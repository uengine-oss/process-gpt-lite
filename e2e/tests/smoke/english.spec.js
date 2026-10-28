// English mode (src/i18n): every top-level screen, opened with ?lang=en on a fresh account, shows no
// Korean outside user content and tenant data (e2e/lib/hangul.js). The language switch is on the
// login screen and in 설정 › 계정, and every /api call says the screen language (X-PGL-Lang).
import { test, expect } from '@playwright/test'
import * as api from '../../lib/api.js'
import { RUN } from '../../lib/env.js'
import { visibleHangul, dataOf, isData } from '../../lib/hangul.js'

const EMAIL = `pro-en-ui-smoke-${RUN}@uengine.org`.toLowerCase()
const SETTINGS = ['schedules', 'team', 'skills', 'accounts', 'wallet', 'system', 'security', 'profile']
const SCREENS = ['/chat', '/projects', '/folders', '/settings', ...SETTINGS.map((k) => `/settings/${k}`), '/mining', '/improve']

let user, data
test.beforeAll(async () => {
  user = api.client(await api.login(EMAIL))
  await user.post('/profile', { name: 'Jinyoung Jang', birth: '1990-01-01', onboarded: true })
  data = await dataOf(async (p) => (await user.get(p)).body)
})

async function english(browser, { signedIn = true } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'en-US' })
  if (signedIn) await ctx.addInitScript((s) => { if (window.top === window) localStorage.setItem('pgpt-pro-session', s) }, JSON.stringify(user.s))
  const page = await ctx.newPage()
  page.errors = []
  page.on('pageerror', (e) => page.errors.push(String(e?.message || e)))
  return page
}
async function noKorean(page) {
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {})
  await page.waitForTimeout(1200)
  const r = await visibleHangul(page)
  expect(r.lang).toBe('en')
  const left = r.left.filter((l) => !isData(l.text, data)).map((l) => `${l.text} ‹${l.where}›`)
  expect(left, 'Korean left on screen').toEqual([])
}

test.describe('English mode', () => {
  test('S-EN-01 login screen in English, with the language switch', async ({ browser }) => {
    const page = await english(browser, { signedIn: false })
    await page.goto('/login?lang=en')
    await expect(page.locator('.lang-switch [data-lang="en"]')).toHaveAttribute('aria-pressed', 'true')
    await noKorean(page)
    expect(await page.evaluate(() => localStorage.getItem('pgl-lang'))).toBe('en')
    await page.context().close()
  })

  for (const p of SCREENS) {
    test(`S-EN-02 ${p} has no Korean`, async ({ browser }) => {
      const page = await english(browser)
      await page.goto(`${p}?lang=en`)
      await noKorean(page)
      expect(page.errors).toEqual([])
      await page.context().close()
    })
  }

  test('S-EN-03 every /api call carries X-PGL-Lang, and the switch goes back to Korean', async ({ browser }) => {
    const page = await english(browser)
    const langs = new Set()
    // fetch/XHR carry the header; EventSource cannot send headers and says it in the query instead
    page.on('request', (r) => {
      const u = new URL(r.url())
      if (!u.pathname.startsWith('/api/')) return
      if (r.resourceType() === 'eventsource') langs.add(`events:${u.searchParams.get('lang')}`)
      else if (['fetch', 'xhr'].includes(r.resourceType())) langs.add(r.headers()['x-pgl-lang'] || '(none)')
    })
    await page.goto('/settings/accounts?lang=en')
    await expect(page.locator('.lang-switch')).toBeVisible()
    await page.waitForLoadState('networkidle').catch(() => {})
    expect([...langs].sort()).toEqual(['en', 'events:en'])
    await page.locator('.lang-switch [data-lang="ko"]').click()
    await page.waitForURL(/\/settings\/accounts$/)
    await expect(page.locator('html')).toHaveAttribute('lang', 'ko')
    await expect(page.locator('.settings h1')).toHaveText('계정')
    await page.context().close()
  })
})
