// 휴대폰 화면(2026-11-23, 운영) — Home 의 메일 카드(Review · Reply)와 업무 카드(Submit)는 닫을 수 없었다. 메일 카드의 ✕ 는
// 마우스를 올려야 보였고, 업무 카드에는 ✕ 가 없었다. 워크아이템 알림을 닫으면 같은 업무가 「Submit」 카드로 다시 나왔다.
// (「이메일이나 bpm todolist 는, 다른 곳에서 목록을 볼 수 있을것이므로 … 삭제 가능해야 한다... 홈은 일종의 노티피케이션이므로」)
// 고친 뒤: 모든 Home 카드는 ✕(휴대폰에서 늘 보임)나 옆으로 밀기로 닫힌다. 업무는 루틴 「내 입력이 필요해요」에, 메일은
// 팀 메시지 › 받은 편지함 › 메일에 남는다. 이 묶음의 서버는 mail-reply.spec.js 와 같이 가짜 모델로 띄운다(PRO_LLM_BASE_URL).
import crypto from 'node:crypto'
import { test, expect } from '../../lib/fixtures.js'

const PHONE = { width: 390, height: 844 }
const RUN = process.env.RT_RUN || Date.now().toString(36)

// a finger on the screen (CDP): Playwright's mouse never makes a pointerType 'touch'
async function swipe(page, box, dx = -260) {
  const cdp = await page.context().newCDPSession(page)
  const y = box.y + box.height / 2, x = box.x + box.width * 0.75
  const pt = (px) => [{ x: px, y, id: 1, radiusX: 4, radiusY: 4, force: 1 }]
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(x) })
  for (let i = 1; i <= 8; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt(x + (dx * i) / 8) }); await page.waitForTimeout(16) }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await cdp.detach()
}
// the screen's own transitions are over (endless ones — a spinner — are not waited for)
const settled = (page) => page.evaluate(() => Promise.all(document.getAnimations()
  .filter((a) => a.effect?.getComputedTiming?.().iterations !== Infinity).map((a) => a.finished.catch(() => {}))))
const opacity = (loc) => loc.evaluate((el) => getComputedStyle(el).opacity)
async function openHome(page) {
  await page.goto('/chat')
  await page.locator('.seg button').filter({ hasText: '홈' }).click()
}

// one routine with a step waiting on me (process-gpt's todolist trigger may also write its notice)
async function seedRoutine(db, u, cleanup, { keepNotice = false } = {}) {
  const DEF = `rt_hd_${RUN}_${crypto.randomUUID().slice(0, 6)}`.toLowerCase()
  const inst = `${DEF}.${crypto.randomUUID()}`
  const step = `고객 요구사항 작성 ${crypto.randomUUID().slice(0, 4)}`
  const def = { activities: [{ id: 'req', name: step, role: '영업담당자', type: 'userTask' }], events: [{ id: 'start', type: 'startEvent' }, { id: 'end', type: 'endEvent' }],
    gateways: [], roles: [{ name: '영업담당자' }], sequences: [{ id: 's1', source: 'start', target: 'req' }, { id: 's2', source: 'req', target: 'end' }] }
  const todo = crypto.randomUUID()
  cleanup(async () => {
    await db.q(`delete from notifications where url = '/todolist/' || $1`, [todo]).catch(() => {})
    await db.q(`delete from pro_actions where user_id=$1`, [u.id]).catch(() => {})
    await db.q('delete from todolist where proc_inst_id=$1', [inst]).catch(() => {})
    await db.q('delete from bpm_proc_inst where proc_inst_id=$1', [inst]).catch(() => {})
    await db.q('delete from proc_def where id=$1', [DEF]).catch(() => {})
  })
  await db.q(`insert into proc_def (id, name, definition, type, tenant_id, isdeleted) values ($1,$2,$3,'bpmn',$4,false)`, [DEF, `회귀 영업활동 ${RUN}`, def, db.tenant])
  await db.q(`insert into bpm_proc_inst (proc_inst_id, proc_inst_name, proc_def_id, status, current_activity_ids, participants, tenant_id, start_date)
              values ($1,$2,$3,'RUNNING',$4,$5,$6,now())`, [inst, `회귀 영업활동 ${RUN}`, DEF, ['req'], [u.id], db.tenant])
  await db.q(`insert into todolist (id, user_id, proc_inst_id, proc_def_id, activity_id, activity_name, status, tenant_id, start_date, root_proc_inst_id)
              values ($1,$2,$3,$4,'req',$5,'IN_PROGRESS',$6, now(), $3)`, [todo, u.email, inst, DEF, step, db.tenant])
  if (!keepNotice) await db.q(`delete from notifications where url = '/todolist/' || $1`, [todo]).catch(() => {})
  else {
    await db.q(`delete from notifications where url = '/todolist/' || $1`, [todo]).catch(() => {})
    await db.q(`insert into notifications(id,user_id,title,type,description,url,tenant_id) values (gen_random_uuid(),$1,$2,'workitem',$3,$4,$5)`, [u.email, step, `회귀 영업활동 ${RUN}`, `/todolist/${todo}`, db.tenant])
  }
  return { inst, todo, step }
}

test.describe('Home 은 알림 — 메일 카드 · 업무 카드도 닫는다', () => {
  test('F-HD-01 메일 카드: 휴대폰에서 ✕ 가 보이고, 밀어서 닫으면 Home 에서 사라지고 받은 편지함 › 메일에 남아 다시 연다', async ({ pageAs, db, cleanup }) => {
    const page = await pageAs('hd-mail', { viewport: PHONE, touch: true })
    const u = page.user
    const mailId = `demo-hd-${crypto.randomUUID().slice(0, 8)}`
    cleanup(async () => {
      await db.q('delete from pro_actions where user_id=$1', [u.id]); await db.q('delete from pro_demo_mail where user_id=$1', [u.id]); await db.q('delete from pro_mail_accounts where user_id=$1', [u.id])
    })
    await db.q(`insert into pro_mail_accounts(user_id, provider, address) values ($1,'demo',$2) on conflict (user_id) do update set provider='demo'`, [u.id, u.email])
    await db.q('insert into pro_demo_mail(user_id, mail_id, sender, subject, body) values ($1,$2,$3,$4,$5)', [u.id, mailId, '김하늘 <haneul.kim@northwind.example>', '개인정보 처리 안내', '안내드립니다. 자세한 내용은 본문을 확인해 주세요.'])
    await db.q('delete from pro_actions where user_id=$1', [u.id])
    const [a] = await db.q(`insert into pro_actions(user_id, verb, text, prompt, source) values ($1,'Review','개인정보 처리 안내 확인','안내를 확인하세요.',$2) returning *`,
      [u.id, { mail_id: mailId, from: '김하늘 <haneul.kim@northwind.example>', subject: '개인정보 처리 안내' }])
    await openHome(page)
    const card = page.locator('[data-test="action-card"]').filter({ hasText: '개인정보 처리 안내 확인' })
    await expect(card).toBeVisible()
    expect(await opacity(card.locator('[data-test="action-close"]')), '마우스가 없는 휴대폰에서도 ✕ 가 보인다').toBe('1')
    await settled(page)
    await page.screenshot({ path: test.info().outputPath('f-hd-01-home.png') })
    await swipe(page, await card.boundingBox())
    await expect(card).toHaveCount(0)
    await expect(page.locator('[data-test="mail-sheet"]'), '밀기는 카드를 여는 누름이 아니다').toHaveCount(0)
    const [row] = await db.q('select status from pro_actions where id=$1', [a.id])
    expect(row.status).toBe('dismissed')
    // 팀 메시지 › 받은 편지함 › 메일
    await page.locator('button.msgs').click()
    await page.locator('[data-test="inbox-mail"]').click()
    const kept = page.locator('[data-test="inbox-mail-card"]').filter({ hasText: '개인정보 처리 안내 확인' })
    await expect(kept).toContainText('홈에서 닫음')
    await settled(page)
    await page.screenshot({ path: test.info().outputPath('f-hd-01-inbox.png') })
    await kept.click()
    await expect(page.locator('[data-test="mail-text"]')).toContainText('자세한 내용은 본문을 확인해 주세요.')
  })

  test('F-HD-02 업무 카드: ✕ 가 있고, 닫으면 다시 열어도 Home 에 없으며 루틴 「내 입력이 필요해요」에는 남는다', async ({ pageAs, db, cleanup }) => {
    const page = await pageAs('hd-todo', { viewport: PHONE, touch: true })
    const u = page.user
    await db.q('delete from pro_actions where user_id=$1', [u.id])
    const { todo, step } = await seedRoutine(db, u, cleanup)
    await openHome(page)
    const card = page.locator('[data-test="todo-card"]').filter({ hasText: step })
    await expect(card).toBeVisible()
    expect(await opacity(card.locator('[data-test="todo-close"]'))).toBe('1')
    await swipe(page, await card.boundingBox())
    await expect(card).toHaveCount(0)
    expect(page.url(), '밀기는 루틴을 여는 누름이 아니다').not.toContain('/routines/')
    // the server remembers (another device, a reload)
    await page.reload()
    await page.locator('.seg button').filter({ hasText: '홈' }).click()
    await expect(page.locator('[data-test="todo-card"]').filter({ hasText: step })).toHaveCount(0)
    const todos = await page.user.get('/todos')
    expect(todos.body.find((t) => t.id === todo)?.home_hidden).toBe(true)
    // still mine: the process instances' list (「프로세스」 tab — id routine) lists it under 「내 입력이 필요해요」
    await page.locator('.seg button[data-tab="routine"]').click()
    await expect(page.locator('.rlist section').filter({ hasText: '내 입력이 필요해요' })).toContainText(`회귀 영업활동 ${RUN}`)
    await settled(page)
    await page.screenshot({ path: test.info().outputPath('f-hd-02-routine.png') })
  })

  test('F-HD-03 워크아이템 알림을 닫으면 같은 업무가 「Submit」 카드로 다시 나오지 않는다', async ({ pageAs, db, cleanup }) => {
    const page = await pageAs('hd-notice', { viewport: PHONE, touch: true })
    const u = page.user
    await db.q('delete from pro_actions where user_id=$1', [u.id])
    const { step } = await seedRoutine(db, u, cleanup, { keepNotice: true })
    await openHome(page)
    const notice = page.locator('[data-test="notice-card"]').filter({ hasText: step })
    await expect(notice).toBeVisible()
    await notice.locator('[data-test="notice-close"]').click()
    await expect(notice).toHaveCount(0)
    await expect(page.locator('[data-test="todo-card"]').filter({ hasText: step })).toHaveCount(0)
    await page.reload()
    await page.locator('.seg button').filter({ hasText: '홈' }).click()
    await expect(page.locator('.dock')).toBeVisible()
    await expect(page.locator('[data-test="todo-card"]').filter({ hasText: step })).toHaveCount(0)
    await expect(page.locator('[data-test="notice-card"]').filter({ hasText: step })).toHaveCount(0)
  })
})
