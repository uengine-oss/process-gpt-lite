// 규정 · 업무 정의서(design-v0.3 §17, lib/ontology/documents.js): 문서 글을 읽을 만한 부분으로 나누고, process-gpt 문서 읽기(PDF2BPMN)의
// 결과를 절차 · 단계 · 순서로 — 분기점(게이트웨이)을 지나는 흐름은 앞 단계에서 뒤 단계로 잇고 조건은 남긴다. 모델 없이.
import test from 'node:test'
import assert from 'node:assert/strict'
import { chunksOf, proceduresOf } from '../lib/ontology/documents.js'

test('문서를 문단째로 나눈다(한 부분 크기 · 최대 부분 수)', () => {
  const text = Array.from({ length: 30 }, (_, i) => `제${i + 1}조 ` + '가'.repeat(400)).join('\n\n')
  const c = chunksOf(text, 1000, 5)
  assert.equal(c.length, 5)
  assert.ok(c.every((x) => x.length <= 1000))
  assert.match(c[0], /^제1조/)
})

test('PDF2BPMN 결과 → 절차: 역할 · 순서 · 게이트웨이를 지나는 흐름과 조건', () => {
  const ent = {
    processes: [{ name: '견적 업무', description: '요청부터 회신까지' }],
    tasks: [{ name: '견적서 작성', order: 1 }, { name: '재무 검토', order: 2 }, { name: '고객 회신', order: 3 }],
    task_role_mappings: [{ task_name: '견적서 작성', role_name: '영업' }, { task_name: '재무 검토', role_name: '재무 담당' }],
    task_process_mappings: [],
    sequence_flows: [
      { from_task: '견적서 작성', to_task: '금액 분기' },
      { from_task: '금액 분기', to_task: '재무 검토', condition: '1,000만원 이상' },
      { from_task: '금액 분기', to_task: '고객 회신', condition: '1,000만원 미만' },
      { from_task: '재무 검토', to_task: '고객 회신' },
    ],
    events: [{ name: '견적 요청 접수', event_type: 'start', description: '고객의 견적 요청 메일이 오면' }],
  }
  const [p] = proceduresOf(ent, '규정.pdf')
  assert.equal(p.name, '견적 업무')
  assert.deepEqual(p.steps.map((s) => [s.name, s.role]), [['견적서 작성', '영업'], ['재무 검토', '재무 담당'], ['고객 회신', '']])
  assert.deepEqual(p.then, [
    { from: '견적서 작성', to: '재무 검토', cond: '1,000만원 이상' },
    { from: '견적서 작성', to: '고객 회신', cond: '1,000만원 미만' },
    { from: '재무 검토', to: '고객 회신', cond: '' },
  ])
  assert.equal(p.trigger, '고객의 견적 요청 메일이 오면')
})
