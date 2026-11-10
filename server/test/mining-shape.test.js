// 필수·옵션은 BPMN 의 뜻이다 (2026-11-10, lib/mining/shape.js).
// 필수 = 시작부터 끝까지 어느 경로로도 지나는 태스크, 옵션 = 건너뛰는 경로가 있는 태스크.
// 관리자가 언제 건너뛰는지 말해야 정의에 배타 게이트웨이와 조건 흐름이 생긴다.
import test from 'node:test'
import assert from 'node:assert/strict'
import { applyStepRules, forSave, gatewayLanes, ruleOf, stepKinds } from '../lib/mining/shape.js'

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
  assert.equal(JSON.parse(keep.properties).default, true, '재무 검토로 가는 흐름이 기본')
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

test('마이닝이 그린 우회 분기(조건 없음)는 관리자의 조건을 받고, 들어가는 흐름이 기본이 된다', () => {
  const mined = JSON.parse(JSON.stringify(linear))
  mined.gateways.push({ id: 'gw_x', type: 'exclusiveGateway' })
  mined.sequences = mined.sequences.filter((s) => s.id !== 's4')
  mined.sequences.push({ id: 'x1', source: 'activity_04', target: 'gw_x' }, { id: 'x2', source: 'gw_x', target: 'activity_05', condition: '조건1' },
    { id: 'x3', source: 'gw_x', target: 'activity_06', condition: '조건2' })
  assert.equal(stepKinds(mined)['재무 검토'].kind, 'optional')
  const { def } = applyStepRules(mined, { '재무 검토': { kind: 'optional', skip_when: SKIP } })
  assert.equal(def.sequences.find((s) => s.id === 'x3').condition, SKIP)
  assert.equal(JSON.parse(def.sequences.find((s) => s.id === 'x2').properties).default, true)
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
