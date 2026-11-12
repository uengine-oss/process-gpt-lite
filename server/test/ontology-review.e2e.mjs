// E2E S3 「고정 · 노화 · 검토」 (spec pgpt-pro_process-ontology): the review agenda lists the stale bypass as a
// retirement candidate (with its Poisson evidence); 장진영 retires it → the map draws it as retired and a snapshot no longer
// goes that way; 「다음 달 1일부터 재무 검토 고정」 → today's snapshot from the quote still splits on the amount, a
// snapshot as of a day after that date always goes through the finance review; each decision is in Ontological's
// history (a past point in time shows the edge active) and in the policy decision ledger. At the end the decisions are
// undone (revive · unpin) so the scenario can run again.
//
//   PRO_API=http://ax.localhost:8790 node test/ontology-review.e2e.mjs [--keep]
process.env.DOTENV_CONFIG_QUIET = 'true'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { q, pool } from '../lib/supa.js'

const API = process.env.PRO_API || 'http://ax.localhost:8790'
const keep = process.argv.includes('--keep')
let failed = 0
const out = {}
const step = async (name, fn) => {
  try { out[name] = await fn(); console.log(`✓ ${name}`, JSON.stringify(out[name]).slice(0, 400)) } catch (e) { failed++; console.log(`✗ ${name}`, e.message) }
}
async function call(tok, method, path, body) {
  const r = await fetch(`${API}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` }, body: body ? JSON.stringify(body) : undefined })
  return { status: r.status, body: await r.json().catch(() => ({})) }
}
async function signIn(email) {
  const r = await fetch(`${API}/api/auth/email/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, code: '000000' }) })
  const j = await r.json()
  assert.ok(j.session?.access_token, `sign-in ${email}`)
  return { id: j.user.id, tok: j.session.access_token, email }
}
const nextMonthFirst = () => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 10) }

const boss = await signIn('pro-ax-jinyoung@uengine.org')
const minji = await signIn('pro-ax-minji@uengine.org')
let bypass
const before = new Date().toISOString()

await step('검토 안건: 옛 우회 경로가 은퇴 후보(근거 숫자와 함께)', async () => {
  const a = (await call(boss.tok, 'GET', '/ontology/review')).body
  bypass = a.items.find((x) => x.kind === 'retire' && x.to === '평면도 작성')
  assert.ok(bypass, JSON.stringify(a.items.map((x) => x.text)))
  assert.ok(bypass.expected > 3)
  return { text: bypass.text, items: a.items.map((x) => x.kind) }
})

await step('관리자만 결정한다', async () => {
  const r = await call(minji.tok, 'POST', '/ontology/edges', { from: bypass.from, to: bypass.to, status: 'retired' })
  assert.equal(r.status, 403)
  return r.body
})

await step('은퇴: 지도에서 은퇴로 보이고, 과거 시점에는 살아 있다', async () => {
  const r = await call(boss.tok, 'POST', '/ontology/edges', { from: bypass.from, to: bypass.to, status: 'retired', reason: '실측 없이 진행하지 않기로 함(분기 검토)' })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const now = (await call(boss.tok, 'GET', '/ontology/map')).body
  assert.equal(now.edges.find((e) => e.from === bypass.from && e.to === bypass.to).status, 'retired')
  const then = (await call(boss.tok, 'GET', `/ontology/map?at=${encodeURIComponent(before)}`)).body
  assert.equal(then.edges.find((e) => e.from === bypass.from && e.to === bypass.to).status, 'active')
  return { now: 'retired', before: 'active' }
})

let A
await step('다음 달 1일부터 재무 검토 고정 — 오늘의 스냅샷은 그대로, 그날 뒤의 스냅샷에는 반드시', async () => {
  const m = (await call(boss.tok, 'GET', '/ontology/map')).body
  A = m.bundles.find((b) => b.tasks.includes('견적서 작성'))
  const day = nextMonthFirst()
  const r = await call(boss.tok, 'POST', `/ontology/tasks/${encodeURIComponent('재무 검토')}/pin`, { validFrom: day, reason: '금액과 상관없이 재무 검토(분기 검토)' })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const today = (await call(boss.tok, 'GET', `/ontology/snapshot?bundle=${encodeURIComponent(A.key)}&entry=${encodeURIComponent('견적서 작성')}`)).body
  const later = (await call(boss.tok, 'GET', `/ontology/snapshot?bundle=${encodeURIComponent(A.key)}&entry=${encodeURIComponent('견적서 작성')}&at=${day}T12:00:00Z`)).body
  const [dToday] = await q('select definition from proc_def where id=$1', [today.procDefId])
  const [dLater] = await q('select definition from proc_def where id=$1', [later.procDefId])
  const outsOf = (d, name) => {
    const id = d.definition.activities.find((a) => a.name === name)?.id
    const g = d.definition.sequences.filter((s) => s.source === id).map((s) => s.target)
    return d.definition.sequences.filter((s) => g.includes(s.source) || s.source === id).map((s) => d.definition.activities.find((a) => a.id === s.target)?.name || s.target)
  }
  const tOuts = outsOf(dToday, '견적서 작성'), lOuts = outsOf(dLater, '견적서 작성')
  assert.ok(tOuts.includes('고객 회신') && tOuts.includes('재무 검토'), `today ${tOuts}`)
  assert.ok(lOuts.includes('재무 검토') && !lOuts.includes('고객 회신'), `later ${lOuts}`)
  return { day, today: tOuts, later: lOuts, snapshots: [today.procDefId, later.procDefId] }
})

await step('결정 원장에 남는다(누가 · 무엇 · 언제부터)', async () => {
  const d = (await call(boss.tok, 'GET', '/ontology/decisions')).body
  const kinds = d.slice(0, 5).map((x) => x.action_kind)
  assert.ok(kinds.includes('ontology.pin') && kinds.includes('ontology.retire'), kinds.join(','))
  return d.slice(0, 2).map((x) => x.subject)
})

if (!keep) {
  await step('되돌리기: 되살림 · 고정 풀기', async () => {
    await call(boss.tok, 'POST', '/ontology/edges', { from: bypass.from, to: bypass.to, status: 'active', reason: '시험 정리' })
    await call(boss.tok, 'POST', `/ontology/tasks/${encodeURIComponent('재무 검토')}/pin`, { pinned: false, validFrom: nextMonthFirst(), reason: '시험 정리' })
    const m = (await call(boss.tok, 'GET', '/ontology/map')).body
    assert.equal(m.edges.find((e) => e.from === bypass.from && e.to === bypass.to).status, 'active')
    return 'ok'
  })
}

console.log(failed ? `\n${failed} failed` : '\nall passed')
fs.writeFileSync(new URL('../.scratch/ontology-review.e2e.json', import.meta.url), JSON.stringify(out, null, 1))
await pool.end()
process.exit(failed ? 1 : 0)
