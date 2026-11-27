'use strict'
// The browser on this PC as the server drives it (src/browser/protocol.js — desktop 0.2.3): only named operations, only for the person
// this desktop is signed in as, long messages in pieces both ways, and nothing of an operation's arguments in a log (a vault value for one
// fill is among them). The browser itself (src/browser/host.js) needs Electron: server/test/browserDriver.test.js runs it.
const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')
const { BrowserService, Parts, sendBig, PART, WHOLE, MAX_PARTS, OPEN, OPS } = require('../src/browser/protocol')
const { webAddress, privateHost, createBrowserHost, requestVerdict, APP_REFUSED, MAX_WORDS, POPUPS } = require('../src/browser/host')
const { answersGate } = require('../src/policy')
const settings = require('../src/settings')
const P = require('../src/browser/pageScripts')

function service({ user = { id: 'u-1' } } = {}) {
  const out = []
  const logs = []
  const calls = []
  let opened = false
  const driver = {
    opened: () => opened,
    at: () => ({ url: 'https://shop.example/', title: '가게', vp: { width: 1280, height: 800 }, tab: 1 }),
    open: async (a) => { calls.push(['open', a]); opened = true; return { shown: false } },
    look: async () => ({ title: '가게', url: 'https://shop.example/', text: 'x'.repeat(PART * 2), els: [] }),
    fillSecret: async (a) => { calls.push(['fillSecret', a]); return true },
    click: async () => { throw new Error('this element is no longer on the page') },
  }
  const svc = new BrowserService({ driver, send: (m) => { out.push(m); return true }, user: () => user, log: (...a) => logs.push(a.join(' ')) })
  return { svc, out, logs, calls, driver }
}
const replyOf = (out, id) => {
  const parts = new Parts()
  let whole = null
  for (const m of out) whole = m.type === 'browser-part' ? parts.take(m) || whole : m.id === id ? m : whole
  return whole
}

test('열기는 이 데스크톱에 로그인한 사람의 것만 — 다른 사람 · 열기 전의 동작 · 모르는 동작은 거절', async () => {
  const { svc, out, calls } = service()
  await svc.handle({ type: 'browser', id: 'a', op: 'look', args: {} })
  assert.match(replyOf(out, 'a').error, /not open/)
  await svc.handle({ type: 'browser', id: 'b', op: 'open', args: { user: 'someone-else' } })
  assert.equal(replyOf(out, 'b').ok, false)
  assert.equal(replyOf(out, 'b').code, 'person')
  await svc.handle({ type: 'browser', id: 'c', op: 'open', args: { user: 'u-1' } })
  assert.equal(replyOf(out, 'c').ok, true)
  assert.deepEqual(calls.map((c) => c[0]), ['open'])
  await svc.handle({ type: 'browser', id: 'd', op: 'runScript', args: { code: 'process.exit()' } })
  assert.match(replyOf(out, 'd').error, /unknown operation/)
  await svc.handle({ type: 'browser', id: 'e', op: 'constructor', args: {} })
  assert.match(replyOf(out, 'e').error, /unknown operation/)
  assert.ok(!OPS.has('evaluate') && !OPS.has('exec'), '코드를 돌리는 동작은 없다')
})

test('서버가 로그인 전(환영 전)에 열라고 해도 열지 않는다', async () => {
  const { svc, out } = service({ user: null })
  await svc.handle({ type: 'browser', id: 'x', op: 'open', args: { user: 'u-1' } })
  assert.equal(replyOf(out, 'x').ok, false)
})

test('답에는 지금 페이지가 어디인지가 따르고, 실패는 이유로 · 긴 답은 조각으로', async () => {
  const { svc, out } = service()
  await svc.handle({ type: 'browser', id: 'o', op: 'open', args: { user: 'u-1' } })
  await svc.handle({ type: 'browser', id: 'k', op: 'click', args: { i: 3 } })
  const k = replyOf(out, 'k')
  assert.deepEqual([k.ok, k.error, k.at.url], [false, 'this element is no longer on the page', 'https://shop.example/'])
  out.length = 0
  await svc.handle({ type: 'browser', id: 'l', op: 'look', args: {} })
  assert.ok(out.length > 2 && out.every((m) => m.type === 'browser-part' && JSON.stringify(m).length < 1024 * 1024))
  assert.equal(replyOf(out, 'l').value.text.length, PART * 2)
})

test('조각으로 온 일(첨부할 파일)도 하나로 받아 돌린다', async () => {
  const { svc, out, calls } = service()
  await svc.handle({ type: 'browser', id: 'o', op: 'open', args: { user: 'u-1' } })
  const big = crypto.randomBytes(900_000).toString('base64')
  const pieces = []
  sendBig((m) => { pieces.push(m); return true }, { type: 'browser', id: 'f', op: 'fillSecret', args: { i: 1, value: big } })
  assert.ok(pieces.length > 1)
  for (const m of pieces) await svc.handle(m)
  assert.equal(replyOf(out, 'f').ok, true)
  assert.equal(calls.at(-1)[1].value, big)
})

test('보관함 값은 어떤 로그에도 남지 않는다(추적을 켜도)', async () => {
  const keep = process.env.PGL_BROWSER_TRACE
  process.env.PGL_BROWSER_TRACE = '1'
  const printed = []
  const orig = console.log
  console.log = (...a) => printed.push(a.join(' '))
  try {
    const { svc, logs } = service()
    await svc.handle({ type: 'browser', id: 'o', op: 'open', args: { user: 'u-1' } })
    await svc.handle({ type: 'browser', id: 's', op: 'fillSecret', args: { i: 2, value: 'Secret-Value-99!', keys: true } })
    assert.ok(![...printed, ...logs].some((l) => l.includes('Secret-Value-99!')))
    assert.ok(printed.some((l) => /fillSecret/.test(l)), '추적은 동작 이름과 시간만')
  } finally { console.log = orig; if (keep === undefined) delete process.env.PGL_BROWSER_TRACE; else process.env.PGL_BROWSER_TRACE = keep }
})

test('웹 주소만: 이 PC 의 파일 · 앱의 페이지 · 스크립트 주소는 열지 않는다', () => {
  for (const u of ['https://a.example/x', 'http://127.0.0.1:8080/', 'about:blank']) assert.equal(webAddress(u), true, u)
  for (const u of ['file:///etc/hosts', 'javascript:alert(1)', 'chrome://settings', 'devtools://x', 'data:text/html,x', '']) assert.equal(webAddress(u), false, u)
})

test('페이지 스크립트: 비밀 칸의 값은 읽기에도 낱말에도 없다(서버와 같은 스크립트)', () => {
  // the server's own copies are compared in server/test/browserDriver.test.js; here: what they are for
  assert.match(String(P.SNAPSHOT_JS), /secret \? \{ secret: true, filled: !!el\.value \}/)
  assert.match(String(P.PAGE_WORDS_JS), /:not\(\[data-pro-secret\]\)/)
  assert.match(String(P.GUARD_JS), /-webkit-text-security:disc/)
  assert.doesNotMatch(String(P.GUARD_JS), /__proVaultCapture/, 'PC 에서 친 로그인은 보고하지 않는다')
})

// ---- 2026-11-25 review ----
const bytes = (m) => Buffer.byteLength(JSON.stringify(m))

test('긴 한국어는 바이트로 잰다: 한글 40만 자(1.2MB)도 조각마다 1MB 아래로 가고 그대로 돌아온다 — 32만 자 ASCII 는 한 번에', async () => {
  const korean = '가'.repeat(400_000)
  const out = []
  sendBig((m) => { out.push(m); return true }, { type: 'browser-reply', id: 'w', ok: true, value: korean })
  assert.ok(out.length >= 2 && out.every((m) => m.type === 'browser-part' && bytes(m) < 1024 * 1024), out.map(bytes).join(','))
  const parts = new Parts()
  let whole = null
  for (const m of out) whole = parts.take(m) || whole
  assert.equal(whole.value, korean)
  const ascii = []
  sendBig((m) => { ascii.push(m); return true }, { type: 'browser-reply', id: 'a', ok: true, value: 'a'.repeat(320_000) })
  assert.equal(ascii.length, 1)
  const k320 = []
  sendBig((m) => { k320.push(m); return true }, { type: 'browser-reply', id: 'k', ok: true, value: '가'.repeat(320_000) })
  assert.ok(k320.length > 1 && WHOLE < 320_000 * 3, '32만 자 한글(960KB)은 조각으로')
  // the service's own replies too: a page's words in Korean
  const { svc, out: sent } = service()
  await svc.handle({ type: 'browser', id: 'o', op: 'open', args: { user: 'u-1' } })
  svc.driver.words = async () => korean
  sent.length = 0
  await svc.handle({ type: 'browser', id: 'wd', op: 'words', args: {} })
  assert.ok(sent.length > 1 && sent.every((m) => bytes(m) < 1024 * 1024))
  assert.equal(replyOf(sent, 'wd').value, korean)
})

test('조각 받기에 끝이 있다: 한 번에 메시지 둘 · 조각 수 · 바이트 — 넘는 것은 버린다', () => {
  const parts = new Parts()
  const piece = (mid, n, of, b = 'AAAA') => ({ type: 'browser-part', mid, n, of, b })
  assert.equal(parts.take(piece('x', 0, MAX_PARTS + 1)), null)
  assert.equal(parts.open.size, 0, '조각 수가 끝을 넘으면 시작도 하지 않는다')
  for (const mid of ['a', 'b', 'c']) parts.take(piece(mid, 0, 2))
  assert.equal(parts.open.size, OPEN)
  assert.equal(parts.take(piece('a', 0, 2)), null, '같은 조각 두 번은 받지 않는다')
  assert.equal(parts.take({ ...piece('a', 1, 2), b: 'A'.repeat(PART * 2) }), null, '조각 하나가 너무 크다')
  parts.clear()
  assert.deepEqual([parts.open.size, parts.size], [0, 0])
})

test('작업이 쥐고 놓는 동작(begin · idle)이 있고, 창이 스스로 닫힌 뒤의 동작은 새 탭에서 — 닫기 · 보이기 · idle 은 탭을 만들지 않는다', async () => {
  assert.ok(OPS.has('begin') && OPS.has('idle'))
  const { svc, out, driver } = service()
  const made = []
  driver.ensureTab = async () => { made.push('tab') }
  driver.begin = async (a) => a
  driver.idle = async () => true
  driver.show = async () => true
  await svc.handle({ type: 'browser', id: 'o', op: 'open', args: { user: 'u-1' } })
  await svc.handle({ type: 'browser', id: 'b', op: 'begin', args: { noPrivate: true } })
  assert.deepEqual(replyOf(out, 'b').value, { noPrivate: true })
  assert.equal(made.length, 1)
  await svc.handle({ type: 'browser', id: 'l', op: 'look', args: {} })
  assert.equal(made.length, 2)
  for (const op of ['idle', 'show']) await svc.handle({ type: 'browser', id: op, op, args: {} })
  assert.equal(made.length, 2)
})

test('사람이 없는 작업이 PC 에서 열지 않는 주소: localhost · 127/8 · 10/8 · 172.16/12 · 192.168/16 · 링크 로컬 · ::1 · fc00::/7', () => {
  for (const u of ['http://localhost/', 'http://a.localhost:3000/', 'http://127.1.2.3/', 'http://10.0.0.1/', 'http://172.16.5.5/', 'http://172.31.0.1/', 'http://192.168.1.1/',
    'http://169.254.169.254/', 'http://[::1]/', 'http://[fc00::1]/', 'http://[fdab::2]/', 'http://[fe80::1]/', 'http://0.0.0.0/']) assert.equal(privateHost(u), true, u)
  for (const u of ['https://www.naver.com/', 'http://172.15.0.1/', 'http://172.32.0.1/', 'http://11.0.0.1/', 'https://[2001:db8::1]/']) assert.equal(privateHost(u), false, u)
})

test('사이트의 기본 인증(app.on(\'login\'))은 이 앱의 창이 서버에 갈 때만 — 서버가 모는 브라우저 · 프록시 · 다른 주소에는 답하지 않는다', () => {
  const server = 'https://acme.example/lite'
  assert.equal(answersGate({ mainSession: true, url: 'https://acme.example/lite/api/x', server }), true)
  assert.equal(answersGate({ mainSession: false, url: 'https://acme.example/lite/api/x', server }), false, '브라우저 작업의 세션')
  assert.equal(answersGate({ mainSession: true, isProxy: true, url: 'https://acme.example/', server }), false)
  assert.equal(answersGate({ mainSession: true, url: 'https://evil.example/', server }), false)
  assert.equal(answersGate({ mainSession: true, url: 'https://acme.example/', server: '' }), false)
})

test('이 PC 의 설정 「브라우저 작업」은 실행 설정과 함께 간다 — 모르는 값 · 없는 값은 「내가 시킨 작업만」', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgl-set-'))
  try {
    settings.init(dir)
    assert.equal(settings.runnerPrefs().browser, 'own')
    settings.set({ runnerPrefs: { ...settings.runnerPrefs(), browser: 'all' } })
    assert.deepEqual(settings.runnerPrefs(), { enabled: true, ask: false, finishMinutes: 5, browser: 'all' })
    settings.init(dir)
    assert.equal(settings.runnerPrefs().browser, 'all', '앱을 다시 켜도')
    for (const v of ['everything', '', null, undefined, 3]) assert.equal(settings.browserPrefOf(v), 'own')
    assert.deepEqual(settings.BROWSER_PREFS, ['own', 'all', 'off'])
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('닫으면 그 사람의 세션도 놓는다 — 다음 동작은 다시 「열기」(사람 확인)부터', async () => {
  const host = createBrowserHost({ electron: { BrowserWindow: class {}, session: { fromPartition: () => ({}) } }, tmp: os.tmpdir() })
  Object.assign(host.state, { partition: 'persist:pgl-browser-u-1', user: 'u-1', busy: true, noPrivate: true })
  assert.equal(host.opened(), true)
  await host.close()
  assert.deepEqual([host.state.partition, host.state.user, host.state.busy, host.state.noPrivate, host.opened()], [null, null, false, false, false])
  const out = []
  const svc = new BrowserService({ driver: host, send: (m) => { out.push(m); return true }, user: () => ({ id: 'u-1' }) })
  await svc.handle({ type: 'browser', id: 'l', op: 'look', args: {} })
  assert.deepEqual([out[0].ok, out[0].code], [false, 'closed'])
  assert.ok(MAX_WORDS === 200_000 && POPUPS === 10)
})

// ---- 2026-11-25 re-review ----
test('내부망(재검토): IPv4 를 품은 IPv6 · 끝의 점 · 한 단어 이름 · .local · .lan · .internal · .home.arpa 도 이 PC 의 망이다', () => {
  for (const u of ['http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/', 'http://[::ffff:c0a8:101]/', 'http://localhost./', 'http://intranet/', 'http://router.local/',
    'http://printer.lan/', 'http://db.internal/', 'http://nas.home.arpa/', 'http://2130706433/']) assert.equal(privateHost(u), true, u)
  for (const u of ['https://example.com./', 'http://[::ffff:808:808]/', 'https://www.naver.com/', 'https://local.example.com/']) assert.equal(privateHost(u), false, u)
})

test('링크가 끊기면 이 PC 의 브라우저는 작업이 쥔 상태를 놓는다(보내지도 막지도 않음) — 페이지는 그대로', async () => {
  const { createLocalRunner } = require('../src/runner')
  const calls = []
  const fakeHost = { opened: () => true, at: () => null, linkDown: () => { calls.push('linkDown'); return true }, close: () => true }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgl-run-'))
  try {
    const r = createLocalRunner({ server: 'http://127.0.0.1:9', token: 't', dataDir: dir, prefs: () => ({ enabled: true }), ask: async () => false, browser: fakeHost })
    r.browser.parts.take({ type: 'browser-part', mid: 'm', n: 0, of: 2, b: 'AAAA' })
    assert.equal(r.browser.parts.open.size, 1)
    r.link.emit('down')
    assert.deepEqual(calls, ['linkDown'])
    assert.equal(r.browser.parts.open.size, 0, '반쯤 온 조각도 버린다')
    r.stop()
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  // the host itself: no task holds it any more
  const host = createBrowserHost({ electron: { BrowserWindow: class {}, session: { fromPartition: () => ({ webRequest: { onBeforeRequest() {} } }) } }, tmp: os.tmpdir() })
  Object.assign(host.state, { partition: 'persist:pgl-browser-u-1', user: 'u-1', busy: true, noPrivate: true })
  host.linkDown()
  assert.deepEqual([host.state.busy, host.state.noPrivate, host.state.partition], [false, false, 'persist:pgl-browser-u-1'])
})

test('새 탭은 동작 안에서(시간 끝 안에) — 탭이 없을 때 동시에 온 동작들에 탭 하나', async () => {
  const { svc, out, driver } = service()
  await svc.handle({ type: 'browser', id: 'o', op: 'open', args: { user: 'u-1' } })
  let making = 0, made = 0
  driver.ensureTab = async () => { making++; await new Promise((r) => setTimeout(r, 30)); made++ }
  driver.stop = async () => true
  driver.frameShot = async () => 'x'
  driver.look = async () => ({ els: [] })
  await Promise.all([svc.handle({ type: 'browser', id: 's', op: 'stop', args: {} }), svc.handle({ type: 'browser', id: 'f', op: 'frameShot', args: {} }), svc.handle({ type: 'browser', id: 'l', op: 'look', args: {} })])
  assert.ok(['s', 'f', 'l'].every((id) => replyOf(out, id)?.ok), '모두 답했다')
  // (each asked for a tab inside its own operation; the host — host.js ensureTab — makes one for all: server/test/browserDriver.test.js)
  assert.equal(making, 3)
  assert.equal(made, 3)
  // a failing new tab fails the operation that needed it, with its reason
  driver.ensureTab = async () => { throw new Error('no window') }
  await svc.handle({ type: 'browser', id: 'l2', op: 'look', args: {} })
  assert.deepEqual([replyOf(out, 'l2').ok, replyOf(out, 'l2').error], [false, 'no window'])
})

// ---- desktop 0.2.6: never the Lite app this browser is part of, nor its sign-in ----
test('이 세션의 요청: Lite 앱과 그 로그인 출처는 언제나 막고, 이 PC 의 망은 사람이 없는 작업에서만 — 웹 주소가 아닌 것은 페이지 규칙에', () => {
  const app = { server: 'https://acme.process-gpt.io/lite', authOrigins: ['https://auth.process-gpt.io'] }
  assert.equal(requestVerdict('https://acme.process-gpt.io/lite/api/me', { app }), 'app')
  assert.equal(requestVerdict('wss://acme.process-gpt.io/lite/api/events', { app }), 'app')
  assert.equal(requestVerdict('https://auth.process-gpt.io/auth/v1/token?grant_type=password', { app, noPrivate: true }), 'app')
  assert.equal(requestVerdict('https://shop.example/', { app }), null)
  assert.equal(requestVerdict('http://127.0.0.1:8080/', { app }), null, '사람이 시킨 작업은 이 PC 의 망도 그대로')
  assert.equal(requestVerdict('http://127.0.0.1:8080/', { app, noPrivate: true }), 'private')
  assert.equal(requestVerdict('https://shop.example/', { app, noPrivate: true }), 'name')
  assert.equal(requestVerdict('data:text/plain,x', { app }), null)
  // a server on this PC: by its other names too
  const local = { server: 'http://localhost:5391', authOrigins: [] }
  for (const u of ['http://127.0.0.1:5391/api/auth/email/start', 'http://[::1]:5391/login']) assert.equal(requestVerdict(u, { app: local }), 'app', u)
  assert.equal(requestVerdict('http://127.0.0.1:5392/', { app: local }), null)
})

test('「열기」 동작: Lite 앱 · 로그인 주소는 열지 않고 까닭을 답한다 — 다음 읽기에 붙고, 이 PC 에 보인 창이면 사람에게 한 번 알린다', async () => {
  const told = []
  const host = createBrowserHost({ electron: { BrowserWindow: class {}, session: { fromPartition: () => ({}) } }, tmp: os.tmpdir(),
    appServer: () => ({ server: 'http://127.0.0.1:5391', authOrigins: ['https://auth.example'] }), notice: (n) => told.push(n.origin) })
  const sent = []
  const win = { isDestroyed: () => false, isVisible: () => true }
  const tab = { id: 1, win, wc: { getURL: () => 'about:blank', getTitle: () => '' }, cdp: { send: async (m, p) => { sent.push([m, p?.url]); return { loaderId: 'l1' } }, waitStage: async () => {} } }
  Object.assign(host.state, { partition: 'persist:pgl-browser-u-1', user: 'u-1', active: tab, tabs: [tab], step: { ...host.state.step, navMs: 2000, settleMs: 10 } })
  for (const url of ['http://localhost:5391/chat', 'http://127.0.0.1:5391/login']) {
    const r = await host.navigate({ url })
    assert.deepEqual([r.ok, r.error], [false, APP_REFUSED], url)
  }
  assert.deepEqual(sent, [], '페이지에 보내지도 않았다')
  assert.deepEqual(told, [], '숨은 창: 사람에게 알리지 않는다(에이전트가 답을 받는다)')
  host.state.shown = true
  await host.navigate({ url: 'https://auth.example/auth/v1/authorize?provider=google' })
  await host.navigate({ url: 'https://auth.example/auth/v1/authorize?provider=google' })
  assert.deepEqual(told, ['https://auth.example'], '보인 창: 한 번(같은 주소는 잠시 다시 알리지 않음)')
  const ok = await host.navigate({ url: 'https://shop.example/' })
  assert.equal(ok.ok, true)
  assert.deepEqual(sent, [['Page.navigate', 'https://shop.example/']])
  assert.equal(host.state.refused.length, 4)
  assert.ok(host.state.refused.every((r) => r.endsWith(APP_REFUSED)))
  assert.match(APP_REFUSED, /Process GPT Lite/)
})
