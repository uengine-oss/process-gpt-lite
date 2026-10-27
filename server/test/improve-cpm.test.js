// 크리티컬 패스(병렬·배타 게이트웨이·루프), 남은 경로, 가치 흐름·흐름 효율, 제약 찾기, what-if — 손으로 셈한 값과 비교.
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildGraph } from '../lib/improve/graph.js'
import * as cpmMod from '../lib/improve/cpm.js'
const { criticalPath, remainingPath } = cpmMod
import { analyze, valueStream } from '../lib/improve/analyze.js'
import { resources, constraintOf } from '../lib/improve/toc.js'
import { whatIf, buildModel, evaluate } from '../lib/improve/whatif.js'
import { transformDefinition } from '../lib/improve/transform.js'
import { focusingSteps, skipShare } from '../lib/improve/focus.js'
import { engineRows } from '../lib/improve/shape.js'
import { simulate, contract, DEF_ID } from '../lib/improve/demoProcess.js'

const A = (id, human = true) => ({ id, name: id, type: 'userTask', ...(human ? {} : { agentMode: 'complete', orchestration: 'deepagents' }) })
const G = (id, type) => ({ id, type })
const S = (source, target, id = `${source}_${target}`) => ({ id, source, target })
const E = (id, type) => ({ id, type })
const near = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} ≉ ${b}`)

test('sequence: T = sum, all critical, zero slack', () => {
  const g = buildGraph({ activities: [A('a'), A('b'), A('c')], events: [E('s', 'startEvent'), E('e', 'endEvent')], sequences: [S('s', 'a'), S('a', 'b'), S('b', 'c'), S('c', 'e')] })
  const r = criticalPath(g, { dur: { a: 2, b: 3, c: 1 }, p: {} })
  assert.equal(r.expectedT, 6)
  assert.deepEqual(r.main.path, ['a', 'b', 'c'])
  for (const id of ['a', 'b', 'c']) assert.equal(r.main.nodes[id].slack, 0)
})

test('parallel gateway: the longer branch is critical, the other has slack (ES/EF/LS/LF)', () => {
  const g = buildGraph({
    activities: [A('a'), A('b'), A('c')], gateways: [G('sp', 'parallelGateway'), G('jn', 'parallelGateway')], events: [E('s', 'startEvent'), E('e', 'endEvent')],
    sequences: [S('s', 'sp'), S('sp', 'a'), S('sp', 'b'), S('a', 'jn'), S('b', 'jn'), S('jn', 'c'), S('c', 'e')],
  })
  const r = criticalPath(g, { dur: { a: 5, b: 2, c: 1 }, p: {} })
  assert.equal(r.expectedT, 6)
  assert.deepEqual(r.main.path, ['a', 'c'])
  const b = r.main.nodes.b
  assert.deepEqual([b.es, b.ef, b.ls, b.lf, b.slack], [0, 2, 3, 5, 3])
  assert.equal(r.criticality.b || 0, 0)
})

test('exclusive gateway: scenarios weighted by branch frequency, criticality index', () => {
  const g = buildGraph({
    activities: [A('a'), A('b'), A('c')], gateways: [G('x', 'exclusiveGateway'), G('m', 'exclusiveGateway')], events: [E('s', 'startEvent'), E('e', 'endEvent')],
    sequences: [S('s', 'x'), S('x', 'a', 'xa'), S('x', 'b', 'xb'), S('a', 'm'), S('b', 'm'), S('m', 'c'), S('c', 'e')],
  })
  const r = criticalPath(g, { dur: { a: 10, b: 2, c: 1 }, p: { xa: 0.3, xb: 0.7 } })
  near(r.expectedT, 0.3 * 11 + 0.7 * 3)
  assert.equal(r.scenarios.length, 2)
  assert.deepEqual(r.main.path, ['b', 'c'], '가장 흔한 시나리오가 대표 경로')
  near(r.criticality.a, 0.3); near(r.criticality.b, 0.7); near(r.criticality.c, 1)
})

test('loop back from an exclusive gateway adds p/(1-p) × body length', () => {
  const g = buildGraph({
    activities: [A('a'), A('b'), A('c')], gateways: [G('x', 'exclusiveGateway')], events: [E('s', 'startEvent'), E('e', 'endEvent')],
    sequences: [S('s', 'a'), S('a', 'b'), S('b', 'x'), S('x', 'c', 'ok'), S('x', 'b', 'back'), S('c', 'e')],
  })
  assert.ok(g.back.has('back'))
  const r = criticalPath(g, { dur: { a: 1, b: 2, c: 1 }, p: { ok: 0.75, back: 0.25 } })
  near(r.loops[0].passes, 1 / 3)
  near(r.expectedT, 1 + 2 + 2 / 3 + 1)
})

test('remaining path of a running instance: done steps keep their times, the active one gets what is left', () => {
  const g = buildGraph({ activities: [A('a'), A('b'), A('c')], events: [E('s', 'startEvent'), E('e', 'endEvent')], sequences: [S('s', 'a'), S('a', 'b'), S('b', 'c'), S('c', 'e')] })
  const H = 3600_000, t0 = Date.UTC(2026, 9, 1)
  const prof = { start: t0, now: t0 + 2 * H, steps: [
    { activityId: 'a', ready: t0, finish: t0 + H, done: true },
    { activityId: 'b', ready: t0 + H, finish: null, done: false },
  ] }
  const r = remainingPath(g, { dur: { a: 7200, b: 10800, c: 3600 }, p: {} }, prof)
  assert.equal(r.remainingSec, 3 * 3600)
  assert.equal(r.expectedEnd, t0 + 5 * H)
  assert.deepEqual(r.path, ['b', 'c'])
})

// ---------- on the simulated 달빛커피 history (engine-shaped rows) ----------
function demo() {
  const people = { jang: 'u1', minji: 'u2', seoyeon: 'u3' }
  const names = { jang: '장진영', minji: '김민지', seoyeon: '박서연' }
  const now = Date.UTC(2026, 9, 27, 3)
  const sims = simulate({ people, names, from: Date.UTC(2026, 7, 3), to: now })
  const els = contract(people).processDefinition.elements
  const def = {
    activities: els.filter((e) => e.elementType === 'Activity').map((e) => ({ id: e.id, name: e.name, role: e.role, type: 'userTask', agentMode: e.agentMode, orchestration: e.orchestration })),
    gateways: els.filter((e) => e.elementType === 'Gateway').map((e) => ({ id: e.id, name: e.name, type: e.type === 'ParallelGateway' ? 'parallelGateway' : 'exclusiveGateway' })),
    events: els.filter((e) => e.elementType === 'Event').map((e) => ({ id: e.id, name: e.name, type: e.type === 'StartEvent' ? 'startEvent' : 'endEvent' })),
    sequences: els.filter((e) => e.elementType === 'Sequence').map((e) => ({ id: e.id, source: e.source, target: e.target, condition: e.condition })),
  }
  const data = { def, instances: [], todos: [], history: [], events: [], now }
  for (const s of sims) {
    const r = engineRows({ instId: s.instId, defId: DEF_ID, steps: s.steps })
    data.instances.push({ id: s.instId, name: s.name, status: 'COMPLETED' })
    data.todos.push(...r.todos); data.history.push(...r.history); data.events.push(...r.events)
  }
  return { a: analyze(data), sims }
}
const D = demo()

test('analysis: every completed instance decomposes to its lead time; pre-created TODO rows do not inflate waits', () => {
  for (const i of D.a.instances) assert.equal(Object.values(i.totals).reduce((x, y) => x + y, 0), i.leadSec)
  const fin = D.a.steps.find((s) => s.id === 'finance_review')
  assert.ok(fin.sums.review_wait > 0 && fin.sums.queue_wait === 0, '에이전트 제안서 뒤 사람 대기는 검토 대기')
  const plan = D.a.steps.find((s) => s.id === 'floor_plan')
  assert.ok(plan.medianWait < 86400, '평면도 대기는 인스턴스 시작부터가 아니라 접수 뒤부터')
  // the simulated work time comes back out of the engine-shaped rows
  const sim = D.sims.flatMap((s) => s.steps).filter((x) => x.activityId === 'floor_plan')
  const want = sim.reduce((s, x) => s + (x.finish - x.start) / 1000, 0) / sim.length
  near(D.a.steps.find((s) => s.id === 'floor_plan').avgWork, want, 2)
})

test('analysis: branch frequencies, rework rate and first-pass yield from the 보완 loop', () => {
  const b = D.a.branches.gw_review.edges
  const back = b.find((e) => e.id === 'seq_back'), ok = b.find((e) => e.id === 'seq_approved')
  const reruns = D.sims.reduce((s, x) => s + x.steps.filter((y) => y.activityId === 'finance_review').length - 1, 0)
  assert.equal(back.count, reruns)
  near(back.p + ok.p, 1)
  const fin = D.a.steps.find((s) => s.id === 'finance_review')
  near(fin.reworkRate, (fin.frequency - fin.instances) / fin.frequency * 100)
  assert.ok(fin.fpy < 1)
})

test('value stream: flow efficiency = Σ work / lead time', () => {
  const v = valueStream(D.a)
  const done = D.a.instances.filter((i) => i.status === 'COMPLETED')
  near(v.flowEfficiency, done.reduce((s, i) => s + i.workSec, 0) / done.reduce((s, i) => s + i.leadSec, 0), 1e-9)
  assert.ok(v.flowEfficiency > 0 && v.flowEfficiency < 0.2)
  assert.deepEqual(v.steps.map((s) => s.id), ['intake', 'floor_plan', 'quote_draft', 'proposal', 'finance_review', 'reply'])
})

test('constraint: 재무 검토 (박서연) — highest utilisation, most of the lead time waiting in front of it', () => {
  const res = resources(D.a)
  const c = constraintOf(res)
  assert.equal(c.name, '박서연')
  assert.ok(c.capacityBound && c.rho > 0.7)
  assert.ok(c.waitShare > 0.5)
  const f = focusingSteps(D.a, { labels: { amount: '견적 금액' } })
  assert.deepEqual(f.steps.map((s) => s.stage), ['identify', 'exploit', 'subordinate', 'elevate', 'repeat'])
  for (const x of [...f.steps[1].actions, ...f.steps[3].actions]) assert.ok(x.after.leadSec < x.before.leadSec, `${x.title} 이 리드타임을 줄여야 함`)
})

test('what-if: capacity, pre-draft, skip under a threshold, automate, parallel', () => {
  const res = resources(D.a)
  const base = evaluate(D.a.g, buildModel(D.a, res))
  const cap = whatIf(D.a, res, [{ type: 'capacity', step: 'finance_review', add: 1 }])
  assert.equal(cap.before.leadSec, base.leadSec)
  assert.ok(cap.after.leadSec < cap.before.leadSec)
  assert.ok(cap.after.util.find((u) => u.name === '박서연').rho < cap.before.util.find((u) => u.name === '박서연').rho)
  const pre = whatIf(D.a, res, [{ type: 'predraft', step: 'finance_review', saving: 0.5 }])
  assert.ok(pre.after.steps.finance_review.work < pre.before.steps.finance_review.work)
  const share = skipShare(D.a, 'finance_review', 'amount', 5e7).share
  assert.ok(share > 0 && share < 1)
  const sk = whatIf(D.a, res, [{ type: 'skip', step: 'finance_review', field: 'amount', threshold: 5e7 }], { share: { finance_review: share } })
  near(sk.after.steps.finance_review.p, 1 - share, 1e-6)
  assert.ok(sk.def.gateways.some((g) => g.id === 'gw_skip_finance_review'))
  assert.equal(sk.def.sequences.find((s) => s.id === 'seq_skip_finance_review_skip').target, 'reply', '건너뛰면 승인 갈래(고객 회신)로')
  const au = whatIf(D.a, res, [{ type: 'automate', step: 'floor_plan' }])
  assert.equal(au.after.steps.floor_plan.kind, 'agent')
  assert.ok(au.after.leadSec < au.before.leadSec)
  const pa = whatIf(D.a, res, [{ type: 'parallel', step: 'finance_review' }])
  assert.ok(pa.def.gateways.some((g) => g.id === 'gw_par_finance_review_split'))
  assert.ok(pa.after.leadSec <= pa.before.leadSec)
  assert.ok(pa.after.flowEfficiency > 0)
})

test('transform: parallel rewires the step beside its predecessor; a bad request is refused', () => {
  const def = { activities: [A('p'), A('x'), A('n')], events: [E('s', 'startEvent'), E('e', 'endEvent')], sequences: [S('s', 'p'), S('p', 'x'), S('x', 'n'), S('n', 'e')] }
  const t = transformDefinition(def, [{ type: 'parallel', step: 'x' }])
  const g = buildGraph(t.def)
  const r = criticalPath(g, { dur: { p: 4, x: 3, n: 1 }, p: {} })
  assert.equal(r.expectedT, 5)
  assert.throws(() => transformDefinition(def, [{ type: 'parallel', step: 'p' }]), /동시에/)
})

test('pre-created work items that were never reached are not runs; a running instance keeps its whole remaining path', () => {
  const sim = D.sims[0]
  const t0 = Date.UTC(2026, 9, 26, 1)
  const H = 3600_000
  // a running instance: 접수 done, 평면도·견적 done, 제안서 작성 reached; the engine pre-created 재무 검토·고객 회신 as TODO
  const pre = (activityId, at) => ({ todo_id: `pre-${activityId}`, to_status: 'TODO', changed_at: new Date(at).toISOString(), rework_seq: 0 })
  const steps = sim.steps.filter((x) => ['intake', 'floor_plan', 'quote_draft'].includes(x.activityId)).map((x, i) => ({ ...x, todoId: `r${i}`, createdAt: t0, ready: x.activityId === 'intake' ? t0 : t0 + 60_000, start: x.activityId === 'intake' ? t0 : t0 + 2 * 60_000, finish: x.activityId === 'intake' ? t0 + 60_000 : t0 + H }))
  const rows = engineRows({ instId: 'run1', defId: DEF_ID, steps })
  const extra = ['proposal', 'finance_review', 'reply'].map((a) => ({ id: `pre-${a}`, instId: 'run1', activityId: a, activityName: a, userId: 'u', username: 'x', status: 'TODO', output: {} }))
  const a = analyze({ def: D.a.g.def, instances: [{ id: 'run1', status: 'RUNNING', current: ['proposal'] }], todos: [...rows.todos, ...extra], history: [...rows.history, ...['proposal', 'finance_review', 'reply'].map((x) => pre(x, t0))], events: rows.events, now: t0 + 2 * H })
  const ids = a.executions.map((x) => x.activityId).sort()
  assert.deepEqual(ids, ['floor_plan', 'intake', 'proposal', 'quote_draft'], '도달하지 않은 재무 검토·고객 회신은 실행이 아님')
  const res = resources(D.a)
  const m = buildModel(D.a, res)
  const prof = { ...a.instances[0], now: a.now, steps: a.executions.map((x) => ({ activityId: x.activityId, ready: x.ready, finish: x.finish, done: x.done })) }
  const { remainingPath } = cpmMod
  const r = remainingPath(D.a.g, { dur: Object.fromEntries(Object.entries(m.act).map(([k, x]) => [k, x.wait + x.work])), p: m.p }, prof)
  assert.deepEqual(r.path, ['proposal', 'finance_review', 'reply'])
  assert.ok(r.remainingSec > 86400)
})
