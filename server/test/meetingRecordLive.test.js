// A meeting's record reaches the open room at once (2026-11-24 운영, a team group room: 「회의가 끝나면 회의가 끝난 회의록을
// 부착해주는데, 이게 곧바로 반영안되고 나갔다 들어와야 업데이트됨」). The card, 회의 자료 and the minutes are chats rows the
// meeting assistant writes (lib/meetings/record.js); only the room feed (chats trigger → LISTEN, messenger.feedRow) pushed
// them, and behind the ProcessGPT gateway the feed looked only at the default tenant — a company's rooms got nothing live.
//   RL-U-01  a record row written here goes to every person of the room (in the meeting or not), once per content
//   RL-U-02  the feed's copy of a row already delivered is not sent again; the room's watchers still see it
//   RL-U-03  behind the gateway the feed pushes a row of a company's room (a tenant that uses Lite, not the default)
//   RL-U-04  on one server, a room of a tenant it does not serve is still not pushed
// On the local database (rooms and rows made here, removed after). Run: node --test test/meetingRecordLive.test.js
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

process.env.PRO_TENANT_ID = 'localhost'
process.env.PRO_TENANT_HOSTS = ''
process.env.PRO_TENANT_FROM_HEADER = '0'
const { config } = await import('../config.js')
const { q, pool } = await import('../lib/supa.js')
const { poll, lastSeq } = await import('../lib/bus.js')
const { withTenant } = await import('../lib/tenant.js')
const M = await import('../lib/team/messenger.js')
const R = await import('../lib/meetings/record.js')

const rooms = []
// a room of three people (fictional), in a tenant
async function room(tenant = 'localhost') {
  const id = `rl-test-${crypto.randomUUID().slice(0, 8)}`
  const people = ['한가온', '서도윤', '문채아'].map((name, i) => ({ id: crypto.randomUUID(), email: `rl-${i}-${id}@example.test`, username: name, profile: '/images/defaultUser.png', agent_type: null, is_agent: false }))
  await q('insert into chat_rooms(id, participants, name, tenant_id, message, context) values ($1,$2,$3,$4,$5,$6)',
    [id, JSON.stringify(people), '회의록 실시간', tenant, { msg: '', type: 'text', createdAt: new Date().toISOString() }, { pgpt: { kind: 'group' } }])
  rooms.push(id)
  return { id, people }
}
after(async () => {
  for (const id of rooms) {
    await q('delete from notifications where url=$1', [`/chats?id=${id}`]).catch(() => {})
    await q('delete from chats where id=$1', [id]).catch(() => {})
    await q('delete from chat_rooms where id=$1', [id]).catch(() => {})
  }
  await pool.end().catch(() => {})
})
// the 'team' message events each person got since `from` for that room
async function got(people, roomId, from) {
  const out = {}
  for (const p of people) out[p.id] = (await poll(p.id, from, 0)).filter((e) => e.type === 'team' && e.data.type === 'message' && e.data.threadId === roomId).map((e) => e.data.message)
  return out
}
// a row someone else wrote (an agent through process-gpt, process-gpt's own chat screen)
async function foreignRow(roomId, tenant, content) {
  const uuid = crypto.randomUUID()
  await q('insert into chats(uuid, id, messages, tenant_id, thread_id) values ($1,$2,$3,$4,$2)', [uuid, roomId,
    { uuid, role: 'assistant', email: 'agent:rl-agent', name: '에이전트', userName: '에이전트', content, timeStamp: new Date().toISOString() }, tenant])
  return uuid
}

test('RL-U-01 회의록 행을 쓰면 방 사람 모두에게(회의에 없던 사람도) 바로, 같은 내용은 한 번', async () => {
  const r = await room()
  const m = { id: crypto.randomUUID(), room_id: r.id, started_at: new Date(Date.now() - 60000), ended_at: new Date(), started_by: r.people[0].id, agent: true }
  const from = lastSeq()
  const uuid = await withTenant('localhost', () => R.minutesRow(m, '📝 회의록 · 21:10–21:11 (1분)\n\n참여: 한가온, 서도윤', { lang: 'ko', summary: '받아쓰기 없이 진행했어요.', decisions: [], actions: [], people: ['한가온', '서도윤'], by: 'rules' }, []))
  const ev = await got(r.people, r.id, from)
  for (const p of r.people) {
    assert.equal(ev[p.id].length, 1, `${p.username}: one message`)
    assert.equal(ev[p.id][0].id, uuid)
    assert.equal(ev[p.id][0].kind, 'meeting-minutes')
    assert.equal(ev[p.id][0].meeting.by, 'rules')
  }
  // the meeting card written, then updated in place to 「끝났어요」: each change once, the same id
  const from2 = lastSeq()
  const card = await withTenant('localhost', async () => {
    m.card_uuid = await R.startCard(m, [{ name: '한가온' }, { name: '서도윤' }], [])
    await R.updateCard(m, [{ name: '한가온', left_at: new Date() }, { name: '서도윤', left_at: new Date() }], { ended: true })
    return m.card_uuid
  })
  const ev2 = await got(r.people, r.id, from2)
  for (const p of r.people) {
    assert.deepEqual(ev2[p.id].map((x) => [x.id, x.meeting.state]), [[card, 'live'], [card, 'ended']])
  }
  // delivered again with nothing changed: nothing more
  const from3 = lastSeq()
  assert.equal(await M.deliver(card), false)
  assert.equal((await got(r.people, r.id, from3))[r.people[2].id].length, 0)
})

test('RL-U-02 피드가 같은 행을 다시 들어도 또 보내지 않고, 방을 지켜보는 쪽(어시스트)은 본다', async () => {
  const r = await room()
  const seen = []
  M.onChat((row) => { if (row.id === r.id) seen.push(row.uuid) })
  const m = { id: crypto.randomUUID(), room_id: r.id, started_at: new Date(), started_by: r.people[0].id, agent: true }
  const from = lastSeq()
  const uuid = await withTenant('localhost', () => R.startCard(m, [{ name: '한가온' }], []))
  assert.equal(await M.feedRow(uuid), false, 'already delivered with this content')
  assert.deepEqual(seen, [uuid])
  assert.equal((await got(r.people, r.id, from))[r.people[1].id].length, 1)
  // a row written elsewhere reaches the room through the feed, once
  const other = await foreignRow(r.id, 'localhost', '견적서를 정리했어요.')
  assert.equal(await M.feedRow(other), true)
  assert.equal(await M.feedRow(other), false)
  const ev = await got(r.people, r.id, from)
  assert.deepEqual(ev[r.people[2].id].map((x) => x.id), [uuid, other])
})

test('RL-U-03 게이트웨이 뒤: 기본 테넌트가 아닌 회사의 방 행도 피드가 보낸다', async (t) => {
  const [lite] = await q(`select distinct u.tenant_id from users u join tenants x on x.id=u.tenant_id
                          where u.tenant_id <> $1 and exists (select 1 from pro_threads p where p.user_id=u.id) limit 1`, [config.defaultTenantId])
  if (!lite) return t.skip('Lite 를 쓰는 다른 테넌트가 이 데이터베이스에 없음')
  const r = await room(lite.tenant_id)
  const uuid = await foreignRow(r.id, lite.tenant_id, '회의록을 정리했어요.')
  const was = config.tenantFromHeader
  try {
    // (before 2026-11-24: tenants() — only the default tenant there, the row was dropped)
    config.tenantFromHeader = true
    const from = lastSeq()
    assert.equal(await M.feedRow(uuid), true)
    const ev = await got(r.people, r.id, from)
    for (const p of r.people) assert.deepEqual(ev[p.id].map((x) => x.id), [uuid])
  } finally { config.tenantFromHeader = was }
})

test('RL-U-04 한 서버(게이트웨이 아님): 맡지 않은 테넌트의 방은 여전히 보내지 않는다', async (t) => {
  const [other] = await q(`select id from tenants where id <> $1 limit 1`, [config.defaultTenantId])
  if (!other) return t.skip('다른 테넌트가 없음')
  const r = await room(other.id)
  const uuid = await foreignRow(r.id, other.id, '다른 회사의 방')
  const from = lastSeq()
  assert.equal(await M.feedRow(uuid), false)
  assert.equal((await got(r.people, r.id, from))[r.people[0].id].length, 0)
})
