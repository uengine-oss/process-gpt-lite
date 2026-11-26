// Variation seats — the check of e775030 (PR #86, 2026-11-26): each case here failed before its fix.
//   Y-01 a copy to another filesystem removes the original only when it is still what was copied: a file rewritten at the same size, or one
//        gone, while the copy ran keeps the original (tried again later) — the newer write is never lost
//   Y-02 two sweeps that find the same stopped copy at once: one keeps it, the other leaves it — one copy, one record, no failure; a claim
//        of another server going on is left alone, one whose server stopped is taken over
//   Y-03 a FIFO in a copy (another filesystem) does not stop it: skipped, and named in the record
// The other filesystem is played by fs.promises.rename answering EXDEV for a move from .retiring into .kept.
// Run: node --test test/variationSeats.review8.test.js  (the local database with sql/063; folders in a temporary directory, tenant
// "seats-review8", removed afterwards)
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'

const ROOT = await fsp.mkdtemp(path.join(os.tmpdir(), 'pgl-seats-review8-'))
const TENANT = 'seats-review8'
process.env.PRO_TENANT_ID = TENANT
process.env.PRO_FOLDERS_ROOT = path.join(ROOT, 'folders')
process.env.PRO_LLM_BASE_URL = 'http://127.0.0.1:9/v1'
const SE = await import('../lib/folders/seats.js')
const { q, pool } = await import('../lib/supa.js')
const db = await q('select 1 from pro_variation_locks limit 1').then(() => true).catch(() => false)
const S = await import('../lib/folders/service.js')
const { ensureTenantRow } = await import('../lib/tenant.js')
const owner = { id: crypto.randomUUID(), name: '한소유', email: 'review8-owner@example.test' }
if (db) {
  await ensureTenantRow(TENANT).catch(() => {})
  await q('insert into users (id, email, username, tenant_id) values ($1,$2,$3,$4) on conflict do nothing', [owner.id, owner.email, owner.name, TENANT]).catch(() => {})
}
const realRename = fsp.rename, realCp = fsp.cp
let exdev = false, afterCp = null
fsp.rename = async (a, b) => {
  if (exdev && String(a).includes(`${path.sep}.retiring${path.sep}`) && String(b).includes(`${path.sep}.kept${path.sep}`)) throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' })
  return realRename(a, b)
}
fsp.cp = async (...args) => { const r = await realCp(...args); if (afterCp) await afterCp(String(args[0])); return r }
after(async () => {
  fsp.rename = realRename; fsp.cp = realCp
  if (db) {
    await q('delete from pro_variation_seat_log where tenant_id=$1', [TENANT]).catch(() => {})
    await q('delete from pro_folders where tenant_id=$1', [TENANT]).catch(() => {})
    await q("delete from users where tenant_id=$1 and email like '%@example.test'", [TENANT]).catch(() => {})
  }
  await pool.end()
  await fsp.rm(ROOT, { recursive: true, force: true })
})
let folder = null
const theFolder = async () => folder || (folder = await S.folderById((await S.createFolder(owner, { name: `사본 ${crypto.randomBytes(3).toString('hex')}` })).id))
const newVar = async (title) => S.createVariation(await theFolder(), { title: `${title} ${crypto.randomBytes(3).toString('hex')}`, kind: 'person', holder: { type: 'user', id: owner.id, name: owner.name }, createdBy: owner.id })
const ago = (ms) => new Date(Date.now() - ms)
// what a stopped server's retire left: a copy under .retiring and its note, an hour old
async function stoppedCopy(v, files) {
  const copy = path.join(S.foldersRoot(), '.retiring', `${String(v.id).slice(0, 8)}-${crypto.randomBytes(3).toString('hex')}`)
  await fsp.mkdir(copy, { recursive: true })
  for (const [name, body] of Object.entries(files)) await fsp.writeFile(path.join(copy, name), body)
  await fsp.writeFile(`${copy}.json`, JSON.stringify({ vid: v.id, host: 'stopped-pod-x', pid: 42, boot: 'feedfacefeed', ns: '1' }))
  await fsp.utimes(`${copy}.json`, ago(3600_000), ago(3600_000))
  return copy
}
const keptUnder = async (v) => (await fsp.readdir(path.join(S.keptRootOf(), String(v.id))).catch(() => [])).length
const rows = async (v, action) => q('select note from pro_variation_seat_log where variation_id=$1 and action=$2', [v.id, action])

test('Y-01 복사하는 사이 원본이 바뀌면(같은 크기로 다시 씀 · 사라짐) 원본을 지우지 않고 나중에 다시 해 본다', { skip: !db && 'no database' }, async () => {
  for (const change of ['rewrite', 'vanish']) {
    const v = await newVar(`바뀜 ${change}`)
    const copy = await stoppedCopy(v, { 'state.db': 'OLD-CONTENT-0001', 'other.txt': 'x' })
    exdev = true
    afterCp = async (from) => {
      if (from !== copy) return
      if (change === 'rewrite') await fsp.writeFile(path.join(copy, 'state.db'), 'NEW-CONTENT-0002')
      else await fsp.rm(path.join(copy, 'other.txt'))
    }
    try { await S.keepStoppedStagings() } finally { exdev = false; afterCp = null }
    assert.ok(existsSync(copy), `원본은 그대로 (${change})`)
    if (change === 'rewrite') assert.equal(await fsp.readFile(path.join(copy, 'state.db'), 'utf8'), 'NEW-CONTENT-0002', '새로 쓴 것이 남아 있다')
    assert.equal(await keptUnder(v), 0, `반쯤 · 옛것을 남기지 않았다 (${change})`)
    assert.ok(existsSync(`${copy}.fail`), '나중에 다시 해 본다')
  }
})

test('Y-02 두 쓸기가 같은 멈춘 사본을 함께 찾으면 하나만 남긴다 — 실패도 기록도 하나 · 진행 중인 남의 표지는 둔다', { skip: !db && 'no database' }, async () => {
  for (const cross of [false, true]) {
    const v = await newVar(`둘이 ${cross}`)
    const copy = await stoppedCopy(v, { 'a.txt': 'a'.repeat(200_000), 'b.txt': 'b' })
    exdev = cross
    let out
    try { out = await Promise.all([S.keepStoppedStagings(), S.keepStoppedStagings()]) } finally { exdev = false }
    assert.deepEqual(out.sort(), [0, 1], `하나만 남겼다 (${cross ? '다른' : '같은'} 파일시스템)`)
    assert.equal(await keptUnder(v), 1)
    assert.equal((await rows(v, 'kept')).length, 1)
    assert.equal((await rows(v, 'keep-failed')).length, 0, '실패로 보지 않았다')
    assert.equal(existsSync(copy) || existsSync(`${copy}.fail`) || existsSync(`${copy}.claim`), false)
  }
  // another server is moving this copy right now (its claim is fresh): left alone · its server stopped long ago: taken over
  const v = await newVar('남의 표지')
  const copy = await stoppedCopy(v, { 'a.txt': 'a' })
  await fsp.writeFile(`${copy}.claim`, JSON.stringify({ host: 'live-pod-y', pid: 7, boot: 'abcabcabcabc', ns: '1' }))
  assert.equal(await S.keepStoppedStagings(), 0)
  assert.ok(existsSync(copy), '진행 중인 남의 표지는 둔다')
  await fsp.utimes(`${copy}.claim`, ago(3600_000), ago(3600_000))
  assert.equal(await S.keepStoppedStagings(), 1, '멈춘 서버의 표지는 이어받는다')
  assert.equal(existsSync(copy), false)
  assert.equal(existsSync(`${copy}.claim`), false)
})

test('Y-03 다른 파일시스템으로 옮기는 사본에 FIFO 가 있어도 멈추지 않는다 — 건너뛰고 기록에 적는다', { skip: !db && 'no database' }, async () => {
  const v = await newVar('FIFO')
  const copy = await stoppedCopy(v, { 'notes.md': 'keep me' })
  execFileSync('mkfifo', [path.join(copy, 'pipe')])
  exdev = true
  try { assert.equal(await S.keepStoppedStagings(), 1) } finally { exdev = false }
  assert.equal(existsSync(copy), false, '원본은 지웠다')
  assert.equal(existsSync(`${copy}.fail`), false)
  const [row] = await rows(v, 'kept')
  assert.deepEqual(JSON.parse(row.note).skipped, ['pipe'], '건너뛴 것을 기록에 적었다')
  const [k] = await SE.keptOf(await theFolder(), await S.variationById(v.id), { me: owner, role: 'owner' })
  assert.equal(k.bytes, Buffer.byteLength('keep me'))
})
