// 공개 계층 판정 사례(context-visibility-cases.json)를 순수 함수로 확인한다 — DB 없이.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { depthOf, ruleFor, widerThan } from '../lib/context/visibility.js'
import { parseChart, relation } from '../lib/context/org.js'

const C = JSON.parse(fs.readFileSync(new URL('./context-visibility-cases.json', import.meta.url)))
const P = (id, name) => ({ id, data: { id, name } })
const chart = { id: 'root', data: { name: '회사' }, children: [
  P('윤서진', '윤서진'),
  { id: 'hq', data: { id: 'hq', name: '컨설팅본부', isTeam: true }, children: [
    P('강민호', '강민호'),
    { id: 'strategy', data: { id: 'strategy', name: '전략팀', isTeam: true }, children: [P('박하늘', '박하늘'), P('이도윤', '이도윤'), P('한지우', '한지우'), { id: 'ai-1', data: { id: 'ai-1', name: '리서치 직원', isAgent: true } }] },
    { id: 'proposal', data: { id: 'proposal', name: '제안팀', isTeam: true }, children: [P('최유나', '최유나'), P('정하은', '정하은'), P('한지우', '한지우')] },
  ] },
] }
const { nodes, people } = parseChart(chart)
const org = { nodes, people, leads: new Map([['strategy', '박하늘'], ['proposal', '최유나'], ['hq', '강민호']]), admins: new Set(['윤서진']), users: [] }
const now = new Date('2026-11-01T12:00:00Z')
const when = (s) => { if (!s) return null; const m = /^([+-])(\d+)([sd])$/.exec(s); const ms = Number(m[2]) * (m[3] === 'd' ? 86400000 : 1000); return new Date(now.getTime() + (m[1] === '+' ? ms : -ms)).toISOString() }

test('사례 수 = 카탈로그 길이', () => { assert.ok(C.cases.length >= 25); assert.equal(new Set(C.cases.map((c) => c.id)).size, C.cases.length) })
for (const c of C.cases) {
  test(`${c.id} ${c.viewer} → ${c.owner} ${c.item.visibility}/${c.item.reach}${c.item.sensitive ? '/민감' : ''}${c.grants ? ' +허락' : ''}: ${c.expect}`, () => {
    const rel = relation(org, c.viewer, c.owner, { via: c.via || 'jwt' })
    const grants = (c.grants || []).map((g) => ({ ...g, until: when(g.until), revoked_at: g.revoked ? now.toISOString() : null }))
    const r = depthOf({ owner: c.owner, ...c.item }, rel, { grants, now, room: c.room || null })
    assert.equal(r.depth, c.expect, `${c.note || ''} — 근거 ${r.why.join(', ')}`)
  })
}
for (const c of C.rules) {
  test(`${c.id} 규칙 ${c.requester} → ${c.owner}: ${c.expect.decision}`, () => {
    const rel = relation(org, c.requester, c.owner)
    const r = ruleFor(c.rules || null, rel, { sensitive: !!c.sensitive, requester: c.requester, depth: c.depth })
    for (const [k, v] of Object.entries(c.expect)) assert.equal(r[k], v, `${k} — ${c.note}`)
  })
}
for (const c of C.inherit) test(`${c.id} 상속: ${c.expect ?? '허용'}`, () => assert.equal(widerThan(c.child, c.parent), c.expect))
test('AI 직원 노드는 사람 범위에 들지 않는다', () => assert.equal(people.has('ai-1'), false))
