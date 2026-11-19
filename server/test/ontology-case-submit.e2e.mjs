// E2E 건 화면에서 내 단계 내기(runmode.js runView 의 mine → OntoCaseRun 의 TodoCard): over HTTP against a running server + the real DB.
// The seed (scripts/seed-flow-demo.mjs) puts six weeks of 「지도에서 바로」(mapengine.js) cases in ax-demo; 김민지(디자이너) holds open
// 평면도 작성 — or, after a decided 개선안 added a designer, only 현장 실측: the test takes her 평면도 작성 when there is one, else another open step.
//   C1 길: 김민지의 프로세스 목록에 그 건이 「입력 필요」로 있고(engine map · case_id · case_proc → /process-map?proc=…&case=…),
//      /projects/p/<instId> 도 같은 건 화면으로 간다(getInstance mapCase)
//   C2 mine: 김민지가 건을 보면 그 단계가 mine(사람 차례 · 그 사람의 할 일), 표시된 mine 은 모두 그 사람이 맡은 열린 단계
//   C3 남: 건의 주인(관리자) · 다른 사람이 보면 그 단계는 mine 이 아니고, 그들의 mine 도 그들이 맡은 단계뿐
//   C4 내기: 건 화면의 카드가 보내는 그대로(POST /todos/:id/submit) 내면 지도 엔진이 지도의 다음 단계(평면도 작성 다음은 제안서 작성)를 열고,
//      건 화면에 끝남 · 다음 단계가 보인다
//
//   cd server && node scripts/seed-flow-demo.mjs && PRO_API=http://ax.localhost:8790 node test/ontology-case-submit.e2e.mjs [--keep]
// --keep: leave the hand-in (else the seed is written again at the end, so the screen starts from the same numbers)
process.env.DOTENV_CONFIG_QUIET = 'true'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { q, pool } from '../lib/supa.js'

const API = process.env.PRO_API || 'http://ax.localhost:8790'
const T = 'ax-demo'
const PROC = 'process:79928ca715' // 요청 접수 · 견적 제안
let failed = 0
const step = async (name, fn) => {
  try { const r = await fn(); console.log(`✓ ${name}`, JSON.stringify(r ?? '').slice(0, 300)) } catch (e) { failed++; console.log(`✗ ${name}`, e.message) }
}
async function call(tok, method, path, body) {
  const r = await fetch(`${API}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` }, body: body ? JSON.stringify(body) : undefined })
  return { status: r.status, body: await r.json().catch(() => ({})) }
}
async function signIn(email) {
  const r = await fetch(`${API}/api/auth/email/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, code: '000000' }) })
  const j = await r.json()
  assert.ok(j.session?.access_token, `sign-in ${email}`)
  return { id: j.user.id, email, tok: j.session.access_token }
}
const run = async (u, caseId) => { const r = await call(u.tok, 'GET', `/ontology/cases/${caseId}/run`); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body }
// every step a viewer is shown as theirs is an open person's turn they hold (todolist.user_id, a comma list)
async function minesAreTheirs(u, v) {
  for (const s of v.steps.filter((x) => x.mine)) {
    assert.equal(s.state, 'person', `「${s.task}」 mine 인데 ${s.state}`)
    const [t] = await q(`select user_id, status::text as status from todolist where id=$1`, [s.todoId])
    assert.ok(String(t.user_id).split(',').map((x) => x.trim()).some((x) => x === u.id || x === u.email), `「${s.task}」 mine 인데 맡은 사람이 아니에요`)
    assert.equal(t.status, 'IN_PROGRESS')
  }
}

const [{ n: seeded }] = await q(`select count(*)::int as n from pro_po_cases where tenant_id=$1 and request->>'seed'='flow-demo'`, [T])
assert.ok(seeded > 20, '시드가 없어요 — node scripts/seed-flow-demo.mjs 먼저')
const boss = await signIn('pro-ax-jinyoung@uengine.org')
const minji = await signIn('pro-ax-minji@uengine.org')
const doyun = await signIn('pro-ax-doyun@uengine.org')
// one of 김민지's open steps of a map case — 평면도 작성 when she has one (the oldest; a decided 개선안 that added a designer can leave her
// only 현장 실측), its case and instance — one whose case is in her 프로세스 list (her newest 30, the ones waiting on her first)
const listed = new Set(((await call(minji.tok, 'GET', '/instances')).body || []).map((i) => i.proc_inst_id))
const open = await q(`select t.id::text as id, t.proc_inst_id, t.activity_name as task, c.id::text as case_id, c.bundle as proc from todolist t join pro_po_cases c on t.proc_inst_id = any(c.instances)
                      where c.tenant_id=$1 and c.engine='map' and t.status='IN_PROGRESS' and coalesce(t.agent_orch,'')='' and t.user_id like '%'||$2||'%'
                      order by (t.activity_name='평면도 작성' and c.bundle=$3) desc, t.start_date`, [T, minji.id, PROC])
const T0 = open.find((t) => listed.has(t.proc_inst_id)) || open[0]
assert.ok(T0, '김민지의 열린 단계')

await step('C1 길: 프로세스 목록의 그 건(입력 필요) → 지도의 건 화면, /projects/p/<instId> 도 같은 건으로', async () => {
  const r = await call(minji.tok, 'GET', '/instances')
  assert.equal(r.status, 200)
  const i = r.body.find((x) => x.proc_inst_id === T0.proc_inst_id)
  assert.ok(i, '김민지의 프로세스 목록에 그 건이 있다')
  assert.equal(i.engine, 'map')
  assert.equal(i.needs_me, true)
  assert.equal(i.case_id, T0.case_id)
  assert.equal(i.case_proc, T0.proc)
  const d = await call(minji.tok, 'GET', `/instances/${encodeURIComponent(T0.proc_inst_id)}`)
  assert.equal(d.status, 200)
  assert.deepEqual(d.body.mapCase, { id: T0.case_id, proc: T0.proc })
  return { url: `/process-map?proc=${encodeURIComponent(i.case_proc)}&case=${i.case_id}`, from: `/projects/p/${T0.proc_inst_id}` }
})

await step(`C2 mine: 김민지가 건을 보면 그 단계(${T0.task})가 mine, 표시된 mine 은 모두 그 사람의 열린 단계`, async () => {
  const v = await run(minji, T0.case_id)
  const s = v.steps.find((x) => x.todoId === T0.id)
  assert.ok(s, '건 화면에 그 단계')
  assert.equal(s.current, true)
  assert.equal(s.state, 'person')
  assert.equal(s.mine, true)
  await minesAreTheirs(minji, v)
  // the work item the card loads (GET /todos/:id) is the map's task with its one field
  const d = await call(minji.tok, 'GET', `/todos/${T0.id}`)
  assert.equal(d.status, 200)
  assert.ok(d.body.form?.fields?.some((f) => f.key === 'result'), JSON.stringify(d.body.form))
  return { task: s.task, holder: s.holder?.names, mine: v.steps.filter((x) => x.mine).map((x) => x.task) }
})

await step('C3 남: 건의 주인(관리자)과 다른 사람에게는 그 단계가 mine 이 아니다', async () => {
  const out = {}
  for (const u of [boss, doyun]) {
    const v = await run(u, T0.case_id)
    const s = v.steps.find((x) => x.todoId === T0.id)
    assert.equal(s.mine, false, `${u.email} 에게 mine`)
    await minesAreTheirs(u, v)
    out[u.email.split('@')[0]] = v.steps.filter((x) => x.mine).length
  }
  // the case's owner keeps the owner's controls — not the step's form
  assert.equal((await run(boss, T0.case_id)).controls.mine, true)
  return out
})

await step('C4 내기: 카드가 보내는 그대로 내면 지도 엔진이 다음 단계(평면도 작성 다음은 제안서 작성)를 열고, 건 화면에 끝남 · 다음 단계', async () => {
  const r = await call(minji.tok, 'POST', `/todos/${T0.id}/submit`, { values: { result: `${T0.task} 했어요(건 화면에서)` } })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  // the step the map engine made from her hand-in (its row says which step it came from)
  const [next] = await q(`select t.id::text as id, t.activity_name, t.status::text as status, s.via from pro_case_steps s join todolist t on t.id = s.todo_id
                          where s.case_id=$1 and s.via->>'fromTodo' = $2`, [T0.case_id, T0.id])
  assert.ok(next, '다음 단계가 열렸다')
  assert.equal(next.via.from, T0.task)
  assert.ok(!['DONE', 'CANCELLED'].includes(next.status), next.status)
  if (T0.task === '평면도 작성') assert.equal(next.activity_name, '제안서 작성')
  const v = await run(minji, T0.case_id)
  const done = v.steps.find((x) => x.todoId === T0.id)
  assert.equal(done.state, 'done')
  assert.equal(done.mine, false)
  const now = v.steps.find((x) => x.todoId === next.id)
  assert.ok(now?.current, '건 화면에 다음 단계')
  assert.notEqual(now.state, 'done')
  // a second hand-in of the same step is refused (the card shows it handed in, the engine says it is closed)
  const again = await call(minji.tok, 'POST', `/todos/${T0.id}/submit`, { values: { result: '한 번 더' } })
  assert.notEqual(again.status, 200)
  return { next: next.activity_name, state: now.state, holder: now.holder?.names || now.holder?.name }
})

if (!process.argv.includes('--keep')) {
  const r = spawnSync(process.execPath, ['scripts/seed-flow-demo.mjs'], { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8' })
  console.log(r.status === 0 ? '(시드를 다시 썼어요)' : `(시드 다시 쓰기 실패: ${r.stderr.slice(0, 200)})`)
}
await pool.end()
console.log(failed ? `\n${failed}개 실패` : '\n모두 통과')
process.exit(failed ? 1 : 0)
