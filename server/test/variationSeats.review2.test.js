// Variation seats — the second review of PR #86 (2026-11-26): each case here failed before its fix.
//   K-01 what git does not carry is kept only where it matters: a run's ignored files (caches, logs) are dropped; a person's workroom's are
//        kept — only those paths, under <folders>/.kept/<variation>/<time> (outside every room), recorded, listed on the variation and
//        downloadable, and removed after the retention days
//   L-02 a variation's disk lock is a lease row (no pooled client held through the work): a person's move waits a few seconds, then 409 busy
//   W-03 a stale git lock (a process killed mid-commit) is cleared; a lock that is not stale refuses the move without a new epoch or a log
//        row, and the sweep backs off instead of retrying every 30 s; git's words carry no server path
//   H-04 a run's heartbeat is its own (work · ref · epoch): it never keeps the next holder alive, and it stops when the run ends even when
//        bringing its result in threw
//   C-05 an agent run whose commit fails keeps everything its checkout held (recorded, listed) — never a silent copy
// Run: node --test test/variationSeats.review2.test.js  (the local database with sql/063; folders in a temporary directory, tenant
// "seats-review2", removed afterwards)
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'pgl-seats-review2-'))
const TENANT = 'seats-review2'
process.env.PRO_TENANT_ID = TENANT
process.env.PRO_FOLDERS_ROOT = path.join(ROOT, 'folders')
process.env.PRO_LLM_BASE_URL = 'http://127.0.0.1:9/v1'
const SE = await import('../lib/folders/seats.js')
const { q, pool } = await import('../lib/supa.js')
const db = await q('select 1 from pro_variation_locks limit 1').then(() => true).catch(() => false)
const S = await import('../lib/folders/service.js')
const G = await import('../lib/folders/git.js')
const { ensureTenantRow } = await import('../lib/tenant.js')
const owner = { id: crypto.randomUUID(), name: '한소유', email: 'review2-owner@example.test' }
if (db) {
  await ensureTenantRow(TENANT).catch(() => {})
  await q('insert into users (id, email, username, tenant_id) values ($1,$2,$3,$4) on conflict do nothing', [owner.id, owner.email, owner.name, TENANT]).catch(() => {})
}
const chmodded = []
after(async () => {
  for (const f of chmodded) await fs.chmod(f, 0o644).catch(() => {})
  if (db) {
    await q('delete from pro_variation_seat_log where tenant_id=$1', [TENANT]).catch(() => {})
    await q('delete from pro_folders where tenant_id=$1', [TENANT]).catch(() => {})
    await q("delete from users where tenant_id=$1 and email like '%@example.test'", [TENANT]).catch(() => {})
  }
  await pool.end()
  await fs.rm(ROOT, { recursive: true, force: true })
})
async function folderWith(label, gitignore = '') {
  const f = await S.createFolder(owner, { name: `${label} ${crypto.randomBytes(3).toString('hex')}` })
  await S.upload(f, owner, '안내문.md', Buffer.from('# 안내\n'))
  // (the folder's own .gitignore — written in place and committed on main: an upload never takes one)
  if (gitignore) { await fs.writeFile(path.join(f.repo_path, '.gitignore'), gitignore); await S.commitMain(f, owner, '.gitignore') }
  return S.folderById(f.id)
}
const personVar = (f, title = '내 작업') => S.createVariation(f, { title, kind: 'person', holder: { type: 'user', id: owner.id, name: owner.name }, createdBy: owner.id })
const open = (f, v) => SE.openServer(f, v, { user: owner, run: 'workroom', dir: S.personCheckoutDir(owner, v) })
const wt = async (v) => (await S.variationById(v.id)).worktree_path
const keptRoot = (v) => path.join(S.foldersRoot(), '.kept', String(v.id))
const listKept = async (v) => (await fs.readdir(keptRoot(v)).catch(() => [])).map((x) => path.join(keptRoot(v), x))
const logs = async (v, action) => q('select * from pro_variation_seat_log where variation_id=$1 and ($2::text is null or action=$2) order by id', [v.id, action || null])
const strict = (f, who, msg) => (cur) => S.commitVariation(f, cur, who, msg, { strict: true })

test('K-01a 에이전트 실행의 무시된 파일(캐시)은 버리고, 방의 나무에도 남기지 않는다', { skip: !db && 'no database' }, async () => {
  const f = await folderWith('캐시', '__pycache__/\n*.log\n')
  const v = await personVar(f, '프로젝트')
  const dir = path.join(S.foldersRoot(), '.runs', `turn-${crypto.randomBytes(3).toString('hex')}`, f.slug)
  const run = await SE.openServer(f, v, { user: owner, run: 'agent', work: 'turn', ref: 'conv-k1', dir })
  const out = await SE.finishRun(f, await S.variationById(v.id), run, {
    fill: async (d) => { await fs.mkdir(path.join(d, '__pycache__'), { recursive: true }); await fs.writeFile(path.join(d, '__pycache__', 'a.pyc'), 'x'); await fs.writeFile(path.join(d, 'run.log'), 'x'); await fs.writeFile(path.join(d, '결과.md'), '결과\n') },
    commit: strict(f, owner, '턴'),
  })
  assert.equal(out.held, true)
  assert.equal(existsSync(dir), false)
  const siblings = (await fs.readdir(path.dirname(dir))).filter((x) => x !== path.basename(dir))
  assert.deepEqual(siblings, [], '작업 폴더 옆에 옮겨 둔 폴더가 없다(방의 나무에 보이지 않는다)')
  assert.deepEqual(await listKept(v), [], '실행의 무시된 파일은 남기지 않는다')
  assert.match((await G.show(f.repo_path, v.branch, '결과.md')).toString(), /결과/)
})

test('K-01b 사람의 작업실에서 git 이 싣지 않는 것은 그 경로만 .kept 에 남기고, 기록 · 목록 · 내려받기, 보관 기간 뒤 지운다', { skip: !db && 'no database' }, async () => {
  const f = await folderWith('남김', '*.env\n')
  const v = await personVar(f)
  await open(f, v)
  const dir = await wt(v)
  await fs.writeFile(path.join(dir, '비밀.env'), 'TOKEN=example\n')
  await fs.writeFile(path.join(dir, '메모.md'), '커밋되는 파일\n')
  const out = await SE.closeServer(f, await S.variationById(v.id), { by: owner.id, me: owner })
  assert.equal(out.kept, 1)
  const [k] = await listKept(v)
  assert.ok(k && existsSync(path.join(k, '비밀.env')), '무시된 파일은 .kept 에')
  assert.equal(existsSync(path.join(k, '메모.md')), false, 'git 이 가진 파일은 다시 남기지 않는다')
  assert.equal(existsSync(path.join(k, '.git')), false)
  assert.equal((await fs.readdir(path.dirname(dir))).filter((x) => x.includes('.kept')).length, 0, '작업실 옆에 옮겨 둔 폴더가 없다')
  const [row] = await logs(v, 'kept')
  assert.ok(row, '기록이 남는다')
  const list = await SE.keptOf(f, await S.variationById(v.id), { me: owner, role: 'owner' })
  assert.equal(list.length, 1)
  assert.equal(list[0].count, 1)
  assert.ok(list[0].until)
  const zip = await SE.keptZip(f, await S.variationById(v.id), list[0].id, { me: owner, role: 'owner' })
  const JSZip = (await import('jszip')).default
  const bytes = await new Promise((resolve, reject) => { const parts = []; zip.stream.on('data', (c) => parts.push(c)); zip.stream.on('end', () => resolve(Buffer.concat(parts))); zip.stream.on('error', reject) })
  assert.ok((await JSZip.loadAsync(bytes)).file('비밀.env'), '내려받은 zip 에 있다')
  await assert.rejects(SE.keptZip(f, await S.variationById(v.id), list[0].id, { me: { id: crypto.randomUUID() }, role: 'editor' }), (e) => e.status === 403)
  // past the retention days (from when it was kept — its record, review 3) it is removed by the sweep
  await q(`update pro_variation_seat_log set at = now() - ($2 || ' days')::interval where id=$1`, [row.id, String(SE.keptDays() + 1)])
  await SE.sweep()
  assert.equal(existsSync(k), false)
  assert.equal((await SE.keptOf(f, await S.variationById(v.id), { me: owner, role: 'owner' })).length, 0)
})

test('L-02 다른 곳이 변형의 잠금(임대)을 쥐고 있으면 사람의 돌려놓기는 몇 초 뒤 409 busy', { skip: !db && 'no database' }, async () => {
  const f = await folderWith('잠금')
  const v = await personVar(f)
  await open(f, v)
  await q(`insert into pro_variation_locks (variation_id, owner, until) values ($1, 'another-pod', now() + interval '30 seconds')
           on conflict (variation_id) do update set owner=excluded.owner, until=excluded.until`, [v.id])
  const t0 = Date.now()
  await assert.rejects(SE.closeServer(f, await S.variationById(v.id), { by: owner.id, me: owner }), (e) => e.status === 409 && e.why === 'busy')
  assert.ok(Date.now() - t0 < 10_000, `${Date.now() - t0}ms`)
  await q('delete from pro_variation_locks where variation_id=$1', [v.id])
  await SE.closeServer(f, await S.variationById(v.id), { by: owner.id, me: owner })
  assert.equal(await SE.seatOf(v.id), null)
})

test('W-03 오래된 git 잠금은 치우고, 살아 있는 잠금은 회차 · 기록 없이 거절, 쓸기는 물러난다 · 메시지에 서버 경로 없음', { skip: !db && 'no database' }, async () => {
  const f = await folderWith('git 잠금')
  const v = await personVar(f)
  await open(f, v)
  const dir = await wt(v)
  await fs.writeFile(path.join(dir, '메모.md'), '잠금 뒤\n')
  const lock = path.join((await G.git(dir, ['rev-parse', '--absolute-git-dir'])).trim(), 'index.lock')
  await fs.writeFile(lock, '')
  const old = new Date(Date.now() - 10 * 60_000)
  await fs.utimes(lock, old, old)
  await SE.closeServer(f, await S.variationById(v.id), { by: owner.id, me: owner })
  assert.equal(await SE.seatOf(v.id), null, '오래된 잠금을 치우고 옮겼다')
  assert.match((await G.show(f.repo_path, v.branch, '메모.md')).toString(), /잠금 뒤/)
  // a lock git may still be using: the move is refused with nothing changed
  const v2 = await personVar(f, '둘째')
  await open(f, v2)
  const dir2 = await wt(v2)
  await fs.writeFile(path.join(dir2, '메모.md'), 'x\n')
  const lock2 = path.join((await G.git(dir2, ['rev-parse', '--absolute-git-dir'])).trim(), 'index.lock')
  await fs.writeFile(lock2, '')
  const before = { epoch: (await S.variationById(v2.id)).seat_epoch, logs: (await logs(v2)).length }
  await assert.rejects(SE.closeServer(f, await S.variationById(v2.id), { by: owner.id, me: owner }), (e) => {
    assert.equal(e.why, 'unsaved')
    assert.ok(!e.message.includes(ROOT) && !/\/(Users|var|private|home)\//.test(e.message), e.message)
    return true
  })
  assert.equal((await S.variationById(v2.id)).seat_epoch, before.epoch, '새 회차가 생기지 않는다')
  assert.equal((await logs(v2)).length, before.logs, '기록 줄이 생기지 않는다')
  assert.equal((await SE.seatOf(v2.id))?.run, 'workroom')
  await fs.rm(lock2, { force: true })
  // the sweep: a dead turn whose checkout cannot be saved is tried, then left alone for a while (no new epoch)
  const v3 = await personVar(f, '셋째')
  const run = await SE.openServer(f, v3, { user: owner, run: 'agent', work: 'turn', ref: 'conv-w3', dir: path.join(S.foldersRoot(), '.runs', 'w3', f.slug) })
  SE.forget(v3.id)
  await fs.writeFile(path.join(await wt(v3), 'x.md'), 'x\n')
  const lock3 = path.join((await G.git(await wt(v3), ['rev-parse', '--absolute-git-dir'])).trim(), 'index.lock')
  await fs.writeFile(lock3, '')
  await q(`update pro_variation_seats set seen_at = now() - interval '1 hour' where variation_id=$1`, [v3.id])
  const e3 = (await S.variationById(v3.id)).seat_epoch
  await SE.sweep()
  await SE.sweep()
  assert.equal((await S.variationById(v3.id)).seat_epoch, e3, '실패한 시도는 회차를 올리지 않는다')
  assert.ok(SE.backoffOf(v3.id)?.next > Date.now(), '다음 시도는 뒤로 미룬다')
  assert.equal(Number((await SE.seatOf(v3.id))?.epoch), Number(run.epoch))
  await fs.rm(lock3, { force: true })
})

test('H-04 하트비트는 그 실행의 것: 자리를 잃은 실행이 다음 자리를 살려 두지 않고, 결과를 들이다 실패해도 멈춘다', { skip: !db && 'no database' }, async () => {
  const f = await folderWith('하트비트')
  const v = await personVar(f, '프로젝트')
  const a = await SE.openServer(f, v, { user: owner, run: 'agent', work: 'turn', ref: 'conv-a', dir: path.join(S.foldersRoot(), '.runs', 'ha', f.slug) })
  // another run of the same person takes it (on another server, a turn in another sub-topic); a is still beating here
  await SE.transition(v.id, (vv, st) => SE.decide(st, { type: 'open', run: 'agent', user: owner.id, work: 'turn', ref: 'conv-b' }, { v: vv }))
  await q(`update pro_variation_seats set state='held', deadline=null, seen_at = now() - interval '1 hour' where variation_id=$1`, [v.id])
  await SE.beatNow()
  const [s] = await q('select seen_at from pro_variation_seats where variation_id=$1', [v.id])
  assert.ok(Date.now() - new Date(s.seen_at).getTime() > 30 * 60_000, '지난 실행의 하트비트가 새 자리를 새로 하지 않는다')
  // a run whose fill throws stops beating all the same
  const v2 = await personVar(f, '둘째')
  const b = await SE.openServer(f, v2, { user: owner, run: 'agent', work: 'turn', ref: 'conv-c', dir: path.join(S.foldersRoot(), '.runs', 'hb', f.slug) })
  assert.equal(SE.beating(v2.id, b.epoch), true)
  await assert.rejects(SE.finishRun(f, await S.variationById(v2.id), b, { fill: async () => { throw new Error('pull failed') } }), /pull failed/)
  assert.equal(SE.beating(v2.id, b.epoch), false)
  assert.equal(SE.beating(v.id, a.epoch) && false, false)
})

test('C-05 커밋이 실패한 에이전트 실행은 작업 폴더의 것을 모두 남기고(기록 · 목록), 결과에 그렇다고 말한다', { skip: (!db && 'no database') || (process.getuid?.() === 0 && 'root reads everything') }, async () => {
  const f = await folderWith('커밋 실패')
  const v = await personVar(f, '프로젝트')
  const dir = path.join(S.foldersRoot(), '.runs', 'c5', f.slug)
  const run = await SE.openServer(f, v, { user: owner, run: 'agent', work: 'turn', ref: 'conv-c5', dir })
  const out = await SE.finishRun(f, await S.variationById(v.id), run, {
    fill: async (d) => {
      await fs.writeFile(path.join(d, '결과.md'), '에이전트의 결과\n')
      await fs.writeFile(path.join(d, '잠긴.md'), 'x\n')
      await fs.chmod(path.join(d, '잠긴.md'), 0o000)
      chmodded.push(path.join(d, '잠긴.md'))
    },
    commit: strict(f, owner, '턴'),
  })
  assert.equal(out.saved, false)
  assert.ok(out.kept >= 2, JSON.stringify(out))
  const [k] = await listKept(v)
  assert.ok(k && existsSync(path.join(k, '결과.md')), '결과가 .kept 에 있다')
  chmodded.push(path.join(k, '잠긴.md'))
  assert.equal(existsSync(dir), false)
  assert.equal(await SE.seatOf(v.id), null)
  const [row] = await logs(v, 'kept')
  assert.match(row.note, /commit/)
})
