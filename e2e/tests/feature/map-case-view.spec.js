// 지도에서 바로 도는 건의 인스턴스 화면 — 회사 지도가 아니라 그 건의 BPMN 으로 진행을 본다(2026-11-24: 「프로세스 지도 자체는 가독성이 많이 떨어지기
// 때문에 이메일로 연동되어서 시작하거나 프로세스를 실제 불러서 시작시켰을 때 … BPMN 스냅샷을 보여줘야 됩니다」).
//   - 메일 칩 · Home 카드 · 루틴 목록 · 알림 → /routines/<instId> 에 머문다(회사 지도로 넘기지 않음)
//   - 진행 상황은 다이어그램부터: 건의 BPMN(역할 레인 · 갈림), 단계마다 상태 색과 범례, 넓은 화면은 왼쪽에서 오른쪽, 휴대폰은 위에서 아래
//   - 목록은 같은 읽기의 단계들 — 흐름도의 색과 같은 상태, 「내 입력이 필요해요」 카드는 하나, 건의 방식 · 멈추기와 「이 건 다루기」
//   - 「회사 지도에서 이 건 보기」 → 지도의 건 패널, 거기서 흐름도 「크게 보기」 · 「인스턴스 열기」
//   - 정의가 있는 인스턴스(클래식 · 스냅샷)는 그대로
// 건은 엔진(mapengine.js)이 남기는 모양대로 DB 에 넣는다(server/test/fixtures/map-case-view.mjs — 지어낸 회사 · 사람). 로컬에는 지도 저장소
// (Ontological)가 없어 GET /ontology/cases/:id/flow 만 시험이 대신 답한다: 같은 서버 코드(mapengine.js flowFor — 건의 단계를 읽고 casebpmn.js 로
// BPMN 을 만든다)를 이 시험 프로세스에서 고정 지도로 돌린 응답이다. 나머지(인스턴스 · 건 · 진행 · 할 일)는 실제 서버가 답한다.
// 스펙 openspec/specs/map-case-view · 단위 server/test/map-case-view.test.js
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { test, expect, RUN } from '../../lib/fixtures.js'
import { quoteView, PROC, STEPS, EXPECTED, REQUEST } from '../../../server/test/fixtures/map-case-view.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const SHOTS = path.resolve(here, '../../../openspec/specs/map-case-view/e2e/results')
const PHONE = { width: 390, height: 844 }
const WIDE = { width: 1280, height: 900 }
const actId = (task) => `t_${crypto.createHash('sha1').update(String(task)).digest('hex').slice(0, 10)}`

// every finite animation on the page is over (a picture taken during a fade shows the screen half there)
const calm = (page) => page.evaluate(() => Promise.race([
  Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming?.().iterations !== Infinity).map((a) => a.finished.catch(() => {}))),
  new Promise((ok) => setTimeout(ok, 3000)),
]))
const shot = async (page, name, loc = null) => {
  await calm(page)
  fs.mkdirSync(SHOTS, { recursive: true })
  await (loc || page).screenshot({ path: path.join(SHOTS, `${name}.png`) })
  await (loc || page).screenshot({ path: test.info().outputPath(`${name}.png`) })
}

// A case run straight from the map, as mapengine.js leaves one: its row, its one instance (no definition), a work item and a step row per
// step made (made a minute apart), the person's open step held by `who`; its step screen marked plain (no model asked for it)
async function seedCase(db, cleanup, who) {
  const instId = `onto-map.${crypto.randomUUID()}`
  const bindings = [{ role: '영업', userId: who.id, name: '한지우', from: 'settings' }, { role: '설계', userId: who.id, name: '한지우', from: 'settings' },
    { role: '업무 에이전트', userId: null, name: null, from: 'agent' }]
  const [c] = await db.q(`insert into pro_po_cases (tenant_id, bundle, entry_task, started_by, trigger, instances, engine, request, run_mode, bindings, status)
                          values ($1,$2,'요청 검토',$3,$4,$5,'map',$6,'hitl',$7,'running') returning id::text as id`,
  [db.tenant, PROC.key, who.id, { kind: 'mail', subject: REQUEST.subject, from: REQUEST.sender }, [instId], REQUEST, JSON.stringify(bindings)])
  const name = `${PROC.name} · ${REQUEST.subject}`
  cleanup(async () => {
    await db.q('delete from pro_messages where thread_id in (select id from pro_threads where kind=$1 and ref=$2)', ['process', instId]).catch(() => {})
    await db.q('delete from pro_threads where kind=$1 and ref=$2', ['process', instId]).catch(() => {})
    await db.q('delete from pro_step_ui where proc_inst_id=$1', [instId]).catch(() => {})
    // (멈추기 · 이어 가기 in F-CV-02: the case's run row and its ledger lines)
    await db.q('delete from pro_case_runs where case_id=$1', [c.id]).catch(() => {})
    await db.q(`delete from pro_policy_decisions where tenant_id=$1 and ref='process-ontology' and facts->>'case' = $2`, [db.tenant, c.id]).catch(() => {})
    // (Process GPT's todolist trigger told the step's person: its notices)
    await db.q(`delete from notifications where url in (select '/todolist/' || id::text from todolist where proc_inst_id=$1)`, [instId]).catch(() => {})
    await db.q('delete from pro_case_steps where case_id=$1', [c.id])
    await db.q('delete from todolist where proc_inst_id=$1', [instId])
    await db.q('delete from bpm_proc_inst where proc_inst_id=$1', [instId])
    await db.q('delete from pro_po_cases where id=$1', [c.id])
  })
  await db.q(`insert into bpm_proc_inst (proc_inst_id, proc_inst_name, proc_def_id, tenant_id, status, start_date, participants, current_activity_ids, updated_at)
              values ($1,$2,null,$3,'RUNNING',now() - interval '2 hours',$4,$5,now())`, [instId, name, db.tenant, [who.id], [actId('견적서 작성')]])
  const todos = {}
  let i = 0
  for (const s of STEPS) {
    const agent = s.kind === 'agent'
    const aid = actId(s.task), formId = `onto-map_${aid}_form`
    const done = s.status === 'DONE'
    const [t] = await db.q(`insert into todolist (id, tenant_id, user_id, username, proc_inst_id, root_proc_inst_id, activity_id, activity_name, status, tool, description,
                              agent_orch, agent_mode, output, start_date, end_date)
                            values (gen_random_uuid(),$1,$2,$3,$4,$4,$5,$6,$7,$8,$9,$10,$11,$12, now() - make_interval(mins => $13), $14) returning id::text as id`,
    [db.tenant, agent ? 'pgpt-pro-onto-agent' : who.id, agent ? '업무 에이전트' : '한지우', instId, aid, s.task, s.status, `formHandler:${formId}`, `${s.task} 단계`,
      agent ? 'pgpt-pro-onto' : null, agent ? 'COMPLETE' : null, done ? { [formId]: { result: `${s.task} 끝냈어요` } } : null, 100 - i * 20, done ? new Date(Date.now() - (90 - i * 20) * 60_000) : null])
    todos[s.task] = t.id
    const act = { id: aid, name: s.task, role: agent ? '업무 에이전트' : s.task === '현장 실측' ? '설계' : '영업', runner: agent ? 'agent' : 'person', agentMode: agent ? 'complete' : 'none' }
    await db.q(`insert into pro_case_steps (tenant_id, case_id, proc_inst_id, todo_id, task, kind, mode, state, act, via, created_at)
                values ($1,$2,$3,$4,$5,$6,'hitl','released',$7,$8, now() - make_interval(mins => $9))`,
    [db.tenant, c.id, instId, t.id, s.task, s.kind, act, s.via, 100 - i * 20])
    i++
  }
  await db.q(`insert into pro_step_ui (todo_id, tenant_id, proc_inst_id, status) values ($1,$2,$3,'fallback') on conflict (todo_id) do nothing`, [todos['견적서 작성'], db.tenant, instId])
  return { caseId: c.id, instId, name, todos }
}

// the case's flowchart as GET /ontology/cases/:id/flow answers it — the server's code (mapengine.js flowFor) on the fixed map
async function flowOf(lib, caseId) {
  const R = await lib('lib/ontology/run.js')
  const M = await lib('lib/ontology/mapengine.js')
  return M.flowFor(await R.getCase(caseId), quoteView())
}
async function serveFlow(page, lib, caseId) {
  const flow = await flowOf(lib, caseId)
  await page.route(`**/api/ontology/cases/${caseId}/flow`, (route) => route.fulfill({ json: flow }))
  return flow
}

// a 모닝 브리프 whose mail chip points to the case's instance (the mail started it — lib/mailFlow.js)
async function briefChip(db, who, k) {
  const main = await db.clearMain(who.id)
  await db.q('delete from pro_actions where user_id=$1', [who.id])
  const mailId = `demo-cv-${RUN}-${Math.random().toString(36).slice(2, 6)}`
  const inst = { instId: k.instId, name: k.name }
  const [a] = await db.q(`insert into pro_actions(user_id, verb, text, prompt, source) values ($1,'Reply',$2,'',$3) returning id`,
    [who.id, '가람상사 교육장 인테리어 견적 회신', { mail_id: mailId, from: REQUEST.sender, subject: REQUEST.subject, inst }])
  await db.addMessages(main, [
    { role: 'system', kind: 'divider', content: { text: '모닝 브리프' } },
    { role: 'agent', kind: 'text', content: { text: '가람상사 서다온 님이 교육장 인테리어 견적을 부탁했어요. 견적 요청 처리로 시작했어요.', mails: [{ actionId: a.id, mailId, verb: 'Reply', text: '가람상사 교육장 인테리어 견적 회신', inst }] } },
  ])
  return a.id
}

// the diagram's card just under the top bar (the bar floats over the conversation's top)
const toCard = (page, sel = '[data-test="map-case-card"]') => page.evaluate((q) => { document.querySelector(q).scrollIntoView({ block: 'start' }); document.querySelector('.msgs')?.scrollBy(0, -84) }, sel)
// a diagram drawn and fitted to its box (BpmnView data-ready)
const drawn = (loc) => expect(loc.locator('.bpmn').first()).toHaveAttribute('data-ready', '1', { timeout: 20000 })
const flowBox = (page) => page.locator('[data-test="map-case-card"] [data-testid="onto-case-flow"]')
const node = (page, task) => flowBox(page).locator(`[data-testid="onto-case-flow-node"][data-task="${task}"]`)

test.describe('지도에서 바로 도는 건의 인스턴스 화면 — 건의 BPMN 으로 (spec map-case-view)', () => {
  test.describe.configure({ mode: 'serial' })

  test('F-CV-01 메일 칩으로 연 지도 건: 회사 지도가 아니라 인스턴스 화면, 진행 상황은 건의 BPMN(왼쪽에서 오른쪽) · 상태 색 · 범례 · 레인', async ({ pageAs, db, lib, cleanup }) => {
    const page = await pageAs('cv-owner', { viewport: WIDE })
    const k = await seedCase(db, cleanup, page.user)
    const flow = await serveFlow(page, lib, k.caseId)
    expect(flow.bpmn?.xml, '서버 코드가 이 건의 BPMN 을 만든다').toBeTruthy()
    const actionId = await briefChip(db, page.user, k)
    cleanup(() => db.q('delete from pro_actions where id=$1', [actionId]))

    await page.goto('/chat')
    const chip = page.locator('[data-test="mail-chip-inst"]').first()
    await expect(chip).toContainText(`루틴 · ${k.name}`)
    await shot(page, 'f-cv-01a-chip', page.locator('.center')) // (the conversation only — Home's weather card shows where this machine is)
    await chip.click()
    // the instance page — and it stays there (it used to replace itself with /process-map?proc=…&case=…)
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 15000 }).toBe(`/routines/${encodeURIComponent(k.instId)}`)
    await expect(page.locator('[data-test="instance-map-case"]')).toBeVisible({ timeout: 20000 })
    await page.waitForTimeout(1500)
    expect(new URL(page.url()).pathname).toBe(`/routines/${encodeURIComponent(k.instId)}`)
    await expect(page.getByRole('heading', { name: '회사 프로세스 지도' })).toHaveCount(0)
    await expect(page.locator('h2')).toContainText(k.name)
    await expect(page.locator('.ih .sub')).toContainText('지도에서 바로 도는 건')
    await expect(page.locator('.ih .sub')).toContainText('3/4 단계')

    // 진행 상황 opens on the diagram: the case's BPMN, left to right on a wide page (its card wider than the conversation's column)
    const card = page.locator('[data-test="map-case-card"]')
    await expect(card).toHaveAttribute('data-view', 'bpmn')
    await expect(flowBox(page)).toHaveAttribute('data-bpmn', '1', { timeout: 20000 })
    await expect(flowBox(page)).toHaveAttribute('data-dir', 'LR')
    const cw = (await card.boundingBox()).width
    expect(cw, '넓은 화면: 대화 칸(512px)보다 넓은 카드').toBeGreaterThan(600)
    // every step the case reached carries its state, painted (BpmnView's cs-<state> marker) — the way not taken has none
    for (const [task, st] of Object.entries(EXPECTED)) {
      await expect(node(page, task)).toHaveAttribute('data-state', st, { timeout: 20000 })
      await expect(node(page, task)).toHaveClass(new RegExp(`\\bcs-${st}\\b`))
    }
    await expect(node(page, '정밀 견적')).toHaveAttribute('data-state', '')
    // lanes per role with the person the case bound (영업 · 한지우), the agent's own lane; the split after 현장 실측
    const lanes = (await flowBox(page).locator('.djs-element[data-element-id^="Lane"] text').allTextContents()).join(' ')
    expect(lanes).toContain('영업 · 한지우')
    expect(lanes).toContain('업무 에이전트')
    await expect(flowBox(page).locator('.djs-element[data-element-id^="g_"]:not([data-element-id$="_label"])')).toHaveCount(1)
    // the legend
    const legend = flowBox(page).getByTestId('onto-case-flow-legend')
    for (const w of ['끝남', '사람 차례', '다음']) await expect(legend).toContainText(w)
    // the page's own column does not scroll sideways
    const sideways = await page.locator('.msgs').evaluate((el) => el.scrollWidth - el.clientWidth)
    expect(sideways).toBeLessThanOrEqual(1)
    await drawn(flowBox(page))
    await toCard(page)
    await shot(page, 'f-cv-01b-instance-bpmn')
    expect(page.errors).toEqual([])
  })

  test('F-CV-02 목록과 다이어그램은 같은 상태 — 서버의 단계 · 흐름도의 색 · 목록, 「내 입력이 필요해요」 카드 하나, 건의 방식 · 멈추기 · 이 건 다루기', async ({ pageAs, db, lib, cleanup }) => {
    const page = await pageAs('cv-owner', { viewport: WIDE })
    const k = await seedCase(db, cleanup, page.user)
    const flow = await serveFlow(page, lib, k.caseId)
    // the server's instance page data (GET /instances/:id): its steps are the case's work items with the flowchart's own state
    const inst = (await page.user.get(`/instances/${encodeURIComponent(k.instId)}`)).body
    expect(inst.mapCase).toMatchObject({ id: k.caseId, proc: PROC.key, engine: 'map' })
    expect(inst.def).toBeNull()
    const byFlow = Object.fromEntries(flow.nodes.map((n) => [n.key, n.state]))
    expect(inst.steps.map((s) => [s.name, s.caseState])).toEqual(STEPS.map((s) => [s.task, byFlow[s.task]]))
    expect(inst.steps.filter((s) => s.mine).map((s) => s.todoId)).toEqual([k.todos['견적서 작성']])

    await page.goto(`/routines/${encodeURIComponent(k.instId)}`)
    await expect(flowBox(page)).toHaveAttribute('data-bpmn', '1', { timeout: 20000 })
    const painted = {}
    for (const s of STEPS) painted[s.task] = await node(page, s.task).getAttribute('data-state')
    // 목록: the case's steps (the run view — the same reading), each with the diagram's state
    await page.locator('[data-test="map-case-card"] .seg button[data-view="list"]').click()
    await expect(page.locator('[data-test="map-case-card"]')).toHaveAttribute('data-view', 'list')
    await expect(flowBox(page)).toHaveCount(0)
    const list = page.locator('[data-test="map-case-card"] [data-testid="onto-case-run"][data-part="steps"]')
    for (const s of STEPS) await expect(list.locator(`[data-testid="onto-case-step"][data-task="${s.task}"]`)).toHaveAttribute('data-state', painted[s.task], { timeout: 20000 })
    const mineRow = list.locator(`[data-testid="onto-case-step"][data-task="견적서 작성"]`)
    await expect(mineRow).toHaveAttribute('data-mine', '1')
    await expect(mineRow.getByTestId('onto-case-mine')).toHaveText('내 입력이 필요해요')
    // the step's form once, under 「내 입력이 필요해요」 (not again inside the list)
    await expect(list.getByTestId('onto-case-todo')).toHaveCount(0)
    await expect(page.locator('.ih .mine')).toHaveCount(1)
    await expect(page.locator('.ih .mine .ch')).toContainText('내 입력이 필요해요')
    await expect(page.locator('.ih .mine textarea').first()).toBeVisible({ timeout: 20000 })
    // the case's controls under the diagram: its mode and 멈추기 (the owner); 「이 건 다루기」: who does each role, the map pin, 옮기기
    const ctl = page.locator('[data-test="map-case-controls"] [data-testid="onto-case-run"][data-part="controls"]')
    await expect(ctl.getByTestId('onto-case-mode')).toContainText('단계마다 사람이 정해요')
    await expect(ctl.getByTestId('onto-case-engine')).toContainText('지도에서 바로')
    await expect(ctl.getByTestId('onto-case-pause')).toBeVisible()
    await expect(ctl.locator('[data-testid="onto-case-step"]')).toHaveCount(0)
    const manage = page.locator('[data-testid="map-case-manage"]')
    await expect(manage.getByTestId('onto-case-bindings')).toContainText('한지우')
    await expect(manage.getByTestId('onto-case-pin')).toBeVisible()
    await expect(manage.getByTestId('onto-case-move-open')).toBeVisible()
    await toCard(page)
    await shot(page, 'f-cv-02a-list')
    await page.evaluate(() => document.querySelector('.ih .mine').scrollIntoView({ block: 'center' }))
    await shot(page, 'f-cv-02b-controls-todo')
    // 멈추기 (the owner) → the case is paused, and the controls say so
    await ctl.getByTestId('onto-case-pause').click()
    await expect(ctl).toHaveAttribute('data-paused', '1', { timeout: 15000 })
    await expect(ctl.getByTestId('onto-case-resume')).toBeVisible()
    await ctl.getByTestId('onto-case-resume').click()
    await expect(ctl).toHaveAttribute('data-paused', '0', { timeout: 15000 })
    expect(page.errors).toEqual([])
  })

  test('F-CV-03 「회사 지도에서 이 건 보기」 → 지도의 건 패널, 거기서 흐름도 「크게 보기」(왼쪽에서 오른쪽) · 「인스턴스 열기」로 돌아옴', async ({ pageAs, db, lib, cleanup }) => {
    const page = await pageAs('cv-owner', { viewport: WIDE })
    const k = await seedCase(db, cleanup, page.user)
    await serveFlow(page, lib, k.caseId)
    await page.goto(`/routines/${encodeURIComponent(k.instId)}`)
    const link = page.locator('[data-test="map-case-map-link"]')
    await expect(link).toHaveText('회사 지도에서 이 건 보기 →')
    await expect(link).toHaveAttribute('href', `/process-map?proc=${encodeURIComponent(PROC.key)}&case=${encodeURIComponent(k.caseId)}`)
    // (a server started without a map store — PRO_ONTOLOGY_BOLT_URL= — sends the map page on to 루틴: say the map is there, as it is where
    // map cases run; the map's own reading is not what this checks)
    await page.route('**/api/ontology/status', (route) => route.fulfill({ json: { enabled: true, admin: false, mail: null, build: null, meta: null } }))
    await link.click()
    await expect.poll(() => { const u = new URL(page.url()); return `${u.pathname}?proc=${u.searchParams.get('proc')}&case=${u.searchParams.get('case')}` }, { timeout: 15000 })
      .toBe(`/process-map?proc=${PROC.key}&case=${k.caseId}`)
    await expect(page.getByRole('heading', { name: '회사 프로세스 지도' })).toBeVisible({ timeout: 20000 })

    // the map with its case panel (this machine has no map store: the dev server's sample map, the case itself from the server)
    await page.goto(`/process-map?mock=1&case=${encodeURIComponent(k.caseId)}`)
    const panel = page.getByTestId('onto-case-panel')
    await expect(panel).toBeVisible({ timeout: 20000 })
    const mapSec = panel.getByTestId('onto-case-map')
    await expect(mapSec.getByTestId('onto-case-flow')).toHaveAttribute('data-bpmn', '1', { timeout: 20000 })
    await expect(mapSec.getByTestId('onto-case-flow')).toHaveAttribute('data-dir', 'TB') // the side panel is narrow
    const big = mapSec.getByTestId('onto-case-flow-big')
    await expect(big).toBeVisible()
    await drawn(mapSec)
    await shot(page, 'f-cv-03a-map-panel')
    await big.click()
    const dialog = page.locator('.bpmn.big')
    await expect(dialog).toBeVisible()
    await expect(dialog.locator('.djs-element[data-element-id="Participant"]')).toBeVisible()
    // 크게 보기 draws it left to right: wider than tall
    await expect(dialog).toHaveAttribute('data-ready', '1', { timeout: 20000 })
    await page.waitForTimeout(500)
    const pool = await dialog.locator('.djs-element[data-element-id="Participant"]').boundingBox()
    expect(pool.width).toBeGreaterThan(pool.height)
    await expect(dialog.locator(`[data-testid="onto-case-flow-node"][data-task="견적서 작성"]`)).toHaveAttribute('data-state', 'person')
    await shot(page, 'f-cv-03b-map-big')
    await dialog.getByTestId('bpmn-big').click()
    await expect(dialog).toHaveCount(0)
    // 「인스턴스 열기」 → the instance page
    await mapSec.getByTestId('onto-case-open-inst').click()
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 15000 }).toBe(`/routines/${encodeURIComponent(k.instId)}`)
    await expect(page.locator('[data-test="instance-map-case"]')).toBeVisible({ timeout: 20000 })
    expect(page.errors).toEqual([])
  })

  test('F-CV-04 루틴 목록 · Home 카드 · 알림에서 연 지도 건도 인스턴스 화면', async ({ pageAs, db, lib, cleanup }) => {
    const page = await pageAs('cv-owner', { viewport: WIDE })
    const k = await seedCase(db, cleanup, page.user)
    await serveFlow(page, lib, k.caseId)
    const at = () => new URL(page.url()).pathname
    const want = `/routines/${encodeURIComponent(k.instId)}`
    // the routine list: the Lite case opens its instance page (no longer the map)
    await page.goto('/routines')
    const item = page.locator(`[data-testid="instance-map-case"][data-inst="${k.instId}"]`)
    await expect(item).toBeVisible({ timeout: 20000 })
    await item.click()
    await expect.poll(at, { timeout: 15000 }).toBe(want)
    await expect(page.locator('[data-test="instance-map-case"]')).toBeVisible({ timeout: 20000 })
    await page.waitForTimeout(1000)
    expect(at()).toBe(want)
    // Home: the step's card (the work item's notice — Process GPT's trigger makes one — or its to-do card)
    await page.goto('/chat')
    const home = page.locator('[data-test="notice-card"], [data-test="todo-card"]').filter({ hasText: '견적서 작성' }).first()
    await expect(home).toBeVisible({ timeout: 20000 })
    await shot(page, 'f-cv-04-home-card', home)
    const open = home.getByRole('button', { name: '열기' })
    if (await open.count()) await open.click()
    else await home.click()
    await expect.poll(at, { timeout: 15000 }).toBe(want)
    await expect(page.locator('[data-test="instance-map-case"]')).toBeVisible({ timeout: 20000 })
    // a notification (a browser notification clicked: the work item's)
    await page.goto('/chat')
    await expect(home).toBeVisible({ timeout: 20000 }) // (the page is up: its listener is there)
    await page.evaluate((instId) => window.dispatchEvent(new CustomEvent('pgl:open-notification', { detail: { type: 'workitem', instId } })), k.instId)
    await expect.poll(at, { timeout: 15000 }).toBe(want)
    await expect(page.locator('[data-test="instance-map-case"]')).toBeVisible({ timeout: 20000 })
    // the old address (/projects/p/<instId>) too
    await page.goto(`/projects/p/${encodeURIComponent(k.instId)}`)
    await expect.poll(at, { timeout: 15000 }).toBe(want)
    await expect(page.locator('[data-test="instance-map-case"]')).toBeVisible({ timeout: 20000 })
    expect(page.errors).toEqual([])
  })

  test('F-CV-08 채팅에서 시작한 건: 시작 카드의 「인스턴스 열기」 → 그 건의 인스턴스 화면(건 보기는 그대로)', async ({ pageAs, db, lib, cleanup }) => {
    const page = await pageAs('cv-owner', { viewport: WIDE })
    const k = await seedCase(db, cleanup, page.user)
    await serveFlow(page, lib, k.caseId)
    // the card a mail's start asks with, after 「진행」 (routes/ontology.js keepOnCard: state started · caseId · instId)
    const main = await db.clearMain(page.user.id)
    await db.addMessages(main, [{ role: 'agent', kind: 'onto-entry', content: {
      state: 'started', source: 'mail', customer: REQUEST.customer, mail: { subject: REQUEST.subject, from: REQUEST.sender },
      choice: { proc: PROC.key, procName: PROC.name, task: '요청 검토', p: 0.82, measured: true, options: [{ task: '요청 검토', p: 0.82 }] },
      caseId: k.caseId, instId: k.instId, nodes: ['요청 검토', '단가 조회', '현장 실측', '견적서 작성', '고객 회신'], skipped: [] } }])
    await page.goto('/chat')
    const card = page.getByTestId('onto-entry-card').filter({ hasText: REQUEST.subject })
    await expect(card).toHaveAttribute('data-state', 'started', { timeout: 20000 })
    await expect(card.getByTestId('onto-entry-case')).toBeVisible()
    await shot(page, 'f-cv-08-entry-card', card)
    await card.getByTestId('onto-entry-open-inst').click()
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 15000 }).toBe(`/routines/${encodeURIComponent(k.instId)}`)
    await expect(flowBox(page)).toHaveAttribute('data-bpmn', '1', { timeout: 20000 })
    await expect(node(page, '견적서 작성')).toHaveAttribute('data-state', 'person', { timeout: 20000 })
    expect(page.errors).toEqual([])
  })

  // 2026-11-25 사용자: 「프로세스 지도 이벤트가 인식되었을때 카드가 나타나는거 좋다. 그런데 해당 프로세스가 어떻게 돌아가는지 알아야 선택하므로,
  // 해당 프로세스 정의 스냅샷을 열어볼 수 있도록 해줘야」 — the 「제안」 card asks before it starts; 「흐름 보기」 opens the snapshot the engine
  // would run from the suggested start (the map's 스냅샷 보기 — GET /ontology/snapshot, answered here with a saved definition: locally there is
  // no map store), in the card's sheet, before anything is chosen
  test('F-CV-09 「제안」 카드의 「흐름 보기」 — 고르기 전에 그 프로세스가 도는 단계(스냅샷 BPMN)를 본다, 휴대폰에서도', async ({ pageAs, db, lib, cleanup }) => {
    const CB = await lib('lib/ontology/casebpmn.js')
    const { processDefinition: pd } = CB.caseContract(quoteView(), { entry: '요청 검토', horizontal: false })
    const DEF = `rt_cv_snap_${RUN}`.toLowerCase()
    pd.processDefinitionId = DEF
    const els = (k) => pd.elements.filter((e) => e.elementType === k)
    const definition = {
      processDefinitionId: DEF, processDefinitionName: `회귀 견적 스냅샷 ${RUN}`, roles: pd.roles,
      activities: els('Activity').map((e) => ({ id: e.id, name: e.name, type: 'userTask', role: e.role, agentMode: 'none' })),
      gateways: els('Gateway').map((e) => ({ id: e.id, name: e.name, type: 'exclusiveGateway' })),
      events: els('Event').map((e) => ({ id: e.id, name: e.name, type: e.type === 'StartEvent' ? 'startEvent' : 'endEvent' })),
      sequences: els('Sequence').map((e) => ({ id: e.id, source: e.source, target: e.target })),
    }
    const page = await pageAs('cv-owner', { viewport: WIDE })
    await db.q(`insert into proc_def (id, name, definition, bpmn, type, tenant_id, owner, isdeleted) values ($1,$2,$3,$4,'bpmn',$5,$6,false)`,
      [DEF, `회귀 견적 스냅샷 ${RUN}`, definition, CB.createBpmnXml(pd, true), db.tenant, page.user.id])
    cleanup(async () => { await db.q('delete from proc_def where id=$1', [DEF]) })
    let asked = null
    await page.route('**/api/ontology/snapshot?*', (route) => {
      asked = new URL(route.request().url()).searchParams
      return route.fulfill({ json: { procDefId: DEF, theta: 0.6, nodes: ['요청 검토', '단가 조회', '현장 실측', '견적서 작성', '고객 회신'], skipped: [], reused: true } })
    })
    await page.route('**/api/ontology/start-bindings?*', (route) => route.fulfill({ json: { bindings: [] } }))
    const main = await db.clearMain(page.user.id)
    await db.addMessages(main, [{ role: 'agent', kind: 'onto-entry', content: {
      state: 'ask', source: 'chat', customer: REQUEST.customer, mail: { subject: REQUEST.subject, from: REQUEST.sender },
      choice: { proc: PROC.key, procName: PROC.name, task: '요청 검토', p: 0.56, suggest: true, options: [{ task: '요청 검토', p: 0.56 }, { task: '단가 조회', p: 0.21 }] } } }])
    await page.goto('/chat')
    const card = page.getByTestId('onto-entry-card').filter({ hasText: REQUEST.subject })
    await expect(card.getByTestId('onto-entry-suggest')).toBeVisible({ timeout: 20000 })
    const open = async () => {
      await card.getByTestId('onto-entry-flow').click()
      await expect(page.locator('.djs-container').first()).toBeVisible({ timeout: 20000 })
      await drawn(page)
      await expect(page.getByText('요청 접수 → 요청 검토 → 단가 조회 → 현장 실측 → 견적서 작성 → 고객 회신')).toBeVisible()
      await expect(page.locator(`.djs-element[data-element-id="${actId('견적서 작성')}"]`).first()).toBeAttached()
    }
    await open()
    expect(asked?.get('proc')).toBe(PROC.key)
    expect(asked?.get('entry'), '제안한 시작 일부터의 스냅샷').toBe('요청 검토')
    await shot(page, 'f-cv-09-flow')
    // nothing was chosen: closing the sheet leaves the card asking
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('onto-sheet')).toHaveCount(0)
    await expect(card).toHaveAttribute('data-state', 'ask')
    // a phone: the same, inside the screen
    await page.setViewportSize(PHONE)
    await page.goto('/chat')
    await page.locator('.seg button').filter({ hasText: '채팅' }).first().click()
    await expect(card.getByTestId('onto-entry-suggest')).toBeVisible({ timeout: 20000 })
    await open()
    const box = await page.getByTestId('onto-sheet').boundingBox()
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(PHONE.width + 1)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
    await shot(page, 'f-cv-09-flow-phone')
    expect(page.errors).toEqual([])
  })

  test('F-CV-05 정의가 있는 인스턴스(클래식 · 스냅샷)는 그대로: 목록부터, 다이어그램은 정의의 BPMN, 병목 링크 · 회사 지도 링크 없음', async ({ pageAs, db, lib, cleanup }) => {
    const page = await pageAs('cv-owner', { viewport: WIDE })
    // a definition as Process GPT stores one (activities · gateways · events · sequences, and its BPMN — the contract and XML a snapshot
    // makes, casebpmn.js), and an instance of it
    const CB = await lib('lib/ontology/casebpmn.js')
    const { processDefinition: pd } = CB.caseContract(quoteView(), { entry: '요청 검토', horizontal: false })
    const DEF = `rt_cv_classic_${RUN}`.toLowerCase()
    const INST = `${DEF}.${crypto.randomUUID()}`
    pd.processDefinitionId = DEF
    const els = (t) => pd.elements.filter((e) => e.elementType === t)
    const definition = {
      processDefinitionId: DEF, processDefinitionName: `회귀 견적 정의 ${RUN}`, roles: pd.roles,
      activities: els('Activity').map((e) => ({ id: e.id, name: e.name, type: 'userTask', role: e.role, agentMode: 'none' })),
      gateways: els('Gateway').map((e) => ({ id: e.id, name: e.name, type: 'exclusiveGateway' })),
      events: els('Event').map((e) => ({ id: e.id, name: e.name, type: e.type === 'StartEvent' ? 'startEvent' : 'endEvent' })),
      sequences: els('Sequence').map((e) => ({ id: e.id, source: e.source, target: e.target })),
    }
    await db.q(`insert into proc_def (id, name, definition, bpmn, type, tenant_id, owner, isdeleted) values ($1,$2,$3,$4,'bpmn',$5,$6,false)`,
      [DEF, `회귀 견적 정의 ${RUN}`, definition, CB.createBpmnXml(pd, true), db.tenant, page.user.id])
    await db.q(`insert into bpm_proc_inst (proc_inst_id, proc_inst_name, proc_def_id, tenant_id, status, start_date, participants, current_activity_ids, updated_at)
                values ($1,$2,$3,$4,'RUNNING',now() - interval '1 hour',$5,$6,now())`, [INST, `회귀 견적 · ${RUN}`, DEF, db.tenant, [page.user.id], [actId('단가 조회')]])
    await db.q(`insert into todolist (id, tenant_id, user_id, proc_inst_id, root_proc_inst_id, proc_def_id, activity_id, activity_name, status, start_date, end_date)
                values (gen_random_uuid(),$1,$2,$3,$3,$4,$5,'요청 검토','DONE', now() - interval '50 minutes', now() - interval '40 minutes')`, [db.tenant, page.user.id, INST, DEF, actId('요청 검토')])
    cleanup(async () => {
      await db.q('delete from pro_messages where thread_id in (select id from pro_threads where kind=$1 and ref=$2)', ['process', INST]).catch(() => {})
      await db.q('delete from pro_threads where kind=$1 and ref=$2', ['process', INST]).catch(() => {})
      await db.q('delete from todolist where proc_inst_id=$1', [INST])
      await db.q('delete from bpm_proc_inst where proc_inst_id=$1', [INST])
      await db.q('delete from proc_def where id=$1', [DEF])
    })
    let flowAsked = 0
    await page.route('**/api/ontology/cases/*/flow', (route) => { flowAsked++; return route.abort() })
    await page.goto(`/routines/${encodeURIComponent(INST)}`)
    await expect(page.locator('[data-test="instance-definition"]')).toBeVisible({ timeout: 20000 })
    const card = page.locator('[data-test="instance-card"]')
    await expect(card).toHaveAttribute('data-view', 'list')
    await expect(card.locator('.tl li').filter({ hasText: '요청 검토' })).toHaveClass(/\bdone\b/)
    await expect(card.locator('.bpmn')).toHaveCount(0) // 목록 shows the list only
    await expect(page.getByRole('link', { name: '이 프로세스의 병목·크리티컬 패스 보기 →' })).toBeVisible()
    await expect(page.locator('[data-test="map-case-map-link"]')).toHaveCount(0)
    await expect(page.locator('[data-test="map-case-controls"], [data-testid="map-case-manage"], [data-testid="onto-case-flow"]')).toHaveCount(0)
    await shot(page, 'f-cv-05a-classic-list')
    await card.locator('.seg button[data-view="bpmn"]').click()
    await expect(card.locator('.djs-container')).toBeVisible({ timeout: 20000 })
    await expect(card.locator(`.djs-element[data-element-id="${actId('요청 검토')}"]`)).toHaveClass(/st-done/, { timeout: 20000 })
    await expect(card.getByTestId('onto-case-flow')).toHaveCount(0)
    await drawn(card)
    expect((await card.boundingBox()).width, '정의의 카드는 대화 칸 너비 그대로').toBeLessThanOrEqual(520)
    await shot(page, 'f-cv-05b-classic-diagram')
    expect(flowAsked, '정의가 있는 인스턴스는 건의 흐름도를 묻지 않는다').toBe(0)
    expect(page.errors).toEqual([])
  })

  test('F-CV-06 휴대폰(390px): 흐름도는 위에서 아래로, 페이지는 옆으로 넘치지 않음 · ‹ 로 닫기', async ({ pageAs, db, lib, cleanup }) => {
    const page = await pageAs('cv-owner', { viewport: PHONE, touch: true, dpr: 2 })
    const k = await seedCase(db, cleanup, page.user)
    await serveFlow(page, lib, k.caseId)
    await page.goto('/routines')
    await page.locator(`[data-testid="instance-map-case"][data-inst="${k.instId}"]`).click()
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 15000 }).toBe(`/routines/${encodeURIComponent(k.instId)}`)
    await expect(flowBox(page)).toHaveAttribute('data-bpmn', '1', { timeout: 20000 })
    await expect(flowBox(page)).toHaveAttribute('data-dir', 'TB')
    await expect(node(page, '견적서 작성')).toHaveAttribute('data-state', 'person', { timeout: 20000 })
    const card = page.locator('[data-test="map-case-card"]')
    const box = await card.boundingBox()
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(PHONE.width)
    // top to bottom: the pool is taller than wide
    const pool = await flowBox(page).locator('.djs-element[data-element-id="Participant"]').boundingBox()
    expect(pool.height).toBeGreaterThan(pool.width)
    const over = await page.evaluate(() => {
      const m = document.querySelector('.msgs')
      return { doc: document.documentElement.scrollWidth - window.innerWidth, col: m.scrollWidth - m.clientWidth }
    })
    expect(over.doc, '페이지가 옆으로 넘치지 않는다').toBeLessThanOrEqual(0)
    expect(over.col, '대화 칸이 옆으로 넘치지 않는다').toBeLessThanOrEqual(1)
    await drawn(flowBox(page))
    await toCard(page)
    await shot(page, 'f-cv-06a-phone-bpmn')
    await page.locator('[data-test="map-case-card"] .seg button[data-view="list"]').click()
    await expect(page.locator('[data-test="map-case-card"] [data-testid="onto-case-step"]').first()).toBeVisible({ timeout: 20000 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
    await shot(page, 'f-cv-06b-phone-list')
    await page.locator('[data-test="instance-close"]').click()
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 15000 }).toBe('/routines')
    expect(page.errors).toEqual([])
  })

  test('F-CV-07 밤 테마: 흐름도 · 범례 · 칸이 어두운 화면의 색을 따른다', async ({ pageAs, db, lib, cleanup }) => {
    const page = await pageAs('cv-owner', { viewport: WIDE })
    const k = await seedCase(db, cleanup, page.user)
    await serveFlow(page, lib, k.caseId)
    await page.goto(`/routines/${encodeURIComponent(k.instId)}`)
    await expect(node(page, '견적서 작성')).toHaveAttribute('data-state', 'person', { timeout: 20000 })
    await drawn(flowBox(page))
    const lum = (c) => { const [r, g, b] = c.match(/\d+(\.\d+)?/g).map(Number); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 }
    const seen = {}
    for (const theme of ['dark', 'light']) {
      await page.evaluate((t) => { document.documentElement.dataset.theme = t }, theme)
      await page.waitForTimeout(400)
      seen[theme] = await page.evaluate(() => {
        const q = (s) => document.querySelector(`[data-test="map-case-card"] ${s}`)
        const cs = (e) => getComputedStyle(e)
        return { label: cs(q('[data-testid="onto-case-flow-node"][data-task="요청 검토"] text')).fill, title: cs(q('[data-testid="onto-case-flow-title"]')).color,
          legend: cs(q('[data-testid="onto-case-flow-legend"] span')).color, person: cs(q('[data-testid="onto-case-flow-node"][data-task="견적서 작성"] .djs-visual > rect')).stroke }
      })
      await toCard(page)
      await shot(page, `f-cv-07-${theme}`)
    }
    // dark: light ink on the dark card; light: dark ink — the step names, the heading and the legend follow the theme
    expect(lum(seen.dark.label)).toBeGreaterThan(0.7)
    expect(lum(seen.light.label)).toBeLessThan(0.35)
    for (const k of ['title', 'legend']) expect(lum(seen.dark[k]) - lum(seen.light[k]), k).toBeGreaterThan(0.2)
    // the person's step keeps its colour (the info blue) in both
    expect(seen.dark.person).not.toBe('none')
    expect(page.errors).toEqual([])
  })
})
