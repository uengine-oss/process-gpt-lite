// 제안 카드를 거절한 까닭이 서버에 남고(카드 메시지의 content), 다음 채팅 요청을 견줄 때 그 회사의 거절만 읽힌다 — 실제 DB(로컬 Supabase) ·
// 실제 Express 라우트(로그인만 헤더 대역), 모델은 가짜 fetch(첫 글자 확률). 서버 lib/ontology/declines.js · routes/ontology.js.
//   OD-I-01 「아니요」: 카드가 declined 로(누가 · 언제 · 어느 프로세스), 남의 카드 404, 이미 진행한 카드 409, messageId 없으면 400
//   OD-I-02 까닭: 칩(관계없어요 · 맞지만 이번엔) · 넘어가기 · 직접 적은 말은 모델이 읽어 0.7 이상일 때만 그 까닭, 아니면 「다른 까닭」
//   OD-I-03 읽기: 이 회사의 거절한 채팅 카드만(다른 회사 · 메일 카드 · 아직 묻는 카드 빼고) → 반례 · 쉬는 프로세스
// 사람 · 회사는 지어낸 것이다(정하윤 · 김서연, 가나정밀).
// Run: node --test --test-concurrency=1 test/ontology-declines.integration.test.js  (needs the local Supabase)
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

const TENANT = `onto-decline-test-${crypto.randomBytes(3).toString('hex')}`
const OTHER = `${TENANT}-other`
delete process.env.PRO_TENANT_FROM_HEADER
process.env.PRO_BACKGROUND = '0'
process.env.PRO_TENANT_ID = TENANT
process.env.PRO_TENANT_HOSTS = ''
process.env.PRO_ONTOLOGY_BOLT_URL = ''
process.env.PRO_CONTEXT_ROUTER_URL = ''
process.env.PRO_JUDGE_URL = ''
process.env.PRO_LLM_BASE_URL = 'https://llm.fake.example/v1'
process.env.PRO_LLM_API_KEY = 'test'
process.env.PRO_LLM_KEYS = 'off'
process.env.PRO_LLM_MODEL = 'fake'
process.env.PRO_LLM_FAST_MODEL = 'fake'

const { config } = await import('../config.js')
const { q, pool } = await import('../lib/supa.js')
const D = await import('../lib/ontology/declines.js')

// the fake model: the option whose label holds `pick` gets probability p (the reading of a person's own words)
const llm = { pick: null, p: 0.86, read: [] }
const real = globalThis.fetch
globalThis.fetch = async (url, init = {}) => {
  const u = String(url)
  if (u.startsWith(config.llm.baseUrl)) {
    const b = JSON.parse(init.body || '{}')
    const text = (b.messages || []).map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n')
    llm.read.push(text)
    const options = [...text.matchAll(/^([A-Z])\) (.+)$/gm)].map((m) => ({ letter: m[1], label: m[2] }))
    const hit = (llm.pick && options.find((o) => o.label.includes(llm.pick))) || options.at(-1) || { letter: 'A' }
    const other = options.find((o) => o.letter !== hit.letter) || { letter: 'Z' }
    return Response.json({ choices: [{ message: { content: hit.letter }, logprobs: { content: [{ token: hit.letter, top_logprobs: [{ token: hit.letter, logprob: Math.log(llm.p) }, { token: other.letter, logprob: Math.log(1 - llm.p) }] }] } }] })
  }
  return real(url, init)
}

const users = [], closers = []
after(async () => {
  for (const c of closers) c()
  for (const u of users) {
    await q('delete from pro_messages where thread_id in (select id from pro_threads where user_id=$1)', [u.id]).catch(() => {})
    await q('delete from pro_threads where user_id=$1', [u.id]).catch(() => {})
    await q('delete from pro_profile where user_id=$1', [u.id]).catch(() => {})
    await q('delete from users where id=$1', [u.id]).catch(() => {})
  }
  for (const t of tenants) await q('delete from tenants where id=$1', [t]).catch(() => {})
  await pool.end()
  globalThis.fetch = real
})

const tenants = new Set()
async function person(name, tenant = TENANT) {
  if (!tenants.has(tenant)) { tenants.add(tenant); await q('insert into tenants (id) values ($1) on conflict (id) do nothing', [tenant]) }
  const id = crypto.randomUUID()
  const u = { id, email: `od-${id.slice(0, 8)}@lite.example`, name }
  users.push(u)
  await q(`insert into users (id, email, username, tenant_id) values ($1,$2,$3,$4)`, [id, u.email, `pgpt-${id.slice(0, 6)}`, tenant])
  await q(`insert into pro_profile(user_id,name,email) values ($1,$2,$3) on conflict (user_id) do nothing`, [id, name, u.email])
  const [t] = await q(`insert into pro_threads(user_id, kind, title) values ($1,'chat','채팅') returning id`, [id])
  u.thread = t.id
  return u
}
const GEN = { proc: 'p:gen-od', procName: '요청 보고 · 구현', task: '요청방향 보고', p: 0.44, suggest: true, options: [{ task: '요청방향 보고', p: 0.44 }, { task: '구현', p: 0.23 }] }
const card = async (u, subject, extra = {}) => (await q(`insert into pro_messages(thread_id, role, kind, content) values ($1,'agent','onto-entry',$2) returning id::text as id`,
  [u.thread, { state: 'ask', source: 'chat', mail: { from: '', subject, text: subject }, customer: '', choice: GEN, suggest: true, conv: '', ...extra }]))[0].id
const contentOf = async (id) => (await q('select content from pro_messages where id=$1', [id]))[0]?.content

let base = null
async function call(u, p, body) {
  if (!base) {
    const express = (await import('express')).default
    const { ontologyRoutes } = await import('../routes/ontology.js')
    const app = express()
    app.use(express.json())
    const auth = (req, res, next) => {
      const me = users.find((x) => x.id === req.headers['x-test-user'])
      if (!me) return res.status(401).json({ error: 'unauthorized' })
      req.user = { id: me.id, email: me.email, name: me.name }; next()
    }
    app.use('/api', ontologyRoutes(auth))
    const s = await new Promise((ok) => { const x = app.listen(0, '127.0.0.1', () => ok(x)) })
    closers.push(() => s.close())
    base = `http://127.0.0.1:${s.address().port}/api`
  }
  const r = await real(`${base}${p}`, { method: 'POST', headers: { 'x-test-user': u.id, 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
  return { status: r.status, body: await r.json().catch(() => null) }
}

test('OD-I-01 「아니요」는 카드에 남는다 — 누가 · 언제 · 어느 프로세스, 남의 카드 404 · 진행한 카드 409 · 카드 없음 400', async () => {
  const me = await person('정하윤'), sy = await person('김서연')
  const id = await card(me, 'Spec Kit 기반 교육 과정 커리큘럼 설계해 줘')
  assert.equal((await call(sy, '/ontology/entry/decline', { messageId: id })).status, 404, '남의 카드')
  assert.equal((await call(me, '/ontology/entry/decline', {})).status, 400)
  const r = await call(me, '/ontology/entry/decline', { messageId: id })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const c = await contentOf(id)
  assert.equal(c.state, 'declined')
  assert.equal(c.declined.by, me.id)
  assert.ok(Date.parse(c.declined.at) > Date.now() - 60_000)
  assert.deepEqual(c.declined.procs, [{ proc: GEN.proc, name: GEN.procName }])
  assert.equal(c.declined.reason, undefined, '까닭은 아직')
  assert.equal(c.choice.procName, GEN.procName, '카드의 나머지는 그대로')
  const started = await card(me, '가나정밀 견적 요청', { state: 'started', caseId: 'c-1' })
  assert.equal((await call(me, '/ontology/entry/decline', { messageId: started })).status, 409)
})

test('OD-I-02 까닭: 칩 · 넘어가기 · 직접 적은 말(모델이 0.7 이상으로 읽은 것만)', async () => {
  const me = await person('정하윤')
  const a = await card(me, 'Spec Kit 실습 과정 목차 짜 줘')
  await call(me, '/ontology/entry/decline', { messageId: a })
  const at0 = (await contentOf(a)).declined.at
  const r = await call(me, '/ontology/entry/decline', { messageId: a, reason: 'unrelated' })
  assert.equal(r.status, 200)
  assert.equal(r.body.declined.reason, 'unrelated')
  const c = await contentOf(a)
  assert.equal(c.declined.reason, 'unrelated')
  assert.equal(c.declined.at, at0, '거절한 때는 처음 그대로')
  assert.ok(c.declined.reasonAt)

  const b = await card(me, '팀 회고 정리해 줘')
  await call(me, '/ontology/entry/decline', { messageId: b, reason: 'not-now' })
  assert.equal((await contentOf(b)).declined.reason, 'not-now')

  const s = await card(me, '주간 보고 표 만들어 줘')
  await call(me, '/ontology/entry/decline', { messageId: s, skip: true })
  assert.equal((await contentOf(s)).declined.skipped, true)
  assert.equal((await contentOf(s)).declined.reason, undefined)

  // the person's own words: the model reads them (the options are the three reasons)
  llm.pick = '관계없다'; llm.p = 0.86; llm.read.length = 0
  const w = await card(me, '발표 슬라이드 다듬어 줘')
  const rw = await call(me, '/ontology/entry/decline', { messageId: w, note: '교육 과정 설계지 요청 보고가 아니에요' })
  assert.equal(rw.status, 200, JSON.stringify(rw.body))
  const cw = await contentOf(w)
  assert.equal(cw.declined.reason, 'unrelated')
  assert.equal(cw.declined.note, '교육 과정 설계지 요청 보고가 아니에요')
  assert.ok(llm.read.some((t) => t.includes('거절하며 쓴 말: 교육 과정 설계지 요청 보고가 아니에요') && t.includes('「요청 보고 · 구현」')), llm.read.join('\n---\n'))
  // unsure → 「다른 까닭」, never a negative
  llm.pick = '관계없다'; llm.p = 0.55
  const u = await card(me, '사내 위키 목차 다시 짜 줘')
  await call(me, '/ontology/entry/decline', { messageId: u, note: '음 글쎄요' })
  assert.equal((await contentOf(u)).declined.reason, 'other')
  assert.equal((await contentOf(u)).declined.readAs.choice, 'unrelated')
})

test('OD-I-03 읽기: 이 회사의 거절한 채팅 카드만 → 반례 · 쉬는 프로세스', async () => {
  const me = await person('정하윤'), far = await person('다른 회사 사람', OTHER)
  // three more 「관계없어요」 of this company (with OD-I-02's two: 「Spec Kit 실습 과정 목차 짜 줘」 and 「발표 슬라이드 다듬어 줘」)
  for (const s of ['워크숍 안내 메일 초안 써 줘', '세미나 자료 요약해 줘', '사내 교육 일정표 만들어 줘']) {
    const id = await card(me, s)
    await call(me, '/ontology/entry/decline', { messageId: id, reason: 'unrelated' })
  }
  // not read: another company's, a mail card's, a card still asking
  await q(`insert into pro_messages(thread_id, role, kind, content) values ($1,'agent','onto-entry',$2)`, [far.thread,
    { state: 'declined', source: 'chat', mail: { subject: '다른 회사의 요청' }, choice: GEN, declined: { at: new Date().toISOString(), reason: 'unrelated', procs: [{ proc: GEN.proc, name: GEN.procName }] } }])
  await q(`insert into pro_messages(thread_id, role, kind, content) values ($1,'agent','onto-entry',$2)`, [me.thread,
    { state: 'declined', source: 'mail', mail: { subject: '메일로 온 요청' }, choice: GEN, declined: { at: new Date().toISOString(), reason: 'unrelated', procs: [{ proc: GEN.proc, name: GEN.procName }] } }])
  await card(me, '아직 묻는 카드')
  const R = { declines: {} }
  const rows = await D.recentDeclines(R)
  const requests = rows.map((r) => r.request)
  assert.ok(!requests.includes('다른 회사의 요청'))
  assert.ok(!requests.includes('메일로 온 요청'))
  assert.ok(!requests.includes('아직 묻는 카드'))
  const m = await D.forMatching(R)
  const neg = m.negatives.get(GEN.proc).map((n) => n.request)
  assert.equal(neg.length, 4, neg.join(' / '))
  assert.equal(neg[0], '사내 교육 일정표 만들어 줘', '새것부터')
  assert.ok(!neg.includes('팀 회고 정리해 줘'), '「맞지만 이번엔」은 반례가 아니다')
  assert.ok(!neg.includes('사내 위키 목차 다시 짜 줘'), '「다른 까닭」은 반례가 아니다')
  // five 「관계없어요」 within days: it rests for 7 days from the last
  const rest = m.resting.get(GEN.proc)
  assert.equal(rest.count, 5)
  assert.ok(Date.parse(rest.until) > Date.now() + 6.9 * 86_400_000)
})
