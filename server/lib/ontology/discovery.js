// 프로세스 찾기 스킬(skills/process-discovery): 메일 · 인계 · 문서에서 일과 흐름을 찾는 규칙(rules.json)과 프롬프트(prompts/*.md).
// 회사가 고친 판 — 스킬 폴더 'process-discovery'(git, main) 또는 설치된 테넌트 스킬 — 이 있으면 그것을, 없으면 Lite 와 함께 온
// 기본 판을 읽는다. 회사 판에 없는 프롬프트 · 규칙 값은 기본 판 것을 쓴다. 고치면 다음 읽기 · 다음 셈부터 바뀐다.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

export const NAME = 'process-discovery'
const here = path.dirname(fileURLToPath(import.meta.url))
export const BUNDLED_DIR = process.env.PRO_DISCOVERY_SKILL_DIR || path.join(here, '..', '..', '..', 'skills', NAME)

function readDir(dir) {
  if (!fs.existsSync(path.join(dir, 'SKILL.md'))) return null
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
const merge = (base, over) => {
  if (!isObj(base) || !isObj(over)) return over ?? base
  const out = { ...base }
  for (const [k, v] of Object.entries(over)) out[k] = isObj(v) && isObj(base[k]) ? merge(base[k], v) : v
  return out
}

let bundledCache = null
export function bundled() {
  bundledCache ||= readDir(BUNDLED_DIR)
  if (!bundledCache) throw new Error(`프로세스 찾기 스킬의 기본 판이 없어요(${BUNDLED_DIR}).`)
  return { ...bundledCache, source: 'bundled' }
}

// the company's version (a short cache: a job asks for it many times)
let cached = null
export async function discoverySkill() {
  if (cached && Date.now() - cached.at < 30_000) return cached.skill
  const base = bundled()
  let skill = base
  try {
    const { skillFolder, installedDir } = await import('../folders/skills.js')
    const f = await skillFolder(NAME).catch(() => null)
    for (const [dir, source] of [[f?.repo_path, 'folder'], [installedDir(NAME), 'installed']]) {
      const own = dir && readDir(dir)
      if (!own) continue
      skill = { dir: own.dir, source, version: own.version, rules: merge(base.rules, own.rules), prompts: { ...base.prompts, ...own.prompts }, folderId: source === 'folder' ? f.id : null }
      break
    }
  } catch { /* a database or folder error: the bundled version */ }
  cached = { at: Date.now(), skill }
  return skill
}
export const forgetSkill = () => { cached = null }

export async function prompt(name) {
  const p = (await discoverySkill()).prompts[name]
  if (!p) throw new Error(`프로세스 찾기 스킬에 「${name}」 프롬프트가 없어요.`)
  return p
}
export async function rules() { return (await discoverySkill()).rules }
// what reading a thread depends on (its prompt, what counts as one to read, how much of it, who is inside): a re-read reads
// a thread again only when this changed — not when a form, a period or a naming rule did, nor a filter (a stricter one
// only leaves out mails, and a thread's remaining mails were read)
export function readVersion(skill) {
  const r = skill.rules || {}
  return crypto.createHash('sha1').update(JSON.stringify([skill.prompts['read-thread'] || '', r.readAlone, r.mailbox?.historyTextChars, r.company])).digest('hex').slice(0, 10)
}
// the rules as the bundled version has them, for the code that must not wait (pure functions and their tests)
export const defaultRules = () => bundled().rules
