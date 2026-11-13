// The bolt board's own logic (test/apps.test.js): the intent's units, each with its design stages and its bolts —
// from the unit plan, the bolt plan and the audit, no database.
// Unit → bolts, as the AI-DLC method defines them (Raja SP, 2025): a Unit is "a cohesive, self-contained work element
// derived from an Intent", a Bolt "the smallest iteration … for rapid implementation of a Unit", and "a Unit may be
// executed through one or more Bolts". In AI-DLC 2.11.x a unit's bolt is one pass of its code generation closed by
// the unit checkpoint (`aidlc engine bolt checkpoint --kind unit`); a pass sent back (a unit-end GATE_REJECTED, e.g.
// from Build and Test) is followed by the next. bolt-plan.md's "Bolt N" only groups units for delivery (the runtime
// order is the unit DAG), so here it is a label on the unit, not its parent.
export const UNIT_STAGES = ['functional-design', 'nfr-requirements', 'nfr-design', 'infrastructure-design', 'code-generation']
export const DESIGN_STAGES = UNIT_STAGES.slice(0, 4)
const mins = (ms) => Math.round((ms / 60000) * 10) / 10

// per unit and stage: when it started, when it finished, its time (an open one runs to now). The start is
// the first event naming the unit and stage — AI-DLC may write UNIT_STARTED only at the end (a code plan
// asked and approved 40 minutes before it, in our run).
export function stageTimes(events, now = Date.now()) {
  const out = new Map() // unit -> Map(stage -> { start, end, min })
  for (const e of events) {
    if (!e.unit || !UNIT_STAGES.includes(e.stage)) continue
    if (!out.has(e.unit)) out.set(e.unit, new Map())
    const m = out.get(e.unit)
    const s = m.get(e.stage) || { start: null, end: null }
    s.start = s.start ?? e.t
    if (e.event === 'UNIT_STARTED' && s.end != null && e.t > s.end) s.end = null
    if (e.event === 'UNIT_COMPLETED') s.end = e.t
    m.set(e.stage, s)
  }
  for (const m of out.values()) for (const s of m.values()) s.min = s.start != null ? mins((s.end ?? now) - s.start) : null
  return out
}

// swarm (AI-DLC 2.11.2 with `stage-major` + `swarm`): each bolt is built in its own worktree — made (WORKTREE_CREATED,
// `Swarm Unit`), merged into the landing branch (SWARM_SOURCE_MERGED: the proof it landed, a squash commit "Bolt <slug>")
// or set aside (WORKTREE_DISCARDED, kept under a parked ref). The worker's own steps are in the worktree's audit shard
// and reach the main record only when the bolt is merged. → unit -> [{ slug, path, branch, batch, at, merged, discarded }]
export function boltWorktrees(events) {
  const out = new Map()
  const bySlug = new Map()
  for (const e of events) {
    const f = e.fields || {}
    if (e.event === 'WORKTREE_CREATED' && f['Swarm Unit']) {
      const w = { slug: f['Bolt slug'] || '', path: f['Worktree path'] || '', branch: f['Branch name'] || '', batch: f['Swarm Batch'] || null, at: e.t, merged: null, discarded: null }
      if (!out.has(f['Swarm Unit'])) out.set(f['Swarm Unit'], [])
      out.get(f['Swarm Unit']).push(w)
      bySlug.set(w.slug, w)
    } else if (e.event === 'SWARM_SOURCE_MERGED' && f['Unit name']) {
      const w = (out.get(f['Unit name']) || []).filter((x) => !x.merged && !x.discarded).at(0)
      if (w) w.merged = { at: e.t, commit: f['Merge commit'] || f['Source Commit'] || '' }
    } else if (e.event === 'WORKTREE_DISCARDED') {
      const w = bySlug.get(f['Bolt slug'])
      if (w) w.discarded = { at: e.t, ref: f['Parked ref'] || '' }
    }
  }
  return out
}

// one unit's bolts in order: { n, start, end, min, checks: [{ at, ok, exit }], outcome, back, worktree? }
//   outcome: working (open) · verified (its checkpoint passed) · approved (the unit gate passed) ·
//            sent-back (back: { at, from, feedback }) · accepted (the last one, once the whole intent is complete) ·
//            merged (swarm: landed from its worktree) · discarded (swarm: its worktree set aside)
export function unitBolts(events, unit, { now = Date.now(), complete = false, worktrees = null } = {}) {
  const out = []
  let cur = null
  let reopened = null
  const last = () => cur || out.at(-1)
  for (const e of events) {
    if (e.unit !== unit || e.stage !== 'code-generation') continue
    if (e.event === 'GATE_REJECTED') {
      const b = last()
      if (b) { b.outcome = 'sent-back'; b.back = { at: e.t, from: e.fields?.['Moved From'] || '', feedback: e.fields?.Feedback || '' }; b.end = b.end ?? e.t }
      cur = null
      reopened = e.t
      continue
    }
    if (e.event === 'GATE_APPROVED') { const b = last(); if (b && b.outcome !== 'sent-back') b.outcome = 'approved'; continue }
    // a new pass only for the unit's first code generation or after it was sent back: what follows a closed pass
    // (sensors, reviews, a check run again) belongs to that pass
    if (!cur && (!out.length || reopened != null)) {
      cur = { n: out.length + 1, start: reopened ?? e.t, end: null, checks: [], outcome: 'working', back: null }
      out.push(cur)
      reopened = null
    }
    const b = cur || out.at(-1)
    if (!b) continue
    if (e.event === 'CHECKPOINT_VERIFICATION_RECORDED') {
      const ok = e.fields?.Verified === 'true'
      b.checks.push({ at: e.t, ok, exit: e.fields?.['Exit Code'] != null ? Number(e.fields['Exit Code']) : null })
      if (ok && b === cur) { cur.end = e.t; cur.outcome = 'verified'; cur = null }
    } else if (e.event === 'UNIT_COMPLETED' && b === cur) cur.end = e.t
  }
  // sent back and not started again yet: the next pass is waiting
  if (reopened != null) out.push({ n: out.length + 1, start: reopened, end: null, checks: [], outcome: 'working', back: null })
  // swarm: the n-th worktree of a unit is its n-th pass (a pass whose steps are still in the worktree has no events here)
  const wts = (worktrees || boltWorktrees(events)).get(unit) || []
  wts.forEach((w, i) => {
    let b = out[i]
    if (!b) { b = { n: out.length + 1, start: w.at, end: null, checks: [], outcome: 'working', back: null }; out.push(b) }
    b.worktree = { slug: w.slug, path: w.path, branch: w.branch, batch: w.batch }
    if (w.discarded) { b.outcome = 'discarded'; b.end = b.end ?? w.discarded.at; b.parked = w.discarded.ref }
    else if (w.merged) { b.merged = w.merged; if (['working', 'verified'].includes(b.outcome)) b.outcome = 'merged'; b.end = b.end ?? w.merged.at }
  })
  const tail = out.at(-1)
  if (complete && tail && ['verified', 'approved'].includes(tail.outcome)) tail.outcome = 'accepted'
  for (const b of out) b.min = mins((b.end ?? now) - b.start)
  return out
}

// the intent's units (the unit plan's order), each with its design stages, its bolts and its delivery group
export function buildUnitTree({ units, plan = [], times, events, now: running, complete = false, at = Date.now() }) {
  const wts = boltWorktrees(events)
  const groupOf = new Map()
  for (const b of plan) for (const n of b.units) if (!groupOf.has(n)) groupOf.set(n, { n: b.n, name: b.name })
  return units.map((u) => {
    const t = times.get(u.name) || new Map()
    const stages = UNIT_STAGES.map((slug) => {
      const st = u.stages?.[slug] || null
      const isNow = running && running.unit === u.name && running.stage === slug
      return { slug, state: isNow && running.open ? 'working' : st === 'done' ? 'done' : st === 'skipped' ? 'skipped' : st === 'working' ? 'working' : 'pending', min: t.get(slug)?.min ?? null, now: !!isNow }
    })
    const bolts = unitBolts(events, u.name, { now: at, complete, worktrees: wts })
    // a swarm batch builds several units at once: any unit with a worktree still open is running
    const inWorktree = bolts.some((b) => b.worktree && b.outcome === 'working')
    const runningHere = (!!running && running.unit === u.name) || inWorktree
    if (runningHere && (inWorktree || running.stage === 'code-generation') && bolts.length && bolts.at(-1).outcome === 'working') bolts.at(-1).now = true
    const staged = Math.round(stages.reduce((n, s) => n + (s.min || 0), 0) * 10) / 10
    const workMin = Math.max(u.workMin || 0, Math.round((staged - (u.humanMin || 0)) * 10) / 10)
    const done = stages.filter((s) => s.state === 'done' || s.state === 'skipped').length
    return { ...u, workMin, stages, design: stages.slice(0, DESIGN_STAGES.length), bolts, group: groupOf.get(u.name) || null, done, total: stages.length, running: runningHere }
  })
}

// (the earlier shape, bolt plan groups → units, kept for the dashboards' bolt panel)
export function buildTree({ bolts, units, times, now: running }) {
  const byName = new Map(units.map((u) => [u.name, u]))
  const unitRow = (u) => {
    const t = times.get(u.name) || new Map()
    const stages = UNIT_STAGES.map((slug) => {
      const st = u.stages?.[slug] || null
      const tm = t.get(slug)
      const isNow = running && running.unit === u.name && running.stage === slug
      return { slug, state: isNow && running.open ? 'working' : st === 'done' ? 'done' : st === 'skipped' ? 'skipped' : st === 'working' ? 'working' : 'pending', min: tm?.min ?? null, now: !!isNow }
    })
    const done = stages.filter((s) => s.state === 'done' || s.state === 'skipped').length
    // the stages' own times (from their first event) when the audit's unit work undercounts a late UNIT_STARTED
    const staged = Math.round(stages.reduce((n, s) => n + (s.min || 0), 0) * 10) / 10
    const workMin = Math.max(u.workMin || 0, Math.round((staged - (u.humanMin || 0)) * 10) / 10)
    return { ...u, workMin, stages, done, total: stages.length, running: !!running && running.unit === u.name }
  }
  const used = new Set()
  const out = bolts.map((b) => {
    const rows = b.units.map((n) => byName.get(n)).filter(Boolean).map(unitRow)
    rows.forEach((r) => used.add(r.name))
    return { ...b, units: rows, status: boltStatus(rows) }
  })
  const rest = units.filter((u) => !used.has(u.name)).map(unitRow)
  if (rest.length) out.push({ n: out.length + 1, name: bolts.length ? 'Bolt 밖 유닛' : '유닛', id: 'units', units: rest, after: [], status: boltStatus(rest), loose: true })
  return out
}
export function boltStatus(rows) {
  if (!rows.length) return 'pending'
  if (rows.every((r) => r.status === 'done')) return 'done'
  if (rows.some((r) => r.running || r.status === 'working' || r.status === 'waiting')) return 'working'
  if (rows.some((r) => r.status === 'done')) return 'working'
  return rows.every((r) => r.status === 'blocked') ? 'blocked' : 'pending'
}
