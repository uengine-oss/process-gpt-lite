// The strategic score of an alternative (plan.md §4): Σ objective weight × contribution − risk penalty (scaled
// by the risk appetite) − delay cost. Weights come from the strategy graph (lib/strategy/graph.js): an
// objective's priority 1..5 gives PRIORITY_WEIGHT 1 … 0.1. The risk penalty of a category is its exposure
// (lib/optimize/simulate.js) × RISK_SCALE × the strictest stake any objective holds in it — the objective's weight ×
// (1 − APPETITE[its risk appetite]): a top-priority objective with a low appetite for privacy makes privacy
// exposure cost the most. An alternative a "must" constraint's policy denies is excluded (no score); a "should"
// constraint denied costs SHOULD_PENALTY × the objective's weight. Deterministic.
import { PRIORITY_WEIGHT, APPETITE, constraintsOf } from '../strategy/graph.js'
import { L } from '../lang.js'

export const WEIGHTS = {
  riskScale: 10,          // a whole horizon of a high-severity finding open to every user costs 10 points × stake
  defaultAppetite: 'medium',
  shouldPenalty: 0.15,
  dayCost: 0.02,          // each day until the whole plan is public
  phaseCost: 0.05,        // each extra deployment (coordination, another regression run)
  autoMargin: 0.1,        // the best allowed alternative runs on its own only this far ahead of the next
}
const round = (x, n = 3) => Math.round(x * 10 ** n) / 10 ** n
export const weightOf = (o) => PRIORITY_WEIGHT[o.priority] ?? PRIORITY_WEIGHT[3]

// how much one unit of exposure in a category costs: the strictest objective stake in it
export function stakes(graph) {
  const out = {}
  for (const c of ['privacy', 'security', 'quality']) {
    const holders = graph.objectives.filter((o) => o.risk_appetite?.[c])
    out[c] = holders.length
      ? Math.max(...holders.map((o) => weightOf(o) * (1 - (APPETITE[o.risk_appetite[c]] ?? APPETITE.medium))))
      : 1 - APPETITE[WEIGHTS.defaultAppetite]
    out[c] = round(out[c])
  }
  return out
}

// which constraints an alternative breaks, from the policies that matched its phases (PDP dry runs): a "must"
// constraint is broken when its policy denies (requiring its approver is not breaking it — the approver can lift
// it); a "should" constraint already when its policy does not simply allow (deny or require_approval)
export function breaksOf(graph, matched) {
  const cons = constraintsOf(graph)
  const out = new Map()
  for (const m of matched) {
    const c = cons[m.id]
    if (!c || out.has(m.id)) continue
    const broken = m.decision === 'deny' || (c.level === 'should' && m.decision === 'require_approval')
    if (broken) out.set(m.id, { policy: m.id, level: c.level, objectives: c.objectives, decision: m.decision, title: m.title })
  }
  return [...out.values()]
}

// the score of one simulated alternative: {total, value, risk, delay, should, parts[]} or null when excluded
export function score(graph, sim, breaks = []) {
  if (breaks.some((b) => b.level === 'must')) return null
  const parts = []
  let value = 0
  for (const o of graph.objectives) {
    const c = sim.contribution[o.id]
    if (c == null) continue
    const w = weightOf(o)
    value += w * c
    parts.push({ objective: o.id, name: o.name, weight: w, contribution: c, points: round(w * c) })
  }
  const st = stakes(graph)
  const riskParts = Object.entries(sim.risk).filter(([, v]) => v > 0).map(([c, v]) => ({ category: c, exposure: v, stake: st[c], points: round(WEIGHTS.riskScale * v * st[c]) }))
  const risk = riskParts.reduce((s, r) => s + r.points, 0)
  const byId = Object.fromEntries(graph.objectives.map((o) => [o.id, o]))
  const should = breaks.filter((b) => b.level === 'should').reduce((s, b) => s + WEIGHTS.shouldPenalty * Math.max(...b.objectives.map((id) => weightOf(byId[id] || {}))), 0)
  const delay = WEIGHTS.dayCost * sim.daysToFull + WEIGHTS.phaseCost * Math.max(0, sim.phases - 1)
  const max = graph.objectives.reduce((s, o) => s + (sim.contribution[o.id] == null ? 0 : weightOf(o)), 0)
  const total = value - risk - should - delay
  return { total: round(total), value: round(value), risk: round(risk), should: round(should), delay: round(delay), max: round(max), share: max ? round(Math.max(0, total) / max) : 0, parts, riskParts }
}

// one line on why an alternative ranks where it does
export function why(s) {
  if (!s) return ''
  const top = [...s.parts].sort((a, b) => b.points - a.points)[0]
  const bits = [L(`목표 가치 ${s.value}`, `objective value ${s.value}`)]
  if (s.risk) bits.push(L(`위험 −${s.risk}`, `risk −${s.risk}`))
  if (s.should) bits.push(L(`권장 제약 −${s.should}`, `should-constraints −${s.should}`))
  if (s.delay) bits.push(L(`지연 −${round(s.delay, 2)}`, `delay −${round(s.delay, 2)}`))
  return `${bits.join(' · ')}${top ? L(` (가장 큰 몫: ${top.name})`, ` (largest share: ${top.name})`) : ''}`
}
