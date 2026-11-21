// Turn orchestration. The chat router (lib/skills/router.js) reads the action skills (skills/actions) and
// the person's facts and picks what the turn needs: one of this server's actions, or the general agent —
// process-gpt's deepagents (/chat/stream), whose answer is streamed back verbatim. What a message means
// is decided there, by a model reading skill descriptions, or by a structured field the page sent
// (intent, reply); nothing here reads the words (docs/mobile-review-1121/skill-routing-design.md).
import { config } from '../config.js'
import { chat } from './llm.js'
import { q } from './supa.js'
import { addMessage, history, getThread, setThreadStatus } from './store.js'
import { listSkills, workspaceHostPath, runMission, parseResult } from './missions.js'
import { createTrail } from './workTrail.js'
import { summarizeSkill, listFolder, getSkill } from './skills.js'
import { generatedContract } from './generated.js'
import fs from 'node:fs/promises'
import { emit } from './bus.js'
import { listDefinitions } from './processes.js'
import { systemGuide } from './systems.js'
import { displayName, documentFrom, documentsOfRun, editable, parseToolOutput, publish } from './office.js'
import { AsyncLocalStorage } from 'node:async_hooks'
import * as turns from './turns.js'
import { isOutput, keepToolDoc, roomOf, workspaceHint, workspacePaths, textDoc, workFile, checkoutFile } from './provenance.js'
import { activateCraft, CRAFT_APPS } from '../mcp/craft.js'
import { activateOffice } from '../mcp/office.js'
import { liveOpen, liveFact, livePin, openDocOf } from './craftLive.js'
import { capture, reviewTurn } from './review.js'
import { attachmentHint, indexForRoom, chatFiles } from './attachments.js'
import { ensureHubBinding } from '../mcp/connectors.js'
import { isFolderRoom, startChatWork, finishChatWork } from './folders/work.js'
import { privateSkillFor, askShareAfterUse } from './folders/skills.js'
import * as TF from './folders/threadFolders.js'
import { L, isEn, locale, langInstruction } from './lang.js'
import { skillNamed } from './skills/registry.js'
import { decide, choiceDecision } from './skills/router.js'
import { gatherFacts } from './skills/facts.js'
import { HANDLERS } from './skills/handlers.js'
import { startActionSkills } from './skills/index.js'

// Files attached to the turn being handled, picked up by the deepagents call that answers it.
const attached = new Map() // threadId -> [{name, path, url, type, size}]
// A turn sent from inside one conversation's view goes to that conversation, not to the router.
const pinned = new Map() // threadId -> {conversationId, title}

function toLlmHistory(rows) {
  return rows.filter((r) => r.kind === 'text' || r.kind === 'doc').map((r) => ({
    role: r.role === 'user' ? 'user' : 'assistant',
    content: r.content.text || '',
  }))
}

// A message's place in line, from the moment it comes in (lib/turns.js): the agent turn it leads to
// (delegate) takes this place, so turns on the same conversation run in the order they were sent.
const turnCtx = new AsyncLocalStorage()
export function runTurn(args) {
  const turn = turns.enqueue({ userId: args.user.id, threadId: args.threadId })
  return turnCtx.run({ turn, userMsgId: null, adopted: false }, () => handleTurn(args)).finally(() => turn.finish())
}

// This message is answered here, not by an agent turn: a message after it need not wait for it.
const noAgentTurn = () => { const t = turnCtx.getStore()?.turn; if (t) t.setConv(`none:${t.id}`) }

// What the page says a message is, as fields (never read off its words): the button it came from
// (intent) or the offered choice it answers (reply). A Home card's run (index.js) is the server's own.
const INTENTS = ['create_panel', 'skill', 'home_action']
function structuredOf({ intent, reply }) {
  const out = {}
  if (intent && typeof intent === 'object' && INTENTS.includes(intent.kind)) {
    out.intent = intent.kind === 'skill'
      ? { kind: 'skill', skill: String(intent.skill || ''), args: intent.args && typeof intent.args === 'object' ? intent.args : {} }
      : intent.kind === 'home_action' ? { kind: 'home_action', verb: String(intent.verb || '').slice(0, 20) } : { kind: intent.kind }
  }
  if (reply && typeof reply === 'object' && /^[0-9a-f-]{36}$/.test(String(reply.messageId || '')) && Number.isInteger(reply.index) && reply.index >= 0 && reply.index < 10) {
    out.reply = { messageId: String(reply.messageId), index: reply.index }
  }
  return out
}
const withContext = (text, context) => (context ? `${text}\n\n${context}` : text)

async function handleTurn({ user, session, threadId, text, context, onDelta, files, conversation, noFolder, openDoc, intent, reply }) {
  startActionSkills()
  const userId = user.id
  const pin = conversation?.id ? { conversationId: String(conversation.id), title: String(conversation.title || '') } : null
  if (pin) pinned.set(threadId, pin)
  // a key is only ever this person's own upload (lib/attachments.js); the page could send any other
  files = (files || []).filter((f) => f?.url).map((f) => (f.key && !String(f.key).startsWith(`pgpt-pro/${user.id}/att/`) ? { ...f, key: undefined } : f)).slice(0, 10)
  if (!text?.trim() && files.length) text = L('첨부한 파일을 확인해 줘', 'Please look at the attached files')
  text = String(text || '')
  const shape = structuredOf({ intent, reply })
  const said = await addMessage(userId, threadId, 'user', 'text', { text, ...(files.length ? { files } : {}), ...(shape.intent ? { intent: shape.intent } : {}), ...(shape.reply ? { reply: shape.reply } : {}) })
  const store = turnCtx.getStore()
  if (store) store.userMsgId = said.id
  // the document open in the page's editor (src/stores/app.js send): this turn's delegate treats it
  // as the open document even when the live link (lib/craftLive.js) is down
  const doc = openDocOf(openDoc)
  if (store && doc) store.openDoc = doc
  for (const f of files) await addMessage(userId, threadId, 'user', 'file', { name: f.name, url: f.url, path: f.path, attached: true })
  if (files.length) attached.set(threadId, files)
  const hist = toLlmHistory(await history(threadId, 12))
  if (context) hist[hist.length - 1] = { role: 'user', content: `${text}\n\n${context}` }
  const turn = { user, session, threadId, text, context, onDelta, files, noFolder, doc, ackMsg: null, pin }
  const toAgent = (t = withContext(text, context), extra = {}) => delegate({ user, session, threadId, text: t, onDelta, ...extra })

  // 1. an offered choice, tapped
  if (shape.reply) {
    const r = await replyTurn(turn, shape.reply)
    if (r !== undefined) return r
  }
  // 2. the button the message came from
  if (shape.intent?.kind === 'create_panel' && !files.length) {
    return runAction(turn, { route: 'skill', skill: 'panel-create', args: { description: text }, ack: L('패널을 설계하고 있어요.', "I'm designing the panel.") })
  }
  if (shape.intent?.kind === 'home_action') return toAgent()
  if (shape.intent?.kind === 'skill') {
    const facts = await factsFor(turn)
    const d = choiceDecision({ skill: shape.intent.skill, args: shape.intent.args }, facts)
    if (d) return runAction({ ...turn, facts }, d)
  }
  // 3. "/name" at the front names a skill (a command's format): the author's own unshared skill is read
  // from its copy; an installed one is pinned by deepagents from the same prefix
  const cmd = /^\/([\w.-]+)(\s|$)/.exec(text.trim())?.[1]
  if (cmd && !generationPending(threadId)) {
    const own = await privateSkillFor(user, text).catch(() => null)
    if (own) return ownSkillTurn(turn, own)
    if ((await listSkills(session.access_token)).some((k) => k.name === cmd)) return toAgent()
  }
  // 4. a process being designed: the agent's turn, told what is being designed
  if (generationPending(threadId)) return toAgent(generationPrompt(threadId, text))
  // 5. the router
  const facts = await factsFor(turn)
  const decision = await decide({ messages: hist.slice(-8), facts, onAck: (ack) => showAck(turn, ack) })
    .catch((e) => { console.warn('[router]', e.message); return { route: 'delegate', skill: null } })
  console.log(`[router] ${decision.route}${decision.skill ? ` ${decision.skill}` : ''}${decision.args ? ` ${JSON.stringify(decision.args).slice(0, 160)}` : ''} · ${decision.timings?.stage1 ?? '-'}ms${decision.stage2 ? ` + ${decision.timings.stage2}ms` : ''}`)
  return dispatch({ ...turn, facts }, decision)
}

async function factsFor(turn) {
  return gatherFacts({ user: turn.user, session: turn.session, threadId: turn.threadId, files: turn.files, openDoc: turn.doc || liveOpen(turn.user.id), generation: generationPending(turn.threadId) ? { pending: true } : null, noFolder: turn.noFolder })
}

// the router's confirmation sentence, in the chat at once (a staged skill's, before its second stage)
async function showAck(turn, ack) {
  if (turn.ackMsg || !ack) return turn.ackMsg
  turn.ackMsg = await addMessage(turn.user.id, turn.threadId, 'agent', 'text', { text: ack })
  turn.onDelta?.(ack)
  return turn.ackMsg
}

// a conversation pin this turn set and no agent turn used does not carry over to the next message
const unpin = (turn) => { if (turn.pin && pinned.get(turn.threadId) === turn.pin) pinned.delete(turn.threadId) }

async function dispatch(turn, d) {
  const { user, session, threadId, text, context, onDelta } = turn
  if (d.route === 'ask') {
    unpin(turn)
    noAgentTurn()
    const m = await addMessage(user.id, threadId, 'agent', 'text', { text: d.question, choices: d.choices || [] })
    onDelta?.(d.question)
    return turn.ackMsg || m
  }
  if (d.route === 'skill' && skillNamed(d.skill)) return runAction(turn, d)
  // the agent's turn; a skill the router named: the author's own unshared skill is read from its copy,
  // and the app tools an installed skill declares (metadata.include_tools) are listed for this turn
  let tools = null
  if (d.skill) {
    if (turn.facts.mySkills.some((k) => k.name === d.skill)) {
      const own = await privateSkillFor(user, `/${d.skill}`).catch(() => null)
      if (own) return ownSkillTurn(turn, own)
    }
    tools = await skillTools(session, d.skill)
  }
  return delegate({ user, session, threadId, text: withContext(text, context), onDelta, tools })
}

// One action skill, run: its ack (already shown for a staged skill), then its handler
async function runAction(turn, d) {
  const s = skillNamed(d.skill)
  const agentTurn = s.metadata.agent_turn
  if (agentTurn === false) noAgentTurn()
  let ackMsg = turn.ackMsg
  if (!ackMsg && d.ack) ackMsg = await showAck(turn, d.ack)
  const ctx = { ...turn, facts: turn.facts || await factsFor(turn), acked: !!ackMsg, ackText: ackMsg?.content?.text || null, noAgentTurn }
  const out = await HANDLERS[s.metadata.handler](ctx, d.args || {})
  unpin(turn)
  return ackMsg || out
}

// A choice from a message's stored choices (src/components/Message.vue sends its message id and place):
// a router's ask runs the skill it carries, a process draft's "go ahead" goes on with the generation,
// an agent's question goes back to the agent. undefined: route the label like any message.
async function replyTurn(turn, reply) {
  const [m] = await q('select content from pro_messages where id=$1 and thread_id=$2 and role=$3', [reply.messageId, turn.threadId, 'agent']).catch(() => [])
  const choice = m?.content?.choices?.[reply.index]
  if (!choice) return undefined
  const { user, session, threadId, text, onDelta } = turn
  if (choice.reply?.kind === 'approve' && generationPending(threadId)) return delegate({ user, session, threadId, text: generationPrompt(threadId, text, { approved: true }), onDelta })
  if (choice.skill) {
    const facts = await factsFor(turn)
    const d = choiceDecision(choice, facts)
    if (d) return runAction({ ...turn, facts }, d)
    return undefined
  }
  if (choice.to === 'agent') {
    // the answer goes to the conversation the question came from
    const conv = m.content.context?.conversationId
    if (conv && !pinned.has(threadId)) pinned.set(threadId, { conversationId: String(conv), title: String(m.content.context?.title || '') })
    return delegate({ user, session, threadId, text, onDelta })
  }
  return undefined
}

// the author's own private skill is not installed: their run is pointed at its copy, and after the first
// good run the chat asks once more whether to share it (attached files go along like any turn's)
async function ownSkillTurn(turn, own) {
  const { user, session, threadId, text, onDelta } = turn
  const msg = await delegate({ user, session, threadId, onDelta, text: `${text.replace(`/${own.name}`, '').trim() || text}\n\n${L(`(내 스킬 '${own.name}' 로 처리하세요. 아직 공유하지 않은 개인 스킬이라 설치 목록에는 없어요 — 이 문서를 읽고 그 절차대로 하세요: ${own.path}, 같은 폴더의 파일도 참고)`, `(Handle this with my skill '${own.name}'. It is a personal skill not shared yet, so it is not in the installed list — read this document and follow its procedure: ${own.path}, and see the files in the same folder)`)}` })
  // (the stream says whether the run failed or ended empty: lib/agent.js streamTurn)
  if (msg && !msg.content?.stopped && !msg.content?.error && !msg.content?.empty) await askShareAfterUse(user, threadId, own.name).catch(() => {})
  return msg
}

// The app tools an installed agent skill declares (its frontmatter metadata.include_tools): an ArtCraft
// app's (`<app>_…`) or the open-document editor's (`office_live_…`) — tool names' prefixes
const toolCache = new Map() // skill → { at, apps, office }
async function skillTools(session, name) {
  const hit = toolCache.get(name)
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit
  const declared = await getSkill(session.access_token, name).then((s) => s.tools || []).catch(() => [])
  const apps = Object.keys(CRAFT_APPS).filter((app) => declared.some((t) => String(t).startsWith(`${app}_`)))
  const out = { at: Date.now(), apps, office: declared.some((t) => String(t).startsWith('office_live_')) }
  toolCache.set(name, out)
  return out
}


// A scheduled task, run once now (lib/missions.js runMission 'manual'): its result comes to this
// conversation like a scheduled run's, under its divider — even when nothing crossed its condition.
export async function runScheduleNowTurn({ userId, threadId, s, onDelta, acked = false }) {
  let msg = null
  if (!acked) {
    const said = L(`「${s.name}」 작업을 지금 바로 한 번 실행할게요. 새 예약은 만들지 않고, 결과는 곧 여기에 올라와요.`,
      `I'll run "${s.name}" once, right now. No new schedule — the result will show up here shortly.`)
    msg = await addMessage(userId, threadId, 'agent', 'text', { text: said })
    onDelta?.(said)
  }
  await addMessage(userId, threadId, 'agent', 'chip', { icon: 'clock', text: L(`지금 실행 · ${s.name}`, `Running now · ${s.name}`), scheduleId: s.id })
  // the run is its own agent turn, outside this message's place in line (lib/turns.js)
  turnCtx.exit(() => runMission(s.id, 'manual', { threadId, test: true })).catch((e) => console.warn('[schedule] run now', e.message))
  return msg
}

// One run of the agent on a fresh variation of a shared folder, in its own conversation.
export async function folderTurn({ user, session, threadId, text, onDelta, folder }) {
  const work = await startChatWork({ user, folder, text, threadId })
  await TF.noteVariation(user, threadId, folder, work.v).catch(() => {})
  // (folder: the run's own room — the main chat does not move into it, so the next message is not
  // answered there: lib/agent.js delegate)
  pinned.set(threadId, { conversationId: work.room, title: folder.kind === 'skill' ? L(`${folder.name} 스킬 고치기`, `Fix the ${folder.name} skill`) : L(`${folder.name} 폴더 작업`, `${folder.name} folder work`), folder: true })
  const msg = await delegate({ user, session, threadId, text: work.message, onDelta })
  await finishChatWork({ user, folder, v: work.v, threadId, room: work.room, seeded: work.seeded, stopped: !!msg?.content?.stopped }).catch((e) => console.warn('[folders] chat work', e.message))
  await TF.announce(user.id, threadId).catch(() => {})
  return msg
}

// While skill-creator works its raw output (test prompts, sample data, interleaved subagent
// streams) is not for reading; the chat shows the step it is on and, at the end, a summary card.
const SKILL_STEPS = {
  task: '스킬 설계', write_file: '파일 작성', edit_file: '파일 다듬기', read_file: '자료 읽기',
  execute: '스킬 시험 실행', ls: '폴더 확인', glob: '파일 찾기', grep: '내용 찾기', write_todos: '계획 세우기',
}
const SKILL_STEPS_EN = {
  task: 'designing the skill', write_file: 'writing files', edit_file: 'polishing files', read_file: 'reading material',
  execute: 'test-running the skill', ls: 'checking the folder', glob: 'finding files', grep: 'searching contents', write_todos: 'planning',
}
const skillStatus = (tool, steps) => L(`스킬 만드는 중 · ${SKILL_STEPS[tool] || '작업'} (${steps}단계)`, `Making the skill · ${SKILL_STEPS_EN[tool] || 'working'} (step ${steps})`)

// What the person sees above the composer while the agent works (hark's "패널 만드는 중"): the tool
// the agent just reached for, in everyday words.
const PHASES = [
  [/^cadcraft_/, '도면 그리는 중'], [/^vectorcraft_/, '그림 만드는 중'], [/^photocraft_/, '이미지 편집하는 중'],
  [/^soundcraft_/, '소리 만드는 중'], [/^filmcraft_/, '영상 편집하는 중'], [/^folder_/, '폴더 살펴보는 중'],
  [/^office_live_(read|documents)|^office_guide/, '문서 읽는 중'], [/^office_live_/, '문서 고치는 중'],
  [/hwpx|docx|pptx|xlsx|office|document|render_hwp/i, '문서 만드는 중'], [/panel/i, '패널 만드는 중'],
  [/gmail|mail/i, '메일 확인하는 중'], [/calendar/i, '일정 확인하는 중'], [/youtube/i, '영상 정보 찾는 중'],
  [/slack|notion|github|drive/i, '연결된 서비스 확인하는 중'], [/search|web|fetch|browse|tavily/i, '찾아보는 중'],
  [/^(ls|glob|grep|read_file|read)$/i, '파일 살펴보는 중'], [/^(write_file|edit_file|write|edit)$/i, '파일 쓰는 중'],
  [/execute|shell|bash|python|run_code/i, '실행하는 중'], [/^task$|subagent/i, '나눠서 일하는 중'], [/todo/i, '할 일 정리하는 중'],
  [/process|bpmn|instance|workitem/i, '프로세스 확인하는 중'], [/skill/i, '스킬 쓰는 중'],
]
// the same phases in English, in PHASES order
const PHASES_EN = ['Drawing the plan', 'Making the picture', 'Editing the image', 'Making the sound', 'Editing the video', 'Looking through the folder',
  'Reading the document', 'Editing the document', 'Making the document', 'Making the panel', 'Checking mail', 'Checking the calendar', 'Looking up the video',
  'Checking connected services', 'Looking it up', 'Looking through files', 'Writing files', 'Running it', 'Splitting up the work', 'Organizing to-dos',
  'Checking the process', 'Using a skill']
export const toolPhase = (tool) => {
  const i = PHASES.findIndex(([re]) => re.test(String(tool || '')))
  return isEn() ? (PHASES_EN[i] || 'Working') : (PHASES[i] || [null, '작업하는 중'])[1]
}

const hubBound = new Set()
// long tool calls (skill-creator, CAD drawing) stream nothing for minutes, so this is generous
const STREAM_IDLE_MS = Number(process.env.PRO_STREAM_IDLE_MS) || 15 * 60_000
// what the person reads when a turn ended without an answer of its own
export const STOPPED_TEXT = '답을 멈췄어요.'
export const SUPERSEDED_TEXT = '같은 대화에서 다른 요청이 시작되어 이 답이 중간에 멈췄어요. 필요하면 다시 보내 주세요.'
export const EMPTY_TEXT = '에이전트가 아무 내용 없이 답을 끝냈어요. 같은 요청을 다시 보내 주세요.'
export const STOPPED_TEXT_EN = 'Stopped the answer.'
export const SUPERSEDED_TEXT_EN = 'Another request started in the same conversation, so this answer stopped partway. Send it again if you need it.'
export const EMPTY_TEXT_EN = 'The agent ended its answer without any content. Please send the same request again.'
const stoppedText = () => L(STOPPED_TEXT, STOPPED_TEXT_EN)
const supersededText = () => L(SUPERSEDED_TEXT, SUPERSEDED_TEXT_EN)
const emptyText = () => L(EMPTY_TEXT, EMPTY_TEXT_EN)

// The router's decision alone (context-router POST /route), for a message sent while another turn
// of the same thread is still running: it tells whether this one has to wait for that one.
async function routeFirst({ user, thread, text, ahead = [] }) {
  try {
    // the requests still being answered are offered as conversations in progress (their context
    // rows are written only when they finish)
    const contexts = ahead.map((x) => ({ conversation_id: x.conv, title: x.title || L('진행 중인 요청', 'Request in progress'), summary: `${L('진행 중인 요청', 'Request in progress')}: ${x.title || ''}`, kind: 'conversation', active: true }))
    const r = await fetch(`${config.contextRouterUrl}/route`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(120_000),
      body: JSON.stringify({ message: text, tenant_id: config.tenantId, user_uid: user.id, conversation_id: thread?.conversation_id || null, metadata: { contexts } }),
    })
    const j = r.ok ? await r.json() : null
    return j?.conversation_id ? j : null
  } catch (e) { console.warn('[delegate] route', e.message); return null }
}
// the router records each answered turn of a conversation it routed (context_threads); a turn routed
// ahead of time goes straight to the agent, so the same row is written here (router/store.py touch)
async function touchContext(user, routing, text, answer) {
  const prev = routing.context || {}
  const title = prev.title || text.trim().split('\n')[0].slice(0, 60)
  await q(`insert into context_threads(tenant_id,user_id,conversation_id,title,summary,gist,kind,turns,updated_at) values ($1,$2,$3,$4,$5,$6,$7,1,now())
           on conflict (tenant_id,user_id,conversation_id) do update set title=excluded.title, summary=excluded.summary, updated_at=now()`,
  [config.tenantId, user.id, routing.conversation_id, title.slice(0, 120), L(`최근 요청: ${text.trim().slice(0, 200)}\n최근 답: ${String(answer || '').trim().slice(0, 300)}`, `Latest request: ${text.trim().slice(0, 200)}\nLatest answer: ${String(answer || '').trim().slice(0, 300)}`).slice(0, 600), String(prev.gist || '').slice(0, 200), prev.kind || 'conversation'])
    .catch((e) => console.warn('[delegate] context', e.message))
}

// 멈추기 (POST /api/threads/:id/stop): the running agent turns of a thread are stopped through
// deepagents' own /chat/stop (the SDK cancels the turn on the server, not only the stream); a turn
// it does not know (already over, or held elsewhere) is cut off here. With no turn in flight here
// (e.g. after a restart of this server) the thread's conversation is still asked to stop, so a
// turn left running in deepagents cannot keep the conversation busy.
export async function stopTurns({ user, session, threadId, conversation }) {
  const list = turns.running({ userId: user.id, threadId, conv: conversation || null })
  const ask = async (conv) => {
    if (!conv) return false
    const r = await fetch(`${config.deepagentsUrl}/chat/stop`, {
      method: 'POST', signal: AbortSignal.timeout(20_000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}`, 'X-Tenant-Id': config.tenantId },
      body: JSON.stringify({ conversation_id: conv, tenant_id: config.tenantId }),
    }).then((x) => x.json()).catch((e) => ({ stopped: false, error: e.message }))
    return !!r.stopped
  }
  for (const t of list) {
    t.stopped = true
    // the stream ends with "turn cancelled" once deepagents stops it; if it does not, stop waiting
    const ok = await ask(t.conv)
    if (!ok) t.abort.abort()
    else setTimeout(() => { if (!t.finished) t.abort.abort() }, 8000).unref?.()
  }
  if (!list.length) {
    const thread = await getThread(user.id, threadId)
    const conv = conversation || thread?.conversation_id
    const ok = await ask(conv)
    await setThreadStatus(user.id, threadId, null)
    return { stopped: ok ? 1 : 0, waiting: turns.waiting({ userId: user.id, threadId }).length }
  }
  return { stopped: list.length, waiting: turns.waiting({ userId: user.id, threadId }).length }
}

// quietIfUnchanged: a scheduled run whose result line (MISSION_RESULT, lib/missions.js) says nothing changed
// posts nothing; resultLine: the answer ends with that line, which is taken off what the chat shows and
// handed to onResult; tools: the app tools a skill the router named declares (skillTools)
export async function delegate({ user, session, threadId, text, onDelta, silent, mode, divider, quietIfUnchanged, resultLine, onResult, hwpxTemplateUrl, fileTag, tools }) {
  let thread = await getThread(user.id, threadId)
  // a main chat left standing in a shared folder's run room (as folder turns used to leave it) does
  // not answer the next message there
  if (thread?.kind === 'chat' && thread.conversation_id && await isFolderRoom(thread.conversation_id).catch(() => false)) {
    await q('update pro_threads set conversation_id=null where id=$1 and conversation_id=$2', [threadId, thread.conversation_id])
    thread = { ...thread, conversation_id: null }
  }
  const uploads = attached.get(threadId) || []
  attached.delete(threadId)
  const pin = pinned.get(threadId)
  pinned.delete(threadId)
  // In the main chat, several things run side by side (hark): the context-router decides which
  // conversation this message continues. Projects, instances, skill authoring and scheduled
  // runs already know their conversation and go straight to the agent.
  let routed = !pin && !!config.contextRouterUrl && thread?.kind === 'chat' && mode !== 'skill' && !divider
  const conv0 = pin?.conversationId || (!routed ? thread?.conversation_id : null)
  // the place in line runTurn took when the message came in (so turns keep the order they were
  // sent in), or a new one for work started elsewhere (schedules, team assist, missions)
  const store = turnCtx.getStore()
  const adopted = store?.turn && !store.adopted && store.turn.threadId === threadId
  if (adopted) store.adopted = true
  const turn = adopted ? store.turn : turns.enqueue({ userId: user.id, threadId, conv: conv0 })
  turn.setConv(conv0)
  turn.title = String(text || '').trim().split('\n')[0].slice(0, 60)
  // a shared folder's run room (folderTurn) is never offered to the router as a conversation in progress
  turn.folder = !!pin?.folder
  // the user's message this turn answers (runTurn), marked 대기 while it waits
  const userMsgId = adopted ? store.userMsgId : null
  let routing = null
  let preRouted = false
  try {
    let marked = false
    const queued = async () => {
      if (!userMsgId || marked) return
      marked = true
      const [m] = await q(`update pro_messages set content = content || '{"queued":true}'::jsonb where id=$1 returning *`, [userMsgId])
      if (m) emit(user.id, 'message', m)
    }
    // another answer of this thread is still coming: which conversation is this one for? (a
    // second request on the same conversation would make deepagents cancel the first)
    if (routed && turns.busyThread(turn)) {
      await queued()
      const ahead = (await turns.aheadInThread(turn)).filter((x) => !x.folder)
      thread = await getThread(user.id, threadId)
      const r = await routeFirst({ user, thread, text, ahead })
      if (r) { routing = r; preRouted = true; routed = false; turn.setConv(r.conversation_id) }
    }
    let waited = (await turns.waitTurn(turn, queued)) || marked
    // a thread that had no conversation yet may have one now (the turn that went first started it)
    if (waited && !routed && !turn.conv) {
      thread = await getThread(user.id, threadId)
      if (thread?.conversation_id) { turn.setConv(thread.conversation_id); waited = (await turns.waitTurn(turn, queued)) || waited }
    }
    if (waited && userMsgId) {
      const [m] = await q(`update pro_messages set content = (content - 'queued') || '{"dequeued":true}'::jsonb where id=$1 returning *`, [userMsgId])
      if (m) emit(user.id, 'message', m)
      thread = await getThread(user.id, threadId)
    }
    return await runDelegated()
  } finally { turn.finish() }

  async function runDelegated() {
  // the main chat now stands in that conversation, so an unsure next message stays there too —
  // except a shared folder's run room: that room is one variation's work, finished with this turn
  // (an ordinary message or a Home card answered there edited the folder's checkout)
  if (pin && !pin.folder) await q('update pro_threads set conversation_id=$2 where id=$1', [threadId, pin.conversationId])
  if (preRouted) await q('update pro_threads set conversation_id=$2 where id=$1', [threadId, routing.conversation_id])
  await setThreadStatus(user.id, threadId, 'working')
  // tools that need no account (CADCraft) are bound once per user per server start
  if (!hubBound.has(user.id)) { hubBound.add(user.id); await ensureHubBinding(user.id, config.tenantId).catch(() => {}) }
  // the app open in the page lists its tools to the agent (mcp/craft.js), and so do the apps a skill the
  // router named declares (metadata.include_tools) — a state and a skill's data, never the message's words
  // (or the document the page said is open with this message, when its live link is down)
  const live = !silent && !divider ? liveOpen(user.id) || (adopted && store.openDoc) || null : null
  if (live?.fromPage) console.log(`[delegate] open document from the page: '${live.file}' (${live.editor || '?'}) user=${user.id.slice(0, 8)} — live link down`)
  activateCraft(user.id, [...(tools?.apps || []), ...(live ? [live.app] : [])])
  if (live?.app === 'ieumoffice' || tools?.office) activateOffice(user.id)
  // a stalled agent (no byte for STREAM_IDLE_MS) is cut off, so the chat never sits on "생각하는 중" for good
  const idle = new AbortController()
  let idleTimer = setTimeout(() => idle.abort(), STREAM_IDLE_MS)
  const alive = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => idle.abort(), STREAM_IDLE_MS) }
  // 검수 (lib/review.js): what is open now, as it is before the agent's edits
  const before = live ? await capture({ userId: user.id, jwt: session.access_token, open: live }) : null
  const usedTools = new Set()
  let partial = ''
  // a project with a folder works on its own variation of it; a chat with one attached reads its main
  // (lib/folders/threadFolders.js) — not a shared folder's run room (folderTurn: its message says where)
  let projectWork = null, failed = false
  if (!pin?.folder && (thread?.kind === 'project' || thread?.kind === 'chat')) {
    projectWork = await TF.prepareProjectWork({ user, thread }).catch((e) => { console.warn('[folders] project work', e.message); return null })
    if (projectWork) { thread = { ...thread, conversation_id: projectWork.conv }; turn.setConv(projectWork.conv); text += projectWork.note }
    else {
      const ref = await TF.linkOf(threadId).catch(() => null)
      const hint = ref ? await TF.refHint(ref).catch(() => '') : ''
      if (hint) { text += hint; console.log(`[folders] reference hint: '${ref.slug}' thread=${String(threadId).slice(0, 8)}`) }
    }
  }
  try {
    const msg = await streamTurn()
    // an edit tool of the open app or document ran: check the result against the request
    const prefix = live?.app === 'ieumoffice' ? /^office_live_(write|replace|apply_ops|hwp_)/ : new RegExp(`^${live?.app}_`)
    if (before && !turn.stopped && [...usedTools].some((t) => prefix.test(t) && !/(inspect|read|list|render|preview|find|query|guide|documents)/.test(t))) {
      await reviewTurn({ user, session, threadId, request: text.split('\n\n(')[0], open: live, before })
    }
    return msg
  } catch (e) {
    failed = true
    if (!idle.signal.aborted && !turn.abort.signal.aborted && !/fetch failed|ECONNREFUSED|deepagents \d/.test(e.message)) throw e
    console.warn('[delegate]', turn.abort.signal.aborted ? 'stopped by the user' : idle.signal.aborted ? 'agent stream idle, aborted' : e.message)
    await setThreadStatus(user.id, threadId, null)
    if (turn.abort.signal.aborted) return addMessage(user.id, threadId, 'agent', 'text', { text: [partial.trim(), `(${stoppedText()})`].filter(Boolean).join('\n\n'), stopped: true, silent })
    const why = idle.signal.aborted ? 'agent stream idle' : causeOf(e)
    onResult?.({ result: null, error: why, ended: false })
    return addMessage(user.id, threadId, 'agent', 'text', { error: true, text: idle.signal.aborted
      ? L('에이전트가 한동안 응답하지 않아 기다리기를 멈췄어요. 같은 요청을 다시 보내 주세요.', "The agent didn't respond for a while, so I stopped waiting. Please send the same request again.")
      : L(`에이전트에 연결하지 못했어요. 잠시 후 다시 보내 주세요. (${causeOf(e)})`, `I couldn't reach the agent. Please send it again in a moment. (${causeOf(e)})`) })
  } finally {
    clearTimeout(idleTimer)
    // what the agent changed goes into the project's variation (commit; no merge card — the header's 반영 merges)
    if (projectWork) await TF.finishProjectWork(projectWork, { stopped: failed || turn.stopped || turn.abort.signal.aborted }).catch((e) => console.warn('[folders] project commit', e.message))
  }

  async function streamTurn() {
  // attachments are indexed for the conversation they go to (lib/attachments.js), so a new
  // conversation gets its id here — the SDK keeps a conversation_id it is given. The router's
  // choice is not known yet, so routed turns send theirs by address only.
  let conv = turn.conv || pin?.conversationId || thread?.conversation_id || null
  // (a scheduled run too: deepagents keeps the history of a chat sent without one under one shared key,
  // so every such first turn would carry all the earlier ones — 270k tokens and other people's runs)
  if (!conv && !routed && (uploads.length || divider)) conv = crypto.randomUUID().replace(/-/g, '')
  const sent = conv && !routed ? await indexForRoom(uploads, conv) : uploads
  const res = await connect(() => fetch(`${routed ? config.contextRouterUrl : config.deepagentsUrl}/chat/stream`, {
    signal: AbortSignal.any([idle.signal, turn.abort.signal]),
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}`, 'X-Tenant-Id': config.tenantId },
    body: JSON.stringify({
      // what the person said, then only system facts: the open document (and the skill that edits it,
      // pinned by deepagents from a leading /name), the attachments, the workspace, the company's hwpx
      // template, and — English mode — the language instruction last. How to use a tool or a site is
      // in the agent's skills, not here (design 4).
      message: livePin(live, text) + text + liveFact(live) + attachmentHint(sent) + workspaceHint(user, turn.conv) + templateFact(hwpxTemplateUrl || config.hwpxTemplateUrl) + langInstruction(), message_uuid: crypto.randomUUID(), tenant_id: config.tenantId,
      files: chatFiles(sent),
      user_uid: user.id, user_email: user.email, user_name: user.name, user_jwt: session.access_token,
      conversation_id: conv, stream: true,
      metadata: { client: 'pgpt-pro', style: isEn() ? 'English, concise, first person. Use a markdown "# Title" first line only for long structured documents.' : 'Korean 해요체, concise. Use a markdown "# 제목" first line only for long structured documents.',
        ...(isEn() ? { language: 'en' } : {}),
        ...(routed ? { auto_route: true, route_text: text, agent: 'deepagents' } : {}) },
    }),
  }), () => idle.signal.aborted || turn.abort.signal.aborted)
  if (!res.ok) throw new Error(`deepagents ${res.status}${await refusal(res)}`)
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = '', out = '', event = ''
  const files = []
  const started = Date.now()
  const runDirs = new Set()
  let processResult = null
  let workDir = null
  let skillDraft = null
  let steps = 0
  let cancelled = false
  // the stream's own signals: an error event (not a cancel), a question asked through the agent's
  // human-input tool (its options become the answer's choices), skill-creator at work
  let streamError = null
  let hitl = null
  let skillMode = mode === 'skill'
  // provenance (lib/provenance.js): what this turn wrote, every workspace path it touched, and the
  // documents tool results carried, kept apart until the end
  const written = new Set()
  const seen = new Set()
  const toolDocs = []
  const inputs = new Map() // tool -> arguments of its last call
  // what this answer did on the way, shown under it (lib/workTrail.js: steps and the sites read, no commands)
  const trail = createTrail()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    alive()
    buf += dec.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop()
    for (const line of lines) {
      if (line.startsWith('event:')) { event = line.slice(6).trim(); continue }
      if (!line.startsWith('data:')) continue
      let j
      try { j = JSON.parse(line.slice(5)) } catch { continue }
      if (event === 'metadata' && j.routing) {
        routing = j.routing
        turn.setConv(j.conversation_id)
        // the thread follows the context the user is in now, so an unsure next message stays there
        await q('update pro_threads set conversation_id=$2 where id=$1', [threadId, j.conversation_id])
      } else if (event === 'metadata' && j.conversation_id) {
        turn.setConv(j.conversation_id)
        if (!thread?.conversation_id && !pin?.folder) await q('update pro_threads set conversation_id=$2 where id=$1', [threadId, j.conversation_id])
      }
      if (j.type === 'token' && j.content) { out += j.content; partial = out; if (!skillMode) onDelta?.(j.content) }
      // deepagents ends a turn that waits for the person with a done event whose content is its
      // human_input_required payload (core/chat/hitl.py): the question and its options
      if (j.type === 'done' && typeof j.content === 'string' && j.content.trimStart().startsWith('{')) {
        try { const h = JSON.parse(j.content); if (h?.type === 'human_input_required') hitl = h } catch { /* a plain final answer */ }
      }
      const art = j.type === 'file_artifact' ? generationArtifact(j.path) : {}
      if (art.skill) skillDraft = art.skill
      const room = j.type === 'file_artifact' && /^\/workspace\/\.bpmn\/[^/]+\//.exec(j.path || '')
      if (room) runDirs.add(room[0])
      // (a url event is deepagents collecting a path the answer named — not proof the turn wrote it)
      if (j.type === 'file_artifact' && j.path && !j.replay && !j.url) { written.add(j.path); seen.add(j.path) }
      if (art.def) workDir = art.def
      if (art.gen) workDir ||= art.gen
      else if (art.def) { /* the definition (the draft card shows it) */ }
      else if (art.evalRun) { /* a skill's evaluation run (skill-creator), not the turn's output */ }
      else if (j.type === 'file_artifact' && /\/skills\/[^/]+\//.test(j.path || '')) { /* part of a skill draft */ }
      // deepagents sends every file of the folder again at the end of a generation (replay) — what this
      // turn wrote already came as its own event; the rest are earlier turns' files
      else if (j.type === 'file_artifact' && j.replay) { /* not this turn's document */ }
      // a text document the agent's own work wrote (a skill, a process folder) is not a card
      else if (j.type === 'file_artifact' && textDoc(j.path) && workFile(j.path)) { /* part of the work */ }
      else if (j.type === 'file_artifact' && j.name && !/\.(form|json)$/.test(j.name)) {
        // deepagents keeps a turn's documents in storage and names them with a signed url (it
        // expires): the card gets its own copy from there when this server cannot see the sandbox.
        // It also stores every document the answer names, read or not: those are checked at the end
        // (collected). Written, then edited in the same turn: one card.
        const had = files.find((f) => f.path === j.path)
        if (had) { if (j.url) had.src = j.url; else delete had.collected }
        else files.push({ name: j.name, path: j.path, ext: j.ext, ...(j.url ? { src: j.url, collected: true } : {}) })
      }
      // office-mcp / IeumOffice MCP results carry a storage URL: those open straight in the editor —
      // when they are this turn's output, not a document the agent only opened (checked at the end)
      if (j.type === 'tool_end' || j.type === 'tool_result') {
        const raw = j.output ?? j.result ?? j.content
        for (const p of workspacePaths(raw)) seen.add(p)
        const doc = documentFrom(raw)
        const tool = j.tool || j.tool_name || ''
        if (doc && !toolDocs.some((d) => d.doc.url === doc.url)) toolDocs.push({ doc, tool, input: inputs.get(tool) ?? null, raw: parseToolOutput(raw)?.file_name || parseToolOutput(raw)?.fileName || doc.name })
      }
      if (j.type === 'process_result' && j.data?.processDefinition) processResult = j.data
      if (j.type === 'tool_start') {
        const tool = j.tool || j.tool_name || j.name || ''
        // skill-creator's SKILL.md read (a path of the system skill's folder): its raw output is not for
        // reading — the chat shows the step it is on and, at the end, a summary card
        if (!skillMode && workspacePaths(j.input).concat(String(j.input?.file_path || j.input?.path || '')).some((p) => /\/skill-creator\/SKILL\.md$/.test(p))) skillMode = true
        usedTools.add(tool)
        inputs.set(tool, j.input ?? null)
        trail.add(tool, j.input, toolPhase(tool))
        for (const p of workspacePaths(j.input)) seen.add(p)
        steps += 1
        emit(user.id, 'status', { threadId, text: skillMode ? skillStatus(tool, steps) : toolPhase(tool) })
      }
      if (j.type === 'error') {
        const why = String(j.message || j.error || '')
        // the SDK ended the turn: our own 멈추기, or another request on this conversation
        if (/turn cancelled/i.test(why)) cancelled = true
        else { streamError = why || 'error'; out += L(`\n\n(오류: ${why})`, `\n\n(error: ${why})`) }
      }
    }
  }
  await setThreadStatus(user.id, threadId, null)
  let body = out.trim()
  const ended = cancelled || turn.stopped
  // a turn that wrote a process definition ends with its draft card, not a skill card for a skill
  // the generation picked up along the way
  if (skillDraft && !ended && !workDir) {
    // The card carries the skill itself; the agent's long write-up stays folded inside it.
    const host = await workspaceHostPath(skillDraft.dir).catch(() => null)
    const markdown = host ? await fs.readFile(`${host}/SKILL.md`, 'utf8').catch(() => '') : ''
    const files = host ? await listFolder(host) : []
    const summary = summarizeSkill(markdown)
    const draft = await addMessage(user.id, threadId, 'agent', 'skill_draft', {
      ...skillDraft, ...summary, name: skillDraft.name, markdown, files, note: body.slice(0, 6000), state: 'draft',
    })
    return draft
  }
  // a scheduled run's result line (our own output contract): parsed, and not part of what the chat shows
  const result = resultLine ? parseResult(body) : null
  if (resultLine) body = body.replace(/^.*MISSION_RESULT:.*$/gm, '').trim()
  onResult?.({ result, error: streamError, ended })
  if (quietIfUnchanged && !ended && !streamError && result && result.changed === false) return null
  // the agent asked through its human-input tool: its question is the answer when nothing else was written
  if (hitl && !body.trim()) body = [hitl.question, hitl.context].filter(Boolean).join('\n\n')
  if (divider) await addMessage(user.id, threadId, 'system', 'divider', typeof divider === 'string' ? { text: divider } : divider)
  if (ended) body = [body, `(${turn.stopped ? stoppedText() : supersededText()})`].filter(Boolean).join('\n\n')
  let kind = /^#\s/.test(body) ? 'doc' : 'text'
  const structured = (body.match(/^\s*([-*]|\d+\.)\s/gm) || []).length >= 4
  if (kind === 'text' && !ended && body.length > 600 && structured) {
    // hark-style document card: short serif title over the body
    const t = await chat({ model: config.llm.fastModel, temperature: 0, messages: [
      { role: 'system', content: L('다음 문서의 제목을 8~20자 한국어로. 제목만.', 'A title for the following document: 3 to 8 English words. Only the title.') }, { role: 'user', content: body.slice(0, 1500) }] })
    body = `# ${t.content.replace(/^#+\s*|["']/g, '').trim()}\n${body}`
    kind = 'doc'
  }
  // which context answered (hark shows replies under their own thread): title, how sure, by whom
  const context = pin && !routing ? { title: pin.title, action: 'continue', conversationId: pin.conversationId, strategy: 'pinned', confidence: 1 }
    : routing && routing.action !== 'stay' ? {
    title: routing.context?.title || text.trim().split('\n')[0].slice(0, 40),
    action: routing.action, conversationId: routing.conversation_id,
    confidence: routing.decision?.confidence, strategy: routing.decision?.strategy, model: routing.decision?.model,
    escalated: (routing.decision?.notes || []).some((n) => n.startsWith('escalated')),
    // the judge chose a context nothing in the message pointed to, so the router asked again
    rechecked: (routing.decision?.notes || []).some((n) => n.includes('re-decided')),
  } : routing ? { title: routing.context?.title, action: 'stay', confidence: routing.decision?.confidence, strategy: routing.decision?.strategy } : null
  // only this turn's output becomes a file card: written now, in this conversation's folder, or
  // changed on disk since it started — never a document the agent opened for reference
  const rooms = [roomOf(turn.conv), ...runDirs].filter(Boolean)
  const ctx = { rooms, written, since: started - 2000 }
  for (const t of toolDocs) {
    const { keep, src } = await keepToolDoc({ name: t.raw, tool: t.tool, input: t.input }, seen, ctx)
    if (!keep) { console.log(`[delegate] not attached (not this turn's output): ${src || t.doc.name}`); continue }
    if ((src && evalRun(src)) || workspacePaths(t.input).some(evalRun)) { console.log(`[delegate] not attached (a skill's test run): ${src || t.doc.name}`); continue }
    if (files.some((f) => f.url === t.doc.url)) continue
    // a republished copy keeps the name of the file it came from
    files.push(src ? { ...t.doc, name: src.split('/').pop(), path: src } : t.doc)
  }
  // why a document found by its path (named in the answer, in the folder) is not this turn's output
  const notOutput = async (p) => {
    // the answer often lists the skill test step's outputs (<room>/.skill-evals/…/outputs/*.dxf): named,
    // but test runs, not what the person asked for — the same as their file_artifact events above
    if (evalRun(p)) return "a skill's test run"
    // a text document: only a file this turn wrote or changed — not a note it read in this folder, not the
    // other files of a shared folder's checkout, not a process folder's or a skill's own files
    const text = textDoc(p)
    if (text && (workFile(p) || (checkoutFile(p) && !written.has(p)))) return 'work file'
    if (!(await isOutput(p, text ? { ...ctx, strict: true } : ctx))) return "not this turn's output"
    return null
  }
  for (const f of [...files]) {
    if (!f.collected) continue
    delete f.collected
    const why = written.has(f.path) ? null : await notOutput(f.path)
    if (why) { console.log(`[delegate] not attached (${why}): ${f.path}`); files.splice(files.indexOf(f), 1) }
  }
  const empty = !body && !files.length && !workDir
  if (empty) body = emptyText()
  const work = trail.list()
  // choices under the answer: the options of the agent's own question, or — a process draft waiting for
  // the person (the generation is still pending and no definition came) — going ahead with it
  const choices = hitl?.options?.length ? hitl.options.filter((o) => o?.label).slice(0, 6).map((o) => ({ label: String(o.label).slice(0, 80), ...(o.description ? { hint: String(o.description).slice(0, 120) } : {}), to: 'agent' }))
    : generationPending(threadId) && !workDir && !ended && !streamError ? [{ label: L('이대로 진행', 'Go ahead as is'), reply: { kind: 'approve' } }] : []
  const msg = await addMessage(user.id, threadId, 'agent', kind, { text: body, silent, ...(work.length ? { work } : {}), ...(context ? { context } : {}), ...(ended ? { stopped: true, ...(turn.stopped ? {} : { superseded: true }) } : {}),
    ...(streamError ? { error: true } : {}), ...(empty ? { empty: true } : {}), ...(choices.length ? { choices } : {}), ...(result ? { result } : {}) })
  if (preRouted) touchContext(user, routing, text, body)
  // documents made by the agent's own scripts (no file_artifact event) are found and added too
  for (const f of files) if (f.url && !f.path) f.name = displayName(f, body)
  for (const p of await documentsOfRun({ text: body, dirs: rooms, since: started - 2000 }).catch(() => [])) {
    // office-mcp already published this one (store_and_render): one card per document
    const name = p.split('/').pop()
    if (files.some((f) => f.path === p || (f.url && f.name === name))) continue
    const why = await notOutput(p)
    if (why) { console.log(`[delegate] not attached (${why}): ${p}`); continue }
    files.push({ name, path: p })
  }
  // the script that built a document is scaffolding; the document is what the user asked for (and
  // a turn that was stopped leaves no half-run scripts behind as results)
  if (ended || files.some((f) => editable(f.name))) files.splice(0, files.length, ...files.filter((f) => !/\.(py|js|mjs|ts|sh)$/.test(f.name)))
  for (const f of files) {
    // a document the agent wrote in its sandbox is published so the editor can load it
    if (!f.url && f.path && editable(f.name)) Object.assign(f, await publish(user.id, f.path, f.src).catch((e) => { console.warn('[office publish]', e.message); return {} }))
    delete f.src
    // fileTag: what the card belongs to, e.g. the mail whose draft it is (lib/mining/recorder.js)
    await addMessage(user.id, threadId, 'agent', 'file', { ...f, ...(fileTag || {}) })
  }
  // The draft card is the definition this turn wrote, read back from its folder the way saving reads
  // it (lib/generated.js) — not the first definition-shaped JSON in the stream: deepagents used to send
  // whatever the agent read first (the skill's schema sample "휴가 신청 프로세스", another saved
  // process). A turn that wrote no definition (the consulting draft) has no card.
  const contract = workDir && !ended ? await draftContract(workDir, processResult) : null
  if (contract) {
    generationDone(threadId)
    await addMessage(user.id, threadId, 'agent', 'process_draft', { contract, workDir, state: 'draft' })
  }
  return msg
  }
  }
}

// What a file the agent wrote (file_artifact) is to a process generation:
//   def   — the folder of the definition this turn wrote (or completion rewrote): process-<id>/, or a
//           folder the model named itself (deepagents process_work_dirs takes that one too)
//   gen   — a process folder the file is in (forms, agents …)
//   skill — a skill-creator draft (<conversation base>/skills/<name>/SKILL.md); the skills inside a
//           process folder (process-*/skills/) belong to that process and are not a draft
//   evalRun — a file of a skill's evaluation runs (<room>/.skill-evals/…): no file card
// a file of a skill's test runs (deepagents' skill test step, also inside a process generation: plan_skill_eval
// → <room>/.skill-evals/<skill>/iteration-N/<case>/<with|without>_skill/outputs/…), however it reached the turn
export const evalRun = (path) => /\/\.skill-evals\//.test(String(path || ''))
export function generationArtifact(path) {
  const p = String(path || '')
  const def = /\/\.bpmn\/[^/]+\/(?:[^/.][^/]*\/)?process-definition\.json$/.exec(p)
  const gen = /\/\.bpmn\/[^/]+\/process-[^/]+\//.exec(p)
  const skill = !/\/\.bpmn\/[^/]+\/process-[^/]+\/skills\//.test(p) && /^(.*\/skills\/([^/]+))\/SKILL\.md$/.exec(p)
  return { def: def ? def[0].replace(/process-definition\.json$/, '') : null, gen: gen ? gen[0] : null, skill: skill ? { dir: skill[1], name: skill[2] } : null,
    ...(evalRun(p) ? { evalRun: true } : {}) }
}

// The draft card's contract: the definition in the folder a turn wrote (workDir), assembled the way
// saving assembles it; when that cannot run, the definition file itself (the streamed contract only
// when it is that same definition — it carries the forms).
export async function draftContract(workDir, streamed, rebuild = generatedContract) {
  const built = await rebuild(workDir).catch(() => null)
  if (built?.processDefinition) return built
  const host = await workspaceHostPath(`${workDir.replace(/\/$/, '')}/process-definition.json`).catch(() => null)
  let pd = null
  try { pd = JSON.parse(await fs.readFile(host, 'utf8')) } catch { return null }
  pd = pd?.processDefinition || pd
  if (!pd || typeof pd !== 'object' || !(pd.processDefinitionName || pd.elements || pd.activities)) return null
  if (streamed?.processDefinition && streamed.processDefinition.processDefinitionName === pd.processDefinitionName) return streamed
  return { type: 'process-definition-result', processDefinition: pd, forms: [], agents: [], skills: [] }
}


// The company's hwpx template (settings): a fact the agent's hwpx skill uses whenever it is set. A
// sandbox reaches this server's own address by the Docker host name (an address's format).
export function templateFact(url) {
  if (!url) return ''
  const inSandbox = url.replace(/\/\/(127\.0\.0\.1|localhost)(?=[:/])/, '//host.docker.internal')
  return L(`\n\n(회사 한글(hwpx) 양식: ${url}${inSandbox !== url ? ` — 샌드박스에서는 ${inSandbox}` : ''})`, `\n\n(Company Hangul (hwpx) template: ${url}${inSandbox !== url ? ` — from the sandbox: ${inSandbox}` : ''})`)
}

// Process design runs on process-gpt's own bpmn-process-generation-skill in deepagents.
// The skill pauses for a draft review. When the person agrees — the draft card's "go ahead" choice — the
// requirement is restated with that agreement; an answer in words goes to the agent with what is being
// designed, and the agent (the skill's review step) reads whether it agrees.
const generating = new Map() // threadId -> requirement
// what the person agreed to, as a fact: the steps after the review are the skill's own (its SKILL.md and
// references), not repeated here (design 4.3); English mode: the names a person sees are English too
const GEN_STEPS = '사용자가 흐름 초안에 동의했어요. bpmn-process-generation-skill 의 나머지 단계를 이번 턴에 끝까지 진행하세요.'
const GEN_STEPS_EN = 'The user agreed to the draft flow. Carry out the remaining steps of bpmn-process-generation-skill in this turn, to the end. Every name and text a person sees in the definition is in English.'

export function generationPending(threadId) { return generating.get(threadId) }
export function generationDone(threadId) { generating.delete(threadId) }
export function generationPrompt(threadId, text, { approved = false } = {}) {
  const req = generating.get(threadId)
  if (approved) return L(`${text}\n\n요구사항(다시 확인): ${req}\n${GEN_STEPS}`, `${text}\n\nRequirements (restated): ${req}\n${GEN_STEPS_EN}`)
  return L(`${text}\n\n(프로세스 설계 중 — 요구사항: ${req})`, `${text}\n\n(designing a process — requirements: ${req})`)
}

export async function processTurn(userId, threadId, args) {
  if (args.intent === 'create') {
    generating.set(threadId, args.query || '')
    const guide = await systemGuide().catch(() => '')
    const [p] = await q('select email, name from pro_profile where user_id=$1', [userId])
    const { sessionFor } = await import('./supa.js')
    const { user, session } = await sessionFor(p.email, p.name)
    await delegate({ user, session, threadId,
      text: isEn()
        ? `Use bpmn-process-generation-skill to design a new process definition. First propose a draft of the flow and get it confirmed.\nRequirements: ${args.query}\nWrite the draft and, later, every name in the definition (process, roles/lanes, activities, events, gateways, conditions, forms and their fields, agents and their instructions) in English.${guide ? `\n\n### External systems guide (systems registry)\n${guide}\nMake a step that connects to an external system a serviceTask and set its tool to "mcp:<tool name>".` : ''}`
        : `bpmn-process-generation-skill 을 사용해서 새 프로세스 정의를 설계해 주세요. 먼저 흐름 초안을 제안하고 확인을 받아 주세요.\n요구사항: ${args.query}${guide ? `\n\n### 외부 시스템 가이드 (systems 레지스트리)\n${guide}\n외부 시스템과 연결되는 단계는 serviceTask 로 두고 tool 을 "mcp:<도구명>" 으로 지정한다.` : ''}` })
    return
  }
  // start / view: the process the router picked from the facts (its id); none — the catalogue to choose from
  const defs = args.intent === 'instances' || args.intent === 'my_todos' ? [] : await listDefinitions()
  const d = args.process ? defs.find((x) => x.id === args.process) : null
  if (args.intent === 'catalog' || ((args.intent === 'start' || args.intent === 'view') && !d)) {
    await addMessage(userId, threadId, 'agent', 'catalog', { items: defs.slice(0, 12) })
    return
  }
  if (args.intent === 'start' || args.intent === 'view') {
    await addMessage(userId, threadId, 'agent', 'process', { defId: d.id, name: d.name, mode: args.intent, prefill: args.prefill || {} })
  } else if (args.intent === 'instances') {
    const [{ email }] = await q('select email from pro_profile where user_id=$1', [userId])
    const list = await listInstances({ userEmail: email, userId, status: 'RUNNING', limit: 8 })
    await addMessage(userId, threadId, 'agent', 'instances', { items: list })
  } else if (args.intent === 'my_todos') {
    const [{ email }] = await q('select email from pro_profile where user_id=$1', [userId])
    const list = await myTodos({ id: userId, email })
    if (!list.length) await addMessage(userId, threadId, 'agent', 'text', { text: L('지금 기다리고 있는 할 일은 없어요.', 'No to-dos are waiting for you right now.') })
    // one list: each to-do opens its instance page, where its form is (not a form card per to-do in the
    // chat — the work belongs to its instance's context, 2026-11-18)
    else await addMessage(userId, threadId, 'agent', 'instances', {
      title: L(`기다리는 내 할 일 ${list.length}건`, `${list.length} to-dos waiting for you`),
      items: list.slice(0, 8).map((t) => ({ proc_inst_id: t.proc_inst_id, proc_inst_name: t.proc_inst_name, def_name: t.def_name, status: 'RUNNING', needs_me: true, activity: t.activity_name })),
    })
  }
}

// Reaching the agent for a turn: a refused connection or a gateway that has no agent to hand the turn to
// yet (502/503/504 — a pod starting or being replaced) means the turn never started, so it is tried again
// a moment later, twice, before the chat says it could not reach the agent. Any other answer is final.
export async function connect(open, stopped = () => false, waits = [3000, 8000]) {
  for (let i = 0; ; i++) {
    let res, err
    try { res = await open() } catch (e) { err = e }
    const transient = err ? /fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket hang up/i.test(`${err.message} ${err.cause?.code || ''}`) : [502, 503, 504].includes(res.status)
    if (!transient || i >= waits.length || stopped()) { if (err) throw err; return res }
    console.warn('[delegate] agent not reachable, trying again:', err ? err.message : `${res.status}${await refusal(res)}`)
    await new Promise((r) => setTimeout(r, waits[i]))
  }
}
// why the agent's address refused a turn, from the body it answered with: the session router in front
// of the runners says which of its failures it was ({"error":"agent runner unreachable"} — no runner
// answered — or "could not start an agent runner for this conversation"), FastAPI says {"detail": …}.
// ": <reason>", or '' when the body says nothing readable.
export async function refusal(res) {
  const t = await res.text().catch(() => '')
  let why = t
  try { const j = JSON.parse(t); why = j.error || j.detail || j.message || '' } catch { /* not JSON: an HTML page from a proxy says nothing */ if (/^\s*</.test(t)) why = '' }
  why = String(typeof why === 'string' ? why : JSON.stringify(why)).replace(/\s+/g, ' ').trim().slice(0, 100)
  return why ? `: ${why}` : ''
}
// what the chat shows after "에이전트에 연결하지 못했어요": the status and the reason the agent's address gave,
// or the network error, so a failure on a server whose logs nobody can read still says why
// ("deepagents 502: agent runner unreachable", "ECONNREFUSED")
export const causeOf = (e) => (/^deepagents \d{3}(: |$)/.test(e?.message || '') ? e.message.slice(0, 130) : e?.cause?.code || String(e?.message || 'error').slice(0, 60))
