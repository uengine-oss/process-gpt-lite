// Write side of process-gpt BPM. Both starting an instance and submitting a work item go
// through completion's POST /complete; the polling service then advances the instance and
// deepagents picks up agent steps (status IN_PROGRESS).
import crypto from 'node:crypto'
import { config } from '../config.js'
import { q } from './supa.js'
import { emit } from './bus.js'
import { updateMessage } from './store.js'
import { getDefinition, getTodo } from './processes.js'
import { roleMap, roleKey } from './team.js'
import { L, isEn } from './lang.js'

// English mode: process-gpt's completion names a new instance with a Korean-only prompt (polling_service
// semantic_naming: "한국어 기준 30자 이내"), so an English process started in English gets a Korean name
// ("출장비 정산 …"). The instance keeps an English one instead: "<process> · <the first short value of the
// start form>", the same shape completion uses. Korean mode, and processes with Korean names, are left alone.
const HANGUL = /[가-힣]/
const englishNames = new Map() // instId -> name
function englishName(defName, values) {
  const v = Object.values(values || {}).map((x) => String(x ?? '').trim()).find((x) => x.length >= 2 && x.length <= 60 && !/^[\d\s.,:/-]+$/.test(x) && !HANGUL.test(x) && !x.includes('\n'))
  return v ? `${defName} · ${v}` : defName
}
async function keepEnglishName(instId) {
  const name = englishNames.get(instId)
  if (!name) return
  const [i] = await q('select proc_inst_name from bpm_proc_inst where proc_inst_id=$1', [instId]).catch(() => [])
  if (i && HANGUL.test(i.proc_inst_name || '')) await q('update bpm_proc_inst set proc_inst_name=$2 where proc_inst_id=$1', [instId, name]).catch(() => {})
}

async function complete(input) {
  const res = await fetch(`${config.completionUrl}/complete`, {
    method: 'POST',
    // completion takes the tenant from the first label of X-Forwarded-Host, not from input.tenant_id
    // (process-gpt main.py; a host with 'localhost' in it is the localhost tenant)
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-Host': `${config.tenantId}.process-gpt.local` },
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
  // a role whose endpoint is an agent keeps it; a person written into the definition (often the
  // modeller's own account, e.g. demo@localhost) is not a team assignment and does not count
  const ids = roles.flatMap((x) => [].concat(x.endpoint || [])).map(String).filter(Boolean)
  const agents = new Set(ids.length ? (await q('select id::text from users where is_agent and id::text = any($1)', [ids])).map((r) => r.id) : [])
  for (const x of roles) {
    const eps = [].concat(x.endpoint || []).map(String).filter(Boolean)
    if (eps.length && eps.every((e) => agents.has(e))) continue // agents keep their own endpoint
    const who = assigned[roleKey(x.name)] || me.id
    x.endpoint = [who]; x.default = [who]
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
  if (isEn() && def.name && !HANGUL.test(def.name)) {
    englishNames.set(instId, englishName(def.name, values))
    await keepEnglishName(instId)
  }
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
  await keepEnglishName(t.proc_inst_id)
  if (messageId) await updateMessage(me.id, messageId, { state: 'submitted' })
  emit(me.id, 'process', { instId: t.proc_inst_id, type: 'submitted' })
  watchInstance(me, t.proc_inst_id)
  return { ok: true }
}

// Where an instance lives for a person: its page (/projects/p/<instId>) and one conversation there (the
// instance page's, routes/process.js GET /instances/:id) — what started it (a mail, a schedule) and talk
// about it stay in that context. A step of mine is announced by the Home card process-gpt's todolist
// trigger makes (lib/notify.js), which opens that page; nothing is added to the main chat (2026-11-18:
// "전체 대화 목록에 어펜드되기보다는 해당 인스턴스 쪽에서 열리는 게 맞다").
export async function instanceThread(userId, instId, title = null) {
  let [t] = await q('select id from pro_threads where user_id=$1 and ref=$2 order by created_at limit 1', [userId, instId])
  if (!t) {
    const [i] = await q('select proc_inst_name from bpm_proc_inst where proc_inst_id=$1', [instId])
    ;[t] = await q(`insert into pro_threads(user_id,kind,title,ref) values ($1,'process',$2,$3) returning id`, [userId, title || i?.proc_inst_name || instId, instId])
  }
  return t.id
}

// A Home card that opens the instance page (started from a mail or a schedule, finished): the same
// notifications table, so process-gpt's bell and phone push carry it too.
export async function notifyInstance(userId, instId, { type, title, text }) {
  const { notifyUser } = await import('./notify.js')
  await notifyUser(userId, { type, title, text: text || '', url: `/projects/p/${instId}` })
}

// Follow an instance while it runs: push changes to the client and surface new work
// items assigned to the user (hark-style "needs your input", announceStep).
const watching = new Map()
export function watchInstance(me, instId) {
  if (watching.has(instId)) return
  let last = ''
  let idle = 0
  const tick = async () => {
    try {
      const [i] = await q('select status, current_activity_ids, updated_at from bpm_proc_inst where proc_inst_id=$1', [instId])
      const todos = await q(`select id, activity_id, activity_name, status, draft_status, user_id, agent_orch, updated_at from todolist where proc_inst_id=$1`, [instId])
      const sig = JSON.stringify([i?.status, i?.current_activity_ids, todos.map((t) => [t.id, t.status, t.draft_status])])
      if (sig !== last) {
        last = sig
        idle = 0
        await keepEnglishName(instId)
        // an open instance page (and its Home card) follow the change; a step of mine is the Home card's
        emit(me.id, 'process', { instId, type: 'changed', status: i?.status })
        if (i?.status === 'COMPLETED') {
          const [n] = await q('select proc_inst_name from bpm_proc_inst where proc_inst_id=$1', [instId])
          const name = n?.proc_inst_name || instId
          await notifyInstance(me.id, instId, { type: 'process_done', title: L(`완료 · ${name}`, `Done · ${name}`) })
        }
      } else idle++
      if (i?.status === 'COMPLETED' || idle > 360) return stop()
    } catch (e) { console.warn('[watch]', e.message) }
  }
  const stop = () => { clearInterval(watching.get(instId)); watching.delete(instId); englishNames.delete(instId) }
  watching.set(instId, setInterval(tick, 5000))
  tick()
}
