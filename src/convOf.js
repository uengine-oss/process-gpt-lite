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
// Messages stored before those tags are read by their structure: a scheduled run's divider names its task (scheduleId) — it and the
// untagged lines of that run (no context at all, and the same task or written within moments of the divider) go to that task's
// conversation; a brief's text carries its mails' chips (mails) — it and the divider just before it go to the person's 브리프
// conversation. Other old lines stay where the sweep put them. The server's ids for these conversations cannot be worked out here
// (lib/ownConversations.js — keyed, so a teammate cannot guess them): a task's is the one its tagged divider carries, the briefs' the one
// a tagged brief carries (or the server's 브리프 row — briefId); until there is one, an old run or brief waits under an id of the
// screen's own (`sched-old-…` · `brief-old`), which no request ever sends as its own (the server takes only a person's own ids).

// the conversation a message is filed in aside, or null
export function asideOf(m) {
  const c = m?.content?.context
  return c?.action === 'aside' && c.conversationId ? String(c.conversationId) : null
}
const OLD_RUN_MS = 30_000 // an old run's lines came with its divider (the answer, its files, a Telegram line) — not minutes later
const at = (m) => { const v = new Date(m?.created_at).getTime(); return Number.isFinite(v) ? v : NaN }

/** message id → conversation id (null: before any conversation) for the main chat's messages, oldest first; briefId: the server's 브리프 row */
export function convOf(messages = [], { briefId = null } = {}) {
  const out = {}
  const list = Array.isArray(messages) ? messages : []
  // what the tagged messages say about the ids: a task's conversation, the briefs'
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
  let run = null // an old scheduled run: {conv, task, at} while its lines go on
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
    // a line of the old run: nothing marks it as anything else (no context at all), and it is that task's or came with its divider
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

/** the conversation the person is in: that of the latest message not filed aside (a brief or a scheduled run is never where they are) */
export function currentConversation(messages = [], of = {}) {
  for (let i = (messages || []).length - 1; i >= 0; i--) {
    const m = messages[i]
    if (of[m?.id] && !asideOf(m)) return of[m.id]
  }
  return null
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
    else if (m.kind === 'divider' && m.content?.scheduleId) { n.title ||= m.content.text; n.kind ||= 'schedule' }
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
