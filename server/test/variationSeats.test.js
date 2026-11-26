// Variation seats, P0 (spec openspec/specs/variation-seats — 작업본은 한 곳에): a variation's working copy is in one place at most — none
// (보관 중), its person's server workroom, a server agent run, or one computer — and moving it commits what the old place held as it is first.
//   - the rules (pure): open · device · settle · release · take · recall · expire, the epoch, a person's variation only by that person,
//     the owner's take only after asking and a day without an answer (and the computer off)
//   - with the database: two claims at once — one wins; a checkout while seated elsewhere is refused; a move, a handover, a merge and a discard
//     commit what was not saved as it is; an older epoch is refused (a terminal ticket, a release, a desktop token); a chat's 「내 PC」 run on a
//     project's variation holds the seat (the server's workroom and a server agent's turn are refused meanwhile) and gives it back when it ends;
//     what it pushes after losing the seat becomes a variation of its own; seats stay in their tenant; a move that ran out of time ends
// Run: node --test test/variationSeats.test.js  (the parts with a database need the local one with sql/063; folders go to a temporary
// directory, in the test tenant "seats-test", and everything is removed afterwards)
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'pgl-seats-'))
const TENANT = 'seats-test'
process.env.PRO_TENANT_ID = TENANT
process.env.PRO_FOLDERS_ROOT = path.join(ROOT, 'folders')
process.env.PRO_LLM_BASE_URL = 'http://127.0.0.1:9/v1'
const SE = await import('../lib/folders/seats.js')

const A = 'aaaaaaaa-0000-4000-8000-000000000001'
const B = 'bbbbbbbb-0000-4000-8000-000000000002'
const NOW = Date.parse('2026-11-26T09:00:00Z')
const seat = (o = {}) => ({ place: 'server', state: 'held', run: 'workroom', user_id: A, device_id: null, job_id: null, epoch: 3, since: new Date(NOW - 60_000), deadline: null, recall: null, ...o })
const V = (o = {}) => ({ id: 'v1', holder_type: 'user', holder_id: A, status: 'open', worktree_path: '/x', seat_epoch: 3, ...o })
const d = (s, ev, v = V()) => SE.decide(s, ev, { v, now: NOW })

// ---------- the rules ----------
test('WL-U-01 열기: 보관 중이면 넘기는 중 → 자리, 회차가 오른다 · 같은 사람 같은 곳은 그대로 · 남의 자리는 거절', () => {
  const o = d(null, { type: 'open', run: 'workroom', user: A })
  assert.ok(o.ok && o.bump && !o.clear)
  assert.equal(o.next.state, 'moving')
  assert.equal(o.next.place, 'server')
  assert.ok(new Date(o.next.deadline).getTime() === NOW + SE.MOVE_MS)
  const held = d({ ...o.next, epoch: 4 }, { type: 'settle', epoch: 4 })
  assert.ok(held.ok && held.next.state === 'held' && !held.bump)
  assert.equal(d({ ...o.next, epoch: 4 }, { type: 'settle', epoch: 3 }).why, 'stale', '지난 회차의 settle 은 거절')
  assert.equal(d(seat(), { type: 'open', run: 'workroom', user: A }).action, 'same')
  assert.equal(d(seat(), { type: 'open', run: 'workroom', user: B }).why, 'held')
  assert.equal(d(seat({ run: 'agent' }), { type: 'open', run: 'workroom', user: B }).why, 'agent')
  assert.equal(d(seat({ place: 'device', device_id: 'd1', run: null }), { type: 'open', run: 'workroom', user: A }).why, 'device-mine')
  assert.equal(d(seat({ place: 'device', device_id: 'd1', run: null }), { type: 'open', run: 'workroom', user: B }).why, 'device')
  assert.equal(d(seat({ state: 'moving', deadline: new Date(NOW + 1000) }), { type: 'open', run: 'workroom', user: A }).why, 'moving')
})

test('WL-U-02 같은 사람의 작업실 → 그 사람의 서버 에이전트 턴은 옮김(먼저 커밋), 거꾸로 도는 턴에서 작업실로는 거절', () => {
  const m = d(seat(), { type: 'open', run: 'agent', user: A })
  assert.ok(m.ok && m.clear && m.bump && m.action === 'move')
  assert.equal(m.next.run, 'agent')
  assert.equal(m.next.state, 'moving')
  assert.equal(d(seat({ run: 'agent' }), { type: 'open', run: 'workroom', user: A }).why, 'agent')
  assert.equal(d(seat({ run: 'agent' }), { type: 'open', run: 'agent', user: A }).action, 'same')
})

test('WL-U-03 PC(채팅의 내 PC 실행)가 자리를 잡는다: 내 작업실은 옮김, 서버 에이전트 · 남 · 다른 실행은 거절, 같은 실행은 그대로', () => {
  const ev = { type: 'device', device: 'd1', user: A, job: 'j1' }
  const o = d(null, ev)
  assert.ok(o.ok && o.bump && o.next.place === 'device' && o.next.state === 'held' && o.next.job_id === 'j1')
  const mine = seat({ place: 'device', device_id: 'd1', run: null, job_id: 'j1' })
  assert.equal(d(mine, ev).action, 'same')
  const moved = d(mine, { ...ev, device: 'd2' })
  assert.ok(moved.ok && moved.bump && moved.next.device_id === 'd2', '같은 실행이 다른 PC 로 다시 보내지면 따라간다')
  assert.equal(d(mine, { ...ev, job: 'j2' }).why, 'device-mine', '다른 실행은 같은 변형을 PC 에 또 받지 못한다')
  assert.equal(d(seat({ run: 'agent' }), ev).why, 'agent')
  assert.equal(d(seat({ user_id: B }), ev).why, 'held')
  const fromRoom = d(seat(), ev)
  assert.ok(fromRoom.ok && fromRoom.clear && fromRoom.action === 'move', '내 서버 작업실은 먼저 커밋하고 치운다')
  assert.equal(d(null, { ...ev, ready: false }).next.state, 'moving', '데스크톱 작업본(P1)은 준비될 때까지 넘기는 중')
})

test('WL-U-04 돌려놓기: 자리를 가진 사람만, 지난 회차는 거절, 서버는 돌려놓는 중(먼저 커밋)으로, PC 는 그 PC 만', () => {
  assert.equal(d(seat(), { type: 'release', by: A, epoch: 2 }).why, 'stale')
  assert.equal(d(seat(), { type: 'release', by: B }).why, 'not-holder')
  const r = d(seat(), { type: 'release', by: A, epoch: 3 })
  assert.ok(r.ok && r.clear && r.bump && r.next.state === 'returning')
  assert.equal(d(seat({ place: 'device', device_id: 'd1', run: null }), { type: 'release', by: A }).why, 'device-mine')
  const sys = d(seat({ place: 'device', device_id: 'd1', run: null }), { type: 'release', system: true })
  assert.ok(sys.ok && sys.next === null && sys.bump)
  assert.equal(d(null, { type: 'release', by: A }).action, 'none')
})

test('WL-U-05 가져오기: 본인은 언제나 · 소유자는 돌려 달라 뒤 24시간 + PC 꺼짐일 때만', () => {
  const pc = seat({ place: 'device', device_id: 'd1', run: null })
  const self = d(pc, { type: 'take', by: A })
  assert.ok(self.ok && self.next === null && self.bump, '본인은 마지막 올림부터 가져온다')
  assert.equal(d(pc, { type: 'take', by: B }).why, 'not-holder')
  assert.equal(d(pc, { type: 'take', by: B, owner: true }).why, 'ask-first')
  const asked = { ...pc, recall: { by: B, at: new Date(NOW - 3600_000).toISOString() } }
  const w = d(asked, { type: 'take', by: B, owner: true })
  assert.equal(w.why, 'wait')
  assert.ok(w.left > 22 * 3600_000)
  const old = { ...pc, recall: { by: B, at: new Date(NOW - SE.RECALL_WAIT_MS - 1).toISOString() } }
  assert.equal(d(old, { type: 'take', by: B, owner: true, online: true }).why, 'online', 'PC 가 켜져 있으면 그 PC 에서 돌려놓기를 기다린다')
  assert.ok(d(old, { type: 'take', by: B, owner: true, online: false }).ok)
  const room = { ...seat(), recall: old.recall }
  const t = d(room, { type: 'take', by: B, owner: true })
  assert.ok(t.ok && t.clear && t.next.state === 'returning', '서버 작업실은 먼저 커밋하고 치운다')
  assert.equal(d(seat({ run: 'agent' }), { type: 'take', by: A }).why, 'agent')
  assert.equal(d(pc, { type: 'take', by: A, epoch: 1 }).why, 'stale')
})

test('WL-U-06 돌려 달라: 남의 자리에만, 서버 에이전트 실행은 아님, 회차는 그대로', () => {
  const r = d(seat(), { type: 'recall', by: B, why: '반영해야 해요' })
  assert.ok(r.ok && !r.bump && r.next.recall.by === B && r.next.recall.why === '반영해야 해요')
  assert.equal(d(seat(), { type: 'recall', by: A }).why, 'self')
  assert.equal(d(seat({ run: 'agent' }), { type: 'recall', by: B }).why, 'agent')
  assert.equal(d(null, { type: 'recall', by: B }).why, 'none')
})

test('WL-U-07 서 있지 않은 자리: 기한이 지난 넘기는 중 · 체크아웃이 없는 서버 자리는 없음으로 본다', () => {
  const late = seat({ state: 'moving', deadline: new Date(NOW - 1) })
  assert.ok(SE.stale(late, V(), NOW))
  assert.ok(d(late, { type: 'open', run: 'workroom', user: B }, V({ holder_type: 'agent', holder_id: 'x' })).ok, '기한이 지나면 다른 사람이 열 수 있다')
  assert.ok(d(late, { type: 'expire' }).ok)
  assert.equal(d(seat(), { type: 'expire' }).why, 'none')
  assert.ok(SE.stale(seat(), V({ worktree_path: null }), NOW))
  assert.ok(!SE.stale(seat({ place: 'device', device_id: 'd', run: null }), V({ worktree_path: null }), NOW), 'PC 의 자리는 서버 체크아웃이 없어도 선다')
  assert.equal(d(seat(), { type: 'drop' }).next, null)
})

test('WL-U-08 사람의 변형은 그 사람만, 에이전트의 변형은 실행할 수 있는 누구나 연다', () => {
  assert.ok(SE.mayHold(V(), A))
  assert.ok(!SE.mayHold(V(), B))
  assert.ok(SE.mayHold(V({ holder_type: 'agent', holder_id: 'deepagents' }), B))
  assert.ok(SE.mayHold(V({ holder_id: null }), B))
})

// ---------- with the database ----------
const { q, pool } = await import('../lib/supa.js')
const db = await q('select 1 from pro_variation_seats limit 1').then(() => true).catch(() => false)
const S = await import('../lib/folders/service.js')
const G = await import('../lib/folders/git.js')
const W = await import('../lib/workroom.js')
const D = await import('../lib/localAgents/devices.js')
const { withTenant, tenants, ensureTenantRow } = await import('../lib/tenant.js')
const owner = { id: crypto.randomUUID(), name: '한소유', email: 'seats-owner@example.test' }
const mate = { id: crypto.randomUUID(), name: '김동료', email: 'seats-mate@example.test' }
const third = { id: crypto.randomUUID(), name: '박편집', email: 'seats-third@example.test' }
// (the people as Process GPT has them in this tenant: a handover's receiver and a notification's person are users rows)
if (db) {
  await ensureTenantRow(TENANT).catch(() => {})
  for (const u of [owner, mate, third]) await q('insert into users (id, email, username, tenant_id) values ($1,$2,$3,$4) on conflict do nothing', [u.id, u.email, u.name, TENANT]).catch((e) => console.warn('users', e.message))
}
after(async () => {
  if (db) {
    await q('delete from pro_variation_seat_log where tenant_id=$1', [TENANT]).catch(() => {})
    for (const t of ['pro_local_jobs', 'pro_local_devices', 'pro_folders', 'todolist', 'handover_events', 'chats', 'chat_rooms', 'notifications']) await q(`delete from ${t} where tenant_id=$1`, [TENANT]).catch(() => {})
    await q("delete from users where tenant_id=$1 and email like '%@example.test'", [TENANT]).catch(() => {})
  }
  await pool.end()
  await fs.rm(ROOT, { recursive: true, force: true })
})
async function folderWith(label) {
  const f = await S.createFolder(owner, { name: `${label} ${crypto.randomBytes(3).toString('hex')}` })
  await S.upload(f, owner, '안내문.md', Buffer.from('# 안내\n\n신청: 현장 접수\n'))
  await S.setMember(f, owner, { id: mate.id, role: 'editor' })
  await S.setMember(f, owner, { id: third.id, role: 'editor' })
  return S.folderById(f.id)
}
const personVar = (f, who, title = '내 작업') => S.createVariation(f, { title, kind: 'person', holder: { type: 'user', id: who.id, name: who.name }, createdBy: who.id })
const agentVar = (f) => S.createVariation(f, { title: '가져온 갈래', kind: 'imported', holder: { type: 'agent', id: 'cliagents', name: 'Claude Code' } })
const open = (f, v, who) => SE.openServer(f, v, { user: who, run: 'workroom', dir: S.personCheckoutDir(who, v) })
const fileOn = async (f, v, p) => (await G.show(f.repo_path, (await S.variationById(v.id)).branch, p).catch(() => Buffer.from(''))).toString()
const scribble = async (v, p, text) => { const cur = await S.variationById(v.id); await fs.writeFile(path.join(cur.worktree_path, p), text) }

test('WL-I-01 같은 변형을 동시에 열면 하나만 이긴다(행 잠금) — 진 쪽은 409 와 자리', { skip: !db && 'no database' }, async () => {
  const f = await folderWith('동시')
  const v = await agentVar(f)
  const tries = await Promise.allSettled([owner, mate, third].map((who) => open(f, v, who)))
  const won = tries.filter((t) => t.status === 'fulfilled')
  const lost = tries.filter((t) => t.status === 'rejected')
  assert.equal(won.length, 1, JSON.stringify(tries.map((t) => t.reason?.message || 'ok')))
  for (const l of lost) {
    assert.equal(l.reason.status, 409)
    assert.ok(['held', 'moving'].includes(l.reason.why), l.reason.why)
    assert.ok(l.reason.seat && !('device_id' in l.reason.seat) && !JSON.stringify(l.reason.seat).includes(ROOT), '자리에는 경로 · 기기 id 가 없다')
  }
  const s = await SE.seatOf(v.id)
  assert.equal(s.state, 'held')
  assert.equal((await S.variationById(v.id)).seat_epoch, 1)
  // the raw transition too: ten claims at once, one row
  const v2 = await agentVar(f)
  const many = await Promise.all(Array.from({ length: 10 }, (_, i) => SE.transition(v2.id, (vv, st) => SE.decide(st, { type: 'open', run: 'agent', user: `agent-${i}` }, { v: vv }))))
  assert.equal(many.filter((o) => o.ok).length, 1)
  assert.equal((await q('select count(*)::int as n from pro_variation_seats where variation_id=$1', [v2.id]))[0].n, 1)
})

test('WL-I-02 다른 곳에 자리가 있으면 체크아웃은 거절: 남의 변형 · 남의 작업실 · 서버 에이전트 · PC', { skip: !db && 'no database' }, async () => {
  const f = await folderWith('거절')
  const mine = await personVar(f, owner)
  await open(f, mine, owner)
  await assert.rejects(open(f, mine, mate), (e) => e.status === 409 && e.why === 'not-yours' && /한소유/.test(e.message))
  const shared = await agentVar(f)
  await open(f, shared, mate)
  await assert.rejects(open(f, shared, owner), (e) => e.status === 409 && e.why === 'held' && e.seat.who.id === mate.id)
  // a server agent turn holds it: its person's workroom waits
  const proj = await personVar(f, owner, '프로젝트')
  await SE.openServer(f, proj, { user: owner, run: 'agent', dir: S.runCheckoutDir(`room-${proj.id.slice(0, 8)}`, f) })
  await assert.rejects(open(f, proj, owner), (e) => e.status === 409 && e.why === 'agent')
  // a computer holds it (a chat's 「내 PC」 run): the workroom is refused, with the computer's name and not its id
  const pcVar = await personVar(f, owner, 'PC 일')
  const [dev] = await q(`insert into pro_local_devices (tenant_id, user_id, name, token_hash) values ($1,$2,'맥북',$3) returning *`, [TENANT, owner.id, crypto.randomBytes(16).toString('hex')])
  await SE.claimDevice(f, pcVar, { user: owner, device: dev.id, job: crypto.randomUUID() })
  await assert.rejects(open(f, pcVar, owner), (e) => e.status === 409 && e.why === 'device-mine' && e.seat.device.name === '맥북' && !JSON.stringify(e.seat).includes(dev.id))
  // the workroom room: only the seat's person writes; the others read the branch as saved
  const roomMine = await W.resolveRoom('variation', mine.id, owner)
  assert.ok(roomMine.writable && roomMine.root)
  const roomMate = await W.resolveRoom('variation', mine.id, mate)
  assert.ok(roomMate.readonly && !roomMate.root && roomMate.need === 'viewer')
  assert.throws(() => W.assertWritable(roomMate, mate), (e) => e.status === 409)
  await assert.rejects(W.writeFile(roomMate, '안내문.md', 'x'), (e) => e.status === 409)
  assert.equal(W.terminalStatus(roomMate).status, 409)
  assert.match((await W.readFile(roomMate, '안내문.md')).content, /현장 접수/)
  assert.deepEqual((await W.tree(roomMate)).map((x) => x.path), ['.gitattributes', '안내문.md'])
  await assert.rejects(W.readFile(roomMate, '.git/config'), (e) => e.status === 400)
  assert.throws(() => W.gitRel('../x'), (e) => e.status === 400)
})

test('WL-I-03 옮길 때 저장 안 한 변경은 있는 그대로 커밋된다 — 작업실 → 서버 에이전트, 그리고 S.checkout 이 다른 곳의 체크아웃을 치울 때도', { skip: !db && 'no database' }, async () => {
  const f = await folderWith('옮김')
  const v = await personVar(f, owner)
  await open(f, v, owner)
  const roomDir = (await S.variationById(v.id)).worktree_path
  await scribble(v, '메모.md', '작업실에서 쓰고 저장 안 함\n')
  const before = Number((await S.variationById(v.id)).seat_epoch)
  await SE.openServer(f, v, { user: owner, run: 'agent', dir: S.runCheckoutDir('turn-1', f) })
  assert.match(await fileOn(f, v, '메모.md'), /저장 안 함/, '작업실에 남아 있던 것이 가지에 있다')
  await assert.rejects(fs.stat(roomDir), '옛 자리(작업실)는 디스크에서 치웠다')
  const s = await SE.seatOf(v.id)
  assert.equal(s.run, 'agent')
  assert.equal(Number((await S.variationById(v.id)).seat_epoch), before + 1)
  const log = await q('select action, from_place, to_place from pro_variation_seat_log where variation_id=$1 order by id', [v.id])
  assert.deepEqual(log.map((l) => l.action), ['open', 'held', 'move', 'held'])
  assert.equal(log[2].from_place, 'server:workroom')
  assert.equal(log[2].to_place, 'server:agent')
  // the run ends: committed and released → none
  await S.commitVariation(f, await S.variationById(v.id), owner, '턴')
  await S.release(f, await S.variationById(v.id))
  assert.equal(await SE.seatOf(v.id), null)
  // S.checkout itself (whoever calls it): another checkout of the branch is committed before it goes
  const v2 = await personVar(f, owner, '직접')
  const d1 = path.join(ROOT, 'co-1'), d2 = path.join(ROOT, 'co-2')
  await S.checkout(f, v2, d1)
  await fs.writeFile(path.join(d1, '남은.md'), '첫 자리에서\n')
  await S.checkout(f, await S.variationById(v2.id), d2)
  assert.match(await fileOn(f, v2, '남은.md'), /첫 자리에서/)
  assert.match(await fs.readFile(path.join(d2, '남은.md'), 'utf8'), /첫 자리에서/)
})

test('WL-I-04 인계는 넘기기 전에 커밋해 돌려놓는다 · 남이 작업실에 있으면 거절', { skip: !db && 'no database' }, async () => {
  const { handover } = await import('../lib/folders/handover.js')
  const f = await folderWith('인계')
  const v = await personVar(f, owner)
  await open(f, v, owner)
  await scribble(v, '인계 메모.md', '넘기기 직전에 쓴 것\n')
  await assert.rejects(handover(f, await S.variationById(v.id), third, { to: { id: mate.id }, next: '마무리' }), (e) => e.status === 409 && e.why === 'held')
  const r = await handover(f, await S.variationById(v.id), owner, { to: { id: mate.id }, next: '마무리해 주세요' })
  assert.equal(r.variation.holder_id, mate.id)
  assert.match(await fileOn(f, v, '인계 메모.md'), /넘기기 직전/, '작업실의 저장 안 한 변경까지 넘어갔다')
  assert.equal(await SE.seatOf(v.id), null)
  assert.equal((await S.variationById(v.id)).worktree_path, null)
  // the receiver opens it in their own workroom (it is theirs now); the sender no longer can
  await open(f, await S.variationById(v.id), mate)
  await assert.rejects(open(f, await S.variationById(v.id), owner), (e) => e.why === 'not-yours')
})

test('WL-I-05 지난 회차는 거절: 터미널 표 · 돌려놓기 · 데스크톱 작업본 토큰', { skip: !db && 'no database' }, async () => {
  const f = await folderWith('회차')
  const v = await personVar(f, owner)
  await open(f, v, owner)
  const room1 = await W.resolveRoom('variation', v.id, owner)
  const ticket = { userId: owner.id, epoch: room1.epoch }
  assert.ok(W.ticketHolds(room1, ticket))
  await assert.rejects(SE.closeServer(f, v, { by: owner.id, epoch: room1.epoch - 1 }), (e) => e.status === 409 && e.why === 'stale')
  await SE.closeServer(f, v, { by: owner.id, epoch: room1.epoch })
  await open(f, await S.variationById(v.id), owner)
  const room2 = await W.resolveRoom('variation', v.id, owner)
  assert.ok(room2.epoch > room1.epoch)
  assert.ok(!W.ticketHolds(room2, ticket), '옮기기 전에 받은 표로는 새 작업실의 셸을 열지 못한다')
  assert.ok(!W.ticketHolds(await W.resolveRoom('variation', v.id, mate), { userId: mate.id, epoch: room2.epoch }), '다른 사람의 표는 안 된다')
  // a desktop's working-copy token (the P1 seam): the device, the seat, the epoch, the role — every request
  const pcV = await personVar(f, owner, 'PC')
  const [dev] = await q(`insert into pro_local_devices (tenant_id, user_id, name, token_hash) values ($1,$2,'맥북',$3) returning *`, [TENANT, owner.id, crypto.randomBytes(16).toString('hex')])
  const got = await SE.claimDevice(f, pcV, { user: owner, device: dev.id, job: null, ready: true })
  const claims = { scope: 'seat', tenant: TENANT, folder: f.id, device: dev.id, seat: pcV.id, epoch: got.epoch }
  assert.equal(await D.seatAccess(claims, { push: true }), null)
  assert.match(await D.seatAccess({ ...claims, epoch: got.epoch - 1 }, { push: true }), /older epoch/)
  assert.match(await D.seatAccess({ ...claims, folder: crypto.randomUUID() }), /another folder/)
  await SE.take(f, await S.variationById(pcV.id), owner, { role: 'owner' })
  assert.match(await D.seatAccess(claims, { push: true }), /not on this desktop/, '가져온 뒤에는 그 PC 의 토큰이 멈춘다')
  const { mintToken, verifyToken } = await import('../lib/folders/gitHttp.js')
  const t = verifyToken(mintToken({ folderId: f.id, scope: 'seat', device: dev.id, seat: pcV.id, epoch: 7, push: `pgpt-agent/seat-${pcV.id.slice(0, 8)}-7/` }))
  assert.equal(t.seat, pcV.id)
  assert.equal(t.epoch, 7)
})

test('WL-I-06 반영 · 버리기: 내 작업실은 먼저 커밋해 닫고, 남의 작업실은 거절', { skip: !db && 'no database' }, async () => {
  const M = await import('../lib/folders/merge.js')
  const f = await folderWith('반영')
  const v = await personVar(f, owner)
  await open(f, v, owner)
  await scribble(v, '안내문.md', '# 안내\n\n신청: 사전 신청\n')
  await S.commitVariation(f, await S.variationById(v.id), owner, '저장')
  await scribble(v, '추가.md', '반영 직전에 쓴 것\n')
  await assert.rejects(M.start(f, { ...mate }, [v.id], 'stop', { role: 'editor' }), (e) => e.status === 409 && e.why === 'held')
  const done = await M.start(f, owner, [v.id], 'stop', { role: 'owner' })
  assert.equal(done.status, 'done')
  assert.match((await G.show(f.repo_path, 'main', '추가.md')).toString(), /반영 직전/, '저장 안 한 변경까지 반영됐다')
  assert.equal(await SE.seatOf(v.id), null)
  const v2 = await personVar(f, owner, '버릴 것')
  await open(f, v2, owner)
  await scribble(v2, '버림.md', '버리기 전\n')
  const R = await import('../routes/folders.js')
  assert.ok(R.folderRoutes)
  await assert.rejects(SE.forMove(f, await S.variationById(v2.id), mate), (e) => e.status === 409)
  await SE.forMove(f, await S.variationById(v2.id), owner)
  await S.discard(f, await S.variationById(v2.id))
  assert.match(await fileOn(f, v2, '버림.md'), /버리기 전/, '버린 변형의 가지도 저장 안 한 변경을 가진다')
})

test('WL-I-07 돌려 달라 → 알림 · 소유자는 24시간 뒤(PC 꺼짐)에만 가져온다', { skip: !db && 'no database' }, async () => {
  const f = await folderWith('돌려 달라')
  const v = await agentVar(f)
  await open(f, v, mate)
  await assert.rejects(SE.recall(f, v, mate), (e) => e.why === 'self')
  await SE.recall(f, v, third, { why: '오늘 반영해요' })
  const [n] = await q("select * from notifications where tenant_id=$1 and type='seat_recall' and user_id=$2 order by time_stamp desc limit 1", [TENANT, mate.id])
  assert.ok(n, '작업본을 가진 사람에게 알림이 간다')
  assert.match(n.url, new RegExp(`/folders/${f.slug}/v/${v.id}`))
  assert.match(n.description, /오늘 반영해요/)
  const view = await SE.viewOf(await SE.seatOf(v.id), await S.variationById(v.id), { me: owner, role: 'owner' })
  assert.equal(view.recall.by.id, third.id)
  assert.equal(view.can.take, false, '하루가 지나기 전에는 소유자도 못 가져온다')
  await assert.rejects(SE.take(f, v, owner, { role: 'owner' }), (e) => e.why === 'wait')
  await q(`update pro_variation_seats set recall = jsonb_set(recall, '{at}', to_jsonb((now() - interval '25 hours')::text)) where variation_id=$1`, [v.id])
  const v2 = await SE.viewOf(await SE.seatOf(v.id), await S.variationById(v.id), { me: owner, role: 'owner' })
  assert.equal(v2.can.take, true)
  await scribble(v, '김동료.md', '가져가기 전에 쓴 것\n')
  await SE.take(f, await S.variationById(v.id), owner, { role: 'owner' })
  assert.equal(await SE.seatOf(v.id), null)
  assert.match(await fileOn(f, v, '김동료.md'), /가져가기 전/)
})

test('WL-I-08 채팅의 「내 PC」 실행이 프로젝트 변형의 자리를 쥔다 — 서버 작업실 · 서버 에이전트 턴은 그동안 거절, 끝나면 보관, 잃은 뒤 올린 것은 새 변형', { skip: !db && 'no database' }, async () => {
  const C = await import('../lib/localAgents/chat.js')
  const TF = await import('../lib/folders/threadFolders.js')
  const f = await folderWith('프로젝트 PC')
  const v = await personVar(f, owner, '프로젝트 변형')
  await open(f, v, owner)
  await scribble(v, '작업실.md', 'PC 로 보내기 전에 작업실에서 쓴 것\n')
  const [dev] = await q(`insert into pro_local_devices (tenant_id, user_id, name, token_hash) values ($1,$2,'사무실 PC',$3) returning *`, [TENANT, owner.id, crypto.randomBytes(16).toString('hex')])
  const chat = { key: 't', threadId: crypto.randomUUID(), mode: 'project', folderId: f.id, folderName: f.name, folderSlug: f.slug, line: v.branch, variation: v.id, message: '고쳐 줘', messages: [], replies: [], carded: [] }
  const [job] = await q(`insert into pro_local_jobs (tenant_id, user_id, todo_id, kind, thread_id, activity_name, agent, mode, offline, server_agent, person_name, chat, folder_id, line, device_id, device_name, state)
                         values ($1,$2,$3,'chat',$4,'프로젝트','claude-code','complete','wait','onto','한소유',$5,$6,$7,$8,'사무실 PC','offered') returning *`,
  [TENANT, owner.id, `chat:${crypto.randomUUID()}`, chat.threadId, JSON.stringify(chat), f.id, v.branch, dev.id])
  const payload = await C.prepare(job, { id: dev.id, name: '사무실 PC', userId: owner.id })
  assert.equal(payload.git.line, v.branch)
  const s = await SE.seatOf(v.id)
  assert.equal(s.place, 'device')
  assert.equal(String(s.job_id), job.id)
  assert.match(await fileOn(f, v, '작업실.md'), /PC 로 보내기 전에/, '작업실의 저장 안 한 변경은 PC 로 옮기기 전에 커밋됐다')
  assert.equal((await S.variationById(v.id)).worktree_path, null, '서버 체크아웃과 PC 의 사본이 동시에 있지 않다')
  await assert.rejects(open(f, await S.variationById(v.id), owner), (e) => e.why === 'device-mine')
  await assert.rejects(SE.openServer(f, await S.variationById(v.id), { user: owner, run: 'agent', dir: S.runCheckoutDir('turn-x', f) }), (e) => {
    assert.match(TF.seatHint(e), /사무실 PC/)
    return e.why === 'device-mine'
  })
  // a second run (another agent of the same chat) does not get its own copy of the same variation
  await assert.rejects(SE.claimDevice(f, v, { user: owner, device: dev.id, job: crypto.randomUUID() }), (e) => e.why === 'device-mine')
  // the run pushes a turn: it comes into the variation while it holds the seat
  const j1 = (await q('select * from pro_local_jobs where id=$1', [job.id]))[0]
  const work = path.join(ROOT, 'pc-work')
  await G.git(f.repo_path, ['worktree', 'add', '-q', '-b', `pgpt-agent/local-${job.id.slice(0, 8)}-a`, work, v.branch])
  await fs.writeFile(path.join(work, 'PC.md'), 'PC 에서 한 일\n')
  await G.commitAll(work, 'PC 턴', { name: '한소유' })
  const out = await C.complete(j1, { pushed: true, branch: `pgpt-agent/local-${job.id.slice(0, 8)}-a`, files: [] })
  assert.ok(out?.head)
  assert.match(await fileOn(f, v, 'PC.md'), /PC 에서 한 일/)
  assert.ok((await SE.seatOf(v.id)).pushed_at, '올라온 때가 남는다(방금 올림)')
  // the person takes it back here (the run is asked to end); what the run pushes after that is a variation of its own
  await SE.take(f, await S.variationById(v.id), owner, { role: 'owner' })
  await fs.writeFile(path.join(work, 'PC.md'), '가져간 뒤 PC 에서 한 일\n')
  await G.commitAll(work, 'PC 턴 2', { name: '한소유' })
  const j2 = (await q('select * from pro_local_jobs where id=$1', [job.id]))[0]
  await C.complete(j2, { pushed: true, branch: `pgpt-agent/local-${job.id.slice(0, 8)}-a`, files: [] })
  assert.doesNotMatch(await fileOn(f, v, 'PC.md'), /가져간 뒤/, '자리를 잃은 실행의 결과는 말없이 섞이지 않는다')
  const [left] = await q(`select * from pro_folder_variations where folder_id=$1 and source->>'left_of'=$2`, [f.id, v.id])
  assert.ok(left, '새 변형으로 올라왔다')
  assert.equal(left.kind, 'imported')
  assert.match(left.title, /사무실 PC에 남아 있던 변경/)
  assert.match((await G.show(f.repo_path, left.branch, 'PC.md')).toString(), /가져간 뒤/)
  // a run that ends gives its seat back
  const v3 = await personVar(f, owner, '끝나면 보관')
  const jobId = crypto.randomUUID()
  await SE.claimDevice(f, v3, { user: owner, device: dev.id, job: jobId })
  assert.equal(await SE.releaseJob({ id: jobId, user_id: owner.id, state: 'done' }), 1)
  assert.equal(await SE.seatOf(v3.id), null)
  await G.git(f.repo_path, ['worktree', 'remove', '--force', work], { check: false })
})

test('WL-I-09 자리는 그 테넌트 안에서만 보인다 · 기한이 지난 넘기기는 보관 중으로', { skip: !db && 'no database' }, async () => {
  const f = await folderWith('테넌트')
  const v = await agentVar(f)
  await open(f, v, owner)
  assert.equal((await SE.seatsOfFolder(f.id)).length, 1)
  const other = tenants().find((t) => t !== TENANT)
  if (other) assert.equal((await withTenant(other, () => SE.seatsOfFolder(f.id))).length, 0, `${other} 에서는 보이지 않는다`)
  // a move that never finished (the server stopped in the middle): past its deadline it is none, and the sweep removes it
  const v2 = await agentVar(f)
  await SE.transition(v2.id, (vv, st) => SE.decide(st, { type: 'open', run: 'agent', user: 'x' }, { v: vv }))
  await q(`update pro_variation_seats set deadline = now() - interval '1 minute' where variation_id=$1`, [v2.id])
  assert.equal(await SE.seatOf(v2.id), null)
  const before = Number((await S.variationById(v2.id)).seat_epoch)
  await SE.sweep()
  assert.equal((await q('select count(*)::int as n from pro_variation_seats where variation_id=$1', [v2.id]))[0].n, 0)
  assert.equal(Number((await S.variationById(v2.id)).seat_epoch), before + 1)
  assert.ok((await q(`select 1 from pro_variation_seat_log where variation_id=$1 and action='expire'`, [v2.id])).length)
})
