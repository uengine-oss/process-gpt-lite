// A mail the agent writes for the person — 「내 계정으로 보내기」 (mcp/mail.js send_mail_as_me). The agent never sends it:
// it becomes a 「보낼 메일」 card in the chat (pro_messages kind 'mail_out') with who it goes out as, to whom, its subject,
// whether it continues the mail it answers, its body and its files — and it leaves only when the person presses 보내기,
// from the mailbox THEY connected (lib/mailReply.js): Gmail sends it, in the thread it answers (threadId, In-Reply-To,
// References); IMAP puts it in that mailbox's Drafts; the demo mailbox records it.
// 2026-11-27 (production, a recording): asked in the chat 「이렇게 보내」, the agent sent a customer's reply itself through the
// company's mail tool (a tenant MCP send_email) — from the company's shared sending address, not the person's, and as a new
// mail instead of a reply in the customer's thread. Lite's turns no longer get that tool (lib/agentMeta.js → deepagents
// metadata.hidden_tools · hidden_tool_servers); this is the tool they get instead.
//   senderOf      — who the mail goes out as now: the person's connected mailbox and how it leaves (send · drafts · none · connect)
//   findOriginal  — the mail it answers, in the person's own mailbox: by its id, or by subject among the mails exchanged with a
//                   recipient the agent named — never guessed from the subject alone
//   propose       — the card, in the chat of the agent turn that asked — found by its conversation (nothing leaves)
//   cardView      — what the card shows now (GET /api/mail-out/:id): the sender is read again, never taken from the card, and a
//                   confirmation bound to exactly what is shown
//   editOut       — the person's edits, saved on the card first (POST …/edit)
//   sendOut       — 보내기: only the saved card, only with the confirmation of what was shown; once, claimed first
//   resolveOut    — after a send that could not be confirmed (a timeout): 「보냈어요」 or 「안 나갔어요」, after checking the Sent folder
//   keepOut · reopenOut · cancelOut — 초안으로 두기 · 다시 열기 · 그만두기
import crypto from 'node:crypto'
import { q, admin } from './supa.js'
import { emit } from './bus.js'
import { getThread } from './store.js'
import { L } from './lang.js'
import * as turns from './turns.js'
import { addresses, formatAddress, recipients, originalOf, sendMode, buildReply, gmail, gmailSend, imapDraft, imapClient, parsed,
  storageKey, ownUpload, filesFor, download, sendUncertain } from './mailReply.js'

const BODY_MAX = 20000
const FILES_MAX = 10
const ATTACH_MAX = 20 * 1024 * 1024
const fail = (status, message, code) => Object.assign(new Error(message), { status, ...(code && { code }) })
const clean = (s, n = 300) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n)
const list = (v) => (Array.isArray(v) ? v : v ? [v] : []).map((x) => String(x || '').trim()).filter(Boolean)
const asAddresses = (v) => addresses(list(v).join(', '))
const lower = (a) => String(a?.address || a || '').toLowerCase()
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// RFC 5322 §3.6.5: a reply's subject is the original's with "Re: " in front (forwards: "Fw:" / "Fwd:") — a format, not words read
const REPLY_PREFIX = /^\s*((re|fwd?)\s*:\s*)+/i
export const baseSubject = (s) => String(s || '').replace(REPLY_PREFIX, '').replace(/\s+/g, ' ').trim()

// ---------- who it goes out as ----------
// The mailbox this person connected — never the company's, never what the card or the agent says.
// mode: send (Gmail allowed to send · the demo mailbox) | drafts (IMAP — into that mailbox's Drafts) | none (Gmail without permission
// to send) | connect (no mailbox)
export async function senderOf(user) {
  const [acc] = await q('select provider, address from pro_mail_accounts where user_id=$1', [user.id])
  const [p] = await q('select name from pro_profile where user_id=$1', [user.id]).catch(() => [])
  const name = p?.name || user.name || ''
  if (!acc) return { provider: null, address: null, name, mode: 'connect' }
  return { provider: acc.provider, address: acc.address || user.email || null, name, mode: await sendMode(user.id, acc.provider) }
}

// ---------- the mail it answers ----------
const participants = (o) => [o?.from, ...(o?.to || []), ...(o?.cc || []), ...(o?.replyTo || [])].filter(Boolean).map(lower)
function replyOf(o, by, to) {
  if (!o) return null
  const from = o.from ? lower(o.from) : ''
  const rt = (o.replyTo || []).map(lower).filter(Boolean)
  const seen = participants(o)
  return {
    mailId: String(o.id), threadId: o.threadId || null, subject: o.subject || '', from: o.from ? formatAddress(o.from) : '', date: o.date || null, by, seen,
    // the mail asks replies to go somewhere other than its sender — said on the card
    ...(rt.length && rt.some((a) => a !== from) ? { replyTo: (o.replyTo || []).map(formatAddress).join(', ') } : {}),
    // the mail goes to someone who was not in that conversation — said on the card
    ...(to.length && !to.some((a) => seen.includes(lower(a))) ? { outsider: true } : {}),
  }
}
// the newest mail in this person's own mailbox with that subject, exchanged with one of the people the agent named
async function bySubject(user, provider, base, people) {
  if (!base || !people.length) return null
  const matches = (o) => o && baseSubject(o.subject) === base && participants(o).some((a) => people.includes(a))
  if (provider === 'gmail') {
    const qs = `subject:"${base.replace(/["\\]/g, ' ')}" {${people.map((a) => `from:${a} to:${a}`).join(' ')}} -in:drafts`
    const found = await gmail(user.id, `messages?maxResults=5&q=${encodeURIComponent(qs)}`)
    for (const m of found.messages || []) {
      const o = await originalOf(user.id, 'gmail', m.id).catch(() => null)
      if (matches(o)) return o
    }
    return null
  }
  if (provider === 'imap') {
    const client = await imapClient(user.id)
    let lock = null
    try {
      lock = await client.getMailboxLock('INBOX')
      const uids = (await client.search({ subject: base }, { uid: true })) || []
      for (const uid of [...uids].sort((a, b) => b - a).slice(0, 5)) {
        const msg = await client.fetchOne(String(uid), { source: true }, { uid: true })
        const o = msg?.source ? { id: String(uid), threadId: null, ...(await parsed(msg.source)) } : null
        if (matches(o)) return o
      }
      return null
    } finally { try { lock?.release() } catch { /* closed */ } await client.logout().catch(() => {}) }
  }
  // the demo mailbox: the cards its mails made
  const cards = await q(`select source from pro_actions where user_id=$1 and source ? 'mail_id' order by created_at desc limit 50`, [user.id])
  for (const c of cards) {
    if (baseSubject(c.source?.subject) !== base) continue
    const o = await originalOf(user.id, provider, String(c.source.mail_id)).catch(() => null)
    if (matches(o)) return o
  }
  return null
}
// → {original, by: 'id'|'subject'} — the original as lib/mailReply.js reads it — or {original: null} (not found, not this person's,
// no mailbox, or nothing to find it by: no mail id and no recipient named)
export async function findOriginal(user, sender, { mailId = null, subject = '', people = [] } = {}) {
  if (!sender?.provider) return { original: null }
  if (mailId) {
    // (an id from a Home card: the card's mail — only a card of this person's)
    const [card] = UUID.test(String(mailId)) ? await q(`select source from pro_actions where id=$1 and user_id=$2`, [String(mailId), user.id]).catch(() => []) : []
    const id = card?.source?.mail_id ? String(card.source.mail_id) : String(mailId)
    const o = await originalOf(user.id, sender.provider, id).catch(() => null)
    return o ? { original: o, by: 'id' } : { original: null, notFound: true }
  }
  const o = await bySubject(user, sender.provider, baseSubject(subject), people.map(lower)).catch((e) => { console.warn('[mail out] thread', e.code || e.message); return null })
  return o ? { original: o, by: 'subject' } : { original: null }
}
// The person's Home card for that mail (or its thread) was already answered — from its sheet or from another card
async function answeredOf(userId, original) {
  if (!original) return null
  const [a] = await q(`select source->'sent' as sent from pro_actions where user_id=$1 and source ? 'sent'
                       and (source->>'mail_id' = $2 or ($3::text is not null and source->>'thread_id' = $3)) order by created_at desc limit 1`,
  [userId, String(original.id), original.threadId ? String(original.threadId) : null]).catch(() => [])
  return a?.sent ? { at: a.sent.at || null, to: a.sent.to || '', subject: a.sent.subject || '' } : null
}

// ---------- the files ----------
// What may go with the mail is what the reply sheet allows (lib/mailReply.js): a file the person uploaded themselves (their own
// storage folder) or a draft document made for the mail it answers — named by the agent, found in this chat (an upload's card) or
// among that mail's draft cards. A name two different files share is not guessed: it is left out, and the card says why.
async function sizeOf(key) {
  const dir = key.split('/').slice(0, -1).join('/'), base = key.split('/').pop()
  const { data } = await admin.storage.from('files').list(dir, { search: base, limit: 5 }).catch(() => ({ data: null }))
  const hit = (data || []).find((x) => x.name === base)
  return Number(hit?.metadata?.size) || null
}
async function filesOf(user, threadId, names, original) {
  const want = list(names).slice(0, FILES_MAX).map((n) => n.split('/').pop())
  if (!want.length) return { files: [], missing: [] }
  const rows = await q(`select id, content, created_at from pro_messages where thread_id=$1 and kind='file' order by created_at desc limit 200`, [threadId])
  const uploads = rows.map((r) => ({ messageId: r.id, name: r.content?.name, key: storageKey(r.content?.url || ''), at: r.created_at }))
    .filter((x) => x.key && ownUpload(user.id, x.key)).map((x) => ({ ...x, origin: 'upload' }))
  const drafts = original ? (await filesFor(user.id, String(original.id)).catch(() => [])).map((d) => ({ messageId: d.messageId, name: d.name, key: storageKey(d.url), origin: 'draft' })).filter((x) => x.key) : []
  const allowed = [...uploads, ...drafts]
  const files = [], missing = []
  for (const name of [...new Set(want)]) {
    const hits = allowed.filter((x) => x.name === name)
    const keys = [...new Set(hits.map((x) => x.key))]
    if (!hits.length) { missing.push({ name, why: rows.some((r) => r.content?.name === name) ? 'not_allowed' : 'not_found' }); continue }
    if (keys.length > 1) { missing.push({ name, why: 'ambiguous', count: keys.length }); continue }
    const f = hits[0]
    files.push({ messageId: f.messageId, name, origin: f.origin, size: await sizeOf(f.key), ...(f.at ? { at: new Date(f.at).toISOString() } : {}) })
  }
  return { files, missing }
}
// The card's files as they are now: each one's storage object and size, read again from its card (an upload of this person's in this
// chat, or a draft made for the mail it answers). What the confirmation is bound to (a file swapped since it was shown is a changed
// card), and exactly what leaves. → [{name, origin, key, size, ok}] — ok: still a file this card may carry
export async function filesNow(user, card) {
  const out = card.content.mail_out || {}
  const files = out.files || []
  if (!files.length) return []
  const mailId = out.reply?.mailId ? String(out.reply.mailId) : null
  const rows = await q(`select m.id, m.thread_id, m.content from pro_messages m join pro_threads t on t.id=m.thread_id
                        where m.id = any($1::uuid[]) and t.user_id=$2 and m.kind='file'`, [files.map((f) => f.messageId), user.id])
  const now = []
  for (const f of files) {
    const r = rows.find((x) => x.id === f.messageId)
    const key = r ? storageKey(r.content?.url || '') : null
    const ok = !!key && (f.origin === 'upload' ? r.thread_id === card.thread_id && ownUpload(user.id, key) : !!mailId && String(r.content?.mail_id || '') === mailId)
    now.push({ messageId: f.messageId, name: f.name, origin: f.origin, key: ok ? key : null, size: ok ? await sizeOf(key) : null, ok })
  }
  return now
}
async function attachments(files) {
  const out = []
  let total = 0
  for (const f of files) {
    if (!f.ok) throw fail(409, L(`첨부할 파일 「${f.name}」을 찾지 못했어요.`, `Couldn't find the file "${f.name}" to attach.`), 'file_missing')
    const got = await download(f.key, f.name)
    total += got.buf.length
    if (total > ATTACH_MAX) throw fail(413, L('첨부 파일이 모두 20MB를 넘어요.', 'The attachments are over 20 MB together.'))
    out.push({ filename: f.name, content: got.buf, ...(got.type ? { contentType: got.type } : {}) })
  }
  return out
}

// ---------- which chat the card goes in ----------
// The agent turn that is calling, by the conversation the agent runs in (deepagents fills X-Conversation-Id from {{conversation_id}}):
// a chat's agent turns are in lib/turns.js; an agent run that is not one (a skill on a schedule — lib/missions.js) is registered here
// for as long as it runs, with the chat it reports to and the agent's conversation. Without a conversation, only when this person has
// exactly one agent run under way; two or more cannot be told apart — refused rather than guessed (a background turn of another chat).
const runs = new Map() // id → {id, userId, threadId, conv, agentConv}
let runSeq = 0
export async function asAgentRun({ userId, threadId, conv = null, agentConv = null }, fn) {
  const id = `run-${++runSeq}`
  runs.set(id, { id, userId, threadId, conv, agentConv })
  try { return await fn() } finally { runs.delete(id) }
}
const ambiguous = () => fail(409, L('어느 대화의 작업인지 알 수 없어 보낼 메일 카드를 띄우지 않았어요. 사람에게 초안을 보여 주고 다시 요청하도록 안내해 주세요.',
  "Couldn't tell which conversation this task is in, so the mail card was not shown. Show the person the draft and ask them to request it again."), 'ambiguous_turn')
export function callingTurn(userId, conv = null) {
  const chats = turns.agentTurnsOf(userId)
  const others = [...runs.values()].filter((r) => r.userId === userId)
  if (conv) {
    const hit = [...chats.filter((t) => t.conv === conv), ...others.filter((r) => r.agentConv === conv)]
    if (hit.length > 1) throw ambiguous()
    return hit[0] || null
  }
  const all = [...chats, ...others]
  if (all.length > 1) throw ambiguous()
  return all[0] || null
}

// ---------- the card ----------
// A recipient list, a subject (empty matches nothing), the mail it answers: the same mail written again
const sameMail = (a, b) => !!baseSubject(a.subject) && baseSubject(a.subject) === baseSubject(b.subject)
  && [...new Set(addresses(a.to || '').map(lower))].sort().join(',') === [...new Set(addresses(b.to || '').map(lower))].sort().join(',')
  && (a.reply?.mailId || null) === (b.reply?.mailId || null)

// input: {to, cc, subject, body, reply_to: {mail_id, subject}, attachments} (the tool's arguments) → {card, view}
// conv: the agent's conversation (X-Conversation-Id)
export async function propose(user, input = {}, { conv = null, turn = callingTurn(user.id, conv) } = {}) {
  if (!turn) throw fail(409, L('보낼 메일 카드는 Process GPT Lite 의 에이전트 작업에서만 띄울 수 있어요. 사람에게 초안을 보여 주고 직접 보내게 하세요.',
    'The mail card can only be shown from an agent task in Process GPT Lite. Show the person the draft and let them send it themselves.'), 'no_turn')
  const body = String(input.body || '').trim().slice(0, BODY_MAX)
  if (!body) throw fail(400, L('보낼 본문이 없어요.', 'There is no body to send.'))
  const subject = clean(input.subject, 300)
  const sender = await senderOf(user)
  let to = asAddresses(input.to)
  const rt = input.reply_to && typeof input.reply_to === 'object' ? input.reply_to : {}
  // the mail it answers: by its id, else only among the mails exchanged with someone the agent named (never by subject alone)
  const found = await findOriginal(user, sender, { mailId: rt.mail_id ? String(rt.mail_id) : null, subject: rt.subject || subject, people: to.map((a) => a.address) })
  const original = found.original
  // whom: what the agent wrote; a reply to a mail named by its id with no one named goes where that mail asks replies to go (its
  // headers — lib/mailReply.js). With neither, no one: the card cannot be sent until the person writes a recipient.
  if (!to.length && original && found.by === 'id') to = recipients(original, [sender.address, user.email].filter(Boolean)).to
  const cc = asAddresses(input.cc)
  const thread = await getThread(user.id, turn.threadId)
  if (!thread) throw fail(404, L('대화를 찾지 못했어요.', "Couldn't find the conversation."))
  const { files, missing } = await filesOf(user, turn.threadId, input.attachments, original)
  const out = {
    to: to.map(formatAddress).join(', '), cc: cc.map(formatAddress).join(', '),
    subject: subject || (original ? `Re: ${baseSubject(original.subject)}` : ''), body,
    reply: replyOf(original, found.by, to.map((a) => a.address)), ...(found.notFound ? { replyNotFound: String(rt.mail_id).slice(0, 80) } : {}),
    answered: await answeredOf(user.id, original), files, missing,
    // (who it would go out as when it was proposed — shown again from the mailbox when the card is read, and used only from there)
    from: sender.address ? formatAddress({ name: sender.name, address: sender.address }) : null,
    state: 'pending', at: new Date().toISOString(),
  }
  const where = turn.conv && !String(turn.conv).startsWith('none:') ? String(turn.conv) : null
  const tag = where ? (thread.kind === 'chat' ? { context: { conversationId: where, action: 'aside' }, conv: where } : { conv: where }) : {}
  const [card] = await q(`insert into pro_messages(thread_id, role, kind, content) values ($1,'agent','mail_out',$2) returning *`,
    [turn.threadId, { text: L(`보낼 메일 · ${out.subject}`, `Mail to send · ${out.subject}`), mail_out: out, owner: user.id, turn: turn.id, ...tag }])
  await q('update pro_threads set updated_at=now() where id=$1', [turn.threadId])
  emit(user.id, 'message', card)
  // the same mail written again (a correction, 「…로 고쳐서」 — same subject, same recipients, same mail answered): the earlier card of
  // it still waiting in this chat is that draft's, now replaced — one card to press, never two versions of the same mail
  const waiting = await q(`select id, content from pro_messages where thread_id=$1 and kind='mail_out' and id<>$2 and content->>'owner'=$3
                           and content->'mail_out'->>'state' = 'pending' and created_at > now() - interval '2 days'`, [turn.threadId, card.id, user.id])
  for (const w of waiting) if (sameMail(w.content?.mail_out || {}, out)) await setState(user, w.id, 'replaced', ['pending']).catch(() => {})
  console.log(`[mail out] card ${card.id.slice(0, 8)} user=${user.id.slice(0, 8)} mode=${sender.mode} reply=${original ? found.by : 'new'} files=${files.length}${missing.length ? ` missing=${missing.length}` : ''}`)
  return { card, view: viewOf(card, sender) }
}

async function cardOf(user, id) {
  if (!UUID.test(String(id))) throw fail(404, L('메일 카드를 찾지 못했어요.', "Couldn't find the mail card."))
  const [m] = await q(`select m.* from pro_messages m join pro_threads t on t.id=m.thread_id where m.id=$1 and m.kind='mail_out'`, [String(id)])
  // (a card in a room shared with others is still only its writer's to send: the turn that proposed it was theirs)
  if (!m || m.content?.owner !== user.id) throw fail(404, L('메일 카드를 찾지 못했어요.', "Couldn't find the mail card."))
  return m
}

// ---------- what was shown is what leaves ----------
// GET returns a confirmation bound to exactly what is shown: the card's content (recipients, subject, body, the mail it answers), who
// it goes out as and how (the connected mailbox's address and mode), and each file as it is now (its storage object and size);
// 보내기 must bring it back. An edit (the person's, on the card) gives a new one; anything else changed since it was shown — the card,
// another mailbox connected, a file swapped — or a confirmation older than CONFIRM_MS is refused (409 stale) and the card is shown
// again. Kept in memory (one server): a restart only asks for one more look.
const SECRET = crypto.randomBytes(32)
const CONFIRM_MS = 15 * 60_000
const contentHash = (out, sender, files) => crypto.createHash('sha256').update(JSON.stringify([out.to || '', out.cc || '', out.subject || '', out.body || '',
  out.reply?.mailId || null, sender?.address || null, sender?.mode || null, sender?.provider || null,
  (files || []).map((f) => [f.messageId, f.key || null, f.size ?? null])])).digest('hex')
const sign = (userId, cardId, hash, at) => crypto.createHmac('sha256', SECRET).update(`${userId}:${cardId}:${hash}:${at}`).digest('base64url')
export const confirmFor = (userId, cardId, out, sender, files, at = Date.now()) => `${at}.${sign(userId, cardId, contentHash(out, sender, files), at)}`
export function confirmOk(userId, cardId, out, sender, files, token, now = Date.now()) {
  const [at, mac] = String(token || '').split('.')
  const t = Number(at)
  if (!t || !mac || now - t > CONFIRM_MS || t > now + 60_000) return false
  const want = Buffer.from(sign(userId, cardId, contentHash(out, sender, files), t)), got = Buffer.from(mac)
  return want.length === got.length && crypto.timingSafeEqual(want, got)
}

const MISSING_WHY = { not_found: ['이 대화에 없는 파일이에요', 'not in this chat'], not_allowed: ['내가 올린 파일이나 이 메일의 초안만 첨부할 수 있어요', 'only your own uploads or drafts for this mail can be attached'],
  ambiguous: ['같은 이름의 파일이 여러 개예요', 'several files have this name'] }
function viewOf(card, sender, files = null) {
  const out = card.content.mail_out || {}
  const now = files || (out.files || []).map((f) => ({ ...f, ok: true }))
  return {
    id: card.id, state: out.state, mode: sender.mode, provider: sender.provider,
    from: sender.address ? formatAddress({ name: sender.name, address: sender.address }) : null,
    to: out.to, cc: out.cc, subject: out.subject, body: out.body, reply: out.reply || null, replyNotFound: out.replyNotFound || null, answered: out.answered || null,
    files: now.map((f) => ({ name: f.name, origin: f.origin, size: f.size ?? null, ...(f.ok === false ? { gone: true } : {}) })),
    missing: (out.missing || []).map((m) => (typeof m === 'string' ? { name: m, why: 'not_found' } : m)).map((m) => ({ ...m, reason: L(...(MISSING_WHY[m.why] || MISSING_WHY.not_found)) })),
    sent: out.sent || null, unknown: out.unknown || null, edited: !!out.edited_at,
    // (only with the files read now: a view made without them cannot be sent from)
    confirm: files && ['pending', 'kept'].includes(out.state) ? confirmFor(card.content.owner, card.id, out, sender, files) : null,
  }
}
// GET /api/mail-out/:id
export async function cardView(user, id) {
  const card = await cardOf(user, id)
  return viewOf(card, await senderOf(user), await filesNow(user, card))
}

async function setState(user, id, state, from, extra = {}) {
  const [m] = await q(`update pro_messages set content = jsonb_set(content, '{mail_out}', (content->'mail_out') || $3::jsonb)
                       where id=$1 and kind='mail_out' and content->>'owner'=$4 and content->'mail_out'->>'state' = any($2::text[]) returning *`,
  [id, from, JSON.stringify({ state, ...extra }), user.id])
  if (m) emit(user.id, 'message', m)
  return m
}

// POST /api/mail-out/:id/edit {to, cc, subject, body} — the person's edits, saved on the card (a pending or kept card) → the view, with a
// new confirmation for what is now shown
export async function editOut(user, id, input = {}) {
  const card = await cardOf(user, id)
  const out = card.content.mail_out || {}
  if (!['pending', 'kept'].includes(out.state)) throw fail(409, L('이미 보냈거나 그만둔 메일이에요.', 'This mail was already sent or dropped.'), 'closed')
  const pick = (k) => (input[k] != null ? String(input[k]) : String(out[k] || ''))
  const to = addresses(pick('to')), cc = addresses(pick('cc'))
  const body = pick('body').trim().slice(0, BODY_MAX)
  if (!body) throw fail(400, L('보낼 내용을 적어 주세요.', 'Write what the mail says.'))
  const patch = { to: to.map(formatAddress).join(', '), cc: cc.map(formatAddress).join(', '), subject: clean(pick('subject'), 300), body, edited_at: new Date().toISOString() }
  // (the recipients changed: whether they were in the conversation it answers is said again)
  if (out.reply) {
    const { outsider, ...reply } = out.reply
    const seen = Array.isArray(reply.seen) ? reply.seen : []
    patch.reply = { ...reply, ...(to.length && !to.some((a) => seen.includes(lower(a))) ? { outsider: true } : {}) }
  }
  const m = await setState(user, card.id, out.state, ['pending', 'kept'], patch)
  if (!m) throw fail(409, L('이미 보냈거나 그만둔 메일이에요.', 'This mail was already sent or dropped.'), 'closed')
  return viewOf(m, await senderOf(user), await filesNow(user, m))
}

// Gmail · IMAP said nothing usable in time: it may have left — the card says 「확인하지 못했어요」 instead of offering 보내기 again
const UNKNOWN_TEXT = () => L('보냈는지 확인하지 못했어요. 메일함의 보낸 편지함을 확인해 주세요.', "Couldn't confirm it was sent. Check the Sent folder of your mailbox.")

// POST /api/mail-out/:id/send {confirm} — 보내기 (IMAP: 임시 보관함에 넣기). Only the saved card leaves: recipients, subject and body in the
// request are not read — the person edits them on the card (…/edit) first.
export async function sendOut(user, id, input = {}) {
  const card = await cardOf(user, id)
  const out = card.content.mail_out || {}
  if (['sent', 'drafted', 'sending'].includes(out.state)) throw fail(409, L('이 메일은 이미 보냈거나 보내는 중이에요. 보낸 편지함을 확인해 주세요.', 'This mail was already sent or is being sent. Check your Sent folder.'), 'already')
  if (out.state === 'unknown') throw fail(409, UNKNOWN_TEXT(), 'send_unknown')
  if (!['pending', 'kept'].includes(out.state)) throw fail(409, L('보내기를 그만둔 메일이에요. 보내려면 채팅에서 다시 부탁해 주세요.', 'This mail was dropped. Ask again in the chat to send it.'), 'closed')
  const sender = await senderOf(user)
  const files = await filesNow(user, card)
  if (!confirmOk(user.id, card.id, out, sender, files, input.confirm)) throw fail(409, L('카드 내용이 바뀌었거나 오래됐어요. 카드를 다시 확인하고 「보내기」를 눌러 주세요.', 'The card changed or was shown too long ago. Check it again and press it.'), 'stale')
  if (sender.mode === 'connect') throw fail(409, L('메일을 연결하면 내 계정으로 보낼 수 있어요.', 'Connect your mail to send it from your own account.'), 'mail_not_connected')
  if (sender.mode === 'none') throw fail(403, L('Gmail의 메일 전송 권한이 없어요. 메일을 다시 연결해 주세요.', "Gmail hasn't allowed sending. Connect your mail again."), 'gmail_scope')
  if (!(sender.mode === 'drafts' || sender.provider === 'gmail' || sender.provider === 'demo')) throw fail(409, L('이 메일함으로는 보낼 수 없어요. 메일을 다시 연결해 주세요.', "This mailbox can't send. Connect your mail again."), 'unknown_provider')
  const to = addresses(String(out.to || '')), cc = addresses(String(out.cc || ''))
  const subject = clean(out.subject, 300), body = String(out.body || '').trim().slice(0, BODY_MAX)
  if (!to.length) throw fail(400, L('받는 사람을 적어 주세요.', 'Add who the mail goes to.'), 'no_recipient')
  if (!body) throw fail(400, L('보낼 내용을 적어 주세요.', 'Write what the mail says.'))
  // the mail it answers, read again from this mailbox (a card made with another mailbox connected answers nothing here)
  const original = out.reply?.mailId ? await originalOf(user.id, sender.provider, out.reply.mailId).catch(() => null) : null
  // answered meanwhile (its sheet, another card): not again
  const answered = await answeredOf(user.id, original)
  if (answered) throw fail(409, L(`이 메일에는 이미 답장을 보냈어요${answered.at ? `(${new Date(answered.at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })})` : ''}. 보낸 편지함을 확인해 주세요.`,
    'This mail was already answered. Check your Sent folder.'), 'already_answered')
  const attached = await attachments(files)
  const from = { name: sender.name, address: sender.address }
  const raw = await buildReply({ from, to, cc, subject: subject || (original ? `Re: ${baseSubject(original.subject)}` : ''), body, original, attachments: attached })
  // one send per card, even when two presses arrive together: the card is claimed before anything leaves
  const claimed = await setState(user, card.id, 'sending', ['pending', 'kept'])
  if (!claimed) throw fail(409, L('이 메일은 이미 보냈거나 보내는 중이에요. 보낸 편지함을 확인해 주세요.', 'This mail was already sent or is being sent. Check your Sent folder.'), 'already')
  let res = null
  try {
    if (sender.mode === 'drafts') await imapDraft(user.id, raw)
    else if (sender.provider === 'gmail') res = await gmailSend(user.id, raw, original?.threadId || null)
    // (demo: recorded only)
  } catch (e) {
    // a refusal (Gmail answered no) frees the card; no answer in time, or an answer that says nothing — it may have left: the card
    // asks the person to check the Sent folder instead of offering 보내기 again (a second press would mail it twice)
    if (sendUncertain(e, sender.mode)) {
      await setState(user, card.id, 'unknown', ['sending'], { unknown: { at: new Date().toISOString(), code: e.code || null } }).catch(() => {})
      console.warn(`[mail out] unknown card=${card.id.slice(0, 8)} user=${user.id.slice(0, 8)} (${e.code || e.message})`)
      throw fail(504, UNKNOWN_TEXT(), 'send_unknown')
    }
    await setState(user, card.id, out.state, ['sending']).catch(() => {})
    throw e
  }
  const via = sender.mode === 'drafts' ? 'drafts' : sender.provider
  const sent = { from: formatAddress(from), to: to.map(formatAddress).join(', '), cc: cc.map(formatAddress).join(', '), subject: subject || out.subject,
    files: attached.map((f) => f.filename), via, thread: !!original, ...(res?.threadId ? { threadId: String(res.threadId) } : {}), at: new Date().toISOString() }
  const m = await setState(user, card.id, via === 'drafts' ? 'drafted' : 'sent', ['sending'], { sent })
  if (original) await markAnswered(user.id, original, sent, via)
  console.log(`[mail out] ${via} card=${card.id.slice(0, 8)} user=${user.id.slice(0, 8)} thread=${original ? 'yes' : 'no'} files=${attached.length}`)
  return { ok: true, sent, card: m }
}
// the mail's Home card (if it made one) is answered now — its sheet must not offer the same reply again
async function markAnswered(userId, original, sent, via) {
  await q(`update pro_actions set status='done', source = source || jsonb_build_object('sent', $3::jsonb) where user_id=$1 and source->>'mail_id'=$2 and not (source ? 'sent')`,
    [userId, String(original.id), { to: sent.to, cc: sent.cc, subject: sent.subject, files: sent.files, via, at: sent.at, from: 'chat' }]).catch((e) => console.warn('[mail out] card', e.message))
}

// POST /api/mail-out/:id/resolve {sent: true|false} — after 「보냈는지 확인하지 못했어요」: the person looked in the Sent folder
export async function resolveOut(user, id, { sent } = {}) {
  const card = await cardOf(user, id)
  const out = card.content.mail_out || {}
  if (out.state !== 'unknown') throw fail(409, L('확인할 메일이 아니에요.', 'There is nothing to confirm for this mail.'), 'closed')
  if (sent === true) {
    const s = { from: out.from || '', to: out.to, cc: out.cc, subject: out.subject, files: (out.files || []).map((f) => f.name), checked: true, thread: !!out.reply, at: new Date().toISOString() }
    const m = await setState(user, card.id, 'sent', ['unknown'], { sent: s })
    if (out.reply?.mailId) await markAnswered(user.id, { id: out.reply.mailId }, s, 'checked')
    return { ok: true, card: m }
  }
  const m = await setState(user, card.id, 'pending', ['unknown'], { unknown: null })
  return { ok: true, card: m }
}

// POST /api/mail-out/:id/keep — 초안으로 두기: nothing leaves; the card keeps the draft in the chat
export async function keepOut(user, id) {
  await cardOf(user, id)
  const m = await setState(user, id, 'kept', ['pending'])
  if (!m) throw fail(409, L('이미 보냈거나 그만둔 메일이에요.', 'This mail was already sent or dropped.'), 'closed')
  return { ok: true, card: m }
}
// POST /api/mail-out/:id/reopen — a kept draft back to 보내기
export async function reopenOut(user, id) {
  await cardOf(user, id)
  const m = await setState(user, id, 'pending', ['kept'])
  if (!m) throw fail(409, L('이미 보냈거나 그만둔 메일이에요.', 'This mail was already sent or dropped.'), 'closed')
  return { ok: true, card: m }
}
// POST /api/mail-out/:id/cancel — 그만두기
export async function cancelOut(user, id) {
  await cardOf(user, id)
  const m = await setState(user, id, 'cancelled', ['pending', 'kept'])
  if (!m) throw fail(409, L('이미 보냈거나 그만둔 메일이에요.', 'This mail was already sent or dropped.'), 'closed')
  return { ok: true, card: m }
}

// what the agent is told back (the tool's result): nothing has left — the person sends it from the card
export function toolResult(view) {
  const note = view.mode === 'connect'
    ? L('메일이 연결되어 있지 않아 보낼 수 없어요. 카드에 「연결하기」와 「초안으로 두기」가 있어요. 다른 도구로 보내지 말고, 메일을 연결하면 그 사람의 계정으로 보낼 수 있다고 짧게 알려 주세요.',
      "No mailbox is connected, so it can't be sent. The card offers Connect and Keep as draft. Don't send it with any other tool; say briefly that connecting their mail lets it go from their own account.")
    : view.mode === 'none'
      ? L('Gmail 이 보내기를 허락하지 않아 보낼 수 없어요. 카드에서 다시 연결하거나 초안으로 둘 수 있어요. 다른 도구로 보내지 마세요.',
        "Gmail hasn't allowed sending, so it can't be sent. The card lets them reconnect or keep it as a draft. Don't send it with any other tool.")
      : L(`보낼 메일 카드를 채팅에 띄웠어요. 아직 보내지 않았어요 — 사람이 카드에서 「${view.mode === 'drafts' ? '임시 보관함에 넣기' : '보내기'}」를 눌러야 그 사람의 메일(${view.from})에서 나가요. 답에는 보냈다고 쓰지 말고, 카드를 확인하고 눌러 달라고 짧게 적으세요.`,
        `The mail card is in the chat. Nothing has been sent — it leaves from the person's own mailbox (${view.from}) only when they press "${view.mode === 'drafts' ? 'Put in Drafts' : 'Send'}" on the card. Don't say it was sent; ask them briefly to check the card and press it.`)
  return {
    card: view.id, sent: false, mode: view.mode, from: view.from,
    thread: view.reply ? { continues: true, subject: view.reply.subject, from: view.reply.from } : { continues: false, ...(view.replyNotFound ? { mail_not_found: true } : {}) },
    to: view.to || null, ...(view.to ? {} : { needs_recipient: true }), subject: view.subject, files: view.files.map((f) => f.name),
    ...(view.missing.length ? { files_not_attached: view.missing.map((m) => ({ name: m.name, why: m.why })) } : {}),
    ...(view.answered ? { already_answered: true } : {}), note,
  }
}
