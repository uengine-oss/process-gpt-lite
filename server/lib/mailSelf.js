// Whose mail it is. The mail intake (lib/mail.js pollUser) makes Home cards of what new mail asks the person to do — a mail the person
// sent asks them nothing. Gmail's list leaves the Sent folder out (-in:sent), yet a mail of theirs still comes in: a copy sent from another
// address of theirs (their Lite · company address with the connected Gmail in Cc or Bcc, a send-as alias, a group that sends members their
// own posts) carries no SENT label. 2026-11-26 (production, phone Home): the person's own mail to a customer, an activity report attached,
// came back as a 「답장」 card (reply to themselves) and a 「검토」 card (review their own attachment) — 「이 메일은 내가 보낸건데 왜 내가
// 받은걸로 뜨는건가.」
//
// Who the person is, by structure only — never by reading the words: the Gmail SENT label, and the sender's address against the person's
// addresses. Their own addresses: the connected mailbox (its primary send-as address), the Lite · Process GPT account's e-mail. Their
// aliases: the other addresses Gmail lets the account send as and treats as aliases (readable with gmail.readonly, no new scope) — a
// shared group address a colleague also sends as, or that a customer's post reaches rewritten as "Customer via Sales" <sales@…>, is not
// proof enough on its own. Without the SENT label a mail counts as theirs only when it went to someone besides them (a note to self, or a
// rule that forwards company mail with the person's address put in From, is still mail to read). A sender with the person's name at an
// address Lite does not know of is not taken for them: someone else may have the same name.
//
// A thread: the person's own reply to the sender after a mail — that mail is not waiting for their reply (answeredOf).
import { config } from '../config.js'
import { q } from './supa.js'

const TIMEOUT_MS = 10_000

// the address of a From header — '"홍길동" <Gil@Hong.example>' → 'gil@hong.example' — or '' when there is none
export function addrOf(header) {
  const s = String(header || '').trim()
  const a = (/<([^<>]+)>\s*$/.exec(s)?.[1] ?? s).trim().toLowerCase()
  return /^[^\s@<>]+@[^\s@<>]+$/.test(a) ? a : ''
}

// every address of an address list header (To, Cc, Reply-To) — commas inside quoted names or <…> do not split it; an array is a list
export function addrsOf(list) {
  if (Array.isArray(list)) return list.flatMap(addrsOf)
  const s = String(list || ''), parts = []
  let cur = '', quoted = false, angle = false
  for (const ch of s) {
    if (ch === '"' && !angle) quoted = !quoted
    else if (ch === '<' && !quoted) angle = true
    else if (ch === '>' && !quoted) angle = false
    if (ch === ',' && !quoted && !angle) { parts.push(cur); cur = '' } else cur += ch
  }
  parts.push(cur)
  return parts.map(addrOf).filter(Boolean)
}

// The person's addresses: own (the connected mailbox and its primary address, the Lite · Process GPT e-mail) and aliases (other send-as
// addresses Gmail treats as aliases). has(a): either.
export function addressBook(own = [], aliases = []) {
  const o = new Set(own.map(addrOf).filter(Boolean))
  const al = new Set(aliases.map(addrOf).filter((a) => a && !o.has(a)))
  return { own: o, aliases: al, has: (a) => o.has(a) || al.has(a) }
}
// (a plain Set of addresses — tests — is all own addresses)
const bookOf = (me) => (me instanceof Set ? addressBook([...me]) : me || addressBook())

// a header of a mail as the intake reads it ({from, to, cc, replyTo, xOriginalSender, labels}) or as Gmail gives it ({labelIds, payload.headers})
const FIELDS = { from: 'from', to: 'to', cc: 'cc', replyTo: 'reply-to', xOriginalSender: 'x-original-sender' }
const field = (m, k) => m?.[k] ?? (m?.payload?.headers || []).find((h) => String(h.name).toLowerCase() === FIELDS[k])?.value ?? ''
const labelsOf = (m) => m?.labels || m?.labelIds || []

// Sent by the person: Gmail filed it as sent; or (no SENT label) its sender is one of the person's addresses, it went to someone besides
// them, and — when the sender is only an alias of theirs — no Reply-To / X-Original-Sender names someone else.
export function isOwn(mail, me) {
  if (labelsOf(mail).includes('SENT')) return true
  const book = bookOf(me)
  const a = addrOf(field(mail, 'from'))
  if (!a || !book.has(a)) return false
  if (!addrsOf([field(mail, 'to'), field(mail, 'cc')]).some((r) => !book.has(r))) return false
  if (!book.own.has(a) && addrsOf([field(mail, 'replyTo'), field(mail, 'xOriginalSender')]).some((r) => !book.has(r))) return false
  return true
}

// ---------- the person's addresses ----------
const SEND_AS_MS = 60 * 60 * 1000
const sendAsSeen = new Map() // `${userId}|${account}` → { at, own, aliases }

// The addresses Gmail lets the connected account send as: { own: [the primary], aliases: [the others it treats as aliases] }, lower case —
// empty when Gmail does not answer (an older grant, the API off): the other addresses still count. An address still waiting for its
// verification mail, or one Gmail does not treat as an alias (a group or another person's mailbox sent "on behalf of"), is left out.
// Kept an hour per person and mailbox: they change rarely.
export async function gmailSendAs(userId, token, { api = gmailBase(), account = '', fresh = false } = {}) {
  const key = `${userId}|${String(account).toLowerCase()}`
  const hit = sendAsSeen.get(key)
  if (!fresh && hit && Date.now() - hit.at < SEND_AS_MS) return hit
  const none = { own: [], aliases: [] }
  try {
    const r = await fetch(`${api}/settings/sendAs`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!r.ok) return none
    const j = await r.json().catch(() => ({}))
    const kept = (j.sendAs || []).filter((x) => x?.sendAsEmail && x.verificationStatus !== 'pending' && (x.isPrimary || x.treatAsAlias !== false))
    const low = (x) => String(x.sendAsEmail).trim().toLowerCase()
    const got = { at: Date.now(), own: kept.filter((x) => x.isPrimary).map(low), aliases: kept.filter((x) => !x.isPrimary).map(low) }
    sendAsSeen.set(key, got)
    return got
  } catch { return none }
}
const gmailBase = () => process.env.PRO_GMAIL_API || `${config.google.gmailUrl}/users/me`

// Every address of the person's: the connected mailbox's (acc.address — the Google account the connection was made with for Gmail, the
// login for IMAP, the Lite address for the demo mailbox), Gmail's send-as addresses (token: the Gmail access token), and the person's
// Lite · Process GPT e-mail.
export async function myAddresses(userId, acc = null, { token = null, api } = {}) {
  const own = [acc?.address]
  for (const r of await q('select email from pro_profile where user_id=$1', [userId]).catch(() => [])) own.push(r.email)
  // (process-gpt's users: one row per company the person is in)
  for (const r of await q('select email from users where id=$1', [userId]).catch(() => [])) own.push(r.email)
  let aliases = []
  if (acc?.provider === 'gmail' && token) {
    const s = await gmailSendAs(userId, token, { api, account: acc.address })
    own.push(...s.own)
    aliases = s.aliases
  }
  return addressBook(own, aliases)
}

// ---------- threads ----------
// Labels of a mail that was not (or not yet) sent to anyone: a draft, a scheduled send, one in spam or the trash.
const NOT_SENT = ['DRAFT', 'SCHEDULED', 'SPAM', 'TRASH']

// The mails (Gmail) whose thread holds a later mail of the person's to that mail's sender — they have answered it already — as a Set of
// mail ids. A forward to a colleague, a draft, a scheduled send, spam or trash is not an answer. One thread read per thread (metadata only:
// labels, From, To, Cc); a thread that cannot be read leaves its mails as they were.
export async function answeredOf(mails, me, token, { api = gmailBase() } = {}) {
  const answered = new Set()
  const byThread = new Map()
  for (const m of mails) if (m.thread) byThread.set(m.thread, [...(byThread.get(m.thread) || []), m])
  for (const [thread, ms] of byThread) {
    let t
    try {
      const r = await fetch(`${api}/threads/${encodeURIComponent(thread)}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc`,
        { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(TIMEOUT_MS) })
      if (!r.ok) continue
      t = await r.json()
    } catch { continue }
    // (Gmail gives a thread's mails oldest first; the time each arrived decides, then that order)
    const all = (t.messages || []).map((x, i) => ({ x, i, at: Number(x.internalDate) || 0 })).sort((a, b) => a.at - b.at || a.i - b.i).map((y) => y.x)
    for (const m of ms) {
      const k = all.findIndex((x) => x.id === m.id)
      if (k < 0) continue
      // the sender: From, and the Reply-To an answer goes to (a group post rewritten "via" the group)
      const sender = new Set([addrOf(field(m, 'from')), ...addrsOf(field(m, 'replyTo'))].filter(Boolean))
      const answers = (x) => !labelsOf(x).some((l) => NOT_SENT.includes(l)) && isOwn(x, me) && addrsOf([field(x, 'to'), field(x, 'cc')]).some((r) => sender.has(r))
      if (all.slice(k + 1).some(answers)) answered.add(m.id)
    }
  }
  return answered
}

// A triage action that writes the sender a reply (the card lib/mailReply.js isReplyCard opens as a reply)
export const repliesTo = (a) => a?.kind === 'reply' || a?.verb === 'Reply'
