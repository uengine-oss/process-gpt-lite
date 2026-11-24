// 지도에서 바로 도는 건의 인스턴스 화면(2026-11-24 「프로세스 지도 자체는 가독성이 많이 떨어지기 때문에 … BPMN 스냅샷을 보여줘야 됩니다」):
// 인스턴스를 열면 회사 지도로 넘기지 않고 그 건의 BPMN 을 그린다. 여기서는 DB · 모델 없이 순수한 조각을 본다.
//   - 건의 단계를 한 번 읽어(mapengine.js caseRowsOf · madeOrder · runmode.js stepState) 흐름도의 색, 인스턴스 화면의 단계 · 진행 막대 ·
//     「내 입력이 필요해요」가 모두 같은 상태를 보인다
//   - 화면이 무엇을 그릴지(src/components/ontology/caseView.js): 지도 건은 그 건의 BPMN · 다이어그램부터, 정의가 있는 인스턴스는 그대로
// Run: node --test test/map-case-view.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { madeOrder, caseRowsOf, instanceSteps, flowGraph, TIMELINE_OF } from '../lib/ontology/mapengine.js'
import { caseBpmn } from '../lib/ontology/casebpmn.js'
import { actId } from '../lib/ontology/run.js'
import { quoteView, STEPS, EXPECTED } from './fixtures/map-case-view.mjs'
import { instanceViewOf, mapCaseOf, mapCaseLink, routineTarget, flowDir, wideCardWidth, instanceContext } from '../../src/components/ontology/caseView.js'

const ME = { id: 'u-me', email: 'me@example.test' }
const OTHER = { id: 'u-other', email: 'other@example.test' }
// the case's work items and rows as the engine leaves them (mapengine.js createItem): made one minute apart, the person's step mine
function items(steps = STEPS, { holder = ME.id } = {}) {
  const t0 = Date.parse('2026-11-24T01:00:00Z')
  const todos = [], gates = new Map()
  steps.forEach((s, i) => {
    const id = `todo-${i + 1}`
    const agent = s.kind === 'agent'
    todos.push({ id, activity_id: actId(s.task), activity_name: s.task, status: s.status, user_id: agent ? 'agent-1' : holder, username: agent ? '업무 에이전트' : '한지우',
      agent_orch: agent ? 'pgpt-pro-onto' : null, agent_mode: agent ? 'COMPLETE' : null, draft_status: s.draft || null })
    gates.set(id, { todo_id: id, state: s.gate || 'released', kind: s.kind, created_at: new Date(t0 + i * 60_000).toISOString(), via: s.via, act: { role: agent ? '업무 에이전트' : '영업' } })
  })
  return { todos, gates }
}

test('madeOrder: 지도 건은 단계를 만든 차례(행의 created_at), 스냅샷 건은 읽은 차례 그대로', () => {
  const { todos, gates } = items()
  const shuffled = [todos[2], todos[0], todos[3], todos[1]]
  assert.deepEqual(madeOrder('map', shuffled, gates).map((t) => t.activity_name), ['요청 검토', '단가 조회', '현장 실측', '견적서 작성'])
  assert.deepEqual(madeOrder('bpm', shuffled, gates).map((t) => t.id), shuffled.map((t) => t.id))
  // a work item without a row (a snapshot's intake) comes first, nothing is lost
  assert.equal(madeOrder('map', [...shuffled, { id: 'x', activity_name: '요청 접수' }], gates)[0].id, 'x')
})

test('인스턴스 화면의 단계: 흐름도와 같은 읽기 — 끝남 · 사람 차례(내 것) · 에이전트 단계, 진행 막대와 「내 입력이 필요해요」', async () => {
  const c = { id: 'case-1', engine: 'map' }
  const rows = await caseRowsOf(c, items())
  assert.deepEqual(rows.map((r) => [r.task, r.show]), [['요청 검토', 'done'], ['단가 조회', 'done'], ['현장 실측', 'done'], ['견적서 작성', 'person']])
  const steps = instanceSteps(rows, ME)
  assert.deepEqual(steps.map((s) => [s.name, s.kind, s.state, s.caseState]), [
    ['요청 검토', 'human', 'done', 'done'], ['단가 조회', 'agent', 'done', 'done'], ['현장 실측', 'human', 'done', 'done'], ['견적서 작성', 'human', 'active', 'person']])
  // mine: the person's turn whose work item names me — the one 「내 입력이 필요해요」 card
  assert.deepEqual(steps.filter((s) => s.mine).map((s) => [s.name, s.todoId]), [['견적서 작성', 'todo-4']])
  assert.equal(instanceSteps(rows, OTHER).filter((s) => s.mine).length, 0)
  // (by e-mail too, as a work item may name the person by it)
  assert.equal(instanceSteps(await caseRowsOf(c, items(STEPS, { holder: ME.email })), { id: 'nope', email: ME.email }).filter((s) => s.mine).length, 1)
  // ids are the work items' (a step done twice is two rows)
  assert.equal(new Set(steps.map((s) => s.id)).size, steps.length)
  assert.equal(steps[0].role, '영업')
})

test('상태 낱말: 하는 중 · 기다림 · 닫힘 · 건너뜀 · 실패한 에이전트 단계', async () => {
  const more = [
    { task: '요청 검토', status: 'DONE', kind: 'person' },
    { task: '단가 조회', status: 'IN_PROGRESS', kind: 'agent', draft: 'STARTED' },
    { task: '현장 실측', status: 'TODO', kind: 'person', gate: 'waiting' },
    { task: '정밀 견적', status: 'CANCELLED', kind: 'person' },
    { task: '고객 회신', status: 'DONE', kind: 'person', gate: 'skipped' },
    { task: '견적서 작성', status: 'IN_PROGRESS', kind: 'agent', draft: 'FAILED' },
  ]
  const steps = instanceSteps(await caseRowsOf({ id: 'c', engine: 'map' }, items(more)), ME)
  assert.deepEqual(steps.map((s) => [s.caseState, s.state]), [['done', 'done'], ['running', 'active'], ['waiting', 'active'], ['closed', 'cancelled'], ['skipped', 'skipped'], ['running', 'active']])
  assert.equal(steps[1].running, true)
  assert.equal(steps[2].waiting, true)
  assert.equal(steps[2].mine, false) // waiting for the owner is nobody's input yet
  assert.equal(steps[5].failed, true)
  for (const s of Object.keys(TIMELINE_OF)) assert.ok(['done', 'active', 'pending', 'skipped', 'cancelled'].includes(TIMELINE_OF[s]))
})

test('같은 근원: 흐름도(flowGraph · BPMN 의 색)와 인스턴스 화면의 단계가 일마다 같은 상태 — 다음은 흐름도에만', async () => {
  const c = { id: 'case-1', engine: 'map' }
  const rows = await caseRowsOf(c, items())
  const view = quoteView()
  const g = flowGraph(view, { entry: '요청 검토', rows: rows.map(({ task, show, via }) => ({ task, show, via })) })
  const node = Object.fromEntries(g.nodes.map((n) => [n.key, n.state]))
  const steps = instanceSteps(rows, ME)
  for (const s of steps) assert.equal(node[s.name], s.caseState, `「${s.name}」: 흐름도 ${node[s.name]} · 목록 ${s.caseState}`)
  for (const [task, st] of Object.entries(EXPECTED)) assert.equal(node[task], st, task)
  assert.equal(node['정밀 견적'], '') // the way not taken: no state
  // the BPMN's markers (what BpmnView paints) say the same
  const b = caseBpmn(view, { entry: '요청 검토', rows: rows.map(({ task, show, via }) => ({ task, show, via })), graph: g, status: 'running' })
  for (const [task, st] of Object.entries(EXPECTED)) assert.equal(b.states[b.ids[task]], st, `BPMN 「${task}」`)
  // the taken ways are drawn bold; the split after 현장 실측 went to 견적서 작성
  assert.equal(b.states[`SequenceFlow_${actId('요청 검토')}_${actId('단가 조회')}`], 'taken')
})

test('화면이 그릴 것(caseView.js): 지도 건은 건의 BPMN · 다이어그램부터 · 회사 지도 링크, 정의가 있는 인스턴스는 목록부터 그대로', () => {
  const mapInst = { inst: { proc_inst_id: 'onto-map.1', proc_def_id: null }, mapCase: { id: 'case-1', proc: 'p:quote case', engine: 'map' }, steps: [] }
  assert.deepEqual(instanceViewOf(mapInst), { kind: 'map', diagram: 'case-bpmn', view: 'bpmn', caseId: 'case-1', mapLink: '/process-map?proc=p%3Aquote%20case&case=case-1' })
  assert.equal(mapCaseOf(mapInst).id, 'case-1')
  const classic = { inst: { proc_inst_id: 'leave.1', proc_def_id: 'leave' }, def: { name: '휴가 신청' }, steps: [] }
  assert.deepEqual(instanceViewOf(classic), { kind: 'definition', diagram: 'definition-bpmn', view: 'list', defId: 'leave', mapLink: null })
  assert.equal(mapCaseOf(classic), null)
  assert.equal(mapCaseOf({ mapCase: null }), null)
  assert.equal(mapCaseLink(null), '/process-map')
})

test('루틴 목록에서 여는 곳: 지도 건 · 클래식은 인스턴스 화면, 스냅샷 건은 지도의 건 화면', () => {
  assert.equal(routineTarget({ proc_inst_id: 'onto-map.a b', case_id: 'c1', case_proc: 'p:x', engine: 'map' }), '/routines/onto-map.a%20b')
  assert.equal(routineTarget({ proc_inst_id: 'quote_snap.1', case_id: 'c2', case_proc: 'p:x', engine: 'bpm' }), '/process-map?proc=p%3Ax&case=c2')
  assert.equal(routineTarget({ proc_inst_id: 'quote_snap.2', case_id: 'c3', case_proc: 'p:x', engine: null }), '/process-map?proc=p%3Ax&case=c3')
  assert.equal(routineTarget({ proc_inst_id: 'leave.1' }), '/routines/leave.1')
})

test('흐름의 방향과 넓은 화면의 카드 폭: 640px 아래는 위에서 아래로, 넓은 화면에서는 대화 칸보다 넓게(최대 1040px)', () => {
  assert.equal(flowDir(358), 'TB')
  assert.equal(flowDir(639), 'TB')
  assert.equal(flowDir(640), 'LR')
  assert.equal(flowDir(0), 'LR') // not measured yet
  assert.equal(wideCardWidth(390), null) // a phone: the column's own width
  assert.equal(wideCardWidth(600), null)
  assert.equal(wideCardWidth(860), 812) // 1280 wide beside the routine list
  assert.equal(wideCardWidth(2000), 1040)
})

test('채팅에 실어 보내는 인스턴스 맥락: 지도 건은 「지도에서 바로 도는 건」과 단계 상태(undefined 없음)', () => {
  const i = { inst: { proc_inst_name: '견적 요청 처리 · 가람상사', status: 'RUNNING' }, def: null, mapCase: { id: 'c1' },
    steps: [{ name: '요청 검토', state: 'done' }, { name: '견적서 작성', state: 'active' }], artifacts: [] }
  const ctx = instanceContext(i)
  assert.match(ctx, /^\[프로세스 인스턴스: 견적 요청 처리 · 가람상사 \/ 지도에서 바로 도는 건 \/ 상태 RUNNING\]/)
  assert.match(ctx, /단계: 요청 검토\(done\), 견적서 작성\(active\)/)
  assert.ok(!ctx.includes('undefined'))
  assert.match(instanceContext({ ...i, def: { name: '휴가 신청' }, mapCase: null }), /\/ 휴가 신청 \//)
})
