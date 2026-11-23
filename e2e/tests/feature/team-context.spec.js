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

test('F-TC-04 팀 탭: 팀 활동 화면이 뜨고, 조직도에 없는 사람에게는 공유된 활동이 없다고 말한다', async ({ pageAs }) => {
  const page = await pageAs('tc-team')
  await page.goto('/chat')
  await page.locator('nav.seg button', { hasText: '팀' }).click()
  await expect(page).toHaveURL(/\/team-activity/)
  await expect(page.getByRole('heading', { name: '팀 활동' })).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText('공유된 작업만, 내가 볼 수 있는 깊이로 모았어요')).toBeVisible()
  expect(page.errors).toEqual([])
})

test('F-TC-05 설정 › 공유와 허락: 기본 등급, 자동 허용 규칙(민감 줄 고정), 쓰인 곳·본 기록 칸', async ({ pageAs }) => {
  const page = await pageAs('tc-sharing')
  await page.goto('/settings/sharing')
  await expect(page.getByRole('heading', { name: '공유와 허락' })).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText('새 맥락의 기본 등급')).toBeVisible()
  await expect(page.getByText('민감 항목 → 언제나 묻기')).toBeVisible()
  await expect(page.getByText('내 맥락이 쓰인 곳')).toBeVisible()
  expect(page.errors).toEqual([])
})

// ── 회사 정책과 함께(설정 › 정책 · 팀원 맥락 참고, server/test/context-policy.{test.js,e2e.mjs}) ──────────────
const ledgerRow = (db, userId, { status = 'pending', decision = 'require_approval', topic = '급여', matched = 'context-sensitive-topic' } = {}) =>
  db.q(`insert into pro_policy_decisions (tenant_id, user_id, action_kind, subject, facts, decision, matched, status, approver_role)
        values ($1,$2,'context.access','박하늘의 민감할 수 있는 맥락(제목 가림) 원문 참고',$3,$4,$5,$6,'맥락 주인') returning id`,
  [db.tenant, userId, { sensitive: false, topic, relation: 'team', depth: 'content', owner_rule: 'allow' }, decision,
    JSON.stringify([{ id: matched, decision, title: ['민감할 수 있는 주제는 자동 허용하지 않음', 'Possibly sensitive topics are never allowed automatically'], approver: '맥락 주인' }]), status]).then((r) => r[0].id)

test('F-TC-06 설정 › 정책: 팀원 맥락 참고 정책 셋(주제 목록·주인이 결정), 원장의 참고 줄은 「주인 결정 대기」이고 승인 버튼이 없다', async ({ pageAs, db, cleanup }) => {
  const page = await pageAs('tc-policy')
  const id = await ledgerRow(db, page.user.id)
  cleanup(() => db.q('delete from pro_policy_decisions where id = $1', [id]))
  await page.goto('/settings/policies')
  const topic = page.locator('[data-policy="context-sensitive-topic"]')
  await expect(topic).toContainText('민감할 수 있는 주제는 자동 허용하지 않음', { timeout: 20_000 })
  await expect(topic.getByTestId('policy-topics')).toContainText('급여')
  await expect(topic).toContainText('그 맥락의 주인이 홈 카드에서')
  await expect(page.locator('[data-policy="context-sensitive-owner"]')).toContainText('민감 맥락은 주인이 직접 허락')
  await expect(page.locator('[data-policy="context-access-record"]')).toContainText('팀원 맥락 참고는 기록')
  await page.locator('[data-test="ledger-tab"]').click()
  const row = page.locator(`[data-decision="${id}"]`)
  await expect(row).toContainText('주인 결정 대기', { timeout: 20_000 })
  await expect(row).toContainText('팀원 맥락 참고')
  await expect(row.locator('[data-test="approve"]')).toHaveCount(0)
  await row.locator('.li.dec').click()
  await expect(row).toContainText('민감할 수 있는 주제')
  expect(page.errors).toEqual([])
})

test('F-TC-07 홈 카드·공유와 허락: 정책이 묻게 한 요청은 카드에 정책·주제가 보이고, 민감 표시 제안 카드, 고정 줄 둘(회사 정책)', async ({ pageAs, as, db, cleanup }) => {
  const page = await pageAs('tc-pol-owner')
  const req = await as('tc-pol-asker')
  await db.clearMain(page.user.id)
  const conv = `tc-pol-${Date.now()}`
  await db.addConversation(page.user.id, conv, '3분기 성과급 기준 정리')
  const did = await ledgerRow(db, req.id)
  const [r] = await db.q(`insert into pro_access_requests (tenant_id, requester, owner, conversation_id, target_title, depth, doing, policy_decision) values ($1,$2,$3,$4,'3분기 성과급 기준 정리','content','팀 보상 원칙 비교',$5) returning id`,
    [db.tenant, req.id, page.user.id, conv, did])
  await db.q(`insert into notifications (id, user_id, title, type, description, is_checked, time_stamp, url, tenant_id) values
      (gen_random_uuid(), $1, '참고 요청 · 회귀-tc-pol-asker · 「3분기 성과급 기준 정리」 원문', 'context_access', '지금 하는 일: 팀 보상 원칙 비교', false, now(), $2, $3),
      (gen_random_uuid(), $1, '민감 표시 제안 · 「팀원 병가 일정 정리」', 'context_sensitive', '「병가」에 관한 내용으로 보여요.', false, now(), '/settings/sharing', $3)`,
  [page.user.id, `/pro/context-access/${r.id}`, db.tenant])
  cleanup(() => db.q(`delete from notifications where tenant_id = $1 and user_id = $2 and type like 'context_%'`, [db.tenant, page.user.id]))
  cleanup(() => db.q('delete from pro_access_requests where id = $1', [r.id]))
  cleanup(() => db.q('delete from pro_policy_decisions where id = $1', [did]))
  await page.goto('/chat')
  const card = page.locator('.nc.context_access')
  await expect(card.getByTestId('access-policy')).toContainText('회사 정책 「민감할 수 있는 주제는 자동 허용하지 않음」 · 급여', { timeout: 20_000 })
  await expect(page.locator('.nc.context_sensitive')).toContainText('민감 표시 제안')
  await page.goto('/settings/sharing')
  await expect(page.getByTestId('rule-fixed')).toContainText('회사 정책 「민감 맥락은 주인이 직접 허락」', { timeout: 20_000 })
  await expect(page.getByTestId('rule-topic')).toContainText('민감할 수 있는 내용으로 읽히면 → 묻기')
  expect(page.errors).toEqual([])
})

// ── 글을 읽은 값(server lib/context/sensitive.js readContext, test/guard-reading.{test.js,e2e.mjs}) ──
test('F-TC-09 읽은 값이 보인다: 카드에 모델 판단과 확률, 원장에 판별 방법·민감 확률, 모델이 답하지 못하면 정책 화면에 경고', async ({ pageAs, as, db, cleanup }) => {
  const page = await pageAs('tc-read-owner')
  const req = await as('tc-read-asker')
  await db.clearMain(page.user.id)
  const conv = `tc-read-${Date.now()}`
  await db.addConversation(page.user.id, conv, '최 대리 권고사직 면담 메모')
  const [{ id: did }] = await db.q(`insert into pro_policy_decisions (tenant_id, user_id, action_kind, subject, facts, decision, matched, status, approver_role) values ($1,$2,'context.access','회귀 민감할 수 있는 맥락(제목 가림) 원문 참고',$3,'require_approval',$4,'pending','맥락 주인') returning id`,
    [db.tenant, req.id, { sensitive: false, topic: '이직', topic_source: 'logprob', topic_p: 0.97, topic_model: 'frentis-ai-model', relation: 'team', depth: 'content', owner_rule: 'allow' },
      JSON.stringify([{ id: 'context-sensitive-topic', decision: 'require_approval', title: ['민감할 수 있는 주제는 자동 허용하지 않음', 'x'], approver: '맥락 주인' }])])
  const [r] = await db.q(`insert into pro_access_requests (tenant_id, requester, owner, conversation_id, target_title, depth, doing, policy_decision) values ($1,$2,$3,$4,'최 대리 권고사직 면담 메모','content','회귀',$5) returning id`,
    [db.tenant, req.id, page.user.id, conv, did])
  await db.q(`insert into notifications (id, user_id, title, type, description, is_checked, time_stamp, url, tenant_id) values (gen_random_uuid(), $1, '참고 요청 · 회귀 · 「최 대리 권고사직 면담 메모」 원문', 'context_access', '', false, now(), $2, $3)`,
    [page.user.id, `/pro/context-access/${r.id}`, db.tenant])
  cleanup(() => db.q(`delete from notifications where tenant_id = $1 and user_id = $2 and type like 'context_%'`, [db.tenant, page.user.id]))
  cleanup(() => db.q('delete from pro_access_requests where id = $1', [r.id]))
  cleanup(() => db.q('delete from pro_policy_decisions where id = $1', [did]))
  await page.goto('/chat')
  await expect(page.locator('.nc.context_access').getByTestId('access-how')).toContainText('모델이 글을 읽고 판단, 97%', { timeout: 20_000 })
  // 모델이 답하지 못하는 상태: 정책 화면이 말해 준다. 원장에는 판별 방법·확률
  const admin = await pageAs('tc-policy')
  await db.q('update pro_policy_decisions set user_id = $2 where id = $1', [did, admin.user.id])
  await admin.route('**/api/policies', async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    const res = await route.fetch()
    await route.fulfill({ response: res, json: { ...(await res.json()), reading: { state: 'down', model: 'm', at: null, reason: 'x' } } })
  })
  await admin.goto('/settings/policies')
  await expect(admin.locator('[data-policy="context-sensitive-topic"]').getByTestId('reading-off')).toContainText('지금 모델이 답하지 않아 참고 요청을 모두 주인에게 묻고 있어요', { timeout: 20_000 })
  await admin.locator('[data-test="ledger-tab"]').click()
  const row = admin.locator(`[data-decision="${did}"]`)
  await row.locator('.li.dec').click({ timeout: 20_000 })
  await expect(row).toContainText('판별 방법')
  await expect(row).toContainText('모델이 글을 읽음')
  await expect(row).toContainText('민감 확률')
  await expect(row).toContainText('97%')
  expect(page.errors).toEqual([])
})

test('F-TC-10 모델이 끊겨 읽지 못한 글: 카드가 직접 확인해 달라고 말한다', async ({ pageAs, as, db, cleanup }) => {
  const page = await pageAs('tc-unread-owner')
  const req = await as('tc-unread-asker')
  await db.clearMain(page.user.id)
  const conv = `tc-unread-${Date.now()}`
  await db.addConversation(page.user.id, conv, '한 대리 재택 요청')
  const [{ id: did }] = await db.q(`insert into pro_policy_decisions (tenant_id, user_id, action_kind, subject, facts, decision, matched, status, approver_role) values ($1,$2,'context.access','회귀 민감할 수 있는 맥락(제목 가림) 원문 참고',$3,'require_approval',$4,'pending','맥락 주인') returning id`,
    [db.tenant, req.id, { sensitive: false, topic: '모델이 읽지 못함', topic_source: 'unread', topic_p: null, topic_model: null, relation: 'team', depth: 'content', owner_rule: 'allow' },
      JSON.stringify([{ id: 'context-sensitive-topic', decision: 'require_approval', title: ['민감할 수 있는 주제는 자동 허용하지 않음', 'x'], approver: '맥락 주인' }])])
  const [r] = await db.q(`insert into pro_access_requests (tenant_id, requester, owner, conversation_id, target_title, depth, doing, policy_decision) values ($1,$2,$3,$4,'한 대리 재택 요청','content','회귀',$5) returning id`,
    [db.tenant, req.id, page.user.id, conv, did])
  await db.q(`insert into notifications (id, user_id, title, type, description, is_checked, time_stamp, url, tenant_id) values (gen_random_uuid(), $1, '참고 요청 · 회귀 · 「한 대리 재택 요청」 원문', 'context_access', '', false, now(), $2, $3)`,
    [page.user.id, `/pro/context-access/${r.id}`, db.tenant])
  cleanup(() => db.q(`delete from notifications where tenant_id = $1 and user_id = $2 and type like 'context_%'`, [db.tenant, page.user.id]))
  cleanup(() => db.q('delete from pro_access_requests where id = $1', [r.id]))
  cleanup(() => db.q('delete from pro_policy_decisions where id = $1', [did]))
  await page.goto('/chat')
  const card = page.locator('.nc.context_access')
  await expect(card.getByTestId('access-policy')).toContainText('모델이 읽지 못함', { timeout: 20_000 })
  await expect(card.getByTestId('access-how')).toContainText('모델이 끊겨 직접 확인해 주세요')
  expect(page.errors).toEqual([])
})

// ── 같은 요청 알아보기(server lib/context/repeat.js, test/repeat.{test.js,e2e.mjs}) ─────────────────────────
test('F-TC-08 「이미 한 요청」 카드: 내 이전 요청은 그 답 보기(그 턴의 답을 펼침), 제목만 보이는 팀원 것은 요청하기, 그래도 새로 하기는 fresh 로 다시 보냄', async ({ pageAs, db, cleanup }) => {
  const page = await pageAs('tc-repeat')
  const th = await db.clearMain(page.user.id)
  const conv = `tc-rep-${Date.now()}`
  await db.addConversation(page.user.id, conv, '경쟁 서비스 동향')
  const ASK = '경쟁 3사 월 요금을 표로 비교해줘'
  const [, ans] = await db.addMessages(th, [
    { role: 'user', content: { text: '경쟁 3사 월 요금을 표로 비교해 줘' } },
    { role: 'agent', content: { text: '| 회사 | 월 요금 |\n|---|---|\n| A사 | 9,000원 |\n| B사 | 11,000원 |', conv } },
  ])
  const hits = [
    { kind: 'turn', conv, title: '경쟁 서비스 동향', owner: page.user.id, owner_name: '나', mine: true, depth: 'content', at: ans.created_at, turn_id: ans.id, prompt: '경쟁 3사 월 요금을 표로 비교해 줘', can_request: null, score: 0.99 },
    { kind: 'context', conv: 'tc-rep-other', title: '경쟁사 가격 벤치마크', owner: '00000000-0000-0000-0000-0000000000a2', owner_name: '최유나', mine: false, depth: 'title', at: ans.created_at, can_request: 'content', score: 0.77 },
  ]
  const [rep] = await db.q(`insert into pro_context_repeats (tenant_id, user_id, thread_id, message, hits) values ($1,$2,$3,$4,$5) returning id`, [db.tenant, page.user.id, th, ASK, JSON.stringify(hits)])
  cleanup(() => db.q('delete from pro_context_repeats where id = $1', [rep.id]))
  await db.addMessages(th, [
    { role: 'user', content: { text: ASK } },
    { role: 'agent', kind: 'repeat', content: { text: '이미 한 요청이에요', repeat_id: rep.id, request: ASK, hits } },
  ])
  let sent = null
  await page.route('**/api/threads/*/messages', async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    sent = route.request().postDataJSON()
    await route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body: 'event: done\ndata: {}\n\n' })
  })
  await page.goto('/chat')
  const card = page.getByTestId('repeat-card')
  await expect(card).toContainText('같은 요청을 전에 했어요', { timeout: 20_000 })
  await expect(card).toContainText('에이전트는 아직 부르지 않았어요')
  const mine = card.locator('[data-repeat="경쟁 서비스 동향"]')
  await expect(mine).toContainText('「경쟁 3사 월 요금을 표로 비교해 줘」')
  const other = card.locator('[data-repeat="경쟁사 가격 벤치마크"]')
  await expect(other).toContainText('최유나님이')
  await expect(other).toContainText('지금은 제목만')
  await expect(other.getByRole('button', { name: '요청하기' })).toBeVisible()
  await mine.getByRole('button', { name: '그 답 보기' }).click()
  await expect(mine.getByTestId('repeat-answer')).toContainText('11,000원')
  await expect.poll(async () => (await db.q('select choice from pro_context_repeats where id = $1', [rep.id]))[0].choice).toBe('view')
  await card.getByTestId('repeat-fresh').click()
  await expect(card).toContainText('같은 요청을 새로 보냈어요')
  await expect.poll(() => sent).toMatchObject({ text: ASK, fresh: true })
  expect(page.errors).toEqual([])
})
