// 지도에 무엇을 그릴지: 고른 프로세스 · θ 로 거른 일과 관계.
// θ 보다 드문 관계는 빼고(고정한 관계는 남김), 시작 일에서 더는 닿지 않는 일도 뺀다. 은퇴 후보와 은퇴한 관계는
// θ 와 상관없이 그리지만(주황 · 회색 점선) 닿음을 이어 주지는 않는다. θ 는 보기만 바꾼다(실행에 쓰는 θ 는 그대로).
// 한 일이 여러 프로세스에 들어 있을 수 있다(v0.3 HAS_TASK, t.procs). 프로세스를 고르면 그 프로세스의 θ 와
// 그 프로세스 안의 시작 비율(hasTask.entry_share)로, 전체를 보면 일마다 주 프로세스(t.proc)의 θ 로 거른다.
// 사건 보기(eventGraph): 일 사이에 사건(메일 · 결과물 · 채팅)을 넣어 Task→Event(RAISES) · Event→Task(TRIGGERS) 로 그린다.
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

export function visibleGraph(map, { proc = '', mode = 'summary' } = {}) {
  if (!map?.tasks?.length) return { tasks: [], edges: [], entries: [], procShares: false }
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
  return { tasks, edges, entries, procShares: own.size > 0 }
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
export function eventGraph(map, { proc = '', mode = 'summary' } = {}) {
  const empty = { tasks: [], edges: [], events: [], entries: [] }
  if (!map?.tasks?.length) return empty
  const processes = new Map((map.processes || []).map((b) => [b.key, b]))
  const P = processes.get(proc)
  const routines = new Set((map.processes || []).filter((p) => p.kind === 'routine').map((p) => p.key))
  const routine = P?.kind === 'routine'
  const base = routine ? { tasks: map.tasks.filter((t) => inProc(t, proc)), edges: [] } : visibleGraph(map, { proc, mode })
  const tasks = [...base.tasks]
  if (!proc) for (const t of map.tasks) if (!tasks.some((x) => x.key === t.key) && procsOf(t).some((k) => routines.has(k))) tasks.push(t)
  const shown = new Map(tasks.map((t) => [t.key, t]))
  const th = (task) => (routine ? 0 : thetaOf(mode, proc ? P : processes.get(mainProc(shown.get(task)))))
  const evBy = new Map((map.events || []).map((e) => [e.key, e]))

  const raisedAny = new Set((map.raises || []).map((r) => r.to))
  let trig = (map.triggers || []).filter((t) => shown.has(t.to) && t.status !== 'retired' && (t.pinned || (t.p || 0) >= th(t.to) - EPS))
  const rais = (map.raises || []).filter((r) => shown.has(r.from) && trig.some((t) => t.from === r.to) && (r.p || 0) >= th(r.from) - EPS)
  const raisedShown = new Set(rais.map((r) => r.to))
  trig = trig.filter((t) => raisedShown.has(t.from) || !raisedAny.has(t.from))
  const used = new Set(trig.map((t) => t.from))
  const covered = new Set()
  for (const r of rais) for (const t of trig) if (t.from === r.to) covered.add(`${r.from}\u0000${t.to}`)
  const next = (base.edges || []).filter((e) => !covered.has(edgeId(e)))

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
