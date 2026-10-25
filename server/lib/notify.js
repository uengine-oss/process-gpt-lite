// "Needs action" on Home, read from process-gpt's own `notifications` table: the todolist
// trigger writes one for whoever a step was assigned to, the process-gpt bell and FCM push read
// the same rows. pgpt-pro adds what hark shows on Home — one line of context and the step's
// choices as buttons, so a decision is made without opening the form — and a way to ask a
// teammate to look at something from chat.
import { config } from '../config.js'
import { q } from './supa.js'
import { emit } from './bus.js'
import { getTodo } from './processes.js'
import { submitTodo } from './engine.js'
import { mainThread, addMessage } from './store.js'

const T = () => config.tenantId
const ids = (me) => [me.id, me.email].filter(Boolean)

// One line of what the run found so far, for the card. A step's own gist field (접목 방안,
// 요약, 근거) from the last two finished steps reads best; otherwise the newest step's first plain
// sentence, markdown stripped. Identifiers, JSON and links are never the line.
const GIST = /fit_reason|summary|reason|rationale|gist/i
function sentence(v) {
  if (typeof v !== 'string' || /^\s*[{[]/.test(v)) return ''
  for (const line of v.split('\n')) {
    if (/^\s*#/.test(line)) continue // headings name the document, they do not say what it found
    const t = line.replace(/^[\s#>*\-|0-9.]+/, '').replace(/\*\*|`|\|/g, '').replace(/\s+/g, ' ').trim()
    if (t.length >= 20 && t.includes(' ') && !/https?:\/\//.test(t)) return t
  }
  return ''
}
async function contextLine(procInstId) {
  const rows = await q(`select activity_name, output from todolist where proc_inst_id=$1 and status='DONE' and output is not null
                        order by end_date desc nulls last limit 2`, [procInstId])
  const fields = (r) => Object.values(r.output || {}).flatMap((v) => (v && typeof v === 'object' ? Object.entries(v) : []))
  for (const r of rows) {
    const g = fields(r).find(([k, v]) => GIST.test(k) && sentence(v))
    if (g) return sentence(g[1]).slice(0, 140)
  }
  for (const r of rows) {
    for (const [, v] of fields(r)) {
      const t = sentence(v)
      if (t) return `${r.activity_name}: ${t}`.slice(0, 140)
    }
  }
  return ''
}

// The step's choices (first radio/select field) become the card's buttons.
function choicesOf(form) {
  const f = (form?.fields || []).find((x) => ['radio', 'select'].includes(x.type) && x.items?.length)
  if (!f) return null
  // items come either as {key, label} or as process-gpt's {"반영": "제품에 반영 — 구현 시도"}
  const opt = (it) => (it.key !== undefined ? { key: it.key, label: it.label ?? it.key } : { key: Object.keys(it)[0], label: Object.values(it)[0] })
  return { field: f.key, options: f.items.map(opt) }
}

export async function listFor(me) {
  const rows = await q(`select n.*, t.id as todo_id, t.status as todo_status, t.proc_inst_id, fu.username as from_name
                        from notifications n
                        left join todolist t on n.url = '/todolist/' || t.id::text
                        left join users fu on fu.email = n.from_user_id and fu.tenant_id = n.tenant_id
                        where n.tenant_id=$1 and coalesce(n.is_checked,false)=false and n.user_id = any($2)
                        order by n.time_stamp desc limit 30`, [T(), ids(me)])
  const out = []
  for (const n of rows) {
    if (n.type?.startsWith('workitem')) {
      // a step someone already finished (or that was cancelled) is no longer anyone's action
      if (n.todo_status && !['IN_PROGRESS', 'TODO', 'NEW'].includes(n.todo_status)) {
        await q('update notifications set is_checked=true where id=$1', [n.id])
        continue
      }
      const d = n.todo_id ? await getTodo(n.todo_id) : null
      out.push({ id: n.id, type: 'workitem', title: n.title, process: n.description, at: n.time_stamp, todoId: n.todo_id,
        context: n.proc_inst_id ? await contextLine(n.proc_inst_id) : '', choices: choicesOf(d?.form), role: d?.step?.role || '' })
    } else if (n.type === 'mention') {
      out.push({ id: n.id, type: 'mention', title: n.title, text: n.description, at: n.time_stamp, from: n.from_name || n.from_user_id })
    } else {
      out.push({ id: n.id, type: n.type, title: n.title, text: n.description, at: n.time_stamp, url: n.url, ...(n.from_user_id ? { from: n.from_name || n.from_user_id } : {}) })
    }
  }
  return out
}

async function own(me, id) {
  const [n] = await q('select * from notifications where id=$1 and tenant_id=$2 and user_id = any($3)', [id, T(), ids(me)])
  return n || null
}

// The process-gpt bell groups by url, so every unchecked row for the same thing is cleared.
async function check(n) {
  await q('update notifications set is_checked=true where tenant_id=$1 and url=$2 and user_id=$3', [T(), n.url, n.user_id])
}

// A button on the card: submit the step with that choice, or open it (no choice) in chat.
export async function act(me, id, { choice } = {}) {
  const n = await own(me, id)
  if (!n) return null
  if (n.type?.startsWith('workitem')) {
    const todoId = n.url.split('/').pop()
    const d = await getTodo(todoId)
    if (!d) { await check(n); return { done: true } }
    const c = choicesOf(d.form)
    if (choice && c) {
      await submitTodo({ me, todoId, values: { ...(d.values || {}), [c.field]: choice } })
      await check(n)
      return { submitted: true, choice }
    }
    const t = await mainThread(me.id)
    const m = await addMessage(me.id, t.id, 'agent', 'todo', { todoId, name: d.todo.activity_name, inst: d.instName })
    return { opened: m.id }
  }
  if (n.type === 'mention') {
    // the request lands in the recipient's own chat, where they can answer or act on it
    const t = await mainThread(me.id)
    await addMessage(me.id, t.id, 'agent', 'text', { text: `**${n.title}**\n\n${n.description || ''}` })
    await check(n)
    return { opened: true }
  }
  await check(n)
  return { done: true, thread: n.url?.startsWith('/pro/threads/') ? n.url.split('/').pop() : null }
}

export async function dismiss(me, id) {
  const n = await own(me, id)
  if (n) await check(n)
  return !!n
}

// Chat → a teammate: "이건 김민지님께 봐달라고 알려줘". Same table, type 'mention', so the
// process-gpt bell and phone push carry it too.
export async function notifyMember(me, member, { title, text }) {
  const [n] = await q(`insert into notifications(id,user_id,title,type,description,url,from_user_id,tenant_id)
                       values (gen_random_uuid(),$1,$2,'mention',$3,$4,$5,$6) returning id`,
  [member.id, title, text, `/pro/mention/${Date.now()}`, me.email, T()])
  emit(member.id, 'notifications', {})
  return n
}

// A result for one person (a scheduled skill run): same table, so the bell and push carry it too.
export async function notifyUser(userId, { type, title, text, url }) {
  await q(`insert into notifications(id,user_id,title,type,description,url,tenant_id) values (gen_random_uuid(),$1,$2,$3,$4,$5,$6)`,
    [userId, title, type, text, url, T()])
  emit(userId, 'notifications', {})
}

// New rows reach open clients without a reload: one tenant-wide check every few seconds,
// fanned out to the users the rows are for (rows may name a user by id or by email).
let last = new Date()
export function startNotificationFeed() {
  setInterval(async () => {
    try {
      const rows = await q(`select n.user_id, n.time_stamp, u.id as uid from notifications n
                            left join users u on (u.id::text = n.user_id or u.email = n.user_id) and u.tenant_id = n.tenant_id
                            where n.tenant_id=$1 and n.time_stamp > $2`, [T(), last])
      for (const r of rows) {
        if (r.time_stamp > last) last = r.time_stamp
        if (r.uid) emit(r.uid, 'notifications', {})
      }
    } catch (e) { console.warn('[notify feed]', e.message) }
  }, 4000)
}
