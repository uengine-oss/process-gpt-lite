// 지도에서 바로 실행(lib/ontology/mapengine.js): 단계가 끝날 때 지도에서 다음 단계를 정하는 규칙 — 한 갈래 · 갈림길(금액 조건 · 글 조건 ·
// 가장 흔한 길) · 나란히 하는 두 일과 합류 · 꼭 하는 단계 · 은퇴한 길 · 끝 · 지도가 바뀐 뒤(따라감 · 고정) · 중간에서 시작. 모델 · DB 없이.
import test from 'node:test'
import assert from 'node:assert/strict'
import { waysOut, pickWay, nextOf, joinNext, likelyNext, pinOnStart, flowGraph, mapTimeOf, isMapInst } from '../lib/ontology/mapengine.js'
import { unfold, skippedBefore, parallelPair, contractOf } from '../lib/ontology/run.js'
import { requiredView } from '../lib/ontology/steprule.js'
import { END } from '../lib/ontology/stats.js'

const task = (key, x = {}) => [key, { key, role: '담당', status: 'active', ...x }]
const view = (tasks, edges, proc = {}) => ({ proc: { key: 'p', name: '시험', theta: 0.05, entries: [tasks[0]], ...proc }, tasks: new Map(tasks.map((t) => (Array.isArray(t) ? t : task(t)))), edges })
const e = (from, to, p, x = {}) => ({ from, to, p, n: Math.round(p * 10), status: 'active', ...x })
// a case's step row as nextOf reads it
const row = (task, state = 'done', x = {}) => ({ todoId: `${task}#${x.n || 1}`, task, state, ...x })

test('한 갈래: 다음 일이 하나면 그 일 — 정한 까닭은 「이 흐름의 다음 단계」', async () => {
  const v = view(['접수', '검토', '회신'], [e('접수', '검토', 1), e('검토', '회신', 1), e('회신', END, 1)])
  const d = await nextOf(v, row('접수'), { rows: [row('접수')] })
  assert.deepEqual(d.creates.map((c) => c.task), ['검토'])
  assert.equal(d.creates[0].via.how, 'single')
  assert.equal(d.creates[0].via.from, '접수')
})

test('끝: 다음이 끝(END)이거나 나갈 길이 없으면 건이 끝난다', async () => {
  const v = view(['접수', '회신'], [e('접수', '회신', 1), e('회신', END, 1)])
  assert.deepEqual(await nextOf(v, row('회신'), { rows: [row('접수'), row('회신')] }), { end: true, how: 'single' })
  // a task with no way out in the map: unfold gives it a way to the end
  const w = view(['접수', '외딴 일'], [e('접수', '외딴 일', 1)])
  assert.equal((await nextOf(w, row('외딴 일'), {})).end, true)
})

test('갈림길 · 금액 조건: 배운 기준(금액 이상 · 미만)과 이 건의 금액으로 모델 없이 고른다', async () => {
  const info = { attr: 'amount', threshold: 10_000_000 }
  const v = view(['견적', '재무 검토', '발송'], [
    e('견적', '재무 검토', 0.3, { cond: '금액(amount)이 10,000,000원 이상', cond_cases: info }),
    e('견적', '발송', 0.7, { cond: '금액(amount)이 10,000,000원 미만', cond_cases: info }),
    e('재무 검토', '발송', 1), e('발송', END, 1),
  ])
  const judge = async () => { throw new Error('금액 조건에는 모델을 부르지 않아요') }
  const big = await nextOf(v, row('견적'), { amount: 12_400_000, judge })
  assert.equal(big.creates[0].task, '재무 검토')
  assert.equal(big.creates[0].via.how, 'amount')
  assert.match(big.creates[0].via.why, /이상이라 이쪽으로/)
  const small = await nextOf(v, row('견적'), { amount: 3_000_000, judge })
  assert.equal(small.creates[0].task, '발송')
  // no amount on the case: the most common way
  const none = await nextOf(v, row('견적'), { amount: null, judge })
  assert.equal(none.creates[0].task, '발송')
  assert.equal(none.creates[0].via.how, 'common')
  assert.equal(none.creates[0].via.unsure, true)
})

test('갈림길 · 글 조건: 갈래마다 따로 읽어(심판 대역) 문턱 넘는 가장 높은 쪽 — 모두 낮으면 가장 흔한 길', async () => {
  const v = view(['문의', '견적', '안내', '끝맺음'], [e('문의', '견적', 0.6), e('문의', '안내', 0.4), e('견적', END, 1), e('안내', END, 1)])
  const texts = new Map([['견적', '고객이 가격을 물었다'], ['안내', '고객이 사용법을 물었다']])
  const asked = []
  const judge = async (cond) => { asked.push(cond); return { p: cond.includes('사용법') ? 0.82 : 0.2, measured: true } }
  const d = await nextOf(v, row('문의'), { texts, judge })
  assert.equal(d.creates[0].task, '안내')
  assert.equal(d.creates[0].via.how, 'text')
  assert.match(d.creates[0].via.why, /사용법을 물었다.*82%/)
  assert.deepEqual(asked.sort(), ['고객이 가격을 물었다', '고객이 사용법을 물었다'])
  // unsure (no way over textMatch) → the most common way
  const low = await nextOf(v, row('문의'), { texts, judge: async () => ({ p: 0.3, measured: true }) })
  assert.equal(low.creates[0].task, '견적')
  assert.equal(low.creates[0].via.how, 'common')
  // the reading fails → the most common way
  const fail = await nextOf(v, row('문의'), { texts, judge: async () => ({ p: null, measured: false }) })
  assert.equal(fail.creates[0].task, '견적')
})

test('갈림길 · 조건 없음: 가장 흔한 길, 고르지 않은 갈래는 근거(outs)로 남는다', async () => {
  const v = view(['A', 'B', 'C'], [e('A', 'B', 0.35), e('A', 'C', 0.65), e('B', END, 1), e('C', END, 1)])
  const d = await nextOf(v, row('A'))
  assert.equal(d.creates[0].task, 'C')
  assert.match(d.creates[0].via.why, /65%/)
  assert.deepEqual(d.creates[0].via.outs.map((o) => o.to).sort(), ['B', 'C'])
  // pickWay on its own: ending is a way too
  assert.equal(pickWay([{ to: END, p: 0.7 }, { to: 'B', p: 0.3 }]).to, END)
})

test('은퇴한 길 · θ 아래의 길은 지도에서 빠진다(unfold 와 같은 거름) — 은퇴한 일로도 가지 않는다', async () => {
  const v = view(['A', 'B', 'C', 'D'].map((k) => (k === 'D' ? task(k, { status: 'retired' }) : task(k))), [
    e('A', 'B', 0.5, { status: 'retired' }), e('A', 'C', 0.3), e('A', 'D', 0.6), e('A', END, 0.02), e('C', END, 1),
  ])
  const w = waysOut(v, 'A', 0.05)
  assert.deepEqual(w.outs.map((o) => o.to), ['C'])
  assert.equal((await nextOf(v, row('A'))).creates[0].task, 'C')
})

test('꼭 하는 단계: 그 일로 갈 수 있는 갈림길은 그 일을 지나간다(고정과 같다) — 흔한 길이 다른 쪽이어도', async () => {
  const base = view(['검토', '동료 검토', '발송'], [e('검토', '동료 검토', 0.1), e('검토', '발송', 0.9), e('동료 검토', '발송', 1), e('발송', END, 1)])
  assert.equal((await nextOf(base, row('검토'))).creates[0].task, '발송')
  const req = requiredView(base, [{ task: '동료 검토', requirement: 'required', rules: [] }])
  assert.equal(pinOnStart(base), false)
  assert.equal(pinOnStart(req), true)
  const d = await nextOf(req, row('검토'))
  assert.equal(d.creates[0].task, '동료 검토')
  assert.equal(d.creates[0].via.how, 'single')
})

test('나란히 하는 두 일: 둘 다 넣고, 합류 다음 일은 둘 다 끝나야(어느 쪽이 먼저 끝나든) — 하나를 건너뛰어도 합류한다', async () => {
  const v = view(['준비', '계획서', '보고', '회신'], [
    e('준비', '계획서', 0.5), e('준비', '보고', 0.5), e('계획서', '보고', 0.4, { parallel: true }),
    e('계획서', '회신', 0.6), e('보고', '회신', 0.7), e('회신', END, 1),
  ])
  const split = await nextOf(v, row('준비', 'done', { todoId: 'T-준비' }))
  assert.deepEqual(split.creates.map((c) => c.task).sort(), ['계획서', '보고'])
  assert.ok(split.creates.every((c) => c.par.group === 'T-준비' && c.via.how === 'parallel'))
  const par = split.creates[0].par
  const p = (task, state) => row(task, state, { todoId: `T-${task}`, par })
  // 계획서 first, then 보고
  assert.deepEqual(await nextOf(v, p('계획서', 'done'), { rows: [row('준비'), p('계획서', 'done'), p('보고', 'open')] }), { wait: 'join', pending: ['보고'] })
  const join1 = await nextOf(v, p('보고', 'done'), { rows: [row('준비'), p('계획서', 'done'), p('보고', 'done')] })
  assert.deepEqual(join1.creates.map((c) => c.task), ['회신'])
  assert.equal(join1.creates[0].via.how, 'join')
  // 보고 first, then 계획서: the same join
  assert.equal((await nextOf(v, p('보고', 'done'), { rows: [p('계획서', 'open'), p('보고', 'done')] })).wait, 'join')
  assert.deepEqual((await nextOf(v, p('계획서', 'done'), { rows: [p('계획서', 'done'), p('보고', 'done')] })).creates.map((c) => c.task), ['회신'])
  // one skipped (an optional step): the join goes on when the other ends
  assert.deepEqual((await nextOf(v, p('계획서', 'done'), { rows: [p('계획서', 'done'), p('보고', 'skipped')] })).creates.map((c) => c.task), ['회신'])
  // joined once only (a second hand-in of the last sibling makes nothing)
  const joined = [p('계획서', 'done'), p('보고', 'done'), row('회신', 'open', { via: { how: 'join', group: par.group } })]
  assert.deepEqual((await nextOf(v, p('보고', 'done'), { rows: joined })).creates, [])
  // a move closed a sibling: the group is given up
  assert.deepEqual((await nextOf(v, p('계획서', 'done'), { rows: [p('계획서', 'done'), p('보고', 'closed')] })).creates, [])
  // the same pair and next as the snapshot's AND gateway (run.js contractOf's rule)
  assert.equal(joinNext(v, ['계획서', '보고'], 0.05), '회신')
  assert.deepEqual(parallelPair(v.edges, unfold(v, '준비', 0.05).flows, '준비'), { targets: ['계획서', '보고'], next: '회신' })
})

test('지도가 두 단계 사이에 바뀌면: 따라가는 건은 새 지도로, 시작한 날의 지도에 고정한 건은 그대로 정한다', async () => {
  const old = view(['검토', '동료 검토', '발송'], [e('검토', '동료 검토', 0.1), e('검토', '발송', 0.9), e('동료 검토', '발송', 1), e('발송', END, 1)])
  // after the case started, a person retired 검토 → 발송 (or set 동료 검토 to 꼭): the map now goes through 동료 검토
  const now = view(['검토', '동료 검토', '발송'], [e('검토', '동료 검토', 0.1), e('검토', '발송', 0.9, { status: 'retired' }), e('동료 검토', '발송', 1), e('발송', END, 1)])
  const follow = await nextOf(now, row('검토'))   // map_pin off: procGraph(proc) — the map as it is now
  const pinned = await nextOf(old, row('검토'))   // map_pin on: procGraph(proc, {validAt: map_pin})
  assert.equal(follow.creates[0].task, '동료 검토')
  assert.equal(pinned.creates[0].task, '발송')
  // which map a case reads: its pin (validAt) when pinned, else the map as it is (undefined); a snapshot case never reads a pin
  const start = '2026-11-16T01:00:00.000Z'
  assert.equal(mapTimeOf({ engine: 'map', map_pin: null }), undefined)
  assert.equal(mapTimeOf({ engine: 'map', map_pin: new Date(start) }), start)
  assert.equal(mapTimeOf({ engine: 'bpm', map_pin: new Date(start) }), undefined)
  assert.equal(isMapInst('onto-map.1f2e'), true)
  assert.equal(isMapInst('onto_61cb7a27c39a.1f2e'), false)
})

test('중간에서 시작: 그 일의 행을 넣는 것뿐 — 건너뛴 앞 단계는 기록으로, 펼친 흐름은 그 일부터', () => {
  const v = view(['요청 접수', '계획서', '자료 준비', '회신'], [e('요청 접수', '계획서', 1), e('계획서', '자료 준비', 0.9), e('자료 준비', '회신', 1), e('회신', END, 1)], { entries: ['요청 접수'] })
  assert.deepEqual(skippedBefore(v.proc, v.edges, '자료 준비'), ['요청 접수', '계획서'])
  assert.deepEqual(unfold(v, '자료 준비', 0.05).nodes, ['자료 준비', '회신'])
  assert.deepEqual(likelyNext(v, ['자료 준비'], 0.05), ['회신'])
})

test('되풀이: 이미 여러 번 한 일로는 다시 가지 않는다(다른 길이 있으면 그쪽, 없으면 끝)', async () => {
  const v = view(['작성', '검토'], [e('작성', '검토', 1), e('검토', '작성', 0.6), e('검토', END, 0.4)])
  const rows = [row('작성', 'done', { n: 1 }), row('검토', 'done', { n: 1 }), row('작성', 'done', { n: 2 }), row('검토', 'done', { n: 2 }), row('작성', 'done', { n: 3 })]
  const d = await nextOf(v, row('검토', 'done', { n: 3 }), { rows: [...rows, row('검토', 'done', { n: 3 })], R: { maxRepeat: 3 } })
  assert.equal(d.end, true)
  const once = await nextOf(v, row('검토'), { rows: [row('작성'), row('검토')] })
  assert.equal(once.creates[0].task, '작성')
})

test('흐름도: 지도에서 펼친 일 · 건이 닿은 상태(끝남 · 하는 중 · 다음) · 건이 실제로 간 길 · 나란히', () => {
  const v = view(['준비', '계획서', '보고', '회신'], [
    e('준비', '계획서', 0.5), e('준비', '보고', 0.5), e('계획서', '보고', 0.4, { parallel: true }), e('계획서', '회신', 0.6), e('보고', '회신', 0.7), e('회신', END, 1),
  ])
  const g = flowGraph(v, { entry: '준비', rows: [{ task: '준비', show: 'done', via: { how: 'entry' } }, { task: '계획서', show: 'running', via: { from: '준비' } }, { task: '보고', show: 'done', via: { from: '준비' } }] })
  const by = Object.fromEntries(g.nodes.map((n) => [n.key, n]))
  assert.equal(by['준비'].state, 'done')
  assert.equal(by['계획서'].state, 'running')
  assert.equal(by['회신'].state, 'next')
  assert.ok(g.nodes.some((n) => n.key === END))
  assert.ok(g.flows.find((f) => f.from === '준비' && f.to === '계획서').taken)
  assert.ok(g.flows.filter((f) => f.from === '준비').every((f) => f.and))
  // a case started in the middle: the steps it passed over are drawn before its start, as skipped
  const mid = flowGraph(v, { entry: '계획서', before: ['준비'], rows: [{ task: '계획서', show: 'running', via: { how: 'entry' } }] })
  assert.equal(mid.nodes[0].key, '준비')
  assert.equal(mid.nodes[0].state, 'skipped')
  assert.ok(mid.flows.some((f) => f.from === '준비' && f.to === '계획서' && f.skipped))
})

test('스냅샷의 AND 갈림은 같은 규칙(parallelPair)으로 그대로다', async () => {
  const v = view(['준비', '계획서', '보고', '회신'].map((k) => task(k, { definition_md: '' })), [
    e('준비', '계획서', 0.5), e('준비', '보고', 0.5), e('계획서', '보고', 0.4, { parallel: true }), e('계획서', '회신', 0.6), e('보고', '회신', 0.7), e('회신', END, 1),
  ])
  const { flows } = unfold(v, '준비', 0.05)
  assert.deepEqual(parallelPair(v.edges, flows, '준비'), { targets: ['계획서', '보고'], next: '회신' })
  assert.equal(typeof contractOf, 'function')
})
