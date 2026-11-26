'use strict'
// 챔피언 폴더 — a folder the person picked on this computer, kept as a managed Lite folder (design: champion folders §2, §6.3, §7).
// P0: pick → preview (what goes up, what is left out and why, files to check, the agent assets found) → the person's yes in a system
// dialog (main.js) → the first upload; later uploads only when the person presses 「지금 올리기」. No receiving yet (P1).
//
// The picked folder is only ever read. Its git history (if it is a repository) is not used and its .git is never opened: a shadow
// repository of the app's own — GIT_DIR=<data>/sync/<server10>/<folderId>.git, the picked folder as its work tree — holds the index and
// the snapshots. Nothing is created in the picked folder (no .git, no file), and the git commands this module runs are a fixed list
// none of which writes into a work tree (no reset · clean · checkout · restore · stash · merge — `shadowGit` refuses anything else).
// What is left out: the folder's own .gitignore (git applies it), and the app's groups (secret-shapes.json — names and paths only):
// secret · personal · rebuildable, files over 50 MB, and structure (another repository inside, every link — inside the folder or not —
// and git's own control files .gitmodules · .lfsconfig): only plain files go up, never a link or a submodule entry. Text files that
// stay (1 MB or less) are looked at for the shapes of known keys (secret-shapes.json: token formats only — no meaning is read); a hit
// is reported as file + line + reason code, never the value, and the file stays out. What the person may bring back in the preview
// (include): a file or folder of the gitignore · personal · rebuildable · large groups, and a file whose hits are all of level 'check'
// — never a secret, never a 'block' shape, never a structure entry (enforced here, whatever the page sends).
// The token for the server comes over the link for each round (1 h) and reaches git only as a request header in GIT_CONFIG_*, for the
// folder's own address only (git.js authEnv).
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')
const { EventEmitter } = require('node:events')
const G = require('./git')
const SHAPES = require('./secret-shapes.json')
const PLACES = require('./kit-places.json')

const GROUPS = ['gitignore', 'secret', 'personal', 'rebuildable', 'large', 'structure']
const LOCAL_MS = 120_000
const NETWORK_MS = 600_000
const ASK_MS = 30_000 // the server's answer to sync:bind · sync:token · sync:unbind
const TAKE_MS = 180_000 // its answer to sync:pushed (it reindexes and finds the agent assets first)
const PICK_MS = 60 * 60_000
const SAMPLES = 5
const TOP = 40
const HITS_PER_FILE = 3
const MAX_FLAGGED = 200
const READERS = 12
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CASELESS = process.platform === 'darwin' || process.platform === 'win32'

const serverKey = (server) => crypto.createHash('sha1').update(String(server || '').replace(/\/+$/, '')).digest('hex').slice(0, 10)
// one person's shadow repositories apart from another's on the same computer and server (two people, one PC: neither shares nor removes
// the other's)
const personKey = (userId) => `u-${crypto.createHash('sha1').update(String(userId || '')).digest('hex').slice(0, 12)}`
// the snapshot's message: no machine name (a host name is the computer's, not something the folder's people need to see)
const SNAPSHOT_MESSAGE = '동기화'
const isInside = (child, parent) => { const r = path.relative(parent, child); return r === '' || (!!r && !r.startsWith('..') && !path.isAbsolute(r)) }
const samePath = (a, b) => (CASELESS ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b))
const split0 = (s) => String(s || '').split('\0').filter(Boolean)
const nfc = (s) => String(s).normalize('NFC')

// ---------- git in the shadow repository ----------
// the only subcommands run here: none writes into a work tree (the picked folder) — git itself never lists or reads `.git` there
const ALLOWED = new Set(['init', 'ls-files', 'check-ignore', 'update-index', 'write-tree', 'commit-tree', 'update-ref', 'rev-parse', 'fetch', 'push'])
// tests: every git call this module makes (sub, args, gitDir, workTree)
let tap = null
const setTap = (fn) => { tap = fn }
// the person's environment without git's own variables (another index, object folder, trace that could print a header …)
function baseEnv() {
  const env = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('GIT_') && k !== 'GIT_EXEC_PATH' && !k.startsWith('GIT_SSL_')) continue
    env[k] = v
  }
  return env
}
// for every call: no hooks, no signing, no fsmonitor, not the person's global excludes, no automatic gc — the shadow is the app's alone
function quietPairs(gitDir) {
  return [['core.hooksPath', path.join(gitDir, 'no-hooks')], ['core.fsmonitor', 'false'], ['core.untrackedCache', 'false'],
    ['core.excludesFile', path.join(gitDir, 'info', 'no-global-excludes')], ['core.ignoreCase', CASELESS ? 'true' : 'false'],
    ['core.precomposeUnicode', 'true'], ['commit.gpgSign', 'false'], ['push.gpgSign', 'false'], ['gc.auto', '0'], ['maintenance.auto', 'false'],
    ['submodule.recurse', 'false'], ['safe.directory', '*'], ['init.defaultBranch', 'main']]
}
function shadowGit(gitDir, workTree, args, { token = '', url = '', input = null, env = {}, timeout = LOCAL_MS, check = true } = {}) {
  const sub = args[0]
  if (!ALLOWED.has(sub)) return Promise.reject(new G.GitError(`git ${sub} is not used by the folder sync`))
  // (names as they are — `*` in a file name is no pattern; check-ignore takes plain paths and refuses the flag)
  const pre = sub === 'init' ? [] : [`--git-dir=${gitDir}`, ...(workTree ? [`--work-tree=${workTree}`] : []), ...(sub === 'check-ignore' ? [] : ['--literal-pathspecs'])]
  const full = [...pre, ...args]
  try { tap?.({ sub, args: full, gitDir, workTree }) } catch { /* tests */ }
  const e = { ...baseEnv(), GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '', LC_ALL: 'C', ...G.authEnv(token, quietPairs(gitDir), url), ...env }
  // (run from the app's own folder: nothing relative ever lands in the picked one)
  const cwd = path.dirname(gitDir)
  return new Promise((resolve, reject) => {
    let child
    try { child = spawn(G.gitPath(), full, { cwd, env: e, windowsHide: true }) } catch (err) { return reject(new G.GitError(err.message)) }
    const out = []; const errs = []
    let size = 0
    child.stdout.on('data', (d) => { size += d.length; if (size <= 256 * 1024 * 1024) out.push(d) })
    child.stderr.on('data', (d) => { if (errs.length < 64) errs.push(d) })
    const timer = setTimeout(() => { try { child.kill() } catch { /* gone */ } }, timeout)
    child.on('error', (err) => { clearTimeout(timer); reject(new G.GitError(err.code === 'ENOENT' ? 'git is not installed on this computer' : err.message)) })
    child.on('close', (code) => {
      clearTimeout(timer)
      const stdout = Buffer.concat(out).toString('utf8')
      if (code !== 0 && check) {
        let why = Buffer.concat(errs).toString('utf8').trim() || `exit ${code}`
        if (token) why = why.split(token).join('***')
        return reject(new G.GitError(`git ${sub} failed: ${why.slice(0, 400)}`))
      }
      resolve(stdout)
    })
    child.stdin.on('error', () => { /* it closed early */ })
    if (input != null) child.stdin.end(input)
    else child.stdin.end()
  })
}

// ---------- the rules (secret-shapes.json) ----------
const low = (a) => (Array.isArray(a) ? a.map((x) => String(x).toLowerCase()) : [])
function compileRules(raw = SHAPES) {
  const groups = {}
  for (const [g, r] of Object.entries(raw.groups || {})) {
    groups[g] = { names: new Set(low(r.names)), prefixes: low(r.prefixes), extensions: low(r.extensions), dirs: new Set(low(r.dirs)),
      paths: low(r.paths), dirPaths: low(r.dirPaths), keep: new Set(low(r.keep)) }
  }
  const shapes = (raw.shapes || []).map((s) => (s.kind === 'assignment' ? { ...s } : { ...s, re: new RegExp(s.pattern, s.flags || '') }))
  const check = (raw.check?.paths || []).map((c) => ({ path: String(c.path).toLowerCase(), reason: c.reason || 'check' }))
  const limits = { textMaxBytes: 1048576, largeFileBytes: 52428800, pushMaxBytes: 209715200, headMaxFiles: 20000, headMaxBytes: 1073741824, ...(raw.limits || {}) }
  const rules = { groups, shapes, check, limits, order: ['secret', 'personal', 'rebuildable'].filter((g) => groups[g]) }
  rules.patterns = patternsOf(rules)
  return rules
}
// the same rules as gitignore lines — for the shadow's info/exclude, and on ls-files' command line (where a `!` in the folder's own
// .gitignore cannot bring a secret back: command-line patterns come first)
function patternsOf(rules) {
  const out = []
  for (const g of rules.order) {
    const r = rules.groups[g]
    out.push(`# ${g}`)
    for (const n of r.names) out.push(n)
    for (const p of r.prefixes) out.push(`${p}*`)
    for (const x of r.extensions) out.push(`*${x}`)
    for (const d of r.dirs) out.push(`${d}/`)
    for (const p of r.paths) out.push(`**/${p}`)
    for (const p of r.dirPaths) out.push(`**/${p}/`)
    for (const k of r.keep) out.push(`!${k}`)
  }
  return out
}
// which of the app's groups a path falls in (a folder: isDir) — by its names only. Every part of the path is looked at, as git does
// with a pattern that has no slash (a folder named .ssh leaves out all that is in it).
function groupOf(rules, rel, isDir = false) {
  const segs = String(rel).toLowerCase().split('/').filter(Boolean)
  const full = segs.join('/')
  for (const g of rules.order) {
    const r = rules.groups[g]
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i]
      const last = i === segs.length - 1
      if (r.keep.has(s) && last) continue
      if (r.names.has(s)) return g
      if (r.prefixes.some((p) => s.startsWith(p)) && !r.keep.has(s)) return g
      if (r.extensions.some((x) => s.endsWith(x) && s.length > x.length)) return g
      if ((!last || isDir) && r.dirs.has(s)) return g
    }
    for (const p of r.paths) if (full === p || full.endsWith(`/${p}`)) return g
    for (const p of r.dirPaths) if (full === p ? isDir : (full.startsWith(`${p}/`) || full.includes(`/${p}/`) || (isDir && full.endsWith(`/${p}`)))) return g
  }
  return null
}
const checkOf = (rules, rel) => { const f = String(rel).toLowerCase(); const c = rules.check.find((x) => f === x.path || f.endsWith(`/${x.path}`)); return c ? c.reason : null }

// ---------- the shapes of keys (secret-shapes.json) ----------
function entropy(s) {
  const n = new Map()
  for (const ch of s) n.set(ch, (n.get(ch) || 0) + 1)
  let h = 0
  for (const c of n.values()) { const p = c / s.length; h -= p * Math.log2(p) }
  return h
}
// NAME=value in the dotenv · shell form (export NAME=value, quotes allowed): a long, evenly mixed value with no space that is not a path,
// an address or a reference to something else
const ASSIGN = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_.]*\s*=\s*(.*)$/
function assignmentHit(line, s) {
  const m = ASSIGN.exec(line)
  if (!m) return false
  let v = m[1].trim()
  const q = v[0]
  if ((q === '"' || q === "'") && v.lastIndexOf(q) > 0) v = v.slice(1, v.lastIndexOf(q))
  else { const hash = v.indexOf(' #'); if (hash >= 0) v = v.slice(0, hash).trim() }
  if (v.length < (s.minLength || 20) || /\s/.test(v)) return false
  if ('/.~$%<{'.includes(v[0]) || v.includes('://') || v.includes('${')) return false
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/].filter((r) => r.test(v)).length
  return classes >= (s.minClasses || 2) && entropy(v) >= (s.minEntropy || 3.6)
}
// [{line, reason, level}] — never the matched text
function shapeHits(rules, text) {
  const hits = []
  const lines = String(text).split('\n')
  for (let i = 0; i < lines.length && hits.length < HITS_PER_FILE; i++) {
    const line = lines[i]
    if (!line) continue
    for (const s of rules.shapes) {
      if (s.re ? s.re.test(line) : assignmentHit(line, s)) { hits.push({ line: i + 1, reason: s.id, level: s.level || 'check' }); break }
    }
  }
  return hits
}
const looksBinary = (buf) => buf.subarray(0, 8000).includes(0)

// ---------- agent assets (kit-places.json) ----------
// glob: '/'-separated, '*' inside one name, '**' any number of folders
function segMatch(pat, s) {
  if (!pat.includes('*')) return pat === s
  const parts = pat.split('*')
  if (!s.startsWith(parts[0])) return false
  let at = parts[0].length
  for (let k = 1; k < parts.length - 1; k++) { const j = s.indexOf(parts[k], at); if (j < 0) return false; at = j + parts[k].length }
  const last = parts[parts.length - 1]
  return s.length - last.length >= at && s.endsWith(last)
}
function globMatch(glob, rel) {
  const g = String(glob).split('/')
  const p = String(rel).split('/')
  const m = (gi, pi) => {
    if (gi === g.length) return pi === p.length
    if (g[gi] === '**') { for (let k = pi; k <= p.length; k++) if (m(gi + 1, k)) return true; return false }
    return pi < p.length && segMatch(g[gi], p[pi]) && m(gi + 1, pi + 1)
  }
  return m(0, 0)
}
const unquote = (v) => { const t = String(v).trim(); return (t.length > 1 && (t[0] === '"' || t[0] === "'") && t.endsWith(t[0])) ? t.slice(1, -1) : t }
// the YAML front matter's plain keys (name · description — a folded or literal block joined into one line)
function frontMatter(text) {
  const lines = String(text || '').replace(/^﻿/, '').split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return {}
  const out = {}
  let block = null
  for (let i = 1; i < lines.length && i < 300; i++) {
    const l = lines[i]
    if (l.trim() === '---' || l.trim() === '...') break
    if (block && (/^\s/.test(l) || !l.trim())) { if (l.trim()) out[block] = out[block] ? `${out[block]} ${l.trim()}` : l.trim(); continue }
    block = null
    const c = l.indexOf(':')
    if (c <= 0 || /^\s/.test(l)) continue
    const k = l.slice(0, c).trim()
    const v = l.slice(c + 1).trim()
    if (['', '>', '|', '>-', '|-', '>+', '|+'].includes(v)) { block = k; out[k] = ''; continue }
    out[k] = unquote(v)
  }
  return out
}
function kitName(place, rel) {
  const segs = rel.split('/')
  if (place.name === 'dir') return segs[segs.length - 2] || segs[segs.length - 1]
  if (place.name === 'command') {
    const under = place.base && rel.startsWith(`${place.base}/`) ? rel.slice(place.base.length + 1) : segs[segs.length - 1]
    return under.replace(/\.[^./]+$/, '').split('/').join(':')
  }
  return segs[segs.length - 1]
}
// a JSON settings file runs something only when one of runsKeys (dotted) is there and not empty (kit-places.json); unreadable: as the place says
const filled = (v) => v != null && v !== '' && v !== false && !(Array.isArray(v) && !v.length) && !(typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length)
async function runsOf(root, rel, place) {
  if (!place.runs || !Array.isArray(place.runsKeys)) return !!place.runs
  try {
    const st = await fsp.stat(path.join(root, ...rel.split('/')))
    if (st.size > 262144) return true
    const o = JSON.parse(await fsp.readFile(path.join(root, ...rel.split('/')), 'utf8'))
    return place.runsKeys.some((k) => filled(String(k).split('.').reduce((v, part) => (v && typeof v === 'object' ? v[part] : undefined), o)))
  } catch { return true }
}
// [{platform, type, path, name, description, runs}] — paths only, a name and description from the front matter where there is one
async function kitOf(root, rels, places = PLACES) {
  const out = []
  for (const rel of rels) {
    const place = (places.places || []).find((p) => globMatch(p.glob, rel))
    if (!place) continue
    let fm = {}
    if (place.frontMatter) {
      try {
        const fd = await fsp.open(path.join(root, ...rel.split('/')), 'r')
        try { const b = Buffer.alloc(16384); const { bytesRead } = await fd.read(b, 0, b.length, 0); fm = frontMatter(b.subarray(0, bytesRead).toString('utf8')) } finally { await fd.close() }
      } catch { /* unreadable: the path is enough */ }
    }
    out.push({ platform: place.platform, type: place.type, path: rel, name: String(fm.name || kitName(place, rel)).slice(0, 120),
      description: String(fm.description || '').slice(0, 300), runs: await runsOf(root, rel, place) })
  }
  return out
}

// ---------- the shadow repository ----------
// made once (bare: no work tree of its own — the picked folder is named as one on each call that reads it); its excludes and attributes
// written each round from the app's rules. info/attributes: the files are taken byte for byte — no line-ending change, no filter (LFS
// or another the person's git names), whatever the folder's .gitattributes says.
async function ensureShadow(gitDir, rules) {
  if (!fs.existsSync(path.join(gitDir, 'HEAD'))) {
    fs.mkdirSync(path.dirname(gitDir), { recursive: true })
    await shadowGit(gitDir, null, ['init', '-q', '--bare', '--template=', gitDir])
  }
  fs.mkdirSync(path.join(gitDir, 'info'), { recursive: true })
  fs.writeFileSync(path.join(gitDir, 'info', 'exclude'), `# Process GPT Lite — what a champion folder never uploads (secret-shapes.json)\n${rules.patterns.join('\n')}\n`)
  fs.writeFileSync(path.join(gitDir, 'info', 'attributes'), G.NEUTRAL)
}

// what the person chose in the preview: folder-relative paths ('/' between names), nothing outside the folder
function rels(list) {
  const out = []
  for (const x of Array.isArray(list) ? list : []) {
    const r = nfc(String(x || '').replace(/\\/g, '/')).replace(/^\/+|\/+$/g, '')
    if (!r || r.split('/').some((p) => p === '..' || p === '.' || p === '' || p.toLowerCase() === '.git')) continue
    if (!out.includes(r)) out.push(r)
    if (out.length >= 500) break
  }
  return out
}

// the files a refusal names: [{path, line, reason}] (server/lib/folders — a secret's name or a key's shape, never the value) or plain paths
function pathsOf(list) {
  const out = []
  for (const x of Array.isArray(list) ? list.slice(0, 50) : []) {
    const o = typeof x === 'string' ? { path: x } : (x && typeof x === 'object' ? x : null)
    const [p] = rels([o?.path])
    if (!p) continue
    out.push({ path: p, line: Number.isInteger(o.line) ? o.line : null, reason: o.reason ? String(o.reason).slice(0, 40) : null })
  }
  return out
}

async function pool(items, n, fn) {
  let i = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k) } }))
}

// git's own control files a folder may carry: a submodule list, LFS's settings (its lfs.url would name where git sends requests)
const CONTROL = new Set(['.gitmodules', '.lfsconfig'])
const baseName = (rel) => String(rel).split('/').pop().toLowerCase()

// the files under a folder the person brought back in (one the folder's .gitignore or the app's rebuildable group had left out as a whole)
async function walk(root, relDir, cb, depth = 0) {
  if (depth > 40) return
  let ents
  try { ents = await fsp.readdir(path.join(root, ...relDir.split('/')), { withFileTypes: true }) } catch { return }
  for (const d of ents) {
    const name = nfc(d.name)
    if (name.toLowerCase() === '.git') continue
    const rel = `${relDir}/${name}`
    if (d.isDirectory()) {
      if (fs.existsSync(path.join(root, ...rel.split('/'), '.git'))) { await cb(rel + '/', 'repo'); continue }
      await walk(root, rel, cb, depth + 1)
    } else await cb(rel, 'file')
  }
}

// The scan: what would go up from `root`, given the person's choices. → {preview, files:[rel], sizes:{rel: bytes}, report}
async function scan(root, { gitDir, rules = compileRules(), places = PLACES, include = [], exclude = [] } = {}) {
  root = path.resolve(root)
  await ensureShadow(gitDir, rules)
  const inc = rels(include)
  const exc = rels(exclude)
  const out = (rel) => exc.some((x) => rel === x || rel.startsWith(`${x}/`))
  const asked = (rel) => inc.includes(rel)
  const ex = rules.patterns.filter((p) => !p.startsWith('#')).map((p) => `--exclude=${p}`)
  // an index that does not exist: every file is "other" — the shadow's own index is left as it is
  const env = { GIT_INDEX_FILE: path.join(gitDir, `scan-${crypto.randomBytes(6).toString('hex')}.index`) }
  const listed = split0(await shadowGit(gitDir, root, ['ls-files', '-z', '--others', '--exclude-standard', ...ex], { env })).map(nfc)
  // (a folder that holds only left-out files comes with them listed after it: the files carry the reasons, the folder is dropped)
  const ignoredAll = split0(await shadowGit(gitDir, root, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory', ...ex], { env })).map(nfc)
  const ignored = ignoredAll.filter((e, i) => !(e.endsWith('/') && ignoredAll[i + 1]?.startsWith(e)))

  const excluded = Object.fromEntries(GROUPS.map((g) => [g, { count: 0, samples: [] }]))
  const leave = (g, rel) => { const e = excluded[g]; e.count++; if (e.samples.length < SAMPLES) e.samples.push(rel) }
  const files = new Map() // rel → size
  const decided = new Set() // (a path the person named and a folder of theirs may both bring the same file: it is judged once)
  const consider = async (rel, { lifted = '' } = {}) => {
    if (out(rel) || decided.has(rel)) return
    decided.add(rel)
    if (CONTROL.has(baseName(rel))) return leave('structure', rel)
    // (inside a folder the person brought back: the app's groups judged from there down — a .env in it still stays out; and a secret
    // is a secret wherever it is, whatever the person asked)
    const whole = groupOf(rules, rel)
    const g = lifted ? groupOf(rules, rel.slice(lifted.length + 1)) : whole
    if (whole === 'secret' || g === 'secret') return leave('secret', rel)
    if (g && !asked(rel)) return leave(g, rel)
    const abs = path.join(root, ...rel.split('/'))
    let st
    try { st = await fsp.lstat(abs) } catch { return }
    // (a link — to inside the folder or out of it — never goes up: only plain files do)
    if (st.isSymbolicLink()) return leave('structure', rel)
    if (!st.isFile()) return
    if (st.size > rules.limits.largeFileBytes && !asked(rel)) return leave('large', rel)
    files.set(rel, st.size)
  }
  // A folder git shows as one left-out entry is one a pattern names (dist/ in the folder's .gitignore, node_modules/ of the app's); any
  // other (git did not list what is in it) is looked into, so each file is counted under its own reason
  const whole = ignored.filter((e) => e.endsWith('/') && !groupOf(rules, e.slice(0, -1), true))
  const named = new Set()
  if (whole.length) {
    const said = (await shadowGit(gitDir, root, ['check-ignore', '-z', '-v', '-n', '--no-index', '--stdin'], { env, input: `${whole.map((e) => e.slice(0, -1)).join('\0')}\0`, check: false })).split('\0')
    for (let i = 0; i + 3 < said.length; i += 4) if (said[i] && said[i + 2] && !said[i + 2].startsWith('!')) named.add(nfc(said[i + 3]))
  }
  let looked = 0
  const lookInto = async (d) => {
    await walk(root, d, async (rel, kind) => {
      if (++looked > 20_000) return
      leave(kind === 'repo' ? 'structure' : (groupOf(rules, rel) || 'gitignore'), rel)
    })
  }
  for (const e of ignored) {
    const dir = e.endsWith('/')
    const r = dir ? e.slice(0, -1) : e
    const own = groupOf(rules, r, dir)
    const back = own === 'secret' ? [] : inc.filter((x) => x === r || x.startsWith(`${r}/`))
    if (!back.length) {
      const g = own
      if (!g && dir && !named.has(r)) await lookInto(r)
      else leave(g || 'gitignore', e)
      continue
    }
    for (const x of back) {
      if (x === r && !dir) await consider(x)
      else {
        let st = null
        try { st = await fsp.lstat(path.join(root, ...x.split('/'))) } catch { /* gone */ }
        if (st?.isDirectory()) await walk(root, x, (rel, kind) => (kind === 'repo' ? leave('structure', rel) : consider(rel, { lifted: x })))
        else if (st) await consider(x)
      }
    }
  }
  const pending = []
  for (const rel of listed) {
    if (rel.endsWith('/')) { if (!out(rel.slice(0, -1))) leave('structure', rel); continue } // another repository inside
    pending.push(rel)
  }
  await pool(pending, READERS, (rel) => consider(rel))

  // the shapes of keys in the text files that stay, and the files that go only when the person says so
  const flagged = []
  const flaggedFiles = new Set()
  const sure = new Set() // a file with a 'block' hit: it never goes up
  const sorted = [...files.keys()].sort()
  await pool(sorted, READERS, async (rel) => {
    const size = files.get(rel)
    const c = checkOf(rules, rel)
    if (c) { flaggedFiles.add(rel); if (flagged.length < MAX_FLAGGED) flagged.push({ path: rel, line: 0, reason: c, level: 'check' }) }
    if (!size || size > rules.limits.textMaxBytes) return
    let buf
    try { buf = await fsp.readFile(path.join(root, ...rel.split('/'))) } catch { return }
    if (looksBinary(buf)) return
    const hits = shapeHits(rules, buf.toString('utf8'))
    if (!hits.length) return
    flaggedFiles.add(rel)
    if (hits.some((h) => h.level === 'block')) sure.add(rel)
    for (const h of hits) if (flagged.length < MAX_FLAGGED) flagged.push({ path: rel, ...h })
  })
  flagged.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line))
  // what is flagged stays out — unless the person brought it back and none of its hits is a sure key ('block')
  let flaggedIn = 0
  for (const rel of flaggedFiles) {
    if (sure.has(rel) || !asked(rel)) files.delete(rel)
    else flaggedIn++
  }
  for (const f of flagged) f.includable = !sure.has(f.path)

  const kept = [...files.keys()].sort()
  const bytes = kept.reduce((n, r) => n + files.get(r), 0)
  const tops = new Map()
  for (const r of kept) {
    const i = r.indexOf('/')
    const k = i < 0 ? r : r.slice(0, i + 1)
    const t = tops.get(k) || { path: k, files: 0, bytes: 0 }
    t.files++; t.bytes += files.get(r)
    tops.set(k, t)
  }
  const warnings = []
  if (fs.existsSync(path.join(root, '.git'))) warnings.push('own_git')
  if (!kept.length) warnings.push('empty')
  const big = tooBig(rules, { files: kept.length, bytes })
  if (big) warnings.push(big)
  const kit = await kitOf(root, kept, places)
  const preview = {
    files: kept.length, bytes,
    top: [...tops.values()].sort((a, b) => (a.path < b.path ? -1 : 1)).slice(0, TOP),
    excluded: GROUPS.filter((g) => excluded[g].count).map((g) => ({ group: g, count: excluded[g].count, samples: excluded[g].samples })),
    flagged, flaggedIncluded: flaggedIn, kit, warnings,
  }
  const report = { files: kept.length, bytes, excluded: Object.fromEntries(GROUPS.map((g) => [g, excluded[g].count])), flagged: flaggedFiles.size - flaggedIn, flaggedIncluded: flaggedIn }
  return { preview, files: kept, report, flaggedIn }
}

// what the server would refuse for its size (secret-shapes.json limits: one push · the snapshot's whole tree) → 'too_big' | 'too_many' | null
// (the raw size against the push's limit: the first push carries every file)
function tooBig(rules, { files, bytes }) {
  const l = rules.limits
  if (bytes > l.pushMaxBytes || bytes > l.headMaxBytes) return 'too_big'
  if (files > l.headMaxFiles) return 'too_many'
  return null
}

// ---------- the snapshot ----------
// the shadow's index made exactly the scanned list (entries no longer in it dropped, the rest taken from the folder), its tree, and a
// commit on `parent` when the tree differs from the parent's → {commit, tree, changed}
async function snapshot(root, gitDir, { files, parent = null, author = {}, message }) {
  const keep = new Set(files)
  const cached = split0(await shadowGit(gitDir, root, ['ls-files', '-z'])).map(nfc)
  const gone = cached.filter((p) => !keep.has(p))
  if (gone.length) await shadowGit(gitDir, root, ['update-index', '-z', '--force-remove', '--stdin'], { input: `${gone.join('\0')}\0` })
  if (files.length) await shadowGit(gitDir, root, ['update-index', '-z', '--add', '--remove', '--replace', '--stdin'], { input: `${files.join('\0')}\0` })
  // only plain files go up: a file that became a link (or a repository) since the scan is dropped here, never recorded as one
  const odd = split0(await shadowGit(gitDir, null, ['ls-files', '-z', '-s'])).filter((l) => l.startsWith('120000 ') || l.startsWith('160000 ')).map((l) => nfc(l.slice(l.indexOf('\t') + 1)))
  if (odd.length) await shadowGit(gitDir, root, ['update-index', '-z', '--force-remove', '--stdin'], { input: `${odd.join('\0')}\0` })
  const tree = (await shadowGit(gitDir, null, ['write-tree'])).trim()
  const before = parent ? (await shadowGit(gitDir, null, ['rev-parse', `${parent}^{tree}`])).trim() : null
  if (parent ? tree === before : !files.length) return { commit: parent, tree, changed: false }
  const name = String(author.name || 'Process GPT Lite').slice(0, 80)
  const email = String(author.email || 'desktop@pgpt-lite.local').slice(0, 120)
  const env = { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email }
  const commit = (await shadowGit(gitDir, null, ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', message], { env })).trim()
  await shadowGit(gitDir, null, ['update-ref', 'refs/heads/main', commit])
  return { commit, tree, changed: true }
}

// the server's main and this computer's sync branch, fetched into the shadow (refs/remotes/lite/…) → {main, tip}
async function fetchServer(gitDir, { url, token, branch, main }) {
  const cut = branch.lastIndexOf('/') + 1
  const specs = [`+refs/heads/${branch.slice(0, cut)}*:refs/remotes/lite/sync/*`]
  if (main) specs.unshift('+refs/heads/main:refs/remotes/lite/main')
  await shadowGit(gitDir, null, ['fetch', '-q', '--no-tags', '--no-recurse-submodules', '--prune', url, ...specs], { token, url, timeout: NETWORK_MS })
  const at = async (ref) => (await shadowGit(gitDir, null, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { check: false })).trim() || null
  return { main: main ? await at('refs/remotes/lite/main') : null, tip: await at(`refs/remotes/lite/sync/${branch.slice(cut)}`) }
}
async function pushHead(gitDir, { url, token, branch, commit }) {
  await shadowGit(gitDir, null, ['push', '--porcelain', '--no-verify', url, `${commit}:refs/heads/${branch}`], { token, url, timeout: NETWORK_MS })
}

// ---------- the system dialog before the first upload (main.js shows it) ----------
const sizeText = (b) => (b >= 100 * 1024 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`)
// 로 / 으로 after the folder's name (a final consonant other than ㄹ takes 으로)
function ro(name) {
  const c = String(name || '').trim().slice(-1).charCodeAt(0)
  const jong = c >= 0xac00 && c <= 0xd7a3 ? (c - 0xac00) % 28 : 0
  return jong && jong !== 8 ? '으로' : '로'
}
// what goes up and where — and, when the person brought back files the preview flagged (only 'check' ones can be), how many of them
// go with it → {message, detail}
function uploadQuestion({ files = 0, bytes = 0, folderName = '', host = '', report = {}, flaggedIn = 0, lang = 'ko' } = {}) {
  const ko = lang !== 'en'
  const name = String(folderName || '').slice(0, 80)
  const message = ko
    ? `파일 ${files}개(${sizeText(bytes)})를 ${host} 의 폴더 '${name}'${ro(name)} 올립니다${flaggedIn ? ` — 확인이 필요한 파일 ${flaggedIn}개도 함께 올라가요` : ''}`
    : `Upload ${files} files (${sizeText(bytes)}) to the folder '${name}' on ${host}?${flaggedIn ? ` ${flaggedIn} of them were flagged to check.` : ''}`
  const left = (report.excluded?.secret || 0) + (report.excluded?.personal || 0)
  const out = report.flagged || 0
  const detail = ko
    ? [`이 컴퓨터의 폴더는 읽기만 하고 아무것도 쓰지 않아요.`, left ? `비밀 · 개인 설정으로 보이는 ${left}개는 올리지 않아요.` : '', out ? `확인이 필요한 파일 ${out}개는 빼고 올려요.` : '',
      flaggedIn ? `함께 올리기로 고른 확인 파일 ${flaggedIn}개는 그 안의 글 그대로 서버에 남아요.` : ''].filter(Boolean).join(' ')
    : [`The folder on this computer is only read, nothing is written to it.`, left ? `${left} files that look secret or personal stay here.` : '', out ? `${out} files to check stay here.` : '',
      flaggedIn ? `The ${flaggedIn} flagged files you chose to include go to the server as they are.` : ''].filter(Boolean).join(' ')
  return { message, detail }
}

// ---------- the folders of one person on one server ----------
// a folder's state on this computer: synced (up as it is) · pushing · behind (the server's main moved and could not take this upload in —
// receiving is P1) · paused (on the web) · blocked (the server or this computer stopped it — why) · missing (the picked folder is gone)
const stopState = (why) => (why === 'paused' ? 'paused' : 'blocked')
// store: this server's and this person's entries in the app's settings (settings.folderStore) — the only place a path is kept.
// send(msg): the link to the server (runner/link.js). Events: 'state' (list()).
class FolderSync extends EventEmitter {
  constructor({ dataDir, server, userId, store, send = () => false, device = {}, user = () => null, log = () => {}, rules = compileRules(), places = PLACES,
    askMs = ASK_MS, takeMs = TAKE_MS } = {}) {
    super()
    this.server = String(server || '').replace(/\/+$/, '')
    this.userId = String(userId || '')
    this.dataDir = path.resolve(dataDir)
    // <data>/sync/<server10>/<person>/<folderId>.git — and that person's own scratch repository for previews
    this.root = path.join(this.dataDir, 'sync', serverKey(this.server), personKey(this.userId))
    this.store = store
    this.sendFn = send
    void device
    this.userFn = user
    this.logFn = log
    this.rules = rules
    this.places = places
    this.askMs = askMs
    this.takeMs = takeMs
    this.picks = new Map()
    this.waiters = new Set()
    this.locks = new Map()
    this.busy = new Set()
    this.secrets = new Set()
    this.connected = false
    this.other = false
    this.stopped = false
  }

  log(...a) { let s = a.join(' '); for (const t of this.secrets) if (t) s = s.split(t).join('***'); this.logFn(s) }
  changed() { this.emit('state', this.list()) }
  handles(msg) { return typeof msg?.type === 'string' && msg.type.startsWith('sync:') }
  // the link is up: the server says who this desktop is signed in as — another person than the one these folders are for stops them
  linkUp(user) {
    this.connected = true
    this.other = !!(user?.id && this.userId && String(user.id) !== this.userId)
    this.changed()
  }
  linkDown() {
    this.connected = false
    for (const w of [...this.waiters]) w.done({ why: 'offline' })
    this.changed()
  }
  stop() {
    this.stopped = true
    this.connected = false
    for (const w of [...this.waiters]) w.done({ why: 'stopped' })
    this.picks.clear()
  }
  gitDirOf(folderId) { return path.join(this.root, `${folderId}.git`) }
  pathOf(folderId) { return this.store.get(String(folderId || ''))?.path || null }
  list() {
    return this.store.all().map((e) => ({ folderId: e.folderId, label: e.label, state: this.busy.has(e.folderId) ? 'pushing' : (e.state || 'synced'),
      lastPushedAt: e.lastPushedAt || null, why: e.why || null, ...(e.paths?.length ? { paths: e.paths } : {}), files: e.files ?? null, bytes: e.bytes ?? null }))
  }
  mark(folderId, patch) {
    const e = this.store.get(folderId)
    if (!e) return
    this.store.put({ ...e, ...patch })
    this.changed()
  }
  // one thing at a time per folder
  locked(key, fn) {
    const prev = this.locks.get(key) || Promise.resolve()
    const run = prev.catch(() => {}).then(fn)
    const tail = run.catch(() => {})
    this.locks.set(key, tail)
    tail.then(() => { if (this.locks.get(key) === tail) this.locks.delete(key) })
    return run
  }
  // a message to the server and its answer (one of `types`, or sync:refused) for that folder
  ask(msg, types, ms = this.askMs) {
    return new Promise((resolve) => {
      const w = { folderId: String(msg.folderId), types: new Set([...types, 'sync:refused']) }
      w.done = (m) => { clearTimeout(w.timer); this.waiters.delete(w); resolve(m) }
      w.timer = setTimeout(() => w.done({ why: 'timeout' }), ms)
      this.waiters.add(w)
      if (this.stopped || !this.sendFn(msg)) w.done({ why: 'offline' })
    })
  }
  // what the server sends on the link (sync:bound · token · taken · behind · refused · unbound)
  handle(msg) {
    const id = String(msg?.folderId || '')
    for (const w of this.waiters) if (w.folderId === id && w.types.has(msg.type)) { w.done(msg); return }
    // (an answer that came after its wait, or the server's own word)
    if (msg.type === 'sync:refused') this.mark(id, { state: stopState(msg.why), why: String(msg.why || 'refused'), paths: pathsOf(msg.paths) })
    else if (msg.type === 'sync:taken') this.mark(id, { state: 'synced', why: null, paths: [], taken: this.store.get(id)?.head || null })
    else if (msg.type === 'sync:behind') this.mark(id, { state: 'behind', why: 'behind' })
    else if (msg.type === 'sync:resumed') this.mark(id, { state: 'synced', why: null, paths: [] })
    else if (msg.type === 'sync:unbound' && this.store.get(id)) this.forget(id)
  }

  // the folder the person picked in the system dialog: checked, remembered for this window (an id — the page never sees the path) and
  // scanned → {pickId, label, preview} | {error}
  async pick(dir) {
    if (this.stopped) return { error: 'stopped' }
    if (this.other) return { error: 'other_user' }
    const why = await this.unsafe(dir)
    if (why) return { error: why }
    const real = nfc(await fsp.realpath(path.resolve(dir)))
    for (const [k, p] of this.picks) if (Date.now() - p.at > PICK_MS) this.picks.delete(k)
    if (this.picks.size >= 20) this.picks.delete(this.picks.keys().next().value)
    const pickId = crypto.randomUUID()
    const label = path.basename(real) || real
    this.picks.set(pickId, { dir: real, label, at: Date.now() })
    const s = await this.scanOf(real, this.scratch(), [], [])
    return { pickId, label, preview: s.preview }
  }
  async preview(pickId, { include = [], exclude = [] } = {}) {
    const p = this.picks.get(String(pickId || ''))
    if (!p) return { error: 'no_pick' }
    return (await this.scanOf(p.dir, this.scratch(), include, exclude)).preview
  }
  scratch() { return path.join(this.root, 'scan.git') }
  // not the whole disk, the home folder, or a folder that holds (or is inside) the app's own data
  async unsafe(dir) {
    if (!dir || !path.isAbsolute(String(dir))) return 'not_found'
    let real
    try { real = await fsp.realpath(String(dir)) } catch { return 'not_found' }
    const st = await fsp.stat(real).catch(() => null)
    if (!st) return 'not_found'
    if (!st.isDirectory()) return 'not_folder'
    if (path.parse(real).root === real || (CASELESS ? path.parse(real).root.toLowerCase() === real.toLowerCase() : false)) return 'system_folder'
    let home = os.homedir()
    try { home = await fsp.realpath(home) } catch { /* as it is */ }
    if (samePath(real, home)) return 'home_folder'
    let data = this.dataDir
    try { fs.mkdirSync(data, { recursive: true }); data = await fsp.realpath(data) } catch { /* as it is */ }
    const app = path.dirname(data)
    if (isInside(data, real) || isInside(real, app)) return 'app_folder'
    try { await fsp.access(real, fs.constants.R_OK) } catch { return 'not_readable' }
    return null
  }
  async scanOf(dir, gitDir, include, exclude) {
    return scan(dir, { gitDir, rules: this.rules, places: this.places, include, exclude })
  }

  // the first upload: the person's yes (confirm — main's system dialog), the server's source row (sync:bind), then one round
  // → {ok:true, folderId, pushed:{files, bytes}} | {ok:false, why}
  async bind({ pickId, folderId, folderName = '', include = [], exclude = [] } = {}, { confirm } = {}) {
    if (this.stopped) return { ok: false, why: 'stopped' }
    if (this.other) return { ok: false, why: 'other_user' }
    const p = this.picks.get(String(pickId || ''))
    if (!p) return { ok: false, why: 'no_pick' }
    folderId = String(folderId || '')
    if (!UUID.test(folderId)) return { ok: false, why: 'invalid' }
    if (this.store.get(folderId) || this.store.all().some((e) => samePath(e.path, p.dir))) return { ok: false, why: 'already_bound' }
    if (!this.connected) return { ok: false, why: 'offline' }
    const inc = rels(include)
    const exc = rels(exclude)
    return this.locked(folderId, async () => {
      const s = await this.scanOf(p.dir, this.scratch(), inc, exc)
      if (!s.report.files) return { ok: false, why: 'empty' }
      const big = tooBig(this.rules, s.report)
      if (big) return { ok: false, why: big }
      let yes = false
      try { yes = typeof confirm === 'function' && (await confirm({ files: s.report.files, bytes: s.report.bytes, folderName: String(folderName || p.label).slice(0, 120), label: p.label, report: s.report, flaggedIn: s.flaggedIn })) === true } catch { yes = false }
      if (!yes) return { ok: false, why: 'cancelled' }
      const b = await this.ask({ type: 'sync:bind', folderId, label: p.label }, ['sync:bound'])
      if (b.type !== 'sync:bound') return { ok: false, why: String(b.why || 'refused') }
      this.store.put({ folderId, path: p.dir, label: p.label, include: inc, exclude: exc, sourceId: b.sourceId || null, branch: b.branch || null, state: 'synced', boundAt: new Date().toISOString() })
      this.picks.delete(String(pickId))
      this.changed()
      const r = await this.round(folderId)
      if (!r.ok) {
        // nothing of it stays: the page deletes the folder it made, the server its source row
        await this.ask({ type: 'sync:unbind', folderId }, ['sync:unbound'], 5000).catch(() => {})
        this.forget(folderId)
        return { ok: false, why: r.why }
      }
      return { ok: true, folderId, pushed: r.pushed, ...(r.pending ? { pending: true } : {}) }
    })
  }

  // 「지금 올리기」
  async syncNow(folderId) {
    folderId = String(folderId || '')
    if (this.other) return { ok: false, why: 'other_user' }
    if (!this.store.get(folderId)) return { ok: false, why: 'not_bound' }
    return this.locked(folderId, () => this.round(folderId))
  }

  // one round: scan → the token → fetch → snapshot → push → the server takes it (sync:pushed → sync:taken · behind · refused)
  async round(folderId) {
    const e = this.store.get(folderId)
    if (!e) return { ok: false, why: 'not_bound' }
    if (!this.connected) return { ok: false, why: 'offline' }
    this.busy.add(folderId)
    this.changed()
    try {
      let st = null
      try { st = await fsp.stat(e.path) } catch { /* moved or deleted */ }
      if (!st?.isDirectory()) { this.mark(folderId, { state: 'missing', why: 'folder_missing' }); return { ok: false, why: 'folder_missing' } }
      const gitDir = this.gitDirOf(folderId)
      const s = await this.scanOf(e.path, gitDir, e.include, e.exclude)
      const big = tooBig(this.rules, s.report)
      if (big) { this.mark(folderId, { state: 'blocked', why: big }); return { ok: false, why: big } }
      const t = await this.ask({ type: 'sync:token', folderId }, ['sync:token'])
      if (t.type !== 'sync:token' || !t.token) {
        const why = String(t.why || 'refused')
        if (!['offline', 'timeout', 'stopped'].includes(why)) this.mark(folderId, { state: stopState(why), why })
        return { ok: false, why }
      }
      this.secrets.add(t.token)
      const url = this.urlOf(t)
      const branch = String(t.branch || e.branch || '')
      G.checkRef(branch)
      if (!branch.startsWith('pgpt-agent/sync-')) throw new G.GitError('not a sync branch')
      const { main, tip } = await fetchServer(gitDir, { url, token: t.token, branch, main: t.main || null })
      const parent = tip || main || null
      const person = this.userFn() || {}
      const author = { name: t.person?.name || person.name || 'Process GPT Lite', email: t.person?.email || `${this.userId || 'desktop'}@users.pgpt-lite.local` }
      const snap = await snapshot(e.path, gitDir, { files: s.files, parent, author, message: SNAPSHOT_MESSAGE })
      const pushed = { files: s.report.files, bytes: s.report.bytes }
      // nothing new, and the server already took what is on the branch
      if (!snap.changed && (!tip || tip === e.taken)) {
        this.mark(folderId, { state: 'synced', why: null, files: pushed.files, bytes: pushed.bytes })
        return { ok: true, pushed, changed: false }
      }
      const head = snap.changed ? snap.commit : tip
      if (snap.changed) await pushHead(gitDir, { url, token: t.token, branch, commit: head })
      this.mark(folderId, { head, branch })
      const r = await this.ask({ type: 'sync:pushed', folderId, head, report: s.report }, ['sync:taken', 'sync:behind'], this.takeMs)
      const at = new Date().toISOString()
      if (r.type === 'sync:taken') { this.mark(folderId, { state: 'synced', why: null, paths: [], taken: head, lastPushedAt: at, ...pushed }); return { ok: true, pushed } }
      if (r.type === 'sync:behind') { this.mark(folderId, { state: 'behind', why: 'behind', lastPushedAt: at, ...pushed }); return { ok: true, pushed, behind: true } }
      if (r.type === 'sync:refused') { const why = String(r.why || 'refused'); const paths = pathsOf(r.paths); this.mark(folderId, { state: stopState(why), why, paths }); return { ok: false, why, ...(paths.length ? { paths } : {}) } }
      // (up, but the server has not said yet: it says later — handle())
      this.mark(folderId, { state: 'synced', why: null, lastPushedAt: at, ...pushed })
      return { ok: true, pushed, pending: true }
    } catch (err) {
      this.log(`[folders] ${String(folderId).slice(0, 8)}: ${err.message}`)
      this.mark(folderId, { state: 'blocked', why: 'failed' })
      return { ok: false, why: 'failed' }
    } finally {
      this.busy.delete(folderId)
      this.changed()
    }
  }
  urlOf(t) {
    const u = String(t.url || t.path || '')
    return G.checkUrl(u.startsWith('/') ? `${this.server}${u}` : u)
  }

  // 「연결 끊기」: the server's source row, then this computer's record and shadow repository — the picked folder and the Lite folder
  // stay as they are
  async unbind(folderId) {
    folderId = String(folderId || '')
    if (!this.store.get(folderId)) return { ok: true }
    return this.locked(folderId, async () => {
      if (this.connected) await this.ask({ type: 'sync:unbind', folderId }, ['sync:unbound'])
      this.forget(folderId)
      return { ok: true }
    })
  }
  forget(folderId) {
    if (!UUID.test(String(folderId))) return
    this.store.drop(folderId)
    const dir = this.gitDirOf(folderId)
    if (isInside(dir, this.root) && dir !== this.root) { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch (e) { this.log(`[folders] ${e.message}`) } }
    this.changed()
  }
}

module.exports = { FolderSync, scan, snapshot, fetchServer, pushHead, ensureShadow, shadowGit, compileRules, groupOf, shapeHits, assignmentHit, frontMatter, globMatch, kitOf, uploadQuestion,
  patternsOf, serverKey, setTap, ALLOWED, GROUPS }
