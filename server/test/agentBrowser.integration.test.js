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
const effects = [] // what the effect gate was asked
const judgeServer = await new Promise((r) => {
  const s = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      if (!req.url.startsWith('/judge')) { res.writeHead(404); return res.end() }
      const b = JSON.parse(raw)
      const keys = (b.options || []).map((o) => o.key)
      effects.push({ state: String(b.state || '') })
      // the effect gate (lib/browser.js EFFECT_OPTIONS): removing is outside the person's workspace, generating is in it, the rest only looks
      const control = /Control: "([^"]*)"/.exec(String(b.state || ''))?.[1] || /Web address: "([^"]*)"/.exec(String(b.state || ''))?.[1] || ''
      if (keys.includes('outside')) {
        const p = /삭제|delete|unsubscribe|공유/i.test(control) ? { outside: 0.92 } : /생성/.test(control) ? { own: 0.9 } : { look: 0.9 }
        return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ probabilities: p, model: 'scripted' }))
      }
      const p = keys.includes('login_needed') ? { ok: 1 } : keys.includes('idle') ? { busy: 1 } : keys.includes('none') ? { none: 1 } : keys.includes('new') ? { new: 1 } : { other: 1 }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ probabilities: p, model: 'scripted' }))
    })
  })
  s.listen(0, '127.0.0.1', () => r(s))
})

// ---- the model: the front plan, the router (DELEGATE), the plan guard, the browser's plan and its agent (by the task's goal) ----
const scripts = {} // goal's first line → (body) => [tool, args]
const lastTool = (b) => String([...b.messages].reverse().find((m) => m.role === 'tool')?.content || '')
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
  req.on('end', async () => {
    const b = JSON.parse(raw || '{}')
    const sys = String(b.messages?.[0]?.content || '')
    const names = (b.tools || []).map((t) => t.function?.name)
    let message
    if (b.logprobs) message = { content: 'B' }
    // (the sites the person's words name — lib/agentBrowser.js namedSites: the made-up sites run on this machine)
    else if (sys.includes("Name the website(s) the person's own words ask")) message = { content: JSON.stringify({ sites: /아무 데서나/.test(String(b.messages?.at(-1)?.content || '')) ? [] : ['127.0.0.1'], skills: [] }) }
    else if (sys.includes('what you understood and how the work will go')) message = { content: JSON.stringify({ understood: '스튜디오에서 보고서를 만들어 받아 드릴게요.', steps: ['스튜디오에서 보고서 만들기', '파일 받기'], tier: 'standard', certainty: 'sure' }) }
    else if (/Break a web task/.test(sys)) message = { content: JSON.stringify({ title: String(b.messages[1].content).split('\n')[0].slice(0, 30), steps: ['생성', '기다리기', '받기'] }) }
    else if (names.includes('finish')) {
      const goal = (/Goal: (.*)/.exec(sys)?.[1] || '').trim()
      // (a move may take a while — what the page does meanwhile is part of the check)
      const move = (await scripts[goal]?.(b)) || ['finish', { summary: '끝났어요.' }]
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
  fx.srv?.close()
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
  assert.equal(card.content.byAgent, true, '에이전트가 시작한 작업 — 이어서 해도 그대로')
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

test('AB-I-03 턴이 끝난 뒤 같은 대화에서 부르면 사람이 없으니 읽기만 — 만드는 동작은 하지 않고, 저장된 로그인도 쓰지 않는다', { skip: !up }, async () => {
  const GOAL = '스튜디오 첫 화면의 제목을 읽는다'
  // (the browser's model tries to make something and to fill a saved login: neither happens in a run nobody watches)
  const moves = [(b) => ['click', { i: el(b, '생성').i }], (b) => ['fill_secret', { i: el(b, '파일 고르기').i, field: 'username' }], (b) => ['note', { text: `제목: ${lastPage(b).title}` }], () => ['finish', { summary: '제목은 스튜디오예요.' }]]
  const told = []
  scripts[GOAL] = (b) => { const k = b.messages.filter((m) => m.role === 'tool').length; if (k) told.push(lastTool(b)); return moves[Math.min(k, moves.length - 1)](b) }
  const r = await mcp(aSession.access_token, CONV, 'browser_task', { goal: GOAL, start_url: site.url })
  assert.equal(r.error, false, r.text)
  assert.match(r.out.note || '', /only reads public pages/)
  const card = (await tasksOf(A.id)).at(-1)
  assert.equal(card.thread_id, mainA, '그 대화의 방')
  assert.match(card.content.goal, /^스튜디오 첫 화면의 제목을 읽는다\n\n\(읽기만 하세요/)
  assert.match(told[0], /^not done: nobody is watching this task, so it only reads/, '「생성」은 누르지 않았다')
  assert.match(told[1], /no credential saved/)
  assert.ok(r.out.notes.some((n) => /사람이 없는 작업이라 「생성」은\(는\) 하지 않음/.test(n)), r.out.notes.join(' | '))
  assert.ok(r.out.notes.some((n) => /사람이 없는 작업이라 저장된 로그인를 쓰지 않음/.test(n)), r.out.notes.join(' | '))
  // (the page still waits: 생성 was never pressed)
  assert.match(r.out.page_text, /대기/)
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
  assert.match(hb.body.message, new RegExp(`task_id: ${r.out.task_id} · state: done`))
  assert.match(hb.body.message, /browser_task_wait/)
  // nothing the website wrote is in the message: the agent reads the result as a tool result
  assert.doesNotMatch(hb.body.message, /긴 오디오 보고서를 받았어요|오디오 보고서\.pdf|완료/)
  const said = await until(async () => (await msgs(mainA)).filter((m) => m.role === 'user').at(-1))
  assert.equal(said.content.handback.taskId, r.out.task_id)
  assert.equal(said.content.composed, true)
  assert.equal(said.content.text, '브라우저 작업이 끝났어요. 에이전트가 결과를 읽고 남은 일을 이어서 해요.')
  const read = await mcp(aSession.access_token, CONV, 'browser_task_wait', { task_id: r.out.task_id, seconds: 5 })
  assert.match(read.out.summary, /^긴 오디오 보고서를 받았어요\./)
  assert.match(read.out.files[0].name, /오디오 보고서\.pdf$/)
  answer(hb, '긴 오디오 보고서를 받았어요. 이어서 정리했어요.')
  await until(async () => (await msgs(mainA)).some((m) => m.role === 'agent' && m.kind === 'text' && /이어서 정리했어요/.test(m.content.text)))
  // never twice
  await new Promise((ok) => setTimeout(ok, 1500))
  assert.equal(streams.length, n0 + 2)
  delete process.env.PRO_BROWSER_TOOL_MS
})

test('AB-I-05 에이전트가 시작한 작업: 사람이 말하지 않은 지우기는 승인 카드에서 멈추고(「취소」면 하지 않음), 자기 작업 공간의 생성은 카드 없이', { skip: !up }, async () => {
  const { startNotebooks } = await import('./fixtures/notebooks.mjs')
  const nb = await startNotebooks()
  try {
    const GOAL = '노트북 목록을 정리한다'
    const told = []
    scripts[GOAL] = (b) => {
      const k = b.messages.filter((m) => m.role === 'tool').length
      if (k) told.push(lastTool(b))
      if (k === 0) return ['click', { i: el(b, 'more_vert').i }]
      if (k === 1) return ['click', { i: el(b, 'delete 삭제').i }]
      return ['finish', { summary: /not done/.test(lastTool(b)) ? '지우지 않았어요.' : '지웠어요.' }]
    }
    const n0 = streams.length
    const p = runTurn({ user: { id: A.id, email: A_MAIL, name: '시험 에이' }, session: aSession, threadId: mainA, text: '노트북 사이트의 목록을 보기 좋게 정리해 줘' })
    const h = await nth(n0 + 1)
    await until(() => turns.agentTurnsOf(A.id).find((t) => t.conv === CONV))
    const call = mcp(aSession.access_token, CONV, 'browser_task', { goal: GOAL, start_url: `${nb.url}/notebooks?n=3` })
    // the press waits on the person's approval card, naming the control and the site
    const card = await until(async () => (await msgs(mainA)).find((m) => m.kind === 'choice' && m.content.approval && m.content.state === 'pending'), 30000)
    assert.ok(card, '승인 카드')
    assert.match(card.content.question, /「delete 삭제」을\(를\) 누를까요\? 에이전트가 시작한 작업이라/)
    const task = (await tasksOf(A.id)).at(-1)
    assert.equal(task.content.state, 'needs_input')
    assert.equal(task.content.need, 'approve')
    // the judgment read the person's own words — not the goal the agent wrote
    const asked = effects.filter((e) => e.state.includes('Control: "delete 삭제"')).at(-1).state
    assert.match(asked, /"노트북 사이트의 목록을 보기 좋게 정리해 줘"/)
    assert.doesNotMatch(asked, /노트북 목록을 정리한다/)
    await browser.answerCard(A.id, card.id, '취소')
    const r = await call
    assert.equal(r.out.state, 'done', r.text)
    assert.match(r.out.summary, /^지우지 않았어요\./)
    assert.match(told[1], /^not done: the user declined/)
    assert.equal(r.out.page_text.match(/제목 없는 노트북/g)?.length, 3, '목록은 그대로')
    answer(h, '지우지 않고 그대로 두었어요.')
    await p
  } finally { await nb.close() }
  // making something in the person's own workspace (AB-I-01's 「생성」) went on without a card
  assert.ok(effects.some((e) => e.state.includes('Control: "생성"')))
  const approvals = (await msgs(mainA)).filter((m) => m.kind === 'choice' && m.content.approval)
  assert.equal(approvals.length, 1, '승인 카드는 지우기 하나뿐')
})

test('AB-I-06 멈추기: 그 턴에서 에이전트가 시작한 작업도 멈추고, 이어 하기는 없다', { skip: !up }, async () => {
  process.env.PRO_BROWSER_TOOL_MS = '1500'
  const { stopTurns } = await import('../lib/agent.js')
  const GOAL = '스튜디오에서 멈출 오디오 보고서를 생성한다'
  scripts[GOAL] = studio('받았어요.')
  const n0 = streams.length
  const p = runTurn({ user: { id: A.id, email: A_MAIL, name: '시험 에이' }, session: aSession, threadId: mainA, text: '스튜디오에서 아주 긴 보고서를 만들어 줘' })
  const h = await nth(n0 + 1)
  void h
  await until(() => turns.agentTurnsOf(A.id).find((t) => t.conv === CONV))
  const r = await mcp(aSession.access_token, CONV, 'browser_task', { goal: GOAL, start_url: `${site.url}?ms=20000` })
  assert.equal(r.out.state, 'running', r.text)
  await stopTurns({ user: { id: A.id, email: A_MAIL, name: '시험 에이' }, session: aSession, threadId: mainA })
  await p
  const card = await until(async () => { const [m] = await q('select content from pro_messages where id=$1', [r.out.task_id]); return m.content.state === 'cancelled' ? m : null }, 15000)
  assert.ok(card, '작업 카드가 멈췄다')
  assert.match(card.content.summary, /에이전트의 답을 멈춰서 이 작업도 멈췄어요/)
  await new Promise((ok) => setTimeout(ok, 2000))
  assert.equal(streams.length, n0 + 1, '이어 하기 없음')
  delete process.env.PRO_BROWSER_TOOL_MS
})

// ---- a made-up site for the navigation, upload and cookie checks ----
const fx = { hits: [], srv: null, url: '' }
const SECRET = `person-secret-${crypto.randomBytes(3).toString('hex')}`
async function fixture() {
  if (fx.srv) return fx
  fx.srv = http.createServer((req, res) => {
    fx.hits.push(`${req.method} ${req.url.split('?')[0]}`)
    const page = (body, head = {}) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...head }); res.end(`<!doctype html><html lang="ko"><meta charset="utf-8"><title>시험 사이트</title><body>${body}</body></html>`) }
    if (req.url.startsWith('/form')) return page('<h1>양식</h1><form method="post" action="/submit"><input name="x" value="1" aria-label="값"><button>보내기</button></form>')
    if (req.url.startsWith('/submit')) return page('<p>보냈어요</p>')
    if (req.url.startsWith('/unsubscribe')) return page('<p>구독을 해지했어요</p>')
    if (req.url.startsWith('/set-cookie')) return page('<p>쿠키를 저장했어요</p>', { 'Set-Cookie': `sid=${SECRET}; Path=/; Max-Age=3600` })
    if (req.url.startsWith('/show-cookie')) return page(`<p>cookie: ${String(req.headers.cookie || '(none)').replace(/[<>&]/g, '')}</p>`)
    const other = `http://localhost:${fx.srv.address().port}`
    if (req.url.startsWith('/links')) return page(`<h1>링크</h1><a href="${other}/away">다른 곳으로</a><form action="/stay" method="get"><button type="submit" formaction="${other}/away-form">양식 보내기</button></form>`)
    if (req.url.startsWith('/redirect-during')) return page(`<p>기다리는 화면</p><script>if(!sessionStorage.getItem('d')){sessionStorage.setItem('d','1');setTimeout(()=>{location.href='${other}/landing'},400)}</script>`)
    if (req.url.startsWith('/redirect-later')) return page(`<p>대기 화면</p><button onclick="fetch('/pressed')">누르기</button><script>if(!sessionStorage.getItem('l')){sessionStorage.setItem('l','1');setTimeout(()=>{location.href='${other}/landing'},700)}</script>`)
    if (req.url.startsWith('/landing')) return page('<p>도착</p><button onclick="fetch(\'/pressed\')">누르기</button>')
    if (req.url.startsWith('/share')) return page('<h1>공유</h1><button id="up" onclick="document.getElementById(\'f\').click()">공유하며 올리기</button><input id="f" type="file" hidden>')
    page('<p>시험 사이트</p>')
  })
  await new Promise((r) => fx.srv.listen(0, '127.0.0.1', r))
  fx.url = `http://127.0.0.1:${fx.srv.address().port}`
  return fx
}
const toldOf = (goal) => { const told = []; return { told, script: (moves) => { scripts[goal] = (b) => { const k = b.messages.filter((m) => m.role === 'tool').length; if (k) told.push(lastTool(b)); return moves[Math.min(k, moves.length - 1)](b) } } } }

test('AB-I-07 브라우저의 이동은 웹 주소(http · https)만 — 사람이 채팅에서 시킨 작업에서도, 에이전트가 시작한 작업에서도', { skip: !up }, async () => {
  const f = await fixture()
  const n0 = f.hits.filter((h) => h.startsWith('POST')).length
  // a task the person started in the chat
  const CHAT = '양식 페이지에서 이동해 본다(채팅)'
  const c = toldOf(CHAT)
  c.script([() => ['goto', { url: 'javascript:document.forms[0].submit()' }], () => ['note', { text: '이동하지 않음' }], () => ['finish', { summary: '이동하지 않았어요.' }]])
  const r1 = await browser.runBrowserTask({ userId: A.id, threadId: mainA, goal: CHAT, startUrl: `${f.url}/form`, own: true })
  assert.match(c.told[0], /^refused: the browser only opens web addresses \(http or https\)/)
  assert.equal(r1.state, 'done')
  // a task the agent started (nobody watching here)
  const AGENT = '양식 페이지에서 이동해 본다(에이전트)'
  const a = toldOf(AGENT)
  a.script([() => ['goto', { url: 'javascript:document.forms[0].submit()' }], () => ['goto', { url: 'data:text/html,<p>x</p>' }], () => ['note', { text: '이동하지 않음' }], () => ['finish', { summary: '이동하지 않았어요.' }]])
  const r2 = await mcp(aSession.access_token, null, 'browser_task', { goal: AGENT, start_url: `${f.url}/form` })
  assert.equal(r2.error, false, r2.text)
  assert.match(a.told[0], /^refused: the browser only opens web addresses/)
  assert.match(a.told[1], /^refused: the browser only opens web addresses/)
  // no form request went out
  assert.equal(f.hits.filter((h) => h.startsWith('POST')).length, n0)
  assert.ok(!f.hits.includes('POST /submit'))
})

test('AB-I-08 에이전트가 시작한 작업: 무엇을 하는 주소(구독 해지)를 여는 것은 승인 카드 · 파일 칸이 아닌 단추로 올리기도 승인 카드', { skip: !up }, async () => {
  const f = await fixture()
  const n0 = streams.length
  const p = runTurn({ user: { id: A.id, email: A_MAIL, name: '시험 에이' }, session: aSession, threadId: mainA, text: '시험 사이트에서 목록을 보기 좋게 정리해 줘' })
  const h = await nth(n0 + 1)
  if (!h.body.conversation_id) h.meta(CONV)
  await until(() => turns.agentTurnsOf(A.id).find((t) => t.conv === CONV))
  const GOAL = '시험 사이트의 구독 정리'
  const g = toldOf(GOAL)
  g.script([() => ['goto', { url: `${f.url}/unsubscribe?u=1` }], (b) => ['finish', { summary: /^not done/.test(lastTool(b)) ? '열지 않았어요.' : '열었어요.' }]])
  const call = mcp(aSession.access_token, CONV, 'browser_task', { goal: GOAL, start_url: `${f.url}/` })
  const card = await until(async () => (await msgs(mainA)).find((m) => m.kind === 'choice' && m.content.approval && m.content.state === 'pending' && /unsubscribe/.test(m.content.question)), 30000)
  assert.ok(card, '승인 카드')
  assert.match(card.content.question, /주소를 열까요\? 에이전트가 시작한 작업이라/)
  // the task's card says where it may work (the sites the person's words name)
  const task = (await tasksOf(A.id)).at(-1)
  assert.deepEqual(task.content.sites, ['127.0.0.1'])
  await browser.answerCard(A.id, card.id, '취소')
  const r = await call
  assert.match(r.out.summary, /^열지 않았어요/)
  assert.ok(!f.hits.some((x) => x.startsWith('GET /unsubscribe')), '그 주소는 열리지 않았다')
  assert.ok(f.hits.includes('GET /'), '시작 페이지는 열렸다')
  answer(h, '정리했어요.')
  await p
  // a control that is not a file field, pressed to open the picker: the card too (a task the agent started, with a file of its own)
  const UP = '시험 사이트에 파일 올리기'
  const u = toldOf(UP)
  u.script([(b) => { const e = el(b, '공유하며 올리기'); return e ? ['attach_file', { i: e.i, name: 'a.pdf' }] : ['finish', { summary: '단추가 없어요.' }] }, (b) => ['finish', { summary: /^not done/.test(lastTool(b)) ? '올리지 않았어요.' : '올렸어요.' }]])
  const run = browser.runBrowserTask({ userId: A.id, threadId: mainA, goal: UP, startUrl: `${f.url}/share`, own: true, byAgent: true, said: ['시험 사이트에서 파일 정리해 줘'], sites: ['127.0.0.1'],
    files: [{ name: 'a.pdf', url: 'https://files.example/a.pdf' }] })
  const card2 = await until(async () => (await msgs(mainA)).find((m) => m.kind === 'choice' && m.content.approval && m.content.state === 'pending' && /공유하며 올리기/.test(m.content.question)), 30000)
  assert.ok(card2, '올리기 단추의 승인 카드')
  await browser.answerCard(A.id, card2.id, '취소')
  const r2 = await run
  assert.match(r2.summary, /^올리지 않았어요/)
  assert.match(u.told[0], /^not done: the user declined/)
})

test('AB-I-09 사람이 없는 에이전트의 작업은 그 사람의 브라우저에 저장된 쿠키 · 로그인을 보지 못한다(따로 연 빈 브라우저)', { skip: !up }, async () => {
  const f = await fixture()
  const SET = '쿠키를 저장해 본다', SEE = '쿠키를 본다(채팅)', AGENT = '쿠키를 본다(에이전트)'
  for (const g of [SET, SEE, AGENT]) scripts[g] = (b) => (b.messages.some((m) => m.role === 'tool') ? ['finish', { summary: '봤어요.' }] : ['note', { text: lastPage(b).text || '-' }])
  await browser.runBrowserTask({ userId: A.id, threadId: mainA, goal: SET, startUrl: `${f.url}/set-cookie`, own: true })
  const seen = await browser.runBrowserTask({ userId: A.id, threadId: mainA, goal: SEE, startUrl: `${f.url}/show-cookie`, own: true })
  assert.match(seen.pageText, new RegExp(SECRET), '그 사람의 브라우저에는 쿠키가 있다')
  const r = await mcp(aSession.access_token, null, 'browser_task', { goal: AGENT, start_url: `${f.url}/show-cookie` })
  assert.equal(r.error, false, r.text)
  assert.doesNotMatch(r.out.page_text, new RegExp(SECRET))
  assert.match(r.out.page_text, /cookie: \(none\)/)
  assert.match(r.out.note, /only reads public pages/)
  const card = (await tasksOf(A.id)).at(-1)
  assert.equal(card.content.readOnly, true)
  assert.equal(card.content.where?.why, 'fresh')
  // the person's own browser still has it afterwards (the empty one was its own, and is gone)
  const again = await browser.runBrowserTask({ userId: A.id, threadId: mainA, goal: SEE, startUrl: `${f.url}/show-cookie`, own: true })
  assert.match(again.pageText, new RegExp(SECRET))
})

test('AB-I-10 사람이 말한 사이트 밖: 시작 주소도 주소 열기도 판정과 상관없이 「<호스트> 을(를) 열까요?」 카드 — 「취소」면 열리지 않는다', { skip: !up }, async () => {
  const f = await fixture()
  const other = f.url.replace('127.0.0.1', 'localhost') // the same made-up site under another name: not a site the person named
  const n0 = streams.length
  const p = runTurn({ user: { id: A.id, email: A_MAIL, name: '시험 에이' }, session: aSession, threadId: mainA, text: '시험 사이트에서 목록을 정리해 줘' })
  const h = await nth(n0 + 1)
  if (!h.body.conversation_id) h.meta(CONV)
  await until(() => turns.agentTurnsOf(A.id).find((t) => t.conv === CONV))
  const cardFor = (host) => until(async () => (await msgs(mainA)).find((m) => m.kind === 'choice' && m.content.approval && m.content.state === 'pending' && m.content.question.startsWith(`${host} 을(를) 열까요?`)), 30000)
  // a start address on another host: the card before it is opened
  const START = '다른 이름의 시작 주소'
  scripts[START] = (b) => ['finish', { summary: lastPage(b).url === 'about:blank' || !lastPage(b).url ? '열지 않았어요.' : '열었어요.' }]
  const unsub0 = f.hits.filter((x) => x.startsWith('GET /unsubscribe')).length
  const call = mcp(aSession.access_token, CONV, 'browser_task', { goal: START, start_url: `${other}/unsubscribe?u=2` })
  const c1 = await cardFor('localhost')
  assert.ok(c1, '시작 주소의 카드')
  await browser.answerCard(A.id, c1.id, '취소')
  const r1 = await call
  assert.equal(r1.error, false, r1.text)
  assert.equal(f.hits.filter((x) => x.startsWith('GET /unsubscribe')).length, unsub0, '그 주소는 열리지 않았다')
  // going to another host from a named one: the card, even for a page that only shows something
  const GO = '다른 이름으로 옮겨 가기'
  const g = toldOf(GO)
  g.script([() => ['goto', { url: `${other}/look-only` }], (b) => ['finish', { summary: /^not opened/.test(lastTool(b)) ? '옮기지 않았어요.' : '옮겼어요.' }]])
  const before = effects.length
  const call2 = mcp(aSession.access_token, CONV, 'browser_task', { goal: GO, start_url: `${f.url}/` })
  const c2 = await cardFor('localhost')
  assert.ok(c2, '주소 열기의 카드')
  await browser.answerCard(A.id, c2.id, '취소')
  const r2 = await call2
  assert.match(r2.out.summary, /^옮기지 않았어요/)
  assert.ok(!f.hits.includes('GET /look-only'), '열리지 않았다')
  assert.ok(!effects.slice(before).some((e) => e.state.includes('/look-only')), '판정에 묻지 않고 사람에게')
  answer(h, '정리했어요.')
  await p
})

test('AB-I-11 사람의 말에 사이트가 없는 에이전트 작업은 전체가 임시 브라우저에서 읽기만', { skip: !up }, async () => {
  const f = await fixture()
  const n0 = streams.length
  const p = runTurn({ user: { id: A.id, email: A_MAIL, name: '시험 에이' }, session: aSession, threadId: mainA, text: '아무 데서나 공개된 내용을 찾아 읽어 줘' })
  const h = await nth(n0 + 1)
  if (!h.body.conversation_id) h.meta(CONV)
  await until(() => turns.agentTurnsOf(A.id).find((t) => t.conv === CONV))
  const GOAL = '공개된 쿠키 페이지 읽기'
  scripts[GOAL] = (b) => (b.messages.some((m) => m.role === 'tool') ? ['finish', { summary: '읽었어요.' }] : ['note', { text: lastPage(b).text || '-' }])
  const r = await mcp(aSession.access_token, CONV, 'browser_task', { goal: GOAL, start_url: `${f.url}/show-cookie` })
  assert.equal(r.error, false, r.text)
  assert.match(r.out.note, /name no site to work on/)
  assert.doesNotMatch(r.out.page_text, new RegExp(SECRET), '그 사람의 쿠키가 없는 브라우저')
  const card = (await tasksOf(A.id)).at(-1)
  assert.deepEqual({ readOnly: card.content.readOnly, why: card.content.where?.why }, { readOnly: true, why: 'fresh' })
  answer(h, '읽었어요.')
  await p
})

test('AB-I-12 에이전트가 시작한 작업은 결제 정보를 넣지 않는다', { skip: !up }, async () => {
  const f = await fixture()
  const GOAL = '양식에 카드 번호 넣기'
  const g = toldOf(GOAL)
  g.script([(b) => ['fill_secret', { i: el(b, 'x').i, field: 'card_number' }], () => ['finish', { summary: '넣지 않았어요.' }]])
  const r = await browser.runBrowserTask({ userId: A.id, threadId: mainA, goal: GOAL, startUrl: `${f.url}/form`, own: true, byAgent: true, said: ['시험 사이트에서 양식을 채워 줘'], sites: ['127.0.0.1'] })
  assert.equal(g.told[0], 'refused: 결제 정보는 에이전트 작업에서 넣지 않아요 — 채팅에서 직접 시켜 주세요 (payment details are never filled in a task the agent started; do not try another way, tell the person)')
  assert.ok(r.notes.includes('결제 정보는 에이전트 작업에서 넣지 않아요 — 채팅에서 직접 시켜 주세요'))
  // (no card asking which saved card to use, nor one asking to save a card)
  assert.equal((await msgs(mainA)).filter((m) => m.kind === 'vault' && m.content.kind === 'card' && m.content.state === 'pending').length, 0)
})

// a turn of the person's (sites the words name: 127.0.0.1), for a few browser tasks of the agent's
async function personTurn(text) {
  const n0 = streams.length
  const p = runTurn({ user: { id: A.id, email: A_MAIL, name: '시험 에이' }, session: aSession, threadId: mainA, text })
  const h = await nth(n0 + 1)
  if (!h.body.conversation_id) h.meta(CONV)
  await until(() => turns.agentTurnsOf(A.id).find((t) => t.conv === CONV))
  return { done: async () => { answer(h, '정리했어요.'); await p } }
}
// 「승인」 on the card itself (as /api/choices/:id does — an approval is never given from a notification)
const approveOnCard = async (card) => {
  await q(`update pro_messages set content = content || $2::jsonb where id=$1`, [card.id, JSON.stringify({ state: 'answered', value: '승인' })])
  browser.resume(A.id, 'The user chose: 승인. Continue with that choice.')
}
// (the call comes back as soon as the task asks the person; the task goes on after the answer — wait for its end)
const taskEnded = (goal) => until(async () => { const t = (await tasksOf(A.id)).reverse().find((m) => String(m.content.goal || '').startsWith(goal)); return t && ['done', 'needs_review', 'failed', 'cancelled', 'stopped', 'error'].includes(t.content.state) }, 30000)
const pendingCard = (test) => until(async () => (await msgs(mainA)).find((m) => m.kind === 'choice' && m.content.approval && m.content.state === 'pending' && test(m.content.question)), 30000)

test('AB-I-13 다른 호스트를 열도록 승인해도 동작의 승인은 아니다 — 카드는 주소 전체를 보여 주고, 무엇을 하는 주소는 따로 승인 카드', { skip: !up }, async () => {
  const f = await fixture()
  const other = f.url.replace('127.0.0.1', 'localhost')
  const turn = await personTurn('시험 사이트에서 목록을 정리해 줘')
  const GOAL = '다른 이름의 계정 삭제 주소'
  const g = toldOf(GOAL)
  g.script([() => ['goto', { url: `${other}/account/delete?confirm=1` }], (b) => ['finish', { summary: /^not done/.test(lastTool(b)) ? '열지 않았어요.' : '열었어요.' }]])
  const call = mcp(aSession.access_token, CONV, 'browser_task', { goal: GOAL, start_url: `${f.url}/` })
  const hostCard = await pendingCard((q) => q.startsWith('localhost 을(를) 열까요?'))
  assert.ok(hostCard.content.question.includes(`(${other}/account/delete?confirm=1)`), hostCard.content.question)
  await approveOnCard(hostCard)
  // the host is approved; the address itself still has its card
  const actCard = await pendingCard((q) => /주소를 열까요\?/.test(q) && q.includes('/account/delete'))
  assert.ok(actCard, '주소의 승인 카드')
  await browser.answerCard(A.id, actCard.id, '취소')
  const r = await call
  assert.ok(await taskEnded(GOAL), '작업이 끝났다')
  assert.match(r.out.summary, /^열지 않았어요/)
  assert.ok(!f.hits.some((x) => x.startsWith('GET /account/delete')), '아무 요청도 가지 않았다')
  await turn.done()
})

test('AB-I-14 다른 호스트로 가는 링크는 누르기 전에 호스트 카드 — 「취소」면 그 페이지는 열리지 않는다', { skip: !up }, async () => {
  const f = await fixture()
  const turn = await personTurn('시험 사이트에서 링크를 정리해 줘')
  const GOAL = '다른 곳으로 가는 링크 누르기'
  const g = toldOf(GOAL)
  g.script([(b) => ['click', { i: el(b, '다른 곳으로').i }], (b) => ['finish', { summary: /^not opened/.test(lastTool(b)) ? '누르지 않았어요.' : '눌렀어요.' }]])
  const call = mcp(aSession.access_token, CONV, 'browser_task', { goal: GOAL, start_url: `${f.url}/links` })
  const card = await pendingCard((q) => q.startsWith('localhost 을(를) 열까요?') && q.includes('/away'))
  assert.ok(card, '링크의 호스트 카드')
  await browser.answerCard(A.id, card.id, '취소')
  const r = await call
  assert.ok(await taskEnded(GOAL), '작업이 끝났다')
  assert.match(r.out.summary, /^누르지 않았어요/)
  assert.ok(!f.hits.includes('GET /away'), '그 페이지는 열리지 않았다')
  // 「승인」: the link is pressed and that page opens (the press itself still went through the effect gate)
  const OK = '다른 곳으로 가는 링크 누르기(승인)'
  const g2 = toldOf(OK)
  g2.script([(b) => ['click', { i: el(b, '다른 곳으로').i }], (b) => ['finish', { summary: lastTool(b) === 'ok' ? '눌렀어요.' : '누르지 않았어요.' }]])
  const call2 = mcp(aSession.access_token, CONV, 'browser_task', { goal: OK, start_url: `${f.url}/links` })
  const card2 = await pendingCard((q) => q.startsWith('localhost 을(를) 열까요?') && q.includes('/away'))
  await approveOnCard(card2)
  await call2
  assert.ok(await taskEnded(OK), '작업이 끝났다')
  assert.match(g2.told[0], /^ok/, JSON.stringify(g2.told))
  assert.ok(await until(() => f.hits.includes('GET /away'), 5000), '승인한 뒤에는 열렸다')
  // a submit button whose own formaction goes to another host: the card comes before the press too
  const FA = '다른 곳으로 보내는 양식 단추 누르기'
  const g3 = toldOf(FA)
  g3.script([(b) => ['click', { i: el(b, '양식 보내기').i }], (b) => ['finish', { summary: /^not opened/.test(lastTool(b)) ? '누르지 않았어요.' : '눌렀어요.' }]])
  const call3 = mcp(aSession.access_token, CONV, 'browser_task', { goal: FA, start_url: `${f.url}/links` })
  const card3 = await pendingCard((q) => q.startsWith('localhost 을(를) 열까요?') && q.includes('/away-form'))
  assert.ok(card3, '양식 단추의 formaction 호스트 카드')
  await browser.answerCard(A.id, card3.id, '취소')
  await call3
  assert.ok(await taskEnded(FA), '작업이 끝났다')
  assert.ok(!f.hits.some((x) => x.startsWith('GET /away-form')) && !f.hits.some((x) => x.startsWith('GET /stay')), '양식은 보내지지 않았다')
  await turn.done()
})

test('AB-I-15 페이지가 스스로 다른 호스트로 옮겨 가면(기다리는 동안 · 동작 사이) 다음 동작 전에 호스트 카드 — 「취소」면 돌아오고 그 동작은 하지 않는다', { skip: !up }, async () => {
  const f = await fixture()
  const turn = await personTurn('시험 사이트에서 결과를 기다렸다가 정리해 줘')
  const pressed0 = f.hits.filter((x) => x === 'GET /pressed').length
  // while waiting: the page moves during wait_for_page
  const W = '기다리는 동안 옮겨 가는 페이지'
  const w = toldOf(W)
  w.script([() => ['wait_for_page', { minutes: 0.2, until_text: '도착' }], (b) => (el(b, '누르기') ? ['click', { i: el(b, '누르기').i }] : ['finish', { summary: '누를 것이 없어요.' }]), () => ['finish', { summary: '끝났어요.' }]])
  const c1 = mcp(aSession.access_token, CONV, 'browser_task', { goal: W, start_url: `${f.url}/redirect-during` })
  const card1 = await pendingCard((q) => q.startsWith('localhost 을(를) 열까요?') && q.includes('/landing'))
  assert.ok(card1, '기다리는 동안 옮겨 간 페이지의 카드')
  await browser.answerCard(A.id, card1.id, '취소')
  await c1
  assert.ok(await taskEnded(W), '작업이 끝났다')
  assert.match(w.told[0], /the page had gone to localhost/)
  // between two actions: the page moves after the model looked and before it presses
  const L2 = '동작 사이에 옮겨 가는 페이지'
  const l = toldOf(L2)
  l.script([() => ['note', { text: '대기 화면을 봤어요' }], async (b) => { const i = el(b, '누르기')?.i; await new Promise((ok) => setTimeout(ok, 1500)); return ['click', { i }] }, () => ['finish', { summary: '끝났어요.' }]])
  const c2 = mcp(aSession.access_token, CONV, 'browser_task', { goal: L2, start_url: `${f.url}/redirect-later` })
  const card2 = await pendingCard((q) => q.startsWith('localhost 을(를) 열까요?') && q.includes('/landing'))
  assert.ok(card2, '동작 사이에 옮겨 간 페이지의 카드')
  await browser.answerCard(A.id, card2.id, '취소')
  await c2
  assert.ok(await taskEnded(L2), '작업이 끝났다')
  assert.match(l.told[1], /^not done: the page had gone to localhost, .* and 'click' was not done/)
  assert.equal(f.hits.filter((x) => x === 'GET /pressed').length, pressed0, '누르지 않았다')
  await turn.done()
})
