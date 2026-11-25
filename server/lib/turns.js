// Agent turns in flight (lib/agent.js delegate), one at a time per conversation.
//
// process-gpt's chat SDK cancels a conversation's running turn when a new request arrives for the
// same conversation_id (InflightRegistry.supersede → "turn cancelled"). Sent while an answer is
// still coming, a second message used to cancel the first and lose its own answer as well. Here a
// turn for a conversation that already has one running waits until that one ends (the chat shows
// it as 대기), and 멈추기 stops a running turn through the SDK's own /chat/stop.
import crypto from 'node:crypto'

const live = new Map() // id -> turn
let seq = 0

// conv: the deepagents conversation the turn goes to, when known before it starts (a pinned
// conversation, a project/instance thread); a routed turn learns it from the router (setConv).
export function enqueue({ userId, threadId, conv = null, jwt = '' }) {
  let doneResolve, convResolve
  const t = {
    id: crypto.randomUUID(), seq: ++seq, userId, threadId, conv: conv || null, jwt, title: '',
    started: false, finished: false, stopped: false, front: false, abort: new AbortController(),
    done: new Promise((r) => { doneResolve = r }),
    convReady: conv ? Promise.resolve(conv) : new Promise((r) => { convResolve = r }),
  }
  t.setConv = (c) => { if (c && !t.conv) { t.conv = String(c); convResolve?.(t.conv) } }
  t.finish = () => {
    if (t.finished) return
    t.finished = true
    live.delete(t.id)
    convResolve?.(t.conv)
    doneResolve()
  }
  live.set(t.id, t)
  return t
}

// turns that came before this one and are still in flight
const earlier = (t) => [...live.values()].filter((x) => x !== t && x.seq < t.seq && !x.finished)

// another turn of this thread is in flight (a routed turn then asks the router first which
// conversation it belongs to, so it knows whether it has to wait)
export const busyThread = (t) => earlier(t).some((x) => x.threadId === t.threadId)

// The turns ahead of this one in its thread, once each knows its conversation (or has ended): the
// router is shown them as conversations in progress, so a follow-up of a running request ("방금 말한
// 것 중…") joins it instead of starting a new one before that answer is recorded.
export async function aheadInThread(t) {
  const list = earlier(t).filter((x) => x.threadId === t.threadId)
  await Promise.all(list.map((x) => x.convReady))
  // (a message answered without an agent turn marks itself none:<id>)
  return list.filter((x) => x.conv && !x.conv.startsWith('none:') && !x.finished)
}

// Waits until no earlier turn is in flight on the same conversation. onQueued runs once, before the
// first wait (the chat marks the message 대기). Returns whether the turn had to wait.
// A serial turn (a project's — lib/agent.js delegate) also waits for every earlier agent turn of its thread, whatever its conversation:
// a project's sub-topics are conversations of their own (lib/projectTopics.js), but its folder's variation is checked out where the
// turn runs, one turn at a time — as when a project had one conversation
export async function waitTurn(t, onQueued) {
  let waited = false
  for (;;) {
    const before = earlier(t)
    // an earlier turn of this thread that has not learned its conversation yet may be on this one
    const unsure = before.filter((x) => !x.conv && x.threadId === t.threadId)
    const same = before.filter((x) => (t.conv && x.conv === t.conv) || (t.serial && x.threadId === t.threadId && x.conv && !x.conv.startsWith('none:')))
    if (!unsure.length && !same.length) { t.started = true; return waited }
    if (!waited) { waited = true; await onQueued?.() }
    if (t.abort.signal.aborted) { t.started = true; return waited }
    await Promise.race([...same.map((x) => x.done), ...unsure.map((x) => x.convReady),
      new Promise((r) => t.abort.signal.addEventListener('abort', r, { once: true }))])
  }
}

// The running turns a stop request reaches: this user's, in this thread, optionally one conversation — and a message still in its
// front stage (t.front: read and routed before any handler starts — lib/agent.js runTurn): 멈추기 then stops it before a handler
// starts (design turnplan §1.3; it used to go on and run). A message in its front stage has no conversation yet: in one
// conversation's (or sub-topic's) view it is still that view's (review 11-25 #3).
export function running({ userId, threadId, conv }) {
  return [...live.values()].filter((x) => x.userId === userId && x.threadId === threadId && (x.started || x.front) && !x.finished
    && (!conv || x.conv === conv || (x.front && !x.started && !x.conv)))
}
// What 멈추기 stops: the answers being written if there are any — a message just sent while one is written (still in its front stage)
// goes on (review 11-25 #4); a message in its front stage only when nothing has started.
export function toStop(list) {
  const started = list.filter((x) => x.started)
  return started.length ? started : list
}
export const waiting = ({ userId, threadId }) => [...live.values()].filter((x) => x.userId === userId && x.threadId === threadId && !x.started && !x.front && !x.finished)

// A browser task started by a correction ("do it on that site instead") replaces the agent turn of the
// request it corrects: left running, that turn came back first with "완료했습니다" and files of its own
// while the site's work had not even started (recording 2026-11-21).
// The agent turns (delegate marks them: t.agent) of this thread still in flight — running or waiting
// their turn — that came before the given one:
export const agentTurnsAhead = ({ userId, threadId, before = null }) => [...live.values()].filter((x) =>
  x.agent && x.fromUser && !x.finished && !x.stopped && x.userId === userId && x.threadId === threadId && x !== before && (!before || x.seq < before.seq))

// Does a new browser request replace them?
//   'ask'  — whether it corrects one of them is the judge's call (pickReplaced), in a project room as in the main
//            chat: a room can hold a report being written and a link handed in for something else
//   'keep' — nothing ahead
export const CORRECTION_BAR = 0.7
export function replaceRule({ room, ahead = [] }) {
  if (!ahead.length) return 'keep'
  return 'ask'
}
// the judge's answer (option t<i> per turn ahead, 'new' for a separate request) → the turns to stop
export const JUDGE_AHEAD = 3
export const judgedAhead = (ahead) => ahead.slice(-JUDGE_AHEAD)
export function pickReplaced(shown, probabilities, bar = CORRECTION_BAR) {
  const p = probabilities || {}
  const best = Object.keys(p).filter((k) => k !== 'new').sort((a, b) => p[b] - p[a])[0]
  const i = best ? Number(best.slice(1)) : -1
  return best && p[best] >= bar && shown[i] ? [shown[i]] : []
}

// tests
export const _live = live
