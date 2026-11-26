// 약속 알림 — 모델 · DB 없이(lib/agenda/remind.js · read.js, 스펙 openspec/specs/agenda-reminders). 2026-11-26 사용자: 「그 메일이나 그 톡에서
// 유입된 정보를 기반으로 어떤 일정이나 그런 맥락이 파악이 되면 … 해당 일정 때에 해당 담당자에게 알림을 … 없으면 추가해줘.」
//   AG-U-01~06 알림의 때: 그날 아침 8시 · 시작 1시간 전, 시간대(서울 · 런던 · 서머타임), 종일, 늦게 만든 약속, 너무 붙은 아침, 끈 사람
//   AG-U-07~09 알림의 말: 오늘 · 내일 · 날짜, 남은 시간, 곳 · 함께 · 챙길 것 · 어디서 정했나(한국어 조사 · 영어)
//   AG-U-10~16 모델의 답 확인: 만들기 · 지난 때 · 시각 없음 · 너무 먼 때 · 바꾸기(준 칸만) · 취소 · 모르는 약속 · 방의 사람만 · 같은 약속
//   AG-U-17~18 모델이 보는 것: 달력(이번 주 · 다음 주), 판정의 문턱
// 이름은 지어낸 것.
import test from 'node:test'
import assert from 'node:assert/strict'

const M = await import('../lib/agenda/remind.js')
const R = await import('../lib/agenda/read.js')
const E = await import('../lib/calendarEvent.js')

const SEOUL = 'Asia/Seoul'
const kst = (date, time) => E.zonedToUtc(date, time, SEOUL)
const iso = (d) => new Date(d).toISOString()
// Thursday 2026-11-26 14:00 KST; the plan: next Tuesday 2026-12-01 15:00 KST at 강남역 스타벅스
const NOW = kst('2026-11-26', '14:00')
const PLAN = { title: '시니어그룹 모임', date: '2026-12-01', start: '15:00', allDay: false, tz: SEOUL, durationMin: 60, location: '강남역 스타벅스', link: '', bring: '', notes: '' }

test('AG-U-01 시각이 있는 약속: 그날 아침 8시와 시작 1시간 전, 둘 다 그 사람의 시계로', () => {
  const s = M.slotsFor(PLAN, { now: NOW })
  assert.deepEqual(s.map((x) => [x.slot, iso(x.dueAt)]), [['day', iso(kst('2026-12-01', '08:00'))], ['before', iso(kst('2026-12-01', '14:00'))]])
  // a person who chose 30 minutes
  assert.equal(iso(M.slotsFor(PLAN, { now: NOW, prefs: { leadMin: 30 } })[1].dueAt), iso(kst('2026-12-01', '14:30')))
  // an odd lead is held between 5 minutes and a day
  assert.equal(iso(M.slotsFor(PLAN, { now: NOW, prefs: { leadMin: 1 } })[1].dueAt), iso(kst('2026-12-01', '14:55')))
})

test('AG-U-02 시간대: 런던 사람은 런던의 아침 8시, 서머타임이 시작되는 날은 바뀐 시계로', () => {
  // 19:00 KST = 10:00 UTC = 10:00 London (winter): its morning is 08:00 London, its before 09:00 UTC
  const evening = { ...PLAN, start: '19:00' }
  const s = M.slotsFor(evening, { now: NOW, tz: 'Europe/London' })
  assert.deepEqual(s.map((x) => [x.slot, iso(x.dueAt)]), [['day', '2026-12-01T08:00:00.000Z'], ['before', '2026-12-01T09:00:00.000Z']])
  // New York, 2026-03-08 (clocks go forward at 02:00): 08:00 EDT = 12:00 UTC, the 15:00 start's hour before = 18:00 UTC
  const ny = { ...PLAN, date: '2026-03-08', start: '15:00', tz: 'America/New_York' }
  const t = M.slotsFor(ny, { now: new Date('2026-03-01T00:00:00Z') })
  assert.deepEqual(t.map((x) => iso(x.dueAt)), ['2026-03-08T12:00:00.000Z', '2026-03-08T18:00:00.000Z'])
})

test('AG-U-03 종일 약속: 그날 아침 하나뿐', () => {
  const day = { ...PLAN, start: null, allDay: true }
  assert.deepEqual(M.slotsFor(day, { now: NOW }).map((x) => [x.slot, iso(x.dueAt)]), [['day', iso(kst('2026-12-01', '08:00'))]])
  assert.deepEqual(M.slotsFor(day, { now: kst('2026-12-01', '09:00') }), [], '그날 아침이 지나 만든 종일 약속은 알림 없음')
  assert.equal(iso(M.startOf(day)), iso(kst('2026-12-01', '00:00')))
  assert.equal(M.isOver(day, kst('2026-12-01', '23:59')), false)
  assert.equal(M.isOver(day, kst('2026-12-02', '00:00')), true)
})

test('AG-U-04 늦게 만든 약속: 지난 알림은 건너뛰고, 아직 앞인 1시간 전 알림은 보낸다', () => {
  assert.deepEqual(M.slotsFor(PLAN, { now: kst('2026-12-01', '09:00') }).map((x) => x.slot), ['before'])
  assert.deepEqual(M.slotsFor(PLAN, { now: kst('2026-12-01', '14:30') }), [], '1시간 전도 지났으면 없음')
  assert.deepEqual(M.slotsFor({ ...PLAN, date: '2026-11-20' }, { now: NOW }), [], '지난 약속')
})

test('AG-U-05 아침 알림이 시작 전 알림과 30분 안쪽으로 붙으면 시작 전 하나만', () => {
  // 09:15 start: before 08:15, the morning 08:00 is within 30 min of it
  assert.deepEqual(M.slotsFor({ ...PLAN, start: '09:15' }, { now: NOW }).map((x) => [x.slot, iso(x.dueAt)]), [['before', iso(kst('2026-12-01', '08:15'))]])
  // 07:30 start: the morning is after the start — the hour before only
  assert.deepEqual(M.slotsFor({ ...PLAN, start: '07:30' }, { now: NOW }).map((x) => x.slot), ['before'])
  // 10:00 start: 08:00 and 09:00 both
  assert.deepEqual(M.slotsFor({ ...PLAN, start: '10:00' }, { now: NOW }).map((x) => x.slot), ['day', 'before'])
})

test('AG-U-06 약속 알림을 끈 사람 · 때가 없는 약속은 알림 없음', () => {
  assert.deepEqual(M.slotsFor(PLAN, { now: NOW, prefs: { on: false } }), [])
  assert.deepEqual(M.slotsFor({ ...PLAN, start: null }, { now: NOW }), [])
  assert.deepEqual(M.slotsFor({ ...PLAN, date: null }, { now: NOW }), [])
})

test('AG-U-07 때의 말: 오늘 · 내일은 그렇게, 그 밖은 날짜와 요일 — 영어도', () => {
  assert.equal(M.whenWords(PLAN, { now: kst('2026-12-01', '08:00') }), '오늘 오후 3:00')
  assert.equal(M.whenWords(PLAN, { now: kst('2026-11-30', '20:00') }), '내일 오후 3:00')
  assert.equal(M.whenWords(PLAN, { now: NOW }), '12월 1일 (화) 오후 3:00')
  assert.equal(M.whenWords(PLAN, { now: kst('2026-12-01', '08:00'), lang: 'en' }), 'Today, 3:00 PM')
  assert.equal(M.whenWords(PLAN, { now: NOW, lang: 'en' }), 'Tue, Dec 1, 3:00 PM')
  assert.equal(M.whenWords({ ...PLAN, start: null, allDay: true }, { now: kst('2026-12-01', '08:00') }), '오늘 종일')
  // read on another clock: at 08:00 in Seoul it is still the evening before in London — the plan is 「tomorrow, 6 AM」 there
  assert.equal(M.whenWords(PLAN, { now: kst('2026-12-01', '08:00'), tz: 'Europe/London', lang: 'en' }), 'Tomorrow, 6:00 AM')
})

test('AG-U-08 남은 시간의 말: 1시간 뒤 · 1시간 30분 뒤 · 25분 뒤 (5분 단위)', () => {
  assert.equal(M.leadWords(PLAN, { now: kst('2026-12-01', '14:00') }), '1시간 뒤')
  assert.equal(M.leadWords(PLAN, { now: kst('2026-12-01', '13:31') }), '1시간 30분 뒤')
  assert.equal(M.leadWords(PLAN, { now: kst('2026-12-01', '14:36') }), '25분 뒤')
  assert.equal(M.leadWords(PLAN, { now: kst('2026-12-01', '14:00'), lang: 'en' }), 'in 1 hr')
  assert.equal(M.leadWords(PLAN, { now: kst('2026-12-01', '12:30'), lang: 'en' }), 'in 2 hrs 30 min')
})

test('AG-U-09 알림의 글: 무엇을 언제 어디서 하기로 했는지, 함께 · 챙길 것 · 정한 곳 — 조사와 영어', () => {
  const room = { kind: 'room', title: '시니어그룹' }
  const a = M.reminderText(PLAN, 'day', { now: kst('2026-12-01', '08:00'), source: room })
  assert.equal(a.title, '오늘 오후 3:00 · 시니어그룹 모임')
  assert.equal(a.text, '오늘 오후 3:00 시니어그룹 모임은 강남역 스타벅스에서 하기로 했어요.\n「시니어그룹」 대화에서 정했어요.')
  const b = M.reminderText({ ...PLAN, title: '주간 회의', location: '', bring: '노트북' }, 'before', { now: kst('2026-12-01', '14:00'), source: room, people: ['김서연', '박도윤'] })
  assert.equal(b.title, '1시간 뒤 · 주간 회의')
  assert.equal(b.text, '오늘 오후 3:00 주간 회의가 있어요.\n함께: 김서연, 박도윤\n챙길 것: 노트북\n「시니어그룹」 대화에서 정했어요.')
  const c = M.reminderText({ ...PLAN, link: 'https://meet.example/abc' }, 'day', { now: kst('2026-12-01', '08:00'), lang: 'en', source: { kind: 'mail', subject: '12월 정기 모임 안내' } })
  assert.equal(c.title, 'Today, 3:00 PM · 시니어그룹 모임')
  assert.equal(c.text, 'Today, 3:00 PM: 시니어그룹 모임 is at 강남역 스타벅스, as agreed.\nJoin: https://meet.example/abc\nFrom the mail “12월 정기 모임 안내”.')
  // 받침 없는 제목: 「저녁 식사는」
  assert.match(M.reminderText({ ...PLAN, title: '저녁 식사' }, 'day', { now: NOW, source: room }).text, /^12월 1일 \(화\) 오후 3:00 저녁 식사는 강남역 스타벅스에서 하기로 했어요\./)
})

// ---------- what the model answered, checked ----------
const members = [{ id: '11111111-1111-4111-8111-111111111111', name: '정하윤' }, { id: '22222222-2222-4222-8222-222222222222', name: '김서연' }, { id: '33333333-3333-4333-8333-333333333333', name: '이지후' }]
const live = [{ id: 'p-1', ...PLAN, audience: 'room', participants: members.map((m) => m.id) }]
const msgs = [{ uuid: 'u-1', who: '김서연', at: NOW, text: '다음주 화요일 3시에 강남역 스타벅스에서 봐요', fresh: true }, { uuid: 'u-2', who: '정하윤', at: NOW, text: '좋아요', fresh: true }]
const ctx = (plans = []) => { const { input, keys } = R.inputFor({ where: 'room', now: NOW, tz: SEOUL, plans, members, messages: msgs }); return { input, keys, where: 'room', now: NOW, tz: SEOUL, lastMessage: 'u-2' } }

test('AG-U-10 만들기: 있는 날짜 · 24시간 시각 · 곳, 메시지 열쇠 → 그 메시지, 사람은 방 전체', () => {
  const c = ctx()
  const { ops, skipped } = R.checkOps([{ op: 'create', title: '시니어그룹 모임', date: '2026-12-01', start: '15:00', allDay: false, location: '강남역 스타벅스', for: 'all', message: '#1', basis: '다음주 화요일 3시' }], c)
  assert.deepEqual(skipped, [])
  assert.equal(ops.length, 1)
  assert.deepEqual({ ...ops[0].item }, { title: '시니어그룹 모임', date: '2026-12-01', start: '15:00', allDay: false, tz: SEOUL, durationMin: 60, location: '강남역 스타벅스', link: '', bring: '', notes: '' })
  assert.equal(ops[0].message, 'u-1')
  assert.equal(ops[0].people, null)
  // a message key the model made up: the newest new message
  assert.equal(R.checkOps([{ op: 'create', title: '점심', date: '2026-12-02', start: '12:00', message: '#9' }], c).ops[0].message, 'u-2')
  // a link given as the place goes to link
  const on = R.checkOps([{ op: 'create', title: '온라인 회의', date: '2026-12-02', start: '10:00', location: 'https://meet.example/x' }], c).ops[0].item
  assert.equal(on.link, 'https://meet.example/x')
  assert.equal(on.location, '')
})

test('AG-U-11 남기지 않는 것: 지난 때 · 시각도 종일도 아님 · 없는 날짜 · 1년보다 먼 때 · 제목 없음 · 모르는 일', () => {
  const c = ctx()
  const { ops, skipped } = R.checkOps([
    { op: 'create', title: '지난 회의', date: '2026-11-20', start: '10:00' },
    { op: 'create', title: '언젠가 식사', date: '2026-12-03', start: null, allDay: false },
    { op: 'create', title: '없는 날', date: '2026-02-30', start: '10:00' },
    { op: 'create', title: '먼 약속', date: '2028-01-05', start: '10:00' },
    { op: 'create', title: '', date: '2026-12-03', start: '10:00' },
    { op: 'delete', plan: 'P1' },
  ], c)
  assert.deepEqual(ops, [])
  assert.deepEqual(skipped.map((s) => s.why), ['past', 'incomplete', 'incomplete', 'too_far', 'incomplete', 'unknown'])
  assert.deepEqual(R.checkOps({ ops: 'nope' }, c), { ops: [], skipped: [] }, 'ops 가 배열이 아니면 아무것도')
})

test('AG-U-12 바꾸기: 준 칸만 바뀐다 — 곳만 주면 때는 그대로, 시각만 주면 날짜는 그대로, 같으면 아무 일도 아님', () => {
  const c = ctx(live)
  const place = R.checkOps([{ op: 'update', plan: 'P1', location: '역삼역 2번 출구', message: '#2' }], c)
  assert.equal(place.ops.length, 1)
  assert.equal(place.ops[0].id, 'p-1')
  assert.deepEqual(place.ops[0].changed, ['location'])
  assert.equal(place.ops[0].item.date, '2026-12-01')
  assert.equal(place.ops[0].item.start, '15:00')
  assert.equal(place.ops[0].item.location, '역삼역 2번 출구')
  const time = R.checkOps([{ op: 'update', plan: 'P1', start: '16:00', date: null, location: '' }], c).ops[0]
  assert.deepEqual(time.changed, ['start'])
  assert.equal(time.item.date, '2026-12-01')
  assert.equal(time.item.location, '강남역 스타벅스', '빈 칸은 바꾸지 않는다')
  assert.deepEqual(R.checkOps([{ op: 'update', plan: 'P1', location: '강남역 스타벅스' }], c).skipped.map((s) => s.why), ['same'])
  // a model that wrote the place under 「place」 (the real model did, 2026-11-26): the same as location
  assert.equal(R.checkOps([{ op: 'update', plan: 'P1', place: '역삼역' }], c).ops[0].item.location, '역삼역')
  assert.deepEqual(R.checkOps([{ op: 'update', plan: 'P1', date: '2026-11-20' }], c).skipped.map((s) => s.why), ['past'], '지난 날로 옮기지 않는다')
})

test('AG-U-13 취소 · 모르는 약속: 이 방(메일함)의 약속만 바꾸고 취소한다', () => {
  const c = ctx(live)
  assert.deepEqual(R.checkOps([{ op: 'cancel', plan: 'P1', message: '#2' }], c).ops, [{ op: 'cancel', id: 'p-1', message: 'u-2', basis: '' }])
  const other = R.checkOps([{ op: 'cancel', plan: 'P7' }, { op: 'update', plan: 'p-1', location: 'x' }], c)
  assert.deepEqual(other.ops, [])
  assert.deepEqual(other.skipped.map((s) => s.why), ['no_plan', 'no_plan'], '약속의 진짜 id 를 적어도 열쇠가 아니면 없는 약속')
})

test('AG-U-14 몇 사람만의 약속: 방 사람의 열쇠만 id 로, 지어낸 열쇠는 버리고, 하나도 없으면 방 전체', () => {
  const c = ctx()
  const two = R.checkOps([{ op: 'create', title: '견적 검토', date: '2026-12-02', start: '10:00', for: 'some', people: ['M1', 'M3', 'M9'] }], c).ops[0]
  assert.deepEqual(two.people, [members[0].id, members[2].id])
  assert.equal(R.checkOps([{ op: 'create', title: '견적 검토', date: '2026-12-02', start: '10:00', for: 'some', people: ['M9'] }], c).ops[0].people, null)
  // a mail: the owner's, never people
  const { input, keys } = R.inputFor({ where: 'mail', now: NOW, tz: SEOUL, mail: { from: 'a@example.test', subject: 's', text: 't', date: NOW } })
  assert.equal(input.members, undefined)
  assert.equal(R.checkOps([{ op: 'create', title: '면담', date: '2026-12-02', start: '10:00', for: 'some', people: ['M1'] }], { input, keys, where: 'mail', now: NOW, tz: SEOUL }).ops[0].people, null)
  // the people of a plan are said by key to the model
  const c2 = ctx([{ ...live[0], audience: 'people', participants: [members[1].id] }])
  assert.deepEqual(c2.input.plans[0].for, ['M2'])
})

test('AG-U-15 같은 약속을 다시 말하면 아무 일도 아님(같은 이름 · 같은 때), 한 번에 둘을 정하면 둘', () => {
  const c = ctx(live)
  assert.deepEqual(R.checkOps([{ op: 'create', title: '시니어그룹  모임', date: '2026-12-01', start: '15:00' }], c).skipped.map((s) => s.why), ['same'])
  const two = R.checkOps([{ op: 'create', title: '점심', date: '2026-12-02', start: '12:00' }, { op: 'create', title: '점심', date: '2026-12-02', start: '12:00' },
    { op: 'create', title: '저녁 식사', date: '2026-12-04', start: '19:00', location: '을지로' }], c)
  assert.deepEqual(two.ops.map((o) => o.item.title), ['점심', '저녁 식사'])
  assert.equal(R.checkOps(Array.from({ length: 9 }, (_, i) => ({ op: 'create', title: `약속 ${i}`, date: '2026-12-02', start: `1${i}:00` })), c).ops.length, R.MAX_OPS)
})

test('AG-U-16 다른 시간대로 말한 시각은 그 사람의 시간대로 옮긴다', () => {
  const c = ctx()
  const o = R.checkOps([{ op: 'create', title: '본사 통화', date: '2026-12-02', start: '09:00', timezone: 'America/New_York' }], c).ops[0]
  assert.deepEqual([o.item.date, o.item.start, o.item.tz], ['2026-12-02', '23:00', SEOUL])
})

test('AG-U-17 모델이 보는 달력: 목요일 오늘 — 다음 월요일부터 「다음 주」, 그다음 월요일부터 「다다음 주」', () => {
  const cal = R.calendarOf(NOW, SEOUL, 14)
  assert.equal(cal[0], '2026-11-26 (목) · 이번 주 · 오늘')
  assert.equal(cal[1], '2026-11-27 (금) · 이번 주 · 내일')
  assert.equal(cal[4], '2026-11-30 (월) · 다음 주')
  assert.equal(cal[5], '2026-12-01 (화) · 다음 주')
  assert.equal(cal[11], '2026-12-07 (월) · 다다음 주')
  const { input } = R.inputFor({ where: 'room', now: NOW, tz: SEOUL, plans: live, members, messages: msgs })
  assert.equal(input.today, '2026-11-26 (목)')
  assert.deepEqual(input.plans, [{ key: 'P1', title: '시니어그룹 모임', when: '2026-12-01 (화) 15:00', location: '강남역 스타벅스', for: 'all' }])
  assert.deepEqual(input.members, [{ key: 'M1', name: '정하윤' }, { key: 'M2', name: '김서연' }, { key: 'M3', name: '이지후' }])
  assert.deepEqual(input.messages[0], { key: '#1', who: '김서연', at: '2026-11-26 (목) 14:00', text: msgs[0].text, new: true })
})

test('AG-U-18 판정: 「있다」의 확률이 문턱(0.3) 이상이면 읽는다, JSON 답은 고른 쪽의 확신으로, 읽지 못하면 null', async () => {
  const skill = { prompts: { gate: 'Q', 'answer-json': 'J' }, rules: { gateMin: 0.3, timeoutMs: 100 } }
  const { input } = R.inputFor({ where: 'room', now: NOW, tz: SEOUL, members, messages: msgs })
  let seen = null
  const odds = (p) => async (state, question, options) => { seen = { state, question, options }; return { choice: p >= 0.5 ? 'plan' : 'none', probabilities: { plan: p, none: 1 - p }, confidence: Math.max(p, 1 - p), strategy: 'logprob', model: 'm' } }
  assert.deepEqual(await R.gate(input, { skill, decide: odds(0.31) }), { pass: true, p: 0.31, by: 'logprob', model: 'm' })
  assert.equal((await R.gate(input, { skill, decide: odds(0.29) })).pass, false)
  assert.match(seen.state, /#1 \[새\] 김서연 \(2026-11-26 \(목\) 14:00\): 다음주 화요일 3시에 강남역 스타벅스에서 봐요/)
  assert.deepEqual(seen.options.map((o) => o.key), ['plan', 'none'])
  const json = async () => ({ choice: 'none', probabilities: { none: 0.9 }, confidence: 0.9, strategy: 'json', model: null })
  assert.deepEqual(await R.gate(input, { skill, decide: json }), { pass: false, p: 0.1, by: 'json', model: null })
  assert.equal(await R.gate(input, { skill, decide: async () => null }), null)
})
