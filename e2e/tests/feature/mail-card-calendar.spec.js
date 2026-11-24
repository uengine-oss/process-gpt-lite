// 운영 화면(2026-11-24): 채팅의 「오후 브리프」 「내일 오후 3시 UiPath 웨비나가 예정되어 있어요. 캘린더에 추가해 드릴게요.」 아래 칩
// 「Add · 내일 오후 3시 UiPath 웨비나를 캘린더에 추가합니다.」를 누르자 메일 시트의 답장 쓰기가 열렸다(「캘린더에 추가를 눌렀더니 왠
// 답장하기가 열리는...」). 고친 뒤(스펙 openspec/specs/mail-card-actions, 서버 lib/mailCard.js):
//   - 시트의 큰 단추는 카드가 하는 일을 따른다: 일정 카드는 메일에서 읽은 일정 양식과 「캘린더에 추가」, 답장 카드는 지금 그대로,
//     그 밖의 카드는 「에이전트에게 맡기기」 — 답장은 「답장도 쓰기」 아래로 접힌다. 누르기 전에는 아무것도 만들거나 보내지 않는다.
//   - 단추 말은 사람의 언어로: 「일정 추가」 · 「답장」 · 「납부」 (Home 카드 · 브리프 칩 · 시트 머리 · 받은 편지함)
// 이 묶음의 서버는 PRO_LLM_BASE_URL 을 이 파일이 띄우는 가짜 모델(http://127.0.0.1:<RT_FAKE_LLM_PORT, 기본 59967>/v1)로, Google 의 Gmail ·
// 캘린더 주소를 이 파일이 띄우는 가짜 Google(http://127.0.0.1:<RT_FAKE_GOOGLE_PORT, 기본 59966>)로 띄운다. 가짜 판정 모델은 웨비나
// 카드면 일정(A), 아니면 그 밖의 일(C)을 고르고, 일정 읽기는 「내일 오후 3시 · 웨비나」를 돌려준다. 실제 메일 · 캘린더 없음.
import http from 'node:http'
import crypto from 'node:crypto'
import { test, expect } from '../../lib/fixtures.js'

test.describe.configure({ mode: 'serial' })

const PHONE = { width: 390, height: 844 }
const LLM_PORT = Number(process.env.RT_FAKE_LLM_PORT || 59967)
const GOOGLE_PORT = Number(process.env.RT_FAKE_GOOGLE_PORT || 59966)
const DRAFT = { subject: 'Re: [초대] 에이전틱 자동화 웨비나 안내', body: '안녕하세요.\n\n웨비나에 참석하겠습니다.\n\n홍길동 드림' }
// tomorrow in Seoul: the mail says 「내일 오후 3시」
const seoulDate = (plusDays) => new Date(Date.now() + 9 * 3600_000 + plusDays * 864e5).toISOString().slice(0, 10)
const TOMORROW = seoulDate(1)
const WD = '일월화수목금토'
const koDay = (d) => { const [, m, day] = d.split('-').map(Number); return `${m}월 ${day}일 (${WD[new Date(`${d}T00:00:00Z`).getUTCDay()]})` }
const WEBINAR = {
  sender: '웨비나 사무국 <events@robotics-webinar.example>',
  subject: '[초대] 에이전틱 자동화 웨비나 안내',
  body: '홍길동 님, 안녕하세요.\n내일 오후 3시에 에이전틱 자동화 웨비나가 열립니다(60분).\n참여 링크: https://webinar.robotics-webinar.example/join/8812\n\n웨비나 사무국 드림',
  text: '내일 오후 3시 에이전틱 자동화 웨비나를 캘린더에 추가합니다.',
}
const BILL = {
  sender: '청구 담당 <billing@cloudhost.example>',
  subject: '11월 서버 이용료 청구서',
  body: '11월 서버 이용료 330,000원이 청구되었습니다. 11월 30일까지 납부해 주세요.\n\n클라우드호스트 청구 담당',
  text: '클라우드호스트 11월 서버 이용료 330,000원 납부',
  prompt: '클라우드호스트 11월 서버 이용료 330,000원을 11월 30일까지 납부할 수 있게 결제 방법을 확인해 주세요.',
}
const EVENT = { title: '에이전틱 자동화 웨비나', date: TOMORROW, start: '15:00', durationMin: 60, allDay: false, timezone: 'Asia/Seoul', location: '',
  link: 'https://webinar.robotics-webinar.example/join/8812', description: '웨비나 사무국이 보낸 초대 메일', basis: '내일 오후 3시' }

// ---------- the fake model ----------
const llm = { calls: [], readDelay: 1500 }
// ---------- the fake Google (Gmail raw · Calendar events) ----------
const google = { events: [], inserts: [], mails: new Map() }
let servers = []
const listen = (srv, port) => new Promise((ok, no) => srv.once('error', no).listen(port, '127.0.0.1', () => { servers.push(srv); ok() }))
const b64 = (s) => `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`
const rawMail = (m) => [`From: ${b64(m.sender.split(' <')[0])} <${m.sender.split('<')[1].replace('>', '')}>`, 'To: me@lite.example', `Subject: ${b64(m.subject)}`,
  `Date: ${new Date().toUTCString()}`, `Message-ID: <${crypto.randomUUID()}@fake-google.example>`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8',
  'Content-Transfer-Encoding: base64', '', Buffer.from(m.body).toString('base64')].join('\r\n')

test.beforeAll(async () => {
  await listen(http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', async () => {
      let body = {}
      try { body = JSON.parse(raw) } catch { /* not json */ }
      const sys = String(body.messages?.[0]?.content || '')
      const all = (body.messages || []).map((m) => String(m.content || '')).join('\n')
      llm.calls.push({ judge: !!body.logprobs, sys })
      res.writeHead(200, { 'content-type': 'application/json' })
      // the judge (lib/decide.js oddsOf): A 일정 · B 답장 · C 그 밖의 일 — the webinar card is 일정, others 그 밖의 일, sure at 94%
      const letter = /에이전틱 자동화 웨비나/.test(all) ? 'A' : 'C'
      if (body.max_tokens === 1 && body.logprobs) {
        const other = letter === 'A' ? 'C' : 'A'
        return res.end(JSON.stringify({ choices: [{ message: { content: letter }, logprobs: { content: [{ token: letter, top_logprobs: [{ token: letter, logprob: Math.log(0.94) }, { token: other, logprob: Math.log(0.06) }] }] } }] }))
      }
      let answer = DRAFT
      if (sys.startsWith('메일 카드가 캘린더에 넣으려는 일정')) { await new Promise((ok) => setTimeout(ok, llm.readDelay)); answer = EVENT }
      else if (sys.includes('JSON {"choice"')) answer = { choice: letter, confidence: 0.94 }
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify(answer) }, finish_reason: 'stop' }] }))
    })
  }), LLM_PORT)
  await listen(http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      const u = new URL(req.url, 'http://x')
      const json = (o, s = 200) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)) }
      const m = /^\/gmail\/v1\/users\/me\/messages\/([^/?]+)$/.exec(u.pathname)
      if (m && u.searchParams.get('format') === 'raw' && google.mails.has(m[1])) return json({ id: m[1], threadId: `t-${m[1]}`, raw: Buffer.from(google.mails.get(m[1])).toString('base64url') })
      if (u.pathname === '/calendar/v3/calendars/primary/events' && req.method === 'GET') {
        const min = new Date(u.searchParams.get('timeMin')).getTime(), max = new Date(u.searchParams.get('timeMax')).getTime()
        return json({ items: google.events.filter((e) => new Date(e.end.dateTime || `${e.end.date}T00:00:00+09:00`).getTime() > min && new Date(e.start.dateTime || `${e.start.date}T00:00:00+09:00`).getTime() < max) })
      }
      if (u.pathname === '/calendar/v3/calendars/primary/events' && req.method === 'POST') {
        const b = JSON.parse(raw || '{}')
        google.inserts.push(b)
        const id = `ev${google.inserts.length}${crypto.randomBytes(2).toString('hex')}`
        const ev = { id, ...b, htmlLink: `http://127.0.0.1:${GOOGLE_PORT}/calendar/event?eid=${id}` }
        google.events.push(ev)
        return json(ev)
      }
      if (u.pathname.startsWith('/calendar/event')) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end('<h1>가짜 Google 캘린더 일정</h1>') }
      json({ error: { message: 'not found' } }, 404)
    })
  }), GOOGLE_PORT)
})
test.afterAll(async () => { for (const s of servers) await new Promise((ok) => s.close(ok)); servers = [] })

// the sheet's opening animation is over (a picture taken during it shows Home through the sheet)
const calm = (page) => page.evaluate(() => Promise.race([
  Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming?.().iterations !== Infinity).map((a) => a.finished.catch(() => {}))),
  new Promise((ok) => setTimeout(ok, 3000)),
]))
const shot = async (page, name) => { await calm(page); await page.screenshot({ path: test.info().outputPath(name) }) }
const sheetOf = (page) => page.locator('[data-test="mail-sheet"]')
const homeCard = (page, a) => page.locator(`[data-test="action-card"][data-action-id="${a.id}"]`)
const cleanup = async (db, u) => {
  await db.q('delete from pro_actions where user_id=$1', [u.id])
  await db.q('delete from pro_demo_mail where user_id=$1', [u.id])
  await db.q('delete from pro_mail_accounts where user_id=$1', [u.id])
}

// a demo mailbox with the mails that arrived, and the Home cards the triage made from them (kind: what the triage said — absent on a
// card made before this change, which the sheet then asks)
async function setup(pageAs, db, area, cards, { viewport, touch = false, brief = null } = {}) {
  const page = await pageAs(area, { viewport, touch })
  const u = page.user
  // (the screen follows the language saved on the server: Korean, whatever an earlier run left)
  expect((await u.put('/me/lang', { lang: 'ko' })).status).toBe(200)
  const main = await db.clearMain(u.id)
  await cleanup(db, u)
  await db.q(`insert into pro_mail_accounts(user_id, provider, address) values ($1,'demo',$2) on conflict (user_id) do update set provider='demo', address=$2`, [u.id, u.email])
  const made = []
  for (const c of cards) {
    const mailId = `demo-mc-${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`
    await db.q('insert into pro_demo_mail(user_id, mail_id, sender, subject, body) values ($1,$2,$3,$4,$5)', [u.id, mailId, c.mail.sender, c.mail.subject, c.mail.body])
    const [a] = await db.q(`insert into pro_actions(user_id, verb, text, prompt, source) values ($1,$2,$3,$4,$5) returning *`,
      [u.id, c.verb, c.mail.text, c.mail.prompt || `${c.mail.text}`, { mail_id: mailId, from: c.mail.sender, subject: c.mail.subject, ...(c.kind ? { kind: c.kind, kind_read: { by: 'triage' } } : {}) }])
    made.push(a)
  }
  if (brief) {
    await db.addMessages(main, [
      { role: 'system', kind: 'divider', content: { text: '오후 브리프' } },
      { role: 'agent', kind: 'text', content: { text: brief, mails: made.map((a) => ({ actionId: a.id, mailId: a.source.mail_id, verb: a.verb, text: a.text, ...(a.source.kind ? { kind: a.source.kind } : {}) })) } },
    ])
  }
  const ran = []
  page.on('request', (r) => { if (/\/api\/actions\/[^/]+\/run$/.test(r.url())) ran.push(r.url()) })
  return { page, u, cards: made, main, ran }
}
const goHome = async (page, phone) => {
  await page.goto('/chat')
  if (phone) await page.locator('.seg button').filter({ hasText: '홈' }).click()
}

test.describe('메일 카드의 일 — 일정 카드는 일정 양식, 답장은 그대로, 그 밖의 카드는 맡기기', () => {
  test('F-MC-01 Home 의 일정 카드(예전 카드)를 누르면 판정 모델이 일정으로 읽고 일정 양식이 열린다 — 답장 쓰기가 아니다, 만들지 않는다', async ({ pageAs, db }) => {
    const { page, u, cards: [a], ran } = await setup(pageAs, db, 'mc-home', [{ verb: 'Add', mail: WEBINAR }])
    await goHome(page)
    const card = homeCard(page, a)
    await expect(card.locator('[data-test="action-verb"]')).toHaveText('추가') // not decided yet: the verb in Korean
    await card.click()
    const sheet = sheetOf(page)
    await expect(sheet.locator('[data-test="mail-original"]')).toContainText('웨비나 사무국 <events@robotics-webinar.example>')
    await expect(sheet.locator('[data-test="ev-reading"]')).toHaveText('일정 정보를 읽는 중…')
    await expect(sheet.locator('[data-test="mail-verb"]')).toHaveText('일정 추가')
    await shot(page, 'f-mc-01a-reading.png')
    await expect(sheet.locator('[data-test="ev-title"]')).toHaveValue('에이전틱 자동화 웨비나')
    await expect(sheet.locator('[data-test="ev-date"]')).toHaveValue(TOMORROW)
    await expect(sheet.locator('[data-test="ev-start"]')).toHaveValue('15:00')
    await expect(sheet.locator('[data-test="ev-link"]')).toHaveValue(EVENT.link)
    await expect(sheet.locator('[data-test="ev-when"]')).toContainText(`${koDay(TOMORROW)} 오후 3:00 – 오후 4:00`)
    await expect(sheet.locator('[data-test="ev-add"]')).toHaveText('캘린더에 추가')
    await expect(sheet.locator('[data-test="ev-add"]')).toBeEnabled()
    await expect(sheet).toContainText('캘린더에 추가를 누르기 전에는 아무것도 만들지 않아요.')
    // the reply is not the sheet: folded under 「답장도 쓰기」, no draft written, no agent
    await expect(sheet.locator('[data-test="mail-reply"]')).toHaveCount(0)
    await expect(sheet.locator('[data-test="mail-body"]')).toHaveCount(0)
    await expect(sheet.locator('[data-test="mail-write"]')).toHaveText('답장도 쓰기')
    await expect(sheet.locator('[data-test="mail-agent"]')).toHaveCount(0)
    // the Home card learned what it is for
    await expect(card.locator('[data-test="action-verb"]')).toHaveText('일정 추가')
    await shot(page, 'f-mc-01b-form.png')
    const [row] = await db.q('select status, source from pro_actions where id=$1', [a.id])
    expect(row.status).toBe('open')
    expect(row.source.kind).toBe('calendar')
    expect(row.source.event).toBeUndefined()
    expect(row.source.event_draft.start).toBe('15:00')
    expect(ran).toEqual([])
    expect(page.errors).toEqual([])
    await cleanup(db, u)
  })

  test('F-MC-02 브리프의 칩은 「일정 추가 · …」, 누르면 같은 일정 양식(Home 에서 연 것과 같은 시트)', async ({ pageAs, db }) => {
    const { page, u, cards: [a] } = await setup(pageAs, db, 'mc-chip', [{ verb: 'Add', kind: 'calendar', mail: WEBINAR }],
      { brief: '내일 오후 3시 에이전틱 자동화 웨비나 초대가 왔어요. 카드를 누르면 일정을 확인하고 캘린더에 넣을 수 있어요.' })
    await page.goto('/chat')
    const chip = page.locator('[data-test="mail-chip"]').filter({ hasText: a.text })
    await expect(chip.locator('[data-test="mail-chip-verb"]')).toHaveText('일정 추가')
    await shot(page, 'f-mc-02a-chip.png')
    // (the kind's question only — the sheet's row of follow-up actions asks the judge its own question once: spec mail-card-actions)
    const kindAsked = () => llm.calls.filter((c) => c.judge && c.sys.includes('무엇을 하는 카드')).length
    const judged = kindAsked()
    await chip.click()
    const sheet = sheetOf(page)
    await expect(sheet.locator('[data-test="mail-event"]')).toBeVisible()
    await expect(sheet.locator('[data-test="ev-start"]')).toHaveValue('15:00')
    await expect(sheet.locator('[data-test="mail-body"]')).toHaveCount(0)
    await expect(sheet.locator('[data-test="mail-home"]')).toBeVisible() // 「Home 카드로」 as from any chip
    await shot(page, 'f-mc-02b-sheet.png')
    expect(kindAsked(), '메일 비서가 정한 카드는 다시 묻지 않는다').toBe(judged)
    expect(page.errors).toEqual([])
    await cleanup(db, u)
  })

  test('F-MC-03 시각을 고치고 「캘린더에 추가」 → 「기록했어요 · <날짜 시간>」(데모 메일함), 카드는 끝나 Home 에서 빠지고 채팅에 남는다', async ({ pageAs, db }) => {
    const { page, u, cards: [a], main, ran } = await setup(pageAs, db, 'mc-add', [{ verb: 'Add', kind: 'calendar', mail: WEBINAR }])
    await goHome(page)
    await homeCard(page, a).click()
    const sheet = sheetOf(page)
    await expect(sheet.locator('[data-test="ev-start"]')).toHaveValue('15:00')
    await sheet.locator('[data-test="ev-start"]').fill('16:30')
    await sheet.locator('[data-test="ev-duration"]').selectOption('90')
    await expect(sheet.locator('[data-test="ev-when"]')).toContainText(`${koDay(TOMORROW)} 오후 4:30 – 오후 6:00`)
    const answer = page.waitForResponse((r) => r.url().endsWith(`/api/actions/${a.id}/event`) && r.request().method() === 'POST')
    await sheet.locator('[data-test="ev-add"]').click()
    expect((await answer).status()).toBe(200)
    const done = sheet.locator('[data-test="ev-done"]')
    await expect(done).toContainText('기록했어요')
    await expect(done.locator('[data-test="ev-done-when"]')).toHaveText(`${koDay(TOMORROW)} 오후 4:30 – 오후 6:00`)
    await expect(done).toContainText('데모 메일함이라 실제 캘린더에는 넣지 않았어요.')
    await expect(sheet.locator('[data-test="ev-add"]')).toHaveCount(0)
    await shot(page, 'f-mc-03-done.png')
    const [row] = await db.q('select status, source from pro_actions where id=$1', [a.id])
    expect(row.status).toBe('done')
    expect([row.source.event.via, row.source.event.date, row.source.event.start, row.source.event.durationMin]).toEqual(['demo', TOMORROW, '16:30', 90])
    await sheet.getByRole('button', { name: '닫기' }).click()
    await expect(homeCard(page, a)).toHaveCount(0)
    const [m] = await db.q(`select content from pro_messages where thread_id=$1 and content ? 'calendar_event'`, [main])
    expect(m.content.text).toBe(`데모 메일함이라 「에이전틱 자동화 웨비나」(${koDay(TOMORROW)} 오후 4:30)을 실제 캘린더에 넣지 않고 기록만 했어요.`)
    expect(ran).toEqual([])
    await cleanup(db, u)
  })

  test('F-MC-04 Google 메일함: 「캘린더에 추가했어요 · …」와 「캘린더에서 보기」 한 번만 만들고, 같은 일정이 이미 있으면 「이미 캘린더에 있어요」', async ({ pageAs, db, lib }) => {
    const page = await pageAs('mc-google')
    const u = page.user
    await db.clearMain(u.id)
    await cleanup(db, u)
    // a Gmail mailbox whose Google connection may write calendar events (this server's Google is the fake above)
    const vault = await lib('lib/vault.js')
    const { config } = await lib('config.js')
    const token = { username: u.email, access_token: 'at-e2e', refresh_token: 'rt-e2e', expires_at: Date.now() + 6 * 3600_000,
      scope: 'openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/gmail.compose', client_id: 'cid-e2e' }
    // (the account's data key is sealed with one checkout's keyring, server/.vault-keyring.json: one another checkout made cannot be
    // opened here — it is made again. It is not removed after the test: the server keeps an opened key for ten minutes.)
    await vault.putItem(u.id, 'oauth', config.google.vaultSite, token, { actor: 'mail' }).catch(async () => {
      for (const t of ['pro_vault_items', 'pro_vault_keys']) await db.q(`delete from ${t} where user_id=$1`, [u.id])
      await vault.putItem(u.id, 'oauth', config.google.vaultSite, token, { actor: 'mail' })
    })
    await db.q(`insert into pro_mail_accounts(user_id, provider, address) values ($1,'gmail',$2) on conflict (user_id) do update set provider='gmail', address=$2`, [u.id, u.email])
    const ids = [`g-mc-${crypto.randomBytes(4).toString('hex')}`, `g-mc-${crypto.randomBytes(4).toString('hex')}`]
    for (const id of ids) google.mails.set(id, rawMail(WEBINAR))
    const made = []
    for (const id of ids) {
      const [a] = await db.q(`insert into pro_actions(user_id, verb, text, prompt, source) values ($1,'Add',$2,$3,$4) returning *`,
        [u.id, WEBINAR.text, WEBINAR.text, { mail_id: id, from: WEBINAR.sender, subject: WEBINAR.subject, kind: 'calendar' }])
      made.push(a)
    }
    const before = google.inserts.length
    await page.goto('/chat')
    await homeCard(page, made[0]).click()
    const sheet = sheetOf(page)
    await expect(sheet.locator('[data-test="mail-text"]')).toContainText('내일 오후 3시에 에이전틱 자동화 웨비나가 열립니다')
    await expect(sheet.locator('[data-test="ev-start"]')).toHaveValue('15:00')
    expect(google.inserts.length, '열기만 해서는 만들지 않는다').toBe(before)
    await sheet.locator('[data-test="ev-add"]').click()
    const done = sheet.locator('[data-test="ev-done"]')
    await expect(done).toContainText('캘린더에 추가했어요')
    await expect(done.locator('[data-test="ev-done-when"]')).toHaveText(`${koDay(TOMORROW)} 오후 3:00 – 오후 4:00`)
    await expect(done.locator('[data-test="ev-open"]')).toHaveText('캘린더에서 보기')
    await expect(done.locator('[data-test="ev-open"]')).toHaveAttribute('href', /\/calendar\/event\?eid=/)
    await shot(page, 'f-mc-04a-added.png')
    expect(google.inserts.length).toBe(before + 1)
    expect(google.inserts.at(-1).summary).toBe('에이전틱 자동화 웨비나')
    expect(google.inserts.at(-1).start.timeZone).toBe('Asia/Seoul')
    await sheet.getByRole('button', { name: '닫기' }).click()
    // the same webinar from a second mail: already there — nothing made
    await homeCard(page, made[1]).click()
    await expect(sheet.locator('[data-test="ev-start"]')).toHaveValue('15:00')
    await sheet.locator('[data-test="ev-add"]').click()
    await expect(sheet.locator('[data-test="ev-done"]')).toContainText('이미 캘린더에 있어요')
    await expect(sheet.locator('[data-test="ev-open"]')).toBeVisible()
    await shot(page, 'f-mc-04b-already.png')
    expect(google.inserts.length).toBe(before + 1)
    const rows = await db.q('select status, source from pro_actions where id = any($1::uuid[]) order by created_at', [made.map((a) => a.id)])
    expect(rows.map((r) => [r.status, r.source.event.via, r.source.event.existing])).toEqual([['done', 'google', false], ['done', 'google', true]])
    expect(page.errors).toEqual([])
    await cleanup(db, u)
    await db.q('delete from pro_vault_items where user_id=$1', [u.id])
  })

  test('F-MC-05 답장 카드는 그대로: 머리는 「답장」, 초안이 바로 열리고 일정 양식 · 「답장도 쓰기」 · 맡기기는 없다', async ({ pageAs, db }) => {
    const reply = { ...WEBINAR, text: '웨비나 사무국에 참석 여부를 회신' }
    const { page, u, cards: [a], ran } = await setup(pageAs, db, 'mc-reply', [{ verb: 'Reply', mail: reply }])
    await goHome(page)
    await expect(homeCard(page, a).locator('[data-test="action-verb"]')).toHaveText('답장')
    await homeCard(page, a).click()
    const sheet = sheetOf(page)
    await expect(sheet.locator('[data-test="mail-verb"]')).toHaveText('답장')
    await expect(sheet.locator('[data-test="mail-body"]')).toHaveValue(DRAFT.body)
    await expect(sheet.locator('[data-test="mail-send"]')).toBeEnabled()
    await expect(sheet.locator('[data-test="mail-event"]')).toHaveCount(0)
    await expect(sheet.locator('[data-test="mail-write"]')).toHaveCount(0)
    await expect(sheet.locator('[data-test="mail-agent"]')).toHaveCount(0)
    await expect(sheet).toContainText('보내기를 누르기 전에는 아무것도 보내지 않아요.')
    await shot(page, 'f-mc-05-reply.png')
    const [row] = await db.q('select status, source from pro_actions where id=$1', [a.id])
    expect([row.status, row.source.sent, row.source.kind]).toEqual(['open', undefined, undefined]) // a Reply card is not asked
    expect(ran).toEqual([])
    await cleanup(db, u)
  })

  test('F-MC-06 그 밖의 카드(Pay): 「에이전트에게 맡기기」가 큰 단추(할 일과 함께), 답장은 「답장도 쓰기」 아래 — 누르면 초안', async ({ pageAs, db }) => {
    const { page, u, cards: [a], ran } = await setup(pageAs, db, 'mc-task', [{ verb: 'Pay', mail: BILL }])
    await goHome(page)
    await homeCard(page, a).click()
    const sheet = sheetOf(page)
    const agent = sheet.locator('[data-test="mail-agent"]')
    await expect(agent).toBeVisible()
    await expect(agent).toContainText('에이전트에게 맡기기')
    await expect(agent).toContainText(BILL.prompt)
    await expect(sheet.locator('[data-test="mail-verb"]')).toHaveText('납부')
    await expect(sheet.locator('[data-test="mail-event"]')).toHaveCount(0)
    await expect(sheet.locator('[data-test="mail-body"]')).toHaveCount(0)
    const write = sheet.locator('[data-test="mail-write"]')
    await expect(write).toHaveText('답장도 쓰기')
    // the agent button is the main one: dark, above the folded reply
    const [agentBox, writeBox] = [await agent.boundingBox(), await write.boundingBox()]
    expect(agentBox.y).toBeLessThan(writeBox.y)
    expect(await agent.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(29, 29, 31)')
    await shot(page, 'f-mc-06a-task.png')
    await write.click()
    await expect(sheet.locator('[data-test="mail-body"]')).toHaveValue(DRAFT.body)
    await expect(write).toHaveCount(0)
    await shot(page, 'f-mc-06b-reply-open.png')
    const [row] = await db.q('select status, source from pro_actions where id=$1', [a.id])
    expect([row.status, row.source.kind, row.source.sent]).toEqual(['open', 'task', undefined])
    expect(ran, '맡기기는 눌러야 한다').toEqual([])
    await cleanup(db, u)
  })

  test('F-MC-07 단추 말은 사람의 언어로: Home · 칩 · 받은 편지함이 「일정 추가」 · 「납부」 · 「답장」 · 「검토」, 영어 화면은 Add to calendar · Pay · Reply', async ({ pageAs, db }) => {
    const review = { ...BILL, text: '청구서 내역 확인', subject: '11월 청구서 상세' }
    const { page, u, cards } = await setup(pageAs, db, 'mc-labels', [
      { verb: 'Add', kind: 'calendar', mail: WEBINAR }, { verb: 'Pay', kind: 'task', mail: BILL }, { verb: 'Reply', mail: { ...WEBINAR, text: '참석 여부 회신' } }, { verb: 'Review', kind: 'task', mail: review },
    ], { brief: '메일 네 통을 살펴봤어요.' })
    const want = ['일정 추가', '납부', '답장', '검토']
    await page.goto('/chat')
    for (const [i, a] of cards.entries()) {
      await expect(homeCard(page, a).locator('[data-test="action-verb"]')).toHaveText(want[i])
      await expect(page.locator('[data-test="mail-chip"]').filter({ hasText: a.text }).locator('[data-test="mail-chip-verb"]')).toHaveText(want[i])
    }
    await shot(page, 'f-mc-07a-labels.png')
    // 팀 메시지 › 받은 편지함 › 메일
    await page.locator('button.msg-btn').click()
    await page.locator('.ms').waitFor()
    await page.locator('.ms .tabs button').filter({ hasText: '받은 편지함' }).click()
    await page.locator('[data-test="inbox-mail"]').click()
    const inbox = page.locator('[data-test="inbox-mail-card"]')
    await expect(inbox).toHaveCount(4)
    for (const [i, a] of cards.entries()) await expect(inbox.filter({ hasText: a.text }).locator('.vb')).toHaveText(want[i])
    await shot(page, 'f-mc-07b-inbox.png')
    // the English screen: the stored English verb, the calendar card's own words
    expect((await u.put('/me/lang', { lang: 'en' })).status).toBe(200)
    await page.evaluate(() => localStorage.setItem('pgl-lang', 'en'))
    await page.goto('/chat?lang=en')
    const en = ['Add to calendar', 'Pay', 'Reply', 'Review']
    for (const [i, a] of cards.entries()) await expect(homeCard(page, a).locator('[data-test="action-verb"]')).toHaveText(en[i])
    await homeCard(page, cards[0]).click()
    await expect(sheetOf(page).locator('[data-test="ev-add"]')).toHaveText('Add to calendar')
    await expect(sheetOf(page).locator('[data-test="mail-write"]')).toHaveText('Write a reply too')
    await shot(page, 'f-mc-07c-english.png')
    expect((await u.put('/me/lang', { lang: 'ko' })).status).toBe(200)
    await cleanup(db, u)
  })

  test('F-MC-08 휴대폰(390px): 브리프 칩 · 일정 양식 · 맡기기 카드가 화면 너비 안, 일정 양식에서 바로 추가', async ({ pageAs, db }) => {
    const { page, u, cards: [cal, pay] } = await setup(pageAs, db, 'mc-phone', [{ verb: 'Add', kind: 'calendar', mail: WEBINAR }, { verb: 'Pay', mail: BILL }],
      { viewport: PHONE, touch: true, brief: '내일 오후 3시 웨비나 초대와 서버 이용료 청구서가 왔어요.' })
    const wide = () => page.evaluate(() => document.scrollingElement.scrollWidth)
    await page.goto('/chat')
    await page.locator('.seg button').filter({ hasText: '채팅' }).click()
    const chip = page.locator('[data-test="mail-chip"]').filter({ hasText: cal.text })
    await expect(chip.locator('[data-test="mail-chip-verb"]')).toHaveText('일정 추가')
    expect(await wide()).toBeLessThanOrEqual(PHONE.width)
    await shot(page, 'f-mc-08a-phone-chip.png')
    await chip.click()
    const sheet = sheetOf(page)
    await expect(sheet.locator('[data-test="ev-start"]')).toHaveValue('15:00')
    const box = await sheet.boundingBox()
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(PHONE.width + 0.5)
    for (const t of ['ev-title', 'ev-date', 'ev-start', 'ev-duration', 'ev-add']) {
      const b = await sheet.locator(`[data-test="${t}"]`).boundingBox()
      expect(b.x + b.width, t).toBeLessThanOrEqual(PHONE.width)
    }
    expect(await wide()).toBeLessThanOrEqual(PHONE.width)
    await shot(page, 'f-mc-08b-phone-form.png')
    await sheet.locator('[data-test="ev-add"]').scrollIntoViewIfNeeded()
    await sheet.locator('[data-test="ev-add"]').click()
    await expect(sheet.locator('[data-test="ev-done"]')).toContainText('기록했어요')
    await shot(page, 'f-mc-08c-phone-done.png')
    await sheet.getByRole('button', { name: '닫기' }).click()
    await page.locator('[data-test="mail-chip"]').filter({ hasText: pay.text }).click()
    await expect(sheet.locator('[data-test="mail-agent"]')).toBeVisible()
    await expect(sheet.locator('[data-test="mail-write"]')).toBeVisible()
    expect(await wide()).toBeLessThanOrEqual(PHONE.width)
    await shot(page, 'f-mc-08d-phone-task.png')
    await cleanup(db, u)
  })
})
