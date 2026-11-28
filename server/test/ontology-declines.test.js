// 제안을 거절한 까닭 → 다음 채팅 요청(lib/ontology/declines.js · events.js identify · turnDidWork). 2026-11-28 녹화: 「Spec Kit 커리큘럼을 PMO 자료로
// 설계해 줘」에 「요청 보고 · 구현」을 권했다 — 「전혀 관계도 없는 거 자꾸 추천하기도 하고 … 아닌 이유를 좀 파악을 해야」. 일이 이미 끝난 답 아래에.
//   OD-U-01 거절한 카드의 프로세스: 하나 · 여럿(같은 카드에서 시작한 것은 빼고)
//   OD-U-02 반례 고르기: 「관계없어요」만 · 그 프로세스의 것만 · 최근 days 일 · 새것부터 · 같은 첫 줄은 하나 · negatives 개까지
//   OD-U-03 쉬기(셈 · 기간): 마지막 「관계없어요」와 그 앞 restWindowDays 일 안 restAfter 번 → restDays 일 · 모자라거나 흩어졌거나 지났으면 아님 · 설정으로 바뀜
//   OD-U-04 읽기: 쉬는 프로세스는 읽지 않고, 반례는 그 프로세스를 읽을 때만 요청 뒤에, 채팅 요청은 chatQuestion(메일은 그대로)
//   OD-U-05 직접 적은 까닭: 모델이 reasonMin 이상으로 읽은 것만 그 까닭, 아니면 · 못 읽으면 「다른 까닭」(반례 아님)
//   OD-U-06 이미 한 일: 파일을 만든 턴은 모델 없이 · 답은 모델이 done.min 이상일 때만 · 못 읽으면 평소대로(권함)
// 모델 없이(읽기를 대역으로). 사람 · 회사는 지어낸 것이다(정하윤 · 가나정밀).
import test from 'node:test'
import assert from 'node:assert/strict'
import { declinedProcs, negativesFor, restOf, forMatchingFrom, negativeText, readNote, declineRules, DECLINE_DEFAULTS } from '../lib/ontology/declines.js'
import { identify, turnDidWork } from '../lib/ontology/events.js'

const DAY = 86_400_000
const NOW = Date.parse('2026-11-28T12:00:00Z')
const ago = (d) => new Date(NOW - d * DAY).toISOString()
const GEN = { proc: 'p:gen', name: '요청 보고 · 구현' }
const EDU = { proc: 'p:edu', name: '교육 과정 설계 · 운영' }
const row = (request, daysAgo, reason, procs = [GEN], note = '') => ({ request, declined: { at: ago(daysAgo), reason, procs, ...(note ? { note } : {}) } })

test('OD-U-01 거절한 카드의 프로세스: 하나뿐이면 그것, 여럿이면 같은 카드에서 시작한 것을 뺀 나머지', () => {
  assert.deepEqual(declinedProcs({ choice: { proc: 'p:gen', procName: '요청 보고 · 구현' } }), [GEN])
  const many = { choice: { proc: 'p:gen', procName: '요청 보고 · 구현' }, choices: [{ proc: 'p:gen', procName: '요청 보고 · 구현' }, { proc: 'p:edu', procName: '교육 과정 설계 · 운영' }],
    starts: { 'p:edu': { caseId: 'c1' } } }
  assert.deepEqual(declinedProcs(many), [GEN])
  assert.deepEqual(declinedProcs({}), [])
})

test('OD-U-02 반례: 「관계없어요」만, 그 프로세스의 것만, 최근 30일, 새것부터, 같은 첫 줄은 하나, 4개까지', () => {
  const rows = [
    row('Spec Kit 기반 교육 과정 커리큘럼 설계해 줘\n자료는 드라이브에', 1, 'unrelated', [GEN], '교육 과정 설계지 요청 보고가 아니에요'),
    row('Spec Kit 기반 교육 과정 커리큘럼 설계해 줘', 2, 'unrelated'), // the same first line: once
    row('가나정밀 견적서 양식 정리해 줘', 3, 'not-now'), // 맞지만 이번엔 — not a negative
    row('사내 위키 목차 다시 짜 줘', 4, 'other'), // the model could not tell — not a negative
    row('워크숍 안내 메일 초안 써 줘', 5, 'unrelated', [EDU]), // another process's
    row('발표 슬라이드 다듬어 줘', 6, 'unrelated', [GEN, EDU]),
    row('팀 회고 정리해 줘', 10, 'unrelated'),
    row('주간 보고 표 만들어 줘', 20, 'unrelated'),
    row('예전 일 정리', 40, 'unrelated'), // older than 30 days
  ]
  const n = negativesFor(rows, 'p:gen', {}, NOW)
  assert.deepEqual(n.map((x) => x.request), ['Spec Kit 기반 교육 과정 커리큘럼 설계해 줘', '발표 슬라이드 다듬어 줘', '팀 회고 정리해 줘', '주간 보고 표 만들어 줘'])
  assert.equal(n[0].note, '교육 과정 설계지 요청 보고가 아니에요')
  assert.deepEqual(negativesFor(rows, 'p:edu', {}, NOW).map((x) => x.request), ['워크숍 안내 메일 초안 써 줘', '발표 슬라이드 다듬어 줘'])
  // settings: fewer days, fewer examples
  assert.deepEqual(negativesFor(rows, 'p:gen', { declines: { days: 7, negatives: 2 } }, NOW).map((x) => x.request), ['Spec Kit 기반 교육 과정 커리큘럼 설계해 줘', '발표 슬라이드 다듬어 줘'])
  // what the model reads: the intro with the process's name, then a line per request with its reason (the chip's words when nothing was typed)
  const text = negativeText({ name: '요청 보고 · 구현' }, n.slice(0, 2))
  assert.ok(text.startsWith('이 회사 사람들이 최근 「요청 보고 · 구현」 업무가 아니라고 한 채팅 요청이에요'))
  assert.ok(text.includes('- 「Spec Kit 기반 교육 과정 커리큘럼 설계해 줘」 — 교육 과정 설계지 요청 보고가 아니에요'))
  assert.ok(text.includes(`- 「발표 슬라이드 다듬어 줘」 — ${DECLINE_DEFAULTS.unrelatedText}`))
  assert.equal(negativeText({ name: 'x' }, []), '')
})

test('OD-U-03 쉬기: 마지막 「관계없어요」와 그 앞 14일 안에 3번이면 마지막 거절부터 7일 — 모자라거나 · 흩어졌거나 · 지났으면 아니다', () => {
  // three within 14 days, the last one 2 days ago → rests until 5 days from now
  const three = [row('a', 2, 'unrelated'), row('b', 6, 'unrelated'), row('c', 12, 'unrelated')]
  const r = restOf(three, 'p:gen', {}, NOW)
  assert.equal(r.count, 3)
  assert.equal(r.until, new Date(NOW + 5 * DAY).toISOString())
  // two only (a 「맞지만 이번엔」 and an 「다른 까닭」 do not count)
  assert.equal(restOf([row('a', 2, 'unrelated'), row('b', 3, 'unrelated'), row('c', 4, 'not-now'), row('d', 5, 'other')], 'p:gen', {}, NOW), null)
  // spread out: the third is 20 days before the last one
  assert.equal(restOf([row('a', 1, 'unrelated'), row('b', 3, 'unrelated'), row('c', 21, 'unrelated')], 'p:gen', {}, NOW), null)
  // over: the last of the three was 8 days ago (7 days of rest are done)
  assert.equal(restOf([row('a', 8, 'unrelated'), row('b', 9, 'unrelated'), row('c', 10, 'unrelated')], 'p:gen', {}, NOW), null)
  // another process's declines rest only that one
  assert.equal(restOf(three, 'p:edu', {}, NOW), null)
  // settings (events.declines): two are enough, three days of rest
  const s = restOf([row('a', 1, 'unrelated'), row('b', 2, 'unrelated')], 'p:gen', { declines: { restAfter: 2, restDays: 3 } }, NOW)
  assert.equal(s.until, new Date(NOW + 2 * DAY).toISOString())
  // restAfter 0 turns resting off
  assert.equal(restOf(three, 'p:gen', { declines: { restAfter: 0 } }, NOW), null)
  // one read of the rows gives both, per process
  const m = forMatchingFrom([...three, row('워크숍 안내', 3, 'unrelated', [EDU])], {}, NOW)
  assert.deepEqual([...m.resting.keys()], ['p:gen'])
  assert.deepEqual([...m.negatives.keys()].sort(), ['p:edu', 'p:gen'])
  assert.equal(declineRules({ declines: { restDays: 9 } }).restDays, 9)
  assert.equal(declineRules({}).restAfter, 3)
})

// a yes/no reader that says yes to a process unless the requests people declined for it are in what it reads
const P = (key, name, status = 'suggested', x = {}) => ({ key, name, status, kind: 'flow', cases: 5, tasks: [`${name} 일`], steps: ['요청방향 보고', '구현', '검토'], summary: '', ...x })
const GENP = P('p:gen', '요청 보고 · 구현', 'suggested', { summary: '고객 요청을 받아 방향을 보고하고 구현하는 일' })
const EDUP = P('p:edu', '교육 과정 설계 · 운영', 'suggested', { steps: ['과정 설계', '강사 섭외', '운영'] })
const QUOTE = P('p:quote', '견적 요청 처리', 'adopted', { steps: ['요청 검토', '견적서 작성'] })
const entryOf = async ({ procKey }) => ({ task: `${procKey}의 첫 일`, p: 0.8, ask: false, options: [{ task: `${procKey}의 첫 일`, p: 0.8 }], proc: procKey })
const chatEv = { kind: 'chat', subject: 'Spec Kit 기반 교육 과정 커리큘럼 설계해 줘', text: 'Spec Kit 기반 교육 과정 커리큘럼 설계해 줘. PMO 자료를 참고해서.' }

test('OD-U-04 읽기: 쉬는 프로세스는 읽지 않고, 반례는 그 프로세스를 읽을 때만, 채팅 요청은 「그 업무의 한 건인가」로 묻는다', async () => {
  const seen = []
  const yes = async (state, question) => {
    seen.push({ state, question })
    const isGen = question.includes('「요청 보고 · 구현」')
    // a model that takes the generic process for anything to make — until it sees the same kind of request declined for it
    if (isGen) return { p: state.includes('아니라고 한 채팅 요청') ? 0.2 : 0.9, measured: true }
    return { p: question.includes('「교육 과정 설계 · 운영」') ? 0.85 : 0.1, measured: true }
  }
  // no declines: the generic process says yes too
  const plain = await identify(chatEv, { procs: [QUOTE, GENP, EDUP], yes, entryOf })
  assert.deepEqual(plain.matches.map((m) => m.proc).sort(), ['p:edu', 'p:gen'])
  // the chat question: a process's own work, not its step names, and its description
  const q = seen.find((x) => x.question.includes('「요청 보고 · 구현」')).question
  assert.ok(q.startsWith('이 채팅 요청이 「요청 보고 · 구현」 업무의 한 건인가'), q)
  assert.ok(q.includes('무언가를 만들어 · 고쳐 · 정리해 · 보고해 달라는 것만으로는 아니다'), q)
  assert.ok(q.includes('업무 설명: 고객 요청을 받아 방향을 보고하고 구현하는 일'), q)
  assert.ok(q.includes('그 업무의 단계: 요청방향 보고 · 구현 · 검토'), q)

  // with this company's 「관계없어요」 declines of the generic process: they go with its reading only, and it says no
  seen.length = 0
  const declines = forMatchingFrom([row('Spec Kit 실습 과정 목차 짜 줘', 2, 'unrelated', [GEN], '교육 과정 설계예요')], {}, NOW)
  const r = await identify(chatEv, { procs: [QUOTE, GENP, EDUP], yes, entryOf, declines })
  assert.deepEqual(r.matches.map((m) => m.proc), ['p:edu'])
  const genRead = seen.find((x) => x.question.includes('「요청 보고 · 구현」'))
  assert.ok(genRead.state.includes('- 「Spec Kit 실습 과정 목차 짜 줘」 — 교육 과정 설계예요'), genRead.state)
  assert.ok(genRead.state.startsWith('회사에 들어온 요청'), 'the request first, then the declines')
  for (const x of seen.filter((y) => !y.question.includes('「요청 보고 · 구현」'))) assert.ok(!x.state.includes('아니라고 한 채팅 요청'), 'no other process reads them')
  assert.equal(r.reads.find((x) => x.proc === 'p:gen').negatives, 1)

  // declined as unrelated three times lately: the generic process rests — not read at all, and said so
  seen.length = 0
  const resting = forMatchingFrom([row('a', 1, 'unrelated'), row('b', 4, 'unrelated'), row('c', 9, 'unrelated')], {}, NOW)
  const r2 = await identify(chatEv, { procs: [QUOTE, GENP, EDUP], yes, entryOf, declines: resting })
  assert.ok(!seen.some((x) => x.question.includes('「요청 보고 · 구현」')))
  assert.deepEqual(r2.rested.map((x) => [x.proc, x.count]), [['p:gen', 3]])
  assert.deepEqual(r2.matches.map((m) => m.proc), ['p:edu'])

  // a mail is read with the old question (its step names), and no declines are given to it
  seen.length = 0
  await identify({ kind: 'mail', subject: '견적 부탁드립니다', text: '견적서 부탁드립니다' }, { procs: [QUOTE], yes, entryOf })
  assert.ok(seen[0].question.startsWith('이 메일이 회사에 해 달라고 하는 일'), seen[0].question)
})

test('OD-U-05 직접 적은 까닭: 모델이 0.7 이상으로 읽은 까닭만, 아니면 · 못 읽으면 「다른 까닭」', async () => {
  const at = (probabilities, strategy = 'logprob') => async (state, question, options) => {
    assert.ok(state.includes('거절하며 쓴 말: 교육 과정 설계지 요청 보고가 아니에요'), state)
    assert.ok(state.includes('「요청 보고 · 구현」'), state)
    assert.deepEqual(options.map((o) => o.key), ['unrelated', 'not-now', 'other'])
    return { probabilities, strategy }
  }
  const ask = { request: 'Spec Kit 기반 교육 과정 커리큘럼 설계해 줘', procs: [GEN], note: '교육 과정 설계지 요청 보고가 아니에요' }
  assert.equal((await readNote(ask, {}, at({ unrelated: 0.86, 'not-now': 0.1, other: 0.04 }))).reason, 'unrelated')
  assert.equal((await readNote(ask, {}, at({ unrelated: 0.08, 'not-now': 0.9, other: 0.02 }))).reason, 'not-now')
  // unsure: not a negative
  const unsure = await readNote(ask, {}, at({ unrelated: 0.55, 'not-now': 0.4, other: 0.05 }))
  assert.equal(unsure.reason, 'other')
  assert.equal(unsure.choice, 'unrelated')
  // nothing read (no model): not a negative
  assert.equal((await readNote(ask, {}, async () => { throw new Error('down') })).reason, 'other')
  assert.equal((await readNote(ask, {}, async () => null)).reason, 'other')
  // the bar is a setting
  assert.equal((await readNote(ask, { declines: { reasonMin: 0.5 } }, at({ unrelated: 0.55, 'not-now': 0.4, other: 0.05 }))).reason, 'unrelated')
})

test('OD-U-06 이미 한 일: 파일을 만든 턴은 모델 없이 「했음」, 답은 모델이 0.7 이상일 때만, 못 읽으면 평소대로 권한다', async () => {
  let calls = 0
  const never = async () => { calls++; return { p: 1, measured: true } }
  assert.deepEqual(await turnDidWork({ said: chatEv.text, answer: '만들었어요', made: 21 }, {}, never), { done: true, why: 'made', p: null })
  assert.equal(calls, 0)
  const reader = (p) => async (state, question) => {
    assert.ok(state.includes('채팅에 쓴 요청: Spec Kit 기반 교육 과정'), state)
    assert.ok(state.includes('그 요청에 한 답(앞부분): 커리큘럼을 짰어요'), state)
    assert.ok(question.startsWith('이 답이 요청한 일을 이미 해 냈나'), question)
    return { p, measured: true }
  }
  assert.equal((await turnDidWork({ said: chatEv.text, answer: '커리큘럼을 짰어요. 1주차 …', made: 0 }, {}, reader(0.92))).done, true)
  assert.equal((await turnDidWork({ said: chatEv.text, answer: '커리큘럼을 짰어요? 어느 자료를 볼까요?', made: 0 }, {}, reader(0.3))).done, false)
  // nothing read: the usual path (the card is offered)
  assert.equal((await turnDidWork({ said: chatEv.text, answer: '커리큘럼을 짰어요', made: 0 }, {}, async () => { throw new Error('down') })).done, false)
  assert.equal((await turnDidWork({ said: chatEv.text, answer: '커리큘럼을 짰어요', made: 0 }, {}, async () => ({ p: null, measured: false }))).done, false)
  // no answer text
  assert.equal((await turnDidWork({ said: chatEv.text, answer: '', made: 0 }, {}, never)).done, false)
  // the bar is a setting
  assert.equal((await turnDidWork({ said: chatEv.text, answer: '커리큘럼을 짰어요', made: 0 }, { done: { min: 0.95 } }, reader(0.92))).done, false)
})
