// 지도에 그릴 관계(spec pgpt-pro_process-ontology, 「쓰이지 않게 된 우회 경로의 은퇴」): 은퇴 후보 · 은퇴한 관계는 θ 보다 드물어도
// 그린다 — 검토할 대상이 기본 지도에서 안 보였다(2026-11-13 녹화). 하지만 그 관계로만 닿는 일을 끌어오지는 않는다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { visibleGraph, eventGraph, EV } from '../../src/components/ontology/mapView.js'

const T = (key, x = {}) => ({ key, procs: ['b'], proc: 'b', ...x })
const E = (from, to, p, x = {}) => ({ from, to, p, ...x })
const map = {
  processes: [{ key: 'b', theta: 0.2, summary_theta: 0.1 }],
  tasks: [T('요청', { entry_share: 1 }), T('평면도'), T('견적'), T('법무')],
  edges: [E('요청', '평면도', 0.9), E('평면도', '견적', 1), E('요청', '견적', 0.09, { stale: true }),
    E('견적', '평면도', 0.05, { status: 'retired' }), E('견적', '법무', 0.03, { stale: true })],
}

test('은퇴 후보 · 은퇴한 관계는 θ 보다 드물어도 보이는 일 사이에서는 그린다', () => {
  const v = visibleGraph(map, { proc: 'b', mode: 'auto' })
  const ids = v.edges.map((e) => `${e.from}>${e.to}`)
  assert.ok(ids.includes('요청>견적'), '은퇴 후보')
  assert.ok(ids.includes('견적>평면도'), '은퇴함')
  assert.ok(!v.tasks.some((t) => t.key === '법무'), '은퇴 후보로만 닿는 일은 끌어오지 않는다')
  assert.ok(!ids.includes('견적>법무'))
})

test('θ 보다 드문 보통 관계는 빠진다', () => {
  const m = { ...map, edges: [...map.edges, E('평면도', '요청', 0.04)] }
  const ids = visibleGraph(m, { proc: 'b', mode: 'auto' }).edges.map((e) => `${e.from}>${e.to}`)
  assert.ok(!ids.includes('평면도>요청'))
  assert.ok(visibleGraph(m, { proc: 'b', mode: 'all' }).edges.some((e) => e.from === '평면도' && e.to === '요청'))
})

// v0.3: 한 일이 여러 프로세스에 든다(procs) — 프로세스를 고르면 그 프로세스의 θ 와 그 안의 시작 비율로
test('여러 프로세스에 든 일은 어느 프로세스를 골라도 보이고, 고른 프로세스의 θ 로 거른다', () => {
  const m = {
    processes: [{ key: 'b', theta: 0.2, summary_theta: 0.2 }, { key: 'c', theta: 0.01, summary_theta: 0.01 }],
    tasks: [T('요청', { procs: ['b', 'c'], entry_share: 0.9 }), T('평면도'), T('보수', { procs: ['c'], proc: 'c' })],
    edges: [E('요청', '평면도', 0.8), E('요청', '보수', 0.05)],
    hasTask: [{ from: 'b', to: '요청', entry_share: 0.8 }, { from: 'c', to: '요청', entry_share: 1 }],
  }
  const c = visibleGraph(m, { proc: 'c', mode: 'auto' })
  assert.deepEqual(c.tasks.map((t) => t.key).sort(), ['보수', '요청'])
  assert.equal(c.tasks.find((t) => t.key === '요청').entry_share, 1, '그 프로세스 안의 시작 비율')
  assert.ok(c.procShares)
  const b = visibleGraph(m, { proc: 'b', mode: 'auto' })
  assert.deepEqual(b.tasks.map((t) => t.key).sort(), ['요청', '평면도'])
})

test('사건 보기: 루틴은 사건 → 일, 결과물이 있는 넘어감은 일 → 사건 → 일, 없는 넘어감은 일 → 일', () => {
  const m = {
    processes: [{ key: 'b', kind: 'flow', theta: 0, summary_theta: 0 }, { key: 'r', kind: 'routine', role: '영업', theta: 0, summary_theta: 0 }],
    tasks: [T('요청', { entry_share: 1 }), T('평면도'), T('제안서'), T('직인', { procs: ['r'], proc: 'r', kind: 'habit' })],
    edges: [E('요청', '평면도', 1), E('평면도', '제안서', 1)],
    events: [{ key: 'mail', kind: 'mail', name: '요청 메일 도착', n: 3 }, { key: 'artifact:평면도:drawing', kind: 'artifact', name: '평면도 결과물(도면)', n: 3 },
      { key: 'artifact:@영업:sheet', kind: 'artifact', name: '표 결과물(영업)', n: 2 }],
    triggers: [{ from: 'mail', to: '요청', p: 1 }, { from: 'artifact:평면도:drawing', to: '제안서', p: 1, split: 'and' }, { from: 'artifact:@영업:sheet', to: '직인', p: 0.75, scope: 'role:영업' }],
    raises: [{ from: '평면도', to: 'artifact:평면도:drawing', p: 1 }],
  }
  const r = eventGraph(m, { proc: 'r', mode: 'summary' })
  assert.deepEqual(r.tasks.map((t) => t.key), ['직인'])
  assert.deepEqual(r.edges.map((e) => `${e.kind}:${e.from}>${e.to}`), [`trigger:${EV}artifact:@영업:sheet>직인`])
  const f = eventGraph(m, { proc: 'b', mode: 'summary' })
  const ids = f.edges.map((e) => `${e.kind}:${e.from.replace(EV, '@')}>${e.to.replace(EV, '@')}`).sort()
  assert.deepEqual(ids, ['next:요청>평면도', 'raise:평면도>@artifact:평면도:drawing', 'trigger:@artifact:평면도:drawing>제안서', 'trigger:@mail>요청'])
  assert.equal(f.entries[0], `${EV}mail`)
  assert.ok(f.events.find((e) => e.ev.key === 'artifact:평면도:drawing').and)
  assert.equal(f.events.find((e) => e.ev.key === 'artifact:평면도:drawing').label, '결과물(도면)')
})

test('단순 프로세스(일 하나짜리 흐름): 전체 지도에서 빼면 그 흐름에만 든 일과 그 관계가 빠지고, 다른 흐름에도 든 일은 남는다', async () => {
  const { isSimple, withoutSimple } = await import('../../src/components/ontology/mapView.js')
  const map = {
    processes: [{ key: 'p1', kind: 'flow', tasks: ['뉴스클리핑'] }, { key: 'p2', kind: 'flow', tasks: ['보고'] }, { key: 'p3', kind: 'flow', tasks: ['계획', '보고'] }, { key: 'r', kind: 'routine', tasks: ['직인'] }],
    tasks: [{ key: '뉴스클리핑', procs: ['p1'] }, { key: '보고', procs: ['p2', 'p3'] }, { key: '계획', procs: ['p3'] }, { key: '직인', procs: ['r'] }, { key: '외톨이', procs: [] }],
    edges: [{ from: '뉴스클리핑', to: '__end__' }, { from: '계획', to: '보고' }, { from: '보고', to: '__end__' }],
    triggers: [{ from: 'e1', to: '뉴스클리핑' }, { from: 'e2', to: '계획' }], raises: [{ from: '뉴스클리핑', to: 'e3' }],
  }
  assert.deepEqual(map.processes.filter(isSimple).map((p) => p.key), ['p1', 'p2'])
  const m = withoutSimple(map)
  assert.deepEqual(m.tasks.map((t) => t.key), ['보고', '계획', '직인', '외톨이'])
  assert.deepEqual(m.edges.map((e) => `${e.from}>${e.to}`), ['계획>보고', '보고>__end__'])
  assert.equal(m.triggers.length, 1); assert.equal(m.raises.length, 0)
  assert.equal(m.hidden, 1)
  assert.deepEqual(m.processes.map((p) => p.key), ['p3', 'r'])
})
