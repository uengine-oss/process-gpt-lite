// 메일 한 통이 일의 어디에 있나 (2026-11-24 사용자 요청 — 「메일 기반으로 처리할 일들이 채팅으로 들어올 때 메일 내용과 연관되었음을
// 표시 … 클릭하면 메일 원문을 보고, 거기서 답장도 하고 일을 바로 처리」, 「메일은 프로세스 지도의 업무 트리거(이벤트) … 인스턴스화되는
// UI 흐름」). 설계 docs/mail-thread-flow/design.md, 스펙 openspec/specs/mail-thread-flow.
//   refOf          — a chat message's chip for a mail's Home card (모닝 브리프 · 메일에서 찾은 요청 · 보낸 답장): it opens the card's mail
//                    sheet, or — once the mail belongs to an instance — that instance's page
//   flowOfCard     — what the mail sheet says about the work: the instance the mail is part of; else the running instance it is the same work
//                    as (its Gmail thread first, without a model; then the judge, skill prompt same-work) and the process of the company map
//                    it starts (ontology/events.js routeEvent — 제안 · 자동 processes; a 관찰 one is never offered)
//   startFromCard · joinFromCard — the person's answer: a new case of that process (ontology/run.js startCase) or the running instance. Either
//                    way the mail becomes the instance's (its conversation, engine.instanceThread) and the card and its chips point there
//                    (2026-11-18: work of an instance happens on its page, nothing is appended to the main chat)
//   linkByThread   — at intake: a new mail of a thread already linked to a running instance goes to that instance (a Home notice, no model)
//   routeMailCards — at intake, a mail the map's router reads (lib/mail.js — one asking for documents): an adopted (자동) process starts on it
//                    and lives with its instance; a suggested (제안) one is asked on the mail's card, not in the main chat
// The link is the card's own (pro_actions.source.inst · .flow · .thread_id): no table of its own.
import { config } from '../config.js'
import { q } from './supa.js'
import { emit } from './bus.js'
import { addMessage, updateMessage } from './store.js'
import { L } from './lang.js'

const T = () => config.tenantId
const fail = (status, message, code) => Object.assign(new Error(message), { status, ...(code && { code }) })
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
const round = (p) => (p == null ? null : Math.round(Number(p) * 1000) / 1000)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// "김하늘 <haneul@x.example>" → 김하늘 (an address alone stays the address)
export const nameOf = (from) => clean(String(from || '').split('<')[0].replace(/"/g, '')) || clean(String(from || '').replace(/[<>]/g, ''))
// 받침 있는 말 뒤엔 을/이/은/으로, 없으면 를/가/는/로 (the particle only)
export function jo(word, pair) {
  const ch = String(word || '').trim().slice(-1)
  const code = ch.charCodeAt(0) - 0xac00
  const has = code >= 0 && code <= 11171 ? code % 28 !== 0 : /[0-9LMNR]$/i.test(ch)
  const [a, b] = pair.split('/')
  if (pair === '으로/로') return has && code % 28 !== 8 ? '으로' : '로'
  return has ? a : b
}
const RUNNING = ['RUNNING', 'NEW']
export const STAGES = ['adopted', 'suggested'] // 자동 · 제안 — a 관찰(paused) process is never offered

export const DEFAULTS = { joinMin: 0.7, joinCandidates: 4, joinDays: 60, matchHours: 12, textChars: 1200 }
// the skill's numbers (skills/process-discovery rules.json mailFlow), the defaults when it cannot be read
export async function flowRules() {
  try { return { ...DEFAULTS, ...((await (await import('./ontology/discovery.js')).rules()).mailFlow || {}) } } catch { return { ...DEFAULTS } }
}

// ---------- the chip ----------
export const instRef = (i) => (i?.instId ? { instId: i.instId, name: i.name || '' } : null)
// a chat message's chip for a mail card: {actionId, mailId, verb, text, inst?}
export function refOf(a) {
  const inst = instRef(a?.source?.inst)
  return { actionId: a.id, mailId: a.source?.mail_id || null, verb: a.verb, text: a.text, ...(inst ? { inst } : {}) }
}

// the card a chip names: by its id, else the newest card of its mail (a put-away card too — it still opens its mail)
export async function cardByRef(userId, { action, mail } = {}) {
  let a = null
  if (action && UUID.test(String(action))) [a] = await q(`select * from pro_actions where id=$1 and user_id=$2 and source ? 'mail_id' and status <> 'deleted'`, [String(action), userId])
  if (!a && mail) [a] = await q(`select * from pro_actions where user_id=$1 and source->>'mail_id'=$2 and status <> 'deleted' order by created_at desc limit 1`, [userId, String(mail)])
  if (!a) throw fail(404, L('이 메일의 카드를 찾지 못했어요.', "The card of this mail couldn't be found."))
  return a
}

async function cardOf(userId, id) {
  const [a] = UUID.test(String(id)) ? await q('select * from pro_actions where id=$1 and user_id=$2', [String(id), userId]) : []
  if (!a) throw fail(404, L('카드를 찾지 못했어요.', "This card couldn't be found."))
  if (!a.source?.mail_id) throw fail(400, L('메일에서 온 카드가 아니에요.', "This card didn't come from a mail."))
  return a
}

async function instState(instId) {
  const [i] = await q(`select proc_inst_id, proc_inst_name, status::text as status, coalesce(is_deleted,false) as deleted from bpm_proc_inst where proc_inst_id=$1 and tenant_id=$2`, [String(instId), T()])
  return i || null
}
const running = (i) => !!i && !i.deleted && RUNNING.includes(i.status)

async function saveFlow(userId, id, flow) {
  const [row] = await q(`update pro_actions set source = source || jsonb_build_object('flow', $3::jsonb) where id=$1 and user_id=$2 returning *`, [id, userId, JSON.stringify(flow)])
  if (row) emit(userId, 'action', row)
  return row
}

// the mail as it arrived (the sheet's original — lib/mailReply.js), else what the card knows of it
async function mailOf(user, a) {
  try {
    const R = await import('./mailReply.js')
    const [acc] = await q('select provider from pro_mail_accounts where user_id=$1', [user.id])
    if (acc) {
      const m = await R.originalOf(user.id, acc.provider, a.source.mail_id)
      return { from: m.from ? R.formatAddress(m.from) : a.source.from || '', subject: m.subject || a.source.subject || '', text: m.text || '' }
    }
  } catch (e) { console.warn('[mail flow] original', e.message) }
  return { from: a.source.from || '', subject: a.source.subject || '', text: a.text || '' }
}

// ---------- which running instance a mail belongs to ----------
// the thread: an earlier mail of the same Gmail thread was linked to a running instance — the surest correlation there is, no model
export async function threadLink(userId, threadId, exceptId = null) {
  if (!threadId) return null
  const rows = await q(`select source->'inst' as inst from pro_actions where user_id=$1 and source->>'thread_id'=$2 and source ? 'inst'
                        and ($3::uuid is null or id <> $3::uuid) order by created_at desc limit 5`, [userId, String(threadId), exceptId && UUID.test(exceptId) ? exceptId : null])
  for (const r of rows) {
    const i = r.inst?.instId && await instState(r.inst.instId)
    if (running(i)) return { ...r.inst, name: i.proc_inst_name || r.inst.name || '' }
  }
  return null
}

// the running instances a new mail may be the work of: the company map's cases I started (the matched process's first) and the instances my
// mail cards were linked to, newest first — with what each is about for the judge
export async function runningOf(userId, { proc = '', limit = 4, days = 60 } = {}) {
  const cases = await q(`select c.id::text as case_id, c.bundle as proc, c.trigger, c.request, c.instances[array_length(c.instances, 1)] as inst_id, c.updated_at
                         from pro_po_cases c where c.tenant_id=$1 and c.started_by=$2 and c.status='running' and coalesce(array_length(c.instances, 1), 0) > 0
                           and c.updated_at > now() - make_interval(days => $3) order by (c.bundle = $4) desc, c.updated_at desc limit $5`,
  [T(), userId, days, proc || '', limit * 2]).catch(() => [])
  const cards = await q(`select distinct on (source->'inst'->>'instId') source->'inst' as inst, source->>'subject' as subject, source->>'from' as "from", text, created_at
                         from pro_actions where user_id=$1 and source ? 'inst' and created_at > now() - make_interval(days => $2)
                         order by source->'inst'->>'instId', created_at`, [userId, days])
  const by = new Map()
  for (const c of cases) {
    by.set(c.inst_id, { instId: c.inst_id, caseId: c.case_id, proc: c.proc, subject: c.trigger?.subject || c.request?.subject || '', from: c.trigger?.from || c.request?.sender || '',
      about: c.request?.body || '', at: c.updated_at })
  }
  for (const r of cards) {
    if (!r.inst?.instId || by.has(r.inst.instId)) continue
    by.set(r.inst.instId, { instId: r.inst.instId, caseId: r.inst.caseId || null, proc: r.inst.proc || null, subject: r.subject || '', from: r.from || '', about: r.text || '', at: r.created_at })
  }
  if (!by.size) return []
  const live = new Map((await q(`select proc_inst_id, proc_inst_name from bpm_proc_inst where tenant_id=$1 and proc_inst_id = any($2) and status::text = any($3) and not coalesce(is_deleted,false)`,
    [T(), [...by.keys()], RUNNING])).map((r) => [r.proc_inst_id, r.proc_inst_name]))
  return [...by.values()].filter((x) => live.has(x.instId)).map((x) => ({ ...x, name: live.get(x.instId) || x.subject }))
    .sort((a, b) => (b.proc === proc) - (a.proc === proc) || new Date(b.at) - new Date(a.at)).slice(0, limit)
}

// the judge's question as the link-cases judge asks it (prompts/same-work.md): 「이미 묶인 건」 — the running instance, 「새 건」 — the mail
export const instLine = (x, R = DEFAULTS) => [x.name, x.subject && `제목 ${x.subject}`, x.from && `상대 ${nameOf(x.from)}`, x.about && `내용 "${clean(x.about).slice(0, Math.round(R.textChars / 2))}"`].filter(Boolean).join(' · ')
export const mailLine = (m, R = DEFAULTS) => ['메일', m.subject && `제목 ${m.subject}`, m.from && `보낸 사람 ${nameOf(m.from)}`, m.text && `내용 "${clean(m.text).slice(0, R.textChars)}"`].filter(Boolean).join(' · ')
export const sameState = (inst, mail, R = DEFAULTS) => ['이미 묶인 건:', `- ${instLine(inst, R)}`, '', '새 건:', `- ${mailLine(mail, R)}`].join('\n')
async function judge(inst, mail, R) {
  const D = await import('./ontology/discovery.js')
  const sameWork = (await D.discoverySkill()).prompts['same-work']
  if (!sameWork) return null
  return (await import('./ontology/streams.js')).sameWorkP(sameState(inst, mail, R), sameWork, { timeoutMs: 8000 })
}

// ---------- which process of the company map it starts ----------
const trimChoice = (c) => (c ? { task: c.task, p: round(c.p), ask: !!c.ask, measured: c.measured !== false, options: (c.options || []).slice(0, 3).map((o) => ({ task: o.task, p: round(o.p) })),
  procName: c.procName || null, procP: round(c.procP), ...(c.suggest ? { suggest: true } : {}) } : null)
// the router's matches (ontology/events.js identify) as a card keeps them
export const matchesOf = (r) => (r?.matches || []).filter((m) => m.choice?.task).slice(0, 3)
  .map((m) => ({ proc: m.proc, name: m.name, stage: m.status, p: round(m.p), task: m.choice.task, choice: trimChoice(m.choice) }))
async function mapRouter() {
  const S = await import('./ontology/store.js')
  if (!S.ontologyEnabled()) return null
  return (await import('./ontology/events.js')).routeEvent
}
async function matchOf(userId, a, getMail, R, deps) {
  const f = a.source.flow
  if (f?.at && Array.isArray(f.matches) && Date.now() - Date.parse(f.at) < R.matchHours * 3600_000) return f
  const route = deps.route || await mapRouter()
  if (!route) return { matches: [], off: true }
  let r
  try { const mail = await getMail(); r = await route({ kind: 'mail', subject: mail.subject, text: mail.text, from: mail.from }) } catch (e) {
    // (not kept: the map may answer next time)
    console.warn('[mail flow] map', e.message)
    return { matches: [], error: e.message }
  }
  const flow = { ...(f || {}), at: new Date().toISOString(), matches: matchesOf(r) }
  await saveFlow(userId, a.id, flow)
  return flow
}

// GET /actions/:id/flow → {linked} | {matches, joins, declined, off, error}
export async function flowOfCard(user, actionId, deps = {}) {
  const a = await cardOf(user.id, actionId)
  if (a.source.inst?.instId) {
    const i = await instState(a.source.inst.instId)
    return { linked: { ...a.source.inst, name: i?.proc_inst_name || a.source.inst.name || '', status: i?.status || null } }
  }
  const R = await flowRules()
  if (a.source.flow?.declined) return { linked: null, declined: true, matches: [], joins: [] }
  // (the mail is read from the mailbox only when the map or the judge needs it)
  let mail = null
  const getMail = async () => (mail ||= await mailOf(user, a))
  const f = await matchOf(user.id, a, getMail, R, deps)
  const matches = (f.matches || []).filter((m) => STAGES.includes(m.stage))
  const joins = []
  const t = await threadLink(user.id, a.source.thread_id, a.id)
  if (t) joins.push({ instId: t.instId, caseId: t.caseId || null, name: t.name, by: 'thread', p: 1 })
  // the judge's readings stay on the card: a running instance is read once for this mail
  const same = { ...(f.same || a.source.flow?.same || {}) }
  let read = false
  for (const c of await runningOf(user.id, { proc: matches[0]?.proc || '', limit: R.joinCandidates, days: R.joinDays })) {
    if (joins.some((j) => j.instId === c.instId)) continue
    let p = same[c.instId]
    if (p === undefined) {
      p = await (deps.judge || judge)(c, await getMail(), R).catch(() => null)
      if (p != null) { same[c.instId] = round(p); read = true }
    }
    if (p != null && p >= R.joinMin) joins.push({ instId: c.instId, caseId: c.caseId, name: c.name, by: 'judge', p: round(p) })
  }
  if (read) await saveFlow(user.id, a.id, { ...(a.source.flow || {}), ...(f.at ? f : {}), same })
  return { linked: null, declined: false, matches, joins: joins.sort((x, y) => y.p - x.p), off: !!f.off, error: f.error || null }
}

// 이번엔 안 해요 (and its undo): the sheet stops asking about this mail
export async function declineFlow(user, actionId, { undo = false } = {}) {
  const a = await cardOf(user.id, actionId)
  const flow = { ...(a.source.flow || {}) }
  if (undo) delete flow.declined
  else flow.declined = new Date().toISOString()
  await saveFlow(user.id, a.id, flow)
  return { ok: true, declined: !undo }
}

// ---------- the person's answer ----------
// one answer per mail, even when two presses arrive together: the card is claimed first, the claim lifted when the start failed
async function claim(userId, a) {
  if (a.source.inst?.instId) throw fail(409, L(`이 메일은 이미 「${a.source.inst.name || '진행 중인 일'}」에 이어져 있어요.`, `This mail is already part of "${a.source.inst.name || 'a running instance'}".`), 'linked')
  const [ok] = await q(`update pro_actions set source = source || jsonb_build_object('linking', now()) where id=$1 and user_id=$2 and not (source ? 'inst')
                        and (not (source ? 'linking') or (source->>'linking')::timestamptz < now() - interval '3 minutes') returning id`, [a.id, userId])
  if (!ok) throw fail(409, L('이 메일은 지금 다른 화면에서 잇는 중이에요.', 'This mail is being linked from another screen.'), 'linking')
}
const unclaim = (a) => q(`update pro_actions set source = source - 'linking' where id=$1`, [a.id]).catch(() => {})

// POST /actions/:id/flow/start {proc, task?}: a new case of a process the map read for this mail, from its start task (or another of its options)
export async function startFromCard(user, actionId, { proc, task } = {}, deps = {}) {
  const a = await cardOf(user.id, actionId)
  const m = (a.source.flow?.matches || []).find((x) => x.proc === String(proc || ''))
  if (!m || !STAGES.includes(m.stage) || !m.task) throw fail(400, L('이 메일로 시작할 프로세스를 다시 확인해 주세요.', 'Check again which process this mail starts.'))
  const entry = task && (m.choice?.options || []).some((o) => o.task === String(task)) ? String(task) : m.task
  await claim(user.id, a)
  try {
    const mail = await mailOf(user, a)
    const start = deps.start || (await import('./ontology/run.js')).startCase
    const c = await start({ id: user.id, email: user.email }, { procKey: m.proc, entry, subject: mail.subject, body: mail.text, from: mail.from,
      customer: nameOf(mail.from) || L('고객', 'Customer'), odds: m.choice ? { ...m.choice, task: entry } : null, kind: 'mail' })
    const inst = { instId: c.instId, caseId: c.caseId || null, name: c.instName || m.name, proc: m.proc, procName: m.name, via: 'start' }
    const link = await linkCards(user.id, a, inst, { mail, task: entry })
    return { instId: c.instId, inst: link }
  } catch (e) { await unclaim(a); throw e }
}

// POST /actions/:id/flow/join {instId}: the mail is the running instance's (one the person can see, still running)
export async function joinFromCard(user, actionId, { instId } = {}) {
  const a = await cardOf(user.id, actionId)
  const { canSeeInstance } = await import('./processes.js')
  if (!instId || !(await canSeeInstance(String(instId), user))) throw fail(403, L('이 일을 볼 권한이 없어요.', "You can't see this instance."))
  const i = await instState(instId)
  if (!running(i)) throw fail(409, L('이미 끝난 일이에요. 새로 시작해 주세요.', 'That instance has ended. Start a new one instead.'), 'ended')
  await claim(user.id, a)
  try {
    const [c] = await q(`select id::text as id, bundle from pro_po_cases where tenant_id=$1 and $2 = any(instances) limit 1`, [T(), String(instId)])
    const mail = await mailOf(user, a)
    // why it was offered: its thread, or the judge's reading kept on the card — else the person chose it
    const t = await threadLink(user.id, a.source.thread_id, a.id)
    const p = a.source.flow?.same?.[String(instId)]
    const by = t?.instId === String(instId) ? 'thread' : p != null ? 'judge' : 'person'
    const link = await linkCards(user.id, a, { instId: String(instId), caseId: c?.id || null, name: i.proc_inst_name || '', proc: c?.bundle || null, via: 'join',
      by, ...(by === 'judge' ? { p: round(p) } : {}) }, { mail })
    return { instId: String(instId), inst: link }
  } catch (e) { await unclaim(a); throw e }
}

// ---------- the link ----------
// the chat messages carrying chips of these cards now point to the instance (a brief's list, or one mail's chip outside the instance)
async function repoint(userId, actionIds, link) {
  const inst = instRef(link)
  for (const id of actionIds) {
    const rows = await q(`select m.id, m.content from pro_messages m join pro_threads t on t.id = m.thread_id
                          where t.user_id=$1 and (m.content->'mails' @> $2::jsonb or (m.content->'mail'->>'actionId' = $3 and not (m.content ? 'mailEvent')))`,
    [userId, JSON.stringify([{ actionId: id }]), id])
    for (const m of rows) {
      if (Array.isArray(m.content.mails)) await updateMessage(userId, m.id, { mails: m.content.mails.map((x) => (x.actionId === id ? { ...x, inst } : x)) })
      else await updateMessage(userId, m.id, { mail: { ...m.content.mail, inst } })
    }
  }
}

const SAYS = {
  start: (who, s, proc, task) => L(`${who}님의 메일 「${s}」${jo(s, '으로/로')} ‘${proc}’${jo(proc, '을/를')} 시작했어요.${task ? ` 「${task}」부터 해요.` : ''}`,
    `Started '${proc}' from ${who}'s mail "${s}".${task ? ` It begins with "${task}".` : ''}`),
  auto: (who, s, proc, task) => L(`${who}님의 메일 「${s}」${jo(s, '이/가')} 와서 ‘${proc}’${jo(proc, '이/가')} 저절로 시작됐어요(자동 단계).${task ? ` 「${task}」부터 해요.` : ''}`,
    `${who}'s mail "${s}" started '${proc}' by itself (automatic stage).${task ? ` It begins with "${task}".` : ''}`),
  join: (who, s) => L(`${who}님의 메일 「${s}」${jo(s, '을/를')} 이 일에 이었어요.`, `${who}'s mail "${s}" is now part of this work.`),
  thread: (who, s) => L(`같은 메일 스레드로 ${who}님의 새 메일 「${s}」${jo(s, '이/가')} 왔어요.`, `A new mail "${s}" from ${who} came in the same thread.`),
}
// the mail in the instance's conversation (what started it, or what came in for it), and a Home card that opens the instance when the person
// did not do it themselves (a mail that started a process by itself, a new mail of its thread)
export async function intoInstance(userId, inst, { mail = {}, task = null, card = null, notify = false } = {}) {
  const { instanceThread, notifyInstance } = await import('./engine.js')
  const th = await instanceThread(userId, inst.instId, inst.name)
  const who = nameOf(mail.from) || L('보낸 사람', 'the sender')
  const subj = clean(mail.subject) || L('(제목 없음)', '(no subject)')
  const proc = inst.procName || inst.name || L('프로세스', 'the process')
  await addMessage(userId, th, 'system', 'divider', { text: L(`메일 · ${subj}`, `Mail · ${subj}`) })
  const text = (SAYS[inst.via] || SAYS.join)(who, subj, proc, task)
  await addMessage(userId, th, 'agent', 'text', { text, mail: { from: mail.from || '', subject: mail.subject || '', ...(card ? { actionId: card.id, mailId: card.source?.mail_id || null } : {}) }, mailEvent: inst.via })
  if (notify) {
    await notifyInstance(userId, inst.instId, inst.via === 'thread'
      ? { type: 'process_mail', title: L(`메일이 이어졌어요 · ${inst.name}`, `New mail · ${inst.name}`), text }
      : { type: 'process_started', title: L(`메일로 시작 · ${inst.name}`, `Started from a mail · ${inst.name}`), text })
  }
  return th
}

// the mail's cards (every card of the mail: the triage's and its drafts' Review card) belong to the instance from now on.
// quiet: the instance already has the mail in its conversation (process mining's registered flow — lib/mining/service.js)
export async function linkCards(userId, card, inst, { mail = null, task = null, notify = false, quiet = false } = {}) {
  let name = inst.name || ''
  if (!name) name = (await instState(inst.instId))?.proc_inst_name || ''
  const link = { instId: inst.instId, caseId: inst.caseId || null, name, proc: inst.proc || null, procName: inst.procName || null, via: inst.via, at: new Date().toISOString(),
    ...(inst.by ? { by: inst.by } : {}), ...(inst.p != null ? { p: inst.p } : {}) }
  const rows = await q(`update pro_actions set source = (source - 'linking') || jsonb_build_object('inst', $3::jsonb)
                        where user_id=$1 and (id=$2 or ($4 <> '' and source->>'mail_id' = $4)) returning *`, [userId, card.id, JSON.stringify(link), String(card.source?.mail_id || '')])
  for (const r of rows) emit(userId, 'action', r)
  await repoint(userId, rows.map((r) => r.id), link)
  if (!quiet) await intoInstance(userId, { ...inst, name }, { mail: mail || { from: card.source?.from, subject: card.source?.subject }, task, card, notify })
  return link
}

// ---------- at intake (lib/mail.js pollUser) ----------
// the new cards whose mail is in a thread already linked to a running instance: linked to it, said there, a Home notice — no model
export async function linkByThread(userId, cards = []) {
  const linked = new Map() // mail id → link
  for (const a of cards) {
    const mailId = a.source?.mail_id
    if (!a.source?.thread_id || a.source.inst || linked.has(mailId)) continue
    const t = await threadLink(userId, a.source.thread_id, a.id)
    if (!t) continue
    linked.set(mailId, await linkCards(userId, a, { ...t, via: 'thread' }, { notify: true }))
  }
  return linked
}

// A mail the map's router reads at intake, when it made Home cards: every process it is the work of is kept on the cards (the sheet asks about
// a suggested one — 제안); an adopted process whose start is sure starts by itself (자동) and the cards belong to that instance. Nothing is
// added to the main chat (ontology/events.js onMail still does for a mail without a card — the simulated mail of the map's tests).
// → false when no process takes it (process mining's flows and the ad-hoc drafts then may), else {started, offered, instId}
export async function routeMailCards(userId, mail, cards = [], deps = {}) {
  const route = deps.route || await mapRouter()
  if (!route || !cards.length) return false
  const [p] = await q('select email from pro_profile where user_id=$1', [userId])
  if (!p?.email) return false
  const ev = { kind: 'mail', subject: mail.subject || '', text: mail.text || '', from: mail.from || '' }
  const r = await route(ev)
  const matches = matchesOf(r)
  const at = new Date().toISOString()
  for (const a of cards) await saveFlow(userId, a.id, { ...(a.source?.flow || {}), at, matches })
  if (r?.none || !matches.length) return false
  const E = await import('./ontology/events.js')
  const { start } = E.planStarts(r.matches, 'mail', deps.rules || await E.eventRules())
  const startCase = deps.start || (await import('./ontology/run.js')).startCase
  const started = []
  for (const m of start) {
    const c = await startCase({ id: userId, email: p.email }, { procKey: m.proc, entry: m.choice.task, subject: ev.subject, body: ev.text, from: ev.from,
      customer: nameOf(ev.from) || L('고객', 'Customer'), odds: m.choice, kind: 'mail' })
    const inst = { instId: c.instId, caseId: c.caseId || null, name: c.instName || m.name, proc: m.proc, procName: m.name, via: 'auto' }
    // the cards belong to the first; a second process the same mail started gets its own conversation and Home card
    if (!started.length) await linkCards(userId, cards[0], inst, { mail: ev, task: m.choice.task, notify: true })
    else await intoInstance(userId, inst, { mail: ev, task: m.choice.task, card: cards[0], notify: true })
    started.push(inst)
  }
  return { started, offered: matches.filter((x) => !started.some((s) => s.proc === x.proc)), instId: started[0]?.instId || null }
}
