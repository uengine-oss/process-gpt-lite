// Page addresses shown and kept without sign-in tokens (lib/urlTokens.js — the desktop's copy is the same function), the sign-in steps
// this server's browser does not open (lib/signInSteps.js), and /auth/done taking only the sign-in its own tab started
// (src/signInNonce.js). No network, no database.
//   node --test test/urlTokens.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { maskUrl } from '../lib/urlTokens.js'
import { signInPlaces, isSignInStep, stepPatterns } from '../lib/signInSteps.js'
import { startSignIn, takeSignIn, doneStep, subjectOf, SIGN_IN_MS } from '../../src/signInNonce.js'

const require = createRequire(import.meta.url)

test('BT-U-01 주소의 토큰 값은 이름으로 가린다 — 쿼리와 fragment 둘 다, 값만', () => {
  assert.equal(maskUrl('https://acme.process-gpt.io/lite/api/config#access_token=eyJhbGciOi.x.y&expires_at=1764&expires_in=3600&refresh_token=r-123&token_type=bearer&type=signup'),
    'https://acme.process-gpt.io/lite/api/config#access_token=…&expires_at=1764&expires_in=3600&refresh_token=…&token_type=bearer&type=signup')
  assert.equal(maskUrl('https://app.example/cb?code=4/0AbC&state=s-1&scope=email'), 'https://app.example/cb?code=…&state=s-1&scope=email')
  assert.equal(maskUrl('https://x.example/a?id_token=1&provider_token=2&provider_refresh_token=3&token=4&sig=5&keep=6'),
    'https://x.example/a?id_token=…&provider_token=…&provider_refresh_token=…&token=…&sig=…&keep=6')
  // a signed address keeps where it goes and for how long: only the signature's value goes
  assert.equal(maskUrl('https://lite.example/api/team/shares/7/raw?exp=1764&sig=ab12cd'), 'https://lite.example/api/team/shares/7/raw?exp=1764&sig=…')
  // nothing to hide: the address as it is
  assert.equal(maskUrl('https://www.naver.com/search?query=%EC%82%AC%EA%B3%BC&where=nexearch'), 'https://www.naver.com/search?query=%EC%82%AC%EA%B3%BC&where=nexearch')
})

test('BT-U-02 이름은 대소문자 · %-인코딩과 상관없이, 빈 값 · 값 없는 이름은 그대로', () => {
  assert.equal(maskUrl('https://x.example/a?ACCESS_TOKEN=a&Refresh_Token=b&%63ode=c&%73ig=d'), 'https://x.example/a?ACCESS_TOKEN=…&Refresh_Token=…&%63ode=…&%73ig=…')
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
  assert.equal(maskUrl('https://kim:hunter2@intra.example/p?q=1'), 'https://kim:…@intra.example/p?q=1')
  for (const x of ['about:blank', '', 'not an address', 'chrome-error://chromewebdata/']) assert.equal(maskUrl(x), x)
  assert.equal(maskUrl(null), '')
  assert.equal(maskUrl(undefined), '')
  // the token value never survives in any form
  const raw = 'https://t.example/x?code=SECRET1#access_token=SECRET2&refresh_token=SECRET3'
  assert.doesNotMatch(maskUrl(raw), /SECRET/)
})

test('BT-U-04 데스크톱 브라우저가 쓰는 가림 함수는 서버의 것과 글자 하나 다르지 않다', () => {
  const desktop = require('../../desktop/src/browser/urlTokens.js')
  assert.equal(String(desktop.maskUrl), String(maskUrl), 'desktop/src/browser/urlTokens.js 를 server/lib/urlTokens.js 와 같게')
  assert.equal(desktop.maskUrl('https://x.example/a?code=1#access_token=2'), 'https://x.example/a?code=…#access_token=…')
})

const GATEWAY = { supabaseUrl: 'https://auth.process-gpt.io', supabasePublicUrl: '', publicUrl: 'https://www.process-gpt.io/lite', tenantHosts: '', tenantFromHeader: true }
const INSTALLED = { supabaseUrl: 'http://127.0.0.1:54321', supabasePublicUrl: 'https://supa.acme.example', publicUrl: 'https://lite.acme.example', tenantHosts: 'en.localhost=en-demo', tenantFromHeader: false }

test('BT-U-05 로그인 단계: 로그인 서버 · 이 앱 주소(게이트웨이의 회사 주소, /lite 아래 포함)의 /auth/v1/authorize · callback · verify', () => {
  const gw = signInPlaces(GATEWAY)
  assert.deepEqual(gw, { hosts: ['auth.process-gpt.io', 'www.process-gpt.io'], parents: ['process-gpt.io'] })
  for (const u of [
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
  ]) assert.equal(isSignInStep(u, gw), true, u)
  for (const u of [
    // the Google connection this app makes itself, and Google's own pages
    'https://acme.process-gpt.io/lite/api/auth/google/callback?code=x&state=y',
    'https://accounts.google.com/o/oauth2/v2/auth?client_id=x&redirect_uri=https://acme.process-gpt.io/lite/api/auth/google/callback',
    // other steps of the auth server, other sites' Supabase sign-ins, look-alike hosts
    'https://auth.process-gpt.io/auth/v1/settings',
    'https://acme.process-gpt.io/lite/chat',
    'https://other-project.supabase.co/auth/v1/authorize?provider=google',
    'https://process-gpt.io.evil.example/auth/v1/authorize',
    'https://evil.example/process-gpt.io/auth/v1/authorize',
    'ftp://acme.process-gpt.io/auth/v1/authorize',
    'not an address',
  ]) assert.equal(isSignInStep(u, gw), false, u)
  const inst = signInPlaces(INSTALLED)
  assert.deepEqual(inst, { hosts: ['127.0.0.1', 'supa.acme.example', 'lite.acme.example', 'en.localhost'], parents: [] })
  assert.equal(isSignInStep('http://127.0.0.1:54321/auth/v1/authorize?provider=google', inst), true)
  assert.equal(isSignInStep('https://lite.acme.example/auth/v1/verify?token=x', inst), true, 'the installed app\'s web server passes /auth/v1 on')
  assert.equal(isSignInStep('http://en.localhost:5180/auth/v1/callback', inst), true)
  assert.equal(isSignInStep('https://supa.acme.example/auth/v1/authorize', inst), true)
  assert.equal(isSignInStep('https://acme.process-gpt.io/auth/v1/authorize', inst), false, 'not behind the gateway: no sibling hosts')
})

test('BT-U-06 브라우저가 멈춰 보는 것: 그 호스트들의 문서(페이지 · 프레임 · 리디렉션 한 걸음)만', () => {
  const p = stepPatterns(signInPlaces(GATEWAY))
  assert.ok(p.length > 0)
  assert.ok(p.every((x) => x.resourceType === 'Document' && x.requestStage === 'Request'), 'documents only, before they are sent')
  const urls = p.map((x) => x.urlPattern)
  for (const u of ['*://auth.process-gpt.io/*', '*://auth.process-gpt.io:*', '*://*@auth.process-gpt.io/*', '*://auth.process-gpt.io./*',
    '*://www.process-gpt.io/*', '*://process-gpt.io/*', '*://*.process-gpt.io/*', '*://*.process-gpt.io:*', '*://*.process-gpt.io./*']) assert.ok(urls.includes(u), u)
  assert.equal(urls.length, new Set(urls).size)
  assert.ok(urls.every((u) => /process-gpt\.io\.?(\/\*|:\*)$/.test(u)), 'nothing but those hosts')
  assert.deepEqual(stepPatterns({ hosts: [], parents: [] }), [], 'nothing to look at: nothing is paused')
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
