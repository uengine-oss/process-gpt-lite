// A browser on the person's own PC, driven over their desktop's link (lib/localAgents/hub.js — the one outgoing WebSocket the
// desktop keeps; no port opens on the PC). The server's browser agent (lib/browser.js) keeps its loop here — the model, the judge,
// the vault, the skills, the cards — and only the page operations go to the desktop (lib/browserRemote.js): a fixed set of named
// operations the desktop runs with its own code (desktop/src/browser) — never code or commands the server sends.
//   server → desktop  {type:'browser', id, op, args}
//   desktop → server  {type:'browser-reply', id, ok, value | error, at:{url, title, vp, tab}}   (every answer says where the page is now)
//                     {type:'browser-frame', data, url}                                       (the live view, at most LIVE.minMs apart)
//                     {type:'browser-event', kind:'download' | 'moved' | 'shown' | 'hidden', …}
//   either way        {type:'browser-part', mid, n, of, b}   — a message over WHOLE bytes, in pieces of PART bytes of its UTF-8 (b: those
//                     bytes in base64): the hub's link takes at most 1 MB a message, counted in bytes — a page's Korean text is three
//                     bytes a letter (2026-11-25 review: 400K letters went whole as 1.2 MB and the link was closed with 1009)
// Pieces are taken only from a link that a browser task holds now (its driver between begin and idle — not one that ran a task once —
// or a call waiting on it), at most OPEN messages at once per link, MAX_MESSAGE bytes per link and MAX_TOTAL across all links — linked
// desktops must not fill this server's memory (2026-11-25 review: 400 pieces of a never-finished message grew it by 389 MB; re-review:
// the cap was per link only). What is dropped is said in the log at most once a minute per link.
// Only the link the call names gets it: a driver is bound to one link, which is one person on one device (devices.js), and the
// person is checked against the task's (lib/browserRemote.js). Arguments (a vault value for one fill among them) are never logged.
import crypto from 'node:crypto'

export const WHOLE = 900 * 1024 // a message up to this many bytes goes whole
export const PART = 600 * 1024 // bytes of a piece (800 KB as base64, with its frame well under 1 MB)
// bytes of all the messages in pieces of one link at once (a 50 MB download is ≈ 67 MB of base64 in its JSON); tests make it small
export const MAX_MESSAGE = Number(process.env.PRO_LOCAL_BROWSER_MAX_MESSAGE) > 0 ? Number(process.env.PRO_LOCAL_BROWSER_MAX_MESSAGE) : 72 * 1024 * 1024
export const MAX_PARTS = Math.ceil(MAX_MESSAGE / PART)
// bytes in pieces across every link at once (two 50 MB downloads in flight); tests make it small
export const MAX_TOTAL = Number(process.env.PRO_LOCAL_BROWSER_MAX_TOTAL) > 0 ? Number(process.env.PRO_LOCAL_BROWSER_MAX_TOTAL) : 2 * MAX_MESSAGE
let total = 0 // bytes in pieces now, all links
const gone = new Map() // `${linkKey}:${mid}` of a message dropped for its size → when (its later pieces are not taken up again)
const warned = new Map() // `${linkKey}:${kind}` → when it was last said
function warn(link, kind, text) {
  const k = `${keyOf(link)}:${kind}`
  const now = Date.now()
  if (now - (warned.get(k) || 0) < 60_000) return
  warned.set(k, now)
  if (warned.size > 1000) warned.delete(warned.keys().next().value)
  console.warn(`[local-browser] ${link.name}: ${text}`)
}
export const OPEN = 2 // messages in pieces at once, per link
const PART_MS = 120_000
const KINDS = new Set(['browser-reply', 'browser-frame', 'browser-event', 'browser-part'])
export const handles = (msg) => KINDS.has(msg?.type)

// A call that cannot be answered any more: the link it went over closed (the desktop went off, the app quit, the PC slept).
export class LinkLost extends Error {
  constructor(name = '') { super(`the browser on ${name || 'the PC'} is not linked any more (the desktop app went off)`); this.lost = true }
}

// (each link object its own key: the same device's newer link is another — a late close of the old one touches only its own)
const keyOf = (link) => (link.__blKey ||= crypto.randomBytes(8).toString('hex'))
const pending = new Map() // `${linkKey}:${id}` → {resolve, reject, timer, link}
const bound = new Map() // linkKey → the driver that link's frames and events go to
const inbox = new Map() // linkKey → { open: Map(mid → {of, got: [], have, size, timer}), size }
const waiters = new Set() // {tenant, userId, deviceId, resolve}

// a message to a link, in pieces when it is long
export function send(link, msg) {
  const text = JSON.stringify(msg)
  if (Buffer.byteLength(text) <= WHOLE) return link.send(msg)
  const buf = Buffer.from(text)
  const mid = crypto.randomBytes(8).toString('hex')
  const of = Math.ceil(buf.length / PART)
  for (let n = 0; n < of; n++) if (!link.send({ type: 'browser-part', mid, n, of, b: buf.subarray(n * PART, (n + 1) * PART).toString('base64') })) return false
  return true
}

// One operation on the desktop's browser → its value. Rejects with LinkLost when the link closes meanwhile, a StepError-like
// timeout when the desktop does not answer within timeoutMs, and at once when signal aborts (the desktop may go on with it).
export function call(link, op, args = {}, { timeoutMs = 15000, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (link.closedAt) return reject(new LinkLost(link.name))
    if (signal?.aborted) return reject(Object.assign(new Error(`${op}: stopped`), { stopped: true }))
    const id = crypto.randomUUID()
    const key = `${keyOf(link)}:${id}`
    const done = (fn, v) => {
      const p = pending.get(key)
      if (!p) return
      pending.delete(key)
      clearTimeout(p.timer)
      signal?.removeEventListener('abort', p.onAbort)
      fn(v)
    }
    const onAbort = () => done(reject, Object.assign(new Error(`${op}: stopped`), { stopped: true }))
    const timer = setTimeout(() => done(reject, Object.assign(new Error(`${op} took longer than ${Math.round(timeoutMs / 1000)} s on the PC`), { timeout: true })), timeoutMs)
    timer.unref?.()
    pending.set(key, { resolve: (v) => done(resolve, v), reject: (e) => done(reject, e), timer, link, onAbort })
    signal?.addEventListener('abort', onAbort, { once: true })
    if (!send(link, { type: 'browser', id, op, args })) done(reject, new LinkLost(link.name))
  })
}

// the driver a link's frames and events go to (one at a time per link)
export function bind(link, driver) { bound.set(keyOf(link), driver) }
export function unbind(link, driver) { if (bound.get(keyOf(link)) === driver) bound.delete(keyOf(link)) }
export const boundTo = (link) => bound.get(keyOf(link)) || null
// a browser task holds this link's browser now (or a call on it waits for its answer): pieces from it are taken
const inUse = (link) => {
  if (bound.get(keyOf(link))?.holding) return true
  for (const p of pending.values()) if (p.link === link) return true
  return false
}

function dropMessage(box, mid) {
  const b = box.open.get(mid)
  if (!b) return
  clearTimeout(b.timer)
  box.size -= b.size
  total -= b.size
  box.open.delete(mid)
}

// a piece → the whole message once all have come (or null)
function takePart(link, msg) {
  const mid = String(msg.mid || '').slice(0, 40)
  const of = Number(msg.of) | 0, n = Number(msg.n) | 0
  if (!mid || of < 1 || of > MAX_PARTS || n < 0 || n >= of || typeof msg.b !== 'string' || msg.b.length > Math.ceil(PART / 3) * 4 + 4) return null
  if (!inUse(link)) return null
  const k = keyOf(link)
  if (gone.has(`${k}:${mid}`)) return null
  let box = inbox.get(k)
  if (!box) inbox.set(k, box = { open: new Map(), size: 0 })
  let b = box.open.get(mid)
  if (!b) {
    if (box.open.size >= OPEN) { warn(link, 'open', `more than ${OPEN} messages in pieces at once — dropped`); return null }
    b = { of, got: new Array(of), have: 0, size: 0 }
    b.timer = setTimeout(() => { dropMessage(box, mid); if (!box.open.size) inbox.delete(k) }, PART_MS)
    b.timer.unref?.()
    box.open.set(mid, b)
  }
  if (b.of !== of || b.got[n] !== undefined) return null
  const bytes = Buffer.from(msg.b, 'base64')
  if (box.size + bytes.length > MAX_MESSAGE || total + bytes.length > MAX_TOTAL) {
    warn(link, 'bytes', box.size + bytes.length > MAX_MESSAGE ? `over ${MAX_MESSAGE >> 20} MB in pieces — the message is dropped`
      : `over ${MAX_TOTAL >> 20} MB in pieces across all desktops — the message is dropped`)
    dropMessage(box, mid)
    gone.set(`${k}:${mid}`, Date.now())
    if (gone.size > 1000) gone.delete(gone.keys().next().value)
    if (!box.open.size) inbox.delete(k)
    return null
  }
  b.got[n] = bytes
  b.have++
  b.size += bytes.length
  box.size += bytes.length
  total += bytes.length
  if (b.have < b.of) return null
  const whole = Buffer.concat(b.got)
  dropMessage(box, mid)
  if (!box.open.size) inbox.delete(k)
  try { return JSON.parse(whole.toString('utf8')) } catch { return null }
}

// a message from a desktop (hub.js receive, in the link's tenant)
export async function receive(link, msg) {
  if (msg.type === 'browser-part') {
    const inner = takePart(link, msg)
    if (!inner || inner.type === 'browser-part' || !handles(inner)) return
    return receive(link, inner)
  }
  const k = keyOf(link)
  if (msg.type === 'browser-reply') {
    const p = pending.get(`${k}:${String(msg.id || '')}`)
    if (!p) return
    const d = bound.get(k)
    if (msg.at && d) d.at(msg.at)
    if (msg.ok) p.resolve(msg.value)
    else p.reject(Object.assign(new Error(String(msg.error || 'failed on the PC').slice(0, 300)), { remote: true, code: msg.code || null }))
    return
  }
  const d = bound.get(k)
  if (!d) return
  if (msg.type === 'browser-frame') { if (typeof msg.data === 'string') d.onFrame(msg.data, String(msg.url || '')); return }
  if (msg.type === 'browser-event') return d.onEvent(msg)
}

// the link closed: what was asked over it fails now (LinkLost), its driver knows (lost), its pieces go — only this link object's
export function linkGone(link) {
  link.closedAt = Date.now()
  const k = keyOf(link)
  for (const [key, p] of pending) if (p.link === link) { p.reject(new LinkLost(link.name)); pending.delete(key) }
  const box = inbox.get(k)
  if (box) { for (const mid of [...box.open.keys()]) dropMessage(box, mid); inbox.delete(k) }
  const d = bound.get(k)
  if (d) { bound.delete(k); d.linkLost() }
}

// a link came on: whoever waits for this person's PC (a task paused because it went off — 「PC가 다시 켜지면」) gets it
export function linkOn(link) {
  if (!link.caps?.browser) return
  for (const w of [...waiters]) {
    if (w.tenant !== link.tenant || w.userId !== link.userId || (w.deviceId && w.deviceId !== link.id)) continue
    waiters.delete(w)
    w.resolve(link)
  }
}
// → the link when one of this person's PCs (deviceId: that one) with a browser comes on; null when signal aborts first
export function waitForLink({ tenant, userId, deviceId = null, signal } = {}) {
  return new Promise((resolve) => {
    const w = { tenant, userId: String(userId), deviceId, resolve: (v) => { signal?.removeEventListener('abort', off); resolve(v) } }
    const off = () => { waiters.delete(w); resolve(null) }
    if (signal?.aborted) return resolve(null)
    signal?.addEventListener('abort', off, { once: true })
    waiters.add(w)
  })
}

// (tests)
export function reset() {
  for (const p of pending.values()) clearTimeout(p.timer)
  pending.clear(); bound.clear()
  for (const box of inbox.values()) for (const b of box.open.values()) clearTimeout(b.timer)
  inbox.clear(); waiters.clear(); warned.clear(); gone.clear()
  total = 0
}
export const stats = (link = null) => {
  if (link) { const box = inbox.get(keyOf(link)); return { open: box?.open.size || 0, bytes: box?.size || 0, bound: bound.has(keyOf(link)) } }
  let bytes = 0
  for (const box of inbox.values()) bytes += box.size
  return { pending: pending.size, bound: bound.size, inbox: inbox.size, bytes, total, waiters: waiters.size }
}
