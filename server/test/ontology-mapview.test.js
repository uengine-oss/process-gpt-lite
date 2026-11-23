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

// 간선 설정(edge-step-condition): 프로세스를 고르면 결과물이 없는 넘어감도 「앞 단계 완료」 사건을 거친다 — 모든 진입이 사건 → 일 간선
test('사건 보기: 루틴은 사건 → 일, 결과물이 있는 넘어감은 일 → 사건 → 일, 없는 넘어감은 일 → 「완료」 → 일', () => {
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
  assert.deepEqual(ids, ['raise:요청>@done:요청', 'raise:평면도>@artifact:평면도:drawing', 'trigger:@artifact:평면도:drawing>제안서', 'trigger:@done:요청>평면도', 'trigger:@mail>요청'])
  assert.equal(f.entries[0], `${EV}mail`)
  assert.ok(!f.entries.includes(`${EV}done:요청`), '「완료」는 일이 일으키므로 시작이 아니다')
  const done = f.events.find((e) => e.ev.key === 'done:요청')
  assert.equal(done.ev.kind, 'done'); assert.equal(done.label, '요청 완료')
  assert.ok(f.edges.find((e) => e.kind === 'trigger' && e.event === 'done:요청').virtual, '지도에 아직 없는 「완료」 간선')
  // 전체 지도(프로세스를 고르지 않음)에는 「완료」를 만들어 넣지 않는다
  assert.ok(!eventGraph(m, { proc: '', mode: 'summary' }).events.some((e) => e.ev.kind === 'done'))
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

// 말로 프로세스 지도 고치기: 프로세스를 고르면 다듬은 흐름(map.refined[proc])을 그린다. 사람이 정한 관계는 θ 와 상관없이,
// 본 관계는 θ 그대로. 사람이 더한 단계는 「정했지만 아직 본 적 없어요」(unseen), 뺀 단계는 안 보인다.
const refinedMap = () => ({
  processes: [{ key: 'b', theta: 0.2, summary_theta: 0.2 }],
  tasks: [T('요청', { entry_share: 1, n_cases: 9 }), T('평면도', { n_cases: 7, candidate: true }), T('견적', { n_cases: 6 }), T('법무', { n_cases: 1 }), T('메모', { n_cases: 3 })],
  edges: [E('요청', '평면도', 0.9, { n: 8 }), E('평면도', '견적', 0.6, { n: 4 }), E('평면도', '메모', 0.4, { n: 3 }), E('견적', '법무', 0.1, { n: 1 }), E('견적', '__end__', 0.9, { n: 5 })],
  refined: {
    b: {
      said: false, corrections: 3, removed: { tasks: ['메모'], edges: [{ from: '평면도', to: '메모' }] },
      tasks: [{ key: '요청', role: '영업', n: 9, origin: '요청' }, { key: '도면 작성', role: '설계', n: 7, origin: '평면도', decided: true },
        { key: '견적', role: '', n: 6, origin: '견적' }, { key: '법무', role: '', n: 1, origin: '법무' },
        { key: '검토', role: '팀장', n: 0, origin: null, added: true, decided: true, unseen: true, runner: 'agent' }],
      edges: [{ from: '요청', to: '도면 작성', n: 8, p: 0.9 }, { from: '도면 작성', to: '견적', n: 0, p: 0.05, decided: true },
        { from: '견적', to: '법무', n: 1, p: 0.1 }, { from: '견적', to: '검토', n: 0, p: 0, decided: true, added: true },
        { from: '검토', to: '__end__', n: 0, p: 0, decided: true, added: true }],
      entries: ['요청'],
    },
  },
})
const ids = (v) => v.edges.map((e) => `${e.from}>${e.to}`).sort()

test('다듬은 흐름: 정한 관계는 θ 보다 드물어도, 본 관계는 θ 그대로 · 더한 단계는 unseen · 뺀 단계는 없음', () => {
  const v = visibleGraph(refinedMap(), { proc: 'b', mode: 'auto' })
  assert.equal(v.refined, true)
  assert.ok(v.decided)
  assert.deepEqual(v.tasks.map((t) => t.key).sort(), ['검토', '견적', '도면 작성', '요청'])
  assert.deepEqual(ids(v), ['검토>__end__', '견적>검토', '도면 작성>견적', '요청>도면 작성'])
  assert.ok(!ids(v).includes('견적>법무'), '본 관계는 θ 보다 드물면 빠진다')
  assert.ok(!v.tasks.some((t) => t.key === '메모'), '뺀 단계')
  const low = v.edges.find((e) => e.from === '도면 작성')
  assert.ok(low.decided && low.unseen, 'θ 보다 드문 정한 관계 · 0건이라 아직 본 적 없음')
  const seen = v.edges.find((e) => e.from === '요청')
  assert.ok(!seen.decided && !seen.unseen)
  const renamed = v.tasks.find((t) => t.key === '도면 작성')
  assert.equal(renamed.origin, '평면도')
  assert.equal(renamed.name, '도면 작성')
  assert.equal(renamed.n_cases, 7, '지도의 일(origin)에서 건수')
  assert.equal(renamed.candidate, true)
  assert.equal(renamed.role, '설계')
  assert.ok(renamed.decided && !renamed.unseen)
  const added = v.tasks.find((t) => t.key === '검토')
  assert.deepEqual({ name: added.name, role: added.role, n_cases: added.n_cases, added: added.added, decided: added.decided, unseen: added.unseen, procs: added.procs, runner: added.runner },
    { name: '검토', role: '팀장', n_cases: 0, added: true, decided: true, unseen: true, procs: ['b'], runner: 'agent' })
  assert.equal(v.entries[0], '요청')
  assert.equal(v.tasks.find((t) => t.key === '요청').entry_share, 1)
})

test('다듬은 흐름: 찾은 대로(flow found)는 지금 그대로', () => {
  const m = refinedMap()
  const plain = { ...m, refined: undefined }
  const f = visibleGraph(m, { proc: 'b', mode: 'auto', flow: 'found' })
  assert.equal(f.refined, false)
  assert.deepEqual(f, visibleGraph(plain, { proc: 'b', mode: 'auto' }))
  assert.ok(f.tasks.some((t) => t.key === '평면도') && f.tasks.some((t) => t.key === '메모'))
  assert.ok(!f.tasks.some((t) => t.key === '도면 작성'))
  // the whole map: a refined process that was not made by words stays as found
  assert.deepEqual(visibleGraph(m, { mode: 'auto' }), visibleGraph(plain, { mode: 'auto' }))
})

test('말로 만든 프로세스(said): 건이 없어도 전체 지도와 그 프로세스에 그려진다 · 칩 목록에서 단순으로 빠지지 않는다', async () => {
  const { isSimple } = await import('../../src/components/ontology/mapView.js')
  const m = refinedMap()
  m.processes.push({ key: 'said:접수', said: true, band: 'said', status: 'suggested', cases: 0, kind: 'flow', tasks: ['접수'] })
  m.tasks.push({ key: '접수', procs: ['said:접수'], proc: 'said:접수', kind: 'said', n: 0, n_cases: 0 }, { key: '확인', procs: ['said:접수'], proc: 'said:접수', kind: 'said', n: 0, n_cases: 0 })
  m.refined['said:접수'] = {
    said: true, corrections: 1, removed: { tasks: [], edges: [] },
    tasks: [{ key: '접수', role: '영업', n: 0, origin: '접수', said: true, decided: true, unseen: true }, { key: '확인', role: '', n: 0, origin: '확인', said: true },
      { key: '견적', role: '', n: 6, origin: '견적' }],
    edges: [{ from: '접수', to: '확인', n: 0, p: 0, decided: true }, { from: '확인', to: '견적', n: 0, p: 0 }],
    entries: ['접수'],
  }
  const w = visibleGraph(m, { mode: 'auto' })
  assert.ok(w.decided)
  assert.equal(w.refined, false)
  assert.equal(w.tasks.filter((t) => t.key === '견적').length, 1, '회사에 이미 있는 일은 한 번만')
  assert.ok(w.tasks.some((t) => t.key === '접수' && t.unseen && t.said))
  assert.ok(w.tasks.some((t) => t.key === '확인' && t.decided && t.unseen))
  assert.ok(ids(w).includes('접수>확인') && ids(w).includes('확인>견적'))
  assert.ok(w.edges.find((e) => e.from === '확인').decided, '말로 정한 관계는 모두 정한 것')
  assert.ok(w.entries.includes('접수'))
  assert.ok(w.tasks.some((t) => t.key === '평면도') && !w.tasks.some((t) => t.key === '도면 작성'), '다른 다듬은 프로세스는 찾은 대로')
  assert.ok(!visibleGraph(m, { mode: 'auto', flow: 'found' }).tasks.some((t) => t.key === '접수'))
  const s = visibleGraph(m, { proc: 'said:접수', mode: 'auto' })
  assert.deepEqual(s.tasks.map((t) => t.key).sort(), ['견적', '접수', '확인'])
  assert.equal(s.entries[0], '접수')
  assert.equal(isSimple(m.processes[1]), false)
})

test('flowView: 미리 보기 뒤(after)의 diff · change 를 그대로 넘기고, 뺀 것도 남긴다', async () => {
  const { flowView } = await import('../../src/components/ontology/mapView.js')
  const after = {
    tasks: [{ key: '요청', role: '영업', n: 9, origin: '요청' }, { key: '평면도', role: '', n: 7, origin: '평면도', diff: 'remove' },
      { key: '검토', role: '팀장', n: 0, origin: null, added: true, decided: true, unseen: true, diff: 'add' },
      { key: '견적서 작성', role: '', n: 6, origin: '견적', decided: true, diff: 'change', change: '이름을 「견적」에서 바꿔요', was: '견적' }],
    edges: [{ from: '요청', to: '평면도', n: 8, p: 0.9, diff: 'remove' }, { from: '요청', to: '검토', n: 0, p: 0, decided: true, diff: 'add' },
      { from: '검토', to: '견적서 작성', n: 0, p: 0, decided: true, diff: 'add' }, { from: '견적서 작성', to: '__end__', n: 5, p: 1 }, { from: '없는 일', to: '요청', n: 1, p: 1 }],
    entries: ['요청'],
  }
  const v = flowView(after, refinedMap(), { proc: 'b' })
  assert.deepEqual(v.tasks.map((t) => [t.key, t.diff || '']), [['요청', ''], ['평면도', 'remove'], ['검토', 'add'], ['견적서 작성', 'change']])
  const ch = v.tasks.find((t) => t.key === '견적서 작성')
  assert.deepEqual([ch.change, ch.was, ch.n_cases, ch.name, ch.origin], ['이름을 「견적」에서 바꿔요', '견적', 6, '견적서 작성', '견적'])
  assert.ok(v.tasks.find((t) => t.key === '검토').unseen)
  assert.deepEqual(v.edges.map((e) => `${e.from}>${e.to}:${e.diff || ''}`), ['요청>평면도:remove', '요청>검토:add', '검토>견적서 작성:add', '견적서 작성>__end__:'])
  assert.ok(v.edges[1].decided && v.edges[1].unseen)
  assert.deepEqual(v.entries, ['요청'])
  assert.equal(v.tasks[0].entry_share, 1)
  // no map: names are keys, counts are the Flow's
  const bare = flowView(after, null)
  assert.equal(bare.tasks.find((t) => t.key === '견적서 작성').n_cases, 6)
  assert.equal(bare.tasks[0].entry_share, 0)
  assert.deepEqual(flowView({ tasks: [{ key: 'a', n: 0 }, { key: 'b', n: 0 }], edges: [{ from: 'a', to: 'b', n: 0, p: 0 }] }).entries, ['a'])
  assert.deepEqual(flowView(null), { tasks: [], edges: [], entries: [] })
})

test('사건 보기: 다듬은 흐름에서 이름을 바꾼 일에도 사건이 이어진다', () => {
  const m = refinedMap()
  m.events = [{ key: 'artifact:평면도:drawing', kind: 'artifact', name: '평면도 결과물(도면)', n: 3 }]
  m.raises = [{ from: '평면도', to: 'artifact:평면도:drawing', p: 1 }]
  m.triggers = [{ from: 'artifact:평면도:drawing', to: '견적', p: 1 }]
  const f = eventGraph(m, { proc: 'b', mode: 'auto' })
  const got = f.edges.filter((e) => e.kind !== 'next').map((e) => `${e.kind}:${e.from.replace(EV, '@')}>${e.to.replace(EV, '@')}`).sort()
  assert.deepEqual(got, ['raise:견적>@done:견적', 'raise:도면 작성>@artifact:평면도:drawing', 'raise:요청>@done:요청', 'trigger:@artifact:평면도:drawing>견적', 'trigger:@done:견적>검토', 'trigger:@done:요청>도면 작성'])
})
