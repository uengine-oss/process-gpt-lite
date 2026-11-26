// 대화방 이름 · 말풍선 반응(2026-11-26 사용자 「대화방 설정으로 대화방 명칭 바꿀 수 있게하고 다른 사람 말풍선에 좋아요 확인했음 사랑해 웃음 등을
// 붙힐 수 있게」): lib/team/messenger.js rename · lib/team/reactions.js. 지어낸 사람으로 로컬 Supabase 에 대고 돈다(화면은 e2e F-RX-01~06).
//   RX-I-01 이름 권한: 방 사람이면 누구나(Process GPT 와 같음), 방 밖 404, 다른 회사의 방 404(참여자 목록에 있어도), 1:1 400, 51자 400
//   RX-I-02 이름: chat_rooms.name 에(Process GPT 의 칸) · 시스템 줄(보는 사람의 언어 · 「(으)로」) · 'room' 알림 · 같은 이름은 아무 일 없음 ·
//           빈 이름 → null, 다시 사람들 이름으로 · Process GPT 의 자동 이름 짓기는 손대지 않게(auto_name_pending false)
//   RX-I-03 이름은 조용히: Process GPT 의 'chat' 알림은 읽은 것으로(홈 카드 · 푸시 없음), 읽지 않은 수에 들지 않는다
//   RX-I-04 반응: 남의 말풍선에 켜고 끄기(두 번 누르면 꺼짐 · on 지정), 여러 종류 · 여러 사람, 방 사람마다 'reactions' 알림(각자의 「내 것」),
//           방의 메시지 목록에 반응, 같은 사람이 동시에 두 번 눌러도 한 번
//   RX-I-05 반응 권한: 내 메시지 · 시스템 줄 400, 모르는 종류 400, 방 밖 · 다른 회사 404 — 반응은 알림 행을 만들지 않는다
//   RX-I-06 RLS: 화면 키(authenticated)로는 같은 회사이면서 그 방의 사람만 반응 행을 읽고, 아무도 쓰지 못한다
// Run: node --test --test-concurrency=1 test/roomRenameReactions.integration.test.js  (로컬 Supabase, sql/062 적용)
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

const { q, pool } = await import('../lib/supa.js')
const { config } = await import('../config.js')
const { withLang } = await import('../lib/lang.js')
const bus = await import('../lib/bus.js')
const db = await q('select 1 from pro_chat_reactions limit 1').then(() => true).catch(() => false)
const T = config.tenantId
const stamp = Date.now().toString(36)
const made = { users: [], rooms: [] }
const OTHER_T = `rx-other-${stamp}`

async function person(username, profileName, { tenant = T, team = true } = {}) {
  const id = crypto.randomUUID()
  if (tenant !== T) await q('insert into tenants (id) values ($1) on conflict do nothing', [tenant])
  const email = `rx-${crypto.randomBytes(3).toString('hex')}-${stamp}@people.test`
  await q('insert into users (id, email, username, tenant_id) values ($1,$2,$3,$4)', [id, email, username, tenant])
  if (profileName) await q('insert into pro_profile (user_id, name, email) values ($1,$2,$3)', [id, profileName, email])
  if (team) await q('insert into pro_team_members (tenant_id, user_id, added_by) values ($1,$2,$2) on conflict do nothing', [tenant, id])
  made.users.push(id)
  return { id, email, username, name: profileName || username }
}
let M, A, B, C, D, O
async function setup() {
  if (M) return
  M = await import('../lib/team/messenger.js')
  A = await person(`rx-a-${stamp}`, '정하윤')
  B = await person(`김서연${stamp}`, '김서연')
  C = await person(`박도윤${stamp}`, '박도윤')
  D = await person(`최도현${stamp}`, '최도현')                         // on the team, not in the rooms below
  O = await person(`남의회사${stamp}`, '남의회사', { tenant: OTHER_T })  // another company
}
const me = (p) => ({ id: p.id, email: p.email, name: p.name })
const room = async (who, ids, title = '') => { const g = await M.groupThread(me(who), ids, title); made.rooms.push(g.id); return g }
const teamEvents = (id, after, type) => bus.poll(id, after, 0).then((l) => l.filter((e) => e.type === 'team' && e.data?.type === type))

after(async () => {
  for (const id of made.rooms) {
    await q('delete from pro_chat_reactions where room_id=$1', [id]).catch(() => {})
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

// a room of another company that even lists A among its people (an id someone got hold of): never found from here
async function otherCompanyRoom() {
  const id = crypto.randomUUID()
  await q(`insert into chat_rooms(id, participants, message, name, tenant_id, context) values ($1,$2,$3,null,$4,$5)`,
    [id, JSON.stringify([O, A].map((p) => ({ id: p.id, email: p.email, username: p.username, profile: '/images/defaultUser.png', agent_type: null, is_agent: false }))),
      { msg: 'NEW', type: 'text', createdAt: new Date().toISOString() }, OTHER_T, { pgpt: { kind: 'group', assist: true } }])
  made.rooms.push(id)
  const uuid = crypto.randomUUID()
  await q('insert into chats(uuid, id, messages, tenant_id) values ($1,$2,$3,$4)', [uuid, id, { uuid, role: 'user', content: '남의 회사 이야기', email: O.email, userId: O.id, timeStamp: new Date().toISOString() }, OTHER_T])
  return { id, uuid }
}

test('RX-I-01 이름 권한 — 방 사람 누구나, 방 밖 · 다른 회사 404, 1:1 400, 51자 400', { skip: !db }, async () => {
  await setup()
  const g = await room(A, [B.id, C.id])
  // any of its people, not only who made it (Process GPT's room settings have no owner check)
  assert.equal((await M.rename(me(B), g.id, '견적 회의')).name, '견적 회의')
  await assert.rejects(M.rename(me(D), g.id, '몰래 바꿈'), (e) => e.status === 404)
  await assert.rejects(M.rename(me(A), crypto.randomUUID(), '없는 방'), (e) => e.status === 404)
  const x = await otherCompanyRoom()
  await assert.rejects(M.rename(me(A), x.id, '남의 방'), (e) => e.status === 404)
  assert.equal((await q('select name from chat_rooms where id=$1', [x.id]))[0].name, null)
  const d = await M.directThread(me(A), B.id)
  made.rooms.push(d.id)
  await assert.rejects(M.rename(me(A), d.id, '둘만'), (e) => e.status === 400)
  await assert.rejects(M.rename(me(A), g.id, '가'.repeat(51)), (e) => e.status === 400)
  assert.equal((await q('select name from chat_rooms where id=$1', [g.id]))[0].name, '견적 회의')
})

test('RX-I-02 이름은 chat_rooms.name 에, 시스템 줄과 함께 모두에게 바로 — 빈 이름은 사람들 이름으로', { skip: !db }, async () => {
  await setup()
  const g = await room(A, [B.id, C.id])
  await M.post(me(B), g.id, { body: '3분기 실적 정리해 볼까요?' })
  const before = bus.lastSeq()
  const r = await M.rename(me(A), g.id, '  3분기   영업 ')
  assert.deepEqual(r, { threadId: g.id, name: '3분기 영업', changed: true })
  const [cr] = await q('select name, context from chat_rooms where id=$1', [g.id])
  assert.equal(cr.name, '3분기 영업')
  assert.equal(cr.context.auto_name_pending, false)
  assert.equal(cr.context.pgpt.kind, 'group')                 // (Lite's own part of the context stays)
  // the line Process GPT reads: role system, from the one who named it; 「영업」 ends in ㅂ → 「으로」
  const [line] = await q(`select messages from chats where id=$1 and messages->'pgpt'->>'kind'='rename'`, [g.id])
  assert.equal(line.messages.role, 'system')
  assert.equal(line.messages.content, '정하윤님이 대화방 이름을 「3분기 영업」으로 바꿨어요')
  const seen = await M.messages(me(C), g.id)
  assert.deepEqual(seen.messages.map((m) => m.kind), ['text', 'rename'])
  assert.equal(seen.messages[1].body, '정하윤님이 대화방 이름을 「3분기 영업」으로 바꿨어요')
  assert.equal(seen.messages[1].name, '3분기 영업')
  assert.equal((await withLang('en', () => M.messages(me(C), g.id))).messages[1].body, '정하윤 renamed the conversation to “3분기 영업”')
  // every one of its people: the list's title, at once ('room' with the name) and the line
  for (const p of [A, B, C]) {
    assert.equal((await M.listThreads(me(p))).find((t) => t.id === g.id).title, '3분기 영업', p.name)
    const ev = (await teamEvents(p.id, before, 'room')).filter((e) => e.data.threadId === g.id)
    assert.equal(ev.at(-1)?.data.name, '3분기 영업', p.name)
    const lines = (await teamEvents(p.id, before, 'message')).filter((e) => e.data.threadId === g.id)
    assert.equal(lines.at(-1)?.data.message.kind, 'rename', p.name)
  }
  // the same name again: nothing happens (no second line)
  assert.equal((await M.rename(me(B), g.id, '3분기 영업')).changed, false)
  assert.equal((await q(`select 1 from chats where id=$1 and messages->'pgpt'->>'kind'='rename'`, [g.id])).length, 1)
  // a name with no final consonant: 「로」
  await M.rename(me(B), g.id, '견적 회의')
  assert.equal((await M.messages(me(A), g.id)).messages.at(-1).body, '김서연님이 대화방 이름을 「견적 회의」로 바꿨어요')
  // empty: the name is taken off — the room is called by its people again
  const off = await M.rename(me(C), g.id, '   ')
  assert.deepEqual(off, { threadId: g.id, name: null, changed: true })
  assert.equal((await q('select name from chat_rooms where id=$1', [g.id]))[0].name, null)
  assert.equal((await M.listThreads(me(A))).find((t) => t.id === g.id).title, '김서연, 박도윤')
  assert.equal((await M.messages(me(A), g.id)).messages.at(-1).body, '박도윤님이 대화방 이름을 지웠어요')
  // the list's preview of a rename line: in the reader's language
  assert.equal((await withLang('en', () => M.listThreads(me(A)))).find((t) => t.id === g.id).last.body, "박도윤 removed the conversation's name")
})

test('RX-I-03 이름은 조용히 — Process GPT 의 채팅 알림은 읽은 것, 읽지 않은 수에 들지 않는다', { skip: !db }, async () => {
  await setup()
  const g = await room(A, [B.id, C.id])
  await M.markRead(me(B), g.id)
  await M.rename(me(A), g.id, '주간 회의')
  // Process GPT's chat trigger made a 'chat' notice of the line for B and C — checked in the same transaction
  const ns = await q(`select user_id, is_checked from notifications where type='chat' and url=$1`, [`/chats?id=${g.id}`])
  assert.ok(ns.length >= 2, 'the trigger wrote its notices')
  assert.ok(ns.every((n) => n.is_checked === true), JSON.stringify(ns))
  assert.equal((await q(`select 1 from notifications where type='team' and url like $1`, [`/pro/team/${g.id}/%`])).length, 0)
  assert.equal((await M.unread(me(B))).byThread[g.id] || 0, 0)
  // a message after it still counts
  await M.post(me(A), g.id, { body: '이번 주 안건 올려 주세요' })
  assert.equal((await M.unread(me(B))).byThread[g.id], 1)
})

test('RX-I-04 반응 — 켜고 끄기, 여러 종류 · 여러 사람, 방 사람마다 각자의 「내 것」으로 바로', { skip: !db }, async () => {
  await setup()
  const g = await room(A, [B.id, C.id])
  const m = await M.post(me(B), g.id, { body: '견적서 초안 올렸어요' })
  const before = bus.lastSeq()
  const r1 = await M.react(me(A), m.id, 'like')
  assert.deepEqual(r1, { messageId: m.id, threadId: g.id, reactions: [{ key: 'like', count: 1, mine: true, people: [{ id: A.id, name: '정하윤' }] }] })
  await M.react(me(C), m.id, 'like')
  await M.react(me(C), m.id, 'check')
  // each of the room's people hears of it, with their own 「mine」 — B (whose message it is) among them
  for (const [p, mine] of [[A, true], [B, false], [C, true]]) {
    const ev = (await teamEvents(p.id, before, 'reactions')).filter((e) => e.data.messageId === m.id)
    assert.equal(ev.length, 3, p.name)
    assert.deepEqual(ev.at(-1).data.reactions.map((c) => [c.key, c.count, c.mine]), [['like', 2, mine], ['check', 1, p === C]], p.name)
    assert.equal(ev.at(-1).data.threadId, g.id)
  }
  // in the room's messages: who reacted, in order
  const seen = await M.messages(me(B), g.id)
  const mm = seen.messages.find((x) => x.id === m.id)
  assert.deepEqual(mm.reactions[0].people.map((p) => p.name), ['정하윤', '박도윤'])
  assert.equal(mm.reactions[0].mine, false)
  // asked again: taken off; on given: as given (twice the same: still once)
  assert.deepEqual((await M.react(me(A), m.id, 'like')).reactions.map((c) => [c.key, c.count, c.mine]), [['like', 1, false], ['check', 1, false]])
  await M.react(me(A), m.id, 'love', true)
  await M.react(me(A), m.id, 'love', true)
  assert.deepEqual((await M.react(me(A), m.id, 'like', false)).reactions.map((c) => [c.key, c.count]), [['like', 1], ['check', 1], ['love', 1]])
  // the same person three times at once, or two quick taps that cross: one row, the last word counts
  const m2 = await M.post(me(C), g.id, { body: '확인 부탁해요' })
  await Promise.all([M.react(me(A), m2.id, 'wow', true), M.react(me(A), m2.id, 'wow', true), M.react(me(A), m2.id, 'wow', true)])
  assert.equal((await q(`select count(*)::int n from pro_chat_reactions where chat_uuid=$1 and user_id=$2 and reaction='wow'`, [m2.id, A.id]))[0].n, 1)
  // a message with none: [] in the room's messages (a live copy carries no reactions at all — the screen keeps what it had)
  const m3 = await M.post(me(C), g.id, { body: '반응 없는 말' })
  assert.equal(m3.reactions, undefined)
  assert.deepEqual((await M.messages(me(A), g.id)).messages.find((x) => x.id === m3.id).reactions, [])
})

test('RX-I-05 반응 권한 — 내 메시지 · 시스템 줄 · 모르는 종류 400, 방 밖 · 다른 회사 404, 알림 행은 만들지 않는다', { skip: !db }, async () => {
  await setup()
  const g = await room(A, [B.id])
  const mine = await M.post(me(A), g.id, { body: '내가 쓴 말' })
  const theirs = await M.post(me(B), g.id, { body: '김서연이 쓴 말' })
  await M.rename(me(B), g.id, '둘이 하는 방')
  const line = (await M.messages(me(A), g.id)).messages.find((x) => x.kind === 'rename')
  const notes = async () => (await q('select count(*)::int n from notifications where user_id = any($1)', [[B.id, B.email]]))[0].n
  const n0 = await notes()
  await assert.rejects(M.react(me(A), mine.id, 'like'), (e) => e.status === 400)
  await assert.rejects(M.react(me(A), line.id, 'like'), (e) => e.status === 400)
  await assert.rejects(M.react(me(A), theirs.id, 'angry'), (e) => e.status === 400)
  await assert.rejects(M.react(me(A), theirs.id, ''), (e) => e.status === 400)
  await assert.rejects(M.react(me(D), theirs.id, 'like'), (e) => e.status === 404)
  await assert.rejects(M.react(me(A), crypto.randomUUID(), 'like'), (e) => e.status === 404)
  await assert.rejects(M.react(me(A), "x' or 1=1 --", 'like'), (e) => e.status === 404)
  const x = await otherCompanyRoom()
  await assert.rejects(M.react(me(A), x.uuid, 'like'), (e) => e.status === 404)
  await M.react(me(A), theirs.id, 'like')
  await M.react(me(A), theirs.id, 'love')
  assert.equal(await notes(), n0, 'a reaction makes no notice for the one whose message it is')
  assert.equal((await q('select count(*)::int n from pro_chat_reactions where room_id=$1', [g.id]))[0].n, 2)
  assert.equal((await q('select count(*)::int n from pro_chat_reactions where room_id=$1', [x.id]))[0].n, 0)
})

test('RX-I-06 RLS — 화면 키로는 같은 회사의 그 방 사람만 읽고, 아무도 쓰지 못한다', { skip: !db }, async () => {
  await setup()
  const g = await room(A, [B.id])
  const m = await M.post(me(B), g.id, { body: '읽기 권한 확인' })
  await M.react(me(A), m.id, 'check')
  // as the screen's key would: role authenticated with the person's JWT claims (auth.uid() · public.tenant_id())
  async function asPerson(p, tenant, sql, params = []) {
    const c = await pool.connect()
    try {
      await c.query('begin')
      await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: p.id, role: 'authenticated', app_metadata: { tenant_id: tenant } })])
      await c.query('set local role authenticated')
      return (await c.query(sql, params)).rows
    } finally { await c.query('rollback').catch(() => {}); c.release() }
  }
  const read = (p, tenant) => asPerson(p, tenant, 'select reaction from pro_chat_reactions where room_id=$1', [g.id])
  assert.deepEqual((await read(A, T)).map((r) => r.reaction), ['check'])
  assert.deepEqual((await read(B, T)).map((r) => r.reaction), ['check'])
  assert.deepEqual(await read(D, T), [])          // on the team, not in the room
  assert.deepEqual(await read(A, OTHER_T), [])    // in the room, but asking as another company
  await assert.rejects(asPerson(A, T, `insert into pro_chat_reactions(tenant_id, room_id, chat_uuid, user_id, reaction) values ($1,$2,$3,$4,'like')`, [T, g.id, m.id, A.id]))
  const del = await asPerson(A, T, 'delete from pro_chat_reactions where room_id=$1 returning 1', [g.id]).catch(() => 'refused')
  assert.ok(del === 'refused' || del.length === 0)
  assert.equal((await q('select count(*)::int n from pro_chat_reactions where room_id=$1', [g.id]))[0].n, 1)
})
