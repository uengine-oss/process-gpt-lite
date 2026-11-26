// Phone notifications that read like a messenger and let the person answer the AI from the notification itself (2026-11-26 사용자,
// Android 알림 창의 카카오톡 · Gemini · Claude 알림을 보여 주며: 「퀵하게 대화방에서 온 내용 혹은 ai의 후먼인더루프 등을 모바일에서 보게할 수
// 있나?」). The pure parts — no database, no network (server/test/pushActions.test.js):
//   - a room's new messages as one notification per room: its tag, a title with the count, the last lines 「김민수: …」
//   - what the AI is waiting for (a question, an approval, a sign-in, something only the person can do): the title, and which buttons
//     the notification may carry (Android shows two at most)
//   - the action token: "pa1.<payload>.<signature>", both base64url — one notification's answer for one person, the answers it may give,
//     an expiry. HMAC-SHA256 under a key derived from the server's secret with a fixed label (the secret never leaves the server); the
//     session token is never in a push. A valid token says only who answers what: lib/askPerson.js still checks the notice, the person,
//     that the card still waits — and uses the notice up once (single use).
import crypto from 'node:crypto'

export const TOKEN_TTL_S = 24 * 3600
// Android shows two buttons on a web notification
export const MAX_ACTIONS = 2
// an option longer than this is cut on the button: then the notification opens the card instead of answering from it
export const MAX_LABEL = 24

// ---------- the action token ----------
/** the signing key: HMAC of a fixed label under the server's secret (never the secret itself) */
export function actionKey(secret) {
  if (!secret) throw new Error('no secret to sign notification actions with')
  return crypto.createHmac('sha256', String(secret)).update('pgpt-lite/push-action/v1').digest()
}
const mac = (key, body) => crypto.createHmac('sha256', key).update(`pa1.${body}`).digest('base64url')

/** → the token of notice `notice` (card `card`) for person `userId`, which may answer one of `answers` */
export function mintAction({ key, tenant, userId, notice, card, answers = [], now = Date.now(), ttlS = TOKEN_TTL_S }) {
  if (!userId || !notice || !card) throw new Error('an action token names its person, notice and card')
  const body = Buffer.from(JSON.stringify({ v: 1, t: String(tenant || ''), u: String(userId), n: String(notice), c: String(card),
    a: answers.map(String), exp: Math.floor(now / 1000) + ttlS })).toString('base64url')
  return `pa1.${body}.${mac(key, body)}`
}

/** {ok: true, claims} | {ok: false, why: 'bad' | 'expired'} — the signature first (an altered token is 'bad' whatever its expiry) */
export function verifyAction(token, { key, now = Date.now() }) {
  const m = /^pa1\.([A-Za-z0-9_-]{10,2000})\.([A-Za-z0-9_-]{43})$/.exec(String(token || ''))
  if (!m) return { ok: false, why: 'bad' }
  const want = Buffer.from(mac(key, m[1]), 'base64url')
  const got = Buffer.from(m[2], 'base64url')
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return { ok: false, why: 'bad' }
  let c
  try { c = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8')) } catch { return { ok: false, why: 'bad' } }
  if (!c || c.v !== 1 || !c.u || !c.n || !c.c || !Array.isArray(c.a) || !Number.isFinite(c.exp)) return { ok: false, why: 'bad' }
  if (c.exp > Math.floor(now / 1000) + TOKEN_TTL_S + 60) return { ok: false, why: 'bad' }
  if (c.exp * 1000 <= now) return { ok: false, why: 'expired' }
  return { ok: true, claims: c }
}

// ---------- a room's messages ----------
// the room of a notice: process-gpt's chat trigger ('/chats?id=<room>') or a share or mention in it ('/pro/team/<room>/<message>')
export function roomOf(url) {
  const s = String(url || '')
  return /^\/chats\?id=([\w.:-]+)/.exec(s)?.[1] || /^\/pro\/team\/([\w.:-]+)\/[\w-]+$/.exec(s)?.[1] || null
}
export const roomTag = (room) => `pgl-room-${room}`
const oneLine = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n)

// A mention of me: its own notification, always (never folded into the room's, never held back) — Lite's 'team' notice says
// 「…나를 언급했어요」 / 「… mentioned you」 (lib/team/messenger.js notifyMembers); process-gpt's own 'mention' type
export const isMention = (r) => r?.type === 'mention' || (r?.type === 'team' && /나를 언급했어요|\bmentioned you\b/.test(String(r.title || '')))

/** one person's new rows of this pass (oldest first) → [{room, rows}] for teammates' messages (one per room, in the order their newest
 *  came) and [{row}] for everything else */
export function groupForPush(rows = []) {
  const rooms = new Map()
  const out = []
  for (const r of rows) {
    const room = r?.type === 'chat' ? roomOf(r.url) : null
    if (!room) { out.push({ row: r }); continue }
    const g = rooms.get(room)
    if (g) { g.rows.push(r); out.splice(out.indexOf(g), 1); out.push(g) } else { const n = { room, rows: [r] }; rooms.set(room, n); out.push(n) }
  }
  return out
}

/** the room's notification: 「<방 이름> · 3」 over its last two lines 「김민수: …」. name: the room's own name (a 1:1 room has none: it
 *  is called by the other person — the writer); count: how many of its messages wait unread; lines: [{from, text}] oldest first */
export function roomNotice({ room, name, count = 1, lines = [] }) {
  const last = lines[lines.length - 1] || {}
  const who = oneLine(name, 60) || oneLine(last.from, 40)
  const title = `${who || '새 메시지'}${count > 1 ? ` · ${count}` : ''}`
  const body = lines.slice(-2).map((l) => (l.from ? `${oneLine(l.from, 30)}: ${oneLine(l.text, 120)}` : oneLine(l.text, 140))).join('\n')
  return { title, body, tag: roomTag(room), renotify: true, room }
}

// ---------- what the AI waits for ----------
export const ASK_KINDS = ['question', 'approval', 'login', 'hands']
// a waiting card (lib/browser.js waitForUser, lib/agent.js delegate) → its kind: the card's own kind and fields
export function askKind({ kind, content = {} } = {}) {
  if (kind === 'choice') return content.approval ? 'approval' : content.vault ? 'login' : 'question'
  if (kind === 'vault') return 'login'
  if (kind === 'task') return content.need === 'login' ? 'login' : 'hands'
  return 'question'
}

/** the buttons a waiting card's notification carries, and the answers its token allows (by index):
 *  - a question with one or two short options: the options themselves — a tap answers without opening Lite
 *  - an approval (a payment, an upload): 「열기」 and the refusal only — approving is done on the card, with the screen in front of the
 *    person (a phone's lock screen shows notification buttons to whoever holds it); refusing is always safe
 *  - everything else (more options, a sign-in, a check only the person can do on the screen): 「열기」 */
export function askButtons({ kind, options = [] }, { open = '열기' } = {}) {
  const opts = (options || []).map((o) => String(o ?? '').trim()).filter(Boolean)
  const short = opts.every((o) => [...o].length <= MAX_LABEL)
  if (kind === 'question' && opts.length >= 1 && opts.length <= MAX_ACTIONS && short) {
    return { buttons: opts.map((o, i) => ({ action: `a${i}`, title: o })), answers: opts }
  }
  if (kind === 'approval' && opts.length === 2 && short) {
    return { buttons: [{ action: 'open', title: open }, { action: 'a0', title: opts[1] }], answers: [opts[1]] }
  }
  return { buttons: [{ action: 'open', title: open }], answers: [] }
}

/** the notice's words: what it asks, short enough for a notification line */
export function askText(text, n = 140) {
  const t = String(text ?? '').replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim()
  return [...t].length > n ? `${[...t].slice(0, n - 1).join('')}…` : t
}
