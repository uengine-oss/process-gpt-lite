// 「앱 설치」 안내 (2026-11-24): a colleague opened the /lite link in KakaoTalk and got "just the web version".
// On a phone-sized screen with each browser's user agent: Chrome's install offer (a fake beforeinstallprompt —
// a test browser never offers it) under our own 「앱 설치」, the iPhone steps, the way out of an in-app browser
// with the address kept, nothing inside the installed app, the answers remembered on the device, settings ›
// 앱 설치 any time, and the link-preview tags crawlers read without running the page.
// Spec: openspec/specs/install-nudge. Pure rules: server/test/installNudge.test.js.
// RT_SHOT_DIR=<dir>: F-IN-10 keeps the phone screens (light and dark) there.
import fs from 'node:fs'
import { test, expect } from '../../lib/fixtures.js'
import { PGPT_URL } from '../../lib/env.js'

const ORIGIN = new URL(PGPT_URL).origin
const BASE_PATH = new URL(PGPT_URL).pathname.replace(/\/+$/, '')
const PHONE = { width: 390, height: 844 }
const UA = {
  androidChrome: 'Mozilla/5.0 (Linux; Android 14; SM-S928N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
  kakaoAndroid: 'Mozilla/5.0 (Linux; Android 14; SM-S928N Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0.6778.39 Mobile Safari/537.36;KAKAOTALK 2410520',
  kakaoIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 KAKAOTALK 10.9.0',
  instagramIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 312.0.0.32.112 (iPhone15,3; iOS 17_1; ko_KR; ko; scale=3.00; 1290x2796; 548339486)',
  iosSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
  wrapper: 'Mozilla/5.0 (Linux; Android 14; SM-S928N Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0.0.0 Mobile Safari/537.36 pgpt-pro-android/0.1.0',
  macChrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
}

// A context like the fixtures' pageAs, with the browser's user agent and, optionally, signed in, the app
// opened as installed (display-mode standalone / iOS home screen / the desktop app's page mark), a theme,
// English, or this device's earlier answers.
// (lang 'ko' by default: the screen language follows the account across devices — F-IN-09's English stays on its own account)
async function open(browser, as, { ua, area, viewport = PHONE, standalone = false, iosStandalone = false, desktopMark = false, theme, lang = 'ko', memo } = {}) {
  const phone = viewport.width <= 760
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: phone ? 2 : 1, userAgent: ua, locale: 'ko-KR', baseURL: ORIGIN, ...(phone ? { isMobile: true, hasTouch: true } : {}) })
  if (area) {
    const c = await as(area)
    await ctx.addInitScript((s) => { if (window.top === window) localStorage.setItem('pgpt-pro-session', s) }, JSON.stringify(c.s))
  }
  await ctx.addInitScript(({ theme, lang, memo }) => {
    if (window.top !== window) return
    try {
      if (theme) localStorage.setItem('pgpt-pro-theme', theme)
      if (lang) localStorage.setItem('pgl-lang', lang)
      if (memo) localStorage.setItem('pgl-install', JSON.stringify(memo))
    } catch { /* opaque origin */ }
  }, { theme, lang, memo })
  if (standalone) {
    await ctx.addInitScript(() => {
      const orig = window.matchMedia.bind(window)
      window.matchMedia = (q) => (/display-mode:\s*standalone/.test(q)
        ? { matches: true, media: q, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false }
        : orig(q))
    })
  }
  if (iosStandalone) await ctx.addInitScript(() => { Object.defineProperty(Navigator.prototype, 'standalone', { get: () => true, configurable: true }) })
  // like the desktop app's preload: <html> may not exist yet — mark it the moment it is inserted
  if (desktopMark) {
    await ctx.addInitScript(() => {
      const mark = () => { const el = document.documentElement; if (!el) return false; el.classList.add('pgl-desktop'); return true }
      if (!mark()) new MutationObserver((_, o) => { if (mark()) o.disconnect() }).observe(document, { childList: true })
    })
  }
  const page = await ctx.newPage()
  if (BASE_PATH) {
    const go = page.goto.bind(page)
    page.goto = (u, o) => go(typeof u === 'string' && u.startsWith('/') && !u.startsWith(`${BASE_PATH}/`) ? BASE_PATH + u : u, o)
  }
  page.errors = []
  page.on('pageerror', (e) => page.errors.push(String(e?.message || e)))
  return { ctx, page }
}

// Chrome's install offer, as the browser would send it; window.__prompted counts prompt() calls
async function offer(page, outcome = 'accepted') {
  await page.evaluate((outcome) => {
    const e = new Event('beforeinstallprompt', { cancelable: true })
    window.__prompted = 0
    e.prompt = () => { window.__prompted++; return Promise.resolve() }
    e.userChoice = Promise.resolve({ outcome, platform: 'web' })
    window.__offer = e
    window.dispatchEvent(e)
  }, outcome)
}
const memoOf = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('pgl-install') || '{}'))
const card = (page) => page.locator('[data-test="install-nudge"]')
// the sign-in screen is the first thing a shared link shows
const toLogin = async (page, q = '') => { await page.goto(`/login${q}`); await expect(page.locator('.login .inner')).toBeVisible() }
const toHome = async (page, q = '') => { await page.goto(`/chat${q}`); await expect(page.locator('aside.dock')).toBeVisible({ timeout: 30_000 }) }
const SHOTS = process.env.RT_SHOT_DIR

test.describe('앱 설치 안내', () => {
  test('F-IN-01 Android Chrome, 로그인 화면: 브라우저가 설치를 제안하면 「앱 설치」가 나오고, 누르면 브라우저의 설치 창(prompt)을 연다', async ({ browser, as }) => {
    const { ctx, page } = await open(browser, as, { ua: UA.androidChrome })
    try {
      await toLogin(page)
      // no offer from the browser yet: nothing to press
      await expect(card(page)).toHaveCount(0)
      await offer(page)
      await expect(card(page)).toBeVisible()
      await expect(card(page)).toHaveAttribute('data-kind', 'prompt')
      await expect(card(page)).toContainText('앱으로 설치하기')
      // ours to show: the browser's own install bar is held back
      expect(await page.evaluate(() => window.__offer.defaultPrevented)).toBe(true)
      await page.locator('[data-test="install-go"]').click()
      await expect.poll(() => page.evaluate(() => window.__prompted)).toBe(1)
      // installed: the card goes, and the device remembers
      await expect(card(page)).toHaveCount(0)
      expect((await memoOf(page)).installedAt).toBeGreaterThan(0)
      expect(page.errors).toEqual([])
    } finally { await ctx.close() }
  })

  test('F-IN-02 Android Chrome, Home: 로그인 뒤 Home 카드 — 설치 창에서 취소하면 7일 동안 다시 나오지 않는다', async ({ browser, as }) => {
    const { ctx, page } = await open(browser, as, { ua: UA.androidChrome, area: 'install' })
    try {
      await toHome(page)
      await offer(page, 'dismissed')
      const c = page.locator('aside.dock [data-test="install-nudge"]')
      await expect(c).toBeVisible()
      await c.locator('[data-test="install-go"]').click()
      await expect.poll(() => page.evaluate(() => window.__prompted)).toBe(1)
      await expect(c).toHaveCount(0)
      const m = await memoOf(page)
      expect(m.installedAt || null).toBeNull()
      expect(m.snoozeUntil - Date.now()).toBeGreaterThan(6.9 * 86_400_000)
      // the next visit, the browser offers again: still asleep
      await page.reload()
      await expect(page.locator('aside.dock')).toBeVisible()
      await offer(page)
      await page.waitForTimeout(300)
      await expect(c).toHaveCount(0)
      expect(page.errors).toEqual([])
    } finally { await ctx.close() }
  })

  test('F-IN-03 iPhone Safari: 설치 API가 없으니 공유 › 「홈 화면에 추가」 › 「추가」 순서를 보여 준다', async ({ browser, as }) => {
    const { ctx, page } = await open(browser, as, { ua: UA.iosSafari })
    try {
      await toLogin(page)
      await expect(card(page)).toBeVisible()
      await expect(card(page)).toHaveAttribute('data-kind', 'ios')
      await expect(card(page)).toContainText('홈 화면에 추가하기')
      // the sign-in screen: the short way, in one line
      await expect(page.locator('[data-test="install-ios-path"] .chip')).toHaveText(['공유', '홈 화면에 추가', '추가'])
      await expect(card(page)).toContainText('⋯')
      // nothing to call on iOS
      await expect(page.locator('[data-test="install-go"]')).toHaveCount(0)
      // a short phone screen (the browser's bars take part of it): the card and the sign-in buttons can be scrolled to, nothing is cut off
      await page.setViewportSize({ width: 375, height: 548 })
      await page.locator('[data-test="install-later"]').scrollIntoViewIfNeeded()
      await expect(page.locator('[data-test="install-later"]')).toBeInViewport()
      await page.locator('.login .inner .wm').scrollIntoViewIfNeeded()
      await expect(page.locator('.login .inner .wm')).toBeInViewport()
      expect(page.errors).toEqual([])
    } finally { await ctx.close() }
  })

  test('F-IN-03b iPhone Safari, Home: 단계마다 한 줄 — 공유 › 「홈 화면에 추가」 › 「추가」', async ({ browser, as }) => {
    const { ctx, page } = await open(browser, as, { ua: UA.iosSafari, area: 'install' })
    try {
      await toHome(page)
      const steps = page.locator('aside.dock [data-test="install-ios-steps"] li')
      await expect(steps).toHaveCount(3)
      await expect(steps.nth(0)).toContainText('공유 버튼을 누르세요.')
      await expect(steps.nth(1)).toContainText('「홈 화면에 추가」를 누르세요.')
      await expect(steps.nth(2)).toContainText('「추가」')
      expect(page.errors).toEqual([])
    } finally { await ctx.close() }
  })

  test('F-IN-04 카카오톡 안의 브라우저: 설치할 수 없다고 알리고, 같은 주소(경로·쿼리 그대로)를 Chrome / Safari로 여는 링크를 준다', async ({ browser, as }) => {
    // Android: an intent for Chrome (the default browser when there is no Chrome)
    {
      const { ctx, page } = await open(browser, as, { ua: UA.kakaoAndroid })
      try {
        await toLogin(page, '?from=kakao')
        await expect(card(page)).toHaveAttribute('data-kind', 'inapp')
        await expect(card(page)).toContainText('카카오톡 안의 브라우저에서는 앱을 설치할 수 없어요.')
        const a = page.locator('[data-test="install-open"]')
        await expect(a).toHaveText('Chrome에서 열기')
        const here = new URL(page.url())
        expect(here.pathname).toBe(`${BASE_PATH}/login`)
        expect(await a.getAttribute('href')).toBe(`intent://${here.host}${here.pathname}?from=kakao#Intent;scheme=${here.protocol.replace(':', '')};package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(here.href)};end`)
        expect(page.errors).toEqual([])
      } finally { await ctx.close() }
    }
    // iPhone: KakaoTalk's own "open outside" address
    {
      const { ctx, page } = await open(browser, as, { ua: UA.kakaoIos })
      try {
        await toLogin(page, '?from=kakao')
        const a = page.locator('[data-test="install-open"]')
        await expect(a).toHaveText('Safari에서 열기')
        expect(await a.getAttribute('href')).toBe(`kakaotalk://web/openExternal?url=${encodeURIComponent(page.url())}`)
      } finally { await ctx.close() }
    }
    // another iPhone app (no link can leave it): its ⋯ menu, and the address to copy
    {
      const { ctx, page } = await open(browser, as, { ua: UA.instagramIos })
      try {
        await toLogin(page)
        await expect(card(page)).toContainText('인스타그램 안의 브라우저에서는 앱을 설치할 수 없어요.')
        await expect(card(page)).toContainText('「Safari로 열기」')
        await expect(page.locator('[data-test="install-open"]')).toHaveCount(0)
        await expect(page.locator('[data-test="install-copy"]')).toHaveText('주소 복사')
      } finally { await ctx.close() }
    }
  })

  test('F-IN-05 설치된 앱 안(standalone · iOS 홈 화면 · Android 래퍼 · 데스크톱 앱)에서는 아무것도 보이지 않는다', async ({ browser, as }) => {
    const cases = [
      ['standalone', { ua: UA.androidChrome, standalone: true }],
      ['iOS 홈 화면', { ua: UA.iosSafari, iosStandalone: true }],
      ['Android 래퍼', { ua: UA.wrapper }],
      ['데스크톱 앱', { ua: UA.macChrome, desktopMark: true, viewport: { width: 1280, height: 800 } }],
    ]
    for (const [name, o] of cases) {
      const { ctx, page } = await open(browser, as, { ...o, area: 'install' })
      try {
        await toHome(page)
        await offer(page)
        await page.waitForTimeout(300)
        await expect(card(page), name).toHaveCount(0)
        await page.goto('/login')
        await expect(page.locator('.login .inner')).toBeVisible()
        await offer(page)
        await page.waitForTimeout(300)
        await expect(card(page), name).toHaveCount(0)
        // and no settings row either
        await page.goto('/settings')
        await expect(page.locator('.settings button.danger')).toBeVisible()
        await expect(page.locator('[data-test="install-app"]'), name).toHaveCount(0)
        expect(page.errors, name).toEqual([])
      } finally { await ctx.close() }
    }
  })

  test('F-IN-06 「나중에」는 7일, 「다시 보지 않기」는 계속 — 이 기기에 기억하고, 설정 › 앱 설치는 언제든 열린다', async ({ browser, as }) => {
    const { ctx, page } = await open(browser, as, { ua: UA.iosSafari, area: 'install' })
    try {
      await toHome(page)
      const c = page.locator('aside.dock [data-test="install-nudge"]')
      await expect(c).toBeVisible()
      await c.locator('[data-test="install-later"]').click()
      await expect(c).toHaveCount(0)
      let m = await memoOf(page)
      expect(m.snoozeUntil - Date.now()).toBeGreaterThan(6.9 * 86_400_000)
      expect(m.snoozeUntil - Date.now()).toBeLessThan(7.1 * 86_400_000)
      await page.reload()
      await expect(page.locator('aside.dock')).toBeVisible()
      await page.waitForTimeout(300)
      await expect(c).toHaveCount(0)
      // the 7 days are over
      await page.evaluate(() => localStorage.setItem('pgl-install', JSON.stringify({ snoozeUntil: Date.now() - 1000 })))
      await page.reload()
      await expect(c).toBeVisible()
      await c.locator('[data-test="install-never"]').click()
      await expect(c).toHaveCount(0)
      m = await memoOf(page)
      expect(m.never).toBe(true)
      await page.reload()
      await expect(page.locator('aside.dock')).toBeVisible()
      await page.waitForTimeout(300)
      await expect(c).toHaveCount(0)
      // the sign-in screen too (same device)
      await page.goto('/login')
      await expect(page.locator('.login .inner')).toBeVisible()
      await expect(card(page)).toHaveCount(0)
      // settings › 앱 설치: still there, opens the steps
      await page.goto('/settings')
      await page.locator('[data-test="install-app"]').click()
      const sheet = page.locator('.veil [data-test="install-nudge"]')
      await expect(sheet).toBeVisible()
      await expect(sheet).toHaveAttribute('data-kind', 'ios')
      await expect(sheet.locator('[data-test="install-later"]')).toHaveCount(0)
      await sheet.locator('[data-test="install-close"]').click()
      await expect(sheet).toHaveCount(0)
      expect(page.errors).toEqual([])
    } finally { await ctx.close() }
  })

  test('F-IN-07 설정 › 앱 설치: 제안이 없으면 브라우저 메뉴(⋮)로 가는 길, 제안이 오면 「앱 설치」 — 컴퓨터는 로그인 화면에 띄우지 않는다', async ({ browser, as }) => {
    {
      const { ctx, page } = await open(browser, as, { ua: UA.androidChrome, area: 'install' })
      try {
        await page.goto('/settings')
        await page.locator('[data-test="install-app"]').click()
        const sheet = page.locator('.veil [data-test="install-nudge"]')
        await expect(sheet).toHaveAttribute('data-kind', 'menu')
        await expect(sheet).toContainText('브라우저 메뉴(⋮)에서 「앱 설치」나 「홈 화면에 추가」를 누르세요.')
        await offer(page)
        await expect(sheet).toHaveAttribute('data-kind', 'prompt')
        await sheet.locator('[data-test="install-go"]').click()
        await expect.poll(() => page.evaluate(() => window.__prompted)).toBe(1)
        await expect(sheet).toHaveCount(0)
        expect(page.errors).toEqual([])
      } finally { await ctx.close() }
    }
    // installed on this device before (and the browser offers nothing): how to open it first
    {
      const { ctx, page } = await open(browser, as, { ua: UA.androidChrome, area: 'install', memo: { installedAt: Date.now() - 86_400_000 } })
      try {
        await page.goto('/settings')
        await page.locator('[data-test="install-app"]').click()
        const sheet = page.locator('.veil [data-test="install-nudge"]')
        await expect(sheet).toContainText('이미 설치했어요')
        await expect(sheet).toContainText('홈 화면이나 앱 목록의 Process GPT 아이콘을 누르세요.')
        await expect(sheet).toContainText('브라우저 메뉴(⋮)')
      } finally { await ctx.close() }
    }
    {
      const { ctx, page } = await open(browser, as, { ua: UA.macChrome, area: 'install', viewport: { width: 1280, height: 800 } })
      try {
        await toHome(page)
        await offer(page)
        const c = page.locator('aside.dock [data-test="install-nudge"]')
        await expect(c).toBeVisible()
        await expect(c).toContainText('브라우저 탭 없이 별도 창으로 열려요.')
        await page.goto('/login')
        await expect(page.locator('.login .inner')).toBeVisible()
        await offer(page)
        await page.waitForTimeout(300)
        await expect(card(page)).toHaveCount(0)
      } finally { await ctx.close() }
    }
  })

  test('F-IN-08 링크 미리보기: 페이지를 실행하지 않고 읽는 HTML에 og:/twitter: 태그 — 절대 주소, 1200×630 그림', async () => {
    const r = await fetch(`${PGPT_URL}/`, { headers: { 'User-Agent': 'facebookexternalhit/1.1 kakaotalk-scrap/1.0' } })
    expect(r.status).toBe(200)
    const html = await r.text()
    const meta = {}
    for (const m of html.matchAll(/<meta\s+(?:property|name)="([^"]+)"\s+content="([^"]*)"/g)) meta[m[1]] = m[2]
    for (const k of ['og:title', 'og:description', 'og:image', 'og:site_name', 'og:locale', 'twitter:card', 'twitter:image', 'description']) expect(meta[k], k).toBeTruthy()
    expect(meta['twitter:card']).toBe('summary_large_image')
    expect(meta['og:locale']).toBe('ko_KR')
    expect(meta['og:image']).toMatch(/^https?:\/\/[^/]+\/.*og-image\.png$/)
    // og:url is left out on purpose: the gateway does not pass the company's own host (spec install-nudge)
    expect(meta['og:url']).toBeUndefined()
    expect(html).not.toContain('__PGL_PUBLIC_URL__')
    // the picture itself, from this server (the absolute address names the public host)
    const img = await fetch(`${PGPT_URL}/og-image.png`)
    expect(img.status).toBe(200)
    const b = Buffer.from(await img.arrayBuffer())
    expect(b.subarray(1, 4).toString()).toBe('PNG')
    expect([b.readUInt32BE(16), b.readUInt32BE(20)]).toEqual([1200, 630])
  })

  test('F-IN-09 영어 화면: 카드 문구가 모두 번역된다', async ({ browser, as }) => {
    for (const ua of [UA.iosSafari, UA.kakaoAndroid, UA.instagramIos]) {
      const { ctx, page } = await open(browser, as, { ua, lang: 'en' })
      try {
        await toLogin(page)
        await expect(card(page)).toBeVisible()
        await page.waitForTimeout(400)
        const text = await card(page).innerText()
        expect(text, ua).not.toMatch(/[가-힣]/)
      } finally { await ctx.close() }
    }
    const { ctx, page } = await open(browser, as, { ua: UA.androidChrome, lang: 'en', area: 'install-en' })
    try {
      await toHome(page)
      await offer(page)
      await expect(page.locator('aside.dock [data-test="install-nudge"]')).toContainText('Install')
      await page.waitForTimeout(400)
      expect(await page.locator('aside.dock [data-test="install-nudge"]').innerText()).not.toMatch(/[가-힣]/)
      await page.goto('/settings')
      await expect(page.locator('[data-test="install-app"]')).toContainText('Install app')
    } finally { await ctx.close() }
  })

  test('F-IN-10 화면 사진 (휴대폰 390×844, 밝은 · 어두운 테마)', async ({ browser, as }) => {
    test.skip(!SHOTS, 'RT_SHOT_DIR 을 줄 때만')
    fs.mkdirSync(SHOTS, { recursive: true })
    for (const theme of ['light', 'dark']) {
      // the sky follows the time of day (?hour=): daytime for the light theme, night for the dark one
      const hour = theme === 'light' ? '?hour=13' : '?hour=22'
      const shots = [
        ['login-android-chrome', { ua: UA.androidChrome }, async (page) => { await toLogin(page, hour); await offer(page) }],
        ['login-iphone-safari', { ua: UA.iosSafari }, (page) => toLogin(page, hour)],
        ['login-kakaotalk-android', { ua: UA.kakaoAndroid }, (page) => toLogin(page, hour)],
        ['login-kakaotalk-iphone', { ua: UA.kakaoIos }, (page) => toLogin(page, hour)],
        ['login-instagram-iphone', { ua: UA.instagramIos }, (page) => toLogin(page, hour)],
        ['home-android-chrome', { ua: UA.androidChrome, area: 'install' }, async (page) => { await toHome(page, hour); await offer(page) }],
        ['home-iphone-safari', { ua: UA.iosSafari, area: 'install' }, (page) => toHome(page, hour)],
        ['settings-sheet-iphone', { ua: UA.iosSafari, area: 'install', memo: { never: true } }, async (page) => {
          await page.goto(`/settings${hour}`); await page.locator('[data-test="install-app"]').click()
        }],
        ['settings-sheet-android-menu', { ua: UA.androidChrome, area: 'install' }, async (page) => {
          await page.goto(`/settings${hour}`); await page.locator('[data-test="install-app"]').click()
        }],
        ['home-mac-chrome', { ua: UA.macChrome, area: 'install', viewport: { width: 1280, height: 800 } }, async (page) => { await toHome(page, hour); await offer(page) }],
      ]
      for (const [name, o, go] of shots) {
        const { ctx, page } = await open(browser, as, { ...o, theme })
        try {
          await go(page)
          await expect(card(page)).toBeVisible()
          await page.waitForTimeout(1200)
          await page.screenshot({ path: `${SHOTS}/${name}-${theme}.png` })
        } finally { await ctx.close() }
      }
    }
  })
})
