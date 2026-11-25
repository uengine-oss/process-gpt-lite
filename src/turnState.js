// The running turns of one thread as the page keeps them ({turnId → turn}), from the turn.* events and from the snapshot a page
// asks for when it opens a thread or reconnects (server lib/turnPlan.js · GET /api/threads/:id/turn). Plain functions, no Vue:
// the store (stores/app.js) applies them, the server's tests run them (server/test/turnPlan.test.js).
//
// A turn that ended is remembered for a while (`ended`): a snapshot taken before its turn.end — the request was on the way while it
// ended — and an event that comes after its end must not bring its card back (review 11-25 #7: a card ran forever).
export const ENDED_KEEP_MS = 10 * 60_000

export function rememberEnded(ended, turnId, now = Date.now()) {
  ended.set(turnId, now)
  for (const [id, at] of ended) if (now - at > ENDED_KEEP_MS) ended.delete(id)
}

// one event → the thread's turns (a new object when something changed, the same one when not)
export function applyTurnEvent(all, type, d, ended, now = Date.now()) {
  if (!d?.turnId) return all
  if (type === 'turn.end') {
    rememberEnded(ended, d.turnId, now)
    if (!all[d.turnId]) return all
    const { [d.turnId]: _gone, ...rest } = all
    return rest
  }
  if (ended.has(d.turnId)) return all
  const t = all[d.turnId] || { turnId: d.turnId, threadId: d.threadId, msgId: null, startedAt: d.at, planState: 'reading', plan: null, handler: null, stage: null, todos: [], steps: [], notes: [], open: null }
  // seenAt: when the last event came (the live line's 「· 12초」 counts from it); skew: this clock against the server's
  const next = { ...t, lastAt: d.at || now, seenAt: now, skew: d.at ? now - d.at : (t.skew || 0), ...(d.conversationId ? { conversationId: d.conversationId } : {}) }
  if (type === 'turn.start') Object.assign(next, { msgId: d.msgId || null, startedAt: d.startedAt || d.at, planState: d.planState || next.planState || 'reading' })
  else if (type === 'turn.plan') Object.assign(next, { planState: 'planned', handler: d.handler || null,
    plan: { understood: d.understood, steps: d.steps || [], tier: d.tier, certainty: d.certainty, source: d.source, alternatives: d.alternatives || [] } })
  else if (type === 'turn.stage') next.stage = { stage: d.stage, text: d.text, ...(d.detail ? { detail: d.detail } : {}), at: d.at }
  else if (type === 'turn.todos') next.todos = d.todos || []
  else if (type === 'turn.step') {
    const i = next.steps.findIndex((x) => (d.key && x.key === d.key) || x.seq === d.seq)
    next.steps = i >= 0 ? next.steps.map((x, k) => (k === i ? d : x)) : [...next.steps, d].slice(-30)
  } else if (type === 'turn.note') {
    if (d.open) next.open = { seq: d.seq, text: d.text }
    else { next.open = null; next.notes = [...next.notes, { seq: d.seq, text: d.text }].slice(-10) }
  } else if (type === 'turn.call') next.call = d.state === 'end' ? null : d
  return { ...all, [d.turnId]: next }
}

// the snapshot (r = {now, turns}) → the thread's turns: what the server has now, less the turns this page saw end
export function fromSnapshot(r, ended, now = Date.now()) {
  const live = {}
  if (!r || !Array.isArray(r.turns)) return live
  // (the server's clock against this one: elapsed times count from the server's `at`)
  const skew = r.now ? now - r.now : 0
  for (const t of r.turns) {
    if (!t?.turnId || ended.has(t.turnId)) continue
    live[t.turnId] = { ...t, skew, seenAt: now - Math.max(0, (r.now || now) - (t.lastAt || t.startedAt)), open: t.open || null, notes: t.notes || [], steps: t.steps || [], todos: t.todos || [] }
  }
  return live
}
