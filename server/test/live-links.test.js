// The two websocket links a phone saw fail silently (2026-11-18), checked without a database or a model:
//   - a workroom says whether it can have a terminal here and why not (workroom.js terminalStatus): no
//     folder → 404, Claude Code missing → 503, the multi-tenant gateway without PRO_TERMINAL_KEY → 503
//   - a refused websocket is accepted and closed with 44xx after a {type:'denied', reason} message
//     (a gateway in front turns an HTTP refusal into an open socket closed 1002)
//   - a proxy chain's X-Forwarded-Host list still counts as this app's own origin
//   - the document a chat message says is open (openDoc) stands in for a live link that is down
//     (craftLive.js openDocOf), and the hint forbids a new file when the editor cannot be reached
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import http from 'node:http'

const { config } = await import('../config.js')
const { terminalStatus, terminalInfo, sameOrigin, refuse } = await import('../lib/workroom.js')
const { openDocOf, liveFact, livePin } = await import('../lib/craftLive.js')
const { WebSocketServer, WebSocket } = await import('ws')

test('workroom: terminal availability and its reason', () => {
  const room = { kind: 'folder', id: 'x', agent: 'shell', cwd: os.tmpdir() }
  const here = terminalStatus(room)
  // (an install whose node-pty did not load says so instead)
  if (!here.ok) assert.match(here.reason, /node-pty/)
  else assert.deepEqual(here, { ok: true })
  const gone = terminalStatus({ ...room, cwd: '/nonexistent/pgpt-room' })
  if (here.ok) assert.deepEqual([gone.ok, gone.status], [false, 404])
  const bin = config.claudeBin
  config.claudeBin = '/nonexistent/claude'
  try {
    if (here.ok) assert.deepEqual([terminalStatus(room, 'claude').ok, terminalStatus(room, 'claude').status], [false, 503])
    const info = terminalInfo({ ...room, agent: 'claude-code' })
    assert.equal(info.status, undefined)
    if (here.ok) assert.equal(info.claude.ok, false)
  } finally { config.claudeBin = bin }
  const was = [config.tenantFromHeader, config.terminalKey]
  config.tenantFromHeader = true; config.terminalKey = ''
  try {
    const shared = terminalStatus(room)
    assert.deepEqual([shared.ok, shared.status], [false, 503])
    assert.match(shared.reason, /여러 회사/)
    config.terminalKey = 'set-by-operator'
    assert.equal(terminalStatus(room).ok, here.ok)
  } finally { [config.tenantFromHeader, config.terminalKey] = was }
})

test('workroom: a proxy chain X-Forwarded-Host list is still this origin', () => {
  const req = (h) => ({ headers: { origin: 'https://acme.process-gpt.io', host: 'process-gpt-lite-web', ...h } })
  assert.equal(sameOrigin(req({ 'x-forwarded-host': 'acme.process-gpt.io, process-gpt-lite-web' })), true)
  assert.equal(sameOrigin(req({ 'x-forwarded-host': 'acme.process-gpt.io' })), true)
  assert.equal(sameOrigin(req({})), false)
  assert.equal(sameOrigin({ headers: { host: 'acme.process-gpt.io' } }), false)
})

test('workroom: behind the gateway a company address is this origin without any forwarded host', () => {
  // what production sends (2026-11-18): Host process-gpt-lite-web, no X-Forwarded-Host
  const req = (origin) => ({ headers: { origin, host: 'process-gpt-lite-web' } })
  const was = [config.tenantFromHeader, config.publicUrl]
  try {
    config.tenantFromHeader = false; config.publicUrl = 'https://www.process-gpt.io/lite'
    assert.equal(sameOrigin(req('https://uengine.process-gpt.io')), false)
    config.tenantFromHeader = true
    assert.equal(sameOrigin(req('https://uengine.process-gpt.io')), true)
    assert.equal(sameOrigin(req('https://www.process-gpt.io')), true)
    assert.equal(sameOrigin(req('https://process-gpt.io.evil.example')), false)
    assert.equal(sameOrigin(req('https://evilprocess-gpt.io')), false)
    assert.equal(sameOrigin(req('https://evil.example')), false)
    // a public URL without a parent domain trusts only itself
    config.publicUrl = 'http://localhost:5180'
    assert.equal(sameOrigin(req('http://other.localhost:5180')), false)
  } finally { [config.tenantFromHeader, config.publicUrl] = was }
})

test('a refused websocket arrives open, with the reason, then closes 44xx', async () => {
  const server = http.createServer()
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => refuse(wss, req, socket, head, 4403, '출처가 달라요'))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  try {
    const got = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/api/workroom/term`)
      let msg = null
      ws.on('message', (m) => (msg = JSON.parse(m)))
      ws.on('close', (code) => resolve({ msg, code }))
      ws.on('error', reject)
    })
    assert.deepEqual(got, { msg: { type: 'denied', code: 4403, reason: '출처가 달라요' }, code: 4403 })
  } finally { server.close() }
})

test('openDoc: the document the page says is open stands in for a live link that is down', () => {
  assert.equal(openDocOf(null), null)
  assert.equal(openDocOf({ app: 'photocraft', file: 'a.psd' }), null)
  assert.equal(openDocOf({ app: 'ieumoffice', file: '' }), null)
  const d = openDocOf({ app: 'ieumoffice', file: '회의록.docx', editor: 'docs' })
  assert.deepEqual(d, { app: 'ieumoffice', title: '이음오피스', file: '회의록.docx', editor: 'docs', fromPage: true })
  assert.equal(openDocOf({ app: 'ieumoffice', name: 'x'.repeat(300), editor: '<script>' }).file.length, 200)
  assert.equal(openDocOf({ app: 'ieumoffice', name: 'a.docx', editor: '<script>' }).editor, null)
  // the agent is told what is open (a fact) and the edit skill is pinned; how to edit is that skill's
  assert.match(liveFact(d), /회의록\.docx/)
  assert.ok(!/office_live_/.test(liveFact(d)), 'no tool instructions in the message')
  assert.equal(livePin(d, '표의 합계를 고쳐 줘'), '/ieumoffice-live-edit ')
})
