// 계획 지키기 — 벗어나면 멈추고 묻기, 단계마다 어떻게 됐는지 (lib/planGuard.js · lib/turnPlan.js stepsOf · saved · settledPlan · finalAnswer,
// 스펙 openspec/specs/turn-plan 「계획에서 벗어나면 멈추고 묻는다」 · 「저장된 계획은 단계마다 어떻게 됐는지 남긴다」). 2026-11-28 녹화 20:49:
// 「구글 드라이브에서 찾지 못했다 … 이걸 그냥 무시하고 그냥 넘어갖고 멈춰서 나한테 물어보는 게 맞지」. 모델은 가짜(ask 를 주입) — 판정의 뜻은
// 모델 몫이고, 여기서는 언제 묻는지 · 답을 어떻게 읽는지 · 무엇을 남기는지를 본다.
//   PG-U-01 판정 읽기: off 는 missing · changed 와 what · question 이 있을 때만, 단계 번호 범위, 보기 3개까지
//   PG-U-02 단계 결과 읽기: 모든 단계를 덮을 때만
//   PG-U-03 언제 묻나: 할 일 목록이 움직일 때(처음 기록은 아님) · 첫 파일 · 도구 4개마다 · 중간 글, 겹치면 하나 뒤에 한 번
//   PG-U-04 0.7 이상이면 한 번만 멈춤(onStop), 아래면 그대로, 모델 오류면 그대로
//   PG-U-05 계획이 없거나(앞단 실패) 꺼져 있거나 턴이 끝났으면 묻지 않음
//   PG-U-06 끝 확인: 단계 결과 + 벗어남, 멈춘 턴 · 모델 오류는 null
//   PG-U-07 저장된 계획의 단계: 멈춘 단계는 못 함/바꿈 + 까닭, 확인 중엔 에이전트의 상태, 확인이 오면 결과 · 없으면 예전처럼 완료
//   PG-U-08 답 앞의 짧은 딴 줄(「Update README structure section.」)은 답에 붙지 않고, 긴 요약 뒤 맺음 한 줄은 그대로
//   PG-U-09 멈춘 턴의 메시지: 무엇이 있었나 · 질문 · 보기 목록 — 채팅의 빠른 답 단추로 읽힘
//   (PR #132 검토) PG-U-10 스트림이 끝난 뒤 온 판정은 멈추지 않고 끝 확인으로 · PG-U-11 6번까지, 15초 간격 · PG-U-12 나란히 부른 도구의
//   결과 · 같은 보기 하나로 · 기록은 지시가 아님 · PG-U-13 멈춘 단계는 판정 때의 목록으로
//   cd server && node --test test/planGuard.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import * as PG from '../lib/planGuard.js'
import * as TP from '../lib/turnPlan.js'
import { parseReplies } from '../../src/replies.js'

const PLAN = { understood: '드라이브의 가나정밀 교육 자료로 커리큘럼을 만들어 드릴게요.', steps: [{ id: 'p1', text: '드라이브에서 가나정밀 교육 자료 찾기' }, { id: 'p2', text: '자료로 커리큘럼 만들기' }, { id: 'p3', text: '정리해서 전달' }], source: 'front' }
const OFF = { off: true, step: 1, kind: 'missing', what: '드라이브에서 가나정밀 교육 자료를 찾지 못했는데 공개 자료로 대신 만들고 있어요.', question: '어떻게 할까요?', options: ['자료 위치를 알려 줄게요', '공개 자료로 계속해 줘', '여기서 멈춰'], confidence: 0.9 }
const view = (over = {}) => ({ plan: PLAN, todos: [], notes: [], ended: null, ...over })
const flush = () => new Promise((r) => setTimeout(r, 0))
// a fake model: each call answers with the next of `answers` (an Error rejects), and is recorded
function fakeAsk(answers) {
  const calls = []
  const ask = async (system, user, opts) => {
    calls.push({ system, user, opts })
    const a = answers.length > 1 ? answers.shift() : answers[0]
    if (a instanceof Error) throw a
    return typeof a === 'function' ? a() : a
  }
  return { ask, calls }
}

test('PG-U-01 판정 읽기 — off 는 missing · changed 와 무엇 · 질문이 있을 때만', () => {
  assert.deepEqual(PG.readVerdict(OFF, 3), { off: true, step: 1, kind: 'missing', what: OFF.what, question: OFF.question, options: OFF.options, confidence: 0.9 })
  assert.equal(PG.readVerdict({ ...OFF, kind: 'other' }, 3).off, false, 'an unknown kind is not off')
  assert.equal(PG.readVerdict({ ...OFF, question: '' }, 3).off, false, 'no question: nothing to ask')
  assert.equal(PG.readVerdict({ ...OFF, step: 7 }, 3).step, 0, 'a step outside the list')
  assert.equal(PG.readVerdict({ ...OFF, options: ['a', 'b', 'c', 'd'] }, 3).options.length, 3)
  assert.equal(PG.readVerdict({ ...OFF, confidence: 3 }, 3).confidence, 1)
  assert.equal(PG.readVerdict({ off: false, confidence: 0.9 }, 3).off, false)
  assert.equal(PG.readVerdict(null), null)
  assert.equal(PG.stops(PG.readVerdict({ ...OFF, confidence: 0.69 }, 3)), false, 'under the bar')
  assert.equal(PG.stops(PG.readVerdict({ ...OFF, confidence: 0.7 }, 3)), true, 'at the bar')
})

test('PG-U-02 단계 결과 읽기 — 모든 단계를 덮을 때만', () => {
  const j = { steps: [{ n: 1, state: 'missed', why: '자료를 찾지 못함' }, { n: 2, state: 'done', why: '무시' }, { n: 3, state: 'changed', why: '표로' }] }
  assert.deepEqual(PG.readOutcomes(j, 3), [{ state: 'missed', why: '자료를 찾지 못함' }, { state: 'done' }, { state: 'changed', why: '표로' }])
  assert.equal(PG.readOutcomes({ steps: j.steps.slice(0, 2) }, 3), null, 'a step not covered')
  assert.equal(PG.readOutcomes({ steps: [...j.steps.slice(0, 2), { n: 3, state: 'maybe' }] }, 3), null, 'an unknown state')
  assert.equal(PG.readOutcomes({}, 3), null)
})

test('PG-U-03 언제 묻나 — 할 일이 움직일 때 · 첫 파일 · 도구 4개마다 · 중간 글, 겹치면 하나 뒤에 한 번', async () => {
  const { ask, calls } = fakeAsk([{ off: false, confidence: 0.1 }])
  const g = PG.createGuard({ view: view(), request: '드라이브에서 가나정밀 교육 자료를 찾아 커리큘럼을 만들어 줘', ask, enabled: true, gap: 0 })
  g.todos([{ text: 'a', state: 'active' }, { text: 'b', state: 'pending' }])
  await flush()
  assert.equal(calls.length, 0, 'the first to-do list is the plan, not a move')
  g.todos([{ text: 'a', state: 'active' }, { text: 'b', state: 'pending' }])
  assert.equal(calls.length, 0, 'the same list again')
  g.todos([{ text: 'a', state: 'done' }, { text: 'b', state: 'active' }])
  await g.settle()
  assert.equal(calls.length, 1, 'a step moved')
  for (let i = 0; i < 3; i++) { g.tool({ tool: 'drive_search', phase: '드라이브 찾기', query: '가나정밀' }); g.result('[]') }
  await g.settle()
  assert.equal(calls.length, 1, 'three tools: not yet')
  g.tool({ tool: 'fetch_url', phase: '웹 읽기', hosts: ['github.com'] }); g.result('<html>')
  g.result('<html> again')
  await g.settle()
  assert.equal(calls.length, 2, 'the fourth tool (a second result for the same call counts once)')
  assert.match(calls[1].user, /drive_search · 드라이브 찾기 · "가나정밀"\n {2}→ \[\]/, 'the record carries what each tool returned')
  g.file('curriculum.md'); g.file('curriculum.md'); g.file('README.md')
  await g.settle()
  assert.equal(calls.length, 3, 'the first file only')
  // two reasons while one check is on its way: one more check after it, not two
  const slow = fakeAsk([() => new Promise((r) => setTimeout(() => r({ off: false, confidence: 0 }), 30))])
  const g2 = PG.createGuard({ view: view(), request: 'x', ask: slow.ask, enabled: true, gap: 0 })
  g2.note('먼저 드라이브를 찾아볼게요.')
  g2.note('찾지 못했어요. 공개 자료로 할게요.')
  g2.file('a.md')
  await g2.settle(); await new Promise((r) => setTimeout(r, 80)); await g2.settle()
  assert.equal(slow.calls.length, 2)
  assert.match(slow.calls[1].user, /찾지 못했어요. 공개 자료로 할게요./, 'the later check reads the later note')
})

test('PG-U-04 0.7 이상이면 한 번만 멈춤, 아래 · 모델 오류는 그대로', async () => {
  let stopped = []
  const low = fakeAsk([{ ...OFF, confidence: 0.6 }])
  const g1 = PG.createGuard({ view: view(), request: 'x', ask: low.ask, enabled: true, gap: 0, onStop: (v) => stopped.push(v) })
  g1.file('a.md'); await g1.settle()
  assert.equal(stopped.length, 0)
  assert.equal(g1.stopped(), null)
  const err = fakeAsk([new Error('model down')])
  const g2 = PG.createGuard({ view: view(), request: 'x', ask: err.ask, enabled: true, gap: 0, onStop: (v) => stopped.push(v) })
  g2.file('a.md'); await g2.settle()
  assert.equal(stopped.length, 0)
  const hi = fakeAsk([OFF])
  const g3 = PG.createGuard({ view: view({ todos: [{ text: '드라이브 찾기', state: 'active' }, { text: '만들기', state: 'pending' }] }), request: 'x', ask: hi.ask, enabled: true, gap: 0, onStop: (v) => stopped.push(v) })
  g3.file('a.md'); await g3.settle()
  g3.note('또'); g3.file('b.md'); await g3.settle()
  assert.equal(stopped.length, 1, 'once')
  assert.equal(hi.calls.length, 1, 'no more checks once stopped')
  assert.equal(stopped[0].kind, 'missing')
  assert.equal(stopped[0].steps.length, 2, 'the steps as they were when it stopped')
  assert.match(hi.calls[0].system, /off is true only when the work goes on regardless/)
  assert.match(hi.calls[0].user, /1\. 드라이브 찾기 \[active\]/)
  assert.equal(hi.calls[0].opts.temperature, 0)
})

test('PG-U-05 계획이 없거나 꺼져 있거나 턴이 끝났으면 묻지 않음', async () => {
  for (const [v, enabled] of [[view({ plan: { ...PLAN, source: 'fallback' } }), true], [view({ plan: { ...PLAN, steps: [] } }), true], [view(), false], [view({ ended: 'done' }), true]]) {
    const { ask, calls } = fakeAsk([OFF])
    const g = PG.createGuard({ view: v, request: 'x', ask, enabled, gap: 0 })
    g.file('a.md'); g.note('n'); await g.settle()
    assert.equal(calls.length, 0)
    // (the end check is asked as the answer is saved, before the turn's view ends — an ended view only stops the checks on the way)
    if (!v.ended) assert.equal(await g.final('답'), null)
  }
  const before = process.env.PRO_PLAN_GUARD
  process.env.PRO_PLAN_GUARD = 'off'
  assert.equal(PG.guardOn(), false)
  process.env.PRO_PLAN_GUARD = before ?? 'on'
  if (before === undefined) delete process.env.PRO_PLAN_GUARD
  assert.equal(PG.guardOn(), true)
})

test('PG-U-06 끝 확인 — 단계 결과와 벗어남, 멈춘 턴 · 모델 오류는 null', async () => {
  const ans = { ...OFF, steps: [{ n: 1, state: 'missed', why: '드라이브에서 찾지 못함' }, { n: 2, state: 'changed', why: '공개 자료로 만듦' }, { n: 3, state: 'done' }] }
  const { ask, calls } = fakeAsk([{ off: false, confidence: 0.2 }, ans])
  const g = PG.createGuard({ view: view(), request: '드라이브의 자료로 만들어 줘', ask, enabled: true, gap: 0 })
  g.note('찾아볼게요'); await g.settle()
  const fin = await g.final('# 커리큘럼\n다만 드라이브에서 자료를 찾지 못해 공개 자료를 기준으로 잡았어요.')
  assert.equal(fin.verdict.kind, 'missing')
  assert.deepEqual(fin.outcomes.map((o) => o.state), ['missed', 'changed', 'done'])
  assert.match(calls.at(-1).system, /"steps": \[\{"n"/)
  assert.match(calls.at(-1).user, /Its answer:\n# 커리큘럼/)
  // an end check that says all went to plan: outcomes, no verdict
  const ok = fakeAsk([{ off: false, confidence: 0.1, steps: [{ n: 1, state: 'done' }, { n: 2, state: 'done' }, { n: 3, state: 'done' }] }])
  const g2 = PG.createGuard({ view: view(), request: 'x', ask: ok.ask, enabled: true, gap: 0 })
  const f2 = await g2.final('답')
  assert.equal(f2.verdict, null)
  assert.deepEqual(f2.outcomes.map((o) => o.state), ['done', 'done', 'done'])
  const err = fakeAsk([new Error('down')])
  assert.equal(await PG.createGuard({ view: view(), request: 'x', ask: err.ask, enabled: true, gap: 0 }).final('답'), null)
  const stop = fakeAsk([OFF])
  const g3 = PG.createGuard({ view: view(), request: 'x', ask: stop.ask, enabled: true, gap: 0, onStop: () => {} })
  g3.file('a.md'); await g3.settle()
  assert.equal(await g3.final('답'), null, 'a stopped turn has no end check')
})

test('PG-U-07 저장된 계획의 단계 — 멈춘 단계 · 확인 중 · 확인 결과 · 예전처럼', () => {
  const steps = PLAN.steps
  // stopped at step 2 with no to-do list: before it done, it missed with why, after it pending
  assert.deepEqual(TP.stepsOf(steps, { guard: { ...OFF, step: 2 } }).map((s) => [s.state, s.why || '']), [['done', ''], ['missed', OFF.what], ['pending', '']])
  // stopped with the agent's own to-dos: their states before it (an active one is pending), changed with why
  const todos = [{ id: 't1', text: 'a', state: 'done' }, { id: 't2', text: 'b', state: 'active' }, { id: 't3', text: 'c', state: 'pending' }]
  assert.deepEqual(TP.stepsOf(todos, { todos: true, guard: { ...OFF, kind: 'changed', step: 3 } }).map((s) => s.state), ['done', 'pending', 'changed'])
  // a guard with no step: the first one not done
  assert.deepEqual(TP.stepsOf(todos, { todos: true, guard: { ...OFF, step: 0 } }).map((s) => s.state), ['done', 'missed', 'pending'])
  // checking: the agent's own states (a step it never marked is not done yet); asked: the same
  assert.deepEqual(TP.stepsOf(todos, { todos: true, checking: true }).map((s) => s.state), ['done', 'active', 'pending'])
  assert.deepEqual(TP.stepsOf(steps, { state: 'asked' }).map((s) => s.state), ['pending', 'pending', 'pending'])
  // no outcomes, no guard: done as before (2026-11-25 — no model to ask)
  assert.deepEqual(TP.stepsOf(todos, { todos: true, state: 'done' }).map((s) => s.state), ['done', 'done', 'done'])
  // settled: the outcomes, or done as before when none; checking goes
  const plan = { understood: 'u', steps: todos, state: 'done', fromTodos: true, checking: true }
  const s1 = TP.settledPlan(plan, [{ state: 'missed', why: '못 찾음' }, { state: 'done' }, { state: 'done' }])
  assert.equal(s1.checking, undefined)
  assert.deepEqual(s1.steps.map((s) => [s.state, s.why || '']), [['missed', '못 찾음'], ['done', ''], ['done', '']])
  assert.deepEqual(TP.settledPlan(plan, null).steps.map((s) => s.state), ['done', 'done', 'done'])
  assert.deepEqual(TP.settledPlan(plan, [{ state: 'done' }]).steps.map((s) => s.state), ['done', 'done', 'done'], 'outcomes of another length are not taken')
})

test('PG-U-08 답 앞의 짧은 딴 줄은 답에 붙지 않고, 긴 요약 뒤 맺음 한 줄은 그대로', () => {
  const long = '# 스펙킷 기반 교육과정\n' + '교육 과정을 Spec Kit 기반으로 다시 설계했어요. '.repeat(20)
  const segsOf = (text) => { const s = TP.createSegments({ stream: false }); s.token(text); s.mark(); return s }
  // a stray line, then write_todos (bookkeeping), then the answer: the answer alone
  const stray = segsOf('Update README structure section.')
  stray.token(long)
  assert.equal(TP.finalAnswer(long, stray).text, long.trim())
  // a long summary, then write_todos, then a closing line: the whole segment (2026-11-25 review #2)
  const summary = segsOf(long)
  summary.token('모든 단계를 마쳤어요.')
  assert.equal(TP.finalAnswer('모든 단계를 마쳤어요.', summary).text, `${long}\n\n모든 단계를 마쳤어요.`)
  // a 400-character summary, then write_todos, then a longer closing: still one answer (review #132-11)
  const s4 = '요약 문장입니다. '.repeat(40), c4 = '마무리 문장입니다. '.repeat(45).trim()
  const mid = segsOf(s4)
  mid.token(c4)
  assert.equal(TP.finalAnswer(c4, mid).text, `${s4}\n\n${c4}`)
})

test('PG-U-09 멈춘 턴의 메시지 — 무엇이 있었나 · 질문 · 보기가 빠른 답 단추로', () => {
  const t = PG.askText(OFF)
  assert.ok(t.startsWith(OFF.what))
  const r = parseReplies(t)
  assert.ok(r, 'quick replies')
  assert.deepEqual(r.options.map((o) => o.label), OFF.options)
})

test('PG-U-10 스트림이 끝난 뒤 온 판정은 멈추지 않고 끝 확인으로 간다(검토 #132-1)', async () => {
  const stopped = []
  // a reading on its way when the stream ends: no stop
  let release
  const slow = fakeAsk([() => new Promise((r) => { release = () => r(OFF) })])
  const g = PG.createGuard({ view: view(), request: 'x', ask: slow.ask, enabled: true, gap: 0, onStop: (v) => stopped.push(v) })
  g.file('a.md')
  g.close()
  release()
  await g.settle()
  assert.equal(stopped.length, 0, 'a finished turn is never stopped')
  assert.equal(g.canSettle(), true)
  // and when the end check's own call fails, that late reading is the verdict (the question is still asked, after the answer)
  let r2
  const onWay = fakeAsk([() => new Promise((r) => { r2 = () => r(OFF) })])
  const down = fakeAsk([new Error('down')])
  const ask = (sys, user, o) => (sys.includes('"steps": [{"n"') ? down.ask(sys, user, o) : onWay.ask(sys, user, o))
  const g2 = PG.createGuard({ view: view(), request: 'x', ask, enabled: true, gap: 0, onStop: (v) => stopped.push(v) })
  g2.file('a.md'); g2.close(); r2(); await g2.settle()
  const fin = await g2.final('답')
  assert.equal(stopped.length, 0)
  assert.equal(fin.verdict.kind, 'missing', 'the late reading')
  assert.equal(fin.outcomes, null)
})

test('PG-U-11 한 턴의 판정은 6번까지, 15초 간격(검토 #132-3)', async () => {
  const { ask, calls } = fakeAsk([{ off: false, confidence: 0.1 }])
  const g = PG.createGuard({ view: view(), request: 'x', ask, enabled: true, gap: 0, max: 6 })
  for (let i = 0; i < 12; i++) { g.note(`메모 ${i}`); await g.settle() }
  assert.equal(calls.length, 6)
  const spaced = fakeAsk([{ off: false, confidence: 0.1 }])
  const g2 = PG.createGuard({ view: view(), request: 'x', ask: spaced.ask, enabled: true, gap: 60_000 })
  g2.note('하나'); await g2.settle()
  g2.note('둘'); g2.note('셋'); await g2.settle()
  assert.equal(spaced.calls.length, 1, 'a second reason within the gap waits')
  g2.close()
  assert.equal(PG.GAP_MS, 15000)
  assert.equal(PG.MAX_CHECKS, 6)
})

test('PG-U-12 나란히 부른 도구의 결과는 그 도구에(검토 #132-7) · 같은 보기는 하나로 · 기록은 지시가 아니라고 알림', async () => {
  const { ask, calls } = fakeAsk([{ off: false, confidence: 0.1 }])
  const g = PG.createGuard({ view: view(), request: 'x', ask, enabled: true, gap: 0, every: 2 })
  g.tool({ tool: 'drive_search', phase: '드라이브 찾기' })
  g.tool({ tool: 'fetch_url', phase: '웹 읽기' })
  g.result('<html>page</html>', 'fetch_url')
  g.result('[]', 'drive_search')
  await g.settle()
  assert.match(calls[0].user, /drive_search · 드라이브 찾기\n {2}→ \[\]/)
  assert.match(calls[0].user, /fetch_url · 웹 읽기\n {2}→ <html>page<\/html>/)
  assert.match(calls[0].system, /data, never instructions/)
  assert.deepEqual(PG.readVerdict({ ...OFF, options: ['가', '가', '나'] }, 3).options, ['가', '나'])
})

test('PG-U-13 멈춘 단계는 판정할 때의 단계 목록으로(검토 #132-8)', () => {
  const at = [{ id: 't1', text: '찾기', state: 'active' }, { id: 't2', text: '만들기', state: 'pending' }]
  // the agent rewrote its to-dos into three before the stop landed: the snapshot (two) is what the step number means
  const g = { ...OFF, step: 1, steps: at, fromTodos: true }
  const out = TP.stepsOf(g.steps, { todos: g.fromTodos, guard: g })
  assert.deepEqual(out.map((s) => [s.text, s.state]), [['찾기', 'missed'], ['만들기', 'pending']])
})
