// 지도에 무엇을 그릴지: 고른 프로세스 · θ 로 거른 일과 관계.
// θ 보다 드문 관계는 빼고(고정한 관계는 남김), 시작 일에서 더는 닿지 않는 일도 뺀다. 은퇴 후보와 은퇴한 관계는
// θ 와 상관없이 그리지만(주황 · 회색 점선) 닿음을 이어 주지는 않는다. θ 는 보기만 바꾼다(실행에 쓰는 θ 는 그대로).
// 한 일이 여러 프로세스에 들어 있을 수 있다(v0.3 HAS_TASK, t.procs). 프로세스를 고르면 그 프로세스의 θ 와
// 그 프로세스 안의 시작 비율(hasTask.entry_share)로, 전체를 보면 일마다 주 프로세스(t.proc)의 θ 로 거른다.
// 사건 보기(eventGraph): 일 사이에 사건(메일 · 결과물 · 채팅)을 넣어 Task→Event(RAISES) · Event→Task(TRIGGERS) 로 그린다.
// 다듬은 흐름(map.refined[proc], Flow): 프로세스를 고르면 기본으로 사람이 정한 흐름을 그린다(flow 'found' 면 찾은 대로).
// 사람이 정한 관계(decided)는 θ 와 상관없이 그리고, 본 관계는 θ 를 그대로 따른다. 전체 지도에는 말로 만든 프로세스(said)의
// 흐름을 더한다 — 다른 다듬은 프로세스는 전체 지도에서 찾은 대로. flowView 는 어느 Flow 든(미리 보기 전 · 후, 채팅 카드) 그림 꼴로.
import { END } from './fmt.js'

const EPS = 1e-9
// mode: 'summary' | 'auto' | 'all' | a number
export function thetaOf(mode, proc) {
  if (typeof mode === 'number') return mode
  if (mode === 'all' || !proc) return 0
  if (mode === 'summary') return Number(proc.summary_theta) || 0
  return Number(proc.theta) || 0
}

export const edgeId = (e) => `${e.from}\u0000${e.to}`
// the processes a task belongs to (v0.3: procs, several; older data: proc) and its main one
export const procsOf = (t) => (Array.isArray(t?.procs) ? t.procs : t?.proc ? [t.proc] : [])
export const mainProc = (t) => t?.proc || procsOf(t)[0] || ''
export const inProc = (t, proc) => !proc || procsOf(t).includes(proc)

// 단순 프로세스: 일이 하나뿐인 흐름(뉴스클리핑 작성 · 연차 사용 확인처럼 한 가지 일이 되풀이되는 것). 프로세스 목록에서는 따로 모으고,
// 전체 지도에서는 뺄 수 있다 — 단순 프로세스에만 속한 일을 빼고(다른 흐름에도 든 일은 남는다), 그 일에 닿는 관계 · 사건도 뺀다.
// a process made by words (said) stays in the chip list whatever its size
export const isSaid = (p) => !!p?.said || String(p?.key || '').startsWith('said:')
export const isSimple = (p) => (p?.kind || 'flow') === 'flow' && (p?.tasks || []).length <= 1 && !isSaid(p)
export function withoutSimple(map) {
  if (!map?.tasks?.length) return map
  const simple = new Set((map.processes || []).filter(isSimple).map((p) => p.key))
  if (!simple.size) return map
  const gone = new Set(map.tasks.filter((t) => { const ps = procsOf(t); return ps.length && ps.every((k) => simple.has(k)) }).map((t) => t.key))
  return {
    ...map,
    tasks: map.tasks.filter((t) => !gone.has(t.key)),
    edges: (map.edges || []).filter((e) => !gone.has(e.from) && !gone.has(e.to)),
    triggers: (map.triggers || []).filter((x) => !gone.has(x.to)),
    raises: (map.raises || []).filter((x) => !gone.has(x.from)),
    processes: (map.processes || []).filter((p) => !simple.has(p.key)),
    hidden: gone.size,
  }
}

export function visibleGraph(map, { proc = '', mode = 'summary', flow = 'refined' } = {}) {
  if (!map?.tasks?.length) return { tasks: [], edges: [], entries: [], procShares: false, refined: false, decided: false }
  if (proc && flow === 'refined' && map.refined?.[proc]) return refinedGraph(map, proc, mode)
  const found = foundGraph(map, proc, mode)
  return !proc && flow === 'refined' ? withSaid(found, map) : found
}

function foundGraph(map, proc, mode) {
  const processes = new Map((map.processes || []).map((b) => [b.key, b]))
  // a task's entry share within the shown process (HAS_TASK), else of all cases
  const own = proc ? new Map((map.hasTask || []).filter((h) => h.from === proc).map((h) => [h.to, h.entry_share || 0])) : new Map()
  const scope = map.tasks.filter((t) => inProc(t, proc)).map((t) => (own.has(t.key) ? { ...t, entry_share: own.get(t.key) } : t))
  const byKey = new Map(scope.map((t) => [t.key, t]))
  const th = proc ? () => thetaOf(mode, processes.get(proc)) : (key) => thetaOf(mode, processes.get(mainProc(byKey.get(key))))
  // an edge as common as θ (or pinned) is drawn and leads on; a retirement candidate or a retired edge is drawn too
  // (whatever its θ — it is what the review is about), but only between tasks the map shows anyway
  const passes = (e) => e.pinned || e.p >= th(e.from) - EPS
  const kept = (map.edges || []).filter((e) => byKey.has(e.from) && (e.to === END || byKey.has(e.to)) && (passes(e) || e.stale || e.status === 'retired'))

  // roots: entries at least as common as θ (pinned tasks too); a proc whose entries all fall under θ keeps its first
  const roots = new Set(scope.filter((t) => t.pinned || ((t.entry_share || 0) > 0 && t.entry_share >= th(t.key) - EPS)).map((t) => t.key))
  const groups = new Map()
  for (const t of scope) if ((t.entry_share || 0) > 0) { const g = proc || mainProc(t); (groups.get(g) || groups.set(g, []).get(g)).push(t) }
  for (const list of groups.values()) if (!list.some((t) => roots.has(t.key))) roots.add(list.sort((a, b) => b.entry_share - a.entry_share)[0].key)

  const out = new Map()
  for (const e of kept) if (passes(e) && e.status !== 'retired' && e.to !== END) (out.get(e.from) || out.set(e.from, []).get(e.from)).push(e.to)
  const seen = new Set(roots), stack = [...roots]
  while (stack.length) for (const n of out.get(stack.pop()) || []) if (!seen.has(n)) { seen.add(n); stack.push(n) }

  const tasks = scope.filter((t) => seen.has(t.key))
  const edges = kept.filter((e) => seen.has(e.from) && (e.to === END || seen.has(e.to)))
  const entries = tasks.filter((t) => roots.has(t.key) && (t.entry_share || 0) > 0).sort((a, b) => b.entry_share - a.entry_share).map((t) => t.key)
  return { tasks, edges, entries, procShares: own.size > 0, refined: false, decided: false }
}

// ---------- 다듬은 흐름 ----------
const push = (m, k, v) => (m.get(k) || m.set(k, []).get(k)).push(v)
const FLAGS = ['added', 'said', 'runner', 'diff', 'change', 'was']
// the map node a Flow task is: its origin (a renamed task keeps its node), else the company's work of that name
const nodeOf = (byKey, ft) => (ft.origin ? byKey.get(ft.origin) || byKey.get(ft.key) : byKey.get(ft.key)) || null
// a Flow task as the map draws it: the node gives counts and marks (n_cases · entry share · candidate · kind), the Flow the shown
// key, role and flags. Decided: a person decided something of it; unseen: decided and never observed (0 cases).
function flowTask(ft, node, { share, proc = '' } = {}) {
  const decided = !!(ft.decided || ft.added || ft.said)
  const n_cases = node ? node.n_cases ?? ft.n ?? 0 : ft.n ?? 0
  const t = {
    ...(node || {}),
    key: ft.key,
    name: node && node.key === ft.key ? node.name || ft.key : ft.key,
    role: ft.role || node?.role || '',
    n_cases,
    origin: ft.origin ?? null,
    entry_share: share ?? node?.entry_share ?? 0,
    procs: [...new Set([...procsOf(node), ...(proc ? [proc] : [])])],
  }
  for (const k of FLAGS) if (ft[k] != null && ft[k] !== false && ft[k] !== '') t[k] = ft[k]
  if (decided) t.decided = true
  if (decided && (ft.unseen != null ? !!ft.unseen : !(n_cases > 0))) t.unseen = true
  return t
}
// a Flow way: an observed one keeps what the map knows of it (stale · thin · people …) under the Flow's share
function flowEdge(fe, base, force = false) {
  const decided = !!(force || fe.decided || fe.added)
  const e = { ...(base || {}), ...fe, n: fe.n ?? 0, p: fe.p ?? 0 }
  if (decided) e.decided = true
  if (decided && (fe.unseen != null ? !!fe.unseen : !(e.n > 0))) e.unseen = true
  return e
}

// the selected process's decided flow: observed ways follow θ as on the found map, decided ways are drawn whatever θ;
// the roots are the Flow's starts, then the observed starts as common as θ (pinned too), then a step a person added
// that nothing leads into
function refinedGraph(map, proc, mode) {
  const F = map.refined[proc]
  const th = thetaOf(mode, (map.processes || []).find((b) => b.key === proc))
  const own = new Map((map.hasTask || []).filter((h) => h.from === proc).map((h) => [h.to, h.entry_share || 0]))
  const byNode = new Map(map.tasks.map((t) => [t.key, t]))
  const all = (F.tasks || []).filter((ft) => ft.diff !== 'remove').map((ft) => {
    const node = nodeOf(byNode, ft)
    const share = !ft.origin ? 0 : own.has(ft.origin) ? own.get(ft.origin) : undefined
    return flowTask(ft, node, { share, proc })
  })
  const byKey = new Map(all.map((t) => [t.key, t]))
  const orig = (k) => (k === END ? END : byKey.get(k)?.origin || k)
  const mapEdge = new Map((map.edges || []).map((e) => [edgeId(e), e]))
  const passes = (e) => e.decided || e.pinned || (e.p || 0) >= th - EPS
  const kept = (F.edges || []).filter((fe) => fe.diff !== 'remove')
    .map((fe) => flowEdge(fe, fe.decided || fe.added ? null : mapEdge.get(`${orig(fe.from)}\u0000${orig(fe.to)}`)))
    .filter((e) => byKey.has(e.from) && (e.to === END || byKey.has(e.to)) && (passes(e) || e.stale || e.status === 'retired'))

  const starts = (F.entries || []).filter((k) => byKey.has(k))
  const roots = new Set(starts)
  for (const t of all) if (t.pinned || ((t.entry_share || 0) > 0 && t.entry_share >= th - EPS)) roots.add(t.key)
  const into = new Set((F.edges || []).filter((e) => e.from !== e.to).map((e) => e.to))
  for (const t of all) if ((t.added || t.said) && !into.has(t.key)) roots.add(t.key)
  if (!roots.size && all.length) {
    const first = all.filter((t) => (t.entry_share || 0) > 0).sort((a, b) => b.entry_share - a.entry_share)[0] || all.find((t) => !into.has(t.key)) || all[0]
    roots.add(first.key)
  }
  const out = new Map()
  for (const e of kept) if (passes(e) && e.status !== 'retired' && e.to !== END) push(out, e.from, e.to)
  const seen = new Set(roots), stack = [...roots]
  while (stack.length) for (const n of out.get(stack.pop()) || []) if (!seen.has(n)) { seen.add(n); stack.push(n) }

  const tasks = all.filter((t) => seen.has(t.key))
  const edges = kept.filter((e) => seen.has(e.from) && (e.to === END || seen.has(e.to)))
  const observed = tasks.filter((t) => roots.has(t.key) && !starts.includes(t.key) && (t.entry_share || 0) > 0).sort((a, b) => b.entry_share - a.entry_share)
  const entries = [...starts.filter((k) => seen.has(k)), ...observed.map((t) => t.key)]
  return { tasks, edges, entries, procShares: own.size > 0, refined: true, decided: tasks.some((t) => t.decided) || edges.some((e) => e.decided) }
}

// the whole map: a process made by words has no cases, so the found map never reaches it — add its steps, its ways (all
// decided) and its starts. A step that is the company's work already on the map stays as it is.
function withSaid(base, map) {
  const said = Object.entries(map.refined || {}).filter(([k, F]) => F && (F.said || String(k).startsWith('said:')))
  if (!said.length) return base
  const byNode = new Map(map.tasks.map((t) => [t.key, t]))
  const tasks = [...base.tasks], edges = [...base.edges], entries = [...base.entries]
  const keys = new Set(tasks.map((t) => t.key)), ids = new Set(edges.map(edgeId))
  for (const [proc, F] of said) {
    for (const ft of F.tasks || []) {
      if (ft.diff === 'remove' || keys.has(ft.key)) continue
      tasks.push(flowTask(ft, nodeOf(byNode, ft), { proc }))
      keys.add(ft.key)
    }
    for (const fe of F.edges || []) {
      if (fe.diff === 'remove' || !keys.has(fe.from) || !(fe.to === END || keys.has(fe.to)) || ids.has(edgeId(fe))) continue
      edges.push(flowEdge(fe, null, true))
      ids.add(edgeId(fe))
    }
    for (const k of F.entries || []) if (keys.has(k) && !entries.includes(k)) entries.push(k)
  }
  return { ...base, tasks, edges, entries, decided: true }
}

// any Flow (a preview's before / after, a chat card) as MapGraph draws it, no θ: removed things stay (diff 'remove') so the
// drawing can strike them. map (optional) gives counts and marks by origin; proc (optional) the start shares within it.
export function flowView(flow, map = null, { proc = '' } = {}) {
  if (!flow?.tasks?.length) return { tasks: [], edges: [], entries: [] }
  const byNode = new Map((map?.tasks || []).map((t) => [t.key, t]))
  const own = new Map((map?.hasTask || []).filter((h) => proc && h.from === proc).map((h) => [h.to, h.entry_share || 0]))
  const tasks = flow.tasks.map((ft) => {
    const node = map ? nodeOf(byNode, ft) : null
    const share = !map || !ft.origin || !proc ? 0 : own.has(ft.origin) ? own.get(ft.origin) : undefined
    return flowTask(ft, node, { share, proc })
  })
  const keys = new Set(tasks.map((t) => t.key))
  const edges = (flow.edges || []).filter((e) => keys.has(e.from) && (e.to === END || keys.has(e.to))).map((fe) => flowEdge(fe, null))
  let entries = (flow.entries || []).filter((k) => keys.has(k))
  if (!entries.length) {
    const ins = new Set(edges.filter((e) => e.from !== e.to && e.diff !== 'remove').map((e) => e.to))
    entries = tasks.filter((t) => !ins.has(t.key) && t.diff !== 'remove').map((t) => t.key)
    if (!entries.length) entries = [tasks[0].key]
  }
  return { tasks, edges, entries }
}

// ---------- 사건 보기 ----------
// event node keys in the drawing (a task and an event could share a name)
export const EV = '\u0002'
export const isEv = (key) => String(key).startsWith(EV)
// 「견적서 작성 결과물(표)」 right after 「견적서 작성」 reads 「결과물(표)」 on the map; the panel shows the whole name
export function eventLabel(e) {
  const m = /^artifact:([^@:][^:]*):/.exec(e.key || '')
  const name = String(e.name || e.key || '')
  return m && name.startsWith(`${m[1]} `) ? name.slice(m[1].length + 1) : name
}

// Tasks are the ones the task view keeps (same θ); a routine process shows all its tasks (it has no NEXT, only events),
// and the whole map adds the routines' tasks. Events are those that open a shown task through a trigger as common as θ
// and are either raised by a shown task (a task's RAISES into it is drawn too) or raised by no task at all (a mail coming
// in, a chat request, a role's result) — a result of a task the view leaves out does not start the view.
// A NEXT between two shown tasks with no event in between (a task that makes no result: 요청 메일 접수 → 현장 실측)
// stays a plain task → task line, and so do the edges to 「끝」.
export function eventGraph(map, { proc = '', mode = 'summary', flow = 'refined' } = {}) {
  const empty = { tasks: [], edges: [], events: [], entries: [] }
  if (!map?.tasks?.length) return empty
  const processes = new Map((map.processes || []).map((b) => [b.key, b]))
  const P = processes.get(proc)
  const routines = new Set((map.processes || []).filter((p) => p.kind === 'routine').map((p) => p.key))
  const routine = P?.kind === 'routine'
  const base = routine ? { tasks: map.tasks.filter((t) => inProc(t, proc)), edges: [] } : visibleGraph(map, { proc, mode, flow })
  // a task renamed in the refined flow: the map's triggers and raises name it by its map key
  const alias = new Map(base.tasks.filter((t) => t.origin && t.origin !== t.key).map((t) => [t.origin, t.key]))
  const triggers = alias.size ? (map.triggers || []).map((t) => (alias.has(t.to) ? { ...t, to: alias.get(t.to) } : t)) : map.triggers || []
  const raises = alias.size ? (map.raises || []).map((r) => (alias.has(r.from) ? { ...r, from: alias.get(r.from) } : r)) : map.raises || []
  const tasks = [...base.tasks]
  if (!proc) for (const t of map.tasks) if (!tasks.some((x) => x.key === t.key) && procsOf(t).some((k) => routines.has(k))) tasks.push(t)
  const shown = new Map(tasks.map((t) => [t.key, t]))
  const th = (task) => (routine ? 0 : thetaOf(mode, proc ? P : processes.get(mainProc(shown.get(task)))))
  const evBy = new Map((map.events || []).map((e) => [e.key, e]))

  const raisedAny = new Set(raises.map((r) => r.to))
  let trig = triggers.filter((t) => shown.has(t.to) && t.status !== 'retired' && (t.pinned || (t.p || 0) >= th(t.to) - EPS))
  const rais = raises.filter((r) => shown.has(r.from) && trig.some((t) => t.from === r.to) && (r.p || 0) >= th(r.from) - EPS)
  const raisedShown = new Set(rais.map((r) => r.to))
  trig = trig.filter((t) => raisedShown.has(t.from) || !raisedAny.has(t.from))
  const covered = new Set()
  for (const r of rais) for (const t of trig) if (t.from === r.to) covered.add(`${r.from}\u0000${t.to}`)
  let next = (base.edges || []).filter((e) => !covered.has(edgeId(e)))
  // 간선 설정(edge-step-condition): with a process picked, a way that no event covers gets its 「앞 단계 완료」 event (the map may not have
  // one yet — a way 다듬기 made, or a map counted before 완료 events), so every way into a task is an event → task edge to set
  if (proc && !routine) {
    const extra = { events: new Map(), rais: [], trig: [] }
    for (const e of next) {
      if (e.to === END) continue
      const from = shown.get(e.from)?.origin || e.from
      const key = `done:${from}`
      if (!evBy.has(key)) extra.events.set(key, { key, kind: 'done', cls: '', name: `${e.from} 완료`, n: 0, virtual: true })
      if (!rais.some((r) => r.from === e.from && r.to === key) && !extra.rais.some((r) => r.from === e.from && r.to === key)) extra.rais.push({ from: e.from, to: key, n: e.n || 0, p: 1, virtual: true })
      extra.trig.push({ from: key, to: e.to, n: e.n || 0, p: e.p || 0, split: '', virtual: !trig.some((t) => t.from === key && t.to === e.to) })
    }
    for (const [k, v] of extra.events) evBy.set(k, v)
    rais.push(...extra.rais)
    for (const r of extra.rais) raisedShown.add(r.to)
    trig = [...trig, ...extra.trig]
    next = next.filter((e) => e.to === END)
  }
  const used = new Set(trig.map((t) => t.from))

  const events = [...used].map((k) => {
    const e = evBy.get(k) || { key: k, kind: 'artifact', name: k, n: 0 }
    const out = trig.filter((t) => t.from === k)
    return { key: EV + k, ev: e, label: eventLabel(e), and: out.some((t) => t.split === 'and') }
  })
  const edges = [
    ...rais.map((r) => ({ ...r, kind: 'raise', event: r.to, from: r.from, to: EV + r.to })),
    ...trig.map((t) => ({ ...t, kind: 'trigger', event: t.from, from: EV + t.from, to: t.to })),
    ...next.map((e) => ({ ...e, kind: 'next' })),
  ]
  // start where the work starts: the events nothing shown raises (the process's start events first, most common first)
  const raised = raisedShown
  const starts = new Map((map.startsOn || []).filter((s) => !proc || s.from === proc).map((s) => [s.to, s.n || 0]))
  const entries = events.filter((e) => !raised.has(e.ev.key))
    .sort((a, b) => (starts.has(b.ev.key) - starts.has(a.ev.key)) || (b.ev.n || 0) - (a.ev.n || 0)).map((e) => e.key)
  return { tasks, edges, events, entries }
}
