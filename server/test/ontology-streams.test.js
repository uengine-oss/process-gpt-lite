// 건 이어 묶기(design-v0.3 §22, lib/ontology/streams.js): AI 가 정한 줄기(같은 고객 · 프로젝트 · 목적)를 덩어리로 — 줄기 안에서
// 오래 끊기면 다음 덩어리, 루틴(줄기 없음)은 묶지 않는다. 모델 없이.
import test from 'node:test'
import assert from 'node:assert/strict'
import { chunksOf } from '../lib/ontology/streams.js'

test('줄기 안의 건은 한 덩어리, gapDays 넘게 끊기면 다음 덩어리, 줄기 없는 건(루틴)은 그대로', () => {
  const d = (n) => Date.UTC(2026, 8, 1) + n * 86_400_000
  const c = chunksOf([
    { id: 'a', from: d(0), to: d(2), stream: '한빛 견적' }, { id: 'b', from: d(10), to: d(12), stream: '한빛 견적' },
    { id: 'c', from: d(80), to: d(81), stream: '한빛 견적' }, { id: 'r', from: d(1), to: d(1), stream: null },
    { id: 'x', from: d(3), to: d(4), stream: '경남대 강의' },
  ], 45)
  assert.equal(c.get('a'), c.get('b'))
  assert.notEqual(c.get('c'), c.get('a'))
  assert.equal(c.has('r'), false)
  assert.notEqual(c.get('x'), c.get('a'))
  assert.match(c.get('a'), /^stream:[0-9a-f]{12}:2026-09-01$/)
})
