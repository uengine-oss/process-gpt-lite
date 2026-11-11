// The bolt board's own logic (test/apps.test.js): bolts → units → the unit's construction stages,
// each with its state and time, from the bolt plan, the unit plan and the audit — no database.
export const UNIT_STAGES = ['functional-design', 'nfr-requirements', 'nfr-design', 'infrastructure-design', 'code-generation']
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

// the tree: bolts in plan order with their units; units no bolt names go in a bolt of their own
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
