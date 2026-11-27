// Packing the folders' repositories: one pass a night (03:00 KST), folder by folder.
// A folder's main is edited like a drive and an editing session's saves fold into one commit (amend):
// every save of a 10 MB document leaves a 10 MB object behind that nothing points at once the next save
// replaces the commit. git's automatic gc is off for every command this server runs (git.js), so a save
// never waits for a repack; this pass does it at night instead, inside the folder's serial lock, so it
// never overlaps a save, a merge or an agent's push (gitHttp.js).
//   - what is unreachable goes after 7 days (reflog entries and loose objects): an undo the same week works
//   - never --aggressive (hours of CPU for a few percent) nor --prune=now (races a write in flight)
//   - a folder with little to do is left alone
//   - what a push stopped half way left of its quarantine (objects/tmp_objdir-incoming-…: what it received, never in the repository) goes
//     every night, packing or not — inside the lock no push is running
import fs from 'node:fs/promises'
import path from 'node:path'
import { config } from '../../config.js'
import { q } from '../supa.js'
import { forEachTenant } from '../tenant.js'
import { nextRun } from '../scheduler.js'
import * as G from './git.js'
import * as S from './service.js'

const GC_TIMEOUT = 30 * 60_000
// little to do: fewer loose objects than this, and less loose data, at most one pack and no garbage …
export const LOOSE_COUNT = 300
export const LOOSE_KIB = 20 * 1024
// … and either a small pack or a pass in the last week (amended saves' reflog entries expire after 7 days:
// a folder that went quiet still needs one later pass to let them go)
export const PACK_KIB = 1024
const WEEK = 7 * 86_400_000
const EXPIRY = /^[A-Za-z0-9.]+$/

// `git count-objects -v` → {count, size, inPack, packs, sizePack, prunePackable, garbage, sizeGarbage} (sizes in KiB)
export async function countObjects(dir) {
  const out = await G.git(dir, ['count-objects', '-v'])
  const v = Object.fromEntries(out.split('\n').filter(Boolean).map((l) => {
    const [k, n] = l.split(':')
    return [k.trim().replace(/-([a-z])/g, (_, c) => c.toUpperCase()), Number(n) || 0]
  }))
  return { count: 0, size: 0, inPack: 0, packs: 0, sizePack: 0, prunePackable: 0, garbage: 0, sizeGarbage: 0, ...v }
}
export const kib = (c) => c.size + c.sizePack + c.sizeGarbage

export function littleToDo(c, lastAt, now = Date.now()) {
  if (c.garbage > 0 || c.packs > 1 || c.count >= LOOSE_COUNT || c.size >= LOOSE_KIB) return false
  const recent = lastAt && now - Date.parse(lastAt) < WEEK
  return c.sizePack < PACK_KIB || !!recent
}

// One folder. opts.reflogExpire / opts.pruneExpire: git's expiry values (tests pass 'now'); opts.force: even
// with little to do. → {skipped} | {at, beforeKiB, afterKiB, ms}
export async function gcFolder(folder, { reflogExpire = '7.days', pruneExpire = '7.days.ago', force = false } = {}) {
  if (folder.kind === 'linked') return { skipped: 'linked' } // someone else's repository: never changed here
  if (!EXPIRY.test(reflogExpire) || !EXPIRY.test(pruneExpire)) throw new Error('bad expiry')
  return S.serial(folder.id, async () => {
    if (!(await fs.stat(path.join(folder.repo_path, '.git')).catch(() => null))) return { skipped: 'missing' }
    const leftover = await dropQuarantines(folder.repo_path)
    // (the branches of epochs a PC working copy's seat left behind — seatLink.js: what is still to be packed then is the folder's own)
    const seatBranches = await import('./seatLink.js').then((m) => m.dropOldSeatBranches(folder)).catch((e) => { console.warn(`[folders gc] seat branches: ${e.message}`); return 0 })
    const before = await countObjects(folder.repo_path)
    if (!force && littleToDo(before, folder.settings?.gc?.at)) return { skipped: 'little', before, leftover, seatBranches }
    const t0 = Date.now()
    await G.git(folder.repo_path, ['-c', 'pack.threads=1', '-c', 'pack.windowMemory=256m',
      '-c', `gc.reflogExpireUnreachable=${reflogExpire}`, '-c', `gc.pruneExpire=${pruneExpire}`, 'gc', '--quiet'], { timeout: GC_TIMEOUT })
    const after = await countObjects(folder.repo_path)
    const gc = { at: new Date().toISOString(), beforeKiB: kib(before), afterKiB: kib(after) }
    // pro_folders.settings is jsonb: the last pass rides along with the folder, no table of its own
    await q(`update pro_folders set settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('gc', $2::jsonb) where id=$1`, [folder.id, gc])
    return { ...gc, ms: Date.now() - t0, before, after, leftover, seatBranches }
  })
}
// the quarantine folders a stopped push left (git's receive-pack: objects/tmp_objdir-incoming-XXXXXX) → how many went
export async function dropQuarantines(repo) {
  const objects = path.join(repo, '.git', 'objects')
  let n = 0
  for (const name of await fs.readdir(objects).catch(() => [])) {
    if (!/^tmp_objdir-incoming-[A-Za-z0-9]+$/.test(name)) continue
    await fs.rm(path.join(objects, name), { recursive: true, force: true }).then(() => { n++ }).catch(() => {})
  }
  return n
}

// every folder of the current tenant, one at a time, one log line each
export async function gcTenant(opts = {}) {
  const rows = await q(`select * from pro_folders where tenant_id=$1 and kind <> 'linked' order by created_at`, [config.tenantId])
  const done = []
  for (const f of rows) {
    const where = `${config.tenantId}/${f.slug}`
    try {
      const r = await gcFolder(f, opts)
      if (r.skipped === 'little') console.log(`[folders gc] ${where}: skipped, little to do (${r.before.count} loose, ${r.before.packs} pack(s), ${kib(r.before)} KiB)`)
      else if (r.skipped) console.log(`[folders gc] ${where}: skipped (${r.skipped})`)
      else console.log(`[folders gc] ${where}: ${r.beforeKiB} KiB → ${r.afterKiB} KiB in ${(r.ms / 1000).toFixed(1)}s`)
      done.push({ folder: f.id, ...r })
    } catch (e) { console.warn(`[folders gc] ${where}: ${e.message}`) }
  }
  return done
}

let timer = null
let running = false
// the nightly pass (PRO_BACKGROUND=0 never starts it: index.js). PRO_FOLDER_GC_CRON=off turns it off.
export function startFolderGc(cron = config.folderGcCron) {
  if (timer || !cron || cron === 'off') return
  const plan = () => {
    const at = nextRun(cron)
    if (!at) return console.warn(`[folders gc] no next run for '${cron}'`)
    timer = setTimeout(async () => {
      if (!running) {
        running = true
        try { await forEachTenant(() => gcTenant(), 'folders gc') } finally { running = false }
      }
      plan()
    }, Math.max(1000, at.getTime() - Date.now()))
    timer.unref?.()
  }
  plan()
}
