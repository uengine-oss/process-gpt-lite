// 계획 카드와 진행 상황 (lib/turnPlan.js · lib/agent.js routeTurn, design turnplan P0 · 스펙 openspec/specs/turn-plan).
// 가짜 OpenAI 형식 서버로 — 실제 모델 없이:
//   TP-U-01 앞단 계획 JSON(울타리째 와도) · 계획이 아닌 답은 버림
//   TP-U-02 4초 안에 계획이 오지 않으면 null, 카드는 「요청을 받았어요. 바로 살펴볼게요.」
//   TP-U-03 앞단 모델과 빠른 모델의 경주: 오류 → 빠른 모델, 2.5초 넘게 조용 → 빠른 모델도, 먼저 온 쪽, 같은 모델이면 두 번 묻지 않음
//   TP-U-04 언어: 앞단 호출이 사람의 언어를 말함(한국어 모드 · 영어 모드), 에이전트에게 가는 한국어 지시 · 계획 블록
//   TP-U-05 라우터: 6초를 넘기거나 오류 · JSON 이 아닌 인자면 null(→ 에이전트), DELEGATE 는 call 없음, 도구는 그대로
//   TP-U-06 중간 글: 짧은 글 뒤 도구 → 메모(답 아님), 200자 넘으면 답으로 흘리다가 도구가 오면 거둠(retract)
//   TP-U-07 plan_todos → [{id, text, state}]
//   TP-U-08 GET /api/threads/:id/turn: 진행 중인 턴의 계획 · 단계 · 할 일 · 한 일 · 메모, 다른 사람은 못 봄
//   TP-U-09 최근 작업 카드 한 줄: NotebookLM 카드가 있는 대화에서 「이제 아까 만들기로 한 노트북 만들자」 → 라우터 프롬프트에 그 카드 줄
//   TP-U-10 멈추기가 앞 단계(라우터 전)의 턴에 닿고, 줄 서서 기다리는 턴은 그대로
//   cd server && node --test test/turnPlan.test.js
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import express from 'express'

// ---- a fake OpenAI-style server: each test says how it answers (respond(body) → {delay, status, content, tool_calls}) ----
const calls = []
let respond = () => ({ content: '{}' })
const server = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (d) => { raw += d })
  req.on('end', async () => {
    const b = JSON.parse(raw || '{}')
    const at = Date.now()
    calls.push({ model: b.model, body: b, at })
    const r = (await respond(b)) || {}
    let closed = false
    res.on('close', () => { closed = true })
    if (r.delay) await new Promise((ok) => setTimeout(ok, r.delay))
    if (closed) return
    if (r.status && r.status !== 200) { res.writeHead(r.status, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message: r.error || 'boom' } })) }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    // (an odds reading: the first token's candidates — the letter r.content with 0.9, the next letter with 0.05)
    const lp = r.logprobs ? { logprobs: { content: [{ token: r.content, logprob: Math.log(0.9), top_logprobs: [{ token: r.content, logprob: Math.log(0.9) }, { token: r.content === 'A' ? 'B' : 'A', logprob: Math.log(0.05) }] }] } } : {}
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: r.content ?? null, ...(r.tool_calls ? { tool_calls: r.tool_calls } : {}) }, finish_reason: 'stop', ...lp }] }))
  })
})
const planJson = (o = {}) => JSON.stringify({ understood: '링크의 글을 읽고 요약해 드릴게요.', steps: ['글 열기', '핵심 정리', '요약 전달'], tier: 'light', certainty: 'sure', ...o })

let TP, A, T, lang, bus
before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  process.env.PRO_LLM_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`
  process.env.PRO_LLM_API_KEY = 'test'
  process.env.PRO_LLM_FAST_MODEL = 'fast-m'
  process.env.PRO_LLM_FRONT_MODEL = 'front-m'
  process.env.PRO_LLM_KEYS = 'off'
  // (the router's hints read the database and the catalogue: not what these tests are about)
  process.env.PRO_ROUTER_HINT_MS = '200'
  process.env.PRO_DEEPAGENTS_URL = 'http://127.0.0.1:9'
  TP = await import('../lib/turnPlan.js')
  A = await import('../lib/agent.js')
  T = await import('../lib/turns.js')
  lang = await import('../lib/lang.js')
  bus = await import('../lib/bus.js')
})
after(async () => {
  server.close()
  const { pool } = await import('../lib/supa.js')
  await pool.end().catch(() => {})
  const { closeOntology } = await import('../lib/ontology/store.js')
  await closeOntology().catch(() => {})
})

test('TP-U-01 앞단 계획: JSON(울타리째)을 읽고, 계획이 아닌 답은 버린다', async () => {
  respond = () => ({ content: '```json\n' + planJson({ steps: ['글 열기', '  핵심   정리 ', '요약 전달', '다시 확인', '다섯째'] }) + '\n```' })
  const p = await TP.frontPlan({ text: 'https://medium.com/@a/why-plans-1' })
  assert.equal(p.understood, '링크의 글을 읽고 요약해 드릴게요.')
  assert.deepEqual(p.steps.map((s) => s.text), ['글 열기', '핵심 정리', '요약 전달', '다시 확인'], '2–4 steps, tidied')
  assert.deepEqual(p.steps.map((s) => s.id), ['p1', 'p2', 'p3', 'p4'])
  assert.equal(p.tier, 'light')
  assert.equal(p.certainty, 'sure')
  assert.equal(p.model, 'front-m')
  const sent = calls.at(-1).body
  assert.equal(sent.model, 'front-m')
  assert.deepEqual(sent.response_format, { type: 'json_object' })
  assert.deepEqual(sent.chat_template_kwargs, { enable_thinking: false }, 'think:false')
  assert.equal(sent.max_tokens, 400)
  // not a plan
  assert.equal(TP.readPlan('{"steps": ["a"]}'), null)
  assert.equal(TP.readPlan('DELEGATE'), null)
  assert.deepEqual(TP.readPlan({ understood: 'x', steps: 'no', tier: 'huge', certainty: '?' }), { understood: 'x', steps: [], tier: 'standard', certainty: 'likely' })
})

test('TP-U-02 4초 안에 계획이 없으면 null, 카드는 「요청을 받았어요. 바로 살펴볼게요.」 (턴은 이어감)', async () => {
  respond = () => ({ delay: 9000, content: planJson() })
  const t0 = Date.now()
  const p = await TP.frontPlan({ text: '이 링크 봐 줘 https://example.com/slow' })
  const ms = Date.now() - t0
  assert.equal(p, null)
  assert.ok(ms >= 3900 && ms < 4800, `ended at the 4 s limit (${ms} ms)`)
  assert.equal(TP.FRONT_MS, 4000)
  assert.equal(TP.HEDGE_MS, 2500)
  // the turn's view: turn.plan with the fallback sentence, no steps
  const seen = []
  const userId = `u-fb-${Date.now()}`
  const off = bus.subscribe(userId, { write: (line) => seen.push(line) })
  const turn = T.enqueue({ userId, threadId: '00000000-0000-0000-0000-000000000001' })
  const v = TP.begin({ turn, userId, threadId: turn.threadId, msgId: 'm1', text: '이 링크 봐 줘 https://example.com/slow' })
  const plan = await v.ready
  off()
  assert.equal(plan.source, 'fallback')
  assert.equal(plan.understood, '요청을 받았어요. 바로 살펴볼게요.')
  assert.deepEqual(plan.steps, [])
  const evs = seen.map((l) => /^event: (.*)$/m.exec(l)[1])
  assert.deepEqual(evs.slice(0, 2), ['turn.start', 'turn.stage'])
  assert.ok(evs.includes('turn.plan'))
  assert.equal(await TP.planBlock(turn), '', 'the agent is told no plan after a fallback')
  assert.equal(TP.saved(turn, 'done').plan.source, 'fallback')
  TP.end(turn, 'done')
  turn.finish()
})

test('TP-U-03 경주: 앞단 모델 오류 → 빠른 모델 · 2.5초 조용 → 빠른 모델도 · 먼저 온 쪽 · 같은 모델이면 한 번만 · 둘 다 실패 → null', async () => {
  // (a) the front model errors: the fast model is asked at once, and its plan is taken
  respond = (b) => (b.model === 'front-m' ? { status: 500 } : { content: planJson({ understood: '빠른 모델의 계획' }) })
  let t0 = Date.now()
  let n0 = calls.length
  let p = await TP.frontPlan({ text: 'a' })
  assert.equal(p.model, 'fast-m')
  assert.equal(p.hedge, 'error')
  assert.ok(Date.now() - t0 < 1500, 'no wait for the hedge timer after an error')
  assert.deepEqual(calls.slice(n0).map((c) => c.model), ['front-m', 'fast-m'])

  // (b) the front model is slow: at 2.5 s the fast model is asked too, and answers first
  respond = (b) => (b.model === 'front-m' ? { delay: 3500, content: planJson({ understood: '앞단' }) } : { delay: 200, content: planJson({ understood: '빠른' }) })
  t0 = Date.now(); n0 = calls.length
  p = await TP.frontPlan({ text: 'b' })
  const ms = Date.now() - t0
  assert.equal(p.model, 'fast-m')
  assert.equal(p.understood, '빠른')
  assert.equal(p.hedge, 'slow')
  assert.ok(ms >= 2600 && ms < 3400, `fast model answered after the hedge (${ms} ms)`)
  const fastCall = calls.slice(n0).find((c) => c.model === 'fast-m')
  assert.ok(fastCall.at - t0 >= 2400, 'the fast model is asked only after 2.5 s')

  // (c) the front model answers after the hedge started but before the fast one: the front plan wins
  respond = (b) => (b.model === 'front-m' ? { delay: 2800, content: planJson({ understood: '앞단 먼저' }) } : { delay: 1500, content: planJson({ understood: '늦은 빠른' }) })
  p = await TP.frontPlan({ text: 'c' })
  assert.equal(p.model, 'front-m')
  assert.equal(p.understood, '앞단 먼저')

  // (d) no front model of its own (front = fast): a slow call is not asked twice; an error is retried once
  respond = () => ({ delay: 3000, content: planJson({ understood: '하나뿐' }) })
  n0 = calls.length
  p = await TP.frontPlan({ text: 'd', front: 'fast-m', fast: 'fast-m' })
  assert.equal(p.understood, '하나뿐')
  assert.equal(calls.slice(n0).length, 1)
  let k = 0
  respond = () => (k++ === 0 ? { status: 500 } : { content: planJson({ understood: '다시 물어 받음' }) })
  p = await TP.frontPlan({ text: 'e', front: 'fast-m', fast: 'fast-m' })
  assert.equal(p.understood, '다시 물어 받음')

  // (e) both fail: null (the card then shows the fallback sentence)
  respond = () => ({ status: 500 })
  assert.equal(await TP.frontPlan({ text: 'f' }), null)
  respond = () => ({ content: 'not json' })
  assert.equal(await TP.frontPlan({ text: 'g' }), null)
})

test('TP-U-04 언어: 앞단 호출은 사람의 언어를(말이 없으면 화면 언어), 에이전트에게는 한국어 모드에서도 언어 지시와 계획', async () => {
  respond = () => ({ content: planJson() })
  // Korean mode: the rule names the message's language, and Korean when the message has no words (a link)
  await TP.frontPlan({ text: 'https://medium.com/@a/b' })
  let sys = calls.at(-1).body.messages[0].content
  assert.match(sys, /language of the person's message/)
  assert.match(sys, /only a link, a file or an attachment\), write them in Korean/)
  assert.ok(!/LANGUAGE: English/.test(sys))
  // English mode: English, and the English note every call carries
  await lang.withLang('en', () => TP.frontPlan({ text: 'https://medium.com/@a/b' }))
  sys = calls.at(-1).body.messages[0].content
  assert.match(sys, /Write "understood" and "steps" in English/)
  assert.match(sys, /LANGUAGE: English/)
  // the agent's message: a Korean instruction in Korean mode too when the message is a link alone (no language of its own);
  // a message with words keeps its own (review 11-25 #6 — TP-R-06)
  assert.match(lang.langInstruction({ said: 'https://medium.com/@a/b' }), /\[Instruction\] 언어: 한국어/)
  assert.match(lang.langInstruction({ said: 'https://medium.com/@a/b' }), /말이 없어\(링크나 파일뿐\)/)
  assert.match(lang.withLang('en', () => lang.langInstruction()), /LANGUAGE: English/)
  // the plan block (§1.4) after the message, in the person's language
  const userId = `u-pb-${Date.now()}`
  const turn = T.enqueue({ userId, threadId: '00000000-0000-0000-0000-000000000002' })
  const v = TP.begin({ turn, userId, threadId: turn.threadId, msgId: 'm2', text: 'https://medium.com/@a/b' })
  await v.ready
  const block = await TP.planBlock(turn)
  assert.match(block, /^\n\n\[계획\] 링크의 글을 읽고 요약해 드릴게요\.\n1\. 글 열기\n2\. 핵심 정리\n3\. 요약 전달\n/)
  // (no tool named that the agent may not have — production deepagents has no write_todos; the rule for leaving the plan names its tool)
  assert.doesNotMatch(block, /write_todos/)
  assert.match(block, /할 일 목록 도구가 있으면 이 계획을 먼저 기록하고\(다듬어도 됩니다\), 없으면 그냥 진행하세요 — 기록 도구가 없는 것은 계획에서 벗어난 것이 아닙니다\./)
  assert.ok(block.endsWith(`\n${TP.OFF_PLAN_KO}`), 'the agreement for leaving the plan comes last, on its own line')
  assert.match(TP.OFF_PLAN_KO, /다른 것으로 대신하지 마세요\. request_human_input 도구로 무슨 일이 있었는지, 왜 계획대로 못 하는지, 고를 수 있는 길 2~3가지를 알리고 답을 기다리세요\./)
  assert.match(block, /요청하지 않은 결과물은 만들지 마세요/)
  TP.end(turn, 'done'); turn.finish()
  const t2 = T.enqueue({ userId, threadId: '00000000-0000-0000-0000-000000000002' })
  const en = await lang.withLang('en', async () => { const v2 = TP.begin({ turn: t2, userId, threadId: t2.threadId, msgId: 'm3', text: 'x' }); await v2.ready; return TP.planBlock(t2) })
  assert.match(en, /^\n\n\[Plan\] .*\n1\. /)
  assert.match(en, /Do only this plan\. If you have a to-do list tool, record this plan with it first \(you may refine it\); if not, just go ahead — not having one is not a departure from the plan\.\nDo not produce deliverables that were not asked for/)
  assert.doesNotMatch(en, /write_todos/)
  assert.ok(en.endsWith(`\n${TP.OFF_PLAN_EN}`))
  assert.match(TP.OFF_PLAN_EN, /do not substitute something else\. Call the request_human_input tool: say what happened, why the plan cannot be followed, and 2-3 options/)
  TP.end(t2, 'done'); t2.finish()
})

test('TP-U-11 약속: 혼자 도는 습관 실행(ask:false)에는 계획만 · 묻는 도구는 이름으로 알아본다(검토 #136-1 · 2)', async () => {
  const userId = `u-pb2-${Date.now()}`
  const turn = T.enqueue({ userId, threadId: '00000000-0000-0000-0000-000000000002' })
  const v = TP.begin({ turn, userId, threadId: turn.threadId, msgId: 'm4', text: 'https://medium.com/@a/b' })
  await v.ready
  const plain = await TP.planBlock(turn, { ask: false })
  assert.match(plain, /^\n\n\[계획\] /)
  assert.ok(!plain.includes('계획대로 할 수 없을 때'), 'nobody there to answer: no agreement to ask')
  assert.ok(plain.endsWith('더 하면 좋을 일이 있으면 끝에 말로 제안하세요.'))
  assert.ok((await TP.planBlock(turn)).endsWith(`\n${TP.OFF_PLAN_KO}`), 'the default carries it')
  TP.end(turn, 'done'); turn.finish()
  for (const t of ['request_human_input', 'REQUEST_HUMAN_INPUT', ' request_human_input ']) assert.equal(TP.asksPerson(t), true, t)
  for (const t of ['request_human', 'drive_search', '', null, undefined]) assert.equal(TP.asksPerson(t), false, String(t))
})

const user = { id: '00000000-0000-0000-0000-0000000000aa', name: '시험' }
const session = { access_token: 'test' }
const hist = [{ role: 'user', content: 'https://example.com/a' }]

test('TP-U-05 라우터: 6초 넘으면 · 오류면 · 인자가 JSON 이 아니면 null(→ 에이전트), DELEGATE · 도구는 그대로', async () => {
  assert.equal(A.ROUTER_MS, 6000)
  // passes 6 s (the judge reads no tool in it: not asked again — TP-R-08 has the other cases)
  respond = () => ({ delay: 9000, content: 'DELEGATE' })
  const noTool = async () => ({ probabilities: { tool: 0.05, agent: 0.95 }, choice: 'agent' })
  let t0 = Date.now()
  let r = await A.routeTurn({ user, session, hist, now: 'now', judge: noTool })
  const ms = Date.now() - t0
  assert.equal(r, null)
  assert.ok(ms >= 6000 && ms < 7300, `gave up at about 6 s (${ms} ms)`)
  const sent = calls.at(-1).body
  assert.equal(sent.model, 'fast-m')
  // (the router keeps thinking: without it frentis routed a link alone to browser_task — see routeTurn)
  assert.equal(sent.chat_template_kwargs, undefined)
  assert.equal(sent.max_tokens, 1500)
  // throws
  respond = () => ({ status: 500 })
  t0 = Date.now()
  assert.equal(await A.routeTurn({ user, session, hist, now: 'now' }), null)
  assert.ok(Date.now() - t0 < 2000)
  // arguments that are not JSON
  respond = () => ({ tool_calls: [{ id: 'c1', type: 'function', function: { name: 'browser_task', arguments: '{"goal": "x", ' } }] })
  assert.equal(await A.routeTurn({ user, session, hist, now: 'now' }), null)
  // DELEGATE and a tool
  respond = () => ({ content: 'DELEGATE' })
  assert.deepEqual(await A.routeTurn({ user, session, hist, now: 'now' }), { call: null, args: {} })
  respond = () => ({ tool_calls: [{ id: 'c2', type: 'function', function: { name: 'add_action', arguments: '{"verb":"Remind","text":"x","ack":"네"}' } }] })
  r = await A.routeTurn({ user, session, hist, now: 'now' })
  assert.equal(r.call.function.name, 'add_action')
  assert.deepEqual(r.args, { verb: 'Remind', text: 'x', ack: '네' })
  // 멈추기 (the turn's signal) while it runs: null at once, no fallback log
  respond = () => ({ delay: 5000, content: 'DELEGATE' })
  const ac = new AbortController()
  setTimeout(() => ac.abort(), 200)
  t0 = Date.now()
  assert.equal(await A.routeTurn({ user, session, hist, now: 'now', signal: ac.signal }), null)
  assert.ok(Date.now() - t0 < 1500)
})

test('TP-U-06 중간 글: 짧은 글 + 도구 → 메모(답 아님) · 200자 넘으면 답으로 흘리다 도구가 오면 거둠 · 답은 마지막 조각', () => {
  const out = { delta: [], retract: 0, notes: [], open: [], promoted: 0 }
  const segs = TP.createSegments({ onDelta: (d) => out.delta.push(d), onRetract: () => out.retract++, onNote: (t) => out.notes.push(t), onOpen: (t) => out.open.push(t), onPromote: () => out.promoted++ })
  segs.token('먼저 링크의 글을 ')
  segs.token('열어 볼게요.')
  assert.deepEqual(out.delta, [], 'a short text is not shown as the answer')
  assert.equal(out.open.at(-1), '먼저 링크의 글을 열어 볼게요.')
  segs.cut() // tool_start
  assert.deepEqual(out.notes, ['먼저 링크의 글을 열어 볼게요.'])
  assert.equal(out.retract, 0)
  // a long run: promoted once past 200, streamed from then on
  const long = '가'.repeat(150)
  segs.token(long)
  assert.deepEqual(out.delta, [])
  segs.token('나'.repeat(60))
  assert.equal(out.promoted, 1)
  assert.deepEqual(out.delta, [long + '나'.repeat(60)])
  segs.token('다')
  assert.deepEqual(out.delta.at(-1), '다')
  // …then a tool: it was interim after all — taken back, kept as a note
  segs.cut()
  assert.equal(out.retract, 1)
  assert.equal(out.notes.length, 2)
  // the answer is the last segment, not every token
  segs.token('요약: 세 줄로 정리했어요.')
  assert.equal(segs.answer(), '요약: 세 줄로 정리했어요.')
  assert.ok(!segs.answer().includes('먼저 링크의 글을'))
  assert.equal(TP.PROMOTE_CHARS, 200)
  // with nothing after the last tool, the last closed segment
  const s2 = TP.createSegments({})
  s2.token('정리했어요.'); s2.cut()
  assert.equal(s2.answer(), '정리했어요.')
  // skill authoring: never streamed as the answer
  const s3 = TP.createSegments({ stream: false, onDelta: () => assert.fail('no delta') })
  s3.token('x'.repeat(500))
})

test('TP-U-07 plan_todos → 할 일(상태: pending · active · done)', () => {
  assert.deepEqual(TP.todosOf([
    { content: '링크의 글 읽기', status: 'completed' },
    { content: '  핵심  세 줄로 요약 ', status: 'in_progress' },
    { content: '요약 전달', status: 'pending' },
    { content: '', status: 'pending' },
    'plain string',
    null,
  ]), [
    { id: 't1', text: '링크의 글 읽기', state: 'done' },
    { id: 't2', text: '핵심 세 줄로 요약', state: 'active' },
    { id: 't3', text: '요약 전달', state: 'pending' },
    { id: 't5', text: 'plain string', state: 'pending' },
  ])
  assert.deepEqual(TP.todosOf(null), [])
  assert.deepEqual(TP.todosOf('x'), [])
})

test('TP-U-08 GET /api/threads/:id/turn: 진행 중인 턴(계획 · 단계 · 할 일 · 한 일 · 메모), 남의 대화는 404, 끝난 턴은 없음', async () => {
  respond = () => ({ content: planJson() })
  const owner = 'u-snap-owner', other = 'u-snap-other', threadId = '00000000-0000-0000-0000-0000000000ff'
  const app = express()
  const fakeAuth = (req, res, next) => { req.user = { id: req.headers['x-user'] }; next() }
  app.use('/api', TP.turnRoutes(fakeAuth, { thread: async (u, id) => (u === owner && id === threadId ? { id } : null) }))
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
  const get = (who) => fetch(`http://127.0.0.1:${srv.address().port}/api/threads/${threadId}/turn`, { headers: { 'x-user': who } })
  try {
    const turn = T.enqueue({ userId: owner, threadId })
    const v = TP.begin({ turn, userId: owner, threadId, msgId: 'msg-1', text: 'https://medium.com/@a/b' })
    await v.ready
    TP.handler(turn, { kind: 'agent', label: '에이전트' })
    TP.stage(turn, 'working', { text: '찾아보는 중' })
    TP.todos(turn, [{ content: '글 읽기', status: 'completed' }, { content: '요약', status: 'in_progress' }])
    TP.step(turn, { tool: 'fetch', phase: '찾아보는 중', hosts: ['medium.com'], key: 'k1', n: 1 })
    TP.note(turn, '먼저 글을 열어 볼게요.')
    let r = await (await get(owner)).json()
    assert.ok(Math.abs(r.now - Date.now()) < 2000)
    assert.equal(r.turns.length, 1)
    const s = r.turns[0]
    assert.equal(s.msgId, 'msg-1')
    assert.equal(s.turnId, turn.id)
    assert.equal(s.plan.understood, '링크의 글을 읽고 요약해 드릴게요.')
    assert.equal(s.plan.steps.length, 3)
    assert.deepEqual(s.handler, { kind: 'agent', label: '에이전트' })
    assert.equal(s.stage.stage, 'working')
    assert.deepEqual(s.todos.map((x) => x.state), ['done', 'active'])
    assert.equal(s.steps[0].hosts[0], 'medium.com')
    assert.deepEqual(s.notes.map((n) => n.text), ['먼저 글을 열어 볼게요.'])
    assert.equal((await get(other)).status, 404)
    // the answer keeps it (content.plan · content.notes), then the turn is gone from the snapshot
    const kept = TP.saved(turn, 'done')
    assert.deepEqual(kept.plan.steps.map((x) => x.state), ['done', 'done'])
    assert.equal(kept.plan.state, 'done')
    assert.deepEqual(kept.notes, ['먼저 글을 열어 볼게요.'])
    TP.end(turn, 'done'); turn.finish()
    r = await (await get(owner)).json()
    assert.deepEqual(r.turns, [])
  } finally { srv.close() }
})

test('TP-U-09 최근 작업 카드: NotebookLM 카드가 있는 대화의 「이제 아까 만들기로 한 노트북 만들자」 → 라우터와 앞단 프롬프트에 그 카드 한 줄', async () => {
  const card = { kind: 'task', content: { title: 'NotebookLM에서 노트북 만들기', goal: '이 글로 노트북을 만들어 줘 https://medium.com/@kim/agents-need-plans-9f1c2 — 슬라이드와 팟캐스트까지',
    state: 'needs_input', need: 'other', url: '', skill: 'notebooklm', steps: [] } }
  const local = { kind: 'local_run', content: { activity: '견적서 정리', state: 'done', label: 'Claude Code', chat: true } }
  const line = TP.taskLine(card)
  assert.equal(line, 'browser task · waiting · NotebookLM에서 노트북 만들기 · https://medium.com/@kim/agents-need-plans-9f1c2 · skill notebooklm')
  assert.ok(line.length <= 160)
  assert.equal(TP.taskLine(local), 'local agent task · done · 견적서 정리 · skill Claude Code')
  assert.equal(TP.taskLine({ kind: 'task', content: { title: 'x'.repeat(300), state: 'running', url: `https://e.com/${'y'.repeat(300)}` } }).length, 160)
  const states = ['running', 'queued', 'needs_input', 'done', 'needs_review', 'failed', 'cancelled'].map((s) => TP.taskLine({ kind: 'task', content: { title: 't', state: s } }).split(' · ')[1])
  assert.deepEqual(states, ['running', 'waiting', 'waiting', 'done', 'stopped', 'stopped', 'cancelled'])
  // the router's prompt
  respond = () => ({ content: 'DELEGATE' })
  await A.routeTurn({ user, session, hist: [{ role: 'user', content: '이제 아까 만들기로 한 노트북 만들자' }], now: 'now', tasks: [TP.taskLine(local), line] })
  const sys = calls.at(-1).body.messages[0].content
  assert.ok(sys.includes(`- ${line}`), 'the card line is in the router prompt')
  assert.match(sys, /이 대화의 최근 작업 카드\(오래된 것부터\):\n- local agent task/)
  assert.equal(calls.at(-1).body.messages.at(-1).content, '이제 아까 만들기로 한 노트북 만들자')
  // the front call too
  respond = () => ({ content: planJson() })
  await TP.frontPlan({ text: '이제 아까 만들기로 한 노트북 만들자', tasks: [line] })
  assert.ok(calls.at(-1).body.messages[1].content.includes(`- ${line}`))
  // nothing when there are none
  assert.equal(TP.taskBlock([]), '')
})

test('TP-U-10 멈추기: 앞 단계(라우터 전)의 턴은 running 에 들고, 줄 서서 기다리는 턴은 waiting 에 남는다', async () => {
  const userId = 'u-stop', threadId = 't-stop'
  const a = T.enqueue({ userId, threadId, conv: 'c1' })
  await T.waitTurn(a) // running
  const front = T.enqueue({ userId, threadId })
  front.front = true // a message still being read and routed
  const queued = T.enqueue({ userId, threadId, conv: 'c1' })
  const w = T.waitTurn(queued)
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(T.running({ userId, threadId }).map((x) => x.id).sort(), [a.id, front.id].sort())
  assert.deepEqual(T.waiting({ userId, threadId }).map((x) => x.id), [queued.id])
  // (the message still being read has no conversation yet: the turn in line waits for it too, as for any earlier turn of the thread)
  a.finish(); front.finish(); await w
  queued.finish()
})

// ---------- 검토 11-25 (review of f9f80f1): one regression test per item ----------
const HITL = (o = {}) => JSON.stringify({ type: 'human_input_required', question: '어떤 형식으로 정리할까요?', context: '링크의 글이 길어요.', options: ['세 줄 요약', { label: '표로 정리' }], multi_select: false, run_state: { pending_field: 'human_response', tool_name: 'request_human_input' }, ...o })

test('TP-R-01 (#1) 에이전트가 사람에게 물으면(done.content 가 human_input_required JSON) 답은 질문 · 맥락 · 고를 것이고, JSON 은 답이 되지 않는다', () => {
  const segs = TP.createSegments({})
  segs.token('어떤 형식이 좋을지 여쭤볼게요.'); segs.cut() // (request_human_input: plan_tools cuts the streamed question to a note)
  const a = TP.finalAnswer(HITL(), segs)
  assert.equal(a.asks, true)
  assert.equal(a.text, '링크의 글이 길어요.\n\n어떤 형식으로 정리할까요?\n- 세 줄 요약\n- 표로 정리')
  assert.ok(!a.text.includes('run_state') && !a.text.startsWith('{'))
  assert.equal(TP.finalAnswer(HITL({ context: '' }), segs).text, '어떤 형식으로 정리할까요?\n- 세 줄 요약\n- 표로 정리')
  // any other JSON is never the answer: the stream's own text is
  const s2 = TP.createSegments({}); s2.token('정리했어요.')
  assert.equal(TP.finalAnswer('{"type":"something_else","x":1}', s2).text, '정리했어요.')
  assert.equal(TP.finalAnswer('[1,2]', s2).text, '정리했어요.')
  assert.equal(TP.finalAnswer('{"type":"human_input_required"}', s2).text, '정리했어요.', 'no question: not taken')
  // plain done.content is still the answer
  assert.equal(TP.finalAnswer('마지막 답이에요.', s2).text, '마지막 답이에요.')
  assert.equal(TP.humanInput('그냥 글'), null)
})

test('TP-R-02 (#2) 정리 도구(write_todos · think)는 글을 자르지 않는다 — 긴 요약 → write_todos → 「모든 단계를 마쳤어요.」 는 하나의 답', () => {
  for (const t of ['write_todos', 'think', 'todo_write', 'THINK']) assert.equal(TP.bookkeeping(t), true, t)
  for (const t of ['fetch_url', 'execute', 'request_human_input', 'ls', 'read_file', '']) assert.equal(TP.bookkeeping(t), false, t)
  const out = { delta: [], retract: 0, notes: [] }
  const segs = TP.createSegments({ onDelta: (d) => out.delta.push(d), onRetract: () => out.retract++, onNote: (t) => out.notes.push(t) })
  const summary = `요약\n${'가나다라마바사 '.repeat(190)}`.trim()
  segs.token(summary)
  segs.mark() // plan_tools [write_todos]
  segs.mark() // tool_start write_todos
  segs.token('모든 단계를 마쳤어요.')
  assert.equal(out.retract, 0)
  assert.deepEqual(out.notes, [])
  assert.equal(segs.answer(), `${summary}\n\n모든 단계를 마쳤어요.`)
  // done.content is only the last message: the segment it ends is the answer
  const a = TP.finalAnswer('모든 단계를 마쳤어요.', segs)
  assert.equal(a.text, `${summary}\n\n모든 단계를 마쳤어요.`)
  assert.ok(a.text.length > 1400)
  // the streamed draft got the paragraph break too (it was promoted past 200 characters)
  assert.ok(out.delta.join('').endsWith('\n\n모든 단계를 마쳤어요.'))
  // a real tool still cuts
  const s2 = TP.createSegments({ onNote: (t) => out.notes.push(t) })
  s2.token('먼저 볼게요.'); s2.cut(); s2.token('끝.')
  assert.equal(TP.finalAnswer('끝.', s2).text, '끝.')
})

test('TP-R-03 (#3) 대화 · 주제 보기에서 누른 멈추기도 앞 단계(대화가 아직 없는) 메시지에 닿는다', () => {
  const userId = 'u-r03', threadId = 't-r03'
  const front = T.enqueue({ userId, threadId }); front.front = true
  const other = T.enqueue({ userId, threadId, conv: 'c-other' }); other.started = true
  assert.deepEqual(T.running({ userId, threadId, conv: 'c-mine' }).map((x) => x.id), [front.id])
  assert.deepEqual(T.running({ userId, threadId, conv: 'c-other' }).map((x) => x.id).sort(), [front.id, other.id].sort())
  // once it has a conversation, only that view's stop reaches it
  front.setConv('c-x')
  assert.deepEqual(T.running({ userId, threadId, conv: 'c-mine' }).map((x) => x.id), [])
  front.finish(); other.finish()
})

test('TP-R-04 (#4) 멈추기는 쓰는 중인 답을 멈추고, 그동안 방금 보낸 메시지(앞 단계)는 두며, 시작한 것이 없을 때만 앞 단계를 멈춘다', () => {
  const userId = 'u-r04', threadId = 't-r04'
  const a = T.enqueue({ userId, threadId, conv: 'c1' }); a.started = true
  const b = T.enqueue({ userId, threadId }); b.front = true
  assert.deepEqual(T.toStop(T.running({ userId, threadId })).map((x) => x.id), [a.id])
  a.finish()
  assert.deepEqual(T.toStop(T.running({ userId, threadId })).map((x) => x.id), [b.id])
  b.finish()
})

test('TP-R-05 (#5) 앞 단계에서 멈춘 턴은 새 프로세스 초안을 남기지 않는다(generationPending)', async () => {
  const userId = '00000000-0000-0000-0000-0000000000a5', threadId = '00000000-0000-0000-0000-0000000005a5'
  const turn = T.enqueue({ userId, threadId }); turn.front = true; turn.stopped = true
  await assert.rejects(A._test.inTurn(turn, () => A._test.processTurn(userId, threadId, { intent: 'create', query: '휴가 신청 프로세스' })), (e) => e.turnStopped === true)
  assert.equal(A.generationPending(threadId), undefined)
  turn.finish()
})

test('TP-R-06 (#6) 한국어 화면의 언어 지시는 말이 없는 메시지(링크 · 파일뿐)에만, 다른 언어 요청은 그 언어로, 내 PC 에이전트 · 미션에는 없음', () => {
  assert.equal(lang.wordless('https://medium.com/@a/b'), true)
  assert.equal(lang.wordless('  https://a.com  https://b.com '), true)
  assert.equal(lang.wordless('영문 메일 써 줘 https://a.com'), false)
  assert.equal(lang.wordless('Summarize https://a.com'), false)
  const link = lang.langInstruction({ said: 'https://medium.com/@a/b' })
  assert.match(link, /^\n\n\[Instruction\] 언어: 한국어/)
  assert.match(link, /다른 언어를 요청했거나 앞선 대화를 다른 언어로 썼으면 그 언어로/)
  assert.equal(lang.langInstruction({ said: '영어로 번역해 줘' }), '')
  assert.equal(lang.langInstruction({ said: 'Write the reply in English' }), '')
  // callers that do not say what was said (local CLI agents — lib/localAgents/chat.js · steps.js, missions, mail drafts)
  assert.equal(lang.langInstruction(), '')
  assert.match(lang.withLang('en', () => lang.langInstruction()), /LANGUAGE: English/)
})

test('TP-R-07 (#7) 끝난 턴은 스냅샷 · 늦은 사건으로 되살아나지 않고, 서버는 끝내기를 늘 보낸다', async () => {
  const S = await import('../../src/turnState.js')
  const ended = new Map()
  let all = {}
  const ev = (type, d) => { all = S.applyTurnEvent(all, type, { threadId: 'th', turnId: 'x1', at: Date.now(), ...d }, ended) }
  ev('turn.start', { msgId: 'm1', startedAt: Date.now() })
  ev('turn.plan', { understood: '요약', steps: [] })
  assert.ok(all.x1)
  ev('turn.end', { state: 'done' })
  assert.equal(all.x1, undefined)
  // a snapshot taken before the end (it was on the way) still lists it: not brought back
  const snap = S.fromSnapshot({ now: Date.now(), turns: [{ turnId: 'x1', threadId: 'th', msgId: 'm1', startedAt: Date.now() - 5000, lastAt: Date.now() - 1000 }, { turnId: 'x2', threadId: 'th', msgId: 'm2', startedAt: Date.now() }] }, ended)
  assert.deepEqual(Object.keys(snap), ['x2'])
  // an event after the end does not either
  ev('turn.stage', { stage: 'working', text: '작업하는 중' })
  assert.equal(all.x1, undefined)
  // (the server's side — the view ends even when the 「멈췄어요」 message cannot be written — is TP-I-07 in turnPlan.integration.test.js)
})

test('TP-R-08 (#8) 라우터가 6초 안에 답하지 않으면: 도구가 필요한 말이면 한 번 더(더 길게) 묻고, 아니면 에이전트 — 몇 번째 대신인지 센다', async () => {
  const before = { ...A.routerStats }
  const slowThen = (tool) => { let n = 0; return () => (n++ === 0 ? { delay: 2000, content: 'DELEGATE' } : { delay: 100, tool_calls: [{ id: 'c', type: 'function', function: { name: tool, arguments: '{"name":"주간 보고","cron":"0 9 * * 1","prompt":"주간 보고","ack":"네"}' } }] }) }
  const sched = [{ role: 'user', content: '매주 월요일 9시에 주간 보고 써 줘' }]
  // (a) the judge says a tool is needed: asked again, and the schedule tool comes back
  respond = slowThen('schedule_task')
  let judged = 0
  const toolJudge = async () => { judged++; return { probabilities: { tool: 0.91, agent: 0.09 }, choice: 'tool' } }
  let r = await A.routeTurn({ user, session, hist: sched, now: 'now', judge: toolJudge, limitMs: 500, retryMs: 5000 })
  assert.equal(judged, 1)
  assert.equal(r.call.function.name, 'schedule_task')
  assert.equal(A.routerStats.retried, before.retried + 1)
  assert.equal(A.routerStats.answeredOnRetry, before.answeredOnRetry + 1)
  // (b) the judge says it is the agent's work: not asked again, delegated, counted
  respond = slowThen('schedule_task')
  const agentJudge = async () => ({ probabilities: { tool: 0.08, agent: 0.92 }, choice: 'agent' })
  const n0 = calls.length
  r = await A.routeTurn({ user, session, hist: [{ role: 'user', content: 'https://medium.com/@a/b' }], now: 'now', judge: agentJudge, limitMs: 500, retryMs: 5000 })
  assert.equal(r, null)
  assert.equal(calls.length - n0, 1, 'one router call only')
  // (c) no reading at all: the structural signs decide — an address, an attached file
  respond = slowThen('browser_task')
  const noJudge = async () => null
  r = await A.routeTurn({ user, session, hist: [{ role: 'user', content: '로그인해서 주문 내역 https://shop.example.com' }], now: 'now', judge: noJudge, limitMs: 500, retryMs: 5000 })
  assert.equal(r.call.function.name, 'browser_task')
  respond = slowThen('browser_task')
  r = await A.routeTurn({ user, session, hist: [{ role: 'user', content: '이 파일 정리' }], now: 'now', judge: noJudge, attachments: 1, limitMs: 500, retryMs: 5000 })
  assert.equal(r.call.function.name, 'browser_task')
  respond = slowThen('browser_task')
  assert.equal(await A.routeTurn({ user, session, hist: [{ role: 'user', content: '오늘 할 일 정리' }], now: 'now', judge: noJudge, limitMs: 500, retryMs: 5000 }), null)
  // (d) slow again: delegated after the second limit
  respond = () => ({ delay: 3000, content: 'DELEGATE' })
  assert.equal(await A.routeTurn({ user, session, hist: sched, now: 'now', judge: toolJudge, limitMs: 300, retryMs: 600 }), null)
  assert.equal(A.routerStats.timeouts, before.timeouts + 6)
  assert.equal(A.routerStats.fallbacks, before.fallbacks + 3)
  assert.ok(A.routerStats.calls >= before.calls + 6)
  // the judge's question (the real one: the odds reading on the fake server) — a model call, not words matched
  const w = await A.toolWanted({ text: '매주 월요일 9시에 주간 보고 써 줘', judge: async (state, q, opts) => { assert.match(state, /매주 월요일 9시/); assert.deepEqual(opts.map((o) => o.key), ['tool', 'agent']); return null } })
  assert.deepEqual(w, { want: false, via: 'structure' })
})

test('TP-R-09 (#9) 질문 카드에 대한 답과 습관 설정 읽기는 기본 한도(8초)를 쓴다 — 3초는 라우터 옆의 결과물 후속 판단만', async () => {
  const D = await import('../lib/decide.js')
  assert.equal(D.ODDS_MS, 8000)
  assert.equal(D.TURN_ODDS_MS, 3000)
  const src = (await import('node:fs')).readFileSync(new URL('../lib/followups.js', import.meta.url), 'utf8')
  const call = (name) => new RegExp(`oddsOf\\(${name}`).exec(src) && src.slice(src.indexOf(`oddsOf(${name}`), src.indexOf('\n', src.indexOf(`oddsOf(${name}`)))
  assert.ok(!/TURN_ODDS_MS/.test(call('answerState')), call('answerState'))
  assert.ok(!/TURN_ODDS_MS/.test(call('ruleState')), call('ruleState'))
  assert.ok(/TURN_ODDS_MS/.test(call('followupState')), call('followupState'))
  // a 4.2 s reading on the default limit is read (and a short limit's timeout does not mark the reader down)
  respond = (b) => (b.logprobs ? { delay: 4200, content: 'A', logprobs: true } : { content: '{}' })
  const opts = [{ key: 'accept', label: 'yes' }, { key: 'decline', label: 'no' }]
  assert.equal(await D.oddsOf('state', 'q?', opts, { timeoutMs: 1000 }), null)
  const r = await D.oddsOf('state', 'q?', opts)
  assert.equal(r?.choice, 'accept')
})

test('TP-R-10 (#10) PRO_FRONT_PLAN=off: 「요청을 읽는 중」 머리 없이, 단계 · 현재 상태 줄만', async () => {
  const seen = []
  const userId = `u-r10-${Date.now()}`
  const off = bus.subscribe(userId, { write: (line) => seen.push(line) })
  const n0 = calls.length
  const turn = T.enqueue({ userId, threadId: '00000000-0000-0000-0000-00000000010a' })
  const v = TP.begin({ turn, userId, threadId: turn.threadId, msgId: 'm', text: 'x', plan: false })
  assert.equal(await v.ready, null)
  off()
  const start = JSON.parse(/^data: (.*)$/m.exec(seen.find((l) => l.startsWith('event: turn.start')))[1])
  assert.equal(start.planState, 'off')
  assert.equal(calls.length, n0, 'no front call')
  assert.equal(TP.snapshot(userId, turn.threadId)[0].planState, 'off')
  TP.end(turn, 'done'); turn.finish()
  const V = await import('../../src/turnView.js')
  const at = Date.now()
  const base = { turnId: 'o', startedAt: at - 2000, skew: 0, seenAt: at, planState: 'off', plan: null, steps: [], todos: [], stage: { stage: 'reading', text: '요청을 읽는 중' } }
  let cv = V.cardView(base, at)
  assert.equal(cv.reading, false)
  assert.equal(cv.off, true)
  cv = V.cardView({ ...base, stage: { stage: 'working', text: '찾아보는 중' }, todos: [{ id: 't1', text: '글 읽기', state: 'active' }] }, at)
  assert.equal(cv.shown, true)
  assert.deepEqual(cv.steps.map((s) => s.text), ['글 읽기'])
  // with the plan on: the reading head
  assert.equal(V.cardView({ ...base, planState: 'reading' }, at).reading, true)
})

test('TP-R-11 (#11) 방금 만든 결과물에 대한 말이면 라우터 호출을 멈춘다', async () => {
  let aborted = false
  const t0 = Date.now()
  const r = await TP.aboutOrRoute({
    about: () => new Promise((ok) => setTimeout(() => ok({ conv: 'c1', title: '보고서' }), 50)),
    route: (signal) => new Promise((ok) => { signal.addEventListener('abort', () => { aborted = true; ok(null) }); setTimeout(() => ok({ call: null, args: {} }), 5000) }),
  })
  assert.ok(Date.now() - t0 < 1000)
  assert.equal(aborted, true)
  assert.deepEqual(r, { about: { conv: 'c1', title: '보고서' }, routed: null })
  // not about the result: the router's answer
  const r2 = await TP.aboutOrRoute({ about: async () => null, route: async () => ({ call: null, args: {} }) })
  assert.deepEqual(r2, { about: null, routed: { call: null, args: {} } })
  // the turn's own stop reaches the router too
  const ac = new AbortController()
  setTimeout(() => ac.abort(), 30)
  const r3 = await TP.aboutOrRoute({ about: async () => null, route: (signal) => new Promise((ok) => signal.addEventListener('abort', () => ok('stopped'))), signal: ac.signal })
  assert.equal(r3.routed, 'stopped')
})

test('TP-R-12 (#12) 로그에는 사람이 한 말 · 계획 문장이 없다(출처 · tier · 길이만)', async () => {
  respond = () => ({ content: planJson({ understood: '김민지 과장의 연봉 계약서를 요약해 드릴게요.' }) })
  const lines = []
  const orig = console.log
  console.log = (...a) => { lines.push(a.join(' ')); orig(...a) }
  try {
    const userId = `u-r12-${Date.now()}`
    const turn = T.enqueue({ userId, threadId: '00000000-0000-0000-0000-00000000012a' })
    const v = TP.begin({ turn, userId, threadId: turn.threadId, msgId: 'm', text: '김민지 과장 연봉 계약서 https://drive.example.com/x' })
    await v.ready
    TP.handler(turn, { kind: 'agent', label: '에이전트' })
    TP.end(turn, 'done'); turn.finish()
  } finally { console.log = orig }
  const ours = lines.filter((l) => l.startsWith('[turn-plan]'))
  assert.ok(ours.length >= 2, ours.join('\n'))
  for (const l of ours) { assert.ok(!/김민지|연봉|계약서|drive\.example/.test(l), l) }
  assert.ok(ours.some((l) => /plan=front tier=light understood=\d+ch steps=3/.test(l)), ours.join('\n'))
})
