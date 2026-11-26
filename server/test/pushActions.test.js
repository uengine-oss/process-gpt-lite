// 휴대폰 알림을 메신저처럼 · AI 의 질문에 알림에서 바로 답하기 — 순수한 부분(lib/pushActions.js, 2026-11-26 사용자: 「퀵하게 대화방에서 온
// 내용 혹은 ai의 후먼인더루프 등을 모바일에서 보게할 수 있나?」, 스펙 openspec/specs/mobile-push). DB · 네트워크 없음.
//   PA-U-01 토큰: 사람 · 알림 · 카드 · 답할 수 있는 보기에 묶이고, 같은 키로만 검증된다
//   PA-U-02 위조: 내용을 바꾸거나 서명을 바꾸거나 다른 키 · 다른 모양이면 'bad'
//   PA-U-03 만료: 24시간이 지나면 'expired', 24시간보다 먼 만료는 우리 것이 아니다('bad')
//   PA-U-04 묶기: 팀원의 메시지는 방마다 하나(가장 최근 것이 온 순서), 그 밖의 알림은 하나씩
//   PA-U-05 방 알림: 「<방 이름> · 3」, 마지막 두 줄 「보낸 사람: 말」, 1:1 방은 보낸 사람 이름, 방마다 같은 태그
//   PA-U-06 멘션: Lite 의 'team' 알림 중 「나를 언급했어요」 · 「mentioned you」와 process-gpt 의 'mention' 만
//   PA-U-07 단추: 보기 두 개 이하의 짧은 질문은 보기, 승인은 「열기」 + 거절만, 그 밖은 「열기」
//   PA-U-08 카드 종류 · 알림 글자
// Run: node --test test/pushActions.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import * as PA from '../lib/pushActions.js'

const key = PA.actionKey('service-secret-for-tests')
const ids = { u: '11111111-1111-4111-8111-111111111111', n: '22222222-2222-4222-8222-222222222222', c: '33333333-3333-4333-8333-333333333333' }
const mint = (o = {}) => PA.mintAction({ key, tenant: 'push-t', userId: ids.u, notice: ids.n, card: ids.c, answers: ['세 줄 요약', '표로 정리'], ...o })

test('PA-U-01 토큰은 사람 · 알림 · 카드 · 보기에 묶이고 같은 키로 검증된다', () => {
  const t = mint()
  assert.match(t, /^pa1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/)
  const v = PA.verifyAction(t, { key })
  assert.equal(v.ok, true)
  assert.deepEqual({ t: v.claims.t, u: v.claims.u, n: v.claims.n, c: v.claims.c, a: v.claims.a }, { t: 'push-t', u: ids.u, n: ids.n, c: ids.c, a: ['세 줄 요약', '표로 정리'] })
  // (the session token is nowhere in it)
  assert.doesNotMatch(Buffer.from(t.split('.')[1], 'base64url').toString(), /access_token|Bearer|eyJ/)
  assert.throws(() => PA.mintAction({ key, userId: ids.u, notice: null, card: ids.c }))
  assert.throws(() => PA.actionKey(''))
})

test('PA-U-02 바꾼 내용 · 바꾼 서명 · 다른 키 · 다른 모양은 거절한다', () => {
  const t = mint()
  const [, body, sig] = t.split('.')
  const claims = JSON.parse(Buffer.from(body, 'base64url').toString())
  // another person, or more answers, in the same signature
  for (const change of [{ u: '44444444-4444-4444-8444-444444444444' }, { a: ['승인'] }, { n: ids.c }]) {
    const forged = `pa1.${Buffer.from(JSON.stringify({ ...claims, ...change })).toString('base64url')}.${sig}`
    assert.deepEqual(PA.verifyAction(forged, { key }), { ok: false, why: 'bad' })
  }
  const flipped = `pa1.${body}.${sig.slice(0, -2)}${sig.slice(-2) === 'AA' ? 'AB' : 'AA'}`
  assert.equal(PA.verifyAction(flipped, { key }).why, 'bad')
  assert.equal(PA.verifyAction(t, { key: PA.actionKey('another-server') }).why, 'bad')
  for (const junk of ['', null, 'pa1..', `pga1.${body}.${sig}`, `pa1.${body}`, `pa1.${body}.${sig}.x`]) assert.equal(PA.verifyAction(junk, { key }).ok, false)
})

test('PA-U-03 24시간이 지나면 만료, 그보다 먼 만료는 거절', () => {
  const now = Date.UTC(2026, 10, 26, 9, 0, 0)
  const t = mint({ now })
  assert.equal(PA.verifyAction(t, { key, now: now + 23 * 3600e3 }).ok, true)
  assert.deepEqual(PA.verifyAction(t, { key, now: now + 24 * 3600e3 + 1000 }), { ok: false, why: 'expired' })
  const far = mint({ now, ttlS: 30 * 24 * 3600 })
  assert.equal(PA.verifyAction(far, { key, now }).why, 'bad')
})

test('PA-U-04 팀원의 메시지는 방마다 하나로, 그 밖의 알림은 하나씩', () => {
  const R1 = '/chats?id=room-a', R2 = '/chats?id=room-b'
  const rows = [
    { id: 1, type: 'chat', url: R1, title: '안녕하세요' },
    { id: 2, type: 'workitem_bpm', url: '/todolist/x', title: '견적 승인' },
    { id: 3, type: 'chat', url: R2, title: '회의 몇 시죠?' },
    { id: 4, type: 'chat', url: R1, title: '견적서 보냈어요' },
    { id: 5, type: 'team', url: '/pro/team/room-b/m1', title: '김민수님이 나를 언급했어요' },
  ]
  const g = PA.groupForPush(rows)
  assert.deepEqual(g.map((x) => x.room ? `room:${x.room}:${x.rows.map((r) => r.id).join(',')}` : `row:${x.row.id}`),
    ['row:2', 'room:room-b:3', 'room:room-a:1,4', 'row:5'])
  assert.equal(PA.roomOf(R1), 'room-a')
  assert.equal(PA.roomOf('/pro/team/room-b/m1'), 'room-b')
  assert.equal(PA.roomOf('/todolist/x'), null)
})

test('PA-U-05 방 알림: 「<방 이름> · 3」, 마지막 두 줄, 1:1 방은 보낸 사람, 방마다 같은 태그', () => {
  const lines = [{ from: '박지호', text: '첫 줄' }, { from: '김민수', text: '견적서 보냈어요' }, { from: '김민수', text: '확인   부탁해요' }]
  const n = PA.roomNotice({ room: 'room-a', name: '3분기 견적', count: 3, lines })
  assert.deepEqual(n, { title: '3분기 견적 · 3', body: '김민수: 견적서 보냈어요\n김민수: 확인 부탁해요', tag: 'pgl-room-room-a', renotify: true, room: 'room-a' })
  const one = PA.roomNotice({ room: 'room-c', name: null, count: 1, lines: [{ from: '한지우', text: '점심 같이 해요' }] })
  assert.equal(one.title, '한지우')
  assert.equal(one.body, '한지우: 점심 같이 해요')
  assert.equal(one.tag, PA.roomTag('room-c'))
  assert.equal(PA.roomNotice({ room: 'r', count: 2, lines: [] }).title, '새 메시지 · 2')
})

test('PA-U-06 멘션은 따로 — 「나를 언급했어요」 · 「mentioned you」 · mention', () => {
  assert.equal(PA.isMention({ type: 'team', title: '김민수님이 나를 언급했어요 · 견적' }), true)
  assert.equal(PA.isMention({ type: 'team', title: 'Minsu Kim mentioned you' }), true)
  assert.equal(PA.isMention({ type: 'mention', title: '봐 주세요' }), true)
  assert.equal(PA.isMention({ type: 'team', title: '김민수님이 견적서.xlsx를 공유했어요' }), false)
  assert.equal(PA.isMention({ type: 'chat', title: '나를 언급했어요' }), false)
})

test('PA-U-07 단추: 묻는 쪽이 가볍다고 한 짧은 보기 두 개 이하는 보기, 승인은 「열기」와 정해진 거절만, 그 밖은 「열기」', () => {
  assert.deepEqual(PA.askButtons({ kind: 'question', options: ['세 줄 요약', '표로 정리'], quick: true }),
    { buttons: [{ action: 'a0', title: '세 줄 요약' }, { action: 'a1', title: '표로 정리' }], answers: ['세 줄 요약', '표로 정리'] })
  assert.deepEqual(PA.askButtons({ kind: 'question', options: ['예'], quick: true }).answers, ['예'])
  const open = { buttons: [{ action: 'open', title: '열기' }], answers: [] }
  assert.deepEqual(PA.askButtons({ kind: 'question', options: ['가', '나', '다'], quick: true }), open)
  assert.deepEqual(PA.askButtons({ kind: 'question', options: ['아주 긴 보기라서 알림 단추에서 잘려 버리는 글자'], quick: true }), open)
  assert.deepEqual(PA.askButtons({ kind: 'question', options: [], quick: true }), open)
  // an approval: approving is on the card only — the notification refuses (the card names its refusal) or opens
  assert.deepEqual(PA.askButtons({ kind: 'approval', options: ['승인', '취소'], refusal: '취소' }),
    { buttons: [{ action: 'open', title: '열기' }, { action: 'a0', title: '취소' }], answers: ['취소'] })
  assert.deepEqual(PA.askButtons({ kind: 'login', options: ['a', 'b'], quick: true, refusal: 'b' }), open)
  assert.deepEqual(PA.askButtons({ kind: 'hands' }, { open: 'Open' }).buttons, [{ action: 'open', title: 'Open' }])
})

test('PA-U-08 카드 종류와 알림 글자', () => {
  assert.equal(PA.askKind({ kind: 'choice', content: { approval: true } }), 'approval')
  assert.equal(PA.askKind({ kind: 'choice', content: { vault: true } }), 'login')
  assert.equal(PA.askKind({ kind: 'choice', content: {} }), 'question')
  assert.equal(PA.askKind({ kind: 'vault', content: {} }), 'login')
  assert.equal(PA.askKind({ kind: 'task', content: { need: 'login' } }), 'login')
  assert.equal(PA.askKind({ kind: 'task', content: { need: 'captcha' } }), 'hands')
  assert.equal(PA.askKind({ kind: 'text', content: { ask: {} } }), 'question')
  assert.equal(PA.askText('**어떤 형식**으로   정리할까요?\n- 표'), '어떤 형식으로 정리할까요? - 표')
  assert.equal([...PA.askText('가'.repeat(300))].length, 140)
})

// 보안 검토 11-26 #2: 잠금 화면의 단추 한 번으로 결과가 큰 일을 하지 않는다 — 단추로 답하는 보기는 묻는 쪽이 「가벼운 선택」(quick)으로 표시한
// 것만, 그 밖에는 「열기」와 묻는 쪽이 정한 거절(refusal)뿐. 파일 고르기(올릴 파일)는 승인과 같다
test('PA-U-09 단추는 묻는 쪽이 가볍다고 한 보기만 — 그 밖은 「열기」와 정해진 거절뿐, 파일 고르기는 승인', () => {
  const open = { buttons: [{ action: 'open', title: '열기' }], answers: [] }
  // a question nobody marked: no answer from the lock screen (「보낼까요? [보내기/취소]」)
  assert.deepEqual(PA.askButtons({ kind: 'question', options: ['보내기', '취소'] }), open)
  // …with the asker's refusal: that one only
  assert.deepEqual(PA.askButtons({ kind: 'question', options: ['보내기', '취소'], refusal: '취소' }),
    { buttons: [{ action: 'open', title: '열기' }, { action: 'a0', title: '취소' }], answers: ['취소'] })
  // a refusal that is not one of its options is not offered
  assert.deepEqual(PA.askButtons({ kind: 'question', options: ['보내기', '취소'], refusal: '그만' }), open)
  // marked quick by the asker: the options
  assert.deepEqual(PA.askButtons({ kind: 'question', options: ['세 줄 요약', '표로 정리'], quick: true }).answers, ['세 줄 요약', '표로 정리'])
  assert.deepEqual(PA.askButtons({ kind: 'question', options: ['세 줄 요약', '표로 정리'], quick: 'yes' }), open, 'only true')
  // an approval: its own refusal (the card says which), never the approval
  assert.deepEqual(PA.askButtons({ kind: 'approval', options: ['승인', '취소'], refusal: '취소' }).answers, ['취소'])
  assert.deepEqual(PA.askButtons({ kind: 'approval', options: ['승인', '취소'] }), open, 'no refusal named: open only')
  // (quick on an approval changes nothing: still its refusal alone)
  assert.deepEqual(PA.askButtons({ kind: 'approval', options: ['승인', '취소'], refusal: '취소', quick: true }).answers, ['취소'])
  // a file to upload picked on the card: an approval — open only (its options are file names, none refuses)
  assert.equal(PA.askKind({ kind: 'choice', content: { files: true, options: ['견적서.pdf', '계약서.docx'] } }), 'approval')
  assert.deepEqual(PA.askButtons({ kind: 'approval', options: ['견적서.pdf', '계약서.docx'], quick: true }), open)
})
