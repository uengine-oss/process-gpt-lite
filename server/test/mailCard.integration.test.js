// 일정 카드를 누르면 일정 양식, 「캘린더에 추가」를 눌러야 Google 캘린더에 (lib/mailCard.js, 스펙 openspec/specs/mail-card-actions).
// 2026-11-24 운영: 브리프 칩 「Add · 내일 오후 3시 UiPath 웨비나를 캘린더에 추가합니다」를 누르자 답장 쓰기가 열렸다.
// 실제 DB, 메일 카드 경로는 실제 Express 라우트(routes/mailReply.js)에 대고 부르고(로그인만 헤더 대역), 모델 · Gmail · Google 캘린더는
// 가짜 fetch. 가짜 캘린더는 넣은 일정을 기억하고, 시간 창으로 찾으면 돌려준다.
//   - 카드의 일: 들어올 때 메일 비서가 정하고(kind), 예전 카드는 시트를 처음 열 때 판정 모델이 한 번 — 카드에 남는다
//   - 여는 것만으로는 아무것도 만들지 않는다(종류 · 일정 읽기 · 원문) · 누르면 한 번 · 두 번째 누름은 「이미 있어요」
//   - 같은 일정이 캘린더에 있으면 새로 만들지 않는다 · 데모 메일함은 기록만 · 권한 없음 403 · 남의 카드 403 · Google 오류는 카드가 남음
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// a throwaway vault keyring; no graph engine; a calendar address of this test's own (answered by the fake fetch below)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgpt-mailcard-test-'))
const kek = crypto.randomBytes(32)
const kid = crypto.createHash('sha256').update(kek).digest('hex').slice(0, 12)
fs.writeFileSync(path.join(dir, 'keyring.json'), JSON.stringify({ current: kid, keys: [{ id: kid, key: kek.toString('base64') }] }), { mode: 0o600 })
process.env.PRO_VAULT_KEYRING = path.join(dir, 'keyring.json')
delete process.env.PRO_VAULT_KEK
delete process.env.PRO_TENANT_FROM_HEADER
process.env.PRO_ONTOLOGY_BOLT_URL = ''
process.env.PRO_LLM_BASE_URL = 'http://127.0.0.1:59969/v1'
process.env.PRO_GOOGLE_CALENDAR_URL = 'https://calendar.fake-google.example/calendar/v3'
process.env.PRO_GOOGLE_GMAIL_URL = 'https://gmail.fake-google.example/gmail/v1'

const { config } = await import('../config.js')
const { q, pool } = await import('../lib/supa.js')
const vault = await import('../lib/vault.js')
const R = await import('../lib/mailReply.js')
const { pollUser } = await import('../lib/mail.js')
const express = (await import('express')).default
const { mailReplyRoutes } = await import('../routes/mailReply.js')

const users = []
after(async () => {
  for (const u of users) {
    for (const t of ['pro_actions', 'pro_mail_accounts', 'pro_mail_seen', 'pro_demo_mail', 'pro_vault_items', 'pro_vault_keys', 'pro_vault_audit', 'pro_profile']) await q(`delete from ${t} where user_id=$1`, [u.id]).catch(() => {})
    await q('delete from pro_mail_archive where owner_id=$1', [u.id]).catch(() => {})
    await q('delete from pro_messages where thread_id in (select id from pro_threads where user_id=$1)', [u.id])
    await q('delete from pro_threads where user_id=$1', [u.id])
  }
  server?.close()
  await pool.end()
  fs.rmSync(dir, { recursive: true, force: true })
})

// ---------- the fake model, Gmail and Google Calendar ----------
const MAIL_DATE = '2026-11-24T07:20:00.000Z' // 16:20 in Seoul
const ORIGINAL = await R.buildReply({
  from: { name: '웨비나 사무국', address: 'events@robotics-webinar.example' }, to: [{ name: '홍길동', address: 'me@lite.example' }],
  subject: '[초대] 에이전틱 자동화 웨비나 안내', body: '홍길동 님, 내일 오후 3시에 에이전틱 자동화 웨비나가 열립니다.\n참여 링크: https://webinar.robotics-webinar.example/join/8812\n\n웨비나 사무국 드림',
}).then((raw) => raw.toString().replace(/^Date: .*$/m, `Date: ${new Date(MAIL_DATE).toUTCString()}`))
const EVENT = { title: '에이전틱 자동화 웨비나', date: '2026-11-25', start: '15:00', durationMin: 60, allDay: false, timezone: 'Asia/Seoul', location: '',
  link: 'https://webinar.robotics-webinar.example/join/8812', description: '웨비나 사무국이 보낸 초대', basis: '내일 오후 3시' }
const llm = { judge: { letter: 'A', p: 0.93 }, event: EVENT, triage: { actions: [], brief: '' }, calls: [] }
const cal = { events: [], inserts: [], lists: [], fail: false }
const gmailCalls = []
const startOf = (e) => new Date(e.start.dateTime || `${e.start.date}T00:00:00+09:00`).getTime()
const endOf = (e) => new Date(e.end.dateTime || `${e.end.date}T00:00:00+09:00`).getTime()
const real = globalThis.fetch
globalThis.fetch = async (url, init = {}) => {
  const u = String(url)
  if (u === `${config.llm.baseUrl}/chat/completions`) {
    const body = JSON.parse(init.body || '{}')
    const sys = String(body.messages?.[0]?.content || '')
    llm.calls.push({ judge: !!body.logprobs, sys, user: String(body.messages?.at(-1)?.content || '') })
    if (body.max_tokens === 1 && body.logprobs) {
      const { letter, p } = llm.judge
      const other = letter === 'A' ? 'C' : 'A'
      return Response.json({ choices: [{ message: { content: letter }, logprobs: { content: [{ token: letter, top_logprobs: [{ token: letter, logprob: Math.log(p) }, { token: other, logprob: Math.log(1 - p) }] }] } }] })
    }
    // (the judge asked in JSON: after an outage the first-token reading rests for a while — lib/decide.js)
    const answer = sys.startsWith('메일 카드가 캘린더에 넣으려는 일정') ? llm.event : sys.startsWith("You read a user's newest emails") ? llm.triage
      : sys.includes('JSON {"choice"') ? { choice: llm.judge.letter, confidence: llm.judge.p } : {}
    return Response.json({ choices: [{ message: { content: JSON.stringify(answer) }, finish_reason: 'stop' }] })
  }
  if (u.startsWith(config.google.gmailUrl)) {
    gmailCalls.push(u)
    if (u.includes('/messages/g-1?format=raw')) return Response.json({ id: 'g-1', threadId: 'thr-1', raw: Buffer.from(ORIGINAL).toString('base64url') })
    if (u.includes('/messages?')) return Response.json({ messages: [] })
    return Response.json({ error: { message: 'not found' } }, { status: 404 })
  }
  if (u.startsWith(config.google.calendarUrl)) {
    const method = init.method || 'GET'
    assert.match(String(init.headers?.Authorization), /^Bearer at-/, '그 사람의 토큰으로')
    if (method === 'GET') {
      const p = new URL(u).searchParams
      cal.lists.push(Object.fromEntries(p))
      const min = new Date(p.get('timeMin')).getTime(), max = new Date(p.get('timeMax')).getTime()
      return Response.json({ items: cal.events.filter((e) => endOf(e) > min && startOf(e) < max) })
    }
    if (cal.fail) return Response.json({ error: { message: 'Backend Error' } }, { status: 503 })
    const body = JSON.parse(init.body)
    cal.inserts.push(body)
    const id = `ev${cal.events.length + 1}`
    const ev = { id, ...body, htmlLink: `https://calendar.fake-google.example/event?eid=${id}` }
    cal.events.push(ev)
    return Response.json(ev)
  }
  return real(url, init)
}

// ---------- the routes, signed in by a header ----------
let server = null, base = null
async function call(u, method, p, body) {
  if (!base) {
    const app = express()
    app.use(express.json())
    app.use('/api', mailReplyRoutes((req, res, next) => {
      const me = users.find((x) => x.id === req.headers['x-test-user'])
      if (!me) return res.status(401).json({ error: 'unauthorized' })
      req.user = { id: me.id, email: me.email, name: me.name }; next()
    }))
    server = await new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)) })
    base = `http://127.0.0.1:${server.address().port}/api`
  }
  const r = await real(`${base}${p}`, { method, headers: { 'x-test-user': u.id, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
  return { status: r.status, body: await r.json().catch(() => null) }
}

const CAL_SCOPE = 'openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/gmail.compose'
async function person({ provider = 'gmail', scope = CAL_SCOPE } = {}) {
  const u = { id: crypto.randomUUID(), email: 'me@lite.example', name: '홍길동' }
  users.push(u)
  await q('insert into pro_profile(user_id, email, name) values ($1,$2,$3)', [u.id, u.email, u.name])
  await q(`insert into pro_mail_accounts(user_id, provider, address) values ($1,$2,$3)`, [u.id, provider, u.email])
  if (provider === 'gmail') await vault.putItem(u.id, 'oauth', config.google.vaultSite, { username: u.email, access_token: `at-${u.id.slice(0, 6)}`, refresh_token: 'rt', expires_at: Date.now() + 3600_000, scope, client_id: 'cid' }, { actor: 'mail' })
  return u
}
// the card the triage made from the webinar mail (before this change: no kind)
async function webinarCard(u, { mailId = 'g-1', kind } = {}) {
  if (mailId.startsWith('demo-')) await q('insert into pro_demo_mail(user_id, mail_id, sender, subject, body) values ($1,$2,$3,$4,$5)', [u.id, mailId, '웨비나 사무국 <events@robotics-webinar.example>', '[초대] 에이전틱 자동화 웨비나 안내', '홍길동 님, 내일 오후 3시에 웨비나가 열립니다.'])
  const [a] = await q(`insert into pro_actions(user_id, verb, text, prompt, source) values ($1,'Add',$2,$3,$4) returning *`,
    [u.id, '내일 오후 3시 에이전틱 자동화 웨비나를 캘린더에 추가합니다.', '내일 오후 3시 웨비나 일정을 캘린더에 추가해 주세요.',
      { mail_id: mailId, from: '웨비나 사무국 <events@robotics-webinar.example>', subject: '[초대] 에이전틱 자동화 웨비나 안내', ...(kind ? { kind } : {}) }])
  return a
}
const card = async (id) => (await q('select * from pro_actions where id=$1', [id]))[0]
const chat = async (userId) => q(`select m.content from pro_messages m join pro_threads t on t.id=m.thread_id where t.user_id=$1 and m.content ? 'calendar_event' order by m.created_at`, [userId])
const FORM = { title: '에이전틱 자동화 웨비나', date: '2026-11-25', start: '15:00', durationMin: 60, allDay: false, location: '', link: EVENT.link, description: '웨비나 사무국이 보낸 초대', tz: 'Asia/Seoul' }

test('예전 카드: 시트를 처음 열 때 판정 모델이 「일정」으로 읽고 카드에 남긴다 — 다시 열면 묻지 않는다', async () => {
  const u = await person()
  const a = await webinarCard(u)
  const before = llm.calls.length
  const r = await call(u, 'GET', `/actions/${a.id}/kind`)
  assert.equal(r.status, 200)
  assert.deepEqual([r.body.kind, r.body.by, r.body.p], ['calendar', 'logprob', 0.93])
  const asked = llm.calls.slice(before)
  assert.equal(asked.length, 1)
  assert.match(asked[0].user, /내일 오후 3시 에이전틱 자동화 웨비나를 캘린더에 추가합니다/)
  assert.match(asked[0].user, /A\) 일정[^\n]*\nB\) 답장[^\n]*\nC\) 그 밖의 일/)
  const kept = (await card(a.id)).source
  assert.equal(kept.kind, 'calendar')
  assert.equal(kept.kind_read.by, 'logprob')
  const again = await call(u, 'GET', `/actions/${a.id}/kind`)
  assert.equal(again.body.kind, 'calendar')
  assert.equal(llm.calls.length, before + 1, '두 번째는 모델을 부르지 않는다')
  // a Reply card is a reply without asking
  const [reply] = await q(`insert into pro_actions(user_id, verb, text, source) values ($1,'Reply','회신',$2) returning id`, [u.id, { mail_id: 'g-1' }])
  assert.deepEqual((await call(u, 'GET', `/actions/${reply.id}/kind`)).body, { kind: 'reply', by: 'card', p: null })
  assert.equal(llm.calls.length, before + 1)
})

test('판정 모델이 꺼져 있으면 「그 밖의 일」로 보여 주되 카드에 남기지 않는다(다음에 다시 묻는다)', async () => {
  const u = await person()
  const a = await webinarCard(u)
  const ok = globalThis.fetch
  globalThis.fetch = async (url, init) => (String(url).startsWith(config.llm.baseUrl) ? Response.json({ error: { message: 'down' } }, { status: 503 }) : ok(url, init))
  try {
    const r = await call(u, 'GET', `/actions/${a.id}/kind`)
    assert.deepEqual([r.status, r.body.kind, r.body.by], [200, 'task', 'fallback'])
  } finally { globalThis.fetch = ok }
  assert.equal((await card(a.id)).source.kind, undefined)
})

test('여는 것만으로는 아무것도 만들지 않는다: 원문 · 종류 · 일정 읽기 뒤에도 캘린더 요청 0, 카드는 열린 채 · 읽은 일정은 카드에', async () => {
  const u = await person()
  const a = await webinarCard(u, { kind: 'calendar' })
  const [ins, lists] = [cal.inserts.length, cal.lists.length]
  const before = llm.calls.length
  assert.equal((await call(u, 'GET', `/actions/${a.id}/mail`)).status, 200)
  assert.equal((await call(u, 'GET', `/actions/${a.id}/kind`)).body.kind, 'calendar')
  const ev = await call(u, 'GET', `/actions/${a.id}/event?tz=Asia/Seoul`)
  assert.equal(ev.status, 200)
  assert.equal(ev.body.mode, 'google')
  assert.deepEqual([ev.body.draft.title, ev.body.draft.date, ev.body.draft.start, ev.body.draft.tz, ev.body.draft.read], ['에이전틱 자동화 웨비나', '2026-11-25', '15:00', 'Asia/Seoul', 'model'])
  // the model read the mail as it arrived, with when it arrived in the person's zone
  const read = llm.calls.slice(before).find((c) => c.sys.startsWith('메일 카드가 캘린더에 넣으려는 일정'))
  const input = JSON.parse(read.user)
  assert.equal(input.mailReceived, '2026-11-24 (Tue) 16:20')
  assert.match(input.mail.text, /내일 오후 3시에 에이전틱 자동화 웨비나가 열립니다/)
  assert.equal(input.mail.from, '웨비나 사무국 <events@robotics-webinar.example>')
  assert.deepEqual([cal.inserts.length, cal.lists.length], [ins, lists], '캘린더에는 닿지 않았다')
  const row = await card(a.id)
  assert.equal(row.status, 'open')
  assert.equal(row.source.event, undefined)
  assert.equal(row.source.event_draft.start, '15:00')
  // opened again: read once
  const n = llm.calls.length
  assert.equal((await call(u, 'GET', `/actions/${a.id}/event?tz=Asia/Seoul`)).body.draft.start, '15:00')
  assert.equal(llm.calls.length, n)
})

test('「캘린더에 추가」: 한 번 만들고(서울 시각 · 링크 · 메일), 카드는 끝 · 채팅에 남김 — 두 번째 누름은 「이미 있어요」, 만들지 않는다', async () => {
  const u = await person()
  const a = await webinarCard(u, { kind: 'calendar' })
  const ins = cal.inserts.length
  const r = await call(u, 'POST', `/actions/${a.id}/event`, { ...FORM, start: '16:00' }) // the person moved it an hour
  assert.equal(r.status, 200)
  assert.equal(r.body.event.via, 'google')
  assert.equal(r.body.event.existing, false)
  assert.match(r.body.event.htmlLink, /^https:\/\/calendar\.fake-google\.example\/event\?eid=/)
  assert.equal(r.body.event.when, '11월 25일 (수) 오후 4:00')
  assert.equal(cal.inserts.length, ins + 1)
  const made = cal.inserts.at(-1)
  assert.equal(made.summary, '에이전틱 자동화 웨비나')
  assert.deepEqual(made.start, { dateTime: '2026-11-25T07:00:00.000Z', timeZone: 'Asia/Seoul' })
  assert.deepEqual(made.end, { dateTime: '2026-11-25T08:00:00.000Z', timeZone: 'Asia/Seoul' })
  assert.equal(made.location, EVENT.link)
  assert.match(made.description, /웨비나 사무국이 보낸 초대/)
  assert.match(made.description, /메일: \[초대\] 에이전틱 자동화 웨비나 안내/)
  // it looked for the same event first, around that start
  assert.deepEqual([cal.lists.at(-1).timeMin, cal.lists.at(-1).timeMax], ['2026-11-25T06:59:00.000Z', '2026-11-25T07:01:00.000Z'])
  const row = await card(a.id)
  assert.equal(row.status, 'done')
  assert.equal(row.source.event.id, made.id ?? row.source.event.id)
  assert.equal(row.source.adding, undefined)
  const [m] = await chat(u.id)
  assert.equal(m.content.text, '캘린더에 「에이전틱 자동화 웨비나」을 넣었어요 · 11월 25일 (수) 오후 4:00')
  assert.equal(m.content.mail.actionId, a.id)
  // pressed again (another screen): it is there — nothing made
  const again = await call(u, 'POST', `/actions/${a.id}/event`, FORM)
  assert.deepEqual([again.status, again.body.already, again.body.event.htmlLink], [200, true, r.body.event.htmlLink])
  assert.equal(cal.inserts.length, ins + 1, '한 번만 만들었다')
  // the sheet opened again shows what was made
  assert.equal((await call(u, 'GET', `/actions/${a.id}/event`)).body.event.htmlLink, r.body.event.htmlLink)
})

test('두 번 누름이 동시에 와도 한 번만 만든다(다른 하나는 409)', async () => {
  const u = await person()
  const a = await webinarCard(u, { kind: 'calendar' })
  const ins = cal.inserts.length
  const rs = await Promise.all([call(u, 'POST', `/actions/${a.id}/event`, { ...FORM, start: '10:00' }), call(u, 'POST', `/actions/${a.id}/event`, { ...FORM, start: '10:00' })])
  assert.equal(rs.filter((r) => r.status === 200 && !r.body.already).length, 1, '하나만 만든다')
  // the other: refused while the first is adding (409), or — if it came after — told it is there
  const other = rs.find((r) => !(r.status === 200 && !r.body.already))
  assert.ok(other.status === 409 || other.body.already === true, JSON.stringify(other))
  assert.equal(cal.inserts.length, ins + 1)
})

test('같은 일정이 캘린더에 이미 있으면 만들지 않고 「이미 캘린더에 있어요」와 그 일정', async () => {
  const u = await person()
  const a = await webinarCard(u, { kind: 'calendar' })
  cal.events.push({ id: 'pre-1', summary: '에이전틱 자동화 웨비나', start: { dateTime: '2026-11-25T15:00:00+09:00' }, end: { dateTime: '2026-11-25T16:00:00+09:00' }, htmlLink: 'https://calendar.fake-google.example/event?eid=pre-1' })
  const ins = cal.inserts.length
  const r = await call(u, 'POST', `/actions/${a.id}/event`, FORM)
  assert.equal(r.status, 200)
  assert.deepEqual([r.body.event.existing, r.body.event.htmlLink], [true, 'https://calendar.fake-google.example/event?eid=pre-1'])
  assert.equal(cal.inserts.length, ins, '새로 만들지 않았다')
  assert.equal((await card(a.id)).status, 'done')
  assert.equal((await chat(u.id)).at(-1).content.text, '「에이전틱 자동화 웨비나」은 이미 캘린더에 있어요 · 11월 25일 (수) 오후 3:00')
})

test('데모 메일함: Google 에 닿지 않고 기록만 하고 그렇다고 말한다', async () => {
  const u = await person({ provider: 'demo' })
  const a = await webinarCard(u, { mailId: `demo-mc-${crypto.randomBytes(3).toString('hex')}` })
  const [ins, lists] = [cal.inserts.length, cal.lists.length]
  assert.equal((await call(u, 'GET', `/actions/${a.id}/kind`)).body.kind, 'calendar')
  const ev = await call(u, 'GET', `/actions/${a.id}/event`)
  assert.equal(ev.body.mode, 'demo')
  const r = await call(u, 'POST', `/actions/${a.id}/event`, FORM)
  assert.deepEqual([r.status, r.body.event.via, r.body.event.htmlLink], [200, 'demo', null])
  assert.deepEqual([cal.inserts.length, cal.lists.length], [ins, lists])
  assert.equal((await card(a.id)).status, 'done')
  assert.equal((await chat(u.id)).at(-1).content.text, '데모 메일함이라 「에이전틱 자동화 웨비나」(11월 25일 (수) 오후 3:00)을 실제 캘린더에 넣지 않고 기록만 했어요.')
})

test('남의 카드는 403 — 읽지도 만들지도 않는다', async () => {
  const owner = await person()
  const a = await webinarCard(owner, { kind: 'calendar' })
  const other = await person()
  const ins = cal.inserts.length
  for (const [m, p, b] of [['GET', `/actions/${a.id}/kind`], ['GET', `/actions/${a.id}/event`], ['POST', `/actions/${a.id}/event`, FORM]]) {
    const r = await call(other, m, p, b)
    assert.equal(r.status, 403, `${m} ${p}`)
    assert.equal(r.body.code, 'not_yours')
  }
  assert.equal(cal.inserts.length, ins)
  const row = await card(a.id)
  assert.deepEqual([row.status, row.source.event, row.source.event_draft], ['open', undefined, undefined])
  assert.equal((await call(other, 'GET', `/actions/${crypto.randomUUID()}/kind`)).status, 404)
})

test('캘린더 권한이 없는 Google 연결은 만들지 않고 다시 연결하라고 한다(403), 시각 · 날짜가 빠진 양식은 400', async () => {
  const u = await person({ scope: 'openid email https://www.googleapis.com/auth/gmail.readonly' })
  const a = await webinarCard(u, { kind: 'calendar' })
  assert.equal((await call(u, 'GET', `/actions/${a.id}/event`)).body.mode, 'scope')
  const ins = cal.inserts.length
  const r = await call(u, 'POST', `/actions/${a.id}/event`, FORM)
  assert.deepEqual([r.status, r.body.code], [403, 'calendar_scope'])
  assert.match(r.body.error, /설정에서 Google을 다시 연결해 주세요/)
  assert.equal(cal.inserts.length, ins)
  assert.equal((await card(a.id)).source.adding, undefined, '잡아 둔 카드가 남지 않는다')
  assert.deepEqual([(await call(u, 'POST', `/actions/${a.id}/event`, { ...FORM, start: '' })).body.code, (await call(u, 'POST', `/actions/${a.id}/event`, { ...FORM, date: '2026-13-01' })).body.code], ['event_start', 'event_date'])
  // no Google at all (an IMAP mailbox without a Google connection)
  const imap = await person({ provider: 'imap' })
  const b = await webinarCard(imap, { kind: 'calendar' })
  const n = await call(imap, 'POST', `/actions/${b.id}/event`, FORM)
  assert.deepEqual([n.status, n.body.code], [403, 'calendar_none'])
})

test('Google 이 거절하면(503) 카드는 열린 채 남고 다시 누를 수 있다 · 종일 일정은 날짜로(끝은 다음 날)', async () => {
  const u = await person()
  const a = await webinarCard(u, { kind: 'calendar' })
  cal.fail = true
  try {
    const r = await call(u, 'POST', `/actions/${a.id}/event`, { ...FORM, title: '분기 보고서 마감', allDay: true, start: null })
    assert.deepEqual([r.status, r.body.code], [502, 'calendar_error'])
  } finally { cal.fail = false }
  const row = await card(a.id)
  assert.deepEqual([row.status, row.source.adding, row.source.event], ['open', undefined, undefined])
  const ok = await call(u, 'POST', `/actions/${a.id}/event`, { ...FORM, title: '분기 보고서 마감', date: '2026-11-30', allDay: true, start: null })
  assert.equal(ok.status, 200)
  assert.deepEqual([cal.inserts.at(-1).start, cal.inserts.at(-1).end], [{ date: '2026-11-30' }, { date: '2026-12-01' }])
  assert.equal(ok.body.event.when, '11월 30일 (월) 종일')
})

test('들어올 때 메일 비서가 카드의 일을 정한다: 일정 카드는 kind=calendar, 브리프 칩도 그 종류를 안다 · 일정 카드는 답장 카드가 아니다', async () => {
  const u = await person({ provider: 'demo' })
  const mailId = `demo-mc-triage-${crypto.randomBytes(3).toString('hex')}`
  await q('insert into pro_demo_mail(user_id, mail_id, sender, subject, body) values ($1,$2,$3,$4,$5)', [u.id, mailId, '웨비나 사무국 <events@robotics-webinar.example>', '[초대] 에이전틱 자동화 웨비나 안내', '내일 오후 3시에 웨비나가 열립니다.'])
  llm.triage = { actions: [{ mail_id: mailId, verb: 'Add', kind: 'calendar', text: '내일 오후 3시 에이전틱 자동화 웨비나를 캘린더에 추가합니다.', icon_domain: '', due: null, prompt: '캘린더에 추가' }], brief: '내일 오후 3시 웨비나 초대가 왔어요.' }
  try { await pollUser(u.id) } finally { llm.triage = { actions: [], brief: '' } }
  const triageCall = llm.calls.findLast((c) => c.sys.startsWith("You read a user's newest emails"))
  assert.match(triageCall.sys, /"kind"/)
  assert.match(triageCall.sys, /not that you will do\s+it/, '브리프는 할 일을 대신 하겠다고 말하지 않는다')
  const [a] = await q(`select * from pro_actions where user_id=$1 and source->>'mail_id'=$2`, [u.id, mailId])
  assert.equal(a.source.kind, 'calendar')
  assert.equal(a.source.kind_read.by, 'triage')
  const [brief] = await q(`select m.content from pro_messages m join pro_threads t on t.id=m.thread_id where t.user_id=$1 and m.content ? 'mails'`, [u.id])
  assert.deepEqual(brief.content.mails, [{ actionId: a.id, mailId, verb: 'Add', kind: 'calendar', text: a.text }])
  assert.equal(R.isReplyCard(a), false)
})
