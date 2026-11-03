// 후행 습관 — 묻는 카드와 설정 › 습관 화면 (spec pgpt-pro_followup-habits, 모델 없음)
// (src/components/FollowupCard.vue, FollowupList.vue, server/lib/followups.js)
import { test, expect } from '../../lib/fixtures.js'

const ACTION = '슬라이드 로고를 유엔진으로 바꿔 줘'
async function habit(db, u, over = {}) {
  const [h] = await db.q(`insert into pro_followups(tenant_id,user_id,event_cls,action,ask,seen,accepted,declined,origin,state) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
    [db.tenant, u.id, over.cls || 'slides', over.action || ACTION, over.ask || '슬라이드 로고를 유엔진으로 바꿔드릴까요?', over.seen ?? 2, over.accepted ?? 0, over.declined ?? 0, over.origin || 'observed', over.state || 'on'])
  return h
}
async function withCard(pageAs, db, area, over = {}) {
  const page = await pageAs(area, over.pageOpts)
  await db.q('delete from pro_followups where user_id=$1', [page.user.id])
  const th = await db.clearMain(page.user.id)
  const h = await habit(db, page.user, over)
  const [, , card] = await db.addMessages(th, [
    { role: 'user', kind: 'text', content: { text: '고객 제안 슬라이드 만들어 줘' } },
    { role: 'agent', kind: 'text', content: { text: '슬라이드를 만들었어요.' } },
    { role: 'agent', kind: 'followup', content: { text: `지난번처럼 슬라이드 로고를 유엔진으로 바꿔드릴까요?`, followupId: h.id, state: 'pending', seen: h.seen, accepted: h.accepted, origin: h.origin, source: 'logprob', p: 0.62, conv: { id: 'rt-fu', title: '고객 제안' } } },
  ])
  await page.goto('/chat')
  await expect(page.getByTestId('followup-card')).toBeVisible()
  return { page, th, h, card }
}
const row = async (db, id) => (await db.q('select * from pro_followups where id=$1', [id]))[0]
const content = async (db, id) => (await db.q('select content from pro_messages where id=$1', [id]))[0].content

test.describe('후행 습관 (spec pgpt-pro_followup-habits)', () => {
  test('F-FU-01 묻는 카드: 질문, 세 버튼, 근거 한 줄', async ({ pageAs, db }) => {
    const { page } = await withCard(pageAs, db, 'fu-card', { seen: 3 })
    const card = page.getByTestId('followup-card')
    await expect(card).toContainText('지난번처럼 슬라이드 로고를 유엔진으로 바꿔드릴까요?')
    await expect(card).toContainText('지금까지 3번 하셨어요')
    await expect(page.getByTestId('followup-accept')).toBeVisible()
    await expect(page.getByTestId('followup-decline')).toBeVisible()
    await expect(page.getByTestId('followup-mute')).toBeVisible()
    expect(page.errors).toEqual([])
  })

  test('F-FU-02 네: 답하는 요청이 가고 카드가 닫힌다(에이전트 실행은 가로챔)', async ({ pageAs, db }) => {
    const { page, card } = await withCard(pageAs, db, 'fu-accept')
    const sent = []
    await page.route('**/api/followups/answer/*', async (route) => {
      sent.push({ url: route.request().url(), body: route.request().postDataJSON() })
      await db.q(`update pro_messages set content = content || '{"state":"accepted"}'::jsonb where id=$1`, [card.id])
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"state":"accepted"}' })
    })
    await page.getByTestId('followup-accept').click()
    await expect.poll(() => sent.length).toBe(1)
    expect(sent[0].url).toContain(card.id)
    expect(sent[0].body).toEqual({ choice: 'accept' })
    await page.reload()
    await expect(page.getByTestId('followup-done')).toContainText('하는 중')
    await expect(page.getByTestId('followup-accept')).toHaveCount(0)
  })

  test('F-FU-03 아니요: 카드가 닫히고 거절이 쌓이며, 새로고침해도 그대로다', async ({ pageAs, db }) => {
    const { page, h, card } = await withCard(pageAs, db, 'fu-decline')
    await page.getByTestId('followup-decline').click()
    await expect(page.getByTestId('followup-done')).toContainText('하지 않았어요')
    await expect(page.getByTestId('followup-accept')).toHaveCount(0)
    expect((await content(db, card.id)).state).toBe('declined')
    const r = await row(db, h.id)
    expect(r.declined).toBe(1)
    expect(r.state).toBe('on')
    await page.reload()
    await expect(page.getByTestId('followup-done')).toContainText('하지 않았어요')
  })

  test('F-FU-04 연달아 세 번 거절하면 그만 묻는다(경계)', async ({ pageAs, db }) => {
    const { page, h } = await withCard(pageAs, db, 'fu-decline3', { declined: 2 })
    await db.q('update pro_followups set declined_run=2 where id=$1', [h.id])
    await page.getByTestId('followup-decline').click()
    await expect(page.getByTestId('followup-done')).toBeVisible()
    const r = await row(db, h.id)
    expect(r.declined_run).toBe(3)
    expect(r.state).toBe('muted')
  })

  test('F-FU-05 다시 묻지 않기: 끄고, 설정 › 습관에 꺼진 채 보이며, 다시 켤 수 있다', async ({ pageAs, db }) => {
    const { page, h } = await withCard(pageAs, db, 'fu-mute')
    await page.getByTestId('followup-mute').click()
    await expect(page.getByTestId('followup-done')).toContainText('다시 묻지 않을게요')
    expect((await row(db, h.id)).state).toBe('muted')
    await page.goto('/settings/habits')
    const li = page.getByTestId('habit-row')
    await expect(li).toContainText(ACTION)
    await expect(li).toContainText('묻지 않아요')
    await page.getByTestId('habit-on').click()
    await expect(page.getByTestId('habit-mute')).toBeVisible()
    expect((await row(db, h.id)).state).toBe('on')
  })

  test('F-FU-06 설정 › 습관: 언제·무엇을·횟수, 다음에 물을지, 지우기, 빈 화면 안내', async ({ pageAs, db }) => {
    const page = await pageAs('fu-list')
    await db.q('delete from pro_followups where user_id=$1', [page.user.id])
    await page.goto('/settings/habits')
    await expect(page.getByTestId('habits-empty')).toBeVisible()
    const a = await habit(db, page.user, { seen: 1 })
    await habit(db, page.user, { cls: 'doc', action: '표지에 대외비 넣어 줘', ask: '표지에 대외비를 넣어드릴까요?', origin: 'told', seen: 0, accepted: 1 })
    await page.reload()
    const rows = page.getByTestId('habit-row')
    await expect(rows).toHaveCount(2)
    const told = rows.filter({ hasText: '대외비' })
    await expect(told).toContainText('문서를 만들면')
    await expect(told).toContainText('직접 말씀하신 습관')
    await expect(told).toContainText('수락 1')
    const seen = rows.filter({ hasText: ACTION })
    await expect(seen).toContainText('슬라이드를 만들면')
    await expect(seen).toContainText('한 번 더 보면 물어볼게요')
    await seen.getByTestId('habit-remove').click()
    await expect(rows).toHaveCount(1)
    expect(await row(db, a.id)).toBeUndefined()
    expect(page.errors).toEqual([])
  })

  test('F-FU-07 설정 첫 화면에서 습관으로 들어간다', async ({ pageAs }) => {
    const page = await pageAs('fu-nav')
    await page.goto('/settings')
    await page.getByRole('button', { name: '습관' }).click()
    await expect(page).toHaveURL(/\/settings\/habits$/)
  })

  test('F-FU-08 휴대폰 폭에서 버튼이 화면 안에 들어온다', async ({ pageAs, db }) => {
    const page = await pageAs('fu-phone', { viewport: { width: 390, height: 844 }, touch: false })
    await db.q('delete from pro_followups where user_id=$1', [page.user.id])
    const th = await db.clearMain(page.user.id)
    const h = await habit(db, page.user)
    await db.addMessages(th, [{ role: 'agent', kind: 'followup', content: { text: '지난번처럼 슬라이드 로고를 유엔진으로 바꿔드릴까요?', followupId: h.id, state: 'pending', seen: 2, origin: 'observed' } }])
    await page.goto('/chat')
    await page.getByText('채팅', { exact: true }).click()
    const mute = page.getByTestId('followup-mute')
    await expect(mute).toBeVisible()
    const b = await mute.boundingBox()
    expect(b.x + b.width).toBeLessThanOrEqual(390)
  })

  test('F-FU-10 [model] 에이전트 없이 바로 온 답도 화면 아래까지 따라간다', async ({ pageAs, db }) => {
    const page = await pageAs('fu-scroll')
    await db.q('delete from pro_followups where user_id=$1', [page.user.id])
    const th = await db.clearMain(page.user.id)
    const rows = []
    for (let i = 0; i < 30; i++) rows.push({ role: i % 2 ? 'agent' : 'user', kind: 'text', content: { text: `지난 이야기 ${i}` } })
    await db.addMessages(th, rows)
    await page.goto('/chat')
    await expect(page.locator('.row').last()).toBeVisible()
    await page.waitForTimeout(800)
    await page.locator('.composer textarea').first().fill('앞으로 문서 만들면 표지에 대외비라고 넣어 줘')
    await page.keyboard.press('Enter')
    const ok = page.locator('.bubble.agent', { hasText: '기억할게요' })
    await expect(ok).toBeVisible({ timeout: 40000 })
    await page.waitForTimeout(1200)
    // 입력창에 가리지 않는다
    const b = await ok.boundingBox(), c = await page.locator('.composer .box').first().boundingBox()
    expect(b.y + b.height).toBeLessThanOrEqual(c.y)
  })

  test('F-FU-09 영어 모드: 카드와 화면 이름이 영어다', async ({ pageAs, db }) => {
    const page = await pageAs('fu-en')
    await page.addInitScript(() => localStorage.setItem('pgl-lang', 'en'))
    await db.q('delete from pro_followups where user_id=$1', [page.user.id])
    const th = await db.clearMain(page.user.id)
    const h = await habit(db, page.user, { action: 'Change the logo to uEngine', ask: 'Shall I change the logo to uEngine?' })
    await db.addMessages(th, [{ role: 'agent', kind: 'followup', content: { text: 'Like last time: Shall I change the logo to uEngine?', followupId: h.id, state: 'pending', seen: 2, origin: 'observed' } }])
    await page.goto('/chat')
    await expect(page.getByTestId('followup-accept')).toHaveText('Yes, please')
    await expect(page.getByTestId('followup-decline')).toHaveText('No')
    await expect(page.getByTestId('followup-mute')).toHaveText("Don't ask again")
    await expect(page.getByTestId('followup-card')).toContainText("You've done this 2 times")
  })
})
