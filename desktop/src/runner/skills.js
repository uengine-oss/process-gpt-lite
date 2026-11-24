'use strict'
// The company's skills in a local run (design docs/local-agents/design.md §6.5). The server sends the skills the server agent would get for
// the activity (and the person's own private ones), each its skill folder over git with a token that may only read. Before the CLI starts
// they are brought up to date (a cache clone per skill under <data>/local-agents/skills, fetched each job) and put where the CLI reads them
// by itself:
//   Claude Code — <work folder>/.claude/skills/<name>/ (its project skills)
//   Codex       — <work folder>/.pgl-skills/<name>/ and an AGENTS.md that points at them
// None of it is committed (the work folder's .git/info/exclude). After the run, what the CLI changed there — in a skill's files, or what it
// wrote into its own memory (CLAUDE.md, AGENTS.md) — is what the run learned (runner.js → the server's know-how candidates).
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

// a clean slate, the skills current from their folders' main, placed for this CLI → {placed: {name → {dir, files: {rel → sha}}}, agents}
async function place({ dir, agent, skills = [], server, cacheRoot, lang = 'ko', log = () => {} }) {
  exclude(dir)
  for (const p of ['.claude', '.pgl-skills', 'CLAUDE.md', 'AGENTS.md']) fs.rmSync(path.join(dir, p), { recursive: true, force: true })
  const placed = {}
  const lines = []
  for (const k of skills) {
    if (!k?.name || !k.token || !/^[0-9a-f-]{36}$/i.test(String(k.folder?.id || ''))) continue
    const cache = path.join(cacheRoot, String(k.folder.id))
    try {
      await G.sync(cache, { url: k.url || `${server}${k.path}`, token: k.token, base: 'main' })
      await G.git(cache, ['checkout', '-q', '-f', '--detach', 'refs/remotes/origin/main'])
    } catch (e) { log(`[runner] skill ${k.name}: ${e.message}`); continue }
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
  // Codex reads AGENTS.md by itself: it points at the skills
  let agents = null
  if (agent === 'codex' && lines.length) {
    agents = lang === 'en'
      ? `# Skills of this work folder\n\nThe company's skills for this work are in \`.pgl-skills/\`. When the work is what a skill covers, read its SKILL.md first and do it that way.\n\n${lines.join('\n')}\n`
      : `# 이 작업 폴더의 스킬\n\n이 일에 쓰는 회사 스킬이 \`.pgl-skills/\` 에 있어요. 일이 그 스킬에 해당하면 먼저 그 SKILL.md 를 읽고 그 방법대로 하세요.\n\n${lines.join('\n')}\n`
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), agents)
  }
  return { placed, agents, names: Object.keys(placed) }
}

// what the CLI changed in the skills it was given, and what it wrote into its own memory → {skills: [{name, folderId, files: [{path, text}]}], memory}
function changes({ dir, placed = {}, agents = null }) {
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
  const read = (f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8') } catch { return null } }
  const claude = read('CLAUDE.md')
  if (claude && claude.trim()) memory.push({ file: 'CLAUDE.md', text: claude.slice(0, 4000) })
  const ag = read('AGENTS.md')
  if (ag && ag !== agents) {
    // (only what the CLI added to the pointer it was given)
    const added = agents && ag.startsWith(agents) ? ag.slice(agents.length) : ag
    if (added.trim()) memory.push({ file: 'AGENTS.md', text: added.slice(0, 4000) })
  }
  return { skills, memory }
}

module.exports = { place, changes, exclude, EXCLUDE }
