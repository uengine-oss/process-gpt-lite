// Write side of process-gpt BPM. Both starting an instance and submitting a work item go
// through completion's POST /complete; the polling service then advances the instance and
// deepagents picks up agent steps (status IN_PROGRESS).
import crypto from 'node:crypto'
import { config } from '../config.js'
import { q } from './supa.js'
import { emit } from './bus.js'
import { updateMessage, mainThread, addMessage } from './store.js'
import { getDefinition, getTodo } from './processes.js'
import { roleMap } from './team.js'

async function complete(input) {
  const res = await fetch(`${config.completionUrl}/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: { ...input, tenant_id: config.tenantId } }),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`completion ${res.status}: ${text.slice(0, 200)}`)
  try { return JSON.parse(text) } catch { return { raw: text } }
}

export async function startProcess({ me, defId, values, messageId }) {
  const [row] = await q('select definition from proc_def where id=$1 and tenant_id=$2', [defId, config.tenantId])
  if (!row) throw new Error('process not found')
  const def = await getDefinition(defId)
  const first = def.steps.find((s) => s.kind === 'human' || s.kind === 'agent')
  if (!first) throw new Error('process has no activities')
  const formId = first.formId || 'defaultform'

  // Human roles go to the teammate assigned to them (Settings → 팀·역할); a role nobody holds
  // goes to whoever started the process — the person who set the work up owns it by default.
  // process-gpt's todolist trigger then notifies exactly that person when their step comes up.
  const roles = JSON.parse(JSON.stringify(row.definition.roles || []))
  const assigned = await roleMap(defId)
  for (const x of roles) {
    const empty = !x.endpoint || (Array.isArray(x.endpoint) && !x.endpoint.length)
    if (x.origin === 'used' && !empty) continue // agents keep their own endpoint
    const who = assigned[x.name] || (empty || x.name === first.role ? me.id : null)
    if (who) { x.endpoint = [who]; x.default = [who] }
  }

  const instId = `${defId.toLowerCase()}.${crypto.randomUUID()}`
  await complete({
    process_definition_id: defId.toLowerCase(),
    process_instance_id: instId,
    chat_room_id: instId,
    activity_id: first.id,
    answer: '',
    form_values: { [formId]: values || {} },
    role_mappings: roles,
    version_tag: 'major',
    version: null,
    source_list: [],
    email: me.email,
  })
  const [inst] = await q('select proc_inst_id, proc_inst_name from bpm_proc_inst where proc_inst_id=$1', [instId])
  const instName = inst?.proc_inst_name || def.name
  if (messageId) await updateMessage(me.id, messageId, { state: 'started', instId, instName })
  emit(me.id, 'process', { instId, type: 'started' })
  watchInstance(me, instId)
  return { instId, instName }
}

export async function submitTodo({ me, todoId, values, messageId }) {
  const d = await getTodo(todoId)
  if (!d) throw new Error('work item not found')
  const t = d.todo
  const formId = d.form?.id || d.step?.formId || 'defaultform'
  await complete({
    answer: '',
    form_values: { [formId]: values || {} },
    process_instance_id: t.proc_inst_id,
    process_definition_id: t.proc_def_id,
    activity_id: t.activity_id,
    chat_room_id: t.proc_inst_id,
    task_id: t.id,
    version_tag: t.version_tag || 'major',
    version: t.version || null,
    email: me.email,
  })
  if (messageId) await updateMessage(me.id, messageId, { state: 'submitted' })
  emit(me.id, 'process', { instId: t.proc_inst_id, type: 'submitted' })
  watchInstance(me, t.proc_inst_id)
  return { ok: true }
}

// Follow an instance while it runs: push changes to the client and surface new work
// items assigned to the user in the main chat (hark-style "needs your input").
const watching = new Map()
export function watchInstance(me, instId) {
  if (watching.has(instId)) return
  let last = ''
  const announced = new Set()
  let idle = 0
  const tick = async () => {
    try {
      const [i] = await q('select status, current_activity_ids, updated_at from bpm_proc_inst where proc_inst_id=$1', [instId])
      const todos = await q(`select id, activity_id, activity_name, status, draft_status, user_id, agent_orch, updated_at from todolist where proc_inst_id=$1`, [instId])
      const sig = JSON.stringify([i?.status, i?.current_activity_ids, todos.map((t) => [t.id, t.status, t.draft_status])])
      if (sig !== last) {
        last = sig
        idle = 0
        emit(me.id, 'process', { instId, type: 'changed', status: i?.status })
        for (const t of todos) {
          const reached = t.status === 'IN_PROGRESS' || (['TODO', 'NEW'].includes(t.status) && (i?.current_activity_ids || []).includes(t.activity_id))
          const mine = reached && !t.agent_orch && (String(t.user_id).includes(me.id) || String(t.user_id).includes(me.email))
          if (mine && !announced.has(t.id)) {
            announced.add(t.id)
            const th = await mainThread(me.id)
            await addMessage(me.id, th.id, 'agent', 'todo', { todoId: t.id, name: t.activity_name })
          }
        }
        if (i?.status === 'COMPLETED') {
          const th = await mainThread(me.id)
          const [n] = await q('select proc_inst_name from bpm_proc_inst where proc_inst_id=$1', [instId])
          await addMessage(me.id, th.id, 'agent', 'chip', { icon: 'check', text: `완료 · ${n?.proc_inst_name || instId}`, instId })
        }
      } else idle++
      if (i?.status === 'COMPLETED' || idle > 360) return stop()
    } catch (e) { console.warn('[watch]', e.message) }
  }
  const stop = () => { clearInterval(watching.get(instId)); watching.delete(instId) }
  watching.set(instId, setInterval(tick, 5000))
  tick()
}
