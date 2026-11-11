// 필수·옵션은 BPMN 의 뜻이다 (2026-11-10, lib/mining/shape.js).
// 필수 = 시작부터 끝까지 어느 경로로도 지나는 태스크, 옵션 = 건너뛰는 경로가 있는 태스크.
// 관리자가 언제 건너뛰는지 말해야 정의에 배타 게이트웨이와 조건 흐름이 생긴다.
import test from 'node:test'
import assert from 'node:assert/strict'
import { applyStepRules, clearMined, flowOf, forSave, gatewayLanes, notHolds, ruleOf, stepKinds, undecided } from '../lib/mining/shape.js'

// 정식 등록된 "설계 제안·견적 대응" 그대로: 유저 태스크 여섯 개가 한 줄
const names = ['요청 메일 접수', '평면도 작성', '제안서 작성', '견적서 작성', '재무 검토', '고객 회신']
const linear = {
  activities: names.map((n, i) => ({ id: `activity_0${i + 1}`, name: n, type: 'userTask', role: '담당' })),
  gateways: [{ id: 'start_event', type: 'startEvent' }, { id: 'end_event', type: 'endEvent' }],
  sequences: [
    { id: 's0', source: 'start_event', target: 'activity_01' },
    ...names.slice(1).map((_, i) => ({ id: `s${i + 1}`, source: `activity_0${i + 1}`, target: `activity_0${i + 2}` })),
    { id: 's9', source: 'activity_06', target: 'end_event' },
  ],
}
const SKIP = '견적 합계가 5천만 원 미만이면'

test('한 줄로 이어진 정의에서는 모든 단계가 필수다', () => {
  const k = stepKinds(linear)
  assert.deepEqual(names.map((n) => k[n].kind), names.map(() => 'required'))
})

test('조건 없는 옵션은 정의를 바꾸지 않는다 (언제 건너뛰는지는 관리자가 말한다)', () => {
  assert.equal(ruleOf('optional'), null)
  assert.equal(ruleOf({ kind: 'optional', skip_when: ' ' }), null)
  const { def } = applyStepRules(linear, { '재무 검토': 'optional' })
  assert.deepEqual(def, linear)
})

test('옵션으로 확정하면 앞에 배타 게이트웨이가 생기고, 건너뛰는 흐름에 조건이 붙는다', () => {
  const { def, notes } = applyStepRules(linear, { '재무 검토': { kind: 'optional', skip_when: SKIP } })
  assert.deepEqual(notes, [])
  const g = def.gateways.find((x) => x.id === 'gw_opt_activity_05')
  assert.equal(g.type, 'exclusiveGateway')
  assert.ok(def.sequences.some((s) => s.source === 'activity_04' && s.target === g.id), '견적서 작성 → 게이트웨이')
  const keep = def.sequences.find((s) => s.source === g.id && s.target === 'activity_05')
  const skip = def.sequences.find((s) => s.source === g.id && s.target === 'activity_06')
  assert.equal(keep.condition, notHolds([SKIP]), '재무 검토로 가는 흐름은 여집합 조건 (기본 흐름 없음)')
  assert.ok(!JSON.parse(keep.properties).default)
  assert.equal(skip.condition, SKIP)
  const k = stepKinds(def)
  assert.equal(k['재무 검토'].kind, 'optional')
  assert.equal(k['재무 검토'].skip_when, SKIP)
  for (const n of names.filter((x) => x !== '재무 검토')) assert.equal(k[n].kind, 'required', n)
})

test('같은 확정을 두 번 적용해도 게이트웨이는 하나, 조건만 바뀐다', () => {
  const once = applyStepRules(linear, { '재무 검토': { kind: 'optional', skip_when: SKIP } }).def
  const twice = applyStepRules(once, { '재무 검토': { kind: 'optional', skip_when: '고객이 재무 검토를 원하지 않으면' } }).def
  assert.equal(twice.gateways.filter((g) => /gateway/i.test(g.type)).length, 1)
  assert.equal(stepKinds(twice)['재무 검토'].skip_when, '고객이 재무 검토를 원하지 않으면')
})

test('필수로 되돌리면 우회 흐름과 게이트웨이가 사라져 다시 한 줄이 된다', () => {
  const opt = applyStepRules(linear, { '재무 검토': { kind: 'optional', skip_when: SKIP } }).def
  const { def } = applyStepRules(opt, { '재무 검토': 'required' })
  assert.equal(def.gateways.filter((g) => /gateway/i.test(g.type)).length, 0)
  assert.equal(stepKinds(def)['재무 검토'].kind, 'required')
  assert.ok(def.sequences.some((s) => s.source === 'activity_04' && s.target === 'activity_05'))
})

test('마이닝이 그린 우회 분기는 관리자의 조건을 받고, 들어가는 흐름은 그 여집합이 된다', () => {
  const mined = JSON.parse(JSON.stringify(linear))
  mined.gateways.push({ id: 'gw_x', type: 'exclusiveGateway' })
  mined.sequences = mined.sequences.filter((s) => s.id !== 's4')
  mined.sequences.push({ id: 'x1', source: 'activity_04', target: 'gw_x' }, { id: 'x2', source: 'gw_x', target: 'activity_05', condition: '조건1' },
    { id: 'x3', source: 'gw_x', target: 'activity_06', condition: '조건2' })
  assert.equal(stepKinds(mined)['재무 검토'].kind, 'optional')
  const { def } = applyStepRules(mined, { '재무 검토': { kind: 'optional', skip_when: SKIP } })
  assert.equal(def.sequences.find((s) => s.id === 'x3').condition, SKIP)
  assert.equal(def.sequences.find((s) => s.id === 'x2').condition, notHolds([SKIP]))
  assert.equal(def.gateways.filter((g) => /gateway/i.test(g.type)).length, 1, '게이트웨이를 하나 더 만들지 않는다')
})

test('정의에 없는 단계는 바꾸지 못했다고 남긴다', () => {
  const { notes } = applyStepRules(linear, { '디자인 검토': { kind: 'optional', skip_when: SKIP } })
  assert.deepEqual(notes, [{ step: '디자인 검토', reason: 'not_in_definition' }])
})

test('저장 전에 시작·끝 이벤트를 events 로 옮기고 한 번씩만 남긴다 (게이트웨이로 그려지지 않게)', () => {
  const stored = { ...linear, gateways: [...linear.gateways, ...linear.gateways, { id: 'gw_opt_activity_05', type: 'exclusiveGateway' }] }
  const d = forSave(stored)
  assert.deepEqual(d.events.map((e) => e.id), ['start_event', 'end_event'])
  assert.deepEqual(d.gateways.map((g) => g.id), ['gw_opt_activity_05'])
})

test('경계의 필수 단계는 정의에서 읽는다 — 정의에 없는 단계나 옵션 단계는 넣지 않는다', async () => {
  const { requiredIn } = await import('../lib/mining/boundary.js')
  const opt = applyStepRules(linear, { '재무 검토': { kind: 'optional', skip_when: SKIP } }).def
  assert.deepEqual(requiredIn(opt), names.filter((n) => n !== '재무 검토'))
  assert.equal(requiredIn(null), null, '정의가 없으면 초안을 쓴다')
})

test('건너뛰는 조건은 관리자가 방금 한 말에서만 받는다 (지난 대화의 조건을 다시 쓰지 않는다)', async () => {
  const { saidNow } = await import('../lib/mining/talk.js')
  assert.ok(saidNow('견적 합계가 5천만 원 미만이면', '견적 합계가 5천만 원 미만이면 건너뛰어'))
  assert.ok(saidNow('고객이 메일에서 계약서를 요청하지 않았으면', '계약 검토는 옵션이야. 고객이 메일에서 계약서를 요청하지 않았으면 건너뛰어'))
  assert.ok(!saidNow('견적 합계가 5천만 원 미만이면', '재무 검토는 옵션 단계로 해 줘'))
  assert.ok(!saidNow('', '아무 말'))
})

test('게이트웨이는 바로 앞 단계의 레인에 둔다 — 역할이 없으면 BPMN 생성기가 모두 한 구석에 겹쳐 그린다', async () => {
  // 마이너가 그린 '요청 메일·견적서 작성': 접수 → 분기(견적서 작성 → 분기(견적서 검토 | 건너뜀) → 합류 | 제안서 작성) → 합류
  const def = {
    activities: [{ id: 'a1', name: '요청 메일 접수', role: '영업 담당' }, { id: 'a2', name: '견적서 작성', role: '견적 에이전트' },
      { id: 'a3', name: '견적서 검토', role: '검토 담당' }, { id: 'a4', name: '제안서 작성', role: '제안서 에이전트' }],
    gateways: [{ id: 'g1', type: 'exclusiveGateway' }, { id: 'g2', type: 'exclusiveGateway' }, { id: 'g3', type: 'exclusiveGateway' }, { id: 'g4', type: 'exclusiveGateway' },
      { id: 'g0', type: 'exclusiveGateway' }],
    events: [{ id: 'start_event', type: 'startEvent' }, { id: 'end_event', type: 'endEvent' }],
    sequences: [['start_event', 'g0'], ['g0', 'a1'], ['a1', 'g1'], ['g1', 'a2'], ['a2', 'g3'], ['g3', 'a3'], ['a3', 'g4'], ['g3', 'g4'], ['g4', 'g2'],
      ['g1', 'a4'], ['a4', 'g2'], ['g2', 'end_event']].map(([source, target], i) => ({ id: `s${i}`, source, target })),
  }
  const lanes = gatewayLanes(def)
  assert.equal(lanes.g0, '영업 담당', '시작 바로 뒤는 뒤 단계의 레인')
  assert.equal(lanes.g1, '영업 담당')
  assert.equal(lanes.g3, '견적 에이전트')
  assert.ok(lanes.g2 && lanes.g4, '합류도 레인이 있다')
  assert.ok(forSave(def).gateways.every((g) => g.role), '저장 전 정의의 게이트웨이마다 역할이 있다')
  const { buildContract } = await import('../lib/mining/service.js')
  const c = buildContract({ process_id: 'p', name: 'n', summary: '', definition: def, confirmed: {}, pattern: { case_count: 1, event_count: 1 } })
  assert.ok(c.processDefinition.elements.filter((e) => e.elementType === 'Gateway').every((e) => e.role), '정식 등록 계약의 게이트웨이마다 역할이 있다')
})

// 마이너가 그린 '요청 메일·견적서 작성' 3.0 모양: 접수 → 분기(견적서 작성 → 분기(견적서 검토 | 빈 갈래) | 제안서 작성) → 회신 완료
const QUOTE_WHEN = "이번 일에 '견적서 작성'이 필요하면", PROP_WHEN = "이번 일에 '제안서 작성'이 필요하면"
const branched = {
  activities: [['a1', '요청 메일 접수'], ['a2', '견적서 작성'], ['a3', '견적서 검토'], ['a4', '제안서 작성']].map(([id, name]) => ({ id, name, type: 'userTask' })),
  gateways: ['g1', 'g2', 'g3', 'g4'].map((id) => ({ id, type: 'exclusiveGateway' })),
  events: [{ id: 'start_event', type: 'startEvent' }, { id: 'end_event', type: 'endEvent' }],
  sequences: [['start_event', 'a1'], ['a1', 'g1'], ['g1', 'a2', QUOTE_WHEN], ['a2', 'g3'], ['g3', 'a3'], ['a3', 'g4'], ['g3', 'g4'], ['g4', 'g2'],
    ['g1', 'a4', PROP_WHEN], ['a4', 'g2'], ['g2', 'end_event']].map(([source, target, condition = ''], i) => ({ id: `s${i}`, source, target, condition })),
}

test('갈래마다 하는 일이 있으면 택일, 아무것도 하지 않고 넘어가는 갈래가 있으면 옵션이다', () => {
  const k = stepKinds(branched)
  assert.equal(k['요청 메일 접수'].kind, 'required')
  assert.equal(k['견적서 작성'].kind, 'choice', '제안서 작성과 둘 중 하나 — 건너뛰는 단계가 아니다')
  assert.equal(k['견적서 작성'].when, QUOTE_WHEN)
  assert.deepEqual(k['견적서 작성'].alternatives, ['제안서 작성'])
  assert.equal(k['견적서 작성'].skip_when, '', '다른 갈래의 조건을 건너뛰는 조건으로 내지 않는다')
  assert.equal(k['제안서 작성'].kind, 'choice')
  assert.equal(k['견적서 검토'].kind, 'optional', '빈 갈래가 있다')
  // 관리자가 확정한 옵션(배타 게이트웨이 + 빈 갈래)은 그대로 옵션
  const opt = applyStepRules(linear, { '재무 검토': { kind: 'optional', skip_when: SKIP } }).def
  assert.equal(stepKinds(opt)['재무 검토'].kind, 'optional')
})

test('정의를 순서와 갈래로 읽는다 — 택일은 갈래들, 옵션 단계는 제자리에', () => {
  assert.deepEqual(flowOf(branched), [
    { step: '요청 메일 접수' },
    { choice: 'g1', branches: [{ when: QUOTE_WHEN, items: [{ step: '견적서 작성' }, { step: '견적서 검토' }] }, { when: PROP_WHEN, items: [{ step: '제안서 작성' }] }] },
  ])
  const opt = applyStepRules(linear, { '재무 검토': { kind: 'optional', skip_when: SKIP } }).def
  assert.deepEqual(flowOf(opt).map((x) => x.step), names, '건너뛰는 갈래 하나뿐이면 택일로 그리지 않는다')
})

test('택일 단계는 필수·옵션으로 바꾸지 않는다 — 다른 갈래를 지우거나 그 조건을 바꾸게 된다', () => {
  for (const v of ['required', { kind: 'optional', skip_when: '고객이 원하지 않으면' }]) {
    const { def, notes } = applyStepRules(branched, { '견적서 작성': v })
    assert.deepEqual(notes, [{ step: '견적서 작성', reason: 'in_choice' }])
    assert.deepEqual(def.sequences, branched.sequences, '흐름이 그대로다')
  }
})

test('대화에 넘기는 정의 한 줄: 택일은 [A | B], 옵션은 (옵션)', async () => {
  const { flowLine } = await import('../lib/mining/talk.js')
  const card = (activity, kind) => ({ step: { activity, decided: { kind } } })
  const line = flowLine([card('요청 메일 접수', 'required'), { choice: 'g1', branches: [{ items: [card('견적서 작성', 'choice'), card('견적서 검토', 'optional')] }, { items: [card('제안서 작성', 'choice')] }, { items: [] }] }])
  assert.equal(line, '요청 메일 접수 → [견적서 작성 → 견적서 검토(옵션) | 제안서 작성 | 건너뜀]')
})

// 마이너가 그린 그대로(4.0 전): 기본 갈래(견적서 작성)에도 조건이 붙어 있고, 견적서 검토의 건너뛰는 흐름엔 조건이 없다
const mined = JSON.parse(JSON.stringify(branched))
for (const s of mined.sequences) {
  if (s.source === 'g1' && s.target === 'a2') s.properties = JSON.stringify({ priority: 0, default: true })
  if (s.source === 'g1' && s.target === 'a4') s.properties = JSON.stringify({ priority: 1 })
  if (s.source === 'g3' && s.target === 'a3') s.properties = JSON.stringify({ priority: 0, default: true })
}

test('정하지 않은 분기: 조건 없는 건너뛰기와, 덜 관측된 택일 갈래 (마이닝이 쓴 단계 이름 조건은 조건이 아니다)', () => {
  assert.deepEqual(undecided(clearMined(mined), {}), [
    { step: '견적서 검토', need: 'skip', gateway: 'g3', draft: '' },
    { step: '제안서 작성', need: 'when', gateway: 'g1', draft: '', alternatives: ['견적서 작성'] },
  ])
  // 정하면 빠진다: 건너뛰기는 필수 또는 조건, 갈래는 조건 — 나머지 흐름은 여집합
  const both = { '견적서 검토': 'required', '제안서 작성': { kind: 'choice', when: PROP_WHEN } }
  assert.deepEqual(undecided(applyStepRules(clearMined(mined), both).def, both), [])
  assert.deepEqual(undecided(linear, {}), [], '한 줄 정의는 정할 분기가 없다')
  const opt = applyStepRules(linear, { '재무 검토': { kind: 'optional', skip_when: SKIP } }).def
  assert.deepEqual(undecided(opt, { '재무 검토': { kind: 'optional', skip_when: SKIP } }), [])
})

test('갈래 조건 확정은 그 갈래로 들어가는 흐름의 조건이 되고, 다른 갈래는 그 여집합이 된다', () => {
  const when = '고객이 교육 제안서를 요청하면'
  const { def, notes } = applyStepRules(clearMined(mined), { '제안서 작성': { kind: 'choice', when } })
  assert.deepEqual(notes, [])
  assert.equal(def.sequences.find((s) => s.source === 'g1' && s.target === 'a4').condition, when)
  assert.equal(def.sequences.find((s) => s.source === 'g1' && s.target === 'a2').condition, notHolds([when]), '여집합')
  assert.deepEqual(applyStepRules(clearMined(mined), { '견적서 작성': { kind: 'choice', when } }).notes, [], '어느 갈래든 조건을 정할 수 있다 (기본 갈래가 없다)')
  assert.deepEqual(applyStepRules(mined, { '요청 메일 접수': { kind: 'choice', when } }).notes, [{ step: '요청 메일 접수', reason: 'not_choice' }])
  // 건너뛰는 조건을 정하면 견적서 검토 앞 게이트웨이의 빈 갈래에 붙는다
  const skip = applyStepRules(mined, { '견적서 검토': { kind: 'optional', skip_when: '견적 금액이 100만 원 미만이면' } }).def
  assert.equal(skip.sequences.find((s) => s.source === 'g3' && s.target === 'g4').condition, '견적 금액이 100만 원 미만이면')
})

test('정식 등록은 관리자가 정하지 않은 분기가 없어야 된다 (registerIn 이 이 목록으로 막는다)', async () => {
  const { openBranches } = await import('../lib/mining/service.js')
  const s = { definition: mined, confirmed: {} }
  assert.deepEqual(openBranches(s).map((x) => x.step), ['견적서 검토', '제안서 작성'])
  s.confirmed = { '견적서 검토': 'required', '제안서 작성': { kind: 'choice', when: PROP_WHEN } }
  assert.deepEqual(openBranches(s), [], '모두 정하면 등록할 수 있다')
})
