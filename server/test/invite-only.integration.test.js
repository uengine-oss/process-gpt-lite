// Invite-only against the real local database (2026-11-25 사용자: 「초대를 해준 사람에 한해서만 로그인 할 수 있는 거야」, spec
// openspec/specs/team-membership). Lite's membership rules (lib/supa.js · lib/membership.js) on:
//   IO-I-01 an old database without membership_status (a scratch schema whose users table lacks the column): every row is approved, a
//           membership cannot end (409); a request is still kept — in Lite's own table, not as a row
//   IO-I-02 Process GPT's own approval triggers (test/fixtures/pgpt-membership-approval.sql — its migrations' SQL), in one transaction
//           that is rolled back, with approval on and off: a request is Lite's record (no users row either way); approving it makes the
//           row (pending under the trigger, approved by it when approval is off) and approves it; Process GPT's invite row (pending, admin
//           stripped) becomes an approved administrator; a Process GPT sign-up declined and a member let go are 'rejected' with no role; the
//           tenant's owner is approved; the first person keeps their administrator role through the trigger
//   IO-I-03 the dev database as it is (Lite's sql/058: the column and pro_join_requests, no triggers): the status Lite writes is the status
//           it reads, the members' list SQL keeps the approved, the waiting are Process GPT's pending rows and Lite's requests together
//   IO-I-04 approving keeps a row's role (editor stays editor), an invitation as administrator makes it admin; the administrator check is
//           the same everywhere: is_admin or an admin role, on an approved row
//   IO-I-05 two first people of a company nobody runs, at once: exactly one makes it; the other gets no row
//   IO-I-06 two administrators letting each other go at once: exactly one goes, the company keeps an administrator
//   IO-I-07 no session for someone not approved here, and nothing written for them (no row here, none in the default tenant)
//   IO-I-08 approving a waiting or let-go row turns the 'viewer' it was left with into 'user'; editor stays editor
//   IO-I-09 the shares' own read policy (pro_shares_read, sql/058) lets the owner and the recipient read only while they are approved
//           members of the share's company — as the authenticated role through PostgREST would, in a transaction rolled back
// Every row lives in a tenant of its own and inside a transaction that is rolled back (IO-I-01, IO-I-02), or is deleted at the end.
//   cd server && node --test --test-concurrency=1 test/invite-only.integration.test.js
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import crypto from 'node:crypto'

process.env.PRO_BACKGROUND = '0'
// (tenants of their own: the server serves any tenant it is asked for, as behind the gateway — lib/tenant.js withTenant)
process.env.PRO_TENANT_FROM_HEADER = '1'
const { pool, q, admin: supa, memberStatus, sessionFor, STATUS, APPROVED } = await import('../lib/supa.js')
const M = await import('../lib/membership.js')
const team = await import('../lib/team.js')
const { withTenant, DEFAULT_TENANT } = await import('../lib/tenant.js')

const RUN = crypto.randomBytes(3).toString('hex')
const id = () => crypto.randomUUID()
const FIXTURE = fs.readFileSync(new URL('./fixtures/pgpt-membership-approval.sql', import.meta.url), 'utf8')
const tenants = [], accounts = []

// a client of its own in one transaction (rolled back at the end): query(sql, params) → rows
async function inTransaction(fn) {
  const c = await pool.connect()
  const query = (sql, p) => c.query(sql, p).then((r) => r.rows)
  try {
    await c.query('begin')
    await c.query("set local lock_timeout = '5s'")
    return await fn(query, c)
  } finally {
    await c.query('rollback').catch(() => {})
    c.release()
  }
}
async function freshTenant(name) {
  const t = `pgl-io-${name}-${RUN}`
  await q('insert into tenants (id) values ($1) on conflict do nothing', [t])
  tenants.push(t)
  return t
}

after(async () => {
  for (const t of tenants) {
    for (const tb of ['pro_join_requests', 'pro_team_members', 'pro_team_removed', 'pro_role_assignments']) await q(`delete from ${tb} where tenant_id=$1`, [t]).catch(() => {})
    await q('delete from users where tenant_id=$1', [t]).catch(() => {})
    await q('delete from tenants where id=$1', [t]).catch(() => {})
  }
  for (const a of accounts) { await q('delete from users where id=$1', [a]).catch(() => {}); await supa.auth.admin.deleteUser(a).catch(() => {}) }
  await pool.end()
})

test('IO-I-01 열이 없는 예전 DB: 모든 행이 승인, 내보내기는 409, 요청은 Lite 의 기록으로 남음', async () => {
  await inTransaction(async (query) => {
    const S = `pgl_io_old_${RUN}`
    await query(`create schema ${S}`)
    await query(`create table ${S}.users (like public.users including defaults including indexes)`)
    await query(`alter table ${S}.users drop column if exists membership_status`)
    await query(`set local search_path = ${S}, public`)
    const T = `pgl-io-old-${RUN}`
    const a = id(), b = id()
    await query(`insert into users (id, username, email, tenant_id) values ($1, 'old', 'old@example.test', $2)`, [a, T])
    assert.equal(await memberStatus(a, T, query), 'approved')
    assert.equal(await memberStatus(id(), T, query), null, '행이 없으면 회원이 아님')
    assert.equal(await M.hasStatusColumn(query), false)
    const [r] = await query(`select ${STATUS('u')} as s, ${APPROVED('u')} as ok from users u where u.id = $1`, [a])
    assert.deepEqual([r.s, r.ok], ['approved', true])
    await withTenant(T, async () => {
      assert.equal(await M.keepRequest({ userId: b, email: 'New@Example.test' }, query), 'pending', 'Lite 의 요청')
      assert.equal(await memberStatus(b, T, query), null, '행은 만들지 않음')
      assert.equal((await M.requestOf(b, query)).email, 'new@example.test')
      // approving it: the row (no status column — the row is the membership)
      await M.addRow(b, 'new@example.test', null, query)
      await M.approveRow(b, { by: a }, query)
      assert.equal(await memberStatus(b, T, query), 'approved')
      assert.equal((await M.requestOf(b, query)).status, 'approved')
      await assert.rejects(M.endRow(a, null, query), (e) => e.status === 409)
    })
  })
})

test('IO-I-02 Process GPT 의 승인 트리거 위에서(승인 켬 · 끔): 요청 · 승인 · 초대 행 · 거절 · 내보내기 · 주인 · 첫 관리자', async () => {
  await inTransaction(async (query) => {
    await query(FIXTURE)
    const T = `pgl-io-pg-${RUN}`, T2 = `pgl-io-pg2-${RUN}`
    await query('insert into tenants (id) values ($1), ($2)', [T, T2])
    const boss = id(), asker = id(), invited = id(), signup = id(), owner = id(), first = id(), walkIn = id()
    const statusOf = async (u, t = T) => (await query(`select membership_status as s, role, is_admin from users where id=$1 and tenant_id=$2`, [u, t]))[0]
    const signupOf = async (u, t = T) => (await query(`select status, reviewed_by from signup_requests where user_id=$1 and tenant_id=$2`, [u, t]))[0]
    await withTenant(T, async () => {
      // a request is Lite's record — no users row (so Process GPT's trigger never sees it)
      assert.equal(await M.keepRequest({ userId: asker, email: 'Asker@Example.test' }, query), 'pending')
      assert.equal(await statusOf(asker), undefined)
      assert.equal(await M.keepRequest({ userId: asker, email: 'asker@example.test' }, query), 'pending', '다시 눌러도 하나')
      assert.equal((await query('select count(*)::int n from pro_join_requests where user_id=$1', [asker]))[0].n, 1)
      // approving it: the row (pending under the trigger, with Process GPT's own signup_requests row), then approved
      await M.addRow(asker, 'asker@example.test', null, query)
      assert.equal((await statusOf(asker)).s, 'pending')
      await M.approveRow(asker, { by: boss }, query)
      assert.deepEqual(await statusOf(asker), { s: 'approved', role: 'user', is_admin: false }, "트리거가 남긴 viewer 는 user 로")
      assert.deepEqual(await signupOf(asker), { status: 'approved', reviewed_by: boss })
      assert.equal((await M.requestOf(asker, query)).status, 'approved')
      // Process GPT's invite row (completion invite_user: role user, is_admin as asked): pending, admin stripped → approved administrator
      await query(`insert into users (id, email, username, role, is_admin, tenant_id) values ($1, 'inv@example.test', 'inv', 'user', true, $2)`, [invited, T])
      assert.deepEqual(await statusOf(invited), { s: 'pending', role: 'viewer', is_admin: false })
      await M.approveRow(invited, { admin: true, by: boss }, query)
      assert.deepEqual(await statusOf(invited), { s: 'approved', role: 'admin', is_admin: true })
      assert.equal(await M.companyHasAdmin(query), true)
      // a sign-up in Process GPT (its row, pending) declined
      await query(`insert into users (id, email, username, role, tenant_id) values ($1, 'su@example.test', 'su', 'user', $2)`, [signup, T])
      assert.equal(await M.standing(signup, query), 'pending', 'Process GPT 의 가입도 요청')
      await M.endRow(signup, boss, query)
      assert.deepEqual(await statusOf(signup), { s: 'rejected', role: 'viewer', is_admin: false })
      assert.deepEqual(await signupOf(signup), { status: 'rejected', reviewed_by: boss })
      assert.equal(await M.keepRequest({ userId: signup, email: 'su@example.test' }, query), 'rejected', '거절된 사람은 다시 요청되지 않음')
      // a member let go (「내보내기」)
      await M.endRow(asker, boss, query)
      assert.equal(await memberStatus(asker, T, query), 'rejected')
      // the tenant's owner (Process GPT's tenant creation: the owner first, then their row) is approved
      await query('update tenants set owner=$1 where id=$2', [owner, T])
      await query(`insert into users (id, email, username, role, is_admin, tenant_id) values ($1, 'own@example.test', 'own', 'superAdmin', true, $2)`, [owner, T])
      assert.deepEqual(await statusOf(owner), { s: 'approved', role: 'superAdmin', is_admin: true })
    })
    // the first person of a company nobody runs (claimCompany): owner, then the row (approved by the trigger as owner), administrator
    await withTenant(T2, async () => {
      assert.equal(await M.claimCompany(first, 'first@example.test', null, query), true)
      assert.deepEqual(await statusOf(first, T2), { s: 'approved', role: 'admin', is_admin: true })
      assert.equal(await M.claimCompany(id(), 'second@example.test', null, query), false, '두 번째 사람은 못 만듦')
    })
    // approval off (production today): a request is still Lite's record, waiting — the trigger would have approved a row
    await query('update membership_settings set require_approval = false')
    await withTenant(T, async () => {
      assert.equal(await M.keepRequest({ userId: walkIn, email: 'walk@example.test' }, query), 'pending')
      assert.equal(await statusOf(walkIn), undefined, '행이 없으니 들어오지 못함')
      assert.equal(await memberStatus(walkIn, T, query), null)
      // approving it: the trigger approves the new row at once, and the approval that follows is the same
      await M.addRow(walkIn, 'walk@example.test', null, query)
      await M.approveRow(walkIn, { by: boss }, query)
      assert.equal((await statusOf(walkIn)).s, 'approved')
    })
  })
})

test('IO-I-03 개발 DB(sql/058, 트리거 없음): 적은 상태 그대로 · 승인된 사람만 목록 · 기다리는 사람은 두 곳에서', async () => {
  const T = await freshTenant('dev')
  assert.equal(await M.hasStatusColumn(), true, '개발 DB 에 server/sql/058_membership_status.sql 을 먼저 적용')
  const [a, p, r] = [id(), id(), id()]
  for (const [u, s] of [[a, 'approved'], [p, 'pending'], [r, 'rejected']]) {
    await q(`insert into users (id, username, email, tenant_id, membership_status) values ($1, $2, $3, $4, $5)`, [u, s, `${s}-${RUN}@example.test`, T, s])
  }
  assert.deepEqual(await Promise.all([a, p, r, id()].map((u) => memberStatus(u, T))), ['approved', 'pending', 'rejected', null])
  const listed = (await q(`select u.email from users u where u.tenant_id=$1 and ${APPROVED('u')}`, [T])).map((x) => x.email)
  assert.deepEqual(listed, [`approved-${RUN}@example.test`])
  await withTenant(T, async () => {
    const k = id()
    assert.equal(await M.keepRequest({ userId: k, email: `kept-${RUN}@example.test` }), 'pending')
    assert.equal(await memberStatus(k, T), null)
    assert.deepEqual((await M.listRequests()).map((x) => x.email).sort(), [`kept-${RUN}@example.test`, `pending-${RUN}@example.test`].sort())
    assert.equal(await M.companyHasAdmin(), false)
    // a row Lite makes is pending until someone lets the person in
    const n = id()
    await M.addRow(n, `new-${RUN}@example.test`, null)
    assert.equal(await memberStatus(n, T), 'pending')
  })
})

test('IO-I-04 승인은 역할을 그대로 두고(편집자는 편집자), 관리자 판단은 어디서나 is_admin 또는 관리자 역할', async () => {
  const T = await freshTenant('role')
  const [ed, adminRole, waitingAdmin] = [id(), id(), id()]
  await q(`insert into users (id, username, email, tenant_id, role, is_admin, membership_status) values
           ($1, 'ed', 'ed@example.test', $4, 'editor', false, 'pending'),
           ($2, 'ar', 'ar@example.test', $4, 'admin', false, 'approved'),
           ($3, 'wa', 'wa@example.test', $4, 'admin', true, 'pending')`, [ed, adminRole, waitingAdmin, T])
  await withTenant(T, async () => {
    await M.approveRow(ed, { by: adminRole })
    assert.deepEqual((await q('select membership_status s, role, is_admin from users where id=$1 and tenant_id=$2', [ed, T]))[0], { s: 'approved', role: 'editor', is_admin: false })
    assert.equal(await team.isAdmin({ id: adminRole }), true, '관리자 역할(is_admin 없이)')
    assert.equal(await team.isAdmin({ id: waitingAdmin }), false, '승인되지 않은 관리자')
    assert.equal(await team.isAdmin({ id: ed }), false)
    const listed = await M.removableAll({ id: ed }, [{ id: adminRole }, { id: ed }])
    assert.deepEqual(listed.map((x) => x.removable), [false, false], '유일한 관리자 · 나 자신')
    await M.approveRow(ed, { admin: true, by: adminRole })
    assert.deepEqual((await q('select role, is_admin from users where id=$1 and tenant_id=$2', [ed, T]))[0], { role: 'admin', is_admin: true })
  })
})

test('IO-I-05 아무도 운영하지 않는 회사의 첫 사람 둘이 동시에: 한 사람만 회사를 만든다', async () => {
  const T = await freshTenant('first')
  const [a, b] = [id(), id()]
  const won = await withTenant(T, () => Promise.all([M.claimCompany(a, 'a@example.test', null), M.claimCompany(b, 'b@example.test', null)]))
  assert.deepEqual(won.filter(Boolean).length, 1, JSON.stringify(won))
  const winner = won[0] ? a : b, loser = won[0] ? b : a
  assert.equal((await q('select owner::text from tenants where id=$1', [T]))[0].owner, winner)
  assert.equal(await memberStatus(winner, T), 'approved')
  assert.equal(await memberStatus(loser, T), null, '진 사람은 행이 없음')
})

test('IO-I-06 관리자 둘이 서로를 동시에 내보내면 한 사람만 나가고 회사에 관리자가 남는다', async () => {
  const T = await freshTenant('last')
  const [a, b] = [id(), id()]
  await q(`insert into users (id, username, email, tenant_id, role, is_admin, membership_status) values
           ($1, 'a', 'a@example.test', $3, 'admin', true, 'approved'), ($2, 'b', 'b@example.test', $3, 'admin', true, 'approved')`, [a, b, T])
  const out = await withTenant(T, () => Promise.allSettled([M.remove({ id: b }, a), M.remove({ id: a }, b)]))
  assert.deepEqual(out.map((x) => x.status).sort(), ['fulfilled', 'rejected'])
  assert.match(out.find((x) => x.status === 'rejected').reason.message, /마지막 관리자/)
  const left = await q(`select id::text from users where tenant_id=$1 and membership_status='approved' and is_admin`, [T])
  assert.equal(left.length, 1)
})

test('IO-I-07 승인되지 않은 사람에게는 세션이 없고, 아무 행도 쓰지 않는다(이 회사 · 기본 회사)', async () => {
  const T = await freshTenant('mint')
  const email = `pro-rt-io-mint-${RUN}@uengine.org`
  const { data, error } = await supa.auth.admin.createUser({ email, email_confirm: true })
  if (error) throw error
  accounts.push(data.user.id)
  const rows = async () => (await q('select tenant_id, membership_status from users where id=$1 order by 1', [data.user.id])).filter((r) => r.tenant_id !== 'process-gpt')
  await assert.rejects(withTenant(T, () => sessionFor(email)), (e) => e.status === 403 && e.code === 'invite_only')
  await assert.rejects(withTenant(DEFAULT_TENANT, () => sessionFor(email)), (e) => e.status === 403)
  assert.deepEqual(await rows(), [], '어느 회사에도 행을 만들지 않음')
  await q(`insert into users (id, username, email, tenant_id, membership_status) values ($1, 'm', $2, $3, 'pending')`, [data.user.id, email, T])
  await assert.rejects(withTenant(T, () => sessionFor(email)), (e) => e.status === 403)
  assert.deepEqual(await rows(), [{ tenant_id: T, membership_status: 'pending' }])
  await q(`update users set membership_status='approved' where id=$1 and tenant_id=$2`, [data.user.id, T])
  const { forgetMember } = await import('../lib/supa.js')
  forgetMember(data.user.id)
  assert.ok((await withTenant(T, () => sessionFor(email))).session.access_token, '승인되면 세션')
})

test('IO-I-08 기다리던 · 내보냈던 행을 승인하면 남아 있던 viewer 는 user, 편집자는 편집자', async () => {
  const T = await freshTenant('viewer')
  const [w, r, e] = [id(), id(), id()]
  await q(`insert into users (id, username, email, tenant_id, role, is_admin, membership_status) values
           ($1, 'w', 'w@example.test', $4, 'viewer', false, 'pending'),
           ($2, 'r', 'r@example.test', $4, 'viewer', false, 'rejected'),
           ($3, 'e', 'e@example.test', $4, 'editor', false, 'pending')`, [w, r, e, T])
  await withTenant(T, async () => {
    for (const u of [w, r, e]) await M.approveRow(u, {})
  })
  const roles = Object.fromEntries((await q('select id::text as id, role from users where tenant_id=$1', [T])).map((x) => [x.id, x.role]))
  assert.deepEqual([roles[w], roles[r], roles[e]], ['user', 'user', 'editor'])
})

test('IO-I-09 공유 읽기 정책(pro_shares_read): 주인 · 받는 사람도 그 회사의 승인된 구성원일 때만', async () => {
  await inTransaction(async (query) => {
    const T = `pgl-io-rls-${RUN}`
    await query('insert into tenants (id) values ($1)', [T])
    const [owner, to] = [id(), id()]
    await query(`insert into users (id, username, email, tenant_id, membership_status) values ($1,'o','o@example.test',$3,'approved'), ($2,'t','t@example.test',$3,'approved')`, [owner, to, T])
    const [sh] = await query(`insert into pro_shares (tenant_id, owner_id, recipient_id, name, bucket, object_key) values ($1,$2,$3,'보고서.pdf','files','x/y') returning id::text`, [T, owner, to])
    const asUser = async (who) => {
      await query('reset role')
      await query("select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)", [JSON.stringify({ sub: who, role: 'authenticated' }), who])
      await query('set local role authenticated')
      const rows = await query('select id::text from pro_shares where id = $1', [sh.id])
      await query('reset role')
      return rows.length
    }
    assert.equal(await asUser(to), 1, '받는 사람(승인된 구성원)')
    assert.equal(await asUser(owner), 1, '주인')
    await query(`update users set membership_status='rejected' where id=$1 and tenant_id=$2`, [to, T])
    assert.equal(await asUser(to), 0, '내보낸 받는 사람은 못 읽음')
    assert.equal(await asUser(id()), 0, '상관없는 사람')
  })
})
