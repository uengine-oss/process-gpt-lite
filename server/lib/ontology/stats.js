// 프로세스 온톨로지의 셈(spec pgpt-pro_process-ontology, 설계 docs/auto-ax-onboarding/design-v0.2.md §2.2 · §2.5 · §7.3).
// Pure functions over the event log: no database, no model. Events → cases → tasks and NEXT edges with counts,
// probabilities, dependency, waits and decayed weights; then the values the design says are set automatically
// (θ from the replay-fitness knee, the half-life by log-likelihood on the last weeks, the bands by next-step
// accuracy on held-out recent cases, retirement by a Poisson test, "관찰 적음" by the Wilson interval).
// Every rule here is a measured or statistical one; the few fixed numbers (95 %, 5 %, 0.5) are statistical
// conventions, not business choices (§2.5).

export const DAY = 86_400_000
export const END = '__end__'
export const THETAS = [0, 0.01, 0.02, 0.05, 0.1, 0.2]
export const HALF_LIVES = [14, 30, 60, 90, 180]
export const START = { theta: 0.05, halfLife: 60, acceptBar: 0.5 }
export const MIN_HOLDOUT = 5 // fewer held-out cases than this: nothing to measure (band 지켜보기)
export const SUMMARY_TASKS = 8 // the summary view: the main way through, at a glance

const ms = (t) => (typeof t === 'number' ? t : new Date(t).getTime())

// events [{case, task, at, who?, role?, source?, person?}] → cases [{id, steps:[{task, at, end, who, role, sources, people}]}]
// A task repeated back to back (two mails about the same quote) is one step: first event starts it, last ends it.
export function toCases(events) {
  const by = new Map()
  for (const e of events) {
    if (!e?.case || !e?.task) continue
    if (!by.has(e.case)) by.set(e.case, [])
    by.get(e.case).push({ ...e, at: ms(e.at) })
  }
  const cases = []
  for (const [id, evs] of by) {
    evs.sort((a, b) => a.at - b.at)
    const steps = []
    for (const e of evs) {
      const last = steps.at(-1)
      if (last && last.task === e.task) {
        last.end = e.at
        if (e.source) last.sources.add(e.source)
        if (e.person) last.people.add(e.person)
        continue
      }
      steps.push({ task: e.task, at: e.at, end: e.at, who: e.who || null, role: e.role || null, sources: new Set(e.source ? [e.source] : []), people: new Set(e.person ? [e.person] : []) })
    }
    cases.push({ id, start: steps[0].at, steps })
  }
  return cases.sort((a, b) => a.start - b.start)
}

// the case's transitions, END included: [{from, to, at, wait}]
export function transitions(c) {
  const out = []
  for (let i = 0; i < c.steps.length; i++) {
    const a = c.steps[i], b = c.steps[i + 1]
    if (b) out.push({ from: a.task, to: b.task, at: b.at, wait: Math.max(0, b.at - a.end), sources: new Set([...a.sources, ...b.sources]), people: new Set([...a.people, ...b.people]) })
    else out.push({ from: a.task, to: END, at: a.end, wait: 0, sources: a.sources, people: a.people })
  }
  return out
}

export const decay = (ageMs, halfLifeDays) => Math.pow(2, -Math.max(0, ageMs) / (halfLifeDays * DAY))

// Wilson score interval (95 %) for k successes out of n
export function wilson(k, n, z = 1.96) {
  if (!n) return { low: 0, high: 1, width: 1 }
  const p = k / n, z2 = z * z
  const center = (p + z2 / (2 * n)) / (1 + z2 / n)
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n)
  return { low: Math.max(0, center - half), high: Math.min(1, center + half), width: Math.min(1, center + half) - Math.max(0, center - half) }
}

// The graph the cases make. now: the instant weights decay to (default: the last event).
export function graphOf(cases, { halfLife = START.halfLife, now } = {}) {
  const tasks = new Map(), edges = new Map()
  const last = cases.reduce((m, c) => Math.max(m, c.steps.at(-1).end), 0)
  const at = now ?? last
  const task = (k) => {
    if (!tasks.has(k)) tasks.set(k, { key: k, cases: new Set(), n: 0, entry: 0, exit: 0, first: Infinity, last: -Infinity, roles: new Map(), people: new Set(), sources: new Map() })
    return tasks.get(k)
  }
  for (const c of cases) {
    c.steps.forEach((s, i) => {
      const t = task(s.task)
      t.cases.add(c.id); t.n++
      if (i === 0) t.entry++
      if (i === c.steps.length - 1) t.exit++
      t.first = Math.min(t.first, s.at); t.last = Math.max(t.last, s.end)
      if (s.role) t.roles.set(s.role, (t.roles.get(s.role) || 0) + 1)
      for (const p of s.people) t.people.add(p)
      for (const src of s.sources) t.sources.set(src, (t.sources.get(src) || 0) + 1)
    })
    for (const x of transitions(c)) {
      const k = `${x.from}\u0000${x.to}`
      if (!edges.has(k)) edges.set(k, { from: x.from, to: x.to, n: 0, times: [], waits: [], w: 0, sources: new Map(), people: new Set(), cases: [] })
      const e = edges.get(k)
      e.n++; e.times.push(x.at); e.waits.push(x.wait); e.w += decay(at - x.at, halfLife); e.cases.push(c.id)
      for (const src of x.sources) e.sources.set(src, (e.sources.get(src) || 0) + 1)
      for (const p of x.people) e.people.add(p)
    }
  }
  // out-totals (END included) → p, recent share, dependency, Wilson
  const out = new Map(), outW = new Map()
  for (const e of edges.values()) { out.set(e.from, (out.get(e.from) || 0) + e.n); outW.set(e.from, (outW.get(e.from) || 0) + e.w) }
  for (const e of edges.values()) {
    e.p = e.n / out.get(e.from)
    e.share = outW.get(e.from) ? e.w / outW.get(e.from) : 0
    const back = edges.get(`${e.to}\u0000${e.from}`)?.n || 0
    e.dependency = e.to === END ? 1 : (e.n - back) / (e.n + back + 1)
    e.ci = wilson(e.n, out.get(e.from))
    e.thin = e.ci.width > 0.3
    e.avgWaitH = e.waits.length ? e.waits.reduce((s, v) => s + v, 0) / e.waits.length / 3_600_000 : 0
    e.lastSeen = Math.max(...e.times)
    e.firstSeen = Math.min(...e.times)
  }
  const nCases = cases.length || 1
  for (const t of tasks.values()) {
    t.entryShare = t.entry / nCases
    t.exitShare = t.n ? t.exit / t.n : 0
    t.role = [...t.roles].sort((a, b) => b[1] - a[1])[0]?.[0] || null
  }
  return { tasks, edges, first: cases[0]?.start ?? null, last, now: at, cases: cases.length }
}

// p(b|a) lookup from a graph, END included
export function nextOf(g, a) {
  return [...g.edges.values()].filter((e) => e.from === a).sort((x, y) => y.p - x.p || x.to.localeCompare(y.to))
}

// Is the transition allowed in the θ-model (p ≥ θ, or pinned)?
const allowed = (g, from, to, theta, pinned) => {
  const e = g.edges.get(`${from}\u0000${to}`)
  return !!e && (e.p >= theta || pinned?.has(`${from}\u0000${to}`) || pinned?.has(to))
}

// Hold out the most recent cases (by start): {train, holdout}
export function split(cases, fraction = 0.2) {
  const sorted = [...cases].sort((a, b) => a.start - b.start)
  const k = Math.max(1, Math.round(sorted.length * fraction))
  return { train: sorted.slice(0, sorted.length - k), holdout: sorted.slice(sorted.length - k) }
}

// Replay fitness of the θ-model on held-out cases: the share of their transitions the model allows
export function fitness(g, holdout, theta, pinned) {
  let ok = 0, all = 0
  for (const c of holdout) for (const x of transitions(c)) { all++; if (allowed(g, x.from, x.to, theta, pinned)) ok++ }
  return all ? ok / all : 1
}

// θ = the largest value before the biggest fall in fitness ("곡선이 꺾이는 곳"); a fall smaller than one held-out
// transition is measurement noise, so a flat curve takes the largest θ (the simplest model that fits as well)
export function kneeTheta(curve, transitionsHeld) {
  const noise = transitionsHeld ? 1 / transitionsHeld : 0
  let best = -1, at = curve.length - 1
  for (let i = 0; i < curve.length - 1; i++) {
    const drop = curve[i].fitness - curve[i + 1].fitness
    if (drop > noise && drop > best) { best = drop; at = i }
  }
  return curve[at].theta
}

// Next-step accuracy on held-out cases (top-1 / top-3 by the train graph's p, END counts as a step)
export function nextStepAccuracy(g, holdout) {
  let n = 0, top1 = 0, top3 = 0
  for (const c of holdout) for (const x of transitions(c)) {
    const ranked = nextOf(g, x.from).map((e) => e.to)
    if (!ranked.length) { n++; continue }
    n++
    if (ranked[0] === x.to) top1++
    if (ranked.slice(0, 3).includes(x.to)) top3++
  }
  return { n, top1: n ? top1 / n : 0, top3: n ? top3 / n : 0 }
}

// Half-life by log-likelihood: weights decayed to the cut-off from the cases before it, scored on the transitions after it
export function pickHalfLife(cases, { now, testDays = 28, candidates = HALF_LIVES, alpha = 0.5 } = {}) {
  const end = now ?? cases.reduce((m, c) => Math.max(m, c.steps.at(-1).end), 0)
  const cut = end - testDays * DAY
  const before = cases.map((c) => ({ ...c, steps: c.steps.filter((s) => s.end <= cut) })).filter((c) => c.steps.length)
  const test = cases.flatMap((c) => transitions(c).filter((x) => x.at > cut))
  if (test.length < 10 || !before.length) return { halfLife: START.halfLife, start: true, scores: [], tested: test.length }
  const succ = new Map()
  for (const c of before) for (const x of transitions(c)) { if (!succ.has(x.from)) succ.set(x.from, new Set()); succ.get(x.from).add(x.to) }
  const scores = candidates.map((h) => {
    const w = new Map(), tot = new Map()
    for (const c of before) for (const x of transitions(c)) {
      const v = decay(cut - x.at, h)
      w.set(`${x.from}\u0000${x.to}`, (w.get(`${x.from}\u0000${x.to}`) || 0) + v)
      tot.set(x.from, (tot.get(x.from) || 0) + v)
    }
    let ll = 0
    for (const x of test) {
      const k = (succ.get(x.from)?.size || 0) + 1
      ll += Math.log(((w.get(`${x.from}\u0000${x.to}`) || 0) + alpha) / ((tot.get(x.from) || 0) + alpha * k))
    }
    return { halfLife: h, ll }
  })
  const best = scores.reduce((a, b) => (b.ll > a.ll ? b : a))
  return { halfLife: best.halfLife, start: false, scores, tested: test.length }
}

// Staleness (design §7.3): after the edge was last taken, its source task was left k more times; at the edge's old share of
// that task's ways out, it should have been taken k × p_old times. More than 3 expected and none seen (P(none) =
// (1 − p_old)^k, under 5 %) → a retirement candidate. Conditioning on the source task's later traffic keeps a quiet week
// (or cases still under way) from looking like a dropped path.
export function staleness(e, outTimes) {
  if (e.to === END || !outTimes?.length) return { stale: false, expected: 0, pValue: 1, after: 0 }
  const before = outTimes.filter((t) => t <= e.lastSeen).length
  const after = outTimes.length - before
  const pOld = before ? e.n / before : 0
  const expected = after * pOld
  const pValue = Math.pow(1 - pOld, after)
  return { stale: expected > 3, expected, pValue, after, pOld, gapDays: 0 }
}

// the times of every transition out of each task (for staleness)
export function outTimesOf(g) {
  const m = new Map()
  for (const e of g.edges.values()) { if (!m.has(e.from)) m.set(e.from, []); m.get(e.from).push(...e.times) }
  return m
}

// Bundles (design §2.4): cases grouped by the work they hold. The most common task sets come first and found a group
// (its core flow). A case joins the first group when
//   - every task of it is already in the group (a re-quote: part of the flow, nothing else), or
//   - it has more than half of the group's core and most (≥ 0.7) of its tasks are in the group (the flow plus a stray step)
// so a different flow that shares a step or two (요청 접수 · 고객 회신) and has its own work stays apart.
// → [{key, core, tasks, caseIds}]
export function clusterCases(cases, bar = 0.7) {
  const sig = (c) => [...new Set(c.steps.map((s) => s.task))].sort()
  const bySig = new Map()
  for (const c of cases) { const k = sig(c).join('|'); if (!bySig.has(k)) bySig.set(k, { set: sig(c), cases: [] }); bySig.get(k).cases.push(c) }
  const groups = []
  for (const x of [...bySig.values()].sort((a, b) => b.cases.length - a.cases.length || b.set.length - a.set.length)) {
    const g = groups.find((y) => x.set.every((t) => y.tasks.has(t)) ||
      (x.set.filter((t) => y.core.has(t)).length / y.core.size > 0.5 && x.set.filter((t) => y.tasks.has(t)).length / x.set.length >= bar))
    if (g) { g.cases.push(...x.cases); x.set.forEach((t) => g.tasks.add(t)) } else groups.push({ core: new Set(x.set), tasks: new Set(x.set), cases: [...x.cases] })
  }
  return groups.map((g) => ({ core: [...g.core].sort(), tasks: [...g.tasks].sort(), caseIds: g.cases.map((c) => c.id), key: [...g.core].sort().join('|') }))
}

// (kept for the tests: the connected parts of the task graph)
export function bundlesOf(g) {
  const adj = new Map()
  const link = (a, b) => { if (!adj.has(a)) adj.set(a, new Set()); adj.get(a).add(b) }
  for (const t of g.tasks.keys()) link(t, t)
  for (const e of g.edges.values()) if (e.to !== END) { link(e.from, e.to); link(e.to, e.from) }
  const seen = new Set(), out = []
  for (const t of g.tasks.keys()) {
    if (seen.has(t)) continue
    const part = [], stack = [t]
    while (stack.length) { const x = stack.pop(); if (seen.has(x)) continue; seen.add(x); part.push(x); for (const y of adj.get(x) || []) stack.push(y) }
    out.push(part)
  }
  return out.map((tasks) => ({ tasks: tasks.sort(), key: [...tasks].sort().join('|') }))
}

// A logistic fit of "accepted" on p (1-D, gradient descent) → p ↦ probability of acceptance; null below `min` records
export function calibrate(records, { min = 20, steps = 2000, rate = 0.5 } = {}) {
  if (!records || records.length < min) return null
  let a = 0, b = 0
  for (let i = 0; i < steps; i++) {
    let ga = 0, gb = 0
    for (const r of records) { const y = r.accepted ? 1 : 0; const pr = 1 / (1 + Math.exp(-(a + b * r.p))); ga += pr - y; gb += (pr - y) * r.p }
    a -= (rate * ga) / records.length; b -= (rate * gb) / records.length
  }
  return { a, b, accept: (p) => 1 / (1 + Math.exp(-(a + b * p))) }
}

// The smallest θ that leaves at most `max` tasks on the summary view: the tasks reachable from the entries through edges
// ≥ θ (a rare task's only way out has p = 1 and would otherwise keep it on the summary)
export function summaryTheta(g, max = SUMMARY_TASKS) {
  const entries = [...g.tasks.values()].filter((t) => t.entry > 0).map((t) => t.key)
  for (const th of [...THETAS, 0.3, 0.5]) {
    const keep = new Set(entries), stack = [...entries]
    while (stack.length) {
      const x = stack.pop()
      for (const e of g.edges.values()) if (e.from === x && e.to !== END && e.p >= th && !keep.has(e.to)) { keep.add(e.to); stack.push(e.to) }
    }
    if (keep.size <= max) return th
  }
  return 0.5
}

// Everything §2.5 sets automatically, for one bundle's cases
export function autoValues(cases, { now, pinned } = {}) {
  const { train, holdout } = split(cases)
  const hl = pickHalfLife(cases, { now })
  const gTrain = graphOf(train.length ? train : cases, { halfLife: hl.halfLife, now })
  const held = holdout.reduce((s, c) => s + transitions(c).length, 0)
  const curve = THETAS.map((theta) => ({ theta, fitness: fitness(gTrain, holdout, theta, pinned) }))
  const measurable = holdout.length >= MIN_HOLDOUT && train.length > 0
  const theta = measurable ? kneeTheta(curve, held) : START.theta
  const acc = nextStepAccuracy(gTrain, holdout)
  return {
    theta, thetaStart: !measurable, curve, heldCases: holdout.length, heldTransitions: held,
    halfLife: hl.halfLife, halfLifeStart: hl.start, halfLifeScores: hl.scores,
    accuracy: acc, measurable,
  }
}

export function bandOf(values, acceptBar = START.acceptBar) {
  if (!values.measurable) return 'watch'
  if (values.accuracy.top1 >= acceptBar) return 'paved'
  return 'open'
}
export const BAND_KO = { paved: '굳은 길', open: '열린 일', watch: '지켜보기' }

// A learned condition for an XOR split (design §2.5 「조건 글 쓰기」): rows [{x: number, y: branch}] → the threshold on x
// that best tells the two most common branches apart. Kept only when, predicting each case from the others
// (leave-one-out), it gets more right than always taking the most common branch; otherwise null (the split then takes
// its most common branch as the default flow).
function bestSplit(two, a, b) {
  const xs = [...new Set(two.map((r) => r.x))].sort((p, q) => p - q)
  let best = null
  for (let i = 1; i < xs.length; i++) {
    const t = (xs[i - 1] + xs[i]) / 2
    for (const [hi, lo] of [[a, b], [b, a]]) {
      const ok = two.filter((r) => (r.x >= t ? r.y === hi : r.y === lo)).length
      if (!best || ok > best.ok) best = { threshold: t, high: hi, low: lo, ok }
    }
  }
  return best
}
export function learnThreshold(rows) {
  const data = rows.filter((r) => Number.isFinite(r.x) && r.y != null)
  if (data.length < 4) return null
  const count = new Map()
  for (const r of data) count.set(r.y, (count.get(r.y) || 0) + 1)
  const [a, b] = [...count].sort((x, y) => y[1] - x[1]).map(([k]) => k)
  if (!b) return null
  const two = data.filter((r) => r.y === a || r.y === b)
  // (the bar is the larger branch's share: a left-out case's majority flips on balanced data and would read as 0)
  let loo = 0
  two.forEach((r, i) => {
    const s = bestSplit(two.filter((_, j) => j !== i), a, b)
    if (s && (r.x >= s.threshold ? s.high : s.low) === r.y) loo++
  })
  const base = Math.max(...[a, b].map((k) => two.filter((r) => r.y === k).length))
  if (loo <= base) return null
  const best = bestSplit(two, a, b)
  // a round number a person would write (the threshold sits between two observed amounts)
  const lowX = Math.max(...two.filter((r) => r.x < best.threshold).map((r) => r.x))
  const highX = Math.min(...two.filter((r) => r.x >= best.threshold).map((r) => r.x))
  const mag = Math.pow(10, Math.floor(Math.log10(Math.max(1, highX))))
  let round = Math.ceil(lowX / mag) * mag
  if (!(round > lowX && round <= highX)) round = best.threshold
  return { threshold: round, high: best.high, low: best.low, accuracy: best.ok / two.length, loo: loo / two.length, baseline: base / two.length, n: two.length }
}
