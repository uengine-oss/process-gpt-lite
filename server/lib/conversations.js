// Which conversation each message belongs to, as the page files them — the same rules as src/convOf.js (the main chat's conversations) and
// src/projectTopics.js topicOf (a project's sub-topics). The server image has no src/ and the web image no server/: the cases in
// server/test/conversations.test.js hold both to the same answers. Used where the server must pick what a conversation is about the way
// the person sees it (lib/chatProject.js — 「이 내용으로 프로젝트 만들자」: this conversation's answer, not a newer one filed elsewhere).

// ---------- the main chat (src/convOf.js convOf) ----------
// the conversation a message is filed in aside, or null
export function asideOf(m) {
  const c = m?.content?.context
  return c?.action === 'aside' && c.conversationId ? String(c.conversationId) : null
}
const OLD_RUN_MS = 30_000
const at = (m) => { const v = new Date(m?.created_at).getTime(); return Number.isFinite(v) ? v : NaN }

/** message id → conversation id (null: before any conversation) for the main chat's messages, oldest first; briefId: the server's 브리프 row */
export function convOf(messages = [], { briefId = null } = {}) {
  const out = {}
  const list = Array.isArray(messages) ? messages : []
  const taskConv = {}
  let brief = briefId || null
  for (const m of list) {
    const own = asideOf(m)
    if (!own) continue
    if (m.content?.scheduleId && !taskConv[m.content.scheduleId]) taskConv[m.content.scheduleId] = own
    if (m.content.context.kind === 'brief' && !brief) brief = own
  }
  let cur = null
  let pending = []
  let run = null
  for (let i = 0; i < list.length; i++) {
    const m = list[i]
    if (!m?.id) continue
    const own = asideOf(m)
    if (own) { out[m.id] = own; run = null; continue }
    const c = m.content || {}
    if (m.kind === 'divider' && c.scheduleId) {
      run = { conv: taskConv[c.scheduleId] || `sched-old-${String(c.scheduleId).replace(/-/g, '')}`, task: c.scheduleId, at: at(m) }
      out[m.id] = run.conv
      continue
    }
    if (m.role === 'agent' && Array.isArray(c.mails) && c.mails.length && !c.context) {
      const b = brief || 'brief-old'
      out[m.id] = b
      const before = list[i - 1]
      if (before?.kind === 'divider' && !before.content?.context && !before.content?.scheduleId) out[before.id] = b
      run = null
      continue
    }
    if (m.role === 'user') { run = null; pending.push(m); continue }
    if (run && !c.context && m.kind !== 'divider' && (c.scheduleId === run.task || (!c.scheduleId && at(m) - run.at <= OLD_RUN_MS))) { out[m.id] = run.conv; continue }
    run = null
    const ctx = c.context
    if (ctx?.conversationId && ctx.action !== 'stay') cur = ctx.conversationId
    for (const p of pending) out[p.id] = cur
    pending = []
    out[m.id] = cur
  }
  for (const p of pending) out[p.id] = cur
  return out
}
/** the conversation the person is in: that of the latest message not filed aside */
export function currentConversation(messages = [], of = {}) {
  for (let i = (messages || []).length - 1; i >= 0; i--) {
    const m = messages[i]
    if (of[m?.id] && !asideOf(m)) return of[m.id]
  }
  return null
}

// ---------- a project's sub-topics (src/projectTopics.js topicOf) ----------
const convOfMsg = (m) => {
  const raw = m?.content?.conv
  const c = raw && typeof raw === 'object' ? raw.id : raw
  return c && !String(c).startsWith('none:') ? String(c) : null
}
export function topicOf(messages = []) {
  const out = {}
  let cur = null
  let pending = []
  for (const m of messages || []) {
    if (!m?.id) continue
    const conv = convOfMsg(m)
    // a conversation moved in from the chat (lib/conversationMove.js): its own sub-topic, and it never takes the messages around it along
    if (m.content?.moved) { if (conv) out[m.id] = conv; continue }
    if (m.role === 'user') {
      if (conv) out[m.id] = conv
      else pending.push(m)
      continue
    }
    if (conv) cur = conv
    for (const p of pending) out[p.id] = cur
    pending = []
    out[m.id] = cur
  }
  for (const p of pending) out[p.id] = cur
  return out
}
// the sub-topic a project is in: that of its latest message that has one
export function currentTopic(messages = [], of = {}) {
  for (let i = (messages || []).length - 1; i >= 0; i--) if (of[messages[i]?.id]) return of[messages[i].id]
  return null
}
