'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { kind, openable, agentMay, appNames, nameToCheck, hereAddress, windowFor } = require('../src/policy')

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

test('이 PC 의 주소는 어떻게 적어도 같다 — IPv4 를 품은 IPv6(16진 · 점), 옛 호환 꼴, 0.0.0.0', () => {
  const here = { server: 'http://localhost:5180', authOrigins: [], selfHosts: ['192.168.0.7'] }
  for (const u of ['http://[::ffff:192.168.0.7]:5180/', 'http://[::ffff:c0a8:7]:5180/', 'http://[::ffff:0.0.0.0]:5180/', 'http://[::7f00:1]:5180/', 'http://[::127.0.0.1]:5180/',
    'http://[0:0:0:0:0:ffff:7f00:1]:5180/', 'http://0.0.0.0:5180/', 'http://[::]:5180/']) assert.equal(agentMay(u, here), false, u)
  for (const u of ['http://[::ffff:192.168.0.8]:5180/', 'http://[::ffff:c0a8:7]:5181/', 'https://[2001:db8::1]:5180/']) assert.equal(agentMay(u, here), true, u)
  // a server reached at this PC's LAN address: localhost on its port is it too
  assert.equal(agentMay('http://localhost:18080/', { server: 'http://192.168.0.7:18080', selfHosts: ['192.168.0.7'] }), false)
})

test('이름은 풀어 본다 — 이 PC 에 있는 서버의 포트로 가는 이름(그 이름이 이 PC 를 가리키면 막음), 앱 서버 자신의 이름', () => {
  const here = { server: 'http://localhost:5180', authOrigins: ['http://localhost:54321'], selfHosts: ['192.168.0.7', 'my-mac.local'] }
  for (const [u, name] of [['http://localtest.me:5180/login', 'localtest.me'], ['http://127.0.0.1.nip.io:5180/', '127.0.0.1.nip.io'], ['http://my-mac.lan:5180/', 'my-mac.lan'],
    ['ws://lite-alias.test:5180/api/events', 'lite-alias.test'], ['http://supa.test:54321/auth/v1/otp', 'supa.test']]) assert.equal(nameToCheck(u, here), name, u)
  // an address (decided without resolving), this PC's own names, another port, no server on this PC: nothing to resolve
  for (const u of ['http://127.0.0.1:5180/', 'http://my-mac.local:5180/', 'http://localtest.me:3000/', 'https://www.naver.com/', 'about:blank'])
    assert.equal(nameToCheck(u, here), null, u)
  assert.equal(nameToCheck('http://localtest.me:443/', { server: 'https://acme.process-gpt.io/lite', authOrigins: [] }), null, '회사 서버는 그 주소 그대로')
  // a server on the default port: a name on 80 or 443
  assert.equal(nameToCheck('https://alias.test/', { server: 'http://localhost', selfHosts: [] }), 'alias.test')
  // the app's own names, to learn whether the server is on this PC (an address or this PC's own name needs no resolving)
  assert.deepEqual(appNames({ server: 'http://mypc.example.com:18080', authOrigins: ['https://auth.process-gpt.io', 'http://127.0.0.1:54321'], selfHosts: ['my-mac.local'] }),
    ['mypc.example.com', 'auth.process-gpt.io'])
  assert.deepEqual(appNames({ server: 'http://my-mac.local:18080', selfHosts: ['my-mac.local'] }), [])
  // once a name is known to be this PC's (host.js adds it to selfHosts), the server by that name is here
  const named = { server: 'http://mypc.example.com:18080', authOrigins: [], selfHosts: ['192.168.0.7', 'mypc.example.com'] }
  for (const u of ['http://localhost:18080/', 'http://192.168.0.7:18080/', 'http://[::ffff:c0a8:7]:18080/']) assert.equal(agentMay(u, named), false, u)
  assert.equal(nameToCheck('http://other-name.test:18080/', named), 'other-name.test')
})

test('푼 주소가 이 PC 의 것인가 — loopback(127/8 · ::1 · 0.0.0.0 · ::) · IPv4 를 품은 IPv6 · 이 PC 의 주소', () => {
  const self = ['192.168.0.7', 'fe80::1']
  for (const a of ['127.0.0.1', '127.8.9.10', '::1', '0.0.0.0', '::', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:c0a8:7', '192.168.0.7', 'FE80::1']) assert.equal(hereAddress(a, self), true, a)
  for (const a of ['192.168.0.8', '8.8.8.8', '2001:db8::1', '', '::ffff:808:808']) assert.equal(hereAddress(a, self), false, a)
})

test('앱 창이 여는 새 창 — 웹 앱의 화면은 이 창에서, 서버의 /api/ · 내려받기 · 같은 출처의 다른 화면은 새 창, 로그인 · 다른 주소는 바깥', () => {
  const company = { server: 'https://acme.process-gpt.io/lite', authOrigins: ['https://auth.process-gpt.io'] }
  const local = { server: 'http://localhost:18080', authOrigins: [] }
  for (const [u, ctx] of [['https://acme.process-gpt.io/lite/projects/p/1', company], ['https://acme.process-gpt.io/lite', company], ['https://acme.process-gpt.io/lite/?x=1', company],
    ['http://localhost:18080/folders/abc', local], ['http://localhost:18080/', local]]) assert.equal(windowFor(u, ctx), 'main', u)
  for (const [u, ctx] of [['https://acme.process-gpt.io/lite/api/files/x.pdf', company], ['https://acme.process-gpt.io/lite/api', company], ['https://acme.process-gpt.io/', company],
    ['https://acme.process-gpt.io/litegame', company], ['http://localhost:18080/api/attachments/1', local], ['blob:http://localhost:18080/5b1c', local]]) assert.equal(windowFor(u, ctx), 'child', u)
  for (const u of ['https://auth.process-gpt.io/auth/v1/authorize', 'https://www.naver.com/', 'mailto:a@example.com']) assert.equal(windowFor(u, company), 'outside', u)
  for (const u of ['about:blank', 'file:///etc/passwd', 'javascript:alert(1)']) assert.equal(windowFor(u, company), 'none', u)
})

test('서버가 알린 제 주소(공개 주소 · 터널)도 그 서버다 — 에이전트 브라우저는 열지 않는다. 그 이름 아래 · 앱 이름 아래는 이 PC 의 이름처럼 다룬다', () => {
  const ctx = { server: 'http://localhost:18080', authOrigins: [], appOrigins: ['https://lite-tunnel.example', 'http://192.168.0.7:18080'], selfHosts: ['192.168.0.7'] }
  for (const u of ['https://lite-tunnel.example/chat', 'http://lite-tunnel.example/', 'wss://lite-tunnel.example/api/events', 'http://192.168.0.7:18080/']) assert.equal(agentMay(u, ctx), false, u)
  for (const u of ['https://other-tunnel.example/', 'https://www.naver.com/']) assert.equal(agentMay(u, ctx), true, u)
  // (no server chosen: nothing of the app)
  assert.equal(agentMay('https://lite-tunnel.example/', { appOrigins: ['https://lite-tunnel.example'] }), true)
  const { siteOf, underAppSite, couldBeLocal } = require('../src/policy')
  assert.deepEqual(['accounts.shop.example', 'lite.acme.co.kr', 'acme.co.kr', 'localhost', '127.0.0.1', 'intranet'].map(siteOf), ['shop.example', 'acme.co.kr', 'acme.co.kr', 'localhost', '127.0.0.1', 'intranet'])
  const company = { server: 'https://acme.process-gpt.io/lite', authOrigins: ['https://auth.process-gpt.io'] }
  for (const h of ['www.process-gpt.io', 'process-gpt.io', 'x.y.process-gpt.io']) assert.equal(underAppSite(h, company), true, h)
  for (const h of ['process-gpt.io.evil.example', 'google.com', 'naver.co.kr']) assert.equal(underAppSite(h, company), false, h)
  for (const h of ['intranet', 'printer.lan', 'nas.home.arpa', 'db.internal', 'a.localhost', 'other.process-gpt.io']) assert.equal(couldBeLocal(h, company), true, h)
  for (const h of ['slow.example', 'www.naver.com']) assert.equal(couldBeLocal(h, company), false, h)
})

test('웹 앱의 화면만 앱 창에서 — 정적 파일 · 다른 앱(/craft · /assets · /_lite · 파일 이름)은 새 창', () => {
  const company = { server: 'https://acme.process-gpt.io/lite', authOrigins: [] }
  for (const u of ['https://acme.process-gpt.io/lite/craft/vectorcraft/index.html', 'https://acme.process-gpt.io/lite/assets/index-abc.js', 'https://acme.process-gpt.io/lite/sw.js',
    'https://acme.process-gpt.io/lite/_lite/host.html', 'https://acme.process-gpt.io/lite/favicon.svg', 'https://acme.process-gpt.io/lite/manifest.webmanifest'])
    assert.equal(windowFor(u, company), 'child', u)
  for (const u of ['https://acme.process-gpt.io/lite/chat/c/1', 'https://acme.process-gpt.io/lite/routines/abc', 'https://acme.process-gpt.io/lite/folders/my.folder/v/2?x=1#a'])
    assert.equal(windowFor(u, company), 'main', u)
})
