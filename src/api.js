// Thin client for the pgpt-pro server (proxied at /api by Vite).
import { forgetAllUnsent } from './sendQueue.js'
import { BASE } from './base.js'
import { forgetPlaces } from './shareTarget.js'
import { sessionStore } from './sessionStore.js'

// the sign-in: the page's localStorage in a browser, the desktop app's sealed store in the app (src/sessionStore.js)
export const auth = {
  get() { try { return JSON.parse(sessionStore.read() || 'null') } catch { return null } },
  set(v) { sessionStore.write(JSON.stringify(v)) },
  clear() { sessionStore.remove() },
}
// who is signed in here: the session token's subject (the person's id) — what a kept place, a waiting share and a messenger draft
// belong to (src/shareTarget.js), read without asking the server
export const sessionUser = () => sub(auth.get()?.session?.access_token || '') || null

// Behind the ProcessGPT gateway (<tenant>.process-gpt.io/lite) the person is already signed in to
// ProcessGPT, which keeps its Supabase tokens in access_token/refresh_token cookies on .process-gpt.io
// (the same handoff the /wms app uses). Take them when there is no session here or it belongs to
// someone else; a pair that was already refused is not taken again (no sign-in loop).
const HOST_FAILED = 'pgpt-pro-host-session-failed'
const storeOf = (k) => { try { return window[k] } catch { return null } }
const cookie = (k) => decodeURIComponent((document.cookie.match(new RegExp(`(?:^|; )${k}=([^;]*)`)) || [])[1] || '')
const sub = (jwt) => { try { return JSON.parse(atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).sub } catch { return null } }
export function adoptHostSession() {
  const access_token = cookie('access_token'), refresh_token = cookie('refresh_token')
  if (!access_token || !refresh_token) return false
  try { if (sessionStorage.getItem(HOST_FAILED) === refresh_token) return false } catch { /* ignore */ }
  const mine = auth.get()?.session?.access_token
  if (mine && sub(mine) === sub(access_token)) return false
  // (another person's session from here on: this device forgets the last one's places, waiting share and unsent words)
  if (mine) { forgetPlaces(storeOf('localStorage'), storeOf('sessionStorage')); forgetAllUnsent(storeOf('localStorage')) }
  auth.set({ session: { access_token, refresh_token }, host: true })
  return true
}

export async function refreshToken() {
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
  }).catch(() => null)
  // a busy or restarting server is not a refused session: null = unknown, the person stays signed in
  if (!r || r.status >= 500) return null
  const j = await r.json()
  if (!j.access_token) return false
  auth.set({ ...s, session: { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: j.expires_at } })
  return true
}
// (desktop: a sign-in that was in the page's storage moved to the app's sealed store just now — renewed once, so the pair the storage
// held is spent; one taken from ProcessGPT is ProcessGPT's to renew)
if (sessionStore.moved && !auth.get()?.host) setTimeout(() => { refreshToken().catch(() => {}) }, 0)

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
// signal: an AbortSignal — the chip taken away (a share put somewhere else) stops the upload
export async function uploadAttachment(file, { signal } = {}) {
  const go = () => fetch(BASE + '/api/attachments', {
    method: 'POST', body: file, signal,
    headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name), Authorization: `Bearer ${auth.get()?.session?.access_token || ''}` },
  })
  let r = await go()
  if (r.status === 401 && await refreshToken()) r = await go()
  if (!r.ok) throw new Error(r.status === 413 ? '50MB 보다 큰 파일은 올릴 수 없어요.' : '올리지 못했어요.')
  return r.json()
}

// A file sent from the computer in the messenger (POST /api/team/uploads → my file card {id, name, size, type}), with how much has
// gone (onProgress(0..1)): XHR, because fetch says nothing about an upload's progress. The body goes as octet-stream with the type in
// X-File-Type (a .json file is not taken by the server's JSON parser). abort: the returned promise's .abort().
export function uploadTeamFile(file, onProgress = () => {}) {
  let xhr
  const go = () => new Promise((resolve, reject) => {
    xhr = new XMLHttpRequest()
    xhr.open('POST', BASE + '/api/team/uploads')
    xhr.setRequestHeader('Content-Type', 'application/octet-stream')
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name))
    xhr.setRequestHeader('X-File-Type', file.type || '')
    xhr.setRequestHeader('Authorization', `Bearer ${auth.get()?.session?.access_token || ''}`)
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total) }
    xhr.onload = () => resolve(xhr)
    xhr.onerror = () => reject(new Error('보내지 못했어요. 연결을 확인해 주세요.'))
    xhr.onabort = () => reject(Object.assign(new Error('취소했어요.'), { aborted: true }))
    xhr.send(file)
  })
  const job = (async () => {
    let r = await go()
    if (r.status === 401 && await refreshToken()) r = await go()
    let body = null
    try { body = JSON.parse(r.responseText) } catch { /* not JSON */ }
    if (r.status < 200 || r.status >= 300) throw new Error(r.status === 413 ? '50MB 보다 큰 파일은 보낼 수 없어요.' : body?.error || '올리지 못했어요.')
    onProgress(1)
    return body
  })()
  job.abort = () => xhr?.abort()
  return job
}

// an HTML page where an API answer was expected (the media type, or a body that is a document)
export const htmlPage = (r, text) => /\bhtml\b/i.test(r.headers?.get?.('content-type') || '') || /^\s*<(!doctype|html)\b/i.test(String(text || ''))

export async function api(path, { method = 'GET', body, raw, signal } = {}) {
  const go = () => fetch(`${BASE}/api${path}`, {
    method,
    ...(signal ? { signal } : {}),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.get()?.session?.access_token || ''}` },
    body: body ? JSON.stringify(body) : undefined,
  })
  let r = await go()
  // the server could not check the sign-in (X-Auth-Retry): wait and ask again, never a reason to sign out
  for (let i = 0; r.status === 503 && r.headers.get('X-Auth-Retry') && i < 4; i++) {
    await new Promise((ok) => setTimeout(ok, 1500 * (i + 1)))
    r = await go()
  }
  if (r.status === 401) {
    const renewed = await refreshToken()
    if (renewed) r = await go()
    else if (renewed === null) throw new Error('server busy')
  }
  if (r.status === 401) {
    if (auth.get()?.host) try { sessionStorage.setItem(HOST_FAILED, auth.get().session.refresh_token) } catch { /* ignore */ }
    auth.clear(); location.href = BASE + '/login'; throw new Error('unauthorized')
  }
  if (raw) return r
  // a long answer (server lib/longJson.js: 200 committed early so a proxy does not cut it, X-Long-Json) carries its error in
  // the body: {"error", "status" ≥ 400} is the failure it would have been
  if (r.ok && r.headers.get('X-Long-Json')) {
    const j = await r.json()
    if (j && typeof j === 'object' && !Array.isArray(j) && j.error && Number(j.status) >= 400) {
      throw Object.assign(new Error(String(j.error).slice(0, 300)), { status: Number(j.status), ...(j.conflicts ? { conflicts: j.conflicts } : {}), ...(j.code ? { code: j.code } : {}) })
    }
    return j
  }
  if (!r.ok) {
    // a JSON error body ({error}) shows its message, not the raw JSON
    const t = await r.text()
    let m = t, extra = {}
    try { const j = JSON.parse(t); m = j.error || t; if (j.conflicts) extra = { conflicts: j.conflicts }; if (j.code) extra.code = j.code } catch { /* plain text */ }
    // an error page made by something in front of the server (Cloudflare's 502 page, a proxy's): its markup
    // is no message — say the server did not answer, with the status (2026-11-23: the Telegram card showed HTML)
    if (m === t && htmlPage(r, t)) m = `서버가 응답하지 못했어요 (${r.status}). 잠시 후 다시 시도해 주세요.`
    throw Object.assign(new Error(String(m).slice(0, 300)), { status: r.status, ...extra })
  }
  return r.json()
}

// POST that streams SSE events back: onEvent(type, data)
// POST that streams SSE events back: onEvent(type, data). A failure says whether the server took the request (accepted):
//   false — no answer at all (no connection, aborted), an error status, or a 200 that is not an event stream (a proxy's page in front):
//           the message was not taken and may be sent again (src/sendQueue.js)
//   true  — the stream broke after the server took it: its answer still arrives as live events — never sent again
// onAccepted() is called the moment the server has taken it (its event stream began), long before the answer is written.
// Before 2026-11-27 an error status was read as an empty stream and the message vanished without a word (recording 07:03).
export async function stream(path, body, onEvent, { onAccepted, signal } = {}) {
  let r
  try { r = await api(path, { method: 'POST', body, raw: true, signal }) } catch (e) {
    throw Object.assign(e, { accepted: false, ...(e?.name === 'AbortError' ? { aborted: true } : {}), ...(e?.message === 'unauthorized' ? { unauthorized: true } : {}) })
  }
  const sse = /text\/event-stream/i.test(r.headers.get('content-type') || '')
  if (!r.ok || !sse) {
    const t = await r.text().catch(() => '')
    let m = t
    try { m = JSON.parse(t).error || t } catch { /* plain text */ }
    if (m === t && (!t || htmlPage(r, t))) m = `서버가 응답하지 못했어요 (${r.status}).`
    throw Object.assign(new Error(String(m).slice(0, 300)), { status: r.ok ? 0 : r.status, accepted: false, ...(r.ok ? { proxyPage: true } : {}) })
  }
  onAccepted?.()
  const reader = r.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  for (;;) {
    let got
    try { got = await reader.read() } catch (e) { throw Object.assign(e, { accepted: true }) }
    const { done, value } = got
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

const EVENT_TYPES = ['message', 'thread', 'action', 'panel', 'panel.deleted', 'panelapp', 'panelapp.rows', 'panelapp.deleted', 'panelapp.changed', 'status', 'browser.frame', 'browser.click', 'process', 'mission', 'notifications', 'team', 'meeting', 'local_presence',
  // a chat turn while it runs: its plan, stage, to-dos, steps and notes (server lib/turnPlan.js — the plan card and the progress panel)
  'turn.start', 'turn.plan', 'turn.stage', 'turn.todos', 'turn.step', 'turn.note', 'turn.call', 'turn.end',
  // a project's plan changed (server lib/projectNote.js — an automatic update, 계획에 넣기, an undo): its chip and sheet load it again
  'projectNote']
// Live events over SSE; if the stream never says hello (a proxy in front holding it back, as
// Cloudflare quick tunnels do), the same events come by long polling instead.
// One stream per page, however many ask for it: the chat (app.js boot) and the team messenger (stores/team.js boot — a messenger
// docked beside the folder screen, where the chat never booted, still gets its messages and the AI's answers live).
let shared = null
export function events(handler) {
  if (shared) { shared.add(handler); return () => shared?.delete(handler) }
  const handlers = (shared = new Set([handler]))
  // every event is also re-broadcast on the window, so a store that is not app.js (stores/team.js)
  // can listen without a second stream
  const onEvent = (t, d) => { for (const h of handlers) h(t, d); try { window.dispatchEvent(new CustomEvent('pgpt:event', { detail: { type: t, data: d } })) } catch { /* old browser */ } }
  let es, stopped = false, polling = false
  // a connection after the first one (a reconnect, or long polling after a stream): events sent meanwhile were not seen — the
  // handlers are told ('reconnect'), so what they keep live (the running turns' cards) is read again
  let connected = 0
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
      if (connected++ > 0) onEvent('reconnect', {})
      pollLoop(null)
    }, 5000)
    es.addEventListener('hello', () => { hello = true; clearTimeout(fallback); if (connected++ > 0) onEvent('reconnect', {}) })
    for (const t of EVENT_TYPES) es.addEventListener(t, (e) => onEvent(t, JSON.parse(e.data)))
    es.onerror = () => { if (polling) return; es.close(); setTimeout(async () => { await refreshToken(); if (!polling) open() }, 3000) }
  }
  open()
  return () => { handlers.delete(handler); if (!handlers.size) { stopped = true; es?.close(); shared = null } }
}
