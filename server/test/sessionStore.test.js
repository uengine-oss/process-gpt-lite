// Where the page keeps the sign-in (src/sessionStore.js — desktop 0.2.6): the page's localStorage in a browser, the desktop app's sealed
// store in the app; a sign-in the page's storage held moves to the app once and leaves the storage. Spec desktop-app 「로그인 보관」.
// Run: node --test test/sessionStore.test.js
import test from 'node:test'
import assert from 'node:assert/strict'

const { makeSessionStore, spendMoved, KEY } = await import('../../src/sessionStore.js')

function storage(init = {}) {
  const m = new Map(Object.entries(init))
  return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }
}
function app({ sealed = true, keeps = true, value = null, keptBefore = false } = {}) {
  const calls = []
  return { calls, kept: () => value, sealed: () => sealed, keptBefore: () => keptBefore, get: () => value, set: (v) => { calls.push(['set', v]); if (keeps) value = v; return keeps }, clear: () => { calls.push(['clear']); value = null; return true } }
}
const S = JSON.stringify({ session: { access_token: 'a.b.c', refresh_token: 'r-1' } })

test('브라우저(앱 다리 없음): 지금처럼 이 페이지의 저장소', () => {
  const ls = storage()
  const st = makeSessionStore({ desktop: null, storage: ls })
  assert.deepEqual([st.sealed, st.moved, st.read()], [false, false, null])
  st.write(S)
  assert.equal(ls.getItem(KEY), S)
  assert.equal(st.read(), S)
  st.remove()
  assert.equal(ls.getItem(KEY), null)
})

test('데스크톱 앱: 앱이 봉인해 두고 이 페이지의 저장소에는 쓰지 않는다', () => {
  const ls = storage(), d = app()
  const st = makeSessionStore({ desktop: d, storage: ls })
  assert.deepEqual([st.sealed, st.moved], [true, false])
  st.write(S)
  assert.equal(ls.getItem(KEY), null)
  assert.equal(d.kept(), S)
  assert.equal(st.read(), S)
  st.remove()
  assert.equal(d.kept(), null)
  assert.deepEqual(d.calls.map((c) => c[0]), ['set', 'clear'])
})

test('저장소에 있던 로그인(앞선 판)은 처음 읽을 때 앱으로 옮기고 저장소에서 지운다 — 옮겼다고 알린다(한 번 새로 받기)', () => {
  const ls = storage({ [KEY]: S, 'pgl-lang': 'ko' }), d = app({ value: '{"old":1}' })
  const st = makeSessionStore({ desktop: d, storage: ls })
  assert.deepEqual([st.sealed, st.moved, st.read()], [true, true, S], '저장소의 것이 더 새것(앞선 판이 쓴 것)')
  assert.equal(ls.getItem(KEY), null)
  assert.equal(ls.getItem('pgl-lang'), 'ko', '다른 값은 그대로')
  // the next load: nothing to move
  const again = makeSessionStore({ desktop: d, storage: ls })
  assert.deepEqual([again.moved, again.read()], [false, S])
  // an empty one: only removed
  const ls2 = storage({ [KEY]: '' })
  assert.equal(makeSessionStore({ desktop: app(), storage: ls2 }).moved, false)
  assert.equal(ls2.getItem(KEY), null)
})

test('앱이 봉인할 수 없으면(키체인 없음 · 거절) 저장소 그대로 — 로그인을 잃지 않는다', () => {
  const ls = storage({ [KEY]: S })
  const none = makeSessionStore({ desktop: app({ sealed: false }), storage: ls })
  assert.deepEqual([none.sealed, none.moved, none.read(), ls.getItem(KEY)], [false, false, S, S])
  const refused = makeSessionStore({ desktop: app({ keeps: false }), storage: ls })
  assert.deepEqual([refused.sealed, refused.moved, refused.read(), ls.getItem(KEY)], [false, false, S, S], '옮기지 못하면 이 페이지는 저장소로')
  // a bridge that throws: the storage
  const broken = makeSessionStore({ desktop: { sealed: () => { throw new Error('x') } }, storage: ls })
  assert.equal(broken.sealed, false)
})

test('앱이 이 서버의 로그인을 보관한 적이 있으면 저장소의 사본은 받지 않고 지운다 — 로그아웃한 뒤 다른 창이 남긴 것도', () => {
  const ls = storage({ [KEY]: S }), d = app({ value: null, keptBefore: true })
  const st = makeSessionStore({ desktop: d, storage: ls })
  assert.deepEqual([st.sealed, st.moved, st.read()], [true, false, null], '로그아웃한 채')
  assert.equal(ls.getItem(KEY), null)
  assert.deepEqual(d.calls, [], '앱이 보관한 것을 덮지 않는다')
  // the one the app keeps stays the one read
  const ls2 = storage({ [KEY]: S }), d2 = app({ value: '{"mine":1}', keptBefore: true })
  assert.equal(makeSessionStore({ desktop: d2, storage: ls2 }).read(), '{"mine":1}')
  assert.equal(ls2.getItem(KEY), null)
})

// spendMoved: the timer is the test's (later), the refresh answers from a list
function auth(v) { let x = v; return { get: () => x, set: (n) => { x = n } } }

test('옮긴 로그인은 새로 받아질 때까지 「다 쓸 것」 표시를 지니고 다시 해 본다 — 서버가 답하지 않으면 5초부터 두 배로, 거절이면 그만', async () => {
  const s0 = { session: { access_token: 'a.b.c', refresh_token: 'r-1' } }
  // the server does not answer twice, then renews (the timers run one by one, with their delays)
  const a = auth({ ...s0 }), timers = [], answers = [null, null, true]
  let calls = 0
  spendMoved({ auth: a, moved: true, refresh: async () => { calls++; const ok = answers.shift(); if (ok) { const { spend, ...rest } = a.get(); a.set({ ...rest, session: { access_token: 'n.e.w', refresh_token: 'r-2' } }) } return ok }, later: (fn, ms) => timers.push([fn, ms]) })
  const delays = []
  while (timers.length) { const [fn, ms] = timers.shift(); delays.push(ms); fn(); await new Promise((r) => setTimeout(r, 0)) }
  assert.deepEqual(delays, [0, 5000, 10000])
  assert.equal(calls, 3)
  assert.equal(a.get().spend, undefined)
  assert.equal(a.get().session.refresh_token, 'r-2')
  // the next load with the mark still there (the app was closed before it went through): tried again
  const b = auth({ ...s0, spend: true }), bt = []
  let bcalls = 0
  spendMoved({ auth: b, moved: false, refresh: async () => { bcalls++; return false }, later: (fn, ms) => bt.push([fn, ms]) })
  while (bt.length) { const [fn] = bt.shift(); fn(); await new Promise((r) => setTimeout(r, 0)) }
  assert.equal(bcalls, 1)
  assert.equal(b.get().spend, undefined, '거절: 쓸 것이 남지 않았다')
  // nothing moved, no mark (a browser, or after it went through): nothing is renewed; one taken from ProcessGPT is left to it
  for (const v of [{ ...s0 }, { ...s0, host: true, spend: true }, null]) {
    const c = auth(v), ct = []
    let n = 0
    spendMoved({ auth: c, moved: false, refresh: async () => { n++; return true }, later: (fn, ms) => ct.push([fn, ms]) })
    while (ct.length) { const [fn] = ct.shift(); fn(); await new Promise((r) => setTimeout(r, 0)) }
    assert.equal(n, 0, JSON.stringify(v))
  }
  const h = auth({ ...s0, host: true })
  spendMoved({ auth: h, moved: true, refresh: async () => true, later: () => {} })
  assert.equal(h.get().spend, undefined)
})
