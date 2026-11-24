// 페이지 드라이버 두 개(lib/browserServer.js — 이 서버의 Chromium · lib/browserRemote.js — 사람 PC 의 데스크톱 앱 브라우저, 링크 너머)가
// 같은 일을 같게 한다: 같은 시험을 두 드라이버에 그대로 돌린다(시험 사이트 fixtures/drivers.mjs, 다른 출처의 iframe 포함). 원격 쪽은 진짜
// 데스크톱 앱 코드다 — Electron 이 앱의 로컬 러너(desktop/src/runner)와 브라우저(desktop/src/browser/host.js)를 띄우고, 이 시험의 서버
// 링크(hub.js)에 기기 토큰으로 붙는다. 그리고 어디서 돌지 정하는 규칙, 링크의 조각 나누기, 페이지 스크립트가 데스크톱 사본과 같은지.
// Run: node --test test/browserDriver.test.js   (로컬 DB, desktop/ 의 npm ci — Electron 이 없으면 원격 쪽은 건너뛴다)
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { startDriverSite, PASSWORD, REPORT } from './fixtures/drivers.mjs'
import { startDesktopBrowser, haveElectron } from './fixtures/desktopBrowser.mjs'

const require = createRequire(import.meta.url)
const { jpegjs } = require('playwright-core/lib/utilsBundle')
process.env.PRO_LOCAL_BROWSER_MAX_MESSAGE = String(8 * 1024 * 1024) // (the link's cap, small here: the cap test sends up to it)
process.env.PRO_LOCAL_BROWSER_MAX_TOTAL = String(12 * 1024 * 1024) // (the cap across all links: two links of 7 MB go over it)
const S = await import('../lib/browserSteps.js')
const { ServerDriver } = await import('../lib/browserServer.js')
const { RemoteDriver, routeOf, privateAddress } = await import('../lib/browserRemote.js')
const BL = await import('../lib/localAgents/browserLink.js')
const H = await import('../lib/localAgents/hub.js')
const D = await import('../lib/localAgents/devices.js')
const { config } = await import('../config.js')
const { q, pool } = await import('../lib/supa.js')
const desktopScripts = require('../../desktop/src/browser/pageScripts.js')

// ---- the page scripts the desktop runs are the server's own ----
test('데스크톱이 페이지 안에서 돌리는 읽기 스크립트는 서버의 것과 글자 하나 다르지 않다', () => {
  for (const k of ['SECRET_SELECTOR', 'IS_SECRET_JS', 'DESCRIBE_JS', 'PAGE_WORDS_JS', 'SNAPSHOT_JS']) {
    assert.equal(String(desktopScripts[k]), String(S[k]), `${k}: desktop/src/browser/pageScripts.js 를 server/lib/browserSteps.js 와 같게`)
  }
})

// ---- where a task runs: each PC's own setting (prefs.browser), the person's own tasks only unless that PC says 'all' ----
test('어디서 도나: 그 PC 의 설정 — 기본은 내가 시킨 작업만, 사람이 없는 작업은 「모두」인 PC 만, 끄거나 단계 실행을 끄면 서버', () => {
  const pc = (id, since, prefs = {}, browser = true) => ({ id, name: id, since: new Date(since), caps: { browser }, prefs })
  assert.deepEqual(routeOf({ links: [] }), { kind: 'server', why: 'no-desktop' })
  assert.deepEqual(routeOf({ links: [pc('old', 1, {}, false)] }), { kind: 'server', why: 'old-desktop' })
  assert.equal(routeOf({ links: [pc('a', 1)] }).link.id, 'a', '정한 적 없음 = 내가 시킨 작업은 PC')
  assert.equal(routeOf({ links: [pc('a', 1), pc('b', 2)] }).link.id, 'b', '가장 최근에 이어진 PC')
  assert.equal(routeOf({ links: [pc('old', 3, {}, false), pc('a', 1)] }).link.id, 'a', '브라우저가 있는 PC 만')
  assert.deepEqual(routeOf({ links: [pc('a', 1, { browser: 'off' })] }), { kind: 'server', why: 'off' })
  assert.deepEqual(routeOf({ links: [pc('a', 1, { enabled: false, browser: 'all' })] }), { kind: 'server', why: 'off' }, '「이 컴퓨터에서 단계 실행」을 끈 PC 로는 가지 않는다')
  assert.deepEqual(routeOf({ links: [pc('a', 1)], own: false }), { kind: 'server', why: 'not-own' }, '사람이 없는 작업은 기본으로 서버')
  assert.deepEqual(routeOf({ links: [pc('a', 1, { browser: 'own' })], own: false }), { kind: 'server', why: 'not-own' })
  assert.equal(routeOf({ links: [pc('a', 2, { browser: 'own' }), pc('b', 1, { browser: 'all' })], own: false }).link.id, 'b', '「모두」로 정한 PC 만')
  assert.equal(routeOf({ links: [pc('a', 2, { browser: 'off' }), pc('b', 1)] }).link.id, 'b', '끈 PC 는 건너뛴다')
  // the desktop's prefs as the hub keeps them (devices.js prefsOf): an unknown value is the default
  assert.deepEqual(D.prefsOf({ enabled: true, browser: 'everything' }), { enabled: true, ask: false, browser: 'own' })
  assert.equal(D.prefsOf({ browser: 'all' }).browser, 'all')
})

test('사람이 없는 작업은 PC 의 내부망 주소를 열지 않는다(이름 · 번호로)', () => {
  for (const u of ['http://localhost:8080/', 'http://app.localhost/', 'http://127.0.0.1/', 'http://10.1.2.3/', 'http://172.16.0.1/', 'http://172.31.255.1/', 'http://192.168.0.10/',
    'http://169.254.169.254/latest', 'http://0.0.0.0/', 'http://[::1]/', 'http://[fd12::1]/', 'http://[fe80::1]/', 'http://100.64.0.1/']) assert.equal(privateAddress(u), true, u)
  for (const u of ['https://www.naver.com/', 'http://172.32.0.1/', 'http://8.8.8.8/', 'https://192.169.0.1/', 'not a url']) assert.equal(privateAddress(u), false, u)
  const { privateHost } = require('../../desktop/src/browser/host.js')
  for (const u of ['http://localhost/', 'http://10.0.0.1/', 'http://[::1]/', 'https://www.naver.com/']) assert.equal(privateHost(u), privateAddress(u), `데스크톱과 같게: ${u}`)
})

// (2026-11-25 re-review probes: each of these reached the PC's own network)
const PRIVATE_PROBES = ['http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/', 'http://[::ffff:c0a8:1]/', 'http://[::ffff:a00:1]/', 'http://[::127.0.0.1]/', 'http://localhost./',
  'http://127.0.0.1./', 'http://intranet/', 'http://intranet./', 'http://router.local/', 'http://printer.lan/', 'http://db.internal/', 'http://nas.home.arpa/', 'http://wiki.intranet/',
  'http://box.localdomain/', 'http://2130706433/', 'http://0x7f.1/', 'http://[fc00::1]/']
const PUBLIC_PROBES = ['https://example.com./', 'http://[::ffff:808:808]/', 'http://[2001:4860:4860::8888]/', 'https://www.naver.com/', 'https://local.example.com/', 'https://lan.example.org/']
test('내부망 판단(재검토): IPv4 를 품은 IPv6 · 끝의 점 · 한 단어 이름 · .local · .lan · .internal · .home.arpa — 서버와 데스크톱이 같다', () => {
  const { privateHost } = require('../../desktop/src/browser/host.js')
  for (const u of PRIVATE_PROBES) { assert.equal(privateAddress(u), true, `서버: ${u}`); assert.equal(privateHost(u), true, `데스크톱: ${u}`) }
  for (const u of PUBLIC_PROBES) { assert.equal(privateAddress(u), false, `서버: ${u}`); assert.equal(privateHost(u), false, `데스크톱: ${u}`) }
})

test('원격 드라이버는 그 사람의 링크에만 붙는다', () => {
  assert.throws(() => new RemoteDriver({ id: 'd', name: 'x', userId: 'someone' }, 'another'), /own person/)
})

// ---- the link's pieces ----
const fakeLink = (name = '조각 PC') => ({ id: 'link-x', name, userId: 'u', send: () => true })
const bindTo = (link, got = [], holding = true) => { const d = { link, holding, at() {}, onFrame() {}, onEvent: (e) => got.push(e), linkLost() {} }; BL.bind(link, d); return d }

test('링크: 1MB 를 넘는 메시지는 바이트로 재어 조각으로 가고, 와서 다시 하나가 된다 — 한글 40만 자(1.2MB)도 양쪽으로', async () => {
  const { Parts, sendBig } = require('../../desktop/src/browser/protocol.js')
  const korean = '가'.repeat(400_000)
  for (const payload of [korean, crypto.randomBytes(1_500_000).toString('base64')]) {
    const big = { type: 'browser-event', kind: 'download', name: 'big.bin', data: payload }
    // desktop → server: every frame under the hub's 1 MB in bytes
    const sent = []
    assert.equal(sendBig((m) => { sent.push(m); return true }, big), true)
    assert.ok(sent.length >= 2 && sent.every((m) => m.type === 'browser-part' && Buffer.byteLength(JSON.stringify(m)) < 1024 * 1024), sent.map((m) => Buffer.byteLength(JSON.stringify(m))).join(','))
    const got = []
    const link = fakeLink()
    const d = bindTo(link, got)
    for (const m of sent.reverse()) await BL.receive(link, m) // (in any order)
    assert.equal(got.length, 1)
    assert.equal(got[0].data, payload)
    BL.unbind(link, d)
    // server → desktop
    const out = []
    BL.send({ send: (m) => { out.push(m); return true } }, { type: 'browser', id: '1', op: 'attach', args: { data: payload } })
    assert.ok(out.length >= 2 && out.every((m) => Buffer.byteLength(JSON.stringify(m)) < 1024 * 1024))
    const parts = new Parts()
    let whole = null
    for (const m of out) whole = parts.take(m) || whole
    assert.equal(whole.args.data, payload)
  }
  // whole or in pieces by bytes, not letters: 320K Korean letters (960 KB) go in pieces, 320K ASCII letters (320 KB) whole
  for (const [t, pieces] of [['가'.repeat(320_000), true], ['a'.repeat(320_000), false]]) {
    const out = []
    BL.send({ send: (m) => { out.push(m); return true } }, { type: 'browser', id: '2', op: 'x', args: { t } })
    assert.equal(out.length > 1, pieces, `${t[0]} ×320K`)
    const sent = []
    sendBig((m) => { sent.push(m); return true }, { type: 'browser-reply', id: '2', ok: true, value: t })
    assert.equal(sent.length > 1, pieces, `PC: ${t[0]} ×320K`)
  }
})

test('링크: 쓰지 않는 링크의 조각은 받지 않고, 한 링크에 메시지 둘 · 조각 수 · 바이트에 끝이 있다 — 메모리가 늘지 않는다', async () => {
  const link = fakeLink('조각을 쏟아붓는 PC')
  const piece = (mid, n, of, bytes = BL.PART) => ({ type: 'browser-part', mid, n, of, b: crypto.randomBytes(bytes).toString('base64') })
  // no task uses this link: 400 pieces of a message that never ends — none kept (the review grew the server by 389 MB this way)
  const rss0 = process.memoryUsage().rss
  for (let n = 0; n < 400; n++) await BL.receive(link, piece(`m${n}`, 0, BL.MAX_PARTS))
  assert.deepEqual(BL.stats(link), { open: 0, bytes: 0, bound: false })
  assert.ok(process.memoryUsage().rss - rss0 < 120 * 1024 * 1024, `RSS +${Math.round((process.memoryUsage().rss - rss0) / 1048576)} MB`)
  // a link a task uses: no more than OPEN messages at once, no more than MAX_PARTS pieces, no more than MAX_MESSAGE bytes in all
  const d = bindTo(link)
  await BL.receive(link, piece('too-many', 0, BL.MAX_PARTS + 1, 10))
  assert.equal(BL.stats(link).open, 0, '조각 수가 끝을 넘는 메시지')
  for (const mid of ['a', 'b', 'c']) await BL.receive(link, piece(mid, 0, 3, 10))
  assert.equal(BL.stats(link).open, BL.OPEN, `한 링크에 ${BL.OPEN}개까지`)
  BL.linkGone(link)
  const link2 = fakeLink('조각을 쏟아붓는 PC')
  bindTo(link2)
  const of = BL.MAX_PARTS
  for (let n = 0; n < of; n++) await BL.receive(link2, piece('huge', n, of))
  assert.ok(BL.stats(link2).bytes <= BL.MAX_MESSAGE, `${BL.stats(link2).bytes} bytes`)
  assert.equal(BL.stats(link2).open, 0, '바이트가 끝을 넘은 메시지는 버린다')
  BL.linkGone(link2)
  void d
})

test('링크(재검토): 작업이 쥐지 않은 링크(한 번 쓴 드라이버가 묶여 있어도)의 조각은 받지 않고, 모든 링크를 합친 끝이 있고, 버린다는 말은 링크마다 1분에 한 번', async () => {
  const piece = (mid, n, of, bytes = BL.PART) => ({ type: 'browser-part', mid, n, of, b: crypto.randomBytes(bytes).toString('base64') })
  // a driver bound from a task that is over (idle): not holding — nothing taken
  const done = fakeLink('작업이 끝난 PC')
  const dd = bindTo(done, [], false)
  for (let n = 0; n < 5; n++) await BL.receive(done, piece(`m${n}`, 0, 3))
  assert.deepEqual(BL.stats(done), { open: 0, bytes: 0, bound: true })
  // the RemoteDriver's own flag: begin → holding, idle → not
  const rd0 = new RemoteDriver({ id: 'x', name: 'x', userId: 'u', send: () => true }, 'u')
  assert.equal(rd0.holding, false)
  rd0.call = async () => true
  rd0.quiet = async () => null
  await rd0.begin()
  assert.equal(rd0.holding, true)
  await rd0.idle({ keep: true })
  assert.equal(rd0.holding, false)
  BL.linkGone(done)
  void dd
  // two links each sending 7 MB at once (each under its own 8 MB): together over the 12 MB across all — the second is dropped
  const a = fakeLink('PC 하나'), b = fakeLink('PC 둘')
  bindTo(a); bindTo(b)
  const of = Math.ceil((7 * 1024 * 1024) / BL.PART)
  const warns = []
  const keep = console.warn
  console.warn = (...x) => warns.push(x.join(' '))
  try {
    for (let n = 0; n < of - 1; n++) await BL.receive(a, piece('big-a', n, of))
    for (let n = 0; n < of - 1; n++) await BL.receive(b, piece('big-b', n, of))
    assert.ok(BL.stats().total <= BL.MAX_TOTAL, `${BL.stats().total} > ${BL.MAX_TOTAL}`)
    assert.equal(BL.stats(a).open, 1, '먼저 온 것은 그대로')
    assert.equal(BL.stats(b).open, 0, '모두 합친 끝을 넘은 것은 버린다')
    // its later pieces are not taken up again, and the log says so once
    for (let n = 0; n < of; n++) await BL.receive(b, piece('big-b', n, of, 10))
    assert.equal(BL.stats(b).open, 0)
    for (let k = 0; k < 50; k++) { for (const mid of ['x', 'y', 'z']) await BL.receive(a, piece(`${mid}${k}`, 0, 2, 10)) }
    const said = (name) => warns.filter((w) => w.includes(name)).length
    assert.equal(said('PC 둘'), 1, warns.join('\n'))
    assert.ok(said('PC 하나') <= 2, warns.join('\n'))
  } finally { console.warn = keep }
  BL.linkGone(a); BL.linkGone(b)
  assert.equal(BL.stats().total, 0, '링크가 닫히면 합계도 돌아온다')
})

test('링크: 같은 기기의 새 링크가 오가는 중이면, 옛 링크가 늦게 닫혀도 새 링크의 조각은 그대로다', async () => {
  const old = fakeLink(), fresh = fakeLink() // (the same device id, two link objects)
  bindTo(old)
  const got = []
  bindTo(fresh, got)
  const out = []
  BL.send({ send: (m) => { out.push(m); return true } }, { type: 'browser-event', kind: 'download', name: 'x', data: '나'.repeat(400_000) })
  await BL.receive(fresh, out[0])
  BL.linkGone(old)
  for (const m of out.slice(1)) await BL.receive(fresh, m)
  assert.equal(got.length, 1)
  BL.linkGone(fresh)
})

test('링크가 끊기면 기다리던 호출은 바로 「연결 끊김」으로 끝나고, 드라이버는 그것을 안다', async () => {
  const fake = { id: crypto.randomUUID(), name: '끊길 PC', userId: 'u1', tenant: 't', send: () => true }
  let lost = 0
  const d = new RemoteDriver(fake, 'u1', { lost: () => lost++ })
  BL.bind(fake, d)
  const p = d.call('look', {}, { timeoutMs: 10_000 })
  const t0 = Date.now()
  BL.linkGone(fake)
  await assert.rejects(p, (e) => e.lost === true)
  assert.ok(Date.now() - t0 < 200)
  assert.equal(d.lost, true)
  assert.equal(lost, 1)
  await assert.rejects(d.call('look'), (e) => e.lost === true, '끊긴 뒤의 호출도')
  assert.deepEqual((await d.look()).els, [], '읽기는 빈 페이지')
})

// ---- the same suite on both drivers ----
const T = config.tenantId
const userS = crypto.randomUUID(), userR = crypto.randomUUID()
let site, hub, pc, sd, rd
const seen = { server: { frames: 0, downloads: [] }, local: { frames: 0, downloads: [] } }
const hooks = (k) => ({
  frame: () => { seen[k].frames++ },
  wantsDownload: () => true,
  download: async (_d, f) => {
    try { seen[k].downloads.push({ name: f.name, data: (await f.read()).toString('utf8') }) } catch (e) { seen[k].downloads.push({ name: f.name, error: e.message, status: e.status ?? null }) }
  },
})
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pgl-drv-'))
const upload = path.join(tmp, 'hello.txt')
const downloads = path.join(tmp, 'Downloads') // (the PC's Downloads folder in this test)
fs.mkdirSync(downloads, { recursive: true })
fs.writeFileSync(upload, 'hi there')

before(async () => {
  site = await startDriverSite()
  sd = await ServerDriver.open(userS, hooks('server'))
  if (!haveElectron()) return
  hub = http.createServer()
  H.attach(hub)
  await new Promise((r) => hub.listen(0, '127.0.0.1', r))
  const { token } = await D.issue({ id: userR }, { name: '드라이버 시험 PC', platform: process.platform, appVersion: '0.2.3' })
  pc = startDesktopBrowser({ server: `http://127.0.0.1:${hub.address().port}`, token, userData: path.join(tmp, 'pc'), env: { PGL_BROWSER_MAX_DOWNLOAD: String(2 * 1024 * 1024), PGL_TEST_DOWNLOADS: downloads } })
  assert.equal(await pc.ready, userR)
  const link = H.linksOf(T, userR)[0]
  assert.equal(link.caps.browser, true, '0.2.3 데스크톱은 caps.browser 를 알린다')
  rd = await RemoteDriver.open(link, userR, hooks('local'))
  // (a task takes it: frames and downloads go to the server only now)
  await rd.begin()
})
after(async () => {
  await sd?.close().catch(() => {})
  await rd?.close().catch(() => {})
  await pc?.stop()
  hub?.close()
  await site?.close()
  await q('delete from pro_local_devices where user_id = any($1)', [[userS, userR]]).catch(() => {})
  await pool.end()
  fs.rmSync(path.join((await import('../lib/browserServer.js')).PROFILES, userS), { recursive: true, force: true })
  fs.rmSync(tmp, { recursive: true, force: true })
})

const until = async (fn, ms = 10_000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v || Date.now() > end) return v; await new Promise((r) => setTimeout(r, 100)) } }
const el = (snap, text) => {
  const e = snap.els.find((x) => x.text === text)
  assert.ok(e, `no element "${text}" in ${snap.els.map((x) => x.text).join(' | ')}`)
  return e.i
}
// average brightness of a box of the picture around (x, y)
const brightness = (jpg, x, y, w = 40, h = 8) => {
  const img = jpegjs.decode(jpg, { useTArray: true })
  let sum = 0, n = 0
  for (let yy = Math.max(0, y - h); yy < Math.min(img.height, y + h); yy++) {
    for (let xx = Math.max(0, x - w); xx < Math.min(img.width, x + w); xx++) { const o = (yy * img.width + xx) * 4; sum += (img.data[o] + img.data[o + 1] + img.data[o + 2]) / 3; n++ }
  }
  return { avg: sum / n, width: img.width, height: img.height }
}

for (const kind of ['server', 'local']) {
  const d = () => (kind === 'server' ? sd : rd)
  const skip = kind === 'local' && !haveElectron() ? 'desktop/ 에 Electron 이 없다(npm ci)' : false

  test(`${kind}: 열고 읽기 — 제목 · 사이트 이름 · 번호 붙은 요소 · 다른 출처 iframe 안의 단추와 글`, { skip }, async () => {
    const r = await d().navigate(`${site.url}/shop`)
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(d().url(), `${site.url}/shop`)
    assert.equal(await d().title(), '가상 상점')
    const snap = await d().look()
    assert.equal(snap.site, '가상 상점')
    el(snap, '검색')
    el(snap, '안쪽 단추')
    assert.match(snap.text, /아직 찾지 않음/)
    assert.match(snap.text, /\[frame localhost:\d+\]\n안쪽 글/)
    assert.deepEqual(d().viewport(), { width: 1280, height: 800 })
  })

  test(`${kind}: 요소 이름 · 비밀 칸 · 자리`, { skip }, async () => {
    const snap = await d().look()
    assert.deepEqual(await d().describe(el(snap, '검색')), { name: '검색', field: false, secret: '', what: '검색' })
    const pw = snap.els.find((x) => x.type === 'password').i
    assert.equal((await d().describe(pw)).secret, 'password')
    assert.equal(await d().isSecret(pw), true)
    assert.equal(await d().isSecret(snap.els.find((x) => x.name === 'q').i), false)
    assert.equal(await d().describe(9999, { strict: true }), null, '없는 요소')
    const b = await d().box(el(snap, '검색'))
    assert.ok(b.x > 0 && b.x < 1280 && b.y > 0 && b.y < 800 && b.w === 1280 && b.h === 800, JSON.stringify(b))
  })

  test(`${kind}: 입력하고 Enter · 누르기 · iframe 안에서 누르고 입력 · 날짜 칸`, { skip }, async () => {
    let snap = await d().look()
    await d().fill(snap.els.find((x) => x.name === 'q').i, '가상 사과', { enter: true })
    snap = await d().look()
    assert.match(snap.text, /찾은 것: 가상 사과/)
    await d().click(el(snap, '세기'))
    snap = await d().look()
    assert.match(snap.text, /눌림 1/)
    await d().click(el(snap, '안쪽 단추'))
    snap = await d().look()
    assert.match(snap.text, /안쪽 눌림/)
    await d().fill(el(snap, '안쪽 칸'), '안쪽에 쓴 말')
    const date = snap.els.find((x) => x.type === 'date').i
    await d().fill(date, '2026-12-18')
    const words = await d().words()
    assert.match(words, /2026-12-18/)
    assert.match(words, /가상 사과/)
    assert.match((await d().look()).text, /안쪽 글|안쪽 눌림/)
  })

  test(`${kind}: 보관함 값 넣기 — 읽기 · 글 · 페이지 낱말에 값이 없고, 모델의 그림에서는 칠해진다`, { skip }, async () => {
    let snap = await d().look()
    const pw = snap.els.find((x) => x.type === 'password').i
    await d().fillSecret(pw, PASSWORD)
    snap = await d().look()
    const e = snap.els.find((x) => x.type === 'password')
    assert.equal(e.secret, true)
    assert.equal(e.filled, true)
    assert.ok(!JSON.stringify(snap).includes(PASSWORD), '읽기에 비밀번호가 없다')
    assert.ok(!String(await d().words()).includes(PASSWORD), '낱말에 없다')
    assert.ok(!String(await d().text()).includes(PASSWORD), '글에 없다')
    const b = await d().box(e.i)
    const shot = await d().shot()
    assert.ok(shot && shot[0] === 0xff && shot[1] === 0xd8, 'JPEG')
    const m = brightness(shot, b.x, b.y)
    assert.deepEqual([m.width, m.height], [1280, 800], '1280×800 (레티나에서도)')
    assert.ok(m.avg < 60, `비밀번호 칸이 칠해졌다(밝기 ${m.avg.toFixed(0)})`)
    const frame = Buffer.from(await d().frameShot(), 'base64')
    assert.ok(frame[0] === 0xff && frame[1] === 0xd8)
    assert.ok(brightness(frame, b.x, b.y).avg > 60, '실시간 화면의 그림은 칠하지 않는다(점으로 보인다)')
  })

  test(`${kind}: 보관함 값을 키 하나씩(사람처럼) 치고 Enter 로 보낸다 — 칸은 처음부터 가려지고, 읽기에 값이 없다`, { skip }, async () => {
    await d().navigate(`${site.url}/keys`)
    let snap = await d().look()
    const user = el(snap, '아이디'), pass = snap.els.find((x) => x.type === 'password').i
    await d().fillSecret(user, 'hong', { keys: true })
    await d().fillSecret(pass, PASSWORD, { keys: true })
    snap = await d().look()
    assert.match(snap.text, new RegExp(`keys u=4 p=${PASSWORD.length}`), '글자마다 키 하나')
    assert.equal(snap.els.find((x) => x.i === user).secret, true, '아이디 칸도 가려진다')
    assert.ok(!JSON.stringify(snap).includes(PASSWORD) && !JSON.stringify(snap).includes('hong'))
    await d().press(pass, 'Enter')
    assert.match((await d().look()).text, /환영합니다, hong/, '키로 친 값이 그대로 — 대문자 · 기호 포함')
  })

  test(`${kind}: 스크롤하면 아래 글이 읽힌다`, { skip }, async () => {
    await d().navigate(`${site.url}/long`)
    assert.ok(!(await d().look()).text.includes('맨 아래 줄'))
    for (let k = 0; k < 3 && !(await d().look()).text.includes('맨 아래 줄'); k++) await d().scroll(null, 2400)
    assert.match((await d().look()).text, /맨 아래 줄/)
  })

  test(`${kind}: 파일 칸에 넣기 · 파일 고르개로 넣기`, { skip }, async () => {
    await d().navigate(`${site.url}/file`)
    let snap = await d().look()
    await d().attach(snap.els.find((x) => x.type === 'file').i, upload, 'hello.txt')
    await d().attach(el(snap, '파일 고르기'), upload, 'hello.txt')
    snap = await d().look()
    assert.match(snap.text, /받은 파일: hello\.txt 8/)
    assert.match(snap.text, /고른 파일: hello\.txt/)
  })

  test(`${kind}: 새 탭을 여는 링크 → 일은 그 탭에서, 스스로 닫히는 창이 닫히면 연 페이지로 돌아온다`, { skip }, async () => {
    const at = (end) => until(() => d().url().endsWith(end))
    await d().navigate(`${site.url}/tabs`)
    await d().click(el(await d().look(), '새 탭으로 긴 페이지'))
    assert.ok(await at('/long'), d().url())
    assert.match((await d().look()).text, /긴 페이지 맨 위/)
    // a task's end closes the other tabs — never the one the work is in (on the PC its opener stays with it)
    await d().closeOtherTabs()
    await new Promise((r) => setTimeout(r, 300))
    assert.ok(d().url().endsWith('/long'), d().url())
    assert.match((await d().look()).text, /긴 페이지 맨 위/)
    await d().healthy()
    await d().navigate(`${site.url}/tabs`)
    await d().click(el(await d().look(), '닫히는 창 열기'))
    assert.ok(await at('/closer'), d().url())
    await d().click(el(await d().look(), '창 닫기'))
    assert.ok(await at('/tabs'), `돌아온 곳 ${d().url()}`)
    assert.match((await d().look()).text, /닫히는 창 열기/)
    await d().closeOtherTabs()
  })

  test(`${kind}: 받은 파일은 드라이버의 갈고리로 온다`, { skip }, async () => {
    await d().navigate(`${site.url}/download`)
    const before = seen[kind].downloads.length
    await d().click(el(await d().look(), '보고서 받기'))
    const end = Date.now() + 10_000
    while (seen[kind].downloads.length === before && Date.now() < end) await new Promise((r) => setTimeout(r, 100))
    assert.deepEqual(seen[kind].downloads.at(-1), { name: 'report.txt', data: REPORT })
  })

  test(`${kind}: 끝나지 않는 페이지는 문서가 오면 진행하고, 멈출 수 있다 · 직접 제어(누르기 · 글자) · 실시간 화면`, { skip }, async () => {
    const t0 = Date.now()
    const r = await d().navigate(`${site.url}/never`)
    assert.equal(r.ok, true)
    assert.ok(Date.now() - t0 < 6000, `${Date.now() - t0}ms`)
    await d().stop()
    assert.match((await d().look()).text, /본문은 왔어요/)
    await d().navigate(`${site.url}/shop`)
    const snap = await d().look()
    const b = await d().box(el(snap, '세기'))
    await d().input({ type: 'click', x: b.x / 1280, y: b.y / 800 })
    await new Promise((r) => setTimeout(r, 300))
    assert.match((await d().look()).text, /눌림 1/)
    const q = await d().box(snap.els.find((x) => x.name === 'q').i)
    await d().input({ type: 'click', x: q.x / 1280, y: q.y / 800 })
    await d().input({ type: 'text', text: '손으로' })
    await d().input({ type: 'key', key: 'Enter' })
    await new Promise((r) => setTimeout(r, 300))
    assert.match((await d().look()).text, /찾은 것: 손으로/)
    assert.equal(await d().healthy().then(() => true), true)
    assert.ok(seen[kind].frames > 0, '실시간 화면 프레임')
  })
  test(`${kind}: 페이지의 대화 상자(confirm · alert)는 상자를 띄우지 않고 취소되고, 그 말은 다음 읽기에 한 번 온다`, { skip }, async () => {
    await d().navigate(`${site.url}/dialog`)
    await d().click(el(await d().look(), '지우기'))
    const snap = await d().look()
    assert.match(snap.text, /안 지움/, 'confirm 은 「취소」')
    assert.match(snap.text, /\[dialog\] confirm: 정말 지울까요\?/)
    assert.match(snap.text, /\[dialog\] alert: 끝났어요/)
    assert.doesNotMatch((await d().look()).text, /\[dialog\]/, '한 번만')
    assert.match((await d().look()).text, /안 지움/, '페이지는 그대로 움직인다')
  })

  test(`${kind}: 한글 40만 자 페이지 — 낱말 · 읽기가 오고, 링크는 끊기지 않는다`, { skip }, async () => {
    await d().navigate(`${site.url}/korean`)
    const w = await d().words()
    assert.ok(typeof w === 'string' && w.startsWith('가나다라'), String(w).slice(0, 40))
    if (kind === 'local') assert.ok(w.length <= 200_000, `PC 는 20만 자까지(${w.length})`)
    assert.match((await d().look()).text, /가나다라마바사아자차/)
    if (kind === 'local') { assert.equal(rd.lost, false, '링크가 그대로'); await rd.healthy() }
  })

  test(`${kind}: 새 탭으로 여는 다운로드 링크 — 파일이 오고, 일은 그 페이지에 남는다`, { skip }, async () => {
    await d().navigate(`${site.url}/downloads`)
    const n0 = seen[kind].downloads.length
    await d().click(el(await d().look(), '새 탭으로 받기'))
    assert.ok(await until(() => seen[kind].downloads.length > n0, 10_000), '받은 파일')
    assert.deepEqual(seen[kind].downloads.at(-1), { name: 'report.txt', data: REPORT })
    assert.ok(await until(() => d().url().endsWith('/downloads'), 5000), d().url())
    await d().closeOtherTabs()
  })

  test(`${kind}: 하나뿐인 창이 스스로 닫혀도 PC 가 꺼진 것이 아니다 — 다음 일은 새 탭에서`, { skip }, async () => {
    await d().navigate(`${site.url}/selfclose`)
    await d().click(el(await d().look(), '이 창 닫기'))
    await new Promise((r) => setTimeout(r, 600))
    await d().healthy()
    const r = await d().navigate(`${site.url}/shop`)
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(d().lost ?? false, false)
    assert.equal(await d().title(), '가상 상점')
  })

  test(`${kind}: 「떠날까요?」를 거는 페이지(beforeunload)도 다음 주소로 간다 — 아무도 답할 사람이 없다`, { skip }, async () => {
    await d().navigate(`${site.url}/unload`)
    await d().fill(el(await d().look(), '메모'), '적어 둔 말')
    const r = await d().navigate(`${site.url}/shop`)
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.ok(await until(() => d().url().endsWith('/shop'), 5000), d().url())
    assert.equal(await d().title(), '가상 상점')
  })

  test(`${kind}: 페이지가 만든 빈 iframe 의 alert · frames[] 의 confirm 도 상자 없이 — 페이지는 그대로 움직이고 말은 다음 읽기에`, { skip }, async () => {
    await d().navigate(`${site.url}/framedialog`)
    const t0 = Date.now()
    await d().click(el(await d().look(), '안쪽 알림'))
    let snap = await d().look()
    assert.match(snap.text, /알림 뒤/, '알림이 페이지를 붙잡지 않았다')
    assert.match(snap.text, /\[dialog\] alert: 안쪽 알림/)
    await d().click(el(snap, '프레임 확인'))
    snap = await d().look()
    assert.match(snap.text, /확인 안 함/, 'confirm 은 「취소」')
    assert.match(snap.text, /\[dialog\] confirm: 안쪽 확인/)
    assert.ok(Date.now() - t0 < 8000, `${Date.now() - t0}ms`)
  })
}

// ---- only on the PC ----
const local = { skip: !haveElectron() && 'desktop/ 에 Electron 이 없다(npm ci)' }

test('local: 「떠날까요?」를 거는 페이지에 보관함 값을 넣고 작업이 끝나도(idle) 페이지는 비워진다', local, async () => {
  await rd.navigate(`${site.url}/unload`)
  await rd.fillSecret(el(await rd.look(), '메모'), PASSWORD)
  await rd.idle()
  assert.ok(await until(() => rd.url() === 'about:blank', 3000), `비운 페이지: ${rd.url()}`)
  await rd.begin()
})

test('local: 사람이 없는 작업(noPrivate)이 쥔 동안 이 PC 의 내부망으로 가는 요청은 무엇이든 막힌다 — fetch · 그림 · 폼 · 새 창 · 127.0.0.1 로 풀리는 공개 이름', local, async () => {
  const lookup = await import('node:dns').then((m) => m.promises.lookup('localtest.me').catch(() => null))
  await rd.navigate(`${site.url}/net`) // (opened before: a person's task)
  await rd.begin({ noPrivate: true })
  const n0 = site.probes.length
  try {
    let snap = await rd.look()
    for (const b of ['가져오기', '그림', '새 창', '이름으로']) { await rd.click(el(snap, b)); snap = await rd.look() }
    await rd.click(el(snap, '폼 보내기'))
    await new Promise((r) => setTimeout(r, 1500))
    assert.deepEqual(site.probes.slice(n0), [], '이 PC 의 내부망에 닿은 요청이 없다')
    assert.ok(rd.url().endsWith('/net'), rd.url())
    // by a public name that resolves to 127.0.0.1 here — the address itself (the desktop resolves it with this PC's resolver)
    if (lookup) {
      for (const host of ['localtest.me', '127.0.0.1.nip.io']) {
        const r = await rd.navigate(`http://${host}:${site.port}/shop`)
        assert.equal(r.ok, false, host)
        assert.match(r.error, /own network/, host)
      }
    }
    for (const u of [`http://[::ffff:127.0.0.1]:${site.port}/shop`, `http://localhost.:${site.port}/shop`]) {
      const r = await rd.navigate(u)
      assert.equal(r.ok, false, u)
    }
  } finally { await rd.begin() }
  // a person's task again: the same requests go
  await rd.navigate(`${site.url}/net`)
  await rd.click(el(await rd.look(), '가져오기'))
  assert.ok(await until(() => site.probes.slice(n0).includes('fetch'), 3000), site.probes.slice(n0).join(','))
})

test('local: 작업 사이에 이 PC 에 보이는 창에서 사람이 받는 파일은 그 PC 의 다운로드 폴더로 — 서버로는 가지 않는다', local, async () => {
  await rd.navigate(`${site.url}/download`)
  await rd.idle({ keep: true })
  assert.ok(rd.url().endsWith('/download'), `keep: 페이지가 남는다 — ${rd.url()}`)
  const n0 = seen.local.downloads.length
  await rd.show(true)
  try {
    await rd.click(el(await rd.look(), '보고서 받기'))
    assert.ok(await until(() => fs.existsSync(path.join(downloads, 'report.txt')), 5000), fs.readdirSync(downloads).join(','))
    assert.equal(fs.readFileSync(path.join(downloads, 'report.txt'), 'utf8'), REPORT)
    await rd.click(el(await rd.look(), '보고서 받기'))
    assert.ok(await until(() => fs.existsSync(path.join(downloads, 'report (2).txt')), 5000), '같은 이름은 (2)')
    await new Promise((r) => setTimeout(r, 500))
    assert.equal(seen.local.downloads.length, n0, '서버로는 가지 않는다')
  } finally { await rd.show(false) }
  await rd.begin()
})

test('local: 탭이 없을 때 곁에서 도는 동작(멈추기 · 직접 제어 · 실시간 한 장)이 한꺼번에 와도 새 탭은 하나', local, async () => {
  await rd.navigate(`${site.url}/selfclose`)
  await rd.click(el(await rd.look(), '이 창 닫기'))
  await new Promise((r) => setTimeout(r, 600))
  await Promise.all([rd.stop(), rd.frameShot(), rd.input({ type: 'scroll', dy: 10 }).catch(() => {}), rd.look(), rd.stop()])
  await rd.look()
  assert.equal(rd.cur.tabs, 1, `탭 ${rd.cur.tabs}`)
  assert.equal((await rd.navigate(`${site.url}/shop`)).ok, true)
})

test('local: 크기를 말하지 않는 큰 파일은 받는 도중 끝을 넘으면 멈추고 「너무 크다」(413)로 온다', local, async () => {
  await rd.navigate(`${site.url}/downloads`)
  const n0 = seen.local.downloads.length
  await rd.click(el(await rd.look(), '큰 파일'))
  assert.ok(await until(() => seen.local.downloads.length > n0, 15_000), '알림이 온다')
  const got = seen.local.downloads[n0]
  assert.equal(got.name, 'big.bin')
  assert.equal(got.status, 413, JSON.stringify(got))
  assert.equal(got.data, undefined)
})

test('local: 작업이 끝나면(idle) 페이지를 비우고 프레임 · 받은 파일을 보내지 않는다 — 다음 작업(begin)부터 다시', local, async () => {
  await rd.navigate(`${site.url}/download`)
  await rd.idle()
  assert.ok(await until(() => rd.url() === 'about:blank' || rd.url() === '', 3000), `비운 페이지: ${rd.url()}`)
  await new Promise((r) => setTimeout(r, 400))
  const f0 = seen.local.frames, n0 = seen.local.downloads.length
  // (between tasks the browser still answers — a page clicked into now downloads nothing to the server)
  await rd.navigate(`${site.url}/download`)
  await rd.click(el(await rd.look(), '보고서 받기'))
  await new Promise((r) => setTimeout(r, 1500))
  assert.equal(seen.local.downloads.length, n0, '작업 밖에서 받은 파일은 서버로 오지 않는다')
  assert.equal(seen.local.frames, f0, '작업 밖에서는 프레임이 없다')
  await rd.begin()
  await rd.navigate(`${site.url}/shop`)
  await rd.click(el(await rd.look(), '세기'))
  assert.ok(await until(() => seen.local.frames > f0, 5000), '다시 프레임')
})

test('local: 사람이 없는 작업(begin noPrivate)은 이 PC 의 내부망 주소를 열지 않는다', local, async () => {
  await rd.navigate(`${site.url}/tabs`)
  await rd.begin({ noPrivate: true })
  try {
    const r = await rd.navigate(`${site.url}/shop`) // (127.0.0.1)
    assert.equal(r.ok, false)
    assert.match(r.error, /own network/)
    assert.ok(rd.url().endsWith('/tabs'), `그 자리에 있다: ${rd.url()}`)
    // a link on the page that opens such an address in a new tab is refused too (the PC's own check, not only the server's)
    const snap = await rd.look()
    const tabs = rd.cur.tabs
    await rd.click(el(snap, '새 탭으로 긴 페이지'))
    await new Promise((r) => setTimeout(r, 800))
    await rd.look()
    assert.ok(rd.url().endsWith('/tabs'), rd.url())
    assert.equal(rd.cur.tabs, tabs, '새 탭이 열리지 않았다')
  } finally { await rd.begin() }
  assert.equal((await rd.navigate(`${site.url}/shop`)).ok, true, '사람이 시킨 작업은 연다')
})

test('local: 이 PC 의 클립보드는 붙여 넣지 않는다(⌘V · Ctrl+V) — 보는 사람의 글은 글로 친다', local, async () => {
  await rd.navigate(`${site.url}/shop`)
  const snap = await rd.look()
  await assert.rejects(rd.input({ type: 'key', key: 'ControlOrMeta+v' }), /pasting/)
  await assert.rejects(rd.press(snap.els.find((x) => x.name === 'q').i, 'Control+V'), /pasting/)
  await assert.rejects(rd.press(snap.els.find((x) => x.name === 'q').i, 'Meta+v'), /pasting/)
  await rd.fill(snap.els.find((x) => x.name === 'q').i, '보낸 글', { enter: true })
  assert.match((await rd.look()).text, /찾은 것: 보낸 글/)
})

test('local: 창을 잇달아 여는 페이지 — 한 번에 탭은 8개까지', local, async () => {
  await rd.navigate(`${site.url}/popups`)
  await rd.click(el(await rd.look(), '창 열두 개'))
  await new Promise((r) => setTimeout(r, 2500))
  await rd.look()
  assert.ok(rd.cur.tabs >= 2 && rd.cur.tabs <= 8, `탭 ${rd.cur.tabs}`)
  await rd.closeOtherTabs()
  await rd.healthy()
})

test('local: 페이지가 그리지 못하는 동안 모델의 그림은 없다 — 가리기 전의 그림으로 대신하지 않는다', local, async () => {
  const t0 = Date.now()
  await rd.navigate(`${site.url}/busy`)
  const snap = await rd.look()
  const b = await rd.box(snap.els.find((x) => x.type === 'password').i)
  await rd.fillSecret(snap.els.find((x) => x.type === 'password').i, PASSWORD)
  // (the page's script holds it from 1.5 s on, for 9 s)
  await new Promise((r) => setTimeout(r, Math.max(0, 1900 - (Date.now() - t0))))
  const shot = await rd.shot()
  if (shot) assert.ok(brightness(shot, b.x, b.y).avg < 60, '그림이 오면 비밀번호 칸이 칠해져 있다')
  else assert.equal(shot, null)
  // (let the page go before the next test)
  await new Promise((r) => setTimeout(r, Math.max(0, 11_500 - (Date.now() - t0))))
  await rd.healthy()
})

test('local: 웹 주소만 연다 — 이 PC 의 파일은 열지 않는다', { skip: !haveElectron() }, async () => {
  const r = await rd.navigate('file:///etc/hosts')
  assert.equal(r.ok, false)
  assert.match(r.error, /web addresses/)
  assert.notEqual(rd.url(), 'file:///etc/hosts')
})
