// 작업 폴더 · 버전 — a real turn (lib/agent.js runTurn → delegate, the real database): what the agent is sent and what file cards it leaves
// (spec openspec/specs/chat-artifacts 「한 턴의 결과물은 작업 폴더와 버전에」). deepagents and the model are faked here (fetch swapped, as
// test/turnPlan.integration.test.js does): the model answers the front plan and the work-folder question; deepagents takes the message and
// writes the files the test says. The test person is a random id, removed at the end. Skipped without a database.
//   WF-I-01 new work: the message carries 「작업 폴더: … '교육-과정/v1/'」; the files land as cards with their folder paths
//   WF-I-02 「처음부터 다시」: the model is shown 교육-과정 (v1) and answers redo — the line names v2 and to keep v1
//   WF-I-03 a revision: the latest version, edited in place, no copies
//   WF-I-04 the model down (500) — and a light front plan: no line, no work-folder call
//   cd server && node --test --test-concurrency=1 test/workFolder.integration.test.js
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { config } from '../config.js'
import { q, pool } from '../lib/supa.js'

const up = await q('select 1').then(() => true, () => false)
const realFetch = globalThis.fetch
const enc = new TextEncoder()
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } })
const reply = (content) => json({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] })

// ---- the fake model: the front plan (its tier set by the test), the work-folder question (answered by the test), DELEGATE for the router ----
const llm = { folder: [], tier: 'standard', answer: null }
async function fakeLlm(body) {
  const sys = String(body.messages?.[0]?.content || '')
  if (body.logprobs) return json({ choices: [{ message: { content: 'A' }, logprobs: { content: [{ token: 'A', logprob: Math.log(0.9), top_logprobs: [{ token: 'A', logprob: Math.log(0.9) }] }] } }] })
  if (sys.includes('what you understood and how the work will go')) return reply(JSON.stringify({ understood: '교육 과정 자료를 만들어 달라는 요청으로 이해했어요.', steps: ['자료 만들기'], tier: llm.tier, certainty: 'sure' }))
  if (sys.includes('keeps the files of one piece of work')) {
    llm.folder.push(String(body.messages?.[1]?.content || ''))
    const a = typeof llm.answer === 'function' ? llm.answer() : llm.answer
    return a?.status ? json({ error: 'down' }, a.status) : reply(JSON.stringify(a || {}))
  }
  if (body.tools) return reply('DELEGATE')
  return reply(body.response_format ? '{}' : 'OK')
}
// ---- the fake deepagents: the message kept, the files the test gives written as file_artifact events in the conversation's folder ----
const agent = { bodies: [], files: [] }
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url)
  if (u.startsWith(config.llm.baseUrl)) return fakeLlm(opts.body ? JSON.parse(opts.body) : {})
  if (u.startsWith(config.deepagentsUrl)) {
    const body = opts.body ? JSON.parse(opts.body) : {}
    if (u.endsWith('/chat/stop')) return json({ stopped: false })
    if (!u.endsWith('/chat/stream')) return json([])
    agent.bodies.push(body)
    const conv = body.conversation_id || `wfi-${crypto.randomBytes(4).toString('hex')}`
    const files = agent.files.splice(0)
    const rs = new ReadableStream({ start(c) {
      const push = (data, event = 'message') => c.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
      push({ conversation_id: conv }, 'metadata')
      push({ type: 'token', content: '만들었어요.' })
      for (const rel of files) push({ type: 'file_artifact', name: rel.split('/').pop(), path: `/workspace/.bpmn/${conv}/${rel}`, ext: rel.split('.').pop() })
      push({ type: 'done', content: '만들었어요.' })
      c.close()
    } })
    return new Response(rs, { headers: { 'Content-Type': 'text/event-stream' } })
  }
  if (/\/servers$|\/bindings$|\/skills\?/.test(u)) return json([])
  return realFetch(url, opts)
}

const { runTurn } = await import('../lib/agent.js')
const user = { id: crypto.randomUUID(), email: `pro-fix-wfi-${crypto.randomBytes(3).toString('hex')}@uengine.org`, name: '시험' }
const session = { access_token: 'test-token' }
let tid = null
const lastMessage = () => String(agent.bodies.at(-1)?.message || '')
const cards = async () => (await q(`select content from pro_messages where thread_id=$1 and kind='file' order by created_at`, [tid])).map((m) => m.content)
after(async () => {
  globalThis.fetch = realFetch
  if (up && tid) await q('delete from pro_threads where id=$1', [tid]).catch(() => {})
  if (up) await q('delete from pro_followups where user_id=$1', [user.id]).catch(() => {})
  await pool.end()
  const { closeOntology } = await import('../lib/ontology/store.js')
  await closeOntology().catch(() => {})
})

test('WF-I-01 new work: the agent is told the work folder\'s first version, and its files come back as cards in that folder', { skip: !up }, async () => {
  ;[{ id: tid }] = await q(`insert into pro_threads(user_id,kind,title) values ($1,'chat','시험') returning id`, [user.id])
  llm.tier = 'standard'
  llm.answer = { files: 'several', mode: 'new', folder: '', name: '교육 과정', confidence: 0.92 }
  agent.files.push('교육-과정/v1/README.md', '교육-과정/v1/constitution.md', '교육-과정/v1/syllabus/week-1.md', '교육-과정/v1/syllabus/week-2.md', '교육-과정/v1/starter/README.md')
  await runTurn({ user, session, threadId: tid, text: '가나정밀 교육 과정 자료를 스펙킷 방식으로 만들어 줘' })
  assert.equal(llm.folder.length, 1)
  // (the reading starts while the front plan is still coming — it has the person's request; the plan's sentence only when it was already there)
  assert.match(llm.folder[0], /The person's request:\n가나정밀 교육 과정 자료를/)
  assert.match(llm.folder[0], /Existing work folders in this conversation:\n\(none\)/)
  const m = lastMessage()
  assert.match(m, /\(작업 폴더: 이번 결과물은 산출물 폴더 안의 '교육-과정\/v1\/' 에 두세요\(이 일의 버전 1\)/)
  // (after the file-location line and the plan block, before nothing of the person's words)
  assert.ok(m.indexOf('(작업 폴더:') > m.indexOf('(파일 위치 규칙:'), 'after the workspace line')
  assert.ok(m.startsWith('가나정밀 교육 과정 자료를'))
  const cs = await cards()
  assert.equal(cs.length, 5)
  assert.ok(cs.every((c) => /^\/workspace\/\.bpmn\/[^/]+\/교육-과정\/v1\//.test(c.path)), JSON.stringify(cs.map((c) => c.path)))
})

test('WF-I-02 「처음부터 다시」: the model sees the folder and its version; the line names the next version and keeps the earlier one', { skip: !up }, async () => {
  llm.answer = { files: 'several', mode: 'redo', folder: '교육-과정', name: '교육 과정', confidence: 0.88 }
  agent.files.push('교육-과정/v2/README.md', '교육-과정/v2/syllabus/week-1.md', '교육-과정/v2/syllabus/week-2.md', '교육-과정/v2/syllabus/week-3.md')
  await runTurn({ user, session, threadId: tid, text: '방향이 별로야. 처음부터 다른 구성으로 다시 만들어 줘' })
  assert.equal(llm.folder.length, 2)
  assert.match(llm.folder[1], /- 교육-과정: versions v1 \(latest v1: /)
  assert.match(llm.folder[1], /syllabus\/week-1\.md/)
  const m = lastMessage()
  assert.match(m, /새 버전 산출물 폴더 안의 '교육-과정\/v2\/' 에 두세요\(버전 2\)/)
  assert.match(m, /이전 버전 산출물 폴더 안의 '교육-과정\/v1\/' 의 파일은 고치거나 지우지 말고 그대로/)
  const cs = await cards()
  assert.equal(cs.length, 9)
  assert.equal(cs.filter((c) => c.path.includes('/교육-과정/v1/')).length, 5)
})

test('WF-I-03 a revision of parts: the latest version, edited in place — no copies', { skip: !up }, async () => {
  llm.answer = { files: 'one', mode: 'revise', folder: '교육-과정', name: '교육 과정', confidence: 0.9 }
  await runTurn({ user, session, threadId: tid, text: '2주차 내용만 실습 위주로 고쳐 줘' })
  assert.match(llm.folder.at(-1), /- 교육-과정: versions v1, v2 \(latest v2: /)
  const m = lastMessage()
  assert.match(m, /이번 요청은 산출물 폴더 안의 '교육-과정\/v2\/' 의 파일을 고치는 일이에요\. 고칠 파일을 그 자리에서 고치고/)
  assert.doesNotMatch(m, /새 버전/)
})

test('WF-I-04 the model down, or a light one-off: no line — the turn goes as before', { skip: !up }, async () => {
  llm.answer = { status: 500 }
  await runTurn({ user, session, threadId: tid, text: '보고서 세 개 만들어 줘' })
  assert.doesNotMatch(lastMessage(), /작업 폴더/)
  const asked = llm.folder.length
  llm.tier = 'light'
  llm.answer = { files: 'several', mode: 'new', name: '아무거나', confidence: 0.99 }
  await runTurn({ user, session, threadId: tid, text: '오늘 회의 몇 시였지?' })
  // (the reading may already be on its way when the plan says light — it is dropped: no line)
  assert.ok(llm.folder.length <= asked + 1)
  assert.doesNotMatch(lastMessage(), /작업 폴더/)
})
