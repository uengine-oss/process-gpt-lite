// 메시지 메뉴 HTTP E2E: 실제 BFF·실제 DB·실제 에이전트. spec pgpt-pro_message-actions
//   API_URL=http://localhost:8793 node test/message-actions.e2e.mjs   (BFF: PRO_BACKGROUND=0, 데모 로그인 코드 000000)
// 실제 모델이 답하는 단계는 내용 대신 구조와, 인용으로만 알 수 있는 코드 하나로 판단한다.
import assert from 'node:assert/strict'
import { q, pool } from '../lib/supa.js'
import { replyOf } from '../lib/messageActions.js'

const API = process.env.API_URL || 'http://localhost:8793'
const CODE = process.env.PGPT_LOGIN_CODE || '000000'
const SECRET_CODE = 'BX-4471'
const OTHER_SECRET = 'QZ-9023'
const FILLERS = 14 // more than the 12 rows a turn reads back, so only the quote can bring the code

let n = 0
async function step(name, fn) {
  n++
  try { await fn(); console.log(`ok ${n} - ${name}`) } catch (e) { console.log(`not ok ${n} - ${name}\n  ${e.message}`); await cleanup(); process.exit(1) }
}
async function login(email) {
  const r = await fetch(`${API}/api/auth/email/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, code: CODE }) })
  assert.equal(r.status, 200, `login ${email}: ${r.status}`)
  const s = await r.json()
  const token = s.session.access_token
  const call = async (method, path, body) => {
    const res = await fetch(`${API}/api${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* not JSON */ }
    return { status: res.status, body: json, text }
  }
  await call('POST', '/profile', { name: email.split('@')[0], birth: '1990-01-01', onboarded: true })
  return { id: s.user.id, email, token, call }
}
async function threadOf(u) {
  const [t] = await q(`select id from pro_threads where user_id=$1 and kind='chat' order by created_at limit 1`, [u.id])
  if (t) return t.id
  const [c] = await q(`insert into pro_threads(user_id,kind,title) values ($1,'chat','채팅') returning id`, [u.id])
  return c.id
}
const addRow = async (th, role, kind, content, ago) => (await q(`insert into pro_messages(thread_id,role,kind,content,created_at) values ($1,$2,$3,$4, now() - ($5 || ' seconds')::interval) returning *`, [th, role, kind, content, String(ago)]))[0]
// sends like the page and waits for the stream to end
async function send(u, th, text, extra = {}) {
  const r = await fetch(`${API}/api/threads/${th}/messages`, { method: 'POST', headers: { Authorization: `Bearer ${u.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ text, ...extra }), signal: AbortSignal.timeout(300_000) })
  assert.equal(r.status, 200, `send: ${r.status}`)
  await r.text()
  const rows = await q(`select * from pro_messages where thread_id=$1 order by created_at`, [th])
  const i = rows.findLastIndex((m) => m.role === 'user' && m.kind === 'text' && m.content?.text === text)
  assert.ok(i >= 0, `the message "${text}" was not saved`)
  const answer = rows.slice(i + 1).find((m) => m.role === 'agent' && ['text', 'doc'].includes(m.kind))
  return { said: rows[i], answer }
}
async function cleanup() {
  for (const u of [a, b].filter(Boolean)) {
    const th = await threadOf(u)
    await q('delete from pro_messages where thread_id=$1', [th])
    await q('update pro_threads set conversation_id=null, status=null where id=$1', [th])
    await q('delete from context_threads where user_id=$1', [u.id])
  }
}

let a, b, thA, thB, original, mineB, conv
await step('두 사람이 로그인한다', async () => {
  a = await login('pro-ma-a@uengine.org'); b = await login('pro-ma-b@uengine.org')
  await cleanup()
  thA = await threadOf(a); thB = await threadOf(b)
})
await step('A 의 대화에 코드가 든 답과, 그 뒤 잡담이 많이 쌓여 있다', async () => {
  conv = `ma-conv-${Date.now().toString(36)}`
  original = await addRow(thA, 'agent', 'text', { text: `이번 사업비 코드는 ${SECRET_CODE} 이에요. 이대로 세 분께 보낼까요?`, context: { title: '사업비 메일', conversationId: conv, action: 'new' } }, 600)
  for (let i = 0; i < FILLERS; i++) await addRow(thA, i % 2 ? 'agent' : 'user', 'text', { text: `날씨 이야기 ${i}` }, 500 - i)
  mineB = await addRow(thB, 'agent', 'text', { text: `다른 사람의 비밀 코드는 ${OTHER_SECRET} 입니다` }, 400)
})
await step('답장 없이 코드를 물으면 에이전트는 코드를 모른다(대조군)', async () => {
  const { said, answer } = await send(a, thA, '아까 그 사업비 코드 다시 한 번만 알려 줘')
  assert.equal(said.content.replyUuid, undefined)
  assert.ok(answer, 'no answer')
  assert.ok(!answer.content.text.includes(SECRET_CODE), `control answer already knows the code: ${answer.content.text.slice(0, 200)}`)
})
await step('남의 메시지 ID 로 답장해도 인용되지 않고, 말은 보통 메시지로 간다', async () => {
  const { said, answer } = await send(a, thA, '이 코드 다시 알려 줘', { replyTo: mineB.id })
  assert.equal(said.content.replyUuid, undefined, 'a message of another person was quoted')
  assert.equal(said.content.replyContent, undefined)
  assert.ok(!JSON.stringify(answer?.content || {}).includes(OTHER_SECRET), 'the answer leaked another person\'s words')
})
await step('A 가 그 답에 답장하면, 서버가 읽은 원문이 인용으로 남는다', async () => {
  const { said, answer } = await send(a, thA, '여기 나온 코드만 그대로 다시 알려 줘', { replyTo: original.id, replyContent: '페이지가 보낸 가짜 인용' })
  assert.equal(said.content.replyUuid, original.id)
  assert.equal(said.content.replyContent, original.content.text)
  assert.equal(said.content.replyRole, 'agent')
  assert.ok(answer, 'no answer')
  // 인용으로만 알 수 있는 코드
  assert.ok(answer.content.text.includes(SECRET_CODE), `the answer does not know the quoted code: ${answer.content.text.slice(0, 300)}`)
  // 그 메시지의 대화로 이어진다
  assert.equal(answer.content.context?.conversationId, conv, `answered in ${JSON.stringify(answer.content.context)}`)
  assert.equal(answer.content.context?.strategy, 'pinned')
})
await step('인용 판단: 다른 스레드·형식 오류·파일 카드·빈 글은 인용하지 않는다', async () => {
  assert.equal(await replyOf(thA, mineB.id), null)
  assert.equal(await replyOf(thA, 'not-a-uuid'), null)
  assert.equal(await replyOf(thA, '00000000-0000-4000-8000-000000000000'), null)
  const file = await addRow(thA, 'agent', 'file', { name: '견적.xlsx' }, 100)
  assert.equal(await replyOf(thA, file.id), null)
  const empty = await addRow(thA, 'agent', 'text', { text: '   ' }, 90)
  assert.equal(await replyOf(thA, empty.id), null)
})
await step('사람 자기 말에도 답장할 수 있고, 긴 글은 잘라 인용한다', async () => {
  const mine = await addRow(thA, 'user', 'text', { text: '내가 쓴 말' }, 80)
  assert.equal((await replyOf(thA, mine.id)).fields.replyRole, 'user')
  const long = await addRow(thA, 'agent', 'doc', { text: `# 제목\n${'가'.repeat(3000)}` }, 70)
  const r = await replyOf(thA, long.id)
  assert.equal(r.fields.replyContent.length, 2001)
  assert.ok(r.fields.replyContent.endsWith('…'))
})
await step('👍 를 누르면 저장되고, 👎 로 바꾸고, null 로 거둔다', async () => {
  for (const value of ['up', 'down', null]) {
    const r = await a.call('POST', `/messages/${original.id}/feedback`, { value })
    assert.equal(r.status, 200, r.text)
    assert.equal(r.body.content.feedback, value)
    const [row] = await q('select content from pro_messages where id=$1', [original.id])
    assert.equal(row.content.feedback, value)
    assert.equal(row.content.text, original.content.text, 'the rating changed the words')
  }
})
await step('평가 거절: 남의 답 404, 사람 말 400, 없는 값 400, 형식 오류 404, 로그인 없음 401', async () => {
  assert.equal((await b.call('POST', `/messages/${original.id}/feedback`, { value: 'up' })).status, 404)
  const mine = await addRow(thA, 'user', 'text', { text: '사람 말' }, 60)
  assert.equal((await a.call('POST', `/messages/${mine.id}/feedback`, { value: 'up' })).status, 400)
  assert.equal((await a.call('POST', `/messages/${original.id}/feedback`, { value: 'great' })).status, 400)
  assert.equal((await a.call('POST', '/messages/nope/feedback', { value: 'up' })).status, 404)
  const anon = await fetch(`${API}/api/messages/${original.id}/feedback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"value":"up"}' })
  assert.equal(anon.status, 401)
  const [row] = await q('select content from pro_messages where id=$1', [original.id])
  assert.equal(row.content.feedback, null, 'a refused rating was saved')
})
await step('정리한다', cleanup)
console.log(`1..${n}\n# pass ${n}`)
await pool.end()
process.exit(0)
