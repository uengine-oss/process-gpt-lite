// 채팅 턴 (lib/agent.js runTurn → delegate) — deepagents 를 흉내 낸 스트림으로, 실제 DB 위에서:
//   · 답을 기다리는 중 같은 대화에 보낸 메시지는 대기했다가 이어서 답을 받는다 (#31·#32)
//   · 멈추기는 deepagents /chat/stop 을 부르고 "답을 멈췄어요" 로 끝난다 (#25)
//   · 다른 사람 문서는 파일 카드가 되지 않고, 이 대화 폴더의 문서만 원래 이름으로 붙는다 (#6·#39)
//   · 공유하지 않은 내 스킬을 파일과 함께 부르면 스킬 위치와 첨부가 함께 간다 (#18)
//   · 빈 답은 빈 말풍선이 아니라 안내 문장으로
//   · 새 프로세스 초안 카드는 이번 턴이 쓴 정의(폴더) — 스트림에 먼저 온 스킬 예시('휴가 신청 프로세스')가
//     아니고, 프로세스 폴더 안의 스킬(process-*/skills/xlsx)은 스킬 초안 카드가 아님. 정의를 쓰지 않은 턴(초안 제안)은 카드 없음
// 데이터베이스(supabase-db)가 없으면 건너뜀. 시험 사용자는 무작위 id(로그인 계정 아님), 끝나면 지움.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { config } from '../config.js'
import { q, pool } from '../lib/supa.js'
import fs from 'node:fs/promises'
import path from 'node:path'
import { PGPT_ROOT } from '../lib/paths.js'

const up = await q('select 1').then(() => true, () => false)

// ---- a scripted deepagents: every /chat/stream call becomes a stream the test writes into ----
const realFetch = globalThis.fetch
const streams = []
const stops = []
let wake = []
const enc = new TextEncoder()
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url)
  if (u.startsWith(config.deepagentsUrl) || (config.contextRouterUrl && u.startsWith(config.contextRouterUrl))) {
    const body = opts.body ? JSON.parse(opts.body) : {}
    if (u.endsWith('/chat/stop')) {
      stops.push(body.conversation_id)
      // the SDK cancels the turn: its stream ends with "turn cancelled"
      const h = streams.find((s) => s.body.conversation_id === body.conversation_id && !s.closed)
      if (h) { h.push('message', { type: 'error', error: 'turn cancelled' }); h.end() }
      return new Response(JSON.stringify({ stopped: !!h }), { headers: { 'Content-Type': 'application/json' } })
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
  }
  // mcp-hub bindings (agent.js binds tools once per user): nothing bound in this test
  if (/\/servers$|\/bindings$/.test(u)) return new Response('[]', { headers: { 'Content-Type': 'application/json' } })
  return realFetch(url, opts)
}
const nth = async (n) => { while (streams.length < n) await new Promise((r) => wake.push(r)); return streams[n - 1] }
const until = async (fn, ms = 5000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return v; await new Promise((r) => setTimeout(r, 30)) } }

const { runTurn, stopTurns, STOPPED_TEXT, EMPTY_TEXT } = await import('../lib/agent.js')

const stamp = crypto.randomBytes(3).toString('hex')
const user = { id: crypto.randomUUID(), email: `pro-fix-a-turn-${stamp}@uengine.org`, name: '시험' }
const session = { access_token: 'test-token' }
const threads = []
async function thread(conv) {
  const [t] = await q(`insert into pro_threads(user_id,kind,title,conversation_id) values ($1,'project','시험',$2) returning id`, [user.id, conv])
  threads.push(t.id)
  return t.id
}
const msgs = (tid) => q('select id, role, kind, content from pro_messages where thread_id=$1 order by created_at', [tid])
const skillName = `fxa-quote-${stamp}`

// a generation folder in the deepagents workspace (lib/missions.js workspaceHostPath), removed at the end
const WS = path.join(PGPT_ROOT, 'services/deepagents/workspace', config.tenantId)
const rooms = []
after(async () => {
  for (const r of rooms) await fs.rm(path.join(WS, '.bpmn', r), { recursive: true, force: true })
  globalThis.fetch = realFetch
  if (up) {
    if (threads.length) await q('delete from pro_threads where id = any($1)', [threads])
    await q('delete from pro_skill_visibility where tenant_id=$1 and skill_name=$2', [config.tenantId, skillName])
  }
  await pool.end()
})

test('같은 대화에 보낸 두 번째 메시지는 대기했다가, 첫 답이 끝난 뒤 자기 답을 받음', { skip: !up }, async () => {
  const conv = `fxa-q-${stamp}`
  const tid = await thread(conv)
  const n0 = streams.length
  const p1 = runTurn({ user, session, threadId: tid, text: '첫 번째 보고서 문서 만들어 줘' })
  const h1 = await nth(n0 + 1)
  const p2 = runTurn({ user, session, threadId: tid, text: '두 번째 보고서 문서 만들어 줘' })
  // the second user message is marked 대기, and no second request reached deepagents
  const second = await until(async () => (await msgs(tid)).find((m) => m.role === 'user' && m.content.text.startsWith('두 번째') && m.content.queued))
  assert.ok(second, '두 번째 메시지에 대기 표시')
  assert.equal(streams.length, n0 + 1)
  h1.push('message', { type: 'token', content: '첫 답이에요.' }); h1.end()
  await p1
  const h2 = await nth(n0 + 2)
  assert.equal(h2.body.conversation_id, conv)
  h2.push('message', { type: 'token', content: '두 번째 답이에요.' }); h2.end()
  await p2
  const rows = await msgs(tid)
  const answers = rows.filter((m) => m.role === 'agent' && m.kind === 'text').map((m) => m.content.text)
  assert.deepEqual(answers, ['첫 답이에요.', '두 번째 답이에요.'])
  const u2 = rows.find((m) => m.id === second.id)
  assert.equal(u2.content.queued, undefined)
  assert.equal(u2.content.dequeued, true)
})

test('멈추기: deepagents /chat/stop 을 부르고, 답은 쓰던 데까지와 "답을 멈췄어요"', { skip: !up }, async () => {
  const conv = `fxa-s-${stamp}`
  const tid = await thread(conv)
  const n0 = streams.length
  const p = runTurn({ user, session, threadId: tid, text: '긴 보고서 문서 만들어 줘' })
  const h = await nth(n0 + 1)
  h.push('message', { type: 'token', content: '쓰던 중인 답' })
  h.push('message', { type: 'file_artifact', path: `/workspace/.bpmn/${conv}/build.js`, name: 'build.js', ext: 'js' })
  await new Promise((r) => setTimeout(r, 50))
  const r = await stopTurns({ user, session, threadId: tid })
  assert.equal(r.stopped, 1)
  assert.deepEqual(stops.slice(-1), [conv])
  const last = await p
  assert.equal(last.content.stopped, true)
  assert.match(last.content.text, /^쓰던 중인 답/)
  assert.ok(last.content.text.includes(STOPPED_TEXT))
  // a stopped turn leaves no half-run script as a result card
  assert.equal((await msgs(tid)).filter((m) => m.kind === 'file').length, 0)
  const [t] = await q('select status from pro_threads where id=$1', [tid])
  assert.equal(t.status, null)
})

test('다른 사람 문서는 카드가 안 되고, 이 대화 폴더의 문서만 원래 이름으로 붙음', { skip: !up }, async () => {
  const conv = `fxa-p-${stamp}`
  const tid = await thread(conv)
  const n0 = streams.length
  const p = runTurn({ user, session, threadId: tid, text: '첫 미팅 메모 한글 문서 만들어 줘' })
  const h = await nth(n0 + 1)
  const foreign = `/workspace/rt-foreign-${stamp}.hwpx`, own = `/workspace/.bpmn/${conv}/rt-own-${stamp}.hwpx`
  h.push('message', { type: 'tool_start', tool: 'execute', input: { command: 'ls /workspace' } })
  h.push('message', { type: 'tool_end', tool: 'execute', output: `${foreign}\n${own}` })
  // deepagents' end-of-turn republish of every hwpx path it saw (no tool name)
  h.push('message', { type: 'tool_end', output: { file_url: 'http://127.0.0.1:9/f1.hwpx', file_name: `edited-rt-foreign-${stamp}_20261027_101010.hwpx` } })
  h.push('message', { type: 'tool_end', output: { file_url: 'http://127.0.0.1:9/f2.hwpx', file_name: `edited-rt-own-${stamp}_20261027_101011.hwpx` } })
  h.push('message', { type: 'token', content: '메모를 만들었어요.' })
  h.end()
  await p
  const cards = (await msgs(tid)).filter((m) => m.kind === 'file').map((m) => m.content)
  assert.equal(cards.length, 1, JSON.stringify(cards))
  assert.equal(cards[0].url, 'http://127.0.0.1:9/f2.hwpx')
  assert.equal(cards[0].name, `rt-own-${stamp}.hwpx`)
  // the agent was told where its files go and what it must not read
  assert.match(h.body.message, new RegExp(`/workspace/\\.bpmn/${conv}/`))
  assert.match(h.body.message, new RegExp(`/workspace/uploads/${user.id}/`))
})

test('공유하지 않은 내 스킬을 파일과 함께 부르면, 스킬 위치와 첨부가 에이전트에게 감', { skip: !up }, async () => {
  await q(`insert into pro_skill_visibility(tenant_id,skill_name,visibility,author_id) values ($1,$2,'private',$3)`, [config.tenantId, skillName, user.id])
  const tid = await thread(`fxa-k-${stamp}`)
  const n0 = streams.length
  const file = { name: '견적서.xlsx', path: `/workspace/uploads/${user.id}/x/견적서.xlsx`, url: 'http://127.0.0.1:9/q.xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: 10 }
  const p = runTurn({ user, session, threadId: tid, text: `/${skillName} 이 견적서 점검해 줘`, files: [file] })
  const h = await nth(n0 + 1)
  assert.match(h.body.message, new RegExp(`내 스킬 '${skillName}'`))
  assert.match(h.body.message, new RegExp(`${skillName}/SKILL\\.md`))
  assert.ok(h.body.message.includes(file.path), '첨부 경로')
  assert.equal(h.body.files.length, 1)
  h.push('message', { type: 'token', content: '점검했어요. 홀 단가 하나가 비어 있어요.' }); h.end()
  const m = await p
  assert.match(m.content.text, /점검했어요/)
})

test('아무 내용 없이 끝난 답은 안내 문장으로', { skip: !up }, async () => {
  const tid = await thread(`fxa-e-${stamp}`)
  const n0 = streams.length
  const p = runTurn({ user, session, threadId: tid, text: '빈 보고서 문서 만들어 줘' })
  const h = await nth(n0 + 1)
  h.end()
  const m = await p
  assert.equal(m.content.text, EMPTY_TEXT)
})

// what deepagents sent before it read results only from the process folder: the first definition-shaped
// JSON in the stream — here the skill's schema sample the agent read
const LEAVE = { type: 'process-definition-result', processDefinition: { processDefinitionName: '휴가 신청 프로세스', processDefinitionId: 'leave_request_process', elements: [] }, forms: [], agents: [], skills: [] }
const MINE = {
  processDefinitionName: 'Moonlight Coffee proposal', processDefinitionId: 'moonlight_coffee_proposal', description: 'Design request mail to the reply', isHorizontal: true, data: [],
  roles: [{ name: 'Sales', endpoint: 'sales', resolutionRule: 'the requester', origin: 'created' }],
  elements: [
    { elementType: 'Event', id: 'start_event', name: 'Request received', role: 'Sales', type: 'StartEvent' },
    { elementType: 'Sequence', id: 'seq_1', source: 'start_event', target: 'receive_mail' },
    { elementType: 'Activity', id: 'receive_mail', name: 'Receive request mail', role: 'Sales', type: 'UserActivity', tool: 'formHandler:receive_mail', inputData: [], outputData: ['request'], checkpoints: [], duration: 1 },
    { elementType: 'Sequence', id: 'seq_2', source: 'receive_mail', target: 'end_event' },
    { elementType: 'Event', id: 'end_event', name: 'Reply sent', role: 'Sales', type: 'EndEvent' },
  ],
}

test('새 프로세스 초안 카드는 이번 턴이 폴더에 쓴 정의 — 먼저 읽은 스킬 예시도, 프로세스 폴더의 xlsx 스킬도 카드가 아님', { skip: !up }, async () => {
  const conv = `fxa-d-${stamp}`
  rooms.push(conv)
  const work = path.join(WS, '.bpmn', conv, 'process-fxa')
  await fs.mkdir(path.join(work, 'skills', 'xlsx'), { recursive: true })
  await fs.writeFile(path.join(work, 'process-definition.json'), JSON.stringify(MINE))
  await fs.writeFile(path.join(work, 'skills', 'xlsx', 'SKILL.md'), '---\nname: xlsx\ndescription: 엑셀\n---\n')
  const tid = await thread(conv)
  const n0 = streams.length
  // (a document request goes straight to the agent: no router model in this test)
  const p = runTurn({ user, session, threadId: tid, text: 'Write the definition document of the Moonlight Coffee proposal process' })
  const h = await nth(n0 + 1)
  const base = `/workspace/.bpmn/${conv}/process-fxa`
  h.push('message', { type: 'tool_start', tool: 'read_file', input: { file_path: '/skills/process-gpt-system/bpmn-process-generation-skill/assets/templates/process-definition.schema.json' } })
  h.push('message', { type: 'process_result', data: LEAVE })
  h.push('message', { type: 'file_artifact', op: 'create', path: `${base}/process-definition.json`, name: 'process-definition.json', ext: '.json', content: JSON.stringify(MINE) })
  // completion re-sends the folder, its skills included
  h.push('message', { type: 'file_artifact', op: 'edit', path: `${base}/skills/xlsx/SKILL.md`, name: 'SKILL.md', ext: '.md', content: '---\nname: xlsx\n---' })
  h.push('message', { type: 'token', content: 'I built the Moonlight Coffee proposal process.' })
  h.end()
  await p
  const rows = await msgs(tid)
  assert.equal(rows.filter((m) => m.kind === 'skill_draft').length, 0, 'no xlsx skill draft card')
  const drafts = rows.filter((m) => m.kind === 'process_draft')
  assert.equal(drafts.length, 1)
  assert.equal(drafts[0].content.contract.processDefinition.processDefinitionName, 'Moonlight Coffee proposal')
  assert.equal(drafts[0].content.workDir, `/.bpmn/${conv}/process-fxa/`)
  const acts = drafts[0].content.contract.processDefinition.activities || drafts[0].content.contract.processDefinition.elements.filter((e) => e.elementType === 'Activity')
  assert.deepEqual(acts.map((a) => a.name), ['Receive request mail'])
})

// the skill test step inside a process generation (deepagents plan_skill_eval) draws its test floor plans under
// <room>/.skill-evals/…/outputs/, and the answer lists them: four .dxf cards came above the draft card
test('스킬 시험 단계(.skill-evals)의 산출물은 답에 경로가 적혀 있어도 파일 카드가 아님 — 초안 카드만', { skip: !up }, async () => {
  const conv = `fxa-v-${stamp}`
  rooms.push(conv)
  const work = path.join(WS, '.bpmn', conv, 'process-fxv')
  await fs.mkdir(work, { recursive: true })
  await fs.writeFile(path.join(work, 'process-definition.json'), JSON.stringify(MINE))
  const evals = ['basic-store-floor-plan/with_skill/outputs/floor-plan.dxf', 'basic-store-floor-plan/without_skill/outputs/moonlight_coffee_floor_plan.dxf',
    'revised-floor-plan-with-notes/with_skill/outputs/Moonlight Coffee revised floor plan.dxf', 'revised-floor-plan-with-notes/without_skill/outputs/floor-plan.dxf']
  for (const e of evals) {
    const f = path.join(WS, '.bpmn', conv, '.skill-evals', 'floor-plan-cad', 'iteration-1', e)
    await fs.mkdir(path.dirname(f), { recursive: true })
    await fs.writeFile(f, '0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n')
  }
  const tid = await thread(conv)
  const n0 = streams.length
  const p = runTurn({ user, session, threadId: tid, text: 'Write the definition document of the Moonlight Coffee proposal process' })
  const h = await nth(n0 + 1)
  const room = `/workspace/.bpmn/${conv}`
  h.push('message', { type: 'file_artifact', op: 'create', path: `${room}/process-fxv/process-definition.json`, name: 'process-definition.json', ext: '.json', content: JSON.stringify(MINE) })
  h.push('message', { type: 'token', content: `The eval gate is done. Test outputs:\n${evals.map((e) => `- \`${room}/.skill-evals/floor-plan-cad/iteration-1/${e}\``).join('\n')}\n\nThe process is ready — press Save.` })
  h.end()
  await p
  const rows = await msgs(tid)
  assert.deepEqual(rows.filter((m) => m.kind === 'file').map((m) => m.content.path), [], 'no file card for a test run')
  assert.equal(rows.filter((m) => m.kind === 'process_draft').length, 1)
})

test('정의를 쓰지 않은 턴(초안 제안)에는 새 프로세스 초안 카드가 없음', { skip: !up }, async () => {
  const conv = `fxa-c-${stamp}`
  const tid = await thread(conv)
  const n0 = streams.length
  const p = runTurn({ user, session, threadId: tid, text: 'Write a draft document of the Moonlight Coffee proposal process' })
  const h = await nth(n0 + 1)
  h.push('message', { type: 'process_result', data: LEAVE })
  h.push('message', { type: 'token', content: 'Here is the draft of the flow. Shall I proceed?' })
  h.end()
  await p
  const rows = await msgs(tid)
  assert.equal(rows.filter((m) => m.kind === 'process_draft').length, 0)
  assert.match(rows.filter((m) => m.role === 'agent').at(-1).content.text, /Shall I proceed/)
})
