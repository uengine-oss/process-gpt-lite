// What a chat turn is doing, while it does it (design turnplan §3, P0). A turn used to show only 「생각하는 중」 or
// 「실행하는 중」 for minutes (2026-11-25 사용자: 「입력을 주면 일단 의도파악과 어떤식으로 일을 할지 퀵하게 먼저 알려주는 단계가
// 필요해보이는데」 · 「3분이 지났는데.. 화면이 이꼴임」).
//   - frontPlan(): one model call started the moment the message is saved — what was understood and 2–4 steps, as JSON. It runs
//     beside the existing path (the router still decides the handler); its tier is only logged in P0.
//   - turn.* events on the user's bus (/api/events · long poll): the plan, the stage, the agent's to-dos, every trail entry, the
//     interim texts, the end. They are turn state, not chat messages (an agent message clears the streaming draft). The plan and
//     the notes are saved onto the answer at the end (saved()).
//   - GET /api/threads/:id/turn: the same state from memory, for a page opened (or reloaded) mid-turn.
import express from 'express'
import { config } from '../config.js'
import { chat } from './llm.js'
import { emit } from './bus.js'
import { L, isEn } from './lang.js'
import { history, getThread } from './store.js'
import { q } from './supa.js'

// the front call's limit, and when the fast model is asked too (the front model errored or has not answered yet)
export const FRONT_MS = Number(process.env.PRO_FRONT_PLAN_MS) || 4000
export const HEDGE_MS = Number(process.env.PRO_FRONT_HEDGE_MS) || 2500
// Interim text (§3.4): a text run is shown as the answer only once it is longer than this with no tool event after it. A display
// threshold — how much text the person waits for before it is shown as an answer — not a reading of what the text means.
export const PROMOTE_CHARS = 200
const KEEP_STEPS = 30
const KEEP_NOTES = 10
const NOTE_CHARS = 300
const TIERS = ['light', 'standard', 'deep']
const CERTAINTY = ['sure', 'likely', 'unsure']

export const fallbackText = () => L('요청을 받았어요. 바로 살펴볼게요.', "Got your request. I'll look into it right away.")

// ---------- recent task cards (design turnplan §8.1 L7) ----------
// The router read only text messages: 「이제 아까 만들기로 한 노트북 만들자」 reached it with the NotebookLM task card (and its Medium
// link) invisible, so it delegated. The router and the front call now get each recent browser or local task card as one line.
const TASK_STATE = { running: 'running', offered: 'running', planning: 'running', queued: 'waiting', needs_input: 'waiting', pending: 'waiting',
  done: 'done', needs_review: 'stopped', failed: 'stopped', stopped: 'stopped', delegated: 'stopped', cancelled: 'cancelled', canceled: 'cancelled' }
const firstLink = (t) => /https?:\/\/[^\s)'"<>\]]+/i.exec(String(t || ''))?.[0] || ''
const oneLine = (t, n) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, n)
// a task card (kind 'task' — lib/browser.js, 'local_run' — lib/localAgents) → "browser task · waiting · <title> · <link> · skill <name>"
export function taskLine(row) {
  const c = row?.content || {}
  const local = row?.kind === 'local_run'
  const state = TASK_STATE[c.state] || oneLine(c.state, 20) || 'stopped'
  const title = oneLine(local ? c.activity || c.text : c.title || c.goal, 70)
  const link = local ? '' : oneLine(c.url || firstLink(c.goal), 70)
  const skill = oneLine(local ? c.label || c.agent : c.skill, 30)
  return [local ? 'local agent task' : 'browser task', state, title, link, skill ? `skill ${skill}` : ''].filter(Boolean).join(' · ').slice(0, 160)
}
// the thread's last five task cards, oldest first, as lines
export async function taskCards(threadId, limit = 5) {
  const rows = await q(`select kind, content from pro_messages where thread_id=$1 and kind in ('task','local_run') order by created_at desc limit $2`, [threadId, limit]).catch(() => [])
  return rows.reverse().map(taskLine).filter(Boolean)
}
// the block a prompt gets ('' when there are none)
export const taskBlock = (lines = []) => (lines.length ? `${L('이 대화의 최근 작업 카드(오래된 것부터)', 'Recent task cards in this chat (oldest first)')}:\n${lines.map((l) => `- ${l}`).join('\n')}` : '')

// ---------- the front call ----------

// what the person's message is shown with: up to four earlier messages and the message itself
export function frontMessages({ text, files = [], hist = [], tasks = [] }) {
  const lang = isEn()
    ? 'Write "understood" and "steps" in English.'
    : 'Write "understood" and "steps" in the language of the person\'s message. When the message has no words of its own (only a link, a file or an attachment), write them in Korean, in polite 해요체.'
  const system = [
    "You read a person's message to their work assistant and say, before any work starts, what you understood and how the work will go.",
    'Answer with JSON only: {"understood": "<one sentence>", "steps": ["<step>", "..."], "tier": "light|standard|deep", "certainty": "sure|likely|unsure"}',
    '- understood: one sentence in the assistant\'s own voice restating what the person wants done (for example, that they want the linked article summarised). Not a request to the person, not a greeting, not a promise of results.',
    '- steps: 2 to 4 short steps (each under 40 characters), in the order the work will go. Plan only what was asked: never add a deliverable the person did not ask for. A message that is only a link means: read that page and summarise it.',
    '- tier: light = a short answer from what is known or one lookup, a summary of one page; standard = most work (research over several sources, one document, a mail draft, work in a connected service); deep = several deliverables that must agree, analysis across many sources, editing the person\'s existing documents, or anything the person says must be thorough.',
    '- certainty: how sure you are of what the person wants.',
    `- Language: ${lang}`,
    '- The earlier messages are background; the message now decides.',
  ].join('\n')
  const earlier = hist.slice(-4).map((m) => `${m.role === 'user' ? 'Person' : 'Assistant'}: ${String(m.text || '').replace(/\s+/g, ' ').slice(0, 300)}`)
  const names = files.map((f) => f?.name).filter(Boolean).slice(0, 10)
  const user = [earlier.length ? `Earlier messages:\n${earlier.join('\n')}\n` : '', tasks.length ? `Recent task cards in this chat (oldest first):\n${tasks.map((l) => `- ${l}`).join('\n')}\n` : '',
    `The message now:\n${String(text || '').slice(0, 2000)}`,
    names.length ? `(attached: ${names.join(', ')})` : ''].filter(Boolean).join('\n')
  return [{ role: 'system', content: system }, { role: 'user', content: user }]
}

// the model's answer → {understood, steps:[{id,text}], tier, certainty}, or null when it is not a plan (format check only)
export function readPlan(content) {
  let j = content
  if (typeof j === 'string') { try { j = JSON.parse(j) } catch { return null } }
  if (!j || typeof j !== 'object') return null
  const understood = String(j.understood || '').replace(/\s+/g, ' ').trim().slice(0, 240)
  if (!understood) return null
  const steps = (Array.isArray(j.steps) ? j.steps : [])
    .map((s) => String(s && typeof s === 'object' ? s.text || s.step || '' : s ?? '').replace(/\s+/g, ' ').trim().slice(0, 120))
    .filter(Boolean).slice(0, 4)
  return {
    understood,
    steps: steps.map((t, i) => ({ id: `p${i + 1}`, text: t })),
    tier: TIERS.includes(j.tier) ? j.tier : 'standard',
    certainty: CERTAINTY.includes(j.certainty) ? j.certainty : 'likely',
  }
}

// The front call: the front model first; if it errors, or has not answered by hedgeMs, the same call on the fast model — the first
// plan to come back within limitMs wins (the other is aborted). → {understood, steps, tier, certainty, model, ms, hedge} or null.
// (with no front model of its own — the default — a slow call is not asked twice; an error is retried once)
export function frontPlan({ text, files = [], hist = [], tasks = [], signal, front = config.llm.frontModel, fast = config.llm.fastModel,
  limitMs = FRONT_MS, hedgeMs = HEDGE_MS, call = chat } = {}) {
  const t0 = Date.now()
  const messages = frontMessages({ text, files, hist, tasks })
  const deadline = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(limitMs)])
  return new Promise((resolve) => {
    const runs = []
    let done = false, hedged = null, pending = 0, timer = null
    const finish = (v) => {
      if (done) return
      done = true
      clearTimeout(timer)
      for (const ac of runs) ac.abort()
      resolve(v)
    }
    const launch = (model) => {
      const ac = new AbortController()
      runs.push(ac)
      pending++
      Promise.resolve().then(() => call({ model, messages, temperature: 0, json: true, think: false, maxTokens: 400, timeoutMs: limitMs, signal: AbortSignal.any([deadline, ac.signal]) }))
        .then((m) => {
          const plan = readPlan(m?.content)
          if (!plan) throw new Error('the answer is not a plan')
          finish({ ...plan, model, ms: Date.now() - t0, hedge: hedged })
        })
        .catch((e) => {
          pending--
          if (done) return
          if (!deadline.aborted) console.warn(`[turn-plan] ${model} ${String(e.message || e).slice(0, 120)}`)
          if (!hedged) hedge('error')
          else if (!pending) finish(null)
        })
    }
    const hedge = (why) => {
      if (hedged || done) return
      hedged = why
      if (fast && (fast !== front || why === 'error')) launch(fast)
      else if (!pending) finish(null)
    }
    if (deadline.aborted) return finish(null)
    deadline.addEventListener('abort', () => finish(null), { once: true })
    timer = setTimeout(() => hedge('slow'), hedgeMs)
    launch(front)
  })
}

// ---------- the live state of a turn ----------

const views = new Map() // turn id → view

const base = (v) => ({ threadId: v.threadId, turnId: v.turnId, conversationId: convOf(v), at: Date.now() })
const convOf = (v) => (v.turn?.conv && !String(v.turn.conv).startsWith('none:') ? v.turn.conv : null)
function send(v, type, data) {
  v.lastAt = Date.now()
  emit(v.userId, type, { ...base(v), ...data })
}
export const viewOf = (turn) => (turn ? views.get(turn.id) || null : null)

// stage texts (the pill and the panel's 지금)
const STAGE = {
  reading: () => L('요청을 읽는 중', 'Reading your request'),
  routing: () => L('어떻게 할지 정하는 중', 'Deciding how to do it'),
  queued: () => L('앞 요청이 끝나길 기다리는 중', 'Waiting for the request ahead'),
  preparing: () => L('에이전트가 준비하는 중', 'The agent is getting ready'),
  working: () => L('작업하는 중', 'Working'),
  writing: () => L('답을 쓰는 중', 'Writing the answer'),
  done: () => L('끝났어요', 'Done'),
  stopped: () => L('멈췄어요', 'Stopped'),
  failed: () => L('처리하지 못했어요', "Couldn't finish"),
}
export const nextStepText = () => L('다음 단계를 쓰는 중', 'Writing the next step')

// The message is saved: the turn's view opens (turn.start) and the front call starts beside the existing path.
// files: what the message carries (names only reach the model)
export function begin({ turn, userId, threadId, msgId, text, files = [], plan = config.llm.frontPlan }) {
  if (!turn) return null
  const v = {
    turn, turnId: turn.id, userId, threadId, msgId, startedAt: Date.now(), lastAt: Date.now(), plan: null, planState: 'reading',
    handler: null, stage: null, stages: [], todos: [], steps: [], notes: [], open: null, seq: 0, ended: null, abort: new AbortController(),
  }
  views.set(turn.id, v)
  send(v, 'turn.start', { msgId, startedAt: v.startedAt })
  stage(turn, 'reading')
  v.ready = plan ? runFront(v, text, files) : Promise.resolve(null)
  if (!plan) v.planState = 'off'
  return v
}

async function runFront(v, text, files) {
  const [rows, tasks] = await Promise.all([history(v.threadId, 6).catch(() => []), taskCards(v.threadId)])
  // (the message itself is the last row: it is given as the message now)
  const hist = rows.filter((r) => ['text', 'doc'].includes(r.kind) && r.content?.text).map((r) => ({ role: r.role, text: r.content.text }))
  if (hist.length && hist[hist.length - 1].role === 'user') hist.pop()
  const signal = AbortSignal.any([v.abort.signal, v.turn.abort.signal])
  const p = await frontPlan({ text, files, hist, tasks, signal }).catch(() => null)
  if (v.ended) return null
  if (p) {
    console.log(`[turn-plan] model=${p.model} ms=${p.ms}${p.hedge ? ` hedge=${p.hedge}` : ''} tier=${p.tier} certainty=${p.certainty} steps=${p.steps.length} thread=${String(v.threadId).slice(0, 8)}`)
    v.plan = { understood: p.understood, steps: p.steps, tier: p.tier, certainty: p.certainty, model: p.model, ms: p.ms, source: 'front' }
  } else {
    if (v.turn.stopped) return null
    console.log(`[turn-plan] fallback after ${Date.now() - v.startedAt} ms thread=${String(v.threadId).slice(0, 8)}`)
    v.plan = { understood: fallbackText(), steps: [], tier: 'standard', certainty: 'unsure', source: 'fallback', ms: Date.now() - v.startedAt }
  }
  v.planState = 'planned'
  sendPlan(v)
  if (v.handler) logReadings(v)
  return v.plan
}
function sendPlan(v) {
  if (!v.plan) return
  send(v, 'turn.plan', { understood: v.plan.understood, steps: v.plan.steps, handler: v.handler, tier: v.plan.tier, certainty: v.plan.certainty,
    alternatives: [], source: v.plan.source })
}
// the plan and the router can read a message differently (the plan says summarise, the router starts a browser task):
// the handler line always comes from the router, and both readings are logged
function logReadings(v) {
  console.log(`[turn-plan] handler=${v.handler.kind}${v.handler.skill ? `:${v.handler.skill}` : ''} plan(${v.plan?.source || '-'})="${String(v.plan?.understood || '').slice(0, 80)}" thread=${String(v.threadId).slice(0, 8)}`)
}

// what the existing path decided: {kind: 'agent'|'browser'|'action'|'process', skill?, label}
export function handler(turn, h) {
  const v = viewOf(turn)
  if (!v || v.ended || v.handler?.kind === h.kind) return
  v.handler = { kind: h.kind, ...(h.skill ? { skill: h.skill } : {}), label: h.label || '' }
  if (v.plan) { sendPlan(v); logReadings(v) }
}

export function stage(turn, name, { text, detail } = {}) {
  const v = viewOf(turn)
  if (!v || (v.ended && !['done', 'stopped', 'failed'].includes(name))) return
  const t = text || STAGE[name]?.() || ''
  if (v.stage?.stage === name && v.stage.text === t && (v.stage.detail || null) === (detail || null)) return
  if (v.stage?.stage !== name) v.stages.push({ stage: name, ms: Date.now() - v.startedAt })
  v.stage = { stage: name, text: t, ...(detail ? { detail } : {}) }
  send(v, 'turn.stage', v.stage)
}

// deepagents plan_todos (the write_todos list, the whole list every time) → [{id, text, state}]
export function todosOf(list) {
  if (!Array.isArray(list)) return []
  return list.filter((t) => t && (typeof t === 'object' || typeof t === 'string')).slice(0, 20).map((t, i) => {
    const text = String(typeof t === 'string' ? t : t.content ?? t.text ?? t.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 160)
    const s = String(typeof t === 'object' ? t.status ?? t.state ?? '' : '').toLowerCase()
    const state = ['completed', 'complete', 'done'].includes(s) ? 'done' : ['in_progress', 'in-progress', 'active', 'running'].includes(s) ? 'active' : 'pending'
    return { id: `t${i + 1}`, text, state }
  }).filter((t) => t.text)
}
export function todos(turn, list) {
  const v = viewOf(turn)
  if (!v || v.ended) return
  const next = todosOf(list)
  if (!next.length) return
  v.todos = next
  send(v, 'turn.todos', { todos: next })
  if (v.stage?.stage === 'preparing') stage(turn, 'working')
}

// a trail entry as it is added (lib/workTrail.js — the same redaction): {tool, phase, hosts?, query?, file?}
export function step(turn, e) {
  const v = viewOf(turn)
  if (!v || v.ended || !e) return
  // (the same step at the same place again: the line it is already on counts it — key, as the saved trail does)
  const had = e.key ? v.steps.find((x) => x.key === e.key) : null
  const s = { seq: had ? had.seq : ++v.seq, phase: e.phase || '', tool: e.tool || '', text: e.phase || e.tool || '', ...(e.hosts ? { hosts: e.hosts } : {}),
    ...(e.query ? { query: e.query } : {}), ...(e.file ? { file: e.file } : {}), n: e.n || 1, ...(e.key ? { key: e.key } : {}) }
  if (had) Object.assign(had, s)
  else v.steps.push(s)
  if (v.steps.length > KEEP_STEPS) v.steps.splice(0, v.steps.length - KEEP_STEPS)
  send(v, 'turn.step', s)
}

// an interim text: open (still being written, shown on the live line) or closed (it was followed by a tool event)
export function note(turn, text, { open = false } = {}) {
  const v = viewOf(turn)
  if (!v || v.ended) return
  const t = String(text || '').trim().slice(0, NOTE_CHARS)
  if (open) {
    if (v.open?.text === t) return
    v.open = { seq: v.seq + 1, text: t }
    return send(v, 'turn.note', { seq: v.open.seq, text: t, open: true })
  }
  v.open = null
  if (!t) return
  const n = { seq: ++v.seq, text: t }
  v.notes.push(n)
  if (v.notes.length > KEEP_NOTES) v.notes.splice(0, v.notes.length - KEEP_NOTES)
  send(v, 'turn.note', n)
}

// The turn is over: the card goes, the answer keeps the plan (saved). A front call still running is not wanted any more.
export function end(turn, state = 'done') {
  const v = viewOf(turn)
  if (!v || v.ended) return
  stage(turn, state)
  v.ended = state
  v.abort.abort()
  send(v, 'turn.end', { state, ms: Date.now() - v.startedAt })
  views.delete(turn.id)
}

// what the answer (or the 「멈췄어요」 message) keeps: content.plan and content.notes
export function saved(turn, state) {
  const v = viewOf(turn)
  if (!v?.plan) return {}
  const steps = v.todos.length ? v.todos.map((t) => ({ ...t, state: state === 'done' ? 'done' : t.state }))
    : v.plan.steps.map((s) => ({ ...s, state: state === 'done' ? 'done' : 'pending' }))
  return {
    plan: { understood: v.plan.understood, steps, handler: v.handler, tier: v.plan.tier, model: v.plan.model || null, source: v.plan.source,
      state, ms: Date.now() - v.startedAt, stages: v.stages.slice(0, 20), fromTodos: !!v.todos.length },
    ...(v.notes.length ? { notes: v.notes.map((n) => n.text) } : {}),
  }
}

// §1.4: what the agent is told after the person's message — the plan, recorded with write_todos first, and no more than it.
// Waits for the front call (it ends by FRONT_MS from the message); nothing when it fell back or is off.
export async function planBlock(turn) {
  const v = viewOf(turn)
  if (!v?.ready) return ''
  const plan = v.plan || await Promise.race([v.ready, new Promise((r) => setTimeout(() => r(null), Math.max(0, FRONT_MS + 300 - (Date.now() - v.startedAt))))])
  if (!plan || plan.source !== 'front') return ''
  const steps = plan.steps.map((s, i) => `${i + 1}. ${s.text}`).join('\n')
  return L(`\n\n[계획] ${plan.understood}\n${steps ? `${steps}\n` : ''}이 계획을 먼저 write_todos 로 기록하세요(다듬어도 됩니다). 이 일만 하세요.\n요청하지 않은 결과물은 만들지 마세요. 더 하면 좋을 일이 있으면 끝에 말로 제안하세요.`,
    `\n\n[Plan] ${plan.understood}\n${steps ? `${steps}\n` : ''}Record this plan with write_todos first; you may refine it. Do only this work.\nDo not produce deliverables that were not asked for; if more seems useful, say so at the end.`)
}

// the live state of this person's turns in a thread (the page opened mid-turn)
export function snapshot(userId, threadId) {
  return [...views.values()].filter((v) => v.userId === userId && v.threadId === threadId && !v.ended).map((v) => ({
    ...base(v), msgId: v.msgId, startedAt: v.startedAt, lastAt: v.lastAt, planState: v.planState,
    plan: v.plan ? { understood: v.plan.understood, steps: v.plan.steps, tier: v.plan.tier, certainty: v.plan.certainty, source: v.plan.source, alternatives: [] } : null,
    handler: v.handler, stage: v.stage, todos: v.todos, steps: v.steps.slice(-KEEP_STEPS), notes: v.notes, open: v.open,
  }))
}

// (thread: how a person's thread is found — tests give their own)
export function turnRoutes(auth, { thread = getThread } = {}) {
  const r = express.Router()
  r.get('/threads/:id/turn', auth, async (req, res) => {
    const t = await thread(req.user.id, req.params.id).catch(() => null)
    if (!t) return res.status(404).end()
    res.json({ now: Date.now(), turns: snapshot(req.user.id, t.id) })
  })
  return r
}

// ---------- interim text (§3.4) ----------
// Tokens are collected per segment; a segment ends at a tool event (tool_start, plan_tools) or the end of the stream. Under
// PROMOTE_CHARS it shows only on the card's live line (onOpen); past it, with no tool event, it becomes the draft answer (onDelta,
// streamed from then on); a tool event after that takes it back (onRetract) and it becomes a note (onNote), as a short one does.
export function createSegments({ promoteAt = PROMOTE_CHARS, onDelta, onRetract, onNote, onOpen, onPromote, stream = true } = {}) {
  let seg = '', promoted = false, lastClosed = ''
  return {
    token(t) {
      if (!t) return
      seg += t
      if (promoted) return onDelta?.(t)
      if (stream && seg.trim().length > promoteAt) { promoted = true; onPromote?.(); onDelta?.(seg); return }
      onOpen?.(seg)
    },
    cut() {
      const s = seg.trim()
      if (s) {
        if (promoted) onRetract?.()
        onNote?.(s)
        lastClosed = s
      }
      seg = ''
      promoted = false
    },
    // the answer at the end of the stream: the open segment, else the last closed one
    current: () => seg.trim(),
    answer: () => seg.trim() || lastClosed,
    promoted: () => promoted,
  }
}
