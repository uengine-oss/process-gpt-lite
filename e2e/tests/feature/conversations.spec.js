// 대화 맥락 — 라우터가 나눈 대화 목록(/api/conversations), ConversationBar(/chat/c/:cid), 대화별 산출물
// 스택(ArtifactStack: 더미 → 펼침, 많으면 격자 → 누르면 편집기). 모델 없이 고정 데이터로.
// (영상 대화 맥락 라우터 youtu.be/oL_mfiQBCPU)
import { test, expect, api } from '../../lib/fixtures.js'
import { seedConversations } from '../../lib/chatseed.js'

test.describe.configure({ mode: 'serial' })

test('F-CV-01 /api/conversations: 내 대화만, 최근 순', async ({ as, db }) => {
  const u = await as('cv-user'), other = await as('cv-other')
  await seedConversations(db, u)
  const list = (await u.get('/conversations')).body
  expect(list.map((c) => c.id)).toEqual(expect.arrayContaining(['rt-conv-trip', 'rt-conv-yt']))
  expect(list[0]).toHaveProperty('title')
  expect((await other.get('/conversations')).body.some((c) => c.id.startsWith('rt-conv-'))).toBe(false)
})

test('F-CV-02 ConversationBar: 대화 2개 → 하나를 고르면 /chat/c/:cid, 그 대화의 메시지만', async ({ pageAs, db }) => {
  const page = await pageAs('cv-user')
  await seedConversations(db, page.user)
  await page.goto('/chat')
  const pill = page.locator('.cbar .pill')
  await expect(pill).toContainText('대화 2개')
  await pill.click()
  await expect(page.locator('.cbar .panel .row:not(.all)')).toHaveCount(2)
  await page.locator('.cbar .panel .row', { hasText: '출장 숙소' }).click()
  await expect(page).toHaveURL(/\/chat\/c\/rt-conv-trip$/)
  await expect(page.locator('.cbar.inside .cur b')).toHaveText('출장 숙소')
  await expect(page.locator('button.file')).toHaveCount(3)
  await expect(page.getByText('최근 영상 10개예요.')).toHaveCount(0)
  await page.locator('.cbar .back').click()
  await expect(page).toHaveURL(/\/chat$/)
  await expect(page.locator('button.file')).toHaveCount(13)
  expect(page.errors).toEqual([])
})

test('F-CV-03 산출물 스택: 3개는 부채꼴로 펼치고, 10개는 격자', async ({ pageAs, db }) => {
  const page = await pageAs('cv-user')
  await seedConversations(db, page.user)
  await page.goto('/chat/c/rt-conv-trip')
  await expect(page.locator('.astack .count')).toHaveText('3', { timeout: 20_000 })
  await page.locator('.astack .pile').click({ force: true })
  await expect(page.locator('.astack .fitem')).toHaveCount(3)
  await expect(page.locator('.astack .grid')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(page.locator('.astack .fitem')).toHaveCount(0)
  await page.goto('/chat/c/rt-conv-yt')
  await expect(page.locator('.astack .count')).toHaveText('10', { timeout: 20_000 })
  await page.locator('.astack .pile').click({ force: true })
  await expect(page.locator('.astack .grid .cap')).toContainText('이 대화의 산출물 10개')
  await expect(page.locator('.astack .grid .cell')).toHaveCount(10)
  // the whole chat (no conversation picked) shows no stack of its own
  await page.goto('/chat')
  await expect(page.locator('.astack')).toHaveCount(0)
  expect(page.errors).toEqual([])
})

test('F-CV-04 스택에서 엑셀을 누르면 이음오피스 편집기, SVG 는 VectorCraft 가 열린다', async ({ pageAs, db }) => {
  const page = await pageAs('cv-user')
  await seedConversations(db, page.user)
  await page.goto('/chat/c/rt-conv-trip')
  await page.locator('.astack .pile').click({ force: true })
  await expect(page.locator('.astack .fitem')).toHaveCount(3)
  await page.waitForTimeout(800) // let the fan settle (items fly out with a spring)
  await page.locator('.astack .fitem', { hasText: '숙소 1.xlsx' }).click({ force: true })
  const frame = page.locator('.oef iframe.frm')
  await expect(frame).toBeVisible({ timeout: 20_000 })
  expect(await frame.getAttribute('src')).toMatch(/^\/office\/sheets\/\?src=/)
  await page.locator('.oef .tb.ic[title="닫기"]').click()
  await expect(page.locator('.oef')).toHaveCount(0)
  // the pile bobs (animated): force the click, and retry once the sheet's closing transition ends
  await expect(async () => {
    if (!(await page.locator('.astack .fitem').count())) await page.locator('.astack .pile').click({ force: true })
    await expect(page.locator('.astack .fitem')).toHaveCount(3, { timeout: 1500 })
  }).toPass({ timeout: 15_000 })
  // without VectorCraft (Docker lite) the SVG is a plain link instead
  if (!(await api.craftHas('vectorcraft'))) { test.info().annotations.push({ type: 'skip-part', description: api.craftSkip('vectorcraft') }); expect(page.errors).toEqual([]); return }
  await page.waitForTimeout(800)
  await page.locator('.astack .fitem', { hasText: '숙소 3.svg' }).click({ force: true })
  await expect(page.locator('.cef iframe.frm')).toHaveAttribute('src', /\/craft\/vectorcraft\//, { timeout: 20_000 })
  expect(page.errors).toEqual([])
})

test('F-CV-05 대화 안에서 보낸 메시지는 그 대화로 이어진다(요청에 conversation id)', async ({ pageAs, db }) => {
  const page = await pageAs('cv-user')
  await seedConversations(db, page.user)
  let sent = null
  await page.route('**/api/threads/*/messages', async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    sent = route.request().postDataJSON()
    await route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body: 'event: done\ndata: {}\n\n' })
  })
  await page.goto('/chat/c/rt-conv-trip')
  await page.locator('.composer textarea').first().fill('두 번째 숙소 위치는?')
  await page.keyboard.press('Enter')
  await expect.poll(() => sent?.conversation?.id).toBe('rt-conv-trip')
  expect(sent.text).toBe('두 번째 숙소 위치는?')
})
