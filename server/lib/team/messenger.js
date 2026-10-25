// Team messenger: 1:1 and small group threads between teammates. Shares and mentions are messages
// in the same thread with that teammate, so everything two people handed each other is in one place.
// Every send reaches each member live (bus event 'team'); shares and mentions also land in
// process-gpt's notifications (type 'team') so the Home card, the bell and phone push carry them.
import { config } from '../../config.js'
import { q } from '../supa.js'
import { emit } from '../bus.js'
import { TeamError, isMember, people } from './access.js'
import { viewArtifacts } from './shares.js'

const T = () => config.tenantId
const UUID = /^[0-9a-f-]{36}$/i
export const MAX_GROUP = 8

export async function directThread(me, otherId) {
  const key = [me.id, otherId].sort().join(':')
  const [t] = await q(`insert into pro_dm_threads(tenant_id,kind,direct_key,created_by) values ($1,'direct',$2,$3)
                       on conflict (tenant_id, direct_key) do update set direct_key=excluded.direct_key returning *`, [T(), key, me.id])
  await q(`insert into pro_dm_members(thread_id,user_id) values ($1,$2),($1,$3) on conflict do nothing`, [t.id, me.id, otherId])
  return t
}

export async function groupThread(me, ids, title) {
  const members = [...new Set([me.id, ...ids])]
  if (members.length > MAX_GROUP) throw new TeamError(400, `그룹 대화는 ${MAX_GROUP}명까지예요.`)
  const [t] = await q(`insert into pro_dm_threads(tenant_id,kind,title,created_by) values ($1,'group',$2,$3) returning *`,
    [T(), String(title || '').slice(0, 60) || null, me.id])
  for (const id of members) await q('insert into pro_dm_members(thread_id,user_id) values ($1,$2) on conflict do nothing', [t.id, id])
  return t
}

// the thread, if I am in it; anything else is "not found"
export async function memberThread(me, threadId) {
  if (!UUID.test(String(threadId || ''))) return null
  const [t] = await q(`select t.* from pro_dm_threads t join pro_dm_members m on m.thread_id=t.id
                       where t.id=$1 and t.tenant_id=$2 and m.user_id=$3`, [threadId, T(), me.id])
  return t || null
}

export async function membersOf(threadId) {
  return q(`select m.user_id as id, u.username as name, u.email, m.last_read_at from pro_dm_members m
            left join users u on u.id=m.user_id and u.tenant_id=$2 where m.thread_id=$1`, [threadId, T()])
}

const nameOf = (p) => p?.name || p?.email?.split('@')[0] || '팀원'

export function view(viewerId, row, senders) {
  const s = senders?.[row.sender_id]
  return {
    id: row.id, threadId: row.thread_id, kind: row.kind, body: row.body, at: row.created_at,
    sender: { id: row.sender_id, name: nameOf(s) }, mine: row.sender_id === viewerId,
    artifacts: viewArtifacts(viewerId, row.sender_id, row.artifacts), context: row.context || null,
  }
}

export async function listThreads(me) {
  const rows = await q(`select t.*, mb.last_read_at,
      (select count(*)::int from pro_dm_messages x where x.thread_id=t.id and x.created_at > mb.last_read_at and x.sender_id <> $2) as unread,
      (select row_to_json(l) from (select id, kind, body, sender_id, created_at, artifacts from pro_dm_messages x where x.thread_id=t.id order by created_at desc limit 1) l) as last
    from pro_dm_threads t join pro_dm_members mb on mb.thread_id=t.id and mb.user_id=$2
    where t.tenant_id=$1 order by t.updated_at desc limit 100`, [T(), me.id])
  const out = []
  for (const t of rows) {
    const members = await membersOf(t.id)
    const others = members.filter((m) => m.id !== me.id)
    out.push({
      id: t.id, kind: t.kind, title: t.title || others.map(nameOf).join(', ') || '나',
      members: members.map((m) => ({ id: m.id, name: nameOf(m) })), unread: t.unread, updatedAt: t.updated_at,
      last: t.last ? { kind: t.last.kind, body: t.last.body, mine: t.last.sender_id === me.id, at: t.last.created_at, files: (t.last.artifacts || []).length } : null,
    })
  }
  return out
}

export async function messages(me, threadId, { before, limit = 60 } = {}) {
  const t = await memberThread(me, threadId)
  if (!t) throw new TeamError(404, '대화를 찾지 못했어요.')
  const rows = await q(`select * from pro_dm_messages where thread_id=$1 and ($2::timestamptz is null or created_at < $2)
                        order by created_at desc limit $3`, [t.id, before || null, Math.min(Number(limit) || 60, 200)])
  const members = await membersOf(t.id)
  const by = Object.fromEntries(members.map((m) => [m.id, m]))
  return { thread: { id: t.id, kind: t.kind, title: t.title, members: members.map((m) => ({ id: m.id, name: nameOf(m), lastReadAt: m.last_read_at })) },
    messages: rows.reverse().map((r) => view(me.id, r, by)) }
}

// Write a message into a thread I am in. Every other member must still be on the team.
export async function post(me, threadId, { kind = 'text', body = '', context = null, attach } = {}) {
  const t = await memberThread(me, threadId)
  if (!t) throw new TeamError(404, '대화를 찾지 못했어요.')
  const members = await membersOf(t.id)
  for (const m of members) if (!(await isMember(m.id))) throw new TeamError(403, `${nameOf(m)}님은 더 이상 팀원이 아니에요.`)
  const [row] = await q(`insert into pro_dm_messages(thread_id,tenant_id,sender_id,kind,body,context) values ($1,$2,$3,$4,$5,$6) returning *`,
    [t.id, T(), me.id, kind, String(body || '').slice(0, 8000), context])
  if (attach) {
    // grants are made per recipient once the message exists (the grant points back at it)
    row.artifacts = await attach(members.filter((m) => m.id !== me.id), row.id)
    await q('update pro_dm_messages set artifacts=$2 where id=$1', [row.id, JSON.stringify(row.artifacts)])
  }
  await q('update pro_dm_threads set updated_at=now() where id=$1', [t.id])
  await q('update pro_dm_members set last_read_at=now() where thread_id=$1 and user_id=$2', [t.id, me.id])
  const by = Object.fromEntries(members.map((m) => [m.id, m]))
  for (const m of members) emit(m.id, 'team', { type: 'message', threadId: t.id, message: view(m.id, row, by) })
  if (kind !== 'text') await notifyMembers(me, t, row, members.filter((m) => m.id !== me.id))
  return view(me.id, row, by)
}

async function notifyMembers(me, t, row, recipients) {
  const files = (row.artifacts || []).map((a) => a.name)
  const title = row.kind === 'share'
    ? `${me.name}님이 ${files[0] || '산출물'}${files.length > 1 ? ` 외 ${files.length - 1}개` : ''}를 공유했어요`
    : `${me.name}님이 나를 언급했어요${row.context?.title ? ` · ${row.context.title.slice(0, 30)}${row.context.title.length > 30 ? '…' : ''}` : ''}`
  const text = [row.body, files.length && row.kind !== 'share' ? `산출물: ${files.join(', ')}` : ''].filter(Boolean).join('\n').slice(0, 600)
  for (const r of recipients) {
    await q(`insert into notifications(id,user_id,title,type,description,url,from_user_id,tenant_id)
             values (gen_random_uuid(),$1,$2,'team',$3,$4,$5,$6)`, [r.id, title.slice(0, 200), text, `/pro/team/${t.id}/${row.id}`, me.email, T()])
    emit(r.id, 'notifications', {})
  }
}

export async function markRead(me, threadId) {
  const t = await memberThread(me, threadId)
  if (!t) throw new TeamError(404, '대화를 찾지 못했어요.')
  await q('update pro_dm_members set last_read_at=now() where thread_id=$1 and user_id=$2', [t.id, me.id])
  // the Home card and the bell for this thread are read too
  const n = await q(`update notifications set is_checked=true where tenant_id=$1 and user_id = any($2) and type='team'
                     and url like $3 and coalesce(is_checked,false)=false returning id`, [T(), [me.id, me.email], `/pro/team/${t.id}/%`])
  emit(me.id, 'team', { type: 'read', threadId: t.id })
  if (n.length) emit(me.id, 'notifications', {})
  return { ok: true }
}

export async function unread(me) {
  const rows = await q(`select mb.thread_id, count(m.id)::int n from pro_dm_members mb
                        join pro_dm_threads t on t.id=mb.thread_id and t.tenant_id=$1
                        join pro_dm_messages m on m.thread_id=mb.thread_id and m.created_at > mb.last_read_at and m.sender_id <> mb.user_id
                        where mb.user_id=$2 group by 1`, [T(), me.id])
  const byThread = Object.fromEntries(rows.map((r) => [r.thread_id, r.n]))
  return { total: rows.reduce((s, r) => s + r.n, 0), byThread }
}

// "받은 편지함": what teammates shared with me or mentioned me in, newest first
export async function inbox(me) {
  const rows = await q(`select m.*, mb.last_read_at from pro_dm_messages m join pro_dm_members mb on mb.thread_id=m.thread_id and mb.user_id=$2
                        where m.tenant_id=$1 and m.sender_id <> $2 and m.kind in ('share','mention') order by m.created_at desc limit 50`, [T(), me.id])
  const senders = Object.fromEntries((await people([...new Set(rows.map((r) => r.sender_id))])).map((p) => [p.id, p]))
  return rows.map((r) => ({ ...view(me.id, r, senders), unread: new Date(r.created_at) > new Date(r.last_read_at) }))
}

export async function message(me, id) {
  if (!UUID.test(String(id || ''))) return null
  const [r] = await q(`select m.* from pro_dm_messages m join pro_dm_members mb on mb.thread_id=m.thread_id and mb.user_id=$2
                       where m.id=$1 and m.tenant_id=$3`, [id, me.id, T()])
  if (!r) return null
  const senders = Object.fromEntries((await people([r.sender_id])).map((p) => [p.id, p]))
  return view(me.id, r, senders)
}
