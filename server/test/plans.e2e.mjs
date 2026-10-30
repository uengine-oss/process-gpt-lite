// E2E: plans (lib/plans) applied to a real LiteLLM whose tables share this Postgres (process-gpt worktree
// exp/litellm-native-billing: mock-fast costs $0.002 a call, mock-pro $0.02). Tiny baseline units make every
// limit a few calls. Made-up people (fresh keys and memberships every run) in the served tenant localhost;
// its plan rows are put back as they were at the end.
//
//   PRO_LLM_KEYS=litellm PRO_LLM_BASE_URL=http://localhost:4102/v1 PRO_LITELLM_URL=http://localhost:4102 \
//   PRO_LITELLM_ADMIN_KEY=sk-poc-master PRO_LLM_KEY_SECRET=<anything> PRO_LLM_MODEL=mock-fast \
//   PRO_LLM_FAST_MODEL=mock-fast PRO_LLM_PRO_MODEL=mock-pro node test/plans.e2e.mjs
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { chat } from '../lib/llm.js'
import { withTenant } from '../lib/tenant.js'
import { withUsage } from '../lib/usage.js'
import { withLang } from '../lib/lang.js'
import { QuotaError, ModelError, enabled } from '../lib/llmKeys.js'
import { applyPlan, applyMember } from '../lib/plans/apply.js'
import { windowsOf, companyOf } from '../lib/plans/usage.js'
import { usdPerCredit } from '../lib/plans/catalog.js'
import { q, pool } from '../lib/supa.js'

assert.ok(enabled(), 'run with PRO_LLM_KEYS=litellm (see the top of this file)')
const T = 'localhost'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const CACHE = 62000   // LiteLLM keeps keys and memberships cached for 60 s
const person = () => crypto.randomUUID()
const units = (session, week, month = 0.004) => Object.assign(process.env, { PRO_PLAN_UNIT_SESSION_USD: String(session), PRO_PLAN_UNIT_WEEK_USD: String(week), PRO_PLAN_UNIT_MONTH_USD: String(month) })

const ask = (userId, model) => withTenant(T, () => withUsage({ userId, feature: 'chat' }, () => chat({ messages: [{ role: 'user', content: 'hi' }], model, maxTokens: 50 })))
async function until(userId, model) {
  for (let ok = 0; ok < 20; ok++) {
    try { await ask(userId, model) } catch (e) {
      if (e instanceof QuotaError) return { allowed: ok, scope: e.scope, resetsIn: e.resetsAt ? Math.round((e.resetsAt - Date.now()) / 6e4) + 'm' : null, message: e.message }
      throw e
    }
  }
  return { allowed: 20, scope: null }
}
async function setPlan(catalog, plan, extra = 0) {
  await q(`insert into pro_billing_subscriptions(tenant_id, catalog, plan, extra_usage_usd) values ($1,$2,$3,$4)
    on conflict (tenant_id) do update set catalog=$2, plan=$3, extra_usage_usd=$4, updated_at=now()`, [T, catalog, plan, extra])
  return withTenant(T, () => applyPlan(T))
}
const seat = (userId, s, limitUsd = null) => q(`insert into pro_billing_seats(tenant_id, user_id, seat, limit_usd) values ($1,$2,$3,$4)
  on conflict (tenant_id, user_id) do update set seat=$3, limit_usd=$4`, [T, userId, s, limitUsd])

const [before] = await q('select * from pro_billing_subscriptions where tenant_id=$1', [T])
const made = []
const out = {}
const step = async (name, fn) => { out[name] = await fn(); console.log(`✓ ${name}`, JSON.stringify(out[name])) }

try {
  units(0.001, 0.003)
  await step('Free: one call a session, no Pro model', async () => {
    await setPlan('claude', 'free')
    const a = person(); made.push(a)
    const s = await until(a)
    assert.equal(s.scope, 'session'); assert.equal(s.allowed, 1)
    // LiteLLM's windows are on the clock (5-hour blocks from midnight UTC), not from the first message as Claude's
    const mins = parseInt(s.resetsIn, 10)
    assert.ok(mins > 0 && mins <= 300, `resets in ${s.resetsIn}`)
    const model = await ask(person(), 'mock-pro').then(() => 'allowed', (e) => (e instanceof ModelError ? 'refused' : e.message))
    assert.equal(model, 'refused')
    out.a = a
    return { session: s, proModel: model, english: await withLang('en', () => ask(a).catch((e) => e.message)) }
  })

  await step('upgrade to Pro: the same session window grows (after LiteLLM\'s cache), Pro model allowed', async () => {
    const applied = await setPlan('claude', 'pro')
    const mine = applied.members.find((m) => m.userId === out.a)
    assert.equal(mine.limits.session.usd, 0.005); assert.equal(mine.limits.period.usd, 0.015)
    await sleep(CACHE)
    const s = await until(out.a)
    assert.equal(s.scope, 'session'); assert.ok(s.allowed >= 1 && s.allowed <= 2, `allowed ${s.allowed}`)
    const pro = await ask(person(), 'mock-pro').then(() => 'allowed', (e) => e.message)
    assert.equal(pro, 'allowed')
    return { session: s, proModel: pro, windows: await withTenant(T, () => windowsOf(T, out.a)) }
  })

  await step('Pro: the weekly limit stops a person whose session still has room', async () => {
    units(0.05, 0.0016)          // a session of 0.25, a week of 0.008 (4 calls)
    await setPlan('claude', 'pro')
    const b = person(); made.push(b)
    const s = await until(b)
    assert.equal(s.scope, 'period'); assert.ok(s.allowed >= 4 && s.allowed <= 5, `allowed ${s.allowed}`)
    assert.ok(/이번 주/.test(s.message), s.message)
    return s
  })

  await step('Team: Standard seat, then the company\'s extra usage pool, then the pool runs out', async () => {
    // the pool is monthly and keeps what earlier runs spent: 3 calls on top of that
    const [x] = await q('select spend::float8 from litellm."LiteLLM_TeamTable" where team_id=$1', [`pgpt-${T}-extra`])
    await setPlan('claude', 'team', (x?.spend || 0) + 0.006)
    const c = person(); made.push(c)
    const s = await until(c)                 // the Standard seat's week (0.0096) and then the pool
    assert.equal(s.scope, 'extra'); assert.ok(s.allowed >= 8 && s.allowed <= 10, `allowed ${s.allowed}`)
    await sleep(14000)
    const w = await withTenant(T, () => windowsOf(T, c))
    assert.ok(w.extra && w.extra.mine >= 0.006 - 1e-9, JSON.stringify(w.extra))   // (their own share of the pool)
    return { refused: s, windows: w }
  })

  await step('Team: an administrator\'s monthly limit for one person, and a Premium seat', async () => {
    const d = person(), e = person(); made.push(d, e)
    await seat(d, 'standard', 0.004)
    await seat(e, 'premium')
    await setPlan('claude', 'team', 0)       // no pool: the limits are the seats'
    const sd = await until(d), se = await until(e)
    assert.equal(sd.scope, 'period'); assert.ok(sd.allowed >= 2 && sd.allowed <= 3, `allowed ${sd.allowed}`)
    assert.ok(se.allowed > sd.allowed, `premium ${se.allowed} vs standard-with-limit ${sd.allowed}`)
    return { standardWithLimit: sd, premium: se }
  })

  await step('Enterprise: no windows, the company\'s monthly cap', async () => {
    await setPlan('claude', 'enterprise', 0.0001)
    const f = person(); made.push(f)
    const s = await until(f)
    assert.equal(s.scope, 'company')
    await setPlan('claude', 'enterprise', 0)
    const free = await ask(f).then(() => 'allowed', (x) => x.message)
    return { capped: s, afterCapRemoved: free }
  })

  await step('Hark Pro 2x: one window, the billing month', async () => {
    units(0.05, 0.05, 0.004)   // Pro 2x: 0.008 a month (4 calls)
    await setPlan('hark', 'pro2')
    const g = person(); made.push(g)
    const s = await until(g)
    assert.equal(s.scope, 'period'); assert.ok(s.allowed >= 4 && s.allowed <= 5, `allowed ${s.allowed}`)
    assert.ok(/이번 달/.test(s.message), s.message)
    return s
  })

  await step('Process GPT Team (the default): the seats\' credits pooled, then the credits the company bought', async () => {
    Object.assign(process.env, { PRO_PLAN_SESSION_SHARE: '1000', PRO_PLAN_PERSON_SHARE: '1000' })   // fair shares out of the way
    await sleep(14000)                       // the team's counter in the database
    const [t] = await q('select spend::float8 from litellm."LiteLLM_TeamTable" where team_id=$1', [`pgpt-${T}`])
    const [x] = await q('select spend::float8 from litellm."LiteLLM_TeamTable" where team_id=$1', [`pgpt-${T}-extra`])
    const [{ n }] = await q('select count(*)::int n from pro_team_members where tenant_id=$1', [T])
    // every member's 1,500 credits, scaled so that the pool is what the company spent this month and 3 calls more
    process.env.PRO_PLAN_SCALE = String(((t?.spend || 0) + 0.006) / (n * 1500 * usdPerCredit()))
    const applied = await setPlan('uengine', 'team', (x?.spend || 0) + 0.004)   // bought: 2 calls more
    assert.ok(applied.pool > 0 && applied.extraUsage > 0, JSON.stringify(applied).slice(0, 200))
    const h = person(); made.push(h)
    const s = await until(h)
    assert.equal(s.scope, 'extra'); assert.ok(s.allowed >= 4 && s.allowed <= 7, `allowed ${s.allowed}`)
    return s
  })

  await step('Process GPT: a person\'s fair share of the month (twice their seat), and an admin\'s limit in credits', async () => {
    // the pool far away again; a seat's twice is 3 calls
    Object.assign(process.env, { PRO_PLAN_SCALE: '1', PRO_PLAN_SESSION_SHARE: '1', PRO_PLAN_PERSON_SHARE: String(0.006 / (1500 * usdPerCredit())) })
    await setPlan('uengine', 'team', 0)
    const i = person(), j = person(); made.push(i, j)
    await seat(j, 'team', 1 * usdPerCredit())    // an administrator's limit: one credit
    await setPlan('uengine', 'team', 0)
    const si = await until(i), sj = await until(j)
    assert.equal(si.scope, 'period'); assert.ok(si.allowed >= 3 && si.allowed <= 4, `allowed ${si.allowed}`)
    assert.ok(/이번 달/.test(si.message), si.message)
    // one credit is about 1.6 calls of $0.002: two get through before the limit is reached
    assert.equal(sj.scope, 'period'); assert.ok(sj.allowed <= 2 && sj.allowed < si.allowed, `admin-limited allowed ${sj.allowed}`)
    return { fairShare: si, adminLimit: sj }
  })

  await step('company view: seats, windows, the month\'s bill (won, VAT)', async () => {
    const c = await withTenant(T, () => companyOf(T))
    assert.equal(c.bill.currency, 'KRW'); assert.ok(c.bill.lines.some((l) => l.kind === 'vat'))
    assert.ok(c.pool && c.pool.limit > 0, 'the company pool is shown')
    // the same company on Claude's Team: dollars, no VAT line
    await setPlan('claude', 'team', 0.006)
    const d = await withTenant(T, () => companyOf(T))
    assert.equal(d.bill.currency, 'USD'); assert.ok(d.bill.lines.some((l) => l.kind === 'seat'))
    return { plan: c.subscription.plan, people: c.people.length, pool: c.pool, month: c.month, bill: c.bill, claudeBill: d.bill.total }
  })
  console.log('\nall passed')
} finally {
  await q('delete from pro_billing_seats where tenant_id=$1 and user_id = any($2::uuid[])', [T, made])
  if (before) await q('update pro_billing_subscriptions set catalog=$2, plan=$3, billing=$4, extra_usage_usd=$5 where tenant_id=$1', [T, before.catalog, before.plan, before.billing, before.extra_usage_usd])
  else await q('delete from pro_billing_subscriptions where tenant_id=$1', [T])
  await withTenant(T, () => applyPlan(T)).catch((e) => console.warn('restore', e.message))
  await pool.end()
}
