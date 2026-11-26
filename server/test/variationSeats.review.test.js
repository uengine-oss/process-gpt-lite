// Variation seats — the review of PR #86 (2026-11-26): each case here failed before its fix.
//   R-01 a server restart (a new process) never puts away a step deepagents runs outside this server, nor a chat change (recoverChatRuns
//        has those); a turn whose process stopped saying it runs is put away. A step that ends without its checkout gets one again.
//   R-02 a move whose commit fails changes nothing (the seat stays, the folder stays); what git does not carry (ignored files, a repository
//        inside) is moved aside next to the folder, never deleted — also when S.checkout takes a branch from another place
//   R-03 an agent run's end touches only its own seat (its epoch): a run whose seat moved leaves its result as a variation of its own; a
//        person cannot release a server agent's seat; a drop needs the run's epoch
//   R-04 an instance line opens read only
//   R-05 no place takes a variation while it is being merged; a merge does not call merged a variation that moved past what it merged
//   R-06 a move in progress elsewhere (the lock held) is not expired by the sweep
//   R-07 a workroom write with a room read before a move is refused and does not bring the folder back
//   R-08 a checkout with no seat (from before seats, or left by a crash) is put away — by its person, and by the sweep
//   R-09 asking again does not restart the owner's day, and each asker notifies at most once in a few hours
//   R-10 a room is found only in its own tenant
//   R-12 the read-only listing is one pass (20 000 files in well under a second) and resolving a room asks the database few times
//   R-13 a run that fails while it is being set up gives its seat back
// Run: node --test test/variationSeats.review.test.js  (the local database with sql/063; folders in a temporary directory, tenant
// "seats-review", removed afterwards)
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'pgl-seats-review-'))
const TENANT = 'seats-review'
process.env.PRO_TENANT_ID = TENANT
process.env.PRO_FOLDERS_ROOT = path.join(ROOT, 'folders')
process.env.PRO_LLM_BASE_URL = 'http://127.0.0.1:9/v1'
const SE = await import('../lib/folders/seats.js')
const { q, pool } = await import('../lib/supa.js')
const db = await q('select work, ref from pro_variation_seats limit 1').then(() => true).catch(() => false)
const S = await import('../lib/folders/service.js')
const G = await import('../lib/folders/git.js')
const W = await import('../lib/workroom.js')
const { withTenant, tenants, ensureTenantRow } = await import('../lib/tenant.js')
const owner = { id: crypto.randomUUID(), name: '한소유', email: 'review-owner@example.test' }
const mate = { id: crypto.randomUUID(), name: '김동료', email: 'review-mate@example.test' }
const third = { id: crypto.randomUUID(), name: '박편집', email: 'review-third@example.test' }
if (db) {
  await ensureTenantRow(TENANT).catch(() => {})
  for (const u of [owner, mate, third]) await q('insert into users (id, email, username, tenant_id) values ($1,$2,$3,$4) on conflict do nothing', [u.id, u.email, u.name, TENANT]).catch(() => {})
}
const chmodded = []
after(async () => {
  for (const f of chmodded) await fs.chmod(f, 0o644).catch(() => {})
  if (db) {
    await q('delete from pro_variation_seat_log where tenant_id=$1', [TENANT]).catch(() => {})
    for (const t of ['pro_local_devices', 'pro_folders', 'notifications']) await q(`delete from ${t} where tenant_id=$1`, [TENANT]).catch(() => {})
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
const agentVar = (f, kind = 'run') => S.createVariation(f, { title: '실행', kind, holder: { type: 'agent', id: 'deepagents', name: '단계' } })
const open = (f, v, who) => SE.openServer(f, v, { user: who, run: 'workroom', dir: S.personCheckoutDir(who, v) })
const fileOn = async (f, v, p) => (await G.show(f.repo_path, (await S.variationById(v.id)).branch, p).catch(() => Buffer.from(''))).toString()
const wt = async (v) => (await S.variationById(v.id)).worktree_path
const asideOf = async (dir) => (await fs.readdir(path.dirname(dir))).filter((n) => n.startsWith(`${path.basename(dir)}.kept-`)).map((n) => path.join(path.dirname(dir), n))

// ---------- the rules ----------
const A = 'aaaaaaaa-0000-4000-8000-000000000001'
const seat = (o = {}) => ({ place: 'server', state: 'held', run: 'workroom', user_id: A, device_id: null, job_id: null, epoch: 3, since: new Date(), deadline: null, recall: null, ...o })
const d = (s, ev) => SE.decide(s, ev, { v: { id: 'v', holder_type: 'user', holder_id: A, status: 'open', worktree_path: '/x', seat_epoch: 3 } })

test('R-03a 드롭은 그 실행의 회차로만 · 사람은 서버 에이전트의 자리를 돌려놓지 못한다', () => {
  assert.equal(d(seat(), { type: 'drop', epoch: 3 }).ok, false, '작업실 자리는 실행의 끝으로 지워지지 않는다')
  assert.equal(d(seat({ run: 'agent' }), { type: 'drop', epoch: 2 }).ok, false, '다른 회차의 실행은 지우지 못한다')
  assert.equal(d(seat({ run: 'agent' }), { type: 'drop' }).ok, false, '회차 없이는 지우지 못한다')
  assert.equal(d(seat({ run: 'agent' }), { type: 'drop', epoch: 3 }).ok, true)
  assert.equal(d(seat({ run: 'agent' }), { type: 'release', by: A }).why, 'agent', '내 프로젝트 턴이라도 사람이 돌려놓지 못한다')
})

test('R-09a 다시 돌려 달라고 해도 첫 요청의 때가 남는다', () => {
  const first = new Date(Date.now() - 3 * 3600_000).toISOString()
  const r = d(seat({ recall: { by: 'b', at: first, asks: { b: first } } }), { type: 'recall', by: 'c', why: '저도요' })
  assert.equal(r.ok, true)
  assert.equal(r.next.recall.at, first)
  assert.equal(r.notify, true, '처음 묻는 사람은 알린다')
  const again = d(seat({ recall: { by: 'b', at: first, asks: { b: new Date().toISOString() } } }), { type: 'recall', by: 'b' })
  assert.equal(again.ok, true)
  assert.equal(again.notify, false, '같은 사람이 곧 다시 물으면 알리지 않는다')
  assert.equal(again.next.recall.at, first)
})

test('R-04a 인스턴스 줄은 작업실에서 열지 않는다', () => {
  assert.equal(SE.mayHold({ kind: 'instance', holder_type: 'agent', holder_id: null }, A), false)
})

test('R-12a 읽기 전용 목록은 한 번에 — 2만 개 파일', () => {
  const files = []
  for (let i = 0; i < 2000; i++) for (let j = 0; j < 10; j++) files.push({ path: `d${i % 40}/e${i}/f${j}.md`, size: 1 })
  const t0 = Date.now()
  const out = W.listing(files)
  assert.ok(Date.now() - t0 < 800, `${Date.now() - t0}ms`)
  assert.equal(out.filter((x) => !x.dir).length, 20000)
  const small = W.listing([{ path: 'b.md', size: 1 }, { path: 'a/z.md', size: 1 }, { path: 'a/b/c.md', size: 1 }, { path: 'a.md', size: 1 }])
  assert.deepEqual(small.map((x) => `${x.dir ? 'D' : 'F'}${x.depth}:${x.path}`), ['D0:a', 'D1:a/b', 'F2:a/b/c.md', 'F1:a/z.md', 'F0:a.md', 'F0:b.md'])
})

// ---------- with the database ----------
test('R-01 다시 시작한 서버의 쓸기는 밖에서 도는 단계 · 채팅 변경을 치우지 않고, 멈춘 턴만 치운다', { skip: !db && 'no database' }, async () => {
  const f = await folderWith('재시작')
  const step = await agentVar(f)
  await SE.openServer(f, step, { user: { id: 'deepagents', name: '단계' }, run: 'agent', work: 'step', ref: crypto.randomUUID(), dir: S.runCheckoutDir('step-room', f) })
  await fs.writeFile(path.join(await wt(step), '결과.md'), '단계가 쓴 것\n')
  const chat = await personVar(f, owner, '채팅 변경')
  await SE.openServer(f, chat, { user: owner, run: 'agent', work: 'chat', ref: 'chat-room', dir: S.runCheckoutDir('chat-room', f) })
  const turn = await personVar(f, owner, '프로젝트')
  await SE.openServer(f, turn, { user: owner, run: 'agent', work: 'turn', ref: 'conv-1', dir: S.runCheckoutDir('conv-1', f) })
  // all three began long before (an earlier process); only the turn's process stopped saying it runs it
  await q(`update pro_variation_seats set since = now() - interval '2 hours', seen_at = now() - interval '2 hours' where variation_id = any($1)`, [[step.id, chat.id, turn.id]])
  for (const x of [turn, step, chat]) SE.forget?.(x.id)
  await SE.sweep({ restart: true })
  assert.ok(await SE.seatOf(step.id), '단계의 자리는 그대로')
  assert.ok(existsSync(path.join(await wt(step), '결과.md')), '단계가 쓴 파일이 그대로 있다')
  assert.ok(await SE.seatOf(chat.id), '채팅 변경은 recoverChatRuns 의 몫')
  assert.equal(await SE.seatOf(turn.id), null, '멈춘 턴은 치운다')
  // a step that ends without its checkout (it went somehow): it gets one again before its output is brought in
  const lost = await agentVar(f)
  const WK = await import('../lib/folders/work.js')
  const out = await WK.finishStep(f, lost, { id: crypto.randomUUID(), activity_name: '단계' })
  assert.equal(out.reopened, true)
  assert.equal(await SE.seatOf(lost.id), null)
})

test('R-02 커밋하지 못하면 옮기지 않고, git 이 싣지 않는 것은 옆으로 옮겨 둔다(지우지 않음)', { skip: (!db && 'no database') || (process.getuid?.() === 0 && 'root reads everything') }, async () => {
  const f = await folderWith('커밋 실패')
  const v = await personVar(f, owner)
  await open(f, v, owner)
  const dir = await wt(v)
  await fs.writeFile(path.join(dir, '못 읽는 파일.md'), '권한 없음\n')
  await fs.chmod(path.join(dir, '못 읽는 파일.md'), 0o000)
  chmodded.push(path.join(dir, '못 읽는 파일.md'))
  await assert.rejects(SE.closeServer(f, await S.variationById(v.id), { by: owner.id, me: owner }), (e) => e.status === 409 && e.why === 'unsaved')
  const s = await SE.seatOf(v.id)
  assert.equal(s?.run, 'workroom', '자리는 그 사람의 작업실 그대로')
  assert.equal(s.state, 'held')
  assert.ok(existsSync(path.join(dir, '못 읽는 파일.md')), '작업실 폴더는 그대로')
  await fs.chmod(path.join(dir, '못 읽는 파일.md'), 0o644)
  // ignored files and a repository inside: moved aside with the folder, never deleted
  await fs.writeFile(path.join(dir, '.gitignore'), '*.log\n')
  await fs.writeFile(path.join(dir, '비밀.log'), '무시되는 파일\n')
  // (a repository cloned into the workroom: git keeps only a link to it, its files would not be in the commit)
  await fs.mkdir(path.join(dir, '안쪽'), { recursive: true })
  await G.git(path.join(dir, '안쪽'), ['init', '-q'])
  await fs.writeFile(path.join(dir, '안쪽', '속.md'), '안쪽 저장소의 파일\n')
  await G.git(path.join(dir, '안쪽'), [...G.who('x', 'x@example.test'), 'add', '-A'])
  await G.git(path.join(dir, '안쪽'), [...G.who('x', 'x@example.test'), 'commit', '-q', '-m', 'inner'])
  const out = await SE.closeServer(f, await S.variationById(v.id), { by: owner.id, me: owner })
  assert.ok(out.kept > 0, JSON.stringify(out))
  const [aside] = await asideOf(dir)
  assert.ok(aside && existsSync(path.join(aside, '비밀.log')) && existsSync(path.join(aside, '안쪽', '속.md')), '옆에 옮겨 둔 폴더에 있다')
  assert.equal(await SE.seatOf(v.id), null)
  // S.checkout taking a branch from another place whose commit fails: nothing moves
  const v2 = await personVar(f, owner, '직접')
  const d1 = path.join(ROOT, 'co-a'), d2 = path.join(ROOT, 'co-b')
  await S.checkout(f, v2, d1)
  await fs.writeFile(path.join(d1, '잠김.md'), 'x\n')
  await fs.chmod(path.join(d1, '잠김.md'), 0o000)
  chmodded.push(path.join(d1, '잠김.md'))
  await assert.rejects(S.checkout(f, await S.variationById(v2.id), d2))
  assert.ok(existsSync(path.join(d1, '잠김.md')), '첫 자리는 그대로')
  await fs.chmod(path.join(d1, '잠김.md'), 0o644)
})

test('R-03b 자리를 잃은 실행의 끝: 결과는 새 변형으로, 그 사이 생긴 다른 자리는 건드리지 않는다', { skip: !db && 'no database' }, async () => {
  const f = await folderWith('실행 끝')
  const v = await personVar(f, owner, '프로젝트')
  const run = await SE.openServer(f, v, { user: owner, run: 'agent', work: 'turn', ref: 'conv-9', dir: S.runCheckoutDir('conv-9', f) })
  assert.ok(run.epoch > 0 && run.base)
  // its process is taken for dead and its seat put away; the person opens it in the workroom
  SE.forget(v.id)
  await q(`update pro_variation_seats set seen_at = now() - interval '1 hour' where variation_id=$1`, [v.id])
  await SE.sweep()
  await open(f, await S.variationById(v.id), owner)
  // the run was alive after all and ends now
  const out = await SE.finishRun(f, await S.variationById(v.id), run, {
    fill: async (dir) => fs.writeFile(path.join(dir, '턴.md'), '늦게 끝난 턴\n'),
    commit: async (cur) => S.commitVariation(f, cur, owner, '턴'), user: owner.id, where: '서버 에이전트 턴' })
  assert.equal(out.held, false)
  const s = await SE.seatOf(v.id)
  assert.equal(s?.run, 'workroom', '사람의 작업실 자리는 그대로')
  assert.equal(await fileOn(f, v, '턴.md'), '', '변형에는 섞이지 않는다')
  assert.match((await G.show(f.repo_path, out.left.branch, '턴.md')).toString(), /늦게 끝난 턴/, '새 변형이 가진다')
  // a drop with the run's (old) epoch does not touch the person's seat either
  assert.equal((await SE.dropServer(v.id, { epoch: run.epoch }))?.ok ?? false, false)
  assert.equal((await SE.seatOf(v.id))?.run, 'workroom')
  assert.ok(existsSync(await wt(v)), '사람의 작업실 폴더도 그대로')
})

test('R-04b 인스턴스 줄을 작업실에서 열면 거절된다', { skip: !db && 'no database' }, async () => {
  const f = await folderWith('줄')
  const line = await S.createVariation(f, { title: '인스턴스', kind: 'instance', branch: `inst/${crypto.randomBytes(4).toString('hex')}` })
  await assert.rejects(open(f, line, owner), (e) => e.status === 409 && e.why === 'line')
})

test('R-05 반영 중인 변형은 어느 자리도 받지 않고, 반영한 데보다 앞서간 변형은 반영됨이 아니다', { skip: !db && 'no database' }, async () => {
  const M = await import('../lib/folders/merge.js')
  const f = await folderWith('반영 중')
  const mk = async (title, text) => {
    const v = await personVar(f, owner, title)
    await open(f, v, owner)
    await fs.writeFile(path.join(await wt(v), '안내문.md'), text)
    await SE.closeServer(f, await S.variationById(v.id), { by: owner.id, me: owner })
    return S.variationById(v.id)
  }
  const a = await mk('가', '# 안내\n\n신청: 가\n')
  const b = await mk('나', '# 안내\n\n신청: 나\n')
  const row = await M.start(f, owner, [a.id, b.id], 'stop', { role: 'owner' })
  assert.equal(row.status, 'conflicted')
  await assert.rejects(SE.openServer(f, await S.variationById(b.id), { user: owner, run: 'agent', work: 'turn', ref: 'x', dir: S.runCheckoutDir('x', f) }), (e) => e.why === 'integrating')
  const [dev] = await q(`insert into pro_local_devices (tenant_id, user_id, name, token_hash) values ($1,$2,'맥북',$3) returning *`, [TENANT, owner.id, crypto.randomBytes(16).toString('hex')])
  await assert.rejects(SE.claimDevice(f, await S.variationById(b.id), { user: owner, device: dev.id, job: crypto.randomUUID() }), (e) => e.why === 'integrating')
  // something moved b's branch past what the merge took (from before this fix, or by hand)
  const tmp = path.join(ROOT, 'stray')
  await G.git(f.repo_path, ['worktree', 'add', '-q', tmp, b.branch])
  await fs.writeFile(path.join(tmp, '나중.md'), '반영 뒤에 생긴 것\n')
  await G.commitAll(tmp, '나중', { name: '한소유' })
  await G.git(f.repo_path, ['worktree', 'remove', '--force', tmp])
  const done = await M.choose(f, await M.get(f, row.id), owner, { '안내문.md': 'ours' })
  assert.equal(done.status, 'done')
  assert.equal((await S.variationById(a.id)).status, 'merged')
  assert.equal((await S.variationById(b.id)).status, 'ready', '반영한 뒤에 생긴 커밋이 있으면 반영됨이 아니다')
})

test('R-06 다른 곳에서 넘기는 중(잠금이 잡혀 있음)이면 쓸기가 기한으로 치우지 않는다', { skip: !db && 'no database' }, async () => {
  const f = await folderWith('잠금')
  const v = await agentVar(f)
  await SE.transition(v.id, (vv, st) => SE.decide(st, { type: 'open', run: 'agent', user: 'x' }, { v: vv }))
  await q(`update pro_variation_seats set deadline = now() - interval '1 minute' where variation_id=$1`, [v.id])
  const key = SE.lockKey(v.id)
  const c = await pool.connect()
  try {
    await c.query('select pg_advisory_lock($1::bigint)', [key])
    await SE.sweep()
    assert.equal((await q('select count(*)::int as n from pro_variation_seats where variation_id=$1', [v.id]))[0].n, 1, '잠금을 잡은 쪽이 끝낼 때까지 둔다')
  } finally { await c.query('select pg_advisory_unlock($1::bigint)', [key]).catch(() => {}); c.release() }
  await SE.sweep()
  assert.equal((await q('select count(*)::int as n from pro_variation_seats where variation_id=$1', [v.id]))[0].n, 0)
})

test('R-07 옮기기 전에 읽은 작업실로 쓰면 거절되고, 치운 폴더가 다시 생기지 않는다', { skip: !db && 'no database' }, async () => {
  const f = await folderWith('늦은 쓰기')
  const v = await personVar(f, owner)
  await open(f, v, owner)
  const room = await W.resolveRoom('variation', v.id, owner)
  await SE.closeServer(f, await S.variationById(v.id), { by: owner.id, me: owner })
  // (the route's write: before this fix the room's own check and a plain write)
  const write = W.writeAs || (async (r, u, rel, c) => { W.assertWritable(r, u); return W.writeFile(r, rel, c) })
  await assert.rejects(write(room, owner, '늦게.md', '옮긴 뒤에 온 쓰기\n'), (e) => e.status === 409)
  assert.equal(existsSync(room.root), false)
})

test('R-08 자리 없는 체크아웃: 그 사람이 돌려놓거나 쓸기가 보관한다(있는 그대로 커밋)', { skip: !db && 'no database' }, async () => {
  const f = await folderWith('고아')
  const v = await personVar(f, owner)
  const dir = path.join(ROOT, 'orphan-1')
  await S.checkout(f, v, dir)
  await fs.writeFile(path.join(dir, '예전.md'), '자리 전부터 있던 작업실\n')
  await SE.closeServer(f, await S.variationById(v.id), { by: owner.id, me: owner })
  assert.equal(await wt(v), null)
  assert.match(await fileOn(f, v, '예전.md'), /자리 전부터/)
  const v2 = await personVar(f, owner, '오래된')
  const dir2 = path.join(ROOT, 'orphan-2')
  await S.checkout(f, v2, dir2)
  await fs.writeFile(path.join(dir2, '버려진.md'), '아무도 안 치운 체크아웃\n')
  await q(`update pro_folder_variations set updated_at = now() - interval '1 hour' where id=$1`, [v2.id])
  await SE.sweep()
  assert.equal(await wt(v2), null)
  assert.match(await fileOn(f, v2, '버려진.md'), /아무도 안 치운/)
})

test('R-09b 같은 사람의 돌려 달라는 몇 시간에 한 번만 알리고, 소유자의 하루는 첫 요청부터', { skip: !db && 'no database' }, async () => {
  const f = await folderWith('알림')
  const v = await agentVar(f, 'imported')
  await open(f, v, mate)
  await SE.recall(f, v, third)
  const at1 = (await SE.seatOf(v.id)).recall.at
  await SE.recall(f, v, third)
  await SE.recall(f, v, owner)
  const n = await q(`select from_user_id from notifications where tenant_id=$1 and type='seat_recall' and user_id=$2`, [TENANT, mate.id])
  assert.equal(n.length, 2, '박편집 한 번 · 한소유 한 번')
  assert.equal((await SE.seatOf(v.id)).recall.at, at1)
})

test('R-10 다른 회사에서는 작업실을 찾지 못한다', { skip: !db && 'no database' }, async () => {
  const other = tenants().find((t) => t !== TENANT)
  if (!other) return
  const f = await folderWith('회사')
  const v = await personVar(f, owner)
  await open(f, v, owner)
  assert.ok(await W.resolveRoom('variation', v.id, owner))
  assert.equal(await withTenant(other, () => W.resolveRoom('variation', v.id, owner)), null)
})

test('R-12b 작업실 하나를 여는 데 데이터베이스에 묻는 수가 적다', { skip: !db && 'no database' }, async () => {
  const f = await folderWith('질의')
  const v = await personVar(f, owner)
  await open(f, v, owner)
  const { roomSeat } = await import('../lib/folders/rooms.js')
  const was = pool.query.bind(pool)
  let n = 0
  pool.query = (...a) => { n++; return was(...a) }
  try {
    const room = await W.resolveRoom('variation', v.id, mate)
    assert.ok(await W.canAccess(mate, room))
    await roomSeat(room, mate)
  } finally { pool.query = was }
  assert.ok(n <= 7, `${n} queries`)
})

test('R-13 설정하다 실패한 실행은 자리를 돌려준다', { skip: !db && 'no database' }, async () => {
  const f = await folderWith('설정 실패')
  const v = await personVar(f, owner, '프로젝트')
  await assert.rejects(SE.withRun(f, v, { user: owner, work: 'turn', ref: 'conv-x', dir: S.runCheckoutDir('conv-x', f) }, async () => { throw new Error('pushRoomDir failed') }), /pushRoomDir failed/)
  assert.equal(await SE.seatOf(v.id), null)
  assert.equal(await wt(v), null)
})
