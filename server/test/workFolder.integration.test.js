// 작업 폴더 · 버전 — a real turn (lib/agent.js runTurn → delegate, the real database): what the agent is sent and what file cards it leaves
// (spec openspec/specs/chat-artifacts 「한 턴의 결과물은 작업 폴더와 버전에」). deepagents and the model are faked here (fetch swapped, as
// test/turnPlan.integration.test.js does): the model answers the front plan and the work-folder question; deepagents takes the message and
// writes the files the test says. The test person is a random id, removed at the end. Skipped without a database.
//   WF-I-01 new work: the message carries 「작업 폴더: … '교육-과정/v1/'」; the files land as cards with their folder paths
//   WF-I-02 「처음부터 다시」: the model is shown 교육-과정 (v1) and answers redo — the line names v2 and to keep v1
//   WF-I-03 a revision: the latest version, edited in place, no copies
//   WF-I-04 the model down (500) — and a light front plan: no line, no work-folder call
//   WF-I-05 (PR #135 review) the reading starts with the plan (runTurn) and the turn never waits for it: a model still answering a moment
//           after the plan block is dropped — the agent gets the message without the line, well before the model would have answered
//   WF-I-07 (PR #135 confirmation review) the usual timing: the plan takes ~1.5 s, the model ~1 s (and 2.5 s) — the note reaches the agent
//   WF-I-06 (PR #135 review) the model names the work 「process improvement plan」: placed as work-process-improvement-plan/v1, and its files
//           come back as cards (a process-* folder would be read as a process generation and show none)
//   WF-I-08 (PR #135 demo) a small web page: its app.js is a card beside index.html · style.css · README.md (every script used to be
//           dropped once the turn left any document); node_modules · a dot folder's helper are not — nor a script beside a document a
//           program built (a workbook deepagents stored)
//   WF-I-09 (PR #135 demo) a revision in place posts a second card for the same path; the chat keeps both, the list and the pile
//           (src/artifactScope.js artifactItems) read the thread's messages as one row per file — its newest card
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
  if (sys.includes('what you understood and how the work will go')) {
    if (llm.planDelay) await new Promise((r) => setTimeout(r, llm.planDelay))
    return reply(JSON.stringify({ understood: '교육 과정 자료를 만들어 달라는 요청으로 이해했어요.', steps: ['자료 만들기'], tier: llm.tier, certainty: 'sure' }))
  }
  if (sys.includes('keeps the files of one piece of work')) {
    llm.folder.push(String(body.messages?.[1]?.content || ''))
    const a = typeof llm.answer === 'function' ? llm.answer() : llm.answer
    if (llm.delay) await new Promise((r) => setTimeout(r, llm.delay))
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
    agent.at = Date.now()
    const conv = body.conversation_id || `wfi-${crypto.randomBytes(4).toString('hex')}`
    const files = agent.files.splice(0)
    const rs = new ReadableStream({ start(c) {
      const push = (data, event = 'message') => c.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
      push({ conversation_id: conv }, 'metadata')
      push({ type: 'token', content: '만들었어요.' })
      // (a file given as {rel, url}: a document a program built, stored by deepagents — a file_artifact with its url, no write of the agent's)
      for (const f of files) {
        const rel = typeof f === 'string' ? f : f.rel
        push({ type: 'file_artifact', name: rel.split('/').pop(), path: `/workspace/.bpmn/${conv}/${rel}`, ext: rel.split('.').pop(), ...(f.url ? { url: f.url } : {}) })
      }
      push({ type: 'done', content: '만들었어요.' })
      c.close()
    } })
    return new Response(rs, { headers: { 'Content-Type': 'text/event-stream' } })
  }
  if (/\/servers$|\/bindings$|\/skills\?/.test(u)) return json([])
  return realFetch(url, opts)
}

const { runTurn } = await import('../lib/agent.js')
const { artifactItems, artifactSections } = await Promise.all([import('../../src/artifactScope.js'), import('../../src/fileGroups.js')]).then(([a, g]) => ({ ...a, ...g }))
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
  // (the reading starts when the message comes, beside the plan — it has the person's request; the whole chat's folders)
  assert.match(llm.folder[0], /The person's request:\n가나정밀 교육 과정 자료를/)
  assert.match(llm.folder[0], /Existing work folders in this chat or project — any of its conversations \(JSON, one per line\):\n\(none\)/)
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
  assert.ok(llm.folder[1].includes('- {"folder":"교육-과정","versions":["v1"],"latest":"v1","files":['), llm.folder[1])
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
  assert.ok(llm.folder.at(-1).includes('{"folder":"교육-과정","versions":["v1","v2"],"latest":"v2"'), llm.folder.at(-1))
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
  // (the model is asked at once; the light plan stops the reading — no line)
  assert.ok(llm.folder.length <= asked + 1)
  assert.doesNotMatch(lastMessage(), /작업 폴더/)
})

test('WF-I-05 the turn never waits for the reading: a model still answering after the plan block is dropped', { skip: !up }, async () => {
  llm.tier = 'standard'
  llm.answer = { files: 'several', mode: 'new', folder: '', name: '늦은 자료', confidence: 0.95 }
  llm.delay = 4500
  const n = agent.bodies.length
  const t0 = Date.now()
  try {
    await runTurn({ user, session, threadId: tid, text: '분기 보고 자료 여러 개 만들어 줘' })
  } finally { llm.delay = 0 }
  assert.equal(agent.bodies.length, n + 1)
  assert.doesNotMatch(lastMessage(), /작업 폴더/)
  assert.ok(agent.at - t0 < 3500, `the agent was asked ${agent.at - t0} ms after the message — not after the model's 4.5 s (1.5 s grace after the plan block)`)
})

test('WF-I-06 a work named like a process folder: work-process-improvement-plan/v1, and its files are cards', { skip: !up }, async () => {
  llm.answer = { files: 'several', mode: 'new', folder: '', name: 'process improvement plan', confidence: 0.93 }
  agent.files.push(...['README.md', 'as-is.md', 'to-be.md', 'roadmap.md'].map((f) => `work-process-improvement-plan/v1/${f}`))
  const before = (await cards()).length
  await runTurn({ user, session, threadId: tid, text: '우리 팀 업무 처리 개선 계획 문서 여러 개 만들어 줘' })
  assert.match(lastMessage(), /산출물 폴더 안의 'work-process-improvement-plan\/v1\/'/)
  const cs = (await cards()).slice(before)
  assert.equal(cs.length, 4, JSON.stringify(cs.map((c) => c.path)))
  assert.ok(cs.every((c) => c.path.includes('/work-process-improvement-plan/v1/')))
})

test('WF-I-07 the usual timing: a plan that takes ~1.5 s and a model that takes ~1 s (or 2.5 s) — the note reaches the agent', { skip: !up }, async () => {
  llm.tier = 'standard'
  try {
    for (const [plan, model, name] of [[1500, 1000, '분기 보고 자료'], [1500, 2500, '분기 회의 자료']]) {
      llm.planDelay = plan
      llm.delay = model
      llm.answer = { files: 'several', mode: 'new', folder: '', name, confidence: 0.93 }
      const t0 = Date.now()
      await runTurn({ user, session, threadId: tid, text: `${name} 여러 개 만들어 줘` })
      assert.match(lastMessage(), new RegExp(`산출물 폴더 안의 '${name.replaceAll(' ', '-')}\\/v1\\/'`), `plan ${plan} ms, model ${model} ms`)
      assert.ok(agent.at - t0 < plan + 1500 + 1000, `asked ${agent.at - t0} ms after the message`)
    }
  } finally { llm.planDelay = 0; llm.delay = 0 }
})
test('WF-I-08 a small web page: app.js is a card with the page\'s other files; node_modules · a dot folder\'s helper are not; a script beside a built document is not', { skip: !up }, async () => {
  llm.tier = 'standard'
  llm.answer = { files: 'several', mode: 'new', folder: '', name: '작은 웹 페이지', confidence: 0.93 }
  const page = ['index.html', 'app.js', 'style.css', 'README.md'].map((f) => `작은-웹-페이지/v1/${f}`)
  agent.files.push(...page, '작은-웹-페이지/v1/node_modules/left-pad/index.js', '.cache/check.py')
  const before = (await cards()).length
  await runTurn({ user, session, threadId: tid, text: '할 일 목록 작은 웹 페이지 만들어 줘. html, css, js 로' })
  assert.match(lastMessage(), /산출물 폴더 안의 '작은-웹-페이지\/v1\/'/)
  const cs = (await cards()).slice(before)
  assert.deepEqual(cs.map((c) => c.path.replace(/^\/workspace\/\.bpmn\/[^/]+\//, '')).sort(), [...page].sort(), JSON.stringify(cs.map((c) => c.path)))
  // a script that built a workbook (stored by deepagents: a url, no write of the agent's): the workbook is the card, the script is not
  llm.answer = { files: 'one', mode: 'new', folder: '', name: '정산표', confidence: 0.9 }
  agent.files.push('make_sheet.py', { rel: '정산표.xlsx', url: 'http://127.0.0.1:9/정산표.xlsx' })
  const mid = (await cards()).length
  await runTurn({ user, session, threadId: tid, text: '정산표를 엑셀로 만들어 줘' })
  assert.deepEqual((await cards()).slice(mid).map((c) => c.name), ['정산표.xlsx'])
})

test('WF-I-09 a revision in place: a second card for the same path stays in the chat; the list and the pile count the file once', { skip: !up }, async () => {
  llm.tier = 'standard'
  llm.answer = { files: 'several', mode: 'new', folder: '', name: '신입 과정', confidence: 0.93 }
  const v1 = ['README.md', 'modules/module-1.md', 'modules/module-2.md', 'modules/module-3.md', 'labs/lab-1.md'].map((f) => `신입-과정/v1/${f}`)
  agent.files.push(...v1)
  await runTurn({ user, session, threadId: tid, text: '신입 과정 모듈과 실습 자료 여러 개 만들어 줘' })
  llm.answer = { files: 'one', mode: 'revise', folder: '신입-과정', name: '신입 과정', confidence: 0.9 }
  agent.files.push('신입-과정/v1/modules/module-2.md')
  await runTurn({ user, session, threadId: tid, text: '2주차 모듈만 실습 위주로 고쳐 줘' })
  assert.match(lastMessage(), /'신입-과정\/v1\/' 의 파일을 고치는 일이에요/)
  const rows = await q(`select id, role, kind, content, created_at from pro_messages where thread_id=$1 order by created_at, id`, [tid])
  const same = rows.filter((m) => m.kind === 'file' && m.content.path?.endsWith('/신입-과정/v1/modules/module-2.md'))
  assert.equal(same.length, 2, 'the chat keeps the first card and the revision\'s')
  const items = artifactItems({ scope: 'project', messages: rows })
  const ours = items.filter((x) => x.msg.content.path?.includes('/신입-과정/v1/'))
  assert.equal(ours.length, 5)
  assert.deepEqual(ours.filter((x) => x.msg.content.name === 'module-2.md').map((x) => x.msg.id), [same[1].id])
  const sec = artifactSections(items).find((s) => s.folder === '신입-과정' && s.version === 1)
  assert.equal(sec.items.length, 5)
  // every file of the thread once
  assert.equal(items.length, new Set(rows.filter((m) => m.kind === 'file').map((m) => m.content.path)).size)
})
