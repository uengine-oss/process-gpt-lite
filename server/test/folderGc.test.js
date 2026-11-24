// Packing the folders' repositories at night (lib/folders/gc.js) and no automatic gc in between (git.js).
//   - git's automatic gc is off for every command the server runs on a folder
//   - an editing session's saves fold into one commit (amend): what they leave behind goes once it has
//     expired — the nightly defaults keep a week (an undo the same week works), tests expire it now
//   - gc runs inside the folder's serial lock: it waits for a save in flight
//   - a folder with little to do is skipped; a linked repository is never touched
//   - the nightly pass is only started by a server with background work (not PRO_BACKGROUND=0)
// Run: node --test test/folderGc.test.js  (needs the local database; folders go to a temporary directory,
// in the test tenant "gitremote-test", and are removed afterwards)
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'pgl-gc-'))
process.env.PRO_TENANT_ID = 'gitremote-test'
process.env.PRO_FOLDERS_ROOT = path.join(ROOT, 'folders')
const GC = await import('../lib/folders/gc.js')
const G = await import('../lib/folders/git.js')

test('폴더 git 은 자동 gc 를 하지 않는다(gc.auto=0)', async () => {
  const dir = path.join(ROOT, 'plain')
  await fs.mkdir(dir, { recursive: true })
  await G.git(dir, ['init', '-q', '-b', 'main'])
  assert.equal((await G.git(dir, ['config', '--get', 'gc.auto'])).trim(), '0')
  // set for the command, whatever the repository's or the host's own configuration says
  await G.git(dir, ['config', 'gc.auto', '50'])
  assert.match((await G.git(dir, ['config', '--show-origin', '--get', 'gc.auto'])).trim(), /^command line:\s+0$/)
})

test('할 일이 적은 폴더는 건너뛴다', () => {
  const c = (o) => ({ count: 0, size: 0, inPack: 0, packs: 1, sizePack: 0, prunePackable: 0, garbage: 0, sizeGarbage: 0, ...o })
  const now = Date.parse('2026-11-24T18:00:00Z')
  assert.equal(GC.littleToDo(c({ count: 10, size: 40 }), null, now), true)
  assert.equal(GC.littleToDo(c({ count: GC.LOOSE_COUNT }), null, now), false, '느슨한 객체가 많다')
  assert.equal(GC.littleToDo(c({ size: GC.LOOSE_KIB }), null, now), false, '느슨한 객체가 크다')
  assert.equal(GC.littleToDo(c({ packs: 2 }), null, now), false, '팩이 여럿')
  assert.equal(GC.littleToDo(c({ garbage: 1 }), null, now), false, '찌꺼기')
  // a big single pack: once a week, so expired leftovers of amended saves go
  assert.equal(GC.littleToDo(c({ sizePack: 50 * 1024 }), null, now), false, '정리한 적 없음')
  assert.equal(GC.littleToDo(c({ sizePack: 50 * 1024 }), '2026-11-22T18:00:00Z', now), true, '이틀 전에 정리')
  assert.equal(GC.littleToDo(c({ sizePack: 50 * 1024 }), '2026-11-10T18:00:00Z', now), false, '2주 전에 정리')
})

test('index.js: 밤 정리는 PRO_BACKGROUND=0 이면 시작하지 않는다', async () => {
  const src = await fs.readFile(new URL('../index.js', import.meta.url), 'utf8')
  const off = src.indexOf("if (!background) return console.log('PRO_BACKGROUND=0")
  const start = src.indexOf('startFolderGc()')
  assert.ok(off > 0 && start > off, 'startFolderGc() 는 PRO_BACKGROUND=0 의 return 뒤에서만 불린다')
})

// ---------- on the local database ----------
const { q, pool } = await import('../lib/supa.js')
const db = await q('select 1 from pro_folders limit 1').then(() => true).catch(() => false)
const S = await import('../lib/folders/service.js')
const made = []
after(async () => {
  for (const f of made) await q('delete from pro_folders where id=$1', [f.id]).catch(() => {})
  await pool.end()
  await fs.rm(ROOT, { recursive: true, force: true })
})
const user = { id: crypto.randomUUID(), name: 'gc 시험', email: `gc-${Date.now()}@example.test` }
const MSG = '이음오피스에서 고침: 보고서.docx\n\nOffice-Session: gc-test'
async function du(dir) {
  let n = 0
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    n += e.isDirectory() ? await du(p) : (await fs.stat(p)).size
  }
  return n
}
// one editing session: a big document saved again and again, each save folded into the session's commit
async function autosaves(f, times, bytes = 1024 * 1024) {
  const blobs = []
  for (let i = 0; i < times; i++) {
    await fs.writeFile(path.join(f.repo_path, '보고서.docx'), crypto.randomBytes(bytes))
    const fold = i > 0 && await G.canFold(f.repo_path, 'main', { message: MSG, path: '보고서.docx', email: user.email })
    await G.commitPath(f.repo_path, '보고서.docx', MSG, user, { amend: fold })
    blobs.push((await G.git(f.repo_path, ['rev-parse', 'main:보고서.docx'])).trim())
  }
  return blobs
}

test('여러 번 접어 저장한 큰 문서: 밤 기본값은 한 주를 남기고, 기한이 지나면 디스크가 준다', { skip: !db }, async () => {
  const f = await S.createFolder(user, { name: `gc 접기 ${Date.now()}` })
  made.push(f)
  const blobs = await autosaves(f, 8)
  assert.equal((await G.log(f.repo_path, 'main', 10)).length, 2, '폴더 만들기 + 편집 한 줄')
  const diskBefore = await du(path.join(f.repo_path, '.git'))

  // the nightly defaults: packed, but what the saves replaced stays a week (an undo still finds it)
  const nightly = await GC.gcFolder(f, { force: true })
  assert.ok(nightly.beforeKiB >= 8 * 1000, `before ${nightly.beforeKiB} KiB`)
  assert.equal((await G.git(f.repo_path, ['cat-file', '-t', blobs[0]], { check: false })).trim(), 'blob')

  // the week is over (the test expires it now): the replaced versions go, the last one stays
  const r = await GC.gcFolder({ ...f, settings: {} }, { reflogExpire: 'now', pruneExpire: 'now', force: true })
  const diskAfter = await du(path.join(f.repo_path, '.git'))
  assert.ok(r.afterKiB < r.beforeKiB / 3, `${r.beforeKiB} KiB → ${r.afterKiB} KiB`)
  assert.ok(diskAfter < diskBefore / 3, `.git ${diskBefore} → ${diskAfter} bytes`)
  assert.equal((await G.git(f.repo_path, ['cat-file', '-t', blobs[0]], { check: false })).trim(), '', '바뀌기 전 버전은 사라졌다')
  assert.equal((await G.git(f.repo_path, ['cat-file', '-t', blobs.at(-1)])).trim(), 'blob', '마지막 버전은 그대로')
  assert.equal((await G.git(f.repo_path, ['fsck', '--no-progress'], { check: false })).includes('missing'), false)
  console.log(`[gc test] 8 folded saves of 1 MB: ${nightly.beforeKiB} KiB, nightly defaults → ${nightly.afterKiB} KiB, expired → ${r.afterKiB} KiB; .git on disk ${Math.round(diskBefore / 1024)} → ${Math.round(diskAfter / 1024)} KiB`)
  // the last pass rides on the folder's settings (jsonb: no new table)
  const [row] = await q('select settings from pro_folders where id=$1', [f.id])
  assert.deepEqual(Object.keys(row.settings.gc).sort(), ['afterKiB', 'at', 'beforeKiB'])
  assert.equal(row.settings.gc.afterKiB, r.afterKiB)
})

test('gc 는 폴더의 직렬 잠금 안에서: 진행 중인 main 쓰기를 기다린다', { skip: !db }, async () => {
  const f = await S.createFolder(user, { name: `gc 잠금 ${Date.now()}` })
  made.push(f)
  let release
  const order = []
  const writing = S.serial(f.id, async () => {
    await new Promise((r) => { release = r })
    await fs.writeFile(path.join(f.repo_path, '메모.md'), '쓰는 중이던 저장\n')
    await S.commitMainNow(f, user, '저장')
    order.push('write')
  })
  const gc = GC.gcFolder(f, { force: true }).then((r) => { order.push('gc'); return r })
  await new Promise((r) => setTimeout(r, 400))
  assert.deepEqual(order, [], '쓰기가 끝나기 전에는 gc 가 시작하지 않는다')
  release()
  await writing
  const r = await gc
  assert.deepEqual(order, ['write', 'gc'])
  // gc saw the write: its commit is in the pack it made
  assert.ok(r.after.inPack >= 6, JSON.stringify(r.after))
  assert.equal((await G.log(f.repo_path, 'main', 5))[0].msg, '저장')
})

test('할 일이 적으면 건너뛰고, 연결형 폴더는 건드리지 않는다, 회사의 폴더마다 한 줄', { skip: !db }, async () => {
  const f = await S.createFolder(user, { name: `gc 작은 ${Date.now()}` })
  made.push(f)
  assert.equal((await GC.gcFolder(f)).skipped, 'little')
  // and one with many loose objects: a few hundred small files, as a folder fills up
  const busy = await S.createFolder(user, { name: `gc 많은 ${Date.now()}` })
  made.push(busy)
  for (let i = 0; i < GC.LOOSE_COUNT; i++) await fs.writeFile(path.join(busy.repo_path, `메모-${i}.md`), `메모 ${i} ${crypto.randomUUID()}\n`)
  await S.commitMainNow(busy, user, '메모 여러 개')
  assert.equal((await GC.gcFolder({ ...f, kind: 'linked' }, { force: true })).skipped, 'linked')

  const lines = []
  const log = console.log
  console.log = (...a) => { lines.push(a.join(' ')); log(...a) }
  try { await GC.gcTenant() } finally { console.log = log }
  const ours = lines.filter((l) => l.startsWith('[folders gc] gitremote-test/'))
  // every folder of the test tenant this file made, one line each, with before/after or why it was skipped
  for (const m of made) assert.equal(ours.filter((l) => l.includes(`/${m.slug}:`)).length, 1, m.slug)
  assert.ok(ours.every((l) => /KiB → \d+ KiB|skipped/.test(l)), ours.join('\n'))
  assert.match(ours.find((l) => l.includes(`/${busy.slug}:`)), /\d+ KiB → \d+ KiB in /)
})
