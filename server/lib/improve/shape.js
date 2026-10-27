// The rows process-gpt's engine leaves behind for one step run, in the same shape (seed data and tests):
//  - every step's work item is pre-created as TODO when the instance starts (a re-run when it is sent back)
//  - the first step is the start form: SUBMITTED when the instance starts, DONE when the engine moves on
//  - a person's step goes IN_PROGRESS the moment it is reached; Lite records when the assignee first
//    opens it (events.human_checked); submitting is SUBMITTED, the engine then marks DONE
//  - an agent step goes IN_PROGRESS on reach, the worker leaves task_started / task_completed events
// todolist_status_history.changed_at and events.timestamp are the only times the analysis reads.
import crypto from 'node:crypto'
const iso = (t) => new Date(t).toISOString()

export function engineRows({ instId, defId, tenant = 'localhost', steps }) {
  const todos = [], history = [], events = []
  for (const s of steps) {
    const created = s.createdAt
    todos.push({
      id: s.todoId, instId, defId, activityId: s.activityId, activityName: s.activityName, userId: s.userId, username: s.username,
      agentOrch: s.human ? null : 'deepagents', agentMode: s.human ? null : 'COMPLETE', status: 'DONE', output: s.output || {},
      tool: s.tool || null, startDate: iso(s.ready), endDate: iso(s.finish), tenant,
    })
    const h = (from, to, at, extra = {}) => history.push({ todo_id: s.todoId, proc_inst_id: instId, activity_id: s.activityId, from_status: from, to_status: to, changed_at: iso(at), changed_by: s.userId, changed_by_is_agent: !s.human, rework_seq: 0, is_estimated: false, tenant_id: tenant, ...extra })
    if (s.startForm) {
      h(null, 'SUBMITTED', created)
      h('SUBMITTED', 'DONE', s.finish)
      continue
    }
    h(null, 'TODO', created)
    h('TODO', 'IN_PROGRESS', s.ready + 50)
    const job = s.human ? `opened:${s.todoId}` : crypto.randomUUID()
    if (s.human) {
      events.push({ job_id: job, todo_id: s.todoId, proc_inst_id: instId, event_type: 'human_checked', crew_type: 'pgpt-pro', timestamp: iso(s.start), data: { by: s.username } })
      h('IN_PROGRESS', 'SUBMITTED', s.finish - 3000)
      h('SUBMITTED', 'DONE', s.finish)
    } else {
      events.push({ job_id: job, todo_id: s.todoId, proc_inst_id: instId, event_type: 'task_started', crew_type: 'deepagents', timestamp: iso(s.start), data: { name: s.username, role: s.activityName } })
      events.push({ job_id: job, todo_id: s.todoId, proc_inst_id: instId, event_type: 'task_completed', crew_type: 'result', timestamp: iso(s.finish - 2000), data: {} })
      h('IN_PROGRESS', 'SUBMITTED', s.finish - 2000, { draft_status: 'COMPLETED' })
      h('SUBMITTED', 'DONE', s.finish, { draft_status: 'COMPLETED' })
    }
  }
  return { todos, history, events }
}

/** write one simulated instance into the engine tables (bpm_proc_inst, todolist, todolist_status_history, events) */
export async function writeInstance(q, { tenant = 'localhost', defId, sim, arcv = null, version = null, roles = [], mark = {} }) {
  const r = engineRows({ instId: sim.instId, defId, tenant, steps: sim.steps })
  const participants = [...new Set(sim.steps.map((x) => x.userId))]
  await q(`insert into bpm_proc_inst (proc_inst_id, proc_inst_name, proc_def_id, status, tenant_id, current_activity_ids, participants, role_bindings, variables_data,
                                      proc_def_version, version_tag, version, start_date, end_date, updated_at, actual_start_date, is_deleted)
           values ($1,$2,$3,'COMPLETED',$4,'{}',$5,$6,$7,$8,'major',$9,$10,$11,$12,$13,false)`,
  [sim.instId, sim.name, defId, tenant, participants, JSON.stringify(roles), mark, arcv, version, new Date(sim.start), new Date(sim.end), new Date(sim.end), new Date(sim.start)])
  for (const t of r.todos) {
    await q(`insert into todolist (id, user_id, username, proc_inst_id, root_proc_inst_id, proc_def_id, activity_id, activity_name, start_date, end_date, status, tool, tenant_id,
                                   output, agent_mode, agent_orch, version_tag, version, draft_status, duration)
             values ($1,$2,$3,$4,$4,$5,$6,$7,$8,$9,'DONE',$10,$11,$12,$13,$14,'major',$15,$16,1)`,
    [t.id, t.userId, t.username, sim.instId, defId, t.activityId, t.activityName, t.startDate, t.endDate, `formHandler:${defId}_${t.activityId}_form`, tenant,
      t.output, t.agentMode, t.agentOrch, version, t.agentOrch ? 'COMPLETED' : null])
  }
  // the insert trigger stamped now(); the engine's own transitions replace it
  await q('delete from todolist_status_history where todo_id = any($1::uuid[])', [r.todos.map((t) => t.id)])
  for (const h of r.history) {
    await q(`insert into todolist_status_history (tenant_id, todo_id, proc_inst_id, activity_id, from_status, to_status, changed_at, changed_by, changed_by_is_agent, rework_seq, draft_status, is_estimated)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,false)`,
    [tenant, h.todo_id, h.proc_inst_id, h.activity_id, h.from_status, h.to_status, h.changed_at, h.changed_by, h.changed_by_is_agent, h.rework_seq, h.draft_status || null])
  }
  for (const e of r.events) {
    await q(`insert into events (id, job_id, todo_id, proc_inst_id, event_type, crew_type, data, timestamp, tenant_id) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [crypto.randomUUID(), e.job_id, e.todo_id, e.proc_inst_id, e.event_type, e.crew_type, e.data, e.timestamp, tenant])
  }
  for (const t of sim.steps) {
    await q(`update task_execution_properties set started_at=$2, completed_at=$3, execution_status='COMPLETED', actual_duration=make_interval(secs => $4) where todo_id=$1`,
      [t.todoId, new Date(t.start), new Date(t.finish), Math.round((t.finish - t.ready) / 1000)]).catch(() => {})
  }
  return r.todos.length
}

/** the flattened definition save_contract would store, from a generation contract's elements (tests, previews) */
export function flatDefinition(contract) {
  const pd = contract.processDefinition
  const els = pd.elements
  return {
    processDefinitionId: pd.processDefinitionId, processDefinitionName: pd.processDefinitionName, description: pd.description, roles: pd.roles,
    activities: els.filter((e) => e.elementType === 'Activity').map((e) => ({ id: e.id, name: e.name, role: e.role, type: 'userTask', tool: e.tool, agent: e.agent || null, agentMode: e.agentMode || 'none', orchestration: e.orchestration || null, description: e.description, instruction: e.instruction, properties: '{}' })),
    gateways: els.filter((e) => e.elementType === 'Gateway').map((e) => ({ id: e.id, name: e.name, role: e.role, type: e.type === 'ParallelGateway' ? 'parallelGateway' : 'exclusiveGateway', properties: '{}' })),
    events: els.filter((e) => e.elementType === 'Event').map((e) => ({ id: e.id, name: e.name, role: e.role, type: e.type === 'StartEvent' ? 'startEvent' : 'endEvent', properties: '{}' })),
    sequences: els.filter((e) => e.elementType === 'Sequence').map((e) => ({ id: e.id, source: e.source, target: e.target, condition: e.condition || '', name: e.name || '', properties: '{}' })),
  }
}
