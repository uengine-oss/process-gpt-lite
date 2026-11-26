// One message per client id (2026-11-27 recording: a message sent while a deploy restarted the server vanished — the page now sends it
// again, and a page that sends again must never make a second message). The page names each message it sends (`clientId`, a random id);
// the server takes an id once: while its turn runs (this process) and afterwards (the user message keeps it — content.clientId).
// A second request with that id answers at once with a stream that says {duplicate: true} and does nothing else.
import { q } from './supa.js'

const running = new Set()
const keyOf = (threadId, id) => `${threadId}:${id}`
export const validId = (x) => (typeof x === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(x) ? x : null)

// → true when this request takes the id (call release when its turn is over), false when it was taken before
export async function claim(threadId, id) {
  const k = keyOf(threadId, id)
  if (running.has(k)) return false
  running.add(k)
  try {
    const [r] = await q(`select 1 from pro_messages where thread_id=$1 and role='user' and content->>'clientId'=$2 limit 1`, [threadId, id])
    if (r) { running.delete(k); return false }
    return true
  } catch (e) { running.delete(k); throw e }
}
export const release = (threadId, id) => running.delete(keyOf(threadId, id))
