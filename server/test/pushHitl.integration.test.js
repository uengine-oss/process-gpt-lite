// 휴대폰 알림을 메신저처럼 · AI 의 질문에 알림에서 바로 답하기 — 실제 DB 위에서(2026-11-26 사용자: 「퀵하게 대화방에서 온 내용 혹은 ai의
// 후먼인더루프 등을 모바일에서 보게할 수 있나?」, 스펙 openspec/specs/mobile-push). 회사는 이 시험만의 것(push-hitl-it), deepagents 는
// 흉내 낸 스트림(fetch 가로채기), 모델은 부르지 않음(닿지 않는 주소), 푸시 서비스는 이 시험의 가짜(test/fixtures/fakePush.mjs) — 실제
// 기기로는 아무것도 가지 않는다.
//   PH-I-01 채팅 에이전트가 사람에게 묻고 멈추면(human_input_required) 답에 질문 · 보기가 남고, 'ai_ask' 알림 행 하나 · Home 카드(어디서 여는지)
//   PH-I-02 알림 피드 → 가짜 푸시 서비스: 질문은 보기 두 개가 단추 + 토큰(로그인 토큰 아님), 방 메시지는 방마다 하나(「<방> · 3」, 마지막
//           두 줄, 태그, 「답장」), 멘션은 따로 · 언제나, 내가 보낸 것은 없음, 다른 사람에게는 아무것도 가지 않음
//   PH-I-03 단추로 답하기 → 그 보기가 그 대화에 내 메시지로 한 번, 알림은 확인됨 · Home 에서 사라짐; 같은 토큰 다시 → 409
//   PH-I-04 위조 토큰 401 · 다른 사람의 토큰 403 · 만료 410 · 없는 보기 400 · 다른 회사의 토큰 401
//   PH-I-05 채팅에 직접 답하면(다음 메시지) 그 대화의 질문 알림은 확인됨 · 그 뒤 알림의 단추는 409
//   PH-I-06 브라우저 작업의 승인 카드: 단추는 「열기」와 「취소」뿐, 토큰은 「취소」만 — 승인은 카드에서만(canAnswerCard)
//   PH-I-07 「시험 알림 보내기」: 내 기기마다 하나
//   PH-I-08 이름 없는 단체방: 제목은 나를 뺀 사람들 이름(「박도윤, 김민수 · 2」)
//   PH-I-09 그 대화에서 다른 답을 쓰는 중이면 단추의 답은 보내지 않고 알림 · Home 카드는 남는다(끝나면 같은 단추로 답함)
// 데이터베이스가 없으면 건너뜀. 시험 사용자는 무작위 id(로그인 계정 아님), 끝나면 지움.
// Run: node --test --test-concurrency=1 test/pushHitl.integration.test.js
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

const TENANT = 'push-hitl-it'
process.env.PRO_TENANT_ID = TENANT
delete process.env.PRO_TENANT_FROM_HEADER
process.env.PRO_TENANT_HOSTS = ''
process.env.PRO_BACKGROUND = '0'
process.env.PRO_DEEPAGENTS_URL = 'http://deepagents.push-hitl.test'
process.env.PRO_CONTEXT_ROUTER_URL = ''
process.env.PRO_MEMENTO_URL = 'http://127.0.0.1:9'
process.env.PRO_LLM_BASE_URL = 'http://127.0.0.1:9/v1'
process.env.PRO_JUDGE_URL = ''
process.env.PRO_VAPID_FILE = path.join(os.tmpdir(), `pgl-vapid-pushhitl-${process.pid}.json`)

const { config } = await import('../config.js')
const { q, pool } = await import('../lib/supa.js')
const up = await q('select 1').then(() => true, () => false)

// ---- a scripted deepagents: every /chat/stream call becomes a stream the test writes into ----
const realFetch = globalThis.fetch
const streams = []
let wake = []
const enc = new TextEncoder()
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url)
  if (u.startsWith(config.deepagentsUrl)) {
    const body = opts.body ? JSON.parse(opts.body) : {}
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
    return new Response('{}', { headers: { 'Content-Type': 'application/json' } })
  }
  if (/\/servers$|\/bindings$/.test(u)) return new Response('[]', { headers: { 'Content-Type': 'application/json' } })
  return realFetch(url, opts)
}
const nth = async (n) => { while (streams.length < n) await new Promise((r) => wake.push(r)); return streams[n - 1] }
const until = async (fn, ms = 6000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return v; await new Promise((r) => setTimeout(r, 40)) } }

const { runTurn } = await import('../lib/agent.js')
const ASK = await import('../lib/askPerson.js')
const PA = await import('../lib/pushActions.js')
const notify = await import('../lib/notify.js')
const webpush = await import('../lib/webpush.js')
const { canAnswerCard } = await import('../lib/browser.js')
const { startFakePush } = await import('./fixtures/fakePush.mjs')

const stamp = crypto.randomBytes(3).toString('hex')
const A = { id: crypto.randomUUID(), email: `pro-push-hitl-a-${stamp}@people-mail.test`, name: '정하윤' }
const B = { id: crypto.randomUUID(), email: `pro-push-hitl-b-${stamp}@people-mail.test`, name: '박도윤' }
const session = { access_token: 'test-token' }
const ROOM = `push-room-${stamp}`
const P = await startFakePush()
const threads = []
async function thread(user, kind = 'project') {
  const [t] = await q(`insert into pro_threads(user_id,kind,title,conversation_id) values ($1,$2,'주간 회의 정리',$3) returning id`, [user.id, kind, `ph-${stamp}-${threads.length}`])
  threads.push(t.id)
  return t.id
}
const msgs = (tid) => q('select id, role, kind, content from pro_messages where thread_id=$1 order by created_at', [tid])
const HITL = JSON.stringify({ type: 'human_input_required', question: '어떤 형식으로 정리할까요?', context: '회의록 초안이 준비됐어요.', options: ['세 줄 요약', '표로 정리'], run_state: {} })
// the agent asks in a project thread → {tid, card}
async function asked(user) {
  const tid = await thread(user)
  const n0 = streams.length
  const p = runTurn({ user, session, threadId: tid, text: '이번 주 회의록 정리해 줘' })
  const h = await nth(n0 + 1)
  h.push('message', { type: 'done', content: HITL }); h.end()
  const card = await p
  return { tid, card }
}
const notices = (user, type = 'ai_ask') => q(`select * from notifications where tenant_id=$1 and user_id = any($2) and type=$3 order by time_stamp`, [TENANT, [user.id, user.email], type])

if (up) {
  await q('insert into tenants (id) values ($1) on conflict do nothing', [TENANT])
  for (const u of [A, B]) {
    await q(`insert into users (id, email, username, tenant_id) values ($1,$2,$3,$4)`, [u.id, u.email, u.name, TENANT])
    await q(`insert into pro_profile(user_id,name,email) values ($1,$2,$3) on conflict (user_id) do nothing`, [u.id, u.name, u.email])
  }
  const subA = P.subscription('a'), subB = P.subscription('b')
  for (const [u, s] of [[A, subA], [B, subB]]) {
    await q(`insert into pro_push_subscriptions(endpoint, user_id, tenant_id, p256dh, auth, ua) values ($1,$2,$3,$4,$5,'test')`, [s.endpoint, u.id, TENANT, s.keys.p256dh, s.keys.auth])
  }
  // the feed's position: now (rows before it are not news)
  await notify.feedOnce()
}
after(async () => {
  globalThis.fetch = realFetch
  if (up) {
    await q('delete from notifications where tenant_id=$1', [TENANT]).catch(() => {})
    await q('delete from pro_push_subscriptions where tenant_id=$1', [TENANT]).catch(() => {})
    if (threads.length) await q('delete from pro_threads where id = any($1)', [threads])
    for (const u of [A, B]) {
      await q('delete from pro_profile where user_id=$1', [u.id]).catch(() => {})
      await q('delete from users where id=$1', [u.id]).catch(() => {})
    }
  }
  await P.close()
  await pool.end()
  const { closeOntology } = await import('../lib/ontology/store.js').catch(() => ({}))
  await closeOntology?.().catch(() => {})
})

let first // PH-I-01's question, answered in PH-I-03
let pushed // PH-I-02's payload of it

test('PH-I-01 에이전트가 묻고 멈추면: 답에 질문 · 보기, ai_ask 알림 한 줄, Home 카드는 그 프로젝트에서 연다', { skip: !up }, async () => {
  first = await asked(A)
  assert.deepEqual(first.card.content.ask, { question: '어떤 형식으로 정리할까요?', options: ['세 줄 요약', '표로 정리'] })
  assert.match(first.card.content.text, /어떤 형식으로 정리할까요\?\n- 세 줄 요약\n- 표로 정리/)
  const rows = await until(async () => { const r = await notices(A); return r.length ? r : null })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].title, 'Process GPT 의 질문이 있어요')
  assert.equal(rows[0].description, '어떤 형식으로 정리할까요?')
  assert.equal(rows[0].url, `/pro/ask/chat/${first.tid}/${first.card.id}`)
  const home = (await notify.listFor(A)).filter((n) => n.type === 'ai_ask')
  assert.deepEqual(home.map((n) => ({ kind: n.kind, place: n.place, text: n.text })), [{ kind: 'question', place: `/projects/${first.tid}`, text: '어떤 형식으로 정리할까요?' }])
  // (opening the Home card does not answer it: it stays)
  assert.deepEqual(await notify.act(A, rows[0].id), { place: `/projects/${first.tid}` })
  assert.equal((await notices(A))[0].is_checked, false)
  assert.equal((await notices(B)).length, 0)
})

test('PH-I-02 피드 → 푸시: 질문은 단추 · 토큰, 방은 하나로 묶고, 멘션은 따로, 내가 보낸 것 · 다른 사람 것은 없다', { skip: !up }, async () => {
  // three messages of a teammate in one room (as process-gpt's chat trigger writes them), a mention, one with me as its sender
  for (const text of ['회의 자료 올렸어요', '견적서도 같이 봐 주세요', '오늘 안에 부탁해요']) {
    await q(`insert into notifications(id,user_id,title,type,description,url,from_user_id,tenant_id) values (gen_random_uuid(),$1,$2,'chat','3분기 견적',$3,'김민수',$4)`,
      [A.email, text, `/chats?id=${ROOM}`, TENANT])
    await new Promise((r) => setTimeout(r, 15))
  }
  await q(`insert into notifications(id,user_id,title,type,description,url,from_user_id,tenant_id) values (gen_random_uuid(),$1,'김민수님이 나를 언급했어요','team','@정하윤 이거 확인 부탁',$2,$3,$4)`,
    [A.id, `/pro/team/${ROOM}/${crypto.randomUUID()}`, B.email, TENANT])
  await q(`insert into notifications(id,user_id,title,type,description,url,from_user_id,tenant_id) values (gen_random_uuid(),$1,'내가 쓴 공유','team','',$2,$3,$4)`,
    [A.id, `/pro/team/${ROOM}/${crypto.randomUUID()}`, A.email, TENANT])
  // (the question's row as new as the room's: one pass of the feed carries them all)
  await q(`update notifications set time_stamp = now() where tenant_id=$1 and user_id=$2 and type='ai_ask'`, [TENANT, A.id])
  await notify.feedOnce()
  const got = await P.payloads('a', 3)
  const ask = got.find((p) => p.type === 'ai_ask')
  const room = got.find((p) => p.type === 'chat')
  const mention = got.find((p) => p.mention)
  assert.ok(ask && room && mention, JSON.stringify(got))
  assert.equal(got.length, 3, 'one per room, the mention apart, nothing of my own')
  // the question
  assert.equal(ask.title, 'Process GPT 의 질문이 있어요')
  assert.equal(ask.body, '어떤 형식으로 정리할까요?')
  assert.deepEqual(ask.actions, [{ action: 'a0', title: '세 줄 요약' }, { action: 'a1', title: '표로 정리' }])
  assert.equal(ask.tag, `pgl-ask-${first.card.id}`)
  assert.equal(ask.place, `/projects/${first.tid}`)
  assert.equal(ask.requireInteraction, true)
  assert.doesNotMatch(JSON.stringify(ask), /test-token|access_token/)
  const v = PA.verifyAction(ask.token, { key: ASK.signingKey() })
  assert.equal(v.ok, true)
  assert.deepEqual({ u: v.claims.u, c: v.claims.c, a: v.claims.a }, { u: A.id, c: first.card.id, a: ['세 줄 요약', '표로 정리'] })
  // the room: one notification, its count, the last two lines, its tag, 「답장」
  assert.equal(room.title, '3분기 견적 · 4')
  assert.equal(room.body, '김민수: 견적서도 같이 봐 주세요\n김민수: 오늘 안에 부탁해요')
  assert.equal(room.tag, `pgl-room-${ROOM}`)
  assert.equal(room.renotify, true)
  assert.equal(room.room, ROOM)
  assert.deepEqual(room.actions, [{ action: 'reply', title: '답장' }])
  // the mention: its own, always shown
  assert.equal(mention.title, '김민수님이 나를 언급했어요')
  assert.equal(mention.tag, `pgl-${mention.id}`)
  assert.deepEqual(mention.actions, [{ action: 'reply', title: '답장' }])
  assert.ok(got.every((p) => p.badge >= 4))
  // nobody else heard of any of it
  assert.equal((await P.payloads('b', 1, 300)).length, 0)
  pushed = ask
})

test('PH-I-03 알림의 단추로 답하면 그 보기가 내 메시지로 한 번 가고, 같은 토큰은 다시 쓰지 못한다', { skip: !up }, async () => {
  const turns = []
  const answerChat = ASK.chatAnswerer({ runTurn: async (a) => { turns.push(a) }, sessionFor: async (email) => ({ user: { email }, session }), busy: () => [] })
  const r = await ASK.act({ token: pushed.token, answer: 0 }, { answerChat, answerTask: async () => assert.fail('not a task') })
  assert.equal(r.status, 200, JSON.stringify(r))
  assert.equal(r.answered, '세 줄 요약')
  assert.equal(r.said, '「세 줄 요약」으로 답했어요')
  assert.equal(r.place, `/projects/${first.tid}`)
  await until(() => turns.length)
  assert.equal(turns.length, 1)
  assert.deepEqual({ id: turns[0].user.id, thread: turns[0].threadId, text: turns[0].text }, { id: A.id, thread: first.tid, text: '세 줄 요약' })
  assert.equal((await notices(A)).every((n) => n.is_checked), true)
  assert.equal((await notify.listFor(A)).some((n) => n.type === 'ai_ask'), false)
  // the same token again (a second tap, another device): used
  const again = await ASK.act({ token: pushed.token, answer: 1 }, { answerChat, answerTask: async () => true })
  assert.equal(again.status, 409)
  assert.equal(turns.length, 1)
})

test('PH-I-04 위조 · 다른 사람 · 만료 · 없는 보기 · 다른 회사의 토큰은 거절한다', { skip: !up }, async () => {
  const { tid, card } = await asked(A)
  const n = await until(async () => (await notices(A)).find((x) => !x.is_checked && x.url.endsWith(card.id)))
  assert.ok(n, 'its notice')
  const key = ASK.signingKey()
  const calls = []
  const deps = { answerChat: async (...a) => { calls.push(a); return true }, answerTask: async (...a) => { calls.push(a); return true } }
  const good = PA.mintAction({ key, tenant: TENANT, userId: A.id, notice: n.id, card: card.id, answers: ['세 줄 요약', '표로 정리'] })
  const [h, body, sig] = good.split('.')
  // forged: another answer slipped into the same signature
  const claims = JSON.parse(Buffer.from(body, 'base64url'))
  assert.equal((await ASK.act({ token: `${h}.${Buffer.from(JSON.stringify({ ...claims, a: ['승인'] })).toString('base64url')}.${sig}`, answer: 0 }, deps)).status, 401)
  assert.equal((await ASK.act({ token: `${h}.${body}.${'A'.repeat(43)}`, answer: 0 }, deps)).status, 401)
  assert.equal((await ASK.act({ token: PA.mintAction({ key: PA.actionKey('another-server'), tenant: TENANT, userId: A.id, notice: n.id, card: card.id, answers: ['x'] }), answer: 0 }, deps)).status, 401)
  // another person's token (B, signed by this server) on A's notice
  assert.equal((await ASK.act({ token: PA.mintAction({ key, tenant: TENANT, userId: B.id, notice: n.id, card: card.id, answers: ['세 줄 요약'] }), answer: 0 }, deps)).status, 403)
  // A's token for another card than the notice's
  assert.equal((await ASK.act({ token: PA.mintAction({ key, tenant: TENANT, userId: A.id, notice: n.id, card: crypto.randomUUID(), answers: ['x'] }), answer: 0 }, deps)).status, 403)
  // another company's
  assert.equal((await ASK.act({ token: PA.mintAction({ key, tenant: 'localhost', userId: A.id, notice: n.id, card: card.id, answers: ['x'] }), answer: 0 }, deps)).status, 401)
  // expired, an answer it does not carry
  assert.equal((await ASK.act({ token: PA.mintAction({ key, tenant: TENANT, userId: A.id, notice: n.id, card: card.id, answers: ['x'], now: Date.now() - 25 * 3600e3 }), answer: 0 }, deps)).status, 410)
  assert.equal((await ASK.act({ token: good, answer: 2 }, deps)).status, 400)
  assert.equal((await ASK.act({ token: good, answer: 'a0' }, deps)).status, 400)
  // none of them answered anything, and the notice still waits
  assert.equal(calls.length, 0)
  assert.equal((await notices(A)).find((x) => x.id === n.id).is_checked, false)
  assert.ok(tid)
})

test('PH-I-05 채팅에 직접 답하면 그 대화의 질문 알림은 확인되고, 그 뒤의 단추는 409', { skip: !up }, async () => {
  const n = (await notices(A)).filter((x) => !x.is_checked).at(-1)
  const at = ASK.parseAskUrl(n.url)
  const token = PA.mintAction({ key: ASK.signingKey(), tenant: TENANT, userId: A.id, notice: n.id, card: at.cardId, answers: ['세 줄 요약', '표로 정리'] })
  const n0 = streams.length
  const p = runTurn({ user: A, session, threadId: at.threadId, text: '표로 정리해 줘' })
  const h = await nth(n0 + 1)
  assert.equal((await until(async () => (await notices(A)).find((x) => x.id === n.id && x.is_checked))).is_checked, true)
  h.push('message', { type: 'token', content: '표로 정리했어요.' }); h.end()
  await p
  assert.equal((await notify.listFor(A)).some((x) => x.type === 'ai_ask'), false)
  const turns = []
  const answerChat = ASK.chatAnswerer({ runTurn: async (a) => { turns.push(a) }, sessionFor: async (email) => ({ user: { email }, session }), busy: () => [] })
  assert.equal((await ASK.act({ token, answer: 0 }, { answerChat })).status, 409)
  assert.equal(turns.length, 0)
  // (a question the person already answered in the chat is not waiting, even if its notice were still up)
  assert.equal(await ASK.stillWaiting(at), false)
})

test('PH-I-06 브라우저 작업의 승인 카드: 알림은 「열기」 · 「취소」뿐, 승인은 카드에서만', { skip: !up }, async () => {
  const tid = await thread(A, 'chat')
  const [card] = await q(`insert into pro_messages(thread_id,role,kind,content) values ($1,'agent','choice',$2) returning id`,
    [tid, { site: 'shop.example', approval: true, question: '장바구니 49,000원 결제', options: ['승인', '취소'], taskId: crypto.randomUUID(), state: 'pending' }])
  const id = await ASK.ask(A.id, { via: 'task', threadId: tid, cardId: card.id, kind: 'approval', text: '장바구니 49,000원 결제' })
  assert.equal(await ASK.ask(A.id, { via: 'task', threadId: tid, cardId: card.id, kind: 'approval', text: '같은 카드' }), id, 'once per card')
  const [row] = await q('select * from notifications where id=$1', [id])
  assert.equal(row.title, '승인이 필요해요')
  const p = await ASK.askPayload(row, A.id)
  assert.equal(p.kind, 'approval')
  assert.equal(p.place, '/chat')
  assert.deepEqual(p.actions, [{ action: 'open', title: '열기' }, { action: 'a0', title: '취소' }])
  assert.deepEqual(PA.verifyAction(p.token, { key: ASK.signingKey() }).claims.a, ['취소'])
  // the task's own guard: an approval is refused from outside its card, never approved
  const asking = { card: card.id, kind: 'choice', approval: true, options: ['승인', '취소'] }
  assert.equal(canAnswerCard(asking, card.id, '승인'), false)
  assert.equal(canAnswerCard(asking, card.id, '취소'), true)
  assert.equal(canAnswerCard({ ...asking, approval: false }, card.id, '승인'), true)
  assert.equal(canAnswerCard(asking, crypto.randomUUID(), '취소'), false, 'another card')
  assert.equal(canAnswerCard({ ...asking, vault: true }, card.id, '취소'), false, 'a vault card')
  assert.equal(canAnswerCard({ ...asking, kind: 'vault' }, card.id, '취소'), false)
  assert.equal(canAnswerCard({ ...asking, approval: false }, card.id, '다른 말'), false, 'not one of its options')
  // refused from the notification: the task hears it; then the card is no longer waiting — the Home drops it
  const heard = []
  const r = await ASK.act({ token: p.token, answer: 0 }, { answerTask: async (...a) => { heard.push(a); await q(`update pro_messages set content = content || '{"state":"answered"}'::jsonb where id=$1`, [card.id]); return true } })
  assert.equal(r.status, 200)
  assert.deepEqual(heard, [[A.id, card.id, '취소']])
  assert.equal(r.said, '「취소」로 답했어요')
  // a sign-in wait (the task card itself, needs_input): 「열기」 only, no token
  const [task] = await q(`insert into pro_messages(thread_id,role,kind,content) values ($1,'agent','task',$2) returning id`, [tid, { state: 'needs_input', need: 'login', title: '노트 만들기' }])
  const lid = await ASK.ask(A.id, { via: 'task', threadId: tid, cardId: task.id, kind: 'login', text: 'notes.example 로그인' })
  const [lrow] = await q('select * from notifications where id=$1', [lid])
  assert.equal(lrow.title, '로그인이 필요해요')
  const lp = await ASK.askPayload(lrow, A.id)
  assert.deepEqual(lp.actions, [{ action: 'open', title: '열기' }])
  assert.equal(lp.token, undefined)
  // a question in one conversation of the main chat opens that conversation (/chat/c/<id>), as the conversation list does
  const [inConv] = await q(`insert into pro_messages(thread_id,role,kind,content) values ($1,'agent','text',$2) returning id`, [tid, { text: '어느 쪽으로 할까요?', conv: `conv-${stamp}`, ask: { question: '어느 쪽으로 할까요?', options: [] } }])
  assert.equal(await ASK.placeOf(tid, inConv.id), `/chat/c/conv-${stamp}`)
  assert.equal(await ASK.placeOf(tid, card.id), '/chat')
  // the wait ends (answered on the screen): settled — off the Home
  assert.equal(await ASK.settle(A.id, { via: 'task', threadId: tid, cardId: task.id }), 1)
  assert.equal((await notify.listFor(A)).some((x) => x.type === 'ai_ask'), false)
})

test('PH-I-07 「시험 알림 보내기」: 내 기기마다 하나, 다른 사람에게는 없음', { skip: !up }, async () => {
  const before = P.received.filter((r) => r.who === 'a').length
  const n = await webpush.pushTo(A.id, { id: `test-${Date.now()}`, type: 'test', tag: 'pgl-test', title: '시험 알림이에요', body: '이 알림이 보이면 휴대폰 알림이 켜진 거예요' })
  assert.equal(n, 1)
  const got = await P.payloads('a', before + 1)
  assert.equal(got.at(-1).title, '시험 알림이에요')
  assert.equal((await P.payloads('b', 1, 300)).length, 0)
})

test('PH-I-08 이름 없는 단체방의 알림 제목은 나를 뺀 사람들 이름', { skip: !up }, async () => {
  const group = `push-group-${stamp}`
  const C = { id: crypto.randomUUID(), email: `pro-push-hitl-c-${stamp}@people-mail.test`, name: '김민수' }
  await q(`insert into chat_rooms(id, name, participants, tenant_id) values ($1, null, $2, $3)`, [group,
    JSON.stringify([A, B, C].map((u) => ({ id: u.id, email: u.email, username: u.name, is_agent: false }))), TENANT])
  try {
    for (const [from, text] of [['박도윤', '오후 회의 자료예요'], ['김민수', '저도 봤어요']]) {
      await q(`insert into notifications(id,user_id,title,type,description,url,from_user_id,tenant_id) values (gen_random_uuid(),$1,$2,'chat',null,$3,$4,$5)`,
        [A.email, text, `/chats?id=${group}`, from, TENANT])
      await new Promise((r) => setTimeout(r, 15))
    }
    const before = P.received.filter((r) => r.who === 'a').length
    await notify.feedOnce()
    const got = (await P.payloads('a', before + 1)).slice(before).find((p) => p.room === group)
    assert.ok(got, 'the group room pushed')
    assert.equal(got.title, '박도윤, 김민수 · 2')
    assert.equal(got.body, '박도윤: 오후 회의 자료예요\n김민수: 저도 봤어요')
  } finally {
    await q('delete from chat_rooms where id=$1', [group]).catch(() => {})
  }
})

test('PH-I-09 그 대화에서 다른 답을 쓰는 중이면 단추의 답은 보내지 않고, 알림과 Home 카드는 남는다', { skip: !up }, async () => {
  const { tid, card } = await asked(A)
  const n = await until(async () => (await notices(A)).find((x) => !x.is_checked && x.url.endsWith(card.id)))
  const token = PA.mintAction({ key: ASK.signingKey(), tenant: TENANT, userId: A.id, notice: n.id, card: card.id, answers: ['세 줄 요약', '표로 정리'] })
  const turns = []
  const busy = ASK.chatAnswerer({ runTurn: async (a) => { turns.push(a) }, sessionFor: async (email) => ({ user: { email }, session }), busy: () => [{ started: true }] })
  const r = await ASK.act({ token, answer: 1 }, { answerChat: busy })
  assert.equal(r.status, 409)
  assert.equal(r.error, '그 대화에서 다른 답을 쓰는 중이에요. 앱에서 답해 주세요.')
  assert.equal(turns.length, 0)
  assert.equal((await notices(A)).find((x) => x.id === n.id).is_checked, false)
  assert.ok((await notify.listFor(A)).some((x) => x.type === 'ai_ask' && x.url.endsWith(card.id)))
  // once the turn is over, the same button answers
  const free = ASK.chatAnswerer({ runTurn: async (a) => { turns.push(a) }, sessionFor: async (email) => ({ user: { email }, session }), busy: () => [] })
  assert.equal((await ASK.act({ token, answer: 1 }, { answerChat: free })).status, 200)
  assert.deepEqual(turns.map((t) => [t.threadId, t.text]), [[tid, '표로 정리']])
})
