// 고쳐 보기(what-if) · 개선안 · 시행 전후 — the arithmetic (설계 docs/auto-ax-onboarding/design-improve-on-map.md §5, P3 · P4). Pure.
// The loader (flowload.js flowModel) hands in what the map says now: the process's steps (할 일 · 들어오고 넘기는 빠르기 · 걸린 시간 · 빠른 건의
// 시간), its usual way (흔한 길), and every role's open items across the company (회사의 제약). A plan is a list of levers — the map's own means
// (설계 §5.2): 에이전트가 맡음 · AI 초안 먼저 · 건너뛰기 · 빼기 · 나란히 · 다른 역할 · 사람 더하기 · 들어오는 건(가정).
// The rules are the old what-if's (lib/improve/whatif.js), read on the map's numbers:
//   - a step's time = its work + its waiting; the work is what the fast cases took (p20 — little waiting), the rest is waiting
//   - the waiting in front of a role scales with its queue (M/M/c, Erlang C), calibrated to now: 대기' = 대기 × Wq(λ', μ', c') / Wq(λ, μ, c)
//   - an agent's step: the agent's own time, its queue leaves the people; AI 초안: the person's work shrinks by `save` (가정, 기본 0.5)
//   - 할 일(예상) by Little's law on today's count: L' = L × (λ'/λ) × (W'/W); 「지금 들어오면」 meets today's queue, cleared at the new pace
// Nothing here writes; improveplans.js keeps plans and their review.
import * as F from './flowtime.js'
import { erlangWq } from '../improve/whatif.js'

export const LEVERS = ['agent', 'draft', 'skip', 'remove', 'parallel', 'role', 'capacity', 'demand']
export const LEVER_KO = { agent: '에이전트가 맡음', draft: 'AI 초안 먼저', skip: '건너뛰기', remove: '흐름에서 빼기', parallel: '나란히', role: '다른 역할이 맡음', capacity: '사람 더하기', demand: '들어오는 건' }
export const SAVE = 0.5 // AI 초안이 덜어 주는 사람 일의 몫(옛 사전 초안 규칙의 기본값, 가정)
export const SKIP = 0.3 // 건너뛰는 건의 몫을 모를 때(가정)
export const MONTH_DAYS = 21

const round = (v, k = 2) => (Number.isFinite(v) ? +v.toFixed(k) : null)
const clamp = (v, a, b) => Math.min(b, Math.max(a, v))
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
const fin = (w) => { const c = String(w).trim().slice(-1).charCodeAt(0); return c >= 0xac00 && c <= 0xd7a3 ? (c - 0xac00) % 28 : 0 }
const eun = (w) => (fin(w) ? '은' : '는')
const eul = (w) => (fin(w) ? '을' : '를')
const gwa = (w) => (fin(w) ? '과' : '와')
const pct = (x) => `${Math.round(x * 100)}%`

// ---------- levers ----------
// one lever, from a lever object or from a map operation (말로 고치기 · 의견의 ops) → null when it is not one the arithmetic knows
export function normLever(x) {
  if (!x || typeof x !== 'object') return null
  const a = x.args || x
  const task = clean(a.task).slice(0, 60)
  if (x.op) {
    switch (x.op) {
      case 'set_runner': return a.runner === 'agent' ? { type: 'agent', task } : a.runner === 'draft' ? { type: 'draft', task, save: SAVE } : null
      case 'set_requirement': return a.requirement === 'optional' ? { type: 'skip', task, share: SKIP, assumed: true } : null
      case 'remove_task': return task ? { type: 'remove', task } : null
      case 'set_parallel': return a.a && a.b ? { type: 'parallel', a: clean(a.a), b: clean(a.b) } : null
      case 'set_role': return task && a.role ? { type: 'role', task, to: clean(a.role) } : null
      default: return null
    }
  }
  const t = clean(x.type)
  switch (t) {
    case 'agent': case 'remove': return task ? { type: t, task } : null
    case 'draft': return task ? { type: t, task, save: clamp(Number(x.save ?? SAVE) || SAVE, 0.1, 0.9) } : null
    case 'skip': return task ? { type: t, task, share: clamp(Number(x.share ?? SKIP) || SKIP, 0.05, 0.95), ...(x.share == null ? { assumed: true } : {}) } : null
    case 'parallel': return x.a && x.b ? { type: t, a: clean(x.a), b: clean(x.b) } : null
    case 'role': return task && x.to ? { type: t, task, to: clean(x.to) } : null
    case 'capacity': {
      const people = (Array.isArray(x.people) ? x.people : []).map((p) => ({ id: String(p.id || ''), name: clean(p.name).slice(0, 40) })).filter((p) => p.id).slice(0, 5)
      const n = Math.max(people.length, clamp(Math.round(Number(x.n) || 1), 1, 5))
      return x.role ? { type: t, role: clean(x.role), n, people } : null
    }
    case 'demand': { const p = clamp(Number(x.pct) || 0, -90, 300); return p ? { type: t, pct: p } : null }
    default: return null
  }
}

export function leverLabel(l) {
  switch (l.type) {
    case 'agent': return `「${l.task}」${eun(l.task)} 에이전트가 맡음`
    case 'draft': return `「${l.task}」${eun(l.task)} AI가 초안을 먼저 씀(사람 일 ${pct(l.save)} 덜기, 가정)`
    case 'skip': return `「${l.task}」${eul(l.task)} 건 ${pct(l.share)}가 건너뜀${l.assumed ? '(가정)' : ''}`
    case 'remove': return `「${l.task}」${eul(l.task)} 흐름에서 뺌`
    case 'parallel': return `「${l.a}」${gwa(l.a)} 「${l.b}」${eul(l.b)} 나란히 함`
    case 'role': return `「${l.task}」${eul(l.task)} 「${l.to}」 역할이 맡음`
    case 'capacity': return `「${l.role}」 역할에 ${l.people?.length ? l.people.map((p) => p.name).join(' · ') : `${l.n}명`}${l.people?.length ? ' 님을 더함' : '을 더함'}`
    case 'demand': return `들어오는 건 ${l.pct > 0 ? '+' : ''}${l.pct}%(가정)`
    default: return l.type
  }
}

// the map operations a plan applies when it is decided (사람 더하기 goes to the role's members; 들어오는 건 is only an assumption)
export function opsOf(levers = []) {
  const out = []
  for (const l of levers.map(normLever).filter(Boolean)) {
    if (l.type === 'agent') out.push({ op: 'set_runner', args: { task: l.task, runner: 'agent' } })
    else if (l.type === 'draft') out.push({ op: 'set_runner', args: { task: l.task, runner: 'draft' } })
    else if (l.type === 'skip') out.push({ op: 'set_requirement', args: { task: l.task, requirement: 'optional' } })
    else if (l.type === 'remove') out.push({ op: 'remove_task', args: { task: l.task } })
    else if (l.type === 'parallel') out.push({ op: 'set_parallel', args: { a: l.a, b: l.b } })
    else if (l.type === 'role') out.push({ op: 'set_role', args: { task: l.task, role: l.to } })
  }
  return out
}

// ---------- the model ----------
// model (flowload.js flowModel): { proc, tasks: [{key, role, outside, agent, wip, inPerDay, perDay, pastH, fastH, grade}],
//   path: {steps: [key], parallel: [[a, b]]}, roles: [{role, members, items: [{task, proc, wip, inPerDay, perDay}]}], agentH }
// a step's work: what its fast cases took (p20), never more than its whole time
const workOf = (t) => (t.pastH == null ? null : clamp(t.fastH ?? t.pastH * 0.5, Math.min(0.05, t.pastH), t.pastH))

function roleBase(r, tasksHere) {
  const c = Math.max(1, r.members || 0)
  const lam = r.items.reduce((s, x) => s + (x.inPerDay || 0), 0)
  const done = r.items.reduce((s, x) => s + (x.perDay || 0), 0)
  const wip = r.items.reduce((s, x) => s + (x.wip || 0), 0)
  // the work per item: the λ-weighted work of this process's steps of the role (other processes' steps: assumed alike)
  const mine = tasksHere.filter((t) => t.role === r.role && !t.agent && !t.outside && workOf(t) != null && t.inPerDay > 0)
  const lamMine = mine.reduce((s, t) => s + t.inPerDay, 0)
  const avgWork = lamMine ? mine.reduce((s, t) => s + t.inPerDay * workOf(t), 0) / lamMine : null
  // capacity (items per working day): a role with a real queue (QUEUE open items a person, or more coming in than handed on while every
  // person holds one) works flat out — what it hands on is what it can do; otherwise its people's hours over the work per item (and never
  // less than what comes in). Two weeks with a few more arrivals than hand-offs is not a queue for a role with people to spare.
  const saturated = wip >= F.QUEUE * c || (lam > done * 1.05 && wip >= c)
  const byWork = avgWork ? (c * F.WORK_H) / avgWork : 0
  const cap = saturated ? Math.max(done, 1e-3) : Math.max(byWork, lam * 1.15, done, 1e-3)
  return { role: r.role, c, lam, done, wip, cap, saturated, avgWork, items: r.items.map((x) => ({ ...x })) }
}

const waitOf = (R) => (R.lam > 0 ? erlangWq(R.lam, R.cap / R.c, R.c) : 0)

// the numbers a side (before · after) shows
function sideOf(model, S, roles) {
  const times = new Map(), load = new Map()
  const stepOut = []
  for (const t of S.tasks.values()) {
    if (t.removed) continue
    const w = 1 - (t.skip || 0)
    times.set(t.key, { medH: t.pastH == null ? null : t.pastH * w, estimated: t.grade !== 'run' })
    load.set(t.key, { wip: t.wip, clearH: t.clearH == null ? null : t.clearH * w })
  }
  const path = S.path.filter((k) => !S.tasks.get(k)?.removed)
  const P = F.pathTime(path, times, load, { parallel: S.par.filter(([a, b]) => path.includes(a) && path.includes(b)) })
  // ahead: the open items the step would carry once the change has settled (Little's law, flowplan below) — before: today's count
  const ahead = (t) => t.wipAhead ?? t.wip
  for (const s of P.steps) { const t = S.tasks.get(s.key); stepOut.push({ ...s, ahead: round(ahead(t || {}), 1), agent: !!t?.agent, skip: t?.skip || 0, role: t?.role || '' }) }
  const ours = [...S.tasks.values()].filter((t) => !t.removed && !t.agent && !t.outside)
  const byWip = [...ours].sort((a, b) => ahead(b) - ahead(a) || (b.pastH || 0) - (a.pastH || 0))
  const bott = ahead(byWip[0] || {}) > 0 ? { key: byWip[0].key, wip: round(ahead(byWip[0]), 1), role: byWip[0].role } : null
  const R = [...roles.values()].map((r) => ({ role: r.role, members: r.c, rho: round(r.lam / r.cap, 2), wip: round(r.wipNow ?? r.wip, 1), perPerson: round((r.wipNow ?? r.wip) / r.c, 1), saturated: r.lam >= r.cap }))
    .sort((a, b) => b.perPerson - a.perPerson || b.rho - a.rho)
  const monthly = ours.reduce((s, t) => s + (t.inPerDay || 0) * (1 - (t.skip || 0)), 0) * MONTH_DAYS
  const hours = ours.reduce((s, t) => s + (t.inPerDay || 0) * (1 - (t.skip || 0)) * (t.work ?? 0), 0) * MONTH_DAYS
  const onPath = path.map((k) => S.tasks.get(k)).filter(Boolean)
  const pastSum = onPath.reduce((s, t) => s + (t.pastH || 0) * (1 - (t.skip || 0)), 0)
  const workSum = onPath.reduce((s, t) => s + (t.work ?? 0) * (1 - (t.skip || 0)), 0)
  return {
    pastH: P.pastH, nowH: P.nowH, longest: P.longest, steps: stepOut, bottleneck: bott,
    constraint: R[0]?.wip > 0 ? R[0] : null, roles: R, monthly: { items: Math.round(monthly), hours: Math.round(hours) },
    flowEff: pastSum ? round(workSum / pastSum, 2) : null,
  }
}

// before · after of a plan (levers) on the model
export function whatIfFlow(model, levers = []) {
  const lv = levers.map(normLever).filter(Boolean)
  const base = new Map(model.tasks.map((t) => [t.key, { ...t, work: t.agent ? t.pastH : workOf(t), clearH: t.clearH ?? null }]))
  const roles0 = new Map(model.roles.map((r) => [r.role, roleBase(r, model.tasks)]))
  const before = sideOf(model, { tasks: base, path: model.path.steps, par: model.path.parallel || [] }, roles0)

  const S = { tasks: new Map([...base].map(([k, t]) => [k, { ...t }])), path: [...model.path.steps], par: [...(model.path.parallel || [])] }
  const roles = new Map([...roles0].map(([k, r]) => [k, { ...r, items: r.items.map((x) => ({ ...x })) }]))
  const notes = new Set(), skipped = []
  const R = (name) => roles.get(name) || null
  const lamOf = (t) => t.inPerDay || 0
  const take = (r, task, d) => { if (!r) return; r.lam = Math.max(0, r.lam - d); const it = r.items.find((x) => x.task === task && x.proc === model.proc.key); if (it) it.inPerDay = Math.max(0, (it.inPerDay || 0) - d) }
  for (const l of lv) {
    const t = l.task ? S.tasks.get(l.task) : null
    if (['agent', 'draft', 'skip', 'remove', 'role'].includes(l.type) && !t) { skipped.push({ lever: l, why: `「${l.task}」${eun(l.task)} 이 프로세스에 없어요.` }); continue }
    switch (l.type) {
      case 'agent':
        if (t.agent) { skipped.push({ lever: l, why: '이미 에이전트가 해요.' }); break }
        take(R(t.role), t.key, lamOf(t))
        Object.assign(t, { agent: true, pastH: model.agentH, work: model.agentH, wip: 0, clearH: 0, changed: true })
        break
      case 'draft': {
        const r = R(t.role)
        if (t.agent) { skipped.push({ lever: l, why: '에이전트가 하는 일이에요.' }); break }
        if (r) {
          const share = r.avgWork && t.work != null && r.lam ? (lamOf(t) * t.work) / (r.avgWork * r.lam) : r.lam ? lamOf(t) / r.lam : 0
          r.cap = r.cap / (1 - l.save * clamp(share, 0, 1))
        }
        t.draftSave = l.save; t.changed = true
        notes.add(`AI 초안이 사람 일을 ${pct(l.save)} 덜어 준다고 봤어요(가정 — 시행한 뒤 실측으로 맞춰 봐요).`)
        break
      }
      case 'skip':
        take(R(t.role), t.key, lamOf(t) * l.share)
        t.skip = l.share; t.changed = true
        if (l.assumed) notes.add(`건너뛰는 건의 몫을 모르는 단계는 ${pct(SKIP)}로 봤어요(가정).`)
        break
      case 'remove':
        take(R(t.role), t.key, lamOf(t))
        t.removed = true
        break
      case 'parallel':
        if (!S.tasks.has(l.a) || !S.tasks.has(l.b)) { skipped.push({ lever: l, why: '두 단계가 모두 이 프로세스에 있어야 해요.' }); break }
        S.par.push([l.a, l.b])
        break
      case 'role': {
        const to = R(l.to)
        if (!to) { skipped.push({ lever: l, why: `「${l.to}」 역할을 찾지 못했어요.` }); break }
        take(R(t.role), t.key, lamOf(t))
        to.lam += lamOf(t)
        to.items.push({ task: t.key, proc: model.proc.key, wip: 0, inPerDay: lamOf(t), perDay: 0 })
        t.role = l.to; t.changed = true
        break
      }
      case 'capacity': {
        const r = R(l.role)
        if (!r) { skipped.push({ lever: l, why: `「${l.role}」 역할을 찾지 못했어요.` }); break }
        r.cap = r.cap * ((r.c + l.n) / r.c); r.c += l.n
        break
      }
      case 'demand':
        for (const x of S.tasks.values()) {
          if (x.outside || x.agent) continue
          const d = lamOf(x) * (l.pct / 100)
          x.inPerDay = Math.max(0, lamOf(x) + d)
          const r = R(x.role)
          if (r) { r.lam = Math.max(0, r.lam + d); const it = r.items.find((y) => y.task === x.key && y.proc === model.proc.key); if (it) it.inPerDay = Math.max(0, (it.inPerDay || 0) + d) }
        }
        notes.add(`들어오는 건이 ${l.pct > 0 ? '+' : ''}${l.pct}% 바뀐다고 봤어요(가정).`)
        break
      default: break
    }
  }
  // the waiting in front of each role: as its queue changes (Erlang C, the old what-if's rule)
  const factor = new Map()
  for (const [k, r] of roles) {
    const r0 = roles0.get(k)
    const w0 = waitOf(r0), w1 = waitOf(r)
    factor.set(k, w0 > 0 ? w1 / w0 : 1)
  }
  for (const t of S.tasks.values()) {
    const t0 = base.get(t.key)
    if (t.removed || t.agent || t.outside || t0.pastH == null) continue
    const f = factor.get(t.role) ?? factor.get(t0.role) ?? 1
    const work0 = t0.work ?? 0, work1 = work0 * (1 - (t.draftSave || 0))
    const wait0 = Math.max(0, t0.pastH - work0)
    t.work = work1
    t.pastH = round(work1 + wait0 * f, 2)
    // 할 일(예상): Little's law on today's count — L' = L × (λ'/λ) × (W'/W)
    const lr = lamOf(t0) > 0 ? lamOf(t) / lamOf(t0) : 1
    const wr = t0.pastH > 0 ? t.pastH / t0.pastH : 1
    t.wipAhead = round(t0.wip * lr * wr, 1)
    // 지금 들어오면: today's queue, at the new pace (the role's capacity over what still comes in, this step's share)
    const r0 = roles0.get(t0.role), r1 = roles.get(t.role)
    const pace = r0 && r1 && r0.cap > 0 && r1.lam > 0 && r0.lam > 0 ? (r1.cap / r0.cap) * (r0.lam / r1.lam) : r0 && r1 && r0.cap > 0 ? r1.cap / r0.cap : 1
    const perDay = (t0.perDay || 0) * pace * (lamOf(t0) > 0 ? lamOf(t) / lamOf(t0) : 1)
    t.clearH = t0.wip ? (perDay > 0 ? round((t0.wip / perDay) * F.WORK_H, 1) : null) : 0
  }
  // what each role carries afterwards (this process's steps by the estimate above; the role's other steps by its waiting)
  for (const [k, r] of roles) {
    const f = factor.get(k) ?? 1
    let wip = 0
    for (const it of r.items) {
      const t = it.proc === model.proc.key ? S.tasks.get(it.task) : null
      if (t) wip += t.removed || t.agent || t.role !== k ? 0 : (t.wipAhead ?? t.wip ?? 0)
      else wip += (it.wip || 0) * (0.5 + 0.5 * f)
    }
    r.wipNow = wip
  }
  const after = sideOf(model, S, roles)
  for (const r of roles.values()) if (lv.length && r.lam >= r.cap && r.lam > 0 && r.items.some((x) => x.proc === model.proc.key)) notes.add(`「${r.role}」 역할은 바꾼 뒤에도 들어오는 일이 처리하는 빠르기보다 많아요 — 할 일이 계속 쌓여요.`)
  notes.add('일과 기다림은 빠른 건(20%)이 걸린 시간을 일로 보고 나눴어요. 기다림은 역할 앞에 선 줄의 길이만큼 늘고 줄어요(추정).')
  return {
    before, after, levers: lv.map((l) => ({ ...l, label: leverLabel(l) })), skipped: skipped.map((s) => ({ ...s, label: leverLabel(s.lever) })),
    ops: opsOf(lv), notes: [...notes], estimated: true,
    moved: before.bottleneck && after.bottleneck && before.bottleneck.key !== after.bottleneck.key ? { from: before.bottleneck.key, to: after.bottleneck.key } : null,
  }
}

// ---------- 시행 전후 ----------
// a decided plan against what happened since its effective day: plan = {baseline, predicted (after side)}, now = the flow view's numbers
// with times since that day ({pastH, nowH, bottleneck, roles, tasks}) → rows [{key, label, before, predicted, actual, unit, verdict}]
export function reviewOf(plan, now) {
  const b = plan.baseline || {}, p = plan.predicted || {}
  const rows = []
  const add = (key, label, before, predicted, actual, unit = 'h', lowerBetter = true) => {
    let verdict = null
    if ([before, predicted, actual].every(Number.isFinite) && before !== predicted) {
      const want = before - predicted, got = before - actual
      const r = want ? got / want : 0
      verdict = r >= 0.8 ? (r > 1.25 ? 'better' : 'met') : r > 0.2 ? 'partly' : lowerBetter ? (actual > before ? 'worse' : 'none') : 'none'
    }
    rows.push({ key, label, before: round(before, 1), predicted: round(predicted, 1), actual: round(actual, 1), unit, verdict })
  }
  add('path', '보통 건(흔한 길)', b.pastH, p.pastH, now.pastH)
  add('now', '지금 들어오면', b.nowH, p.nowH, now.nowH)
  if (b.bottleneck) {
    const was = b.bottleneck.key
    add('bott', `「${was}」 할 일`, b.bottleneck.wip, p.steps?.find((s) => s.key === was)?.ahead ?? null, now.tasks?.find((t) => t.key === was)?.wip ?? null, '건')
  }
  const role = b.constraint?.role
  if (role) add('role', `「${role}」 한 사람당 할 일`, b.constraint.perPerson, p.roles?.find((r) => r.role === role)?.perPerson ?? null, now.roles?.find((r) => r.role === role)?.perPerson ?? null, '건')
  return { rows, moved: b.bottleneck && now.bottleneck && b.bottleneck.key !== now.bottleneck.key ? { from: b.bottleneck.key, to: now.bottleneck.key } : null }
}
export const VERDICT_KO = { better: '예상보다 더 좋아졌어요', met: '예상만큼', partly: '예상의 일부만', none: '그대로예요', worse: '오히려 나빠졌어요' }
