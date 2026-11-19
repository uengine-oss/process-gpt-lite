// 제약 이론 안내가 실제로 시간이 새는 단계를 가리키고, 숫자와 문장이 what-if 계산과 맞는가.
// 운영 "계약서 검토"에서 한 사람이 두 단계를 같은 횟수로 맡자 먼저 나온 단계를 제약으로 골랐고,
// 처리 능력은 계산과 달리 늘 2배로 적혔으며, 제약이 첫 단계면 "새 요청의 은(는)" 으로 문장이 깨졌다.
import test from 'node:test'
import assert from 'node:assert/strict'
import { constraintStep, ropeText, predraftCapacity } from '../lib/improve/focus.js'

const run = (activityId, wait, who = '오순영') => ({ activityId, wait, human: true, whoName: who })

test('같은 사람이 같은 횟수로 맡은 단계 중 기다림이 긴 단계를 제약으로 고른다', () => {
  const c = { key: 'person:오순영', stepIds: ['task1', 'task4'] }
  const executions = [
    ...Array.from({ length: 10 }, () => run('task1', 600)),
    ...Array.from({ length: 10 }, () => run('task4', 40 * 86400)),
    run('task1', 99 * 86400, '다른 사람'), // 다른 사람의 기다림은 세지 않는다
  ]
  assert.equal(constraintStep({ executions }, c), 'task4')
})

test('기다림이 같으면 더 자주 맡은 단계를 고른다', () => {
  const c = { key: 'person:오순영', stepIds: ['a', 'b'] }
  assert.equal(constraintStep({ executions: [run('a', 0), run('b', 0), run('b', 0)] }, c), 'b')
})

test('제약이 첫 단계라 앞 단계가 없어도 문장이 깨지지 않는다', () => {
  const t = ropeText({ name: '계약서 등록' }, 2, [])
  assert.ok(!t.includes('의 은(는)'), t)
  assert.match(t, /새 요청은 급한 건부터/)
  assert.match(ropeText({ name: '확인' }, 2, ['계약서 등록']), /새 요청의 계약서 등록은\(는\)/)
})

test('사전 초안의 처리 능력은 what-if 가 계산한 값으로 적는다', () => {
  assert.match(predraftCapacity(0.2015, 0.2687), /0\.2건 → 0\.3건/)
  assert.doesNotMatch(predraftCapacity(0.2015, 0.2687), /0\.4건/)
})
