// Turn orchestration. A quick routing call picks what the turn needs; general work is
// delegated to process-gpt's deepagents (/chat/stream) and streamed back verbatim.
import { config } from '../config.js'
import { chat } from './llm.js'
import { q } from './supa.js'
import { addMessage, history, getThread, setThreadStatus } from './store.js'
import { runBrowserTask, runningIn, waitingIn, activeIn, answerWaiting, steer as steerBrowser } from './browser.js'
import * as BQ from './browserQueue.js'
import { createSchedule, nextRun, cronAfter, dueAt, listSchedules } from './scheduler.js'
import { createMission, createProcessSchedule, listSkills, workspaceHostPath, runMission } from './missions.js'
import { wantsRunNow, telegramIntent, pickSchedule, recentScheduleIds, channelsOf } from './scheduleIntent.js'
import { createTrail } from './workTrail.js'
import { marketHint, stripInventedCodes } from './marketHint.js'
import { summarizeSkill, listFolder } from './skills.js'
import { generatedContract } from './generated.js'
import fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { standInPath } from './craftWork.js'
import { generatePanel } from './panels.js'
import * as PanelApps from './panelApps/service.js'
import { valuesFromText } from './panelApps/sheet.js'
import { emit } from './bus.js'
import { listDefinitions, listInstances, myTodos, getDefinition } from './processes.js'
import { systemGuide } from './systems.js'
import { listTeam, listAssignments, resolveMember } from './team.js'
import { notifyMember } from './notify.js'
import { craftAppsFor, displayName, documentFrom, documentsOfRun, editable, officeHint, parseToolOutput, publish } from './office.js'
import { AsyncLocalStorage } from 'node:async_hooks'
import * as llmKeys from './llmKeys.js'
import * as turns from './turns.js'
import { refer as referContext } from './context/refer.js'
import { rebuildSoon } from './context/digest.js'
import { findRepeat } from './context/repeat.js'
import { afterTurn, followsResult, readAnswer, readRule, whenText } from './followups.js'
import { ranRule, readRoom, roomGoal, ruleAction, ruleOf } from './roomRules.js'
import { browserSkill, browserSkills } from './browserSkills.js'
import { judge } from './judge.js'
import { isOutput, keepToolDoc, roomOf, workspaceHint, workspacePaths, textDoc, workFile, checkoutFile } from './provenance.js'
import { activateCraft } from '../mcp/craft.js'
import { activateOffice } from '../mcp/office.js'
import { liveOpen, liveHint, openDocOf } from './craftLive.js'
import { capture, reviewTurn } from './review.js'
import { editsSince, editVerdict, notAppliedAnswer } from './officeEdits.js'
import { attachmentHint, indexForRoom, chatFiles } from './attachments.js'
import { ensureHubBinding } from '../mcp/connectors.js'
import { folderFor, isFolderRoom, startChatWork, finishChatWork } from './folders/work.js'
import { privateSkillFor, askShareAfterUse } from './folders/skills.js'
import * as TF from './folders/threadFolders.js'
import * as PT from './projectTopics.js'
import { resolveProcess, brief as improveBrief } from './improve/service.js'
import { L, isEn, locale, langInstruction, langOf, withLang } from './lang.js'
import { sendMail, demoFiles } from './scenarios/mail.js'
import * as TP from './turnPlan.js'
import { oddsOf, TURN_ODDS_MS } from './decide.js'

// Files attached to the turn being handled, picked up by the deepagents call that answers it.
const attached = new Map() // threadId -> [{name, path, url, type, size}]
// A turn sent from inside one conversation's view goes to that conversation, not to the router.
const pinned = new Map() // threadId -> {conversationId, title}

const ROUTER_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'process',
      description: 'Business processes (프로세스, 업무 절차, 결재, 신청, 접수, 심사 …): start one, show what a process looks like, list running instances, or show my pending work items (할 일, 결재 대기). NOT for creating a skill (스킬 만들어줘) — skill requests are answered without tools.',
      parameters: {
        type: 'object',
        properties: {
          intent: { type: 'string', enum: ['start', 'view', 'catalog', 'instances', 'my_todos', 'create', 'edit_map'], description: 'catalog = list which processes exist; create = design a NEW process definition from a description; edit_map = change one of the company process map\'s processes by words, or say an improvement for it («○○ 프로세스에서 … 바꿔 줘», «… 뒤에 …를 넣어 줘», «…는 에이전트가 하게», «… 바꾸면 좋겠어요»)' },
          query: { type: 'string', description: 'process name or keywords (start/view), the full requirement for a new process (create), or the change in the user\'s own words (edit_map)' },
          process: { type: 'string', description: 'edit_map: the name of the process on the company process map the change is for, as the user said it (empty when unsure)' },
          prefill: { type: 'object', description: 'form values the user already gave, keyed by meaning (e.g. customer, qty)' },
          ack: { type: 'string', description: '해요체 한 문장' },
        },
        required: ['intent', 'ack'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_task',
      description: 'The request needs a real web browser: log in to a site, check an account balance, book, order, fill a web form, operate a web console — or the person wants the work done on a site that one of the browser skills (listed in the system message) is for, even when what they hand over is a link to another service. NOT for YouTube, Google (Gmail/Calendar/Drive), Slack, GitHub or Notion lookups: answer those without tools — the agent tries their connector tools first and opens the browser itself when they fail.',
      parameters: { type: 'object', properties: {
        goal: { type: 'string', description: 'Self-contained: what to do and on what, with the links (and the names of files) the person gave for it — from earlier messages too when this message refers to them' },
        start_url: { type: 'string', description: 'An address to open first. With a skill, leave it out unless the person gave a page on that site: the skill knows where to start' },
        skill: { type: 'string', description: 'The exact name of the browser skill (listed in the system message) for this work, if one is for it' },
        ack: { type: 'string', description: '해요체 한두 문장으로 무엇을 할지 알림' } }, required: ['goal', 'ack'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'schedule_task',
      description: 'User wants something NEW done repeatedly or at a time (매일, 매주, 30분마다, 장중에, 내일 아침…). NOT for running a task that is already scheduled (listed in the system message) right now — that is run_schedule_now.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '짧은 작업 이름' },
          cron: { type: 'string', description: '5-field cron in Asia/Seoul local time. Leave out when in_minutes is given' },
          in_minutes: { type: 'integer', description: 'For one run a number of minutes from now ("3분 뒤에 한 번만"): the minutes. It runs once' },
          once: { type: 'boolean', description: 'true when it should run only one time at the cron moment ("내일 오전 9시에 한 번")' },
          notify: { type: 'string', enum: ['always', 'on_change'], description: "always: the user is told at every run (reminders, reports). on_change: only when something changed since the last run (watching for news, prices, new items)" },
          prompt: { type: 'string', description: 'Self-contained instruction executed at each run. Keep every name (stocks, companies, people, products) exactly as the user wrote it; never add codes, tickers or ids the user did not give — the run looks them up' },
          skill: { type: 'string', description: 'If one of the available skills (listed in the system message) does this job, its exact name. The run then executes that skill as a mission. A skill is one person\'s job done by one agent: results go only to the person who set it up.' },
          process: { type: 'string', description: 'If one of the processes (listed in the system message) is the job to run on this schedule, its exact id. Each run then starts a new instance of that process. Use a process (not a skill) when the work passes between people or roles (검토·승인·결정을 다른 사람/역할이 함), branches on a decision, or chains several agents/skills — each step then goes to whoever holds its role.' },
          params: { type: 'object', description: 'Inputs taken from the request. For a skill, what the skill needs, e.g. {"channel":"@경제사냥꾼","sectors":["코스피","반도체"]}. For a process, its first-step fields (listed with the process), e.g. {"sources":"Facebook","topics":"AI 업무 자동화"}' },
          ack: { type: 'string', description: '해요체 확인 문장 한두 개. 첫 실행 시각은 말하지 말 것(시스템이 따로 표시)' },
        },
        required: ['name', 'prompt', 'ack'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_schedule_now',
      description: 'Run one of the user\'s existing scheduled tasks (listed in the system message) right now, once, to try it: "지금 한 번 실행해 봐", "곧바로 돌려 봐", "테스트로 실행해 줘". Never make a new schedule for this.',
      parameters: { type: 'object', properties: { schedule: { type: 'string', description: 'the id or exact name of the scheduled task' }, ack: { type: 'string', description: '해요체 한 문장' } }, required: ['schedule', 'ack'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'notify_member',
      description: 'Ask a teammate to look at or handle something: "김민지님께 알려줘", "제품 책임자한테 봐달라고 해", "@민지 확인 부탁", "팀장님께 전달해줘". The member may be a name, an e-mail or a role (listed in the system message). Sends them a notification on their Home.',
      parameters: {
        type: 'object',
        properties: {
          member: { type: 'string', description: 'name, e-mail or role of the teammate' },
          title: { type: 'string', description: '알림 제목 한 줄(무엇을 봐 달라는지)' },
          message: { type: 'string', description: 'Self-contained request for the teammate: what to look at and why, with the facts they need. They have NOT seen this chat, so never refer to "this conversation"' },
          ack: { type: 'string', description: '해요체 한 문장' },
        },
        required: ['member', 'title', 'message', 'ack'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_panel',
      description: 'User wants a NEW panel / widget / mini-app on Home: a live widget (주식 추적, 날씨, 환율) or a small data app people register and manage records in, kept in a spreadsheet and shareable with the team (리드 관리, 휴가 일수 관리, 비품 대장, 할일 목록, 고객 명단…). Not for adding a record to an app that already exists (panel_record). NOT for writing a document or file (안내문·보고서·제안서, docx/hwpx/xlsx/pptx) — answer those without tools.',
      parameters: { type: 'object', properties: { description: { type: 'string', description: 'what the panel is for, with any fields, rules and first records the user mentioned' }, ack: { type: 'string', description: '만들기 시작했다는 해요체 한 문장(완료됐다고 말하지 말 것)' } }, required: ['description', 'ack'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'panel_record',
      description: 'Add, change or look up records in one of the user\'s existing panel apps (listed in the system message), e.g. "휴가 일수 관리에 이준호 15일 추가해줘", "리드 관리에서 한빛상사 단계를 제안으로 바꿔줘", "리드 몇 건이야?".',
      parameters: {
        type: 'object',
        properties: {
          app: { type: 'string', description: 'exact app title from the list' },
          action: { type: 'string', enum: ['add', 'update', 'list'] },
          values: { type: 'object', description: 'field label → value for add/update' },
          match: { type: 'string', description: 'update: text that identifies the row (e.g. the name in its title column); for a cancel/correction in a record-keeping app: text that identifies the original record' },
          event: { type: 'string', description: 'record-keeping (event) apps: which record to add, e.g. 휴가 신청, 휴가 취소, 휴가 부여' },
          ack: { type: 'string', description: '해요체 한 문장' },
        },
        required: ['app', 'action', 'ack'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_mail',
      // the company's mail policies decide (lib/scenarios/mail.js → lib/policy): sent, recorded, held for approval or blocked
      description: `Send an e-mail for the user now: "kim@globex-demo.com 에게 견적 메일 보내줘", "고객 명단 파일 첨부해서 메일로 보내", "민지님께 회의 자료 메일로 보내줘". Anything to go by 메일/이메일/e-mail is this tool, to a teammate too (notify_member is a Home notification, not a mail). Write the whole mail from the request. NOT for reading, searching or summarising mail, and not for a mail on a schedule (schedule_task).`,
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'array', items: { type: 'string' }, description: 'recipient e-mail addresses (a teammate may be named instead)' },
          subject: { type: 'string', description: '메일 제목' },
          body: { type: 'string', description: '보낼 본문 전체' },
          attachment: { type: 'string', description: `REQUIRED whenever the request names a file, list or material to send (명단, 파일, 자료, 첨부): its exact file name from the user's demo folder (${demoFiles().join(', ')}) or from this chat's attachments — or the text to attach` },
          ack: { type: 'string', description: '보내 보겠다는 해요체 한 문장(보냈다고 말하지 말 것 — 회사 정책이 결과를 정함)' },
        },
        required: ['to', 'subject', 'body', 'ack'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_action',
      description: 'Save a reminder / to-do as an action button on Home.',
      parameters: {
        type: 'object',
        properties: { verb: { type: 'string', enum: ['Remind', 'Add', 'Reply', 'Pay', 'Review', 'Call'] }, text: { type: 'string' }, due: { type: 'string' }, ack: { type: 'string' } },
        required: ['verb', 'text', 'ack'],
      },
    },
  },
]

// English mode: the argument descriptions a person's words come from (ack, name, title) ask for English
const ARG_EN = {
  ack: 'One or two short English sentences to the user, first person, saying what you will do',
  name: 'Short task name in English', title: 'One-line notification title in English (what to look at)',
  event: 'record-keeping (event) apps: which record to add, as the app names it',
}
function routerTools(list) {
  if (!isEn()) return list
  return list.map((t) => {
    const props = Object.fromEntries(Object.entries(t.function.parameters.properties).map(([k, v]) => [k, ARG_EN[k] && /[가-힣]/.test(v.description || '') ? { ...v, description: ARG_EN[k] } : v]))
    return { ...t, function: { ...t.function, parameters: { ...t.function.parameters, properties: props } } }
  })
}

const PERSONA = `너는 사용자의 개인 운영체제 같은 업무 비서야. 한국어 해요체로 짧고 따뜻하게 답해.
불필요한 서론 없이 핵심만. 지금 시각: ${'{now}'}.`
// English mode (lib/lang.js): the same assistant, in English; tool arguments a person reads (ack,
// titles, names) are written in English too
const PERSONA_EN = `You are the user's work assistant, like a personal operating system. Answer in English, short and warm,
first person ("I'll…"), no preamble. Write every tool argument a person will read (ack, name, title, message, text) in English. Current time: ${'{now}'}.`

function toLlmHistory(rows) {
  return rows.filter((r) => r.kind === 'text' || r.kind === 'doc' || r.kind === 'followup').map((r) => ({
    role: r.role === 'user' ? 'user' : 'assistant',
    content: r.content.text || '',
  }))
}

// A message's place in line, from the moment it comes in (lib/turns.js): the agent turn it leads to
// (delegate) takes this place, so turns on the same conversation run in the order they were sent.
const turnCtx = new AsyncLocalStorage()
// auto: a turn nobody asked for just now (a company routine done without asking — lib/followups.js autoRoutine): a browser task it starts
// is not the person's own (it runs on their PC only when that PC says so, and not on that PC's own network — lib/browser.js)
// onRetract: the POST stream's `retract` — the draft answer turned out to be an interim text (lib/turnPlan.js createSegments)
// From the message to the handler the turn is in its front stage (turn.front): 멈추기 reaches it there (lib/turns.js running), and no
// handler starts once it is stopped (checkpoint) — the chat says 「멈췄어요」 instead (design turnplan §1.3).
export function runTurn(args) {
  const turn = turns.enqueue({ userId: args.user.id, threadId: args.threadId })
  turn.front = true
  return turnCtx.run({ turn, userMsgId: null, adopted: false, auto: !!args.auto, onRetract: args.onRetract || null }, async () => {
    // (the view ends however the turn does — a failure to write the 「멈췄어요」 message must not leave a card running for good)
    let state = 'failed'
    try {
      const m = await handleTurn(args)
      state = m?.content?.stopped ? 'stopped' : 'done'
      return m
    } catch (e) {
      if (!e?.turnStopped) throw e
      state = 'stopped'
      // what this message left for its agent turn is not picked up by the next message (review 11-25 #5)
      attached.delete(args.threadId)
      pinned.delete(args.threadId)
      console.log(`[turn] stopped before a handler started thread=${String(args.threadId).slice(0, 8)}`)
      return await addMessage(args.user.id, args.threadId, 'agent', 'text', { text: `(${stoppedText()})`, stopped: true, ...TP.saved(turn, 'stopped') })
    } finally { TP.end(turn, state) }
  }).finally(() => turn.finish())
}
// tests: a handler run inside a given turn (server/test/turnPlan.test.js)
export const _test = { inTurn: (turn, fn) => turnCtx.run({ turn, userMsgId: null, adopted: false, auto: false }, fn), processTurn: (...a) => processTurn(...a) }
// a turn stopped in its front stage starts no handler: runTurn answers it with 「멈췄어요」
function checkpoint(t) {
  if (t?.stopped) throw Object.assign(new Error('stopped before a handler started'), { turnStopped: true })
}

// This message is answered here, not by an agent turn: a message after it need not wait for it.
// h: what handles it, for the plan card's handler line (lib/turnPlan.js)
const noAgentTurn = (h) => {
  const t = turnCtx.getStore()?.turn
  if (!t) return
  checkpoint(t)
  t.front = false
  t.setConv(`none:${t.id}`)
  TP.handler(t, h || { kind: 'action', label: L('바로 처리', 'Handled here') })
}

// A turn the browser agent answers: said now, its result posted when it ends. Nothing runs in the agent service.
// asked: the message as the person sent it ({text, files}); skill: the browser skill (lib/browserSkills.js) the task uses
async function startBrowserTurn({ user, session, threadId, goal, startUrl, skill, files, onDelta, ack, room, asked, replaces = true }) {
  noAgentTurn(browserHandler(skill))
  // asked to come after a task it finishes first: the reply says the order
  const after = turnCtx.getStore()?.after
  if (after) ack = BQ.orderText(after.title, goal)
  const msg = await addMessage(user.id, threadId, 'agent', 'text', { text: ack })
  onDelta?.(ack)
  runBrowser({ user, session, threadId, goal, startUrl, skill, files, room, asked, replaces })
  return msg
}
const browserHandler = (skill) => ({ kind: 'browser', ...(skill ? { skill } : {}), label: `${L('브라우저', 'Browser')}${skill ? ` · ${skill}` : ''}` })
// the browser tasks this server started, newest last (what the tests read: the skill is passed on as chosen)
export const browserStarts = []
// (the ack is already in the chat; the turn it replaces stops alongside — the card need not wait for that)
function runBrowser({ user, session, threadId, goal, startUrl, skill, files = [], room, asked, replaces = true }) {
  const userId = user.id
  if (replaces) replaceEarlier({ user, session, threadId, room, text: asked?.text ?? goal, why: replacedText(startUrl) })
    .catch((e) => console.warn('[replace]', e.message))
  console.log(`[browser] start thread=${String(threadId).slice(0, 8)} skill=${skill || '-'} url=${startUrl || '-'} files=${files.length}`)
  const own = !turnCtx.getStore()?.auto
  browserStarts.push({ threadId, goal, startUrl: startUrl || '', skill: skill || '', files: files.map((f) => f.name), own })
  if (browserStarts.length > 20) browserStarts.shift()
  // the person's words go along (behind a task that waits for them, its card offers them as that task's answer — the first choice
  // is what the judge found likeliest: lib/browserQueue.js queueDefault); a task this turn finishes first comes before it
  const st = turnCtx.getStore()
  const queue = { asked: String(asked?.text ?? '').trim() || goal, default: st?.waitRead?.default || 'after' }
  runBrowserTask({ userId, threadId, goal, startUrl, files, skill, own, queue, ...(st?.after ? { after: st.after.taskId } : {}) })
    .then((r) => postBrowserResult(userId, threadId, r))
    .catch((e) => { console.warn('[browser]', e.message); addMessage(userId, threadId, 'agent', 'text', { text: L('브라우저 작업을 시작하지 못했어요. 잠시 후 다시 시도해 주세요.', "I couldn't start the browser task. Please try again in a moment."), failed: true }) })
}
// A browser task's result in the chat: a line or two (brief), with what it did step by step and the whole account folded under
// 「자세히」 (did · detail — the screen's Message.vue). The text the agents read back later stays short (2026-11-25 recording).
export function postBrowserResult(userId, threadId, r) {
  const text = String(r?.brief || r?.summary || '').trim()
  if (!text) return null
  return addMessage(userId, threadId, 'agent', 'text', { text, ...(r.taskId ? { taskId: r.taskId } : {}), ...(r.did?.length ? { did: r.did } : {}),
    ...(r.detail ? { detail: r.detail } : {}), ...(r.refused?.length ? { refused: r.refused } : {}) })
}
// A browser task that ended, again: resume — the same task from where it stopped, with a fresh budget (and the person's instruction,
// when they gave one); otherwise a new task that carries on from it with the instruction (its goal, inputs and page). → the run
function goOn({ user, threadId, id, resume = true, instruction = '', queue = null }) {
  const userId = user.id
  const own = !turnCtx.getStore()?.auto
  console.log(`[browser] ${resume ? 'resume' : 'carry on from'} ${String(id).slice(0, 8)} thread=${String(threadId).slice(0, 8)}${instruction ? ' (with an instruction)' : ''}`)
  const run = runBrowserTask({ userId, threadId, ...(resume ? { resume: id } : { from: id }), instruction, own, ...(queue ? { queue } : {}) })
  run.then((r) => postBrowserResult(userId, threadId, r)).catch((e) => console.warn('[browser] go on', e.message))
  return run
}
// Words for a browser task of this person in this room: the one under way takes them as steering; else the one that just ended goes
// on with them (a stopped one is resumed with them, a finished one carries on as a new task). → the reply posted, or null when there
// is no such task. (the room judge's steer, and 「이번 작업에만 적용」 on a rule's confirm card)
async function steerOrContinue({ user, threadId, text, onDelta, ended = null }) {
  const userId = user.id
  const active = activeIn(userId, threadId)
  if (active && await steerBrowser(userId, active.taskId, text)) {
    const ok = BQ.steeredText(active.title)
    onDelta?.(ok)
    return addMessage(userId, threadId, 'agent', 'text', { text: ok, steered: active.taskId })
  }
  const t = (ended || await BQ.recentEnded(userId, threadId).catch(() => []))[0]
  if (!t) return null
  goOn({ user, threadId, id: t.id, resume: !t.done, instruction: text })
  const ok = BQ.continueText(t.title)
  onDelta?.(ok)
  return addMessage(userId, threadId, 'agent', 'text', { text: ok, continued: t.id })
}
// 「이번 작업에만 적용」 on a rule's confirm card (lib/roomRules.js settleRuleConfirm): the words go to the task, never into the rule; with
// no task to take them, they run once as a request of their own (the room's judge is not asked again)
export async function onceTurn({ user, session, threadId, text }) {
  const r = await steerOrContinue({ user, threadId, text })
  if (r) return r
  return runTurn({ user, session, threadId, text, again: true })
}

// 바로잡는 말 ("그 사이트에 들어가서 생성해야"): a browser task that starts while an agent turn of the same
// room is still being answered may take its place when the judge says the new message corrects that request
// (lib/turns.js replaceRule). The turn ahead is stopped the way 멈추기 stops it
// (deepagents /chat/stop) and its answer says why instead of "완료했습니다"; what it already made stays where it is.
function replacedText(url) {
  let host = ''
  try { host = new URL(url).hostname } catch { /* no address */ }
  return host
    ? L(`${host}에서 하는 브라우저 작업으로 바꿔서 이전 작업은 멈췄어요.`, `I switched to the browser task on ${host} and stopped the earlier work.`)
    : L('브라우저 작업으로 바꿔서 이전 작업은 멈췄어요.', 'I switched to the browser task and stopped the earlier work.')
}
export async function replaceEarlier({ user, session, threadId, room, text, why }) {
  const ahead = turns.agentTurnsAhead({ userId: user.id, threadId, before: turnCtx.getStore()?.turn })
  const rule = turns.replaceRule({ room, ahead })
  if (rule === 'keep') return []
  let list = ahead
  if (rule === 'ask') {
    const shown = turns.judgedAhead(ahead)
    const r = await judge({
      state: L(`진행 중인 요청:\n${shown.map((t, i) => `t${i}. ${t.title}`).join('\n')}\n\n사용자가 새로 한 말: ${String(text).slice(0, 400)}`,
        `Requests in progress:\n${shown.map((t, i) => `t${i}. ${t.title}`).join('\n')}\n\nWhat the person said now: ${String(text).slice(0, 400)}`),
      question: L('새로 한 말은 진행 중인 요청 하나를 바로잡는 말(그 일을 다른 방법·다른 곳에서 하라는 말)인가?', 'Does the new remark correct one of the requests in progress (do that work another way or somewhere else)?'),
      options: [...shown.map((t, i) => ({ key: `t${i}`, label: L(`「${t.title}」 요청을 바로잡는 말이다`, `It corrects the request "${t.title}"`) })),
        { key: 'new', label: L('앞의 요청과 따로, 새로 시키는 일이다', 'It is a new request, separate from those') }],
    }).catch((e) => { console.warn('[replace] judge', e.message); return null })
    console.log(`[replace] judged ${JSON.stringify(r?.probabilities || {})} via ${r?.via || '-'} ${r?.ms ?? '-'} ms`)
    list = turns.pickReplaced(shown, r?.probabilities)
  }
  for (const t of list) {
    console.log(`[replace] stopping the turn ahead ('${t.title}') thread=${String(threadId).slice(0, 8)} (${rule})`)
    await stopTurn(t, session, why)
  }
  return list
}

// ---------- what must never become a file card (review 11-25 #1) ----------
// /workspace/uploads/<person>/…: what a person attached or was handed (chat attachments, a mail's attachments) — never a turn's output
export const uploadsPath = (p) => /^\/workspace\/uploads\//.test(String(p || ''))
// the turn's handed-over files → {paths: Set, hashes: Set}
export function privatePaths(list) {
  const out = { paths: new Set(), hashes: new Set() }
  for (const x of Array.isArray(list) ? list : []) {
    if (x?.path) out.paths.add(String(x.path))
    if (/^[0-9a-f]{64}$/.test(String(x?.sha256 || ''))) out.hashes.add(String(x.sha256))
  }
  return out
}
// a path for the log: an upload's (or a handed-over file's) own name is not written there
export const logPath = (p, handed) => (!p ? '' : uploadsPath(p) || handed?.paths?.has(p) ? '/workspace/uploads/…' : p)
export const logName = (n, handed) => (handed?.hashes?.size ? '(a document)' : n)
const sha256Of = (buf) => createHash('sha256').update(buf).digest('hex')
// the bytes of a candidate card (its sandbox file here, else the copy deepagents stored, else its address) — only to compare with what was
// handed over; a file too large to be one of those is not read
async function candidateBytes(f, userId) {
  const MAX = 80 * 1024 * 1024
  if (f.path) {
    const host = await workspaceHostPath(f.path).catch(() => null) || await standInPath(f.path, { userId }).catch(() => null)
    if (host) {
      const st = await fs.stat(host).catch(() => null)
      if (st?.isFile()) return st.size <= MAX ? fs.readFile(host) : null
    }
  }
  for (const u of [f.src, f.url]) {
    if (!u || !/^https?:\/\//.test(String(u))) continue
    const r = await fetch(u, { signal: AbortSignal.timeout(60_000) }).catch(() => null)
    if (!r?.ok) continue
    if (Number(r.headers.get('content-length')) > MAX) { await r.body?.cancel().catch(() => {}); return null }
    return Buffer.from(await r.arrayBuffer())
  }
  return null
}
// why a candidate must not become a card, or null
export async function privateCandidate(f, handed, userId, { bytes = candidateBytes } = {}) {
  if (uploadsPath(f.path) || (f.path && handed?.paths?.has(f.path))) return 'an upload'
  if (!handed?.hashes?.size) return null
  const buf = await bytes(f, userId).catch(() => null)
  return buf && handed.hashes.has(sha256Of(buf)) ? 'a mail attachment handed over this turn' : null
}

const hostOf = (u) => { try { return new URL(u).host } catch { return '' } }
const sameHost = (a, b) => !!hostOf(a) && hostOf(a) === hostOf(b)

// again: the words of a message already in the chat, run once more as a request of its own (onceTurn) — not posted again, and not read
// as an answer, as words for a browser task or as the room's rule
async function handleTurn({ user, session, threadId, text, context, onDelta, files, conversation, noFolder, fresh, habitId, openDoc, refs, again = false }) {
  const userId = user.id
  if (conversation?.id) pinned.set(threadId, { conversationId: String(conversation.id), title: String(conversation.title || '') })
  // a key or a workspace path is only ever this person's own upload (lib/attachments.js); the page could send any other
  const ownPath = (p) => typeof p === 'string' && p.startsWith(`/workspace/uploads/${user.id}/`) && !p.split('/').includes('..')
  files = (files || []).filter((f) => f?.url).map((f) => ({ ...f,
    ...(f.key && !String(f.key).startsWith(`pgpt-pro/${user.id}/att/`) ? { key: undefined } : {}),
    ...(f.path && !ownPath(f.path) ? { path: undefined } : {}) })).slice(0, 10)
  // files dragged onto the composer (src/fileDrag.js — a shared folder's file, an artifact, a file a teammate sent): read with this
  // person's access and given to the agent as where to read each (lib/fileRefs.js turnRefs); the sent message keeps them as chips
  let pointed = null
  if (Array.isArray(refs) && refs.length) {
    pointed = await import('./fileRefs.js').then((m) => m.turnRefs(user, refs)).catch((e) => { console.warn('[file-refs] turn', e.message); return { context: '', shown: [] } })
    if (pointed?.context) context = [context, pointed.context].filter(Boolean).join('\n\n')
    // a mail's attachment handed to the agent (lib/mailAttachments.js agentFile): the turn's end never makes a card — a public copy — of it
    const st = turnCtx.getStore()
    if (st && pointed?.handed?.length) st.mailAtts = { threadId, handed: pointed.handed }
  }
  // (only a mail pointed at — lib/mailMention.js: the words say so)
  const onlyMail = !files.length && pointed?.shown?.length && pointed.shown.every((x) => x.as === 'mail' || x.error)
  if (!text?.trim() && (files.length || pointed?.shown?.some((x) => !x.error))) text = onlyMail ? L('이 메일을 확인해 줘', 'Please look at this mail') : L('첨부한 파일을 확인해 줘', 'Please look at the attached files')
  // only dragged files, and none of them usable: nothing goes to the agent (the route says so — not an empty turn)
  if (!text?.trim() && pointed) throw Object.assign(new Error(L('보낼 말이나 쓸 수 있는 파일이 없어요.', 'There is nothing usable to send.')), { status: 400, empty: true })
  // asked from a project's view narrowed to one of its sub-topics (lib/projectTopics.js): the message is that sub-topic's from the start
  // (the page shows it there while it is answered)
  const th = conversation?.id ? await getThread(userId, threadId) : null
  const topicConv = th?.kind === 'project' && await PT.isTopic(userId, th, conversation.id).catch(() => false) ? String(conversation.id) : null
  // fresh: 「이미 한 요청」 카드에서 「그래도 새로 하기」(또는 허락 뒤 다시 답하기) — 같은 요청 알아보기를 건너뛴다
  const said = again ? ((await q(`select id from pro_messages where thread_id=$1 and role='user' and content->>'text'=$2 order by created_at desc limit 1`, [threadId, text]))[0] || { id: null })
    : await addMessage(userId, threadId, 'user', 'text', { text, ...(files.length ? { files } : {}), ...(pointed?.shown?.length ? { refs: pointed.shown } : {}), ...(fresh && !habitId ? { fresh: true } : {}), ...(habitId ? { fromHabit: true } : {}), ...(topicConv ? { conv: topicConv } : {}) })
  const store = turnCtx.getStore()
  if (store) { store.userMsgId = said.id; store.fresh = !!fresh; store.said = text; store.habitId = habitId || null }
  // the plan card (lib/turnPlan.js): turn.start now, what was understood and the steps within a few seconds, beside this path
  TP.begin({ turn: store?.turn, userId, threadId, msgId: said.id, text, files: [...files, ...(pointed?.shown || [])] })
  // the document open in the page's editor (src/stores/app.js send): this turn's delegate treats it
  // as the open document even when the live link (lib/craftLive.js) is down
  const doc = openDocOf(openDoc)
  if (store && doc) store.openDoc = doc
  // 후행 습관(lib/followups.js): an answer in words to the question just asked, or a habit told outright
  if (!habitId && !again) {
    const ans = await readAnswer(user, threadId, said.id, text, files.length > 0).catch((e) => { console.warn('[followups] answer', e.message); return null })
    if (ans?.decline) {
      noAgentTurn()
      const ok = L('알겠어요. 이번에는 하지 않을게요.', "Okay, I won't this time.")
      onDelta?.(ok)
      return addMessage(userId, threadId, 'agent', 'text', { text: ok })
    }
    if (ans?.accept) {
      // from here it is the turn the card's button runs; the person's own words stay in the chat
      text = ans.accept.action
      files = (ans.accept.files || []).filter((f) => f?.url).slice(0, 10)
      if (ans.accept.conversation?.id) pinned.set(threadId, { conversationId: String(ans.accept.conversation.id), title: String(ans.accept.conversation.title || '') })
      context = [context, L('(비서가 물은 일을 사용자가 수락했습니다)', '(The person accepted what the assistant asked)')].filter(Boolean).join('\n\n')
      if (store) { store.fresh = true; store.said = text; store.habitId = ans.accept.habitId }
    } else {
      const told = await readRule(user, text).catch((e) => { console.warn('[followups] rule', e.message); return null })
      if (told) {
        noAgentTurn()
        const ok = L(`기억할게요. ${whenText(told.event_cls)} 「${told.action}」를 먼저 물어볼게요. 설정 › 습관에서 끄거나 지울 수 있어요.`, `Got it. ${whenText(told.event_cls)}, I'll ask about "${told.action}" first. You can turn it off or remove it in Settings › Habits.`)
        onDelta?.(ok)
        return addMessage(userId, threadId, 'agent', 'text', { text: ok, habit: told.id })
      }
    }
  }
  // 이 방에서 돌거나 사람을 기다리는 이 사람의 브라우저 작업(lib/browserQueue.js, 2026-11-25 녹화): 입력창의 말이 그 작업이 물은 것의
  // 답이면 그 카드의 답으로(「새로 만들어」), 그 작업에게 어떻게 하라는 말이면 그 작업으로(「미디엄은 … pdf 로 만든 후에 노트북엘엠에
  // 넣어야 해」) — 뜻은 판정 모델이 읽는다. 그 밖의 말은 평소 길로 가고, 그 말로 시작한 브라우저 작업이 기다리는 작업 뒤에 서면 그 카드가
  // 세 갈래(답으로 · 이것부터 · 뒤에 줄 서기)를 판정이 가장 높게 본 것부터 보여 준다(waitRead.default).
  const active = !habitId && !again && !files.length ? activeIn(userId, threadId) : null
  let activeRead = null
  if (active) {
    const w = active.waiting ? { ...active, ...waitingIn(userId, threadId) } : active
    activeRead = await BQ.readWaiting(w, text)
    console.log(`[browser-queue] ${activeRead.pick}${activeRead.option != null ? ` o${activeRead.option}` : ''} ${JSON.stringify(activeRead.probabilities)} via ${activeRead.via} ${activeRead.ms} ms thread=${String(threadId).slice(0, 8)}${activeRead.error ? ` (${activeRead.error})` : ''}`)
    if (store) store.waitRead = { taskId: active.taskId, default: BQ.queueDefault(activeRead.p) }
    if (activeRead.pick === 'answer' && await answerWaiting(userId, active.taskId, { text, option: activeRead.option })) {
      noAgentTurn()
      const ok = BQ.answeredText(active.title)
      onDelta?.(ok)
      return addMessage(userId, threadId, 'agent', 'text', { text: ok, answered: active.taskId })
    }
    if (activeRead.pick === 'steer' && await steerBrowser(userId, active.taskId, text)) {
      noAgentTurn()
      const ok = BQ.steeredText(active.title)
      onDelta?.(ok)
      return addMessage(userId, threadId, 'agent', 'text', { text: ok, steered: active.taskId })
    }
  }
  // 끝냈거나 멈춘 브라우저 작업(같은 판정): 그 작업을 먼저 마저 끝내고 그다음 일(「작업을 마치고 아까 노트북 엘엠 만들던거 진행해」 —
  // ① 그 작업을 멈춘 자리부터 새 동작 한도로, ② 이 말이 시키는 일은 그 뒤에), 그 작업만 이어서(「다시 시도해 줘: …」), 또는 그 작업을
  // 이렇게 이어서 하라는 말(멈춘 작업은 그 말과 함께 이어서, 끝난 작업은 그 말을 더한 새 작업으로)
  const ended = !habitId && !again && !files.length ? await BQ.recentEnded(userId, threadId).catch(() => []) : []
  if (ended.length) {
    const r = await BQ.readResume(ended, text)
    console.log(`[browser-queue] resume ${r.pick || 'none'}${r.task ? ` '${r.task.title}'` : ''} ${JSON.stringify(r.probabilities || {})} via ${r.via || '-'} ${r.ms ?? '-'} ms thread=${String(threadId).slice(0, 8)}${r.error ? ` (${r.error})` : ''}`)
    const queue = { asked: text, default: store?.waitRead?.default || 'after' }
    if (r.pick === 'then') {
      // ① first: it takes the browser (or its place in line) before anything this message starts
      const done = goOn({ user, threadId, id: r.task.id, queue })
      if (store) store.after = { taskId: r.task.id, title: r.task.title, done }
    } else if (r.pick) {
      noAgentTurn()
      goOn({ user, threadId, id: r.task.id, resume: !r.task.done, instruction: r.pick === 'more' ? text : '', queue })
      const ok = r.pick === 'more' ? BQ.continueText(r.task.title) : BQ.resumeText(r.task.title)
      onDelta?.(ok)
      return addMessage(userId, threadId, 'agent', 'text', { text: ok, continued: r.task.id })
    }
  }
  for (const f of files) await addMessage(userId, threadId, 'user', 'file', { name: f.name, url: f.url, path: f.path, attached: true })
  if (files.length) {
    // 회사 프로세스 지도(lib/ontology/events.js): a file someone attaches is an event too — the processes it is the work of are offered
    // (never started for them); it stands in for the chat request's offer of this turn
    if (!habitId) {
      if (store) store.fileEvent = true
      import('./ontology/events.js').then((m) => m.onFile({ user, threadId, files, said: text })).catch((e) => console.warn('[ontology] file event', e.message))
    }
    attached.set(threadId, files)
    // the router only needs to know there are files; a question about them is the agent's job
    context = [context, L(`(첨부: ${files.map((f) => f.name).join(', ')})`, `(attached: ${files.map((f) => f.name).join(', ')})`)].filter(Boolean).join('\n\n')
  }
  // 방 판정(lib/roomRules.js): a project room's message is read once by the judge before any other shortcut —
  // it may set what this room does with the links and files put in it (set_rule), or be one of those (run_rule).
  // (recording 2026-11-21: the rule's first sentence went down a shortcut to the agent first and came back as
  // "PowerPoint 를 만든다") A reply to a process draft the room is waiting on is that draft's, not the room's.
  const room = !habitId && (await getThread(userId, threadId))?.kind === 'project'
  if (room && !again && !generationPending(threadId)) {
    const rule = await ruleOf(userId, threadId).catch(() => null)
    // the person's browser tasks here (under way, just ended) are read with it: words for a task are not the room's rule
    const tasks = BQ.taskContext(active, ended)
    const read = await readRoom({ rule, text, files, tasks })
    console.log(`[room] ${read.pick} ${JSON.stringify(read.probabilities)} via ${read.via} ${read.ms} ms thread=${String(threadId).slice(0, 8)}${read.error ? ` (${read.error})` : ''}`)
    if (read.pick === 'steer') {
      const r = await steerOrContinue({ user, threadId, text, onDelta, ended })
      if (r) { noAgentTurn(); return r }
    }
    if (read.pick === 'set_rule') {
      noAgentTurn()
      const set = await ruleAction(text)
      // a room that has a rule: never replaced silently — 「규칙을 바꿀까요?」 with 「바꾸기」 · 「이번 작업에만 적용」 (lib/roomRules.js
      // settleRuleConfirm, POST /api/threads/:id/rule/confirm)
      if (rule) {
        const ask = L(`규칙을 바꿀까요?\n지금: ${rule.action}\n새: ${set.action}`, `Change this room's rule?\nNow: ${rule.action}\nNew: ${set.action}`)
        onDelta?.(ask)
        return addMessage(userId, threadId, 'agent', 'text', { text: ask, ruleConfirm: { said: String(text).trim().slice(0, 400), now: rule.action, next: set.action, skill: set.skill, state: 'pending' } })
      }
      // (the action on a line of its own: the model's sentence may end without a stop)
      const ok = [L('알겠습니다. 이 방에 올리시는 링크와 파일은 앞으로 바로 처리할게요.', 'Got it. Links and files you put in this room will be handled right away.'), set.action,
        set.skill ? L('서버의 내장 브라우저에서 진행해요.', "I'll do it in the server's built-in browser.") : ''].filter(Boolean).join('\n')
      onDelta?.(ok)
      return addMessage(userId, threadId, 'agent', 'text', { text: ok, roomRule: { said: String(text).trim().slice(0, 400), action: set.action, skill: set.skill, runs: 0 } })
    }
    if (read.pick === 'run_rule') {
      ranRule(rule.id).catch(() => {})
      const goal = roomGoal(rule.action, text, files)
      const skill = rule.skill ? browserSkill(rule.skill) : null
      if (skill) return startBrowserTurn({ user, session, threadId, goal, startUrl: skill.startUrl || undefined, skill: skill.name, files, onDelta, room, asked: { text, files }, replaces: false, ack: L('이 방의 규칙대로 시작할게요.', 'Starting, as this room is set up to.') })
      return delegate({ user, session, threadId, text: goal, onDelta })
    }
  }
  const hist = toLlmHistory(await history(threadId, 12))
  if (context) hist[hist.length - 1] = { role: 'user', content: `${text}\n\n${context}` }
  const now = new Date().toLocaleString(locale(), { timeZone: 'Asia/Seoul' })

  // Skill authoring belongs to deepagents' own skill-creator (its root prompt routes '스킬 만들어줘'
  // there); pass such requests through untouched instead of classifying them here.
  // ("…점검 방법을 스킬로 만들어 줘" and "아까 만들던 … 스킬을 마무리해 줘" — the tutorial's own wording — are too)
  if (/(스킬|skill)\s*(을|를|로|으로)?\s*(새로\s*)?(만들|생성|작성)|만들던\s.{0,40}(스킬|skill)|(스킬|skill)\s*(을|를)?\s*(마무리|이어서?\s*(만들|해)|완성)/i.test(text) || SKILL_REQUEST_EN.test(text)) {
    generationDone(threadId)
    // a skill meant to run on a schedule reports its outcome the way missions read it (lib/missions.js)
    return delegate({ user, session, threadId, text: RECURRING.test(text) || /예약|미션|schedul|mission/i.test(text) ? L(`${text}\n\n(이 스킬은 예약 실행(미션)으로도 돌아요: SKILL.md 절차의 마지막 단계로 "${MISSION_LINE}" 을 넣어 주세요.)`, `${text}\n\n(This skill also runs on a schedule (as a mission): add "${MISSION_LINE_EN}" as the last step of the SKILL.md procedure.)`) : text, onDelta, mode: 'skill' })
  }
  // A change asked for in a shared folder ("11월 세미나 폴더의 안내문 고쳐줘") runs on a new
  // variation of that folder (lib/folders/work.js); the person reviews and merges it.
  // "새 패널 만들기: …" (Home button) always makes a panel, without asking the router
  // so does a plain "…패널 만들어줘" (a router model sometimes hands it to the general agent)
  if ((/^새 패널 만들기\s*[:：]/.test(text) || /패널\s*(을|를|하나|좀)?\s*(새로\s*)?(만들어|만들자|생성해|추가해\s*줘)/.test(text) || PANEL_REQUEST_EN.test(text)) && !files.length) {
    const description = text.replace(/^새 패널 만들기\s*[:：]\s*/, '').replace(/^New panel\s*[:：]\s*/i, '')
    noAgentTurn()
    const designing = L('패널을 설계하고 있어요.', "I'm designing the panel.")
    const ack = await addMessage(userId, threadId, 'agent', 'text', { text: designing })
    onDelta?.(designing)
    await makePanel({ user: { ...user, jwt: session?.access_token }, threadId, description })
    return ack
  }
  // an app's folder is named after the app: "휴가 일수 관리에 … 추가해줘" is a record, not a folder change
  const namedApp = await PanelApps.appNamed(user, text).catch(() => null)
  // (a Home card that answers a mail — noFolder — is never a folder edit)
  const folderBlocked = noFolder || !!namedApp || generationPending(threadId) || !!files.length
  // (a folder attached in chat is the one a change request means when it names none; a project's own
  // folder is changed on the project's variation — delegate — not on a short one: lib/folders/threadFolders.js)
  const folderLink = await TF.linkOf(threadId).catch(() => null)
  // (an instance's work folder is attached to its conversation to be read — lib/mailWork.js; what is asked there is not taken as an edit
  // of that folder unless it names it)
  const changeLink = folderLink && (await getThread(userId, threadId).catch(() => null))?.kind === 'process' ? null : folderLink
  const named = !folderBlocked ? await folderFor(user, text).catch(() => null) : null
  const sharedFolder = await TF.chatFolderTarget({ user, link: changeLink, named, text, blocked: folderBlocked }).catch(() => named)
  if (sharedFolder) return folderTurn({ user, session, threadId, text, onDelta, folder: sharedFolder })
  // the author's own private skill is not installed: their run is pointed at its copy, and after the
  // first good run the chat asks once more whether to share it
  // (attached files go along: the skill's run reads them like any other turn's attachments)
  const ownSkill = !generationPending(threadId) ? await privateSkillFor(user, text).catch(() => null) : null
  if (ownSkill) {
    const msg = await delegate({ user, session, threadId, onDelta, text: `${text.replace(`/${ownSkill.name}`, '').trim() || text}\n\n${L(`(내 스킬 '${ownSkill.name}' 로 처리하세요. 아직 공유하지 않은 개인 스킬이라 설치 목록에는 없어요 — 이 문서를 읽고 그 절차대로 하세요: ${ownSkill.path}, 같은 폴더의 파일도 참고)`, `(Handle this with my skill '${ownSkill.name}'. It is a personal skill not shared yet, so it is not in the installed list — read this document and follow its procedure: ${ownSkill.path}, and see the files in the same folder)`)}` })
    if (msg && !msg.content?.stopped && msg.content?.text !== EMPTY_TEXT && msg.content?.text !== EMPTY_TEXT_EN && !/오류|실패|\(error:/i.test(msg.content?.text || '')) await askShareAfterUse(user, threadId, ownSkill.name).catch(() => {})
    return msg
  }
  // A task already on a schedule, asked to run now ("곧바로 하나 정도 한번 실행해 봐"): that task runs once,
  // now — not a new schedule a minute later (2026-11-21 phone review). It has to be named or be the one
  // this conversation just set up or ran; otherwise the words may be about a process and go on as before.
  if (!files.length && wantsRunNow(text) && !generationPending(threadId)) {
    // (the last exchange only: an hourly task's own run lines further up are not "the one we were talking about")
    const s = pickSchedule(await listSchedules(userId), text, recentScheduleIds((await history(threadId, 6)).slice(-5)), { only: false })
    if (s) { noAgentTurn(); return runScheduleNowTurn({ userId, threadId, s, onDelta }) }
  }
  // Telegram: a task's alerts there too ("급등락이 감지되면 내 텔레그램 봇으로 알려줘"), an answer sent
  // there, or connecting the bot — handled here, the agent has no Telegram tool
  const tg = !files.length ? telegramIntent(text) : null
  if (tg) { noAgentTurn(); return telegramTurn({ userId, threadId, text, kind: tg, onDelta }) }
  // A one-off question about a connected service (YouTube, Calendar, Slack…) goes straight to
  // deepagents, which holds the connector tools; small router models tend to pick browser_task.
  // (a request about one of the user's panel apps — "팀 공유 캘린더에서 …" — is not a Google Calendar question)
  if (!namedApp && await connectorFirst(user, text) && !RECURRING.test(text) && !/브라우저|사이트에\s*접속|\bbrowser\b|log\s*in to/i.test(text) && !generationPending(threadId)) {
    return delegate({ user, session, threadId, text, onDelta })
  }
  if (generationPending(threadId)) {
    return delegate({ user, session, threadId, text: generationPrompt(threadId, text), onDelta })
  }
  // Making or editing a drawing, picture, sound or video: deepagents has the ArtCraft apps' tools
  // (mcp/craft.js); a router model reads "FilmCraft에서…" as a site to open in a browser.
  // (only plain schedule words count here: "처음 3초에 자막" is a time inside the video, not a schedule)
  // (an app open in the page — lib/craftLive.js — is the document a message like "제목을 노랗게" is about)
  if ((craftAppsFor(text).length || liveOpen(userId) || doc) && !/매일|매주|매달|마다|정기|반복|every|daily|weekly|monthly/i.test(text)) {
    // (the context carries what the person pointed at in the open document: @표 2, @이미지 1 …)
    return delegate({ user, session, threadId, text: context ? `${text}\n\n${context}` : text, onDelta })
  }
  // "달빛커피 제안 프로세스 어디가 병목이야? 어떻게 줄여?" — a process with a history, asked about its speed:
  // the numbers come from the deterministic analysis (lib/improve), the model only explains them
  if (!files.length && (IMPROVE_Q.test(text) || IMPROVE_Q_EN.test(text)) && !generationPending(threadId)) {
    const proc = await resolveProcess(text).catch(() => null)
    if (proc) { noAgentTurn(); return improveTurn({ user, threadId, text, onDelta, proc }) }
  }
  // Writing a document is the agent's job (office-mcp); a router model reads "안내문을 … 만들어줘" as a panel app.
  // (a process that names documents among its steps — "…제안서를 만들어" — is still the router's create;
  // "Make a process for the Moonlight Coffee proposal: …" is a new process, not a document: the router's
  // process tool designs it, as the Korean request always went)
  if (!namedApp && (DOC_REQUEST.test(text) || (DOC_REQUEST_EN.test(text) && !PROCESS_REQUEST_EN.test(text))) && !/패널|위젯|앱|프로세스|\b(panel|widget|app)\b/i.test(text) && !RECURRING.test(text)) {
    return delegate({ user, session, threadId, text: context ? `${text}\n\n${context}` : text, onDelta })
  }
  // An address plus a site action ("테스트 상점(http://…/login)에 로그인해서 …") is the browser agent's: the router
  // model sometimes answers these itself, and the agent's sandbox cannot reach the site
  const siteUrl = /https?:\/\/[^\s)'"]+/i.exec(text)?.[0]
  if (!namedApp && siteUrl && SITE_ACTION.test(text) && !files.length && !RECURRING.test(text) && !generationPending(threadId)) {
    return startBrowserTurn({ user, session, threadId, goal: text, startUrl: siteUrl, onDelta, room, asked: { text, files }, ack: L('사이트에서 직접 처리할게요.', "I'll do it on the site.") })
  }
  // a message about the result just made goes to the agent that made it (lib/followups.js) — read beside the router, not before it
  // (design turnplan §5.1: it held the router up by up to its odds limit); once it is found, the router's call is aborted
  TP.stage(store?.turn, 'routing')
  const { about, routed } = await TP.aboutOrRoute({
    about: () => followsResult(threadId, said.id, text),
    route: (signal) => TP.taskCards(threadId).then((tasks) => routeTurn({ user, session, hist, now, tasks, signal, attachments: files.length })),
    signal: store?.turn?.abort.signal,
  })
  checkpoint(store?.turn)
  if (about) {
    if (about.conv) pinned.set(threadId, { conversationId: about.conv, title: about.title })
    // the same words about a new result are new work, not 「이미 한 요청」
    if (store) store.fresh = true
    return delegate({ user, session, threadId, text: context ? `${text}\n\n${context}` : text, onDelta })
  }
  const call = routed?.call
  // a panel only when the words ask for one; the router otherwise turns "안내문 … 만들어줘" follow-ups into apps
  const strayPanel = call?.function.name === 'create_panel' && !PANEL_WORDS.test(text) && !PANEL_WORDS_EN.test(text)
  if (!call || strayPanel) return delegate({ user, session, threadId, text: context ? `${text}\n\n${context}` : text, onDelta })

  const args = routed.args
  // only designing a new process goes on to the agent; the other tools answer here
  if (!(call.function.name === 'process' && args.intent === 'create')) noAgentTurn()
  // (a small router model sometimes leaves the acknowledgement out: never an empty bubble)
  if (!String(args.ack || '').trim()) args.ack = L('네, 처리할게요.', 'On it.')
  // a task this message finishes first (「① … 마저 끝내고 → ② …」): the reply says the order
  if (call.function.name === 'browser_task' && store?.after) args.ack = BQ.orderText(store.after.title, args.goal || text)
  const ack = await addMessage(userId, threadId, 'agent', 'text', { text: args.ack })
  onDelta?.(args.ack)

  switch (call.function.name) {
    case 'browser_task': {
      // a skill the router named starts where the skill says: an address of the router's own counts only as a page on
      // that site (the real router named the skill and also guessed the site's address, on another host: 2026-11-21)
      const skill = args.skill ? browserSkill(String(args.skill).trim()) : null
      if (args.skill && !skill) console.warn(`[router] browser skill '${args.skill}' is not installed`)
      TP.handler(store?.turn, browserHandler(skill?.name))
      const startUrl = skill?.startUrl ? (sameHost(args.start_url, skill.startUrl) ? args.start_url : skill.startUrl) : args.start_url
      runBrowser({ user, session, threadId, goal: args.goal || text, startUrl: startUrl || undefined, skill: skill?.name, files, room, asked: { text, files } })
      break
    }
    case 'schedule_task': {
      // the ack is already in the chat: a schedule that cannot be made has to say so
      try {
        const cron = args.in_minutes ? cronAfter(args.in_minutes) : args.cron
        dueAt(cron, new Date()) // throws on an expression that is not a cron
        const skills = await listSkills(session.access_token)
        const useSkill = args.skill && skills.some((k) => k.name === args.skill)
        // the router sometimes names the process only inside its prompt; match ids and names as well
        let procId = !useSkill ? args.process : null
        if (!useSkill && !procId) {
          const said = `${args.prompt || ''} ${args.name || ''} ${text}`
          procId = (await listDefinitions()).slice(0, 40).find((d) => said.includes(d.id) || (d.name && d.name.length >= 6 && said.includes(d.name)))?.id
        }
        const proc = procId ? await getDefinition(procId) : null
        const s = proc
          ? await createProcessSchedule({ userId, name: args.name, cron, processId: proc.id, params: { ...(args.params || {}), request: text }, threadId })
          : useSkill
          // keep the user's own words with the inputs so the skill can recover anything the router missed
          ? await createMission({ userId, name: args.name, cron, skill: args.skill, params: { ...(args.params || {}), request: text } })
          : await createSchedule({ userId, name: args.name, cron, prompt: stripInventedCodes(args.prompt, text), threadId, notify: args.notify === 'on_change' ? 'on_change' : 'always', once: !!(args.in_minutes || args.once) })
        const next = nextRun(s.cron)
        const when = next ? next.toLocaleString(locale(), { timeZone: 'Asia/Seoul', month: 'long', day: 'numeric', weekday: 'short', hour: 'numeric', minute: '2-digit' }) : ''
        await addMessage(userId, threadId, 'agent', 'chip', { icon: 'clock', text: L(`예약됨 · ${s.name}${useSkill ? ` · 스킬 ${args.skill}` : proc ? ` · 프로세스 ${proc.name}` : ''}${when ? ` · 다음 실행 ${when}` : ''}`,
          `Scheduled · ${s.name}${useSkill ? ` · skill ${args.skill}` : proc ? ` · process ${proc.name}` : ''}${when ? ` · next run ${when}` : ''}`), cron: s.cron, scheduleId: s.id })
      } catch (e) {
        console.warn('[schedule]', e.message)
        await addMessage(userId, threadId, 'agent', 'text', { text: L('예약을 걸지 못했어요. 시각을 다시 알려 주세요.', "I couldn't set that schedule. Please tell me the time again.") })
      }
      break
    }
    case 'run_schedule_now': {
      const list = await listSchedules(userId)
      const s = list.find((x) => x.id === args.schedule || x.id.startsWith(String(args.schedule || '')) && String(args.schedule || '').length >= 8)
        || pickSchedule(list, `${args.schedule || ''} ${text}`, recentScheduleIds(await history(threadId, 16)))
      if (!s) { await addMessage(userId, threadId, 'agent', 'text', { text: L('어느 예약 작업인지 찾지 못했어요. 작업 이름을 알려 주세요.', "I couldn't tell which scheduled task you mean. Tell me its name.") }); break }
      await runScheduleNowTurn({ userId, threadId, s, acked: true })
      break
    }
    case 'create_panel':
      await makePanel({ user: { ...user, jwt: session?.access_token }, threadId, description: args.description || text })
      break
    case 'panel_record':
      await panelRecord({ user: { ...user, jwt: session?.access_token }, threadId, args, text })
      break
    case 'process':
      await processTurn(userId, threadId, args)
      break
    case 'notify_member': {
      const member = await resolveMember(args.member)
      if (!member || member.id === userId) {
        await addMessage(userId, threadId, 'agent', 'text', { text: member ? L('본인에게는 알림을 보내지 않아요.', "I don't send notifications to yourself.") : L(`'${args.member}' 팀원을 찾지 못했어요. 설정 → 팀·역할에서 팀원을 추가해 주세요.`, `I couldn't find a teammate called '${args.member}'. Add them in Settings → Team & roles.`) })
        break
      }
      // the teammate never saw this chat: what was said just before the request goes along
      // (earlier "알려줘" exchanges — a request followed by its bell chip — are not context)
      const rows = await history(threadId, 12)
      const pinged = new Set()
      rows.forEach((r, i) => { if (r.kind === 'chip' && r.content?.icon === 'bell') { pinged.add(i - 1); pinged.add(i - 2) } })
      // the excerpt's labels are in the teammate's language (they read it), the excerpt itself as it was said
      const theirs = await langOf(member.id).catch(() => 'ko')
      const T = (ko, en) => (theirs === 'en' ? en : ko)
      const said = [...new Set(rows.filter((r, i) => ['text', 'doc'].includes(r.kind) && r.content?.text && r.content.text !== text && r.content.text !== args.ack && !pinged.has(i))
        .slice(-3).map((r) => `${r.role === 'user' ? user.name || T('요청자', 'Requester') : T('비서', 'Assistant')}: ${r.content.text.replace(/\s+/g, ' ').slice(0, 220)}`))]
      await withLang(theirs, () => notifyMember(user, member, { title: args.title, text: [args.message.replace(/[^.。!?]*이 대화[^.。!?]*[.。!?]?/g, '').replace(/[^.!?]*\bthis (conversation|chat)\b[^.!?]*[.!?]?/gi, '').trim(), said.length ? `${T('— 대화 발췌 —', '— Conversation excerpt —')}\n${said.join('\n')}` : ''].filter(Boolean).join('\n\n') }))
      await addMessage(userId, threadId, 'agent', 'chip', { icon: 'bell', text: L(`${member.name}님께 알림 보냄${member.via === 'role' ? ` · ${member.role}` : ''} · ${args.title}`, `Notified ${member.name}${member.via === 'role' ? ` · ${member.role}` : ''} · ${args.title}`) })
      break
    }
    case 'send_mail': {
      // (never offered with the scenarios off; a call named anyway is not sent to the demo outbox)
      if (!config.scenarios) break
      // the policy card (and the demo outbox's note) follow in this chat; a recipient without an address is said here
      // (request: the person's own words, so a file they named is attached even when the arguments left it out)
      await sendMail(user, { ...args, request: text }, { threadId, files: attached.get(threadId) || [] })
        .catch((e) => { if (!e.status) console.warn('[mail]', e.message); return addMessage(userId, threadId, 'agent', 'text', { text: e.status ? e.message : L('메일을 보내지 못했어요. 잠시 후 다시 시도해 주세요.', "I couldn't send the mail. Please try again in a moment.") }) })
      break
    }
    case 'add_action': {
      const [a] = await q(`insert into pro_actions(user_id,verb,text,due,prompt) values ($1,$2,$3,$4,$5) returning *`,
        [userId, args.verb, args.text, args.due || null, args.text])
      emit(userId, 'action', a)
      break
    }
  }
  return ack
}

// ---------- the front router (design turnplan §5.1) ----------
// It used to have no time limit (180 s), no try/catch and an unguarded JSON.parse: 17.5 s in production, and a failure ended the
// turn with 「이 요청을 처리하지 못했어요」. Now: a token cap, 6 s, and any failure hands the turn to the agent (nothing is lost — DELEGATE
// is what most messages get anyway). The model still thinks: with thinking off (think:false) frentis sent a link alone and 「소개 페이지와
// 메모, 마인드맵을 만들어 줘」 to browser_task and 「주간 보고를 마크다운으로 써 줘」 to process, 3 of 3 times each; thinking, it
// delegated them and still picked schedule_task · browser_task · notify_member where those fit, in 0.9–3.7 s (measured 2026-11-25).
export const ROUTER_MS = Number(process.env.PRO_ROUTER_TIMEOUT_MS) || 6000
// each hint source is waited for this long at most (a slow one is left out of this turn; its result still fills its cache)
const HINT_MS = Number(process.env.PRO_ROUTER_HINT_MS) || 1500
const capped = (p, ms, fallback) => Promise.race([Promise.resolve(p).catch(() => fallback), new Promise((r) => setTimeout(() => r(fallback), ms).unref?.())])
// deepagents' skill list (an HTTP call per turn): kept a minute per person
const skillCache = new Map() // `${tenant}:${userId}` → {at, list}
function skillsOf(userId, jwt) {
  const key = `${config.tenantId}:${userId}`
  const hit = skillCache.get(key)
  if (hit && Date.now() - hit.at < 60_000) return Promise.resolve(hit.list)
  return listSkills(jwt).then((list) => { skillCache.set(key, { at: Date.now(), list }); return list })
}
// A router that gives up after 6 s drops tool routing silently when the gateway is slow (production once took 17.5 s): 「매주 월요일 9시에
// 주간 보고 써 줘」 would go to the agent and no schedule would be made (review 11-25 #8). Every fallback is counted and logged with the
// counts; on a timeout, the router is asked once more, for up to ROUTER_RETRY_MS, when the message needs one of its tools. Whether it
// does is read by the odds judge (meaning is the model's call, never words matched here); only when no reading can be had, the
// structural signs those tools take — an address, an attached file — decide. (A link alone is the commonest message and usually
// a summary: the judge, not the address, says whether to wait.)
export const ROUTER_RETRY_MS = Number(process.env.PRO_ROUTER_RETRY_MS) || 20_000
export const routerStats = { calls: 0, fallbacks: 0, timeouts: 0, errors: 0, badArgs: 0, retried: 0, answeredOnRetry: 0 }
const routerCounts = () => `fallbacks ${routerStats.fallbacks} of ${routerStats.calls} (timeouts ${routerStats.timeouts}, errors ${routerStats.errors}, bad arguments ${routerStats.badArgs}; asked again ${routerStats.retried}, answered then ${routerStats.answeredOnRetry})`
const isTimeout = (e) => /TimeoutError/.test(e?.name || '') || /timeout|timed out/i.test(String(e?.message || ''))
export const TOOL_OPTIONS = () => [
  { key: 'tool', label: L('지금 도구가 할 일이다: 예약 · 알림 · 팀원에게 알리기 · 사이트에서 하는 일(로그인 · 주문 · 신청) · 패널 기록 · 프로세스 시작 · 메일 보내기',
    'A tool must do it now: a schedule or reminder, notifying a teammate, work on a website (signing in, ordering, applying), a panel record, starting a process, sending a mail') },
  { key: 'agent', label: L('에이전트가 할 일이다: 답 · 조사 · 요약 · 문서나 파일 작성', 'Work for the agent: an answer, research, a summary, writing a document or file') },
]
// does this message need one of the router's tools? → {want, via: 'odds'|'structure', p?}
export async function toolWanted({ text, attachments = 0, judge = oddsOf }) {
  const r = await judge(L(`사용자가 한 말: ${String(text || '').slice(0, 400)}`, `The person said: ${String(text || '').slice(0, 400)}`),
    L('이 말을 처리하려면 무엇이 필요한가?', 'What does handling this message take?'), TOOL_OPTIONS(), { timeoutMs: TURN_ODDS_MS }).catch(() => null)
  if (r?.probabilities) return { want: (r.probabilities.tool ?? 0) >= 0.5, via: 'odds', p: r.probabilities.tool ?? 0 }
  return { want: /https?:\/\/\S/i.test(String(text || '')) || attachments > 0, via: 'structure' }
}
// → {call, args} when a tool is called, {call: null} for DELEGATE, null when the router failed (the agent takes the turn too)
// call: the model call; judge: the odds reading (tests replace both); limitMs / retryMs: the two time limits
// tasks: the thread's recent task cards as lines (lib/turnPlan.js taskCards — a request that refers to one: 「아까 만들기로 한 노트북」)
// attachments: how many files the message carries
export async function routeTurn({ user, session, hist, now, tasks = [], signal, attachments = 0, call = chat, judge = oddsOf, limitMs = ROUTER_MS, retryMs = ROUTER_RETRY_MS }) {
  const userId = user.id
  const t0 = Date.now()
  const [skillList, processHint, teamHint, appHint, schedHint] = await Promise.all([
    capped(skillsOf(userId, session.access_token), HINT_MS, []),
    capped(processCatalogHint(), HINT_MS, ''),
    capped(teamCatalogHint(userId), HINT_MS, ''),
    capped(panelAppHint(user), HINT_MS, ''),
    capped(scheduleCatalogHint(userId), HINT_MS, ''),
  ])
  const skillHint = skillList.length ? `\n${L('사용 가능한 스킬(주기 작업에 쓸 수 있음)', 'Available skills (usable for recurring tasks)')}: ${skillList.map((k) => `${k.name} — ${k.description.slice(0, 80)}`).join(' / ')}` : ''
  // the browser skills, the same way: name and description only (lib/browserSkills.js — a body is read when a task uses it)
  const browserList = browserSkills()
  const browserHint = browserList.length ? `\n${L('브라우저 스킬(그 사이트에서 하는 일, browser_task 의 skill)', 'Browser skills (work done on that site; browser_task skill)')}: ${browserList.map((k) => `${k.name} — ${k.description.slice(0, 200)}`).join(' / ')}` : ''
  const taskHint = tasks.length ? `\n${TP.taskBlock(tasks)}` : ''
  const hintMs = Date.now() - t0
  const model = config.llm.fastModel
  routerStats.calls++
  const fallback = (why) => { routerStats.fallbacks++; console.warn(`[router] model=${model} ${why} after ${Date.now() - t0} ms (hints ${hintMs} ms) → delegate · ${routerCounts()}`); return null }
  const ask = (ms) => call({
      model,
      temperature: 0,
      // (a cap: a routing answer is a tool call or one word — send_mail's body is the longest argument)
      maxTokens: 1500, timeoutMs: ms, signal,
      // with no apps to name, a small router model still reaches for panel_record ("'문서 작성' 패널을 찾지 못했어요")
      // (send_mail is the demo scenarios' — the demo outbox, config.scenarios; off, a mail request goes where it went before them)
      tools: routerTools(ROUTER_TOOLS.filter((t) => (appHint || t.function.name !== 'panel_record') && (config.scenarios || t.function.name !== 'send_mail'))),
      messages: [
        { role: 'system', content: isEn()
          ? PERSONA_EN.replace('{now}', now) + skillHint + browserHint + processHint + teamHint + appHint + schedHint + taskHint + '\nCall a tool only when a specific tool is needed; for any other question, document writing, analysis or work, answer with the single word "DELEGATE" and no tool.'
          : PERSONA.replace('{now}', now) + skillHint + browserHint + processHint + teamHint + appHint + schedHint + taskHint + '\n특정 도구가 필요할 때만 도구를 호출하고, 그 외 질문·문서작성·분석·업무 처리는 도구 없이 "DELEGATE" 한 단어만 답해.' },
        ...hist.slice(-8),
      ],
    })
  let route
  try { route = await ask(limitMs) } catch (e) {
    // 멈추기 (the turn's own signal), or the message turned out to be about the last result: no fallback — the caller decides
    if (signal?.aborted) return null
    if (!isTimeout(e)) { routerStats.errors++; return fallback(`failed (${String(e.message || e).slice(0, 120)})`) }
    routerStats.timeouts++
    const said = hist[hist.length - 1]?.content
    const w = await toolWanted({ text: typeof said === 'string' ? said : '', attachments, judge })
    if (signal?.aborted) return null
    if (!w.want) return fallback(`gave no answer in ${limitMs} ms (no tool needed: ${w.via}${w.p != null ? ` ${w.p.toFixed(2)}` : ''})`)
    routerStats.retried++
    console.warn(`[router] model=${model} gave no answer in ${limitMs} ms; the message needs a tool (${w.via}${w.p != null ? ` ${w.p.toFixed(2)}` : ''}) — asking again for up to ${retryMs} ms`)
    try { route = await ask(retryMs); routerStats.answeredOnRetry++ } catch (e2) {
      if (signal?.aborted) return null
      if (isTimeout(e2)) return fallback(`gave no answer again in ${retryMs} ms`)
      routerStats.errors++
      return fallback(`failed on the second try (${String(e2.message || e2).slice(0, 120)})`)
    }
  }
  const tc = route?.tool_calls?.[0] || null
  let args = {}
  if (tc) {
    try { args = JSON.parse(tc.function.arguments || '{}') || {} } catch (e) {
      routerStats.badArgs++
      return fallback(`${tc.function.name}: arguments are not JSON (${e.message})`)
    }
  }
  console.log(`[router] model=${model} ${Date.now() - t0} ms (hints ${hintMs} ms) → ${tc ? tc.function.name : 'DELEGATE'}`)
  return { call: tc, args }
}

// the person's scheduled tasks, for the router (run_schedule_now names one of these)
async function scheduleCatalogHint(userId) {
  const list = await listSchedules(userId).catch(() => [])
  if (!list.length) return ''
  const items = list.slice(0, 12).map((s) => `${s.id.slice(0, 8)} ${s.name}${s.paused ? L('(멈춤)', ' (paused)') : ''}`).join(' / ')
  return L(`\n내 예약 작업(지금 한 번 실행은 run_schedule_now, 새 예약이 아님): ${items}`, `\nMy scheduled tasks (run one now with run_schedule_now, not a new schedule): ${items}`)
}

// A scheduled task, run once now (lib/missions.js runMission 'manual'): its result comes to this
// conversation like a scheduled run's, under its divider — even when nothing crossed its condition.
async function runScheduleNowTurn({ userId, threadId, s, onDelta, acked = false }) {
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

// where a task's results go besides the chat (pro_schedules.state.channels)
async function setChannel(s, channel, on) {
  const next = [...new Set([...channelsOf(s).filter((c) => c !== channel), ...(on ? [channel] : [])])]
  await q(`update pro_schedules set state = jsonb_set(coalesce(state,'{}'::jsonb), '{channels}', $2::jsonb) where id=$1 and user_id=$3`, [s.id, JSON.stringify(next), s.user_id])
  return next
}

// Telegram (lib/telegram.js): a task's alerts there too, the last answer sent there now, or connecting
// the person's bot. Not connected yet: a card in the chat connects it (src/components/TelegramConnect.vue),
// and a task already marked sends there from its next result on.
async function telegramTurn({ userId, threadId, text, kind, onDelta }) {
  const tg = await import('./telegram.js')
  const status = await tg.telegramStatus(userId).catch(() => ({ connected: false, linked: false }))
  const ready = status.connected && status.linked
  const say = async (t) => { const m = await addMessage(userId, threadId, 'agent', 'text', { text: t }); onDelta?.(t); return m }
  const card = (s) => addMessage(userId, threadId, 'agent', 'telegram_connect', { scheduleId: s?.id || null, scheduleName: s?.name || '' })
  const chip = (t, s) => addMessage(userId, threadId, 'agent', 'chip', { icon: 'bell', text: t, ...(s ? { scheduleId: s.id } : {}) })
  if (kind === 'connect') {
    if (ready) return say(L(`텔레그램 봇 @${status.bot} 이 이미 연결돼 있어요.`, `Your Telegram bot @${status.bot} is already connected.`))
    const m = await say(L('내 텔레그램 봇을 연결해 볼게요. 아래 카드 순서대로 하면 1분이면 돼요.', "Let's connect your Telegram bot. Follow the card below — it takes about a minute."))
    await card(null)
    return m
  }
  const all = await listSchedules(userId)
  const s = pickSchedule(all, text, recentScheduleIds((await history(threadId, 10)).slice(-8)), { only: false })
  if (kind === 'off') {
    if (!s) return say(L('어느 예약 작업의 텔레그램 알림을 끌지 찾지 못했어요. 작업 이름을 알려 주세요.', "I couldn't tell which scheduled task's Telegram alerts to turn off. Tell me its name."))
    await setChannel(s, 'telegram', false)
    const m = await say(L(`「${s.name}」 결과는 이제 텔레그램으로 보내지 않아요.`, `"${s.name}" results won't go to Telegram any more.`))
    await chip(L(`텔레그램 알림 끔 · ${s.name}`, `Telegram alerts off · ${s.name}`), s)
    return m
  }
  if (kind === 'alerts' && !s) {
    if (!all.length) return say(L('텔레그램으로 알려 드릴 예약 작업이 아직 없어요. 무엇을 언제 확인할지 먼저 말해 주세요.', "There's no scheduled task to alert you about yet. Tell me what to check and when first."))
    return say(L(`어느 예약 작업의 알림을 텔레그램으로 보낼까요? ${all.slice(0, 5).map((x) => `「${x.name}」`).join(', ')} 중에서 이름을 말해 주세요.`,
      `Which scheduled task should alert you on Telegram? Name one of: ${all.slice(0, 5).map((x) => `"${x.name}"`).join(', ')}.`))
  }
  if (kind === 'alerts') {
    await setChannel(s, 'telegram', true)
    if (ready) {
      const m = await say(L(`좋아요. 「${s.name}」에서 알릴 일이 생기면 채팅과 함께 텔레그램(@${status.bot})으로도 보내 드릴게요.`,
        `Done. When "${s.name}" has something to tell you, it goes to Telegram (@${status.bot}) as well as this chat.`))
      await chip(L(`텔레그램 알림 켬 · ${s.name}`, `Telegram alerts on · ${s.name}`), s)
      return m
    }
    const m = await say(L(`「${s.name}」 알림을 텔레그램으로도 보내도록 해 둘게요. 먼저 내 텔레그램 봇을 연결해 주세요 — 아래 카드에서 1분이면 돼요. 연결되면 다음 알림부터 텔레그램으로 가요.`,
      `I've set "${s.name}" to alert you on Telegram too. First connect your Telegram bot with the card below — about a minute. Alerts go there from the next one on.`))
    await card(s)
    return m
  }
  // the last answer of this conversation, now
  const rows = await history(threadId, 14)
  const last = [...rows].reverse().find((r) => r.role === 'agent' && (r.kind === 'text' || r.kind === 'doc') && r.content?.text)
  if (!last) return say(L('텔레그램으로 보낼 답을 찾지 못했어요. 보낼 내용을 알려 주세요.', "I couldn't find an answer to send to Telegram. Tell me what to send."))
  if (!ready) {
    const m = await say(L('먼저 내 텔레그램 봇을 연결해 주세요. 연결하면 바로 보낼 수 있어요.', 'Connect your Telegram bot first — then I can send it right away.'))
    await card(null)
    return m
  }
  try {
    await tg.sendTelegram(userId, last.content.text)
    const m = await say(L(`텔레그램(@${status.bot})으로 보냈어요.`, `Sent to Telegram (@${status.bot}).`))
    return m
  } catch (e) {
    return say(L(`텔레그램으로 보내지 못했어요: ${e.message}`, `I couldn't send it to Telegram: ${e.message}`))
  }
}

// One run of the agent on a fresh variation of a shared folder, in its own conversation.
async function folderTurn({ user, session, threadId, text, onDelta, folder }) {
  // (a variation is made before the agent is called: not for a turn stopped in its front stage)
  checkpoint(turnCtx.getStore()?.turn)
  const work = await startChatWork({ user, folder, text, threadId })
  // stopped while the variation was being made (review 11-25 #5): it is closed as a stopped run, and the chat is not pointed at it
  const stoppedNow = turnCtx.getStore()?.turn?.stopped
  if (stoppedNow) {
    await finishChatWork({ user, folder, v: work.v, threadId, room: work.room, seeded: work.seeded, stopped: true }).catch((x) => console.warn('[folders] chat work', x.message))
    checkpoint(turnCtx.getStore()?.turn)
  }
  await TF.noteVariation(user, threadId, folder, work.v).catch(() => {})
  // (folder: the run's own room — the main chat does not move into it, so the next message is not
  // answered there: lib/agent.js delegate)
  pinned.set(threadId, { conversationId: work.room, title: folder.kind === 'skill' ? L(`${folder.name} 스킬 고치기`, `Fix the ${folder.name} skill`) : L(`${folder.name} 폴더 작업`, `${folder.name} folder work`), folder: true })
  let msg
  try { msg = await delegate({ user, session, threadId, text: work.message, onDelta }) } catch (e) {
    if (!e?.turnStopped) throw e
    // stopped before the agent was called (review 11-25 #5): the variation made for it is closed as a stopped run, and the chat
    // does not stay pointed at its room
    pinned.delete(threadId)
    await finishChatWork({ user, folder, v: work.v, threadId, room: work.room, seeded: work.seeded, stopped: true }).catch((x) => console.warn('[folders] chat work', x.message))
    throw e
  }
  await finishChatWork({ user, folder, v: work.v, threadId, room: work.room, seeded: work.seeded, stopped: !!msg?.content?.stopped }).catch((e) => console.warn('[folders] chat work', e.message))
  await TF.announce(user.id, threadId).catch(() => {})
  return msg
}

// Delegate to process-gpt deepagents and stream its answer.
// Steer the agent to connector tools when the request is plainly about one of those services;
// smaller models otherwise tend to reach for generic web fetching among dozens of tools.
// [words, its tools, the MCP server (mcp/connectors.js) that serves them]
const CONNECTOR_HINTS = [
  [/유튜브|youtube|채널|영상/i, 'youtube_trending, youtube_search, youtube_channel_videos, youtube_video_info, youtube_transcript', 'pgpt-youtube'],
  [/캘린더|일정|gmail|메일함|구글 ?드라이브|drive|\bcalendar\b|\binbox\b/i, 'calendar_find_events, calendar_create_event, gmail_search, gmail_read, drive_search', 'pgpt-google'],
  [/slack|슬랙/i, 'slack_list_channels, slack_read_channel, slack_post_message', 'pgpt-slack'],
  [/github|깃허브|\bPR\b/i, 'github_list_prs, github_search_issues, github_create_issue', 'pgpt-github'],
  [/notion|노션/i, 'notion_search, notion_read_page, notion_create_page', 'pgpt-notion'],
]
// Where public YouTube data is when the YouTube tools are not there (a run in a sandbox can read these)
const YT_PUBLIC = ' — YouTube 는 채널 새 영상: https://www.youtube.com/feeds/videos.xml?channel_id=UC…(채널 페이지 HTML 의 "externalId" 가 id), 오늘 많이 본 영상: https://www.youtube.com/results?search_query=<주제>&sp=CAMSBAgCEAE%3D (오늘 올라온 영상·조회수 순, HTML 안 ytInitialData 의 videoRenderer·lockupViewModel). 지역 인기 차트 자체는 API(youtube_trending)로만 볼 수 있어요(공개 인기 페이지는 2025년에 없어져 브라우저로도 못 보니 브라우저로 찾지 마세요)'
const YT_PUBLIC_EN = ' — for YouTube, a channel\'s new videos: https://www.youtube.com/feeds/videos.xml?channel_id=UC… (the channel page HTML\'s "externalId" is the id); today\'s most viewed: https://www.youtube.com/results?search_query=<topic>&sp=CAMSBAgCEAE%3D (uploaded today, by view count; videoRenderer / lockupViewModel in the HTML\'s ytInitialData). The regional popular chart itself is only in the API (youtube_trending); the public Trending page was retired in 2025, so do not look for it in the browser'
// Anything that sounds recurring is the router's call (schedule_task), never a one-off delegate.
// the last line a scheduled skill run prints (lib/missions.js parseResult)
const MISSION_LINE = '맨 마지막 줄에 MISSION_RESULT: {"changed": true|false, "summary": "결과 한 문장"} 를 한 줄로 출력'
const MISSION_LINE_EN = 'print on the very last line, as one line: MISSION_RESULT: {"changed": true|false, "summary": "one sentence with the result"}'
const RECURRING = /매일|매주|매달|매시|마다|주기|정기|반복|한\s*번씩|한번씩|\d+\s*(초|분|시간|일)\s*(에|간격|마다)|every|hourly|daily|weekly|monthly|on a schedule|recurring/i
// Something to do on a site the message gives the address of: signing in, paying, ordering, booking, submitting.
const SITE_ACTION = /로그인|결제|주문|구매|예약|발행|신청|제출|\b(log\s*in|sign\s*in|check\s*out|pay|order|purchase|book|submit)\b/i
// A document or file to write: a kind of document (or a file format) followed closely by a verb of making.
const DOC_REQUEST = /(docx|hwpx|pptx|xlsx|워드|한글\s*(파일|문서)|파워포인트|문서|보고서|안내문|제안서|기획서|공문|견적서|회의록)[^.?!\n]{0,20}(작성|만들|써\s*줘|뽑아)/i
// the same in English ("write a proposal", "make me a Word document", "draft the quote as xlsx")
const DOC_REQUEST_EN = /\b(write|make|create|draft|prepare|put together|generate|produce)\b[^.?!\n]{0,40}\b(docx|hwpx|pptx|xlsx|word|powerpoint|excel|document|doc|report|notice|announcement|proposal|plan|letter|quote|quotation|estimate|minutes|memo|slides?|deck|spreadsheet|brochure|flyer)\b/i
// English requests the Korean shortcuts above recognise in Korean
// a new process (definition) to design: "make a process for …", "create a workflow …"
export const PROCESS_REQUEST_EN = /\b(make|create|build|design|set up|model)\b[^.?!\n]{0,30}\b(process|workflow)\b/i
const SKILL_REQUEST_EN = /\b(make|create|build|write|author|set up)\s+(me\s+)?(a|an|the|my)?\s*(new\s+)?([\w'-]+\s+){0,3}skill\b/i
const PANEL_REQUEST_EN = /^New panel\s*[:：]|\b(make|create|build|add|set up)\s+(me\s+)?(a|an|the|my)?\s*(new\s+)?([\w'-]+\s+){0,3}panel\b/i
// What a request for a Home panel / data app says (create_panel's own examples)
const IMPROVE_Q = /병목|크리티컬\s*패스|임계\s*경로|리드\s*타임|흐름\s*효율|가치\s*흐름|제약|오래\s*걸|느려|밀려|지연|단축|줄이|줄여|줄일|개선/
const IMPROVE_Q_EN = /bottleneck|critical path|lead\s*time|flow efficiency|value stream|constraint|tak(e|es|ing) (so |too )?long|\bslow|delay|speed (it |this )?up|shorten|reduce|cut (down )?the time|improve/i

const IMPROVE_PROMPT_EN = `You are a business process improvement consultant. Answer the user's question in English, using only the 'analysis result (JSON)' below.
Rules:
- Copy numbers exactly as they are in the JSON. Do not calculate new ones or make any up. Do not mention numbers the JSON does not have.
- Order: (1) where the bottleneck/constraint is (step, owner, utilization, share of lead time spent waiting) (2) why (arrivals per day vs capacity, trend of items waiting) (3) how to reduce it — the 2-3 actions from five_focusing_steps that cut lead time the most, each with before → after numbers (4) a last line: on the Improve screen you can try changes and preview them, and create a new version with "Apply proposal".
- 8-12 lines. Lists with '- '. Don't blame people; explain it through the flow of work.`
const IMPROVE_PROMPT = `너는 업무 프로세스 개선 컨설턴트야. 사용자의 질문에 아래 '계산 결과(JSON)'만 근거로 한국어 해요체로 답해.
규칙:
- 숫자는 JSON 에 있는 값을 그대로 옮겨 써. 새로 계산하거나 지어내지 마. JSON 에 없는 숫자는 말하지 마.
- 순서: ① 병목·제약이 어디인지(단계·담당·가동률·리드타임 중 대기 비중) ② 왜 그런지(하루 도착 건수 vs 처리 능력, 대기 건수 추세) ③ 어떻게 줄일지 — five_focusing_steps 의 행동 중 리드타임을 가장 많이 줄이는 2~3개를 전→후 숫자와 함께 ④ 마지막 한 줄: 개선 화면에서 바꿔 보며 미리 계산하고 「개선안 적용」으로 새 버전을 만들 수 있다고 안내.
- 8~12줄. 목록은 '- ' 로. 사람을 탓하지 말고 일의 흐름으로 설명해.`

// the explanation without a model (the model is down or slow): the same facts, in a fixed shape
function improveTemplate(b) {
  const c = b.constraint
  const acts = b.five_focusing_steps.flatMap((s) => s.actions || []).filter((x) => x.lead_time).slice(0, 3)
  if (isEn()) return [
    `The ${b.process} process (${b.completed} completed) has a median lead time of ${b.lead_time.median} and a flow efficiency of ${b.flow_efficiency}.`,
    c ? `The bottleneck is the ${c.step} step (${c.who}). Utilization is ${c.utilization} (${c.arrivals_per_day} arriving a day, capacity ${c.capacity_per_day ?? '-'} a day), and waiting before this step takes ${c.wait_share_of_lead_time} of the lead time.` : '',
    ...acts.map((x) => `- ${x.title}: lead time ${x.lead_time}`),
    '',
    'On the Improve screen you can try changes and preview them, then create a new version with "Apply proposal".',
  ].filter((x) => x != null).join('\n')
  return [
    `${b.process} 프로세스(완료 ${b.completed}건)의 리드타임 중앙값은 ${b.lead_time.median}, 흐름 효율은 ${b.flow_efficiency}예요.`,
    c ? `병목은 ${c.step}(${c.who}) 단계예요. 가동률 ${c.utilization}(하루 ${c.arrivals_per_day}건 도착, 처리 능력 ${c.capacity_per_day ?? '-'}건)이고, 이 단계 앞 대기가 리드타임의 ${c.wait_share_of_lead_time}를 차지해요.` : '',
    ...acts.map((x) => `- ${x.title}: 리드타임 ${x.lead_time}`),
    '',
    '개선 화면에서 바꿔 보며 미리 계산하고, 「개선안 적용」으로 새 버전을 만들 수 있어요.',
  ].filter((x) => x != null).join('\n')
}

async function improveTurn({ user, threadId, text, onDelta, proc }) {
  let b
  try { b = await improveBrief(user, proc.id) } catch (e) {
    const say = e.status === 403 ? L(`${proc.name} 프로세스는 참여한 사람과 관리자만 분석을 볼 수 있어요.`, `Only the people who took part in the ${proc.name} process and administrators can see its analysis.`) : L(`${proc.name} 프로세스를 분석하지 못했어요: ${e.message}`, `I couldn't analyze the ${proc.name} process: ${e.message}`)
    onDelta?.(say)
    return addMessage(user.id, threadId, 'agent', 'text', { text: say })
  }
  let say = ''
  try {
    // a slow or absent model must not hold the answer: after 25 s the same facts go out in a fixed shape
    const r = await chat({ model: config.llm.fastModel, temperature: 0.2, signal: AbortSignal.timeout(Number(process.env.PRO_IMPROVE_EXPLAIN_MS || 25000)),
      messages: isEn() ? [{ role: 'system', content: IMPROVE_PROMPT_EN }, { role: 'user', content: `Question: ${text}\n\nAnalysis result (JSON):\n${JSON.stringify(b)}` }]
        : [{ role: 'system', content: IMPROVE_PROMPT }, { role: 'user', content: `질문: ${text}\n\n계산 결과(JSON):\n${JSON.stringify(b)}` }] })
    say = String(r.content || '').trim()
  } catch (e) { console.warn('[improve] explain', e.message) }
  if (!say) say = improveTemplate(b)
  onDelta?.(say)
  const m = await addMessage(user.id, threadId, 'agent', 'text', { text: say })
  const acts = b.five_focusing_steps.flatMap((s) => (s.actions || []).map((x) => ({ ...x, stage: s.stage }))).filter((x) => x.lead_time).slice(0, 3)
  await addMessage(user.id, threadId, 'agent', 'improve', { defId: b.id, name: b.process, url: b.link, completed: b.completed, lead: b.lead_time, flow: b.flow_efficiency, constraint: b.constraint,
    path: b.critical_path.path, actions: acts.map((x) => ({ title: x.title, lead: x.lead_time, flow: x.flow_efficiency })) })
  return m
}

const PANEL_WORDS = /패널|위젯|앱|홈에|대시보드|관리|대장|목록|명단|추적|트래커|현황판|날씨|환율|주가|주식/
const PANEL_WORDS_EN = /\b(panel|widget|app|on home|dashboard|manage|management|tracker|track|list|roster|register|ledger|log|board|weather|exchange rate|stock|stocks|share price)\b/i
// Teammates and who holds which role, so "제품 책임자한테 알려줘" can name someone.
async function teamCatalogHint(userId) {
  const team = (await listTeam()).filter((m) => m.id !== userId)
  if (!team.length) return ''
  const roles = await listAssignments(null)
  const held = (id) => roles.filter((r) => r.user_id === id && r.proc_def_id === '*').map((r) => r.role)
  return `\n${L('팀원(알림 대상)', 'Teammates (can be notified)')}: ${team.map((m) => `${m.name}${held(m.id).length ? `(${held(m.id).join(', ')})` : ''}`).join(', ')}`
}

// Recent processes with their start-form fields, so a schedule can name one and fill its first step.
// (per company and language: the definitions and the map's process names are the company's own)
const catalogCache = new Map() // `${tenant}:${lang}` → {at, text}
async function processCatalogHint() {
  const key = `${config.tenantId}:${isEn() ? 'en' : 'ko'}`
  const hit = catalogCache.get(key)
  if (hit && Date.now() - hit.at < 60000) return hit.text
  const defs = (await listDefinitions()).slice(0, 12)
  const lines = []
  for (const d of defs) {
    const def = await getDefinition(d.id).catch(() => null)
    const keys = (def?.startForm?.fields || []).map((f) => f.key).join(', ')
    lines.push(`${d.id} — ${d.name}${keys ? L(` (첫 단계 입력: ${keys})`, ` (first-step inputs: ${keys})`) : ''}`)
  }
  // the company process map's processes (lib/ontology/editmap.js chatEdit): what «○○ 프로세스에서 … 바꿔 줘» names
  const mapped = await import('./ontology/store.js').then(async (S) => (S.ontologyEnabled() ? (await S.readGraph({})).processes.filter((p) => p.kind !== 'routine' && (p.tasks || []).length > 1).sort((a, b) => (b.cases || 0) - (a.cases || 0)).slice(0, 12).map((p) => p.name) : [])).catch(() => [])
  const text = (lines.length ? `\n${L('주기적으로 시작할 수 있는 프로세스', 'Processes that can be started on a schedule')}: ${lines.join(' / ')}` : '')
    + (mapped.length ? `\n${L('회사 프로세스 지도의 프로세스(바꾸거나 의견을 말하면 process edit_map)', 'Processes on the company process map (changes or improvement ideas → process edit_map)')}: ${mapped.join(' / ')}` : '')
  catalogCache.set(key, { at: Date.now(), text })
  return text
}

// The one-off connector shortcut. Someone who keeps records in panel apps ("할 일", "팀 일정") may
// mean one of those by "일정 추가": then only a connector they actually connected takes the
// message; otherwise the router sees their apps (panel_record) and decides.
async function connectorFirst(user, text) {
  const hinted = CONNECTOR_HINTS.filter(([re]) => re.test(text)).flatMap(([, t]) => t.split(', '))
  if (!hinted.length) return false
  if (!(await PanelApps.listApps(user).catch(() => [])).length) return true
  const { connectorStatus } = await import('../mcp/connectors.js')
  return (await connectorStatus(user.id).catch(() => [])).some((c) => c.connected && c.tools.some((t) => hinted.includes(t)))
}
// The order for any outside service (a scheduled run included): its connector/API tools, then public
// pages or feeds read in the sandbox, then the built-in browser; and when all of it fails, exactly what
// is missing and where to connect it — never a bare "not connected".
export function connectorHint(text) {
  const hit = CONNECTOR_HINTS.filter(([re]) => re.test(text))
  if (!hit.length) return ''
  const tools = hit.map(([, t]) => t).join(', ')
  const servers = hit.map(([, , s]) => s).join(', ')
  const yt = hit.some(([, t]) => t.includes('youtube_'))
  return L(`\n\n(외부 서비스 정보는 이 순서로 구하세요. ① 연결된 커넥터·API 도구를 웹 조회보다 먼저: ${tools}. ② 그 도구가 목록에 없거나 실패하면 공개 페이지·RSS 를 샌드박스에서 직접 읽기${yt ? YT_PUBLIC : ''}. ③ 그래도 안 되면 내장 브라우저(browser_task 도구가 있을 때, 읽기만). ④ 모두 안 되면 "연결되어 있지 않다"로 끝내지 말고 무엇이 없어서 못 했는지와 어디서 연결하는지를 정확히 쓰세요: 도구가 돌려준 missing·how_to_connect 를 그대로 옮기고, 도구가 아예 목록에 없으면 "이 회사 에이전트에 ${servers} 커넥터가 등록되어 있지 않아 관리자가 등록해야 해요"라고 쓰세요.)`,
    `\n\n(Get outside-service information in this order. 1) The connected connector/API tools, before searching the web: ${tools}. 2) If those tools are not in your list or fail, read public pages or feeds yourself in the sandbox${yt ? YT_PUBLIC_EN : ''}. 3) If that fails too, the built-in browser (the browser_task tool, when you have it; reading only). 4) If everything fails, do not stop at "not connected": say exactly what was missing and where to connect it — copy the missing and how_to_connect a tool returned, and if the tools are not in your list at all, say "the ${servers} connector is not registered for this company's agents; an administrator has to register it".)`)
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
// (a conversation started outside the composer — a mail's follow-up action, lib/mailFollow.js — is filed the same way: it is listed in
// the chat's 대화 and the router can route later messages into it)
export const fileConversation = (user, { conversationId, title, kind = 'conversation' }, text, answer = '') => touchContext(user, { conversation_id: conversationId, context: { title, kind } }, text, answer)
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
async function askStop(session, conv) {
  if (!conv) return false
  const r = await fetch(`${config.deepagentsUrl}/chat/stop`, {
    method: 'POST', signal: AbortSignal.timeout(20_000),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}`, 'X-Tenant-Id': config.tenantId },
    body: JSON.stringify({ conversation_id: conv, tenant_id: config.tenantId }),
  }).then((x) => x.json()).catch((e) => ({ stopped: false, error: e.message }))
  return !!r.stopped
}
// why: what its answer says instead (a turn replaced by a correction); a turn still waiting its turn
// never reaches the agent (delegate)
async function stopTurn(t, session, why) {
  t.stopped = true
  if (why) t.reason = why
  // the stream ends with "turn cancelled" once deepagents stops it; if it does not, stop waiting
  const ok = t.started ? await askStop(session, t.conv) : false
  if (!ok) t.abort.abort()
  else setTimeout(() => { if (!t.finished) t.abort.abort() }, 8000).unref?.()
}
export async function stopTurns({ user, session, threadId, conversation }) {
  const list = turns.toStop(turns.running({ userId: user.id, threadId, conv: conversation || null }))
  for (const t of list) await stopTurn(t, session)
  if (!list.length) {
    const thread = await getThread(user.id, threadId)
    const conv = conversation || thread?.conversation_id
    const ok = await askStop(session, conv)
    await setThreadStatus(user.id, threadId, null)
    return { stopped: ok ? 1 : 0, waiting: turns.waiting({ userId: user.id, threadId }).length }
  }
  return { stopped: list.length, waiting: turns.waiting({ userId: user.id, threadId }).length }
}

// pin: the conversation this turn goes to, given by the caller ({conversationId, title} — a mail's follow-up action, lib/mailFollow.js):
// taken before anything else could take the thread's pinned one (a pin set in the map could be picked up by another turn of the thread)
// background: a turn started by a button, not by what the person typed in this chat (a mail's follow-up action) — the chat stays in the
// conversation the person is in, and the turn does not take what is open on the screen (the document, its editing tools) nor other
// conversations' context (PR #49 review)
// privateFiles: what this turn handed the agent that must never come back as a file card (a mail's attachment — [{path, sha256}]); by
// default what runTurn put on the turn (handleTurn)
export async function delegate({ user, session, threadId, text, onDelta, silent, mode, divider, quietIfUnchanged, hwpxTemplateUrl, fileTag, pin: given = null, background = false, privateFiles = null }) {
  // the person's message stopped in its front stage (runTurn): the agent is not called
  const st0 = turnCtx.getStore()
  if (st0?.turn && !st0.adopted && st0.turn.threadId === threadId) checkpoint(st0.turn)
  // asked to come after a browser task this message finishes first (「① … 마저 끝내고 → ② …」): the agent's work waits for it — the order
  // is said now, and the same words run once more as a request of their own when that task is over (the chat is not held meanwhile)
  const st = turnCtx.getStore()
  if (st?.after?.done && !st.after.deferred) {
    st.after.deferred = true
    const said = st.said || text
    const order = BQ.orderTextAgent(st.after.title)
    onDelta?.(order)
    st.after.done.catch(() => {}).then(() => runTurn({ user, session, threadId, text: said, again: true })).catch((e) => console.warn('[browser-queue] after', e.message))
    noAgentTurn({ kind: 'action', label: L('순서대로', 'In order') })
    return addMessage(user.id, threadId, 'agent', 'text', { text: order })
  }
  let thread = await getThread(user.id, threadId)
  // a main chat left standing in a shared folder's run room (as folder turns used to leave it) does
  // not answer the next message there
  if (thread?.kind === 'chat' && thread.conversation_id && await isFolderRoom(thread.conversation_id).catch(() => false)) {
    await q('update pro_threads set conversation_id=null where id=$1 and conversation_id=$2', [threadId, thread.conversation_id])
    thread = { ...thread, conversation_id: null }
  }
  const uploads = attached.get(threadId) || []
  attached.delete(threadId)
  let pin = given?.conversationId ? { conversationId: String(given.conversationId), title: String(given.title || '') } : pinned.get(threadId)
  if (!given?.conversationId) pinned.delete(threadId)
  // a project's view narrowed to one of its sub-topics sends that one (lib/projectTopics.js); a conversation that is not this
  // project's is not taken (the message is classified as any other)
  if (pin && !pin.folder && thread?.kind === 'project' && !(await PT.isTopic(user.id, thread, pin.conversationId).catch(() => false))) pin = null
  const store = turnCtx.getStore()
  const adopted = store?.turn && !store.adopted && store.turn.threadId === threadId
  const handedOver = privatePaths(privateFiles || (store?.mailAtts?.threadId === threadId ? store.mailAtts.handed : []))
  // what the person said (the text may carry hints after it): what a project's message is classified on, and its sub-topic's summary
  const asked = String((adopted && store?.said) || text || '')
  // In the main chat, several things run side by side (hark): the context-router decides which
  // conversation this message continues. A project's message is classified among the project's own
  // sub-topics (topical — lib/projectTopics.js). Instances, skill authoring and scheduled runs
  // already know their conversation and go straight to the agent.
  let routed = !pin && !!config.contextRouterUrl && thread?.kind === 'chat' && mode !== 'skill' && !divider
  const topical = PT.routesProject({ kind: thread?.kind, routerOn: PT.enabled(), pinned: !!pin, silent, background, divider, mode, generating: !!generationPending(threadId) })
  const conv0 = pin?.conversationId || (!routed && !topical ? thread?.conversation_id : null)
  // the place in line runTurn took when the message came in (so turns keep the order they were
  // sent in), or a new one for work started elsewhere (schedules, team assist, missions)
  if (adopted) store.adopted = true
  const turn = adopted ? store.turn : turns.enqueue({ userId: user.id, threadId, conv: conv0 })
  // (out of its front stage: a stop now reaches it once it runs, and a turn waiting its place in line goes on — lib/turns.js)
  if (adopted) { turn.front = false; TP.handler(turn, { kind: 'agent', label: L('에이전트', 'Agent') }) }
  // the POST stream's retract (an answer in progress turned out to be interim): only for the message that stream is for
  const retract = adopted ? store.onRetract : null
  turn.setConv(conv0)
  // a project's turns go one at a time, whichever sub-topic they are in (lib/turns.js waitTurn)
  turn.serial = thread?.kind === 'project'
  // what this turn leaves in a project — its cards, a stop or a failure — says which sub-topic it is (src/projectTopics.js): a card
  // written after the answer can come after the person's next message, which may be another sub-topic's
  const inProject = thread?.kind === 'project'
  const convTag = () => (inProject && turn.conv && !String(turn.conv).startsWith('none:') ? { conv: turn.conv } : {})
  // an agent turn: a correction that goes to the browser may replace it (replaceEarlier) — only one answering a
  // person's message in this thread, never a schedule, a mission or a team run delegated here
  turn.agent = true
  turn.fromUser = !!adopted
  turn.title = String(text || '').trim().split('\n')[0].slice(0, 60)
  // a shared folder's run room (folderTurn) is never offered to the router as a conversation in progress
  turn.folder = !!pin?.folder
  // the user's message this turn answers (runTurn), marked 대기 while it waits
  const userMsgId = adopted ? store.userMsgId : null
  // a turn replaced by a browser task does not mark the thread idle under that task
  const idleStatus = () => (turn.reason && runningIn(user.id, threadId) ? 'working' : null)
  let routing = null
  let preRouted = false
  // routed among a project's sub-topics (the turn's row is the project's: PT.fileTopic, not the main chat's touchContext)
  let topicRouted = false
  try {
    let marked = false
    const queued = async () => {
      if (!userMsgId || marked) return
      marked = true
      TP.stage(turn, 'queued')
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
    // a project's message: which of its sub-topics (decided before it waits its place, so a follow-up of a request still being
    // answered joins that one); no decision — the router off or unreachable — and it goes where the project's turns always went
    if (topical) {
      const ahead = (await turns.aheadInThread(turn)).filter((x) => !x.folder)
      thread = await getThread(user.id, threadId)
      const r = await PT.routeProject({ user, thread, text: asked, ahead })
      if (r) {
        routing = r; preRouted = true; topicRouted = true
        turn.setConv(r.conversation_id)
        await PT.tagMessage(user.id, userMsgId, r.conversation_id).catch((e) => console.warn('[topics] tag', e.message))
      } else turn.setConv(thread?.conversation_id)
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
    // replaced while it waited (replaceEarlier): it never goes to the agent
    if (turn.abort.signal.aborted) return addMessage(user.id, threadId, 'agent', 'text', { text: turn.reason || `(${stoppedText()})`, stopped: true, ...(turn.reason ? { superseded: true, replaced: true } : {}), silent, ...convTag() })
    return await runDelegated()
  } finally { turn.finish() }

  async function runDelegated() {
  // the main chat now stands in that conversation, so an unsure next message stays there too —
  // except a shared folder's run room: that room is one variation's work, finished with this turn
  // (an ordinary message or a Home card answered there edited the folder's checkout)
  if (pin && !pin.folder && !background) await q('update pro_threads set conversation_id=$2 where id=$1', [threadId, pin.conversationId])
  if (preRouted) await q('update pro_threads set conversation_id=$2 where id=$1', [threadId, routing.conversation_id])
  await setThreadStatus(user.id, threadId, 'working')
  TP.stage(turn, 'preparing')
  // tools that need no account (CADCraft) are bound once per user per server start
  if (!hubBound.has(user.id)) { hubBound.add(user.id); await ensureHubBinding(user.id, config.tenantId).catch(() => {}) }
  // the ArtCraft apps this message asks for list their tools to the agent (mcp/craft.js)
  // (or the document the page said is open with this message, when its live link is down)
  const live = !silent && !divider && !background ? liveOpen(user.id) || (adopted && store.openDoc) || null : null
  if (live?.fromPage) console.log(`[delegate] open document from the page: '${live.file}' (${live.editor || '?'}) user=${user.id.slice(0, 8)} — live link down`)
  activateCraft(user.id, [...craftAppsFor(text), ...(live ? [live.app] : [])])
  if (live?.app === 'ieumoffice') activateOffice(user.id)
  // a stalled agent (no byte for STREAM_IDLE_MS) is cut off, so the chat never sits on "생각하는 중" for good
  const idle = new AbortController()
  let idleTimer = setTimeout(() => idle.abort(), STREAM_IDLE_MS)
  const alive = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => idle.abort(), STREAM_IDLE_MS) }
  // 검수 (lib/review.js): what is open now, as it is before the agent's edits
  const before = live ? await capture({ userId: user.id, jwt: session.access_token, open: live }) : null
  // the live editor's edit calls from here on (mcp/office.js → lib/officeEdits.js): did any of them change the document?
  const editsFrom = Date.now()
  const usedTools = new Set()
  let partial = ''
  // 같은 요청 알아보기(lib/context/repeat.js): 나나 팀원이 이미 같은 요청을 해 답이 있으면 에이전트를 부르지 않고 카드로 묻는다
  // (그 답 보기 · 요청하기 · 그래도 새로 하기). 파일을 붙인 요청, 「새로 하기」로 다시 보낸 요청은 보지 않는다.
  const freshAsked = !!turnCtx.getStore()?.fresh
  if (thread?.kind === 'chat' && !silent && mode !== 'skill' && !divider && !pin?.folder && userMsgId && !freshAsked && !uploads.length) {
    const [said] = await q(`select content->>'text' as text from pro_messages where id = $1`, [userMsgId])
    const rep = said?.text ? await findRepeat(user, { threadId, message: said.text, userMsgId }).catch((e) => { console.warn('[delegate] repeat', e.message); return null }) : null
    if (rep?.hits?.length) {
      await setThreadStatus(user.id, threadId, null)
      clearTimeout(idleTimer)
      const h = rep.hits[0]
      const who = h.mine ? L('같은 요청을', 'the same request') : L(`${h.owner_name}님이 같은 요청을`, `${h.owner_name} made the same request`)
      return addMessage(user.id, threadId, 'agent', 'repeat', { text: L(`이미 한 요청이에요 — ${who} 했어요(「${h.title}」). 그 답을 볼까요, 새로 할까요?`, `Already asked — ${who} (“${h.title}”). See that answer, or do it again?`),
        repeat_id: rep.repeat_id, request: said.text, hits: rep.hits, ms: rep.ms })
    }
  }
  // 팀 맥락 공유(lib/context/refer.js): 메인 채팅의 턴마다 지금 일과 관계있는 다른 대화 맥락(내 것·팀이 공유한 것·허락받은 것)을
  // 골라 인용 블록으로 붙인다. 고른 결과는 사람 메시지에 남아 칩이 된다. 2초 안에 못 고르면 참고 없이 간다.
  const refer = thread?.kind === 'chat' && !silent && !background && mode !== 'skill' && !divider && !pin?.folder
    ? await referContext(user, { threadId, message: text, current: turn.conv || thread?.conversation_id || null, turnTitle: turn.title }).catch((e) => { console.warn('[delegate] refer', e.message); return null })
    : null
  if ((refer?.refer_id || refer?.off) && userMsgId) {
    const keep = refer.off ? { off: true } : { refer_id: refer.refer_id, used: refer.used, requestable: refer.requestable, ...(refer.skipped ? { skipped: refer.skipped } : {}) }
    const [m] = await q(`update pro_messages set content = content || jsonb_build_object('refer', $2::jsonb) where id=$1 returning *`, [userMsgId, JSON.stringify(keep)])
    if (m) emit(user.id, 'message', m)
  }
  // a project with a folder works on its own variation of it; a chat with one attached reads its main
  // (lib/folders/threadFolders.js) — not a shared folder's run room (folderTurn: its message says where)
  let projectWork = null, failed = false
  // (an instance's conversation has its work folder attached for reference — lib/mailWork.js: what is asked there reads its mails)
  if (!pin?.folder && (thread?.kind === 'project' || thread?.kind === 'chat' || thread?.kind === 'process')) {
    // (in the conversation this turn goes to — a project's sub-topic, lib/projectTopics.js — not the one the project stood in before)
    projectWork = await TF.prepareProjectWork({ user, thread: turn.conv ? { ...thread, conversation_id: turn.conv } : thread }).catch((e) => { console.warn('[folders] project work', e.message); return null })
    if (projectWork) { thread = { ...thread, conversation_id: projectWork.conv }; turn.setConv(projectWork.conv); text += projectWork.note }
    else {
      const ref = await TF.linkOf(threadId).catch(() => null)
      const hint = ref ? await TF.refHint(ref).catch(() => '') : ''
      if (hint) { text += hint; console.log(`[folders] reference hint: '${ref.slug}' thread=${String(threadId).slice(0, 8)}`) }
    }
  }
  try {
    const msg = await streamTurn()
    // the document's editor changed nothing although the agent edited (every edit call failed or changed nothing): the
    // answer says so plainly instead of the agent's 「맞췄어요」 (lib/officeEdits.js — the editor's own report)
    const edits = live?.app === 'ieumoffice' ? editsSince(user.id, editsFrom) : []
    if (editVerdict(edits) === 'none' && !turn.stopped && msg?.id && (msg.kind === 'text' || msg.kind === 'doc')) {
      const [m] = await q(`update pro_messages set kind='text', content = content || $2::jsonb where id=$1 returning *`,
        [msg.id, JSON.stringify({ text: notAppliedAnswer(edits, live.file), notApplied: true, claimed: String(msg.content?.text || '').slice(0, 4000) })])
      if (m) emit(user.id, 'message', m)
      console.log(`[delegate] office edits not applied (${edits.length}) user=${user.id.slice(0, 8)} — answer replaced`)
      return m || msg
    }
    // an edit tool of the open app or document ran: check the result against the request
    const prefix = live?.app === 'ieumoffice' ? /^office_live_(write|replace|apply_ops|hwp_)/ : new RegExp(`^${live?.app}_`)
    if (before && !turn.stopped && [...usedTools].some((t) => prefix.test(t) && !/(inspect|read|list|render|preview|find|query|guide|documents)/.test(t))) {
      await reviewTurn({ user, session, threadId, request: text.split('\n\n(')[0], open: live, before, applied: edits.filter((e) => e.applied) })
    }
    return msg
  } catch (e) {
    failed = true
    if (!idle.signal.aborted && !turn.abort.signal.aborted && !/fetch failed|ECONNREFUSED|deepagents \d/.test(e.message)) throw e
    console.warn('[delegate]', turn.reason ? 'replaced by a browser task' : turn.abort.signal.aborted ? 'stopped by the user' : idle.signal.aborted ? 'agent stream idle, aborted' : e.message)
    await setThreadStatus(user.id, threadId, idleStatus())
    if (turn.abort.signal.aborted && turn.reason) return addMessage(user.id, threadId, 'agent', 'text', { text: turn.reason, stopped: true, superseded: true, replaced: true, partial: partial.trim().slice(0, 4000), silent, ...convTag(), ...TP.saved(turn, 'stopped') })
    if (turn.abort.signal.aborted) return addMessage(user.id, threadId, 'agent', 'text', { text: [partial.trim(), `(${stoppedText()})`].filter(Boolean).join('\n\n'), stopped: true, silent, ...convTag(), ...TP.saved(turn, 'stopped') })
    return addMessage(user.id, threadId, 'agent', 'text', { ...convTag(), text: idle.signal.aborted
      ? L('에이전트가 한동안 응답하지 않아 기다리기를 멈췄어요. 같은 요청을 다시 보내 주세요.', "The agent didn't respond for a while, so I stopped waiting. Please send the same request again.")
      : L(`에이전트에 연결하지 못했어요. 잠시 후 다시 보내 주세요. (${causeOf(e)})`, `I couldn't reach the agent. Please send it again in a moment. (${causeOf(e)})`) })
  } finally {
    clearTimeout(idleTimer)
    // what the agent changed goes into the project's variation (commit; no merge card — the header's 반영 merges)
    if (projectWork) await TF.finishProjectWork(projectWork, { stopped: failed || turn.stopped || turn.abort.signal.aborted }).catch((e) => console.warn('[folders] project commit', e.message))
  }

  async function streamTurn() {
  // with usage limits on (lib/llmKeys.js): refused before the agent starts when a limit is spent, and the
  // agent's own model calls go out with this person's key
  const llmAuth = await llmKeys.admit()
  // the plan the person was shown (lib/turnPlan.js §1.4): the agent records it with write_todos and does only that work
  const planText = adopted && mode !== 'skill' && !silent && !divider ? await TP.planBlock(turn) : ''
  // the request, through the context router (viaRouter) or straight to the agent
  const request = async (viaRouter) => {
    // attachments are indexed for the conversation they go to (lib/attachments.js), so a new
    // conversation gets its id here — the SDK keeps a conversation_id it is given. The router's
    // choice is not known yet, so routed turns send theirs by address only.
    let conv = turn.conv || pin?.conversationId || thread?.conversation_id || null
    // (a scheduled run too: deepagents keeps the history of a chat sent without one under one shared key,
    // so every such first turn would carry all the earlier ones — 270k tokens and other people's runs)
    if (!conv && !viaRouter && (uploads.length || divider)) conv = crypto.randomUUID().replace(/-/g, '')
    const sent = conv && !viaRouter ? await indexForRoom(uploads, conv) : uploads
    return () => fetch(`${viaRouter ? config.contextRouterUrl : config.deepagentsUrl}/chat/stream`, {
      signal: AbortSignal.any([idle.signal, turn.abort.signal]),
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}`, 'X-Tenant-Id': config.tenantId, ...llmKeys.agentHeaders(llmAuth) },
      body: JSON.stringify({
        // English mode: the language instruction goes last, after what the person said and the hints
        message: (refer?.context ? `${refer.context}\n\n[지금 메시지]\n` : '') + text + connectorHint(text) + marketHint(text) + officeHint(text, hwpxTemplateUrl || config.hwpxTemplateUrl) + liveHint(live) + attachmentHint(sent) + workspaceHint(user, turn.conv) + planText + langInstruction({ said: asked }), message_uuid: crypto.randomUUID(), tenant_id: config.tenantId,
        files: chatFiles(sent),
        user_uid: user.id, user_email: user.email, user_name: user.name, user_jwt: session.access_token,
        conversation_id: conv, stream: true,
        metadata: { client: 'pgpt-pro', style: isEn() ? 'English, concise, first person. Use a markdown "# Title" first line only for long structured documents.' : 'Korean 해요체, concise. Use a markdown "# 제목" first line only for long structured documents.',
          // (the language in every mode: a message that is only a link has none of its own — design turnplan §1.5)
          language: isEn() ? 'en' : 'ko',
          ...(viaRouter ? { auto_route: true, route_text: text, agent: 'deepagents' } : {}) },
      }),
    })
  }
  const opened = await openTurn({ routed, request, stopped: () => idle.signal.aborted || turn.abort.signal.aborted })
  routed = opened.routed
  const res = opened.res
  if (!res.ok) throw new Error(`deepagents ${res.status}${await refusal(res)}`)
  TP.stage(turn, 'preparing')
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = '', event = ''
  // the answer (design turnplan §3.4): deepagents' done.content when it sends one, else the last text segment — an interim text
  // followed by a tool goes to the progress panel's 메모 instead. Errors are added after it; skill authoring keeps all its text.
  let doneText = null, hitl = null, errors = '', all = ''
  let openAt = 0
  const segs = TP.createSegments({
    stream: mode !== 'skill',
    onDelta: (d) => onDelta?.(d),
    onPromote: () => TP.stage(turn, 'writing'),
    onRetract: () => { retract?.(); TP.stage(turn, 'working') },
    onNote: (t) => { if (mode !== 'skill') TP.note(turn, t) },
    onOpen: (t) => { if (mode !== 'skill' && Date.now() - openAt > 400) { openAt = Date.now(); TP.note(turn, t, { open: true }) } },
  })
  const files = []
  const started = Date.now()
  const runDirs = new Set()
  let processResult = null
  let workDir = null
  let skillDraft = null
  let steps = 0
  let cancelled = false
  // provenance (lib/provenance.js): what this turn wrote, every workspace path it touched, and the
  // documents tool results carried, kept apart until the end
  const written = new Set()
  const seen = new Set()
  const toolDocs = []
  const inputs = new Map() // tool -> arguments of its last call
  // what this answer did on the way, shown under it (lib/workTrail.js: steps and the sites read, no commands)
  // (30 entries: the progress panel's 한 일 and the folded trail under the answer — design turnplan §3.5)
  const trail = createTrail(30)
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
        if (!thread?.conversation_id && !pin?.folder && !background) await q('update pro_threads set conversation_id=$2 where id=$1', [threadId, j.conversation_id])
      }
      if (j.type === 'token' && j.content) { all += j.content; segs.token(j.content); partial = segs.answer() }
      // a tool is being called: the text before it was on the way, not the answer — unless the call is bookkeeping (the to-do
      // list, a think step): then the text goes on (review 11-25 #2)
      if (j.type === 'tool_start') { if (TP.bookkeeping(j.tool || j.tool_name || j.name)) segs.mark(); else segs.cut() }
      if (j.type === 'plan_tools') {
        const called = (Array.isArray(j.tools) ? j.tools : []).map((t) => t?.tool || t?.name || '')
        if (called.length && called.every(TP.bookkeeping)) segs.mark(); else segs.cut()
      }
      if (j.type === 'plan_todos') TP.todos(turn, j.todos)
      // (the agent stopped to ask the person: its done.content is the question as JSON — kept apart, a later plain done does not
      // replace it)
      if (j.type === 'done' && typeof j.content === 'string') { if (TP.humanInput(j.content)) hitl = j.content; else doneText = j.content }
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
        // the next model call may write for a long while with nothing to stream: the live line counts from here
        if (j.type === 'tool_end') TP.stage(turn, 'working', { text: TP.nextStepText(), detail: 'after_tool' })
      }
      if (j.type === 'process_result' && j.data?.processDefinition) processResult = j.data
      if (j.type === 'tool_start') {
        const tool = j.tool || j.tool_name || j.name || ''
        usedTools.add(tool)
        inputs.set(tool, j.input ?? null)
        const entry = trail.add(tool, j.input, toolPhase(tool))
        for (const p of workspacePaths(j.input)) seen.add(p)
        steps += 1
        const said = mode === 'skill' ? skillStatus(tool, steps) : toolPhase(tool)
        emit(user.id, 'status', { threadId, text: said, turnId: turn.id, conversationId: turn.conv && !String(turn.conv).startsWith('none:') ? turn.conv : null })
        TP.stage(turn, 'working', { text: said })
        if (entry) TP.step(turn, entry)
      }
      if (j.type === 'error') {
        const why = String(j.message || j.error || '')
        // the SDK ended the turn: our own 멈추기, or another request on this conversation
        if (/turn cancelled/i.test(why)) cancelled = true
        else errors += L(`\n\n(오류: ${why})`, `\n\n(error: ${why})`)
      }
    }
  }
  await setThreadStatus(user.id, threadId, idleStatus())
  let body = `${mode === 'skill' ? all : TP.finalAnswer(hitl || doneText, segs).text}${errors}`.trim()
  const ended = cancelled || turn.stopped
  // a turn that wrote a process definition ends with its draft card, not a skill card for a skill
  // the generation picked up along the way
  if (skillDraft && !ended && !workDir) {
    // The card carries the skill itself; the agent's long write-up stays folded inside it.
    const host = await workspaceHostPath(skillDraft.dir).catch(() => null)
    const markdown = host ? await fs.readFile(`${host}/SKILL.md`, 'utf8').catch(() => '') : ''
    const files = host ? await listFolder(host) : []
    const summary = summarizeSkill(markdown)
    const draft = await addMessage(user.id, threadId, 'agent', 'skill_draft', { ...convTag(),
      ...skillDraft, ...summary, name: skillDraft.name, markdown, files, note: body.slice(0, 6000), state: 'draft',
    })
    return draft
  }
  if (quietIfUnchanged && !ended && /^(변동\s*없음|no changes?)[.!]?$/i.test(body.replace(/[*_`"]/g, '').trim())) return null
  if (divider) await addMessage(user.id, threadId, 'system', 'divider', typeof divider === 'string' ? { text: divider } : divider)
  // (replaced by a correction: the reason alone — what the agent had written so far is kept, not shown)
  const partialText = ended && turn.reason ? body.slice(0, 4000) : ''
  if (ended) body = turn.reason || [body, `(${turn.stopped ? stoppedText() : supersededText()})`].filter(Boolean).join('\n\n')
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
    // a shared folder's file the person asked to see (folder_open checked their membership): shown even
    // when the turn also saw that folder's checkout, where the same name is not this turn's output
    if (t.doc.open && /(^|[^a-z])folder_open$/.test(t.tool)) { if (!files.some((f) => f.url === t.doc.url)) files.push(t.doc); continue }
    const { keep, src } = await keepToolDoc({ name: t.raw, tool: t.tool, input: t.input }, seen, ctx)
    if (!keep) { console.log(`[delegate] not attached (not this turn's output): ${logPath(src, handedOver) || logName(t.doc.name, handedOver)}`); continue }
    if ((src && evalRun(src)) || workspacePaths(t.input).some(evalRun)) { console.log(`[delegate] not attached (a skill's test run): ${logPath(src, handedOver) || logName(t.doc.name, handedOver)}`); continue }
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
    if (why) { console.log(`[delegate] not attached (${why}): ${logPath(f.path, handedOver)}`); files.splice(files.indexOf(f), 1) }
  }
  if (!body && !files.length && !workDir) body = emptyText()
  // conv: 이 턴이 실제로 간 맥락(라우터가 「그대로」라고 한 턴은 context 에 맥락 id 가 없다) — 맥락의 턴을 찾는 표지(lib/context/items.js)
  const convNow = turn.conv || routing?.conversation_id || null
  const work = trail.list()
  const msg = await addMessage(user.id, threadId, 'agent', kind, { text: body, silent, ...(work.length ? { work } : {}), ...(context ? { context } : {}), ...(convNow ? { conv: convNow } : {}), ...(refer?.refer_id ? { refer_id: refer.refer_id } : {}),
    ...TP.saved(turn, ended ? 'stopped' : 'done', body),
    ...(ended ? { stopped: true, ...(turn.stopped && !turn.reason ? {} : { superseded: true }), ...(turn.reason ? { replaced: true, partial: partialText } : {}) } : {}) })
  // the conversation's row: a project's sub-topic under the project (routed, or the view narrowed to it), else the main chat's
  if (topicRouted || (pin && !pin.folder && thread?.kind === 'project')) {
    await PT.fileTopic(user, { id: threadId }, topicRouted ? routing : { conversation_id: pin.conversationId, context: { title: pin.title } }, asked, body)
      .catch((e) => console.warn('[topics] file', e.message))
  } else if (preRouted) touchContext(user, routing, text, body)
  if (convNow && userMsgId) await q(`update pro_messages set content = content || jsonb_build_object('conv', $2::text) where id=$1`, [userMsgId, convNow]).catch(() => {})
  if (convNow && thread?.kind === 'chat') rebuildSoon(user.id, convNow)
  // documents made by the agent's own scripts (no file_artifact event) are found and added too
  for (const f of files) if (f.url && !f.path) f.name = displayName(f, body)
  for (const p of await documentsOfRun({ text: body, dirs: rooms, since: started - 2000, userId: user.id }).catch(() => [])) {
    // office-mcp already published this one (store_and_render): one card per document
    const name = p.split('/').pop()
    if (files.some((f) => f.path === p || (f.url && f.name === name))) continue
    // (what the person attached or was handed — /workspace/uploads/ — is never this turn's output)
    if (uploadsPath(p)) { console.log(`[delegate] not attached (an upload): ${logPath(p, handedOver)}`); continue }
    const why = await notOutput(p)
    if (why) { console.log(`[delegate] not attached (${why}): ${logPath(p, handedOver)}`); continue }
    files.push({ name, path: p })
  }
  // never a card — a public copy — of an upload or of a mail's attachment handed over this turn, however the agent saved or named it
  // (its own folder, a new name, a copy deepagents stored): by its place, and by its content (review 11-25 #1)
  for (const f of [...files]) {
    const why = await privateCandidate(f, handedOver, user.id)
    if (why) { console.log(`[delegate] not attached (${why})`); files.splice(files.indexOf(f), 1) }
  }
  // the script that built a document is scaffolding; the document is what the user asked for (and
  // a turn that was stopped leaves no half-run scripts behind as results)
  if (ended || files.some((f) => editable(f.name))) files.splice(0, files.length, ...files.filter((f) => !/\.(py|js|mjs|ts|sh)$/.test(f.name)))
  for (const f of files) {
    // a document the agent wrote in its sandbox is published so the editor can load it
    if (!f.url && f.path && editable(f.name)) Object.assign(f, await publish(user.id, f.path, f.src).catch((e) => { console.warn('[office publish]', e.message); return {} }))
    delete f.src
    // fileTag: what the card belongs to, e.g. the mail whose draft it is (lib/mining/recorder.js)
    await addMessage(user.id, threadId, 'agent', 'file', { ...f, ...(fileTag || {}), ...convTag() })
  }
  // The draft card is the definition this turn wrote, read back from its folder the way saving reads
  // it (lib/generated.js) — not the first definition-shaped JSON in the stream: deepagents used to send
  // whatever the agent read first (the skill's schema sample "휴가 신청 프로세스", another saved
  // process). A turn that wrote no definition (the consulting draft) has no card.
  const contract = workDir && !ended ? await draftContract(workDir, processResult) : null
  if (contract) {
    generationDone(threadId)
    await addMessage(user.id, threadId, 'agent', 'process_draft', { contract, workDir, state: 'draft', ...convTag() })
  }
  // 후행 습관(lib/followups.js): what this turn made, whether it followed the last one, the usual next step. The answer is
  // already out; this never holds it up, and a scheduled run or a stopped answer teaches nothing.
  const tc = turnCtx.getStore()
  if (tc?.said && !ended && !silent && !divider && mode !== 'skill' && !contract) {
    afterTurn({ user, threadId, msg, conv: turn.conv || routing?.conversation_id || pin?.conversationId || thread?.conversation_id || null, title: context?.title, said: tc.said, files, attached: uploads, fromHabit: tc.habitId, session }).catch((e) => console.warn('[followups]', e.message))
    // 회사 프로세스 지도(design-v0.3 §12): a new request that starts one of the company's processes is offered as that process
    if (!tc.habitId && !tc.fileEvent) import('./ontology/run.js').then((m) => m.chatSuggest({ user, threadId, said: tc.said, conv: turn.conv || routing?.conversation_id || null })).catch((e) => console.warn('[ontology] chat suggest', e.message))
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

// Find the definition the user means; the catalogue is small enough to let the model pick.
async function pickDefinition(query) {
  const defs = await listDefinitions()
  if (!defs.length) return null
  const m = await chat({
    model: config.llm.fastModel, temperature: 0, json: true,
    messages: [
      { role: 'system', content: 'Pick the process the user means. Reply JSON {"id": "<id or null>"}' },
      { role: 'user', content: `${L('요청', 'Request')}: ${query}\n\n${L('목록', 'List')}:\n${defs.map((d) => `${d.id} | ${d.name}`).join('\n')}` },
    ],
  })
  const id = JSON.parse(m.content).id
  return defs.find((d) => d.id === id) || null
}

// Process design runs on process-gpt's own bpmn-process-generation-skill in deepagents.
// The skill pauses for a draft review; when the user agrees we restate the requirement and the
// remaining steps, since gpt-4.1 otherwise tends to stop or skip writing the definition file.
const generating = new Map() // threadId -> requirement
// deepagents (feat/pgpt-lite) validates and assembles the folder itself when the turn ends; it has no
// validate/complete tools any more, so asking for them only makes the agent stop and explain
const GEN_STEPS = 'bpmn-process-generation-skill 절차대로 진행해 주세요: 합의된 흐름으로 references 의 02-generate-definition 규격을 read_file 로 읽고 process-definition.json 을 write_file 로 작성 → 사용자 활동마다 forms/<activity_id>.form 파일 작성(process-gpt 폼 태그 형식, .html 아님) → 에이전트·스킬·manifest 파일까지 이번 턴에 모두 씁니다. 검증과 통합은 턴이 끝나면 시스템이 자동으로 하니 다시 확인을 묻지 말고 끝까지 진행합니다. 후보 선택이 필요하면 추천안으로 정합니다.'
// English mode: the same steps, and every name a person sees in the definition is English
const GEN_STEPS_EN = 'Follow the bpmn-process-generation-skill procedure: with the agreed flow, read the 02-generate-definition spec in references with read_file and write process-definition.json with write_file → write forms/<activity_id>.form for every user activity (process-gpt form tag format, not .html), all in this turn. Where a choice between candidates is needed, take the recommended one. '
  + 'Every name and text a person sees is in English: the process name and description, lane/role names, activity, event and gateway names, sequence-flow conditions, form titles, field labels and choices, and agent names, roles, goals and instructions (agents answer in English).'

export function generationPending(threadId) { return generating.get(threadId) }
export function generationDone(threadId) { generating.delete(threadId) }
export function generationPrompt(threadId, text) {
  const req = generating.get(threadId)
  if (/^(네|예|좋아|진행|ok|yes)/i.test(text.trim()) || /이대로 진행/.test(text) || /^(sure|go ahead|sounds good|looks good|proceed|let'?s go|do it|great|perfect)\b/i.test(text.trim()) || /\b(go ahead|proceed) (with|as)\b/i.test(text)) {
    return L(`${text}\n\n요구사항(다시 확인): ${req}\n${GEN_STEPS}`, `${text}\n\nRequirements (restated): ${req}\n${GEN_STEPS_EN}`)
  }
  return L(`${text}\n\n(프로세스 설계 중 — 요구사항: ${req})`, `${text}\n\n(designing a process — requirements: ${req})`)
}

async function processTurn(userId, threadId, args) {
  // 말로 프로세스 지도 고치기(lib/ontology/editmap.js): a card with the preview — 적용 (admin) or 의견으로 남기기
  if (args.intent === 'edit_map') {
    const [p] = await q('select email from pro_profile where user_id=$1', [userId])
    await (await import('./ontology/editmap.js')).chatEdit({ user: { id: userId, email: p?.email || '' }, threadId, query: args.query || '', process: args.process || '' })
    return
  }
  if (args.intent === 'create') {
    // stopped before the agent was called (review 11-25 #5): no draft is left pending in this chat — the draft is marked only right
    // before the agent is asked (delegate checks the stop first thing), and taken back if that check stops it
    checkpoint(turnCtx.getStore()?.turn)
    const guide = await systemGuide().catch(() => '')
    const [p] = await q('select email, name from pro_profile where user_id=$1', [userId])
    const { sessionFor } = await import('./supa.js')
    const { user, session } = await sessionFor(p.email, p.name)
    generating.set(threadId, args.query || '')
    await delegate({ user, session, threadId,
      text: isEn()
        ? `Use bpmn-process-generation-skill to design a new process definition. First propose a draft of the flow and get it confirmed.\nRequirements: ${args.query}\nWrite the draft and, later, every name in the definition (process, roles/lanes, activities, events, gateways, conditions, forms and their fields, agents and their instructions) in English.${guide ? `\n\n### External systems guide (systems registry)\n${guide}\nMake a step that connects to an external system a serviceTask and set its tool to "mcp:<tool name>".` : ''}`
        : `bpmn-process-generation-skill 을 사용해서 새 프로세스 정의를 설계해 주세요. 먼저 흐름 초안을 제안하고 확인을 받아 주세요.\n요구사항: ${args.query}${guide ? `\n\n### 외부 시스템 가이드 (systems 레지스트리)\n${guide}\n외부 시스템과 연결되는 단계는 serviceTask 로 두고 tool 을 "mcp:<도구명>" 으로 지정한다.` : ''}` })
      .catch((e) => { if (e?.turnStopped) generationDone(threadId); throw e })
    return
  }
  if (args.intent === 'catalog' || ((args.intent === 'start' || args.intent === 'view') && !args.query)) {
    await addMessage(userId, threadId, 'agent', 'catalog', { items: (await listDefinitions()).slice(0, 12) })
    return
  }
  if (args.intent === 'start' || args.intent === 'view') {
    const d = await pickDefinition(args.query || '')
    if (!d) {
      const defs = await listDefinitions()
      await addMessage(userId, threadId, 'agent', 'catalog', { items: defs.slice(0, 12) })
      return
    }
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

// ---------- panel apps (lib/panelApps) ----------
// A data app (records kept in a shared folder's spreadsheet) or, for live widgets, a generated panel.
async function makePanel({ user, threadId, description }) {
  const userId = user.id
  const status = (t) => emit(userId, 'status', { threadId, text: t })
  status(L('패널 설계하는 중', 'Designing the panel'))
  try {
    const d = await PanelApps.design(description)
    if (d.kind === 'live') {
      status(L('패널 만드는 중', 'Making the panel'))
      const p = await generatePanel({ userId, description })
      await addMessage(userId, threadId, 'agent', 'chip', { icon: 'panel', text: L(`'${p.title}' 패널이 Home에 올라갔어요`, `'${p.title}' is now on Home`), panelId: p.id })
      return
    }
    status(L('시트 만드는 중', 'Making the sheet'))
    const app = await PanelApps.createApp(user, { description, def: d.def, rows: d.rows, folderHint: description })
    const n = d.rows.length
    const where = isEn() ? whereEn(app) : app.kind === 'events' ? `모든 변경은 기록(${app.def.events.map((e) => e.label).join('·')})으로 쌓이고, ${app.def.projections.map((p) => p.label).join('·')}은(는) 기록을 다시 계산해 보여 줘요. ${app.tier === 'db' ? '데이터는 데이터베이스에 저장돼요.' : `기록은 '${app.folder.name}' 폴더의 ${app.sheetPath.split('/').pop()} '이벤트' 탭에 쌓여요.`}` : app.tier === 'db' ? `데이터는 데이터베이스에 행 단위 권한으로 저장돼요(정의는 '${app.folder.name}' 폴더의 ${app.defPath.split('/').pop()}).\n권한: ${app.rules.map((r) => `${r.label} — ${r.text}`).join(' / ')}` : `데이터는 '${app.folder.name}' 폴더의 ${app.sheetPath.split('/').pop()} 시트에 쌓여요.`
    await addMessage(userId, threadId, 'agent', 'text', { text: L(`'${app.title}' 패널을 Home에 올렸어요. ${where}\n항목: ${PanelApps.describe(app.def)}${n ? `\n말씀하신 ${n}건을 먼저 넣어 두었어요.` : ''}\n패널에서 바로 등록하거나 "시트 열기"로 스프레드시트에서 고칠 수 있고, 패널 메뉴의 "공유하기"로 팀원과 함께 쓸 수 있어요.`,
      `I put the '${app.title}' panel on Home. ${where}\nFields: ${PanelApps.describe(app.def)}${n ? `\nI added the ${n} you mentioned first.` : ''}\nYou can add records right in the panel or edit them in the spreadsheet with "Open sheet", and use them with teammates through "Share" in the panel menu.`) })
    // secure by default: the defaults in words, before anyone else is invited
    await addMessage(userId, threadId, 'agent', 'text', { text: L(`보안·개인정보 기본값\n${app.privacy.map((l) => `• ${l.text}`).join('\n')}\nHome 패널 위의 카드에서 확인하거나 "권한 규칙"에서 조정할 수 있어요.`,
      `Security & privacy defaults\n${app.privacy.map((l) => `• ${l.text}`).join('\n')}\nYou can check them on the card above the panel on Home or adjust them in "Access rules".`) })
    await addMessage(userId, threadId, 'agent', 'chip', { icon: 'panel', text: L(`'${app.title}' 패널이 Home에 올라갔어요 · ${app.folder.name} 폴더`, `'${app.title}' is now on Home · ${app.folder.name} folder`), panelAppId: app.id })
  } catch (e) {
    console.warn('[panelApps] create', e.message)
    await addMessage(userId, threadId, 'agent', 'text', { text: L(`패널을 만들지 못했어요: ${e.message}`, `I couldn't make the panel: ${e.message}`) })
  } finally { status(null) }
}
// where a new app keeps its data, in English (makePanel)
function whereEn(app) {
  if (app.kind === 'events') return `Every change is kept as a record (${app.def.events.map((e) => e.label).join(' · ')}), and ${app.def.projections.map((p) => p.label).join(' · ')} ${app.def.projections.length > 1 ? 'are' : 'is'} recalculated from the records. ${app.tier === 'db' ? 'The data is stored in the database.' : `The records go to the 'Events' tab of ${app.sheetPath.split('/').pop()} in the '${app.folder.name}' folder.`}`
  if (app.tier === 'db') return `The data is stored in the database with row-level access (the definition is ${app.defPath.split('/').pop()} in the '${app.folder.name}' folder).\nAccess: ${app.rules.map((r) => `${r.label} — ${r.text}`).join(' / ')}`
  return `The data goes to the ${app.sheetPath.split('/').pop()} sheet in the '${app.folder.name}' folder.`
}

async function panelRecord({ user, threadId, args, text }) {
  const userId = user.id
  const say = (t) => addMessage(userId, threadId, 'agent', 'text', { text: t })
  const app = (await PanelApps.listApps(user, { all: true })).find((a) => a.title === args.app) || await PanelApps.appNamed(user, `${args.app} ${text}`)
  if (!app) return say(L(`'${args.app}' 패널을 찾지 못했어요.`, `I couldn't find the '${args.app}' panel.`))
  const def = app.def
  if (app.kind === 'events') return panelEvent({ user, threadId, args, app, say })
  // each column once (a list whose title is also a subtitle would name the customer twice)
  const fmt = (r) => [...new Set([def.views.list.title, ...def.views.list.subtitle, def.views.list.value].filter(Boolean))].map((k) => [...def.fields, ...def.computed].find((f) => f.key === k)).filter(Boolean).map((f) => `${f.label} ${r[f.key] === '' ? '-' : typeof r[f.key] === 'number' ? r[f.key].toLocaleString(locale()) : r[f.key]}`).join(' · ')
  emit(userId, 'status', { threadId, text: L('시트 고치는 중', 'Updating the sheet') })
  try {
    if (args.action === 'list') {
      const { rows } = await PanelApps.rows(user, app.id)
      return say(rows.length ? L(`${app.title} — ${rows.length}건\n${rows.slice(0, 20).map((r) => `• ${fmt(r)}`).join('\n')}`, `${app.title} — ${rows.length}\n${rows.slice(0, 20).map((r) => `• ${fmt(r)}`).join('\n')}`) : L(`${app.title}에 아직 행이 없어요.`, `${app.title} has no rows yet.`))
    }
    // a number or date the model left out of its arguments ("견적 금액 2,450만 원" with the key
    // "견적 금액(숫자)" or none at all) is read from the request itself
    const fromText = () => { const given = args.values || {}; const t = valuesFromText(def, text); for (const f of def.fields) if (Object.keys(given).some((k) => k === f.key || k.replace(/\s|\*|\([^)]*\)/g, '').toLowerCase() === String(f.label).replace(/\s/g, '').toLowerCase())) delete t[f.key]; return { ...t, ...given } }
    if (args.action === 'add') {
      const r = await PanelApps.write(user, app.id, { add: fromText() })
      return say(L(`${app.title}에 넣었어요: ${fmt(r.row)} (모두 ${r.rows.length}건)`, `Added to ${app.title}: ${fmt(r.row)} (${r.rows.length} in all)`))
    }
    const { rows } = await PanelApps.rows(user, app.id)
    const m = String(args.match || '').trim()
    const hits = rows.filter((r) => m && def.fields.some((f) => String(r[f.key]).includes(m)))
    if (hits.length !== 1) return say(hits.length ? L(`'${m}'에 맞는 행이 ${hits.length}개예요. 더 구체적으로 말씀해 주세요.`, `${hits.length} rows match '${m}'. Please be more specific.`) : L(`'${m}'에 맞는 행을 찾지 못했어요.`, `I couldn't find a row matching '${m}'.`))
    const r = await PanelApps.write(user, app.id, { update: { id: hits[0]._id, v: hits[0]._v, vals: args.values || {} } })
    return say(L(`${app.title}에서 고쳤어요: ${fmt(r.row)}`, `Updated in ${app.title}: ${fmt(r.row)}`))
  } catch (e) {
    return say(e.status === 403 ? (app.tier === 'db' ? `${e.message.replace(/\.$/, '')} — ${L(`'${app.title}'의 권한 규칙`, `access rule of '${app.title}'`)}: ${(app.rules || []).find((r) => r.action === (args.action === 'add' ? 'create' : 'update'))?.text || ''}` : L(`'${app.title}'은(는) 보기 권한만 있어서 고칠 수 없어요.`, `You can only view '${app.title}', so I can't change it.`)) : L(`고치지 못했어요: ${e.message}`, `I couldn't change it: ${e.message}`))
  } finally { emit(userId, 'status', { threadId, text: null }) }
}

async function panelAppHint(user) {
  const apps = await PanelApps.listApps(user, { all: true }).catch(() => [])
  return apps.length ? `\n${L('사용자의 패널 앱(행 추가·수정은 panel_record)', "The user's panel apps (add/change rows with panel_record)")}: ${apps.map((a) => `${a.title} [${PanelApps.describe(a.def)}]`).join(' / ')}` : ''
}

// record-keeping (event) apps: every change is a new record; a cancellation points at the original
async function panelEvent({ user, threadId, args, app, say }) {
  const def = app.def
  const userId = user.id
  emit(userId, 'status', { threadId, text: L('기록 더하는 중', 'Adding the record') })
  try {
    const r = await PanelApps.rows(user, app.id)
    const nm = (id) => r.people.find((p) => p.id === id)?.name || id
    const main = def.projections.find((p) => p.key === def.views.main)
    if (args.action === 'list' || !args.event) {
      const lines = main ? r.projections[main.key].map((x) => `• ${nm(x.entity)}: ${[...main.columns, ...main.computed].map((c) => `${c.label} ${x[c.key] === null ? L('비공개', 'Private') : x[c.key]}`).join(' · ')}`) : []
      return say(L(`${app.title} — 기록 ${r.events.length}개\n${lines.join('\n') || '아직 기록이 없어요.'}`, `${app.title} — ${r.events.length} records\n${lines.join('\n') || 'No records yet.'}`))
    }
    const t = def.events.find((e) => e.label === args.event || e.type === args.event) || def.events.find((e) => String(args.event).includes(e.label) || e.label.includes(String(args.event)))
    if (!t) return say(L(`'${app.title}'에는 ${def.events.map((e) => e.label).join(', ')} 기록만 있어요.`, `'${app.title}' only has these records: ${def.events.map((e) => e.label).join(', ')}.`))
    const vals = Object.fromEntries(def.fields.filter((f) => t.fields.includes(f.key)).map((f) => [f.key, args.values?.[f.label] ?? args.values?.[f.key]]).filter(([, v]) => v !== undefined))
    let ref = null, entity = args.values?.[def.entity.label] ?? args.values?.[def.entity.key] ?? null
    if (t.ref) {
      const m = String(args.match || entity || '').trim()
      const open = r.events.filter((e) => t.ref.types.includes(e.type) && !e.closedBy && e.amend.includes(t.type))
      const hits = open.filter((e) => !m || nm(e.entity).includes(m) || def.fields.some((f) => String(e[f.key] ?? '').includes(m)))
      if (hits.length !== 1) return say(hits.length ? L(`'${m}'에 맞는 기록이 ${hits.length}개예요. 더 구체적으로 말씀해 주세요.`, `${hits.length} records match '${m}'. Please be more specific.`) : L(`'${t.label}'할 수 있는 기록을 찾지 못했어요.`, `I couldn't find a record that '${t.label}' applies to.`))
      ref = hits[0].id
    } else if (!entity && t.who.includes('subject_is_me')) entity = user.id
    const out = await PanelApps.appendEvent(user, app.id, { type: t.type, entity, ref, values: vals })
    const row = main ? out.projections[main.key].find((x) => x.entity === out.event.entity) : null
    const rowText = row ? ` — ${nm(row.entity)}: ${[...main.columns, ...main.computed].map((c) => `${c.label} ${row[c.key] === null ? L('비공개', 'Private') : row[c.key]}`).join(' · ')}` : ''
    return say(L(`${app.title}에 '${t.label}' 기록을 더했어요${rowText}. 이전 기록은 그대로 남아요.`, `Added a '${t.label}' record to ${app.title}${rowText}. Earlier records stay as they were.`))
  } catch (e) {
    return say(e.status === 403 ? `${e.message.replace(/\.$/, '')} — ${L(`'${app.title}'의 기록 권한`, `record permissions of '${app.title}'`)}: ${(app.eventRules || []).map((x) => `${x.label}: ${x.who}`).join(' / ')}` : L(`기록하지 못했어요: ${e.message}`, `I couldn't record it: ${e.message}`))
  } finally { emit(userId, 'status', { threadId, text: null }) }
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
// The main chat's turn goes through the context router, which picks the conversation it continues. When the
// router cannot be reached, or fails (5xx) before the agent's answer starts, the turn goes straight to the agent
// in the conversation the chat stands in: the chat never stops working because of the router. An agent's own
// refusal (4xx, passed on by the router) is not sent again. request(viaRouter) → a function that opens the stream.
export async function openTurn({ routed, request, stopped = () => false, waits }) {
  if (routed) {
    let res = null
    try { res = await (await request(true))() } catch (e) {
      if (stopped()) throw e
      console.warn('[delegate] context router not reachable, straight to the agent:', e.cause?.code || e.message)
    }
    if (res && res.status >= 500) {
      console.warn(`[delegate] context router ${res.status}${await refusal(res)}, straight to the agent`)
      res = null
    }
    if (res) return { res, routed: true }
  }
  return { res: await connect(await request(false), stopped, waits), routed: false }
}

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
