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
//   · The conversation (design §5.11): the CLI's own records, as small items the desktop reads from its session jsonl · rollout
//     (desktop/src/runner/transcript.js) — kept here per session within the same kind of bounds as the bytes, replayed to a viewer of the
//     「대화」 view, and what the CLI asks (a permission, a choice) answered by its owner only (answer → the keys, on the desktop).
//   · A viewer may come before the terminal is open (the run card shows as soon as the run is sent): it waits here for it (pending).
// One server process holds them in memory (like hub.js presence); a step's last screen and its conversation are kept on its job when the
// session ends — the screen as it was at the last turn's end (term-keep), not the one the CLI leaves when it is closed.
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
const TX_KINDS = new Set(['user', 'text', 'thinking', 'tool', 'result', 'note', 'turn', 'ask', 'ask-done'])
const ITEM_MAX = 64 * 1024
const PARK_MS = 10 * 60_000
const FILE_MAX = 256 * 1024
const TICKET_MS = 60_000
// how long a session stays in memory once its CLI ended (viewers that are on keep its screen; later ones get the job's kept screen —
// a kind's stored()), and once its desktop went away without coming back
// how much of a session's conversation is kept (items · bytes; the oldest go first)
const limits = { keepMs: Number(process.env.PRO_LOCAL_TERM_KEEP_MS || 10 * 60_000), detachMs: Number(process.env.PRO_LOCAL_TERM_DETACH_MS || 60 * 60_000),
  txItems: Number(process.env.PRO_LOCAL_TX_ITEMS || 2000), txBytes: Number(process.env.PRO_LOCAL_TX_BYTES || 1536 * 1024) }
export function setLimits(next = {}) { const was = { ...limits }; Object.assign(limits, next); return was }
const SID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const events = new EventEmitter() // 'open' · 'hook' · 'files' · 'exit' — ({tenant, sid, kind, ref, userId, …})
events.setMaxListeners(50)
const sessions = new Map() // `${tenant}:${sid}` → session
const kinds = new Map()    // kind → { open(link, ref), view(user, ref), opened(S), exit(S), stored(ref), pending(ref) }
const parked = new Map()   // `${tenant}:${kind}:${ref}` → Set of {ws, t, streams} — viewers that came before the terminal
export function registerKind(kind, spec) { kinds.set(kind, spec) }

const keyOf = (tenant, sid) => `${tenant}:${sid}`
const send = (ws, m) => { if (ws.readyState === 1) ws.send(JSON.stringify(m)) }
// to every viewer — or only to those who follow that stream ('term': the bytes · 'tx': the conversation)
const broadcast = (S, m, stream = null) => { for (const ws of S.viewers) if (!stream || ws.streams?.has(stream)) send(ws, m) }

export const get = (tenant, sid) => sessions.get(keyOf(tenant, String(sid || ''))) || null
// the newest session of a kind's ref (a step's run: its job id)
export function find(tenant, kind, ref) {
  let best = null
  for (const S of sessions.values()) if (S.tenant === tenant && S.kind === kind && S.ref === String(ref) && (!best || S.openedAt > best.openedAt)) best = S
  return best
}

// ---------- what a desktop sends ----------
const RELAY = new Set(['term-open', 'pty', 'term-session', 'term-exit', 'hook', 'files', 'tx', 'term-keep', 'answer-failed'])
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
        screen: null, hooks: [], files: new Map(), exited: false, code: null, dropped: 0, inputs: 0, openedAt: Date.now(), tx: [], txBytes: 0, asks: new Map(), kept: null }
      if (Headless) S.screen = new Headless({ cols: S.cols, rows: S.rows, scrollback: 2000, allowProposedApi: true })
      sessions.set(keyOf(S.tenant, sid), S)
    }
    S.link = link
    S.detached = false
    clearTimeout(S.dropTimer)
    // (a restarted server, or a link that came back: the desktop sends its screen so far)
    if (typeof msg.replay === 'string' && msg.replay && !S.buf) feed(S, msg.replay, false)
    if (msg.exited) S.exited = true
    if (fresh) {
      // (viewers that came before the terminal was open: served now)
      const k = `${S.tenant}:${S.kind}:${S.ref}`
      for (const v of parked.get(k) || []) { clearTimeout(v.timer); v.ws.off('message', v.onMsg); v.ws.off('close', v.onClose); if (v.ws.readyState === 1) serve(v.ws, v.t, S, null, v.streams) }
      parked.delete(k)
      await spec.opened?.(S).catch((e) => console.warn('[local-agents] opened', e.message)); events.emit('open', view(S))
    }
    broadcast(S, { type: 'attached' })
    return
  }
  if (!S || S.userId !== link.userId || S.deviceId !== link.id) return
  S.link = link
  if (msg.type === 'pty') { if (typeof msg.data === 'string') feed(S, msg.data, true); return }
  if (msg.type === 'term-session') { S.cli = msg.cli ? String(msg.cli).slice(0, 100) : S.cli; return }
  if (msg.type === 'tx') {
    const added = pushTx(S, msg.items, { replay: !!msg.replay })
    if (added.length) broadcast(S, { type: 'tx', items: added }, 'tx')
    return
  }
  // the screen to keep (a turn ended; the run is about to close the CLI): a snapshot of the screen model as it is now
  if (msg.type === 'term-keep') { await flushed(S); S.kept = { data: snapshot(S), cols: S.cols, rows: S.rows, at: Date.now() }; return }
  if (msg.type === 'answer-failed') { broadcast(S, { type: 'answer-failed', ask: String(msg.ask || '').slice(0, 60), reason: String(msg.reason || '').slice(0, 40) }); return }
  if (msg.type === 'term-exit') {
    S.exited = true
    S.code = Number.isFinite(msg.code) ? msg.code : null
    S.asks.clear()
    // (the screen a viewer keeps is the one kept at the last turn's end — the CLI clears its own on its way out)
    if (S.kept) {
      await flushed(S)
      S.buf = S.kept.data
      try { S.screen?.reset(); S.screen?.write(S.buf) } catch { /* fine */ }
      broadcast(S, { type: 'output', data: S.buf, replay: true }, 'term')
    }
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
  if (live) broadcast(S, { type: 'output', data }, 'term')
}

// ---------- the conversation ----------
// items from the desktop (transcript.js · session.js): checked for shape and size, kept within the bounds (the oldest go first), what the
// CLI asks followed (an ask is open until its ask-done) → the items added
export function pushTx(S, items, { replay = false } = {}) {
  if (!S || !Array.isArray(items)) return []
  // (a desktop that announces its session again sends all it has: only what this server does not have yet is taken)
  const have = replay && S.tx.length ? new Set(S.tx.map((x) => x.id)) : null
  const added = []
  for (const raw of items.slice(0, 1000)) {
    if (!raw || typeof raw !== 'object' || !TX_KINDS.has(raw.t)) continue
    const it = { ...raw, id: String(raw.id || '').slice(0, 120) }
    if (!it.id || have?.has(it.id)) continue
    const size = Buffer.byteLength(JSON.stringify(it))
    if (size > ITEM_MAX) continue
    it._n = size
    S.tx.push(it)
    S.txBytes += size
    added.push(it)
    if (it.t === 'ask' && it.ask?.id) S.asks.set(String(it.ask.id), it.ask)
    else if (it.t === 'ask-done') S.asks.delete(String(it.ask || ''))
  }
  while (S.tx.length > limits.txItems || S.txBytes > limits.txBytes) S.txBytes -= S.tx.shift()._n || 0
  return added.map(bare)
}
const bare = ({ _n, ...it }) => it
export const txOf = (S) => (S ? S.tx.map(bare) : [])
export const asksOf = (S) => (S ? [...S.asks.values()] : [])
// the conversation to keep with a finished run: the newest items within bytes
export function txToKeep(S, bytes = 512 * 1024) {
  const out = []
  let n = 0
  for (let i = (S?.tx.length || 0) - 1; i >= 0; i--) { n += S.tx[i]._n || 0; if (n > bytes) break; out.unshift(bare(S.tx[i])) }
  return out
}

// The screen as it is now, as bytes a terminal can be given again (the last 300 lines of the screen model, with their colours and
// attributes) — what a run keeps as its last screen. (Without a screen model: the tail of the bytes.)
const sgr = (c) => {
  const p = []
  if (c.isBold()) p.push(1)
  if (c.isDim()) p.push(2)
  if (c.isItalic()) p.push(3)
  if (c.isUnderline()) p.push(4)
  if (c.isInverse()) p.push(7)
  const col = (rgb, pal, v, base, bright, ext) => { if (rgb) p.push(`${ext};2;${(v >> 16) & 255};${(v >> 8) & 255};${v & 255}`); else if (pal) p.push(v < 8 ? base + v : v < 16 ? bright + v - 8 : `${ext};5;${v}`) }
  col(c.isFgRGB(), c.isFgPalette(), c.getFgColor(), 30, 90, 38)
  col(c.isBgRGB(), c.isBgPalette(), c.getBgColor(), 40, 100, 48)
  return p.length ? `;${p.join(';')}` : ''
}
export function snapshot(S, lines = 300) {
  if (!S?.screen) return String(S?.buf || '').slice(-64 * 1024)
  const b = S.screen.buffer.active
  let last = b.length - 1
  while (last > 0 && !(b.getLine(last)?.translateToString(true) || '').trim()) last--
  const first = Math.max(0, last - lines + 1)
  const rows = []
  let cell
  for (let y = first; y <= last; y++) {
    const line = b.getLine(y)
    if (!line) continue
    let row = ''
    let prev = ''
    for (let x = 0; x < line.length; x++) {
      cell = line.getCell(x, cell)
      if (!cell || cell.getWidth() === 0) continue
      const a = sgr(cell)
      if (a !== prev) { row += `\x1b[0${a}m`; prev = a }
      row += cell.getChars() || ' '
    }
    const wrapsOn = !!b.getLine(y + 1)?.isWrapped
    if (!wrapsOn && !prev) row = row.replace(/ +$/, '')
    rows.push({ row: `${row}${prev ? '\x1b[0m' : ''}`, wrapsOn })
  }
  let out = ''
  for (const r of rows) out += r.row + (r.wrapsOn ? '' : '\r\n')
  // (at most 64 KB, cut at a line)
  while (out.length > 64 * 1024 && out.includes('\r\n')) out = out.slice(out.indexOf('\r\n') + 2)
  return out.replace(/(\r\n)+$/, '')
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
  S.tx = []
  S.txBytes = 0
  S.asks.clear()
  S.kept = null
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
export const stats = (S) => (S ? { viewers: S.viewers.size, inputs: S.inputs, dropped: S.dropped, bytes: S.buf.length, exited: S.exited, detached: !!S.detached,
  items: S.tx.length, itemBytes: S.txBytes, asks: S.asks.size, kept: !!S.kept } : null)

// ---------- input from a viewer ----------
// only the owner's reaches the desktop; anyone else's is dropped (counted)
export function input(S, userId, data) {
  if (!S || typeof data !== 'string' || !data) return false
  if (String(userId) !== S.userId || S.exited) { S.dropped++; return false }
  S.inputs++
  return !!S.link?.send({ type: 'pty-input', sid: S.sid, data: data.slice(0, 64 * 1024), byId: S.userId })
}
// the owner's answer to what the CLI asks — only theirs, only while that ask is open; the desktop turns it into the keys (prompts.js)
// → true · 'forbidden' · 'closed' · 'offline'
export function answer(S, userId, askId, value, { by = '' } = {}) {
  if (!S || String(userId) !== S.userId || S.exited) { if (S) S.dropped++; return 'forbidden' }
  const id = String(askId || '')
  if (!S.asks.has(id)) return 'closed'
  return S.link?.send({ type: 'pty-answer', sid: S.sid, ask: id, answer: value, byId: S.userId, by: String(by || '').slice(0, 60) }) ? true : 'offline'
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
    // what the viewer follows: the terminal's bytes, the conversation, or both (more can be asked for on the socket — subscribe)
    const streams = streamsOf(url.searchParams.get('streams'))
    const S = find(t.tenant, t.kind, t.ref)
    const stored = S ? null : await Promise.resolve().then(() => withTenant(t.tenant, () => kinds.get(t.kind)?.stored?.(t.ref))).catch(() => null)
    if (!S && !stored) {
      // a run sent to its desktop that has not opened its terminal yet: the viewer waits for it (the card shows the run at once)
      const pending = await Promise.resolve().then(() => withTenant(t.tenant, () => kinds.get(t.kind)?.pending?.(t.ref))).catch(() => false)
      if (!pending) return deny(4404, L('아직 이 실행의 터미널이 없어요', 'This run has no terminal yet'))
      return wss.handleUpgrade(req, socket, head, (ws) => park(ws, t, streams))
    }
    wss.handleUpgrade(req, socket, head, (ws) => serve(ws, t, S, stored, streams))
  })
  return wss
}
const streamsOf = (v) => { const s = new Set(String(v || 'term').split(',').map((x) => x.trim()).filter((x) => x === 'term' || x === 'tx')); return s.size ? s : new Set(['term']) }
function park(ws, t, streams) {
  const k = `${t.tenant}:${t.kind}:${t.ref}`
  const v = { ws, t, streams }
  if (!parked.has(k)) parked.set(k, new Set())
  parked.get(k).add(v)
  send(ws, { type: 'waiting' })
  v.timer = setTimeout(() => { try { ws.close(1000, 'no terminal') } catch { /* gone */ } }, PARK_MS)
  v.timer.unref?.()
  v.onMsg = (raw) => { try { const m = JSON.parse(raw); if (m.type === 'subscribe') for (const x of streamsOf((m.streams || []).join(','))) v.streams.add(x) } catch { /* not json */ } }
  v.onClose = () => { clearTimeout(v.timer); parked.get(k)?.delete(v); if (!parked.get(k)?.size) parked.delete(k) }
  ws.on('message', v.onMsg)
  ws.on('close', v.onClose)
}
// what a viewer is sent of a stream when it starts following it: the screen so far · the conversation so far
function replay(ws, S, stored, stream) {
  if (stream === 'term') { const buf = S ? S.buf : stored?.buf; if (buf) send(ws, { type: 'output', data: buf, replay: true }) }
  if (stream === 'tx') send(ws, { type: 'tx', items: S ? txOf(S) : (Array.isArray(stored?.tx) ? stored.tx : []), replay: true })
}
function serve(ws, t, S, stored, streams = new Set(['term'])) {
  ws.streams = new Set(streams)
  if (!S) {
    // the run ended before this server's restart (or it left memory): its last screen and its conversation, read only
    send(ws, { type: 'session', mode: 'local', owner: false, live: false, cols: stored.cols || 100, rows: stored.rows || 30, agent: stored.agent || null })
    for (const x of ws.streams) replay(ws, null, stored, x)
    send(ws, { type: 'exit', code: null })
    ws.on('message', (raw) => { try { const m = JSON.parse(raw); if (m.type === 'subscribe') for (const x of streamsOf((m.streams || []).join(','))) if (!ws.streams.has(x) || m.replay) { ws.streams.add(x); replay(ws, null, stored, x) } } catch { /* not json */ } })
    return
  }
  const owner = t.userId === S.userId
  S.viewers.add(ws)
  send(ws, { type: 'session', mode: 'local', owner, live: !S.exited, detached: !!S.detached, cols: S.cols, rows: S.rows, agent: S.agent, device: S.deviceName })
  for (const x of ws.streams) replay(ws, S, null, x)
  if (S.exited) send(ws, { type: 'exit', code: S.code })
  ws.on('message', (raw) => {
    let m
    try { m = JSON.parse(raw) } catch { return }
    if (m.type === 'input') input(S, t.userId, m.data)
    else if (m.type === 'resize') resize(S, t.userId, m.cols, m.rows)
    // (a view that shows now follows its stream from the start; replay: a view mounted again gets it again)
    else if (m.type === 'subscribe') for (const x of streamsOf((m.streams || []).join(','))) if (!ws.streams.has(x) || m.replay) { ws.streams.add(x); replay(ws, S, null, x) }
  })
  ws.on('close', () => S.viewers.delete(ws))
}

// (tests)
export function reset() {
  for (const S of [...sessions.values()]) { clearTimeout(S.dropTimer); drop(S) }
  sessions.clear(); tickets.clear()
  for (const set of parked.values()) for (const v of set) { clearTimeout(v.timer); try { v.ws.close() } catch { /* gone */ } }
  parked.clear()
}
