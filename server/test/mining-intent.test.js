// 검토 단계 이름은 공유한 문서로 정한다 (2026-11-09 결정 7).
// 역할로 붙이면 한 사람의 검토가 여러 이름으로 흩어져, 같은 업무의 흐름이 까닭 없이 달라진다.
// 문서 형식 → 검토 이름은 업종 지식이라 업무 팩(skills/packs/store-design)이 정한다(2026-11-21 결정 3):
// 팩을 켠 회사에서는 전과 같고, 켜지 않은 회사에서는 그 이름이 하나도 나오지 않는다.
import test from 'node:test'
import assert from 'node:assert/strict'
import { config } from '../config.js'
import { setEnabledPacks } from '../lib/skillInstallCatalog.js'
import { docReview, stepsIn, stepOf, labelIn, labelsOf, reviewLabel, reviewStep, draftStep } from '../lib/mining/catalog.js'

const withPack = (on, fn) => { setEnabledPacks(config.tenantId, on ? ['store-design'] : []); try { return fn() } finally { setEnabledPacks(config.tenantId, []) } }

test('팩을 켠 회사: 공유한 문서의 형식이 검토 이름을 정한다', () => withPack(true, () => {
  assert.equal(docReview(['강남점_평면도.dxf']), '평면도 검토')
  assert.equal(docReview(['제안서.hwpx']), '제안서 검토')
  assert.equal(docReview(['proposal.docx']), '제안서 검토')
  assert.equal(docReview(['견적서.xlsx']), '견적서 검토')
  assert.equal(docReview(['QUOTE.XLSX']), '견적서 검토', '확장자는 대소문자를 가리지 않는다')
  assert.equal(docReview(['quote.xlsx'], 'en'), 'Quote review', '영어 사례는 영어 이름')
}))

test('문서가 없거나 팩이 모르는 형식이면 이름을 정하지 않는다 (사례의 문서·역할로 넘어간다)', () => withPack(true, () => {
  assert.equal(docReview([]), '')
  assert.equal(docReview(['메모.txt']), '')
  assert.equal(docReview([null, undefined]), '')
}))

test('여러 문서를 함께 공유하면 팩이 정한 순서의 앞선 종류로 정한다', () => withPack(true, () => {
  assert.equal(docReview(['견적서.xlsx', '평면도.dxf']), '평면도 검토')
}))

test('문서 기반 검토도 단계 목록에 있어 기록이 버려지지 않는다', () => withPack(true, () => {
  for (const label of ['평면도 검토', '제안서 검토', '견적서 검토']) {
    assert.equal(stepOf(label)?.kind, 'human', label)
    assert.deepEqual(stepOf(label).fields.map((f) => f.key), ['decision', 'comment'])
  }
  for (const label of ['재무 검토', '디자인 검토', '계약 검토', '제안서 검토', '팀원 검토']) assert.ok(stepOf(label), `${label} 가 단계 목록에 있다`)
}))

test('검토 이름도 두 언어로 오간다', () => withPack(true, () => {
  assert.equal(labelIn('평면도 검토', 'en'), 'Floor plan review')
  assert.equal(labelIn('Floor plan review', 'ko'), '평면도 검토')
  assert.equal(labelIn('견적서 검토', 'en'), 'Quote review')
  assert.equal(labelIn('Quote review', 'ko'), '견적서 검토')
  assert.deepEqual(labelsOf('견적서 검토'), ['견적서 검토', 'Quote review'])
}))

test('팩을 켜지 않은 회사: 업종 단계·검토 이름이 하나도 없고, 기본 단계와 문서 이름의 단계만 있다', () => withPack(false, () => {
  assert.equal(docReview(['평면도.dxf', '견적서.xlsx']), '', '형식으로 검토를 정하지 않는다')
  assert.equal(stepOf('평면도 작성'), null)
  assert.equal(stepOf('재무 검토'), null)
  const labels = [...stepsIn('ko'), ...stepsIn('en')].map((s) => s.label)
  assert.deepEqual(labels.sort(), ['Receive request mail', 'Reply to customer', 'Teammate review', '고객 회신', '요청 메일 접수', '팀원 검토'].sort())
  const words = JSON.stringify([...stepsIn('ko'), ...stepsIn('en')])
  assert.doesNotMatch(words, /평면도|견적|제안서|인테리어|floor plan|quote|proposal|interior|CADCraft|캐드크래프트/i)
  // a draft and a review named for the document the mail asked for (the triage's kind), in the case's language
  assert.equal(draftStep('교육 일정표', 'ko', 'xlsx').label, '교육 일정표 작성')
  assert.equal(draftStep('schedule', 'en', 'xlsx').label, 'Write schedule')
  assert.equal(draftStep('schedule', 'en', 'xlsx').tool, 'xlsx')
  assert.equal(reviewLabel('교육 일정표', 'ko'), '교육 일정표 검토')
  assert.equal(reviewStep(reviewLabel('schedule', 'en'), 'en', 'Reviewer').skill, 'team-share-review')
  // a label no catalog knows is kept as recorded
  assert.equal(labelIn('Operations review', 'ko'), 'Operations review')
}))
