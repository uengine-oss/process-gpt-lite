// After a run: the test accounts leave the tenant team (GET /api/team adds the caller) and any
// role they were given; folders/panel apps/schedules are removed by each test's own cleanup.
import * as db from './db.js'
export default async function teardown() {
  if (!(await db.available())) return
  const ids = (await db.q(`select id::text from users where tenant_id=$1 and email like 'pro-rt-%@uengine.org'`, [db.tenant])).map((r) => r.id)
  if (ids.length) {
    await db.q('delete from pro_role_assignments where tenant_id=$1 and user_id::text = any($2)', [db.tenant, ids]).catch(() => {})
    await db.q('delete from pro_team_members where tenant_id=$1 and user_id::text = any($2)', [db.tenant, ids]).catch(() => {})
  }
  await db.end()
}
