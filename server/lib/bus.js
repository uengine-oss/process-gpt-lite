// Per-user event bus, delivered to the browser over one SSE stream (/api/events), or — where a
// proxy in front holds streams back (Cloudflare quick tunnels do not pass SSE) — by long polling
// (/api/events/poll) over the same recent-events buffer.
const subs = new Map() // userId -> Set<res>
const recent = new Map() // userId -> [{seq, type, data}]  (last KEEP events)
const waiters = new Map() // userId -> Set<fn>
const KEEP = 200
let seq = 0

export function subscribe(userId, res) {
  if (!subs.has(userId)) subs.set(userId, new Set())
  subs.get(userId).add(res)
  return () => subs.get(userId)?.delete(res)
}

// A person whose membership ended (lib/membership.js remove): their open streams end now, and their waiting long polls answer — the
// page's next request (a reconnect) is then checked at the door. Their buffered events go with them.
export function closeStreams(userId) {
  const id = String(userId)
  for (const res of subs.get(id) || []) { try { res.end() } catch { /* already gone */ } }
  subs.delete(id)
  recent.delete(id)
  for (const wake of waiters.get(id) || []) wake()
}

// A live-view frame (browser.frame) is the one kind of event that may be left out: a viewer whose connection still holds
// FRAME_BACKLOG bytes it has not sent (a phone on a slow line) gets no new frame until it has caught up — never a queue
// growing in this server's memory — and the long-poll buffer keeps a task's newest frame only, so frames (several a
// second) do not push messages and card changes out of it.
export const FRAME_BACKLOG = 256 * 1024
export const dropped = { frames: 0 }
export function emit(userId, type, data) {
  const line = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`
  const frame = type === 'browser.frame'
  for (const res of subs.get(userId) || []) {
    if (frame && (res.writableLength || 0) > FRAME_BACKLOG) { dropped.frames++; continue }
    res.write(line)
  }
  let list = recent.get(userId) || []
  if (frame) list = list.filter((e) => !(e.type === type && e.data?.taskId === data?.taskId))
  list.push({ seq: ++seq, type, data })
  if (list.length > KEEP) list.splice(0, list.length - KEEP)
  recent.set(userId, list)
  for (const wake of waiters.get(userId) || []) wake()
}

export const lastSeq = () => seq

// Events after `after`, waiting up to `ms` for the first one.
export function poll(userId, after, ms = 25000) {
  const pending = () => (recent.get(userId) || []).filter((e) => e.seq > after)
  const now = pending()
  if (now.length) return Promise.resolve(now)
  return new Promise((resolve) => {
    const set = waiters.get(userId) || new Set()
    waiters.set(userId, set)
    const done = () => { clearTimeout(t); set.delete(done); resolve(pending()) }
    const t = setTimeout(done, ms)
    set.add(done)
  })
}
