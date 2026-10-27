// A process-gpt definition (proc_def.definition, flattened: activities / gateways / events / sequences)
// as a graph for the improvement analysis: node kinds, the loops (back edges found by a DFS from the
// start), a DAG without them, and the nearest activities before each node.

const GW = { parallelGateway: 'and', exclusiveGateway: 'xor', inclusiveGateway: 'or', eventBasedGateway: 'xor', complexGateway: 'and' }

export const isHumanActivity = (a) => (a.type === 'userTask' || !a.type) && (!a.agentMode || a.agentMode === 'none') && !a.orchestration
export const isDraftActivity = (a) => String(a.agentMode || '').toLowerCase() === 'draft'

export function buildGraph(def) {
  const nodes = new Map()
  for (const a of def.activities || []) {
    const human = isHumanActivity(a) || isDraftActivity(a)
    nodes.set(a.id, { id: a.id, name: a.name || a.id, kind: 'activity', human, agent: !human, draft: isDraftActivity(a), role: a.role || '', raw: a })
  }
  for (const g of def.gateways || []) nodes.set(g.id, { id: g.id, name: g.name || '', kind: 'gateway', gw: GW[g.type] || 'xor', raw: g })
  for (const e of def.events || []) nodes.set(e.id, { id: e.id, name: e.name || '', kind: e.type === 'startEvent' ? 'start' : e.type === 'endEvent' ? 'end' : 'event', raw: e })
  const edges = (def.sequences || []).filter((s) => nodes.has(s.source) && nodes.has(s.target))
    .map((s, i) => ({ id: s.id || `seq_${i}`, source: s.source, target: s.target, condition: s.condition || s.name || '', raw: s }))
  const out = new Map([...nodes.keys()].map((k) => [k, []]))
  const inc = new Map([...nodes.keys()].map((k) => [k, []]))
  for (const e of edges) { out.get(e.source).push(e); inc.get(e.target).push(e) }
  const starts = [...nodes.values()].filter((n) => n.kind === 'start').map((n) => n.id)
  if (!starts.length) for (const n of nodes.values()) if (!inc.get(n.id).length) starts.push(n.id)

  // back edges: an edge to a node still on the DFS stack closes a loop (rework)
  const back = new Set()
  const state = new Map()
  const dfs = (id) => {
    state.set(id, 1)
    for (const e of out.get(id)) {
      const s = state.get(e.target)
      if (s === 1) back.add(e.id)
      else if (!s) dfs(e.target)
    }
    state.set(id, 2)
  }
  for (const s of starts) if (!state.get(s)) dfs(s)
  for (const n of nodes.keys()) if (!state.get(n)) dfs(n)

  const fwd = edges.filter((e) => !back.has(e.id))
  const dout = new Map([...nodes.keys()].map((k) => [k, []]))
  const din = new Map([...nodes.keys()].map((k) => [k, []]))
  for (const e of fwd) { dout.get(e.source).push(e); din.get(e.target).push(e) }
  // topological order (Kahn) over the DAG
  const deg = new Map([...nodes.keys()].map((k) => [k, din.get(k).length]))
  const queue = [...nodes.keys()].filter((k) => !deg.get(k)).sort((a, b) => (starts.includes(b) ? 1 : 0) - (starts.includes(a) ? 1 : 0))
  const topo = []
  while (queue.length) {
    const id = queue.shift()
    topo.push(id)
    for (const e of dout.get(id)) { deg.set(e.target, deg.get(e.target) - 1); if (!deg.get(e.target)) queue.push(e.target) }
  }
  const rank = new Map()
  for (const id of topo) rank.set(id, Math.max(0, ...din.get(id).map((e) => (rank.get(e.source) ?? 0) + 1)))
  const g = { def, nodes, edges, out, inc, back, dout, din, topo, rank, starts }
  g.activities = topo.filter((id) => nodes.get(id).kind === 'activity')
  return g
}

// the activities met first walking back from node id (through gateways and events); withLoops also
// follows back edges (a re-run of a step after 보완 요청 is reached from the review)
export function upstreamActivities(g, id, { withLoops = true } = {}) {
  const found = new Set(), seen = new Set()
  const walk = (nid) => {
    for (const e of g.inc.get(nid) || []) {
      if (!withLoops && g.back.has(e.id)) continue
      if (seen.has(e.source)) continue
      seen.add(e.source)
      if (g.nodes.get(e.source).kind === 'activity') found.add(e.source)
      else walk(e.source)
    }
  }
  walk(id)
  return [...found]
}

// the activities (or 'END') an edge leads to first
export function firstActivities(g, edge) {
  const found = new Set(), seen = new Set()
  const walk = (nid) => {
    if (seen.has(nid)) return
    seen.add(nid)
    const n = g.nodes.get(nid)
    if (n.kind === 'activity') return found.add(nid)
    if (n.kind === 'end') return found.add('END')
    for (const e of g.out.get(nid) || []) walk(e.target)
  }
  walk(edge.target)
  return found
}

// exclusive splits: gateways (xor/or) with two or more outgoing edges
export const decisionGateways = (g) => [...g.nodes.values()].filter((n) => n.kind === 'gateway' && n.gw !== 'and' && g.out.get(n.id).length > 1)

// the gateway (if any) that decides after an activity: the first xor split reached from it
export function decisionAfter(g, actId) {
  const seen = new Set()
  const walk = (nid) => {
    for (const e of g.out.get(nid) || []) {
      const t = g.nodes.get(e.target)
      if (seen.has(t.id)) continue
      seen.add(t.id)
      if (t.kind === 'gateway' && t.gw !== 'and' && g.out.get(t.id).length > 1) return t.id
      if (t.kind === 'gateway' || t.kind === 'event') { const r = walk(t.id); if (r) return r }
    }
    return null
  }
  return walk(actId)
}

// every activity before node id in the DAG (no loops)
export function ancestorActivities(g, id) {
  const seen = new Set(), out = []
  const walk = (nid) => {
    for (const e of g.din.get(nid) || []) {
      if (seen.has(e.source)) continue
      seen.add(e.source)
      if (g.nodes.get(e.source).kind === 'activity') out.push(e.source)
      walk(e.source)
    }
  }
  walk(id)
  return out
}
