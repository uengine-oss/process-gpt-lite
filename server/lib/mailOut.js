// A mail the agent writes for the person — 「내 계정으로 보내기」 (mcp/mail.js send_mail_as_me). The agent never sends it:
// it becomes a 「보낼 메일」 card in the chat (pro_messages kind 'mail_out') with who it goes out as, to whom, its subject,
// whether it continues the mail it answers, its body and its files — and it leaves only when the person presses 보내기,
// from the mailbox THEY connected (lib/mailReply.js): Gmail sends it, in the thread it answers (threadId, In-Reply-To,
// References); IMAP puts it in that mailbox's Drafts; the demo mailbox records it.
// 2026-11-27 (production, a recording): asked in the chat 「이렇게 보내」, the agent sent a customer's reply itself through the
// company's mail tool (a tenant MCP send_email) — from the company's shared sending address, not the person's, and as a new
// mail instead of a reply in the customer's thread. Lite's turns no longer get that tool (config.agent.hiddenTools →
// deepagents metadata.hidden_tools); this is the tool they get instead.
//   senderOf      — who the mail goes out as now: the person's connected mailbox and how it leaves (send · drafts · none · connect)
//   findOriginal  — the mail it answers, in the person's own mailbox (by its id, else by subject among the mails with the recipient)
//   propose       — the card, in the chat of the agent turn that asked (nothing leaves)
//   cardView      — what the card shows now (GET /api/mail-out/:id): the sender is read again, never taken from the card
//   sendOut       — 보내기: once, claimed first; the From is the connected mailbox's address, whatever the card says
//   keepOut · reopenOut · cancelOut — 초안으로 두기 · 다시 열기 · 그만두기
import { q } from './supa.js'
import { emit } from './bus.js'
import { getThread } from './store.js'
import { L } from './lang.js'
import * as turns from './turns.js'
import { addresses, formatAddress, recipients, originalOf, sendMode, buildReply, gmail, gmailSend, imapDraft, imapClient, parsed, storageKey, download } from './mailReply.js'

const BODY_MAX = 20000
const FILES_MAX = 10
const ATTACH_MAX = 20 * 1024 * 1024
const fail = (status, message, code) => Object.assign(new Error(message), { status, ...(code && { code }) })
const clean = (s, n = 300) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n)
const list = (v) => (Array.isArray(v) ? v : v ? [v] : []).map((x) => String(x || '').trim()).filter(Boolean)
const asAddresses = (v) => addresses(list(v).join(', '))

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
const replyOf = (o) => (o ? { mailId: String(o.id), threadId: o.threadId || null, subject: o.subject || '', from: o.from ? formatAddress(o.from) : '', date: o.date || null } : null)
// the newest mail in this person's own mailbox with that subject, exchanged with one of these people
async function bySubject(user, provider, base, people) {
  if (!base) return null
  const matches = (o) => o && baseSubject(o.subject) === base
    && (!people.length || [o.from, ...(o.to || []), ...(o.cc || []), ...(o.replyTo || [])].some((a) => a && people.some((x) => x.toLowerCase() === String(a.address).toLowerCase())))
  if (provider === 'gmail') {
    const who = people.length ? ` {${people.map((a) => `from:${a} to:${a}`).join(' ')}}` : ''
    const qs = `subject:"${base.replace(/["\\]/g, ' ')}"${who} -in:drafts`
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
// → the original as lib/mailReply.js reads it, or null (not found, not this person's, no mailbox)
export async function findOriginal(user, sender, { mailId = null, subject = '', people = [] } = {}) {
  if (!sender?.provider) return null
  if (mailId) {
    // (an id from a Home card: the card's mail — only a card of this person's)
    const [card] = /^[0-9a-f-]{36}$/i.test(String(mailId)) ? await q(`select source from pro_actions where id=$1 and user_id=$2`, [String(mailId), user.id]).catch(() => []) : []
    const id = card?.source?.mail_id ? String(card.source.mail_id) : String(mailId)
    const o = await originalOf(user.id, sender.provider, id).catch(() => null)
    if (o) return o
  }
  return bySubject(user, sender.provider, baseSubject(subject), people).catch((e) => { console.warn('[mail out] thread', e.code || e.message); return null })
}

// ---------- the files ----------
// a file named by the agent: a file card of this chat (a document it made, a file someone put here) with that name, the newest
async function filesOf(threadId, names) {
  const want = list(names).slice(0, FILES_MAX)
  if (!want.length) return { files: [], missing: [] }
  const rows = await q(`select id, content from pro_messages where thread_id=$1 and kind='file' order by created_at desc limit 200`, [threadId])
  const files = [], missing = []
  for (const n of want) {
    const base = n.split('/').pop()
    const hit = rows.find((r) => r.content?.name === base && storageKey(r.content?.url || ''))
    if (hit && !files.some((f) => f.messageId === hit.id)) files.push({ messageId: hit.id, name: base })
    else if (!hit) missing.push(base)
  }
  return { files, missing }
}
async function attachments(threadId, files) {
  const out = []
  let total = 0
  for (const f of files || []) {
    const [row] = await q(`select content from pro_messages where id=$1 and thread_id=$2 and kind='file'`, [f.messageId, threadId])
    const key = row && storageKey(row.content?.url || '')
    if (!key) throw fail(409, L(`첨부할 파일 「${f.name}」을 찾지 못했어요.`, `Couldn't find the file "${f.name}" to attach.`), 'file_missing')
    const got = await download(key, f.name)
    total += got.buf.length
    if (total > ATTACH_MAX) throw fail(413, L('첨부 파일이 모두 20MB를 넘어요.', 'The attachments are over 20 MB together.'))
    out.push({ filename: f.name, content: got.buf, ...(got.type ? { contentType: got.type } : {}) })
  }
  return out
}

// ---------- the card ----------
// the agent turn that is calling (the MCP call carries only the person's token): theirs, running now — the newest when several.
// A chat's agent turns are in lib/turns.js; an agent run that is not one (a skill on a schedule — lib/missions.js) is registered here
// for as long as it runs, with the chat it reports to.
const runs = new Map() // id → {id, userId, threadId, conv}
let runSeq = 0
export async function asAgentRun({ userId, threadId, conv = null }, fn) {
  const id = `run-${++runSeq}`
  runs.set(id, { id, userId, threadId, conv })
  try { return await fn() } finally { runs.delete(id) }
}
export function callingTurn(userId) {
  const live = turns.agentTurnsOf(userId)
  if (live.length) return live[live.length - 1]
  const other = [...runs.values()].filter((r) => r.userId === userId)
  return other.length ? other[other.length - 1] : null
}

// input: {to, cc, subject, body, reply_to: {mail_id, subject}, attachments} (the tool's arguments) → {card, view}
export async function propose(user, input = {}, { turn = callingTurn(user.id) } = {}) {
  if (!turn) throw fail(409, L('보낼 메일 카드는 Process GPT Lite 채팅의 에이전트 작업에서만 띄울 수 있어요. 사람에게 초안을 보여 주고 직접 보내게 하세요.',
    'The mail card can only be shown from an agent task in a Process GPT Lite chat. Show the person the draft and let them send it themselves.'), 'no_turn')
  const body = String(input.body || '').trim().slice(0, BODY_MAX)
  if (!body) throw fail(400, L('보낼 본문이 없어요.', 'There is no body to send.'))
  const subject = clean(input.subject, 300)
  const sender = await senderOf(user)
  const people = asAddresses(input.to).map((a) => a.address)
  const rt = input.reply_to && typeof input.reply_to === 'object' ? input.reply_to : {}
  const original = await findOriginal(user, sender, { mailId: rt.mail_id ? String(rt.mail_id) : null, subject: rt.subject || subject, people })
  // whom: what the agent wrote; a reply with no one named goes where the mail asks replies to go (its headers — lib/mailReply.js)
  let to = asAddresses(input.to)
  if (!to.length && original) to = recipients(original, [sender.address, user.email].filter(Boolean)).to
  const cc = asAddresses(input.cc)
  const thread = await getThread(user.id, turn.threadId)
  if (!thread) throw fail(404, L('대화를 찾지 못했어요.', "Couldn't find the conversation."))
  const { files, missing } = await filesOf(turn.threadId, input.attachments)
  const out = {
    to: to.map(formatAddress).join(', '), cc: cc.map(formatAddress).join(', '),
    subject: subject || (original ? `Re: ${baseSubject(original.subject)}` : ''), body,
    reply: replyOf(original), files, missing,
    // (who it would go out as when it was proposed — shown again from the mailbox when the card is read, and used only from there)
    from: sender.address ? formatAddress({ name: sender.name, address: sender.address }) : null,
    state: 'pending', at: new Date().toISOString(),
  }
  const conv = turn.conv && !String(turn.conv).startsWith('none:') ? String(turn.conv) : null
  const tag = conv ? (thread.kind === 'chat' ? { context: { conversationId: conv, action: 'aside' }, conv } : { conv }) : {}
  const [card] = await q(`insert into pro_messages(thread_id, role, kind, content) values ($1,'agent','mail_out',$2) returning *`,
    [turn.threadId, { text: L(`보낼 메일 · ${out.subject}`, `Mail to send · ${out.subject}`), mail_out: out, owner: user.id, turn: turn.id, ...tag }])
  await q('update pro_threads set updated_at=now() where id=$1', [turn.threadId])
  emit(user.id, 'message', card)
  // the same mail written again (a correction, 「…로 고쳐서」): the earlier card of it still waiting in this chat is that draft's, now replaced —
  // one card to press, never two versions of the same mail
  const waiting = await q(`select id, content from pro_messages where thread_id=$1 and kind='mail_out' and id<>$2 and content->>'owner'=$3
                           and content->'mail_out'->>'state' = 'pending' and created_at > now() - interval '2 days'`, [turn.threadId, card.id, user.id])
  for (const w of waiting) {
    if (baseSubject(w.content?.mail_out?.subject) === baseSubject(out.subject)) await setState(user, w.id, 'replaced', ['pending']).catch(() => {})
  }
  console.log(`[mail out] card ${card.id.slice(0, 8)} user=${user.id.slice(0, 8)} mode=${sender.mode} reply=${original ? 'thread' : 'new'} files=${files.length}${missing.length ? ` missing=${missing.length}` : ''}`)
  return { card, view: viewOf(card, sender) }
}

async function cardOf(user, id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) throw fail(404, L('메일 카드를 찾지 못했어요.', "Couldn't find the mail card."))
  const [m] = await q(`select m.* from pro_messages m join pro_threads t on t.id=m.thread_id where m.id=$1 and m.kind='mail_out'`, [String(id)])
  // (a card in a room shared with others is still only its writer's to send: the turn that proposed it was theirs)
  if (!m || m.content?.owner !== user.id) throw fail(404, L('메일 카드를 찾지 못했어요.', "Couldn't find the mail card."))
  return m
}
function viewOf(card, sender) {
  const out = card.content.mail_out || {}
  return {
    id: card.id, state: out.state, mode: sender.mode, provider: sender.provider,
    from: sender.address ? formatAddress({ name: sender.name, address: sender.address }) : null,
    to: out.to, cc: out.cc, subject: out.subject, body: out.body, reply: out.reply || null,
    files: (out.files || []).map((f) => f.name), missing: out.missing || [], sent: out.sent || null,
  }
}
// GET /api/mail-out/:id
export async function cardView(user, id) {
  const card = await cardOf(user, id)
  return viewOf(card, await senderOf(user))
}

async function setState(user, id, state, from, extra = {}) {
  const [m] = await q(`update pro_messages set content = jsonb_set(content, '{mail_out}', (content->'mail_out') || $3::jsonb)
                       where id=$1 and kind='mail_out' and content->>'owner'=$4 and content->'mail_out'->>'state' = any($2::text[]) returning *`,
  [id, from, JSON.stringify({ state, ...extra }), user.id])
  if (m) emit(user.id, 'message', m)
  return m
}

// POST /api/mail-out/:id/send {to, cc, subject, body} — 보내기 (IMAP: 임시 보관함에 넣기)
export async function sendOut(user, id, input = {}) {
  const card = await cardOf(user, id)
  const out = card.content.mail_out || {}
  if (['sent', 'drafted', 'sending'].includes(out.state)) throw fail(409, L('이 메일은 이미 보냈거나 보내는 중이에요. 보낸 편지함을 확인해 주세요.', 'This mail was already sent or is being sent. Check your Sent folder.'), 'already')
  if (!['pending', 'kept'].includes(out.state)) throw fail(409, L('보내기를 그만둔 메일이에요. 보내려면 채팅에서 다시 부탁해 주세요.', 'This mail was dropped. Ask again in the chat to send it.'), 'closed')
  const sender = await senderOf(user)
  if (sender.mode === 'connect') throw fail(409, L('메일을 연결하면 내 계정으로 보낼 수 있어요.', 'Connect your mail to send it from your own account.'), 'mail_not_connected')
  if (sender.mode === 'none') throw fail(403, L('Gmail의 메일 전송 권한이 없어요. 메일을 다시 연결해 주세요.', "Gmail hasn't allowed sending. Connect your mail again."), 'gmail_scope')
  const pick = (k) => (input[k] != null ? String(input[k]) : String(out[k] || ''))
  const to = addresses(pick('to')), cc = addresses(pick('cc'))
  const subject = clean(pick('subject'), 300), body = pick('body').trim().slice(0, BODY_MAX)
  if (!to.length) throw fail(400, L('받는 사람을 적어 주세요.', 'Add who the mail goes to.'))
  if (!body) throw fail(400, L('보낼 내용을 적어 주세요.', 'Write what the mail says.'))
  // the mail it answers, read again from this mailbox (a card made with another mailbox connected answers nothing here)
  const original = out.reply?.mailId ? await originalOf(user.id, sender.provider, out.reply.mailId).catch(() => null) : null
  const files = await attachments(card.thread_id, out.files)
  const from = { name: sender.name, address: sender.address }
  const raw = await buildReply({ from, to, cc, subject: subject || (original ? `Re: ${baseSubject(original.subject)}` : ''), body, original, attachments: files })
  // one send per card, even when two presses arrive together: the card is claimed before anything leaves; the claim is lifted only
  // when the send itself failed (lib/mailReply.js sendReply does the same)
  const claimed = await setState(user, card.id, 'sending', ['pending', 'kept'])
  if (!claimed) throw fail(409, L('이 메일은 이미 보냈거나 보내는 중이에요. 보낸 편지함을 확인해 주세요.', 'This mail was already sent or is being sent. Check your Sent folder.'), 'already')
  let res = null
  try {
    if (sender.mode === 'drafts') await imapDraft(user.id, raw)
    else if (sender.provider === 'gmail') res = await gmailSend(user.id, raw, original?.threadId || null)
  } catch (e) {
    await setState(user, card.id, out.state, ['sending']).catch(() => {})
    throw e
  }
  const via = sender.mode === 'drafts' ? 'drafts' : sender.provider
  const sent = { from: formatAddress(from), to: to.map(formatAddress).join(', '), cc: cc.map(formatAddress).join(', '), subject: subject || out.subject,
    files: files.map((f) => f.filename), via, thread: !!original, ...(res?.threadId ? { threadId: String(res.threadId) } : {}), at: new Date().toISOString() }
  const m = await setState(user, card.id, via === 'drafts' ? 'drafted' : 'sent', ['sending'], { sent, to: sent.to, cc: sent.cc, subject: sent.subject, body })
  // the mail's Home card (if it made one) is answered now — its sheet must not offer the same reply again
  if (original) {
    await q(`update pro_actions set status='done', source = source || jsonb_build_object('sent', $3::jsonb) where user_id=$1 and source->>'mail_id'=$2 and not (source ? 'sent')`,
      [user.id, String(original.id), { to: sent.to, cc: sent.cc, subject: sent.subject, files: sent.files, via, at: sent.at, from: 'chat' }]).catch((e) => console.warn('[mail out] card', e.message))
  }
  console.log(`[mail out] ${via} card=${card.id.slice(0, 8)} user=${user.id.slice(0, 8)} thread=${original ? 'yes' : 'no'} files=${files.length}`)
  return { ok: true, sent, card: m }
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
    thread: view.reply ? { continues: true, subject: view.reply.subject, from: view.reply.from } : { continues: false },
    to: view.to, subject: view.subject, files: view.files, ...(view.missing.length ? { files_not_found: view.missing } : {}), note,
  }
}

