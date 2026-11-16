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

// ---------- 건마다 bpm_proc_inst 한 행 · 시각 · 되감은 단계의 문구 · 여러 업무 카드 · 역할마다 맡는 사람 ----------
import { NOW_KST, instNameOf } from '../lib/ontology/mapengine.js'
import { mapStartProposal } from '../lib/ontology/runmode.js'
import { bindingFor, rolesOfFlow, roleBindingsOf, bindingsView, unbound, AGENT_ROLE } from '../lib/ontology/bindings.js'
import { entryManyText } from '../../src/components/ontology/ontoText.js'

test('시각: 할 일 · 인스턴스의 날짜 열은 엔진처럼 한국 시각으로 쓴다(DB 시계는 UTC — now() 는 9시간 이르게 읽혔다)', () => {
  assert.match(NOW_KST, /now\(\) at time zone 'Asia\/Seoul'/)
  // the instance's name, as the engine names one
  assert.equal(instNameOf('강의계획서 작성 · 보고', '[특강] 강의자료 준비 부탁드립니다'), '강의계획서 작성 · 보고 · [특강] 강의자료 준비 부탁드립니다')
  assert.equal(instNameOf('강의계획서 작성 · 보고', ''), '강의계획서 작성 · 보고')
})

test('되감은 · 옮긴 · 처음 단계의 근거: 지도 건에는 요청 접수가 없고, 시작 확률을 되감기에 붙이지 않는다', () => {
  const r = mapStartProposal('강의자료 준비', { how: 'rewound', from: '고객 회신', why: '이 단계로 되감기' })
  assert.equal(r.from, '')
  assert.equal(r.p, null)
  assert.equal(r.split, false)
  assert.deepEqual(r.others, [])
  assert.equal(r.why, '사람이 「강의자료 준비」로 되감았어요 — 이 단계부터 다시 해요')
  assert.doesNotMatch(r.why, /요청 접수|%/)
  assert.equal(mapStartProposal('교육 진행', { how: 'moved', why: '사람이 이 단계로 옮겼어요' }).why, '사람이 「교육 진행」으로 옮겼어요 — 이 단계부터 해요')
  assert.equal(mapStartProposal('교육 진행', { how: 'moved', why: '사람이 다른 갈래(「교육 진행」)를 골랐어요' }).why, '사람이 다른 갈래(「교육 진행」)를 골랐어요')
  // the first step: the request chose it — its odds stay in the reason, not as a branch share
  const s = mapStartProposal('강의자료 준비', { how: 'entry', why: '이 요청은 「강의자료 준비」부터 하면 돼요(83%)' })
  assert.equal(s.why, '이 요청은 「강의자료 준비」부터 하면 돼요(83%)')
  assert.equal(s.from, '')
  assert.equal(s.p, null)
})

test('여러 업무 카드: 같은 사건으로 이미 시작한 자동 프로세스도 세고, 시작한 것과 묻는 것을 나눠 말한다', () => {
  assert.equal(entryManyText('이 메일은', 3, 0), '이 메일은 회사의 업무 3가지에 해당해요. 진행할 업무를 골라 주세요.')
  assert.equal(entryManyText('이 메일은', 3, 1), '이 메일은 회사의 업무 4가지에 해당해요. 자동인 1가지는 이미 시작했고, 나머지 3가지는 진행할지 골라 주세요.')
})

test('맡는 사람 풀이: 설정의 담당자 하나 → 그 사람, 프로세스마다 정한 사람이 여럿 → 정해야 함, 아무도 없음 → 시작한 사람, 시작한 사람도 없음 → 없음', () => {
  const names = new Map([['u1', '김강사'], ['u2', '이강사'], ['s', '장진영']])
  assert.deepEqual(bindingFor('강사', { star: 'u1', names, starter: 's' }), { role: '강사', userId: 'u1', name: '김강사', from: 'settings' })
  assert.deepEqual(bindingFor('강사', { others: ['u2', 'u2'], names, starter: 's' }), { role: '강사', userId: 'u2', name: '이강사', from: 'process' })
  const many = bindingFor('강사', { others: ['u1', 'u2'], names, starter: 's' })
  assert.equal(many.from, 'several')
  assert.equal(many.userId, null)
  assert.deepEqual(many.candidates.map((c) => c.name), ['김강사', '이강사'])
  assert.equal(unbound(many), true)
  assert.deepEqual(bindingFor('전무', { names, starter: 's' }), { role: '전무', userId: 's', name: '장진영', from: 'starter' })
  const none = bindingFor('전무', { names })
  assert.equal(none.from, 'none')
  assert.equal(unbound(none), true)
  assert.equal(unbound({ from: 'agent', userId: null }), false)
})

test('맡는 사람의 역할: 시작 일부터 펼친 흐름의 사람 단계만 역할마다 한 번, 에이전트 단계는 「업무 에이전트」 — bpm_proc_inst.role_bindings 는 엔진의 모양', async () => {
  const agentDef = '---\nkind: task\nrunner: agent\n---\n자료를 만든다'
  const v = view([task('계획서', { role: '강사' }), task('자료 준비', { role: '강사', definition_md: agentDef }), task('회신', { role: '전무' }), task('교육', { role: '강사' }), task('홍보', { role: '마케팅' })],
    [e('계획서', '자료 준비', 1), e('자료 준비', '회신', 1), e('회신', '교육', 1), e('교육', END, 1), e('홍보', '계획서', 1)])
  const roles = await rolesOfFlow(v, '계획서', 0.05)
  assert.deepEqual(roles.map((r) => [r.role, r.tasks, r.agent]), [['강사', ['계획서', '교육'], false], [AGENT_ROLE, ['자료 준비'], true], ['전무', ['회신'], false]])
  // (홍보 is before the start: its role is not asked)
  const bs = [{ role: '강사', userId: 'u1', name: '김강사', from: 'settings' }, { role: AGENT_ROLE, userId: null, name: '', from: 'agent' }, { role: '전무', userId: null, name: '', from: 'several', candidates: [] }]
  assert.deepEqual(roleBindingsOf(bs, 'a1'), [
    { name: '강사', origin: 'created', default: ['u1'], endpoint: ['u1'], resolutionRule: '프로세스 지도: 설정의 팀 · 역할 담당자' },
    { name: AGENT_ROLE, origin: 'used', default: 'a1', endpoint: 'a1', resolutionRule: '' },
    { name: '전무', origin: 'created', default: [], endpoint: [], resolutionRule: '프로세스 지도: 여러 명 · 정해야 해요' },
  ])
  const shown = bindingsView(bs)
  assert.equal(shown[0].fromKo, '설정의 팀 · 역할 담당자')
  assert.equal(shown[2].unbound, true)
  assert.equal(shown[1].unbound, false)
})
