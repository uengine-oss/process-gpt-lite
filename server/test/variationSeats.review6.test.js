// Variation seats — the re-review of d45235a (PR #86, 2026-11-26): each case here failed before its fix (V-03b is a guard — see there).
//   V-01 whether a retire stopped is told right both ways: this process's retire going on is never taken for stopped (a root reached
//        through a link spells its paths two ways); a lock of another process with this host name — another pid namespace, even the same pid —
//        is not taken for this process's, nor for stopped because its pid is not in ours; a pid that lives on (reused) stops counting past
//        a ceiling; a lock's age is its file's own time, not the clock of the server that wrote it
//   V-02 a server agent run's ignored caches inside a new folder are dropped too (`?? tools/` with `!! tools/node_modules/`)
//   V-03 a kept zip: a file stream given up while it opens its file closes it; two zips asked at once never pass the limit together; a
//        file still growing goes in as it was counted; too many files → 413
//   V-04 the lease connections send no startup parameter a pooler would refuse; no connection for the lease in time → 409 busy, not a 500
//   V-05 a server failure's message says none of the server's places — not after a colon, not with spaces in them
// Run: node --test test/variationSeats.review6.test.js  (the local database with sql/063; folders under a link to a temporary directory,
// in a folder with a space; tenant "seats-review6", removed afterwards)
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'

const REAL = await fs.mkdtemp(path.join(os.tmpdir(), 'pgl-seats-review6-'))
const ROOT = `${REAL}-link`
await fs.symlink(REAL, ROOT)
const TENANT = 'seats-review6'
process.env.PRO_TENANT_ID = TENANT
process.env.PRO_FOLDERS_ROOT = path.join(ROOT, 'App Support', 'folders')
process.env.PRO_LLM_BASE_URL = 'http://127.0.0.1:9/v1'
const SE = await import('../lib/folders/seats.js')
const { q, pool, quickPool } = await import('../lib/supa.js')
const db = await q('select 1 from pro_variation_locks limit 1').then(() => true).catch(() => false)
const S = await import('../lib/folders/service.js')
const G = await import('../lib/folders/git.js')
const { ensureTenantRow } = await import('../lib/tenant.js')
const owner = { id: crypto.randomUUID(), name: '한소유', email: 'review6-owner@example.test' }
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
  await fs.rm(ROOT, { force: true })
  await fs.rm(REAL, { recursive: true, force: true })
})
async function folderWith(label, gitignore = '') {
  const f = await S.createFolder(owner, { name: `${label} ${crypto.randomBytes(3).toString('hex')}` })
  await S.upload(f, owner, '안내문.md', Buffer.from('# 안내\n'))
  if (gitignore) await S.upload(f, owner, '.gitignore', Buffer.from(gitignore))
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
const adminOf = async (dir) => (await G.git(dir, ['rev-parse', '--absolute-git-dir'])).trim()
const old = (ms) => new Date(Date.now() - ms)
const streamed = (s) => new Promise((resolve, reject) => { const parts = []; s.on('data', (c) => parts.push(c)); s.on('end', () => resolve(Buffer.concat(parts))); s.on('error', reject) })
async function deadPid() { for (let pid = 400000; ; pid++) { try { process.kill(pid, 0) } catch (e) { if (e.code === 'ESRCH') return pid } } }
// a retire's lock left on a checkout's entry (reason, the lock file's own time), its folder gone
async function lockedGone(f, title, reason, age = 0) {
  const v = await personVar(f, `${title} ${crypto.randomBytes(3).toString('hex')}`)
  await open(f, v)
  const dir = await wt(v)
  const admin = await adminOf(dir)
  await fs.writeFile(path.join(admin, 'locked'), reason)
  if (age) await fs.utimes(path.join(admin, 'locked'), old(age), old(age))
  await fs.rename(dir, `${dir}-gone`)
  return { v, dir, admin }
}
const checkoutAgain = (f, v, dir) => SE.onDisk(String(v.id), async () => S.checkout(f, await S.variationById(v.id), dir)).then(() => 'ok', (e) => `${e.status} ${e.why}`)

test('V-01a 이 프로세스의 치우기는 링크 너머의 경로로 불려도 멈춘 것으로 보지 않는다(잠금 · 사본 모두)', { skip: !db && 'no database' }, async () => {
  const f = await folderWith('링크', '*.env\n')
  const v = await personVar(f)
  await open(f, v)
  const dir = await wt(v)
  // what git carries is plenty (the walk takes a moment), one file it does not
  for (let i = 0; i < 400; i++) { await fs.mkdir(path.join(dir, `d${i}`), { recursive: true }); await fs.writeFile(path.join(dir, `d${i}`, 'f.txt'), 'x') }
  await G.commitAll(dir, 'many', owner)
  await fs.writeFile(path.join(dir, '비밀.env'), 'S=1\n')
  let done = false, freed = 0, moved = 0
  const r = S.retire(f.repo_path, dir, { mode: 'person', vid: v.id }).finally(() => { done = true })
  while (!done) {
    freed += (await S.freeStoppedRetires(f.repo_path)).freed
    moved += await S.keepStoppedStagings()
    await new Promise((x) => setImmediate(x))
  }
  const out = await r
  assert.equal(freed, 0, '진행 중인 자기 잠금을 풀지 않았다')
  assert.equal(moved, 0, '진행 중인 자기 사본을 옮기지 않았다')
  assert.equal(out.kept, 1, 'git 이 싣지 않는 것만 남겼다(폴더 통째가 아니다)')
})

test('V-01b 같은 호스트 이름의 다른 프로세스(다른 pid 이름공간, 같은 pid) 잠금을 이 프로세스 것으로도, 멈춘 것으로도 보지 않는다', { skip: !db && 'no database' }, async () => {
  const f = await folderWith('이름공간')
  const now = new Date().toISOString()
  const a = await lockedGone(f, '죽은 pid', `pgl-retire ${os.hostname()}:${await deadPid()} ${now} boot=0badc0ffee00 ns=4026599999`)
  assert.equal(await checkoutAgain(f, a.v, a.dir), '409 busy', '다른 이름공간에서는 pid 가 없다고 멈춘 것이 아니다')
  const b = await lockedGone(f, '같은 pid', `pgl-retire ${os.hostname()}:${process.pid} ${now} boot=0badc0ffee00 ns=4026599999`)
  assert.equal(await checkoutAgain(f, b.v, b.dir), '409 busy', 'pid 가 같아도 이 프로세스의 것이 아니다')
  assert.ok(existsSync(path.join(a.admin, 'locked')) && existsSync(path.join(b.admin, 'locked')))
})

test('V-01c 살아 있는 pid(재사용)라도 상한이 지나면 멈춘 것 · 나이는 잠금 파일의 시각으로 센다(다른 서버의 시계가 아니라)', { skip: !db && 'no database' }, async () => {
  const f = await folderWith('나이')
  const a = await lockedGone(f, '재사용된 pid', `pgl-retire ${os.hostname()}:1 2020-01-01T00:00:00.000Z boot=0badc0ffee00 ns=${S.retireNs?.() ?? process.platform}`, (S.RETIRE_CEILING_MS ?? 30 * 60_000) + 60_000)
  assert.equal(await checkoutAgain(f, a.v, a.dir), 'ok', '오래된 잠금은 pid 가 살아 있어도 푼다')
  // another server whose clock is years behind: its lock was just written
  const b = await lockedGone(f, '느린 시계', 'pgl-retire slow-clock-pod:7 2020-01-01T00:00:00.000Z boot=0badc0ffee00 ns=1')
  assert.equal(await checkoutAgain(f, b.v, b.dir), '409 busy', '방금 쓴 잠금은 그 안의 옛 시각과 상관없이 아직이다')
  // the same for a staging copy's note
  const v = await personVar(f, '느린 시계 사본')
  const copy = path.join(S.foldersRoot(), '.retiring', `${v.id}-slow`)
  await fs.mkdir(copy, { recursive: true })
  await fs.writeFile(path.join(copy, 'x.txt'), 'x')
  await fs.writeFile(`${copy}.json`, JSON.stringify({ vid: v.id, host: 'slow-clock-pod', pid: 7, boot: '0badc0ffee00', ns: '1', at: '2020-01-01T00:00:00.000Z' }))
  assert.equal(await S.keepStoppedStagings(), 0)
  assert.ok(existsSync(copy), '방금 쓴 메모의 사본은 옮기지 않는다')
  await fs.rm(copy, { recursive: true }); await fs.rm(`${copy}.json`)
})

test('V-02 서버 에이전트 실행이 만든 새 폴더 안의 무시된 캐시도 버린다', { skip: !db && 'no database' }, async () => {
  const f = await folderWith('새 폴더', 'node_modules/\n__pycache__/\n')
  const branch = `review6/agent-${crypto.randomBytes(2).toString('hex')}`
  await G.git(f.repo_path, ['branch', branch, 'main'])
  const dir = path.join(S.foldersRoot(), '.runs', `t-${crypto.randomBytes(2).toString('hex')}`, f.slug)
  await fs.mkdir(path.dirname(dir), { recursive: true })
  await G.git(f.repo_path, ['worktree', 'add', '-q', dir, branch])
  await fs.mkdir(path.join(dir, 'tools', 'node_modules', 'x'), { recursive: true })
  await fs.mkdir(path.join(dir, 'tools', '__pycache__'), { recursive: true })
  await fs.writeFile(path.join(dir, 'tools', 'run.py'), 'print(1)\n')
  await fs.writeFile(path.join(dir, 'tools', 'node_modules', 'x', 'index.js'), 'x')
  await fs.writeFile(path.join(dir, 'tools', '__pycache__', 'run.pyc'), 'x')
  const out = await S.retire(f.repo_path, dir, { mode: 'agent', vid: crypto.randomUUID() })
  assert.ok(existsSync(path.join(out.keptDir, 'tools', 'run.py')), '새 파일은 남긴다')
  assert.equal(existsSync(path.join(out.keptDir, 'tools', 'node_modules')), false, 'node_modules 는 버린다')
  assert.equal(existsSync(path.join(out.keptDir, 'tools', '__pycache__')), false, '__pycache__ 는 버린다')
})

// a workroom put away with three .gitignore'd files kept on the server (3 MB each)
async function kept3(label) {
  const f = await folderWith(label, '*.bin\n')
  const v = await personVar(f)
  await open(f, v)
  const dir = await wt(v)
  for (const n of ['하나', '둘', '셋']) await fs.writeFile(path.join(dir, `${n}.bin`), crypto.randomBytes(3 * 1024 * 1024))
  await SE.closeServer(f, await S.variationById(v.id), { by: owner.id, me: owner })
  const [k] = await SE.keptOf(f, await S.variationById(v.id), asOwner)
  const root = path.join(S.foldersRoot(), '.kept', String(v.id))
  return { f, v: await S.variationById(v.id), k, keptDir: path.join(root, (await fs.readdir(root))[0]) }
}

test('V-03a 파일을 여는 사이에 그만둔 zip 도 그 파일을 닫는다', { skip: !db && 'no database' }, async () => {
  const { f, v, k, keptDir } = await kept3('일찍 그만둠')
  for (let i = 0; i < 40; i++) {
    const z = await SE.keptZip(f, v, k.id, asOwner)
    z.stream.on('error', () => {})
    z.stream.resume()
    await new Promise((x) => setImmediate(x)); await new Promise((x) => setImmediate(x))
    z.stream.destroy()
  }
  await new Promise((x) => setTimeout(x, 500))
  const open = execFileSync('lsof', ['-p', String(process.pid)]).toString().split('\n').filter((l) => l.includes(path.basename(keptDir))).length
  assert.equal(open, 0, '열린 채 남은 파일이 없다')
  assert.equal(SE.zipsGoing(), 0)
})

// (a guard: the check and the count are one step now — before, a third request could slip between them, which a test cannot time)
test('V-03b 동시에 들어온 zip 요청도 한도를 함께 넘지 않는다', { skip: !db && 'no database' }, async () => {
  const { f, v, k } = await kept3('동시 요청')
  const tries = await Promise.all([1, 2, 3].map(() => SE.keptZip(f, v, k.id, asOwner).then((z) => z, (e) => e)))
  assert.equal(tries.filter((t) => t.stream).length, 2, '두 개만')
  assert.equal(tries.filter((t) => t.status === 409).length, 1)
  for (const t of tries) t.stream?.destroy()
  await new Promise((x) => setTimeout(x, 50))
  assert.equal(SE.zipsGoing(), 0)
})

test('V-03c 아직 커지는 파일은 센 크기만큼 들어가고, 작아진 파일은 실패 · 파일이 너무 많으면 413', { skip: !db && 'no database' }, async () => {
  const { f, v, k, keptDir } = await kept3('커지는 파일')
  // something still writing a file: what was counted goes in
  const z = await SE.keptZip(f, v, k.id, asOwner)
  const before = await fs.readFile(path.join(keptDir, '하나.bin'))
  await fs.appendFile(path.join(keptDir, '하나.bin'), 'more bytes')
  const JSZip = (await import('jszip')).default
  const got = await JSZip.loadAsync(await streamed(z.stream))
  assert.ok((await got.file('하나.bin').async('nodebuffer')).equals(before), '센 크기만큼 들어갔다')
  // a file that got shorter still fails it
  const z2 = await SE.keptZip(f, v, k.id, asOwner)
  await fs.truncate(path.join(keptDir, '둘.bin'), 10)
  await assert.rejects(streamed(z2.stream))
  // too many files for one zip
  process.env.PRO_KEPT_ZIP_MAX_FILES = '2'
  try {
    await assert.rejects(SE.keptZip(f, v, k.id, asOwner), (e) => e.status === 413 && e.why === 'too-big' && /2개/.test(e.message))
  } finally { delete process.env.PRO_KEPT_ZIP_MAX_FILES }
})

test('V-04 임대 연결은 풀러가 거절할 시작 매개변수를 보내지 않고, 연결을 제때 못 얻으면 409 busy', { skip: !db && 'no database' }, async () => {
  assert.equal(quickPool.options.statement_timeout, undefined, 'statement_timeout 을 시작 매개변수로 보내지 않는다')
  assert.ok(quickPool.options.query_timeout > 0, '질의 시간 제한은 이쪽에서')
  const f = await folderWith('연결 없음')
  const v = await personVar(f)
  const held = []
  for (let i = 0; i < quickPool.options.max; i++) held.push(await quickPool.connect())
  let e
  try { e = await SE.onDisk(String(v.id), async () => 'ran', { wait: 500 }).then(() => null, (x) => x) } finally { for (const c of held) c.release() }
  assert.equal(e?.status, 409)
  assert.equal(e.why, 'busy')
})

test('V-05 서버 실패 메시지에 서버의 자리가 없다 — 콜론 뒤에도, 공백이 든 경로에도', { skip: !db && 'no database' }, async () => {
  const { hidePaths } = await import('../routes/folders.js')
  const said = hidePaths(`fatal: '${S.foldersRoot()}/.people/ab/cd' is busy · at:/srv/data/repo/x.txt · open '${os.homedir()}/Library/Application Support/pgpt/x.json'`)
  assert.doesNotMatch(said, /App Support|\/srv\/|pgl-seats-review6/, said)
  assert.doesNotMatch(said, new RegExp(os.homedir().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), said)
  assert.match(said, /…/)
  assert.equal(hidePaths('see http://127.0.0.1:9/v1'), 'see http://127.0.0.1:9/v1', '주소는 그대로')
})
