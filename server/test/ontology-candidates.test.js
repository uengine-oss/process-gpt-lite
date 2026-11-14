// AI 후보(design-v0.3 §24, lib/ontology/candidates.js): 사람이 꼭 해야 하는 일을 규칙으로 찾고(이름의 낱말 · 승인 비율), 모델 판단과 합친다. 모델 없이.
import test from 'node:test'
import assert from 'node:assert/strict'
import { humanByRule, mergeHuman, scoreOf } from '../lib/ontology/candidates.js'
import { defaultRules } from '../lib/ontology/discovery.js'

const H = defaultRules().candidates.human
test('규칙: 이름의 낱말(계약 · 급여)과 승인 비율로 사람이 꼭 해야 하는 일을 찾는다', () => {
  assert.deepEqual(humanByRule({ name: '계약 체결', acts: { notify: 2 } }, H).map((x) => x.key), ['legal'])
  assert.deepEqual(humanByRule({ name: '급여대장 작성', acts: {} }, H).map((x) => x.key), ['money'])
  assert.deepEqual(humanByRule({ name: '레포 권한 요청', acts: { request: 5, approve: 5 } }, H).map((x) => x.key), ['approval'])
  assert.deepEqual(humanByRule({ name: '업무 계획 공유', acts: { notify: 100, approve: 2 } }, H), [])
})
test('합치기: 규칙과 모델이 같으면 both, 규칙만 걸린 것(낱말만 겹침)은 버리고, 모델만 본 것은 model', () => {
  const rule = humanByRule({ name: '계약서 양식 공유', acts: { notify: 3 } }, H)
  assert.equal(rule[0].key, 'legal')
  assert.deepEqual(mergeHuman(rule, [], H.kinds), [])
  assert.equal(mergeHuman(rule, ['legal'], H.kinds)[0].by, 'both')
  const m = mergeHuman([], ['money', 'nope'], H.kinds)
  assert.equal(m.length, 1); assert.equal(m[0].by, 'model'); assert.equal(m[0].name, '돈이 나가는 일')
})
test('먼저 볼 순서: 맡길 수 있는 정도 × 한 달 횟수', () => {
  assert.ok(scoreOf('high', 10) > scoreOf('mid', 10))
  assert.ok(scoreOf('mid', 30) > scoreOf('high', 10))
  assert.equal(scoreOf('none', 100), 0)
})
