// 메일 → 초안: 고객 메일이 문서를 요청하면 묻지 않고 초안을 만들어 둔다(홈 '초안 검토' 카드 + 파일 카드).
// 정식 등록된(프로세스 마이닝) 프로세스와 맞는 메일은 그 프로세스로 시작된다. 데모 메일함(/api/mail/demo-arrive)만 씀 —
// 실제 메일은 건드리지 않는다. (server/lib/mail.js · floorPlan.js · officeMcp.js · lib/mining/service.js routeMail)
import fs from 'node:fs/promises'
import path from 'node:path'
import { test, expect, api, RUN } from '../../lib/fixtures.js'
import { since, waitFor } from '../../lib/agent.js'
import { retireInstance } from '../../lib/seed.js'
import { SERVER_DIR } from '../../lib/env.js'

test.describe.configure({ mode: 'parallel' })
test.beforeEach(async () => {
  await expect.poll(async () => (await api.call(null, 'GET', '/config', null, { timeout: 5000 }).catch(() => ({ status: 0 }))).status, { timeout: 180_000, intervals: [3000] }).toBe(200)
})

// a demo mailbox for a test account, with the fixture's sample mails already seen (only the new mail is fresh)
async function demoMailbox(db, u, cleanup) {
  const fixture = JSON.parse(await fs.readFile(path.join(SERVER_DIR, 'fixtures', 'demo-mail.json'), 'utf8').catch(() => 'null'))
  if (!fixture) return false
  await db.q(`insert into pro_mail_accounts(user_id, provider, address) values ($1,'demo',$2) on conflict (user_id) do update set provider='demo'`, [u.id, u.email])
  for (const m of fixture) await db.q('insert into pro_mail_seen values ($1,$2) on conflict do nothing', [u.id, m.id])
  cleanup(async () => {
    await db.q('delete from pro_mail_accounts where user_id=$1', [u.id])
    await db.q('delete from pro_demo_mail where user_id=$1', [u.id])
    await db.q('delete from pro_mail_seen where user_id=$1', [u.id])
    await db.q(`delete from pro_actions where user_id=$1`, [u.id]).catch(() => {})
    await db.q('delete from pro_mining_cases where user_id=$1', [u.id]).catch(() => {})
  })
  return true
}

test('A-12 [flaky] 고객 메일이 엑셀 문서를 요청하면 → 홈 "초안 검토" 카드와 엑셀 초안 파일 카드 (묻지 않고)', async ({ as, db, cleanup }) => {
  test.setTimeout(25 * 60_000)
  const u = await as('ag-mail')
  const th = await db.clearMain(u.id)
  test.skip(!(await demoMailbox(db, u, cleanup)), '데모 메일 fixture(server/fixtures) 없음')
  // demo-arrive is for a demo mailbox only
  const other = await as('ag-mail-none')
  await db.q('delete from pro_mail_accounts where user_id=$1', [other.id])
  expect((await other.post('/mail/demo-arrive', { from: 'x@example.com', subject: 's', text: 't' })).status).toBe(400)
  const t0 = new Date()
  const subject = `[${RUN}] 송년회 다과 비용표 부탁드립니다`
  const r = await u.post('/mail/demo-arrive', {
    from: '김다은 <daeun@hanbit-events.example>', subject,
    text: '안녕하세요, 한빛이벤트 김다은입니다. 12월 송년회(80명)에 쓸 다과·음료 비용을 품목별 수량과 단가, 합계가 보이는 엑셀 파일로 보내 주실 수 있을까요? 이번 주 금요일까지 받으면 좋겠습니다.',
  }, { timeout: 180_000 })
  expect(r.status, r.text).toBe(200)
  expect(r.body.fresh).toBe(1)
  const [mail] = await db.q('select mail_id from pro_demo_mail where user_id=$1 and subject=$2', [u.id, subject])
  const review = await waitFor(async () => (await db.q(`select * from pro_actions where user_id=$1 and verb='Review' and source->>'mail_id'=$2`, [u.id, mail.mail_id]))[0], { timeout: 5 * 60_000 })
  expect(review, '홈의 초안 검토 카드').toBeTruthy()
  expect(review.source.drafts.some((n) => /\.xlsx$/i.test(n))).toBe(true)
  const file = await waitFor(async () => (await since(db, th, t0, 'file')).find((m) => /\.xlsx$/i.test(m.content.name || '')), { timeout: 20 * 60_000 })
  expect(file, '엑셀 초안 카드').toBeTruthy()
  expect(file.content.url).toMatch(/^https?:\/\//)
  // the mail case left handover records for process mining
  expect((await db.q('select 1 from pro_mining_cases where user_id=$1 and mail_id=$2', [u.id, mail.mail_id])).length).toBe(1)
})

test('A-13 [flaky] 정식 등록된 프로세스와 맞는 메일 → 그 프로세스로 시작(프로세스 카드), 초안을 따로 만들지 않음', async ({ as, db, cleanup }) => {
  test.setTimeout(15 * 60_000)
  const [reg] = await db.q(`select id, name, match from pro_mining_suggestions where tenant_id=$1 and status='registered' and proc_def_id is not null order by decided_at desc limit 1`, [db.tenant])
  test.skip(!reg, '정식 등록된 마이닝 프로세스가 없음 (관리자가 추천을 등록한 뒤에만 확인)')
  const u = await as('ag-mail-route')
  const th = await db.clearMain(u.id)
  test.skip(!(await demoMailbox(db, u, cleanup)), '데모 메일 fixture(server/fixtures) 없음')
  const words = (reg.match?.keywords || []).slice(0, 3).join(', ')
  const t0 = new Date()
  const subject = `[${RUN}] ${words} 요청드립니다`
  const r = await u.post('/mail/demo-arrive', {
    from: '박서준 <seojun@cafe-namu.example>', subject,
    text: `안녕하세요, 카페나무 박서준입니다. 12m × 8m 매장 인테리어 설계 제안서(한글)와 견적서(엑셀), 평면도를 요청드립니다. ${words}`,
  }, { timeout: 180_000 })
  expect(r.status, r.text).toBe(200)
  const card = await waitFor(async () => (await since(db, th, t0, 'process')).find((m) => m.content.state === 'started'), { timeout: 8 * 60_000 })
  expect(card, '프로세스 카드').toBeTruthy()
  cleanup(() => retireInstance(card.content.instId))
  expect(card.content.name).toBe(reg.name)
  const [run] = await db.q('select suggestion_id from pro_mining_runs where proc_inst_id=$1', [card.content.instId])
  expect(run?.suggestion_id).toBe(reg.id)
  cleanup(() => db.q('delete from pro_mining_runs where proc_inst_id=$1', [card.content.instId]))
})
