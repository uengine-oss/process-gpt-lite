// 약속 알림 재검토 반영(PR #95 재검토) — DB · 모델 없이. 고치기 전 코드에서 먼저 돌려 실패를 확인한 시험이다.
//   R2-U-01 (#1) 카드의 링크 옆 「보낸 사람」은 그 링크를 준 메일의 보낸 사람(처음 약속을 정한 사람이 아니라)
//   R2-U-02 (#2) 여러 사람이 함께 쓰는 보낸 주소(메일링 리스트 · 그룹이 고쳐 쓴 From · 자동 발송): 낱말이 아니라 머리로만 알아본다
//   R2-U-03 (#2) 메일을 가져올 때 그 머리(List-Id · List-Unsubscribe · Precedence · Auto-Submitted · X-Original-Sender)를 함께 가져온다
//   R2-U-04 (#3) 메일 약속의 제목 · 장소 · 챙길 것 · 메모 속 주소는 알림 글에서 「(링크: 도메인)」으로 — 카드는 그대로
//   R2-U-05 (#4) 판정에는 새 메시지를 먼저(많으면 짧게 모두), 남는 자리에 앞의 맥락
//   R2-U-06 (#4) 한 시간 넘게 쉰 방은 방마다의 호출 기록에서 지운다
// 이름은 지어낸 것.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'

process.env.PRO_TENANT_ID = 'agenda-rv2-unit'
process.env.PRO_BACKGROUND = '0'
process.env.PRO_LLM_BASE_URL = 'http://127.0.0.1:9/v1'
const M = await import('../lib/agenda/remind.js')
const R = await import('../lib/agenda/read.js')
const S = await import('../lib/agenda/store.js')
const A = await import('../lib/agenda/mail.js')
const RM = await import('../lib/agenda/rooms.js')
const MAIL = await import('../lib/mail.js')
const { pool } = await import('../lib/supa.js')
after(() => pool.end().catch(() => {}))

const NOW = new Date('2026-11-26T14:00:00+09:00')
const MORNING = new Date('2026-12-01T08:00:00+09:00')
const PLAN = { title: '파트너 미팅', date: '2026-12-01', start: '15:00', allDay: false, tz: 'Asia/Seoul', durationMin: 60, location: '', link: 'https://meet.partner.example/b', bring: '', notes: '' }

test('R2-U-01 카드의 링크 옆 보낸 사람은 그 링크를 준 메일의 보낸 사람', async () => {
  const item = { ...PLAN, id: 'p-1', kind: 'mail', audience: 'owner', participants: ['u-1'], dismissedBy: [], status: 'changed', version: 2, calendar: {}, history: [],
    messageIds: [], mailId: 'm-2', roomId: null,
    source: { kind: 'mail', subject: 'Re: 파트너 미팅', from: '박 과장 <park@partner.example>', sender: 'kim@partner.example', thread: 't-1', linkFrom: 'park@partner.example' } }
  const v = await S.viewOf(item, { id: 'u-1' }, { now: NOW })
  assert.equal(v.linkFrom, 'park@partner.example')
})

test('R2-U-02 함께 쓰는 보낸 주소는 머리로만 알아본다(List-Id · List-Unsubscribe · Precedence · Auto-Submitted · 다른 X-Original-Sender)', () => {
  const from = '공지 <notice@club.example>'
  assert.ok(A.sharedSender({ from, listId: '<club.lists.example>' }))
  assert.ok(A.sharedSender({ from, listUnsubscribe: '<mailto:leave@club.example>' }))
  assert.ok(A.sharedSender({ from, precedence: 'bulk' }))
  assert.ok(A.sharedSender({ from, precedence: 'List' }))
  assert.ok(A.sharedSender({ from, autoSubmitted: 'auto-generated' }))
  assert.ok(A.sharedSender({ from: '김 대리 via 영업팀 <sales-team@groups.example>', xOriginalSender: 'kim@partner.example' }), '그룹이 From 을 고쳐 씀')
  assert.equal(A.sharedSender({ from: 'kim@partner.example', xOriginalSender: 'Kim@Partner.example' }), null, '같은 사람')
  assert.equal(A.sharedSender({ from, autoSubmitted: 'no' }), null)
  assert.equal(A.sharedSender({ from, precedence: 'first-class' }), null)
  // a plain mail — even from an address that reads like a robot's: words are not looked at
  assert.equal(A.sharedSender({ from: 'no-reply@zoom.example' }), null)
  assert.equal(A.sharedSender({ from: '김 대리 <kim@partner.example>' }), null)
})

test('R2-U-03 메일을 가져올 때 함께 쓰는 주소를 알아볼 머리를 가져온다', () => {
  const h = { 'list-id': '<club.lists.example>', 'list-unsubscribe': '<mailto:x@club.example>', precedence: 'bulk', 'auto-submitted': 'auto-generated', 'x-original-sender': 'kim@partner.example' }
  assert.deepEqual(MAIL.headerFields(h), { listId: '<club.lists.example>', listUnsubscribe: '<mailto:x@club.example>', precedence: 'bulk', autoSubmitted: 'auto-generated', xOriginalSender: 'kim@partner.example' })
  assert.deepEqual(MAIL.headerFields({}), {})
  // IMAP: mailparser's raw header lines
  assert.deepEqual(MAIL.headerFields(MAIL.headerMap([{ key: 'list-id', line: 'List-Id: <club.lists.example>' }, { key: 'precedence', line: 'Precedence: list' }])), { listId: '<club.lists.example>', precedence: 'list' })
})

test('R2-U-04 메일 약속의 제목 · 장소 · 챙길 것 · 메모 속 주소는 알림 글에서 도메인만, 대화방 약속은 그대로', () => {
  const evil = { ...PLAN, title: '미팅 https://evil.example/t?x=1', location: 'https://evil.example/room', bring: '자료(https://files.evil.example/a)', notes: '여기로 https://evil.example/n 들어오세요', link: '' }
  const t = M.reminderText(evil, 'day', { now: MORNING, source: { kind: 'mail', subject: '미팅' } })
  assert.ok(!/https?:\/\//.test(t.title + t.text), `${t.title}\n${t.text}`)
  assert.match(t.title, /미팅 \(링크: evil\.example\)/)
  assert.match(t.text, /\(링크: evil\.example\)에서 하기로 했어요/)
  assert.match(t.text, /\(링크: files\.evil\.example\)/)
  const en = M.reminderText(evil, 'day', { now: MORNING, lang: 'en', source: { kind: 'mail', subject: 'x' } })
  assert.ok(!/https?:\/\//.test(en.title + en.text))
  assert.match(en.text, /\(link: evil\.example\)/)
  const room = M.reminderText(evil, 'day', { now: MORNING, source: { kind: 'room', title: '영업팀' } })
  assert.match(room.text, /https:\/\/evil\.example\/room/)
})

test('R2-U-05 판정에는 새 메시지를 먼저 — 15개가 넘으면 짧게 모두, 남는 자리에만 앞의 맥락', () => {
  const members = [{ id: '00000000-0000-4000-8000-000000000001', name: '정하윤' }]
  const at = NOW
  const ctx = Array.from({ length: 12 }, (_, i) => ({ uuid: `c-${i}`, who: '정하윤', at, text: `예전 이야기 ${i}`, fresh: false }))
  const fresh = Array.from({ length: 20 }, (_, i) => ({ uuid: `n-${i}`, who: '정하윤', at, text: i === 0 ? '내일 3시 강남역 스타벅스에서 봐요 ' + '가'.repeat(400) : `잡담 ${i} ` + '나'.repeat(400), fresh: true }))
  const { input } = R.inputFor({ where: 'room', now: NOW, tz: 'Asia/Seoul', members, messages: [...ctx, ...fresh] })
  const state = R.gateState(input)
  const lines = state.split('\n').filter((l) => /^#\d+/.test(l))
  assert.ok(state.includes('내일 3시 강남역 스타벅스에서 봐요'), '앞쪽의 새 메시지가 잘리지 않는다')
  assert.equal(lines.filter((l) => l.includes('[새]')).length, 20, '새 메시지는 모두')
  assert.equal(lines.filter((l) => !l.includes('[새]')).length, 0, '자리가 없으면 맥락은 빠진다')
  const total = lines.reduce((n, l) => n + l.length, 0)
  assert.ok(total <= 15 * 300 + 20 * 60, `판정 글 ${total}자`)
  // few new: they and the latest context fit within the cap
  const { input: i2 } = R.inputFor({ where: 'room', now: NOW, tz: 'Asia/Seoul', members, messages: [...ctx, ...fresh.slice(0, 5)] })
  const l2 = R.gateState(i2).split('\n').filter((l) => /^#\d+/.test(l))
  assert.equal(l2.filter((l) => l.includes('[새]')).length, 5)
  assert.equal(l2.length, 15)
  assert.ok(!l2.some((l) => /예전 이야기 [01]$/.test(l)) && l2.some((l) => l.includes('예전 이야기 11')), '맥락은 가장 최근 것부터')
})

test('R2-U-06 한 시간 넘게 쉰 방은 방마다의 호출 기록에서 지운다', () => {
  const t0 = Date.now()
  RM.noteReading('t:room-a', t0)
  RM.noteReading('t:room-b', t0 - 2 * 3600_000)
  RM.pruneReadings(t0)
  assert.deepEqual(RM.readingRooms().sort(), ['t:room-a'])
  RM.pruneReadings(t0 + 2 * 3600_000)
  assert.deepEqual(RM.readingRooms(), [])
})
