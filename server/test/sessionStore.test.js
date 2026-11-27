// Where the page keeps the sign-in (src/sessionStore.js — desktop 0.2.6): the page's localStorage in a browser, the desktop app's sealed
// store in the app; a sign-in the page's storage held moves to the app once and leaves the storage. Spec desktop-app 「로그인 보관」.
// Run: node --test test/sessionStore.test.js
import test from 'node:test'
import assert from 'node:assert/strict'

const { makeSessionStore, KEY } = await import('../../src/sessionStore.js')

function storage(init = {}) {
  const m = new Map(Object.entries(init))
  return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }
}
function app({ sealed = true, keeps = true, value = null } = {}) {
  const calls = []
  return { calls, kept: () => value, sealed: () => sealed, get: () => value, set: (v) => { calls.push(['set', v]); if (keeps) value = v; return keeps }, clear: () => { calls.push(['clear']); value = null; return true } }
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
