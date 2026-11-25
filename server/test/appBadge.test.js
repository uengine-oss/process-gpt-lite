// 앱 배지(src/appBadge.js — src/browserNotify.js setBadge 가 부른다, 2026-11-25 「일렉트론 버전의 시스템 트레이에 알람 개수 뱃지 설치」):
// 데스크톱 앱에서는 다리(pglDesktop.setBadge)로만 — Dock · 작업 표시줄 · 트레이, 설치한 웹 앱(PWA)에서는 navigator.setAppBadge.
// 수는 0…9999 의 정수로. 화면 없이, window · navigator 대신 가짜로.
//   node --test test/appBadge.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { badgeCount, showBadge } from '../../src/appBadge.js'

const fakeNav = () => {
  const calls = []
  return { calls, setAppBadge: (n) => { calls.push(['set', n]); return Promise.resolve() }, clearAppBadge: () => { calls.push(['clear']); return Promise.resolve() } }
}
const fakeDesktop = () => {
  const calls = []
  return { calls, pglDesktop: Object.freeze({ app: 'process-gpt-lite', setBadge: (n) => calls.push(n) }) }
}

test('AB-U-01 수: 정수 0…9999 — 음수 · 숫자 아님 · 소수 · 너무 큰 수', () => {
  assert.deepEqual([3, 0, -2, 2.9, '7', 'x', null, undefined, NaN, Infinity, 123456].map(badgeCount), [3, 0, 0, 2, 7, 0, 0, 0, 0, 9999, 9999])
})

test('AB-U-02 데스크톱 앱: 다리로만 보내고 navigator 의 배지는 부르지 않는다 (0 도 보낸다)', () => {
  const win = fakeDesktop()
  const nav = fakeNav()
  assert.equal(showBadge(3, { win, nav }), 'desktop')
  assert.equal(showBadge(0, { win, nav }), 'desktop')
  assert.equal(showBadge(-1, { win, nav }), 'desktop')
  assert.equal(showBadge(42.7, { win, nav }), 'desktop')
  assert.deepEqual(win.calls, [3, 0, 0, 42])
  assert.deepEqual(nav.calls, [])
})

test('AB-U-03 설치한 웹 앱(PWA): navigator.setAppBadge, 0 이면 clearAppBadge — 지금까지와 같이', () => {
  const nav = fakeNav()
  assert.equal(showBadge(5, { win: {}, nav }), 'pwa')
  assert.equal(showBadge(0, { win: {}, nav }), 'pwa')
  assert.deepEqual(nav.calls, [['set', 5], ['clear']])
})

test('AB-U-04 배지가 없는 곳 · 거절 · 오래된 데스크톱 앱: 페이지 오류가 되지 않는다', async () => {
  // no Badging API
  assert.equal(showBadge(2, { win: {}, nav: {} }), null)
  assert.equal(showBadge(2, { win: undefined, nav: undefined }), null)
  // the browser refuses (not installed, no permission): the promise's rejection is caught
  let unhandled = 0
  const onUnhandled = () => { unhandled++ }
  process.on('unhandledRejection', onUnhandled)
  const nav = { setAppBadge: () => Promise.reject(new Error('NotAllowedError')), clearAppBadge: () => { throw new Error('gone') } }
  assert.equal(showBadge(2, { win: {}, nav }), 'pwa')
  assert.equal(showBadge(0, { win: {}, nav }), null)
  await new Promise((ok) => setTimeout(ok, 20))
  process.off('unhandledRejection', onUnhandled)
  assert.equal(unhandled, 0)
  // a desktop app whose bridge has no setBadge (0.2.3 and before): the Badging API as before (Electron's own Dock number)
  const old = fakeNav()
  assert.equal(showBadge(4, { win: { pglDesktop: { app: 'process-gpt-lite' } }, nav: old }), 'pwa')
  assert.deepEqual(old.calls, [['set', 4]])
  // a bridge that throws: no page error — the Badging API instead
  const thrower = fakeNav()
  assert.equal(showBadge(4, { win: { pglDesktop: { setBadge: () => { throw new Error('ipc closed') } } }, nav: thrower }), 'pwa')
  assert.deepEqual(thrower.calls, [['set', 4]])
})
