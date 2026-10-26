// HTTP helpers against the BFF: demo login, JSON calls, MCP JSON-RPC, the chat SSE stream.
import { API_URL, MCP_URL, LOGIN_CODE, MAILPIT_URL, email as areaEmail, isTestEmail } from './env.js'
import { Agent, fetch as ufetch } from 'undici'

// a long agent turn (skill authoring, CAD) sends nothing — not even headers — for many minutes:
// no header/body timeouts on the chat stream (the browser has none either)
const patient = new Agent({ headersTimeout: 0, bodyTimeout: 0 })

const sessions = new Map()

// the newest code mailed to addr after `since` (a code mailed earlier may already be used by another
// worker signing in as the same test account)
async function readMailpitCode(addr, since) {
  for (let i = 0; i < 30; i++) {
    const list = await fetch(`${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:${addr}`)}`).then((r) => r.json()).catch(() => null)
    const m = (list?.messages || []).find((x) => new Date(x.Created).getTime() >= since - 2000)
    if (m) {
      const msg = await fetch(`${MAILPIT_URL}/api/v1/message/${m.ID}`).then((r) => r.json())
      const code = /\b(\d{6})\b/.exec(`${msg.Subject} ${msg.Text}`)?.[1]
      if (code) return code
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  return null
}

// Sign in a test account (demo code, or the code mailpit received). Returns {user, session}.
// With mailpit, parallel workers signing in as one account race (each new code replaces the last, and
// the auth server spaces codes ~10s apart): retry with a fresh code.
export async function login(areaOrEmail, { fresh = false } = {}) {
  const addr = areaOrEmail.includes('@') ? areaOrEmail : areaEmail(areaOrEmail)
  if (!isTestEmail(addr)) throw new Error(`refusing to sign in as a non-test account: ${addr}`)
  const hit = sessions.get(addr)
  if (hit && !fresh && hit.session.expires_at * 1000 > Date.now() + 120_000) return hit
  let last = ''
  for (let attempt = 0; attempt < (MAILPIT_URL ? 6 : 1); attempt++) {
    let code = LOGIN_CODE
    if (MAILPIT_URL) {
      if (attempt) await new Promise((r) => setTimeout(r, 4000 + Math.random() * 8000))
      const since = Date.now()
      await fetch(`${API_URL}/api/auth/email/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: addr }) })
      code = await readMailpitCode(addr, since)
      if (!code) { last = 'no login code in mailpit'; continue }
    }
    const r = await fetch(`${API_URL}/api/auth/email/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: addr, code }) })
    if (r.ok) {
      const s = await r.json()
      sessions.set(addr, s)
      return s
    }
    last = `${r.status} ${await r.text()}`
  }
  throw new Error(`login ${addr}: ${last}`)
}

// JSON call; never throws on HTTP status — returns {status, body, headers}
export async function call(token, method, path, body, { headers = {}, raw = false, timeout = 120_000 } = {}) {
  const isBuf = body instanceof Uint8Array || body instanceof ArrayBuffer
  const r = await fetch(`${API_URL}/api${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body != null && !isBuf ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body == null ? undefined : isBuf ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  })
  if (raw) return r
  const text = await r.text()
  let parsed = text
  try { parsed = text ? JSON.parse(text) : null } catch { /* text */ }
  return { status: r.status, body: parsed, headers: r.headers, text }
}

// a client bound to one signed-in account
export function client(s) {
  const tok = () => s.session.access_token
  return {
    s, id: s.user.id, email: s.user.email, token: tok,
    get: (p, o) => call(tok(), 'GET', p, null, o),
    post: (p, b, o) => call(tok(), 'POST', p, b ?? {}, o),
    put: (p, b, o) => call(tok(), 'PUT', p, b ?? {}, o),
    patch: (p, b, o) => call(tok(), 'PATCH', p, b ?? {}, o),
    del: (p, o) => call(tok(), 'DELETE', p, null, o),
  }
}

export async function as(area, opts) { return client(await login(area, opts)) }

// MCP over streamable HTTP (JSON responses): {status, body}
export async function mcp(path, method, params = {}, token) {
  const r = await fetch(`${MCP_URL}${path}`, {
    method: 'POST',
    headers: { ...(token != null ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(180_000),
  })
  const text = await r.text()
  let body = null
  try { body = JSON.parse(text) } catch { const m = /^data: (.*)$/m.exec(text); if (m) body = JSON.parse(m[1]) }
  return { status: r.status, body, text }
}
export const toolText = (res) => (res.body?.result?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n')

// Send a chat message the way the page does (POST /api/threads/:id/messages, SSE back).
// Resolves with every event seen; `done` is the final message the server stored.
export async function sendChat(token, threadId, text, { timeout = 900_000, extra = {} } = {}) {
  const r = await ufetch(`${API_URL}/api/threads/${threadId}/messages`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, ...extra }), signal: AbortSignal.timeout(timeout), dispatcher: patient,
  })
  if (!r.ok) throw new Error(`send ${r.status}`)
  const events = []
  let draft = ''
  const dec = new TextDecoder()
  let buf = ''
  for await (const chunk of r.body) {
    buf += dec.decode(chunk, { stream: true })
    const parts = buf.split('\n\n')
    buf = parts.pop()
    for (const c of parts) {
      const ev = /^event: (.*)$/m.exec(c)?.[1]
      const data = /^data: (.*)$/m.exec(c)?.[1]
      if (!ev || !data) continue
      const d = JSON.parse(data)
      if (ev === 'delta') draft += d.d
      else events.push({ ev, d })
    }
  }
  const done = events.find((e) => e.ev === 'done')?.d || null
  const error = events.find((e) => e.ev === 'error')?.d || null
  return { done, error, draft, events }
}

export async function upload(token, name, type, buf) {
  const r = await call(token, 'POST', '/attachments', buf, { headers: { 'Content-Type': type, 'X-File-Name': encodeURIComponent(name) } })
  if (r.status !== 200) throw new Error(`upload ${name}: ${r.status} ${r.text}`)
  return r.body
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// poll fn() until it returns a truthy value (or time runs out → returns the last value)
export async function until(fn, { timeout = 60_000, every = 1000 } = {}) {
  const end = Date.now() + timeout
  let v
  for (;;) {
    v = await fn().catch((e) => { if (Date.now() > end) throw e; return null })
    if (v || Date.now() > end) return v
    await sleep(every)
  }
}

// which ArtCraft apps the stack under test has (/api/config craft: {app: {web, cli}}). A server that
// does not report it (older build) is taken to have them all. The Docker lite profile has none.
let craftCfg
export async function craftHas(app, need = ['web']) {
  if (craftCfg === undefined) craftCfg = (await call(null, 'GET', '/config').catch(() => null))?.body?.craft || null
  if (!craftCfg) return true
  return need.every((k) => craftCfg[app]?.[k])
}
export const craftSkip = (app, need = ['web']) => `${app} ${need.join('·')} 이(가) 이 설치에 없음 (Docker lite 프로필엔 ArtCraft 앱이 없음 — artcraft/README.md)`
