// 폴더를 끌어다 놓아 올리기 (spec openspec/specs/champion-folders 「컴퓨터의 폴더를 끌어다 놓아 올린다」): a folder of the person's
// computer — dropped on a folder's files (Finder · Explorer), dropped on the folder list (a new folder by its name), or picked with
// 「폴더 올리기」 — goes up to a Lite folder's main once, with its paths inside it. Nothing stays linked to the computer (that is the
// desktop app's 「내 PC 폴더로 공유」 — champion folders, src/desktopFolders.js).
// Before anything goes up a sheet (components/folders/FolderDropSheet.vue) shows how many files, how big, and what stays here and why —
// by the champion folders' own rules (server lib/folders/secret-shapes.json, through GET /api/folders/upload-rules — secrets.js
// pageRules): git's data (.git), secrets, personal settings, what can be rebuilt (node_modules …), git's control files, files over the
// size limit, and text with a key of a sure shape (its line and the shape's name only, never the value). Over one upload's limits (files ·
// bytes) nothing goes until the biggest parts are left out — the sheet says which. The server looks again at what arrives
// (folders/service.js uploadMany).
// Nothing here touches the page: the walk, the rules and the plan are plain functions (test/folderDrop.test.js).

// ---------- the rules ----------
// raw: GET /api/folders/upload-rules → {groups: {secret|personal|rebuildable: {names, prefixes, extensions, dirs, paths, dirPaths, keep}},
// limits: {largeFileBytes, pushMaxBytes, headMaxFiles, textMaxBytes}, block: [{id, pattern, flags}]}
const low = (a) => (Array.isArray(a) ? a.map((x) => String(x).toLowerCase()) : [])
export function compileRules(raw = {}) {
  const groups = {}
  for (const [g, r] of Object.entries(raw.groups || {})) {
    if (!r) continue
    groups[g] = { names: new Set(low(r.names)), prefixes: low(r.prefixes), extensions: low(r.extensions), dirs: new Set(low(r.dirs)),
      paths: low(r.paths), dirPaths: low(r.dirPaths), keep: new Set(low(r.keep)) }
  }
  const block = []
  for (const s of raw.block || []) { try { block.push({ id: String(s.id), re: new RegExp(s.pattern, s.flags || '') }) } catch { /* a shape this browser cannot read */ } }
  const L = raw.limits || {}
  const limits = { largeFileBytes: Number(L.largeFileBytes) || 50 * 1024 * 1024, pushMaxBytes: Number(L.pushMaxBytes) || 200 * 1024 * 1024,
    headMaxFiles: Number(L.headMaxFiles) || 20000, textMaxBytes: Number(L.textMaxBytes) || 1024 * 1024 }
  return { groups, order: ['secret', 'personal', 'rebuildable'].filter((g) => groups[g]), limits, block }
}

// the group a file's path falls in by its names — the same reading as the server's (lib/folders/secrets.js groupOf) and the desktop's:
// any case, every part of the path, a folder of the group leaves out all that is in it → 'secret' | 'personal' | 'rebuildable' | null
export function groupOf(rel, rules) {
  const segs = String(rel).toLowerCase().split('/').filter(Boolean)
  const full = segs.join('/')
  for (const g of rules.order) {
    const r = rules.groups[g]
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
// a folder not walked into at all: git's own data → 'git', or a group every file in it would fall in (node_modules, .ssh …)
export function dirGroupOf(relDir, rules) {
  const name = String(relDir).split('/').pop()
  if (name.toLowerCase() === '.git') return 'git'
  // (a name no rule has, inside it: what the folder itself makes every file of it)
  return groupOf(`${relDir}/\u0000`, rules)
}
// git's control files: never a file of a folder (the server refuses them too — secrets.js structureOf)
const STRUCTURE = new Set(['.gitmodules', '.lfsconfig'])
export const structureOf = (rel) => (STRUCTURE.has(String(rel).split('/').pop().toLowerCase()) ? 'structure' : null)

// ---------- what was dropped ----------
// The entries of a drop, read while the drop event lasts (a DataTransfer's items are gone once it returns): a folder or a file of the
// computer each. A browser without entries gives the plain files (a folder among them cannot be read — it is said).
export function entriesOf(dt) {
  const out = []
  const items = [...(dt?.items || [])].filter((it) => it.kind === 'file')
  for (const it of items) {
    const e = typeof it.webkitGetAsEntry === 'function' ? it.webkitGetAsEntry() : null
    if (e) out.push(e)
    else { const f = it.getAsFile?.(); if (f) out.push({ isFile: true, isDirectory: false, name: f.name, fullPath: `/${f.name}`, plain: f }) }
  }
  if (!out.length) for (const f of dt?.files || []) out.push({ isFile: true, isDirectory: false, name: f.name, fullPath: `/${f.name}`, plain: f })
  return out
}
// whether a drag carries a folder of the computer (dragover can see only kinds, not names: a drop decides)
export const hasEntries = (dt) => [...(dt?.items || [])].some((it) => it.kind === 'file')

const readBatch = (reader) => new Promise((res, rej) => reader.readEntries(res, rej))
const fileOf = (entry) => (entry.plain ? Promise.resolve(entry.plain) : new Promise((res, rej) => entry.file(res, rej)))
const textOf = (entry) => new Promise((res) => entry.file((f) => f.slice(0, 64 * 1024).text().then(res, () => res('')), () => res('')))
const relOf = (entry) => String(entry.fullPath || entry.name || '').replace(/^\/+/, '')
const MAX_DEPTH = 40

// Walk what was dropped: every file below, with its path from the drop (a dropped folder's name first), but never into git's data or a
// folder the rules leave out whole (counted as one place each). At most `max` files are read — more is said, not counted.
// → {roots: [{name, dir}], files: [{rel, file}], pruned: [{rel, group}], unreadable: [rel], truncated, git: {remote, worktree} | null}
export async function walk(entries, rules, { max = 40000, onProgress } = {}) {
  const out = { roots: entries.map((e) => ({ name: e.name, dir: !!e.isDirectory })), files: [], pruned: [], unreadable: [], truncated: false, git: null }
  let seen = 0
  let dirs = 0
  // (a folder that leads back into itself — a link the browser follows — ends at a depth no real folder has, or at the folder count)
  const one = async (entry, depth = 0) => {
    if (out.truncated) return
    const rel = relOf(entry)
    if (entry.isDirectory) {
      const g = dirGroupOf(rel, rules)
      if (g) { out.pruned.push({ rel, group: g }); return }
      if (depth > MAX_DEPTH) { out.unreadable.push(rel); return }
      if (++dirs > max) { out.truncated = true; return }
      const reader = entry.createReader()
      for (;;) {
        let batch
        try { batch = await readBatch(reader) } catch { out.unreadable.push(rel); return }
        if (!batch.length) break
        for (const child of batch) { await one(child, depth + 1); if (out.truncated) return }
      }
      return
    }
    if (!entry.isFile) return
    if (out.files.length >= max) { out.truncated = true; return }
    try { out.files.push({ rel, file: await fileOf(entry) }) } catch { out.unreadable.push(rel) }
    if (++seen % 200 === 0) onProgress?.(seen)
  }
  for (const e of entries) {
    // a dropped folder that is a git repository: where its remote is (git's own config — the page reads the address only)
    if (e.isDirectory && !out.git) out.git = await gitOf(e)
    await one(e)
  }
  onProgress?.(out.files.length)
  return out
}
// a dropped folder's .git: a folder (a repository — its config's first remote) or a file (a work tree of a repository elsewhere)
async function gitOf(dirEntry) {
  if (typeof dirEntry.getDirectory !== 'function') return null
  const get = (kind, p) => new Promise((res) => dirEntry[kind](p, {}, res, () => res(null)))
  const dir = await get('getDirectory', '.git')
  if (dir) {
    const cfg = await get('getFile', '.git/config')
    return { remote: cfg ? remoteOf(await textOf(cfg)) : '', worktree: false }
  }
  return (await get('getFile', '.git')) ? { remote: '', worktree: true } : null
}
// the first remote's address in a git config, without any name or password in it: 「github.com/org/repo」
// (origin's when there is one)
export function remoteOf(text) {
  let remote = null, first = '', origin = ''
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('[')) { const m = /^\[remote\s+"([^"]*)"\]$/.exec(line); remote = m ? m[1] : null; continue }
    const m = remote !== null && /^url\s*=\s*(.+)$/i.exec(line)
    if (!m) continue
    if (!first) first = m[1].trim()
    if (remote === 'origin' && !origin) origin = m[1].trim()
  }
  const url = origin || first
  return url ? cleanRemote(url) : ''
}
export function cleanRemote(url) {
  let u = String(url).trim()
  u = u.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')     // scheme
  u = u.replace(/^[^@/]*@/, '')                     // name · password · token before the host
  u = u.replace(/\.git\/?$/i, '').replace(/\/+$/, '')
  return u.slice(0, 200)
}

// 「폴더 올리기」 (an input with webkitdirectory): the same as a drop of that folder — its files with their paths from it (the folder's
// name first), git's data and the folders the rules leave out whole taken apart here (the browser hands every file over)
export function fromPicked(fileList, rules) {
  const out = { roots: [], files: [], pruned: [], unreadable: [], truncated: false, git: null }
  const roots = new Set()
  const prunedAt = new Set()
  for (const f of fileList || []) {
    const rel = String(f.webkitRelativePath || f.name || '').replace(/^\/+/, '')
    const segs = rel.split('/')
    if (segs.length > 1 && !roots.has(segs[0])) { roots.add(segs[0]); out.roots.push({ name: segs[0], dir: true }) }
    // the first folder on its path the walk would not have gone into
    let cut = null
    for (let i = 1; i < segs.length - 1 && !cut; i++) {
      const d = segs.slice(0, i + 1).join('/')
      const g = dirGroupOf(d, rules)
      if (g) cut = { rel: d, group: g }
    }
    if (cut) {
      if (cut.group === 'git' && cut.rel.split('/').length === 2) out.git ||= { remote: '', worktree: false }
      if (!prunedAt.has(cut.rel)) { prunedAt.add(cut.rel); out.pruned.push(cut) }
      continue
    }
    out.files.push({ rel, file: f })
  }
  return out
}

// ---------- the plan ----------
// What goes up and what stays, from a walk: `base` is the dropped folder's name when one folder was dropped (its files' tops are its own
// entries); `strip` takes that name off every path (a new folder made from the dropped one holds its contents, not a folder of it);
// `exclude`: tops the person unticked.
// → {up: [{rel, path, size, file}], left: {group: [rel]}, places: {group: [rel]}, tops: [{top, files, bytes, out}], files, bytes, over: [...]}
export function planOf(scan, rules, { strip = false, exclude = new Set(), shapes = [] } = {}) {
  const base = scan.roots.length === 1 && scan.roots[0].dir ? scan.roots[0].name : ''
  const topOf = (rel) => { const s = rel.split('/'); return base && s[0] === base ? (s.length > 2 ? `${s[1]}/` : s[1] || base) : (s.length > 1 ? `${s[0]}/` : s[0]) }
  const pathOf = (rel) => (strip && base && rel.startsWith(`${base}/`) ? rel.slice(base.length + 1) : rel)
  const left = {}
  const add = (g, rel) => { (left[g] ||= []).push(rel) }
  const places = {}
  for (const p of scan.pruned) (places[p.group] ||= []).push(`${p.rel}/`)
  const shapeOf = new Map(shapes.map((h) => [h.rel, h]))
  const tops = new Map()
  const topRow = (t) => { if (!tops.has(t)) tops.set(t, { top: t, files: 0, bytes: 0, out: exclude.has(t) }); return tops.get(t) }
  const up = []
  let bytes = 0
  for (const { rel, file } of scan.files) {
    const size = Number(file?.size) || 0
    const g = groupOf(rel, rules) || structureOf(rel)
    if (g) { add(g, rel); continue }
    if (size > rules.limits.largeFileBytes) { add('large', rel); continue }
    if (shapeOf.has(rel)) { add('shape', rel); continue }
    const t = topOf(rel)
    const row = topRow(t)
    row.files++; row.bytes += size
    if (row.out) continue
    up.push({ rel, path: pathOf(rel), size, file })
    bytes += size
  }
  const over = []
  if (scan.truncated || up.length > rules.limits.headMaxFiles) over.push({ kind: 'files', value: up.length, max: rules.limits.headMaxFiles, more: scan.truncated })
  if (bytes > rules.limits.pushMaxBytes) over.push({ kind: 'bytes', value: bytes, max: rules.limits.pushMaxBytes })
  const topList = [...tops.values()].sort((a, b) => b.bytes - a.bytes || b.files - a.files || a.top.localeCompare(b.top))
  // the biggest tops still going up, by what is over (bytes, else files): what to leave out first — the largest, and up to two more
  // that hold a tenth of it or more
  const by = over.some((o) => o.kind === 'bytes') ? 'bytes' : 'files'
  const total = by === 'bytes' ? bytes : up.length
  const biggest = topList.filter((t) => !t.out).sort((a, b) => b[by] - a[by]).filter((t, i) => i === 0 || t[by] >= total * 0.1).slice(0, 3)
  return { base, up, left, places, shapes: [...shapeOf.values()], tops: topList, files: up.length, bytes, over, biggest }
}
// how many files and places stayed out, all groups together
export function leftCount(plan) {
  return Object.values(plan.left).reduce((a, l) => a + l.length, 0) + Object.values(plan.places).reduce((a, l) => a + l.length, 0)
}

// Keys of a sure shape in the text that would go up (files up to textMaxBytes with no NUL in their start): the shape's id and the line —
// the matched text is not kept. → [{rel, line, reason}]
export async function shapesIn(up, rules, { onProgress } = {}) {
  if (!rules.block.length) return []
  const out = []
  let n = 0
  for (const u of up) {
    if (++n % 100 === 0) onProgress?.(n)
    if (!(u.size > 0) || u.size > rules.limits.textMaxBytes || !u.file?.arrayBuffer) continue
    let bytes
    try { bytes = new Uint8Array(await u.file.arrayBuffer()) } catch { continue }
    if (bytes.subarray(0, 8000).includes(0)) continue
    const lines = new TextDecoder().decode(bytes).split('\n')
    for (let i = 0; i < lines.length; i++) {
      const hit = rules.block.find((s) => s.re.test(lines[i]))
      if (hit) { out.push({ rel: u.rel, line: i + 1, reason: hit.id }); break }
    }
  }
  return out
}

// ---------- sending ----------
// one request's files at most (server folders/service.js BATCH_MAX_FILES) and bytes (under the server's 64 MB body limit, with room for
// the form's own parts)
export const BATCH = { files: 1000, bytes: 32 * 1024 * 1024 }
export function batchesOf(up, { files = BATCH.files, bytes = BATCH.bytes } = {}) {
  const out = []
  let cur = [], size = 0
  for (const u of up) {
    if (cur.length && (cur.length >= files || size + u.size > bytes)) { out.push(cur); cur = []; size = 0 }
    cur.push(u); size += u.size
  }
  if (cur.length) out.push(cur)
  return out
}
// the plan's files to the folder, request by request (each one commit) → {written, refused: [{path, reason, line}]}
// send(batch, meta): the folders API (foldersApi.js uploadBatch) · onProgress(done, total)
export async function sendPlan(plan, { label, send, onProgress } = {}) {
  const parts = batchesOf(plan.up)
  let written = 0
  const refused = []
  for (let i = 0; i < parts.length; i++) {
    const r = await send(parts[i], { label, part: i + 1, parts: parts.length, final: i === parts.length - 1 })
    written += (r?.written || []).length
    refused.push(...(r?.refused || []))
    onProgress?.(parts.slice(0, i + 1).reduce((a, b) => a + b.length, 0), plan.up.length)
  }
  return { written, refused }
}
