// This server's browser (lib/browserServer.js, a real Chromium) never signs in to this app (lib/signInSteps.js): the auth server's
// sign-in steps, Lite's sign-in API and the sign-in screens are refused before they are sent — typed, linked, on a redirect from
// another site, in a new tab or a popup, in a frame of another site (in a process of its own), by a page's own fetch — while other
// sites, this app's other pages (its Google connection included) and the HTTP cache work as before. Made-up servers on this machine:
//   auth.localhost   the auth server (PRO_SUPABASE_URL): /auth/v1/authorize → (Google, a moment) → /auth/v1/callback → Lite's address
//                    #access_token=… ; /auth/v1/token · signup · otp answer a session
//   lite.localhost   this app (PRO_PUBLIC_URL …/lite): Lite under /lite (its sign-in API, /login, /auth/done, the Google connection's
//                    callback → done), ProcessGPT's screens at the root (/auth/login …); passes /auth/v1/* on
//   127.0.0.1        another site: links, a redirect, a popup, a frame, pictures and scripts that may be cached — and /google, standing
//                    in for Google's consent that sends a signed-in browser straight back (after GOOGLE_MS, as over the network)
//   node --test test/browserSignInGuard.test.js   (no database)
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import http from 'node:http'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pgl-signin-guard-'))
process.env.PRO_BROWSER_PROFILES = tmp
// (the made-up sites run on this machine: the server's browser may open them — but BT-E-12, which shows it does not by default)
const LOCAL = '127.0.0.1,localhost,auth.localhost,lite.localhost,other.localhost'
process.env.PRO_BROWSER_PRIVATE_ALLOW = LOCAL
const { config } = await import('../config.js')
const { ServerDriver, LAUNCH_ARGS } = await import('../lib/browserServer.js')
const { browserPidFor } = await import('../lib/browserSteps.js')

const GOOGLE_MS = 20
const hits = new Map() // "<server> <path>" → count
const hit = (who, p) => hits.set(`${who} ${p}`, (hits.get(`${who} ${p}`) || 0) + 1)
const count = (who, p) => hits.get(`${who} ${p}`) || 0
const serve = (who, routes, host = '127.0.0.1') => {
  const s = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    hit(who, u.pathname)
    const r = routes(u, req)
    if (r.location) { setTimeout(() => { res.writeHead(302, { Location: r.location }); res.end() }, r.delayMs || 0); return }
    res.writeHead(r.status || 200, { 'Content-Type': r.type || 'text/html; charset=utf-8', 'Cache-Control': r.cache || 'no-store', 'Access-Control-Allow-Origin': '*' })
    res.end(r.body || '')
  })
  return new Promise((ok) => s.listen(0, host, () => ok(s)))
}
const page = (title, body = '') => ({ body: `<!doctype html><title>${title}</title><body>${body}</body>` })
const session = { type: 'application/json', body: '{"access_token":"SECRET-ACCESS","refresh_token":"SECRET-REFRESH"}' }
let auth, lite, site, A, Lt, S, d
const saved = { supabaseUrl: config.supabaseUrl, supabasePublicUrl: config.supabasePublicUrl, publicUrl: config.publicUrl, tenantHosts: config.tenantHosts, tenantFromHeader: config.tenantFromHeader }
// a page whose button sends one request with the page's own fetch, and says on the page how it went
const fetchPage = (title, url) => page(title, `<button onclick="fetch('${url}', { method: 'POST', body: '{}' }).then((r) => { document.body.dataset.r = 'sent ' + r.status }, () => { document.body.dataset.r = 'failed' })">보내기</button>`)

before(async () => {
  auth = await serve('auth', (u) => {
    if (u.pathname === '/auth/v1/authorize') return { location: `${S}/google?back=${encodeURIComponent(`${A}/auth/v1/callback?code=c-${Date.now()}&state=s`)}` }
    if (u.pathname === '/auth/v1/callback') return { location: `${Lt}/lite/api/config#access_token=SECRET-ACCESS&refresh_token=SECRET-REFRESH&token_type=bearer` }
    if (['/auth/v1/token', '/auth/v1/signup', '/auth/v1/otp'].includes(u.pathname)) return session
    if (u.pathname.toLowerCase().includes('verify')) return page('verified')
    return page('auth server root')
  })
  lite = await serve('lite', (u) => {
    if (u.pathname === '/lite/api/config') return { type: 'application/json', body: '{"demoLogin":false}' }
    // this app's Google connection in its own browser (mode 'browser'): callback → done
    if (u.pathname === '/lite/api/auth/google/callback') return { location: `${Lt}/lite/api/auth/google/done` }
    if (u.pathname === '/lite/api/auth/google/done') return page('Google 연결됨', '<p>연결했어요</p>')
    if (u.pathname === '/lite/api/auth/google/start') return { location: `${S}/google?back=${encodeURIComponent(`${Lt}/lite/auth/done#SECRET-SESSION`)}` }
    if (u.pathname.startsWith('/lite/api/auth/')) return session
    if (u.pathname.startsWith('/lite/auth/v1/')) return { location: `${A}/auth/v1/callback?code=via-lite&state=s` }
    if (u.pathname === '/lite/asset.js') return { type: 'text/javascript', cache: 'public, max-age=3600', body: 'window.__asset = 1' }
    // the Lite app's screen that shows the sign-in (the app's router puts it on any address when nobody is signed in)
    if (u.pathname === '/lite/chat') {
      return page('Lite', `<script src="/lite/asset.js"></script>
        <button onclick="fetch('/lite/api/auth/email/start', { method: 'POST' }).then(() => { document.body.dataset.start = 'sent' }, () => { document.body.dataset.start = 'failed' })">코드 받기</button>
        <button onclick="fetch('/lite/api/auth/email/verify', { method: 'POST' }).then(() => { document.body.dataset.verify = 'sent' }, () => { document.body.dataset.verify = 'failed' })">코드 확인</button>
        <button onclick="location.href = '/lite/api/auth/google/start?n=${'ab'.repeat(24)}'">Google로 계속하기</button>`)
    }
    // ProcessGPT's own screen at the root: its password sign-in posts to the auth server
    if (u.pathname === '/') return fetchPage('ProcessGPT', `${A}/auth/v1/token?grant_type=password`)
    return page('Lite', '<script src="/lite/asset.js"></script>')
  })
  site = await serve('site', (u) => {
    if (u.pathname === '/google') return { location: u.searchParams.get('back'), delayMs: GOOGLE_MS }
    if (u.pathname === '/go') return { location: `${A}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(`${Lt}/lite/api/config`)}` }
    if (u.pathname === '/link') return page('링크', `<a id="sign" href="${A}/auth/v1/authorize?provider=google">Google 로 로그인</a>`)
    if (u.pathname === '/popup') return page('새 창', `<button id="open" onclick="window.open('${A}/auth/v1/authorize?provider=google')">새 창으로 로그인</button>`)
    if (u.pathname === '/blank') return page('새 탭', `<a id="tab" target="_blank" href="${A}/auth/v1/authorize?provider=google">새 탭으로 로그인</a>`)
    if (u.pathname === '/frame') return page('프레임', `<iframe src="${A}/auth/v1/authorize?provider=google" width="400" height="300"></iframe>`)
    // a frame of another site that goes to the sign-in itself (a moment after it loads), and one sent there by its own redirect
    if (u.pathname === '/frames') return page('프레임들', `<iframe src="http://other.localhost:${site.address().port}/inner" width="400" height="300"></iframe><iframe src="http://other.localhost:${site.address().port}/go" width="400" height="300"></iframe>`)
    if (u.pathname === '/inner') return page('inner', `<script>setTimeout(() => { location.href = '${A}/auth/v1/authorize?provider=google' }, 100)</script>안쪽`)
    if (u.pathname === '/app.js') return { type: 'text/javascript', cache: 'public, max-age=3600', body: 'window.__app = 1' }
    if (u.pathname === '/logo.png') return { type: 'image/svg+xml', cache: 'public, max-age=3600', body: '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>' }
    if (u.pathname === '/a' || u.pathname === '/b') return page(`page ${u.pathname}`, '<script src="/app.js"></script><img src="/logo.png">')
    if (u.pathname === '/xhr') return fetchPage('다른 사이트', `${A}/auth/v1/token?grant_type=password`)
    return page('site')
  })
  A = `http://auth.localhost:${auth.address().port}`
  Lt = `http://lite.localhost:${lite.address().port}`
  S = `http://127.0.0.1:${site.address().port}`
  Object.assign(config, { supabaseUrl: A, supabasePublicUrl: '', publicUrl: `${Lt}/lite`, tenantHosts: '', tenantFromHeader: false })
  d = await ServerDriver.open('sign-in-guard-test', {})
})
after(async () => {
  await d?.close()
  for (const s of [auth, lite, site]) s?.close()
  Object.assign(config, saved)
  fs.rmSync(tmp, { recursive: true, force: true })
})

// what reached the sign-in (the auth server's steps, Lite's sign-in API and screens) and the page with the tokens since mark()
const SIGN_IN = [['auth', '/auth/v1/authorize'], ['auth', '/auth/v1/callback'], ['auth', '/auth/v1/token'], ['auth', '/auth/v1/signup'], ['auth', '/auth/v1/otp'],
  ['lite', '/lite/api/auth/email/start'], ['lite', '/lite/api/auth/email/verify'], ['lite', '/lite/api/auth/google/start'], ['lite', '/lite/login'], ['lite', '/lite/auth/done'],
  ['lite', '/auth/login'], ['lite', '/auth/register'], ['lite', '/auth/forgot-password'], ['lite', '/lite/api/config']]
const mark = () => Object.fromEntries(SIGN_IN.map(([w, p]) => [`${w} ${p}`, count(w, p)]))
const noSignIn = (why, m) => {
  const now = mark()
  const reached = Object.keys(now).filter((k) => now[k] > m[k])
  assert.deepEqual(reached, [], `${why}: reached ${reached.join(', ')}`)
}
const click = async (text) => d.click((await d.look()).els.find((e) => e.text === text).i).catch(() => {})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test('BT-E-01 로그인 서버의 authorize 주소로 가면 막힌다 — 요청이 나가지 않고, 다음 보기가 그 사실을 말한다', async () => {
  const m = mark()
  const r = await d.navigate(`${A}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(`${Lt}/lite/api/config`)}`)
  assert.equal(r.ok, false)
  assert.match(r.error, /^refused: this browser does not sign in to this app/)
  noSignIn('typed', m)
  const snap = await d.look()
  assert.match(snap.text, new RegExp(`\\[not opened\\] auth\\.localhost:${auth.address().port}/auth/v1/authorize — a way into this app's own sign-in`))
  assert.doesNotMatch(snap.text, /redirect_to|provider=google/, 'the query is not repeated')
  assert.equal((await d.look()).text.includes('[not opened]'), false, 'said once')
})

test('BT-E-02 다른 사이트에서 302 로 그 주소로 가도 막힌다', async () => {
  const m = mark()
  const r = await d.navigate(`${S}/go`)
  assert.equal(count('site', '/go'), 1)
  assert.equal(r.ok, false)
  assert.match(r.error, /^refused:/)
  noSignIn('a redirect', m)
})

test('BT-E-03 callback · verify, 이 앱이 넘겨주는 /lite/auth/v1/…, 대소문자 · %-인코딩도 막힌다', async () => {
  const m = mark()
  for (const u of [`${A}/auth/v1/callback?code=x&state=y`, `${A}/auth/v1/verify?token=t&type=magiclink`, `${Lt}/lite/auth/v1/authorize?provider=google`,
    `${A}/AUTH/V1/AUTHORIZE?provider=google`, `${A}/auth/v1/%61uthorize?provider=google`]) {
    const r = await d.navigate(u)
    assert.equal(r.ok, false, u)
  }
  noSignIn('variants', m)
  assert.equal(count('auth', '/auth/v1/verify'), 0)
  assert.equal([...hits.keys()].filter((k) => /^lite \/lite\/auth\//.test(k)).length, 0, 'Lite\'s /auth/v1 path is not reached either')
  assert.equal([...hits.keys()].filter((k) => /^auth \/(AUTH|auth\/v1\/%61)/.test(k)).length, 0)
})

test('BT-E-04 링크 · 프레임 · 새 창(window.open) · 새 탭 링크(noopener)도 첫 요청부터 막힌다', async () => {
  for (const [path, text] of [['/link', 'Google 로 로그인'], ['/frame', null], ['/popup', '새 창으로 로그인'], ['/blank', '새 탭으로 로그인']]) {
    await d.navigate(`${S}${path}`)
    const m = mark()
    if (text) await click(text)
    await sleep(800)
    noSignIn(path, m)
    assert.match((await d.look()).text, /\[not opened\] auth\.localhost:\d+\/auth\/v1\/authorize/, `${path}: the next look says why`)
    await d.closeOtherTabs()
  }
})

test('BT-E-05 보통 사이트 · 이 앱의 화면 · 이 앱 자신의 Google 연결(콜백 → 끝 화면) · 로그인 서버의 다른 주소는 그대로 열린다', async () => {
  for (const [u, title] of [[`${S}/`, 'site'], [`${Lt}/lite/chat`, 'Lite'], [`${Lt}/lite/api/auth/google/callback?code=x&state=y`, 'Google 연결됨'], [`${A}/`, 'auth server root']]) {
    const r = await d.navigate(u)
    assert.equal(r.ok, true, `${u}: ${r.error}`)
    assert.equal(await d.title(), title, u)
  }
  assert.equal(count('lite', '/lite/api/auth/google/done'), 1, 'the connection ends on its own page')
})

test('BT-E-06 캐시는 그대로: 보통 사이트와 이 앱의 페이지 모두 스크립트 · 그림을 다시 받지 않는다', async () => {
  for (const u of [`${S}/a`, `${S}/b`, `${S}/a`]) assert.equal((await d.navigate(u)).ok, true)
  assert.equal(count('site', '/app.js'), 1, 'script fetched once')
  assert.equal(count('site', '/logo.png'), 1, 'picture fetched once')
  // this app's host is one whose page loads are looked at: what the pages load is not
  for (const u of [`${Lt}/lite/x`, `${Lt}/lite/y`, `${Lt}/lite/x`]) assert.equal((await d.navigate(u)).ok, true)
  assert.equal(count('lite', '/lite/asset.js'), 1, 'script on this app\'s host fetched once')
})

test('BT-E-08 이 앱에 로그인하지 않는다: Lite 의 로그인 화면 · 완료 화면 · 코드 받기/확인 · Google로 계속하기, ProcessGPT 의 로그인 화면 · 비밀번호 로그인', async () => {
  let m = mark()
  for (const u of [`${Lt}/lite/login`, `${Lt}/lite/auth/done?n=${'ab'.repeat(24)}#SECRET`, `${Lt}/lite/api/auth/google/start?n=x`, `${Lt}/auth/login`, `${Lt}/auth/register`, `${Lt}/auth/forgot-password`]) {
    const r = await d.navigate(u)
    assert.equal(r.ok, false, `${u} opened`)
    assert.match(r.error, /^refused:/, u)
  }
  noSignIn('the sign-in screens, as pages', m)
  // the app's screen that shows the sign-in: its requests are refused (the page sees them fail), its Google start is not opened
  assert.equal((await d.navigate(`${Lt}/lite/chat`)).ok, true)
  m = mark()
  await click('코드 받기')
  await click('코드 확인')
  await sleep(300)
  assert.deepEqual(await d.page.evaluate(() => [document.body.dataset.start, document.body.dataset.verify]), ['failed', 'failed'])
  await click('Google로 계속하기')
  await sleep(500)
  noSignIn('Lite\'s sign-in from its screen', m)
  // (each look says what was refused since the one before: the Google start, after the two codes said on the looks that found its button)
  assert.match((await d.look()).text, /\[not opened\] lite\.localhost:\d+\/lite\/api\/auth\/google\/start/)
  // ProcessGPT's password sign-in from its own screen, and the same request from another site's page
  for (const u of [`${Lt}/`, `${S}/xhr`]) {
    assert.equal((await d.navigate(u)).ok, true)
    m = mark()
    await click('보내기')
    await sleep(300)
    assert.equal(await d.page.evaluate(() => document.body.dataset.r), 'failed', u)
    noSignIn(`a password sign-in from ${u}`, m)
  }
})

test('BT-E-07 Playwright route 가 함께 있어도(시험 · 다른 기능) 막힘은 그대로, 보통 사이트는 열린다', async () => {
  const routed = []
  await d.ctx.route('**/*', (r) => { routed.push(r.request().url()); return r.continue() })
  try {
    const m = mark()
    const r = await d.navigate(`${S}/go`)
    assert.equal(r.ok, false)
    await d.navigate(`${S}/blank`)
    await click('새 탭으로 로그인')
    await sleep(500)
    await d.closeOtherTabs()
    noSignIn('with a route', m)
    const a = await d.navigate(`${S}/a`)
    assert.equal(a.ok, true, a.error)
    assert.ok(routed.some((u) => u.endsWith('/a')), 'the route saw the page')
    // (for the record: a route takes every request through this process and Playwright turns the cache off for it)
    const before = count('site', '/app.js')
    await d.navigate(`${S}/b`)
    console.log(`[BT-E-07] with a Playwright route the cached script was fetched again ${count('site', '/app.js') - before}×`)
  } finally { await d.ctx.unrouteAll({ behavior: 'ignoreErrors' }) }
})

test('BT-E-09 새 탭 · 새 창 경쟁: Google 단계가 20 ms 여도 스무 번 모두 첫 요청부터 막힌다', async () => {
  const runs = { '/blank': 0, '/popup': 0 }
  for (let i = 0; i < 20; i++) {
    for (const [path, text] of [['/blank', '새 탭으로 로그인'], ['/popup', '새 창으로 로그인']]) {
      await d.navigate(`${S}${path}`)
      const m = mark()
      await click(text)
      await sleep(150)
      const now = mark()
      if (Object.keys(now).some((k) => now[k] > m[k])) runs[path]++
      await d.closeOtherTabs()
    }
  }
  console.log(`[BT-E-09] runs that reached the sign-in: ${JSON.stringify(runs)} of 20 each`)
  assert.deepEqual(runs, { '/blank': 0, '/popup': 0 })
})

test('BT-E-10 다른 사이트의 프레임(--site-per-process: 따로 도는 프로세스)이 로그인으로 가도 막힌다', async () => {
  LAUNCH_ARGS.push('--site-per-process')
  const oop = await ServerDriver.open('sign-in-guard-oopif', {})
  try {
    const m = mark()
    for (let i = 0; i < 3; i++) {
      assert.equal((await oop.navigate(`${S}/frames`)).ok, true)
      await sleep(800)
    }
    assert.ok(count('site', '/inner') >= 3, 'the frames loaded')
    noSignIn('frames of another site', m)
    assert.match((await oop.look()).text, /\[not opened\] auth\.localhost:\d+\/auth\/v1\/authorize/)
  } finally {
    LAUNCH_ARGS.pop()
    await oop.close()
    fs.rmSync(path.join(tmp, 'sign-in-guard-oopif'), { recursive: true, force: true })
  }
})

test('BT-E-11 막음을 켜지 못하면 그 브라우저는 쓰지 않는다(닫고, 띄우기가 실패)', async () => {
  const keep = ServerDriver.prototype.guardSignIn
  ServerDriver.prototype.guardSignIn = async () => { throw new Error('the sign-in guard could not be turned on') }
  const dir = path.join(tmp, 'sign-in-guard-off')
  try {
    await assert.rejects(ServerDriver.open('sign-in-guard-off', {}), /sign-in guard could not be turned on/)
    await sleep(500)
    assert.equal(browserPidFor(dir), 0, 'its Chromium is closed')
  } finally {
    ServerDriver.prototype.guardSignIn = keep
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ---- this server's own network (lib/privateNet.js): a Docker install's app at http://localhost:<port> (public and auth address alike) ----
// The app answers on :: (IPv4 and IPv6); 'other' is another service on this machine (the API server's own port, a database's)
async function dockerLike(allow = '') {
  const app = await serve('app', (u) => {
    if (u.pathname === '/chat') return page('앱', `<button onclick="fetch('http://127.0.0.1:${other.address().port}/api/auth/email/verify', { method: 'POST' }).then(() => { document.body.dataset.r = 'sent' }, () => { document.body.dataset.r = 'failed' })">옆 포트로</button>
      <button onclick="fetch('http://web:${other.address().port}/api/auth/email/verify', { method: 'POST' }).then(() => { document.body.dataset.w = 'sent' }, () => { document.body.dataset.w = 'failed' })">web 으로</button>`)
    return page('앱 화면')
  }, '::')
  const other = await serve('other', () => page('다른 서비스'), '::')
  const keep = { publicUrl: config.publicUrl, supabaseUrl: config.supabaseUrl }
  const P = app.address().port
  Object.assign(config, { publicUrl: `http://localhost:${P}`, supabaseUrl: `http://localhost:${P}` })
  process.env.PRO_BROWSER_PRIVATE_ALLOW = allow
  let dd
  try { dd = await ServerDriver.open(`sign-in-guard-docker-${Date.now()}`, {}) } finally { process.env.PRO_BROWSER_PRIVATE_ALLOW = LOCAL }
  return {
    d: dd, P, O: other.address().port,
    close: async () => { await dd.close(); app.close(); other.close(); Object.assign(config, keep) },
  }
}

test('BT-E-12 이 서버의 망은 열지 않는다(설치형 Docker 처럼): 다른 포트 · 컨테이너 이름 · 클러스터 이름 · 메일함 — 이 앱 주소는 다른 루프백 이름으로도 열되 로그인은 막는다', async () => {
  const x = await dockerLike()
  try {
    const { d: dd, P, O } = x
    const refused = async (u, why) => {
      const r = await dd.navigate(u)
      assert.equal(r.ok, false, `${u} opened`)
      assert.match(r.error, why === 'sign-in' ? /does not sign in to this app/ : /does not open addresses on this server's own network/, u)
    }
    // this app, by its other loopback names: opened; its sign-in refused
    for (const base of [`http://localhost:${P}`, `http://127.0.0.1:${P}`, `http://app.localhost:${P}`, `http://[::1]:${P}`]) {
      const r = await dd.navigate(`${base}/chat`)
      assert.equal(r.ok, true, `${base}: ${r.error}`)
      await refused(`${base}/login`, 'sign-in')
      await refused(`${base}/auth/v1/verify?token=x&type=magiclink`, 'sign-in')
    }
    assert.equal(count('app', '/login'), 0)
    // another port of this machine, the install's containers and the cluster's names, a mailbox
    for (const u of [`http://127.0.0.1:${O}/`, `http://localhost:${O}/`, `http://[::1]:${O}/`, 'http://web/login', 'http://kong:8000/auth/v1/verify?token=x', 'http://mailpit:8025/',
      'http://process-gpt-lite-web/', 'http://process-gpt-lite-web.default.svc.cluster.local/', 'http://169.254.169.254/latest/meta-data']) await refused(u, 'private')
    assert.equal(count('other', '/'), 0, 'the other service was never reached')
    const said = (await dd.look()).text
    assert.match(said, /\[not opened\] mailpit:8025\/ — a mailbox on this server's own network/)
    // a page of this app sending its own requests to another port and to a container's name: they never leave
    assert.equal((await dd.navigate(`http://127.0.0.1:${P}/chat`)).ok, true)
    await dd.click((await dd.look()).els.find((e) => e.text === '옆 포트로').i)
    await dd.click((await dd.look()).els.find((e) => e.text === 'web 으로').i)
    await sleep(500)
    assert.deepEqual(await dd.page.evaluate(() => [document.body.dataset.r, document.body.dataset.w]), ['failed', 'failed'])
    assert.equal(count('other', '/api/auth/email/verify'), 0)
  } finally { await x.close() }
})

test('BT-E-13 회사가 허용한 내부망 주소(PRO_BROWSER_PRIVATE_ALLOW)는 열고, 메일함은 허용해도 열지 않는다', async () => {
  const probe = await serve('probe', () => page('허용됨'), '::')
  const Q = probe.address().port
  const x = await dockerLike(`http://127.0.0.1:${Q},mailpit,http://mailpit:8025`)
  try {
    const r = await x.d.navigate(`http://127.0.0.1:${Q}/`)
    assert.equal(r.ok, true, r.error)
    assert.equal(await x.d.title(), '허용됨')
    assert.equal((await x.d.navigate(`http://localhost:${Q}/`)).ok, false, 'that origin only')
    assert.equal((await x.d.navigate('http://mailpit:8025/')).ok, false, 'a mailbox, allowed or not')
  } finally { await x.close(); probe.close() }
})

test('BT-E-14 다른 사이트가 경로를 바꿔 써서(%-인코딩 · 겹친 /) 보내는 로그인 요청과 ProcessGPT SSO 교환 요청도 멈춰 보고 막는다', async () => {
  const sent = (url) => page('보내기', `<button onclick="fetch('${url}', { method: 'POST', body: '{}' }).then((r) => { document.body.dataset.r = 'sent ' + r.status }, () => { document.body.dataset.r = 'failed' })">보내기</button>`)
  const odd = await serve('odd', (u) => sent(decodeURIComponent(u.searchParams.get('to') || '')))
  try {
    const O = `http://127.0.0.1:${odd.address().port}`
    for (const to of [`${A}/%61uth/v1/token?grant_type=password`, `${A}/auth//v1/token?grant_type=password`, `${Lt}/lite/%61pi/auth/email/verify`, `${Lt}/lite/api//auth/email/verify`,
      `${Lt}/pi-system-backend/auth/sso/exchange?redirect_to=%2Fauth`]) {
      assert.equal((await d.navigate(`${O}/?to=${encodeURIComponent(to)}`)).ok, true)
      const before = [...hits.entries()].filter(([k]) => /^(auth|lite) /.test(k)).reduce((n, [, v]) => n + v, 0)
      await click('보내기')
      await sleep(300)
      assert.equal(await d.page.evaluate(() => document.body.dataset.r), 'failed', to)
      const after = [...hits.entries()].filter(([k]) => /^(auth|lite) /.test(k)).reduce((n, [, v]) => n + v, 0)
      assert.equal(after, before, `${to} reached the server`)
    }
    // ProcessGPT's /auth (where its single sign-on comes back) is not opened as a page
    const r = await d.navigate(`${Lt}/auth?redirect=%2F`)
    assert.equal(r.ok, false)
  } finally { odd.close() }
})
