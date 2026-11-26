// Variation seats — the re-review of b3e117b · 83ce821 (PR #86, 2026-11-26): each case here failed before its fix.
//   X-01 a stopped retire's copy kept across filesystems (the agents' workspace mounted apart from the folders — EXDEV) is copied once,
//        checked, and its original removed: the next sweeps find nothing to copy again
//   X-02 a retire that keeps a whole folder across filesystems leaves neither the copy nor its note behind
//   X-03 a copy that cannot be kept (a file it cannot read) leaves nothing half-copied, is tried again later and later, and is recorded once
//   X-04 a lock of an earlier run of this server that got this very pid (another token) is stopped, not alive
//   X-05 a retire says it goes on while it runs (its lock and note are touched) · a copy with no note goes by when it was moved there, not
//        by its files' old times · a note whose copy is gone is removed once it is old
// The other filesystem is played by fs.promises.rename answering EXDEV for a move from .retiring into .kept.
// Run: node --test test/variationSeats.review7.test.js  (the local database with sql/063; folders in a temporary directory, tenant
// "seats-review7", removed afterwards)
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

const ROOT = await fsp.mkdtemp(path.join(os.tmpdir(), 'pgl-seats-review7-'))
const TENANT = 'seats-review7'
process.env.PRO_TENANT_ID = TENANT
process.env.PRO_FOLDERS_ROOT = path.join(ROOT, 'folders')
process.env.PRO_LLM_BASE_URL = 'http://127.0.0.1:9/v1'
process.env.PRO_RETIRE_TOUCH_MS = '50'
const SE = await import('../lib/folders/seats.js')
const { q, pool } = await import('../lib/supa.js')
const db = await q('select 1 from pro_variation_locks limit 1').then(() => true).catch(() => false)
const S = await import('../lib/folders/service.js')
const G = await import('../lib/folders/git.js')
const { ensureTenantRow } = await import('../lib/tenant.js')
const owner = { id: crypto.randomUUID(), name: '한소유', email: 'review7-owner@example.test' }
if (db) {
  await ensureTenantRow(TENANT).catch(() => {})
  await q('insert into users (id, email, username, tenant_id) values ($1,$2,$3,$4) on conflict do nothing', [owner.id, owner.email, owner.name, TENANT]).catch(() => {})
}
const vids = []
const realRename = fsp.rename
let exdev = false, slow = null
fsp.rename = async (a, b) => {
  const across = String(a).includes(`${path.sep}.retiring${path.sep}`) && String(b).includes(`${path.sep}.kept${path.sep}`)
  if (across && slow) await slow(String(a))
  if (across && exdev) throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' })
  return realRename(a, b)
}
const chmodded = []
after(async () => {
  fsp.rename = realRename
  for (const f of chmodded) await fsp.chmod(f, 0o644).catch(() => {})
  if (db) {
    if (vids.length) await q('delete from pro_variation_locks where variation_id = any($1::uuid[])', [vids]).catch(() => {})
    await q('delete from pro_variation_seat_log where tenant_id=$1', [TENANT]).catch(() => {})
    await q('delete from pro_folders where tenant_id=$1', [TENANT]).catch(() => {})
    await q("delete from users where tenant_id=$1 and email like '%@example.test'", [TENANT]).catch(() => {})
  }
  await pool.end()
  await fsp.rm(ROOT, { recursive: true, force: true })
})
let folder = null
async function theFolder() {
  if (folder) return folder
  const f = await S.createFolder(owner, { name: `파일시스템 ${crypto.randomBytes(3).toString('hex')}` })
  await S.upload(f, owner, '안내문.md', Buffer.from('# 안내\n'))
  await S.upload(f, owner, '.gitignore', Buffer.from('*.env\n'))
  return (folder = await S.folderById(f.id))
}
const personVar = async (f, title) => {
  const v = await S.createVariation(f, { title: `${title} ${crypto.randomBytes(3).toString('hex')}`, kind: 'person', holder: { type: 'user', id: owner.id, name: owner.name }, createdBy: owner.id })
  vids.push(String(v.id))
  return v
}
const retiring = () => path.join(S.foldersRoot(), '.retiring')
const keptUnder = async (v) => (await fsp.readdir(path.join(S.keptRootOf(), String(v.id))).catch(() => [])).length
const keptAll = async () => { let n = 0; for (const x of await fsp.readdir(S.keptRootOf()).catch(() => [])) n += (await fsp.readdir(path.join(S.keptRootOf(), x)).catch(() => [])).length; return n }
const rows = async (v, action) => (await q('select count(*)::int n from pro_variation_seat_log where variation_id=$1 and action=$2', [v.id, action]))[0].n
const ago = (ms) => new Date(Date.now() - ms)
// what a stopped server's retire left: a copy under .retiring and its note, an hour old
async function stoppedCopy(v, files) {
  const copy = path.join(retiring(), `${String(v.id).slice(0, 8)}-${crypto.randomBytes(3).toString('hex')}`)
  await fsp.mkdir(copy, { recursive: true })
  for (const [name, body] of Object.entries(files)) await fsp.writeFile(path.join(copy, name), body)
  await fsp.writeFile(`${copy}.json`, JSON.stringify({ vid: v.id, host: 'stopped-pod-x', pid: 42, boot: 'feedfacefeed', ns: '1' }))
  await fsp.utimes(`${copy}.json`, ago(3600_000), ago(3600_000))
  return copy
}

test('X-01 다른 파일시스템으로 남기는 멈춘 사본은 한 번 복사 · 확인하고 원본을 지운다 — 다음 쓸기는 다시 복사하지 않는다', { skip: !db && 'no database' }, async () => {
  const f = await theFolder()
  const v = await personVar(f, '건너편')
  const copy = await stoppedCopy(v, { 'big.bin': crypto.randomBytes(256 * 1024), '메모.txt': '남길 것\n' })
  exdev = true
  try { for (let i = 0; i < 4; i++) await S.keepStoppedStagings() } finally { exdev = false }
  assert.equal(existsSync(copy), false, '원본 사본은 지웠다')
  assert.equal(existsSync(`${copy}.json`), false)
  assert.equal(await keptUnder(v), 1, '한 번만 남겼다')
  assert.equal(existsSync(path.join(S.keptRootOf(), 'none')), false, '기록 없는 사본을 따로 만들지 않았다')
  assert.equal(await rows(v, 'kept'), 1)
  const [k] = await SE.keptOf(f, await S.variationById(v.id), { me: owner, role: 'owner' })
  assert.equal(k.bytes, 256 * 1024 + Buffer.byteLength('남길 것\n'))
})

test('X-02 다른 파일시스템으로 폴더 통째를 남기는 치우기는 사본도 메모도 남기지 않는다', { skip: !db && 'no database' }, async () => {
  const f = await theFolder()
  const v = await personVar(f, '통째 건너편')
  await SE.openServer(f, v, { user: owner, run: 'workroom', dir: S.personCheckoutDir(owner, v) })
  const dir = (await S.variationById(v.id)).worktree_path
  await fsp.writeFile(path.join(dir, '메모.md'), '메모\n')
  await fsp.writeFile(path.join((await G.git(dir, ['rev-parse', '--absolute-git-dir'])).trim(), 'index'), 'not an index') // git can no longer tell
  exdev = true
  let gone
  try {
    gone = await S.release(f, await S.variationById(v.id), { who: owner.id })
    for (let i = 0; i < 2; i++) await S.keepStoppedStagings()
  } finally { exdev = false }
  assert.equal(gone.kept, -1)
  assert.equal(gone.staging, null)
  assert.deepEqual((await fsp.readdir(retiring()).catch(() => [])).filter((x) => x.startsWith(path.basename(dir))), [], '.retiring 에 아무것도 없다')
  assert.equal(await keptUnder(v), 1)
  assert.equal(await rows(v, 'kept'), 1)
})

test('X-03 남기지 못하는 사본은 반쯤 복사한 것을 남기지 않고, 점점 늦게 다시 해 보며, 한 번 기록한다', { skip: !db && 'no database' }, async () => {
  const f = await theFolder()
  const v = await personVar(f, '못 읽음')
  const copy = await stoppedCopy(v, { 'a.txt': 'x'.repeat(100_000), 'b.txt': 'y'.repeat(100_000) })
  await fsp.writeFile(path.join(copy, 'z-못읽음.bin'), 'secret')
  await fsp.chmod(path.join(copy, 'z-못읽음.bin'), 0)
  chmodded.push(path.join(copy, 'z-못읽음.bin'))
  const before = await keptAll()
  exdev = true
  try { for (let i = 0; i < 3; i++) await S.keepStoppedStagings() } finally { exdev = false }
  assert.equal(await keptAll(), before, '반쯤 복사한 것이 남지 않았다')
  assert.ok(existsSync(path.join(copy, 'a.txt')), '원본은 그대로')
  const fail = JSON.parse(await fsp.readFile(`${copy}.fail`, 'utf8'))
  assert.equal(fail.tries, 1, '세 번 쓸어도 한 번만 해 봤다(다음은 나중에)')
  assert.ok(Date.parse(fail.next) > Date.now())
  assert.equal(await rows(v, 'keep-failed'), 1, '변형에 한 번 기록했다')
  await fsp.chmod(path.join(copy, 'z-못읽음.bin'), 0o644)
  await fsp.rm(copy, { recursive: true }); await fsp.rm(`${copy}.json`, { force: true }); await fsp.rm(`${copy}.fail`, { force: true })
})

test('X-04 같은 호스트 · 같은 이름공간 · 이 프로세스와 같은 pid 지만 다른 토큰의 잠금은 멈춘 것', { skip: !db && 'no database' }, async () => {
  const f = await theFolder()
  const v = await personVar(f, '같은 pid')
  await SE.openServer(f, v, { user: owner, run: 'workroom', dir: S.personCheckoutDir(owner, v) })
  const dir = (await S.variationById(v.id)).worktree_path
  const admin = (await G.git(dir, ['rev-parse', '--absolute-git-dir'])).trim()
  await fsp.writeFile(path.join(admin, 'locked'), `pgl-retire ${os.hostname()}:${process.pid} 2020-01-01T00:00:00.000Z boot=deadbeef0000 ns=${S.retireNs()}`)
  await fsp.utimes(path.join(admin, 'locked'), ago(5 * 60_000), ago(5 * 60_000))
  await fsp.rename(dir, `${dir}-gone`)
  assert.deepEqual(await S.freeStoppedRetires(f.repo_path, { branch: v.branch }), { freed: 1, waiting: false })
})

test('X-05a 치우기는 도는 동안 잠금과 메모의 시각을 새로 한다', { skip: !db && 'no database' }, async () => {
  const f = await theFolder()
  const v = await personVar(f, '오래 걸림')
  await SE.openServer(f, v, { user: owner, run: 'workroom', dir: S.personCheckoutDir(owner, v) })
  const dir = (await S.variationById(v.id)).worktree_path
  const lock = path.join((await G.git(dir, ['rev-parse', '--absolute-git-dir'])).trim(), 'locked')
  await fsp.writeFile(path.join(dir, '비밀.env'), 'A=1\n')
  const seen = []
  // the move into .kept takes a while (a big folder copied to another filesystem)
  slow = async (from) => {
    const note = `${path.dirname(from)}.json`
    const a = [(await fsp.stat(note)).mtimeMs, (await fsp.stat(lock)).mtimeMs]
    await new Promise((r) => setTimeout(r, 400))
    const b = [(await fsp.stat(note)).mtimeMs, (await fsp.stat(lock)).mtimeMs]
    seen.push([b[0] - a[0], b[1] - a[1]])
  }
  try { await S.release(f, await S.variationById(v.id), { who: owner.id }) } finally { slow = null }
  assert.ok(seen.length >= 1)
  assert.ok(seen[0][0] >= 100, `메모의 시각이 새로워졌다 (+${Math.round(seen[0][0])} ms)`)
  assert.ok(seen[0][1] >= 100, `잠금의 시각이 새로워졌다 (+${Math.round(seen[0][1])} ms)`)
})

test('X-05b 메모 없는 사본은 옮겨진 때(ctime)로 · 사본 없는 메모는 오래되면 지운다', { skip: !db && 'no database' }, async () => {
  // an older version's copy with no note, its files' times old — but it was moved there just now
  const copy = path.join(retiring(), `old-version-${crypto.randomBytes(3).toString('hex')}`)
  await fsp.mkdir(copy, { recursive: true })
  await fsp.writeFile(path.join(copy, 'x.txt'), 'x')
  await fsp.utimes(copy, ago(3600_000), ago(3600_000))
  await S.keepStoppedStagings()
  assert.ok(existsSync(copy), '방금 옮겨진 사본은 아직 그대로')
  await fsp.rm(copy, { recursive: true })
  // a note whose copy never came (a crash between the note and the move)
  const orphan = path.join(retiring(), `orphan-${crypto.randomBytes(3).toString('hex')}.json`)
  await fsp.writeFile(orphan, JSON.stringify({ host: 'stopped-pod-x', pid: 1 }))
  const fresh = path.join(retiring(), `fresh-${crypto.randomBytes(3).toString('hex')}.json`)
  await fsp.writeFile(fresh, JSON.stringify({ host: 'live-pod', pid: 1 }))
  await fsp.utimes(orphan, ago(3600_000), ago(3600_000))
  await S.keepStoppedStagings()
  assert.equal(existsSync(orphan), false, '오래된 외톨이 메모는 지웠다')
  assert.ok(existsSync(fresh), '방금 쓴 메모는 둔다(사본이 곧 올 수 있다)')
  await fsp.rm(fresh, { force: true })
})
