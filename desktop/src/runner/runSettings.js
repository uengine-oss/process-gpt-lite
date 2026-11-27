'use strict'
// A folder's own run settings on this PC: the files that make a CLI run things by itself — Claude Code's project settings (hooks,
// permissions, MCP servers, status line, helpers), its project MCP servers (.mcp.json), Codex's project config. When the server says the
// person may not edit the folder they work in (job.projectSettings === false — a template's runner, working in their own workspace), they are
// left off for the run: each one that is there is replaced in the work folder by an empty one, so the CLI starts without them, while the
// folder's skills (.claude/skills) and CLAUDE.md stay as they are. They are never sent back changed: the turn's commit leaves them out
// (git.js commit except), and the next run starts from the line again (git.js branch — reset), where they are as the folder has them.
// Claude Code's --setting-sources user would drop them too, but also drops the folder's skills and CLAUDE.md (2.1.331, tried 2026-11-27).
const fs = require('node:fs')
const path = require('node:path')

// (the same list as the server's — lib/localAgents/chat.js RUN_SETTINGS)
const FILES = [
  ['.claude/settings.json', '{}\n'],
  ['.claude/settings.local.json', '{}\n'],
  ['.mcp.json', '{\n  "mcpServers": {}\n}\n'],
  ['.codex/config.toml', ''],
]

// → the folder paths left off (those that were there)
function leaveOff(dir) {
  const off = []
  for (const [rel, empty] of FILES) {
    const f = path.join(dir, ...rel.split('/'))
    try { fs.lstatSync(f) } catch { continue }
    // (whatever it is — a file, a link — it goes, and an empty file takes its place: a link is never followed)
    fs.rmSync(f, { recursive: true, force: true })
    fs.writeFileSync(f, empty)
    off.push(rel)
  }
  return off
}

module.exports = { leaveOff, FILES: FILES.map(([rel]) => rel) }
