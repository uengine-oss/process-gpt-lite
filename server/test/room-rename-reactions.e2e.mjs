// 대화방 이름 · 말풍선 반응 HTTP E2E(2026-11-26 사용자 「대화방 설정으로 대화방 명칭 바꿀 수 있게하고 다른 사람 말풍선에 좋아요 확인했음 사랑해 웃음
// 등을 붙힐 수 있게」): 실제 BFF · 실제 DB, 세 사람(지어낸 이름)이 HTTP 로만. 모델은 부르지 않는다.
//   BFF:  cd server && PRO_PORT=8966 PRO_BACKGROUND=0 PRO_TENANT_HOSTS= PRO_TENANT_ID=room-react PRO_LLM_BASE_URL=http://127.0.0.1:9/v1 node index.js
//   이것: API_URL=http://127.0.0.1:8966 node test/room-rename-reactions.e2e.mjs
//   1. 세 사람의 단체방 · 1:1 — 메시지 몇 줄
//   2. PUT /api/team/rooms/:id/name — 방 사람 누구나 · 대화 목록 제목 · 시스템 줄 · 다른 사람의 실시간 'room' · 'message'(long poll) · 읽지 않은 수 그대로 ·
//      Process GPT 의 'chat' 알림은 읽은 것 · 같은 이름은 그대로 · 51자 400 · 1:1 400 · 방 밖 404 · 빈 이름 → 사람들 이름
//   3. POST /api/team/messages/:id/reactions — 켜기 · 다른 사람에게 실시간(각자의 mine) · 두 번째 사람 · 끄기 · on 지정 · 방의 메시지 목록 ·
//      내 메시지 · 시스템 줄 · 모르는 종류 400 · 방 밖 404 · 알림 행 없음
import assert from 'node:assert/strict'
import { q, pool } from '../lib/supa.js'

const API = `${process.env.API_URL || 'http://127.0.0.1:8966'}/api`
const CODE = process.env.PGPT_LOGIN_CODE || '000000'
const JSONH = { 'Content-Type': 'application/json', 'X-PGL-Lang': 'ko' }
const RUN = Date.now().toString(36)
let n = 0
const rooms = []
async function step(name, fn) {
  n++
  const t = Date.now()
  try { await fn(); console.log(`ok ${n} - ${name} (${Date.now() - t} ms)`) } catch (e) { console.log(`not ok ${n} - ${name}\n  ${e.stack || e.message}`); await cleanup(); process.exit(1) }
}
async function login(local, name) {
  const email = `pro-rx-${local}-${RUN}@people-mail.test`
  const r = await fetch(`${API}/auth/email/verify`, { method: 'POST', headers: JSONH, body: JSON.stringify({ email, code: CODE }) })
  const s = await r.json()
  if (!s.session) throw new Error(`login ${email}: ${JSON.stringify(s).slice(0, 200)}`)
  const H = { Authorization: `Bearer ${s.session.access_token}`, ...JSONH }
  await fetch(`${API}/profile`, { method: 'POST', headers: H, body: JSON.stringify({ name, birth: '1990-01-01', onboarded: true }) })
  await fetch(`${API}/me`, { headers: H }) // (who signs in joins the team)
  return { id: s.user.id, email, name, H }
}
async function call(u, path, { method = 'GET', body } = {}) {
  const r = await fetch(`${API}${path}`, { method, headers: u.H, body: body ? JSON.stringify(body) : undefined })
  const t = await r.text()
  let j = null
  try { j = JSON.parse(t) } catch { /* not JSON */ }
  return { status: r.status, body: j ?? t }
}
const ok = async (u, path, opts) => { const r = await call(u, path, opts); assert.equal(r.status, 200, `${path} → ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`); return r.body }
// what came to this person live (the same recent-events buffer the SSE stream reads; the room is new, so all of its events are this run's)
// — after: the newest seq already seen (an answer waits only while nothing is there: after=0 answers at once)
const seqOf = async (u) => ((await ok(u, '/events/poll?after=0')).events || []).at(-1)?.seq || 0
const live = async (u, after, type) => ((await ok(u, `/events/poll?after=0`)).events || []).filter((e) => e.seq > after && e.type === 'team' && (!type || e.data?.type === type))
async function cleanup() {
  for (const id of rooms) {
    await q('delete from pro_chat_reactions where room_id=$1', [id]).catch(() => {})
    await q('delete from chats where id=$1', [id]).catch(() => {})
    await q('delete from pro_chat_reads where room_id=$1', [id]).catch(() => {})
    await q('delete from notifications where url like $1', [`%${id}%`]).catch(() => {})
    await q('delete from chat_rooms where id=$1', [id]).catch(() => {})
  }
  await pool.end().catch(() => {})
}

const HY = await login('hayoon', '정하윤')
const SY = await login('seoyeon', '김서연')
const DY = await login('doyun', '박도윤')
const OUT = await login('dohyun', '최도현') // on the team, not in the room
let g, d, said, mine

await step('단체방 · 1:1 과 메시지', async () => {
  g = (await ok(HY, '/team/threads', { method: 'POST', body: { members: [SY.id, DY.id] } })).id
  d = (await ok(HY, '/team/threads', { method: 'POST', body: { members: [SY.id] } })).id
  rooms.push(g, d)
  said = await ok(SY, `/team/threads/${g}/messages`, { method: 'POST', body: { text: '견적서 초안 올렸어요. 확인 부탁해요.' } })
  mine = await ok(HY, `/team/threads/${g}/messages`, { method: 'POST', body: { text: '네, 오후에 볼게요.' } })
  await ok(SY, `/team/threads/${g}/read`, { method: 'POST' })
  await ok(DY, `/team/threads/${g}/read`, { method: 'POST' })
  assert.equal((await ok(SY, '/team/threads')).find((t) => t.id === g).title, '정하윤, 박도윤')
})

await step('이름 바꾸기 — 방 사람 누구나, 모두의 목록 · 실시간 · 시스템 줄, 조용히', async () => {
  const [s0, d0] = [await seqOf(SY), await seqOf(DY)]
  const r = await ok(DY, `/team/rooms/${g}/name`, { method: 'PUT', body: { name: '  3분기 견적   검토 ' } })
  assert.deepEqual(r, { threadId: g, name: '3분기 견적 검토', changed: true })
  for (const u of [HY, SY, DY]) assert.equal((await ok(u, '/team/threads')).find((t) => t.id === g).title, '3분기 견적 검토', u.name)
  const room = (await live(SY, s0, 'room')).filter((e) => e.data.threadId === g)
  assert.equal(room.at(-1)?.data.name, '3분기 견적 검토')
  const line = (await live(SY, s0, 'message')).filter((e) => e.data.threadId === g).at(-1)?.data.message
  assert.equal(line?.kind, 'rename')
  assert.equal(line.body, '박도윤님이 대화방 이름을 「3분기 견적 검토」로 바꿨어요')
  assert.ok((await live(DY, d0, 'room')).some((e) => e.data.threadId === g), 'the one who renamed hears of it too (their other screens)')
  const msgs = (await ok(HY, `/team/threads/${g}/messages`)).messages
  assert.equal(msgs.at(-1).kind, 'rename')
  // quiet: no unread for it, Process GPT's 'chat' notice of the line already checked (no Home card · push)
  assert.equal((await ok(SY, '/team/unread')).byThread[g] || 0, 0)
  const ns = await q(`select is_checked from notifications where type='chat' and url=$1 and title=$2`, [`/chats?id=${g}`, line.body])
  assert.ok(ns.length >= 1 && ns.every((x) => x.is_checked), JSON.stringify(ns))
  assert.equal((await ok(SY, '/notifications')).filter?.((x) => String(x.url || '').includes(g)).length ?? 0, 0)
  const [cr] = await q('select name from chat_rooms where id=$1', [g])
  assert.equal(cr.name, '3분기 견적 검토')
})

await step('이름 — 같은 이름은 그대로 · 51자 400 · 1:1 400 · 방 밖 404 · 빈 이름은 사람들 이름으로', async () => {
  assert.equal((await ok(HY, `/team/rooms/${g}/name`, { method: 'PUT', body: { name: '3분기 견적 검토' } })).changed, false)
  const long = await call(HY, `/team/rooms/${g}/name`, { method: 'PUT', body: { name: '가'.repeat(51) } })
  assert.equal(long.status, 400)
  assert.match(long.body.error, /50자/)
  assert.equal((await call(HY, `/team/rooms/${d}/name`, { method: 'PUT', body: { name: '둘만' } })).status, 400)
  assert.equal((await call(OUT, `/team/rooms/${g}/name`, { method: 'PUT', body: { name: '몰래' } })).status, 404)
  assert.equal((await call(HY, '/team/rooms/not-a-room/name', { method: 'PUT', body: { name: 'x' } })).status, 404)
  assert.equal((await q(`select count(*)::int n from chats where id=$1 and messages->'pgpt'->>'kind'='rename'`, [g]))[0].n, 1)
  const off = await ok(SY, `/team/rooms/${g}/name`, { method: 'PUT', body: { name: '' } })
  assert.deepEqual(off, { threadId: g, name: null, changed: true })
  assert.equal((await ok(SY, '/team/threads')).find((t) => t.id === g).title, '정하윤, 박도윤')
  assert.equal((await ok(HY, '/team/threads')).find((t) => t.id === g).title, '김서연, 박도윤')
  assert.equal((await ok(HY, `/team/threads/${g}/messages`)).messages.at(-1).body, '김서연님이 대화방 이름을 지웠어요')
  await ok(HY, `/team/rooms/${g}/name`, { method: 'PUT', body: { name: '견적 검토' } })
})

await step('반응 — 켜기, 다른 사람에게 실시간(각자의 mine), 두 번째 사람, 끄기, on 지정', async () => {
  const [s0, n0] = [await seqOf(SY), (await q('select count(*)::int n from notifications where user_id = any($1)', [[SY.id, SY.email]]))[0].n]
  const r1 = await ok(HY, `/team/messages/${said.id}/reactions`, { method: 'POST', body: { key: 'like' } })
  assert.deepEqual(r1.reactions, [{ key: 'like', count: 1, mine: true, people: [{ id: HY.id, name: '정하윤' }] }])
  const ev = (await live(SY, s0, 'reactions')).filter((e) => e.data.messageId === said.id).at(-1)
  assert.deepEqual(ev.data, { type: 'reactions', threadId: g, messageId: said.id, reactions: [{ key: 'like', count: 1, mine: false, people: [{ id: HY.id, name: '정하윤' }] }] })
  const r2 = await ok(DY, `/team/messages/${said.id}/reactions`, { method: 'POST', body: { key: 'like' } })
  assert.deepEqual(r2.reactions.map((c) => [c.key, c.count, c.mine, c.people.map((p) => p.name)]), [['like', 2, true, ['정하윤', '박도윤']]])
  await ok(DY, `/team/messages/${said.id}/reactions`, { method: 'POST', body: { key: 'laugh', on: true } })
  await ok(HY, `/team/messages/${said.id}/reactions`, { method: 'POST', body: { key: 'check', on: true } })
  // the room's messages: the chips as each one sees them
  const forSY = (await ok(SY, `/team/threads/${g}/messages`)).messages.find((m) => m.id === said.id)
  assert.deepEqual(forSY.reactions.map((c) => [c.key, c.count, c.mine]), [['like', 2, false], ['check', 1, false], ['laugh', 1, false]])
  const forHY = (await ok(HY, `/team/threads/${g}/messages`)).messages.find((m) => m.id === said.id)
  assert.deepEqual(forHY.reactions.map((c) => [c.key, c.mine]), [['like', true], ['check', true], ['laugh', false]])
  // asked again: off; on: false twice — still off
  const r3 = await ok(HY, `/team/messages/${said.id}/reactions`, { method: 'POST', body: { key: 'like' } })
  assert.deepEqual(r3.reactions.map((c) => [c.key, c.count, c.mine]), [['like', 1, false], ['check', 1, true], ['laugh', 1, false]])
  await ok(HY, `/team/messages/${said.id}/reactions`, { method: 'POST', body: { key: 'like', on: false } })
  assert.equal((await q(`select count(*)::int n from pro_chat_reactions where chat_uuid=$1 and reaction='like'`, [said.id]))[0].n, 1)
  // nothing for SY's bell, Home or unread: a reaction is not a message
  assert.equal((await q('select count(*)::int n from notifications where user_id = any($1)', [[SY.id, SY.email]]))[0].n, n0)
  assert.equal((await ok(SY, '/team/unread')).byThread[g] || 0, 0)
})

await step('반응 — 내 메시지 · 시스템 줄 · 모르는 종류 400, 방 밖 · 없는 메시지 404', async () => {
  assert.equal((await call(HY, `/team/messages/${mine.id}/reactions`, { method: 'POST', body: { key: 'like' } })).status, 400)
  const line = (await ok(HY, `/team/threads/${g}/messages`)).messages.findLast((m) => m.kind === 'rename')
  assert.equal((await call(SY, `/team/messages/${line.id}/reactions`, { method: 'POST', body: { key: 'like' } })).status, 400)
  assert.equal((await call(HY, `/team/messages/${said.id}/reactions`, { method: 'POST', body: { key: 'angry' } })).status, 400)
  assert.equal((await call(OUT, `/team/messages/${said.id}/reactions`, { method: 'POST', body: { key: 'like' } })).status, 404)
  assert.equal((await call(HY, '/team/messages/00000000-0000-4000-8000-000000000000/reactions', { method: 'POST', body: { key: 'like' } })).status, 404)
})

await cleanup()
console.log(`1..${n}`)
