// Fixes from the English tutorial capture and product-video recordings, second round (i18n/CAPTURE-LOG.md,
// 2026-10-29), each checked in Korean and English — no database, no model (the translation is stubbed):
//   - which registered process a team-room request starts is the judge's pick among the registered
//     processes, never a match of words against names (team/assist.js classify — 2026-11-21 skill routing)
//   - the skill test step's outputs (<room>/.skill-evals/…) that an answer lists are no file cards (agent.js evalRun)
//   - a request in Japanese (any language) goes to the judge as written; only its format keeps a message
//     out (emoji, jamo, a bare link) — team/assist.js formatGate
//   - an agent's row in a room and a meeting result name whose agent it is in the reader's language, not
//     the starter's (team/messenger.js view, meetings/materials.js reasonFor)
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { startJudge } from './fixtures/judgeStub.mjs'

// the judge's answers come from the test (a stand-in judge server); the modules read PRO_JUDGE_URL on import
let answer = () => 'none'
const J = await startJudge((body, n) => answer(body, n))
process.env.PRO_JUDGE_URL = J.url
after(() => J.close())
const A = await import('../lib/team/assist.js')
const { offers } = await import('../lib/offers.js')
const { evalRun, generationArtifact } = await import('../lib/agent.js')
const M = await import('../lib/team/messenger.js')
const { reasonFor } = await import('../lib/meetings/materials.js')
const TR = await import('../lib/translate.js')
const { withLang } = await import('../lib/lang.js')
const en = (fn) => withLang('en', fn)
const ko = (fn) => withLang('ko', fn)

test('room assist: the registered process a request starts is the judge\'s pick; no process fits → a lookup', async () => {
  const procs = [{ id: 'p-travel', name: 'Travel expense settlement' }, { id: 'p-leave', name: '휴가 신청' }, { id: 'p-buy', name: 'Purchase request approval' }]
  const opts = await en(() => offers('team'))
  // 1st call: which offer; 2nd: which process (the options are the registered names, as given)
  answer = (body, n) => (n === 1 ? 'StartProcessInstance' : 'p-travel')
  J.calls.length = 0
  const r = await en(() => A.classify(['Kim: I spent two nights in the field office'], 'can you file the claim for those nights?', { offers: opts, processes: async () => procs }))
  assert.equal(r.work, 'StartProcessInstance')
  assert.equal(r.proc.id, 'p-travel')
  assert.equal(r.title, 'Start Travel expense settlement')
  assert.deepEqual(J.calls[1].options.map((o) => o.key), ['none', 'p-travel', 'p-leave', 'p-buy'])
  assert.deepEqual(J.calls[1].options.slice(1).map((o) => o.label), procs.map((x) => x.name), 'the names are shown, not matched')
  // the judge finds no registered process for it: the agent answers it instead
  answer = (body, n) => (n % 2 === 1 ? 'StartProcessInstance' : 'none')
  J.calls.length = 0
  const n = await en(() => A.classify([], 'start whatever we use for this', { offers: opts, processes: async () => procs }))
  assert.equal(n.work, 'CompanyQuery')
  // a sheet the judge picked stays a sheet when no process is meant
  answer = (body, k) => (k === 1 ? 'CreateSpreadsheet' : 'none')
  J.calls.length = 0
  const t = await ko(() => A.classify([], '다음 분기 부서별 예산을 한 장으로 볼 수 있게 해 줄래요', { offers: offers('team'), processes: async () => procs }))
  assert.equal(t.work, 'CreateSpreadsheet')
  assert.equal(t.title, '표 초안 만들기', 'no title from the judge server: the offer\'s own title')
})

test('room assist: unsure or none from the judge is no card; the options are the offer skills plus none', async () => {
  answer = () => ['CreateDocument', 0.4]
  J.calls.length = 0
  const r = await ko(() => A.classify([], '이번 주 안에 정리해야 할 것 같긴 한데', { processes: async () => [] }))
  assert.deepEqual([r.none, r.why], [true, 'judge-unsure'])
  const keys = J.calls[0].options.map((o) => o.key)
  assert.equal(keys[0], 'none')
  for (const k of keys.slice(1)) assert.ok(offers('team').some((o) => o.key === k), k)
  answer = () => 'none'
  assert.equal((await ko(() => A.classify([], '오늘 다들 고생 많았어요', { processes: async () => [] }))).why, 'judge-none')
})

test('process chat: the skill test step files an answer names are not file cards', () => {
  const ROOM = '/workspace/.bpmn/c42b3fc044bb4463b7ca3fc7e5665a5c'
  // the four floor plans of the recording (CAPTURE-LOG 15:45), named in the answer's text
  for (const p of [`${ROOM}/.skill-evals/floor-plan-cad/iteration-1/basic-store-floor-plan/with_skill/outputs/floor-plan.dxf`,
    `${ROOM}/.skill-evals/floor-plan-cad/iteration-1/basic-store-floor-plan/without_skill/outputs/moonlight_coffee_floor_plan.dxf`,
    `${ROOM}/.skill-evals/floor-plan-cad/iteration-1/revised-floor-plan-with-notes/with_skill/outputs/Moonlight Coffee revised floor plan.dxf`,
    `${ROOM}/.skill-evals/floor-plan-cad/iteration-1/revised-floor-plan-with-notes/without_skill/outputs/floor-plan.dxf`]) {
    assert.equal(evalRun(p), true, p)
    assert.equal(generationArtifact(p).evalRun, true)
  }
  // the turn's own outputs stay cards
  for (const p of [`${ROOM}/Moonlight Coffee floor plan.dxf`, `${ROOM}/process-6c8bf96/forms/quote.form`, '/workspace/11월 고객 세미나 예산표.xlsx', `${ROOM}/skills-evals.xlsx`]) assert.equal(evalRun(p), false, p)
})

test('room assist: a message in any language goes to the judge as written; only its format keeps one out', async () => {
  for (const [t, why] of [['', 'empty'], ['👍👍👍', 'emoji'], ['ㅋㅋㅋㅋ', 'emoji'], ['ㅠㅠ!!', 'emoji'], ['https://example.com/deck', 'link'], ['네', 'short']]) assert.equal(A.formatGate(t).why, why, t)
  for (const t of ['見積書を作ってもらえますか？', '了解', 'ok', '¿Puedes preparar el presupuesto?', '요약?']) assert.equal(A.formatGate(t).pass, true, t)
  answer = () => 'CreateSpreadsheet'
  J.calls.length = 0
  const JA = '来月の展示会の費用、表にまとめてもらえますか'
  const r = await en(() => A.classify(['Sato: 展示会の件です'], JA, { processes: async () => [] }))
  assert.equal(r.work, 'CreateSpreadsheet')
  assert.ok(J.calls[0].state.includes(JA), 'the judge reads the message itself, not a translation')
  assert.ok(J.calls[0].state.startsWith('Earlier messages:\nSato: 展示会の件です\n\nNew message:'))
})

test("team rooms: an agent's row names whose agent in the reader's language", () => {
  const row = (byName) => ({ uuid: 'u1', id: 'r1', messages: { role: 'assistant', email: 'agent:process-gpt-agent', userName: 'Process GPT Agent', content: 'Done.', timeStamp: new Date().toISOString(), pgpt: { kind: 'agent', by: 'y1', byName } } })
  const members = { 'pro-rt-yuki@uengine.org': { id: 'y1', name: '사토 유키' } }
  // stored by an English-screen starter, read on a Korean screen (the recording's "사토 유키's agent")
  assert.equal(ko(() => M.view('v', row("사토 유키's agent"), members)).sender.name, '사토 유키님의 에이전트')
  assert.equal(en(() => M.view('v', row('사토 유키님의 에이전트'), members)).sender.name, "사토 유키's agent")
  // the room's members unknown (an old row): the name from the stored words
  assert.equal(ko(() => M.view('v', row("Yuki Sato's agent"), {})).sender.name, 'Yuki Sato님의 에이전트')
  assert.equal(en(() => M.view('v', row('장진영님의 에이전트'), {})).sender.name, "장진영's agent")
  // no owner at all (process-gpt's own agent): as written
  const plain = row(undefined); delete plain.messages.pgpt.by
  assert.equal(ko(() => M.view('v', plain, {})).sender.name, 'Process GPT Agent')
  // a person's own message is untouched
  const mine = { uuid: 'u2', id: 'r1', messages: { role: 'user', email: 'pro-rt-yuki@uengine.org', userName: '사토 유키', userId: 'y1', content: 'hi' } }
  assert.equal(en(() => M.view('v', mine, members)).sender.name, '사토 유키')
})

test("meetings: an agent's result names whose agent in the reader's language", () => {
  const mat = (reason) => ({ kind: 'result', reason, by_agent: true })
  assert.equal(ko(() => reasonFor(mat("Made by Jinyoung Jang's agent"))), 'Jinyoung Jang님의 에이전트가 만들었어요')
  assert.equal(en(() => reasonFor(mat('장진영님의 에이전트가 만들었어요'))), "Made by 장진영's agent")
  assert.equal(en(() => reasonFor(mat("Made by Jinyoung Jang's agent"))), "Made by Jinyoung Jang's agent")
  // other materials keep what the helper wrote
  assert.equal(ko(() => reasonFor({ kind: 'file', reason: '견적서 이야기가 나와서' })), '견적서 이야기가 나와서')
  assert.equal(ko(() => reasonFor({ kind: 'file', reason: null })), null)
})
