// Browser skills: what the browser agent knows about a site, as modules (skills/<name>/SKILL.md with
// metadata.runs_in: browser). Progressive disclosure, like the agent's own skills: only a skill's name and
// description are shown (to the router choosing the work, to the browser agent); its body is read when a task
// uses it (the browser agent's read_skill). Nothing about a site is written into prompts or code here —
// adding a site is adding a folder. PRO_BROWSER_SKILLS_DIR points somewhere else (a company's own skills).
import fs from 'node:fs'
import path from 'node:path'
import { REPO_ROOT } from './paths.js'

const dirs = () => [process.env.PRO_BROWSER_SKILLS_DIR, path.join(REPO_ROOT, 'skills')].filter(Boolean)

// "---\nkey: value\nmetadata:\n  key: value\n---\nbody" → { fields, body } (one level of nesting is enough here)
export function parseSkill(md = '') {
  const text = String(md).replace(/\r\n/g, '\n')
  if (!text.startsWith('---\n')) return { fields: {}, body: text }
  const end = text.indexOf('\n---', 4)
  if (end < 0) return { fields: {}, body: text }
  const fields = {}
  let group = null
  for (const line of text.slice(4, end).split('\n')) {
    if (!line.trim()) continue
    const nested = line.startsWith(' ') || line.startsWith('\t')
    const at = line.indexOf(':')
    if (at < 0) continue
    const key = line.slice(0, at).trim(), value = line.slice(at + 1).trim()
    if (!nested) {
      if (value) { fields[key] = value; group = null } else { fields[key] = {}; group = key }
    } else if (group) fields[group][key] = value
  }
  return { fields, body: text.slice(end + 4).replace(/^\n+/, '') }
}

// the sites a skill works on (metadata.hosts: host names, comma or space separated), else its start address's host — a task the agent
// started may make or change things there when the person's words name that skill (lib/agentBrowser.js namedSites)
export function hostsOf(list, startUrl = '') {
  const out = String(list || '').split(/[\s,]+/).map((h) => h.trim().toLowerCase().replace(/^www\./, '').replace(/\.$/, '')).filter(Boolean)
  if (!out.length && startUrl) { try { out.push(new URL(startUrl).hostname.toLowerCase().replace(/^www\./, '')) } catch { /* no address */ } }
  return [...new Set(out)]
}

let cache = null
// [{ name, description, startUrl, signIn, label, file }] — the skills that run in the browser. signIn: the host the
// site sends people to for signing in (metadata.sign_in, e.g. a Google site's accounts.google.com) — a login
// the vault keeps for that host is the agent's to use on the site's own sign-in wall. label: the name people know the
// site by (metadata.label — the room's rule bar and the project plan show it), else the skill's name
export function browserSkills() {
  if (cache && Date.now() - cache.at < 60_000) return cache.list
  const list = []
  for (const dir of dirs()) {
    let names = []
    try { names = fs.readdirSync(dir) } catch { continue }
    for (const n of names) {
      const file = path.join(dir, n, 'SKILL.md')
      let md
      try { md = fs.readFileSync(file, 'utf8') } catch { continue }
      const { fields } = parseSkill(md)
      if (fields.metadata?.runs_in !== 'browser' || !fields.name || list.some((s) => s.name === fields.name)) continue
      const startUrl = fields.metadata.start_url || ''
      list.push({ name: fields.name, description: fields.description || '', startUrl, signIn: fields.metadata.sign_in || '', label: fields.metadata.label || '', file, hosts: hostsOf(fields.metadata.hosts, startUrl) })
    }
  }
  cache = { at: Date.now(), list }
  return list
}
export const browserSkill = (name) => browserSkills().find((s) => s.name === name) || null
// the body, read when a task uses the skill
export function readBrowserSkill(name) {
  const s = browserSkill(name)
  if (!s) return null
  try { return parseSkill(fs.readFileSync(s.file, 'utf8')).body } catch { return null }
}
// the one-line catalogue shown before any body is read
export const browserSkillCatalog = () => browserSkills().map((s) => `- ${s.name}: ${s.description}${s.startUrl ? ` (start: ${s.startUrl})` : ''}`).join('\n')
export const _resetBrowserSkills = () => { cache = null }
