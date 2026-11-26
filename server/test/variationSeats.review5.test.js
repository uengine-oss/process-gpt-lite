// Variation seats — after the fourth review of PR #86 (2026-11-26): this failed before its fix.
//   T-01 a retire stopped mid-way (a pod killed after it moved the checkout out of the way) left its copy under .retiring/, seen by nobody:
//        the sweep keeps it in .kept/<variation>/<time> with a record, so it shows under 「따로 남긴 파일」 and goes by the usual days — a
//        copy another server is still working on is left alone, and a retire that ends well leaves nothing there
// Run: node --test test/variationSeats.review5.test.js  (the local database with sql/063; folders in a temporary directory, tenant
// "seats-review5", removed afterwards)
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'pgl-seats-review5-'))
const TENANT = 'seats-review5'
process.env.PRO_TENANT_ID = TENANT
process.env.PRO_FOLDERS_ROOT = path.join(ROOT, 'folders')
process.env.PRO_LLM_BASE_URL = 'http://127.0.0.1:9/v1'
const SE = await import('../lib/folders/seats.js')
const { q, pool } = await import('../lib/supa.js')
const db = await q('select 1 from pro_variation_locks limit 1').then(() => true).catch(() => false)
const S = await import('../lib/folders/service.js')
const { ensureTenantRow } = await import('../lib/tenant.js')
const owner = { id: crypto.randomUUID(), name: '한소유', email: 'review5-owner@example.test' }
if (db) {
  await ensureTenantRow(TENANT).catch(() => {})
  await q('insert into users (id, email, username, tenant_id) values ($1,$2,$3,$4) on conflict do nothing', [owner.id, owner.email, owner.name, TENANT]).catch(() => {})
}
after(async () => {
  if (db) {
    await q('delete from pro_variation_seat_log where tenant_id=$1', [TENANT]).catch(() => {})
    await q('delete from pro_folders where tenant_id=$1', [TENANT]).catch(() => {})
    await q("delete from users where tenant_id=$1 and email like '%@example.test'", [TENANT]).catch(() => {})
  }
  await pool.end()
  await fs.rm(ROOT, { recursive: true, force: true })
})
const ago = (ms) => new Date(Date.now() - ms).toISOString()

test('T-01 치우다 멈춘 서버의 .retiring 사본은 쓸기가 그 변형의 「따로 남긴 파일」로 남긴다 — 다른 서버가 작업 중인 사본은 둔다', { skip: !db && 'no database' }, async () => {
  const f0 = await S.createFolder(owner, { name: `멈춘 사본 ${crypto.randomBytes(3).toString('hex')}` })
  await S.upload(f0, owner, '.gitignore', Buffer.from('*.env\n'))
  const f = await S.folderById(f0.id)
  const mkVar = (title) => S.createVariation(f, { title, kind: 'person', holder: { type: 'user', id: owner.id, name: owner.name }, createdBy: owner.id })
  const retiring = path.join(S.foldersRoot(), '.retiring')
  // a retire that ends well leaves nothing under .retiring
  const ok = await mkVar('잘 끝난')
  await SE.openServer(f, ok, { user: owner, run: 'workroom', dir: S.personCheckoutDir(owner, ok) })
  await fs.writeFile(path.join((await S.variationById(ok.id)).worktree_path, '비밀.env'), 'A=1\n')
  await SE.closeServer(f, await S.variationById(ok.id), { by: owner.id, me: owner })
  assert.deepEqual(await fs.readdir(retiring).catch(() => []), [], '잘 끝난 치우기는 사본도 메모도 남기지 않는다')
  // what retires of two other servers left: one stopped twenty minutes ago (its pod was killed), one is moving its copy right now
  const stage = async (title, host, at) => {
    const v = await mkVar(title)
    const copy = path.join(retiring, `${v.id}-${crypto.randomBytes(3).toString('hex')}`)
    await fs.mkdir(copy, { recursive: true })
    await fs.writeFile(path.join(copy, '비밀.env'), `${title}\n`)
    await fs.writeFile(`${copy}.json`, JSON.stringify({ vid: v.id, repo: f.repo_path, branch: v.branch, mode: 'person', host, pid: 4242, at }))
    // (a note's age is its file's own time — review 6)
    await fs.utimes(`${copy}.json`, new Date(at), new Date(at))
    return { v, copy }
  }
  const dead = await stage('멈춘', 'stopped-pod-4c1e', ago(20 * 60_000))
  const live = await stage('작업 중', 'live-pod-77aa', ago(1000))
  await SE.sweep()
  assert.equal(existsSync(dead.copy), false, '멈춘 치우기의 사본은 옮겼다')
  assert.equal(existsSync(`${dead.copy}.json`), false)
  const [k] = await SE.keptOf(f, await S.variationById(dead.v.id), { me: owner, role: 'owner' })
  assert.ok(k, '그 변형의 「따로 남긴 파일」에 있다')
  assert.equal(k.canGet, true)
  assert.ok(k.bytes > 0)
  const z = await SE.keptZip(f, await S.variationById(dead.v.id), k.id, { me: owner, role: 'owner' })
  const parts = []
  await new Promise((resolve, reject) => { z.stream.on('data', (c) => parts.push(c)); z.stream.on('end', resolve); z.stream.on('error', reject) })
  const JSZip = (await import('jszip')).default
  assert.match(await (await JSZip.loadAsync(Buffer.concat(parts))).file('비밀.env').async('string'), /멈춘/)
  assert.ok(existsSync(live.copy), '다른 서버가 작업 중인 사본은 그대로')
  assert.ok(existsSync(`${live.copy}.json`))
  // and it goes by the usual days, from its record
  await q(`update pro_variation_seat_log set at = now() - ($2 || ' days')::interval where id=$1`, [k.id, String(SE.keptDays() + 1)])
  await SE.dropOldKept()
  assert.equal((await SE.keptOf(f, await S.variationById(dead.v.id), { me: owner, role: 'owner' })).length, 0)
})
