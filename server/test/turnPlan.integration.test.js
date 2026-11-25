// 계획 카드와 진행 상황 — 검토 11-25(f9f80f1)의 지적을 실제 턴으로(lib/agent.js runTurn → delegate, 실제 DB). deepagents 와 모델은
// 이 파일이 흉내 낸다(fetch 를 바꿔 끼움): deepagents 의 /chat/stream 은 시험이 써 넣는 스트림, 모델은 앞단 계획 JSON · 라우터(DELEGATE, 늦게도) ·
// 확률 읽기를 돌려준다. 시험 사용자는 무작위 id(로그인 계정 아님), 끝나면 지움. 데이터베이스가 없으면 건너뜀.
//   TP-I-01 (#1) 에이전트가 사람에게 물으면(interrupt — done.content 가 human_input_required JSON) 저장되는 답은 질문 · 맥락 · 고를 것
//   TP-I-02 (#2) 긴 요약 → write_todos → 「모든 단계를 마쳤어요.」: 요약이 답에 남고 메모로 잘리지 않음, 답 말풍선을 거두지도 않음
//   TP-I-03 (#3) 대화 보기에서 누른 멈추기가 앞 단계(라우터가 아직 답하지 않은) 메시지를 멈춤
//   TP-I-04 (#4) 답을 쓰는 중에 보낸 메시지는 그 답을 멈춰도 이어서 처리됨
//   TP-I-05 (#5) 앞 단계에서 멈춘 메시지의 첨부가 다음 메시지의 에이전트에게 따라가지 않음
//   TP-I-06 (#6) 말이 있는 한국어 메시지에는 언어 지시가 붙지 않고, 링크만 보낸 메시지에는 붙음
//   TP-I-07 (#7) 「멈췄어요」를 쓸 수 없어도(대화방이 지워짐) 턴의 끝(turn.end)이 나가고 진행 상태가 남지 않음
//   TP-I-09 (#9) 질문 카드에 대한 「아니요」 읽기가 4.2초 걸려도 읽힘(예전 3초 한도에서는 지나쳤음)
//   cd server && node --test --test-concurrency=1 test/turnPlan.integration.test.js
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { config } from '../config.js'
import { q, pool } from '../lib/supa.js'

const up = await q('select 1').then(() => true, () => false)
const realFetch = globalThis.fetch
const enc = new TextEncoder()
const wait = (ms, signal) => new Promise((ok, no) => {
  const t = setTimeout(ok, ms)
  signal?.addEventListener('abort', () => { clearTimeout(t); no(signal.reason || Object.assign(new Error('aborted'), { name: 'AbortError' })) }, { once: true })
})
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } })

// ---- the fake model ----
const llm = { router: [], odds: [] }
let routerReply = () => ({ content: 'DELEGATE' })
let oddsReply = (prompt) => ({ letter: [...prompt.matchAll(/^([A-Z])\) /gm)].map((m) => m[1]).at(-1) || 'A' })
async function fakeLlm(body, signal) {
  const text = (body.messages || []).map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n')
  const last = String(body.messages?.at(-1)?.content || '')
  if (body.logprobs) {
    llm.odds.push(text)
    const r = oddsReply(text)
    if (r.delay) await wait(r.delay, signal)
    const other = r.letter === 'A' ? 'B' : 'A'
    return json({ choices: [{ message: { content: r.letter }, logprobs: { content: [{ token: r.letter, logprob: Math.log(0.95), top_logprobs: [{ token: r.letter, logprob: Math.log(0.95) }, { token: other, logprob: Math.log(0.03) }] }] } }] })
  }
  if (String(body.messages?.[0]?.content || '').includes('what you understood and how the work will go')) {
    return json({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ understood: '요청을 살펴볼게요.', steps: ['읽기', '정리'], tier: 'light', certainty: 'sure' }) }, finish_reason: 'stop' }] })
  }
  if (body.tools) {
    llm.router.push({ text: last, at: Date.now() })
    const r = routerReply(last)
    if (r.delay) await wait(r.delay, signal)
    return json({ choices: [{ message: { role: 'assistant', content: r.content ?? null, ...(r.tool_calls ? { tool_calls: r.tool_calls } : {}) }, finish_reason: 'stop' }] })
  }
  return json({ choices: [{ message: { role: 'assistant', content: body.response_format ? '{}' : 'OK' }, finish_reason: 'stop' }] })
}

// ---- the fake deepagents: every /chat/stream call becomes a stream the test writes into ----
const streams = []
let wake = []
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url)
  if (u.startsWith(config.llm.baseUrl)) return fakeLlm(opts.body ? JSON.parse(opts.body) : {}, opts.signal)
  if (u.startsWith(config.deepagentsUrl) || (config.contextRouterUrl && u.startsWith(config.contextRouterUrl))) {
    const body = opts.body ? JSON.parse(opts.body) : {}
    if (u.endsWith('/chat/stop')) {
      const h = streams.find((s) => s.body.conversation_id && s.body.conversation_id === body.conversation_id && !s.closed)
      if (h) { h.push({ type: 'error', error: 'turn cancelled' }); h.end() }
      return json({ stopped: !!h })
    }
    if (u.endsWith('/chat/stream')) {
      let ctl
      const h = { body, closed: false }
      const rs = new ReadableStream({ start(c) { ctl = c } })
      h.push = (data, event = 'message') => { if (!h.closed) ctl.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)) }
      h.end = () => { if (!h.closed) { h.closed = true; ctl.close() } }
      opts.signal?.addEventListener('abort', () => { if (!h.closed) { h.closed = true; ctl.error(Object.assign(new Error('aborted'), { name: 'AbortError' })) } })
      if (body.conversation_id) h.push({ conversation_id: body.conversation_id }, 'metadata')
      streams.push(h)
      for (const w of wake.splice(0)) w()
      return new Response(rs, { headers: { 'Content-Type': 'text/event-stream' } })
    }
    if (u.includes('/route')) return json({})
  }
  if (/\/servers$|\/bindings$|\/skills\?/.test(u)) return json([])
  return realFetch(url, opts)
}
const nth = async (n) => { while (streams.length < n) await new Promise((r) => wake.push(r)); return streams[n - 1] }
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return v; await new Promise((r) => setTimeout(r, 30)) } }

const { runTurn, stopTurns } = await import('../lib/agent.js')
const { subscribe } = await import('../lib/bus.js')
const TP = await import('../lib/turnPlan.js')

const user = { id: crypto.randomUUID(), email: `pro-fix-tpi-${crypto.randomBytes(3).toString('hex')}@uengine.org`, name: '시험' }
const session = { access_token: 'test-token' }
const threads = []
async function chatThread() {
  const [t] = await q(`insert into pro_threads(user_id,kind,title) values ($1,'chat','시험') returning id`, [user.id])
  threads.push(t.id)
  return t.id
}
const agentTexts = async (tid) => (await q(`select content from pro_messages where thread_id=$1 and role='agent' and kind in ('text','doc') order by created_at`, [tid])).map((m) => m.content)
after(async () => {
  globalThis.fetch = realFetch
  if (up && threads.length) await q('delete from pro_threads where id = any($1)', [threads]).catch(() => {})
  if (up) await q('delete from pro_followups where user_id=$1', [user.id]).catch(() => {})
  await pool.end()
  const { closeOntology } = await import('../lib/ontology/store.js')
  await closeOntology().catch(() => {})
})

test('TP-I-01 (#1) 에이전트가 사람에게 물으면 저장되는 답은 JSON 이 아니라 질문 · 맥락 · 고를 것', { skip: !up }, async () => {
  routerReply = () => ({ content: 'DELEGATE' })
  const tid = await chatThread()
  const n0 = streams.length
  const p = runTurn({ user, session, threadId: tid, text: '이 글을 어떻게 정리할지 정해서 해 줘 https://example.com/a' })
  const h = await nth(n0 + 1)
  h.push({ type: 'token', content: '어떤 형식이 좋을지 여쭤볼게요.' })
  h.push({ type: 'plan_tools', tools: [{ tool: 'request_human_input', name: 'request_human_input', args: { question: '어떤 형식으로 정리할까요?' } }] })
  h.push({ type: 'tool_start', tool: 'request_human_input', input: { question: '어떤 형식으로 정리할까요?' } })
  h.push({ type: 'done', content: JSON.stringify({ type: 'human_input_required', question: '어떤 형식으로 정리할까요?', context: '링크의 글이 길어요.', options: ['세 줄 요약', '표로 정리'], multi_select: false, run_state: { pending_field: 'human_response', tool_name: 'request_human_input', last_question: '어떤 형식으로 정리할까요?' } }) })
  h.end()
  const m = await p
  assert.equal(m.content.text, '링크의 글이 길어요.\n\n어떤 형식으로 정리할까요?\n- 세 줄 요약\n- 표로 정리')
  assert.ok(!/run_state|human_input_required/.test(m.content.text))
  assert.equal(m.content.plan?.state, 'done')
})

test('TP-I-02 (#2) 긴 요약 → write_todos → 짧은 마무리: 요약이 답에 남는다', { skip: !up }, async () => {
  routerReply = () => ({ content: 'DELEGATE' })
  const tid = await chatThread()
  const n0 = streams.length
  let retracted = 0
  const deltas = []
  const p = runTurn({ user, session, threadId: tid, text: '이 자료를 길게 요약해 줘 https://example.com/report', onDelta: (d) => deltas.push(d), onRetract: () => retracted++ })
  const h = await nth(n0 + 1)
  const summary = `# 요약\n${'핵심 내용을 정리한 문장이에요. '.repeat(60)}`.trim()
  h.push({ type: 'token', content: summary.slice(0, 700) })
  h.push({ type: 'token', content: summary.slice(700) })
  h.push({ type: 'plan_tools', tools: [{ tool: 'write_todos', name: 'write_todos', args: {} }] })
  h.push({ type: 'tool_start', tool: 'write_todos', input: { todos: [] } })
  h.push({ type: 'plan_todos', todos: [{ content: '요약 쓰기', status: 'completed' }] })
  h.push({ type: 'tool_end', tool: 'write_todos', output: 'ok' })
  h.push({ type: 'token', content: '모든 단계를 마쳤어요.' })
  h.push({ type: 'done', content: '모든 단계를 마쳤어요.' })
  h.end()
  const m = await p
  assert.ok(m.content.text.length > 1000, m.content.text.slice(0, 80))
  assert.ok(m.content.text.startsWith('# 요약'))
  assert.ok(m.content.text.endsWith('모든 단계를 마쳤어요.'))
  assert.equal(m.content.notes, undefined, 'nothing was cut to a note')
  assert.equal(retracted, 0)
  assert.ok(deltas.join('').length > 1000, 'the summary was streamed as the answer')
})

test('TP-I-03 (#3) 대화 보기에서 누른 멈추기가 라우터를 기다리는 메시지에 닿는다', { skip: !up }, async () => {
  routerReply = (t) => (t.includes('slow-3') ? { delay: 6000, content: 'DELEGATE' } : { content: 'DELEGATE' })
  const tid = await chatThread()
  const n0 = streams.length
  const p = runTurn({ user, session, threadId: tid, text: '이거 정리해 줘 slow-3', conversation: { id: 'conv-view-3', title: '보고서' } })
  await until(() => llm.router.some((r) => r.text.includes('slow-3')))
  const r = await stopTurns({ user, session, threadId: tid, conversation: 'conv-view-3' })
  assert.equal(r.stopped, 1)
  const m = await p
  assert.equal(m.content.stopped, true)
  assert.match(m.content.text, /멈췄어요/)
  assert.equal(streams.length, n0, 'no agent turn')
})

test('TP-I-04 (#4) 답을 쓰는 중에 보낸 메시지는, 그 답을 멈춰도 이어서 처리된다', { skip: !up }, async () => {
  routerReply = (t) => (t.includes('slow-4b') ? { delay: 2500, content: 'DELEGATE' } : { content: 'DELEGATE' })
  const tid = await chatThread()
  const n0 = streams.length
  const pA = runTurn({ user, session, threadId: tid, text: '첫 번째 요청 정리해 줘' })
  const hA = await nth(n0 + 1)
  hA.push({ type: 'token', content: '쓰는 중' })
  const pB = runTurn({ user, session, threadId: tid, text: '두 번째 요청 slow-4b' })
  await until(() => llm.router.some((r) => r.text.includes('slow-4b')))
  const r = await stopTurns({ user, session, threadId: tid })
  assert.equal(r.stopped, 1, 'only the answer being written')
  const a = await pA
  assert.equal(a.content.stopped, true)
  const hB = await nth(n0 + 2)
  assert.ok(String(hB.body.message).includes('두 번째 요청'))
  hB.push({ type: 'token', content: '두 번째 답이에요.' })
  hB.end()
  const b = await pB
  assert.equal(b.content.text, '두 번째 답이에요.')
  assert.equal(b.content.stopped, undefined)
})

test('TP-I-05 (#5) 앞 단계에서 멈춘 메시지의 첨부는 다음 메시지의 에이전트에게 따라가지 않는다', { skip: !up }, async () => {
  routerReply = (t) => (t.includes('slow-5') ? { delay: 6000, content: 'DELEGATE' } : { content: 'DELEGATE' })
  const tid = await chatThread()
  const n0 = streams.length
  const pA = runTurn({ user, session, threadId: tid, text: '이 파일 봐 줘 slow-5', files: [{ name: '계약서.pdf', url: 'http://127.0.0.1:9/att/계약서.pdf', type: 'application/pdf', size: 10 }] })
  await until(() => llm.router.some((r) => r.text.includes('slow-5')))
  assert.equal((await stopTurns({ user, session, threadId: tid })).stopped, 1)
  assert.equal((await pA).content.stopped, true)
  const pB = runTurn({ user, session, threadId: tid, text: '오늘 할 일 정리해 줘' })
  const hB = await nth(n0 + 1)
  assert.deepEqual(hB.body.files || [], [])
  assert.ok(!String(hB.body.message).includes('계약서.pdf'))
  hB.push({ type: 'token', content: '정리했어요.' }); hB.end()
  await pB
})

test('TP-I-06 (#6) 말이 있는 한국어 메시지에는 언어 지시가 없고, 링크만 보낸 메시지에는 있다', { skip: !up }, async () => {
  routerReply = () => ({ content: 'DELEGATE' })
  const tid = await chatThread()
  const n0 = streams.length
  const p1 = runTurn({ user, session, threadId: tid, text: 'Write the reply in English, please https://example.com/mail' })
  const h1 = await nth(n0 + 1)
  assert.ok(!String(h1.body.message).includes('[Instruction]'), 'an English message from a Korean-mode person keeps its language')
  assert.equal(h1.body.metadata.language, 'ko')
  h1.push({ type: 'token', content: 'Done.' }); h1.end()
  await p1
  const p2 = runTurn({ user, session, threadId: tid, text: 'https://medium.com/@kim/agents-need-plans' })
  const h2 = await nth(n0 + 2)
  assert.match(String(h2.body.message), /\[Instruction\] 언어: 한국어/)
  h2.push({ type: 'token', content: '요약했어요.' }); h2.end()
  await p2
})

test('TP-I-07 (#7) 「멈췄어요」를 쓸 수 없어도 턴의 끝이 나가고 진행 상태가 남지 않는다', { skip: !up }, async () => {
  routerReply = (t) => (t.includes('slow-7') ? { delay: 6000, content: 'DELEGATE' } : { content: 'DELEGATE' })
  const tid = await chatThread()
  const seen = []
  const off = subscribe(user.id, { write: (line) => { const t = /^event: (.*)$/m.exec(line)?.[1]; const d = /^data: (.*)$/m.exec(line)?.[1]; if (t?.startsWith('turn.')) seen.push({ t, d: JSON.parse(d) }) } })
  const p = runTurn({ user, session, threadId: tid, text: '정리해 줘 slow-7' }).then(() => null, (e) => e)
  await until(() => llm.router.some((r) => r.text.includes('slow-7')))
  const turnId = seen.find((e) => e.t === 'turn.start' && e.d.threadId === tid)?.d.turnId
  assert.ok(turnId)
  // the room goes away (its messages with it): the 「멈췄어요」 message cannot be written
  await q('delete from pro_threads where id=$1', [tid])
  await stopTurns({ user, session, threadId: tid })
  const err = await p
  off()
  assert.ok(err instanceof Error, 'the turn failed to write its message')
  assert.ok(seen.some((e) => e.t === 'turn.end' && e.d.turnId === turnId && e.d.state === 'stopped'), JSON.stringify(seen.map((e) => e.t)))
  assert.equal(TP.snapshot(user.id, tid).length, 0)
})

test('TP-I-09 (#9) 질문 카드에 대한 「아니요」 읽기가 4.2초 걸려도 읽힌다', { skip: !up }, async () => {
  const { readAnswer } = await import('../lib/followups.js')
  const tid = await chatThread()
  const [said] = await q(`insert into pro_messages(thread_id,role,kind,content,created_at) values ($1,'user','text','{"text":"보고서 써 줘"}', now() - interval '10 seconds') returning id`, [tid])
  await q(`insert into pro_messages(thread_id,role,kind,content) values ($1,'agent','followup',$2)`, [tid, { text: '메일로도 보내 드릴까요?', state: 'pending', followupId: crypto.randomUUID() }])
  const [now] = await q(`insert into pro_messages(thread_id,role,kind,content) values ($1,'user','text','{"text":"아니요"}') returning id`, [tid])
  // the answer reading takes 4.2 s and says decline (B)
  oddsReply = (prompt) => (prompt.includes('메일로도 보내 드릴까요?') ? { letter: 'B', delay: 4200 } : { letter: [...prompt.matchAll(/^([A-Z])\) /gm)].map((m) => m[1]).at(-1) || 'A' })
  const t0 = Date.now()
  const r = await readAnswer(user, tid, now.id, '아니요', false)
  assert.ok(Date.now() - t0 >= 4100)
  assert.deepEqual(r, { decline: true })
  assert.ok(said.id)
})
