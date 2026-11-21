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
    started: false, finished: false, stopped: false, abort: new AbortController(),
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
export async function waitTurn(t, onQueued) {
  let waited = false
  for (;;) {
    const before = earlier(t)
    // an earlier turn of this thread that has not learned its conversation yet may be on this one
    const unsure = before.filter((x) => !x.conv && x.threadId === t.threadId)
    const same = t.conv ? before.filter((x) => x.conv === t.conv) : []
    if (!unsure.length && !same.length) { t.started = true; return waited }
    if (!waited) { waited = true; await onQueued?.() }
    await Promise.race([...same.map((x) => x.done), ...unsure.map((x) => x.convReady)])
  }
}

// The running turns a stop request reaches: this user's, in this thread, optionally one conversation.
export function running({ userId, threadId, conv }) {
  return [...live.values()].filter((x) => x.userId === userId && x.threadId === threadId && x.started && !x.finished && (!conv || x.conv === conv))
}
export const waiting = ({ userId, threadId }) => [...live.values()].filter((x) => x.userId === userId && x.threadId === threadId && !x.started && !x.finished)

// A browser task started by a correction ("do it on that site instead") replaces the agent turn of the
// request it corrects: left running, that turn came back first with "완료했습니다" and files of its own
// while the site's work had not even started (recording 2026-11-21).
// The agent turns (delegate marks them: t.agent) of this thread still in flight — running or waiting
// their turn — that came before the given one:
export const agentTurnsAhead = ({ userId, threadId, before = null }) => [...live.values()].filter((x) =>
  x.agent && !x.finished && !x.stopped && x.userId === userId && x.threadId === threadId && x !== before && (!before || x.seq < before.seq))

// Does a new browser request replace them?
//   'stop' — a project room is one conversation: a new browser request there takes the place of the turn ahead
//   'ask'  — the main chat runs several things side by side: whether it corrects one of them is the judge's
//            call (pickReplaced) — asked only when a browser task starts while an agent turn is ahead
//   'keep' — nothing ahead
export const CORRECTION_BAR = 0.7
export function replaceRule({ room, ahead = [] }) {
  if (!ahead.length) return 'keep'
  return room ? 'stop' : 'ask'
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
