'use strict'
// The company's skills in a local run (design docs/local-agents/design.md §6.5). The server sends the skills the server agent would get for
// the activity (and the person's own private ones), each its skill folder over git with a token that may only read. Before the CLI starts
// they are brought up to date (a cache clone per skill under <data>/local-agents/skills, fetched each job) and put where the CLI reads them
// by itself:
//   Claude Code — <work folder>/.claude/skills/<name>/ (its project skills)
//   Codex       — <work folder>/.pgl-skills/<name>/ and an AGENTS.md that points at them
// None of it is committed (the work folder's .git/info/exclude). After the run, what the CLI changed there — in a skill's files, or what it
// wrote into its own memory (CLAUDE.md, AGENTS.md) — is what the run learned (runner.js → the server's know-how candidates).
// The folder's own files are never touched: what the folder tracks (its AGENTS.md, CLAUDE.md, .claude/settings.json, a skill of its own) is
// neither removed nor overwritten — only what an earlier run left untracked is cleared; a company skill whose place the folder already
// uses is left out (the folder's own is there), and for Codex with the folder's own AGENTS.md the pointer goes into the prompt instead.
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const G = require('./git')

const EXCLUDE = ['.tmp/', '.pgl-run/', '.claude/', '.pgl-skills/', 'CLAUDE.md', 'AGENTS.md']
const safeName = (n) => String(n || '').normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').replace(/^\.+/, '').trim().slice(0, 80) || 'skill'
const sha = (b) => crypto.createHash('sha1').update(b).digest('hex')
const walk = (root, rel = '') => {
  const out = []
  for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    if (e.name === '.git') continue
    const r = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) out.push(...walk(root, r))
    else if (e.isFile()) out.push(r)
  }
  return out
}

// what the CLI's own files must never go into the work's commits
function exclude(dir) {
  const f = path.join(dir, '.git', 'info', 'exclude')
  let have = ''
  try { have = fs.readFileSync(f, 'utf8') } catch { /* none yet */ }
  const missing = EXCLUDE.filter((x) => !have.split('\n').includes(x))
  if (missing.length) fs.appendFileSync(f, `\n${missing.join('\n')}\n`)
}

const where = (agent) => (agent === 'codex' ? '.pgl-skills' : path.join('.claude', 'skills'))

// what the folder tracks among the CLI's own places (never removed or overwritten here)
async function trackedIn(dir) {
  const out = await G.git(dir, ['ls-files', '-z', '--', '.claude', '.pgl-skills', 'CLAUDE.md', 'AGENTS.md'], { check: false }).catch(() => '')
  return new Set(String(out || '').split('\0').filter(Boolean))
}
const under = (set, rel) => [...set].some((f) => f === rel || f.startsWith(`${rel}/`))
const readOr = (f) => { try { return fs.readFileSync(f, 'utf8') } catch { return null } }

// a clean slate (what earlier runs left), the skills current from their folders' main, placed for this CLI
// → {placed: {name → {dir, folderId, files: {rel → sha}}}, agents (the AGENTS.md written), pointer (for the prompt instead), names,
//    skipped (left out: the folder has its own there), before (CLAUDE.md · AGENTS.md as the CLI finds them)}
async function place({ dir, agent, skills = [], server, cacheRoot, lang = 'ko', log = () => {} }) {
  exclude(dir)
  const tracked = await trackedIn(dir)
  // (only what is untracked and ignored there — an earlier run's skills and notes; the folder's own files stay)
  await G.git(dir, ['clean', '-fdXq', '--', '.claude', '.pgl-skills', 'CLAUDE.md', 'AGENTS.md'], { check: false }).catch(() => {})
  const placed = {}
  const skipped = []
  const lines = []
  for (const k of skills) {
    if (!k?.name || !k.token || !/^[0-9a-f-]{36}$/i.test(String(k.folder?.id || ''))) continue
    const cache = path.join(cacheRoot, String(k.folder.id))
    try {
      await G.sync(cache, { url: k.url || `${server}${k.path}`, token: k.token, base: 'main' })
      await G.git(cache, ['checkout', '-q', '-f', '--detach', 'refs/remotes/origin/main'])
    } catch (e) { log(`[runner] skill ${k.name}: ${e.message}`); continue }
    const rel = path.posix.join(where(agent).split(path.sep).join('/'), safeName(k.name))
    if (under(tracked, rel)) { skipped.push(k.name); log(`[runner] skill ${k.name}: the work folder has its own ${rel} — left as it is`); continue }
    const target = path.join(dir, where(agent), safeName(k.name))
    fs.mkdirSync(target, { recursive: true })
    const files = {}
    for (const rel of walk(cache)) {
      const buf = fs.readFileSync(path.join(cache, rel))
      fs.mkdirSync(path.dirname(path.join(target, rel)), { recursive: true })
      fs.writeFileSync(path.join(target, rel), buf)
      files[rel] = sha(buf)
    }
    placed[k.name] = { dir: target, folderId: k.folder.id, files }
    const md = (() => { try { return fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8') } catch { return '' } })()
    const desc = (/^description:\s*(.+)$/m.exec(md)?.[1] || '').replace(/^["']|["']$/g, '').slice(0, 160)
    lines.push(`- ${k.name}: ${path.posix.join(where(agent).split(path.sep).join('/'), safeName(k.name), 'SKILL.md')}${desc ? ` — ${desc}` : ''}`)
  }
  // Codex reads AGENTS.md by itself: it points at the skills (the folder's own AGENTS.md is not overwritten — the pointer goes into the
  // prompt instead)
  let agents = null
  let pointer = null
  if (agent === 'codex' && lines.length) {
    const text = lang === 'en'
      ? `# Skills of this work folder\n\nThe company's skills for this work are in \`.pgl-skills/\`. When the work is what a skill covers, read its SKILL.md first and do it that way.\n\n${lines.join('\n')}\n`
      : `# 이 작업 폴더의 스킬\n\n이 일에 쓰는 회사 스킬이 \`.pgl-skills/\` 에 있어요. 일이 그 스킬에 해당하면 먼저 그 SKILL.md 를 읽고 그 방법대로 하세요.\n\n${lines.join('\n')}\n`
    if (tracked.has('AGENTS.md')) pointer = text
    else { agents = text; fs.writeFileSync(path.join(dir, 'AGENTS.md'), agents) }
  }
  const before = { 'CLAUDE.md': readOr(path.join(dir, 'CLAUDE.md')), 'AGENTS.md': readOr(path.join(dir, 'AGENTS.md')) }
  return { placed, agents, pointer, names: Object.keys(placed), skipped, before }
}

// what the CLI changed in the skills it was given, and what it wrote into its own memory → {skills: [{name, folderId, files: [{path, text}]}], memory}
// (before: CLAUDE.md · AGENTS.md as the CLI found them — what it added to them is its memory, not the folder's own text)
function changes({ dir, placed = {}, agents = null, before = null }) {
  const skills = []
  for (const [name, p] of Object.entries(placed)) {
    if (!fs.existsSync(p.dir)) continue
    const files = []
    for (const rel of walk(p.dir)) {
      const buf = fs.readFileSync(path.join(p.dir, rel))
      if (p.files[rel] !== sha(buf) && buf.length <= 200_000) files.push({ path: rel, text: buf.toString('utf8') })
    }
    if (files.length) skills.push({ name, folderId: p.folderId, files })
  }
  const memory = []
  const was = before || { 'CLAUDE.md': null, 'AGENTS.md': agents }
  for (const file of ['CLAUDE.md', 'AGENTS.md']) {
    const now = readOr(path.join(dir, file))
    const then = was[file] ?? null
    if (!now || now === then) continue
    // (only what the CLI added to what it found — the folder's own note, the pointer it was given)
    const added = then && now.startsWith(then) ? now.slice(then.length) : now
    if (added.trim()) memory.push({ file, text: added.slice(0, 4000) })
  }
  return { skills, memory }
}

module.exports = { place, changes, exclude, EXCLUDE }
