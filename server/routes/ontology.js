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
import { cypher } from '../lib/ontology/store.js'
import { q } from '../lib/supa.js'
import { updateMessage } from '../lib/store.js'
import { config } from '../config.js'

export function ontologyRoutes(auth) {
  const r = express.Router()
  const h = (fn) => async (req, res) => {
    try { res.json(await fn(req)) } catch (e) {
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
  // 개인 습관을 지도에 보이는 기준(관리자가 정하고, 보기는 누구나)
  r.get('/ontology/settings', auth, h(() => S.habitSettings()))
  r.put('/ontology/settings', auth, h(async (req) => { await admin(req); return S.setHabitSettings(req.user, { mode: String(req.body?.mode || ''), min: req.body?.min }) }))

  // 프로세스 채택(관리자): 채택한 프로세스만 들어오는 메일을 받는다
  r.post('/ontology/processes/status', auth, h(async (req) => {
    await admin(req)
    const status = String(req.body?.status || '')
    if (!['adopted', 'paused', 'suggested'].includes(status)) throw S.err(400, 'status 는 adopted · paused · suggested 예요.')
    const rows = await cypher('MATCH (b:Process {key:$key}) SET b.status=$status, b.owner=$owner RETURN b.key AS key, b.status AS status',
      { key: String(req.body?.key || ''), status, owner: req.user.email || '' }, { actor: req.user.email, reason: `프로세스 ${status === 'adopted' ? '자동으로 승격' : status === 'suggested' ? '제안으로' : '관찰로'}` })
    if (!rows.length) throw S.err(404, '프로세스를 찾지 못했어요.')
    // 조직이 정한 일(design-v0.3 §12): 승격은 결정 원장에 남는다
    await V.ledger(req.user, status === 'adopted' ? 'ontology.promote' : 'ontology.demote', `${status === 'adopted' ? '자동으로 승격' : status === 'suggested' ? '제안으로' : '관찰로'}: ${req.body?.name || rows[0].key}`, { process: rows[0].key, status })
    return rows[0]
  }))

  // 스냅샷 · 시작 일 · 건
  r.get('/ontology/snapshot', auth, h((req) => R.snapshot({ procKey: String(req.query.proc || ''), entry: String(req.query.entry || ''), theta: num(req.query.theta), validAt: req.query.at || undefined })))
  r.post('/ontology/entry', auth, h((req) => R.chooseEntry({ subject: req.body?.subject, text: req.body?.text, procKey: req.body?.proc })))
  r.post('/ontology/cases', auth, h(async (req) => {
    const r2 = await R.startCase(req.user, { procKey: String(req.body?.proc || ''), entry: String(req.body?.entry || ''), subject: req.body?.subject || '',
      body: req.body?.body || '', from: req.body?.from || '', customer: req.body?.customer || '', odds: req.body?.odds || null, kind: req.body?.kind || 'manual' })
    await keepOnCard(req.user, req.body?.messageId, { state: 'started', picked: true, choice: req.body?.odds || null, caseId: r2.caseId, instId: r2.instId,
      skipped: r2.snapshot.skipped, nodes: r2.snapshot.nodes, procDefId: r2.snapshot.procDefId })
    return r2
  }))
  r.get('/ontology/cases', auth, h(() => q(`select id, bundle as proc, entry_task, trigger, status, instances, history, created_at from pro_po_cases where tenant_id=$1 order by created_at desc limit 30`, [config.tenantId])))
  r.get('/ontology/cases/:id', auth, h((req) => R.getCase(req.params.id)))
  r.post('/ontology/cases/:id/move', auth, h(async (req) => {
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

  // 일 정의
  r.get('/ontology/tasks/:key', auth, h((req) => D.getTask(req.params.key)))
  r.post('/ontology/tasks/:key/draft', auth, h(async (req) => { await admin(req); return D.draftDefinition(req.params.key, { template: req.body?.template }) }))
  r.put('/ontology/tasks/:key/definition', auth, h(async (req) => { await admin(req); return D.saveDefinition(req.user, req.params.key, String(req.body?.definition || '')) }))

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
  return r
}
