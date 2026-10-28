// The screen language: 'ko' (the source text) or 'en' (runtime translation, see english.js).
// Order: URL ?lang=en|ko (saved) > the user's saved setting > the browser language (ko* → ko, else en).
// The saved setting lives in localStorage `pgl-lang` and on the server (PUT /api/me/lang,
// GET /api/me → lang): a choice made here (URL, the switch, the login screen) is sent to the server;
// a choice made on another device comes back through /api/me (syncLang).
// Every /api request carries `X-PGL-Lang: en|ko`, so the server answers in the screen's language.
// Imported first in main.js — before anything calls fetch.
const KEY = 'pgl-lang'
const SYNCED = 'pgl-lang-synced' // the value the server last confirmed
const valid = (v) => (v === 'en' || v === 'ko' ? v : null)
const get = (k) => { try { return valid(localStorage.getItem(k)) } catch { return null } }
const put = (k, v) => { try { localStorage.setItem(k, v) } catch { /* private mode */ } }

const fromUrl = valid(new URLSearchParams(location.search).get('lang'))
if (fromUrl) put(KEY, fromUrl)
export const browserLang = () => (/^ko\b/i.test(navigator.language || '') ? 'ko' : 'en')
export const lang = fromUrl || get(KEY) || browserLang()
export const isEnglish = lang === 'en'
document.documentElement.lang = lang

// '' at a domain root, '/lite' when the app is served under a prefix (VITE_BASE_PATH)
const BASE = (import.meta.env?.BASE_URL || '/').replace(/\/$/, '')
const nativeFetch = window.fetch.bind(window)
const isApi = (url) => url.startsWith(`${BASE}/api/`) || url.startsWith(`${location.origin}${BASE}/api/`)
window.fetch = function (input, init) {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input && input.url) || ''
  if (!isApi(url)) return nativeFetch(input, init)
  const headers = new Headers((init && init.headers) || (input instanceof Request ? input.headers : undefined))
  if (!headers.has('X-PGL-Lang')) headers.set('X-PGL-Lang', lang)
  return nativeFetch(input, { ...(init || {}), headers })
}

function token() {
  try { return JSON.parse(localStorage.getItem('pgpt-pro-session') || 'null')?.session?.access_token || '' } catch { return '' }
}
async function tellServer(v) {
  if (!token()) return false
  try {
    const r = await fetch(`${BASE}/api/me/lang`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` }, body: JSON.stringify({ lang: v }) })
    if (r.ok) put(SYNCED, v)
    return r.ok
  } catch { return false }
}

function reloadWithout() {
  const u = new URL(location.href)
  u.searchParams.delete('lang')
  location.replace(u.href)
}

/** The switch: save, tell the server (when signed in) and reload in the new language. */
export async function setLang(v) {
  v = valid(v)
  if (!v) return
  put(KEY, v)
  await tellServer(v)
  if (v !== lang || fromUrl) reloadWithout()
}

/** After GET /api/me: keep the device and the server on the same language. */
export async function syncLang(me) {
  const server = valid(me && me.lang)
  const local = get(KEY)
  // chosen here and not on the server yet (URL, the switch, the login screen) → send it
  if (fromUrl || (local && local !== get(SYNCED))) { if (server !== lang) await tellServer(lang); else put(SYNCED, lang); return }
  // chosen on another device → follow it
  if (server && server !== lang) { put(KEY, server); put(SYNCED, server); reloadWithout(); return }
  // the server has no setting yet → the one in use (the browser's)
  if (!server) await tellServer(lang)
  else put(SYNCED, server)
}
