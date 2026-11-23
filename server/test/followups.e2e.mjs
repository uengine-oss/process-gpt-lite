// 후행 습관 HTTP E2E: 실제 BFF·실제 DB·실제 모델. spec pgpt-pro_followup-habits
//   API_URL=http://localhost:8794 node test/followups.e2e.mjs   (BFF: PRO_BACKGROUND=0, 데모 로그인 코드 000000)
// 결과물을 만드는 턴은 에이전트 없이 턴의 끝(afterTurn)을 직접 부른다. 판정은 실제 모델이 한다.
// 에이전트까지 도는 것은 수락 단계 둘과 tests/agent/followups.spec.js 이다.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { config } from '../config.js'
import { q, pool } from '../lib/supa.js'
import { afterTurn, followsResult, readRule } from '../lib/followups.js'

const API = process.env.API_URL || 'http://localhost:8794'
const CODE = process.env.PGPT_LOGIN_CODE || '000000'
const AWAIT_MS = 480_000
let n = 0
async function step(name, fn) {
  n++
  try { await fn(); console.log(`ok ${n} - ${name}`) } catch (e) { console.log(`not ok ${n} - ${name}\n  ${e.message}`); await cleanup().catch(() => {}); await pool.end(); process.exit(1) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms, what) {
  const t0 = Date.now()
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`시간 초과: ${what}`); await sleep(1500) }
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
  return (await q(`insert into pro_threads(user_id,kind,title) values ($1,'chat','채팅') returning id`, [u.id]))[0].id
}
async function cleanup() {
  for (const u of [a, b].filter(Boolean)) {
    const th = await threadOf(u)
    await q('delete from pro_messages where thread_id=$1', [th])
    await q('update pro_threads set conversation_id=null, status=null where id=$1', [th])
    await q('delete from context_threads where user_id=$1', [u.id])
    await q('delete from pro_followups where user_id=$1', [u.id])
  }
}
// the end of a turn, as lib/agent.js calls it, in conversation conv
async function turn(u, th, conv, said, fileNames = [], extra = {}) {
  await q(`insert into pro_messages(thread_id,role,kind,content) values ($1,'user','text',$2)`, [th, { text: said }])
  const [msg] = await q(`insert into pro_messages(thread_id,role,kind,content) values ($1,'agent','text',$2) returning *`, [th, { text: '네, 했어요.', context: { title: conv, conversationId: conv, action: 'continue' } }])
  await afterTurn({ user: { id: u.id }, threadId: th, msg, conv, title: conv, said, files: fileNames.map((name) => ({ name })), attached: [], ...extra })
}
const habits = (u) => q('select * from pro_followups where user_id=$1 order by created_at', [u.id])
const cards = (th) => q(`select * from pro_messages where thread_id=$1 and kind='followup' order by created_at`, [th])
const chips = (th) => q(`select * from pro_messages where thread_id=$1 and kind='chip' order by created_at`, [th])
const lastCard = async (th) => (await cards(th)).at(-1)
async function send(u, th, text) {
  const r = await fetch(`${API}/api/threads/${th}/messages`, { method: 'POST', headers: { Authorization: `Bearer ${u.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ text }), signal: AbortSignal.timeout(AWAIT_MS) })
  assert.equal(r.status, 200, `send: ${r.status}`)
  await r.text()
}

let a, b, th, thB
await step('두 사람이 로그인하고 습관이 비어 있다', async () => {
  a = await login('pro-fu-a@uengine.org'); b = await login('pro-fu-b@uengine.org')
  await cleanup()
  th = await threadOf(a); thB = await threadOf(b)
  const r = await a.call('GET', '/followups')
  assert.equal(r.status, 200, r.text)
  assert.deepEqual(r.body.habits, [])
  assert.equal(r.body.minSeen, 2)
})
await step('슬라이드를 처음 받는다: 묻지 않고, 무엇이 나왔는지만 답에 남긴다', async () => {
  await turn(a, th, 'c1', '분기 실적 요약 슬라이드 만들어 줘', ['분기 실적.pptx'])
  assert.equal((await habits(a)).length, 0)
  assert.equal((await cards(th)).length, 0)
  const [m] = await q(`select content from pro_messages where thread_id=$1 and role='agent' order by created_at desc limit 1`, [th])
  assert.deepEqual(m.content.event.classes, ['slides'])
  assert.deepEqual(m.content.event.files, ['분기 실적.pptx'])
})
await step('이어서 로고를 바꾸라고 한다: 습관 후보로 한 번 기록하고, 아직 말하지 않는다', async () => {
  await turn(a, th, 'c1', '슬라이드 로고를 유엔진으로 바꿔 줘', ['분기 실적-edited.pptx'])
  const hs = await habits(a)
  assert.equal(hs.length, 1, JSON.stringify(hs))
  assert.equal(hs[0].event_cls, 'slides')
  assert.equal(hs[0].seen, 1)
  assert.equal(hs[0].action, '슬라이드 로고를 유엔진으로 바꿔 줘')
  assert.equal((await chips(th)).length, 0)
  assert.equal((await cards(th)).length, 0, '후행 작업의 결과물로 묻지 않는다')
})
await step('방금 나온 결과물에 대한 말은 에이전트에게 보낸다. 상관없는 말은 평소대로다', async () => {
  const [u] = await q(`insert into pro_messages(thread_id,role,kind,content) values ($1,'user','text','{"text":"x"}') returning id`, [th])
  const about = await followsResult(th, u.id, '슬라이드 첫 장 제목 앞에 [유엔진]을 붙여 줘')
  assert.equal(about?.conv, 'c1', JSON.stringify(about))
  assert.equal(await followsResult(th, u.id, '내일 날씨 알려 줘'), null)
  await q('delete from pro_messages where id=$1', [u.id])
})
await step('결과물 뒤의 감사·내용 질문은 습관이 아니다', async () => {
  await turn(a, th, 'c2', '신제품 소개 슬라이드 만들어 줘', ['신제품.pptx'])
  await turn(a, th, 'c2', '고마워', [])
  await turn(a, th, 'c2-2', '교육 자료 슬라이드 만들어 줘', ['교육.pptx'])
  await turn(a, th, 'c2-2', '3번째 장 수치 출처가 어디야?', [])
  assert.equal((await habits(a)).length, 1, JSON.stringify((await habits(a)).map((h) => h.action)))
})
await step('다음번에 다른 말로 같은 일을 시킨다: 같은 습관 2회, 기억한다고 한 번 말한다', async () => {
  await turn(a, th, 'c3', '영업 자료 슬라이드 만들어 줘', ['영업 자료.pptx'])
  await turn(a, th, 'c3', '슬라이드에 우리 회사 유엔진 로고로 넣어 줘', ['영업 자료-edited.pptx'])
  const hs = await habits(a)
  assert.equal(hs.length, 1, `다른 말을 같은 습관으로 보지 못함: ${JSON.stringify(hs.map((h) => h.action))}`)
  assert.equal(hs[0].seen, 2)
  const c = await chips(th)
  assert.equal(c.length, 1)
  assert.match(c[0].content.text, /기억할게요/)
})
await step('습관이 된 뒤 새 대화에서 슬라이드가 나오면 먼저 묻는다', async () => {
  await q(`update pro_followups set last_asked_conv=null where user_id=$1`, [a.id])
  const before = (await cards(th)).length
  await turn(a, th, 'c4', '고객 제안 슬라이드 만들어 줘', ['고객 제안.pptx'])
  const all = await cards(th)
  assert.equal(all.length, before + 1, '카드가 없음')
  const c = all.at(-1).content
  assert.match(c.text, /^지난번처럼 /)
  assert.match(c.text, /\?$/)
  assert.equal(c.state, 'pending')
  assert.equal(c.source, 'logprob')
  assert.ok(c.p >= 0.5, `p=${c.p}`)
  assert.equal(c.conv.id, 'c4')
})
await step('같은 대화에서는 한 번만 묻고, 다른 종류의 결과물에는 묻지 않는다', async () => {
  const before = (await cards(th)).length
  await turn(a, th, 'c4', '비슷한 슬라이드 하나 더 만들어 줘', ['고객 제안2.pptx'])
  await turn(a, th, 'c5', '견적 표 만들어 줘', ['견적.xlsx'])
  assert.equal((await cards(th)).length, before)
})
await step('아니요를 누르면 그 카드만 닫히고 거절이 쌓이며, 두 번 답할 수 없다', async () => {
  const card = await lastCard(th)
  const r = await a.call('POST', `/followups/answer/${card.id}`, { choice: 'decline' })
  assert.equal(r.status, 200, r.text)
  assert.equal(r.body.state, 'declined')
  assert.equal((await lastCard(th)).content.state, 'declined')
  const [h] = await habits(a)
  assert.equal(h.declined, 1)
  assert.equal(h.declined_run, 1)
  assert.equal(h.state, 'on')
  assert.equal((await a.call('POST', `/followups/answer/${card.id}`, { choice: 'accept' })).status, 409)
})
await step('말로 사양해도(괜찮아요) 에이전트를 부르지 않고 거절로 친다', async () => {
  await turn(a, th, 'c6', '사내 교육 슬라이드 만들어 줘', ['사내 교육.pptx'])
  assert.equal((await lastCard(th)).content.state, 'pending')
  await send(a, th, '괜찮아요')
  assert.equal((await lastCard(th)).content.state, 'declined')
  const [h] = await habits(a)
  assert.equal(h.declined, 2)
  const [m] = await q(`select content from pro_messages where thread_id=$1 and role='agent' and kind='text' order by created_at desc limit 1`, [th])
  assert.match(m.content.text, /하지 않을게요/)
})
await step('네를 누르면 그 대화에서 습관의 말이 그대로 턴이 되고, 그 결과로는 다시 묻지 않는다', async () => {
  await turn(a, th, 'c7', '파트너 소개 슬라이드 만들어 줘', ['파트너.pptx'])
  const card = await lastCard(th)
  assert.equal(card.content.state, 'pending')
  const before = (await cards(th)).length
  const r = await a.call('POST', `/followups/answer/${card.id}`, { choice: 'accept' })
  assert.equal(r.status, 200, r.text)
  assert.equal(r.body.state, 'accepted')
  const said = await until(async () => (await q(`select * from pro_messages where thread_id=$1 and role='user' and content->>'fromHabit'='true' order by created_at desc limit 1`, [th]))[0], 15000, '습관의 말')
  assert.equal(said.content.text, '슬라이드 로고를 유엔진으로 바꿔 줘')
  const answer = await until(async () => (await q(`select * from pro_messages where thread_id=$1 and role='agent' and kind in ('text','doc') and created_at > $2 and content ? 'event' order by created_at limit 1`, [th, said.created_at]))[0], AWAIT_MS, '에이전트의 답')
  assert.equal(answer.content.context?.conversationId, 'c7', JSON.stringify(answer.content.context))
  const [h] = await habits(a)
  assert.equal(h.accepted, 1)
  assert.equal(h.declined_run, 0, '수락하면 거절 연속이 끊긴다')
  await sleep(2500)
  assert.equal((await cards(th)).length, before, '수락한 일의 결과로 또 묻는다')
})
await step('말로 수락해도(응, 해 줘) 습관의 말로 돈다. 사람의 말은 그대로 남는다', async () => {
  await turn(a, th, 'c8', '채용 설명회 슬라이드 만들어 줘', ['채용.pptx'])
  assert.equal((await lastCard(th)).content.state, 'pending')
  await send(a, th, '응, 해 줘')
  assert.equal((await lastCard(th)).content.state, 'accepted')
  const [h] = await habits(a)
  assert.equal(h.accepted, 2)
  const [u] = await q(`select content from pro_messages where thread_id=$1 and role='user' order by created_at desc limit 1`, [th])
  assert.equal(u.content.text, '응, 해 줘')
})
await step('답이 아닌 말은 보통 메시지로 가고, 카드는 조용히 닫힌다', async () => {
  await turn(a, th, 'c9', '세미나 슬라이드 만들어 줘', ['세미나.pptx'])
  assert.equal((await lastCard(th)).content.state, 'pending')
  await send(a, th, '근데 오늘 몇 월 며칠이야?')
  assert.equal((await lastCard(th)).content.state, 'passed')
  const [h] = await habits(a)
  assert.equal(h.declined, 2, '다른 말을 거절로 세면 안 된다')
})
await step('다시 묻지 않기: 끄고 나면 슬라이드가 나와도 묻지 않고, 설정에서 다시 켤 수 있다', async () => {
  await turn(a, th, 'c10', '워크숍 슬라이드 만들어 줘', ['워크숍.pptx'])
  const card = await lastCard(th)
  assert.equal(card.content.state, 'pending')
  assert.equal((await a.call('POST', `/followups/answer/${card.id}`, { choice: 'mute' })).body.state, 'muted')
  const [h] = await habits(a)
  assert.equal(h.state, 'muted')
  const before = (await cards(th)).length
  await turn(a, th, 'c11', '주주 총회 슬라이드 만들어 줘', ['주총.pptx'])
  assert.equal((await cards(th)).length, before)
  assert.equal((await a.call('PATCH', `/followups/${h.id}`, { state: 'on' })).status, 200)
  await turn(a, th, 'c12', '연말 결산 슬라이드 만들어 줘', ['결산.pptx'])
  assert.equal((await cards(th)).length, before + 1)
})
await step('습관은 그 사람만의 것이다: 남의 습관과 카드를 보거나 바꿀 수 없다', async () => {
  const [h] = await habits(a)
  const card = await lastCard(th)
  const list = await b.call('GET', '/followups')
  assert.deepEqual(list.body.habits, [])
  assert.equal((await b.call('PATCH', `/followups/${h.id}`, { state: 'muted' })).status, 404)
  assert.equal((await b.call('DELETE', `/followups/${h.id}`)).status, 404)
  assert.equal((await b.call('POST', `/followups/answer/${card.id}`, { choice: 'accept' })).status, 404)
  const before = (await cards(thB)).length
  await turn(b, thB, 'b1', '내 슬라이드 만들어 줘', ['내것.pptx'])
  assert.equal((await cards(thB)).length, before, '남의 습관으로 묻는다')
})
await step('잘못된 요청: 없는 선택 400, 없는 상태 400, 형식 오류 404, 로그인 없음 401', async () => {
  const [h] = await habits(a)
  const card = await lastCard(th)
  assert.equal((await a.call('POST', `/followups/answer/${card.id}`, { choice: 'maybe' })).status, 400)
  assert.equal((await a.call('PATCH', `/followups/${h.id}`, { state: 'paused' })).status, 400)
  assert.equal((await a.call('POST', '/followups/answer/nope', { choice: 'accept' })).status, 404)
  assert.equal((await fetch(`${API}/api/followups`)).status, 401)
})
await step('지우면 목록에서 사라진다', async () => {
  const hs = await habits(a)
  assert.ok(hs.length >= 1)
  assert.equal((await a.call('DELETE', `/followups/${hs[0].id}`)).status, 200)
  const left = (await a.call('GET', '/followups')).body.habits
  assert.ok(!left.some((h) => h.id === hs[0].id), '지운 습관이 남아 있다')
  for (const h of left) assert.equal((await a.call('DELETE', `/followups/${h.id}`)).status, 200)
  assert.deepEqual((await a.call('GET', '/followups')).body.habits, [])
})
await step('「앞으로 …」라고 직접 말하면 에이전트 없이 바로 기억하고, 다음 결과물부터 묻는다', async () => {
  const beforeUser = (await q(`select count(*)::int n from pro_messages where thread_id=$1 and role='agent' and kind='text'`, [th]))[0].n
  await send(a, th, '앞으로 문서 만들면 표지에 대외비라고 넣어 줘')
  const hs = await habits(a)
  assert.equal(hs.length, 1, JSON.stringify(hs))
  assert.equal(hs[0].origin, 'told')
  assert.equal(hs[0].event_cls, 'doc')
  assert.match(hs[0].action, /대외비/)
  const [m] = await q(`select content from pro_messages where thread_id=$1 and role='agent' and kind='text' order by created_at desc limit 1`, [th])
  assert.match(m.content.text, /기억할게요/)
  assert.equal((await q(`select count(*)::int n from pro_messages where thread_id=$1 and role='agent' and kind='text'`, [th]))[0].n, beforeUser + 1)
  await turn(a, th, 'c20', '계약 검토 문서 만들어 줘', ['계약 검토.docx'])
  const c = (await lastCard(th)).content
  assert.match(c.text, /^말씀하신 대로 /)
  assert.equal(c.origin, 'told')
  assert.equal(c.source, 'told', '직접 말한 습관은 어울림을 따지지 않는다')
})
await step('예약이나 말투 부탁은 습관이 아니다', async () => {
  const count = (await habits(a)).length
  assert.equal(await readRule({ id: a.id }, '매일 9시에 보고서 만들어 줘'), null)
  assert.equal(await readRule({ id: a.id }, '앞으로 존댓말로 해 줘'), null)
  assert.equal(await readRule({ id: a.id }, '이 슬라이드 로고 바꿔 줘'), null)
  assert.equal((await habits(a)).length, count)
})
await step('모델이 읽지 못할 때: 말만 보고 배우지 않고, 이미 있는 습관은 규칙으로 묻는다', async () => {
  // 닿지 않는 LLM 을 쓰는 프로세스에서 턴의 끝을 부른다
  await q(`delete from pro_followups where user_id=$1`, [a.id])
  await q(`insert into pro_followups(tenant_id,user_id,event_cls,action,ask,seen) select tenant_id,$1,'doc','표지에 대외비라고 넣어 줘','표지에 대외비라고 넣어드릴까요?',2 from (select $2::text as tenant_id) x`, [a.id, config.tenantId])
  const code = `
    import { q, pool } from '${new URL('../lib/supa.js', import.meta.url).href}'
    import { afterTurn } from '${new URL('../lib/followups.js', import.meta.url).href}'
    const add = async (role, content) => (await q('insert into pro_messages(thread_id,role,kind,content) values ($1,$2,$3,$4) returning *', ['${th}', role, 'text', content]))[0]
    const go = async (said, name) => { const msg = await add('agent', { text: '네', context: { title: 'd1', conversationId: 'd1', action: 'continue' } }); await afterTurn({ user: { id: '${a.id}' }, threadId: '${th}', msg, conv: 'd1', title: 'd1', said, files: name ? [{ name }] : [], attached: [] }) }
    await go('회의록 문서 만들어 줘', '회의록.docx')
    await go('표지에 회사 주소도 넣어 줘', '회의록-edited.docx')
    await pool.end()`
  const before = (await cards(th)).length
  const count = (await habits(a)).length
  const out = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: fileURLToPath(new URL('..', import.meta.url)), env: { ...process.env, PRO_LLM_BASE_URL: 'http://127.0.0.1:9/v1' }, encoding: 'utf8', timeout: 60000 })
  assert.equal(out.status, 0, out.stderr.slice(0, 400))
  assert.equal((await habits(a)).length, count, '모델 없이 배웠다')
  const all = await cards(th)
  assert.equal(all.length, before + 1, '규칙으로 묻지 않았다')
  assert.equal(all.at(-1).content.source, 'rule')
})
await step('정리한다', cleanup)
console.log(`1..${n}\n# pass ${n}`)
await pool.end()
process.exit(0)
