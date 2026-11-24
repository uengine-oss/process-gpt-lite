// The chat's agent picker inside the desktop app (spec openspec/specs/local-agents 「데스크톱 앱 안에서 고르기가 말하는 까닭」). The user's
// report 2026-11-25 (verbatim): 「일렉트론에서 실행했는데도... 에이전트 선택이 안됨」 — their app was 0.1.0 (from before the local agents: it
// has no runner bridge, so it never paired the computer) and the picker said 「PC 앱을 설치하고 로그인하면 쓸 수 있어요」, inside the PC app.
// The page here is a plain browser page given the desktop preload's window.pglDesktop (an old one, or one with a fake runner bridge).
// Fictional person: 한서윤.
// F-CA-09 a browser: the picker says what it said before (install the app), no app-version line
// F-CA-10 inside a 0.1.0 app: 「PC 앱이 오래돼 …」, the version and the newest, 「최신 버전 받기」; settings say the same; 390px phone
// F-CA-11 inside an app this person disconnected: 「연결을 해제해 두었어요」 + 「이 컴퓨터 연결」 — a failed pairing says so, the next one
//         pairs (a device token is issued) and the picker says 「연결 중」
// F-CA-12 inside a linked app older than the newest release: 「PC 앱 새 버전(…)이 나왔어요」 + 「내려받기」 (settings too)
// It starts its own stack (lib/localStack.js: a BFF in tenant chatagent-desk and Vite, on free ports from 8930 · 5330), the newest desktop
// release fixed at 0.2.3 (PRO_DESKTOP_LATEST). No model, no shared service.
//   cd e2e && npx playwright test --project=feature tests/feature/chat-agent-desktop.spec.js
import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { startStack, SHOTS as LA_SHOTS } from '../../lib/localStack.js'

test.describe.configure({ mode: 'serial' })
const SHOTS = path.join(LA_SHOTS, 'chat-agent')
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ko-KR' }
const DESK = { viewport: { width: 1280, height: 900 }, locale: 'ko-KR' }
const NOWHERE = 'http://127.0.0.1:9'
const LATEST = '0.2.3'
let S, SY

// desktop: null (a browser) · { version } (an app with no runner bridge) · { version, bridge: true } (a fake runner bridge:
// not paired, the person opted out here; pair() fails `fails` times, then pairs; never connects)
async function page(browser, opts, { desktop = null, theme = null, fails = 0 } = {}) {
  const ctx = await browser.newContext({ ...opts, baseURL: S.web })
  await ctx.addInitScript(([s, th, d, n]) => {
    if (window.top !== window) return
    localStorage.setItem('pgpt-pro-session', s)
    if (th) localStorage.setItem('pgpt-pro-theme', th)
    if (!d) return
    const app = { app: 'process-gpt-lite', version: d.version, platform: 'darwin' }
    if (d.bridge) {
      const st = { paired: !!d.paired, userId: d.paired ? d.userId : null, deviceId: null, deviceName: 'Test Mac', platform: 'darwin',
        prefs: { enabled: true, ask: false, finishMinutes: 5 }, connected: !!d.connected, clis: {}, running: [] }
      window.__pair = { calls: [], fails: n }
      app.localRunner = Object.freeze({
        status: async () => ({ ...st }),
        mayPair: async () => false,
        pair: async (v) => {
          window.__pair.calls.push(v.deviceId)
          if (window.__pair.fails-- > 0) return { ok: false, reason: '이 컴퓨터가 연결을 받지 않았어요' }
          Object.assign(st, { paired: true, userId: v.userId, deviceId: v.deviceId })
          return { ok: true }
        },
        forget: async () => ({ ok: true }), setPrefs: async () => {}, detect: async () => ({ ...st }), onState: () => () => {},
      })
    }
    window.pglDesktop = Object.freeze(app)
  }, [JSON.stringify(SY.session), theme, desktop, fails])
  const p = await ctx.newPage()
  p.errors = []
  p.on('pageerror', (e) => p.errors.push(String(e?.message || e)))
  return p
}
const shot = async (p, name) => { await p.waitForTimeout(600); await p.screenshot({ path: path.join(SHOTS, `${name}.png`) }) }
const noOverflow = (p) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
const chip = (p) => p.locator('[data-test=chat-agent-chip]').first()
const option = (p, id) => p.locator(`[data-test=chat-agent-option][data-agent="${id}"]`)
const why = (p, id) => option(p, id).locator('[data-test=chat-agent-why]')
async function openPicker(p) {
  await p.goto('/chat')
  await expect(chip(p)).toBeVisible({ timeout: 20000 })
  // (the newest release comes with the list: wait for the server's answer, not the page's first guess)
  await chip(p).click()
  await expect(option(p, 'claude-code')).toBeVisible()
}
const devices = () => S.q(`select id, revoked_at from pro_local_devices where tenant_id=$1 and user_id=$2`, [S.tenant, SY.id])

test.beforeAll(async () => {
  test.setTimeout(240_000)
  fs.mkdirSync(SHOTS, { recursive: true })
  S = await startStack({ tenant: 'chatagent-desk', apiFrom: 8930, webFrom: 5330,
    env: { PRO_DEEPAGENTS_URL: NOWHERE, PRO_COMPLETION_URL: NOWHERE, PRO_CONTEXT_ROUTER_URL: NOWHERE, PRO_DESKTOP_LATEST: LATEST } })
  SY = await S.person('pro-rt-chatagent-desk-a@uengine.org', '한서윤')
  await S.join(SY)
  await S.q(`delete from pro_local_devices where tenant_id=$1 and user_id=$2`, [S.tenant, SY.id])
  await S.q(`delete from pro_chat_agents where user_id=$1`, [SY.id])
})
test.afterAll(async () => {
  if (S) {
    await S.q(`delete from pro_local_devices where tenant_id=$1 and user_id=$2`, [S.tenant, SY?.id]).catch(() => {})
    await S.q(`delete from pro_chat_agents where tenant_id=$1`, [S.tenant]).catch(() => {})
    await S.stop()
  }
})

test('F-CA-09 브라우저에서는 그대로: 「PC 앱을 설치하고 로그인하면 쓸 수 있어요」와 「PC 앱 내려받기」, 앱 버전 줄은 없다', async ({ browser }) => {
  const p = await page(browser, DESK)
  await openPicker(p)
  for (const id of ['claude-code', 'codex']) await expect(why(p, id)).toHaveText('PC 앱을 설치하고 로그인하면 쓸 수 있어요')
  await expect(p.locator('[data-test=chat-agent-download]')).toBeVisible()
  await expect(p.locator('[data-test=chat-agent-old], [data-test=chat-agent-pair], [data-test=chat-agent-newer]')).toHaveCount(0)
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-CA-10 0.1.0 앱 안에서: 「PC 앱이 오래돼 …」, 지금 버전과 최신 버전, 「최신 버전 받기」 — 설정도 같은 말, 휴대폰 폭에서도', async ({ browser }) => {
  const p = await page(browser, DESK, { desktop: { version: '0.1.0' } })
  await openPicker(p)
  for (const id of ['claude-code', 'codex']) {
    await expect(option(p, id)).toHaveAttribute('aria-disabled', 'true')
    await expect(why(p, id)).toHaveText('PC 앱이 오래돼 이 컴퓨터를 연결할 수 없어요 — 업데이트하면 쓸 수 있어요')
  }
  await expect(p.getByText('PC 앱을 설치하고 로그인하면 쓸 수 있어요')).toHaveCount(0)
  const old = p.locator('[data-test=chat-agent-old]')
  await expect(old).toContainText(`지금 쓰는 PC 앱은 0.1.0 버전, 최신은 ${LATEST} 버전이에요`)
  await expect(old.locator('[data-test=chat-agent-update]')).toHaveText('최신 버전 받기')
  await expect(old.locator('[data-test=chat-agent-update]')).toHaveAttribute('href', /processgptlite\.html#desktop$/)
  // the chip's own tooltip says the same when a local agent was chosen before (here: 기본 — the chip has no why)
  // by keyboard: Tab from the list reaches the link, Esc closes
  await option(p, 'default').focus()
  await p.keyboard.press('Tab')
  await expect(old.locator('[data-test=chat-agent-update]')).toBeFocused()
  await shot(p, 'ca10-old-app')
  await p.keyboard.press('Escape')
  await expect(p.locator('[data-test=chat-agent-menu]')).toBeHidden()
  // settings › 계정: the same, not 「데스크톱 앱에서 연결해요」
  await p.goto('/settings/accounts')
  const box = p.locator('[data-test=local-agents-settings]')
  await expect(box.locator('[data-test=local-old-app]')).toContainText('PC 앱이 이전 버전이에요 · 0.1.0')
  await expect(box.locator('[data-test=local-update]')).toHaveText('최신 버전 받기')
  await expect(box).not.toContainText('데스크톱 앱에서 연결해요')
  await box.scrollIntoViewIfNeeded()
  await shot(p, 'ca10-old-app-settings')
  expect(p.errors).toEqual([])
  await p.context().close()
  // a phone-wide window, dark
  const ph = await page(browser, PHONE, { desktop: { version: '0.1.0' }, theme: 'dark' })
  await openPicker(ph)
  await expect(ph.locator('[data-test=chat-agent-old]')).toBeVisible()
  const menu = await ph.locator('[data-test=chat-agent-menu]').boundingBox()
  expect(menu.x).toBeGreaterThanOrEqual(0)
  expect(menu.x + menu.width).toBeLessThanOrEqual(390)
  expect(await noOverflow(ph)).toBe(true)
  await shot(ph, 'ca10-old-app-phone-dark')
  await ph.context().close()
})

test('F-CA-11 연결을 해제해 둔 앱 안에서: 「이 컴퓨터 연결」 — 실패하면 그렇다고, 다시 누르면 연결되고 「연결 중」', async ({ browser }) => {
  const p = await page(browser, DESK, { desktop: { version: LATEST, bridge: true }, fails: 1 })
  await openPicker(p)
  await expect(why(p, 'claude-code')).toHaveText('이 컴퓨터는 연결을 해제해 두었어요 — 다시 연결하면 쓸 수 있어요')
  const foot = p.locator('[data-test=chat-agent-pair]')
  await expect(foot).toContainText('연결하면 이 컴퓨터의 Claude Code · Codex로 보낼 수 있어요')
  // the first pairing is refused by the app: the picker says so, and offers it again
  await foot.locator('[data-test=chat-agent-pair-btn]').click()
  await expect(why(p, 'claude-code')).toHaveText('이 컴퓨터를 연결하지 못했어요 — 다시 연결해 주세요')
  await expect(p.locator('[data-test=chat-agent-pair-btn]')).toBeEnabled()
  await shot(p, 'ca11-pair-failed')
  // again: a device token is issued for this person and handed to the app; the app is paired, its link not up yet
  await p.locator('[data-test=chat-agent-pair-btn]').click()
  await expect(why(p, 'claude-code')).toHaveText('이 컴퓨터가 서버에 연결 중이에요')
  await expect(p.locator('[data-test=chat-agent-connecting]')).toHaveText('연결되면 바로 고를 수 있어요')
  await expect(p.locator('[data-test=chat-agent-pair]')).toHaveCount(0)
  const calls = await p.evaluate(() => window.__pair.calls)
  expect(calls.length).toBe(2)
  const rows = await devices()
  expect(rows.filter((d) => !d.revoked_at).map((d) => d.id)).toEqual(expect.arrayContaining([calls[1]]))
  // the token issued for the refused pairing was revoked, not left as a desktop that never comes
  expect(rows.filter((d) => d.revoked_at).map((d) => d.id)).toEqual([calls[0]])
  await expect(option(p, 'codex')).toBeVisible()
  // (the app is newest: no newer-version line)
  await expect(p.locator('[data-test=chat-agent-newer]')).toHaveCount(0)
  await shot(p, 'ca11-pair-connecting')
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-CA-12 연결된 앱이 최신이 아니면: 「PC 앱 새 버전(0.2.3)이 나왔어요」와 「내려받기」 — 설정에도', async ({ browser }) => {
  const p = await page(browser, DESK, { desktop: { version: '0.2.2', bridge: true, paired: true, connected: true, userId: SY.id } })
  await openPicker(p)
  const newer = p.locator('[data-test=chat-agent-newer]')
  await expect(newer).toContainText(`PC 앱 새 버전(${LATEST})이 나왔어요`)
  await expect(newer.locator('a')).toHaveText('내려받기')
  await expect(p.locator('[data-test=chat-agent-old], [data-test=chat-agent-pair]')).toHaveCount(0)
  await shot(p, 'ca12-newer')
  await p.keyboard.press('Escape')
  await p.goto('/settings/accounts')
  const box = p.locator('[data-test=local-agents-settings]')
  await expect(box.locator('[data-test=local-newer]')).toContainText(`PC 앱 새 버전(${LATEST})이 나왔어요 — 지금은 0.2.2 버전이에요`)
  await box.scrollIntoViewIfNeeded()
  await shot(p, 'ca12-newer-settings')
  expect(p.errors).toEqual([])
  await p.context().close()
})
