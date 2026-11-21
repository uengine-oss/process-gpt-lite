// English mode for process mining, process improvement and the demo data (lib/lang.js): English
// variants carry no Hangul in what people read; the Korean ones are as they were.
import test from 'node:test'
import assert from 'node:assert/strict'
import { withLang } from '../lib/lang.js'
import { stepsIn, agentsIn, labelIn, labelsOf, labelLang, stepOf, formatOfTool } from '../lib/mining/catalog.js'
import { setEnabledPacks } from '../lib/skillInstallCatalog.js'
import { config } from '../config.js'
import { contract, simulate, DEF_NAME, defName, fieldLabels, FIELD_LABELS } from '../lib/improve/demoProcess.js'
import { engineRows } from '../lib/improve/shape.js'
import { analyze } from '../lib/improve/analyze.js'
import { resources } from '../lib/improve/toc.js'
import { focusingSteps, dur } from '../lib/improve/focus.js'
import { whatIf } from '../lib/improve/whatif.js'
import { describeChange, fmtNum, changeTypes, CHANGE_TYPES } from '../lib/improve/transform.js'
import { buildContract, registeredFor, patternLang } from '../lib/mining/service.js'

const HANGUL = /[가-힣]/
const noHangul = (v, what) => assert.ok(!HANGUL.test(JSON.stringify(v)), `${what}: ${JSON.stringify(v).match(/.{0,40}[가-힣].{0,40}/)?.[0]}`)
const people = { jang: 'u1', minji: 'u2', seoyeon: 'u3' }
const NAMES = { ko: { jang: '장진영', minji: '김민지', seoyeon: '박서연' }, en: { jang: 'Jinyoung Jang', minji: 'Minji Kim', seoyeon: 'Seoyeon Park' } }
const range = { from: Date.UTC(2026, 7, 3), to: Date.UTC(2026, 9, 27, 3) }

// the store-design steps come from its business pack (skills/packs/store-design): on for these tests
const packOn = () => setEnabledPacks(config.tenantId, ['store-design'])
const packOff = () => setEnabledPacks(config.tenantId, [])

test('mining catalog: every step has an English twin (same key, kind, form keys, agent id); labels map both ways', () => {
  packOn()
  try {
    const ko = stepsIn('ko'), en = stepsIn('en')
    assert.equal(ko.length, en.length)
    for (const st of ko) {
      const e = labelIn(st.label, 'en')
      assert.notEqual(e, st.label, `${st.label} has an English label`)
      assert.equal(labelIn(e, 'ko'), st.label)
      assert.equal(stepOf(e).key, st.key)
      assert.equal(stepOf(e).kind, st.kind)
      assert.deepEqual((stepOf(e).fields || []).map((f) => f.key), (st.fields || []).map((f) => f.key))
    }
    noHangul(en, 'English steps')
    noHangul(agentsIn('en'), 'English agents')
    for (const k of Object.keys(agentsIn('ko'))) assert.equal(agentsIn('en')[k].id, agentsIn('ko')[k].id)
    assert.equal(agentsIn('en').drawing.name, 'Drawing agent')
    assert.equal(agentsIn('ko').drawing.name, '도면 에이전트')
    assert.equal(withLang('en', () => agentsIn()).quote.name, 'Quote agent')
    assert.deepEqual(labelsOf('고객 회신'), ['고객 회신', 'Reply to customer'])
    assert.equal(labelLang('Finance review'), 'en')
    assert.equal(labelLang('재무 검토'), 'ko')
    // a label no catalog has is kept as recorded
    assert.equal(labelIn('Operations review', 'en'), 'Operations review')
    assert.equal(formatOfTool(stepOf('Write proposal').tool), 'docx')
    assert.equal(formatOfTool(stepOf('제안서 작성').tool), 'hwpx')
    assert.equal(formatOfTool('xlsx'), 'xlsx', 'a draft step records its format as its tool')
  } finally { packOff() }
})

test('mining: a flow recorded in English is named and registered in English; a Korean one as before', () => {
  packOn()
  try {
    const s = {
      process_id: 'rt_mined_en', name: 'Design proposal & quote', summary: 'A store design request answered with a floor plan, a proposal and a quote.',
      pattern: { case_count: 4, event_count: 24, main_variant: ['Receive request mail', 'Draw floor plan', 'Write proposal', 'Prepare quote', 'Finance review', 'Reply to customer'] },
      definition: {
        roles: [{ name: 'Sales' }, { name: 'Finance' }],
        events: [{ id: 'start', type: 'startEvent' }, { id: 'end', type: 'endEvent' }],
        activities: ['Receive request mail', 'Draw floor plan', 'Write proposal', 'Prepare quote', 'Finance review', 'Reply to customer'].map((name, i) => ({ id: `a${i}`, name })),
        gateways: [], sequences: [{ id: 's0', source: 'start', target: 'a0' }],
      },
    }
    assert.equal(patternLang(s.pattern), 'en')
    const c = withLang(patternLang(s.pattern), () => buildContract(s))
    noHangul(c, 'English contract')
    assert.ok(c.processDefinition.elements.some((e) => e.agent === agentsIn('ko').drawing.id))
    assert.ok(c.skills.includes('store-design-proposal'), 'the proposal step runs the pack skill')
    assert.equal(c.processDefinition.roles.find((r) => r.name === 'Sales')?.origin, 'created', "the pack's role name for the mail steps")
    // Korean: unchanged words
    const ko = { ...s, pattern: { ...s.pattern, main_variant: ['요청 메일 접수', '고객 회신'] }, definition: { ...s.definition, activities: [{ id: 'a0', name: '요청 메일 접수' }, { id: 'a1', name: '고객 회신' }] } }
    assert.equal(patternLang(ko.pattern), 'ko')
    const kc = buildContract(ko)
    assert.equal(kc.processDefinition.elements.find((e) => e.id === 'start').name, '요청 메일 도착')
    assert.match(kc.processDefinition.description, /프로세스 마이닝이 인계 기록 24건\(케이스 4건\)에서 찾은 흐름을 정식 등록했어요\.$/)
  } finally { packOff() }
})

test('mining without the pack: the same contract has no trade agents, skills or wording — the steps keep the mined roles', () => {
  packOff()
  const s = {
    process_id: 'rt_mined_plain', name: 'n', summary: '',
    pattern: { case_count: 4, event_count: 24, main_variant: ['요청 메일 접수', '평면도 작성', '고객 회신'] },
    definition: { roles: [{ name: '영업' }], events: [{ id: 'start', type: 'startEvent' }, { id: 'end', type: 'endEvent' }],
      activities: [{ id: 'a0', name: '요청 메일 접수' }, { id: 'a1', name: '평면도 작성', role: '디자이너' }, { id: 'a2', name: '고객 회신' }], gateways: [], sequences: [] },
  }
  const c = buildContract(s)
  assert.ok(!c.processDefinition.elements.some((e) => e.agent === '3a6f0c1e-8d2b-4f4a-9c61-0d5e7b2a9f11'), 'no pack agent')
  assert.deepEqual(c.skills, [], 'no pack skills')
  const plan = c.processDefinition.elements.find((e) => e.id === 'a1')
  assert.equal(plan.role, '디자이너', 'the role the cases recorded')
  assert.equal(plan.instruction, '', 'no pack instruction')
  assert.doesNotMatch(JSON.stringify(c.forms), /실별 면적|캐드크래프트|견적 합계/)
})

test('mining: the next mail goes to the registered process of its 업무 범주 — not by step words (2026-11-11)', () => {
  const regs = [
    { name: '요청 메일·견적서 작성', pattern: { category: '교육 일정표' } },
    { name: '행사 견적·고객 회신', pattern: { category: '행사 견적' } },
    { name: '다과 견적·재무 검토', pattern: { category: '행사 견적' } },
  ]
  assert.equal(registeredFor(regs, '교육 일정표')?.name, '요청 메일·견적서 작성', '견적서·단가 같은 낱말이 없는 교육 일정표 메일도')
  assert.equal(registeredFor(regs, '행사 견적')?.name, '행사 견적·고객 회신', '같은 범주가 둘이면 나중에 등록한 것 (regs 순서)')
  assert.equal(registeredFor(regs, '매장 설계'), null, '범주가 맞는 등록 프로세스가 없으면 맡지 않는다')
  assert.equal(registeredFor(regs, ''), null)
})

test('improve demo: the English definition and history have the same ids, timings and numbers, and no Hangul', () => {
  const ko = contract(people)
  const en = contract(people, { lang: 'en' })
  noHangul(en, 'English contract')
  assert.equal(ko.processDefinition.processDefinitionName, DEF_NAME)
  assert.equal(en.processDefinition.processDefinitionName, 'Moonlight Coffee proposal')
  assert.equal(withLang('en', () => defName()), 'Moonlight Coffee proposal')
  const ids = (c) => c.processDefinition.elements.map((e) => `${e.elementType}:${e.id}:${e.source || ''}>${e.target || ''}:${e.agent || ''}`)
  assert.deepEqual(ids(en), ids(ko))
  assert.deepEqual(en.forms.map((f) => f.form_id), ko.forms.map((f) => f.form_id))
  assert.deepEqual(Object.keys(fieldLabels('en')), Object.keys(FIELD_LABELS))
  assert.equal(fieldLabels('en').amount, 'Quote amount')

  const sk = simulate({ people, names: NAMES.ko, ...range })
  const se = simulate({ people, names: NAMES.en, ...range, lang: 'en' })
  assert.equal(se.length, sk.length)
  noHangul(se.map((x) => ({ name: x.name, store: x.store, steps: x.steps.map((s) => [s.activityName, s.username, s.output]) })), 'English history')
  for (let i = 0; i < sk.length; i++) {
    assert.equal(se[i].amount, sk[i].amount)
    assert.deepEqual(se[i].steps.map((s) => [s.activityId, s.start, s.finish]), sk[i].steps.map((s) => [s.activityId, s.start, s.finish]))
  }
  assert.equal(se[0].store, 'Seongsu Store #2')
  assert.equal(sk[0].store, '성수 2호점')
  assert.match(sk[0].steps[0].output.tutd_moonlight_proposal_intake_form.body, /^달빛커피 성수 2호점 매장\(\d+㎡\) 설계 제안과 견적을 부탁드립니다\. 예산은 [\d,]+만원 안팎입니다\.$/)
})

function analysed(lang) {
  const sims = simulate({ people, names: NAMES[lang], ...range, lang })
  const els = contract(people, { lang }).processDefinition.elements
  const def = {
    activities: els.filter((e) => e.elementType === 'Activity').map((e) => ({ id: e.id, name: e.name, role: e.role, type: 'userTask', agentMode: e.agentMode, orchestration: e.orchestration })),
    gateways: els.filter((e) => e.elementType === 'Gateway').map((e) => ({ id: e.id, name: e.name, type: e.type === 'ParallelGateway' ? 'parallelGateway' : 'exclusiveGateway' })),
    events: els.filter((e) => e.elementType === 'Event').map((e) => ({ id: e.id, name: e.name, type: e.type === 'StartEvent' ? 'startEvent' : 'endEvent' })),
    sequences: els.filter((e) => e.elementType === 'Sequence').map((e) => ({ id: e.id, source: e.source, target: e.target, condition: e.condition })),
  }
  const data = { def, instances: [], todos: [], history: [], events: [], now: range.to }
  for (const s of sims) {
    const r = engineRows({ instId: s.instId, defId: 'tutd_moonlight_proposal', steps: s.steps })
    data.instances.push({ id: s.instId, name: s.name, status: 'COMPLETED' })
    data.todos.push(...r.todos); data.history.push(...r.history); data.events.push(...r.events)
  }
  return { a: analyze(data), def }
}

test('improve: the five focusing steps, what-if notes and change texts in English (same numbers); Korean as before', () => {
  const ko = analysed('ko')
  const fk = focusingSteps(ko.a, { labels: { amount: '견적 금액' } })
  assert.equal(fk.steps[0].title, '1. 찾기 — 제약은 어디인가')
  assert.match(fk.steps[0].text, /^재무 검토\(박서연\) 단계가 제약이에요\./)
  const en = analysed('en')
  const fe = withLang('en', () => focusingSteps(en.a, { labels: { amount: 'Quote amount' } }))
  noHangul(fe.steps.map((s) => ({ title: s.title, text: s.text, actions: (s.actions || []).map((x) => [x.title, x.text]) })), 'English focusing steps')
  assert.equal(fe.steps[0].title, '1. Identify — where is the constraint?')
  assert.match(fe.steps[0].text, /^The Finance review step \(Seoyeon Park\) is the constraint\./)
  // the same computation underneath
  assert.deepEqual(fe.steps.map((s) => s.stage), fk.steps.map((s) => s.stage))
  assert.equal(fe.constraint.rho, fk.constraint.rho)

  const changes = [{ type: 'skip', step: 'finance_review', field: 'amount', label: 'Quote amount', threshold: 5e7 }, { type: 'automate', step: 'floor_plan' }, { type: 'capacity', step: 'finance_review', add: 1 }, { type: 'rework', step: 'finance_review' }]
  const w = withLang('en', () => whatIf(en.a, resources(en.a), changes.map((c) => ({ ...c })), { share: { finance_review: 0.4 } }))
  noHangul({ notes: w.notes, changes: w.changes.map((c) => c.text), gateways: w.def.gateways, seqs: w.def.sequences, roles: w.def.roles, instructions: w.def.activities.map((x) => x.instruction), util: w.after.util.map((u) => u.name) }, 'English what-if')
  const wk = whatIf(ko.a, resources(ko.a), changes.map((c) => ({ ...c, label: '견적 금액' })), { share: { finance_review: 0.4 } })
  assert.equal(w.after.leadSec, wk.after.leadSec)
  assert.equal(wk.def.gateways.find((g) => g.id === 'gw_skip_finance_review').name, '견적 금액 기준')
})

test('improve: durations, amounts, change kinds per language', () => {
  assert.deepEqual([5, 300, 7200, 200000].map(dur), ['5초', '5분', '2.0시간', '2.3일'])
  assert.deepEqual(withLang('en', () => [5, 300, 7200, 200000].map(dur)), ['5 s', '5 min', '2.0 h', '2.3 days'])
  assert.deepEqual([5e7, 1.5e8, 30000, 900].map(fmtNum), ['5,000만', '1.5억', '3만', '900'])
  assert.deepEqual(withLang('en', () => [5e7, 1.5e8, 30000, 900].map(fmtNum)), ['50M', '150M', '30K', '900'])
  assert.equal(changeTypes(), CHANGE_TYPES)
  noHangul(withLang('en', () => changeTypes()), 'English change kinds')
  const def = { activities: [{ id: 'r', name: 'Finance review' }] }
  noHangul(withLang('en', () => ['automate', 'predraft', 'skip', 'parallel', 'capacity', 'rework'].map((type) => describeChange({ type, step: 'r', field: 'amount', threshold: 5e7 }, def))), 'English change texts')
  assert.equal(describeChange({ type: 'capacity', step: 'r', add: 2 }, { activities: [{ id: 'r', name: '재무 검토' }] }), '재무 검토 — 담당 2명 추가')
})
