// HTTP routes for the process ontology (spec pgpt-pro_process-ontology): read the mail history, draw the company's
// process map, run from wherever a case comes in, and look after the map (pin · retire · revive).
import express from 'express'
import * as S from '../lib/ontology/service.js'
import * as R from '../lib/ontology/run.js'
import * as D from '../lib/ontology/taskdef.js'
import * as V from '../lib/ontology/review.js'
import * as RL from '../lib/ontology/roles.js'
import * as W from '../lib/ontology/ways.js'
import * as TM from '../lib/ontology/timers.js'
import * as DOC from '../lib/ontology/documents.js'
import { cypher, cypherTimer } from '../lib/ontology/store.js'
import { diag } from '../lib/ontology/diag.js'
import { q } from '../lib/supa.js'
import { updateMessage } from '../lib/store.js'
import { config } from '../config.js'
import { formRoutes } from './ontologyForms.js'

export function ontologyRoutes(auth) {
  const r = express.Router()
  // Server-Timing: how many Cypher statements the route ran and their time, and the route's own time (the map's latency
  // is read in the browser's network panel, ontology diag)
  const h = (fn) => async (req, res) => {
    const t = { n: 0, ms: 0 }, t0 = performance.now()
    try {
      const body = await cypherTimer.run(t, () => fn(req))
      if (!res.headersSent) res.set('Server-Timing', `onto;desc="cypher x${t.n}";dur=${t.ms.toFixed(1)}, app;dur=${(performance.now() - t0).toFixed(1)}`)
      res.json(body)
    } catch (e) {
      if (!e.status) console.warn('[ontology]', req.method, req.path, e.message)
      res.status(e.status || 500).json({ error: e.status ? e.message : '처리하지 못했어요.' })
    }
  }
  const admin = async (req) => { if (!(await S.isAdmin(req.user))) throw S.err(403, '관리자만 할 수 있어요.') }
  const num = (v) => (v === undefined || v === null || v === '' ? undefined : Number(v))
  // a card's choice is kept on its message (every screen of that person sees the same card), only on their own message
  const keepOnCard = async (me, messageId, content) => {
    if (!messageId) return
    const [m] = await q(`select m.id from pro_messages m join pro_threads t on t.id=m.thread_id where m.id=$1 and t.user_id=$2`, [messageId, me.id])
    if (m) await updateMessage(me.id, messageId, content)
  }

  // 지도
  r.get('/ontology/status', auth, h((req) => S.status(req.user)))
  // where the map's time goes, from inside the server pod (administrators): ?n=20&map=3&write=1
  r.get('/ontology/diag', auth, h(async (req) => {
    await admin(req)
    return diag({ n: num(req.query.n), mapRuns: num(req.query.map) ?? 3, write: req.query.write === '1' })
  }))
  r.post('/ontology/mail-history', auth, h((req) => S.readMailAndBuild(req.user, { days: Math.min(180, Math.max(7, Number(req.body?.days) || 90)) })))
  r.get('/ontology/jobs/:id', auth, h((req) => S.job(req.params.id)))
  // 규정 · 업무 정의서(design-v0.3 §17): 파일 그대로 올리면 process-gpt 의 문서 읽기로 절차를 뽑아 지도 곁에 둔다
  // the same upload takes a chat export (카카오톡 대화 내보내기 CSV · TXT, design-v0.3 §21): its messages are read like mail
  r.post('/ontology/documents', express.raw({ type: () => true, limit: '60mb' }), auth, h(async (req) => {
    const name = decodeURIComponent(String(req.headers['x-file-name'] || 'document.txt'))
    const C = await import('../lib/ontology/chatlog.js')
    return C.isChatExport(name, req.body) ? C.startChatHistory(req.user, { name, buf: req.body }) : DOC.startDocument(req.user, { name, buf: req.body })
  }))
  r.get('/ontology/documents', auth, h(() => DOC.documents()))
  r.post('/ontology/build', auth, h(async (req) => { await admin(req); return S.startBuild(req.user) }))
  r.get('/ontology/map', auth, h((req) => S.map({ validAt: req.query.at || undefined, systemAt: req.query.system || undefined })))
  r.get('/ontology/labels', auth, h(() => S.labels()))
  // 흐름 분석(flowload.js): 일마다 지금 쌓인 할 일(지도 엔진 · 스냅샷 건의 todolist 행) · 걸린 시간 · 병목 · 흔한 길 · 회사의 제약(역할) — 보기는 누구나,
  // 열린 할 일의 건 제목 · 맡은 사람은 관리자만
  r.get('/ontology/flow', auth, h(async (req) => (await import('../lib/ontology/flowload.js')).flowView(req.user, { proc: String(req.query.proc || ''), validAt: req.query.at || undefined })))
  // 고쳐 보기 · 개선안(flowplan.js · improveplans.js, 설계 §5): 계산은 누구나, 안은 누구나 만들고 합의에 올림, 정하기 · 하지 않기는 관리자
  const IP = () => import('../lib/ontology/improveplans.js')
  r.post('/ontology/flow/whatif', auth, h(async (req) => (await import('../lib/ontology/flowload.js')).whatIfView(req.user, { proc: String(req.body?.proc || ''), levers: Array.isArray(req.body?.levers) ? req.body.levers : [] })))
  r.get('/ontology/flow/people', auth, h(async (req) => (await IP()).peopleFor(req.user, String(req.query.role || ''))))
  r.get('/ontology/plans', auth, h(async (req) => (await IP()).listPlans(req.user, String(req.query.proc || ''))))
  r.post('/ontology/plans', auth, h(async (req) => (await IP()).savePlan(req.user, { proc: String(req.body?.proc || ''), name: String(req.body?.name || ''), levers: Array.isArray(req.body?.levers) ? req.body.levers : [], words: String(req.body?.words || '') })))
  r.get('/ontology/plans/:id', auth, h(async (req) => (await IP()).getPlan(req.user, req.params.id)))
  r.delete('/ontology/plans/:id', auth, h(async (req) => (await IP()).removePlan(req.user, req.params.id)))
  r.post('/ontology/plans/:id/vote', auth, h(async (req) => (await IP()).votePlan(req.user, req.params.id)))
  r.post('/ontology/plans/:id/agree', auth, h(async (req) => (await IP()).agreePlan(req.user, req.params.id)))
  r.post('/ontology/plans/:id/decide', auth, h(async (req) => (await IP()).decidePlan(req.user, req.params.id, { note: String(req.body?.note || '') })))
  r.post('/ontology/plans/:id/decline', auth, h(async (req) => (await IP()).declinePlan(req.user, req.params.id, { note: String(req.body?.note || '') })))
  r.get('/ontology/plans/:id/review', auth, h(async (req) => (await IP()).reviewPlan(req.user, req.params.id)))
  // 개인 습관을 지도에 보이는 기준(관리자가 정하고, 보기는 누구나)
  r.get('/ontology/settings', auth, h(() => S.habitSettings()))
  r.put('/ontology/settings', auth, h(async (req) => { await admin(req); return S.setHabitSettings(req.user, { mode: String(req.body?.mode || ''), min: req.body?.min }) }))

  // 프로세스 채택(관리자): 채택한 프로세스만 들어오는 메일을 받는다. 단계는 건의 실행 방식도 정한다(runmode.js modeOfStage — 제안:
  // 단계마다 사람이 정함 · 자동: 사람이 지켜봄). 건은 시작할 때의 방식을 지니므로(pro_po_cases.run_mode) 바꿔도 진행 중인 건은 그대로 —
  // 새 건부터 바뀐다(running: 그대로 가는 진행 중인 건 수, 화면이 알려 준다)
  r.post('/ontology/processes/status', auth, h(async (req) => {
    await admin(req)
    const status = String(req.body?.status || '')
    if (!['adopted', 'paused', 'suggested'].includes(status)) throw S.err(400, 'status 는 adopted · paused · suggested 예요.')
    const rows = await cypher('MATCH (b:Process {key:$key}) SET b.status=$status, b.owner=$owner RETURN b.key AS key, b.status AS status',
      { key: String(req.body?.key || ''), status, owner: req.user.email || '' }, { actor: req.user.email, reason: `프로세스 ${status === 'adopted' ? '자동으로 승격' : status === 'suggested' ? '제안으로' : '관찰로'}` })
    if (!rows.length) throw S.err(404, '프로세스를 찾지 못했어요.')
    // 조직이 정한 일(design-v0.3 §12): 승격은 결정 원장에 남는다
    await V.ledger(req.user, status === 'adopted' ? 'ontology.promote' : 'ontology.demote', `${status === 'adopted' ? '자동으로 승격' : status === 'suggested' ? '제안으로' : '관찰로'}: ${req.body?.name || rows[0].key}`, { process: rows[0].key, status })
    const [run] = await q(`select count(*)::int as n from pro_po_cases where tenant_id=$1 and bundle=$2 and status='running'`, [config.tenantId, rows[0].key]).catch(() => [])
    return { ...rows[0], running: run?.n || 0 }
  }))

  // 스냅샷 · 시작 일 · 건
  r.get('/ontology/snapshot', auth, h((req) => R.snapshot({ procKey: String(req.query.proc || ''), entry: String(req.query.entry || ''), theta: num(req.query.theta), validAt: req.query.at || undefined })))
  r.post('/ontology/entry', auth, h((req) => R.chooseEntry({ subject: req.body?.subject, text: req.body?.text, procKey: req.body?.proc })))
  r.post('/ontology/cases', auth, h(async (req) => {
    const r2 = await R.startCase(req.user, { procKey: String(req.body?.proc || ''), entry: String(req.body?.entry || ''), subject: req.body?.subject || '',
      body: req.body?.body || '', from: req.body?.from || '', customer: req.body?.customer || '', odds: req.body?.odds || null, kind: req.body?.kind || 'manual',
      file: req.body?.file?.name ? { name: String(req.body.file.name).slice(0, 200) } : null,
      // who does each role, as the person left it on the ask card before 진행 (bindings.js — a role nobody could be found for must be chosen)
      picks: (Array.isArray(req.body?.picks) ? req.body.picks : []).filter((p) => p?.role && p?.userId).slice(0, 30).map((p) => ({ role: String(p.role).slice(0, 120), userId: String(p.userId) })) })
    await keepOnCard(req.user, req.body?.messageId, { state: 'started', picked: true, choice: req.body?.odds || null, caseId: r2.caseId, instId: r2.instId,
      skipped: r2.snapshot.skipped, nodes: r2.snapshot.nodes, procDefId: r2.snapshot.procDefId, bindings: r2.bindings || null })
    return r2
  }))
  r.get('/ontology/cases', auth, h(() => q(`select id, bundle as proc, entry_task, trigger, status, instances, history, engine, map_pin, created_at from pro_po_cases where tenant_id=$1 order by created_at desc limit 30`, [config.tenantId])))
  r.get('/ontology/cases/:id', auth, h(async (req) => {
    const c = await R.getCase(req.params.id)
    // who does each role, as the case view shows it (bindings.js)
    return { ...c, bindings: (await import('../lib/ontology/bindings.js')).bindingsView(Array.isArray(c.bindings) ? c.bindings : []) }
  }))
  // 지도에서 바로 실행(mapengine.js): 실행 방식의 엔진(보기는 누구나, 바꾸기는 관리자) · 건의 흐름도(지금 지도 · 고정했으면 시작한 날의 지도로
  // 그때그때 그린다, 남기지 않음) · 건마다 지도 고정(관리자)
  const ME = () => import('../lib/ontology/mapengine.js')
  r.get('/ontology/engine', auth, h(async (req) => (await ME()).engineView(req.user)))
  r.put('/ontology/engine', auth, h(async (req) => { await admin(req); return (await ME()).setEngine(req.user, req.body?.engine ? String(req.body.engine) : null) }))
  r.get('/ontology/cases/:id/flow', auth, h(async (req) => (await ME()).flowOf(req.params.id)))
  // 역할마다 맡을 사람(bindings.js): 시작하기 전(묻는 카드)에 이 프로세스를 그 일부터 시작하면 누가 맡는지 · 고를 수 있는 회사 사람 · 진행 중인 건에서
  // 바꾸기(그 역할의 끝나지 않은 단계만 — 회사 설정은 그대로)
  r.get('/ontology/start-bindings', auth, h(async (req) => {
    const view = await R.procGraph(String(req.query.proc || ''))
    const entry = String(req.query.entry || '')
    if (!view.tasks.has(entry)) throw S.err(400, '그 일은 이 프로세스에 없어요.')
    const B = await import('../lib/ontology/bindings.js')
    return { proc: view.proc.key, entry, stage: view.proc.status || null, bindings: B.bindingsView(await B.resolveBindings(view, entry, { starter: req.user.id })) }
  }))
  r.get('/ontology/people', auth, h(() => q(`select u.id::text as id, coalesce(nullif(u.username,''), u.email) as name, u.email,
      exists (select 1 from pro_team_members m where m.tenant_id=u.tenant_id and m.user_id=u.id) as team
    from users u where u.tenant_id=$1 and not coalesce(u.is_agent,false) order by 4 desc, 2 limit 200`, [config.tenantId])))
  r.put('/ontology/cases/:id/bindings', auth, h(async (req) => (await ME()).setBinding(req.user, req.params.id, { role: String(req.body?.role || ''), userId: String(req.body?.userId || '') })))
  r.put('/ontology/cases/:id/map-pin', auth, h(async (req) => { await admin(req); return (await ME()).setPin(req.user, req.params.id, req.body?.pin === true) }))
  // 채팅에 올린 파일도 사건이다(events.js onFile): 채팅 메시지와 함께 오면 서버가 보고(lib/agent.js), 여기로는 이미 올린 첨부(POST /api/attachments 의
  // path)를 다시 보낼 수 있다 — 자기 첨부만. 묻기만 하고 저절로 시작하지 않는다.
  r.post('/ontology/events/file', auth, h(async (req) => {
    const own = `/workspace/uploads/${req.user.id}/`
    const files = (Array.isArray(req.body?.files) ? req.body.files : []).filter((f) => f?.name && String(f.path || '').startsWith(own) && !String(f.path).includes('..')).slice(0, 5)
    if (!files.length) throw S.err(400, '올린 파일(path)이 없어요 — 먼저 /api/attachments 로 올려 주세요.')
    const { getThread } = await import('../lib/store.js')
    const threadId = req.body?.threadId && (await getThread(req.user.id, String(req.body.threadId)).catch(() => null)) ? String(req.body.threadId) : null
    return (await import('../lib/ontology/events.js')).onFile({ user: req.user, threadId, files, said: String(req.body?.text || '').slice(0, 2000) }) || { none: true }
  }))
  r.post('/ontology/cases/:id/move', auth, h(async (req) => {
    // a move that passes a 꼭 하는 단계 only says so until the person confirms with a reason (steprule.js)
    const pass = await SR().then((m) => m.guardMove(req.user, req.params.id, { task: String(req.body?.task || ''), confirm: req.body?.confirm === true, reason: String(req.body?.reason || '') }))
    if (pass) return pass
    const r2 = await R.moveCase(req.user, req.params.id, { task: String(req.body?.task || ''), reason: req.body?.reason || '' })
    await keepOnCard(req.user, req.body?.messageId, { movedTo: req.body?.task, instId: r2.instId, skipped: r2.snapshot.skipped, nodes: r2.snapshot.nodes, procDefId: r2.snapshot.procDefId })
    return r2
  }))
  r.get('/ontology/cases/:id/habit', auth, h((req) => R.habitFor(req.params.id)))
  r.post('/ontology/cases/:id/habit', auth, h(async (req) => {
    const r2 = await R.answerHabit(req.user, req.params.id, req.body || {})
    await keepOnCard(req.user, req.body?.messageId, { answered: { to: req.body?.to, accepted: !!req.body?.accepted, moved: !!r2.moved } })
    return r2
  }))

  // 실행 방식(runmode.js): 사람이 지켜봄 · 단계마다 사람이 정함 — 따로 고르지 않는다: 프로세스의 단계(위 /ontology/processes/status 의
  // 제안 · 자동)가 정하고, 건은 시작할 때의 방식을 지닌다. 보기(단계가 주는 방식)는 누구나. 예전의 방식 바꾸기(회사 기본값 · 프로세스마다)는
  // 410 — 남은 pro_run_modes · default_mode 행은 읽지 않는다. 건 지켜보기 · 멈추기 · 이어 가기 · 이 단계로 되감기 · 기다리는 단계 정하기
  // (진행 · 다른 갈래 · 멈추기)는 건을 맡은 사람이나 관리자
  const RM = () => import('../lib/ontology/runmode.js')
  const SR = () => import('../lib/ontology/steprule.js')
  const EC = () => import('../lib/ontology/edgecond.js')
  const noModeSwitch = h(async () => { throw S.err(410, '실행 방식은 따로 고르지 않아요 — 프로세스의 단계가 정해요(제안: 단계마다 사람이 정함 · 자동: 사람이 지켜봄). 지도의 「관찰 · 제안 · 자동」에서 바꿔 주세요.') })
  r.get('/ontology/run-mode', auth, h(async () => (await RM()).modesView()))
  r.put('/ontology/run-mode', auth, noModeSwitch)
  r.post('/ontology/processes/run-mode', auth, noModeSwitch)
  r.get('/ontology/processes/steps', auth, h(async (req) => {
    const M = await RM(), key = String(req.query.key || '')
    return { key, ...(await M.modeOf(key)), steps: [...(await M.stepFacts(key)).values()] }
  }))
  r.post('/ontology/processes/step-rule', auth, h(async (req) => { await admin(req); return (await RM()).setStepPolicy(req.user, String(req.body?.key || ''), String(req.body?.task || ''), req.body?.policy ? String(req.body.policy) : null) }))
  r.get('/ontology/cases/:id/run', auth, h(async (req) => (await RM()).runView(req.user, req.params.id)))
  r.post('/ontology/cases/:id/pause', auth, h(async (req) => (await RM()).pauseCase(req.user, req.params.id)))
  r.post('/ontology/cases/:id/resume', auth, h(async (req) => (await RM()).resumeCase(req.user, req.params.id)))
  r.post('/ontology/cases/:id/rewind', auth, h(async (req) => (await RM()).rewindCase(req.user, req.params.id, { task: String(req.body?.task || ''), confirm: req.body?.confirm === true })))
  r.post('/ontology/steps/:id', auth, h(async (req) => (await RM()).decide(req.user, req.params.id, { action: String(req.body?.action || ''), to: String(req.body?.to || ''), confirm: req.body?.confirm === true, reason: String(req.body?.reason || '') })))
  // 간선 설정(edgecond.js): 이벤트 → 태스크 간선마다, 프로세스마다 조건(꼭 · 선택 · 사안에 따라)과 단계 분류 — 보기는 누구나, 바꾸기는 관리자.
  // 이벤트 key 에 「:」가 들어 있어 간선은 쿼리(event · task)로 고른다.
  r.get('/ontology/processes/:proc/edge-conditions', auth, h(async (req) => (await EC()).edgeList(req.user, req.params.proc)))
  r.get('/ontology/processes/:proc/edge-condition', auth, h(async (req) => (await EC()).edgeView(req.user, req.params.proc, { event: String(req.query.event || ''), task: String(req.query.task || '') })))
  r.put('/ontology/processes/:proc/edge-condition', auth, h(async (req) => { await admin(req); return (await EC()).setEdgeCondition(req.user, req.params.proc, req.body || {}) }))
  // 시험용으로 들어온 메일(개발 · 시연 서버에서만): 진짜 메일이 들어올 때와 같은 길(run.js routeMail)로 건을 연다 — 이 기기에서, 관리자만,
  // 보낸 사람은 예약된 시험용 도메인(.test · .example · .invalid · example.com/net/org)만. 실제 메일함에는 아무것도 읽거나 쓰지 않는다.
  r.post('/ontology/simulate-mail', auth, h(async (req) => {
    await admin(req)
    const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)
    if (process.env.PRO_DEMO_LOGIN === '0' || !local) throw S.err(404, '찾지 못했어요.')
    const from = String(req.body?.from || '').slice(0, 200)
    const addr = (from.match(/<([^>]+)>/)?.[1] || from).trim().toLowerCase()
    if (!/@([a-z0-9-]+\.)*(test|example|invalid|localhost)$|@example\.(com|net|org)$/.test(addr)) throw S.err(400, '시험용 메일은 보낸 사람이 시험용 도메인(.test · .example · example.com)이어야 해요.')
    return (await R.routeMail(req.user.id, { from, subject: String(req.body?.subject || '').slice(0, 300), text: String(req.body?.text || '').slice(0, 4000) })) || { routed: false }
  }))

  // 일 정의
  r.get('/ontology/tasks/:key', auth, h((req) => D.getTask(req.params.key)))
  // 근거: the mails · chat messages · chat handovers this work was read from (subjects and originals: their owner only)
  // 갈림길 조건(§25): 한 일 뒤 갈래마다 「어떤 경우에 이쪽으로」 — 보기 · 한 갈림길 뽑기(관리자) · 모두 뽑기(관리자, 작업)
  r.get('/ontology/branches/:task', auth, h(async (req) => (await import('../lib/ontology/conditions.js')).branchView(req.user, req.params.task)))
  r.post('/ontology/branches/:task', auth, h(async (req) => { await admin(req); const C = await import('../lib/ontology/conditions.js'); await C.judgeConditions({ task: req.params.task }); return C.branchView(req.user, req.params.task) }))
  r.post('/ontology/conditions', auth, h(async (req) => { await admin(req); return S.startConditions(req.user, { force: !!req.body?.force }) }))
  r.get('/ontology/conditions', auth, h(async () => ({ job: await (await import('../lib/ontology/history.js')).latestJob('conditions') })))
  // AI 후보(§24): 일마다 AI 가 맡을 수 있는지 · 사람이 꼭 해야 하는지
  r.get('/ontology/candidates', auth, h(async () => ({ ...(await (await import('../lib/ontology/candidates.js')).candidateList()), job: await (await import('../lib/ontology/history.js')).latestJob('candidates') })))
  r.post('/ontology/candidates', auth, h(async (req) => { await admin(req); return S.startCandidates(req.user, { all: !!req.body?.all }) }))
  r.get('/ontology/candidates/:task', auth, h(async (req) => ({ candidate: await (await import('../lib/ontology/candidates.js')).candidateOf(req.params.task) })))
  r.post('/ontology/candidates/:task', auth, h(async (req) => { await admin(req); return (await import('../lib/ontology/candidates.js')).decideCandidate(req.user, req.params.task, req.body || {}) }))
  // 프로세스 다듬기 ① 바로잡기 · ② 단계 가르기(plan-process-refinement §3): 찾은 흐름 · 다듬은 흐름 · AI 점검 · 고친 기록 · 단계 분류.
  // 보기는 누구나, 점검 · 고치기 · 분류는 관리자
  const RF = () => import('../lib/ontology/refine.js')
  r.get('/ontology/refine/:proc', auth, h(async (req) => (await RF()).refineView(req.user, req.params.proc)))
  r.post('/ontology/refine/:proc/review', auth, h(async (req) => { await admin(req); return S.startRefine(req.user, req.params.proc) }))
  r.post('/ontology/refine/:proc/issues/:id', auth, h(async (req) => { await admin(req); return (await RF()).decideIssue(req.user, req.params.proc, req.params.id, { action: String(req.body?.action || '') }) }))
  r.post('/ontology/refine/:proc/corrections', auth, h(async (req) => { await admin(req); return (await RF()).addCorrection(req.user, req.params.proc, { op: req.body?.op, args: req.body?.args, why: String(req.body?.why || '') }) }))
  r.delete('/ontology/refine/:proc/corrections/:id', auth, h(async (req) => { await admin(req); return (await RF()).removeCorrection(req.user, req.params.proc, req.params.id) }))
  r.get('/ontology/tasks/:key/evidence', auth, h(async (req) => (await import('../lib/ontology/evidence.js')).taskEvidence(req.user, req.params.key, {
    limit: Math.min(100, Math.max(5, Number(req.query.limit) || 40)), before: req.query.before || null })))
  r.post('/ontology/tasks/:key/draft', auth, h(async (req) => { await admin(req); return D.draftDefinition(req.params.key, { template: req.body?.template }) }))
  r.put('/ontology/tasks/:key/definition', auth, h(async (req) => { await admin(req); return D.saveDefinition(req.user, req.params.key, String(req.body?.definition || '')) }))
  // 일이 쓰는 양식 · 형식 규칙 · 스킬 보기 · 건의 단계가 만든 파일(routes/ontologyForms.js)
  formRoutes(r, { auth, h, admin })

  // 역할: 보기는 누구나, 정의 초안 · 확정은 관리자
  r.get('/ontology/roles/:key', auth, h((req) => RL.roleView(req.params.key)))
  r.post('/ontology/roles/:key/draft', auth, h(async (req) => { await admin(req); return RL.draftRole(req.params.key) }))
  r.put('/ontology/roles/:key', auth, h(async (req) => { await admin(req); return RL.saveRole(req.user, req.params.key, req.body || {}) }))
  r.put('/ontology/roles/:key/members', auth, h(async (req) => { await admin(req); return W.setMember(req.user, req.params.key, String(req.body?.userId || ''), req.body?.on !== false) }))

  // 일의 방법: 습관 주인이 공유에 답하고(본인만), 같은 목표의 방법을 견주고(누구나), 고른 방법을 그 일의 스킬로(관리자)
  r.post('/ontology/ways/answer', auth, h((req) => W.answerShare(req.user, { messageId: req.body?.messageId, followupId: String(req.body?.followupId || ''), answer: String(req.body?.answer || '') })))
  // 타이머 사건(design-v0.3 §13): 회사가 프로세스에 거는 타이머, 켬 · 멈춤 · 지움(사람의 예약도 그래프에서 멈출 수 있다)
  r.post('/ontology/timers', auth, h(async (req) => { await admin(req); return TM.addProcessTimer(req.user, { proc: String(req.body?.proc || ''), entry: String(req.body?.entry || ''), cron: String(req.body?.cron || ''), name: req.body?.name }) }))
  r.post('/ontology/timers/from-mail', auth, h((req) => TM.acceptMailTimer(req.user, String(req.body?.messageId || ''))))
  r.put('/ontology/timers/:key', auth, h(async (req) => { await admin(req); return TM.setTimerStatus(req.user, req.params.key, String(req.body?.status || '')) }))
  r.post('/ontology/routines/autonomy', auth, h(async (req) => { await admin(req); return W.setRoutineAutonomy(req.user, { role: String(req.body?.role || ''), task: String(req.body?.task || ''), auto: req.body?.auto === true }) }))
  r.get('/ontology/ways', auth, h((req) => W.waysFor(req.query.task ? String(req.query.task) : null)))
  r.post('/ontology/ways/:id/skill', auth, h(async (req) => { await admin(req); return W.makeSkill(req.user, req.params.id, String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')) }))

  // 검토 · 고정 · 은퇴
  r.get('/ontology/review', auth, h(() => V.agenda()))
  r.post('/ontology/tasks/:key/pin', auth, h(async (req) => { await admin(req); return V.pinTask(req.user, req.params.key, { pinned: req.body?.pinned !== false, validFrom: req.body?.validFrom, reason: req.body?.reason || '' }) }))
  r.post('/ontology/edges', auth, h(async (req) => { await admin(req); return V.setEdge(req.user, String(req.body?.from || ''), String(req.body?.to || ''), { status: req.body?.status, validFrom: req.body?.validFrom, reason: req.body?.reason || '' }) }))
  r.get('/ontology/decisions', auth, h(() => V.decisions()))

  // 말로 고치기 · 더하기(editmap.js): 말 → 동작 → 미리 보기는 누구나, 적용 · 말로 만든 프로세스 지우기는 관리자(서버가 막는다).
  // 채팅의 초안 카드 「지도에 넣기」 · 「○○ 프로세스에서 … 바꿔 줘」 카드. 의견(opinions.js): 남기기는 누구나, 해소는 관리자.
  const EM = () => import('../lib/ontology/editmap.js')
  const OP = () => import('../lib/ontology/opinions.js')
  const arr = (v) => (Array.isArray(v) ? v.slice(0, 40) : [])
  r.post('/ontology/edit/plan', auth, h(async (req) => (await EM()).planEdit(req.user, { proc: String(req.body?.proc || ''), scope: req.body?.scope || null, words: String(req.body?.words || ''), answer: String(req.body?.answer || '') })))
  r.post('/ontology/edit/apply', auth, h(async (req) => (await EM()).applyEdit(req.user, { proc: String(req.body?.proc || ''), scope: req.body?.scope || null, words: String(req.body?.words || ''),
    ops: arr(req.body?.ops), messageId: req.body?.messageId || null, resolve: req.body?.resolve?.opinions ? { opinions: arr(req.body.resolve.opinions).map(String), note: String(req.body.resolve.note || '') } : null })))
  r.delete('/ontology/said/:proc', auth, h(async (req) => (await EM()).removeSaid(req.user, req.params.proc)))
  r.post('/ontology/edit/from-draft/:msgId', auth, h(async (req) => (await EM()).fromDraft(req.user, req.params.msgId)))
  r.post('/ontology/edit/chat/:msgId', auth, h(async (req) => (await EM()).chatEditAction(req.user, req.params.msgId, req.body || {})))
  r.post('/ontology/opinions', auth, h(async (req) => (await OP()).voice(req.user, { proc: String(req.body?.proc || ''), scope: req.body?.scope || null, words: String(req.body?.words || ''), ops: arr(req.body?.ops),
    source: String(req.body?.source || 'map'), caseId: req.body?.caseId || null, todoId: req.body?.todoId || null, task: req.body?.task || null, messageId: req.body?.messageId || null })))
  r.get('/ontology/processes/:proc/opinions', auth, h(async (req) => (await OP()).opinionsView(req.user, req.params.proc)))
  r.get('/ontology/opinions/:id/preview', auth, h(async (req) => (await OP()).opinionPreview(req.user, req.params.id)))
  r.post('/ontology/processes/:proc/opinions/resolve', auth, h(async (req) => (await OP()).resolve(req.user, req.params.proc, { action: String(req.body?.action || ''), opinion: req.body?.opinion || null,
    opinions: arr(req.body?.opinions).map(String), note: String(req.body?.note || '') })))
  return r
}
