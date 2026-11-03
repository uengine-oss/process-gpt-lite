// 메시지 메뉴 — PC 우클릭·모바일 길게 누르기로 👍 👎 · 복사 · 텍스트 선택 · 답장 (spec pgpt-pro_message-actions, 모델 없음)
// (src/components/MessageMenu.vue, holdMenu.js, server/lib/messageActions.js)
import { test, expect } from '../../lib/fixtures.js'

const ANSWER = '미팅 날짜는 **오늘**로 넣었어요. 이대로 세 분께 보낼까요?'
const ANSWER_SEEN = '미팅 날짜는 오늘로 넣었어요. 이대로 세 분께 보낼까요?'
const PHONE = { viewport: { width: 390, height: 844 }, touch: true }

async function seeded(pageAs, db, area, opts, rows) {
  const page = await pageAs(area, opts)
  const th = await db.clearMain(page.user.id)
  const list = await db.addMessages(th, rows || [
    { role: 'user', kind: 'text', content: { text: '회의록 메일 써 줘' } },
    { role: 'agent', kind: 'text', content: { text: ANSWER } },
  ])
  await page.goto('/chat')
  // a phone opens on its Home tab
  if (opts?.touch) await page.getByText('채팅', { exact: true }).click()
  await expect(page.locator('.row').first()).toBeVisible()
  return { page, th, list }
}
const answer = (page) => page.locator('.bubble.agent', { hasText: '미팅 날짜는' })
const menu = (page) => page.getByTestId('message-menu')
// where a menu stands once its entrance has played
const settled = async (el) => { await el.evaluate((n) => Promise.all(n.getAnimations().map((a) => a.finished))); return el.boundingBox() }
const openByMouse = async (page, el = answer(page)) => { await el.click({ button: 'right' }); await expect(menu(page)).toBeVisible() }
// a real touch through the browser's input pipeline, as Playwright has no long press
async function press(page, el, ms, moveBy = 0) {
  const b = await el.boundingBox()
  const x = b.x + b.width / 2, y = b.y + b.height / 2
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
  if (moveBy) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - moveBy }] })
  await page.waitForTimeout(ms)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}
// the message POST is caught: the body is what this feature adds, the agent is not called
async function catchSend(page) {
  const sent = []
  await page.route('**/api/threads/*/messages', async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    sent.push(route.request().postDataJSON())
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'event: done\ndata: {}\n\n' })
  })
  return sent
}

test.describe('메시지 메뉴 (spec pgpt-pro_message-actions)', () => {
  test('F-MA-01 PC 우클릭: 포인터 자리에 메뉴, 답에는 👍 👎, 사람 말에는 없음, Esc·바깥 클릭으로 닫힘', async ({ pageAs, db }) => {
    const { page } = await seeded(pageAs, db, 'ma-mouse')
    const b = await answer(page).boundingBox()
    await page.mouse.click(b.x + 30, b.y + 12, { button: 'right' })
    await expect(menu(page)).toBeVisible()
    const m = await settled(menu(page))
    expect(Math.abs(m.x - (b.x + 30))).toBeLessThan(2)
    expect(Math.abs(m.y - (b.y + 12))).toBeLessThan(2)
    await expect(page.getByTestId('message-lift')).toHaveCount(0)
    await expect(page.getByTestId('rate-up')).toBeVisible()
    await expect(page.getByTestId('rate-down')).toBeVisible()
    for (const t of ['복사', '텍스트 선택', '답장']) await expect(menu(page).getByRole('menuitem', { name: t })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(menu(page)).toHaveCount(0)
    await page.locator('.bubble.user').click({ button: 'right' })
    await expect(menu(page)).toBeVisible()
    await expect(page.getByTestId('rate-up')).toHaveCount(0)
    await page.getByTestId('message-menu-scrim').click({ position: { x: 5, y: 5 } })
    await expect(menu(page)).toHaveCount(0)
    expect(page.errors).toEqual([])
  })

  test('F-MA-02 화면 끝에서 우클릭해도 메뉴가 화면 안에 들어온다', async ({ pageAs, db }) => {
    const { page } = await seeded(pageAs, db, 'ma-edge', { viewport: { width: 900, height: 400 } })
    const b = await answer(page).boundingBox()
    await page.mouse.click(b.x + b.width - 16, b.y + b.height - 16, { button: 'right' })
    const m = await settled(menu(page))
    expect(m.x + m.width).toBeLessThanOrEqual(900)
    expect(m.y + m.height).toBeLessThanOrEqual(400)
  })

  test('F-MA-03 선택한 글자와 링크의 우클릭은 브라우저 기본 메뉴로 둔다', async ({ pageAs, db }) => {
    const { page } = await seeded(pageAs, db, 'ma-native', {}, [{ role: 'agent', kind: 'text', content: { text: '미팅 날짜는 [안내문](https://example.com/a) 에 있어요' } }])
    const prevented = () => page.evaluate(() => new Promise((res) => addEventListener('contextmenu', (e) => setTimeout(() => res(e.defaultPrevented)), { once: true })))
    let p = prevented()
    await answer(page).locator('a').click({ button: 'right' })
    expect(await p).toBe(false)
    await expect(menu(page)).toHaveCount(0)
    await answer(page).evaluate((el) => { const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r) })
    p = prevented()
    await answer(page).click({ button: 'right', position: { x: 12, y: 18 } })
    expect(await p).toBe(false)
    await expect(menu(page)).toHaveCount(0)
    // 선택을 풀면 다시 메뉴
    await page.evaluate(() => getSelection().removeAllRanges())
    await answer(page).click({ button: 'right', position: { x: 12, y: 18 } })
    await expect(menu(page)).toBeVisible()
  })

  test('F-MA-04 복사: 화면에 보이는 글(마크다운 기호 없이)이 클립보드로, 잠시 뒤 닫힘', async ({ pageAs, db }) => {
    const { page } = await seeded(pageAs, db, 'ma-copy')
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    await openByMouse(page)
    await page.getByTestId('menu-copy').click()
    await expect(page.getByTestId('menu-copy')).toContainText('복사했어요')
    await expect(menu(page)).toHaveCount(0)
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(ANSWER_SEEN)
  })

  test('F-MA-05 텍스트 선택: 고를 수 있는 창에 글 전체가 선택되어 열리고, 전체 복사·닫기', async ({ pageAs, db }) => {
    const { page } = await seeded(pageAs, db, 'ma-select')
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    await openByMouse(page)
    await page.getByTestId('menu-select').click()
    const sheet = page.getByTestId('message-select')
    await expect(sheet).toContainText(ANSWER_SEEN)
    expect(await page.evaluate(() => getSelection().toString())).toBe(ANSWER_SEEN)
    expect(await sheet.locator('.words').evaluate((el) => getComputedStyle(el).userSelect)).toBe('text')
    await sheet.getByRole('button', { name: '닫기' }).click()
    await expect(sheet).toHaveCount(0)
    await openByMouse(page)
    await page.getByTestId('menu-select').click()
    await page.getByRole('button', { name: '전체 복사' }).click()
    await expect(page.getByRole('button', { name: '복사했어요' })).toBeVisible()
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(ANSWER_SEEN)
  })

  test('F-MA-06 👍 👎: 저장되고 표시되며 새로고침 뒤에도 남고, 다시 누르면 거둔다', async ({ pageAs, db }) => {
    const { page, list } = await seeded(pageAs, db, 'ma-rate')
    const row = async () => (await db.q('select content from pro_messages where id=$1', [list[1].id]))[0].content
    const rated = page.getByTestId('rated')
    await expect(rated).toHaveCount(0)
    await openByMouse(page)
    await page.getByTestId('rate-up').click()
    await expect(page.getByTestId('rate-up')).toHaveAttribute('aria-checked', 'true')
    await expect(menu(page)).toHaveCount(0)
    await expect(rated).toBeVisible()
    expect((await row()).feedback).toBe('up')
    await page.reload()
    await expect(rated).toBeVisible()
    await openByMouse(page)
    await expect(page.getByTestId('rate-up')).toHaveAttribute('aria-checked', 'true')
    await page.getByTestId('rate-down').click()
    await expect(menu(page)).toHaveCount(0)
    expect((await row()).feedback).toBe('down')
    await openByMouse(page)
    await page.getByTestId('rate-down').click()
    await expect(menu(page)).toHaveCount(0)
    await expect(rated).toHaveCount(0)
    expect((await row()).feedback).toBe(null)
    expect((await row()).text).toBe(ANSWER)
  })

  test('F-MA-07 모바일: 길게 누르면 말풍선이 떠오르고 배경이 흐려지며, 손을 떼도 열려 있다', async ({ pageAs, db }) => {
    const { page } = await seeded(pageAs, db, 'ma-touch', PHONE)
    expect(await answer(page).evaluate((el) => getComputedStyle(el).userSelect)).toBe('none')
    await press(page, answer(page), 650)
    await expect(menu(page)).toBeVisible()
    await page.waitForTimeout(200)
    await expect(menu(page)).toBeVisible()
    await expect(page.getByTestId('message-lift')).toContainText(ANSWER_SEEN)
    expect(await page.getByTestId('message-menu-scrim').evaluate((el) => getComputedStyle(el).backdropFilter)).toContain('blur')
    // 떠오른 말풍선과 메뉴가 겹치지 않고 화면 안에
    const l = await settled(page.getByTestId('message-lift')), m = await settled(menu(page))
    expect(m.y).toBeGreaterThanOrEqual(l.y + l.height)
    expect(m.y + m.height).toBeLessThanOrEqual(844)
    await page.getByTestId('message-lift').click()
    await expect(menu(page)).toHaveCount(0)
    expect(page.errors).toEqual([])
  })

  test('F-MA-08 모바일: 짧게 누르거나 스크롤하면 열리지 않는다', async ({ pageAs, db }) => {
    const { page } = await seeded(pageAs, db, 'ma-tap', PHONE)
    await press(page, answer(page), 120)
    await page.waitForTimeout(600)
    await expect(menu(page)).toHaveCount(0)
    await press(page, answer(page), 650, 40)
    await page.waitForTimeout(200)
    await expect(menu(page)).toHaveCount(0)
  })

  test('F-MA-09 답장: 입력창 위에 원문, 배경 흐림, 입력창에 포커스, 보내면 그 ID 가 함께 가고 인용이 사라진다', async ({ pageAs, db }) => {
    const { page, list } = await seeded(pageAs, db, 'ma-reply')
    const sent = await catchSend(page)
    await openByMouse(page)
    await page.getByTestId('menu-reply').click()
    const quote = page.getByTestId('reply-quote')
    await expect(quote).toContainText(ANSWER_SEEN)
    await expect(page.locator('.msgs')).toHaveClass(/dim/)
    await expect(page.locator('.composer textarea').first()).toBeFocused()
    await page.keyboard.type('보내')
    await page.keyboard.press('Enter')
    await expect(quote).toHaveCount(0)
    await expect(page.locator('.msgs')).not.toHaveClass(/dim/)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ text: '보내', replyTo: list[1].id })
    // 다음 말은 보통 메시지
    await page.locator('.composer textarea').first().fill('다음 말')
    await page.keyboard.press('Enter')
    await expect.poll(() => sent.length).toBe(2)
    expect(sent[1].replyTo).toBeUndefined()
  })

  test('F-MA-10 답장 취소: × · Esc · 바깥 누르기 어느 쪽이든 다음 말에 인용이 붙지 않는다', async ({ pageAs, db }) => {
    const { page } = await seeded(pageAs, db, 'ma-cancel')
    const sent = await catchSend(page)
    const quote = page.getByTestId('reply-quote')
    const startReply = async () => { await openByMouse(page); await page.getByTestId('menu-reply').click(); await expect(quote).toBeVisible() }
    await startReply()
    await page.getByTestId('reply-cancel').click()
    await expect(quote).toHaveCount(0)
    await startReply()
    await page.keyboard.press('Escape')
    await expect(quote).toHaveCount(0)
    await startReply()
    await page.getByTestId('reply-scrim').click({ position: { x: 5, y: 200 } })
    await expect(quote).toHaveCount(0)
    await page.locator('.composer textarea').first().fill('인용 없는 말')
    await page.keyboard.press('Enter')
    await expect.poll(() => sent.length).toBe(1)
    expect(sent[0].replyTo).toBeUndefined()
  })

  test('F-MA-11 답장 표시: 흐린 사본 + 내 말풍선, 사본을 누르면 원본으로 간다, 원본이 내 말이면 오른쪽', async ({ pageAs, db }) => {
    const rows = [{ role: 'agent', kind: 'text', content: { text: ANSWER } }]
    for (let i = 0; i < 30; i++) rows.push({ role: i % 2 ? 'agent' : 'user', kind: 'text', content: { text: `다른 이야기 ${i}` } })
    const page = await pageAs('ma-quote')
    const th = await db.clearMain(page.user.id)
    const [first] = await db.addMessages(th, rows)
    await db.addMessages(th, [
      { role: 'user', kind: 'text', content: { text: '보내', replyUuid: first.id, replyContent: ANSWER, replyRole: 'agent' } },
      { role: 'user', kind: 'text', content: { text: '그 말 취소', replyUuid: first.id, replyContent: '내가 쓴 말', replyRole: 'user' } },
    ])
    await page.goto('/chat')
    const reply = page.locator('.row', { hasText: '보내' }).last()
    const copy = page.getByTestId('reply-of').first()
    await expect(copy).toContainText(ANSWER_SEEN)
    expect(Number(await copy.evaluate((el) => getComputedStyle(el).opacity))).toBeLessThan(0.8)
    await expect(reply.locator('.bubble.user')).toBeVisible()
    await expect(page.locator('.quote.q-user')).toContainText('내가 쓴 말')
    const original = page.locator(`[data-msg="${first.id}"]`)
    await expect(original).not.toBeInViewport()
    await copy.click()
    await expect(original).toBeInViewport()
    expect(page.errors).toEqual([])
  })

  test('F-MA-12 문서 카드에서도 메뉴가 열리고, 펼치기 버튼은 그대로다', async ({ pageAs, db }) => {
    const { page } = await seeded(pageAs, db, 'ma-doc', {}, [{ role: 'agent', kind: 'doc', content: { text: '# 회의록 초안\n- 첫째\n- 둘째' } }])
    await page.locator('.doc .inner').click({ button: 'right' })
    await expect(menu(page)).toBeVisible()
    await page.keyboard.press('Escape')
    await page.locator('.doc .more').click({ button: 'right' })
    await expect(menu(page)).toHaveCount(0)
  })

  test('F-MA-13 영어 모드: 메뉴 이름이 영어다', async ({ pageAs, db }) => {
    const page = await pageAs('ma-en')
    await page.addInitScript(() => localStorage.setItem('pgl-lang', 'en'))
    const th = await db.clearMain(page.user.id)
    await db.addMessages(th, [{ role: 'agent', kind: 'text', content: { text: 'The date is today.' } }])
    await page.goto('/chat')
    await page.locator('.bubble.agent').click({ button: 'right' })
    for (const t of ['Copy', 'Select text', 'Reply']) await expect(menu(page).getByRole('menuitem', { name: t })).toBeVisible()
    await expect(page.getByTestId('rate-up')).toHaveAttribute('aria-label', 'Good answer')
  })
})
