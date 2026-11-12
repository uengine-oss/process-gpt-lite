// 지도에 그릴 관계(spec pgpt-pro_process-ontology, 「쓰이지 않게 된 우회 경로의 은퇴」): 은퇴 후보 · 은퇴한 관계는 θ 보다 드물어도
// 그린다 — 검토할 대상이 기본 지도에서 안 보였다(2026-11-13 녹화). 하지만 그 관계로만 닿는 일을 끌어오지는 않는다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { visibleGraph } from '../../src/components/ontology/mapView.js'

const T = (key, x = {}) => ({ key, bundle: 'b', ...x })
const E = (from, to, p, x = {}) => ({ from, to, p, ...x })
const map = {
  bundles: [{ key: 'b', theta: 0.2, summary_theta: 0.1 }],
  tasks: [T('요청', { entry_share: 1 }), T('평면도'), T('견적'), T('법무')],
  edges: [E('요청', '평면도', 0.9), E('평면도', '견적', 1), E('요청', '견적', 0.09, { stale: true }),
    E('견적', '평면도', 0.05, { status: 'retired' }), E('견적', '법무', 0.03, { stale: true })],
}

test('은퇴 후보 · 은퇴한 관계는 θ 보다 드물어도 보이는 일 사이에서는 그린다', () => {
  const v = visibleGraph(map, { bundle: 'b', mode: 'auto' })
  const ids = v.edges.map((e) => `${e.from}>${e.to}`)
  assert.ok(ids.includes('요청>견적'), '은퇴 후보')
  assert.ok(ids.includes('견적>평면도'), '은퇴함')
  assert.ok(!v.tasks.some((t) => t.key === '법무'), '은퇴 후보로만 닿는 일은 끌어오지 않는다')
  assert.ok(!ids.includes('견적>법무'))
})

test('θ 보다 드문 보통 관계는 빠진다', () => {
  const m = { ...map, edges: [...map.edges, E('평면도', '요청', 0.04)] }
  const ids = visibleGraph(m, { bundle: 'b', mode: 'auto' }).edges.map((e) => `${e.from}>${e.to}`)
  assert.ok(!ids.includes('평면도>요청'))
  assert.ok(visibleGraph(m, { bundle: 'b', mode: 'all' }).edges.some((e) => e.from === '평면도' && e.to === '요청'))
})
