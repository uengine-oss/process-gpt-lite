// 팀원에게 물어 채우기 (lib/askTeammate.js · mcp/team.js · routes/askTeammate.js, 스펙 openspec/specs/ask-teammate) — 실제 개발 DB · 로컬 Storage,
// 가짜 모델(이 시험이 띄운 서버, 첫 글자 확률 길 그대로) · 가짜 deepagents(도구 ask_teammate 를 이 서버의 도구 함수로 부르고 그 결과를 흘려 보냄),
// 팀 · 묻기 경로는 실제 Express 라우트에 대고(로그인만 대역). 사람 · 값은 지어낸 것이다(정하윤 · 김서연 · 박도윤, 010-0000-0000 꼴).
//   AT-I-01 빈칸 → 에이전트의 ask_teammate → 동의 카드(누구 · 왜 · 항목 · 미리 보기, 휴대폰 알림) → 물어보기 → 1:1 방의 요청(AI 가 대신 묻는 중,
//           메일 원문 없음, 양식은 박도윤에게만, 팀 알림) → 박도윤이 양식으로 답함 → 원래 채팅에 「답했어요」 · 초안 TXT 의 빈칸이 채워진 새 판
//           (앞 판은 versions) · 메일 카드의 답장 초안도 채워짐 — 메일은 보내지 않음 · 두 번째 답은 409
//   AT-I-02 대신 답하려는 사람: 방에 없는 팀원 404 · 물어본 사람 403 · 방에 쓴 그 사람의 말도 읽지 않음
//   AT-I-03 말로 한 답: 그 방에 쓴 박도윤의 말을 판정이 답으로 읽고 값을 뽑아 채움 · 인사는 답이 아님
//   AT-I-04 「아니요(직접 채울게요)」: 아무것도 보내지 않음, 그 뒤 물어보기는 409
//   AT-I-05 답 없음: 하루가 지나면 「아직 답하지 않았어요」 · 알림 → 다시 묻기(새 요청, 앞 요청은 거둠) → 직접 채우기(방의 요청도 거둠, 뒤늦은 답 409)
//   AT-I-06 「잘 모르겠어요 · 대신 ○○에게」: 그 말 그대로 알림
//   AT-I-07 누구에게 물을 수 있나: 다른 회사 사람 · 자기 자신 · 팀에서 빠진 사람은 거절(빠진 사람은 카드가 그대로 「물어보기」 전으로), 남의 카드 404
//   AT-I-08 문서(docx)의 빈칸은 서버가 만든 턴(composed)으로 에이전트가 채움 — 그 턴의 사람 메시지는 composed
// Run: node --test --test-concurrency=1 test/askTeammate.integration.test.js  (needs the local Supabase)
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
process.env.DOTENV_CONFIG_QUIET = 'true'
process.env.PRO_BACKGROUND = '0'
// a company of its own on the shared database (its people only — the dev database's default company has leftover 박도윤s), removed at the end
const TENANT = `pro-at-${crypto.randomBytes(3).toString('hex')}`
process.env.PRO_TENANT_ID = TENANT
delete process.env.PRO_TENANT_FROM_HEADER
const NOWHERE = 'http://127.0.0.1:9'
Object.assign(process.env, { PRO_CONTEXT_ROUTER_URL: '', PRO_MEMENTO_URL: NOWHERE, PRO_JUDGE_URL: '', PRO_JUDGE_LLM: '0', PRO_EMBED_URL: '', PRO_COMPLETION_URL: NOWHERE,
  PRO_MINER_URL: NOWHERE, PRO_OFFICE_MCP_URL: NOWHERE, PRO_CLI_AGENT_URL: NOWHERE, PRO_ONTOLOGY_WORKER: '0', PRO_SCENARIOS: 'off', PRO_LLM_KEYS: 'off' })
const SKILL = path.join(here, '../../skills/ask-teammate/prompts')
const PROMPT = Object.fromEntries(['extract', 'fill', 'read-answer'].map((k) => [k, fs.readFileSync(path.join(SKILL, `${k}.md`), 'utf8').replace(/\s+$/, '')]))

// ---- the fake model ----
const script = { read: [], extract: [] }
const seen = { read: 0, extract: 0, fill: 0 }
const listen = (srv) => new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok(srv.address().port)))
const bodyOf = (req) => new Promise((ok) => { let raw = ''; req.on('data', (c) => { raw += c }); req.on('end', () => { try { ok(JSON.parse(raw)) } catch { ok({}) } }) })
// a blank in the fake's eyes: 「[<the label's last word>]」 or 「[확인 필요]」 on a line — this is the fake model, not the app
function fakeFill(u) {
  const lines = String(u.text).split('\n')
  const edits = []
  for (const it of u.items) {
    const word = it.label.split(' ').pop()
    const line = lines.find((l) => l.includes(`[${word}]`))
    if (line) edits.push({ find: line, replace: line.replace(`[${word}]`, it.value) })
  }
  return { edits }
}
const llm = http.createServer(async (req, res) => {
  const b = await bodyOf(req)
  const text = (b.messages || []).map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n')
  const sys = String(b.messages?.[0]?.content || '')
  const user = String(b.messages?.at(-1)?.content || '')
  const reply = (content) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] })) }
  if (b.logprobs) {
    const options = [...text.matchAll(/^([A-Z])\) (.+)$/gm)].map((m) => ({ letter: m[1], label: m[2] }))
    let hit = options.at(-1) || { letter: 'A' }
    if (text.includes(PROMPT['read-answer'])) {
      seen.read++
      const want = script.read.shift() || 'other'
      hit = options.find((o) => o.label.startsWith({ answer: '답 —', unknown: '모름 —', other: '다른 말 —' }[want])) || hit
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ choices: [{ message: { content: hit.letter }, logprobs: { content: [{ token: hit.letter, logprob: Math.log(0.92), top_logprobs: [{ token: hit.letter, logprob: Math.log(0.92) }] }] } }] }))
  }
  if (sys === PROMPT.extract) { seen.extract++; return reply(JSON.stringify(script.extract.shift() || { values: {} })) }
  if (sys === PROMPT.fill) { seen.fill++; return reply(JSON.stringify(fakeFill(JSON.parse(user)))) }
  if (b.tools) return reply('DELEGATE')
  if (sys.includes('what you understood')) return reply(JSON.stringify({ understood: '말씀대로 할게요.', steps: ['처리'], tier: 'light', certainty: 'sure' }))
  return reply(b.response_format ? '{}' : 'OK')
})
const llmPort = await listen(llm)
Object.assign(process.env, { PRO_LLM_BASE_URL: `http://127.0.0.1:${llmPort}/v1`, PRO_LLM_API_KEY: 'test', PRO_LLM_MODEL: 'fake', PRO_LLM_FAST_MODEL: 'fake', PRO_LLM_FRONT_MODEL: 'fake', PRO_LLM_ODDS_MODEL: 'fake' })

// ---- the fake deepagents (and mcp-hub: nothing bound) ----
const agent = { turns: [], next: [] }
const deep = http.createServer(async (req, res) => {
  const b = await bodyOf(req)
  if (!req.url.startsWith('/chat/stream')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(req.url.startsWith('/chat/stop') ? '{"stopped":false}' : req.url.startsWith('/health') ? '{}' : '[]') }
  agent.turns.push(b)
  const events = await (agent.next.shift() || (async () => [{ type: 'done', content: '확인했어요.' }]))(b)
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  if (b.conversation_id) res.write(`event: metadata\ndata: ${JSON.stringify({ conversation_id: b.conversation_id })}\n\n`)
  for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`)
  res.end()
})
const deepPort = await listen(deep)
process.env.PRO_DEEPAGENTS_URL = `http://127.0.0.1:${deepPort}`
process.env.PRO_MCP_HUB_URL = `http://127.0.0.1:${deepPort}`

const { q, pool, admin } = await import('../lib/supa.js')
const { config } = await import('../config.js')
const db = await q('select 1 from pro_messages limit 1').then(() => true).catch(() => false)
const AT = await import('../lib/askTeammate.js')
const { callTool } = await import('../mcp/team.js')
const { runTurn } = await import('../lib/agent.js')
const { mainThread } = await import('../lib/store.js')
const { publishBuffer } = await import('../lib/office.js')
const { storageKey } = await import('../lib/mailReply.js')

const users = [], rooms = new Set(), actions = [], closers = []
const OTHER_TENANT = `pro-at-other-${crypto.randomBytes(3).toString('hex')}`
after(async () => {
  if (db) {
    for (const r of rooms) {
      await q('delete from chats where id=$1', [r]).catch(() => {})
      await q('delete from pro_chat_reads where room_id=$1', [r]).catch(() => {})
      await q('delete from chat_rooms where id=$1', [r]).catch(() => {})
    }
    for (const a of actions) await q('delete from pro_actions where id=$1', [a]).catch(() => {})
    const objects = []
    for (const u of users) {
      await q('delete from pro_messages where thread_id in (select id from pro_threads where user_id=$1)', [u.id]).catch(() => {})
      await q('delete from pro_threads where user_id=$1', [u.id]).catch(() => {})
      await q('delete from notifications where user_id=$1 or user_id=$2 or from_user_id=$2', [u.id, u.email]).catch(() => {})
      await q('delete from pro_team_members where user_id=$1', [u.id]).catch(() => {})
      await q('delete from pro_team_removed where user_id=$1', [u.id]).catch(() => {})
      await q('delete from pro_profile where user_id=$1', [u.id]).catch(() => {})
      await q('delete from users where id=$1', [u.id]).catch(() => {})
      objects.push(...(await q(`select name from storage.objects where bucket_id='files' and starts_with(name, $1)`, [`pgpt-pro/${u.id}/`]).catch(() => [])).map((r) => r.name))
    }
    if (objects.length) await admin.storage.from('files').remove(objects).catch(() => {})
    await q('delete from tenants where id = any($1)', [[OTHER_TENANT, TENANT]]).catch(() => {})
    await pool.end()
  }
  for (const c of closers) c()
  llm.close(); deep.close()
})

async function person(name, tenant = TENANT) {
  const id = crypto.randomUUID()
  const u = { id, email: `pro-at-${id.slice(0, 8)}@example.test`, name }
  users.push(u)
  await q(`insert into users (id, email, username, tenant_id) values ($1,$2,$3,$4)`, [id, u.email, name, tenant])
  await q(`insert into pro_profile(user_id,name,email) values ($1,$2,$3) on conflict (user_id) do nothing`, [id, name, u.email])
  await q(`insert into pro_team_members(tenant_id,user_id,added_by) values ($1,$2,$2) on conflict do nothing`, [tenant, id])
  return u
}
let base = null
async function server() {
  if (base) return base
  const express = (await import('express')).default
  const { teamRoutes } = await import('../routes/team.js')
  const { askTeammateRoutes } = await import('../routes/askTeammate.js')
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  const auth = (req, res, next) => {
    const u = users.find((x) => x.id === req.headers['x-test-user'])
    if (!u) return res.status(401).json({ error: 'unauthorized' })
    req.user = { ...u }; req.session = { access_token: 'test' }; next()
  }
  app.use('/api', teamRoutes(auth))
  app.use('/api', askTeammateRoutes(auth))
  const srv = await new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)) })
  closers.push(() => srv.close())
  base = `http://127.0.0.1:${srv.address().port}`
  return base
}
async function call(who, method, p, body) {
  const r = await fetch(`${await server()}/api${p}`, { method, headers: { 'content-type': 'application/json', 'x-test-user': who.id }, body: body ? JSON.stringify(body) : undefined })
  const t = await r.text()
  let j = null
  try { j = JSON.parse(t) } catch { /* text */ }
  return { status: r.status, body: j ?? t }
}
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return v; await new Promise((r) => setTimeout(r, 60)) } }
const rowsOf = (tid) => q('select id, role, kind, content, created_at from pro_messages where thread_id=$1 order by created_at', [tid])
const cardOf = async (id) => (await q('select * from pro_messages where id=$1', [id]))[0]
const download = async (url) => Buffer.from(await (await admin.storage.from('files').download(storageKey(url))).data.arrayBuffer()).toString('utf8')

const DRAFT = ['교육 출강 참석자 정보 회신', '', '[정하윤]', '1) 이름 : 정하윤', '2) 연락처 : 010-0000-0001', '', '[박도윤]', '1) 이름 : 박도윤',
  '2) 연락처 : [확인 필요]', '3) 생년월일 : [확인 필요]', '4) 차량정보 : [차량정보]'].join('\n')
const MAIL_TEXT = '안녕하세요. 교육 출강 건으로 참석자 정보(연락처 · 생년월일 · 차량정보)를 회신해 주세요. 출입 등록에 필요합니다.'
const REPLY = '안녕하세요.\n참석자 정보 보내 드립니다.\n박도윤 연락처: [연락처]\n박도윤 생년월일: [생년월일]\n정하윤 드림'

let HY, DY, SY, OUT, thread, file, action
async function setup() {
  if (HY) return
  await q('insert into tenants (id) values ($1) on conflict do nothing', [TENANT])
  HY = await person('정하윤'); DY = await person('박도윤'); SY = await person('김서연')
  await q('insert into tenants (id) values ($1) on conflict do nothing', [OUT_TENANT()])
  OUT = await person('최다른', OUT_TENANT())
  thread = (await mainThread(HY.id)).id
  const pub = await publishBuffer(HY.id, '답장초안_교육출강.txt', Buffer.from(DRAFT, 'utf8'))
  ;[file] = await q(`insert into pro_messages(thread_id,role,kind,content) values ($1,'agent','file',$2) returning *`, [thread, { name: pub.name, url: pub.url, ext: 'txt' }])
  ;[action] = await q(`insert into pro_actions(user_id,verb,text,prompt,source) values ($1,'Review','교육 출강 요청 회신하기','참석자 정보 정리해서 회신',$2) returning *`,
    [HY.id, { mail_id: `demo-at-${crypto.randomBytes(3).toString('hex')}`, from: '담당자 <edu@example.test>', subject: '교육 출강 요청', kind: 'task',
      reply: { to: 'edu@example.test', cc: '', subject: 'Re: 교육 출강 요청', body: REPLY, at: new Date().toISOString() } }])
  actions.push(action.id)
}
const OUT_TENANT = () => OTHER_TENANT
const ARGS = () => ({ member: '박도윤', reason: '교육 출강 요청 메일에 참석자 정보를 회신해야 해요.', file: '답장초안_교육출강.txt', fields: [
  { label: '박도윤 연락처', line: '2) 연락처 : [확인 필요]', blank: '[확인 필요]' },
  { label: '박도윤 생년월일', line: '3) 생년월일 : [확인 필요]', blank: '[확인 필요]' },
  { label: '박도윤 차량정보' }] })
// the agent's turn: it calls ask_teammate (through this server's own tool function, as the MCP route would) and says what it left blank
function askingTurn(args) {
  agent.next.push(async () => {
    const r = await callTool(HY, 'ask_teammate', args)
    const out = r.content[0].text
    return [{ type: 'tool_start', tool: 'ask_teammate', input: args },
      { type: 'tool_end', tool: 'ask_teammate', output: `content='${out}' name='ask_teammate' tool_call_id='call_1'` },
      { type: 'done', content: '박도윤님 연락처 · 생년월일 · 차량정보는 비워 뒀어요. 박도윤님께 물어볼지 카드로 여쭤요. 메일은 보내지 않았어요.' }]
  })
}
async function offered(args = ARGS(), source = null) {
  askingTurn(args)
  await runTurn({ user: HY, session: { access_token: 'test' }, threadId: thread, text: '참석자 정보 답장 초안 마저 써 줘', composed: true, ...(source ? { source } : {}) })
  const cards = (await rowsOf(thread)).filter((m) => m.kind === 'ask_team')
  return cards.at(-1)
}
const roomOfCard = async (id) => { const c = await cardOf(id); if (c.content.ask?.room) rooms.add(c.content.ask.room); return c }

test('AT-I-01 빈칸 → 동의 카드 → 물어보기 → 메신저 요청 → 양식으로 답 → 「답했어요」 · 초안의 새 판 · 메일 답장 초안 (보내지 않음)', { skip: !db }, async () => {
  await setup()
  const card = await offered(ARGS(), { actionId: action.id })
  assert.ok(card, '동의 카드')
  assert.equal(card.content.state, 'offered')
  assert.equal(card.content.text, '박도윤님께 메신저로 물어볼까요?')
  assert.deepEqual(card.content.ask.member, { id: DY.id, name: '박도윤' })
  assert.deepEqual(card.content.ask.fields.map((f) => f.label), ['박도윤 연락처', '박도윤 생년월일', '박도윤 차량정보'])
  assert.equal(card.content.ask.file.msgId, file.id)
  assert.equal(card.content.ask.actionId, action.id)
  assert.match(card.content.ask.message, /^정하윤님 대신 AI가 여쭤봐요\.\n교육 출강 요청 메일에 참석자 정보를 회신해야 해요\./)
  // the person's phone hears of it (an 'ai_ask' notice for the card)
  const [n] = await q(`select * from notifications where user_id=$1 and type='ai_ask' and url like $2`, [HY.id, `%/${card.id}`])
  assert.ok(n, '휴대폰 · Home 알림')
  // nothing went to anyone yet
  assert.equal((await q(`select count(*)::int n from chats c join chat_rooms r on r.id=c.id where r.participants @> $1::jsonb`, [JSON.stringify([{ id: DY.id }])]))[0].n, 0)

  // 「물어보기」
  const s = await call(HY, 'POST', `/asks/${card.id}/send`, {})
  assert.equal(s.status, 200, JSON.stringify(s.body))
  const sent = await roomOfCard(card.id)
  assert.equal(sent.content.state, 'asked')
  assert.equal((await q(`select is_checked from notifications where id=$1`, [n.id]))[0].is_checked, true, '물어본 뒤엔 알림이 닫힘')
  // twice: once
  assert.equal((await call(HY, 'POST', `/asks/${card.id}/send`, {})).status, 409)
  const room = sent.content.ask.room
  const [row] = await q('select uuid, messages from chats where uuid=$1', [sent.content.ask.chat])
  assert.equal(row.messages.pgpt.kind, 'askteam')
  assert.equal(row.messages.userId, HY.id, '사용자 이름으로')
  assert.doesNotMatch(row.messages.content, /출입 등록에 필요합니다/, '메일 원문은 보내지 않음')
  assert.match(row.messages.content, /- 박도윤 연락처\n- 박도윤 생년월일\n- 박도윤 차량정보$/)
  // the teammate is told (a 'team' notice that opens the room at the request)
  const [tn] = await q(`select * from notifications where user_id=$1 and type='team'`, [DY.id])
  assert.equal(tn.title, '정하윤님이 물어봤어요 · AI 가 대신 묻는 중')
  assert.equal(tn.url, `/pro/team/${room}/${row.uuid}`)
  // the form: only for the one asked
  const theirs = (await call(DY, 'GET', `/team/threads/${room}/messages`)).body.messages.find((m) => m.id === row.uuid)
  assert.equal(theirs.kind, 'askteam')
  assert.ok(theirs.ask.forMe && theirs.ask.surface)
  const mine = (await call(HY, 'GET', `/team/threads/${room}/messages`)).body.messages.find((m) => m.id === row.uuid)
  assert.ok(mine.ask.mine && !mine.ask.surface)

  // 박도윤 answers with the form
  const action0 = { name: 'answer', surfaceId: theirs.ask.surface.createSurface.surfaceId, sourceComponentId: 'send' }
  const a = await call(DY, 'POST', `/team/asks/${row.uuid}/answer`, { values: { f1: '010-0000-0000', f2: '1990-01-01', f3: '없음' }, a2ui: { action: action0 } })
  assert.equal(a.status, 200, JSON.stringify(a.body))
  assert.equal(a.body.ask.state, 'answered')
  assert.deepEqual(a.body.ask.values, { f1: '010-0000-0000', f2: '1990-01-01', f3: '없음' })
  // once
  assert.equal((await call(DY, 'POST', `/team/asks/${row.uuid}/answer`, { values: { f1: '010-0000-0009' }, a2ui: { action: action0 } })).status, 409)

  // back in 정하윤's chat
  const done = await cardOf(card.id)
  assert.equal(done.content.state, 'answered')
  const back = (await rowsOf(thread)).filter((m) => m.kind === 'ask_team_reply').at(-1)
  assert.equal(back.content.mode, 'answered')
  assert.equal(back.content.text, '박도윤님이 답했어요')
  assert.deepEqual(back.content.items, [{ label: '박도윤 연락처', value: '010-0000-0000' }, { label: '박도윤 생년월일', value: '1990-01-01' }, { label: '박도윤 차량정보', value: '없음' }])
  // the draft: a new version of its card, the blanks filled (two by the agent's lines, one by the model), the old address kept
  const f2 = await cardOf(file.id)
  assert.notEqual(f2.content.url, file.content.url)
  assert.deepEqual(f2.content.versions, [file.content.url])
  assert.equal(back.content.file.state, 'filled')
  assert.equal(back.content.file.count, 3)
  const txt = await download(f2.content.url)
  assert.match(txt, /\[박도윤\]\n1\) 이름 : 박도윤\n2\) 연락처 : 010-0000-0000\n3\) 생년월일 : 1990-01-01\n4\) 차량정보 : 없음$/)
  assert.match(txt, /2\) 연락처 : 010-0000-0001/)
  // the mail card's reply draft too — filled, not sent
  const [act] = await q('select * from pro_actions where id=$1', [action.id])
  assert.match(act.source.reply.body, /박도윤 연락처: 010-0000-0000\n박도윤 생년월일: 1990-01-01/)
  assert.ok(!act.source.sent && !act.source.sending, '메일은 보내지 않음')
  assert.equal(act.source.teammate_answers.at(-1).by, '박도윤')
  assert.equal(back.content.mail.count, 2)
  // the person is told (Home · phone)
  const [an] = await q(`select * from notifications where user_id=$1 and type='ask_teammate' order by time_stamp desc limit 1`, [HY.id])
  assert.equal(an.title, '박도윤님이 답했어요')
})

test('AT-I-02 대신 답하려는 사람은 거절 — 방에 없는 팀원 404 · 물어본 사람 403 · 물어본 사람이 방에 쓴 말도 답이 아님', { skip: !db }, async () => {
  await setup()
  const card = await offered()
  assert.equal((await call(HY, 'POST', `/asks/${card.id}/send`, {})).status, 200)
  const c = await roomOfCard(card.id)
  const uuid = c.content.ask.chat
  const surfaceId = `ask_${card.id.replace(/-/g, '')}`
  const body = { values: { f1: '010-0000-0002' }, a2ui: { action: { name: 'answer', surfaceId } } }
  assert.equal((await call(SY, 'POST', `/team/asks/${uuid}/answer`, body)).status, 404)
  assert.equal((await call(HY, 'POST', `/team/asks/${uuid}/answer`, body)).status, 403)
  // 정하윤 writes in the room: not read as the answer (only the one asked is)
  const before = seen.read
  assert.equal((await call(HY, 'POST', `/team/threads/${c.content.ask.room}/messages`, { text: '연락처는 010-0000-0003 이에요' })).status, 200)
  await new Promise((r) => setTimeout(r, 400))
  assert.equal(seen.read, before)
  assert.equal((await cardOf(card.id)).content.state, 'asked')
  await call(HY, 'POST', `/asks/${card.id}/decline`, {})
})

test('AT-I-03 말로 한 답: 판정이 답으로 읽고 값을 뽑아 채운다, 인사는 답이 아님', { skip: !db }, async () => {
  await setup()
  const card = await offered()
  assert.equal((await call(HY, 'POST', `/asks/${card.id}/send`, {})).status, 200)
  const c = await roomOfCard(card.id)
  const room = c.content.ask.room
  // a greeting: the judge says 「다른 말」
  script.read.push('other')
  assert.equal((await call(DY, 'POST', `/team/threads/${room}/messages`, { text: '네 잠시만요' })).status, 200)
  await until(async () => seen.read && script.read.length === 0)
  await new Promise((r) => setTimeout(r, 300))
  assert.equal((await cardOf(card.id)).content.state, 'asked')
  // the answer in words
  script.read.push('answer')
  script.extract.push({ values: { f1: '010-0000-0004', f2: '1991-02-03' }, note: '차는 따로 알려 드릴게요' })
  assert.equal((await call(DY, 'POST', `/team/threads/${room}/messages`, { text: '연락처 010-0000-0004, 생일은 1991-02-03 이에요. 차는 따로 알려 드릴게요' })).status, 200)
  const done = await until(async () => { const x = await cardOf(card.id); return x.content.state === 'answered' ? x : null })
  assert.ok(done, '답으로 읽힘')
  assert.deepEqual(done.content.ask.values, { f1: '010-0000-0004', f2: '1991-02-03' })
  const back = await until(async () => (await rowsOf(thread)).filter((m) => m.kind === 'ask_team_reply' && m.content.card === card.id).at(-1))
  assert.equal(back.content.note, '차는 따로 알려 드릴게요')
  const [row] = await q('select messages from chats where uuid=$1', [c.content.ask.chat])
  assert.equal(row.messages.pgpt.ask.via, 'chat')
})

test('AT-I-04 「아니요(직접 채울게요)」: 아무것도 보내지 않고, 그 뒤 물어보기는 409', { skip: !db }, async () => {
  await setup()
  const card = await offered()
  const r = await call(HY, 'POST', `/asks/${card.id}/decline`, {})
  assert.equal(r.status, 200)
  assert.equal(r.body.content.state, 'declined')
  assert.equal((await call(HY, 'POST', `/asks/${card.id}/send`, {})).status, 409)
  assert.equal((await cardOf(card.id)).content.ask.chat, undefined)
})

test('AT-I-05 답 없음: 하루 뒤 「아직 답하지 않았어요」 → 다시 묻기 → 직접 채우기(방의 요청도 거둠)', { skip: !db }, async () => {
  await setup()
  const card = await offered()
  // 「고쳐서 물어보기」: the words and an item changed
  const s = await call(HY, 'POST', `/asks/${card.id}/send`, { message: '도윤님, 교육 출강 참석자 정보 좀 채워 주세요.', fields: [{ key: 'f1', label: '연락처' }, { key: 'f2', label: '생년월일' }] })
  assert.equal(s.status, 200)
  const c = await roomOfCard(card.id)
  assert.deepEqual(c.content.ask.fields.map((f) => f.label), ['연락처', '생년월일'])
  const [row] = await q('select messages from chats where uuid=$1', [c.content.ask.chat])
  assert.equal(row.messages.content, '도윤님, 교육 출강 참석자 정보 좀 채워 주세요.')
  // a day later
  assert.equal(await AT.sweep({ now: Date.now() + 25 * 3600_000, ids: [card.id] }), 1)
  assert.equal((await cardOf(card.id)).content.state, 'late')
  const late = (await rowsOf(thread)).filter((m) => m.kind === 'ask_team_reply').at(-1)
  assert.deepEqual([late.content.mode, late.content.text], ['late', '박도윤님이 아직 답하지 않았어요'])
  assert.equal(await AT.sweep({ now: Date.now() + 50 * 3600_000, ids: [card.id] }), 0, '한 번만')
  // 다시 묻기: a new request, the old one taken back
  const again = await call(HY, 'POST', `/asks/${card.id}/again`, {})
  assert.equal(again.status, 200)
  const c2 = await roomOfCard(card.id)
  assert.notEqual(c2.content.ask.chat, c.content.ask.chat)
  assert.equal((await q('select messages from chats where uuid=$1', [c.content.ask.chat]))[0].messages.pgpt.ask.state, 'superseded')
  // 직접 채우기: the request in the room is taken back; a late answer is refused
  assert.equal((await call(HY, 'POST', `/asks/${card.id}/decline`, {})).status, 200)
  assert.equal((await q('select messages from chats where uuid=$1', [c2.content.ask.chat]))[0].messages.pgpt.ask.state, 'cancelled')
  const surfaceId = `ask_${card.id.replace(/-/g, '')}`
  assert.equal((await call(DY, 'POST', `/team/asks/${c2.content.ask.chat}/answer`, { values: { f1: '010-0000-0005' }, a2ui: { action: { name: 'answer', surfaceId } } })).status, 409)
})

test('AT-I-06 「잘 모르겠어요」: 그 말 그대로 알린다', { skip: !db }, async () => {
  await setup()
  const card = await offered()
  assert.equal((await call(HY, 'POST', `/asks/${card.id}/send`, {})).status, 200)
  const c = await roomOfCard(card.id)
  const surfaceId = `ask_${card.id.replace(/-/g, '')}`
  const r = await call(DY, 'POST', `/team/asks/${c.content.ask.chat}/answer`, { values: { note: '저는 몰라요. 김서연 팀장님께 물어보세요' }, a2ui: { action: { name: 'unknown', surfaceId } } })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal((await cardOf(card.id)).content.state, 'unknown')
  const back = (await rowsOf(thread)).filter((m) => m.kind === 'ask_team_reply').at(-1)
  assert.deepEqual([back.content.mode, back.content.text, back.content.note], ['unknown', '박도윤님이 모른다고 했어요', '저는 몰라요. 김서연 팀장님께 물어보세요'])
})

test('AT-I-07 같은 회사 팀원에게만: 다른 회사 · 자기 자신 · 팀에서 빠진 사람은 거절, 남의 카드 404', { skip: !db }, async () => {
  await setup()
  const other = await AT.offerFor(HY, { ...ARGS(), member: OUT.email })
  assert.equal(other.ok, false)
  assert.ok(Array.isArray(other.team) && other.team.includes('박도윤') && !other.team.includes('최다른') && !other.team.includes('정하윤'))
  assert.equal((await AT.offerFor(HY, { ...ARGS(), member: '최다른' })).ok, false)
  assert.equal((await AT.offerFor(HY, { ...ARGS(), member: '정하윤' })).ok, false)
  // the MCP tool says so to the agent (isError) and no card comes
  const r = await callTool(HY, 'ask_teammate', { ...ARGS(), member: OUT.email })
  assert.equal(r.isError, true)
  // a teammate removed between the card and 「물어보기」
  const card = await offered()
  assert.equal((await call(SY, 'POST', `/asks/${card.id}/send`, {})).status, 404, '남의 카드')
  await q('delete from pro_team_members where user_id=$1', [DY.id])
  await q(`insert into pro_team_removed(tenant_id,user_id,removed_by) values ($3,$1,$2) on conflict do nothing`, [DY.id, HY.id, TENANT])
  try {
    const s = await call(HY, 'POST', `/asks/${card.id}/send`, {})
    assert.equal(s.status, 403)
    assert.equal((await cardOf(card.id)).content.state, 'offered', '보내지 않았으니 그대로')
  } finally {
    await q('delete from pro_team_removed where user_id=$1', [DY.id])
    await q(`insert into pro_team_members(tenant_id,user_id,added_by) values ($2,$1,$1) on conflict do nothing`, [DY.id, TENANT])
  }
})

test('AT-I-08 문서(docx)의 빈칸은 서버가 만든 턴(composed)으로 에이전트가 채운다', { skip: !db }, async () => {
  await setup()
  const pub = await publishBuffer(HY.id, '참석자명단.docx', Buffer.from('PK fake docx'))
  const [doc] = await q(`insert into pro_messages(thread_id,role,kind,content) values ($1,'agent','file',$2) returning *`, [thread, { name: pub.name, url: pub.url, ext: 'docx' }])
  const card = await offered({ ...ARGS(), file: '참석자명단.docx', fields: [{ label: '박도윤 연락처' }] })
  assert.equal(card.content.ask.file.msgId, doc.id)
  assert.equal((await call(HY, 'POST', `/asks/${card.id}/send`, {})).status, 200)
  const c = await roomOfCard(card.id)
  const was = AT.deps.sessionOf
  AT.deps.sessionOf = async (id) => ({ user: { id, email: HY.email }, session: { access_token: 'test' } })
  const turns = agent.turns.length
  try {
    const r = await call(DY, 'POST', `/team/asks/${c.content.ask.chat}/answer`, { values: { f1: '010-0000-0006' }, a2ui: { action: { name: 'answer', surfaceId: `ask_${card.id.replace(/-/g, '')}` } } })
    assert.equal(r.status, 200)
    const t = await until(() => agent.turns.length > turns && agent.turns.at(-1), 10000)
    assert.ok(t, '에이전트 턴')
    assert.match(t.message, /「참석자명단\.docx」의 빈칸을 채워 새 판으로 저장해 줘/)
    assert.match(t.message, /박도윤 연락처: 010-0000-0006/)
    const said = await until(async () => (await rowsOf(thread)).filter((m) => m.role === 'user' && /참석자명단\.docx/.test(m.content?.text || '')).at(-1))
    assert.equal(said.content.composed, true, '사람의 말이 아님')
    const back = (await rowsOf(thread)).filter((m) => m.kind === 'ask_team_reply').at(-1)
    assert.equal(back.content.file.state, 'agent')
  } finally { AT.deps.sessionOf = was }
})
