// E2E: lib/llmKeys.js and lib/llmUsage.js against a real LiteLLM with its tables in the same Postgres
// (process-gpt worktree exp/litellm-native-billing, experiments/litellm-native-billing: model mock-fast costs
// exactly $0.002 a call). The two tenants this server serves (localhost, en-demo) as two companies, real people
// (their names come from pro_profile). Use a LiteLLM no live server uses: this sets and lifts budgets on it.
//
//   PRO_LLM_KEYS=litellm PRO_LLM_BASE_URL=http://localhost:4102/v1 PRO_LITELLM_URL=http://localhost:4102 \
//   PRO_LITELLM_ADMIN_KEY=sk-poc-master PRO_LLM_KEY_SECRET=<anything> PRO_LLM_MODEL=mock-fast \
//   node test/llm-keys.e2e.mjs
import assert from 'node:assert/strict'
import { config } from '../config.js'
import { chat } from '../lib/llm.js'
import { withTenant } from '../lib/tenant.js'
import { withUsage } from '../lib/usage.js'
import { withLang } from '../lib/lang.js'
import { QuotaError, teamOf, enabled } from '../lib/llmKeys.js'
import { monthOf, mineOf } from '../lib/llmUsage.js'
import { pool } from '../lib/supa.js'

assert.ok(enabled(), 'run with PRO_LLM_KEYS=litellm (see the top of this file)')
const CALL = 0.002
const A = 'localhost', B = 'en-demo'
const OWNER = '1b0cd880-86db-4803-8b9c-f3cbc3ca66af', MINJI = '5f39e4de-eb7c-4cb6-afc1-1fa33a6e92a9'      // pro-team-*
const EN_MINJI = '847efa3f-4024-4fbe-9c47-81bc977d4e4b', EN_SEOYEON = '0306968b-dd2d-4ff3-a0cb-58d6dfc9fd5f'  // pro-en-*
const calls = { [A]: 0, [B]: 0 }   // successful calls this run, to check LiteLLM's totals against
const WRITE_LAG = 14000            // LiteLLM writes its spend and daily tables every ~10 s
const CACHE = 62000                // and keeps a team membership (a person's limit) cached for 60 s
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const ask = (tenant, userId, feature) => withTenant(tenant, () => withUsage({ userId, feature }, async () => {
  const m = await chat({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 50 })
  calls[tenant]++
  return m.content
}))
async function untilRefused(tenant, userId, feature) {
  for (let ok = 0; ok < 12; ok++) {
    try { await ask(tenant, userId, feature) } catch (e) {
      if (e instanceof QuotaError) return { allowed: ok, scope: e.scope, message: e.message }
      throw e
    }
  }
  return { allowed: 12, scope: null }
}
async function admin(path, body) {
  const res = await fetch(`${config.llmKeys.adminUrl}${path}`, {
    method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${config.llmKeys.adminKey}`, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body),
  })
  const j = await res.json()
  assert.ok(res.ok, `${path} ${res.status} ${JSON.stringify(j).slice(0, 200)}`)
  return j
}
const team = (t) => admin(`/team/info?team_id=${teamOf(t)}`)
const out = {}
const step = async (name, fn) => { out[name] = await fn(); console.log(`✓ ${name}`, JSON.stringify(out[name])) }

let lifted = false
try {
  await step('first calls make the company, person and key', async () => ({
    localhost_minji: await ask(A, MINJI, 'chat'), localhost_owner: await ask(A, OWNER, 'mission'),
    localhost_background: await ask(A, undefined, 'mining'), en_demo_minji: await ask(B, EN_MINJI, 'chat'),
    en_demo_seoyeon: await ask(B, EN_SEOYEON, 'chat'),
  }))
  await sleep(WRITE_LAG)
  const base = { [A]: await monthOf(A), [B]: await monthOf(B) }

  await step('company budget stops that company only', async () => {
    const spent = (await team(A)).team_info.spend
    await admin('/team/update', { team_id: teamOf(A), max_budget: spent + 3 * CALL })   // 3 calls left
    const localhost = await untilRefused(A, MINJI, 'chat')
    assert.equal(localhost.scope, 'company')
    assert.ok(localhost.allowed >= 3 && localhost.allowed <= 4, `allowed ${localhost.allowed}`)
    const englishMessage = await withLang('en', () => ask(A, OWNER, 'chat').catch((e) => e.message))
    return { localhost, englishMessage, en_demo_still: await ask(B, EN_MINJI, 'chat') }
  })

  await step('a person\'s limit stops that person only', async () => {
    const m = (await team(B)).team_memberships.find((x) => x.user_id === EN_SEOYEON)
    await admin('/team/member_update', { team_id: teamOf(B), user_id: EN_SEOYEON, max_budget_in_team: (m?.spend || 0) + 3 * CALL })
    await sleep(CACHE)
    const seoyeon = await untilRefused(B, EN_SEOYEON, 'chat')
    assert.equal(seoyeon.scope, 'period')   // the membership's limit (lib/plans: the week)
    assert.ok(seoyeon.allowed >= 3 && seoyeon.allowed <= 4, `allowed ${seoyeon.allowed}`)
    return { seoyeon, minji_still: await ask(B, EN_MINJI, 'chat') }
  })

  await admin('/team/update', { team_id: teamOf(A), max_budget: 1000 })
  await admin('/team/member_update', { team_id: teamOf(B), user_id: EN_SEOYEON, max_budget_in_team: 1000 })
  lifted = true

  await step('usage read from LiteLLM\'s tables in the same database', async () => {
    await sleep(WRITE_LAG)
    const now = { [A]: await monthOf(A, { people: true }), [B]: await monthOf(B, { people: true }) }
    const firstCalls = { [A]: 3, [B]: 2 }   // made before the baseline was read
    for (const t of [A, B]) {
      const added = now[t].month.calls - base[t].month.calls
      assert.equal(added, calls[t] - firstCalls[t], `${t}: LiteLLM counted ${added}, made ${calls[t] - firstCalls[t]}`)
      assert.ok(Math.abs(now[t].month.spend - base[t].month.spend - added * CALL) < 1e-9, `${t} spend`)
    }
    const features = Object.fromEntries(now[A].features.map((f) => [f.feature, f.calls]))
    assert.ok(features.chat && features.mission && features.mining, JSON.stringify(features))
    const who = (p) => `${p.name || p.user_id}: ${p.calls} calls${p.limit != null ? `, limit $${p.limit}` : ''}`
    assert.ok(now[A].people.some((p) => /^system:/.test(p.user_id)), 'background work is the company\'s own key')
    return { calls, localhost: { month: now[A].month, features, people: now[A].people.map(who) },
      en_demo: { month: now[B].month, people: now[B].people.map(who) }, seoyeon_mine: await mineOf(B, EN_SEOYEON) }
  })
  console.log('\nall passed')
} finally {
  if (!lifted) {
    await admin('/team/update', { team_id: teamOf(A), max_budget: 1000 }).catch(() => {})
    await admin('/team/member_update', { team_id: teamOf(B), user_id: EN_SEOYEON, max_budget_in_team: 1000 }).catch(() => {})
  }
  await pool.end()
}
