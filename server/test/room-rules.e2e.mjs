// 방 규칙 HTTP E2E: 실제 BFF·실제 DB·실제 모델·실제 Chromium. spec pgpt-pro_room-rules
//   API_URL=http://localhost:8794 node test/room-rules.e2e.mjs   (BFF: PRO_BACKGROUND=0, 데모 로그인 코드 000000)
// 규칙을 말하고 링크만 붙이면 내장 브라우저 작업이 NotebookLM 에서 시작한다. 로그인 뒤의 일은 사람이 있어야 해서 여기 없다.
// 에이전트로 가는 단계는 맨 뒤에 둔다: 멈춰도 게이트웨이 모델이 한동안 붙잡혀 다음 단계의 계획이 느려진다.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { q, pool } from '../lib/supa.js'
import { readRoomRule, ruleOf } from '../lib/roomRules.js'

const API = `${process.env.API_URL || 'http://localhost:8794'}/api`
const CODE = process.env.PGPT_LOGIN_CODE || '000000'
const RULE = '앞으로 이 방에 붙여넣는 모든 내용들은 URL 이나 어떤 첨부파일은 곧바로 노트북 lm의 슬라이드 팟캐스트로 만들어주는 작업을 해주면 돼.'
const LINK = 'https://youtu.be/3jQHMKGcwQs'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const JSONH = { 'Content-Type': 'application/json' }
let n = 0
async function step(name, fn) {
  n++
  try { await fn(); console.log(`ok ${n} - ${name}`) } catch (e) { console.log(`not ok ${n} - ${name}\n  ${e.message}`); await cleanup().catch(() => {}); process.exit(1) }
}
async function login(email) {
  const r = await fetch(`${API}/auth/email/verify`, { method: 'POST', headers: JSONH, body: JSON.stringify({ email, code: CODE }) })
  const s = await r.json()
  const H = { Authorization: `Bearer ${s.session.access_token}`, ...JSONH }
  await fetch(`${API}/profile`, { method: 'POST', headers: H, body: JSON.stringify({ name: '회귀-방규칙', birth: '1990-01-01', onboarded: true }) })
  return { id: s.user.id, email, H }
}
const call = (u, path, opts = {}) => fetch(`${API}${path}`, { headers: u.H, ...opts }).then((r) => r.json())
// 답은 스트림으로 온다: 끝까지 읽는다
const say = (u, thread, text) => fetch(`${API}/threads/${thread}/messages`, { method: 'POST', headers: u.H, body: JSON.stringify({ text }), signal: AbortSignal.timeout(120000) }).then((r) => r.text())
const rows = (thread, kind) => q(`select role, kind, content from pro_messages where thread_id=$1 ${kind ? 'and kind=$2' : ''} order by created_at`, kind ? [thread, kind] : [thread])
const replies = async (thread) => (await rows(thread, 'text')).filter((m) => m.role === 'agent').map((m) => m.content.text)
const until = async (fn, what, ms = 60000) => {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`기다렸지만 안 됨: ${what}`)
    await sleep(500)
  }
}
const newRoom = async (u, title) => (await q(`insert into pro_threads(user_id,kind,title) values ($1,'project',$2) returning id`, [u.id, title]))[0].id

const me = await login('pro-rt-roomrule@uengine.org')
const other = await login('pro-rt-roomrule2@uengine.org')
async function cleanup() {
  await call(me, '/browser/cancel', { method: 'POST', body: '{}' }).catch(() => {})
  await q(`delete from pro_threads where user_id=$1 and kind='project'`, [me.id])
  await q(`delete from pro_threads where user_id=$1 and kind='project'`, [other.id])
}
await cleanup()
const room = await newRoom(me, '슬라이드 방')

await step('규칙을 말하면 에이전트 없이 기억하고 바로 그렇게 답한다', async () => {
  const t0 = Date.now()
  await say(me, room, RULE)
  const rule = await ruleOf(me.id, room)
  assert.ok(rule, '규칙이 저장되어야 한다')
  assert.equal(rule.said, RULE)
  assert.match(rule.action, /노트북|슬라이드/)
  const said = (await replies(room)).at(-1)
  assert.match(said, /앞으로/)
  assert.ok(said.includes(rule.action), `답에 할 일이 보여야 한다: ${said}`)
  assert.equal((await rows(room, 'task')).length, 0, '규칙을 정하는 말로는 아직 일을 시작하지 않는다')
  console.log(`  # ${Date.now() - t0} ms`)
})

await step('규칙이 아닌 말은 규칙이 되지 않는다(실제 모델)', async () => {
  const blank = await newRoom(me, '다른 방')
  for (const text of ['앞으로 답은 짧게 해 줘', `이 링크 요약해 줘 ${LINK}`, '매일 아침 9시에 이 링크들을 확인해서 알려 줘']) {
    assert.equal(await readRoomRule(me, blank, text), null, text)
  }
  assert.equal(await ruleOf(me.id, blank), null)
})

await step('다른 말로 해도 규칙으로 읽는다(실제 모델)', async () => {
  const blank = await newRoom(me, '번역 방')
  const row = await readRoomRule(me, blank, '이 방에 올리는 파일은 앞으로 전부 영어로 번역해 줘')
  assert.ok(row, '규칙이어야 한다')
  assert.match(row.action, /번역/)
})

await step('다른 사람은 규칙을 보거나 지우지 못한다', async () => {
  assert.equal((await call(other, `/threads/${room}/rule`)).rule, null)
  assert.equal((await call(other, `/threads/${room}/rule`, { method: 'DELETE' })).removed, 0)
  assert.ok(await ruleOf(me.id, room))
})

await step('링크만 붙이면 묻지 않고 내장 브라우저로 NotebookLM 에서 시작한다', async () => {
  await say(me, room, LINK)
  assert.match((await replies(room)).at(-1), /규칙대로 시작/)
  const task = await until(async () => (await rows(room, 'task')).at(-1)?.content, '작업 카드')
  assert.ok(['queued', 'running', 'needs_input'].includes(task.state), task.state)
  const fr = await until(async () => { const f = await call(me, '/browser/frame'); return f?.url?.includes('google.com') && f }, '브라우저가 구글 사이트를 연다')
  assert.ok(fr.running)
  assert.equal((await ruleOf(me.id, room)).runs, 1)
})

await step('취소하면 작업이 멈춘다', async () => {
  await call(me, '/browser/cancel', { method: 'POST', body: '{}' })
  await until(async () => (await rows(room, 'task')).at(-1)?.content.state === 'cancelled', '취소됨', 30000)
})

await step('끄면 링크를 붙여도 그 일이 돌지 않는다', async () => {
  assert.equal((await call(me, `/threads/${room}/rule`, { method: 'DELETE' })).removed, 1)
  assert.equal((await call(me, `/threads/${room}/rule`)).rule, null)
  const before = (await rows(room, 'task')).length
  // 규칙이 없으니 평소의 에이전트로 간다: 그 턴은 볼일이 없어 바로 멈춘다
  fetch(`${API}/threads/${room}/messages`, { method: 'POST', headers: me.H, body: JSON.stringify({ text: LINK }) }).catch(() => {})
  await sleep(6000)
  await call(me, `/threads/${room}/stop`, { method: 'POST', body: '{}' }).catch(() => {})
  assert.equal((await rows(room, 'task')).length, before, '새 브라우저 작업이 없어야 한다')
})

await step('프로젝트 방이 아닌 대화에서는 같은 말이 규칙이 되지 않는다', async () => {
  const [t] = await q(`select id from pro_threads where user_id=$1 and kind='chat' order by created_at limit 1`, [me.id])
  const chat = t?.id || (await q(`insert into pro_threads(user_id,kind,title) values ($1,'chat','채팅') returning id`, [me.id]))[0].id
  fetch(`${API}/threads/${chat}/messages`, { method: 'POST', headers: me.H, body: JSON.stringify({ text: RULE }) }).catch(() => {})
  await sleep(6000)
  await call(me, `/threads/${chat}/stop`, { method: 'POST', body: '{}' }).catch(() => {})
  assert.equal(await ruleOf(me.id, chat), null)
  await q('delete from pro_messages where thread_id=$1', [chat])
})

await step('사이트 일이 아닌 규칙은 평소의 에이전트로 간다', async () => {
  const [{ id: blank }] = await q(`select thread_id as id from pro_room_rules where user_id=$1 and action like '%번역%'`, [me.id])
  fetch(`${API}/threads/${blank}/messages`, { method: 'POST', headers: me.H, body: JSON.stringify({ text: LINK }) }).catch(() => {})
  await until(async () => (await ruleOf(me.id, blank)).runs === 1, '규칙이 한 번 돈다', 20000)
  await sleep(3000)
  await call(me, `/threads/${blank}/stop`, { method: 'POST', body: '{}' }).catch(() => {})
  assert.equal((await rows(blank, 'task')).length, 0, '브라우저 작업이 아니다')
  assert.ok(!(await replies(blank)).some((t) => t.includes('규칙대로 시작')))
})

await cleanup()
for (const u of [me, other]) fs.rmSync(fileURLToPath(new URL(`../.browser-profiles/${u.id}`, import.meta.url)), { recursive: true, force: true })
console.log(`1..${n}`)
await pool.end()
process.exit(0)
