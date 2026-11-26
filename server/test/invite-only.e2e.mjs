// Invite-only behind the ProcessGPT gateway, as production runs (PRO_TENANT_FROM_HEADER=1 — the request's X-Tenant-Id is its company),
// over HTTP against this server (port 9045) and the real local database and auth server. Spec openspec/specs/team-membership.
// A fake completion (port 9046) answers Process GPT's POST /invite-user the way services/completion/database.py invite_user does: the
// account (no mail here) and a users row of the tenant (role user, is_admin as asked). No model.
//   IO-G-01 the auth middleware: an approved member passes; pending, rejected and absent (a member of another company only) are 403
//           invite_only; an administrator of this company is refused at another company's address
//   IO-G-02 Google through Process GPT's Supabase (/auth/done → POST /api/auth/refuse): nothing is kept, the session made for it is ended
//           at the auth server, the screen gets a ticket; 「가입 요청 보내기」 (POST /api/auth/join-request) keeps the request then; a session
//           taken from Process GPT ({host: true}) is not ended, still refused, and someone let go gets no ticket
//   IO-G-03 the e-mail code: an uninvited new address gets the same answer and no account, its code is refused (invite_only) and still no
//           account; someone waiting is told so (pending); a member gets a session
//   IO-G-04 an administrator: invite (Process GPT's invite through completion — the row approved; an address waiting or let go is
//           approved; a member is 'member'; a bad address 'invalid'; completion down → the same here), the requests list (Process GPT's
//           pending rows and Lite's requests), approve, reject, 「내보내기」 (the session ends at once), not oneself · not the owner · not
//           the last administrator; a member is 403 on all
//   IO-G-05 another company: its people are not found from this one, and this company's administrator is refused at its address
//   IO-G-06 「내보내기」 ends everything the person could still reach the company with: auth sessions (access and refresh), linked desktops,
//           rooms, direct conversations, shared folders, live meetings, routines (paused), the open event stream, a folder git token
//           naming them; and someone in a room who is no longer a member does not stop the others from posting (they are dropped)
//   IO-G-07 the e-mail code behind the gateway: an address with an account that is not a member here gets {sent: true} and no code
//   IO-G-08 「가입 요청 보내기」 limits: a forged or another company's ticket is refused, one person once a minute, one address
//           PRO_JOIN_REQUESTS_PER_ADDRESS_PER_DAY companies a day, a company PRO_JOIN_REQUESTS_PER_HOUR waiting requests an hour (declined
//           ones free their place)
//   IO-G-09 the agent's file downloads (/api/agent-files) and the MCP gateways (/mcp/*) take an approved member of the request's company only
//   IO-G-10 someone who is an approved member of two companies, let go by one: still signed in, still working in the other (requests,
//           its event stream, its routines); this company's rooms, folders, stream and routines are gone; a routine of no company stays
//   node test/invite-only.e2e.mjs        (IO_BFF_PORT · IO_FAKE_PORT to move the ports)
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const BFF = Number(process.env.IO_BFF_PORT || 9045)
const FAKE = Number(process.env.IO_FAKE_PORT || 9046)
const RUN = crypto.randomBytes(3).toString('hex')
const TENANT = `pgl-io-${RUN}`, OTHER = `pgl-io2-${RUN}`
const mail = (who) => `pro-rt-io-${who}-${RUN}@uengine.org`
const EMAIL = { boss: mail('boss'), mate: mail('mate'), waiting: mail('waiting'), gone: mail('gone'), stranger: mail('stranger'),
  owner: mail('owner'), newbie: mail('newbie'), invitee: mail('invitee'), local: mail('local'), elsewhere: mail('elsewhere'),
  leaver: mail('leaver'), outsider: mail('outsider'), asker1: mail('asker1'), asker2: mail('asker2'), asker3: mail('asker3'), asker4: mail('asker4'),
  both: mail('both') }

Object.assign(process.env, {
  PRO_PORT: String(BFF), PRO_PUBLIC_URL: `http://127.0.0.1:${BFF}`, PRO_TENANT_FROM_HEADER: '1', PRO_TENANT_ID: 'localhost', PRO_TENANT_HOSTS: '',
  PRO_BACKGROUND: '0', PRO_ONTOLOGY_WORKER: '0', PRO_SCENARIOS: 'off', PRO_CONTEXT_ROUTER_URL: '', PRO_DEMO_LOGIN: '1',
  PRO_COMPLETION_URL: `http://127.0.0.1:${FAKE}`, PRO_LLM_BASE_URL: 'http://127.0.0.1:9/v1', PRO_LLM_API_KEY: 'test', PRO_MCP_HUB_URL: 'http://127.0.0.1:9',
})
process.chdir(path.resolve(here, '..'))
const { q, pool, admin: supa } = await import('../lib/supa.js')
const members = await import('../lib/membership.js')
const { withTenant } = await import('../lib/tenant.js')

// ---- the fake completion: POST /invite-user as Process GPT's does it (no mail) ----
const completion = { calls: [], down: false }
const fake = http.createServer(async (req, res) => {
  let raw = ''
  for await (const c of req) raw += c
  const send = (code, j) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(j)) }
  if (req.method !== 'POST' || req.url !== '/invite-user') return send(404, {})
  const input = JSON.parse(raw || '{}').input || {}
  completion.calls.push({ ...input, host: req.headers['x-forwarded-host'] })
  if (completion.down) return send(500, { detail: 'Failed to invite user: down' })
  // invite_user: an existing users row anywhere → that id; else invite_user_by_email (the account) — then the tenant's row
  let [u] = await q('select id::text as id from users where email = $1 limit 1', [input.email])
  if (!u) {
    const { data, error } = await supa.auth.admin.createUser({ email: input.email, email_confirm: true })
    if (error) return send(500, { detail: error.message })
    u = { id: data.user.id }
  }
  await q(`insert into users (id, email, username, role, is_admin, tenant_id) values ($1, $2, $3, 'user', $4, $5)`, [u.id, input.email, input.email.split('@')[0], !!input.is_admin, input.tenant_id])
  send(200, { success: true, message: `Invitation sent to ${input.email}`, redirect_url: null, user_id: u.id })
})

// ---- requests as the gateway passes them on: X-Tenant-Id from the address ----
async function api(method, p, { token, tenant = TENANT, body } = {}) {
  const r = await fetch(`http://127.0.0.1:${BFF}/api${p}`, {
    method, headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': tenant, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await r.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* not JSON */ }
  return { status: r.status, json, text }
}
// a session of the auth server for an account (what Google through Process GPT's Supabase gives the page) — no users row made
async function rawSession(email) {
  const { data: link, error } = await supa.auth.admin.generateLink({ type: 'magiclink', email })
  if (error) throw error
  const { config } = await import('../config.js')
  const r = await fetch(`${config.supabaseUrl}/auth/v1/verify`, { method: 'POST', headers: { apikey: config.anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', token_hash: link.properties.hashed_token }) })
  const s = await r.json()
  if (!s.access_token) throw new Error('no session: ' + JSON.stringify(s).slice(0, 200))
  return s
}
const account = async (email) => (await q('select id::text as id from auth.users where email = $1', [email]))[0]?.id || null
const statusIn = async (id, t = TENANT) => (await q('select membership_status as s from users where id=$1 and tenant_id=$2', [id, t]))[0]?.s || null
const P = {} // who → {id, token}

async function cleanup() {
  const ids = (await q('select id::text as id from auth.users where email = any($1)', [Object.values(EMAIL)])).map((r) => r.id)
  for (const id of ids) {
    for (const t of ['pro_threads', 'pro_profile', 'pro_actions', 'pro_mail_accounts', 'pro_vault_items', 'pro_vault_keys'])
      await q(`delete from ${t} where user_id=$1`, [id]).catch(() => {})
    await q('delete from users where id=$1', [id]).catch(() => {})
  }
  for (const t of [TENANT, OTHER]) {
    for (const sql of ['delete from chats where tenant_id=$1', 'delete from pro_meetings where tenant_id=$1', 'delete from chat_rooms where tenant_id=$1', 'delete from pro_dm_threads where tenant_id=$1',
      'delete from pro_folders where tenant_id=$1', 'delete from pro_schedules where tenant_id=$1', 'delete from pro_local_devices where tenant_id=$1']) await q(sql, [t]).catch(() => {})
    for (const tb of ['pro_team_members', 'pro_team_removed', 'pro_role_assignments', 'pro_join_requests']) await q(`delete from ${tb} where tenant_id=$1`, [t]).catch(() => {})
    await q('delete from users where tenant_id=$1', [t]).catch(() => {})
    await q('delete from tenants where id=$1', [t]).catch(() => {})
  }
  for (const id of ids) await supa.auth.admin.deleteUser(id).catch(() => {})
}

before(async () => {
  await new Promise((r) => fake.listen(FAKE, '127.0.0.1', r))
  await cleanup()
  await q('insert into tenants (id) values ($1), ($2)', [TENANT, OTHER])
  // the company's people: accounts of the auth server and their rows (as Process GPT keeps them)
  for (const who of ['boss', 'mate', 'waiting', 'gone', 'stranger', 'owner', 'elsewhere', 'leaver', 'outsider', 'asker1', 'asker2', 'asker3', 'asker4', 'both']) {
    const { data, error } = await supa.auth.admin.createUser({ email: EMAIL[who], email_confirm: true, user_metadata: { name: `시험 ${who}` } })
    if (error) throw error
    P[who] = { id: data.user.id }
  }
  const row = (who, t, status, admin = false) => q(`insert into users (id, username, email, tenant_id, role, is_admin, membership_status) values ($1,$2,$3,$4,$5,$6,$7)`,
    [P[who].id, `시험 ${who}`, EMAIL[who], t, admin ? 'admin' : 'user', admin, status])
  await row('boss', TENANT, 'approved', true)
  await row('mate', TENANT, 'approved')
  await row('owner', TENANT, 'approved')
  await row('waiting', TENANT, 'pending')
  await row('gone', TENANT, 'rejected')
  await row('stranger', OTHER, 'approved')   // a member of another company only
  await row('elsewhere', OTHER, 'pending')    // waiting at the other company
  await row('leaver', TENANT, 'approved')
  await row('outsider', TENANT, 'approved')
  await row('both', TENANT, 'approved')
  await row('both', OTHER, 'approved')
  // (the leaver belongs to this company only: the row the dev stack's sign-up trigger adds in its default company goes)
  await q('delete from users where id=$1 and tenant_id <> $2', [P.leaver.id, TENANT])
  await q('update tenants set owner=$1 where id=$2', [P.owner.id, TENANT])
  for (const who of Object.keys(P)) P[who].token = (await rawSession(EMAIL[who])).access_token
  await import('../index.js')
  for (let i = 0; i < 100; i++) { if ((await fetch(`http://127.0.0.1:${BFF}/api/config`).catch(() => null))?.ok) break; await new Promise((r) => setTimeout(r, 200)) }
})

after(async () => {
  await cleanup()
  fake.close()
  await pool.end().catch(() => {})
  setTimeout(() => process.exit(process.exitCode || 0), 300)
})

test('IO-G-01 인증 미들웨어: 승인된 구성원만, 대기 · 거절 · 다른 회사 사람은 403 invite_only', async () => {
  assert.equal((await api('GET', '/me', { token: P.mate.token })).status, 200)
  assert.equal((await api('GET', '/me', { token: P.owner.token })).status, 200, '회사 주인')
  for (const who of ['waiting', 'gone', 'stranger']) {
    const r = await api('GET', '/me', { token: P[who].token })
    assert.equal(r.status, 403, who)
    assert.equal(r.json.code, 'invite_only', who)
    assert.match(r.json.error, /초대받은 분만 들어올 수 있어요/)
    assert.equal(r.json.company, TENANT)
  }
  // an administrator of this company at another company's address
  const at = await api('GET', '/team', { token: P.boss.token, tenant: OTHER })
  assert.deepEqual([at.status, at.json.code], [403, 'invite_only'])
  // English: the same refusal in the screen's language (L())
  const en = await fetch(`http://127.0.0.1:${BFF}/api/me`, { headers: { 'X-Tenant-Id': TENANT, Authorization: `Bearer ${P.gone.token}`, 'X-PGL-Lang': 'en' } }).then((r) => r.json())
  assert.equal(en.title, 'Only invited people can come in.')
})

test('IO-G-02 Process GPT 의 Google 로그인으로 온 초대받지 않은 사람: 요청으로 남고, 그 로그인의 세션은 끝남 · Process GPT 의 세션은 그대로', async () => {
  const s = await rawSession(EMAIL.stranger)
  const r = await api('POST', '/auth/refuse', { token: s.access_token, body: {} })
  assert.equal(r.status, 403)
  assert.deepEqual([r.json.code, r.json.pending, r.json.company, r.json.email, r.json.canRequest], ['invite_only', false, TENANT, EMAIL.stranger, true])
  assert.match(r.json.detail, /관리자에게 초대를 요청해 주세요/)
  assert.ok(r.json.ticket)
  assert.equal((await q('select count(*)::int n from pro_join_requests where user_id=$1', [P.stranger.id]))[0].n, 0, '누르기 전에는 아무것도 남기지 않음')
  // 「가입 요청 보내기」: the request kept now (Lite's record — no row in this company)
  const j = await api('POST', '/auth/join-request', { body: { ticket: r.json.ticket } })
  assert.equal(j.status, 201)
  assert.deepEqual([j.json.pending, j.json.canRequest], [true, false])
  assert.match(j.json.detail, /가입 요청을 보냈어요/)
  assert.equal((await q('select status from pro_join_requests where tenant_id=$1 and user_id=$2', [TENANT, P.stranger.id]))[0].status, 'pending')
  assert.equal(await statusIn(P.stranger.id), null, '행은 만들지 않음')
  assert.equal(await statusIn(P.stranger.id, OTHER), 'approved', '다른 회사의 회원 자격은 그대로')
  // signing in again: told it waits, no button
  const again = await api('POST', '/auth/refuse', { token: (await rawSession(EMAIL.stranger)).access_token, body: {} })
  assert.deepEqual([again.json.pending, again.json.canRequest], [true, false])
  // the session made for this sign-in is over at the auth server: the page cannot use it again
  const { error } = await supa.auth.getUser(s.access_token)
  assert.ok(error, '끝난 세션')
  assert.equal((await api('GET', '/me', { token: s.access_token })).status, 401)
  // a session taken from Process GPT's cookies ({host: true}) is Process GPT's: refused here, not ended
  const h = await rawSession(EMAIL.gone)
  const rh = await api('POST', '/auth/refuse', { token: h.access_token, body: { host: true } })
  assert.deepEqual([rh.status, rh.json.pending, rh.json.canRequest], [403, false, false], '내보낸 사람: 요청이 아니고 요청할 수도 없음')
  assert.ok(!(await supa.auth.getUser(h.access_token)).error, 'Process GPT 의 세션은 살아 있음')
  assert.equal(await statusIn(P.gone.id), 'rejected')
  // a member: nothing to refuse
  assert.deepEqual((await api('POST', '/auth/refuse', { token: P.mate.token, body: {} })).json, { ok: true })
})

test('IO-G-03 이메일 코드: 초대받지 않은 새 주소는 계정이 생기지 않고, 기다리는 사람은 그렇게 듣고, 구성원은 들어옴', async () => {
  const start = await api('POST', '/auth/email/start', { body: { email: EMAIL.newbie } })
  assert.deepEqual([start.status, start.json.sent], [200, true], '같은 대답')
  assert.equal(await account(EMAIL.newbie), null, '보내지 않았고 만들지 않았음')
  const v = await api('POST', '/auth/email/verify', { body: { email: EMAIL.newbie, code: '000000' } })
  assert.deepEqual([v.status, v.json.code, v.json.pending], [403, 'invite_only', false])
  assert.ok(!v.json.session && !v.json.access_token, '세션 없음')
  assert.equal(await account(EMAIL.newbie), null, '여전히 계정 없음')
  const w = await api('POST', '/auth/email/verify', { body: { email: EMAIL.waiting.toUpperCase(), code: '000000' } })
  assert.deepEqual([w.status, w.json.pending, w.json.email], [403, true, EMAIL.waiting])
  const bad = await api('POST', '/auth/email/verify', { body: { email: EMAIL.mate, code: '123456' } })
  assert.equal(bad.status, 400, '틀린 코드')
  const ok = await api('POST', '/auth/email/verify', { body: { email: EMAIL.mate, code: '000000' } })
  assert.equal(ok.status, 200)
  assert.ok(ok.json.session.access_token)
})

test('IO-G-04 관리자: 초대 · 가입 요청 · 승인 · 거절 · 내보내기, 구성원은 모두 403', async () => {
  // a member who is not an administrator
  for (const [m, p, body] of [['POST', '/team/invites', { emails: EMAIL.newbie }], ['GET', '/team/requests'], ['POST', `/team/requests/${P.waiting.id}/approve`],
    ['POST', `/team/requests/${P.waiting.id}/reject`], ['POST', `/team/members/${P.owner.id}/remove`]]) {
    assert.equal((await api(m, p, { token: P.mate.token, body })).status, 403, `${m} ${p}`)
  }
  // the requests: who waits here (the stranger's Google sign-in from IO-G-02 included), not the other company's
  const reqs = (await api('GET', '/team/requests', { token: P.boss.token })).json
  assert.deepEqual(reqs.map((r) => r.email).sort(), [EMAIL.stranger, EMAIL.waiting].sort())
  assert.ok(reqs.every((r) => r.id && r.name))
  // approve → in at once
  assert.equal((await api('POST', `/team/requests/${P.waiting.id}/approve`, { token: P.boss.token })).json.status, 'approved')
  assert.equal((await api('GET', '/me', { token: P.waiting.token })).status, 200)
  assert.ok((await api('GET', '/team', { token: P.boss.token })).json.some((m) => m.id === P.waiting.id), '팀원 목록에')
  // reject → rejected, off the list, still refused
  assert.equal((await api('POST', `/team/requests/${P.stranger.id}/reject`, { token: P.boss.token })).json.status, 'rejected')
  assert.equal((await q('select status from pro_join_requests where tenant_id=$1 and user_id=$2', [TENANT, P.stranger.id]))[0].status, 'rejected')
  assert.equal(await statusIn(P.stranger.id), null)
  assert.equal((await api('GET', '/team/requests', { token: P.boss.token })).json.length, 0)
  assert.equal((await api('POST', `/team/requests/${P.stranger.id}/reject`, { token: P.boss.token })).status, 404, '이미 끝난 요청')
  // invite: a new address (Process GPT's invite through completion), a member, someone let go, a bad address
  completion.calls.length = 0
  // (the auth server sends one person a mail at most once a minute — GOTRUE_SMTP_MAX_FREQUENCY — and this test signed 'gone' in a moment
  // ago: their last-sent mark is cleared so the re-invitation's mail is not held back by the test itself)
  await q('update auth.users set recovery_sent_at = null, confirmation_sent_at = null where id=$1', [P.gone.id])
  const sentBefore = (await q('select count(*)::int n from auth.one_time_tokens where user_id=$1', [P.gone.id]))[0].n
  const inv = await api('POST', '/team/invites', { token: P.boss.token, body: { emails: `${EMAIL.invitee}, ${EMAIL.mate}\n${EMAIL.gone} not-an-address` } })
  assert.equal(inv.status, 200)
  const by = Object.fromEntries(inv.json.map((x) => [x.email, x]))
  // (someone let go before is invited the way a new address is — told by mail, not quietly let back in)
  assert.deepEqual([by[EMAIL.invitee].result, by[EMAIL.mate].result, by[EMAIL.gone].result, by['not-an-address'].result], ['invited', 'member', 'invited', 'invalid'])
  assert.equal(by[EMAIL.gone].mailed, true, '다시 초대한 사람에게도 메일')
  assert.ok((await q('select count(*)::int n from auth.one_time_tokens where user_id=$1', [P.gone.id]))[0].n > sentBefore || (await q('select recovery_sent_at is not null as s from auth.users where id=$1', [P.gone.id]))[0].s, '인증 서버가 메일을 보냄')
  assert.deepEqual(completion.calls.map((c) => [c.email, c.is_admin, c.tenant_id, c.host]), [[EMAIL.invitee, false, TENANT, `${TENANT}.process-gpt.local`]])
  const invitee = await account(EMAIL.invitee)
  assert.equal(await statusIn(invitee), 'approved', '초대가 곧 승인')
  const signIn = await api('POST', '/auth/email/verify', { body: { email: EMAIL.invitee, code: '000000' } })
  assert.equal(signIn.status, 200, '초대받은 사람은 들어옴')
  assert.equal((await api('GET', '/me', { token: signIn.json.session.access_token })).status, 200)
  assert.equal((await api('GET', '/me', { token: P.gone.token })).status, 200, '다시 초대한 사람도')
  // completion not there (an install without the process engine): the same steps here — Supabase's own invitation (the auth server
  // marks the account invited), or the account without a mail when the auth server cannot send one
  completion.down = true
  const loc = await api('POST', '/team/invites', { token: P.boss.token, body: { emails: [EMAIL.local], admin: true } })
  completion.down = false
  assert.equal(loc.json[0].result, 'invited')
  const local = await account(EMAIL.local)
  const [marked] = await q('select invited_at is not null as invited from auth.users where id=$1', [local])
  assert.equal(loc.json[0].mailed, marked.invited, '「메일을 보냈다」는 인증 서버가 초대를 받았을 때만')
  assert.deepEqual((await q('select membership_status, role, is_admin from users where id=$1 and tenant_id=$2', [local, TENANT]))[0], { membership_status: 'approved', role: 'admin', is_admin: true })
  // 「내보내기」: what the list offers, then the member's access ends at once
  const team = (await api('GET', '/team', { token: P.boss.token })).json
  const flag = (id) => team.find((m) => m.id === id)?.removable
  assert.equal(flag(P.boss.id), false, '나 자신')
  assert.equal(flag(P.owner.id), false, '회사를 만든 사람')
  assert.equal(flag(P.mate.id), true)
  assert.equal((await api('GET', '/me', { token: P.mate.token })).status, 200)
  assert.equal((await api('POST', `/team/members/${P.mate.id}/remove`, { token: P.boss.token })).json.status, 'rejected')
  // (they also belong to the dev stack's default company, so they stay signed in — and this company refuses them at once; IO-G-06 sees
  // the sessions end for someone of this company only, IO-G-10 the rest)
  const gone = await api('GET', '/me', { token: P.mate.token })
  assert.deepEqual([gone.status, gone.json.code], [403, 'invite_only'], '곧바로 막힘')
  assert.equal(await statusIn(P.mate.id), 'rejected')
  assert.ok(!(await api('GET', '/team', { token: P.boss.token })).json.some((m) => m.id === P.mate.id), '팀원 목록에서 빠짐')
  assert.ok(!(await api('GET', '/people', { token: P.boss.token })).json[P.mate.id], '사람 목록에서도')
  assert.equal((await api('POST', `/team/members/${P.boss.id}/remove`, { token: P.boss.token })).status, 400, '나 자신은 못 내보냄')
  assert.equal((await api('POST', `/team/members/${P.owner.id}/remove`, { token: P.boss.token })).status, 400, '회사를 만든 사람은 못 내보냄')
  // the last administrator: with no owner and no other administrator, nobody can let them go
  await q('update tenants set owner=null where id=$1', [TENANT])
  await q('update users set is_admin=false, role=$3 where id=$1 and tenant_id=$2', [local, TENANT, 'user'])
  await withTenant(TENANT, async () => {
    assert.equal(await members.removable({ id: crypto.randomUUID() }, P.boss.id), false)
    await assert.rejects(members.remove({ id: crypto.randomUUID() }, P.boss.id), (e) => e.status === 400 && /마지막 관리자/.test(e.message))
  })
  await q('update tenants set owner=$1 where id=$2', [P.owner.id, TENANT])
})

test('IO-G-05 다른 회사: 그 회사 사람은 이 회사에서 찾지 못하고, 이 회사 관리자는 그 회사 주소에서 막힘', async () => {
  const here = await api('POST', `/team/requests/${P.elsewhere.id}/approve`, { token: P.boss.token })
  assert.equal(here.status, 404)
  assert.equal(await statusIn(P.elsewhere.id, OTHER), 'pending', '그대로')
  const there = await api('POST', `/team/requests/${P.elsewhere.id}/approve`, { token: P.boss.token, tenant: OTHER })
  assert.deepEqual([there.status, there.json.code], [403, 'invite_only'])
  assert.equal((await api('POST', `/team/members/${P.stranger.id}/remove`, { token: P.boss.token })).status, 404, '이 회사의 구성원이 아님')
})

test('IO-G-06 내보내기는 그 사람이 회사에 닿던 모든 길을 끝낸다 · 방에 남은 비회원은 다른 사람의 글을 막지 않는다', async () => {
  const L = P.leaver
  const s = await rawSession(EMAIL.leaver)
  await api('GET', '/me', { token: s.access_token })
  await api('GET', '/me', { token: P.outsider.token })
  // their places: a room (through the API, as the messenger makes it), a direct conversation, a folder, a live meeting, a routine, a desktop
  const room = (await api('POST', '/team/threads', { token: P.boss.token, body: { members: [L.id, P.outsider.id] } })).json
  assert.ok(room.id, JSON.stringify(room))
  const [dm] = await q(`insert into pro_dm_threads (tenant_id, kind, created_by) values ($1, 'group', $2) returning id`, [TENANT, P.boss.id])
  await q('insert into pro_dm_members (thread_id, user_id) values ($1,$2), ($1,$3)', [dm.id, P.boss.id, L.id])
  const [folder] = await q(`insert into pro_folders (tenant_id, slug, name, repo_path) values ($1, $2, '나가는 폴더', '/nonexistent') returning id::text`, [TENANT, `io-leave-${RUN}`])
  await q(`insert into pro_folder_members (folder_id, principal_type, principal_id, role) values ($1,'user',$2,'editor'), ($1,'user',$3,'owner')`, [folder.id, L.id, P.boss.id])
  const [meet] = await q(`insert into pro_meetings (tenant_id, room_id, started_by) values ($1,$2,$3) returning id`, [TENANT, room.id, P.boss.id])
  await q('insert into pro_meeting_participants (meeting_id, user_id) values ($1,$2), ($1,$3)', [meet.id, L.id, P.boss.id])
  const [sched] = await q(`insert into pro_schedules (user_id, name, cron, prompt, tenant_id) values ($1, '아침 브리핑', '0 8 * * *', 'x', $2) returning id`, [L.id, TENANT])
  const [dev] = await q(`insert into pro_local_devices (tenant_id, user_id, name, token_hash) values ($1,$2,'노트북',$3) returning id`, [TENANT, L.id, `io-${RUN}`])
  const { mintToken } = await import('../lib/folders/gitHttp.js')
  const gitToken = mintToken({ tenant: TENANT, folderId: folder.id, user: L.id })
  const git = () => fetch(`http://127.0.0.1:${BFF}/api/git/${folder.id}.git/info/refs?service=git-upload-pack`, { headers: { Authorization: `Bearer ${gitToken}` } }).then(async (r) => ({ status: r.status, text: await r.text() }))
  const before = await git()
  assert.ok(!/not a member/.test(before.text), before.text)
  // an open event stream
  const ctl = new AbortController()
  const stream = await fetch(`http://127.0.0.1:${BFF}/api/events?token=${s.access_token}`, { headers: { 'X-Tenant-Id': TENANT }, signal: ctl.signal })
  assert.equal(stream.status, 200)
  const reader = stream.body.getReader()
  await reader.read()
  const ended = (async () => { for (;;) { const { done } = await reader.read(); if (done) return true } })()
  // 「내보내기」
  assert.equal((await api('POST', `/team/members/${L.id}/remove`, { token: P.boss.token })).json.status, 'rejected')
  assert.equal(await Promise.race([ended, new Promise((r) => setTimeout(() => r(false), 5000))]), true, '열린 이벤트 흐름이 닫힘')
  ctl.abort()
  assert.ok((await supa.auth.getUser(s.access_token)).error, '세션 끝남')
  const { config } = await import('../config.js')
  const refreshed = await fetch(`${config.supabaseUrl}/auth/v1/token?grant_type=refresh_token`, { method: 'POST', headers: { apikey: config.anonKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: s.refresh_token }) }).then((r) => r.json())
  assert.ok(!refreshed.access_token, '갱신 토큰도 끝남')
  assert.equal((await q('select count(*)::int n from auth.sessions where user_id=$1', [L.id]))[0].n, 0)
  assert.ok((await q('select revoked_at from pro_local_devices where id=$1', [dev.id]))[0].revoked_at, '데스크톱 연결 끊김')
  const [rm] = await q('select participants from chat_rooms where id=$1', [room.id])
  assert.ok(!rm.participants.some((p) => p.id === L.id), '방에서 빠짐')
  assert.equal((await q('select count(*)::int n from pro_dm_members where thread_id=$1 and user_id=$2', [dm.id, L.id]))[0].n, 0, '대화에서 빠짐')
  assert.equal((await q(`select count(*)::int n from pro_folder_members where folder_id=$1 and principal_id=$2`, [folder.id, L.id]))[0].n, 0, '폴더에서 빠짐')
  assert.equal((await q('select count(*)::int n from pro_meeting_participants where meeting_id=$1 and user_id=$2', [meet.id, L.id]))[0].n, 0, '회의에서 빠짐')
  assert.equal((await q('select paused from pro_schedules where id=$1', [sched.id]))[0].paused, true, '루틴 멈춤')
  const after = await git()
  assert.deepEqual([after.status, /not a member/.test(after.text)], [403, true], '폴더 git 토큰도 막힘')
  // someone still in a room who is no longer a member (let go elsewhere): the others post, and they are dropped
  await q(`update users set membership_status='rejected' where id=$1 and tenant_id=$2`, [P.outsider.id, TENANT])
  const { forgetMember } = await import('../lib/supa.js')
  forgetMember(P.outsider.id)
  const posted = await api('POST', `/team/threads/${room.id}/messages`, { token: P.boss.token, body: { text: '남은 사람끼리 이야기해요' } })
  assert.equal(posted.status, 200, posted.text)
  const [rm2] = await q('select participants from chat_rooms where id=$1', [room.id])
  assert.deepEqual(rm2.participants.filter((p) => !p.is_agent && /^[0-9a-f-]{36}$/.test(p.id)).map((p) => p.id), [P.boss.id])
})

test('IO-G-07 게이트웨이 뒤 이메일 코드: 계정은 있지만 이 회사 구성원이 아닌 주소는 {sent: true} 이고 코드가 가지 않는다', async () => {
  const snap = async () => JSON.stringify(await q(`select confirmation_sent_at, recovery_sent_at, (select count(*) from auth.one_time_tokens o where o.user_id = u.id) n
                                                   from auth.users u where u.id=$1`, [P.elsewhere.id]))
  const before = await snap()
  const r = await api('POST', '/auth/email/start', { body: { email: EMAIL.elsewhere } })
  assert.deepEqual([r.status, r.json.sent], [200, true])
  assert.equal(await snap(), before, '인증 서버에 코드를 청하지 않음')
})

test('IO-G-08 가입 요청 보내기의 한도: 위조 · 다른 회사의 표는 거절, 한 사람은 1분에 한 번, 한 주소는 하루 3곳, 회사는 시간당 기다리는 요청 수까지(거절하면 자리가 빔)', async () => {
  assert.equal((await api('POST', '/auth/join-request', { body: { ticket: 'pgj1.e30.AAAA' } })).status, 400)
  const ticketOf = async (who, tenant = TENANT) => (await api('POST', '/auth/refuse', { token: (await rawSession(EMAIL[who])).access_token, body: {}, tenant })).json.ticket
  const t1 = await ticketOf('asker1')
  assert.equal((await api('POST', '/auth/join-request', { body: { ticket: t1 }, tenant: OTHER })).status, 403, '다른 회사의 표')
  assert.equal((await api('POST', '/auth/join-request', { body: { ticket: t1 } })).status, 201)
  assert.equal((await api('POST', '/auth/join-request', { body: { ticket: t1 } })).status, 429, '1분에 한 번')
  const was = process.env.PRO_JOIN_REQUESTS_PER_HOUR
  const waiting = async () => (await q(`select count(*)::int as n from pro_join_requests where tenant_id=$1 and status='pending' and created_at > now() - interval '1 hour'`, [TENANT]))[0].n
  process.env.PRO_JOIN_REQUESTS_PER_HOUR = String((await waiting()) + 1)
  try {
    assert.equal((await api('POST', '/auth/join-request', { body: { ticket: await ticketOf('asker2') } })).status, 201)
    const t3 = await ticketOf('asker3')
    const third = await api('POST', '/auth/join-request', { body: { ticket: t3 } })
    assert.equal(third.status, 429, '회사의 시간당 한도')
    assert.match(third.json.error, /가입 요청이 많아요/)
    // the administrator declines one: its place is free again, and a real person gets through
    assert.equal((await api('POST', `/team/requests/${P.asker2.id}/reject`, { token: P.boss.token })).status, 200)
    const after = await api('POST', '/auth/join-request', { body: { ticket: await ticketOf('asker4') } })
    assert.equal(after.status, 201, '거절한 요청은 자리를 비운다')
  } finally { if (was === undefined) delete process.env.PRO_JOIN_REQUESTS_PER_HOUR; else process.env.PRO_JOIN_REQUESTS_PER_HOUR = was }
  // one address asks at most PRO_JOIN_REQUESTS_PER_ADDRESS_PER_DAY (3) companies a day
  for (const t of ['pgl-io-cap-a', 'pgl-io-cap-b', 'pgl-io-cap-c']) {
    await q(`insert into pro_join_requests (tenant_id, user_id, email) values ($1, $2, $3) on conflict do nothing`, [`${t}-${RUN}`, P.asker3.id, EMAIL.asker3])
  }
  // (asked at the other company, so the once-a-minute limit of this one does not answer first)
  const capped = await api('POST', '/auth/join-request', { body: { ticket: await ticketOf('asker3', OTHER) }, tenant: OTHER })
  assert.equal(capped.status, 429, capped.text)
  assert.match(capped.json.error, /오늘은 이 주소로/)
  await q(`delete from pro_join_requests where email=$1 and tenant_id like 'pgl-io-cap-%'`, [EMAIL.asker3])
})

test('IO-G-09 에이전트 파일 내려받기와 MCP 게이트웨이는 요청한 회사의 승인된 구성원만', async () => {
  const files = (token) => fetch(`http://127.0.0.1:${BFF}/api/agent-files/run-x?path=a.txt`, { headers: { 'X-Tenant-Id': TENANT, Authorization: `Bearer ${token}` } }).then((r) => r.status)
  assert.equal(await files(P.stranger.token), 403, '다른 회사 사람')
  assert.notEqual(await files(P.boss.token), 403, '구성원은 지나감(뒤의 cli-agent 는 없음)')
  const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'io', version: '1' } } }
  const mcp = (token, tenant = null) => fetch(`http://127.0.0.1:${BFF}/mcp/folders`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}`, ...(tenant ? { 'X-Tenant-Id': tenant } : {}) }, body: JSON.stringify(init) })
    .then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }))
  // a token naming this company (Process GPT writes the company into app_metadata) of someone who is not its member
  await supa.auth.admin.updateUserById(P.elsewhere.id, { app_metadata: { tenant_id: TENANT } })
  const no = await mcp((await rawSession(EMAIL.elsewhere)).access_token)
  assert.deepEqual([no.status, no.json?.error?.code], [403, -32003])
  await supa.auth.admin.updateUserById(P.boss.id, { app_metadata: { tenant_id: TENANT } })
  assert.equal((await mcp((await rawSession(EMAIL.boss)).access_token)).status, 200, '구성원')
  // the request's company (X-Tenant-Id, as the gateway sets it) wins over the token's claim, and the membership is checked there
  await supa.auth.admin.updateUserById(P.boss.id, { app_metadata: { tenant_id: OTHER } })
  const bossOther = (await rawSession(EMAIL.boss)).access_token
  assert.equal((await mcp(bossOther)).status, 403, '토큰이 적은 다른 회사: 그곳의 구성원이 아님')
  assert.equal((await mcp(bossOther, TENANT)).status, 200, '요청한 회사(X-Tenant-Id)가 이김 — 그곳의 구성원')
  assert.equal((await mcp((await rawSession(EMAIL.elsewhere)).access_token, OTHER)).json?.error?.code, -32003, '요청한 회사에서 기다리는 사람')
})

test('IO-G-10 두 회사의 승인된 구성원을 한 회사에서 내보내면: 로그인은 그대로, 다른 회사에서는 그대로 일하고, 이 회사의 자리만 사라진다', async () => {
  const B = P.both
  const s = await rawSession(EMAIL.both)
  assert.equal((await api('GET', '/me', { token: s.access_token })).status, 200)
  assert.equal((await api('GET', '/me', { token: s.access_token, tenant: OTHER })).status, 200)
  const room = (await api('POST', '/team/threads', { token: P.boss.token, body: { members: [B.id] } })).json
  const [folder] = await q(`insert into pro_folders (tenant_id, slug, name, repo_path) values ($1, $2, '두 회사 폴더', '/nonexistent') returning id::text`, [TENANT, `io-both-${RUN}`])
  await q(`insert into pro_folder_members (folder_id, principal_type, principal_id, role) values ($1,'user',$2,'editor')`, [folder.id, B.id])
  const sched = {}
  for (const [k, t] of [['here', TENANT], ['there', OTHER], ['none', null]]) {
    sched[k] = (await q(`insert into pro_schedules (user_id, name, cron, prompt, tenant_id) values ($1, $2, '0 8 * * *', 'x', $3) returning id`, [B.id, `루틴 ${k}`, t]))[0].id
  }
  // a stream opened for each company
  const open = async (tenant) => {
    const ctl = new AbortController()
    const r = await fetch(`http://127.0.0.1:${BFF}/api/events?token=${s.access_token}`, { headers: { 'X-Tenant-Id': tenant }, signal: ctl.signal })
    assert.equal(r.status, 200)
    const reader = r.body.getReader()
    await reader.read()
    const ended = (async () => { for (;;) { const { done } = await reader.read(); if (done) return true } })()
    return { ctl, ended }
  }
  const here = await open(TENANT), there = await open(OTHER)
  assert.equal((await api('POST', `/team/members/${B.id}/remove`, { token: P.boss.token })).json.status, 'rejected')
  assert.equal(await Promise.race([here.ended, new Promise((r) => setTimeout(() => r(false), 5000))]), true, '이 회사의 흐름은 닫힘')
  assert.equal(await Promise.race([there.ended, new Promise((r) => setTimeout(() => r(false), 1500))]), false, '다른 회사의 흐름은 열려 있음')
  here.ctl.abort(); there.ctl.abort()
  assert.ok(!(await supa.auth.getUser(s.access_token)).error, '로그인은 그대로')
  assert.ok((await q('select count(*)::int n from auth.sessions where user_id=$1', [B.id]))[0].n > 0, '세션이 남음')
  assert.equal((await api('GET', '/me', { token: s.access_token, tenant: OTHER })).status, 200, '다른 회사에서는 그대로')
  const out = await api('GET', '/me', { token: s.access_token })
  assert.deepEqual([out.status, out.json.code], [403, 'invite_only'], '이 회사는 막힘')
  const paused = Object.fromEntries(await Promise.all(Object.entries(sched).map(async ([k, sid]) => [k, (await q('select paused from pro_schedules where id=$1', [sid]))[0].paused])))
  assert.deepEqual(paused, { here: true, there: false, none: false }, '이 회사의 루틴만 멈춤')
  const [rm] = await q('select participants from chat_rooms where id=$1', [room.id])
  assert.ok(!rm.participants.some((p) => p.id === B.id), '이 회사의 방에서 빠짐')
  assert.equal((await q('select count(*)::int n from pro_folder_members where folder_id=$1 and principal_id=$2', [folder.id, B.id]))[0].n, 0, '이 회사의 폴더에서 빠짐')
})
