// What the admin has confirmed about a recommendation, and what the miner may only propose (2026-11-10).
//
//   - a step's frequency is the draft: more than half of the cases → 필수, otherwise 옵션 (the miner's
//     core_by_frequency). The admin confirms; a confirmed step (confirmed[step]) is never changed by
//     the counts again
//   - every recommendation the admin has seen is a boundary sent to the miner: its key, category, required
//     steps, the cases it rests on (case_ids — pinned there) and the cases the admin took out (exclude)
//   - new cases of the same work never enter a recommendation by themselves: the miner hands them back as
//     new_case_ids / proposed, kept here as the recommendation's proposal until the admin decides
//
// 필수·옵션 mean what they mean in BPMN (shape.js): a step is optional when the definition has a way around
// it — the admin says when it is skipped, and that becomes an exclusive gateway with a condition. A step
// counts as optional here only then; 'optional' without a condition (the first version) changes nothing.
//
// Pure functions: no database, no model. service.js and talk.js read and write the rows.
import { ruleOf, stepKinds } from './shape.js'

const uniq = (xs) => [...new Set(xs)]

// the order the steps are shown in: the usual order first, then the rest as they first appear
export function stepOrder(pattern = {}) {
  const main = pattern.main_variant || []
  const rest = (pattern.variants || []).flatMap((v) => v.trace || [])
  return uniq([...main, ...rest, ...(pattern.core_activities || []), ...Object.keys(pattern.frequency || {})])
}

// how many of the recommendation's cases went through each step (older rows: from steps[].cases)
export function frequencyOf(pattern = {}) {
  if (pattern.frequency && Object.keys(pattern.frequency).length) return { ...pattern.frequency }
  const out = {}
  for (const v of pattern.variants || []) for (const a of uniq(v.trace || [])) out[a] = (out[a] || 0) + (v.count || 0)
  if (!Object.keys(out).length) for (const s of pattern.steps || []) out[s.activity] = s.cases || 0
  return out
}

// the draft from the counts alone: more than half of the cases (exactly half is one side of a branch)
export function draftOf(pattern = {}) {
  if (Array.isArray(pattern.core_by_frequency)) return [...pattern.core_by_frequency]
  const n = pattern.case_count || 0
  const f = frequencyOf(pattern)
  return Object.keys(f).filter((a) => n && f[a] * 2 > n)
}

// the required steps the recommendation stands on: the draft it was made with, with the admin's word on top
export function requiredOf(pattern = {}, confirmed = {}) {
  const base = new Set(pattern.core_activities || [])
  for (const [a, v] of Object.entries(confirmed || {})) {
    const r = ruleOf(v)
    if (r?.kind === 'required') base.add(a)
    else if (r?.kind === 'optional') base.delete(a)
  }
  return stepOrder(pattern).filter((a) => base.has(a)).concat([...base].filter((a) => !stepOrder(pattern).includes(a)))
}

// each step as the admin sees it. With the process definition (def): its kind is what the BPMN says —
// required when every path passes it, optional when there is a way around it (and when it is skipped),
// 'absent' when the definition does not have it. Without one: what the counts suggest.
// cases/total and draft are the evidence (how many cases went through it; more than half → required).
export function stepsView(pattern = {}, confirmed = {}, def = null) {
  const f = frequencyOf(pattern)
  const draft = new Set(draftOf(pattern))
  const req = new Set(requiredOf(pattern, confirmed))
  const kinds = def ? stepKinds(def) : null
  const order = [...stepOrder(pattern), ...Object.keys(kinds || {}).filter((a) => !stepOrder(pattern).includes(a))]
  return order.map((a) => ({
    activity: a,
    cases: f[a] || 0,
    total: pattern.case_count || 0,
    draft: draft.has(a) ? 'required' : 'optional',
    kind: kinds ? (kinds[a]?.kind || 'absent') : (req.has(a) ? 'required' : 'optional'),
    skip_when: kinds?.[a]?.skip_when || '',
    by: ruleOf(confirmed?.[a]) ? 'admin' : 'frequency',
  }))
}

// the required steps of a process definition: the tasks every path passes (BPMN)
export const requiredIn = (def) => (def?.activities?.length ? Object.entries(stepKinds(def)).filter(([, k]) => k.kind === 'required').map(([n]) => n) : null)

// the boundary one recommendation sends to the miner. `required`: the definition's required steps
// (requiredIn) — the same 필수 the admin sees; without a definition, the draft with the admin's word on top
export function boundaryOf(row, category = '', required = null) {
  const p = row.pattern || {}
  return {
    key: row.pattern_key,
    category: p.category || category || '',
    core_activities: required || requiredOf(p, row.confirmed || {}),
    case_ids: [...(p.case_ids || [])],
    exclude: [...(row.excluded || [])],
  }
}

// decided recommendations first, in the order they were decided; then the others, oldest first
export function boundaryOrder(rows) {
  const decided = rows.filter((r) => r.status === 'registered' || r.status === 'held')
  const open = rows.filter((r) => !(r.status === 'registered' || r.status === 'held'))
  const t = (x) => new Date(x || 0).getTime()
  decided.sort((a, b) => t(a.decided_at || a.created_at) - t(b.decided_at || b.created_at) || t(a.created_at) - t(b.created_at))
  open.sort((a, b) => t(a.created_at) - t(b.created_at))
  return [...decided, ...open]
}

// What the miner found for a recommendation that already exists. The cases and required steps stay
// as the admin has them; the miner's view of those same cases (counts, variants) is refreshed; the
// new cases become the proposal (null when there are none).
export function keepFound(row, p, required = null) {
  const before = row.pattern || {}
  const pattern = {
    ...p,
    case_ids: p.case_ids || [],
    case_count: (p.case_ids || []).length,
    core_activities: required || requiredOf(before, row.confirmed || {}),
    category: p.category || before.category || '',
  }
  delete pattern.new_case_ids
  delete pattern.proposed
  return { pattern, proposal: proposalOf(pattern, row.confirmed || {}, p, required) }
}

// the proposal for the admin: the new cases and what putting them in would change
export function proposalOf(pattern, confirmed, p, required = null) {
  const ids = p?.new_case_ids || []
  if (!ids.length || !p.proposed) return null
  const now = frequencyOf(pattern)
  const then = p.proposed.frequency || {}
  const req = required || requiredOf(pattern, confirmed)
  const draftNow = new Set(draftOf(pattern))
  const draftThen = new Set(p.proposed.core_by_frequency || [])
  return {
    case_ids: [...ids],
    case_count: ids.length,
    total: p.proposed.case_count || (pattern.case_count || 0) + ids.length,
    variants: p.proposed.variants || [],
    frequency: then,
    core_by_frequency: [...draftThen],
    // steps no confirmed case went through
    new_steps: Object.keys(then).filter((a) => !(a in now)),
    // required steps some of the new cases skipped: [step, how many of the new cases skipped it]
    missing_required: req.map((a) => [a, ids.length - ((then[a] || 0) - (now[a] || 0))]).filter(([, n]) => n > 0),
    // where the counts would now point the other way than what holds (the admin decides; nothing changes)
    draft_changes: uniq([...draftNow, ...draftThen]).filter((a) => draftNow.has(a) !== draftThen.has(a))
      .map((a) => ({ activity: a, draft: draftThen.has(a) ? 'required' : 'optional', holds: req.includes(a) ? 'required' : 'optional', by: confirmed?.[a] ? 'admin' : 'frequency' })),
  }
}

// the same proposal as before (the admin is told only when it is new or has grown)
export const sameCases = (a, b) => {
  const x = [...(a?.case_ids || [])].sort(), y = [...(b?.case_ids || [])].sort()
  return x.length === y.length && x.every((v, i) => v === y[i])
}

// ---------- the admin's words → one step, case or recommendation (talk.js) ----------
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, '')

// a step by its name; null when nothing or more than one matches (the admin is asked back)
export function findStep(name, steps) {
  const n = norm(name)
  if (!n) return null
  const exact = steps.filter((a) => norm(a) === n)
  if (exact.length === 1) return exact[0]
  const part = steps.filter((a) => norm(a).includes(n) || n.includes(norm(a)))
  return part.length === 1 ? part[0] : null
}

// the cases the admin's words point at ("새봄교육 온보딩 안내서 요청"): by id, or the cases whose subject,
// customer and category hold the most of those words. Several when they hold them equally — the same
// request mailed twice reads the same, and the admin means all of them.
export function findCases(ref, cases) {
  if (!norm(ref)) return []
  const byId = cases.filter((c) => c.case_id === ref)
  if (byId.length) return byId
  const words = String(ref).split(/[\s,·]+/).map(norm).filter((w) => w.length >= 2)
  const scored = cases.map((c) => {
    const text = norm([c.subject, c.customer, c.category].filter(Boolean).join(' '))
    const whole = [c.subject, c.customer].some((t) => t && (norm(t).includes(norm(ref)) || norm(ref).includes(norm(t)))) ? 0.5 : 0
    return { c, n: words.filter((w) => text.includes(w)).length + whole }
  }).filter((x) => x.n > 0)
  const top = Math.max(0, ...scored.map((x) => x.n))
  return scored.filter((x) => x.n === top).map((x) => x.c)
}

// one case, or null when the words fit none or several that differ (the admin is asked back)
export function findCase(ref, cases) {
  const hit = findCases(ref, cases)
  if (hit.length === 1) return hit[0]
  if (hit.length > 1 && hit.every((c) => norm(c.subject) === norm(hit[0].subject) && norm(c.customer) === norm(hit[0].customer))) return hit[0]
  return null
}

// a recommendation by its name or its category
export function findSuggestion(ref, rows) {
  const n = norm(ref)
  if (!n) return null
  const exact = rows.filter((r) => norm(r.name) === n || norm(r.pattern?.category || r.category) === n)
  if (exact.length === 1) return exact[0]
  const part = rows.filter((r) => [r.name, r.pattern?.category || r.category].some((t) => t && (norm(t).includes(n) || n.includes(norm(t)))))
  return part.length === 1 ? part[0] : null
}
