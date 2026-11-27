// 설치된 도구가 에이전트에게도 이어져 있는가(lib/agentTools.js → /api/config agentTools). 2026-11-25 운영: PhotoCraft 를 열어 둔 채
// 「배경색을 옅은 하늘색으로」 → 「PhotoCraft 편집 도구가 현재 연결되지 않아 …」. 편집기와 CLI 는 서버에 있었지만 회사(테넌트)의 MCP 목록에
// 그 도구가 없었다. 로컬은 목록이 차 있어 회귀 시험이 모두 통과했다. 여기서는 판단만(데이터베이스 · 모델 없이):
//   - 이름: 허브가 묶는 목록(connectors.js) · 공통 목록이 실어야 할 이름 · 이 서버의 경로가 한 목록(mcp/toolServers.js)에서 나온다
//   - 출처 둘 중 하나면 이어짐: tenant(켜진 항목의 주소가 이 서버의 /mcp/<경로>, 사람의 토큰을 넘김) · common(deepagents
//     /mcp/common 에 그 이름이 있고 그 항목이 에이전트가 받는 것) — 회사가 그 이름으로 끈 것(enabled:false)은 아님
//   - mcp-hub 는 출처가 아니다(에이전트에 연결을 주지 않고 거르기만 한다): 허브가 답하는데 그 이름이 없으면 hub-filtered 로 이어지지 않음
//   - common 은 deepagents merge_common_mcp_servers 그대로: 회사 목록의 같은 이름 항목이 url · command 를 가지면 공통 항목을 통째로
//     바꾸고, 없으면 그 위에 얹힌다({enabled:false} 는 끔, {enabled:true} 는 공통 주소 그대로). 그 이름으로 다른 곳을 가리키면
//     tenant-overrides-common-with-other-url 로 드러난다(이어짐 아님)
//   - 에이전트가 다른 곳(게이트웨이 뒤 · Docker)에서 돌면 localhost 주소는 이 서버에 닿지 않는다
//   - 회사 목록을 못 읽으면(데이터베이스 오류 · 시간 초과) 모두 아님. 허브 · 공통 목록이 없거나 404 면 그것만 빠진다
//   - 1분 동안 기억, 실패는 10초
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

process.env.SERVICE_ROLE_KEY ||= 'test-service-key'
process.env.ANON_KEY ||= 'test-anon-key'
const { decide, shape, agentToolsChecker, tenantReaches, wired, agentsElsewhere, OVERRIDDEN, HUB_FILTERED } = await import('../lib/agentTools.js')
const { config } = await import('../config.js')
const { LITE_TOOL_SERVERS, LITE_TOOL_SERVER_NAMES, CRAFT_APP_NAMES, OFFICE_SERVER_PATH } = await import('../mcp/toolServers.js')

const tool = (key) => LITE_TOOL_SERVERS.find((t) => t.key === key)
const on = (via) => Object.keys(via).filter((k) => wired(via[k]))
const entry = (url, more = {}) => ({ url, type: 'streamable-http', headers: { Authorization: 'Bearer {{user_jwt}}' }, ...more })
const ALL = LITE_TOOL_SERVERS.map((t) => t.key)

test('이름은 한 목록: 허브가 묶는 이름 = 공통 목록 이름 = pgpt-<이 서버의 경로>, ArtCraft 앱 · 이음오피스 이름과 같다', async () => {
  assert.deepEqual(LITE_TOOL_SERVER_NAMES, ['pgpt-folders', 'pgpt-panelapps', 'pgpt-improve', 'pgpt-team', 'pgpt-cadcraft', 'pgpt-vectorcraft', 'pgpt-photocraft', 'pgpt-soundcraft', 'pgpt-filmcraft', 'pgpt-ieumoffice-live-editor'])
  // (entered the way the server's imports reach them: test/craftInstall.test.js)
  await import('../lib/craftWork.js')
  const { CRAFT_APPS } = await import('../mcp/craft.js')
  const { OFFICE_MCP } = await import('../mcp/office.js')
  assert.deepEqual(CRAFT_APP_NAMES, Object.keys(CRAFT_APPS))
  assert.equal(OFFICE_SERVER_PATH, OFFICE_MCP)
  const fs = await import('node:fs/promises')
  const src = await fs.readFile(new URL('../mcp/connectors.js', import.meta.url), 'utf8')
  assert.match(src, /const ALWAYS = LITE_TOOL_SERVER_NAMES\b/, 'connectors.js 의 허브 묶음은 같은 목록')
})

test('hub: 허브만으로는 이어지지 않는다 — 허브가 답하는데 그 이름이 없으면 hub-filtered 로 이어지지 않음', () => {
  const hub = new Set(['pgpt-photocraft', 'pgpt-folders', 'something-else'])
  // the hub alone: nothing (it gives no connection)
  const alone = decide({ hub, tenant: null })
  assert.deepEqual(on(alone), [])
  assert.deepEqual(alone['craft.photocraft'], [])
  assert.deepEqual(alone['craft.cadcraft'], [HUB_FILTERED])
  // with the common list: what the hub has stays wired, what it lacks is filtered out
  const via = decide({ hub, common: new Set(LITE_TOOL_SERVER_NAMES), tenant: null })
  assert.deepEqual(via['craft.photocraft'], ['common'])
  assert.deepEqual(via['craft.cadcraft'], ['common', HUB_FILTERED])
  assert.deepEqual(on(via).sort(), ['craft.photocraft', 'folders'])
  // no hub answering (production): no filtering
  assert.deepEqual(on(decide({ common: new Set(LITE_TOOL_SERVER_NAMES), tenant: null })), ALL)
})

test('tenant: 키가 아니라 주소로 — 켜진 항목이 이 서버의 /mcp/<경로> 로 가고 사람의 토큰을 넘기면 이어짐', () => {
  const tenant = {
    'my-photo': entry('http://process-gpt-lite-server:8787/mcp/photocraft'),
    // a prefix in front and a trailing slash are the same place
    vec: entry('https://acme.example/lite/mcp/vectorcraft/'),
    // IeumOffice: the long name and the short alias are the same tools
    office: entry('http://lite:8787/mcp/office'),
    // no enabled flag = on (deepagents' rule)
    'pgpt-folders': { url: 'http://localhost:8787/mcp/folders', headers: { authorization: 'Bearer {{user_jwt}}' } },
  }
  const via = decide({ tenant, elsewhere: false })
  assert.deepEqual(on(via).sort(), ['craft.photocraft', 'craft.vectorcraft', 'folders', 'office'])
  assert.deepEqual(via['craft.photocraft'], ['tenant'])
  assert.equal(tenantReaches(tool('office'), { x: entry('http://lite/mcp/ieumoffice-live-editor') }), true)
})

test('tenant: 꺼진 항목(enabled:false)은 아님', () => {
  const via = decide({ tenant: { 'pgpt-photocraft': entry('http://lite:8787/mcp/photocraft', { enabled: false }) } })
  assert.deepEqual(via['craft.photocraft'], [])
})

test('tenant: 다른 곳을 가리키는 주소 · 토큰을 넘기지 않는 항목은 아님', () => {
  const tenant = {
    agg: entry('http://lite:8787/mcp'), // the connectors' aggregate endpoint, not the app
    old: entry('http://lite:8787/mcp/photocraft-old'),
    other: entry('http://elsewhere:9000/x/photocraftmcp/photocraft2'),
    'pgpt-filmcraft': entry('http://lite:8787/mcp-filmcraft'),
    weld: entry('http://weld:8000/weld/mcp-exec/'),
    stdio: { command: 'photocraft-cli', args: ['mcp'] },
    bad: entry('not a url /mcp/soundcraft'),
    // reaches the app but every call would be refused as unauthorized
    anon: { url: 'http://lite:8787/mcp/cadcraft', type: 'streamable-http' },
    fixed: { url: 'http://lite:8787/mcp/improve', headers: { 'X-Other': '{{user_jwt}}' } },
  }
  assert.deepEqual(on(decide({ tenant })), [])
})

test('회사 행이 없으면(null) 회사 목록으로는 아무것도 — 허브 · 공통 목록이 없으면 모두 false', () => {
  assert.deepEqual(on(decide({ tenant: null })), [])
  assert.deepEqual(on(decide({ tenant: null, common: new Set(['pgpt-photocraft']) })), ['craft.photocraft'])
})

test('회사 목록을 읽지 못하면(undefined) 허브 · 공통 목록에 있어도 모두 false (닫힌 쪽으로)', () => {
  const via = decide({ tenant: undefined, hub: new Set(LITE_TOOL_SERVER_NAMES), common: new Set(LITE_TOOL_SERVER_NAMES) })
  assert.deepEqual(on(via), [])
  assert.deepEqual(Object.keys(via), ALL)
})

test('common: 공통 목록에 그 이름이 있으면 이어짐, 회사가 그 이름으로 끈 것은 아님', () => {
  const common = new Set(['pgpt-photocraft', 'pgpt-cadcraft', 'pgpt-ieumoffice-live-editor'])
  const via = decide({ common, tenant: {
    'pgpt-cadcraft': entry('http://lite:8787/mcp/cadcraft', { enabled: false }),
  } })
  assert.deepEqual(via['craft.photocraft'], ['common'])
  assert.deepEqual(via.office, ['common'])
  assert.deepEqual(via['craft.cadcraft'], [])
  // several sources at once: every one is named
  const both = decide({ common, tenant: { p: entry('http://lite/mcp/photocraft') } })
  assert.deepEqual(both['craft.photocraft'], ['tenant', 'common'])
})

test('common 과 회사의 같은 이름 항목: url 이 있으면 통째로 바뀐다 — 다른 곳이면 이어지지 않고 그렇다고 드러난다', () => {
  const common = new Set(LITE_TOOL_SERVER_NAMES)
  const tenant = {
    // a row copied from another install: another host, an old path
    'pgpt-photocraft': entry('http://old-lite:8787/mcp/photocraft-v0'),
    // a stdio command of the same name replaces it too
    'pgpt-soundcraft': { command: 'soundcraft-cli', args: ['mcp'] },
    // the same name pointing here: the tenant's own entry is what the agent gets (not the common one)
    'pgpt-cadcraft': entry('http://lite:8787/mcp/cadcraft'),
    // pointing here but switched off: replaced by an entry that is off — nothing, and nothing pointing elsewhere either
    'pgpt-filmcraft': entry('http://lite:8787/mcp/filmcraft', { enabled: false }),
  }
  const via = decide({ common, tenant, elsewhere: true })
  assert.deepEqual(via['craft.photocraft'], [OVERRIDDEN])
  assert.equal(wired(via['craft.photocraft']), false)
  assert.deepEqual(via['craft.soundcraft'], [OVERRIDDEN])
  assert.deepEqual(via['craft.cadcraft'], ['tenant'])
  assert.deepEqual(via['craft.filmcraft'], [])
  assert.deepEqual(via['craft.vectorcraft'], ['common'])
  // another key may still reach the app: then it is wired, and the stale row of the built-in name still shows
  const also = decide({ common, tenant: { ...tenant, 'my-photo': entry('http://lite:8787/mcp/photocraft') }, elsewhere: true })
  assert.deepEqual(also['craft.photocraft'], ['tenant', OVERRIDDEN])
  assert.equal(wired(also['craft.photocraft']), true)
  // shown before the common list is up too (production today): the row would replace it
  assert.deepEqual(decide({ tenant, elsewhere: true })['craft.photocraft'], [OVERRIDDEN])
})

test('common 과 회사의 같은 이름 항목: url 이 없으면 그 위에 얹힌다 — enabled:false 는 끄고 enabled:true 는 공통 주소 그대로', () => {
  const common = new Set(['pgpt-photocraft', 'pgpt-vectorcraft', 'pgpt-folders'])
  const via = decide({ common, tenant: {
    'pgpt-photocraft': { enabled: false },
    'pgpt-vectorcraft': { enabled: true },
    'pgpt-folders': { headers: { 'X-Note': 'kept' } },
  } })
  assert.deepEqual(via['craft.photocraft'], [])
  assert.deepEqual(via['craft.vectorcraft'], ['common'])
  assert.deepEqual(via.folders, ['common'])
})

test('localhost 주소: 에이전트가 이 기계에서 돌면(로컬 개발) 닿고, 다른 곳에서 돌면(게이트웨이 뒤 · Docker) 낡은 항목', () => {
  const tenant = { 'pgpt-photocraft': entry('http://localhost:8787/mcp/photocraft'), x: entry('http://127.0.0.1:8787/mcp/folders') }
  const common = new Set(['pgpt-photocraft'])
  assert.deepEqual(decide({ tenant, common, elsewhere: false })['craft.photocraft'], ['tenant'])
  assert.deepEqual(decide({ tenant, common, elsewhere: false }).folders, ['tenant'])
  assert.deepEqual(decide({ tenant, common, elsewhere: true })['craft.photocraft'], [OVERRIDDEN])
  assert.deepEqual(decide({ tenant, common, elsewhere: true }).folders, [])
  // where the agents run: behind the gateway, or this server's address for engines/agents is not a loopback one
  const saved = { gw: config.tenantFromHeader, git: config.gitUrl, rt: process.env.PRO_MCP_RUNTIME_BASE }
  try {
    config.tenantFromHeader = false; config.gitUrl = ''; delete process.env.PRO_MCP_RUNTIME_BASE
    assert.equal(agentsElsewhere(), false)
    process.env.PRO_MCP_RUNTIME_BASE = 'http://localhost:8787'
    assert.equal(agentsElsewhere(), false)
    process.env.PRO_MCP_RUNTIME_BASE = 'http://server:8787' // the Docker install
    assert.equal(agentsElsewhere(), true)
    delete process.env.PRO_MCP_RUNTIME_BASE
    config.gitUrl = 'http://process-gpt-lite-server.default.svc.cluster.local:8787' // the cluster
    assert.equal(agentsElsewhere(), true)
    config.gitUrl = ''; config.tenantFromHeader = true
    assert.equal(agentsElsewhere(), true)
  } finally {
    config.tenantFromHeader = saved.gw; config.gitUrl = saved.git
    if (saved.rt === undefined) delete process.env.PRO_MCP_RUNTIME_BASE; else process.env.PRO_MCP_RUNTIME_BASE = saved.rt
  }
})

test('shape: /api/config 모양 — office · folders · panelapps · improve · team 과 craft.<앱>', () => {
  const s = shape(decide({ tenant: null, common: new Set(['pgpt-photocraft']) }), (v) => v.length > 0)
  assert.deepEqual(s, { folders: false, panelapps: false, improve: false, team: false, office: false,
    craft: { cadcraft: false, vectorcraft: false, photocraft: true, soundcraft: false, filmcraft: false } })
})

// a tiny deepagents / mcp-hub: path → [status, body]
async function fakeServer(routes) {
  const seen = []
  const srv = http.createServer((req, res) => {
    seen.push({ path: req.url, tenant: req.headers['x-tenant-id'] || null })
    const [status, body] = routes[req.url] || [404, { detail: 'Not Found' }]
    res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  after(() => srv.close())
  return { url: `http://127.0.0.1:${srv.address().port}`, seen }
}
const DEAD = 'http://127.0.0.1:9' // nothing listens: no hub here (production)

test('공통 목록: deepagents 의 GET /mcp/common {servers:[이름]} — 이름만 쓴다', async () => {
  const da = await fakeServer({ '/mcp/common': [200, { servers: ['pgpt-photocraft', 'pgpt-folders'] }] })
  const c = agentToolsChecker({ hubUrl: DEAD, deepagentsUrl: da.url, readTenant: async () => ({}), log: () => {} })
  const r = await c.forTenant('acme')
  assert.equal(r.tools.craft.photocraft, true)
  assert.equal(r.tools.folders, true)
  assert.equal(r.tools.office, false)
  assert.deepEqual(r.via.craft.photocraft, ['common'])
  assert.deepEqual(r.via.office, [])
})

test('공통 목록이 아직 없는 deepagents(404) · 닿지 않는 deepagents: 그 출처만 빠진다', async () => {
  const da = await fakeServer({})
  const tenant = { p: entry('http://lite/mcp/photocraft') }
  for (const deepagentsUrl of [da.url, DEAD]) {
    const r = await agentToolsChecker({ hubUrl: DEAD, deepagentsUrl, readTenant: async () => tenant, log: () => {} }).forTenant('acme')
    assert.equal(r.tools.craft.photocraft, true)
    assert.equal(r.tools.craft.cadcraft, false)
    assert.deepEqual(r.via.craft.photocraft, ['tenant'])
  }
  assert.ok(da.seen.some((s) => s.path === '/mcp/common'))
})

test('허브: 닿으면 그 회사의 서버 목록(X-Tenant-Id)을 보고, 없는 이름만 거른다', async () => {
  const hub = await fakeServer({ '/servers': [200, [{ id: 'a', name: 'pgpt-soundcraft' }, { id: 'b', name: 'pgpt-panelapps' }]] })
  const da = await fakeServer({ '/mcp/common': [200, { servers: LITE_TOOL_SERVER_NAMES }] })
  const r = await agentToolsChecker({ hubUrl: hub.url, deepagentsUrl: da.url, readTenant: async () => null, log: () => {} }).forTenant('acme')
  assert.deepEqual(r.via.craft.soundcraft, ['common'])
  assert.equal(r.tools.panelapps, true)
  assert.equal(r.tools.folders, false)
  assert.deepEqual(r.via.folders, ['common', HUB_FILTERED])
  assert.deepEqual(hub.seen.find((s) => s.path === '/servers').tenant, 'acme')
})

test('회사 목록 읽기 오류 → 모두 false, 10초 뒤 다시 읽는다 · 성공은 1분 동안 기억', async () => {
  let t = 1_000_000, reads = 0, fail = true
  const logs = []
  const c = agentToolsChecker({ now: () => t, hubServers: async () => new Set(LITE_TOOL_SERVER_NAMES), commonServers: async () => new Set(LITE_TOOL_SERVER_NAMES),
    readTenant: async () => { reads++; if (fail) throw new Error('connection refused'); return {} }, log: (m) => logs.push(m) })
  let r = await c.forTenant('acme')
  assert.deepEqual(r.tools, shape(decide({ tenant: undefined }), () => false))
  assert.match(logs.at(-1), /\[agent-tools\] acme: tenant MCP list unreadable/)
  t += 5_000; await c.forTenant('acme')
  assert.equal(reads, 1, '실패는 10초 동안 기억')
  fail = false; t += 6_000
  r = await c.forTenant('acme')
  assert.equal(reads, 2)
  assert.equal(r.tools.craft.photocraft, true)
  t += 59_000; await c.forTenant('acme')
  assert.equal(reads, 2, '성공은 1분 동안 기억')
  t += 2_000; await c.forTenant('acme')
  assert.equal(reads, 3)
  // another tenant is read on its own
  await c.forTenant('other')
  assert.equal(reads, 4)
})

test('회사 목록이 시간 안에 오지 않으면 false (닫힌 쪽으로), 이어지지 않은 도구는 이름만 한 번 적는다', async () => {
  const logs = []
  const c = agentToolsChecker({ hubServers: async () => null, commonServers: async () => null, readTenant: () => new Promise(() => {}), log: (m) => logs.push(m) })
  const r = await c.forTenant('slow')
  assert.equal(Object.values(r.tools.craft).some(Boolean) || r.tools.office || r.tools.folders, false)
  const c2 = agentToolsChecker({ hubServers: async () => null, commonServers: async () => null, readTenant: async () => ({ p: entry('http://lite/mcp/photocraft') }), log: (m) => logs.push(m) })
  await c2.forTenant('acme')
  const line = logs.find((m) => m.includes('not wired'))
  assert.match(line, /acme: not wired to the agent: folders, panelapps, improve, team, cadcraft, vectorcraft, soundcraft, filmcraft, office/)
  assert.doesNotMatch(logs.join('\n'), /http|Bearer|user_jwt/)
})
