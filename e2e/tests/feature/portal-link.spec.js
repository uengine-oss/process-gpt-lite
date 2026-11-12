// ProcessGPT 포털(같은 주소의 /)에서 「휴대폰 화면 › 라이트 모드」를 골라 /lite/ 로 온 휴대폰이
// 데스크톱 화면으로 돌아가는 길: 설정 시트의 「Process GPT 데스크톱 화면으로」 한 줄.
// /lite 아래에서 뜰 때만 보인다(PGPT_URL=http://…/lite). 그 밖의 설치에서는 줄이 없다는 것만 본다.
import { test, expect } from '../../lib/fixtures.js'
import { PGPT_URL } from '../../lib/env.js'

const UNDER_LITE = new URL(PGPT_URL).pathname.replace(/\/+$/, '') === '/lite'
const choose = (page, view) => page.addInitScript((v) => { if (window.top === window && v) localStorage.setItem('mobileView', v) }, view)

test.describe('포털로 돌아가기', () => {
  test('F-PT-01 포털에서 라이트 모드를 고르지 않았으면 설정에 「데스크톱 화면으로」 줄이 없다', async ({ pageAs }) => {
    const page = await pageAs('smoke')
    await page.goto('/settings')
    await expect(page.locator('.settings button.danger')).toBeVisible()
    await expect(page.locator('[data-test="to-portal"]')).toHaveCount(0)
    expect(page.errors).toEqual([])
  })

  test('F-PT-02 /lite 밖(단독 설치)에서는 mobileView 가 lite 여도 줄이 없다', async ({ pageAs }) => {
    test.skip(UNDER_LITE, '/lite 아래에서 도는 중')
    const page = await pageAs('smoke')
    await choose(page, 'lite')
    await page.goto('/settings')
    await expect(page.locator('.settings button.danger')).toBeVisible()
    await expect(page.locator('[data-test="to-portal"]')).toHaveCount(0)
  })

  test('F-PT-03 /lite 아래 + 라이트 모드로 온 휴대폰: 줄을 누르면 포털에 「데스크톱 화면」을 알리며 돌아간다', async ({ pageAs }) => {
    test.skip(!UNDER_LITE, 'ProcessGPT 게이트웨이 뒤(/lite)에서만 — PGPT_URL=http://…/lite')
    const page = await pageAs('smoke', { viewport: { width: 390, height: 844 }, dpr: 2 })
    await choose(page, 'lite')
    // the portal itself is not under test: any page at /definition-map will do
    await page.route((u) => u.pathname === '/definition-map', (r) => r.fulfill({ contentType: 'text/html', body: '<title>portal</title>' }))
    await page.goto('/settings')
    const row = page.locator('[data-test="to-portal"]')
    await expect(row).toBeVisible()
    await expect(row).toContainText(/Process GPT 데스크톱 화면으로|Open the Process GPT desktop view/)
    if (process.env.RT_SHOT_DIR) await page.screenshot({ path: `${process.env.RT_SHOT_DIR}/lite-to-portal.png` })
    await row.click()
    await page.waitForURL((u) => u.pathname === '/definition-map')
    expect(new URL(page.url()).searchParams.get('mobileView')).toBe('desktop')
  })
})
