// 「앱 설치」 안내 (2026-11-24): the pure rules in src/installEnv.js — which browser this is, what to offer,
// when the card shows by itself, and the link that leaves an in-app browser for the real one.
// Spec: openspec/specs/install-nudge. The screens: e2e/tests/feature/install-nudge.spec.js (F-IN-…).
import test from 'node:test'
import assert from 'node:assert/strict'
import { detect, guideKind, shouldNudge, answered, openInBrowser, SNOOZE_DAYS } from '../../src/installEnv.js'

export const UA = {
  androidChrome: 'Mozilla/5.0 (Linux; Android 14; SM-S928N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
  samsung: 'Mozilla/5.0 (Linux; Android 14; SM-S928N) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36',
  androidEdge: 'Mozilla/5.0 (Linux; Android 14; SM-S928N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36 EdgA/131.0.0.0',
  androidFirefox: 'Mozilla/5.0 (Android 14; Mobile; rv:132.0) Gecko/132.0 Firefox/132.0',
  kakaoAndroid: 'Mozilla/5.0 (Linux; Android 14; SM-S928N Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0.6778.39 Mobile Safari/537.36;KAKAOTALK 2410520',
  kakaoIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 KAKAOTALK 10.9.0',
  naverIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 NAVER(inapp; search; 2000; 12.0.10; 15PRO)',
  naverAndroid: 'Mozilla/5.0 (Linux; Android 13; SM-S908N Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/119.0.6045.163 Mobile Safari/537.36 NAVER(inapp; search; 2000; 12.3.6)',
  lineIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari Line/14.0.0',
  instagramIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 312.0.0.32.112 (iPhone15,3; iOS 17_1; ko_KR; ko; scale=3.00; 1290x2796; 548339486)',
  facebookAndroid: 'Mozilla/5.0 (Linux; Android 14; SM-S928N Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0.0.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/450.0.0.43.109;]',
  unknownWebviewIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  iosSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
  iosChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1',
  ipad: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
  wrapper: 'Mozilla/5.0 (Linux; Android 14; SM-S928N Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0.0.0 Mobile Safari/537.36 pgpt-pro-android/0.1.0',
  macChrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
  winEdge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
  winFirefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0',
  electron: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) process-gpt-lite-desktop/0.1.0 Chrome/130.0.0.0 Electron/33.0.0 Safari/537.36',
}

test('U-IN-01 browsers: phone and computer, the in-app browsers by name, an unknown app web view', () => {
  assert.deepEqual(pick(detect({ ua: UA.androidChrome })), { os: 'android', browser: 'chrome', inapp: null, appMode: false })
  assert.equal(detect({ ua: UA.samsung }).browser, 'samsung')
  assert.equal(detect({ ua: UA.androidEdge }).browser, 'edge')
  assert.equal(detect({ ua: UA.androidFirefox }).browser, 'firefox')
  assert.deepEqual(detect({ ua: UA.kakaoAndroid }).inapp, { id: 'kakaotalk', name: '카카오톡' })
  assert.deepEqual(detect({ ua: UA.kakaoIos }), { os: 'ios', browser: 'safari', inapp: { id: 'kakaotalk', name: '카카오톡' }, appMode: false, wrapper: false, electron: false })
  assert.equal(detect({ ua: UA.naverIos }).inapp.id, 'naver')
  assert.equal(detect({ ua: UA.naverAndroid }).inapp.id, 'naver')
  assert.equal(detect({ ua: UA.lineIos }).inapp.id, 'line')
  assert.equal(detect({ ua: UA.instagramIos }).inapp.id, 'instagram')
  assert.equal(detect({ ua: UA.facebookAndroid }).inapp.id, 'facebook')
  assert.deepEqual(detect({ ua: UA.unknownWebviewIos }).inapp, { id: 'webview', name: '' })
  assert.equal(detect({ ua: UA.iosSafari }).inapp, null)
  assert.equal(detect({ ua: UA.iosChrome }).browser, 'chrome')
  // iPadOS reports a Mac; touch tells
  assert.equal(detect({ ua: UA.ipad, touchPoints: 5 }).os, 'ios')
  assert.equal(detect({ ua: UA.macSafari, touchPoints: 0 }).os, 'desktop')
  assert.equal(detect({ ua: UA.macChrome }).browser, 'chrome')
  assert.equal(detect({ ua: UA.winEdge }).browser, 'edge')
})

test('U-IN-02 the installed app, the Android wrapper and the desktop app are "app mode" — never an in-app browser', () => {
  assert.equal(detect({ ua: UA.androidChrome, standalone: true }).appMode, true)
  const w = detect({ ua: UA.wrapper })
  assert.equal(w.appMode, true)
  assert.equal(w.inapp, null) // its web view is ours, not an app's browser to leave
  assert.equal(detect({ ua: UA.androidChrome, androidBridge: true }).appMode, true)
  assert.equal(detect({ ua: UA.electron }).appMode, true)
  // the desktop app takes Electron out of its user agent: the page mark tells
  assert.equal(detect({ ua: UA.macChrome, desktopApp: true }).appMode, true)
  for (const ua of Object.values(UA)) assert.equal(guideKind(detect({ ua, standalone: true }), { canPrompt: true }), 'none')
})

test('U-IN-03 what to offer: the browser\'s dialog, the iPhone steps, the real browser first, the menu', () => {
  const k = (ua, canPrompt = false, extra = {}) => guideKind(detect({ ua, ...extra }), { canPrompt })
  assert.equal(k(UA.androidChrome, true), 'prompt')
  assert.equal(k(UA.samsung, true), 'prompt')
  assert.equal(k(UA.androidChrome), 'menu') // no offer (yet): only settings › 앱 설치 shows the menu way
  assert.equal(k(UA.iosSafari), 'ios')
  assert.equal(k(UA.iosChrome), 'ios')
  assert.equal(k(UA.ipad, false, { touchPoints: 5 }), 'ios')
  assert.equal(k(UA.kakaoAndroid, true), 'inapp') // an in-app browser first leaves, whatever it claims
  assert.equal(k(UA.kakaoIos), 'inapp')
  assert.equal(k(UA.macChrome, true), 'prompt')
  assert.equal(k(UA.macChrome), 'menu')
  assert.equal(k(UA.macSafari), 'menu')
  assert.equal(k(UA.winFirefox), 'unsupported')
})

test('U-IN-04 the card by itself: not after 「나중에」 for 7 days, never after 「다시 보지 않기」, not once installed, not at a computer\'s sign-in', () => {
  const now = Date.parse('2026-11-24T09:00:00+09:00')
  const phone = detect({ ua: UA.androidChrome })
  const mac = detect({ ua: UA.macChrome })
  assert.equal(shouldNudge('prompt', phone, 'login', {}, now), true)
  assert.equal(shouldNudge('prompt', phone, 'home', {}, now), true)
  assert.equal(shouldNudge('menu', phone, 'home', {}, now), false)
  assert.equal(shouldNudge('none', phone, 'home', {}, now), false)
  const later = answered({}, 'later', now)
  assert.equal(later.snoozeUntil, now + SNOOZE_DAYS * 86_400_000)
  assert.equal(shouldNudge('prompt', phone, 'home', later, now + 6 * 86_400_000), false)
  assert.equal(shouldNudge('prompt', phone, 'home', later, now + 7 * 86_400_000 + 1), true)
  const never = answered(later, 'never', now)
  assert.equal(shouldNudge('prompt', phone, 'home', never, now + 400 * 86_400_000), false)
  // installed here before: the iPhone steps and the in-app note stay away; Chrome offering again means it is not installed any more
  const ios = detect({ ua: UA.iosSafari })
  assert.equal(shouldNudge('ios', ios, 'home', { installedAt: now }, now), false)
  assert.equal(shouldNudge('ios', ios, 'home', {}, now, true), false)
  assert.equal(shouldNudge('prompt', phone, 'home', { installedAt: now }, now), true)
  // a computer: Home's small card only
  assert.equal(shouldNudge('prompt', mac, 'login', {}, now), false)
  assert.equal(shouldNudge('prompt', mac, 'home', {}, now), true)
})

test('U-IN-05 leaving an in-app browser keeps the address (path and query), drops the fragment', () => {
  const href = 'https://uengine.process-gpt.io/lite/routines/abc?from=kakao#top'
  assert.deepEqual(openInBrowser(detect({ ua: UA.kakaoAndroid }), href), {
    via: 'chrome',
    href: 'intent://uengine.process-gpt.io/lite/routines/abc?from=kakao#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=https%3A%2F%2Fuengine.process-gpt.io%2Flite%2Froutines%2Fabc%3Ffrom%3Dkakao;end',
  })
  // any Android app's browser: the same intent
  assert.equal(openInBrowser(detect({ ua: UA.naverAndroid }), href).via, 'chrome')
  assert.equal(openInBrowser(detect({ ua: UA.facebookAndroid }), 'http://localhost:5180/login').href,
    'intent://localhost:5180/login#Intent;scheme=http;package=com.android.chrome;S.browser_fallback_url=http%3A%2F%2Flocalhost%3A5180%2Flogin;end')
  assert.deepEqual(openInBrowser(detect({ ua: UA.kakaoIos }), href), {
    via: 'safari', href: 'kakaotalk://web/openExternal?url=https%3A%2F%2Fuengine.process-gpt.io%2Flite%2Froutines%2Fabc%3Ffrom%3Dkakao',
  })
  assert.deepEqual(openInBrowser(detect({ ua: UA.lineIos }), href), { via: 'safari', href: 'https://uengine.process-gpt.io/lite/routines/abc?from=kakao&openExternalBrowser=1' })
  // other iOS apps: no link can do it (their ⋯ menu), and a real browser needs none
  assert.equal(openInBrowser(detect({ ua: UA.instagramIos }), href), null)
  assert.equal(openInBrowser(detect({ ua: UA.naverIos }), href), null)
  assert.equal(openInBrowser(detect({ ua: UA.iosSafari }), href), null)
  assert.equal(openInBrowser(detect({ ua: UA.androidChrome }), href), null)
})

function pick(e) { return { os: e.os, browser: e.browser, inapp: e.inapp, appMode: e.appMode } }
