// Quick replies are fields, not words (docs/mobile-review-1121/skill-routing-design.md 5.4): the choices the
// server stored with an answer (content.choices — the router's ask, the agent's own question, a process
// draft's "go ahead") are the buttons; an answer's bullet lines never are. src/replies.js — no page.
import test from 'node:test'
import assert from 'node:assert/strict'
import { choicesOf } from '../../src/replies.js'

const agent = (content) => ({ role: 'agent', kind: 'text', content })

test('저장된 선택지가 버튼 — 순서(index)와 설명(hint)을 그대로', () => {
  const c = choicesOf(agent({ text: '어느 작업으로 할까요?', choices: [{ label: '환율 변동 감시', skill: 'schedule-run-now', args: { schedule: 'a3f1c9e2' } }, { label: '아침 뉴스 요약', hint: '매일 7시' }] }))
  assert.deepEqual(c, [{ label: '환율 변동 감시', hint: undefined, index: 0 }, { label: '아침 뉴스 요약', hint: '매일 7시', index: 1 }])
})

test('글머리 목록이 있어도 선택지 필드가 없으면 버튼이 아님 — 어떤 말로 끝나든', () => {
  assert.equal(choicesOf(agent({ text: '흐름 초안을 만들었어요.\n이대로 진행할까요?\n- 네\n- 아니요' })), null)
  assert.equal(choicesOf(agent({ text: 'Done.\n- added the row\n- shared it' })), null)
})

test('멈춘 답 · 사람 메시지 · 빈 선택지는 버튼이 없음, 이름 없는 항목은 빠짐', () => {
  assert.equal(choicesOf(agent({ text: 'x', choices: [{ label: 'A' }], stopped: true })), null)
  assert.equal(choicesOf({ role: 'user', kind: 'text', content: { text: 'x', choices: [{ label: 'A' }] } }), null)
  assert.equal(choicesOf(agent({ text: 'x', choices: [] })), null)
  assert.deepEqual(choicesOf(agent({ text: 'x', choices: [{ label: ' ' }, { label: 'B' }] })).map((o) => [o.label, o.index]), [['B', 1]])
})
