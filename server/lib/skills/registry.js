// Action skills (skills/actions/<name>/): what the chat router can choose to have this server do.
// A skill is data — SKILL.md (frontmatter name, description, metadata; the body is read only at the
// second stage) and args.schema.json. It names its handler, its facts and the state it needs; the
// names are checked against this server's tables when the skills are loaded, and a skill that names
// something that does not exist stops the server (docs/mobile-review-1121/skill-routing-design.md 2.2).
import fs from 'node:fs'
import path from 'node:path'

const HERE = path.dirname(new URL(import.meta.url).pathname)
export const ACTIONS_DIR = process.env.PRO_ACTION_SKILLS_DIR || path.resolve(HERE, '../../../skills/actions')

// a function name for the router call ("schedule-run-now" → "schedule_run_now")
export const toolName = (name) => String(name).replace(/-/g, '_')

// ---- frontmatter: the YAML subset the action skills use (scalars, a nested map, flow lists and maps) ----
function scalar(v) {
  const t = v.trim()
  if (t === '') return ''
  if (t === 'true' || t === 'false') return t === 'true'
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t)
  if (/^[[{]/.test(t)) {
    // flow collections: quote the bare words, then it is JSON
    const json = t.replace(/"(?:[^"\\]|\\.)*"|[A-Za-z_][\w.-]*/g, (w) => (w.startsWith('"') || w === 'true' || w === 'false' || w === 'null' ? w : `"${w}"`))
    return JSON.parse(json)
  }
  if (/^(["']).*\1$/.test(t)) return t.slice(1, -1)
  return t
}
export function parseSkillMd(md) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(String(md || ''))
  if (!m) throw new Error('no frontmatter')
  const head = {}
  let block = null
  for (const line of m[1].split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    const kv = /^(\s*)([\w-]+):\s?(.*)$/.exec(line)
    if (!kv) throw new Error(`frontmatter line not understood: ${line}`)
    const [, indent, key, value] = kv
    if (!indent) {
      if (value.trim() === '') { head[key] = {}; block = head[key] } else { head[key] = scalar(value); block = null }
    } else {
      if (!block) throw new Error(`indented line outside a block: ${line}`)
      block[key] = scalar(value)
    }
  }
  return { name: head.name, description: head.description, metadata: head.metadata || {}, body: String(md).slice(m[0].length).trim() }
}

// ---- loading ----
function loadOne(dir) {
  const md = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8')
  const s = parseSkillMd(md)
  const meta = s.metadata
  const schemaFile = path.join(dir, meta.args || 'args.schema.json')
  const schema = fs.existsSync(schemaFile) ? JSON.parse(fs.readFileSync(schemaFile, 'utf8')) : { type: 'object', properties: {}, required: [] }
  const refDir = path.join(dir, 'references')
  const references = fs.existsSync(refDir) ? fs.readdirSync(refDir).filter((f) => f.endsWith('.md')) : []
  return { ...s, dir, tool: toolName(s.name), schema, references }
}

export function loadSkills(dir = ACTIONS_DIR) {
  return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'SKILL.md')))
    .map((e) => loadOne(path.join(dir, e.name))).sort((a, b) => a.name.localeCompare(b.name))
}

// What a skill names must exist here: its handler, its facts, its state condition. Returns the problems.
export function problemsOf(skills, { handlers = {}, facts = [], conditions = {} } = {}) {
  const out = []
  const seen = new Set()
  for (const s of skills) {
    const p = (why) => out.push(`${s.name || path.basename(s.dir)}: ${why}`)
    if (!s.name || s.name !== path.basename(s.dir)) p('name must equal its folder name')
    if (seen.has(s.name)) p('duplicate name')
    seen.add(s.name)
    if (!String(s.description || '').trim()) p('no description')
    const m = s.metadata
    if (m.kind !== 'action') p('metadata.kind must be action')
    if (!handlers[m.handler]) p(`handler '${m.handler}' is not registered`)
    for (const f of [].concat(m.facts || [])) if (!facts.includes(f)) p(`fact '${f}' has no provider`)
    if (!conditions[m.available_when || 'always']) p(`available_when '${m.available_when}' is not a known condition`)
    if (!['inline', 'staged'].includes(m.disclosure)) p('metadata.disclosure must be inline or staged')
    if (s.schema?.type !== 'object' || typeof s.schema.properties !== 'object') p('args schema must be an object schema')
    for (const k of [].concat(m.stage1_args || [])) if (!s.schema.properties?.[k]) p(`stage1_args '${k}' is not in the schema`)
    if (m.choose_if_missing && !s.schema.properties?.[m.choose_if_missing]?.['x-enum-from']) p('choose_if_missing must name an argument with x-enum-from')
    for (const [k, v] of Object.entries(s.schema.properties || {})) {
      if (v['x-enum-from'] && !facts.includes(v['x-enum-from'])) p(`argument '${k}': x-enum-from '${v['x-enum-from']}' has no provider`)
    }
    if (!['low', 'medium', 'high'].includes(m.misroute_cost)) p('metadata.misroute_cost must be low, medium or high')
  }
  return out
}

// ---- the loaded set, read again when a SKILL.md or schema changes ----
let cache = null
let checked = 0
let validator = null
const stamp = (dir) => {
  let n = 0
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue
      for (const f of ['SKILL.md', 'args.schema.json']) { try { n += fs.statSync(path.join(dir, e.name, f)).mtimeMs } catch { /* none */ } }
    }
  } catch { /* no folder */ }
  return n
}
// the tables the names are checked against (lib/skills/handlers.js and facts.js register them)
export function useValidator(fn) { validator = fn; cache = null }
export function actionSkills() {
  if (cache && Date.now() - checked < 5000) return cache.skills
  checked = Date.now()
  const at = stamp(ACTIONS_DIR)
  if (cache && cache.at === at) return cache.skills
  const skills = loadSkills()
  const problems = validator ? validator(skills) : []
  if (problems.length) {
    // at start the server stops; a bad edit later keeps the last good set
    if (!cache) throw new Error(`action skills: ${problems.join('; ')}`)
    console.warn('[skills] not reloaded:', problems.join('; '))
    return cache.skills
  }
  cache = { at, skills }
  return skills
}
export const skillNamed = (name) => actionSkills().find((s) => s.name === name) || null
export const skillByTool = (tool) => actionSkills().find((s) => s.tool === tool) || null
// third stage: one references/ file, when a skill's body points at it
export function reference(name, file) {
  const s = skillNamed(name)
  if (!s || !s.references.includes(file)) return null
  return fs.readFileSync(path.join(s.dir, 'references', file), 'utf8')
}
