// 단계의 꼭 · 선택(lib/ontology/steprule.js): 사안에 따른 규칙 맞추기(금액 · 글로 쓴 조건 · 차례), 관문의 판단(방식 × 꼭 · 선택 × 이 건에 필요한지),
// 꼭 하는 단계는 스냅샷에 늘, 건너뛴 단계로 되감기, 꼭 하는 단계를 지나치는 옮기기. 모델 · DB 없이(글 조건의 확률은 넣어 준다).
import test from 'node:test'
import assert from 'node:assert/strict'
import { normRule, ruleText, won, amountMatch, pickRequirement, reqLine, suggestionOf, requiredView, pathBetween, passedRequired, settingLines, needText, skipReason } from '../lib/ontology/steprule.js'
import { decideStep, rewindCheck, stepState, whyLines } from '../lib/ontology/runmode.js'
import { unfold } from '../lib/ontology/run.js'
import { END } from '../lib/ontology/refine.js'
import { defaultRules } from '../lib/ontology/discovery.js'

const R = defaultRules().stepRules
const amt = (op, value, then = 'required') => ({ when: { field: 'amount', op, value }, then })
const txt = (text, then = 'required') => ({ when: { text }, then })

test('규칙 읽기: 금액(네 가지 비교 · 값) 또는 글로 쓴 조건, 그리고 꼭 · 선택 — 아니면 읽지 못함', () => {
  assert.deepEqual(normRule({ when: { field: 'amount', op: '>=', value: '10,000,000' }, then: 'required' }), amt('>=', 10000000))
  assert.deepEqual(normRule({ when: { text: '  외부 고객에게   처음 나가는 제안이면 ' }, then: 'optional' }), txt('외부 고객에게 처음 나가는 제안이면', 'optional'))
  assert.equal(normRule({ when: { field: 'amount', op: '==', value: 1 }, then: 'required' }), null)
  assert.equal(normRule({ when: { field: 'amount', op: '>=', value: '' }, then: 'required' }), null)
  assert.equal(normRule({ when: { field: 'amount', op: '>=', value: 5 }, then: 'maybe' }), null)
  assert.equal(normRule({ when: { text: '   ' }, then: 'required' }), null)
  assert.equal(won(12000000), '1,200만원')
  assert.equal(won(120000000), '1억 2,000만원')
  assert.equal(won(3500), '3,500원')
  assert.equal(ruleText(amt('>=', 10000000)), '금액 1,000만원 이상 → 꼭')
  assert.equal(ruleText(txt('외부 고객에게 처음 나가는 제안이면', 'optional')), '「외부 고객에게 처음 나가는 제안이면」 → 선택')
})

test('금액 규칙: 이상 · 초과 · 이하 · 미만, 금액이 없는 건은 맞지 않고 그렇다고 보인다', () => {
  assert.equal(amountMatch({ op: '>=', value: 100 }, 100).match, true)
  assert.equal(amountMatch({ op: '>', value: 100 }, 100).match, false)
  assert.equal(amountMatch({ op: '<=', value: 100 }, 100).match, true)
  assert.equal(amountMatch({ op: '<', value: 100 }, 100).match, false)
  assert.equal(amountMatch({ op: '>=', value: 10000000 }, 12000000).text, '금액 1,200만원 ≥ 1,000만원')
  assert.equal(amountMatch({ op: '>=', value: 10000000 }, 3000000).text, '금액 300만원 < 1,000만원')
  const none = amountMatch({ op: '>=', value: 10000000 }, null)
  assert.deepEqual([none.match, none.text], [null, '이 건에는 금액이 없어요'])
  // 금액이 없으면 그 규칙은 맞지 않고 기본 정책으로 — 왜 그런지 줄에 보인다
  const r = pickRequirement({ requirement: 'optional', rules: [amt('>=', 10000000)] }, { amount: null }, R)
  assert.deepEqual([r.requirement, r.from, r.matched], ['optional', 'base', null])
  assert.match(reqLine(r), /해도 되고 안 해도 되는 단계예요 — 맞는 규칙이 없어 기본대로 \(이 건에는 금액이 없어/)
})

test('사안에 따라: 위에서부터 맞는 첫 규칙 — 없으면 단계의 기본 정책, 줄에 무엇이 맞았는지', () => {
  const set = { requirement: 'optional', rules: [amt('>=', 50000000), amt('>=', 10000000), amt('<', 10000000, 'optional')] }
  const a = pickRequirement(set, { amount: 12000000 }, R)
  assert.deepEqual([a.requirement, a.from, a.matched.i], ['required', 'rule', 1])
  assert.equal(reqLine(a), '이 건은 금액 1,200만원 ≥ 1,000만원이라 꼭 하는 단계예요')
  assert.deepEqual(a.checked.map((c) => c.match), [false, true])
  // 차례가 먼저: 같은 금액이라도 앞의 규칙이 맞으면 그것
  const b = pickRequirement({ requirement: null, rules: [amt('>=', 1000, 'optional'), amt('>=', 10000000)] }, { amount: 12000000 }, R)
  assert.deepEqual([b.requirement, b.matched.i], ['optional', 0])
  const c = pickRequirement({ requirement: null, rules: [amt('>=', 50000000)] }, { amount: 12000000 }, R)
  assert.deepEqual([c.requirement, c.from], [null, null])
  assert.equal(reqLine(c), '맞는 규칙이 없어 지도대로 해요')
  assert.equal(reqLine(pickRequirement({ requirement: 'required', rules: [] }, {}, R)), '꼭 하는 단계예요')
})

test('글로 쓴 조건: 확률이 문턱(rules.stepRules.textMatch) 이상이면 맞음 — 맞는 첫 규칙까지만 읽는다, 못 읽으면 맞지 않음', () => {
  assert.equal(R.textMatch, 0.6)
  const set = { requirement: 'optional', rules: [txt('외부 고객에게 처음 나가는 제안이면'), amt('>=', 10000000), txt('재계약이면', 'optional')] }
  // 첫 글 조건은 아직 읽지 않았다 → 읽어 달라고 한다
  assert.deepEqual(pickRequirement(set, { amount: 12000000, odds: [] }, R), { pending: 0, checked: [] })
  // 문턱보다 낮으면 다음 규칙(금액)이 맞는다 — 셋째(글 조건)는 읽지 않는다
  const low = pickRequirement(set, { amount: 12000000, odds: [{ p: 0.42, measured: true }] }, R)
  assert.deepEqual([low.requirement, low.matched.kind, low.checked.length], ['required', 'amount', 2])
  const hi = pickRequirement(set, { amount: null, odds: [{ p: 0.87, measured: true }] }, R)
  assert.deepEqual([hi.requirement, hi.matched.kind, hi.matched.p], ['required', 'text', 0.87])
  assert.equal(reqLine(hi), '이 건은 「외부 고객에게 처음 나가는 제안이면」에 해당해서(87%) 꼭 하는 단계예요')
  // 문턱 그대로는 맞음, 바로 아래는 아님
  assert.equal(pickRequirement({ rules: [txt('x')] }, { odds: [{ p: 0.6 }] }, R).requirement, 'required')
  assert.equal(pickRequirement({ rules: [txt('x')] }, { odds: [{ p: 0.59 }] }, R).requirement, null)
  // 못 읽은 글 조건(null): 맞지 않고 다음으로, 그렇다고 줄에
  const unread = pickRequirement({ requirement: 'optional', rules: [txt('외부 고객이면')] }, { odds: [null] }, R)
  assert.deepEqual([unread.requirement, unread.checked[0].match], ['optional', null])
  assert.match(reqLine(unread), /「외부 고객이면」 — 읽지 못했어요/)
})

test('관문의 판단 표: 방식 × 꼭 · 선택 × 이 건에 필요한지 — 선택은 낮으면 건너뜀 · 애매하면 묻기, 단계마다는 늘 묻기, 꼭은 절대 건너뛰지 않음', () => {
  const band = R.need
  assert.deepEqual(band, { skipBelow: 0.25, runAbove: 0.6 })
  const at = (o) => decideStep({ band, requirement: 'optional', ...o })
  // 사람이 지켜봄 · 에이전트 단계
  assert.deepEqual(at({ mode: 'hotl', kind: 'agent', need: 0.1 }), { act: 'skip', why: ['optional'] })
  assert.deepEqual(at({ mode: 'hotl', kind: 'agent', need: 0.4 }), { act: 'wait', why: ['optional'] })
  assert.deepEqual(at({ mode: 'hotl', kind: 'agent', need: null }), { act: 'wait', why: ['optional'] }) // 못 읽으면 묻는다
  assert.deepEqual(at({ mode: 'hotl', kind: 'agent', need: 0.8 }), { act: 'run', why: [] })
  // 사람이 지켜봄 · 사람 단계: 건너뛰면 그 사람 목록에 남지 않게(엔진에서 끝냄), 애매하면 목록에 보이기 전에 묻는다
  assert.deepEqual(at({ mode: 'hotl', kind: 'person', need: 0.1 }), { act: 'skip', why: ['optional'] })
  assert.deepEqual(at({ mode: 'hotl', kind: 'person', need: 0.4 }), { act: 'wait', why: ['optional'], hold: true })
  assert.deepEqual(at({ mode: 'hotl', kind: 'person', need: 0.9 }), { act: 'person', why: [] })
  assert.deepEqual(at({ mode: 'hotl', kind: 'draft', need: 0.4 }), { act: 'wait', why: ['optional'], hold: true })
  // 단계마다 사람이 정함: 필요해 보여도 · 아니어도 늘 진행 · 건너뛰기를 묻는다
  for (const need of [0.05, 0.5, 0.95, null]) {
    assert.deepEqual(at({ mode: 'hitl', kind: 'agent', need }), { act: 'wait', why: ['hitl', 'optional'] })
    assert.deepEqual(at({ mode: 'hitl', kind: 'person', need }), { act: 'wait', why: ['hitl', 'optional'], hold: true })
    assert.deepEqual(at({ mode: 'hitl', kind: 'draft', need }), { act: 'wait', why: ['hitl', 'optional'], hold: true })
  }
  // 멈춘 건: 에이전트는 건너뛰지도 않는다(멈춤이 먼저) · 사람이 「진행」한 단계는 다시 읽지 않는다
  assert.deepEqual(at({ mode: 'hotl', kind: 'agent', need: 0.1, paused: true }), { act: 'wait', why: ['paused'] })
  assert.deepEqual(at({ mode: 'hitl', kind: 'agent', need: 0.1, approved: true }), { act: 'run', why: [] })
  assert.deepEqual(at({ mode: 'hitl', kind: 'person', need: 0.1, approved: true }), { act: 'person', why: [] })
  // 되돌릴 수 없는 선택 단계: 나갈 것을 먼저 만들고 묻는다(보내기 · 건너뛰기)
  const out = at({ mode: 'hotl', kind: 'agent', need: 0.4, irreversible: true })
  assert.deepEqual([out.act, out.draftFirst, out.why], ['run', true, ['irreversible', 'optional']])
  // 꼭 하는 단계: 무엇을 넣어도 건너뛰지 않고, 정하지 않은 단계와 똑같이 판단한다(누가 하는지 · 묻는지는 그대로)
  for (const mode of ['hotl', 'hitl']) for (const kind of ['agent', 'draft', 'person']) for (const responsible of [false, true]) for (const irreversible of [false, true]) for (const need of [0, 0.5, 1, null]) {
    const base = decideStep({ mode, kind, responsible, irreversible })
    const req = decideStep({ mode, kind, responsible, irreversible, requirement: 'required', need, band })
    assert.notEqual(req.act, 'skip')
    assert.deepEqual(req, base, JSON.stringify({ mode, kind, responsible, irreversible, need }))
  }
  // 정하지 않은 단계(지도대로)는 지금과 같다
  assert.deepEqual(decideStep({ mode: 'hotl', kind: 'agent', need: 0 }), { act: 'run', why: [] })
})

test('묻는 줄: 선택 단계는 이 건에 필요할 확률을, 건너뛴 까닭은 그 확률과 맞은 규칙을', () => {
  assert.deepEqual(whyLines(['hitl', 'optional'], null, { need: { p: 0.45, measured: true } }), ['단계마다 사람이 정하는 방식이에요', '해도 되고 안 해도 되는 단계 — 이 건에 필요할 확률 45%'])
  assert.equal(needText({ p: null }), '이 건에 필요한지 읽지 못했어요')
  assert.equal(needText({ p: 1, forced: true, why: '사람이 이 단계로 되감아서 해요' }), '사람이 이 단계로 되감아서 해요')
  const req = { need: { p: 0.12, measured: true }, matched: { kind: 'amount' }, line: '이 건은 금액 300만원 < 1,000만원이라 해도 되고 안 해도 되는 단계예요' }
  assert.equal(skipReason(req), '이 건에는 하지 않아도 돼 보여요(이 건에 필요할 확률 12%) — 이 건은 금액 300만원 < 1,000만원이라 해도 되고 안 해도 되는 단계예요')
})

test('꼭 하는 단계는 스냅샷에 늘(이 프로세스에서는 고정과 같다) — 꼭이 될 수 있는 규칙만 있어도, 정한 것이 바뀌면 스냅샷 열쇠도', () => {
  const t = (key, extra = {}) => ({ key, role: '담당', n: 5, status: 'active', ...extra })
  const e = (from, to, p) => ({ from, to, n: Math.round(p * 100), p, status: 'active' })
  const view = { proc: { key: 'p', name: 'P', tasks: ['A', 'B', 'C'], entries: ['A'], theta: 0.05 }, tasks: new Map([['A', t('A')], ['B', t('B')], ['C', t('C', { pin_reason: '' })]]),
    edges: [e('A', 'B', 0.97), e('A', 'C', 0.03), e('B', END, 1), e('C', END, 1)] }
  assert.deepEqual(unfold(view, 'A', 0.05).nodes, ['A', 'B']) // 드문 C 는 θ 아래
  const req = requiredView(view, [{ task: 'C', requirement: 'required', rules: [] }])
  assert.ok(unfold(req, 'A', 0.05).nodes.includes('C'))
  assert.deepEqual([req.tasks.get('C').pinned, req.tasks.get('C').required, req.tasks.get('C').pin_reason], [true, true, '꼭 하는 단계'])
  assert.equal(view.tasks.get('C').pinned, undefined) // 지도의 일은 그대로
  // 기본은 선택이어도 「금액 … 이상이면 꼭」 규칙이 있으면 스냅샷에 든다(그 건에서 선택이면 열릴 때 건너뛸 수 있다)
  const cond = requiredView(view, [{ task: 'C', requirement: 'optional', rules: [amt('>=', 10000000)] }])
  assert.ok(unfold(cond, 'A', 0.05).nodes.includes('C'))
  // 선택만이면 지도대로 θ 를 따른다
  const opt = requiredView(view, [{ task: 'C', requirement: 'optional', rules: [] }])
  assert.deepEqual(unfold(opt, 'A', 0.05).nodes, ['A', 'B'])
  // 정한 것이 바뀌면 열쇠가 바뀐다(새 스냅샷)
  assert.ok(req.requirements && cond.requirements && opt.requirements)
  assert.equal(new Set([req.requirements, cond.requirements, opt.requirements]).size, 3)
  assert.equal(requiredView(view, []), view)
  // 다듬은 흐름에서 이름이 바뀐 단계: 찾은 이름(origin)으로 정한 것도 맞는다
  const renamed = { ...view, tasks: new Map([...view.tasks].map(([k, x]) => (k === 'C' ? ['C2', { ...x, key: 'C2', origin: 'C' }] : [k, x]))) }
  assert.equal(requiredView(renamed, [{ task: 'C', requirement: 'required', rules: [] }]).tasks.get('C2').required, true)
})

test('건너뛴 단계: 지켜보기에 「건너뜀」, 이 단계로 되감기로 다시 할 수 있다', () => {
  assert.equal(stepState({ status: 'SUBMITTED' }, { state: 'skipped' }), 'skipped')
  assert.equal(stepState({ status: 'DONE' }, { state: 'skipped' }), 'skipped')
  const steps = [{ task: '강의계획서 작성', state: 'done' }, { task: '강의자료 준비', state: 'skipped' }, { task: '고객 회신', state: 'done', sent: true }, { task: '교육 진행', state: 'person' }]
  const r = rewindCheck('강의자료 준비', steps)
  assert.deepEqual(r, { ok: true, confirm: true, lost: ['고객 회신'], redo: ['강의자료 준비', '고객 회신'] })
  assert.equal(rewindCheck('교육 진행', steps).ok, true)
})

test('다른 일로 옮기기가 지나치는 꼭 하는 단계: 지금 자리에서 고른 일까지 가장 흔한 길 위의, 아직 하지 않은 것', () => {
  const e = (from, to, p, extra = {}) => ({ from, to, p, status: 'active', ...extra })
  const edges = [e('접수', '견적', 0.9), e('견적', '내부 검토', 0.6), e('견적', '회신', 0.4), e('내부 검토', '회신', 1), e('회신', '계약', 1), e('계약', END, 1)]
  assert.deepEqual(pathBetween(edges, '접수', '계약'), ['접수', '견적', '내부 검토', '회신'])
  assert.deepEqual(passedRequired({ edges, from: '견적', to: '계약', required: ['내부 검토', '계약'] }), ['내부 검토'])
  assert.deepEqual(passedRequired({ edges, from: '견적', to: '계약', required: ['내부 검토'], done: ['내부 검토'] }), [])
  // 지금 단계가 꼭이면 그것도(아직 하지 않았으니 지나친다)
  assert.deepEqual(passedRequired({ edges, from: '견적', to: '회신', required: ['견적'] }), ['견적'])
  // 길이 없으면(뒤로 · 닿지 않는 일) 지나치는 것도 없다
  assert.deepEqual(passedRequired({ edges, from: '계약', to: '견적', required: ['견적', '회신'] }), [])
  // 사람이 정한 길(다듬기에서 더한 길, p 0)도 길이다
  assert.deepEqual(pathBetween([e('A', 'B', 0, { decided: true }), e('B', 'C', 0, { decided: true })], 'A', 'C'), ['A', 'B'])
})

test('AI 제안: 다듬기의 단계 분류에서(새 모델 호출 없이) — 관문 · 건너뛰었지만 해야 함은 꼭, 걷어냄은 선택, 사람이 정한 분류가 먼저', () => {
  assert.deepEqual(suggestionOf({ class: 'gate', why: '지급 승인', decided: false }, R), { requirement: 'required', class: 'gate', why: '지급 승인', by: 'ai' })
  assert.equal(suggestionOf({ class: 'drop', why: '전달만 함' }, R).requirement, 'optional')
  assert.equal(suggestionOf({ class: 'skipped', why: '기록엔 없지만 해야 함' }, R).requirement, 'required')
  assert.equal(suggestionOf({ class: 'human' }, R), null)
  assert.equal(suggestionOf(null, R), null)
  // 사람이 다듬기에서 「꼭 하는 관문」으로 정했으면 그것(AI 는 걷어냄이라 했어도)
  const s = suggestionOf({ class: 'gate', decided: true, by: 'person', why: '사람이 정함', ai: { class: 'drop', why: '전달' } }, R)
  assert.deepEqual([s.requirement, s.by], ['required', 'person'])
  // 정하지 않았으면 AI 의 판단(ai 칸)
  assert.equal(suggestionOf({ class: 'none', decided: false, ai: { class: 'drop', why: '전달' } }, R).requirement, 'optional')
})

test('패널의 설명 줄: 꼭 · 선택 · 지도대로와 사안에 따른 규칙', () => {
  assert.match(settingLines({ requirement: 'required' })[0], /^꼭 하는 단계예요/)
  assert.match(settingLines({ requirement: 'required' })[1], /누가 하는지는 그대로/)
  assert.match(settingLines({ requirement: 'optional' })[0], /^해도 되고 안 해도 되는 단계예요/)
  const lines = settingLines({ requirement: 'optional', rules: [amt('>=', 10000000)] })
  assert.ok(lines.includes('사안에 따라(위에서부터 맞는 첫 규칙): 1. 금액 1,000만원 이상 → 꼭'))
  assert.ok(lines.includes('맞는 규칙이 없으면 해도 되고 안 해도 되는 단계예요.'))
  assert.ok(lines.some((l) => /스냅샷이 늘 지나가요/.test(l)))
  assert.deepEqual(settingLines({}), ['지도대로 해요 — 찾은 흐름대로 지나가요.'])
})
