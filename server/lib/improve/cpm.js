// 크리티컬 패스(CPM) over the BPMN graph. 단계 시간은 기록에서 잰 값(대기 포함, 중앙값 또는 p80).
//  - sequence flow 와 병렬 게이트웨이: 보통의 CPM (합류는 가장 늦은 가지)
//  - 배타 게이트웨이(앞으로 가는 갈래): 관측된 갈래 비율로 시나리오를 나눠 각각 CPM. 기대 리드타임 =
//    Σ 확률 × 시나리오 길이, 대표 경로 = 가장 흔한 시나리오의 크리티컬 패스, 단계마다 '크리티컬 확률'
//    (그 단계가 크리티컬인 시나리오 확률의 합 — 확률적 CPM 의 criticality index)
//  - 되돌아가는 갈래(보완 요청 → 앞 단계, 루프): 기대 반복 횟수 p/(1-p) × 루프 몸통 길이를 그 게이트웨이의
//    '재작업 기대 시간'으로 더한다
// 시간 단위는 초, 인스턴스 시작 = 0.

const MAX_SCENARIOS = 128

export function forwardDecisions(g) {
  return g.topo.filter((id) => { const n = g.nodes.get(id); return n.kind === 'gateway' && n.gw !== 'and' && g.dout.get(id).length > 1 })
}

// edge probabilities: given p (edgeId → share at its gateway), forward edges renormalised (the token
// eventually leaves a loop forward)
function forwardP(g, gwId, p) {
  const edges = g.dout.get(gwId)
  const raw = edges.map((e) => Math.max(p?.[e.id] ?? 1 / edges.length, 0))
  const s = raw.reduce((a, b) => a + b, 0) || 1
  return edges.map((e, i) => ({ e, p: raw[i] / s }))
}

function scenarios(g, p, fixed = {}) {
  const decisions = forwardDecisions(g)
  let list = [{ prob: 1, choice: {} }]
  for (const d of decisions) {
    const opts = fixed[d] ? [{ e: { id: fixed[d] }, p: 1 }] : forwardP(g, d, p)
    const next = []
    for (const s of list) for (const o of opts) if (o.p > 0) next.push({ prob: s.prob * o.p, choice: { ...s.choice, [d]: o.e.id } })
    next.sort((a, b) => b.prob - a.prob)
    list = next.slice(0, MAX_SCENARIOS)
  }
  // merge scenarios that activate the same nodes (a choice at a gateway that is not reached does not matter)
  const merged = new Map()
  for (const s of list) {
    const act = activeSet(g, s.choice)
    const k = [...act.edges].sort().join('|')
    const m = merged.get(k)
    if (m) m.prob += s.prob
    else merged.set(k, { ...s, active: act })
  }
  const out = [...merged.values()]
  const tot = out.reduce((a, s) => a + s.prob, 0) || 1
  for (const s of out) s.prob /= tot
  return out.sort((a, b) => b.prob - a.prob)
}

function activeSet(g, choice) {
  const nodes = new Set(g.starts), edges = new Set()
  for (const id of g.topo) {
    if (!nodes.has(id) && !g.din.get(id).some((e) => edges.has(e.id))) continue
    nodes.add(id)
    const outs = g.dout.get(id)
    if (choice[id]) { for (const e of outs) if (e.id === choice[id]) edges.add(e.id) }
    else for (const e of outs) edges.add(e.id)
  }
  return { nodes, edges }
}

function pass(g, active, d, { fixedEs = {}, fixedEf = {}, notBefore = 0 } = {}) {
  const es = {}, ef = {}
  for (const id of g.topo) {
    if (!active.nodes.has(id)) continue
    const ins = g.din.get(id).filter((e) => active.edges.has(e.id))
    let s = ins.length ? Math.max(...ins.map((e) => ef[e.source] ?? 0)) : 0
    if (fixedEs[id] != null) s = fixedEs[id]
    else if (notBefore && !(id in fixedEf)) s = Math.max(s, notBefore)
    es[id] = s
    ef[id] = fixedEf[id] != null ? Math.max(fixedEf[id], s) : s + (d[id] || 0)
  }
  const T = Math.max(0, ...Object.values(ef))
  const ls = {}, lf = {}
  for (const id of [...g.topo].reverse()) {
    if (!active.nodes.has(id)) continue
    const outs = g.dout.get(id).filter((e) => active.edges.has(e.id))
    lf[id] = outs.length ? Math.min(...outs.map((e) => ls[e.target] ?? T)) : T
    ls[id] = lf[id] - (ef[id] - es[id])
  }
  return { es, ef, ls, lf, T }
}

// longest path from v to u through the DAG (both included), with durations d — a loop body
function longest(g, v, u, d) {
  const best = { [v]: d[v] || 0 }
  for (const id of g.topo) {
    if (best[id] == null) continue
    for (const e of g.dout.get(id)) best[e.target] = Math.max(best[e.target] ?? -Infinity, best[id] + (d[e.target] || 0))
  }
  return best[u] ?? 0
}

/**
 * model = { dur: {activityId: sec}, reDur?: {activityId: sec} (a re-run after 보완), p: {edgeId: share} }
 * options: fixed {gatewayId: edgeId} (decided in a running instance), fixedEs/fixedEf, notBefore (now)
 */
export function criticalPath(g, model, options = {}) {
  const base = { ...model.dur }
  // loops: expected extra passes × body length, on the gateway that sends work back
  const loops = []
  for (const e of g.edges) {
    if (!g.back.has(e.id)) continue
    const shareRaw = model.p?.[e.id]
    if (!shareRaw) continue
    const share = Math.min(shareRaw, 0.9)
    const k = share / (1 - share)
    const body = longest(g, e.target, e.source, model.reDur || model.dur)
    loops.push({ edge: e.id, from: e.source, to: e.target, share, passes: k, body, extra: k * body })
    base[e.source] = (base[e.source] || 0) + k * body
  }
  const list = scenarios(g, model.p, options.fixed)
  const eps = (T) => Math.max(1, T * 1e-6)
  const sc = list.map((s) => {
    const r = pass(g, s.active, base, options)
    const nodes = {}
    for (const id of s.active.nodes) {
      const slack = r.ls[id] - r.es[id]
      nodes[id] = { es: r.es[id], ef: r.ef[id], ls: r.ls[id], lf: r.lf[id], slack, d: r.ef[id] - r.es[id], critical: slack <= eps(r.T) }
    }
    const path = g.topo.filter((id) => nodes[id]?.critical && g.nodes.get(id).kind === 'activity')
    return { prob: s.prob, choice: s.choice, T: r.T, nodes, path }
  })
  const expectedT = sc.reduce((a, s) => a + s.prob * s.T, 0)
  const criticality = {}, activeP = {}
  for (const s of sc) for (const [id, n] of Object.entries(s.nodes)) {
    activeP[id] = (activeP[id] || 0) + s.prob
    if (n.critical) criticality[id] = (criticality[id] || 0) + s.prob
  }
  return { expectedT, main: sc[0], scenarios: sc, criticality, activeP, loops, durations: base }
}

/**
 * remaining critical path of a running instance: finished steps keep their real times, a step under way
 * gets what is left of its usual time, the rest follow the model; gateways already passed keep their branch.
 */
export function remainingPath(g, model, prof, { d80 = {} } = {}) {
  const t0 = prof.start
  const now = (prof.now ?? Date.now())
  const nowRel = (now - t0) / 1000
  const fixedEs = {}, fixedEf = {}, state = {}
  const byAct = new Map()
  for (const x of prof.steps) (byAct.get(x.activityId) || byAct.set(x.activityId, []).get(x.activityId)).push(x)
  for (const [id, xs] of byAct) {
    const last = xs[xs.length - 1]
    if (last.done) { fixedEs[id] = (xs[0].ready - t0) / 1000; fixedEf[id] = (last.finish - t0) / 1000; state[id] = 'done' }
    else {
      const elapsed = (now - last.ready) / 1000
      const d = model.dur[id] || 0
      const left = elapsed < d ? d - elapsed : Math.max((d80[id] || d) - elapsed, 0.25 * d)
      fixedEs[id] = (last.ready - t0) / 1000
      fixedEf[id] = nowRel + left
      state[id] = 'active'
    }
  }
  // branches taken so far
  const fixed = {}
  for (const gw of forwardDecisions(g)) {
    for (const e of g.dout.get(gw)) {
      const reach = reachActs(g, e.target)
      if ([...reach].some((a) => byAct.has(a))) { fixed[gw] = e.id; break }
    }
  }
  const r = criticalPath(g, { ...model }, { fixed, fixedEs, fixedEf, notBefore: nowRel })
  const main = r.main
  const path = main.path.filter((id) => state[id] !== 'done')
  return {
    elapsedSec: Math.round(nowRel), totalSec: Math.round(main.T), remainingSec: Math.max(0, Math.round(main.T - nowRel)),
    expectedEnd: t0 + main.T * 1000, path, state, nodes: main.nodes, fixed,
  }
}

function reachActs(g, start) {
  const out = new Set(), seen = new Set()
  const walk = (id) => {
    if (seen.has(id)) return
    seen.add(id)
    const n = g.nodes.get(id)
    if (n.kind === 'activity') { out.add(id); return }
    for (const e of g.dout.get(id)) walk(e.target)
  }
  walk(start)
  return out
}
