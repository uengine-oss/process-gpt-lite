// A prompt skill that comes with Lite (skills/<name>: SKILL.md, rules.json, prompts/*.md) and that a company may change: its own
// version — the skill folder '<name>' (git, main) or an installed tenant skill — wins, and what it leaves out is taken from the
// bundled one. The same rule as the process-discovery skill (lib/ontology/discovery.js), for the smaller skills that keep one
// feature's prompts out of the code (folder-filing: lib/folders/filing.js).
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { config } from '../config.js'

const here = path.dirname(fileURLToPath(import.meta.url))
export const bundledDir = (name) => path.join(here, '..', '..', 'skills', name)

export function readSkillDir(dir) {
  if (!dir || !fs.existsSync(path.join(dir, 'SKILL.md'))) return null
  const h = crypto.createHash('sha1')
  const rulesFile = path.join(dir, 'rules.json')
  const rulesText = fs.existsSync(rulesFile) ? fs.readFileSync(rulesFile, 'utf8') : '{}'
  h.update(rulesText)
  const prompts = {}
  const pdir = path.join(dir, 'prompts')
  for (const f of fs.existsSync(pdir) ? fs.readdirSync(pdir).sort() : []) {
    if (!f.endsWith('.md')) continue
    const t = fs.readFileSync(path.join(pdir, f), 'utf8').replace(/\s+$/, '')
    prompts[f.slice(0, -3)] = t
    h.update(f).update(t)
  }
  return { dir, rules: JSON.parse(rulesText), prompts, version: h.digest('hex').slice(0, 10) }
}

const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x)
export const mergeRules = (base, over) => {
  if (!isObj(base) || !isObj(over)) return over ?? base
  const out = { ...base }
  for (const [k, v] of Object.entries(over)) out[k] = isObj(v) && isObj(base[k]) ? mergeRules(base[k], v) : v
  return out
}

const bundled = new Map()
const cached = new Map() // `${tenant}:${name}` → {at, skill}

// → {name, source: 'bundled'|'folder'|'installed', version, rules, prompts}; a short cache per company
export async function skillPack(name, { dir = null } = {}) {
  const key = `${config.tenantId}:${name}`
  const hit = cached.get(key)
  if (hit && Date.now() - hit.at < 30_000) return hit.skill
  if (!bundled.has(name)) bundled.set(name, readSkillDir(dir || bundledDir(name)))
  const base = bundled.get(name)
  if (!base) throw new Error(`스킬 「${name}」의 기본 판이 없어요(${dir || bundledDir(name)}).`)
  let skill = { name, source: 'bundled', ...base }
  try {
    const { skillFolder, installedDir } = await import('./folders/skills.js')
    const f = await skillFolder(name).catch(() => null)
    for (const [d, source] of [[f?.repo_path, 'folder'], [installedDir(name), 'installed']]) {
      const own = d && readSkillDir(d)
      if (!own) continue
      skill = { name, source, dir: own.dir, version: own.version, rules: mergeRules(base.rules, own.rules), prompts: { ...base.prompts, ...own.prompts } }
      break
    }
  } catch { /* a database or folder error: the bundled version */ }
  cached.set(key, { at: Date.now(), skill })
  return skill
}
export const forgetSkillPacks = () => cached.clear()
