// 지도에서 바로 실행(lib/ontology/mapengine.js) HTTP e2e — 로컬 Lite(localhost 테넌트, :8787)의 실제 프로세스로.
// ontology-mapengine.e2e.mjs 의 a · b · h 를 jy-mail 준비(강의 프로세스 · 에이전트 단계) 없이 옮겼다: 프로세스를 「제안」 단계(단계마다 사람이 정함)로 두고
// 단계마다 사람이 건너뛰기만 해 에이전트 · 메일 작업은 하지 않는다. 건너뛸 수 있게 그 프로세스의 간선을 잠시 「해도 되고 안 해도 되는 단계」로 둔다.
//
//   cd server && node test/ontology-mapengine-local.e2e.mjs [--proc process:…] [--as 관리자메일]
//     a  중간에서 시작 — 인스턴스 하나 · onto-map. · 스냅샷 0 · 요청 접수 행 없음 · bpm_proc_inst 한 행(제목 · 정의 없음 · 진행 중 · 지금 단계),
//        건너뛰며 끝까지 — 인스턴스 하나 그대로 · 새 proc_def 0 · 인스턴스 행 COMPLETED
//     b  되감기 한 번 — 같은 인스턴스 · 뒤 단계 행은 닫힘(CANCELLED) · 되감은 단계 via rewound · bpm_proc_inst 한 행 그대로
//     h  단계마다 사람이 정함 — 중간 시작한 에이전트 단계도 묻고(hitl) · 선택으로 읽고 · 건너뛰면 행은 DONE(건너뜀) · 지도가 다음 단계를 정하고 또 묻는다,
//        사람 단계는 정하기 전까지 그 사람 목록에 없음
//   끝나면 바꾼 간선 설정 · 프로세스 단계 · 엔진을 처음대로 되돌린다. 만든 건은 멈춰 두고 지우지 않는다.
process.env.DOTENV_CONFIG_QUIET = 'true'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

const { q } = await import('../lib/supa.js')
const { withTenant } = await import('../lib/tenant.js')
const { cypher, closeOntology } = await import('../lib/ontology/store.js')

const API = process.env.API_URL || `http://localhost:${process.env.PRO_PORT || 8787}/api`
const T = process.env.PRO_TENANT_ID || 'localhost'
const argv = process.argv.slice(2)
const arg = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : null)
const BOSS = arg('--as') || process.env.E2E_ADMIN || 'resume-e2e@localhost.dev'
const PROC = arg('--proc') || 'process:6ab5624c15'
const START = new Date()
const stamp = START.toISOString().slice(11, 16)
const checks = [], cases = []

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)
function check(label, ok, detail = '') {
  checks.push({ label, ok: !!ok })
  log(ok ? '  ✓' : '  ✗', label, detail ? `— ${detail}` : '')
  if (!ok) throw new Error(`실패: ${label} ${detail}`)
}
async function call(tok, method, p, body) {
  const r = await fetch(`${API}${p}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` }, body: body ? JSON.stringify(body) : undefined })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw Object.assign(new Error(`${method} ${p} → ${r.status} ${j.error || ''}`), { status: r.status, body: j })
  return j
}
async function signIn(email) {
  const r = await fetch(`${API}/auth/email/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, code: '000000' }) })
  const j = await r.json()
  assert.ok(j.session?.access_token, `sign-in ${email}`)
  return { id: j.user.id, tok: j.session.access_token, email }
}
async function waitFor(what, fn, { timeout = 90_000, every = 1500 } = {}) {
  const until = Date.now() + timeout
  for (;;) {
    const v = await fn().catch((e) => { log('  (wait)', e.message); return null })
    if (v) return v
    if (Date.now() > until) throw new Error(`시간 초과: ${what}`)
    await sleep(every)
  }
}
const enc = encodeURIComponent
const actId = (task) => `t_${crypto.createHash('sha1').update(String(task)).digest('hex').slice(0, 10)}`
const caseRow = async (id) => (await q(`select id::text as id, engine, run_mode, instances, snapshots, history, status, entry_task from pro_po_cases where id=$1`, [id]))[0]
const instRow = async (inst) => (await q(`select proc_inst_name, proc_def_id, status::text as status, participants, current_activity_ids, tenant_id from bpm_proc_inst where proc_inst_id=$1`, [inst]))[0]
const procDefs = async () => Number((await q(`select count(*) n from proc_def where tenant_id=$1`, [T]))[0].n)
// the step the case waits on now (a person decides: HITL)
const waitingStep = async (caseId) => (await q(`select s.*, t.status::text as todo_status from pro_case_steps s join todolist t on t.id=s.todo_id where s.case_id=$1 and s.state='waiting' and s.message_id is not null order by s.created_at desc limit 1`, [caseId]))[0]
const stepOf = async (caseId, task) => (await q(`select s.*, t.status::text as todo_status from pro_case_steps s join todolist t on t.id=s.todo_id where s.case_id=$1 and s.task=$2 order by s.created_at desc limit 1`, [caseId, task]))[0]
async function startCase(who, entry, subject) {
  const r = await call(who.tok, 'POST', '/ontology/cases', { proc: PROC, entry, subject: `${subject} ${stamp}`, body: `${subject}(지도 실행 e2e — 단계는 건너뛰기만 해요)`, from: '시험 <e2e@example.test>', kind: 'manual' })
  cases.push(r.caseId)
  return r.caseId
}

// every edge into the process's steps made 「해도 되고 안 해도 되는 단계」 for the run (rules off), each put back at the end
const touched = []
async function allOptional(boss) {
  const P = `/ontology/processes/${enc(PROC)}`
  for (const e of (await call(boss.tok, 'GET', `${P}/edge-conditions`)).edges) {
    if (e.kind === 'end') continue
    const v = await call(boss.tok, 'GET', `${P}/edge-condition?event=${enc(e.event)}&task=${enc(e.task)}`)
    touched.push(v)
    await call(boss.tok, 'PUT', `${P}/edge-condition`, { event: e.event, task: e.task, requirement: 'optional', rules: [], class: v.class?.decided ? v.class.class : null, reason: 'e2e: 지도 실행(건너뛰기)' })
  }
}
async function putBack(boss) {
  const P = `/ontology/processes/${enc(PROC)}`
  for (const v of touched) await call(boss.tok, 'PUT', `${P}/edge-condition`, { event: v.event, task: v.task, requirement: v.requirement || null, rules: (v.rules || []).map((r) => ({ when: r.when, then: r.then })),
    class: v.class?.decided ? v.class.class : null, reason: 'e2e: 원래대로' }).catch((e) => log('  되돌리기 실패', v.event, v.task, e.message))
}

async function phaseA(boss, view) {
  log('— (a) 중간에서 시작 → 건너뛰며 끝까지')
  const defs0 = await procDefs()
  const entry = view.entry
  const id = await startCase(boss, entry, '[e2e] 지도 실행 중간 시작')
  const c = await caseRow(id)
  check('건의 엔진은 지도에서 바로(map) · 단계마다 사람이 정함', c.engine === 'map' && c.run_mode === 'hitl', `${c.engine} · ${c.run_mode}`)
  check('인스턴스 하나 · onto-map. · 스냅샷 0', c.instances.length === 1 && c.instances[0].startsWith('onto-map.') && !c.snapshots?.length, c.instances[0])
  check(`중간에서 시작(첫 일 「${view.first}」이 아님)`, c.entry_task === entry && entry !== view.first, `${c.entry_task} · 건너뜀 ${(c.history || []).filter((h) => h.state === 'skipped').map((h) => h.task).join(', ') || '없음'}`)
  check('요청 접수 행이 없다', !(await q(`select 1 from todolist where proc_inst_id=$1 and activity_id='intake'`, [c.instances[0]])).length)
  const first = await waitFor('첫 단계가 묻는다', async () => { const s = await waitingStep(id); return s?.task === entry ? s : null })
  check('첫 단계 행: 지도에서 정함(entry) · map_at', first.via?.how === 'entry' && !!first.map_at, JSON.stringify(first.via))
  const i0 = await instRow(c.instances[0])
  check('bpm_proc_inst 한 행: 제목 · 정의 없음 · 진행 중 · 시작한 사람 · 지금 단계', !!i0 && i0.proc_inst_name.includes('지도 실행 중간 시작') && i0.proc_def_id === null && i0.status === 'RUNNING' &&
    i0.participants.includes(boss.id) && i0.current_activity_ids.includes(actId(entry)) && i0.tenant_id === T, JSON.stringify({ status: i0?.status, cur: i0?.current_activity_ids }))
  // skip each step as it asks, until the case ends (the map picks the next one each time)
  const path = [entry]
  let last = first
  for (let n = 0; n < 14; n++) {
    const d = await call(boss.tok, 'POST', `/ontology/steps/${last.id}`, { action: 'skip', reason: 'e2e: 건너뜀' })
    assert.ok(d.skipped, `「${last.task}」 건너뛰기: ${JSON.stringify(d)}`)
    const next = await waitFor('다음 단계 또는 끝', async () => {
      if ((await caseRow(id)).status === 'done') return { done: true }
      const s = await waitingStep(id)
      return s && s.id !== last.id ? s : null
    })
    if (next.done) break
    path.push(`${next.task}(${next.via?.how})`)
    last = next
  }
  const ce = await caseRow(id)
  check('건너뛰며 지나간 길의 끝에서 건이 끝남', ce.status === 'done', path.join(' → '))
  check('끝까지 인스턴스 하나 · 새 proc_def 0', ce.instances.length === 1 && (await procDefs()) === defs0, `instances ${ce.instances.length} · proc_def +${(await procDefs()) - defs0}`)
  const ie = await instRow(ce.instances[0])
  check('끝: 인스턴스 행 COMPLETED · 열린 단계 없음', ie.status === 'COMPLETED' && !ie.current_activity_ids.length, JSON.stringify({ status: ie.status, cur: ie.current_activity_ids }))
  check('bpm_proc_inst 는 끝까지 한 행', Number((await q(`select count(*) n from bpm_proc_inst where proc_inst_id = any($1)`, [ce.instances]))[0].n) === 1)
}

async function phaseB(boss, view) {
  log('— (b) 되감기 한 번')
  const id = await startCase(boss, view.entry, '[e2e] 지도 실행 되감기')
  const w = await waitFor('첫 단계가 묻는다', async () => waitingStep(id))
  await call(boss.tok, 'POST', `/ontology/steps/${w.id}`, { action: 'skip', reason: 'e2e: 건너뜀' })
  const y = await waitFor('다음 단계가 묻는다', async () => { const s = await waitingStep(id); return s && s.id !== w.id ? s : null })
  const c0 = await caseRow(id)
  const ask = await call(boss.tok, 'POST', `/ontology/cases/${id}/rewind`, { task: view.entry })
  const rw = ask.confirm ? await call(boss.tok, 'POST', `/ontology/cases/${id}/rewind`, { task: view.entry, confirm: true }) : ask
  const c = await caseRow(id)
  check('되감은 뒤에도 같은 인스턴스(하나)', c.instances.length === 1 && c.instances[0] === c0.instances[0] && (!rw.instId || rw.instId === c.instances[0]), c.instances[0])
  check(`뒤 단계 「${y.task}」 행은 닫힘(CANCELLED)`, (await q(`select status::text s from todolist where id=$1`, [y.todo_id]))[0].s === 'CANCELLED')
  const again = await waitFor('되감은 단계 행', async () => { const s = await stepOf(id, view.entry); return s?.via?.how === 'rewound' ? s : null })
  check('되감은 단계 행: via rewound', again.via.how === 'rewound', JSON.stringify(again.via))
  const ir = await instRow(c.instances[0])
  check('bpm_proc_inst 한 행 그대로 · 진행 중 · 지금 단계는 되감은 단계', Number((await q(`select count(*) n from bpm_proc_inst where proc_inst_id = any($1)`, [c.instances]))[0].n) === 1 && ir.status === 'RUNNING' && ir.current_activity_ids.join() === actId(view.entry),
    JSON.stringify({ status: ir.status, cur: ir.current_activity_ids }))
  check('되감기 1번이 기록에', (c.history || []).filter((h) => h.state === 'rewound').length === 1)
  await call(boss.tok, 'POST', `/ontology/cases/${id}/pause`).catch(() => {})
}

async function phaseH(boss, view) {
  log('— (h) 단계마다 사람이 정함 · 해도 되고 안 해도 되는 단계')
  // an agent's step started in the middle (the way in from the skipped step is 선택 for the run): the owner is asked, the agent does not take it
  const id = await startCase(boss, view.entry, '[e2e] 지도 실행 단계마다 확인')
  const w = await waitFor(`「${view.entry}」이 확인을 기다림`, async () => { const s = await waitingStep(id); return s?.task === view.entry ? s : null })
  const agent = !!(await q(`select agent_orch from todolist where id=$1`, [w.todo_id]))[0]?.agent_orch
  check('HITL: 에이전트 단계도 주인에게 묻는다(에이전트가 잡지 않음)', (w.why || []).includes('hitl') && (!agent || w.todo_status === 'IN_PROGRESS'), `${(w.why || []).join(',')} · ${agent ? '에이전트' : '사람'} · ${w.todo_status}`)
  check('해도 되고 안 해도 되는 단계로 읽음(건너뛴 앞 단계에서 들어온 간선)', w.requirement === 'optional', `${w.requirement} · ${JSON.stringify(w.matched?.edge || null)}`)
  const d = await call(boss.tok, 'POST', `/ontology/steps/${w.id}`, { action: 'skip', reason: 'e2e: 이미 했어요' })
  check('건너뛰기', d.skipped === true)
  const sk = await stepOf(id, view.entry)
  const t = (await q(`select status::text as status, output from todolist where id=$1`, [sk.todo_id]))[0]
  check('건너뛴 단계: 행은 끝(DONE) · 결과는 건너뜀 · 단계 행 skipped', t.status === 'DONE' && Object.values(t.output || {})[0]?.skipped === true && sk.state === 'skipped', `${t.status} · ${sk.state}`)
  const n = await waitFor('다음 단계가 다시 묻는다', async () => { const s = await waitingStep(id); return s && s.id !== w.id ? s : null })
  check('건너뛴 뒤 지도가 다음 단계를 정함 · HITL 이라 또 묻는다', n.via?.from === view.entry && !!n.via?.how && (n.why || []).includes('hitl'), `${n.task} · ${n.via?.how} · ${n.via?.why || ''}`)
  await call(boss.tok, 'POST', `/ontology/cases/${id}/pause`).catch(() => {})
  // a person's step is kept off their list until the owner says 진행 (HITL)
  const id2 = await startCase(boss, view.first, '[e2e] 지도 실행 사람 단계 확인')
  const w2 = await waitFor(`「${view.first}」이 확인을 기다림`, async () => { const s = await waitingStep(id2); return s?.task === view.first ? s : null })
  const person = !(await q(`select agent_orch from todolist where id=$1`, [w2.todo_id]))[0]?.agent_orch
  if (person) check('HITL: 사람 단계는 정하기 전까지 그 사람 목록에 없음(hold · TODO)', w2.hold_item === true && w2.todo_status === 'TODO', `hold ${w2.hold_item} · ${w2.todo_status}`)
  else log(`  · 「${view.first}」은 에이전트 단계라 사람 단계 확인은 건너뜀`)
  await call(boss.tok, 'POST', `/ontology/cases/${id2}/pause`).catch(() => {})
}

async function main() {
  const boss = await signIn(BOSS)
  log(`관리자 ${BOSS} · ${API} · 테넌트 ${T} · ${PROC}`)
  const engine0 = await call(boss.tok, 'GET', '/ontology/engine')
  check('관리자 계정', engine0.admin === true)
  const [st0] = await withTenant(T, () => cypher(`MATCH (b:Process {key:$key}) RETURN b.status AS status, b.name AS name, b.entries AS entries, b.tasks AS tasks`, { key: PROC }))
  check('프로세스', !!st0?.name, st0?.name)
  // the first step of the flow and a step after it to start in the middle at (one the first leads to)
  const ways = (await call(boss.tok, 'GET', `/ontology/processes/${enc(PROC)}/edge-conditions`)).edges
  const first = (st0.entries || [])[0] || (st0.tasks || [])[0]
  const entry = ways.find((e) => e.event === `done:${first}` && e.task !== first)?.step || ways.find((e) => ['artifact', 'done'].includes(e.kind) && e.step !== first)?.step
  check('첫 일과 그 뒤의 일', first && entry, `${first} → ${entry}`)
  const view = { first, entry }
  if (engine0.engine !== 'map') await call(boss.tok, 'PUT', '/ontology/engine', { engine: 'map' })
  if (st0.status !== 'suggested') await call(boss.tok, 'POST', '/ontology/processes/status', { key: PROC, status: 'suggested', name: st0.name })
  try {
    await allOptional(boss)
    await phaseA(boss, view)
    await phaseB(boss, view)
    await phaseH(boss, view)
  } finally {
    await putBack(boss)
    const back = (await call(boss.tok, 'GET', `/ontology/processes/${enc(PROC)}/edge-conditions`)).edges
    const off = touched.filter((v) => { const e = back.find((x) => x.event === v.event && x.task === v.task); return (e?.setting?.requirement || null) !== (v.requirement || null) || JSON.stringify((e?.setting?.rules || []).map((r) => [r.when, r.then])) !== JSON.stringify((v.rules || []).map((r) => [r.when, r.then])) })
    log(off.length ? `  ✗ 되돌리지 못한 간선 ${off.map((v) => `${v.event}→${v.task}`).join(', ')}` : `  ✓ 바꾼 간선 ${touched.length}개를 처음대로`)
    if (st0.status && st0.status !== 'suggested') await call(boss.tok, 'POST', '/ontology/processes/status', { key: PROC, status: st0.status, name: st0.name }).catch((e) => log('  단계 되돌리기', e.message))
    if (engine0.engine !== 'map') await call(boss.tok, 'PUT', '/ontology/engine', { engine: engine0.engine }).catch((e) => log('  엔진 되돌리기', e.message))
  }
}

let failed = false
try { await main(); log(`통과 ${checks.filter((c) => c.ok).length}개 · 건 ${cases.join(', ')} (멈춰 둠)`) } catch (e) { failed = true; log('실패', e.message) }
await closeOntology().catch(() => {})
process.exit(failed ? 1 : 0)
