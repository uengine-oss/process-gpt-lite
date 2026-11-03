// 후행 습관의 끝까지 — 실제 에이전트가 슬라이드를 만들고, 후행 작업을 두 번 보면 세 번째에 먼저 묻고, 눌러서 실행한다 (spec pgpt-pro_followup-habits)
import { test, expect } from '../../lib/fixtures.js'
import { ask, since, waitFor } from '../../lib/agent.js'

const AFTER = '슬라이드 첫 장 제목 앞에 [유엔진]을 붙여 줘'
const habits = (db, id) => db.q('select * from pro_followups where user_id=$1 order by created_at', [id])
const fileCards = async (db, th, t0) => (await since(db, th, t0, ['file'])).filter((m) => /\.pptx$/i.test(m.content?.name || ''))
async function slides(u, db, topic) {
  const r = await ask(u, db, `${topic} 슬라이드 3장짜리 pptx 파일로 만들어 줘. 표는 넣지 말고 짧게.`)
  await waitFor(async () => (await fileCards(db, r.th, r.t0)).length > 0, { timeout: 480_000, every: 3000 })
  return r
}

test('A-FU-01 슬라이드 → 후행 작업을 두 번 보면, 세 번째 슬라이드 뒤에 먼저 묻고, 네를 누르면 그 대화에서 실행한다', async ({ as, db }) => {
  test.setTimeout(2_700_000)
  const u = await as('fu-agent')
  await db.q('delete from pro_followups where user_id=$1', [u.id])
  await db.clearMain(u.id)
  // 첫째: 슬라이드를 받고 후행 작업을 시킨다 → 후보
  await slides(u, db, '카페 창업 절차')
  await ask(u, db, AFTER)
  await expect.poll(async () => (await habits(db, u.id)).length, { timeout: 30_000 }).toBeGreaterThan(0)
  expect((await habits(db, u.id))[0]).toMatchObject({ event_cls: 'slides', seen: 1, action: AFTER })
  // 둘째: 다른 주제의 슬라이드, 같은 후행 작업 → 습관
  await db.q(`update pro_threads set conversation_id=null where user_id=$1`, [u.id])
  await slides(u, db, '우주 탐사의 역사')
  await ask(u, db, AFTER)
  await expect.poll(async () => (await habits(db, u.id)).find((h) => h.action === AFTER)?.seen, { timeout: 30_000 }).toBe(2)
  // 셋째: 묻는다
  await db.q(`update pro_threads set conversation_id=null where user_id=$1`, [u.id])
  const third = await slides(u, db, '꿀벌의 한살이')
  const card = await waitFor(async () => (await since(db, third.th, third.t0, ['followup']))[0], { timeout: 30_000, every: 1000 })
  expect(card.content.state).toBe('pending')
  expect(card.content.text).toMatch(/^지난번처럼 /)
  // 네: 습관의 말이 턴이 된다
  const answered = await u.post(`/followups/answer/${card.id}`, { choice: 'accept' })
  expect(answered.status, answered.text).toBe(200)
  const said = await waitFor(async () => (await db.q(`select * from pro_messages where thread_id=$1 and role='user' and content->>'fromHabit'='true' and created_at > $2 limit 1`, [third.th, card.created_at]))[0], { timeout: 30_000, every: 1000 })
  expect(said.content.text).toBe(AFTER)
  await waitFor(async () => (await db.q(`select 1 from pro_messages where thread_id=$1 and role='agent' and kind in ('text','doc') and created_at > $2 and content ? 'event'`, [third.th, said.created_at]))[0], { timeout: 480_000, every: 3000 })
  const h = (await habits(db, u.id)).find((x) => x.action === AFTER)
  expect(h.accepted).toBe(1)
  expect(h.seen).toBe(3)
})
