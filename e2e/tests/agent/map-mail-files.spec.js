// 「지도에서 바로」 건 — 메일로 시작해 사람 단계의 파일을 입력 폼 · 채팅으로 내고, 간선 규칙대로 끝까지(server lib/ontology/stepfiles.js ·
// mapengine.js · edgecond.js). 실제 사용자 흐름 그대로: 설정 › 연습 메일 받기 → 채팅의 시작 카드 → 단계마다 채팅의 「진행」 →
// 사람 단계는 채팅의 할 일 카드(입력 폼)나 채팅 첨부로 내고 → 에이전트가 앞 단계 파일을 읽어 결과를 낸다.
//
// 지도(로컬 Lite localhost 테넌트)의 「정산서 작성 · 재무 승인」 프로세스와 그 간선 규칙을 쓴다:
//   영수증 제출 → 재무 검토: 금액 10만원 이상이면 꼭 · 금액 확인 → 재무 승인: 금액 100만원 이상이면 꼭.
// 일 정의(준비): 「영수증 제출」은 영수증(파일), 「재무 검토」는 법인카드 사용내역(xlsx)을 낸다 — 사람 단계에 파일 칸이 생긴다. 「재무 승인」은 파일 칸 없음.
//
// 건 둘(대전 1,286,000원 · 부산 742,000원), 한 시험에서:
//   A 대전 — 영수증 제출: 두 건이 같은 단계를 기다릴 때 채팅에 「대전 출장 건 영수증 제출 단계 증빙」으로 올림 → A 에만 붙고 B 는 그대로, 새 건 제안 없음
//            재무 검토: 메일의 금액(≥10만)으로 꼭 → 입력 폼의 파일 칸으로 카드 내역을 냄
//            금액 확인(에이전트): 영수증 · 카드 내역 파일의 금액(498,000 · 372,300 …)을 읽어 결과에 → 재무 승인: 메일 금액(≥100만)으로 꼭 → 끝까지
//   기존 기능 — B 가 영수증을 기다리는 중 채팅에 견적 요청서 파일: 단계에 붙지 않고 예전처럼 새 건 시작 제안(묻는 카드면 「새 요청으로」)
//   B 부산 — 영수증 제출: 단계 이름 없이 「영수증이에요」로 올림 → 내기 전에 묻는 카드(아무 단계에도 안 붙음) → 고르면 그 단계로
// 만든 건 · 메일 · 파일은 지우지 않는다(시험 데이터는 남긴다).
//
//   cd e2e && PGPT_URL=http://localhost:8088/lite API_URL=http://localhost:8787 npx playwright test --project=agent tests/agent/map-mail-files.spec.js
//   SHOT_DIR=<폴더> 를 주면 확인하는 순간마다 화면을 그 폴더에 남긴다.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect, RUN } from '../../lib/fixtures.js'
import { PGPT_URL, LOCAL_API } from '../../lib/env.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const FILES = path.resolve(here, '../../fixtures/trip-expense')
const PROC = process.env.RT_MAP_PROC || 'process:4dacd6c9b8'
const A = { template: 'daejeon-trip-expense', subject: '대전 교육 출장비 정산 요청드립니다' }
const B = { template: 'busan-trip-expense', subject: '부산 지사 출장비 정산 요청' }
const DEF = {
  '영수증 제출': `---\nname: 영수증 제출\ndescription: 출장자가 쓴 비용의 영수증 파일을 정산 건에 낸다\nkind: task\nrole: 홍길동\nrunner: person\noutputs:\n  - name: 영수증\n    format: 파일\ncheckpoints: [교통 · 숙박 · 식대 항목마다 영수증이 있다]\n---\n\n## 하는 일\n1. 교통 · 숙박 · 식대 영수증 파일을 올린다.\n2. 영수증이 없는 비용이 있으면 글 칸에 적는다.\n`,
  '재무 검토': `---\nname: 재무 검토\ndescription: 재무 담당자가 법인카드 사용내역을 내고 영수증과 맞는지 검토한다\nkind: task\nrole: 에이전트\nrunner: person\noutputs:\n  - name: 법인카드 사용내역\n    format: xlsx\ncheckpoints: [카드 사용내역과 영수증의 날짜 · 금액이 맞다]\n---\n\n## 하는 일\n1. 출장 기간의 법인카드 사용내역 파일을 올린다.\n2. 영수증과 다른 점이 있으면 글 칸에 적는다.\n`,
}

const at = (p) => new URL(p, `${PGPT_URL}/`).href
let shotN = 0
async function shot(page, name) {
  const dir = process.env.SHOT_DIR
  if (!dir) return
  fs.mkdirSync(dir, { recursive: true })
  await page.screenshot({ path: path.join(dir, `${String(++shotN).padStart(2, '0')}-${name}.png`) })
}

test('지도 건 — 메일로 시작 · 사람 단계 파일(채팅 · 입력 폼) · 간선 규칙대로 끝까지', async ({ pageAs, db, cleanup }) => {
  test.skip(!LOCAL_API, '로컬 Lite 에서만(연습 메일 · 데이터베이스)')
  test.setTimeout(40 * 60_000)
  // 실행마다 새 시험 계정: 앞선 실행의 건(같은 메일 제목)이 이 사람의 기다리는 단계로 섞이지 않게(그 건들은 지우지 않고 남긴다)
  const page = await pageAs(`po-mailfile-${RUN}`, { viewport: { width: 1400, height: 900 } })
  const u = page.user
  // 준비: 관리자(일 정의 저장), 데모 메일함(예전 견본 메일은 읽은 것으로), 화면에 보이는 이름
  await db.q('update users set is_admin=true where id=$1', [u.id]); cleanup(() => db.q('update users set is_admin=false where id=$1', [u.id]))
  await db.q(`insert into pro_mail_accounts(user_id, provider, address) values ($1,'demo',$2) on conflict (user_id) do update set provider='demo'`, [u.id, u.email])
  const fx = JSON.parse(fs.readFileSync(path.resolve(here, '../../../server/fixtures/demo-mail.json'), 'utf8'))
  for (const m of fx) await db.q('insert into pro_mail_seen values ($1,$2) on conflict do nothing', [u.id, m.id])
  await u.post('/profile', { name: '최재무', birth: '1990-01-01', onboarded: true })
  expect((await u.get('/ontology/engine')).body.engine, '테넌트가 「지도에서 바로」 실행').toBe('map')
  for (const [k, md] of Object.entries(DEF)) expect((await u.put(`/ontology/tasks/${encodeURIComponent(k)}/definition`, { definition: md })).status).toBe(200)
  const rules = (await u.get(`/ontology/processes/${encodeURIComponent(PROC)}/edge-conditions`)).body.edges || []
  const rule = (from, to) => rules.find((e) => e.event === `done:${from}` && e.task === to)?.setting?.rules?.[0]?.when?.value
  expect([rule('영수증 제출', '재무 검토'), rule('금액 확인', '재무 승인')], '간선 규칙(10만 · 100만)').toEqual([100000, 1000000])
  const T0 = new Date()

  // DB: 이 사람의 지도 건 · 단계(화면이 아니라 결과 확인용)
  const caseOf = async (subject) => (await db.q(`select id::text as id, status, instances, trigger from pro_po_cases where started_by=$1 and engine='map' and trigger->>'subject'=$2 and created_at > $3 order by created_at desc limit 1`, [u.id, subject, T0]))[0]
  const stepRow = async (c, task) => (await db.q(`select t.id::text as id, t.status::text as status, t.output, s.state, s.requirement, s.via from pro_case_steps s join todolist t on t.id=s.todo_id where s.case_id=$1 and s.task=$2 order by s.created_at desc limit 1`, [c.id, task]))[0]
  const valOf = (row) => Object.values(row?.output || {}).find((x) => x && typeof x === 'object') || {}
  const entryOffers = async () => Number((await db.q(`select count(*) n from pro_messages m join pro_threads t on t.id=m.thread_id where t.user_id=$1 and m.kind='onto-entry' and m.created_at > $2 and m.content->>'source'='file'`, [u.id, T0]))[0].n)

  const chat = page.locator('.foot .composer')
  // a step's ask card of this case (a card of an earlier run with the same subject is not this case's)
  const ask = (c, task) => page.locator(`[data-testid=onto-case-ask][data-case="${c.id}"][data-state=ask][data-task="${task}"]`).last()
  // a step's 「진행」 in chat (제안 단계: 단계마다 사람이 정함)
  async function go(c, task, { timeout = 8 * 60_000 } = {}) {
    const card = ask(c, task)
    // the step's ask comes to the main chat (an input form may have opened another conversation); opened again now and then in case it
    // came while the chat loaded
    const until = Date.now() + timeout
    for (let first = true; ; first = false) {
      if (!first || !(await card.isVisible().catch(() => false))) await page.goto(at('chat'))
      if (await card.waitFor({ state: 'visible', timeout: 45_000 }).then(() => true, () => false)) break
      if (Date.now() > until) await expect(card).toBeVisible({ timeout: 1000 })
    }
    await card.scrollIntoViewIfNeeded()
    await card.getByTestId('onto-case-ask-go').click()
    await expect(card).toHaveCount(0, { timeout: 30_000 })
  }
  // the person's own step opened: its work item is theirs (IN_PROGRESS)
  const opened = async (c, task) => expect.poll(async () => (await stepRow(c, task))?.status, { timeout: 8 * 60_000, intervals: [2000] }).toBe('IN_PROGRESS')
  // a person's step comes to the home list (「입력 · 단계」 card): 「열기」 opens the conversation with its input form
  async function openTodo(c, task, subject) {
    await page.goto(at('chat'))
    const row = await stepRow(c, task)
    const n = page.locator('.nc.workitem', { hasText: task }).filter({ hasText: subject }).first()
    await expect(n).toBeVisible({ timeout: 60_000 })
    await n.getByRole('button', { name: '열기' }).click()
    // (the step's own card came when it opened; 「열기」 brings one more to the chat's end — that one)
    const form = page.locator(`[data-testid=todo-card][data-todo="${row.id}"]`).last()
    await expect(form).toBeVisible({ timeout: 30_000 })
    await form.scrollIntoViewIfNeeded()
    return form
  }
  async function mail(m) {
    await page.goto(at('settings/accounts'))
    const box = page.locator('.practice')
    await box.locator('select').selectOption(m.template)
    await box.getByRole('button', { name: '연습 메일 받기' }).click()
    await expect(box.locator('.said')).toContainText('도착', { timeout: 120_000 })
    // the card comes a moment after the mail is read (the processes are read against it): open the chat, and again if it came while it loaded
    const card = page.locator('[data-testid=onto-entry-card][data-state=ask]', { hasText: m.subject }).last()
    for (let i = 0; ; i++) {
      await page.goto(at('chat'))
      if (await card.waitFor({ state: 'visible', timeout: 30_000 }).then(() => true, () => false)) break
      if (i >= 7) await expect(card).toBeVisible({ timeout: 1000 })
    }
    await expect(card).toContainText('정산서 작성 · 재무 승인')
    await card.scrollIntoViewIfNeeded()
    await shot(page, `메일 시작 카드 ${m.template}`)
    await card.getByTestId('onto-entry-go').click()
    await expect.poll(async () => !!(await caseOf(m.subject)), { timeout: 60_000 }).toBe(true)
    const c = await caseOf(m.subject)
    expect(c.trigger.kind, '메일로 시작한 건').toBe('mail')
    return c
  }
  // 정산서 작성(에이전트) → 영수증 제출(사람) 이 열릴 때까지, 채팅의 「진행」만으로(채팅으로 다시 요청하지 않음)
  async function toReceipts(c, m) {
    // 제안 단계 프로세스: 시작 단계부터 묻는다
    await go(c, '정산서 작성', { timeout: 2 * 60_000 })
    await go(c, '영수증 제출')
    await opened(c, '영수증 제출')
    expect((await stepRow(c, '정산서 작성')).status).toBe('DONE')
  }

  // ---------- 메일 두 통 → 건 둘, 둘 다 「영수증 제출」을 기다린다 ----------
  const ca = await mail(A)
  await toReceipts(ca, A)
  const cb = await mail(B)
  await toReceipts(cb, B)
  // 할 일의 입력 폼에 파일 칸(일 정의의 영수증)이 있다 — 여기서는 폼 대신 이 대화의 채팅으로 낸다
  const recForm = await openTodo(ca, '영수증 제출', A.subject)
  await expect(recForm.getByTestId('form-files')).toBeVisible()
  await shot(page, '영수증 제출 입력 폼(파일 칸)')

  // ---------- A 영수증 제출: 채팅에 올리며 단계를 말한다 → A 에만, 새 건 제안 없음 ----------
  await chat.locator('input[type=file]').setInputFiles([path.join(FILES, 'KTX 승차권 영수증_대전 1117-1119.docx'), path.join(FILES, '숙박 영수증_대전 유성 호텔.docx')])
  await expect(chat.locator('.att:not(.uploading)')).toHaveCount(2, { timeout: 60_000 })
  await chat.locator('textarea').fill('대전 출장 건 영수증 제출 단계 증빙이에요. 식대는 법인카드로 결제해서 재무 검토 때 카드 내역으로 갈음할게요.')
  await chat.getByRole('button', { name: '보내기' }).click()
  await expect(page.getByText(`「영수증 제출」 결과로 냈어요 — ${A.subject}`)).toBeVisible({ timeout: 60_000 })
  // 같은 단계의 입력 폼 카드도 「제출됨」으로 바뀐다(두 길로 같은 단계를 두 번 내지 않게)
  await expect(recForm.getByTestId('form-files')).toHaveCount(0, { timeout: 15_000 })
  await page.getByText(`「영수증 제출」 결과로 냈어요 — ${A.subject}`).scrollIntoViewIfNeeded()
  await shot(page, '채팅으로 영수증 제출')
  const ra = await stepRow(ca, '영수증 제출')
  expect(ra.status).toBe('DONE')
  expect((valOf(ra).files || []).map((f) => f.name).sort()).toEqual(['KTX 승차권 영수증_대전 1117-1119.docx', '숙박 영수증_대전 유성 호텔.docx'])
  expect(valOf(ra).via).toBe('chat')
  const rb0 = await stepRow(cb, '영수증 제출')
  expect([rb0.status, (valOf(rb0).files || []).length], '부산 건 영수증 제출은 그대로').toEqual(['IN_PROGRESS', 0])
  expect(await entryOffers(), '새 건 시작 제안으로 바뀌지 않음').toBe(0)

  // ---------- A 재무 검토: 메일 금액(1,286,000 ≥ 10만)으로 꼭 → 입력 폼의 파일 칸으로 카드 내역 ----------
  const fin = ask(ca, '재무 검토')
  await expect(fin).toBeVisible({ timeout: 4 * 60_000 })
  await expect(fin.getByTestId('onto-case-ask-req')).toHaveAttribute('data-requirement', 'required')
  await shot(page, '재무 검토 꼭(메일 금액)')
  await go(ca, '재무 검토')
  await opened(ca, '재무 검토')
  const rv = (await stepRow(ca, '재무 검토')).id
  const form = await openTodo(ca, '재무 검토', A.subject)
  await form.getByTestId('form-file-input').setInputFiles(path.join(FILES, '법인카드 사용내역_2026-11 기술지원팀.xlsx'))
  await expect(form.getByTestId('form-files')).toHaveAttribute('data-count', '1', { timeout: 60_000 })
  await shot(page, '입력 폼 파일 칸에 카드 내역')
  await form.getByRole('button', { name: '제출' }).click()
  await expect.poll(async () => (await stepRow(ca, '재무 검토'))?.status, { timeout: 30_000 }).toBe('DONE')
  const rr = await stepRow(ca, '재무 검토')
  expect(rr.status).toBe('DONE')
  expect((valOf(rr).files || []).map((f) => f.name)).toEqual(['법인카드 사용내역_2026-11 기술지원팀.xlsx'])

  // ---------- A 금액 확인(에이전트): 두 길로 낸 파일을 읽는다 → 재무 승인(메일 금액 ≥ 100만으로 꼭) ----------
  await go(ca, '금액 확인')
  await expect.poll(async () => (await stepRow(ca, '금액 확인'))?.status, { timeout: 15 * 60_000, intervals: [5000] }).toBe('DONE')
  const amt = String(valOf(await stepRow(ca, '금액 확인')).result || '').replace(/\s/g, '')
  // 영수증(채팅) · 카드 내역(입력 폼)에만 있는 금액
  expect(amt, `금액 확인 결과: ${amt.slice(0, 400)}`).toMatch(/498,?000/)
  expect(amt).toMatch(/372,?300|368,?300|740,?600/)
  const ok = ask(ca, '재무 승인')
  await expect(ok).toBeVisible({ timeout: 4 * 60_000 })
  await expect(ok.getByTestId('onto-case-ask-req')).toHaveAttribute('data-requirement', 'required')
  await shot(page, '재무 승인 꼭(메일 금액)')
  await go(ca, '재무 승인')
  await opened(ca, '재무 승인')
  const apForm = await openTodo(ca, '재무 승인', A.subject)
  // 파일 칸이 없는 단계: 글 칸 하나 그대로
  await expect(apForm.getByTestId('form-files')).toHaveCount(0)
  await apForm.locator('textarea').fill('영수증과 카드 내역 합계가 요청 금액과 같아 승인합니다.')
  await apForm.getByRole('button', { name: '제출' }).click()
  await expect.poll(async () => (await stepRow(ca, '재무 승인'))?.status, { timeout: 30_000 }).toBe('DONE')

  // 안내문 작성(에이전트) → 끝
  await go(ca, '안내문 작성')
  await expect.poll(async () => (await caseOf(A.subject)).status, { timeout: 10 * 60_000, intervals: [5000] }).toBe('done')

  // 건 화면: 단계마다 낸 파일(영수증 둘은 채팅, 카드 내역은 입력 폼)
  await page.goto(at(`process-map?case=${encodeURIComponent(ca.id)}`))
  const files = (task) => page.locator(`[data-testid=onto-case-step][data-task="${task}"] [data-testid=onto-case-step-files]`)
  const older = page.getByTestId('onto-case-older')
  if (await older.count()) await older.click()
  await expect(files('영수증 제출')).toHaveAttribute('data-count', '2', { timeout: 30_000 })
  await expect(files('영수증 제출')).toHaveAttribute('data-via', 'chat')
  await expect(files('재무 검토')).toHaveAttribute('data-count', '1')
  await expect(files('재무 검토')).toHaveAttribute('data-via', 'form')
  await files('영수증 제출').scrollIntoViewIfNeeded()
  await shot(page, '건 화면 단계 파일')
  await page.locator('[data-testid=onto-case-step][data-task="금액 확인"]').scrollIntoViewIfNeeded()
  await shot(page, '건 화면 금액 확인 결과')

  // ---------- 기존 기능: 파일 단계(B 영수증 제출)가 기다리는 중에 파일로 새 요청 → 단계에 붙지 않고 예전처럼 새 건 시작 제안 ----------
  await page.goto(at('chat'))
  const NEW = '견적 요청서_화상회의 장비.txt'
  await chat.locator('input[type=file]').setInputFiles(path.join(FILES, NEW))
  await expect(chat.locator('.att:not(.uploading)')).toHaveCount(1, { timeout: 60_000 })
  await chat.locator('textarea').fill('구매팀에서 온 견적 요청이에요. 이대로 진행해 주세요.')
  await chat.getByRole('button', { name: '보내기' }).click()
  // the step-file reading may see it is no step's file (straight to the offer) or ask first — then 「새 요청으로」
  const offer = page.locator('[data-testid=onto-entry-card][data-state=ask]', { hasText: NEW }).last()
  const newAsk = page.locator('[data-testid=step-file-ask][data-state=asking]').last()
  await expect(offer.or(newAsk)).toBeVisible({ timeout: 120_000 })
  if (await newAsk.isVisible()) {
    await newAsk.scrollIntoViewIfNeeded()
    await shot(page, '새 요청 파일 — 묻는 카드')
    await newAsk.getByTestId('step-file-new').click()
    await expect(page.locator('[data-testid=step-file-ask][data-state=new]').last()).toBeVisible({ timeout: 30_000 })
  }
  for (let i = 0; !(await offer.isVisible().catch(() => false)); i++) {
    if (i) await page.goto(at('chat'))
    if (await offer.waitFor({ state: 'visible', timeout: 30_000 }).then(() => true, () => false)) break
    if (i >= 4) await expect(offer).toBeVisible({ timeout: 1000 })
  }
  await offer.scrollIntoViewIfNeeded()
  await shot(page, '새 요청 파일 — 새 건 시작 제안')
  expect(await entryOffers(), '파일 사건의 새 건 제안 하나').toBe(1)
  const rbN = await stepRow(cb, '영수증 제출')
  expect([rbN.status, (valOf(rbN).files || []).length], '기다리는 단계에 붙지 않음').toEqual(['IN_PROGRESS', 0])

  // ---------- B 영수증 제출: 단계를 말하지 않으면 내기 전에 묻는다 ----------
  await page.goto(at('chat'))
  await chat.locator('input[type=file]').setInputFiles(path.join(FILES, 'KTX 승차권 영수증_부산 1120.docx'))
  await expect(chat.locator('.att:not(.uploading)')).toHaveCount(1, { timeout: 60_000 })
  await chat.locator('textarea').fill('영수증이에요')
  await chat.getByRole('button', { name: '보내기' }).click()
  const q = page.locator('[data-testid=step-file-ask][data-state=asking]').last()
  await expect(q).toBeVisible({ timeout: 90_000 })
  // the turn ends with the card (no agent answer follows)
  await expect(page.getByText('생각하는 중')).toHaveCount(0, { timeout: 30_000 })
  await q.scrollIntoViewIfNeeded()
  await shot(page, '어느 단계인지 묻는 카드')
  const rb1 = await stepRow(cb, '영수증 제출')
  expect([rb1.status, (valOf(rb1).files || []).length], '묻는 동안 아무 단계에도 안 붙음').toEqual(['IN_PROGRESS', 0])
  expect(await entryOffers(), "묻는 카드는 새 건 제안이 아님(앞의 견적 요청 하나만)").toBe(1)
  await q.locator(`[data-testid=step-file-option][data-todo="${rb1.id}"]`).click()
  await expect(page.locator('[data-testid=step-file-ask][data-state=submitted]').last()).toBeVisible({ timeout: 30_000 })
  const rb = await stepRow(cb, '영수증 제출')
  expect(rb.status).toBe('DONE')
  expect((valOf(rb).files || []).map((f) => f.name)).toEqual(['KTX 승차권 영수증_부산 1120.docx'])
  await shot(page, '고른 단계로 냄')
  expect(page.errors).toEqual([])
})
