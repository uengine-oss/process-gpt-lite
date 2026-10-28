// what-if: 단계 하나를 바꾸면(자동화·사전 초안·건너뛰기·동시에·인원 추가·보완 줄이기) 리드타임·크리티컬 패스·
// 흐름 효율·가동률이 어떻게 바뀌는지 바로 다시 계산한다. 모두 결정적 계산(모델 호출 없음).
// 단계 시간 = 대기 + 작업. 사람 자원 앞의 대기는 대기열 모형(M/M/c, Erlang C)을 지금 기록에 맞춰 보정한 뒤
// 수요 λ·처리 능력 μ·인원 c 가 바뀐 비율만큼 늘이거나 줄인다: 대기' = 대기 × Wq(λ',μ',c') / Wq(λ,μ,c).
import { buildGraph } from './graph.js'
import { criticalPath } from './cpm.js'
import { percentile, mean } from './analyze.js'
import { resourceKey, workdaysBetween } from './toc.js'
import { transformDefinition, describeChange } from './transform.js'
import { L } from '../lang.js'

const RHO_MAX = 0.97

function erlangWq(lambda, mu, c) {
  if (!mu || !lambda) return 0
  const a = lambda / mu
  const rho = a / c
  if (rho >= RHO_MAX) return erlangWq(RHO_MAX * c * mu, mu, c) * (1 + 4 * (rho - RHO_MAX))
  let sum = 0, term = 1
  for (let k = 0; k < c; k++) { if (k) term *= a / k; sum += term }
  const last = term * (a / c) // a^c / c!
  const tail = last * (c / (c - a))
  const C = tail / (sum + tail)
  return C / (c * mu - lambda)
}

/** the model behind CPM and the what-if, from the analysis and the resources (toc.resources) */
export function buildModel(a, res, { basis = 'median' } = {}) {
  const q = basis === 'p80' ? 0.8 : 0.5
  const act = {}
  for (const id of a.g.activities) {
    const xs = a.executions.filter((x) => x.activityId === id && x.done)
    const first = xs.filter((x) => x.seq === 0)
    const re = xs.filter((x) => x.seq > 0)
    const n = a.g.nodes.get(id)
    const durs = first.map((x) => x.duration)
    const d = percentile(durs, q) ?? 0
    const md = mean(durs) || 0
    // wait share of the usual run (queue + review + idle); the rest is work. Of the wait, the part spent
    // behind other runs of the same person (차례 기다림) is what demand and capacity change
    const waitShare = md ? mean(first.map((x) => x.wait + x.idle)) / md : 0
    const waitMean = mean(first.map((x) => x.wait + x.idle)) || 0
    const behindShare = waitMean ? (mean(first.map((x) => x.behind || 0)) || 0) / waitMean : 0
    const rk = new Map()
    for (const x of xs) rk.set(resourceKey(x), (rk.get(resourceKey(x)) || 0) + 1)
    const resource = [...rk].sort((p, r) => r[1] - p[1])[0]?.[0] || (n.human ? `person:${n.role}` : `agent:${n.name}`)
    // the step's time at this basis (median / p80) is mostly waiting when it is long; the work itself is
    // what people and agents usually spend (mean work, at most the whole step time)
    const workMean = mean(first.map((x) => x.work)) || 0
    const work = Math.min(workMean || d * (1 - waitShare), d)
    const reD = re.length ? (percentile(re.map((x) => x.duration), q) || 0) : null
    const reWork = re.length ? Math.min(mean(re.map((x) => x.rework + x.work)) || 0, reD) : null
    act[id] = {
      id, name: n.name, kind: n.human ? 'human' : 'agent', resource, n: first.length,
      wait: d - work, work, behindShare,
      reWait: reD != null ? reD - reWork : null, reWork,
      workMean,
    }
  }
  const p = {}
  for (const b of Object.values(a.branches)) for (const e of b.edges) p[e.id] = e.p
  const R = {}
  for (const r of res) R[r.key] = { key: r.key, kind: r.kind, name: r.name, lambda: r.lambdaPerDay, mu: r.muPerDay, c: 1, rho: r.rho, work: r.workPerItem }
  const agentSteps = Object.values(act).filter((x) => x.kind === 'agent' && x.n)
  return {
    basis, act, p, R,
    agentWork: percentile(agentSteps.map((x) => x.work), 0.5) ?? 300,
    agentWait: percentile(agentSteps.map((x) => x.wait), 0.5) ?? 30,
  }
}

const cloneModel = (m) => ({ ...m, act: Object.fromEntries(Object.entries(m.act).map(([k, v]) => [k, { ...v }])), p: { ...m.p }, R: Object.fromEntries(Object.entries(m.R).map(([k, v]) => [k, { ...v }])) })

/** evaluate one model: CPM (expected lead time, path), expected work, flow efficiency, utilisation */
export function evaluate(g, m) {
  const dur = {}, reDur = {}
  for (const [id, x] of Object.entries(m.act)) {
    dur[id] = x.wait + x.work
    reDur[id] = x.reWait != null ? x.reWait + x.reWork : dur[id]
  }
  const cp = criticalPath(g, { dur, reDur, p: m.p })
  // expected work per instance: each step's work × the chance it runs, plus the extra passes of loops
  let work = 0
  const loopPasses = {}
  for (const l of cp.loops) for (const id of loopBody(g, l.to, l.from)) loopPasses[id] = (loopPasses[id] || 0) + l.passes
  for (const [id, x] of Object.entries(m.act)) {
    const pa = cp.activeP[id] ?? 0
    work += pa * (x.work + (loopPasses[id] || 0) * (x.reWork ?? x.work))
  }
  const util = Object.values(m.R).map((r) => ({ key: r.key, name: r.name, kind: r.kind, rho: r.mu ? r.lambda / (r.c * r.mu) : 0, c: r.c, lambda: r.lambda, mu: r.mu }))
  const top = util.filter((u) => u.kind === 'human').sort((p, q) => q.rho - p.rho)[0] || null
  return {
    leadSec: Math.round(cp.expectedT), mainSec: Math.round(cp.main?.T || 0), workSec: Math.round(work),
    flowEfficiency: cp.expectedT ? work / cp.expectedT : null,
    path: cp.main?.path || [], pathProb: cp.main?.prob ?? 1, criticality: cp.criticality, loops: cp.loops,
    steps: Object.fromEntries(Object.entries(m.act).map(([id, x]) => [id, { wait: Math.round(x.wait), work: Math.round(x.work), dur: Math.round(x.wait + x.work), kind: x.kind, resource: x.resource, p: cp.activeP[id] ?? 0, critical: cp.main?.nodes?.[id]?.critical || false }])),
    util, constraint: top, cp,
  }
}

function loopBody(g, from, to) {
  // nodes on DAG paths from `from` to `to`
  const reach = new Set([from])
  for (const id of g.topo) if (reach.has(id)) for (const e of g.dout.get(id)) reach.add(e.target)
  const back = new Set([to])
  for (const id of [...g.topo].reverse()) if (back.has(id)) for (const e of g.din.get(id)) back.add(e.source)
  return [...reach].filter((id) => back.has(id) && g.nodes.get(id).kind === 'activity')
}

/**
 * a: analysis, res: toc.resources(a), changes: [{type, step, ...}], ctx: {share: {step: skipShare}, agentFor}
 * → {before, after, changes(described), g (after), def (after)}
 */
export function whatIf(a, res, changes = [], { basis = 'median', share = {}, agentFor } = {}) {
  const base = buildModel(a, res, { basis })
  const before = evaluate(a.g, base)
  const t = transformDefinition(a.g.def, changes, { p: base.p, back: a.g.back, share, agentFor })
  const g2 = buildGraph(t.def)
  const m = cloneModel(base)
  Object.assign(m.p, t.edgeP)
  const W = a.window ? Math.max(1, workdays(a)) : 1
  const stepRate = (id) => a.executions.filter((x) => x.activityId === id).length / W
  const touched = new Set()
  for (const c of changes) {
    const x = m.act[c.step]
    if (!x) continue
    const R = m.R[x.resource]
    if (c.type === 'automate') {
      if (R) { R.lambda = Math.max(0, R.lambda - stepRate(c.step)); touched.add(R.key) }
      x.kind = 'agent'; x.work = c.minutes ? c.minutes * 60 : m.agentWork; x.wait = m.agentWait
      if (x.reWork != null) { x.reWork = x.work; x.reWait = x.wait }
      x.resource = `agent:auto-${c.step}`
      m.R[x.resource] = { key: x.resource, kind: 'agent', name: L(`${x.name} 에이전트`, `${x.name} agent`), lambda: stepRate(c.step), mu: null, c: 1, rho: 0 }
    } else if (c.type === 'predraft') {
      const saving = Math.min(Math.max(c.saving ?? 0.5, 0), 0.9)
      if (R && R.mu) { const shareOfR = stepRate(c.step) / (R.lambda || 1); R.mu = R.mu / (1 - saving * Math.min(shareOfR, 1)); touched.add(R.key) }
      x.work *= 1 - saving
      if (x.reWork != null) x.reWork *= 1 - saving
    } else if (c.type === 'skip') {
      const s = share[c.step] ?? c.share ?? 0
      if (R) { R.lambda = Math.max(0, R.lambda - s * stepRate(c.step)); touched.add(R.key) }
    } else if (c.type === 'capacity') {
      if (R) { R.c += c.add ?? 1; touched.add(R.key) }
    } else if (c.type === 'rework') {
      const f = Math.min(Math.max(c.factor ?? 0.5, 0), 1)
      for (const [eid, pv] of Object.entries(m.p)) {
        const e = a.g.edges.find((y) => y.id === eid)
        if (!e || !a.g.back.has(eid) || e.target !== c.step && !loopBody(a.g, e.target, e.source).includes(c.step)) continue
        const k0 = pv / (1 - Math.min(pv, 0.9)), p1 = pv * f, k1 = p1 / (1 - Math.min(p1, 0.9))
        // the fewer the loops, the fewer the second passes the loop's people take
        for (const id of loopBody(a.g, e.target, e.source)) {
          const r = m.R[m.act[id]?.resource]
          if (r) { r.lambda = r.lambda * (1 + k1) / (1 + k0); touched.add(r.key) }
        }
        // the gateway's other edges share what is left
        const sib = a.g.out.get(e.source).filter((y) => y.id !== eid)
        const rest = sib.reduce((s2, y) => s2 + (m.p[y.id] ?? 0), 0) || 1
        for (const y of sib) m.p[y.id] = (m.p[y.id] ?? 0) / rest * (1 - p1)
        m.p[eid] = p1
      }
    }
  }
  // queue waits in front of people whose demand / capacity / headcount changed
  const factor = {}
  for (const key of touched) {
    const r0 = base.R[key], r1 = m.R[key]
    if (!r0?.mu || r0.kind !== 'human') continue
    const w0 = erlangWq(r0.lambda, r0.mu, r0.c), w1 = erlangWq(r1.lambda, r1.mu, r1.c)
    factor[key] = w0 > 0 ? w1 / w0 : 1
  }
  // only the 차례 기다림 part scales; waiting for the person's own time slot stays as it was
  for (const x of Object.values(m.act)) {
    const f = factor[x.resource]
    if (f == null || x.kind !== 'human') continue
    const scale = (w) => w * (1 - x.behindShare) + w * x.behindShare * f
    x.wait = scale(x.wait)
    if (x.reWait != null) x.reWait = scale(x.reWait)
  }
  const after = evaluate(g2, m)
  return {
    before: strip(before), after: strip(after), waitFactor: factor,
    changes: changes.map((c) => ({ ...c, text: describeChange(c, a.g.def) })), notes: t.notes, def: t.def, g: g2,
  }
}

const strip = ({ cp, ...r }) => ({ ...r, durations: cp.durations, mainNodes: cp.main?.nodes || {}, scenarios: cp.scenarios.map((s) => ({ prob: s.prob, T: s.T, path: s.path, choice: s.choice })) })

const workdays = (a) => workdaysBetween(a.window.from, a.window.to)
