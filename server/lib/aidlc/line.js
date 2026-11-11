// The bolt line of one AI-DLC project (docs/robo-dlc/plan-intake.md §13): every bolt of every intent, and
// the bolts the waiting requests are expected to become, in one line — which release each belongs to, what
// it waits for, what waits for it. Nothing here reads a file or the database: the record (lib/aidlc/record.js),
// the requests and what people decided about a bolt (sql/041) come in, the line comes out.

export const BUCKETS = ['shipped', 'now', 'next', 'tail']
const ORDER = Object.fromEntries(BUCKETS.map((b, i) => [b, i]))
export const laneOf = (unit) => String(unit || '').replace(/^u\d+[-_.]/i, '') || String(unit || '')
export const intentKey = (dir, unit) => `i:${dir}:${unit}`
export const requestKey = (id, unit) => `r:${id}:${unit}`
// a request that has no unit to name yet (nothing in the record matched): one bolt of its own
export const WHOLE = '*'

// provider → consumer edges of one intent: the unit dependencies and the contracts between units.
// → [{ from, to, via: 'C3' | 'unit', label }]
export function edgesOf({ units = [], contracts = [] }) {
  const out = []
  const names = new Set(units.map((u) => u.name))
  for (const c of contracts) {
    if (!c.provider) continue
    for (const to of c.consumers) if (to !== c.provider && names.has(to)) out.push({ from: c.provider, to, via: c.id, label: c.mechanism })
  }
  for (const u of units) {
    for (const from of u.dependsOn || []) {
      if (names.has(from) && !out.some((e) => e.from === from && e.to === u.name)) out.push({ from, to: u.name, via: 'unit', label: '' })
    }
  }
  return out
}

const stateOf = (metric, intentDone) => {
  if (intentDone) return 'done'
  const s = metric?.status
  if (s === 'done') return 'done'
  if (s === 'working' || s === 'waiting') return 'running'
  return 'planned'
}

// intents: [{ dir, slug, scope, title, done, archived, units: [{ name, dependsOn }], contracts, bolts: [{ n, units }],
//             metrics: { <unit>: { status } }, running: <unit in flight> | true (an intent without units, in flight) }]
//   in the order the record has them (oldest first)
// requests: [{ id, title, status, scope, fast, intent, estimate: { touches: { units, contracts }, newUnits, reverts }, by, at }]
// marks: { <bolt key>: { bucket, hold, discarded_at, discard_reason, discarded_by, discarded_for } }
// → { bolts, buckets: [{ key, bolts: [key], total, done, running, held }], lanes: [lane] }
//   a bolt: { key, n, kind: 'intent' | 'request', intent, request, unit, lane, title, scope, state: done | running |
//   planned | estimated, bucket, deps: [{ key, n, via, label, met }], hold, discarded, revert, isNew, fast, starting }
export function buildLine({ intents = [], requests = [], marks = {} }) {
  const bolts = []
  const reqOfIntent = (dir) => requests.find((r) => r.intent === dir)
  // the newest record of each unit's place in the dependency graph: what a request's expected bolts inherit
  const graph = { units: [], edges: [] }
  for (const it of intents) {
    if (!it.units?.length) continue
    const edges = edgesOf(it)
    for (const u of it.units) if (!graph.units.includes(u.name)) graph.units.push(u.name)
    graph.edges = [...graph.edges.filter((e) => !edges.some((x) => x.from === e.from && x.to === e.to)), ...edges]
  }
  const push = (b) => { bolts.push({ deps: [], hold: false, discarded: null, revert: false, fast: false, ...b, lane: b.unit === WHOLE ? '' : laneOf(b.unit) }) }

  for (const it of intents) {
    if (it.archived) continue
    const req = reqOfIntent(it.dir)
    const title = req?.title || it.title || it.slug
    if (it.units?.length) {
      // the bolt plan's order, then the units it does not name in the order they are declared
      const planned = (it.bolts || []).flatMap((b) => b.units)
      const order = [...planned.filter((u) => it.units.some((x) => x.name === u)), ...it.units.map((u) => u.name).filter((u) => !planned.includes(u))]
      for (const unit of [...new Set(order)]) {
        push({ key: intentKey(it.dir, unit), kind: 'intent', intent: it.dir, request: req?.id || null, unit, title, scope: it.scope,
          state: stateOf(it.metrics?.[unit], it.done), touches: req?.estimate?.touches?.contracts || null })
      }
    } else {
      // an intent that did not split into units (a bug fix): one bolt, in the lane of the unit it touches
      const unit = req?.estimate?.touches?.units?.[0] || WHOLE
      push({ key: intentKey(it.dir, unit), kind: 'intent', intent: it.dir, request: req?.id || null, unit, title, scope: it.scope,
        state: it.done ? 'done' : it.running ? 'running' : 'planned', touches: req?.estimate?.touches?.contracts || null })
    }
  }
  // a request just started, before the record has its intent: its expected bolts, the first one under way
  for (const r of requests.filter((x) => x.status === 'started' && !x.intent)) {
    boltUnits(r, graph).forEach((u, i) => {
      push({ key: requestKey(r.id, u.unit), kind: 'request', intent: null, request: r.id, unit: u.unit, title: r.title, scope: r.scope,
        state: i ? 'planned' : 'running', revert: !!u.revert, isNew: !!u.isNew, fast: !!r.fast, starting: true, touches: r.estimate?.touches?.contracts || null })
    })
  }
  // the waiting requests, as the bolts they are expected to become: the fast lane first, then the release
  // people put them in, then the order they were approved
  const waiting = requests.filter((r) => r.status === 'queued' && !r.intent)
  const bucketOfReq = (r) => Math.min(...boltUnits(r).map((u) => ORDER[marks[requestKey(r.id, u.unit)]?.bucket] ?? ORDER.tail))
  waiting.sort((a, b) => (b.fast ? 1 : 0) - (a.fast ? 1 : 0) || bucketOfReq(a) - bucketOfReq(b) || String(a.at || '').localeCompare(String(b.at || '')))
  for (const r of waiting) {
    for (const u of boltUnits(r, graph)) {
      push({ key: requestKey(r.id, u.unit), kind: 'request', intent: null, request: r.id, unit: u.unit, title: r.title, scope: r.scope,
        state: 'estimated', revert: !!u.revert, isNew: !!u.isNew, fast: !!r.fast, touches: r.estimate?.touches?.contracts || null })
    }
  }

  // what people decided about a bolt
  for (const b of bolts) {
    const m = marks[b.key]
    if (!m) continue
    b.hold = !!m.hold
    if (m.discarded_at) b.discarded = { at: m.discarded_at, by: m.discarded_by || null, reason: m.discard_reason || '', for: m.discarded_for || null }
  }

  // dependencies
  const byKey = Object.fromEntries(bolts.map((b) => [b.key, b]))
  const groupOf = (b) => b.intent || b.request
  const alive = (b) => !b.discarded
  bolts.forEach((b, i) => {
    if (b.unit === WHOLE) return
    const add = (from, via, label) => {
      if (from.key === b.key || b.deps.some((d) => d.key === from.key)) return
      b.deps.push({ key: from.key, via, label: label || '', met: from.state === 'done' })
    }
    const edges = b.kind === 'intent' ? edgesOf(intents.find((it) => it.dir === b.intent) || {}) : graph.edges
    // within the same piece of work: the unit's providers that are part of it
    for (const e of edges.filter((e) => e.to === b.unit)) {
      const from = bolts.find((x) => alive(x) && groupOf(x) === groupOf(b) && x.unit === e.from)
      if (from) add(from, e.via, e.label)
    }
    // a revert comes before the rest of its request
    if (b.kind === 'request' && !b.revert) for (const x of bolts) if (x.request === b.request && x.revert && alive(x)) add(x, 'revert', '')
    // across pieces of work: an earlier bolt, not finished, that changes a contract this unit consumes
    for (const x of bolts.slice(0, i)) {
      if (!alive(x) || x.state === 'done' || groupOf(x) === groupOf(b) || x.unit === WHOLE) continue
      for (const e of graph.edges.filter((e) => e.from === x.unit && e.to === b.unit && e.via !== 'unit')) {
        if ((x.touches || []).includes(e.via)) add(x, e.via, e.label)
      }
    }
    // the same unit: one after another
    const before = bolts.slice(0, i).filter((x) => alive(x) && x.state !== 'done' && x.unit === b.unit).pop()
    if (before) add(before, 'lane', '')
  })

  // releases
  for (const b of bolts) {
    const m = marks[b.key]?.bucket
    const it = b.intent && intents.find((x) => x.dir === b.intent)
    if (BUCKETS.includes(m)) b.bucket = m
    else if (b.kind === 'request') b.bucket = b.starting ? 'now' : 'tail'
    // work that was there before the line is released already; work taken in through it waits for a person's release
    else b.bucket = it?.done && !b.request ? 'shipped' : 'now'
  }
  // a bolt nobody placed goes no earlier than the bolts it waits for (a person's placement stays as it is)
  for (let pass = 0, moved = true; moved && pass < bolts.length; pass++) {
    moved = false
    for (const b of bolts) {
      if (BUCKETS.includes(marks[b.key]?.bucket) || b.discarded) continue
      for (const d of b.deps) {
        const p = byKey[d.key]
        if (p && alive(p) && ORDER[p.bucket] > ORDER[b.bucket]) { b.bucket = p.bucket; moved = true }
      }
    }
  }
  const ordered = BUCKETS.flatMap((k) => bolts.filter((b) => b.bucket === k))
  ordered.forEach((b, i) => { b.n = i + 1 })
  const buckets = BUCKETS.map((key) => {
    const mine = ordered.filter((b) => b.bucket === key && alive(b))
    return { key, bolts: ordered.filter((b) => b.bucket === key).map((b) => b.key), total: mine.length, done: mine.filter((b) => b.state === 'done').length,
      running: mine.filter((b) => b.state === 'running').length, held: mine.filter((b) => b.hold).length }
  })
  const lanes = [...new Set([...graph.units.map(laneOf), ...ordered.map((b) => b.lane)])].filter(Boolean)
  if (ordered.some((b) => !b.lane)) lanes.push('')
  for (const b of ordered) { for (const d of b.deps) d.n = byKey[d.key]?.n; delete b.touches }
  return { bolts: ordered, buckets, lanes }
}

// the bolts a waiting request is expected to become: one for each unit it touches (those the record has)
// and each unit it adds, in the dependency graph's order; first the bolts that take back finished work
function boltUnits(r, graph = { units: [] }) {
  const e = r.estimate || {}
  const touched = (e.touches?.units || [])
  const fresh = (e.newUnits || []).map((u) => u.name).filter((n) => n && !touched.includes(n))
  const at = (u) => { const i = graph.units.indexOf(u); return i < 0 ? 999 : i }
  const units = [...touched].sort((a, b) => at(a) - at(b))
  const out = (e.reverts || []).map((u) => ({ unit: u, revert: true }))
  for (const u of units) if (!out.some((x) => x.unit === u)) out.push({ unit: u })
  for (const u of fresh) out.push({ unit: u, isNew: true })
  return out.length ? out : [{ unit: WHOLE }]
}

// The bolts that wait for `key`. `needs`: only those that need what it makes (a contract, a unit, a revert) —
// a bolt that merely comes after it on the same unit stops waiting when it goes.
export const dependents = (line, key, deep = false, needs = false) => {
  const out = []
  const walk = (k) => {
    for (const b of line.bolts) {
      if (b.discarded || out.includes(b.key) || !b.deps.some((d) => d.key === k && !(needs && d.via === 'lane'))) continue
      out.push(b.key)
      if (deep) walk(b.key)
    }
  }
  walk(key)
  return out
}

// Would the line still hold if `key` went to release `bucket`? A bolt cannot be released before a bolt it
// waits for, nor after a bolt that waits for it. → { ok, blockers: [{ key, n, title, unit, bucket, why:
// 'provider' | 'consumer', via, label }], together: [key] } — `together` is the smallest set that can move with it.
export function checkMove(line, key, bucket) {
  const byKey = Object.fromEntries(line.bolts.map((b) => [b.key, b]))
  const b = byKey[key]
  if (!b || !(bucket in ORDER) || bucket === 'shipped') return { ok: false, blockers: [], together: [], error: 'unknown' }
  if (b.bucket === 'shipped') return { ok: false, blockers: [], together: [], error: 'shipped' }
  const to = ORDER[bucket]
  const moving = new Set([key])
  const blockers = []
  const walk = (x) => {
    for (const d of x.deps) {
      const p = byKey[d.key]
      if (!p || p.discarded || moving.has(p.key) || ORDER[p.bucket] <= to) continue
      moving.add(p.key); blockers.push({ key: p.key, n: p.n, title: p.title, unit: p.unit, bucket: p.bucket, why: 'provider', via: d.via, label: d.label }); walk(p)
    }
    for (const c of line.bolts) {
      const d = c.deps.find((d) => d.key === x.key)
      if (!d || c.discarded || moving.has(c.key) || ORDER[c.bucket] >= to) continue
      moving.add(c.key); blockers.push({ key: c.key, n: c.n, title: c.title, unit: c.unit, bucket: c.bucket, why: 'consumer', via: d.via, label: d.label }); walk(c)
    }
  }
  walk(b)
  // a bolt already released cannot come along
  const stuck = blockers.filter((x) => x.bucket === 'shipped')
  return { ok: !blockers.length, blockers, together: stuck.length ? [] : [...moving], stuck: stuck.map((x) => x.key) }
}

// every dependency a set of moves would break: [{ from, to }] (empty: the line holds)
export function violations(line, moves = {}) {
  const at = (b) => ORDER[moves[b.key] || b.bucket]
  const byKey = Object.fromEntries(line.bolts.map((b) => [b.key, b]))
  const out = []
  for (const b of line.bolts) {
    if (b.discarded) continue
    for (const d of b.deps) {
      const p = byKey[d.key]
      if (p && !p.discarded && at(p) > at(b)) out.push({ from: p.key, to: b.key })
    }
  }
  return out
}

// What discarding a bolt means, by where it is: nothing was spent (drop), work is under way (stop and put the
// files back), or it is finished and can only be taken back by new work (revert).
export const discardKind = (bolt) => (bolt.state === 'done' ? 'revert' : bolt.state === 'running' ? 'stop' : 'drop')

// the request that starts next when the line's head is free: the first waiting bolt's
export const nextUp = (line) => line.bolts.find((b) => b.kind === 'request' && b.state === 'estimated' && !b.discarded && !b.hold)?.request || null
