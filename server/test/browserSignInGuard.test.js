// This server's browser (lib/browserServer.js, a real Chromium) does not open the sign-in steps of the auth server this app signs people
// in with (lib/signInSteps.js): typed, linked, on a redirect from another site, in a new tab — while other sites, this app's own pages
// (its Google connection included) and the HTTP cache work as before. Made-up servers on this machine only:
//   auth.localhost   the auth server (PRO_SUPABASE_URL): /auth/v1/authorize → (Google, a moment) → /auth/v1/callback → Lite's address
//                    #access_token=…
//   lite.localhost   this app (PRO_PUBLIC_URL), which passes /auth/v1/* on (/lite/auth/v1/… too)
//   127.0.0.1        another site: links, a redirect, a popup, pictures and scripts that may be cached — and /google, standing in for
//                    Google's consent that sends a signed-in browser straight back (after a moment, as over the network)
//   node --test test/browserSignInGuard.test.js   (no database)
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import http from 'node:http'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pgl-signin-guard-'))
process.env.PRO_BROWSER_PROFILES = tmp
const { config } = await import('../config.js')
const { ServerDriver } = await import('../lib/browserServer.js')

const hits = new Map() // "<server> <path>" → count
const hit = (who, p) => hits.set(`${who} ${p}`, (hits.get(`${who} ${p}`) || 0) + 1)
const count = (who, p) => hits.get(`${who} ${p}`) || 0
const serve = (who, routes) => {
  const s = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    hit(who, u.pathname)
    const r = routes(u, req)
    if (r.location) { setTimeout(() => { res.writeHead(302, { Location: r.location }); res.end() }, r.delayMs || 0); return }
    res.writeHead(r.status || 200, { 'Content-Type': r.type || 'text/html; charset=utf-8', 'Cache-Control': r.cache || 'no-store' })
    res.end(r.body || '')
  })
  return new Promise((ok) => s.listen(0, '127.0.0.1', () => ok(s)))
}
const page = (title, body = '') => ({ body: `<!doctype html><title>${title}</title><body>${body}</body>` })
let auth, lite, site, A, Lt, S, d
const saved = { supabaseUrl: config.supabaseUrl, supabasePublicUrl: config.supabasePublicUrl, publicUrl: config.publicUrl, tenantHosts: config.tenantHosts, tenantFromHeader: config.tenantFromHeader }

before(async () => {
  auth = await serve('auth', (u) => {
    if (u.pathname === '/auth/v1/authorize') return { location: `${S}/google?back=${encodeURIComponent(`${A}/auth/v1/callback?code=c-${Date.now()}`)}` }
    if (u.pathname === '/auth/v1/callback') return { location: `${Lt}/lite/api/config#access_token=SECRET-ACCESS&refresh_token=SECRET-REFRESH&token_type=bearer` }
    if (u.pathname.toLowerCase().includes('verify')) return page('verified')
    return page('auth server root')
  })
  lite = await serve('lite', (u) => {
    if (u.pathname === '/lite/api/config') return { type: 'application/json', body: '{"demoLogin":false}' }
    if (u.pathname === '/lite/api/auth/google/callback') return page('Google 연결됨', '<p>연결했어요</p>')
    if (u.pathname.startsWith('/lite/auth/v1/')) return { location: `${A}/auth/v1/callback?code=via-lite` }
    if (u.pathname === '/lite/asset.js') return { type: 'text/javascript', cache: 'public, max-age=3600', body: 'window.__asset = 1' }
    return page('Lite', '<script src="/lite/asset.js"></script>')
  })
  site = await serve('site', (u) => {
    if (u.pathname === '/google') return { location: u.searchParams.get('back'), delayMs: 300 }
    if (u.pathname === '/go') return { location: `${A}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(`${Lt}/lite/api/config`)}` }
    if (u.pathname === '/link') return page('링크', `<a id="sign" href="${A}/auth/v1/authorize?provider=google">Google 로 로그인</a>`)
    if (u.pathname === '/popup') return page('새 창', `<button id="open" onclick="window.open('${A}/auth/v1/authorize?provider=google')">새 창으로 로그인</button>`)
    if (u.pathname === '/blank') return page('새 탭', `<a id="tab" target="_blank" href="${A}/auth/v1/authorize?provider=google">새 탭으로 로그인</a>`)
    if (u.pathname === '/frame') return page('프레임', `<iframe src="${A}/auth/v1/authorize?provider=google" width="400" height="300"></iframe>`)
    if (u.pathname === '/app.js') return { type: 'text/javascript', cache: 'public, max-age=3600', body: 'window.__app = 1' }
    if (u.pathname === '/logo.png') return { type: 'image/svg+xml', cache: 'public, max-age=3600', body: '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>' }
    if (u.pathname === '/a' || u.pathname === '/b') return page(`page ${u.pathname}`, '<script src="/app.js"></script><img src="/logo.png">')
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

// what reached the sign-in steps and the page with the tokens since mark()
const mark = () => ({ authorize: count('auth', '/auth/v1/authorize'), callback: count('auth', '/auth/v1/callback'), tokens: count('lite', '/lite/api/config') })
const since = (m) => { const n = mark(); return { authorize: n.authorize - m.authorize, callback: n.callback - m.callback, tokens: n.tokens - m.tokens } }
const noSignIn = (why, m) => assert.deepEqual(since(m), { authorize: 0, callback: 0, tokens: 0 }, `${why}: a sign-in step or the page with the tokens was reached`)
// a new tab's own first load may leave before the tab can be guarded: the sign-in never comes back (no callback, no tokens)
const neverBack = (why, m) => { const d = since(m); assert.deepEqual([d.callback, d.tokens], [0, 0], `${why}: ${JSON.stringify(d)}`); return d.authorize }

test('BT-E-01 로그인 서버의 authorize 주소로 가면 막힌다 — 요청이 나가지 않고, 다음 보기가 그 사실을 말한다', async () => {
  const m = mark()
  const r = await d.navigate(`${A}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(`${Lt}/lite/api/config`)}`)
  assert.equal(r.ok, false)
  assert.match(r.error, /^refused: this browser does not open the sign-in pages/)
  noSignIn('typed', m)
  const snap = await d.look()
  assert.match(snap.text, new RegExp(`\\[not opened\\] auth\\.localhost:${auth.address().port}/auth/v1/authorize — a sign-in step`))
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

test('BT-E-04 링크를 눌러도 · 프레임 안에서도 막히고, 새 창(window.open) · 새 탭 링크로 가면 그 탭이 닫혀 토큰 페이지에 닿지 않는다', async () => {
  await d.navigate(`${S}/link`)
  let m = mark()
  const link = (await d.look()).els.find((e) => e.text === 'Google 로 로그인')
  await d.click(link.i).catch(() => {})
  await new Promise((r) => setTimeout(r, 800))
  noSignIn('a link', m)
  m = mark()
  await d.navigate(`${S}/frame`)
  await new Promise((r) => setTimeout(r, 800))
  noSignIn('a frame', m)
  // a new tab: a page's own window.open, and a link that opens a tab of its own (noopener). Its first load can be on its way before the
  // tab can be guarded (window.open: usually not) — the tab closes then, before the sign-in's next hop (after the other site's answer,
  // here Google's); the work stays where it was and the next look says why
  for (const [path, text] of [['/popup', '새 창으로 로그인'], ['/blank', '새 탭으로 로그인']]) {
    await d.navigate(`${S}${path}`)
    m = mark()
    await d.click((await d.look()).els.find((e) => e.text === text).i).catch(() => {})
    await new Promise((r) => setTimeout(r, 1500))
    const first = neverBack(text, m)
    console.log(`[BT-E-04] ${text}: the new tab's first load reached authorize ${first}× (then closed)`)
    assert.equal(d.ctx.pages().length, 1, `${text}: the new tab is gone`)
    assert.match((await d.look()).text, /\[not opened\] auth\.localhost:\d+\/auth\/v1\/authorize/, `${text}: the next look says why`)
  }
})

test('BT-E-05 보통 사이트 · 이 앱의 화면 · 이 앱 자신의 Google 연결 주소 · 로그인 서버의 다른 주소는 그대로 열린다', async () => {
  for (const [u, title] of [[`${S}/`, 'site'], [`${Lt}/lite/chat`, 'Lite'], [`${Lt}/lite/api/auth/google/callback?code=x&state=y`, 'Google 연결됨'], [`${A}/`, 'auth server root']]) {
    const r = await d.navigate(u)
    assert.equal(r.ok, true, `${u}: ${r.error}`)
    assert.equal(await d.title(), title, u)
  }
})

test('BT-E-06 캐시는 그대로: 보통 사이트와 이 앱의 페이지 모두 스크립트 · 그림을 다시 받지 않는다', async () => {
  for (const u of [`${S}/a`, `${S}/b`, `${S}/a`]) assert.equal((await d.navigate(u)).ok, true)
  assert.equal(count('site', '/app.js'), 1, 'script fetched once')
  assert.equal(count('site', '/logo.png'), 1, 'picture fetched once')
  // this app's host is one whose page loads are looked at: what the pages load is not
  for (const u of [`${Lt}/lite/x`, `${Lt}/lite/y`, `${Lt}/lite/x`]) assert.equal((await d.navigate(u)).ok, true)
  assert.equal(count('lite', '/lite/asset.js'), 1, 'script on this app\'s host fetched once')
})

test('BT-E-07 Playwright route 가 함께 있어도(시험 · 다른 기능) 막힘은 그대로, 보통 사이트는 열린다', async () => {
  const routed = []
  await d.ctx.route('**/*', (r) => { routed.push(r.request().url()); return r.continue() })
  try {
    const m = mark()
    const r = await d.navigate(`${S}/go`)
    assert.equal(r.ok, false)
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
