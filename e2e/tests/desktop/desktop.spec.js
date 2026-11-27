// Process GPT Lite desktop app (desktop/, Electron) driven by Playwright's _electron — spec openspec/specs/desktop-app.
// The app runs from desktop/ (npm install there first) against the stack PGPT_URL points at, through a TCP relay this
// file opens: the app's server is http://localhost:<relay>, and closing the relay is the server going away (D-06).
// Screenshots (normal and phone width, light and dark) go to openspec/specs/desktop-app/e2e/results/.
//   cd e2e && PGPT_URL=http://localhost:5211 API_URL=http://127.0.0.1:8791 npx playwright test --project=desktop
import { test, expect } from '../../lib/fixtures.js'
import { _electron } from '@playwright/test'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGPT_URL, email } from '../../lib/env.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const DESKTOP = path.resolve(here, '../../../desktop')
const SHOTS = path.resolve(here, '../../../openspec/specs/desktop-app/e2e/results')
// PGL_DESKTOP_EXE: a packed app instead (desktop/release/mac-arm64/Process GPT Lite.app/Contents/MacOS/Process GPT Lite)
const PACKED = process.env.PGL_DESKTOP_EXE || ''
let ELECTRON = PACKED
if (!ELECTRON) try { ELECTRON = createRequire(path.join(DESKTOP, 'package.json'))('electron') } catch { /* not installed */ }
const ARGS = PACKED ? [] : [DESKTOP]
const MAC = process.platform === 'darwin'
// main.js: traffic lights at (20, 27), three 14px buttons 23px apart → they end at x 80, y 41
const LIGHTS = { x: 20, y: 27, right: 80, bottom: 41 }
const ACCOUNT = email('desktop')

test.describe.configure({ mode: 'serial' })
test.skip(!ELECTRON || !fs.existsSync(ELECTRON), 'desktop/ 에 Electron 이 없음 (cd desktop && npm install) — 또는 PGL_DESKTOP_EXE')

// ---- a TCP relay in front of the web app: the server the desktop app is given ----
const target = new URL(PGPT_URL)
let relay = null
const sockets = new Set()
let relayPort = 0
function openRelay(port = 0) {
  return new Promise((ok, fail) => {
    relay = net.createServer((c) => {
      const up = net.connect({ port: Number(target.port || 80), host: target.hostname, autoSelectFamily: true }) // (Vite listens on ::1 only)
      for (const s of [c, up]) { sockets.add(s); s.on('close', () => sockets.delete(s)); s.on('error', () => {}) }
      c.pipe(up).pipe(c)
    })
    relay.once('error', fail)
    relay.listen(port, '127.0.0.1', () => { relayPort = relay.address().port; ok(relayPort) })
  })
}
function closeRelay() {
  return new Promise((ok) => { for (const s of sockets) s.destroy(); sockets.clear(); if (!relay) return ok(); relay.close(() => ok()); relay = null })
}
const serverOf = () => `http://localhost:${relayPort}`

// ---- the app ----
let userData = '' // a fresh profile, made in beforeAll (not when the runner only lists the tests)
let app = null
let page = null
const errors = []
async function launch() {
  const env = { ...process.env, PGL_DESKTOP_USER_DATA: userData, PGL_DESKTOP_EXTERNAL: 'log' }
  delete env.ELECTRON_RUN_AS_NODE // set in some terminals: Electron would run as plain Node
  app = await _electron.launch({ executablePath: ELECTRON, args: ARGS, env, timeout: 60_000 })
  page = await app.firstWindow()
  page.on('pageerror', (e) => errors.push(String(e?.message || e)))
  return page
}
// the main window: the first one the app made (a window a page opens comes later)
const mainWin = (fn, arg) => app.evaluate(({ BrowserWindow }, [src, a]) => {
  const w = BrowserWindow.getAllWindows().sort((x, y) => x.id - y.id)[0]
  // eslint-disable-next-line no-new-func
  return new Function('w', 'a', `return (${src})(w, a)`)(w, a)
}, [fn.toString(), arg])
const windows = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
const opened = () => app.evaluate(() => global.__pglExternal || [])
const settingsFile = () => JSON.parse(fs.readFileSync(path.join(userData, 'desktop-settings.json'), 'utf8'))
async function size(width, height) {
  await mainWin((w, a) => { w.setContentSize(a[0], a[1]) }, [width, height])
  await page.waitForFunction(([wd]) => window.innerWidth === wd, [width])
  await page.waitForTimeout(700)
}
// light: the sky at 13:00, dark: at 22:00 (the web app's own ?hour= preview, theme following the sun)
async function theme(t, sub = '/chat') {
  await page.evaluate(() => localStorage.setItem('pgpt-pro-theme', 'auto'))
  await page.goto(`${serverOf()}${sub}?hour=${t === 'light' ? 13 : 22}`)
  await page.waitForFunction((v) => document.documentElement.dataset.theme === v, t)
  await page.waitForSelector('header.top')
  await page.waitForTimeout(1500) // the sky eases in
}
const shot = (name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`), scale: 'css' })

test.beforeAll(async () => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pgl-desktop-e2e-'))
  fs.mkdirSync(SHOTS, { recursive: true })
  await openRelay()
})
test.afterAll(async () => {
  await app?.close().catch(() => {})
  await closeRelay()
  if (userData) fs.rmSync(userData, { recursive: true, force: true })
})

test('D-01 첫 실행: 서버를 묻고, 확인한 뒤 기억한다', async () => {
  await launch()
  await expect(page.locator('[data-test=setup]')).toBeVisible()
  // the page is marked for the title bar
  const mark = await page.evaluate(() => ({ cls: [...document.documentElement.classList], left: getComputedStyle(document.documentElement).getPropertyValue('--pgl-tb-left').trim() }))
  expect(mark.cls).toContain('pgl-desktop')
  if (MAC) expect(mark.left).toBe(`${LIGHTS.right}px`)
  // nothing there: said on the page, nothing saved
  await page.fill('[data-test=server-url]', 'localhost:1')
  await page.click('[data-test=setup-connect]')
  await expect(page.locator('[data-test=setup-status]')).toHaveText(/연결하지 못했어요/)
  expect(fs.existsSync(path.join(userData, 'desktop-settings.json')) ? settingsFile().server : undefined).toBeFalsy()
  // a page address copied from a browser: its base is kept
  await shot('d01-setup-dark')
  await page.click('[data-test=pick-local]')
  await expect(page.locator('[data-test=server-url]')).toHaveValue('http://localhost:18080')
  await page.fill('[data-test=server-url]', `localhost:${relayPort}/chat`)
  await page.click('[data-test=setup-connect]')
  await page.waitForURL(`${serverOf()}/login`)
  expect(settingsFile().server).toBe(serverOf())
})

test('D-02 로그인: 이메일 코드로 창 안에서', async ({ as }) => {
  await as('desktop') // the test account exists and is onboarded
  await expect(page.locator('.login')).toBeVisible()
  if (MAC) {
    // the picture starts below the traffic lights
    const top = await page.locator('.login .media').evaluate((el) => el.getBoundingClientRect().top)
    expect(top).toBeGreaterThan(LIGHTS.bottom)
  }
  await page.waitForTimeout(800)
  await shot('d02-login')
  await page.fill('input[type=email]', ACCOUNT)
  await page.getByRole('button', { name: '계속', exact: true }).click()
  await page.locator('.code input').first().waitFor()
  await page.locator('.code input').first().fill('000000')
  await page.waitForURL(`${serverOf()}/chat`)
  await expect(page.locator('header.top')).toBeVisible()
})

test('D-03 채팅 · 루틴 · 폴더 화면이 열린다', async () => {
  const tab = (id) => page.locator(`header.top .seg button[data-tab="${id}"]`)
  await tab('routine').click()
  await page.waitForURL(/\/(process-map|routines)/)
  await tab('folders').click()
  await page.waitForURL(/\/folders/)
  await expect(page.locator('header.top')).toBeVisible()
  await tab('chat').click()
  await page.waitForURL(/\/chat/)
  await expect(page.locator('.composer textarea').first()).toBeVisible()
  expect(errors, errors.join(' | ')).toEqual([])
})

test('D-04 제목 영역: 신호등이 메뉴와 겹치지 않고, 위 띠가 창을 끌고, 단추는 눌린다 (넓은 · 좁은 폭, 밝음 · 어두움)', async () => {
  if (MAC) {
    const pos = await mainWin((w) => w.getWindowButtonPosition())
    expect(pos).toEqual({ x: LIGHTS.x, y: LIGHTS.y })
  }
  const measure = () => page.evaluate(() => {
    const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom } }
    const region = (el, pseudo) => getComputedStyle(el, pseudo).getPropertyValue('app-region') || getComputedStyle(el, pseudo).getPropertyValue('-webkit-app-region')
    const top = document.querySelector('header.top')
    const btns = [...top.querySelectorAll('button')].filter((b) => b.offsetParent)
    return {
      home: r(top.querySelector('button.home')),
      seg: r(top.querySelector('.seg')),
      avatar: r(top.querySelector('button.avatar')),
      strip: { region: region(document.body, '::before'), height: getComputedStyle(document.body, '::before').height },
      buttonsNoDrag: btns.every((b) => region(b) === 'no-drag'),
      navNoDrag: region(top.querySelector('.seg')) === 'no-drag',
    }
  })
  const clear = (m) => {
    // nothing clickable over the traffic lights (x 20..80, y 27..41)
    for (const k of ['home', 'seg']) {
      const b = m[k]
      const overlaps = b.l < LIGHTS.right && b.r > LIGHTS.x && b.t < LIGHTS.bottom && b.b > LIGHTS.y
      expect(overlaps, `${k} ${JSON.stringify(b)} over the traffic lights`).toBe(false)
    }
    expect(m.strip).toEqual({ region: 'drag', height: '68px' })
    expect(m.buttonsNoDrag).toBe(true)
    expect(m.navNoDrag).toBe(true)
  }
  for (const t of ['light', 'dark']) {
    await size(1280, 800)
    await theme(t)
    // the window background follows the theme (no white flash at the next start)
    const bg = await mainWin((w) => w.getBackgroundColor())
    expect(bg.toLowerCase()).toBe(t === 'light' ? '#4670ad' : '#0a0f24')
    let m = await measure()
    if (MAC) { clear(m); expect(m.home.l).toBeGreaterThanOrEqual(LIGHTS.right + 12) }
    await shot(`d04-chat-wide-${t}`)
    // a click on a button in the strip still works
    await page.locator('header.top button.home').click()
    await page.waitForTimeout(400)
    await page.locator('header.top button.home').click()
    // phone width (≤760px: the mobile layout with the scrolling pill)
    await size(600, 800)
    await expect(page.locator('header.top.narrow')).toBeVisible()
    m = await measure()
    if (MAC) { clear(m); expect(m.seg.l).toBeGreaterThanOrEqual(LIGHTS.right + 12 + 56) }
    expect(m.seg.r).toBeLessThanOrEqual(m.avatar.l)
    await shot(`d04-chat-narrow-${t}`)
  }
  await size(1280, 800)
  // pages without the top bar keep a thinner strip (the settings sheet)
  await page.locator('header.top button.avatar').click()
  await page.waitForURL(/\/settings/)
  await expect(page.locator('.settings')).toBeVisible()
  await page.waitForTimeout(600)
  expect(await page.evaluate(() => getComputedStyle(document.body, '::before').height)).toBe('40px')
  await shot('d04-settings')
  await page.locator('.settings > .x').click()
  await page.waitForURL(/\/chat/)
})

test('D-05 다른 사이트 · 메일 링크는 창 밖(시스템 브라우저)에서, 같은 서버의 새 창은 창으로', async () => {
  const before = (await opened()).length
  await page.evaluate(() => {
    for (const [id, href, target] of [['x-blank', 'https://example.com/desktop-e2e', '_blank'], ['x-self', 'https://example.org/desktop-e2e', ''], ['x-mail', 'mailto:someone@example.com', '']]) {
      const a = Object.assign(document.createElement('a'), { id, href, textContent: id })
      if (target) a.target = target
      a.style.cssText = 'position:fixed;left:200px;bottom:200px;z-index:99999'
      document.body.append(a)
    }
  })
  for (const id of ['x-blank', 'x-self', 'x-mail']) {
    await page.evaluate((i) => document.getElementById(i).click(), id)
    await page.waitForTimeout(500)
  }
  expect((await opened()).slice(before)).toEqual(['https://example.com/desktop-e2e', 'https://example.org/desktop-e2e', 'mailto:someone@example.com'])
  expect(page.url()).toMatch(new RegExp(`^${serverOf()}/chat`))
  expect(await windows()).toBe(1)
  // a file of the same server opened in a new window (원본 받기, 문서 링크): an ordinary window, closed again
  await page.evaluate(() => window.open('/api/config', '_blank'))
  await expect.poll(windows).toBe(2)
  // (once its page is in: /api/config can take a few seconds to answer — the window has no address until then)
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w) => w.webContents.getURL().includes('/api/config'))), { timeout: 15_000 }).toBe(true)
  await app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) if (w.webContents.getURL().includes('/api/config')) w.close() })
  await expect.poll(windows).toBe(1)
  await page.evaluate(() => document.querySelectorAll('#x-blank,#x-self,#x-mail').forEach((a) => a.remove()))
})

test('D-06 서버가 응답하지 않으면 연결 실패 화면, 다시 시도로 돌아온다', async () => {
  await closeRelay()
  await mainWin((w) => w.webContents.reload())
  await expect(page.locator('[data-test=offline]')).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('[data-test=offline-url]')).toContainText(serverOf())
  await shot('d06-offline-dark')
  await openRelay(relayPort)
  await page.click('[data-test=offline-retry]')
  await page.waitForURL(new RegExp(`^${serverOf()}/chat`))
  await expect(page.locator('header.top')).toBeVisible()
})

test('D-07 알림 · 아이콘 숫자 · 메뉴', async () => {
  const n = await page.evaluate(() => { try { new Notification('desktop e2e', { body: 'x', silent: true }).close(); return Notification.permission } catch (e) { return String(e) } })
  expect(n).toBe('granted')
  await page.evaluate(() => navigator.setAppBadge(3))
  expect(await app.evaluate(({ app: a }) => a.getBadgeCount())).toEqual(MAC ? 3 : expect.any(Number))
  await page.evaluate(() => navigator.clearAppBadge())
  // src/browserNotify.js in the desktop app: a Home card that arrives while the window is in the background is shown
  // with new Notification (Electron shows no service worker notifications); the dev server's module, so skipped on a build
  const shown = await page.evaluate(async () => {
    let m
    try { m = await import('/src/browserNotify.js') } catch { return null }
    const calls = []
    const Real = window.Notification
    window.Notification = class { constructor(t) { calls.push(t) } static get permission() { return 'granted' } close() {} }
    document.hasFocus = () => false
    try {
      m.announce([], () => {}) // (the first load is what was waiting already)
      m.announce([{ id: `desktop-e2e-${Date.now()}`, type: 'chat', from: '동료', title: '안녕하세요' }], () => {})
    } finally { window.Notification = Real; delete document.hasFocus }
    return calls
  })
  if (shown) expect(shown).toEqual(['동료'])
  else test.info().annotations.push({ type: 'skip-part', description: 'browserNotify: 개발 서버가 아니라 건너뜀' })
  // what the server's page gets from the app: read-only facts, none of the local pages' buttons
  expect(await page.evaluate(() => ({ local: typeof window.pglLocal, app: window.pglDesktop?.app, frozen: Object.isFrozen(window.pglDesktop) }))).toEqual({ local: 'undefined', app: 'process-gpt-lite', frozen: true })
  const labels = await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.map((i) => i.label))
  expect(labels).toEqual(expect.arrayContaining(['편집', '보기', '이동', '윈도우', '도움말']))
  const view = await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.find((i) => i.label === '보기').submenu.items.map((i) => [i.label, i.accelerator || '']))
  expect(view).toEqual(expect.arrayContaining([['새로 고침', 'CmdOrCtrl+R'], ['확대', expect.any(String)]]))
  // developer tools only in development (npm start), not in the packed app
  if (PACKED) expect(view.map((v) => v[0])).not.toContain('개발자 도구')
  else expect(view.map((v) => v[0])).toContain('개발자 도구')
  // the web app in English: the menu follows
  await page.evaluate(() => localStorage.setItem('pgl-lang', 'en'))
  await page.reload()
  await expect.poll(() => app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.map((i) => i.label))).toEqual(expect.arrayContaining(['Edit', 'View', 'Go', 'Window', 'Help']))
  await page.evaluate(() => localStorage.setItem('pgl-lang', 'ko'))
  await page.reload()
  await expect.poll(() => app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.map((i) => i.label))).toEqual(expect.arrayContaining(['편집']))
})

test('D-08 Google 로그인은 창 안에서 Google 계정 화면으로 간다', async () => {
  const cfg = await page.evaluate(() => fetch('/api/config').then((r) => r.json()))
  test.skip(!cfg.googleLogin, '이 서버에는 Google 로그인이 없음')
  // a second profile of the app is not needed: sign out in this one, then back in afterwards
  // (0.2.6: the app keeps the sign-in sealed — window.pglDesktop.session — not in the page's storage)
  await page.evaluate(() => { window.pglDesktop.session?.clear?.(); localStorage.removeItem('pgpt-pro-session'); location.href = '/login' })
  await page.waitForURL(`${serverOf()}/login`)
  const before = (await opened()).length
  await page.getByRole('button', { name: /Google로 계속하기/ }).click()
  const reached = await page.waitForURL(/^https:\/\/accounts\.google\.com\//, { timeout: 20_000 }).then(() => true).catch(() => false)
  // no network to Google: the connection-failure page names it (the window still tried in place)
  if (!reached && await page.locator('[data-test=offline-url]').textContent().then((t) => /accounts\.google\.com/.test(t)).catch(() => false)) test.skip(true, 'Google 에 닿지 않음 (네트워크)')
  expect(reached, page.url()).toBe(true)
  expect((await opened()).length).toBe(before) // not handed to the system browser
  await page.goto(`${serverOf()}/login`)
  await page.fill('input[type=email]', ACCOUNT)
  await page.getByRole('button', { name: '계속', exact: true }).click()
  await page.locator('.code input').first().fill('000000')
  await page.waitForURL(`${serverOf()}/chat`)
})

test('D-09 하나만 뜨고(두 번째 실행은 첫 창으로), 창 크기·자리를 기억한다', async () => {
  // a second start with the same profile hands over to this one and ends
  const env = { ...process.env, PGL_DESKTOP_USER_DATA: userData }
  delete env.ELECTRON_RUN_AS_NODE
  const second = spawn(ELECTRON, ARGS, { env, stdio: 'ignore' })
  const code = await new Promise((ok) => { second.on('exit', (c) => ok(c)); setTimeout(() => { second.kill(); ok('still running') }, 20_000) })
  expect(code).toBe(0)
  expect(await windows()).toBe(1)

  await mainWin((w) => w.setBounds({ x: 140, y: 90, width: 1100, height: 740 }))
  await page.waitForTimeout(800)
  await app.close()
  expect(settingsFile().window).toMatchObject({ x: 140, y: 90, width: 1100, height: 740 })
  await launch()
  // straight to the remembered server, still signed in
  await page.waitForURL(new RegExp(`^${serverOf()}/chat`))
  await expect(page.locator('header.top')).toBeVisible()
  const b = await mainWin((w) => w.getBounds())
  expect(b).toEqual({ x: 140, y: 90, width: 1100, height: 740 })
})

test('D-10 메뉴 「서버 바꾸기…」: 같은 하늘의 고르기 화면, 취소하면 그대로 (밝음)', async () => {
  await theme('light')
  const clickMenu = (label) => app.evaluate(({ Menu }, l) => {
    const find = (items) => { for (const i of items) { if (i.label === l) return i; const sub = i.submenu && find(i.submenu.items); if (sub) return sub } return null }
    find(Menu.getApplicationMenu().items).click()
  }, label)
  await clickMenu('서버 바꾸기…')
  await expect(page.locator('[data-test=setup]')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('light')
  await expect(page.locator('[data-test=server-url]')).toHaveValue(serverOf())
  await page.waitForTimeout(300)
  await shot('d10-setup-light')
  await page.click('[data-test=setup-cancel]')
  await page.waitForURL(new RegExp(`^${serverOf()}/chat`))
  // the connection-failure page in the light theme too (the daytime sky again: the clock may say night)
  await theme('light')
  await closeRelay()
  await mainWin((w) => w.webContents.reload())
  await expect(page.locator('[data-test=offline]')).toBeVisible({ timeout: 20_000 })
  await shot('d10-offline-light')
  await openRelay(relayPort)
  await page.click('[data-test=offline-retry]')
  await page.waitForURL(new RegExp(`^${serverOf()}/chat`))
})

test('D-11 브라우저에서는 아무것도 바뀌지 않는다 (desktop.css 는 html.pgl-desktop 아래에서만)', async ({ pageAs }) => {
  const p = await pageAs('desktop')
  await p.goto('/chat')
  await expect(p.locator('header.top')).toBeVisible()
  const got = await p.evaluate(() => ({
    desktop: document.documentElement.classList.contains('pgl-desktop'),
    pad: getComputedStyle(document.querySelector('header.top')).paddingLeft,
    strip: getComputedStyle(document.body, '::before').content,
    region: getComputedStyle(document.querySelector('header.top button.home')).getPropertyValue('app-region') || 'none',
  }))
  expect(got).toEqual({ desktop: false, pad: '16px', strip: 'none', region: 'none' })
})

// ---- the count of Home cards on the Dock · taskbar · tray (desktop/src/tray.js · badge.js, 0.2.4) ----
// What main shows, read back there: the tray's state (global.__pglTray — the menu bar's number on macOS is the real tray.getTitle()),
// and the Dock's number (app.getBadgeCount — macOS; Windows shows an overlay instead, Linux a number only under Unity).
const trayState = () => app.evaluate(() => global.__pglTray?.state() ?? null)
async function expectCount(n) {
  await expect.poll(async () => (await trayState())?.count).toBe(n)
  if (MAC) expect(await app.evaluate(({ app: a }) => a.getBadgeCount())).toBe(n)
}
const homeOpen = () => page.locator('aside.dock').isVisible()
// the chat's own load of the Home cards (MainView boot → announce) sets the count too: wait for it before setting one
const notificationsLoaded = () => page.waitForResponse((r) => /\/api\/notifications(\?|$)/.test(r.url()), { timeout: 30_000 }).then(() => page.waitForTimeout(300))
async function openChat() {
  const loaded = notificationsLoaded()
  await page.goto(`${serverOf()}/chat`)
  await loaded
  // (the chat is ready — Home's dock and the composer show once the page's boot is done)
  await expect(page.locator('.composer textarea').first()).toBeVisible({ timeout: 30_000 })
}

test('D-12 알림 수: 페이지가 보낸 수가 Dock · 트레이(메뉴 막대 숫자 · 툴팁 · 메뉴)에, 트레이를 누르면 창, 「알림 N개 — 열기」는 Home, 로그아웃하면 0', async () => {
  await openChat()
  // the bridge: the count, and the tray's way to Home (still frozen)
  expect(await page.evaluate(() => [typeof window.pglDesktop.setBadge, typeof window.pglDesktop.onOpenHome, Object.isFrozen(window.pglDesktop)])).toEqual(['function', 'function', true])
  // the tray icon is there from the start
  expect(await trayState()).toMatchObject({ menu: ['열기', expect.any(String), '-', '종료'] })

  await page.evaluate(() => window.pglDesktop.setBadge(3))
  await expectCount(3)
  let st = await trayState()
  expect(st.tooltip).toBe('Process GPT Lite — 알림 3개')
  expect(st.menu).toEqual(['열기', '알림 3개 — 열기', '-', '종료'])
  if (MAC) expect(st.title).toBe(' 3')
  if (process.platform === 'win32') expect(st.overlay).toBe('알림 3개')
  // the web app's own setBadge (src/browserNotify.js, the dev server's module) goes over the same bridge
  const viaApp = await page.evaluate(async () => { try { (await import('/src/browserNotify.js')).setBadge(5); return true } catch { return false } })
  if (viaApp) await expectCount(5)
  else test.info().annotations.push({ type: 'skip-part', description: 'browserNotify: 개발 서버가 아니라 건너뜀' })
  // a fraction comes down to a whole number; anything else is 0
  await page.evaluate(() => window.pglDesktop.setBadge(12.7))
  await expectCount(12)
  if (MAC) expect((await trayState()).title).toBe(' 12')
  await page.evaluate(() => window.pglDesktop.setBadge('many'))
  await expectCount(0)
  st = await trayState()
  expect(st).toMatchObject({ count: 0, tooltip: 'Process GPT Lite', menu: ['열기', '알림 없음', '-', '종료'] })
  if (MAC) expect(st.title).toBe('')

  // the tray's click: the window, shown and in front
  await mainWin((w) => w.hide())
  expect(await mainWin((w) => w.isVisible())).toBe(false)
  await app.evaluate(() => global.__pglTray.tray().emit('click'))
  await expect.poll(() => mainWin((w) => w.isVisible())).toBe(true)

  // 「알림 N개 — 열기」 from another screen (폴더): the chat with Home open
  if (await homeOpen()) await page.locator('header.top button.home').click()
  await expect(page.locator('aside.dock')).toHaveCount(0)
  await page.locator('header.top .seg button[data-tab="folders"]').click()
  await page.waitForURL(/\/folders/)
  await page.evaluate(() => window.pglDesktop.setBadge(2))
  await expectCount(2)
  const back = notificationsLoaded()
  await app.evaluate(() => global.__pglTray.menu().items[1].click())
  await page.waitForURL(/\/chat/)
  await back
  await expect(page.locator('aside.dock')).toBeVisible()
  await page.waitForTimeout(800)
  await shot('d12-home-from-tray')

  // signed out (설정 › 로그아웃): the count was that person's — gone
  await page.evaluate(() => window.pglDesktop.setBadge(4))
  await expectCount(4)
  await page.locator('header.top button.avatar').click()
  await page.waitForURL(/\/settings/)
  await page.locator('.settings .list button.danger', { hasText: '로그아웃' }).click()
  await page.waitForURL(`${serverOf()}/login`)
  await expectCount(0)
  // signed in again for what follows
  await page.fill('input[type=email]', ACCOUNT)
  await page.getByRole('button', { name: '계속', exact: true }).click()
  await page.locator('.code input').first().fill('000000')
  await page.waitForURL(`${serverOf()}/chat`)
})

test('D-13 Home 카드 수: 불러온 카드 수가 숫자가 되고, 카드를 닫으면 줄고, 다 닫으면 지워진다', async ({ as, db, cleanup }) => {
  const u = await as('desktop')
  const tag = `desktop-badge-${Date.now().toString(36)}`
  // only this test's cards on the account's Home (a test account — pro-rt-desktop)
  await db.q(`update notifications set is_checked = true where tenant_id = $1 and user_id = any($2) and coalesce(is_checked, false) = false`, [db.tenant, [u.id, u.email]])
  cleanup(() => db.q('delete from notifications where tenant_id = $1 and title like $2', [db.tenant, `${tag}%`]))
  for (let i = 1; i <= 3; i++) {
    await db.q(`insert into notifications(id, user_id, title, type, description, url, tenant_id) values (gen_random_uuid(), $1, $2, 'mention', $3, $4, $5)`,
      [u.id, `${tag} ${i}`, '회귀: 데스크톱 알림 수', `/pro/mention/${tag}-${i}`, db.tenant])
  }
  await openChat()
  if (!(await homeOpen())) await page.locator('header.top button.home').click()
  // (a card on its way out — the dock's leave transition — is not counted)
  const cards = page.locator('aside.dock [data-test=notice-card]:not(.arc-leave-active)').filter({ hasText: tag })
  await expect(cards).toHaveCount(3)
  await expectCount(3)
  await page.waitForTimeout(600)
  await shot('d13-home-cards')
  // a card put away (✕): the server sends no new list for it — the count follows the cards
  await cards.first().hover()
  await cards.first().locator('[data-test=notice-close]').click()
  await expect(cards).toHaveCount(2)
  await expectCount(2)
  if (MAC) expect((await trayState()).title).toBe(' 2')
  for (const left of [1, 0]) {
    await cards.first().hover()
    await cards.first().locator('[data-test=notice-close]').click()
    await expect(cards).toHaveCount(left)
    await expectCount(left)
  }
  expect((await trayState()).menu[1]).toBe('알림 없음')
  // and stays so after the next load from the server (the cards were put away there too)
  await openChat()
  await expectCount(0)
})
