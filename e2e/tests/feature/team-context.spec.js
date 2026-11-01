// 팀 맥락 공유 — 메인 채팅의 자동 참고 칩·요청 후보, 홈의 참고 요청 카드(server lib/context, openspec changes/pgpt-pro-team-context).
// 고르기·판정·허락 규칙 자체는 server/test(context-visibility·refer 사례, context-share.e2e.mjs — 실제 임베딩·모델·시드 회사)가 보고,
// 여기는 고정 데이터로 화면을 본다. 모델 없이.
import { test, expect } from '../../lib/fixtures.js'

const referRow = (db, userId, threadId, { used = [], requestable = [], message = '경쟁사 가격 변화를 표로 정리해 줘' } = {}) =>
  db.q(`insert into pro_refers (tenant_id, user_id, thread_id, message, used, requestable, ms) values ($1,$2,$3,$4,$5,$6,120) returning id`,
    [db.tenant, userId, threadId, message, JSON.stringify(used), JSON.stringify(requestable)]).then((r) => r[0].id)

test('F-TC-01 자동 참고 칩: 사람 메시지 아래에 참고한 맥락(주인·깊이), 원문 요청·빼기·고정·자동 참고 끄기', async ({ pageAs, db, cleanup }) => {
  const page = await pageAs('tc-chips')
  const th = await db.clearMain(page.user.id)
  const used = [
    { id: 'tc-own', title: '경쟁 서비스 동향', owner: page.user.id, mine: true, depth: 'content', why: ['본인'] },
    { id: 'tc-park', title: '가격 정책 조사', owner: '00000000-0000-0000-0000-0000000000a1', owner_name: '박하늘', mine: false, depth: 'summary', why: ['요약 공개 · 팀 범위'], can_request: 'content' },
  ]
  const rid = await referRow(db, page.user.id, th, { used })
  cleanup(() => db.q('delete from pro_refers where id = $1', [rid]))
  cleanup(() => db.q('delete from pro_refer_edits where user_id = $1', [page.user.id]))
  await db.addMessages(th, [{ role: 'user', content: { text: '경쟁사 가격 변화를 표로 정리해 줘', refer: { refer_id: rid, used, requestable: [] } } }])
  await page.goto('/chat')
  const own = page.locator('[data-ref="경쟁 서비스 동향"]')
  const park = page.locator('[data-ref="가격 정책 조사"]')
  await expect(own).toContainText('내 맥락 · 원문', { timeout: 20_000 })
  await expect(park).toContainText('박하늘 · 요약')
  await expect(park.getByRole('button', { name: '원문 요청' })).toBeVisible()
  await expect(page.getByRole('button', { name: '자동 참고 끄기' })).toBeVisible()
  // 고정·빼기는 서버에 남는다(다음 턴의 고르기가 읽는다)
  await own.getByRole('button', { name: '고정' }).click()
  await expect(own.getByRole('button', { name: '고정됨' })).toBeVisible()
  await park.getByRole('button', { name: '빼기' }).click()
  await expect(park).toHaveCount(0)
  await expect.poll(async () => (await db.q(`select action from pro_refer_edits where user_id = $1 order by created_at`, [page.user.id])).map((r) => r.action).join(',')).toBe('pin,drop')
  await page.getByRole('button', { name: '자동 참고 끄기' }).click()
  await expect(page.getByText('자동 참고 꺼짐')).toBeVisible()
  expect(page.errors).toEqual([])
})

test('F-TC-02 요청 후보: 답 아래에 제목·주인만, 요청 상태(요청함·허락됨)와 「지금 반영해 다시 답하기」', async ({ pageAs, db, cleanup }) => {
  const page = await pageAs('tc-req')
  const th = await db.clearMain(page.user.id)
  const requestable = [{ id: 'tc-choi', title: '고객 B 가격 협상', owner: '00000000-0000-0000-0000-0000000000a2', owner_name: '최유나', depth: 'title', want: 'content' }]
  const rid = await referRow(db, page.user.id, th, { requestable })
  cleanup(() => db.q('delete from pro_refers where id = $1', [rid]))
  cleanup(() => db.q('delete from pro_access_requests where requester = $1', [page.user.id]))
  await db.addMessages(th, [
    { role: 'user', content: { text: '경쟁사 가격 변화를 표로 정리해 줘', refer: { refer_id: rid, used: [], requestable } } },
    { role: 'agent', content: { text: '경쟁 3사 가격표입니다.', refer_id: rid } },
  ])
  await page.goto('/chat')
  const row = page.locator('[data-req="고객 B 가격 협상"]')
  await expect(row).toContainText('최유나 · 지금은 제목만', { timeout: 20_000 })
  await expect(row.getByRole('button', { name: '요청하기' })).toBeVisible()
  // 주인에게 간 요청(기다리는 중) → 「요청함」, 허락 → 「허락됨」과 다시 답하기
  const [req] = await db.q(`insert into pro_access_requests (tenant_id, requester, owner, conversation_id, target_title, depth, status) values ($1,$2,$3,'tc-choi','고객 B 가격 협상','content','pending') returning id`,
    [db.tenant, page.user.id, requestable[0].owner])
  await page.reload()
  await expect(row).toContainText('요청함 — 최유나에게 갔어요', { timeout: 20_000 })
  await db.q(`update pro_access_requests set status = 'granted', decision = '{"depth":"content","duration":"7d"}' where id = $1`, [req.id])
  await page.reload()
  await expect(row).toContainText('허락됨 · 원문', { timeout: 20_000 })
  await expect(page.getByRole('button', { name: '지금 반영해 다시 답하기' })).toBeVisible()
  expect(page.errors).toEqual([])
})

test('F-TC-03 홈 카드: 팀원의 참고 요청을 카드 안에서 깊이·기간을 정해 허락하면 카드가 내려가고 요청자에게 결과가 간다', async ({ pageAs, as, db, cleanup }) => {
  const page = await pageAs('tc-owner')
  const req = await as('tc-asker')
  await db.clearMain(page.user.id)
  const conv = `tc-conv-${Date.now()}`
  await db.addConversation(page.user.id, conv, '고객 B 가격 협상')
  const [r] = await db.q(`insert into pro_access_requests (tenant_id, requester, owner, conversation_id, target_title, depth, doing) values ($1,$2,$3,$4,'고객 B 가격 협상','content','3분기 시장 보고서의 가격 비교표') returning id`,
    [db.tenant, req.id, page.user.id, conv])
  await db.q(`insert into notifications (id, user_id, title, type, description, is_checked, time_stamp, url, tenant_id) values (gen_random_uuid(), $1, '참고 요청 · 회귀-tc-asker · 「고객 B 가격 협상」 원문', 'context_access', '지금 하는 일: 3분기 시장 보고서의 가격 비교표', false, now(), $2, $3)`,
    [page.user.id, `/pro/context-access/${r.id}`, db.tenant])
  cleanup(() => db.q(`delete from notifications where tenant_id = $1 and (user_id = $2 or user_id = $3) and type like 'context_access%'`, [db.tenant, page.user.id, req.id]))
  cleanup(() => db.q('delete from pro_grants where owner = $1', [page.user.id]))
  cleanup(() => db.q('delete from pro_access_requests where owner = $1', [page.user.id]))
  await page.goto('/chat')
  const card = page.locator('.nc.context_access')
  await expect(card).toContainText('참고 요청', { timeout: 20_000 })
  await expect(card).toContainText('3분기 시장 보고서의 가격 비교표')
  await expect(card).toContainText('허락하면 나가는 것')
  await card.locator('select').nth(1).selectOption('7d')
  await card.getByRole('button', { name: '허락', exact: true }).click()
  await expect(card).toContainText('허락했어요')
  await expect(card).toHaveCount(0, { timeout: 10_000 })
  const [g] = await db.q(`select depth, duration, via from pro_grants where request_id = $1`, [r.id])
  expect(g).toEqual({ depth: 'content', duration: '7d', via: 'owner' })
  await expect.poll(async () => (await db.q(`select title from notifications where user_id = $1 and type = 'context_access_result'`, [req.id])).map((x) => x.title).join()).toContain('참고 허락')
  expect(page.errors).toEqual([])
})
