// A folder's agent assets (에이전트 자산 — champion folders, spec openspec/specs/champion-folders): the skills, commands, instructions,
// rules and specs the agent platforms keep in a folder (Claude Code's .claude/skills · CLAUDE.md, Codex's AGENTS.md, Cursor's rules, …).
// Found by WHERE a file is in main — the places are data (kit-places.json, the same file the desktop app's preview reads) — never by what
// its text means; a Markdown file's name and description come from its YAML front matter (read like a SKILL.md everywhere else in Lite).
// Run after main moves (indexer.reindex); kept in pro_folder_kit (sql/059) for the folder screen's 「에이전트 자산」 tab.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { q } from '../supa.js'
import * as G from './git.js'
import { summarizeSkill } from '../skills.js'

const here = path.dirname(fileURLToPath(import.meta.url))
export const PLACES = JSON.parse(fs.readFileSync(path.join(here, 'kit-places.json'), 'utf8'))
const PLATFORM_ORDER = new Map(Object.keys(PLACES.platforms || {}).map((p, i) => [p, i]))
const TYPE_ORDER = new Map(['skill', 'command', 'agent', 'prompt', 'rules', 'instructions', 'settings', 'mcp', 'spec', 'change'].map((t, i) => [t, i]))
const READ_MAX = 256 * 1024
const LIMIT = 500

// ---------- the path patterns (kit-places.json) ----------
// '/'-separated; '**' = zero or more whole folders; in any other part '*' = any run of characters but '/' (a pattern starts at the
// folder's root unless it starts with '**/'). Matched part by part.
const segRe = new Map()
function segment(pat, s) {
  if (!pat.includes('*')) return pat === s
  let re = segRe.get(pat)
  if (!re) {
    re = new RegExp(`^${pat.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`)
    segRe.set(pat, re)
  }
  return re.test(s)
}
export function matchGlob(pattern, rel) {
  const p = String(pattern).split('/').filter(Boolean)
  const s = String(rel).split('/').filter(Boolean)
  const go = (i, j) => {
    if (i === p.length) return j === s.length
    if (p[i] === '**') {
      for (let k = j; k <= s.length; k++) if (go(i + 1, k)) return true
      return false
    }
    return j < s.length && segment(p[i], s[j]) && go(i + 1, j + 1)
  }
  return go(0, 0)
}

// ---------- one file → one item ----------
export const placeOf = (rel) => PLACES.places.find((pl) => matchGlob(pl.glob, rel)) || null
const isText = (buf) => !buf.subarray(0, 8000).includes(0)
const clip = (s, n = 300) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t }
// 'dir': the folder the file is in (a skill) · 'command': its path under the commands folder, ':' between folders, no extension (how
// Claude Code calls it: /opsx:apply) · 'file': the file's name
function nameOf(place, rel) {
  const segs = rel.split('/')
  if (place.name === 'dir') return segs[segs.length - 2] || segs[segs.length - 1]
  if (place.name === 'command') {
    const under = place.base && rel.startsWith(`${place.base}/`) ? rel.slice(place.base.length + 1) : segs[segs.length - 1]
    return under.replace(/\.[^./]+$/, '').split('/').join(':')
  }
  return segs[segs.length - 1]
}
// a JSON key path ('permissions.allow') there and not empty
function hasKey(obj, dotted) {
  let v = obj
  for (const k of String(dotted).split('.')) { if (!v || typeof v !== 'object') return false; v = v[k] }
  if (v == null || v === false || v === '') return false
  if (Array.isArray(v)) return v.length > 0
  if (typeof v === 'object') return Object.keys(v).length > 0
  return true
}
// a skill · command · agent's front matter (YAML between the first two '---' lines): which of the keys that make it run things by itself
// (kit-places.json frontMatterRuns — hooks, allowed-tools, …) it names. Read conservatively for a badge: a key of that name anywhere in the
// front matter, at any depth or in a flow mapping, counts (the desktop, which leaves them off, reads the front matter as YAML —
// desktop/src/runner/runSettings.js).
export function frontRuns(text) {
  const md = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  if (!md.startsWith('---\n')) return []
  const end = md.slice(4).search(/^(---|\.\.\.)[ \t]*$/m)
  const block = end < 0 ? md.slice(4) : md.slice(4, 4 + end)
  const keys = new Set()
  for (const m of block.matchAll(/(?:^|[\s{,])["']?([A-Za-z][\w-]*)["']?[ \t]*:(?=\s|$)/gm)) keys.add(m[1])
  return (PLACES.frontMatterRuns || []).filter((k) => keys.has(k))
}
// runs: the place says so; for a JSON settings file with runsKeys, only when one of those keys is there and not empty; for a skill ·
// command · agent (frontRuns), when its front matter names a key that runs things
function runsOf(place, text) {
  if (place.frontRuns && text != null && frontRuns(text).length) return true
  if (!place.runs) return false
  if (!Array.isArray(place.runsKeys)) return true
  if (text == null) return true
  let j
  try { j = JSON.parse(text) } catch { return false }
  return place.runsKeys.some((k) => hasKey(j, k))
}
// the file's text (null: not read) → {platform, type, path, name, description, runs}
export function itemOf(place, rel, text = null) {
  const item = { platform: place.platform, type: place.type, path: rel, name: nameOf(place, rel), description: null, runs: runsOf(place, null) }
  if (text == null) return item
  const md = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  if (place.frontMatter && md.startsWith('---\n')) {
    const s = summarizeSkill(md)
    if (s.name) item.name = clip(s.name, 120)
    if (s.description) item.description = clip(s.description)
  }
  // an instructions file (CLAUDE.md · AGENTS.md · …): its first heading, when it has one
  if (!item.description && ['instructions', 'rules', 'spec', 'change', 'prompt', 'command', 'agent'].includes(place.type)) {
    const body = md.startsWith('---\n') ? md.replace(/^---\n[\s\S]*?\n---\n?/, '') : md
    const h = /^#{1,3}\s+(.+)$/m.exec(body)
    if (h) item.description = clip(h[1].replace(/[*_`]/g, ''), 200)
  }
  item.runs = runsOf(place, md)
  return item
}

// ---------- a folder's main ----------
// files: main's [{path, sha, size}] (indexer.reindex has them already); a file whose blob did not change since the last pass is not read again
export async function discover(folder, files = null) {
  if (!folder || folder.kind === 'linked') return []
  const list = files || await G.lsTree(folder.repo_path, folder.default_branch)
  const found = []
  for (const f of list) {
    const place = placeOf(f.path)
    if (place) found.push({ f, place })
    if (found.length >= LIMIT) break
  }
  const old = new Map((await q('select path, sha, name, description, runs, platform, type from pro_folder_kit where folder_id=$1', [folder.id])).map((r) => [r.path, r]))
  const keep = new Set()
  const out = []
  for (const { f, place } of found) {
    keep.add(f.path)
    const was = old.get(f.path)
    // (a skill · command · agent kept as not running is read again: rows from before its front matter was read for run keys — frontRuns)
    if (was && was.sha === f.sha && was.platform === place.platform && was.type === place.type && (!place.frontRuns || was.runs)) { out.push({ ...was, path: f.path }); continue }
    let text = null
    if ((place.frontMatter || place.runsKeys || ['instructions', 'rules', 'spec', 'change', 'prompt', 'command', 'agent'].includes(place.type)) && Number(f.size) <= READ_MAX) {
      const buf = await G.git(folder.repo_path, ['cat-file', 'blob', f.sha], { buffer: true }).catch(() => null)
      if (buf && isText(buf)) text = buf.toString('utf8')
    }
    const item = itemOf(place, f.path, text)
    await q(`insert into pro_folder_kit (folder_id, path, platform, type, name, description, sha, runs, updated_at) values ($1,$2,$3,$4,$5,$6,$7,$8,now())
             on conflict (folder_id, path) do update set platform=$3, type=$4, name=$5, description=$6, sha=$7, runs=$8, updated_at=now()`,
    [folder.id, f.path, item.platform, item.type, item.name, item.description, f.sha, item.runs])
    out.push({ ...item, sha: f.sha })
  }
  const gone = [...old.keys()].filter((p) => !keep.has(p))
  if (gone.length) await q('delete from pro_folder_kit where folder_id=$1 and path = any($2::text[])', [folder.id, gone])
  return sortKit(out)
}

export const sortKit = (rows) => [...rows].sort((a, b) => (PLATFORM_ORDER.get(a.platform) ?? 99) - (PLATFORM_ORDER.get(b.platform) ?? 99)
  || (TYPE_ORDER.get(a.type) ?? 99) - (TYPE_ORDER.get(b.type) ?? 99) || String(a.path).localeCompare(String(b.path)))

// what the folder screen shows (GET /api/folders/:slug/kit)
export async function kitOf(folder) {
  const rows = await q('select path, platform, type, name, description, runs from pro_folder_kit where folder_id=$1', [folder.id])
  return sortKit(rows).map(({ path: p, platform, type, name, description, runs }) => ({ platform, type, path: p, name, description, runs }))
}
// counts per type, for a folder's card (「스킬 6 · 명령 4 · 스펙 12」)
export async function kitCounts(folderIds) {
  const ids = [...new Set((folderIds || []).map(String))]
  const out = new Map()
  if (!ids.length) return out
  for (const r of await q('select folder_id::text as f, type, count(*)::int as n from pro_folder_kit where folder_id = any($1::uuid[]) group by 1, 2', [ids])) {
    if (!out.has(r.f)) out.set(r.f, {})
    out.get(r.f)[r.type] = r.n
  }
  return out
}
