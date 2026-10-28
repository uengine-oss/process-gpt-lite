// Team messenger on process-gpt's own chat (계승): a thread is a process-gpt chat_rooms row and a message
// is a chats row, written in the shape process-gpt's frontend writes (ChatRoomPage handleSendMessage),
// so the same room opens in both UIs; agents in a room are ordinary participants (is_agent).
//   chat_rooms {id, name, participants:[{id,email,username,profile,agent_type,is_agent}],
//               message:{msg,type:'text',createdAt}, primary_agent_id, context:{…, pgpt:{kind,direct_key,assist}}}
//   chats      {uuid, id: room id, messages:{uuid, role, content, timeStamp, email, name, userName, userId,
//               mentionedUsers, pgpt:{kind, artifacts, context}}}
// process-gpt's chat_insert_trigger notifies the other people (type 'chat'); pgpt-pro adds a richer
// 'team' notification for shares and mentions. Live delivery: the pro_chats_notify trigger → LISTEN here.
import crypto from 'node:crypto'
import pg from 'pg'
import { config } from '../../config.js'
import { q } from '../supa.js'
import { tenants, withTenant } from '../tenant.js'
import { emit } from '../bus.js'
import { TeamError, isMember, people } from './access.js'
import { viewArtifacts } from './shares.js'
import { L, langOf } from '../lang.js'

const T = () => config.tenantId
const ROOM = /^[\w.:-]{1,120}$/
export const MAX_GROUP = 8
const iso = (d = new Date()) => new Date(d).toISOString()
const nameOf = (p) => p?.name || p?.username || p?.email?.split('@')[0] || L('팀원', 'Teammate')

// participants → people and agents (process-gpt's System participant is neither)
export function split(participants) {
  const all = Array.isArray(participants) ? participants : []
  const humans = all.filter((p) => p && !p.is_agent && p.id && p.id !== 'system_id' && /^[0-9a-f-]{36}$/i.test(String(p.id)))
  const agents = all.filter((p) => p && p.is_agent)
  return { humans, agents }
}
const participant = (u) => ({ id: u.id, email: u.email, username: u.name, profile: '/images/defaultUser.png', agent_type: null, is_agent: false })

async function users(ids) {
  if (!ids.length) return []
  return q('select id::text as id, email, username as name from users where tenant_id=$1 and id = any($2::uuid[])', [T(), ids])
}

export async function directThread(me, otherId) {
  const key = [me.id, otherId].sort().join(':')
  const [found] = await q(`select * from chat_rooms where tenant_id=$1 and context->'pgpt'->>'direct_key'=$2 limit 1`, [T(), key])
  if (found) return roomRow(found)
  const ps = await users([me.id, otherId])
  const [r] = await q(`insert into chat_rooms(id, participants, message, name, primary_agent_id, tenant_id, context)
                       values ($1,$2,$3,null,null,$4,$5) returning *`,
  [crypto.randomUUID(), JSON.stringify(ps.map(participant)), { msg: 'NEW', type: 'text', createdAt: iso() }, T(), { pgpt: { kind: 'direct', direct_key: key, assist: true } }])
  return roomRow(r)
}

export async function groupThread(me, ids, title) {
  const members = [...new Set([me.id, ...ids])]
  if (members.length > MAX_GROUP) throw new TeamError(400, L(`그룹 대화는 ${MAX_GROUP}명까지예요.`, `A group conversation has at most ${MAX_GROUP} people.`))
  const ps = await users(members)
  const [r] = await q(`insert into chat_rooms(id, participants, message, name, primary_agent_id, tenant_id, context)
                       values ($1,$2,$3,$4,null,$5,$6) returning *`,
  [crypto.randomUUID(), JSON.stringify(ps.map(participant)), { msg: 'NEW', type: 'text', createdAt: iso() }, String(title || '').slice(0, 60) || null, T(), { pgpt: { kind: 'group', assist: true } }])
  return roomRow(r)
}

function roomRow(r) {
  const { humans } = split(r.participants)
  const kind = r.context?.pgpt?.kind || (humans.length > 2 ? 'group' : 'direct')
  return { ...r, kind, title: r.name, assist: r.context?.pgpt?.assist !== false }
}

// the room, if I am one of its people; anything else is "not found"
export async function memberThread(me, roomId) {
  if (!ROOM.test(String(roomId || ''))) return null
  const [r] = await q(`select * from chat_rooms where id=$1 and tenant_id=$2 and participants @> $3::jsonb`, [roomId, T(), JSON.stringify([{ id: me.id }])])
  return r ? roomRow(r) : null
}

export async function membersOf(roomId) {
  const [r] = await q('select participants from chat_rooms where id=$1', [roomId])
  const { humans } = split(r?.participants)
  const reads = await q('select user_id::text as id, last_read_at from pro_chat_reads where room_id=$1', [roomId])
  const by = Object.fromEntries(reads.map((x) => [x.id, x.last_read_at]))
  return humans.map((p) => ({ id: p.id, name: nameOf(p), email: p.email, last_read_at: by[p.id] || null }))
}

// one chats row as one viewer sees it
export function view(viewerId, row, byEmail = {}) {
  const m = row.messages || {}
  const g = m.pgpt || {}
  const agent = m.role === 'assistant' || String(m.email || '').startsWith('agent:')
  const senderId = m.userId || byEmail[m.email]?.id || null
  // a meeting's record in the room (lib/meetings/record.js) is written by the meeting assistant
  const kind = agent ? (String(g.kind || '').startsWith('meeting') ? g.kind : 'agent') : g.kind && g.kind !== 'assist' ? g.kind : 'text'
  return {
    ...(g.meeting ? { meeting: g.meeting } : {}),
    id: row.uuid, threadId: row.id, kind, body: String(m.content || ''), at: m.timeStamp ? iso(typeof m.timeStamp === 'number' || /^\d+$/.test(m.timeStamp) ? Number(m.timeStamp) : m.timeStamp) : null,
    sender: { id: agent ? (g.by || null) : senderId, name: agent ? (g.byName || m.userName || m.name || L('에이전트', 'Agent')) : (m.userName || m.name || byEmail[m.email]?.name || L('팀원', 'Teammate')), agent },
    mine: !agent && senderId === viewerId, byMe: agent && g.by === viewerId,
    artifacts: viewArtifacts(viewerId, agent ? g.by : senderId, g.artifacts), context: g.context || null,
  }
}
const ORDER = 'coalesce(public.pro_chat_ts(messages), now())'

// rooms I am in with at least one other person (process-gpt agent-only rooms are not the messenger's)
export async function listThreads(me) {
  const rows = await q(`select r.*, coalesce(rd.last_read_at, 'epoch'::timestamptz) as last_read_at from chat_rooms r
      left join pro_chat_reads rd on rd.room_id=r.id and rd.user_id=$2
      where r.tenant_id=$1 and r.participants @> $3::jsonb
        and (select count(*) from jsonb_array_elements(r.participants) p where coalesce((p->>'is_agent')::boolean,false)=false and p->>'id' ~ '^[0-9a-f-]{36}$') >= 2
      limit 200`, [T(), me.id, JSON.stringify([{ id: me.id }])])
  const out = []
  for (const r0 of rows) {
    const r = roomRow(r0)
    const [last] = await q(`select uuid, messages from chats where id=$1 order by ${ORDER} desc limit 1`, [r.id])
    const [{ n }] = await q(`select count(*)::int n from chats where id=$1 and ${ORDER} > $2 and coalesce(messages->>'email','') <> $3`, [r.id, r0.last_read_at, me.email])
    const { humans } = split(r.participants)
    const others = humans.filter((p) => p.id !== me.id)
    const lm = last?.messages
    const at = lm ? (view(me.id, last).at) : r.message?.createdAt ? iso(typeof r.message.createdAt === 'number' ? r.message.createdAt : r.message.createdAt) : null
    out.push({
      id: r.id, kind: r.kind, title: r.name || others.map(nameOf).join(', ') || L('나', 'Me'), members: humans.map((p) => ({ id: p.id, name: nameOf(p) })),
      agents: split(r.participants).agents.map((a) => ({ id: a.id, name: a.username })), unread: n, updatedAt: at,
      last: lm ? { kind: lm.pgpt?.kind || (lm.role === 'assistant' ? 'agent' : 'text'), body: String(lm.content || '').slice(0, 80), mine: lm.email === me.email, at, files: (lm.pgpt?.artifacts || []).length } : null,
    })
  }
  return out.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0)).slice(0, 100)
}

async function emailMap(roomId) {
  const ms = await membersOf(roomId)
  return Object.fromEntries(ms.map((m) => [m.email, m]))
}

export async function messages(me, roomId, { before, limit = 80 } = {}) {
  const t = await memberThread(me, roomId)
  if (!t) throw new TeamError(404, L('대화를 찾지 못했어요.', "I couldn't find that conversation."))
  const rows = await q(`select uuid, id, messages from chats where id=$1 and coalesce(messages->>'__hidden','false') <> 'true'
                        and ($2::timestamptz is null or ${ORDER} < $2) order by ${ORDER} desc limit $3`, [t.id, before || null, Math.min(Number(limit) || 80, 200)])
  const members = await membersOf(t.id)
  const by = Object.fromEntries(members.map((m) => [m.email, m]))
  return { thread: { id: t.id, kind: t.kind, title: t.name, assist: t.assist, members: members.map((m) => ({ id: m.id, name: m.name, lastReadAt: m.last_read_at })) },
    messages: rows.reverse().map((r) => view(me.id, r, by)) }
}

// Write a message into a room I am in, as process-gpt's frontend would. Every other person must still be
// on the team. attach(recipients, chatUuid) makes the share grants once the row's id is known.
export async function post(me, roomId, { kind = 'text', body = '', context = null, attach, agent = null } = {}) {
  const t = await memberThread(me, roomId)
  if (!t) throw new TeamError(404, L('대화를 찾지 못했어요.', "I couldn't find that conversation."))
  const members = await membersOf(t.id)
  for (const m of members) if (!(await isMember(m.id))) throw new TeamError(403, L(`${m.name}님은 더 이상 팀원이 아니에요.`, `${m.name} is no longer a teammate.`))
  const uuid = crypto.randomUUID()
  const artifacts = attach ? await attach(members.filter((m) => m.id !== me.id), uuid, t.id) : []
  const files = artifacts.map((a) => a.name)
  const content = String(body || '').slice(0, 8000) || (files.length ? `📎 ${files.join(', ')}` : '')
  const pgptPart = kind === 'text' && !artifacts.length && !context ? undefined : { kind, artifacts, context, ...(agent || {}) }
  const msg = { uuid, clientUuid: uuid, role: 'user', content, timeStamp: iso(), email: me.email, name: me.name, userName: me.name, userId: me.id, mentionedUsers: [], ...(pgptPart ? { pgpt: pgptPart } : {}) }
  const [row] = await q(`insert into chats(uuid, id, messages, tenant_id) values ($1,$2,$3,$4) returning uuid, id, messages`, [uuid, t.id, msg, T()])
  // the room list preview, the way process-gpt writes it
  await q(`update chat_rooms set message=$2 where id=$1`, [t.id, { msg: content.slice(0, 50), type: 'text', createdAt: msg.timeStamp }])
  await q(`insert into pro_chat_reads(room_id,user_id,last_read_at) values ($1,$2,greatest(now(), $3::timestamptz)) on conflict (room_id,user_id) do update set last_read_at=excluded.last_read_at`, [t.id, me.id, msg.timeStamp])
  const by = Object.fromEntries(members.map((m) => [m.email, m]))
  for (const m of members) emit(m.id, 'team', { type: 'message', threadId: t.id, message: view(m.id, row, by) })
  if (kind === 'share' || kind === 'mention') await notifyMembers(me, t, row, kind, files, context, members.filter((m) => m.id !== me.id))
  return view(me.id, row, by)
}

async function notifyMembers(me, t, row, kind, files, context, recipients) {
  const ctx = context?.title ? ` · ${context.title.slice(0, 30)}${context.title.length > 30 ? '…' : ''}` : ''
  // each notice in its recipient's saved language (lib/lang.js)
  const words = (en) => ({
    title: kind === 'share'
      ? (en ? `${me.name} shared ${files[0] || 'an output'}${files.length > 1 ? ` and ${files.length - 1} more` : ''}` : `${me.name}님이 ${files[0] || '산출물'}${files.length > 1 ? ` 외 ${files.length - 1}개` : ''}를 공유했어요`)
      : (en ? `${me.name} mentioned you${ctx}` : `${me.name}님이 나를 언급했어요${ctx}`),
    text: [row.messages.content, files.length && kind !== 'share' ? `${en ? 'Outputs' : '산출물'}: ${files.join(', ')}` : ''].filter(Boolean).join('\n').slice(0, 600),
  })
  for (const r of recipients) {
    const { title, text } = words((await langOf(r.id)) === 'en')
    // process-gpt's chat trigger already made a plain 'chat' notice for this row: the 'team' one replaces it
    await q(`update notifications set is_checked=true where tenant_id=$1 and type='chat' and url=$2 and user_id = any($3) and title=$4 and coalesce(is_checked,false)=false`,
      [T(), `/chats?id=${t.id}`, [r.email, r.id], row.messages.content])
    await q(`insert into notifications(id,user_id,title,type,description,url,from_user_id,tenant_id)
             values (gen_random_uuid(),$1,$2,'team',$3,$4,$5,$6)`, [r.id, title.slice(0, 200), text, `/pro/team/${t.id}/${row.uuid}`, me.email, T()])
    emit(r.id, 'notifications', {})
  }
}

export async function markRead(me, roomId) {
  const t = await memberThread(me, roomId)
  if (!t) throw new TeamError(404, L('대화를 찾지 못했어요.', "I couldn't find that conversation."))
  // read up to the newest message (its timeStamp comes from whoever wrote it, whose clock may run ahead of the DB's)
  await q(`insert into pro_chat_reads(room_id,user_id,last_read_at)
           values ($1,$2,greatest(now(), (select max(public.pro_chat_ts(messages)) from chats where id=$1)))
           on conflict (room_id,user_id) do update set last_read_at=excluded.last_read_at`, [t.id, me.id])
  // process-gpt's own unread flag on my participant entry, and the bell/Home notices for this room
  await q(`update chat_rooms set participants = (select jsonb_agg(case when p->>'id'=$2 then p - 'isExistUnReadMessage' else p end) from jsonb_array_elements(participants) p) where id=$1`, [t.id, me.id])
  const n = await q(`update notifications set is_checked=true where tenant_id=$1 and user_id = any($2) and coalesce(is_checked,false)=false
                     and ((type='team' and url like $3) or (type='chat' and url=$4)) returning id`, [T(), [me.id, me.email], `/pro/team/${t.id}/%`, `/chats?id=${t.id}`])
  emit(me.id, 'team', { type: 'read', threadId: t.id })
  if (n.length) emit(me.id, 'notifications', {})
  return { ok: true }
}

export async function unread(me) {
  const rooms = await listThreads(me)
  const byThread = Object.fromEntries(rooms.filter((r) => r.unread).map((r) => [r.id, r.unread]))
  return { total: Object.values(byThread).reduce((s, n) => s + n, 0), byThread }
}

// "받은 편지함": what teammates shared with me or mentioned me in, newest first
export async function inbox(me) {
  const rows = await q(`select c.uuid, c.id, c.messages, coalesce(rd.last_read_at, 'epoch'::timestamptz) as last_read_at
                        from chats c join chat_rooms r on r.id=c.id and r.tenant_id=$1 and r.participants @> $3::jsonb
                        left join pro_chat_reads rd on rd.room_id=c.id and rd.user_id=$2
                        where c.messages->'pgpt'->>'kind' in ('share','mention') and coalesce(c.messages->>'email','') <> $4
                        order by coalesce(public.pro_chat_ts(c.messages), now()) desc limit 50`, [T(), me.id, JSON.stringify([{ id: me.id }]), me.email])
  const senders = await people([...new Set(rows.map((r) => r.messages.userId).filter(Boolean))])
  const by = Object.fromEntries(senders.map((p) => [p.email, p]))
  return rows.map((r) => { const v = view(me.id, r, by); return { ...v, unread: new Date(v.at) > new Date(r.last_read_at) } })
}

export async function message(me, uuid) {
  if (!ROOM.test(String(uuid || ''))) return null
  const [r] = await q('select uuid, id, messages from chats where uuid=$1 and tenant_id=$2', [uuid, T()])
  if (!r || !(await memberThread(me, r.id))) return null
  return view(me.id, r, await emailMap(r.id))
}

// ---- live delivery for rows written anywhere (process-gpt's UI, an agent, this server) ----
const listeners = new Set() // (row) => void   (lib/team/assist.js watches for requests)
export const onChat = (fn) => listeners.add(fn)
export function startRoomFeed() {
  let client, retry
  // a dropped connection (DB restart, recovery) is reopened; messages written meanwhile are still in
  // chats and load with the room — only their live push was missed
  const again = (why) => {
    if (retry) return
    console.warn('[rooms feed] reconnecting:', why)
    try { client?.removeAllListeners(); client?.end().catch(() => {}) } catch { /* already gone */ }
    retry = setTimeout(() => { retry = null; connect().catch((e) => again(e.message)) }, 3000)
  }
  const connect = async () => {
    client = new pg.Client(config.db)
    client.on('error', (e) => again(e.message))
    client.on('end', () => again('connection ended'))
    await client.connect()
    await client.query('listen pro_chats')
    client.on('notification', async (n) => {
      try {
        const { uuid, id } = JSON.parse(n.payload)
        const [row] = await q('select c.uuid, c.id, c.messages, r.participants, r.tenant_id from chats c join chat_rooms r on r.id=c.id where c.uuid=$1 and r.tenant_id = any($2)', [uuid, tenants()])
        if (!row) return
        await withTenant(row.tenant_id, async () => {
          const { humans } = split(row.participants)
          const by = Object.fromEntries(humans.map((p) => [p.email, { id: p.id, name: nameOf(p) }]))
          for (const p of humans) emit(p.id, 'team', { type: 'message', threadId: id, message: view(p.id, row, by) })
          for (const fn of listeners) fn(row, humans)
        })
      } catch (e) { console.warn('[rooms feed]', e.message) }
    })
  }
  connect().catch((e) => again(e.message))
}
