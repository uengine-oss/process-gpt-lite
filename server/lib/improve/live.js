// 실행 중 TOC (pgpt-pro/docs/agentic-bpm/plan.md §5 P2) — the improvement analysis (service.js, cpm.js) is after the
// fact and per definition; this is the same model used while work is in flight. For every open human work item of
// the given processes: the remaining critical path of its instance from now (CPM over the definition with the
// recorded step times, the branches already taken kept, the ones ahead predicted from the instance's facts when the
// caller can), how long it has waited, and its slack against the process's lead-time target. Least slack first:
// an item with no slack is on the critical path — delaying it delays its instance past the target — so it goes
// first, whoever asked first. Deterministic: no model call.
import { q } from '../supa.js'
import { config } from '../../config.js'
import { load } from './service.js'
import { resources } from './toc.js'
import { buildModel, whatIf } from './whatif.js'
import { remainingPath } from './cpm.js'
import { instanceProfile, percentile } from './analyze.js'
import { L } from '../lang.js'

const T = () => config.tenantId
const TTL_MS = 5000
const cache = new Map() // tenant|defId -> {at, m}

/** the live model of one process: its analysis with step times (median, p80), branch shares and lead-time target */
export async function liveModel(defId, { fresh = false } = {}) {
  const key = `${T()}|${String(defId).toLowerCase()}`
  const hit = cache.get(key)
  if (!fresh && hit && Date.now() - hit.at < TTL_MS) return hit.m
  const { d, a } = await load(defId)
  const res = resources(a)
  const med = buildModel(a, res, { basis: 'median' })
  const p80 = buildModel(a, res, { basis: 'p80' })
  const total = (m) => Object.fromEntries(Object.entries(m.act).map(([k, x]) => [k, x.wait + x.work]))
  const leads = a.instances.filter((i) => i.status === 'COMPLETED' && i.leadSec).map((i) => i.leadSec)
  const m = {
    defId: d.id, defName: d.name, a, res, dur: total(med), d80: total(p80), p: med.p,
    // the target: the lead time half of the finished instances made (the caller may set its own)
    targetSec: percentile(leads, 0.5), completed: leads.length,
    names: Object.fromEntries(a.g.activities.map((id) => [id, a.g.nodes.get(id).name])),
  }
  cache.set(key, { at: Date.now(), m })
  return m
}

// the instance's form values so far (every step's output, flattened): what a branch prediction reads
export const valuesOf = (m, instId) => Object.assign({}, ...m.a.executions.filter((x) => x.instId === instId).sort((p, r) => p.ready - r.ready).map((x) => x.values || {}))

/**
 * the remaining critical path of one instance. p: edge shares for this instance (predicted branches win over the
 * recorded ones); decideNow: an activity under way taken as finished now (the what-if of an approver deciding now).
 */
export function remainingOf(m, instId, { p = null, now = Date.now(), decideNow = null } = {}) {
  const prof = instanceProfile(m.a, instId)
  if (!prof) return null
  const steps = decideNow ? prof.steps.map((s) => (s.activityId === decideNow && !s.done ? { ...s, done: true, finish: now } : s)) : prof.steps
  const rp = remainingPath(m.a.g, { dur: m.dur, p: { ...m.p, ...(p || {}) } }, { ...prof, steps, now }, { d80: m.d80 })
  return { ...rp, prof, pathNames: rp.path.map((id) => m.names[id] || id) }
}

/** the what-if of a model change (whatif.js) on this process: lead time before → after, e.g. a 사전 초안 */
export function predicted(m, changes) {
  const r = whatIf(m.a, m.res, changes)
  return { beforeSec: r.before.leadSec, afterSec: r.after.leadSec, changes: r.changes.map((c) => c.text), notes: r.notes }
}

const H = 3600, D = 86400
// 3.2일 · 5시간 · 12분
export function span(sec) {
  const s = Math.max(0, Math.abs(sec || 0))
  if (s >= D) return L(`${(s / D).toFixed(1)}일`, `${(s / D).toFixed(1)} d`)
  if (s >= H) return L(`${Math.round(s / H)}시간`, `${Math.round(s / H)} h`)
  return L(`${Math.max(1, Math.round(s / 60))}분`, `${Math.max(1, Math.round(s / 60))} min`)
}
function waited(sec) {
  if (sec < 600) return L('방금 도착', 'just arrived')
  if (sec >= D) return L(`${Math.floor(sec / D) + 1}일째 대기`, `waiting since ${Math.floor(sec / D)} d`)
  return L(`${span(sec)}째 대기`, `waiting ${span(sec)}`)
}
export function reasonOf(x) {
  const head = x.critical ? L('주공정 위', 'On the critical path') : L(`여유 ${span(x.slackSec)}`, `${span(x.slackSec)} of slack`)
  return `${head} · ${L(`남은 리드타임 ${span(x.remainingSec)}`, `${span(x.remainingSec)} lead time left`)} · ${waited(x.waitedSec)}`
}

/**
 * open human work items of the processes, least slack first.
 * predict(values, m, instId) → {edgeId: share} for the branches ahead (optional, per process: {defId: fn}).
 */
export async function liveQueue(defIds, { now = Date.now(), predict = {}, targetSec = {} } = {}) {
  const items = []
  for (const defId of [...new Set(defIds.map((x) => String(x).toLowerCase()))]) {
    let m
    try { m = await liveModel(defId) } catch (e) { if (e.status === 404) continue; throw e }
    const target = targetSec[defId] ?? m.targetSec
    for (const inst of m.a.instances.filter((i) => i.status !== 'COMPLETED' && i.open.length)) {
      const p = predict[defId]?.(valuesOf(m, inst.id), m, inst.id) || null
      const rp = remainingOf(m, inst.id, { p, now })
      if (!rp) continue
      for (const s of rp.prof.steps.filter((x) => !x.done && x.human)) {
        const node = rp.nodes[s.activityId]
        const stepSlack = node ? Math.max(0, node.slack) : 0
        const remainingSec = rp.remainingSec
        const projectedSec = rp.elapsedSec + remainingSec
        const slackSec = target != null ? Math.round(target - projectedSec + stepSlack) : Math.round(stepSlack)
        const x = m.a.executions.find((e) => e.todoId === s.todoId)
        const item = {
          todoId: s.todoId, instId: inst.id, instName: inst.name, defId: m.defId, defName: m.defName, activityId: s.activityId, activityName: s.name,
          userId: x?.who || null, readyAt: s.ready, waitedSec: Math.round((now - s.ready) / 1000), elapsedSec: rp.elapsedSec,
          remainingSec, projectedSec, targetSec: target != null ? Math.round(target) : null, slackSec, stepSlackSec: Math.round(stepSlack),
          onPath: rp.path.includes(s.activityId), path: rp.path, pathNames: rp.pathNames, predicted: !!p,
        }
        item.critical = item.onPath && slackSec <= 0
        item.reason = reasonOf(item)
        items.push(item)
      }
    }
  }
  // slack in ten-minute steps (seconds apart is noise), then the one waiting longer
  const step = (x) => Math.floor(x.slackSec / 600)
  items.sort((p, r) => step(p) - step(r) || r.waitedSec - p.waitedSec)
  items.forEach((x, i) => { x.rank = i + 1 })
  return items
}

// a form that decides (a radio or select offering 승인/Approve): the step is an approval
export const isApprovalForm = (fields) => (fields || []).some((f) => /radio|select/.test(f.type || '') && JSON.stringify(f.items || f.options || []).match(/승인|approve/i))

/** the processes in which this person has open approval work items (the inbox looks at these): {defs, acts: Set('def|activity')} */
export async function approvalProcessesOf(me, always = []) {
  const rows = await q(`select distinct t.proc_def_id as def, t.activity_id as act, f.fields_json as fields
    from todolist t join bpm_proc_inst i on i.proc_inst_id=t.proc_inst_id
    left join form_def f on f.proc_def_id=t.proc_def_id and f.activity_id=t.activity_id and f.tenant_id=t.tenant_id
    where t.tenant_id=$1 and coalesce(t.agent_orch,'')='' and i.status::text <> 'COMPLETED'
      and (t.status::text='IN_PROGRESS' or (t.status::text in ('TODO','NEW') and t.activity_id = any(i.current_activity_ids)))
      and (t.user_id like '%'||$2||'%' or t.user_id like '%'||$3||'%')`, [T(), String(me.id), me.email || '(none)'])
  const hits = rows.filter((r) => isApprovalForm(r.fields))
  return { defs: [...new Set([...always, ...hits.map((r) => String(r.def).toLowerCase())])], acts: new Set(hits.map((r) => `${String(r.def).toLowerCase()}|${r.act}`)) }
}
