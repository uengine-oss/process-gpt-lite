// Turn orchestration. A quick routing call picks what the turn needs; general work is
// delegated to process-gpt's deepagents (/chat/stream) and streamed back verbatim.
import { config } from '../config.js'
import { chat } from './llm.js'
import { q } from './supa.js'
import { addMessage, history, getThread, setThreadStatus } from './store.js'
import { runBrowserTask } from './browser.js'
import { createSchedule, nextRun } from './scheduler.js'
import { createMission, createProcessSchedule, listSkills, workspaceHostPath } from './missions.js'
import { summarizeSkill, listFolder } from './skills.js'
import fs from 'node:fs/promises'
import { generatePanel } from './panels.js'
import * as PanelApps from './panelApps/service.js'
import { emit } from './bus.js'
import { listDefinitions, listInstances, myTodos, getDefinition } from './processes.js'
import { systemGuide } from './systems.js'
import { listTeam, listAssignments, resolveMember } from './team.js'
import { notifyMember } from './notify.js'
import { craftAppsFor, displayName, documentFrom, documentsOfRun, editable, officeHint, parseToolOutput, publish } from './office.js'
import { AsyncLocalStorage } from 'node:async_hooks'
import * as turns from './turns.js'
import { isOutput, keepToolDoc, roomOf, workspaceHint, workspacePaths } from './provenance.js'
import { activateCraft } from '../mcp/craft.js'
import { activateOffice } from '../mcp/office.js'
import { liveOpen, liveHint } from './craftLive.js'
import { capture, reviewTurn } from './review.js'
import { attachmentHint } from './attachments.js'
import { ensureHubBinding } from '../mcp/connectors.js'
import { folderFor, startChatWork, finishChatWork } from './folders/work.js'
import { privateSkillFor, askShareAfterUse } from './folders/skills.js'
import { assembleGenerated } from './generated.js'
import { resolveProcess, brief as improveBrief } from './improve/service.js'
import { L, isEn, locale, langInstruction, langOf, withLang } from './lang.js'

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
          intent: { type: 'string', enum: ['start', 'view', 'catalog', 'instances', 'my_todos', 'create'], description: 'catalog = list which processes exist; create = design a NEW process definition from a description' },
          query: { type: 'string', description: 'process name or keywords (start/view), or the full requirement for a new process (create)' },
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
      description: 'The request needs a real web browser: log in to a site, check an account balance, book, order, fill a web form, operate a web console. NOT for YouTube, Google (Gmail/Calendar/Drive), Slack, GitHub or Notion lookups — connector tools handle those, so answer without tools.',
      parameters: { type: 'object', properties: { goal: { type: 'string' }, start_url: { type: 'string' }, ack: { type: 'string', description: '해요체 한두 문장으로 무엇을 할지 알림' } }, required: ['goal', 'ack'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'schedule_task',
      description: 'User wants something done repeatedly or at a time (매일, 매주, 30분마다, 장중에, 내일 아침…).',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '짧은 작업 이름' },
          cron: { type: 'string', description: '5-field cron in Asia/Seoul local time' },
          prompt: { type: 'string', description: 'Self-contained instruction executed at each run' },
          skill: { type: 'string', description: 'If one of the available skills (listed in the system message) does this job, its exact name. The run then executes that skill as a mission. A skill is one person\'s job done by one agent: results go only to the person who set it up.' },
          process: { type: 'string', description: 'If one of the processes (listed in the system message) is the job to run on this schedule, its exact id. Each run then starts a new instance of that process. Use a process (not a skill) when the work passes between people or roles (검토·승인·결정을 다른 사람/역할이 함), branches on a decision, or chains several agents/skills — each step then goes to whoever holds its role.' },
          params: { type: 'object', description: 'Inputs taken from the request. For a skill, what the skill needs, e.g. {"channel":"@경제사냥꾼","sectors":["코스피","반도체"]}. For a process, its first-step fields (listed with the process), e.g. {"sources":"Facebook","topics":"AI 업무 자동화"}' },
          ack: { type: 'string', description: '해요체 확인 문장 한두 개. 첫 실행 시각은 말하지 말 것(시스템이 따로 표시)' },
        },
        required: ['name', 'cron', 'prompt', 'ack'],
      },
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

async function handleTurn({ user, session, threadId, text, context, onDelta, files, conversation }) {
  const userId = user.id
  if (conversation?.id) pinned.set(threadId, { conversationId: String(conversation.id), title: String(conversation.title || '') })
  files = (files || []).filter((f) => f?.path && f?.url).slice(0, 10)
  if (!text?.trim() && files.length) text = L('첨부한 파일을 확인해 줘', 'Please look at the attached files')
  const said = await addMessage(userId, threadId, 'user', 'text', { text, ...(files.length ? { files } : {}) })
  const store = turnCtx.getStore()
  if (store) store.userMsgId = said.id
  for (const f of files) await addMessage(userId, threadId, 'user', 'file', { name: f.name, url: f.url, path: f.path, attached: true })
  if (files.length) {
    attached.set(threadId, files)
    // the router only needs to know there are files; a question about them is the agent's job
    context = [context, L(`(첨부: ${files.map((f) => f.name).join(', ')})`, `(attached: ${files.map((f) => f.name).join(', ')})`)].filter(Boolean).join('\n\n')
  }
  const hist = toLlmHistory(await history(threadId, 12))
  if (context) hist[hist.length - 1] = { role: 'user', content: `${text}\n\n${context}` }
  const now = new Date().toLocaleString(locale(), { timeZone: 'Asia/Seoul' })

  // Skill authoring belongs to deepagents' own skill-creator (its root prompt routes '스킬 만들어줘'
  // there); pass such requests through untouched instead of classifying them here.
  if (/(스킬|skill)\s*(을|를)?\s*(새로\s*)?(만들|생성|작성)/i.test(text) || SKILL_REQUEST_EN.test(text)) {
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
  const sharedFolder = !namedApp && !generationPending(threadId) && !files.length ? await folderFor(user, text).catch(() => null) : null
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
  if ((craftAppsFor(text).length || liveOpen(userId)) && !/매일|매주|매달|마다|정기|반복|every|daily|weekly|monthly/i.test(text)) {
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
  // (a process that names documents among its steps — "…제안서를 만들어" — is still the router's create)
  if (!namedApp && (DOC_REQUEST.test(text) || DOC_REQUEST_EN.test(text)) && !/패널|위젯|앱|프로세스|\b(panel|widget|app|process)\b/i.test(text) && !RECURRING.test(text)) {
    return delegate({ user, session, threadId, text: context ? `${text}\n\n${context}` : text, onDelta })
  }
  const skillList = await listSkills(session.access_token)
  const skillHint = skillList.length ? `\n${L('사용 가능한 스킬(주기 작업에 쓸 수 있음)', 'Available skills (usable for recurring tasks)')}: ${skillList.map((k) => `${k.name} — ${k.description.slice(0, 80)}`).join(' / ')}` : ''
  const processHint = await processCatalogHint()
  const teamHint = await teamCatalogHint(userId)
  const appHint = await panelAppHint(user)
  const route = await chat({
    model: config.llm.fastModel,
    temperature: 0,
    // with no apps to name, a small router model still reaches for panel_record ("'문서 작성' 패널을 찾지 못했어요")
    tools: routerTools(appHint ? ROUTER_TOOLS : ROUTER_TOOLS.filter((t) => t.function.name !== 'panel_record')),
    messages: [
      { role: 'system', content: isEn()
        ? PERSONA_EN.replace('{now}', now) + skillHint + processHint + teamHint + appHint + '\nCall a tool only when a specific tool is needed; for any other question, document writing, analysis or work, answer with the single word "DELEGATE" and no tool.'
        : PERSONA.replace('{now}', now) + skillHint + processHint + teamHint + appHint + '\n특정 도구가 필요할 때만 도구를 호출하고, 그 외 질문·문서작성·분석·업무 처리는 도구 없이 "DELEGATE" 한 단어만 답해.' },
      ...hist.slice(-8),
    ],
  })
  const call = route.tool_calls?.[0]
  // a panel only when the words ask for one; the router otherwise turns "안내문 … 만들어줘" follow-ups into apps
  const strayPanel = call?.function.name === 'create_panel' && !PANEL_WORDS.test(text) && !PANEL_WORDS_EN.test(text)
  if (!call || strayPanel) return delegate({ user, session, threadId, text: context ? `${text}\n\n${context}` : text, onDelta })

  const args = JSON.parse(call.function.arguments || '{}')
  // only designing a new process goes on to the agent; the other tools answer here
  if (!(call.function.name === 'process' && args.intent === 'create')) noAgentTurn()
  const ack = await addMessage(userId, threadId, 'agent', 'text', { text: args.ack })
  onDelta?.(args.ack)

  switch (call.function.name) {
    case 'browser_task':
      runBrowserTask({ userId, threadId, goal: args.goal, startUrl: args.start_url })
        .then((r) => r.summary && addMessage(userId, threadId, 'agent', 'text', { text: r.summary }))
        .catch((e) => { console.warn('[browser]', e.message); addMessage(userId, threadId, 'agent', 'text', { text: L('브라우저 작업을 시작하지 못했어요. 잠시 후 다시 시도해 주세요.', "I couldn't start the browser task. Please try again in a moment.") }) })
      break
    case 'schedule_task': {
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
        ? await createProcessSchedule({ userId, name: args.name, cron: args.cron, processId: proc.id, params: { ...(args.params || {}), request: text }, threadId })
        : useSkill
        // keep the user's own words with the inputs so the skill can recover anything the router missed
        ? await createMission({ userId, name: args.name, cron: args.cron, skill: args.skill, params: { ...(args.params || {}), request: text } })
        : await createSchedule({ userId, name: args.name, cron: args.cron, prompt: args.prompt, threadId })
      const next = nextRun(s.cron)
      const when = next ? next.toLocaleString(locale(), { timeZone: 'Asia/Seoul', month: 'long', day: 'numeric', weekday: 'short', hour: 'numeric', minute: '2-digit' }) : ''
      await addMessage(userId, threadId, 'agent', 'chip', { icon: 'clock', text: L(`예약됨 · ${s.name}${useSkill ? ` · 스킬 ${args.skill}` : proc ? ` · 프로세스 ${proc.name}` : ''}${when ? ` · 다음 실행 ${when}` : ''}`,
        `Scheduled · ${s.name}${useSkill ? ` · skill ${args.skill}` : proc ? ` · process ${proc.name}` : ''}${when ? ` · next run ${when}` : ''}`), cron: s.cron, scheduleId: s.id })
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
    case 'add_action': {
      const [a] = await q(`insert into pro_actions(user_id,verb,text,due,prompt) values ($1,$2,$3,$4,$5) returning *`,
        [userId, args.verb, args.text, args.due || null, args.text])
      emit(userId, 'action', a)
      break
    }
  }
  return ack
}

// One run of the agent on a fresh variation of a shared folder, in its own conversation.
async function folderTurn({ user, session, threadId, text, onDelta, folder }) {
  const work = await startChatWork({ user, folder, text, threadId })
  pinned.set(threadId, { conversationId: work.room, title: folder.kind === 'skill' ? L(`${folder.name} 스킬 고치기`, `Fix the ${folder.name} skill`) : L(`${folder.name} 폴더 작업`, `${folder.name} folder work`) })
  const msg = await delegate({ user, session, threadId, text: work.message, onDelta })
  await finishChatWork({ user, folder, v: work.v, threadId }).catch((e) => console.warn('[folders] chat work', e.message))
  return msg
}

// Delegate to process-gpt deepagents and stream its answer.
// Steer the agent to connector tools when the request is plainly about one of those services;
// smaller models otherwise tend to reach for generic web fetching among dozens of tools.
const CONNECTOR_HINTS = [
  [/유튜브|youtube|채널|영상/i, 'youtube_channel_videos, youtube_video_info, youtube_transcript'],
  [/캘린더|일정|gmail|메일함|구글 ?드라이브|drive|\bcalendar\b|\binbox\b/i, 'calendar_find_events, calendar_create_event, gmail_search, gmail_read, drive_search'],
  [/slack|슬랙/i, 'slack_list_channels, slack_read_channel, slack_post_message'],
  [/github|깃허브|\bPR\b/i, 'github_list_prs, github_search_issues, github_create_issue'],
  [/notion|노션/i, 'notion_search, notion_read_page, notion_create_page'],
]
// Anything that sounds recurring is the router's call (schedule_task), never a one-off delegate.
// the last line a scheduled skill run prints (lib/missions.js parseResult)
const MISSION_LINE = '맨 마지막 줄에 MISSION_RESULT: {"changed": true|false, "summary": "결과 한 문장"} 를 한 줄로 출력'
const MISSION_LINE_EN = 'print on the very last line, as one line: MISSION_RESULT: {"changed": true|false, "summary": "one sentence with the result"}'
const RECURRING = /매일|매주|매달|매시|마다|주기|정기|반복|한\s*번씩|한번씩|\d+\s*(초|분|시간|일)\s*(에|간격|마다)|every|hourly|daily|weekly|monthly|on a schedule|recurring/i
// A document or file to write: a kind of document (or a file format) followed closely by a verb of making.
const DOC_REQUEST = /(docx|hwpx|pptx|xlsx|워드|한글\s*(파일|문서)|파워포인트|문서|보고서|안내문|제안서|기획서|공문|견적서|회의록)[^.?!\n]{0,20}(작성|만들|써\s*줘|뽑아)/i
// the same in English ("write a proposal", "make me a Word document", "draft the quote as xlsx")
const DOC_REQUEST_EN = /\b(write|make|create|draft|prepare|put together|generate|produce)\b[^.?!\n]{0,40}\b(docx|hwpx|pptx|xlsx|word|powerpoint|excel|document|doc|report|notice|announcement|proposal|plan|letter|quote|quotation|estimate|minutes|memo|slides?|deck|spreadsheet|brochure|flyer)\b/i
// English requests the Korean shortcuts above recognise in Korean
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
let catalogCache = { at: 0, text: '', lang: 'ko' }
async function processCatalogHint() {
  if (Date.now() - catalogCache.at < 60000 && catalogCache.lang === (isEn() ? 'en' : 'ko')) return catalogCache.text
  const defs = (await listDefinitions()).slice(0, 12)
  const lines = []
  for (const d of defs) {
    const def = await getDefinition(d.id).catch(() => null)
    const keys = (def?.startForm?.fields || []).map((f) => f.key).join(', ')
    lines.push(`${d.id} — ${d.name}${keys ? L(` (첫 단계 입력: ${keys})`, ` (first-step inputs: ${keys})`) : ''}`)
  }
  catalogCache = { at: Date.now(), lang: isEn() ? 'en' : 'ko', text: lines.length ? `\n${L('주기적으로 시작할 수 있는 프로세스', 'Processes that can be started on a schedule')}: ${lines.join(' / ')}` : '' }
  return catalogCache.text
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
function connectorHint(text) {
  const tools = CONNECTOR_HINTS.filter(([re]) => re.test(text)).map(([, t]) => t)
  return tools.length ? L(`\n\n(연결된 커넥터 도구를 웹 조회보다 먼저 쓰세요: ${tools.join(', ')})`, `\n\n(Use the connected connector tools before searching the web: ${tools.join(', ')})`) : ''
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

export async function delegate({ user, session, threadId, text, onDelta, silent, mode, divider, quietIfUnchanged, hwpxTemplateUrl }) {
  let thread = await getThread(user.id, threadId)
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
      const ahead = await turns.aheadInThread(turn)
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
  // the main chat now stands in that conversation, so an unsure next message stays there too
  if (pin) await q('update pro_threads set conversation_id=$2 where id=$1', [threadId, pin.conversationId])
  if (preRouted) await q('update pro_threads set conversation_id=$2 where id=$1', [threadId, routing.conversation_id])
  await setThreadStatus(user.id, threadId, 'working')
  // tools that need no account (CADCraft) are bound once per user per server start
  if (!hubBound.has(user.id)) { hubBound.add(user.id); await ensureHubBinding(user.id, config.tenantId).catch(() => {}) }
  // the ArtCraft apps this message asks for list their tools to the agent (mcp/craft.js)
  const live = !silent && !divider ? liveOpen(user.id) : null
  activateCraft(user.id, [...craftAppsFor(text), ...(live ? [live.app] : [])])
  if (live?.app === 'ieumoffice') activateOffice(user.id)
  // a stalled agent (no byte for STREAM_IDLE_MS) is cut off, so the chat never sits on "생각하는 중" for good
  const idle = new AbortController()
  let idleTimer = setTimeout(() => idle.abort(), STREAM_IDLE_MS)
  const alive = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => idle.abort(), STREAM_IDLE_MS) }
  // 검수 (lib/review.js): what is open now, as it is before the agent's edits
  const before = live ? await capture({ userId: user.id, jwt: session.access_token, open: live }) : null
  const usedTools = new Set()
  let partial = ''
  try {
    const msg = await streamTurn()
    // an edit tool of the open app or document ran: check the result against the request
    const prefix = live?.app === 'ieumoffice' ? /^office_live_(write|replace|apply_ops|hwp_)/ : new RegExp(`^${live?.app}_`)
    if (before && !turn.stopped && [...usedTools].some((t) => prefix.test(t) && !/(inspect|read|list|render|preview|find|query|guide|documents)/.test(t))) {
      await reviewTurn({ user, session, threadId, request: text.split('\n\n(')[0], open: live, before })
    }
    return msg
  } catch (e) {
    if (!idle.signal.aborted && !turn.abort.signal.aborted && !/fetch failed|ECONNREFUSED|deepagents \d/.test(e.message)) throw e
    console.warn('[delegate]', turn.abort.signal.aborted ? 'stopped by the user' : idle.signal.aborted ? 'agent stream idle, aborted' : e.message)
    await setThreadStatus(user.id, threadId, null)
    if (turn.abort.signal.aborted) return addMessage(user.id, threadId, 'agent', 'text', { text: [partial.trim(), `(${stoppedText()})`].filter(Boolean).join('\n\n'), stopped: true, silent })
    return addMessage(user.id, threadId, 'agent', 'text', { text: idle.signal.aborted
      ? L('에이전트가 한동안 응답하지 않아 기다리기를 멈췄어요. 같은 요청을 다시 보내 주세요.', "The agent didn't respond for a while, so I stopped waiting. Please send the same request again.")
      : L('에이전트에 연결하지 못했어요. 잠시 후 다시 보내 주세요.', "I couldn't reach the agent. Please send it again in a moment.") })
  } finally { clearTimeout(idleTimer) }

  async function streamTurn() {
  const res = await fetch(`${routed ? config.contextRouterUrl : config.deepagentsUrl}/chat/stream`, {
    signal: AbortSignal.any([idle.signal, turn.abort.signal]),
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}`, 'X-Tenant-Id': config.tenantId },
    body: JSON.stringify({
      // English mode: the language instruction goes last, after what the person said and the hints
      message: text + connectorHint(text) + officeHint(text, hwpxTemplateUrl || config.hwpxTemplateUrl) + liveHint(live) + attachmentHint(uploads) + workspaceHint(user, turn.conv) + langInstruction(), message_uuid: crypto.randomUUID(), tenant_id: config.tenantId,
      // process-gpt's chat contract for uploads (same shape its frontend sends)
      files: uploads.map((f) => ({ fileName: f.name, fileUrl: f.url, filePath: f.path, fileType: f.type, fileSize: f.size })),
      user_uid: user.id, user_email: user.email, user_name: user.name, user_jwt: session.access_token,
      conversation_id: turn.conv || pin?.conversationId || thread?.conversation_id || null, stream: true,
      metadata: { client: 'pgpt-pro', style: isEn() ? 'English, concise, first person. Use a markdown "# Title" first line only for long structured documents.' : 'Korean 해요체, concise. Use a markdown "# 제목" first line only for long structured documents.',
        ...(isEn() ? { language: 'en' } : {}),
        ...(routed ? { auto_route: true, route_text: text, agent: 'deepagents' } : {}) },
    }),
  })
  if (!res.ok) throw new Error(`deepagents ${res.status}`)
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
  // provenance (lib/provenance.js): what this turn wrote, every workspace path it touched, and the
  // documents tool results carried, kept apart until the end
  const written = new Set()
  const seen = new Set()
  const toolDocs = []
  const inputs = new Map() // tool -> arguments of its last call
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
        if (!thread?.conversation_id) await q('update pro_threads set conversation_id=$2 where id=$1', [threadId, j.conversation_id])
      }
      if (j.type === 'token' && j.content) { out += j.content; partial = out; if (mode !== 'skill') onDelta?.(j.content) }
      const genDir = j.type === 'file_artifact' && /\/\.bpmn\/[^/]+\/process-[^/]+\//.exec(j.path || '')
      // skill-creator writes <conversation base>/skills/<name>/SKILL.md (+ scripts/, references/)
      const skillDir = j.type === 'file_artifact' && /^(.*\/skills\/([^/]+))\/SKILL\.md$/.exec(j.path || '')
      if (skillDir) skillDraft = { dir: skillDir[1], name: skillDir[2] }
      const room = j.type === 'file_artifact' && /^\/workspace\/\.bpmn\/[^/]+\//.exec(j.path || '')
      if (room) runDirs.add(room[0])
      if (j.type === 'file_artifact' && j.path) { written.add(j.path); seen.add(j.path) }
      if (genDir) workDir = genDir[0]
      else if (j.type === 'file_artifact' && /\/skills\/[^/]+\//.test(j.path || '')) { /* part of a skill draft */ }
      else if (j.type === 'file_artifact' && j.name && !/\.(form|json|md)$/.test(j.name)) files.push({ name: j.name, path: j.path, ext: j.ext })
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
        usedTools.add(tool)
        inputs.set(tool, j.input ?? null)
        for (const p of workspacePaths(j.input)) seen.add(p)
        steps += 1
        emit(user.id, 'status', { threadId, text: mode === 'skill' ? skillStatus(tool, steps) : toolPhase(tool) })
      }
      if (j.type === 'error') {
        const why = String(j.message || j.error || '')
        // the SDK ended the turn: our own 멈추기, or another request on this conversation
        if (/turn cancelled/i.test(why)) cancelled = true
        else out += L(`\n\n(오류: ${why})`, `\n\n(error: ${why})`)
      }
    }
  }
  await setThreadStatus(user.id, threadId, null)
  let body = out.trim()
  const ended = cancelled || turn.stopped
  if (skillDraft && !ended) {
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
  if (quietIfUnchanged && !ended && /^(변동\s*없음|no changes?)[.!]?$/i.test(body.replace(/[*_`"]/g, '').trim())) return null
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
    if (files.some((f) => f.url === t.doc.url)) continue
    // a republished copy keeps the name of the file it came from
    files.push(src ? { ...t.doc, name: src.split('/').pop(), path: src } : t.doc)
  }
  if (!body && !files.length && !processResult) body = emptyText()
  const msg = await addMessage(user.id, threadId, 'agent', kind, { text: body, silent, ...(context ? { context } : {}), ...(ended ? { stopped: true, ...(turn.stopped ? {} : { superseded: true }) } : {}) })
  if (preRouted) touchContext(user, routing, text, body)
  // documents made by the agent's own scripts (no file_artifact event) are found and added too
  for (const f of files) if (f.url && !f.path) f.name = displayName(f, body)
  for (const p of await documentsOfRun({ text: body, dirs: rooms, since: started - 2000 }).catch(() => [])) {
    // office-mcp already published this one (store_and_render): one card per document
    const name = p.split('/').pop()
    if (files.some((f) => f.path === p || (f.url && f.name === name))) continue
    if (!(await isOutput(p, ctx))) { console.log(`[delegate] not attached (not this turn's output): ${p}`); continue }
    files.push({ name, path: p })
  }
  // the script that built a document is scaffolding; the document is what the user asked for (and
  // a turn that was stopped leaves no half-run scripts behind as results)
  if (ended || files.some((f) => editable(f.name))) files.splice(0, files.length, ...files.filter((f) => !/\.(py|js|mjs|ts|sh)$/.test(f.name)))
  for (const f of files) {
    // a document the agent wrote in its sandbox is published so the editor can load it
    if (!f.url && f.path && editable(f.name)) Object.assign(f, await publish(user.id, f.path).catch((e) => { console.warn('[office publish]', e.message); return {} }))
    await addMessage(user.id, threadId, 'agent', 'file', f)
  }
  // with the bridge, a draft needs this turn's generation folder: a contract streamed without one is
  // something the agent only quoted (the skill's leave-request example) while still asking a question
  if (processResult && !ended && config.bridgeUrl && !workDir) console.warn('[process] process_result without a generation folder this turn: no draft card')
  else if (processResult && !ended) {
    generationDone(threadId)
    const contract = await assembleGenerated(processResult, workDir).catch((e) => { console.warn('[process] assemble', e.message); return processResult })
    await addMessage(user.id, threadId, 'agent', 'process_draft', { contract, workDir, state: 'draft' })
  }
  return msg
  }
  }
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
    for (const t of list.slice(0, 3)) await addMessage(userId, threadId, 'agent', 'todo', { todoId: t.id, name: t.activity_name, inst: t.proc_inst_name })
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
    if (args.action === 'add') {
      const r = await PanelApps.write(user, app.id, { add: args.values || {} })
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
