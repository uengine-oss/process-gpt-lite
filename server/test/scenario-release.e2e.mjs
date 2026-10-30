// E2E: scenario 1 「금요일 출시」 over HTTP against a running BFF and its database (pgpt-pro/docs/agentic-bpm/plan.md
// §6, lib/scenarios/release.js, lib/optimize). Tenant localhost, the seeded people: 김민지 asks for the release,
// 장진영 is the 릴리스 책임자, 이도윤 the 개인정보 책임자 / 보안 담당자 and administrator.
//
//   . <scratchpad>/agentic-env.sh && node scripts/seed-release-demo.mjs --reset && node test/scenario-release.e2e.mjs [--api http://localhost:8793]
//
// It starts from a reset of this scenario (seed --reset) and puts the strategy graph back at the end. The model
// writes the first run's alternatives, so that run asserts the reasoning (every alternative checked, simulated and
// scored; the rule that ran it or asked), not a fixed winner; the later runs use the templates (useModel false),
// where the scores are deterministic.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { q, pool } from '../lib/supa.js'

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d }
const API = arg('--api', 'http://localhost:8793')
const HERE = path.dirname(fileURLToPath(import.meta.url))
const T = 'localhost'
const AUTO_MARGIN = 0.1

async function signIn(email) {
  const r = await fetch(`${API}/api/auth/email/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, code: '000000' }) })
  const j = await r.json()
  assert.ok(j.session?.access_token, `sign in ${email}: ${JSON.stringify(j).slice(0, 200)}`)
  return { id: j.user.id, token: j.session.access_token }
}
const call = (who) => async (method, p, body) => {
  const r = await fetch(`${API}/api${p}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${who.token}`, 'X-PGL-Lang': 'ko' }, body: body ? JSON.stringify(body) : undefined })
  const j = await r.json().catch(() => ({}))
  return { ...j, http: r.status }
}
const out = {}
const step = async (name, fn) => { out[name] = await fn(); console.log(`✓ ${name}\n  ${JSON.stringify(out[name])}`) }
const brief = (o) => o.alternatives.map((a) => `${a.id} ${a.kind} 「${a.label}」 ${a.excluded ? `제외(${a.reason})` : `${a.decision} 점수 ${a.score} #${a.rank}`}`)

// what the rule should do with these alternatives (lib/optimize/index.js choosePath)
function expected(o) {
  const ok = o.alternatives.filter((a) => !a.excluded).sort((x, y) => y.score - x.score)
  if (!ok.length) return 'exception'
  const margin = ok[1] ? ok[0].score - ok[1].score : Infinity
  return ['allow', 'allow_audit'].includes(ok[0].decision) && ok[0].phases[0].day === 0 && margin >= AUTO_MARGIN - 1e-9 ? 'auto' : 'ask'
}
// every alternative was checked (a dry-run ledger row per phase), simulated and scored; exclusion ⇔ a denied phase
async function assertAssessed(o) {
  assert.ok(o.alternatives.length >= 3, `alternatives: ${o.alternatives.length}`)
  const ledger = await q(`select id, dry_run, decision, ref from pro_policy_decisions where tenant_id=$1 and ref=$2`, [T, `optimization:${o.optimizationId}`])
  for (const a of o.full) {
    for (const p of a.phases) {
      const row = ledger.find((r) => r.id === p.policy.decisionId)
      assert.ok(row && row.dry_run, `${a.id} day ${p.day}: a dry-run ledger row`)
      assert.equal(row.decision, p.policy.decision)
    }
    const denied = a.phases.some((p) => p.policy.decision === 'deny')
    assert.equal(a.excluded, denied, `${a.id}: excluded iff a phase is denied`)
    assert.ok(a.sim && typeof a.sim.daysToFull === 'number' && a.sim.contribution && a.sim.risk, `${a.id}: simulated`)
    if (a.excluded) { assert.equal(a.score, null); assert.ok(a.reason) } else assert.equal(typeof a.score.total, 'number')
  }
  const ranked = o.alternatives.filter((a) => !a.excluded)
  for (let i = 1; i < ranked.length; i++) assert.ok(ranked[i - 1].score >= ranked[i].score, 'ranked by score')
}
const cardsOf = (optId) => q('select user_id, chooser from pro_optimization_cards where optimization_id=$1', [optId])

const minji = await signIn('pro-team-minji@uengine.org')
const jang = await signIn('pro-team-owner@uengine.org')
const doyun = await signIn('pro-mine3-admin@uengine.org')
const [M, J, D] = [call(minji), call(jang), call(doyun)]

execFileSync(process.execPath, [path.join(HERE, '../scripts/seed-release-demo.mjs'), '--reset', '--no-llm'], { stdio: 'inherit' })

try {
  await step('Friday 16:00 public release with the open privacy finding → blocked → alternatives (model)', async () => {
    const r = await M('POST', '/release/requests', { weekday: 5, hour: 16 })
    assert.equal(r.http, 200, r.error)
    assert.equal(r.decision.decision, 'deny'); assert.equal(r.decision.status, 'blocked')
    assert.ok(r.decision.matched.some((m) => m.id === 'release-open-pii' && m.decision === 'deny'), 'release-open-pii denies')
    const o = await M('GET', `/release/optimizations/${r.optimization.id}`)
    await assertAssessed(o)
    // the split release ships no feature with an open finding: not denied; at Friday 16:00 public it needs the release manager
    const split = o.alternatives.find((a) => a.kind === 'split' && !a.excluded)
    assert.ok(split, 'a split alternative that passes')
    assert.equal(split.decision, 'require_approval'); assert.equal(split.approver, '릴리스 책임자')
    const rule = expected(o)
    if (rule === 'ask') {
      assert.equal(o.status, 'proposed')
      const cards = await cardsOf(o.optimizationId)
      assert.ok(cards.some((c) => c.user_id === jang.id && c.chooser), '장진영 gets the card to choose')
      assert.ok(cards.some((c) => c.user_id === minji.id && !c.chooser), '김민지 sees it')
    } else assert.ok(['executed', 'chosen'].includes(o.status), `auto: ${o.status}`)
    out.first = o
    return { rule, status: o.status, explain: o.explain, alternatives: brief(o) }
  })

  await step('the choice: 김민지 may not; 장진영 picks the best — his choice approves the Friday release, it runs', async () => {
    const o = out.first
    if (o.status !== 'proposed') return { skipped: `already ${o.status}` }
    const best = o.alternatives.find((a) => a.rank === 1)
    const no = await M('POST', `/release/optimizations/${o.optimizationId}/choose`, { alternative: best.id })
    assert.equal(no.http, 403)
    const ex = o.alternatives.find((a) => a.excluded)
    if (ex) assert.equal((await J('POST', `/release/optimizations/${o.optimizationId}/choose`, { alternative: ex.id })).http, 409)
    const c = await J('POST', `/release/optimizations/${o.optimizationId}/choose`, { alternative: best.id })
    assert.equal(c.http, 200, c.error)
    const run = c.full.find((a) => a.id === best.id).execution.phases[0]
    if (best.phases[0].day === 0) {
      const [d] = await q('select decision, status, approved_by, dry_run from pro_policy_decisions where id=$1', [run.decisionId])
      assert.equal(d.dry_run, false); assert.equal(d.status, 'executed')
      if (d.decision === 'require_approval') assert.equal(d.approved_by, jang.id, 'approved by 장진영 through his choice')
      const dep = await q('select status, audience, features from pro_release_deployments where optimization_id=$1 order by created_at', [o.optimizationId])
      assert.equal(dep[0].status, 'deployed')
      assert.equal(c.status, 'executed'); assert.equal(c.chosen, best.id)
      return { chosen: `${best.id} ${best.label}`, optimization: c.status, explain: c.explain, decision: d.decision, approvedBy: d.approved_by === jang.id ? '장진영' : d.approved_by, deployments: dep.map((x) => `${x.status} ${x.audience} ${x.features.join('/')}`) }
    }
    return { chosen: best.id, scheduled: run.status }
  })

  await step('priority of 고객 신뢰 1 → 5: the ranking changes on re-run; the new best (internal first) runs on its own', async () => {
    const r = await M('POST', '/release/requests', { weekday: 5, hour: 16, useModel: false })
    const o = r.optimization
    assert.equal(o.status, 'proposed', o.explain)
    const before = (await M('POST', `/release/optimizations/${o.id}/rerun`, { preview: true })).alternatives
    assert.equal(before.find((a) => a.rank === 1).kind, 'split')
    const g = await D('GET', '/strategy')
    const trust = g.objectives.find((x) => x.id === 'customer-trust')
    // only an administrator changes the graph
    assert.equal((await M('PUT', '/strategy/objectives/customer-trust', { ...trust, priority: 5 })).http, 403)
    assert.equal((await D('PUT', '/strategy/objectives/customer-trust', { ...trust, priority: 5 })).http, 200)
    const after = await M('POST', `/release/optimizations/${o.id}/rerun`, { preview: true })
    const order = (xs) => xs.filter((a) => a.rank).sort((a, b) => a.rank - b.rank).map((a) => a.kind)
    assert.notDeepEqual(order(after.alternatives), order(before), 'the ranking changed')
    assert.equal(after.alternatives.find((a) => a.rank === 1).kind, 'internal_first')
    // nothing was written by the preview
    assert.equal((await M('GET', `/release/optimizations/${o.id}`)).status, 'proposed')
    const fresh = await M('POST', `/release/optimizations/${o.id}/rerun`, {})
    assert.equal(fresh.status, 'executed', fresh.explain)
    assert.ok(fresh.auto, 'ran on its own')
    const win = fresh.full.find((a) => a.id === fresh.chosen)
    assert.equal(win.kind, 'internal_first'); assert.equal(win.policy.decision, 'allow_audit')
    const old = await M('GET', `/release/optimizations/${o.id}`)
    assert.equal(old.status, 'stopped'); assert.equal(old.next, fresh.optimizationId)
    // Human-on-the-Loop: an internal release is recorded and can be taken back for a while
    const run = win.execution.phases[0]
    const [d] = await q('select decision, status from pro_policy_decisions where id=$1', [run.decisionId])
    assert.equal(d.status, 'executed')
    const u = await M('POST', `/decisions/${run.decisionId}/undo`)
    assert.equal(u.status, 'undone')
    const [dep] = await q(`select status from pro_release_deployments where decision_id=$1`, [run.decisionId])
    assert.equal(dep.status, 'rolled_back')
    return { before: order(before), after: order(after.alternatives), scores: after.alternatives.map((a) => `${a.kind} ${a.before.score}→${a.score}`), ran: `${win.label} (${win.policy.decision})`, explain: fresh.explain, undo: dep.status }
  })
  // back to the seeded priority
  await q(`update pro_strategy_objectives set priority=1 where tenant_id=$1 and id='customer-trust'`, [T])

  await step('Friday 11:00 (before the Friday-afternoon rule): the split release is allowed and leads → it runs on its own (model)', async () => {
    const r = await M('POST', '/release/requests', { weekday: 5, hour: 11 })
    assert.equal(r.decision.decision, 'deny')
    const o = await M('GET', `/release/optimizations/${r.optimization.id}`)
    await assertAssessed(o)
    const rule = expected(o)
    const best = o.alternatives.find((a) => a.rank === 1)
    if (rule === 'auto') {
      assert.equal(o.status, 'executed', o.explain); assert.equal(o.chosen, best.id)
      const dep = await q('select status, audience, features from pro_release_deployments where optimization_id=$1 order by created_at', [o.optimizationId])
      assert.equal(dep[0].status, 'deployed')
      assert.ok(!dep[0].features.includes('공유 링크') || dep[0].audience !== 'public', 'the feature with the open finding is not public')
    } else assert.equal(o.status, 'proposed')
    return { rule, status: o.status, best: `${best.kind} ${best.decision} ${best.score}`, explain: o.explain, alternatives: brief(o) }
  })

  await step('security scan failed: every alternative breaks a must constraint → escalated to the 보안 담당자 (이도윤)', async () => {
    const r = await M('POST', '/release/requests', { weekday: 5, hour: 16, security_scan: 'failed', useModel: false })
    const o = await M('GET', `/release/optimizations/${r.optimization.id}`)
    await assertAssessed(o)
    assert.ok(o.alternatives.every((a) => a.excluded), 'all excluded')
    assert.ok(o.alternatives.every((a) => a.breaks.some((b) => b.policy === 'release-security-scan' && b.level === 'must')))
    assert.equal(o.status, 'escalated', o.explain)
    assert.deepEqual(o.exception.holders.map((h) => h.name), ['이도윤'])
    const cards = await cardsOf(o.optimizationId)
    assert.ok(cards.some((c) => c.user_id === doyun.id), '이도윤 gets the card')
    const [n] = await q(`select title from notifications where tenant_id=$1 and user_id=$2 and title like '예외 판단 요청%' order by time_stamp desc limit 1`, [T, doyun.id])
    assert.ok(n, 'and a notification')
    return { status: o.status, exception: o.exception, explain: o.explain, alternatives: brief(o) }
  })

  await step('…and with the 보안 담당자 treated as unheld: nobody may grant the exception → stopped', async () => {
    const r = await M('POST', '/release/requests', { weekday: 5, hour: 16, security_scan: 'failed', useModel: false, unheldRoles: ['보안 담당자'] })
    const o = await M('GET', `/release/optimizations/${r.optimization.id}`)
    assert.ok(o.alternatives.every((a) => a.excluded))
    assert.equal(o.status, 'stopped', o.explain)
    return { status: o.status, explain: o.explain }
  })
} finally {
  await q(`update pro_strategy_objectives set priority=1 where tenant_id=$1 and id='customer-trust'`, [T])
  await pool.end()
}
console.log('\nall steps passed — `node scripts/seed-release-demo.mjs --reset` clears what they left')
