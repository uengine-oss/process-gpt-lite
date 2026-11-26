// 프로젝트 계획 — 실제 DB 위에서 실제 턴으로(lib/agent.js runTurn), 모델 없이. 운영에서 일어난 세 장면(2026-11-25 · 11-27, 프로젝트
// 「링크 슬라이드 팟캐스트」)을 그대로 다시 일으킨다. 스펙 openspec/specs/project-room 「프로젝트 계획」 · room-rules 「계획에 넣는 말」.
//   · 판정은 가짜 판정 서버(PRO_JUDGE_URL — 확률 JSON), 모델(앞단 계획 · 라우터 · 계획 쓰기 · 규칙 받아 적기 · 습관)은 fetch 가로채기,
//     deepagents 는 흉내 낸 스트림, 브라우저 스킬은 시험용 가짜 스킬(fake-notes), 하위 대화 라우터는 가짜 /route
//   PP-I-01 덮어쓰기(11-25): 규칙이 있는 방에서 작업에 준 세부 지시 → 「계획에 넣기」 — 규칙은 그대로, 계획의 지킬 것에(고정), 칩 · 에이전트 없음 · 습관 없음
//   PP-I-02 링크만(11-27 07:02): 덮어써진 규칙 + 계획 → 판정이 계획의 목적을 읽고 규칙대로 → 브라우저 작업의 할 일에 계획
//   PP-I-03 링크만, 규칙 없음: 계획의 도구가 브라우저 스킬 → 연결 서비스 지름길을 건너뛰고 라우터가 계획을 읽어 그 스킬로, 계획 카드의 처리 주체
//   PP-I-04 「앞으로 …」(11-27 07:05): 프로젝트 방에서는 습관보다 방 판정이 먼저 → 규칙(계획을 먼저 고치고 받아 적기) · 습관 없음
//           메인 채팅은 그대로 습관, 프로젝트 방에서도 판정이 「그 밖」이면 그 뒤에 습관
//   PP-I-05 처음 채우기: 계획이 없는 방의 첫 턴 — 지난 메시지 · 하위 대화 제목과 요지 · 지금 규칙 · 방 이름 → 계획, 그 턴의 판정이 읽음, 칩
//   PP-I-06 턴이 끝나고 앞단 계획이 memory 라고 하면 계획을 고침 — 도구 ref, 「계획에 넣었어요」 칩, 사람이 고친 항목은 낱말 그대로
//   PP-I-07 에이전트에게 가는 메시지마다 계획 — 하위 대화의 첫 턴 · 스킬 없는 규칙 실행, 규칙 막대의 스킬 고르기
//   PP-I-08 되돌리기는 그 앞의 행으로, 계획은 주인만(다른 사람 404), 채팅 목록에 보이지 않음
//   PP-I-09 「뒤로 갈수록 휘발」(11-27 사용자): 미션 뒤로 64개 메시지가 쌓인 방 — 처음 채우기가 첫 메시지의 미션을 읽고, 나중에 링크만 보내도
//           (미션은 라우터의 최근 대화 밖) 계획의 목적대로 그 스킬의 브라우저 작업, 규칙 실행 · 에이전트에게 가는 메시지에도 계획
//   PP-I-10 바뀐 기록(11-27 사용자 「중간중간 방향을 개선하거나 수정한 내용 등이 이 파일에 관리」): 변경마다 언제 · 누가 · 무엇이 · 어느 메시지에서,
//           사람이 직접 고친 것도 기록, 어느 기록이든 되돌리기(뒤에 다른 변경이 있으면 그 변경만), 되돌린 것도 기록, 칩도 「되돌렸어요」
//   cd server && node --test --test-concurrency=1 test/projectPlan.integration.test.js
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

// ---- the judge: scripted probabilities for the room's question ----
const roomJudged = []
const judgeCalls = []
const judgeServer = await new Promise((r) => {
  const s = http.createServer((req, res) => {
    if (!req.url.startsWith('/judge')) { req.resume(); res.writeHead(404); return res.end() }
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      const b = JSON.parse(raw)
      const room = b.options.some((o) => o.key === 'set_rule')
      judgeCalls.push({ ...b, room, at: Date.now() })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ probabilities: (room ? roomJudged.shift() : null) || (room ? { other: 1 } : { new: 1 }), model: 'scripted' }))
    })
  })
  s.listen(0, '127.0.0.1', () => r(s))
})
const skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-plan-int-'))
fs.mkdirSync(path.join(skillsDir, 'fake-notes'))
fs.writeFileSync(path.join(skillsDir, 'fake-notes', 'SKILL.md'), `---
name: fake-notes
description: 시험용 노트 사이트에서 링크 · 파일로 슬라이드와 팟캐스트를 만든다.
metadata:
  runs_in: browser
  label: Fake Notes
  start_url: https://notes.example/
---
본문.
`)
const START = 'https://notes.example/'
const CTX = 'http://ctx-router.test'
process.env.PRO_CONTEXT_ROUTER_URL = CTX
process.env.PRO_JUDGE_URL = `http://127.0.0.1:${judgeServer.address().port}/judge`
process.env.PRO_JUDGE_LLM = '0'
process.env.PRO_BROWSER_SKILLS_DIR = skillsDir
const { config } = await import('../config.js')
const { q, pool } = await import('../lib/supa.js')
const R = await import('../lib/roomRules.js')
const N = await import('../lib/projectNote.js')
const up = await q('select 1').then(() => true, () => false)

// ---- the fake model and deepagents ----
const realFetch = globalThis.fetch
const enc = new TextEncoder()
const json = (v) => new Response(JSON.stringify(v), { headers: { 'Content-Type': 'application/json' } })
const llm = { calls: [], front: [], router: [], update: [], backfill: [], add: [], action: [], odds: [], habit: [] }
const script = { front: [], router: [], update: [], backfill: [], add: [], action: [], ruleOdds: [] }
const streams = []
const plans = []
const topicRoutes = []
let wake = []
const sk = await N.planSkill()
const isPrompt = (sys, name) => sys === sk.prompts[name] || sys === sk.prompts[`${name}-en`]
async function fakeLlm(body) {
  const sys = String(body.messages?.[0]?.content || '')
  const user = String(body.messages?.at(-1)?.content || '')
  const answer = (message) => json({ choices: [{ message: { role: 'assistant', ...message }, finish_reason: 'stop' }] })
  llm.calls.push({ at: Date.now(), sys: sys.slice(0, 80) })
  if (body.logprobs) {
    const text = (body.messages || []).map((m) => m.content).join('\n')
    llm.odds.push(text)
    // (the habit question 「이 말은 무엇인가?」: A = rule when scripted; everything else: its last option — "none / new / other")
    const letters = [...text.matchAll(/^([A-Z])\) /gm)].map((m) => m[1])
    const letter = text.includes('어떤 결과물이 나올 때마다 할 일을 기억해 두라는 말이다') && script.ruleOdds.shift() ? 'A' : letters.at(-1) || 'A'
    return json({ choices: [{ message: { content: letter }, logprobs: { content: [{ token: letter, logprob: Math.log(0.95), top_logprobs: [{ token: letter, logprob: Math.log(0.95) }] }] } }] })
  }
  if (sys.includes('what you understood and how the work will go')) {
    llm.front.push({ sys, user })
    return answer({ content: JSON.stringify(script.front.shift() || { understood: '요청을 살펴볼게요.', steps: ['읽기', '정리'], tier: 'light', certainty: 'sure' }) })
  }
  if (/Break a web task/.test(sys)) return new Promise((go) => plans.push(() => go(answer({ content: JSON.stringify({ title: '사이트 작업', steps: ['열기'] }) }))))
  if (body.tools?.length) {
    llm.router.push({ sys, body })
    const args = script.routerFn ? script.routerFn(sys) : script.router.shift()
    return args ? answer({ content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'browser_task', arguments: JSON.stringify(args) } }] }) : answer({ content: 'DELEGATE' })
  }
  for (const k of ['update', 'backfill', 'add']) {
    if (isPrompt(sys, k)) { llm[k].push({ user, at: Date.now() }); return answer({ content: JSON.stringify((k === 'backfill' && script.backfillFn ? script.backfillFn(user) : script[k].shift()) || {}) }) }
  }
  if (sys.startsWith(R.ruleActionPrompt('').split('\n')[0])) { llm.action.push({ user, at: Date.now() }); return answer({ content: JSON.stringify(script.action.shift() || {}) }) }
  if (sys.includes('어떤 결과물이 나올 때마다 할 일을 말했다')) { llm.habit.push(user); return answer({ content: JSON.stringify({ event: 'audio', action: '노트 사이트로 팟캐스트를 만들어 줘' }) }) }
  if (sys.includes('비서가 먼저 묻는 한 문장')) return answer({ content: '노트 사이트로 팟캐스트를 만들어 드릴까요?' })
  return answer({ content: body.response_format ? '{}' : 'OK' })
}
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url)
  if (u.startsWith(config.llm.baseUrl)) return fakeLlm(opts.body ? JSON.parse(opts.body) : {})
  if (u.startsWith(CTX) && u.endsWith('/route')) {
    const b = JSON.parse(opts.body)
    const r = topicRoutes.shift()
    return r ? json({ ...r, routing: r }) : new Response('{}', { status: 503 })
  }
  if (u.startsWith(config.deepagentsUrl) || u.startsWith(CTX)) {
    const body = opts.body ? JSON.parse(opts.body) : {}
    if (u.endsWith('/chat/stop')) {
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
  if (/\/servers$|\/bindings$|\/skills\?/.test(u)) return json([])
  return realFetch(url, opts)
}
const nth = async (n) => { while (streams.length < n) await new Promise((r) => wake.push(r)); return streams[n - 1] }
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return v; await new Promise((r) => setTimeout(r, 30)) } }

const { runTurn, browserStarts } = await import('../lib/agent.js')
const browser = await import('../lib/browser.js')
const { subscribe } = await import('../lib/bus.js')

const stamp = crypto.randomBytes(3).toString('hex')
const user = { id: crypto.randomUUID(), email: `pro-pp-${stamp}@uengine.org`, name: '정하윤' }
const other = { id: crypto.randomUUID(), email: `pro-pp-other-${stamp}@uengine.org`, name: '김서연' }
const session = { access_token: 'test-token' }
const threads = []
// the bus events of this person (the plan card's turn.plan)
const events = []
subscribe(user.id, { write: (line) => { const m = /^event: (.+)\ndata: (.+)\n/.exec(line); if (m) events.push({ type: m[1], data: JSON.parse(m[2]) }) } })
async function room(title = '링크 슬라이드 팟캐스트', conv = null) {
  const [t] = await q(`insert into pro_threads(user_id,kind,title,conversation_id) values ($1,'project',$2,$3) returning id`, [user.id, title, conv])
  threads.push(t.id)
  return t.id
}
async function mainChat() {
  const [t] = await q(`insert into pro_threads(user_id,kind,title) values ($1,'chat','채팅') returning id`, [user.id])
  threads.push(t.id)
  return t.id
}
const say = (tid, role, text, extra = {}) => q(`insert into pro_messages(thread_id,role,kind,content) values ($1,$2,'text',$3) returning id`, [tid, role, { text, ...extra }]).then((r) => r[0].id)
const setRule = (tid, action, skill = 'fake-notes') => q(`insert into pro_messages(thread_id,role,kind,content) values ($1,'agent','text',$2) returning id`,
  [tid, { text: `알겠습니다.\n${action}`, roomRule: { said: '…', action, skill, runs: 0 } }]).then((r) => r[0].id)
const msgs = (tid) => q('select id, role, kind, content, created_at from pro_messages where thread_id=$1 order by created_at', [tid])
const roomCalls = () => judgeCalls.filter((c) => c.room)
const habits = () => q('select * from pro_followups where user_id=$1', [user.id])
// the browser task a message started: its card, then cancelled before its plan is back
async function cancelTask(tid) {
  const card = await until(async () => (await msgs(tid)).filter((m) => m.kind === 'task' && m.content.state !== 'cancelled').at(-1))
  assert.ok(card, '브라우저 작업 카드')
  assert.ok(await until(() => browser.cancel(user.id, card.id)), '계획 중에 취소')
  await until(() => plans.length)
  for (const go of plans.splice(0)) go()
  await until(async () => (await msgs(tid)).find((m) => m.id === card.id && m.content.state === 'cancelled'))
  return card
}
const MISSION = '이 방에서 내가 주는 url이 있으면 그거를 받아다가 노트북엘엠으로 슬라이드를 만들고 그 팟캐스트를 하나 만들어 주면 돼'
const MEDIUM = '미디엄은 접근 권한 문제가 있으니, 내 계정으로 접근해서 인쇄시킨 후, pdf 등으로 만든후에 노트북엘엠에 넣어야 해.'
const AGAIN = '내가 입력한 url 의 내용은 항상 노트북 lm 으로 팟캐스트를 만들어야.'
const PLAN = { intent: '링크 · 파일을 Fake Notes 슬라이드와 팟캐스트로 만든다', deliverables: ['슬라이드', '팟캐스트'],
  tools: [{ name: 'Fake Notes', kind: 'browser_skill', ref: 'fake-notes', how: '서버 브라우저에서 소스로 넣고 슬라이드 · 오디오를 만든다' }],
  constraints: ['미디엄 글은 내 계정으로 인쇄해 PDF 로 넣는다'], decisions: [] }
const planned = async (tid, note = PLAN) => N.saveNote(user.id, tid, N.normalize(note), { editedBy: 'assistant', upTo: (await msgs(tid)).at(-1)?.id })

after(async () => {
  globalThis.fetch = realFetch
  judgeServer.close()
  fs.rmSync(skillsDir, { recursive: true, force: true })
  await browser.close(user.id).catch(() => {})
  fs.rmSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.browser-profiles', user.id), { recursive: true, force: true })
  if (up && threads.length) await q('delete from pro_threads where id = any($1)', [threads])
  if (up) await q('delete from pro_followups where user_id=$1', [user.id]).catch(() => {})
  if (up) await q('delete from context_threads where user_id like $1', [`${user.id}%`]).catch(() => {})
  await pool.end()
  const { closeOntology } = await import('../lib/ontology/store.js')
  await closeOntology().catch(() => {})
})

test('PP-I-01 덮어쓰기(11-25): 규칙이 있는 방에서 작업에 준 세부 지시는 계획의 지킬 것으로 — 규칙은 그대로, 칩, 에이전트 · 습관 없음', { skip: !up }, async () => {
  const tid = await room()
  await say(tid, 'user', MISSION)
  const ruleId = await setRule(tid, '이 링크나 파일로 Fake Notes 에서 슬라이드와 팟캐스트를 만든다')
  await planned(tid, { ...PLAN, constraints: [] })
  const n0 = streams.length, h0 = (await habits()).length
  roomJudged.push({ set_rule: 0.06, plan: 0.9, run_rule: 0.02, other: 0.02 })
  script.add.push({ to: 'constraints', text: '미디엄 글은 내 계정으로 접속해 인쇄한 뒤 PDF 로 만들어 Fake Notes 에 넣는다', replaces: '' })
  const ack = await runTurn({ user, session, threadId: tid, text: MEDIUM })
  const call = roomCalls().at(-1)
  assert.deepEqual(call.options.map((o) => o.key), ['set_rule', 'plan', 'run_rule', 'other'], '보기에 「계획에 넣기」')
  assert.ok(call.state.includes(PLAN.intent), '판정은 계획의 목적을 읽는다')
  assert.ok(call.state.includes('이 링크나 파일로 Fake Notes 에서 슬라이드와 팟캐스트를 만든다'), '판정은 지금 규칙을 읽는다')
  assert.equal(ack.kind, 'chip')
  assert.equal(ack.content.text, '계획에 넣었어요: 미디엄 글은 내 계정으로 접속해 인쇄한 뒤 PDF 로 만들어 Fake Notes 에 넣는다')
  assert.ok(ack.content.planChange?.noteId)
  const rule = await R.ruleOf(user.id, tid)
  assert.equal(rule.id, ruleId, '규칙은 덮어써지지 않는다')
  assert.equal(rule.action, '이 링크나 파일로 Fake Notes 에서 슬라이드와 팟캐스트를 만든다')
  assert.ok(!(await msgs(tid)).some((m) => m.content?.ruleConfirm), '규칙을 바꿀까요 카드도 없다')
  const { note } = await N.noteRow(user.id, tid)
  assert.deepEqual(note.constraints, [{ text: '미디엄 글은 내 계정으로 접속해 인쇄한 뒤 PDF 로 만들어 Fake Notes 에 넣는다', pinned: true }], '사람이 한 말은 고정')
  assert.equal(note.intent, PLAN.intent, '목적은 그대로')
  assert.equal(note.editedBy, 'person')
  assert.ok(llm.add.at(-1).user.includes(MEDIUM))
  assert.equal(streams.length, n0, '에이전트에 가지 않는다')
  assert.equal((await habits()).length, h0, '습관이 생기지 않는다')
})

test('PP-I-02 링크만(11-27 07:02): 덮어써진 규칙 + 계획 → 판정이 계획을 읽고 규칙대로 — 브라우저 작업의 할 일에 계획의 목적과 지킬 것', { skip: !up }, async () => {
  const tid = await room()
  await say(tid, 'user', MISSION)
  await setRule(tid, '이 링크로 미디엄 글은 내 계정으로 인쇄해 PDF 로 만든 뒤 Fake Notes 에 넣는다')
  await planned(tid)
  roomJudged.push({ set_rule: 0.02, plan: 0.03, run_rule: 0.93, other: 0.02 })
  const link = 'https://youtu.be/pp1127link'
  const ack = await runTurn({ user, session, threadId: tid, text: link })
  assert.equal(ack.content.text, '이 방의 규칙대로 시작할게요.')
  const call = roomCalls().at(-1)
  assert.ok(call.state.includes(`목적: ${PLAN.intent}`))
  assert.ok(call.state.includes(PLAN.constraints[0]))
  const started = browserStarts.at(-1)
  assert.equal(started.skill, 'fake-notes')
  assert.equal(started.startUrl, START)
  assert.ok(started.goal.includes(`사용자가 이 방에 준 것: ${link}`))
  assert.ok(started.goal.includes('[프로젝트 계획]') && started.goal.includes(PLAN.intent) && started.goal.includes(PLAN.constraints[0]), '할 일에 계획')
  await cancelTask(tid)
})

test('PP-I-03 링크만, 규칙 없음: 계획의 도구가 브라우저 스킬이면 연결 서비스 지름길 대신 라우터가 계획을 읽어 그 스킬로 — 계획 카드의 처리 주체도', { skip: !up }, async () => {
  const tid = await room()
  await say(tid, 'user', 'Fake Notes 로 슬라이드랑 팟캐스트 만들어 줘, 서버 브라우저에서')
  await planned(tid)
  roomJudged.push({ set_rule: 0.1, plan: 0.05, other: 0.85 })
  script.front.push({ understood: 'Fake Notes 에서 이 영상으로 슬라이드와 팟캐스트를 만들게요.', steps: ['영상 넣기', '슬라이드 · 오디오 만들기'], tier: 'standard', certainty: 'sure' })
  script.router.push({ goal: '이 영상으로 Fake Notes 에서 슬라이드와 팟캐스트를 만든다 https://youtu.be/pp1127alone', skill: 'fake-notes', ack: 'Fake Notes 에서 만들게요.' })
  const r0 = llm.router.length, f0 = llm.front.length, e0 = events.length
  const ack = await runTurn({ user, session, threadId: tid, text: 'https://youtu.be/pp1127alone' })
  assert.equal(llm.router.length, r0 + 1, '유튜브 링크도 연결 서비스 지름길로 가지 않고 라우터가 본다')
  const sys = llm.router.at(-1).sys
  assert.ok(sys.includes('[프로젝트 계획]') && sys.includes('Fake Notes (서버 브라우저 스킬 fake-notes)'), '라우터의 프롬프트에 계획')
  assert.match(sys, /browser_task 에 그 skill 을 쓴다/)
  assert.ok(llm.front.length > f0 && llm.front.at(-1).user.includes('[프로젝트 계획]'), '앞단 계획도 계획을 배경으로')
  assert.match(llm.front.at(-1).sys, /"memory": true\|false/)
  assert.equal(ack.content.text, 'Fake Notes 에서 만들게요.')
  const started = browserStarts.at(-1)
  assert.equal(started.skill, 'fake-notes')
  assert.ok(started.goal.includes('[프로젝트 계획]'))
  const planEv = await until(() => events.slice(e0).filter((e) => e.type === 'turn.plan' && e.data.threadId === tid && e.data.handler?.kind === 'browser').at(-1))
  assert.equal(planEv.data.handler.skill, 'fake-notes')
  assert.equal(planEv.data.handler.label, '브라우저 · Fake Notes', '계획 카드: 브라우저 · <스킬의 이름>')
  await cancelTask(tid)
})

test('PP-I-04 「앞으로 …」(11-27 07:05): 프로젝트 방에서는 습관보다 방 판정이 먼저 — 규칙으로(계획을 먼저 고치고 대화를 읽어 받아 적기), 습관 없음', { skip: !up }, async () => {
  const tid = await room()
  await say(tid, 'user', 'Fake Notes 로 이 링크 슬라이드 만들어 줘 https://a.example/1')
  await say(tid, 'agent', '서버 브라우저에서 Fake Notes 로 슬라이드를 만들었어요.')
  await planned(tid, { ...PLAN, intent: '' })
  const h0 = (await habits()).length, o0 = llm.odds.length
  roomJudged.push({ set_rule: 0.91, plan: 0.05, other: 0.04 })
  script.update.push({ ...PLAN, intent: '내가 주는 링크의 내용을 늘 Fake Notes 팟캐스트로 만든다' })
  script.action.push({ action: '이 링크의 내용으로 Fake Notes 에서 팟캐스트를 만든다', skill: 'fake-notes' })
  const ack = await runTurn({ user, session, threadId: tid, text: AGAIN })
  assert.deepEqual(ack.content.roomRule, { said: AGAIN, action: '이 링크의 내용으로 Fake Notes 에서 팟캐스트를 만든다', skill: 'fake-notes', runs: 0 })
  assert.equal((await habits()).length, h0, '습관으로 가지 않는다')
  assert.ok(!llm.odds.slice(o0).some((t) => t.includes('어떤 결과물이 나올 때마다 할 일을 기억해 두라는 말이다')), '습관 판정을 묻지도 않는다')
  // the plan first, then the write-down that reads it with the room's recent messages
  assert.ok(llm.update.at(-1).at < llm.action.at(-1).at, '계획을 먼저 고친다')
  assert.ok(llm.update.at(-1).user.includes(AGAIN))
  const said = llm.action.at(-1).user
  assert.ok(said.startsWith(`정한 말: ${AGAIN}`))
  assert.ok(said.includes('내가 주는 링크의 내용을 늘 Fake Notes 팟캐스트로 만든다'), '받아 적기는 고친 계획을 읽는다')
  assert.ok(said.includes('사람: Fake Notes 로 이 링크 슬라이드 만들어 줘'), '받아 적기는 최근 대화를 읽는다')
  assert.equal((await N.noteRow(user.id, tid)).note.intent, '내가 주는 링크의 내용을 늘 Fake Notes 팟캐스트로 만든다')

  // the main chat: the same words are a habit there, as before
  const main = await mainChat()
  script.ruleOdds.push(true)
  const ok = await runTurn({ user, session, threadId: main, text: AGAIN })
  assert.ok(ok.content.habit, '메인 채팅은 그대로 습관')
  assert.match(ok.content.text, /^기억할게요\./)
  // a project room whose judge says "something else": the habit is read after the judge
  const tid2 = await room('다른 방')
  await planned(tid2)
  roomJudged.push({ set_rule: 0.1, plan: 0.1, other: 0.8 })
  script.ruleOdds.push(true)
  const j0 = roomCalls().length, o1 = llm.odds.length
  const ok2 = await runTurn({ user, session, threadId: tid2, text: '앞으로 오디오 만들면 제목은 영어로 해 줘' })
  assert.ok(ok2.content.habit, '판정이 그 밖이면 그 뒤에 습관')
  assert.equal(roomCalls().length, j0 + 1)
  const habitAsk = llm.odds.slice(o1).findIndex((t) => t.includes('어떤 결과물이 나올 때마다 할 일을 기억해 두라는 말이다'))
  assert.ok(habitAsk >= 0, '습관 판정')
  assert.ok(roomCalls().at(-1).at <= Date.now())
})

test('PP-I-05 처음 채우기: 계획이 없는 방의 첫 턴 — 지난 메시지 · 하위 대화의 제목과 요지 · 지금 규칙 · 방 이름에서, 그 턴의 판정이 읽고, 칩', { skip: !up }, async () => {
  const tid = await room('링크 슬라이드 팟캐스트')
  await say(tid, 'user', MISSION)
  await say(tid, 'agent', '알겠습니다. 이 방에 올리시는 링크와 파일은 앞으로 바로 처리할게요.')
  for (let i = 0; i < 6; i++) await say(tid, i % 2 ? 'agent' : 'user', i % 2 ? `답 ${i}` : `https://a.example/${i}`)
  await say(tid, 'user', MEDIUM)
  await setRule(tid, '이 링크로 미디엄 글은 내 계정으로 인쇄해 PDF 로 만든 뒤 Fake Notes 에 넣는다')
  await q(`insert into context_threads(tenant_id,user_id,conversation_id,title,summary,gist,kind,turns,updated_at) values ($1,$2,$3,'왜 노트북엘엠으로 하나요','최근 요청: 왜 노트북엘엠으로…','노트북엘엠을 쓰는 까닭','conversation',1,now())`,
    [config.tenantId, `${user.id}/project/${tid}`, `pp-topic-${stamp}`])
  assert.equal(await N.noteRow(user.id, tid), null, '아직 계획이 없다')
  script.backfill.push({ intent: '링크 · 파일을 NotebookLM 슬라이드 · 팟캐스트로 만든다', deliverables: ['슬라이드', '팟캐스트'],
    tools: [{ name: 'Fake Notes', kind: 'browser_skill', ref: 'fake-notes', how: '서버 브라우저에서' }, { name: '지어낸 도구', kind: 'service', ref: 'made-up' }],
    constraints: ['미디엄은 내 계정으로 인쇄해 PDF 로 넣는다'], decisions: [] })
  roomJudged.push({ set_rule: 0.02, plan: 0.02, run_rule: 0.94, other: 0.02 })
  const b0 = llm.backfill.length
  await runTurn({ user, session, threadId: tid, text: 'https://youtu.be/pp1127first' })
  assert.equal(llm.backfill.length, b0 + 1, '처음 채우기 한 번')
  const input = llm.backfill.at(-1).user
  assert.ok(input.includes('방 이름: 링크 슬라이드 팟캐스트'))
  assert.ok(input.includes(`사람: ${MISSION}`), '처음의 미션')
  assert.ok(input.includes(`사람: ${MEDIUM}`), '뒤의 세부 지시')
  assert.ok(input.includes('이 방의 규칙: 이 링크로 미디엄 글은'), '지금 규칙')
  assert.ok(input.includes('왜 노트북엘엠으로 하나요 — 노트북엘엠을 쓰는 까닭'), '하위 대화의 제목 · 요지')
  assert.ok(input.includes('fake-notes (서버 브라우저 스킬 · Fake Notes)'), '등록된 도구는 이름 · 설명만')
  const { note } = await N.noteRow(user.id, tid)
  assert.equal(note.intent, '링크 · 파일을 NotebookLM 슬라이드 · 팟캐스트로 만든다')
  assert.deepEqual(note.constraints.map((x) => x.text), ['미디엄은 내 계정으로 인쇄해 PDF 로 넣는다'])
  assert.equal(note.tools.find((t) => t.name === '지어낸 도구').ref, '', '등록되지 않은 ref 는 비운다')
  assert.ok(roomCalls().at(-1).state.includes('목적: 링크 · 파일을 NotebookLM 슬라이드 · 팟캐스트로 만든다'), '그 턴의 판정이 채운 계획을 읽는다')
  const chip = (await msgs(tid)).find((m) => m.kind === 'chip' && m.content.planChange?.backfill)
  assert.equal(chip.content.text, '프로젝트 계획을 채웠어요: 링크 · 파일을 NotebookLM 슬라이드 · 팟캐스트로 만든다')
  await cancelTask(tid)
  // the next turn does not fill it in again
  roomJudged.push({ other: 1 })
  const p = runTurn({ user, session, threadId: tid, text: '고마워요' })
  const h = await nth(streams.length + 1)
  h.push('message', { type: 'token', content: '천만에요.' }); h.end()
  await p
  assert.equal(llm.backfill.length, b0 + 1)
})

test('PP-I-06 턴이 끝나고 앞단 계획이 memory 라고 하면 계획을 고친다 — 도구 ref, 칩, 사람이 고친 항목은 낱말 그대로', { skip: !up }, async () => {
  const tid = await room('정리 방')
  await planned(tid, { intent: '자료를 정리한다', constraints: ['표는 한국어로'] })
  // the person edits the plan: the item they wrote is pinned
  const edited = await N.editNote(user.id, tid, { note: { intent: '자료를 정리한다', constraints: ['표는 한국어로', '출처는 늘 링크로 단다'] } })
  assert.deepEqual(edited.note.constraints.map((x) => [x.text, !!x.pinned]), [['표는 한국어로', false], ['출처는 늘 링크로 단다', true]])
  roomJudged.push({ other: 1 })
  script.front.push({ understood: '앞으로 Fake Notes 를 쓰기로 한 것을 알았어요.', steps: ['기억하기', '답하기'], tier: 'light', certainty: 'sure', memory: true })
  // the model drops the pinned item and adds the tool
  script.update.push({ intent: '자료를 정리한다', tools: [{ name: 'Fake Notes', kind: 'service', ref: 'fake-notes', how: '서버 브라우저로 오디오를 만든다' }], constraints: ['표는 한국어로'] })
  const u0 = llm.update.length
  const p = runTurn({ user, session, threadId: tid, text: '이 방은 앞으로 오디오는 Fake Notes 를 서버 브라우저로 써서 만들자' })
  const h = await nth(streams.length + 1)
  assert.ok(h.body.message.includes('[프로젝트 계획]') && h.body.message.includes('출처는 늘 링크로 단다'), '에이전트에게 가는 메시지에 계획')
  h.push('message', { type: 'token', content: '좋아요.' }); h.end()
  await p
  await until(() => llm.update.length > u0, 8000)
  const chip = await until(async () => (await msgs(tid)).find((m) => m.kind === 'chip' && m.content.planChange && !m.content.planChange.backfill))
  assert.equal(chip.content.text, '계획에 넣었어요: Fake Notes — 서버 브라우저로 오디오를 만든다')
  const { note } = await N.noteRow(user.id, tid)
  assert.deepEqual(note.tools.map((t) => [t.name, t.kind, t.ref]), [['Fake Notes', 'browser_skill', 'fake-notes']])
  assert.ok(note.constraints.some((x) => x.text === '출처는 늘 링크로 단다' && x.pinned), '사람이 고친 항목은 낱말 그대로 남는다')
  assert.ok(llm.update.at(-1).user.includes('출처는 늘 링크로 단다 (고정)'), '모델은 고정 표시를 본다')
  // a turn the front step did not mark, under five turns: no rewrite
  roomJudged.push({ other: 1 })
  const u1 = llm.update.length
  const p2 = runTurn({ user, session, threadId: tid, text: '고마워요' })
  const h2 = await nth(streams.length + 1)
  h2.push('message', { type: 'token', content: '네.' }); h2.end()
  await p2
  await new Promise((r) => setTimeout(r, 300))
  assert.equal(llm.update.length, u1, '다섯 턴이 안 됐고 memory 도 아니면 고치지 않는다')
})

test('PP-I-07 에이전트에게 가는 메시지마다 계획 — 새 하위 대화의 첫 턴 · 스킬 없는 규칙 실행, 규칙 막대의 스킬 고르기', { skip: !up }, async () => {
  const tid = await room('조사 방', `pp-root-${stamp}`)
  await planned(tid)
  roomJudged.push({ other: 1 })
  topicRoutes.push({ action: 'new', conversation_id: `pp-new-topic-${stamp}`, context: { title: '새 주제' } })
  const p = runTurn({ user, session, threadId: tid, text: '이 주제와 상관없는 새 질문: 다음 주 일정 정리해 줘' })
  const h = await nth(streams.length + 1)
  assert.equal(h.body.conversation_id, `pp-new-topic-${stamp}`, '새 하위 대화')
  assert.ok(h.body.message.includes('[프로젝트 계획]') && h.body.message.includes(PLAN.intent), '하위 대화의 첫 메시지에 계획')
  h.push('message', { type: 'token', content: '정리했어요.' }); h.end()
  await p
  // a rule with no skill: the bar reads 「에이전트가 처리」 (label ''), the run goes to the agent with the plan
  await setRule(tid, '이 파일을 영어로 번역한다', '')
  const r = await R.ruleOf(user.id, tid)
  assert.equal(r.skill, '')
  assert.equal(r.label, '')
  roomJudged.push({ run_rule: 0.95, other: 0.05 })
  const p2 = runTurn({ user, session, threadId: tid, text: 'https://a.example/doc' })
  const h2 = await nth(streams.length + 1)
  assert.ok(h2.body.message.startsWith('이 파일을 영어로 번역한다\n사용자가 이 방에 준 것: https://a.example/doc'))
  assert.equal(h2.body.message.split('[프로젝트 계획]').length - 1, 1, '계획은 한 번(할 일에 겹쳐 붙지 않는다)')
  h2.push('message', { type: 'token', content: '번역했어요.' }); h2.end()
  await p2
  // the bar's picker: a browser skill, or back to the agent; an unknown name is refused
  assert.equal((await R.setRuleSkill(user.id, tid, 'fake-notes')).label, 'Fake Notes')
  assert.equal((await R.setRuleSkill(user.id, tid, '')).skill, '')
  await assert.rejects(R.setRuleSkill(user.id, tid, 'no-such'), (e) => e.status === 400)
  assert.equal(await R.setRuleSkill(other.id, tid, 'fake-notes'), null, '다른 사람의 방은 바꾸지 못한다')
})

test('PP-I-08 되돌리기는 그 앞의 행으로 · 계획은 주인만 · 채팅 목록에 보이지 않음', { skip: !up }, async () => {
  const tid = await room('되돌리기 방')
  const first = await planned(tid, { intent: '목적', constraints: ['하나'] })
  roomJudged.push({ plan: 0.9, other: 0.1 })
  script.add.push({ to: 'decisions', text: '보고서는 매주 금요일에 낸다', replaces: '' })
  const chip = await runTurn({ user, session, threadId: tid, text: '보고서는 매주 금요일에 내는 걸로 하자' })
  assert.equal(chip.content.text, '계획에 넣었어요: 보고서는 매주 금요일에 낸다')
  assert.deepEqual((await N.noteRow(user.id, tid)).note.decisions.map((x) => x.text), ['보고서는 매주 금요일에 낸다'])
  const back = await N.undoChange(user.id, tid, chip.id)
  // (the plan is the row before that change again — as a new row of its own: the history keeps the change and its revert)
  assert.deepEqual({ ...back.note, upTo: undefined, updatedAt: undefined, editedBy: undefined, change: undefined }, { ...N.normalize(first.note), upTo: undefined, updatedAt: undefined, editedBy: undefined, change: undefined }, '그 앞의 행으로')
  assert.deepEqual(back.note.decisions, [])
  assert.deepEqual(back.history.slice(0, 2).map((h) => [h.kind, h.reverted]), [['revert', false], ['add', true]])
  assert.equal(back.chip.content.planChange.undone, true)
  // (the words that change read stay read: the next rewrite does not put back what was just taken out)
  const said = (await msgs(tid)).filter((m) => m.role === 'user').at(-1)
  assert.equal((await N.noteRow(user.id, tid)).note.upTo, said.id)
  assert.equal(await N.turnsSince(tid, said.id), 0)
  await assert.rejects(N.undoChange(user.id, tid, chip.id), (e) => e.status === 409, '두 번은 못 한다')
  // someone else: not found, not changed
  await assert.rejects(N.getNote(other.id, tid), (e) => e.status === 404)
  await assert.rejects(N.editNote(other.id, tid, { note: { intent: '남의 목적' } }), (e) => e.status === 404)
  await assert.rejects(N.undoChange(other.id, tid, chip.id), (e) => e.status === 404)
  assert.equal((await N.getNote(user.id, tid)).note.intent, '목적')
  // the plan's rows are the room's but never a chat message (GET /api/threads/:id/messages leaves them out)
  const shown = await q(`select kind from pro_messages where thread_id=$1 and kind <> 'note'`, [tid])
  assert.ok(!shown.some((m) => m.kind === 'note'))
  assert.ok((await q(`select 1 from pro_messages where thread_id=$1 and kind='note'`, [tid])).length >= 1)
  // the history keeps twenty rows
  for (let i = 0; i < 22; i++) await N.saveNote(user.id, tid, N.normalize({ intent: `목적 ${i}` }))
  assert.equal((await q(`select count(*)::int as n from pro_messages where thread_id=$1 and kind='note'`, [tid]))[0].n, 20)
})

test('PP-I-09 「뒤로 갈수록 휘발」 — 미션 뒤로 64개 메시지가 쌓여도: 처음 채우기가 미션을 읽고, 링크만 보내도 계획의 목적대로(요약이 아니라 그 스킬로)', { skip: !up }, async () => {
  // a room whose mission was said first, then 64 messages about other things (as a long room grows) — no plan yet, no rule
  const tid = await room('링크 슬라이드 팟캐스트 (긴 방)')
  await say(tid, 'user', MISSION)
  await say(tid, 'agent', '알겠습니다. 이 방에 올리시는 링크와 파일은 앞으로 바로 처리할게요.')
  for (let i = 0; i < 64; i++) await say(tid, i % 2 ? 'agent' : 'user', i % 2 ? `답 ${i}: 정리했어요.` : `다른 이야기 ${i}: 회의 일정 좀 정리해 줘`)
  assert.ok((await msgs(tid)).length >= 66)
  // the fake backfill writes the mission's plan only when the mission is among what it was given
  const b0 = llm.backfill.length
  script.backfillFn = (input) => (input.includes(MISSION) ? PLAN : { intent: '회의 일정을 정리한다' })
  // the fake router: the plan's skill only when the plan is in its prompt; else a summary (DELEGATE) — the mission itself is far out of its window
  script.routerFn = (sys) => (sys.includes('[프로젝트 계획]') && sys.includes('fake-notes') ? { goal: '이 링크로 Fake Notes 팟캐스트를 만든다', skill: 'fake-notes', ack: 'Fake Notes 로 팟캐스트를 만들게요.' } : null)
  roomJudged.push({ set_rule: 0.05, plan: 0.05, other: 0.9 })
  const r0 = llm.router.length
  const ack = await runTurn({ user, session, threadId: tid, text: 'https://youtu.be/pp1127late' }).finally(() => { script.backfillFn = null; script.routerFn = null })
  assert.equal(llm.backfill.length, b0 + 1)
  const input = llm.backfill.at(-1).user
  assert.ok(input.includes(`사람: ${MISSION}`), '처음 채우기가 첫 메시지의 미션을 읽는다(마지막 40개만이 아니라)')
  assert.match(input, /중간의 메시지 \d+개는 생략/)
  assert.equal((await N.noteRow(user.id, tid)).note.intent, PLAN.intent)
  assert.equal(llm.router.length, r0 + 1)
  const rb = llm.router.at(-1).body
  assert.ok(!rb.messages.some((m) => String(m.content).includes(MISSION)), '미션은 라우터의 최근 대화에 없다')
  assert.ok(llm.router.at(-1).sys.includes(PLAN.intent), '계획은 라우터의 프롬프트에 있다')
  assert.equal(ack.content.text, 'Fake Notes 로 팟캐스트를 만들게요.')
  const started = browserStarts.at(-1)
  assert.equal(started.skill, 'fake-notes', '요약이 아니라 계획의 도구로')
  assert.ok(started.goal.includes('[프로젝트 계획]'))
  await cancelTask(tid)
  script.routerFn = null
  // the same long room, later still: an agent turn and a rule run carry the plan too
  for (let i = 0; i < 10; i++) await say(tid, i % 2 ? 'agent' : 'user', `더 지난 이야기 ${i}`)
  roomJudged.push({ other: 1 })
  script.routerFn = null
  // (the rewrite every few turns reads these ten — the fake model answers it with nothing, which must not empty the plan)
  const n0 = streams.length
  const p = runTurn({ user, session, threadId: tid, text: '지금까지 만든 것 목록 알려 줘' })
  const h = await nth(n0 + 1)
  assert.ok(h.body.message.includes('[프로젝트 계획]') && h.body.message.includes(PLAN.intent), '에이전트에게 가는 메시지에 계획')
  h.push('message', { type: 'token', content: '두 개예요.' }); h.end()
  await p
  await setRule(tid, '이 링크나 파일로 Fake Notes 에서 팟캐스트를 만든다')
  roomJudged.push({ run_rule: 0.95, other: 0.05 })
  await runTurn({ user, session, threadId: tid, text: 'https://youtu.be/pp1127later' })
  assert.ok(browserStarts.at(-1).goal.includes(PLAN.intent), '규칙 실행의 할 일에 계획')
  await cancelTask(tid)
  assert.equal((await N.noteRow(user.id, tid)).note.intent, PLAN.intent, '빈 답은 계획을 비우지 않는다')
})

test('PP-I-10 바뀐 기록 — 변경마다 언제 · 누가 · 무엇이 · 어느 메시지에서, 직접 고친 것도, 어느 기록이든 되돌리고 되돌린 것도 기록', { skip: !up }, async () => {
  const tid = await room('방향이 바뀌는 방')
  await say(tid, 'user', MISSION)
  roomJudged.push({ other: 1 })
  script.backfill.push({ intent: '링크를 Fake Notes 팟캐스트로', constraints: ['오디오는 한국어로'] })
  const p0 = runTurn({ user, session, threadId: tid, text: '시작해 볼게' })
  const h0 = await nth(streams.length + 1)
  h0.push('message', { type: 'token', content: '네.' }); h0.end()
  await p0
  // a direction set mid-way, in the room (계획에 넣기)
  roomJudged.push({ plan: 0.9, other: 0.1 })
  script.add.push({ to: 'decisions', text: '팟캐스트는 10분 안으로 만든다', replaces: '' })
  const said1 = '앞으로 팟캐스트는 10분 안으로 하자'
  await runTurn({ user, session, threadId: tid, text: said1 })
  const m1 = (await msgs(tid)).filter((m) => m.role === 'user' && m.content.text === said1).at(-1)
  // another one changes an item
  roomJudged.push({ plan: 0.9, other: 0.1 })
  script.add.push({ to: 'constraints', text: '오디오는 영어로', replaces: 'c1' })
  const said2 = '오디오는 이제 영어로 만들어'
  await runTurn({ user, session, threadId: tid, text: said2 })
  // the owner edits by hand
  const now = await N.getNote(user.id, tid)
  await N.editNote(user.id, tid, { note: { ...now.note, deliverables: [{ text: '팟캐스트 MP3' }] } })
  const { history, note } = await N.getNote(user.id, tid)
  assert.deepEqual(history.map((h) => [h.kind, h.by]), [['edit', 'person'], ['add', 'person'], ['add', 'person'], ['backfill', 'assistant']])
  assert.equal(history[0].text, '직접 고쳤어요: 팟캐스트 MP3')
  assert.equal(history[1].text, '계획에 넣었어요: 오디오는 영어로')
  assert.equal(history[1].from.text, said2, '어느 메시지에서')
  assert.equal(history[2].from.messageId, m1.id)
  assert.equal(history[2].text, '계획에 넣었어요: 팟캐스트는 10분 안으로 만든다')
  assert.ok(history.every((h) => h.at && !Number.isNaN(new Date(h.at).getTime())), '언제')
  assert.equal(history[3].text, '프로젝트 계획을 채웠어요: 링크를 Fake Notes 팟캐스트로')
  assert.ok(history[0].current && !history[1].current)
  assert.deepEqual(note.constraints.map((x) => x.text), ['오디오는 영어로'])
  // revert an older entry (later changes stay): only what it did is taken back
  const r = await N.revertChange(user.id, tid, history[2].id)
  assert.deepEqual(r.note.decisions, [], '10분 결정만 빠진다')
  assert.deepEqual(r.note.constraints.map((x) => x.text), ['오디오는 영어로'], '뒤의 변경은 그대로')
  assert.deepEqual(r.note.deliverables.map((x) => x.text), ['팟캐스트 MP3'], '직접 고친 것도 그대로')
  assert.equal(r.history[0].kind, 'revert')
  assert.equal(r.history[0].text, '되돌렸어요: 계획에 넣었어요: 팟캐스트는 10분 안으로 만든다')
  assert.equal(r.history[0].revertable, false)
  assert.equal(r.history.find((h) => h.id === history[2].id).reverted, true)
  const chip = (await msgs(tid)).find((m) => m.kind === 'chip' && m.content.planChange?.noteId === history[2].id)
  assert.equal(chip.content.planChange.undone, true, '그 변경의 칩도 「되돌렸어요」')
  await assert.rejects(N.revertChange(user.id, tid, history[2].id), (e) => e.status === 409)
  await assert.rejects(N.revertChange(user.id, tid, r.history[0].id), (e) => e.status === 400, '되돌린 기록은 다시 되돌리지 않는다')
  // the hand edit can be reverted too; and the first fill
  const r2 = await N.revertChange(user.id, tid, history[0].id)
  assert.deepEqual(r2.note.deliverables, [])
  // an edit that changes nothing adds no entry
  const n = (await N.getNote(user.id, tid)).history.length
  await N.editNote(user.id, tid, { note: r2.note })
  assert.equal((await N.getNote(user.id, tid)).history.length, n)
  await assert.rejects(N.revertChange(other.id, tid, history[1].id), (e) => e.status === 404, '다른 사람은 되돌리지 못한다')
})

