// 휴대폰 화면(2026-11-24): 메일 카드를 열면 답장 시트 「답장 · … 데이터 이전 협업 제안 확인 회신」 — 원문(접힘), 받는 사람 · 참조 · 제목 · 본문, 「+ 파일 첨부」,
// 「다시 쓰기」 · 「보내기」뿐이었다. 사용자: 「메일에 대해서 무조건 답장만 하지는 않는다. 그 회사에 대해서 추가적으로 알아볼 수 도 있고.. 기타 액션을 할 수
// 있어야 하는데... 채팅에 멘션해서 뭔가 후속 작업을 할 수 있어야하는디」. 고친 뒤(스펙 openspec/specs/mail-card-actions, 서버 lib/mailFollow.js ·
// lib/mailMention.js):
//   - 모든 메일 시트에 할 일 줄: 「이 회사 알아보기」 · 「채팅에서 이어서」 · 판정 모델이 고른 몇 가지. 누르면 무엇을 할지 말하고, 그 단추를 눌러야 한다.
//     답장 카드는 답장이 그대로 큰 칸이고, 줄은 그 위에 한 줄.
//   - 메일은 멘션: Home 카드 · 시트 머리의 손잡이를 AI 채팅 입력창(칩 — 에이전트가 메일을 읽음)이나 메신저(메일 멘션 — 동료는 요약만)에 끌어 놓는다.
// 끌기는 Playwright 의 DataTransfer 끌기 이벤트로 시험한다(dragstart 를 끄는 것에, dragenter · dragover · drop 을 놓는 곳에).
// 서버는 가짜 모델(PRO_LLM_BASE_URL=http://127.0.0.1:<RT_FAKE_LLM_PORT, 기본 59981>/v1)과 가짜 deepagents(PRO_DEEPAGENTS_URL=
// http://127.0.0.1:<RT_FAKE_AGENT_PORT, 기본 59982>)로 띄운다 — 둘 다 이 파일이 띄운다. 메일함은 데모 메일함(실제 메일 없음, 보내지 않음).
// 사람 이름 · 회사 · 메일은 지어낸 것이다(한지우 · 서민재, 하늘데이터 윤서진).
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { test, expect, uniq } from '../../lib/fixtures.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const WIDE = { width: 1440, height: 900 }
const PHONE = { width: 390, height: 844 }
const LLM_PORT = Number(process.env.RT_FAKE_LLM_PORT || 59981)
const AGENT_PORT = Number(process.env.RT_FAKE_AGENT_PORT || 59982)
const SHOTS = path.resolve(here, '../../../openspec/specs/mail-card-actions/e2e/results')
test.describe.configure({ mode: 'serial' })

const MAIL = {
  sender: '윤서진 <seojin@haneul-data.example>',
  subject: '데이터 이전 협업 제안드립니다',
  body: '한지우 님, 안녕하세요. 하늘데이터 윤서진입니다.\n귀사의 레거시 데이터 이전 프로젝트에 함께하고 싶어 연락드립니다.\n저희는 지난 3년간 제조 · 유통 고객 40곳의 데이터 이전을 맡았습니다.\n다음 주에 30분 정도 통화가 가능할까요?\n\n윤서진 드림\n하늘데이터 사업개발팀',
  text: '하늘데이터 윤서진 님께 데이터 이전 협업 제안 확인 회신',
}
const DRAFT = { subject: 'Re: 데이터 이전 협업 제안드립니다', body: '윤서진 님, 안녕하세요.\n\n제안 감사합니다. 내부 검토 후 [날짜]까지 통화 가능한 시간을 알려 드리겠습니다.\n\n한지우 드림' }
const RESEARCH = '# haneul-data.example 알아보기\n하늘데이터는 데이터 이전 · 통합을 하는 회사예요(출처: https://haneul-data.example/about).\n- 제조 · 유통 고객 40곳의 이전 사례\n\n이 메일에 답할 때 알아 둘 점: 통화 전에 이전 대상 시스템 목록을 물어보세요.'

// ---- the fake model: the follow-up judge picks 회의 잡기 · 제안서 초안; the reply draft; the chat's router hands every turn to the agent ----
const llm = { calls: [] }
// ---- the fake deepagents: every /chat/stream body is kept ----
const agent = { bodies: [] }
let servers = []
const listen = (srv, port) => new Promise((ok, no) => srv.once('error', no).listen(port, '127.0.0.1', () => { servers.push(srv); ok() }))
test.beforeAll(async () => {
  await listen(http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      let b = {}
      try { b = JSON.parse(raw) } catch { /* not json */ }
      const text = (b.messages || []).map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n')
      llm.calls.push({ judge: !!b.logprobs, text })
      res.writeHead(200, { 'content-type': 'application/json' })
      if (b.logprobs) {
        const options = [...text.matchAll(/^([A-Z])\) (.+)$/gm)].map((m) => ({ letter: m[1], label: m[2] }))
        const want = text.includes('다음에 할 일은') ? { '회의 잡기': 0.5, '제안서 초안': 0.3 } : null
        const top = want ? options.filter((o) => Object.keys(want).some((w) => o.label.startsWith(w))).map((o) => ({ token: o.letter, logprob: Math.log(want[Object.keys(want).find((w) => o.label.startsWith(w))]) }))
          : [{ token: (options.at(-1) || { letter: 'A' }).letter, logprob: Math.log(0.9) }]
        const rest = options.find((o) => !top.some((t) => t.token === o.letter))
        if (rest) top.push({ token: rest.letter, logprob: Math.log(0.08) })
        return res.end(JSON.stringify({ choices: [{ message: { content: top[0].token }, logprobs: { content: [{ token: top[0].token, logprob: top[0].logprob, top_logprobs: top }] } }] }))
      }
      const sys = String(b.messages?.[0]?.content || '')
      const answer = sys.startsWith('You write the reply e-mail') ? JSON.stringify(DRAFT) : /DELEGATE/.test(text) ? 'DELEGATE' : '{}'
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: answer }, finish_reason: 'stop' }] }))
    })
  }), LLM_PORT)
  await listen(http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', async () => {
      if (!req.url.endsWith('/chat/stream')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('[]') }
      let body = {}
      try { body = JSON.parse(raw) } catch { /* not json */ }
      agent.bodies.push(body)
      const research = String(body.message || '').includes('회사를 알아봐 주세요')
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      if (body.conversation_id) res.write(`event: metadata\ndata: ${JSON.stringify({ conversation_id: body.conversation_id })}\n\n`)
      // (a moment of 「하는 중…」 before the answer)
      if (research) await new Promise((ok) => setTimeout(ok, 1500))
      res.write(`data: ${JSON.stringify({ type: 'token', content: research ? RESEARCH : '메일을 읽었어요. 장점은 이전 경험(40곳)이고, 확인할 점은 비용과 일정이에요.' })}\n\n`)
      res.end()
    })
  }), AGENT_PORT)
})
test.afterAll(async () => { for (const s of servers) await new Promise((ok) => s.close(ok)); servers = [] })

const shot = async (page, name) => {
  await calm(page)
  fs.mkdirSync(SHOTS, { recursive: true })
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) })
  await page.screenshot({ path: test.info().outputPath(`${name}.png`) })
}
// the sheet's opening animation is over
const calm = (page) => page.evaluate(() => Promise.race([
  Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming?.().iterations !== Infinity).map((a) => a.finished.catch(() => {}))),
  new Promise((ok) => setTimeout(ok, 3000)),
]))
const sheetOf = (page) => page.locator('[data-test="mail-sheet"]')
const homeCard = (page, a) => page.locator(`[data-test="action-card"][data-action-id="${a.id}"]`)
const composer = (page) => page.locator('[data-test="chat-composer"]').last()
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
async function drag(page, source, target, { drop = true } = {}) {
  const dt = await page.evaluateHandle(() => new DataTransfer())
  await source.dispatchEvent('dragstart', { dataTransfer: dt })
  await target.dispatchEvent('dragenter', { dataTransfer: dt })
  await target.dispatchEvent('dragover', { dataTransfer: dt })
  if (!drop) return dt
  await target.dispatchEvent('drop', { dataTransfer: dt })
  await source.dispatchEvent('dragend', { dataTransfer: dt }).catch(() => {})
  return dt
}
// a conversation as one person's messenger lists it (a room of two is named after the other person)
const roomTitle = async (c, id) => ((await c.get('/team/threads')).body || []).find((x) => x.id === id)?.title
const cleanup = async (db, u) => {
  await db.q('delete from pro_actions where user_id=$1', [u.id])
  await db.q('delete from pro_demo_mail where user_id=$1', [u.id])
  await db.q('delete from context_threads where tenant_id=$1 and user_id=$2', [db.tenant, u.id])
}

// a demo mailbox with the collaboration mail and the Reply card the triage made from it (the user's screen)
async function setup(pageAs, db, area, { viewport = WIDE, touch = false, theme = null, dock = false } = {}) {
  const page = await pageAs(area, { viewport, touch })
  if (theme) await page.addInitScript((th) => { try { localStorage.setItem('pgpt-pro-theme', th) } catch { /* none */ } }, theme)
  if (dock) await page.addInitScript(() => { try { localStorage.setItem('pgl-messenger-dock', JSON.stringify({ dock: 'left', width: 420 })) } catch { /* none */ } })
  const u = page.user
  expect((await u.put('/me/lang', { lang: 'ko' })).status).toBe(200)
  await db.clearMain(u.id)
  await cleanup(db, u)
  await db.q(`insert into pro_mail_accounts(user_id, provider, address) values ($1,'demo',$2) on conflict (user_id) do update set provider='demo', address=$2`, [u.id, u.email])
  const mailId = `demo-mf-${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`
  await db.q('insert into pro_demo_mail(user_id, mail_id, sender, subject, body) values ($1,$2,$3,$4,$5)', [u.id, mailId, MAIL.sender, MAIL.subject, MAIL.body])
  const [a] = await db.q(`insert into pro_actions(user_id, verb, text, prompt, source) values ($1,'Reply',$2,$3,$4) returning *`,
    [u.id, MAIL.text, '데이터 이전 협업 제안에 회신해 주세요.', { mail_id: mailId, from: MAIL.sender, subject: MAIL.subject }])
  const ran = []
  page.on('request', (r) => { if (/\/api\/actions\/[^/]+\/run$/.test(r.url())) ran.push(r.url()) })
  return { page, u, a, ran }
}
async function openSheet(page, a, { phone = false } = {}) {
  await page.goto('/chat')
  if (phone) await page.locator('.seg button').filter({ hasText: '홈' }).click()
  await homeCard(page, a).click()
  const sheet = sheetOf(page)
  await expect(sheet.locator('[data-test="mail-original"]')).toContainText('윤서진 <seojin@haneul-data.example>')
  return sheet
}

test.describe('메일에 답장만 하지 않는다 — 할 일 줄 · 이 회사 알아보기 · 채팅에서 이어서 · 메일 멘션 (spec mail-card-actions)', () => {
  test('F-MF-01 답장 시트: 답장 위에 할 일 줄(이 회사 알아보기 · 채팅에서 이어서 · 판정 모델이 고른 회의 잡기 · 제안서 초안) — 누르면 무엇을 할지 말하고, 답장은 그대로 보낸다', async ({ pageAs, db }) => {
    const { page, u, a, ran } = await setup(pageAs, db, 'mf-sheet')
    const sheet = await openSheet(page, a)
    const row = sheet.locator('[data-test="follow-row"]')
    await expect(row.locator('[data-test^="follow-"][data-do]')).toHaveText(['이 회사 알아보기', '대화방에 공유', '채팅에서 이어서', '회의 잡기', '제안서 초안'])
    // the reply is still the main section, under the row
    await expect(sheet.locator('[data-test="mail-body"]')).toHaveValue(DRAFT.body)
    const [rb, rr] = [await row.boundingBox(), await sheet.locator('[data-test="mail-reply"]').boundingBox()]
    expect(rb.y + rb.height).toBeLessThanOrEqual(rr.y)
    await shot(page, 'f-mf-01a-reply-sheet-row')
    // a pill only says what it will do; nothing runs
    await row.locator('[data-test="follow-research"]').click()
    const say = sheet.locator('[data-test="follow-say"]')
    await expect(say).toContainText('보낸 분의 회사(윤서진 · haneul-data.example)를 웹과 Lite 가 이미 아는 것')
    await expect(say).toContainText('결과는 채팅의 새 대화에 남아요. 메일을 보내거나 일정을 만들지는 않아요.')
    await expect(say.locator('[data-test="follow-go"]')).toHaveText('알아보기 시작')
    await shot(page, 'f-mf-01b-research-says')
    await row.locator('[data-test="follow-meeting"]').click()
    await expect(say).toContainText('시간을 제안하는 답장 문안을 써요')
    await say.locator('[data-test="follow-cancel"]').click()
    await expect(say).toHaveCount(0)
    expect(agent.bodies.length).toBe(0)
    // the judge's picks stay on the card
    const [kept] = await db.q('select source from pro_actions where id=$1', [a.id])
    expect(kept.source.follow.suggest.map((x) => x.key)).toEqual(['meeting', 'proposal'])
    // the reply works as before: changed, sent (the demo mailbox records it)
    await sheet.locator('[data-test="mail-body"]').fill(`${DRAFT.body}\n\n추신: 이전 대상 시스템 목록을 미리 보내 주시면 좋겠습니다.`)
    await sheet.locator('[data-test="mail-send"]').click()
    await expect(sheet.locator('[data-test="mail-sent"]')).toContainText('기록했어요')
    const [sent] = await db.q('select source from pro_actions where id=$1', [a.id])
    expect(sent.source.sent.subject).toBe(DRAFT.subject)
    expect(sent.source.reply.body).toContain('추신: 이전 대상 시스템 목록')
    // (the row stays after the reply)
    await expect(row.locator('[data-test="follow-research"]')).toBeVisible()
    await shot(page, 'f-mf-01c-replied')
    expect(ran).toEqual([])
    expect(page.errors).toEqual([])
    await cleanup(db, u)
  })

  test('F-MF-02 「이 회사 알아보기」 → 하는 중 → 「회사 알아본 결과 · 열기」(시트 · Home 카드) → 그 메일의 대화에 답, 에이전트는 메일 맥락을 받았다', async ({ pageAs, db }) => {
    const { page, u, a } = await setup(pageAs, db, 'mf-research')
    agent.bodies = []
    const sheet = await openSheet(page, a)
    await sheet.locator('[data-test="follow-research"]').click()
    await sheet.locator('[data-test="follow-go"]').click()
    const note = sheet.locator('[data-test="follow-run"][data-key="research"]')
    await expect(note).toHaveAttribute('data-status', 'running')
    await expect(note).toContainText('이 회사 알아보기 · 하는 중…')
    await shot(page, 'f-mf-02a-running')
    await expect(note).toHaveAttribute('data-status', 'done', { timeout: 30000 })
    await expect(note).toHaveText('회사 알아본 결과 · 열기')
    // what the agent was asked: the company, the mail as data, what Lite knows
    const asked = agent.bodies.find((b) => String(b.message).includes('회사를 알아봐 주세요'))
    expect(asked.message).toContain('메일 도메인: haneul-data.example')
    expect(asked.message).toContain('- 보낸 사람: 윤서진 <seojin@haneul-data.example>')
    expect(asked.message).toContain('- 제목: 데이터 이전 협업 제안드립니다')
    expect(asked.message).toContain('귀사의 레거시 데이터 이전 프로젝트에 함께하고 싶어')
    expect(asked.message).toContain('[Lite 가 아는 것')
    expect(asked.message).toContain('메일을 보내거나 답장하거나 일정을 만들지 마세요')
    await shot(page, 'f-mf-02b-done-note')
    // the Home card says it too
    await sheet.locator('.x').first().click()
    const line = homeCard(page, a).locator('[data-test="action-follow"]')
    await expect(line).toHaveText('회사 알아본 결과 · 열기')
    await shot(page, 'f-mf-02c-home-card-line')
    await line.click()
    // the mail's own conversation of the chat: the request with the mail's chip, and the answer
    await expect(page).toHaveURL(/\/chat\/c\/mail-research-/)
    // (a long answer under a 「# 제목」 line is a document card)
    await expect(page.locator('.doc').last()).toContainText('haneul-data.example 알아보기')
    await expect(page.locator('.doc').last()).toContainText('하늘데이터는 데이터 이전 · 통합을 하는 회사예요')
    await expect(page.locator('[data-test="sent-ref"][data-kind="mail"]').last()).toContainText(MAIL.subject)
    await shot(page, 'f-mf-02d-result-conversation')
    // the conversation is filed (the chat's 대화 list)
    const [ctx] = await db.q('select title from context_threads where tenant_id=$1 and user_id=$2 and conversation_id like $3', [db.tenant, u.id, 'mail-research-%'])
    expect(ctx.title).toBe('haneul-data.example 알아보기')
    // nothing was sent
    const [row] = await db.q('select status, source from pro_actions where id=$1', [a.id])
    expect(row.status).toBe('open')
    expect(row.source.sent).toBeUndefined()
    expect(page.errors).toEqual([])
    await cleanup(db, u)
  })

  test('F-MF-03 「채팅에서 이어서」 → 채팅 입력창에 메일 칩(봉투 · 보낸 사람 · 제목) → 할 일을 적어 보내면 에이전트가 메일을 읽는다', async ({ pageAs, db }) => {
    const { page, u, a } = await setup(pageAs, db, 'mf-chat')
    agent.bodies = []
    const sheet = await openSheet(page, a)
    await sheet.locator('[data-test="follow-chat"]').click()
    await expect(sheet.locator('[data-test="follow-say"]')).toContainText('채팅 입력창에 이 메일을 멘션으로 붙여요')
    await sheet.locator('[data-test="follow-go"]').click()
    await expect(sheetOf(page)).toHaveCount(0)
    const chip = composer(page).locator('[data-test="chat-ref-chip"][data-kind="mail"]')
    await expect(chip).toHaveAttribute('data-state', 'ready', { timeout: 15000 })
    await expect(chip).toContainText(MAIL.subject)
    await expect(chip).toContainText('윤서진')
    await expect(composer(page).locator('textarea')).toBeFocused()
    await composer(page).locator('textarea').fill('이 제안 검토해서 장단점 정리해 줘')
    await shot(page, 'f-mf-03a-chat-chip')
    await composer(page).locator('textarea').press('Enter')
    await expect(page.locator('[data-test="sent-ref"][data-kind="mail"]').last()).toContainText(MAIL.subject)
    await expect.poll(() => agent.bodies.length, { timeout: 30000 }).toBeGreaterThan(0)
    const said = agent.bodies.at(-1).message
    expect(said).toContain('이 제안 검토해서 장단점 정리해 줘')
    expect(said).toContain('사용자가 가리킨 메일 — 이 요청은 이 메일에 대한 것이에요')
    expect(said).toContain('- 보낸 사람: 윤서진 <seojin@haneul-data.example>')
    expect(said).toContain('다음 주에 30분 정도 통화가 가능할까요?')
    await expect(page.locator('.bubble.agent').last()).toContainText('장점은 이전 경험(40곳)')
    await shot(page, 'f-mf-03b-agent-answered')
    // the sent chip opens the mail again
    await page.locator('[data-test="sent-ref"][data-kind="mail"]').last().click()
    await expect(sheetOf(page).locator('[data-test="mail-original"]')).toContainText(MAIL.subject)
    expect(page.errors).toEqual([])
    await cleanup(db, u)
  })

  test('F-MF-04 Home 카드 · 시트 머리의 손잡이를 AI 채팅 입력창에 끌어 놓으면 「AI에게 이 메일로 묻기」 → 메일 칩(한 번만)', async ({ pageAs, db }) => {
    const { page, u, a } = await setup(pageAs, db, 'mf-drag-chat')
    await page.goto('/chat')
    await composer(page).locator('textarea').waitFor()
    await drag(page, homeCard(page, a), composer(page).locator('textarea'), { drop: false })
    await expect(composer(page).locator('[data-test="chat-dropzone"]')).toContainText('AI에게 이 메일로 묻기')
    await page.waitForTimeout(450)
    await shot(page, 'f-mf-04a-card-over-chat')
    await drag(page, homeCard(page, a), composer(page).locator('textarea'))
    const chip = composer(page).locator('[data-test="chat-ref-chip"][data-kind="mail"]')
    await expect(chip).toHaveAttribute('data-state', 'ready', { timeout: 15000 })
    await expect(chip).toContainText(MAIL.subject)
    // the open sheet's handle: while it is dragged the sheet steps aside; the same mail is not added twice
    await homeCard(page, a).click()
    const grip = sheetOf(page).locator('[data-test="mail-drag"]')
    const dt = await page.evaluateHandle(() => new DataTransfer())
    await grip.dispatchEvent('dragstart', { dataTransfer: dt })
    await expect(page.locator('.veil.passing')).toHaveCount(1)
    await shot(page, 'f-mf-04b-sheet-handle-dragging')
    for (const t of ['dragenter', 'dragover', 'drop']) await composer(page).locator('textarea').dispatchEvent(t, { dataTransfer: dt })
    await grip.dispatchEvent('dragend', { dataTransfer: dt })
    await expect(page.locator('.veil.passing')).toHaveCount(0)
    await expect(composer(page).locator('[data-test="chat-ref-chip"]')).toHaveCount(1)
    expect(page.errors).toEqual([])
    await cleanup(db, u)
  })

  test('F-MF-05 붙여 둔 메신저에 메일을 끌어 놓으면 메일 멘션 → 동료는 요약만(본문 없음) → 본문 보기 요청 → 주인이 본문 공유 → 동료가 본문을 봄', async ({ pageAs, as, db }) => {
    const { page, u, a } = await setup(pageAs, db, 'mf-owner', { dock: true })
    const mate = await as('mf-mate')
    await mate.get('/team')
    await u.get('/team')
    const title = `하늘데이터 협업 ${uniq('t').slice(-4)}`
    const t = await u.post('/team/threads', { members: [mate.id], title })
    expect(t.status, t.text).toBe(200)
    const [mineTitle, mateTitle] = [await roomTitle(u, t.body.id), await roomTitle(mate, t.body.id)]
    try {
      await page.goto('/chat')
      await homeCard(page, a).waitFor()
      await page.locator('button.msg-btn').click()
      await page.locator('.ms .tabs button').filter({ hasText: '대화' }).click()
      await page.locator('.ms .th').filter({ hasText: mineTitle }).first().click()
      await page.locator('.ms .cmp textarea').waitFor()
      const conv = page.locator('.ms .pane .msgs')
      await drag(page, homeCard(page, a), conv, { drop: false })
      await expect(page.locator('[data-test="msg-dropzone"]')).toContainText('여기에 놓으면 메일을 멘션해요')
      await page.waitForTimeout(450)
      await shot(page, 'f-mf-05a-card-over-messenger')
      await drag(page, homeCard(page, a), conv)
      const chip = page.locator('[data-test="msg-ref-chip"][data-kind="mail"]')
      await expect(chip).toContainText(MAIL.subject)
      await expect(chip.locator('[data-test="msg-mail-body"] input')).not.toBeChecked()
      await page.locator('.ms .cmp textarea').fill('하늘데이터에서 온 협업 제안이에요. 같이 봐 주세요')
      await shot(page, 'f-mf-05b-mail-chip')
      await page.locator('[data-test="msg-send"]').click()
      const mine = page.locator('.ms .msg.mine [data-test="mail-ref"]').last()
      await expect(mine).toHaveAttribute('data-state', 'mine')
      await expect(mine).toContainText('다른 사람에게는 요약만 보여요')
      // what the room keeps: no body
      const [stored] = await db.q(`select messages from chats where id=$1 order by coalesce(public.pro_chat_ts(messages), now()) desc limit 1`, [t.body.id])
      expect(stored.messages.pgpt.kind).toBe('mailref')
      expect(JSON.stringify(stored)).not.toContain('레거시 데이터 이전')
      // 서민재: the summary only
      const pb = await pageAs('mf-mate', { viewport: WIDE })
      await pb.addInitScript(() => { try { localStorage.setItem('pgl-messenger-dock', JSON.stringify({ dock: 'left', width: 420 })) } catch { /* none */ } })
      await pb.goto('/chat')
      await pb.locator('button.msg-btn').click()
      await pb.locator('.ms .tabs button').filter({ hasText: '대화' }).click()
      await pb.locator('.ms .th').filter({ hasText: mateTitle }).first().click()
      const card = pb.locator('.ms .msg [data-test="mail-ref"]').last()
      await expect(card).toHaveAttribute('data-state', 'summary')
      await expect(card.locator('[data-test="mail-ref-subject"]')).toHaveText(MAIL.subject)
      await expect(card.locator('[data-test="mail-ref-from"]')).toContainText('윤서진 · haneul-data.example')
      await expect(pb.locator('.ms')).not.toContainText('레거시 데이터 이전')
      await shot(pb, 'f-mf-05c-colleague-summary')
      await card.locator('[data-test="mail-ref-request"]').click()
      await expect(card).toHaveAttribute('data-state', 'requested')
      // the owner is told, and shares the body with the room
      await expect.poll(async () => (await db.q(`select count(*)::int as n from notifications where user_id=$1 and type='mail_access'`, [u.id]))[0].n).toBe(1)
      await mine.locator('[data-test="mail-ref-share"]').click()
      await expect(mine).toContainText('이 대화방이 본문을 볼 수 있어요')
      await expect(card).toHaveAttribute('data-state', 'shared', { timeout: 15000 })
      await card.locator('[data-test="mail-ref-open"]').click()
      await expect(card.locator('[data-test="mail-ref-body"]')).toContainText('귀사의 레거시 데이터 이전 프로젝트')
      await shot(pb, 'f-mf-05d-colleague-shared-body')
      expect(pb.errors).toEqual([])
      expect(page.errors).toEqual([])
    } finally {
      await db.q('delete from chats where id=$1', [t.body.id]).catch(() => {})
      await db.q('delete from chat_rooms where id=$1', [t.body.id]).catch(() => {})
      await db.q(`delete from notifications where user_id=$1 and type='mail_access'`, [u.id]).catch(() => {})
      await cleanup(db, u)
    }
  })

  for (const theme of ['light', 'dark']) {
    test(`F-MF-06 휴대폰(390px · ${theme === 'light' ? '밝은' : '밤'} 테마): 답장 시트의 할 일 줄은 한 줄(옆으로 넘김), 화면이 옆으로 넘치지 않고 답장 · 보내기가 그대로`, async ({ pageAs, db }) => {
      const { page, u, a } = await setup(pageAs, db, `mf-phone-${theme}`, { viewport: PHONE, touch: true, theme })
      const sheet = await openSheet(page, a, { phone: true })
      const row = sheet.locator('[data-test="follow-row"]')
      await expect(row.locator('[data-test="follow-proposal"]')).toBeAttached()
      await expect(sheet.locator('[data-test="mail-body"]')).toHaveValue(DRAFT.body)
      const m = await page.evaluate(() => {
        const r = document.querySelector('[data-test="follow-row"]')
        const s = document.querySelector('[data-test="mail-sheet"]').getBoundingClientRect()
        return { rowH: r.getBoundingClientRect().height, scroll: r.scrollWidth > r.clientWidth, sheetR: s.right, sheetL: s.left }
      })
      expect(m.rowH).toBeLessThan(44) // one line
      expect(m.scroll).toBe(true)     // it scrolls sideways — never squeezed
      expect(m.sheetL).toBeGreaterThanOrEqual(0)
      expect(m.sheetR).toBeLessThanOrEqual(PHONE.width)
      expect(await noOverflow(page)).toBe(true)
      await shot(page, `f-mf-06a-phone-${theme}`)
      // a pill's line fits too
      await row.locator('[data-test="follow-research"]').click()
      const say = sheet.locator('[data-test="follow-say"]')
      await expect(say.locator('[data-test="follow-go"]')).toBeVisible()
      expect((await say.boundingBox()).x + (await say.boundingBox()).width).toBeLessThanOrEqual(PHONE.width)
      expect(await noOverflow(page)).toBe(true)
      await shot(page, `f-mf-06b-phone-say-${theme}`)
      // the reply is still there and sends
      await say.locator('[data-test="follow-cancel"]').click()
      await sheet.locator('[data-test="mail-send"]').scrollIntoViewIfNeeded()
      await sheet.locator('[data-test="mail-send"]').click()
      await expect(sheet.locator('[data-test="mail-sent"]')).toContainText('기록했어요')
      expect(page.errors).toEqual([])
      await cleanup(db, u)
    })
  }
  // (F-MF-07 「동료에게 공유」 → 「대화방에 공유」: the sheet's own room picker — e2e/tests/feature/mail-room-share.spec.js F-MR-01~04)
})
