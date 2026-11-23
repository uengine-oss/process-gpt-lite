// 말로 프로세스 지도 고치기 · 더하기(lib/ontology/editmap.js) · 의견과 상충(opinions.js): 말을 옮긴 동작이 흐름에 어떻게 얹히는지, 범위,
// 이름 맞추기, 말로 만든 프로세스, 지도 그림의 표시, 채팅 초안 → 동작, 의견의 맞춰 적기 · 같은 의견 · 상충 · 묶음. 모델 · DB 없이.
import test from 'node:test'
import assert from 'node:assert/strict'
import { applyCorrections, refinedView, normFix, labelOf, baseOf, saidWays, condOfWhen, normWhen } from '../lib/ontology/refine.js'
import { inRange, checkOps, sameName, sameWork, touchOf, flowOf, diffFlows, opsFromContract, whenOfText, masker, previewOf, pickProcess, OUT_OF_RANGE } from '../lib/ontology/editmap.js'
import { normOps, opsKey, conflictsBetween, groupsOf, marksOf, textPairs } from '../lib/ontology/opinions.js'
import { keptAfterBuild } from '../lib/ontology/build.js'
import { unfold, parallelPair, contractOf } from '../lib/ontology/run.js'
import { pickWay, waysOut, nextOf } from '../lib/ontology/mapengine.js'
import { taskDefinition } from '../lib/ontology/taskdef.js'
import { END } from '../lib/ontology/stats.js'

// the lecture process as found (refine.test.js)
const found = () => ({
  tasks: [{ key: '강의계획서 작성', role: '전무', n: 9 }, { key: '강의자료 준비', role: '전무', n: 3 }, { key: '고객 회신', role: '전무', n: 10 }, { key: '교육 진행', role: '강사', n: 2 }],
  edges: [
    { from: '강의계획서 작성', to: '강의자료 준비', n: 3, p: 0.6 }, { from: '강의계획서 작성', to: END, n: 2, p: 0.4 },
    { from: '강의자료 준비', to: '고객 회신', n: 3, p: 1 }, { from: '고객 회신', to: '교육 진행', n: 2, p: 0.8 }, { from: '고객 회신', to: END, n: 1, p: 0.2 }, { from: '교육 진행', to: END, n: 2, p: 1 },
  ],
})
const c = (id, op, args) => ({ id, op, args })
const edge = (r, from, to) => r.edges.find((e) => e.from === from && e.to === to)
const graph = () => {
  const f = found()
  const tasks = f.tasks.map((t) => ({ ...t, status: 'active', kind: 'flow' }))
  return { tasks: [...tasks, { key: '견적서 작성', role: '영업', n: 40, status: 'active', kind: 'flow' }, { key: '대표 승인', role: '대표', n: 6, status: 'active', kind: 'flow' }],
    edges: [...f.edges.map((e) => ({ ...e, status: 'active' })), { from: '견적서 작성', to: '대표 승인', n: 5, p: 0.12, status: 'active' }, { from: '견적서 작성', to: '고객 회신', n: 30, p: 0.7, status: 'active' }],
    processes: [{ key: 'process:lec', name: '강의', kind: 'flow', status: 'suggested', theta: 0.05, entries: ['강의계획서 작성'], tasks: f.tasks.map((t) => t.key) }] }
}
const lectureBase = (cs = []) => { const g = graph(); return baseOf(g, g.processes[0], cs) }

test('새 동작 읽기: move_task · set_cond(금액 · 글 · 지우기) · set_parallel · set_runner · set_requirement · set_timer · new_process', () => {
  assert.deepEqual(normFix({ op: 'move_task', args: { task: '교육 진행', after: '강의계획서 작성' } }), { op: 'move_task', args: { task: '교육 진행', after: '강의계획서 작성' } })
  assert.equal(normFix({ op: 'move_task', args: { task: '교육 진행' } }), null)
  assert.deepEqual(normFix({ op: 'set_cond', args: { from: 'a', to: 'b', when: { amount: { op: '<', value: '3,000,000' } } } }).args.when, { amount: { op: '<', value: 3000000 } })
  assert.deepEqual(normFix({ op: 'set_cond', args: { from: 'a', to: '끝', when: null } }).args, { from: 'a', to: END, when: null })
  assert.equal(normFix({ op: 'set_cond', args: { from: 'a', to: 'b', when: { amount: { op: '=', value: 1 } } } }), null)
  assert.equal(normFix({ op: 'set_runner', args: { task: 'a', runner: 'robot' } }), null)
  assert.deepEqual(normFix({ op: 'set_requirement', args: { task: 'a', requirement: 'map' } }).args, { task: 'a', requirement: null })
  assert.equal(normFix({ op: 'set_timer', args: { cron: 'every day', entry: 'a' } }), null)
  const np = normFix({ op: 'new_process', args: { name: '견적', steps: [{ name: '견적서 작성', role: '영업' }, '대표 승인', { name: '견적서 작성' }], ways: [{ from: '견적서 작성', to: '대표 승인' }, { from: '없는 일', to: '끝' }] } })
  assert.deepEqual(np.args.steps.map((s) => s.name), ['견적서 작성', '대표 승인'])
  assert.deepEqual(np.args.ways, [{ from: '견적서 작성', to: '대표 승인' }])
  assert.equal(np.args.start, '견적서 작성')
  assert.match(labelOf({ op: 'set_cond', args: { from: '견적서 작성', to: '대표 승인', when: { amount: { op: '>=', value: 5000000 } } } }), /금액 5,000,000원 이상/)
  assert.equal(labelOf({ op: 'set_runner', args: { task: '강의자료 준비', runner: 'agent' } }), '「강의자료 준비」는 에이전트가 하게 함')
  assert.deepEqual(condOfWhen(normWhen({ amount: { op: '>=', value: 5000000 } })), { cond: '금액(amount)이 5,000,000원 이상', condInfo: { attr: 'amount', threshold: 5000000, op: '>=', said: true } })
})

test('옮기기: 빠진 자리는 이어지고, 새 자리에 들어가며 사람이 정한 길이 된다', () => {
  const r = applyCorrections(found(), [c('m', 'move_task', { task: '교육 진행', after: '강의계획서 작성', before: '강의자료 준비' })])
  assert.equal(r.skipped.length, 0)
  assert.ok(edge(r, '고객 회신', END), '교육 진행이 빠진 뒤 고객 회신은 끝으로')
  assert.ok(!edge(r, '고객 회신', '교육 진행'))
  assert.equal(edge(r, '강의계획서 작성', '교육 진행').decided, true)
  assert.equal(edge(r, '교육 진행', '강의자료 준비').decided, true)
  assert.equal(r.tasks.find((t) => t.key === '교육 진행').decided, true)
  assert.equal(applyCorrections(found(), [c('m', 'move_task', { task: '없음', after: '고객 회신' })]).skipped[0].why, '그 일이 없어요.')
})

test('갈림길 조건 · 나란히 · 하는 이: 흐름에 얹히고 엔진이 읽는 꼴로', async () => {
  const cs = [
    c('1', 'set_cond', { from: '고객 회신', to: '교육 진행', when: { amount: { op: '>=', value: 3000000 } } }),
    c('2', 'set_cond', { from: '고객 회신', to: END, when: { amount: { op: '<', value: 3000000 } } }),
    c('3', 'set_runner', { task: '강의자료 준비', runner: 'agent' }),
  ]
  const v = refinedView(lectureBase(cs), cs)
  const big = v.edges.find((e) => e.from === '고객 회신' && e.to === '교육 진행')
  assert.equal(big.cond, '금액(amount)이 3,000,000원 이상')
  assert.equal(big.decided, true)
  assert.equal(big.cond_cases.op, '>=')
  assert.equal(v.tasks.get('강의자료 준비').runner, 'agent')
  assert.equal(v.tasks.get('강의자료 준비').decided, true)
  assert.equal((await taskDefinition('강의자료 준비', v.tasks.get('강의자료 준비'))).runner, 'agent')
  // the map engine picks the way by the said threshold (no model), on both sides
  const outs = waysOut(v, '고객 회신', 0.05).outs
  assert.equal(pickWay(outs, { amount: 1_200_000 }).to, END)
  assert.equal(pickWay(outs, { amount: 3_000_000 }).to, '교육 진행')
  // a condition on a task with one way out is refused (there is no split)
  assert.match(applyCorrections(found(), [c('x', 'set_cond', { from: '강의자료 준비', to: '고객 회신', when: { text: '급하면' } })]).skipped[0].why, /갈림길이 없어요/)
  // side by side: both open after what came before the first, and the step after both waits for both
  const p = [c('p', 'set_parallel', { a: '강의자료 준비', b: '고객 회신' })]
  const pv = refinedView(lectureBase(p), p)
  const pair = parallelPair(pv.edges, unfold(pv, '강의계획서 작성', 0.05).flows, '강의계획서 작성')
  assert.deepEqual(pair.targets.sort(), ['강의자료 준비', '고객 회신'])
  assert.equal(pair.next, '교육 진행')
  const d = await nextOf(pv, { todoId: 't1', task: '강의계획서 작성', state: 'done' }, { rows: [{ todoId: 't1', task: '강의계획서 작성', state: 'done' }] })
  assert.deepEqual(d.creates.map((x) => x.task).sort(), ['강의자료 준비', '고객 회신'])
  assert.match(applyCorrections(found(), [c('p', 'set_parallel', { a: '강의계획서 작성', b: '강의자료 준비' })]).skipped[0].why, /앞에 오는 일이 있어야/)
})

test('사람이 정한 길은 θ 와 상관없이 실행에 들어간다(관찰한 길은 θ 그대로)', () => {
  const cs = [c('a', 'add_edge', { from: '강의자료 준비', to: '교육 진행' })]
  const v = refinedView(lectureBase(cs), cs)
  const { flows } = unfold(v, '강의자료 준비', 0.9)
  assert.ok(flows.some((f) => f.from === '강의자료 준비' && f.to === '교육 진행'), '정한 길')
  assert.ok(!flows.some((f) => f.from === '고객 회신' && f.to === END && !f.synthetic), '관찰한 0.2 길은 θ 0.9 에서 빠짐')
  assert.ok(!unfold(v, '강의계획서 작성', 0.9).flows.some((f) => f.from === '강의계획서 작성' && f.to === END && !f.synthetic), '관찰한 0.4 길도 빠짐')
})

test('범위: 고른 단계 · 관계 안의 동작만 — 밖은 「범위 밖이라 하지 않았어요」', () => {
  const range = { tasks: ['강의자료 준비', '고객 회신'], ways: [{ from: '강의계획서 작성', to: '강의자료 준비' }] }
  assert.equal(inRange(normFix({ op: 'set_runner', args: { task: '강의자료 준비', runner: 'agent' } }), range), '')
  assert.equal(inRange(normFix({ op: 'set_role', args: { task: '교육 진행', role: '강사' } }), range), OUT_OF_RANGE)
  assert.equal(inRange(normFix({ op: 'add_task', args: { name: '검토', after: '강의자료 준비', before: '고객 회신' } }), range), '')
  assert.equal(inRange(normFix({ op: 'add_task', args: { name: '검토', after: '강의계획서 작성', before: '강의자료 준비' } }), range), '', '고른 관계 사이')
  assert.equal(inRange(normFix({ op: 'add_task', args: { name: '검토', after: '고객 회신', before: '교육 진행' } }), range), OUT_OF_RANGE)
  assert.equal(inRange(normFix({ op: 'add_edge', args: { from: '고객 회신', to: '끝' } }), range), '')
  assert.equal(inRange(normFix({ op: 'set_timer', args: { cron: '0 9 * * 1', entry: '강의자료 준비' } }), range), OUT_OF_RANGE)
  assert.equal(inRange(normFix({ op: 'remove_task', args: { task: '교육 진행' } }), null), '', '범위가 없으면 프로세스 전체')
})

test('동작 확인: 범위 밖 · 없는 이름 · 이미 있는 일은 하지 않고 까닭을 남긴다, 이름은 맞춘다', async () => {
  const base = lectureBase(), view = refinedView(base, [])
  const company = new Set(graph().tasks.map((t) => t.key))
  const range = { tasks: ['강의자료 준비'], ways: [] }
  const raw = [
    { op: 'set_runner', args: { task: '강의자료준비', runner: 'agent' } },
    { op: 'set_role', args: { task: '교육 진행', role: '외부 강사' } },
    { op: 'remove_task', args: { task: '없는 일' } },
  ]
  const r = await checkOps({ kind: 'range', raw, found: found(), view, range, company })
  assert.deepEqual(r.ok.map((x) => [x.op, x.args.task]), [['set_runner', '강의자료 준비']])
  assert.deepEqual(r.matched, [{ said: '강의자료준비', task: '강의자료 준비' }])
  assert.deepEqual(r.refused.map((x) => x.why), [OUT_OF_RANGE, '「없는 일」이 이 프로세스에 없어요.'])
  // a new step that the company already does elsewhere: that work's name (the model's matcher), not a second name
  const r2 = await checkOps({ kind: 'process', raw: [{ op: 'add_task', args: { name: '견적서 만들기', after: '고객 회신' } }, { op: 'add_task', args: { name: '고객 회신', after: '교육 진행' } }],
    found: found(), view, company, match: async (names) => new Map(names.map((n) => [n, n === '견적서 만들기' ? '견적서 작성' : null])) })
  assert.equal(r2.ok[0].args.name, '견적서 작성')
  assert.match(r2.refused[0].why, /이미 있어요/)
  // a process in hand: no new process from it; a new process: nothing else
  const r3 = await checkOps({ kind: 'process', raw: [{ op: 'new_process', args: { name: 'x', steps: ['a'] } }], found: found(), view, company })
  assert.match(r3.refused[0].why, /새 프로세스는 만들지 않았어요/)
  const r4 = await checkOps({ kind: 'new', raw: [{ op: 'set_role', args: { task: 'a', role: 'b' } }], company })
  assert.equal(r4.ok.length, 0)
  // each one applies on top of the ones before it
  const r5 = await checkOps({ kind: 'process', raw: [{ op: 'add_task', args: { name: '결과 보고', after: '고객 회신' } }, { op: 'set_role', args: { task: '결과 보고', role: '전무' } }], found: found(), view, company })
  assert.equal(r5.ok.length, 1, '더할 일은 아직 이 프로세스에 없으니 그 이름으로 고치는 것은 범위(이름) 확인에서 빠진다')
  assert.equal(sameName('고객  회신', new Set(['고객 회신'])), '고객 회신')
  // the mail reader folds 「견적서 발송」 into 「견적서 작성」: two steps said apart stay apart, a match of another kind of work is not taken
  const fold = async (names) => new Map(names.map((n) => [n, '견적서 작성']))
  const r6 = await checkOps({ kind: 'new', company, match: fold, raw: [{ op: 'new_process', args: { name: '견적', steps: [{ name: '견적서 만들기' }, { name: '견적서 발송' }], ways: [{ from: '견적서 만들기', to: '견적서 발송' }] } }] })
  assert.deepEqual(r6.ok[0].args.steps.map((x) => x.name), ['견적서 작성', '견적서 발송'])
  assert.deepEqual(r6.ok[0].args.ways.map((w) => `${w.from}>${w.to}`), ['견적서 작성>견적서 발송', '견적서 발송>__end__'])
  assert.ok(!sameWork('결과 보고', '작업 내용 확인') && sameWork('결과 보고', '결과보고서 공유') && sameWork('견적서작성', '견적서 작성'))
})

test('말로 만든 프로세스: 단계는 지도의 일, 길은 새 프로세스 줄 — 다듬은 흐름 · 실행 · 빌드 뒤에도 그대로', () => {
  const np = normFix({ op: 'new_process', args: { name: '견적 승인', start: '견적 요청 접수', steps: [{ name: '견적 요청 접수', role: '영업' }, { name: '견적서 작성', role: '영업' }, { name: '대표 승인', role: '대표' }, { name: '견적서 발송', role: '영업' }],
    ways: [{ from: '견적 요청 접수', to: '견적서 작성' }, { from: '견적서 작성', to: '대표 승인', when: { amount: { op: '>=', value: 5000000 } } }, { from: '견적서 작성', to: '견적서 발송', when: { amount: { op: '<', value: 5000000 } } },
      { from: '대표 승인', to: '견적서 발송' }, { from: '견적서 발송', to: '끝' }] } })
  const g = graph()
  const proc = { key: 'said:abc', name: '견적 승인', kind: 'flow', status: 'suggested', theta: 0.05, band: 'said', entries: ['견적 요청 접수'], tasks: np.args.steps.map((s) => s.name) }
  g.tasks.push({ key: '견적 요청 접수', role: '영업', n: 0, status: 'active', kind: 'said' }, { key: '견적서 발송', role: '영업', n: 0, status: 'active', kind: 'said' })
  g.processes.push(proc)
  const cs = [{ id: 'n', ...np }]
  // only the ways the person said are this process's (the mined 견적서 작성 → 고객 회신 is not: 고객 회신 is not its step; the mined
  // 견적서 작성 → 대표 승인 is, with what was observed)
  const base = baseOf(g, proc, cs)
  assert.deepEqual(base.edges.map((e) => `${e.from}>${e.to}`), ['견적서 작성>대표 승인'])
  assert.ok(saidWays(cs).has('견적서 작성\u0000견적서 발송'))
  const v = refinedView(base, cs)
  assert.deepEqual([...v.tasks.keys()].sort(), ['견적 요청 접수', '견적서 발송', '견적서 작성', '대표 승인'])
  assert.equal(v.edges.length, 5)
  assert.ok(v.edges.every((e) => e.decided), '모든 길이 사람이 정한 길')
  assert.equal(v.edges.find((e) => e.to === '대표 승인').n, 5, '관찰한 수는 같은 일 위에 쌓인다')
  assert.deepEqual(v.proc.entries[0], '견적 요청 접수')
  // all ways in at any θ; the amount split decides
  const { nodes } = unfold(v, '견적 요청 접수', 0.99)
  assert.deepEqual(nodes.sort(), ['견적 요청 접수', '견적서 발송', '견적서 작성', '대표 승인'])
  const outs = waysOut(v, '견적서 작성', 0.5).outs
  assert.equal(pickWay(outs, { amount: 6_200_000 }).to, '대표 승인')
  assert.equal(pickWay(outs, { amount: 1_000_000 }).to, '견적서 발송')
  // a build keeps it and its steps; a mined cluster does not take its key
  const k = keptAfterBuild({ processes: [...g.processes.map((p) => ({ ...p, status: p.status })), { key: 'process:old', status: 'suggested', tasks: ['x'] }],
    tasks: [...g.tasks, { key: 'x', status: 'active', kind: 'flow' }], mined: ['process:lec'], habitKeys: [], flowLive: new Set(found().tasks.map((t) => t.key)), habitLive: null })
  assert.ok(k.live.includes('said:abc'))
  assert.ok(!k.live.includes('process:old'))
  assert.ok(!k.goneTasks.includes('견적 요청 접수') && !k.goneTasks.includes('견적서 발송'))
  assert.ok(k.goneTasks.includes('x'))
  // gone said process → its steps go too
  const k2 = keptAfterBuild({ processes: [{ ...proc, status: 'gone' }], tasks: g.tasks, mined: [], flowLive: new Set() })
  assert.ok(k2.goneTasks.includes('견적서 발송'))
})

test('스냅샷(프로세스 정의로)도 말로 만든 흐름을 그대로: 금액 갈림 · 에이전트 단계', async () => {
  const np = normFix({ op: 'new_process', args: { name: '견적', start: '견적서 작성', steps: [{ name: '견적서 작성', role: '영업', runner: 'agent' }, { name: '대표 승인', role: '대표' }, { name: '견적서 발송', role: '영업' }],
    ways: [{ from: '견적서 작성', to: '대표 승인', when: { amount: { op: '>=', value: 5000000 } } }, { from: '견적서 작성', to: '견적서 발송', when: { amount: { op: '<', value: 5000000 } } }, { from: '대표 승인', to: '견적서 발송' }, { from: '견적서 발송', to: '끝' }] } })
  const g = graph()
  g.tasks.push({ key: '견적서 발송', role: '영업', n: 0, status: 'active', kind: 'said' })
  const proc = { key: 'said:q', name: '견적', kind: 'flow', status: 'suggested', theta: 0.05, entries: ['견적서 작성'], tasks: ['견적서 작성', '대표 승인', '견적서 발송'] }
  const v = refinedView(baseOf(g, proc, [{ id: 'n', ...np }]), [{ id: 'n', ...np }])
  const prev = process.env.PRO_ONTOLOGY_BOLT_URL
  // contractOf reads text conditions (none here) and the agent's id: it needs the database, so only the unfold is checked when there is none
  const { flows } = unfold(v, '견적서 작성', 0.05)
  assert.equal(flows.filter((f) => f.from === '견적서 작성').length, 2)
  assert.ok(flows.filter((f) => f.from === '견적서 작성').every((f) => /금액\(amount\)/.test(f.cond)))
  assert.equal(v.tasks.get('견적서 작성').runner, 'agent')
  assert.equal(typeof contractOf, 'function'); assert.equal(prev, process.env.PRO_ONTOLOGY_BOLT_URL)
})

test('지도 그림: 관찰한 것 · 사람이 정한 것 · 정했지만 아직 본 적 없는 것(n 0), 미리 보기의 더함 · 뺌 · 바뀜', () => {
  const cs = [c('1', 'add_task', { name: '결과 보고', role: '전무', after: '고객 회신' }), c('2', 'set_role', { task: '교육 진행', role: '외부 강사' }), c('3', 'rename_task', { task: '강의자료 준비', name: '강의 자료 만들기' })]
  const f = flowOf(refinedView(lectureBase(cs), cs))
  const t = (k) => f.tasks.find((x) => x.key === k)
  assert.deepEqual([t('결과 보고').decided, t('결과 보고').unseen, t('결과 보고').added], [true, true, true])
  assert.equal(t('강의계획서 작성').decided, undefined, '관찰만 한 일')
  assert.equal(t('교육 진행').decided, true, '역할을 바꿈')
  assert.equal(t('강의 자료 만들기').origin, '강의자료 준비')
  const add = f.edges.find((e) => e.from === '고객 회신' && e.to === '결과 보고')
  assert.equal(add.decided, true)
  const obs = f.edges.find((e) => e.from === '강의계획서 작성' && e.to === '강의 자료 만들기')
  assert.equal(obs.decided, undefined, '이름이 바뀌어도 관찰한 길')
  // preview: before → after
  const base = lectureBase()
  const p = previewOf({ kind: 'process', base, cs: [], ok: [{ op: 'remove_task', args: { task: '교육 진행' } }, { op: 'rename_task', args: { task: '강의자료 준비', name: '강의 자료 만들기' } }, { op: 'add_task', args: { name: '결과 보고', after: '고객 회신' } }] })
  const at = (k) => p.after.tasks.find((x) => x.key === k)
  assert.equal(at('교육 진행').diff, 'remove')
  assert.equal(at('결과 보고').diff, 'add')
  assert.equal(at('강의 자료 만들기').diff, 'change')
  assert.equal(at('강의 자료 만들기').was, '강의자료 준비')
  assert.ok(p.after.edges.some((e) => e.from === '고객 회신' && e.to === '교육 진행' && e.diff === 'remove'))
  assert.ok(p.after.edges.some((e) => e.from === '강의계획서 작성' && e.to === '강의 자료 만들기' && !e.diff), '이름만 바뀐 길은 같은 길')
  const d = diffFlows(null, { tasks: [{ key: 'a', origin: null }], edges: [], entries: [] })
  assert.equal(d.tasks[0].diff, 'add')
})

test('채팅 초안(프로세스 정의 계약) → 새 프로세스 동작: 갈림길 조건 · 나란히 · 에이전트 단계', () => {
  const contract = { processDefinition: { processDefinitionName: '견적 승인', description: '견적 요청부터 발송까지', elements: [
    { elementType: 'Event', id: 'start', name: '요청 도착', type: 'StartEvent' },
    { elementType: 'Activity', id: 'a1', name: '견적서 작성', role: '영업' },
    { elementType: 'Gateway', id: 'g1', type: 'ExclusiveGateway' },
    { elementType: 'Activity', id: 'a2', name: '대표 승인', role: '대표' },
    { elementType: 'Activity', id: 'a3', name: '견적서 발송', role: '영업' },
    { elementType: 'Gateway', id: 'g2', type: 'ParallelGateway' },
    { elementType: 'Activity', id: 'a4', name: '고객 안내 메일', role: '업무 에이전트', agentMode: 'complete', orchestration: 'x' },
    { elementType: 'Activity', id: 'a5', name: '영업 기록', role: '영업' },
    { elementType: 'Event', id: 'end', name: '끝', type: 'EndEvent' },
    { elementType: 'Sequence', source: 'start', target: 'a1' }, { elementType: 'Sequence', source: 'a1', target: 'g1' },
    { elementType: 'Sequence', source: 'g1', target: 'a2', condition: '금액이 500만 원 이상' }, { elementType: 'Sequence', source: 'g1', target: 'a3', condition: '금액이 500만 원 미만' },
    { elementType: 'Sequence', source: 'a2', target: 'a3' }, { elementType: 'Sequence', source: 'a3', target: 'g2' },
    { elementType: 'Sequence', source: 'g2', target: 'a4' }, { elementType: 'Sequence', source: 'g2', target: 'a5' },
    { elementType: 'Sequence', source: 'a4', target: 'end' }, { elementType: 'Sequence', source: 'a5', target: 'end' },
  ] } }
  const [op] = opsFromContract(contract)
  assert.equal(op.op, 'new_process')
  assert.equal(op.args.name, '견적 승인')
  assert.equal(op.args.start, '견적서 작성')
  assert.deepEqual(op.args.steps.find((s) => s.name === '고객 안내 메일'), { name: '고객 안내 메일', role: '', runner: 'agent' })
  assert.deepEqual(op.args.ways.find((w) => w.to === '대표 승인').when, { amount: { op: '>=', value: 5000000 } })
  assert.deepEqual(op.args.parallel, [['고객 안내 메일', '영업 기록']])
  assert.ok(op.args.ways.some((w) => w.from === '견적서 발송' && w.to === '고객 안내 메일'))
  assert.ok(normFix(op), '그대로 읽힌다')
  assert.deepEqual(whenOfText('계약 금액 1억 원 초과'), { amount: { op: '>', value: 100000000 } })
  assert.deepEqual(whenOfText('긴급한 요청이면'), { text: '긴급한 요청이면' })
})

test('사람 이름 가리기: 모델에 보낼 때 가리고, 받은 동작에서 되돌린다', () => {
  const m = masker(['장진영', '김지원'])
  const s = m.mask(JSON.stringify({ words: '장진영 전무가 승인하고 김지원 교수에게 jy@uengine.org 로 보내요' }))
  assert.ok(!/장진영|김지원|uengine\.org/.test(s))
  assert.deepEqual(m.unmask({ ops: [{ op: 'add_task', args: { name: '사람1 확인' } }] }), { ops: [{ op: 'add_task', args: { name: '장진영 확인' } }] })
})

test('채팅에서 말한 프로세스 고르기: 이름이 하나로 맞으면 그것, 아니면 묻는다', () => {
  const ps = [{ key: 'a', name: '강의계획서 작성 · 보고', tasks: ['강의계획서 작성'], cases: 2, kind: 'flow' }, { key: 'b', name: '제안서 공유 · 검토', tasks: ['제안서 작성'], cases: 5, kind: 'flow' }, { key: 'r', name: '루틴', kind: 'routine', tasks: [] }]
  assert.equal(pickProcess(ps, { name: '강의계획서 작성 · 보고' }).proc.key, 'a')
  assert.equal(pickProcess(ps, { text: '강의 프로세스에서 강의계획서 작성 뒤에 검토를 넣어 줘' }).proc.key, 'a')
  assert.ok(pickProcess(ps, { text: '그거 바꿔 줘' }).choices.length >= 2)
})

// ---------- 의견 · 상충 ----------
const op = (o, args) => ({ op: o, args })
test('의견 맞춰 적기: 같은 동작은 같은 지문(순서 · 띄어쓰기 상관없이), 동작이 없으면 말로', () => {
  const a = normOps([op('set_runner', { task: '강의자료 준비', runner: 'agent' }), op('add_task', { name: '결과 보고', after: '고객 회신' })])
  const b = normOps([op('add_task', { name: '결과  보고', after: '고객 회신', role: '' }), op('set_runner', { task: '강의자료 준비', runner: 'agent' })])
  assert.equal(opsKey(a), opsKey(b))
  assert.notEqual(opsKey(normOps([op('set_runner', { task: '강의자료 준비', runner: 'person' })])), opsKey(a))
  assert.equal(opsKey([], '강의가 너무 길어요'), opsKey([], '강의가  너무 길어요'))
  assert.match(opsKey([], 'x'), /^text:/)
})

test('상충: 빼기와 쓰기 · 순서 · 역할 · 하는 이 · 조건 · 잇기와 끊기 · 나란히와 차례로 · 이름 · 꼭 선택', () => {
  const kinds = (A, B, o) => conflictsBetween(A, B, o).map((x) => x.kind)
  assert.deepEqual(kinds([op('remove_task', { task: '교육 진행' })], [op('set_requirement', { task: '교육 진행', requirement: 'required' })]), ['requirement'])
  assert.deepEqual(kinds([op('remove_task', { task: '교육 진행' })], [op('add_task', { name: '결과 보고', after: '교육 진행' })]), ['remove'])
  assert.deepEqual(kinds([op('add_edge', { from: '고객 회신', to: '교육 진행' })], [op('reverse_edge', { from: '고객 회신', to: '교육 진행' })]), ['way', 'order'].filter((k) => kinds([op('add_edge', { from: '고객 회신', to: '교육 진행' })], [op('reverse_edge', { from: '고객 회신', to: '교육 진행' })]).includes(k)))
  assert.ok(kinds([op('move_task', { task: '교육 진행', after: '강의계획서 작성' })], [op('move_task', { task: '교육 진행', after: '고객 회신' })]).includes('order'))
  assert.ok(kinds([op('add_edge', { from: 'a', to: 'b' })], [op('add_edge', { from: 'b', to: 'a' })]).includes('order'))
  assert.deepEqual(kinds([op('set_role', { task: '교육 진행', role: '강사' })], [op('set_role', { task: '교육 진행', role: '전무' })]), ['role'])
  assert.deepEqual(kinds([op('set_runner', { task: 'x', runner: 'agent' })], [op('set_runner', { task: 'x', runner: 'person' })]), ['runner'])
  const cond = (v) => op('set_cond', { from: '견적', to: '승인', when: { amount: { op: '>=', value: v } } })
  assert.deepEqual(kinds([cond(5000000)], [cond(3000000)]), ['cond'])
  assert.deepEqual(kinds([cond(5000000)], [cond(5000000)]), [], '같은 조건은 같은 의견')
  const t = (s) => op('set_cond', { from: '견적', to: '승인', when: { text: s } })
  assert.deepEqual(kinds([t('급한 요청이면')], [t('긴급한 건이면')], { sameText: () => true }), [], '같은 뜻이라고 본 글')
  assert.deepEqual(kinds([t('급한 요청이면')], [t('새 고객이면')], { sameText: () => false }), ['cond'])
  assert.deepEqual(kinds([op('add_edge', { from: 'a', to: 'b' })], [op('remove_edge', { from: 'a', to: 'b' })]), ['way'])
  assert.ok(kinds([op('set_parallel', { a: 'a', b: 'b' })], [op('add_edge', { from: 'a', to: 'b' })]).includes('parallel'))
  assert.deepEqual(kinds([op('rename_task', { task: 'a', name: 'b' })], [op('rename_task', { task: 'a', name: 'c' })]), ['rename'])
  assert.deepEqual(kinds([op('set_requirement', { task: 'a', requirement: 'required' })], [op('set_requirement', { task: 'a', requirement: 'optional' })]), ['requirement'])
  // not a conflict: different steps, the same thing
  assert.deepEqual(kinds([op('set_role', { task: 'a', role: 'x' })], [op('set_role', { task: 'b', role: 'y' })]), [])
  assert.deepEqual(kinds([op('remove_task', { task: 'a' })], [op('remove_task', { task: 'a' })]), [])
  assert.deepEqual(textPairs([[t('급한 요청이면')], [t('긴급한 건이면')], [t('급한  요청이면')]]), [['급한 요청이면', '긴급한 건이면']])
})

test('상충 묶음: 이어진 의견끼리 한 묶음, 이미 정한 것과 어긋나면 혼자서도 묶음 · 지도 표시', () => {
  const ops = {
    A: [op('set_runner', { task: '강의자료 준비', runner: 'agent' })],
    B: [op('set_runner', { task: '강의자료 준비', runner: 'person' })],
    C: [op('set_role', { task: '교육 진행', role: '외부 강사' })],
    D: [op('remove_task', { task: '고객 회신' })],
    E: [op('set_runner', { task: '강의자료 준비', runner: 'agent' })],
  }
  const list = Object.entries(ops).map(([id, o]) => ({ id, ops: o, key: opsKey(normOps(o)) }))
  const decided = [{ kind: 'requirement', op: 'set_requirement', args: { task: '고객 회신', requirement: 'required' }, label: '「고객 회신」을 꼭 하는 단계로 정함', by: 'boss', why: '고객에게 꼭 알려요' }]
  const groups = groupsOf(list, decided)
  const g1 = groups.find((g) => g.ids.includes('A'))
  assert.deepEqual(g1.ids, ['A', 'B', 'E'].filter((x) => x !== 'E').concat(g1.ids.includes('E') ? ['E'] : []).sort())
  assert.ok(!g1.ids.includes('C'))
  const g2 = groups.find((g) => g.ids.includes('D'))
  assert.deepEqual(g2.ids, ['D'])
  assert.equal(g2.decided[0].by, 'boss')
  assert.ok(g2.why[0].startsWith('이미 정한 것과 달라요'))
  assert.ok(!groups.some((g) => g.ids.includes('C')), '다른 단계는 상충 아님')
  // A and E agree (same operations): never in conflict with each other
  assert.equal(groupsOf([list[0], list[4]], []).length, 0)
  const m = marksOf(list.map((x) => ({ ...x })), groups)
  assert.deepEqual(m.tasks['강의자료 준비'], { n: 3, conflict: true })
  assert.deepEqual(m.tasks['교육 진행'], { n: 1, conflict: false })
  assert.equal(touchOf(op('add_task', { name: 'x', after: 'a', before: 'b' })).ways[0].join('>'), 'a>b')
})
