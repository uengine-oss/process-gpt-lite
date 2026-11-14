// 프로세스 다듬기(plan-process-refinement §3 ① · ②, lib/ontology/refine.js): 찾은 흐름 위에 고친 기록을 얹는 셈과 AI 답 다듬기. 모델 없이.
import test from 'node:test'
import assert from 'node:assert/strict'
import { applyCorrections, labelOf, normFix, wontApply, shapeClass, shapeReview, mergeClasses, caseSequences, flowOrder, END } from '../lib/ontology/refine.js'

// 「강의계획서 작성 · 보고」 as found: 교육 진행 comes before 강의 준비 (the known wrong order)
const found = () => ({
  tasks: [
    { key: '교육 진행', role: '개발', n: 2 }, { key: '강의계획서 작성', role: '전무', n: 9 }, { key: '강의 준비', role: '전무', n: 2 },
    { key: '강의자료 준비', role: '전무', n: 3 }, { key: '작업 내용 보고', role: '개발', n: 104 },
  ],
  edges: [
    { from: '교육 진행', to: '강의계획서 작성', n: 1, p: 0.5 }, { from: '교육 진행', to: '작업 내용 보고', n: 1, p: 0.5 },
    { from: '강의계획서 작성', to: '강의 준비', n: 1, p: 0.11 }, { from: '강의계획서 작성', to: END, n: 5, p: 0.45 },
    { from: '강의 준비', to: '강의계획서 작성', n: 1, p: 0.5 }, { from: '강의 준비', to: '작업 내용 보고', n: 1, p: 0.5 },
    { from: '강의자료 준비', to: '강의 준비', n: 1, p: 0.33 }, { from: '작업 내용 보고', to: END, n: 27, p: 0.26 },
  ],
})
const c = (id, op, args) => ({ id, op, args })
const edge = (r, from, to) => r.edges.find((e) => e.from === from && e.to === to)
const task = (r, key) => r.tasks.find((t) => t.key === key)

test('고친 것이 없으면 다듬은 흐름 = 찾은 흐름(더한 것 · 뺀 것 없음)', () => {
  const r = applyCorrections(found(), [])
  assert.deepEqual(r.tasks.map((t) => t.key), found().tasks.map((t) => t.key))
  assert.deepEqual(r.edges, found().edges)
  assert.deepEqual(r.removed, { tasks: [], edges: [] })
  assert.deepEqual(r.skipped, [])
})

test('reverse_edge: 화살표를 뒤집고, 바뀐 일에서 나가는 확률은 n 의 몫으로', () => {
  const r = applyCorrections(found(), [c('1', 'reverse_edge', { from: '교육 진행', to: '강의계획서 작성' })])
  assert.equal(edge(r, '교육 진행', '강의계획서 작성'), undefined)
  assert.deepEqual(edge(r, '강의계획서 작성', '교육 진행'), { from: '강의계획서 작성', to: '교육 진행', n: 1, p: +(1 / 7).toFixed(3), added: true })
  assert.equal(edge(r, '교육 진행', '작업 내용 보고').p, 1)
  assert.equal(edge(r, '작업 내용 보고', END).p, 0.26) // untouched: as found
  assert.deepEqual(r.removed.edges, [{ from: '교육 진행', to: '강의계획서 작성' }])
  // the end cannot be reversed
  assert.match(applyCorrections(found(), [c('x', 'reverse_edge', { from: '작업 내용 보고', to: END })]).skipped[0].why, /뒤집을 수 없어요/)
})

test('remove_edge · add_edge: 끊고 잇기, 없는 화살표 · 이미 있는 화살표는 건너뜀', () => {
  const r = applyCorrections(found(), [c('1', 'remove_edge', { from: '강의 준비', to: '작업 내용 보고' }), c('2', 'add_edge', { from: '강의 준비', to: '교육 진행' }), c('3', 'add_edge', { from: '교육 진행', to: END })])
  assert.equal(edge(r, '강의 준비', '작업 내용 보고'), undefined)
  assert.equal(edge(r, '강의 준비', '강의계획서 작성').p, 1)
  assert.deepEqual(edge(r, '강의 준비', '교육 진행'), { from: '강의 준비', to: '교육 진행', n: 0, p: 0, added: true })
  assert.equal(edge(r, '교육 진행', END).added, true)
  assert.deepEqual(r.removed.edges, [{ from: '강의 준비', to: '작업 내용 보고' }])
  const bad = applyCorrections(found(), [c('a', 'remove_edge', { from: '교육 진행', to: '강의 준비' }), c('b', 'add_edge', { from: '교육 진행', to: '작업 내용 보고' }), c('c', 'add_edge', { from: '없는 일', to: '교육 진행' })])
  assert.deepEqual(bad.skipped.map((s) => s.id), ['a', 'b', 'c'])
  assert.deepEqual(bad.edges, found().edges)
})

test('rename_task: 같은 일이라 더한 것도 뺀 것도 아니고, 화살표가 따라온다 · 있는 이름으로는 못 바꿈', () => {
  const r = applyCorrections(found(), [c('1', 'rename_task', { task: '교육 진행', name: '지난 회차 강의' })])
  assert.deepEqual(task(r, '지난 회차 강의'), { key: '지난 회차 강의', role: '개발', n: 2 })
  assert.equal(task(r, '교육 진행'), undefined)
  assert.ok(edge(r, '지난 회차 강의', '강의계획서 작성') && !edge(r, '지난 회차 강의', '강의계획서 작성').added)
  assert.deepEqual(r.removed, { tasks: [], edges: [] })
  assert.equal(r.origin['지난 회차 강의'], '교육 진행')
  assert.match(applyCorrections(found(), [c('x', 'rename_task', { task: '교육 진행', name: '강의 준비' })]).skipped[0].why, /합치기/)
})

test('merge_task: 한 일로 합치면 횟수가 더해지고, 둘 사이의 화살표는 사라진다', () => {
  const r = applyCorrections(found(), [c('1', 'merge_task', { task: '강의자료 준비', into: '강의 준비' })])
  assert.equal(task(r, '강의자료 준비'), undefined)
  assert.equal(task(r, '강의 준비').n, 5)
  assert.deepEqual(r.removed.tasks, ['강의자료 준비'])
  assert.deepEqual(r.removed.edges, [{ from: '강의자료 준비', to: '강의 준비' }])
  assert.ok(r.edges.every((e) => e.from !== e.to))
  // ways into the merged one now go into the other
  const r2 = applyCorrections(found(), [c('1', 'merge_task', { task: '교육 진행', into: '강의 준비' })])
  assert.equal(edge(r2, '강의 준비', '강의계획서 작성').n, 2)
  assert.equal(edge(r2, '강의 준비', '작업 내용 보고').n, 2)
  assert.equal(edge(r2, '강의 준비', '강의계획서 작성').added, undefined) // found had it
})

test('add_task: 둘 사이에 · 뒤에 · 앞에 더하고, 기록에 없는 일이라 n 0 · added', () => {
  const between = applyCorrections(found(), [c('1', 'add_task', { name: '강의 계획 승인', role: '전무', after: '강의계획서 작성', before: '강의 준비' })])
  assert.deepEqual(task(between, '강의 계획 승인'), { key: '강의 계획 승인', role: '전무', n: 0, added: true })
  assert.equal(edge(between, '강의계획서 작성', '강의 준비'), undefined)
  assert.equal(edge(between, '강의계획서 작성', '강의 계획 승인').added, true)
  assert.equal(edge(between, '강의 계획 승인', '강의 준비').n, 1)
  assert.deepEqual(between.removed.edges, [{ from: '강의계획서 작성', to: '강의 준비' }])
  const after = applyCorrections(found(), [c('1', 'add_task', { name: '수강 신청 확인', role: '개발', after: '교육 진행' })])
  assert.deepEqual(after.edges.filter((e) => e.from === '교육 진행').map((e) => [e.to, e.n, e.p]), [['수강 신청 확인', 2, 1]])
  assert.deepEqual(after.edges.filter((e) => e.from === '수강 신청 확인').map((e) => e.to).sort(), ['강의계획서 작성', '작업 내용 보고'])
  const before = applyCorrections(found(), [c('1', 'add_task', { name: '교안 검토', before: '강의 준비' })])
  assert.deepEqual(before.edges.filter((e) => e.to === '강의 준비').map((e) => e.from), ['교안 검토'])
  assert.equal(edge(before, '교안 검토', '강의 준비').n, 2)
  assert.match(applyCorrections(found(), [c('x', 'add_task', { name: '강의 준비' })]).skipped[0].why, /이미/)
  assert.match(applyCorrections(found(), [c('x', 'add_task', { name: '새 일', after: '없는 일' })]).skipped[0].why, /「없는 일」이 없어요/)
})

test('remove_task: 이 프로세스의 일이 아닌 것을 빼면 앞뒤가 이어진다', () => {
  const r = applyCorrections(found(), [c('1', 'remove_task', { task: '작업 내용 보고' })])
  assert.equal(task(r, '작업 내용 보고'), undefined)
  assert.deepEqual(r.removed.tasks, ['작업 내용 보고'])
  assert.deepEqual(edge(r, '교육 진행', END), { from: '교육 진행', to: END, n: 1, p: 0.5, added: true })
  assert.equal(edge(r, '강의 준비', END).added, true)
  assert.deepEqual(r.removed.edges.map((e) => `${e.from}>${e.to}`).sort(), ['강의 준비>작업 내용 보고', '교육 진행>작업 내용 보고', `작업 내용 보고>${END}`])
})

test('되돌리기는 그 줄을 지우는 것: 남은 줄만 다시 얹은 것과 같고, 기대던 줄은 건너뜀', () => {
  const a = c('a', 'reverse_edge', { from: '교육 진행', to: '강의계획서 작성' })
  const b = c('b', 'remove_task', { task: '작업 내용 보고' })
  const both = applyCorrections(found(), [a, b])
  assert.notDeepEqual(both, applyCorrections(found(), [a]))
  assert.deepEqual(applyCorrections(found(), [a, b].filter((x) => x.id !== 'b')), applyCorrections(found(), [a]))
  assert.deepEqual(applyCorrections(found(), []), applyCorrections(found(), [a, b].filter((x) => !['a', 'b'].includes(x.id))))
  // a correction that leaned on the one taken back is skipped, not applied to something else
  const ren = c('r', 'rename_task', { task: '교육 진행', name: '대학 강의' })
  const link = c('l', 'add_edge', { from: '강의 준비', to: '대학 강의' })
  assert.equal(applyCorrections(found(), [ren, link]).skipped.length, 0)
  assert.deepEqual(applyCorrections(found(), [link]).skipped, [{ id: 'l', why: '그 일이 없어요.' }])
  assert.equal(wontApply(found(), [ren], link.args ? { op: link.op, args: link.args } : null), '')
  assert.equal(wontApply(found(), [], { op: link.op, args: link.args }), '그 일이 없어요.')
})

test('찾은 흐름은 바뀌지 않는다(모든 고치기 뒤에도)', () => {
  const f = found(), before = structuredClone(f)
  applyCorrections(f, [
    c('1', 'reverse_edge', { from: '교육 진행', to: '강의계획서 작성' }), c('2', 'remove_edge', { from: '강의 준비', to: '작업 내용 보고' }),
    c('3', 'add_edge', { from: '강의 준비', to: '교육 진행' }), c('4', 'rename_task', { task: '교육 진행', name: '대학 강의' }),
    c('5', 'merge_task', { task: '강의자료 준비', into: '강의 준비' }), c('6', 'add_task', { name: '계획 승인', after: '강의계획서 작성', before: '강의 준비' }),
    c('7', 'remove_task', { task: '작업 내용 보고' }),
  ])
  assert.deepEqual(f, before)
})

test('고친 줄의 이름: 사람이 읽는 한 줄(받침에 따라 조사)', () => {
  assert.equal(labelOf({ op: 'reverse_edge', args: { from: '교육 진행', to: '강의 준비' } }), '「강의 준비 → 교육 진행」으로 뒤집음')
  assert.equal(labelOf({ op: 'reverse_edge', args: { from: '보고', to: '작성' } }), '「작성 → 보고」로 뒤집음')
  assert.equal(labelOf({ op: 'remove_edge', args: { from: '강의 준비', to: END } }), '「강의 준비 → 끝」 끊음')
  assert.equal(labelOf({ op: 'add_edge', args: { from: '강의 준비', to: '교육 진행' } }), '「강의 준비 → 교육 진행」 이음')
  assert.equal(labelOf({ op: 'rename_task', args: { task: '교육 진행', name: '대학 강의' } }), '「교육 진행」을 「대학 강의」로 이름 바꿈')
  assert.equal(labelOf({ op: 'merge_task', args: { task: '강의자료 준비', into: '강의 준비' } }), '「강의자료 준비」를 「강의 준비」에 합침')
  assert.equal(labelOf({ op: 'add_task', args: { name: '계약', role: '영업', after: '견적', before: '납품' } }), '「견적」과 「납품」 사이에 「계약」(영업) 더함')
  assert.equal(labelOf({ op: 'add_task', args: { name: '계약', after: '견적서 작성' } }), '「견적서 작성」 뒤에 「계약」 더함')
  assert.equal(labelOf({ op: 'remove_task', args: { task: '작업 내용 보고' } }), '「작업 내용 보고」를 이 프로세스에서 뺌')
})

test('normFix: 모르는 동작 · 빈 값은 null, 「끝」은 __end__', () => {
  assert.equal(normFix({ op: 'delete_all', args: {} }), null)
  assert.equal(normFix({ op: 'reverse_edge', args: { from: '가' } }), null)
  assert.deepEqual(normFix({ op: 'add_edge', args: { from: ' 강의 준비 ', to: '끝' } }), { op: 'add_edge', args: { from: '강의 준비', to: END } })
  assert.deepEqual(normFix({ op: 'add_task', args: { name: '계약', role: '', after: '견적', before: '' } }), { op: 'add_task', args: { name: '계약', role: '', after: '견적' } })
})

test('단계 가르기: AI 후보와 어긋나지 않게 — 사람이 꼭 할 까닭이 있으면 AI 아님, 걷어냄은 대신 받는 길이 있어야', () => {
  assert.equal(shapeClass({ class: 'ai', why: '양식 작성' }, { human: ['approval'] }).class, 'human')
  assert.equal(shapeClass({ class: 'ai', why: '양식 작성' }).class, 'ai')
  const noWay = shapeClass({ class: 'drop', why: '전달만 함', instead: '' })
  assert.equal(noWay.class, 'none')
  assert.match(noWay.why, /누가 대신 받는지/)
  const drop = shapeClass({ class: 'drop', why: '취합해 다시 보냄', instead: '팀장이 공유 폴더에서 바로 봄' })
  assert.equal(drop.class, 'drop')
  assert.equal(drop.why, '취합해 다시 보냄 — 대신 팀장이 공유 폴더에서 바로 봄')
  assert.equal(shapeClass({ class: 'drop', why: '전달', instead: '누군가' }, { pinned: true }).class, 'none')
  assert.equal(shapeClass({ class: 'whatever' }).class, 'none')
})

test('다시 가를 때 사람이 정한 것은 남고, AI 제안은 곁에 새로', () => {
  const have = { 강의: { class: 'gate', why: '사람', by: 'person', decided: true, pinned_here: true }, 보고: { class: 'ai', why: '예전', by: 'ai', decided: false } }
  const out = mergeClasses(have, { 강의: { class: 'human', why: '대면' }, 보고: { class: 'drop', why: '새로' } })
  assert.equal(out.강의.class, 'gate')
  assert.equal(out.강의.decided, true)
  assert.deepEqual(out.강의.ai, { class: 'human', why: '대면' })
  assert.equal(out.강의.pinned_here, true)
  assert.deepEqual(out.보고, { class: 'drop', why: '새로', by: 'ai', decided: false, ai: { class: 'drop', why: '새로' } })
})

test('AI 의 점검 답 다듬기: 고칠 동작 확인 · 근거는 건의 걸음 날짜로 · 그대로 둔 제안은 다시 물어도 그대로', () => {
  const shownCases = [{ id: 'c1', steps: [{ i: 0, task: '교육 진행', when: '2026-09-08', said: '강의 진행' }, { i: 1, task: '강의계획서 작성', when: '2026-09-16', said: '강의계획서 작성' }] }]
  const r = { summary: '강의 계획 흐름 이메일 seoul@example.com', issues: [
    { kind: 'order', title: '교육 진행이 강의 준비보다 앞', why: '9월 8일 강의는 지난 회차', evidence: [{ case: 'c1', step: 0, said: '지난 회차 강의 후기' }, { case: 'c9', step: 0 }],
      fix: { op: 'reverse_edge', args: { from: '교육 진행', to: '강의계획서 작성' } } },
    { kind: 'missing', title: '없는 일을 뒤집음', fix: { op: 'reverse_edge', args: { from: '없는 일', to: '교육 진행' } } },
    { kind: 'weird', title: '모르는 종류', fix: { op: 'explode', args: {} } },
  ], proposed: { steps: [{ task: '강의 준비', role: '전무' }, { task: '교육 진행', role: '개발' }], flows: [{ from: '강의 준비', to: '교육 진행' }, { from: '교육 진행', to: '끝' }, { from: '교육 진행', to: '모르는 일' }] } }
  const out = shapeReview(r, { found: found(), corrections: [], shownCases })
  assert.equal(out.summary, '강의 계획 흐름 이메일 •••')
  assert.deepEqual(out.issues.map((x) => [x.kind, x.status, x.fix?.op ?? null]), [['order', 'open', 'reverse_edge'], ['missing', 'open', null], ['order', 'open', null]])
  assert.equal(out.issues[0].fix.label, '「강의계획서 작성 → 교육 진행」으로 뒤집음')
  assert.deepEqual(out.issues[0].evidence, [{ at: '2026-09-08', said: '지난 회차 강의 후기' }])
  assert.deepEqual(out.proposed.flows, [{ from: '강의 준비', to: '교육 진행' }, { from: '교육 진행', to: END }])
  // a re-run: the same issue keeps 「dismissed」; one whose fix is already a correction reads 「accepted」
  const again = shapeReview(r, { found: found(), corrections: [], shownCases, before: { issues: [{ ...out.issues[0], status: 'dismissed' }] } })
  assert.equal(again.issues[0].id, out.issues[0].id)
  assert.equal(again.issues[0].status, 'dismissed')
  const applied = shapeReview(r, { found: found(), corrections: [{ op: 'reverse_edge', args: { from: '교육 진행', to: '강의계획서 작성' } }], shownCases })
  assert.equal(applied.issues[0].status, 'accepted')
  assert.ok(applied.issues[0].fix)
})

test('프로세스의 실제 건: 그 프로세스의 일이 대부분인 건, 다른 일을 뺀 뒤 이어진 같은 일은 한 걸음', () => {
  const s = (task, at) => ({ task, recs: [{ at: `2026-10-${String(at).padStart(2, '0')}T00:00:00Z`, said: task, ref: `m${at}` }] })
  const steps = new Map([
    ['a', [s('교육 진행', 1), s('강의계획서 작성', 2), s('다른 일', 3), s('강의계획서 작성', 4), s('강의 준비', 5)]],
    ['b', [s('다른 일', 1), s('또 다른 일', 2), s('교육 진행', 3), s('강의 준비', 4)]],
    ['c', [s('강의 준비', 9), s('강의 준비', 10)]],
  ])
  const out = caseSequences(steps, ['교육 진행', '강의계획서 작성', '강의 준비'], { minInside: 0.6 })
  assert.deepEqual(out.map((x) => x.id), ['a'])
  assert.deepEqual(out[0].steps.map((x) => [x.task, x.recs.length]), [['교육 진행', 1], ['강의계획서 작성', 2], ['강의 준비', 1]])
})

test('일의 차례: 시작하는 일부터 많이 간 길을 따라', () => {
  const f = found()
  assert.deepEqual(flowOrder(f.tasks, f.edges, ['교육 진행']).map((t) => t.key), ['교육 진행', '강의계획서 작성', '작업 내용 보고', '강의 준비', '강의자료 준비'])
})
