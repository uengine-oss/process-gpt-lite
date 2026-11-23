// 흐름 분석의 셈(lib/ontology/flowtime.js) — DB 없이. 근무 시간 · 걸린 시간의 등급 · 기대 방문 · 흔한 길 · 할 일(WIP) · 병목 · 회사의 제약 · 흔한 길의 시간.
import test from 'node:test'
import assert from 'node:assert/strict'
import * as F from '../lib/ontology/flowtime.js'
import { toCases } from '../lib/ontology/stats.js'

const H = F.HOUR
// Korea's wall clock → epoch ms
const kst = (s) => new Date(`${s}+09:00`).getTime()

test('근무 시간: 금요일 18시 → 월요일 10시는 근무 1시간, 주말 · 밤은 세지 않는다', () => {
  assert.equal(F.workMs(kst('2026-11-13T18:00:00'), kst('2026-11-16T10:00:00')) / H, 1) // 금 → 월
  assert.equal(F.workMs(kst('2026-11-13T17:00:00'), kst('2026-11-16T10:00:00')) / H, 2)
  assert.equal(F.workMs(kst('2026-11-16T08:00:00'), kst('2026-11-16T20:00:00')) / H, 9) // 하루 9시간
  assert.equal(F.workMs(kst('2026-11-14T09:00:00'), kst('2026-11-15T18:00:00')), 0) // 토 · 일
  assert.equal(F.workMs(kst('2026-11-16T10:00:00'), kst('2026-11-16T09:00:00')), 0)
})

test('근무 시간 더하기: addWork 는 workMs 의 반대', () => {
  const a = kst('2026-11-13T16:00:00')
  const b = F.addWork(a, 5) // 금 16시 + 5시간 = 금 2시간 + 월 3시간 → 월 12시
  assert.equal(b, kst('2026-11-16T12:00:00'))
  assert.equal(F.workMs(a, b) / H, 5)
  // 밤에 시작하면 다음 근무 시작부터
  assert.equal(F.addWork(kst('2026-11-16T21:00:00'), 1), kst('2026-11-17T10:00:00'))
})

test('기록 등급: 응답 시간은 앞 일이 넘긴 때부터 이 일이 넘긴 때까지, 기록이 하나뿐인 첫 단계는 잴 수 없다', () => {
  const ev = (c, task, at) => ({ case: c, task, at: kst(at) })
  const cases = toCases([
    ev('a', '접수', '2026-11-16T09:00:00'),
    ev('a', '견적', '2026-11-16T11:00:00'), ev('a', '견적', '2026-11-16T15:00:00'), // 견적: 접수 끝(9시) → 15시 = 6시간
    ev('a', '회신', '2026-11-17T10:00:00'), // 회신: 15시 → 다음 날 10시 = 근무 4시간
  ])
  const s = F.minedSamples(cases)
  assert.equal(s.length, 2, '첫 단계(기록 하나)는 빠진다')
  assert.deepEqual(s.map((x) => [x.task, x.workMs / H]), [['견적', 6], ['회신', 4]])
  assert.equal(s[1].wallMs / H, 19)
})

test('걸린 시간의 등급: 실행 건이 5건이면 실행 기록, 그보다 적으면 기록(추정)', () => {
  const mk = (h) => ({ workMs: h * H, wallMs: h * H })
  const mined = [1, 2, 3].map(mk), run4 = [4, 4, 4, 4].map(mk), run5 = [5, 5, 5, 5, 5].map(mk)
  assert.equal(F.taskTime(mined, run4).grade, 'mined')
  assert.equal(F.taskTime(mined, run4).medH, 2)
  assert.equal(F.taskTime(mined, run4).estimated, true)
  assert.equal(F.taskTime(mined, run5).grade, 'run')
  assert.equal(F.taskTime(mined, run5).medH, 5)
  assert.equal(F.taskTime([], []).grade, 'none')
})

test('기대 방문: 되돌아가는 길 확률 p 면 그 일은 1/(1−p) 번, 갈래는 확률대로', () => {
  const e = [
    { from: 'A', to: 'B', p: 1 },
    { from: 'B', to: 'A', p: 0.25 }, { from: 'B', to: 'C', p: 0.75 },
    { from: 'C', to: F.END, p: 0.6 }, { from: 'C', to: 'D', p: 0.4 },
    { from: 'D', to: F.END, p: 1 },
  ]
  const v = F.expectedVisits(e, { A: 1 })
  assert.ok(Math.abs(v.get('A') - 1 / 0.75) < 1e-6)
  assert.ok(Math.abs(v.get('B') - 1 / 0.75) < 1e-6)
  assert.ok(Math.abs(v.get('C') - 1) < 1e-6)
  assert.ok(Math.abs(v.get('D') - 0.4) < 1e-6)
  // 여러 시작점: 시작 몫으로 가중
  const w = F.expectedVisits([{ from: 'A', to: 'C', p: 1 }, { from: 'B', to: 'C', p: 1 }, { from: 'C', to: F.END, p: 1 }], { A: 3, B: 1 })
  assert.ok(Math.abs(w.get('A') - 0.75) < 1e-9 && Math.abs(w.get('C') - 1) < 1e-9)
})

test('흔한 길: 엔진이 고르듯 매번 가장 흔한 길로, 각 일은 한 번 — 짧은 길을 편애하지 않는다', () => {
  // 계약 흐름의 모양: 날인 뒤 대부분 확정으로 가고(0.78), 회신으로 바로 가는 건 드물다(0.11). 확률을 곱한 「가장 그럴듯한 길」은
  // 날인 → 회신(0.11 × 0.9 = 0.099)이 날인 → 확정 → 조율 → 끝(0.78 × 0.55 × 0.2 = 0.086)보다 커서 짧은 쪽을 고른다
  const e = [
    { from: '날인', to: '확정', p: 0.78 }, { from: '날인', to: '회신', p: 0.11 }, { from: '날인', to: '발주', p: 0.11 },
    { from: '확정', to: '조율', p: 0.55 }, { from: '확정', to: '발주', p: 0.45 },
    { from: '조율', to: '발주', p: 0.6 }, { from: '조율', to: F.END, p: 0.2 }, { from: '조율', to: '회신', p: 0.2 },
    { from: '발주', to: '조율', p: 0.7 }, { from: '발주', to: '회신', p: 0.3 },
    { from: '회신', to: F.END, p: 0.9 }, { from: '회신', to: '조율', p: 0.1 },
  ]
  const c = F.commonPath(e, '날인')
  assert.deepEqual(c.path, ['날인', '확정', '조율', '발주', '회신'], '발주 뒤 조율은 이미 지났으니 그다음 흔한 회신으로')
  assert.ok(Math.abs(c.p - 0.78 * 0.55 * 0.6 * 0.3 * 0.9) < 1e-4)
  // 되돌아감이 있어도 같은 일을 두 번 지나지 않고, 끝이 가장 흔하면 거기서 끝난다
  const loop = [{ from: 'A', to: 'B', p: 1 }, { from: 'B', to: 'A', p: 0.7 }, { from: 'B', to: F.END, p: 0.3 }]
  assert.deepEqual(F.commonPath(loop, 'A').path, ['A', 'B'])
  assert.deepEqual(F.commonPath([{ from: 'A', to: F.END, p: 0.6 }, { from: 'A', to: 'B', p: 0.4 }], 'A').path, ['A'])
})

test('할 일(WIP): 열린 행을 일마다 세고, 2주 동안 들어온 것 · 넘긴 것 · 치우는 데 드는 시간(리틀의 법칙)', () => {
  const now = kst('2026-11-19T15:00:00')
  const r = (task, status, start, end) => ({ task, status, start: kst(start), end: end ? kst(end) : NaN })
  const rows = [
    r('평면도', 'IN_PROGRESS', '2026-11-10T10:00:00'), r('평면도', 'TODO', '2026-11-18T10:00:00'), r('평면도', 'IN_PROGRESS', '2026-11-19T10:00:00'),
    r('평면도', 'DONE', '2026-11-09T10:00:00', '2026-11-12T10:00:00'), r('평면도', 'DONE', '2026-11-12T10:00:00', '2026-11-17T10:00:00'),
    r('견적', 'DONE', '2026-11-17T10:00:00', '2026-11-17T12:00:00'), r('견적', 'CANCELLED', '2026-11-17T10:00:00'),
  ]
  const L = F.loadOf(rows, { now })
  const p = L.by.get('평면도')
  assert.equal(p.wip, 3)
  assert.equal(p.done, 2)
  assert.equal(p.arrived, 5)
  assert.equal(p.growing, true)
  assert.ok(p.oldestH > 60, `가장 오래 기다린 것은 11-10부터(근무 ${p.oldestH}시간)`)
  // 근무일마다 2건 ÷ 근무일 수 → 3건을 치우는 근무 시간
  assert.ok(Math.abs(p.clearH - (3 / p.perDay) * F.WORK_H) < 0.05)
  assert.equal(L.by.get('견적').wip, 0, '닫힌 것(CANCELLED)은 할 일이 아니다')
})

test('병목: 우리 쪽 사람 단계 가운데 할 일이 가장 많은 일 — 바깥 역할(고객) · 에이전트 단계는 빠진다', () => {
  const load = new Map([['날인', { wip: 9 }], ['초안', { wip: 7 }], ['평면도', { wip: 6, oldestH: 30 }], ['견적', { wip: 6, oldestH: 10 }], ['회신', { wip: 1 }]])
  const tasks = [{ key: '날인', role: '고객', outside: true }, { key: '초안', role: '에이전트', agent: true }, { key: '평면도', role: '디자이너' }, { key: '견적', role: '영업' }, { key: '회신', role: '영업' }]
  const b = F.bottleneckOf(tasks, load)
  assert.equal(b.key, '평면도', '같은 수면 더 오래 기다린 쪽')
  assert.equal(b.by, 'wip')
  assert.equal(b.second, '견적')
  // 아직 실행이 없으면 기록의 보통 쌓인 양(추정)으로
  const none = F.bottleneckOf(tasks, new Map(), new Map(), new Map([['평면도', 1.2], ['견적', 2.5], ['날인', 9]]))
  assert.equal(none.key, '견적')
  assert.equal(none.by, 'mined')
})

test('회사의 제약: 여러 프로세스의 할 일을 역할로 모아 한 사람당 — 한 프로세스만 볼 때와 다를 수 있다', () => {
  const roles = [{ key: '영업', members: 4 }, { key: '디자이너', members: 1 }, { key: '고객', members: 0, outside: true }, { key: '에이전트', agent: true }]
  const items = [
    { task: '견적', proc: 'A', role: '영업', wip: 8 }, { task: '회신', proc: 'A', role: '영업', wip: 2 },
    { task: '평면도', proc: 'A', role: '디자이너', wip: 3 }, { task: '일정 조율', proc: 'B', role: '디자이너', wip: 3 },
    { task: '날인', proc: 'B', role: '고객', wip: 20 },
  ]
  const C = F.constraintOf(roles, items)
  // 프로세스 A 안에서는 견적(8)이 가장 많지만, 회사 전체로는 디자이너 한 사람이 6건 — 영업은 4명이 10건
  assert.equal(C.key, '디자이너')
  const d = C.roles.find((r) => r.role === '디자이너')
  assert.equal(d.wip, 6)
  assert.deepEqual(d.procs, { A: 3, B: 3 })
  assert.equal(C.roles.find((r) => r.role === '영업').perPerson, 2.5)
  assert.ok(!C.roles.some((r) => r.role === '고객' || r.role === '에이전트'), '바깥 역할 · 에이전트는 제약 후보가 아니다')
})

test('흔한 길의 시간: 지난 건의 시간(기다림이 이미 들어 있음)과, 지금 줄이 선 곳은 쌓인 것을 치우는 시간 중 긴 쪽 — 두 번 더하지 않는다', () => {
  const times = new Map([['A', { medH: 1 }], ['B', { medH: 4 }], ['C', { medH: 2 }], ['D', { medH: 3 }], ['E', { medH: 5 }]])
  // B: 7건이 쌓였고 치우는 데 18시간 → 지금 들어오면 18시간 · E: 1건뿐이면 줄이 아니다(지난 건 시간 그대로)
  const load = new Map([['B', { wip: 7, clearH: 18 }], ['C', { wip: 0, clearH: 0 }], ['E', { wip: 1, clearH: 30 }]])
  const t = F.pathTime(['A', 'B', 'C', 'D', 'E'], times, load, { parallel: [['C', 'D']] })
  assert.equal(t.longest, 'B')
  assert.equal(t.steps.find((s) => s.key === 'C').beside, true, '나란히 하는 둘 중 짧은 쪽')
  assert.equal(t.pastH, 1 + 4 + 3 + 5)
  assert.equal(t.nowH, 1 + 18 + 3 + 5)
  assert.equal(t.extraH, 14)
  assert.equal(t.steps.find((s) => s.key === 'E').extraH, 0)
  // 줄이 섰는데 넘긴 것이 없으면(처리 0) 치우는 시간을 알 수 없다
  const stuck = F.pathTime(['B'], times, new Map([['B', { wip: 3, clearH: null }]]))
  assert.equal(stuck.steps[0].stuck, true)
  assert.equal(stuck.nowH, 4)
})

test('시간 몫: 방문 × 시간 ÷ 합', () => {
  const r = F.timeShares(new Map([['A', 1], ['B', 2]]), new Map([['A', { medH: 2 }], ['B', { medH: 4 }]]))
  assert.equal(r.leadH, 10)
  assert.equal(r.shares.get('B'), 0.8)
})

test('제안: 찾기 → 최대 활용 → 맞추기 → 늘리기 → 다시 보기, AI 후보 · 단계 규칙 · 역할 사람 수를 쓴다', () => {
  const s = F.suggestionsOf({ bott: { key: '평면도', wip: 9, oldestH: 40, perDay: 1.2 }, cand: { fit: 'mid' }, optional: true, onPath: true,
    role: { role: '디자이너', members: 1, wip: 12, perPerson: 12 }, constraint: '디자이너' })
  assert.deepEqual(s.map((x) => x.step), ['find', 'exploit', 'exploit', 'subordinate', 'elevate', 'repeat'])
  assert.match(s[0].text, /9건/)
  assert.match(s[1].text, /초안/)
  assert.equal(F.suggestionsOf({ bott: null }).length, 0)
  assert.equal(F.fmtH(0.5), '30분')
  assert.equal(F.fmtH(4), '4시간')
  assert.equal(F.fmtH(27), '3일')
})
