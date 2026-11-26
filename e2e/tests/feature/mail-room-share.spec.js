// 메일을 대화방에 (2026-11-27 사용자: 「메일이 왔을때 그걸 대화방에 공유하는 기능도 필요.」 — 스펙 openspec/specs/mail-room-share, 서버 lib/mailRooms.js).
// 메일 시트의 「대화방에 공유」(모든 시트에 있음)를 누르면 시트 안에서 대화방을 고른다: 판정 모델이 고른 방이 먼저(「추천」 · 까닭), 그다음 내 대화방,
// 대화가 없는 팀원. 한마디 · 「본문도 공유」 · 「앞으로 오는 메일도 이 방에 올리기」(보낸 사람 · 회사)를 정하고, 방에 무엇이 보일지 읽은 뒤 「보내기」.
// 약속을 정하면 그 회사의 새 메일은 들어올 때 그 방에 저절로 올라간다(「메일 자동 공유」, 본문은 약속을 정할 때의 「본문도 공유」대로 — 화면에서는 켜짐이 기본).
// 서버는 가짜 모델(PRO_LLM_BASE_URL=http://127.0.0.1:<RT_FAKE_LLM_PORT, 기본 59961>/v1)로 띄운다 — 이 파일이 띄운다. 메일함은 데모 메일함(보내지 않음).
// 사람 이름 · 회사 · 메일은 지어낸 것이다(에이스정밀 김하늘 · 이준호).
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { test, expect, uniq } from '../../lib/fixtures.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const WIDE = { width: 1440, height: 900 }
const PHONE = { width: 390, height: 844 }
const LLM_PORT = Number(process.env.RT_FAKE_LLM_PORT || 59961)
const SHOTS = path.resolve(here, '../../../openspec/specs/mail-room-share/e2e/results')
test.describe.configure({ mode: 'serial' })

const MAIL = {
  sender: '김하늘 <haneul@ace-precision.example>',
  subject: '3분기 부품 견적 요청드립니다',
  body: '안녕하세요, 에이스정밀 구매팀 김하늘입니다.\n3분기에 필요한 베어링 하우징 1,200개와 샤프트 800개의 견적을 부탁드립니다.\n납기는 9월 말까지 희망합니다.\n\n김하늘 드림',
  text: '에이스정밀 3분기 부품 견적 요청을 확인합니다',
}
const ROOM = '에이스정밀 납품'

// ---- the fake model: the room judge picks the room named ROOM; the triage makes a card for each mail whose subject is in `cards` ----
const llm = { calls: [], cards: [] }
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
        const hit = (text.includes('어느 방에 올릴') && options.find((o) => o.label.startsWith(`「${ROOM}`))) || options.at(-1) || { letter: 'A' }
        const other = options.find((o) => o.letter !== hit.letter)?.letter || 'Z'
        return res.end(JSON.stringify({ choices: [{ message: { content: hit.letter }, logprobs: { content: [{ token: hit.letter, logprob: Math.log(0.84), top_logprobs: [{ token: hit.letter, logprob: Math.log(0.84) }, { token: other, logprob: Math.log(0.16) }] }] } }] }))
      }
      const sys = String(b.messages?.[0]?.content || '')
      let answer = '{}'
      if (sys.startsWith("You read a user's newest emails")) {
        let mails = []
        try { mails = JSON.parse(String(b.messages?.at(-1)?.content || '[]')) } catch { /* none */ }
        answer = JSON.stringify({ actions: mails.filter((m) => llm.cards.includes(m.subject)).map((m) => ({ mail_id: m.id, verb: 'Review', kind: 'task', text: `${m.subject} — 확인합니다`, icon_domain: '', due: null, prompt: '확인' })), brief: '' })
      }
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: answer }, finish_reason: 'stop' }] }))
    })
  }), LLM_PORT)
})
test.afterAll(async () => { for (const s of servers) await new Promise((ok) => s.close(ok)); servers = [] })

const shot = async (page, name) => {
  await calm(page)
  fs.mkdirSync(SHOTS, { recursive: true })
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) })
  await page.screenshot({ path: test.info().outputPath(`${name}.png`) })
}
const calm = (page) => page.evaluate(() => Promise.race([
  Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming?.().iterations !== Infinity).map((a) => a.finished.catch(() => {}))),
  new Promise((ok) => setTimeout(ok, 3000)),
]))
const sheetOf = (page) => page.locator('[data-test="mail-sheet"]')
const homeCard = (page, a) => page.locator(`[data-test="action-card"][data-action-id="${a.id}"]`)
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
const cleanup = async (db, u) => {
  await db.q('delete from pro_actions where user_id=$1', [u.id])
  await db.q('delete from pro_demo_mail where user_id=$1', [u.id])
  await db.q('delete from pro_mail_seen where user_id=$1', [u.id])
}
const dropRoom = async (db, id) => {
  await db.q('delete from chats where id=$1', [id]).catch(() => {})
  await db.q('delete from pro_chat_reads where room_id=$1', [id]).catch(() => {})
  await db.q('delete from chat_rooms where id=$1', [id]).catch(() => {})
}
const messages = async (c, room) => ((await c.get(`/team/threads/${room}/messages`)).body?.messages || [])

// a demo mailbox with the quote mail and the Home card the triage made of it; ROOM with two teammates (one has just spoken there)
async function setup(pageAs, as, db, area, { viewport = WIDE, touch = false, theme = null } = {}) {
  const page = await pageAs(area, { viewport, touch })
  if (theme) await page.addInitScript((th) => { try { localStorage.setItem('pgpt-pro-theme', th) } catch { /* none */ } }, theme)
  const u = page.user
  expect((await u.put('/me/lang', { lang: 'ko' })).status).toBe(200)
  await db.clearMain(u.id)
  await cleanup(db, u)
  await db.q(`insert into pro_mail_accounts(user_id, provider, address) values ($1,'demo',$2) on conflict (user_id) do update set provider='demo', address=$2`, [u.id, u.email])
  const mailId = `demo-mr-${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`
  await db.q('insert into pro_demo_mail(user_id, mail_id, sender, subject, body) values ($1,$2,$3,$4,$5)', [u.id, mailId, MAIL.sender, MAIL.subject, MAIL.body])
  // (it arrived before: a poll below reads only what the test sends)
  await db.q('insert into pro_mail_seen values ($1,$2) on conflict do nothing', [u.id, mailId])
  const [a] = await db.q(`insert into pro_actions(user_id, verb, text, prompt, source) values ($1,'Review',$2,$3,$4) returning *`,
    [u.id, MAIL.text, '견적 요청을 확인해 주세요.', { mail_id: mailId, from: MAIL.sender, subject: MAIL.subject, kind: 'task' }])
  const mate = await as(`${area}-m1`), mate2 = await as(`${area}-m2`)
  for (const c of [mate, mate2, u]) await c.get('/team')
  const title = `${ROOM} ${uniq('r').slice(-4)}`
  const t = await u.post('/team/threads', { members: [mate.id, mate2.id], title })
  expect(t.status).toBe(200)
  expect((await mate.post(`/team/threads/${t.body.id}/messages`, { text: '에이스정밀 3분기 납품 일정 정리했어요' })).status).toBe(200)
  const other = await u.post('/team/threads', { members: [mate2.id], title: `주간 회의 ${uniq('w').slice(-4)}` })
  return { page, u, a, mate, mate2, room: t.body.id, title, rooms: [t.body.id, other.body.id] }
}
async function openSheet(page, a, { phone = false } = {}) {
  await page.goto('/chat')
  if (phone) await page.locator('.seg button').filter({ hasText: '홈' }).click()
  await homeCard(page, a).click()
  const sheet = sheetOf(page)
  await expect(sheet.locator('[data-test="mail-original"]')).toContainText(MAIL.sender)
  return sheet
}

test.describe('메일을 대화방에 — 고르기 · 보내기 · 들어올 때 저절로 · 끄기 (spec mail-room-share)', () => {
  test('F-MR-01 「대화방에 공유」: 추천 방이 먼저(까닭) → 한마디 · 「앞으로 이 회사 메일도」 → 방에 보일 것을 읽고 보내기 → 공유한 대화방 · 동료는 요약만', async ({ pageAs, as, db }) => {
    const { page, u, a, mate, room, title, rooms } = await setup(pageAs, as, db, 'mr-pick')
    try {
      const sheet = await openSheet(page, a)
      const row = sheet.locator('[data-test="follow-row"]')
      await expect(row.locator('[data-test="follow-share"]')).toHaveText('대화방에 공유')
      await row.locator('[data-test="follow-share"]').click()
      const picker = sheet.locator('[data-test="room-picker"]')
      await expect(picker.locator('[data-test="room-option"]').first()).toHaveAttribute('data-room', room)
      const first = picker.locator('[data-test="room-option"]').first()
      await expect(first).toHaveAttribute('data-suggested', '')
      await expect(first).toContainText('추천')
      await expect(first).toContainText('이 메일과 닿는 이야기를 하는 방')
      await expect(picker.locator('[data-test="room-option"][data-suggested]')).toHaveCount(1)
      // (a room's line names the others in it, never me)
      await expect(picker.locator('[data-test="room-option"]').nth(1)).not.toContainText(`${u.name || '회귀-mr-pick'},`)
      await first.scrollIntoViewIfNeeded()
      // (the picture shows the rooms only: this database's other teammates stay out of it)
      await page.evaluate(() => { for (const el of document.querySelectorAll('[data-test="room-person"], .sub')) el.style.visibility = 'hidden' })
      await shot(page, 'f-mr-01a-picker-suggested')
      // nothing was posted by opening it
      const before = (await messages(mate, room)).length
      await first.click()
      await expect(picker.locator('[data-test="room-to"]')).toContainText(title)
      await picker.locator('[data-test="room-note"]').fill('견적 요청 왔어요. 수량 확인 부탁드려요')
      await picker.locator('[data-test="room-follow"]').check()
      await expect(picker.locator('[data-test="room-follow-by"]')).toHaveText(['김하늘(haneul@ace-precision.example)에게서 오는 메일', 'ace-precision.example에서 오는 메일'])
      await expect(picker.locator('[data-test="room-follow-by"][data-by="domain"]')).toHaveAttribute('aria-checked', 'true')
      // 「본문도 공유」 is on unless turned off (2026-11-27 「메일 본문 내용 공유는 기본값임」)
      await expect(picker.locator('[data-test="room-body"]')).toBeChecked()
      await expect(picker.locator('[data-test="room-says"]')).toHaveText(`「${title}」에는 보낸 사람 · 제목 · 날짜와 본문이 보여요. 앞으로 ace-precision.example에서 오는 메일도 이 방에 올려요. 그 메일의 본문도 함께 보여요.`)
      await shot(page, 'f-mr-01b-compose')
      expect((await messages(mate, room)).length).toBe(before)
      await picker.locator('[data-test="room-send"]').click()
      await expect(sheet.locator('[data-test="room-sent"]')).toContainText(`「${title}」에 공유했어요`)
      await expect(picker).toHaveCount(0)
      const line = sheet.locator(`[data-test="room-shared-line"][data-room="${room}"]`)
      await expect(line).toContainText('본문 공유 중')
      await expect(line.locator('[data-test="room-rule"]')).toContainText('앞으로 ace-precision.example에서 오는 메일도 이 방에 올려요')
      await expect(line.locator('[data-test="room-rule"]')).toContainText('본문도 함께 보여요')
      await shot(page, 'f-mr-01c-shared')
      // the teammate: a mail mention they may open (the body is read from the owner's mailbox when opened — the message never holds it)
      const m = (await messages(mate, room)).at(-1)
      expect(m.kind).toBe('mailref')
      expect(m.body).toBe('견적 요청 왔어요. 수량 확인 부탁드려요')
      expect(m.refs[0].subject).toBe(MAIL.subject)
      expect(m.refs[0].state.card).toBe('shared')
      expect(JSON.stringify(m)).not.toContain('베어링 하우징')
      expect(await noOverflow(page)).toBe(true)
      expect(page.errors).toEqual([])
    } finally {
      for (const r of rooms) await dropRoom(db, r)
      await cleanup(db, u)
    }
  })

  test('F-MR-02 동료의 메신저: 메일 멘션 카드(요약 · 「본문 보기 요청」) — 본문은 보이지 않는다', async ({ pageAs, as, db }) => {
    const { u, a, room, rooms, title } = await setup(pageAs, as, db, 'mr-mate')
    const matePage = await pageAs('mr-mate-m1', { viewport: WIDE })
    try {
      const s = await u.post(`/actions/${a.id}/rooms`, { room, note: '견적 요청 왔어요' })
      expect(s.status).toBe(200)
      await matePage.goto('/chat')
      await matePage.locator('.msg-btn').click()
      const ms = matePage.locator('.ms')
      // (the inbox also lists the mention: the conversation itself is opened from 대화)
      await ms.locator('.tabs button, .seg button').filter({ hasText: '대화' }).first().click()
      await ms.locator('.th').filter({ hasText: title }).first().click()
      const card = ms.locator('[data-test="mail-ref"]').last()
      await expect(card).toHaveAttribute('data-state', 'summary')
      await expect(card.locator('[data-test="mail-ref-subject"]')).toHaveText(MAIL.subject)
      await expect(card).not.toContainText('베어링 하우징')
      await shot(matePage, 'f-mr-02-mate-summary')
      expect(matePage.errors).toEqual([])
    } finally {
      for (const r of rooms) await dropRoom(db, r)
      await cleanup(db, u)
    }
  })

  test('F-MR-03 메일이 오면: 약속한 회사의 새 메일은 그 방에 「메일 자동 공유」로 · 다른 회사는 아님 → 그 메일 시트에서 「그만 올리기」', async ({ pageAs, as, db }) => {
    const { page, u, a, mate, room, rooms } = await setup(pageAs, as, db, 'mr-auto')
    try {
      const s = await u.post(`/actions/${a.id}/rooms`, { room, follow: 'domain' })
      expect(s.status).toBe(200)
      const before = (await messages(mate, room)).length
      llm.cards = ['납품 일정 변경 안내', '신제품 소개']
      expect((await u.post('/mail/demo-arrive', { from: '이준호 <junho@ace-precision.example>', subject: '납품 일정 변경 안내', text: '다음 주 납품이 하루 늦어집니다.' })).status).toBe(200)
      expect((await u.post('/mail/demo-arrive', { from: '한소희 <sohee@other-maker.example>', subject: '신제품 소개', text: '신제품을 소개합니다.' })).status).toBe(200)
      const now = await messages(mate, room)
      expect(now.length - before).toBe(1)
      const auto = now.at(-1)
      expect(auto.auto?.by).toBe('domain')
      expect(auto.body).toBe('ace-precision.example에서 오는 메일은 이 방에 올리기로 했어요.')
      expect(auto.refs[0].subject).toBe('납품 일정 변경 안내')
      expect(auto.refs[0].state.card).toBe('summary')
      // the new mail's sheet says it went by the rule — and the rule can be turned off there
      const [a2] = await db.q(`select * from pro_actions where user_id=$1 and source->>'subject'=$2`, [u.id, '납품 일정 변경 안내'])
      await page.goto('/chat')
      await homeCard(page, a2).click()
      const sheet = sheetOf(page)
      const line = sheet.locator(`[data-test="room-shared-line"][data-room="${room}"]`)
      await expect(line.locator('[data-test="room-auto"]')).toContainText('ace-precision.example에서 오는 메일이라 저절로 올라갔어요')
      await line.scrollIntoViewIfNeeded()
      await shot(page, 'f-mr-03a-auto-sheet')
      await line.locator('[data-test="room-stop-auto"]').click()
      await expect(line.locator('[data-test="room-auto"]')).toContainText('지금은 꺼 둔 약속이에요')
      await expect(line.locator('[data-test="room-stop-auto"]')).toHaveCount(0)
      // the next mail of that company stays out
      llm.cards = ['추가 견적 문의']
      expect((await u.post('/mail/demo-arrive', { from: MAIL.sender, subject: '추가 견적 문의', text: '추가 견적을 여쭙니다.' })).status).toBe(200)
      expect((await messages(mate, room)).length - before).toBe(1)
      expect(page.errors).toEqual([])
    } finally {
      llm.cards = []
      for (const r of rooms) await dropRoom(db, r)
      await cleanup(db, u)
    }
  })

  test('F-MR-04 휴대폰 390 · 밤 테마: 팀원에게 바로(새 대화) · 본문도 공유 → 「본문 공유 중」 → 「본문 끄기」 → 요약만 · 화면이 넘치지 않음', async ({ pageAs, as, db }) => {
    const { page, u, a, rooms } = await setup(pageAs, as, db, 'mr-phone', { viewport: PHONE, touch: true, theme: 'dark' })
    const lone = await as('mr-phone-lone')
    await lone.get('/team')
    let dm = null
    try {
      const sheet = await openSheet(page, a, { phone: true })
      await sheet.locator('[data-test="follow-share"]').click()
      const picker = sheet.locator('[data-test="room-picker"]')
      await picker.locator('[data-test="room-find"]').fill(lone.name || '회귀-mr-phone-lone')
      const person = picker.locator(`[data-test="room-person"][data-person="${lone.id}"]`)
      await expect(person).toContainText('새 대화')
      await shot(page, 'f-mr-04a-phone-person')
      await person.click()
      await picker.locator('[data-test="room-body"]').check()
      await expect(picker.locator('[data-test="room-says"]')).toContainText('보낸 사람 · 제목 · 날짜와 본문이 보여요')
      expect(await noOverflow(page)).toBe(true)
      await shot(page, 'f-mr-04b-phone-compose')
      await picker.locator('[data-test="room-send"]').click()
      const sent = sheet.locator('[data-test="room-sent"]')
      await expect(sent).toContainText('공유했어요')
      dm = await sent.getAttribute('data-room')
      const line = sheet.locator(`[data-test="room-shared-line"][data-room="${dm}"]`)
      await expect(line).toContainText('본문 공유 중')
      expect((await messages(lone, dm)).at(-1).refs[0].state.card).toBe('shared')
      await line.locator('[data-test="room-stop-body"]').click()
      await expect(line).toContainText('요약만')
      expect((await messages(lone, dm)).at(-1).refs[0].state.card).toBe('summary')
      expect(await noOverflow(page)).toBe(true)
      await shot(page, 'f-mr-04c-phone-body-off')
      expect(page.errors).toEqual([])
    } finally {
      if (dm) await dropRoom(db, dm)
      for (const r of rooms) await dropRoom(db, r)
      await cleanup(db, u)
    }
  })

  test('F-MR-05 본문을 펼쳐 둔 동료: 주인이 「본문 끄기」를 누르면 펼친 본문이 곧바로 접히고, 같은 메일의 앞선 멘션도 요약으로 — 새로 고치지 않아도', async ({ pageAs, as, db }) => {
    const { u, a, rooms } = await setup(pageAs, as, db, 'mr-bodyoff')
    const mate = await pageAs('mr-bodyoff-m1', { viewport: { width: 1440, height: 900 } })
    let dm = null
    try {
      const first = await u.post(`/actions/${a.id}/rooms`, { person: mate.user.id, body: true, note: '본문까지 봐 주세요' })
      expect(first.status).toBe(200)
      dm = first.body.room.id
      expect((await u.post(`/actions/${a.id}/rooms`, { room: dm, body: true, note: '한 번 더 올려요' })).status).toBe(200)
      await mate.goto('/chat')
      await mate.locator('.msg-btn').click()
      const ms = mate.locator('.ms')
      await ms.locator('.tabs button').filter({ hasText: '대화' }).first().click()
      await ms.locator('.th').filter({ hasText: u.name || '회귀-mr-bodyoff' }).first().click()
      const cards = ms.locator('[data-test="mail-ref"]')
      await expect(cards).toHaveCount(2)
      for (const c of await cards.all()) await expect(c).toHaveAttribute('data-state', 'shared')
      await cards.last().getByText('본문 보기').click()
      await expect(ms.locator('[data-test="mail-ref-body"]')).toContainText('베어링 하우징')
      // the owner turns it off on the mail sheet (the same request the sheet sends)
      expect((await u.post(`/actions/${a.id}/rooms/${dm}/stop`, { what: 'body' })).status).toBe(200)
      for (const c of await cards.all()) await expect(c).toHaveAttribute('data-state', 'summary')
      await expect(ms.locator('[data-test="mail-ref-body"]')).toHaveCount(0)
      await shot(mate, 'f-mr-05-body-off-live')
      expect(mate.errors).toEqual([])
    } finally {
      if (dm) await dropRoom(db, dm)
      for (const r of rooms) await dropRoom(db, r)
      await cleanup(db, u)
    }
  })

  test('F-MR-06 동료가 앞선 멘션의 본문을 펼쳐 둔 채, 주인이 메신저 카드의 「공유 그만두기」로 뒤 멘션을 끈다 — 두 멘션 모두 요약, 펼친 본문도 곧바로 접힘', async ({ pageAs, as, db }) => {
    const { u, a, rooms } = await setup(pageAs, as, db, 'mr-cardoff')
    const mate = await pageAs('mr-cardoff-m1', { viewport: { width: 1440, height: 900 } })
    let dm = null
    try {
      const first = await u.post(`/actions/${a.id}/rooms`, { person: mate.user.id, body: true, note: '앞선 멘션' })
      expect(first.status).toBe(200)
      dm = first.body.room.id
      const second = await u.post(`/actions/${a.id}/rooms`, { room: dm, body: true, note: '뒤 멘션' })
      expect(second.status).toBe(200)
      await mate.goto('/chat')
      await mate.locator('.msg-btn').click()
      const ms = mate.locator('.ms')
      await ms.locator('.tabs button').filter({ hasText: '대화' }).first().click()
      await ms.locator('.th').filter({ hasText: u.name || '회귀-mr-cardoff' }).first().click()
      const cards = ms.locator('[data-test="mail-ref"]')
      await expect(cards).toHaveCount(2)
      await cards.first().getByText('본문 보기').click()
      await expect(ms.locator('[data-test="mail-ref-body"]')).toContainText('베어링 하우징')
      // the owner's 「공유 그만두기」 on the second (newer) mention's card — the request that card sends
      expect((await u.post('/team/refs/share', { messageId: second.body.message, index: 0, on: false })).status).toBe(200)
      for (const c of await cards.all()) await expect(c).toHaveAttribute('data-state', 'summary')
      await expect(ms.locator('[data-test="mail-ref-body"]')).toHaveCount(0)
      // again: the same mail posted anew (the body on — the default) shares it once more; the colleague opens the oldest one's body;
      // the owner stops it on the newest — the older ones, already stored as not shared, are sent again all the same
      const third = await u.post(`/actions/${a.id}/rooms`, { room: dm, body: true, note: '다시 올려요' })
      expect(third.status).toBe(200)
      await mate.reload()
      await mate.locator('.msg-btn').click()
      await ms.locator('.tabs button').filter({ hasText: '대화' }).first().click()
      await ms.locator('.th').filter({ hasText: u.name || '회귀-mr-cardoff' }).first().click()
      await expect(cards).toHaveCount(3)
      await expect(cards.first()).toHaveAttribute('data-state', 'shared')
      await cards.first().getByText('본문 보기').click()
      await expect(ms.locator('[data-test="mail-ref-body"]')).toContainText('베어링 하우징')
      expect((await u.post('/team/refs/share', { messageId: third.body.message, index: 0, on: false })).status).toBe(200)
      for (const c of await cards.all()) await expect(c).toHaveAttribute('data-state', 'summary')
      await expect(ms.locator('[data-test="mail-ref-body"]')).toHaveCount(0)
      expect(mate.errors).toEqual([])
    } finally {
      if (dm) await dropRoom(db, dm)
      for (const r of rooms) await dropRoom(db, r)
      await cleanup(db, u)
    }
  })
})
