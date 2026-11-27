// Connecting a signed-in person's Google account (mail, calendar, Drive, YouTube), and the installed
// Lite's 「Google로 계속하기」 sign-in, which shares the callback.
//   - who: a connection belongs to the Lite person who started it (and the tenant they started it in),
//     whatever Google account they pick — the callback never signs anyone in for it
//   - where: the redirect URI is the address the page is on. Behind the ProcessGPT gateway that is the
//     company's own, <tenant>.process-gpt.io/lite (lib/workroom.js companyAddress), so the callback
//     comes back to the same host and path the state cookie was set for: the public path
//     (PRO_PUBLIC_URL's, '/lite' — the gateway strips it before the server sees the request) +
//     /api/auth/google. An installed Lite keeps its one address, PRO_PUBLIC_URL.
//   - forgery: the state lives here (one server) with the person, the tenant, the PKCE verifier and
//     where to go back; the callback takes it only together with the same value in the state cookie of
//     the browser that started it, so a consent screen someone else started cannot connect your Google
//     to their Lite account (nor theirs to yours).
//   - how (mode): 'browser' — in the person's server browser (lib/browser.js connectGoogle), so one
//     sign-in also signs that browser in to Google (NotebookLM and other Google sites); 'phone' — in the
//     person's own browser, mail only; 'login' — the installed sign-in.
import crypto from 'node:crypto'
import { config } from '../config.js'
import { companyAddress } from './workroom.js'
import { urlOf } from './tenant.js'
import { L } from './lang.js'

export const STATE_COOKIE = 'pgpt-oauth-state'
export const STATE_MS = { login: 10 * 60 * 1000, phone: 10 * 60 * 1000, browser: 15 * 60 * 1000 }

// the path the app is served under in the browser ('' at a domain root, '/lite' behind the gateway)
export function publicPath() {
  try { return new URL(config.publicUrl).pathname.replace(/\/+$/, '') } catch { return '' }
}
export const cookiePath = () => `${publicPath()}/api/auth/google`

// The app's address for a page on origin, or null when a connection may not start from there.
// Gateway: the page's own company address (+ the public path). Otherwise: this install's address
// (the tenant's host when there are several), the one registered with Google.
export function pageBase(origin) {
  if (config.tenantFromHeader) {
    let u
    try { u = new URL(String(origin || '')) } catch { return null }
    if (!/^https?:$/.test(u.protocol) || !companyAddress(u.host)) return null
    return `${u.origin}${publicPath()}`
  }
  // (urlOf gives the tenant's origin only: the app's path under it is the public URL's, as in the cookie path)
  const own = urlOf(config.tenantId)
  return own ? `${String(own).replace(/\/+$/, '')}${publicPath()}` : String(config.publicUrl).replace(/\/+$/, '')
}
export const redirectUriOf = (base) => `${base}/api/auth/google/callback`
export const doneUrlOf = (base, { error, lang } = {}) => {
  // (the reason itself is on the card: the page only says that it did not work — a link cannot put words on it)
  const p = new URLSearchParams({ ...(error ? { error: '1' } : {}), ...(lang ? { lang } : {}) })
  return `${base}/api/auth/google/done${String(p) ? `?${p}` : ''}`
}

// The installed sign-in comes back to the page that started it: <base>/auth/done?n=<the page's value>#<the session> — the page takes
// only a sign-in it started itself (src/signInNonce.js). n: what /api/auth/google/start was given (hex, as the page makes it), else ''.
export const signInValue = (v) => (typeof v === 'string' && /^[0-9a-f]{32,128}$/.test(v) ? v : '')
export const loginDoneUrlOf = (base, login, n = '') => `${base}/auth/done${signInValue(n) ? `?n=${n}` : ''}#${encodeURIComponent(JSON.stringify(login))}`

const states = new Map() // state -> { at, ms, mode, userId, tenant, verifier, base, redirectUri, lang, taskId, signIn }
function sweep() {
  for (const [k, v] of states) if (Date.now() - v.at > v.ms) states.delete(k)
}

// A new state for a consent screen: { state, verifier } (entry: mode, userId, tenant, base, lang …)
export function newState(entry) {
  sweep()
  const state = crypto.randomBytes(32).toString('hex')
  const verifier = crypto.randomBytes(32).toString('base64url')
  states.set(state, { ...entry, verifier, redirectUri: redirectUriOf(entry.base), at: Date.now(), ms: STATE_MS[entry.mode] || STATE_MS.phone })
  return { state, verifier }
}
export const setTask = (state, taskId) => { const st = states.get(state); if (st) st.taskId = taskId }
export const dropState = (state) => states.delete(state)

// the state cookie's value in a Cookie header
export function cookieState(header) {
  const hit = String(header || '').split(';').map((x) => x.trim()).find((x) => x.startsWith(`${STATE_COOKIE}=`))
  return hit ? decodeURIComponent(hit.slice(STATE_COOKIE.length + 1)) : ''
}

export class ConnectError extends Error {
  constructor(message, st = null) { super(message); this.st = st }
}

// The callback's state: the one this server handed out, still fresh, in the browser that started it
// (the cookie), for the tenant the callback came to. Used once.
export function takeState(state, cookieHeader, tenant) {
  const st = typeof state === 'string' ? states.get(state) : null
  const expired = L('연결 요청이 만료됐어요. 처음부터 다시 시도해 주세요.', 'The request has expired. Please start again.')
  if (!st) throw new ConnectError(expired)
  if (cookieState(cookieHeader) !== state) throw new ConnectError(L('이 브라우저에서 시작한 연결 요청이 아니에요. 처음부터 다시 시도해 주세요.', "This request wasn't started in this browser. Please start again."), null)
  states.delete(state)
  if (Date.now() - st.at > st.ms) throw new ConnectError(expired, st)
  if (st.tenant !== tenant) throw new ConnectError(L('다른 작업 공간에서 시작한 연결 요청이에요. 처음부터 다시 시도해 주세요.', 'This request was started in another workspace. Please start again.'), st)
  return st
}

// the state cookie, for an express response (the person's own browser) or a Playwright context (the server browser)
export function cookieFor(base, state, mode) {
  const u = new URL(base)
  return {
    name: STATE_COOKIE, value: state, path: cookiePath(), httpOnly: true, sameSite: 'Lax', secure: u.protocol === 'https:',
    domain: u.hostname, maxAgeMs: STATE_MS[mode] || STATE_MS.phone,
  }
}
