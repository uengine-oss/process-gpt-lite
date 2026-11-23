// 브라우저 작업 독 — Hark 처럼 브라우저 에이전트가 일하는 동안 그 실시간 화면이 입력창 왼쪽에 작은 원으로 떠 있고,
// 누르면 그 자리에서 화면 가운데 카드로 커진다(닫으면 다시 원으로). 카드는 채팅의 작업 카드 그대로(계획·확장·취소),
// 알약은 일하는 동안 지금 하는 일(lib/browser.js say → status 이벤트)을 보여 준다. 모델 없이 고정 카드로.
import { test, expect } from '../../lib/fixtures.js'
import { PNG } from '../../lib/seed.js'

const shot = PNG(320, 200, [40, 120, 200]).toString('base64')
const running = { title: '튜토리얼 목차 확인', goal: 'g', steps: [{ text: '페이지 열기', done: true }, { text: '목차 읽기', done: false }], state: 'running', shot }

test('F-BD-01 일하는 브라우저 작업: 입력창 옆 원형 썸네일 → 누르면 가운데 카드(작업 카드 그대로) → Esc 로 닫힘', async ({ pageAs, db }) => {
  const page = await pageAs('bd-dock')
  const th = await db.clearMain(page.user.id)
  await db.addMessages(th, [
    { role: 'user', kind: 'text', content: { text: '튜토리얼 목차 확인해 줘' } },
    { role: 'agent', kind: 'task', content: running },
  ])
  await page.goto('/chat')
  const dock = page.locator('.foot .dock')
  await expect(dock).toBeVisible({ timeout: 20_000 })
  await expect(dock.locator('img')).toHaveAttribute('src', /^data:image\/jpeg;base64,/)
  // the dock takes the place of 조치 필요 left of the composer: never both
  await expect(page.locator('.foot .attn')).toHaveCount(0)

  await dock.click()
  const card = page.locator('.peek .pcard')
  await expect(card.locator('.screen img')).toBeVisible()
  await expect(card.locator('.title .tt')).toHaveText('튜토리얼 목차 확인')
  // the card's own controls: the plan, 확장 (the full handoff — the peek gives way), 작업 취소
  await card.locator('.title').click()
  await expect(card.locator('.plan li')).toHaveCount(2)
  await expect(card.getByRole('button', { name: '작업 취소' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('.peek')).toHaveCount(0)

  await dock.click()
  await page.locator('.peek').getByRole('button', { name: '확장' }).click()
  await expect(page.locator('.handoff')).toBeVisible()
  await expect(page.locator('.peek')).toHaveCount(0)
  expect(page.errors).toEqual([])
})

test('F-BD-02 끝난 작업에는 독이 없고, 조치가 필요한 작업은 주황 테두리 — 누르면 카드 대신 답할 카드로', async ({ pageAs, db }) => {
  const page = await pageAs('bd-dock')
  const th = await db.clearMain(page.user.id)
  const [done] = await db.addMessages(th, [{ role: 'agent', kind: 'task', content: { ...running, state: 'done' } }])
  await page.goto('/chat')
  await expect(page.locator('.task .title .tt')).toHaveText('튜토리얼 목차 확인', { timeout: 20_000 })
  await expect(page.locator('.foot .dock')).toHaveCount(0)

  await db.clearMain(page.user.id)
  await db.addMessages(th, [{ role: 'agent', kind: 'task', content: { ...running, state: 'needs_input' } }])
  await page.reload()
  await expect(page.locator('.foot .dock.attn')).toBeVisible({ timeout: 20_000 })
  await page.locator('.foot .dock').click()
  await page.waitForTimeout(400)
  await expect(page.locator('.peek')).toHaveCount(0)
  expect(done.id).toBeTruthy()
  expect(page.errors).toEqual([])
})

test('F-BD-03 끝났는데 마지막 화면이 없는 카드: 빈 화면에 반짝이는 제목(불러오는 중처럼 보임) 대신 알약만 있는 짧은 줄, 알약을 누르면 계획', async ({ pageAs, db }) => {
  const page = await pageAs('bd-dock', { viewport: { width: 390, height: 844 } })
  const th = await db.clearMain(page.user.id)
  const { shot: _none, ...noShot } = running
  await db.addMessages(th, [{ role: 'agent', kind: 'task', content: { ...noShot, title: '기존 오디오 개요 다운로드', state: 'done', url: '' } }])
  await page.goto('/chat')
  // a phone opens on 홈: the chat is its own tab
  await page.locator('button, a').filter({ hasText: /^채팅$/ }).first().click()
  const card = page.locator('.task').first()
  await expect(card.locator('.title .tt')).toHaveText('기존 오디오 개요 다운로드', { timeout: 20_000 })
  const screen = card.locator('.screen')
  await expect(screen).toHaveClass(/\bbare\b/)
  await expect(card.locator('.shimmer-text')).toHaveCount(0)
  expect((await screen.boundingBox()).height).toBeLessThan(80)
  await expect(page.locator('.foot .dock')).toHaveCount(0)
  await page.waitForTimeout(800) // the chat slides in: the picture after it settles
  await page.screenshot({ path: test.info().outputPath('bare-390.png') })
  // the plan still opens, at full size
  await card.locator('.title').click()
  await expect(card.locator('.plan li')).toHaveCount(2)
  await expect(screen).not.toHaveClass(/\bbare\b/)
  expect((await screen.boundingBox()).height).toBeGreaterThan(150)
  expect(page.errors).toEqual([])
})
