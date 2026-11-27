// Requests marked as the desktop agent browser's (X-PGL-Agent-Browser) are refused: every /api call and the sign-in, the MCP
// endpoints and the ArtCraft apps get 403 { code: 'agent_browser' } in the request's language, and a websocket upgrade gets 403
// before any upgrade listener sees it. Unmarked requests go on as before. (lib/agentBrowserGuard.js; index.js mounts it ahead of every
// route and on the server's upgrades.)
//   cd server && node --test test/agentBrowserGuard.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import express from 'express'
import { AGENT_BROWSER_HEADER, fromAgentBrowser, refuseAgentBrowser, guardUpgrades } from '../lib/agentBrowserGuard.js'

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(`127.0.0.1:${srv.address().port}`)))

async function serve() {
  const app = express()
  app.use(refuseAgentBrowser)
  app.use(express.json())
  app.get('/api/x', (req, res) => res.json({ ok: true }))
  app.post('/api/auth/email/start', (req, res) => res.json({ sent: true }))
  app.post(['/mcp', '/mcp/:connector'], (req, res) => res.json({ jsonrpc: '2.0', id: 1, result: {} }))
  app.use('/craft', (req, res) => res.type('text/javascript').send('// app'))
  app.get('/page', (req, res) => res.type('text/plain').send('page'))
  const srv = http.createServer(app)
  const at = await listen(srv)
  return { base: `http://${at}`, close: () => srv.close() }
}

test('the header name and what counts as marked', () => {
  assert.equal(AGENT_BROWSER_HEADER, 'x-pgl-agent-browser')
  assert.equal(fromAgentBrowser({ headers: { 'x-pgl-agent-browser': '1' } }), true)
  assert.equal(fromAgentBrowser({ headers: { 'x-pgl-agent-browser': '' } }), false)
  assert.equal(fromAgentBrowser({ headers: {} }), false)
})

test('에이전트 브라우저 표시가 있는 /api 요청과 로그인은 403 agent_browser, 말은 X-PGL-Lang 대로', async () => {
  const s = await serve()
  try {
    const marked = { 'X-PGL-Agent-Browser': '1' }
    const x = await fetch(`${s.base}/api/x`, { headers: marked })
    assert.equal(x.status, 403)
    const xb = await x.json()
    assert.equal(xb.code, 'agent_browser')
    assert.match(xb.error, /에이전트 브라우저에서 온 요청은 받지 않아요/)
    const start = await fetch(`${s.base}/api/auth/email/start`, { method: 'POST', headers: { ...marked, 'Content-Type': 'application/json', 'X-PGL-Lang': 'en' }, body: JSON.stringify({ email: 'a@example.com' }) })
    assert.equal(start.status, 403)
    const sb = await start.json()
    assert.equal(sb.code, 'agent_browser')
    assert.match(sb.error, /^Requests from the agent's browser are not accepted/)
    assert.equal((await (await fetch(`${s.base}/api/x?lang=en`, { headers: marked })).json()).error.startsWith('Requests'), true)
  } finally { s.close() }
})

test('MCP 끝점과 ArtCraft 앱도 표시가 있으면 403 agent_browser — 표시가 없으면 그대로', async () => {
  const s = await serve()
  try {
    const marked = { 'X-PGL-Agent-Browser': '1' }
    const rpc = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }
    for (const [p, init] of [['/mcp', rpc], ['/mcp/mail', rpc], ['/craft/vectorcraft/index.js', {}], ['/page', {}]]) {
      const r = await fetch(`${s.base}${p}`, { ...init, headers: { ...(init.headers || {}), ...marked } })
      assert.equal(r.status, 403, p)
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff')
      assert.equal((await r.json()).code, 'agent_browser', p)
      const plain = await fetch(`${s.base}${p}`, init)
      assert.equal(plain.status, 200, p)
    }
  } finally { s.close() }
})

test('표시가 없는 요청은 그대로 지나간다', async () => {
  const s = await serve()
  try {
    const x = await fetch(`${s.base}/api/x`)
    assert.equal(x.status, 200)
    assert.deepEqual(await x.json(), { ok: true })
    const start = await fetch(`${s.base}/api/auth/email/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'a@example.com' }) })
    assert.deepEqual(await start.json(), { sent: true })
  } finally { s.close() }
})

// a raw upgrade request: what comes back before the socket closes
function upgrade(at, path, extra = {}) {
  const [host, port] = at.split(':')
  return new Promise((resolve, reject) => {
    const sock = net.connect(Number(port), host)
    let got = ''
    sock.on('data', (d) => { got += d })
    sock.on('end', () => resolve({ got, closed: true }))
    sock.on('error', reject)
    const head = { Host: at, Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', ...extra }
    sock.write(`GET ${path} HTTP/1.1\r\n${Object.entries(head).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`)
  })
}

test('표시가 있는 웹소켓 연결은 403 으로 닫히고, 다른 upgrade 처리기는 불리지 않는다', async () => {
  const srv = http.createServer((req, res) => res.end('plain'))
  const seen = []
  srv.on('upgrade', (req, socket) => {
    seen.push(req.url)
    socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')
  })
  guardUpgrades(srv)
  // a listener added after the guard is passed over too
  srv.on('upgrade', (req) => seen.push(`late ${req.url}`))
  const at = await listen(srv)
  try {
    const marked = await upgrade(at, '/api/workroom/term', { 'X-PGL-Agent-Browser': '1' })
    assert.match(marked.got, /^HTTP\/1\.1 403 Forbidden\r\n/)
    assert.match(marked.got, /"code":"agent_browser"/)
    assert.match(marked.got, /에이전트 브라우저/)
    assert.equal(marked.closed, true)
    const en = await upgrade(at, '/api/meetings/voice?lang=en', { 'X-PGL-Agent-Browser': '1' })
    assert.match(en.got, /Requests from the agent's browser are not accepted/)
    assert.deepEqual(seen, [], 'no upgrade listener saw a marked request')

    const plain = await upgrade(at, '/api/local-agents/link')
    assert.match(plain.got, /^HTTP\/1\.1 101 /)
    assert.deepEqual(seen, ['/api/local-agents/link', 'late /api/local-agents/link'])
  } finally { srv.close() }
})

test('index.js: 모든 경로보다 앞(앱을 만든 바로 뒤 — /craft · /api · git · 본문 파서 · 로그인 · MCP 앞)에 붙고, 웹소켓 연결들보다 먼저 upgrade 를 막는다', async () => {
  const fs = await import('node:fs/promises')
  const src = await fs.readFile(new URL('../index.js', import.meta.url), 'utf8')
  const at = (s) => { const i = src.indexOf(s); assert.ok(i >= 0, s); return i }
  const guard = at('app.use(refuseAgentBrowser)')
  assert.ok(at('const app = express()') < guard)
  // (the only mount: no route group of its own that a later change could leave out)
  assert.equal(src.split('refuseAgentBrowser)').length - 1, 1)
  for (const later of ["app.use('/craft'", "app.use('/api', apiHeaders)", "app.use('/api/git', gitRoutes())", "app.use('/api/local-git'", "app.use(express.json({ limit: '2mb' }))",
    "app.post('/api/auth/email/start'", 'mountCraft(app)', 'mountConnectors(app)']) assert.ok(guard < at(later), later)
  // every route this server has is added after it
  const first = src.search(/\bapp\.(get|post|put|patch|delete|all)\(/)
  assert.ok(guard < first)
  const up = at('guardUpgrades(server)')
  assert.ok(at('const server = app.listen(') < up)
  for (const later of ['workroom.attachTerminal(server)', 'startLocalAgents(server)', 'attachCraftLive(server)', 'attachVoice(server)']) assert.ok(up < at(later), later)
})
