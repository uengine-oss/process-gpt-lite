// Variation seats — the fourth review of PR #86 (2026-11-26): each case here failed before its fix.
//   B1 a retire that stopped mid-way (a pod killed) left its checkout's worktree entry locked: the branch could never be checked out again
//      (a 500 with a server path). Its lock carries a mark now; checkout frees a stopped one of its branch (409 busy while it may go on),
//      the sweep frees old ones everywhere
//   B2 · S5 a checkout holding tens of thousands of entries git does not carry, and many folders, leaves the disk without freezing the server
//   B3 a lease renewal only extends this work's own running row — after another server took the row and gave it back, the work stops; the
//      lease queries answer even while the shared pool is busy
//   S1 a kept zip reads each file only when it comes to it — never past the size counted, never through a link put in its place, never a
//      vanished file as an empty one — and only a few zips go at once (409 busy)
//   S2 a kept folder that went away mid-request is a clean 404 'gone'; a download given up frees its place
//   S3 a run whose lease was lost before its result came in leaves the result as a variation of its own (the live checkout untouched)
//   S4 a checkout whose `.git` file was rewritten (its shell) is still put away by its own git folder — another checkout's lock untouched
//   S6 a server failure on the folder routes says no server path
// Run: node --test test/variationSeats.review4.test.js  (the local database with sql/063; folders in a temporary directory, tenant
// "seats-review4", removed afterwards)
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { monitorEventLoopDelay } from 'node:perf_hooks'

const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'pgl-seats-review4-'))
const TENANT = 'seats-review4'
process.env.PRO_TENANT_ID = TENANT
process.env.PRO_FOLDERS_ROOT = path.join(ROOT, 'folders')
process.env.PRO_LLM_BASE_URL = 'http://127.0.0.1:9/v1'
const SE = await import('../lib/folders/seats.js')
const { q, pool } = await import('../lib/supa.js')
const db = await q('select 1 from pro_variation_locks limit 1').then(() => true).catch(() => false)
const S = await import('../lib/folders/service.js')
const G = await import('../lib/folders/git.js')
const { stillHeld } = await import('../lib/folders/diskLease.js')
const { ensureTenantRow } = await import('../lib/tenant.js')
const owner = { id: crypto.randomUUID(), name: '한소유', email: 'review4-owner@example.test' }
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
const adminOf = async (dir) => (await G.git(dir, ['rev-parse', '--absolute-git-dir'])).trim()
const streamed = (s) => new Promise((resolve, reject) => { const parts = []; s.on('data', (c) => parts.push(c)); s.on('end', () => resolve(Buffer.concat(parts))); s.on('error', reject) })
const ago = (ms) => new Date(Date.now() - ms).toISOString()
// what a retire did before its server stopped: its checkout's entry locked (reason), the folder moved out of the way
// (age: how long ago the lock was written — its file's own time, which is what its age is told by since the re-review)
async function stoppedRetire(dir, reason, age = 0) {
  const admin = await adminOf(dir)
  await fs.writeFile(path.join(admin, 'locked'), reason)
  if (age) { const t = new Date(Date.now() - age); await fs.utimes(path.join(admin, 'locked'), t, t) }
  await fs.rename(dir, `${dir}-moved-by-a-stopped-server`)
  return admin
}
// a process id that surely runs no more on this host
async function deadPid() {
  for (let pid = 400000; ; pid++) { try { process.kill(pid, 0) } catch (e) { if (e.code === 'ESRCH') return pid } }
}

test('R4-B1a 치우다 멈춘 서버가 남긴 worktree 잠금은 체크아웃이 풀고 같은 자리에 다시 펼친다', { skip: !db && 'no database' }, async () => {
  const f = await folderWith('멈춘 치우기')
  const reasons = [
    ['leaving the disk (Process GPT Lite)', 0], // the first version's
    [`pgl-retire stopped-pod-7f9c:4242 ${ago(2 * 60_000)}`, 2 * 60_000], // another server, two minutes ago
    [`pgl-retire ${os.hostname()}:${await deadPid()} ${ago(1000)} boot=0badc0ffee00 ns=${S.retireNs()}`, 0], // a process of this host (and pid namespace) that is gone
  ]
  for (const [reason, age] of reasons) {
    const v = await personVar(f, `멈춘 치우기 ${reason.slice(0, 12)}`)
    await open(f, v)
    const dir = await wt(v)
    await stoppedRetire(dir, reason, age)
    await SE.onDisk(String(v.id), async () => S.checkout(f, await S.variationById(v.id), dir))
    assert.ok(existsSync(path.join(dir, '.git')), `다시 펼쳤다 (${reason.slice(0, 20)})`)
    assert.ok(existsSync(path.join(dir, '안내문.md')))
    const list = await G.git(f.repo_path, ['worktree', 'list', '--porcelain'])
    assert.doesNotMatch(list, /moved-by-a-stopped-server/)
    assert.doesNotMatch(list, /^locked/m, '남은 잠금이 없다')
  }
})

test('R4-B1b 다른 서버가 방금 건 잠금(치우는 중일 수 있음)이면 409 busy — 500 도, 서버 경로도 아니다', { skip: !db && 'no database' }, async () => {
  const f = await folderWith('치우는 중')
  const v = await personVar(f)
  await open(f, v)
  const dir = await wt(v)
  const admin = await stoppedRetire(dir, `pgl-retire live-pod-2b:17 ${ago(1000)}`)
  const e = await SE.onDisk(String(v.id), async () => S.checkout(f, await S.variationById(v.id), dir)).then(() => null, (x) => x)
  assert.equal(e?.status, 409)
  assert.equal(e.why, 'busy')
  assert.doesNotMatch(e.message, /\/(private|var|Users|tmp)\//)
  assert.match(await fs.readFile(path.join(admin, 'locked'), 'utf8'), /live-pod-2b/, '그 잠금은 그대로')
})

test('R4-B1c 쓸기는 오래전에 멈춘 치우기의 잠금을 풀고 정리한다 — 방금 건 다른 서버의 잠금은 둔다', { skip: !db && 'no database' }, async () => {
  const f = await folderWith('쓸기 잠금')
  const v1 = await personVar(f, '오래된')
  const v2 = await personVar(f, '방금')
  await open(f, v1)
  await open(f, v2)
  const a1 = await stoppedRetire(await wt(v1), `pgl-retire stopped-pod-1:1 ${ago(20 * 60_000)}`, 20 * 60_000)
  const a2 = await stoppedRetire(await wt(v2), `pgl-retire live-pod-2:1 ${ago(1000)}`)
  await SE.sweep()
  assert.equal(existsSync(a1), false, '멈춘 치우기의 항목은 정리됐다')
  assert.ok(existsSync(path.join(a2, 'locked')), '방금 건 잠금은 그대로')
})

test('R4-B2·S5 git 이 싣지 않는 항목 수만 개 · 폴더 수백 개를 치워도 서버가 멈추지 않는다', { skip: !db && 'no database' }, async () => {
  const f = await folderWith('많은 항목', '*.log\n')
  const branch = `review4/many-${crypto.randomBytes(2).toString('hex')}`
  await G.git(f.repo_path, ['branch', branch, 'main'])
  const dir = path.join(S.foldersRoot(), '.people', 'many', crypto.randomBytes(3).toString('hex'))
  await fs.mkdir(path.dirname(dir), { recursive: true })
  await G.git(f.repo_path, ['worktree', 'add', '-q', dir, branch])
  const N = 30_000
  for (let i = 0; i < N; i += 1000) await Promise.all(Array.from({ length: Math.min(1000, N - i) }, (_, k) => fs.writeFile(path.join(dir, `f${String(i + k).padStart(5, '0')}.log`), 'x')))
  for (let i = 0; i < 1000; i++) { await fs.mkdir(path.join(dir, 'tree', `d${i}`), { recursive: true }); await fs.writeFile(path.join(dir, 'tree', `d${i}`, 'a.txt'), 'a') }
  // finding what git does not carry does not walk what it already named (S5)
  const t0 = Date.now()
  const left = await S.leftIn(dir)
  assert.ok(Date.now() - t0 < 2500, `leftIn 이 ${Date.now() - t0} ms 걸렸다`)
  assert.ok(left.length >= N)
  const h = monitorEventLoopDelay({ resolution: 10 })
  h.enable()
  const t = Date.now()
  const out = await S.retire(f.repo_path, dir, { mode: 'person', vid: crypto.randomUUID() })
  h.disable()
  const worst = h.max / 1e6
  assert.ok(worst < 700, `이벤트 루프가 ${Math.round(worst)} ms 멈췄다 (${Date.now() - t} ms 동안 치움)`)
  assert.equal(existsSync(path.join(out.keptDir, 'f00000.log')), true)
  assert.equal(existsSync(path.join(out.keptDir, 'tree', 'd999', 'a.txt')), true, '폴더 안의 것도 남긴다')
})

test('R4-B3a 임대 갱신은 다시 잡지 않는다 — 다른 서버가 잡았다 돌려준 뒤면 멈추고, 행을 새로 만들지 않는다', { skip: !db && 'no database' }, async () => {
  const f = await folderWith('ABA')
  const v = await personVar(f)
  const out = await SE.onDisk(String(v.id), async () => {
    await q(`update pro_variation_locks set owner='다른 서버', until=now() + interval '1 minute' where variation_id=$1`, [v.id])
    await q('delete from pro_variation_locks where variation_id=$1', [v.id])
    const e = await stillHeld('commit').then(() => null, (x) => x)
    const [row] = await q('select owner from pro_variation_locks where variation_id=$1', [v.id])
    return { e, row }
  })
  assert.equal(out.e?.status, 409, '임대를 잃었다')
  assert.equal(out.row, undefined, '갱신이 행을 새로 만들지 않았다')
})

test('R4-B3b 공유 연결 풀이 바빠도 임대 확인은 몇 초 안에 답한다', { skip: !db && 'no database' }, async () => {
  const f = await folderWith('바쁜 풀')
  const v = await personVar(f)
  const res = await SE.onDisk(String(v.id), async () => {
    const held = []
    for (let i = 0; i < (pool.options.max || 10); i++) held.push(await pool.connect())
    try {
      return await Promise.race([stillHeld('commit').then(() => 'answered', (e) => `refused ${e.status}`), new Promise((r) => setTimeout(() => r('stalled'), 3000))])
    } finally { for (const c of held) c.release() }
  })
  assert.equal(res, 'answered')
})

// a person's workroom put away with three .gitignore'd files kept on the server
async function kept3(label) {
  const f = await folderWith(label, '*.bin\n')
  const v = await personVar(f)
  await open(f, v)
  const dir = await wt(v)
  await fs.writeFile(path.join(dir, '하나.bin'), 'AAAA')
  await fs.writeFile(path.join(dir, '둘.bin'), 'BBBB')
  await fs.writeFile(path.join(dir, '셋.bin'), 'CCCC')
  await SE.closeServer(f, await S.variationById(v.id), { by: owner.id, me: owner })
  const [k] = await SE.keptOf(f, await S.variationById(v.id), asOwner)
  const keptDir = (await fs.readdir(path.join(S.foldersRoot(), '.kept', String(v.id)))).map((x) => path.join(S.foldersRoot(), '.kept', String(v.id), x))[0]
  return { f, v: await S.variationById(v.id), k, keptDir }
}

test('R4-S1a 남긴 파일은 zip 이 그 차례에 읽는다 — 센 크기만큼, 링크로 바뀌었거나 사라졌거나 작아졌으면 zip 이 실패한다', { skip: !db && 'no database' }, async () => {
  const { f, v, k, keptDir } = await kept3('늦게 읽기')
  const JSZip = (await import('jszip')).default
  // read when its turn comes: what is there then (same size) goes in
  let z = await SE.keptZip(f, v, k.id, asOwner)
  await fs.writeFile(path.join(keptDir, '하나.bin'), 'aaaa')
  const got = await JSZip.loadAsync(await streamed(z.stream))
  assert.equal(await got.file('하나.bin').async('string'), 'aaaa', '그 차례에 읽었다')
  // a link put in a file's place since it was counted: never followed
  const secret = path.join(ROOT, '비밀.txt')
  await fs.writeFile(secret, 'SECR')
  z = await SE.keptZip(f, v, k.id, asOwner)
  await fs.rm(path.join(keptDir, '둘.bin'))
  await fs.symlink(secret, path.join(keptDir, '둘.bin'))
  await assert.rejects(streamed(z.stream), '링크는 따라가지 않고 zip 이 실패한다')
  await fs.rm(path.join(keptDir, '둘.bin'))
  await fs.writeFile(path.join(keptDir, '둘.bin'), 'BBBB')
  // a file that got shorter since it was counted (one that grew goes in as counted — review 6)
  z = await SE.keptZip(f, v, k.id, asOwner)
  await fs.writeFile(path.join(keptDir, '셋.bin'), 'CC')
  await assert.rejects(streamed(z.stream), '작아진 파일은 zip 을 실패시킨다')
  await fs.writeFile(path.join(keptDir, '셋.bin'), 'CCCC')
  // a file that went away since it was counted: not an empty file in the zip
  z = await SE.keptZip(f, v, k.id, asOwner)
  await fs.rm(path.join(keptDir, '하나.bin'))
  await assert.rejects(streamed(z.stream), '사라진 파일은 zip 을 실패시킨다')
  for (let i = 0; i < 50 && SE.zipsGoing(); i++) await new Promise((r) => setTimeout(r, 10))
  assert.equal(SE.zipsGoing(), 0, '실패한 zip 도 자리를 돌려준다')
})

test('R4-S1b 한 서버에서 zip 은 몇 개만 함께 — 넘으면 409 busy, 하나가 끝나면 다시 된다', { skip: !db && 'no database' }, async () => {
  const { f, v, k } = await kept3('동시 zip')
  const a = await SE.keptZip(f, v, k.id, asOwner)
  const b = await SE.keptZip(f, v, k.id, asOwner)
  await assert.rejects(SE.keptZip(f, v, k.id, asOwner), (e) => e.status === 409 && e.why === 'busy')
  await assert.rejects(SE.keptZip(f, v, k.id, { ...asOwner, check: true }), (e) => e.status === 409, '미리 묻기도 바쁘다고 답한다')
  a.stream.destroy()
  await new Promise((r) => setImmediate(r))
  const c = await SE.keptZip(f, v, k.id, asOwner)
  await streamed(c.stream)
  await streamed(b.stream)
  for (let i = 0; i < 50 && SE.zipsGoing(); i++) await new Promise((r) => setTimeout(r, 10))
  assert.equal(SE.zipsGoing(), 0)
})

test('R4-S2 내려받는 사이 남긴 폴더가 사라지면 404 gone(경로 없음) · 내려받다 그만두면 자리를 돌려준다', { skip: !db && 'no database' }, async () => {
  const { f, v, k, keptDir } = await kept3('사라짐')
  await fs.writeFile(path.join(keptDir, '큰.bin'), crypto.randomBytes(8 * 1024 * 1024)) // (a download that takes a while)
  const express = (await import('express')).default
  const { folderRoutes } = await import('../routes/folders.js')
  const app = express()
  app.use(express.json())
  app.use('/api', folderRoutes((req, res, next) => { req.user = { ...owner }; next() }))
  const server = await new Promise((r) => { const sv = app.listen(0, '127.0.0.1', () => r(sv)) })
  const url = `http://127.0.0.1:${server.address().port}/api/folders/${f.slug}/variations/${v.id}/kept/${k.id}`
  try {
    const ok = await fetch(url)
    assert.equal(ok.status, 200)
    const JSZip = (await import('jszip')).default
    assert.ok((await JSZip.loadAsync(Buffer.from(await ok.arrayBuffer()))).file('하나.bin'))
    // given up after the first bytes, three times: the places come back
    for (let i = 0; i < 3; i++) {
      const ac = new AbortController()
      const r = await fetch(url, { signal: ac.signal })
      const reader = r.body.getReader()
      await reader.read()
      ac.abort()
      await reader.cancel().catch(() => {})
    }
    for (let i = 0; i < 50 && SE.zipsGoing(); i++) await new Promise((r) => setTimeout(r, 20))
    assert.equal(SE.zipsGoing(), 0, '그만둔 내려받기는 자리를 돌려준다')
    // the kept folder replaced meanwhile (the sweep took it, something else is there): a clean 404 'gone'
    await fs.rm(keptDir, { recursive: true })
    await fs.writeFile(keptDir, '')
    const e = await SE.keptZip(f, v, k.id, asOwner).then(() => null, (x) => x)
    assert.equal(e?.status, 404)
    assert.equal(e.why, 'gone')
    assert.doesNotMatch(e.message, /\.kept|\/(private|var|Users|tmp)\//)
  } finally { await new Promise((r) => server.close(r)) }
})

test('R4-S3 결과를 들이기 전에 임대를 잃은 실행은 결과를 새 변형으로 남긴다 — 살아 있는 작업본은 그대로', { skip: !db && 'no database' }, async () => {
  const f = await folderWith('들이기 전')
  const v = await personVar(f, '프로젝트')
  const dir = path.join(S.foldersRoot(), '.runs', `turn-${crypto.randomBytes(3).toString('hex')}`, f.slug)
  const run0 = await SE.openServer(f, v, { user: owner, run: 'agent', work: 'turn', ref: 'conv-s3', dir })
  // once this run's end has taken the variation's lease, another server takes it (before the result comes in)
  await Promise.all([q('select 1'), q('select 1'), q('select 1')])
  const query = pool.query
  let armed = false
  pool.query = function (...a) {
    if (!armed) return query.apply(this, a)
    armed = false
    const steal = query.call(this, `update pro_variation_locks set owner='다른 서버', until=now() + interval '1 minute' where variation_id=$1`, [v.id])
    return steal.then(() => query.apply(this, a))
  }
  // (the first query of the shared pool inside finishRun — after its lease was taken, before the result comes in — lets the other
  // server take the lease first)
  const cur = await S.variationById(v.id)
  let out
  try {
    armed = true
    out = await SE.finishRun(f, cur, run0, {
      user: owner.id, where: '턴',
      fill: async (d) => { await fs.writeFile(path.join(d, '결과.md'), '턴의 결과\n') },
      commit: (cur) => S.commitVariation(f, cur, owner, '턴', { strict: true }),
    })
  } finally { pool.query = query; await q('delete from pro_variation_locks where variation_id=$1', [v.id]) }
  assert.equal(out.held, false)
  assert.ok(out.left, '결과는 새 변형으로')
  assert.equal(existsSync(path.join(dir, '결과.md')), false, '살아 있는 작업본에는 들이지 않았다')
  assert.match((await G.show(f.repo_path, out.left.branch, '결과.md')).toString(), /턴의 결과/)
  assert.equal(await G.show(f.repo_path, v.branch, '결과.md').catch(() => null), null)
})

test('R4-S4 `.git` 파일이 다른 작업본을 가리켜도 자기 git 폴더로 치운다 — 남의 잠금은 그대로', { skip: !db && 'no database' }, async () => {
  const f = await folderWith('가리킴')
  const mk = async (name, file) => {
    const branch = `review4/${name}-${crypto.randomBytes(2).toString('hex')}`
    await G.git(f.repo_path, ['branch', branch, 'main'])
    const d = path.join(S.foldersRoot(), '.people', 'point', `${name}-${crypto.randomBytes(2).toString('hex')}`)
    await fs.mkdir(path.dirname(d), { recursive: true })
    await G.git(f.repo_path, ['worktree', 'add', '-q', d, branch])
    if (file) { await fs.writeFile(path.join(d, file), `${name}\n`); await G.commitAll(d, name, owner) }
    return d
  }
  const A = await mk('a', 'A에만.md')
  const B = await mk('b')
  await fs.writeFile(path.join(A, '저장 안 함.txt'), '남길 것\n')
  const adminB = await adminOf(B)
  const lockB = `pgl-retire live-pod-9:3 ${ago(500)}`
  await fs.writeFile(path.join(adminB, 'locked'), lockB) // (B is being put away by another server right now)
  await fs.writeFile(path.join(A, '.git'), `gitdir: ${adminB}\n`) // A's shell pointed its .git at B's git folder
  const out = await S.retire(f.repo_path, A, { mode: 'person', vid: crypto.randomUUID() })
  assert.equal(await fs.readFile(path.join(adminB, 'locked'), 'utf8'), lockB, 'B 의 잠금은 건드리지 않았다')
  assert.deepEqual((await fs.readdir(out.keptDir)).filter((x) => x !== '.git').sort(), ['저장 안 함.txt'], 'A 의 git 폴더로 보고 커밋된 것은 남기지 않았다')
  assert.doesNotMatch(await G.git(f.repo_path, ['worktree', 'list', '--porcelain']), new RegExp(path.basename(A)), 'A 의 항목은 정리됐다')
})

test('R4-S6 폴더 경로의 서버 실패는 서버 경로를 말하지 않는다(기록에는 남긴다)', { skip: !db && 'no database' }, async () => {
  const f = await folderWith('경로')
  const v = await personVar(f)
  // the branch is out at a place someone locked by hand and that is gone: git refuses to check it out again
  const X = path.join(S.foldersRoot(), '.people', 'hand', `x-${crypto.randomBytes(3).toString('hex')}`)
  await fs.mkdir(path.dirname(X), { recursive: true })
  await G.git(f.repo_path, ['worktree', 'add', '-q', X, v.branch])
  await G.git(f.repo_path, ['worktree', 'lock', '--reason', 'kept by hand', X])
  await fs.rm(X, { recursive: true })
  const express = (await import('express')).default
  const { folderRoutes } = await import('../routes/folders.js')
  const app = express()
  app.use(express.json())
  app.use('/api', folderRoutes((req, res, next) => { req.user = { ...owner }; next() }))
  const server = await new Promise((r) => { const sv = app.listen(0, '127.0.0.1', () => r(sv)) })
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/folders/${f.slug}/variations/${v.id}/seat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to: 'server' }) })
    const body = await r.json()
    assert.ok(r.status >= 500, `서버 실패 (${r.status})`)
    assert.doesNotMatch(body.error, new RegExp(ROOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), '임시 폴더 경로가 없다')
    assert.doesNotMatch(body.error, /\/(private|var|Users|tmp)\//, '서버 경로가 없다')
    assert.match(body.error, /…\//, '경로는 마지막 이름만')
  } finally {
    await new Promise((r) => server.close(r))
    await G.git(f.repo_path, ['worktree', 'unlock', X], { check: false })
    await G.git(f.repo_path, ['worktree', 'prune'], { check: false })
  }
})
