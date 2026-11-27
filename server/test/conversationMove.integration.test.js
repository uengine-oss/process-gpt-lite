// 대화를 통째로 프로젝트로 옮기기 — 실제 DB(로컬 Supabase) · 실제 Express 라우트(로그인만 헤더 대역) · 실제 공유 폴더 권한, 모델은 가짜 fetch
// (카드 JSON · 첫 글자 확률). 스펙 openspec/specs/thread-to-project, 서버 lib/conversationMove.js · routes/conversationMove.js.
// 2026-11-28 사용자: 「필터링된 채팅방 자체를 프로젝트로 이관하는 기능. 이관 후엔 이 채팅 내용은 프로젝트에서만 볼 수 있음. 기존 채팅 목록에서는
// 제거됩니다... 라는 알림도 줘야」. 사람 · 회사 · 메일은 지어낸 것이다(정하윤 · 김서연 · 박도윤, 가나정밀).
//   TM-I-01 고르기: 대화의 메시지 수(화면과 같은 규칙) · 내 프로젝트(쓸 수 없는 프로젝트는 까닭) · 공유 폴더 구성원
//   TM-I-02 옮기기: 메시지 · 산출물 · 첨부가 프로젝트로(복사 없이 한 곳), 채팅 · 전체 대화 · 대화 목록 · 검색의 채팅 쪽에서 빠짐, 프로젝트의 주제로 보임,
//           프로젝트 자기 메시지는 끌려가지 않음, 채팅이 서 있던 대화는 비움, 옮긴 뒤 「따로 묶여」 오는 줄은 프로젝트로, 링크(place)는 프로젝트를 가리킴,
//           프로젝트에서 이어 물으면 그 주제(isTopic)
//   TM-I-03 권한: 남의 대화 404 · 남의 프로젝트 404 · 읽기 전용 프로젝트(폴더 보기 권한) 403 · 구성원이 있는 프로젝트는 확인 없이 409 → 확인하면 옮김
//   TM-I-04 경쟁: 두 번 누르기(같은 프로젝트 → 하나만, 두 번째는 already) · 두 화면이 다른 프로젝트로 동시에(하나만, 다른 쪽 409 moved, 메시지 중복 없음)
//   TM-I-05 막는 것: 예약 작업 대화 409 standing · 답을 쓰는 중 409 busy
//   TM-I-06 되돌리기: 남은 404 · 옮긴 사람만 · 프로젝트에서 이어 나눈 메시지도 함께 채팅으로(따로 묶여서 다른 대화를 끌고 가지 않음) · 칩은 지움 · 주제에서 빠짐
//   TM-I-07 새 프로젝트로: 「프로젝트로 시작」 카드(대화 전체, 첫 문서 없음) → 「만들기」가 프로젝트를 만들고 대화를 옮김
//   TM-I-08 말로: 라우터의 move_to_project → 그 대화의 카드(말한 프로젝트는 판정 모델이 고른 것만 권함) → 옮기면 카드가 「옮겼어요」 · 「아니요」
//   TM-I-09 라우트: GET · POST /conversations/:cid/move · …/undo · …/place(남의 것 404)
//   TM-I-10 옮긴 대화에서 이어 물으면: 실제 턴(lib/agent.js runTurn) — 그 주제의 deepagents 대화(같은 id, 이어지는 기록)로, 프로젝트 계획과 함께, 답은 그 주제에
//   (PR #125 검토 — 검토자의 시험 probe.test.mjs 를 진짜 시험으로)
//   TM-I-11 대화를 아직 모르는 턴(라우터가 답하기 전 · 줄 서 있는 턴)이 있으면 옮기기 · 되돌리기 409 busy · 옮긴 대화의 늦은 답은 채팅 행을 다시 만들지 않음
//   TM-I-12 채팅 열쇠의 행이 다시 생긴 대화도 되돌리기가 막히지 않음(행을 합쳐 큰 턴 수 · 늦은 시각을 지킴)
//   TM-I-13 브라우저 작업이 진행 중인 대화는 옮기기 · 되돌리기 409 busy_task
//   TM-I-14 「채팅에서 옮겨 온 대화예요」 칩은 옮기는 문장 안에서 생김 · 칩이 없어도 옮긴 메시지의 표시로 되돌리기
//   TM-I-15 따로 묶여 프로젝트로 간 줄이 프로젝트의 다른 줄을 그 주제로 끌고 가지 않음 · 되돌리기는 계획 바뀜 칩을 가져가지 않음
//   TM-I-16 빠진 폴더의 구성원 이름은 보이지 않음
//   TM-I-17 열린 「새 프로젝트로」 카드는 다른 길로 옮기면 닫히고, 「만들고 옮기기」는 빈 프로젝트를 만들지 않음
//   TM-I-18 말로: 걸러 본 화면에서 한 말 뒤에 전체 채팅에서 한 말은 지금 대화의 카드(남아 있던 고정 대화가 아니라)
// Run: node --test --test-concurrency=1 test/conversationMove.integration.test.js  (needs the local Supabase)
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'pgl-conv-move-'))
const TENANT = `conv-move-test-${crypto.randomBytes(3).toString('hex')}`
delete process.env.PRO_TENANT_FROM_HEADER
process.env.PRO_BACKGROUND = '0'
process.env.PRO_TENANT_ID = TENANT
process.env.PRO_TENANT_HOSTS = ''
process.env.PRO_FOLDERS_ROOT = path.join(ROOT, 'folders')
process.env.PRO_ONTOLOGY_BOLT_URL = ''
process.env.PRO_CONTEXT_ROUTER_URL = ''
process.env.PRO_MEMENTO_URL = 'http://127.0.0.1:9'
process.env.PRO_JUDGE_URL = ''
process.env.PRO_DEEPAGENTS_URL = 'https://deepagents.fake.example'
process.env.PRO_LLM_BASE_URL = 'https://llm.fake.example/v1'
process.env.PRO_LLM_API_KEY = 'test'
process.env.PRO_LLM_KEYS = 'off'
process.env.PRO_LLM_MODEL = 'fake'
process.env.PRO_LLM_FAST_MODEL = 'fake'
process.env.PRO_PROJECT_OFFERS_PER_MIN = '200'

const { config } = await import('../config.js')
const { q, pool } = await import('../lib/supa.js')
const CV = await import('../lib/conversations.js')
const CM = await import('../lib/conversationMove.js')
const CP = await import('../lib/chatProject.js')
const PT = await import('../lib/projectTopics.js')
const turns = await import('../lib/turns.js')
const { addMessage, mainThread } = await import('../lib/store.js')
const { searchMessages } = await import('../lib/search.js')
const PAGE = await import('../../src/convOf.js')

// ---------- the fake model: the card's JSON; the judge picks the option whose label holds `pick` ----------
const llm = { pick: null, p: 0.86, judged: [] }
const real = globalThis.fetch
globalThis.fetch = async (url, init = {}) => {
  const u = String(url)
  if (u.startsWith(config.llm.baseUrl)) {
    const b = JSON.parse(init.body || '{}')
    const text = (b.messages || []).map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n')
    if (b.logprobs) {
      llm.judged.push(text)
      const options = [...text.matchAll(/^([A-Z])\) (.+)$/gm)].map((m) => ({ letter: m[1], label: m[2] }))
      const hit = (llm.pick && options.find((o) => o.label.includes(llm.pick))) || options.at(-1)
      const other = options.find((o) => o.letter !== hit.letter) || { letter: 'Z' }
      return Response.json({ choices: [{ message: { content: hit.letter }, logprobs: { content: [{ token: hit.letter, top_logprobs: [{ token: hit.letter, logprob: Math.log(llm.p) }, { token: other.letter, logprob: Math.log(1 - llm.p) }] }] } }] })
    }
    const sys = String(b.messages?.[0]?.content || '')
    if (sys.startsWith('너는 채팅에서 하던 이야기를')) {
      return Response.json({ choices: [{ message: { content: JSON.stringify({ title: '가나정밀 회의록 정리', intent: '주간 회의록을 정리한다', background: '채팅에서 정리하던 회의록', deliverables: ['회의록'] }) }, finish_reason: 'stop' }] })
    }
    // the chat's router: 「… 프로젝트로 옮겨 줘」 → move_to_project (TM-I-18)
    const last = String(b.messages?.at(-1)?.content || '')
    if (b.tools && last.includes('프로젝트로 옮겨')) {
      return Response.json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'm1', type: 'function', function: { name: 'move_to_project', arguments: JSON.stringify({ ack: '아래 카드에서 프로젝트를 확인하면 옮길게요.' }) } }] }, finish_reason: 'tool_calls' }] })
    }
    return Response.json({ choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] })
  }
  // a scripted deepagents: every turn answers at once; what it was sent is kept (TM-I-10)
  if (u.startsWith(config.deepagentsUrl)) {
    const body = init.body ? JSON.parse(init.body) : {}
    if (u.endsWith('/chat/stream')) {
      agentCalls.push(body)
      const enc = new TextEncoder()
      const ev = (e, d) => enc.encode(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`)
      const rs = new ReadableStream({ start(c) { if (body.conversation_id) c.enqueue(ev('metadata', { conversation_id: body.conversation_id })); c.enqueue(ev('message', { type: 'token', content: '숙소 후보를 정리했어요.' })); c.close() } })
      return new Response(rs, { headers: { 'Content-Type': 'text/event-stream' } })
    }
    return Response.json(u.endsWith('/chat/stop') ? { stopped: false } : [])
  }
  if (/\/servers$|\/bindings$|\/skills\?/.test(u)) return Response.json([])
  return real(url, init)
}
const agentCalls = []

// ---------- people, chats, projects, the routes ----------
const users = [], closers = []
after(async () => {
  for (const c of closers) c()
  for (const u of users) {
    await q('delete from pro_messages where thread_id in (select id from pro_threads where user_id=$1)', [u.id]).catch(() => {})
    await q('delete from pro_thread_folders where thread_id in (select id from pro_threads where user_id=$1)', [u.id]).catch(() => {})
    await q('delete from pro_threads where user_id=$1', [u.id]).catch(() => {})
    await q(`delete from context_threads where tenant_id=$1`, [TENANT]).catch(() => {})
    await q('delete from pro_team_members where user_id=$1', [u.id]).catch(() => {})
    await q('delete from pro_profile where user_id=$1', [u.id]).catch(() => {})
    await q('delete from users where id=$1', [u.id]).catch(() => {})
  }
  await q('delete from pro_folder_members where folder_id in (select id from pro_folders where tenant_id=$1)', [TENANT]).catch(() => {})
  await q('delete from pro_folder_variations where folder_id in (select id from pro_folders where tenant_id=$1)', [TENANT]).catch(() => {})
  await q('delete from pro_folders where tenant_id=$1', [TENANT]).catch(() => {})
  await q('delete from tenants where id=$1', [TENANT]).catch(() => {})
  await pool.end()
  await fs.rm(ROOT, { recursive: true, force: true })
  globalThis.fetch = real
})

async function person(name) {
  const id = crypto.randomUUID()
  const u = { id, email: `tm-${id.slice(0, 8)}@lite.example`, name }
  users.push(u)
  await q(`insert into users (id, email, username, tenant_id) values ($1,$2,$3,$4)`, [id, u.email, `pgpt-${id.slice(0, 6)}`, TENANT])
  await q(`insert into pro_profile(user_id,name,email) values ($1,$2,$3) on conflict (user_id) do nothing`, [id, name, u.email])
  await q(`insert into pro_team_members(tenant_id,user_id,added_by) values ($1,$2,$2) on conflict do nothing`, [TENANT, id])
  return u
}
let base = null
async function call(u, method, p, body) {
  if (!base) {
    const express = (await import('express')).default
    const { conversationMoveRoutes } = await import('../routes/conversationMove.js')
    const app = express()
    app.use(express.json())
    const auth = (req, res, next) => {
      const me = users.find((x) => x.id === req.headers['x-test-user'])
      if (!me) return res.status(401).json({ error: 'unauthorized' })
      req.user = { id: me.id, email: me.email, name: me.name }; req.session = { access_token: 'test' }; next()
    }
    app.use('/api', conversationMoveRoutes(auth))
    const s = await new Promise((ok) => { const x = app.listen(0, '127.0.0.1', () => ok(x)) })
    closers.push(() => s.close())
    base = `http://127.0.0.1:${s.address().port}/api`
  }
  const r = await real(`${base}${p}`, { method, headers: { 'x-test-user': u.id, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
  const text = await r.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* not json */ }
  return { status: r.status, body: json, text }
}
const msgs = (tid) => q('select id, role, kind, content, created_at from pro_messages where thread_id=$1 order by created_at', [tid])
const rowOf = async (key, conv) => (await q('select * from context_threads where tenant_id=$1 and user_id=$2 and conversation_id=$3', [TENANT, String(key), conv]))[0] || null
const T0 = Date.now() - 3600_000
const ts = (s) => new Date(T0 + s * 1000).toISOString()
const rid = (p) => `${p}-${crypto.randomBytes(4).toString('hex')}`

// 정하윤's chat: five conversations of the router (A · B · C · E · F), interleaved, each with its row; a scheduled task's (S); a project's own
// line between A's in time; 김서연's chat with a conversation of her own
let cast = null
async function setup() {
  if (cast) return cast
  const { ensureTenantRow } = await import('../lib/tenant.js')
  await ensureTenantRow(TENANT).catch(() => {})
  const me = await person('정하윤'), sy = await person('김서연'), dy = await person('박도윤')
  const chat = await mainThread(me.id)
  const conv = { A: rid('conv-a'), B: rid('conv-b'), C: rid('conv-c'), E: rid('conv-e'), F: rid('conv-f'), S: rid('sched') }
  const titles = { A: '가나정밀 교육 요청 조사', B: '주간 회의록 정리', C: '견적 비교', E: '출장 일정 정리', F: '회의록 요약 모음' }
  const ins = async (tid, role, kind, content, s) => (await q(`insert into pro_messages(thread_id,role,kind,content,created_at) values ($1,$2,$3,$4,$5) returning *`, [tid, role, kind, content, ts(s)]))[0]
  const ctx = (k, action = 'continue') => ({ conversationId: conv[k], action, title: titles[k] })
  const m = {}
  m.a1 = await ins(chat.id, 'user', 'text', { text: '받은 메일의 교육 요청을 조사해 줘', files: [{ name: '요청서.pdf', url: 'http://127.0.0.1:9/x/요청서.pdf' }] }, 10)
  m.a2 = await ins(chat.id, 'agent', 'doc', { text: '# 데이터 분석 실무 교육안\n\n3일 과정으로 정리했어요. 1일차 스프레드시트, 2일차 대시보드 실습, 3일차 발표.', context: ctx('A', 'new') }, 11)
  m.a3 = await ins(chat.id, 'agent', 'file', { name: '교육안.md', url: 'http://127.0.0.1:9/x/교육안.md' }, 12)
  m.b1 = await ins(chat.id, 'user', 'text', { text: '이번 주 회의록 정리해 줘' }, 20)
  m.b2 = await ins(chat.id, 'agent', 'text', { text: '회의록을 정리했어요. 결정 3건, 할 일 5건이에요. 다음 회의는 목요일이에요.', context: ctx('B', 'new') }, 21)
  m.s1 = await ins(chat.id, 'agent', 'text', { text: '주간 시장 동향 예약 실행 결과예요.', context: { conversationId: conv.S, action: 'aside', kind: 'schedule', title: '주간 시장 동향' } }, 25)
  m.a4 = await ins(chat.id, 'user', 'text', { text: '교육안 2일차를 더 자세히' }, 30)
  m.a5 = await ins(chat.id, 'agent', 'text', { text: '2일차 실습을 세 단계로 나눴어요. 데이터 불러오기, 차트 만들기, 대시보드 묶기예요.', context: ctx('A') }, 31)
  m.c1 = await ins(chat.id, 'user', 'text', { text: '견적 세 곳 비교해 줘' }, 40)
  m.c2 = await ins(chat.id, 'agent', 'text', { text: '세 곳의 견적을 표로 비교했어요. 가나정밀이 가장 낮아요.', context: ctx('C', 'new') }, 41)
  m.e1 = await ins(chat.id, 'user', 'text', { text: '다음 주 출장 일정 정리' }, 50)
  m.e2 = await ins(chat.id, 'agent', 'text', { text: '출장 일정을 정리했어요. 화요일 출발, 목요일 귀환이에요.', context: ctx('E', 'new') }, 51)
  m.f1 = await ins(chat.id, 'user', 'text', { text: '지난 회의록들 요약 모아 줘' }, 60)
  m.f2 = await ins(chat.id, 'agent', 'doc', { text: '# 회의록 요약 모음\n\n세 번의 회의에서 정한 것을 모았어요.', context: ctx('F', 'new') }, 61)
  // the chat stands in F (its latest conversation)
  await q('update pro_threads set conversation_id=$2 where id=$1', [chat.id, conv.F])
  for (const k of ['A', 'B', 'C', 'E', 'F']) {
    await q(`insert into context_threads(tenant_id,user_id,conversation_id,title,summary,gist,kind,turns,updated_at) values ($1,$2,$3,$4,$5,'','conversation',2,now())`,
      [TENANT, me.id, conv[k], titles[k], `최근 요청: ${titles[k]}\n최근 답: …`])
  }
  await q(`insert into context_threads(tenant_id,user_id,conversation_id,title,summary,gist,kind,turns,updated_at) values ($1,$2,$3,'주간 시장 동향','','','schedule',3,now())`, [TENANT, me.id, conv.S])
  // projects: P1 (no folder), P2 (works in 「영업 자료」 — 김서연 is a member too), P3 (works in 「규정집」, where 정하윤 now only views), P4 (no folder)
  const proj = async (who, title) => (await q(`insert into pro_threads(user_id,kind,title) values ($1,'project',$2) returning *`, [who.id, title]))[0]
  const P1 = await proj(me, '가나정밀 1차 교육'), P2 = await proj(me, '영업 자료 정리'), P3 = await proj(me, '규정 검토'), P4 = await proj(me, '견적 모음')
  // P1's own line, between A's lines in time (a project's line from before sub-topics: no sub-topic)
  m.p1 = await ins(P1.id, 'agent', 'text', { text: '프로젝트 계획을 채웠어요' }, 15)
  const S = await import('../lib/folders/service.js')
  const TF = await import('../lib/folders/threadFolders.js')
  const sales = await S.createFolder(me, { name: '영업 자료' })
  await S.setMember(await S.folderById(sales.id), me, { id: sy.id, role: 'editor' })
  await TF.linkProject(me, P2, await S.folderById(sales.id))
  const rules = await S.createFolder(dy, { name: '규정집' })
  await S.setMember(await S.folderById(rules.id), dy, { id: me.id, role: 'viewer' })
  await TF.linkProject(me, P3, await S.folderById(rules.id))
  // 김서연's own chat, conversation and project
  const syChat = await mainThread(sy.id)
  const syConv = rid('conv-sy')
  await ins(syChat.id, 'user', 'text', { text: '김서연의 질문' }, 5)
  await ins(syChat.id, 'agent', 'text', { text: '김서연의 답이에요.', context: { conversationId: syConv, action: 'new', title: '김서연의 대화' } }, 6)
  await q(`insert into context_threads(tenant_id,user_id,conversation_id,title,summary,gist,kind,turns,updated_at) values ($1,$2,$3,'김서연의 대화','','','conversation',1,now())`, [TENANT, sy.id, syConv])
  const SYP = await proj(sy, '김서연의 프로젝트')
  cast = { me, sy, dy, chat, conv, titles, m, P1, P2, P3, P4, sales, rules, syChat, syConv, SYP }
  return cast
}
// what the chat's screen files under each conversation (src/convOf.js) — as the page would see the chat now
const pageConvs = async (chatId) => { const list = await msgs(chatId); return { list, of: PAGE.convOf(list) } }

test('TM-I-01 고르기: 대화의 메시지 수(화면과 같은 규칙) · 내 프로젝트 · 쓸 수 없는 프로젝트의 까닭 · 공유 폴더 구성원', async () => {
  const { me, chat, conv, P1, P2, P3, P4 } = await setup()
  const { list, of } = await pageConvs(chat.id)
  const r = await CM.targets(me, conv.A)
  assert.equal(r.conversation.count, list.filter((x) => of[x.id] === conv.A).length)
  assert.equal(r.conversation.count, 5, '요청(첨부) · 문서 답 · 파일 · 이어 물은 말 · 그 답')
  assert.equal(r.conversation.title, '가나정밀 교육 요청 조사')
  assert.equal(r.conversation.movable, true)
  const by = Object.fromEntries(r.projects.map((p) => [p.id, p]))
  for (const p of [P1, P2, P3, P4]) assert.ok(by[p.id], p.title)
  assert.equal(by[P1.id].writable, true)
  assert.deepEqual(by[P1.id].members, [])
  assert.equal(by[P2.id].writable, true)
  assert.deepEqual(by[P2.id].members.map((x) => x.name), ['김서연'])
  assert.equal(by[P2.id].folder.name, '영업 자료')
  assert.equal(by[P3.id].writable, false)
  assert.match(by[P3.id].why, /「규정집」에 쓸 권한이 없어요/)
  // the scheduled task's conversation says why it cannot move
  const s = await CM.targets(me, conv.S)
  assert.equal(s.conversation.movable, false)
  assert.equal(s.conversation.code, 'standing')
})

test('TM-I-02 옮기기: 한 곳에만 — 채팅 · 대화 목록 · 검색의 채팅 쪽에서 빠지고 프로젝트의 주제로 보임, 링크는 프로젝트로', async () => {
  const { me, chat, conv, m, P1 } = await setup()
  const before = await pageConvs(chat.id)
  const aIds = before.list.filter((x) => before.of[x.id] === conv.A).map((x) => x.id)
  const bIds = before.list.filter((x) => before.of[x.id] === conv.B).map((x) => x.id)
  const r = await CM.move(me, conv.A, { project: P1.id })
  assert.equal(r.moved, 5)
  assert.equal(r.project.id, P1.id)
  assert.equal(r.topic, conv.A)
  // the chat: none of A's lines, the others filed as before
  const after1 = await pageConvs(chat.id)
  assert.ok(!after1.list.some((x) => aIds.includes(x.id)), '채팅에서 사라짐')
  assert.deepEqual(after1.list.filter((x) => after1.of[x.id] === conv.B).map((x) => x.id), bIds)
  assert.ok(!Object.values(after1.of).includes(conv.A))
  // the chat's 대화 list (GET /api/conversations reads the person's rows) and the router's candidates for the chat: no A
  assert.equal(await rowOf(me.id, conv.A), null)
  assert.ok(await rowOf(PT.scopeKey(me.id, P1.id), conv.A), '프로젝트의 주제 행')
  // the project: A's lines (the same rows — moved, not copied), its sub-topic, the chip; P1's own line not taken along
  const room = await msgs(P1.id)
  for (const id of aIds) assert.ok(room.some((x) => x.id === id), `프로젝트에 ${id}`)
  const total = (await q('select count(*)::int as n from pro_messages where id = any($1::uuid[])', [aIds]))[0].n
  assert.equal(total, aIds.length, '복사본 없음')
  const of = CV.topicOf(room)
  for (const id of aIds) assert.equal(of[id], conv.A)
  assert.equal(of[m.p1.id], null, '프로젝트 자기 줄은 그대로')
  const note = room.find((x) => x.content?.moved?.note)
  assert.equal(note.content.text, '채팅에서 옮겨 온 대화예요 · 메시지 5개')
  assert.equal(note.content.moved.by, me.id)
  assert.equal(of[note.id], conv.A)
  // the attachment (on the person's message) and the file card went with it
  assert.equal(room.find((x) => x.id === m.a1.id).content.files[0].name, '요청서.pdf')
  assert.equal(room.find((x) => x.id === m.a3.id).content.name, '교육안.md')
  const topics = await PT.topicsOf(me.id, P1.id)
  assert.ok(topics.some((t) => t.id === conv.A && t.title === '가나정밀 교육 요청 조사'))
  // asked there afterwards: the project's sub-topic (its plan and folder — lib/agent.js delegate takes a pin that is the project's topic)
  assert.equal(await PT.isTopic(me.id, P1, conv.A), true)
  // the search: found in the project, under its sub-topic — not in the chat
  const found = await searchMessages(me.id, '2일차 실습을 세 단계')
  assert.equal(found.length, 1)
  assert.equal(found[0].kind, 'project')
  assert.equal(found[0].thread_id, P1.id)
  assert.equal(found[0].conv, conv.A)
  // a link to /chat/c/A: the page asks where it went
  assert.deepEqual(await CM.placeOf(me, conv.A), { project: { id: P1.id, title: '가나정밀 1차 교육' }, topic: conv.A })
  // a line filed aside into A later (a mail's line): it goes to the project, under A
  const late = await addMessage(me.id, chat.id, 'agent', 'text', { text: '답장을 보냈어요.', context: { conversationId: conv.A, action: 'aside' } })
  assert.equal(late.thread_id, P1.id)
  assert.equal(late.content.conv, conv.A)
  // the other conversations of the chat are not touched by it
  const other = await addMessage(me.id, chat.id, 'agent', 'text', { text: '회의록 메일을 보냈어요.', context: { conversationId: conv.B, action: 'aside' } })
  assert.equal(other.thread_id, chat.id)
})

test('TM-I-02b 채팅이 서 있던 대화를 옮기면 채팅은 그 대화에서 내려온다', async () => {
  const { me, chat, conv, P4 } = await setup()
  assert.equal((await q('select conversation_id from pro_threads where id=$1', [chat.id]))[0].conversation_id, conv.F)
  const r = await CM.move(me, conv.F, { project: P4.id })
  assert.equal(r.moved, 2)
  assert.equal((await q('select conversation_id from pro_threads where id=$1', [chat.id]))[0].conversation_id, null)
})

test('TM-I-03 권한: 남의 대화 · 남의 프로젝트 404 · 읽기 전용 프로젝트 403 · 구성원이 있으면 한 번 더 확인', async () => {
  const { me, sy, conv, P2, P3, syConv, SYP, chat } = await setup()
  // 김서연 moving 정하윤's conversation, into her own project: not hers
  await assert.rejects(CM.move(sy, conv.B, { project: SYP.id }), (e) => e.status === 404)
  // 정하윤 moving into 김서연's project: not hers
  await assert.rejects(CM.move(me, conv.B, { project: SYP.id }), (e) => e.status === 404)
  // 정하윤 moving 김서연's conversation: not in her chat
  await assert.rejects(CM.move(me, syConv, { project: P2.id }), (e) => e.status === 404)
  // a project whose folder she only views
  await assert.rejects(CM.move(me, conv.B, { project: P3.id }), (e) => e.status === 403 && e.code === 'readonly' && /「규정집」/.test(e.message))
  // the project works in a shared folder 김서연 is in: not without saying so
  await assert.rejects(CM.move(me, conv.B, { project: P2.id }), (e) => e.status === 409 && e.code === 'confirm_members' && e.members.map((x) => x.name).join() === '김서연')
  // nothing moved by any of these
  assert.ok(await rowOf(me.id, conv.B))
  assert.equal((await msgs(P2.id)).length, 0)
  // confirmed: it moves
  const r = await CM.move(me, conv.B, { project: P2.id, membersOk: true })
  assert.equal(r.moved, 3, '두 줄과 TM-I-02 에서 따로 묶여 온 메일 줄')
  assert.ok(!(await msgs(chat.id)).some((x) => x.content?.context?.conversationId === conv.B))
})

test('TM-I-04 경쟁: 두 번 누르기 · 두 화면이 다른 프로젝트로 — 한 문장의 조건부 갱신이 하나만 통과', async () => {
  const { me, chat, conv, P1, P4 } = await setup()
  // two screens, two projects, at once
  const ids = (await pageConvs(chat.id)).list.filter((x) => x.content?.context?.conversationId === conv.C || x.content?.text === '견적 세 곳 비교해 줘').map((x) => x.id)
  const res = await Promise.allSettled([CM.move(me, conv.C, { project: P1.id }), CM.move(me, conv.C, { project: P4.id })])
  const ok = res.filter((x) => x.status === 'fulfilled' && !x.value.already)
  assert.equal(ok.length, 1, JSON.stringify(res.map((x) => x.status === 'fulfilled' ? x.value : { code: x.reason.code, status: x.reason.status })))
  const lost = res.find((x) => x !== ok[0])
  if (lost.status === 'rejected') assert.equal(lost.reason.code, 'moved')
  const won = ok[0].value.project.id
  const where = await q('select thread_id, count(*)::int as n from pro_messages where id = any($1::uuid[]) group by thread_id', [ids])
  assert.deepEqual(where, [{ thread_id: won, n: ids.length }], '메시지는 한 프로젝트에만, 중복 없이')
  // the row: one, under the project that won
  assert.equal((await q('select count(*)::int as n from context_threads where tenant_id=$1 and conversation_id=$2', [TENANT, conv.C]))[0].n, 1)
  // pressed again for the same project: the same answer, nothing more
  const again = await CM.move(me, conv.C, { project: won })
  assert.equal(again.already, true)
  assert.equal((await msgs(won)).filter((x) => x.content?.moved?.note && x.content.moved.conv === conv.C).length, 1, '칩 하나')
  // and to the other one: where it went
  await assert.rejects(CM.move(me, conv.C, { project: won === P1.id ? P4.id : P1.id }), (e) => e.status === 409 && e.code === 'moved' && e.place.project.id === won)
})

test('TM-I-05 막는 것: 예약 작업 대화 · 답을 쓰는 중', async () => {
  const { me, chat, conv, P1 } = await setup()
  await assert.rejects(CM.move(me, conv.S, { project: P1.id }), (e) => e.status === 409 && e.code === 'standing')
  // an answer being written in E
  const t = turns.enqueue({ userId: me.id, threadId: chat.id, conv: conv.E })
  t.started = true
  try {
    await assert.rejects(CM.move(me, conv.E, { project: P1.id }), (e) => e.status === 409 && e.code === 'busy')
  } finally { t.finish() }
  assert.ok(await rowOf(me.id, conv.E), '그대로')
})

test('TM-I-06 되돌리기: 옮긴 사람만, 프로젝트에서 이어 나눈 이야기도 함께, 칩은 지움', async () => {
  const { me, sy, chat, conv, P1 } = await setup()
  const r = await CM.move(me, conv.E, { project: P1.id })
  assert.equal(r.moved, 2)
  // asked in the project's sub-topic afterwards: a question, its answer, a card after it
  const t1 = await addMessage(me.id, P1.id, 'user', 'text', { text: '출장 숙소도 찾아 줘', conv: conv.E })
  const t2 = await addMessage(me.id, P1.id, 'agent', 'text', { text: '숙소 세 곳을 찾았어요.', conv: conv.E })
  const t3 = await addMessage(me.id, P1.id, 'agent', 'file', { name: '숙소.md' })
  // someone else: not theirs to take back
  await assert.rejects(CM.undo(sy, conv.E, { project: P1.id }), (e) => e.status === 404)
  // a sub-topic the project started itself was never in the chat
  const own = rid('conv-own')
  await q(`insert into context_threads(tenant_id,user_id,conversation_id,title,summary,gist,kind,turns,updated_at) values ($1,$2,$3,'프로젝트의 주제','','','conversation',1,now())`, [TENANT, PT.scopeKey(me.id, P1.id), own])
  await addMessage(me.id, P1.id, 'agent', 'text', { text: '프로젝트에서 시작한 주제', conv: own })
  await assert.rejects(CM.undo(me, own, { project: P1.id }), (e) => e.status === 409 && e.code === 'not_moved')
  // the mover: back to the chat, all of it
  const b = await CM.undo(me, conv.E, { project: P1.id })
  assert.equal(b.back, 5)
  const { list, of } = await pageConvs(chat.id)
  for (const id of [t1.id, t2.id, t3.id]) assert.equal(of[id], conv.E, `채팅의 E 에 ${id}`)
  assert.equal(list.filter((x) => of[x.id] === conv.E).length, 5)
  // filed aside: the chat's other conversations keep their lines
  assert.ok(list.filter((x) => of[x.id] === conv.E).every((x) => x.content.context?.action === 'aside' && x.content.context.conversationId === conv.E && !x.content.moved && x.content.conv === undefined))
  assert.ok(await rowOf(me.id, conv.E))
  assert.equal(await rowOf(PT.scopeKey(me.id, P1.id), conv.E), null)
  const room = await msgs(P1.id)
  assert.ok(!room.some((x) => x.content?.moved?.conv === conv.E), '칩 지움')
  assert.ok(!(await PT.topicsOf(me.id, P1.id)).some((t) => t.id === conv.E))
  assert.equal(await CM.placeOf(me, conv.E), null)
  // and it can move again
  const again = await CM.move(me, conv.E, { project: P1.id })
  assert.equal(again.moved, 5)
})

test('TM-I-07 새 프로젝트로: 대화 전체로 쓴 「프로젝트로 시작」 카드 → 「만들기」가 프로젝트를 만들고 대화를 옮김', async () => {
  const { me, chat } = await setup()
  // a conversation of its own for this test
  const G = rid('conv-g')
  const mk = async (role, kind, content, s) => (await q(`insert into pro_messages(thread_id,role,kind,content,created_at) values ($1,$2,$3,$4,$5) returning *`, [chat.id, role, kind, content, ts(s)]))[0]
  await mk('user', 'text', { text: '거래처 미팅 메모 정리' }, 70)
  await mk('agent', 'text', { text: '거래처 미팅 메모를 정리했어요. 다음 단계는 견적서 송부예요. 담당은 김서연이에요.', context: { conversationId: G, action: 'new', title: '거래처 미팅 메모' } }, 71)
  await q(`insert into context_threads(tenant_id,user_id,conversation_id,title,summary,gist,kind,turns,updated_at) values ($1,$2,$3,'거래처 미팅 메모','','','conversation',1,now())`, [TENANT, me.id, G])
  const card = await CM.offerNew(me, G)
  assert.equal(card.kind, 'project_offer')
  assert.equal(card.content.move.conversationId, G)
  assert.equal(card.content.move.count, 2)
  assert.equal(card.content.source.answer, undefined, '첫 문서 없음 — 대화가 통째로 감')
  assert.equal(card.content.context.conversationId, G, '카드도 그 대화에(함께 옮겨 감)')
  // two presses: the same card
  assert.equal((await CM.offerNew(me, G)).id, card.id)
  const made = await CP.make(me, card.id, { title: '거래처 미팅 후속' })
  assert.ok(made.moved, made.moveError)
  assert.equal(made.moved.moved, 3, '메시지 둘과 카드')
  const room = await msgs(made.project.id)
  assert.ok(room.some((x) => x.id === card.id && x.content.state === 'made' && x.content.moved?.count === 3))
  assert.ok(!(await msgs(chat.id)).some((x) => x.content?.context?.conversationId === G))
  assert.equal((await CM.placeOf(me, G)).project.id, made.project.id)
  // no 「원래 대화 열기」 · no first document — the conversation itself is there
  assert.ok(!room.some((x) => x.content?.fromChat))
})

test('TM-I-08 말로: 그 대화의 카드 · 말한 프로젝트는 판정 모델이 고른 것만 권함 · 옮기면 「옮겼어요」 · 「아니요」', async () => {
  const { me, chat, P4 } = await setup()
  const H = rid('conv-h')
  const mk = async (role, kind, content, s) => (await q(`insert into pro_messages(thread_id,role,kind,content,created_at) values ($1,$2,$3,$4,$5) returning *`, [chat.id, role, kind, content, ts(s)]))[0]
  await mk('user', 'text', { text: '견적 항목 정리' }, 80)
  await mk('agent', 'text', { text: '견적 항목을 정리했어요. 단가, 수량, 납기 세 칸이에요.', context: { conversationId: H, action: 'new', title: '견적 항목' } }, 81)
  // the chat stands in H; 「이거 견적 모음 프로젝트로 옮겨 줘」 — the judge reads which project
  llm.pick = '「견적 모음」'
  const card = await CM.offerByWords(me, { threadId: chat.id, project: '견적 모음', said: '이거 견적 모음 프로젝트로 옮겨 줘' })
  assert.equal(card.kind, 'conv_move')
  assert.equal(card.content.moveOf.id, H)
  assert.equal(card.content.moveOf.count, 2)
  assert.equal(card.content.suggest.id, P4.id)
  assert.equal(card.content.context.conversationId, H)
  assert.ok(llm.judged.at(-1).includes('견적 모음'), '판정 모델이 프로젝트 목록을 읽음')
  // the judge unsure: nothing suggested (the person picks)
  llm.p = 0.5
  const unsure = await CM.offerByWords(me, { threadId: chat.id, conversationId: H, project: '견적', said: '견적 프로젝트로 옮겨' })
  assert.equal(unsure.content.suggest, undefined)
  llm.p = 0.86
  await CM.declineCard(me, unsure.id)
  await assert.rejects(CM.declineCard(me, unsure.id), (e) => e.status === 409)
  // moved (after the same confirmation as the button): the open card says so, in the project
  const r = await CM.move(me, H, { project: P4.id })
  assert.equal(r.moved, 4, '두 줄과 카드 둘')
  const moved = (await msgs(P4.id)).find((x) => x.id === card.id)
  assert.equal(moved.content.state, 'moved')
  assert.equal(moved.content.project.id, P4.id)
  // in a project: nothing to move from there
  const inProject = await CM.offerByWords(me, { threadId: P4.id, project: '', said: '이 대화 프로젝트로 옮겨 줘' })
  assert.equal(inProject.kind, 'text')
  assert.match(inProject.content.text, /이미 프로젝트 안에 있어요/)
})

test('TM-I-09 라우트: 고르기 · 옮기기 · 되돌리기 · 어디 있나(남의 것 404)', async () => {
  const { me, sy, chat, P1 } = await setup()
  const J = rid('conv-j')
  const mk = async (role, kind, content, s) => (await q(`insert into pro_messages(thread_id,role,kind,content,created_at) values ($1,$2,$3,$4,$5) returning *`, [chat.id, role, kind, content, ts(s)]))[0]
  await mk('user', 'text', { text: '교육 장소 후보' }, 90)
  await mk('agent', 'text', { text: '교육 장소 후보 세 곳을 찾았어요. 모두 30명이 들어가요.', context: { conversationId: J, action: 'new', title: '교육 장소' } }, 91)
  await q(`insert into context_threads(tenant_id,user_id,conversation_id,title,summary,gist,kind,turns,updated_at) values ($1,$2,$3,'교육 장소','','','conversation',1,now())`, [TENANT, me.id, J])
  const g = await call(me, 'GET', `/conversations/${J}/move`)
  assert.equal(g.status, 200, g.text)
  assert.equal(g.body.conversation.count, 2)
  assert.equal((await call(sy, 'GET', `/conversations/${J}/move`)).status, 404)
  const bad = await call(me, 'POST', `/conversations/${J}/move`, { project: 'not-a-project' })
  assert.equal(bad.status, 400)
  const mv = await call(me, 'POST', `/conversations/${J}/move`, { project: P1.id })
  assert.equal(mv.status, 200, mv.text)
  assert.equal(mv.body.moved, 2)
  const pl = await call(me, 'GET', `/conversations/${J}/place`)
  assert.equal(pl.status, 200)
  assert.equal(pl.body.project.id, P1.id)
  assert.equal((await call(sy, 'GET', `/conversations/${J}/place`)).status, 404)
  assert.equal((await call(sy, 'POST', `/conversations/${J}/move/undo`, { project: P1.id })).status, 404)
  const back = await call(me, 'POST', `/conversations/${J}/move/undo`, { project: P1.id })
  assert.equal(back.status, 200, back.text)
  assert.equal(back.body.back, 2)
  assert.equal((await call(me, 'GET', `/conversations/${J}/place`)).status, 404)
})

test('TM-I-10 옮긴 대화에서 이어 물으면 그 프로젝트의 맥락으로 — 같은 대화 기록 · 프로젝트 계획 · 답은 그 주제에', async () => {
  const { me, chat, conv, P1 } = await setup()
  const N = await import('../lib/projectNote.js')
  await N.saveNote(me.id, P1.id, N.normalize({ intent: '가나정밀 1차 교육의 교안과 실습 목록을 만든다', deliverables: ['교안'] }), { editedBy: 'assistant' })
  const { runTurn } = await import('../lib/agent.js')
  const before = agentCalls.length
  // asked in the project's view narrowed to A (the page sends the sub-topic, as it does after the move)
  await runTurn({ user: me, session: { access_token: 'test' }, threadId: P1.id, text: '2일차 실습에 쓸 예제 데이터도 정해 줘', conversation: { id: conv.A, title: '가나정밀 교육 요청 조사' } })
  const call = agentCalls.slice(before).find((b) => b.conversation_id === conv.A)
  assert.ok(call, `deepagents 에 같은 대화 id 로: ${agentCalls.slice(before).map((b) => b.conversation_id).join()}`)
  assert.ok(String(call.message).includes('[프로젝트 계획]') && String(call.message).includes('가나정밀 1차 교육의 교안과 실습 목록을 만든다'), '프로젝트 계획과 함께')
  const room = await msgs(P1.id)
  const asked = room.find((x) => x.role === 'user' && x.content.text === '2일차 실습에 쓸 예제 데이터도 정해 줘')
  assert.equal(asked.content.conv, conv.A)
  const of = CV.topicOf(room)
  const answer = room.filter((x) => x.role === 'agent' && x.kind === 'text').at(-1)
  assert.equal(of[answer.id], conv.A, '답은 그 주제에')
  // the chat got nothing of it
  assert.ok(!(await msgs(chat.id)).some((x) => x.content?.text === '2일차 실습에 쓸 예제 데이터도 정해 줘'))
})

// ---------- PR #125 검토 ----------
// a conversation of its own in 정하윤's chat: two lines, its row (the router's) — newest in the chat
async function convIn(chatId, me, title, extra = 0) {
  const X = rid('conv-r')
  const mk = async (role, kind, content) => (await q(`insert into pro_messages(thread_id,role,kind,content) values ($1,$2,$3,$4) returning *`, [chatId, role, kind, content]))[0]
  await mk('user', 'text', { text: `${title} 정리해 줘` })
  const a = await mk('agent', 'text', { text: `${title}을 정리했어요. 세 가지로 나눴어요.`, context: { conversationId: X, action: 'new', title } })
  for (let i = 0; i < extra; i++) await mk('agent', 'text', { text: `${title} ${i}`, context: { conversationId: X, action: 'continue' } })
  await q(`insert into context_threads(tenant_id,user_id,conversation_id,title,summary,gist,kind,turns,updated_at) values ($1,$2,$3,$4,'','','conversation',2,now())`, [TENANT, me.id, X, title])
  return { X, a }
}

test('TM-I-11 대화를 아직 모르는 턴이 있으면 옮기기 · 되돌리기 409 busy, 옮긴 대화의 늦은 답은 채팅 행을 다시 만들지 않음', async () => {
  const { me, chat, P1 } = await setup()
  const { X } = await convIn(chat.id, me, '부품 단가 비교')
  // a routed chat turn already started, the router not answered yet (conv null)
  const t = turns.enqueue({ userId: me.id, threadId: chat.id, conv: null })
  t.started = true
  try {
    await assert.rejects(CM.move(me, X, { project: P1.id }), (e) => e.status === 409 && e.code === 'busy')
    const tg = await CM.targets(me, X)
    assert.equal(tg.conversation.movable, false)
    assert.equal(tg.conversation.code, 'busy')
  } finally { t.finish() }
  // a turn waiting its place, not knowing its conversation yet: the same
  const w = turns.enqueue({ userId: me.id, threadId: chat.id, conv: null })
  try { await assert.rejects(CM.move(me, X, { project: P1.id }), (e) => e.code === 'busy') } finally { w.finish() }
  // a turn of another conversation it already knows: not this one's
  const o = turns.enqueue({ userId: me.id, threadId: chat.id, conv: 'some-other-conv' })
  o.started = true
  let r
  try { r = await CM.move(me, X, { project: P1.id }) } finally { o.finish() }
  assert.equal(r.moved, 2)
  // a late answer of the chat for it (lib/agent.js touchContext → fileConversation): no row under the person's key again
  const { fileConversation } = await import('../lib/agent.js')
  await fileConversation(me, { conversationId: X, title: '부품 단가 비교' }, '늦은 요청', '늦은 답')
  assert.equal(await rowOf(me.id, X), null, '채팅 목록에 다시 나오지 않음')
  assert.ok(await rowOf(PT.scopeKey(me.id, P1.id), X))
  // undo while a turn of the project does not know its sub-topic yet (PT.routeProject may still pick it): busy
  const pt = turns.enqueue({ userId: me.id, threadId: P1.id, conv: null })
  try { await assert.rejects(CM.undo(me, X, { project: P1.id }), (e) => e.status === 409 && e.code === 'busy') } finally { pt.finish() }
  assert.equal((await CM.undo(me, X, { project: P1.id })).back, 2)
})

test('TM-I-12 채팅 열쇠의 행이 다시 생긴 대화도 되돌리기가 막히지 않음 — 행을 합침', async () => {
  const { me, chat, P1 } = await setup()
  const { X } = await convIn(chat.id, me, '납품 일정 확인')
  assert.equal((await CM.move(me, X, { project: P1.id })).moved, 2)
  // the router (another service) writes the chat's row for it again — 7 turns, a later time
  await q(`insert into context_threads(tenant_id,user_id,conversation_id,title,summary,gist,kind,turns,updated_at) values ($1,$2,$3,'납품 일정 확인','','','conversation',7,now() + interval '1 minute')`, [TENANT, me.id, X])
  const b = await CM.undo(me, X, { project: P1.id })
  assert.equal(b.back, 2)
  const rows = await q('select user_id, turns from context_threads where tenant_id=$1 and conversation_id=$2', [TENANT, X])
  assert.deepEqual(rows.map((x) => [x.user_id, x.turns]), [[me.id, 7]], '행 하나, 큰 턴 수')
})

test('TM-I-13 브라우저 작업이 진행 중인 대화는 옮기기 · 되돌리기 409 busy_task', async () => {
  const { me, chat, P1 } = await setup()
  const { X } = await convIn(chat.id, me, '거래처 사이트 주문')
  const [task] = await q(`insert into pro_messages(thread_id,role,kind,content) values ($1,'agent','task',$2) returning *`, [chat.id, { title: '주문 넣기', state: 'running', context: { conversationId: X, action: 'aside' } }])
  await assert.rejects(CM.move(me, X, { project: P1.id }), (e) => e.status === 409 && e.code === 'busy_task')
  for (const st of ['needs_input', 'queued']) {
    await q(`update pro_messages set content = content || $2::jsonb where id=$1`, [task.id, { state: st }])
    await assert.rejects(CM.move(me, X, { project: P1.id }), (e) => e.code === 'busy_task', st)
  }
  await q(`update pro_messages set content = content || '{"state":"done"}'::jsonb where id=$1`, [task.id])
  assert.equal((await CM.move(me, X, { project: P1.id })).moved, 3)
  // in the project, a task of it at work again: undo waits for it
  await q(`update pro_messages set content = content || '{"state":"running"}'::jsonb where id=$1`, [task.id])
  await assert.rejects(CM.undo(me, X, { project: P1.id }), (e) => e.code === 'busy_task')
  await q(`update pro_messages set content = content || '{"state":"done"}'::jsonb where id=$1`, [task.id])
  assert.equal((await CM.undo(me, X, { project: P1.id })).back, 3)
})

test('TM-I-14 칩은 옮기는 문장 안에서 생기고, 칩이 없어도 옮긴 메시지의 표시로 되돌림', async () => {
  const { me, sy, chat, P1 } = await setup()
  const { X } = await convIn(chat.id, me, '세미나 장소 섭외')
  const r = await CM.move(me, X, { project: P1.id })
  const chips = (await msgs(P1.id)).filter((m) => m.content?.moved?.note && m.content.moved.conv === X)
  assert.equal(chips.length, 1)
  assert.equal(chips[0].content.text, '채팅에서 옮겨 온 대화예요 · 메시지 2개')
  assert.equal(chips[0].content.moved.by, me.id)
  // the chip gone (a process that died, an edit): undo still knows the conversation came from the chat, and who moved it
  await q('delete from pro_messages where id=$1', [chips[0].id])
  await assert.rejects(CM.undo(sy, X, { project: P1.id }), (e) => e.status === 404)
  assert.equal((await CM.undo(me, X, { project: P1.id })).back, r.moved)
})

test('TM-I-15 따로 묶여 온 줄은 프로젝트의 다른 줄을 끌고 가지 않고, 되돌리기는 계획 바뀜 칩을 가져가지 않음', async () => {
  const { me, chat, P4 } = await setup()
  const { X } = await convIn(chat.id, me, '견적 회신 메일')
  assert.equal((await CM.move(me, X, { project: P4.id })).moved, 2)
  // a mail's line filed aside into it later (lib/store.js addMessage → the project), then the project's own untagged lines
  const late = await addMessage(me.id, chat.id, 'agent', 'text', { text: '답장을 보냈어요.', context: { conversationId: X, action: 'aside' } })
  assert.equal(late.thread_id, P4.id)
  const own = await addMessage(me.id, P4.id, 'agent', 'text', { text: '프로젝트에 원래 있던 답이에요.' })
  const plan = await addMessage(me.id, P4.id, 'agent', 'chip', { icon: 'check', text: '프로젝트 계획을 채웠어요', planChange: { noteId: null, backfill: true } })
  const room = await msgs(P4.id)
  const of = CV.topicOf(room)
  assert.equal(of[late.id], X)
  assert.notEqual(of[own.id], X, '프로젝트의 줄은 그 주제가 아님')
  assert.notEqual(of[plan.id], X)
  // (the page files them the same)
  const TOPICS = await import('../../src/projectTopics.js')
  assert.deepEqual(TOPICS.topicOf(room), of)
  const b = await CM.undo(me, X, { project: P4.id })
  assert.equal(b.back, 3, '두 줄과 늦게 온 줄')
  const left = (await msgs(P4.id)).map((m) => m.id)
  assert.ok(left.includes(own.id) && left.includes(plan.id), '프로젝트의 줄 · 계획 칩은 남음')
})

test('TM-I-16 빠진 폴더의 구성원 이름은 보이지 않음', async () => {
  const { me, chat, P2, sales } = await setup()
  const { X } = await convIn(chat.id, me, '영업 자료 요약')
  const S = await import('../lib/folders/service.js')
  // 정하윤 leaves 「영업 자료」 (김서연 owns it now)
  const { sy } = cast
  await q(`update pro_folder_members set role='owner' where folder_id=$1 and principal_id=$2`, [sales.id, sy.id])
  await q(`delete from pro_folder_members where folder_id=$1 and principal_id=$2`, [sales.id, me.id])
  const tg = await CM.targets(me, X)
  const p2 = tg.projects.find((p) => p.id === P2.id)
  assert.equal(p2.writable, false)
  assert.deepEqual(p2.members, [], '구성원 이름 없음')
  // (back as it was for the other tests)
  await q(`insert into pro_folder_members (folder_id, principal_type, principal_id, role) values ($1,'user',$2,'owner') on conflict do nothing`, [sales.id, me.id])
  await q(`update pro_folder_members set role='editor' where folder_id=$1 and principal_id=$2`, [sales.id, sy.id])
  assert.equal((await S.roleOf(await S.folderById(sales.id), me)), 'owner')
})

test('TM-I-17 열린 「새 프로젝트로」 카드는 다른 길로 옮기면 닫히고, 「만들고 옮기기」는 빈 프로젝트를 만들지 않음', async () => {
  const { me, chat, P4 } = await setup()
  const { X } = await convIn(chat.id, me, '협력사 미팅 준비')
  const card = await CM.offerNew(me, X)
  assert.equal(card.content.state, 'offered')
  // moved by the picker meanwhile
  assert.equal((await CM.move(me, X, { project: P4.id })).moved, 3)
  const closed = (await msgs(P4.id)).find((m) => m.id === card.id)
  assert.equal(closed.content.state, 'declined')
  assert.equal(closed.content.closed, 'moved')
  assert.equal(closed.content.project.id, P4.id)
  const before = (await q(`select count(*)::int as n from pro_threads where user_id=$1 and kind='project'`, [me.id]))[0].n
  await assert.rejects(CP.make(me, card.id, { title: '빈 프로젝트' }), (e) => e.status === 409)
  assert.equal((await q(`select count(*)::int as n from pro_threads where user_id=$1 and kind='project'`, [me.id]))[0].n, before, '프로젝트가 늘지 않음')
})

test('TM-I-18 말로: 걸러 본 화면에서 한 말 뒤에 전체 채팅에서 한 말은 지금 대화의 카드', async () => {
  const { me, chat } = await setup()
  const { runTurn } = await import('../lib/agent.js')
  const session = { access_token: 'test' }
  const Q = await convIn(chat.id, me, '교육 장비 대여')
  // from the view narrowed to Q
  await runTurn({ user: me, session, threadId: chat.id, text: '이 대화 프로젝트로 옮겨 줘', conversation: { id: Q.X, title: '교육 장비 대여' } })
  const c1 = (await msgs(chat.id)).filter((m) => m.kind === 'conv_move').at(-1)
  assert.equal(c1.content.moveOf.id, Q.X)
  await CM.declineCard(me, c1.id)
  // then the chat goes on in another conversation, and the whole chat asks the same
  const R = await convIn(chat.id, me, '강사 숙소 예약')
  await runTurn({ user: me, session, threadId: chat.id, text: '이 대화 프로젝트로 옮겨 줘' })
  const c2 = (await msgs(chat.id)).filter((m) => m.kind === 'conv_move').at(-1)
  assert.notEqual(c2.id, c1.id)
  assert.equal(c2.content.moveOf.id, R.X, '지금 대화(남아 있던 고정 대화가 아니라)')
})
