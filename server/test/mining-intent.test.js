// 검토 단계 이름은 공유한 문서로 정한다 (2026-11-09 결정 7).
// 역할로 붙이면 한 사람의 검토가 계약 검토·재무 검토·제안서 검토로 흩어져, 같은 업무의 흐름이
// 까닭 없이 달라진다. 문서는 누가 보든 같으므로 이름이 흔들리지 않는다.
import test from 'node:test'
import assert from 'node:assert/strict'
import { docReview, DOC_REVIEWS, STEPS, stepOf, labelIn, labelsOf } from '../lib/mining/catalog.js'

test('공유한 문서가 검토 이름을 정한다', () => {
  assert.equal(docReview(['강남점_평면도.dxf']), '평면도 검토')
  assert.equal(docReview(['제안서.hwpx']), '제안서 검토')
  assert.equal(docReview(['proposal.docx']), '제안서 검토')
  assert.equal(docReview(['견적서.xlsx']), '견적서 검토')
  assert.equal(docReview(['QUOTE.XLSX']), '견적서 검토', '확장자는 대소문자를 가리지 않는다')
})

test('문서가 없거나 모르는 형식이면 이름을 정하지 않는다 (역할로 넘어간다)', () => {
  assert.equal(docReview([]), '')
  assert.equal(docReview(['메모.txt']), '')
  assert.equal(docReview([null, undefined]), '')
})

test('여러 문서를 함께 공유하면 목록의 앞선 종류로 정한다', () => {
  // 평면도 → 제안서 → 견적서 순. 한 번의 공유가 한 단계로 남아야 한다
  assert.equal(docReview(['견적서.xlsx', '평면도.dxf']), '평면도 검토')
  assert.deepEqual(DOC_REVIEWS.map((r) => r.label), ['평면도 검토', '제안서 검토', '견적서 검토'])
})

test('문서 기반 검토도 단계 목록에 있어 기록이 버려지지 않는다', () => {
  for (const r of DOC_REVIEWS) {
    assert.ok(STEPS[r.label], `${r.label} 가 단계 목록에 있다`)
    assert.equal(stepOf(r.label).kind, 'human')
    assert.deepEqual(stepOf(r.label).fields.map((f) => f.key), ['decision', 'comment'])
  }
})

test('역할로 붙던 검토 이름은 그대로 남는다 (과거 기록)', () => {
  for (const label of ['재무 검토', '디자인 검토', '계약 검토', '제안서 검토', '팀원 검토']) {
    assert.ok(stepOf(label), `${label} 가 단계 목록에 있다`)
  }
})

test('새 검토 이름도 두 언어로 오간다', () => {
  assert.equal(labelIn('평면도 검토', 'en'), 'Floor plan review')
  assert.equal(labelIn('Floor plan review', 'ko'), '평면도 검토')
  assert.equal(labelIn('견적서 검토', 'en'), 'Quote review')
  assert.equal(labelIn('Quote review', 'ko'), '견적서 검토')
  assert.deepEqual(labelsOf('견적서 검토'), ['견적서 검토', 'Quote review'])
})
