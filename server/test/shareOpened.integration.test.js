// 받은 사람이 공유된 파일을 열어 봤는지(2026-11-26 사용자 휴대폰 화면: 단체방 「보냄 · 공유」 카드에 「… 아직 그대로」 — 「아직그대로는 뭔가?
// 혹시 확인여부 ㅡ 파일을 열어서 봤는지라면 좋은데 ○○○께서 열어보셨다는데 아직그대로로 표시된」). lib/team/shares.js recordOpen · markOpened ·
// receipts, routes/team.js. 실제 DB · 로컬 Storage, 팀 경로는 실제 Express 라우트에 대고(로그인만 대역). 사람 이름은 지어낸 것이다.
//   SO-I-01 보낸 직후: 받은 사람마다 「안 열어 봄」(열어 본 수 0), 같은 이름의 두 계정은 주소로 가를 수 있게 이름과 주소가 함께 온다
//   SO-I-02 방의 작은 미리 보기(open 없이 raw)는 열어 본 것이 아니다 · 받은 사람이 raw 로 열면(open=1) 처음 · 마지막 연 때가 적히고 보낸 사람에게만
//           'opened' 가 간다 · 다시 열면 마지막 연 때만 바뀐다
//   SO-I-03 서명된 주소(메신저의 보기 화면)로 열어도 같다 — 그 사람의 행에만
//   SO-I-04 보낸 사람이 같은 공유를 열면(raw open=1 · 열기 · opened) 아무 행도 바뀌지 않는다(보낸 사람의 공유 id 는 첫 받은 사람의 행이다)
//   SO-I-05 다른 회사 · 방 밖 팀원: raw 403 · 404, 그 회사로 서명한 주소도 404, 아무 행도 바뀌지 않는다
//   SO-I-06 칩으로 편집기에서 열기(POST …/open), 자기 사본 카드에서 열기(POST …/opened), 「이어서 작업」도 연 것으로 적힌다
//   SO-I-07 누가 열었는지는 보낸 사람만: 받은 사람 · 방 밖 팀원이 같은 메시지를 물으면 빈 목록
//   SO-I-08 전달: 받은 사람이 자기 사본을 다른 사람에게 보내고 그 사람이 열면 그 사람의 행만 — 처음 보낸 사람의 카드에는 아무것도 바뀌지 않는다
//   SO-I-09 거둔 공유는 열 수도 없고(404) 적히지도 않는다
// Run: node --test --test-concurrency=1 test/shareOpened.integration.test.js  (로컬 Supabase, sql/066 적용)
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

process.env.PRO_BACKGROUND = '0'
process.env.PRO_TENANT_ID = 'localhost'
delete process.env.PRO_TENANT_FROM_HEADER
process.env.PRO_DEEPAGENTS_URL = 'http://127.0.0.1:9'
process.env.PRO_CONTEXT_ROUTER_URL = ''
process.env.PRO_MEMENTO_URL = 'http://127.0.0.1:9'
process.env.PRO_JUDGE_URL = ''
process.env.PRO_LLM_BASE_URL = 'http://127.0.0.1:9/v1'

const { q, pool, admin } = await import('../lib/supa.js')
const bus = await import('../lib/bus.js')
const S = await import('../lib/team/shares.js')
const { signLink, linkPath } = await import('../lib/team/mediaLink.js')
const db = await q('select last_opened_at from pro_shares limit 1').then(() => true).catch(() => false)
const stamp = Date.now().toString(36)
const OTHER_T = `so-other-${stamp}`
const users = [], rooms = [], closers = []

after(async () => {
  // (「이어서 작업」's turn runs on after its answer — the agent is not there — and fails: let it end before the pool does)
  await new Promise((r) => setTimeout(r, 3000))
  for (const c of closers) c()
  for (const r of rooms) {
    await q('delete from chats where id=$1', [r]).catch(() => {})
    await q('delete from pro_chat_reads where room_id=$1', [r]).catch(() => {})
    await q('delete from chat_rooms where id=$1', [r]).catch(() => {})
  }
  const objects = []
  for (const u of users) {
    await q('delete from pro_shares where owner_id=$1 or recipient_id=$1', [u.id]).catch(() => {})
    await q('delete from pro_messages where thread_id in (select id from pro_threads where user_id=$1)', [u.id]).catch(() => {})
    await q('delete from pro_threads where user_id=$1', [u.id]).catch(() => {})
    await q('delete from notifications where user_id=$1 or user_id=$2 or from_user_id=$2', [u.id, u.email]).catch(() => {})
    await q('delete from pro_team_members where user_id=$1', [u.id]).catch(() => {})
    await q('delete from pro_profile where user_id=$1', [u.id]).catch(() => {})
    await q('delete from users where id=$1', [u.id]).catch(() => {})
    objects.push(...(await q(`select name from storage.objects where bucket_id='files' and starts_with(name, $1)`, [`pgpt-pro/${u.id}/`]).catch(() => [])).map((r) => r.name))
  }
  if (objects.length) await admin.storage.from('files').remove(objects).catch(() => {})
  await q('delete from tenants where id=$1', [OTHER_T]).catch(() => {})
  await pool.end()
})

async function person(name, email, { tenant = 'localhost', team = true } = {}) {
  const id = crypto.randomUUID()
  const u = { id, email: email || `so-${id.slice(0, 8)}@example.test`, name, tenant }
  users.push(u)
  if (tenant !== 'localhost') await q('insert into tenants (id) values ($1) on conflict do nothing', [tenant])
  await q('insert into users (id, email, username, tenant_id) values ($1,$2,$3,$4)', [id, u.email, name, tenant])
  await q('insert into pro_profile(user_id,name,email) values ($1,$2,$3) on conflict (user_id) do nothing', [id, name, u.email])
  if (team) await q('insert into pro_team_members(tenant_id,user_id,added_by) values ($1,$2,$2) on conflict do nothing', [tenant, id])
  return u
}

let base = null
async function server() {
  if (base) return base
  const express = (await import('express')).default
  const { teamRoutes } = await import('../routes/team.js')
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  const auth = (req, res, next) => {
    const u = users.find((x) => x.id === req.headers['x-test-user'])
    if (!u) return res.status(401).json({ error: 'unauthorized' })
    req.user = { id: u.id, email: u.email, name: u.name }; req.session = { access_token: 'test' }; next()
  }
  app.use('/api', teamRoutes(auth))
  const s = await new Promise((ok) => { const x = app.listen(0, '127.0.0.1', () => ok(x)) })
  closers.push(() => s.close())
  base = `http://127.0.0.1:${s.address().port}/api`
  return base
}
async function call(u, method, p, body, headers = {}) {
  const raw = Buffer.isBuffer(body)
  const r = await fetch(`${await server()}${p}`, { method, headers: { ...(u ? { 'x-test-user': u.id } : {}), ...(body != null && !raw ? { 'content-type': 'application/json' } : {}), ...headers }, body: body == null ? undefined : raw ? body : JSON.stringify(body) })
  const buf = Buffer.from(await r.arrayBuffer())
  let json = null
  try { json = JSON.parse(buf.toString('utf8')) } catch { /* bytes */ }
  return { status: r.status, body: json, bytes: buf, text: buf.toString('utf8').slice(0, 300), headers: r.headers }
}
// a 1×1 PNG: the screenshot of the report
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const sendFile = (u, name, buf, type) => call(u, 'POST', '/team/uploads', buf, { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(name), 'x-file-type': type })
const row = async (id) => (await q('select opened_at, last_opened_at, recipient_id from pro_shares where id=$1', [id]))[0]
const opened = (u, after) => bus.poll(u.id, after, 0).then((l) => l.filter((e) => e.type === 'team' && e.data?.type === 'opened'))

// 서도윤 sends a screenshot to the group room 「시니어 모임」: 한지우 (two accounts, one person), 정민호; 오세린 is on the team, not in the room
let cast = null
async function setup() {
  if (cast) return cast
  const sender = await person('서도윤', `doyun.seo-${stamp}@corp-a.test`)
  const j1 = await person('한지우', `jiwoo.han-${stamp}@mail-b.test`)
  const j2 = await person('한지우', `jiwoo-${stamp}@corp-a.test`)
  const mh = await person('정민호', `minho-${stamp}@corp-a.test`)
  const out = await person('오세린', `serin-${stamp}@corp-a.test`)
  const far = await person('남궁현', `hyun-${stamp}@far.test`, { tenant: OTHER_T })
  const t = await call(sender, 'POST', '/team/threads', { members: [j1.id, j2.id, mh.id], title: '시니어 모임' })
  assert.equal(t.status, 200, t.text)
  rooms.push(t.body.id)
  const up = await sendFile(sender, '화면 캡처 2026-11-26.png', PNG, 'image/png')
  assert.equal(up.status, 200, up.text)
  const m = await call(sender, 'POST', `/team/threads/${t.body.id}/messages`, { text: '이 화면 한번 봐 주세요', artifactIds: [up.body.id] })
  assert.equal(m.status, 200, m.text)
  const shareOf = async (u) => (await call(u, 'GET', `/team/threads/${t.body.id}/messages`)).body.messages.find((x) => x.id === m.body.id).artifacts[0]
  cast = { sender, j1, j2, mh, out, far, room: t.body.id, msg: m.body.id, a1: await shareOf(j1), a2: await shareOf(j2), am: await shareOf(mh), mine: await shareOf(sender) }
  return cast
}
const receipts = async (u, room, ids) => call(u, 'GET', `/team/threads/${room}/receipts?ids=${ids.join(',')}`)

test('SO-I-01 보낸 직후: 받은 사람마다 안 열어 봄, 같은 이름의 두 계정은 이름과 주소가 함께', { skip: !db }, async () => {
  const { sender, j1, j2, mh, room, msg } = await setup()
  const r = await receipts(sender, room, [msg])
  assert.equal(r.status, 200, r.text)
  const list = r.body.receipts[msg]
  assert.deepEqual(list.map((p) => p.id).sort(), [j1.id, j2.id, mh.id].sort())
  for (const p of list) assert.deepEqual([p.files, p.opened, p.openedAt, p.lastOpenedAt], [1, 0, null, null])
  const two = list.filter((p) => p.name === '한지우')
  assert.equal(two.length, 2)
  assert.deepEqual(two.map((p) => p.email).sort(), [j1.email, j2.email].sort())
})

test('SO-I-02 방의 미리 보기는 연 것이 아니고, 받은 사람이 raw 로 열면(open=1) 처음 · 마지막 연 때 — 보낸 사람에게만 알림', { skip: !db }, async () => {
  const { sender, j1, j2, mh, a1, a2, am } = await setup()
  // the room's small preview of the picture asks without open: shown, not opened
  const pre = await call(j1, 'GET', `/team/shares/${a1.shareId}/raw?inline=1`)
  assert.equal(pre.status, 200, pre.text)
  assert.deepEqual(pre.bytes, PNG)
  assert.equal((await row(a1.shareId)).opened_at, null)
  const before = bus.lastSeq()
  const o1 = await call(j1, 'GET', `/team/shares/${a1.shareId}/raw?inline=1&open=1`)
  assert.equal(o1.status, 200, o1.text)
  assert.deepEqual(o1.bytes, PNG)
  const r1 = await row(a1.shareId)
  assert.ok(r1.opened_at && r1.last_opened_at, '처음 · 마지막 연 때')
  assert.equal(String(r1.recipient_id), j1.id)
  // the other recipients' rows are untouched
  assert.equal((await row(a2.shareId)).opened_at, null)
  assert.equal((await row(am.shareId)).opened_at, null)
  // the sender hears of it (to open their card again), no one else does
  const ev = await opened(sender, before)
  assert.equal(ev.length, 1)
  assert.equal(ev[0].data.messageId, (await setup()).msg)
  for (const u of [j1, j2, mh]) assert.equal((await opened(u, before)).length, 0)
  // opened again: the last time moves, the first stays; no second 'opened'
  await new Promise((r) => setTimeout(r, 30))
  const seq2 = bus.lastSeq()
  assert.equal((await call(j1, 'GET', `/team/shares/${a1.shareId}/raw?open=1`)).status, 200)
  const r2 = await row(a1.shareId)
  assert.equal(r2.opened_at.toISOString(), r1.opened_at.toISOString())
  assert.ok(r2.last_opened_at > r1.last_opened_at)
  assert.equal((await opened(sender, seq2)).length, 0)
  // the sender's card: 한지우 (mail-b) opened · the others not
  const list = (await receipts(sender, (await setup()).room, [(await setup()).msg])).body.receipts[(await setup()).msg]
  const p1 = list.find((p) => p.id === j1.id)
  assert.deepEqual([p1.opened, p1.openedAt, p1.lastOpenedAt], [1, r1.opened_at.toISOString(), r2.last_opened_at.toISOString()])
  assert.equal(list.find((p) => p.id === j2.id).opened, 0)
})

test('SO-I-03 서명된 주소(메신저의 보기 화면)로 열어도 그 사람의 행에만 적힌다', { skip: !db }, async () => {
  const { j2, a2, mh, am } = await setup()
  assert.match(a2.link, /^\/team\/shares\/[0-9a-f-]{36}\/raw\?u=/)
  const r = await call(null, 'GET', `${a2.link}&open=1`)
  assert.equal(r.status, 200, r.text)
  assert.ok((await row(a2.shareId)).opened_at)
  assert.equal(String((await row(a2.shareId)).recipient_id), j2.id)
  assert.equal((await row(am.shareId)).opened_at, null)
  // the same address without open (the room's preview): nothing for 정민호
  assert.equal((await call(null, 'GET', am.link)).status, 200)
  assert.equal((await row(am.shareId)).opened_at, null)
  assert.equal(String((await row(am.shareId)).recipient_id), mh.id)
})

test('SO-I-04 보낸 사람이 열면 아무 행도 바뀌지 않는다', { skip: !db }, async () => {
  const { sender, mine, msg, room } = await setup()
  // the sender's share id is the first recipient's row (viewArtifacts): opening it must not mark that person
  const target = (await q('select id, recipient_id from pro_shares where id=$1', [mine.shareId]))[0]
  await q('update pro_shares set opened_at=null, last_opened_at=null where id=$1', [target.id])
  const before = bus.lastSeq()
  assert.equal((await call(sender, 'GET', `/team/shares/${mine.shareId}/raw?open=1`)).status, 200)
  assert.equal((await call(null, 'GET', `${mine.link}&open=1`)).status, 200)
  assert.equal((await call(sender, 'POST', `/team/shares/${mine.shareId}/open`)).status, 200)
  const o = await call(sender, 'POST', `/team/shares/${mine.shareId}/opened`)
  assert.equal(o.status, 200, o.text)
  assert.equal(o.body.recorded, false)
  const r = await row(target.id)
  assert.deepEqual([r.opened_at, r.last_opened_at], [null, null])
  assert.equal((await opened(sender, before)).length, 0)
  const p = (await receipts(sender, room, [msg])).body.receipts[msg].find((x) => x.id === String(target.recipient_id))
  assert.equal(p.opened, 0)
})

test('SO-I-05 다른 회사 · 방 밖 팀원은 열지 못하고 아무것도 적히지 않는다', { skip: !db }, async () => {
  const { out, far, mh, am } = await setup()
  assert.equal((await call(out, 'GET', `/team/shares/${am.shareId}/raw?open=1`)).status, 404)
  assert.equal((await call(out, 'POST', `/team/shares/${am.shareId}/opened`)).status, 404)
  assert.equal((await call(far, 'GET', `/team/shares/${am.shareId}/raw?open=1`)).status, 403)
  assert.equal((await call(far, 'POST', `/team/shares/${am.shareId}/opened`)).status, 403)
  // an address signed for the other company's person (a key someone got hold of): checked in their own company — refused (403: the
  // signature is not for that company), never served
  const { mediaKey } = S
  const { config } = await import('../config.js')
  const forged = linkPath(am.shareId, signLink({ key: mediaKey(), tenant: config.tenantId, id: am.shareId, userId: far.id, inline: true }))
  assert.ok([403, 404].includes((await call(null, 'GET', `${forged}&open=1`)).status))
  // and directly, as that company: no row of this one changes
  assert.equal(await S.recordOpen({ id: far.id }, [am.shareId]), 0)
  assert.equal((await row(am.shareId)).opened_at, null)
  assert.equal(String((await row(am.shareId)).recipient_id), mh.id)
})

test('SO-I-06 칩으로 편집기에서 열기 · 자기 사본 카드에서 열기 · 「이어서 작업」도 연 것으로 적힌다', { skip: !db }, async () => {
  const { sender, mh, am, j2, room } = await setup()
  // the chip → the editor: POST …/open (the recipient's own card)
  const o = await call(mh, 'POST', `/team/shares/${am.shareId}/open`)
  assert.equal(o.status, 200, o.text)
  assert.equal(o.body.message.content.shared.shareId, am.shareId)
  assert.ok((await row(am.shareId)).opened_at)
  // their own copy, opened from their chat (the server does not see it: the screen says so)
  await q('update pro_shares set opened_at=null, last_opened_at=null where id=$1', [am.shareId])
  const c = await call(mh, 'POST', `/team/shares/${am.shareId}/opened`)
  assert.equal(c.status, 200, c.text)
  assert.equal(c.body.recorded, true)
  assert.ok((await row(am.shareId)).opened_at)
  // 「이어서 작업」 on a second share (the agent is not there: the turn fails later, the open is recorded first)
  const up = await sendFile(sender, '견적 비교.md', Buffer.from('# 견적 비교\n- A사 300\n- B사 280\n'), 'text/markdown')
  const m2 = await call(sender, 'POST', `/team/threads/${room}/messages`, { text: '이것도 이어서 해 주세요', artifactIds: [up.body.id] })
  assert.equal(m2.status, 200, m2.text)
  const share2 = (await call(j2, 'GET', `/team/threads/${room}/messages`)).body.messages.find((x) => x.id === m2.body.id).artifacts[0].shareId
  assert.equal((await row(share2)).opened_at, null)
  const cont = await call(j2, 'POST', `/team/messages/${m2.body.id}/continue`, {})
  assert.equal(cont.status, 200, cont.text)
  assert.ok((await row(share2)).opened_at, '이어서 작업')
  const list = (await receipts(sender, room, [m2.body.id])).body.receipts[m2.body.id]
  assert.equal(list.find((p) => p.id === j2.id).opened, 1)
  assert.equal(list.filter((p) => p.opened).length, 1)
})

test('SO-I-07 누가 열었는지는 보낸 사람만 본다', { skip: !db }, async () => {
  const { j1, out, room, msg } = await setup()
  const asRecipient = await receipts(j1, room, [msg])
  assert.equal(asRecipient.status, 200)
  assert.deepEqual(asRecipient.body.receipts, {})
  const outside = await receipts(out, room, [msg])
  assert.equal(outside.status, 200)
  assert.deepEqual(outside.body.receipts, {})
  // the batch's other branch view (/branches) never carries it either
  const br = await call(j1, 'GET', `/team/messages/${msg}/branches`)
  assert.ok(!/opened/i.test(br.text), br.text)
})

test('SO-I-08 전달: 받은 사람이 자기 사본을 보내면, 그 사람이 열어도 처음 보낸 사람의 카드는 그대로', { skip: !db }, async () => {
  const { sender, j1, mh, out, room, msg } = await setup()
  // 한지우 (mail-b) forwards their own copy (the card POST …/open gave them) to 오세린 in a 1:1
  const card = (await call(j1, 'POST', `/team/shares/${(await setup()).a1.shareId}/open`)).body.message
  const dm = await call(j1, 'POST', '/team/threads', { members: [out.id] })
  rooms.push(dm.body.id)
  const fw = await call(j1, 'POST', `/team/threads/${dm.body.id}/messages`, { text: '참고하세요', artifactIds: [card.id] })
  assert.equal(fw.status, 200, fw.text)
  const fwShare = (await call(out, 'GET', `/team/threads/${dm.body.id}/messages`)).body.messages.find((x) => x.id === fw.body.id).artifacts[0].shareId
  const firstCard = JSON.stringify((await receipts(sender, room, [msg])).body.receipts[msg])
  const before = bus.lastSeq()
  assert.equal((await call(out, 'GET', `/team/shares/${fwShare}/raw?open=1`)).status, 200)
  // 오세린's own row (the forward) is marked; its sender (한지우) hears of it, 서도윤 does not
  assert.ok((await row(fwShare)).opened_at)
  assert.equal((await opened(j1, before)).length, 1)
  assert.equal((await opened(sender, before)).length, 0)
  assert.equal(JSON.stringify((await receipts(sender, room, [msg])).body.receipts[msg]), firstCard)
  const fwList = (await receipts(j1, dm.body.id, [fw.body.id])).body.receipts[fw.body.id]
  assert.deepEqual(fwList.map((p) => [p.id, p.opened]), [[out.id, 1]])
  assert.ok(!fwList.some((p) => p.id === mh.id))
})

test('SO-I-09 거둔 공유는 열 수도, 적히지도 않는다', { skip: !db }, async () => {
  const { sender, mh, am } = await setup()
  await q('update pro_shares set opened_at=null, last_opened_at=null where id=$1', [am.shareId])
  assert.equal((await call(sender, 'DELETE', `/team/shares/${am.shareId}`)).status, 200)
  assert.equal((await call(mh, 'GET', `/team/shares/${am.shareId}/raw?open=1`)).status, 404)
  assert.equal((await call(mh, 'POST', `/team/shares/${am.shareId}/opened`)).status, 404)
  assert.equal(await S.recordOpen({ id: mh.id }, [am.shareId]), 0)
  assert.equal((await row(am.shareId)).opened_at, null)
})
