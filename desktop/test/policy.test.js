'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { kind, openable, agentMay } = require('../src/policy')

const company = { server: 'https://acme.process-gpt.io/lite', authOrigins: ['https://auth.process-gpt.io'] }
const local = { server: 'http://localhost:18080', authOrigins: [] }

test('the server origin opens in the window — the whole origin (ProcessGPT shares it behind the gateway)', () => {
  assert.equal(kind('https://acme.process-gpt.io/lite/chat', company), 'app')
  assert.equal(kind('https://acme.process-gpt.io/', company), 'app')
  assert.equal(kind('http://localhost:18080/folders', local), 'app')
  assert.equal(kind('about:blank', local), 'app')
  assert.equal(kind('blob:http://localhost:18080/5b1c', local), 'app')
})

test('sign-in pages: the Supabase origin from /api/config and Google accounts, https only', () => {
  assert.equal(kind('https://auth.process-gpt.io/auth/v1/authorize?provider=google', company), 'auth')
  assert.equal(kind('https://accounts.google.com/o/oauth2/v2/auth?client_id=x', company), 'auth')
  assert.equal(kind('https://accounts.google.co.kr/accounts/SetSID', company), 'auth')
  assert.equal(kind('https://accounts.youtube.com/accounts/SetSID', local), 'auth')
  assert.equal(kind('http://accounts.google.com/', company), 'external')
})

test('other sites and mail open outside; other schemes nowhere', () => {
  assert.equal(kind('https://other.process-gpt.io/lite', company), 'external')
  assert.equal(kind('https://www.youtube.com/watch?v=x', company), 'external')
  assert.equal(kind('https://drive.google.com/file/d/1', company), 'external')
  assert.equal(kind('http://localhost:5180/chat', local), 'external')
  assert.equal(kind('mailto:a@example.com', company), 'external')
  assert.equal(kind('file:///etc/passwd', company), 'blocked')
  assert.equal(kind('javascript:alert(1)', company), 'blocked')
  assert.equal(kind('blob:https://evil.example/1', company), 'blocked')
  assert.equal(kind('not a url', company), 'blocked')
})

test('only web, mail and phone addresses are handed to the system', () => {
  assert.ok(openable('https://example.com'))
  assert.ok(openable('mailto:a@example.com'))
  assert.ok(!openable('file:///Applications/Calculator.app'))
  assert.ok(!openable('smb://host/share'))
})

// desktop 0.2.6 — the browser the server's agent drives on this PC (browser/host.js) never opens the Lite app or its sign-in
test('에이전트 브라우저는 앱이 연결한 Lite 서버의 출처와 그 로그인 출처를 열지 않는다 — about:blank 와 다른 사이트는 연다', () => {
  for (const u of ['https://acme.process-gpt.io/lite/chat', 'https://acme.process-gpt.io/', 'https://ACME.process-gpt.io./lite/login', 'https://acme.process-gpt.io:443/x',
    'http://acme.process-gpt.io/lite', 'wss://acme.process-gpt.io/lite/api/events', 'https://auth.process-gpt.io/auth/v1/authorize?provider=google',
    'https://auth.process-gpt.io/auth/v1/otp', 'blob:https://acme.process-gpt.io/5b1c']) assert.equal(agentMay(u, company), false, u)
  for (const u of ['about:blank', 'https://other.process-gpt.io/lite', 'https://www.naver.com/', 'https://accounts.google.com/signin', 'https://acme.process-gpt.io:8443/',
    'https://notebooklm.google.com/', 'blob:https://shop.example/1']) assert.equal(agentMay(u, company), true, u)
  // (no server chosen yet: nothing of the app to keep away)
  assert.equal(agentMay('https://acme.process-gpt.io/lite', {}), true)
})

test('이 PC 의 Lite 서버는 이 PC 의 다른 이름으로도 — 같은 포트의 localhost · 127.0.0.1 · [::1] · 이 PC 의 주소', () => {
  const here = { server: 'http://localhost:18080', authOrigins: [], selfHosts: ['192.168.0.7', 'my-mac.local'] }
  for (const u of ['http://localhost:18080/chat', 'http://127.0.0.1:18080/', 'http://[::1]:18080/', 'http://a.localhost:18080/', 'http://2130706433:18080/',
    'http://[::ffff:127.0.0.1]:18080/', 'ws://127.0.0.1:18080/api/local-agents', 'https://localhost:18080/', 'http://192.168.0.7:18080/', 'http://MY-MAC.local:18080/'])
    assert.equal(agentMay(u, here), false, u)
  for (const u of ['http://localhost:5180/', 'http://127.0.0.1:8080/', 'http://192.168.0.8:18080/', 'http://192.168.0.7:3000/']) assert.equal(agentMay(u, here), true, u)
  // a company server is only itself: this PC's names are not it
  assert.equal(agentMay('http://localhost:443/', company), true)
  assert.equal(agentMay('https://127.0.0.1/', company), true)
})
