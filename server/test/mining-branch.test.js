// 분기의 모든 흐름은 업무 조건을 가진다 (2026-11-11, openspec intent-and-admin-boundary 결정 9).
// BPMN 배타 게이트웨이의 기본 흐름은 "다른 조건이 모두 맞지 않을 때" — 그 뜻을 조건으로 적으면 기본 흐름이
// 필요 없다. 조건은 업무 흐름(사례의 요청·문서가 사례 전부를 실제 간 흐름대로 가름) 또는 관리자에게서만 온다.
import test from 'node:test'
import assert from 'node:assert/strict'
import { applyStepRules, clearMined, completeSplits, notHolds, oppositesOf, splitsOf, undecided } from '../lib/mining/shape.js'
import { branchCases, deriveSplit, materialsBefore } from '../lib/mining/branch.js'

const props = (s) => JSON.parse(s.properties || '{}')
const outs = (def, g) => def.sequences.filter((s) => s.source === g)
// 갈래가 둘 이상인 배타 게이트웨이의 모든 흐름: 조건이 있고 기본 흐름이 없다
function everyFlowHasCondition(def) {
  for (const g of def.gateways.filter((x) => /exclusive/i.test(x.type || ''))) {
    const o = outs(def, g.id)
    if (o.length < 2) continue
    for (const s of o) {
      assert.ok(String(s.condition || '').trim(), `${g.id} → ${s.target}: 조건이 없다`)
      assert.ok(!props(s).default, `${g.id} → ${s.target}: 기본 흐름이 남았다`)
    }
  }
}

// 정식 등록된 "설계 제안·견적 대응": 여섯 단계 한 줄
const names = ['요청 메일 접수', '평면도 작성', '제안서 작성', '견적서 작성', '재무 검토', '고객 회신']
const linear = {
  activities: names.map((n, i) => ({ id: `activity_0${i + 1}`, name: n, type: 'userTask', role: '담당' })),
  gateways: [], events: [{ id: 'start_event', type: 'startEvent' }, { id: 'end_event', type: 'endEvent' }],
  sequences: [
    { id: 's0', source: 'start_event', target: 'activity_01' },
    ...names.slice(1).map((_, i) => ({ id: `s${i + 1}`, source: `activity_0${i + 1}`, target: `activity_0${i + 2}` })),
    { id: 's9', source: 'activity_06', target: 'end_event' },
  ],
}
const SKIP = '견적 합계가 5천만 원 미만이면'

test('옵션: 건너뛰는 흐름과 태스크로 가는 흐름 모두 조건이 있고, 기본 흐름이 없다', () => {
  const { def } = applyStepRules(linear, { '재무 검토': { kind: 'optional', skip_when: SKIP } })
  everyFlowHasCondition(def)
  const g = 'gw_opt_activity_05'
  assert.equal(outs(def, g).find((s) => s.target === 'activity_06').condition, SKIP)
  assert.equal(outs(def, g).find((s) => s.target === 'activity_05').condition, notHolds([SKIP]))
})

test('여집합은 정해진 조건의 말을 그대로 감싼다', () => {
  assert.equal(notHolds([SKIP]), `다음에 해당하지 않으면: ${SKIP}`)
  assert.equal(notHolds(['A이면', 'B이면']), '다음 어느 것에도 해당하지 않으면: A이면 / B이면')
  assert.equal(notHolds(['the quote is under 50,000,000']), 'When this does not hold: the quote is under 50,000,000')
})

// 마이너가 그린 '요청 메일·견적서 작성': 접수 → 분기(견적서 작성 → 분기(견적서 검토 | 빈 갈래) | 제안서 작성) → 끝
// 옛 마이너가 남긴 단계 이름 조건과 기본 흐름이 그대로 있다
const OLD = "이번 일에 '제안서 작성'이 필요하면"
const mined = {
  activities: [['a1', '요청 메일 접수'], ['a2', '견적서 작성'], ['a3', '견적서 검토'], ['a4', '제안서 작성']].map(([id, name]) => ({ id, name, type: 'userTask' })),
  gateways: ['g1', 'g2', 'g3', 'g4'].map((id) => ({ id, type: 'exclusiveGateway' })),
  events: [{ id: 'start_event', type: 'startEvent' }, { id: 'end_event', type: 'endEvent' }],
  sequences: [['start_event', 'a1'], ['a1', 'g1'], ['g1', 'a2', '', { priority: 0, default: true }], ['a2', 'g3'], ['g3', 'a3', '', { priority: 0, default: true }],
    ['a3', 'g4'], ['g3', 'g4', '', { priority: 1 }], ['g4', 'g2'], ['g1', 'a4', OLD, { priority: 1 }], ['a4', 'g2'], ['g2', 'end_event']]
    .map(([source, target, condition = '', p = {}], i) => ({ id: `s${i}`, source, target, condition, properties: JSON.stringify(p) })),
}

test('마이닝이 그린 정의의 단계 이름 조건과 기본 흐름은 조건이 아니다 — 지우고 정하지 않은 분기로 남긴다', () => {
  const d = clearMined(mined)
  for (const g of ['g1', 'g3']) for (const s of outs(d, g)) { assert.equal(s.condition, ''); assert.ok(!props(s).default) }
  assert.deepEqual(undecided(d, {}).map(({ step, need }) => ({ step, need })), [
    { step: '견적서 검토', need: 'skip' },
    { step: '제안서 작성', need: 'when' },
  ], '두 갈래 택일은 덜 관측된 갈래 하나만 묻는다 — 나머지 하나는 여집합')
})

test('택일: 한 갈래 조건이 정해지면 다른 갈래는 여집합, 기본 흐름은 없다', () => {
  const when = '고객이 메일에서 제안서를 요청했으면'
  const { def, notes } = applyStepRules(clearMined(mined), { '제안서 작성': { kind: 'choice', when }, '견적서 검토': 'required' })
  assert.deepEqual(notes, [])
  everyFlowHasCondition(def)
  assert.equal(outs(def, 'g1').find((s) => s.target === 'a4').condition, when)
  assert.equal(outs(def, 'g1').find((s) => s.target === 'a2').condition, notHolds([when]))
  assert.deepEqual(undecided(def, { '제안서 작성': { kind: 'choice', when }, '견적서 검토': 'required' }), [])
})

// 세 갈래 택일: 견적서 작성(가장 많음) | 제안서 작성 | 일정표 작성
const three = {
  activities: [['a1', '요청 메일 접수'], ['a2', '견적서 작성'], ['a4', '제안서 작성'], ['a5', '일정표 작성']].map(([id, name]) => ({ id, name, type: 'userTask' })),
  gateways: [{ id: 'g1', type: 'exclusiveGateway' }, { id: 'g2', type: 'exclusiveGateway' }],
  events: [{ id: 'start_event', type: 'startEvent' }, { id: 'end_event', type: 'endEvent' }],
  sequences: [['start_event', 'a1'], ['a1', 'g1'], ['g1', 'a2', 0], ['g1', 'a4', 1], ['g1', 'a5', 2], ['a2', 'g2'], ['a4', 'g2'], ['a5', 'g2'], ['g2', 'end_event']]
    .map(([source, target, priority], i) => ({ id: `t${i}`, source, target, condition: '', properties: JSON.stringify(priority === undefined ? {} : { priority }) })),
}

test('세 갈래 택일은 나머지가 모두 정해졌을 때 마지막 하나만 여집합이 된다', () => {
  assert.deepEqual(undecided(three, {}).map((x) => x.step), ['제안서 작성', '일정표 작성'])
  const one = { '제안서 작성': { kind: 'choice', when: '제안서를 요청했으면' } }
  assert.deepEqual(undecided(applyStepRules(three, one).def, one).map((x) => x.step), ['일정표 작성'], '하나만 정하면 아직 둘이 비어 있다')
  const both = { ...one, '일정표 작성': { kind: 'choice', when: '일정표를 요청했으면' } }
  const { def } = applyStepRules(three, both)
  everyFlowHasCondition(def)
  assert.equal(outs(def, 'g1').find((s) => s.target === 'a2').condition, notHolds(['제안서를 요청했으면', '일정표를 요청했으면']))
})

// 반복 판정: 접수 → 검토 → 판정(다시: 검토로 | 앞으로: 회신) → 회신
const loop = {
  activities: [['a1', '요청 메일 접수'], ['a2', '견적서 검토'], ['a3', '고객 회신']].map(([id, name]) => ({ id, name, type: 'userTask' })),
  gateways: [{ id: 'gin', type: 'exclusiveGateway' }, { id: 'gchk', type: 'exclusiveGateway' }],
  events: [{ id: 'start_event', type: 'startEvent' }, { id: 'end_event', type: 'endEvent' }],
  sequences: [['start_event', 'a1'], ['a1', 'gin'], ['gin', 'a2'], ['a2', 'gchk'], ['gchk', 'a3', { priority: 0, default: true }], ['gchk', 'gin', { priority: 1 }], ['a3', 'end_event']]
    .map(([source, target, p = {}], i) => ({ id: `l${i}`, source, target, condition: '', properties: JSON.stringify(p) })),
}

test('반복 판정도 두 흐름 모두 조건을 가진다 — 정하지 않았으면 언제 다시 하는지 묻는다', () => {
  const sp = splitsOf(loop)
  assert.deepEqual(sp.map((x) => ({ gateway: x.gateway, kind: x.kind, step: x.step })), [{ gateway: 'gchk', kind: 'loop', step: '견적서 검토' }])
  assert.deepEqual(undecided(clearMined(loop), {}).map(({ step, need }) => ({ step, need })), [{ step: '견적서 검토', need: 'redo' }])
  const rule = { '견적서 검토': { kind: 'loop', redo_when: '검토 결과가 수정 요청이면' } }
  const { def } = applyStepRules(clearMined(loop), rule)
  everyFlowHasCondition(def)
  assert.equal(outs(def, 'gchk').find((s) => s.target === 'gin').condition, '검토 결과가 수정 요청이면')
  assert.equal(outs(def, 'gchk').find((s) => s.target === 'a3').condition, notHolds(['검토 결과가 수정 요청이면']))
  assert.deepEqual(undecided(def, rule), [])
})

test('정식 등록된 정의: 관리자가 정한 조건의 여집합만 빠졌으면 묻지 않고 채운다', () => {
  // 2026-11-10 저장본: 건너뛰는 흐름에 관리자 조건, 재무 검토로 가는 흐름은 조건 없는 기본 흐름
  const saved = JSON.parse(JSON.stringify(linear))
  saved.gateways.push({ id: 'gw', type: 'exclusiveGateway' })
  saved.sequences = saved.sequences.filter((s) => s.id !== 's4')
  saved.sequences.push({ id: 'k0', source: 'activity_04', target: 'gw' },
    { id: 'keep', source: 'gw', target: 'activity_05', condition: '', properties: JSON.stringify({ default: true, priority: 1 }) },
    { id: 'skip', source: 'gw', target: 'activity_06', condition: SKIP, properties: JSON.stringify({ priority: 0 }) })
  assert.deepEqual(undecided(saved, {}), [], '여집합만 빠진 분기는 정하지 않은 분기가 아니다')
  const { def, changed } = completeSplits(saved)
  assert.equal(changed, true)
  everyFlowHasCondition(def)
  assert.equal(def.sequences.find((s) => s.id === 'keep').condition, notHolds([SKIP]))
  assert.equal(completeSplits(def).changed, false, '다시 채울 것이 없다')
})

test('업무 흐름이 정한 조건과 초안: 초안은 조건이 아니고, 정하지 않은 분기에 맞은 건수와 함께 실린다', () => {
  const d = clearMined(mined)
  const confirmed = {
    '견적서 검토': { kind: 'optional', skip_when: '요청한 견적이 단가표 사본이면', by: 'cases', matched: 9, total: 9 },
    '제안서 작성': { kind: 'choice', draft: { when: '고객이 제안서를 요청했으면', matched: 8, total: 10 } },
  }
  const { def } = applyStepRules(d, confirmed)
  assert.equal(outs(def, 'g3').find((s) => s.target === 'g4').condition, '요청한 견적이 단가표 사본이면', '업무 흐름이 정한 조건은 조건이다')
  assert.equal(outs(def, 'g1').find((s) => s.target === 'a4').condition, '', '초안은 조건이 아니다')
  assert.deepEqual(undecided(def, confirmed), [{ step: '제안서 작성', need: 'when', gateway: 'g1', draft: '고객이 제안서를 요청했으면', matched: 8, total: 10, alternatives: ['견적서 작성'] }])
})

// ---------- 사례가 간 흐름 ----------
const traces = {
  q1: ['요청 메일 접수', '견적서 작성', '견적서 검토'],
  q2: ['요청 메일 접수', '견적서 작성'],
  p1: ['요청 메일 접수', '제안서 작성'],
  both: ['요청 메일 접수', '견적서 작성', '제안서 작성'],
}

test('사례가 간 흐름: 택일·빈 갈래·중첩 분기, 두 흐름에 걸린 사례는 근거에서 뺀다', () => {
  const d = clearMined(mined)
  const by = Object.fromEntries(branchCases(d, traces).map((x) => [x.gateway, x]))
  const g1 = Object.fromEntries(by.g1.flows.map((f) => [f.target, f.cases]))
  assert.deepEqual(g1, { a2: ['q1', 'q2'], a4: ['p1'] })
  assert.deepEqual(by.g1.ambiguous, ['both'])
  // 견적서 검토 앞 분기는 견적서 작성을 거친 사례만: 검토함 q1, 건너뜀 q2 (both 는 견적서 작성 갈래로 단정할 수 없다)
  const g3 = Object.fromEntries(by.g3.flows.map((f) => [f.target, f.cases]))
  assert.deepEqual(g3, { a3: ['q1'], g4: ['q2'] })
})

test('기준의 재료는 게이트웨이 앞 단계의 문서뿐 — 뒤에서 만든 문서는 넘기지 않는다', () => {
  const steps = [{ activity: '요청 메일 접수', files: ['요청서.pdf'] }, { activity: '견적서 작성', files: ['견적서.xlsx'] }, { activity: '견적서 검토', files: ['검토 의견.docx'] }]
  assert.deepEqual(materialsBefore(clearMined(mined), 'g1', steps), [{ activity: '요청 메일 접수', files: ['요청서.pdf'] }])
  assert.deepEqual(materialsBefore(clearMined(mined), 'g3', steps).map((x) => x.activity), ['요청 메일 접수', '견적서 작성'])
})

// ---------- 업무 흐름 판정 ----------
const flows = [{ seq: 's2', target: 'a2', label: '견적서 작성', cases: ['q1', 'q2'] }, { seq: 's8', target: 'a4', label: '제안서 작성', cases: ['p1'] }]
const materials = { q1: { subject: '견적 요청' }, q2: { subject: '견적 부탁' }, p1: { subject: '제안서 요청' } }

test('업무 흐름 판정: 찾은 기준을 갈래를 모르는 채로 맞춰 보아 모두 맞으면 조건이 된다', async () => {
  const seen = []
  const ask = async (kind, input) => {
    seen.push({ kind, input })
    if (kind === 'find') return { conditions: { '제안서 작성': '고객이 제안서를 요청했으면' } }
    return { assign: { q1: 'none', q2: 'none', p1: 'A' } }
  }
  const r = await deriveSplit({ kind: 'choice', flows, materials, ask })
  assert.deepEqual(r, { grounded: true, conditions: { s8: '고객이 제안서를 요청했으면' }, matched: 3, total: 3 })
  const check = seen.find((x) => x.kind === 'check').input
  assert.ok(!JSON.stringify(check).includes('견적서 작성') && !JSON.stringify(check).includes('제안서 작성'), '맞춰 보는 호출은 갈래(단계 이름)를 모른다')
})

test('업무 흐름 판정: 일부만 맞으면 초안, 기준이 없으면 초안도 없다', async () => {
  const some = async (kind) => (kind === 'find' ? { conditions: { '제안서 작성': '고객이 제안서를 요청했으면' } } : { assign: { q1: 'none', q2: 'A', p1: 'A' } })
  assert.deepEqual(await deriveSplit({ kind: 'choice', flows, materials, ask: some }), { grounded: false, conditions: { s8: '고객이 제안서를 요청했으면' }, matched: 2, total: 3 })
  const none = async (kind) => (kind === 'find' ? { conditions: {} } : { assign: {} })
  assert.deepEqual(await deriveSplit({ kind: 'choice', flows, materials, ask: none }), { grounded: false, conditions: null, matched: 0, total: 3 })
})

test('업무 흐름 판정: 확인 필요가 묻는 흐름(named)의 조건을 찾는다 — 사례가 더 많은 흐름이라도', async () => {
  const seen = []
  const ask = async (kind, input) => { seen.push(input); return kind === 'find' ? { conditions: { '견적서 작성': '고객이 견적서를 요청했으면' } } : { assign: { q1: 'A', q2: 'A', p1: 'none' } } }
  const r = await deriveSplit({ kind: 'choice', flows, materials, named: ['s2'], ask })
  assert.deepEqual(seen[0].name, ['견적서 작성'])
  assert.deepEqual(r, { grounded: true, conditions: { s2: '고객이 견적서를 요청했으면' }, matched: 3, total: 3 })
})

test('업무 흐름 판정: 사례가 없는 흐름이 있으면 모두 맞아도 조건이 아니다 (초안)', async () => {
  const empty = [flows[0], { ...flows[1], cases: [] }]
  const ask = async (kind) => (kind === 'find' ? { conditions: { '제안서 작성': '고객이 제안서를 요청했으면' } } : { assign: { q1: 'none', q2: 'none' } })
  const r = await deriveSplit({ kind: 'choice', flows: empty, materials, ask })
  assert.equal(r.grounded, false)
  assert.equal(r.matched, 2)
})

test('정식 등록 계약에 단계 이름 문장·금액 설정값 조건이 들어가지 않는다', async () => {
  const { buildContract } = await import('../lib/mining/service.js')
  // 마이너가 그린 재무 검토 건너뜀 분기 (조건 없음) — 예전에는 Lite 가 5천만 원 기준을 넣었다
  const fin = {
    activities: [['a1', '요청 메일 접수'], ['a2', '견적서 작성'], ['a3', '재무 검토'], ['a4', '고객 회신']].map(([id, name]) => ({ id, name, type: 'userTask', role: '담당' })),
    gateways: [{ id: 'g1', type: 'exclusiveGateway' }, { id: 'g2', type: 'exclusiveGateway' }],
    events: [{ id: 'start_event', type: 'startEvent' }, { id: 'end_event', type: 'endEvent' }],
    roles: [],
    sequences: [['start_event', 'a1'], ['a1', 'a2'], ['a2', 'g1'], ['g1', 'a3'], ['g1', 'g2'], ['a3', 'g2'], ['g2', 'a4'], ['a4', 'end_event']]
      .map(([source, target], i) => ({ id: `f${i}`, source, target, condition: '', properties: '{}' })),
  }
  const confirmed = { '재무 검토': { kind: 'optional', skip_when: '고객이 재무 검토를 원하지 않으면' } }
  const c = buildContract({ process_id: 'p', name: 'n', summary: '', definition: fin, confirmed, pattern: { case_count: 1, event_count: 1 } })
  const seqs = c.processDefinition.elements.filter((e) => e.elementType === 'Sequence')
  const text = JSON.stringify(seqs)
  assert.ok(!/5천만|50000000|50,000,000|필요하면/.test(text), text)
  const split = seqs.filter((s) => s.source === 'g1')
  assert.equal(split.length, 2)
  for (const s of split) { assert.ok(s.condition.trim()); assert.ok(!JSON.parse(s.properties || '{}').default) }
})

// ---------- 반대쪽 조건은 같은 뜻을 업무 말로 (2026-11-11) ----------
// "시스템이 조건을 지어내지 않는다"는 내용(숫자·기준·사실)을 더하지 않는다는 뜻이다. 같은 뜻을 관리자가 바로
// 읽는 말로 바꾸는 것은 지어내는 것이 아니다. "다음에 해당하지 않으면: …" 감싼 꼴은 바꿀 말이 없을 때만 남는다.
test('반대쪽 흐름은 관리자 조건의 반대를 업무 말로 적는다 — 감싼 꼴이 아니다', async () => {
  const { oppositesOf } = await import('../lib/mining/shape.js')
  const rule = { '재무 검토': { kind: 'optional', skip_when: SKIP, by: 'admin', opposite: '견적 합계가 5천만 원 이상이면' } }
  assert.deepEqual(oppositesOf(rule), { [SKIP]: '견적 합계가 5천만 원 이상이면' })
  const { def } = applyStepRules(linear, rule)
  everyFlowHasCondition(def)
  const keep = outs(def, 'gw_opt_activity_05').find((s) => s.target === 'activity_05')
  assert.equal(keep.condition, '견적 합계가 5천만 원 이상이면')
  assert.equal(props(keep).complement, true, '시스템이 쓴 반대 조건이라는 표시 — 관리자가 조건을 바꾸면 다시 쓴다')
  // 관리자가 건너뛰는 조건을 바꾸면 반대쪽도 새 조건에서 다시 나온다
  const again = applyStepRules(def, { '재무 검토': { kind: 'optional', skip_when: '견적 합계가 1천만 원 미만이면', by: 'admin' } }).def
  assert.equal(outs(again, 'gw_opt_activity_05').find((s) => s.target === 'activity_05').condition, notHolds(['견적 합계가 1천만 원 미만이면']))
})

test('정식 등록된 정의의 감싼 반대 조건은 업무 말 반대가 생기면 바뀐다', () => {
  const wrapped = applyStepRules(linear, { '재무 검토': { kind: 'optional', skip_when: SKIP } }).def
  const { def, changed } = completeSplits(wrapped, { [SKIP]: '견적 합계가 5천만 원 이상이면' })
  assert.equal(changed, true)
  assert.equal(outs(def, 'gw_opt_activity_05').find((s) => s.target === 'activity_05').condition, '견적 합계가 5천만 원 이상이면')
})

test('관리자가 반대쪽 흐름의 조건을 직접 말하면 시스템 표시가 지워져 다시 덮어쓰지 않는다', () => {
  const when = '고객이 메일에서 제안서를 요청했으면'
  const first = applyStepRules(clearMined(mined), { '제안서 작성': { kind: 'choice', when, opposite: '고객이 메일에서 제안서를 요청하지 않았으면' } }).def
  const quote = outs(first, 'g1').find((s) => s.target === 'a2')
  assert.equal(props(quote).complement, true)
  const own = applyStepRules(first, { '견적서 작성': { kind: 'choice', when: '고객이 견적서를 요청했으면' } }).def
  const q2 = outs(own, 'g1').find((s) => s.target === 'a2')
  assert.equal(q2.condition, '고객이 견적서를 요청했으면')
  assert.ok(!props(q2).complement)
})

test('반대 조건은 내용을 더하지 않는다 — 없던 숫자가 들어가거나 같은 문장이면 받지 않는다', async () => {
  const { sameFacts, writeOpposite } = await import('../lib/mining/branch.js')
  assert.ok(sameFacts(SKIP, '견적 합계가 5천만 원 이상이면'))
  assert.ok(sameFacts('고객이 메일에서 계약서를 요청하지 않았으면', '고객이 메일에서 계약서를 요청했으면'))
  assert.ok(!sameFacts(SKIP, '견적 합계가 1억 원 이상이고 재무 검토를 요청했으면'), '없던 금액')
  assert.ok(!sameFacts(SKIP, SKIP), '같은 문장')
  assert.equal(await writeOpposite(SKIP, async () => ({ opposite: '견적 합계가 5천만 원 이상이면' })), '견적 합계가 5천만 원 이상이면')
  assert.equal(await writeOpposite(SKIP, async () => ({ opposite: '견적 합계가 1억 원 이상이면' })), null, '지어낸 숫자는 버린다 (감싼 꼴이 남는다)')
})

test('관리자가 한 분기만 정해도 다른 분기의 업무 말 반대 조건은 그대로다 (감싼 꼴로 돌아가지 않는다)', () => {
  const rules = { '견적서 검토': { kind: 'optional', skip_when: '견적 금액이 100만 원 미만이면', opposite: '견적 금액이 100만 원 이상이면' } }
  const saved = applyStepRules(clearMined(mined), rules).def
  assert.equal(outs(saved, 'g3').find((s) => s.target === 'a3').condition, '견적 금액이 100만 원 이상이면')
  // 관리자가 택일 갈래 하나만 정한다 (setStep 은 그 규칙 하나와 저장된 다른 규칙의 반대 조건을 넘긴다)
    const after = applyStepRules(saved, { '제안서 작성': { kind: 'choice', when: '고객이 제안서를 요청했으면' } }, oppositesOf(rules)).def
  assert.equal(outs(after, 'g3').find((s) => s.target === 'a3').condition, '견적 금액이 100만 원 이상이면')
})
