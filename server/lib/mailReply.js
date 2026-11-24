// Replying to a mail from its Home card: the mail as it arrived, a reply draft the person reads and
// changes, and the send — only when they press 보내기. A card's reply is never handed to the agent:
// on 2026-11-23 a 「Reply」 card gave the agent "reply to …" and the company's mail connector sent it
// within 30 seconds, to an address the card's instruction had wrong, before anyone saw a word.
//   originalOf  — the mail by its id: Gmail (raw → mailparser), IMAP (by uid), the demo mailbox
//   recipients  — whom a reply goes to, from the mail's own headers (Reply-To, From; a mail I sent: To)
//   draftReply  — the reply text, written by the model from the mail and the card (the person edits it)
//   sendReply   — Gmail: sent in the mail's thread; IMAP: put in the mailbox's Drafts (no SMTP here);
//                 demo: recorded only
import { simpleParser } from 'mailparser'
import MailComposer from 'nodemailer/lib/mail-composer'
import addressparser from 'nodemailer/lib/addressparser'
import { ImapFlow } from 'imapflow'
import { config } from '../config.js'
import { q, admin } from './supa.js'
import { chatJson } from './llm.js'
import { getSecret } from './vault.js'
import { emit } from './bus.js'
import { mainThread, addMessage } from './store.js'
import { L } from './lang.js'
import { googleAccessToken, demoMailById } from './mail.js'

const TEXT_MAX = 20000
const ATTACH_MAX = 20 * 1024 * 1024 // all files of one reply together
const fail = (status, message, code) => Object.assign(new Error(message), { status, ...(code && { code }) })

// ---------- addresses ----------
// "김하늘 <haneul@x.example>" or a list → [{name, address}] (RFC 5322 parsing, groups flattened)
export function addresses(v) {
  if (!v) return []
  if (Array.isArray(v)) return v.flatMap(addresses)
  if (typeof v === 'object') return v.value ? addresses(v.value) : v.group ? addresses(v.group) : v.address ? [{ name: v.name || '', address: v.address }] : []
  return addressparser(String(v), { flatten: true }).filter((a) => a.address).map((a) => ({ name: a.name || '', address: a.address }))
}
export const formatAddress = (a) => (a.name ? `${a.name} <${a.address}>` : a.address)
const same = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase()

// A reply goes where the mail asks replies to go (Reply-To), else to its sender. A mail I sent myself
// (a thread whose latest message is mine) is answered to the people it went to.
export function recipients(original, mine = []) {
  const isMine = (a) => mine.some((m) => same(m, a.address))
  const back = original.replyTo?.length ? original.replyTo : original.from ? [original.from] : []
  const to = back.length && back.every(isMine) ? (original.to || []).filter((a) => !isMine(a)) : back
  return { to, cc: [] }
}

// ---------- the mail as it arrived ----------
async function parsed(raw) {
  const p = await simpleParser(raw)
  const refs = p.references ? (Array.isArray(p.references) ? p.references : String(p.references).split(/\s+/)) : []
  return {
    from: addresses(p.from)[0] || null, to: addresses(p.to), cc: addresses(p.cc), replyTo: addresses(p.replyTo),
    subject: p.subject || '', date: p.date ? p.date.toISOString() : null,
    text: String(p.text || '').slice(0, TEXT_MAX),
    messageId: p.messageId || null, references: refs.filter(Boolean),
    attachments: (p.attachments || []).filter((a) => a.contentDisposition !== 'inline').map((a) => ({ name: a.filename || 'file', size: a.size || 0, type: a.contentType || '' })),
  }
}

async function gmail(userId, path, init = {}) {
  const at = await googleAccessToken(userId)
  const res = await fetch(`${init.upload ? config.google.gmailUploadUrl : config.google.gmailUrl}/users/me/${path}`, {
    method: init.method || 'GET', body: init.body,
    headers: { Authorization: `Bearer ${at}`, ...(init.type ? { 'Content-Type': init.type } : {}) },
  })
  const text = await res.text()
  if (!res.ok) {
    const why = (() => { try { return JSON.parse(text).error?.message } catch { return '' } })() || `HTTP ${res.status}`
    throw fail(res.status === 404 ? 404 : 502, L(`Gmail이 요청을 받지 않았어요 (${why}).`, `Gmail didn't accept the request (${why}).`), 'gmail_error')
  }
  return text ? JSON.parse(text) : {}
}

async function imapClient(userId) {
  const sec = await getSecret(userId, 'login', 'imap')
  if (!sec) throw fail(409, L('메일함 로그인 정보가 없어요. 설정에서 메일을 다시 연결해 주세요.', 'The mailbox sign-in is missing. Connect your mail again in Settings.'))
  const client = new ImapFlow({ host: sec.host, port: 993, secure: true, auth: { user: sec.username, pass: sec.password }, logger: false })
  await client.connect()
  return client
}

// the message as the mailbox keeps it (RFC 822 bytes): Gmail's raw, IMAP's source — or null (the demo mailbox keeps no message)
async function rawOf(userId, provider, mailId) {
  if (provider === 'gmail') {
    const m = await gmail(userId, `messages/${encodeURIComponent(mailId)}?format=raw`)
    return { raw: Buffer.from(m.raw || '', 'base64url'), threadId: m.threadId || null }
  }
  if (provider === 'imap') {
    const client = await imapClient(userId)
    let lock = null
    try {
      lock = await client.getMailboxLock('INBOX')
      const msg = await client.fetchOne(String(mailId), { source: true }, { uid: true })
      if (!msg?.source) throw fail(404, L('메일함에서 이 메일을 찾지 못했어요.', "This mail isn't in the mailbox any more."))
      return { raw: msg.source, threadId: null }
    } finally { lock?.release(); await client.logout().catch(() => {}) }
  }
  return null
}

export async function originalOf(userId, provider, mailId) {
  const got = await rawOf(userId, provider, mailId)
  if (got) return { id: mailId, threadId: got.threadId, ...(await parsed(got.raw)) }
  const m = await demoMailById(userId, mailId)
  if (!m) throw fail(404, L('메일함에서 이 메일을 찾지 못했어요.', "This mail isn't in the mailbox any more."))
  return { id: mailId, threadId: null, from: addresses(m.from)[0] || null, to: [], cc: [], replyTo: [], subject: m.subject || '', date: m.date || null,
    text: String(m.text || '').slice(0, TEXT_MAX), messageId: null, references: [], attachments: [] }
}

// The whole message, to keep (lib/mailWork.js — the work's folder): its RFC 822 bytes and what they say, the attachments with their
// content. A demo mailbox keeps no message: one is written from what it has (sender, to, subject, date, body), so the folder still
// gets an .eml any mail program opens.
export async function sourceOf(userId, provider, mailId, { to = '' } = {}) {
  let raw = (await rawOf(userId, provider, mailId))?.raw || null
  if (!raw) {
    const m = await demoMailById(userId, mailId)
    if (!m) throw fail(404, L('메일함에서 이 메일을 찾지 못했어요.', "This mail isn't in the mailbox any more."))
    raw = await new MailComposer({ from: m.from || '', ...(to ? { to } : {}), subject: m.subject || '', text: String(m.text || ''), date: m.date ? new Date(m.date) : new Date() }).compile().build()
  }
  const p = await simpleParser(raw)
  return {
    raw, from: addresses(p.from)[0] || null, to: addresses(p.to), cc: addresses(p.cc), subject: p.subject || '', date: p.date ? p.date.toISOString() : null,
    text: String(p.text || ''),
    // (the pictures inside the body stay in the .eml: the files are the ones sent along)
    attachments: (p.attachments || []).filter((a) => a.contentDisposition !== 'inline').map((a) => ({ name: a.filename || 'file', type: a.contentType || '', content: a.content })),
  }
}

// ---------- the card's mail, the files made for it ----------
// A card whose job is the reply: the triage's 「Reply」 verb, the card that came with the documents
// made for the mail (「… 초안 검토하고 회신하기」), or one the triage or the judge read as a reply
// (source.kind — lib/mailCard.js). Its reply is never handed to the agent (POST /run).
export const isReplyCard = (a) => !!a?.source?.mail_id && (a.verb === 'Reply' || !!a.source.drafts?.length || a.source.kind === 'reply')

async function cardOf(userId, actionId) {
  const [a] = await q('select * from pro_actions where id=$1 and user_id=$2', [actionId, userId])
  if (!a) throw fail(404, L('카드를 찾지 못했어요.', "This card couldn't be found."))
  if (!a.source?.mail_id) throw fail(400, L('메일에서 온 카드가 아니에요.', "This card didn't come from a mail."))
  return a
}
async function accountOf(userId) {
  const [acc] = await q('select provider, address from pro_mail_accounts where user_id=$1', [userId])
  if (!acc) throw fail(409, L('연결된 메일함이 없어요. 설정에서 메일을 연결해 주세요.', 'No mailbox is connected. Connect your mail in Settings.'))
  return acc
}

// the documents made for this mail (its draft cards), the newest card of each name — an edited copy
// replaces the card's url, so the latest edit is what goes
export async function filesFor(userId, mailId) {
  const rows = await q(`select m.id, m.content, m.created_at from pro_messages m join pro_threads t on t.id = m.thread_id
                        where t.user_id=$1 and m.kind='file' and m.content->>'mail_id' = $2 order by m.created_at desc`, [userId, String(mailId)])
  const seen = new Set()
  return rows.filter((r) => r.content?.url && r.content?.name && !seen.has(r.content.name) && seen.add(r.content.name))
    .map((r) => ({ messageId: r.id, name: r.content.name, url: r.content.url }))
}

// How a reply leaves: sent (Gmail with permission to send, the demo mailbox) or put in the mailbox's
// Drafts folder (IMAP — this server has no SMTP account). Each of these Gmail scopes may send.
const SEND_SCOPES = ['https://www.googleapis.com/auth/gmail.compose', 'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify', 'https://mail.google.com/']
export async function sendMode(userId, provider) {
  if (provider === 'imap') return 'drafts'
  if (provider !== 'gmail') return 'send'
  const granted = String((await getSecret(userId, 'oauth', 'google'))?.scope || '').split(' ')
  return granted.some((s) => SEND_SCOPES.includes(s)) ? 'send' : 'none'
}

// GET /actions/:id/mail
export async function mailOfCard(user, actionId) {
  const a = await cardOf(user.id, actionId)
  const acc = await accountOf(user.id)
  const original = await originalOf(user.id, acc.provider, a.source.mail_id)
  const files = await filesFor(user.id, a.source.mail_id)
  const back = recipients(original, [acc.address, user.email])
  return {
    provider: acc.provider, mode: await sendMode(user.id, acc.provider), files,
    mail: { from: original.from, to: original.to, cc: original.cc, date: original.date, subject: original.subject, text: original.text, attachments: original.attachments },
    reply: a.source.reply || null, sent: a.source.sent || null,
    to: back.to.map(formatAddress).join(', '),
  }
}

// ---------- the draft ----------
const DRAFT = `You write the reply e-mail a person will read, correct and then send themselves.
Input: the person (name, address), the to-do card made from the mail (what they mean to do), the mail
itself, and the names of the files that will be attached.
Return JSON {"subject","body"}.
- body: the reply text only, plain text without markdown: a greeting, what the card says to answer, a
  closing with the person's name. Write as the person, in the language of the mail.
- Say only what the card and the mail support. Where the reply needs something they don't give (a date,
  an amount, a name, a file that is not attached), leave a bracketed blank such as [일정] for the person
  to fill in, and never write that something was done or attached when it was not.
- Mention the attached files by name when there are any.
- subject: the reply's subject line for the mail's thread.`

export async function draftReply(user, actionId) {
  const a = await cardOf(user.id, actionId)
  const acc = await accountOf(user.id)
  const original = await originalOf(user.id, acc.provider, a.source.mail_id)
  const files = await filesFor(user.id, a.source.mail_id)
  const [p] = await q('select name, email from pro_profile where user_id=$1', [user.id])
  const r = await chatJson(DRAFT, JSON.stringify({
    me: { name: p?.name || user.name || '', address: acc.address || user.email },
    card: { verb: a.verb, text: a.text, plan: a.prompt || '' },
    mail: { from: original.from && formatAddress(original.from), to: original.to.map(formatAddress), date: original.date, subject: original.subject, text: original.text.slice(0, 8000) },
    attachments: files.map((f) => f.name),
  }))
  const body = String(r?.body || '').trim()
  if (!body) throw fail(502, L('답장 초안을 쓰지 못했어요. 잠시 후 다시 시도해 주세요.', "Couldn't write the reply draft. Please try again in a moment."))
  const back = recipients(original, [acc.address, user.email])
  const reply = { to: back.to.map(formatAddress).join(', '), cc: '', subject: String(r.subject || '').trim() || original.subject, body, at: new Date().toISOString() }
  const [row] = await q(`update pro_actions set source = source || jsonb_build_object('reply', $2::jsonb) where id=$1 returning *`, [a.id, reply])
  emit(user.id, 'action', row)
  return { reply, files }
}

// ---------- sending ----------
// files: {messageId} — a document card made for this mail; {key, name} — a file the person added
// (POST /attachments: their own storage folder). Both are read from this server's own storage by key:
// a card's address only names the object (another service may write the same storage's host its own
// way), and no other address is ever fetched.
// (a key is a path inside the files bucket: one with an empty, "." or ".." segment or a backslash
// could reach another person's object or another bucket through the service key, and is refused)
export const safeKey = (k) => {
  const key = String(k || '')
  return !!key && !key.includes('\\') && key.split('/').every((seg) => seg && seg !== '.' && seg !== '..')
}
export const storageKey = (url) => {
  try {
    const m = /^\/storage\/v1\/object\/(?:public\/|authenticated\/)?files\/(.+)$/.exec(new URL(url).pathname)
    const key = m ? decodeURIComponent(m[1]) : null
    return key && safeKey(key) ? key : null
  } catch { return null }
}
// a file the person added in the sheet: POST /attachments named it pgpt-pro/<their id>/att/<uuid>.<ext>
export const ownUpload = (userId, k) => safeKey(k) && new RegExp(`^pgpt-pro/${userId}/att/[0-9a-f-]{36}\\.[a-z0-9]+$`).test(String(k))
async function download(key, name) {
  const { data, error } = await admin.storage.from('files').download(key)
  if (error) throw fail(502, L(`${name || '파일'}을 가져오지 못했어요.`, `Couldn't fetch ${name || 'the file'}.`))
  return { buf: Buffer.from(await data.arrayBuffer()), type: data.type || undefined }
}
async function attachmentsOf(user, mailId, files = []) {
  const made = await filesFor(user.id, mailId)
  const out = []
  let total = 0
  if (files.length > 10) throw fail(400, L('파일은 10개까지 첨부할 수 있어요.', 'Up to 10 files can be attached.'))
  for (const f of files) {
    let got, name
    if (f?.messageId) {
      const card = made.find((m) => m.messageId === f.messageId)
      const key = card && storageKey(card.url)
      if (!key) throw fail(400, L('이 메일의 초안 파일만 첨부할 수 있어요.', "Only this mail's draft files can be attached."))
      name = card.name; got = await download(key, name)
    } else if (f?.key) {
      if (!ownUpload(user.id, f.key)) throw fail(400, L('첨부할 수 없는 파일이에요.', "That file can't be attached."))
      name = String(f.name || 'file').slice(0, 200); got = await download(f.key, name)
    } else continue
    total += got.buf.length
    if (total > ATTACH_MAX) throw fail(413, L('첨부 파일이 모두 20MB를 넘어요.', 'The attachments are over 20 MB together.'))
    out.push({ filename: name, content: got.buf, ...(got.type ? { contentType: got.type } : {}) })
  }
  return out
}

export async function buildReply({ from, to, cc, subject, body, original, attachments = [] }) {
  const refs = [...(original?.references || []), original?.messageId].filter(Boolean)
  return new MailComposer({
    from, to, ...(cc?.length ? { cc } : {}), subject, text: body,
    ...(original?.messageId ? { inReplyTo: original.messageId, references: refs } : {}),
    attachments,
  }).compile().build()
}

async function gmailSend(userId, raw, threadId) {
  const b = `pgpt${Date.now().toString(36)}`
  const body = Buffer.concat([
    Buffer.from(`--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(threadId ? { threadId } : {})}\r\n--${b}\r\nContent-Type: message/rfc822\r\n\r\n`),
    raw, Buffer.from(`\r\n--${b}--`),
  ])
  return gmail(userId, 'messages/send?uploadType=multipart', { method: 'POST', upload: true, type: `multipart/related; boundary=${b}`, body })
}

async function imapDraft(userId, raw) {
  const client = await imapClient(userId)
  try {
    const box = (await client.list()).find((b) => b.specialUse === '\\Drafts')
    if (!box) throw fail(409, L('메일함에서 임시 보관함을 찾지 못했어요.', "The mailbox has no Drafts folder."))
    await client.append(box.path, raw, ['\\Draft', '\\Seen'])
  } finally { await client.logout().catch(() => {}) }
}

// POST /actions/:id/reply {to, cc, subject, body, files}
export async function sendReply(user, actionId, input = {}) {
  const a = await cardOf(user.id, actionId)
  if (a.source.sent) throw fail(409, L('이 메일에는 이미 답장을 보냈어요.', 'A reply to this mail was already sent.'))
  const acc = await accountOf(user.id)
  const mode = await sendMode(user.id, acc.provider)
  if (mode === 'none') throw fail(403, L('Gmail에서 메일 보내기를 허락받지 않았어요. 설정에서 메일을 다시 연결해 주세요.', "Gmail hasn't allowed sending. Connect your mail again in Settings."), 'gmail_scope')
  const to = addresses(String(input.to || '')), cc = addresses(String(input.cc || ''))
  const subject = String(input.subject || '').trim().slice(0, 300), body = String(input.body || '').trim()
  if (!to.length) throw fail(400, L('받는 사람을 적어 주세요.', 'Add who the reply goes to.'))
  if (!body) throw fail(400, L('보낼 내용을 적어 주세요.', 'Write what the reply says.'))
  const original = await originalOf(user.id, acc.provider, a.source.mail_id)
  const attachments = await attachmentsOf(user, a.source.mail_id, Array.isArray(input.files) ? input.files : [])
  const [p] = await q('select name from pro_profile where user_id=$1', [user.id])
  const raw = await buildReply({ from: { name: p?.name || user.name || '', address: acc.address || user.email }, to, cc, subject: subject || original.subject, body, original, attachments })
  // one send per card, even when two presses arrive together: the card is claimed before anything leaves.
  // The claim is lifted only when the send itself failed — a send that went out but could not be
  // recorded (or a server that stopped half way) keeps it, so a second press never mails it twice.
  const [claimed] = await q(`update pro_actions set source = source || jsonb_build_object('sending', now()) where id=$1 and user_id=$2
                             and not (source ? 'sent') and not (source ? 'sending') returning id`, [a.id, user.id])
  if (!claimed) throw fail(409, L('이 메일의 답장은 이미 보내는 중이거나 보냈어요. 메일함의 보낸 편지함을 확인해 주세요.', 'The reply to this mail is already being sent or was sent. Check the Sent folder of your mailbox.'))
  try {
    if (mode === 'drafts') await imapDraft(user.id, raw)
    else if (acc.provider === 'gmail') await gmailSend(user.id, raw, original.threadId)
  } catch (e) {
    await q(`update pro_actions set source = source - 'sending' where id=$1`, [a.id]).catch(() => {})
    throw e
  }
  const sent = { to: to.map(formatAddress).join(', '), cc: cc.map(formatAddress).join(', '), subject: subject || original.subject, files: attachments.map((x) => x.filename), via: mode === 'drafts' ? 'drafts' : acc.provider, at: new Date().toISOString() }
  // (recorded with a few tries: the mail has left, and the card must say so)
  let row
  for (let i = 0; !row; i++) {
    try {
      ;[row] = await q(`update pro_actions set status='done', source = (source - 'sending') || jsonb_build_object('sent', $2::jsonb, 'reply', $3::jsonb) where id=$1 returning *`,
        [a.id, sent, { to: sent.to, cc: sent.cc, subject: sent.subject, body, at: sent.at }])
    } catch (e) {
      if (i >= 2) { console.warn('[mail reply] sent but not recorded', a.id, e.message); throw fail(500, L('답장은 보냈지만 기록하지 못했어요. 다시 보내지 말고 메일함의 보낸 편지함을 확인해 주세요.', "The reply was sent but couldn't be recorded. Don't send it again — check the Sent folder of your mailbox.")) }
      await new Promise((ok) => setTimeout(ok, 500 * (i + 1)))
    }
  }
  emit(user.id, 'action', row)
  const who = to.map((x) => x.name || x.address).join(', ')
  // the reply is said where the mail's work is: the instance it belongs to (its conversation — lib/mailFlow.js, 2026-11-18: an instance's
  // work stays on its page), else the main chat; either way with the mail's chip, which opens this card again
  const inst = row.source?.inst?.instId ? row.source.inst : null
  const { instanceThread } = await import('./engine.js')
  const where = inst ? await instanceThread(user.id, inst.instId, inst.name) : (await mainThread(user.id)).id
  await addMessage(user.id, where, 'agent', 'text', {
    text: mode === 'drafts'
      ? L(`${who}에게 보낼 답장 「${sent.subject}」을 메일함의 임시 보관함에 넣었어요. 메일 앱에서 보내 주세요.`, `I put the reply "${sent.subject}" to ${who} in your mailbox's Drafts. Send it from your mail app.`)
      : sent.via === 'demo'
        ? L(`데모 메일함이라 ${who}에게 보낼 답장 「${sent.subject}」을 실제로 보내지 않고 기록만 했어요.`, `This is the demo mailbox, so the reply "${sent.subject}" to ${who} was recorded, not sent.`)
        : L(`${who}에게 답장 「${sent.subject}」을 보냈어요.`, `I sent the reply "${sent.subject}" to ${who}.`),
    sent_mail: { to: sent.to, subject: sent.subject, via: sent.via, files: sent.files },
    mail: { from: a.source.from || '', subject: a.source.subject || '', actionId: a.id, mailId: a.source.mail_id, ...(inst ? { inst: { instId: inst.instId, name: inst.name || '' } } : {}) },
    ...(inst ? { mailEvent: 'reply' } : {}),
  })
  // replying to the customer closes the mail's case, if it has one (lib/mining)
  import('./mining/recorder.js').then((m) => m.recordReply(user, a)).catch((e) => console.warn('[mining] reply', e.message))
  return { ok: true, sent, action: row, ...(inst ? { inst: { instId: inst.instId, name: inst.name || '' } } : {}) }
}
