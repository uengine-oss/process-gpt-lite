// 답장의 끝까지 — 화면에서 답장하면 에이전트가 인용으로만 알 수 있는 말을 안다 (spec pgpt-pro_message-actions, 실제 모델)
import { test, expect } from '../../lib/fixtures.js'

const FILLERS = 14 // a turn reads back 12 rows: only the quote can bring the code

test('A-MA-01 오래전 답에 우클릭으로 답장 → 인용과 함께 가고, 답이 그 안의 코드를 안다', async ({ pageAs, db }) => {
  test.setTimeout(300_000)
  const page = await pageAs('ma-agent')
  const th = await db.clearMain(page.user.id)
  const rows = [{ role: 'agent', kind: 'text', content: { text: '이번 사업비 코드는 BX-4471 이에요. 이대로 보낼까요?' } }]
  for (let i = 0; i < FILLERS; i++) rows.push({ role: i % 2 ? 'agent' : 'user', kind: 'text', content: { text: `날씨 이야기 ${i}` } })
  const [first] = await db.addMessages(th, rows)
  await page.goto('/chat')
  const original = page.locator(`[data-msg="${first.id}"] .bubble`)
  await original.scrollIntoViewIfNeeded()
  await original.click({ button: 'right' })
  await page.getByTestId('menu-reply').click()
  await expect(page.getByTestId('reply-quote')).toContainText('BX-4471')
  await page.locator('.composer textarea').first().fill('여기 나온 코드만 그대로 다시 알려 줘')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('reply-of')).toContainText('BX-4471')
  const answers = () => db.q(`select content from pro_messages where thread_id=$1 and role='agent' and kind in ('text','doc') and created_at > (select created_at from pro_messages where thread_id=$1 and content->>'replyUuid'=$2 limit 1)`, [th, first.id])
  await expect.poll(async () => (await answers()).map((a) => a.content.text).join(' '), { timeout: 280_000, intervals: [3000] }).toContain('BX-4471')
  const [said] = await db.q(`select content from pro_messages where thread_id=$1 and content->>'replyUuid'=$2`, [th, first.id])
  expect(said.content).toMatchObject({ replyRole: 'agent' })
  expect(said.content.replyContent).toContain('BX-4471')
})
