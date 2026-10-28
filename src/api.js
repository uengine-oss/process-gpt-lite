// Thin client for the pgpt-pro server (proxied at /api by Vite).
import { BASE } from './base.js'

const KEY = 'pgpt-pro-session'

export const auth = {
  get() { try { return JSON.parse(localStorage.getItem(KEY) || 'null') } catch { return null } },
  set(v) { try { localStorage.setItem(KEY, JSON.stringify(v)) } catch { /* ignore */ } },
  clear() { try { localStorage.removeItem(KEY) } catch { /* ignore */ } },
}

// Behind the ProcessGPT gateway (<tenant>.process-gpt.io/lite) the person is already signed in to
// ProcessGPT, which keeps its Supabase tokens in access_token/refresh_token cookies on .process-gpt.io
// (the same handoff the /wms app uses). Take them when there is no session here or it belongs to
// someone else; a pair that was already refused is not taken again (no sign-in loop).
const HOST_FAILED = 'pgpt-pro-host-session-failed'
const cookie = (k) => decodeURIComponent((document.cookie.match(new RegExp(`(?:^|; )${k}=([^;]*)`)) || [])[1] || '')
const sub = (jwt) => { try { return JSON.parse(atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).sub } catch { return null } }
export function adoptHostSession() {
  const access_token = cookie('access_token'), refresh_token = cookie('refresh_token')
  if (!access_token || !refresh_token) return false
  try { if (sessionStorage.getItem(HOST_FAILED) === refresh_token) return false } catch { /* ignore */ }
  const mine = auth.get()?.session?.access_token
  if (mine && sub(mine) === sub(access_token)) return false
  auth.set({ session: { access_token, refresh_token }, host: true })
  return true
}

async function refreshToken() {
  // a token taken from ProcessGPT is kept fresh by ProcessGPT: take its newer pair rather than
  // spending the shared refresh token here (rotation would sign the other tab out)
  if (auth.get()?.host) {
    const access_token = cookie('access_token'), refresh_token = cookie('refresh_token')
    if (access_token && access_token !== auth.get().session.access_token) {
      auth.set({ session: { access_token, refresh_token }, host: true })
      return true
    }
  }
  const s = auth.get()
  if (!s?.session?.refresh_token) return false
  const r = await fetch(BASE + '/api/auth/refresh', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: s.session.refresh_token }),
  })
  const j = await r.json()
  if (!j.access_token) return false
  auth.set({ ...s, session: { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: j.expires_at } })
  return true
}

// A token for a URL that is not retried on 401 (the office editor's socket): refreshed first when
// it has under two minutes left, since an expired one fails every editor call silently.
export async function freshToken() {
  const s = auth.get()?.session
  if (!s?.access_token) return ''
  let exp = Number(s.expires_at) || 0
  if (!exp) try { exp = JSON.parse(atob(s.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).exp } catch { /* opaque */ }
  if (exp && exp * 1000 - Date.now() < 120000) await refreshToken().catch(() => false)
  return auth.get()?.session?.access_token || ''
}

// A file attached in chat, sent as-is (no JSON, no base64) — the server keeps it where the agent
// can read it and returns {name, size, type, path, url}.
export async function uploadAttachment(file) {
  const go = () => fetch(BASE + '/api/attachments', {
    method: 'POST', body: file,
    headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name), Authorization: `Bearer ${auth.get()?.session?.access_token || ''}` },
  })
  let r = await go()
  if (r.status === 401 && await refreshToken()) r = await go()
  if (!r.ok) throw new Error(r.status === 413 ? '50MB 보다 큰 파일은 올릴 수 없어요.' : '올리지 못했어요.')
  return r.json()
}

export async function api(path, { method = 'GET', body, raw } = {}) {
  const go = () => fetch(`${BASE}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.get()?.session?.access_token || ''}` },
    body: body ? JSON.stringify(body) : undefined,
  })
  let r = await go()
  if (r.status === 401 && await refreshToken()) r = await go()
  if (r.status === 401) {
    if (auth.get()?.host) try { sessionStorage.setItem(HOST_FAILED, auth.get().session.refresh_token) } catch { /* ignore */ }
    auth.clear(); location.href = BASE + '/login'; throw new Error('unauthorized')
  }
  if (raw) return r
  if (!r.ok) {
    // a JSON error body ({error}) shows its message, not the raw JSON
    const t = await r.text()
    let m = t
    try { m = JSON.parse(t).error || t } catch { /* plain text */ }
    throw Object.assign(new Error(String(m).slice(0, 300)), { status: r.status })
  }
  return r.json()
}

// POST that streams SSE events back: onEvent(type, data)
export async function stream(path, body, onEvent) {
  const r = await api(path, { method: 'POST', body, raw: true })
  const reader = r.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const chunks = buf.split('\n\n')
    buf = chunks.pop()
    for (const c of chunks) {
      const ev = /^event: (.*)$/m.exec(c)?.[1]
      const data = /^data: (.*)$/m.exec(c)?.[1]
      if (ev && data) onEvent(ev, JSON.parse(data))
    }
  }
}

const EVENT_TYPES = ['message', 'thread', 'action', 'panel', 'panel.deleted', 'panelapp', 'panelapp.rows', 'panelapp.deleted', 'panelapp.changed', 'status', 'browser.frame', 'process', 'mission', 'notifications', 'team', 'meeting']
// Live events over SSE; if the stream never says hello (a proxy in front holding it back, as
// Cloudflare quick tunnels do), the same events come by long polling instead.
export function events(handler) {
  // every event is also re-broadcast on the window, so a store that is not app.js (stores/team.js)
  // can listen without a second stream
  const onEvent = (t, d) => { handler(t, d); try { window.dispatchEvent(new CustomEvent('pgpt:event', { detail: { type: t, data: d } })) } catch { /* old browser */ } }
  let es, stopped = false, polling = false
  const tok = () => encodeURIComponent(auth.get()?.session?.access_token || '')
  async function pollLoop(after) {
    polling = true
    while (!stopped) {
      try {
        // the first call has no position: the server starts from now
        const r = await fetch(`${BASE}/api/events/poll?${after == null ? '' : `after=${after}&`}token=${tok()}`)
        if (r.status === 401) { await refreshToken(); continue }
        const j = await r.json()
        for (const e of j.events) if (EVENT_TYPES.includes(e.type)) onEvent(e.type, e.data)
        after = j.seq
      } catch { await new Promise((ok) => setTimeout(ok, 3000)) }
    }
  }
  const open = () => {
    es = new EventSource(`${BASE}/api/events?token=${tok()}&lang=${document.documentElement.lang === 'en' ? 'en' : 'ko'}`)
    let hello = false
    const fallback = setTimeout(() => {
      if (hello || stopped) return
      es.close()
      pollLoop(null)
    }, 5000)
    es.addEventListener('hello', () => { hello = true; clearTimeout(fallback) })
    for (const t of EVENT_TYPES) es.addEventListener(t, (e) => onEvent(t, JSON.parse(e.data)))
    es.onerror = () => { if (polling) return; es.close(); setTimeout(async () => { await refreshToken(); if (!polling) open() }, 3000) }
  }
  open()
  return () => { stopped = true; es?.close() }
}
