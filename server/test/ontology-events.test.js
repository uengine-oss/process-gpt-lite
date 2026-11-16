// 사건 → 시작(lib/ontology/events.js): 들어온 메일 · 채팅 요청 · 올린 파일을 자동 · 제안인 프로세스 모두에 견주어(프로세스마다 따로 예/아니요)
// 없음 · 하나 · 둘을 가리고, 자동인 프로세스만 메일에 저절로 시작 — 채팅 · 파일은 늘 묻기만. 프로세스가 많으면 먼저 고르기로 후보를 줄인다.
// 모델 없이(읽기를 대역으로).
import test from 'node:test'
import assert from 'node:assert/strict'
import { identify, planStarts, shortlist, candidatesOf, eventState } from '../lib/ontology/events.js'

const P = (key, name, status = 'suggested', x = {}) => ({ key, name, status, kind: 'flow', cases: 5, tasks: [`${name} 일`], summary: '', ...x })
const LECTURE = P('p:lec', '강의계획서 작성 · 보고', 'adopted', { cases: 2 })
const LAB = P('p:lab', '실습 · 자료 준비', 'suggested', { cases: 2 })
const NEWS = P('p:news', '뉴스 수집 · 클리핑', 'suggested', { cases: 68 })
// a yes/no reader that says yes to the processes whose names it is given
const yesTo = (...names) => async (state, question) => ({ p: names.some((n) => question.includes(`「${n}」`)) ? 0.9 : 0.1, measured: true })
const entryOf = async ({ procKey }) => ({ task: `${procKey}의 첫 일`, p: 0.8, ask: false, options: [{ task: `${procKey}의 첫 일`, p: 0.8 }], proc: procKey })
const ev = { kind: 'mail', subject: '[외부 강의 요청] 특강 부탁드립니다', text: '특강과 실습 자료를 부탁드립니다', from: '김지원 <kim@example-univ.test>' }

test('없음: 어느 프로세스도 「예」가 아니면 없음 — 가장 큰 프로세스로 밀어 넣지 않는다', async () => {
  const r = await identify(ev, { procs: [LECTURE, LAB, NEWS], yes: yesTo(), entryOf })
  assert.equal(r.none, true)
  assert.equal(r.reads.length, 3)
  assert.deepEqual(r.matches, [])
})

test('하나: 그 프로세스만 — 자동이면 메일에 저절로 시작한다', async () => {
  const r = await identify(ev, { procs: [LECTURE, LAB, NEWS], yes: yesTo('강의계획서 작성 · 보고'), entryOf })
  assert.deepEqual(r.matches.map((m) => m.proc), ['p:lec'])
  const plan = planStarts(r.matches, 'mail')
  assert.deepEqual(plan.start.map((m) => m.proc), ['p:lec'])
  assert.deepEqual(plan.offer, [])
})

test('둘: 프로세스마다 따로 읽으므로 둘 다 「예」일 수 있다 — 자동은 시작, 제안은 묻는다', async () => {
  const r = await identify(ev, { procs: [LECTURE, LAB, NEWS], yes: yesTo('강의계획서 작성 · 보고', '실습 · 자료 준비'), entryOf })
  assert.deepEqual(r.matches.map((m) => m.proc).sort(), ['p:lab', 'p:lec'])
  const lab = r.matches.find((m) => m.proc === 'p:lab')
  assert.equal(lab.choice.suggest, true)
  assert.equal(lab.choice.ask, true)
  assert.equal(lab.choice.procName, '실습 · 자료 준비')
  const plan = planStarts(r.matches, 'mail')
  assert.deepEqual(plan.start.map((m) => m.proc), ['p:lec'])
  assert.deepEqual(plan.offer.map((m) => m.proc), ['p:lab'])
})

test('자동인 프로세스라도 시작할 일이 확실하지 않으면(50% 아래) 묻는다', async () => {
  const unsure = async ({ procKey }) => ({ task: '어느 일', p: 0.31, ask: true, options: [{ task: '어느 일', p: 0.31 }], proc: procKey })
  const r = await identify(ev, { procs: [LECTURE], yes: yesTo('강의계획서 작성 · 보고'), entryOf: unsure })
  const plan = planStarts(r.matches, 'mail')
  assert.deepEqual(plan.start, [])
  assert.deepEqual(plan.offer.map((m) => m.proc), ['p:lec'])
})

test('파일 · 채팅: 사람이 한 일이라 자동인 프로세스여도 저절로 시작하지 않고 묻기만 한다', async () => {
  const file = { kind: 'file', subject: '강의 요청서.docx', text: '이거 진행해 주세요', file: { name: '강의 요청서.docx', type: 'application/vnd.openxmlformats', excerpt: '특강 요청 · 3시간 · 40명' } }
  const r = await identify(file, { procs: [LECTURE, LAB], yes: yesTo('강의계획서 작성 · 보고', '실습 · 자료 준비'), entryOf })
  assert.equal(r.matches.length, 2)
  for (const kind of ['file', 'chat']) {
    const plan = planStarts(r.matches, kind)
    assert.deepEqual(plan.start, [], kind)
    assert.equal(plan.offer.length, 2, kind)
  }
  // the event the model reads: the file's name, the start of its text and the words typed with it
  const s = eventState(file)
  assert.match(s, /회사에 들어온 파일/)
  assert.match(s, /파일: 강의 요청서\.docx/)
  assert.match(s, /파일 내용 앞부분:\n특강 요청/)
  assert.match(s, /함께 쓴 말: 이거 진행해 주세요/)
})

test('메일 하나가 여는 건은 maxStarts 개까지', () => {
  const m = (k) => ({ proc: k, status: 'adopted', choice: { task: 'x', p: 0.9, ask: false } })
  const plan = planStarts([m('a'), m('b'), m('c'), m('d')], 'mail', { maxStarts: 3 })
  assert.equal(plan.start.length, 3)
  assert.deepEqual(plan.offer.map((x) => x.proc), ['d'])
})

test('프로세스가 많으면: 제안인 것은 덩어리마다 고르기 한 번으로 후보를 줄이고 후보만 따로 읽는다(비용) — 자동인 것은 늘 따로 읽는다', async () => {
  const many = Array.from({ length: 30 }, (_, i) => P(`p:${i}`, `업무 ${i}`))
  many[3] = LECTURE; many[25] = LAB
  const picks = []
  const read = async (state, question, options) => {
    picks.push(options.length)
    const probabilities = Object.fromEntries(options.map((o) => [o.key, 0.001]))
    options.forEach((o) => { if (/강의계획서|실습 · 자료/.test(o.label)) probabilities[o.key] = 0.6 })
    probabilities.none = 0.2
    return { probabilities }
  }
  const asked = []
  const yes = async (state, q) => { asked.push(q); return { p: /강의계획서|실습 · 자료/.test(q) ? 0.9 : 0.1, measured: true } }
  const r = await identify(ev, { procs: candidatesOf(many), R: { yes: 0.6, prefilterAbove: 6, chunk: 20, shortlist: 4, shortlistMin: 0.05, maxReads: 6, question: '「{name}」?', pick: '어느?', none: '없음' }, read, yes, entryOf })
  assert.deepEqual(picks, [21, 10])           // 29 suggested processes → two picks (20 + 9, each with 「none」); the adopted one is not in a pick
  assert.equal(asked.length, 2)               // the adopted one and the shortlisted ones are read one by one
  assert.ok(asked.some((q) => q.includes('강의계획서')))
  assert.deepEqual(r.matches.map((m) => m.proc).sort(), ['p:lab', 'p:lec'])
  // a pick that cannot be read keeps that chunk (its first ones) rather than dropping it
  const s = await shortlist('x', many.slice(0, 5), { chunk: 20, shortlist: 4 }, async () => null)
  assert.equal(s.keep.length, 4)
})

test('견줄 프로세스: 자동 · 제안인 흐름 모두(루틴 · 관찰 빼고), 자동이 먼저', () => {
  const list = candidatesOf([P('a', 'A', 'paused'), P('b', 'B', 'suggested', { cases: 50 }), P('c', 'C', 'adopted', { cases: 1 }), P('d', 'D', 'adopted', { kind: 'routine' })])
  assert.deepEqual(list.map((p) => p.key), ['c', 'b'])
})
