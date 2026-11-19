// 흐름 분석(병목 · 회사의 제약 · 흔한 길) — what GET /ontology/flow reads, all from the company's process map (설계
// docs/auto-ax-onboarding/design-improve-on-map.md): the map's tasks and ways (its mining — the ways often taken, θ), the work items its
// cases left (todolist rows of the map engine and of snapshots — activity_id = the task's hash, run.js actId), and the mail · chat
// records the map was counted from (build.js loadEvents — the response time of each task, 추정). The arithmetic is flowtime.js.
// Nothing is written. Who holds an open item and the case's subject are shown to an administrator only (설계 결정 2).
import { config } from '../../config.js'
import { q } from '../supa.js'
import { readGraph } from './store.js'
import { procGraph, parallelPair, unfold } from './run.js'
import { toCases } from './stats.js'
import * as F from './flowtime.js'

const T = () => config.tenantId
const err = (status, message) => Object.assign(new Error(message), { status })

// ---------- the records' times (cached per count of the map — reading them takes ~30 s the first time) ----------
const minedCache = new Map()
async function minedByTask(meta, validAt) {
  const key = `${T()}|${meta?.built_at || ''}|${validAt || ''}`
  const hit = minedCache.get(key)
  // the records the map was counted from change only when the map is counted again (built_at is in the key): kept until then
  if (hit) return hit.v
  const { loadEvents } = await import('./build.js')
  const events = await loadEvents(validAt ? { until: validAt } : {})
  const cases = toCases(events)
  const samples = F.minedSamples(cases)
  const by = new Map()
  for (const s of samples) { if (!by.has(s.task)) by.set(s.task, []); by.get(s.task).push(s) }
  const span = cases.length ? { from: Math.min(...cases.map((c) => c.start)), to: Math.max(...cases.map((c) => c.steps.at(-1).end)) } : null
  const v = { by, cases: cases.length, span }
  minedCache.set(key, { at: Date.now(), v })
  if (minedCache.size > 20) minedCache.delete(minedCache.keys().next().value)
  return v
}

// ---------- the work items the map's cases left ----------
// every step of a map case and of a snapshot case (the snapshot's own 요청 접수 is not a task of the map), with its case's process
export async function runRows({ validAt } = {}) {
  const rows = await q(`select c.id::text as case_id, c.bundle as proc, c.status as case_status, c.engine, c.trigger->>'subject' as subject,
                               t.id::text as id, t.activity_id, t.activity_name as task, t.status::text as status, t.user_id, t.username,
                               extract(epoch from (t.start_date at time zone 'Asia/Seoul')) * 1000 as start_ms,
                               extract(epoch from (t.end_date at time zone 'Asia/Seoul')) * 1000 as end_ms,
                               s.kind, s.state as gate, t.agent_mode::text as agent_mode
                          from pro_po_cases c
                          join todolist t on t.proc_inst_id = any(c.instances) and t.tenant_id = c.tenant_id
                          left join pro_case_steps s on s.todo_id = t.id
                         where c.tenant_id=$1 and coalesce(t.activity_id, '') <> 'intake' and ($2::timestamptz is null or c.created_at <= $2)`, [T(), validAt || null])
  const at = validAt ? new Date(validAt).getTime() : null
  return rows.map((r) => {
    const start = r.start_ms == null ? NaN : Number(r.start_ms), end = r.end_ms == null ? NaN : Number(r.end_ms)
    let status = r.status
    // a past day: the item as it stood then (made by then; ended after then → still open)
    if (at != null) {
      if (Number.isFinite(start) && start > at) return null
      if (F.ENDED.includes(status) && Number.isFinite(end) && end > at) status = 'IN_PROGRESS'
    }
    const agent = r.kind === 'agent' || String(r.agent_mode || '').toUpperCase() === 'COMPLETE'
    return { id: r.id, caseId: r.case_id, proc: r.proc, caseStatus: r.case_status, engine: r.engine, subject: r.subject || '', task: r.task, status, start, end,
      agent, draft: r.kind === 'draft', userId: r.user_id, who: r.username || '', gate: r.gate || null }
  }).filter(Boolean)
}

// headcount per role: the people the company put in it (Settings › 팀 · 역할, role members)
async function headcount() {
  const rows = await q(`select x.role, count(distinct x.user_id)::int as n from (
                          select user_id, role from pro_role_assignments where tenant_id=$1 and proc_def_id='*'
                          union select user_id, role from pro_role_members where tenant_id=$1) x
                          join users u on u.id = x.user_id and u.tenant_id = $1 and not coalesce(u.is_agent,false)
                        group by x.role`, [T()]).catch(() => [])
  return new Map(rows.map((r) => [r.role, r.n]))
}

async function candidates() {
  const rows = await q(`select task, fit, how, status from pro_ai_candidates where tenant_id=$1`, [T()]).catch(() => [])
  return new Map(rows.map((r) => [r.task, { fit: r.fit, how: r.how, status: r.status }]))
}
async function classesOf(procKey) {
  if (!procKey) return {}
  const [r] = await q(`select classes from pro_refine_reviews where tenant_id=$1 and proc_key=$2`, [T(), procKey]).catch(() => [])
  return r?.classes || {}
}
async function optionalSteps(procKey) {
  if (!procKey) return new Set()
  const m = await (await import('./steprule.js')).requirementMarks(procKey).catch(() => ({ steps: [] }))
  return new Set((m.steps || []).filter((s) => s.mark === 'opt').map((s) => s.task))
}

const heatOf = (wip, max) => (!wip || !max ? 0 : Math.max(1, Math.ceil((3 * wip) / max)))

// GET /ontology/flow?proc=&at= — one process (its tasks as a case runs them: refined), or the whole company (proc empty)
export async function flowView(me, { proc = '', validAt } = {}) {
  const g = await readGraph({ validAt })
  if (!g.tasks.length) throw err(404, '아직 그린 지도가 없어요.')
  const { isAdmin } = await import('./service.js')
  const admin = me ? await isAdmin(me).catch(() => false) : false
  const view = proc ? await procGraph(proc, { validAt }) : null
  const roleOf = new Map(g.roles.map((r) => [r.key, r]))
  const heads = await headcount()
  const outsideRole = (role) => !!roleOf.get(role)?.outside
  const agentRole = (role) => role === '에이전트' || /에이전트|agent/i.test(String(role || ''))
  // the tasks in view: a process's (refined — what a case runs), or every task on the map
  const tasks = view ? [...view.tasks.values()] : g.tasks
  const keys = new Set(tasks.map((t) => t.key))
  const edges = view ? view.edges : g.edges

  const now = validAt ? new Date(validAt).getTime() : Date.now()
  const rows = await runRows({ validAt })
  const mine = view ? rows.filter((r) => r.proc === view.proc.key) : rows
  const L = F.loadOf(mine, { now })
  const company = F.loadOf(rows, { now })
  const mined = await minedByTask(g.meta, validAt)
  const runBy = new Map()
  for (const s of F.runSamples(mine.filter((r) => !r.agent))) { if (!runBy.has(s.task)) runBy.set(s.task, []); runBy.get(s.task).push(s) }
  const agentBy = new Map()
  for (const s of F.runSamples(mine.filter((r) => r.agent))) { if (!agentBy.has(s.task)) agentBy.set(s.task, []); agentBy.get(s.task).push(s) }
  // an agent's step is timed by its own runs (minutes, no queue); our people's by theirs, else by the records
  const times = new Map(tasks.map((t) => [t.key, F.taskTime(mined.by.get(t.key) || [], runBy.get(t.key)?.length ? runBy.get(t.key) : agentBy.get(t.key) || [])]))
  const usual = new Map(tasks.map((t) => [t.key, F.minedBacklog(mined.by.get(t.key) || [], mined.span || {})]))
  const cands = await candidates()
  const classes = await classesOf(view?.proc.key)
  const optional = await optionalSteps(view?.proc.key)

  // a task's kind of step: an outside role's (waiting outside), an agent's (by its definition or its run records), or our people's
  const isAgentTask = (t) => t.runner === 'agent' || agentRole(t.role) || ((L.by.get(t.key)?.rows || 0) > 0 && (L.by.get(t.key).agentRows / L.by.get(t.key).rows) > 0.5)
  const facts = tasks.map((t) => ({ key: t.key, role: t.role || '', outside: outsideRole(t.role), agent: isAgentTask(t) }))
  const bott = F.bottleneckOf(facts, L.by, times, usual)

  // the usual way (a process only): from its main start, the most probable way to the end over the ways a case would take (θ)
  let path = null, visits = null, lead = null
  if (view) {
    const th = view.proc.theta ?? 0.05
    const entry = view.proc.entries?.find((k) => keys.has(k)) || tasks[0]?.key
    const { flows } = unfold(view, entry, 0)
    const cp = F.commonPath(edges.filter((e) => e.p >= th || e.pinned || e.decided), entry, { keys: new Set(keys) })
    const pairs = []
    for (const x of cp.path) { const par = parallelPair(view.edges, flows, x); if (par && par.targets.every((k) => cp.path.includes(k))) pairs.push(par.targets) }
    path = { start: entry, p: cp.p, ...F.pathTime(cp.path, times, L.by, { parallel: pairs }), parallel: pairs }
    path.bottOnPath = !!bott.key && cp.path.includes(bott.key)
    // where a case's time goes: expected visits (every way, loops included — θ only hides, it does not change the numbers)
    const starts = {}
    for (const t of tasks) if (t.entry_share > 0 && (view.proc.entries || []).includes(t.key)) starts[t.key] = t.entry_share
    if (!Object.keys(starts).length) starts[entry] = 1
    visits = F.expectedVisits(edges, starts)
    lead = F.timeShares(new Map([...visits].filter(([k]) => keys.has(k))), times)
  }
  // the stretches that take long (records — the mail · chat the map was counted from), on the ways a case of this process takes (θ)
  let ways = []
  if (view) {
    const th = view.proc.theta ?? 0.05
    const shown = new Set(edges.filter((e) => e.to !== F.END && (e.p >= th || e.pinned || e.decided) && e.status !== 'retired').map((e) => `${e.from}\u0000${e.to}`))
    ways = F.wayTimes([...keys].flatMap((k) => mined.by.get(k) || [])).filter((w) => shown.has(`${w.from}\u0000${w.to}`))
      .map((w) => ({ ...w, outside: outsideRole(view.tasks.get(w.to)?.role) || outsideRole(view.tasks.get(w.from)?.role) })).slice(0, 6)
  }

  // the company's constraint: every process's open items, gathered by role
  const taskRole = new Map(g.tasks.map((t) => [t.key, t.role || '']))
  if (view) for (const t of tasks) taskRole.set(t.key, t.role || '')
  const items = []
  const byProcTask = new Map()
  for (const r of rows) {
    const k = `${r.proc}\u0000${r.task}`
    if (!byProcTask.has(k)) byProcTask.set(k, [])
    byProcTask.get(k).push(r)
  }
  for (const [k, list] of byProcTask) {
    const [p, task] = k.split('\u0000')
    const one = F.loadOf(list.filter((r) => !r.agent), { now }).by.get(task)
    if (one) items.push({ task, proc: p, role: taskRole.get(task) || '', wip: one.wip, inPerDay: one.inPerDay, perDay: one.perDay })
  }
  const roleList = g.roles.map((r) => ({ key: r.key, members: heads.get(r.key) || r.members || 0, outside: !!r.outside, agent: agentRole(r.key) }))
  const C = F.constraintOf(roleList, items)
  const procName = new Map(g.processes.map((p) => [p.key, p.name]))
  for (const r of C.roles) r.procs = Object.entries(r.procs).map(([k, n]) => ({ key: k, name: procName.get(k) || k, wip: n })).sort((a, b) => b.wip - a.wip)

  const maxWip = Math.max(0, ...facts.filter((f) => !f.outside).map((f) => L.by.get(f.key)?.wip || 0))
  const out = facts.map((f) => {
    const l = L.by.get(f.key) || { wip: 0, oldestH: 0, clearH: 0, perDay: 0, inPerDay: 0, open: [], growing: false }
    const t = times.get(f.key)
    const ag = agentBy.get(f.key) || []
    const cls = classes[f.key]?.class || null
    return {
      ...f, wip: l.wip, oldestH: l.oldestH, clearH: l.clearH, perDay: l.perDay, inPerDay: l.inPerDay, growing: !!l.growing, usual: usual.get(f.key),
      time: t, heat: f.outside ? 0 : heatOf(l.wip, maxWip), inPath: !!path?.steps.some((s) => s.key === f.key),
      visits: visits ? +(visits.get(f.key) || 0).toFixed(2) : null, share: lead ? lead.shares.get(f.key) || 0 : null,
      cand: cands.get(f.key) || null, cls, optional: optional.has(f.key),
      agentRun: ag.length ? { n: ag.length, medH: F.taskTime([], ag, { min: 1 }).medH } : null,
      open: (l.open || []).slice(0, 4).map((o) => ({ caseId: o.caseId, ageH: +o.ageH.toFixed(1), ...(admin ? { subject: o.subject, who: o.who } : {}) })),
    }
  }).sort((a, b) => b.wip - a.wip || (b.share || 0) - (a.share || 0))

  const b = bott.key ? out.find((x) => x.key === bott.key) : null
  const bRole = b ? C.roles.find((r) => r.role === b.role) || null : null
  const suggestions = F.suggestionsOf({ bott: b, cand: b?.cand, cls: b?.cls, optional: b?.optional, onPath: !!path?.bottOnPath, role: bRole, constraint: C.key })
  const runCases = new Set(mine.map((r) => r.caseId)).size
  return {
    proc: view ? { key: view.proc.key, name: view.proc.name, status: view.proc.status, cases: view.proc.cases, theta: view.proc.theta } : null,
    at: validAt || null, now: new Date(now).toISOString(), admin,
    window: { days: L.days, workDays: L.workDays },
    measured: { runCases, runItems: mine.length, openItems: mine.filter((r) => F.OPEN.includes(r.status)).length, minedCases: mined.cases,
      companyOpen: rows.filter((r) => F.OPEN.includes(r.status)).length, sources: g.meta?.sources || {} },
    tasks: out,
    bottleneck: b ? { key: b.key, by: bott.by, role: b.role, wip: b.wip, oldestH: b.oldestH, clearH: b.clearH, perDay: b.perDay, inPerDay: b.inPerDay, growing: b.growing,
      usual: b.usual, second: bott.second, onPath: !!path?.bottOnPath, share: b.share } : null,
    path, lead: lead ? { leadH: lead.leadH } : null, ways,
    constraint: { key: C.key, roles: C.roles, companyWip: company.by.size ? [...company.by.values()].reduce((s, x) => s + x.wip, 0) : 0 },
    agentSteps: out.filter((x) => x.agent).map((x) => ({ key: x.key, role: x.role, wip: x.wip, run: x.agentRun })),
    outsideSteps: out.filter((x) => x.outside && x.wip).map((x) => ({ key: x.key, role: x.role, wip: x.wip })),
    suggestions,
  }
}
