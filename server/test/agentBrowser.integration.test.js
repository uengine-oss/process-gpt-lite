// 에이전트가 턴 도중에 내장 브라우저를 부른다 — 실제 DB · 실제 로그인 토큰 · 실제 HTTP MCP(/mcp/browser) · 실제 Chromium, 모델 없이
// (2026-11-28 운영: 노트북엘엠에 넣어 달라는 요청에 deepagents 가 브라우저를 못 띄우고 reportlab 으로 PDF 를 만들기 시작했다).
//   · deepagents 는 흉내 낸 스트림(fetch 가로채기) — 시험이 그 스트림 도중에 사람의 토큰 + X-Conversation-Id 로 /mcp/browser 를 부른다
//   · 브라우저 에이전트 · 앞단 계획 · 라우터 · 계획 지킴이는 가짜 모델(HTTP), 판정은 가짜 판정 서버
//   · 사이트는 test/fixtures/studio.mjs(생성을 누르면 몇 초 뒤 다운로드가 생기는 스튜디오)
//   AB-I-01 사람의 메시지에 답하는 턴 도중: 작업 카드가 그 방에 곧바로 서고(목표에 「읽기만」 없음), 계획 카드에 「에이전트 · 브라우저」, 결과는
//           요약 · 메모 · 주소 · 페이지 글 · 받은 파일(파일 카드와 같은 것), 작업이 끝나도 턴이 도는 동안 방은 「일하는 중」, 답은 카드 뒤
//   AB-I-02 다른 사람의 대화 id → 거절(카드 없음) · 다른 사람의 작업 id 로 기다리기 → 없음
//   AB-I-03 턴이 끝난 뒤의 같은 대화(사람이 없음) → 읽기만
//   AB-I-04 오래 걸리는 작업: 4분 안(시험은 1.5초)에 running + task_id 로 돌아오고, 말 전하기는 카드에 「에이전트가 전한 말」, 턴이 먼저 끝나면
//           작업이 끝난 뒤 같은 대화로 이어 하기 한 번(Lite 가 보냄 · composed), 두 번은 없다
// 시험 사람은 고정 주소의 시험 계정(pro-rt-agentbrowser-*), 끝나면 그 사람의 방 · 메시지를 지운다. DB 가 없으면 건너뜀.
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import express from 'express'
import { startStudio } from './fixtures/studio.mjs'
// (this test's made-up site runs on this machine: the server's browser may open it — lib/privateNet.js)
process.env.PRO_BROWSER_PRIVATE_ALLOW = '127.0.0.1,localhost'

// ---- the judge: the page check says the page is fine, a page that is generating is busy; anything else the default ----
const judgeServer = await new Promise((r) => {
  const s = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      if (!req.url.startsWith('/judge')) { res.writeHead(404); return res.end() }
      const keys = (JSON.parse(raw).options || []).map((o) => o.key)
      const p = keys.includes('login_needed') ? { ok: 1 } : keys.includes('idle') ? { busy: 1 } : keys.includes('none') ? { none: 1 } : keys.includes('new') ? { new: 1 } : { other: 1 }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ probabilities: p, model: 'scripted' }))
    })
  })
  s.listen(0, '127.0.0.1', () => r(s))
})

// ---- the model: the front plan, the router (DELEGATE), the plan guard, the browser's plan and its agent (by the task's goal) ----
const scripts = {} // goal's first line → (body) => [tool, args]
const lastPage = (b) => { const m = [...b.messages].reverse().find((x) => x.role === 'user' && typeof x.content === 'string' && x.content.startsWith('{')); return m ? JSON.parse(m.content.split('\n')[0]) : { els: [], text: '' } }
const el = (b, text) => lastPage(b).els.find((e) => e.text === text || e.name === text)
// the studio: 생성 → wait while 「생성 중」 → 다운로드 → finish (read from the page each time: a look again after words passed on is the same move)
function studio(summary) {
  const s = { gen: false, dl: false }
  return (b) => {
    const page = lastPage(b)
    if (s.dl) return ['finish', { summary }]
    const dl = el(b, '다운로드')
    if (dl) { s.dl = true; return ['click', { i: dl.i }] }
    if (String(page.text || '').includes('생성 중')) return ['wait_for_page', { minutes: 1, gone_text: '생성 중' }]
    if (!s.gen) { s.gen = true; return ['click', { i: el(b, '생성').i }] }
    return ['wait_for_page', { minutes: 1, until_text: '완료' }]
  }
}
const llm = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => { raw += c })
  req.on('end', () => {
    const b = JSON.parse(raw || '{}')
    const sys = String(b.messages?.[0]?.content || '')
    const names = (b.tools || []).map((t) => t.function?.name)
    let message
    if (b.logprobs) message = { content: 'B' }
    else if (sys.includes('what you understood and how the work will go')) message = { content: JSON.stringify({ understood: '스튜디오에서 보고서를 만들어 받아 드릴게요.', steps: ['스튜디오에서 보고서 만들기', '파일 받기'], tier: 'standard', certainty: 'sure' }) }
    else if (/Break a web task/.test(sys)) message = { content: JSON.stringify({ title: String(b.messages[1].content).split('\n')[0].slice(0, 30), steps: ['생성', '기다리기', '받기'] }) }
    else if (names.includes('finish')) {
      const goal = (/Goal: (.*)/.exec(sys)?.[1] || '').trim()
      const move = scripts[goal]?.(b) || ['finish', { summary: '끝났어요.' }]
      message = { content: null, tool_calls: [{ id: `c_${crypto.randomUUID().slice(0, 8)}`, type: 'function', function: { name: move[0], arguments: JSON.stringify(move[1]) } }] }
    } else if (names.length) message = { content: 'DELEGATE' }
    else if (sys.includes("You watch an assistant's work")) message = { content: JSON.stringify({ off: false, kind: 'none', confidence: 0.1, steps: [{ n: 1, state: 'done' }, { n: 2, state: 'done' }] }) }
    else message = { content: b.response_format ? '{}' : 'OK' }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { role: 'assistant', ...message }, finish_reason: 'stop' }] }))
  })
})
await new Promise((r) => llm.listen(0, '127.0.0.1', r))
const NOWHERE = 'http://127.0.0.1:9'
Object.assign(process.env, {
  PRO_LLM_BASE_URL: `http://127.0.0.1:${llm.address().port}/v1`, PRO_LLM_API_KEY: 'test', PRO_LLM_KEYS: 'off',
  PRO_JUDGE_URL: `http://127.0.0.1:${judgeServer.address().port}/judge`, PRO_JUDGE_LLM: '0', PRO_EMBED_URL: '',
  PRO_CONTEXT_ROUTER_URL: '', PRO_DEEPAGENTS_URL: 'http://127.0.0.1:9', PRO_MCP_HUB_URL: NOWHERE, PRO_COMPLETION_URL: NOWHERE, PRO_MEMENTO_URL: NOWHERE,
  PRO_ONTOLOGY_BOLT_URL: '', PRO_BROWSER_SKILLS_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'ab-int-skills-')),
})
delete process.env.PRO_BROWSER_TOOL_MS
delete process.env.PRO_BROWSER_HANDBACK

const { config } = await import('../config.js')
const { q, pool, sessionFor } = await import('../lib/supa.js')
const turns = await import('../lib/turns.js')
const TP = await import('../lib/turnPlan.js')
const { runTurn } = await import('../lib/agent.js')
const browser = await import('../lib/browser.js')
const { mountConnectors } = await import('../mcp/connectors.js')
const { mainThread } = await import('../lib/store.js')

const up = await q('select 1').then(() => true, () => false)

// ---- a scripted deepagents: every /chat/stream call is a stream the test writes into ----
const realFetch = globalThis.fetch
const streams = []
let wake = []
const enc = new TextEncoder()
const json = (v) => new Response(JSON.stringify(v), { headers: { 'Content-Type': 'application/json' } })
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url)
  if (u.startsWith(config.deepagentsUrl)) {
    const body = opts.body ? JSON.parse(opts.body) : {}
    if (u.endsWith('/chat/stream')) {
      let ctl
      const h = { body, closed: false }
      const rs = new ReadableStream({ start(c) { ctl = c } })
      h.push = (data) => { if (!h.closed) ctl.enqueue(enc.encode(`event: message\ndata: ${JSON.stringify(data)}\n\n`)) }
      h.meta = (conv) => ctl.enqueue(enc.encode(`event: metadata\ndata: ${JSON.stringify({ conversation_id: conv })}\n\n`))
      h.end = () => { if (!h.closed) { h.closed = true; ctl.close() } }
      opts.signal?.addEventListener('abort', () => { if (!h.closed) { h.closed = true; ctl.error(Object.assign(new Error('aborted'), { name: 'AbortError' })) } })
      streams.push(h)
      for (const w of wake.splice(0)) w()
      return new Response(rs, { headers: { 'Content-Type': 'text/event-stream' } })
    }
    return json({ stopped: false })
  }
  if (/\/servers$|\/bindings$/.test(u)) return json([])
  return realFetch(url, opts)
}
const nth = async (n, ms = 20000) => { const end = Date.now() + ms; while (streams.length < n) { if (Date.now() > end) throw new Error(`no stream #${n}`); await new Promise((r) => { wake.push(r); setTimeout(r, 200) }) } return streams[n - 1] }
const until = async (fn, ms = 20000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return v; await new Promise((r) => setTimeout(r, 50)) } }
const answer = (h, text) => { h.push({ type: 'token', content: text }); h.push({ type: 'done', content: text }); h.end() }

// ---- Lite's MCP route, on a port of its own ----
let mcpUrl, server, site
async function mcp(jwt, conv, name, args) {
  const r = await realFetch(`${mcpUrl}/mcp/browser`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${jwt}`, ...(conv ? { 'X-Conversation-Id': conv } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })
  const j = await r.json()
  const text = j.result?.content?.[0]?.text || j.error?.message || ''
  let out = text
  try { out = JSON.parse(text) } catch { /* an error's words */ }
  return { error: !!(j.error || j.result?.isError), out, text }
}

const A_MAIL = 'pro-rt-agentbrowser-a@uengine.org', B_MAIL = 'pro-rt-agentbrowser-b@uengine.org'
let A, B, aSession, bSession, mainA
const msgs = (tid) => q('select id, role, kind, content, created_at from pro_messages where thread_id=$1 order by created_at, id', [tid])
const tasksOf = async (userId) => q(`select m.id, m.thread_id, m.content from pro_messages m join pro_threads t on t.id=m.thread_id where t.user_id=$1 and m.kind='task' order by m.created_at`, [userId])

before(async () => {
  if (!up) return
  browser.WAIT.everyMs = 150
  site = await startStudio()
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  mountConnectors(app)
  server = http.createServer(app)
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  mcpUrl = `http://127.0.0.1:${server.address().port}`
  ;({ user: A, session: aSession } = await sessionFor(A_MAIL, '시험 에이'))
  ;({ user: B, session: bSession } = await sessionFor(B_MAIL, '시험 비'))
  for (const u of [A, B]) {
    await q('delete from pro_messages where thread_id in (select id from pro_threads where user_id=$1)', [u.id])
    await q('delete from pro_threads where user_id=$1', [u.id])
  }
  mainA = (await mainThread(A.id)).id
})
after(async () => {
  globalThis.fetch = realFetch
  for (const h of streams) h.end?.()
  if (up && A) {
    for (const u of [A, B]) {
      await browser.close(u.id).catch(() => {})
      fs.rmSync(path.join(browser.PROFILES, u.id), { recursive: true, force: true })
      await q('delete from pro_messages where thread_id in (select id from pro_threads where user_id=$1)', [u.id])
      await q('delete from pro_threads where user_id=$1', [u.id])
      await q('delete from context_threads where user_id=$1', [u.id]).catch(() => {})
    }
  }
  await site?.close()
  server?.close()
  llm.close()
  judgeServer.close()
  await pool.end()
})

const CONV = `conv-ab-${crypto.randomBytes(3).toString('hex')}`
const SAID = '스튜디오 사이트에서 오디오 보고서를 만들어서 받아 줘'

test('AB-I-01 사람의 턴 도중의 browser_task: 카드가 그 방에 곧바로, 사람의 것으로 돌고, 결과가 에이전트에게 — 답은 카드 뒤', { skip: !up }, async () => {
  const GOAL = '스튜디오에서 오디오 보고서를 생성하고 다운로드한다'
  scripts[GOAL] = studio('오디오 보고서를 만들어 받았어요.')
  const p = runTurn({ user: { id: A.id, email: A_MAIL, name: '시험 에이' }, session: aSession, threadId: mainA, text: SAID })
  const h = await nth(1)
  h.meta(CONV)
  const turn = await until(() => turns.agentTurnsOf(A.id).find((t) => t.conv === CONV))
  assert.ok(turn, '에이전트 턴이 그 대화를 안다')
  h.push({ type: 'tool_start', tool: 'browser_task', input: { goal: GOAL, start_url: `${site.url}?ms=1500` } })
  const call = mcp(aSession.access_token, CONV, 'browser_task', { goal: GOAL, start_url: `${site.url}?ms=1500` })
  // the card is in the person's room at once, while the agent's turn is still working
  const card = await until(async () => (await msgs(mainA)).find((m) => m.kind === 'task'))
  assert.ok(card, '작업 카드')
  assert.ok(!turn.finished, '턴이 아직 돈다')
  assert.equal(card.content.goal, GOAL, '사람의 작업 — 「읽기만」 꼬리가 없다')
  assert.ok(await until(() => TP.viewOf(turn)?.handler?.label === '에이전트 · 브라우저'), `계획 카드의 처리 줄: ${TP.viewOf(turn)?.handler?.label}`)
  const r = await call
  assert.equal(r.error, false, r.text)
  assert.equal(r.out.state, 'done', r.text)
  assert.equal(r.out.task_id, card.id)
  assert.match(r.out.summary, /^오디오 보고서를 만들어 받았어요\./)
  assert.ok(r.out.url.startsWith(site.url))
  assert.match(r.out.page_text, /완료/)
  assert.equal(r.out.files?.length, 1)
  assert.match(r.out.files[0].name, /오디오 보고서\.pdf$/)
  const fileCard = (await msgs(mainA)).find((m) => m.kind === 'file' && m.content.taskId === card.id)
  assert.equal(fileCard.content.url, r.out.files[0].url, '받은 파일 = 채팅의 파일 카드')
  assert.match(r.out.files_note, /already in the chat/)
  // the task is over but the turn goes on: the room still says 「working」
  assert.equal((await until(async () => (await q('select status from pro_threads where id=$1', [mainA]))[0].status === 'working')), true)
  h.push({ type: 'tool_end', tool: 'browser_task', output: r.text })
  answer(h, `스튜디오에서 ${r.out.summary}`)
  const done = await p
  const all = await msgs(mainA)
  const at = (m) => all.findIndex((x) => x.id === m.id)
  assert.ok(at(card) < at(done), '답은 작업 카드 뒤')
  assert.match(done.content.text, /오디오 보고서를 만들어 받았어요/)
  assert.match(done.content.plan?.handler?.label || '', /에이전트 · 브라우저/, '답이 남긴 계획에도')
})

test('AB-I-02 다른 사람의 대화 id 는 거절 · 다른 사람의 작업 id 로는 기다릴 수 없다', { skip: !up }, async () => {
  const [bt] = await q(`insert into pro_threads(user_id, kind, title, conversation_id) values ($1,'chat','비의 방',$2) returning id`, [B.id, `${CONV}-b`])
  const before = (await tasksOf(A.id)).length + (await tasksOf(B.id)).length
  const r = await mcp(aSession.access_token, `${CONV}-b`, 'browser_task', { goal: '비의 방에서 읽기', start_url: site.url })
  assert.equal(r.error, true)
  assert.match(r.text, /이 대화를 이 계정에서 찾지 못해 브라우저 작업을 시작하지 않았어요/)
  assert.equal((await tasksOf(A.id)).length + (await tasksOf(B.id)).length, before, '어느 방에도 카드가 없다')
  assert.equal((await msgs(bt.id)).length, 0)
  const [card] = await tasksOf(A.id)
  const w = await mcp(bSession.access_token, null, 'browser_task_wait', { task_id: card.id, seconds: 1 })
  assert.equal(w.error, true)
  assert.match(w.text, /그 task_id 를 찾지 못했어요/)
  const s = await mcp(bSession.access_token, null, 'browser_task_say', { task_id: card.id, text: '멈춰' })
  assert.equal(s.error, true)
  // the owner may
  const mine = await mcp(aSession.access_token, null, 'browser_task_wait', { task_id: card.id, seconds: 1 })
  assert.equal(mine.out.state, 'done')
})

test('AB-I-03 턴이 끝난 뒤 같은 대화에서 부르면 사람이 없으니 읽기만', { skip: !up }, async () => {
  const GOAL = '스튜디오 첫 화면의 제목을 읽는다'
  scripts[GOAL] = (b) => (lastPage(b).els.length && !b.messages.some((m) => m.role === 'tool') ? ['note', { text: `제목: ${lastPage(b).title}` }] : ['finish', { summary: '제목은 스튜디오예요.' }])
  const r = await mcp(aSession.access_token, CONV, 'browser_task', { goal: GOAL, start_url: site.url })
  assert.equal(r.error, false, r.text)
  assert.match(r.out.note || '', /only reads/)
  const card = (await tasksOf(A.id)).at(-1)
  assert.equal(card.thread_id, mainA, '그 대화의 방')
  assert.match(card.content.goal, /^스튜디오 첫 화면의 제목을 읽는다\n\n\(읽기만 하세요/)
})

test('AB-I-04 오래 걸리는 작업: running 으로 돌아오고, 말 전하기는 카드에, 턴이 먼저 끝나면 같은 대화로 한 번 이어 하기', { skip: !up }, async () => {
  process.env.PRO_BROWSER_TOOL_MS = '1500'
  const GOAL = '스튜디오에서 긴 오디오 보고서를 생성하고 다운로드한다'
  scripts[GOAL] = studio('긴 오디오 보고서를 받았어요.')
  const n0 = streams.length
  const p = runTurn({ user: { id: A.id, email: A_MAIL, name: '시험 에이' }, session: aSession, threadId: mainA, text: '스튜디오에서 긴 오디오 보고서도 만들어 받아 줘' })
  const h = await nth(n0 + 1)
  assert.equal(h.body.conversation_id, CONV, '같은 대화')
  await until(() => turns.agentTurnsOf(A.id).find((t) => t.conv === CONV))
  const t0 = Date.now()
  const r = await mcp(aSession.access_token, CONV, 'browser_task', { goal: GOAL, start_url: `${site.url}?ms=6000` })
  assert.ok(Date.now() - t0 < 5000, '시간 안에 돌아온다')
  assert.equal(r.out.state, 'running', r.text)
  assert.ok(r.out.task_id)
  assert.match(r.out.note, /browser_task_wait/)
  // words passed on: on the card as the agent's, never as the person's
  const s = await mcp(aSession.access_token, CONV, 'browser_task_say', { task_id: r.out.task_id, text: '파일 이름은 그대로 두세요' })
  assert.equal(s.out.ok, true, s.text)
  const steered = await until(async () => (await q('select content from pro_messages where id=$1', [r.out.task_id]))[0].content.steered)
  assert.deepEqual({ text: steered.text, by: steered.by }, { text: '파일 이름은 그대로 두세요', by: 'agent' })
  // the agent ends its turn before the task does
  answer(h, '스튜디오에서 만들고 있어요. 끝나면 이어서 할게요.')
  await p
  // …the task ends, and the agent is handed its result in the same conversation, once
  const hb = await nth(n0 + 2, 60000)
  assert.equal(hb.body.conversation_id, CONV)
  assert.match(hb.body.message, /\(Lite 가 보낸 메시지예요\. 사람이 쓴 말이 아니에요\.\)/)
  assert.match(hb.body.message, new RegExp(`\\[browser_task ${r.out.task_id}\\] state: done`))
  assert.match(hb.body.message, /summary: 긴 오디오 보고서를 받았어요\./)
  assert.match(hb.body.message, /오디오 보고서\.pdf/)
  const said = await until(async () => (await msgs(mainA)).filter((m) => m.role === 'user').at(-1))
  assert.deepEqual(said.content.handback, { taskId: r.out.task_id, title: said.content.handback.title })
  assert.equal(said.content.composed, true)
  assert.match(said.content.text, /^브라우저 작업 「.+」이\(가\) 끝났어요\. 결과를 보고 남은 일을 이어서 해 주세요\.$/)
  answer(hb, '긴 오디오 보고서를 받았어요. 이어서 정리했어요.')
  await until(async () => (await msgs(mainA)).some((m) => m.role === 'agent' && m.kind === 'text' && /이어서 정리했어요/.test(m.content.text)))
  // never twice
  await new Promise((ok) => setTimeout(ok, 1500))
  assert.equal(streams.length, n0 + 2)
  delete process.env.PRO_BROWSER_TOOL_MS
})
