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

// 판정(2026-11-24 녹화): 제안된 줄기 안의 건은 판정 모델이 「같은 한 건의 일」이라고 본 무리에만 든다. 가짜 판정기로.
import { groupBySameWork, caseCard } from '../lib/ontology/streams.js'
const day0 = Date.UTC(2026, 9, 1)
const kase = (id, d, topic) => ({ id, from: day0 + d * 86_400_000, to: day0 + d * 86_400_000, topic, tasks: [], subjects: new Set([topic]), partners: new Set(), roles: new Set(), texts: [] })
// same topic → same work (0.95), else 0.05; 'down' → no reading
const fake = (c, shown) => (c.topic === 'down' ? null : shown.every((x) => x.topic === c.topic) ? 0.95 : 0.05)

test('같은 줄기로 제안돼도 다른 일(교육 안내)은 무리에 들지 않고 혼자 남는다', async () => {
  const { groups, ps } = await groupBySameWork([kase('q1', 0, 'hb27'), kase('edu', 9, 'edu'), kase('q2', 20, 'hb27')], fake)
  const of = (id) => groups.find((g) => g.cases.some((c) => c.id === id))
  assert.equal(of('q1'), of('q2'))
  assert.equal(of('edu').cases.length, 1)
  assert.ok(ps.get('edu') < 0.7)
})

test('줄기의 첫 건은 견줄 무리가 없어 판정하지 않는다 — 「판정 못 함」이 아니다', async () => {
  const { joined, unread } = await groupBySameWork([kase('a', 0, 'x'), kase('b', 3, 'y'), kase('c', 5, 'down')], fake)
  assert.equal(unread.has('a'), false)
  assert.equal(joined.has('a'), false)
  assert.equal(unread.has('b'), false)
  assert.equal(unread.has('c'), true)
})

test('같은 고객의 다른 회차(매달 보고)는 따로 무리 — 회차마다 한 건', async () => {
  const { groups } = await groupBySameWork([kase('m8', 0, 'aug'), kase('m9', 30, 'sep'), kase('m10', 60, 'oct')], fake)
  assert.equal(groups.length, 3)
})

test('전에 정해진 무리에 새 건이 들고, 판정을 못 하면(모델 꺼짐) 아무 데도 들지 않는다', async () => {
  const settled = [{ name: '한빛 견적', cases: [kase('a', 0, 'hanbit')] }]
  const { groups, ps } = await groupBySameWork([kase('b', 5, 'hanbit'), kase('x', 6, 'down')], fake, { groups: settled })
  assert.deepEqual(groups[0].cases.map((c) => c.id), ['a', 'b'])
  assert.equal(groups[0].settled, true)
  assert.equal(ps.get('x'), null)
  assert.equal(groups.find((g) => g.cases.some((c) => c.id === 'x')).cases.length, 1)
})

test('판정 모델에 보이는 건: 날짜 · 상대 · 일 · 제목 · 내용', () => {
  const c = { ...kase('q', 0, '한빛디스플레이 27년 유지보수 견적 요청'), partners: new Set(['hanbit-display.example']), tasks: ['견적서 작성'], texts: ['27년 유지보수 견적 요청드립니다'] }
  assert.equal(caseCard(c), '2026-10-01 · 상대 hanbit-display.example · 일 견적서 작성 · 제목 한빛디스플레이 27년 유지보수 견적 요청 · 내용 "27년 유지보수 견적 요청드립니다"')
})
