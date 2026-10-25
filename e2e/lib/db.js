// Direct database access for seeding and cleanup (dev stack: supabase-db :54322). Tests that need
// it call db.need(test) and are skipped when no database is reachable (e.g. a remote install/).
import pg from 'pg'
import { DB_URL, TENANT } from './env.js'

let pool = null
let ok = null
export async function available() {
  if (ok != null) return ok
  if (!DB_URL) return (ok = false)
  pool = new pg.Pool({ connectionString: DB_URL, max: 4, idleTimeoutMillis: 5000 })
  pool.on('error', () => {})
  ok = await pool.query('select 1').then(() => true, () => false)
  return ok
}
export async function q(sql, params = []) {
  if (!(await available())) throw new Error('database not reachable (set PGPT_DB_URL)')
  return (await pool.query(sql, params)).rows
}
export async function end() { if (pool) { const p = pool; pool = null; ok = null; await p.end().catch(() => {}) } }
export const tenant = TENANT

// ---- seeding helpers ----
export async function mainThreadId(userId) {
  const [t] = await q(`select id from pro_threads where user_id=$1 and kind='chat' order by created_at limit 1`, [userId])
  if (t) return t.id
  const [n] = await q(`insert into pro_threads(user_id,kind,title) values ($1,'chat','채팅') returning id`, [userId])
  return n.id
}
export async function clearMain(userId) {
  const id = await mainThreadId(userId)
  await q('delete from pro_messages where thread_id=$1', [id])
  await q(`update pro_threads set conversation_id=null, status=null where id=$1`, [id])
  await q('delete from context_threads where tenant_id=$1 and user_id=$2', [TENANT, userId])
  return id
}
// messages get increasing created_at so their order is the order given
export async function addMessages(threadId, list) {
  const out = []
  let t = Date.now() - list.length * 1000
  for (const m of list) {
    const [row] = await q(`insert into pro_messages(thread_id, role, kind, content, created_at) values ($1,$2,$3,$4, to_timestamp($5/1000.0)) returning *`,
      [threadId, m.role || 'agent', m.kind || 'text', m.content || {}, t += 1000])
    out.push(row)
  }
  return out
}
export async function addConversation(userId, id, title, { summary = '', gist = '' } = {}) {
  await q(`insert into context_threads(tenant_id,user_id,conversation_id,title,summary,gist,turns,updated_at) values ($1,$2,$3,$4,$5,$6,1,now())
           on conflict (tenant_id,user_id,conversation_id) do update set title=excluded.title, updated_at=now()`, [TENANT, userId, id, title, summary, gist])
}
