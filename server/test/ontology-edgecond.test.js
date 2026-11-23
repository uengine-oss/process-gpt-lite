// 간선 설정(edge-step-condition): 데이터베이스 없이 edgecond.js 의 순수 함수만.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { entryEdgesOf, nextClass, markOf, renamedEvent, caseEntryEdges, classOfEdges, migrationRows, startEventOf, mayRequire } from '../lib/ontology/edgecond.js'
import { snapshotTimeOf } from '../lib/ontology/runmode.js'

const END = '__end__'
// 흐름: 요청 접수 → 견적서 작성(표) → 재무 검토 → 고객 회신, 다듬기에서 「재무 검토」를 「재무 확인」으로 바꾸고 「팀장 승인 → 고객 회신」을 이었다
const tasks = new Map([
  ['요청 접수', { key: '요청 접수' }],
  ['견적서 작성', { key: '견적서 작성' }],
  ['재무 확인', { key: '재무 확인', origin: '재무 검토' }],
  ['팀장 승인', { key: '팀장 승인', added: true }],
  ['고객 회신', { key: '고객 회신' }],
])
const edges = [
  { from: '요청 접수', to: '견적서 작성' }, { from: '견적서 작성', to: '재무 확인' }, { from: '재무 확인', to: '고객 회신' },
  { from: '견적서 작성', to: '팀장 승인' }, { from: '팀장 승인', to: '고객 회신' }, { from: '고객 회신', to: END },
]
const triggers = [
  { from: 'mail', to: '요청 접수', n: 5, p: 1 },
  { from: 'message', to: '견적서 작성', n: 2, p: 0.3 },
  { from: 'done:요청 접수', to: '견적서 작성', n: 5, p: 1 },
  { from: 'artifact:견적서 작성:sheet', to: '재무 검토', n: 4, p: 0.8 },
  { from: 'done:재무 검토', to: '고객 회신', n: 4, p: 1 },
  { from: 'done:옛 단계', to: '고객 회신', n: 1, p: 1, status: 'gone' },
  { from: 'artifact:다른 일:doc', to: '고객 회신', n: 1, p: 1 },
]
const view = { proc: { key: 'process:a' }, tasks, edges, all: { triggers, events: [] } }
const E = entryEdgesOf(view)
const find = (event, step) => E.find((x) => x.event === event && x.step === step)

test('진입 간선: 시작 사건 → 일(중간 일 포함)', () => {
  assert.equal(find('mail', '요청 접수').kind, 'start')
  assert.equal(find('message', '견적서 작성').kind, 'start')
})

test('진입 간선: 결과물이 있으면 결과물 간선, 이름을 바꾼 일은 지도 key 로 저장', () => {
  const x = find('artifact:견적서 작성:sheet', '재무 확인')
  assert.equal(x.kind, 'artifact'); assert.equal(x.task, '재무 검토'); assert.equal(x.virtual, false)
  // 결과물 간선이 있으면 「완료」를 따로 두지 않는다
  assert.ok(!find('done:견적서 작성', '재무 확인'))
})

test('진입 간선: 결과물이 없으면 「앞 단계 완료」, 지도에 없는 길(다듬기로 이음)은 virtual', () => {
  const mined = find('done:재무 검토', '고객 회신')
  assert.equal(mined.kind, 'done'); assert.equal(mined.virtual, false)
  const added = find('done:견적서 작성', '팀장 승인')
  assert.equal(added.virtual, true); assert.equal(added.task, '팀장 승인')
  assert.equal(find('done:팀장 승인', '고객 회신').virtual, true)
})

test('진입 간선: 끝으로 가는 길은 「X 완료 → 끝」(kind end) 하나, 사라진 간선 · 흐름 밖 일의 결과물은 넣지 않는다', () => {
  const ends = E.filter((x) => x.step === END)
  assert.deepEqual(ends.map((x) => [x.event, x.task, x.kind]), [['done:고객 회신', END, 'end']])
  assert.ok(!E.some((x) => x.event === 'done:옛 단계'))
  assert.ok(!E.some((x) => x.event === 'artifact:다른 일:doc'))
  assert.equal(new Set(E.map((x) => `${x.event}>${x.task}`)).size, E.length)
})

test('분류: 사람이 정하면 확정, AI 제안과 같으면 그 까닭, 비우면 제안만 남는다', () => {
  const c = nextClass('human', null)
  assert.deepEqual([c.class, c.by, c.decided], ['human', 'person', true])
  const prev = { class: 'ai', decided: false, ai: { class: 'ai', why: '양식 작성이에요' } }
  const same = nextClass('ai', prev)
  assert.deepEqual([same.by, same.why, same.decided], ['ai', '양식 작성이에요', true])
  const back = nextClass(null, { ...same })
  assert.deepEqual([back.class, back.decided], ['ai', false])
  assert.equal(nextClass(null, null), null)
})

test('표시: 꼭 · 선택 · 사안에 따라(규칙만)', () => {
  assert.equal(markOf({ requirement: 'required', rules: [] }), 'req')
  assert.equal(markOf({ requirement: 'optional', rules: [] }), 'opt')
  assert.equal(markOf({ requirement: null, rules: [{}] }), 'cond')
  assert.equal(markOf({ requirement: null, rules: [] }), null)
  assert.equal(markOf(null), null)
})

test('건의 진입 간선: 앞 단계 뒤 · 첫 단계(시작 사건) · 중간 시작(건너뛴 앞 단계) — 맞는 게 없으면 지도대로', () => {
  // 앞 단계(이름을 바꾼 「재무 확인」 → 지도 key 「재무 검토」)에서 고객 회신으로
  assert.deepEqual(caseEntryEdges(view, E, { task: '고객 회신', prev: '재무 확인' }).map((x) => x.event), ['done:재무 검토'])
  assert.deepEqual(caseEntryEdges(view, E, { task: '고객 회신', prev: '팀장 승인' }).map((x) => x.event), ['done:팀장 승인'])
  // 첫 단계: 시작 사건의 간선
  assert.deepEqual(caseEntryEdges(view, E, { task: '견적서 작성', start: 'message' }).map((x) => x.event), ['message'])
  // 시작 사건 간선이 없으면 건너뛴 바로 앞 단계에서 오는 간선
  assert.deepEqual(caseEntryEdges(view, E, { task: '재무 확인', start: 'mail', skipped: '견적서 작성' }).map((x) => x.event), ['artifact:견적서 작성:sheet'])
  assert.deepEqual(caseEntryEdges(view, E, { task: '재무 확인', start: 'mail' }), [])
  assert.equal(startEventOf({ kind: 'mail' }), 'mail'); assert.equal(startEventOf({ kind: 'chat' }), 'message'); assert.equal(startEventOf({ kind: 'manual' }), null)
})

test('건의 분류: 진입 간선 중 확정한 「사람이 꼭」이 이긴다, 없으면 첫 확정, 없으면 제안', () => {
  const w = (c) => ({ setting: c ? { class: c } : null })
  assert.equal(classOfEdges([w({ class: 'ai', decided: true }), w({ class: 'human', decided: true })]).class, 'human')
  assert.equal(classOfEdges([w({ class: 'human', decided: false }), w({ class: 'ai', decided: true })]).class, 'ai')
  assert.equal(classOfEdges([w(null), w({ class: 'drop', decided: false })]).class, 'drop')
  assert.equal(classOfEdges([w(null)]), null)
  assert.equal(mayRequire({ requirement: 'optional', rules: [{ then: 'required' }] }), true)
  assert.equal(mayRequire({ requirement: 'optional', rules: [] }), false)
})

test('이전: 단계 규칙은 그 단계의 모든 진입 간선에, 확정한 관문은 꼭(단계 규칙이 있으면 단계 규칙), 분류는 제안 · 확정 그대로, 있는 설정은 그대로', () => {
  const reqs = new Map([['고객 회신', { requirement: 'optional', rules: [] }], ['재무 검토', { requirement: null, rules: [{ when: { field: 'amount', op: '>=', value: 5 }, then: 'required' }] }]])
  const classes = {
    '재무 검토': { class: 'gate', decided: true, pinned_here: true },
    '팀장 승인': { class: 'gate', decided: true },
    '견적서 작성': { class: 'ai', decided: false, why: '양식 작성', ai: { class: 'ai', why: '양식 작성' } },
    '요청 접수': { class: 'none' },
  }
  const existing = new Set([`message\u0000견적서 작성`])
  const { rows, dropped, unpin } = migrationRows({ entries: E, reqs, classes, existing })
  const of = (ev, t) => rows.find((r) => r.event === ev && r.task === t)
  // 고객 회신으로 들어오는 두 간선 모두 선택
  assert.equal(of('done:재무 검토', '고객 회신').requirement, 'optional')
  assert.equal(of('done:팀장 승인', '고객 회신').requirement, 'optional')
  // 재무 검토: 단계 규칙(사안에 따라)이 관문을 이긴다, 관문은 버린 것으로
  assert.equal(of('artifact:견적서 작성:sheet', '재무 검토').requirement, null)
  assert.equal(of('artifact:견적서 작성:sheet', '재무 검토').rules.length, 1)
  assert.deepEqual(dropped.map((d) => d.task), ['재무 검토'])
  assert.deepEqual(unpin, ['재무 검토'])
  // 단계 규칙이 없는 관문은 꼭
  assert.equal(of('done:견적서 작성', '팀장 승인').requirement, 'required')
  // 분류는 제안 그대로, 이미 설정이 있는 간선은 건드리지 않는다
  assert.deepEqual([of('done:요청 접수', '견적서 작성').class.class, of('done:요청 접수', '견적서 작성').class.decided], ['ai', false])
  assert.ok(!of('message', '견적서 작성'))
  // 「그대로(none)」는 옮기지 않는다
  assert.ok(!rows.some((r) => r.task === '요청 접수'))
})

test('bpm 건의 스냅샷 때: 첫 인스턴스는 건 시작, 그 뒤 인스턴스는 그것을 연 옮기기 · 되감기', () => {
  const c = { created_at: '2026-11-19T01:00:00Z', instances: ['i1', 'i2', 'i3'],
    history: [{ task: 'A', state: 'skipped' }, { task: 'B', state: 'moved', at: '2026-11-19T02:00:00Z' }, { task: 'A', state: 'rewound', at: '2026-11-19T03:00:00Z' }] }
  assert.equal(snapshotTimeOf(c, 'i1'), '2026-11-19T01:00:00.000Z')
  assert.equal(snapshotTimeOf(c, 'i2'), '2026-11-19T02:00:00.000Z')
  assert.equal(snapshotTimeOf(c, 'i3'), '2026-11-19T03:00:00.000Z')
})

test('이름 합치기: 일이 낸 사건(결과물 · 완료)의 키도 남는 이름으로, 다른 사건은 그대로', () => {
  assert.equal(renamedEvent('done:현장 확인', '현장 확인', '현장 실측'), 'done:현장 실측')
  assert.equal(renamedEvent('artifact:현장 확인:drawing', '현장 확인', '현장 실측'), 'artifact:현장 실측:drawing')
  assert.equal(renamedEvent('artifact:현장 확인 보고:doc', '현장 확인', '현장 실측'), 'artifact:현장 확인 보고:doc')
  assert.equal(renamedEvent('done:현장 확인 보고', '현장 확인', '현장 실측'), 'done:현장 확인 보고')
  assert.equal(renamedEvent('mail', '현장 확인', '현장 실측'), 'mail')
})
