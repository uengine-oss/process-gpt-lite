// What the team assist and the meeting helper may offer (decision 2, 2026-11-21): the options the judge
// picks from are skill descriptions, not a constant in the code. Every SKILL.md under skills/ whose
// frontmatter has `metadata.offer` naming a surface is one option there:
//   team     a message in a team room (lib/team/assist.js)
//   meeting  a line said in a meeting (lib/meetings/intent.js)
//   minutes  an action item in the minutes (lib/meetings/minutes.js)
// `description` (Korean) / `metadata.description_en` is what the judge reads, `metadata.work` the key a
// suggestion keeps (pro_room_suggestions.work), `badge`/`title` what its card shows until the model
// writes a title. Swapping the catalog is adding, editing or removing such a skill — no code change.
import fs from 'node:fs'
import path from 'node:path'
import { REPO_ROOT } from './paths.js'
import { isEn } from './lang.js'

export const SKILLS_DIR = () => process.env.PRO_OFFER_SKILLS_DIR || path.join(REPO_ROOT, 'skills')
// skill packs are installed per company (lib/skillInstall.js): their offers come with the install
const SKIP_DIRS = new Set(['packs', 'node_modules'])

// ---- frontmatter (format: the YAML subset our SKILL.md files use) ----
const scalar = (v) => {
  const t = String(v).trim()
  if (t.startsWith('"') && t.endsWith('"')) { try { return JSON.parse(t) } catch { return t.slice(1, -1) } }
  if (t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1).replace(/''/g, "'")
  if (t.startsWith('[') && t.endsWith(']')) return t.slice(1, -1).split(',').map((x) => scalar(x)).filter((x) => x !== '')
  return t
}
export function frontmatter(md) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(md || ''))
  if (!m) return {}
  const out = {}
  let parent = null
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^(\s*)([A-Za-z_][\w-]*):\s*(.*)$/.exec(line)
    if (!kv) continue
    const [, indent, key, value] = kv
    if (!indent) {
      if (value === '') { parent = out[key] = {}; continue }
      parent = null; out[key] = scalar(value)
    } else if (parent) parent[key] = scalar(value)
  }
  return out
}

function skillFiles(dir, out = []) {
  let entries = []
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) skillFiles(p, out)
    else if (e.name === 'SKILL.md') out.push(p)
  }
  return out
}

let cache = { at: 0, dir: null, list: [] }
const TTL_MS = 30_000
export function catalog() {
  const dir = SKILLS_DIR()
  if (cache.dir === dir && Date.now() - cache.at < TTL_MS) return cache.list
  const list = []
  for (const file of skillFiles(dir)) {
    const fm = frontmatter(fs.readFileSync(file, 'utf8'))
    const meta = fm.metadata || {}
    const surfaces = Array.isArray(meta.offer) ? meta.offer : meta.offer ? [meta.offer] : []
    if (!surfaces.length || !fm.name || !fm.description) continue
    list.push({
      name: fm.name, key: meta.work || `skill:${fm.name}`, surfaces,
      description: fm.description, descriptionEn: meta.description_en || fm.description,
      badge: meta.badge || fm.name, badgeEn: meta.badge_en || meta.badge || fm.name,
      title: meta.title || fm.name, titleEn: meta.title_en || meta.title || fm.name,
    })
  }
  list.sort((a, b) => a.name.localeCompare(b.name))
  cache = { at: Date.now(), dir, list }
  return list
}
export const _reload = () => { cache = { at: 0, dir: null, list: [] } }

// the options of one surface, in the reader's language: [{key, label, badge, title, name}]
export function offers(surface) {
  const en = isEn()
  return catalog().filter((o) => o.surfaces.includes(surface))
    .map((o) => ({ key: o.key, name: o.name, label: en ? o.descriptionEn : o.description, badge: en ? o.badgeEn : o.badge, title: en ? o.titleEn : o.title }))
}
export function offerOf(key) {
  const o = catalog().find((x) => x.key === key)
  if (!o) return null
  const en = isEn()
  return { key: o.key, name: o.name, label: en ? o.descriptionEn : o.description, badge: en ? o.badgeEn : o.badge, title: en ? o.titleEn : o.title }
}
