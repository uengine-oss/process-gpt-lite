// After a run: the test accounts leave the tenant team (GET /api/team adds the caller) and lose any
// role or administrator flag a test gave them; folders/panel apps/schedules are removed by each
// test's own cleanup.
import * as db from './db.js'
export default async function teardown() {
  if (!(await db.available())) return
  const ids = (await db.q(`select id::text from users where tenant_id=$1 and email like 'pro-rt-%@uengine.org'`, [db.tenant])).map((r) => r.id)
  if (ids.length) {
    await db.q('delete from pro_role_assignments where tenant_id=$1 and user_id::text = any($2)', [db.tenant, ids]).catch(() => {})
    await db.q('delete from pro_team_members where tenant_id=$1 and user_id::text = any($2)', [db.tenant, ids]).catch(() => {})
    // removed by a test (F-TM-01, F-FX-A01): free to join again; no test account stays an administrator
    await db.q('delete from pro_team_removed where tenant_id=$1 and user_id::text = any($2)', [db.tenant, ids]).catch(() => {})
    await db.q('update users set is_admin=false where tenant_id=$1 and id::text = any($2) and is_admin', [db.tenant, ids]).catch(() => {})
  }
  await db.end()
}
