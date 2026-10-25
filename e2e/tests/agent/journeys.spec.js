// 에이전트 여정 — 시연 영상의 사용자 흐름을 실제 모델·에이전트로 끝까지. 문구가 아니라 남는 결과(대화 id·행·파일·
// 카드 종류)를 확인한다. 모델 답이 흔들리는 시험은 [flaky] 표시, 프로젝트 설정으로 한 번 더 시도한다.
import { test, expect, api, RUN } from '../../lib/fixtures.js'
import { ask, since, waitFor } from '../../lib/agent.js'
import { makeApp } from '../../lib/panel.js'
import path from 'node:path'
import { removeFolder, PNG, MIME } from '../../lib/seed.js'

// independent journeys (each its own pro-rt-ag-* account): run them side by side
test.describe.configure({ mode: 'parallel' })

const ctxOf = (r) => r.done?.content?.context || null

// the BFF may be restarted by someone working on it: start each journey on a live server
test.beforeEach(async () => {
  await expect.poll(async () => (await api.call(null, 'GET', '/config', null, { timeout: 5000 }).catch(() => ({ status: 0 }))).status, { timeout: 180_000, intervals: [3000] }).toBe(200)
})

test('A-01 [flaky] 대화 맥락 라우터: 주제가 다르면 새 대화, 후속은 원래 대화로 (youtu.be/oL_mfiQBCPU)', async ({ as, db }) => {
  const u = await as('ag-router')
  await db.clearMain(u.id)
  const a = await ask(u, db, '다음 주 부산 출장 가는데 해운대 근처 숙소 3곳만 짧게 추천해줘')
  expect(a.error, JSON.stringify(a.error)).toBeNull()
  const b = await ask(u, db, '우리 회사 유튜브 채널의 새 이름 아이디어 3개만 짧게 줘')
  test.info().annotations.push({ type: 'route', description: JSON.stringify([ctxOf(a), ctxOf(b)]) })
  const c = await ask(u, db, '아까 부산 숙소는 바다가 보이는 곳이면 좋겠어. 그 조건으로 다시 골라줘')
  const [ca, cb, cc] = [ctxOf(a), ctxOf(b), ctxOf(c)]
  test.info().annotations.push({ type: 'route', description: JSON.stringify(cc) })
  expect(ca?.conversationId).toBeTruthy()
  expect(cb?.conversationId).toBeTruthy()
  expect(cb.conversationId, '다른 주제는 다른 대화').not.toBe(ca.conversationId)
  expect(cc?.conversationId, '후속 질문은 숙소 대화로').toBe(ca.conversationId)
  const conv = (await u.get('/conversations')).body.map((x) => x.id)
  expect(conv).toEqual(expect.arrayContaining([ca.conversationId, cb.conversationId]))
})

test('A-02 "새 패널 만들기" 로 데이터 패널 앱이 생긴다 (youtu.be/sXCp1JerNYQ)', async ({ as, db, cleanup }) => {
  const u = await as('ag-panel')
  await db.clearMain(u.id)
  const before = new Set((await u.get('/panel-apps')).body.map((a) => a.id))
  const r = await ask(u, db, `새 패널 만들기: 회귀 휴가 일수 관리 ${RUN} — 팀원 이름, 부여일수, 사용일수, 남은 일수(부여일수-사용일수)`)
  expect(r.error).toBeNull()
  const app = await waitFor(async () => (await u.get('/panel-apps')).body.find((a) => !before.has(a.id)), { timeout: 10 * 60_000 })
  expect(app, '새 앱').toBeTruthy()
  cleanup(async () => { await u.del(`/panel-apps/${app.id}`); await removeFolder(db, app.folder.slug) })
  // the model designs it (a list with 부여·사용 columns, or an event app with 부여·신청 records):
  // what matters is a leave app with day counts
  const design = JSON.stringify(app.def)
  test.info().annotations.push({ type: 'design', description: design.slice(0, 600) })
  expect(app.title).toMatch(/휴가/)
  expect(design).toMatch(/일수/)
  expect(app.def.fields.some((f) => f.type === 'number')).toBe(true)
  const chips = await since(db, r.th, r.t0, 'chip')
  expect(chips.some((m) => m.content.panelAppId === app.id)).toBe(true)
})

test('A-03 [flaky] 채팅으로 할 일 패널에 행 추가: "다음주 월요일에 휴양림 가는 일정 추가"', async ({ as, lib, db, cleanup }) => {
  const u = await as('ag-todo')
  await db.clearMain(u.id)
  for (const a of (await u.get('/panel-apps')).body) if (/^할 일/.test(a.title)) { await u.del(`/panel-apps/${a.id}`); await removeFolder(db, a.folder.slug) }
  const { app } = await makeApp(lib, u, {
    title: '할 일', fields: [{ key: 'task', label: '할 일', type: 'text', required: true }, { key: 'due', label: '날짜', type: 'date' }, { key: 'done', label: '완료', type: 'checkbox' }],
  }).then((x) => { cleanup(() => x.cleanup(db)); return x })
  const r = await ask(u, db, '다음주 월요일에 휴양림 가는 일정 추가')
  expect(r.error).toBeNull()
  const row = await waitFor(async () => (await u.get(`/panel-apps/${app.id}/rows`)).body.rows.find((x) => /휴양림/.test(x.task)), { timeout: 8 * 60_000 })
  expect(row, '할 일 패널에 휴양림 행').toBeTruthy()
  if (row.due) expect(new Date(row.due).getDay()).toBe(1) // a Monday
})

test('A-04 문서 요청 → 문서 카드 → 누르면 이음오피스 편집기 (youtu.be/5J0w5A9ylN0)', async ({ pageAs, db }) => {
  const page = await pageAs('ag-office')
  const u = page.user
  await db.clearMain(u.id)
  const r = await ask(u, db, "회의록 워드 문서(docx)를 하나 만들어줘. 제목은 '회귀 시험 회의록', 안건 두 개와 결정 사항 표를 넣어줘. 질문하지 말고 바로 만들어줘.")
  expect(r.error).toBeNull()
  const file = await waitFor(async () => (await since(db, r.th, r.t0, 'file')).find((m) => /\.(docx|hwpx|hwp)$/i.test(m.content.name || '')), { timeout: 12 * 60_000 })
  expect(file, '문서 카드').toBeTruthy()
  expect(file.content.url).toMatch(/^https?:\/\//)
  await page.goto('/chat')
  await page.locator('button.file', { hasText: file.content.name }).last().click()
  await expect(page.locator('.oef iframe.frm')).toHaveAttribute('src', /^\/office\/(docs|hwp)\//, { timeout: 30_000 })
  await expect(page.locator('.oef .badge.live')).toBeVisible({ timeout: 60_000 })
})

test('A-05 CAD 도면 요청 → CADCraft MCP 로 그린 .dxf 카드 → 웹 CADCraft 로 열림 (youtu.be/QyfrjwhBSsw)', async ({ pageAs, db }) => {
  test.setTimeout(30 * 60_000)
  const page = await pageAs('ag-cad')
  const u = page.user
  await db.clearMain(u.id)
  const r = await ask(u, db, 'CADCraft 로 가로 6m 세로 4m 회의실 평면도를 아주 간단히(벽과 문 하나만) 그려서 dxf 로 저장해줘. 질문하지 말고 바로 해줘.', { timeout: 28 * 60_000 })
  const file = await waitFor(async () => (await since(db, r.th, r.t0, 'file')).find((m) => /\.(dxf|dwg)$/i.test(m.content.name || '')), { timeout: 5 * 60_000 })
  expect(file, 'CAD 카드').toBeTruthy()
  await page.goto('/chat')
  await page.locator('button.file', { hasText: file.content.name }).last().click()
  await expect(page.locator('.cef iframe.frm')).toHaveAttribute('src', /\/craft\/cadcraft\//)
  await expect(page.locator('.cef .badge.live')).toBeVisible({ timeout: 90_000 })
})

test('A-06 [flaky] 열린 PhotoCraft 를 대화로 고친다: 글자 레이어 추가 (youtu.be/izcVNcW37J0)', async ({ pageAs, db }) => {
  const page = await pageAs('ag-live')
  const u = page.user
  const th = await db.clearMain(u.id)
  const png = await api.upload(u.token(), '포스터.png', MIME.png, PNG(320, 180))
  await db.addMessages(th, [{ kind: 'file', content: { name: '포스터.png', url: png.url } }])
  await page.goto('/chat')
  await page.locator('button.file', { hasText: '포스터.png' }).click()
  await expect(page.locator('.cef .badge.live')).toBeVisible({ timeout: 90_000 })
  await api.mcp('/mcp/photocraft', 'tools/call', { name: 'photocraft_start', arguments: {} }, u.token())
  const layers = async () => { const x = await api.mcp('/mcp/photocraft', 'tools/call', { name: 'photocraft_doc_inspect', arguments: {} }, u.token()); return x.body.result.isError ? -1 : (JSON.parse(api.toolText(x)).layers || []).length }
  await expect.poll(layers, { timeout: 60_000 }).toBeGreaterThan(0)
  const n = await layers()
  await page.locator('.foot .composer textarea').click()
  await page.keyboard.type("열린 이미지에 '선착순 50명' 글자 레이어를 노란색으로 하나 추가해줘")
  await page.keyboard.press('Enter')
  await expect.poll(layers, { timeout: 10 * 60_000, intervals: [5000] }).toBeGreaterThan(n)
})

test('A-07 채팅으로 프로세스 찾기 → 프로세스 카드(단계·시작 폼) (youtu.be/wrPlOhwYPcw)', async ({ pageAs, db }) => {
  const page = await pageAs('ag-proc')
  const u = page.user
  await db.clearMain(u.id)
  const r = await ask(u, db, '출장비 정산 프로세스 시작하고 싶어. 시작 양식 보여줘')
  expect(r.error).toBeNull()
  const card = (await since(db, r.th, r.t0, ['process', 'catalog'])).at(-1)
  expect(card, '프로세스/목록 카드').toBeTruthy()
  if (card.kind === 'process') expect(card.content.defId).toBe('pro_expense_claim')
  else expect(JSON.stringify(card.content.items)).toContain('pro_expense_claim')
  await page.goto('/chat')
  expect(page.errors).toEqual([])
})

test('A-08 스킬 만들기 → 스킬 초안 카드(요약·단계) (youtu.be/yVHodTrDwHg)', async ({ as, db, cleanup }) => {
  test.setTimeout(30 * 60_000)
  const u = await as('ag-skill')
  await db.clearMain(u.id)
  // a name of its own each run: a skill folder that already exists is only "checked", no new draft
  const name = `rt-minutes-${RUN}`
  cleanup(async () => {
    const fs = await import('node:fs/promises')
    const { WORKSPACE } = await import('../../lib/env.js')
    for (const d of [path.join(WORKSPACE, '.bpmn', 'skills', name), path.join(WORKSPACE, '.bpmn', '.skill-evals', name)]) await fs.rm(d, { recursive: true, force: true })
    await db.q(`delete from pro_messages where kind='skill_draft' and thread_id=$1`, [await db.mainThreadId(u.id)])
  })
  const r = await ask(u, db, `회의록 글을 받아 결정 사항과 담당자별 할 일을 뽑는 스킬을 만들어줘. 스킬 이름은 ${name} 로 해줘. 질문하지 말고 바로 만들어줘.`, { timeout: 28 * 60_000 })
  const draft = await waitFor(async () => (await since(db, r.th, r.t0, 'skill_draft'))[0], { timeout: 5 * 60_000 })
  expect(draft, `스킬 초안 카드 (에이전트 답: ${String(r.done?.content?.text || '').slice(0, 200)})`).toBeTruthy()
  test.info().annotations.push({ type: 'draft-dir', description: draft.content.dir })
  // the card is the skill that was asked for (not another one lying in a shared folder)
  expect(draft.content.name, `카드의 스킬 (${draft.content.dir})`).toBe(name)
  expect(draft.content.markdown || '').toMatch(/^---[\s\S]*name:/)
  expect(draft.content.state).toBe('draft')
})

test('A-09 예약 요청 → 예약 칩과 예약된 작업 (youtu.be/yVHodTrDwHg)', async ({ as, db, cleanup }) => {
  const u = await as('ag-sched')
  await db.clearMain(u.id)
  const before = new Set((await u.get('/schedules')).body.map((s) => s.id))
  cleanup(async () => { for (const s of (await u.get('/schedules')).body) if (!before.has(s.id)) await u.del(`/schedules/${s.id}`) })
  const r = await ask(u, db, '매일 아침 8시에 서울 날씨를 알려줘')
  expect(r.error).toBeNull()
  const s = await waitFor(async () => (await u.get('/schedules')).body.find((x) => !before.has(x.id)), { timeout: 5 * 60_000 })
  expect(s, '새 예약').toBeTruthy()
  expect(s.cron.split(/\s+/).slice(0, 2)).toEqual(['0', '8'])
  const chip = (await since(db, r.th, r.t0, 'chip')).find((m) => m.content.scheduleId === s.id)
  expect(chip?.content.icon).toBe('clock')
})

test('A-10 [flaky] 채팅으로 공유 폴더 문서 고치기 → 에이전트는 변형에서 일하고 main 은 그대로, 변형 카드 (youtu.be/uam0ffMMu7U)', async ({ as, db, cleanup }) => {
  test.setTimeout(30 * 60_000)
  const u = await as('ag-folder')
  await db.clearMain(u.id)
  const name = `회귀 세미나 ${RUN}`
  const f = await u.post('/folders', { name, description: '회귀 시험 · 세미나 안내' })
  cleanup(() => removeFolder(db, f.body.slug))
  const NOTICE = '# 고객 세미나 안내\n\n일시: 11월 20일\n신청: 현장 접수\n'
  await u.post(`/folders/${f.body.slug}/files?path=${encodeURIComponent('안내문.md')}`, new TextEncoder().encode(NOTICE), { headers: { 'Content-Type': 'text/markdown' } })
  const r = await ask(u, db, `${name} 폴더의 안내문(안내문.md)에 '사전 신청 필수' 문구와 신청 마감일(11월 14일)을 넣어서 고쳐줘`, { timeout: 28 * 60_000 })
  const card = await waitFor(async () => (await since(db, r.th, r.t0, 'folder_variation'))[0], { timeout: 5 * 60_000 })
  expect(card, '변형 카드').toBeTruthy()
  const vs = (await u.get(`/folders/${f.body.slug}`)).body.variations
  expect(vs.length).toBeGreaterThan(0)
  expect((await u.get(`/folders/${f.body.slug}/raw?path=${encodeURIComponent('안내문.md')}`)).text).toBe(NOTICE)
  const v = vs[0]
  const d = await u.get(`/folders/${f.body.slug}/variations/${v.id}/diff?path=${encodeURIComponent('안내문.md')}`)
  expect(d.body.head).toMatch(/사전 신청|11월 14일/)
})
