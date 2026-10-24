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

export function emit(userId, type, data) {
  const line = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`
  for (const res of subs.get(userId) || []) res.write(line)
  const list = recent.get(userId) || []
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
