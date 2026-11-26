// 메일을 대화방에 — 모델 · DB 없이 (2026-11-27 「메일이 왔을때 그걸 대화방에 공유하는 기능도 필요.」). 스펙 openspec/specs/mail-room-share.
//   - 「앞으로 … 메일도 이 방에」 고르기: 스레드(있을 때) · 보낸 사람 · 회사(메일 서비스 도메인은 아님), 먼저 보이는 것은 회사 → 보낸 사람
//   - 들어온 메일을 약속이 받는가: 같은 스레드 · 같은 주소(대소문자 무관) · 같은 회사(하위 도메인 포함), 다른 회사 · 비슷한 이름은 아님
//   - 방 순서: 이 스레드를 올린 방 > 같은 보낸 사람 > 같은 회사 > 메일을 같이 받은 사람이 있는 방 > 판정 모델이 고른 방, 나머지는 원래 순서
//   - 판정이 읽는 것: 방 이름 · 사람(나 빼고) · 최근 메시지, 메일은 자료(본문 앞부분만)
// Run: node --test test/mailRooms.test.js
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.PRO_BACKGROUND = '0'
const R = await import('../lib/mailRooms.js')
const PERSONAL = ['gmail.com', 'naver.com']

test('약속 고르기: 스레드(있을 때) · 보낸 사람 · 회사 — 메일 서비스 도메인은 회사가 아니다, 먼저 보이는 것은 회사', () => {
  const c = R.ruleChoices({ from: '김하늘 <Haneul@Ace-Precision.example>', threadId: 'thr-77' }, { personalDomains: PERSONAL })
  assert.deepEqual(c.map((x) => [x.by, x.key]), [['thread', 'thr-77'], ['sender', 'haneul@ace-precision.example'], ['domain', 'ace-precision.example']])
  assert.equal(c[1].label, '김하늘(haneul@ace-precision.example)에게서 오는 메일')
  assert.equal(c[1].name, '김하늘')
  assert.equal(c[2].label, 'ace-precision.example에서 오는 메일')
  assert.equal(R.firstChoice(c).by, 'domain')
  // a mail service: the sender only (no thread in this mailbox)
  const g = R.ruleChoices({ from: 'someone@gmail.com' }, { personalDomains: PERSONAL })
  assert.deepEqual(g.map((x) => x.by), ['sender'])
  assert.equal(g[0].label, 'someone@gmail.com에게서 오는 메일')
  assert.equal(R.firstChoice(g).by, 'sender')
  assert.deepEqual(R.ruleChoices({ from: '' }), [])
  assert.equal(R.firstChoice([]), null)
})

test('들어온 메일을 약속이 받는가: 같은 스레드 · 같은 주소 · 같은 회사(하위 도메인도) — 다른 회사 · 비슷한 이름은 아니다', () => {
  const thread = { by: 'thread', key: 'thr-77' }, sender = { by: 'sender', key: 'haneul@ace-precision.example' }, company = { by: 'domain', key: 'ace-precision.example' }
  assert.ok(R.ruleTakes(thread, { from: 'x@y.example', thread: 'thr-77' }))
  assert.ok(!R.ruleTakes(thread, { from: 'x@y.example', thread: 'thr-78' }))
  assert.ok(!R.ruleTakes(thread, { from: 'x@y.example' }), '스레드가 없는 메일함')
  assert.ok(R.ruleTakes(sender, { from: '김하늘 <HANEUL@ace-precision.example>' }))
  assert.ok(!R.ruleTakes(sender, { from: '이준호 <junho@ace-precision.example>' }))
  assert.ok(R.ruleTakes(company, { from: '이준호 <junho@ace-precision.example>' }))
  assert.ok(R.ruleTakes(company, { from: 'ops@mail.ace-precision.example' }), '하위 도메인')
  assert.ok(!R.ruleTakes(company, { from: 'a@notace-precision.example' }), '이름이 비슷한 다른 회사')
  assert.ok(!R.ruleTakes(company, { from: 'a@ace-precision.example.evil.example' }))
  assert.ok(!R.ruleTakes({ by: 'anything', key: 'x' }, { from: 'x@x' }))
  assert.ok(!R.ruleTakes(null, { from: 'x@x' }))
})

test('내 회사 도메인은 「같은 회사」가 아니다 — 약속에도 까닭에도(인사 · 급여 메일까지 방으로 가지 않게), 하위 도메인도', () => {
  const own = ['uengine.org']
  assert.deepEqual(R.ruleChoices({ from: '동료 <colleague@uengine.org>' }, { personalDomains: PERSONAL, ownDomains: own }).map((x) => x.by), ['sender'])
  assert.deepEqual(R.ruleChoices({ from: 'hr@mail.uengine.org' }, { personalDomains: PERSONAL, ownDomains: own }).map((x) => x.by), ['sender'])
  assert.deepEqual(R.ruleChoices({ from: 'a@ace-precision.example' }, { personalDomains: PERSONAL, ownDomains: own }).map((x) => x.by), ['sender', 'domain'])
  assert.equal(R.firstChoice(R.ruleChoices({ from: 'colleague@uengine.org' }, { ownDomains: own })).by, 'sender')
  const me = { id: 'me', email: 'me@uengine.org' }
  const out = R.rankRooms([{ id: 'a', members: [] }, { id: 'b', members: [] }], { me, mail: { from: 'colleague@uengine.org' }, posts: [{ room: 'b', address: 'other@uengine.org', domain: 'uengine.org' }], ownDomains: own })
  assert.deepEqual(out.map((r) => r.suggested), [false, false])
  assert.ok(R.isOwn('x.uengine.org', own) && !R.isOwn('notuengine.org', own) && !R.isOwn('', own))
})

test('약속의 말: 주인의 시트에는 주소까지, 방에 가는 말에는 이름이나 도메인만(주소 없음) · 보여 줄 때 그 말로', async () => {
  const sender = { by: 'sender', key: 'haneul@ace-precision.example', name: '김하늘' }
  assert.equal(R.ruleLabel(sender), '김하늘(haneul@ace-precision.example)에게서 오는 메일')
  assert.equal(R.ruleLabel(sender, { room: true }), '김하늘에게서 오는 메일')
  assert.equal(R.ruleLabel({ by: 'sender', key: 'ops@ace-precision.example' }, { room: true }), 'ace-precision.example에게서 오는 메일')
  assert.equal(R.autoNote(sender), '김하늘에게서 오는 메일은 이 방에 올리기로 했어요.')
  assert.ok(!R.autoNote(sender).includes('@'))
  assert.equal(R.autoNote({ by: 'domain', key: 'ace-precision.example' }), 'ace-precision.example에서 오는 메일은 이 방에 올리기로 했어요.')
  assert.equal(R.autoNote({ by: 'thread', key: 'thr-1' }), '이 메일 스레드의 다음 메일은 이 방에 올리기로 했어요.')
  const { withLang } = await import('../lib/lang.js')
  assert.equal(await withLang('en', () => R.autoNote(sender)), 'Mail from 김하늘 goes to this room, as set.')
  assert.equal(await withLang('en', () => R.autoNote({})), 'This mail goes to this room, as set.')
})

test('방 순서: 스레드 > 보낸 사람 > 회사 > 같이 받은 사람 > 판정, 저마다 까닭 — 나머지는 원래(최근) 순서, 나는 같이 받은 사람이 아니다', () => {
  const me = { id: 'me', email: 'me@lite.example' }
  const room = (id, members = []) => ({ id, title: id, kind: 'group', members: [{ id: 'me', name: '정하윤', email: 'me@lite.example' }, ...members] })
  const rooms = [room('recent'), room('judge'), room('cc', [{ id: 'k', name: '김서연', email: 'seoyeon@lite.example' }]), room('company'), room('sender'), room('thread')]
  const posts = [{ room: 'thread', address: 'other@ace-precision.example', domain: 'ace-precision.example', thread: 'thr-77' },
    { room: 'sender', address: 'haneul@ace-precision.example', domain: 'ace-precision.example', thread: null },
    { room: 'company', address: 'junho@ace-precision.example', domain: 'ace-precision.example', thread: null }]
  const mail = { from: '김하늘 <haneul@ace-precision.example>', to: ['me@lite.example'], cc: ['김서연 <SeoYeon@lite.example>'], threadId: 'thr-77' }
  const out = R.rankRooms(rooms, { me, mail, posts, picks: [{ key: 'judge', p: 0.71 }], personalDomains: PERSONAL })
  assert.deepEqual(out.map((r) => r.id), ['thread', 'sender', 'company', 'cc', 'judge', 'recent'])
  assert.deepEqual(out.map((r) => r.suggested), [true, true, true, true, true, false])
  assert.equal(out[0].why[0].text, '이 메일 스레드를 올린 방')
  assert.equal(out[1].why[0].text, '지난번에도 김하늘 메일을 올린 방')
  assert.equal(out[2].why[0].text, '지난번에도 ace-precision.example 메일을 올린 방')
  assert.equal(out[3].why[0].text, '메일을 같이 받은 김서연님이 있어요')
  assert.deepEqual([out[4].why[0].kind, out[4].p], ['judge', 0.71])
  assert.deepEqual(out[5].why, [])
  // a mail service's domain says nothing: another gmail sender's room is not 「같은 회사」
  const g = R.rankRooms([room('a'), room('b')], { me, mail: { from: 'x@gmail.com' }, posts: [{ room: 'b', address: 'y@gmail.com', domain: 'gmail.com' }], personalDomains: PERSONAL })
  assert.deepEqual(g.map((r) => [r.id, r.suggested]), [['a', false], ['b', false]])
})

test('판정이 읽는 것: 방 이름 · 사람(나 빼고) · 최근 메시지, 메일은 보낸 사람 · 제목 · 첨부 · 본문 앞부분(자료)', () => {
  const label = R.roomLabel({ title: '에이스정밀 납품', members: [{ id: 'me', name: '정하윤' }, { id: 'k', name: '김서연' }, { id: 'p', name: '박도윤' }], last: { body: '3분기 납품 일정 정리했어요' } }, { id: 'me' })
  assert.equal(label, '「에이스정밀 납품」 · 사람: 김서연, 박도윤 · 최근 메시지: "3분기 납품 일정 정리했어요"')
  const st = R.mailState({ source: { subject: '견적 요청' } }, { from: '김하늘 <haneul@ace-precision.example>', subject: '3분기 부품 견적 요청드립니다', attachments: [{ name: '부품목록.xlsx' }], text: 'a'.repeat(900) }, 800)
  assert.match(st, /보낸 사람: 김하늘 <haneul@ace-precision\.example>/)
  assert.match(st, /첨부: 부품목록\.xlsx/)
  assert.equal(st.match(/본문 앞부분: "(a+)"/)[1].length, 800)
})
