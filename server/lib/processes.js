// Read side of process-gpt BPM: definitions, forms, instances, work items, artifacts.
import { q } from './supa.js'
import { config } from '../config.js'

const T = () => config.tenantId

// Order a definition's nodes by walking sequences from the start event (BFS).
function orderSteps(def) {
  const acts = def.activities || []
  const gws = def.gateways || []
  const evs = def.events || []
  const seqs = def.sequences || []
  const node = new Map()
  for (const a of acts) node.set(a.id, { ...a, kind: a.type === 'userTask' && (!a.agentMode || a.agentMode === 'none') && !a.orchestration ? 'human' : 'agent' })
  for (const g of gws) node.set(g.id, { ...g, kind: 'gateway' })
  for (const e of evs) node.set(e.id, { ...e, kind: e.type === 'startEvent' ? 'start' : e.type === 'endEvent' ? 'end' : 'event' })
  const out = new Map()
  for (const s of seqs) (out.get(s.source) || out.set(s.source, []).get(s.source)).push(s.target)
  const start = evs.find((e) => e.type === 'startEvent')?.id || acts[0]?.id
  const seen = new Set()
  const order = []
  const queue = [start]
  while (queue.length) {
    const id = queue.shift()
    if (!id || seen.has(id)) continue
    seen.add(id)
    if (node.has(id)) order.push(node.get(id))
    for (const n of out.get(id) || []) queue.push(n)
  }
  for (const n of node.values()) if (!seen.has(n.id)) order.push(n)
  return order
}

const formIdOf = (a) => (a?.tool || '').startsWith('formHandler:') ? a.tool.slice('formHandler:'.length) : null

export async function getForm(formId) {
  if (!formId) return null
  const [f] = await q('select id, html, fields_json from form_def where id=$1 and tenant_id=$2', [formId, T()])
  if (!f) return null
  // fields_json is a derived index; the form HTML is what process-gpt renders. Take missing
  // choice lists from the field tag's items='[...]' attribute.
  const fields = (f.fields_json || []).map((x) => {
    if (x.items || !/select|radio|checkbox|multiselect/.test(x.type || '')) return x
    const tagRe = new RegExp(`<[\\w-]+[^>]*\\bname=['"]${x.key}['"][^>]*>`)
    const tag = (f.html || '').match(tagRe)?.[0] || ''
    const raw = tag.match(/\bitems='([^']*)'/)?.[1] || tag.match(/\bitems="([^"]*)"/)?.[1]
    try { return raw ? { ...x, items: JSON.parse(raw.replace(/&quot;/g, '"')) } : x } catch { return x }
  })
  return { id: f.id, fields }
}

export async function listDefinitions(search) {
  const rows = await q(
    `select id, name, description, definition->>'description' as ddesc, saved_at
     from proc_def where tenant_id=$1 and not coalesce(isdeleted,false) and coalesce(type,'') <> 'dmn'
       and jsonb_array_length(coalesce(definition->'activities','[]'::jsonb)) > 0
       and ($2::text is null or name ilike '%'||$2||'%' or id ilike '%'||$2||'%' or coalesce(description,'') ilike '%'||$2||'%')
     order by saved_at desc nulls last limit 200`, [T(), search || null])
  return rows.map((r) => ({ id: r.id, name: r.name, description: r.description || r.ddesc || '' }))
}

export async function getDefinition(id) {
  const [r] = await q('select id, name, description, definition from proc_def where id=$1 and tenant_id=$2', [id, T()])
  if (!r) return null
  const def = r.definition || {}
  // like the process-gpt frontend: activity.tool names the form, else form_def by (proc_def_id, activity_id)
  const byAct = Object.fromEntries((await q('select id, activity_id from form_def where proc_def_id=$1 and tenant_id=$2', [id, T()])).map((f) => [f.activity_id, f.id]))
  const steps = orderSteps(def).map((n) => ({
    id: n.id, name: n.name || n.id, role: n.role || '', kind: n.kind, description: n.description || '',
    formId: formIdOf(n) || byAct[n.id] || null, agentMode: n.agentMode || null, orchestration: n.orchestration || null,
  }))
  const first = steps.find((s) => s.kind === 'human' || s.kind === 'agent')
  return {
    id: r.id, name: r.name, description: r.description || def.description || '',
    roles: (def.roles || []).map((x) => x.name),
    steps,
    firstActivity: first?.id || null,
    startForm: first?.kind === 'human' ? await getForm(first.formId) : null,
  }
}

// An agent step is only "running" while a worker holds it (polling/cli-agent claim it: consumer,
// lease, draft STARTED). A queued agent step or a step waiting on a person is not.
const AGENT_RUNNING = `t.agent_orch is not null and t.status not in ('DONE','CANCELLED')
  and (t.draft_status::text = 'STARTED' or t.consumer is not null or t.lease_until > now())`
const agentRunning = (t) => !!t?.agent_orch && !['DONE', 'CANCELLED'].includes(t.status) &&
  (t.draft_status === 'STARTED' || !!t.consumer || (t.lease_until && new Date(t.lease_until) > new Date()))

export async function listInstances({ userEmail, userId, status, limit = 30 }) {
  return q(
    `select i.proc_inst_id, i.proc_inst_name, i.proc_def_id, i.status, i.current_activity_ids, i.start_date, i.end_date, i.updated_at,
            d.name as def_name,
            exists (select 1 from todolist t where t.proc_inst_id=i.proc_inst_id
                    and (t.status = 'IN_PROGRESS' or (t.status in ('TODO','NEW') and t.activity_id = any(i.current_activity_ids)))
                    and (t.user_id like '%'||$2||'%' or t.user_id like '%'||$3||'%')) as needs_me,
            exists (select 1 from todolist t where t.proc_inst_id=i.proc_inst_id and ${AGENT_RUNNING}) as agent_running,
            exists (select 1 from todolist t where t.proc_inst_id=i.proc_inst_id and t.agent_orch is null
                    and (t.status = 'IN_PROGRESS' or (t.status in ('TODO','NEW') and t.activity_id = any(i.current_activity_ids)))) as human_waiting
     from bpm_proc_inst i left join proc_def d on d.id=i.proc_def_id and d.tenant_id=i.tenant_id
     where i.tenant_id=$1 and not coalesce(i.is_deleted,false) and ($4::text is null or i.status::text=$4)
     order by coalesce(i.updated_at, i.start_date::timestamptz) desc nulls last limit $5`,
    [T(), userEmail, userId, status || null, limit])
}

// Everything needed to draw one instance: definition steps with live status, work items, outputs.
export async function getInstance(instId, me) {
  const [inst] = await q('select * from bpm_proc_inst where proc_inst_id=$1 and tenant_id=$2', [instId, T()])
  if (!inst) return null
  const def = await getDefinition(inst.proc_def_id)
  const todos = await q(
    `select id, activity_id, activity_name, status, user_id, username, start_date, end_date, updated_at, output, draft,
            output_url, agent_mode, agent_orch, log, description, draft_status::text as draft_status, consumer, lease_until
     from todolist where proc_inst_id=$1 order by coalesce(start_date, updated_at::timestamp) asc`, [instId])
  const byAct = new Map()
  for (const t of todos) byAct.set(t.activity_id, t) // latest wins
  const current = new Set(inst.current_activity_ids || [])
  const steps = (def?.steps || []).map((s) => {
    const t = byAct.get(s.id)
    let state = 'pending'
    // process-gpt pre-creates the next work item as TODO ("New"); it is only underway once
    // IN_PROGRESS/SUBMITTED/PENDING or listed in current_activity_ids
    const reached = current.has(s.id) || ['IN_PROGRESS', 'SUBMITTED', 'PENDING'].includes(t?.status)
    if (t) state = t.status === 'DONE' ? 'done' : t.status === 'CANCELLED' ? 'cancelled' : reached ? 'active' : 'pending'
    else if (current.has(s.id)) state = 'active'
    if (s.kind === 'start') state = 'done'
    if (s.kind === 'end') state = inst.status === 'COMPLETED' ? 'done' : 'pending'
    const mine = t && reached && ['TODO', 'IN_PROGRESS', 'NEW'].includes(t.status) &&
      (String(t.user_id || '').includes(me.email) || String(t.user_id || '').includes(me.id))
    return { ...s, state, todoId: t?.id || null, todoStatus: t?.status || null, mine: !!mine, assignee: t?.username || t?.user_id || null,
      running: state === 'active' && agentRunning(t) }
  })
  // gateways have no work item: done once anything after them is done
  steps.forEach((s, i) => { if (s.kind === 'gateway' && steps.slice(i + 1).some((n) => n.state === 'done')) s.state = 'done' })
  // a finished instance did not take the other branches
  if (inst.status === 'COMPLETED') for (const s of steps) if (s.state !== 'done') s.state = 'skipped'
  const artifacts = []
  const labels = {}
  for (const s of def?.steps || []) {
    const f = await getForm(s.formId)
    for (const x of f?.fields || []) labels[x.key] = x.text
  }
  for (const t of todos) {
    if (!t.output || t.status !== 'DONE' && t.status !== 'SUBMITTED' && t.status !== 'PENDING') continue
    artifacts.push(...flattenOutput(t).map((a) => ({ ...a, label: a.field ? labels[a.field] : undefined })))
  }
  return { inst, def, steps, todos, artifacts }
}

// todolist.output is {formId: {field: value}} (sometimes flat). Pull out documents and files.
function flattenOutput(t) {
  const out = []
  const all = t.output && typeof t.output === 'object' ? t.output : {}
  // cli-agent adds run metadata beside the form values; the worktree branch is a result of its own
  const { worktree, media: _m, cliagents_session_id: _s, replay_limited: _r, ...rest } = all
  // an agent's raw answer rides beside the form it filled; the form is the result to show
  const hasForm = Object.values(rest).some((v) => v && typeof v === 'object' && !Array.isArray(v))
  const { text: _t, ...formsOnly } = rest
  const forms = hasForm ? formsOnly : rest
  const groups = Object.values(forms).every((v) => v && typeof v === 'object' && !Array.isArray(v)) ? forms : { _: forms }
  for (const [formId, vals] of Object.entries(groups)) {
    for (const [k, v] of Object.entries(vals || {})) {
      if (v && typeof v === 'object' && v.url) out.push({ kind: 'file', name: v.name || k, url: v.url, activity: t.activity_name, todoId: t.id })
      else if (typeof v === 'string' && v.length > 280) out.push({ kind: 'doc', field: k, text: v, activity: t.activity_name, todoId: t.id, formId })
    }
  }
  if (t.output_url) out.push({ kind: 'file', name: t.output_url.split('/').pop(), url: t.output_url, activity: t.activity_name, todoId: t.id })
  if (worktree?.commit) out.push({ kind: 'branch', ...worktree, activity: t.activity_name, todoId: t.id })
  // media a CLI agent left in its run workspace (demo video and the like), served through cli-agent
  for (const m of all.media || []) {
    // the finished video, not the silent screen capture or per-scene clips it was built from
    const top = m.path.split('/').slice(-2, -1)[0] === '.pgpt-demo'
    const kind = top && /\.(mp4|webm)$/i.test(m.name) && !/^screen\./.test(m.name) ? 'video' : null
    if (kind) out.push({ kind, name: m.name, runId: m.run_id, path: m.path, activity: t.activity_name, todoId: t.id })
  }
  return out
}

export async function myTodos(me) {
  return q(
    `select t.id, t.proc_inst_id, t.proc_def_id, t.activity_id, t.activity_name, t.status, t.start_date, t.due_date, t.description,
            i.proc_inst_name, d.name as def_name
     from todolist t left join bpm_proc_inst i on i.proc_inst_id=t.proc_inst_id
     left join proc_def d on d.id=t.proc_def_id and d.tenant_id=t.tenant_id
     where t.tenant_id=$1
       and (t.status = 'IN_PROGRESS' or (t.status in ('TODO','NEW') and t.activity_id = any(i.current_activity_ids)))
       and coalesce(t.agent_orch,'') = ''
       and (t.user_id like '%'||$2||'%' or t.user_id like '%'||$3||'%')
     order by t.start_date desc nulls last limit 20`, [T(), me.email, me.id])
}

export async function getTodo(todoId) {
  const [t] = await q('select * from todolist where id=$1', [todoId])
  if (!t) return null
  const def = await getDefinition(t.proc_def_id)
  const step = def?.steps.find((s) => s.id === t.activity_id)
  const form = await getForm(step?.formId)
  const vals = t.draft || t.output || {}
  const [inst] = await q('select proc_inst_name from bpm_proc_inst where proc_inst_id=$1', [t.proc_inst_id])
  return { todo: t, step, form, instName: inst?.proc_inst_name || def?.name, values: form ? (vals[form.id] || vals) : {} }
}

// Same lookup order as the process-gpt frontend's getRawDefinition({type:'bpmn'}):
// latest proc_def_version snapshot, then proc_def.bpmn.
export async function getBpmn(defId) {
  const [v] = await q(`select snapshot from proc_def_version where proc_def_id=$1 and tenant_id=$2 and coalesce(snapshot,'') <> ''
                       order by version desc limit 1`, [defId, T()]).catch(() => [])
  if (v?.snapshot) return v.snapshot
  const [d] = await q('select bpmn from proc_def where id=$1 and tenant_id=$2', [defId, T()])
  return d?.bpmn || null
}
