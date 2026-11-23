// 고쳐 보기(what-if) · 개선안 · 시행 전후의 셈(lib/ontology/flowplan.js)과 근무 시간의 쉬는 날(holidays.js) — DB · 모델 없이.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { whatIfFlow, normLever, opsOf, leverLabel, reviewOf, SAVE } from '../lib/ontology/flowplan.js'
import { erlangWq } from '../lib/improve/whatif.js'
import * as F from '../lib/ontology/flowtime.js'
import { daysOff } from '../lib/ontology/holidays.js'

const P = 'process:p'
// a small company: 접수(agent) → 도면(디자이너 1명, 줄이 섬) → 견적(영업 4명) → 회신(고객, 바깥)
const model = () => ({
  proc: { key: P, name: '견적' },
  tasks: [
    { key: '접수', role: '영업', agent: true, outside: false, wip: 0, inPerDay: 1.5, perDay: 1.5, pastH: 0.1, fastH: 0.05, clearH: 0, grade: 'run' },
    { key: '도면', role: '디자이너', agent: false, outside: false, wip: 8, inPerDay: 1.5, perDay: 1.1, pastH: 30, fastH: 5, clearH: 65.5, grade: 'run' },
    { key: '견적', role: '영업', agent: false, outside: false, wip: 1, inPerDay: 1.5, perDay: 1.5, pastH: 3, fastH: 2, clearH: 6, grade: 'run' },
    { key: '회신', role: '고객', agent: false, outside: true, wip: 1, inPerDay: 1.5, perDay: 1.5, pastH: 10, fastH: 2, clearH: 6, grade: 'mined' },
  ],
  path: { steps: ['접수', '도면', '견적', '회신'], parallel: [] },
  roles: [
    { role: '디자이너', members: 1, items: [{ task: '도면', proc: P, wip: 8, inPerDay: 1.5, perDay: 1.1 }, { task: '일정', proc: 'process:q', wip: 6, inPerDay: 0.5, perDay: 0.3 }] },
    { role: '영업', members: 4, items: [{ task: '견적', proc: P, wip: 1, inPerDay: 1.5, perDay: 1.5 }] },
  ],
  agentH: 0.1,
})
const role = (side, r) => side.roles.find((x) => x.role === r)
const step = (side, k) => side.steps.find((s) => s.key === k)

test('레버: 지도 동작에서 읽고(말로 고치기 · 의견), 정할 때 다시 지도 동작으로', () => {
  assert.deepEqual(normLever({ op: 'set_runner', args: { task: '도면', runner: 'draft' } }), { type: 'draft', task: '도면', save: SAVE })
  assert.deepEqual(normLever({ op: 'set_runner', args: { task: '도면', runner: 'agent' } }), { type: 'agent', task: '도면' })
  assert.equal(normLever({ op: 'set_runner', args: { task: '도면', runner: 'person' } }), null)
  assert.equal(normLever({ op: 'rename_task', args: { task: '도면', name: '평면도' } }), null, '이름 바꾸기는 셈에 들지 않는다')
  assert.equal(normLever({ op: 'set_requirement', args: { task: '견적', requirement: 'optional' } }).assumed, true)
  assert.equal(normLever({ type: 'capacity', role: '디자이너', people: [{ id: 'u1', name: '정하나' }] }).n, 1)
  assert.equal(normLever({ type: 'draft', task: '도면', save: 3 }).save, 0.9, '덜기는 90%까지')
  const lv = [{ type: 'draft', task: '도면' }, { type: 'capacity', role: '디자이너', n: 1 }, { type: 'skip', task: '견적', share: 0.3 }, { type: 'parallel', a: '도면', b: '견적' }, { type: 'demand', pct: 10 }]
  assert.deepEqual(opsOf(lv).map((o) => `${o.op}:${o.args.runner || o.args.requirement || o.args.a || ''}`), ['set_runner:draft', 'set_requirement:optional', 'set_parallel:도면'],
    '사람 더하기는 역할에, 들어오는 건은 가정이라 지도 동작이 아니다')
  assert.match(leverLabel(normLever({ type: 'capacity', role: '디자이너', people: [{ id: 'u1', name: '정하나' }] })), /「디자이너」 역할에 정하나 님을 더함/)
})

test('고칠 것이 없으면 앞 · 뒤가 같다', () => {
  const w = whatIfFlow(model(), [])
  assert.equal(w.after.pastH, w.before.pastH)
  assert.equal(w.after.nowH, w.before.nowH)
  assert.deepEqual(w.after.bottleneck, w.before.bottleneck)
  assert.equal(w.notes.some((n) => n.includes('계속 쌓여요')), false, '고칠 것이 없으면 「바꾼 뒤에도」 말을 하지 않는다')
})

test('사람 더하기: 그 역할 앞의 줄만 줄고(얼랭 C), 다른 역할은 그대로 · 가동률이 반', () => {
  const w = whatIfFlow(model(), [{ type: 'capacity', role: '디자이너', n: 1 }])
  const b0 = role(w.before, '디자이너'), b1 = role(w.after, '디자이너')
  assert.equal(b1.members, 2)
  assert.ok(Math.abs(b1.rho - b0.rho / 2) < 0.02, `${b0.rho} → ${b1.rho}`)
  assert.ok(step(w.after, '도면').pastH < step(w.before, '도면').pastH)
  assert.equal(step(w.after, '견적').pastH, step(w.before, '견적').pastH, '영업은 그대로')
  assert.ok(w.after.nowH < w.before.nowH && w.after.pastH < w.before.pastH)
  // 지금 들어오면: 오늘의 줄(8건)을 두 배 빠르기로 — 치우는 시간이 반
  assert.ok(Math.abs(step(w.after, '도면').nowH - 65.5 / 2) < 1, String(step(w.after, '도면').nowH))
})

test('대기 비율은 옛 what-if 의 규칙(얼랭 C, 지금 기록에 맞춤)과 같다', () => {
  // 줄이 서지 않은 역할(가동률 < 1): 사람 더하기의 대기 비율 = Wq(λ, μ, 2) / Wq(λ, μ, 1)
  const m = model()
  m.tasks[1] = { ...m.tasks[1], wip: 1, perDay: 1.5, clearH: 6 }
  m.roles[0].items = [{ task: '도면', proc: P, wip: 1, inPerDay: 1.5, perDay: 1.5 }]
  const w = whatIfFlow(m, [{ type: 'capacity', role: '디자이너', n: 1 }])
  const work = 5, wait0 = 30 - work
  const cap = Math.max((1 * 9) / work, 1.5 * 1.15, 1.5)
  const f = erlangWq(1.5, (cap * 2) / 2, 2) / erlangWq(1.5, cap, 1)
  assert.ok(Math.abs(step(w.after, '도면').pastH - (work + wait0 * f)) < 0.05, `${step(w.after, '도면').pastH} vs ${work + wait0 * f}`)
})

test('에이전트가 맡음: 그 일의 줄이 사람에게서 빠지고, 병목이 다음 일로 옮겨 간다', () => {
  const w = whatIfFlow(model(), [{ type: 'agent', task: '도면' }])
  assert.equal(step(w.after, '도면').agent, true)
  assert.equal(step(w.after, '도면').pastH, 0.1)
  assert.ok(role(w.after, '디자이너').rho < role(w.before, '디자이너').rho)
  assert.deepEqual(w.moved, { from: '도면', to: '견적' })
  assert.ok(w.after.monthly.items < w.before.monthly.items, '사람 손이 가는 건이 준다')
})

test('AI 초안 먼저: 그 일의 사람 일이 덜고, 역할의 처리 능력이 그만큼 는다', () => {
  const w = whatIfFlow(model(), [{ type: 'draft', task: '도면', save: 0.5 }])
  assert.ok(role(w.after, '디자이너').rho < role(w.before, '디자이너').rho)
  assert.ok(step(w.after, '도면').pastH < step(w.before, '도면').pastH)
  assert.ok(w.after.monthly.hours < w.before.monthly.hours)
  assert.equal(w.after.monthly.items, w.before.monthly.items, '사람이 마무리하므로 건 수는 그대로')
  assert.ok(w.notes.some((n) => n.includes('50%') && n.includes('가정')))
})

test('건너뛰기 · 나란히 · 빼기: 흔한 길의 시간', () => {
  const skip = whatIfFlow(model(), [{ type: 'skip', task: '견적', share: 0.5 }])
  // half the cases pass it — and the role's queue gets shorter too, so at most half
  assert.ok(step(skip.after, '견적').pastH <= step(skip.before, '견적').pastH * 0.5 + 0.01, `${step(skip.after, '견적').pastH}`)
  const par = whatIfFlow(model(), [{ type: 'parallel', a: '견적', b: '회신' }])
  assert.ok(Math.abs(par.before.pastH - par.after.pastH - 3) < 0.15, '짧은 쪽(견적 3시간)은 더하지 않는다')
  const rm = whatIfFlow(model(), [{ type: 'remove', task: '견적' }])
  assert.ok(!rm.after.steps.some((s) => s.key === '견적'))
  const none = whatIfFlow(model(), [{ type: 'agent', task: '없는 일' }])
  assert.equal(none.skipped.length, 1)
})

test('들어오는 건 +20%: 가동률이 그만큼 오르고 할 일(예상)이 는다', () => {
  const w = whatIfFlow(model(), [{ type: 'demand', pct: 20 }])
  assert.ok(Math.abs(role(w.after, '디자이너').rho / role(w.before, '디자이너').rho - (1.5 * 1.2 + 0.5) / 2) < 0.02, '디자이너: 이 프로세스의 일만 +20%')
  assert.ok(w.after.bottleneck.wip > w.before.bottleneck.wip)
})

test('시행 전후: 예상과 실측을 견준다', () => {
  const plan = { baseline: { pastH: 46, nowH: 79, bottleneck: { key: '도면', wip: 8 }, constraint: { role: '디자이너', perPerson: 17 } },
    predicted: { pastH: 16, nowH: 36, steps: [{ key: '도면', ahead: 1.2 }], roles: [{ role: '디자이너', perPerson: 2.9 }] } }
  const r = reviewOf(plan, { pastH: 14, nowH: 60, bottleneck: { key: '재무', wip: 2 }, tasks: [{ key: '도면', wip: 9 }], roles: [{ role: '디자이너', perPerson: 0.5 }] })
  const by = Object.fromEntries(r.rows.map((x) => [x.key, x.verdict]))
  assert.equal(by.path, 'met')
  assert.equal(by.now, 'partly')
  assert.equal(by.bott, 'worse')
  assert.deepEqual(r.moved, { from: '도면', to: '재무' })
})

test('쉬는 날: 공휴일은 근무 시간에서 빠지고, 회사가 더하거나 뺄 수 있다', () => {
  // 2026-10-08(목) 17시 → 10-12(월) 10시: 10-09 한글날을 빼면 근무 2시간
  assert.equal(F.workMs(new Date('2026-10-08T17:00:00+09:00'), new Date('2026-10-12T10:00:00+09:00')) / F.HOUR, 2)
  assert.equal(new Date(F.addWork(new Date('2026-10-08T17:00:00+09:00'), 2)).toISOString(), new Date('2026-10-12T10:00:00+09:00').toISOString())
  const off = daysOff('2026-11-20,-2026-10-09')
  assert.ok(off.has('2026-11-20') && !off.has('2026-10-09') && off.has('2026-12-25'))
  const W = { ...F.WORK, off }
  assert.equal(F.workMs(new Date('2026-10-08T17:00:00+09:00'), new Date('2026-10-12T10:00:00+09:00'), W) / F.HOUR, 11, '한글날을 일하는 날로 둔 회사')
})
