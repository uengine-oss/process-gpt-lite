// The built-in browser, asked for by the agent in the middle of its turn (mcp/connectors/browser.js — browser_task · browser_task_wait ·
// browser_task_say). 2026-11-28 production: a project room asked for a Tistory link to go into NotebookLM with slides and an audio overview;
// the agent (deepagents, in a pod of its own) had no browser, fetched the page itself and began a PDF with reportlab. The person:
// 「랭체인 디베이전트가 일을 하는 도중에 이 브라우저 유즈 기존의 브라우저 유즈가 또 불려질 수 있는 … 화면상에 곧바로 나타나면서 진행사항이
// 나타나면서 서로 커뮤니케이션 하면서 왔다갔다 일이 되어야」.
//
// Here:
//   - which chat the task belongs in: the agent's conversation (X-Conversation-Id, filled by deepagents) among this person's own — a live
//     agent turn of theirs on it, else a thread of theirs that stands in it. Another person's conversation is refused; without one, the
//     conversation the agent is answering in as before (this person's newest working thread, else their main chat)
//   - attended or not: a live turn that answers the person's own message (not a routine, not a scheduled run, not a turn the server
//     composed) runs the task as theirs — its card and questions in their chat, their own words from that turn as the basis of what it may
//     do (the purchase gate), the plan as background. Anything else only reads, as the tool always did
//   - the task followed by its card id: a call returns within the agent's MCP read timeout with the result, or with how it stands
//     (running · waiting for the person · in line) and its last few steps; browser_task_wait follows it further, browser_task_say passes
//     words on (never as the person's)
//   - handback: a task that ends after the agent's turn did, with its result never read by the agent, starts one follow-up turn in the same
//     conversation — once, only when the person has not written in that thread since, and never from a handback itself (PRO_BROWSER_HANDBACK=0
//     switches it off)
import { q } from './supa.js'
import * as turns from './turns.js'
import * as TP from './turnPlan.js'
import { callingTurn } from './mailOut.js'
import { runBrowserTask, taskState, relay } from './browser.js'
import { browserSkill, browserSkills } from './browserSkills.js'
import { mainThread, setThreadStatus } from './store.js'
import { scopePattern } from './projectTopics.js'
import { L } from './lang.js'

// the agent's MCP call waits at most a few minutes for the answer (deepagents' streamable-HTTP read timeout is 5)
export const WAIT_MS = () => Math.min(Number(process.env.PRO_BROWSER_TOOL_MS) || 240000, 240000)
const POLL_MS = 400
const KEEP_MS = 2 * 60 * 60_000
export const handbackOn = () => process.env.PRO_BROWSER_HANDBACK !== '0'
const READ_ONLY = () => L('\n\n(읽기만 하세요. 글을 올리거나 메시지를 보내거나 지우거나 사거나 예약하거나 설정을 바꾸지 마세요.)', '\n\n(Read only. Do not post, send messages, delete, buy, book or change settings.)')
const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const hostOf = (u) => { try { return new URL(u).host } catch { return '' } }

// ---------- whose chat ----------

// The thread (and the live agent turn, when there is one) the agent's call belongs to. conv: the agent's conversation, or null.
// → {threadId, turn, how} — how: turn (a live agent turn of theirs on it) · run (a scheduled agent run of theirs) · thread (a thread of
// theirs in it, no turn under way here) · working · main (no conversation: today's guess) — or {refused: true} for a conversation that is
// someone else's. live(userId, conv): the live agent turns and runs of this person on it (lib/mailOut.js callingTurn — tests give their own)
export async function resolveCaller(userId, conv, { live = callingTurn } = {}) {
  const uid = String(userId)
  if (conv) {
    let hit = null
    // (two runs of this person on one conversation cannot be told apart: neither is taken as the caller — the thread is found below)
    try { hit = live(uid, conv) } catch { hit = null }
    if (hit?.agent) return { threadId: hit.threadId, turn: hit, how: 'turn' }
    if (hit) return { threadId: hit.threadId, turn: null, how: 'run' }
    const [own] = await q(`select id from pro_threads where user_id::text=$1 and conversation_id=$2 order by updated_at desc limit 1`, [uid, conv])
    if (own) return { threadId: own.id, turn: null, how: 'thread' }
    // a project's sub-topic (lib/projectTopics.js — its row is kept under the project's key) or a message of theirs filed to it
    const [topic] = await q(`select user_id from context_threads where user_id like $1 and conversation_id=$2 limit 1`, [scopePattern(uid), conv])
    const fromKey = topic ? String(topic.user_id).slice(scopePattern(uid).length - 1) : ''
    if (fromKey) {
      const [t] = await q(`select id from pro_threads where user_id::text=$1 and id::text=$2`, [uid, fromKey])
      if (t) return { threadId: t.id, turn: null, how: 'thread' }
    }
    const [tagged] = await q(`select m.thread_id from pro_messages m join pro_threads t on t.id=m.thread_id where t.user_id::text=$1
                              and (m.content->>'conv'=$2 or m.content->'context'->>'conversationId'=$2) order by m.created_at desc limit 1`, [uid, conv])
    if (tagged) return { threadId: tagged.thread_id, turn: null, how: 'thread' }
    const [listed] = await q(`select 1 from context_threads where user_id=$1 and conversation_id=$2 limit 1`, [uid, conv])
    if (listed) return { threadId: (await mainThread(uid)).id, turn: null, how: 'thread' }
    // someone else's: never their thread, and never this person's as if it were theirs
    const [other] = await q(`select 1 from pro_threads where conversation_id=$2 and user_id::text<>$1
                             union all select 1 from context_threads where conversation_id=$2 and user_id<>$1 and user_id not like $3 limit 1`, [uid, conv, scopePattern(uid)])
    if (other) return { refused: true }
  }
  const [busy] = await q(`select id from pro_threads where user_id::text=$1 and status='working' order by updated_at desc limit 1`, [uid])
  return busy ? { threadId: busy.id, turn: null, how: 'working' } : { threadId: (await mainThread(uid)).id, turn: null, how: 'main' }
}

// Is the person there? A live agent turn that answers their own message in the chat (lib/agent.js delegate marks it): not a routine
// (auto), not one the server composed (a teammate's words, a Home card, a handback), not stopped, with its plan card up (TP view).
export function attendedBy(turn, view = TP.viewOf(turn)) {
  return !!turn && !!turn.agent && !!turn.fromUser && !turn.auto && !turn.composed && !turn.handback && !turn.finished && !turn.stopped && !!view
}

// The background a task the person is there for gets (lib/browser.js backgroundNote): the project's plan, and the steps the person was
// shown for this request
async function backgroundOf(userId, threadId, view) {
  const PN = await import('./projectNote.js')
  const project = await PN.noteRow(userId, threadId).then((r) => PN.noteText(r?.note), () => '')
  const steps = (view?.plan?.steps || []).map((s, i) => `${i + 1}. ${s.text || s}`).join('\n')
  return [project, steps ? `${L('이 요청에서 사람에게 보여 준 계획', 'The plan the person was shown for this request')}:\n${steps}` : ''].filter(Boolean).join('\n\n')
}

// ---------- the tasks the agent asked for ----------

const tasks = new Map() // task (card) id → record
const handedBack = new Set()
function keep(rec) {
  tasks.set(rec.id, rec)
  for (const [id, r] of tasks) if (r.endedAt && Date.now() - r.endedAt > KEEP_MS) tasks.delete(id)
  if (tasks.size > 500) tasks.delete(tasks.keys().next().value)
}
export const _tasks = tasks

// The label people know the work by: 「브라우저 · NotebookLM」
export const browserLabel = (sk) => `${L('브라우저', 'Browser')}${sk ? ` · ${sk.label || sk.name}` : ''}`

// Starts a browser task for the agent. user: {id, email, name} (the JWT's); conv: X-Conversation-Id; jwt: the token the call came with
// (a handback's session when a fresh one cannot be had). → the record (rec.id is the task's card id) — or throws (refused, bad skill).
// deps (tests): run — lib/browser.js runBrowserTask; live — resolveCaller's
export async function startTask({ user, conv = null, jwt = '', goal, startUrl = '', skill = '' }, { run = runBrowserTask, live } = {}) {
  const sk = skill ? browserSkill(skill) : null
  if (skill && !sk) {
    throw Object.assign(new Error(`no browser skill named "${skill}" — use one of: ${browserSkills().map((s) => s.name).join(', ') || '(none)'}, or leave skill out`), { status: 400 })
  }
  const who = await resolveCaller(user.id, conv, live ? { live } : {})
  if (who.refused) {
    console.warn(`[agent-browser] conversation is not this person's — refused user=${String(user.id).slice(0, 8)}`)
    throw Object.assign(new Error(L('이 대화를 이 계정에서 찾지 못해 브라우저 작업을 시작하지 않았어요.', "This conversation isn't one of this account's, so the browser task was not started.")), { status: 403, refused: true })
  }
  const turn = who.turn && attendedBy(who.turn) ? who.turn : null
  const view = turn ? TP.viewOf(turn) : null
  const said = turn ? String(turn.said || '').trim() : ''
  const args = turn
    // the person's own: their words from the turn (never the goal the agent wrote) set what it may do; questions go to their card
    ? { userId: user.id, threadId: who.threadId, goal, startUrl, skill: sk?.name, own: true, unattended: false, said: said ? [said] : [],
      queue: { asked: said || goal, default: 'after' }, background: await backgroundOf(user.id, who.threadId, view).catch(() => '') }
    // nobody watching (a routine, a scheduled run, a composed turn, no live turn): it only reads, as before
    : { userId: user.id, threadId: who.threadId, goal: `${goal}${READ_ONLY()}`, startUrl, ...(sk ? { skill: sk.name } : {}), unattended: true }
  let cardOf
  const card = new Promise((r) => { cardOf = r })
  const running = run({ ...args, onCard: (id) => cardOf(id) })
  const rec = { id: null, userId: String(user.id), user, jwt, threadId: who.threadId, conv, how: who.how, attended: !!turn, turn, said, goal,
    skill: sk?.name || '', label: browserLabel(sk), steps: (view?.plan?.steps || []).map((s) => s.text || String(s)), run: running, result: null,
    delivered: false, seenSeq: 0, startedAt: Date.now(), endedAt: 0, fromHandback: !!who.turn?.handback }
  console.log(`[agent-browser] start ${rec.attended ? 'attended' : 'unattended (read only)'} via ${who.how} skill=${rec.skill || '-'} host=${hostOf(startUrl) || '-'} user=${rec.userId.slice(0, 8)} thread=${String(who.threadId).slice(0, 8)}`)
  const settled = running.then((r) => r, (e) => ({ state: 'failed', need: 'other', summary: e.message, reason: e.message, notes: [] }))
  rec.id = await Promise.race([card, settled.then((r) => r?.taskId || null)])
  if (!rec.id) rec.id = `failed-${Date.now()}`
  keep(rec)
  // (when the agent's turn ended: what the person wrote after it decides whether a result it never read goes back to it)
  if (turn) turn.done.then(() => { rec.turnEndedAt = Date.now() })
  settled.then((r) => ended(rec, r))
  if (turn) {
    TP.alongside(turn, rec.label)
    TP.stage(turn, 'working', { text: L(`${rec.label} — 채팅의 작업 카드에서 진행 중`, `${rec.label} — under way on the task card in the chat`) })
  }
  return rec
}

// the task ended: its result kept for the agent; the conversation stays 「working」 while the agent's turn goes on (the task clears it);
// a result the agent never read goes back to it once its turn is over (handback)
function ended(rec, r) {
  rec.result = r || { state: 'failed', summary: '', notes: [] }
  rec.endedAt = Date.now()
  const busy = turns.agentTurnsOf(rec.userId).some((t) => t.threadId === rec.threadId)
  if (busy) setThreadStatus(rec.userId, rec.threadId, 'working').catch(() => {})
  if (!rec.attended || !rec.turn || rec.fromHandback || !handbackOn()) return
  const after = () => { if (!rec.delivered) handback(rec).catch((e) => console.warn('[agent-browser] handback', e.message)) }
  if (rec.turn.finished) after()
  else rec.turn.done.then(() => setTimeout(after, 300))
}

// ---------- what the agent is told ----------

const GUIDE = {
  running: () => 'The task is working in the browser; the person watches its live screen on the task card in the chat. Call browser_task_wait with this task_id to wait for its result (up to 240 s a call).',
  waiting_for_person: (locked) => `The browser is asking the person right now, on its card in the chat (question below)${locked ? ' — only they can answer this one (an approval, a sign-in or a check)' : ''}. Do not ask them the same thing yourself. Call browser_task_wait to wait for their answer, or tell them in one line that the browser card needs them.`,
  queued: () => 'The task waits in line behind another browser task of this person\'s. Call browser_task_wait to wait for it.',
  unattended: () => 'Nobody is watching this run, so the task only reads (it does not post, send, delete, buy, book or change settings).',
}
const FILES_NOTE = 'These files are already in the chat as file cards for the person. path, when given, is the copy in your workspace; otherwise read the file from its url.'

// a task under way → {state, task_id, progress, question?, options?, note}
export function liveShape(rec, live) {
  const state = live?.state || 'running'
  const out = { state, task_id: rec.id, ...(live?.title ? { title: live.title } : {}), progress: (live?.progress || []).slice(-6) }
  if (live?.step) out.step = live.step
  if (state === 'waiting_for_person') Object.assign(out, { question: live.question || '', ...(live.options?.length ? { options: live.options } : {}) })
  out.note = [GUIDE[state] ? GUIDE[state](live?.locked) : GUIDE.running(), rec.attended ? '' : GUIDE.unattended()].filter(Boolean).join(' ')
  return out
}
// the task is over → {state, task_id, summary, notes, url, page_text, files?}
export function resultShape(rec) {
  const r = rec.result || {}
  const files = (r.files || []).filter((f) => f?.name).map((f) => ({ name: f.name, url: f.url, ...(f.path ? { path: f.path } : {}) }))
  return { state: r.state || 'failed', task_id: rec.id, summary: String(r.summary || r.brief || '').trim(),
    ...(r.state !== 'done' && r.reason && r.reason !== r.summary ? { reason: String(r.reason) } : {}),
    notes: (r.notes || []).slice(-20).map((n) => String(n).slice(0, 400)), url: r.url || '', page_text: String(r.pageText || '').slice(0, 4000),
    ...(files.length ? { files, files_note: FILES_NOTE } : {}),
    ...(rec.attended ? {} : { note: GUIDE.unattended() }) }
}

// Follows a task for at most ms: back at once when it is over, or when it starts asking the person something the agent has not been
// told of yet (its question's seq); else when the time is up, with how it stands. Meanwhile the plan card's live line follows the task.
export async function follow(rec, ms = WAIT_MS(), { state = taskState } = {}) {
  const end = Date.now() + Math.max(0, Math.min(ms, WAIT_MS()))
  let shown = ''
  for (;;) {
    if (rec.result) { rec.delivered = true; return resultShape(rec) }
    const live = state(rec.userId, rec.id)
    if (!live && rec.fromCard) {
      const card = await cardResult(rec.userId, rec.id)
      if (card) { rec.result = card; rec.delivered = true; return resultShape(rec) }
    }
    const asking = live?.state === 'waiting_for_person'
    // (the live line: what the browser does now, or that it is asking the person — the agent's own tool step says only 「브라우저에서 하는 중」)
    const line = asking ? L(`${rec.label} — 브라우저가 묻고 있어요. 작업 카드에서 답해 주세요.`, `${rec.label} — the browser is asking you something on its task card.`)
      : live?.state === 'running' && (live.doing || live.progress?.at(-1)) ? `${rec.label} · ${live.doing || live.progress.at(-1)}` : ''
    if (line && line !== shown) { shown = line; lineOf(rec, line) }
    if (asking && live.seq > rec.seenSeq) {
      rec.seenSeq = live.seq
      return liveShape(rec, live)
    }
    if (Date.now() >= end) return liveShape(rec, live)
    await Promise.race([rec.run ? rec.run.catch(() => {}) : null, sleep(Math.min(POLL_MS, Math.max(10, end - Date.now())))].filter(Boolean))
  }
}
function lineOf(rec, text) {
  if (rec.turn && !rec.turn.finished) TP.stage(rec.turn, 'working', { text: String(text).slice(0, 160) })
}

// A task of this person's by its id, for wait and say: one this server started for the agent, else (a task the chat started, a record
// gone with a restart) its card in one of their threads → the record, or null
export async function ownTask(userId, taskId) {
  const id = String(taskId || '')
  const rec = tasks.get(id)
  if (rec) return rec.userId === String(userId) ? rec : null
  if (!TASK_ID.test(id)) return null
  const [m] = await q(`select m.id, m.thread_id from pro_messages m join pro_threads t on t.id=m.thread_id where m.id::text=$1 and t.user_id::text=$2 and m.kind='task'`, [id, String(userId)])
  if (!m) return null
  return { id, userId: String(userId), threadId: m.thread_id, attended: true, turn: null, run: null, result: null, delivered: false, seenSeq: 0, label: browserLabel(null), fromCard: true }
}
// a card that is over → the result as the task left it on its card (no page text: that was not kept)
async function cardResult(userId, id) {
  const [m] = await q(`select m.content from pro_messages m join pro_threads t on t.id=m.thread_id where m.id::text=$1 and t.user_id::text=$2`, [id, String(userId)])
  const c = m?.content
  if (!c || !['done', 'failed', 'needs_review', 'cancelled'].includes(c.state)) return null
  return { state: c.state, summary: c.summary || '', reason: c.reason || '', notes: c.notes || [], url: c.url || '', pageText: '', files: [] }
}

// browser_task_say: words for the task from the agent (lib/browser.js relay — not the person's, never an approval)
export async function say(rec, text) {
  const r = await relay(rec.userId, rec.id, text)
  if (!r) return { ok: false, task_id: rec.id, state: rec.result ? rec.result.state : taskState(rec.userId, rec.id)?.state || 'over', note: 'The task is not working in the browser now (it waits in line, or it is over): nothing was passed on.' }
  return { ok: true, task_id: rec.id, state: r.waiting ? 'waiting_for_person' : 'running',
    note: r.waiting ? 'The task is waiting for the person; it reads your words once they have answered its card.' : 'The task reads your words on its next look at the page.' }
}

// ---------- handback ----------

// The words the follow-up turn is sent with: shown — what the chat shows (Lite sent it, not the person); context — what the agent reads
export function handbackMessage(rec) {
  const r = resultShape(rec)
  const title = rec.result?.title || rec.title || rec.goal?.split('\n')[0].slice(0, 60) || ''
  const shown = L(`브라우저 작업 「${title}」이(가) 끝났어요. 결과를 보고 남은 일을 이어서 해 주세요.`, `The browser task "${title}" is over. Please go on with the rest of the work from its result.`)
  const lines = [
    L('(Lite 가 보낸 메시지예요. 사람이 쓴 말이 아니에요.) 이 대화에서 앞서 시작한 브라우저 작업이 앞 답이 끝난 뒤에 끝났어요. 아래 결과로 계획의 남은 단계를 이어서 하세요. 이미 한 일은 다시 하지 말고, 같은 브라우저 작업을 다시 시작하지 마세요.',
      '(Sent by Lite, not typed by the person.) The browser task you started earlier in this conversation ended after your last answer. Go on with the remaining steps of the plan from the result below; do not redo what is done, and do not start the same browser task again.'),
    rec.steps?.length ? `${L('처음 계획', 'The plan')}:\n${rec.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}` : '',
    `[browser_task ${r.task_id}] state: ${r.state}`,
    r.summary ? `summary: ${r.summary}` : '',
    r.reason ? `reason: ${r.reason}` : '',
    r.notes.length ? `notes:\n${r.notes.map((n) => `- ${n}`).join('\n')}` : '',
    r.url ? `url: ${r.url}` : '',
    r.files?.length ? `files (${FILES_NOTE}):\n${r.files.map((f) => `- ${f.name}: ${f.path || f.url}`).join('\n')}` : '',
    r.page_text ? `page_text:\n${r.page_text.slice(0, 2000)}` : '',
  ]
  return { shown, context: lines.filter(Boolean).join('\n\n'), title }
}

// Once, when the person has not written in that thread since the agent's turn ended (words they typed as the task's answer or
// instruction — its acknowledgements carry the task's id — do not count) and nothing else runs there.
// deps (tests): runTurn — lib/agent.js; sessionOf — a fresh session of the person's (lib/supa.js sessionOfUser)
export async function handback(rec, { runTurn = null, sessionOf = null, asUser = null } = {}) {
  if (handedBack.has(rec.id) || rec.delivered || !rec.turn || rec.turn.stopped || rec.turn.reason || rec.fromHandback) return { started: false, why: 'not this one' }
  handedBack.add(rec.id)
  const since = new Date(rec.turnEndedAt || rec.endedAt || Date.now())
  // (the task's own name, as its card shows it)
  if (!rec.title) rec.title = (await q(`select content->>'title' as title from pro_messages where id::text=$1`, [rec.id]).catch(() => []))[0]?.title || ''
  const [n] = await q(`select count(*) filter (where role='user')::int as said,
                              count(*) filter (where role='agent' and (content->>'answered'=$3 or content->>'steered'=$3))::int as told
                       from pro_messages where thread_id=$1 and created_at > $2`, [rec.threadId, since, rec.id])
  if ((n?.said || 0) > (n?.told || 0)) { console.log(`[agent-browser] no handback for ${rec.id}: the person wrote since`); return { started: false, why: 'wrote' } }
  if (turns.unsettled({ userId: rec.userId, threadId: rec.threadId }).length) { console.log(`[agent-browser] no handback for ${rec.id}: a turn is under way there`); return { started: false, why: 'busy' } }
  const A = runTurn ? { runTurn } : await import('./agent.js')
  const S = sessionOf || (await import('./supa.js')).sessionOfUser
  const as = asUser || (await import('./lang.js')).asUser
  let session = null
  try { const s = await S(rec.userId); if (String(s?.user?.id) === rec.userId) session = s.session } catch { /* the call's own token below */ }
  if (!session?.access_token && rec.jwt) session = { access_token: rec.jwt }
  if (!session?.access_token) { console.warn(`[agent-browser] no handback for ${rec.id}: no session`); return { started: false, why: 'session' } }
  const m = handbackMessage(rec)
  console.log(`[agent-browser] handback ${rec.id} (${rec.result?.state}) → conversation ${String(rec.conv || '-').slice(0, 12)} thread=${String(rec.threadId).slice(0, 8)}`)
  const user = { id: rec.userId, email: rec.user?.email || '', name: rec.user?.name || '' }
  const turn = as(rec.userId, () => A.runTurn({ user, session, threadId: rec.threadId, text: m.shown, context: m.context, composed: true,
    handback: { taskId: rec.id, conv: rec.conv, title: m.title }, ...(rec.conv ? { conversation: { id: rec.conv } } : {}) }))
  turn.catch((e) => console.warn('[agent-browser] handback turn', e.message))
  return { started: true, turn }
}
