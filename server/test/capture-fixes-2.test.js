// Fixes from the English tutorial capture and product-video recordings, second round (i18n/CAPTURE-LOG.md,
// 2026-10-29), each checked in Korean and English — no database, no model (the translation is stubbed):
//   - a team-room message is a process's start card only when it names the process: whole words, not
//     function words, a meaningful part of the name; Korean as before (team/assist.js processMatch)
//   - the skill test step's outputs (<room>/.skill-evals/…) that an answer lists are no file cards (agent.js evalRun)
//   - a request in Japanese (any main language but Korean or English) is read through its translation, not
//     dropped by the Korean/English word rules (team/assist.js prefilter, otherLang, readable)
//   - an agent's row in a room and a meeting result name whose agent it is in the reader's language, not
//     the starter's (team/messenger.js view, meetings/materials.js reasonFor)
import test from 'node:test'
import assert from 'node:assert/strict'

const A = await import('../lib/team/assist.js')
const { evalRun, generationArtifact } = await import('../lib/agent.js')
const M = await import('../lib/team/messenger.js')
const { reasonFor } = await import('../lib/meetings/materials.js')
const TR = await import('../lib/translate.js')
const { withLang } = await import('../lib/lang.js')
const en = (fn) => withLang('en', fn)
const ko = (fn) => withLang('ko', fn)

test('room assist: an English message names a process only by whole, meaningful words of its name', () => {
  // what the recordings got "Start …" cards for (CAPTURE-LOG 12:19, the room suggestions of en-demo)
  const no = [
    ['Could you also look at an option that moves the bar counter to the window side on the floor plan? The owner wants window seats.', 'Moonlight Coffee proposal'],
    ["Here's the Store #2 quote. Please check that the total including VAT and the per-㎡ unit price assumptions are right.", 'Supplier catalog price survey'],
    ["Here are the quote and the floor plan I made after last week's Moonlight Coffee meeting. Let's go over them in the meeting.", 'Moonlight Coffee proposal'],
    ['Can you put together the notice on the opening schedule?', 'Moonlight Coffee New Store Proposal'],
    ['Could you write a proposal for the client?', 'Moonlight Coffee proposal'],
  ]
  for (const [b, n] of no) assert.equal(A.processMatch(b, n), false, `${b.slice(0, 40)} → ${n}`)
  const yes = [
    ['Can you start the Moonlight Coffee proposal for Store #3?', 'Moonlight Coffee proposal'],
    ['Please start a travel expense settlement for my Busan trip', 'Travel expense settlement'],
    ['I need to settle my travel expenses from Busan', 'Travel expense settlement'],
    ['Start the travel expense process for the Busan trip, please', 'Travel expense settlement'],
    ['Could you run the daily SNS trend response now?', 'Daily SNS trend response'],
    ['Moonlight Coffee proposal 시작해 주세요', 'Moonlight Coffee proposal'],
  ]
  for (const [b, n] of yes) assert.equal(A.processMatch(b, n), true, `${b.slice(0, 40)} → ${n}`)
})

test('room assist: a Korean message matches process names exactly as before', () => {
  const before = (body, name) => body.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2).some((w) => name.includes(w))
  const names = ['휴가 신청', '출장비 정산', '달빛커피 제안 프로세스', '공급사 카탈로그 가격 조사', '일일 SNS 트렌드 대응']
  const bodies = ['휴가 신청 좀 올려줄래요?', '출장비 정산해 주세요', '달빛커피 제안서 견적 만들어 줄 수 있어요?', '공급사 가격 조사 부탁해요', '점심 뭐 먹을까요', '견적서 초안 만들어 줄 수 있어요?', '오늘 SNS 트렌드 정리해줘']
  for (const b of bodies) for (const n of names) assert.equal(A.processMatch(b, n), before(b, n), `${b} → ${n}`)
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

test('room assist: a request in Japanese (or another main language) goes to its translation, Korean and English as before', () => {
  for (const t of ['見積書を作ってもらえますか？照明の費用も入れてください。', '照明プランを木曜までにまとめてください', '见积单请做一下，谢谢', 'Пожалуйста, подготовьте смету'])
    assert.deepEqual(A.prefilter(t), { pass: false, why: 'other-lang', translate: true }, t)
  // a Latin-script language needs its writer's main language to tell it from English
  assert.equal(A.prefilter('¿Puedes preparar el presupuesto para la tienda?', 'es').translate, true)
  assert.equal(A.prefilter('Could you draft the quote for the store?', 'ja').pass, true, 'English from a Japanese teammate is read as English')
  assert.equal(A.prefilter('了解', 'ja').why, 'short')
  assert.equal(A.prefilter('👍👍👍👍', 'ja').why, 'emoji')
  // unchanged: Korean and English rules
  assert.equal(A.prefilter('견적서 초안 만들어 줄 수 있어요?').pass, true)
  assert.equal(A.prefilter('점심 뭐 먹을까요 다들').why, 'smalltalk')
  assert.equal(A.prefilter('Can you draft the quote for Moonlight Coffee Store #2?').pass, true)
  assert.equal(A.prefilter('heading home now, see you tomorrow').why, 'no-work')
})

test('room assist: the translation is what the rules read, in the language of the card', async () => {
  const prev = process.env.PRO_TRANSLATE
  process.env.PRO_TRANSLATE = '1'
  TR.setDb(false)
  TR._cache.clear()
  const asked = []
  TR.setModelCall(async ({ text, to }) => { asked.push(to); return { text: to === 'en' ? 'Could you make the quote? Please include the lighting costs.' : '견적서 만들어 줄 수 있어요? 조명 비용도 넣어 주세요.', lang: 'ja', ms: 5, model: 'fake' } })
  try {
    if (!TR.enabled()) return // no OpenAI key here: readable() is null and the message is left alone (no card)
    const JA = '見積書を作ってもらえますか？照明の費用も入れてください。'
    const e = await en(() => A.readable(JA, { hint: 'ja' }))
    assert.equal(A.prefilter(e).pass, true, e)
    const k = await ko(() => A.readable(JA, { hint: 'ja' }))
    assert.equal(A.prefilter(k).pass, true, k)
    assert.deepEqual(asked, ['en', 'ko'])
    // the model failed: no card rather than a guess
    TR._cache.clear()
    TR.setModelCall(async () => { throw new Error('translate 500') })
    assert.equal(await en(() => A.readable(JA, { hint: 'ja' })), null)
  } finally {
    TR.setModelCall(null); TR.setDb(true); TR._cache.clear()
    if (prev == null) delete process.env.PRO_TRANSLATE; else process.env.PRO_TRANSLATE = prev
  }
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
