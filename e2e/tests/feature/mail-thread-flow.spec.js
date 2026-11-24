// 운영 화면(2026-11-24, /lite/chat): 채팅의 「모닝 브리프」는 메일 요약만 있고, 그 메일 · Home 카드로 가는 길이 없었다(「지금은 요약
// 메시지만 보임 … 좌측 홈 패널에서 작업하던 화면으로의 링크가 필요함」). 또 메일은 회사 프로세스 지도의 업무 트리거인데, 메일로
// 일이 시작될 때 인스턴스로 잇는 화면 흐름이 없었다. 고친 뒤(스펙 openspec/specs/mail-thread-flow, 서버 lib/mailFlow.js):
//   - 브리프 · 메일에서 나온 채팅 줄 아래에 메일 칩 → 그 카드의 메일 시트(원문 · 답장) → 「Home 카드로」
//   - 시트가 「이 메일은 ‘…’의 시작으로 보여요 — 진행할까요?」: 새로 시작 · 진행 중인 …에 잇기(판정 모델 · 같은 스레드) · 이번엔 안 해요
//   - 시작 · 잇기 뒤엔 /routines/<instId>, 메일이 인스턴스 대화의 사건, Home 카드와 브리프 칩이 인스턴스를 가리킨다
// 이 묶음의 서버는 PRO_LLM_BASE_URL 을 이 파일이 띄우는 가짜 모델(http://127.0.0.1:<RT_FAKE_LLM_PORT, 기본 59998>/v1)로 띄운다: 판정
// 모델의 첫 토큰 확률(같은 일 90%)과 답장 초안이 정해져 있다. 메일함은 데모 메일함(실제 메일 없음), 지도의 읽기는 카드에 남은 것
// (지도 엔진 없이 — 서버를 PRO_ONTOLOGY_BOLT_URL= 로 띄운다).
import http from 'node:http'
import crypto from 'node:crypto'
import { test, expect } from '../../lib/fixtures.js'
import { removeFolder } from '../../lib/seed.js'

const PHONE = { width: 390, height: 844 }
const PORT = Number(process.env.RT_FAKE_LLM_PORT || 59998)
const SAME = 0.9
const DRAFT = { subject: 'Re: 세미나 견적 다시 부탁드립니다', body: '안녕하세요, 이수민 님.\n\n40명 기준 견적을 [날짜]까지 보내 드리겠습니다.\n\n홍길동 드림' }
const MAIL = {
  sender: '이수민 <sumin@hanbit.example>',
  subject: 'Re: 세미나 견적 다시 부탁드립니다',
  body: '홍길동 님, 지난번 세미나 견적에서 인원을 30명에서 40명으로 바꿔 다시 부탁드립니다.\n\n이수민 드림',
}
const BRIEF = '한빛상사 이수민 님이 세미나 견적을 40명 기준으로 다시 부탁했어요. 지난 견적을 고쳐 회신하면 돼요.'
const QUOTE = { proc: 'p:mt-quote', name: '견적 요청 · 견적서 작성', stage: 'suggested', p: 0.91, task: '견적서 작성',
  choice: { task: '견적서 작성', p: 0.88, ask: true, suggest: true, measured: true, options: [{ task: '견적서 작성', p: 0.88 }], procName: '견적 요청 · 견적서 작성', procP: 0.91 } }

let fake
test.beforeAll(async () => {
  fake = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      let body = {}
      try { body = JSON.parse(raw) } catch { /* not json */ }
      res.writeHead(200, { 'content-type': 'application/json' })
      // the judge (lib/decide.js oddsOf): one token, its probabilities — A is 「같은 일」
      if (body.max_tokens === 1 && body.logprobs) {
        return res.end(JSON.stringify({ choices: [{ message: { content: 'A' }, logprobs: { content: [{ token: 'A', top_logprobs: [{ token: 'A', logprob: Math.log(SAME) }, { token: 'B', logprob: Math.log(1 - SAME) }] }] } }] }))
      }
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify(DRAFT) }, finish_reason: 'stop' }] }))
    })
  })
  await new Promise((ok, no) => fake.once('error', no).listen(PORT, '127.0.0.1', ok))
})
test.afterAll(async () => { await new Promise((ok) => fake?.close(ok)) })

const settled = (loc) => loc.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).filter((a) => a.effect?.getComputedTiming?.().iterations !== Infinity).map((a) => a.finished.catch(() => {}))))
// every finite animation on the page is over (a picture taken during a fade shows the screen half there)
const calm = (page) => page.evaluate(() => Promise.race([
  Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming?.().iterations !== Infinity).map((a) => a.finished.catch(() => {}))),
  new Promise((ok) => setTimeout(ok, 3000)),
]))
const shot = async (page, name) => { await calm(page); await page.screenshot({ path: test.info().outputPath(name) }) }
const insts = []

// a demo mailbox with one mail that arrived, the Home card the triage made from it, and the 모닝 브리프 about it (its chip)
async function setup(pageAs, db, area, { viewport, touch = false, flow = null, brief = true } = {}) {
  const page = await pageAs(area, { viewport, touch })
  const u = page.user
  const main = await db.clearMain(u.id)
  await cleanup(db, u)
  const mailId = `demo-mt-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  await db.q(`insert into pro_mail_accounts(user_id, provider, address) values ($1,'demo',$2) on conflict (user_id) do update set provider='demo', address=$2`, [u.id, u.email])
  await db.q('insert into pro_demo_mail(user_id, mail_id, sender, subject, body) values ($1,$2,$3,$4,$5)', [u.id, mailId, MAIL.sender, MAIL.subject, MAIL.body])
  const [a] = await db.q(`insert into pro_actions(user_id, verb, text, prompt, source) values ($1,'Reply',$2,'',$3) returning *`,
    [u.id, '한빛상사 세미나 견적 40명 기준으로 다시 회신', { mail_id: mailId, from: MAIL.sender, subject: MAIL.subject, ...(flow ? { flow: { at: new Date().toISOString(), matches: flow } } : {}) }])
  if (brief) {
    await db.addMessages(main, [
      { role: 'system', kind: 'divider', content: { text: '모닝 브리프' } },
      { role: 'agent', kind: 'text', content: { text: BRIEF, mails: [{ actionId: a.id, mailId, verb: 'Reply', text: a.text }] } },
    ])
  }
  return { page, u, a, mailId, main }
}
// a running instance of the company's process map that I started (as a case start leaves it), about the first quote of the same customer
async function running(db, u, { name = '견적 요청 · 견적서 작성 · 한빛상사' } = {}) {
  const instId = `mt-e2e.${crypto.randomUUID()}`
  insts.push(instId)
  await db.q(`insert into bpm_proc_inst (proc_inst_id, proc_inst_name, tenant_id, status, participants, start_date, updated_at) values ($1,$2,$3,'RUNNING',$4, now() at time zone 'Asia/Seoul', now())`, [instId, name, db.tenant, [u.id]])
  await db.q(`insert into pro_po_cases (tenant_id, bundle, entry_task, started_by, trigger, instances, request, status) values ($1,'p:mt-quote','견적서 작성',$2,$3,$4,$5,'running')`,
    [db.tenant, u.id, { kind: 'mail', subject: '세미나 견적 부탁드립니다', from: MAIL.sender }, [instId], { subject: '세미나 견적 부탁드립니다', sender: MAIL.sender, body: '12월 세미나 30명 기준 견적을 부탁드립니다.' }])
  return { instId, name }
}
async function cleanup(db, u) {
  // (a mail joined to an instance goes into its work folder — server lib/mailWork.js, mail-work-folder.spec.js)
  for (const f of await db.q(`select slug from pro_folders where created_by=$1 and settings ? 'work'`, [u.id])) await removeFolder(db, f.slug)
  await db.q('delete from pro_actions where user_id=$1', [u.id])
  await db.q('delete from pro_demo_mail where user_id=$1', [u.id])
  await db.q('delete from pro_mail_accounts where user_id=$1', [u.id])
  await db.q('delete from notifications where user_id=$1', [u.id])
  await db.q('delete from pro_po_cases where started_by=$1', [u.id])
  await db.q(`delete from pro_messages where thread_id in (select id from pro_threads where user_id=$1 and kind='process' and ref like 'mt-e2e.%')`, [u.id])
  await db.q(`delete from pro_threads where user_id=$1 and kind='process' and ref like 'mt-e2e.%'`, [u.id])
}
test.afterAll(async () => {
  const db = await import('../../lib/db.js')
  if (!insts.length || !(await db.available())) return
  // (an instance page still loading when its test ended may have made its conversation after that test's cleanup)
  await db.q('delete from pro_messages where thread_id in (select id from pro_threads where ref = any($1))', [insts]).catch(() => {})
  await db.q('delete from pro_threads where ref = any($1)', [insts]).catch(() => {})
  await db.q('delete from bpm_proc_inst where proc_inst_id = any($1)', [insts]).catch(() => {})
})
const sheetOf = (page) => page.locator('[data-test="mail-sheet"]')
const homeCard = (page, a) => page.locator(`[data-test="action-card"][data-action-id="${a.id}"]`)

test.describe('메일 칩 · 시트 · 인스턴스 — 채팅의 메일 줄에서 메일 원문으로, 메일에서 일로', () => {
  test('F-MT-01 모닝 브리프 아래 메일 칩 → 원문 시트 → 「Home 카드로」 그 카드가 보이고 빛난다 (PC)', async ({ pageAs, db }) => {
    const { page, u, a } = await setup(pageAs, db, 'mt-chip')
    await page.goto('/chat')
    const chip = page.locator('[data-test="mail-chip"]').filter({ hasText: a.text })
    await expect(chip).toBeVisible()
    await expect(chip).toContainText('답장') // the card's verb in the person's language (src/mailKind.js — spec mail-card-actions)
    await shot(page, 'f-mt-01a.png')
    await chip.click()
    const sheet = sheetOf(page)
    await expect(sheet.locator('[data-test="mail-original"]')).toContainText('이수민 <sumin@hanbit.example>')
    await expect(sheet.locator('[data-test="mail-text"]')).toContainText('40명으로 바꿔 다시 부탁드립니다')
    await expect(sheet.locator('[data-test="mail-body"]')).toHaveValue(DRAFT.body) // the reply, right there
    // the map is off on this server and no running work is like it: nothing to ask
    await expect(sheet.locator('[data-test="mail-flow"]')).toHaveCount(0)
    await settled(sheet)
    await shot(page, 'f-mt-01b.png')
    await sheet.locator('[data-test="mail-home"]').click()
    await expect(sheet).toHaveCount(0)
    await expect(homeCard(page, a)).toBeInViewport()
    await expect(homeCard(page, a)).toHaveClass(/flash/)
    // (the ring holds for a moment, then fades: the picture is taken while it holds)
    await page.waitForTimeout(500)
    await page.screenshot({ path: test.info().outputPath('f-mt-01c.png') })
    expect(page.errors).toEqual([])
    await cleanup(db, u)
  })

  test('F-MT-02 휴대폰: 채팅 탭의 메일 칩 → 시트 → 「Home 카드로」 홈 탭으로 가서 그 카드', async ({ pageAs, db }) => {
    const { page, u, a } = await setup(pageAs, db, 'mt-chip-phone', { viewport: PHONE, touch: true })
    await page.goto('/chat')
    await page.locator('.seg button').filter({ hasText: '채팅' }).click()
    const chip = page.locator('[data-test="mail-chip"]').filter({ hasText: a.text })
    await expect(chip).toBeVisible()
    await page.waitForTimeout(1500)
    await shot(page, 'f-mt-02a.png')
    // the chip stays inside the phone's width
    const box = await chip.boundingBox()
    expect(box.x + box.width).toBeLessThanOrEqual(PHONE.width)
    await chip.click()
    const sheet = sheetOf(page)
    await expect(sheet.locator('[data-test="mail-text"]')).toContainText('40명으로 바꿔')
    await settled(sheet)
    await shot(page, 'f-mt-02b.png')
    await sheet.locator('[data-test="mail-home"]').click()
    await expect(homeCard(page, a)).toBeInViewport()
    await expect(homeCard(page, a)).toHaveClass(/flash/)
    await expect(page.locator('.seg button[data-tab="home"]')).toHaveClass(/\bon\b/)
    await page.waitForTimeout(500)
    await page.screenshot({ path: test.info().outputPath('f-mt-02c.png') })
    expect(page.errors).toEqual([])
    await cleanup(db, u)
  })

  test('F-MT-03 시트가 묻는다: 「이 메일은 ‘…’의 시작으로 보여요 — 진행할까요?」 새로 시작 · 진행 중인 일에 잇기(같은 일 90%) · 이번엔 안 해요 — Home 카드도 한 줄로', async ({ pageAs, db }) => {
    const { page, u, a } = await setup(pageAs, db, 'mt-ask', { flow: [QUOTE], brief: false })
    const run = await running(db, u)
    await page.goto('/chat')
    const card = homeCard(page, a)
    await expect(card.locator('[data-test="action-offer"]')).toContainText('‘견적 요청 · 견적서 작성’의 시작으로 보여요')
    await card.click()
    const sheet = sheetOf(page)
    const flow = sheet.locator('[data-test="mail-flow"]')
    await expect(flow.locator('[data-test="flow-question"]')).toHaveText('이 메일은 ‘견적 요청 · 견적서 작성’의 시작으로 보여요 — 진행할까요?')
    await expect(flow).toContainText('「견적서 작성」부터 · 제안 단계 · 시작하면 단계마다 사람이 정해요')
    await expect(flow.locator('[data-test="flow-start"]')).toHaveText('새로 시작')
    const join = flow.locator('[data-test="flow-join"]')
    await expect(join).toHaveCount(1)
    await expect(join).toContainText(`진행 중인 ‘${run.name}’에 잇기`)
    await expect(join).toContainText('같은 일 90%')
    await expect(flow.locator('[data-test="flow-decline"]')).toBeVisible()
    // nothing started by opening it
    const [row] = await db.q('select source from pro_actions where id=$1', [a.id])
    expect(row.source.inst).toBeUndefined()
    expect(row.source.flow.same[run.instId]).toBe(SAME)
    await settled(sheet)
    await shot(page, 'f-mt-03.png')
    expect(page.errors).toEqual([])
    await cleanup(db, u)
  })

  test('F-MT-04 잇기 → 그 인스턴스 화면, 메일이 인스턴스 대화의 사건 · Home 카드와 브리프 칩은 인스턴스로 · 거기서 답장하면 인스턴스에 남는다', async ({ pageAs, db }) => {
    const { page, u, a, main } = await setup(pageAs, db, 'mt-join', { flow: [QUOTE] })
    const run = await running(db, u)
    await page.goto('/chat')
    await homeCard(page, a).click()
    const sheet = sheetOf(page)
    await sheet.locator('[data-test="flow-join"]').click()
    await page.waitForURL(`**/routines/${encodeURIComponent(run.instId)}`)
    await expect(sheet).toHaveCount(0)
    const said = page.locator('.row.k-text').filter({ hasText: '이수민님의 메일 「Re: 세미나 견적 다시 부탁드립니다」를 이 일에 이었어요.' })
    await expect(said).toBeVisible()
    await expect(page.locator('.row.k-divider').filter({ hasText: '메일 · Re: 세미나 견적 다시 부탁드립니다' })).toBeVisible()
    await said.scrollIntoViewIfNeeded()
    await shot(page, 'f-mt-04a.png')
    const [row] = await db.q('select source from pro_actions where id=$1', [a.id])
    expect([row.source.inst.instId, row.source.inst.via, row.source.inst.by, row.source.inst.p]).toEqual([run.instId, 'join', 'judge', SAME])
    // the main chat got nothing; the brief's chip now names the instance
    const mainRows = await db.q('select kind, content from pro_messages where thread_id=$1 order by created_at', [main])
    expect(mainRows.map((m) => m.kind)).toEqual(['divider', 'text'])
    expect(mainRows[1].content.mails[0].inst).toEqual({ instId: run.instId, name: run.name })
    // from the instance: the mail's chip opens it, and the reply is said here
    await said.locator('[data-test="mail-chip"]').click()
    await expect(sheet.locator('[data-test="mail-body"]')).toHaveValue(DRAFT.body)
    await expect(sheet.locator('[data-test="mail-inst"]')).toHaveCount(0) // already on its page
    await sheet.locator('[data-test="mail-body"]').fill(DRAFT.body.replace('[날짜]', '11월 26일'))
    await sheet.locator('[data-test="mail-send"]').click()
    await expect(sheet.locator('[data-test="mail-sent-inst"]')).toHaveText(`루틴 · ${run.name}에 기록했어요.`)
    await settled(sheet)
    await shot(page, 'f-mt-04b.png')
    await sheet.getByRole('button', { name: '닫기' }).click()
    await expect(page.locator('.row.k-text').filter({ hasText: '데모 메일함이라 이수민에게 보낼 답장' })).toBeVisible()
    // back in the chat: the brief's chip opens the instance (the way a schedule's chip opens the schedule)
    await page.goto('/chat')
    const chip = page.locator('[data-test="mail-chip-inst"]')
    await expect(chip).toContainText(`루틴 · ${run.name}`)
    await shot(page, 'f-mt-04c.png')
    await chip.click()
    await page.waitForURL(`**/routines/${encodeURIComponent(run.instId)}`)
    expect(page.errors).toEqual([])
    await cleanup(db, u)
  })

  test('F-MT-05 휴대폰: 시트의 물음 · 잇기 뒤 Home 카드는 인스턴스를 연다', async ({ pageAs, db }) => {
    const { page, u, a } = await setup(pageAs, db, 'mt-phone', { viewport: PHONE, touch: true, flow: [QUOTE], brief: false })
    const run = await running(db, u)
    await page.goto('/chat')
    const card = homeCard(page, a)
    await expect(card).toBeVisible()
    await card.click()
    const sheet = sheetOf(page)
    await expect(sheet.locator('[data-test="flow-question"]')).toBeVisible()
    await expect(sheet.locator('[data-test="flow-join"]')).toContainText('같은 일 90%')
    // the question, its buttons and the sheet fit the phone: nothing runs off to the side
    const over = await sheet.evaluate((el) => [...el.querySelectorAll('*')].some((x) => x.getBoundingClientRect().right > window.innerWidth + 1))
    expect(over).toBe(false)
    await settled(sheet)
    await shot(page, 'f-mt-05a.png')
    await sheet.locator('[data-test="flow-join"]').click()
    await page.waitForURL(`**/routines/${encodeURIComponent(run.instId)}`)
    const said = page.locator('.row.k-text').filter({ hasText: '이 일에 이었어요.' })
    await expect(said).toBeVisible()
    await said.scrollIntoViewIfNeeded()
    await shot(page, 'f-mt-05b.png')
    // Home's card now says where the mail is, and opens it
    await page.goto('/chat')
    await expect(card).toBeVisible()
    await expect(card.locator('[data-test="action-inst"]')).toContainText(`루틴 · ${run.name}`)
    await shot(page, 'f-mt-05c.png')
    await card.click()
    await page.waitForURL(`**/routines/${encodeURIComponent(run.instId)}`)
    expect(page.errors).toEqual([])
    await cleanup(db, u)
  })

  test('F-MT-06 새로 시작이 실패하면 이유가 시트에 보이고 카드는 묶이지 않는다 · 이번엔 안 해요 → 더 묻지 않고, 다시 묻기로 되돌린다', async ({ pageAs, db }) => {
    const { page, u, a } = await setup(pageAs, db, 'mt-decline', { flow: [QUOTE], brief: false })
    await page.goto('/chat')
    await homeCard(page, a).click()
    const sheet = sheetOf(page)
    // (this server runs without the map's engine: the start cannot be made — said, not swallowed)
    await sheet.locator('[data-test="flow-start"]').click()
    await expect(sheet.locator('[data-test="flow-error"]')).toBeVisible()
    await shot(page, 'f-mt-06a.png')
    let [row] = await db.q('select source from pro_actions where id=$1', [a.id])
    expect(row.source.inst).toBeUndefined()
    expect(row.source.linking).toBeUndefined()
    await sheet.locator('[data-test="flow-decline"]').click()
    await expect(sheet.locator('[data-test="mail-flow"]')).toHaveCount(0)
    await expect(sheet.locator('[data-test="flow-declined"]')).toContainText('이 메일로는 프로세스를 시작하지 않기로 했어요.')
    await settled(sheet)
    await shot(page, 'f-mt-06b.png')
    ;[row] = await db.q('select source from pro_actions where id=$1', [a.id])
    expect(row.source.flow.declined).toBeTruthy()
    // the card's line goes too
    await sheet.getByRole('button', { name: '닫기' }).click()
    await expect(homeCard(page, a).locator('[data-test="action-offer"]')).toHaveCount(0)
    await homeCard(page, a).click()
    await sheet.locator('[data-test="flow-undo"]').click()
    await expect(sheet.locator('[data-test="flow-question"]')).toBeVisible()
    expect(page.errors).toEqual([])
    await cleanup(db, u)
  })

  test('F-MT-07 새로 시작의 화면 흐름: 시작 응답의 인스턴스 화면으로 간다 (지도 엔진 없는 이 계층에서는 시작 응답만 대역)', async ({ pageAs, db }) => {
    const { page, u, a } = await setup(pageAs, db, 'mt-start', { flow: [QUOTE], brief: false })
    const run = await running(db, u, { name: '견적 요청 · 견적서 작성 · 새 건' })
    // the server's start and linking are server/test/mailFlow.integration.test.js 「새로 시작」; here only the answer is stood in for
    await page.route(`**/api/actions/${a.id}/flow/start`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ instId: run.instId, inst: { instId: run.instId, name: run.name, via: 'start' } }) }))
    const sent = page.waitForRequest((r) => r.url().endsWith(`/api/actions/${a.id}/flow/start`))
    await page.goto('/chat')
    await homeCard(page, a).click()
    await sheetOf(page).locator('[data-test="flow-start"]').click()
    expect((await sent).postDataJSON()).toEqual({ proc: 'p:mt-quote', task: '견적서 작성' })
    await page.waitForURL(`**/routines/${encodeURIComponent(run.instId)}`)
    await expect(sheetOf(page)).toHaveCount(0)
    expect(page.errors).toEqual([])
    await cleanup(db, u)
  })
})
