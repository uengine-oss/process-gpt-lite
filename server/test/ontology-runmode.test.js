// 실행 방식(lib/ontology/runmode.js): 사람이 지켜봄(HOTL) · 단계마다 사람이 정함(HITL)의 멈춤 · 진행 판단(방식 × 단계 종류 × 되돌릴 수 있음),
// 도중에 방식 바꾸기, 되감기 규칙, 「다음은 X예요」의 근거, 다듬은 흐름으로 스냅샷 펴기. 모델 · DB 없이.
import test from 'node:test'
import assert from 'node:assert/strict'
import { decideStep, irreversibleOf, responsibleOf, afterSwitch, rewindCheck, proposalOf, stepState, whyLines } from '../lib/ontology/runmode.js'
import { refinedView, applyCorrections, normFix, labelOf, END } from '../lib/ontology/refine.js'
import { unfold } from '../lib/ontology/run.js'
import { defaultRules } from '../lib/ontology/discovery.js'

const R = defaultRules().runMode

test('사람이 지켜봄: 되돌릴 수 있고 책임 단계가 아니면 에이전트가 묻지 않고 한다', () => {
  assert.deepEqual(decideStep({ mode: 'hotl', kind: 'agent' }), { act: 'run', why: [] })
  // 사람 단계의 초안도 저절로(초안은 되돌릴 수 있다), 사람 단계는 그 사람의 할 일로 넘어간다
  assert.deepEqual(decideStep({ mode: 'hotl', kind: 'draft' }), { act: 'run', why: [] })
  assert.deepEqual(decideStep({ mode: 'hotl', kind: 'person', responsible: true }), { act: 'person', why: [] })
})

test('사람이 지켜봄: 책임 단계를 에이전트가 하게 되면 멈춰 묻는다', () => {
  assert.deepEqual(decideStep({ mode: 'hotl', kind: 'agent', responsible: true }), { act: 'wait', why: ['responsible'] })
})

test('되돌릴 수 없는 단계: 사람이 지켜봄이어도 나갈 것을 초안으로 만든 뒤 묻는다 — 따로 「묻지 않고 진행」으로 정했을 때만 그냥 간다', () => {
  assert.deepEqual(decideStep({ mode: 'hotl', kind: 'agent', irreversible: true }), { act: 'run', why: ['irreversible'], draftFirst: true })
  assert.deepEqual(decideStep({ mode: 'hotl', kind: 'agent', irreversible: true, policy: 'auto' }), { act: 'run', why: [] })
  // 책임 단계이기도 하면 질문은 하나(초안을 보고 정한다)
  assert.deepEqual(decideStep({ mode: 'hotl', kind: 'agent', irreversible: true, responsible: true }), { act: 'run', why: ['responsible', 'irreversible'], draftFirst: true })
  // 「묻지 않고 진행」은 되돌릴 수 없음만 풀고, 책임 단계는 그대로 묻는다
  assert.deepEqual(decideStep({ mode: 'hotl', kind: 'agent', irreversible: true, responsible: true, policy: 'auto' }), { act: 'wait', why: ['responsible'] })
  // 「늘 묻기」로 정한 단계
  assert.deepEqual(decideStep({ mode: 'hotl', kind: 'agent', policy: 'ask' }), { act: 'wait', why: ['ask'] })
})

test('단계마다 사람이 정함: 모든 단계에서 묻는다 — 사람 단계는 정할 때까지 그 사람 목록에 보이지 않게', () => {
  assert.deepEqual(decideStep({ mode: 'hitl', kind: 'agent' }), { act: 'wait', why: ['hitl'] })
  assert.deepEqual(decideStep({ mode: 'hitl', kind: 'draft' }), { act: 'wait', why: ['hitl'], hold: true })
  assert.deepEqual(decideStep({ mode: 'hitl', kind: 'person' }), { act: 'wait', why: ['hitl'], hold: true })
  // 되돌릴 수 없는 단계는 초안 먼저, 질문 하나에 까닭 둘
  assert.deepEqual(decideStep({ mode: 'hitl', kind: 'agent', irreversible: true }), { act: 'run', why: ['irreversible', 'hitl'], draftFirst: true })
  // 사람이 「진행」이라고 한 단계는 다시 묻지 않는다
  assert.deepEqual(decideStep({ mode: 'hitl', kind: 'agent', approved: true }), { act: 'run', why: [] })
  assert.deepEqual(decideStep({ mode: 'hitl', kind: 'person', approved: true }), { act: 'person', why: [] })
})

test('멈추기: 에이전트는 다음 단계를 잡지 않는다(초안도) — 사람은 자기 단계를 할 수 있다', () => {
  for (const mode of ['hotl', 'hitl']) {
    assert.deepEqual(decideStep({ mode, kind: 'agent', paused: true }), { act: 'wait', why: ['paused'] })
    assert.deepEqual(decideStep({ mode, kind: 'draft', paused: true }), { act: 'wait', why: ['paused'] })
  }
  assert.equal(decideStep({ mode: 'hotl', kind: 'person', paused: true }).act, 'person')
})

test('표 전체: 방식 × 종류 × 책임 × 되돌릴 수 없음 — 사람이 지켜봄에서 묻는 곳은 책임 · 되돌릴 수 없음뿐, 단계마다는 늘', () => {
  for (const kind of ['agent', 'draft', 'person']) for (const responsible of [false, true]) for (const irreversible of [false, true]) {
    const hotl = decideStep({ mode: 'hotl', kind, responsible, irreversible })
    const hitl = decideStep({ mode: 'hitl', kind, responsible, irreversible })
    const asksHotl = hotl.act === 'wait' || !!hotl.draftFirst
    assert.equal(asksHotl, kind === 'agent' && (responsible || irreversible), JSON.stringify({ kind, responsible, irreversible, hotl }))
    assert.ok(hitl.act === 'wait' || hitl.draftFirst, JSON.stringify({ kind, responsible, irreversible, hitl }))
  }
})

test('되돌릴 수 없음은 규칙이 먼저: 일 정의 > 기록(한 번이라도 밖으로 갔으면) > 일 이름', () => {
  assert.equal(irreversibleOf({ name: '강의계획서 작성', front: { irreversible: true } }, R).by, 'definition')
  assert.equal(irreversibleOf({ name: '고객 회신', front: { irreversible: false } }, R).on, false)
  assert.equal(irreversibleOf({ name: '자료 정리', front: { sends: 'outside' } }, R).on, true)
  const out = irreversibleOf({ name: '고객 회신', records: { sent: 10, outside: 9, to: ['고객'] } }, R)
  assert.deepEqual([out.on, out.by], [true, 'records'])
  assert.match(out.why, /10건 중 9건이 회사 밖\(고객\)/)
  // 회사가 보낸 기록이 넉넉히 있고 대부분 안이면 이름에 「회신」이 있어도 회사 안
  assert.deepEqual([irreversibleOf({ name: '질문사항 회신', records: { sent: 5, outside: 1 } }, R).on, irreversibleOf({ name: '질문사항 회신', records: { sent: 5, outside: 1 } }, R).by], [false, 'records'])
  // 기록이 한 건뿐이어도 그게 밖으로 갔으면 되돌릴 수 없다(안전한 쪽)
  assert.equal(irreversibleOf({ name: '자료 전달', records: { sent: 1, outside: 1, to: ['고객'] } }, R).on, true)
  // 기록이 모자라면 일 이름
  assert.deepEqual([irreversibleOf({ name: '뉴스레터 발송' }, R).on, irreversibleOf({ name: '뉴스레터 발송' }, R).by], [true, 'words'])
  assert.deepEqual([irreversibleOf({ name: '강의자료 준비' }, R).on, irreversibleOf({ name: '강의자료 준비' }, R).by], [false, 'default'])
  // 대화(받는 사람 없는 기록)만 있는 일: 회사 안
  assert.equal(irreversibleOf({ name: '강의계획서 작성', records: null }, R).on, false)
})

test('책임 단계: 다듬기에서 사람이 정한 분류가 조직의 말 — AI 제안 · AI 후보의 까닭 · 관문 고정 · 일 정의(사람)', () => {
  assert.equal(responsibleOf({ cls: { class: 'human', decided: true } }).on, true)
  assert.equal(responsibleOf({ cls: { class: 'gate', decided: false } }).on, true)
  assert.match(responsibleOf({ cls: { class: 'gate', decided: false } }).why[0], /AI 제안/)
  assert.equal(responsibleOf({ human: [{ key: 'relationship', name: '직접 만나는 일', why: '관계와 협상은 사람이 한다' }] }).on, true)
  assert.equal(responsibleOf({ pinnedGate: true }).on, true)
  assert.equal(responsibleOf({ runner: 'person' }).on, true)
  assert.equal(responsibleOf({ runner: 'agent', cls: { class: 'ai', decided: false } }).on, false)
  // 사람이 「AI가 맡음」으로 정했으면 AI 후보의 「사람이 꼭」 까닭이 있어도 책임 단계가 아니다
  assert.equal(responsibleOf({ cls: { class: 'ai', decided: true }, human: [{ key: 'relationship', name: '직접 만나는 일' }] }).on, false)
})

test('도중에 방식 바꾸기: 단계마다 그때 읽는다 — 바꾸면 다음 단계부터, 기다리던 단계도 다시 본다, 다시 바꾸면 돌아간다', () => {
  // 건 하나: 단계 A · B · C (모두 되돌릴 수 있는 에이전트 단계)
  let mode = 'hotl'
  const a = decideStep({ mode, kind: 'agent' })
  assert.equal(a.act, 'run')
  mode = 'hitl' // A 가 도는 동안 바꿈 → A 는 그대로, B 부터 묻는다
  const b = decideStep({ mode, kind: 'agent' })
  assert.deepEqual(b, { act: 'wait', why: ['hitl'] })
  // 다시 사람이 지켜봄으로: 확인만 기다리던 B 는 그대로 진행, 다른 까닭도 있던 단계는 그 까닭으로 계속 기다린다
  mode = 'hotl'
  const back = afterSwitch([{ id: 'B', why: ['hitl'] }, { id: 'X', why: ['irreversible', 'hitl'] }, { id: 'Y', why: ['responsible'] }], mode)
  assert.deepEqual(back, [{ id: 'B', release: true, why: [] }, { id: 'X', keep: true, why: ['irreversible'] }, { id: 'Y', keep: true, why: ['responsible'] }])
  assert.equal(decideStep({ mode, kind: 'agent' }).act, 'run') // C
  // 단계마다로 바꾸면 기다리던 것은 그대로(다음 단계가 묻는다)
  assert.ok(afterSwitch([{ id: 'Y', why: ['responsible'] }], 'hitl').every((x) => x.keep))
})

test('되감기: 이 건이 닿은 단계로만 · 요청 접수는 안 됨 · 그 뒤에 밖으로 보낸 단계가 있으면 확인을 받는다', () => {
  const steps = [
    { task: '강의계획서 작성', state: 'done' }, { task: '강의자료 준비', state: 'done' }, { task: '고객 회신', state: 'done', sent: true },
    { task: '교육 진행', state: 'person' },
  ]
  assert.equal(rewindCheck('요청 접수', steps).ok, false)
  assert.equal(rewindCheck('평가 정리', steps).ok, false)
  assert.match(rewindCheck('평가 정리', steps).why, /다른 일로 옮기기/)
  const r = rewindCheck('강의자료 준비', steps)
  assert.deepEqual(r, { ok: true, confirm: true, lost: ['고객 회신'], redo: ['강의자료 준비', '고객 회신'] })
  // 보낸 단계보다 뒤로 되감으면 되돌아오지 않는 것이 없다
  assert.deepEqual(rewindCheck('교육 진행', steps), { ok: true, confirm: false, lost: [], redo: [] })
  // 아직 닿지 않은 단계(다음 차례) · 옮기며 닫힌 단계로는 안 된다
  assert.equal(rewindCheck('x', [{ task: 'x', state: 'next' }]).ok, false)
  assert.equal(rewindCheck('x', [{ task: 'x', state: 'closed' }]).ok, false)
  // 한 번 되감은 건: 가장 나중에 닿은 그 단계부터 본다(앞서 보낸 것은 이번 되감기로 잃지 않는다)
  const again = [...steps.slice(0, 3), { task: '교육 진행', state: 'closed' }, { task: '강의자료 준비', state: 'done' }, { task: '고객 회신', state: 'waiting' }]
  assert.deepEqual(rewindCheck('강의자료 준비', again), { ok: true, confirm: false, lost: [], redo: ['강의자료 준비'] })
})

test('「다음은 X예요」의 근거: 갈림길이면 갈림길 조건(자신 있는 것) · 아니면 지난 건의 몫, 엔진이 말한 까닭이 먼저', () => {
  const outs = [{ to: '재무 검토', p: 0.3 }, { to: '고객 회신', p: 0.6 }, { to: END, p: 0.1 }]
  const conds = new Map([['재무 검토', { cond: '견적이 1천만 원 이상이면', confidence: 'high' }], ['고객 회신', { cond: '그 밖에', confidence: 'low' }]])
  const a = proposalOf({ from: '견적서 작성', to: '재무 검토', outs, conds })
  assert.equal(a.split, true)
  assert.equal(a.why, '견적이 1천만 원 이상이면')
  assert.deepEqual(a.others, [{ to: '고객 회신', p: 0.6, cond: '그 밖에' }])
  assert.equal(a.end, true)
  // 자신 없는 조건은 근거로 쓰지 않는다(지난 건의 몫으로)
  assert.equal(proposalOf({ from: '견적서 작성', to: '고객 회신', outs, conds }).why, '지난 건의 60%가 이쪽으로 갔어요')
  assert.equal(proposalOf({ from: '견적서 작성', to: '고객 회신', outs, conds, engineWhy: '금액이 900만 원이라 1천만 원 미만' }).why, '금액이 900만 원이라 1천만 원 미만')
  const one = proposalOf({ from: '강의자료 준비', to: '고객 회신', outs: [{ to: '고객 회신', p: 0 }] })
  assert.deepEqual([one.split, one.others, one.why], [false, [], '이 흐름의 다음 단계예요'])
  assert.deepEqual(whyLines(['irreversible', 'hitl'], { irreversible: { why: '회사가 보낸 기록 10건 중 9건이 회사 밖(고객)으로 갔어요' } }),
    ['되돌릴 수 없는 단계 — 회사가 보낸 기록 10건 중 9건이 회사 밖(고객)으로 갔어요', '단계마다 사람이 정하는 방식이에요'])
})

test('지켜보기의 단계 상태: 끝남 · 에이전트가 하는 중 · 사람 차례 · 기다림 · 닫힘 · 다음', () => {
  assert.equal(stepState(null, null), 'next')
  assert.equal(stepState({ status: 'DONE' }), 'done')
  assert.equal(stepState({ status: 'SUBMITTED' }), 'done')
  assert.equal(stepState({ status: 'CANCELLED' }), 'closed')
  assert.equal(stepState({ status: 'IN_PROGRESS', agent_orch: 'pgpt-pro-onto', draft_status: 'HUMAN_ASKED' }, { state: 'waiting' }), 'waiting')
  assert.equal(stepState({ status: 'IN_PROGRESS', agent_orch: 'pgpt-pro-onto', agent_mode: 'COMPLETE', draft_status: 'STARTED' }), 'running')
  assert.equal(stepState({ status: 'IN_PROGRESS', agent_orch: 'pgpt-pro-onto', agent_mode: 'DRAFT', draft_status: 'COMPLETED' }), 'person')
  assert.equal(stepState({ status: 'IN_PROGRESS' }), 'person')
  assert.equal(stepState({ status: 'TODO' }), 'next')
})

// 「강의계획서 작성 · 보고」 as found on jy-mail (the numbers of the real map) and the corrections the run uses
const lectureBase = () => {
  const t = (key, role, n, extra = {}) => ({ key, role, n, status: 'active', ...extra })
  const tasks = [t('교육 진행', '개발', 2), t('강의계획서 작성', '전무', 9), t('작업 내용 보고', '개발', 104), t('강의자료 준비', '전무', 3), t('강의 준비', '전무', 2), t('강의 계획 공유', '전무', 1)]
  const e = (from, to, n, p, extra = {}) => ({ from, to, n, p, status: 'active', ...extra })
  const edges = [
    e('강의 준비', '강의계획서 작성', 1, 0.5, { parallel: true }), e('강의 준비', '작업 내용 보고', 1, 0.5), e('교육 진행', '작업 내용 보고', 1, 0.5),
    e('강의계획서 작성', '작업 내용 보고', 2, 0.22), e('강의계획서 작성', '강의 준비', 1, 0.11), e('강의 계획 공유', '작업 내용 보고', 1, 1),
    e('교육 진행', '강의계획서 작성', 1, 0.5), e('작업 내용 보고', '강의계획서 작성', 2, 0.02), e('강의계획서 작성', '강의자료 준비', 1, 0.11),
    e('강의자료 준비', '강의 준비', 1, 0.33), e('강의자료 준비', '강의 계획 공유', 1, 0.33), e('강의계획서 작성', END, 5, 0.45), e('작업 내용 보고', END, 27, 0.26),
    e('강의자료 준비', END, 2, 0.67), e('교육 진행', END, 1, 0.5),
  ]
  const global = [...tasks, t('고객 회신', '프로젝트 매니저', 17, { definition_md: '---\nname: 고객 회신\nkind: task\nrunner: agent\nskills: [doc-draft]\n---\n' })]
  return { proc: { key: 'process:5c5451687f', name: '강의계획서 작성 · 보고', tasks: tasks.map((x) => x.key), entries: ['교육 진행', '강의자료 준비'], theta: 0.05 },
    tasks: new Map(tasks.map((x) => [x.key, x])), edges, all: { tasks: global, roles: [] } }
}
const lectureFixes = [
  ['remove_task', { task: '작업 내용 보고' }], ['reverse_edge', { from: '교육 진행', to: '강의계획서 작성' }], ['remove_edge', { from: '강의 준비', to: '강의계획서 작성' }],
  ['merge_task', { task: '강의 준비', into: '강의자료 준비' }], ['merge_task', { task: '강의 계획 공유', into: '강의계획서 작성' }],
  ['remove_edge', { from: '강의계획서 작성', to: END }], ['remove_edge', { from: '강의계획서 작성', to: '교육 진행' }], ['remove_edge', { from: '강의자료 준비', to: '강의계획서 작성' }],
  ['add_task', { name: '고객 회신', role: '전무', after: '강의자료 준비', before: '교육 진행' }], ['remove_edge', { from: '강의자료 준비', to: END }],
  ['set_role', { task: '교육 진행', role: '강사' }],
].map(([op, args], i) => ({ id: String(i + 1), op, args }))

test('맡는 역할 바로잡기(set_role): 지도가 고른 역할을 그 일을 실제로 맡는 역할로', () => {
  assert.deepEqual(normFix({ op: 'set_role', args: { task: '교육 진행', role: '강사' } }), { op: 'set_role', args: { task: '교육 진행', role: '강사' } })
  assert.equal(normFix({ op: 'set_role', args: { task: '교육 진행' } }), null)
  assert.equal(labelOf({ op: 'set_role', args: { task: '교육 진행', role: '강사' } }), '「교육 진행」의 맡는 역할을 「강사」로 바꿈')
  const found = { tasks: [{ key: '교육 진행', role: '개발', n: 2 }], edges: [] }
  assert.equal(applyCorrections(found, [{ id: 'r', op: 'set_role', args: { task: '교육 진행', role: '강사' } }]).tasks[0].role, '강사')
  assert.equal(found.tasks[0].role, '개발') // found is not changed
  assert.match(applyCorrections(found, [{ id: 'r', op: 'set_role', args: { task: '없는 일', role: '강사' } }]).skipped[0].why, /그 일이 없어요/)
})

test('다듬은 흐름으로 스냅샷: 고친 대로 한 줄 — 사람이 정한 길은 θ 와 상관없이, 더한 일은 회사의 같은 일(일 정의)로, 시작은 들어오는 길이 없는 일', () => {
  const v = refinedView(lectureBase(), lectureFixes)
  assert.deepEqual(v.refined.skipped, [])
  assert.deepEqual([...v.tasks.keys()].sort(), ['강의계획서 작성', '강의자료 준비', '고객 회신', '교육 진행'].sort())
  assert.equal(v.proc.entries[0], '강의계획서 작성')
  assert.equal(v.tasks.get('교육 진행').role, '강사')
  // 「고객 회신」: 다른 프로세스에 있는 회사의 같은 일 — 그 정의(runner agent)를 쓴다
  assert.match(v.tasks.get('고객 회신').definition_md, /runner: agent/)
  assert.equal(v.tasks.get('고객 회신').added, true)
  const added = v.edges.find((e) => e.from === '강의자료 준비' && e.to === '고객 회신')
  assert.deepEqual([added.p, added.decided], [0, true])
  // 찾은 길은 지도가 아는 것(parallel 등)을 그대로, 몫만 다듬은 흐름의 것
  const kept = v.edges.find((e) => e.from === '강의계획서 작성' && e.to === '강의자료 준비')
  assert.deepEqual([kept.p, kept.decided], [1, undefined])
  const { nodes, flows } = unfold(v, '강의계획서 작성', 0.05)
  assert.deepEqual(nodes, ['강의계획서 작성', '강의자료 준비', '고객 회신', '교육 진행'])
  assert.deepEqual(flows.map((f) => `${f.from}>${f.to === END ? '끝' : f.to}`), ['강의계획서 작성>강의자료 준비', '교육 진행>끝', '강의자료 준비>고객 회신', '고객 회신>교육 진행'])
  // 고친 것이 없으면(다듬지 않은 프로세스) 스냅샷은 찾은 흐름 그대로
  assert.deepEqual(unfold(lectureBase(), '교육 진행', 0.05).nodes[0], '교육 진행')
})
