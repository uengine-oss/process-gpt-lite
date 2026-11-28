// MCP 경로도 화면 API 와 같은 로그인 확인(회사 소속 포함)을 쓴다 (lib/mcpAuth.js · mcp/*.js, 스펙 agent-tools
// 「MCP 경로도 화면 API 와 같은 로그인 확인을 쓴다」) — 실제 개발 DB · 로컬 GoTrue, 설정마다 MCP 경로만 띄운 서버 하나
// (fixtures/mcpAuthServer.mjs, 자식 프로세스: 설정은 시작할 때 읽히므로). 사람 · 회사는 이 시험이 만들고 끝에 지운다.
//   MA-01 한 회사 설치: 구성원도, 그 회사 users 행이 없는 사람도 예전처럼 모든 MCP 경로가 답하고 도구가 돈다
//   MA-02 게이트웨이 뒤(PRO_TENANT_FROM_HEADER=1): 토큰에 든 회사의 구성원은 모든 경로가 답하고 그 회사에서 도구가 돈다 ·
//         그 회사 구성원이 아니면 모든 경로가 403 (화면 API auth() 와 같은 규칙) · MCP 경로의 회사는 X-Tenant-Id 가 아니라 토큰의 회사
//   MA-03 게이트웨이 뒤, 토큰에 회사가 없으면 예전과 같다 — 거절 없이 예전처럼 정해지는 회사(이 설치의 PRO_TENANT_ID)에서 돈다
//   MA-04 호스트 이름별 회사(PRO_TENANT_HOSTS): 거절 없이 그 사람의 회사에서 돈다 (화면 API 와 같이)
//   MA-05 어느 설정에서나: 토큰 없음 · 채우지 않은 {{user_jwt}} 는 익명 목록 그대로(mcp-hub 검증 · D-AT), 잘못된 토큰은 401
//   MA-06 로그인 서버가 답하지 못하면 503 + X-Auth-Retry (화면 API 와 같이), 익명 목록은 그대로
// Run: node --test --test-concurrency=1 test/mcpAuth.integration.test.js  (needs the local Supabase)
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
process.env.DOTENV_CONFIG_QUIET = 'true'
process.env.PRO_BACKGROUND = '0'
const { q, pool, admin } = await import('../lib/supa.js')
const { config } = await import('../config.js')
const { LITE_TOOL_SERVERS, CRAFT_APP_NAMES } = await import('../mcp/toolServers.js')
const db = await q('select 1 from users limit 1').then(() => true).catch(() => false)

const hex = crypto.randomBytes(3).toString('hex')
const TA = `pro-ma-a-${hex}`, TB = `pro-ma-b-${hex}`, TM = `pro-ma-m-${hex}`
const HOST = `ma-${hex}.localhost`
// every MCP path this server answers: the built-in tool servers and the connectors (the browser one among them)
const PATHS = ['/mcp', ...['google', 'youtube', 'slack', 'github', 'notion', 'browser'].map((c) => `/mcp/${c}`), ...LITE_TOOL_SERVERS.flatMap((s) => s.paths.map((p) => `/mcp/${p}`))]
// (an anonymous tools/list of an ArtCraft app starts its CLI for the catalog: there the anonymous check is a call, answered 「unauthorized」)
const isCraft = (p) => CRAFT_APP_NAMES.includes(p.split('/').pop())
const NOWHERE = 'http://127.0.0.1:9'

// ---- people: their own accounts and tokens; the token carries app_metadata.tenant_id as ProcessGPT's do ----
const people = {}
async function person(key, { tenant, memberOf }) {
  const email = `ma-${key}-${hex}@example.test`
  const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: true, user_metadata: { name: `시험 ${key}` }, ...(tenant ? { app_metadata: { tenant_id: tenant } } : {}) })
  if (error) throw error
  for (const t of memberOf) {
    await q(`insert into public.users (id, username, email, tenant_id, role, is_admin, is_agent, is_draft, permission_ids)
             values ($1,$2,$3,$4,'user',false,false,false,'{}') on conflict (id, tenant_id) do nothing`, [data.user.id, `시험 ${key}`, email, t])
  }
  const { data: link, error: le } = await admin.auth.admin.generateLink({ type: 'magiclink', email })
  if (le) throw le
  const s = await (await fetch(`${config.supabaseUrl}/auth/v1/verify`, { method: 'POST', headers: { apikey: config.anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', token_hash: link.properties.hashed_token }) })).json()
  assert.ok(s.access_token, 'session')
  people[key] = { id: data.user.id, token: s.access_token }
}

// ---- one server per setting ----
const servers = []
async function start(env) {
  const child = spawn(process.execPath, [path.join(here, 'fixtures/mcpAuthServer.mjs')], {
    cwd: path.join(here, '..'),
    env: { ...process.env, PRO_BACKGROUND: '0', DOTENV_CONFIG_QUIET: 'true', PRO_TENANT_ID: TA, PRO_TENANT_FROM_HEADER: '0', PRO_TENANT_HOSTS: '',
      PRO_MCP_HUB_URL: NOWHERE, PRO_OFFICE_MCP_URL: NOWHERE, PRO_DEEPAGENTS_URL: NOWHERE, PRO_COMPLETION_URL: NOWHERE, PRO_CLI_AGENT_URL: NOWHERE,
      PRO_CONTEXT_ROUTER_URL: '', PRO_JUDGE_URL: '', PRO_JUDGE_LLM: '0', PRO_EMBED_URL: '', PRO_ONTOLOGY_WORKER: '0', PRO_SCENARIOS: 'off', PRO_LLM_KEYS: 'off', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  servers.push(child)
  let out = ''
  const port = await new Promise((ok, fail) => {
    const t = setTimeout(() => fail(new Error(`server did not start:\n${out.slice(-2000)}`)), 30_000)
    const read = (b) => { out += b; const m = /PORT=(\d+)/.exec(out); if (m) { clearTimeout(t); ok(Number(m[1])) } }
    child.stdout.on('data', read)
    child.stderr.on('data', (b) => { out += b })
    child.on('exit', (code) => { clearTimeout(t); fail(new Error(`server exited ${code}:\n${out.slice(-2000)}`)) })
  })
  return `http://127.0.0.1:${port}`
}

let rpcId = 0
async function rpc(base, p, token, method, params = {}, headers = {}) {
  const r = await fetch(`${base}${p}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(token != null ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) })
  return { status: r.status, retry: r.headers.get('x-auth-retry'), body: await r.json().catch(() => null) }
}
const list = (base, p, token, headers) => rpc(base, p, token, 'tools/list', {}, headers)
const call = (base, p, token, name, args = {}) => rpc(base, p, token, 'tools/call', { name, arguments: args })
const probe = async (base, token, headers) => rpc(base, '/mcp/__probe', token, 'probe', {}, headers)

// every path, as a person: the HTTP status each answers
async function statuses(base, token) {
  const out = {}
  for (const p of PATHS) out[p] = (await list(base, p, token)).status
  return out
}
const all = (s) => Object.fromEntries(PATHS.map((p) => [p, s]))
// the person's tools really run: a folder and a panel-app call (database reads in the request's tenant)
async function toolsRun(base, token) {
  const f = await call(base, '/mcp/folders', token, 'folder_catalog', { query: '' })
  assert.equal(f.status, 200)
  assert.equal(f.body?.result?.isError, undefined, JSON.stringify(f.body))
  assert.ok(f.body.result.content[0].text.length > 0)
  const a = await call(base, '/mcp/panelapps', token, 'panel_app_list')
  assert.equal(a.status, 200)
  assert.equal(a.body?.result?.isError, undefined, JSON.stringify(a.body))
}

// MA-05, in every setting
async function anonymousAndInvalid(base) {
  for (const p of PATHS) {
    if (isCraft(p)) {
      const r = await call(base, p, null, `${p.split('/').pop()}_start`)
      assert.equal(r.status, 200, p)
      assert.match(r.body.result.content[0].text, /^unauthorized: call with the user JWT/, p)
    } else {
      const r = await list(base, p, null)
      assert.equal(r.status, 200, p)
      assert.ok(r.body.result || r.body.error, p)
    }
    // the placeholder a validator sends as it is: no person, the catalog (an ArtCraft app: only its switch)
    const ph = await list(base, p, '{{user_jwt}}')
    assert.equal(ph.status, 200, `${p} placeholder`)
    for (const bad of ['not-a-token', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIwMDAwMDAwMC0wMDAwLTAwMDAtMDAwMC0wMDAwMDAwMDAwMDAiLCJleHAiOjk5OTk5OTk5OTl9.c2lnbmF0dXJl']) {
      const r = await list(base, p, bad)
      assert.equal(r.status, 401, `${p} invalid token`)
      assert.equal(r.body.error.code, -32001)
    }
  }
  const tl = await list(base, '/mcp/folders', null)
  assert.ok(tl.body.result.tools.some((t) => t.name === 'folder_catalog'), 'anonymous catalog lists the tools')
  assert.deepEqual((await probe(base, '{{ user_jwt }}')).body, { user: null, placeholder: true, tenant: (await probe(base, null)).body.tenant })
}

before(async () => {
  if (!db) return
  for (const t of [TA, TB, TM]) await q('insert into tenants (id) values ($1) on conflict (id) do nothing', [t])
  // member: token of TA, a member of TA · other: token of TA, a member of TB only · noClaim: no tenant in the token, a member of TA ·
  // noClaimOther: no tenant in the token, a member of TB only · hostPerson: token of TM (the host-name tenant), a member of TM
  await person('member', { tenant: TA, memberOf: [TA] })
  await person('other', { tenant: TA, memberOf: [TB] })
  await person('noclaim', { tenant: null, memberOf: [TA] })
  await person('noclaimother', { tenant: null, memberOf: [TB] })
  await person('host', { tenant: TM, memberOf: [TM] })
})

after(async () => {
  for (const c of servers) c.kill('SIGTERM')
  if (db) {
    for (const p of Object.values(people)) {
      await q('delete from public.users where id=$1', [p.id]).catch(() => {})
      await q('delete from pro_profile where user_id=$1', [p.id]).catch(() => {})
      await admin.auth.admin.deleteUser(p.id).catch(() => {})
    }
    for (const t of [TA, TB, TM]) await q('delete from tenants where id=$1', [t]).catch(() => {})
  }
  await pool.end().catch(() => {})
})

test('MA-01 한 회사 설치: 구성원도, 그 회사 users 행이 없는 사람도 예전처럼 모든 경로가 답하고 도구가 돈다 (MA-05 포함)', { skip: !db }, async () => {
  const base = await start({})
  await anonymousAndInvalid(base)
  for (const k of ['member', 'other', 'noclaimother']) {
    assert.deepEqual(await statuses(base, people[k].token), all(200), k)
    await toolsRun(base, people[k].token)
    assert.deepEqual((await probe(base, people[k].token)).body, { user: people[k].id, placeholder: false, tenant: TA }, k)
  }
})

test('MA-02 · MA-03 게이트웨이 뒤: 토큰에 든 회사의 구성원은 통과하고 그 회사에서 돌고, 아니면 모든 경로가 403 · 토큰에 회사가 없으면 예전과 같다 (MA-05 포함)', { skip: !db }, async () => {
  const base = await start({ PRO_TENANT_FROM_HEADER: '1' })
  await anonymousAndInvalid(base)
  // MA-02: a member of the token's tenant
  assert.deepEqual(await statuses(base, people.member.token), all(200))
  await toolsRun(base, people.member.token)
  assert.deepEqual((await probe(base, people.member.token)).body, { user: people.member.id, placeholder: false, tenant: TA })
  // a person whose token names a tenant they are not a member of: refused on every path, as the screen API refuses them
  assert.deepEqual(await statuses(base, people.other.token), all(403))
  const r = await call(base, '/mcp/folders', people.other.token, 'folder_catalog', { query: '' })
  assert.equal(r.status, 403)
  assert.deepEqual(r.body, { jsonrpc: '2.0', error: { code: -32001, message: 'not a member of this tenant' }, id: null })
  // the tenant of an MCP call is the token's: a header naming another one does not change it, either way
  assert.equal((await probe(base, people.other.token, { 'X-Tenant-Id': TB })).status, 403)
  assert.deepEqual((await probe(base, people.member.token, { 'X-Tenant-Id': TB })).body.tenant, TA)
  // MA-03: no tenant in the token — as before: no refusal, the tenant resolved as it always was (this install's, PRO_TENANT_ID)
  for (const k of ['noclaim', 'noclaimother']) {
    assert.deepEqual(await statuses(base, people[k].token), all(200), k)
    await toolsRun(base, people[k].token)
    assert.deepEqual((await probe(base, people[k].token)).body, { user: people[k].id, placeholder: false, tenant: TA }, k)
  }
})

test('MA-04 호스트 이름별 회사: 거절 없이 그 사람의 회사에서 돈다, 화면 API 와 같이 (MA-05 포함)', { skip: !db }, async () => {
  const base = await start({ PRO_TENANT_HOSTS: `${HOST}=${TM}` })
  await anonymousAndInvalid(base)
  assert.deepEqual(await statuses(base, people.host.token), all(200))
  await toolsRun(base, people.host.token)
  assert.equal((await probe(base, people.host.token)).body.tenant, TM)
  for (const k of ['member', 'other', 'noclaimother']) {
    assert.deepEqual(await statuses(base, people[k].token), all(200), k)
    assert.equal((await probe(base, people[k].token)).body.tenant, TA, k)
  }
})

test('MA-06 로그인 서버가 답하지 못하면 503 + X-Auth-Retry, 익명 목록은 그대로', { skip: !db }, async () => {
  const base = await start({ PRO_SUPABASE_URL: NOWHERE, PRO_TENANT_FROM_HEADER: '1' })
  for (const p of ['/mcp/folders', '/mcp/team', '/mcp/browser', `/mcp/${CRAFT_APP_NAMES[0]}`]) {
    const r = await list(base, p, people.member.token)
    assert.equal(r.status, 503, p)
    assert.equal(r.retry, '1', p)
    assert.equal(r.body.error.message, 'auth unavailable')
  }
  const anon = await list(base, '/mcp/folders', null)
  assert.equal(anon.status, 200)
  assert.ok(anon.body.result.tools.length > 0)
})
