// What a folder going up from a person's computer must not carry (champion folders, spec openspec/specs/champion-folders 「비밀 · 개인
// 설정 · 큰 파일은 올라가지 않는다」): the desktop app leaves such files out before it pushes, and the server looks again at what a sync
// push brought in. One data file for both (secret-shapes.json): the file names of secrets, and the FORMAT of known keys and tokens (a
// PEM private key's header, a provider's token prefix and length) — a check of file and token formats, never a reading of what a text
// means. The server refuses what is sure: a name of the 'secret' group, or a shape of level 'block'. A matched value is never kept,
// logged or sent: only the path, the line number and the shape's id.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
export const SHAPES = JSON.parse(fs.readFileSync(path.join(here, 'secret-shapes.json'), 'utf8'))
const low = (a) => (Array.isArray(a) ? a.map((x) => String(x).toLowerCase()) : [])
const GROUPS = Object.fromEntries(Object.entries(SHAPES.groups || {}).map(([g, r]) => [g, {
  names: new Set(low(r.names)), prefixes: low(r.prefixes), extensions: low(r.extensions), dirs: new Set(low(r.dirs)), paths: low(r.paths), dirPaths: low(r.dirPaths), keep: new Set(low(r.keep)),
}]))
const ORDER = ['secret', 'personal', 'rebuildable'].filter((g) => GROUPS[g])
const BLOCK = (SHAPES.shapes || []).filter((s) => s.level === 'block' && s.pattern).map((s) => ({ id: s.id, re: new RegExp(s.pattern, s.flags || '') }))
export const TEXT_MAX = Number(SHAPES.limits?.textMaxBytes) || 1024 * 1024
// what one sync push may carry (secret-shapes.json limits): new commits (the desktop makes one a round), one file's size, and the pushed
// head's whole tree — files and bytes before compression. Over one of them the push is refused as too big. (tests change them here)
export const LIMITS = {
  pushMaxCommits: 20, largeFileBytes: 50 * 1024 * 1024, headMaxFiles: 20000, headMaxBytes: 1024 * 1024 * 1024,
  ...Object.fromEntries(Object.entries(SHAPES.limits || {}).filter(([, v]) => Number.isFinite(Number(v))).map(([k, v]) => [k, Number(v)])),
}

// the group a file's path falls in by its names (any case — a computer's folder may not tell cases apart): every part of the path is
// looked at, the way git reads a pattern without a slash (a folder named .ssh leaves out all that is in it) → 'secret' | 'personal' |
// 'rebuildable' | null
export function groupOf(rel) {
  const segs = String(rel).toLowerCase().split('/').filter(Boolean)
  const full = segs.join('/')
  for (const g of ORDER) {
    const r = GROUPS[g]
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i]
      const last = i === segs.length - 1
      if (r.keep.has(s) && last) continue
      if (r.names.has(s)) return g
      if (r.prefixes.some((p) => s.startsWith(p)) && !r.keep.has(s)) return g
      if (r.extensions.some((x) => s.endsWith(x) && s.length > x.length)) return g
      if (!last && r.dirs.has(s)) return g
    }
    for (const p of r.paths) if (full === p || full.endsWith(`/${p}`)) return g
    for (const p of r.dirPaths) if (full.startsWith(`${p}/`) || full.includes(`/${p}/`)) return g
  }
  return null
}

// the first line of a text that holds a key of a sure shape → {line, reason} | null (the matched text is not returned)
export function blockIn(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf || ''), 'utf8')
  if (b.length > TEXT_MAX || b.subarray(0, 8000).includes(0)) return null
  const lines = b.toString('utf8').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const hit = BLOCK.find((s) => s.re.test(lines[i]))
    if (hit) return { line: i + 1, reason: hit.id }
  }
  return null
}

// What a folder's tree must not hold, whatever it says: a link (mode 120000), another repository (a gitlink, 160000), and the files that
// make git fetch or run something else (.gitmodules, .lfsconfig) → the reason, or null
// (a name as Windows and a Mac read it: case aside, trailing dots and spaces dropped — '.LFSCONFIG.' is .lfsconfig there)
const baseOf = (rel) => String(rel).split('/').pop().trim().toLowerCase().replace(/[. ]+$/, '')
export function structureOf({ path: rel, mode }) {
  if (mode === '120000') return 'symlink'
  if (mode === '160000') return 'submodule'
  const base = baseOf(rel)
  if (base === '.gitmodules') return 'gitmodules'
  if (base === '.lfsconfig') return 'lfsconfig'
  return null
}

// What the server refuses among pushed files [{path, size, sha}]: a secret's file name, or a key of a sure shape in it. Only text up to
// TEXT_MAX is read (a larger file or one with a NUL byte is not — this is a safety net behind the desktop's own check, not a boundary).
// contents(files, onBlob): the bytes of those files, all from one reader, each handed to onBlob(sha, buffer); it rejects when it cannot
// give them all — and so does this (nothing that could not be looked at goes through). → [{path, line, reason}] (empty: fine)
export async function refusedIn(files, contents) {
  const out = []
  const scan = []
  for (const f of files) {
    if (groupOf(f.path) === 'secret') out.push({ path: f.path, line: null, reason: 'name' })
    else if (Number(f.size) <= TEXT_MAX) scan.push(f)
  }
  if (scan.length) {
    const bySha = new Map()
    for (const f of scan) { if (!bySha.has(f.sha)) bySha.set(f.sha, []); bySha.get(f.sha).push(f.path) }
    const hits = new Map()
    await contents([...bySha.keys()], (sha, buf) => { const hit = blockIn(buf); if (hit) hits.set(sha, hit) })
    for (const [sha, paths] of bySha) if (hits.has(sha)) for (const p of paths) out.push({ path: p, ...hits.get(sha) })
  }
  return out.slice(0, 50)
}

// ---------- a folder going up from the page (folders/service.js uploadMany — a dropped folder, 「폴더 올리기」) ----------
// One request of such an upload (POST /folders/:slug/files/batch — routes/folders.js): its files at most, their bytes together (one file
// over the size limit is refused anyway, so a request carries at most that much), and a path's bytes. One upload (a drop — its
// session) may carry the limits of a champion folder's push: headMaxFiles files and pushMaxBytes bytes.
export const BATCH = { files: 1000, bytes: LIMITS.largeFileBytes, pathBytes: 1024, metaBytes: 64 * 1024,
  uploadFiles: LIMITS.headMaxFiles, uploadBytes: LIMITS.pushMaxBytes || 200 * 1024 * 1024 }
// What the page needs to leave out the same files before anything is sent (src/folderDrop.js): the groups' names (the same groupOf),
// the limits, and the shapes the server refuses (level 'block' — the token formats, never a value). The page reads no other rule.
export function pageRules() {
  return {
    version: SHAPES.version || 1,
    groups: Object.fromEntries(ORDER.map((g) => [g, SHAPES.groups[g]])),
    limits: { largeFileBytes: LIMITS.largeFileBytes, pushMaxBytes: BATCH.uploadBytes, headMaxFiles: BATCH.uploadFiles, textMaxBytes: TEXT_MAX,
      batchFiles: BATCH.files, batchBytes: BATCH.bytes, pathBytes: BATCH.pathBytes },
    block: (SHAPES.shapes || []).filter((s) => s.level === 'block' && s.pattern).map((s) => ({ id: s.id, pattern: s.pattern, flags: s.flags || '' })),
  }
}
// Why one uploaded file is not kept, or null: a secret's file name, git's control files (.gitmodules · .lfsconfig · .gitattributes ·
// .gitignore), a file over the size limit, or a key of a sure shape in its text → {reason, line} (reason: 'name' · structureOf's ·
// 'gitattributes' · 'gitignore' · 'large' · the shape id). A folder's git attributes are the server's own, and what goes into a folder
// is decided by whoever writes to it: an upload changes neither.
export function refusalOf(rel, buf) {
  if (groupOf(rel) === 'secret') return { reason: 'name', line: null }
  const s = structureOf({ path: rel }) || attributesOf(rel) || ignoreFileOf(rel)
  if (s) return { reason: s, line: null }
  if (buf.length > LIMITS.largeFileBytes) return { reason: 'large', line: null }
  return blockIn(buf)
}
// a .gitattributes anywhere (case as a Mac or Windows reads it) → 'gitattributes' | null
export const attributesOf = (rel) => (baseOf(rel) === '.gitattributes' ? 'gitattributes' : null)
// a .gitignore anywhere → 'gitignore' | null (the page applies a dropped folder's own .gitignore before anything goes up)
export const ignoreFileOf = (rel) => (baseOf(rel) === '.gitignore' ? 'gitignore' : null)
