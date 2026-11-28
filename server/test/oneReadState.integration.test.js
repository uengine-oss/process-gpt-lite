// 읽음은 하나 — 방 읽음(pro_chat_reads)만(2026-11-28 「받은 편지함 = 대화의 거르개」 1단계: 「이 두 대화창이 같은건데... 어떻게 통일할 방법이
// 없을까?」). 대화 › 나에게 온 것의 항목은 방의 메시지 그대로이고, 보거나 홈 카드를 닫으면 그 방을 그 메시지까지 읽는다: lib/team/messenger.js
// markRead({upTo}) · inbox, lib/notify.js dismiss. 지어낸 사람으로 로컬 Supabase 에 대고 돈다(화면은 e2e F-OL-01~05).
//   OL-I-01 나에게 온 것 = 방 메시지(공유 · 멘션 · 파일 링크 · 메일 멘션 · 질문 · 답, 남이 보낸 것만) · 방의 반응 칩 · 방 읽음으로 안 읽음
//   OL-I-02 그 메시지까지 읽기: 항목 읽음 · 뒤의 메시지는 그대로 안 읽음(방의 수 · 합계) · 그 메시지의 'team' 알림만 확인 · Process GPT 의
//           안 읽음 표시는 남김 — 더 앞의 메시지까지 읽기는 되돌리지 않음 · 다른 방의 메시지 id 는 아무 일 없음
//   OL-I-03 홈 카드(team 알림)를 닫으면 그 방을 그 메시지까지 읽음 · 'read' 알림(그 시각)
//   OL-I-04 방의 'chat' 알림(Process GPT 의 채팅 알림)을 닫으면 그 알림 때까지 읽음
//   OL-I-05 방을 열면(그 메시지 없이) 전부 읽음 · 'team' · 'chat' 알림 모두 확인 · Process GPT 의 안 읽음 표시도 지움
// Run: node --test --test-concurrency=1 test/oneReadState.integration.test.js  (로컬 Supabase)
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

process.env.PRO_BACKGROUND = '0'
const { q, pool } = await import('../lib/supa.js')
const { config } = await import('../config.js')
const bus = await import('../lib/bus.js')
const db = await q('select 1 from pro_chat_reads limit 1').then(() => true).catch(() => false)
const rx = await q('select 1 from pro_chat_reactions limit 1').then(() => true).catch(() => false)
const T = config.tenantId
const stamp = Date.now().toString(36)
const made = { users: [], rooms: [] }
const pause = (ms = 15) => new Promise((ok) => setTimeout(ok, ms))

async function person(username, profileName) {
  const id = crypto.randomUUID()
  const email = `ol-${crypto.randomBytes(3).toString('hex')}-${stamp}@people.test`
  await q('insert into users (id, email, username, tenant_id) values ($1,$2,$3,$4)', [id, email, username, T])
  await q('insert into pro_profile (user_id, name, email) values ($1,$2,$3)', [id, profileName, email])
  await q('insert into pro_team_members (tenant_id, user_id, added_by) values ($1,$2,$2) on conflict do nothing', [T, id])
  made.users.push(id)
  return { id, email, username, name: profileName }
}
let M, N, A, B, C
async function setup() {
  if (M) return
  M = await import('../lib/team/messenger.js')
  N = await import('../lib/notify.js')
  A = await person(`ol-a-${stamp}`, '정하윤')
  B = await person(`ol-b-${stamp}`, '김서연')
  C = await person(`ol-c-${stamp}`, '박도윤')
}
const me = (p) => ({ id: p.id, email: p.email, name: p.name })
async function room(who, ids) {
  const g = ids.length === 1 ? await M.directThread(me(who), ids[0]) : await M.groupThread(me(who), ids, '')
  made.rooms.push(g.id)
  return g
}
const unreadOf = async (who, id) => (await M.unread(me(who))).byThread[id] || 0
const forMe = async (who, id) => (await M.inbox(me(who))).filter((m) => m.threadId === id)
const teamNotice = async (who, msgId, roomId) => (await q(`select id, coalesce(is_checked,false) as checked from notifications where user_id=$1 and type='team' and url=$2`, [who.id, `/pro/team/${roomId}/${msgId}`]))[0]
const flag = async (who, roomId) => (await q(`select p from chat_rooms r, jsonb_array_elements(r.participants) p where r.id=$1 and p->>'id'=$2`, [roomId, who.id]))[0]?.p?.isExistUnReadMessage
const readEvents = (id, from) => bus.poll(id, from, 0).then((l) => l.filter((e) => e.type === 'team' && e.data?.type === 'read'))

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
  await pool.end()
})

test('OL-I-01 나에게 온 것은 방의 메시지 그대로 — 남이 보낸 공유 · 멘션 · 질문 등만, 방의 반응, 방 읽음으로 안 읽음', { skip: !db }, async () => {
  await setup()
  const g = await room(A, [B.id, C.id])
  // (what I send reads the room for me up to it: mine first)
  await M.post(me(B), g.id, { kind: 'mention', body: '내가 보낸 멘션은 내 목록에 없어요' })
  await pause()
  const hi = await M.post(me(A), g.id, { body: '견적서 초안 올려 둘게요' })
  await pause()
  const ask = await M.post(me(A), g.id, { kind: 'mention', body: '김서연님, 가나정밀 납기 확인 부탁해요' })
  const list = await forMe(B, g.id)
  // only another's kinds of 나에게 온 것 — the plain line and my own mention are not in it
  assert.deepEqual(list.map((m) => m.id), [ask.id])
  assert.equal(list[0].kind, 'mention')
  assert.equal(list[0].unread, true)
  assert.equal(list[0].sender.name, '정하윤')
  // the same view the room gives (its id, room, words), with the room's reactions
  const inRoom = (await M.messages(me(B), g.id)).messages.find((m) => m.id === ask.id)
  assert.equal(inRoom.body, list[0].body)
  assert.deepEqual(list[0].reactions, [])
  assert.ok(!list.some((m) => m.id === hi.id))
  if (rx) {
    await M.react(me(C), ask.id, 'like', true)
    assert.deepEqual((await forMe(B, g.id))[0].reactions.map((c) => [c.key, c.count]), [['like', 1]])
  }
  assert.ok(M.FOR_ME.includes('askteam') && M.FOR_ME.includes('answer') && M.FOR_ME.includes('fileref') && M.FOR_ME.includes('mailref'))
})

test('OL-I-02 그 메시지까지 읽기 — 그 항목과 그 알림만, 뒤의 메시지는 안 읽음 그대로, 되돌리지 않음, 다른 방의 id 는 아무 일 없음', { skip: !db }, async () => {
  await setup()
  const g = await room(A, [B.id, C.id])
  const first = await M.post(me(A), g.id, { kind: 'mention', body: '이번 주 회의록 확인해 주세요' })
  await pause()
  const second = await M.post(me(A), g.id, { kind: 'mention', body: '그리고 출장 일정도요' })
  await pause()
  await M.post(me(C), g.id, { body: '저도 봤어요' })
  assert.equal(await unreadOf(B, g.id), 3)
  const n1 = await teamNotice(B, first.id, g.id), n2 = await teamNotice(B, second.id, g.id)
  assert.ok(n1 && n2, 'each mention has its Home card')
  await q(`update chat_rooms set participants = (select jsonb_agg(case when p->>'id'=$2 then p || '{"isExistUnReadMessage": true}' else p end) from jsonb_array_elements(participants) p) where id=$1`, [g.id, B.id])

  const from = bus.lastSeq()
  const r = await M.markRead(me(B), g.id, { upTo: first.id })
  assert.ok(r.at)
  const list = await forMe(B, g.id)
  assert.equal(list.find((m) => m.id === first.id).unread, false)
  assert.equal(list.find((m) => m.id === second.id).unread, true)
  assert.equal(await unreadOf(B, g.id), 2)
  assert.equal((await teamNotice(B, first.id, g.id)).checked, true)
  assert.equal((await teamNotice(B, second.id, g.id)).checked, false)
  // (something newer is still unread: Process GPT's own flag stays)
  assert.equal(await flag(B, g.id), true)
  const ev = (await readEvents(B.id, from)).filter((e) => e.data.threadId === g.id)
  assert.equal(ev.length, 1)
  assert.equal(new Date(ev[0].data.at).getTime(), new Date(r.at).getTime())

  // further, then back to the first: the furthest point stays
  await M.markRead(me(B), g.id, { upTo: second.id })
  assert.equal(await unreadOf(B, g.id), 1)
  await M.markRead(me(B), g.id, { upTo: first.id })
  assert.equal(await unreadOf(B, g.id), 1)
  assert.equal((await forMe(B, g.id)).every((m) => !m.unread), true)

  // a message of another room (or no message): nothing read here
  const other = await room(A, [B.id])
  const elsewhere = await M.post(me(A), other.id, { kind: 'mention', body: '다른 방의 멘션' })
  assert.deepEqual(await M.markRead(me(B), g.id, { upTo: elsewhere.id }), { ok: true, at: null })
  assert.equal(await unreadOf(B, other.id), 1)
  assert.equal(await unreadOf(B, g.id), 1)
  // someone not in the room: 404, as for every room route
  await assert.rejects(M.markRead({ id: crypto.randomUUID(), email: 'nobody@people.test', name: '아무개' }, g.id, { upTo: first.id }), (e) => e.status === 404)
})

test('OL-I-03 홈 카드(team 알림)를 닫으면 그 방을 그 메시지까지 읽는다', { skip: !db }, async () => {
  await setup()
  const g = await room(A, [B.id])
  // (the 1:1 room of the test above: read whole first)
  await M.markRead(me(B), g.id)
  const share = await M.post(me(A), g.id, { kind: 'mention', body: '제안서 검토 부탁해요' })
  await pause()
  await M.post(me(A), g.id, { body: '천천히 보셔도 돼요' })
  assert.equal(await unreadOf(B, g.id), 2)
  const n = await teamNotice(B, share.id, g.id)
  const from = bus.lastSeq()
  assert.equal(await N.dismiss(me(B), n.id), true)
  assert.equal(await unreadOf(B, g.id), 1)
  assert.equal((await forMe(B, g.id))[0].unread, false)
  assert.ok((await readEvents(B.id, from)).some((e) => e.data.threadId === g.id && e.data.at))
})

test('OL-I-04 방의 chat 알림을 닫으면 그 알림 때까지 읽는다', { skip: !db }, async () => {
  await setup()
  const g = await room(C, [B.id])
  const line = await M.post(me(C), g.id, { body: '내일 10시에 봬요' })
  const [{ ts }] = await q('select public.pro_chat_ts(messages) as ts from chats where uuid=$1', [line.id])
  // (Process GPT's chat trigger writes one as the message goes in — here by hand, at the message's time)
  const [chat] = await q(`insert into notifications(id,user_id,title,type,description,url,tenant_id,time_stamp) values (gen_random_uuid(),$1,$2,'chat','',$3,$4,$5) returning id`,
    [B.id, '내일 10시에 봬요', `/chats?id=${g.id}`, T, ts])
  // a later message, after the notice: still unread once the notice is put away
  await pause(1500)
  await M.post(me(C), g.id, { body: '자료는 나중에 보낼게요' })
  assert.equal(await unreadOf(B, g.id), 2)
  assert.equal(await N.dismiss(me(B), chat.id), true)
  assert.equal(await unreadOf(B, g.id), 1)
})

test('OL-I-05 방을 열면(메시지 지정 없이) 전부 읽음 — 알림 모두 확인, Process GPT 의 안 읽음 표시도 지움', { skip: !db }, async () => {
  await setup()
  const g = await room(A, [B.id, C.id])
  const m1 = await M.post(me(A), g.id, { kind: 'mention', body: '첫 번째 요청' })
  await pause()
  const m2 = await M.post(me(C), g.id, { kind: 'mention', body: '두 번째 요청' })
  await q(`update chat_rooms set participants = (select jsonb_agg(case when p->>'id'=$2 then p || '{"isExistUnReadMessage": true}' else p end) from jsonb_array_elements(participants) p) where id=$1`, [g.id, B.id])
  await M.markRead(me(B), g.id)
  assert.equal(await unreadOf(B, g.id), 0)
  assert.ok((await forMe(B, g.id)).every((m) => !m.unread))
  assert.equal((await teamNotice(B, m1.id, g.id)).checked, true)
  assert.equal((await teamNotice(B, m2.id, g.id)).checked, true)
  assert.equal(await flag(B, g.id), undefined)
})
