// 휴대폰 화면(2026-11-23, 운영) — Home 의 「Reply」 카드를 누르자 에이전트가 회사 메일 도구(send_email)로 30초 만에
// 답장을 보내 버렸다. 원문을 볼 곳도, 초안을 고칠 틈도 없었다(「메일원문을 보는 기능이 없고 곧바로 답장이 되어버리는
// 문제가 있음. 초안을 검토 후 직접 눌렀을때 보내져야」). 고친 뒤: 메일에서 온 카드는 원문과 답장 초안을 여는 시트이고,
// 보내기를 눌러야 Lite 서버가 보낸다. 받는 사람은 원문의 보낸 사람(카드 지시의 주소가 아니라).
// 이 묶음의 서버는 PRO_LLM_BASE_URL 을 이 파일이 띄우는 가짜 모델(http://127.0.0.1:<RT_FAKE_LLM_PORT, 기본 59998>/v1)로
// 띄운다 — 초안 내용이 정해져 있어야 시트에 무엇이 들어가는지 볼 수 있다. 메일함은 데모 메일함(실제 메일 없음).
import http from 'node:http'
import { test, expect } from '../../lib/fixtures.js'

const PHONE = { width: 390, height: 844 }
const PORT = Number(process.env.RT_FAKE_LLM_PORT || 59998)
const DRAFT = { subject: 'Re: 12월 과정 강사 프로필', body: '안녕하세요, 김하늘 님.\n\n이도윤 님 프로필을 정리해 [날짜]까지 보내 드리겠습니다.\n\n홍길동 드림' }
const MAIL = {
  sender: '김하늘 <haneul.kim@northwind.example>',
  subject: 'Re: 12월 과정 강사 프로필',
  body: '홍길동 님, 12월 과정 강사로 이도윤 님이 확정되었습니다.\n프로필 한 장 보내 주시면 확인 후 회신드리겠습니다.\n\n김하늘 드림',
}

let fake
test.beforeAll(async () => {
  fake = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      let body = {}
      try { body = JSON.parse(raw) } catch { /* not json */ }
      res.writeHead(200, { 'content-type': 'application/json' })
      // what a mail card is for (the judge, server lib/mailCard.js — a Reply card is not asked): these Review cards are 그 밖의 일 (C).
      // (a fake without log-probabilities would rest the server's first-token reading for ten minutes — lib/decide.js — and the
      // specs run after this one on the same server would lose their judge)
      if (body.max_tokens === 1 && body.logprobs) {
        return res.end(JSON.stringify({ choices: [{ message: { content: 'C' }, logprobs: { content: [{ token: 'C', top_logprobs: [{ token: 'C', logprob: Math.log(0.9) }, { token: 'A', logprob: Math.log(0.1) }] }] } }] }))
      }
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify(DRAFT) }, finish_reason: 'stop' }] }))
    })
  })
  await new Promise((ok, no) => fake.once('error', no).listen(PORT, '127.0.0.1', ok))
})
test.afterAll(async () => { await new Promise((ok) => fake?.close(ok)) })

// a demo mailbox with one mail that arrived, and the card the triage made from it — its instruction
// names the wrong address (the person's own), as the 2026-11-23 card did
async function mailCard(pageAs, db, area, { verb = 'Reply', text = '김하늘 님에게 프로필을 보내겠다고 답장', drafts } = {}) {
  const page = await pageAs(area, { viewport: PHONE })
  const u = page.user
  await db.clearMain(u.id)
  const mailId = `demo-rt-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  await db.q(`insert into pro_mail_accounts(user_id, provider, address) values ($1,'demo',$2) on conflict (user_id) do update set provider='demo', address=$2`, [u.id, u.email])
  await db.q('insert into pro_demo_mail(user_id, mail_id, sender, subject, body) values ($1,$2,$3,$4,$5)', [u.id, mailId, MAIL.sender, MAIL.subject, MAIL.body])
  await db.q(`delete from pro_actions where user_id=$1`, [u.id])
  const [a] = await db.q(`insert into pro_actions(user_id, verb, text, prompt, source) values ($1,$2,$3,$4,$5) returning *`,
    [u.id, verb, text, `${u.email}에게 '네, 보내 주세요'라고 회신해 주세요.`, { mail_id: mailId, from: MAIL.sender, subject: MAIL.subject, ...(drafts ? { drafts } : {}) }])
  const ran = []
  page.on('request', (r) => { if (/\/api\/actions\/[^/]+\/run$/.test(r.url())) ran.push(r.url()) })
  await page.goto('/chat')
  await page.locator('.seg button').filter({ hasText: '홈' }).click()
  const card = page.locator('[data-test="action-card"]').filter({ hasText: text })
  await expect(card).toBeVisible()
  return { page, u, a, card, ran, mailId }
}
// the sheet's opening animation is over (a picture taken during it shows Home through the sheet). A loading line's shimmer never
// ends and is cancelled when the line goes (the card's kind, the map's reading): only finite animations, a cancelled one is over
// (as mail-thread-flow.spec.js does)
const settled = (loc) => loc.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).filter((a) => a.effect?.getComputedTiming?.().iterations !== Infinity).map((a) => a.finished.catch(() => {}))))
const cleanup = async (db, u) => {
  await db.q('delete from pro_actions where user_id=$1', [u.id])
  await db.q('delete from pro_demo_mail where user_id=$1', [u.id])
  await db.q('delete from pro_mail_accounts where user_id=$1', [u.id])
}

test.describe('메일 카드 — 원문을 보고, 초안을 고치고, 보내기를 눌러야 보낸다', () => {
  test('F-ML-01 Reply 카드를 누르면 원문과 답장 초안이 열리고, 아무것도 보내지 않는다 · 받는 사람은 원문의 보낸 사람', async ({ pageAs, db }) => {
    const { page, u, a, card, ran } = await mailCard(pageAs, db, 'mail-open')
    await card.click()
    const sheet = page.locator('[data-test="mail-sheet"]')
    await expect(sheet).toBeVisible()
    await expect(sheet.locator('[data-test="mail-original"]')).toContainText('김하늘 <haneul.kim@northwind.example>')
    await expect(sheet.locator('[data-test="mail-text"]')).toContainText('프로필 한 장 보내 주시면 확인 후 회신드리겠습니다.')
    await expect(sheet.locator('[data-test="mail-body"]')).toHaveValue(DRAFT.body)
    await expect(sheet.locator('[data-test="mail-to"]')).toHaveValue('김하늘 <haneul.kim@northwind.example>')
    await expect(sheet.locator('[data-test="mail-to"]')).not.toHaveValue(new RegExp(u.email))
    await expect(sheet.locator('[data-test="mail-send"]')).toBeEnabled()
    await expect(sheet).toContainText('보내기를 누르기 전에는 아무것도 보내지 않아요.')
    await settled(sheet)
    await page.screenshot({ path: test.info().outputPath('f-ml-01.png') })
    await sheet.locator('[data-test="mail-send"]').scrollIntoViewIfNeeded()
    await page.screenshot({ path: test.info().outputPath('f-ml-01b.png') })
    // nothing ran, nothing was sent: the card is still open, no agent turn started
    expect(ran, '카드를 눌러도 에이전트에게 넘기지 않는다').toEqual([])
    const [row] = await db.q('select status, source from pro_actions where id=$1', [a.id])
    expect(row.status).toBe('open')
    expect(row.source.sent).toBeUndefined()
    expect(row.source.reply.body).toBe(DRAFT.body) // the draft is kept with the card
    await cleanup(db, u)
  })

  test('F-ML-02 초안을 고쳐 보내기를 누르면 그때 보내고, 카드가 Home 에서 사라지고, 대화에 남는다', async ({ pageAs, db }) => {
    const { page, u, a, card, ran } = await mailCard(pageAs, db, 'mail-send')
    await card.click()
    const sheet = page.locator('[data-test="mail-sheet"]')
    const body = sheet.locator('[data-test="mail-body"]')
    await expect(body).toHaveValue(DRAFT.body)
    await body.fill(DRAFT.body.replace('[날짜]', '11월 24일'))
    const answer = page.waitForResponse((r) => r.url().endsWith(`/api/actions/${a.id}/reply`))
    await sheet.locator('[data-test="mail-send"]').click()
    expect((await answer).status()).toBe(200)
    // the demo mailbox sends nothing, and says so
    await expect(sheet.locator('[data-test="mail-sent"]')).toContainText('기록했어요')
    await expect(sheet.locator('[data-test="mail-sent"]')).toContainText('데모 메일함이라 실제로 보내지 않았어요.')
    await expect(sheet.locator('[data-test="mail-sent"]')).toContainText('김하늘 <haneul.kim@northwind.example>')
    await settled(sheet)
    await page.screenshot({ path: test.info().outputPath('f-ml-02.png') })
    await sheet.getByRole('button', { name: '닫기' }).click()
    await expect(card).toHaveCount(0)
    const [row] = await db.q('select status, source from pro_actions where id=$1', [a.id])
    expect(row.status).toBe('done')
    expect(row.source.sent.to).toBe('김하늘 <haneul.kim@northwind.example>')
    expect(row.source.reply.body).toContain('11월 24일까지')
    const main = await db.mainThreadId(u.id)
    const [m] = await db.q(`select content from pro_messages where thread_id=$1 and content ? 'sent_mail'`, [main])
    expect(m.content.text).toBe(`데모 메일함이라 김하늘에게 보낼 답장 「${MAIL.subject}」을 실제로 보내지 않고 기록만 했어요.`)
    expect(ran).toEqual([])
    await cleanup(db, u)
  })

  test('F-ML-03 답장이 일이 아닌 메일 카드(Review)는 원문만 열고 초안을 쓰지 않는다(「답장도 쓰기」 아래) · 에이전트에게는 눌러야 맡긴다', async ({ pageAs, db }) => {
    const { page, u, a, card, ran } = await mailCard(pageAs, db, 'mail-review', { verb: 'Review', text: '과정 진행자 확정 메일 확인' })
    await card.click()
    const sheet = page.locator('[data-test="mail-sheet"]')
    await expect(sheet.locator('[data-test="mail-text"]')).toContainText('이도윤 님이 확정되었습니다.')
    await expect(sheet.locator('[data-test="mail-write"]')).toHaveText('답장도 쓰기')
    await expect(sheet.locator('[data-test="mail-body"]')).toHaveCount(0)
    await expect(sheet.locator('[data-test="mail-agent"]')).toBeVisible()
    await settled(sheet)
    await page.screenshot({ path: test.info().outputPath('f-ml-03.png') })
    // writing a draft on request: still nothing is sent
    await sheet.locator('[data-test="mail-write"]').click()
    await expect(sheet.locator('[data-test="mail-body"]')).toHaveValue(DRAFT.body)
    const [row] = await db.q('select status, source from pro_actions where id=$1', [a.id])
    expect(row.status).toBe('open')
    expect(row.source.sent).toBeUndefined()
    expect(ran).toEqual([])
    await cleanup(db, u)
  })

  test('F-ML-04 예전 화면이 답장 카드를 에이전트에게 넘겨도(POST /run) 서버가 거절한다 — 보내지 않고 카드는 그대로', async ({ pageAs, db }) => {
    const { page, u, a } = await mailCard(pageAs, db, 'mail-run')
    const r = await page.user.post(`/actions/${a.id}/run`)
    expect(r.status).toBe(409)
    expect(r.body.code).toBe('reply_in_card')
    const [row] = await db.q('select status, source from pro_actions where id=$1', [a.id])
    expect(row.status).toBe('open')
    expect(row.source.sent).toBeUndefined()
    // a card that is not about a reply still goes to the agent when asked (not run here: no agent in this tier)
    await cleanup(db, u)
  })

  test('F-ML-05 메일을 불러오지 못해도(메일함에 없는 메일) 이유가 보이고, 답장이 일이 아닌 카드는 에이전트에게 맡길 수 있다', async ({ pageAs, db }) => {
    const { page, u, a, card } = await mailCard(pageAs, db, 'mail-gone', { verb: 'Review', text: '지워진 메일 확인' })
    await db.q('delete from pro_demo_mail where user_id=$1', [u.id]) // the mail is gone from the mailbox
    await card.click()
    const sheet = page.locator('[data-test="mail-sheet"]')
    await expect(sheet.locator('[data-test="mail-load-error"]')).toHaveText('메일함에서 이 메일을 찾지 못했어요.')
    await expect(sheet.locator('[data-test="mail-agent"]')).toBeVisible()
    const [row] = await db.q('select status from pro_actions where id=$1', [a.id])
    expect(row.status).toBe('open')
    await cleanup(db, u)
  })

  test('F-ML-06 올리지 못한 첨부가 있으면 보내지 않고 알려 주며, 빼면 보낼 수 있다', async ({ pageAs, db }) => {
    const { page, u, card } = await mailCard(pageAs, db, 'mail-upload')
    await page.route('**/api/attachments', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"storage down"}' }))
    await card.click()
    const sheet = page.locator('[data-test="mail-sheet"]')
    await expect(sheet.locator('[data-test="mail-body"]')).toHaveValue(DRAFT.body)
    await sheet.locator('input[type=file]').setInputFiles({ name: '계약서.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 rt') })
    await expect(sheet.locator('[data-test="mail-added"]')).toContainText('올리지 못함')
    await expect(sheet.locator('[data-test="mail-upload-failed"]')).toBeVisible()
    await expect(sheet.locator('[data-test="mail-send"]')).toBeDisabled()
    await sheet.locator('[data-test="mail-added-drop"]').click()
    await expect(sheet.locator('[data-test="mail-added"]')).toHaveCount(0)
    await expect(sheet.locator('[data-test="mail-send"]')).toBeEnabled()
    await cleanup(db, u)
  })

  test('F-ML-07 고친 초안에서 「다시 쓰기」는 한 번 더 눌러야 새로 쓴다', async ({ pageAs, db }) => {
    const { page, u, card } = await mailCard(pageAs, db, 'mail-rewrite')
    await card.click()
    const sheet = page.locator('[data-test="mail-sheet"]')
    const body = sheet.locator('[data-test="mail-body"]')
    await expect(body).toHaveValue(DRAFT.body)
    await body.fill('제가 고친 본문')
    const again = sheet.locator('[data-test="mail-rewrite"]')
    await again.click()
    await expect(again).toHaveText('한 번 더 누르면 새로 써요')
    await expect(body).toHaveValue('제가 고친 본문')
    await again.click()
    await expect(body).toHaveValue(DRAFT.body)
    await expect(again).toHaveText('다시 쓰기')
    await cleanup(db, u)
  })
})
