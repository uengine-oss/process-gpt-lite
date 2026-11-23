// "Needs action" on Home, read from process-gpt's own `notifications` table: the todolist
// trigger writes one for whoever a step was assigned to, the process-gpt bell and FCM push read
// the same rows. pgpt-pro adds what hark shows on Home — one line of context and the step's
// choices as buttons, so a decision is made without opening the form — and a way to ask a
// teammate to look at something from chat.
import { config } from '../config.js'
import { q, eachTenant } from './supa.js'
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

// Who wrote a teammate's message (a 'chat' notice from process-gpt's chat trigger, which puts the writer's
// name in from_user_id): that, a member's name for an address, or — when the notice names no one — the
// writer of the room's newest message with that text. The Home card and the phone's notification said
// only 「process-gpt 채팅」 / 「새 메시지」 (2026-11-23: 「직원에게서 메시지를 받았을때 누구한테서 온건지가 표시가 없음」).
const writers = new Map() // room|text → writer (a message's writer does not change; kept for a while)
export async function senderOf(n) {
  if (n.from_name || n.from_user_id) return n.from_name || n.from_user_id
  const room = /^\/chats\?id=([\w.:-]+)/.exec(String(n.url || ''))?.[1]
  if (!room) return null
  const k = `${T()}|${room}|${n.title || ''}`
  if (writers.has(k)) return writers.get(k)
  const [m] = await q(`select coalesce(nullif(c.messages->>'name',''), u.username, c.messages->>'email') as who from chats c
                       left join users u on u.email = c.messages->>'email' and u.tenant_id = $3
                       where c.id=$1 and c.messages->>'content' = $2 order by public.pro_chat_ts(c.messages) desc limit 1`, [room, String(n.title || ''), T()]).catch(() => [])
  const who = m?.who || null
  if (who) { writers.set(k, who); if (writers.size > 500) writers.delete(writers.keys().next().value) }
  return who
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
      out.push({ id: n.id, type: 'workitem', title: n.title, process: n.description, at: n.time_stamp, todoId: n.todo_id, instId: n.proc_inst_id || null,
        context: n.proc_inst_id ? await contextLine(n.proc_inst_id) : '', choices: choicesOf(d?.form), role: d?.step?.role || '' })
    } else if (n.type === 'mention') {
      out.push({ id: n.id, type: 'mention', title: n.title, text: n.description, at: n.time_stamp, from: n.from_name || n.from_user_id })
    } else {
      const from = n.type === 'chat' ? await senderOf(n) : n.from_user_id ? n.from_name || n.from_user_id : null
      out.push({ id: n.id, type: n.type, title: n.title, text: n.description, at: n.time_stamp, url: n.url, ...(from ? { from } : {}) })
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

// A button on the card: submit the step with that choice, or open it (no choice) on its instance page,
// where the form is (InstanceHeader 「내 입력이 필요해요」) — no card is added to the chat.
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
    return { instId: d.todo.proc_inst_id }
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
// The position is the database's own text of the newest time_stamp: a JS Date keeps milliseconds
// and the column microseconds, so the newest row was "new" again on every pass.
const lastByTenant = new Map() // tenant -> newest time_stamp seen (timestamptz text)
export async function feedOnce() {
  const last = lastByTenant.get(T()) || new Date().toISOString()
  const rows = await q(`select u.id as uid, n.id, n.title, n.description, n.url, n.type, n.from_user_id, fu.username as from_name, tl.proc_inst_id as inst_id, (max(n.time_stamp) over ())::text as newest from notifications n
                        left join users u on (u.id::text = n.user_id or u.email = n.user_id) and u.tenant_id = n.tenant_id
                        left join users fu on fu.email = n.from_user_id and fu.tenant_id = n.tenant_id
                        left join todolist tl on n.url = '/todolist/' || tl.id::text
                        where n.tenant_id=$1 and n.time_stamp > $2::timestamptz and coalesce(n.is_checked,false)=false
                        order by n.time_stamp`, [T(), last])
  for (const uid of new Set(rows.map((r) => r.uid).filter(Boolean))) emit(uid, 'notifications', {})
  lastByTenant.set(T(), rows[0]?.newest || last)
  // the same rows as system notifications on the person's devices, even with Lite closed (lib/webpush.js);
  // the badge is how many Home cards wait
  pushRows(rows).catch((e) => console.warn('[push]', e.message))
  return rows.length
}
const pushBody = (r) => String(r.type === 'chat' ? r.title : (r.description || '')).replace(/\s+/g, ' ').slice(0, 160)
const pushTitle = (r) => String(r.type === 'chat' ? (r.from || '새 메시지') : r.type?.startsWith('workitem') ? `입력이 필요해요 · ${r.title}` : (r.title || 'process gpt')).slice(0, 120)
async function pushRows(rows) {
  const byUser = new Map()
  for (const r of rows) if (r.uid) (byUser.get(r.uid) || byUser.set(r.uid, []).get(r.uid)).push(r)
  if (!byUser.size) return
  const { pushTo } = await import('./webpush.js')
  for (const r of rows) if (r.type === 'chat') r.from = await senderOf(r)
  for (const [uid, list] of byUser) {
    // rows name a person by id or by email
    const [u] = await q('select email from users where id::text=$1 and tenant_id=$2', [uid, T()]).catch(() => [])
    const [c] = await q(`select count(*)::int as n from notifications where tenant_id=$1 and coalesce(is_checked,false)=false and user_id = any($2)`,
      [T(), [uid, u?.email].filter(Boolean)]).catch(() => [])
    for (const r of list.slice(-3)) await pushTo(uid, { id: r.id, type: r.type?.startsWith('workitem') ? 'workitem' : r.type, title: pushTitle(r), body: pushBody(r), url: r.url || null, instId: r.inst_id || null, badge: c?.n || list.length })
  }
}
export function startNotificationFeed() {
  setInterval(() => eachTenant(() => feedOnce().catch((e) => console.warn('[notify feed]', e.message))), 4000)
}
