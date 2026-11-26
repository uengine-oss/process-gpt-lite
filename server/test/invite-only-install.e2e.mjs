// Invite-only on an installed Lite (no gateway: one company, its own sign-ins — the e-mail code and the install's own Google client),
// over HTTP against this server (port 9045) and the real local database and auth server. Spec openspec/specs/team-membership.
// A company of its own that nobody runs yet; a fake Google (fixtures/fake-google.mjs, the install's client); no completion (an install
// without the process engine — invitations take Lite's own path). No model.
//   IO-S-01 the first person of a company nobody runs (Google) makes it: its administrator, an approved member, the tenant's owner — two
//           signing in at once: one makes it, the other is refused like anyone uninvited (no row)
//   IO-S-02 then an uninvited new address: the same answer and no code, a wrong code refused, Google refused before any session — the
//           refusal screen's words come once by a key (no account made, the key works once)
//   IO-S-03 an account that is not a member here: its code request answers {sent: true}; proving the address with a real code is refused
//           (invite_only) with nothing kept, and 「가입 요청 보내기」 keeps the request
//   IO-S-04 a member with a real code gets a session; the local demo code (PRO_DEMO_LOGIN, development only) still signs up a new address
//   IO-S-05 the administrator invites someone (Lite's own path — Supabase's invitation, the account, the row approved) → Google sign-in
//           comes in; 「내보내기」 ends it — the next request and the next sign-in are refused
//   node test/invite-only-install.e2e.mjs        (IO_BFF_PORT · IO_FAKE_PORT to move the ports)
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { startFakeGoogle } from './fixtures/fake-google.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const BFF = Number(process.env.IO_BFF_PORT || 9045)
const RUN = crypto.randomBytes(3).toString('hex')
const TENANT = `pgl-ioi-${RUN}`
const mail = (who) => `pro-rt-ioi-${who}-${RUN}@uengine.org`
const EMAIL = { first: mail('first'), rival: mail('rival'), newbie: mail('newbie'), known: mail('known'), demo: mail('demo'), guest: mail('guest') }
const CLIENT = 'install-io.apps.googleusercontent.com', SECRET = `io-${RUN}`

const fake = await startFakeGoogle({ clients: { [CLIENT]: SECRET } })
Object.assign(process.env, {
  PRO_PORT: String(BFF), PRO_PUBLIC_URL: `http://127.0.0.1:${BFF}`, PRO_TENANT_FROM_HEADER: '0', PRO_TENANT_ID: TENANT, PRO_TENANT_HOSTS: '',
  PRO_BACKGROUND: '0', PRO_ONTOLOGY_WORKER: '0', PRO_SCENARIOS: 'off', PRO_CONTEXT_ROUTER_URL: '', PRO_DEMO_LOGIN: '1',
  PRO_COMPLETION_URL: 'http://127.0.0.1:9', PRO_LLM_BASE_URL: 'http://127.0.0.1:9/v1', PRO_LLM_API_KEY: 'test', PRO_MCP_HUB_URL: 'http://127.0.0.1:9',
  GOOGLE_CLIENT_ID: CLIENT, GOOGLE_CLIENT_SECRET: SECRET, ...fake.env,
})
process.chdir(path.resolve(here, '..'))
const { q, pool, admin: supa } = await import('../lib/supa.js')
const { config } = await import('../config.js')

async function api(method, p, { token, body } = {}) {
  const r = await fetch(`http://127.0.0.1:${BFF}/api${p}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined,
  })
  const text = await r.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* not JSON */ }
  return { status: r.status, json }
}
// 「Google로 계속하기」 on this install, as a browser goes: start (the state cookie) → Google's consent → back to the callback
// → where the page is sent: {path, hash, query}
async function googleSignIn(email) {
  const start = await fetch(`http://127.0.0.1:${BFF}/api/auth/google/start`, { redirect: 'manual' })
  const cookie = (start.headers.get('set-cookie') || '').split(';')[0]
  const back = await fake.approve(start.headers.get('location'), email)
  const cb = await fetch(back, { redirect: 'manual', headers: { cookie } })
  const to = new URL(cb.headers.get('location'))
  return { path: to.pathname, hash: decodeURIComponent(to.hash.slice(1)), query: to.searchParams }
}
// a real e-mail code for an account (the auth server's own one-time code, as its mail would carry)
async function realCode(email) {
  const { data, error } = await supa.auth.admin.generateLink({ type: 'magiclink', email })
  if (error) throw error
  return data.properties.email_otp
}
const account = async (email) => (await q('select id::text as id from auth.users where email = $1', [email]))[0]?.id || null
const row = async (email) => (await q('select membership_status as s, role, is_admin from users where tenant_id=$1 and email=$2', [TENANT, email]))[0] || null
const P = {}

async function cleanup() {
  const ids = (await q('select id::text as id from auth.users where email = any($1)', [Object.values(EMAIL)])).map((r) => r.id)
  for (const id of ids) {
    for (const t of ['pro_threads', 'pro_profile', 'pro_actions', 'pro_mail_accounts']) await q(`delete from ${t} where user_id=$1`, [id]).catch(() => {})
    await q('delete from users where id=$1', [id]).catch(() => {})
  }
  for (const tb of ['pro_team_members', 'pro_team_removed', 'pro_role_assignments', 'pro_join_requests']) await q(`delete from ${tb} where tenant_id=$1`, [TENANT]).catch(() => {})
  await q('delete from users where tenant_id=$1', [TENANT]).catch(() => {})
  await q('delete from tenants where id=$1', [TENANT]).catch(() => {})
  for (const id of ids) await supa.auth.admin.deleteUser(id).catch(() => {})
}

before(async () => {
  await cleanup()
  // an account of the auth server that is not a member of this company (a Process GPT account of elsewhere)
  const { data, error } = await supa.auth.admin.createUser({ email: EMAIL.known, email_confirm: true })
  if (error) throw error
  P.known = { id: data.user.id }
  await import('../index.js')
  for (let i = 0; i < 100; i++) { if ((await fetch(`http://127.0.0.1:${BFF}/api/config`).catch(() => null))?.ok) break; await new Promise((r) => setTimeout(r, 200)) }
})

after(async () => {
  await cleanup()
  await fake.close()
  await pool.end().catch(() => {})
  setTimeout(() => process.exit(process.exitCode || 0), 300)
})

test('IO-S-01 아무도 운영하지 않는 회사의 첫 사람(Google)이 회사를 만든다: 관리자 · 승인 · 주인 — 둘이 동시에 오면 한 사람만', async () => {
  assert.equal((await api('GET', '/config')).json.googleLogin, true)
  const both = await Promise.all([googleSignIn(EMAIL.first), googleSignIn(EMAIL.rival)])
  assert.deepEqual(both.map((g) => g.path).sort(), ['/auth/done', '/invite-only'], JSON.stringify(both.map((g) => g.path)))
  const won = both.findIndex((g) => g.path === '/auth/done')
  if (won === 1) [EMAIL.first, EMAIL.rival] = [EMAIL.rival, EMAIL.first]
  const login = JSON.parse(both[won].hash)
  assert.ok(login.session.access_token)
  assert.equal(login.user.email, EMAIL.first)
  P.first = { id: login.user.id, token: login.session.access_token }
  assert.equal(await row(EMAIL.rival), null, '진 사람은 행이 없음')
  assert.deepEqual(await row(EMAIL.first), { s: 'approved', role: 'admin', is_admin: true })
  assert.equal((await q('select owner::text from tenants where id=$1', [TENANT]))[0].owner, P.first.id)
  const me = (await api('GET', '/me', { token: P.first.token })).json
  assert.equal(me.admin, true)
})

test('IO-S-02 그 뒤 초대받지 않은 새 주소: 코드도 계정도 없고, Google 은 세션 전에 막힘 — 화면의 말은 열쇠로 한 번', async () => {
  const s = await api('POST', '/auth/email/start', { body: { email: EMAIL.newbie } })
  assert.deepEqual([s.status, s.json.sent], [200, true])
  assert.equal((await api('POST', '/auth/email/verify', { body: { email: EMAIL.newbie, code: '123456' } })).status, 400)
  assert.equal(await account(EMAIL.newbie), null)
  const g = await googleSignIn(EMAIL.newbie)
  assert.equal(g.path, '/invite-only')
  assert.equal(g.hash, '', '세션 없음')
  const k = g.query.get('k')
  const said = await api('GET', `/auth/refusal/${k}`)
  assert.deepEqual([said.status, said.json.code, said.json.pending, said.json.email, said.json.company], [200, 'invite_only', false, EMAIL.newbie, TENANT])
  assert.equal(said.json.title, '초대받은 분만 들어올 수 있어요.')
  assert.equal((await api('GET', `/auth/refusal/${k}`)).status, 404, '열쇠는 한 번만')
  assert.equal(await account(EMAIL.newbie), null, '계정이 생기지 않음')
  assert.equal(await row(EMAIL.newbie), null)
})

test('IO-S-03 이 회사 구성원이 아닌 계정: 코드 요청은 {sent: true}, 진짜 코드로 증명하면 거절 · 아무것도 남기지 않고, 「가입 요청 보내기」로 요청', async () => {
  const start = await api('POST', '/auth/email/start', { body: { email: EMAIL.known } })
  assert.deepEqual([start.status, start.json.sent], [200, true], '인증 서버의 대답과 상관없이')
  const v = await api('POST', '/auth/email/verify', { body: { email: EMAIL.known, code: await realCode(EMAIL.known) } })
  assert.deepEqual([v.status, v.json.code, v.json.pending, v.json.canRequest], [403, 'invite_only', false, true])
  assert.ok(!v.json.session)
  assert.equal(await row(EMAIL.known), null)
  assert.deepEqual((await api('GET', '/team/requests', { token: P.first.token })).json, [], '누르기 전에는 요청이 없음')
  const j = await api('POST', '/auth/join-request', { body: { ticket: v.json.ticket } })
  assert.deepEqual([j.status, j.json.pending], [201, true])
  assert.deepEqual((await api('GET', '/team/requests', { token: P.first.token })).json.map((r) => r.email), [EMAIL.known])
  // and again: still waiting, told so
  const again = await api('POST', '/auth/email/verify', { body: { email: EMAIL.known, code: await realCode(EMAIL.known) } })
  assert.deepEqual([again.status, again.json.pending], [403, true])
})

test('IO-S-04 구성원은 진짜 코드로 들어오고, 로컬 데모 코드는 개발용으로 새 주소를 예전처럼 받음', async () => {
  const v = await api('POST', '/auth/email/verify', { body: { email: EMAIL.first, code: await realCode(EMAIL.first) } })
  assert.equal(v.status, 200)
  assert.ok(v.json.session.access_token)
  const d = await api('POST', '/auth/email/verify', { body: { email: EMAIL.demo, code: '000000' } })
  assert.equal(d.status, 200)
  assert.equal((await row(EMAIL.demo)).s, 'approved')
})

test('IO-S-05 관리자가 초대한 사람은 Google 로 들어오고, 내보내면 다음 요청과 다음 로그인이 막힘', async () => {
  const inv = await api('POST', '/team/invites', { token: P.first.token, body: { emails: EMAIL.guest } })
  assert.equal(inv.json[0].result, 'invited')
  assert.equal((await row(EMAIL.guest)).s, 'approved')
  const g = await googleSignIn(EMAIL.guest)
  assert.equal(g.path, '/auth/done')
  const guest = JSON.parse(g.hash)
  assert.equal((await api('GET', '/me', { token: guest.session.access_token })).status, 200)
  // approve the request from IO-S-03, then let the guest go
  assert.equal((await api('POST', `/team/requests/${P.known.id}/approve`, { token: P.first.token })).status, 200)
  assert.equal((await api('POST', `/team/members/${guest.user.id}/remove`, { token: P.first.token })).json.status, 'rejected')
  // (the session ends at the auth server — the token is no one's any more)
  assert.equal((await api('GET', '/me', { token: guest.session.access_token })).status, 401)
  const g2 = await googleSignIn(EMAIL.guest)
  assert.equal(g2.path, '/invite-only', '다시 로그인해도 막힘')
  const said = (await api('GET', `/auth/refusal/${g2.query.get('k')}`)).json
  assert.deepEqual([said.pending, said.canRequest], [false, false], '내보낸 사람은 요청이 아니고 요청할 수도 없음')
  const code = await api('POST', '/auth/email/verify', { body: { email: EMAIL.guest, code: await realCode(EMAIL.guest) } })
  assert.equal(code.status, 403)
  // the approved one comes in with a code now
  assert.equal((await api('POST', '/auth/email/verify', { body: { email: EMAIL.known, code: await realCode(EMAIL.known) } })).status, 200)
  assert.equal(config.tenantId, TENANT)
})
