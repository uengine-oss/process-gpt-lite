// 말로 프로세스 지도 고치기 · 더하기 · 의견(lib/ontology/editmap.js · opinions.js) HTTP e2e — 실제 메일 테넌트 jy-mail 에서, 돌고 있는 BFF(:8790)로.
// 모델 호출(말 → 동작)은 진짜다(판단 모델 rules.edit.judge). 메일 · 캘린더에는 아무것도 쓰지 않는다(되돌릴 수 없는 단계는 「보냈을 내용」만 건에 남는다).
//   cd server && PRO_TENANT_ID=jy-mail node test/ontology-editmap.e2e.mjs [--phase n,e,c] [--keep]
//     n  새 프로세스를 말로 → 미리 보기(아무것도 바뀌지 않음) → 적용 → 지도에 「제안」 · n 0 · 사람이 정한 길 → 지도에서 바로(실험 엔진)로 손으로 시작해
//        끝까지(흐름도 BPMN 은 그때그때, proc_def 없음) → 고른 범위 안에서 말로 고치기(범위 밖 요청은 하지 않음) → 되돌리기 → 프로세스 지우기
//     e  의견: 주인과 시험용 동료(이 시험이 만들고 지움)가 강의 프로세스에 서로 어긋나는 의견 → 지도에 「해소 필요」 → 동료는 적용 못 함 → 관리자가 하나를 골라
//        적용(고친 기록에 누구의 의견인지) · 다른 의견은 닫힘 · 동료에게 알림 → 되돌려도 의견은 다시 열리지 않음
//     c  채팅 카드: 초안 카드의 「지도에 넣기」(초안 계약은 시험이 넣는다 — 생성기는 부르지 않음) → 적용 → 지우기 · 「○○ 프로세스에서 …」 카드 → 그만두기
//   끝나면 이 시험이 만든 프로세스 · 일 · 고친 기록 · 의견 · 건 · 할 일 · 단계 · 카드 · 스레드 · 알림 · 원장 · 시험용 동료를 지우고 엔진 설정을 처음대로(--keep: 남김).
process.env.DOTENV_CONFIG_QUIET = 'true'
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SERVER = path.join(HERE, '..')
const { q, admin } = await import('../lib/supa.js')
const { withTenant } = await import('../lib/tenant.js')
const { cypher, closeOntology } = await import('../lib/ontology/store.js')

const API = process.env.API_URL || 'http://localhost:8790/api'
const T = 'jy-mail'
const LECTURE = 'process:5c5451687f'
const BOSS = 'jyjang@uengine.org'
const MATE = { email: 'editmap-e2e-colleague@example.com', name: '시험 동료(말로 고치기)' }
const argv = process.argv.slice(2)
const phases = new Set((argv.includes('--phase') ? argv[argv.indexOf('--phase') + 1] : 'n,e,c').split(','))
const keep = argv.includes('--keep')
const START = new Date()
const OUT = { startedAt: START.toISOString(), checks: [], plans: {}, cases: {} }
const OUTFILE = process.env.E2E_OUT || path.join(SERVER, '..', '.scratch', 'editmap-e2e.out.json')
const WORDS_NEW = '견적 요청이 오면 영업이 견적서를 만들고, 500만 원 이상이면 대표 승인 후 고객에게 보낸다'
const SUBJECT = '[견적 요청] 사무실 집기 견적 부탁드립니다(말로 고치기 시험)'
const BODY = '안녕하세요. 사무실 집기 견적을 부탁드립니다. 예산은 620만 원 정도입니다.'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)
function check(label, ok, detail = '') {
  OUT.checks.push({ label, ok: !!ok, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) })
  log(ok ? '  ✓' : '  ✗', label, detail ? `— ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : '')
  if (!ok) throw new Error(`실패: ${label} ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
}
const note = (label, detail) => { OUT.checks.push({ label, ok: null, detail }); log('  ·', label, detail ? `— ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : '') }
const save = () => fs.writeFileSync(OUTFILE, JSON.stringify(OUT, null, 1))
async function call(tok, method, p, body) {
  const r = await fetch(`${API}${p}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` }, body: body ? JSON.stringify(body) : undefined })
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
async function waitFor(what, fn, { timeout = 180_000, every = 2000 } = {}) {
  const until = Date.now() + timeout
  for (;;) {
    const v = await fn().catch((e) => { log('  (wait)', e.message); return null })
    if (v) return v
    if (Date.now() > until) throw new Error(`시간 초과: ${what}`)
    await sleep(every)
  }
}
const G = (c, p = {}) => withTenant(T, () => cypher(c, p))
const n = async (sql, args = [T]) => Number((await q(sql, args))[0].n)
const graphCounts = async () => ({
  Process: Number((await G('MATCH (b:Process) RETURN count(b) AS n'))[0].n), Task: Number((await G('MATCH (t:Task) RETURN count(t) AS n'))[0].n),
  NEXT: Number((await G('MATCH (a:Task)-[e:NEXT]->() RETURN count(e) AS n'))[0].n), corrections: await n(`select count(*) n from pro_corrections where tenant_id=$1`),
  procDefs: await n(`select count(*) n from proc_def where tenant_id=$1`), formDefs: await n(`select count(*) n from form_def where tenant_id=$1`),
  labels: await n(`select count(*) n from pro_onto_labels where tenant_id=$1`), opinions: await n(`select count(*) n from pro_map_opinions where tenant_id=$1`),
})
const plans = []
const plan = async (who, body, label) => {
  const p = await call(who.tok, 'POST', '/ontology/edit/plan', body)
  OUT.plans[label] = { words: body.words, scope: p.scope, range: p.range, ops: p.ops.map((o) => ({ op: o.op, args: o.args, label: o.label })), refused: p.refused, matched: p.matched, question: p.question, note: p.note, model: p.model, ms: p.ms }
  plans.push(p); save()
  log(`  말 「${body.words}」 → ${p.ops.map((o) => o.label).join(' / ') || '없음'}${p.refused.length ? ` · 하지 않음 ${p.refused.map((r) => `${r.label}(${r.why})`).join(' / ')}` : ''}${p.question ? ` · 물음 ${p.question}` : ''} (${p.model}, ${Math.round(p.ms / 1000)}초)`)
  return p
}
const made = { procs: new Set(), tasks: new Set(), cases: new Set(), messages: new Set(), threads: new Set(), corrections: new Set(), mate: null, mateCreated: false, notesBefore: new Set() }

// ---------- (n) 새 프로세스 → 실행 → 범위 안에서 고치기 → 되돌리기 → 지우기 ----------
async function phaseN(boss) {
  log('— (n) 새 프로세스를 말로 → 지도에 → 지도에서 바로 끝까지 → 범위 안에서 고치기 → 되돌리기 → 지우기')
  const before = await graphCounts()
  const p = await plan(boss, { words: WORDS_NEW }, 'new')
  check('미리 보기: 새 프로세스 한 동작 · 단계 3개 이상 · 금액 갈림길', p.scope === 'new' && p.ops.length === 1 && p.ops[0].op === 'new_process' && p.ops[0].args.steps.length >= 3
    && p.ops[0].args.ways.some((w) => w.when?.amount?.value === 5_000_000), p.ops[0]?.args)
  check('미리 보기 그림: 고친 뒤만(새 프로세스), 모두 더함', !p.before && p.after.tasks.every((t) => t.diff === 'add'), p.after.tasks.map((t) => `${t.key}:${t.diff}`))
  check('관리자는 적용할 수 있음', p.canApply === true)
  const mid = await graphCounts()
  check('적용 전에는 아무것도 바뀌지 않음(그래프 · 고친 기록 · 이름 기록)', JSON.stringify(mid) === JSON.stringify(before), { before, mid })
  const had = new Set((await G('MATCH (t:Task) RETURN t.key AS key')).map((r) => r.key))
  const a = await call(boss.tok, 'POST', '/ontology/edit/apply', { words: p.words, ops: p.ops })
  const key = a.proc.key
  made.procs.add(key)
  for (const s of p.ops[0].args.steps) if (!had.has(s.name)) made.tasks.add(s.name)
  a.applied.forEach((x) => made.corrections.add(x.id))
  OUT.said = { key, name: a.proc.name, applied: a.applied, newTasks: [...made.tasks] }; save()
  check('적용: said: 키의 프로세스 · 고친 기록 한 줄(새 프로세스)', key.startsWith('said:') && a.applied.length === 1 && a.applied[0].op === 'new_process', a)
  const m = await call(boss.tok, 'GET', '/ontology/map')
  const sp = m.processes.find((x) => x.key === key)
  check('지도에: 제안 단계 · 말로 정함 · 건 0', sp && sp.status === 'suggested' && sp.band === 'said' && sp.said === true && (sp.cases || 0) === 0, sp && { status: sp.status, band: sp.band, cases: sp.cases })
  const f = m.refined?.[key]
  check('지도가 그리는 흐름: 모든 길이 사람이 정한 길 · 아직 본 적 없음(n 0)', f && f.edges.length >= 4 && f.edges.every((e) => e.decided && e.unseen && e.n === 0), f?.edges?.map((e) => `${e.from}>${e.to}:${e.n}`))
  check('지도가 그리는 흐름: 단계는 말로 정함', f.tasks.every((t) => t.decided), f.tasks.map((t) => `${t.key}:${t.n}`))
  const row = (await q(`select source, why, batch from pro_corrections where id=$1`, [a.applied[0].id]))[0]
  check('고친 기록: source said · 까닭은 그 사람의 말', row.source === 'said' && row.why === WORDS_NEW && row.batch, row)
  const led = await n(`select count(*) n from pro_policy_decisions where tenant_id=$1 and action_kind='ontology.edit' and facts->>'proc'=$2`, [T, key])
  check('결정 원장에 한 줄', led === 1, String(led))

  // run it on the map engine, by hand, to the end
  const eng = await call(boss.tok, 'GET', '/ontology/engine')
  OUT.engineBefore = eng
  if (eng.engine !== 'map') await call(boss.tok, 'PUT', '/ontology/engine', { engine: 'map' })
  const defs0 = before.procDefs
  const start = p.ops[0].args.start
  const r = await call(boss.tok, 'POST', '/ontology/cases', { proc: key, entry: start, subject: SUBJECT, body: BODY, from: '김고객 <kim@buyer.example.com>', customer: '예시상사', kind: 'manual' })
  made.cases.add(r.caseId)
  OUT.cases.said = r.caseId
  check('손으로 시작: 지도에서 바로 · 인스턴스 하나 · 단계마다 사람이 정함(제안)', r.engine === 'map' && r.runMode === 'hitl', { engine: r.engine, runMode: r.runMode })
  const seen = []
  const until = Date.now() + 8 * 60_000
  for (;;) {
    const [c] = await q(`select status, instances from pro_po_cases where id=$1`, [r.caseId])
    if (c.status === 'done') break
    if (Date.now() > until) throw new Error(`시간 초과: 건이 끝나지 않음 (${seen.join(' → ')})`)
    const [w] = await q(`select s.id::text as id, s.task, s.message_id, s.preview from pro_case_steps s where s.case_id=$1 and s.state='waiting' order by s.created_at desc limit 1`, [r.caseId])
    if (w?.message_id) {
      const d = await call(boss.tok, 'POST', `/ontology/steps/${w.id}`, { action: 'go' })
      seen.push(`진행:${w.task}${d.sent ? '(보냈을 내용만)' : ''}`)
      await sleep(1500); continue
    }
    const [t] = await q(`select id::text as id, activity_name from todolist where proc_inst_id = any($1) and status::text='IN_PROGRESS' and (agent_orch is null or agent_mode is null) order by start_date limit 1`, [c.instances])
    if (t) {
      await call(boss.tok, 'POST', `/todos/${t.id}/submit`, { values: { result: `${t.activity_name}: 시험으로 냈어요(말로 고치기 e2e)` } })
      seen.push(`제출:${t.activity_name}`)
      await sleep(1500); continue
    }
    await sleep(2500)
  }
  const steps = await q(`select task, state, via from pro_case_steps where case_id=$1 order by created_at`, [r.caseId])
  OUT.saidRun = { seen, steps: steps.map((s) => `${s.task}:${s.state}${s.via?.how ? `(${s.via.how})` : ''}`) }; save()
  check('끝까지: 금액 620만 원 → 대표 승인을 거쳐 발송까지', steps.some((s) => /승인/.test(s.task) && s.via?.how === 'amount') && steps.length >= 3, OUT.saidRun.steps)
  const fl = await call(boss.tok, 'GET', `/ontology/cases/${r.caseId}/flow`)
  check('흐름도 BPMN 은 그때그때 만든다(남기지 않음)', typeof fl.bpmn === 'string' ? /bpmn/i.test(fl.bpmn) : !!fl.bpmn, typeof fl.bpmn)
  const [c1] = await q(`select instances, snapshots, engine from pro_po_cases where id=$1`, [r.caseId])
  check('proc_def 없음 · 인스턴스 하나', (await n(`select count(*) n from proc_def where tenant_id=$1`)) === defs0 && c1.instances.length === 1 && !c1.snapshots.length, { procDefs: await n(`select count(*) n from proc_def where tenant_id=$1`), defs0 })
  const m2 = await call(boss.tok, 'GET', '/ontology/map')
  note('건이 끝난 뒤 지도의 말로 만든 흐름(관찰 수는 다음 셈에서 같은 일에 쌓임)', m2.refined?.[key]?.edges?.map((e) => `${e.from}>${e.to}:${e.n}`))

  // change it by words inside a range: the approval step picked — what the words ask outside is not done
  const appr = f.tasks.find((t) => /승인/.test(t.key))?.key
  const p2 = await plan(boss, { proc: key, scope: { tasks: [appr], ways: [] }, words: `${appr}은 에이전트가 초안을 만들게 하고, 견적서 작성은 영업팀장이 맡게 해 줘` }, 'range')
  check('범위 안: 고른 단계의 하는 이 바꾸기만', p2.scope === 'range' && p2.ops.length >= 1 && p2.ops.every((o) => o.args.task === appr || touches(o, appr)), p2.ops.map((o) => o.label))
  check('범위 밖 요청은 하지 않음: 「범위 밖이라 하지 않았어요」', p2.refused.some((x) => x.why === '범위 밖이라 하지 않았어요'), p2.refused)
  const a2 = await call(boss.tok, 'POST', '/ontology/edit/apply', { proc: key, scope: p2.range, words: p2.words, ops: p2.ops })
  a2.applied.forEach((x) => made.corrections.add(x.id))
  const f2 = (await call(boss.tok, 'GET', '/ontology/map')).refined[key]
  const t2 = f2.tasks.find((t) => t.key === appr)
  check('지도: 고른 단계만 바뀜(에이전트)', t2.runner === 'agent' && f2.tasks.find((t) => /작성/.test(t.key))?.role !== '영업팀장', t2)
  const rv = await call(boss.tok, 'GET', `/ontology/refine/${encodeURIComponent(key)}`)
  const own = rv.corrections.find((c) => c.id === a2.applied[0].id)
  check('고친 기록에 「말로」 한 줄 · 새 프로세스 줄은 되돌릴 수 없음', own?.source === 'said' && own.undo === true && rv.corrections.find((c) => c.op === 'new_process')?.undo === false, rv.corrections.map((c) => `${c.op}:${c.source}:${c.undo}`))
  const no = await call(boss.tok, 'DELETE', `/ontology/refine/${encodeURIComponent(key)}/corrections/${rv.corrections.find((c) => c.op === 'new_process').id}`).catch((e) => e)
  check('새 프로세스 줄 되돌리기는 409(프로세스 지우기로)', no.status === 409, no.message)
  for (const x of a2.applied) await call(boss.tok, 'DELETE', `/ontology/refine/${encodeURIComponent(key)}/corrections/${x.id}`)
  const f3 = (await call(boss.tok, 'GET', '/ontology/map')).refined[key]
  check('되돌리기: 다시 사람이 하는 단계(말로 만들 때 정한 대로)', f3.tasks.find((t) => t.key === appr).runner !== 'agent', f3.tasks.find((t) => t.key === appr))

  // remove the process made by words
  const del = await call(boss.tok, 'DELETE', `/ontology/said/${encodeURIComponent(key)}`)
  const m4 = await call(boss.tok, 'GET', '/ontology/map')
  check('지우기: 지도에서 빠짐 · 고친 기록도', del.removed === key && !m4.processes.some((x) => x.key === key) && !(await n(`select count(*) n from pro_corrections where tenant_id=$1 and proc_key=$2`, [T, key])), del)
}
const touches = (o, k) => JSON.stringify(o.args).includes(k)

// ---------- (e) 의견 · 상충 · 해소 ----------
async function phaseE(boss) {
  log('— (e) 의견: 서로 어긋나는 두 의견 → 해소 필요 → 관리자가 하나를 골라 적용')
  const had = (await q(`select id::text as id from users where tenant_id=$1 and email=$2`, [T, MATE.email]))[0]
  const m0 = await call(boss.tok, 'POST', '/team', { email: MATE.email, name: MATE.name })
  made.mate = m0.id || had?.id; made.mateCreated = !had
  const mate = await signIn(MATE.email)
  made.mate = mate.id
  const step = '강의자료 준비'
  const pa = await plan(boss, { proc: LECTURE, scope: { tasks: [step], ways: [] }, words: `${step}는 에이전트가 하게 해 줘` }, 'opinionBoss')
  const pb = await plan(mate, { proc: LECTURE, scope: { tasks: [step], ways: [] }, words: `${step}는 사람이 직접 하는 게 좋겠어요` }, 'opinionMate')
  check('동료의 미리 보기: 적용은 못 하고 의견으로는 남길 수 있음', pb.canApply === false && pb.canVoice === true && /관리자/.test(pb.whyNot), pb.whyNot)
  const runnerOps = (p, want) => p.ops.filter((o) => o.op === 'set_runner' && o.args.runner === want)
  // (the model may or may not say 「사람이 직접」 as an operation: when it does not, the opinion is the person's runner by hand — noted)
  let opsB = runnerOps(pb, 'person')
  if (!opsB.length) { note('모델이 「사람이 직접」을 동작으로 옮기지 않아 의견의 동작을 손으로 적음', pb.ops.map((o) => o.label)); opsB = [{ op: 'set_runner', args: { task: step, runner: 'person' } }] }
  check('주인의 말: 에이전트가 하게', runnerOps(pa, 'agent').length === 1, pa.ops.map((o) => o.label))
  const va = await call(boss.tok, 'POST', '/ontology/opinions', { proc: LECTURE, scope: pa.range, words: pa.words, ops: pa.ops, source: 'map' })
  const vb = await call(mate.tok, 'POST', '/ontology/opinions', { proc: LECTURE, scope: pb.range, words: pb.words, ops: opsB, source: 'step', task: step })
  const vb2 = await call(mate.tok, 'POST', '/ontology/opinions', { proc: LECTURE, scope: pb.range, words: `${pb.words}(다시 말함)`, ops: opsB, source: 'map' })
  check('같은 사람이 같은 동작을 또 말하면 새 행이 아님', vb2.opinion.id === vb.opinion.id && vb2.again === true, { a: vb.opinion.id, b: vb2.opinion.id })
  const nOp = await n(`select count(*) n from pro_map_opinions where tenant_id=$1 and proc_key=$2 and state='open'`, [T, LECTURE])
  check('의견은 아무것도 바꾸지 않음(고친 기록 0)', !(await n(`select count(*) n from pro_corrections where tenant_id=$1 and proc_key=$2`, [T, LECTURE])) && nOp === 2, String(nOp))
  const view = await call(boss.tok, 'GET', `/ontology/processes/${encodeURIComponent(LECTURE)}/opinions`)
  OUT.opinions = { conflicts: view.conflicts.map((c) => ({ kinds: c.kinds, why: c.why, who: c.opinions.map((o) => `${o.who.name}: ${o.words}`) })), marks: view.marks }; save()
  check('상충 하나: 같은 단계를 누가 할지가 서로 다름', view.conflicts.length === 1 && view.conflicts[0].opinions.length === 2 && view.conflicts[0].kinds.includes('하는 이'), OUT.opinions.conflicts)
  check('지도 표시: 그 단계에 「해소 필요」', view.marks.tasks[step]?.conflict === true && view.marks.tasks[step].n === 2, view.marks.tasks[step])
  const mp = (await call(boss.tok, 'GET', '/ontology/map')).processes.find((x) => x.key === LECTURE)
  check('프로세스 칩: 상충 1 · 의견 2', mp.opinions?.conflicts === 1 && mp.opinions.open === 2, mp.opinions)
  const deny = await call(mate.tok, 'POST', `/ontology/processes/${encodeURIComponent(LECTURE)}/opinions/resolve`, { action: 'apply', opinion: vb.opinion.id, opinions: [va.opinion.id, vb.opinion.id], note: '' }).catch((e) => e)
  const deny2 = await call(mate.tok, 'POST', '/ontology/edit/apply', { proc: LECTURE, scope: pb.range, words: pb.words, ops: opsB }).catch((e) => e)
  check('동료는 해소 · 적용을 못 함(403)', deny.status === 403 && deny2.status === 403, `${deny.status} ${deny2.status}`)
  const notes0 = await n(`select count(*) n from notifications where tenant_id=$1 and user_id=$2`, [T, mate.id])
  const res = await call(boss.tok, 'POST', `/ontology/processes/${encodeURIComponent(LECTURE)}/opinions/resolve`, { action: 'apply', opinion: vb.opinion.id, opinions: [va.opinion.id, vb.opinion.id], note: '자료는 사람이 직접 만들어요(e2e)' })
  check('해소: 상충이 없어짐', res.conflicts.length === 0 && res.closed.some((o) => o.id === vb.opinion.id && o.state === 'applied') && res.closed.some((o) => o.id === va.opinion.id && o.state === 'superseded'),
    res.closed.map((o) => `${o.who.name}:${o.state}`))
  const cs = await q(`select id::text as id, op, args, source, opinion_id::text as opinion_id, why from pro_corrections where tenant_id=$1 and proc_key=$2`, [T, LECTURE])
  cs.forEach((c) => made.corrections.add(c.id))
  check('고른 의견이 고친 기록으로(까닭 = 그 말 + 정한 사람의 한 줄)', cs.length === 1 && cs[0].opinion_id === vb.opinion.id && cs[0].why.includes('직접'), cs)
  const rv = await call(boss.tok, 'GET', `/ontology/refine/${encodeURIComponent(LECTURE)}`)
  check('고친 기록에 누구의 의견인지', rv.corrections[0]?.voiced?.name === MATE.name, rv.corrections[0]?.voiced)
  const notes1 = await n(`select count(*) n from notifications where tenant_id=$1 and user_id=$2`, [T, mate.id])
  const chip = await n(`select count(*) n from pro_messages m join pro_threads t on t.id=m.thread_id where t.user_id=$1 and m.kind='chip' and m.content->>'opinion'=$2`, [mate.id, vb.opinion.id])
  check('동료에게 알림 · 채팅 칩', notes1 === notes0 + 1 && chip === 1, { notes0, notes1, chip })
  const led = await n(`select count(*) n from pro_policy_decisions where tenant_id=$1 and action_kind='ontology.opinion' and created_at >= $2`, [T, START])
  check('해소마다 원장에', led >= 2, String(led))
  await call(boss.tok, 'DELETE', `/ontology/refine/${encodeURIComponent(LECTURE)}/corrections/${cs[0].id}`)
  const st = (await q(`select state from pro_map_opinions where id=$1`, [vb.opinion.id]))[0].state
  check('되돌려도 의견은 다시 열리지 않음', st === 'applied', st)
}

// ---------- (c) 채팅 카드 ----------
async function phaseC(boss) {
  log('— (c) 채팅: 초안 카드의 「지도에 넣기」 · 「○○ 프로세스에서 …」 카드')
  const [th] = await q(`insert into pro_threads (user_id, kind, title) values ($1, 'chat', $2) returning id`, [boss.id, '말로 고치기 시험(e2e)'])
  made.threads.add(th.id)
  const contract = { type: 'process-definition-result', processDefinition: { processDefinitionName: '비품 구매 요청(시험)', description: '요청 → 팀장 승인 → 구매', elements: [
    { elementType: 'Event', id: 'start', name: '요청 도착', type: 'StartEvent' },
    { elementType: 'Activity', id: 'a1', name: '구매 요청서 작성', role: '요청자' },
    { elementType: 'Activity', id: 'a2', name: '팀장 승인', role: '팀장' },
    { elementType: 'Activity', id: 'a3', name: '비품 주문', role: '총무' },
    { elementType: 'Event', id: 'end', name: '끝', type: 'EndEvent' },
    { elementType: 'Sequence', source: 'start', target: 'a1' }, { elementType: 'Sequence', source: 'a1', target: 'a2' }, { elementType: 'Sequence', source: 'a2', target: 'a3' }, { elementType: 'Sequence', source: 'a3', target: 'end' },
  ], roles: [{ name: '요청자' }, { name: '팀장' }, { name: '총무' }] }, forms: [], agents: [], skills: [] }
  const [m] = await q(`insert into pro_messages (thread_id, role, kind, content) values ($1, 'agent', 'process_draft', $2) returning id::text as id`, [th.id, { contract, state: 'draft' }])
  made.messages.add(m.id)
  const had = new Set((await G('MATCH (t:Task) RETURN t.key AS key')).map((r) => r.key))
  const p = await call(boss.tok, 'POST', `/ontology/edit/from-draft/${m.id}`)
  OUT.plans.draft = { ops: p.ops.map((o) => o.label), matched: p.matched, refused: p.refused }
  check('초안 → 새 프로세스 미리 보기(생성기의 계약 그대로, 모델 없이)', p.scope === 'new' && p.ops[0]?.op === 'new_process' && p.ops[0].args.steps.length === 3, p.ops)
  const kept = (await q(`select content from pro_messages where id=$1`, [m.id]))[0].content
  check('카드에 미리 보기가 남음(mapPlan)', !!kept.mapPlan?.ops?.length)
  const a = await call(boss.tok, 'POST', '/ontology/edit/apply', { words: p.words, ops: p.ops, messageId: m.id })
  made.procs.add(a.proc.key); a.applied.forEach((x) => made.corrections.add(x.id))
  for (const s of p.ops[0].args.steps) if (!had.has(s.name)) made.tasks.add(s.name)
  const kept2 = (await q(`select content from pro_messages where id=$1`, [m.id]))[0].content
  check('카드: 지도에 넣음(mapApplied) · 지도에 제안으로', kept2.mapApplied?.proc?.key === a.proc.key && (await call(boss.tok, 'GET', '/ontology/map')).processes.some((x) => x.key === a.proc.key && x.status === 'suggested'))
  await call(boss.tok, 'DELETE', `/ontology/said/${encodeURIComponent(a.proc.key)}`)
  // «강의 프로세스에서 …» (the router's edit_map → editmap.chatEdit, called here the way agent.js does — the router itself is not run: its
  // other branch hands the words to the deep agent, which has the real mailbox's tools)
  const card = await withTenant(T, async () => (await import('../lib/ontology/editmap.js')).chatEdit({ user: { id: boss.id, email: BOSS }, threadId: th.id, query: '강의계획서 작성 · 보고 프로세스에서 강의 계획 공유는 빼 줘' }))
  made.messages.add(card.id)
  const ready = await waitFor('채팅 카드의 미리 보기', async () => { const c = (await q(`select content from pro_messages where id=$1`, [card.id]))[0].content; return ['preview', 'failed'].includes(c.state) ? c : null }, { timeout: 240_000 })
  OUT.plans.chat = { state: ready.state, ops: ready.plan?.ops?.map((o) => o.label), proc: ready.proc }
  check('채팅 카드: 그 프로세스의 미리 보기(빼기)', ready.state === 'preview' && ready.proc.key === LECTURE && ready.plan.ops.some((o) => o.op === 'remove_task'), OUT.plans.chat)
  const stop = await call(boss.tok, 'POST', `/ontology/edit/chat/${card.id}`, { action: 'stop' })
  check('그만두기: 지도는 그대로', stop.state === 'stopped' && !(await n(`select count(*) n from pro_corrections where tenant_id=$1 and proc_key=$2`, [T, LECTURE])))
}

// ---------- cleanup ----------
async function cleanup(boss) {
  const done = {}
  const ids = [...made.cases]
  const cases = ids.length ? await q(`select id::text as id, instances from pro_po_cases where id::text = any($1)`, [ids]) : []
  const insts = cases.flatMap((c) => c.instances)
  const todos = insts.length ? (await q(`select id::text as id from todolist where proc_inst_id = any($1)`, [insts])).map((r) => r.id) : []
  const steps = ids.length ? (await q(`select id::text as id from pro_case_steps where case_id::text = any($1)`, [ids])).map((r) => r.id) : []
  const people = [boss?.id, made.mate].filter(Boolean)
  done.cards = (await q(`delete from pro_messages m using pro_threads t where t.id=m.thread_id and t.user_id::text = any($1) and m.created_at >= $2 and (
      m.id::text = any($3) or m.content->>'caseId' = any($4) or m.content->>'instId' = any($5) or m.content->>'todoId' = any($6) or m.content->>'stepId' = any($7)) returning m.id`,
  [people, START, [...made.messages], ids, insts, todos, steps])).length
  const th = [...made.threads, ...(insts.length ? (await q(`select id from pro_threads where ref = any($1)`, [insts])).map((r) => r.id) : [])]
  if (th.length) { await q(`delete from pro_messages where thread_id = any($1)`, [th]); done.threads = (await q(`delete from pro_threads where id = any($1) returning 1`, [th])).length }
  if (ids.length) {
    done.steps = (await q(`delete from pro_case_steps where case_id::text = any($1) returning 1`, [ids])).length
    await q(`delete from pro_case_runs where case_id::text = any($1)`, [ids])
    await q(`delete from handover_events where tenant_id=$1 and case_id = any($2)`, [T, ids.map((x) => `onto:${x}`)])
  }
  if (insts.length) {
    for (const t of ['events', 'todolist_status_history', 'task_execution_properties', 'proc_inst_source', 'pro_step_retries', 'llm_call_log', 'mcp_call_log', 'trace_payload']) await q(`delete from ${t} where proc_inst_id = any($1)`, [insts]).catch(() => {})
    done.todos = (await q(`delete from todolist where proc_inst_id = any($1) returning 1`, [insts])).length
    done.instances = (await q(`delete from bpm_proc_inst where proc_inst_id = any($1) returning 1`, [insts])).length
  }
  if (ids.length) done.cases = (await q(`delete from pro_po_cases where id::text = any($1) returning 1`, [ids])).length
  // the owner's notifications this test's work items made (the todolist trigger), the mate's below
  if (todos.length || insts.length) done.ownerNotes = (await q(`delete from notifications where tenant_id=$1 and time_stamp >= $2 and not (id::text = any($3)) and (url like any($4) or description like any($4))
      returning 1`, [T, START, [...made.notesBefore], [...todos, ...insts].map((x) => `%${x}%`)])).length
  // the processes made by words: graph nodes and their own new tasks (hard delete — the test leaves no history behind), their rows
  for (const key of made.procs) {
    await G('MATCH (b:Process {key:$key}) DETACH DELETE b', { key }).catch((e) => log('  process node', e.message))
    await q(`delete from pro_corrections where tenant_id=$1 and proc_key=$2`, [T, key])
    await q(`delete from pro_step_requirements where tenant_id=$1 and proc_key=$2`, [T, key])
    await q(`delete from pro_edge_conditions where tenant_id=$1 and proc_key=$2`, [T, key])
    await q(`delete from pro_map_opinions where tenant_id=$1 and proc_key=$2`, [T, key])
  }
  done.procs = made.procs.size
  for (const k of made.tasks) await G('MATCH (t:Task {key:$key}) WHERE t.kind = $said DETACH DELETE t', { key: k, said: 'said' }).catch((e) => log('  task node', e.message))
  done.tasks = made.tasks.size
  done.corrections = (await q(`delete from pro_corrections where tenant_id=$1 and id::text = any($2) returning 1`, [T, [...made.corrections]])).length
  done.opinions = (await q(`delete from pro_map_opinions where tenant_id=$1 and created_at >= $2 returning 1`, [T, START])).length
  done.ledger = (await q(`delete from pro_policy_decisions where tenant_id=$1 and created_at >= $2 and (action_kind in ('ontology.edit', 'ontology.opinion', 'ontology.engine')
      or (action_kind = 'ontology.refine' and (facts->>'proc' = any($3) or facts->>'proc' = $4)) or (action_kind like 'ontology.run.%' and facts->>'case' = any($5)) or (action_kind like 'team.%' and facts::text like '%editmap-e2e%')) returning 1`,
  [T, START, [...made.procs], LECTURE, ids])).length
  // the engine as it was
  if (OUT.engineBefore && boss) await call(boss.tok, 'PUT', '/ontology/engine', { engine: OUT.engineBefore.from === 'tenant' ? OUT.engineBefore.engine : null }).catch((e) => log('  engine', e.message))
  await q(`delete from pro_policy_decisions where tenant_id=$1 and created_at >= $2 and action_kind='ontology.engine'`, [T, START])
  // the test colleague (only when this test made the account)
  if (made.mate && made.mateCreated) {
    const u = made.mate
    await q(`delete from notifications where tenant_id=$1 and (user_id=$2 or user_id like '%'||$2||'%')`, [T, u]).catch(() => {})
    const ths = (await q(`select id from pro_threads where user_id=$1`, [u])).map((r) => r.id)
    if (ths.length) { await q(`delete from pro_messages where thread_id = any($1)`, [ths]); await q(`delete from pro_threads where id = any($1)`, [ths]) }
    for (const t of ['pro_team_members', 'pro_team_removed', 'pro_role_members', 'pro_role_assignments']) await q(`delete from ${t} where tenant_id=$1 and user_id::text=$2`, [T, u]).catch(() => {})
    await q(`delete from pro_profile where user_id=$1`, [u]).catch(() => {})
    await q(`delete from users where id=$1 and email=$2`, [u, MATE.email])
    const { error } = await admin.auth.admin.deleteUser(u)
    done.mate = error ? `계정 지우기 실패: ${error.message}` : 'deleted'
  }
  return done
}

let boss = null
try {
  boss = await signIn(BOSS)
  made.notesBefore = new Set((await q(`select id::text as id from notifications where tenant_id=$1`, [T])).map((r) => r.id))
  OUT.before = await graphCounts()
  if (phases.has('n')) await phaseN(boss)
  if (phases.has('e')) await phaseE(boss)
  if (phases.has('c')) await phaseC(boss)
  OUT.ok = true
} catch (e) {
  OUT.ok = false; OUT.error = e.message
  console.error(e)
} finally {
  if (!keep) OUT.cleanup = await cleanup(boss).catch((e) => ({ error: e.message }))
  OUT.after = await graphCounts().catch(() => null)
  OUT.finishedAt = new Date().toISOString()
  save()
  log('끝', OUT.ok ? '통과' : '실패', `· 확인 ${OUT.checks.filter((c) => c.ok).length}개`, '· 정리', JSON.stringify(OUT.cleanup), '·', OUTFILE)
  await closeOntology()
  process.exit(OUT.ok ? 0 : 1)
}
