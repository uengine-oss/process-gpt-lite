// Messages the server has not taken yet (2026-11-27 recording 「여기 입력 날라가냐」 · 「지금 입력한게 왜 날라갔지」: sent while a deploy
// restarted the server, the words vanished). The store keeps each one (stores/app.js unsent) until the server takes it: asked again while
// the server is away for a moment, otherwise kept for the person — never dropped. Each message carries its own id (clientId) and the
// server takes an id once (server lib/sendOnce.js), so asking again never makes a second message. Kept in this browser too, so a reload
// (the deploy's own 「새로 고침」) or a sign-in does not lose them. The pure parts are here (tested in server/test/sendQueue.test.js).

// how long a message is asked again (a deploy's restart has taken 1½ – 4 minutes); a test page may shorten it
export const retryWindow = () => Number(globalThis.__PGL_SEND_RETRY_MS__) || 4 * 60_000
// a gateway's answer while the server is away (Cloudflare's 520 – 524 too)
const AWAY = new Set([502, 503, 504, 520, 521, 522, 523, 524])
// a failure that means the server is away for a moment — not taken, asked again. A refusal, or a sign-in that is gone, is not.
// (a try the page gave up on — no answer at all within a while, timedOut — is asked again; one taken back is not)
export const retryable = (e) => !!e && e.accepted === false && !e.unauthorized && (!e.aborted || e.timedOut) && (!e.status || AWAY.has(e.status))
// a try with no answer at all this long is given up and asked again (the server takes a name once — no second message)
export const ATTEMPT_MS = 20_000
// the wait before asking again: 2 s, 4 s, … up to 15 s
export const backoff = (tries) => Math.min(15_000, 2_000 * Math.max(1, Number(tries) || 1))
// why, in the person's words (not the browser's 「Failed to fetch」)
export function why(e) {
  if (!e) return '알 수 없는 문제가 생겼어요'
  if (e.unauthorized) return '로그인이 끝났어요'
  if (e.proxyPage) return '서버 대신 다른 페이지가 응답했어요'
  if (!e.status) return '서버에 연결하지 못했어요'
  if (AWAY.has(e.status)) return `서버가 잠시 응답하지 않았어요 (${e.status})`
  return String(e.message || `서버가 받지 않았어요 (${e.status})`).slice(0, 200)
}
// an id the server accepts (lib/sendOnce.js validId)
export function newId() {
  const raw = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`
  return raw.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64)
}
// a message shown again in its words, short
export function clip(t, n = 40) {
  const s = String(t || '').replace(/\s+/g, ' ').trim()
  return s.length > n ? `${s.slice(0, n)}…` : s
}

// every kept list on this device (sign-out, another person's session: none of it stays)
export function forgetAllUnsent(storage = globalThis.localStorage) {
  try {
    const keys = []
    for (let i = 0; i < (storage?.length || 0); i++) { const k = storage.key(i); if (k && k.startsWith('pgl-unsent:')) keys.push(k) }
    for (const k of keys) storage.removeItem(k)
  } catch { /* storage blocked */ }
}

// ---------- kept in this browser ----------
const KEY = (userId) => `pgl-unsent:${userId || 'me'}`
const FIELDS = ['id', 'threadId', 'key', 'conv', 'text', 'context', 'files', 'refs', 'openDoc', 'agent', 'fresh', 'at', 'state', 'tries', 'error']
const keep = (u) => Object.fromEntries(FIELDS.filter((k) => u[k] !== undefined).map((k) => [k, u[k]]))
const valid = (u) => u && typeof u === 'object' && typeof u.id === 'string' && typeof u.threadId === 'string' && typeof u.text === 'string'
export function loadUnsent(userId, storage = globalThis.localStorage) {
  try {
    const v = JSON.parse(storage?.getItem(KEY(userId)) || '[]')
    return Array.isArray(v) ? v.filter(valid).map(keep) : []
  } catch { return [] }
}
export function saveUnsent(userId, list, storage = globalThis.localStorage) {
  try {
    if (list.length) storage?.setItem(KEY(userId), JSON.stringify(list.map(keep)))
    else storage?.removeItem(KEY(userId))
  } catch { /* storage full or blocked: kept in memory only */ }
}
