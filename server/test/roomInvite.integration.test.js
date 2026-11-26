// 단체방에 사람 초대(2026-11-25 사용자 「기존 단체 메신저 대화창에서 신규인원 초대가 가능해야.」): lib/team/messenger.js invite,
// POST /api/team/rooms/:id/invite. 지어낸 사람으로 로컬 Supabase 에 대고 돈다(화면은 e2e F-MS-03~05).
//   MS-I-01 권한: 방 사람이 아니면 404 · 다른 회사 사람 · 에이전트 · 팀원이 아닌 사람은 403 · 1:1 방은 400(단체방을 만들어야)
//   MS-I-02 같은 사람을 또 초대하면 아무 일도 없다(참여자 · 시스템 줄 그대로), 둘을 동시에 초대해도 한 번씩
//   MS-I-03 참여자 모양: Process GPT 의 것 그대로 — {id, email, username: users.username, profile, agent_type: null, is_agent: false}, 뒤에 붙음
//   MS-I-04 시스템 줄(role 'system', 보는 사람의 언어 · 화면 이름) · 새 사람은 방의 지난 메시지를 다 본다 · 'room' 알림 · 초대받은 사람의 'team' 알림
//   MS-I-05 인원 한도 없음(2026-11-27 「그룹대화 인원 한도 없어」 — 전엔 8명): 열 명으로 만들고 열두 명을 더 초대, 한 요청의 인원만 PER_REQUEST 까지
// Run: node --test --test-concurrency=1 test/roomInvite.integration.test.js  (로컬 Supabase)
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

const { q, pool } = await import('../lib/supa.js')
const { config } = await import('../config.js')
const { withLang } = await import('../lib/lang.js')
const bus = await import('../lib/bus.js')
const db = await q('select 1 from chat_rooms limit 1').then(() => true).catch(() => false)
const T = config.tenantId
const stamp = Date.now().toString(36)
const made = { users: [], rooms: [] }

const OTHER_T = `ms-other-${stamp}`
async function person(username, profileName, { tenant = T, team = true, agent = false } = {}) {
  const id = crypto.randomUUID()
  if (tenant !== T) await q('insert into tenants (id) values ($1) on conflict do nothing', [tenant])
  const email = `ms-inv-${crypto.randomBytes(3).toString('hex')}-${stamp}@people.test`
  await q('insert into users (id, email, username, tenant_id, is_agent) values ($1,$2,$3,$4,$5)', [id, email, username, tenant, agent])
  if (profileName) await q('insert into pro_profile (user_id, name, email) values ($1,$2,$3)', [id, profileName, email])
  if (team) await q('insert into pro_team_members (tenant_id, user_id, added_by) values ($1,$2,$2) on conflict do nothing', [tenant, id])
  made.users.push(id)
  return { id, email, username, name: profileName || username }
}
let M, A, B, C, D, OUT, OTHER, BOT
async function setup() {
  if (M) return
  M = await import('../lib/team/messenger.js')
  A = await person(`ms-inv-a-${stamp}`, '정하윤')      // starts the room; Process GPT's username is the address's style
  B = await person(`김서연${stamp}`, '김서연')
  C = await person(`박도윤${stamp}`, '박도윤')
  D = await person(`봉여울${stamp}`, 'Yeoul Bong')     // to be invited: Lite's name differs from Process GPT's
  OUT = await person(`밖사람${stamp}`, '밖사람', { team: false })                     // of this company, not on the team
  OTHER = await person(`남의회사${stamp}`, '남의회사', { tenant: OTHER_T })            // another company
  BOT = await person(`도우미${stamp}`, null, { agent: true })
}
const me = (p) => ({ id: p.id, email: p.email, name: p.name })
const events = (id, type) => bus.poll(id, 0, 0).then((l) => l.filter((e) => e.type === 'team' && e.data?.type === type))

after(async () => {
  for (const id of made.rooms) {
    await q('delete from chats where id=$1', [id]).catch(() => {})
    await q('delete from pro_chat_reads where room_id=$1', [id]).catch(() => {})
    await q('delete from notifications where url like $1', [`%${id}%`]).catch(() => {})
    await q('delete from chat_rooms where id=$1', [id]).catch(() => {})
  }
  for (const id of made.users) {
    await q('delete from notifications where user_id=$1', [id]).catch(() => {})
    await q('delete from pro_team_members where user_id=$1', [id]).catch(() => {})
    await q('delete from pro_profile where user_id=$1', [id]).catch(() => {})
    await q('delete from users where id=$1', [id]).catch(() => {})
  }
  await q('delete from pro_team_members where tenant_id=$1', [OTHER_T]).catch(() => {})
  await q('delete from tenants where id=$1', [OTHER_T]).catch(() => {})
  await pool.end()
})

test('MS-I-01 권한: 방 사람만, 이 회사의 팀원만, 사람만 — 1:1 방은 초대 대신 단체방', { skip: !db }, async () => {
  await setup()
  const g = await M.groupThread(me(A), [B.id, C.id], '')
  made.rooms.push(g.id)
  // not in the room (D), or a room of another company: "not found"
  await assert.rejects(M.invite(me(D), g.id, [B.id]), (e) => e.status === 404)
  await assert.rejects(M.invite(me(A), crypto.randomUUID(), [D.id]), (e) => e.status === 404)
  // only this company's teammates, only people
  for (const who of [OUT, OTHER, BOT]) await assert.rejects(M.invite(me(A), g.id, [who.id]), (e) => e.status === 403, who.username)
  await assert.rejects(M.invite(me(A), g.id, []), (e) => e.status === 400)
  // a 1:1 room stays private
  const d = await M.directThread(me(A), B.id)
  made.rooms.push(d.id)
  await assert.rejects(M.invite(me(A), d.id, [C.id]), (e) => e.status === 400)
  const [dr] = await q('select participants from chat_rooms where id=$1', [d.id])
  assert.equal(dr.participants.length, 2)
  const [gr] = await q('select participants from chat_rooms where id=$1', [g.id])
  assert.equal(gr.participants.length, 3)
})

test('MS-I-02 같은 사람을 또 초대하면 아무 일도 없다 · 동시에 초대해도 한 번씩', { skip: !db }, async () => {
  await setup()
  const g = await M.groupThread(me(A), [B.id], '')
  made.rooms.push(g.id)
  const first = await M.invite(me(A), g.id, [D.id])
  assert.deepEqual(first.added.map((p) => p.id), [D.id])
  const again = await M.invite(me(B), g.id, [D.id, A.id])
  assert.deepEqual(again.added, [])
  const [r] = await q('select participants from chat_rooms where id=$1', [g.id])
  assert.deepEqual(r.participants.map((p) => p.id), [A.id, B.id, D.id])
  const lines = await q(`select 1 from chats where id=$1 and messages->'pgpt'->>'kind'='invite'`, [g.id])
  assert.equal(lines.length, 1)
  // two at once: each person once, one line between them
  const both = await Promise.all([M.invite(me(A), g.id, [C.id]), M.invite(me(B), g.id, [C.id])])
  assert.equal(both.filter((x) => x.added.length).length, 1)
  const [r2] = await q('select participants from chat_rooms where id=$1', [g.id])
  assert.equal(r2.participants.filter((p) => p.id === C.id).length, 1)
  assert.equal((await q(`select 1 from chats where id=$1 and messages->'pgpt'->>'kind'='invite'`, [g.id])).length, 2)
})

test('MS-I-03 참여자는 Process GPT 의 모양 그대로, users.username 으로 뒤에 붙는다', { skip: !db }, async () => {
  await setup()
  await q('update users set profile=$1 where id=$2 and tenant_id=$3', ['/assets/images/profile/7.jpg', D.id, T])
  const g = await M.groupThread(me(A), [B.id, C.id], '')
  made.rooms.push(g.id)
  await M.invite(me(A), g.id, [D.id])
  const [r] = await q('select participants from chat_rooms where id=$1', [g.id])
  assert.deepEqual(r.participants.at(-1), { id: D.id, email: D.email, username: D.username, profile: '/assets/images/profile/7.jpg', agent_type: null, is_agent: false })
  assert.deepEqual(Object.keys(r.participants[0]).sort(), Object.keys(r.participants.at(-1)).sort())
  // the screens: the name every screen uses
  assert.deepEqual((await M.membersOf(g.id)).map((m) => m.name), ['정하윤', '김서연', '박도윤', 'Yeoul Bong'])
})

test('MS-I-04 시스템 줄 · 지난 메시지 · 방의 새 구성원을 바로 · 초대받은 사람의 알림', { skip: !db }, async () => {
  await setup()
  const g = await M.groupThread(me(A), [B.id, C.id], '견적 회의')
  made.rooms.push(g.id)
  await M.post(me(B), g.id, { body: '견적 세 곳 비교해 볼까요?' })
  await M.post(me(A), g.id, { body: '좋아요, 표로 정리할게요.' })
  const before = bus.lastSeq()
  const r = await M.invite(me(A), g.id, [D.id])
  assert.deepEqual(r.added, [{ id: D.id, name: 'Yeoul Bong' }])
  // the row Process GPT reads: a system line, from the one who invited
  const [row] = await q(`select messages from chats where id=$1 and messages->'pgpt'->>'kind'='invite'`, [g.id])
  assert.equal(row.messages.role, 'system')
  assert.equal(row.messages.email, A.email)
  assert.equal(row.messages.content, '정하윤님이 Yeoul Bong님을 초대했어요')
  // the new member sees the room's history (Process GPT reads chats by the room id alone) and the line, in their language
  const seen = await M.messages(me(D), g.id)
  assert.deepEqual(seen.messages.map((m) => m.kind), ['text', 'text', 'invite'])
  assert.equal(seen.messages[0].body, '견적 세 곳 비교해 볼까요?')
  assert.equal(seen.messages[2].body, '정하윤님이 Yeoul Bong님을 초대했어요')
  assert.deepEqual(seen.thread.members.map((m) => m.name), ['정하윤', '김서연', '박도윤', 'Yeoul Bong'])
  const en = await withLang('en', () => M.messages(me(D), g.id))
  assert.equal(en.messages[2].body, '정하윤 invited Yeoul Bong')
  // the room's list for the new member has it, with everyone
  const t = (await M.listThreads(me(D))).find((x) => x.id === g.id)
  assert.deepEqual(t.members.map((m) => m.name), ['정하윤', '김서연', '박도윤', 'Yeoul Bong'])
  // everyone in the room (the invited too) hears of the new member list at once, and gets the line
  for (const p of [A, B, C, D]) {
    const ev = (await events(p.id, 'room')).filter((e) => e.data.threadId === g.id)
    assert.ok(ev.length, p.name)
    assert.deepEqual(ev.at(-1).data.members.map((m) => m.id), [A.id, B.id, C.id, D.id])
    const msgs = (await bus.poll(p.id, before, 0)).filter((e) => e.type === 'team' && e.data.type === 'message' && e.data.threadId === g.id)
    assert.equal(msgs.at(-1)?.data.message.kind, 'invite', p.name)
  }
  // the invited: a 'team' notice that opens the room in Lite
  const [n] = await q(`select title, url, from_user_id from notifications where user_id=$1 and type='team' and url like $2`, [D.id, `/pro/team/${g.id}/%`])
  assert.deepEqual(n, { title: '정하윤님이 대화방에 초대했어요 · 견적 회의', url: `/pro/team/${g.id}/${(await q(`select uuid from chats where id=$1 and messages->'pgpt'->>'kind'='invite'`, [g.id]))[0].uuid}`, from_user_id: A.email })
})

test('MS-I-05 단체방 인원 한도 없음 — 열한 명으로 만들고 열두 명을 더 초대(전엔 8명에서 막힘), 한 번의 요청만 PER_REQUEST 명까지', { skip: !db }, async () => {
  await setup()
  const crowd = []
  for (let i = 0; i < 22; i++) crowd.push(await person(`ms-crowd-${i}-${stamp}`, `참석자${i + 1}`))
  const g = await M.groupThread(me(A), crowd.slice(0, 10).map((p) => p.id), '전체 공지')
  made.rooms.push(g.id)
  assert.equal((await M.membersOf(g.id)).length, 11)
  const r = await M.invite(me(A), g.id, crowd.slice(10).map((p) => p.id))
  assert.equal(r.added.length, 12)
  assert.equal((await M.membersOf(g.id)).length, 23)
  // a message reaches all of them
  const m = await M.post(me(A), g.id, { body: '모두 들어왔나요?' })
  assert.equal(m.body, '모두 들어왔나요?')
  // one request is bounded (each id is checked one by one), the room is not
  const many = Array.from({ length: M.PER_REQUEST + 1 }, () => crypto.randomUUID())
  await assert.rejects(M.invite(me(A), g.id, many), /한 번에 500명까지/)
  await assert.rejects(M.groupThread(me(A), many, '너무 많은 한 번'), /한 번에 500명까지/)
})
