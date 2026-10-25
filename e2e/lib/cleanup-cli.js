// npm run cleanup — removes everything the pro-rt-* test accounts left behind (a run that was killed
// before its own cleanup): their folders (+ git repos, panel apps), schedules (+ pg_cron jobs), vault
// items, chat messages and conversations, team membership and role assignments. Real accounts are
// never touched: only users whose email matches pro-rt-<area>@uengine.org.
import * as db from './db.js'
import { removeFolder, retireInstance } from './seed.js'

if (!(await db.available())) { console.error('database not reachable (PGPT_DB_URL)'); process.exit(1) }
const users = await db.q(`select id::text, email from users where tenant_id=$1 and email ~ '^pro-rt-[a-z0-9-]+@uengine\\.org$'`, [db.tenant])
const ids = users.map((u) => u.id)
console.log(`test accounts: ${users.length}`)
for (const f of await db.q(`select slug from pro_folders where created_by::text = any($1)`, [ids])) { await removeFolder(db, f.slug); console.log('folder', f.slug) }
for (const s of await db.q(`select id, job_name from pro_schedules where user_id::text = any($1)`, [ids])) {
  for (const j of String(s.job_name || '').split(',').filter(Boolean)) await db.q('select cron.unschedule($1)', [j]).catch(() => {})
  await db.q('delete from pro_schedules where id=$1', [s.id])
  console.log('schedule', s.id)
}
for (const i of await db.q(`select distinct proc_inst_id from todolist where user_id ~ any($1) and status in ('NEW','TODO','IN_PROGRESS','PENDING')`, [ids])) await retireInstance(i.proc_inst_id)
await db.q(`delete from pro_vault_items where user_id::text = any($1)`, [ids]).catch(() => {})
await db.q(`delete from pro_messages where thread_id in (select id from pro_threads where user_id::text = any($1))`, [ids])
await db.q(`delete from context_threads where tenant_id=$1 and user_id = any($2)`, [db.tenant, ids])
await db.q(`delete from pro_role_assignments where tenant_id=$1 and user_id::text = any($2)`, [db.tenant, ids])
await db.q(`delete from pro_team_members where tenant_id=$1 and user_id::text = any($2)`, [db.tenant, ids])
await db.q(`update notifications set is_checked=true where tenant_id=$1 and user_id = any($2)`, [db.tenant, ids])
console.log('done')
await db.end()
