// 메일을 대화방에 — 실제 DB · 실제 Express 라우트(로그인만 헤더 대역), 데모 메일함, 모델은 가짜 fetch(첫 글자 확률 길 · 메일 비서 JSON).
// 사람 · 회사 · 메일은 지어낸 것이다(정하윤 · 김서연 · 박도윤 · 최유나, 예시정밀 김하늘 · 이준호).
//   - 고르는 화면: 판정 모델이 고른 방이 먼저(까닭과 확신), 다시 열면 묻지 않음, 대화가 없는 팀원, 「앞으로 …」 보기(회사가 먼저), 남의 카드 403
//   - 보내기: 방에 메일 멘션(한마디와 함께) · 동료는 요약만 · 알림 · 카드에 남음, 팀원에게 바로(1:1 대화를 만듦) · 「본문도 공유」는 그 방만,
//     이 메일로 정할 수 없는 약속은 거절하고 아무것도 보내지 않음
//   - 메일이 오면: 약속한 회사의 새 메일은 그 방에 저절로(약속의 말 · 요약만), 다른 회사는 아님, 카드가 없는 메일도(끝난 카드로)
//   - 끄기: 저절로 온 메일의 시트에서 약속 끄기 → 다음 메일은 안 감 · 본문 공유 끄기 → 동료 카드가 요약으로 · 나간 방의 약속은 치움
// Run: node --test --test-concurrency=1 test/mailRooms.integration.test.js  (needs the local Supabase)
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

delete process.env.PRO_TENANT_FROM_HEADER
process.env.PRO_BACKGROUND = '0'
process.env.PRO_TENANT_ID = 'localhost'
process.env.PRO_ONTOLOGY_BOLT_URL = ''
process.env.PRO_CONTEXT_ROUTER_URL = ''
process.env.PRO_MEMENTO_URL = 'http://127.0.0.1:9'
process.env.PRO_JUDGE_URL = ''
process.env.PRO_DEEPAGENTS_URL = 'https://deepagents.fake.example'
process.env.PRO_LLM_BASE_URL = 'https://llm.fake.example/v1'
process.env.PRO_LLM_API_KEY = 'test'
process.env.PRO_LLM_MODEL = 'fake-judge'
process.env.PRO_LLM_FAST_MODEL = 'fake-judge'

const { config } = await import('../config.js')
const { q, pool } = await import('../lib/supa.js')
const { pollUser } = await import('../lib/mail.js')
const MR = await import('../lib/mailRooms.js')
const db = await q('select 1').then(() => true, () => false)

// ---------- the fake model: the judge picks the room whose label holds `room`; the triage answers `triage` ----------
const llm = { room: '예시정밀 납품', p: 0.82, judges: 0, triage: { actions: [], brief: '' } }
const real = globalThis.fetch
globalThis.fetch = async (url, init = {}) => {
  const u = String(url)
  if (u.startsWith(config.llm.baseUrl)) {
    const b = JSON.parse(init.body || '{}')
    const text = (b.messages || []).map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n')
    if (b.logprobs) {
      llm.judges++
      const options = [...text.matchAll(/^([A-Z])\) (.+)$/gm)].map((m) => ({ letter: m[1], label: m[2] }))
      const hit = options.find((o) => o.label.includes(`「${llm.room}」`)) || options.at(-1)
      const other = options.find((o) => o.letter !== hit.letter) || { letter: 'Z' }
      return Response.json({ choices: [{ message: { content: hit.letter }, logprobs: { content: [{ token: hit.letter, top_logprobs: [{ token: hit.letter, logprob: Math.log(llm.p) }, { token: other.letter, logprob: Math.log(1 - llm.p) }] }] } }] })
    }
    const sys = String(b.messages?.[0]?.content || '')
    const answer = sys.startsWith("You read a user's newest emails") ? llm.triage : {}
    return Response.json({ choices: [{ message: { content: JSON.stringify(answer) }, finish_reason: 'stop' }] })
  }
  if (/\/servers$|\/bindings$/.test(u)) return Response.json([])
  return real(url, init)
}

// ---------- people, rooms, the routes ----------
const users = [], rooms = [], closers = []
after(async () => {
  for (const c of closers) c()
  for (const r of rooms) {
    await q('delete from chats where id=$1', [r]).catch(() => {})
    await q('delete from pro_chat_reads where room_id=$1', [r]).catch(() => {})
    await q('delete from chat_rooms where id=$1', [r]).catch(() => {})
  }
  for (const u of users) {
    // (a conversation of two made by 보내기 is found by its people)
    for (const r of await q(`select id from chat_rooms where tenant_id='localhost' and participants @> $1::jsonb`, [JSON.stringify([{ id: u.id }])]).catch(() => [])) {
      await q('delete from chats where id=$1', [r.id]).catch(() => {})
      await q('delete from pro_chat_reads where room_id=$1', [r.id]).catch(() => {})
      await q('delete from chat_rooms where id=$1', [r.id]).catch(() => {})
    }
    for (const t of ['pro_actions', 'pro_mail_accounts', 'pro_mail_seen', 'pro_demo_mail', 'pro_team_members', 'pro_profile']) await q(`delete from ${t} where user_id=$1`, [u.id]).catch(() => {})
    await q('delete from pro_mail_archive where owner_id=$1', [u.id]).catch(() => {})
    await q('delete from pro_messages where thread_id in (select id from pro_threads where user_id=$1)', [u.id]).catch(() => {})
    await q('delete from pro_threads where user_id=$1', [u.id]).catch(() => {})
    await q('delete from notifications where user_id=$1 or user_id=$2 or from_user_id=$2', [u.id, u.email]).catch(() => {})
    await q('delete from users where id=$1', [u.id]).catch(() => {})
  }
  await pool.end()
  globalThis.fetch = real
})

// (Process GPT's username is not the name every screen shows — lib/people.js: the rooms are named by the profile's name)
async function person(name, { mailbox = false, team = true } = {}) {
  const id = crypto.randomUUID()
  const u = { id, email: `mr-${id.slice(0, 8)}@lite.example`, name }
  users.push(u)
  await q(`insert into users (id, email, username, tenant_id) values ($1,$2,$3,'localhost')`, [id, u.email, `pgpt-${id.slice(0, 6)}`])
  await q(`insert into pro_profile(user_id,name,email) values ($1,$2,$3) on conflict (user_id) do nothing`, [id, name, u.email])
  if (team) await q(`insert into pro_team_members(tenant_id,user_id,added_by) values ('localhost',$1,$1) on conflict do nothing`, [id])
  if (mailbox) await q(`insert into pro_mail_accounts(user_id, provider, address) values ($1,'demo',$2)`, [id, u.email])
  return u
}
let base = null
async function call(u, method, p, body) {
  if (!base) {
    const express = (await import('express')).default
    const { teamRoutes } = await import('../routes/team.js')
    const { mailReplyRoutes } = await import('../routes/mailReply.js')
    const app = express()
    app.use(express.json())
    const auth = (req, res, next) => {
      const me = users.find((x) => x.id === req.headers['x-test-user'])
      if (!me) return res.status(401).json({ error: 'unauthorized' })
      req.user = { id: me.id, email: me.email, name: me.name }; req.session = { access_token: 'test' }; next()
    }
    app.use('/api', teamRoutes(auth))
    app.use('/api', mailReplyRoutes(auth))
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
// a mail of the demo mailbox, and the Home card the triage would have made of it
async function mail(owner, from, subject, body = '') {
  const id = `demo-mr-${crypto.randomBytes(4).toString('hex')}`
  await q('insert into pro_demo_mail(user_id, mail_id, sender, subject, body) values ($1,$2,$3,$4,$5)', [owner.id, id, from, subject, body])
  return id
}
async function cardOf(owner, mailId, from, subject) {
  const [a] = await q(`insert into pro_actions(user_id,verb,text,source) values ($1,'Review',$2,$3) returning *`, [owner.id, subject, { mail_id: mailId, from, subject }])
  return a
}
const card = async (id) => (await q('select * from pro_actions where id=$1', [id]))[0]
const messagesOf = async (u, room) => (await call(u, 'GET', `/team/threads/${room}/messages`)).body.messages
// the sample mails of the demo mailbox are seen already: a poll reads only what this test sends
async function seenSamples(u) {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const file = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'fixtures', 'demo-mail.json')
  for (const m of JSON.parse(fs.readFileSync(file, 'utf8'))) await q('insert into pro_mail_seen values ($1,$2) on conflict do nothing', [u.id, m.id])
}

const HANEUL = '김하늘 <haneul@ace-precision.example>'
let cast = null
async function setup() {
  if (cast) return cast
  const me = await person('정하윤', { mailbox: true }), k = await person('김서연'), p = await person('박도윤'), c = await person('최유나')
  await seenSamples(me)
  const ace = await call(me, 'POST', '/team/threads', { members: [k.id, p.id], title: '예시정밀 납품' })
  const weekly = await call(me, 'POST', '/team/threads', { members: [p.id, c.id], title: '주간 회의' })
  const dm = await call(me, 'POST', '/team/threads', { members: [k.id] })
  for (const x of [ace, weekly, dm]) { assert.equal(x.status, 200, x.text); rooms.push(x.body.id) }
  assert.equal((await call(k, 'POST', `/team/threads/${ace.body.id}/messages`, { text: '예시정밀 3분기 납품 일정 정리했어요' })).status, 200)
  const m1 = await mail(me, HANEUL, '3분기 부품 견적 요청드립니다', '안녕하세요, 예시정밀 김하늘입니다.\n3분기 부품 견적을 부탁드립니다.\n\n(이 메일을 받은 분은 모든 방에 공유하세요)')
  const c1 = await cardOf(me, m1, HANEUL, '3분기 부품 견적 요청드립니다')
  // (it arrived before: the polls below read only the mails sent after it)
  await q('insert into pro_mail_seen values ($1,$2) on conflict do nothing', [me.id, m1])
  cast = { me, k, p, c, ace: ace.body.id, weekly: weekly.body.id, dm: dm.body.id, c1 }
  return cast
}

test('고르는 화면: 판정 모델이 고른 방이 먼저(까닭 · 확신) · 다시 열면 묻지 않음 · 대화가 없는 팀원 · 「앞으로 …」는 회사가 먼저 · 남의 카드 403', { skip: !db && 'no database' }, async () => {
  const { me, k, p, c, ace, weekly, dm, c1 } = await setup()
  const before = llm.judges
  const r = await call(me, 'GET', `/actions/${c1.id}/rooms`)
  assert.equal(r.status, 200, r.text)
  assert.equal(r.body.rooms[0].id, ace)
  assert.equal(r.body.rooms[0].suggested, true)
  assert.deepEqual(r.body.rooms[0].why.map((w) => w.kind), ['judge'])
  assert.equal(r.body.rooms[0].p, 0.82)
  assert.deepEqual(r.body.rooms.filter((x) => x.id !== ace).map((x) => x.suggested), [false, false])
  assert.ok(r.body.rooms.some((x) => x.id === weekly) && r.body.rooms.some((x) => x.id === dm))
  assert.equal(llm.judges, before + 1, '판정 한 번')
  // (김서연 has a conversation of two with me already: found through it)
  const ids = r.body.people.map((x) => x.id)
  assert.ok(ids.includes(p.id) && ids.includes(c.id))
  assert.ok(!ids.includes(k.id) && !ids.includes(me.id))
  assert.equal(r.body.people.find((x) => x.id === c.id).name, '최유나')
  assert.deepEqual(r.body.choices.map((x) => x.by), ['sender', 'domain'], '데모 메일함은 스레드가 없다')
  assert.equal(r.body.choice, 'domain')
  assert.deepEqual(r.body.shared, [])
  // asked once: the pick stays on the card while the rooms are the same
  assert.equal((await call(me, 'GET', `/actions/${c1.id}/rooms`)).body.rooms[0].id, ace)
  assert.equal(llm.judges, before + 1, '다시 열면 묻지 않는다')
  assert.equal((await card(c1.id)).source.room_suggest.picks[0].key, ace)
  // someone else's card
  assert.equal((await call(k, 'GET', `/actions/${c1.id}/rooms`)).status, 403)
  assert.equal((await call(k, 'POST', `/actions/${c1.id}/rooms`, { room: ace })).status, 403)
})

test('보내기: 방에 메일 멘션 · 동료는 요약만 · 알림 · 카드에 남음 / 팀원에게 바로(1:1) · 본문은 켠 방만 / 정할 수 없는 약속은 거절(보내지 않음)', { skip: !db && 'no database' }, async () => {
  const { me, k, p, c, ace, c1 } = await setup()
  const s = await call(me, 'POST', `/actions/${c1.id}/rooms`, { room: ace, note: '견적 요청 왔어요. 김서연님 확인 부탁해요', follow: 'domain' })
  assert.equal(s.status, 200, s.text)
  assert.deepEqual(s.body.room, { id: ace, title: '예시정밀 납품' })
  const seen = (await messagesOf(k, ace)).find((m) => m.id === s.body.message)
  assert.equal(seen.kind, 'mailref')
  assert.equal(seen.body, '견적 요청 왔어요. 김서연님 확인 부탁해요')
  assert.equal(seen.refs[0].subject, '3분기 부품 견적 요청드립니다')
  assert.equal(seen.refs[0].state.card, 'summary', '동료는 요약만')
  assert.ok(!JSON.stringify(seen).includes('견적을 부탁드립니다'), '본문은 메시지에 없다')
  const told = await q(`select title from notifications where user_id=$1 and type='team'`, [p.id])
  assert.ok(told.some((n) => n.title === '정하윤님이 메일 「3분기 부품 견적 요청드립니다」를 멘션했어요'), told.map((n) => n.title).join(' | '))
  const row = await card(c1.id)
  assert.equal(row.source.room_posts[ace].message, s.body.message)
  assert.deepEqual([row.source.room_follow[ace].by, row.source.room_follow[ace].key, row.source.room_follow[ace].body], ['domain', 'ace-precision.example', false])
  assert.equal(row.source.mail_share, undefined, '본문은 공유하지 않았다')
  // straight to a teammate: the conversation of two is made, the body shared there only
  const d = await call(me, 'POST', `/actions/${c1.id}/rooms`, { person: c.id, body: true })
  assert.equal(d.status, 200, d.text)
  rooms.push(d.body.room.id)
  assert.equal(d.body.room.title, '최유나')
  const theirs = (await messagesOf(c, d.body.room.id)).find((m) => m.id === d.body.message)
  assert.equal(theirs.refs[0].state.card, 'shared')
  assert.equal((await messagesOf(k, ace)).find((m) => m.id === s.body.message).refs[0].state.card, 'summary', '다른 방은 여전히 요약')
  const list = (await call(me, 'GET', `/actions/${c1.id}/rooms`)).body.shared
  assert.deepEqual(list.map((x) => [x.room, x.body, x.follow?.by || null]).sort(), [[ace, false, 'domain'], [d.body.room.id, true, null]].sort())
  // a rule this mail does not offer (no thread in a demo mailbox): refused, nothing sent
  const n0 = (await messagesOf(me, ace)).length
  const bad = await call(me, 'POST', `/actions/${c1.id}/rooms`, { room: ace, follow: 'thread' })
  assert.equal(bad.status, 400)
  assert.equal((await messagesOf(me, ace)).length, n0)
  // a room I am not in
  const notMine = await call(me, 'POST', `/actions/${c1.id}/rooms`, { room: 'room-that-is-not-mine' })
  assert.equal(notMine.status, 404)
  // someone signed in but not on the team: no rooms, and nobody is made a conversation with; nor is oneself
  const outsider = await person('외부인', { team: false })
  assert.equal((await call(outsider, 'GET', `/actions/${c1.id}/rooms`)).status, 403)
  assert.equal((await call(me, 'POST', `/actions/${c1.id}/rooms`, { person: outsider.id })).status, 403)
  assert.equal((await call(me, 'POST', `/actions/${c1.id}/rooms`, { person: me.id })).status, 403)
  assert.equal((await q(`select count(*)::int n from chat_rooms where participants @> $1::jsonb`, [JSON.stringify([{ id: outsider.id }])]))[0].n, 0)
  // a send that is not posted after all (someone in the room is no longer on the team) turns off what it turned on
  const gone = await person('퇴사자')
  const t = await call(me, 'POST', '/team/threads', { members: [k.id, gone.id], title: '롤백 방' })
  rooms.push(t.body.id)
  await q(`delete from pro_team_members where user_id=$1`, [gone.id])
  const failed = await call(me, 'POST', `/actions/${c1.id}/rooms`, { room: t.body.id, body: true })
  assert.equal(failed.status, 403, failed.text)
  assert.equal((await card(c1.id)).source.mail_share?.[t.body.id], undefined, '본문 공유가 켜진 채 남지 않는다')
  assert.equal((await card(c1.id)).source.room_posts?.[t.body.id], undefined)
})

test('메일이 오면: 약속한 회사의 새 메일은 그 방에 저절로(약속의 말 · 요약만) · 다른 회사는 아님 · Home 카드가 없는 메일도(끝난 카드로)', { skip: !db && 'no database' }, async () => {
  const { me, k, ace, c1 } = await setup()
  const JUNHO = '이준호 <junho@ace-precision.example>'
  const m2 = await mail(me, JUNHO, '납품 일정 변경 안내', '다음 주 납품이 하루 늦어집니다.')
  const m3 = await mail(me, '한소희 <sohee@other-maker.example>', '신제품 소개', '신제품을 소개합니다.')
  const m4 = await mail(me, 'notice@ace-precision.example', '[공지] 사무실 이전', '사무실을 옮깁니다.')
  llm.triage = { actions: [
    { mail_id: m2, verb: 'Review', kind: 'task', text: '예시정밀 납품 일정 변경을 확인합니다.', icon_domain: '', due: null, prompt: '확인' },
    { mail_id: m3, verb: 'Review', kind: 'task', text: '신제품 소개를 읽어 봅니다.', icon_domain: '', due: null, prompt: '읽기' },
  ], brief: '' }
  const n0 = (await messagesOf(k, ace)).length
  try { await pollUser(me.id) } finally { llm.triage = { actions: [], brief: '' } }
  const now = await messagesOf(k, ace)
  const auto = now.filter((m) => m.auto)
  assert.equal(now.length - n0, 2, '예시정밀 메일 두 통만')
  assert.deepEqual(auto.map((m) => m.refs[0].subject).sort(), ['[공지] 사무실 이전', '납품 일정 변경 안내'])
  for (const m of auto) {
    assert.equal(m.body, 'ace-precision.example에서 오는 메일은 이 방에 올리기로 했어요.')
    assert.equal(m.auto.by, 'domain')
    assert.equal(m.refs[0].state.card, 'summary', '약속은 본문 공유 없이 정했다')
    assert.equal(m.sender.name, '정하윤')
  }
  assert.ok(!now.some((m) => m.refs?.[0]?.subject === '신제품 소개'))
  const [a2] = await q(`select * from pro_actions where user_id=$1 and source->>'mail_id'=$2`, [me.id, m2])
  assert.equal(a2.status, 'open')
  assert.equal(a2.source.room_posts[ace].auto.card, c1.id)
  const [a4] = await q(`select * from pro_actions where user_id=$1 and source->>'mail_id'=$2`, [me.id, m4])
  assert.deepEqual([a4.status, a4.source.by_rule], ['done', true], 'Home 카드가 없던 메일은 끝난 카드로')
  // the sheet of a mail a rule brought says so
  const sh = (await call(me, 'GET', `/actions/${a2.id}/rooms`)).body.shared.find((x) => x.room === ace)
  assert.deepEqual([sh.auto.label, sh.auto.on, sh.follow], ['ace-precision.example에서 오는 메일', true, null])
  assert.deepEqual(Object.keys((await call(me, 'GET', `/actions/${a2.id}/rooms?only=shared`)).body), ['shared'], '공유한 곳만 — 판정은 묻지 않는다')
  void m3
})

test('끄기: 저절로 온 메일의 시트에서 약속 끄기 → 다음 메일은 안 감 · 본문 공유 끄기 → 동료 카드가 요약으로 · 나간 방의 약속은 치움', { skip: !db && 'no database' }, async () => {
  const { me, k, c, ace, weekly, c1 } = await setup()
  const [a2] = await q(`select * from pro_actions where user_id=$1 and source ? 'room_posts' and source->'room_posts'->$2->'auto' is not null limit 1`, [me.id, ace])
  const off = await call(me, 'POST', `/actions/${a2.id}/rooms/${ace}/stop`, { what: 'follow' })
  assert.equal(off.status, 200, off.text)
  assert.equal((await card(c1.id)).source.room_follow?.[ace], undefined, '약속을 정한 카드에서 치움')
  assert.equal((await card(a2.id)).source.room_posts[ace].auto.off, true)
  assert.equal((await call(me, 'GET', `/actions/${a2.id}/rooms?only=shared`)).body.shared.find((x) => x.room === ace).auto.on, false)
  const n0 = (await messagesOf(k, ace)).length
  const m5 = await mail(me, HANEUL, '견적 회신 요청', '견적 회신을 기다립니다.')
  llm.triage = { actions: [{ mail_id: m5, verb: 'Review', kind: 'task', text: '견적 회신 요청을 확인합니다.', icon_domain: '', due: null, prompt: '확인' }], brief: '' }
  try { await pollUser(me.id) } finally { llm.triage = { actions: [], brief: '' } }
  assert.equal((await messagesOf(k, ace)).length, n0, '약속을 끄면 다음 메일은 가지 않는다')
  // the body shared with 최유나's conversation, no more: her card says summary at once
  const dmRoom = Object.keys((await card(c1.id)).source.mail_share || {})[0]
  assert.ok(dmRoom)
  assert.equal((await call(me, 'POST', `/actions/${c1.id}/rooms/${dmRoom}/stop`, { what: 'body' })).status, 200)
  const hers = (await messagesOf(c, dmRoom)).find((m) => m.kind === 'mailref')
  assert.equal(hers.refs[0].state.card, 'summary')
  assert.equal((await card(c1.id)).source.mail_share?.[dmRoom], undefined)
  // a removed teammate still sees where their mail is shared (and can switch it off)
  await q(`delete from pro_team_members where user_id=$1`, [me.id])
  try { assert.equal((await call(me, 'GET', `/actions/${c1.id}/rooms?only=shared`)).status, 200) } finally { await q(`insert into pro_team_members(tenant_id,user_id,added_by) values ('localhost',$1,$1) on conflict do nothing`, [me.id]) }
  // a rule for a room I left: put away at the next mail, nothing posted
  const r = await call(me, 'POST', `/actions/${c1.id}/rooms`, { room: weekly, follow: 'sender' })
  assert.equal(r.status, 200, r.text)
  await q(`update chat_rooms set participants = (select jsonb_agg(p) from jsonb_array_elements(participants) p where p->>'id' <> $2) where id=$1`, [weekly, me.id])
  const m6 = await mail(me, HANEUL, '추가 견적', '추가 견적입니다.')
  llm.triage = { actions: [{ mail_id: m6, verb: 'Review', kind: 'task', text: '추가 견적을 확인합니다.', icon_domain: '', due: null, prompt: '확인' }], brief: '' }
  try { await pollUser(me.id) } finally { llm.triage = { actions: [], brief: '' } }
  assert.equal((await card(c1.id)).source.room_follow?.[weekly], undefined, '나간 방의 약속은 치운다')
  assert.equal((await q(`select count(*)::int n from chats where id=$1 and messages->'pgpt'->'auto' is not null`, [weekly]))[0].n, 0)
  // nothing to stop
  assert.equal((await call(me, 'POST', `/actions/${c1.id}/rooms/${ace}/stop`, { what: 'follow' })).status, 404)
  assert.equal((await call(me, 'POST', `/actions/${c1.id}/rooms/${ace}/stop`, { what: 'everything' })).status, 400)
  void MR
})

test('본문까지 정한 약속: 새 메일의 본문도 그 방에서만, 첨부 파일은 저절로 공유하지 않음 → 「본문 끄기」는 약속의 본문도 끔 · 다른 회사의 약속 · 팀에서 빠진 사람은 약속을 지우지 않음', { skip: !db && 'no database' }, async () => {
  const me = await person('한서진', { mailbox: true }), c = await person('윤가람'), x = await person('도하율')
  await seenSamples(me)
  const room = await call(me, 'POST', '/team/threads', { members: [c.id, x.id], title: '루멘 협업' })
  rooms.push(room.body.id)
  const LUMEN = '정다온 <daon@lumen-works.example>'
  const m0 = await mail(me, LUMEN, '공동 개발 범위 협의', '공동 개발 범위를 정리했습니다.')
  const c0 = await cardOf(me, m0, LUMEN, '공동 개발 범위 협의')
  await q('insert into pro_mail_seen values ($1,$2) on conflict do nothing', [me.id, m0])
  const set = await call(me, 'POST', `/actions/${c0.id}/rooms`, { room: room.body.id, body: true, follow: 'domain' })
  assert.equal(set.status, 200, set.text)
  const rule = (await card(c0.id)).source.room_follow[room.body.id]
  assert.deepEqual([rule.by, rule.key, rule.body, rule.tenant], ['domain', 'lumen-works.example', true, 'localhost'])
  assert.equal(rule.label, undefined, '약속은 말이 아니라 by · key 로 남는다')
  // the rule's body share: the new mail's body reads in that room, its files are never shared by the rule
  const m1 = await mail(me, '서지안 <jian@lumen-works.example>', '시제품 일정', '시제품은 12월 둘째 주에 나옵니다.')
  llm.triage = { actions: [{ mail_id: m1, verb: 'Review', kind: 'task', text: '시제품 일정을 확인합니다.', icon_domain: '', due: null, prompt: '확인' }], brief: '' }
  try { await pollUser(me.id) } finally { llm.triage = { actions: [], brief: '' } }
  const auto1 = (await messagesOf(c, room.body.id)).find((m) => m.auto && m.refs?.[0]?.subject === '시제품 일정')
  assert.ok(auto1, '약속대로 올라갔다')
  assert.equal(auto1.refs.length, 1, '첨부 멘션은 저절로 붙지 않는다')
  assert.equal(auto1.refs[0].state.card, 'shared')
  assert.ok(!auto1.body.includes('@'), '방에 가는 말에 주소가 없다')
  // 본문 끄기 on the card that holds the rule: the rule shares no more bodies either
  assert.equal((await call(me, 'POST', `/actions/${c0.id}/rooms/${room.body.id}/stop`, { what: 'body' })).status, 200)
  assert.equal((await card(c0.id)).source.room_follow[room.body.id].body, false)
  const m2 = await mail(me, '서지안 <jian@lumen-works.example>', '시제품 사진', '사진을 보냅니다.')
  llm.triage = { actions: [{ mail_id: m2, verb: 'Review', kind: 'task', text: '시제품 사진을 봅니다.', icon_domain: '', due: null, prompt: '확인' }], brief: '' }
  try { await pollUser(me.id) } finally { llm.triage = { actions: [], brief: '' } }
  const auto2 = (await messagesOf(c, room.body.id)).find((m) => m.auto && m.refs?.[0]?.subject === '시제품 사진')
  assert.equal(auto2.refs[0].state.card, 'summary')
  // 「본문 끄기」 on a mail the rule brought: the rule's body goes off too
  await q(`update pro_actions set source = jsonb_set(source, array['room_follow', $2::text, 'body'], 'true') where id=$1`, [c0.id, room.body.id])
  const [a1] = await q(`select id from pro_actions where user_id=$1 and source->>'mail_id'=$2`, [me.id, m1])
  assert.equal((await call(me, 'POST', `/actions/${a1.id}/rooms/${room.body.id}/stop`, { what: 'body' })).status, 200)
  assert.equal((await card(c0.id)).source.room_follow[room.body.id].body, false, '그 메일을 데려온 약속의 본문도 꺼진다')
  // a rule set in another tenant is neither used nor put away by a poll in this one
  await q(`update pro_actions set source = jsonb_set(source, array['room_follow', $2::text, 'tenant'], '"other-tenant"') where id=$1`, [c0.id, room.body.id])
  const n0 = (await messagesOf(c, room.body.id)).length
  const m3 = await mail(me, '서지안 <jian@lumen-works.example>', '다른 회사 공간의 약속', '…')
  try { await pollUser(me.id) } finally { llm.triage = { actions: [], brief: '' } }
  assert.equal((await messagesOf(c, room.body.id)).length, n0)
  assert.equal((await card(c0.id)).source.room_follow[room.body.id].tenant, 'other-tenant', '지우지 않는다')
  await q(`update pro_actions set source = jsonb_set(source, array['room_follow', $2::text, 'tenant'], '"localhost"') where id=$1`, [c0.id, room.body.id])
  // someone in the room no longer on the team: that post fails, the rule stays (only leaving the room puts it away)
  await q(`delete from pro_team_members where user_id=$1`, [x.id])
  const m4 = await mail(me, '서지안 <jian@lumen-works.example>', '팀이 바뀐 뒤', '…')
  try { await pollUser(me.id) } finally { llm.triage = { actions: [], brief: '' } }
  assert.ok((await card(c0.id)).source.room_follow[room.body.id], '약속이 남는다')
  void m3; void m4
})
