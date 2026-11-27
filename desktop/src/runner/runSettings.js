'use strict'
// A folder's own run settings on this PC: what makes a CLI run things by itself — Claude Code's project settings (hooks, permissions, MCP
// servers, status line, helpers), its project MCP servers (.mcp.json), Codex's project config, and the front matter of the folder's skills,
// commands and agents (Claude Code 2.1.332: `hooks` registered when a skill is used, `allowed-tools` approved without asking, `shell`, its own
// `mcpServers` · `lspServers`, an agent's `permissionMode`). When the server says the person may not edit the folder they work in
// (job.projectSettings === false — a template's runner, working in their own workspace), they are left off for the run:
//   · each settings file that is there is replaced in the work folder by an empty one
//   · each SKILL.md (anywhere), and each .md under a .claude/agents or .claude/commands folder (at any depth), loses those front-matter keys —
//     the front matter is read as YAML (js-yaml) and written back without them, the rest of it (name, description, …) and the body as they
//     were, so the skill still works; a front matter that does not read as YAML is left off whole (the body stays)
// The CLI starts without them, while the folder's skills and CLAUDE.md stay. They are never sent back changed: the turn's commit leaves the
// touched paths out (git.js commit except), and the next run starts from the line again (git.js branch — reset), where they are as the
// folder has them. Only files inside the work folder are touched: a folder on the way there that is a link (.codex → the person's own
// ~/.codex, made by the CLI) is never followed.
// Claude Code's --setting-sources user would drop the settings files too, but also drops the folder's skills and CLAUDE.md (2.1.331, tried
// 2026-11-27).
const fs = require('node:fs')
const path = require('node:path')
const yaml = require('js-yaml')
const PLACES = require('./kit-places.json')

// (the same list as the server's — lib/localAgents/chat.js RUN_SETTINGS)
const FILES = [
  ['.claude/settings.json', '{}\n'],
  ['.claude/settings.local.json', '{}\n'],
  ['.mcp.json', '{\n  "mcpServers": {}\n}\n'],
  ['.codex/config.toml', ''],
]
// the front-matter keys that run things (kit-places.json — the server's badge reads the same list)
const FRONT_RUNS = PLACES.frontMatterRuns || []
const WALK_MAX = 20_000
const READ_MAX = 1024 * 1024

// a file the CLI reads front matter from: any SKILL.md, a .md under a .claude/agents or .claude/commands folder (nested folders too)
function isFrontFile(rel) {
  const segs = String(rel).split('/')
  const base = segs[segs.length - 1] || ''
  if (/^skill\.md$/i.test(base)) return true
  if (!/\.md$/i.test(base)) return false
  for (let i = 0; i < segs.length - 2; i++) if (segs[i] === '.claude' && (segs[i + 1] === 'agents' || segs[i + 1] === 'commands')) return true
  return false
}

// the path is inside the work folder all the way: every folder on the way is a real folder in it (no link that leads elsewhere)
function inside(realRoot, abs) {
  let parent
  try { parent = fs.realpathSync(path.dirname(abs)) } catch { return false }
  return parent === realRoot || parent.startsWith(realRoot + path.sep)
}

// The badge's reading (the same as the server's lib/folders/kit.js frontRuns): the keys of frontMatterRuns named anywhere in the front
// matter — conservative, for a warning
function frontRuns(text) {
  const md = String(text || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  if (!md.startsWith('---\n')) return []
  const end = md.slice(4).search(/^(---|\.\.\.)[ \t]*$/m)
  const block = end < 0 ? md.slice(4) : md.slice(4, 4 + end)
  const keys = new Set()
  for (const m of block.matchAll(/(?:^|[\s{,])["']?([A-Za-z][\w-]*)["']?[ \t]*:(?=\s|$)/gm)) keys.add(m[1])
  return FRONT_RUNS.filter((k) => keys.has(k))
}

// One file's text without the run keys of its front matter → {text, removed} — or null when there is nothing to leave off
function stripFront(text) {
  const src = String(text)
  const bom = src.startsWith('﻿') ? '﻿' : ''
  const body = src.slice(bom.length)
  const nl = body.includes('\r\n') ? '\r\n' : '\n'
  const lines = body.split(/\r?\n/)
  if (lines[0].trim() !== '---') return null
  let end = -1
  for (let i = 1; i < lines.length; i++) if (lines[i].trim() === '---' || lines[i].trim() === '...') { end = i; break }
  if (end < 0) return null
  const block = lines.slice(1, end).join('\n')
  const rest = lines.slice(end + 1).join(nl)
  let fm
  // (the default schema: merge keys (<<: *base) come in as the mapping's own keys — a run key merged in is found and left off too)
  try { fm = yaml.load(block) } catch {
    // (it does not read as YAML here — the CLI's own reading might still find keys in it: the whole front matter is left off)
    return { text: `${bom}${rest}`, removed: ['(front matter)'] }
  }
  if (!fm || typeof fm !== 'object' || Array.isArray(fm)) return null
  const removed = [...FRONT_RUNS, '<<'].filter((k) => Object.prototype.hasOwnProperty.call(fm, k))
  if (!removed.length) return null
  for (const k of removed) delete fm[k]
  const kept = Object.keys(fm).length ? yaml.dump(fm, { lineWidth: -1, noRefs: true }) : ''
  return { text: `${bom}---${nl}${kept.replace(/\n/g, nl)}---${nl}${rest}`, removed }
}

// the work folder's files (relative, '/'), its .git and node_modules aside
function walk(dir) {
  const out = []
  const go = (abs, rel) => {
    let ents
    try { ents = fs.readdirSync(abs, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      if (out.length >= WALK_MAX) return
      if (e.name === '.git' || e.name === 'node_modules') continue
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) go(path.join(abs, e.name), r)
      else if (e.isFile()) out.push(r)
    }
  }
  go(dir, '')
  return out
}

// → {paths: every folder path left off (the commit leaves them out), files: the settings files emptied, front: [{path, removed}]}
function leaveOff(dir) {
  let realRoot
  try { realRoot = fs.realpathSync(dir) } catch { return { paths: [], files: [], front: [] } }
  const files = []
  for (const [rel, empty] of FILES) {
    const f = path.join(dir, ...rel.split('/'))
    try { fs.lstatSync(f) } catch { continue }
    // (a folder on the way that leads out of the work folder — .codex → ~/.codex — is never written through)
    if (!inside(realRoot, f)) continue
    // (whatever it is — a file, a link — it goes, and an empty file takes its place: a link is never followed)
    fs.rmSync(f, { recursive: true, force: true })
    fs.writeFileSync(f, empty)
    files.push(rel)
  }
  const front = []
  for (const rel of walk(dir).filter(isFrontFile)) {
    const f = path.join(dir, ...rel.split('/'))
    try {
      const st = fs.lstatSync(f)
      if (!st.isFile() || st.size > READ_MAX || !inside(realRoot, f)) continue
      const r = stripFront(fs.readFileSync(f, 'utf8'))
      if (!r) continue
      fs.writeFileSync(f, r.text)
      front.push({ path: rel, removed: r.removed })
    } catch { /* unreadable: as it is */ }
  }
  return { paths: [...files, ...front.map((x) => x.path)], files, front }
}

module.exports = { leaveOff, stripFront, frontRuns, isFrontFile, FILES: FILES.map(([rel]) => rel), FRONT_RUNS }
