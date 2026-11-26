// Google 연결 behind the ProcessGPT gateway, as production runs (PRO_TENANT_FROM_HEADER=1, no GOOGLE_CLIENT_ID):
// a fake gateway in front (<tenant>.lite.localhost/lite → strips /lite, sets X-Tenant-Id from the address, passes
// no Host), a fake Google (fixtures/fake-google.mjs), a fake judge. No model.
//   - a company's own client (admin only) turns Google on for that company only; 「Google로 계속하기」 stays ProcessGPT's
//   - the redirect URI and the state cookie are the company address's own (/lite/api/auth/google …); a foreign page
//     cannot start one; a callback that comes to another company is refused
//   - the server browser comes back through the company address too, and ends signed in to (fake) Google
//   node test/google-connect-gateway.e2e.mjs
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { startFakeGoogle, SPOTS, TITLES } from './fixtures/fake-google.mjs'
import { startJudge } from './fixtures/walls.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const BFF = Number(process.env.GC_BFF_PORT || 8796)
const TENANT = 'pro-gc-gw', OTHER = 'pro-gc-gw2'
const EMAIL = { admin: 'pro-nb1121-gconnect-gw@uengine.org', member: 'pro-nb1121-gconnect-gw2@uengine.org' }
const COMPANY_CLIENT = 'gw-company.apps.googleusercontent.com'
const SECRET = `gw-secret-${Date.now()}-${Math.random().toString(36).slice(2)}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, what, ms = 20000) => { const end = Date.now() + ms; for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() > end) throw new Error(`기다렸지만 안 됨: ${what}`); await sleep(150) } }

const fake = await startFakeGoogle({ clients: { [COMPANY_CLIENT]: SECRET } })
const judge = await startJudge({ [TITLES.consent]: { login_needed: 0.92, refused: 0.03, human_check: 0.02, ok: 0.03 } })
// the gateway: <tenant>.lite.localhost:<port>/lite/… → the server's /…, X-Tenant-Id from the address, Host not passed on
const gateway = http.createServer((req, res) => {
  const host = String(req.headers.host || '').split(':')[0]
  const tenant = host.endsWith('.lite.localhost') ? host.slice(0, -'.lite.localhost'.length) : ''
  if (!req.url.startsWith('/lite/') || !tenant) { res.writeHead(404); return res.end() }
  const headers = { ...req.headers, host: `127.0.0.1:${BFF}`, 'x-tenant-id': tenant }
  const up = http.request({ host: '127.0.0.1', port: BFF, method: req.method, path: req.url.slice('/lite'.length), headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res) })
  up.on('error', () => { res.writeHead(502); res.end() })
  req.pipe(up)
})
await new Promise((r) => gateway.listen(0, '127.0.0.1', r))
const G = gateway.address().port
const company = (t = TENANT) => `http://${t}.lite.localhost:${G}`
const base = `${company()}/lite`
const llm = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '{}' } }] })) }) })
await new Promise((r) => llm.listen(0, '127.0.0.1', r))
const profiles = fs.mkdtempSync(path.join(os.tmpdir(), 'pro-gcgw-profiles-'))
Object.assign(process.env, {
  PRO_PORT: String(BFF), PRO_PUBLIC_URL: `http://www.lite.localhost:${G}/lite`, PRO_TENANT_FROM_HEADER: '1', PRO_TENANT_ID: 'localhost', PRO_TENANT_HOSTS: '',
  PRO_BACKGROUND: '0', PRO_CONTEXT_ROUTER_URL: '', GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', ...fake.env,
  PRO_JUDGE_URL: judge.url, PRO_JUDGE_LLM: '0', PRO_LLM_BASE_URL: `http://127.0.0.1:${llm.address().port}`, PRO_LLM_API_KEY: 'test',
  PRO_BROWSER_PROFILES: profiles, PRO_MCP_HUB_URL: 'http://127.0.0.1:9',
})
process.chdir(path.resolve(here, '..'))
const { q, pool, admin: supa, sessionFor, ensureUser } = await import('../lib/supa.js')
const { admit } = await import('../lib/membership.js')
const { withTenant } = await import('../lib/tenant.js')
const team = await import('../lib/team.js')
const { getSecret } = await import('../lib/vault.js')
const { companySubject } = await import('../lib/googleClient.js')
const users = {}

// a request as the person's browser makes it, at a company's address
function gw(method, p, { tenant = TENANT, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null
    const r = http.request({ host: '127.0.0.1', port: G, method, path: `/lite${p}`, headers: { host: `${tenant}.lite.localhost:${G}`, ...(data ? { 'content-type': 'application/json' } : {}), ...headers } }, (res) => {
      let text = ''
      res.on('data', (c) => { text += c })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) }))
    })
    r.on('error', reject)
    r.end(data || undefined)
  })
}
const as = (who) => ({ authorization: `Bearer ${users[who].session.access_token}` })

async function cleanup() {
  const listed = await supa.auth.admin.listUsers({ page: 1, perPage: 1000 }).catch(() => ({ data: { users: [] } }))
  const mine = (listed.data?.users || []).filter((u) => Object.values(EMAIL).includes(u.email))
  for (const id of [...mine.map((u) => u.id), companySubject(TENANT), companySubject(OTHER)]) {
    for (const t of ['pro_threads', 'pro_vault_items', 'pro_vault_keys', 'pro_vault_audit', 'pro_mail_accounts', 'pro_mail_seen', 'pro_profile', 'pro_actions'])
      await q(`delete from ${t} where user_id=$1`, [id]).catch(() => {})
    await q('delete from users where id=$1', [id]).catch(() => {})
  }
  for (const t of [TENANT, OTHER]) {
    await q('delete from pro_team_members where tenant_id=$1', [t]).catch(() => {})
    await q('delete from users where tenant_id=$1', [t]).catch(() => {})
    await q('delete from tenants where id=$1', [t]).catch(() => {})
  }
  for (const u of mine) await supa.auth.admin.deleteUser(u.id).catch(() => {})
}

before(async () => {
  await cleanup()
  // the company's people (process-gpt accounts of that tenant); the first one is its administrator
  for (const who of ['admin', 'member']) {
    users[who] = await withTenant(TENANT, async () => {
      // (the account, then the membership — the first one makes the company, the other is let in — then a session: spec team-membership)
      const u = await ensureUser(EMAIL[who], `시험-${who}`)
      if (who === 'admin') await team.claimFirstAdmin(u.id)
      else await admit(u.id, EMAIL[who], `시험-${who}`, u.id)
      return sessionFor(EMAIL[who], `시험-${who}`)
    })
  }
  await import('../index.js')
  await until(() => gw('GET', '/api/config').then((r) => r.status === 200), 'BFF behind the gateway')
})

after(async () => {
  const browser = await import('../lib/browser.js')
  for (const u of Object.values(users)) await browser.close(u.user.id).catch(() => {})
  await cleanup()
  await fake.close(); await judge.close(); llm.close(); gateway.close()
  fs.rmSync(profiles, { recursive: true, force: true })
  await pool.end().catch(() => {})
  setTimeout(() => process.exit(process.exitCode || 0), 300)
})

test('운영처럼: env 클라이언트가 없으면 꺼져 있고, 관리자가 넣은 회사 값은 그 회사에만 · 로그인은 ProcessGPT 그대로', async () => {
  const c0 = (await gw('GET', '/api/config')).json()
  assert.deepEqual([c0.google, c0.googleLogin], [false, false])
  const off = await gw('POST', '/api/auth/google/connect', { headers: { ...as('member'), origin: company() }, body: { mode: 'phone' } })
  assert.equal(off.status, 409)
  assert.match(off.json().error, /관리자/)
  assert.equal((await gw('PUT', '/api/admin/google-client', { headers: { ...as('member'), origin: company() }, body: { clientId: 'x', clientSecret: 'y' } })).status, 403)
  const saved = await gw('PUT', '/api/admin/google-client', { headers: { ...as('admin'), origin: company() }, body: { clientId: COMPANY_CLIENT, clientSecret: SECRET } })
  assert.equal(saved.status, 200)
  assert.deepEqual([saved.json().using, saved.json().redirectUri], ['company', `${base}/api/auth/google/callback`])
  assert.ok(!saved.text.includes(SECRET))
  // the admin screen asks with its page address (a GET carries no Origin): the same URI
  assert.equal((await gw('GET', `/api/admin/google-client?origin=${encodeURIComponent(company())}`, { headers: as('admin') })).json().redirectUri, `${base}/api/auth/google/callback`)
  const cfg = (await gw('GET', '/api/config')).json()
  assert.deepEqual([cfg.google, cfg.googleLogin], [true, false])
  assert.equal((await gw('GET', '/api/config', { tenant: OTHER })).json().google, false, '다른 회사는 여전히 꺼짐')
  const start = await gw('GET', '/api/auth/google/start')
  assert.deepEqual([start.status, start.headers.location], [302, '/lite/login'])
  assert.equal((await gw('GET', '/api/auth/google/start?mail=1')).headers.location, '/lite/settings/accounts')
})

test('휴대폰에서 연결: 회사 주소의 리디렉션·쿠키 경로(/lite/api/auth/google), 다른 사이트에서 시작 불가, 다른 회사로 온 콜백 거부', async () => {
  const foreign = await gw('POST', '/api/auth/google/connect', { headers: { ...as('member'), origin: 'http://evil.example.com' }, body: { mode: 'phone', origin: 'http://evil.example.com' } })
  assert.equal(foreign.status, 400)
  const begin = async () => {
    const r = await gw('POST', '/api/auth/google/connect', { headers: { ...as('member'), origin: company() }, body: { mode: 'phone', origin: company() } })
    assert.equal(r.status, 200)
    const cookie = [].concat(r.headers['set-cookie'] || []).find((c) => c.startsWith('pgpt-oauth-state='))
    return { url: r.json().url, cookie, state: /pgpt-oauth-state=([^;]+)/.exec(cookie)[1] }
  }
  const a = await begin()
  assert.match(a.cookie, /Path=\/lite\/api\/auth\/google(;|$)/)
  assert.doesNotMatch(a.cookie, /Domain=/i, '그 회사 주소에만')
  const asked = new URL(a.url).searchParams
  assert.deepEqual([asked.get('client_id'), asked.get('redirect_uri')], [COMPANY_CLIENT, `${base}/api/auth/google/callback`])
  // the consent came back to another company's address: refused, back to where it started with why
  const back = new URL(await fake.approve(a.url, 'gw.member@example.com'))
  assert.equal(back.origin, company())
  const elsewhere = await gw('GET', `${back.pathname.slice('/lite'.length)}${back.search}`, { tenant: OTHER, headers: { cookie: `pgpt-oauth-state=${a.state}` } })
  assert.equal(elsewhere.status, 302)
  assert.ok(elsewhere.headers.location.startsWith(`${base}/settings/accounts?google_error=`))
  assert.match(decodeURIComponent(elsewhere.headers.location), /다른 작업 공간/)
  assert.equal(await getSecret(users.member.user.id, 'oauth', 'google'), null)
  // started again, back at its own address
  const b = await begin()
  const ok = new URL(await fake.approve(b.url, 'gw.member@example.com'))
  const done = await gw('GET', `${ok.pathname.slice('/lite'.length)}${ok.search}`, { headers: { cookie: `pgpt-oauth-state=${b.state}` } })
  assert.deepEqual([done.status, done.headers.location], [302, `${base}/settings/accounts?google=connected`])
  const sec = await getSecret(users.member.user.id, 'oauth', 'google')
  assert.deepEqual([sec.username, sec.client_id, sec.tenant], ['gw.member@example.com', COMPANY_CLIENT, TENANT])
  assert.equal(fake.log.token.at(-1).redirect_uri, `${base}/api/auth/google/callback`)
})

test('서버 브라우저에서 연결: 회사 주소로 돌아와 카드 완료, 서버 브라우저는 (가짜) Google 에 로그인된 채', async () => {
  const browser = await import('../lib/browser.js')
  browser.WAIT.watchMs = 300
  const r = await gw('POST', '/api/auth/google/connect', { headers: { ...as('admin'), origin: company() }, body: { mode: 'browser', origin: company() } })
  assert.equal(r.status, 200)
  const { taskId } = r.json()
  const card = async () => (await q('select content from pro_messages where id=$1', [taskId]))[0].content
  await until(async () => (await card()).state === 'needs_input', '직접 로그인을 기다림')
  const bctx = await browser.contextFor(users.admin.user.id)
  const st = (await bctx.cookies(`${base}/api/auth/google/callback`)).find((c) => c.name === 'pgpt-oauth-state')
  assert.deepEqual([st?.domain, st?.path, st?.httpOnly], [`${TENANT}.lite.localhost`, '/lite/api/auth/google', true])
  const uid = users.admin.user.id
  await browser.input(uid, { type: 'click', x: SPOTS.email.x / 1280, y: SPOTS.email.y / 800 })
  await browser.input(uid, { type: 'text', text: 'gw.admin@example.com' })
  await browser.input(uid, { type: 'click', x: SPOTS.allow.x / 1280, y: SPOTS.allow.y / 800 })
  const c = await until(async () => { const x = await card(); return x.state === 'done' && x }, '카드 완료', 30000)
  assert.match(c.summary, /gw\.admin@example\.com/)
  const sec = await getSecret(uid, 'oauth', 'google')
  assert.deepEqual([sec.username, sec.tenant], ['gw.admin@example.com', TENANT])
  assert.ok((await bctx.cookies(fake.url)).some((x) => x.name === 'SID'))
  assert.ok(bctx.pages().some((p) => p.url().startsWith(`${base}/api/auth/google/done`)), bctx.pages().map((p) => p.url()).join(' '))
})
