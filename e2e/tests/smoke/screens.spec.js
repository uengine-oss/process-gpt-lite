// 모든 최상위 화면이 페이지 오류 없이 뜬다 (채팅·홈·프로젝트·폴더·설정 탭·작업실·로그인·모바일).
import { test, expect, uniq } from '../../lib/fixtures.js'
import { removeFolder } from '../../lib/seed.js'

const SETTINGS = { schedules: '예약된 작업', team: '팀·역할', skills: '스킬', accounts: '계정', wallet: '지갑', system: '시스템 설정', security: '보안', profile: '프로필' }
const noErrors = (page) => expect(page.errors, `page errors: ${page.errors.join(' | ')}`).toEqual([])

test.describe('화면', () => {
  test('S-10 채팅 화면: 상단 바·입력창·홈(Dock)', async ({ pageAs }) => {
    const page = await pageAs('smoke')
    await page.goto('/chat')
    await expect(page.locator('header.top')).toBeVisible()
    await expect(page.locator('.composer textarea').first()).toBeVisible()
    await expect(page.locator('.dock')).toBeVisible()
    noErrors(page)
  })

  test('S-11 홈 버튼: 원형 집 아이콘, 누르면 Home 이 접힌다', async ({ pageAs }) => {
    // the Process GPT robot was tried and reverted at the user's request (2026-10-25)
    const page = await pageAs('smoke')
    await page.goto('/chat')
    const btn = page.locator('header.top button.home').last()
    await expect(btn).toBeVisible()
    await expect(btn.locator('img.robot')).toHaveCount(0)
    await expect(btn.locator('svg')).toHaveCount(1)
    const radius = await btn.evaluate((el) => getComputedStyle(el).borderTopLeftRadius)
    expect(parseFloat(radius)).toBeGreaterThanOrEqual(24) // the round pill
    await expect(btn).toHaveAttribute('aria-label', 'Home 접기')
    await btn.click()
    await expect(btn).toHaveAttribute('aria-label', 'Home 펼치기')
    noErrors(page)
  })

  test('S-12 프로젝트 화면', async ({ pageAs }) => {
    const page = await pageAs('smoke')
    await page.goto('/projects')
    await expect(page.locator('.plist')).toBeVisible()
    noErrors(page)
  })

  test('S-13 폴더 화면', async ({ pageAs }) => {
    const page = await pageAs('smoke')
    await page.goto('/folders')
    await expect(page.locator('.fl')).toBeVisible()
    noErrors(page)
  })

  for (const [id, title] of Object.entries(SETTINGS)) {
    test(`S-14 설정 > ${title} (/settings/${id})`, async ({ pageAs }) => {
      const page = await pageAs('smoke')
      await page.goto(`/settings/${id}`)
      await expect(page.locator('.settings h1')).toHaveText(title)
      noErrors(page)
    })
  }

  test('S-15 작업실(공유 폴더 main) 화면', async ({ pageAs, cleanup, db }) => {
    const page = await pageAs('smoke')
    const f = await page.user.post('/folders', { name: uniq('회귀 작업실') })
    expect(f.status).toBe(200)
    cleanup(() => removeFolder(db, f.body.slug))
    await page.goto(`/workroom/folder/${f.body.slug}`)
    await expect(page.locator('.wr .hd')).toBeVisible()
    await expect(page.locator('.wr .hd .chip')).toContainText(f.body.slug)
    noErrors(page)
  })

  test('S-16 로그인 화면 (로그아웃 상태는 /login 으로)', async ({ page }) => {
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto('/chat')
    await expect(page).toHaveURL(/\/login$/)
    await expect(page.locator('.login')).toBeVisible()
    expect(errors).toEqual([])
  })

  test('S-17 모바일 폭: 홈·채팅·프로젝트 탭', async ({ pageAs }) => {
    const page = await pageAs('smoke', { viewport: { width: 390, height: 844 } })
    await page.goto('/chat')
    for (const t of ['홈', '채팅', '프로젝트']) await expect(page.locator('header.top .seg button', { hasText: t })).toBeVisible()
    await page.locator('header.top .seg button', { hasText: '홈' }).click()
    await expect(page.locator('.dock')).toBeVisible()
    noErrors(page)
  })
})
