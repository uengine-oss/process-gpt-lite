import { q } from './supa.js'
import { emit } from './bus.js'
import { L } from './lang.js'

export async function mainThread(userId) {
  const [t] = await q(`select * from pro_threads where user_id=$1 and kind='chat' order by created_at limit 1`, [userId])
  if (t) return t
  const [n] = await q(`insert into pro_threads(user_id,kind,title) values ($1,'chat',$2) returning *`, [userId, L('채팅', 'Chat')])
  return n
}

export const getThread = async (userId, id) =>
  (await q('select * from pro_threads where id=$1 and user_id=$2', [id, userId]))[0]

export async function addMessage(userId, threadId, role, kind, content) {
  const [m] = await q(
    `insert into pro_messages(thread_id,role,kind,content) values ($1,$2,$3,$4) returning *`,
    [threadId, role, kind, content])
  await q('update pro_threads set updated_at=now() where id=$1', [threadId])
  emit(userId, 'message', m)
  return m
}

export async function updateMessage(userId, id, content) {
  const [m] = await q(`update pro_messages set content=content || $2::jsonb where id=$1 returning *`, [id, JSON.stringify(content)])
  if (m) emit(userId, 'message', m)
  return m
}

export async function setThreadStatus(userId, threadId, status) {
  const [t] = await q('update pro_threads set status=$2, updated_at=now() where id=$1 returning *', [threadId, status])
  if (t) emit(userId, 'thread', t)
}

export async function history(threadId, limit = 30) {
  const rows = await q(
    `select role, kind, content from pro_messages where thread_id=$1 order by created_at desc limit $2`, [threadId, limit])
  return rows.reverse()
}
