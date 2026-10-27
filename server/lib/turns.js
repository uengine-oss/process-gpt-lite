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

// tests
export const _live = live
