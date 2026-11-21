// Live co-editing: an ArtCraft app open in the person's page (CraftEditorFrame) is the document the
// agent edits. The page opens a websocket here (one-time ticket, same origin) and says what is open;
// for that (user, app) this server listens on a random 127.0.0.1 port and speaks the app's control
// protocol (newline-delimited JSON, docs/control-protocol.md of each app) to the app's own CLI
// bridge (`<app>-cli mcp --connect/--bridge 127.0.0.1:PORT`, started by mcp/craft.js). Each request
// line goes to the page, which runs it on the app in the iframe (window.<app>.request) and sends
// the reply back. When the page closes the app, craft.js falls back to its headless session.
//
// Who may talk to the port: only the CLI process craft.js started for this live session — the
// peer's socket must belong to that pid (lsof), the port is loopback-only and new per session, and
// PhotoCraft/FilmCraft also get a per-session random token (in the CLI's environment, never argv).
import net from 'node:net'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import express from 'express'
import { WebSocketServer } from 'ws'
import { sameOrigin, originWhy, refuse } from './workroom.js'
import { isEn } from './lang.js'

// how each app's CLI reaches a running app, and how its control port authenticates
export const LIVE_APPS = {
  photocraft: { title: 'PhotoCraft', args: (port) => ['--bridge', `127.0.0.1:${port}`], env: 'PHOTOCRAFT_CONTROL_TOKEN', auth: 'first' },
  vectorcraft: { title: 'VectorCraft', args: (port) => ['--connect', `127.0.0.1:${port}`], auth: 'none' },
  // filmcraft-cli 0.12 sends no token yet (newer ones put it on every line): a token, when sent, must match
  filmcraft: { title: 'FilmCraft', args: (port) => ['--bridge', `127.0.0.1:${port}`], env: 'FILMCRAFT_CONTROL_TOKEN', auth: 'each-if-sent' },
  // newer cadcraft-cli reads the token from `cadcraft-control-<port>.token` in $XDG_RUNTIME_DIR and sends it on
  // every line: each session gets its own owner-only folder with that file (never the person's ~/.cache).
  // cadcraft-cli 0.8.0 sends none yet, so (as for FilmCraft) a token, when sent, must match
  cadcraft: { title: 'CADCraft', args: (port) => ['--connect', `127.0.0.1:${port}`], tokenFile: (port) => `cadcraft-control-${port}.token`, auth: 'each-if-sent' },
  // soundcraft-cli 0.12 sends no token: the pid check alone guards the port
  soundcraft: { title: 'SoundCraft', args: (port) => ['--connect', String(port)], auth: 'none' },
  // IeumOffice (office-host) has its own live sessions and MCP (office_live_*, mcp/office.js): here it is
  // only "what is open" for the agent's context, no control port
  ieumoffice: { title: '이음오피스', presence: true },
}
const OFFICE_KIND = { docs: '워드', sheets: '엑셀', slides: '파워포인트', pdf: 'PDF', hwp: '한글', markdown: '마크다운', html: 'HTML', mindmap: '마인드맵' }
const OFFICE_KIND_EN = { docs: 'Word', sheets: 'Excel', slides: 'PowerPoint', pdf: 'PDF', hwp: 'Hangul', markdown: 'Markdown', html: 'HTML', mindmap: 'mind map' }
const CALL_MS = 58_000 // under the CLIs' own 55–60 s waits, so their error is the one the agent sees
const MAX_LINE = 4 * 1024 * 1024
const MAX_CONN = 4

const lives = new Map() // `${app}:${userId}` → live
export const liveEvents = new EventEmitter() // 'closed' (live)

export function liveFor(userId, app) { return lives.get(`${app}:${userId}`) || null }
// what the person has open right now (the newest live app), for the agent's context
export function liveOpen(userId) {
  let best = null
  for (const l of lives.values()) if (l.userId === userId && (!best || l.since > best.since)) best = l
  return best ? { app: best.app, title: LIVE_APPS[best.app].title, file: best.file, editor: best.editor || null } : null
}
// the document the page says is open (a chat message's openDoc), for when its live link is down:
// the same shape as liveOpen, so the turn still edits it in place — office_live_* go through
// office-host's own sessions and do not need this server's socket
export function openDocOf(x) {
  if (!x || x.app !== 'ieumoffice') return null
  const file = String(x.file || x.name || '').slice(0, 200)
  return file ? { app: 'ieumoffice', title: LIVE_APPS.ieumoffice.title, file, editor: OFFICE_KIND[x.editor] ? x.editor : null, fromPage: true } : null
}

// ---- tickets (spent on use, a minute to live) ----
const tickets = new Map()
function issueTicket(user) {
  for (const [k, v] of tickets) if (v.until < Date.now()) tickets.delete(k)
  const t = crypto.randomBytes(24).toString('base64url')
  tickets.set(t, { userId: user.id, until: Date.now() + 60_000 })
  return t
}
function spendTicket(t) {
  const v = tickets.get(t)
  tickets.delete(t)
  return v && v.until > Date.now() ? v : null
}

export function craftLiveRoutes(auth) {
  const r = express.Router()
  r.post('/craft/live/ticket', auth, (req, res) => res.json({ ticket: issueTicket(req.user) }))
  return r
}

// ---- the peer check: is this TCP connection's other end a socket of one of these pids? ----
// macOS keeps lsof in /usr/sbin, Debian (the Docker image) in /usr/bin
const LSOF = ['/usr/sbin/lsof', '/usr/bin/lsof'].find((p) => fs.existsSync(p)) || 'lsof'
function ownedBy(pids, localPort, remotePort) {
  if (!pids.size) return Promise.resolve(false)
  return new Promise((resolve) => {
    execFile(LSOF,['-nP', '-a', '-p', [...pids].join(','), '-iTCP', '-sTCP:ESTABLISHED', '-Fn'], { timeout: 3000 }, (err, out) => {
      if (err && !out) return resolve(false)
      const want = `n127.0.0.1:${remotePort}->127.0.0.1:${localPort}`
      resolve(String(out).split('\n').some((l) => l.trim() === want))
    })
  })
}
const sameToken = (a, b) => typeof a === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))

function startLive(userId, app, file, ws) {
  const live = {
    id: crypto.randomBytes(8).toString('hex'), userId, app, file, ws, since: Date.now(),
    token: crypto.randomBytes(32).toString('hex'), pids: new Set(), port: 0,
    seq: 0, pending: new Map(), conns: new Set(), closed: false,
  }
  // craft.js registers the pid of the CLI it started for this session
  live.allowPid = (pid) => { if (pid) live.pids.add(pid) }
  live.cliEnv = () => {
    const a = LIVE_APPS[app]
    if (a.tokenFile) {
      if (!live.dir) {
        live.dir = fs.mkdtempSync(path.join(os.tmpdir(), `pgpt-${app}-live-`))
        fs.chmodSync(live.dir, 0o700)
        fs.writeFileSync(path.join(live.dir, a.tokenFile(live.port)), live.token, { mode: 0o600 })
      }
      return { XDG_RUNTIME_DIR: live.dir }
    }
    return a.env ? { [a.env]: live.token } : {}
  }
  live.cliArgs = () => LIVE_APPS[app].args(live.port)
  if (LIVE_APPS[app].presence) {
    live.ready = Promise.resolve()
    live.close = () => {
      if (live.closed) return
      live.closed = true
      if (lives.get(`${app}:${userId}`) === live) lives.delete(`${app}:${userId}`)
      try { liveEvents.emit('closed', live) } catch (e) { console.warn('[craft-live]', e.message) }
    }
    return live
  }

  live.server = net.createServer((sock) => serve(live, sock))
  live.server.maxConnections = MAX_CONN
  live.ready = new Promise((resolve, reject) => {
    live.server.once('error', reject)
    live.server.listen(0, '127.0.0.1', () => { live.port = live.server.address().port; resolve() })
  })
  live.close = () => {
    if (live.closed) return
    live.closed = true
    if (lives.get(`${app}:${userId}`) === live) lives.delete(`${app}:${userId}`)
    for (const p of live.pending.values()) { clearTimeout(p.timer); if (p.sock) reply(p.sock, { id: p.id, ok: false, error: 'the app was closed in the page' }); else p.resolve?.({ error: 'the app was closed in the page' }) }
    live.pending.clear()
    for (const s of live.conns) s.destroy()
    live.server.close()
    if (live.dir) fs.rm(live.dir, { recursive: true, force: true }, () => {})
    try { liveEvents.emit('closed', live) } catch (e) { console.warn('[craft-live]', e.message) }
  }
  return live
}

function reply(sock, obj) { if (!sock.destroyed) sock.write(JSON.stringify(obj) + '\n') }

async function serve(live, sock) {
  const a = LIVE_APPS[live.app]
  const loop = /^(127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(sock.remoteAddress || '')
  // the pid may be registered a moment after the CLI starts: give it a little while
  let mine = false
  for (let i = 0; loop && i < 10 && !mine; i++) {
    mine = await ownedBy(live.pids, live.port, sock.remotePort)
    if (!mine) await new Promise((r) => setTimeout(r, 200))
  }
  if (!mine || live.closed) {
    console.warn(`[craft-live] refused a connection to ${live.app} of user=${live.userId.slice(0, 8)} (not its CLI)`)
    return sock.destroy()
  }
  live.conns.add(sock)
  sock.on('close', () => live.conns.delete(sock))
  sock.on('error', () => {})
  let authed = a.auth !== 'first'
  let buf = ''
  sock.setEncoding('utf8')
  sock.on('data', (chunk) => {
    buf += chunk
    if (buf.length > MAX_LINE) { reply(sock, { ok: false, error: 'line too long, closing the connection' }); return sock.destroy() }
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line) continue
      let m
      try { m = JSON.parse(line) } catch { reply(sock, { ok: false, error: 'not JSON, closing the connection' }); return sock.destroy() }
      if (!m || typeof m !== 'object' || typeof m.method !== 'string') { reply(sock, { ok: false, error: 'no method, closing the connection' }); return sock.destroy() }
      if (a.auth === 'first' && !authed) {
        if (m.method !== 'auth' || !sameToken(m.params?.token, live.token)) { reply(sock, { id: m.id, ok: false, error: 'unauthorized' }); return sock.destroy() }
        authed = true
        reply(sock, { id: m.id, ok: true, result: { authenticated: true } })
        continue
      }
      if (a.auth === 'first' && m.method === 'auth') { reply(sock, { id: m.id, ok: false, error: 'already authenticated' }); continue }
      if ((a.auth === 'each' || (a.auth === 'each-if-sent' && m.token != null)) && !sameToken(m.token, live.token)) { reply(sock, { id: m.id, ok: false, error: 'unauthorized' }); return sock.destroy() }
      forward(live, sock, m)
    }
  })
}

function forward(live, sock, m) {
  if (live.ws.readyState !== 1) return reply(sock, { id: m.id, ok: false, error: 'the page is not connected' })
  const seq = ++live.seq
  const timer = setTimeout(() => {
    live.pending.delete(seq)
    reply(sock, { id: m.id, ok: false, error: 'timeout: no reply from the page in 58s — the command may still apply' })
  }, CALL_MS)
  live.pending.set(seq, { sock, id: m.id, timer, method: m.method })
  console.log(`[craft-live] ${live.app}.${m.method}${m.method === 'engine.execute' ? ` ${m.params?.command || ''}` : ''} user=${live.userId.slice(0, 8)}`)
  live.ws.send(JSON.stringify({ type: 'call', id: seq, method: m.method, params: m.params ?? {} }))
}

// a request from this server itself to the app open in the page (lib/review.js: before/after captures,
// a corrective recolour) — the same channel the CLI bridge uses, answered by the page
export function pageCall(live, method, params = {}, timeoutMs = 30_000) {
  if (!live?.ws || live.ws.readyState !== 1 || LIVE_APPS[live.app]?.presence) return Promise.reject(new Error('no live app'))
  const seq = ++live.seq
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { live.pending.delete(seq); reject(new Error(`${method}: no reply`)) }, timeoutMs)
    live.pending.set(seq, { timer, method, resolve: (m) => (m.error != null ? reject(new Error(String(m.error))) : resolve(m.result ?? null)) })
    live.ws.send(JSON.stringify({ type: 'call', id: seq, method, params }))
  })
}

export function attachCraftLive(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 })
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x')
    if (url.pathname !== '/api/craft/live') return
    // (accepted and closed with 44xx and the reason: a gateway in front hides an HTTP refusal — workroom.js refuse)
    const deny = (code, reason) => refuse(wss, req, socket, head, code, reason)
    if (!sameOrigin(req)) return deny(4403, originWhy(req))
    const ticket = spendTicket(String(url.searchParams.get('ticket') || ''))
    if (!ticket) return deny(4401, '연결 표가 없거나 만료됐어요')
    wss.handleUpgrade(req, socket, head, (ws) => {
      let live = null
      const ping = setInterval(() => { if (ws.readyState === 1) ws.ping() }, 25_000)
      ws.on('message', async (raw) => {
        let m
        try { m = JSON.parse(raw) } catch { return }
        if (m.type === 'open' && !live && LIVE_APPS[m.app]) {
          // the newest page wins: a second tab with the same app takes the session over
          liveFor(ticket.userId, m.app)?.close()
          live = startLive(ticket.userId, m.app, String(m.file || '').slice(0, 200), ws)
          if (m.editor && OFFICE_KIND[m.editor]) live.editor = m.editor
          lives.set(`${m.app}:${ticket.userId}`, live)
          try { await live.ready } catch (e) { ws.send(JSON.stringify({ type: 'error', message: e.message })); return ws.close() }
          ws.send(JSON.stringify({ type: 'live', app: m.app }))
          console.log(`[craft-live] ${m.app} open '${live.file}' user=${ticket.userId.slice(0, 8)} port=${live.port}`)
        } else if (m.type === 'file' && live) {
          live.file = String(m.file || '').slice(0, 200)
        } else if (m.type === 'reply' && live) {
          const p = live.pending.get(m.id)
          if (!p) return
          live.pending.delete(m.id)
          clearTimeout(p.timer)
          if (p.resolve) return p.resolve(m)
          reply(p.sock, m.error != null ? { id: p.id, ok: false, error: String(m.error) } : { id: p.id, ok: true, result: m.result ?? null })
        }
      })
      ws.on('close', () => {
        clearInterval(ping)
        if (live) console.log(`[craft-live] ${live.app} closed user=${live.userId.slice(0, 8)}`)
        live?.close()
      })
    })
  })
}

// What the agent is told while an app or document is open in the page (lib/agent.js delegate): that it is
// open — a system fact, one sentence — and, pinned at the front of the message as /name, the agent skill
// that edits that kind of document (deepagents loads a leading /skill-name before its first call). How to
// edit it with which tool is in that skill (design 4.1–4.2), not here.
const LIVE_SKILL = {
  ieumoffice: 'ieumoffice-live-edit', cadcraft: 'cadcraft-drawing', vectorcraft: 'vectorcraft-graphics',
  photocraft: 'photocraft-image-edit', soundcraft: 'soundcraft-audio', filmcraft: 'filmcraft-video',
}
export const liveSkillOf = (open) => (open ? LIVE_SKILL[open.app] || null : null)
// the pin, unless the message already starts with a command of its own
export function livePin(open, text) {
  const skill = liveSkillOf(open)
  return skill && !String(text || '').trimStart().startsWith('/') ? `/${skill} ` : ''
}
export function liveFact(open) {
  if (!open) return ''
  const where = open.app === 'ieumoffice' ? `${open.title} ${OFFICE_KIND[open.editor] || '문서'} 편집기` : open.title
  const whereEn = open.app === 'ieumoffice' ? `the ${open.title} ${OFFICE_KIND_EN[open.editor] || 'document'} editor` : open.title
  return isEn()
    ? `\n\n(The user has '${open.file || 'a document'}' open in ${whereEn} next to the chat right now; this message may be about that open document.)`
    : `\n\n(사용자가 지금 채팅 옆 ${where}에서 '${open.file || '문서'}' 을 열어 두었어요. 이 메시지는 그 열린 문서에 대한 것일 수 있어요.)`
}
