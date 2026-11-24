// Relayed terminals (lib/localAgents, design docs/local-agents/design.md §5.10): the screen of a CLI that runs in a PTY on someone's
// computer, brought here over that desktop's own link (hub.js) and served to every viewer — web, phone, the owner's own window —
// through agent-share's protocol, the one WorkroomTerminal.vue speaks (input · resize out; session · output · exit in; the scrollback
// replayed on attach, so a second viewer sees the same screen).
//   · Only the CLI's owner (the person whose desktop runs it) types into it: anyone else's input frames are dropped here.
//   · Not tied to a process step: a session has a kind and a ref ('step' → a pro_local_jobs row); a kind says who may open one and who
//     may watch it (registerKind). A developer's session in a repo can be another kind.
//   · The server keeps a screen model per session (@xterm/headless fed by the relayed bytes): screenOf() answers "what is on the screen
//     now" (a watcher can spot a selection prompt the way a tmux watcher reads its pane).
//   · Hook events (the CLI's own --settings hooks) and watched files reach here the same way, and are given to listeners (events).
// One server process holds them in memory (like hub.js presence); a step's last screen is kept on its job when the session ends.
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { WebSocketServer } from 'ws'
import { withTenant } from '../tenant.js'
import { L } from '../lang.js'

let Headless = null
try { Headless = createRequire(import.meta.url)('@xterm/headless').Terminal } catch (e) { console.warn('[local-agents] no screen model: @xterm/headless did not load —', e.message.split('\n')[0]) }

const SCROLLBACK = 400 * 1024
const HOOKS_KEPT = 100
const FILE_MAX = 256 * 1024
const TICKET_MS = 60_000
// how long a session stays in memory once its CLI ended (viewers that are on keep its screen; later ones get the job's kept screen —
// a kind's stored()), and once its desktop went away without coming back
const limits = { keepMs: Number(process.env.PRO_LOCAL_TERM_KEEP_MS || 10 * 60_000), detachMs: Number(process.env.PRO_LOCAL_TERM_DETACH_MS || 60 * 60_000) }
export function setLimits(next = {}) { const was = { ...limits }; Object.assign(limits, next); return was }
const SID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const events = new EventEmitter() // 'open' · 'hook' · 'files' · 'exit' — ({tenant, sid, kind, ref, userId, …})
events.setMaxListeners(50)
const sessions = new Map() // `${tenant}:${sid}` → session
const kinds = new Map()    // kind → { open(link, ref), view(user, ref), opened(S), exit(S), stored(ref) }
export function registerKind(kind, spec) { kinds.set(kind, spec) }

const keyOf = (tenant, sid) => `${tenant}:${sid}`
const send = (ws, m) => { if (ws.readyState === 1) ws.send(JSON.stringify(m)) }
const broadcast = (S, m) => { for (const ws of S.viewers) send(ws, m) }

export const get = (tenant, sid) => sessions.get(keyOf(tenant, String(sid || ''))) || null
// the newest session of a kind's ref (a step's run: its job id)
export function find(tenant, kind, ref) {
  let best = null
  for (const S of sessions.values()) if (S.tenant === tenant && S.kind === kind && S.ref === String(ref) && (!best || S.openedAt > best.openedAt)) best = S
  return best
}

// ---------- what a desktop sends ----------
const RELAY = new Set(['term-open', 'pty', 'term-session', 'term-exit', 'hook', 'files'])
export const handles = (msg) => RELAY.has(msg?.type)
export async function receive(link, msg) {
  const sid = String(msg.sid || '')
  if (!SID.test(sid)) return
  let S = get(link.tenant, sid)
  if (msg.type === 'term-open') {
    const kind = String(msg.kind || '')
    const spec = kinds.get(kind)
    const ref = String(msg.ref || '').slice(0, 200)
    if (!spec || !(await spec.open(link, ref).catch(() => false))) { console.warn(`[local-agents] ${link.name}: a terminal of kind ${kind} it may not open`); return }
    if (S && S.userId !== link.userId) return
    const fresh = !S
    if (!S) {
      S = { tenant: link.tenant, sid, kind, ref, userId: link.userId, deviceId: link.id, deviceName: link.name, agent: String(msg.agent || '').slice(0, 20),
        cli: msg.cli ? String(msg.cli).slice(0, 100) : null, cols: clamp(msg.cols, 20, 400, 100), rows: clamp(msg.rows, 5, 200, 30), buf: '', viewers: new Set(),
        screen: null, hooks: [], files: new Map(), exited: false, code: null, dropped: 0, inputs: 0, openedAt: Date.now() }
      if (Headless) S.screen = new Headless({ cols: S.cols, rows: S.rows, scrollback: 2000, allowProposedApi: true })
      sessions.set(keyOf(S.tenant, sid), S)
    }
    S.link = link
    S.detached = false
    clearTimeout(S.dropTimer)
    // (a restarted server, or a link that came back: the desktop sends its screen so far)
    if (typeof msg.replay === 'string' && msg.replay && !S.buf) feed(S, msg.replay, false)
    if (msg.exited) S.exited = true
    if (fresh) { await spec.opened?.(S).catch((e) => console.warn('[local-agents] opened', e.message)); events.emit('open', view(S)) }
    broadcast(S, { type: 'attached' })
    return
  }
  if (!S || S.userId !== link.userId || S.deviceId !== link.id) return
  S.link = link
  if (msg.type === 'pty') { if (typeof msg.data === 'string') feed(S, msg.data, true); return }
  if (msg.type === 'term-session') { S.cli = msg.cli ? String(msg.cli).slice(0, 100) : S.cli; return }
  if (msg.type === 'term-exit') {
    S.exited = true
    S.code = Number.isFinite(msg.code) ? msg.code : null
    broadcast(S, { type: 'exit', code: S.code })
    await kinds.get(S.kind)?.exit?.(S).catch((e) => console.warn('[local-agents] term exit', e.message))
    events.emit('exit', { ...view(S), code: S.code })
    later(S, limits.keepMs)
    return
  }
  if (msg.type === 'hook') {
    const h = { event: String(msg.event || '').slice(0, 40), data: msg.data && typeof msg.data === 'object' ? msg.data : {}, at: new Date().toISOString() }
    S.hooks.push(h)
    if (S.hooks.length > HOOKS_KEPT) S.hooks.splice(0, S.hooks.length - HOOKS_KEPT)
    events.emit('hook', { ...view(S), ...h })
    return
  }
  if (msg.type === 'files') {
    const changed = []
    for (const f of (Array.isArray(msg.files) ? msg.files : []).slice(0, 200)) {
      const p = String(f?.path || '').replace(/\\/g, '/')
      if (!p || p.startsWith('/') || p.split('/').includes('..')) continue
      if (f.deleted) S.files.delete(p)
      else S.files.set(p, { content: typeof f.content === 'string' ? f.content.slice(0, FILE_MAX) : null, size: Number(f.size) || 0, mtime: Number(f.mtime) || 0, at: Date.now() })
      changed.push(p)
    }
    if (changed.length) events.emit('files', { ...view(S), paths: changed })
  }
}
function feed(S, data, live) {
  S.buf = (S.buf + data).slice(-SCROLLBACK)
  S.screen?.write(data)
  if (live) broadcast(S, { type: 'output', data })
}
const clamp = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.max(lo, Math.min(hi, Number(v) | 0)) : d)
const view = (S) => ({ tenant: S.tenant, sid: S.sid, kind: S.kind, ref: S.ref, userId: S.userId, agent: S.agent, cli: S.cli })

// a desktop went away: its terminals stay (the screen so far), marked detached until it is back — or dropped when it is not back in a while
export function linkGone(link) {
  for (const S of sessions.values()) if (S.link === link && !S.exited) { S.detached = true; broadcast(S, { type: 'detached' }); later(S, limits.detachMs) }
}

// a session out of memory: its screen model disposed, its viewers closed (a viewer that comes later opens the kept screen)
function later(S, ms) {
  clearTimeout(S.dropTimer)
  S.dropTimer = setTimeout(() => drop(S), ms)
  S.dropTimer.unref?.()
}
function drop(S) {
  if (sessions.get(keyOf(S.tenant, S.sid)) !== S) return
  sessions.delete(keyOf(S.tenant, S.sid))
  for (const ws of S.viewers) try { ws.close(1000, 'ended') } catch { /* gone */ }
  S.viewers.clear()
  try { S.screen?.dispose() } catch { /* fine */ }
  S.screen = null
  S.buf = ''
}

// the screen model has parsed every byte so far (it parses asynchronously)
export const flushed = (S) => new Promise((resolve) => { if (S?.screen) S.screen.write('', resolve); else resolve() })
// "what is on the screen now": the visible rows of the screen model (after flushed) (or, without one, the tail of the scrollback without escapes)
export function screenOf(S) {
  if (!S) return null
  if (S.screen) {
    const b = S.screen.buffer.active
    const lines = []
    for (let y = 0; y < S.rows; y++) lines.push(b.getLine(b.viewportY + y)?.translateToString(true) ?? '')
    return { cols: S.cols, rows: S.rows, cursor: { x: b.cursorX, y: b.cursorY }, lines, exited: S.exited }
  }
  // eslint-disable-next-line no-control-regex
  const plain = S.buf.slice(-8000).replace(/\x1b\[[0-9;?>]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '').replace(/\r/g, '')
  return { cols: S.cols, rows: S.rows, cursor: null, lines: plain.split('\n').slice(-S.rows), exited: S.exited }
}
export const hooksOf = (S) => (S ? S.hooks.slice() : [])
export const filesOf = (S) => (S ? Object.fromEntries(S.files) : {})
export const stats = (S) => (S ? { viewers: S.viewers.size, inputs: S.inputs, dropped: S.dropped, bytes: S.buf.length, exited: S.exited, detached: !!S.detached } : null)

// ---------- input from a viewer ----------
// only the owner's reaches the desktop; anyone else's is dropped (counted)
export function input(S, userId, data) {
  if (!S || typeof data !== 'string' || !data) return false
  if (String(userId) !== S.userId || S.exited) { S.dropped++; return false }
  S.inputs++
  return !!S.link?.send({ type: 'pty-input', sid: S.sid, data: data.slice(0, 64 * 1024), byId: S.userId })
}
export function resize(S, userId, cols, rows) {
  if (!S || String(userId) !== S.userId || S.exited) return false
  const c = clamp(cols, 20, 400, S.cols), r = clamp(rows, 5, 200, S.rows)
  if (c === S.cols && r === S.rows) return true
  S.cols = c; S.rows = r
  try { S.screen?.resize(c, r) } catch { /* fine */ }
  S.link?.send({ type: 'pty-resize', sid: S.sid, cols: c, rows: r })
  broadcast(S, { type: 'size', cols: c, rows: r })
  return true
}

// ---------- viewers ----------
// A viewer opens with a one-time ticket the page fetched a moment before (signed in, allowed to see that kind's ref) — the sign-in
// token never goes into a websocket address (as the workroom's terminals).
const tickets = new Map()
export function issueTicket(user, { kind, ref, tenant }) {
  for (const [k, v] of tickets) if (v.until < Date.now()) tickets.delete(k)
  const t = crypto.randomBytes(24).toString('base64url')
  tickets.set(t, { userId: String(user.id), kind, ref: String(ref), tenant, until: Date.now() + TICKET_MS })
  return t
}
function spend(t) { const v = tickets.get(t); tickets.delete(t); return v && v.until > Date.now() ? v : null }

export function attach(server, { path = '/api/local-agents/term' } = {}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 })
  server.on('upgrade', async (req, socket, head) => {
    let url
    try { url = new URL(req.url, 'http://x') } catch { return }
    if (url.pathname !== path && !url.pathname.endsWith(path)) return
    const W = await import('../workroom.js')
    const deny = (code, reason) => W.refuse(wss, req, socket, head, code, reason)
    if (!W.sameOrigin(req)) return deny(4403, W.originWhy(req))
    const t = spend(String(url.searchParams.get('ticket') || ''))
    if (!t) return deny(4401, L('터미널 연결 표가 없거나 만료됐어요', 'The terminal ticket is missing or expired'))
    const S = find(t.tenant, t.kind, t.ref)
    const stored = S ? null : await withTenant(t.tenant, () => kinds.get(t.kind)?.stored?.(t.ref)).catch(() => null)
    if (!S && !stored) return deny(4404, L('아직 이 실행의 터미널이 없어요', 'This run has no terminal yet'))
    wss.handleUpgrade(req, socket, head, (ws) => serve(ws, t, S, stored))
  })
  return wss
}
function serve(ws, t, S, stored) {
  if (!S) {
    // the run ended before this server's restart: its last screen, read only
    send(ws, { type: 'session', mode: 'local', owner: false, live: false, cols: stored.cols || 100, rows: stored.rows || 30, agent: stored.agent || null })
    if (stored.buf) send(ws, { type: 'output', data: stored.buf, replay: true })
    send(ws, { type: 'exit', code: null })
    return
  }
  const owner = t.userId === S.userId
  S.viewers.add(ws)
  send(ws, { type: 'session', mode: 'local', owner, live: !S.exited, detached: !!S.detached, cols: S.cols, rows: S.rows, agent: S.agent, device: S.deviceName })
  if (S.buf) send(ws, { type: 'output', data: S.buf, replay: true })
  if (S.exited) send(ws, { type: 'exit', code: S.code })
  ws.on('message', (raw) => {
    let m
    try { m = JSON.parse(raw) } catch { return }
    if (m.type === 'input') input(S, t.userId, m.data)
    else if (m.type === 'resize') resize(S, t.userId, m.cols, m.rows)
  })
  ws.on('close', () => S.viewers.delete(ws))
}

// (tests)
export function reset() { for (const S of [...sessions.values()]) { clearTimeout(S.dropTimer); drop(S) } sessions.clear(); tickets.clear() }
