// E2E 「고쳐 보기 · 개선안 · 시행 전후」(lib/ontology/flowplan.js · improveplans.js, 설계 §5 · P3 · P4): over HTTP against a running server +
// the real DB + Ontological. The data is the flow seed (scripts/seed-flow-demo.mjs — six weeks of map-engine cases in ax-demo, the designer
// alone carries 평면도 작성).
//   S6 고쳐 보기: AI 초안 먼저 · 사람 더하기를 얹으면 지금 들어오는 건 · 보통 건 · 디자이너의 짐이 준다 — 아무것도 쓰지 않는다
//   S7 개선안: 두 안을 저장해 견준다(지도 시점 · 앞 · 뒤를 지님), 관리자가 아니면 정하지 못한다
//   S8 합의: 안을 의견으로 올리고 → 김민지가 같은 의견 → 이도윤의 반대 의견이 상충으로 묶이고 → 관리자가 안을 고르면 안이 정해진다
//      (고친 기록 한 묶음 · 정하나가 디자이너 역할에 · 도윤의 의견은 「다른 의견으로 정함」)
//   S9 일마다 AI 초안: 정한 뒤 지도 엔진이 여는 「평면도 작성」은 초안 단계(에이전트 초안 → 사람)로 열린다
//   S10 시행 전후: 효력일을 2주 앞으로 당겨 시뮬레이션을 다시 쓰면(시험용) 예상과 실측이 나란히, 병목이 옮겨 간 것도 보인다
//
//   cd server && node scripts/seed-flow-demo.mjs --plans && PRO_API=http://ax.localhost:8790 node test/ontology-improve.e2e.mjs [--keep]
// --keep: leave the plans (else seed --plans at the end puts ax-demo back as it was)
process.env.DOTENV_CONFIG_QUIET = 'true'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { q, pool } from '../lib/supa.js'

const API = process.env.PRO_API || 'http://ax.localhost:8790'
const T = 'ax-demo'
const PROC = 'process:79928ca715' // 요청 접수 · 견적 제안
const HERE = new URL('..', import.meta.url).pathname
let failed = 0
const step = async (name, fn) => {
  try { const r = await fn(); console.log(`✓ ${name}`, JSON.stringify(r ?? '').slice(0, 320)) } catch (e) { failed++; console.log(`✗ ${name}`, e.message) }
}
async function call(tok, method, path, body) {
  const r = await fetch(`${API}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` }, body: body ? JSON.stringify(body) : undefined })
  return { status: r.status, body: await r.json().catch(() => ({})) }
}
const ok = async (tok, method, path, body) => { const r = await call(tok, method, path, body); assert.ok(r.status < 300, `${method} ${path} → ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`); return r.body }
async function signIn(email) {
  const r = await fetch(`${API}/api/auth/email/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, code: '000000' }) })
  const j = await r.json()
  assert.ok(j.session?.access_token, `sign-in ${email}`)
  return { id: j.user.id, tok: j.session.access_token }
}
const seed = (...args) => {
  const r = spawnSync(process.execPath, ['scripts/seed-flow-demo.mjs', ...args], { cwd: HERE, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr.slice(0, 300))
  return r.stdout
}

const [{ n: seeded }] = await q(`select count(*)::int as n from pro_po_cases where tenant_id=$1 and request->>'seed'='flow-demo'`, [T])
assert.ok(seeded > 20, '시드가 없어요 — node scripts/seed-flow-demo.mjs --plans 먼저')
const [{ n: plans0 }] = await q(`select count(*)::int as n from pro_improve_plans where tenant_id=$1`, [T])
assert.equal(plans0, 0, '지난 개선안이 남았어요 — node scripts/seed-flow-demo.mjs --plans')
const boss = await signIn('pro-ax-jinyoung@uengine.org')
const minji = await signIn('pro-ax-minji@uengine.org')
const doyun = await signIn('pro-ax-doyun@uengine.org')
const counts = async () => (await q(`select (select count(*) from pro_corrections where tenant_id=$1 and proc_key=$2)::int as c, (select count(*) from pro_role_members where tenant_id=$1)::int as m, (select count(*) from pro_improve_plans where tenant_id=$1)::int as p`, [T, PROC]))[0]
let hana, A, B, W

await step('S6 고쳐 보기: AI 초안 먼저 · 사람 더하기 → 지금 들어오면 · 보통 건 · 디자이너의 짐이 준다(아무것도 쓰지 않음)', async () => {
  const before = await counts()
  const people = await ok(boss.tok, 'GET', `/ontology/flow/people?role=${encodeURIComponent('디자이너')}`)
  hana = people.people.find((p) => p.name === '정하나')
  assert.ok(hana && !people.people.some((p) => p.roles.includes('디자이너')), '디자이너가 아닌 사람들')
  W = await ok(boss.tok, 'POST', '/ontology/flow/whatif', { proc: PROC, levers: [{ type: 'draft', task: '평면도 작성', save: 0.5 }, { type: 'capacity', role: '디자이너', n: 1, people: [{ id: hana.id, name: hana.name }] }] })
  const flow = await ok(boss.tok, 'GET', `/ontology/flow?proc=${encodeURIComponent(PROC)}`)
  assert.equal(W.before.nowH, flow.path.nowH, '앞은 병목 보기의 흔한 길과 같다')
  assert.equal(W.before.bottleneck.key, '평면도 작성')
  assert.ok(W.after.nowH < W.before.nowH && W.after.pastH < W.before.pastH, `${W.before.nowH}→${W.after.nowH} · ${W.before.pastH}→${W.after.pastH}`)
  const d0 = W.before.roles.find((r) => r.role === '디자이너'), d1 = W.after.roles.find((r) => r.role === '디자이너')
  assert.equal(d1.members, d0.members + 1)
  assert.ok(d0.rho > 1 && d1.rho < 1, `디자이너 가동률 ${d0.rho} → ${d1.rho}`)
  assert.ok(W.after.monthly.hours < W.before.monthly.hours)
  assert.ok(W.notes.some((n) => n.includes('가정')))
  assert.deepEqual(await counts(), before, '고쳐 보기는 쓰지 않는다')
  return { now: `${W.before.nowH}→${W.after.nowH}`, past: `${W.before.pastH}→${W.after.pastH}`, rho: `${d0.rho}→${d1.rho}` }
})

await step('S7 개선안: 두 안을 저장해 견준다 · 정하기는 관리자만', async () => {
  A = await ok(boss.tok, 'POST', '/ontology/plans', { proc: PROC, name: 'AI 초안 먼저', levers: [{ type: 'draft', task: '평면도 작성', save: 0.5 }] })
  B = await ok(boss.tok, 'POST', '/ontology/plans', { proc: PROC, name: '초안 먼저 + 한 사람 더', levers: [{ type: 'draft', task: '평면도 작성', save: 0.5 }, { type: 'capacity', role: '디자이너', n: 1, people: [{ id: hana.id, name: hana.name }] }] })
  assert.equal(B.predicted.nowH, W.after.nowH, '저장한 예상 = 고쳐 본 결과')
  assert.ok(A.predicted.nowH > B.predicted.nowH, '사람까지 더한 안이 더 빠르다')
  assert.ok(B.mapAt && B.baseline && B.status === 'draft')
  const list = await ok(minji.tok, 'GET', `/ontology/plans?proc=${encodeURIComponent(PROC)}`)
  assert.equal(list.plans.length, 2)
  assert.equal(list.plans.every((p) => !p.can.decide), true, '김민지(관리자 아님)에게는 정하기가 없다')
  const r = await call(minji.tok, 'POST', `/ontology/plans/${A.id}/decide`, {})
  assert.equal(r.status, 403)
  const mine = await ok(minji.tok, 'POST', '/ontology/plans', { proc: PROC, name: '민지의 안', levers: [{ type: 'skip', task: '평면도 검토', share: 0.3 }] })
  await ok(minji.tok, 'DELETE', `/ontology/plans/${mine.id}`)
  return { A: A.predicted.nowH, B: B.predicted.nowH }
})

await step('S8 합의: 의견으로 올림 → 같은 의견 → 반대 의견이 상충으로 → 관리자가 안을 고름 → 안이 정해짐', async () => {
  const v = await ok(boss.tok, 'POST', `/ontology/plans/${B.id}/vote`)
  assert.equal(v.status, 'voted')
  const g = await ok(minji.tok, 'POST', `/ontology/plans/${B.id}/agree`)
  assert.equal(g.opinion.agree, 2)
  const o = await ok(doyun.tok, 'POST', '/ontology/opinions', { proc: PROC, words: '평면도는 고객마다 달라서 디자이너가 처음부터 그려야 해요', ops: [{ op: 'set_runner', args: { task: '평면도 작성', runner: 'person' } }] })
  const ov = await ok(boss.tok, 'GET', `/ontology/processes/${encodeURIComponent(PROC)}/opinions`)
  const c = ov.conflicts.find((x) => x.opinions.some((y) => y.id === v.opinion.id))
  assert.ok(c && c.opinions.some((y) => y.id === o.opinion.id), '안의 의견과 도윤의 의견이 한 상충')
  assert.ok(c.kinds.includes('하는 이'))
  const before = await counts()
  await ok(boss.tok, 'POST', `/ontology/processes/${encodeURIComponent(PROC)}/opinions/resolve`, { action: 'apply', opinion: v.opinion.id, opinions: c.opinions.map((y) => y.id), note: '초안은 틀만, 마감은 디자이너가 해요' })
  const p = await ok(boss.tok, 'GET', `/ontology/plans/${B.id}`)
  assert.equal(p.status, 'decided')
  assert.ok(p.effectiveAt && p.batch)
  assert.deepEqual(p.membersAdded.map((m) => m.name), ['정하나'])
  const [cor] = await q(`select op, args from pro_corrections where tenant_id=$1 and batch=$2`, [T, p.batch])
  assert.deepEqual({ op: cor.op, runner: cor.args.runner, task: cor.args.task }, { op: 'set_runner', runner: 'draft', task: '평면도 작성' })
  const [m] = await q(`select 1 from pro_role_members where tenant_id=$1 and role='디자이너' and user_id::text=$2`, [T, hana.id])
  assert.ok(m, '정하나가 디자이너 역할에')
  const [d] = await q(`select state from pro_map_opinions where tenant_id=$1 and id=$2`, [T, o.opinion.id])
  assert.equal(d.state, 'superseded')
  const after = await counts()
  assert.equal(after.c, before.c + 1)
  const [led] = await q(`select subject from pro_policy_decisions where tenant_id=$1 and action_kind='ontology.improve_plan' order by created_at desc limit 1`, [T]).catch(() => [])
  assert.match(led?.subject || '', /개선안 정함/)
  return { batch: p.batch, members: p.membersAdded, ledger: led?.subject }
})

await step('S9 일마다 AI 초안: 정한 뒤 지도 엔진이 여는 「평면도 작성」은 초안 단계로', async () => {
  // 김민지의 열린 현장 실측을 내면 지도가 다음 단계(평면도 작성)를 연다
  const [t] = await q(`select t.id::text as id, t.proc_inst_id from todolist t join pro_po_cases c on t.proc_inst_id = any(c.instances)
                       where c.tenant_id=$1 and c.bundle=$2 and t.activity_name='현장 실측' and t.status='IN_PROGRESS' and t.user_id like $3 order by t.start_date limit 1`, [T, PROC, `%${minji.id}%`])
  assert.ok(t, '김민지의 열린 현장 실측')
  await ok(minji.tok, 'POST', `/todos/${t.id}/submit`, { values: { result: '실측 끝났어요' } })
  const [s] = await q(`select s.kind, s.act->>'runner' as runner, t.activity_name, t.agent_mode::text as agent_mode from pro_case_steps s join todolist t on t.id = s.todo_id
                       where s.proc_inst_id=$1 and t.activity_name='평면도 작성' order by s.created_at desc limit 1`, [t.proc_inst_id])
  assert.ok(s, '평면도 작성이 열렸다')
  assert.equal(s.kind, 'draft', `초안 단계: ${JSON.stringify(s)}`)
  // the step's own say (set_runner draft), not only the process's stage (자동 — every person's step drafted)
  assert.equal(s.runner, 'draft', '일 정의의 하는 이 = 초안')
  return s
})

await step('S10 시행 전후: 효력일 뒤의 실행 기록으로 다시 재서 예상과 견준다(시험용으로 2주 앞당겨 다시 씀)', async () => {
  const out = seed('--after', B.id, '--weeks', '2')
  assert.match(out, /효력일을/)
  const r = await ok(boss.tok, 'GET', `/ontology/plans/${B.id}/review`)
  assert.ok(r.since.workDays >= 9 && r.since.items > 20, JSON.stringify(r.since))
  const row = (k) => r.rows.find((x) => x.key === k)
  assert.ok(row('path').actual < row('path').before, `보통 건 ${row('path').before} → ${row('path').actual}`)
  assert.ok(row('bott').actual < row('bott').before)
  assert.ok(r.rows.every((x) => x.verdict), '줄마다 견준 말')
  assert.ok(r.moved && r.moved.from === '평면도 작성', `병목이 옮겨 갔다: ${JSON.stringify(r.moved)}`)
  const flow = await ok(boss.tok, 'GET', `/ontology/flow?proc=${encodeURIComponent(PROC)}`)
  assert.notEqual(flow.bottleneck?.key, '평면도 작성')
  return { rows: r.rows.map((x) => `${x.key}:${x.before}→${x.predicted}/${x.actual}(${x.verdict})`), moved: r.moved }
})

if (!process.argv.includes('--keep')) { seed('--plans'); console.log('(개선안 · 그 고침을 지우고 시드를 다시 썼어요)') }
await pool.end()
console.log(failed ? `\n${failed}개 실패` : '\n모두 통과')
process.exit(failed ? 1 : 0)
