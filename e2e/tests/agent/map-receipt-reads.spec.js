// 「지도에서 바로」 건 — 사람 단계에 받은 그대로의 PDF · 사진 영수증을 내면 뒤 에이전트 단계가 읽고 금액을 맞춰 본다(server
// lib/ontology/fileread.js · stepfiles.js fileRead · run.js mapPrev). 실제 사용자 흐름 그대로: 설정 › 연습 메일 받기(광주 출장비 정산) →
// 채팅의 시작 카드 → 단계마다 채팅의 「진행」 → 사람 단계는 할 일 카드(입력 폼)나 채팅 첨부로 낸다.
//
// 지도(로컬 Lite localhost 테넌트)의 「정산서 작성 · 재무 승인」 프로세스와 간선 규칙(map-mail-files.spec.js 와 같음):
//   영수증 제출 → 재무 검토: 금액 10만원 이상이면 꼭 · 금액 확인 → 재무 승인: 금액 100만원 이상이면 꼭.
// 메일에는 합계(1,054,400원)만 있다 — 항목 금액은 파일에만 있다:
//   영수증 제출(입력 폼): 글 PDF(KTX 93,600) · 스캔 PDF(숙박 176,000) · 사진(식대 784,800)
//   재무 검토(채팅): 카드사의 암호 걸린 이용내역서 PDF — 읽지 못한다
//   금액 확인(에이전트): 세 파일의 금액이 결과에, 이용내역서는 읽지 못했다는 표시 → 재무 승인(사람, 파일 칸 없음)에서 금액 확정 → 끝까지
// 만든 건 · 메일 · 파일은 지우지 않는다(시험 데이터는 남긴다). 영수증은 fixtures/trip-expense/make-pdf-photo-receipts.mjs 로 만들었다.
//
//   cd e2e && PGPT_URL=http://localhost:8088/lite API_URL=http://localhost:8787 PGPT_DB_URL=… npx playwright test --project=agent tests/agent/map-receipt-reads.spec.js
//   SHOT_DIR=<폴더> 를 주면 확인하는 순간마다 화면을 그 폴더에 남긴다.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect, RUN } from '../../lib/fixtures.js'
import { PGPT_URL, LOCAL_API } from '../../lib/env.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const FILES = path.resolve(here, '../../fixtures/trip-expense')
const PROC = process.env.RT_MAP_PROC || 'process:4dacd6c9b8'
const G = { template: 'gwangju-trip-expense', subject: '광주 고객사 세미나 출장비 정산 요청드립니다' }
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

test('지도 건 — 사람 단계에 낸 글 PDF · 스캔 PDF · 사진 · 암호 PDF 를 뒤 에이전트 단계가 읽고 끝까지', async ({ pageAs, db, cleanup }) => {
  test.skip(!LOCAL_API, '로컬 Lite 에서만(연습 메일 · 데이터베이스)')
  test.setTimeout(40 * 60_000)
  // 실행마다 새 시험 계정: 앞선 실행의 건(같은 메일 제목)이 이 사람의 기다리는 단계로 섞이지 않게(그 건들은 지우지 않고 남긴다)
  const page = await pageAs(`po-receipt-${RUN}`, { viewport: { width: 1400, height: 900 } })
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

  const KTX = 'KTX 승차권 영수증_광주 1124-1125.pdf', HOTEL = '숙박 영수증_광주 무등 호텔(스캔).pdf', MEAL = '식대 영수증_광주 1124.jpg'
  const CARD = '법인카드 이용내역서_2026-11 영업팀.pdf'
  // the reading kept next to an upload (stepfiles.js — .<name>.read.json): how the later steps got the file
  const WS = process.env.PGPT_WORKSPACE || path.resolve(here, '../../../../process-gpt-deepagents/workspace')
  const readOf = (f) => {
    for (const base of [path.join(WS, 'localhost'), WS]) {
      const p = path.join(base, path.dirname(f.path.slice('/workspace'.length)), `.${f.name}.read.json`)
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'))
    }
    return null
  }

  // ---------- 메일 → 건, 「영수증 제출」을 기다린다 ----------
  const cg = await mail(G)
  await toReceipts(cg, G)

  // ---------- 영수증 제출(입력 폼): 받은 그대로의 글 PDF · 스캔 PDF · 사진 ----------
  const recForm = await openTodo(cg, '영수증 제출', G.subject)
  await recForm.getByTestId('form-file-input').setInputFiles([KTX, HOTEL, MEAL].map((n) => path.join(FILES, n)))
  await expect(recForm.getByTestId('form-files')).toHaveAttribute('data-count', '3', { timeout: 60_000 })
  await recForm.locator('textarea').fill('받은 영수증 그대로 올립니다. 숙박은 호텔에서 스캔해 준 PDF, 식대는 사진이에요.')
  await shot(page, '영수증 제출 입력 폼 — 글 PDF · 스캔 PDF · 사진')
  await recForm.getByRole('button', { name: '제출' }).click()
  await expect.poll(async () => (await stepRow(cg, '영수증 제출'))?.status, { timeout: 30_000 }).toBe('DONE')
  const rec = valOf(await stepRow(cg, '영수증 제출'))
  expect((rec.files || []).map((f) => f.name).sort()).toEqual([KTX, HOTEL, MEAL].sort())

  // ---------- 재무 검토(채팅): 카드사의 암호 걸린 이용내역서 ----------
  const fin = ask(cg, '재무 검토')
  await expect(fin).toBeVisible({ timeout: 4 * 60_000 })
  await expect(fin.getByTestId('onto-case-ask-req')).toHaveAttribute('data-requirement', 'required')
  await go(cg, '재무 검토')
  await opened(cg, '재무 검토')
  await page.goto(at('chat'))
  await chat.locator('input[type=file]').setInputFiles(path.join(FILES, CARD))
  await expect(chat.locator('.att:not(.uploading)')).toHaveCount(1, { timeout: 60_000 })
  await chat.locator('textarea').fill('광주 출장 건 재무 검토 결과예요. 카드사에서 받은 법인카드 이용내역서인데 암호가 걸려 있어요.')
  await chat.getByRole('button', { name: '보내기' }).click()
  await expect(page.getByText(`「재무 검토」 결과로 냈어요 — ${G.subject}`)).toBeVisible({ timeout: 60_000 })
  await page.getByText(`「재무 검토」 결과로 냈어요 — ${G.subject}`).scrollIntoViewIfNeeded()
  await shot(page, '재무 검토 — 채팅으로 암호 PDF')
  const rv = valOf(await stepRow(cg, '재무 검토'))
  expect((rv.files || []).map((f) => f.name)).toEqual([CARD])

  // ---------- 금액 확인(에이전트): 파일에만 있는 금액이 결과에, 읽지 못한 이용내역서는 그렇다고 ----------
  await go(cg, '금액 확인')
  await expect.poll(async () => (await stepRow(cg, '금액 확인'))?.status, { timeout: 15 * 60_000, intervals: [5000] }).toBe('DONE')
  const amtRaw = String(valOf(await stepRow(cg, '금액 확인')).result || '')
  const amt = amtRaw.replace(/\s/g, '')
  console.log(`[금액 확인 결과]\n${amtRaw}`)
  expect(amt, `글 PDF(KTX) 금액: ${amt.slice(0, 600)}`).toMatch(/93,?600/)
  expect(amt, '스캔 PDF(숙박) 금액').toMatch(/176,?000/)
  expect(amt, '사진(식대) 금액').toMatch(/784,?800/)
  expect(amt, '읽지 못한 이용내역서').toMatch(/이용내역서/)
  expect(amt, '읽지 못했다는 표시').toMatch(/(읽지|열지|열람하지|확인하지|열수없|읽을수없|열람할수없)/)
  // 뒤 단계가 받은 것(업로드 옆에 남긴 읽은 결과): 글 PDF 는 글, 스캔 · 사진은 그림을 읽은 글, 암호 PDF 는 읽지 못함
  const how = Object.fromEntries([...rec.files, ...rv.files].map((f) => [f.name, readOf(f)?.read]))
  expect(how).toEqual({ [KTX]: 'text', [HOTEL]: 'image', [MEAL]: 'image', [CARD]: 'none' })

  // ---------- 재무 승인(사람, 파일 칸 없음): 금액은 사람이 확정 ----------
  const ok = ask(cg, '재무 승인')
  await expect(ok).toBeVisible({ timeout: 4 * 60_000 })
  await expect(ok.getByTestId('onto-case-ask-req')).toHaveAttribute('data-requirement', 'required')
  await go(cg, '재무 승인')
  await opened(cg, '재무 승인')
  const apForm = await openTodo(cg, '재무 승인', G.subject)
  await expect(apForm.getByTestId('form-files')).toHaveCount(0)
  await apForm.locator('textarea').fill('스캔 · 사진 영수증 금액을 원본과 대조했고, 카드 이용내역서는 암호를 풀어 확인했습니다. 1,054,400원 승인합니다.')
  await shot(page, '재무 승인 — 사람이 금액 확정')
  await apForm.getByRole('button', { name: '제출' }).click()
  await expect.poll(async () => (await stepRow(cg, '재무 승인'))?.status, { timeout: 30_000 }).toBe('DONE')

  // 안내문 작성(에이전트) → 끝: 읽지 못한 파일이 있어도 건은 멈추지 않는다
  await go(cg, '안내문 작성')
  await expect.poll(async () => (await caseOf(G.subject)).status, { timeout: 10 * 60_000, intervals: [5000] }).toBe('done')

  // 건 화면: 단계마다 낸 파일(영수증 셋은 입력 폼, 이용내역서는 채팅)과 금액 확인 결과
  await page.goto(at(`process-map?case=${encodeURIComponent(cg.id)}`))
  const files = (task) => page.locator(`[data-testid=onto-case-step][data-task="${task}"] [data-testid=onto-case-step-files]`)
  const older = page.getByTestId('onto-case-older')
  if (await older.count()) await older.click()
  await expect(files('영수증 제출')).toHaveAttribute('data-count', '3', { timeout: 30_000 })
  await expect(files('영수증 제출')).toHaveAttribute('data-via', 'form')
  await expect(files('재무 검토')).toHaveAttribute('data-count', '1')
  await expect(files('재무 검토')).toHaveAttribute('data-via', 'chat')
  await files('영수증 제출').scrollIntoViewIfNeeded()
  await shot(page, '건 화면 단계 파일')
  await page.locator('[data-testid=onto-case-step][data-task="금액 확인"]').scrollIntoViewIfNeeded()
  await shot(page, '건 화면 금액 확인 결과')
  expect(page.errors).toEqual([])
})
