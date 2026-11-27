// 메시지를 대화(주제)에 묶는 규칙 — 서버의 lib/conversations.js 가 화면의 src/convOf.js · src/projectTopics.js 와 같은 답을 내는지 (PR #118 검토 2:
// 「이 내용으로 프로젝트 만들자」의 답 · 카드의 자리를 사람이 보는 대로). 모델 · DB 없이.
// Run: node --test test/conversations.test.js
import test from 'node:test'
import assert from 'node:assert/strict'

const S = await import('../lib/conversations.js')
const PAGE = await import('../../src/convOf.js')
const TOPICS = await import('../../src/projectTopics.js')

const t0 = Date.parse('2026-11-28T09:00:00Z')
const at = (s) => new Date(t0 + s * 1000).toISOString()
const MAIN = [
  { id: 'u1', role: 'user', kind: 'text', content: { text: '교육 요청 정리해 줘' }, created_at: at(0) },
  { id: 'a1', role: 'agent', kind: 'doc', content: { text: '# 정리', context: { conversationId: 'c1', action: 'new' } }, created_at: at(5) },
  { id: 'f1', role: 'agent', kind: 'file', content: { name: 'a.md' }, created_at: at(6) },
  { id: 'r1', role: 'agent', kind: 'text', content: { text: '예약 실행', context: { conversationId: 'run-1', action: 'aside' }, scheduleId: 's1' }, created_at: at(10) },
  { id: 'u2', role: 'user', kind: 'text', content: { text: '견적은?' }, created_at: at(12) },
  { id: 'a2', role: 'agent', kind: 'text', content: { text: '그대로', context: { conversationId: 'c2', action: 'stay' } }, created_at: at(14) },
  { id: 'o1', role: 'agent', kind: 'project_offer', content: { text: '카드', context: { conversationId: 'c1', action: 'aside' } }, created_at: at(15) },
  { id: 'u3', role: 'user', kind: 'text', content: { text: '새 이야기' }, created_at: at(20) },
  { id: 'a3', role: 'agent', kind: 'text', content: { text: '새 답', context: { conversationId: 'c3', action: 'new' } }, created_at: at(25) },
  { id: 'd1', role: 'agent', kind: 'divider', content: { text: '주간 보고', scheduleId: 's9' }, created_at: at(30) },
  { id: 'x1', role: 'agent', kind: 'text', content: { text: '옛 실행의 줄' }, created_at: at(32) },
  { id: 'b1', role: 'agent', kind: 'text', content: { text: '브리프', mails: [{ actionId: 'm' }] }, created_at: at(90) },
  { id: 'u4', role: 'user', kind: 'text', content: { text: '아직 답이 없는 말' }, created_at: at(100) },
]
const PROJECT = [
  { id: 'p1', role: 'user', kind: 'text', content: { text: 'A' } },
  { id: 'p2', role: 'agent', kind: 'text', content: { text: 'A 답', conv: 't-a' } },
  { id: 'p3', role: 'user', kind: 'text', content: { text: 'B', conv: 't-b' } },
  { id: 'p4', role: 'agent', kind: 'file', content: { name: 'b.md' } },
  { id: 'p5', role: 'agent', kind: 'text', content: { text: 'B 답', conv: { id: 't-b', title: 'B' } } },
  { id: 'p6', role: 'agent', kind: 'project_offer', content: { conv: 'none:x' } },
  { id: 'p7', role: 'user', kind: 'text', content: { text: '끝' } },
]

test('메인 채팅: 서버와 화면이 같은 답 — 따로 묶인 것 · 「stay」 · 카드 · 옛 실행 · 브리프 · 답이 아직 없는 말', () => {
  const server = S.convOf(MAIN), page = PAGE.convOf(MAIN)
  assert.deepEqual(server, page)
  // (a 「stay」 answer and a card filed aside do not move the chat: 「새 이야기」 is c3's, 「견적은?」 c1's)
  assert.equal(server.a2, 'c1')
  assert.equal(server.o1, 'c1')
  assert.equal(server.u2, 'c1')
  assert.equal(server.r1, 'run-1')
  assert.equal(S.currentConversation(MAIN, server), PAGE.currentConversation(MAIN, page))
  assert.deepEqual(S.convOf(MAIN, { briefId: 'brief-x' }), PAGE.convOf(MAIN, { briefId: 'brief-x' }))
})

test('프로젝트 주제: 서버와 화면이 같은 답', () => {
  assert.deepEqual(S.topicOf(PROJECT), TOPICS.topicOf(PROJECT))
  assert.equal(S.topicOf(PROJECT).p4, 't-a', '카드는 앞의 답의 주제(사람의 말이 옮기지 않음)')
  assert.equal(S.currentTopic(PROJECT, S.topicOf(PROJECT)), 't-b')
})
