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

// What the server refuses among pushed files [{path, size}]: a secret's file name, or a key of a sure shape in it.
// read(file): its bytes (called only for a text-sized file) → [{path, line, reason}] (empty: fine)
export async function refusedIn(files, read) {
  const out = []
  for (const f of files) {
    if (groupOf(f.path) === 'secret') { out.push({ path: f.path, line: null, reason: 'name' }); continue }
    if (Number(f.size) > TEXT_MAX) continue
    const buf = await read(f)
    const hit = buf ? blockIn(buf) : null
    if (hit) out.push({ path: f.path, ...hit })
    if (out.length >= 50) break
  }
  return out
}
