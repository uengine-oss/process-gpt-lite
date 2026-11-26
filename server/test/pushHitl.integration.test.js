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
// 보안 검토 11-26(PR #89):
//   PH-I-10 단추의 답은 그 사람 자신의 세션으로 — users 의 이메일을 남의 주소로 바꿔도 남의 세션이 아니고, 남을 회사에 넣지 않는다; 다른
//           사람의 세션이 나오면 답하지 않는다
//   PH-I-11 잠금 화면의 한 번으로 결과가 큰 일은 하지 않는다: 파일 고르기 · 표시 없는 브라우저 · 채팅 질문은 「열기」(정해진 거절만 단추)
//   PH-I-12 답하다 실패하면(세션 · 작업) 알림 · Home 카드는 되돌아온다
//   PH-I-13 회사의 사람이 아니거나 내보낸 사람에게는 보내지도 받지도 않는다, 내보내면 그 사람의 기기 구독을 지운다
//   PH-I-14 푸시는 허용한 푸시 서비스 주소로만, 넘겨주기(redirect)는 따라가지 않는다
//   PH-I-15 알림은 이 회사의 사람에게만 만들고, 다시 시작할 때는 작업이 끝난 기다림의 알림만(회사 · 서버와 상관없이), Home 도 같은 규칙
// 재검토 11-26(PR #89):
//   PH-I-16 채팅 질문은 모델이 쓴 JSON 이라 quick · refusal 이 있어도 「열기」만, 채팅 질문의 토큰은 403
//   PH-I-17 public.users 의 이메일을 남의 것으로 바꾼 사람은 남의 방 줄 · 알림을 받지 못하고, 남의 알림에 답하지 못한다
//   PH-I-18 채팅 답의 턴이 내 메시지를 쓰기 전에 실패하면 알림은 다시 기다리고, 새 푸시는 없다
//   PH-I-19 세션은 이 서버가 맡은 회사의 계정일 때만
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
// the fake push service is the one push service this test lets the server reach (review 11-26 #6: only push services' hosts)
process.env.PRO_PUSH_ALLOW_ORIGINS = P.origin
const threads = []
async function thread(user, kind = 'project') {
  const [t] = await q(`insert into pro_threads(user_id,kind,title,conversation_id) values ($1,$2,'주간 회의 정리',$3) returning id`, [user.id, kind, `ph-${stamp}-${threads.length}`])
  threads.push(t.id)
  return t.id
}
const msgs = (tid) => q('select id, role, kind, content from pro_messages where thread_id=$1 order by created_at', [tid])
// (quick: the asker marks the choice as light — only then can a notification's button answer it, review 11-26 #2)
const HITL = JSON.stringify({ type: 'human_input_required', question: '어떤 형식으로 정리할까요?', context: '회의록 초안이 준비됐어요.', options: ['세 줄 요약', '표로 정리'], quick: true, run_state: {} })
// the agent asks in a project thread → {tid, card}
async function asked(user, hitl = HITL) {
  const tid = await thread(user)
  const n0 = streams.length
  const p = runTurn({ user, session, threadId: tid, text: '이번 주 회의록 정리해 줘' })
  const h = await nth(n0 + 1)
  h.push('message', { type: 'done', content: hitl }); h.end()
  const card = await p
  return { tid, card }
}
const notices = (user, type = 'ai_ask') => q(`select * from notifications where tenant_id=$1 and user_id = any($2) and type=$3 order by time_stamp`, [TENANT, [user.id, user.email], type])

if (up) {
  await q('insert into tenants (id) values ($1) on conflict do nothing', [TENANT])
  // real sign-in accounts (the feed matches a person by the auth server's own address, not public.users — review 11-26 #2)
  const { admin } = await import('../lib/supa.js')
  for (const u of [A, B]) {
    const { data, error } = await admin.auth.admin.createUser({ email: u.email, email_confirm: true })
    if (error) throw error
    u.id = data.user.id
  }
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
const OTHER = 'push-hitl-other' // another company on the same database (PH-I-13 · 15)
const extraUsers = [] // made by the review's tests
const authIds = [] // real sign-in accounts (PH-I-10)
const P2 = await startFakePush() // a server that is no push service (PH-I-14)
after(async () => {
  globalThis.fetch = realFetch
  if (up) {
    for (const t of [TENANT, OTHER]) {
      await q('delete from notifications where tenant_id=$1', [t]).catch(() => {})
      await q('delete from pro_push_subscriptions where tenant_id=$1', [t]).catch(() => {})
      await q('delete from pro_team_members where tenant_id=$1', [t]).catch(() => {})
      await q('delete from pro_team_removed where tenant_id=$1', [t]).catch(() => {})
    }
    if (threads.length) await q('delete from pro_threads where id = any($1)', [threads])
    for (const u of [A, B, ...extraUsers]) {
      await q('delete from pro_profile where user_id=$1', [u.id]).catch(() => {})
      await q('delete from users where id=$1', [u.id]).catch(() => {})
    }
    const { admin } = await import('../lib/supa.js')
    for (const id of [...authIds, A.id, B.id]) {
      await q('delete from users where id=$1', [id]).catch(() => {})
      await admin.auth.admin.deleteUser(id).catch(() => {})
    }
  }
  await P.close(); await P2.close()
  await pool.end()
  const { closeOntology } = await import('../lib/ontology/store.js').catch(() => ({}))
  await closeOntology?.().catch(() => {})
})

let first // PH-I-01's question, answered in PH-I-03

test('PH-I-01 에이전트가 묻고 멈추면: 답에 질문 · 보기, ai_ask 알림 한 줄, Home 카드는 그 프로젝트에서 연다', { skip: !up }, async () => {
  first = await asked(A)
  assert.deepEqual(first.card.content.ask, { question: '어떤 형식으로 정리할까요?', options: ['세 줄 요약', '표로 정리'], quick: true })
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

test('PH-I-02 피드 → 푸시: 채팅 질문은 「열기」만, 방은 하나로 묶고, 멘션은 따로, 내가 보낸 것 · 다른 사람 것은 없다', { skip: !up }, async () => {
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
  // (a chat question: 「열기」 only and no token, whatever its JSON marks — re-review 11-26 #1)
  assert.deepEqual(ask.actions, [{ action: 'open', title: '열기' }])
  assert.equal(ask.token, undefined)
  assert.equal(ask.tag, `pgl-ask-${first.card.id}`)
  assert.equal(ask.place, `/projects/${first.tid}`)
  assert.equal(ask.requireInteraction, true)
  assert.doesNotMatch(JSON.stringify(ask), /test-token|access_token/)
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
})

test('PH-I-03 알림의 단추로 답하면(브라우저 작업의 가벼운 질문) 그 보기로 한 번 답하고, 같은 토큰은 다시 쓰지 못한다', { skip: !up }, async () => {
  // a browser task's pick-one its code marked light (quick); the task is live (its answer is taken)
  const c = await card(A, 'choice', { site: 'notes.example', question: '어느 노트에 넣을까요?', options: ['회의록', '할 일'], quick: true })
  const p = await ASK.askPayload(c.n, A.id)
  assert.deepEqual(p.actions, [{ action: 'a0', title: '회의록' }, { action: 'a1', title: '할 일' }])
  const v = PA.verifyAction(p.token, { key: ASK.signingKey() })
  assert.deepEqual({ u: v.claims.u, c: v.claims.c, a: v.claims.a }, { u: A.id, c: c.cardId, a: ['회의록', '할 일'] })
  const taken = []
  const answerTask = async (userId, cardId, label) => { taken.push([userId, cardId, label]); await q(`update pro_messages set content = content || '{"state":"answered"}'::jsonb where id=$1`, [cardId]); return true }
  const r = await ASK.act({ token: p.token, answer: 0 }, { answerTask, answerChat: async () => assert.fail('not a chat') })
  assert.equal(r.status, 200, JSON.stringify(r))
  assert.equal(r.answered, '회의록')
  assert.equal(r.said, '「회의록」으로 답했어요')
  assert.equal(r.place, '/chat')
  assert.deepEqual(taken, [[A.id, c.cardId, '회의록']])
  assert.equal((await q('select is_checked from notifications where id=$1', [c.n.id]))[0].is_checked, true)
  assert.equal((await notify.listFor(A)).some((n) => n.id === c.n.id), false)
  // the same token again (a second tap, another device): used
  const again = await ASK.act({ token: p.token, answer: 1 }, { answerTask })
  assert.equal(again.status, 409)
  assert.equal(taken.length, 1)
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

test('PH-I-05 채팅에 직접 답하면 그 대화의 질문 알림은 확인되고, 채팅 질문의 토큰은 아무것도 답하지 않는다', { skip: !up }, async () => {
  const n = (await notices(A)).filter((x) => !x.is_checked).at(-1)
  const at = ASK.parseAskUrl(n.url)
  const token = PA.mintAction({ key: ASK.signingKey(), tenant: TENANT, userId: A.id, notice: n.id, card: at.cardId, answers: ['세 줄 요약', '표로 정리'] })
  const n0 = streams.length
  const p = runTurn({ user: A, session, threadId: at.threadId, text: '표로 정리해 줘' })
  const h = await nth(n0 + 1)
  assert.equal((await until(async () => (await notices(A)).find((x) => x.id === n.id && x.is_checked))).is_checked, true)
  h.push('message', { type: 'token', content: '표로 정리했어요.' }); h.end()
  await p
  assert.equal((await notify.listFor(A)).some((x) => x.id === n.id), false)
  const turns = []
  const answerChat = ASK.chatAnswerer({ runTurn: async (a) => { turns.push(a) }, sessionFor: async (email) => ({ user: { email }, session }), sessionOf: async (id) => ({ user: { id }, session }), busy: () => [] })
  assert.equal((await ASK.act({ token, answer: 0 }, { answerChat })).status, 403)
  assert.equal(turns.length, 0)
  // (a question the person already answered in the chat is not waiting, even if its notice were still up)
  assert.equal(await ASK.stillWaiting(at), false)
})

test('PH-I-06 브라우저 작업의 승인 카드: 알림은 「열기」 · 「취소」뿐, 승인은 카드에서만', { skip: !up }, async () => {
  const tid = await thread(A, 'chat')
  const [card] = await q(`insert into pro_messages(thread_id,role,kind,content) values ($1,'agent','choice',$2) returning id`,
    [tid, { site: 'shop.example', approval: true, question: '장바구니 49,000원 결제', options: ['승인', '취소'], refusal: '취소', taskId: crypto.randomUUID(), state: 'pending' }])
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
  const asking = { card: card.id, kind: 'choice', approval: true, options: ['승인', '취소'], refusal: '취소' }
  assert.equal(canAnswerCard(asking, card.id, '승인'), false)
  assert.equal(canAnswerCard(asking, card.id, '취소'), true)
  assert.equal(canAnswerCard({ ...asking, approval: false, quick: true }, card.id, '승인'), true)
  assert.equal(canAnswerCard(asking, crypto.randomUUID(), '취소'), false, 'another card')
  assert.equal(canAnswerCard({ ...asking, vault: true }, card.id, '취소'), false, 'a vault card')
  assert.equal(canAnswerCard({ ...asking, kind: 'vault' }, card.id, '취소'), false)
  assert.equal(canAnswerCard({ ...asking, approval: false, quick: true }, card.id, '다른 말'), false, 'not one of its options')
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
  assert.equal((await notify.listFor(A)).some((x) => x.id === lid || x.id === id), false)
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

test('PH-I-09 그 대화에서 다른 답을 쓰는 중이면 채팅 답(알림에서)은 보내지 않는다 — 끝나면 보낸다', { skip: !up }, async () => {
  const { tid, card: c } = await asked(A)
  const thread0 = (await q('select * from pro_threads where id=$1', [tid]))[0]
  const turns = []
  const mint = async (id) => ({ user: { id, email: A.email }, session })
  const busy = ASK.chatAnswerer({ runTurn: async (a) => { turns.push(a) }, sessionOf: mint, busy: () => [{ started: true }] })
  assert.equal(await busy({ id: A.id, name: A.name }, thread0, c.id, '표로 정리'), false)
  assert.equal(turns.length, 0)
  const free = ASK.chatAnswerer({ runTurn: async (a) => { turns.push(a) }, sessionOf: mint, busy: () => [] })
  assert.equal(await free({ id: A.id, name: A.name }, thread0, c.id, '표로 정리'), true)
  await until(() => turns.length)
  assert.deepEqual(turns.map((t) => [t.threadId, t.text]), [[tid, '표로 정리']])
})

// ---------- 보안 검토 11-26 (PR #89) ----------
const jwtSub = (t) => JSON.parse(Buffer.from(String(t).split('.')[1], 'base64url').toString()).sub
const tokenFor = (user, n, cardId, answers) => PA.mintAction({ key: ASK.signingKey(), tenant: TENANT, userId: user.id, notice: n.id, card: cardId, answers })
const noticeOf = (user, cardId) => until(async () => (await notices(user)).find((x) => !x.is_checked && x.url.endsWith(cardId)))
// a person of this company (a users row here), with a Lite profile
async function person(tag, name, tenant = TENANT) {
  const u = { id: crypto.randomUUID(), email: `pro-push-hitl-${tag}-${stamp}@people-mail.test`, name }
  await q('insert into tenants (id) values ($1) on conflict do nothing', [tenant])
  await q(`insert into users (id, email, username, tenant_id) values ($1,$2,$3,$4)`, [u.id, u.email, name, tenant])
  await q(`insert into pro_profile(user_id,name,email) values ($1,$2,$3) on conflict (user_id) do nothing`, [u.id, name, u.email])
  extraUsers.push(u)
  return u
}
// a waiting card the test writes itself (as lib/browser.js waitForUser · lib/agent.js would) → {tid, cardId, n}
async function card(user, kind, content, { via = 'task', threadKind = 'chat' } = {}) {
  const tid = await thread(user, threadKind)
  const [m] = await q(`insert into pro_messages(thread_id,role,kind,content) values ($1,'agent',$2,$3) returning id`, [tid, kind, { state: 'pending', ...content }])
  const id = await ASK.ask(user.id, { via, threadId: tid, cardId: m.id, kind: 'question', text: content.question || '' })
  const [n] = id ? await q('select * from notifications where id=$1', [id]) : [null]
  return { tid, cardId: m.id, n }
}

test('PH-I-10 채팅 답의 턴은 그 사람 자신의 세션으로 — users 의 이메일을 바꿔도 남의 세션이 아니고, 남을 회사에 넣지도 않는다', { skip: !up }, async () => {
  const { admin } = await import('../lib/supa.js')
  const account = async (tag) => {
    const { data, error } = await admin.auth.admin.createUser({ email: `pro-push-hitl-${tag}-${stamp}@people-mail.test`, email_confirm: true })
    if (error) throw error
    authIds.push(data.user.id)
    return data.user
  }
  const atk = await account('atk'), vic = await account('vic')
  // a member whose own users row (Process GPT lets a person update it) names the victim's address; the victim is not in this company
  await q(`insert into users (id, email, username, tenant_id) values ($1,$2,'유도현',$3)`, [atk.id, vic.email, TENANT])
  const { tid, card: c } = await asked({ id: atk.id, email: atk.email, name: '유도현' })
  const thread0 = (await q('select * from pro_threads where id=$1', [tid]))[0]
  const seen = []
  // (the answerer's own session minter: lib/supa.js sessionOfUser — by the account id)
  const answer = ASK.chatAnswerer({ runTurn: async (a) => { seen.push(a) }, busy: () => [] })
  assert.equal(await answer({ id: atk.id, name: '유도현' }, thread0, c.id, '세 줄 요약'), true)
  await until(() => seen.length)
  assert.equal(jwtSub(seen[0].session.access_token), atk.id, "the turn runs in the asker's own session")
  assert.deepEqual({ id: seen[0].user.id, email: seen[0].user.email, thread: seen[0].threadId }, { id: atk.id, email: atk.email, thread: tid })
  assert.equal((await q('select 1 from users where id=$1 and tenant_id=$2', [vic.id, TENANT])).length, 0, 'the victim was not put into this company')
  // a minter that hands back someone else's session: nothing is run
  const second = await asked({ id: atk.id, email: atk.email, name: '유도현' })
  const t2 = (await q('select * from pro_threads where id=$1', [second.tid]))[0]
  const wrong = async () => ({ user: { id: vic.id, email: vic.email }, session: { access_token: 'x' } })
  await assert.rejects(ASK.chatAnswerer({ runTurn: async (a) => { seen.push(a) }, sessionOf: wrong, busy: () => [] })({ id: atk.id, name: '유도현' }, t2, second.card.id, '세 줄 요약'))
  assert.equal(seen.length, 1)
})

test('PH-I-11 잠금 화면의 한 번으로 결과가 큰 일은 하지 않는다 — 파일 고르기 · 표시 없는 질문은 「열기」, 정해진 거절만 단추', { skip: !up }, async () => {
  const open = [{ action: 'open', title: '열기' }]
  // a file to upload to an outside site, picked on the card (lib/browser.js files: true): an approval, open only
  const f = await card(A, 'choice', { files: true, site: 'shop.example', question: '올릴 파일 고르기', options: ['견적서.pdf', '계약서.docx'] })
  const fp = await ASK.askPayload(f.n, A.id)
  assert.equal(fp.kind, 'approval')
  assert.deepEqual(fp.actions, open)
  assert.equal(fp.token, undefined)
  // the browser agent's own pick-one (need_user) — nobody marked it light: open only
  const u = await card(A, 'choice', { site: 'mail.example', question: '보낼까요?', options: ['보내기', '취소'] })
  assert.deepEqual((await ASK.askPayload(u.n, A.id)).actions, open)
  // the chat agent's question without the asker's mark: open only; with its refusal named: that one
  const plain = await asked(A, JSON.stringify({ type: 'human_input_required', question: '이 메일을 보낼까요?', options: ['보내기', '취소'] }))
  assert.deepEqual(plain.card.content.ask, { question: '이 메일을 보낼까요?', options: ['보내기', '취소'] })
  const pn = await noticeOf(A, plain.card.id)
  assert.deepEqual((await ASK.askPayload(pn, A.id)).actions, open)
  // (a refusal named in a chat question's JSON changes nothing: the model wrote it — PH-I-16); a browser card that names it: that one
  const refusing = await card(A, 'choice', { site: 'mail.example', question: '이 메일을 보낼까요?', options: ['보내기', '취소'], refusal: '취소' })
  const rp = await ASK.askPayload(refusing.n, A.id)
  assert.deepEqual(rp.actions, [...open, { action: 'a0', title: '취소' }])
  assert.deepEqual(PA.verifyAction(rp.token, { key: ASK.signingKey() }).claims.a, ['취소'])
  // the task itself takes only what its card allows from outside it
  const base = { card: f.cardId, kind: 'choice' }
  assert.equal(canAnswerCard({ ...base, files: true, options: ['견적서.pdf', '계약서.docx'] }, f.cardId, '견적서.pdf'), false, 'a file pick')
  assert.equal(canAnswerCard({ ...base, files: true, quick: true, options: ['견적서.pdf'] }, f.cardId, '견적서.pdf'), false, 'a file pick, even marked')
  assert.equal(canAnswerCard({ ...base, options: ['보내기', '취소'] }, f.cardId, '보내기'), false, 'not marked light')
  assert.equal(canAnswerCard({ ...base, options: ['보내기', '취소'], refusal: '취소' }, f.cardId, '취소'), true, 'its refusal')
  assert.equal(canAnswerCard({ ...base, options: ['보내기', '취소'], refusal: '취소' }, f.cardId, '보내기'), false)
  assert.equal(canAnswerCard({ ...base, options: ['보내기', '취소'], refusal: '보내기' }, f.cardId, '보내기'), false, 'a "refusal" that is the first (going-ahead) option')
  assert.equal(canAnswerCard({ ...base, approval: true, options: ['승인', '취소'] }, f.cardId, '취소'), false, 'an approval without its refusal named')
  assert.equal(canAnswerCard({ ...base, options: ['세 줄 요약', '표로 정리'], quick: true }, f.cardId, '표로 정리'), true)
})

test('PH-I-12 답하다 실패하면(세션 · 작업) 알림과 Home 카드는 되돌아온다', { skip: !up }, async () => {
  const { card: c } = await asked(A)
  const n = await noticeOf(A, c.id)
  const down = async () => { throw new Error('auth server down') }
  const r = await ASK.act({ token: tokenFor(A, n, c.id, ['세 줄 요약']), answer: 0 },
    { answerChat: ASK.chatAnswerer({ runTurn: async () => assert.fail('no turn'), sessionFor: down, sessionOf: down, busy: () => [] }) }).catch((e) => ({ thrown: e.message }))
  assert.equal(r.thrown, undefined, 'answered with a status, not thrown')
  assert.notEqual(r.status, 200)
  assert.equal((await q('select is_checked from notifications where id=$1', [n.id]))[0].is_checked, false)
  assert.ok((await notify.listFor(A)).some((x) => x.id === n.id))
  // a browser task's answer that fails (the task lives in another server's memory): the same
  const t = await card(A, 'choice', { site: 'shop.example', question: '어느 계정으로 할까요?', options: ['개인', '회사'], quick: true })
  const r2 = await ASK.act({ token: tokenFor(A, t.n, t.cardId, ['개인']), answer: 0 }, { answerTask: async () => { throw new Error('not here') } }).catch((e) => ({ thrown: e.message }))
  assert.equal(r2.thrown, undefined)
  assert.notEqual(r2.status, 200)
  assert.equal((await q('select is_checked from notifications where id=$1', [t.n.id]))[0].is_checked, false)
})

test('PH-I-13 회사의 사람이 아니거나 내보낸 사람에게는 보내지도 받지도 않는다 — 내보내면 기기 구독도 지운다', { skip: !up }, async () => {
  const team = await import('../lib/team.js')
  // someone of another company whose subscription row says this one (left from before): nothing is sent
  const outsider = await person('out', '서지안', OTHER)
  const so = P.subscription('out')
  await q(`insert into pro_push_subscriptions(endpoint, user_id, tenant_id, p256dh, auth, ua) values ($1,$2,$3,$4,$5,'test')`, [so.endpoint, outsider.id, TENANT, so.keys.p256dh, so.keys.auth])
  assert.equal(await webpush.pushTo(outsider.id, { id: 'x-out', title: '시험' }), 0)
  // a member, then removed by an administrator
  const R = await person('rm', '오세린')
  const sr = P.subscription('rm')
  await q(`insert into pro_push_subscriptions(endpoint, user_id, tenant_id, p256dh, auth, ua) values ($1,$2,$3,$4,$5,'test')`, [sr.endpoint, R.id, TENANT, sr.keys.p256dh, sr.keys.auth])
  const c = await card(R, 'choice', { site: 'shop.example', question: '어느 쪽?', options: ['가', '나'], quick: true })
  await team.removeMember(R.id, A.id)
  assert.equal((await q('select 1 from pro_push_subscriptions where user_id=$1', [R.id])).length, 0, 'their devices are forgotten')
  const r = await ASK.act({ token: tokenFor(R, c.n, c.cardId, ['가']), answer: 0 }, { answerTask: async () => true })
  assert.equal(r.status, 403)
  // the feed sends a removed person nothing (a notice written for them anyway)
  await q(`insert into pro_push_subscriptions(endpoint, user_id, tenant_id, p256dh, auth, ua) values ($1,$2,$3,$4,$5,'test')`, [sr.endpoint, R.id, TENANT, sr.keys.p256dh, sr.keys.auth])
  await notify.feedOnce()
  await q(`insert into notifications(id,user_id,title,type,description,url,tenant_id) values (gen_random_uuid(),$1,'내보낸 뒤의 알림','team','',$2,$3)`, [R.id, `/pro/team/${ROOM}/${crypto.randomUUID()}`, TENANT])
  await notify.feedOnce()
  assert.equal((await P.payloads('rm', 1, 400)).length, 0)
  assert.equal((await P.payloads('out', 1, 10)).length, 0)
})

test('PH-I-14 푸시는 허용한 푸시 서비스 주소로만, 넘겨주기는 따라가지 않는다', { skip: !up }, async () => {
  const B2 = await person('b2', '하도윤')
  // a subscription row pointing at a server that is no push service (written straight into the table)
  const bad = P2.subscription('inside')
  await q(`insert into pro_push_subscriptions(endpoint, user_id, tenant_id, p256dh, auth, ua) values ($1,$2,$3,$4,$5,'test')`, [bad.endpoint, B2.id, TENANT, bad.keys.p256dh, bad.keys.auth])
  // and one at the (allowed) fake push service that answers 302 to that server
  const hop = P.subscription('hop')
  const hopEndpoint = P.redirect('hop', `${P2.origin}/push/inside`)
  await q(`insert into pro_push_subscriptions(endpoint, user_id, tenant_id, p256dh, auth, ua) values ($1,$2,$3,$4,$5,'test')`, [hopEndpoint, B2.id, TENANT, hop.keys.p256dh, hop.keys.auth])
  await webpush.pushTo(B2.id, { id: 'x-ssrf', title: '시험' })
  assert.deepEqual(P2.requests, [], 'nothing reached the server that is no push service')
  assert.equal((await q('select 1 from pro_push_subscriptions where endpoint=$1', [bad.endpoint])).length, 0, 'the bad row is dropped')
})

test('PH-I-15 알림은 이 회사의 사람에게만 만들고, 다시 시작할 때는 작업이 끝난 기다림의 알림만 지운다(회사 · 서버와 상관없이)', { skip: !up }, async () => {
  // a users row in another company only: no notice here
  const O = await person('oth', '문예린', OTHER)
  const tid = await thread(O, 'chat')
  const [m] = await q(`insert into pro_messages(thread_id,role,kind,content) values ($1,'agent','choice',$2) returning id`, [tid, { state: 'pending', question: '어느 쪽?', options: ['가', '나'] }])
  assert.equal(await ASK.ask(O.id, { via: 'task', threadId: tid, cardId: m.id, kind: 'question', text: '어느 쪽?' }), null)
  assert.equal((await q(`select 1 from notifications where user_id=$1 and type='ai_ask'`, [O.id])).length, 0)
  // two browser tasks of this company: one still waits on the person (another server's — its task card says so), one whose task is over;
  // and one of another company whose task is over. A restart checks off what is over, wherever it is, and nothing that still waits
  const mk = async (user, tenant, state, title) => {
    const th = await thread(user, 'chat')
    const [task] = await q(`insert into pro_messages(thread_id,role,kind,content) values ($1,'agent','task',$2) returning id`, [th, { state, title }])
    const [c] = await q(`insert into pro_messages(thread_id,role,kind,content) values ($1,'agent','choice',$2) returning id`, [th, { state: 'pending', question: title, options: ['가', '나'], taskId: task.id }])
    const [n] = await q(`insert into notifications(id,user_id,title,type,description,url,tenant_id) values (gen_random_uuid(),$1,$2,'ai_ask','',$3,$4) returning id`,
      [user.id, title, `/pro/ask/task/${th}/${c.id}`, tenant])
    return n.id
  }
  const live = await mk(A, TENANT, 'needs_input', '아직 기다림')
  const over = await mk(A, TENANT, 'failed', '끝난 작업')
  const there = await mk(O, OTHER, 'failed', '다른 회사의 끝난 작업')
  await ASK.resetTaskAsks()
  const checked = async (id) => (await q('select is_checked from notifications where id=$1', [id]))[0].is_checked
  assert.equal(await checked(live), false, 'a task still waiting keeps its notice')
  assert.equal(await checked(over), true)
  assert.equal(await checked(there), true, 'over is over, whichever company')
  // the Home drops a wait whose task is over even before any restart, and keeps the one that still waits
  await mk(A, TENANT, 'failed', '끝난 작업 2')
  const home = (await notify.listFor(A)).filter((x) => x.type === 'ai_ask').map((x) => x.title)
  assert.ok(home.includes('아직 기다림'), JSON.stringify(home))
  assert.equal(home.includes('끝난 작업 2'), false, JSON.stringify(home))
})

test('PH-I-16 채팅 질문의 알림에는 답하는 단추가 없다 — 모델이 quick · refusal 을 써도, 토큰이 있어도', { skip: !up }, async () => {
  // the model's own final text can be any JSON: an injected page makes it end with a "question" that sends a quote to a customer
  const injected = JSON.stringify({ type: 'human_input_required', question: '견적서를 고객에게 보낼까요?', options: ['보내기', '보류'], quick: true })
  const { card: c } = await asked(A, injected)
  const n = await noticeOf(A, c.id)
  const p = await ASK.askPayload(n, A.id)
  assert.deepEqual(p.actions, [{ action: 'open', title: '열기' }])
  assert.equal(p.token, undefined)
  const refusing = await asked(A, JSON.stringify({ type: 'human_input_required', question: '견적서를 고객에게 보낼까요?', options: ['보내기', '보류'], refusal: '보내기' }))
  const rn = await noticeOf(A, refusing.card.id)
  assert.deepEqual((await ASK.askPayload(rn, A.id)).actions, [{ action: 'open', title: '열기' }])
  // a token for a chat question (were one ever minted) answers nothing; the notice still waits
  const calls = []
  const r = await ASK.act({ token: tokenFor(A, n, c.id, ['보내기']), answer: 0 },
    { answerChat: async (...a) => { calls.push(a); return true }, answerTask: async (...a) => { calls.push(a); return true } })
  assert.equal(r.status, 403)
  assert.equal(calls.length, 0)
  assert.equal((await q('select is_checked from notifications where id=$1', [n.id]))[0].is_checked, false)
})

test('PH-I-17 public.users 의 이메일을 남의 것으로 바꿔도 남의 알림 · 방의 줄을 받지 못하고, 남의 알림에 답하지 못한다', { skip: !up }, async () => {
  const { admin } = await import('../lib/supa.js')
  const { data, error } = await admin.auth.admin.createUser({ email: `pro-push-hitl-spoof-${stamp}@people-mail.test`, email_confirm: true })
  if (error) throw error
  const M = { id: data.user.id, email: data.user.email, name: '노지후' }
  authIds.push(M.id)
  // a member whose own users row names A's address
  await q(`insert into users (id, email, username, tenant_id) values ($1,$2,$3,$4)`, [M.id, A.email, M.name, TENANT])
  const sm = P.subscription('spoof')
  await q(`insert into pro_push_subscriptions(endpoint, user_id, tenant_id, p256dh, auth, ua) values ($1,$2,$3,$4,$5,'test')`, [sm.endpoint, M.id, TENANT, sm.keys.p256dh, sm.keys.auth])
  const room = `push-spoof-${stamp}`
  await notify.feedOnce()
  await q(`insert into notifications(id,user_id,title,type,description,url,from_user_id,tenant_id) values (gen_random_uuid(),$1,'계약 단가는 1,200원으로 해요','chat','영업팀',$2,'김민수',$3)`,
    [A.email, `/chats?id=${room}`, TENANT])
  await notify.feedOnce()
  // A hears it; the spoofer does not (the feed sends without waiting: looked for until it comes)
  assert.ok(await until(() => P.received.some((x) => x.who === 'a' && x.payload.room === room), 10000), 'A hears it')
  assert.equal((await P.payloads('spoof', 1, 600)).length, 0)
  // a notice that names A by address (an older kind of row) is not answered with the spoofer's token
  const th = await thread({ id: M.id }, 'chat')
  const [cd] = await q(`insert into pro_messages(thread_id,role,kind,content) values ($1,'agent','choice',$2) returning id`, [th, { state: 'pending', question: '어느 쪽?', options: ['가', '나'], quick: true }])
  const [n] = await q(`insert into notifications(id,user_id,title,type,description,url,tenant_id) values (gen_random_uuid(),$1,'질문','ai_ask','',$2,$3) returning *`,
    [A.email, `/pro/ask/task/${th}/${cd.id}`, TENANT])
  const r = await ASK.act({ token: tokenFor(M, n, cd.id, ['가']), answer: 0 }, { answerTask: async () => true })
  assert.equal(r.status, 403)
})

test('PH-I-18 알림에서 보낸 채팅 답의 턴이 내 메시지를 쓰기 전에 실패하면 알림은 다시 기다리고, 새 푸시는 없다', { skip: !up }, async () => {
  const { card: c } = await asked(A)
  const n = await noticeOf(A, c.id)
  // its one push
  await notify.feedOnce()
  const pushes = () => P.received.filter((x) => x.who === 'a' && x.payload.card === c.id).length
  assert.ok(await until(() => pushes() === 1, 10000))
  const thread0 = (await q('select * from pro_threads where id=(select thread_id from pro_messages where id=$1)', [c.id]))[0]
  // (as act would: the notice is used up, then the answerer runs)
  await q('update notifications set is_checked=true where id=$1', [n.id])
  const answer = ASK.chatAnswerer({ runTurn: async () => { throw new Error('deepagents is down') }, sessionOf: async (id) => ({ user: { id, email: A.email }, session }), busy: () => [] })
  assert.equal(await answer({ id: A.id, name: A.name }, thread0, c.id, '세 줄 요약', { notice: n.id }), true)
  const back = await until(async () => (await q('select is_checked from notifications where id=$1', [n.id]))[0].is_checked === false)
  assert.equal(back, true, 'the notice waits again')
  await notify.feedOnce()
  await new Promise((ok) => setTimeout(ok, 600))
  assert.equal(pushes(), 1, 'nothing pushed again')
})

test('PH-I-19 그 사람의 세션은 이 서버가 맡은 회사의 계정일 때만', { skip: !up }, async () => {
  const { sessionOfUser } = await import('../lib/supa.js')
  // (one company on this test server: what a server of several companies would say is given)
  await assert.rejects(sessionOfUser(A.id, { multi: () => true, tenantOf: () => 'push-hitl-elsewhere' }), (e) => e.status === 403)
  const ok = await sessionOfUser(A.id, { multi: () => true, tenantOf: () => TENANT })
  assert.equal(ok.user.id, A.id)
})
