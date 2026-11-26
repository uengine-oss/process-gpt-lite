// 예약 작업 · 브리프는 자기 대화에, 후속 메시지는 방금 일하던 대화로 — 실제 데이터베이스 위에서, deepagents · context-router · 모델은
// 이 파일이 흉내 낸다(spec openspec/specs/chat-thread-list 「예약 작업과 브리프는 자기 대화에」 · 「후속 메시지는 방금 일하던 대화로」).
// 2026-11-25 운영 화면: 대화 「글씨가 표의 윗부분에 붙어있다. 중앙정렬」 안에 모닝 브리프 · 메일 칩 · 「주식 5일 누적 5% 급등락 감시」
// 실행 두 번이 있었고(예약 실행은 그때 사람이 있던 deepagents 대화를 이어 썼다 — lib/agent.js delegate), 그 대화의 첫 메시지는 바로
// 앞 문서 편집에서 끊겨 「새 주제」로 갔다.
//   · 예약 실행은 그 작업의 대화(sched-<id>)로 deepagents 에 가고(두 번 실행해도 같은 대화), 구분선과 결과가 그 대화로 따로 놓이며,
//     대화 목록(context_threads)에 kind 'schedule' 로 오른다. 메인 채팅이 서 있는 대화(pro_threads.conversation_id)는 그대로.
//     「변동 없음」 실행은 아무것도 남기지 않는다.
//   · 브리프는 그 사람의 「브리프」 대화로(kind 'brief'), 메일 칩도 그 안에.
//   · 문서를 열어 둔 채 보낸 후속 메시지는 그 문서를 다룬 대화로 바로 간다(라우터를 부르지 않음). 패널을 닫았으면 라우터가 받는 후보에
//     다룬 파일 · 마지막 턴 · 「방금까지 사람이 있던 대화」가 실린다(가짜 라우터가 받은 후보를 기록).
// 시험 계정 pro-rt-schedconv@uengine.org(로컬 Supabase 인증 — 예약 실행이 그 사람의 세션을 만든다). 데이터베이스가 없으면 건너뜀.
//   cd server && node --test test/ownConversations.integration.test.js
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

process.env.PRO_CRON_MODE = 'server'
const { config } = await import('../config.js')
const { q, pool, sessionFor } = await import('../lib/supa.js')
const up = await q('select 1').then(() => true, () => false)

// ---- the services this test stands in for ----
const ROUTER = 'http://127.0.0.1:59897'
config.contextRouterUrl = ROUTER
const agentBodies = []   // what deepagents got
const agentStops = []    // the conversations deepagents was asked to stop
let editOnTurn = false   // the agent's turn edits the open document (the editor reports it applied — lib/officeEdits.js)
const routerBodies = []  // what the context router got
const answers = []       // the next deepagents answers, in order (default: a plain one)
let triage = null        // the model's triage of the mailbox (lib/mail.js pollUser)
const realFetch = globalThis.fetch
const sse = (events) => new Response(events.map(([e, d]) => `${e ? `event: ${e}\n` : ''}data: ${JSON.stringify(d)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } })
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url)
  const body = (() => { try { return JSON.parse(opts.body) } catch { return {} } })()
  if (u.startsWith(config.deepagentsUrl)) {
    if (u.endsWith('/chat/stop')) { agentStops.push(body.conversation_id); return new Response(JSON.stringify({ stopped: false }), { headers: { 'Content-Type': 'application/json' } }) }
    if (u.endsWith('/chat/stream')) {
      agentBodies.push(body)
      if (editOnTurn && me) (await import('../lib/officeEdits.js')).recordEdit(me.id, 'office_live_apply_ops', { applied: true, summary: 'setTableCellFormat' })
      return sse([['metadata', { conversation_id: body.conversation_id }], ['', { type: 'token', content: answers.shift() || '결과를 정리했어요.' }]])
    }
    return new Response('[]', { headers: { 'Content-Type': 'application/json' } })
  }
  if (u.startsWith(ROUTER)) {
    routerBodies.push(body)
    // the router's choice, as its judge would make it here: the conversation the person was just in, else a new one
    const contexts = body.metadata?.contexts || []
    const hit = contexts.find((c) => c.active)
    const routing = hit ? { conversation_id: hit.conversation_id, action: 'continue', context: hit, decision: { strategy: 'judge', confidence: 0.9, notes: [] } }
      : { conversation_id: `new-${crypto.randomUUID().slice(0, 8)}`, action: 'new', context: null, decision: { strategy: 'logprob', confidence: 0.75, notes: [] } }
    if (u.endsWith('/route')) return new Response(JSON.stringify(routing), { headers: { 'Content-Type': 'application/json' } })
    return sse([['metadata', { conversation_id: routing.conversation_id, routing }], ['', { type: 'token', content: answers.shift() || '세로 가운데로 다시 맞췄어요.' }]])
  }
  if (u.startsWith(config.llm.baseUrl)) {
    const text = (body.messages || []).map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n')
    const content = triage && body.response_format && text.includes('demo-001') ? JSON.stringify(triage) : '{}'
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] }), { headers: { 'Content-Type': 'application/json' } })
  }
  if (/\/servers$|\/bindings$/.test(u)) return new Response('[]', { headers: { 'Content-Type': 'application/json' } })
  return realFetch(url, opts)
}

const { mainThread } = await import('../lib/store.js')
const { runMission } = await import('../lib/missions.js')
const { createSchedule, deleteSchedule } = await import('../lib/scheduler.js')
const { pollUser } = await import('../lib/mail.js')
const { delegate, runTurn, stopTurns } = await import('../lib/agent.js')
const RC = await import('../lib/routeContexts.js')
const Own = await import('../lib/ownConversations.js')
const { convOf } = await import('../../src/convOf.js')
const OTHER = crypto.randomUUID() // another person of the company (a teammate) — never signed in here

const EMAIL = 'pro-rt-schedconv@uengine.org'
let me = null, session = null, main = null
const schedules = []
const msgs = () => q('select id, role, kind, content, created_at from pro_messages where thread_id=$1 order by created_at', [main.id])
const row = async (conv) => (await q('select conversation_id, title, kind, summary, updated_at from context_threads where tenant_id=$1 and user_id=$2 and conversation_id=$3', [config.tenantId, me.id, conv]))[0]
// the person is in conversation A: a routed request and its answer, the chat standing in it
async function seedA() {
  await q('delete from pro_messages where thread_id=$1', [main.id])
  await q('delete from context_threads where tenant_id=$1 and user_id=$2', [config.tenantId, me.id])
  await q(`update pro_threads set conversation_id='conv-A', status=null where id=$1`, [main.id])
  await q(`insert into pro_messages(thread_id, role, kind, content, created_at) values ($1,'user','text',$2, now() - interval '3 minutes'), ($1,'agent','text',$3, now() - interval '2 minutes')`,
    [main.id, { text: '보고서 표 머리글 굵게 해 줘', conv: 'conv-A' }, { text: '머리글을 굵게 했어요.', conv: 'conv-A', context: { conversationId: 'conv-A', title: '보고서 표 정리', action: 'new' } }])
  await q(`insert into context_threads(tenant_id,user_id,conversation_id,title,summary,gist,kind,turns,updated_at) values ($1,$2,'conv-A','보고서 표 정리',$3,'','conversation',1, now() - interval '2 minutes')`,
    [config.tenantId, me.id, '최근 요청: 보고서 표 머리글 굵게 해 줘\n최근 답: 머리글을 굵게 했어요.'])
}

before(async () => {
  if (!up) return
  // (the account and its membership here first — a session is only an approved member's: spec team-membership)
  const { ensureUser } = await import('../lib/supa.js')
  const { admit } = await import('../lib/membership.js')
  const acct = await ensureUser(EMAIL, '회귀-schedconv')
  await admit(acct.id, EMAIL, '회귀-schedconv', acct.id)
  ;({ user: me, session } = await sessionFor(EMAIL, '회귀-schedconv'))
  await q(`insert into pro_profile(user_id, name, email, onboarded_at) values ($1,'회귀-schedconv',$2, now()) on conflict (user_id) do update set email=excluded.email`, [me.id, EMAIL])
  main = await mainThread(me.id)
})

after(async () => {
  globalThis.fetch = realFetch
  if (up && me) {
    for (const id of schedules) await deleteSchedule(me.id, id).catch(() => {})
    await q('delete from pro_messages where thread_id=$1', [main.id])
    await q('delete from context_threads where tenant_id=$1 and user_id=$2', [config.tenantId, me.id])
    await q('delete from context_threads where tenant_id=$1 and user_id=$2', [config.tenantId, OTHER])
    await q(`update pro_threads set conversation_id=null, status=null where id=$1`, [main.id])
    for (const id of schedules) await q('delete from pro_mission_runs where schedule_id=$1', [id]).catch(() => {})
    for (const t of ['pro_mail_accounts', 'pro_mail_seen', 'pro_actions']) await q(`delete from ${t} where user_id=$1`, [me.id]).catch(() => {})
    await q('delete from pro_mail_archive where owner_id::text=$1', [me.id]).catch(() => {})
    await q('delete from notifications where user_id::text=$1', [me.id]).catch(() => {})
  }
  await pool.end()
  const { closeOntology } = await import('../lib/ontology/store.js')
  await closeOntology().catch(() => {})
})

test('SO-I-01 예약 실행: 그 작업의 대화로 가고(두 번 모두 같은 에이전트 기록), 따로 놓이며 목록에 오르고, 사람의 대화는 그대로 — 알림은 그 대화를 연다', { skip: !up }, async () => {
  await seedA()
  const s = await createSchedule({ userId: me.id, name: '주식 5일 누적 5% 급등락 감시', cron: '0 0 31 2 *', prompt: 'KOSPI와 ASTS 의 5일 누적 등락률을 확인해서 5% 넘게 움직이면 알려 줘', threadId: null, notify: 'always' })
  schedules.push(s.id)
  const SC = Own.scheduleConversationId(s.id)
  const n0 = agentBodies.length
  answers.push('KOSPI 5일 +1.2%, ASTS 5일 -6.1% · 출처: 네이버 증권')
  await runMission(s.id, 'manual')
  answers.push('ASTS 5일 -7.0% — 5% 넘게 내렸어요 · 출처: 네이버 증권')
  await runMission(s.id, 'manual')
  // both runs went to the task's own agent history (its first stretch of runs), not the conversation the person was in
  assert.deepEqual(agentBodies.slice(n0).map((b) => b.conversation_id), [`${SC}-r0`, `${SC}-r0`])
  // the run's notice opens the task's own conversation (review 11-25 #9)
  const [note] = await q(`select url from notifications where user_id::text=$1 and type='mission' order by time_stamp desc limit 1`, [me.id])
  assert.equal(note.url, `/chat/c/${SC}`)
  assert.equal(routerBodies.length, 0)
  const [th] = await q('select conversation_id from pro_threads where id=$1', [main.id])
  assert.equal(th.conversation_id, 'conv-A')
  // each run: its divider (naming the conversation) and its result, filed aside
  const all = await msgs()
  const mine = all.filter((m) => m.content?.context?.conversationId === SC)
  assert.deepEqual(mine.map((m) => m.kind), ['divider', 'text', 'divider', 'text'])
  for (const m of mine) assert.equal(m.content.context.action, 'aside')
  assert.equal(mine[0].content.scheduleId, s.id)
  assert.equal(mine[0].content.context.title, '주식 5일 누적 5% 급등락 감시')
  assert.equal(mine[1].content.context.title, undefined)
  assert.equal(mine[1].content.conv, SC)
  // listed in the chat's 대화, as a scheduled task's
  const r = await row(SC)
  assert.equal(r.kind, 'schedule')
  assert.equal(r.title, '주식 5일 누적 5% 급등락 감시')
  assert.match(r.summary, /ASTS 5일 -7\.0%/)
  // the screen's filing: conversation A holds only its own two messages
  const of = convOf(all, { userId: me.id })
  assert.deepEqual(all.filter((m) => of[m.id] === 'conv-A').map((m) => m.content.text), ['보고서 표 머리글 굵게 해 줘', '머리글을 굵게 했어요.'])
  assert.equal(all.filter((m) => of[m.id] === SC).length, 4)

  // a watch with nothing new: 「변동 없음」 leaves nothing in the chat and does not move the conversation up the list; the run is told
  // what it shared last (its history may have started afresh — review 11-25 #2)
  await q(`update pro_schedules set notify='on_change' where id=$1`, [s.id])
  answers.push('변동 없음')
  await runMission(s.id, 'manual')
  assert.equal(agentBodies.at(-1).conversation_id, `${SC}-r0`)
  assert.match(agentBodies.at(-1).message, /변동 없음/)
  assert.match(agentBodies.at(-1).message, /직전 실행에서 공유한 결과:\n«ASTS 5일 -7\.0% — 5% 넘게 내렸어요 · 출처: 네이버 증권»/)
  assert.equal((await msgs()).length, all.length)
  assert.equal(String((await row(SC)).updated_at), String(r.updated_at))
})

test('SO-I-02 실행 실패 줄과 「지금 실행」의 결과도 그 작업의 대화로', { skip: !up }, async () => {
  await seedA()
  const s = await createSchedule({ userId: me.id, name: '환율 확인', cron: '0 0 31 2 *', prompt: '원/달러 환율 알려 줘', threadId: main.id, notify: 'always' })
  schedules.push(s.id)
  const SC = Own.scheduleConversationId(s.id)
  // asked from the chat ("지금 한 번 실행해 봐"): the run reports with the chat's thread given — still the task's conversation
  answers.push('1,382원이에요.')
  await runMission(s.id, 'manual', { threadId: main.id, test: true })
  assert.equal(agentBodies.at(-1).conversation_id, `${SC}-r0`)
  // an answer the run reads as a failure: its line is in the task's conversation too (the answer is already there: no second line)
  answers.push('(오류: 시세 사이트에 닿지 못했어요)')
  await runMission(s.id, 'manual')
  const all = await msgs()
  const of = convOf(all, { userId: me.id })
  const inSC = all.filter((m) => of[m.id] === SC)
  assert.deepEqual(inSC.map((m) => m.kind), ['divider', 'text', 'divider', 'text'])
  assert.match(inSC[3].content.text, /오류/)
  assert.equal(all.filter((m) => of[m.id] === 'conv-A').length, 2)
  assert.equal((await row(SC)).kind, 'schedule')
})

test('SO-I-03 브리프: 그 사람의 「브리프」 대화로(구분선 · 글 · 메일 칩), 목록에 kind brief, 사람의 대화는 그대로', { skip: !up }, async () => {
  await seedA()
  await q(`insert into pro_mail_accounts(user_id, provider, address) values ($1,'demo',$2) on conflict (user_id) do update set provider='demo'`, [me.id, EMAIL])
  await q('delete from pro_mail_seen where user_id=$1', [me.id])
  triage = { actions: [{ mail_id: 'demo-004', verb: 'Review', kind: 'task', text: '세미나 발표 자료 확인', icon_domain: '', due: null, prompt: '세미나 발표 자료를 확인해 줘' }],
    brief: '다음 주 세미나 발표 자료 요청이 왔어요. 나머지는 안내 메일이에요.', drafts: [] }
  try { await pollUser(me.id) } finally { triage = null }
  const BR = Own.briefConversationId(me.id)
  const all = await msgs()
  const brief = all.filter((m) => m.content?.context?.conversationId === BR)
  assert.deepEqual(brief.map((m) => m.kind), ['divider', 'text'])
  assert.equal(brief[0].content.context.title, '브리프')
  assert.equal(brief[1].content.text, '다음 주 세미나 발표 자료 요청이 왔어요. 나머지는 안내 메일이에요.')
  assert.equal(brief[1].content.mails.length, 1)
  assert.equal(brief[1].content.mails[0].text, '세미나 발표 자료 확인')
  const r = await row(BR)
  assert.equal(r.kind, 'brief')
  assert.equal(r.title, '브리프')
  const [th] = await q('select conversation_id from pro_threads where id=$1', [main.id])
  assert.equal(th.conversation_id, 'conv-A')
  const of = convOf(all, { userId: me.id })
  assert.equal(all.filter((m) => of[m.id] === 'conv-A').length, 2)
})

// the chat a minute before the follow-up: conversation E edited 보고서.docx (its table) in the editor — opened from its card; then a
// scheduled run and a brief. → the card's message id
const CARD_URL = 'http://127.0.0.1:54321/storage/v1/object/public/files/pgpt-pro/test/보고서.docx'
async function seedEdit() {
  await q('delete from pro_messages where thread_id=$1', [main.id])
  await q('delete from context_threads where tenant_id=$1 and user_id=$2', [config.tenantId, me.id])
  await q(`update pro_threads set conversation_id='conv-E', status=null where id=$1`, [main.id])
  const SC = Own.scheduleConversationId('11111111-2222-4333-8444-555555555555')
  const BR = Own.briefConversationId(me.id)
  const rows = [
    ['user', 'text', { text: '이 보고서 표 머리글 굵게 해 줘', conv: 'conv-E' }, 9],
    ['agent', 'text', { text: '머리글을 굵게 했어요.', conv: 'conv-E', context: { conversationId: 'conv-E', title: '보고서 표 정리', action: 'new' } }, 8.5],
    ['agent', 'file', { name: '보고서.docx', ext: 'docx', url: CARD_URL }, 8],
    ['system', 'divider', { text: '주식 감시', scheduleId: '11111111-2222-4333-8444-555555555555', context: { conversationId: SC, action: 'aside', kind: 'schedule', title: '주식 감시' } }, 5],
    ['agent', 'text', { text: 'ASTS -7%', conv: SC, context: { conversationId: SC, action: 'aside', kind: 'schedule' } }, 5],
    ['agent', 'text', { text: '모닝 브리프: 박용주님이 Tailscale 팀에 초대했어요.', context: { conversationId: BR, action: 'aside', kind: 'brief' } }, 3],
    ['user', 'text', { text: '표 안 글씨 세로 가운데로', conv: 'conv-E' }, 2],
    ['agent', 'text', { text: '세로 가운데로 맞췄어요.', conv: 'conv-E', context: { title: '보고서 표 정리', action: 'stay' }, openDoc: { file: '보고서.docx', app: 'ieumoffice' } }, 1],
  ]
  let card = null
  for (const [role, kind, content, min] of rows) {
    const [m] = await q(`insert into pro_messages(thread_id, role, kind, content, created_at) values ($1,$2,$3,$4, now() - ($5::float * interval '1 minute')) returning id`, [main.id, role, kind, content, min])
    if (kind === 'file') card = m.id
  }
  for (const [id, title, kind, min] of [['conv-E', '보고서 표 정리', 'conversation', 1], [SC, '주식 감시', 'schedule', 5], [BR, '브리프', 'brief', 3], ['conv-trip', '부산 출장 숙소', 'conversation', 300]]) {
    await q(`insert into context_threads(tenant_id,user_id,conversation_id,title,summary,gist,kind,turns,updated_at) values ($1,$2,$3,$4,$5,'',$6,1, now() - make_interval(mins => $7))`,
      [config.tenantId, me.id, id, title, `최근 요청: ${title}\n최근 답: …`, kind, min])
  }
  return card
}
const FOLLOW = '글씨가 표의 윗부분에 붙어있다. 중앙정렬'
const DOC = (extra = {}) => ({ app: 'ieumoffice', file: '보고서.docx', name: '보고서.docx', editor: 'docs', ...extra })
const lastAnswer = (all) => all.filter((m) => m.role === 'agent' && m.kind === 'text').at(-1)

test('SO-I-04 패널을 닫고 보낸 후속 메시지: 라우터가 받은 후보에 방금 있던 대화(진행 중) · 다룬 파일 · 마지막 턴 — 그 대화로 이어감', { skip: !up }, async () => {
  await seedEdit()
  const n0 = routerBodies.length
  const msg = await delegate({ user: me, session, threadId: main.id, text: FOLLOW })
  assert.equal(routerBodies.length, n0 + 1)
  const b = routerBodies.at(-1)
  assert.equal(b.metadata.route_text, FOLLOW)
  const E = b.metadata.contexts.find((c) => c.conversation_id === 'conv-E')
  assert.equal(E.active, true)
  assert.equal(E.title, '보고서 표 정리')
  assert.match(E.summary.split('\n')[0], /^방금까지 사람이 있던 대화\(마지막 턴 1분 전\) · 다룬 파일: 보고서\.docx\(Word 문서, 편집\)$/)
  const trip = b.metadata.contexts.find((c) => c.conversation_id === 'conv-trip')
  assert.equal(trip.active, undefined)
  assert.match(trip.summary.split('\n')[0], /^마지막 턴 5시간 전$/)
  // a background conversation is a candidate as it is stored (its kind for the router's label), never the one the person was in
  assert.equal(b.metadata.contexts.find((c) => c.kind === 'schedule').active, undefined)
  // the answer: in conversation E
  assert.equal(msg.content.context.conversationId, 'conv-E')
  assert.equal(msg.content.context.action, 'continue')
})

test('SO-I-05 문서를 열어 둔 채 보낸 후속 메시지: 그 문서의 카드로 그 대화에 바로(라우터 없이), 편집이 반영된 답에만 열린 문서가 남는다', { skip: !up }, async () => {
  const card = await seedEdit()
  // the chat stood elsewhere meanwhile (the screen's own link lost): the open document still decides
  await q(`update pro_threads set conversation_id='conv-trip' where id=$1`, [main.id])
  const r0 = routerBodies.length, a0 = agentBodies.length
  editOnTurn = true
  try { await runTurn({ user: me, session, threadId: main.id, text: FOLLOW, openDoc: DOC({ msgId: card, url: `${CARD_URL}?token=signed` }) }) } finally { editOnTurn = false }
  assert.equal(routerBodies.length, r0)
  assert.equal(agentBodies.length, a0 + 1)
  assert.equal(agentBodies.at(-1).conversation_id, 'conv-E')
  const all = await msgs()
  const said = all.find((m) => m.role === 'user' && m.content.text === FOLLOW)
  const answer = lastAnswer(all)
  assert.equal(said.content.conv, 'conv-E')
  assert.deepEqual([answer.content.context.conversationId, answer.content.context.action, answer.content.context.strategy], ['conv-E', 'continue', 'pinned'])
  // the edit went through: the answer keeps which document (its card, its address without the signature)
  assert.deepEqual(answer.content.openDoc, { file: '보고서.docx', app: 'ieumoffice', msgId: card, url: CARD_URL })
  const [th] = await q('select conversation_id from pro_threads where id=$1', [main.id])
  assert.equal(th.conversation_id, 'conv-E')
  assert.equal(convOf(all)[said.id], 'conv-E')
  // a turn that edited nothing (a question about the document): no openDoc on its answer
  await runTurn({ user: me, session, threadId: main.id, text: '이 표 몇 행이야?', openDoc: DOC({ msgId: card }) })
  assert.equal(lastAnswer(await msgs()).content.openDoc, undefined)
})

test('SO-I-06 문서 연결은 보낸 화면의 문서로만: 이름만 같은 문서 · 문서를 보내지 않은 화면(다른 기기에 열린 문서) · 공유 폴더 실행 방은 잇지 않는다 (검토 #4)', { skip: !up }, async () => {
  const card = await seedEdit()
  // a document of the same name the page opened from somewhere else (no card, no address): the router decides
  let r0 = routerBodies.length
  await runTurn({ user: me, session, threadId: main.id, text: FOLLOW, openDoc: DOC() })
  assert.equal(routerBodies.length, r0 + 1)
  // a phone that sent no open document (the desktop has 보고서.docx open): the router decides, with the facts
  r0 = routerBodies.length
  await delegate({ user: me, session, threadId: main.id, text: FOLLOW })
  assert.equal(routerBodies.length, r0 + 1)
  // the conversation the card is in is a shared folder's run room: never the link
  const f = await RC.turnFacts({ user: me, threadId: main.id, open: DOC({ msgId: card }) }, { isRoom: async (c) => c === 'conv-E' })
  assert.equal(f.docLink, null)
  const g = await RC.turnFacts({ user: me, threadId: main.id, open: DOC({ msgId: card }) }, { isRoom: async () => false })
  assert.deepEqual(g.docLink, { conversationId: 'conv-E', title: '보고서 표 정리' })
})

test('SO-I-07 남의 대화 id 는 받지 않는다: 팀원의 브리프 id 로 보낸 메시지는 고정되지 않고, 멈추기는 거절 — 내 대화는 그대로 (검토 #1)', { skip: !up }, async () => {
  await seedEdit()
  const theirs = Own.briefConversationId(OTHER)
  await q(`insert into context_threads(tenant_id,user_id,conversation_id,title,summary,gist,kind,turns,updated_at) values ($1,$2,$3,'브리프','','','brief',1,now())`, [config.tenantId, OTHER, theirs])
  assert.equal(await Own.ownsConversation(me.id, theirs), null)
  assert.deepEqual(await Own.ownsConversation(OTHER, theirs), { kind: 'brief' })
  assert.deepEqual(await Own.ownsConversation(me.id, 'conv-E'), { kind: 'conversation' })
  // a conversation only a message of mine went to (no row yet) is mine too
  await q(`insert into pro_messages(thread_id, role, kind, content) values ($1,'agent','text',$2)`, [main.id, { text: '새 대화', conv: 'conv-fresh' }])
  assert.deepEqual(await Own.ownsConversation(me.id, 'conv-fresh'), { kind: 'conversation' })
  // asking 「in」 the teammate's conversation: not pinned there — the router decides among my own
  const r0 = routerBodies.length, a0 = agentBodies.length
  await runTurn({ user: me, session, threadId: main.id, text: '오늘 브리프 요약해 줘', conversation: { id: theirs, title: '브리프' } })
  assert.equal(routerBodies.length, r0 + 1)
  assert.ok(agentBodies.slice(a0).every((b) => b.conversation_id !== theirs))
  assert.ok(!routerBodies.at(-1).metadata.contexts.some((c) => c.conversation_id === theirs))
  // 멈추기 in the teammate's conversation: refused, deepagents never asked
  const s0 = agentStops.length
  const r = await stopTurns({ user: me, session, threadId: main.id, conversation: theirs })
  assert.equal(r.refused, true)
  assert.equal(agentStops.length, s0)
  // in my own: asked
  await stopTurns({ user: me, session, threadId: main.id, conversation: 'conv-E' })
  assert.deepEqual(agentStops.slice(s0), ['conv-E'])
})

test('SO-I-08 내 브리프 · 예약 작업 대화 안에서 물으면 그 대화에 올라온 줄(에이전트 기록에 없는 것)을 앞에 붙인다 (검토 #8)', { skip: !up }, async () => {
  await seedEdit()
  const BR = Own.briefConversationId(me.id)
  const a0 = agentBodies.length
  await runTurn({ user: me, session, threadId: main.id, text: 'Tailscale 초대는 누가 보낸 거야?', conversation: { id: BR, title: '브리프' } })
  const b = agentBodies.at(-1)
  assert.equal(agentBodies.length, a0 + 1)
  assert.equal(b.conversation_id, BR)
  assert.match(b.message, /^\(이 대화에 앞서 올라온 내용 — 예약 실행 · 브리프 등, 에이전트 기록에는 없는 것:\n모닝 브리프: 박용주님이 Tailscale 팀에 초대했어요\.\)\n\nTailscale 초대는 누가 보낸 거야\?/)
  // an ordinary conversation of mine: nothing added
  await runTurn({ user: me, session, threadId: main.id, text: '머리글 색도 바꿔 줘', conversation: { id: 'conv-E', title: '보고서 표 정리' } })
  assert.match(agentBodies.at(-1).message, /^머리글 색도 바꿔 줘/)
})

test('SO-I-09 예약 작업의 에이전트 기록은 몇 번마다 새로 — 목록의 대화는 하나 (검토 #2)', { skip: !up }, async () => {
  await seedA()
  process.env.PRO_SCHEDULE_HISTORY_RUNS = '2'
  try {
    const s = await createSchedule({ userId: me.id, name: '환율 감시', cron: '0 0 31 2 *', prompt: '원/달러 환율 알려 줘', threadId: null, notify: 'always' })
    schedules.push(s.id)
    const SC = Own.scheduleConversationId(s.id)
    const n0 = agentBodies.length
    for (const v of ['1,380원', '1,381원', '1,382원']) { answers.push(v); await runMission(s.id, 'manual') }
    assert.deepEqual(agentBodies.slice(n0).map((b) => b.conversation_id), [`${SC}-r0`, `${SC}-r0`, `${SC}-r1`])
    const all = await msgs()
    assert.equal(all.filter((m) => m.content?.context?.conversationId === SC).length, 6)
    assert.equal(all.filter((m) => String(m.content?.conv || '').startsWith(`${SC}-r`)).length, 0)
    assert.equal((await row(SC)).kind, 'schedule')
  } finally { delete process.env.PRO_SCHEDULE_HISTORY_RUNS }
})

const until = async (fn, ms = 10000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v || Date.now() > end) return v; await new Promise((r) => setTimeout(r, 50)) } }
// 「곧바로 하나 정도 한번 실행해 봐」 right after a task's line in the chat (lib/agent.js runScheduleNowTurn): → the run-now line it said
async function runNow(s) {
  await seedA()
  await q(`insert into pro_messages(thread_id, role, kind, content) values ($1,'agent','chip',$2)`, [main.id, { icon: 'clock', text: `예약됨 · ${s.name}`, scheduleId: s.id }])
  await runTurn({ user: me, session, threadId: main.id, text: '곧바로 하나 정도 한번 실행해 봐' })
  // (the run itself goes on in the background: wait for it, so its lines do not land in the next test's chat)
  await until(async () => (await q('select 1 from pro_mission_runs where schedule_id=$1 and finished_at is not null', [s.id])).length)
  return (await msgs()).filter((m) => m.role === 'agent' && m.kind === 'text').map((m) => m.content.text).find((t) => t.includes('지금 바로 한 번 실행할게요'))
}
test('SO-I-10 「지금 실행」의 말: 프로세스를 시작하는 작업은 「여기」(그 실행은 인스턴스에 산다), 프롬프트 작업은 그 작업의 대화 (검토 #9)', { skip: !up }, async () => {
  const s = await createSchedule({ userId: me.id, name: '주간 발주 점검', cron: '0 0 31 2 *', prompt: '발주 점검 시작', threadId: main.id, notify: 'always' })
  schedules.push(s.id)
  await q(`update pro_schedules set process_id='no_such_process_rt' where id=$1`, [s.id])
  const one = await runNow(s)
  assert.match(one, /결과는 곧 여기에 올라와요/)
  await deleteSchedule(me.id, s.id)
  const p = await createSchedule({ userId: me.id, name: '환율 확인', cron: '0 0 31 2 *', prompt: '원/달러 환율 알려 줘', threadId: main.id, notify: 'always' })
  schedules.push(p.id)
  answers.push('1,382원이에요.')
  const two = await runNow(p)
  assert.match(two, /결과는 곧 이 작업의 대화 「환율 확인」에 올라와요/)
})

test('SO-I-11 맥락의 턴 짝짓기: 따로 놓인 답은 사람의 요청과 짝을 이루지 않는다 — 사람의 요청은 자기 답과 (검토 #7)', { skip: !up }, async () => {
  await seedA()
  const SC = Own.scheduleConversationId('33333333-2222-4333-8444-555555555555')
  // the person asks in A; a scheduled run's result arrives aside before A's answer
  for (const [role, content, sec] of [
    ['user', { text: '표 머리글 색 바꿔 줘' }, 30],
    ['agent', { text: 'ASTS -7%', conv: SC, context: { conversationId: SC, action: 'aside', kind: 'schedule' } }, 20],
    ['agent', { text: '머리글 색을 바꿨어요.', conv: 'conv-A', context: { conversationId: 'conv-A', title: '보고서 표 정리', action: 'continue' } }, 10],
  ]) await q(`insert into pro_messages(thread_id, role, kind, content, created_at) values ($1,$2,'text',$3, now() - make_interval(secs => $4))`, [main.id, role, content, sec])
  const { turnsOf } = await import('../lib/context/items.js')
  const inA = await turnsOf(me.id, 'conv-A')
  assert.equal(inA.at(-1).prompt, '표 머리글 색 바꿔 줘')
  assert.equal(inA.at(-1).answer, '머리글 색을 바꿨어요.')
  const inSC = await turnsOf(me.id, SC)
  assert.deepEqual(inSC.map((t) => [t.prompt, t.answer]), [['', 'ASTS -7%']])
  // 같은 요청 알아보기(lib/context/repeat.js) pairs the same way: the person's request with A's answer, the aside answer with nothing
  const { turnsByOwner } = await import('../lib/context/repeat.js')
  const by = await turnsByOwner([me.id])
  assert.equal(by.get(`${me.id}:conv-A`).at(-1).prompt, '표 머리글 색 바꿔 줘')
  assert.equal(by.get(`${me.id}:${SC}`), undefined)
})
