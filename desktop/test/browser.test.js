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
const { webAddress, privateHost, createBrowserHost, requestVerdict, APP_REFUSED, AGENT_HEADER, NOTICE_MS, MAX_WORDS, POPUPS } = require('../src/browser/host')
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

// ---- desktop 0.2.6 review: the app's server by any name of this PC, the mark on every request, one box at a time, a clean session ----
// A host with a session that keeps its handlers (as Electron's would), a resolver that answers from names, and one live tab
function fakeHost({ server = 'http://localhost:5391', authOrigins = [], names = {}, dir } = {}) {
  const on = {}, cleared = [], told = [], resolved = []
  let app = { server, authOrigins }
  const shown = { isDestroyed: () => false, isVisible: () => true }
  const ses = {
    webRequest: { onBeforeRequest: (fn) => { on.request = fn }, onBeforeSendHeaders: (fn) => { on.headers = fn } },
    setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, setDisplayMediaRequestHandler() {}, on() {},
    resolveHost: async (h) => { resolved.push(h); if (!(h in names)) throw new Error('ERR_NAME_NOT_RESOLVED'); return { endpoints: names[h].map((address) => ({ address })) } },
    clearStorageData: async ({ origin }) => { cleared.push(origin) },
  }
  const electron = { BrowserWindow: { fromWebContents: () => shown }, session: { fromPartition: () => ses }, app: { getPath: () => dir } }
  const host = createBrowserHost({ electron, tmp: os.tmpdir(), appServer: () => app, notice: (n) => told.push(n.origin) })
  const tab = { id: 1, win: shown, wc: { getURL: () => 'about:blank', getTitle: () => '' }, cdp: { on() {}, off() {}, send: async () => ({ loaderId: 'l1' }), waitStage: async () => {} } }
  Object.assign(host.state, { tabs: [tab], active: tab })
  const ask = (url, resourceType = 'xhr') => new Promise((r) => on.request({ url, resourceType, webContents: {} }, r))
  return { host, on, cleared, told, resolved, ask, ses, setApp: (a) => { app = a } }
}

test('이 PC 에 있는 Lite 서버는 이 PC 를 가리키는 다른 이름으로도 막는다 — 서버 포트로 가는 이름을 이 세션의 resolver 로 풀어 보고, 서버의 이름도 푼다', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgl-host-'))
  try {
    const f = fakeHost({ dir, names: { 'localtest.me': ['127.0.0.1'], '127.0.0.1.nip.io': ['127.0.0.1'], 'mapped.test': ['::ffff:7f00:1'], 'public.test': ['93.184.216.34'], 'both.test': ['93.184.216.34', '127.0.0.1'] } })
    await f.host.open({ user: 'u-1' })
    for (const u of ['http://localtest.me:5391/login', 'http://127.0.0.1.nip.io:5391/api/auth/email/start', 'ws://mapped.test:5391/api/events', 'http://both.test:5391/',
      'http://nowhere.lan:5391/', 'http://intranet:5391/', 'http://[::ffff:7f00:1]:5391/', 'http://[::7f00:1]:5391/']) assert.deepEqual(await f.ask(u), { cancel: true }, u)
    // (a public-looking name that does not resolve goes on — it reaches nothing; a name that may be local does not)
    for (const u of ['http://public.test:5391/', 'http://nowhere.test:5391/', 'http://localtest.me:3000/', 'https://shop.example/']) assert.deepEqual(await f.ask(u), {}, u)
    // the agent's 「열기」 too
    const r = await f.host.navigate({ url: 'http://localtest.me:5391/chat' })
    assert.deepEqual([r.ok, r.error], [false, APP_REFUSED])
    // a server the app reaches by a name of its own that resolves to this PC: this PC's other names on its port are it
    const g = fakeHost({ dir, server: 'http://lite.test:18080', names: { 'lite.test': ['127.0.0.1'], 'other.test': ['127.0.0.1'] } })
    await g.host.open({ user: 'u-1' })
    for (const u of ['http://localhost:18080/chat', 'http://127.0.0.1:18080/', 'http://other.test:18080/']) assert.deepEqual(await g.ask(u), { cancel: true }, u)
    assert.deepEqual(await g.ask('http://localhost:3000/'), {})
    // a company server: its own name only (it resolves elsewhere)
    const c = fakeHost({ dir, server: 'https://acme.process-gpt.io/lite', names: { 'acme.process-gpt.io': ['34.1.2.3'], 'localtest.me': ['127.0.0.1'] } })
    await c.host.open({ user: 'u-1' })
    assert.deepEqual(await c.ask('https://localhost/'), {})
    assert.deepEqual(await c.ask('https://acme.process-gpt.io/lite/api/me'), { cancel: true })
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('표시는 앱 서버의 다른 주소일 수 있는 곳에만 — 이 PC · 내부망(주소 · 이름 · 푼 주소), 앱 이름 아래, 앱 서버의 주소 · 앱이 알린 제 주소. 보통의 공개 사이트에는 없다', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgl-host-'))
  try {
    const names = { 'acme.process-gpt.io': ['34.1.2.3'], 'cdn-twin.example': ['34.1.2.3'], 'public.example': ['93.184.216.34'], 'home.example': ['192.168.1.20'], 'loop.example': ['127.0.0.1'],
      'lite-tunnel.example': ['104.1.1.1'], 'auth.process-gpt.io': ['35.9.9.9'] }
    const f = fakeHost({ dir, server: 'https://acme.process-gpt.io/lite', authOrigins: ['https://auth.process-gpt.io'], names })
    await f.host.open({ user: 'u-1' })
    // (onBeforeRequest decides, onBeforeSendHeaders adds it — the same request id)
    let id = 0
    const sent = async (url) => {
      const n = ++id
      const v = await new Promise((r) => f.on.request({ id: n, url, resourceType: 'xhr', webContents: {} }, r))
      if (v.cancel) return 'refused'
      const out = await new Promise((r) => f.on.headers({ id: n, url, requestHeaders: { Accept: '*/*', Cookie: 'a=1' } }, r))
      return out.requestHeaders?.[AGENT_HEADER] === '1' ? 'marked' : 'plain'
    }
    for (const u of ['http://127.0.0.1:8991/api/me', 'http://192.168.1.20:18080/', 'http://[::ffff:c0a8:114]/', 'http://router.local/', 'http://intranet/', 'https://home.example/',
      'https://loop.example/', 'https://www.process-gpt.io/', 'wss://other.process-gpt.io/api/events', 'https://cdn-twin.example/', 'http://localhost:3000/']) assert.equal(await sent(u), 'marked', u)
    for (const u of ['https://public.example/', 'https://accounts.google.com/signin', 'https://notebooklm.google.com/', 'https://nowhere.example/']) assert.equal(await sent(u), 'plain', u)
    // the mark goes once, with the other headers as they were
    const out = await new Promise((r) => { f.on.request({ id: 99, url: 'http://127.0.0.1:9/', resourceType: 'xhr', webContents: {} }, () => f.on.headers({ id: 99, url: 'http://127.0.0.1:9/', requestHeaders: { Accept: 'text/html', Cookie: 'a=1' } }, r)) })
    assert.deepEqual(out.requestHeaders, { Accept: 'text/html', Cookie: 'a=1', [AGENT_HEADER]: '1' })
    assert.deepEqual(await new Promise((r) => f.on.headers({ id: 99, url: 'http://127.0.0.1:9/', requestHeaders: {} }, r)), {}, '한 번만')
    assert.equal(AGENT_HEADER, 'X-PGL-Agent-Browser')
    // the addresses the server gives for itself (a tunnel): refused as the app, and names under them marked
    const t = fakeHost({ dir, server: 'http://localhost:18080', names })
    t.setApp({ server: 'http://localhost:18080', authOrigins: [], appOrigins: ['https://lite-tunnel.example'] })
    await t.host.open({ user: 'u-1' })
    assert.deepEqual(await t.ask('https://lite-tunnel.example/api/me'), { cancel: true })
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('이 PC 에 있는 서버가 80 · 443 에 있어도 이름을 풀지 못한 보통의 사이트는 막지 않는다 — 이 PC · 내부망일 수 있는 이름만', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgl-host-'))
  try {
    const f = fakeHost({ dir, server: 'http://localhost', names: { 'x.localtest.me': ['127.0.0.1'], 'shop.example': ['93.184.216.34'] } })
    await f.host.open({ user: 'u-1' })
    for (const u of ['https://slow-or-gone.example/', 'https://shop.example/', 'http://shop.example/']) assert.deepEqual(await f.ask(u), {}, u)
    for (const u of ['https://x.localtest.me/', 'http://printer.lan/', 'http://intranet/', 'http://nas.home.arpa/']) assert.deepEqual(await f.ask(u), { cancel: true }, u)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('보인 창의 안내 상자는 10초에 한 번까지(주소가 달라도) — 에이전트의 답과 다음 읽기에는 매번', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgl-host-'))
  try {
    const f = fakeHost({ dir, authOrigins: ['https://auth.example'] })
    await f.host.open({ user: 'u-1' })
    f.host.state.shown = true
    for (let i = 0; i < 30; i++) await f.ask(i % 2 ? `http://localhost:5391/x${i}` : 'https://auth.example/auth/v1/authorize', 'mainFrame')
    assert.deepEqual(f.told, ['https://auth.example'])
    assert.equal(f.host.state.refused.length, 5, '다음 읽기에 붙는 것은 마지막 다섯')
    assert.equal(NOTICE_MS, 10_000)
    f.host.state.toldAt = Date.now() - NOTICE_MS - 1
    await f.ask('http://localhost:5391/', 'mainFrame')
    assert.deepEqual(f.told, ['https://auth.example', 'http://localhost:5391'])
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('앞선 판에서 이 세션에 남은 Lite 의 저장소 · 쿠키는 한 번 지운다 — 서버 · 로그인 출처(이 PC 의 서버면 그 이름들), 한 번 한 것은 다시 하지 않는다', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgl-host-'))
  try {
    const f = fakeHost({ dir, authOrigins: ['http://localhost:54321'] })
    await f.host.open({ user: 'u-1' })
    assert.deepEqual(f.cleared.sort(), ['http://127.0.0.1:5391', 'http://[::1]:5391', 'http://localhost:5391', 'http://localhost:54321'])
    const kept = JSON.parse(fs.readFileSync(path.join(dir, 'browser-cleared.json'), 'utf8'))
    assert.equal(kept['persist:pgl-browser-u-1'].length, 4)
    // the app again (a new host): nothing again; another person's session, or another server: theirs once
    const again = fakeHost({ dir, authOrigins: ['http://localhost:54321'] })
    await again.host.open({ user: 'u-1' })
    assert.deepEqual(again.cleared, [])
    const other = fakeHost({ dir, server: 'https://acme.process-gpt.io/lite' })
    await other.host.open({ user: 'u-1' })
    assert.deepEqual(other.cleared, ['https://acme.process-gpt.io'])
    const person = fakeHost({ dir })
    await person.host.open({ user: 'u-2' })
    assert.equal(person.cleared.length, 3)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
