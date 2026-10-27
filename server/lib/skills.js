// A skill's SKILL.md, read as the agent sees it, plus the short summary the chat and the skill
// screen show first: what it is for, which connector tools it uses, and its procedure.
import { config } from '../config.js'
import fs from 'node:fs/promises'
import path from 'node:path'

const strip = (s) => s.trim().replace(/^["']|["']$/g, '')

// Frontmatter values may be one line, or a YAML block (`key: >` / `key: |`) on the lines below.
function frontValue(head, key) {
  const lines = head.split('\n')
  const i = lines.findIndex((l) => new RegExp(`^\\s*${key}:`).test(l))
  if (i < 0) return ''
  const first = lines[i].replace(new RegExp(`^\\s*${key}:\\s*`), '')
  if (first && !/^[>|][-+]?$/.test(first)) return strip(first)
  const indent = (lines[i].match(/^\s*/) || [''])[0].length
  const block = []
  for (const l of lines.slice(i + 1)) {
    if (l.trim() && (l.match(/^\s*/) || [''])[0].length <= indent) break
    block.push(l.trim())
  }
  return block.join(' ').trim()
}

export function summarizeSkill(md = '') {
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(md)
  const head = fm ? fm[1] : ''
  const body = fm ? md.slice(fm[0].length) : md
  // Declared tools first; a skill without the line still names its tools in the procedure.
  let tools = frontValue(head, 'include_tools').split(/[\s,]+/).filter(Boolean)
  if (!tools.length) tools = [...new Set(body.match(/\b(?:youtube|calendar|gmail|drive|slack|github|notion)_[a-z_]+\b/g) || [])]
  const sections = [...body.matchAll(/^#{2,3}\s+(.+)$/gm)].map((m) => m[1].trim())
  const steps = [...body.matchAll(/^ {0,3}\d+\.\s+(.+)$/gm)]
    .map((m) => m[1].replace(/\*\*|`/g, '').replace(/\s+/g, ' ').trim())
  return {
    name: frontValue(head, 'name'),
    description: frontValue(head, 'description'),
    tools,
    sections: sections.slice(0, 10),
    steps: steps.slice(0, 6),
    stepCount: steps.length,
  }
}

// Files of a skill folder on disk, relative to it (SKILL.md first).
export async function listFolder(dir) {
  const out = []
  async function walk(d) {
    for (const e of await fs.readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) await walk(p)
      else out.push(path.relative(dir, p))
    }
  }
  await walk(dir)
  return out.sort((a, b) => (a === 'SKILL.md' ? -1 : b === 'SKILL.md' ? 1 : a.localeCompare(b)))
}

const da = (p) => `${config.deepagentsUrl}${p}${p.includes('?') ? '&' : '?'}tenant_id=${encodeURIComponent(config.tenantId)}`

// One tenant skill through deepagents' skills API (tenant-guarded: the user's JWT).
export async function getSkill(jwt, name) {
  const headers = { Authorization: `Bearer ${jwt}` }
  const n = encodeURIComponent(name)
  const fileRes = await fetch(da(`/skills/${n}/files/SKILL.md`), { headers })
  if (!fileRes.ok) throw new Error(`skill ${name}: ${fileRes.status}`)
  const raw = await fileRes.text()
  let markdown = raw
  try { const j = JSON.parse(raw); markdown = j.content ?? j.text ?? raw } catch { /* plain text */ }
  const list = await fetch(da(`/skills/${n}/files`), { headers }).then((r) => r.json()).catch(() => ({}))
  const files = (Array.isArray(list) ? list : list.files || []).map((f) => (typeof f === 'string' ? f : f.path || f.name)).filter(Boolean)
  return { ...summarizeSkill(markdown), name, markdown, files }
}

// deepagents requires a JSON body naming the mode; 'local' removes the tenant's copy only
export async function deleteSkill(jwt, name) {
  const r = await fetch(da(`/skills/${encodeURIComponent(name)}`), {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'local' }),
  })
  if (!r.ok) throw new Error(`delete ${name}: ${r.status} ${(await r.text()).slice(0, 200)}`)
}
