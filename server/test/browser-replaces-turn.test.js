// 프로젝트 방의 방 판정 · 방 규칙 · 바로잡는 말의 대신하기 — 실제 DB 위에서, 모델 없이 (녹화 2026-11-21:
// 규칙을 정한 첫 문장이 다른 지름길로 에이전트에 가서 엉뚱한 일로 받아 적혔고, 바로잡는 말 뒤에도 앞의 에이전트가
// 끝까지 돌아 「완료했습니다」로 먼저 끝났다).
//   · 판정은 가짜 판정 서버(PRO_JUDGE_URL: 확률 JSON 을 돌려주는 작은 HTTP 서버) — 무엇을 물었는지도 본다
//   · 받아 적기·라우터·브라우저 계획은 가짜 모델(fetch 가로채기), deepagents 는 흉내 낸 스트림
//   · 브라우저 스킬은 시험용 폴더의 가짜 스킬(PRO_BROWSER_SKILLS_DIR, 시작 주소 https://notes.example/)
// 보는 것: 방 판정이 다른 지름길보다 먼저, 규칙 저장({said, action, skill, runs})과 소유, 실행 경로(스킬 → 브라우저 ·
// 없으면 에이전트), 라우터의 skill → 시작 주소, 대신하기(프로젝트 방은 늘 · 메인 채팅은 판정 0.7), 앞서 올린 파일.
// 데이터베이스가 없으면 DB 시험은 건너뜀. 시험 사용자는 무작위 id(로그인 계정 아님), 끝나면 지움.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

// ---- the judge: a small HTTP server answering scripted probabilities ----
const roomJudged = [] // answers for the room's question (options set_rule …), default other
const aheadJudged = [] // answers for "does it correct a request in progress" (options t0 … new), default new
const judgeCalls = []
const judgeServer = await new Promise((r) => {
  const s = http.createServer((req, res) => {
    // only /judge: embeddings (lib/context/embed.js asks <judge>/embeddings) are not part of this test —
    // a 404 as from a judge server without them, which embed.js takes as "no embeddings for now"
    if (!req.url.startsWith('/judge')) { req.resume(); res.writeHead(404); return res.end() }
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      const b = JSON.parse(raw)
      const room = b.options.some((o) => o.key === 'set_rule')
      judgeCalls.push({ ...b, room })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ probabilities: (room ? roomJudged : aheadJudged).shift() || (room ? { other: 1 } : { new: 1 }), model: 'scripted' }))
    })
  })
  s.listen(0, '127.0.0.1', () => r(s))
})
const skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-skills-'))
fs.mkdirSync(path.join(skillsDir, 'fake-notes'))
fs.writeFileSync(path.join(skillsDir, 'fake-notes', 'SKILL.md'), `---
name: fake-notes
description: 시험용 노트 사이트에서 링크·파일로 요약 카드를 만든다.
metadata:
  runs_in: browser
  start_url: https://notes.example/
---
본문.
`)
const START = 'https://notes.example/'

// like production: no context router (the main chat is one conversation)
process.env.PRO_CONTEXT_ROUTER_URL = ''
process.env.PRO_JUDGE_URL = `http://127.0.0.1:${judgeServer.address().port}/judge`
process.env.PRO_JUDGE_LLM = '0'
process.env.PRO_BROWSER_SKILLS_DIR = skillsDir
const { config } = await import('../config.js')
const { q, pool } = await import('../lib/supa.js')
const T = await import('../lib/turns.js')
const R = await import('../lib/roomRules.js')

const up = await q('select 1').then(() => true, () => false)

// ---- a scripted deepagents and model ----
const realFetch = globalThis.fetch
const streams = []
const stops = []
const routes = [] // router answers: a browser_task call's arguments, or null for DELEGATE
const routerCalls = []
const actions = [] // the rule's write-down answers
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
  if (u.startsWith(config.llm.baseUrl)) {
    const body = JSON.parse(opts.body)
    const sys = String(body.messages?.[0]?.content || '')
    const answer = (message) => json({ choices: [{ message: { role: 'assistant', ...message }, finish_reason: 'stop' }] })
    if (/Break a web task/.test(sys)) return new Promise((go) => plans.push(() => go(answer({ content: JSON.stringify({ title: '사이트 작업', steps: ['열기'] }) }))))
    if (body.tools?.length) {
      routerCalls.push(body)
      const args = routes.shift()
      return args ? answer({ content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'browser_task', arguments: JSON.stringify(args) } }] }) : answer({ content: 'DELEGATE' })
    }
    if (body.response_format && sys.includes(R.ruleActionPrompt('').split('\n')[0])) return answer({ content: JSON.stringify(actions.shift() || {}) })
    return answer({ content: 'DELEGATE' })
  }
  if (/\/servers$|\/bindings$/.test(u)) return json([])
  return realFetch(url, opts)
}
const nth = async (n) => { while (streams.length < n) await new Promise((r) => wake.push(r)); return streams[n - 1] }
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return v; await new Promise((r) => setTimeout(r, 30)) } }

const { runTurn, browserStarts } = await import('../lib/agent.js')
const browser = await import('../lib/browser.js')

const stamp = crypto.randomBytes(3).toString('hex')
const user = { id: crypto.randomUUID(), email: `pro-nb1121-route2-${stamp}@uengine.org`, name: '시험' }
const session = { access_token: 'test-token' }
const threads = []
async function thread(kind, conv = null) {
  const [t] = await q(`insert into pro_threads(user_id,kind,title,conversation_id) values ($1,$2,'시험',$3) returning id`, [user.id, kind, conv])
  threads.push(t.id)
  return t.id
}
const msgs = (tid) => q('select id, role, kind, content from pro_messages where thread_id=$1 order by created_at', [tid])
const roomCalls = () => judgeCalls.filter((c) => c.room)
const file = (name) => ({ name, url: `https://files.example/${stamp}/${encodeURIComponent(name)}`, path: `/tmp/${stamp}-${name}` })
// the browser task a message started: its card, then cancelled before its plan is back
async function cardOf(tid) {
  const card = await until(async () => (await msgs(tid)).filter((m) => m.kind === 'task' && m.content.state !== 'cancelled').at(-1))
  assert.ok(card, '브라우저 작업 카드')
  assert.ok(await until(() => browser.cancel(user.id, card.id)), '계획 중에 취소')
  await until(() => plans.length)
  for (const go of plans.splice(0)) go()
  await until(async () => (await msgs(tid)).find((m) => m.id === card.id && m.content.state === 'cancelled'))
  return card
}
const REPLACED = 'notes.example에서 하는 브라우저 작업으로 바꿔서 이전 작업은 멈췄어요.'

after(async () => {
  globalThis.fetch = realFetch
  judgeServer.close()
  fs.rmSync(skillsDir, { recursive: true, force: true })
  await browser.close(user.id).catch(() => {})
  fs.rmSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.browser-profiles', user.id), { recursive: true, force: true })
  if (up && threads.length) await q('delete from pro_threads where id = any($1)', [threads])
  await pool.end()
})

// ---------- 방 규칙 ----------
test('방 판정이 다른 지름길보다 먼저: 규칙을 정하는 말은 문서 지름길로 가지 않고, 스킬과 함께 그 방의 안내 메시지에 적힌다', { skip: !up }, async () => {
  const tid = await thread('project')
  const n0 = streams.length, j0 = roomCalls().length
  // (these words would also go down the document shortcut to the agent)
  const said = '앞으로 이 방에 주는 링크는 노트 사이트에서 보고서 문서로 만들어 줘'
  roomJudged.push({ set_rule: 0.93, other: 0.07 })
  actions.push({ action: '이 링크로 시험용 노트 사이트에서 요약 카드를 만든다', skill: 'fake-notes' })
  const ack = await runTurn({ user, session, threadId: tid, text: said })
  assert.equal(roomCalls().length, j0 + 1, '방 판정 한 번')
  const call = roomCalls().at(-1)
  // (a project room is read with its plan — 계획에 넣기 is offered too: lib/projectNote.js)
  assert.deepEqual(call.options.map((o) => o.key), ['set_rule', 'plan', 'other'], '규칙이 없으면 run_rule 은 보기에 없다')
  assert.ok(call.state.includes(said))
  assert.match(call.state, /첨부한 파일: 없음/)
  assert.deepEqual(ack.content.roomRule, { said, action: '이 링크로 시험용 노트 사이트에서 요약 카드를 만든다', skill: 'fake-notes', runs: 0 })
  assert.ok(ack.content.text.includes('이 링크로 시험용 노트 사이트에서 요약 카드를 만든다'))
  assert.deepEqual(ack.content.text.split('\n'), ['알겠습니다. 이 방에 올리시는 링크와 파일은 앞으로 바로 처리할게요.', '이 링크로 시험용 노트 사이트에서 요약 카드를 만든다', '서버의 내장 브라우저에서 진행해요.'])
  assert.equal(streams.length, n0, '에이전트에 가지 않는다')
  const rule = await R.ruleOf(user.id, tid)
  assert.equal(rule.skill, 'fake-notes')
  assert.equal(rule.runs, 0)

  // ---- 규칙의 대상: 스킬이 있으니 브라우저 작업, 시작 주소는 스킬의 start_url ----
  roomJudged.push({ set_rule: 0.03, run_rule: 0.92, other: 0.05 })
  const text = 'https://youtu.be/rr2abc 이것도'
  const ack2 = await runTurn({ user, session, threadId: tid, text, files: [file('메모.pdf')] })
  assert.equal(ack2.content.text, '이 방의 규칙대로 시작할게요.')
  const c2 = roomCalls().at(-1)
  assert.deepEqual(c2.options.map((o) => o.key), ['set_rule', 'plan', 'run_rule', 'other'])
  assert.ok(c2.state.includes(rule.action), '판정은 방의 규칙을 본다')
  assert.match(c2.state, /첨부한 파일: 1개 \(메모\.pdf\)/)
  const started = browserStarts.at(-1)
  assert.equal(started.threadId, tid)
  assert.equal(started.startUrl, START)
  assert.equal(started.skill, 'fake-notes')
  assert.deepEqual(started.files, ['메모.pdf'])
  assert.deepEqual(started.goal.split('\n'), [rule.action, `사용자가 이 방에 준 것: ${text}`, '첨부 파일: 메모.pdf'])
  const card = await cardOf(tid)
  assert.equal(card.content.url, START)
  assert.equal((await R.ruleOf(user.id, tid)).runs, 1)
  assert.equal(streams.length, n0)

  // ---- 0.7 미만이면 규칙대로 하지 않고 평소 길로 ----
  roomJudged.push({ set_rule: 0.1, run_rule: 0.6, other: 0.3 })
  const n1 = streams.length
  const p = runTurn({ user, session, threadId: tid, text: '지난번 보고서 문서 하나 더 만들어 줘' })
  const h = await nth(n1 + 1)
  assert.match(h.body.message, /^지난번 보고서 문서 하나 더 만들어 줘/)
  h.push('message', { type: 'token', content: '만들었어요.' }); h.end()
  assert.equal((await p).content.text, '만들었어요.')
  assert.equal((await R.ruleOf(user.id, tid)).runs, 1)
})

test('스킬이 없는 규칙은 에이전트가 한다 — 할 일 + 사람이 준 원문 그대로, 모델이 지어낸 스킬 이름은 버린다', { skip: !up }, async () => {
  const tid = await thread('project')
  roomJudged.push({ set_rule: 0.88, other: 0.12 })
  actions.push({ action: '이 파일을 영어로 번역한다', skill: 'no-such-skill' })
  const ack = await runTurn({ user, session, threadId: tid, text: '이 방에 올리는 파일은 앞으로 전부 영어로 번역해 줘' })
  assert.equal(ack.content.roomRule.skill, '')
  assert.ok(!/스킬로 진행해요/.test(ack.content.text))
  roomJudged.push({ run_rule: 0.9, set_rule: 0.05, other: 0.05 })
  const n0 = streams.length, b0 = browserStarts.length
  const p = runTurn({ user, session, threadId: tid, text: '', files: [file('계약서.docx')] })
  const h = await nth(n0 + 1)
  assert.deepEqual(h.body.message.split('\n').slice(0, 3), ['이 파일을 영어로 번역한다', '사용자가 이 방에 준 것: 첨부한 파일을 확인해 줘', '첨부 파일: 계약서.docx'])
  h.push('message', { type: 'token', content: '번역했어요.' }); h.end()
  assert.equal((await p).content.text, '번역했어요.')
  assert.equal(browserStarts.length, b0, '브라우저 작업이 아니다')
  assert.equal((await R.ruleOf(user.id, tid)).runs, 1)
})

test('규칙은 그 방 주인만 보고 끄며, 끈 방에서는 판정이 run_rule 이라 해도 규칙대로 하지 않는다', { skip: !up }, async () => {
  const tid = await thread('project')
  roomJudged.push({ set_rule: 0.9, other: 0.1 })
  actions.push({ action: '이 링크로 요약 카드를 만든다', skill: 'fake-notes' })
  await runTurn({ user, session, threadId: tid, text: '여기 올리는 링크는 다 요약 카드로' })
  const stranger = crypto.randomUUID()
  assert.equal(await R.ruleOf(stranger, tid), null)
  assert.deepEqual(await R.removeRule(stranger, tid), { removed: 0 })
  assert.ok(await R.ruleOf(user.id, tid))
  assert.deepEqual(await R.removeRule(user.id, tid), { removed: 1 })
  assert.equal(await R.ruleOf(user.id, tid), null)
  roomJudged.push({ run_rule: 0.95, other: 0.05 })
  const n0 = streams.length, b0 = browserStarts.length
  const p = runTurn({ user, session, threadId: tid, text: 'https://a.example/x 보고서 문서로 만들어 줘' })
  const h = await nth(n0 + 1)
  assert.deepEqual(roomCalls().at(-1).options.map((o) => o.key), ['set_rule', 'plan', 'other'])
  h.push('message', { type: 'token', content: '네.' }); h.end()
  await p
  assert.equal(browserStarts.length, b0)
})

// ---------- 바로잡는 말: 규칙 없는 프로젝트 방 ----------
test('규칙 없는 프로젝트 방: 긴 작업 중 바로잡는 말 → 라우터가 skill 을 고른 browser_task → 판정이 바로잡는 말이라 하면 앞 턴은 멈추고 이유를 말하며, 시작 주소는 스킬의 것 — 앞서 올린 파일은 따라가지 않는다', { skip: !up }, async () => {
  const conv = `rt-p-${stamp}`
  const tid = await thread('project', conv)
  const n0 = streams.length
  const p1 = runTurn({ user, session, threadId: tid, text: '이 영상으로 슬라이드와 팟캐스트 만들어 줘 https://youtu.be/rt1121abc', files: [file('자료.pdf')] })
  const h1 = await nth(n0 + 1)
  assert.equal(h1.body.conversation_id, conv)
  h1.push('message', { type: 'token', content: '슬라이드 파일을 만들고 있어요.' })
  const goal = '노트 사이트에서 https://youtu.be/rt1121abc 영상으로 슬라이드와 팟캐스트를 만든다'
  routes.push({ goal, skill: 'fake-notes', ack: '노트 사이트에서 직접 할게요.' })
  aheadJudged.push({ t0: 0.92, new: 0.08 })
  const r0 = routerCalls.length
  const ack = await runTurn({ user, session, threadId: tid, text: '노트북엘엠 사이트에 들어가서 생성해야' })
  assert.equal(ack.content.text, '노트 사이트에서 직접 할게요.')
  // the router saw the browser skills (name and description) and the earlier message with its link
  const rc = routerCalls.at(-1)
  assert.equal(routerCalls.length, r0 + 1)
  assert.match(rc.messages[0].content, /fake-notes — 시험용 노트 사이트에서 링크·파일로 요약 카드를 만든다/)
  assert.ok(!rc.messages[0].content.includes('본문.'), '스킬 본문은 라우터에 없다')
  assert.ok(rc.messages.some((m) => m.role === 'user' && m.content.includes('https://youtu.be/rt1121abc')))
  assert.ok(rc.tools.find((t) => t.function.name === 'browser_task').function.parameters.properties.skill)
  const first = await p1
  assert.deepEqual(stops.slice(-1), [conv], 'deepagents /chat/stop')
  assert.equal(first.content.text, REPLACED)
  assert.equal(first.content.stopped, true)
  assert.equal(first.content.replaced, true)
  assert.match(first.content.partial, /슬라이드 파일을 만들고 있어요/)
  const started = browserStarts.at(-1)
  // (background: the project's plan, apart from the goal — none yet here: lib/projectNote.js)
  assert.deepEqual({ ...started, threadId: undefined }, { threadId: undefined, goal, startUrl: START, skill: 'fake-notes', files: [], own: true, background: '' })
  const card = await cardOf(tid)
  assert.equal(card.content.url, START)
  const answers = (await msgs(tid)).filter((m) => m.role === 'agent' && m.kind === 'text').map((m) => m.content.text)
  assert.ok(!answers.some((t) => /완료했습니다/.test(t)), JSON.stringify(answers))
})

test('프로젝트 방: 판정이 기다리던 턴을 고르면 그 턴은 에이전트에 가지 않고 바로 이유로 끝나고, 돌던 턴은 그대로 끝난다', { skip: !up }, async () => {
  const conv = `rt-w-${stamp}`
  const tid = await thread('project', conv)
  const n0 = streams.length
  const p1 = runTurn({ user, session, threadId: tid, text: '이 링크로 보고서 문서 만들어 줘 https://a.example/w1' })
  const h1 = await nth(n0 + 1)
  const p2 = runTurn({ user, session, threadId: tid, text: '그 보고서 문서도 하나 더 만들어 줘' })
  await until(async () => (await msgs(tid)).find((m) => m.role === 'user' && m.content.queued))
  routes.push({ goal: '노트 사이트에서 https://a.example/w1 로 보고서를 만든다', skill: 'fake-notes', ack: '사이트에서 할게요.' })
  aheadJudged.push({ t0: 0.05, t1: 0.9, new: 0.05 })
  await runTurn({ user, session, threadId: tid, text: '그건 노트 사이트에서 해 줘' })
  const b = await p2
  assert.equal(b.content.text, REPLACED)
  assert.equal(b.content.replaced, true)
  assert.equal(streams.length, n0 + 1, '기다리던 턴은 deepagents 에 가지 않음')
  h1.push('message', { type: 'token', content: '보고서를 만들었어요.' }); h1.end()
  const a = await p1
  assert.notEqual(a.content.text, REPLACED)
  assert.deepEqual(browserStarts.at(-1).files, [], '앞서 올린 파일은 따라가지 않음')
  await cardOf(tid)
})

// ---------- 바로잡는 말: 메인 채팅 ----------
test('메인 채팅: 방 판정은 없고, 진행 중 턴이 있을 때 브라우저 작업이 시작되면 거르개 없이 판정에 묻는다(0.7 이상이면 그 턴만 대신)', { skip: !up }, async () => {
  const conv = `rt-c-${stamp}`
  const tid = await thread('chat', conv)
  const j0 = roomCalls().length
  // judged a correction
  let n0 = streams.length
  const p1 = runTurn({ user, session, threadId: tid, text: '이 영상으로 슬라이드 만들어 줘 https://youtu.be/rt1121c1' })
  await nth(n0 + 1)
  aheadJudged.push({ t0: 0.9, new: 0.1 })
  routes.push({ goal: '노트 사이트에서 https://youtu.be/rt1121c1 로 슬라이드를 만든다', skill: 'fake-notes', ack: '사이트에서 할게요.' })
  await runTurn({ user, session, threadId: tid, text: '노트북엘엠 사이트에 들어가서 해' })
  const first = await p1
  assert.equal(first.content.text, REPLACED)
  const jc = judgeCalls.at(-1)
  assert.match(jc.state, /이 영상으로 슬라이드 만들어 줘/)
  assert.match(jc.state, /노트북엘엠 사이트에 들어가서 해/)
  assert.equal(browserStarts.at(-1).startUrl, START)
  await cardOf(tid)
  // judged a request of its own: the answer ahead goes on and is kept
  n0 = streams.length
  const p2 = runTurn({ user, session, threadId: tid, text: '이 영상 요약 문서 만들어 줘 https://youtu.be/rt1121c2' })
  const h2 = await nth(n0 + 1)
  aheadJudged.push({ t0: 0.3, new: 0.7 })
  routes.push({ goal: '노트 사이트 첫 화면 열기', skill: 'fake-notes', ack: '열게요.' })
  let calls = judgeCalls.length
  await runTurn({ user, session, threadId: tid, text: '노트 사이트 첫 화면 열어 줘' })
  await cardOf(tid)
  assert.equal(judgeCalls.length, calls + 1)
  h2.push('message', { type: 'token', content: '요약 문서를 완료했습니다.' }); h2.end()
  const second = await p2
  assert.equal(second.content.text, '요약 문서를 완료했습니다.')
  assert.equal(second.content.replaced, undefined)
  // a message with a link of its own is asked about too (no filter); with a skill, the router's own address counts
  // only as a page on the skill's site (it guessed another host for the same site: real model, 2026-11-21)
  n0 = streams.length
  const p3 = runTurn({ user, session, threadId: tid, text: '이 링크로 보고서 문서 만들어 줘 https://a.example/c3' })
  const h3 = await nth(n0 + 1)
  routes.push({ goal: 'https://notes.example/n/42 노트에 슬라이드', skill: 'fake-notes', start_url: 'https://notes.example/n/42', ack: '할게요.' })
  calls = judgeCalls.length
  await runTurn({ user, session, threadId: tid, text: '이건 따로 https://notes.example/n/42 노트에 슬라이드로 해 줘' })
  await cardOf(tid)
  assert.equal(judgeCalls.length, calls + 1, '자기 링크가 있어도 판정에 묻는다')
  assert.equal(browserStarts.at(-1).startUrl, 'https://notes.example/n/42', '스킬 사이트 안의 페이지는 그대로')
  assert.equal(browserStarts.at(-1).skill, 'fake-notes')
  routes.push({ goal: '노트 사이트에서 슬라이드', skill: 'fake-notes', start_url: 'https://old-notes.example.com', ack: '할게요.' })
  await runTurn({ user, session, threadId: tid, text: '노트 사이트에서 슬라이드로 해 줘' })
  await cardOf(tid)
  assert.equal(browserStarts.at(-1).startUrl, START, '라우터가 짐작한 다른 호스트보다 스킬의 시작 주소')
  h3.push('message', { type: 'token', content: '보고서를 만들었어요.' }); h3.end()
  assert.equal((await p3).content.text, '보고서를 만들었어요.')
  // nothing ahead: not asked
  calls = judgeCalls.length
  routes.push({ goal: '노트 사이트 열기', skill: 'fake-notes', ack: '열게요.' })
  await runTurn({ user, session, threadId: tid, text: '노트 사이트 열어 줘' })
  await cardOf(tid)
  assert.equal(judgeCalls.length, calls, '앞에 턴이 없으면 묻지 않는다')
  assert.equal(roomCalls().length, j0, '메인 채팅에는 방 판정이 없다')
})

test('라우터가 없는 스킬 이름을 대면 스킬 없이(시작 주소도 없이) 브라우저 작업', { skip: !up }, async () => {
  const tid = await thread('chat', `rt-n-${stamp}`)
  routes.push({ goal: '어딘가에서 무엇을 한다', skill: 'no-such-skill', ack: '할게요.' })
  await runTurn({ user, session, threadId: tid, text: '그 사이트에서 해 줘' })
  const started = browserStarts.at(-1)
  assert.equal(started.skill, '')
  assert.equal(started.startUrl, '')
  await cardOf(tid)
})

test('회사가 정한 루틴의 자동 실행(runTurn auto)이 시작한 브라우저 작업은 그 사람이 시킨 것이 아니다(own: false) — 사람이 보낸 말은 그 사람의 것', { skip: !up }, async () => {
  const tid = await thread('chat', `rt-auto-${stamp}`)
  routes.push({ goal: '노트 사이트에서 정리', skill: 'fake-notes', ack: '할게요.' })
  await runTurn({ user, session, threadId: tid, text: '노트 사이트에서 정리해 줘', auto: true })
  assert.equal(browserStarts.at(-1).own, false, '자동 실행')
  await cardOf(tid)
  routes.push({ goal: '노트 사이트에서 목록 보기', skill: 'fake-notes', ack: '볼게요.' })
  await runTurn({ user, session, threadId: tid, text: '노트 사이트 목록 좀 보여 줘' })
  assert.equal(browserStarts.at(-1).own, true, '사람이 보낸 말')
  await cardOf(tid)
})
