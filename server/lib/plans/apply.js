// A company's plan, applied to LiteLLM (PRO_LLM_KEYS=litellm). From the plan and each person's seat
// (pro_billing_subscriptions, pro_billing_seats; lib/plans/catalog.js) to:
//   the person's key      session budget (5 hours on Claude-style plans), models, rpm, parallel requests
//   their membership      period budget (a week, or Hark's billing month; an admin's monthly limit)
//   the company's team    the models of its seats; Enterprise: the company's monthly spend limit
//   the extra team        Team plans with extra usage: the pool, monthly
// Applied when a plan or seat changes, when a person's key is first made (lib/llmKeys.js), and every ten
// minutes for every company (startPlanSync), so LiteLLM converges on the plan even after a manual change.
// A window that is already running is kept: only a changed duration (or none yet) restarts it.
import { q } from '../supa.js'
import * as K from '../llmKeys.js'
import { catalog, catalogName, limitsOf, defaultSeat, poolUsd } from './catalog.js'

export async function subscriptionOf(tenant) {
  const [s] = await q('select * from pro_billing_subscriptions where tenant_id=$1', [tenant])
  const sub = s || { tenant_id: tenant, catalog: catalogName(), plan: 'free', billing: 'month', extra_usage_usd: 0 }
  if (!catalog(sub.catalog)?.plans[sub.plan]) Object.assign(sub, { catalog: catalogName(), plan: 'free' })
  return { ...sub, extra_usage_usd: Number(sub.extra_usage_usd) || 0 }
}
export const planOf = (sub) => catalog(sub.catalog).plans[sub.plan]

// a person's seat: the one an administrator gave, while the plan has it; else the plan's first
export async function seatOf(tenant, userId, sub) {
  const plan = planOf(sub)
  const [r] = await q('select seat, limit_usd from pro_billing_seats where tenant_id=$1 and user_id::text=$2', [tenant, String(userId)])
  const seat = r && plan.seats.includes(r.seat) ? r.seat : defaultSeat(sub.plan, sub.catalog)
  return { seat, limit_usd: r?.limit_usd != null && plan.adminLimits ? Number(r.limit_usd) : null }
}

// the limits of a person's seat now
export async function limitsFor(tenant, userId) {
  const sub = await subscriptionOf(tenant)
  if (userId === K.SYSTEM) return null
  const { seat, limit_usd } = await seatOf(tenant, userId, sub)
  return limitsOf(seat, { name: sub.catalog, limitUsd: limit_usd })
}

// every member's seat (the company's seats on a pooled plan)
export async function seatsOfCompany(tenant, sub) {
  const plan = planOf(sub)
  const rows = await q(`select t.user_id::text, s.seat from pro_team_members t left join pro_billing_seats s on s.tenant_id=t.tenant_id and s.user_id=t.user_id
    where t.tenant_id=$1`, [tenant])
  return rows.map((r) => (r.seat && plan.seats.includes(r.seat) ? r.seat : defaultSeat(sub.plan, sub.catalog)))
}

// which refusals go on in the extra usage pool: on a pooled plan the company's (its pool ran out — the
// credits it bought take over; a person's own fair share stays theirs), elsewhere the person's own limits
export async function overflowOf(tenant) {
  const sub = await subscriptionOf(tenant)
  if (!(planOf(sub).extraUsage && sub.extra_usage_usd > 0)) return []
  return catalog(sub.catalog).pooled ? ['company'] : ['session', 'period']
}

export async function extraOpen(tenant) {
  const sub = await subscriptionOf(tenant)
  return !!planOf(sub).extraUsage && sub.extra_usage_usd > 0
}
export async function periodOf(tenant) {
  const sub = await subscriptionOf(tenant)
  return catalog(sub.catalog).windows.period
}

const addTo = (d) => {
  const m = String(d).match(/^(\d+)([smhd])$/)
  const ms = { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[m[2]] * Number(m[1])
  return new Date(Date.now() + ms).toISOString()
}

async function keyRow(key) {
  const [r] = await q('select max_budget::float8, budget_duration, budget_reset_at, models, rpm_limit, max_parallel_requests from litellm."LiteLLM_VerificationToken" where token=$1', [K.tokenOf(key)])
  return r || null
}
async function memberRow(team, member) {
  const [r] = await q(`select m.budget_id, b.max_budget::float8, b.budget_duration, b.budget_reset_at from litellm."LiteLLM_TeamMembership" m
    left join litellm."LiteLLM_BudgetTable" b on b.budget_id=m.budget_id where m.team_id=$1 and m.user_id=$2`, [team, member])
  return r || null
}

// the person's key: the session window, the models, how fast
async function setKey(key, lim) {
  const had = await keyRow(key)
  if (!had) return false
  const body = { key, models: lim.models, rpm_limit: lim.rpm, max_parallel_requests: lim.parallel, max_budget: lim.session ? lim.session.usd : NO }
  const duration = lim.session?.duration || null
  if (duration !== had.budget_duration) Object.assign(body, { budget_duration: duration })
  await K.admin('/key/update', body)
  return true
}

// the membership: the week (or billing month, or an admin's monthly limit)
async function setMember(team, member, period) {
  await K.admin('/team/member_update', { team_id: team, user_id: member, max_budget_in_team: period ? period.usd : NO })
  const row = await memberRow(team, member)
  if (!row?.budget_id) return
  const duration = period?.duration || null
  if (duration !== row.budget_duration || (duration && !row.budget_reset_at)) {
    await K.admin('/budget/update', { budget_id: row.budget_id, budget_duration: duration, budget_reset_at: duration ? addTo(duration) : null })
  }
}

const NO = K.NO_LIMIT

// one person in one company (pool 'extra': their key in the extra team — the seat's models, no own limit)
export async function applyMember(tenant, userId, { sub = null, pool = 'seat' } = {}) {
  sub ||= await subscriptionOf(tenant)
  const member = K.memberOf(tenant, userId)
  if (userId === K.SYSTEM || pool === 'extra') {
    // the company's own work (and the pool) has no seat: every model of the plan, the company's caps above it
    const seats = planOf(sub).seats.map((s) => limitsOf(s, { name: sub.catalog }))
    const models = [...new Set(seats.flatMap((s) => s.models))]
    const lim = { models, rpm: Math.max(...seats.map((s) => s.rpm)), parallel: Math.max(...seats.map((s) => s.parallel)), session: null }
    await setKey(K.keyOf(tenant, userId, pool), lim)
    return { userId, pool, seat: null, limits: lim }
  }
  const { seat, limit_usd } = await seatOf(tenant, userId, sub)
  const lim = limitsOf(seat, { name: sub.catalog, limitUsd: limit_usd })
  const keyed = await setKey(K.keyOf(tenant, userId), lim)
  if (keyed) await setMember(K.teamOf(tenant), member, lim.period)
  return { userId, seat, keyed, limits: lim }
}

// the whole company: its team(s), then everyone who has a key in it
export async function applyPlan(tenant) {
  const sub = await subscriptionOf(tenant)
  const plan = planOf(sub)
  const models = [...new Set(plan.seats.flatMap((s) => limitsOf(s, { name: sub.catalog }).models))]
  const team = K.teamOf(tenant), extraTeam = K.extraTeamOf(tenant)
  await K.admin('/team/new', { team_id: team, team_alias: tenant, metadata: { tenant } })
  // the company's monthly cap: Enterprise's spend limit, or a pooled plan's pool (its seats' credits)
  const pool = poolUsd(sub.plan, await seatsOfCompany(tenant, sub), sub.catalog)
  const cap = plan.usageBased ? (sub.extra_usage_usd > 0 ? sub.extra_usage_usd : null) : pool
  const [had] = await q('select budget_duration from litellm."LiteLLM_TeamTable" where team_id=$1', [team])
  const duration = cap ? '30d' : null
  await K.admin('/team/update', { team_id: team, models, max_budget: cap ?? NO, ...(duration !== had?.budget_duration ? { budget_duration: duration } : {}) })

  const open = !!plan.extraUsage && sub.extra_usage_usd > 0
  const [hasExtra] = await q('select blocked from litellm."LiteLLM_TeamTable" where team_id=$1', [extraTeam])
  if (open) {
    await K.admin('/team/new', { team_id: extraTeam, team_alias: `${tenant} extra usage`, metadata: { tenant, pool: 'extra' } })
    await K.admin('/team/update', { team_id: extraTeam, models, max_budget: sub.extra_usage_usd, budget_duration: '30d' })
    if (hasExtra?.blocked) await K.admin('/team/unblock', { team_id: extraTeam })
  } else if (hasExtra && !hasExtra.blocked) {
    await K.admin('/team/block', { team_id: extraTeam })
  }
  K.forgetExtra(tenant)

  const people = await q(`select distinct user_id from litellm."LiteLLM_VerificationToken" where team_id=$1`, [team])
  const members = []
  for (const { user_id } of people) {
    const userId = user_id.startsWith(`${K.SYSTEM}:`) ? K.SYSTEM : user_id
    members.push(await applyMember(tenant, userId, { sub }))
  }
  const extraPeople = open ? await q(`select distinct user_id from litellm."LiteLLM_VerificationToken" where team_id=$1`, [extraTeam]) : []
  for (const { user_id } of extraPeople) await applyMember(tenant, user_id, { sub, pool: 'extra' })
  return { tenant, catalog: sub.catalog, plan: sub.plan, extraUsage: open ? sub.extra_usage_usd : 0, companyCap: cap, pool, models, members }
}

// every company this server serves, every ten minutes (and once at start)
export function startPlanSync(forEachTenant) {
  if (!K.enabled()) return
  const run = () => forEachTenant(async () => { const { config } = await import('../../config.js'); await applyPlan(config.tenantId) }, 'plans')
  setTimeout(run, 20000)
  setInterval(run, 10 * 60 * 1000).unref()
}
