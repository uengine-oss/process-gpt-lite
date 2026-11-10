// 관리자가 확정한 프로세스 정의 (2026-11-10, lib/mining/boundary.js).
// 빈도는 필수·옵션의 초안이고 확정은 관리자가 한다. 관리자에게 보인 추천은 관리자 확인 없이 바뀌지 않고,
// 같은 업무의 새 사례는 제안으로 온다.
import test from 'node:test'
import assert from 'node:assert/strict'
import { boundaryOf, boundaryOrder, draftOf, findCase, findCases, findStep, findSuggestion, keepFound, proposalOf, requiredOf, sameCases, stepsView } from '../lib/mining/boundary.js'

const OPT = { kind: 'optional', skip_when: '견적 합계가 5천만 원 미만이면' }
const INTAKE = '요청 메일 접수', QUOTE = '견적서 작성', FINANCE = '재무 검토', CONTRACT = '계약 검토', REPLY = '고객 회신'

// 넷 중 셋이 재무 검토를 거친 추천 (빈도로는 재무 검토가 필수 초안)
const pattern = {
  category: '행사 견적',
  case_ids: ['c1', 'c2', 'c3', 'c4'], case_count: 4,
  core_activities: [INTAKE, QUOTE, FINANCE, REPLY],
  core_by_frequency: [INTAKE, QUOTE, FINANCE, REPLY],
  frequency: { [INTAKE]: 4, [QUOTE]: 4, [REPLY]: 4, [FINANCE]: 3, [CONTRACT]: 1 },
  main_variant: [INTAKE, QUOTE, FINANCE, REPLY],
  variants: [{ trace: [INTAKE, QUOTE, FINANCE, REPLY], count: 3 }, { trace: [INTAKE, QUOTE, CONTRACT, REPLY], count: 1 }],
}

test('빈도는 초안: 확정이 없으면 만들 때의 필수 단계를 따른다', () => {
  assert.deepEqual(requiredOf(pattern, {}), [INTAKE, QUOTE, FINANCE, REPLY])
  assert.deepEqual(draftOf(pattern), [INTAKE, QUOTE, FINANCE, REPLY])
})

test('관리자가 확정한 값이 빈도 초안을 덮는다', () => {
  const confirmed = { [FINANCE]: OPT, [CONTRACT]: 'required' }
  assert.deepEqual(requiredOf(pattern, confirmed), [INTAKE, QUOTE, REPLY, CONTRACT])
  const v = Object.fromEntries(stepsView(pattern, confirmed).map((x) => [x.activity, x]))
  assert.deepEqual(v[FINANCE], { activity: FINANCE, cases: 3, total: 4, draft: 'required', kind: 'optional', skip_when: '', by: 'admin' })
  assert.deepEqual(v[CONTRACT], { activity: CONTRACT, cases: 1, total: 4, draft: 'optional', kind: 'required', skip_when: '', by: 'admin' })
  assert.equal(v[INTAKE].by, 'frequency')
})

test('조건 없는 옵션은 아무것도 바꾸지 않는다 (BPMN 에 건너뛰는 길이 생기지 않으므로 필수 그대로)', () => {
  assert.deepEqual(requiredOf(pattern, { [FINANCE]: 'optional' }), [INTAKE, QUOTE, FINANCE, REPLY])
})

test('경계에는 확정한 필수 단계, 근거 사례, 뺀 사례가 실린다', () => {
  const b = boundaryOf({ pattern_key: 'k1', pattern, confirmed: { [FINANCE]: OPT }, excluded: ['x9'] })
  assert.deepEqual(b, { key: 'k1', category: '행사 견적', core_activities: [INTAKE, QUOTE, REPLY], case_ids: ['c1', 'c2', 'c3', 'c4'], exclude: ['x9'] })
})

test('결정된 추천이 결정 순으로 먼저, 결정되지 않은 추천은 만든 순으로 뒤에', () => {
  const rows = [
    { pattern_key: 's2', status: 'suggested', created_at: '2026-11-03' },
    { pattern_key: 'r2', status: 'registered', decided_at: '2026-11-05', created_at: '2026-11-01' },
    { pattern_key: 's1', status: 'suggested', created_at: '2026-11-02' },
    { pattern_key: 'h1', status: 'held', decided_at: '2026-11-04', created_at: '2026-11-04' },
  ]
  assert.deepEqual(boundaryOrder(rows).map((r) => r.pattern_key), ['h1', 'r2', 's1', 's2'])
})

// 마이너가 돌려준 묶음: 근거 사례 넷은 그대로, 같은 업무 둘이 새로 붙음
const found = {
  ...pattern, key: 'k1', decided_key: 'k1',
  new_case_ids: ['n1', 'n2'],
  proposed: {
    case_ids: ['c1', 'c2', 'c3', 'c4', 'n1', 'n2'], case_count: 6,
    variants: [{ trace: [INTAKE, QUOTE, FINANCE, REPLY], count: 3 }, { trace: [INTAKE, QUOTE, REPLY], count: 2 }, { trace: [INTAKE, QUOTE, CONTRACT, REPLY], count: 1 }],
    frequency: { [INTAKE]: 6, [QUOTE]: 6, [REPLY]: 6, [FINANCE]: 3, [CONTRACT]: 1, '디자인 검토': 0 },
    core_by_frequency: [INTAKE, QUOTE, REPLY],
  },
}

test('이미 보인 추천에 새 사례가 붙어도 근거와 필수 단계는 그대로, 새 사례는 제안으로', () => {
  const row = { pattern_key: 'k1', pattern, confirmed: {} }
  const { pattern: kept, proposal } = keepFound(row, found)
  assert.deepEqual(kept.case_ids, ['c1', 'c2', 'c3', 'c4'])
  assert.equal(kept.case_count, 4)
  assert.deepEqual(kept.core_activities, [INTAKE, QUOTE, FINANCE, REPLY])
  assert.equal(kept.new_case_ids, undefined)
  assert.equal(kept.proposed, undefined)
  assert.deepEqual(proposal.case_ids, ['n1', 'n2'])
  assert.equal(proposal.total, 6)
  // 새 사례 둘 다 재무 검토를 건너뛰었다
  assert.deepEqual(proposal.missing_required, [[FINANCE, 2]])
  // 넣으면 빈도로는 재무 검토가 옵션 쪽이지만, 지금은 필수(빈도 초안)
  assert.deepEqual(proposal.draft_changes, [{ activity: FINANCE, draft: 'optional', holds: 'required', by: 'frequency' }])
})

test('관리자가 재무 검토를 옵션으로 확정했으면 새 사례가 그걸 빠뜨려도 필수 누락이 아니다', () => {
  const row = { pattern_key: 'k1', pattern, confirmed: { [FINANCE]: OPT } }
  const { pattern: kept, proposal } = keepFound(row, found)
  assert.deepEqual(kept.core_activities, [INTAKE, QUOTE, REPLY])
  assert.deepEqual(proposal.missing_required, [])
  assert.deepEqual(proposal.draft_changes, [{ activity: FINANCE, draft: 'optional', holds: 'optional', by: 'admin' }])
})

test('새 사례가 없으면 제안도 없다', () => {
  assert.equal(keepFound({ pattern_key: 'k1', pattern }, { ...pattern, new_case_ids: [], proposed: null }).proposal, null)
  assert.equal(proposalOf(pattern, {}, null), null)
})

test('같은 제안인지 (관리자에게 다시 알리지 않는다)', () => {
  assert.ok(sameCases({ case_ids: ['a', 'b'] }, { case_ids: ['b', 'a'] }))
  assert.ok(!sameCases({ case_ids: ['a', 'b', 'c'] }, { case_ids: ['a', 'b'] }))
  assert.ok(!sameCases({ case_ids: ['a'] }, null))
})

test('관리자의 말에서 단계·사례·프로세스를 하나로 가린다, 둘 이상이면 가리지 않는다', () => {
  const steps = [INTAKE, QUOTE, FINANCE, CONTRACT, REPLY]
  assert.equal(findStep('재무검토', steps), FINANCE)
  assert.equal(findStep('재무', steps), FINANCE)
  assert.equal(findStep('검토', steps), null, '재무 검토·계약 검토 둘이 맞는다')
  assert.equal(findStep('', steps), null)
  const cases = [{ case_id: 'a:1', subject: '창립기념식 다과 견적 요청', customer: '한빛상사' }, { case_id: 'a:2', subject: '신입 교육 일정표 요청', customer: '새봄교육' }]
  assert.equal(findCase('새봄교육', cases).case_id, 'a:2')
  assert.equal(findCase('교육 일정표', cases).case_id, 'a:2')
  assert.equal(findCase('요청', cases), null)
  // 고객 이름이 같아도 더 많이 맞는 사례 하나를 고른다
  const same = [{ case_id: 'e1', subject: '입사자 교육 일정표 부탁드립니다', customer: '새봄교육' }, { case_id: 'o1', subject: '신입 사원 온보딩 안내서 한 부 부탁드립니다', customer: '새봄교육' }]
  assert.equal(findCase('새봄교육 온보딩 안내서 요청', same).case_id, 'o1')
  assert.equal(findCase('새봄교육', same), null, '고객 이름만으로는 서로 다른 둘이 맞는다')
  // 같은 요청이 두 번 온 사례는 같은 말로 함께 가리킨다 (관리자는 둘 다를 말한다)
  const twice = [...same, { case_id: 'o2', subject: '신입 사원 온보딩 안내서 한 부 부탁드립니다', customer: '새봄교육' }]
  assert.deepEqual(findCases('새봄교육 온보딩 안내서 요청', twice).map((c) => c.case_id), ['o1', 'o2'])
  assert.deepEqual(findCases('없는 사례', twice), [])
  const rows = [{ name: '행사 견적·고객 회신', pattern: { category: '행사 견적' } }, { name: '요청 메일·견적서 작성', pattern: { category: '교육 일정표' } }]
  assert.equal(findSuggestion('교육 일정표', rows).name, '요청 메일·견적서 작성')
  assert.equal(findSuggestion('행사 견적·고객 회신', rows).name, '행사 견적·고객 회신')
  assert.equal(findSuggestion('견적', rows), null)
})

test('예전 기록(빈도 없음)도 변형으로 빈도를 셈한다', () => {
  const old = { ...pattern }
  delete old.frequency
  delete old.core_by_frequency
  const v = Object.fromEntries(stepsView(old, {}).map((x) => [x.activity, x.cases]))
  assert.equal(v[FINANCE], 3)
  assert.equal(v[CONTRACT], 1)
})
