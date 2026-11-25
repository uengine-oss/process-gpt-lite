// Which conversation each message of the main chat belongs to, and the chat's 대화 list (stores/app.js convOf · convList; spec
// openspec/specs/chat-thread-list). No browser state here: tested in server/test/convOf.test.js.
//
// An answer carries the context router's call (context.conversationId, new/continue); the person's message and attachments just before
// it go with it; a 「stay」 answer, a chip or a card stays in the conversation the chat was in.
// What arrives without the person typing it — a scheduled run, a mail brief, a mail's drafts, a follow-up a button started — carries
// its own conversation, filed aside (context {conversationId, action: 'aside'}, server lib/ownConversations.js): it goes there and never
// moves the conversation the chat is in, so what follows it is not filed with it (2026-11-25, production: a 모닝 브리프, a mail chip and
// two runs of a stock watcher inside the conversation 「글씨가 표의 윗부분에 붙어있다. 중앙정렬」 — 「엉뚱한 쓰레드에 스케쥴 업무가
// 붙어서 분류되어있다」).
// Messages stored before those tags are read by their structure: a scheduled run's divider names its task (scheduleId) — it and the agent
// lines right after it go to that task's conversation; a brief's text carries its mails' chips (mails) — it and the divider just before
// it go to the person's 브리프 conversation. Other old lines stay where the sweep put them.

const hex = (id) => String(id || '').replace(/-/g, '').toLowerCase()
// the same ids the server gives these conversations (server lib/ownConversations.js)
export const scheduleConversationId = (scheduleId) => `sched-${hex(scheduleId)}`
export const briefConversationId = (userId) => `brief-${hex(userId)}`

// the conversation a message is filed in aside, or null
export function asideOf(m) {
  const c = m?.content?.context
  return c?.action === 'aside' && c.conversationId ? String(c.conversationId) : null
}

/** message id → conversation id (null: before any conversation) for the main chat's messages, oldest first; userId: whose chat */
export function convOf(messages = [], { userId = null } = {}) {
  const out = {}
  const list = Array.isArray(messages) ? messages : []
  let cur = null
  let pending = []
  let run = null // an old scheduled run: its task's conversation, while its lines go on
  for (let i = 0; i < list.length; i++) {
    const m = list[i]
    if (!m?.id) continue
    const own = asideOf(m)
    if (own) { out[m.id] = own; run = null; continue }
    const c = m.content || {}
    if (m.kind === 'divider' && c.scheduleId) { run = scheduleConversationId(c.scheduleId); out[m.id] = run; continue }
    if (m.role === 'agent' && userId && Array.isArray(c.mails) && c.mails.length && !c.context?.conversationId) {
      const brief = briefConversationId(userId)
      out[m.id] = brief
      const before = list[i - 1]
      if (before?.kind === 'divider' && !asideOf(before) && !before.content?.scheduleId) out[before.id] = brief
      run = null
      continue
    }
    if (m.role === 'user') { run = null; pending.push(m); continue }
    const ctx = c.context
    if (run && !ctx?.conversationId && m.kind !== 'divider') { out[m.id] = run; continue }
    run = null
    if (ctx?.conversationId && ctx.action !== 'stay') cur = ctx.conversationId
    for (const p of pending) out[p.id] = cur
    pending = []
    out[m.id] = cur
  }
  for (const p of pending) out[p.id] = cur
  return out
}

const time = (t) => { const v = new Date(t).getTime(); return Number.isFinite(v) ? v : -Infinity }
// a conversation of its own that has no title yet
const UNTITLED = { brief: '브리프' }

/**
 * The 대화 list: the server's rows (the router's and the ones filed for scheduled tasks and briefs — title · summary · gist · kind) that
 * have messages in the chat, each with its message count, newest first; and a conversation the chat already shows but the server has not
 * listed (yet), named by a message that carries it (its context's title, or an old scheduled run's divider), with its kind.
 */
export function convRows(rows = [], messages = [], of = {}) {
  const counts = {}
  const last = {}
  for (const m of messages || []) {
    const id = of[m?.id]
    if (!id) continue
    counts[id] = (counts[id] || 0) + 1
    if (time(m.created_at) > time(last[id])) last[id] = m.created_at
  }
  const known = new Set((rows || []).map((c) => c.id))
  const out = (rows || []).filter((c) => counts[c.id]).map((c) => ({ ...c, count: counts[c.id] }))
  const named = {}
  for (const m of messages || []) {
    const id = of[m?.id]
    if (!id || known.has(id)) continue
    const c = m.content?.context
    const n = (named[id] ||= {})
    if (c?.conversationId === id) { n.title ||= c.title; n.kind ||= c.kind }
    else if (m.kind === 'divider' && m.content?.scheduleId && scheduleConversationId(m.content.scheduleId) === id) { n.title ||= m.content.text; n.kind ||= 'schedule' }
    else if (id.startsWith('brief-')) n.kind ||= 'brief'
    else continue
    n.seen = true
  }
  for (const [id, n] of Object.entries(named)) {
    if (!n.seen || !counts[id]) continue
    out.push({ id, title: n.title || UNTITLED[n.kind] || '', summary: '', updated_at: last[id], count: counts[id], ...(n.kind ? { kind: n.kind } : {}) })
  }
  return out.sort((a, b) => time(b.updated_at) - time(a.updated_at))
}
