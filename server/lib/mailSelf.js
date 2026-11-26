// Whose mail it is. The mail intake (lib/mail.js pollUser) makes Home cards of what new mail asks the person to do — a mail the person
// sent asks them nothing. Gmail's list leaves the Sent folder out (-in:sent), yet a mail of theirs still comes in: a copy sent from another
// address of theirs (their Lite · company address with the connected Gmail in Cc or Bcc, a send-as alias, a group that sends members their
// own posts) carries no SENT label. 2026-11-26 (production, phone Home): the person's own mail to a customer, an activity report attached,
// came back as a 「답장」 card (reply to themselves) and a 「검토」 card (review their own attachment) — 「이 메일은 내가 보낸건데 왜 내가
// 받은걸로 뜨는건가.」
//
// Who the person is, by structure only — never by reading the words: the Gmail SENT label, and the sender's address against the person's
// addresses (the connected mailbox, its send-as addresses in Gmail's settings — readable with gmail.readonly, no new scope —, the Lite
// account's e-mail). A sender with the person's name at an address Lite does not know of is not taken for them: someone else may have the
// same name.
//
// A thread: the person's own reply after a mail is the latest word in it — that mail is not waiting for their reply (answeredOf).
import { config } from '../config.js'
import { q } from './supa.js'
import { getSecret } from './vault.js'

// the address of a From header — '"홍길동" <Gil@Hong.example>' → 'gil@hong.example' — or '' when there is none
export function addrOf(header) {
  const s = String(header || '').trim()
  const a = (/<([^<>]+)>\s*$/.exec(s)?.[1] ?? s).trim().toLowerCase()
  return /^[^\s@<>]+@[^\s@<>]+$/.test(a) ? a : ''
}

// the From of a mail as the intake reads it ({from, labels}) or as Gmail gives it ({labelIds, payload.headers})
const fromOf = (m) => m?.from ?? (m?.payload?.headers || []).find((h) => String(h.name).toLowerCase() === 'from')?.value ?? ''

// sent by the person: Gmail filed it as sent, or its sender is one of the person's addresses (me: a Set of lower-case addresses)
export function isOwn(mail, me) {
  if ((mail?.labels || mail?.labelIds || []).includes('SENT')) return true
  const a = addrOf(fromOf(mail))
  return !!a && !!me?.has(a)
}

// ---------- the person's addresses ----------
const SEND_AS_MS = 60 * 60 * 1000
const sendAsSeen = new Map() // userId → { at, list }

// The addresses Gmail lets the connected account send as (its own address too), each lower case — [] when Gmail does not answer
// (an older grant, the API off): the other addresses still count. Kept an hour per person: they change rarely.
export async function gmailSendAs(userId, token, { api = gmailBase(), fresh = false } = {}) {
  const hit = sendAsSeen.get(userId)
  if (!fresh && hit && Date.now() - hit.at < SEND_AS_MS) return hit.list
  try {
    const r = await fetch(`${api}/settings/sendAs`, { headers: { Authorization: `Bearer ${token}` } })
    if (!r.ok) return []
    const j = await r.json().catch(() => ({}))
    // (an outside address still waiting for its verification mail is not one the person may send as yet)
    const list = (j.sendAs || []).filter((x) => x?.sendAsEmail && x.verificationStatus !== 'pending').map((x) => String(x.sendAsEmail).trim().toLowerCase())
    sendAsSeen.set(userId, { at: Date.now(), list })
    return list
  } catch { return [] }
}
const gmailBase = () => process.env.PRO_GMAIL_API || `${config.google.gmailUrl}/users/me`

// Every address of the person's: the connected mailbox's (acc.address — the Google account for Gmail, the login for IMAP, the Lite
// address for the demo mailbox), the Google account the connection was made with, Gmail's send-as addresses (token: the Gmail access
// token), and the person's Lite · Process GPT e-mail.
export async function myAddresses(userId, acc = null, { token = null, api } = {}) {
  const out = new Set()
  const add = (a) => { const x = addrOf(a); if (x) out.add(x) }
  add(acc?.address)
  for (const r of await q('select email from pro_profile where user_id=$1', [userId]).catch(() => [])) add(r.email)
  // (process-gpt's users: one row per company the person is in)
  for (const r of await q('select email from users where id=$1', [userId]).catch(() => [])) add(r.email)
  if (acc?.provider === 'gmail') {
    add((await getSecret(userId, 'oauth', config.google.vaultSite).catch(() => null))?.username)
    if (token) for (const a of await gmailSendAs(userId, token, { api })) add(a)
  }
  return out
}

// ---------- threads ----------
// The mails (Gmail) whose thread holds a later mail of the person's — they have answered it already — as a Set of mail ids. A draft is not
// an answer. One thread read per thread (metadata only: labels and From); a thread that cannot be read leaves its mails as they were.
export async function answeredOf(mails, me, token, { api = gmailBase() } = {}) {
  const answered = new Set()
  const byThread = new Map()
  for (const m of mails) if (m.thread) byThread.set(m.thread, [...(byThread.get(m.thread) || []), m])
  for (const [thread, ms] of byThread) {
    let t
    try {
      const r = await fetch(`${api}/threads/${encodeURIComponent(thread)}?format=metadata&metadataHeaders=From`, { headers: { Authorization: `Bearer ${token}` } })
      if (!r.ok) continue
      t = await r.json()
    } catch { continue }
    // (Gmail gives a thread's mails oldest first; the time each arrived decides, then that order)
    const all = (t.messages || []).map((x, i) => ({ x, i, at: Number(x.internalDate) || 0 })).sort((a, b) => a.at - b.at || a.i - b.i).map((y) => y.x)
    for (const m of ms) {
      const k = all.findIndex((x) => x.id === m.id)
      if (k < 0) continue
      if (all.slice(k + 1).some((x) => !(x.labelIds || []).includes('DRAFT') && isOwn(x, me))) answered.add(m.id)
    }
  }
  return answered
}

// A triage action that writes the sender a reply (the card lib/mailReply.js isReplyCard opens as a reply)
export const repliesTo = (a) => a?.kind === 'reply' || a?.verb === 'Reply'
