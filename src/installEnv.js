// 「앱 설치」 안내 — what this browser can do about installing Lite (2026-11-24). Pure: no Vue and no
// window at import time, so server/test/installNudge.test.js runs it in node.
// Why: a colleague tapped the /lite link in KakaoTalk and got "just the web version". An in-app browser
// cannot install a web app at all, and nothing told him so. Now:
//   - the installed app (display-mode standalone, iOS home screen), the Android wrapper (android/, its UA
//     carries pgpt-pro-android/) and the desktop app (desktop/, <html class="pgl-desktop">) see none of it
//   - Chrome · Samsung Internet · Edge: the browser's own install dialog (beforeinstallprompt) — 'prompt'
//   - iPhone · iPad: Safari has no such API — the steps, Share › 홈 화면에 추가 — 'ios'
//   - an in-app browser (KakaoTalk, NAVER, LINE, Instagram, Facebook …): open this same address in the real
//     browser first — 'inapp'
//   - otherwise the browser's menu has it ('menu', only when asked: settings › 앱 설치), or nothing does
//     ('unsupported': Firefox on a computer)

// [id, user agent test, name shown] — first match wins
const INAPP = [
  ['kakaotalk', /KAKAOTALK/i, '카카오톡'],
  ['naver', /NAVER\(inapp/i, '네이버 앱'],
  ['line', /\bLine\/\d/, '라인'],
  ['instagram', /\bInstagram\b/i, '인스타그램'],
  ['facebook', /\bFB(AN|AV|_IAB|4A|IOS)\b/, '페이스북'],
  ['threads', /\bBarcelona\b/, '스레드'],
  ['band', /\bBAND\//, '밴드'],
  ['daum', /\bDaumApps\b/i, '다음 앱'],
  ['everytime', /everytimeApp/i, '에브리타임'],
  ['telegram', /Telegram/i, '텔레그램'],
  ['google', /\bGSA\//, 'Google 앱'],
]

/**
 * What this browser is. `ua` is navigator.userAgent; `touchPoints` tells an iPad (it reports a Mac);
 * `standalone` / `desktopApp` / `androidBridge` are what the page sees of an installed or wrapped app.
 */
export function detect({ ua = '', touchPoints = 0, standalone = false, desktopApp = false, androidBridge = false } = {}) {
  const wrapper = /pgpt-pro-android\//.test(ua) || !!androidBridge
  const electron = /\bElectron\//.test(ua) || !!desktopApp
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1)
  const android = !ios && /Android/i.test(ua)
  const os = ios ? 'ios' : android ? 'android' : 'desktop'
  let inapp = null
  if (!wrapper) {
    const hit = INAPP.find(([, re]) => re.test(ua))
    if (hit) inapp = { id: hit[0], name: hit[2] }
    // an app's own web view without a name we know: Android marks it "; wv)", iOS leaves out "Safari/"
    else if ((android && /; wv\)/.test(ua)) || (ios && !/Safari\//.test(ua))) inapp = { id: 'webview', name: '' }
  }
  const browser = ios
    ? (/CriOS\//.test(ua) ? 'chrome' : /FxiOS\//.test(ua) ? 'firefox' : /EdgiOS\//.test(ua) ? 'edge' : 'safari')
    : /SamsungBrowser\//.test(ua) ? 'samsung'
      : /\bEdg(A|e)?\//.test(ua) ? 'edge'
        : /Firefox\//.test(ua) ? 'firefox'
          : /\bOPR\//.test(ua) ? 'opera'
            : /Chrome\//.test(ua) ? 'chrome'
              : /Safari\//.test(ua) ? 'safari' : 'other'
  return { os, browser, inapp, appMode: !!standalone || wrapper || electron, wrapper, electron }
}

/** What to offer here: 'none' | 'inapp' | 'prompt' | 'ios' | 'menu' | 'unsupported'. */
export function guideKind(env, { canPrompt = false } = {}) {
  if (!env || env.appMode) return 'none'
  if (env.inapp) return 'inapp'
  if (canPrompt) return 'prompt'
  if (env.os === 'ios') return 'ios'
  if (env.os === 'android') return 'menu'
  if (env.browser === 'firefox' || env.browser === 'other') return 'unsupported'
  return 'menu'
}

export const SNOOZE_DAYS = 7
const DAY = 86_400_000

/**
 * Whether the card shows by itself (Home, the sign-in screen) — the settings row is always there.
 * memo: this device's answers ({ snoozeUntil, never, installedAt }); installed: the browser says an
 * installed copy exists (getInstalledRelatedApps).
 */
export function shouldNudge(kind, env, place, memo = {}, now = Date.now(), installed = false) {
  if (!['prompt', 'ios', 'inapp'].includes(kind)) return false
  if (memo.never) return false
  if (memo.snoozeUntil && memo.snoozeUntil > now) return false
  // installed here before — unless the browser offers to install again, which it does only when it is not
  if ((memo.installedAt || installed) && kind !== 'prompt') return false
  // a computer: only the small card on Home, never in the way of signing in
  if (env.os === 'desktop' && place === 'login') return false
  return true
}

/** The memo after 「나중에」 (snooze) or 「다시 보지 않기」 (never). */
export function answered(memo, how, now = Date.now()) {
  if (how === 'never') return { ...memo, never: true }
  return { ...memo, snoozeUntil: now + SNOOZE_DAYS * DAY }
}

/**
 * The link that opens this same address (path and query kept, the fragment dropped) in the real
 * browser, from an in-app one: { via, href } — via 'chrome' (Android, any app: an intent for Chrome, the
 * default browser when there is no Chrome) or 'safari' (iOS KakaoTalk's own scheme, LINE's parameter).
 * null where no link can do it (other iOS apps: their ⋯ menu).
 */
export function openInBrowser(env, href) {
  if (!env?.inapp) return null
  let u
  try { u = new URL(href) } catch { return null }
  u.hash = ''
  if (env.os === 'android') {
    const scheme = u.protocol.replace(/:$/, '')
    return { via: 'chrome', href: `intent://${u.host}${u.pathname}${u.search}#Intent;scheme=${scheme};package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(u.href)};end` }
  }
  if (env.os === 'ios' && env.inapp.id === 'kakaotalk') return { via: 'safari', href: `kakaotalk://web/openExternal?url=${encodeURIComponent(u.href)}` }
  if (env.os === 'ios' && env.inapp.id === 'line') {
    u.searchParams.set('openExternalBrowser', '1')
    return { via: 'safari', href: u.href }
  }
  return null
}
