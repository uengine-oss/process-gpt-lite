// Team messenger on process-gpt's own chat (계승): a thread is a process-gpt chat_rooms row and a message
// is a chats row, written in the shape process-gpt's frontend writes (ChatRoomPage handleSendMessage),
// so the same room opens in both UIs; agents in a room are ordinary participants (is_agent).
//   chat_rooms {id, name, participants:[{id,email,username,profile,agent_type,is_agent}],
//               message:{msg,type:'text',createdAt}, primary_agent_id, context:{…, pgpt:{kind,direct_key,assist}}}
//   chats      {uuid, id: room id, messages:{uuid, role, content, timeStamp, email, name, userName, userId,
//               mentionedUsers, pgpt:{kind, artifacts, context}}}
// process-gpt's chat_insert_trigger notifies the other people (type 'chat'); pgpt-pro adds a richer
// 'team' notification for shares and mentions. Live delivery: a row written here goes at once (pushRow · deliver),
// a row written anywhere else through the pro_chats_notify trigger → LISTEN here (feedRow).
import crypto from 'node:crypto'
import pg from 'pg'
import { config } from '../../config.js'
import { q, pool } from '../supa.js'
import { watchedTenants, withTenant } from '../tenant.js'
import { emit } from '../bus.js'
import { TeamError, isMember, people } from './access.js'
import { viewArtifacts } from './shares.js'
import { L, langOf, withLang } from '../lang.js'
// file mentions on a message: each person sees them with their own access (lib/fileRefs.js decorate)
import { decorate, publicRef } from '../fileRefs.js'
// a mail mention keeps its summary only — the body is the owner's until they share it (lib/mailMention.js)
import { publicMailRef } from '../mailMention.js'
import { publicAttRef } from '../mailAttachments.js'
import { josa, ro } from '../josa.js'
// reactions on a message (lib/team/reactions.js — their own rows; 2026-11-26)
import * as RX from './reactions.js'
// who a person is on every screen: one name, one picture (lib/people.js) — not users.username, which Process GPT may hold as the
// address's local part (2026-11-25: a room's header listed the user by their address's local part where everything else used their name).
// Only for what the screens show: what is stored in Process GPT's rows (a room's participants, a message's mentionedUsers — its
// resolveMentions matches typed mentions against them) keeps Process GPT's own users.username.
import { people as resolvePeople } from '../people.js'

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
// a person in chat_rooms.participants, in Process GPT's shape (its normalizeParticipant): its own username and picture field
const participant = (u) => ({ id: u.id, email: u.email, username: u.name, profile: u.profile || '/images/defaultUser.png', agent_type: null, is_agent: false })

// (Process GPT's own names: the participants written into a new room — in the order they were chosen, the one who starts it first,
// so the room's title and header read the same each time)
async function users(ids) {
  if (!ids.length) return []
  return q('select id::text as id, email, username as name, profile from users where tenant_id=$1 and id = any($2::uuid[]) order by array_position($2::uuid[], id)', [T(), ids])
}
// a room's people with the names every screen shows (name), and the one the room itself holds (username: Process GPT's, for what
// is written back into its rows)
async function resolved(humans) {
  const by = await resolvePeople(humans.map((p) => p.id))
  return humans.map((p) => { const r = by.get(String(p.id)); return { ...p, name: r?.name || nameOf(p), username: nameOf(p), email: p.email || r?.email || null } })
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

// Invite teammates into a group room I am in (2026-11-25 「기존 단체 메신저 대화창에서 신규인원 초대가 가능해야」). A 1:1 room stays
// private: the screens offer 「단체방 만들기」 there (a new group with both and the ones picked — groupThread). The invited are this
// company's teammates (isMember: pro_team_members of this tenant, or behind the gateway its people), never agents; someone already in
// the room is left as is (inviting again does nothing). They are added to chat_rooms.participants in Process GPT's own shape — its
// users.username, as its participants dialog writes them — and see the room's whole history, as Process GPT shows a room (its
// getMessages reads chats by the room id alone). A system line says who invited whom (Process GPT shows role 'system' rows as notices);
// Process GPT's chat trigger notifies the room's people of it as of any message, and the invited get the richer 'team' notice instead.
// Every open messenger of the room (the invited too) hears of it at once ('room').
export async function invite(me, roomId, userIds) {
  const t = await memberThread(me, roomId)
  if (!t) throw new TeamError(404, L('대화를 찾지 못했어요.', "I couldn't find that conversation."))
  if (t.kind !== 'group') throw new TeamError(400, L('1:1 대화에는 초대할 수 없어요. 단체방을 만들어 초대해 주세요.', "You can't invite people into a one-to-one conversation. Make a group conversation for that."))
  const want = [...new Set((Array.isArray(userIds) ? userIds : []).map(String))].filter((id) => /^[0-9a-f-]{36}$/i.test(id) && id !== me.id).slice(0, MAX_GROUP)
  if (!want.length) throw new TeamError(400, L('초대할 팀원을 골라 주세요.', 'Please choose the teammates to invite.'))
  const inRoom = new Set(split(t.participants).humans.map((p) => String(p.id)))
  const fresh = want.filter((id) => !inRoom.has(id))
  if (!fresh.length) return { threadId: t.id, added: [], members: (await membersOf(t.id)).map(({ id, name, email }) => ({ id, name, email })) }
  for (const id of fresh) if (!(await isMember(id))) throw new TeamError(403, L('이 회사의 팀원만 초대할 수 있어요.', 'You can invite only teammates of this company.'))
  const rows = (await q(`select id::text as id, email, username as name, profile from users where tenant_id=$1 and id = any($2::uuid[]) and not coalesce(is_agent,false)
                         order by array_position($2::uuid[], id)`, [T(), fresh]))
  if (rows.length !== fresh.length) throw new TeamError(403, L('이 회사의 팀원만 초대할 수 있어요.', 'You can invite only teammates of this company.'))
  // appended under the row's lock: two invites at once add each person once, and only who this call added is announced
  let added = []
  const c = await pool.connect()
  try {
    await c.query('begin')
    const { rows: [cur] } = await c.query('select participants from chat_rooms where id=$1 and tenant_id=$2 for update', [t.id, T()])
    const have = new Set(split(cur?.participants).humans.map((p) => String(p.id)))
    added = rows.filter((u) => !have.has(u.id))
    if (have.size + added.length > MAX_GROUP) throw new TeamError(400, L(`그룹 대화는 ${MAX_GROUP}명까지예요.`, `A group conversation has at most ${MAX_GROUP} people.`))
    if (added.length) await c.query('update chat_rooms set participants = coalesce(participants, \'[]\'::jsonb) || $2::jsonb where id=$1', [t.id, JSON.stringify(added.map(participant))])
    await c.query('commit')
  } catch (e) { await c.query('rollback').catch(() => {}); throw e } finally { c.release() }
  const members = await membersOf(t.id)
  if (!added.length) return { threadId: t.id, added: [], members: members.map(({ id, name, email }) => ({ id, name, email })) }
  const shown = (id) => members.find((m) => m.id === id)?.name || added.find((u) => u.id === id)?.name || ''
  const invited = added.map((u) => ({ id: u.id, name: shown(u.id) }))
  const uuid = crypto.randomUUID()
  const names = invited.map((p) => p.name)
  const content = L(`${me.name}님이 ${names.map((n) => `${n}님`).join(', ')}을 초대했어요`, `${me.name} invited ${names.join(', ')}`)
  const msg = { uuid, clientUuid: uuid, role: 'system', content, timeStamp: iso(), email: me.email, name: me.name, userName: me.name, userId: me.id,
    pgpt: { kind: 'invite', by: me.id, byName: me.name, invited } }
  const [row] = await q('insert into chats(uuid, id, messages, tenant_id) values ($1,$2,$3,$4) returning uuid, id, messages', [uuid, t.id, msg, T()])
  await q('update chat_rooms set message=$2 where id=$1', [t.id, { msg: content.slice(0, 50), type: 'text', createdAt: msg.timeStamp }])
  await q(`insert into pro_chat_reads(room_id,user_id,last_read_at) values ($1,$2,greatest(now(), $3::timestamptz)) on conflict (room_id,user_id) do update set last_read_at=excluded.last_read_at`, [t.id, me.id, msg.timeStamp])
  await pushRow(row, members)
  for (const m of members) emit(m.id, 'team', { type: 'room', threadId: t.id, members: members.map(({ id, name, email }) => ({ id, name, email })) })
  await notifyInvited(me, t, row, added.map((u) => members.find((m) => m.id === u.id) || { id: u.id, email: u.email, name: u.name }))
  return { threadId: t.id, added: invited, members: members.map(({ id, name, email }) => ({ id, name, email })) }
}

// the invited: their room notice (Process GPT's 'chat' one for the system line) becomes a 'team' one that opens the room in Lite,
// in each one's saved language
async function notifyInvited(me, t, row, invited) {
  const room = t.name || ''
  for (const r of invited) {
    const en = (await langOf(r.id)) === 'en'
    const title = en ? `${me.name} invited you to a conversation${room ? ` · ${room}` : ''}` : `${me.name}님이 대화방에 초대했어요${room ? ` · ${room}` : ''}`
    await q(`update notifications set is_checked=true where tenant_id=$1 and type='chat' and url=$2 and user_id = any($3) and title=$4 and coalesce(is_checked,false)=false`,
      [T(), `/chats?id=${t.id}`, [r.email, r.id].filter(Boolean), row.messages.content]).catch(() => {})
    await q(`insert into notifications(id,user_id,title,type,description,url,from_user_id,tenant_id) values (gen_random_uuid(),$1,$2,'team',$3,$4,$5,$6)`,
      [r.id, title.slice(0, 200), row.messages.content, `/pro/team/${t.id}/${row.uuid}`, me.email, T()])
    emit(r.id, 'notifications', {})
  }
}

// A group room's name (2026-11-26 사용자 「대화방 설정으로 대화방 명칭 바꿀 수 있게」): any of its people may set it, as in Process GPT's own
// room settings (ChatRoomPage 「채팅방 이름 변경」 — any participant, no owner check; its field chat_rooms.name, at most 50 characters), so
// both UIs show the same name. Empty takes the name off: the room is called by its people again (Process GPT ignores an empty name; here it
// is the way back). A 1:1 room is not renamed: it is called by the other person, which differs for each of the two — one shared name
// would replace both, so only group rooms take a name. Process GPT's AI room naming is told to leave the room alone (auto_name_pending).
// A system line says who named it (role 'system', Process GPT shows it as a notice), every open messenger of the room hears of it at once
// ('room' + the line). Quiet: Process GPT's chat trigger makes a 'chat' notice of the line for the others — checked in the same
// transaction, so no Home card, bell or push comes of a rename; the line does not count as unread either.
export const NAME_MAX = 50
// what a typed name becomes: control and format characters (line breaks, direction marks and overrides, zero-width ones — a name
// must not turn the line around it backwards or look blank) are spaces, except a zero-width joiner inside an emoji sequence; runs of
// spaces one, trimmed; '' → null. Not text, or too long → throws.
const JOINED = /(\p{Extended_Pictographic}\uFE0F?)\u200D(?=\p{Extended_Pictographic})/gu
export function cleanName(v) {
  if (v !== null && v !== undefined && typeof v !== 'string') throw new TeamError(400, L('대화방 이름은 글자로 보내 주세요.', "A conversation's name must be text."))
  const s = String(v ?? '').replace(JOINED, '$1\u0001').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (c) => (c === '\u0001' ? c : ' ')).replace(/\u0001/g, '\u200D').replace(/\s+/g, ' ').trim()
  if ([...s].length > NAME_MAX) throw new TeamError(400, L(`대화방 이름은 ${NAME_MAX}자까지예요.`, `A conversation's name has at most ${NAME_MAX} characters.`))
  return s || null
}
export async function rename(me, roomId, value) {
  const t = await memberThread(me, roomId)
  if (!t) throw new TeamError(404, L('대화를 찾지 못했어요.', "I couldn't find that conversation."))
  if (t.kind !== 'group') throw new TeamError(400, L('1:1 대화는 상대의 이름으로 보여요. 이름은 단체방에서 바꿀 수 있어요.', 'A one-to-one conversation is called by the other person. Only a group conversation takes a name.'))
  const name = cleanName(value)
  const was = t.name ? String(t.name) : null
  if (name === was) return { threadId: t.id, name, changed: false }
  const uuid = crypto.randomUUID()
  const content = name ? L(`${me.name}님이 대화방 이름을 「${name}」${ro(name)} 바꿨어요`, `${me.name} renamed the conversation to “${name}”`)
    : L(`${me.name}님이 대화방 이름을 지웠어요`, `${me.name} removed the conversation's name`)
  const msg = { uuid, clientUuid: uuid, role: 'system', content, timeStamp: iso(), email: me.email, name: me.name, userName: me.name, userId: me.id,
    pgpt: { kind: 'rename', by: me.id, byName: me.name, name, was } }
  const members0 = await membersOf(t.id)
  let row
  const c = await pool.connect()
  try {
    await c.query('begin')
    await c.query(`update chat_rooms set name=$3, message=$4, context = coalesce(context, '{}'::jsonb) || '{"auto_name_pending": false}'::jsonb
                   where id=$1 and tenant_id=$2`, [t.id, T(), name, { msg: content.slice(0, 50), type: 'text', createdAt: msg.timeStamp }])
    ;({ rows: [row] } = await c.query('insert into chats(uuid, id, messages, tenant_id) values ($1,$2,$3,$4) returning uuid, id, messages', [uuid, t.id, msg, T()]))
    // (Process GPT's trigger wrote a 'chat' notice of the line for each of the others: checked before anyone can read it unchecked)
    await c.query(`update notifications set is_checked=true where type='chat' and url=$1 and title=$2 and coalesce(is_checked,false)=false and user_id = any($3)`,
      [`/chats?id=${t.id}`, content, members0.flatMap((m) => [m.email, m.id]).filter(Boolean)])
    await c.query(`insert into pro_chat_reads(room_id,user_id,last_read_at) values ($1,$2,greatest(now(), $3::timestamptz)) on conflict (room_id,user_id) do update set last_read_at=greatest(pro_chat_reads.last_read_at, excluded.last_read_at)`, [t.id, me.id, msg.timeStamp])
    await c.query('commit')
  } catch (e) { await c.query('rollback').catch(() => {}); throw e } finally { c.release() }
  const members = await membersOf(t.id)
  await pushRow(row, members)
  for (const m of members) emit(m.id, 'team', { type: 'room', threadId: t.id, name, members: members.map(({ id, name: n, email }) => ({ id, name: n, email })) })
  return { threadId: t.id, name, changed: true }
}

// Put or take off one of my reactions on a message (lib/team/reactions.js): the room check is this module's
export const react = (me, messageId, key, on) => RX.react(me, messageId, key, on, { memberThread, membersOf })

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
  return (await resolved(humans)).map((p) => ({ id: p.id, name: p.name, username: p.username, email: p.email, last_read_at: by[p.id] || null }))
}

// An agent's row is named after the person it works for, in the viewer's language (L: the request's, or
// the reader's for a live push) — not in the words stored with the row, which are its starter's
// ("사토 유키's agent" on a Korean screen). The person's name: the room's member, else the stored label.
const OWNER_LABEL = /^(.*?)(?:님의 에이전트|'s agent)$/
const memberOf = (byEmail, id) => (id ? Object.values(byEmail).find((p) => p && String(p.id) === String(id)) : null) || null
// whose agent it is: the room's member (the resolved name), else the name in the stored label
const ownerName = (g, byEmail) => memberOf(byEmail, g?.by)?.name || OWNER_LABEL.exec(String(g?.byName || '').trim())?.[1] || null
export function agentLabel(g, byEmail = {}) {
  const owner = ownerName(g, byEmail)
  return owner ? L(`${owner}님의 에이전트`, `${owner}'s agent`) : null
}

// one chats row as one viewer sees it
export function view(viewerId, row, byEmail = {}) {
  const m = row.messages || {}
  const g = m.pgpt || {}
  const agent = m.role === 'assistant' || String(m.email || '').startsWith('agent:')
  const senderId = m.userId || byEmail[m.email]?.id || null
  // a person's message: the name the room's member goes by now, not the one stored with the row
  const member = memberOf(byEmail, senderId) || byEmail[m.email] || null
  // someone invited people into the room (invite below): said in the viewer's language, with the names every screen uses
  if (g.kind === 'invite' && Array.isArray(g.invited)) {
    const by = memberOf(byEmail, g.by)?.name || g.byName || L('팀원', 'Teammate')
    const who = g.invited.map((p) => memberOf(byEmail, p.id)?.name || p.name).filter(Boolean)
    return { id: row.uuid, threadId: row.id, kind: 'invite', at: m.timeStamp ? iso(m.timeStamp) : null, mine: g.by === viewerId,
      sender: { id: g.by || null, name: by, agent: false }, invited: g.invited.map((p) => ({ id: p.id, name: memberOf(byEmail, p.id)?.name || p.name })),
      body: L(`${by}님이 ${who.map((n) => `${n}님`).join(', ')}을 초대했어요`, `${by} invited ${who.join(', ')}`), artifacts: [], context: null }
  }
  // the room was named or its name taken off (rename above): said in the viewer's language, by the name every screen uses
  if (g.kind === 'rename') {
    const by = memberOf(byEmail, g.by)?.name || g.byName || L('팀원', 'Teammate')
    const nm = g.name ? String(g.name) : null
    return { id: row.uuid, threadId: row.id, kind: 'rename', at: m.timeStamp ? iso(m.timeStamp) : null, mine: g.by === viewerId,
      sender: { id: g.by || null, name: by, agent: false }, name: nm,
      body: nm ? L(`${by}님이 대화방 이름을 「${nm}」${ro(nm)} 바꿨어요`, `${by} renamed the conversation to “${nm}”`) : L(`${by}님이 대화방 이름을 지웠어요`, `${by} removed the conversation's name`),
      artifacts: [], context: null }
  }
  // a meeting's record in the room (lib/meetings/record.js) is written by the meeting assistant
  const kind = agent ? (String(g.kind || '').startsWith('meeting') ? g.kind : 'agent') : g.kind && g.kind !== 'assist' ? g.kind : 'text'
  return {
    ...(g.meeting ? { meeting: g.meeting } : {}),
    id: row.uuid, threadId: row.id, kind, body: String(m.content || ''), at: m.timeStamp ? iso(typeof m.timeStamp === 'number' || /^\d+$/.test(m.timeStamp) ? Number(m.timeStamp) : m.timeStamp) : null,
    // the messenger's @AI answers as 「AI」 (lib/team/aiHelp.js), not as someone's agent
    // an agent's row: its owner (g.by) — the screens show the owner's face with the agent's mark; the messenger's @AI is 「AI」
    sender: { id: agent ? (g.by || null) : senderId, name: agent ? (g.ai ? 'AI' : agentLabel(g, byEmail) || g.byName || m.userName || m.name || L('에이전트', 'Agent')) : (member?.name || m.userName || m.name || L('팀원', 'Teammate')), agent,
      ...(g.ai && agent ? { ai: true } : {}), ...(agent && !g.ai && g.by ? { owner: { id: String(g.by), name: ownerName(g, byEmail) } } : {}) },
    mine: !agent && senderId === viewerId, byMe: agent && g.by === viewerId,
    artifacts: viewArtifacts(viewerId, agent ? g.by : senderId, g.artifacts), context: g.context || null,
    // file mentions (links to shared folders' files): their state for this viewer comes with decorate()
    // (a mail · a mail's attachment: what every viewer gets — never a body, a key or an address)
    ...(Array.isArray(g.refs) && g.refs.length ? { refs: g.refs.map((r) => (r?.type === 'mail' ? publicMailRef(r) : r?.type === 'mailatt' ? publicAttRef(r) : { ...publicRef(r), folderId: r.folderId })) } : {}),
    // a message addressed to the AI (「@AI …」) and the AI's own answer to it
    ...(g.ai && !agent ? { toAi: true } : {}),
    // a mail its owner's rule posted as it arrived (lib/mailRooms.js): the rule's words
    ...(g.auto && !agent ? { auto: { by: String(g.auto.by || ''), label: String(g.auto.label || '') } } : {}),
  }
}
// each viewer's copy of a row: their view, with the state of its file mentions
export const viewFor = async (viewer, row, by) => decorate(viewer, view(viewer.id, row, by))
const ORDER = 'coalesce(public.pro_chat_ts(messages), now())'

// rooms I am in with at least one other person (process-gpt agent-only rooms are not the messenger's)
export async function listThreads(me) {
  const rows = await q(`select r.*, coalesce(rd.last_read_at, 'epoch'::timestamptz) as last_read_at from chat_rooms r
      left join pro_chat_reads rd on rd.room_id=r.id and rd.user_id=$2
      where r.tenant_id=$1 and r.participants @> $3::jsonb
        and (select count(*) from jsonb_array_elements(r.participants) p where coalesce((p->>'is_agent')::boolean,false)=false and p->>'id' ~ '^[0-9a-f-]{36}$') >= 2
      limit 200`, [T(), me.id, JSON.stringify([{ id: me.id }])])
  const out = []
  const names = await resolvePeople(rows.flatMap((r) => split(r.participants).humans.map((p) => p.id)))
  const nm = (p) => names.get(String(p.id))?.name || nameOf(p)
  for (const r0 of rows) {
    const r = roomRow(r0)
    const [last] = await q(`select uuid, messages from chats where id=$1 order by ${ORDER} desc limit 1`, [r.id])
    // (a rename's line is not news: it does not count — rename above)
    const [{ n }] = await q(`select count(*)::int n from chats where id=$1 and ${ORDER} > $2 and coalesce(messages->>'email','') <> $3
                             and coalesce(messages->'pgpt'->>'kind','') <> 'rename'`, [r.id, r0.last_read_at, me.email])
    const { humans } = split(r.participants)
    const others = humans.filter((p) => p.id !== me.id)
    const lm = last?.messages
    const at = lm ? (view(me.id, last).at) : r.message?.createdAt ? iso(typeof r.message.createdAt === 'number' ? r.message.createdAt : r.message.createdAt) : null
    out.push({
      // (members with their address: the screens tell same-named people apart by it — src/sameNames.js)
      id: r.id, kind: r.kind, title: r.name || others.map(nm).join(', ') || L('나', 'Me'), members: humans.map((p) => ({ id: p.id, name: nm(p), email: p.email || null })),
      agents: split(r.participants).agents.map((a) => ({ id: a.id, name: a.username })), unread: n, updatedAt: at,
      // (a rename's line in the reader's language, as the room shows it)
      last: lm ? { kind: lm.pgpt?.kind || (lm.role === 'assistant' ? 'agent' : 'text'), body: String(lm.pgpt?.kind === 'rename' ? view(me.id, last, Object.fromEntries(humans.map((p) => [p.email, { id: p.id, name: nm(p) }]))).body : lm.content || '').slice(0, 80),
        mine: lm.email === me.email, at, files: (lm.pgpt?.artifacts || []).length } : null,
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
  const list = await Promise.all(rows.reverse().map((r) => viewFor(me, r, by)))
  // each message's reactions as I see them (lib/team/reactions.js) — [] when none: a copy that comes live carries no reactions (the
  // screen keeps the ones it has), this one says what they are now
  const rx = await RX.forMessages(me.id, t.id, list.map((m) => m.id))
  for (const m of list) m.reactions = rx.get(m.id) || []
  // (reactions: false — this database has no reactions yet, sql/062: the screen offers none — lib/team/reactions.js available)
  return { thread: { id: t.id, kind: t.kind, title: t.name, assist: t.assist, reactions: await RX.available().catch(() => false), members: members.map((m) => ({ id: m.id, name: m.name, email: m.email || null, lastReadAt: m.last_read_at })) },
    messages: list }
}

// Write a message into a room I am in, as process-gpt's frontend would. Every other person must still be
// on the team. attach(recipients, chatUuid) makes the share grants once the row's id is known.
// refs: file mentions already checked as the sender (lib/fileRefs.js forSend); ai: addressed to the AI (「@AI …」, answered by
// lib/team/aiHelp.js — the room's general AI 제안 leaves it alone); mentions: the people named with @ (process-gpt's mentionedUsers);
// auto: a mail its owner's rule posted as it arrived ({by, label} — lib/mailRooms.js autoShare; what it says only, the owner's card decides)
export async function post(me, roomId, { kind = 'text', body = '', context = null, attach, agent = null, refs = [], ai = false, mentions = [], auto = null } = {}) {
  const t = await memberThread(me, roomId)
  if (!t) throw new TeamError(404, L('대화를 찾지 못했어요.', "I couldn't find that conversation."))
  const members = await membersOf(t.id)
  for (const m of members) if (!(await isMember(m.id))) throw new TeamError(403, L(`${m.name}님은 더 이상 팀원이 아니에요.`, `${m.name} is no longer a teammate.`))
  const uuid = crypto.randomUUID()
  const artifacts = attach ? await attach(members.filter((m) => m.id !== me.id), uuid, t.id) : []
  const files = artifacts.map((a) => a.name)
  const linked = (refs || []).map((r) => r.name)
  // (a mail mention says its subject — the summary everyone in the room sees anyway, never its body)
  const content = String(body || '').slice(0, 8000) || (files.length || linked.length ? `${kind === 'mailref' ? '✉️' : '📎'} ${[...files, ...linked].join(', ')}` : '')
  const pgptPart = kind === 'text' && !artifacts.length && !context && !refs?.length && !ai ? undefined
    : { kind, artifacts, context, ...(refs?.length ? { refs } : {}), ...(ai ? { ai: true } : {}), ...(auto ? { auto: { by: String(auto.by || ''), label: String(auto.label || '').slice(0, 200) } } : {}), ...(agent || {}) }
  const named = (mentions || []).map(String).filter((id) => members.some((x) => x.id === id && x.id !== me.id))
  const msg = { uuid, clientUuid: uuid, role: 'user', content, timeStamp: iso(), email: me.email, name: me.name, userName: me.name, userId: me.id,
    // (Process GPT's own name: its resolveMentions matches typed mentions against it)
    mentionedUsers: members.filter((x) => named.includes(x.id)).map((x) => ({ id: x.id, email: x.email, username: x.username })), ...(pgptPart ? { pgpt: pgptPart } : {}) }
  const [row] = await q(`insert into chats(uuid, id, messages, tenant_id) values ($1,$2,$3,$4) returning uuid, id, messages`, [uuid, t.id, msg, T()])
  // the room list preview, the way process-gpt writes it
  await q(`update chat_rooms set message=$2 where id=$1`, [t.id, { msg: content.slice(0, 50), type: 'text', createdAt: msg.timeStamp }])
  await q(`insert into pro_chat_reads(room_id,user_id,last_read_at) values ($1,$2,greatest(now(), $3::timestamptz)) on conflict (room_id,user_id) do update set last_read_at=excluded.last_read_at`, [t.id, me.id, msg.timeStamp])
  const by = Object.fromEntries(members.map((m) => [m.email, m]))
  // (the message is in the room from here on: delivering it and telling the members may fail — say so in the log — but the send stands,
  // so a caller does not take it back or send it twice — lib/mailRooms.js, PR #100 review)
  const told = async (what, fn) => { try { await fn() } catch (e) { console.warn(`[rooms] ${what}`, e.message) } }
  await told('push', () => pushRow(row, members))
  // (a mail's attachment mentioned alone — lib/mailAttachments.js — is said as one: its name, the summary everyone sees; a mail sent with its
  // attachments — lib/mailRooms.js — is one mail, not one mail and N more)
  const attachment = !!refs?.length && refs.every((r) => r.type === 'mailatt')
  const subjects = kind === 'mailref' && refs.some((r) => r.type === 'mail') ? refs.filter((r) => r.type === 'mail').map((r) => r.name) : [...files, ...linked]
  if (kind === 'share' || kind === 'mention' || kind === 'fileref' || kind === 'mailref') await told('notify', () => notifyMembers(me, t, row, kind, subjects, context, members.filter((m) => m.id !== me.id), { attachment }))
  return viewFor(me, row, by)
}

// A row written as the AI (process-gpt's agent shape, like routes/teamAssist.js agentRow), to everyone in the room at once with
// their own view (pushRow: a server without the room feed — PRO_BACKGROUND=0 — still delivers it, and the feed's copy is dropped)
export async function postAgent(roomId, { content, pgpt, uuid = crypto.randomUUID() }) {
  const msg = { uuid, id: 'process-gpt-agent', name: 'Process GPT Agent', role: 'assistant', email: 'agent:process-gpt-agent', agentId: 'process-gpt-agent',
    userName: 'Process GPT Agent', profile: '/images/chat-icon.png', content: String(content || '').slice(0, 8000), timeStamp: iso(), pgpt }
  const [row] = await q('insert into chats(uuid, id, messages, tenant_id, thread_id) values ($1,$2,$3,$4,$2) returning uuid, id, messages', [uuid, roomId, msg, T()])
  await q(`update chat_rooms set message=$2 where id=$1`, [roomId, { msg: msg.content.slice(0, 50), type: 'text', createdAt: msg.timeStamp }])
  await pushRow(row, await membersOf(roomId))
  return row
}

async function notifyMembers(me, t, row, kind, files, context, recipients, { attachment = false } = {}) {
  const ctx = context?.title ? ` · ${context.title.slice(0, 30)}${context.title.length > 30 ? '…' : ''}` : ''
  // each notice in its recipient's saved language (lib/lang.js)
  const words = (en) => ({
    title: kind === 'mailref' && attachment
      ? (en ? `${me.name} mentioned the mail attachment "${files[0] || ''}"${files.length > 1 ? ` and ${files.length - 1} more` : ''}` : `${me.name}님이 메일 첨부 「${files[0] || ''}」${files.length > 1 ? ` 외 ${files.length - 1}개${josa('개', '을', '를')}` : josa(`${files[0] || ''}」`, '을', '를')} 멘션했어요`)
      : kind === 'mailref'
      ? (en ? `${me.name} mentioned the mail "${files[0] || ''}"${files.length > 1 ? ` and ${files.length - 1} more` : ''}` : `${me.name}님이 메일 「${files[0] || ''}」${files.length > 1 ? ` 외 ${files.length - 1}통${josa('통', '을', '를')}` : josa(`${files[0] || ''}」`, '을', '를')} 멘션했어요`)
      : kind === 'fileref'
      ? (en ? `${me.name} linked ${files[0] || 'a file'}${files.length > 1 ? ` and ${files.length - 1} more` : ''}` : `${me.name}님이 ${files[0] || '파일'}${files.length > 1 ? ` 외 ${files.length - 1}개` : ''}를 링크로 멘션했어요`)
      : kind === 'share'
      ? (en ? `${me.name} shared ${files[0] || 'an output'}${files.length > 1 ? ` and ${files.length - 1} more` : ''}` : `${me.name}님이 ${files[0] || '산출물'}${files.length > 1 ? ` 외 ${files.length - 1}개` : ''}를 공유했어요`)
      : (en ? `${me.name} mentioned you${ctx}` : `${me.name}님이 나를 언급했어요${ctx}`),
    text: [row.messages.content, files.length && kind !== 'share' ? `${kind === 'mailref' ? (en ? 'Mail' : '메일') : kind === 'fileref' ? (en ? 'Linked files' : '링크한 파일') : en ? 'Outputs' : '산출물'}: ${files.join(', ')}` : ''].filter(Boolean).join('\n').slice(0, 600),
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
                        where c.messages->'pgpt'->>'kind' in ('share','mention','fileref','mailref') and coalesce(c.messages->>'email','') <> $4
                        order by coalesce(public.pro_chat_ts(c.messages), now()) desc limit 50`, [T(), me.id, JSON.stringify([{ id: me.id }]), me.email])
  const senders = await people([...new Set(rows.map((r) => r.messages.userId).filter(Boolean))])
  const by = Object.fromEntries(senders.map((p) => [p.email, p]))
  return Promise.all(rows.map(async (r) => { const v = await viewFor(me, r, by); return { ...v, unread: new Date(v.at) > new Date(r.last_read_at) } }))
}

export async function message(me, uuid) {
  if (!ROOM.test(String(uuid || ''))) return null
  const [r] = await q('select uuid, id, messages from chats where uuid=$1 and tenant_id=$2', [uuid, T()])
  if (!r || !(await memberThread(me, r.id))) return null
  return viewFor(me, r, await emailMap(r.id))
}

// ---- live delivery for rows written anywhere (process-gpt's UI, an agent, this server) ----
// One chats row to each of the room's people, in their own language — the one way a row reaches open conversations:
// a message sent here (post), a meeting's record written here (lib/meetings/record.js: the card, 회의 자료, 회의록 —
// deliver), and rows written anywhere else (the room feed below). A row goes once per content: the feed's copy of a
// row this server already delivered is dropped, and the other way round (before, a sent message came twice).
const sentRows = new Map() // chats uuid -> the content last delivered (its messages, hashed)
const SENT_KEEP = 2000
const contentOf = (row) => crypto.createHash('sha1').update(JSON.stringify(row.messages ?? null)).digest('base64')
export async function pushRow(row, people) {
  const c = contentOf(row)
  if (sentRows.get(row.uuid) === c) return false
  sentRows.delete(row.uuid)
  sentRows.set(row.uuid, c)
  if (sentRows.size > SENT_KEEP) sentRows.delete(sentRows.keys().next().value)
  const ps = await resolved(people)
  const by = Object.fromEntries(ps.map((p) => [p.email, { id: p.id, name: p.name }]))
  // (each person's copy: their language, and the file mentions in their own access — lib/fileRefs.js decorate)
  for (const p of ps) emit(p.id, 'team', { type: 'message', threadId: row.id, message: await withLang(await langOf(p.id), () => viewFor({ id: p.id, email: p.email, name: p.name }, row, by)) })
  return true
}
// a row this server just wrote into a room (inserted or updated), to the room's people at once — not left to the
// room feed, which a development server (PRO_BACKGROUND=0) does not run and which can be reconnecting
export async function deliver(uuid) {
  try {
    const [row] = await q('select c.uuid, c.id, c.messages, r.participants from chats c join chat_rooms r on r.id=c.id where c.uuid=$1', [uuid])
    return row ? await pushRow(row, split(row.participants).humans) : false
  } catch (e) { console.warn('[rooms] deliver', e.message); return false }
}

const listeners = new Set() // (row) => void   (lib/team/assist.js watches for requests)
export const onChat = (fn) => listeners.add(fn)
// a row the feed heard of: its room's people get it (unless this server already sent this content), the watchers see it.
// Only rooms of the tenants this server serves — behind the ProcessGPT gateway every tenant that uses Lite; until
// 2026-11-24 only the default one there, so in a company's room nothing written by the meeting assistant or an agent
// came live (the minutes showed only after the conversation was opened again).
export async function feedRow(uuid) {
  const [row] = await q('select c.uuid, c.id, c.messages, r.participants, r.tenant_id from chats c join chat_rooms r on r.id=c.id where c.uuid=$1 and r.tenant_id = any($2)', [uuid, await watchedTenants()])
  if (!row) return false
  return withTenant(row.tenant_id, async () => {
    const { humans } = split(row.participants)
    const sent = await pushRow(row, humans)
    for (const fn of listeners) fn(row, humans)
    return sent
  })
}
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
      try { await feedRow(JSON.parse(n.payload).uuid) } catch (e) { console.warn('[rooms feed]', e.message) }
    })
  }
  connect().catch((e) => again(e.message))
}
