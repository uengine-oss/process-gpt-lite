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
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: r.content ?? null, ...(r.tool_calls ? { tool_calls: r.tool_calls } : {}) }, finish_reason: 'stop' }] }))
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
  // the agent's message: a Korean instruction in Korean mode too (a link alone has no language of its own)
  assert.match(lang.langInstruction(), /\[Instruction\] 언어: 한국어/)
  assert.match(lang.langInstruction(), /링크나 파일뿐이어도/)
  assert.match(lang.withLang('en', () => lang.langInstruction()), /LANGUAGE: English/)
  // the plan block (§1.4) after the message, in the person's language
  const userId = `u-pb-${Date.now()}`
  const turn = T.enqueue({ userId, threadId: '00000000-0000-0000-0000-000000000002' })
  const v = TP.begin({ turn, userId, threadId: turn.threadId, msgId: 'm2', text: 'https://medium.com/@a/b' })
  await v.ready
  const block = await TP.planBlock(turn)
  assert.match(block, /^\n\n\[계획\] 링크의 글을 읽고 요약해 드릴게요\.\n1\. 글 열기\n2\. 핵심 정리\n3\. 요약 전달\n/)
  assert.match(block, /write_todos/)
  assert.match(block, /요청하지 않은 결과물은 만들지 마세요/)
  TP.end(turn, 'done'); turn.finish()
  const t2 = T.enqueue({ userId, threadId: '00000000-0000-0000-0000-000000000002' })
  const en = await lang.withLang('en', async () => { const v2 = TP.begin({ turn: t2, userId, threadId: t2.threadId, msgId: 'm3', text: 'x' }); await v2.ready; return TP.planBlock(t2) })
  assert.match(en, /^\n\n\[Plan\] .*\n1\. /)
  assert.match(en, /Record this plan with write_todos first; you may refine it\. Do only this work\.\nDo not produce deliverables that were not asked for/)
  TP.end(t2, 'done'); t2.finish()
})

const user = { id: '00000000-0000-0000-0000-0000000000aa', name: '시험' }
const session = { access_token: 'test' }
const hist = [{ role: 'user', content: 'https://example.com/a' }]

test('TP-U-05 라우터: 6초 넘으면 · 오류면 · 인자가 JSON 이 아니면 null(→ 에이전트), DELEGATE · 도구는 그대로', async () => {
  assert.equal(A.ROUTER_MS, 6000)
  // passes 6 s
  respond = () => ({ delay: 9000, content: 'DELEGATE' })
  let t0 = Date.now()
  let r = await A.routeTurn({ user, session, hist, now: 'now' })
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
