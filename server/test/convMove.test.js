// 대화를 프로젝트로 옮기기 — 순수한 부분(모델 · DB 없이). 스펙 openspec/specs/thread-to-project, 서버 lib/conversationMove.js, 화면 src/convMove.js ·
// src/projectTopics.js. 사람 · 회사는 지어낸 것이다(정하윤 · 김서연 · 박도윤 · 최유나, 가나정밀).
//   TM-U-01 옮겨 온 메시지는 자기 주제로만 묶이고, 프로젝트의 다른 메시지를 끌고 가지 않는다(서버와 화면이 같은 답)
//   TM-U-02 채팅에서 그 대화의 메시지를 고르는 규칙은 화면과 같다(idsOf = src/convOf.js) · 이름 · 종류 · 프로젝트 열쇠
//   TM-U-03 옮기기 전 알림 · 구성원 줄 · 옮긴 뒤 줄(받침에 맞는 조사)
// Run: node --test test/convMove.test.js
import test from 'node:test'
import assert from 'node:assert/strict'

const CV = await import('../lib/conversations.js')
const CM = await import('../lib/conversationMove.js')
const PAGE = await import('../../src/convOf.js')
const TOPICS = await import('../../src/projectTopics.js')
const W = await import('../../src/convMove.js')

const at = (s) => new Date(Date.UTC(2026, 10, 28, 9, 0, s)).toISOString()
// a project's room after 「교육 요청 조사」 moved in: its old lines (moved) between the project's own, then the chip about the move
const ROOM = [
  { id: 'm1', role: 'user', kind: 'text', content: { text: '받은 메일의 교육 요청 조사해 줘', conv: 'conv-a', moved: { conv: 'conv-a' } }, created_at: at(1) },
  { id: 'm2', role: 'agent', kind: 'doc', content: { text: '교육안', conv: 'conv-a', context: { conversationId: 'conv-a', action: 'new', title: '교육 요청 조사' }, moved: { conv: 'conv-a' } }, created_at: at(2) },
  // the project's own line, between the moved ones in time (no sub-topic: a project from before sub-topics)
  { id: 'p1', role: 'agent', kind: 'text', content: { text: '프로젝트의 계획을 채웠어요' }, created_at: at(3) },
  { id: 'm3', role: 'agent', kind: 'file', content: { name: '교육안.md', conv: 'conv-a', moved: { conv: 'conv-a' } }, created_at: at(4) },
  { id: 'p2', role: 'user', kind: 'text', content: { text: '프로젝트에서 한 말' }, created_at: at(5) },
  { id: 'p3', role: 'agent', kind: 'text', content: { text: '프로젝트의 답' }, created_at: at(6) },
  { id: 'n1', role: 'agent', kind: 'chip', content: { text: '채팅에서 옮겨 온 대화예요', conv: 'conv-a', moved: { note: true, conv: 'conv-a' } }, created_at: at(7) },
  // asked afterwards in that sub-topic (the page sent it there): the person's message is tagged, the answer carries it
  { id: 'q1', role: 'user', kind: 'text', content: { text: '이어서 2일차 실습 목록', conv: 'conv-a' }, created_at: at(8) },
  { id: 'q2', role: 'agent', kind: 'text', content: { text: '실습 목록', conv: 'conv-a' }, created_at: at(9) },
  { id: 'q3', role: 'agent', kind: 'file', content: { name: '실습.md' }, created_at: at(10) },
]

test('TM-U-01 옮겨 온 메시지는 자기 주제로만 묶이고, 프로젝트의 다른 메시지를 끌고 가지 않는다(서버 = 화면)', () => {
  const server = CV.topicOf(ROOM), page = TOPICS.topicOf(ROOM)
  assert.deepEqual(server, page)
  for (const id of ['m1', 'm2', 'm3', 'n1', 'q1', 'q2']) assert.equal(server[id], 'conv-a', id)
  // the project's own lines between the moved ones stay where they were (none: 「전체」 only)
  for (const id of ['p1', 'p2', 'p3']) assert.equal(server[id], null, id)
  // a card after an answer asked there goes with that answer, as before
  assert.equal(server.q3, 'conv-a')
  const list = TOPICS.topicList([{ id: 'conv-a', title: '교육 요청 조사', updated_at: at(9) }], ROOM)
  assert.deepEqual(list.map((x) => [x.id, x.count]), [['conv-a', 7]])
})

// the main chat: two conversations interleaved, a card filed aside, a brief, a scheduled run's line
const MAIN = [
  { id: 'u1', role: 'user', kind: 'text', content: { text: '교육 요청 조사해 줘' }, created_at: at(1) },
  { id: 'a1', role: 'agent', kind: 'doc', content: { text: '교육안', context: { conversationId: 'conv-a', action: 'new', title: '교육 요청 조사' } }, created_at: at(2) },
  { id: 'f1', role: 'agent', kind: 'file', content: { name: '교육안.md' }, created_at: at(3) },
  { id: 'u2', role: 'user', kind: 'text', content: { text: '주간 회의록 정리' }, created_at: at(4) },
  { id: 'b1', role: 'agent', kind: 'text', content: { text: '회의록', context: { conversationId: 'conv-b', action: 'new', title: '주간 회의록' } }, created_at: at(5) },
  { id: 'c1', role: 'agent', kind: 'conv_move', content: { text: '옮길까요?', context: { conversationId: 'conv-a', action: 'aside' } }, created_at: at(6) },
  { id: 'u3', role: 'user', kind: 'text', content: { text: '교육안 2일차 더' }, created_at: at(7) },
  { id: 'a2', role: 'agent', kind: 'text', content: { text: '2일차', context: { conversationId: 'conv-a', action: 'continue' } }, created_at: at(8) },
  { id: 's1', role: 'agent', kind: 'text', content: { text: '예약 실행', context: { conversationId: 'sched-x', action: 'aside', kind: 'schedule', title: '주간 시장 동향' } }, created_at: at(9) },
]

test('TM-U-02 채팅에서 그 대화의 메시지를 고르는 규칙은 화면과 같다 · 이름 · 종류 · 프로젝트 열쇠', () => {
  const page = PAGE.convOf(MAIN)
  const ids = CM.idsOf(MAIN, 'conv-a')
  assert.deepEqual(ids, MAIN.filter((m) => page[m.id] === 'conv-a').map((m) => m.id))
  assert.deepEqual(ids, ['u1', 'a1', 'f1', 'c1', 'u3', 'a2'])
  assert.deepEqual(CM.idsOf(MAIN, 'conv-b'), ['u2', 'b1'])
  // its name: the row's, else the router's call on one of its messages; a conversation of its own says its kind
  assert.equal(CM.titleOf({ title: '행의 이름' }, MAIN, 'conv-a'), '행의 이름')
  assert.equal(CM.titleOf(null, MAIN, 'conv-a'), '교육 요청 조사')
  assert.equal(CM.kindOf(null, MAIN, 'sched-x'), 'schedule')
  assert.equal(CM.kindOf(null, MAIN, 'conv-a'), 'conversation')
  assert.equal(CM.kindOf({ kind: 'brief' }, MAIN, 'x'), 'brief')
  assert.ok(CM.STANDING.includes('schedule') && CM.STANDING.includes('brief'))
  // the project a scoped key names — only under this person's own key
  assert.equal(CM.projectOfKey('u-1/project/p-9', 'u-1'), 'p-9')
  assert.equal(CM.projectOfKey('u-2/project/p-9', 'u-1'), null)
})

test('TM-U-03 옮기기 전 알림 · 구성원 줄 · 옮긴 뒤 줄', () => {
  assert.equal(W.moveNotice({ count: 22, project: '가나정밀 1차 교육' }),
    '옮기면 이 대화(메시지 22개)는 프로젝트 「가나정밀 1차 교육」에서만 볼 수 있어요. 채팅 목록과 전체 대화에서는 사라져요.')
  assert.match(W.moveNewNotice({ count: 5 }), /메시지 5개/)
  assert.equal(W.membersLine({ folder: '영업 자료', members: [{ name: '김서연' }, { name: '박도윤' }] }),
    '이 프로젝트는 공유 폴더 「영업 자료」를 사용해요. 옮긴 뒤 이 대화에서 만드는 파일은 프로젝트 구성원 2명(김서연 · 박도윤)도 볼 수 있어요.')
  assert.match(W.membersLine({ folder: 'F', members: [{ name: '가' }, { name: '나' }, { name: '다' }, { name: '라' }, { name: '마' }] }), /구성원 5명\(가 · 나 · 다 외 2명\)/)
  // 으로 · 로: by the name's last sound
  assert.equal(W.movedNotice('가나정밀 1차 교육'), '프로젝트 「가나정밀 1차 교육」으로 옮겼어요 · 채팅 목록에서는 빠졌어요')
  assert.equal(W.movedNotice('영업 자료 정리'), '프로젝트 「영업 자료 정리」로 옮겼어요 · 채팅 목록에서는 빠졌어요')
  assert.equal(W.followedNotice('규정 검토 회의'), '이 대화는 프로젝트 「규정 검토 회의」로 옮겼어요')
  assert.equal(W.followedNotice('사내 교육 과정'), '이 대화는 프로젝트 「사내 교육 과정」으로 옮겼어요')
  assert.equal(W.projectLine({ folder: { name: '영업 자료' } }), '공유 폴더 「영업 자료」')
  assert.equal(W.projectLine({ folder: { name: '교육 과정 템플릿', workspace: true } }), '템플릿 「교육 과정 템플릿」의 전용 작업 공간')
  assert.equal(W.projectLine({ folder: null }), '')
})

// (PR #125 검토 1 · 3 · 6)
test('TM-U-04 따로 묶인 줄도 자기 주제로만(서버 = 화면) · 대화를 아직 모르는 턴은 바쁨 · 일하는 브라우저 작업은 바쁨', () => {
  const room = [
    { id: 'a1', role: 'agent', kind: 'text', content: { text: '프로젝트의 답', conv: 'own' }, created_at: at(1) },
    { id: 'm1', role: 'agent', kind: 'text', content: { text: '답장을 보냈어요', conv: 'conv-x', context: { conversationId: 'conv-x', action: 'aside' } }, created_at: at(2) },
    { id: 'p1', role: 'agent', kind: 'chip', content: { text: '프로젝트 계획을 채웠어요', planChange: { backfill: true } }, created_at: at(3) },
  ]
  const server = CV.topicOf(room), page = TOPICS.topicOf(room)
  assert.deepEqual(server, page)
  assert.equal(server.m1, 'conv-x')
  assert.equal(server.p1, 'own', '따로 묶인 줄은 다음 줄을 끌고 가지 않음')
  const t = (conv, finished = false) => ({ conv, finished })
  assert.equal(CM.busyTurn([t(null)], 'conv-x'), true, '대화를 아직 모름')
  assert.equal(CM.busyTurn([t('none:abc')], 'conv-x'), true)
  assert.equal(CM.busyTurn([t('conv-x')], 'conv-x'), true)
  assert.equal(CM.busyTurn([t('conv-y')], 'conv-x'), false)
  assert.equal(CM.busyTurn([t(null, true)], 'conv-x'), false)
  const rows = [{ id: 'k1', kind: 'task', content: { state: 'running' } }, { id: 'k2', kind: 'task', content: { state: 'done' } }]
  assert.equal(CM.busyTask(rows, ['k1']), true)
  assert.equal(CM.busyTask(rows, ['k2']), false)
  for (const st of ['queued', 'needs_input']) assert.equal(CM.busyTask([{ id: 'k', kind: 'task', content: { state: st } }], ['k']), true, st)
})
