// Variation seats — the third review of PR #86 (2026-11-26): each case here failed before its fix.
//   Z-01 a kept folder is downloaded only within the limits, its size counted again at that moment (a whole folder kept used to record none):
//        too big → 413 'too-big' in words a person reads (which file, which limit); within them the zip streams out
//   R-02 a checkout that leaves the disk while another variation prunes the repository's worktrees keeps only what git does not carry (not
//        the whole folder); a kept folder lasts its retention days from when it was kept (its record), not from its files' old times
//   E-03 a disk lease that was lost (another server took the variation once this one's time ran out) stops the work before it removes,
//        checks out or commits anything
//   S-04 a stale git lock is removed only when lsof plainly says nobody has it open (lsof missing, refused, any other answer: left alone);
//        a workroom save does not look at locks unless git refuses its commit
//   O-05 a run's result that could not be committed after its seat moved is kept and recorded on the variation (listed, downloadable)
// Run: node --test test/variationSeats.review3.test.js  (the local database with sql/063; folders in a temporary directory, tenant
// "seats-review3", removed afterwards)
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'

const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'pgl-seats-review3-'))
const TENANT = 'seats-review3'
process.env.PRO_TENANT_ID = TENANT
process.env.PRO_FOLDERS_ROOT = path.join(ROOT, 'folders')
process.env.PRO_LLM_BASE_URL = 'http://127.0.0.1:9/v1'
const SE = await import('../lib/folders/seats.js')
const { q, pool } = await import('../lib/supa.js')
const db = await q('select 1 from pro_variation_locks limit 1').then(() => true).catch(() => false)
const S = await import('../lib/folders/service.js')
const G = await import('../lib/folders/git.js')
const { ensureTenantRow } = await import('../lib/tenant.js')
const owner = { id: crypto.randomUUID(), name: '한소유', email: 'review3-owner@example.test' }
if (db) {
  await ensureTenantRow(TENANT).catch(() => {})
  await q('insert into users (id, email, username, tenant_id) values ($1,$2,$3,$4) on conflict do nothing', [owner.id, owner.email, owner.name, TENANT]).catch(() => {})
}
const vids = []
after(async () => {
  if (db) {
    if (vids.length) await q('delete from pro_variation_locks where variation_id = any($1::uuid[])', [vids]).catch(() => {})
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
const personVar = async (f, title = '내 작업') => {
  const v = await S.createVariation(f, { title, kind: 'person', holder: { type: 'user', id: owner.id, name: owner.name }, createdBy: owner.id })
  vids.push(String(v.id))
  return v
}
const open = (f, v) => SE.openServer(f, v, { user: owner, run: 'workroom', dir: S.personCheckoutDir(owner, v) })
const wt = async (v) => (await S.variationById(v.id)).worktree_path
const asOwner = { me: owner, role: 'owner' }
const streamed = (s) => new Promise((resolve, reject) => { const parts = []; s.on('data', (c) => parts.push(c)); s.on('end', () => resolve(Buffer.concat(parts))); s.on('error', reject) })
const withEnv = async (vars, fn) => {
  const was = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]))
  Object.assign(process.env, vars)
  try { return await fn() } finally { for (const [k, x] of Object.entries(was)) { if (x === undefined) delete process.env[k]; else process.env[k] = x } }
}
// a workroom put away with two .gitignore'd files of 700 KB each kept on the server
async function keptBig(label) {
  const f = await folderWith(label, '*.bin\n')
  const v = await personVar(f)
  await open(f, v)
  const dir = await wt(v)
  await fs.writeFile(path.join(dir, '큰 파일.bin'), crypto.randomBytes(700 * 1024))
  await fs.writeFile(path.join(dir, '작은 파일.bin'), crypto.randomBytes(300 * 1024))
  await SE.closeServer(f, await S.variationById(v.id), { by: owner.id, me: owner })
  const [k] = await SE.keptOf(f, await S.variationById(v.id), asOwner)
  assert.ok(k, '남긴 파일이 목록에 있다')
  return { f, v: await S.variationById(v.id), k }
}

test('Z-01a 남긴 폴더가 내려받기 한도를 넘으면 413 too-big — 크기는 내려받을 때 다시 센다(기록이 0 이어도)', { skip: !db && 'no database' }, async () => {
  const { f, v, k } = await keptBig('큰 남김')
  // (a whole folder kept before this fix recorded no size: the record is not what is trusted)
  await q(`update pro_variation_seat_log set note = jsonb_set(note::jsonb, '{bytes}', '0')::text where id=$1`, [k.id])
  await withEnv({ PRO_KEPT_ZIP_MAX_MB: '0.8' }, async () => {
    for (const check of [true, false]) {
      await assert.rejects(SE.keptZip(f, v, k.id, { ...asOwner, check }), (e) => {
        assert.equal(e.status, 413)
        assert.equal(e.why, 'too-big')
        assert.match(e.message, /0\.8 ?MB/, '한도를 말한다')
        assert.match(e.message, /1(\.0)? ?MB/, '모두 얼마인지 말한다')
        return true
      })
    }
  })
})

test('Z-01b 파일 하나가 한도를 넘으면 413 — 그 파일 이름과 한도를 말한다', { skip: !db && 'no database' }, async () => {
  const { f, v, k } = await keptBig('큰 파일 하나')
  await withEnv({ PRO_KEPT_FILE_MAX_MB: '0.5' }, async () => {
    await assert.rejects(SE.keptZip(f, v, k.id, asOwner), (e) => e.status === 413 && e.why === 'too-big' && e.message.includes('큰 파일.bin') && /0\.5 ?MB/.test(e.message))
  })
})

test('Z-01c 한도 안이면 zip 이 흘러나간다(메모리에 통째로 만들지 않는다) · 미리 묻기는 크기와 개수만', { skip: !db && 'no database' }, async () => {
  const { f, v, k } = await keptBig('보통 남김')
  const pre = await SE.keptZip(f, v, k.id, { ...asOwner, check: true })
  assert.equal(pre.count, 2)
  assert.ok(pre.bytes >= 1000 * 1024, `다시 센 크기 ${pre.bytes}`)
  assert.equal(pre.stream, undefined, '미리 묻기는 zip 을 만들지 않는다')
  const z = await SE.keptZip(f, v, k.id, asOwner)
  assert.ok(z.stream && typeof z.stream.pipe === 'function', 'zip 은 스트림으로')
  assert.match(z.name, /-kept\.zip$/)
  const JSZip = (await import('jszip')).default
  const got = await JSZip.loadAsync(await streamed(z.stream))
  assert.equal((await got.file('큰 파일.bin').async('nodebuffer')).length, 700 * 1024)
  assert.ok(got.file('작은 파일.bin'))
})

test('R-02a 작업본을 치우는 사이에 다른 변형이 worktree prune 을 해도 git 이 싣지 않는 것만 남긴다(폴더 통째가 아니다)', { skip: !db && 'no database' }, async () => {
  const f = await folderWith('정리 경합', '*.env\n')
  // checkouts of the same repository, each with a .gitignore'd file
  const dirs = []
  for (let i = 0; i < 12; i++) {
    const branch = `review3/race-${i}-${crypto.randomBytes(2).toString('hex')}`
    await G.git(f.repo_path, ['branch', branch, 'main'])
    const d = path.join(S.foldersRoot(), '.people', 'race', `${i}-${crypto.randomBytes(2).toString('hex')}`)
    await fs.mkdir(path.dirname(d), { recursive: true })
    await G.git(f.repo_path, ['worktree', 'add', '-q', d, branch])
    await fs.writeFile(path.join(d, '비밀.env'), `TOKEN=${i}\n`)
    dirs.push(d)
  }
  // another variation's checkout prunes the repository's worktrees again and again meanwhile
  const pruner = spawn('sh', ['-c', 'while :; do git -C "$1" worktree prune; done', 'sh', f.repo_path], { stdio: 'ignore' })
  const outs = []
  try {
    for (const d of dirs) outs.push(await S.retire(f.repo_path, d, { mode: 'person', vid: crypto.randomUUID() }))
  } finally { pruner.kill('SIGKILL') }
  for (const out of outs) {
    assert.notEqual(out.kept, -1, '폴더 통째로 남기지 않는다(git 이 무엇을 싣는지 알았다)')
    assert.equal(out.kept, 1)
    assert.deepEqual(await fs.readdir(out.keptDir), ['비밀.env'])
  }
  for (const d of dirs) assert.equal(existsSync(d), false)
})

test('R-02b 통째로 남긴 폴더도 크기를 기록하고, 남긴 때(기록)부터 보관 기간을 센다 — 파일들의 옛 시각으로 곧 지우지 않는다', { skip: !db && 'no database' }, async () => {
  const f = await folderWith('통째')
  const v = await personVar(f)
  await open(f, v)
  const dir = await wt(v)
  await fs.writeFile(path.join(dir, '메모.md'), '메모\n'.repeat(2000))
  // git can no longer tell what it carries here (its index broken): the whole folder is kept
  const gitDir = (await G.git(dir, ['rev-parse', '--absolute-git-dir'])).trim()
  await fs.writeFile(path.join(gitDir, 'index'), 'not an index')
  // a working copy opened weeks ago: its folder's time is old
  const old = new Date(Date.now() - (SE.keptDays() + 5) * 86400_000)
  await fs.utimes(dir, old, old)
  const gone = await S.release(f, await S.variationById(v.id), { who: owner.id })
  assert.equal(gone.kept, -1)
  assert.ok(gone.bytes >= 2000 * 3, `통째로 남긴 크기도 센다 (${gone.bytes})`)
  const [k] = await SE.keptOf(f, await S.variationById(v.id), asOwner)
  assert.ok(k && k.bytes > 0, '목록에 크기가 있다')
  // whatever the filesystem says of its time, it lasts from when it was kept
  await fs.utimes(gone.keptDir, old, old)
  await SE.sweep()
  assert.ok(existsSync(gone.keptDir), '보관 기간 안이면 남아 있다')
  // its record past the days: removed
  await q(`update pro_variation_seat_log set at = now() - ($2 || ' days')::interval where id=$1`, [k.id, String(SE.keptDays() + 1)])
  await SE.sweep()
  assert.equal(existsSync(gone.keptDir), false)
})

test('E-03 잃은 임대(다른 서버가 이어받음)로는 치우기 · 체크아웃 · 커밋을 하지 않는다', { skip: !db && 'no database' }, async () => {
  const f = await folderWith('임대')
  const v = await personVar(f)
  await open(f, v)
  const dir = await wt(v)
  await fs.writeFile(path.join(dir, '메모.md'), '아직 저장 안 함\n')
  const head = await G.head(f.repo_path, `refs/heads/${v.branch}`)
  // inside a piece of work on disk, this server's lease runs out and another server takes it (its renewals did not reach the database)
  const stolen = () => q(`update pro_variation_locks set owner='다른 서버', until=now() + interval '1 minute' where variation_id=$1`, [v.id])
  const under = (fn) => SE.onDisk(String(v.id), async () => { await stolen(); return fn().then(() => null, (e) => e) }, { wait: 5000 })
  try {
    const e1 = await under(async () => S.release(f, await S.variationById(v.id)))
    assert.equal(e1?.status, 409, '치우지 않는다')
    assert.equal(e1.why, 'busy')
    assert.ok(existsSync(path.join(dir, '메모.md')), '작업본은 그대로')
    await q('delete from pro_variation_locks where variation_id=$1', [v.id])
    const e2 = await under(async () => SE.commitAsIs(f, await S.variationById(v.id)))
    assert.equal(e2?.status, 409, '커밋하지 않는다')
    assert.equal(await G.head(f.repo_path, `refs/heads/${v.branch}`), head)
    await q('delete from pro_variation_locks where variation_id=$1', [v.id])
    const other = path.join(S.foldersRoot(), '.people', 'lease', String(v.id))
    const e3 = await under(async () => S.checkout(f, await S.variationById(v.id), other))
    assert.equal(e3?.status, 409, '체크아웃하지 않는다')
    assert.equal(existsSync(other), false)
    assert.ok(existsSync(dir))
  } finally { await q('delete from pro_variation_locks where variation_id=$1', [v.id]) }
  // with its lease, the same work goes on
  const ok = await SE.onDisk(String(v.id), async () => SE.commitAsIs(f, await S.variationById(v.id)))
  assert.ok(ok, '임대가 있으면 커밋한다')
})

test('S-04a 오래된 git 잠금은 lsof 가 「아무도 안 연다」(종료 1, 출력 없음)고 할 때만 지운다 — 없거나 거절하면 둔다', { skip: !db && 'no database' }, async () => {
  const f = await folderWith('잠금 확인')
  const v = await personVar(f)
  await open(f, v)
  const dir = await wt(v)
  const lock = path.join((await G.git(dir, ['rev-parse', '--absolute-git-dir'])).trim(), 'index.lock')
  const bin = await fs.mkdtemp(path.join(ROOT, 'bin-'))
  const stale = async () => { await fs.writeFile(lock, ''); const t = new Date(Date.now() - 10 * 60_000); await fs.utimes(lock, t, t) }
  const lsof = async (body) => { await fs.writeFile(path.join(bin, 'lsof'), `#!/bin/sh\n${body}\n`); await fs.chmod(path.join(bin, 'lsof'), 0o755) }
  const PATH = process.env.PATH
  const clear = (onlyBin) => withEnv({ PATH: onlyBin ? bin : `${bin}:${PATH}` }, () => S.clearStaleLocks(dir, v.branch))
  await stale()
  assert.equal(await clear(true), 0, 'lsof 가 없으면 지우지 않는다')
  assert.ok(existsSync(lock))
  await lsof('echo "lsof: permission denied" >&2; exit 2')
  assert.equal(await clear(false), 0, 'lsof 가 거절하면 지우지 않는다')
  assert.ok(existsSync(lock))
  await lsof('echo 4242; exit 0')
  assert.equal(await clear(false), 0, '누가 열고 있으면 지우지 않는다')
  assert.ok(existsSync(lock))
  await lsof('exit 1')
  assert.equal(await clear(false), 1, '아무도 안 열면 지운다')
  assert.equal(existsSync(lock), false)
})

test('S-04b 작업실 저장은 git 이 거절할 때만 잠금을 본다 — 거절하면 오래된 잠금을 치우고 다시 저장한다', { skip: !db && 'no database' }, async () => {
  const f = await folderWith('저장 잠금')
  const v = await personVar(f)
  await open(f, v)
  const dir = await wt(v)
  const gitDir = (await G.git(dir, ['rev-parse', '--absolute-git-dir'])).trim()
  const old = new Date(Date.now() - 10 * 60_000)
  // a stale HEAD.lock a save with nothing to commit never needs: left alone (no lsof, no removal on every save)
  const headLock = path.join(gitDir, 'HEAD.lock')
  await fs.writeFile(headLock, '')
  await fs.utimes(headLock, old, old)
  assert.equal(await S.commitVariation(f, await S.variationById(v.id), owner, '빈 저장'), null)
  assert.ok(existsSync(headLock), '저장할 것이 없으면 잠금을 건드리지 않는다')
  await fs.rm(headLock)
  // a stale index.lock git refuses the commit for: cleared, then the save goes through
  const indexLock = path.join(gitDir, 'index.lock')
  await fs.writeFile(path.join(dir, '메모.md'), '저장할 것\n')
  await fs.writeFile(indexLock, '')
  await fs.utimes(indexLock, old, old)
  const sha = await S.commitVariation(f, await S.variationById(v.id), owner, '저장')
  assert.ok(sha, '다시 해서 저장한다')
  assert.equal(existsSync(indexLock), false)
  assert.match((await G.show(f.repo_path, v.branch, '메모.md')).toString(), /저장할 것/)
})

test('O-05 자리를 잃은 실행의 결과를 커밋하지 못하면 그 변형의 「따로 남긴 파일」로 기록한다', { skip: !db && 'no database' }, async () => {
  const f = await folderWith('남은 결과')
  const v = await personVar(f)
  // a run whose seat is gone (someone else took the variation meanwhile)
  const run = { epoch: -1, work: 'turn', ref: 'conv-gone', base: v.base_commit }
  const out = await SE.finishRun(f, await S.variationById(v.id), run, {
    user: owner.id, where: '턴',
    // its result holds a repository with no commit inside: git refuses to add it
    fill: async (d) => {
      await fs.writeFile(path.join(d, '결과.md'), '결과\n')
      await fs.mkdir(path.join(d, '안쪽'))
      await G.git(path.join(d, '안쪽'), ['init', '-q'])
      await fs.writeFile(path.join(d, '안쪽', '노트.txt'), '안쪽\n')
    },
  })
  assert.equal(out.held, false)
  assert.equal(out.saved, false)
  const list = await SE.keptOf(f, await S.variationById(v.id), asOwner)
  assert.equal(list.length, 1, '그 변형의 「따로 남긴 파일」에 있다')
  assert.equal(list[0].why, 'unsaved')
  assert.equal(list[0].canGet, true)
  assert.equal(existsSync(path.join(S.foldersRoot(), '.kept', 'none')), false, '어느 변형에도 묶이지 않은 곳에 두지 않는다')
  const z = await SE.keptZip(f, await S.variationById(v.id), list[0].id, asOwner)
  const JSZip = (await import('jszip')).default
  const got = await JSZip.loadAsync(z.stream ? await streamed(z.stream) : z.buffer)
  assert.ok(got.file('결과.md'), '결과가 zip 에 있다')
  assert.equal(existsSync(path.join(S.foldersRoot(), '.leftover')) ? (await fs.readdir(path.join(S.foldersRoot(), '.leftover'))).length : 0, 0)
})
