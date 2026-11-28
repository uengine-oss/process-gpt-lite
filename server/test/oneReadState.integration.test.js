// 읽음은 하나 — 방 읽음(pro_chat_reads)만(2026-11-28 「받은 편지함 = 대화의 거르개」 1단계: 「이 두 대화창이 같은건데... 어떻게 통일할 방법이
// 없을까?」). 대화 › 나에게 온 것의 항목은 방의 메시지 그대로이고, 보거나 홈 카드를 닫으면 그 방을 그 메시지까지 읽는다: lib/team/messenger.js
// markRead({upTo}) · inbox, lib/notify.js dismiss. 지어낸 사람으로 로컬 Supabase 에 대고 돈다(화면은 e2e F-OL-01~05).
//   OL-I-01 나에게 온 것 = 방 메시지(공유 · 멘션 · 파일 링크 · 메일 멘션 · 질문 · 답, 남이 보낸 것만) · 방의 반응 칩 · 방 읽음으로 안 읽음
//   OL-I-02 그 메시지까지 읽기: 항목 읽음 · 뒤의 메시지는 그대로 안 읽음(방의 수 · 합계) · 그 메시지의 'team' 알림만 확인 · Process GPT 의
//           안 읽음 표시는 남김 — 더 앞의 메시지까지 읽기는 되돌리지 않음 · 다른 방의 메시지 id 는 아무 일 없음
//   OL-I-03 홈 카드(team 알림)를 닫으면 그 방을 그 메시지까지 읽음 · 'read' 알림(그 시각)
//   OL-I-04 방의 'chat' 알림(Process GPT 의 채팅 트리거가 쓴 것)을 닫으면 그 알림의 메시지까지 읽음 — 뒤의 줄 카드는 남음
//   OL-I-05 방을 열면(그 메시지 없이) 전부 읽음 · 'team' · 'chat' 알림 모두 확인 · Process GPT 의 안 읽음 표시도 지움
//   (PR #127 검토 — 읽음 규칙이 보지 않은 것까지 읽었다)
//   OL-I-06 그냥 줄 · 멘션 · 그냥 줄 → 첫 줄의 chat 카드를 닫아도 멘션 카드 · 멘션의 안 읽음 · 뒤 줄의 카드는 그대로
//   OL-I-07 멘션 카드 둘 → 새 것을 닫아도 옛 것의 카드 · 안 읽음은 그대로(읽음이 움직이지 않음), 옛 것을 닫으면 옛 것까지만
//   OL-I-08 Process GPT 의 안 읽음 표시: 뒤에 이름 바꾼 줄 · 숨은 줄만 남으면 지움 · 그 메시지의 chat 알림만 확인(같은 1초 안의 다른 말은 아님)
//   OL-I-09 보내기 · 초대는 앞서 간 읽음 위치를 되돌리지 않음
//   (PR #127 재검토 — 규칙을 하나로: 카드 닫기는 그 카드만(id), 읽음은 그 앞에 보지 않은 것이 없을 때만 그 메시지까지, 아니면 그대로)
//   OL-I-10 (H1) 보지 않은 멘션 뒤의 줄 카드를 닫으면 그 카드는 사라지고(돌아오지 않음), 읽음은 그대로
//   OL-I-11 (H1) 시계가 3초 앞선 사람의 줄 카드를 닫아도 사라지고, 그 메시지까지 읽음
//   OL-I-12 (H2) 멘션 · 줄 · 줄 · 멘션 → 새 멘션 카드를 닫아도, 옛 멘션 카드를 닫아도 보지 않은 줄을 지나 읽지 않음 · 그 줄 카드는 그대로
//   OL-I-13 (M1) 먼저 읽은 「네」와 같은 말 · 같은 사람의 새 「네」 카드는, 멘션까지 읽어도 확인되지 않음
//   OL-I-14 (M2) 이미 읽은 메시지에 남은 카드는 뒤의 카드 닫기를 막지 않고, 그때 함께 확인됨
//   OL-I-15 (M3) 안 읽은 「나에게 온 것」이 50개를 넘어도 모두 오고, 화면이 보여 주지 않은 더 오래된 것이 있으면 「보면 읽음」은 움직이지 않음
//   OL-I-16 (L1) 둘째 줄의 카드를 닫아도 첫 줄의 카드는 그대로(보지 않은 첫 줄 때문에 읽음도 그대로)
//   OL-I-17 (마지막 확인 R8) 회사가 아직 붙지 않은 줄 카드도 막음 — 바로 뒤 멘션 카드를 닫아도 그 줄을 지나 읽지 않음
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
  assert.deepEqual(await M.markRead(me(B), g.id, { upTo: elsewhere.id }), { ok: true, at: null, rest: null })
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

// the chat trigger's notices of a room for a person (user_id = their address, no company), as Process GPT's own screen gets them
// (with the company — the ones Lite's Home lists, as in the review's repro)
async function chatCards(who, roomId) {
  await q(`update notifications set tenant_id=$1 where user_id=$2 and type='chat' and url=$3 and tenant_id is null`, [T, who.email, `/chats?id=${roomId}`])
  return q(`select id, title, coalesce(is_checked,false) as checked from notifications where user_id=$1 and type='chat' and url=$2 order by time_stamp`, [who.email, `/chats?id=${roomId}`])
}
const trigger = await q(`select 1 from pg_trigger where tgname='chat_insert_trigger'`).then((r) => r.length > 0).catch(() => false)

test('OL-I-04 방의 chat 알림(채팅 트리거)을 닫으면 그 알림의 메시지까지 읽고, 뒤 줄의 카드는 남는다', { skip: !db || !trigger }, async () => {
  await setup()
  const g = await room(C, [B.id])
  await M.markRead(me(B), g.id)
  await M.post(me(C), g.id, { body: '내일 10시에 봬요' })
  await pause(1200)
  await M.post(me(C), g.id, { body: '자료는 나중에 보낼게요' })
  const cards = await chatCards(B, g.id)
  assert.deepEqual(cards.map((c) => c.title), ['내일 10시에 봬요', '자료는 나중에 보낼게요'])
  assert.equal(await unreadOf(B, g.id), 2)
  assert.equal(await N.dismiss(me(B), cards[0].id), true)
  assert.equal(await unreadOf(B, g.id), 1)
  assert.deepEqual((await chatCards(B, g.id)).map((c) => c.checked), [true, false])
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

test('OL-I-06 그냥 줄 · 멘션 · 그냥 줄 — 첫 줄의 chat 카드를 닫아도 멘션 카드 · 멘션의 안 읽음 · 뒤 줄의 카드는 그대로', { skip: !db || !trigger }, async () => {
  await setup()
  const g = await room(A, [B.id, C.id])
  await M.post(me(C), g.id, { body: '안녕하세요' })
  await pause(1200)
  const ask = await M.post(me(C), g.id, { kind: 'mention', body: '계약서 검토 부탁해요' })
  await pause(1200)
  await M.post(me(C), g.id, { body: '급하지 않아요' })
  const cards = (await chatCards(B, g.id)).filter((c) => !c.checked)
  // (the mention's own chat card is replaced by its team card — notifyMembers, the trigger's one with no company too)
  assert.deepEqual(cards.map((c) => c.title), ['안녕하세요', '급하지 않아요'])
  assert.equal(await unreadOf(B, g.id), 3)
  assert.equal(await N.dismiss(me(B), cards[0].id), true)
  // read up to the first line only: the mention and the line after it are unread, their cards still on Home
  assert.equal(await unreadOf(B, g.id), 2)
  assert.equal((await teamNotice(B, ask.id, g.id)).checked, false)
  assert.equal((await forMe(B, g.id)).find((m) => m.id === ask.id).unread, true)
  assert.deepEqual((await chatCards(B, g.id)).filter((c) => c.title !== '계약서 검토 부탁해요').map((c) => c.checked), [true, false])
  const home = (await N.listFor(me(B))).filter((n) => String(n.url || '').includes(g.id) || String(n.title || '').includes('급하지 않아요') || n.type === 'team')
  assert.ok(home.some((n) => n.type === 'team'), 'the mention card stays on Home')
  assert.ok(home.some((n) => n.type === 'chat' && n.title === '급하지 않아요'), "the later line's card stays on Home")
})

test('OL-I-07 멘션 카드 둘 — 새 것을 닫아도 옛 것의 카드와 안 읽음은 그대로, 옛 것을 닫으면 옛 것까지만', { skip: !db }, async () => {
  await setup()
  const g = await room(A, [B.id, C.id])
  const older = await M.post(me(A), g.id, { kind: 'mention', body: '견적서 확인 부탁해요' })
  await pause()
  const newer = await M.post(me(C), g.id, { kind: 'mention', body: '일정도 봐 주세요' })
  assert.equal(await unreadOf(B, g.id), 2)
  assert.equal(await N.dismiss(me(B), (await teamNotice(B, newer.id, g.id)).id), true)
  assert.equal((await teamNotice(B, newer.id, g.id)).checked, true)
  assert.equal((await teamNotice(B, older.id, g.id)).checked, false)
  assert.equal((await forMe(B, g.id)).find((m) => m.id === older.id).unread, true)
  assert.equal(await unreadOf(B, g.id), 2)
  // the older one put away: read up to it — the newer one stays unread (its card is gone, the item is still to be seen)
  assert.equal(await N.dismiss(me(B), (await teamNotice(B, older.id, g.id)).id), true)
  assert.equal(await unreadOf(B, g.id), 1)
  assert.equal((await forMe(B, g.id)).find((m) => m.id === newer.id).unread, true)
})

test('OL-I-08 안 읽음 표시는 뒤에 이름 바꾼 줄 · 숨은 줄만 남으면 지우고, 그 메시지의 chat 알림만 확인한다', { skip: !db || !trigger }, async () => {
  await setup()
  const g = await room(A, [B.id, C.id])
  const ask = await M.post(me(A), g.id, { kind: 'mention', body: '회의록 정리 부탁해요' })
  // (another line in the same second: its chat card is not the mention's)
  await M.post(me(C), g.id, { body: '저는 오후에 볼게요' })
  await q(`update chats set messages = messages || jsonb_build_object('timeStamp', $2::text) where uuid=(select uuid from chats where id=$1 and messages->>'content'='저는 오후에 볼게요')`,
    [g.id, new Date(new Date((await q('select public.pro_chat_ts(messages) as ts from chats where uuid=$1', [ask.id]))[0].ts).getTime() + 300).toISOString()])
  const cards = await chatCards(B, g.id)
  assert.ok(cards.some((c) => c.title === '저는 오후에 볼게요'))
  await q(`update chat_rooms set participants = (select jsonb_agg(case when p->>'id'=$2 then p || '{"isExistUnReadMessage": true}' else p end) from jsonb_array_elements(participants) p) where id=$1`, [g.id, B.id])
  await M.markRead(me(B), g.id, { upTo: ask.id })
  assert.equal((await chatCards(B, g.id)).find((c) => c.title === '저는 오후에 볼게요').checked, false)
  assert.equal(await flag(B, g.id), true)
  // read up to that line; after it only a rename line and a hidden row: nothing left to read — the flag goes
  const line = (await q(`select uuid from chats where id=$1 and messages->>'content'='저는 오후에 볼게요'`, [g.id]))[0].uuid
  await pause()
  await M.rename(me(C), g.id, '회의록 방')
  const hidden = crypto.randomUUID()
  await q('insert into chats(uuid, id, messages, tenant_id) values ($1,$2,$3,$4)', [hidden, g.id, { uuid: hidden, role: 'user', content: '숨은 줄', email: C.email, userId: C.id, timeStamp: new Date(Date.now() + 1000).toISOString(), __hidden: true }, T])
  await q(`update chat_rooms set participants = (select jsonb_agg(case when p->>'id'=$2 then p || '{"isExistUnReadMessage": true}' else p end) from jsonb_array_elements(participants) p) where id=$1`, [g.id, B.id])
  const r = await M.markRead(me(B), g.id, { upTo: line })
  assert.equal(r.rest, 0)
  assert.equal(await flag(B, g.id), undefined)
  assert.equal((await chatCards(B, g.id)).find((c) => c.title === '저는 오후에 볼게요').checked, true)
  assert.equal(await unreadOf(B, g.id), 0)
})

test('OL-I-09 보내기 · 초대는 앞서 간 읽음 위치를 되돌리지 않는다', { skip: !db }, async () => {
  await setup()
  const g = await room(A, [B.id])
  // a message whose writer's clock runs ten minutes ahead, read whole by B
  const ahead = crypto.randomUUID(), later = new Date(Date.now() + 10 * 60_000)
  await q('insert into chats(uuid, id, messages, tenant_id) values ($1,$2,$3,$4)', [ahead, g.id, { uuid: ahead, role: 'user', content: '앞선 시계', email: A.email, userId: A.id, timeStamp: later.toISOString() }, T])
  await M.markRead(me(B), g.id)
  const read = async () => new Date((await q('select last_read_at from pro_chat_reads where room_id=$1 and user_id=$2', [g.id, B.id]))[0].last_read_at).getTime()
  const before = await read()
  assert.ok(before >= later.getTime())
  await M.post(me(B), g.id, { body: '네, 봤어요' })
  assert.equal(await read(), before)
  const grp = await room(B, [A.id, C.id])
  const ahead2 = crypto.randomUUID()
  await q('insert into chats(uuid, id, messages, tenant_id) values ($1,$2,$3,$4)', [ahead2, grp.id, { uuid: ahead2, role: 'user', content: '앞선 시계', email: A.email, userId: A.id, timeStamp: later.toISOString() }, T])
  await M.markRead(me(B), grp.id)
  const r2 = async () => new Date((await q('select last_read_at from pro_chat_reads where room_id=$1 and user_id=$2', [grp.id, B.id]))[0].last_read_at).getTime()
  const b2 = await r2()
  const D = await person(`ol-d-${stamp}`, '최도현')
  await M.invite(me(B), grp.id, [D.id])
  assert.equal(await r2(), b2)
})

const onHome = async (who, id) => (await N.listFor(me(who))).some((n) => n.id === id)

test('OL-I-10 (H1) 보지 않은 멘션 뒤의 줄 카드를 닫으면 그 카드는 사라지고 돌아오지 않는다 — 읽음은 그대로', { skip: !db || !trigger }, async () => {
  await setup()
  const g = await room(A, [B.id, C.id])
  await M.markRead(me(B), g.id)
  await M.post(me(A), g.id, { kind: 'mention', body: '견적 다시 봐 주세요' })
  await pause(1200)
  await M.post(me(C), g.id, { body: '저도 볼게요' })
  const card = (await chatCards(B, g.id)).find((c) => c.title === '저도 볼게요')
  assert.equal(await onHome(B, card.id), true)
  assert.equal(await N.dismiss(me(B), card.id), true)
  assert.equal(await onHome(B, card.id), false)
  assert.equal((await q('select is_checked from notifications where id=$1', [card.id]))[0].is_checked, true)
  assert.equal(await unreadOf(B, g.id), 2)
  // (a room the person left: the card goes all the same — its read is not theirs to move)
  const solo = await room(C, [B.id, A.id])
  await M.post(me(C), solo.id, { body: '나간 방의 줄' })
  const left = (await chatCards(B, solo.id)).find((c) => c.title === '나간 방의 줄')
  await q(`update chat_rooms set participants = (select jsonb_agg(p) from jsonb_array_elements(participants) p where p->>'id' <> $2) where id=$1`, [solo.id, B.id])
  assert.equal(await N.dismiss(me(B), left.id), true)
  assert.equal(await onHome(B, left.id), false)
})

test('OL-I-11 (H1) 시계가 3초 앞선 사람의 줄 카드도 닫으면 사라지고, 그 메시지까지 읽는다', { skip: !db || !trigger }, async () => {
  await setup()
  const g = await room(C, [B.id])
  await M.markRead(me(B), g.id)
  const u = crypto.randomUUID()
  await q('insert into chats(uuid, id, messages, tenant_id) values ($1,$2,$3,$4)',
    [u, g.id, { uuid: u, role: 'user', content: '앞선 시계의 줄', email: C.email, name: C.name, userName: C.name, userId: C.id, timeStamp: new Date(Date.now() + 3000).toISOString() }, T])
  const card = (await chatCards(B, g.id)).find((c) => c.title === '앞선 시계의 줄')
  assert.equal(await unreadOf(B, g.id), 1)
  assert.equal(await N.dismiss(me(B), card.id), true)
  assert.equal(await onHome(B, card.id), false)
  assert.equal(await unreadOf(B, g.id), 0)
})

test('OL-I-12 (H2) 멘션 · 줄 · 줄 · 멘션 — 어느 멘션 카드를 닫아도 보지 않은 줄을 지나 읽지 않고, 그 줄 카드는 그대로', { skip: !db || !trigger }, async () => {
  await setup()
  const g = await room(A, [B.id, C.id])
  const m1 = await M.post(me(A), g.id, { kind: 'mention', body: '첫 멘션' })
  await pause(1200)
  await M.post(me(C), g.id, { body: '그냥 줄 하나' })
  await pause(1200)
  await M.post(me(C), g.id, { body: '그냥 줄 둘' })
  await pause(1200)
  const m2 = await M.post(me(A), g.id, { kind: 'mention', body: '둘째 멘션' })
  const lines = async () => (await chatCards(B, g.id)).filter((c) => c.title.startsWith('그냥 줄')).map((c) => c.checked)
  assert.deepEqual(await lines(), [false, false])
  assert.equal(await unreadOf(B, g.id), 4)
  await N.dismiss(me(B), (await teamNotice(B, m2.id, g.id)).id)
  assert.equal(await unreadOf(B, g.id), 4)
  await N.dismiss(me(B), (await teamNotice(B, m1.id, g.id)).id)
  // read up to the first mention only: the two lines (and the second mention) stay unread, the lines' cards stay on Home
  assert.equal(await unreadOf(B, g.id), 3)
  assert.deepEqual(await lines(), [false, false])
  assert.equal((await forMe(B, g.id)).find((m) => m.id === m2.id).unread, true)
})

test('OL-I-13 (M1) 먼저 읽은 「네」와 같은 사람의 새 「네」 카드는 멘션까지 읽어도 확인되지 않는다', { skip: !db || !trigger }, async () => {
  await setup()
  const g = await room(A, [B.id, C.id])
  await M.post(me(C), g.id, { body: '네' })
  await pause(30)
  await M.markRead(me(B), g.id)
  await pause(1200)
  const x = await M.post(me(A), g.id, { kind: 'mention', body: '회신 부탁해요' })
  await pause(300)
  await M.post(me(C), g.id, { body: '네' })
  const yes = async () => (await chatCards(B, g.id)).filter((c) => c.title === '네').map((c) => c.checked)
  assert.deepEqual(await yes(), [true, false])
  await M.markRead(me(B), g.id, { upTo: x.id })
  assert.deepEqual(await yes(), [true, false])
  assert.equal(await unreadOf(B, g.id), 1)
})

test('OL-I-14 (M2) 이미 읽은 메시지에 남은 카드는 뒤의 카드 닫기를 막지 않고, 그때 함께 확인된다', { skip: !db || !trigger }, async () => {
  await setup()
  const g = await room(A, [B.id, C.id])
  const m = await M.post(me(A), g.id, { kind: 'mention', body: '먼저 읽은 멘션' })
  await M.markRead(me(B), g.id)
  // (as if the card came in after the whole read — notifyMembers after the room was opened)
  await q(`update notifications set is_checked=false where user_id=$1 and type='team' and url=$2`, [B.id, `/pro/team/${g.id}/${m.id}`])
  await pause(1200)
  await M.post(me(C), g.id, { body: '나중 줄' })
  const card = (await chatCards(B, g.id)).find((c) => c.title === '나중 줄')
  assert.equal(await unreadOf(B, g.id), 1)
  await N.dismiss(me(B), card.id)
  assert.equal(await unreadOf(B, g.id), 0)
  assert.equal((await teamNotice(B, m.id, g.id)).checked, true)
})

test('OL-I-15 (M3) 안 읽은 「나에게 온 것」이 50개를 넘어도 모두 오고, 보여 주지 않은 더 오래된 것이 있으면 「보면 읽음」은 움직이지 않는다', { skip: !db }, async () => {
  await setup()
  // (a room of its own: the 1:1 room of OL-I-09 keeps a read position ten minutes ahead)
  const g = await room(A, [B.id, C.id])
  await M.markRead(me(B), g.id)
  const ms = []
  for (let i = 0; i < 55; i++) { ms.push(await M.post(me(A), g.id, { kind: 'mention', body: `요청 ${i + 1}` })); await pause(5) }
  const list = await forMe(B, g.id)
  assert.equal(list.length, 55)
  assert.ok(list.every((m) => m.unread))
  // the screen showed (and saw) the newest ten only: the read does not move
  assert.deepEqual(await M.markRead(me(B), g.id, { upTo: ms[54].id, from: ms[45].id }), { ok: true, at: null, rest: null })
  assert.equal(await unreadOf(B, g.id), 55)
  // without `from` it is the item itself — still not past older unread ones
  assert.equal((await M.markRead(me(B), g.id, { upTo: ms[54].id })).at, null)
  // from the oldest unread one: read up to the newest seen
  assert.ok((await M.markRead(me(B), g.id, { upTo: ms[9].id, from: ms[0].id })).at)
  assert.equal(await unreadOf(B, g.id), 45)
})

test('OL-I-16 (L1) 둘째 줄의 카드를 닫아도 첫 줄의 카드는 그대로 — 보지 않은 첫 줄 때문에 읽음도 그대로', { skip: !db || !trigger }, async () => {
  await setup()
  const g = await room(C, [B.id])
  await M.markRead(me(B), g.id)
  await M.post(me(C), g.id, { body: '첫 줄이에요' })
  await pause(1200)
  await M.post(me(C), g.id, { body: '둘째 줄이에요' })
  const cards = await chatCards(B, g.id)
  const second = cards.find((c) => c.title === '둘째 줄이에요')
  await N.dismiss(me(B), second.id)
  assert.deepEqual((await chatCards(B, g.id)).filter((c) => ['첫 줄이에요', '둘째 줄이에요'].includes(c.title)).map((c) => [c.title, c.checked]),
    [['첫 줄이에요', false], ['둘째 줄이에요', true]])
  assert.equal(await unreadOf(B, g.id), 2)
})

test('OL-I-17 (마지막 확인 R8) 아직 회사가 붙지 않은 줄 카드도 막는다 — 바로 뒤 멘션 카드를 닫아도 그 줄을 지나 읽지 않음', { skip: !db || !trigger }, async () => {
  await setup()
  const g = await room(A, [B.id, C.id])
  await M.markRead(me(B), g.id)
  await M.post(me(C), g.id, { body: '방금 올린 줄이에요' })
  await pause(1200)
  const m = await M.post(me(A), g.id, { kind: 'mention', body: '이것 좀 봐 주세요' })
  // the line's card as the chat trigger wrote it — no company yet (Home's feed stamps it a few seconds later): not stamped here
  const line = async () => (await q(`select tenant_id, coalesce(is_checked,false) as checked from notifications where user_id=$1 and type='chat' and url=$2 and title=$3`,
    [B.email, `/chats?id=${g.id}`, '방금 올린 줄이에요']))[0]
  assert.equal((await line()).tenant_id, null)
  assert.equal(await unreadOf(B, g.id), 2)
  await N.dismiss(me(B), (await teamNotice(B, m.id, g.id)).id)
  assert.equal(await unreadOf(B, g.id), 2)
  assert.equal((await line()).checked, false)
})
