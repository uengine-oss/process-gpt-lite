// 지도에 무엇을 그릴지: 고른 묶음 · θ 로 거른 일과 관계.
// θ 보다 드문 관계는 빼고(고정한 관계는 남김), 시작 일에서 더는 닿지 않는 일도 뺀다. 은퇴한 관계는 θ 를 넘으면
// 그리지만(회색 점선) 닿음을 이어 주지는 않는다. θ 는 보기만 바꾼다(실행에 쓰는 θ 는 그대로).
import { END } from './fmt.js'

const EPS = 1e-9
// mode: 'summary' | 'auto' | 'all' | a number
export function thetaOf(mode, bundle) {
  if (typeof mode === 'number') return mode
  if (mode === 'all' || !bundle) return 0
  if (mode === 'summary') return Number(bundle.summary_theta) || 0
  return Number(bundle.theta) || 0
}

export const edgeId = (e) => `${e.from}\u0000${e.to}`

export function visibleGraph(map, { bundle = '', mode = 'summary' } = {}) {
  if (!map?.tasks?.length) return { tasks: [], edges: [], entries: [] }
  const bundles = new Map((map.bundles || []).map((b) => [b.key, b]))
  const scope = map.tasks.filter((t) => !bundle || t.bundle === bundle)
  const byKey = new Map(scope.map((t) => [t.key, t]))
  const th = (key) => thetaOf(mode, bundles.get(byKey.get(key)?.bundle))
  const kept = (map.edges || []).filter((e) => byKey.has(e.from) && (e.to === END || byKey.has(e.to)) && (e.pinned || e.p >= th(e.from) - EPS))

  // roots: entries at least as common as θ (pinned tasks too); a bundle whose entries all fall under θ keeps its first
  const roots = new Set(scope.filter((t) => t.pinned || ((t.entry_share || 0) > 0 && t.entry_share >= th(t.key) - EPS)).map((t) => t.key))
  const groups = new Map()
  for (const t of scope) if ((t.entry_share || 0) > 0) (groups.get(t.bundle) || groups.set(t.bundle, []).get(t.bundle)).push(t)
  for (const list of groups.values()) if (!list.some((t) => roots.has(t.key))) roots.add(list.sort((a, b) => b.entry_share - a.entry_share)[0].key)

  const out = new Map()
  for (const e of kept) if (e.status !== 'retired' && e.to !== END) (out.get(e.from) || out.set(e.from, []).get(e.from)).push(e.to)
  const seen = new Set(roots), stack = [...roots]
  while (stack.length) for (const n of out.get(stack.pop()) || []) if (!seen.has(n)) { seen.add(n); stack.push(n) }

  const tasks = scope.filter((t) => seen.has(t.key))
  const edges = kept.filter((e) => seen.has(e.from) && (e.to === END || seen.has(e.to)))
  const entries = tasks.filter((t) => roots.has(t.key) && (t.entry_share || 0) > 0).sort((a, b) => b.entry_share - a.entry_share).map((t) => t.key)
  return { tasks, edges, entries }
}
