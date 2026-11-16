// 실행 방식(사람이 지켜봄 HOTL · 단계마다 사람이 정함 HITL) 시연 — 실제 메일 테넌트 jy-mail 의 찾은 프로세스 「강의계획서 작성 · 보고」로.
// 들어온 「외부 강의 요청」 메일은 시험용(보낸 사람 kim@example-univ.test, 진짜 메일이 들어올 때와 같은 run.js routeMail 길 —
// POST /api/ontology/simulate-mail). 되돌릴 수 없는 단계(고객 회신)는 확인을 받아도 「보냈을 내용」만 건에 남는다(네트워크 없음).
//
//   cd server && PRO_TENANT_ID=jy-mail node scripts/runmode-lecture.mjs --all      # 준비 → HOTL → HITL → 방식 되돌리기 (건은 남겨 둔다: 지켜보기 화면)
//   cd server && PRO_TENANT_ID=jy-mail node scripts/runmode-lecture.mjs --setup    # 다듬기 고침 · 단계 분류 · 일 정의 · 데모 동료 · 「자동」 · 사람이 지켜봄
//   cd server && PRO_TENANT_ID=jy-mail node scripts/runmode-lecture.mjs --hotl     # 건 1: 저절로 진행 → 멈추기/이어 가기 → 고객 회신 확인(기록만) → 인계 → 되감기 → 끝까지
//   cd server && PRO_TENANT_ID=jy-mail node scripts/runmode-lecture.mjs --hitl     # 건 2: 단계마다 확인(진행 · 멈추기 · 이어 가기) → 교육 진행에서 방식을 되돌리면 인계
//   cd server && PRO_TENANT_ID=jy-mail node scripts/runmode-lecture.mjs --status   # 지금 건 · 방식 · 상태 파일
//   cd server && PRO_TENANT_ID=jy-mail node scripts/runmode-lecture.mjs --drop-cases  # 이 스크립트가 연 건만 지운다(준비는 그대로 — 다시 --hotl · --hitl)
//   cd server && PRO_TENANT_ID=jy-mail node scripts/runmode-lecture.mjs --reset    # 이 스크립트가 만든 모든 것을 지우고, 손댄 설정을 처음대로
//
// 환경: BFF :8790(PRO_TENANT_ID=jy-mail, PRO_BACKGROUND=0 — 단계 일꾼 · 건 훑기는 PRO_BACKGROUND 와 상관없이 돈다), completion :8099(공용, 그대로).
// REC_PAUSE=초 : 장면마다 그만큼 쉰다(녹화용). 처음 --setup 이 손대기 전 상태를 .scratch/runmode-lecture.state.json 에 남기고, --reset 이 그대로 되돌린다.
process.env.DOTENV_CONFIG_QUIET = 'true'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const { q, pool, admin } = await import('../lib/supa.js')
const { withTenant } = await import('../lib/tenant.js')
const { cypher } = await import('../lib/ontology/store.js')

const API = process.env.API_URL || 'http://localhost:8790/api'
const T = 'jy-mail'
const PROC_NAME = '강의계획서 작성 · 보고'
const BOSS = 'jyjang@uengine.org'
const COLLEAGUE = { email: 'runmode-demo-instructor@example.com', name: '데모 강사(시험용)' }
const STATE = new URL('../../.scratch/runmode-lecture.state.json', import.meta.url)
const OUT = new URL('../../.scratch/runmode-lecture.out.json', import.meta.url)
const TASKS = ['강의계획서 작성', '강의자료 준비', '고객 회신', '교육 진행']
const AGENT_TASKS = ['강의계획서 작성', '강의자료 준비', '고객 회신']
const MAIL = {
  from: '김지원 교수 <kim@example-univ.test>',
  subject: '[외부 강의 요청] 「생성형 AI로 일하는 법」 특강 부탁드립니다',
  text: '안녕하세요, 예시대학교 경영학과 김지원입니다. 다음 달 둘째 주 목요일 오후에 3학년 학생 40명을 대상으로 「생성형 AI로 일하는 법」 특강(3시간)을 부탁드리고 싶습니다. ' +
    '실습이 조금 들어가면 좋겠고, 노트북은 학생들이 각자 가져옵니다. 강의계획서와 준비할 자료를 미리 보내 주시면 학과에 공유하겠습니다. 감사합니다.',
}
// the review's fixes this flow needs (Fable's 다듬기 issues on this process, accepted as they are)
const AI_FIXES = ['47c8553a', '5041e317', '72b76c0b', '41af645b', 'cb828268']
// a person's corrections on top (내가 고침)
const MY_FIXES = [
  { op: 'remove_edge', args: { from: '강의계획서 작성', to: '__end__' }, why: '계획서만 쓰고 끝난 건은 대화 기록이 거기서 끊긴 것 — 계획서 뒤에는 자료 준비가 와요' },
  { op: 'remove_edge', args: { from: '강의계획서 작성', to: '교육 진행' }, why: '교육 전에 자료 준비를 거쳐요' },
  { op: 'remove_edge', args: { from: '강의자료 준비', to: '강의계획서 작성' }, why: '자료를 만들다 계획서를 다듬은 것은 같은 준비의 되풀이예요' },
  { op: 'add_task', args: { name: '고객 회신', role: '전무', after: '강의자료 준비', before: '교육 진행' }, why: '밖에서 온 강의 요청에는 계획서와 자료를 요청한 곳에 회신해요(대화방 기록에는 없는 단계)' },
  { op: 'remove_edge', args: { from: '강의자료 준비', to: '__end__' }, why: '자료 준비 뒤에는 요청한 곳에 회신해요' },
  { op: 'set_role', args: { task: '교육 진행', role: '강사' }, why: '강의는 강사가 해요(기록에서 고른 「개발」은 교육을 받은 쪽의 할 일 글)' },
]
const CLASSES = { '교육 진행': 'human', '강의계획서 작성': 'ai', '강의자료 준비': 'ai' }

const args = new Set(process.argv.slice(2))
const pause = Number(process.env.REC_PAUSE || 0) * 1000
const ieyo = (w) => { const c = String(w).slice(-1).charCodeAt(0) - 0xac00; return c >= 0 && c < 11172 && c % 28 ? '이에요' : '예요' }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const scene = async (name) => { log(`— ${name}`); if (pause) await sleep(pause) }
const out = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {}
const save = () => fs.writeFileSync(OUT, JSON.stringify(out, null, 1))
function log(...a) { console.log(new Date().toISOString().slice(11, 19), ...a) }

async function call(tok, method, path, body) {
  const r = await fetch(`${API}${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` }, body: body ? JSON.stringify(body) : undefined })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw Object.assign(new Error(`${method} ${path} → ${r.status} ${j.error || ''}`), { status: r.status, body: j })
  return j
}
async function signIn(email) {
  const r = await fetch(`${API}/auth/email/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, code: '000000' }) })
  const j = await r.json()
  assert.ok(j.session?.access_token, `sign-in ${email}: ${JSON.stringify(j).slice(0, 160)}`)
  return { id: j.user.id, tok: j.session.access_token, email }
}
async function waitFor(what, fn, { timeout = 240_000, every = 2500 } = {}) {
  const until = Date.now() + timeout
  for (;;) {
    const v = await fn().catch((e) => { log('  (wait)', e.message); return null })
    if (v) return v
    if (Date.now() > until) throw new Error(`시간 초과: ${what}`)
    await sleep(every)
  }
}
const procOf = async () => {
  const [p] = await withTenant(T, () => cypher(`MATCH (b:Process) WHERE b.name=$name RETURN b.key AS key, b.status AS status, b.owner AS owner`, { name: PROC_NAME }))
  assert.ok(p, `프로세스 「${PROC_NAME}」가 없어요`)
  return p
}
const stepRow = async (caseId, task, state) => (await q(`select * from pro_case_steps where case_id=$1 and task=$2 ${state ? 'and state = any($3)' : ''} order by created_at desc limit 1`, state ? [caseId, task, [].concat(state)] : [caseId, task]))[0]
const todoOf = async (caseId, task) => {
  const [c] = await q(`select instances from pro_po_cases where id=$1`, [caseId])
  return (await q(`select id, status::text as status, draft_status::text as ds, agent_mode::text as mode, user_id, output, draft from todolist where proc_inst_id=$1 and activity_name=$2 order by start_date desc nulls last limit 1`, [c.instances.at(-1), task]))[0]
}
const runOf = (who, caseId) => call(who.tok, 'GET', `/ontology/cases/${caseId}/run`)
const brief = (run) => run.steps.filter((s) => s.current).map((s) => `${s.task}:${s.state}${s.why.length ? `(${s.why.join(',')})` : ''}${s.reversible ? '' : '[되돌릴 수 없음]'}${s.holder?.agent ? '@에이전트' : s.holder?.names?.length ? `@${s.holder.names.join(',')}` : ''}`).join(' → ')
const hisHome = async (who) => (await call(who.tok, 'GET', '/notifications')).filter((n) => n.type === 'workitem').map((n) => n.title)
const hisTodos = async (who) => (await call(who.tok, 'GET', '/todos')).map((t) => t.activity_name)

// ---------- state ----------
async function snapshotState(boss, p) {
  const taskNodes = await withTenant(T, () => cypher(`MATCH (t:Task) WHERE t.key IN $keys RETURN t.key AS key, t.definition_md AS md, t.skills AS skills, t.checkpoints AS cp, t.outputs AS outs, t.autonomy AS aut, t.pinned AS pinned, t.pinned_by AS pinned_by, t.pin_reason AS pin_reason`, { keys: TASKS }))
  const [refine] = await q(`select review, classes from pro_refine_reviews where tenant_id=$1 and proc_key=$2`, [T, p.key])
  const [cfg] = await q(`select value from configuration where tenant_id=$1 and key='proc_map'`, [T])
  return {
    startedAt: new Date().toISOString(), proc: p, boss: boss.id,
    corrections: (await q(`select id::text as id from pro_corrections where tenant_id=$1 and proc_key=$2`, [T, p.key])).map((r) => r.id),
    refine: refine || null, tasks: taskNodes,
    runModes: await q(`select * from pro_run_modes where tenant_id=$1 and proc_key=$2`, [T, p.key]),
    runSettings: await q(`select * from pro_run_settings where tenant_id=$1`, [T]),
    stepRules: await q(`select * from pro_run_step_rules where tenant_id=$1 and proc_key=$2`, [T, p.key]),
    roleAssign: await q(`select * from pro_role_assignments where tenant_id=$1 and role='강사'`, [T]),
    cases: (await q(`select id::text as id from pro_po_cases where tenant_id=$1`, [T])).map((r) => r.id),
    procDefs: (await q(`select id from proc_def where tenant_id=$1 and id like 'onto\\_%'`, [T])).map((r) => r.id),
    procMapHadOnto: !!cfg,
    colleague: null,
  }
}
const loadState = () => (fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : null)
const saveState = (s) => fs.writeFileSync(STATE, JSON.stringify(s, null, 1))

// ---------- setup ----------
async function setup() {
  const boss = await signIn(BOSS)
  const p = await procOf()
  let st = loadState()
  if (!st) { st = await snapshotState(boss, p); saveState(st); log('상태 저장', STATE.pathname) } else log('상태 파일이 이미 있어요 — 처음 상태는 그대로 두고 이어서 준비해요')
  await scene('다듬기 ① 바로잡기: AI(Fable)가 제안한 고칠 곳 받아들이기')
  let view = await call(boss.tok, 'GET', `/ontology/refine/${encodeURIComponent(p.key)}`)
  for (const id of AI_FIXES) {
    const i = view.review?.issues?.find((x) => x.id === id)
    assert.ok(i, `제안 ${id} 없음`)
    if (i.status === 'accepted') continue
    view = await call(boss.tok, 'POST', `/ontology/refine/${encodeURIComponent(p.key)}/issues/${id}`, { action: 'accept' })
    log('  받아들임:', i.fix?.label || i.title)
  }
  await scene('다듬기 ① 내가 고침: 회신 단계 · 순서 · 맡는 역할')
  for (const f of MY_FIXES) {
    const have = view.corrections.find((c) => c.op === f.op && JSON.stringify(c.args) === JSON.stringify(f.args))
    if (have) continue
    view = await call(boss.tok, 'POST', `/ontology/refine/${encodeURIComponent(p.key)}/corrections`, f)
    log('  고침:', view.corrections.at(-1).label)
  }
  log('  다듬은 흐름:', view.refined.tasks.map((t) => `${t.key}(${t.role})`).join(' → '))
  await scene('다듬기 ② 단계 가르기: 교육 진행 = 사람이 꼭, 계획서 · 자료 = AI')
  for (const [task, cls] of Object.entries(CLASSES)) {
    if (view.classes[task]?.class === cls && view.classes[task]?.decided) continue
    view = await call(boss.tok, 'POST', `/ontology/refine/${encodeURIComponent(p.key)}/classes`, { task, class: cls })
  }
  log('  분류:', Object.entries(view.classes).filter(([k]) => TASKS.includes(k)).map(([k, v]) => `${k}=${v.class}${v.decided ? '(정함)' : ''}`).join(' · '))
  await scene('일 정의: 에이전트가 맡을 단계(초안에서 runner agent · 글로 만드는 doc-draft)')
  for (const key of AGENT_TASKS) {
    const t = await call(boss.tok, 'GET', `/ontology/tasks/${encodeURIComponent(key)}`)
    if (t.parsed?.runner === 'agent' && t.parsed.skills.includes('doc-draft')) continue
    let md
    try { md = (await call(boss.tok, 'POST', `/ontology/tasks/${encodeURIComponent(key)}/draft`, {})).definition } catch (e) { log('  초안 실패 — 손으로 쓴 정의로:', e.message) }
    md ||= `---\nname: ${key}\ndescription: ${key}\nkind: task\nrunner: agent\nskills: [doc-draft]\nautonomy: draft\n---\n`
    md = md.replace(/^runner: \w+$/m, 'runner: agent')
    md = /^skills: /m.test(md) ? md.replace(/^skills: .*$/m, 'skills: [doc-draft]') : md.replace(/^kind: task$/m, 'kind: task\nskills: [doc-draft]')
    const s = await call(boss.tok, 'PUT', `/ontology/tasks/${encodeURIComponent(key)}/definition`, { definition: md })
    log(`  ${key}: runner ${s.parsed.runner} · skills ${s.parsed.skills.join(',')} · 점검 ${s.parsed.checkpoints.length}개`)
  }
  await scene('데모 동료: 강사 역할(교육 진행을 받을 사람)')
  const [had] = await q(`select id::text as id from users where tenant_id=$1 and email=$2`, [T, COLLEAGUE.email])
  const m = await call(boss.tok, 'POST', '/team', { email: COLLEAGUE.email, name: COLLEAGUE.name })
  if (!st.colleague) { st.colleague = { id: m.id, email: COLLEAGUE.email, created: !had }; saveState(st) }
  await call(boss.tok, 'PUT', '/roles', { role: '강사', userId: m.id })
  log(`  ${COLLEAGUE.name} <${COLLEAGUE.email}> · 강사 · ${m.id}`)
  await scene('승격 「자동」 + 실행 방식 「사람이 지켜봄(자동 진행)」')
  if (p.status !== 'adopted') await call(boss.tok, 'POST', '/ontology/processes/status', { key: p.key, status: 'adopted', name: PROC_NAME })
  await call(boss.tok, 'POST', '/ontology/processes/run-mode', { key: p.key, mode: 'hotl', name: PROC_NAME })
  const steps = await call(boss.tok, 'GET', `/ontology/processes/steps?key=${encodeURIComponent(p.key)}`)
  out.setup = { proc: p.key, mode: steps.mode, steps: steps.steps.map((s) => ({ task: s.task, role: s.role, runner: s.runner, responsible: s.responsible.on, responsibleWhy: s.responsible.why, irreversible: s.irreversible.on, irreversibleBy: s.irreversible.by, irreversibleWhy: s.irreversible.why })) }
  for (const s of out.setup.steps) log(`  ${s.task}: ${s.runner || '정의 없음'} · ${s.responsible ? `책임 단계(${s.responsibleWhy[0]})` : '책임 단계 아님'} · ${s.irreversible ? `되돌릴 수 없음(${s.irreversibleWhy})` : '되돌릴 수 있음'}`)
  save()
}

// ---------- a case from the simulated mail ----------
async function mailIn(boss, p, label) {
  const since = new Date()
  const r = await call(boss.tok, 'POST', '/ontology/simulate-mail', MAIL)
  log('  들어온 메일 →', JSON.stringify(r).slice(0, 160))
  let caseId = r.caseId
  if (!caseId) {
    // the start task was unsure (< 50%): the card asks and the person picks — the first option
    const [m] = await q(`select m.id, m.content from pro_messages m join pro_threads t on t.id=m.thread_id where t.user_id=$1 and m.kind='onto-entry' and m.content->>'state'='ask' and m.created_at >= $2 order by m.created_at desc limit 1`, [boss.id, since])
    assert.ok(m, '건이 시작되지도, 묻지도 않았어요')
    const ch = m.content.choice
    const r2 = await call(boss.tok, 'POST', '/ontology/cases', { proc: ch.proc, entry: ch.options[0].task, subject: MAIL.subject, body: MAIL.text, from: MAIL.from, odds: ch, kind: 'mail', messageId: m.id })
    caseId = r2.caseId
    log('  시작 일이 애매해서 카드에서 골랐어요:', ch.options[0].task)
  }
  const [c] = await q(`select id::text as id, entry_task, entry_odds, instances from pro_po_cases where id=$1`, [caseId])
  out[label] = { caseId, entry: c.entry_task, odds: c.entry_odds?.p ?? null, measured: c.entry_odds?.measured ?? null, instances: c.instances, log: [] }
  save()
  log(`  건 ${caseId} · 「${c.entry_task}」부터${c.entry_odds?.p != null ? ` (${Math.round(c.entry_odds.p * 100)}%)` : ''}`)
  return caseId
}
const note = (label, line) => { out[label].log.push(line); save(); log('  ✓', line) }

async function hotl() {
  const boss = await signIn(BOSS), mate = await signIn(COLLEAGUE.email)
  const p = await procOf()
  await scene('HOTL: 시험용 「외부 강의 요청」 메일이 들어온다 — 건이 저절로 시작')
  const id = await mailIn(boss, p, 'hotl')
  // 강의계획서 작성: the agent takes it by itself (no question)
  assert.equal(out.hotl.entry, '강의계획서 작성', `시작 일이 ${out.hotl.entry} — --drop-cases 뒤 다시`)
  const s1 = await waitFor('강의계획서 작성을 에이전트가 잡음', () => stepRow(id, '강의계획서 작성'), { every: 800 })
  assert.equal(s1.state, 'auto', `강의계획서 작성 ${s1.state}`)
  note('hotl', `강의계획서 작성: 묻지 않고 에이전트가 시작(관문 ${s1.state}, 방식 ${s1.mode})`)
  await scene('지켜보다가 「멈추기」 — 에이전트가 다음 단계를 잡지 않는다')
  await call(boss.tok, 'POST', `/ontology/cases/${id}/pause`)
  await waitFor('강의계획서 작성 끝남', async () => (await todoOf(id, '강의계획서 작성'))?.status === 'DONE')
  const held = await waitFor('강의자료 준비가 멈춤으로 기다림', async () => { const s = await stepRow(id, '강의자료 준비'); return s?.state === 'waiting' && s.why.includes('paused') ? s : null })
  note('hotl', `멈춤: 강의자료 준비가 기다림(${held.why.join(',')}) · 할 일 ${(await todoOf(id, '강의자료 준비')).ds}`)
  out.hotl.paused = brief(await runOf(boss, id)); save()
  await sleep(6000)
  assert.equal((await todoOf(id, '강의자료 준비')).status, 'IN_PROGRESS')
  await scene('「이어 가기」 — 멈춘 동안 기다리던 단계를 다시 본다')
  await call(boss.tok, 'POST', `/ontology/cases/${id}/resume`)
  await waitFor('강의자료 준비 끝남', async () => (await todoOf(id, '강의자료 준비'))?.status === 'DONE', { timeout: 300_000 })
  note('hotl', '이어 가기: 강의자료 준비를 묻지 않고 마침')
  await scene('되돌릴 수 없는 단계: 고객 회신 — 초안을 만들고 멈춰 묻는다')
  const w = await waitFor('고객 회신이 되돌릴 수 없는 단계로 기다림', async () => { const s = await stepRow(id, '고객 회신'); return s?.state === 'waiting' && s.why.includes('irreversible') && s.preview ? s : null }, { timeout: 300_000 })
  const [card] = await q(`select id, content from pro_messages where id=$1`, [w.message_id])
  note('hotl', `고객 회신: 기다림(${w.why.join(',')}) · 받는 사람 ${w.preview.to} · 제목 「${w.preview.subject}」 · 주인에게 카드 ${card?.content?.state}`)
  out.hotl.preview = w.preview; out.hotl.atReply = brief(await runOf(boss, id)); save()
  await scene('「보내기」 — 이 판은 보냈을 내용만 건에 남긴다(실제로는 보내지 않음)')
  const d = await call(boss.tok, 'POST', `/ontology/steps/${w.id}`, { action: 'go' })
  assert.ok(d.sent?.stub, '보낸 기록이 없어요')
  note('hotl', `보내기: 기록만(${d.sent.to} · 「${d.sent.subject}」 · stub ${d.sent.stub})`)
  await scene('인계: 교육 진행이 강사(데모 동료)의 할 일로')
  await waitFor('교육 진행이 강사에게', async () => (await hisTodos(mate)).includes('교육 진행'), { timeout: 240_000 })
  const t5 = await todoOf(id, '교육 진행')
  const home = await hisHome(mate)
  note('hotl', `교육 진행: 데모 강사의 할 일 · 홈 카드 ${home.includes('교육 진행') ? '있음' : '없음'} · 방식 ${t5.mode || '사람'} · 담당 ${t5.user_id}`)
  const run1 = await runOf(boss, id)
  out.hotl.handover = brief(run1); save()
  log('  지켜보기:', brief(run1))
  await scene('「이 단계로 되감기」: 강의자료 준비로 — 이미 밖으로 보낸 고객 회신은 되돌아오지 않는다고 먼저 묻는다')
  const ask = await call(boss.tok, 'POST', `/ontology/cases/${id}/rewind`, { task: '강의자료 준비' })
  assert.ok(ask.confirm, `확인을 묻지 않았어요: ${JSON.stringify(ask).slice(0, 120)}`)
  note('hotl', `되감기 확인: 되돌아오지 않는 것 ${ask.lost.join(',')} · 다시 하는 일 ${ask.redo.join(',')}`)
  const rw = await call(boss.tok, 'POST', `/ontology/cases/${id}/rewind`, { task: '강의자료 준비', confirm: true })
  note('hotl', `되감음: 새 인스턴스 ${rw.instId}`)
  const old = await q(`select status::text as status from todolist where id=$1`, [t5.id])
  note('hotl', `되감은 뒤 강사의 교육 진행 할 일: ${old[0]?.status} · 강사 목록에 ${(await hisTodos(mate)).includes('교육 진행') ? '남음' : '없음'}`)
  await waitFor('다시 한 강의자료 준비 끝남', async () => (await todoOf(id, '강의자료 준비'))?.status === 'DONE', { timeout: 300_000 })
  const w2 = await waitFor('고객 회신이 다시 기다림', async () => { const s = await stepRow(id, '고객 회신', 'waiting'); return s?.preview ? s : null }, { timeout: 300_000 })
  await call(boss.tok, 'POST', `/ontology/steps/${w2.id}`, { action: 'go' })
  note('hotl', '되감은 뒤: 강의자료 준비를 다시 하고, 고객 회신을 다시 물어 「보내기」(기록만, 두 번째)')
  const t6 = await waitFor('교육 진행이 다시 강사에게', async () => { const t = await todoOf(id, '교육 진행'); return t?.status === 'IN_PROGRESS' && (await hisTodos(mate)).includes('교육 진행') ? t : null }, { timeout: 240_000 })
  // the agent's draft reaches the person's step first (adopted process: draft mode)
  await waitFor('교육 진행 초안', async () => { const t = await todoOf(id, '교육 진행'); return t?.draft && Object.keys(t.draft).length ? t : null }, { timeout: 180_000 }).catch(() => null)
  await scene('강사가 교육 진행을 낸다 — 건이 끝난다')
  await call(mate.tok, 'POST', `/todos/${t6.id}/submit`, { values: { result: '특강을 마쳤어요. 학생 40명 · 실습 2개 진행.' } })
  await waitFor('건 끝남', async () => (await q(`select status from pro_po_cases where id=$1`, [id]))[0]?.status === 'done', { timeout: 120_000 })
  const end = await runOf(boss, id)
  out.hotl.end = brief(end); out.hotl.older = end.steps.filter((s) => !s.current).map((s) => `${s.task}:${s.state}${s.sent ? '(보냄 기록)' : ''}`); save()
  note('hotl', `건 끝: ${brief(end)}`)
}

async function hitl() {
  const boss = await signIn(BOSS), mate = await signIn(COLLEAGUE.email)
  const p = await procOf()
  await scene('방식을 「단계마다 사람이 정함」으로')
  const m = await call(boss.tok, 'POST', '/ontology/processes/run-mode', { key: p.key, mode: 'hitl', name: PROC_NAME })
  assert.equal(m.mode, 'hitl')
  await scene('HITL: 같은 메일이 다시 들어온다')
  const id = await mailIn(boss, p, 'hitl')
  const ask = async (task, why = 'hitl') => {
    const s = await waitFor(`${task} 확인을 기다림`, async () => { const x = await stepRow(id, task, 'waiting'); return x && x.why.includes(why) && x.message_id && (why !== 'irreversible' || x.preview) ? x : null }, { timeout: 300_000 })
    const [card] = await q(`select content from pro_messages where id=$1`, [s.message_id])
    note('hitl', `${task}: 「${why === 'irreversible' ? '보낼까요?' : `다음은 「${task}」${ieyo(task)} — 진행할까요?`}」 · 까닭 ${s.why.join(',')} · 근거 「${s.proposal?.why || ''}」 · 카드 ${card?.content?.state}`)
    return s
  }
  const a = await ask('강의계획서 작성')
  await scene('「진행」')
  await call(boss.tok, 'POST', `/ontology/steps/${a.id}`, { action: 'go' })
  const b = await ask('강의자료 준비')
  await scene('「멈추기」 → 「이어 가기」(다시 묻는다) → 「진행」')
  await call(boss.tok, 'POST', `/ontology/steps/${b.id}`, { action: 'stop' })
  const runP = await runOf(boss, id)
  note('hitl', `멈추기: 건 멈춤 ${runP.paused} · 강의자료 준비 ${runP.steps.find((s) => s.current && s.task === '강의자료 준비')?.state}`)
  await sleep(4000)
  await call(boss.tok, 'POST', `/ontology/cases/${id}/resume`)
  const [again] = await q(`select count(*)::int n from pro_messages where kind='onto-step' and content->>'stepId'=$1`, [b.id])
  note('hitl', `이어 가기: 강의자료 준비를 다시 물음(카드 ${again.n}장)`)
  await call(boss.tok, 'POST', `/ontology/steps/${b.id}`, { action: 'go' })
  const c = await ask('고객 회신', 'irreversible')
  await scene('되돌릴 수 없는 단계도 단계마다: 초안을 보고 「보내기」(기록만)')
  const d = await call(boss.tok, 'POST', `/ontology/steps/${c.id}`, { action: 'go' })
  note('hitl', `보내기: 기록만(${d.sent?.to})`)
  const e = await ask('교육 진행')
  const hidden = !(await hisTodos(mate)).includes('교육 진행') && !(await hisHome(mate)).includes('교육 진행')
  note('hitl', `교육 진행: 주인이 정하기 전이라 강사 목록에 ${hidden ? '안 보임' : '보임'} (hold ${e.hold_item})`)
  out.hitl.atHandover = brief(await runOf(boss, id)); save()
  await scene('방식을 되돌린다(회사 기본값 = 사람이 지켜봄) — 확인만 기다리던 교육 진행이 그대로 넘어간다')
  const back = await call(boss.tok, 'POST', '/ontology/processes/run-mode', { key: p.key, mode: null, name: PROC_NAME })
  note('hitl', `방식 되돌림: ${back.mode}(${back.from}) · 이어서 진행한 단계 ${back.released}개`)
  await waitFor('교육 진행이 강사에게', async () => (await hisTodos(mate)).includes('교육 진행'), { timeout: 240_000 })
  note('hitl', '교육 진행: 강사의 할 일로 넘어감')
  out.hitl.end = brief(await runOf(boss, id)); save()
}

async function status() {
  const st = loadState()
  const p = await procOf()
  log('프로세스', p.key, p.status, '| 상태 파일', st ? st.startedAt : '없음')
  const rows = await q(`select id::text as id, status, entry_task, created_at from pro_po_cases where tenant_id=$1 and bundle=$2 order by created_at`, [T, p.key])
  for (const r of rows) log('  건', r.id, r.status, r.entry_task, r.created_at.toISOString())
  log('  방식', JSON.stringify(await q(`select mode from pro_run_modes where tenant_id=$1 and proc_key=$2`, [T, p.key])))
}

// ---------- reset: everything this script made goes, everything it changed goes back ----------
// the cases this script made (and their instances, work items, cards, threads, gates, snapshots, ledger lines) — the setup stays
async function dropCases(st, done = {}) {
  const p = st.proc
  const cases = (await q(`select id::text as id, instances, snapshots from pro_po_cases where tenant_id=$1 and not (id::text = any($2))`, [T, st.cases]))
  const ids = cases.map((c) => c.id), insts = cases.flatMap((c) => c.instances), pids = [...new Set(cases.flatMap((c) => c.snapshots))].filter((x) => !st.procDefs.includes(x))
  const todos = insts.length ? (await q(`select id::text as id from todolist where proc_inst_id = any($1)`, [insts])).map((r) => r.id) : []
  // chat: cards about these cases · their process threads (both people)
  const people = [st.boss, st.colleague?.id].filter(Boolean)
  done.cards = (await q(`delete from pro_messages m using pro_threads t where t.id=m.thread_id and t.user_id = any($1::uuid[]) and m.created_at >= $2 and (
      (m.kind in ('onto-entry','onto-step') and (m.content->>'caseId' = any($3) or m.content->'mail'->>'subject' = $5)) or (m.kind in ('process','chip') and m.content->>'instId' = any($4)) or (m.kind='todo' and m.content->>'todoId' = any($6))) returning m.id`,
  [people, st.startedAt, ids, insts, MAIL.subject, todos])).length
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
  // the snapshots made for them: definitions, forms, the process map menu, the graph's Snapshot nodes
  if (pids.length) {
    await q(`delete from form_def where tenant_id=$1 and proc_def_id = any($2)`, [T, pids]).catch(() => {})
    done.procDefs = (await q(`delete from proc_def where tenant_id=$1 and id = any($2) returning 1`, [T, pids])).length
    const [cfg] = await q(`select value from configuration where tenant_id=$1 and key='proc_map'`, [T])
    if (cfg) {
      const drop = (v) => (Array.isArray(v) ? v.filter((x) => !(x && typeof x === 'object' && pids.includes(x.id))).map(drop) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, drop(x)])) : v)
      await q(`update configuration set value=$3 where tenant_id=$1 and key=$2`, [T, 'proc_map', JSON.stringify(drop(cfg.value))])
    }
    await withTenant(T, () => cypher(`MATCH (s:Snapshot) WHERE s.proc_def_id IN $pids DETACH DELETE s`, { pids }, { actor: 'runmode-lecture reset', reason: '시연 건 지우기' })).catch((e) => log('  snapshot nodes', e.message))
  }
  if (ids.length) done.caseLedger = (await q(`delete from pro_policy_decisions where tenant_id=$1 and created_at >= $2 and action_kind like 'ontology.run.%' and facts->>'case' = any($3) returning 1`, [T, st.startedAt, ids])).length
  return done
}

async function reset() {
  const st = loadState()
  if (!st) { log('상태 파일이 없어요 — 되돌릴 것이 없어요'); return }
  const p = st.proc
  const done = await dropCases(st)
  const ids = []
  // the decision ledger: what this script decided (this process, these cases, the colleague's role)
  done.ledger = (await q(`delete from pro_policy_decisions where tenant_id=$1 and created_at >= $2 and action_kind like 'ontology.%' and (
      facts->>'proc' = $3 or facts->>'process' = $3 or facts->>'case' = any($4) or (action_kind in ('ontology.pin','ontology.unpin') and facts->>'task' = any($5))) returning 1`, [T, st.startedAt, p.key, ids, TASKS])).length
  // 다듬기: corrections made since, the review (issue statuses) and classes as they were
  done.corrections = (await q(`delete from pro_corrections where tenant_id=$1 and proc_key=$2 and not (id::text = any($3)) returning 1`, [T, p.key, st.corrections])).length
  if (st.refine) await q(`update pro_refine_reviews set review=$3, classes=$4 where tenant_id=$1 and proc_key=$2`, [T, p.key, JSON.stringify(st.refine.review), JSON.stringify(st.refine.classes)])
  // the tasks' definitions and pins, the process's ladder step
  await withTenant(T, async () => {
    for (const t of st.tasks) {
      await cypher(`MATCH (t:Task {key:$key}) SET t.definition_md=$md, t.skills=$skills, t.checkpoints=$cp, t.outputs=$outs, t.autonomy=$aut, t.pinned=$pinned, t.pinned_by=$pinned_by, t.pin_reason=$pin_reason`,
        { key: t.key, md: t.md ?? '', skills: t.skills ?? [], cp: t.cp ?? '', outs: t.outs ?? '', aut: t.aut ?? '', pinned: !!t.pinned, pinned_by: t.pinned_by ?? '', pin_reason: t.pin_reason ?? '' }, { actor: 'runmode-lecture reset', reason: '시연 전으로 되돌림' })
    }
    await cypher(`MATCH (b:Process {key:$key}) SET b.status=$status, b.owner=$owner`, { key: p.key, status: p.status, owner: p.owner ?? '' }, { actor: 'runmode-lecture reset', reason: '시연 전으로 되돌림' })
  })
  // run modes · step rules · tenant default · the 강사 assignment
  await q(`delete from pro_run_modes where tenant_id=$1 and proc_key=$2`, [T, p.key])
  for (const r of st.runModes) await q(`insert into pro_run_modes (tenant_id, proc_key, mode, updated_by, updated_at) values ($1,$2,$3,$4,$5)`, [r.tenant_id, r.proc_key, r.mode, r.updated_by, r.updated_at])
  await q(`delete from pro_run_step_rules where tenant_id=$1 and proc_key=$2`, [T, p.key])
  for (const r of st.stepRules) await q(`insert into pro_run_step_rules (tenant_id, proc_key, task, policy, by_user, at) values ($1,$2,$3,$4,$5,$6)`, [r.tenant_id, r.proc_key, r.task, r.policy, r.by_user, r.at])
  if (!st.runSettings.length) await q(`delete from pro_run_settings where tenant_id=$1`, [T])
  await q(`delete from pro_role_assignments where tenant_id=$1 and role='강사'`, [T])
  for (const r of st.roleAssign) await q(`insert into pro_role_assignments (tenant_id, proc_def_id, role, user_id, updated_by) values ($1,$2,$3,$4,$5)`, [r.tenant_id, r.proc_def_id, r.role, r.user_id, r.updated_by])
  // the demo colleague (only when this script made the account)
  if (st.colleague?.created) {
    const u = st.colleague.id
    await q(`delete from notifications where tenant_id=$1 and (user_id=$2 or user_id like '%'||$2||'%')`, [T, u]).catch(() => {})
    const ths = (await q(`select id from pro_threads where user_id=$1`, [u])).map((r) => r.id)
    if (ths.length) { await q(`delete from pro_messages where thread_id = any($1)`, [ths]); await q(`delete from pro_threads where id = any($1)`, [ths]) }
    for (const t of ['pro_team_members', 'pro_team_removed', 'pro_role_members']) await q(`delete from ${t} where tenant_id=$1 and user_id::text=$2`, [T, u]).catch(() => {})
    await q(`delete from pro_profile where user_id=$1`, [u]).catch(() => {})
    // (the auth user's own row in the default tenant comes from the auth trigger — this account only)
    await q(`delete from users where id=$1 and email=$2`, [u, st.colleague.email])
    const { error } = await admin.auth.admin.deleteUser(u)
    done.colleague = error ? `계정 지우기 실패: ${error.message}` : 'deleted'
  }
  log('되돌림', JSON.stringify(done))
  fs.renameSync(STATE, new URL(`../../.scratch/runmode-lecture.state.${Date.now()}.done.json`, import.meta.url))
}

try {
  if (args.has('--reset')) await reset()
  else if (args.has('--drop-cases')) { const st = loadState(); if (st) log('건 지움', JSON.stringify(await dropCases(st))) }
  else if (args.has('--status')) await status()
  else {
    if (args.has('--setup') || args.has('--all')) await setup()
    if (args.has('--hotl') || args.has('--all')) await hotl()
    if (args.has('--hitl') || args.has('--all')) await hitl()
    if (![...args].some((a) => ['--setup', '--hotl', '--hitl', '--all'].includes(a))) console.log('옵션: --all | --setup | --hotl | --hitl | --status | --reset')
  }
} catch (e) { console.error('✗', e.message, e.body ? JSON.stringify(e.body).slice(0, 300) : ''); process.exitCode = 1 } finally { await pool.end().catch(() => {}); setTimeout(() => process.exit(process.exitCode || 0), 200) }
