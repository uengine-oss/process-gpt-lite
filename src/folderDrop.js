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
    headMaxFiles: Number(L.headMaxFiles) || 20000, textMaxBytes: Number(L.textMaxBytes) || 1024 * 1024,
    batchFiles: Number(L.batchFiles) || 1000, batchBytes: Number(L.batchBytes) || Number(L.largeFileBytes) || 50 * 1024 * 1024, pathBytes: Number(L.pathBytes) || 1024 }
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
// git's control files, its attributes and ignore files: never a file of a folder that goes up from here (the server refuses them too —
// secrets.js refusalOf). A dropped folder's own .gitignore is read and applied here (below), then stays here itself.
const STRUCTURE = new Set(['.gitmodules', '.lfsconfig', '.gitattributes', '.gitignore'])
// (as Windows and a Mac read a name: case aside, trailing dots and spaces dropped — the server's secrets.js reads it so)
export const structureOf = (rel) => (STRUCTURE.has(String(rel).split('/').pop().trim().toLowerCase().replace(/[. ]+$/, '')) ? 'structure' : null)

// ---------- the folder's own .gitignore ----------
// What a folder's .gitignore files leave out, read the way git reads them (as the desktop's 「내 PC 폴더 올리기」 does with git itself):
// a pattern per line (# comments, a leading ! brings back, a trailing / only folders, a / at the start or inside ties it to the
// .gitignore's folder, else it matches a name at any depth below; * ? [..] within a name, ** across folders), the deeper file and the
// later line win; nothing inside a left-out folder comes back (the walk does not go into it).
// → [{re, neg, dir}] for one .gitignore
export function ignoreRules(text) {
  const out = []
  for (let line of String(text || '').split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue
    line = line.replace(/(?<!\\)\s+$/, '')
    if (!line) continue
    let neg = false
    if (line.startsWith('!')) { neg = true; line = line.slice(1) } else if (line.startsWith('\\!') || line.startsWith('\\#')) line = line.slice(1)
    let dir = false
    if (line.endsWith('/')) { dir = true; line = line.replace(/\/+$/, '') }
    if (!line) continue
    const anchored = line.includes('/')
    if (line.startsWith('/')) line = line.slice(1)
    out.push({ re: new RegExp(`^${anchored ? '' : '(?:.*/)?'}${globRe(line)}$`), neg, dir })
  }
  return out
}
function globRe(g) {
  let re = ''
  for (let i = 0; i < g.length; i++) {
    const c = g[i]
    if (c === '*' && g[i + 1] === '*') {
      const before = i === 0 || g[i - 1] === '/', after = i + 2 === g.length || g[i + 2] === '/'
      if (before && after) { re += i + 2 === g.length ? '.*' : '(?:.*/)?'; i += 2; continue }
    }
    if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else if (c === '\\' && i + 1 < g.length) re += `\\${g[++i]}`
    else if (c === '[') {
      const j = g.indexOf(']', i + 2)
      if (j < 0) { re += '\\['; continue }
      let body = g.slice(i + 1, j)
      if (body[0] === '!') body = `^${body.slice(1)}`
      re += `[${body.replace(/\\/g, '\\\\')}]`
      i = j
    } else re += c.replace(/[.+^${}()|\]\\]/g, '\\$&')
  }
  return re
}
// left out by the .gitignore files on its way (stack: [{base, rules}] from the top folder down) → true · false
export function ignoredBy(stack, rel, isDir) {
  let hit = false
  for (const { base, rules } of stack) {
    if (base && !rel.startsWith(`${base}/`)) continue
    const sub = base ? rel.slice(base.length + 1) : rel
    for (const r of rules) if ((!r.dir || isDir) && r.re.test(sub)) hit = !r.neg
  }
  return hit
}

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
// what a stopped walk, look or upload throws (「그만두기」, the sheet closed, the page left)
export const abortError = () => Object.assign(new Error('그만뒀어요'), { name: 'AbortError' })

// Walk what was dropped: every file below, with its path from the drop (a dropped folder's name first), but never into git's data or a
// folder the rules leave out whole (counted as one place each). At most `max` files are read — more is said, not counted.
// → {roots: [{name, dir}], files: [{rel, file}], pruned: [{rel, group}], unreadable: [rel], truncated, git: {remote, worktree} | null}
export async function walk(entries, rules, { max = 40000, onProgress, signal } = {}) {
  const out = { roots: entries.map((e) => ({ name: e.name, dir: !!e.isDirectory })), files: [], pruned: [], unreadable: [], truncated: false, git: null }
  let seen = 0
  let dirs = 0
  // (a folder that leads back into itself — a link the browser follows — ends at a depth no real folder has, or at the folder count)
  const one = async (entry, depth, stack) => {
    if (out.truncated) return
    if (signal?.aborted) throw abortError()
    const rel = relOf(entry)
    if (entry.isDirectory) {
      const g = dirGroupOf(rel, rules) || (ignoredBy(stack, rel, true) ? 'gitignore' : null)
      if (g) { out.pruned.push({ rel, group: g }); return }
      if (depth > MAX_DEPTH) { out.unreadable.push(rel); return }
      if (++dirs > max) { out.truncated = true; return }
      const kids = []
      const reader = entry.createReader()
      for (;;) {
        let batch
        try { batch = await readBatch(reader) } catch { out.unreadable.push(rel); return }
        if (!batch.length) break
        kids.push(...batch)
      }
      // this folder's own .gitignore, for what is below it
      const gi = kids.find((k) => k.isFile && k.name === '.gitignore')
      const below = gi ? [...stack, { base: rel, rules: ignoreRules(await textOf(gi)) }] : stack
      for (const child of kids) { await one(child, depth + 1, below); if (out.truncated) return }
      return
    }
    if (!entry.isFile) return
    if (ignoredBy(stack, rel, false)) { out.pruned.push({ rel, group: 'gitignore', file: true }); return }
    if (out.files.length >= max) { out.truncated = true; return }
    try { out.files.push({ rel, file: await fileOf(entry) }) } catch { out.unreadable.push(rel) }
    if (++seen % 200 === 0) onProgress?.(seen)
  }
  for (const e of entries) {
    // a dropped folder that is a git repository: where its remote is (git's own config — the page reads the address only)
    if (e.isDirectory && !out.git) out.git = await gitOf(e)
    await one(e, 0, [])
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
// name first), git's data, the folders the rules leave out whole and what the folder's .gitignore files leave out taken apart here (the
// browser hands every file over)
export async function fromPicked(fileList, rules) {
  const out = { roots: [], files: [], pruned: [], unreadable: [], truncated: false, git: null }
  const list = [...(fileList || [])].map((f) => ({ f, rel: String(f.webkitRelativePath || f.name || '').replace(/^\/+/, '') }))
  // the .gitignore files and their folders (read first: a folder's rules apply to all below it)
  const ignores = new Map()
  for (const { f, rel } of list) {
    if (rel.split('/').pop() !== '.gitignore') continue
    const base = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
    try { ignores.set(base, ignoreRules(await f.slice(0, 64 * 1024).text())) } catch { /* unreadable: no rules */ }
  }
  const roots = new Set()
  const prunedAt = new Set()
  for (const { f, rel } of list) {
    const segs = rel.split('/')
    if (segs.length > 1 && !roots.has(segs[0])) { roots.add(segs[0]); out.roots.push({ name: segs[0], dir: true }) }
    // the first folder on its path the walk would not have gone into, with the .gitignore files above each one
    let cut = null
    const stack = ignores.has(segs[0]) && segs.length > 1 ? [{ base: segs[0], rules: ignores.get(segs[0]) }] : []
    for (let i = 1; i < segs.length - 1 && !cut; i++) {
      const d = segs.slice(0, i + 1).join('/')
      const g = dirGroupOf(d, rules) || (ignoredBy(stack, d, true) ? 'gitignore' : null)
      if (g) cut = { rel: d, group: g }
      else if (ignores.has(d)) stack.push({ base: d, rules: ignores.get(d) })
    }
    if (cut) {
      if (cut.group === 'git' && cut.rel.split('/').length === 2) out.git ||= { remote: '', worktree: false }
      if (!prunedAt.has(cut.rel)) { prunedAt.add(cut.rel); out.pruned.push(cut) }
      continue
    }
    if (ignoredBy(stack, rel, false)) { out.pruned.push({ rel, group: 'gitignore', file: true }); continue }
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
  // (a folder left out whole is one place; a file the folder's .gitignore leaves out is a file)
  for (const p of scan.pruned) { if (p.file) add(p.group, p.rel); else (places[p.group] ||= []).push(`${p.rel}/`) }
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
    // (the path as the server keeps it: one Unicode form; a path longer than one request carries stays here)
    const path = pathOf(rel).normalize('NFC')
    if (utf8.encode(path).length > (rules.limits.pathBytes || 1024)) { add('long', rel); continue }
    const t = topOf(rel)
    const row = topRow(t)
    row.files++; row.bytes += size
    if (row.out) continue
    up.push({ rel, path, size, file })
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
export async function shapesIn(up, rules, { onProgress, signal } = {}) {
  if (!rules.block.length) return []
  const out = []
  let n = 0
  for (const u of up) {
    if (signal?.aborted) throw abortError()
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
// One request (server lib/folders/batchBody.js — read as it arrives, within its limits): at most limits.batchFiles files and
// limits.batchBytes bytes of them (a file over largeFileBytes never goes, so one file alone always fits).
export function batchesOf(up, { files = 1000, bytes = 50 * 1024 * 1024 } = {}) {
  const out = []
  let cur = [], size = 0
  for (const u of up) {
    if (cur.length && (cur.length >= files || size + u.size > bytes)) { out.push(cur); cur = []; size = 0 }
    cur.push(u); size += u.size
  }
  if (cur.length) out.push(cur)
  return out
}
const utf8 = new TextEncoder()
const MAGIC = utf8.encode('PGLB1\n')
// the body of one request: "PGLB1\n" · u32 meta length · meta JSON · per file u16 path length · path · u32 size · its bytes (a Blob: the
// browser reads each file as it sends it)
export function batchBody(batch, meta) {
  const m = utf8.encode(JSON.stringify({ ...meta, count: batch.length }))
  const head = new Uint8Array(MAGIC.length + 4 + m.length)
  head.set(MAGIC); new DataView(head.buffer).setUint32(MAGIC.length, m.length); head.set(m, MAGIC.length + 4)
  const parts = [head]
  for (const u of batch) {
    const p = utf8.encode(u.path)
    const h = new Uint8Array(2 + p.length + 4)
    const dv = new DataView(h.buffer)
    dv.setUint16(0, p.length); h.set(p, 2); dv.setUint32(2 + p.length, u.size)
    parts.push(h, u.file)
  }
  return new Blob(parts, { type: 'application/x-pgl-batch' })
}
// an id for one upload (the server counts its requests together against one upload's limits)
export function sessionId() {
  const b = new Uint8Array(12)
  globalThis.crypto.getRandomValues(b)
  return [...b].map((x) => x.toString(36).padStart(2, '0')).join('').slice(0, 20)
}
// The plan's files to the folder, request by request (each one commit) → {written, refused: [{path, reason, line}]}. A failure or a stop
// part way throws with what went up before it (err.written · err.refused).
// send(batch, meta, signal): the folders API (foldersApi.js uploadBatch) · onProgress(done, total) · limits: rules.limits ·
// signal: stops at once (the request on its way too — the sheet closed, the page left) · stopAfter(): true when the person pressed
// 「그만두기」 — the request on its way finishes and is counted, no next one goes
export async function sendPlan(plan, { label, send, onProgress, signal, stopAfter, limits = {} } = {}) {
  const parts = batchesOf(plan.up, { files: limits.batchFiles, bytes: limits.batchBytes })
  const session = sessionId()
  let written = 0
  const refused = []
  for (let i = 0; i < parts.length; i++) {
    try {
      if (signal?.aborted || (i > 0 && stopAfter?.())) throw abortError()
      const r = await send(parts[i], { label, part: i + 1, parts: parts.length, session }, signal)
      written += (r?.written || []).length
      refused.push(...(r?.refused || []))
    } catch (e) { throw Object.assign(signal?.aborted ? abortError() : e, { written, refused }) }
    onProgress?.(parts.slice(0, i + 1).reduce((a, b) => a + b.length, 0), plan.up.length)
  }
  // (stopped while the last request was on its way: everything went up — said as done)
  return { written, refused }
}
