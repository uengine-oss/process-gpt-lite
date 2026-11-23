// 지도에서 바로 실행(lib/ontology/mapengine.js) · 사건 → 시작(events.js) HTTP e2e — 실제 메일 테넌트 jy-mail 의 「강의계획서 작성 · 보고」
// (process:5c5451687f)로, 돌고 있는 BFF(:8790)에 시험용 메일(POST /api/ontology/simulate-mail, 보낸 사람 *.test)만 보낸다. 실제 메일 ·
// 캘린더에는 아무것도 쓰지 않는다(되돌릴 수 없는 고객 회신은 「보냈을 내용」만 건에 남는다).
//
//   준비(처음 한 번): cd server && PRO_TENANT_ID=jy-mail node ../.scratch/runmode-lecture.mjs --setup   (다듬기 · 일 정의 · 데모 강사 · 자동)
//   cd server && PRO_TENANT_ID=jy-mail node test/ontology-mapengine.e2e.mjs [--phase a,b,c,d,e,bpm] [--keep]
//     a  중간에서 시작(강의자료 준비부터) — 끝까지 인스턴스 하나 · 새 proc_def 0
//     b  되감기 한 번 — 여전히 인스턴스 하나
//     c  건이 기다리는 동안 지도를 바꾼다(다듬기: 고객 회신 뒤에 「결과 보고」를 더함) — 따라가는 건은 새 지도로, 시작한 날의 지도에 고정한 건은 그대로
//     d  메일 하나가 두 프로세스를: 자동인 강의 프로세스는 시작, 제안인 프로세스는 묻는다
//     e  채팅에 올린 파일: 묻기만 하고 건을 열지 않는다
//     h  「제안」 단계의 건(단계마다 사람이 정함 HITL) · 해도 되고 안 해도 되는 단계: 지도에서 바로 도는 건도 관문이 묻고, 사람이 건너뛰면 지도가 다음 단계를 정한다
//     r  역할마다 맡는 사람: 시작 전에 바꿈 → 뒤에 생긴 단계도 그 사람에게, 진행 중에 바꿈 → 끝나지 않은 단계만, 여러 명인 역할 → 고를 때까지 기다림
//     bpm 같은 메일을 프로세스 정의로(기존) 한 번 — engine-compare 로 나란히
//   지도에서 바로 도는 건은 bpm_proc_inst 한 행(제목 · 시작한 사람 · 맡은 사람 · 지금 단계 · 상태)을 지니고, 되감아도 행이 늘지 않는다.
//   지도 건의 단계들(a · b · c · d · e · h · r)은 proc_def · form_def 행을 하나도 만들지 않는다(흐름도의 BPMN 은 그때그때 만든다).
//   끝나면 이 시험이 만든 건 · 할 일 · 단계 · 카드 · 스레드 · 원장 · 고친 기록 · 파일을 지우고 엔진 설정을 처음대로(--keep: 남겨 둔다).
//   준비를 되돌리는 것은 runmode-lecture.mjs --reset (이 시험은 하지 않는다).
process.env.DOTENV_CONFIG_QUIET = 'true'
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SERVER = path.join(HERE, '..')
const { q, pool, admin } = await import('../lib/supa.js')
const { withTenant } = await import('../lib/tenant.js')
const { cypher, closeOntology } = await import('../lib/ontology/store.js')

const API = process.env.API_URL || 'http://localhost:8790/api'
const T = 'jy-mail'
const PROC = 'process:5c5451687f'
const BOSS = 'jyjang@uengine.org'
const MATE = 'runmode-demo-instructor@example.com'
const WS = process.env.PRO_FORMS_OUT || '/Users/uengine/process-gpt/services/deepagents/workspace/jy-mail/forms-out'
const argv = process.argv.slice(2)
const phases = new Set((argv[argv.indexOf('--phase') + 1] && argv.includes('--phase') ? argv[argv.indexOf('--phase') + 1] : 'a,b,c,d,e,h,r,bpm').split(','))
const keep = argv.includes('--keep')
// --clean <iso>: only clean up what a kept run (--keep) made since then
const cleanOnly = argv.includes('--clean') ? new Date(argv[argv.indexOf('--clean') + 1]) : null
const START = cleanOnly || new Date()
const OUT = { startedAt: START.toISOString(), checks: [], cases: {} }
const OUTFILE = process.env.E2E_OUT || path.join(SERVER, '..', '.scratch', 'mapengine-e2e.out.json')

// the simulated mails (reserved test domains only)
const FROM = '김지원 교수 <kim@example-univ.test>'
const MAIL_MID = { from: FROM, subject: '[특강] 강의자료 준비 부탁드립니다',
  text: '안녕하세요, 예시대학교 김지원입니다. 보내 주신 특강 강의계획서는 잘 받았고 학과에 공유했습니다. 이제 3시간 특강에 쓸 강의자료(슬라이드)를 준비해서 보내 주시면 됩니다. 학생은 40명입니다.' }
const MAIL_TWO = { from: FROM, subject: '[특강 요청] AI 특강과 실습 자료 준비 부탁드립니다',
  text: '안녕하세요, 예시대학교 김지원입니다. 다음 달 학생 40명 대상 AI 특강(3시간)을 부탁드립니다. 강의계획서를 먼저 보내 주시고, 실습에 쓸 자료(데이터셋 · 실습 안내서)도 따로 준비해 주세요.' }
const MAIL_C = { from: FROM, subject: '[특강] 회신 부탁드립니다(지도 바꾸기 시험)', text: '보내 주신 강의계획서와 강의자료를 잘 받았습니다. 확인 회신 부탁드립니다.' }
const FILE_TEXT = '특강 요청서 — 예시대학교 경영학과\n주제: 생성형 AI로 일하는 법\n대상: 3학년 40명 · 시간: 3시간\n요청: 강의계획서와 강의자료를 준비해 보내 주세요.\n'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)
function check(label, ok, detail = '') {
  OUT.checks.push({ label, ok: !!ok, detail })
  log(ok ? '  ✓' : '  ✗', label, detail ? `— ${detail}` : '')
  if (!ok) throw new Error(`실패: ${label} ${detail}`)
}
const note = (label, detail) => { OUT.checks.push({ label, ok: null, detail }); log('  ·', label, detail ? `— ${detail}` : '') }
const save = () => fs.writeFileSync(OUTFILE, JSON.stringify(OUT, null, 1))

async function call(tok, method, p, body, raw) {
  const r = await fetch(`${API}${p}`, { method, headers: raw ? { Authorization: `Bearer ${tok}`, ...raw.headers } : { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` }, body: raw ? raw.body : body ? JSON.stringify(body) : undefined })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw Object.assign(new Error(`${method} ${p} → ${r.status} ${j.error || ''}`), { status: r.status, body: j })
  return j
}
async function signIn(email) {
  const r = await fetch(`${API}/auth/email/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, code: '000000' }) })
  const j = await r.json()
  assert.ok(j.session?.access_token, `sign-in ${email}: ${JSON.stringify(j).slice(0, 160)}`)
  return { id: j.user.id, tok: j.session.access_token, email }
}
async function waitFor(what, fn, { timeout = 300_000, every = 2500 } = {}) {
  const until = Date.now() + timeout
  for (;;) {
    const v = await fn().catch((e) => { log('  (wait)', e.message); return null })
    if (v) return v
    if (Date.now() > until) throw new Error(`시간 초과: ${what}`)
    await sleep(every)
  }
}
const caseRow = async (id) => (await q(`select id::text as id, engine, instances, snapshots, history, status, map_pin, entry_task, created_at, trigger from pro_po_cases where id=$1`, [id]))[0]
const stepOf = async (caseId, task, states) => (await q(`select s.*, t.status::text as todo_status from pro_case_steps s join todolist t on t.id=s.todo_id where s.case_id=$1 and s.task=$2 ${states ? 'and s.state = any($3)' : ''} order by s.created_at desc limit 1`, states ? [caseId, task, states] : [caseId, task]))[0]
const todoOf = async (caseId, task) => { const c = await caseRow(caseId); return (await q(`select id::text as id, status::text as status, user_id, draft, output from todolist where proc_inst_id = any($1) and activity_name=$2 order by start_date desc nulls last limit 1`, [c.instances, task]))[0] }
const todosOf = async (who) => (await call(who.tok, 'GET', '/todos')).map((t) => ({ id: t.id, name: t.activity_name }))
const procDefs = async () => Number((await q(`select count(*) n from proc_def where tenant_id=$1`, [T]))[0].n)
const formDefs = async () => Number((await q(`select count(*) n from form_def where tenant_id=$1`, [T]))[0].n)
// the case's one bpm_proc_inst row (mapengine.js syncInst)
const instRow = async (inst) => (await q(`select proc_inst_id, proc_inst_name, proc_def_id, status::text as status, participants, role_bindings, current_activity_ids, variables_data, start_date, end_date, tenant_id from bpm_proc_inst where proc_inst_id=$1`, [inst]))[0]
const crypto = await import('node:crypto')
const actId = (task) => `t_${crypto.createHash('sha1').update(String(task)).digest('hex').slice(0, 10)}`
// a timestamp-without-time-zone column read as this machine's (Korea's) clock: within minutes of now, not 9 hours off
const nearNow = (d, min = 15) => !!d && Math.abs(Date.now() - new Date(d).getTime()) < min * 60_000
async function facts(caseId) {
  const c = await caseRow(caseId)
  const todos = await q(`select activity_name, status::text as status from todolist where proc_inst_id = any($1) order by start_date`, [c.instances])
  const bpm = Number((await q(`select count(*) n from bpm_proc_inst where proc_inst_id = any($1)`, [c.instances]))[0].n)
  const defs = c.snapshots.length ? Number((await q(`select count(*) n from proc_def where tenant_id=$1 and id = any($2)`, [T, c.snapshots]))[0].n) : 0
  const steps = await q(`select task, state, kind, via, map_at from pro_case_steps where case_id=$1 order by created_at`, [caseId])
  return { engine: c.engine, status: c.status, instances: c.instances.length, bpmProcInst: bpm, procDefs: defs, todolist: todos.length, todos: todos.map((t) => `${t.activity_name}:${t.status}`),
    steps: steps.map((s) => `${s.task}:${s.state}${s.via?.how ? `(${s.via.how})` : ''}`), moves: (c.history || []).filter((h) => ['moved', 'rewound'].includes(h.state)).map((h) => `${h.state}:${h.task}`) }
}
const made = { cases: new Set(), corrections: [], messages: new Set(), uploads: [] }
const track = (id) => { if (id) made.cases.add(String(id)) }

// a mail through the same way a real one comes (run.js routeMail → events.js): what started, what was offered
async function mailIn(boss, mail) {
  const r = await call(boss.tok, 'POST', '/ontology/simulate-mail', mail)
  for (const s of r.started || []) track(s.caseId)
  if (r.messageId) made.messages.add(r.messageId)
  log(`  메일 「${mail.subject}」 → 시작 ${(r.started || []).map((s) => `${s.proc}:${s.task}(${s.engine})`).join(', ') || '없음'} · 물음 ${(r.offered || []).map((o) => `${o.name}:${o.task}`).join(', ') || '없음'}`)
  log(`    읽음 ${(r.reads || []).map((x) => `${x.name} ${x.p == null ? '?' : Math.round(x.p * 100)}%`).join(' · ')}`)
  return r
}
// the lecture case from a mail: started by itself, or (its start task unsure) picked from the card the way a person would
async function lectureCase(boss, mail, r) {
  const s = (r.started || []).find((x) => x.proc === PROC)
  if (s) return s.caseId
  const [m] = await q(`select m.id, m.content from pro_messages m join pro_threads t on t.id=m.thread_id where t.user_id=$1 and m.kind='onto-entry' and m.content->>'state'='ask' and m.created_at >= $2 order by m.created_at desc limit 1`, [boss.id, START])
  const ch = [m?.content?.choice, ...(m?.content?.choices || [])].find((x) => x?.proc === PROC)
  assert.ok(ch, `강의 프로세스가 이 메일을 받지 않았어요: ${JSON.stringify(r.reads)}`)
  const r2 = await call(boss.tok, 'POST', '/ontology/cases', { proc: PROC, entry: ch.options[0].task, subject: mail.subject, body: mail.text, from: mail.from, odds: ch, kind: 'mail', messageId: m.id })
  note('시작 일이 애매해 카드에서 골랐어요', ch.options[0].task)
  track(r2.caseId)
  return r2.caseId
}
const sent = async (boss, caseId, task) => {
  const w = await waitFor(`${task}가 보내기를 기다림`, async () => { const s = await stepOf(caseId, task, ['waiting']); return s?.preview ? s : null }, { timeout: 360_000 })
  const d = await call(boss.tok, 'POST', `/ontology/steps/${w.id}`, { action: 'go' })
  assert.ok(d.sent?.stub, '보낸 기록이 없어요')
  return w
}

// ---------- phases ----------
async function phaseA(boss, mate) {
  log('— (a) 중간에서 시작: 강의자료 준비부터, 지도에서 바로')
  const defs0 = await procDefs()
  const r = await mailIn(boss, MAIL_MID)
  const id = await lectureCase(boss, MAIL_MID, r)
  OUT.cases.mapA = id
  const c = await caseRow(id)
  check('건의 엔진은 지도에서 바로(map)', c.engine === 'map', c.engine)
  check('인스턴스 하나 · proc_def 없음(스냅샷 0)', c.instances.length === 1 && c.snapshots.length === 0 && c.instances[0].startsWith('onto-map.'), c.instances[0])
  note('시작한 일', `${c.entry_task} · 건너뜀 ${(c.history || []).filter((h) => h.state === 'skipped').map((h) => h.task).join(', ') || '없음'}`)
  check('중간에서 시작(첫 단계가 아님)', c.entry_task !== '강의계획서 작성', c.entry_task)
  const first = await stepOf(id, c.entry_task)
  check('첫 단계 행: 지도에서 정함(entry) · map_at', first?.via?.how === 'entry' && !!first.map_at, JSON.stringify(first?.via))
  check('요청 접수 행이 없다', !(await q(`select 1 from todolist where proc_inst_id=$1 and activity_id='intake'`, [c.instances[0]])).length)
  // the case's one row in the shared instance table: its title, its starter, its open step, no definition
  const i0 = await instRow(c.instances[0])
  check('bpm_proc_inst 한 행: 제목 · 정의 없음 · 진행 중 · 시작한 사람 · 지금 단계', !!i0 && i0.proc_inst_name.includes(MAIL_MID.subject) && i0.proc_def_id === null && i0.status === 'RUNNING' &&
    i0.participants.includes(boss.id) && i0.current_activity_ids.includes(actId(c.entry_task)) && i0.tenant_id === T, JSON.stringify({ name: i0?.proc_inst_name, status: i0?.status, cur: i0?.current_activity_ids }))
  check('인스턴스 행의 시작 시각은 한국 시각(9시간 어긋나지 않음)', nearNow(i0.start_date), String(i0.start_date))
  check('인스턴스 행의 변수: 요청(제목 · 보낸 사람 · 고객)을 엔진의 모양으로', (i0.variables_data || []).some((v) => v.key === 'subject' && v.value === MAIL_MID.subject) && (i0.variables_data || []).some((v) => v.key === 'sender'),
    JSON.stringify(i0.variables_data))
  check('맡는 사람: 강사 → 데모 강사(설정) · 에이전트 단계는 업무 에이전트', (i0.role_bindings || []).some((b) => b.name === '강사' && (b.endpoint || []).includes(mate.id)) && (i0.role_bindings || []).some((b) => b.name === '업무 에이전트'),
    JSON.stringify((i0.role_bindings || []).map((b) => `${b.name}:${[].concat(b.endpoint).join(',')}`)))
  const list = await call(boss.tok, 'GET', '/instances')
  const li = list.find((x) => x.proc_inst_id === c.instances[0])
  check('Lite 인스턴스 목록에 지도 건: 제목 · 지도에서 바로 · 시작한 사람 · 건 id', li && li.engine === 'map' && li.case_id === id && !!li.starter_name && li.proc_inst_name === i0.proc_inst_name, JSON.stringify(li && { name: li.proc_inst_name, engine: li.engine, starter: li.starter_name }))
  const opened = await call(boss.tok, 'GET', `/instances/${encodeURIComponent(c.instances[0])}`)
  check('인스턴스를 열면 건 화면으로(mapCase)', opened.mapCase?.id === id && opened.mapCase?.proc === PROC, JSON.stringify(opened.mapCase))
  await waitFor('강의자료 준비 끝', async () => (await todoOf(id, '강의자료 준비'))?.status === 'DONE', { timeout: 360_000 })
  const [d1] = await q(`select start_date, end_date from todolist where proc_inst_id=$1 and activity_name='강의자료 준비'`, [c.instances[0]])
  check('할 일의 시작 · 끝 시각도 한국 시각(앞선 진행의 「끝남」이 9시간 이르지 않음)', nearNow(d1.start_date) && nearNow(d1.end_date), `${d1.start_date} ~ ${d1.end_date}`)
  const w = await sent(boss, id, '고객 회신')
  check('고객 회신: 지도가 정함(한 갈래, 강의자료 준비에서)', w.via?.how === 'single' && w.via?.from === '강의자료 준비', JSON.stringify(w.via))
  await waitFor('교육 진행이 강사에게', async () => (await todosOf(mate)).some((t) => t.name === '교육 진행'), { timeout: 240_000 })
  const f = await facts(id)
  check('교육 진행 때까지 인스턴스 하나 · bpm_proc_inst 1 · 새 proc_def 0', f.instances === 1 && f.bpmProcInst === 1 && (await procDefs()) === defs0, JSON.stringify({ instances: f.instances, bpm: f.bpmProcInst, defs: (await procDefs()) - defs0 }))
  const i1 = await instRow(c.instances[0])
  check('인스턴스 행: 지금 단계 교육 진행 · 강사도 참여자', i1.current_activity_ids.join() === actId('교육 진행') && i1.participants.includes(mate.id), JSON.stringify({ cur: i1.current_activity_ids, people: i1.participants.length }))
  OUT.a = f; save()
  return { id, defs0 }
}

async function phaseB(boss, mate, { id, defs0 }) {
  log('— (b) 되감기 한 번: 강의자료 준비로')
  const old = await todoOf(id, '교육 진행')
  const ask = await call(boss.tok, 'POST', `/ontology/cases/${id}/rewind`, { task: '강의자료 준비' })
  check('되감기 전 확인(이미 보낸 고객 회신)', ask.confirm && ask.lost.includes('고객 회신'), JSON.stringify(ask).slice(0, 120))
  const rw = await call(boss.tok, 'POST', `/ontology/cases/${id}/rewind`, { task: '강의자료 준비', confirm: true })
  const c = await caseRow(id)
  check('되감은 뒤에도 같은 인스턴스(하나)', c.instances.length === 1 && rw.instId === c.instances[0], rw.instId)
  check('강사의 교육 진행은 닫힘(CANCELLED)', (await q(`select status::text s from todolist where id=$1`, [old.id]))[0].s === 'CANCELLED')
  check('강사 목록에서 빠짐', !(await todosOf(mate)).some((t) => t.id === old.id))
  const again = await stepOf(id, '강의자료 준비', ['planned', 'auto', 'go', 'waiting'])
  check('되감은 단계 행: via rewound', again?.via?.how === 'rewound', JSON.stringify(again?.via))
  const ir = await instRow(c.instances[0])
  check('되감아도 bpm_proc_inst 한 행 그대로 · 지금 단계는 강의자료 준비', Number((await q(`select count(*) n from bpm_proc_inst where proc_inst_id = any($1)`, [c.instances]))[0].n) === 1 && ir.status === 'RUNNING' && ir.current_activity_ids.join() === actId('강의자료 준비'),
    JSON.stringify({ status: ir.status, cur: ir.current_activity_ids }))
  const g = await waitFor('되감은 단계를 관문이 봄', async () => (await q(`select * from pro_case_steps where case_id=$1 and task='강의자료 준비' and via->>'how'='rewound' and proposal is not null order by created_at desc limit 1`, [id]))[0], { timeout: 120_000 })
  check('되감은 단계의 근거: 요청 접수 · 시작 확률 없이 「되감았어요」', g.proposal.why.includes('되감았어요') && !g.proposal.from && g.proposal.p == null && !/요청 접수|%/.test(g.proposal.why), JSON.stringify(g.proposal))
  await waitFor('다시 한 강의자료 준비 끝', async () => (await q(`select count(*)::int n from todolist where proc_inst_id=$1 and activity_name='강의자료 준비' and status::text='DONE'`, [c.instances[0]]))[0].n === 2, { timeout: 360_000 })
  await sent(boss, id, '고객 회신')
  const t6 = await waitFor('교육 진행이 다시 강사에게', async () => { const t = await todoOf(id, '교육 진행'); return t?.status === 'IN_PROGRESS' && t.id !== old.id && (await todosOf(mate)).some((x) => x.id === t.id) ? t : null }, { timeout: 240_000 })
  await call(mate.tok, 'POST', `/todos/${t6.id}/submit`, { values: { result: '특강을 마쳤어요. 학생 40명 · 실습 2개 진행.' } })
  await waitFor('건 끝', async () => (await caseRow(id)).status === 'done', { timeout: 60_000 })
  const f = await facts(id)
  check('끝까지 인스턴스 하나 · bpm_proc_inst 1 · 새 proc_def 0', f.instances === 1 && f.bpmProcInst === 1 && (await procDefs()) === defs0, JSON.stringify({ instances: f.instances, bpm: f.bpmProcInst, defs: (await procDefs()) - defs0 }))
  const ie = await instRow(c.instances[0])
  check('끝: 인스턴스 행 COMPLETED · 끝난 시각(한국 시각) · 열린 단계 없음', ie.status === 'COMPLETED' && nearNow(ie.end_date) && !ie.current_activity_ids.length, JSON.stringify({ status: ie.status, end: ie.end_date, cur: ie.current_activity_ids }))
  check('할 일 6행(강의자료 · 회신 · 교육(닫힘) · 강의자료 · 회신 · 교육)', f.todolist === 6, f.todos.join(' → '))
  check('되감기 1번이 기록에', f.moves.length === 1 && f.moves[0] === 'rewound:강의자료 준비', f.moves.join(','))
  const flow = await call(boss.tok, 'GET', `/ontology/cases/${id}/flow`)
  const st = Object.fromEntries(flow.nodes.map((n) => [n.key, n.state]))
  check('흐름도: 지금 지도로, 네 단계 끝남', !flow.pinned && ['강의자료 준비', '고객 회신', '교육 진행'].every((k) => st[k] === 'done'), JSON.stringify(st))
  const x = flow.bpmn?.xml || ''
  check('흐름도는 BPMN: 그때 만든 XML · 요청 접수 없음 · 단계마다 상태', x.includes('<bpmn:definitions') && !x.includes('요청 접수') && ['강의자료 준비', '고객 회신', '교육 진행'].every((k) => flow.bpmn.states[flow.bpmn.ids[k]] === 'done'),
    JSON.stringify({ len: x.length, states: Object.keys(flow.bpmn?.states || {}).length }))
  const run = await call(boss.tok, 'GET', `/ontology/cases/${id}/run`)
  check('지켜보기: 엔진 map · 인스턴스 1', run.engine === 'map' && run.instances === 1, `${run.engine} ${run.instances}`)
  OUT.b = { ...f, flow: flow.nodes.map((n) => `${n.key}:${n.state}${n.runs > 1 ? `×${n.runs}` : ''}`) }; save()
}

async function phaseC(boss) {
  log('— (c) 기다리는 동안 지도가 바뀌면: 따라가는 건 · 고정한 건')
  const start = async (label) => {
    const r = await call(boss.tok, 'POST', '/ontology/cases', { proc: PROC, entry: '고객 회신', subject: `${MAIL_C.subject} · ${label}`, body: MAIL_C.text, from: MAIL_C.from, customer: '김지원 교수', kind: 'manual' })
    track(r.caseId)
    return r.caseId
  }
  const follow = await start('따라감'), pinned = await start('고정')
  OUT.cases.mapFollow = follow; OUT.cases.mapPinned = pinned
  const p = await call(boss.tok, 'PUT', `/ontology/cases/${pinned}/map-pin`, { pin: true })
  check('고정: 건을 시작한 날의 지도로', !!p.mapPin, p.mapPin)
  check('따라가는 건은 고정 없음(꼭 하는 단계가 없는 프로세스)', !(await caseRow(follow)).map_pin)
  const wf = await waitFor('두 건 모두 고객 회신이 보내기를 기다림', async () => {
    const a = await stepOf(follow, '고객 회신', ['waiting']), b = await stepOf(pinned, '고객 회신', ['waiting'])
    return a?.preview && b?.preview ? [a, b] : null
  }, { timeout: 420_000 })
  const changeAt = new Date()
  const v = await call(boss.tok, 'POST', `/ontology/refine/${encodeURIComponent(PROC)}/corrections`, { op: 'add_task', args: { name: '결과 보고', role: '전무', after: '고객 회신', before: '교육 진행' }, why: '지도 바꾸기 시험(e2e): 회신 뒤에 결과 보고' })
  const cor = v.corrections.find((x) => x.op === 'add_task' && x.args?.name === '결과 보고')
  made.corrections.push(cor.id)
  note('지도를 바꿈(다듬기)', `「고객 회신」 뒤에 「결과 보고」 더함 · ${changeAt.toISOString()}`)
  for (const s of wf) await call(boss.tok, 'POST', `/ontology/steps/${s.id}`, { action: 'go' })
  // the next work items are made as the step ends — pause both right away (their drafts would only cost a model run)
  for (const id of [follow, pinned]) await call(boss.tok, 'POST', `/ontology/cases/${id}/pause`).catch(() => {})
  const nf = await waitFor('따라가는 건의 다음 단계', async () => (await q(`select task, via, map_at from pro_case_steps where case_id=$1 and task <> '고객 회신' order by created_at desc limit 1`, [follow]))[0], { timeout: 30_000 })
  const np = await waitFor('고정한 건의 다음 단계', async () => (await q(`select task, via, map_at from pro_case_steps where case_id=$1 and task <> '고객 회신' order by created_at desc limit 1`, [pinned]))[0], { timeout: 30_000 })
  check('따라가는 건: 바뀐 지도대로 「결과 보고」', nf.task === '결과 보고' && new Date(nf.map_at) >= changeAt, `${nf.task} · map_at ${new Date(nf.map_at).toISOString()}`)
  check('고정한 건: 시작한 날의 지도대로 「교육 진행」', np.task === '교육 진행' && new Date(np.map_at) < changeAt, `${np.task} · map_at ${new Date(np.map_at).toISOString()}`)
  const ff = await call(boss.tok, 'GET', `/ontology/cases/${follow}/flow`), fp = await call(boss.tok, 'GET', `/ontology/cases/${pinned}/flow`)
  check('흐름도: 지금 지도에는 결과 보고, 시작한 날의 지도에는 없음', ff.nodes.some((n) => n.key === '결과 보고') && !fp.nodes.some((n) => n.key === '결과 보고') && fp.pinned && !ff.pinned,
    `${ff.nodes.map((n) => n.key).join('→')} | ${fp.nodes.map((n) => n.key).join('→')}`)
  // the map back as it was
  await call(boss.tok, 'DELETE', `/ontology/refine/${encodeURIComponent(PROC)}/corrections/${cor.id}`)
  made.corrections = made.corrections.filter((x) => x !== cor.id)
  OUT.c = { follow: await facts(follow), pinned: await facts(pinned), next: { follow: nf.task, pinned: np.task } }; save()
}

async function phaseD(boss) {
  log('— (d) 메일 하나 → 프로세스 둘')
  const r = await mailIn(boss, MAIL_TWO)
  const lec = (r.started || []).find((s) => s.proc === PROC)
  check('자동인 강의 프로세스는 저절로 시작', !!lec, JSON.stringify(r.started))
  check('다른 프로세스도 같은 메일의 일로 — 제안이라 묻는다', (r.offered || []).length >= 1 && (r.offered || []).every((o) => o.status !== 'adopted'), (r.offered || []).map((o) => o.name).join(', '))
  const [m] = await q(`select content from pro_messages where id=$1`, [r.messageId])
  check('묻는 카드 하나에 프로세스들', m?.content?.state === 'ask' && ((m.content.choices || []).length === r.offered.length || (r.offered.length === 1 && m.content.choice?.proc === r.offered[0].proc)), `${(m?.content?.choices || [m?.content?.choice]).map((x) => x?.procName).join(', ')}`)
  check('묻는 카드가 같은 메일로 이미 시작한 것도 안다(카드 첫 줄은 둘을 함께 센다)', (m.content.startedAlso || []).length === (r.started || []).length && (m.content.startedAlso || []).every((x) => x.caseId),
    JSON.stringify({ startedAlso: (m.content.startedAlso || []).map((x) => x.procName), offered: (m.content.choices || [m.content.choice]).length }))
  for (const s of r.started || []) await call(boss.tok, 'POST', `/ontology/cases/${s.caseId}/pause`).catch(() => {})
  OUT.d = { started: r.started, offered: r.offered, reads: r.reads }; save()
}

async function phaseE(boss) {
  log('— (e) 채팅에 올린 파일')
  const cases0 = Number((await q(`select count(*) n from pro_po_cases where tenant_id=$1`, [T]))[0].n)
  const att = await call(boss.tok, 'POST', '/attachments', null, { headers: { 'Content-Type': 'text/plain', 'X-File-Name': encodeURIComponent('특강 요청서.txt') }, body: Buffer.from(FILE_TEXT) })
  made.uploads.push(att)
  const r = await call(boss.tok, 'POST', '/ontology/events/file', { files: [att], text: '이 요청서대로 진행해 주세요' })
  if (r.messageId) made.messages.add(r.messageId)
  log(`    읽음 ${(r.reads || []).map((x) => `${x.name} ${x.p == null ? '?' : Math.round(x.p * 100)}%`).join(' · ')}`)
  check('파일은 묻기만 한다(자동인 프로세스여도 건을 열지 않음)', !r.none && r.asked && !(r.started || []).length, JSON.stringify({ offered: r.offered?.map((o) => o.name), started: r.started?.length }))
  check('건 수 그대로', Number((await q(`select count(*) n from pro_po_cases where tenant_id=$1`, [T]))[0].n) === cases0)
  const [m] = await q(`select content from pro_messages where id=$1`, [r.messageId])
  check('카드: 파일 사건 · 파일 이름', m?.content?.source === 'file' && m.content.file?.name === '특강 요청서.txt', JSON.stringify({ source: m?.content?.source, file: m?.content?.file?.name }))
  OUT.e = { offered: r.offered, reads: r.reads }; save()
}

async function phaseH(boss, mate) {
  log('— (h) 단계마다 사람이 정함 · 해도 되고 안 해도 되는 단계(지도에서 바로)')
  // the process's stage decides the mode (제안 → 단계마다 사람이 정함); a case keeps the mode of its start
  const [st0] = await withTenant(T, () => cypher(`MATCH (b:Process {key:$key}) RETURN b.status AS status`, { key: PROC }))
  await call(boss.tok, 'POST', '/ontology/processes/status', { key: PROC, status: 'suggested', name: '강의계획서 작성 · 보고' })
  // 꼭 · 선택은 그 단계로 들어오는 간선마다(edgecond.js): 강의계획서 작성으로 들어오는 간선을 모두 「해도 되고 안 해도 되는 단계」로, 끝나면 처음대로
  const P = `/ontology/processes/${encodeURIComponent(PROC)}`
  const into = (await call(boss.tok, 'GET', `${P}/edge-conditions`)).edges.filter((e) => e.task === '강의계획서 작성')
  const was = []
  for (const e of into) {
    const v = await call(boss.tok, 'GET', `${P}/edge-condition?event=${encodeURIComponent(e.event)}&task=${encodeURIComponent(e.task)}`)
    was.push(v)
    await call(boss.tok, 'PUT', `${P}/edge-condition`, { event: e.event, task: e.task, requirement: 'optional', rules: [], class: v.class?.decided ? v.class.class : null, reason: 'e2e: 건너뛰기 시험' })
  }
  try {
    const r = await call(boss.tok, 'POST', '/ontology/cases', { proc: PROC, entry: '강의계획서 작성', subject: '[특강] 단계마다 확인 시험', body: '강의계획서는 이미 있어요. 강의자료만 준비해 주세요.', from: FROM, customer: '김지원 교수', kind: 'manual' })
    track(r.caseId)
    OUT.cases.mapHitl = r.caseId
    check('「제안」 단계에서 시작한 건은 단계마다 사람이 정함(hitl)을 지닌다', (await q(`select run_mode from pro_po_cases where id=$1`, [r.caseId]))[0].run_mode === 'hitl')
    const w = await waitFor('강의계획서 작성이 단계마다 확인을 기다림', async () => { const s = await stepOf(r.caseId, '강의계획서 작성', ['waiting']); return s?.message_id ? s : null }, { timeout: 60_000 })
    check('HITL: 첫 단계도 주인에게 묻는다(에이전트가 잡지 않음)', w.why.includes('hitl') && w.todo_status === 'IN_PROGRESS', w.why.join(','))
    check('해도 되고 안 해도 되는 단계로 읽음', w.requirement === 'optional', w.requirement)
    const d = await call(boss.tok, 'POST', `/ontology/steps/${w.id}`, { action: 'skip', reason: '강의계획서는 이미 있어요(e2e)' })
    check('건너뛰기', d.skipped === true)
    const sk = await stepOf(r.caseId, '강의계획서 작성')
    const t = (await q(`select status::text as status, output from todolist where id=$1`, [sk.todo_id]))[0]
    check('건너뛴 단계: 행은 끝(DONE) · 결과는 건너뜀 · 단계 행 skipped', t.status === 'DONE' && Object.values(t.output || {})[0]?.skipped === true && sk.state === 'skipped', `${t.status} · ${sk.state}`)
    const n = await waitFor('다음 단계(강의자료 준비)가 다시 묻는다', async () => { const s = await stepOf(r.caseId, '강의자료 준비', ['waiting']); return s?.message_id ? s : null }, { timeout: 60_000 })
    check('건너뛴 뒤 지도가 다음 단계를 정함(한 갈래) · HITL 이라 또 묻는다', n.via?.how === 'single' && n.via?.from === '강의계획서 작성' && n.why.includes('hitl'), JSON.stringify({ via: n.via?.how, why: n.why }))
    // a person's step is kept off their list until the owner says 진행 (HITL): start one at 교육 진행 (the 강사's step, drafted by the agent)
    const r2 = await call(boss.tok, 'POST', '/ontology/cases', { proc: PROC, entry: '교육 진행', subject: '[특강] 강사 단계 확인 시험', body: '특강 진행 부탁드립니다.', from: FROM, customer: '김지원 교수', kind: 'manual' })
    track(r2.caseId)
    const w2 = await waitFor('교육 진행이 확인을 기다림', async () => { const s = await stepOf(r2.caseId, '교육 진행', ['waiting']); return s?.message_id ? s : null }, { timeout: 60_000 })
    check('HITL: 강사 단계는 정하기 전까지 강사 목록에 없음', w2.hold_item && !(await todosOf(mate)).some((x) => x.id === String(w2.todo_id)), `hold ${w2.hold_item}`)
    await call(boss.tok, 'POST', `/ontology/cases/${r2.caseId}/pause`)
    await call(boss.tok, 'POST', `/ontology/cases/${r.caseId}/pause`)
    OUT.h = { skip: await facts(r.caseId), person: await facts(r2.caseId) }; save()
  } finally {
    for (const v of was) await call(boss.tok, 'PUT', `${P}/edge-condition`, { event: v.event, task: v.task, requirement: v.requirement || null, rules: (v.rules || []).map((r) => ({ when: r.when, then: r.then })),
      class: v.class?.decided ? v.class.class : null, reason: 'e2e: 원래대로' }).catch((e) => log('  edge back', e.message))
    await call(boss.tok, 'POST', '/ontology/processes/status', { key: PROC, status: st0?.status || 'adopted', name: '강의계획서 작성 · 보고' }).catch((e) => log('  stage back', e.message))
  }
}

async function phaseR(boss, mate) {
  log('— (r) 역할마다 맡는 사람: 시작 전에 바꾸기 · 진행 중에 바꾸기 · 여러 명인 역할')
  const sb = await call(boss.tok, 'GET', `/ontology/start-bindings?proc=${encodeURIComponent(PROC)}&entry=${encodeURIComponent('고객 회신')}`)
  const k = sb.bindings.find((b) => b.role === '강사')
  check('시작 전 풀이: 강사 → 데모 강사(설정의 팀 · 역할 담당자)', k?.userId === mate.id && k.from === 'settings', JSON.stringify(sb.bindings.map((b) => `${b.role}:${b.name}:${b.from}`)))
  // 1) changed before 진행: the case keeps the pick, and the step made later (교육 진행) goes to that person — not a fresh lookup
  const r = await call(boss.tok, 'POST', '/ontology/cases', { proc: PROC, entry: '고객 회신', subject: '[특강] 맡는 사람 시험(e2e)', body: MAIL_C.text, from: MAIL_C.from, customer: '김지원 교수', kind: 'manual',
    picks: [{ role: '강사', userId: boss.id }] })
  track(r.caseId)
  OUT.cases.mapRoles = r.caseId
  const b1 = r.bindings.find((b) => b.role === '강사')
  check('시작 전에 바꿈: 강사 → 장진영(이 건에서 바꿈)', b1?.userId === boss.id && b1.from === 'picked', JSON.stringify(b1))
  const c = await caseRow(r.caseId)
  const i0 = await instRow(c.instances[0])
  check('bpm_proc_inst.role_bindings 에도 바꾼 사람', (i0.role_bindings || []).some((b) => b.name === '강사' && b.endpoint.includes(boss.id)), JSON.stringify(i0.role_bindings))
  const rs = (await q(`select user_id, role from pro_role_assignments where tenant_id=$1 and role='강사' and proc_def_id='*'`, [T]))[0]
  check('회사 설정은 그대로(강사 → 데모 강사)', rs?.user_id === mate.id)
  await sent(boss, r.caseId, '고객 회신')
  const t6 = await waitFor('교육 진행이 만들어짐', async () => todoOf(r.caseId, '교육 진행'), { timeout: 60_000 })
  await call(boss.tok, 'POST', `/ontology/cases/${r.caseId}/pause`).catch(() => {})
  check('뒤에 생긴 단계도 이 건의 맡는 사람에게(강사 → 장진영)', String(t6.user_id).split(',').includes(boss.id) && !String(t6.user_id).split(',').includes(mate.id), t6.user_id)
  // 2) changed mid-case: the open step goes to the new person, the done ones stay; a ledger line, no handover
  const done0 = (await q(`select id::text as id, user_id from todolist where proc_inst_id=$1 and status::text='DONE'`, [c.instances[0]]))
  const ch = await call(boss.tok, 'PUT', `/ontology/cases/${r.caseId}/bindings`, { role: '강사', userId: mate.id })
  check('진행 중에 바꿈: 끝나지 않은 단계 하나만 넘김 · 회사 설정은 그대로라고', ch.reassigned === 1 && /회사 설정은 그대로/.test(ch.note), JSON.stringify({ reassigned: ch.reassigned, note: ch.note }))
  const t6b = (await q(`select user_id from todolist where id=$1`, [t6.id]))[0]
  check('열린 교육 진행은 이제 데모 강사', String(t6b.user_id).split(',').includes(mate.id) && !String(t6b.user_id).split(',').includes(boss.id), t6b.user_id)
  const done1 = (await q(`select id::text as id, user_id from todolist where proc_inst_id=$1 and status::text='DONE'`, [c.instances[0]]))
  check('끝난 단계의 사람은 그대로', JSON.stringify(done0) === JSON.stringify(done1))
  check('결정 원장에 한 줄 · 인계 기록은 없음', (await q(`select count(*)::int n from pro_policy_decisions where tenant_id=$1 and action_kind='ontology.case.binding' and facts->>'case'=$2`, [T, r.caseId]))[0].n === 1 &&
    (await q(`select count(*)::int n from handover_events where tenant_id=$1 and case_id=$2`, [T, `onto:${r.caseId}`]))[0].n === 0)
  const i1 = await instRow(c.instances[0])
  check('bpm_proc_inst: 강사 → 데모 강사 · 참여자', (i1.role_bindings || []).some((b) => b.name === '강사' && b.endpoint.includes(mate.id)) && i1.participants.includes(mate.id))
  // 3) a role several people hold (and nobody company-wide): the case starts, its first step of that role waits for the owner to choose
  const star = await q(`select * from pro_role_assignments where tenant_id=$1 and role='강사'`, [T])
  try {
    await q(`delete from pro_role_assignments where tenant_id=$1 and role='강사'`, [T])
    for (const [pd, u] of [['e2e-roles-a', boss.id], ['e2e-roles-b', mate.id]]) await q(`insert into pro_role_assignments (tenant_id, proc_def_id, role, user_id, updated_by) values ($1,$2,'강사',$3,$4)`, [T, pd, u, boss.id])
    const sb2 = await call(boss.tok, 'GET', `/ontology/start-bindings?proc=${encodeURIComponent(PROC)}&entry=${encodeURIComponent('교육 진행')}`)
    check('여러 명인 역할: 「여러 명 · 정해야 해요」', sb2.bindings.find((b) => b.role === '강사')?.from === 'several' && sb2.bindings.find((b) => b.role === '강사').unbound, JSON.stringify(sb2.bindings))
    const r3 = await call(boss.tok, 'POST', '/ontology/cases', { proc: PROC, entry: '교육 진행', subject: '[특강] 여러 명인 역할 시험(e2e)', body: '특강 진행 부탁드립니다.', from: FROM, customer: '김지원 교수', kind: 'manual' })
    track(r3.caseId)
    const w = await waitFor('교육 진행이 맡을 사람을 기다림', async () => { const s = await stepOf(r3.caseId, '교육 진행', ['waiting']); return s?.message_id ? s : null }, { timeout: 30_000 })
    check('고를 때까지: 단계는 기다림(unbound) · 할 일은 TODO(누구의 목록에도 없음)', w.why.includes('unbound') && w.todo_status === 'TODO' && !(await todosOf(mate)).some((x) => x.id === String(w.todo_id)), `${w.why} · ${w.todo_status}`)
    const [msg] = await q(`select content from pro_messages where id=$1`, [w.message_id])
    check('주인에게 묻는 카드: 역할과 고를 사람들', msg?.content?.why?.includes('unbound') && msg.content.role === '강사' && msg.content.binding?.from === 'several', JSON.stringify({ role: msg?.content?.role, from: msg?.content?.binding?.from }))
    const go = await call(boss.tok, 'POST', `/ontology/steps/${w.id}`, { action: 'go' }).catch((e) => e)
    check('고르기 전에는 「진행」도 안 돼요', go.status === 409)
    await call(boss.tok, 'POST', `/ontology/cases/${r3.caseId}/pause`).catch(() => {})
    const ch3 = await call(boss.tok, 'PUT', `/ontology/cases/${r3.caseId}/bindings`, { role: '강사', userId: mate.id })
    const t = (await q(`select status::text as status, user_id from todolist where id=$1`, [w.todo_id]))[0]
    const s3 = await stepOf(r3.caseId, '교육 진행')
    check('고르면 그 사람에게 열림(맡을 사람 기다림은 풀림)', ch3.reassigned === 1 && t.status === 'IN_PROGRESS' && String(t.user_id).split(',').includes(mate.id) && !(s3.why || []).includes('unbound'),
      JSON.stringify({ status: t.status, user: t.user_id, state: s3.state, why: s3.why }))
  } finally {
    await q(`delete from pro_role_assignments where tenant_id=$1 and role='강사'`, [T])
    for (const x of star) await q(`insert into pro_role_assignments (tenant_id, proc_def_id, role, user_id, updated_by, updated_at) values ($1,$2,$3,$4,$5,$6)`, [x.tenant_id, x.proc_def_id, x.role, x.user_id, x.updated_by, x.updated_at]).catch(async () =>
      q(`insert into pro_role_assignments (tenant_id, proc_def_id, role, user_id, updated_by) values ($1,$2,$3,$4,$5)`, [x.tenant_id, x.proc_def_id, x.role, x.user_id, x.updated_by]))
  }
  OUT.r = { roles: await facts(r.caseId) }; save()
}

async function phaseBpm(boss, mate) {
  log('— (bpm) 같은 메일을 프로세스 정의로(기존)')
  await call(boss.tok, 'PUT', '/ontology/engine', { engine: 'bpm' })
  const r = await mailIn(boss, MAIL_MID)
  const id = await lectureCase(boss, MAIL_MID, r)
  OUT.cases.bpmA = id
  check('건의 엔진은 프로세스 정의로(bpm)', (await caseRow(id)).engine === 'bpm')
  await waitFor('강의자료 준비 끝(bpm)', async () => (await todoOf(id, '강의자료 준비'))?.status === 'DONE', { timeout: 360_000 })
  await sent(boss, id, '고객 회신')
  // (this case's own 교육 진행 — other phases' cases may have one on the instructor's list too)
  const old = await waitFor('교육 진행이 강사에게(bpm)', async () => { const t = await todoOf(id, '교육 진행'); return t && (await todosOf(mate)).some((x) => x.id === t.id) ? t : null }, { timeout: 240_000 })
  await call(boss.tok, 'POST', `/ontology/cases/${id}/rewind`, { task: '강의자료 준비', confirm: true })
  await waitFor('다시 한 강의자료 준비 끝(bpm)', async () => { const c = await caseRow(id); return (await q(`select count(*)::int n from todolist where proc_inst_id = any($1) and activity_name='강의자료 준비' and status::text='DONE'`, [c.instances]))[0].n === 2 }, { timeout: 360_000 })
  await sent(boss, id, '고객 회신')
  const t6 = await waitFor('교육 진행이 다시 강사에게(bpm)', async () => { const t = await todoOf(id, '교육 진행'); return t?.status === 'IN_PROGRESS' && t.id !== old.id ? t : null }, { timeout: 240_000 })
  await call(mate.tok, 'POST', `/todos/${t6.id}/submit`, { values: { result: '특강을 마쳤어요. 학생 40명 · 실습 2개 진행.' } })
  await waitFor('건 끝(bpm)', async () => (await caseRow(id)).status === 'done', { timeout: 180_000 })
  OUT.bpm = await facts(id); save()
  note('bpm 건', JSON.stringify({ instances: OUT.bpm.instances, bpm: OUT.bpm.bpmProcInst, procDefs: OUT.bpm.procDefs, todolist: OUT.bpm.todolist }))
}

// ---------- cleanup: what this test made goes ----------
async function cleanup() {
  const done = {}
  const cases = await q(`select id::text as id, instances, snapshots from pro_po_cases where tenant_id=$1 and (created_at >= $2 or id::text = any($3))`, [T, START, [...made.cases]])
  const ids = cases.map((c) => c.id), insts = cases.flatMap((c) => c.instances)
  const keepDefs = new Set((await q(`select id from proc_def where tenant_id=$1 and saved_at < $2`, [T, START]).catch(() => [])).map((r) => r.id))
  const pids = [...new Set(cases.flatMap((c) => c.snapshots))].filter((x) => !keepDefs.has(x))
  const todos = insts.length ? (await q(`select id::text as id from todolist where proc_inst_id = any($1)`, [insts])).map((r) => r.id) : []
  const steps = ids.length ? (await q(`select id::text as id from pro_case_steps where case_id::text = any($1)`, [ids])).map((r) => r.id) : []
  const people = (await q(`select id::text as id from users where tenant_id=$1 and email = any($2)`, [T, [BOSS, MATE]])).map((r) => r.id)
  // cards about these cases (entry · step · habit · process · done · to-do), the offers this test made, its upload's own card
  done.cards = (await q(`delete from pro_messages m using pro_threads t where t.id=m.thread_id and t.user_id::text = any($1) and m.created_at >= $2 and (
      m.id::text = any($3) or m.content->>'caseId' = any($4) or m.content->>'instId' = any($5) or m.content->>'todoId' = any($6) or m.content->>'stepId' = any($7)
      or (m.kind='onto-entry' and m.content->'mail'->>'subject' = any($8))) returning m.id`,
  [people, START, [...made.messages], ids, insts, todos, steps, [MAIL_MID.subject, MAIL_TWO.subject, MAIL_C.subject, '특강 요청서.txt']])).length
  const th = insts.length ? (await q(`select id from pro_threads where ref = any($1)`, [insts])).map((r) => r.id) : []
  if (th.length) { await q(`delete from pro_messages where thread_id = any($1)`, [th]); done.threads = (await q(`delete from pro_threads where id = any($1) returning 1`, [th])).length }
  if (ids.length) {
    done.steps = (await q(`delete from pro_case_steps where case_id::text = any($1) returning 1`, [ids])).length
    await q(`delete from pro_case_runs where case_id::text = any($1)`, [ids])
    await q(`delete from pro_onto_answers where case_id::text = any($1)`, [ids]).catch(() => {})
    done.handovers = (await q(`delete from handover_events where tenant_id=$1 and case_id = any($2) returning 1`, [T, ids.map((x) => `onto:${x}`)])).length
  }
  if (insts.length) {
    for (const t of ['events', 'todolist_status_history', 'task_execution_properties', 'proc_inst_source', 'pro_step_retries', 'llm_call_log', 'mcp_call_log', 'trace_payload']) await q(`delete from ${t} where proc_inst_id = any($1)`, [insts]).catch(() => {})
    done.todos = (await q(`delete from todolist where proc_inst_id = any($1) returning 1`, [insts])).length
    done.instances = (await q(`delete from bpm_proc_inst where proc_inst_id = any($1) returning 1`, [insts])).length
  }
  if (ids.length) done.cases = (await q(`delete from pro_po_cases where id::text = any($1) returning 1`, [ids])).length
  if (pids.length) {
    await q(`delete from form_def where tenant_id=$1 and proc_def_id = any($2)`, [T, pids]).catch(() => {})
    done.procDefs = (await q(`delete from proc_def where tenant_id=$1 and id = any($2) returning 1`, [T, pids])).length
    const [cfg] = await q(`select value from configuration where tenant_id=$1 and key='proc_map'`, [T])
    if (cfg) {
      const drop = (v) => (Array.isArray(v) ? v.filter((x) => !(x && typeof x === 'object' && pids.includes(x.id))).map(drop) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, drop(x)])) : v)
      await q(`update configuration set value=$3 where tenant_id=$1 and key=$2`, [T, 'proc_map', JSON.stringify(drop(cfg.value))])
    }
    await withTenant(T, () => cypher(`MATCH (s:Snapshot) WHERE s.proc_def_id IN $pids DETACH DELETE s`, { pids }, { actor: 'mapengine e2e', reason: '시험 건 지우기' })).catch((e) => log('  snapshot nodes', e.message))
  }
  // the decision ledger: this test's case steps, rewinds, pins, the engine switches, the map change (and its undoing)
  done.ledger = (await q(`delete from pro_policy_decisions where tenant_id=$1 and created_at >= $2 and (
      (action_kind like 'ontology.run.%' and facts->>'case' = any($3)) or action_kind in ('ontology.engine', 'ontology.case.pin', 'ontology.steprule', 'ontology.runmode') or (action_kind = 'ontology.case.binding' and facts->>'case' = any($3))
      or (action_kind in ('ontology.promote', 'ontology.demote') and facts->>'process' = '${PROC}') or (action_kind = 'ontology.refine' and created_at >= $2 and facts::text like '%결과 보고%')) returning 1`, [T, START, ids])).length
  for (const id of made.corrections) await q(`delete from pro_corrections where tenant_id=$1 and id::text=$2`, [T, id])
  // files the steps made (drafts as Word files), and the test's upload
  // (only what was made since START; a list taken before the first run, when there is one, keeps anything older for sure)
  const beforeFile = process.env.STORAGE_BEFORE || path.join(SERVER, '..', '.scratch', 'mapengine-storage-before.json')
  const had = new Set(fs.existsSync(beforeFile) ? JSON.parse(fs.readFileSync(beforeFile, 'utf8')) : [])
  const now = (await q(`select name from storage.objects where bucket_id='files' and (name like any($1)) and created_at >= $2`, [people.map((p) => `pgpt-pro/${p}/%`), START])).map((r) => r.name)
  const extra = now.filter((n) => !had.has(n))
  if (extra.length) { const { error } = await admin.storage.from('files').remove(extra); done.storage = error ? `실패 ${error.message}` : extra.length }
  const dirs = new Set((process.env.FORMS_OUT_BEFORE ? fs.readFileSync(process.env.FORMS_OUT_BEFORE, 'utf8') : '').split('\n').map((x) => x.trim()).filter(Boolean))
  if (fs.existsSync(WS)) { const ex = fs.readdirSync(WS).filter((d) => !dirs.has(d) && fs.statSync(path.join(WS, d)).mtime >= START); for (const d of ex) fs.rmSync(path.join(WS, d), { recursive: true, force: true }); done.formsOut = ex.length }
  done.formNames = (await q(`delete from pro_form_names where tenant_id=$1 and at >= $2 returning 1`, [T, START])).length
  // the test's upload on disk (the agent's workspace: /workspace/uploads/<user>/<id>/<name>) — this run's, or (--clean) any of its name since then
  const root = path.dirname(WS)
  const ups = new Set(made.uploads.map((u) => path.dirname(path.join(root, String(u.path).slice('/workspace'.length)))))
  for (const p of people) {
    const d = path.join(root, 'uploads', p)
    if (fs.existsSync(d)) for (const x of fs.readdirSync(d)) if (fs.existsSync(path.join(d, x, '특강 요청서.txt')) && fs.statSync(path.join(d, x)).mtime >= START) ups.add(path.join(d, x))
  }
  for (const d of ups) if (d.includes(`${path.sep}uploads${path.sep}`)) fs.rmSync(d, { recursive: true, force: true })
  done.uploads = ups.size
  return done
}

let engineBefore = null
try {
  if (cleanOnly) throw Object.assign(new Error('clean only'), { cleanOnly: true })
  const boss = await signIn(BOSS), mate = await signIn(MATE)
  const [p] = await withTenant(T, () => cypher(`MATCH (b:Process {key:$key}) RETURN b.status AS status`, { key: PROC }))
  assert.equal(p?.status, 'adopted', '먼저 runmode-lecture.mjs --setup 으로 강의 프로세스를 준비하세요(자동 · 다듬기 · 일 정의 · 데모 강사)')
  if (!fs.existsSync(process.env.STORAGE_BEFORE || path.join(SERVER, '..', '.scratch', 'mapengine-storage-before.json'))) {
    const names = (await q(`select name from storage.objects where bucket_id='files' and name like any($1)`, [[`pgpt-pro/${boss.id}/%`, `pgpt-pro/${mate.id}/%`]])).map((r) => r.name)
    fs.writeFileSync(path.join(SERVER, '..', '.scratch', 'mapengine-storage-before.json'), JSON.stringify(names))
  }
  ;[engineBefore] = await q(`select engine from pro_run_settings where tenant_id=$1`, [T])
  OUT.engineBefore = engineBefore?.engine ?? null
  const e = await call(boss.tok, 'PUT', '/ontology/engine', { engine: 'map' })
  check('엔진을 「지도에서 바로」로(관리자)', e.engine === 'map' && e.from === 'tenant', `${e.engine} · ${e.from}`)
  let a = null
  const defs00 = await procDefs(), forms00 = await formDefs()
  if (phases.has('a') || phases.has('b')) a = await phaseA(boss, mate)
  if (phases.has('b')) await phaseB(boss, mate, a)
  if (phases.has('c')) await phaseC(boss)
  if (phases.has('d')) await phaseD(boss)
  if (phases.has('e')) await phaseE(boss)
  if (phases.has('h')) await phaseH(boss, mate)
  if (phases.has('r')) await phaseR(boss, mate)
  check('지도 건들은 proc_def · form_def 행을 하나도 만들지 않았다(흐름도 BPMN 은 그때그때)', (await procDefs()) === defs00 && (await formDefs()) === forms00, `proc_def ${(await procDefs()) - defs00} · form_def ${(await formDefs()) - forms00}`)
  if (phases.has('bpm')) await phaseBpm(boss, mate)
  // side by side (the video shows this)
  const list = [OUT.cases.mapA, OUT.cases.bpmA].filter(Boolean)
  if (list.length) {
    const r = spawnSync('node', ['scripts/engine-compare.mjs', ...list.flatMap((x) => ['--case', x])], { cwd: SERVER, encoding: 'utf8', env: { ...process.env, PRO_TENANT_ID: T } })
    OUT.compare = r.stdout
    console.log(r.stdout)
  }
  log(`통과 ${OUT.checks.filter((c) => c.ok).length} · 실패 ${OUT.checks.filter((c) => c.ok === false).length}`)
} catch (e) {
  if (!e.cleanOnly) {
    console.error('✗', e.message, e.body ? JSON.stringify(e.body).slice(0, 300) : '')
    OUT.error = e.message
    process.exitCode = 1
  } else [engineBefore] = [{ engine: process.env.ENGINE_BEFORE || null }]
} finally {
  if (!keep) {
    log('— 지우기')
    OUT.cleanup = await cleanup().catch((e) => ({ error: e.message }))
    log('  ', JSON.stringify(OUT.cleanup))
    if (engineBefore?.engine) await q(`update pro_run_settings set engine=$2 where tenant_id=$1`, [T, engineBefore.engine])
    else { await q(`update pro_run_settings set engine=null where tenant_id=$1`, [T]); await q(`delete from pro_run_settings where tenant_id=$1 and default_mode is null and engine is null`, [T]) }
  } else log('— --keep: 남겨 둠', JSON.stringify(OUT.cases))
  save()
  await closeOntology().catch(() => {})
  await pool.end().catch(() => {})
  setTimeout(() => process.exit(process.exitCode || 0), 200)
}
