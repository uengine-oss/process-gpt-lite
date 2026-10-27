// 프로세스 개선 — DB 에서 정의·인스턴스·작업 항목·상태 전이 이력·이벤트를 읽어 결정적 분석을 돌린다.
// (process-gpt analytic 서비스의 ETL/dw 를 거치지 않고 같은 원천 테이블을 바로 읽는다 — design.md)
import { q } from '../supa.js'
import { config } from '../../config.js'
import { emit } from '../bus.js'
import { analyze, valueStream, instanceProfile, percentile } from './analyze.js'
import { resources, constraintOf } from './toc.js'
import { focusingSteps, skipShare, pickThreshold, dur } from './focus.js'
import { buildModel, evaluate, whatIf } from './whatif.js'
import { remainingPath } from './cpm.js'
import { CHANGE_TYPES } from './transform.js'

const T = () => config.tenantId
export const err = (status, message) => Object.assign(new Error(message), { status })

export async function isAdmin(me) {
  const [u] = await q('select is_admin from users where id::text=$1 and tenant_id=$2', [String(me.id), T()])
  return !!u?.is_admin
}

async function defRow(defId) {
  const [d] = await q(`select id, name, owner, definition, description from proc_def where lower(id)=lower($1) and tenant_id=$2 and not coalesce(isdeleted,false)`, [defId, T()])
  return d || null
}

// who may look: an admin, the owner, or anyone who held a work item of this process; apply: admin or owner
export async function access(me, defId) {
  const d = await defRow(defId)
  if (!d) throw err(404, '프로세스를 찾지 못했어요.')
  const admin = await isAdmin(me)
  const owner = d.owner && String(d.owner) === String(me.id)
  let member = admin || owner
  if (!member) {
    const [hit] = await q(`select 1 from todolist t where lower(t.proc_def_id)=lower($1) and t.tenant_id=$2 and (t.user_id like '%'||$3||'%' or t.user_id like '%'||$4||'%') limit 1`, [defId, T(), String(me.id), me.email || '(none)'])
    member = !!hit
  }
  if (!member) throw err(403, '이 프로세스에 참여한 사람과 관리자만 개선 분석을 볼 수 있어요.')
  return { def: d, admin, owner, canApply: admin || owner }
}

// A run belongs to the version in force when it started (its first status change). The completion
// engine now stamps proc_def_version once at start and keeps it (feat/pin-instance-version), but
// instances saved by older engines carry the latest version instead — the start time decides.
async function instancesWithVersion(defId) {
  const vs = await q(`select version, arcv_id, ("timeStamp" at time zone 'UTC') as at from proc_def_version
                      where lower(proc_def_id)=lower($1) and tenant_id=$2 and not coalesce(is_draft,false) order by "timeStamp" asc nulls first`, [defId, T()])
  const insts = await q(`select i.proc_inst_id as id, i.proc_inst_name as name, i.status::text as status, i.proc_def_version as arcv, i.current_activity_ids as current,
                                coalesce((select min(h.changed_at) from todolist_status_history h where h.proc_inst_id=i.proc_inst_id), i.start_date at time zone 'UTC') as started
                         from bpm_proc_inst i where lower(i.proc_def_id)=lower($1) and i.tenant_id=$2 and not coalesce(i.is_deleted,false)`, [defId, T()])
  const at = (v) => (v.at ? new Date(v.at).getTime() : 0) // "timeStamp" is naive UTC (read with at time zone 'UTC')
  for (const i of insts) {
    const t = i.started ? new Date(i.started).getTime() : Date.now()
    let v = vs[0] || null
    for (const x of vs) if (at(x) <= t) v = x
    i.version = v?.version || (i.arcv || '').split('_').pop() || null
  }
  return { vs, insts }
}

export async function versions(defId) {
  const { vs, insts } = await instancesWithVersion(defId)
  const rows = await q(`select version, version_tag, arcv_id, "timeStamp" as at, message, parent_version from proc_def_version
                        where lower(proc_def_id)=lower($1) and tenant_id=$2 and not coalesce(is_draft,false) order by "timeStamp" asc nulls first`, [defId, T()])
  void vs
  return rows.map((r) => ({ ...r, instances: insts.filter((i) => i.version === r.version).length, completed: insts.filter((i) => i.version === r.version && i.status === 'COMPLETED').length }))
}

/** load and analyse; version = a proc_def_version.version (only its instances, its own definition) or 'all' */
export async function load(defId, { version = 'all', now = Date.now() } = {}) {
  const d = await defRow(defId)
  if (!d) throw err(404, '프로세스를 찾지 못했어요.')
  let def = d.definition || {}
  let arcv = null
  if (version && version !== 'all') {
    const [v] = await q(`select arcv_id, definition from proc_def_version where lower(proc_def_id)=lower($1) and tenant_id=$2 and version=$3 order by "timeStamp" desc limit 1`, [defId, T(), String(version)])
    if (!v) throw err(404, `버전 ${version} 을 찾지 못했어요.`)
    arcv = v.arcv_id
    if (v.definition?.activities?.length) def = v.definition
  }
  const all = (await instancesWithVersion(defId)).insts
  const insts = version && version !== 'all' ? all.filter((i) => i.version === String(version)) : all
  const ids = insts.map((i) => i.id)
  const todos = ids.length ? await q(`select id::text as id, proc_inst_id as "instId", activity_id as "activityId", activity_name as "activityName", user_id as "userId",
                                             username, agent_orch as "agentOrch", agent_mode::text as "agentMode", status::text as status, output
                                      from todolist where proc_inst_id = any($1)`, [ids]) : []
  const tids = todos.map((t) => t.id)
  const history = tids.length ? await q(`select todo_id::text as todo_id, from_status::text as from_status, to_status::text as to_status, changed_at, rework_seq, is_estimated
                                         from todolist_status_history where todo_id::text = any($1) order by changed_at`, [tids]) : []
  const events = tids.length ? await q(`select todo_id, event_type::text as event_type, timestamp from events
                                        where todo_id = any($1) and event_type::text in ('task_started','task_completed','human_checked')`, [tids]) : []
  const forms = await q(`select activity_id, fields_json from form_def where lower(proc_def_id)=lower($1) and tenant_id=$2`, [defId, T()])
  const labels = {}
  for (const f of forms) for (const x of f.fields_json || []) if (x.key && x.text) labels[x.key] = String(x.text).replace(/\s*\(.*\)\s*$/, '')
  const a = analyze({ def, instances: insts.map((i) => ({ id: i.id, name: i.name, status: i.status, current: i.current || [], version: i.version })), todos, history, events, now })
  return { d, a, labels, version: version || 'all', arcv }
}

const pickDefaultVersion = (vs) => [...vs].reverse().find((v) => v.completed >= 10)?.version || 'all'

const secs = (x) => (x == null ? null : Math.round(x))
function cpmView(a, res, basis) {
  const m = buildModel(a, res, { basis })
  const e = evaluate(a.g, m)
  const nodes = e.cp.main?.nodes || {}
  const rows = a.g.topo.filter((id) => a.g.nodes.get(id).kind === 'activity' && nodes[id]).map((id) => {
    const n = nodes[id], x = m.act[id]
    return { id, name: a.g.nodes.get(id).name, es: secs(n.es), ef: secs(n.ef), ls: secs(n.ls), lf: secs(n.lf), slack: secs(n.slack), d: secs(n.d),
      wait: secs(x?.wait), work: secs(x?.work), critical: n.critical, criticality: e.criticality[id] || 0, p: e.steps[id]?.p ?? 0, kind: x?.kind }
  })
  // gateways carrying expected rework time show up as their own bar
  for (const l of e.loops) {
    const n = nodes[l.from]
    if (n) rows.push({ id: l.from, name: `보완 재작업 ${Math.round(l.share * 100)}%`, es: secs(n.es), ef: secs(n.ef), ls: secs(n.ls), lf: secs(n.lf), slack: secs(n.slack), d: secs(n.d), wait: 0, work: secs(n.d), critical: n.critical, criticality: e.criticality[l.from] || 0, p: 1, kind: 'loop', loop: true })
  }
  rows.sort((p, r) => p.es - r.es)
  return { basis, expectedSec: e.leadSec, mainSec: e.mainSec, path: e.path, pathProb: e.pathProb, flowEfficiency: e.flowEfficiency, workSec: e.workSec, rows,
    criticalNodes: Object.keys(nodes).filter((id) => nodes[id].critical),
    scenarios: e.cp.scenarios.slice(0, 6).map((s) => ({ prob: s.prob, T: Math.round(s.T), path: s.path })), loops: e.loops, criticalEdges: criticalEdges(a.g, nodes) }
}

// sequence flows between two critical nodes (for drawing the path on the diagram)
function criticalEdges(g, nodes) {
  // as source>target pairs: process-gpt's BPMN generator names the flows itself (SequenceFlow_<source>_<target>)
  return g.edges.filter((e) => !g.back.has(e.id) && nodes[e.source]?.critical && nodes[e.target]?.critical && Math.abs((nodes[e.source].ef) - nodes[e.target].es) < 1).map((e) => `${e.source}>${e.target}`)
}

/** everything the 개선 view shows */
export async function overview(me, defId, { version, basis = 'median' } = {}) {
  const acc = await access(me, defId)
  const vs = await versions(defId)
  const v = version || pickDefaultVersion(vs)
  const { d, a, labels } = await load(defId, { version: v })
  const res = resources(a)
  const constraint = constraintOf(res)
  const focus = focusingSteps(a, { basis, labels })
  const vsm = valueStream(a)
  const cpm = { median: cpmView(a, res, 'median'), p80: cpmView(a, res, 'p80') }
  const model = buildModel(a, res, { basis: 'median' })
  const running = a.instances.filter((i) => i.status !== 'COMPLETED').map((i) => {
    const prof = instanceProfile(a, i.id)
    const d80 = Object.fromEntries(Object.entries(buildModel(a, res, { basis: 'p80' }).act).map(([k, x]) => [k, x.wait + x.work]))
    const rp = remainingPath(a.g, { dur: Object.fromEntries(Object.entries(model.act).map(([k, x]) => [k, x.wait + x.work])), p: model.p }, { ...prof, now: a.now }, { d80 })
    return { id: i.id, name: i.name, start: i.start, elapsedSec: rp.elapsedSec, remainingSec: rp.remainingSec, expectedEnd: rp.expectedEnd, path: rp.path, open: i.open }
  })
  const threshold = constraint ? pickThreshold(a, constraint.stepIds[0]) : null
  const leads = a.instances.filter((i) => i.leadSec).map((i) => i.leadSec)
  checkConstraint(defId, { a, res, d }).catch((e) => console.warn('[improve] notice', e.message))
  return {
    def: { id: d.id, name: d.name, description: d.description || d.definition?.description || '' },
    canApply: acc.canApply, version: v, versions: vs, basis,
    counts: { instances: a.instances.length, completed: a.instances.filter((i) => i.status === 'COMPLETED').length, running: running.length, executions: a.executions.length },
    window: a.window,
    observed: { leadMedian: secs(percentile(leads, 0.5)), leadP80: secs(percentile(leads, 0.8)), leadMean: vsm.leadMean },
    steps: a.steps, branches: a.branches, vsm, toc: { resources: res, constraint, focus: focus.steps, step: focus.step }, cpm, running,
    instances: a.instances.slice().sort((x, y) => y.start - x.start).slice(0, 80).map((i) => ({ id: i.id, name: i.name, status: i.status, version: i.version, start: i.start, end: i.end, leadSec: i.leadSec, elapsedSec: i.elapsedSec, flowEff: i.flowEff, totals: i.totals })),
    numeric: a.numeric.map((f) => ({ activityId: f.activityId, field: f.field, label: labels[f.field] || f.field, n: f.n, min: f.min, max: f.max, median: f.median })),
    suggestedThreshold: threshold ? { ...threshold, label: labels[threshold.field] || threshold.field } : null,
    labels, changeTypes: CHANGE_TYPES,
  }
}

export async function instance(me, defId, instId) {
  await access(me, defId)
  const vs = await versions(defId)
  const i = (await instancesWithVersion(defId)).insts.find((x) => x.id === instId)
  if (!i) throw err(404, '인스턴스를 찾지 못했어요.')
  const ver = vs.find((v) => v.version === i.version)?.version || 'all'
  const { a } = await load(defId, { version: ver })
  const prof = instanceProfile(a, instId)
  if (!prof) throw err(404, '이 인스턴스에는 분해할 상태 전이 이력이 없어요.')
  let remaining = null
  if (prof.status !== 'COMPLETED') {
    const res = resources(a)
    const m = buildModel(a, res)
    const d80 = Object.fromEntries(Object.entries(buildModel(a, res, { basis: 'p80' }).act).map(([k, x]) => [k, x.wait + x.work]))
    remaining = remainingPath(a.g, { dur: Object.fromEntries(Object.entries(m.act).map(([k, x]) => [k, x.wait + x.work])), p: m.p }, { ...prof, now: a.now }, { d80 })
    remaining = { elapsedSec: remaining.elapsedSec, remainingSec: remaining.remainingSec, totalSec: remaining.totalSec, expectedEnd: remaining.expectedEnd, path: remaining.path, state: remaining.state,
      names: Object.fromEntries(remaining.path.map((id) => [id, a.g.nodes.get(id).name])) }
  }
  return { ...prof, remaining }
}

/** what-if: before/after for a list of changes */
export async function simulateChanges(me, defId, { changes = [], version, basis = 'median' } = {}) {
  await access(me, defId)
  const vs = await versions(defId)
  const { a, labels } = await load(defId, { version: version || pickDefaultVersion(vs) })
  const res = resources(a)
  const share = {}
  for (const c of changes) if (c.type === 'skip') { const s = skipShare(a, c.step, c.field, Number(c.threshold)); share[c.step] = s.share; c.threshold = Number(c.threshold); c.label ||= labels[c.field] || c.field; c.skip = s }
  const r = whatIf(a, res, changes, { basis, share })
  const names = Object.fromEntries(r.g.activities.map((id) => [id, r.g.nodes.get(id).name]))
  const view = (e) => ({ leadSec: e.leadSec, workSec: e.workSec, flowEfficiency: e.flowEfficiency, path: e.path, pathNames: e.path.map((id) => names[id] || id), constraint: e.constraint, util: e.util, steps: e.steps, scenarios: e.scenarios.slice(0, 4) })
  return { before: view(r.before), after: view(r.after), changes: r.changes, notes: r.notes, waitFactor: r.waitFactor, names, skip: Object.fromEntries(changes.filter((c) => c.skip).map((c) => [c.step, c.skip])) }
}

/** before/after by version: the same measures per version, from that version's own instances */
export async function compare(me, defId) {
  await access(me, defId)
  const vs = await versions(defId)
  const out = []
  for (const v of vs) {
    if (!v.instances) { out.push({ version: v.version, at: v.at, message: v.message, instances: 0 }); continue }
    const { a } = await load(defId, { version: v.version })
    const vsm = valueStream(a)
    const res = resources(a)
    const c = constraintOf(res)
    const fin = a.steps.map((s) => ({ id: s.id, name: s.name, frequency: s.frequency, medianDuration: s.medianDuration, medianWait: s.medianWait, probability: s.probability }))
    out.push({
      version: v.version, at: v.at, message: v.message, instances: a.instances.length, completed: vsm.instances,
      leadMedian: vsm.leadMedian, leadMean: vsm.leadMean, leadP80: vsm.leadP80, flowEfficiency: vsm.flowEfficiency, workMean: vsm.workMean,
      constraint: c ? { name: c.name, rho: c.rho, step: c.steps[0], waitShare: c.waitShare } : null, steps: fin,
      lowSample: vsm.instances < 10,
    })
  }
  const runs = await q(`select id, from_version, to_version, changes, predicted, notes, applied_by, applied_at from pro_improve_runs where tenant_id=$1 and lower(proc_def_id)=lower($2) order by applied_at`, [T(), defId]).catch(() => [])
  return { versions: out, runs }
}

// ---------- 알림: 새 제약이 나타나면 담당자·관리자에게 (규칙 기반, 모델 호출 없음) ----------
const NOTICE_RHO = 0.75, NOTICE_SHARE = 0.4
export async function checkConstraint(defId, pre = null) {
  const { a, d } = pre || await load(defId)
  const res = pre?.res || resources(a)
  const c = constraintOf(res)
  if (!c || a.instances.filter((i) => i.status === 'COMPLETED').length < 10) return null
  if (!(c.rho >= NOTICE_RHO || c.waitShare >= NOTICE_SHARE)) return null
  const step = c.steps[0]
  const key = `${c.key}|${step}`
  const [st] = await q('select constraint_key from pro_improve_state where tenant_id=$1 and proc_def_id=$2', [T(), d.id])
  if (st?.constraint_key === key) {
    await q('update pro_improve_state set rho=$3, wait_share=$4, checked_at=now() where tenant_id=$1 and proc_def_id=$2', [T(), d.id, c.rho, c.waitShare])
    return null
  }
  await q(`insert into pro_improve_state (tenant_id, proc_def_id, constraint_key, step_name, resource_name, rho, wait_share, detected_at, checked_at)
           values ($1,$2,$3,$4,$5,$6,$7,now(),now())
           on conflict (tenant_id, proc_def_id) do update set constraint_key=excluded.constraint_key, step_name=excluded.step_name, resource_name=excluded.resource_name,
             rho=excluded.rho, wait_share=excluded.wait_share, detected_at=now(), checked_at=now()`, [T(), d.id, key, step, c.name, c.rho, c.waitShare])
  // the process owner; a process nobody owns goes to the admins
  const to = new Set()
  if (d.owner) to.add(String(d.owner))
  else for (const u of await q(`select u.id::text as id from users u join pro_team_members m on m.user_id=u.id and m.tenant_id=u.tenant_id where u.tenant_id=$1 and u.is_admin and not coalesce(u.is_agent,false)`, [T()])) to.add(u.id)
  const url = `/improve/${encodeURIComponent(d.id)}`
  const text = c.capacityBound
    ? `${step}(${c.name}) 단계의 가동률이 ${Math.round(c.rho * 100)}%예요(하루 ${c.lambdaPerDay.toFixed(1)}건 도착, 처리 능력 ${c.muPerDay.toFixed(1)}건). 이 단계 앞 대기가 리드타임의 ${Math.round(c.waitShare * 100)}%(중앙값 ${dur(c.waitMedian)})를 차지해요.`
    : `${step}(${c.name}) 앞 대기가 리드타임의 ${Math.round(c.waitShare * 100)}%(중앙값 ${dur(c.waitMedian)})를 차지해요.`
  for (const id of to) {
    await q(`update notifications set is_checked=true where tenant_id=$1 and user_id=$2 and url=$3 and type='improve' and not coalesce(is_checked,false)`, [T(), id, url])
    await q(`insert into notifications (id, user_id, title, type, description, url, tenant_id) values (gen_random_uuid(),$1,$2,'improve',$3,$4,$5)`,
      [id, `${d.name}: 새 제약이 나타났어요 — ${step}`, text, url, T()])
    emit(id, 'notifications', {})
  }
  return { key, notified: [...to] }
}

// a cheap sweep: definitions whose instances finished in the last day
let sweeping = false
export function startConstraintSweep() {
  const run = async () => {
    if (sweeping) return
    sweeping = true
    try {
      const defs = await q(`select distinct lower(i.proc_def_id) as id from bpm_proc_inst i where i.tenant_id=$1 and i.status='COMPLETED' and i.updated_at > now() - interval '1 day'`, [T()])
      for (const x of defs) await checkConstraint(x.id).catch(() => {})
    } finally { sweeping = false }
  }
  setTimeout(run, 20000)
  setInterval(run, 30 * 60000)
}

/** a process named in a question or a tool call ("달빛커피 제안", an id) among the ones with a history */
export async function resolveProcess(key) {
  const k = String(key || '').trim()
  if (!k) return null
  const rows = await q(`select d.id, d.name, count(i.*)::int as n from proc_def d join bpm_proc_inst i on lower(i.proc_def_id)=lower(d.id) and i.tenant_id=d.tenant_id
                        where d.tenant_id=$1 and not coalesce(d.isdeleted,false) group by d.id, d.name order by n desc`, [T()])
  const norm = (s) => String(s || '').replace(/\s+/g, '').toLowerCase()
  const nk = norm(k)
  return rows.find((r) => r.id.toLowerCase() === k.toLowerCase()) || rows.find((r) => norm(r.name) === nk)
    || rows.find((r) => r.name && nk.includes(norm(r.name))) || rows.find((r) => r.name && norm(r.name).includes(nk)) || null
}

// compact, number-first summaries for tools and the chat (the model explains these; it never computes them)
export async function brief(me, defId, { basis = 'median' } = {}) {
  const o = await overview(me, defId, { basis })
  const c = o.toc.constraint
  const cp = o.cpm[basis] || o.cpm.median
  const names = Object.fromEntries(o.steps.map((s) => [s.id, s.name]))
  return {
    process: o.def.name, id: o.def.id, version: o.version, completed: o.counts.completed, running: o.counts.running,
    lead_time: { median: dur(o.observed.leadMedian), p80: dur(o.observed.leadP80) },
    flow_efficiency: o.vsm.flowEfficiency != null ? `${(o.vsm.flowEfficiency * 100).toFixed(1)}%` : null,
    bottlenecks: [...o.steps].sort((x, y) => y.normalizedBottleneck - x.normalizedBottleneck).slice(0, 4).map((s) => ({
      step: s.name, who: s.people[0]?.name || s.role, kind: s.kind === 'human' ? '사람' : '에이전트', runs: s.frequency,
      median: dur(s.medianDuration), p80: dur(s.p80Duration), wait_median: dur(s.medianWait), work_median: dur(s.medianWork),
      review_wait_total: dur(s.sums.review_wait), queue_wait_total: dur(s.sums.queue_wait), rework_rate: `${s.reworkRate.toFixed(1)}%`,
      bottleneck_score: `${s.normalizedBottleneck.toFixed(0)}%`,
    })),
    constraint: c ? { step: c.steps[0], who: c.name, utilization: `${Math.round(c.rho * 100)}%`, arrivals_per_day: +c.lambdaPerDay.toFixed(2), capacity_per_day: c.muPerDay ? +c.muPerDay.toFixed(2) : null,
      waiting_now_avg: +c.wip.toFixed(1), waiting_recent_2w: +c.wipRecent.toFixed(1), waiting_before: +c.wipBefore.toFixed(1), wait_share_of_lead_time: `${Math.round(c.waitShare * 100)}%`,
      wait_behind_others_share: `${Math.round((c.behindShare || 0) * 100)}%` } : null,
    critical_path: { basis, expected_lead_time: dur(cp.expectedSec), path: cp.path.map((id) => names[id] || id), probability: `${Math.round(cp.pathProb * 100)}%`,
      slack: cp.rows.filter((r) => !r.critical && !r.loop).map((r) => ({ step: r.name, slack: dur(r.slack) })) },
    five_focusing_steps: o.toc.focus.map((s) => ({ stage: s.title, text: s.text, actions: (s.actions || []).map((x) => ({ title: x.title, text: x.text, changes: x.changes?.map((y) => ({ type: y.type, step: y.step, field: y.field, threshold: y.threshold, saving: y.saving, add: y.add, factor: y.factor })),
      lead_time: x.after ? `${dur(x.before.leadSec)} → ${dur(x.after.leadSec)}` : undefined, flow_efficiency: x.after ? `${(x.before.flowEfficiency * 100).toFixed(1)}% → ${(x.after.flowEfficiency * 100).toFixed(1)}%` : undefined,
      utilization: x.after?.rho != null ? `${Math.round(x.before.rho * 100)}% → ${Math.round(x.after.rho * 100)}%` : undefined })) })),
    running_instances: o.running.slice(0, 5).map((r) => ({ name: r.name, remaining: dur(r.remainingSec), expected_end: new Date(r.expectedEnd).toISOString(), remaining_critical_path: r.path.map((id) => names[id] || id) })),
    link: `/improve/${encodeURIComponent(o.def.id)}`,
  }
}
