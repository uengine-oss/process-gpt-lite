// The simulation behind the path optimizer (plan.md §4 "대안"): a simple, explained model of a rollout plan, no
// model call. An alternative is a plan of phases — {day, audience, rollout %, items, fixes} — over a horizon of
// two weeks from the planned date. From it:
//   - per item: reach over the horizon (the widest audience it has reached, day by day: public 1, beta 0.3,
//     internal 0.1, times the rollout share), the day it first ships anywhere, and how long it is in someone's hands
//   - per objective: the share of the planned value it delivers, by the objective's KPI measure (kpi.measure):
//       reach     the value users get over the horizon (default)        — Σ link weight × reach / Σ link weight
//       on_time   shipped on the planned date (anywhere), less a day late less (gone after a week)
//       feedback  the part of the horizon the item is used by anyone (learning, early feedback)
//   - residual risk per category: an item with an open finding of that category, shipped while the finding is open,
//     exposes reach × severity for the days until it is fixed (or the horizon ends)
//   - days to the whole plan being public, and how many phases (each extra deployment is coordination and a re-test)
// The numbers are a model's, stated in its explain lines, not a forecast.
import { L } from '../lang.js'

export const MODEL = {
  horizonDays: 14,
  reach: { public: 1, beta: 0.3, internal: 0.1 },
  severity: { high: 1, medium: 0.6, low: 0.3 },
  onTimeGraceDays: 7,
}

const clamp01 = (x) => Math.max(0, Math.min(1, x))
const round = (x, n = 3) => Math.round(x * 10 ** n) / 10 ** n
export const phaseReach = (p) => (MODEL.reach[p.audience] ?? 0) * clamp01((p.rollout ?? 100) / 100)

// a finding is fixed at a phase if the plan fixes it and its fix estimate has passed by then
export function openAt(finding, day, fixes = []) {
  if (finding.status === 'fixed') return false
  if (!fixes.includes(finding.id) || finding.fix_days == null) return true
  return day < finding.fix_days
}

// how one item fares under a plan
export function itemTimeline(item, phases) {
  const H = MODEL.horizonDays
  const mine = phases.filter((p) => p.items.includes(item)).sort((a, b) => a.day - b.day)
  if (!mine.length) return { first: null, reach: 0, onTime: 0, feedback: 0, publicDay: null }
  const first = mine[0].day
  // reach over the horizon: the widest audience reached so far, day by day (piecewise constant)
  let area = 0, best = 0
  const steps = [...mine.map((p) => p.day), H].filter((d) => d <= H)
  for (let i = 0; i < steps.length - 1; i++) {
    best = Math.max(best, ...mine.filter((p) => p.day <= steps[i]).map(phaseReach))
    area += best * (steps[i + 1] - steps[i])
  }
  const pub = mine.find((p) => p.audience === 'public' && (p.rollout ?? 100) >= 100)
  return {
    first,
    reach: round(area / H),
    onTime: first <= 0 ? 1 : round(clamp01(1 - first / MODEL.onTimeGraceDays)),
    feedback: first < H ? round((H - first) / H) : 0,
    publicDay: pub ? pub.day : null,
  }
}

// residual risk per category: Σ reach × severity × (days the item ships while its finding is open) / horizon
export function exposure(phases, findings, fixes = []) {
  const H = MODEL.horizonDays
  const out = { privacy: 0, security: 0, quality: 0 }
  const items = [...new Set(phases.flatMap((p) => p.items))]
  for (const f of findings.filter((x) => x.status !== 'fixed' && items.includes(x.feature))) {
    const shipped = phases.filter((p) => p.items.includes(f.feature)).sort((a, b) => a.day - b.day)
    const fixedAt = fixes.includes(f.id) && f.fix_days != null ? f.fix_days : H
    let worst = 0
    for (const p of shipped) {
      const until = Math.min(fixedAt, H)
      if (p.day >= until) continue
      worst = Math.max(worst, phaseReach(p) * (MODEL.severity[f.severity] ?? 1) * (until - p.day) / H)
    }
    out[f.category] = round((out[f.category] || 0) + worst)
  }
  return out
}

// one alternative's simulation against the strategy graph: {items, contribution, delivered, risk, daysToFull, ...}
// sourceOf(item) names the item's links in the graph ('feature:공유 링크').
export function simulate({ phases, fixes = [] }, { planned, findings, graph, sourceOf }) {
  const items = {}
  for (const it of planned) items[it] = itemTimeline(it, phases)
  const contribution = {}
  const explain = []
  for (const o of graph.objectives) {
    const links = graph.links.filter((l) => l.objective === o.id && l.relation === 'contributes' && planned.some((it) => sourceOf(it) === l.source))
    const measure = o.kpi?.measure || 'reach'
    const total = links.reduce((s, l) => s + Number(l.weight), 0)
    if (!total) { contribution[o.id] = null; continue }
    const got = links.reduce((s, l) => s + Number(l.weight) * (items[planned.find((it) => sourceOf(it) === l.source)]?.[measure === 'on_time' ? 'onTime' : measure] ?? 0), 0)
    contribution[o.id] = round(got / total)
  }
  const risk = exposure(phases, findings, fixes)
  const pubDays = planned.map((it) => items[it].publicDay)
  const daysToFull = pubDays.some((d) => d == null) ? MODEL.horizonDays : Math.max(0, ...pubDays)
  const firstDay = Math.min(...phases.map((p) => p.day))
  const delivered = round(planned.reduce((s, it) => s + items[it].reach, 0) / Math.max(1, planned.length))
  explain.push(L(`계획한 기능이 2주 동안 사용자에게 닿는 몫 ${Math.round(delivered * 100)}%`, `${Math.round(delivered * 100)}% of the planned value reaches users within two weeks`))
  if (daysToFull) explain.push(L(`모두 공개되기까지 ${daysToFull}일`, `${daysToFull} days until everything is public`))
  const CAT = { privacy: ['개인정보', 'Privacy'], security: ['보안', 'Security'], quality: ['품질', 'Quality'] }
  for (const [c, v] of Object.entries(risk)) if (v > 0) explain.push(L(`${CAT[c][0]} 위험 노출 ${v}`, `${CAT[c][1]} risk exposure ${v}`))
  return { items, contribution, risk, delivered, daysToFull, firstDay, phases: phases.length, explain }
}
