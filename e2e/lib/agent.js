// Agent-tier helpers: talk in the main chat like the page does, then wait for durable outcomes
// (messages of a kind, rows, files) rather than exact wording.
import * as api from './api.js'

export async function ask(u, db, text, opts = {}) {
  const th = await db.mainThreadId(u.id)
  const t0 = new Date()
  const r = await api.sendChat(u.token(), th, text, opts)
  return { ...r, th, t0 }
}
// messages the agent left since t0 (optionally of a kind / matching a predicate)
export async function since(db, th, t0, kind) {
  return db.q(`select * from pro_messages where thread_id=$1 and created_at >= $2 ${kind ? 'and kind = any($3)' : ''} order by created_at`, kind ? [th, t0, [].concat(kind)] : [th, t0])
}
export async function waitFor(fn, { timeout = 15 * 60_000, every = 5000 } = {}) {
  return api.until(fn, { timeout, every })
}
