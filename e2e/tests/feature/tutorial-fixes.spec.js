// 튜토리얼 작성 중 찾은 결함 고침 확인 (pgpt-pro/docs/tutorial-findings.md) — 모델 호출 없이 고정 데이터로.
//   F-FX-A01 팀·역할 관리 권한 (#1)          F-FX-A02 데모 메일함: 예약 도메인·로고 안 불러옴 (#24)
//   F-FX-A03 연습 메일 받기 (#26)            F-FX-A04 메일 연결 바꾸기 (#27)
//   F-FX-A05 표시 이름: 설정·온보딩 (#23)    F-FX-A06 보고문 글머리는 빠른 답 버튼이 아님 (#30)
//   F-FX-A07 대기·멈추기 (#25·#31·#32)       F-FX-A08 브라우저 작업 카드: 대기·확인 필요 (#28·#29)
// 서버 쪽 동작(대기열·멈추기·파일 출처·내 스킬+첨부)은 F-UT-08 (server/test/*.test.js) 이 deepagents 를 흉내 내 확인한다.
import { test, expect, api } from '../../lib/fixtures.js'
import fs from 'node:fs'
import path from 'node:path'
import { SERVER_DIR, hasServerSource } from '../../lib/env.js'

const admin = async (db, c, on = true) => { await db.q('update users set is_admin=$2 where id=$1', [c.id, on]); return c }

test('F-FX-A01 팀원 추가·빼기와 전체 역할 지정은 관리자만, 뺀 사람은 다시 들어오지 않음, 화면은 읽기 전용', async ({ as, pageAs, db, cleanup }) => {
  const boss = await admin(db, await as('fxa-admin'))
  cleanup(() => admin(db, boss, false))
  const user = await as('fxa-member'), mate = await as('fxa-mate')
  await user.get('/team'); await mate.get('/team')
  expect((await boss.get('/me')).body.admin).toBe(true)
  expect((await user.get('/me')).body.admin).toBe(false)
  // a member cannot change the team or the tenant-wide role holders
  expect((await user.post('/team', { email: 'pro-rt-fxa-other@uengine.org', name: '누군가' })).status).toBe(403)
  expect((await user.del(`/team/${mate.id}`)).status).toBe(403)
  expect((await user.put('/roles', { role: `회귀역할-${Date.now()}`, userId: user.id })).status).toBe(403)
  // an administrator can, and a removed member stays removed on their next visit
  expect((await boss.del(`/team/${mate.id}`)).status).toBe(200)
  await mate.get('/team')
  expect((await boss.get('/team')).body.some((m) => m.id === mate.id)).toBe(false)
  expect((await boss.post('/team', { email: mate.email, name: '회귀 동료' })).status).toBe(200)
  expect((await boss.get('/team')).body.some((m) => m.id === mate.id)).toBe(true)
  const role = `회귀역할-${Date.now()}`
  cleanup(() => db.q("delete from pro_role_assignments where tenant_id=$1 and role=$2", [db.tenant, role]))
  expect((await boss.put('/roles', { role, userId: mate.id })).status).toBe(200)
  // the screen: no add form, no remove buttons, role pickers disabled
  const page = await pageAs('fxa-member')
  await page.goto('/settings/team')
  await expect(page.getByText('관리자만 할 수 있어요')).toBeVisible()
  await expect(page.locator('form.add')).toHaveCount(0)
  await expect(page.locator('.tr .rm')).toHaveCount(0)
  const selects = page.locator('.tr select')
  if (await selects.count()) await expect(selects.first()).toBeDisabled()
  const bp = await pageAs('fxa-admin')
  await bp.goto('/settings/team')
  await expect(bp.locator('form.add')).toBeVisible()
  expect([...page.errors, ...bp.errors]).toEqual([])
})

test('F-FX-A02 데모 메일함: 발신 도메인은 예약 도메인(.example), 홈 카드는 실제 회사 로고를 부르지 않음', async ({ pageAs, db, cleanup }) => {
  test.skip(!hasServerSource(), 'server 소스 없음')
  const fixture = JSON.parse(fs.readFileSync(path.join(SERVER_DIR, 'fixtures/demo-mail.json'), 'utf8'))
  for (const m of fixture) expect(m.from, m.id).toMatch(/@[a-z0-9.-]+\.example>$/)
  for (const m of JSON.parse(fs.readFileSync(path.join(SERVER_DIR, 'fixtures/demo-practice-mail.json'), 'utf8'))) expect(m.from, m.id).toMatch(/@[a-z0-9.-]+\.example>$/)
  const page = await pageAs('fxa-demo')
  const u = page.user
  await db.q(`insert into pro_mail_accounts(user_id,provider,address) values ($1,'demo',$2) on conflict (user_id) do update set provider='demo'`, [u.id, u.email])
  cleanup(() => db.q('delete from pro_mail_accounts where user_id=$1', [u.id]))
  // a card left by the model's guess of a real company domain (before the fix)
  const [a] = await db.q(`insert into pro_actions(user_id,verb,text,icon,source) values ($1,'Reply',$2,'aurora-mfg.com',$3) returning id`,
    [u.id, '박서준님께 세미나 발표 가능 여부 회신', { mail_id: 'demo-004', from: '박서준 <seojun.park@aurora-mfg.example>', subject: '세미나' }])
  cleanup(() => db.q('delete from pro_actions where id=$1', [a.id]))
  const favicons = []
  page.on('request', (r) => { if (/google\.com\/s2\/favicons/.test(r.url()) && /aurora/.test(r.url())) favicons.push(r.url()) })
  await page.goto('/chat')
  await expect(page.locator('.act', { hasText: '세미나 발표' })).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('.act', { hasText: '세미나 발표' }).locator('.ico.letter')).toHaveText('A')
  expect(favicons).toEqual([])
  expect(page.errors).toEqual([])
})

test('F-FX-A03 연습 메일 받기: 데모 메일함이면 설정에서 고정 메일(달빛커피 2호점 제안·견적 요청 포함)을 받음', async ({ pageAs, db, cleanup }) => {
  const page = await pageAs('fxa-demo')
  const u = page.user
  await db.q(`insert into pro_mail_accounts(user_id,provider,address) values ($1,'demo',$2) on conflict (user_id) do update set provider='demo'`, [u.id, u.email])
  cleanup(() => db.q('delete from pro_mail_accounts where user_id=$1', [u.id]))
  const list = (await u.get('/mail/demo-templates')).body
  expect(list.map((t) => t.label)).toContain('달빛커피 2호점 제안·견적 요청')
  expect(list.every((t) => t.from && t.subject && !('text' in t))).toBe(true)
  // a template that does not exist, or a mailbox that is not a demo one: refused
  expect((await u.post('/mail/demo-arrive', { template: 'no-such' })).status).toBe(400)
  // the page sends the chosen template (answered here: the real arrival reads the mail with the model)
  let sent = null
  await page.route('**/api/mail/demo-arrive', async (r) => { sent = r.request().postDataJSON(); await r.fulfill({ json: { fresh: 1, actions: 1 } }) })
  await page.goto('/settings/system')
  const box = page.locator('.practice')
  await expect(box).toBeVisible()
  await box.locator('select').selectOption({ label: '달빛커피 2호점 제안·견적 요청' })
  await expect(box.locator('.sub')).toContainText('soyul.han@dalbit-coffee.example')
  await box.getByRole('button', { name: '연습 메일 받기' }).click()
  await expect(box.locator('.said')).toContainText('메일이 도착했어요')
  expect(sent).toEqual({ template: 'dalbit-2-proposal' })
  await page.goto('/settings/accounts')
  await expect(page.locator('.practice')).toBeVisible()
  expect(page.errors).toEqual([])
})

test('F-FX-A04 설정 › 계정 › 연결에서 메일 연결(Gmail·IMAP·데모)을 바꿈', async ({ pageAs, db, cleanup }) => {
  const page = await pageAs('fxa-mail')
  const u = page.user
  await db.q(`insert into pro_mail_accounts(user_id,provider,address) values ($1,'imap',$2) on conflict (user_id) do update set provider='imap', address=$2`, [u.id, u.email])
  cleanup(() => db.q('delete from pro_mail_accounts where user_id=$1', [u.id]))
  let sent = null
  // answered here: a real switch reads the new mailbox (and its mails with the model) a few seconds later
  await page.route('**/api/mail/connect', async (r) => {
    sent = r.request().postDataJSON()
    await db.q(`update pro_mail_accounts set provider=$2 where user_id=$1`, [u.id, sent.provider])
    await r.fulfill({ json: { ok: true } })
  })
  await page.goto('/settings/accounts')
  await expect(page.getByText('메일 · IMAP')).toBeVisible()
  await page.getByRole('button', { name: '연결 바꾸기' }).click()
  const sheet = page.locator('.sheet')
  await expect(sheet.getByText('Google 계정')).toBeVisible()
  await expect(sheet.getByText('IMAP', { exact: true })).toBeVisible()
  await sheet.getByText('데모 메일함').click()
  await expect(sheet).toHaveCount(0)
  expect(sent.provider).toBe('demo')
  await expect(page.getByText('메일 · 데모 메일함')).toBeVisible()
  expect(page.errors).toEqual([])
})

test('F-FX-A05 이메일 로그인 사용자의 표시 이름: 설정 › 계정에서 바꾸고, 온보딩에서 한 번 물음', async ({ pageAs, db }) => {
  const page = await pageAs('fxa-name')
  await page.goto('/settings/accounts')
  const input = page.getByLabel('이름', { exact: true })
  await input.fill('장진영(회귀)')
  await page.getByRole('button', { name: '저장' }).first().click()
  await expect.poll(async () => (await page.user.get('/me')).body.user.name).toBe('장진영(회귀)')
  const [u] = await db.q('select username from users where id=$1 and tenant_id=$2', [page.user.id, db.tenant])
  expect(u.username).toBe('장진영(회귀)')
  // onboarding: a fresh e-mail account is named after its address → asked once
  const s = await api.login('fxa-onboard')
  await db.q(`update pro_profile set name=$2, onboarded_at=null where user_id=$1`, [s.user.id, s.user.email.split('@')[0]])
  const p2 = await page.context().browser().newContext({ baseURL: page.url().replace(/\/settings.*$/, '') })
  await p2.addInitScript((x) => localStorage.setItem('pgpt-pro-session', x), JSON.stringify(s))
  const ob = await p2.newPage()
  await ob.goto('/welcome/age')
  await expect(ob.getByText('어떻게 불러 드릴까요?')).toBeVisible()
  const next = ob.getByRole('button', { name: '계속' })
  await ob.locator('select').nth(0).selectOption({ index: 5 })
  await ob.locator('select').nth(1).selectOption({ index: 3 })
  await ob.locator('select').nth(2).selectOption({ index: 3 })
  await expect(next).toBeDisabled()
  await ob.getByLabel('이름').fill('회귀 온보딩')
  await next.click()
  await expect(ob).toHaveURL(/\/welcome\/intro/)
  const [prof] = await db.q('select name from pro_profile where user_id=$1', [s.user.id])
  expect(prof.name).toBe('회귀 온보딩')
  await p2.close()
  expect(page.errors).toEqual([])
})

test('F-FX-A06 빠른 답 버튼은 질문으로 끝나는 짧은 선택지에만 — 보고문의 글머리 목록은 그대로', async ({ pageAs, db }) => {
  const page = await pageAs('fxa-replies')
  const th = await db.clearMain(page.user.id)
  await db.addMessages(th, [
    { role: 'user', kind: 'text', content: { text: '결제해 줘' } },
    { role: 'agent', kind: 'text', content: { text: '결제를 마쳤어요.\n- 무선 이어폰을 장바구니에 담았습니다\n- 카드 •••• 4242를 자동으로 **선택**·입력했습니다\n- 결제 버튼을 눌렀습니다' } },
    { role: 'user', kind: 'text', content: { text: '프로세스 만들어 줘' } },
    { role: 'agent', kind: 'text', content: { text: '흐름 초안을 만들었어요.\n이대로 진행할까요?\n- 네, 이대로 진행 (폼까지 만들어요)\n- 단계를 고칠게요' } },
  ])
  await page.goto('/chat')
  await expect(page.getByText('결제 버튼을 눌렀습니다')).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('.reply')).toHaveCount(2)
  await expect(page.locator('.reply').first()).toHaveText('네, 이대로 진행')
  await expect(page.locator('.reply', { hasText: '카드' })).toHaveCount(0)
  expect(page.errors).toEqual([])
})

test('F-FX-A07 대기 중인 메시지는 "대기"로 보이고, 답을 쓰는 동안 멈추기 버튼 → 멈추면 작업 중 표시가 사라짐', async ({ pageAs, db }) => {
  const page = await pageAs('fxa-stop')
  const th = await db.clearMain(page.user.id)
  await db.addMessages(th, [
    { role: 'user', kind: 'text', content: { text: '체크리스트 다시 정리해 줘' } },
    { role: 'user', kind: 'text', content: { text: '예산 안에서 가구 비중은?', queued: true } },
  ])
  await db.q(`update pro_threads set status='working', conversation_id=$2 where id=$1`, [th, `rt-fxa-stop-${Date.now()}`])
  await page.goto('/chat')
  await expect(page.getByText('대기 · 앞 답이 끝나면 이어서 답해요')).toBeVisible({ timeout: 20_000 })
  const stop = page.getByRole('button', { name: '답 멈추기' })
  await expect(stop).toBeVisible()
  const [res] = await Promise.all([page.waitForResponse((r) => r.url().includes(`/api/threads/${th}/stop`)), stop.click()])
  expect(res.status()).toBe(200)
  await expect(stop).toHaveCount(0, { timeout: 15_000 })
  const [t] = await db.q('select status from pro_threads where id=$1', [th])
  expect(t.status).toBeNull()
  // someone else's thread: 404
  const other = await api.as('fxa-replies')
  expect((await other.post(`/threads/${th}/stop`)).status).toBe(404)
  expect(page.errors).toEqual([])
})

test('F-FX-A08 브라우저 작업 카드: 앞 작업을 기다리는 작업은 "대기", 아무것도 못 하고 끝난 작업은 "확인 필요"', async ({ pageAs, db }) => {
  const page = await pageAs('fxa-browser')
  const th = await db.clearMain(page.user.id)
  const [q1, r1] = await db.addMessages(th, [
    { role: 'agent', kind: 'task', content: { title: '이어폰 다시 주문', goal: 'g', steps: [{ text: '상점 열기', done: false }], state: 'queued', reason: "앞 작업 '테스트 상점 로그인'이(가) 끝나면 시작해요" } },
    { role: 'agent', kind: 'task', content: { title: '잔액 확인', goal: 'g', steps: [{ text: '은행 열기', done: false }], state: 'needs_review', summary: '브라우저에서 아무 동작도 하지 못한 채 작업이 끝났어요.' } },
  ])
  await page.goto('/chat')
  await expect(page.getByText('대기 · 이어폰 다시 주문')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText('확인 필요 · 잔액 확인')).toBeVisible()
  // the queued card can be cancelled by itself (its own task id goes with the request)
  let body = null
  page.on('request', (r) => { if (r.url().endsWith('/api/browser/cancel')) body = r.postDataJSON() })
  await page.locator('.row', { has: page.getByText('대기 · 이어폰 다시 주문') }).getByRole('button', { name: '작업 취소' }).click()
  await expect.poll(() => body).toEqual({ taskId: q1.id })
  expect(r1.id).toBeTruthy()
  expect(page.errors).toEqual([])
})
