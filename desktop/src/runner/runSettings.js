'use strict'
// A folder's own run settings on this PC: what makes a CLI run things by itself — Claude Code's project settings (hooks, permissions, MCP
// servers, status line, helpers), its project MCP servers (.mcp.json), Codex's project config, and the front matter of the folder's skills,
// commands and agents (Claude Code 2.1.332: `hooks` registered when a skill is used, `allowed-tools` approved without asking, `shell`, its own
// `mcpServers` · `lspServers`, an agent's `permissionMode`). When the server says the person may not edit the folder they work in
// (job.projectSettings === false — a template's runner, working in their own workspace), they are left off for the run:
//   · each settings file that is there is replaced in the work folder by an empty one
//   · names are matched in any case (macOS and Windows ignore it: `.Claude/Agents/x.md` is what the CLI finds as .claude/agents/x.md)
//   · each SKILL.md (anywhere), and each .md under a .claude/agents or .claude/commands folder (at any depth), loses those front-matter keys
//     (any spelling the CLI might take for one: case, '-' · '_', camelCase). The front matter is found exactly as the CLI finds it (cliBlock
//     — its own pattern, read from its binary), read as YAML (js-yaml) and written back without them — the rest of it (name, description,
//     …) and the body as they were, so the skill still works. Fail closed: a front matter that does not read as YAML, or that names one of
//     those keys anywhere (frontRuns — read as the badge reads it) where js-yaml does not show it at the top, is left off whole (an empty
//     front matter in its place; the body stays). Only a file's head is read (HEAD_MAX); the rest of a long file is copied as it is.
//   · which files: git's list of the work folder — its files, and every file not in git (ignored ones too: node_modules, the CLI's .claude/),
//     and the files of a repository inside it (another run's clone, a submodule) read from the disk, never with its git. When that list
//     cannot be whole — git fails, too many files, a link under a .claude folder to a folder the list does not reach — the run is refused
//     (Incomplete), never started with keys left on.
// The CLI starts without them, while the folder's skills and CLAUDE.md stay. They are never sent back changed: the turn's commit leaves the
// touched paths out (git.js commit except), and the next run starts from the line again (git.js branch — reset), where they are as the
// folder has them. Only files inside the work folder are written, each as a new file put in its place: a folder on the way there that is a
// link (.codex → the person's own ~/.codex, made by the CLI) is never followed, a link or a hard link to a file elsewhere never written
// through.
// Claude Code's --setting-sources user would drop the settings files too, but also drops the folder's skills and CLAUDE.md (2.1.331, tried
// 2026-11-27).
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const yaml = require('js-yaml')
const G = require('./git')
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
// (a spelling the CLI might take for one of them: Hooks, allowed_tools, allowedTools, Allowed-Tools — all 'allowedtools')
const norm = (k) => String(k).toLowerCase().replace(/[-_]/g, '')
const RUNS = new Set(FRONT_RUNS.map(norm))
const HEAD_MAX = 1024 * 1024            // a front file's head, read for its front matter
const LIST_MAX = 256 * 1024 * 1024      // git's list of the work folder (bytes)
const INNER_MAX = 100_000               // files of the repositories inside the work folder, read from the disk

// A run the list of files to look at could not be made whole for: refused (runner.js says why, in the person's language)
class Incomplete extends Error {
  constructor(why, detail = '') {
    super(`the folder's run settings could not all be found (${why}${detail ? `: ${detail}` : ''})`)
    this.code = 'RUN_SETTINGS_INCOMPLETE'
    this.why = why
    this.detail = detail
  }
}

// a path's names as a file system that ignores case (macOS, Windows) takes them — `.Claude/Agents/x.md` is where the CLI finds
// .claude/agents: case folded, and the dots and spaces Windows drops from a name's end dropped
const fold = (rel) => String(rel).split('/').map((n) => n.toLowerCase().replace(/[. ]+$/, ''))
// a file the CLI reads front matter from: any SKILL.md, a .md under a .claude/agents or .claude/commands folder (nested folders too) —
// names in any case
function isFrontFile(rel) {
  const segs = fold(rel)
  const base = segs[segs.length - 1] || ''
  if (base === 'skill.md') return true
  if (!base.endsWith('.md')) return false
  for (let i = 0; i < segs.length - 2; i++) if (segs[i] === '.claude' && (segs[i + 1] === 'agents' || segs[i + 1] === 'commands')) return true
  return false
}
const underClaude = (rel) => fold(rel).includes('.claude')
// a settings file of FILES (in any case: .Claude/Settings.json) → its empty text, or undefined
const SETTINGS = new Map(FILES)
const settingsFile = (rel) => SETTINGS.get(fold(rel).join('/'))

// the path is inside the work folder all the way: every folder on the way is a real folder in it (no link that leads elsewhere)
function inside(realRoot, abs) {
  let parent
  try { parent = fs.realpathSync(path.dirname(abs)) } catch { return false }
  return parent === realRoot || parent.startsWith(realRoot + path.sep)
}

// The front matter as Claude Code 2.1.332 finds it (read from its binary): a BOM dropped; none unless another '---' comes after the first
// three characters; then /^---\s*\n([\s\S]*?)---\s*\n?/ — from a first line '---' to the next '---' anywhere, even inside a line; '...'
// does not end it. → {bom, open, block, close, end (where the body starts, in `text`)} or null
const CLI_FRONT = /^(---\s*\n)([\s\S]*?)(---\s*\n?)/
function cliBlock(text) {
  const src = String(text ?? '')
  const bom = src.charCodeAt(0) === 0xfeff ? '﻿' : ''
  const t = src.slice(bom.length)
  if (t.indexOf('---', 3) < 0) return null
  const m = CLI_FRONT.exec(t)
  if (!m) return null
  return { bom, open: m[1], block: m[2], close: m[3], end: bom.length + m[0].length }
}
const OPENS = /^﻿?---\s*\n/

// The run keys a front-matter block names anywhere — at any depth, in a flow mapping, as an explicit key ('? hooks'), in any spelling:
// conservative, for a warning and for failing closed
const KEY = /(?:^|[\s{,[])["']?([A-Za-z][\w-]*)["']?[ \t]*:(?=[\s{}[\],"']|$)/gm
const EXPLICIT = /^[ \t-]*\?[ \t]+["']?([A-Za-z][\w-]*)/gm
function namesIn(block) {
  const seen = new Set()
  for (const re of [KEY, EXPLICIT]) for (const m of String(block).matchAll(re)) seen.add(norm(m[1]))
  return FRONT_RUNS.filter((k) => seen.has(norm(k)))
}
// The badge's reading (the same as the server's lib/folders/kit.js frontRuns). truncated: `text` is only the file's head — a front matter
// that opens there and does not end there counts as naming them all
function frontRuns(text, { truncated = false } = {}) {
  const c = cliBlock(text)
  if (c) return namesIn(c.block)
  return truncated && OPENS.test(String(text ?? '')) ? [...FRONT_RUNS] : []
}

// One file's text (or its head, with the whole front matter in it) without the run keys of its front matter → {text, removed} — or null
// when there is nothing to leave off (the text as it is)
function stripFront(text) {
  const c = cliBlock(text)
  if (!c) return null
  const rest = String(text).slice(c.end)
  const named = namesIn(c.block)
  const nl = c.block.includes('\r\n') ? '\r\n' : '\n'
  // (left off whole: an empty front matter in its place — the CLI reads none, and what came after it stays the body)
  const whole = () => ({ text: `${c.bom}${c.open}${c.close}${rest}`, removed: ['(front matter)'] })
  let fm
  // (the default schema: merge keys (<<: *base) come in as the mapping's own keys — a run key merged in is found and left off too)
  try { fm = yaml.load(c.block) } catch { return whole() }
  if (!fm || typeof fm !== 'object' || Array.isArray(fm)) return named.length ? whole() : null
  const removed = Object.keys(fm).filter((k) => RUNS.has(norm(k)) || k === '<<')
  const top = new Set(removed.map(norm))
  // (a run key named in the block that js-yaml does not show at the top: the CLI's own YAML reading might — left off whole)
  if (named.some((k) => !top.has(norm(k)))) return whole()
  if (!removed.length) return null
  for (const k of removed) delete fm[k]
  const kept = Object.keys(fm).length ? yaml.dump(fm, { lineWidth: -1, noRefs: true }) : ''
  // (what is written back must end where the CLI will end it: no '---' inside)
  if (kept.includes('---')) return whole()
  return { text: `${c.bom}${c.open}${kept.replace(/\n/g, nl)}${c.close}${rest}`, removed }
}

// a new file next to `abs` with `parts` (Buffers, or [fd, from]: the rest of an open file from that byte) in it → its path. putInPlace
// then renames it over `abs` (a link or a hard link there is replaced, never written through) — after the source is closed: Windows
// refuses to rename over a file that is still open
function writeTemp(abs, mode, parts) {
  const tmp = path.join(path.dirname(abs), `.pgl-${crypto.randomBytes(6).toString('hex')}.tmp`)
  const out = fs.openSync(tmp, 'wx', mode & 0o777)
  try {
    for (const p of parts) {
      if (Buffer.isBuffer(p)) { fs.writeSync(out, p); continue }
      const [fd, from] = p
      const buf = Buffer.alloc(1024 * 1024)
      for (let at = from; ;) {
        const n = fs.readSync(fd, buf, 0, buf.length, at)
        if (!n) break
        fs.writeSync(out, buf, 0, n)
        at += n
      }
    }
  } catch (e) { fs.closeSync(out); fs.rmSync(tmp, { force: true }); throw e }
  fs.closeSync(out)
  return tmp
}
function putInPlace(tmp, abs) {
  try { fs.renameSync(tmp, abs) } catch (e) { fs.rmSync(tmp, { force: true }); throw e }
}

// A front file of the work folder (a link: what it leads to) without the run keys of its front matter → the keys left off, or null
function neutralize(abs) {
  const st = fs.statSync(abs)
  if (!st.isFile()) return null
  const fd = fs.openSync(abs, 'r')
  let tmp = null
  let removed = null
  try {
    const head = Buffer.alloc(Math.min(st.size, HEAD_MAX))
    const n = fs.readSync(fd, head, 0, head.length, 0)
    const text = head.subarray(0, n).toString('utf8')
    const c = cliBlock(text)
    if (c) {
      const r = stripFront(text.slice(0, c.end))
      if (!r) return null
      tmp = writeTemp(abs, st.mode, [Buffer.from(r.text, 'utf8'), [fd, Buffer.byteLength(text.slice(0, c.end), 'utf8')]])
      removed = r.removed
    } else {
      const o = st.size > n && OPENS.exec(text)
      if (!o) return null
      // (a front matter that does not end in the head: left off whole — an empty one in its place, the rest as it is)
      tmp = writeTemp(abs, st.mode, [Buffer.from(`${o[0]}---\n`, 'utf8'), [fd, Buffer.byteLength(o[0], 'utf8')]])
      removed = ['(front matter)']
    }
  } catch (e) {
    if (tmp) fs.rmSync(tmp, { force: true })
    throw e
  } finally { fs.closeSync(fd) }
  putInPlace(tmp, abs)
  return removed
}

// the files of a repository inside the work folder, from the disk (its own git is never run: its config is not the app's) → rel paths,
// links as they are (not followed); false when over the budget
function walkInner(abs, rel, budget) {
  const out = []
  const go = (a, r) => {
    let ents
    try { ents = fs.readdirSync(a, { withFileTypes: true }) } catch { return true }
    for (const e of ents) {
      if (--budget.left < 0) return false
      if (e.name === '.git') continue
      const rr = `${r}/${e.name}`
      if (e.isDirectory()) { if (!go(path.join(a, e.name), rr)) return false } else out.push(rr)
    }
    return true
  }
  return go(abs, rel) ? out : false
}

// Every file of the work folder (relative, '/'): git's list of its files and of every file not in git — ignored ones too (node_modules,
// .claude/ — the CLI reads them all the same) — and the files of a repository inside it
async function list(dir) {
  let tracked, others
  try {
    tracked = await G.git(dir, ['ls-files', '-z', '--stage'], { maxBuffer: LIST_MAX })
    others = await G.git(dir, ['ls-files', '-z', '--others'], { maxBuffer: LIST_MAX })
  } catch (e) { throw new Incomplete('list', /maxBuffer/i.test(e.message) ? 'too many files' : e.message) }
  const out = []
  const inner = []
  for (const line of tracked.split('\0')) {
    if (!line) continue
    const p = line.slice(line.indexOf('\t') + 1)
    if (line.startsWith('160000 ')) inner.push(p); else out.push(p)
  }
  // (git shows a repository inside as 'its/path/', and does not go in)
  for (const p of others.split('\0')) if (p) (p.endsWith('/') ? inner.push(p.slice(0, -1)) : out.push(p))
  const budget = { left: INNER_MAX }
  for (const n of inner) {
    const files = walkInner(path.join(dir, ...n.split('/')), n, budget)
    if (!files) throw new Incomplete('inner', n)
    out.push(...files)
  }
  return out
}

// → {paths: every folder path left off (the commit leaves them out), files: the settings files emptied, front: [{path, removed}]};
// throws Incomplete when the work folder's files cannot all be listed
async function leaveOff(dir) {
  let realRoot
  try { realRoot = fs.realpathSync(dir) } catch (e) { throw new Incomplete('list', e.message) }
  const files = []
  const front = []
  for (const rel of await list(dir)) {
    const f = path.join(dir, ...rel.split('/'))
    let st
    try { st = fs.lstatSync(f) } catch { continue }
    const empty = settingsFile(rel)
    if (empty !== undefined) {
      // (a folder on the way that leads out of the work folder — .codex → ~/.codex, which git's list does not go into — is never written
      // through; whatever the file is — a file, a link — it goes, and an empty file takes its place, under the name it has)
      if (!inside(realRoot, f)) continue
      try { fs.rmSync(f, { force: true }); fs.writeFileSync(f, empty) } catch (e) { throw new Incomplete('write', `${rel}: ${e.message}`) }
      files.push(rel)
      continue
    }
    if (st.isSymbolicLink()) {
      // (a link under a .claude folder to a folder: the CLI reads what is in there, which this list does not reach)
      let to = null
      try { to = fs.statSync(f) } catch { /* leads nowhere: nothing is read through it */ }
      if (to?.isDirectory() && underClaude(rel)) throw new Incomplete('link', rel)
      if (!to?.isFile()) continue
    } else if (!st.isFile()) continue
    if (!isFrontFile(rel) || !inside(realRoot, f)) continue
    try {
      const removed = neutralize(f)
      if (removed) front.push({ path: rel, removed })
    } catch (e) { throw new Incomplete('write', `${rel}: ${e.message}`) }
  }
  return { paths: [...files, ...front.map((x) => x.path)], files, front }
}

module.exports = { leaveOff, stripFront, frontRuns, cliBlock, isFrontFile, Incomplete, FILES: FILES.map(([rel]) => rel), FRONT_RUNS, HEAD_MAX }
