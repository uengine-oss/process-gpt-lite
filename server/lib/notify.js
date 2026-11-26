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
import { hideTodo } from './homeCards.js'
import { namesOf } from './people.js'
import { L, langOf, withLang } from './lang.js'
import * as PA from './pushActions.js'

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

// a step with several people — the engine writes them as one comma list (a draft step: 'agent,person') and the
// notification trigger copies that list as is — is each of theirs
const MINE = `(n.user_id = any($2) or string_to_array(replace(n.user_id, ' ', ''), ',') && $2::text[])`

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

// who a notice is from, by the name every screen shows (lib/people.js) — not Process GPT's username alone
async function fromNames(rows) {
  const names = await namesOf(rows.map((n) => n.from_id).filter(Boolean))
  for (const n of rows) if (n.from_id && names[n.from_id]) n.from_name = names[n.from_id]
}

export async function listFor(me) {
  const rows = await q(`select n.*, t.id as todo_id, t.status as todo_status, t.proc_inst_id, fu.id::text as from_id, fu.username as from_name
                        from notifications n
                        left join todolist t on n.url = '/todolist/' || t.id::text
                        left join users fu on fu.email = n.from_user_id and fu.tenant_id = n.tenant_id
                        where n.tenant_id=$1 and coalesce(n.is_checked,false)=false and ${MINE}
                        order by n.time_stamp desc limit 30`, [T(), ids(me)])
  await fromNames(rows)
  const out = []
  // a step of the company's process map that waits for its owner's 「진행」(단계마다 사람이 정함, lib/ontology/runmode.js) is not theirs yet —
  // left out, not checked off: it shows once the owner says go
  const held = await import('./ontology/runmode.js').then((m) => m.heldTodos(rows.map((n) => n.todo_id).filter(Boolean))).catch(() => new Set())
  for (const n of rows) {
    if (n.type?.startsWith('workitem') && n.todo_id && held.has(String(n.todo_id))) continue
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
    } else if (n.type === 'ai_ask') {
      // the AI waits on me (lib/askPerson.js): opens where it asks; a wait that is over (its card answered elsewhere, a server restart
      // that ended its task) is checked off, not listed
      const A = await import('./askPerson.js')
      const at = A.parseAskUrl(n.url)
      const card = at && await A.waitingCard(at)
      if (!card) { await q('update notifications set is_checked=true where id=$1', [n.id]); continue }
      out.push({ id: n.id, type: 'ai_ask', kind: A.kindOf(at, card), title: n.title, text: n.description, at: n.time_stamp, url: n.url, place: await A.placeOf(at.threadId, at.cardId) })
    } else {
      const from = n.type === 'chat' ? await senderOf(n) : n.from_user_id ? n.from_name || n.from_user_id : null
      out.push({ id: n.id, type: n.type, title: n.title, text: n.description, at: n.time_stamp, url: n.url, ...(from ? { from } : {}) })
    }
  }
  return out
}

async function own(me, id) {
  const [n] = await q(`select * from notifications n where id=$1 and tenant_id=$2 and ${MINE.replaceAll('$2', '$3')}`, [id, T(), ids(me)])
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
  // the AI's question: opened where it asks — answered there, not by opening it (the notice stays until then: lib/askPerson.js)
  if (n.type === 'ai_ask') {
    const A = await import('./askPerson.js')
    const at = A.parseAskUrl(n.url)
    return { place: at ? await A.placeOf(at.threadId, at.cardId) : '/chat' }
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
  // a work item's notice put away: its Home card goes with it — it used to come back as a 「Submit」 card
  // (the work item itself stays mine; 루틴 lists it)
  const todo = n && /^\/todolist\/([\w-]+)$/.exec(String(n.url || ''))?.[1]
  if (todo) await hideTodo(me.id, todo, n.title).catch((e) => console.warn('[notify] hide todo', e.message))
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
  // process-gpt's chat trigger writes its 'chat' notices with the tenant of the request's sign-in (tenant_id()): a message Lite's messenger
  // writes through its own connection has none, so the room's message never reached the Home or the phone (found 2026-11-26 — the dev
  // database's room notices were almost all without a tenant). The room's tenant is stamped on them here, minutes old at most.
  await q(`update notifications n set tenant_id = r.tenant_id from chat_rooms r where n.tenant_id is null and n.type = 'chat'
           and n.time_stamp > now() - interval '10 minutes' and n.url = '/chats?id=' || r.id and r.tenant_id = $1`, [T()]).catch(() => {})
  const rows = await q(`select u.id as uid, n.id, n.title, n.description, n.url, n.type, n.from_user_id, fu.id::text as from_id, fu.username as from_name, tl.proc_inst_id as inst_id, (max(n.time_stamp) over ())::text as newest from notifications n
                        left join users u on (u.id::text = any(string_to_array(replace(n.user_id, ' ', ''), ',')) or u.email = n.user_id) and u.tenant_id = n.tenant_id
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
  await fromNames(rows)
  for (const r of rows) if (r.type === 'chat') r.from = await senderOf(r)
  const { memberHere } = await import('./webpush.js')
  for (const [uid, list] of byUser) {
    // (an approved member of this company only — someone removed, or not admitted, hears nothing: review 11-26, PR #89)
    if (!(await memberHere(uid))) continue
    // rows name a person by id or by email
    const [u] = await q('select email from users where id::text=$1 and tenant_id=$2', [uid, T()]).catch(() => [])
    const mine = [uid, u?.email].filter(Boolean)
    const [c] = await q(`select count(*)::int as n from notifications where tenant_id=$1 and coalesce(is_checked,false)=false and user_id = any($2)`,
      [T(), mine]).catch(() => [])
    const payloads = await withLang(await langOf(uid), () => pushPayloads(uid, mine, list))
    for (const p of payloads.slice(-4)) await pushTo(uid, { ...p, badge: c?.n || list.length })
  }
}

// One person's new rows of this pass → what their devices show (2026-11-26 사용자: 「퀵하게 대화방에서 온 내용 혹은 ai의 후먼인더루프 등을
// 모바일에서 보게할 수 있나?」 — the Android shade showed KakaoTalk's rooms grouped, 「Claude의 질문이 있습니다」 with its buttons):
//   - a teammate's messages: one notification per room (its tag), replaced as more come — 「<방 이름> · 3」 over the last two lines
//     「김민수: …」, with 「답장」 (opens that room with the composer focused); a room the person has open in front is not shown (public/sw.js)
//   - a mention of me: its own notification, always
//   - the AI waiting on me (lib/askPerson.js): its question, and buttons that answer it (a signed, single-use token) or open it
//   - my own words never (process-gpt's trigger leaves the writer out; a notice that names me as its sender is dropped too)
export async function pushPayloads(uid, mine, list) {
  const { askPayload } = await import('./askPerson.js')
  const reply = { action: 'reply', title: L('답장', 'Reply') }
  const out = []
  for (const g of PA.groupForPush(list)) {
    if (g.room) { const p = await roomPayload(mine, g, reply); if (p) out.push(p); continue }
    const r = g.row
    if (r.from_user_id && mine.includes(r.from_user_id)) continue
    if (r.type === 'ai_ask') { const p = await askPayload(r, uid).catch((e) => { console.warn('[push] ask', e.message); return null }); if (p) out.push(p); continue }
    const room = PA.isMention(r) ? PA.roomOf(r.url) : null
    out.push({ id: r.id, type: r.type?.startsWith('workitem') ? 'workitem' : r.type, title: pushTitle(r), body: pushBody(r), url: r.url || null, instId: r.inst_id || null,
      ...(room ? { room, mention: true, tag: `pgl-${r.id}`, renotify: true, actions: [reply] } : {}) })
  }
  return out
}
// a room's notification: how many of its messages wait unread for me, and its last two
async function roomPayload(mine, g, reply) {
  const last = g.rows[g.rows.length - 1]
  const [waiting, [n]] = await Promise.all([
    q(`select title, from_user_id, url, description from notifications where tenant_id=$1 and type='chat' and url=$2 and user_id = any($3)
       and coalesce(is_checked,false)=false order by time_stamp desc limit 2`, [T(), last.url, mine]).catch(() => []),
    q(`select count(*)::int as n from notifications where tenant_id=$1 and user_id = any($2) and coalesce(is_checked,false)=false
       and ((type='chat' and url=$3) or (type='team' and url like $4)) and coalesce(from_user_id,'') <> all($2)`, [T(), mine, last.url, `/pro/team/${g.room}/%`]).catch(() => [{}]),
  ])
  // (read in the meantime — on another device, or the room opened: nothing to show)
  if (!waiting.length) return null
  const lines = []
  for (const w of waiting.reverse()) lines.push({ from: await senderOf(w), text: w.title })
  const shown = PA.roomNotice({ room: g.room, name: last.description || await roomPeople(g.room, mine), count: n?.n || waiting.length, lines })
  return { id: last.id, type: 'chat', url: last.url, count: n?.n || waiting.length, ...shown, actions: [reply] }
}
// a group room without a name of its own is called by its people (as the messenger calls it): 「박도윤, 김서연」 — a 1:1 room by its writer
async function roomPeople(room, mine) {
  const [r] = await q('select participants from chat_rooms where id=$1', [room]).catch(() => [])
  const others = (Array.isArray(r?.participants) ? r.participants : [])
    .filter((p) => p && !p.is_agent && p.id && p.id !== 'system_id' && !mine.includes(String(p.id)) && !mine.includes(p.email))
  if (others.length < 2) return null
  const names = await namesOf(others.map((p) => p.id)).catch(() => ({}))
  const list = others.map((p) => names[p.id] || p.username || String(p.email || '').split('@')[0]).filter(Boolean)
  return list.length > 3 ? `${list.slice(0, 3).join(', ')} ${L(`외 ${list.length - 3}명`, `+${list.length - 3}`)}` : list.join(', ')
}
export function startNotificationFeed() {
  setInterval(() => eachTenant(() => feedOnce().catch((e) => console.warn('[notify feed]', e.message))), 4000)
}
