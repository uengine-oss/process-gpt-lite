// Worker for process-gpt work items with agent_orch = 'browser-automation-agent'.
// process-gpt already routes such activities to that orchestration and reserves the slot
// (frontend default agent, SDK sensitive_data handling) but ships no worker for it. This one
// speaks the same protocol as processgpt_agent_sdk:
//   fetch_pending_task(p_agent_orch, p_consumer, p_limit, p_env)  → claim an IN_PROGRESS row
//   record_events_bulk(events)                                   → progress for the existing UI
//   save_task_result(p_todo_id, p_payload, p_final)              → output + SUBMITTED (COMPLETE mode)
// and on failure sets draft_status='FAILED', consumer=null like the SDK's update_task_error.
import crypto from 'node:crypto'
import { admin, q } from './supa.js'
import { config } from '../config.js'
import { withTenant } from './tenant.js'
import { chatJson } from './llm.js'
import { runBrowserTask } from './browser.js'
import { addMessage } from './store.js'
import { getForm } from './processes.js'
import { emit } from './bus.js'

const ORCH = 'browser-automation-agent'
const CONSUMER = `pgpt-pro-browser-${process.pid}`
let busy = false

async function events(list) {
  const { error } = await admin.rpc('record_events_bulk', { p_events: list })
  if (error) console.warn('[browser-worker] events', error.message)
}

// The person the browser acts for: whoever started the instance (first human work item).
async function ownerOf(row) {
  const [t] = await q(`select user_id from todolist where proc_inst_id=$1 and coalesce(agent_orch,'') = ''
                       order by start_date asc nulls last limit 1`, [row.proc_inst_id])
  return (t?.user_id || '').split(',')[0].trim() || null
}

async function instanceThread(userId, instId) {
  let [t] = await q('select id from pro_threads where user_id=$1 and ref=$2', [userId, instId])
  if (!t) {
    const [i] = await q('select proc_inst_name from bpm_proc_inst where proc_inst_id=$1', [instId])
    ;[t] = await q(`insert into pro_threads(user_id,kind,title,ref) values ($1,'process',$2,$3) returning id`, [userId, i?.proc_inst_name, instId])
  }
  return t.id
}

async function formFor(row) {
  const id = (row.tool || '').startsWith('formHandler:') ? row.tool.slice(12) : null
  if (id) return getForm(id)
  const [f] = await q('select id from form_def where proc_def_id=$1 and activity_id=$2 and tenant_id=$3', [row.proc_def_id, row.activity_id, row.tenant_id])
  return f ? getForm(f.id) : null
}

async function handle(row) {
  const job = crypto.randomUUID()
  const base = { job_id: job, todo_id: row.id, proc_inst_id: row.proc_inst_id, crew_type: ORCH }
  const owner = await ownerOf(row)
  if (!owner) throw new Error('no human participant to act for')
  const threadId = owner ? await instanceThread(owner, row.proc_inst_id) : null
  await events([{ ...base, event_type: 'task_started', data: { goal: `${row.activity_name} 작업을 시작합니다.`, name: '브라우저 에이전트', role: row.activity_name } }])

  // the activity's full instruction lives in the definition; the work item carries only its summary
  const [d] = await q(`select a->>'instruction' as instruction from proc_def, jsonb_array_elements(definition->'activities') a
                       where id=$1 and tenant_id=$2 and a->>'id'=$3`, [row.proc_def_id, row.tenant_id, row.activity_id])
  const goal = `${row.activity_name}\n${d?.instruction || row.description || ''}\n\n${row.query || ''}`.trim()
  const result = await runBrowserTask({
    userId: owner, threadId, goal, unattended: true,
    onAction: (name, args, out) => events([
      { ...base, event_type: 'tool_usage_started', data: { tool: name, tool_name: name, args } },
      { ...base, event_type: 'tool_usage_finished', data: { tool: name, tool_name: name, args, result: out.slice(0, 500) } },
    ]),
  })
  if (result.state !== 'done') throw new Error(result.summary || result.state)

  // Fill the activity's form from what the browser found.
  const form = await formFor(row)
  let payload
  if (form?.fields?.length) {
    const values = await chatJson(
      `Fill a work form from a browser agent's findings. Return JSON {"<field key>": value} for exactly these fields: ${JSON.stringify(form.fields.map((f) => ({ key: f.key, label: f.text, type: f.type, items: f.items })))}.
Use only facts present in the findings. For report/textarea fields write a Korean markdown report (tables welcome). For select/radio use one of the item keys.`,
      `Findings:\n${(result.notes || []).join('\n')}\n\nSummary:\n${result.summary}\n\nLast page (${result.url}):\n${result.pageText}`)
    payload = { [form.id]: values }
  } else {
    payload = { result: result.summary, notes: result.notes, url: result.url }
  }
  const { error } = await admin.rpc('save_task_result', { p_todo_id: row.id, p_payload: payload, p_final: true })
  if (error) throw new Error('save_task_result: ' + error.message)
  await events([
    { ...base, crew_type: 'result', event_type: 'task_completed', data: payload },
    { job_id: 'CREW_FINISHED', todo_id: row.id, proc_inst_id: row.proc_inst_id, crew_type: 'crew', event_type: 'crew_completed', data: 'Task completed successfully' },
  ])
  if (owner && threadId) await addMessage(owner, threadId, 'agent', 'text', { text: `브라우저 에이전트가 '${row.activity_name}'을 마쳤어요. ${result.summary}` })
  if (owner) emit(owner, 'process', { instId: row.proc_inst_id, type: 'changed' })
}

async function tick() {
  if (busy) return
  busy = true
  try {
    const { data, error } = await admin.rpc('fetch_pending_task', { p_agent_orch: ORCH, p_consumer: CONSUMER, p_limit: 1, p_env: 'dev' })
    if (error) throw new Error(error.message)
    const row = data?.[0]
    if (!row) return
    // one install serves one tenant; behind the ProcessGPT gateway a step runs as the tenant it belongs to
    if (!config.tenantFromHeader && row.tenant_id !== config.tenantId) {
      // not ours: hand it back untouched for the worker of that tenant
      await admin.from('todolist').update({ draft_status: null, consumer: null }).eq('id', row.id)
      return
    }
    console.log('[browser-worker] claimed', row.id, row.activity_name)
    try {
      await withTenant(row.tenant_id, () => handle(row))
    } catch (e) {
      console.warn('[browser-worker] failed', e.message)
      await admin.from('todolist').update({ draft_status: 'FAILED', consumer: null }).eq('id', row.id)
      await events([{ job_id: crypto.randomUUID(), todo_id: row.id, proc_inst_id: row.proc_inst_id, crew_type: ORCH, event_type: 'error', data: { message: e.message } }])
    }
  } catch (e) {
    console.warn('[browser-worker]', e.message)
  } finally { busy = false }
}

export async function startBrowserWorker() {
  // The browser runs inside this server, so a step claimed by an earlier run of it died with
  // that process; hand it back so this run picks it up again instead of leaving it stuck.
  const freed = await q(`update todolist set consumer=null, draft_status=null
                         where agent_orch=$1 and status='IN_PROGRESS' and consumer like 'pgpt-pro-browser-%' and consumer <> $2
                         returning id, activity_name`, [ORCH, CONSUMER]).catch(() => [])
  for (const r of freed) console.log('[browser-worker] released', r.id, r.activity_name)
  setInterval(tick, 5000)
  console.log(`[browser-worker] polling agent_orch=${ORCH} as ${CONSUMER}`)
}
