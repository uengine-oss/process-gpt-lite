// 바로잡는 말로 시작한 브라우저 작업은 앞의 에이전트 턴을 대신한다 (녹화 2026-11-21: 「노트북엘엠 사이트에 들어가서
// 생성해야」 뒤에도 앞의 에이전트가 PowerPoint 를 끝까지 만들어 「완료했습니다」로 먼저 끝났다).
//   · 판단(lib/turns.js): 프로젝트 방은 늘 멈춤, 메인 채팅은 링크·파일 없는 짧은 말만 판정에 묻고 0.7 이상일 때만
//   · 실제 DB 위에서, deepagents 를 흉내 낸 스트림으로: 앞의 턴은 /chat/stop 으로 멈추고 이유 문구로 끝난다,
//     기다리던 턴은 에이전트에 가지 않는다, 바로잡는 말의 브라우저 작업은 앞서 올린 링크를 안다
//   · 방 규칙의 할 일에서 사람이 이름 댄 서비스(NotebookLM)가 빠지지 않는다
// 데이터베이스가 없으면 DB 시험은 건너뜀. 시험 사용자는 무작위 id(로그인 계정 아님), 끝나면 지움.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// like production: no context router (the main chat is one conversation), the judge answers by its server (scripted here)
process.env.PRO_CONTEXT_ROUTER_URL = ''
process.env.PRO_JUDGE_URL = 'http://judge.test/judge'
const { config } = await import('../config.js')
const { q, pool } = await import('../lib/supa.js')
const T = await import('../lib/turns.js')
const { keepNamed } = await import('../lib/roomRules.js')
const { NOTEBOOK_URL } = await import('../lib/browserGuides.js')

const up = await q('select 1').then(() => true, () => false)

// ---- a scripted deepagents, model and judge ----
const realFetch = globalThis.fetch
const streams = []
const stops = []
const judged = [] // probabilities the judge answers, in order
const judgeCalls = []
const plans = [] // browser plans held until the test lets them go
let wake = []
const enc = new TextEncoder()
const json = (v) => new Response(JSON.stringify(v), { headers: { 'Content-Type': 'application/json' } })
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url)
  if (u.startsWith(config.deepagentsUrl)) {
    const body = opts.body ? JSON.parse(opts.body) : {}
    if (u.endsWith('/chat/stop')) {
      stops.push(body.conversation_id)
      const h = streams.find((s) => s.body.conversation_id === body.conversation_id && !s.closed)
      if (h) { h.push('message', { type: 'error', error: 'turn cancelled' }); h.end() }
      return json({ stopped: !!h })
    }
    if (u.endsWith('/chat/stream')) {
      let ctl
      const h = { body, closed: false }
      const rs = new ReadableStream({ start(c) { ctl = c } })
      h.push = (event, data) => ctl.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
      h.end = () => { if (!h.closed) { h.closed = true; ctl.close() } }
      opts.signal?.addEventListener('abort', () => { if (!h.closed) { h.closed = true; ctl.error(Object.assign(new Error('aborted'), { name: 'AbortError' })) } })
      if (body.conversation_id) h.push('metadata', { conversation_id: body.conversation_id })
      streams.push(h)
      for (const w of wake.splice(0)) w()
      return new Response(rs, { headers: { 'Content-Type': 'text/event-stream' } })
    }
    return json([])
  }
  if (u === process.env.PRO_JUDGE_URL) {
    judgeCalls.push(JSON.parse(opts.body))
    return json({ probabilities: judged.shift() || { new: 1 }, model: 'scripted' })
  }
  if (u.startsWith(config.llm.baseUrl)) {
    const body = JSON.parse(opts.body)
    const sys = String(body.messages?.[0]?.content || '')
    const answer = (content) => json({ choices: [{ message: { role: 'assistant', content } }] })
    if (/Break a web task/.test(sys)) return new Promise((go) => plans.push(() => go(answer(JSON.stringify({ title: '노트북 작업', steps: ['열기'] })))))
    return answer('DELEGATE')
  }
  if (/\/servers$|\/bindings$/.test(u)) return json([])
  return realFetch(url, opts)
}
const nth = async (n) => { while (streams.length < n) await new Promise((r) => wake.push(r)); return streams[n - 1] }
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return v; await new Promise((r) => setTimeout(r, 30)) } }

const { runTurn } = await import('../lib/agent.js')
const browser = await import('../lib/browser.js')

const stamp = crypto.randomBytes(3).toString('hex')
const user = { id: crypto.randomUUID(), email: `pro-nb1121-route-${stamp}@uengine.org`, name: '시험' }
const session = { access_token: 'test-token' }
const threads = []
async function thread(kind, conv) {
  const [t] = await q(`insert into pro_threads(user_id,kind,title,conversation_id) values ($1,$2,'시험',$3) returning id`, [user.id, kind, conv])
  threads.push(t.id)
  return t.id
}
const msgs = (tid) => q('select id, role, kind, content from pro_messages where thread_id=$1 order by created_at', [tid])
const REPLACED = 'NotebookLM에서 하라는 말씀에 따라 앞의 작업은 멈췄어요.'
// the browser task a message started: its card, then cancelled before its plan is back (no page is opened)
async function cardOf(tid) {
  const card = await until(async () => (await msgs(tid)).filter((m) => m.kind === 'task' && m.content.state !== 'cancelled').at(-1))
  assert.ok(card, '브라우저 작업 카드')
  assert.ok(await until(() => browser.cancel(user.id, card.id)), '계획 중에 취소')
  await until(() => plans.length)
  for (const go of plans.splice(0)) go()
  await until(async () => (await msgs(tid)).find((m) => m.id === card.id && m.content.state === 'cancelled'))
  return card
}

after(async () => {
  globalThis.fetch = realFetch
  await browser.close(user.id).catch(() => {})
  fs.rmSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.browser-profiles', user.id), { recursive: true, force: true })
  if (up && threads.length) await q('delete from pro_threads where id = any($1)', [threads])
  await pool.end()
})

// ---------- the decision, without a database ----------
test('판단: 앞에 에이전트 턴이 없으면 그대로, 프로젝트 방은 멈춤, 메인 채팅은 짧고 링크·파일 없는 말만 판정에 묻는다', () => {
  const ahead = [{ title: '영상으로 슬라이드' }]
  assert.equal(T.replaceRule({ room: true, text: '노트북엘엠 사이트에 들어가서 생성해야', ahead: [] }), 'keep')
  assert.equal(T.replaceRule({ room: true, text: '노트북엘엠 사이트에 들어가서 생성해야', ahead }), 'stop')
  assert.equal(T.replaceRule({ room: true, text: 'https://youtu.be/x 이것도', ahead }), 'stop', '프로젝트 방은 대화가 하나')
  assert.equal(T.replaceRule({ room: false, text: '노트북엘엠 사이트에 들어가서 해', ahead }), 'ask')
  assert.equal(T.replaceRule({ room: false, text: '노트북엘엠으로 https://youtu.be/x 슬라이드', ahead }), 'keep', '자기 링크가 있으면 따로 시키는 일')
  assert.equal(T.replaceRule({ room: false, text: '노트북엘엠에서 해', files: [{ name: 'a.pdf' }], ahead }), 'keep', '자기 파일이 있으면 따로 시키는 일')
  assert.equal(T.replaceRule({ room: false, text: `노트북엘엠에서 ${'아주 긴 설명 '.repeat(12)}`, ahead }), 'keep', '긴 말은 새 요청')
})

test('판정 결과: 0.7 이상인 그 요청 하나만, 새 요청이 더 크거나 0.7 미만이면 없음', () => {
  const shown = [{ id: 'a' }, { id: 'b' }]
  assert.deepEqual(T.pickReplaced(shown, { t0: 0.1, t1: 0.85, new: 0.05 }).map((x) => x.id), ['b'])
  assert.deepEqual(T.pickReplaced(shown, { t0: 0.6, t1: 0.1, new: 0.3 }), [])
  assert.deepEqual(T.pickReplaced(shown, { t0: 0.7, new: 0.3 }).map((x) => x.id), ['a'])
  assert.deepEqual(T.pickReplaced(shown, { new: 0.95 }), [])
  assert.deepEqual(T.pickReplaced(shown, null), [])
  assert.equal(T.judgedAhead([1, 2, 3, 4, 5]).length, T.JUDGE_AHEAD)
})

test('대상: 이 방의 앞선 에이전트 턴만(돌거나 기다리는 것), 이미 멈춘 것·다른 방·뒤에 온 것·에이전트 아닌 것은 아님', () => {
  const a = T.enqueue({ userId: 'u', threadId: 't', conv: 'c' }); a.agent = true; a.started = true
  const w = T.enqueue({ userId: 'u', threadId: 't', conv: 'c' }); w.agent = true
  const x = T.enqueue({ userId: 'u', threadId: 'other', conv: 'd' }); x.agent = true
  const s = T.enqueue({ userId: 'u', threadId: 't', conv: 'c' }); s.agent = true; s.stopped = true
  const b = T.enqueue({ userId: 'u', threadId: 't' }); b.setConv(`none:${b.id}`) // a message answered here (the browser one)
  const later = T.enqueue({ userId: 'u', threadId: 't', conv: 'c' }); later.agent = true
  assert.deepEqual(T.agentTurnsAhead({ userId: 'u', threadId: 't', before: b }).map((t) => t.id), [a.id, w.id])
  for (const t of [a, w, x, s, b, later]) t.finish()
  assert.equal(T._live.size, 0)
})

test('방 규칙의 할 일: 사람이 이름 댄 NotebookLM 이 빠지면 붙이고, 있으면 그대로', () => {
  const said = '이 방에서 내가 주는 url이 있으면 그거를 받아다가 노트북엘엠으로 슬라이드를 만들고 그 팟캐스트를 하나 만들어 주면 돼'
  assert.equal(keepNamed(said, '이 링크나 파일로 PowerPoint 슬라이드를 만들고 팟캐스트 대본을 쓴다.'), '이 링크나 파일로 PowerPoint 슬라이드를 만들고 팟캐스트 대본을 쓴다 (NotebookLM 에서)')
  assert.equal(keepNamed(said, '이 링크나 파일로 노트북엘엠에서 슬라이드를 만든다'), '이 링크나 파일로 노트북엘엠에서 슬라이드를 만든다')
  assert.equal(keepNamed('이 방에 올리는 링크는 요약해 줘', '이 링크를 요약한다'), '이 링크를 요약한다')
  // the real model's answer on 2026-11-21: the name it heard, misspelled
  assert.equal(keepNamed(said, '이 링크나 파일로 노트북엘름으로 슬라이드를 만들고 팟캐스트를 하나 만든다'), '이 링크나 파일로 NotebookLM으로 슬라이드를 만들고 팟캐스트를 하나 만든다')
  assert.equal(keepNamed(said, '이 링크나 파일로 노트북 앨름에서 슬라이드를 만든다'), '이 링크나 파일로 NotebookLM에서 슬라이드를 만든다')
})

// ---------- on the database, with a scripted agent ----------
test('프로젝트 방: 바로잡는 말이 오면 돌던 에이전트 턴은 멈추고 이유를 말하며, 브라우저 작업은 앞서 올린 링크로 NotebookLM 에서', { skip: !up }, async () => {
  const conv = `rt-p-${stamp}`
  const tid = await thread('project', conv)
  const n0 = streams.length
  const p1 = runTurn({ user, session, threadId: tid, text: '이 영상으로 슬라이드와 팟캐스트 만들어 줘 https://youtu.be/rt1121abc' })
  const h1 = await nth(n0 + 1)
  assert.equal(h1.body.conversation_id, conv)
  h1.push('message', { type: 'token', content: '파워포인트를 만들고 있어요.' })
  const ack = await runTurn({ user, session, threadId: tid, text: '노트북엘엠 사이트에 들어가서 생성해야' })
  assert.match(ack.content.text, /NotebookLM/)
  const first = await p1
  assert.deepEqual(stops.slice(-1), [conv], 'deepagents /chat/stop')
  assert.equal(first.content.text, REPLACED)
  assert.equal(first.content.stopped, true)
  assert.equal(first.content.superseded, true)
  assert.equal(first.content.replaced, true)
  assert.match(first.content.partial, /파워포인트를 만들고 있어요/)
  const card = await cardOf(tid)
  assert.equal(card.content.url, NOTEBOOK_URL)
  assert.match(card.content.goal, /^노트북엘엠 사이트에 들어가서 생성해야/)
  assert.match(card.content.goal, /이 방에 앞서 올린 링크: https:\/\/youtu\.be\/rt1121abc/)
  const answers = (await msgs(tid)).filter((m) => m.role === 'agent' && m.kind === 'text').map((m) => m.content.text)
  assert.ok(!answers.some((t) => /완료했습니다/.test(t)), JSON.stringify(answers))
})

test('프로젝트 방: 기다리던 에이전트 턴도 에이전트에 가지 않고 이유로 끝난다', { skip: !up }, async () => {
  const conv = `rt-w-${stamp}`
  const tid = await thread('project', conv)
  const n0 = streams.length
  const p1 = runTurn({ user, session, threadId: tid, text: '이 영상으로 보고서 문서 만들어 줘 https://youtu.be/rt1121w1' })
  const h1 = await nth(n0 + 1)
  const p2 = runTurn({ user, session, threadId: tid, text: '그 보고서 문서도 하나 더 만들어 줘' })
  await until(async () => (await msgs(tid)).find((m) => m.role === 'user' && m.content.queued))
  await runTurn({ user, session, threadId: tid, text: '노트북엘엠에서 해 줘' })
  const [a, b] = await Promise.all([p1, p2])
  assert.equal(a.content.text, REPLACED)
  assert.equal(b.content.text, REPLACED)
  assert.equal(b.content.replaced, true)
  assert.equal(streams.length, n0 + 1, '기다리던 턴은 deepagents 에 가지 않음')
  assert.ok(h1.closed)
  await cardOf(tid)
})

test('메인 채팅: 판정이 바로잡는 말이라 하면(0.7 이상) 그 턴만 멈추고, 아니라 하면 앞의 답은 그대로', { skip: !up }, async () => {
  const conv = `rt-c-${stamp}`
  const tid = await thread('chat', conv)
  // judged a correction
  let n0 = streams.length
  const p1 = runTurn({ user, session, threadId: tid, text: '이 영상으로 슬라이드 만들어 줘 https://youtu.be/rt1121c1' })
  await nth(n0 + 1)
  judged.push({ t0: 0.9, new: 0.1 })
  await runTurn({ user, session, threadId: tid, text: '노트북엘엠 사이트에 들어가서 해' })
  const first = await p1
  assert.equal(first.content.text, REPLACED)
  assert.match(judgeCalls.at(-1).state, /이 영상으로 슬라이드 만들어 줘/)
  assert.match(judgeCalls.at(-1).state, /노트북엘엠 사이트에 들어가서 해/)
  const card1 = await cardOf(tid)
  assert.match(card1.content.goal, /이 방에 앞서 올린 링크: https:\/\/youtu\.be\/rt1121c1/)
  // judged a request of its own: the answer ahead goes on and is kept
  n0 = streams.length
  const p2 = runTurn({ user, session, threadId: tid, text: '이 영상 요약 문서 만들어 줘 https://youtu.be/rt1121c2' })
  const h2 = await nth(n0 + 1)
  judged.push({ t0: 0.3, new: 0.7 })
  const calls = judgeCalls.length
  await runTurn({ user, session, threadId: tid, text: '노트북엘엠 첫 화면 열어 줘' })
  await cardOf(tid)
  assert.equal(judgeCalls.length, calls + 1)
  h2.push('message', { type: 'token', content: '요약 문서를 완료했습니다.' }); h2.end()
  const second = await p2
  assert.equal(second.content.text, '요약 문서를 완료했습니다.')
  assert.equal(second.content.replaced, undefined)
  // a message with a link of its own is never asked about
  n0 = streams.length
  const p3 = runTurn({ user, session, threadId: tid, text: '이 영상으로 보고서 문서 만들어 줘 https://youtu.be/rt1121c3' })
  const h3 = await nth(n0 + 1)
  const before = judgeCalls.length
  await runTurn({ user, session, threadId: tid, text: '노트북엘엠으로 https://youtu.be/rt1121c4 슬라이드' })
  await cardOf(tid)
  assert.equal(judgeCalls.length, before)
  h3.push('message', { type: 'token', content: '보고서를 만들었어요.' }); h3.end()
  assert.equal((await p3).content.text, '보고서를 만들었어요.')
})
