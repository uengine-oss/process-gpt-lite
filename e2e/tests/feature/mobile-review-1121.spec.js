// 휴대폰 녹화 검토(2026-11-21) — 홈 알림 카드 닫기 · 루틴 열기/닫기 · 「지금 실행해 봐」 · 텔레그램 알림.
// 390×844 손가락 화면. 모델 없이 고정 데이터로 본다(F-MR-05 의 실행 자체는 에이전트가 뒤에서 돈다 — 시험은 실행 기록과 채팅 줄만 본다).
import crypto from 'node:crypto'
import { test, expect, RUN, uniq } from '../../lib/fixtures.js'

const PHONE = { width: 390, height: 844 }
const NEVER = '0 0 31 2 *'
// the notice from the recording: process-gpt's chat notification copies the agent's whole answer, ```json and all
const LEAVE = '휴가 신청이 성공적으로 완료되었습니다. 이번 주 목요일(12월 28일)부터 금요일(12월 29일)까지 휴가를 신청하셨습니다. 상사와 인사팀의 승인을 기다리시면 됩니다. 추가로 궁금한 점이 있거나 다른 요청이 있으시면 언제든지 말씀해 주세요! 😊 ```json { "action": "process_executed", "status": "success", "message": "휴가 신청이 성공적으로 완료되었습니다.", "data": { "instance_id": "leave_request_and_approval_process.ae1d7b9d-41d2-4209-b919-d8285a0f13d3" }, "next_actions": ["휴가 신청 상태 확인", "다른 프로세스 실행"] } ```'

async function phone(pageAs, area) {
  const page = await pageAs(area, { viewport: PHONE })
  return page
}
// a finger on the screen (CDP): Playwright's mouse never makes a pointerType 'touch'
async function swipe(page, from, to, steps = 8) {
  const cdp = await page.context().newCDPSession(page)
  const pt = (x, y) => [{ x, y, id: 1, radiusX: 4, radiusY: 4, force: 1 }]
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(from.x, from.y) })
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps) })
    await page.waitForTimeout(16)
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await cdp.detach()
}
async function notice(db, u, { title, text = '', type = 'chat', url = '' }) {
  const id = crypto.randomUUID()
  await db.q(`insert into notifications(id,user_id,title,type,description,url,tenant_id) values ($1,$2,$3,$4,$5,$6,$7)`, [id, u.email, title, type, text, url, db.tenant])
  return id
}
async function openHome(page) {
  await page.goto('/chat')
  await page.locator('.dock.mobile').waitFor()
}

test.describe('휴대폰 검토 11-21 — 홈 알림 카드', () => {
  test('F-MR-01 날 JSON 이 든 알림: 카드가 화면 안에 맞고 ✕ 가 보이며, 홈이 옆으로 밀리지 않는다', async ({ pageAs, db, cleanup }) => {
    const page = await phone(pageAs, 'mr-notice')
    const u = page.user
    const id = await notice(db, u, { title: LEAVE, text: '내가 휴가를 가고 싶은데 이번 주 목요일하고 금요일에 휴가 신청해줘', url: `/chats?id=rt-${RUN}` })
    cleanup(() => db.q('delete from notifications where id=$1', [id]))
    await openHome(page)
    const card = page.locator('.nc').filter({ hasText: '휴가 신청이 성공적으로' }).first()
    await expect(card).toBeVisible()
    const title = await card.locator('.title').innerText()
    expect(title).not.toContain('instance_id')
    expect(title).not.toContain('```')
    const box = await card.boundingBox()
    expect(box.x).toBeGreaterThanOrEqual(8)
    expect(box.x + box.width).toBeLessThanOrEqual(PHONE.width - 8)
    const x = await card.locator('.x').boundingBox()
    expect(x.x + x.width, '✕ 가 화면 안').toBeLessThanOrEqual(PHONE.width)
    const dock = await page.locator('.dock.mobile').evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }))
    expect(dock.sw, '홈 목록이 옆으로 스크롤되지 않는다').toBeLessThanOrEqual(dock.cw)
    await page.screenshot({ path: test.info().outputPath('F-MR-01-home.png') })
  })

  test('F-MR-02 ✕ 로 닫으면 아래 카드가 제자리(왼쪽 여백 그대로)에서 위로 올라온다', async ({ pageAs, db, cleanup }) => {
    const page = await phone(pageAs, 'mr-close')
    const u = page.user
    const a = await notice(db, u, { title: `${LEAVE} (${RUN}-a)`, url: `/chats?id=rt-${RUN}` })
    const b = await notice(db, u, { title: `회귀 두 번째 알림 ${RUN}`, text: '아래 카드', url: `/chats?id=rt-${RUN}-b` })
    cleanup(() => db.q('delete from notifications where id = any($1)', [[a, b]]))
    await openHome(page)
    const first = page.locator('.nc').filter({ hasText: `${RUN}-a` })
    const second = page.locator('.nc').filter({ hasText: `회귀 두 번째 알림 ${RUN}` })
    await expect(first).toBeVisible()
    await expect(second).toBeVisible()
    const x0 = (await second.boundingBox()).x
    await first.locator('.x').click()
    // sample the card below while the first one goes: it moves up, never sideways
    const xs = []
    for (let i = 0; i < 12; i++) { const bb = await second.boundingBox(); if (bb) xs.push(bb.x); await page.waitForTimeout(40) }
    expect(Math.max(...xs.map((v) => Math.abs(v - x0))), `x: ${xs.join(',')}`).toBeLessThanOrEqual(2)
    await expect(first).toHaveCount(0)
    await expect.poll(async () => (await db.q('select is_checked from notifications where id=$1', [a]))[0]?.is_checked).toBe(true)
  })

  test('F-MR-03 손가락으로 옆으로 밀면 카드가 닫힌다(위아래는 목록 스크롤)', async ({ pageAs, db, cleanup }) => {
    const page = await phone(pageAs, 'mr-swipe')
    const u = page.user
    const id = await notice(db, u, { title: `밀어서 닫을 알림 ${RUN}`, text: '옆으로 밀어 보세요', url: `/chats?id=rt-${RUN}-s` })
    cleanup(() => db.q('delete from notifications where id=$1', [id]))
    await openHome(page)
    const card = page.locator('.nc').filter({ hasText: `밀어서 닫을 알림 ${RUN}` })
    await expect(card).toBeVisible()
    const bb = await card.boundingBox()
    const y = bb.y + bb.height / 2
    // a short sideways nudge springs back
    await swipe(page, { x: bb.x + bb.width - 40, y }, { x: bb.x + bb.width - 90, y })
    await page.waitForTimeout(300)
    await expect(card).toBeVisible()
    expect(Math.abs((await card.boundingBox()).x - bb.x)).toBeLessThanOrEqual(2)
    // a long one puts it away
    await swipe(page, { x: bb.x + bb.width - 30, y }, { x: bb.x - 150, y }, 10)
    await expect(card).toHaveCount(0)
    await expect.poll(async () => (await db.q('select is_checked from notifications where id=$1', [id]))[0]?.is_checked).toBe(true)
  })
})

// a small running instance with a step that is mine (Home shows it as 「Submit …」)
async function seedRoutine(db, u, cleanup) {
  const DEF = `rt_mr_${RUN}_${crypto.randomUUID().slice(0, 6)}`.toLowerCase()
  const inst = `${DEF}.${crypto.randomUUID()}`
  const def = { activities: [{ id: 'draft', name: '제안서 초안 작성', role: '영업담당자', type: 'userTask' }, { id: 'fix', name: '제안서 보완작성', role: '영업담당자', type: 'userTask' }],
    events: [{ id: 'start', type: 'startEvent' }, { id: 'end', type: 'endEvent' }], gateways: [], roles: [{ name: '영업담당자' }],
    sequences: [{ id: 's1', source: 'start', target: 'draft' }, { id: 's2', source: 'draft', target: 'fix' }, { id: 's3', source: 'fix', target: 'end' }] }
  cleanup(async () => {
    await db.q(`delete from notifications where url like '/todolist/%' and user_id=$1`, [u.email]).catch(() => {})
    await db.q('delete from todolist where proc_inst_id=$1', [inst]).catch(() => {})
    await db.q('delete from bpm_proc_inst where proc_inst_id=$1', [inst]).catch(() => {})
    await db.q('delete from proc_def where id=$1', [DEF]).catch(() => {})
  })
  await db.q(`insert into proc_def (id, name, definition, type, tenant_id, isdeleted) values ($1,$2,$3,'bpmn',$4,false)`, [DEF, `회귀 영업활동 ${RUN}`, def, db.tenant])
  await db.q(`insert into bpm_proc_inst (proc_inst_id, proc_inst_name, proc_def_id, status, current_activity_ids, participants, tenant_id, start_date)
              values ($1,$2,$3,'RUNNING',$4,$5,$6,now())`, [inst, `회귀 영업활동 · 한빛제조 ${RUN}`, DEF, ['fix'], [u.id], db.tenant])
  await db.q(`insert into todolist (id, user_id, proc_inst_id, proc_def_id, activity_id, activity_name, status, tenant_id, start_date, root_proc_inst_id)
              values ($1,$2,$3,$4,'draft','제안서 초안 작성','DONE',$5, now() - interval '10 minutes', $3)`, [crypto.randomUUID(), u.email, inst, DEF, db.tenant])
  const fix = crypto.randomUUID()
  await db.q(`insert into todolist (id, user_id, proc_inst_id, proc_def_id, activity_id, activity_name, status, tenant_id, start_date, root_proc_inst_id)
              values ($1,$2,$3,$4,'fix','제안서 보완작성','IN_PROGRESS',$5, now() - interval '2 minutes', $3)`, [fix, u.email, inst, DEF, db.tenant])
  // process-gpt's todolist trigger also writes a notification card for the step: Home then shows that
  // card instead of the 「Submit」 row this test (and the recording) opens from
  await db.q(`delete from notifications where url = '/todolist/' || $1`, [fix]).catch(() => {})
  return { DEF, inst }
}

test.describe('휴대폰 검토 11-21 — 루틴 열기 · 닫기', () => {
  test('F-MR-04 홈 카드로 루틴을 열면 앞 채팅이 비치지 않고 「루틴 여는 중」 → 루틴, ‹ 로 닫으면 홈', async ({ pageAs, db, cleanup }) => {
    const page = await phone(pageAs, 'mr-routine')
    const u = page.user
    const main = await db.clearMain(u.id)
    const marker = `메인 채팅 표시 ${RUN}`
    await db.addMessages(main, [{ role: 'user', kind: 'text', content: { text: '안녕?' } }, { role: 'agent', kind: 'text', content: { text: marker } }])
    const { inst } = await seedRoutine(db, u, cleanup)
    // a slow instance answer (production was slow enough to show the old chat for seconds)
    await page.route(`**/api/instances/${encodeURIComponent(inst)}`, async (r) => { await new Promise((ok) => setTimeout(ok, 1500)); await r.continue() })
    await openHome(page)
    await page.locator('.act').filter({ hasText: '제안서 보완작성' }).click()
    await expect(page.locator('[data-test="instance-loading"]')).toBeVisible()
    await expect(page.getByText(marker)).toHaveCount(0)
    await expect(page.getByText(`회귀 영업활동 · 한빛제조 ${RUN}`).first()).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText(marker)).toHaveCount(0)
    await page.screenshot({ path: test.info().outputPath('F-MR-04-routine.png') })
    // 닫기 (‹): back to Home where it was opened
    await page.locator('[data-test="instance-close"]').click()
    await expect(page.locator('.dock.mobile')).toBeVisible()
    await expect(page.locator('.seg button.on')).toHaveText(/홈/)
    expect(new URL(page.url()).pathname).toMatch(/\/chat$/)
  })

  test('F-MR-05 없는 루틴은 오류와 「닫기」, 주소로 바로 열었을 때 ‹ 는 루틴 목록으로', async ({ pageAs }) => {
    const page = await phone(pageAs, 'mr-missing')
    await page.goto(`/routines/${encodeURIComponent(`rt_missing_${RUN}.00000000-0000-0000-0000-000000000000`)}`)
    const box = page.locator('[data-test="instance-loading"]')
    await expect(box.getByRole('button', { name: '닫기' })).toBeVisible({ timeout: 15_000 })
    await expect(box.getByRole('button', { name: '다시 시도' })).toBeVisible()
    await page.locator('[data-test="instance-close"]').click()
    await expect.poll(() => new URL(page.url()).pathname).toMatch(/\/routines$/)
  })
})

test.describe('휴대폰 검토 11-21 — 채팅 말풍선', () => {
  test('F-MR-08 넓은 표가 든 답도 말풍선이 휴대폰 폭을 넘지 않고, 표만 그 안에서 옆으로 스크롤된다', async ({ pageAs, db }) => {
    const page = await phone(pageAs, 'mr-table')
    const main = await db.clearMain(page.user.id)
    const table = ['| 종목 | 시장 | 코드 | 현재가(11/20 종가) | 5거래일 전 종가(11/13) | 5일 누적 등락률 | 주요 원인 |', '|---|---|---|---|---|---|---|',
      '| AST 스페이스모바일 | NASDAQ | ASTS | $23.27 | $32.60 | **-28.62%** | 우주주 재편과 기술주 매도세 |',
      '| 테슬라 | NASDAQ | TSLA | $345.82 | $390.22 | **-11.38%** | 대형 기술주 동반 하락 |'].join('\n')
    await db.addMessages(main, [{ role: 'user', kind: 'text', content: { text: '바로 실행해 봐' } },
      { role: 'agent', kind: 'text', content: { text: `**5일 누적 등락 (기준 2026-11-20)**\n\n${table}\n\n4종목 모두 5% 이상 급락 조건에 해당합니다. 특히 AST 스페이스모바일은 일주일새 약 29% 급락했습니다.\n\n출처: 네이버 증권(ac.stock.naver.com, api.stock.naver.com)` } }])
    await page.goto('/chat')
    await page.locator('.seg button').filter({ hasText: '채팅' }).click()
    const bubble = page.locator('.bubble.agent').filter({ hasText: '4종목 모두' })
    await expect(bubble).toBeVisible()
    const bb = await bubble.boundingBox()
    expect(bb.x + bb.width, `bubble right edge ${bb.x + bb.width}`).toBeLessThanOrEqual(PHONE.width - 8)
    const t = await bubble.locator('table').evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }))
    expect(t.sw, '표는 말풍선 안에서 옆으로 스크롤').toBeGreaterThan(t.cw)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(PHONE.width)
  })
})

test.describe('휴대폰 검토 11-21 — 예약 작업', () => {
  // a task this conversation just set up: its 「예약됨」 chip carries its id
  async function seedTask(db, u, cleanup, name) {
    const main = await db.clearMain(u.id)
    const [s] = await db.q(`insert into pro_schedules(user_id,name,cron,prompt,thread_id,notify,state,tenant_id) values ($1,$2,$3,$4,$5,'on_change','{}'::jsonb,$6) returning *`,
      [u.id, name, NEVER, `회귀 시험 작업이에요. 다른 일은 하지 말고 "회귀 확인 ${RUN}" 한 줄만 답하세요.`, main, db.tenant])
    cleanup(() => db.q('delete from pro_schedules where id=$1', [s.id]))
    await db.addMessages(main, [
      { role: 'user', kind: 'text', content: { text: '코스피 주가를 1시간마다 보고 5% 넘게 움직이면 알려줘' } },
      { role: 'agent', kind: 'text', content: { text: '네, 1시간마다 확인해서 알려 드릴게요.' } },
      { role: 'agent', kind: 'chip', content: { icon: 'clock', text: `예약됨 · ${name}`, scheduleId: s.id } },
    ])
    return { s, main }
  }

  // Which words mean "run it now" or "alerts to Telegram" is the chat router's (skills/actions, measured by
  // server/eval's sets with the real model). These two check what the action does once chosen — the same
  // skill and arguments the router or a tapped choice gives (intent { kind: 'skill' }), without a model.
  test('F-MR-06 지금 실행(schedule-run-now): 새 예약 없이 그 작업을 지금 한 번 실행하고 이 대화에 「지금 실행」 칩', async ({ as, db, cleanup }) => {
    test.setTimeout(120_000)
    const u = await as('mr-runnow')
    const name = uniq('회귀 주가 감시')
    const { s, main } = await seedTask(db, u, cleanup, name)
    const before = (await db.q('select count(*)::int as n from pro_schedules where user_id=$1', [u.id]))[0].n
    const r = await u.post(`/threads/${main}/messages`, { text: '지금 한 번 실행', intent: { kind: 'skill', skill: 'schedule-run-now', args: { schedule: s.id.slice(0, 8) } } })
    expect(r.status, r.text).toBeLessThan(300)
    await expect.poll(async () => (await db.q(`select trigger from pro_mission_runs where schedule_id=$1`, [s.id])).map((x) => x.trigger), { timeout: 20_000 }).toContain('manual')
    expect((await db.q('select count(*)::int as n from pro_schedules where user_id=$1', [u.id]))[0].n, '새 예약을 만들지 않는다').toBe(before)
    const chips = await db.q(`select content from pro_messages where thread_id=$1 and kind='chip' order by created_at`, [main])
    expect(chips.map((c) => c.content.text)).toContain(`지금 실행 · ${name}`)
    await db.q('delete from pro_mission_runs where schedule_id=$1', [s.id])
  })

  test('F-MR-07 텔레그램 전달(telegram-delivery alerts_on): 그 작업에 텔레그램 전달을 켜고, 봇이 없으면 연결 카드', async ({ as, db, cleanup }) => {
    test.setTimeout(120_000)
    const u = await as('mr-telegram')
    await u.del('/telegram').catch(() => {})
    const name = uniq('회귀 급등락 감시')
    const { s, main } = await seedTask(db, u, cleanup, name)
    const r = await u.post(`/threads/${main}/messages`, { text: '이 작업 결과를 텔레그램으로도', intent: { kind: 'skill', skill: 'telegram-delivery', args: { action: 'alerts_on', schedule: s.id.slice(0, 8) } } })
    expect(r.status, r.text).toBeLessThan(300)
    await expect.poll(async () => (await db.q('select state from pro_schedules where id=$1', [s.id]))[0].state?.channels, { timeout: 15_000 }).toEqual(['telegram'])
    await expect.poll(async () => (await db.q(`select count(*)::int as n from pro_messages where thread_id=$1 and kind='telegram_connect'`, [main]))[0].n).toBe(1)
    // the task's switch in 예약된 작업 turns it off again
    const off = await u.post(`/missions/${s.id}/channels`, { telegram: false })
    expect(off.body.channels).toEqual([])
    const other = await as('mr-telegram-other')
    expect((await other.post(`/missions/${s.id}/channels`, { telegram: true })).status).toBe(404)
  })
})
