// 메일 카드가 하는 일 · 일정 카드의 일정 (lib/mailCard.js · lib/calendarEvent.js, 스펙 openspec/specs/mail-card-actions). 2026-11-24 운영:
// 브리프의 칩 「Add · 내일 오후 3시 UiPath 웨비나를 캘린더에 추가합니다」를 누르자 답장 쓰기가 열렸다. 고친 뒤 시트의 큰 단추는 카드가 하는
// 일을 따르고(일정 · 답장 · 그 밖의 일 — 판정 모델이 고른다), 일정 카드는 메일에서 읽은 일정 양식과 「캘린더에 추가」다.
// 이 파일은 모델 · DB · Google 없이: 판정은 가짜 판정 모델, 일정 읽기는 가짜 JSON 모델, 나머지는 코드의 확인 · 정리.
// (만들기 전에 아무것도 만들지 않는다 · 같은 일정 · 두 번 누르기 · 남의 카드는 test/mailCard.integration.test.js — 실제 DB · 가짜 Google)
import test from 'node:test'
import assert from 'node:assert/strict'

const E = await import('../lib/calendarEvent.js')
const C = await import('../lib/mailCard.js')
const { readSkillDir, bundledDir } = await import('../lib/skillPack.js')
const { isReplyCard } = await import('../lib/mailReply.js')

const pack = readSkillDir(bundledDir('mail-card-actions'))
const skill = { version: pack.version, prompts: pack.prompts, rules: { timezone: 'Asia/Seoul', minConfidence: 0.6, timeoutMs: 8000, textChars: 6000, defaultDurationMin: 60, ...pack.rules } }
const SEOUL = 'Asia/Seoul'
// the production card (2026-11-24): the brief's chip
const WEBINAR = { id: 'a-1', verb: 'Add', text: '내일 오후 3시 UiPath 웨비나를 캘린더에 추가합니다.', prompt: '내일(11월 25일) 오후 3시 UiPath 웨비나 일정을 캘린더에 추가해 주세요.',
  source: { mail_id: 'm-1', from: '웨비나 사무국 <events@robotics-webinar.example>', subject: '[초대] UiPath 에이전틱 자동화 웨비나 안내' } }

// ---------- what the card is for ----------
test('카드의 일: 「Reply」 · 문서 초안을 들고 온 카드는 묻지 않고 답장, 정한 카드는 그 값, 아직이면 null, 메일 카드가 아니면 null', () => {
  assert.equal(C.kindOf({ verb: 'Reply', source: { mail_id: 'm' } }), 'reply')
  assert.equal(C.kindOf({ verb: 'Review', source: { mail_id: 'm', drafts: ['견적서.xlsx'] } }), 'reply')
  assert.equal(C.kindOf({ verb: 'Reply', source: { mail_id: 'm', kind: 'calendar' } }), 'reply', '「Reply」 카드는 지금처럼 답장')
  assert.equal(C.kindOf({ verb: 'Add', source: { mail_id: 'm', kind: 'calendar' } }), 'calendar')
  assert.equal(C.kindOf({ verb: 'Pay', source: { mail_id: 'm', kind: 'task' } }), 'task')
  assert.equal(C.kindOf({ verb: 'Add', source: { mail_id: 'm' } }), null, '정하지 않은 카드는 시트가 묻는다')
  assert.equal(C.kindOf({ verb: 'Add', source: { mail_id: 'm', kind: 'weird' } }), null)
  assert.equal(C.kindOf({ verb: 'Add', source: null }), null)
  // a card read as a reply is a reply card everywhere: its reply is never handed to the agent (POST /run)
  assert.equal(isReplyCard({ verb: 'Review', source: { mail_id: 'm', kind: 'reply' } }), true)
  assert.equal(isReplyCard({ verb: 'Add', source: { mail_id: 'm', kind: 'calendar' } }), false)
})

test('판정: 카드의 단추 · 글 · 할 일 · 메일을 보기 셋(일정 · 답장 · 그 밖의 일)과 함께 묻고, 첫 글자 확률로 고른다', async () => {
  const asked = []
  const odds = async (state, question, options) => { asked.push({ state, question, options }); return { choice: 'calendar', probabilities: { calendar: 0.93, reply: 0.02, task: 0.05 }, confidence: 0.93, model: 'fake' } }
  const d = await C.decideKind(WEBINAR, { skill, judges: { odds } })
  assert.deepEqual({ kind: d.kind, p: d.p, by: d.by }, { kind: 'calendar', p: 0.93, by: 'logprob' })
  assert.equal(asked.length, 1)
  assert.deepEqual(asked[0].options.map((o) => o.key), ['calendar', 'reply', 'task'])
  assert.equal(asked[0].question, skill.prompts['choose-kind'], '질문은 스킬의 프롬프트(회사가 고칠 수 있음)')
  assert.match(asked[0].state, /단추: Add/)
  assert.match(asked[0].state, /카드 글: 내일 오후 3시 UiPath 웨비나를 캘린더에 추가합니다\./)
  assert.match(asked[0].state, /누르면 할 일: 내일\(11월 25일\)/)
  assert.match(asked[0].state, /제목: \[초대\] UiPath/)
})

test('판정: 확신이 문턱(0.6) 아래면 「그 밖의 일」(무엇이었는지 남김), 확률이 없는 모델은 JSON, 읽지 못하면 null', async () => {
  const unsure = await C.decideKind(WEBINAR, { skill, judges: { odds: async () => ({ choice: 'calendar', probabilities: { calendar: 0.45, reply: 0.3, task: 0.25 }, confidence: 0.45 }) } })
  assert.deepEqual({ kind: unsure.kind, unsure: unsure.unsure }, { kind: 'task', unsure: 'calendar' })
  let sys = ''
  const viaJson = await C.decideKind({ ...WEBINAR, verb: 'Call', text: '김하늘 님에게 회신 메일로 참석 여부 알리기' }, { skill, judges: { odds: async () => null, json: async (s) => { sys = s; return { choice: 'B', confidence: 0.8 } } } })
  assert.deepEqual({ kind: viaJson.kind, by: viaJson.by, p: viaJson.p }, { kind: 'reply', by: 'json', p: 0.8 })
  assert.match(sys, /JSON \{"choice"/, '스킬의 answer-json 으로 묻는다')
  assert.equal(await C.decideKind(WEBINAR, { skill, judges: { odds: async () => null, json: async () => { throw new Error('gateway down') } } }), null)
  assert.equal(await C.decideKind(WEBINAR, { skill, judges: { odds: async () => null, json: async () => ({ choice: 'Z' }) } }), null)
})

// ---------- date math ----------
test('시간대 계산: 서울 벽시계 → UTC, 받은 때는 그 사람의 날짜로(UTC 로는 전날인 밤 메일), 서머타임 앞뒤', () => {
  assert.equal(E.zonedToUtc('2026-11-25', '15:00', SEOUL).toISOString(), '2026-11-25T06:00:00.000Z')
  assert.equal(E.zonedToUtc('2026-11-25', '00:00', SEOUL).toISOString(), '2026-11-24T15:00:00.000Z')
  // a mail that arrived at 23:30 in Seoul is 14:30 UTC: 「내일」 is counted from the 24th, Seoul time
  assert.deepEqual(E.localParts(new Date('2026-11-24T14:30:00Z'), SEOUL), { date: '2026-11-24', time: '23:30', weekday: 2 })
  assert.deepEqual(E.localParts(new Date('2026-11-24T15:30:00Z'), SEOUL), { date: '2026-11-25', time: '00:30', weekday: 3 })
  // New York: summer and winter, a skipped hour (→ 03:30), a repeated hour (→ the first)
  assert.equal(E.zonedToUtc('2026-07-01', '09:00', 'America/New_York').toISOString(), '2026-07-01T13:00:00.000Z')
  assert.equal(E.zonedToUtc('2026-12-01', '09:00', 'America/New_York').toISOString(), '2026-12-01T14:00:00.000Z')
  assert.equal(E.zonedToUtc('2026-03-08', '02:30', 'America/New_York').toISOString(), '2026-03-08T07:30:00.000Z')
  assert.equal(E.zonedToUtc('2026-11-01', '01:30', 'America/New_York').toISOString(), '2026-11-01T05:30:00.000Z')
  assert.equal(E.nextDay('2026-12-31'), '2027-01-01')
  assert.equal(E.nextDay('2028-02-28'), '2028-02-29')
  assert.equal(E.validTz('Mars/Olympus'), null)
  assert.equal(E.validTz('Asia/Seoul'), 'Asia/Seoul')
})

test('일정 읽기: 모델은 메일을 받은 때(그 사람의 시간대 · 요일)를 보고 「내일 오후 3시」를 세고, 코드는 그 답을 확인한다', async () => {
  let saw = null
  const json = async (sys, user) => { saw = { sys, input: JSON.parse(user) }; return { title: 'UiPath 에이전틱 자동화 웨비나', date: '2026-11-25', start: '15:00', durationMin: 90, allDay: false, timezone: 'Asia/Seoul', location: '', link: 'https://webinar.robotics-webinar.example/join/8812', description: '웨비나 사무국이 보낸 초대', basis: '내일 오후 3시' } }
  const mail = { from: { name: '웨비나 사무국', address: 'events@robotics-webinar.example' }, subject: '[초대] UiPath 에이전틱 자동화 웨비나 안내', date: '2026-11-24T07:20:00.000Z', text: '내일 오후 3시에 웨비나가 열립니다. 참여 링크: https://webinar.robotics-webinar.example/join/8812' }
  const ev = await C.readEvent({ card: WEBINAR, mail, tz: SEOUL, now: new Date('2026-11-24T08:00:00Z') }, { skill, json })
  assert.equal(saw.sys, skill.prompts['read-event'])
  assert.equal(saw.input.mailReceived, '2026-11-24 (Tue) 16:20')
  assert.equal(saw.input.today, '2026-11-24 (Tue)')
  assert.equal(saw.input.timezone, SEOUL)
  assert.equal(saw.input.card.text, WEBINAR.text)
  assert.match(saw.input.mail.text, /내일 오후 3시/)
  assert.equal(saw.input.mail.from, '웨비나 사무국 <events@robotics-webinar.example>')
  assert.deepEqual({ title: ev.title, date: ev.date, start: ev.start, durationMin: ev.durationMin, allDay: ev.allDay, tz: ev.tz, link: ev.link, read: ev.read, missing: ev.missing, warnings: ev.warnings },
    { title: 'UiPath 에이전틱 자동화 웨비나', date: '2026-11-25', start: '15:00', durationMin: 90, allDay: false, tz: SEOUL, link: 'https://webinar.robotics-webinar.example/join/8812', read: 'model', missing: [], warnings: [] })
  assert.equal(E.whenText(ev), '11월 25일 (수) 오후 3:00')
  assert.equal(E.whenText(ev, 'en'), 'Wed, Nov 25, 3:00 PM')
})

test('일정 정리: 시각이 없으면 종일(모델이 종일이라 할 때) 아니면 묻기, 없는 날짜 · 시각 · 링크는 버림, 끝 시각 → 길이, 다른 시간대는 내 시각으로', () => {
  const now = new Date('2026-11-24T08:00:00Z')
  const allDay = E.normalizeEvent({ title: '분기 보고서 마감', date: '2026-11-30', start: null, allDay: true }, { tz: SEOUL, now })
  assert.deepEqual([allDay.allDay, allDay.start, allDay.missing], [true, null, []])
  assert.equal(E.whenText(allDay), '11월 30일 (월) 종일')
  const ask = E.normalizeEvent({ title: '협력사 방문', date: '2026-11-26', start: null, allDay: false }, { tz: SEOUL, now })
  assert.deepEqual([ask.allDay, ask.missing], [false, ['start']], '시각을 지어내지 않고 사람에게 묻는다')
  assert.equal(E.ready(ask), false)
  // shapes that are not a date, a time or a web address are dropped, not guessed
  const bad = E.normalizeEvent({ title: '  점검 \n 회의 ', date: '2026-02-30', start: '25:00', link: 'javascript:alert(1)', durationMin: 99999 }, { tz: SEOUL, now })
  assert.deepEqual([bad.title, bad.date, bad.start, bad.link, bad.durationMin, bad.missing], ['점검 회의', null, null, '', 60, ['date']])
  assert.equal(E.normalizeEvent({ title: 'x', date: '2026-11-26', start: '9:05:00' }, { tz: SEOUL, now }).start, '09:05')
  // an end time instead of a length; a meeting address given as the place
  const end = E.normalizeEvent({ title: '킥오프', date: '2026-11-26', start: '14:00', end: '15:30', location: 'https://meet.example/abc' }, { tz: SEOUL, now })
  assert.deepEqual([end.durationMin, end.link, end.location], [90, 'https://meet.example/abc', ''])
  // 「3 PM ET」 in a mail: on a Seoul person's calendar it is 05:00 the next day — and where it came from is kept
  const et = E.normalizeEvent({ title: 'Partner webinar', date: '2026-11-25', start: '15:00', timezone: 'America/New_York' }, { tz: SEOUL, now })
  assert.deepEqual([et.date, et.start, et.tz, et.from], ['2026-11-26', '05:00', SEOUL, { date: '2026-11-25', start: '15:00', tz: 'America/New_York' }])
  // a time that has passed is said
  assert.deepEqual(E.normalizeEvent({ title: 'x', date: '2026-11-20', start: '10:00' }, { tz: SEOUL, now }).warnings, ['past'])
  // no title from the model: the mail's subject
  assert.equal(E.normalizeEvent({ date: '2026-11-26', start: '10:00' }, { tz: SEOUL, now, fallbackTitle: '[초대] 정기 점검' }).title, '[초대] 정기 점검')
})

test('읽기에 실패하면(모델 오류 · JSON 이 아닌 답 · 배열) 빈 양식: 제목은 메일 제목, 날짜 · 시각은 사람이 넣는다', async () => {
  const mail = { subject: '[초대] UiPath 에이전틱 자동화 웨비나 안내', date: '2026-11-24T07:20:00.000Z', text: '…' }
  for (const json of [async () => { throw new Error("the model's answer is not JSON (Unexpected token)") }, async () => 'not an object', async () => [{ date: '2026-11-25' }]]) {
    const ev = await C.readEvent({ card: WEBINAR, mail, tz: SEOUL, now: new Date('2026-11-24T08:00:00Z') }, { skill, json })
    assert.equal(ev.read, 'failed')
    assert.equal(ev.title, mail.subject)
    assert.deepEqual([ev.date, ev.start, ev.missing], [null, null, ['date']])
  }
  // the mail gone from the mailbox: the card's own words
  const gone = await C.readEvent({ card: WEBINAR, mail: null, tz: SEOUL }, { skill, json: async (s, u) => ({ title: JSON.parse(u).card.text.slice(0, 20), date: '2026-11-25', start: '15:00' }) })
  assert.equal(gone.read, 'model')
  assert.equal(gone.start, '15:00')
})

// ---------- the same event already in the calendar ----------
test('같은 일정: 같은 제목(띄어쓰기 · 대소문자 무시)이고 같은 시작(종일이면 같은 날) — 시각이 다르거나 제목이 다르면 다른 일정', () => {
  const ev = E.normalizeEvent({ title: 'UiPath 웨비나', date: '2026-11-25', start: '15:00' }, { tz: SEOUL, now: new Date('2026-11-24T00:00:00Z') })
  const at = (t) => new Date(t).toISOString()
  const items = [
    { id: 'x1', summary: 'UiPath 웨비나', start: '2026-11-25T16:00:00+09:00' },          // an hour later
    { id: 'x2', summary: '다른 회의', start: at('2026-11-25T06:00:00Z') },               // same time, other title
    { id: 'x3', summary: '  uipath   웨비나 ', start: '2026-11-25T15:00:00+09:00' },     // the same one
  ]
  assert.equal(E.findSame(items, ev)?.id, 'x3')
  assert.equal(E.findSame(items.slice(0, 2), ev), null)
  const w = E.eventWindow(ev)
  assert.deepEqual([w.timeMin.toISOString(), w.timeMax.toISOString()], ['2026-11-25T05:59:00.000Z', '2026-11-25T06:01:00.000Z'])
  const day = E.normalizeEvent({ title: '분기 보고서 마감', date: '2026-11-30', allDay: true }, { tz: SEOUL, now: new Date('2026-11-24T00:00:00Z') })
  assert.equal(E.findSame([{ id: 'd1', summary: '분기 보고서 마감', start: '2026-11-30' }], day)?.id, 'd1')
  assert.equal(E.findSame([{ id: 'd2', summary: '분기 보고서 마감', start: '2026-11-29' }], day), null)
  const dw = E.eventWindow(day)
  assert.deepEqual([dw.timeMin.toISOString(), dw.timeMax.toISOString()], ['2026-11-29T15:00:00.000Z', '2026-11-30T15:00:00.000Z'])
  assert.equal(E.findSame([{ id: 'x' }], { title: 'x' }), null, '날짜 없는 일정은 견주지 않는다')
})
