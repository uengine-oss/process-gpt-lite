// 지도에서 바로 도는 건의 사람 단계: 에이전트가 그 단계에 맞게 만든 입력 화면(A2UI v1.0)을 할 일 카드(TodoCard)가 그린다.
// 만드는 동안 「준비하고 있어요」 → 화면(보기 · 숫자 · 날짜 · 확인 · 긴 글 · 버튼 둘), 필수 칸을 채우기 전엔 보내기가 꺼져 있고, 한국어로
// 채워 내면 읽기 전용(낸 값)으로 남는다. 화면을 못 만들면 지금의 글 한 칸. 휴대폰 390px 에서 옆으로 넘치지 않고, 낮 · 밤 테마를 따른다.
// 이 묶음의 서버는 가짜 모델로 띄운다: PRO_LLM_BASE_URL=http://127.0.0.1:<RT_FAKE_LLM_PORT, 기본 59987>/v1 — 이 파일이 그 포트에
// 가짜 모델을 띄운다(step-ui 프롬프트에는 server/test/fixtures/step-ui-review.json 화면, 판정에는 「A」). PRO_ONTOLOGY_BOLT_URL 은
// 비워 둔다(지도 없음 — 낸 뒤 다음 단계를 정하는 일은 이 시험 밖). 건은 엔진이 쓰는 모양 그대로 DB 에 넣는다.
// 스펙 openspec/specs/step-ui-a2ui, 서버 시험 server/test/stepUi.test.js · stepUi.integration.test.js
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../../lib/fixtures.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const PHONE = { width: 390, height: 844 }
const PORT = Number(process.env.RT_FAKE_LLM_PORT || 59987)
const SHOTS = path.resolve(here, '../../../openspec/specs/step-ui-a2ui/e2e/results')
const FIXTURE = JSON.parse(fs.readFileSync(path.resolve(here, '../../../server/test/fixtures/step-ui-review.json'), 'utf8'))
const shot = async (page, name, loc = null) => {
  fs.mkdirSync(SHOTS, { recursive: true })
  await (loc || page).screenshot({ path: path.join(SHOTS, `${name}.png`) })
  await (loc || page).screenshot({ path: test.info().outputPath(`${name}.png`) })
}

// the fake model: the fixture screen for a step-ui prompt (mode broken: a screen with an image — refused twice → the plain field;
// slowMs holds the answer so the 「준비하고 있어요」 state can be seen), 「A」 for a judge's first-token read (no secret asked)
const fake = { mode: 'good', slowMs: 0, uiCalls: 0 }
let server
test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', async () => {
      let b = {}
      try { b = JSON.parse(body) } catch { /* not json */ }
      const reply = (content) => res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] }))
      res.writeHead(200, { 'content-type': 'application/json' })
      if (b.logprobs) {
        return res.end(JSON.stringify({ choices: [{ message: { content: 'A' }, logprobs: { content: [{ token: 'A', logprob: Math.log(0.97), top_logprobs: [{ token: 'A', logprob: Math.log(0.97) }, { token: 'B', logprob: Math.log(0.03) }] }] } }] }))
      }
      const system = String(b.messages?.[0]?.content || '')
      if (!system.includes('입력 화면을 만듭니다')) return reply('{}')
      fake.uiCalls++
      if (fake.slowMs) await new Promise((r) => setTimeout(r, fake.slowMs))
      if (fake.mode === 'broken') return reply(JSON.stringify({ version: '1.0', createSurface: { surfaceId: 'x', components: [{ id: 'root', component: 'Image', url: 'https://example.com/a.png' }] } }))
      reply(JSON.stringify(FIXTURE))
    })
  })
  await new Promise((ok, no) => server.once('error', no).listen(PORT, '127.0.0.1', ok))
})
test.afterAll(async () => { await new Promise((ok) => server?.close(ok)) })

const actId = (task) => `t_${crypto.createHash('sha1').update(String(task)).digest('hex').slice(0, 10)}`
// a map case at a person's step (open, IN_PROGRESS) for `who`, as mapengine.createItem makes it, with the step's card in their chat
async function mapCase(db, cleanup, who, { task = '견적 검토', card = true } = {}) {
  const instId = `onto-map.${crypto.randomUUID()}`
  const request = { subject: '한빛상사 교육장 인테리어 견적 요청', body: '2층 교육장(40석) 인테리어 견적을 부탁드립니다. 다음 달 10일까지 완료가 목표예요.', customer: '한빛상사', sender: '윤태호 <yoon@hanbit.example.test>' }
  const [c] = await db.q(`insert into pro_po_cases (tenant_id, bundle, entry_task, started_by, trigger, instances, engine, request, run_mode, bindings)
                          values ($1,'process:stepui-e2e','요청 정리',$2,$3,$4,'map',$5,'hotl','[]') returning id::text as id`,
  [db.tenant, who.id, { kind: 'mail', subject: request.subject, from: request.sender }, [instId], request])
  cleanup(async () => {
    await db.q('delete from pro_step_ui where proc_inst_id=$1', [instId])
    await db.q('delete from pro_case_steps where case_id=$1', [c.id])
    await db.q('delete from todolist where proc_inst_id=$1', [instId])
    await db.q('delete from bpm_proc_inst where proc_inst_id=$1', [instId])
    await db.q('delete from pro_po_cases where id=$1', [c.id])
  })
  await db.q(`insert into bpm_proc_inst (proc_inst_id, proc_inst_name, proc_def_id, tenant_id, status, start_date, participants, current_activity_ids, updated_at)
              values ($1,$2,null,$3,'RUNNING',now(),$4,'{}',now())`, [instId, `견적 · ${request.subject}`, db.tenant, [who.id]])
  const prev = actId('요청 정리')
  await db.q(`insert into todolist (id, tenant_id, user_id, proc_inst_id, root_proc_inst_id, activity_id, activity_name, status, output, start_date, end_date)
              values (gen_random_uuid(),$1,$2,$3,$3,$4,'요청 정리','DONE',$5, now() - interval '1 hour', now() - interval '50 minutes')`,
  [db.tenant, who.id, instId, prev, { [`onto-map_${prev}_form`]: { result: '고객 한빛상사 · 2층 교육장 40석 · 예산 2,600만 원 안' } }])
  const aid = actId(task), formId = `onto-map_${aid}_form`
  const [t] = await db.q(`insert into todolist (id, tenant_id, user_id, username, proc_inst_id, root_proc_inst_id, activity_id, activity_name, status, tool, description, start_date)
                          values (gen_random_uuid(),$1,$2,'회귀',$3,$3,$4,$5,'IN_PROGRESS',$6,'견적 금액과 납기를 확인해 진행 여부를 정한다',now()) returning id::text as id`,
  [db.tenant, who.id, instId, aid, task, `formHandler:${formId}`])
  const act = { id: aid, name: task, role: '영업', tool: `formHandler:${formId}`, skills: [], checkpoints: ['단가표와 맞춰 보기'], outputs: ['검토 결과', '확정 금액', '납기'],
    description: '견적 금액과 납기를 확인해 진행 여부를 정한다', instruction: '', runner: 'person', agentMode: 'none' }
  await db.q(`insert into pro_case_steps (tenant_id, case_id, proc_inst_id, todo_id, task, kind, mode, state, act) values ($1,$2,$3,$4,$5,'person','hotl','released',$6)`, [db.tenant, c.id, instId, t.id, task, act])
  if (card) {
    const th = await db.clearMain(who.id)
    await db.addMessages(th, [{ role: 'agent', kind: 'todo', content: { todoId: t.id, name: task } }])
  }
  return { caseId: c.id, instId, todoId: t.id, formId }
}
const settled = (loc) => loc.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished))).catch(() => {})
const card = (page) => page.locator('[data-test="a2ui-step"]').first()

test.describe('단계 입력 화면 — 에이전트가 만든 A2UI 화면 (spec step-ui-a2ui)', () => {
  test.describe.configure({ mode: 'serial' })

  test('F-SU-01 할 일 카드: 준비하고 있어요 → 단계에 맞는 화면, 필수 칸 전엔 보내기 꺼짐, 한국어로 채워 내면 읽기 전용 · 서버에 값과 결과 글', async ({ pageAs, db, cleanup }) => {
    fake.mode = 'good'; fake.slowMs = 1800
    const page = await pageAs('su-owner', { viewport: { width: 1280, height: 1000 } })
    const s = await mapCase(db, cleanup, page.user)
    await page.goto('/chat')
    await expect(page.locator('[data-test="a2ui-making"]')).toContainText('이 단계에 맞는 입력 화면을 준비하고 있어요')
    await page.waitForTimeout(900) // (the page's own day/night change settles)
    await shot(page, 'f-su-01a-making')
    const ui = card(page)
    await expect(ui).toHaveAttribute('data-state', 'ready', { timeout: 20_000 })
    await expect(ui.locator('.t')).toHaveText('견적 검토')
    await expect(ui).toContainText('한빛상사 2층 교육장 인테리어 견적 26,070,000원')
    // the fields the agent chose: a choice, a number, a date, a check, a long text, two buttons
    await expect(ui.getByText('그대로 진행', { exact: true })).toBeVisible()
    await expect(ui.getByLabel('확정 금액(원)')).toHaveValue('26070000')
    await expect(ui.getByLabel('검토 의견')).toBeVisible()
    await expect(ui.getByLabel('단가표와 맞춰 봤어요')).not.toBeChecked()
    const send = ui.getByRole('button', { name: '검토 결과 보내기' })
    await expect(send).toBeDisabled()
    await expect(ui.getByRole('button', { name: '반려' })).toBeVisible()
    await settled(ui)
    await shot(page, 'f-su-01b-screen', ui)
    // filled in Korean, typed key by key
    await ui.getByText('금액 조정 후 진행', { exact: true }).click()
    await ui.getByLabel('확정 금액(원)').fill('24500000')
    await ui.locator('input[type="date"]').fill('2026-12-10')
    await ui.getByLabel('단가표와 맞춰 봤어요').check()
    await ui.getByLabel('검토 의견').pressSequentially('설계비 300만 원을 250만 원으로 조정해 주세요. 납기는 그대로예요.')
    await expect(send).toBeEnabled()
    await shot(page, 'f-su-01c-filled', ui)
    await send.click()
    // read-only, with what was handed in
    await expect(ui).toHaveAttribute('data-state', 'readonly')
    await expect(ui).toContainText('제출됨')
    await expect(ui.getByRole('button', { name: '검토 결과 보내기' })).toHaveCount(0)
    await expect(ui.getByLabel('검토 의견')).toHaveValue('설계비 300만 원을 250만 원으로 조정해 주세요. 납기는 그대로예요.')
    await expect(ui.locator('.body')).toHaveAttribute('inert', '')
    await settled(ui)
    await shot(page, 'f-su-01d-readonly', ui)
    // on the server: the values under the form id, the text the next steps read
    const [t] = await db.q('select status::text as status, output from todolist where id=$1', [s.todoId])
    expect(t.status).toBe('DONE')
    const v = t.output[s.formId]
    expect(v).toMatchObject({ decision: ['adjust'], amount: '24500000', due: '2026-12-10', checked: true, opinion: '설계비 300만 원을 250만 원으로 조정해 주세요. 납기는 그대로예요.' })
    expect(v.a2ui).toMatchObject({ event: 'submit', button: '검토 결과 보내기' })
    expect(v.result).toBe('결정: 검토 결과 보내기\n검토 결과: 금액 조정 후 진행\n확정 금액(원): 24500000\n납기일: 2026-12-10\n단가표와 맞춰 봤어요: 예\n검토 의견: 설계비 300만 원을 250만 원으로 조정해 주세요. 납기는 그대로예요.')
    // opened again later: the same read-only screen
    await page.reload()
    await expect(card(page)).toHaveAttribute('data-state', 'readonly')
    await expect(card(page).getByLabel('확정 금액(원)')).toHaveValue('24500000')
    expect(page.errors).toEqual([])
  })

  test('F-SU-02 빈 칸을 두고 보내기를 누르면 모든 칸의 안내가 보이고, 맡은 사람이 아니면 낼 수 없다(서버가 다시 본다)', async ({ pageAs, as, db, cleanup }) => {
    fake.mode = 'good'; fake.slowMs = 0
    const page = await pageAs('su-owner', { viewport: { width: 1280, height: 1000 } })
    const s = await mapCase(db, cleanup, page.user)
    await page.goto('/chat')
    const ui = card(page)
    await expect(ui).toHaveAttribute('data-state', 'ready', { timeout: 20_000 })
    // a fresh screen is not red: no check message until a field was used
    await expect(ui.locator('.a2ui-error-message').first()).toBeHidden()
    // one field used: its message only
    await ui.getByLabel('검토 의견').click()
    await ui.getByLabel('확정 금액(원)').click()
    await expect(ui.getByText('검토 의견을 적어 주세요.')).toBeVisible()
    await expect(ui.getByText('검토 결과를 골라 주세요.')).toBeHidden()
    // pressing the send button while it is off: every field's message
    await ui.getByRole('button', { name: '검토 결과 보내기' }).dispatchEvent('pointerdown')
    await expect(ui.getByText('검토 결과를 골라 주세요.')).toBeVisible()
    await settled(ui)
    await shot(page, 'f-su-02-checks', ui)
    // someone else cannot hand it in through the screen, whatever they send
    const other = await as('su-mate')
    const [row] = await db.q('select surface from pro_step_ui where todo_id=$1', [s.todoId])
    const action = { name: 'submit', surfaceId: row.surface.createSurface.surfaceId, sourceComponentId: 'send', timestamp: new Date().toISOString(), context: {} }
    const r = await other.post(`/todos/${s.todoId}/submit`, { values: { decision: ['go'], opinion: '남이 낸 것' }, a2ui: { version: '1.0', action } })
    expect(r.status).toBe(403)
    // the person: a button the screen does not have is refused too
    const r2 = await page.user.post(`/todos/${s.todoId}/submit`, { values: { decision: ['go'], opinion: '확인' }, a2ui: { version: '1.0', action: { ...action, name: 'approve_all' } } })
    expect(r2.status).toBe(400)
    expect((await db.q('select status::text as s from todolist where id=$1', [s.todoId]))[0].s).toBe('IN_PROGRESS')
    expect(page.errors).toEqual([])
  })

  test('F-SU-03 화면을 못 만들면(모델이 엉뚱한 화면을 두 번) 지금의 글 한 칸으로 낸다', async ({ pageAs, db, cleanup }) => {
    fake.mode = 'broken'; fake.slowMs = 0
    const page = await pageAs('su-owner')
    const s = await mapCase(db, cleanup, page.user)
    await page.goto('/chat')
    const form = page.locator('form.form').filter({ hasText: '견적 검토 결과' })
    await expect(form).toBeVisible({ timeout: 20_000 })
    await expect(card(page)).toHaveCount(0)
    await form.locator('textarea').pressSequentially('금액 그대로 진행해요.')
    await shot(page, 'f-su-03-fallback', form)
    await form.getByRole('button', { name: '제출' }).click()
    await expect(page.locator('.sent').filter({ hasText: '견적 검토 제출됨' })).toBeVisible()
    const [t] = await db.q('select output from todolist where id=$1', [s.todoId])
    expect(t.output).toEqual({ [s.formId]: { result: '금액 그대로 진행해요.' } })
    const [u] = await db.q('select status, tries, errors from pro_step_ui where todo_id=$1', [s.todoId])
    expect(u.status).toBe('fallback')
    expect(u.tries).toBe(2)
    fake.mode = 'good'
    expect(page.errors).toEqual([])
  })

  test('F-SU-04 휴대폰 390px: 화면이 카드 너비 안, 버튼 줄이 옆으로 넘치지 않는다', async ({ pageAs, db, cleanup }) => {
    fake.mode = 'good'; fake.slowMs = 0
    const page = await pageAs('su-owner', { viewport: PHONE, dpr: 2, touch: true })
    await mapCase(db, cleanup, page.user)
    await page.goto('/chat')
    // a phone opens on Home (its card for the step is there too): the chat tab has the work item's card
    await page.locator('.seg button').filter({ hasText: '채팅' }).click()
    const ui = card(page)
    await expect(ui).toHaveAttribute('data-state', 'ready', { timeout: 20_000 })
    await ui.getByText('금액 조정 후 진행', { exact: true }).click()
    await ui.getByLabel('검토 의견').fill('모바일에서 적은 의견')
    await ui.scrollIntoViewIfNeeded()
    await settled(ui)
    // nothing wider than the screen: the page, the card, every field and button inside it
    const over = await page.evaluate(() => {
      const vw = document.documentElement.clientWidth
      const card = document.querySelector('[data-test="a2ui-step"]')
      const r = card.getBoundingClientRect()
      const wide = [...card.querySelectorAll('input, textarea, button, a2ui-basic-row, a2ui-choicepicker')].map((e) => e.getBoundingClientRect()).filter((b) => b.right > r.right + 1 || b.left < r.left - 1)
      return { page: document.documentElement.scrollWidth - vw, card: r.right - vw, cardLeft: r.left, wide: wide.length }
    })
    expect(over.page).toBeLessThanOrEqual(0)
    expect(over.card).toBeLessThanOrEqual(0)
    expect(over.cardLeft).toBeGreaterThanOrEqual(0)
    expect(over.wide).toBe(0)
    await shot(page, 'f-su-04-phone', ui)
    expect(page.errors).toEqual([])
  })

  test('F-SU-05 낮 · 밤 테마: 화면의 글 · 칸 · 버튼 색이 앱의 테마를 따른다(페이지의 color-scheme 은 그대로)', async ({ pageAs, db, cleanup }) => {
    fake.mode = 'good'; fake.slowMs = 0
    const page = await pageAs('su-owner', { viewport: { width: 1280, height: 1000 } })
    await mapCase(db, cleanup, page.user)
    await page.goto('/chat')
    const ui = card(page)
    await expect(ui).toHaveAttribute('data-state', 'ready', { timeout: 20_000 })
    const look = () => page.evaluate(() => {
      const card = document.querySelector('[data-test="a2ui-step"]')
      const area = card.querySelector('textarea')
      const send = [...card.querySelectorAll('button')].find((b) => b.textContent.includes('검토 결과 보내기'))
      const label = [...card.querySelectorAll('label')].find((l) => l.textContent.includes('검토 의견'))
      const cs = (e) => getComputedStyle(e)
      return { theme: document.documentElement.dataset.theme, rootScheme: cs(document.documentElement).colorScheme, cardScheme: cs(card).colorScheme,
        text: cs(area).color, field: cs(area).backgroundColor, send: cs(send).backgroundColor, sendText: cs(send).color, label: cs(label).color }
    })
    for (const theme of ['dark', 'light']) {
      await page.evaluate((t) => { document.documentElement.dataset.theme = t }, theme)
      await page.waitForTimeout(300)
      const l = await look()
      expect(l.theme).toBe(theme)
      expect(l.rootScheme).toBe('normal')
      expect(l.cardScheme).toBe(theme)
      // dark: light ink on a dark page; light: dark ink
      const lum = (c) => { const [r, g, b] = c.match(/\d+(\.\d+)?/g).map(Number); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 }
      if (theme === 'dark') { expect(lum(l.text)).toBeGreaterThan(0.8); expect(lum(l.send)).toBeGreaterThan(0.8); expect(lum(l.sendText)).toBeLessThan(0.3) }
      else { expect(lum(l.text)).toBeLessThan(0.3); expect(lum(l.send)).toBeLessThan(0.3); expect(lum(l.sendText)).toBeGreaterThan(0.8) }
      await settled(ui)
      await shot(page, `f-su-05-${theme}`, ui)
    }
    expect(page.errors).toEqual([])
  })
})
