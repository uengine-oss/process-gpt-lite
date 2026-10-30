// How much of each window a person has used, the way Claude's usage page shows it: this session (5 hours),
// this week (or Hark's billing month), the company's extra usage pool — read from LiteLLM's counters in the
// same Postgres (they trail the calls by LiteLLM's ~10-second write interval). And, for administrators,
// everyone's, with the month's bill estimated from the seats and the usage beyond them.
import { q } from '../supa.js'
import * as K from '../llmKeys.js'
import { catalog, limitsOf, monthlyBill } from './catalog.js'
import { subscriptionOf, planOf, seatOf } from './apply.js'

const utc = (t) => (t ? new Date(String(t).replace(' ', 'T') + (/[Zz+]/.test(String(t).slice(10)) ? '' : 'Z')).toISOString() : null)
const MONTH = `date >= to_char(date_trunc('month', now() at time zone 'utc'), 'YYYY-MM-DD')`
const window = (spent, lim, row) => (lim ? { spent: Number(spent) || 0, limit: lim.usd, duration: lim.duration, resetsAt: utc(row?.budget_reset_at), byAdmin: !!lim.byAdmin } : null)

async function counters(tenant, userId) {
  const [k] = await q('select spend::float8, budget_reset_at::text from litellm."LiteLLM_VerificationToken" where token=$1', [K.tokenOf(K.keyOf(tenant, userId))])
  const [m] = await q(`select m.spend::float8, b.budget_reset_at::text from litellm."LiteLLM_TeamMembership" m left join litellm."LiteLLM_BudgetTable" b on b.budget_id=m.budget_id
    where m.team_id=$1 and m.user_id=$2`, [K.teamOf(tenant), K.memberOf(tenant, userId)])
  const [x] = await q('select spend::float8 from litellm."LiteLLM_VerificationToken" where token=$1', [K.tokenOf(K.keyOf(tenant, userId, 'extra'))])
  return { k, m, extraMine: x?.spend || 0 }
}

async function poolOf(tenant, sub) {
  if (!(planOf(sub).extraUsage && sub.extra_usage_usd > 0)) return null
  const [t] = await q('select spend::float8, budget_reset_at::text from litellm."LiteLLM_TeamTable" where team_id=$1', [K.extraTeamOf(tenant)])
  return { spent: t?.spend || 0, limit: sub.extra_usage_usd, resetsAt: utc(t?.budget_reset_at) }
}

export async function windowsOf(tenant, userId, sub = null) {
  sub ||= await subscriptionOf(tenant)
  const { seat, limit_usd } = await seatOf(tenant, userId, sub)
  const lim = limitsOf(seat, { name: sub.catalog, limitUsd: limit_usd })
  const { k, m, extraMine } = await counters(tenant, userId)
  const pool = await poolOf(tenant, sub)
  return {
    seat, seatName: lim.name, models: lim.models, usageBased: lim.usageBased,
    session: window(k?.spend, lim.session, k), period: window(m?.spend, lim.period, m),
    extra: pool && { ...pool, mine: extraMine },
  }
}

export async function companyOf(tenant) {
  const sub = await subscriptionOf(tenant)
  const team = await q(`select u.id, u.email, u.username as name from pro_team_members t join users u on u.id=t.user_id and u.tenant_id=t.tenant_id
    where t.tenant_id=$1 order by t.created_at`, [tenant])
  const month = await q(`select k.user_id, sum(d.spend)::float8 spend, sum(d.successful_requests)::int calls
    from litellm."LiteLLM_DailyTeamSpend" d join litellm."LiteLLM_VerificationToken" k on k.token=d.api_key
    where d.team_id = any($1) and d.${MONTH} group by k.user_id`, [[K.teamOf(tenant), K.extraTeamOf(tenant)]])
  const byUser = Object.fromEntries(month.map((r) => [r.user_id, r]))
  const people = []
  for (const p of team) {
    const w = await windowsOf(tenant, p.id, sub)
    people.push({ ...p, ...w, month: byUser[p.id] || { spend: 0, calls: 0 } })
  }
  const system = byUser[K.memberOf(tenant, K.SYSTEM)]
  const pool = await poolOf(tenant, sub)
  const usageSpent = month.reduce((a, r) => a + r.spend, 0)
  const bill = monthlyBill({ plan: sub.plan, billing: sub.billing, seats: people.map((p) => p.seat), extraSpent: pool?.spent || 0, usageSpent, name: sub.catalog })
  return { subscription: sub, people, system: system || null, extra: pool, month: { spend: usageSpent, calls: month.reduce((a, r) => a + r.calls, 0) }, bill }
}

// the catalog as the page shows it (notes in the person's language)
export function catalogView(name, L) {
  const c = catalog(name)
  return {
    name, title: c.name, source: c.source, windows: c.windows,
    plans: Object.entries(c.plans).map(([code, p]) => ({
      code, name: p.name, kind: p.kind, note: L(p.note[0], p.note[1]), minSeats: p.minSeats || null, maxSeats: p.maxSeats || null,
      extraUsage: !!p.extraUsage, adminLimits: !!p.adminLimits, usageBased: !!p.usageBased,
      seats: p.seats.map((s) => ({ code: s, name: c.seats[s].name, price: c.seats[s].price, x: c.seats[s].x, limits: limitsOf(s, { name }) })),
    })),
  }
}
