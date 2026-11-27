// Page addresses shown and kept without sign-in tokens (lib/urlTokens.js — the desktop's copy is the same function), the sign-in steps
// this server's browser does not open (lib/signInSteps.js), and /auth/done taking only the sign-in its own tab started
// (src/signInNonce.js). No network, no database.
//   node --test test/urlTokens.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { maskUrl, maskTitle, withoutMasked } from '../lib/urlTokens.js'
import { signInPlaces, isSignInStep, stepPatterns, onPlaces } from '../lib/signInSteps.js'
import { config } from '../config.js'
import { allowedPrivate, privateRefusal, privatePatterns, hostRules, isMailbox, forgetResolved } from '../lib/privateNet.js'
import { startSignIn, takeSignIn, doneStep, subjectOf, fromSupabase, SIGN_IN_MS } from '../../src/signInNonce.js'

const require = createRequire(import.meta.url)

test('BT-U-01 주소의 토큰 값은 이름으로 가린다 — 쿼리와 fragment 둘 다, 값만', () => {
  assert.equal(maskUrl('https://acme.process-gpt.io/lite/api/config#access_token=eyJhbGciOi.x.y&expires_at=1764&expires_in=3600&refresh_token=r-123&token_type=bearer&type=signup'),
    'https://acme.process-gpt.io/lite/api/config#access_token=…&expires_at=1764&expires_in=3600&refresh_token=…&token_type=bearer&type=signup')
  assert.equal(maskUrl('https://app.example/cb?code=4/0AbC&state=s-1&scope=email'), 'https://app.example/cb?code=…&state=s-1&scope=email')
  assert.equal(maskUrl('https://x.example/a?id_token=1&provider_token=2&provider_refresh_token=3&token=4&sig=5&keep=6'),
    'https://x.example/a?id_token=…&provider_token=…&provider_refresh_token=…&token=…&sig=…&keep=6')
  // code: an OAuth answer's (with its state), or on a host the caller names — a stock code on a portal is not a secret
  assert.equal(maskUrl('https://finance.naver.com/item/main.naver?code=005930'), 'https://finance.naver.com/item/main.naver?code=005930')
  assert.equal(maskUrl('https://app.example/cb#code=c-1&state=s'), 'https://app.example/cb#code=…&state=s')
  assert.equal(maskUrl('https://acme.process-gpt.io/lite/auth/done?code=pkce-1', { authHost: (h) => h.endsWith('process-gpt.io') }), 'https://acme.process-gpt.io/lite/auth/done?code=…')
  // a signed address keeps where it goes and for how long: only the signature's value goes
  assert.equal(maskUrl('https://lite.example/api/team/shares/7/raw?exp=1764&sig=ab12cd'), 'https://lite.example/api/team/shares/7/raw?exp=1764&sig=…')
  // nothing to hide: the address as it is
  assert.equal(maskUrl('https://www.naver.com/search?query=%EC%82%AC%EA%B3%BC&where=nexearch'), 'https://www.naver.com/search?query=%EC%82%AC%EA%B3%BC&where=nexearch')
})

test('BT-U-02 이름은 대소문자 · %-인코딩과 상관없이, 빈 값 · 값 없는 이름은 그대로', () => {
  assert.equal(maskUrl('https://x.example/a?ACCESS_TOKEN=a&Refresh_Token=b&%63ode=c&%73ig=d&STATE=s'), 'https://x.example/a?ACCESS_TOKEN=…&Refresh_Token=…&%63ode=…&%73ig=…&STATE=s')
  assert.equal(maskUrl('https://x.example/a#Access_Token=a&%72efresh_token=b'), 'https://x.example/a#Access_Token=…&%72efresh_token=…')
  assert.equal(maskUrl('https://x.example/a?code=&token&sig=&tokens=1&barcode=2'), 'https://x.example/a?code=&token&sig=&tokens=1&barcode=2')
  // a value that is itself %-encoded, a repeated name
  assert.equal(maskUrl('https://x.example/a?token=a%2Bb%3D%3D&token=second'), 'https://x.example/a?token=…&token=…')
})

test('BT-U-03 세션 JSON 의 fragment · 해시 경로의 쿼리 · 주소 안의 비밀번호, 주소가 아닌 것은 그대로', () => {
  const login = encodeURIComponent(JSON.stringify({ user: { id: 'u1' }, session: { access_token: 'a.b.c', refresh_token: 'r' } }))
  assert.equal(maskUrl(`https://lite.example/auth/done#${login}`), 'https://lite.example/auth/done#…')
  assert.equal(maskUrl('https://spa.example/#/callback?token=t1&next=%2Fhome'), 'https://spa.example/#/callback?token=…&next=%2Fhome')
  assert.equal(maskUrl('https://spa.example/#section-2'), 'https://spa.example/#section-2')
  assert.equal(maskUrl('https://kim:hunter2@intra.example/p?q=1'), 'https://…:…@intra.example/p?q=1')
  assert.equal(maskUrl('https://ghp_secret@git.example/r'), 'https://…@git.example/r', 'a user name alone (a token as the user)')
  for (const x of ['about:blank', '', 'not an address', 'chrome-error://chromewebdata/']) assert.equal(maskUrl(x), x)
  assert.equal(maskUrl(null), '')
  assert.equal(maskUrl(undefined), '')
  // the token value never survives in any form
  const raw = 'https://t.example/x?code=SECRET1&state=s#access_token=SECRET2&refresh_token=SECRET3'
  assert.doesNotMatch(maskUrl(raw), /SECRET/)
})

test('BT-U-07 키 · 서명 이름들, ; 로 나뉜 매개변수, 값 안의 주소(한 단계), 주소가 제목인 페이지, 가린 주소를 다시 쓸 때', () => {
  assert.equal(maskUrl('https://s3.example/o?X-Amz-Algorithm=A&X-Amz-Credential=c&X-Amz-Signature=s&X-Amz-Security-Token=t'),
    'https://s3.example/o?X-Amz-Algorithm=A&X-Amz-Credential=…&X-Amz-Signature=…&X-Amz-Security-Token=…')
  assert.equal(maskUrl('https://gcs.example/o?X-Goog-Credential=c&X-Goog-Signature=s'), 'https://gcs.example/o?X-Goog-Credential=…&X-Goog-Signature=…')
  assert.equal(maskUrl('https://cf.example/o?Policy=p&Signature=s&Key-Pair-Id=k'), 'https://cf.example/o?Policy=…&Signature=…&Key-Pair-Id=…')
  assert.equal(maskUrl('https://x.example/?oauth_token=a&oauth_verifier=b&jwt=c&key=d&api_key=e&apikey=f&client_secret=g&token_hash=h&q=1'),
    'https://x.example/?oauth_token=…&oauth_verifier=…&jwt=…&key=…&api_key=…&apikey=…&client_secret=…&token_hash=…&q=1')
  assert.equal(maskUrl('https://x.example/a?a=1;token=2;b=3'), 'https://x.example/a?a=1;token=…;b=3')
  assert.equal(maskUrl('https://x.example/login?next=https%3A%2F%2Fy.example%2Fcb%23access_token%3DSECRET%26x%3D1'), 'https://x.example/login?next=https%3A%2F%2Fy.example%2Fcb%23access_token%3D…%26x%3D1')
  assert.equal(maskUrl('https://x.example/login?next=%2Fcb%3Ftoken%3DSECRET%26a%3D1'), 'https://x.example/login?next=%2Fcb%3Ftoken%3D…%26a%3D1')
  assert.equal(maskUrl('https://x.example/a?next=%2Fhome&r=https%3A%2F%2Fy.example%2F'), 'https://x.example/a?next=%2Fhome&r=https%3A%2F%2Fy.example%2F')
  // (one level: an address inside an address inside a value is not looked into)
  const two = encodeURIComponent(`https://y.example/?next=${encodeURIComponent('https://z.example/#access_token=DEEP')}`)
  assert.match(maskUrl(`https://x.example/?next=${two}`), /DEEP/)
  // a page with no title of its own is titled with its address
  assert.equal(maskTitle('127.0.0.1:5173/landing?code=S&state=t', 'http://127.0.0.1:5173/landing?code=S&state=t'), '127.0.0.1:5173/landing?code=…&state=t')
  assert.equal(maskTitle('http://x.example/?token=T', 'http://x.example/?token=T'), 'http://x.example/?token=…')
  assert.equal(maskTitle('주문 내역', 'http://x.example/?token=T'), '주문 내역')
  // where the address itself is not known: the masked values are left out, never sent as "…"
  assert.equal(withoutMasked('https://x.example/landing?code=…&state=st&token=%E2%80%A6#access_token=…&t=b'), 'https://x.example/landing?state=st#t=b')
  assert.equal(withoutMasked('https://x.example/a?q=1#x'), 'https://x.example/a?q=1#x')
  assert.equal(withoutMasked('https://x.example/done#…'), 'https://x.example/done')
})

test('BT-U-04 데스크톱 브라우저가 쓰는 가림 함수는 서버의 것과 글자 하나 다르지 않다', () => {
  const desktop = require('../../desktop/src/browser/urlTokens.js')
  assert.equal(String(desktop.maskUrl), String(maskUrl), 'desktop/src/browser/urlTokens.js 를 server/lib/urlTokens.js 와 같게')
  assert.equal(String(desktop.maskTitle), String(maskTitle), 'maskTitle 도 같게')
  assert.equal(desktop.maskUrl('https://x.example/a?code=1&state=s#access_token=2'), 'https://x.example/a?code=…&state=s#access_token=…')
})

const GATEWAY = { supabaseUrl: 'https://auth.process-gpt.io', supabasePublicUrl: '', publicUrl: 'https://www.process-gpt.io/lite', tenantHosts: '', tenantFromHeader: true }
const INSTALLED = { supabaseUrl: 'http://127.0.0.1:54321', supabasePublicUrl: 'https://supa.acme.example', publicUrl: 'https://lite.acme.example', tenantHosts: 'en.localhost=en-demo', tenantFromHeader: false }

test('BT-U-05 로그인으로 들어가는 길: 로그인 서버의 단계 · Lite 의 로그인 API(어떤 요청이든) · 로그인 화면(페이지로) — 로그인 서버와 이 앱의 주소에서', () => {
  const gw = signInPlaces(GATEWAY)
  assert.deepEqual(gw, { hosts: ['auth.process-gpt.io', 'www.process-gpt.io'], parents: ['process-gpt.io'], prefixes: ['/lite'], app: { publicUrl: 'https://www.process-gpt.io/lite', tenantUrl: null, gateway: true } })
  const steps = [
    'https://auth.process-gpt.io/auth/v1/authorize?provider=google&redirect_to=https://acme.process-gpt.io/lite/api/config',
    'https://acme.process-gpt.io/auth/v1/authorize?provider=google',
    'https://acme.process-gpt.io/lite/auth/v1/callback?code=x&state=y',
    'https://auth.process-gpt.io/auth/v1/verify?token=t&type=magiclink&redirect_to=x',
    'https://ACME.Process-GPT.io./AUTH/V1/AUTHORIZE?provider=google',
    'https://acme.process-gpt.io/auth/v1/%61uthorize?provider=google',
    'https://acme.process-gpt.io/auth%2Fv1%2Fauthorize?provider=google',
    'https://acme.process-gpt.io//auth//v1//authorize/',
    'https://u:p@acme.process-gpt.io/auth/v1/authorize',
    'https://process-gpt.io/auth/v1/authorize',
    // a password, a code, a sign-up, a reset, a magic link, single sign-on — the auth server's other ways in
    'https://auth.process-gpt.io/auth/v1/token?grant_type=password', 'https://acme.process-gpt.io/auth/v1/otp', 'https://acme.process-gpt.io/auth/v1/signup',
    'https://acme.process-gpt.io/auth/v1/recover', 'https://acme.process-gpt.io/auth/v1/magiclink', 'https://acme.process-gpt.io/auth/v1/sso',
    // Lite's own sign-in API, behind the gateway (/lite) or not
    'https://acme.process-gpt.io/lite/api/auth/email/start', 'https://acme.process-gpt.io/lite/api/auth/email/verify', 'https://acme.process-gpt.io/lite/api/auth/google/start?n=ab',
    'https://acme.process-gpt.io/api/auth/refresh',
    // ProcessGPT's single sign-on, from its /auth page's fetch
    'https://acme.process-gpt.io/pi-system-backend/auth/sso/exchange?redirect_to=%2Fauth',
  ]
  for (const u of steps) {
    assert.equal(isSignInStep(u, gw), true, u)
    assert.equal(isSignInStep(u, gw, { document: false }), true, `${u} (not a page load)`)
  }
  // the sign-in screens, as pages only (Lite's and ProcessGPT's)
  for (const u of ['https://acme.process-gpt.io/lite/login', 'https://acme.process-gpt.io/lite/login?error=x', 'https://acme.process-gpt.io/lite/auth/done?n=a#x',
    'https://acme.process-gpt.io/auth/login', 'https://acme.process-gpt.io/auth/register', 'https://acme.process-gpt.io/auth/forgot-password',
    'https://acme.process-gpt.io/auth/reset-password', 'https://acme.process-gpt.io/auth/two-step?redirect=/', 'https://acme.process-gpt.io/tenant/register',
    'https://acme.process-gpt.io/auth?redirect=%2F', 'https://acme.process-gpt.io/LITE/Login/']) {
    assert.equal(isSignInStep(u, gw), true, u)
    assert.equal(isSignInStep(u, gw, { document: false }), false, `${u}: a request of a page that is not a page load`)
  }
  for (const u of [
    // the Google connection this app makes in that browser, and Google's own pages
    'https://acme.process-gpt.io/lite/api/auth/google/callback?code=x&state=y',
    'https://acme.process-gpt.io/lite/api/auth/google/done',
    'https://accounts.google.com/o/oauth2/v2/auth?client_id=x&redirect_uri=https://acme.process-gpt.io/lite/api/auth/google/callback',
    // other pages and steps, other sites' Supabase sign-ins, look-alike hosts
    'https://auth.process-gpt.io/auth/v1/settings', 'https://auth.process-gpt.io/auth/v1/user',
    'https://acme.process-gpt.io/lite/chat', 'https://acme.process-gpt.io/lite/api/config', 'https://acme.process-gpt.io/lite/api/team/shares/1/raw?sig=x',
    'https://acme.process-gpt.io/blog/login-tips', 'https://acme.process-gpt.io/auth/maintenance',
    'https://other-project.supabase.co/auth/v1/authorize?provider=google', 'https://example.com/login',
    'https://process-gpt.io.evil.example/auth/v1/authorize', 'https://evil.example/process-gpt.io/auth/v1/authorize',
    'ftp://acme.process-gpt.io/auth/v1/authorize', 'not an address',
  ]) assert.equal(isSignInStep(u, gw), false, u)
  assert.equal(onPlaces('https://acme.process-gpt.io/lite/chat', gw), true)
  assert.equal(onPlaces('https://notebooklm.google.com/', gw), false)
  const inst = signInPlaces(INSTALLED)
  assert.deepEqual(inst, { hosts: ['127.0.0.1', 'supa.acme.example', 'lite.acme.example', 'en.localhost'], parents: [], prefixes: ['/lite'], app: { publicUrl: 'https://lite.acme.example', tenantUrl: null, gateway: false } })
  // the sign-in API and screens are this app's own pages only: the auth server's host (here 127.0.0.1) serves other sites too
  assert.equal(isSignInStep('http://127.0.0.1:61234/login', inst), false, 'another site on the same machine')
  assert.equal(isSignInStep('https://supa.acme.example/login', inst), false)
  assert.equal(isSignInStep('https://lite.acme.example:8443/login', inst), false, 'another port')
  assert.equal(isSignInStep('http://127.0.0.1:54321/auth/v1/authorize?provider=google', inst), true)
  assert.equal(isSignInStep('https://lite.acme.example/auth/v1/verify?token=x', inst), true, 'the installed app\'s web server passes /auth/v1 on')
  assert.equal(isSignInStep('http://en.localhost:5180/auth/v1/callback', inst), true)
  assert.equal(isSignInStep('https://lite.acme.example/login', inst), true)
  assert.equal(isSignInStep('https://lite.acme.example/api/auth/email/verify', inst, { document: false }), true)
  assert.equal(isSignInStep('https://acme.process-gpt.io/auth/v1/authorize', inst), false, 'not behind the gateway: no sibling hosts')
})

// CDP Fetch's wildcard ('*' any run, '?' one character) — how the browser matches a pattern against a request's address
const wild = (pattern, url) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`).test(url)
const paused = (patterns, url, document = false) => patterns.some((p) => (!p.resourceType || (document && p.resourceType === 'Document')) && wild(p.urlPattern, url))

test('BT-U-06 브라우저가 멈춰 보는 것: 로그인 서버 · 이 앱 호스트로 가는 모든 요청, 사설 주소로 가는 요청, 페이지 로드 — 보통 사이트의 요청은 아님', () => {
  const p = [...privatePatterns(), ...stepPatterns(signInPlaces(GATEWAY))]
  assert.ok(p.every((x) => x.requestStage === 'Request'), 'before they are sent')
  // any request to this app's and its auth server's hosts, however its path is written (isSignInStep reads it)
  for (const u of ['https://auth.process-gpt.io/%61uth/v1/token?grant_type=password', 'https://auth.process-gpt.io/auth//v1/token', 'https://acme.process-gpt.io/lite/%61pi/auth/email/verify',
    'https://acme.process-gpt.io/lite/api//auth/email/verify', 'https://acme.process-gpt.io/pi-system-backend/auth/sso/exchange?redirect_to=%2Fauth', 'https://acme.process-gpt.io:8443/x.js']) {
    assert.ok(paused(p, u), u)
    assert.equal(isSignInStep(u, signInPlaces(GATEWAY), { document: false }), !u.endsWith('x.js'), u)
  }
  // any request to a private address, by number or by an inside-only name
  for (const u of ['http://127.0.0.1:8787/api/auth/email/verify', 'http://10.43.0.5/', 'http://172.20.1.1/', 'http://192.168.0.1/', 'http://169.254.169.254/latest', 'http://100.100.1.1/',
    'http://34.118.230.1/', 'http://[::1]:18080/', 'http://[fd00::1]/', 'http://localhost:18080/', 'http://app.localhost:18080/', 'http://x.default.svc.cluster.local/',
    'http://api.internal/', 'http://printer.local/', 'http://web./']) assert.ok(paused(p, u), u)
  // an ordinary site: its page load (its name is resolved), and nothing it loads
  assert.ok(paused(p, 'https://www.naver.com/', true), 'a page load')
  for (const u of ['https://www.naver.com/', 'https://ssl.pstatic.net/static/js/app.js', 'https://fonts.gstatic.com/s/a.woff2', 'https://www.google-analytics.com/g/collect?v=2',
    'https://notebooklm.google.com/_/LabsTailwindUi/data/batchexecute?rpcids=x', 'https://cdn.example.com/10.1/lib.js', 'https://img.example.com/./a.png']) {
    assert.equal(paused(p, u), u.includes('/./'), `${u}: not paused unless its address looks like an inside one`)
  }
  assert.deepEqual(stepPatterns({ hosts: [], parents: [], prefixes: [], app: null }), [], 'no hosts: no sign-in patterns')
})

const DOCKER = { publicUrl: 'http://localhost:18080', supabaseUrl: 'http://localhost:18080', supabasePublicUrl: '', tenantHosts: '', tenantFromHeader: false }
test('BT-U-08 서버 브라우저는 이 서버의 망을 열지 않는다: 루프백 · 사설 · 한 단어 이름 · 클러스터 이름 · 메일함 — 이 앱 주소(루프백 별칭 포함)는 열되 로그인 규칙대로', async () => {
  const was = { publicUrl: config.publicUrl, tenantFromHeader: config.tenantFromHeader }
  Object.assign(config, { publicUrl: DOCKER.publicUrl, tenantFromHeader: false })
  forgetResolved()
  try {
    const none = allowedPrivate('')
    const places = signInPlaces(DOCKER)
    // this app's own address by its other loopback names: opened, its sign-in refused
    for (const base of ['http://localhost:18080', 'http://127.0.0.1:18080', 'http://app.localhost:18080', 'http://[::1]:18080']) {
      assert.equal(await privateRefusal(`${base}/chat`, { allow: none, document: true }), null, base)
      assert.equal(isSignInStep(`${base}/login`, places), true, `${base}/login`)
      assert.equal(isSignInStep(`${base}/api/auth/email/verify`, places, { document: false }), true, `${base} code`)
      assert.equal(isSignInStep(`${base}/auth/v1/verify?token=x`, places, { document: false }), true, `${base} verify`)
    }
    // the install's containers by name, another port of this machine, the cluster's names and addresses
    for (const u of ['http://web/login', 'http://web/api/auth/email/verify', 'http://kong:8000/auth/v1/verify?token=x', 'http://127.0.0.1:8787/api/auth/email/verify',
      'http://localhost:54321/auth/v1/token', 'http://process-gpt-lite-web/', 'http://process-gpt-lite-web.default.svc.cluster.local/', 'http://kubernetes.default.svc/',
      'http://10.43.0.5/', 'http://169.254.169.254/latest/meta-data', 'http://[fd00::1]/', 'http://web./']) assert.equal(await privateRefusal(u, { allow: none }), 'private', u)
    assert.equal(await privateRefusal('http://mailpit:8025/', { allow: none }), 'mailbox')
    assert.equal(await privateRefusal('http://mailpit:8025/', { allow: allowedPrivate('mailpit,http://mailpit:8025') }), 'mailbox', 'never, allowed or not')
    assert.equal(await privateRefusal('http://127.0.0.1:8025/view', { allow: allowedPrivate('127.0.0.1') }), 'mailbox', 'its port on a private address')
    assert.equal(isMailbox('https://mailpit.example.com/'), true)
    // a name that resolves to an inside address: a page load is refused (a name of two labels the cluster's search domain completes)
    const inside = async () => [{ address: '10.43.12.7', family: 4 }]
    const outside = async () => [{ address: '93.184.216.34', family: 4 }]
    assert.equal(await privateRefusal('http://web.default/', { allow: none, document: true, lookup: inside }), 'private')
    forgetResolved()
    assert.equal(await privateRefusal('http://127.0.0.1.nip.example/', { allow: none, document: true, lookup: async () => [{ address: '127.0.0.1', family: 4 }] }), 'private')
    // an ordinary public site: opened
    forgetResolved()
    assert.equal(await privateRefusal('https://www.naver.com/', { allow: none, document: true, lookup: outside }), null)
    assert.equal(await privateRefusal('https://www.naver.com/x.js', { allow: none }), null)
    // the company's allowlist: an origin, a host any port, *.suffix
    const allow = allowedPrivate('http://intranet:8080, wiki, *.corp.example')
    assert.equal(await privateRefusal('http://intranet:8080/a', { allow }), null)
    assert.equal(await privateRefusal('http://intranet:9090/a', { allow }), 'private', 'that origin only')
    assert.equal(await privateRefusal('https://wiki:8443/a', { allow }), null)
    assert.equal(await privateRefusal('http://hr.corp.example/', { allow, document: true, lookup: inside }), null)
    // names of one label resolve to nothing in this browser but localhost and the allowed ones — never a mailbox
    assert.equal(hostRules(allowedPrivate('intranet,http://wiki:8080,*.corp.example,mailpit')), 'MAP * ~NOTFOUND, EXCLUDE *.*, EXCLUDE *:*, EXCLUDE localhost, EXCLUDE intranet, EXCLUDE wiki')
  } finally { Object.assign(config, was); forgetResolved() }
})

test('BT-U-09 ProcessGPT 의 SSO 교환은 어떤 요청이든, 그 SSO 가 돌아오는 /auth 는 페이지로', () => {
  const gw = signInPlaces(GATEWAY)
  assert.equal(isSignInStep('https://acme.process-gpt.io/pi-system-backend/auth/sso/exchange?redirect_to=%2Fauth', gw, { document: false }), true, 'its fetch')
  assert.equal(isSignInStep('https://acme.process-gpt.io/pi-system-backend/%61uth/sso/exchange', gw, { document: false }), true)
  assert.equal(isSignInStep('https://acme.process-gpt.io/auth?redirect=%2F', gw), true, '/auth as a page')
  assert.equal(isSignInStep('https://acme.process-gpt.io/auth?redirect=%2F', gw, { document: false }), false)
  assert.equal(isSignInStep('https://acme.process-gpt.io/pi-system-backend/api/other', gw, { document: false }), false)
})

const store = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m } }

test('BT-A-01 /auth/done 은 이 탭이 시작한 로그인의 값과 맞을 때만, 한 번, 30분 안에', () => {
  const s = store()
  const n = startSignIn(s, 1000)
  assert.match(n, /^[0-9a-f]{48}$/)
  assert.equal(takeSignIn(`?n=${n}`, s, 2000), true)
  assert.equal(takeSignIn(`?n=${n}`, s, 2000), false, 'once')
  const n2 = startSignIn(s, 1000)
  assert.notEqual(n2, n)
  assert.equal(takeSignIn('?n=' + 'a'.repeat(48), s, 2000), false, 'another value')
  assert.equal(takeSignIn(`?n=${n2}`, s, 2000), false, 'a wrong try spends the kept value too')
  startSignIn(s, 1000)
  assert.equal(takeSignIn('', s, 2000), false, 'no value back')
  const n3 = startSignIn(s, 1000)
  assert.equal(takeSignIn(`?n=${n3}`, s, 1000 + SIGN_IN_MS + 1), false, 'too late')
  assert.equal(takeSignIn(`?n=${n3}`, store(), 2000), false, 'another tab (nothing kept)')
  const broken = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') }, removeItem: () => {} }
  assert.equal(startSignIn(broken), '', 'a tab that cannot keep it starts no sign-in it could take')
  assert.equal(takeSignIn('?n=x', broken), false)
})

test('BT-A-04 ProcessGPT(Supabase) 로그인: redirect_to 에 값을 싣지 않고, 이 탭에 시작한 그 로그인이 있을 때만 · 한 번 · 30분 안에', () => {
  const sso = { sso: true }
  const s = store()
  startSignIn(s, 1000, { via: 'sso' })
  assert.equal(takeSignIn('', s, 2000, sso), true, 'no value on the address: the sign-in under way is enough')
  assert.equal(takeSignIn('', s, 2000, sso), false, 'once')
  assert.equal(takeSignIn('', store(), 2000, sso), false, 'another tab (nothing under way)')
  startSignIn(s, 1000, { via: 'sso' })
  assert.equal(takeSignIn('', s, 1000 + SIGN_IN_MS + 1, sso), false, 'too late')
  // the two ways do not stand in for each other
  const own = startSignIn(s, 1000)
  assert.equal(takeSignIn(`?n=${own}`, s, 2000, sso), false, 'a Supabase answer while Lite\'s own sign-in was under way')
  const v = startSignIn(s, 1000, { via: 'sso' })
  assert.equal(takeSignIn(`?n=${v}`, s, 2000), false, 'Lite\'s own answer while a Supabase sign-in was under way')
  assert.equal(fromSupabase('#access_token=a&refresh_token=b'), true)
  assert.equal(fromSupabase('#error=access_denied'), true)
  assert.equal(fromSupabase(`#${encodeURIComponent('{"session":{}}')}`), false)
  assert.equal(fromSupabase(''), false)
})

const jwt = (sub) => `h.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.s`
test('BT-A-02 이미 로그인한 사람은 그대로, 남의 · 시작하지 않은 세션은 받지 않는다', () => {
  const mineGot = { session: { access_token: jwt('u-1'), refresh_token: 'r' } }
  const other = { session: { access_token: jwt('u-2'), refresh_token: 'r' } }
  assert.equal(subjectOf(mineGot.session), 'u-1')
  assert.equal(subjectOf({ access_token: 'opaque' }), null)
  assert.equal(doneStep({ mine: true, got: mineGot }), 'take')
  assert.equal(doneStep({ mine: false, got: mineGot }), 'refuse', 'a link from elsewhere')
  assert.equal(doneStep({ mine: false, got: { error: 'access_denied' } }), 'refuse', 'its words are not shown either')
  assert.equal(doneStep({ mine: true, got: { error: 'access_denied' } }), 'fail')
  assert.equal(doneStep({ mine: true, got: null }), 'fail')
  const here = { access_token: jwt('u-1') }
  assert.equal(doneStep({ mine: false, got: other, here, who: 'u-1' }), 'stay')
  assert.equal(doneStep({ mine: true, got: other, here, who: 'u-1' }), 'stay', 'another person\'s session does not replace the one signed in')
  assert.equal(doneStep({ mine: true, got: { error: 'x' }, here, who: 'u-1' }), 'stay')
  assert.equal(doneStep({ mine: true, got: mineGot, here, who: 'u-1' }), 'take', 'the same person signing in again')
})
