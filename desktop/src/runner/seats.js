'use strict'
// 작업본은 한 곳에 — a variation's working copy on this computer (design: 작업실을 내 PC 에서 P1; spec openspec/specs/variation-seats).
// A variation (one branch of a shared folder) is changed in one place at a time — its seat. When the person's seat is this computer, the
// app keeps that variation's working copy in its own data folder and nowhere else (never in a folder of the person's):
//   <data>/folders/<server10>/<person>/<folder8>/repo           the folder's objects (bare — fetched, kept for the next time)
//   <data>/folders/<server10>/<person>/<folder8>/wt/<var8>-<title>   the working copy (git worktree) — one per variation id
// The person changes it with their own tools (Finder, their terminal, their claude · codex); the app does only one thing to it: it commits
// what is there as it is and sends it up — on its own when the files went quiet (60 s) or a CLI's turn ended there (save points, a switch
// per variation), when the person presses 「지금 올리기」, and when the seat goes back (「돌려놓기」). It never resets, cleans or checks out
// anything in the working copy (the git commands it runs are a fixed list — `wcGit`).
// The server decides the seat (server/lib/folders/seats.js) and says so over the link (seat:*):
//   seat:prepare  fetch the variation's branch and add its working copy → seat:ready → seat:held
//   save point    commit as is → seat:token (1 h, this variation at this epoch only) → push pgpt-agent/seat-<var8>-<epoch>/head →
//                 seat:pushed → seat:taken (the server moved the variation's branch forward) | seat:refused (diverged · secret · …)
//   돌려놓기       the same, then seat:release → seat:released → what git does not carry goes to the app's trash (30 days), the working
//                 copy goes
//   seat:list     the seats this computer holds (each time the link comes up, and when one changed elsewhere): a working copy whose seat
//                 is gone (taken elsewhere, moved on) is never thrown away and never mixed in — what it has beyond what the server took goes
//                 up once more as a variation of its own (seat:token for 'left' → push pgpt-agent/left-<var8>-<dev8>/head → seat:left →
//                 「<title> — <this PC>에 남아 있던 변경」), then the working copy goes
// What comes out of a commit (and stays on disk as it is, counted as 「확인이 필요해요」): links and repositories inside, git's control files
// (.gitmodules · .lfsconfig), files a secret's name or a key's shape gives away (secret-shapes.json — the same list the server checks), and
// files over 50 MB. The token goes to git only as a request header for the folder's own address (git.js authEnv); no remote keeps it, so
// a `git push` the person types never reaches the server — uploads go through the app.
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn, execFile } = require('node:child_process')
const G = require('./git')
const SY = require('./sync')
const { Uploader } = require('./upload')

const LOCAL_MS = 120_000
const NETWORK_MS = 600_000
const QUIET_MS = 60_000
const STATUS_MS = 10_000
const SCAN_MS = 5 * 60_000
const TURN_MS = 3_000
const TURN_WAIT_MS = 120_000
const TAKE_MS = 180_000
const OPEN_MS = 120_000
const TRASH_DAYS = 30
const TRASH_MAX_MB = 2048
const TRASH_EVERY_MS = 6 * 3600_000
const PREPARE_BEAT_MS = 30_000
const LEFT_RETRY_MS = 5 * 60_000
// what a trash folder holds (the end of its name): given · gone — a working copy the server has everything of (only what this PC alone had
// is left in it); left — changes let go that never reached the server; orphan · unfinished — a folder found with no record, a copy that never
// finished. Every one stays its 30 days: even given and gone hold exactly what the server lacks. Over its size the person is told instead.
// Two names that are one file on this computer: only macOS treats a decomposed (NFD) Hangul name and its composed (NFC) form as one file;
// case only where the disk does not tell it apart (the repository's core.ignorecase — git sets it by trying the disk). → fold(path) → key
const foldFor = (platform = process.platform, caseless = false) => (p) => { let n = String(p); if (platform === 'darwin') n = n.normalize('NFC'); return caseless ? n.toLowerCase() : n }
// a rebuildable folder that is one only beside what builds it (target/ is Cargo's · Maven's · sbt's · Leiningen's; venv/ holds pyvenv.cfg);
// any other folder of that name is the person's
const BUILD_FILES = ['Cargo.toml', 'pom.xml', 'build.sbt', 'project.clj']
const REBUILT_WHEN = {
  target: (parent) => BUILD_FILES.some((f) => fs.existsSync(path.join(parent, f))),
  venv: (_, d) => fs.existsSync(path.join(d, 'pyvenv.cfg')),
  '.venv': (_, d) => fs.existsSync(path.join(d, 'pyvenv.cfg')),
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CONTROL = new Set(['.gitmodules', '.lfsconfig'])
// the commits the app makes (their author is the person; no machine name in them)
const SAVE_MESSAGE = '저장 지점'
const RELEASE_MESSAGE = '돌려놓기'
const LEFT_MESSAGE = '남아 있던 변경'

const split0 = (s) => String(s || '').split('\0').filter(Boolean)
// whether an entry's working copy was added completely (a record from before `added` was kept: anything past preparing was)
const isAdded = (e) => e?.added === true || (e?.added === undefined && !!e?.state && e.state !== 'preparing')
const isInside = (child, parent) => { const r = path.relative(parent, child); return !!r && !r.startsWith('..') && !path.isAbsolute(r) }
const var8 = (vid) => String(vid).slice(0, 8)
// (the whole variation id: two variations whose ids start alike never share a branch)
const seatBranch = (vid, epoch) => `pgpt-agent/seat-${vid}-${Number(epoch)}/head`
// a working copy's folder name: the variation's id first (one place per variation), its title after it so the person knows it in Finder
const titleSlug = (title) => String(title || '').normalize('NFC').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 24)
// how Claude Code names a folder under <config>/projects: its real path, every character but a letter or digit made '-'
const claudeKey = (dir) => String(dir).replace(/[^A-Za-z0-9]/g, '-')
const day = (d = new Date()) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`

// ---------- git in a working copy (and its folder's repository) ----------
// the only subcommands run here: none rewrites the working tree the person works in (no reset · clean · checkout · restore · stash · rebase
// · merge · switch · pull); `worktree` only adds, removes or lists one of the app's own
const ALLOWED = new Set(['init', 'config', 'fetch', 'worktree', 'add', 'commit', 'rev-parse', 'rev-list', 'status', 'push', 'update-ref', 'update-index',
  'symbolic-ref', 'ls-files', 'ls-tree', 'diff', 'diff-index', 'for-each-ref'])
// of the person's own git settings, only what reaching their server needs is taken (git config --get-urlmatch http <server>): a proxy and
// the certificates a company network puts in front of it — everything else stays cut off
const NET_KEYS = /^http\.(proxy|sslcainfo|sslcapath|sslbackend|schannel[a-z]*)$/i
const WORKTREE = new Set(['add', 'remove', 'prune', 'list'])
let tap = null
const setTap = (fn) => { tap = fn }
function baseEnv() {
  const env = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('GIT_') && k !== 'GIT_EXEC_PATH' && !k.startsWith('GIT_SSL_')) continue
    env[k] = v
  }
  return env
}
// every call: links as plain files, no hooks, no signing, no submodules, protocol v0, no automatic gc — and nothing of the person's own git
// settings (GIT_CONFIG_GLOBAL · NOSYSTEM below): no redirect followed, every object fetched is checked, no tag goes along with a push
function quietPairs(hooks) {
  return [['core.symlinks', 'false'], ['core.hooksPath', hooks], ['core.fsmonitor', 'false'], ['core.precomposeUnicode', 'true'], ['commit.gpgSign', 'false'],
    ['push.gpgSign', 'false'], ['gc.auto', '0'], ['maintenance.auto', 'false'], ['submodule.recurse', 'false'], ['fetch.recurseSubmodules', 'false'],
    ['push.recurseSubmodules', 'no'], ['protocol.version', '0'], ['advice.detachedHead', 'false'], ['init.defaultBranch', 'main'],
    ['http.followRedirects', 'false'], ['fetch.fsckObjects', 'true'], ['transfer.fsckObjects', 'true'], ['push.followTags', 'false'], ['tag.gpgSign', 'false']]
}
// (where the person's global and system git settings would be: none — a push option, a credential helper, an alias of theirs never applies)
const NO_CONFIG = process.platform === 'win32' ? 'NUL' : '/dev/null'
// A call in a working copy (cwd, no gitDir) never looks for a repository above it: GIT_CEILING_DIRECTORIES is the folder the working copies
// sit in, so a working copy whose .git went missing makes git fail — never find the person's own repository further up (a dotfiles one at
// ~) and commit there.
function wcGit(args, { gitDir = null, cwd, hooks, token = '', url = '', input = null, env = {}, timeout = LOCAL_MS, check = true, ceiling = null, net = [] } = {}) {
  const sub = args[0]
  if (!ALLOWED.has(sub) || (sub === 'worktree' && !WORKTREE.has(args[1]))) return Promise.reject(new G.GitError(`git ${sub}${sub === 'worktree' ? ` ${args[1]}` : ''} is not used on a working copy`))
  const full = [...(gitDir ? [`--git-dir=${gitDir}`] : []), ...args]
  const pairs = [...quietPairs(hooks), ...net.filter(([k]) => NET_KEYS.test(k))]
  const fenced = { GIT_CONFIG_GLOBAL: NO_CONFIG, GIT_CONFIG_NOSYSTEM: '1', ...(ceiling || (cwd && !gitDir) ? { GIT_CEILING_DIRECTORIES: ceiling || path.dirname(path.resolve(cwd)) } : {}) }
  try { tap?.({ sub, args: full, gitDir, cwd, env: { ...fenced }, config: Object.fromEntries(pairs) }) } catch { /* tests */ }
  const e = { ...baseEnv(), GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '', LC_ALL: 'C', ...fenced, ...G.authEnv(token, pairs, url), ...env }
  return new Promise((resolve, reject) => {
    let child
    try { child = spawn(G.gitPath(), full, { cwd, env: e, windowsHide: true }) } catch (err) { return reject(new G.GitError(err.message)) }
    const out = []; const errs = []
    child.stdout.on('data', (d) => out.push(d))
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
    child.stdin.on('error', () => { /* closed early */ })
    if (input != null) child.stdin.end(input)
    else child.stdin.end()
  })
}

// ---------- a CLI's turns in the working copy (save points at a turn's end) ----------
// Claude Code writes each session to <config>/projects/<folder>/<session>.jsonl, Codex to <CODEX_HOME>/sessions/Y/M/D/rollout-*.jsonl (its
// session_meta names the folder). A turn ends at an assistant entry with stop_reason end_turn (or the Stop hook's summary) · Codex's
// task_complete; it starts at a person's prompt. Only these records are read — never the screen, and nothing of them leaves this computer.
// One scanner (TurnHub) for all the working copies of this computer: one timer, the Codex sessions looked at once for everyone. Files that
// were there when a working copy started to be watched are read from their end (a turn that already ended is no save point); a Codex
// rollout is identified from its first 64 KB only, and one that says no folder is remembered and not read again.
const META_BYTES = 64 * 1024
const readLines = (f, file, size) => {
  if (size < f.off) { f.off = 0; f.partial = '' }
  if (size === f.off) return []
  const fd = fs.openSync(file, 'r')
  try {
    const b = Buffer.alloc(Math.min(size - f.off, 8 * 1024 * 1024))
    fs.readSync(fd, b, 0, b.length, f.off)
    f.off += b.length
    const lines = (f.partial + b.toString('utf8')).split('\n')
    f.partial = lines.pop()
    return lines.filter((l) => l.trim()).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  } finally { fs.closeSync(fd) }
}
const sizeOf = (file) => { try { return fs.statSync(file).size } catch { return -1 } }
const realOf = (p) => { try { return fs.realpathSync(p) } catch { return path.resolve(p) } }
class TurnWatch {
  constructor(dir, { claudeHome, onEnd = () => {}, onStart = () => {} } = {}) {
    this.dir = realOf(dir)
    this.claudeDir = claudeHome ? path.join(claudeHome, 'projects', claudeKey(this.dir)) : null
    this.onEnd = onEnd
    this.onStart = onStart
    this.files = new Map() // file → {off, partial}
    this.busy = false
    this.lastEnd = 0
    this.snapshot()
  }
  // (the sessions already there: only what they write from now on)
  snapshot() {
    if (!this.claudeDir) return
    let names = []
    try { names = fs.readdirSync(this.claudeDir) } catch { return }
    for (const n of names) if (n.endsWith('.jsonl')) { const file = path.join(this.claudeDir, n); this.files.set(file, { off: Math.max(0, sizeOf(file)), partial: '' }) }
  }
  pollClaude() {
    if (!this.claudeDir) return
    let names = []
    try { names = fs.readdirSync(this.claudeDir) } catch { return }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue
      const file = path.join(this.claudeDir, n)
      const size = sizeOf(file)
      if (size < 0) continue
      let f = this.files.get(file)
      if (!f) { f = { off: 0, partial: '' }; this.files.set(file, f) } // (a session that began after: all of it)
      for (const e of readLines(f, file, size)) this.claude(e)
    }
  }
  claude(e) {
    if (e?.type === 'user' && !e.isMeta) {
      const c = e.message?.content
      if (typeof c === 'string' || (Array.isArray(c) && !c.some((b) => b?.type === 'tool_result'))) this.start_()
    } else if (e?.type === 'assistant' && ['end_turn', 'stop_sequence'].includes(e.message?.stop_reason)) this.end()
    else if (e?.type === 'system' && ['stop_hook_summary', 'turn_duration'].includes(e.subtype)) this.end()
  }
  codex(e) {
    if (e?.type !== 'event_msg') return
    if (e.payload?.type === 'user_message') this.start_()
    else if (e.payload?.type === 'task_complete') this.end()
  }
  start_() { if (!this.busy) { this.busy = true; try { this.onStart() } catch { /* the owner's */ } } }
  // (one turn's end said twice — end_turn, then the Stop hook's summary — is one end)
  end() {
    const now = Date.now()
    const again = !this.busy && now - this.lastEnd < 2000
    this.busy = false
    this.lastEnd = now
    if (!again) try { this.onEnd() } catch { /* the owner's */ }
  }
}
class TurnHub {
  constructor({ claudeHome = null, codexHome = null, every = TURN_MS } = {}) {
    this.claudeHome = claudeHome
    this.codexHome = codexHome
    this.every = every
    this.watchers = new Map() // key → TurnWatch
    this.codexFiles = new Map() // file → {kind: 'codex' | 'other' | null, cwd, off, partial, tries}
    this.timer = null
  }
  get size() { return this.watchers.size }
  timers() { return this.timer ? 1 : 0 }
  get(key) { return this.watchers.get(key) || null }
  add(key, dir, { onEnd, onStart } = {}) {
    this.remove(key)
    // (the Codex sessions already there are known from their end before anyone looks)
    if (!this.watchers.size) for (const file of this.rollouts()) if (!this.codexFiles.has(file)) this.codexFiles.set(file, { kind: null, cwd: null, off: Math.max(0, sizeOf(file)), partial: '', tries: 0 })
    const t = new TurnWatch(dir, { claudeHome: this.claudeHome, onEnd, onStart })
    this.watchers.set(key, t)
    if (!this.timer) { this.timer = setInterval(() => this.poll(), this.every); this.timer.unref?.() }
    return t
  }
  remove(key) {
    this.watchers.delete(key)
    if (!this.watchers.size) this.stop()
  }
  stop() { clearInterval(this.timer); this.timer = null }
  poll() {
    for (const t of this.watchers.values()) { try { t.pollClaude() } catch { /* not there yet */ } }
    try { this.pollCodex() } catch { /* not there yet */ }
  }
  rollouts(now = Date.now()) {
    if (!this.codexHome) return []
    const out = []
    for (let d = new Date(now - 86400_000); d <= new Date(now + 86400_000); d = new Date(d.getTime() + 86400_000)) {
      const dir = path.join(this.codexHome, 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'))
      let names = []
      try { names = fs.readdirSync(dir) } catch { continue }
      for (const n of names) if (/^rollout-.*\.jsonl$/.test(n)) out.push(path.join(dir, n))
    }
    return out
  }
  // the folder a rollout's session_meta names, from its first 64 KB → real path | null (not there yet) | false (not there at all)
  metaOf(file, size) {
    const fd = fs.openSync(file, 'r')
    try {
      const b = Buffer.alloc(Math.min(size, META_BYTES))
      fs.readSync(fd, b, 0, b.length, 0)
      const lines = b.toString('utf8').split('\n')
      if (size > META_BYTES) lines.pop()
      for (const l of lines) { try { const e = JSON.parse(l); if (e?.type === 'session_meta') return e.payload?.cwd ? realOf(e.payload.cwd) : false } catch { /* partial */ } }
      return size >= META_BYTES ? false : null
    } finally { fs.closeSync(fd) }
  }
  pollCodex(force = false) {
    if (!this.codexHome || (!force && !this.watchers.size)) return
    const files = this.rollouts()
    // (what it knew of rollouts that are no longer looked at — older than a day, gone — is forgotten)
    const now = new Set(files)
    for (const k of [...this.codexFiles.keys()]) if (!now.has(k)) this.codexFiles.delete(k)
    if (!this.watchers.size) return
    const byDir = new Map([...this.watchers.values()].map((t) => [t.dir, t]))
    for (const file of files) {
      let f = this.codexFiles.get(file)
      if (f?.kind === 'other') continue
      const size = sizeOf(file)
      if (size < 0) continue
      if (!f) { f = { kind: null, cwd: null, off: 0, partial: '', tries: 0 }; this.codexFiles.set(file, f) } // (a session that began after)
      if (!f.kind) {
        let cwd = null
        try { cwd = this.metaOf(file, size) } catch { cwd = null }
        // (no folder in its head, or nothing after many looks: remembered — never read again)
        if (cwd === false || (cwd === null && ++f.tries > 20)) { f.kind = 'other'; continue }
        if (!cwd) continue
        f.kind = 'codex'
        f.cwd = cwd
      }
      const lines = readLines(f, file, size)
      const t = byDir.get(f.cwd)
      if (t) for (const e of lines) t.codex(e)
    }
  }
}

// ---------- the working copies of one person on one server ----------
// store: this server's and this person's entries in the app's settings (settings.seatStore) — the only place a path is kept.
// send(msg): the link (runner/link.js). Events: 'state' (list()) · 'recall' {variationId, title, folderName, by, why} · 'left' {variationId,
// title, folderName, newVariation, kept} · 'released' {variationId, title, kept} · 'trashed' {variationId, title, folderName, kept, why}: files
// moved to the app's trash without a word otherwise (what git does not carry of a copy that had nothing new · a folder left behind)
class WorkingCopies extends Uploader {
  constructor({ dataDir, server, userId, store, send = () => false, device = {}, user = () => null, log = () => {}, rules = SY.compileRules(),
    askMs = 30_000, takeMs = TAKE_MS, quietMs = Number(process.env.PGL_SEAT_QUIET_MS) || QUIET_MS, statusMs = Number(process.env.PGL_SEAT_STATUS_MS) || STATUS_MS, scanMs = SCAN_MS, turnMs = TURN_MS,
    turnWaitMs = TURN_WAIT_MS, openMs = OPEN_MS, claudeHome = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
    codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), watchFn, prepareBeatMs = PREPARE_BEAT_MS, leftRetryMs = LEFT_RETRY_MS,
    trashMaxBytes = (Number(process.env.PGL_SEAT_TRASH_MAX_MB) || TRASH_MAX_MB) * 1024 * 1024 } = {}) {
    super({ server, send, log, prefix: 'seat:', key: 'variation', askMs, ...(watchFn ? { watchFn } : {}) })
    this.userId = String(userId || '')
    this.dataDir = path.resolve(dataDir)
    this.root = path.join(this.dataDir, 'folders', SY.serverKey(this.server), SY.personKey(this.userId))
    // (the trash sits beside the working copies, under the same folder: moving one there is a rename on the same disk)
    this.trashRoot = path.join(this.root, 'trash')
    this.oldTrash = path.join(this.dataDir, 'trash') // (where an earlier 0.2.6 build put it: only emptied after its 30 days)
    this.netCache = new Map() // server address → {at, pairs}
    this.prepAt = new Map() // variation → the server's time on the seat:prepare this computer last had
    this.lastListAt = 0
    this.hooks = path.join(this.root, 'no-hooks')
    this.store = store
    this.deviceName = String(device?.name || '')
    this.userFn = user
    this.rules = rules
    this.takeMs = takeMs
    this.quietMs = quietMs
    this.statusMs = statusMs
    this.scanMs = scanMs
    this.turnMs = turnMs
    this.turnWaitMs = turnWaitMs
    this.openMs = openMs
    this.claudeHome = claudeHome
    this.codexHome = codexHome
    this.prepareBeatMs = prepareBeatMs
    this.leftRetryMs = leftRetryMs
    this.leftTimers = new Map() // variation → the timer that tries a leftover a terminal held again
    this.trashMaxBytes = trashMaxBytes
    this.busy = new Set()
    this.turnHub = new TurnHub({ claudeHome, codexHome, every: turnMs })
    this.lastList = null // the server's latest seat:list (variation → {epoch, state}) — looked at again inside each variation's lock
    this.statusAt = new Map()
    this.statusTimer = new Map()
    this.failed = new Map() // variation → {why, at}: a prepare that did not make it (open() says so)
    this.other = false
    this.scan = null
    // (the trash is emptied of what is older than 30 days, now and every few hours — never in the way of anything else)
    // (over its size: said once a day at most)
    const clean = () => this.cleanTrash(Date.now(), { say: Date.now() - (this.fullSaidAt || 0) > 86400_000 }).catch((err) => this.log(`[seats] trash ${err.message}`))
    setImmediate(clean)
    this.trashTimer = setInterval(clean, TRASH_EVERY_MS)
    this.trashTimer.unref?.()
    // (what was being worked on when the app closed: watched again at once — a save point while the link is down waits for it)
    for (const e of this.store.all()) if (['held', 'blocked'].includes(e.state) && e.dir && fs.existsSync(e.dir)) this.watchOne(e)
  }

  // ---------- the record ----------
  get(vid) { return this.store.get(String(vid || '')) }
  put(e) { this.store.put(e); this.changed() }
  mark(vid, patch) { const e = this.get(vid); if (!e) return null; const n = { ...e, ...patch }; this.store.put(n); this.changed(); return n }
  drop(vid) { this.unwatchOne(vid); this.store.drop(String(vid)); this.changed() }
  changed() { this.emit('state', this.list()) }
  view(e) {
    return { variationId: e.variationId, folderId: e.folderId, folderName: e.folderName || '', title: e.title || '', state: e.state || 'held', why: e.why || null,
      dirty: e.dirty || 0, ahead: e.ahead || 0, branchOk: e.branchOk !== false, flagged: e.flagged || 0, unsure: e.unsure || 0,
      unsureFiles: Array.isArray(e.unsureFiles) ? e.unsureFiles.slice(0, 10) : [], pushedAt: e.pushedAt || null, autoSave: e.autoSave !== false,
      busy: this.busy.has(e.variationId) }
  }
  list() { return this.store.all().filter((e) => e.state !== 'left').map((e) => this.view(e)) }
  leftovers() { return this.store.all().filter((e) => e.state === 'left').map((e) => this.view(e)) }
  // the working copy's folder (main opens it in Finder · a terminal; the page never learns it)
  pathOf(vid) { const e = this.get(vid); return e?.dir && this.inside(e.dir) && fs.existsSync(e.dir) ? e.dir : null }
  inside(dir) { return isInside(path.resolve(dir), this.root) }
  async git(args, o = {}) {
    const net = o.url ? await this.netConfig(o.url) : []
    return wcGit(args, { hooks: this.hooks, ...o, net })
  }
  // the person's proxy and certificate settings for this address (git config --get-urlmatch http <url> — their system and global settings,
  // nothing of any repository), kept for a few minutes → [[key, value]]
  netConfig(url) {
    const key = String(url || '')
    const hit = this.netCache.get(key)
    if (hit && Date.now() - hit.at < 5 * 60_000) return Promise.resolve(hit.pairs)
    const env = {}
    for (const [k, v] of Object.entries(process.env)) if (!/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+|CONFIG_PARAMETERS|CEILING_DIRECTORIES)$/.test(k)) env[k] = v
    env.GIT_CEILING_DIRECTORIES = os.tmpdir()
    return new Promise((resolve) => {
      execFile(G.gitPath(), ['config', '--get-urlmatch', 'http', key], { cwd: os.tmpdir(), env, timeout: 5000, windowsHide: true }, (err, stdout) => {
        const pairs = String(err ? '' : stdout).split('\n').map((l) => { const i = l.indexOf(' '); return i > 0 ? [l.slice(0, i), l.slice(i + 1).trim()] : null })
          .filter((x) => x && NET_KEYS.test(x[0]) && x[1])
        this.netCache.set(key, { at: Date.now(), pairs })
        resolve(pairs)
      })
    })
  }

  // ---------- the link ----------
  linkUp(user) {
    super.linkUp()
    this.other = !!(user?.id && this.userId && String(user.id) !== this.userId)
    if (!this.scan) { this.scan = setInterval(() => { for (const e of this.store.all()) if (['held', 'blocked'].includes(e.state)) this.statusSoon(e.variationId) }, this.scanMs); this.scan.unref?.() }
    this.changed()
  }
  linkDown() { super.linkDown(); this.changed() }
  stop() {
    super.stop()
    clearInterval(this.scan); this.scan = null
    clearInterval(this.trashTimer); this.trashTimer = null
    this.turnHub.stop()
    this.turnHub.watchers.clear()
    for (const t of this.statusTimer.values()) clearTimeout(t)
    this.statusTimer.clear()
    for (const t of this.leftTimers.values()) clearTimeout(t)
    this.leftTimers.clear()
  }
  // what the server sends (seat:*): a waiter's answer, or the server's own word
  handle(msg) {
    if (this.answer(msg)) return
    if (this.other) return
    const vid = String(msg?.variation || '')
    const bad = (e) => this.log(`[seats] ${msg.type} ${var8(vid)}: ${e.message}`)
    switch (msg.type) {
      case 'seat:list': this.reconcile(msg.seats, Number(msg.at) || 0).catch(bad); return
      case 'seat:prepare': this.prepare(msg).catch(bad); return
      case 'seat:save': if (this.get(vid)) this.round(vid, 'asked').catch(bad); return
      case 'seat:recall': {
        const e = this.get(vid)
        if (!e) return
        // (asked from elsewhere — 「여기로 가져오기」: the page waits; a give-back that cannot happen now is said back, and on this PC)
        if (msg.auto) {
          this.release(vid, { auto: true }).then((r) => {
            if (r?.ok) return
            const cur = this.get(vid)
            this.send({ type: 'seat:refused', re: 'seat:recall', variation: vid, epoch: Number(cur?.epoch ?? e.epoch), why: String(r?.why || 'failed').slice(0, 40) })
            if (r?.why === 'in_use') this.emit('recall', { variationId: vid, title: e.title, folderName: e.folderName, inUse: true })
            if (r?.why === 'unsure') this.emit('recall', { variationId: vid, title: e.title, folderName: e.folderName, unsure: r.unsure || 1, unsureFiles: r.unsureFiles || [] })
          }).catch(bad)
          return
        }
        this.emit('recall', { variationId: vid, title: e.title, folderName: e.folderName, by: String(msg.by || '').slice(0, 80), why: String(msg.why || '').slice(0, 300) })
        return
      }
      case 'seat:prefs': if (this.get(vid) && typeof msg.autoSave === 'boolean') this.mark(vid, { autoSave: msg.autoSave }); return
      case 'seat:refused': if (this.get(vid) && msg.why && !['rate_limited'].includes(msg.why)) this.mark(vid, { why: String(msg.why).slice(0, 40) }); return
      default:
    }
  }

  // ---------- places ----------
  // the folder's place: <root>/<folder8> (another folder whose id starts the same: its whole id)
  folderDir(folderId) {
    const short = path.join(this.root, String(folderId).slice(0, 8))
    try { const own = fs.readFileSync(path.join(short, 'repo', 'pgl-folder'), 'utf8').trim(); if (own && own !== folderId) return path.join(this.root, folderId) } catch { /* new */ }
    return short
  }
  // The working copy's place, decided by the whole variation id: the one its record names, else <var8>-<title> — and when another
  // variation's record (two ids that start alike) has that name, <var8>-<title>-2 … A folder found there with no record of it is never
  // reused or written into: prepare moves it to the trash first.
  placeFor(folderId, vid, title) {
    const e = this.get(vid)
    if (e?.dir && this.inside(e.dir)) return e.dir
    const wt = path.join(this.folderDir(folderId), 'wt')
    const slug = titleSlug(title)
    const base = slug ? `${var8(vid)}-${slug}` : var8(vid)
    const taken = new Set(this.store.all().filter((x) => x.variationId !== vid && x.dir).map((x) => path.resolve(x.dir)))
    let dir = path.join(wt, base)
    for (let i = 2; taken.has(path.resolve(dir)); i++) dir = path.join(wt, `${base}-${i}`)
    return dir
  }
  wtDirOf(folderId, vid, title) { return this.placeFor(folderId, vid, title) }
  async ensureRepo(folderId, person) {
    const repo = path.join(this.folderDir(folderId), 'repo')
    if (!fs.existsSync(path.join(repo, 'HEAD'))) {
      fs.mkdirSync(repo, { recursive: true })
      await this.git(['init', '-q', '--bare', '--template=', repo], { cwd: path.dirname(repo) })
    }
    fs.writeFileSync(path.join(repo, 'pgl-folder'), folderId)
    fs.mkdirSync(path.join(repo, 'info'), { recursive: true })
    // the folder's bytes as they are in every working copy: no line-ending change, no filter (LFS's or another), whatever .gitattributes says
    fs.writeFileSync(path.join(repo, 'info', 'attributes'), G.NEUTRAL)
    // (kept in the repository too, so the person's own git in their terminal works the same way: links as plain files, no hooks run)
    const conf = [['core.symlinks', 'false'], ['core.autocrlf', 'false'], ['core.hooksPath', this.hooks], ['submodule.recurse', 'false'], ['fetch.recurseSubmodules', 'false'],
      ['core.fsmonitor', 'false'], ['commit.gpgSign', 'false'], ['gc.auto', '0']]
    if (person?.name) conf.push(['user.name', String(person.name).slice(0, 80)])
    if (person?.email) conf.push(['user.email', String(person.email).slice(0, 120)])
    for (const [k, v] of conf) await this.git(['config', k, v], { gitDir: repo, cwd: path.dirname(repo) })
    return repo
  }
  repoOf(e) { return path.join(this.folderDir(e.folderId), 'repo') }
  async headOf(e) { return (await this.git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { cwd: e.dir, check: false })).trim() || null }
  async branchOk(e) { return (await this.git(['symbolic-ref', '-q', 'HEAD'], { cwd: e.dir, check: false })).trim() === `refs/heads/${e.branch}` }
  // how many commits HEAD has beyond base — asked strictly: git that cannot say throws (never taken for 0, which would let a copy go)
  async beyond(e, base) {
    if (!base) return 1
    const n = Number((await this.git(['rev-list', '--count', `${base}..HEAD`], { cwd: e.dir })).trim())
    if (!Number.isInteger(n) || n < 0) throw new G.GitError('git rev-list --count: not a number')
    return n
  }
  // The working copy is a worktree of this folder's own repository in the app's data — its top is its folder, its repository is ours —
  // or nothing is done in it (a copy whose .git went missing, pointed elsewhere, or that git cannot read). → throws
  async checkCopy(e) {
    if (!e?.dir || !this.inside(e.dir) || !fs.existsSync(e.dir)) throw new G.GitError('no working copy here')
    const top = (await this.git(['rev-parse', '--show-toplevel'], { cwd: e.dir })).trim()
    const common = (await this.git(['rev-parse', '--git-common-dir'], { cwd: e.dir })).trim()
    const abs = path.isAbsolute(common) ? common : path.resolve(e.dir, common)
    if (realOf(top) !== realOf(e.dir) || realOf(abs) !== realOf(this.repoOf(e))) throw new G.GitError('the working copy is not one of the app\'s')
  }
  // a working copy that was added completely: the app's own, clean, at the head it was given
  // (the index against HEAD — not a clean tree: on a Mac a file stored with a decomposed Hangul name, or two names that differ only in case,
  // show as changed right after checkout without anything being wrong)
  async checkAdded(e, tip) {
    await this.checkCopy(e)
    await this.git(['diff-index', '--cached', '--quiet', 'HEAD'], { cwd: e.dir })
    if (tip && (await this.headOf(e)) !== tip) throw new G.GitError('the working copy is not at the head it was given')
  }
  // HEAD's paths by the name this computer sees them under: {head: Map(path → {mode, sha}), byKey: Map(key → [paths]), fold, algo}. A key
  // with two paths or more is a pair this computer shows as one file (README.md · readme.md on a Mac or Windows)
  async aliasesOf(e, ref = 'HEAD') {
    const head = new Map()
    for (const l of split0(await this.git(['ls-tree', '-r', '-z', ref], { cwd: e.dir }))) {
      const tab = l.indexOf('\t')
      const [mode, , sha] = l.slice(0, tab).split(' ')
      head.set(l.slice(tab + 1), { mode, sha })
    }
    const caseless = (await this.git(['config', '--bool', 'core.ignorecase'], { cwd: e.dir, check: false }).catch(() => '')).trim() === 'true'
    const fold = foldFor(process.platform, caseless)
    const byKey = new Map()
    for (const p of head.keys()) { const k = fold(p); byKey.set(k, [...(byKey.get(k) || []), p]) }
    const algo = (await this.git(['rev-parse', '--show-object-format'], { cwd: e.dir, check: false }).catch(() => '')).trim() === 'sha256' ? 'sha256' : 'sha1'
    return { head, byKey, fold, algo }
  }
  // the tracked paths that are one file with this one on this computer — two or more: a pair it cannot tell apart
  sameFile(a, p) { return a.byKey.get(a.fold(p)) || [] }
  // a path git reports that is only another name of one tracked file (a Mac's composed name of an NFD one) — its change shows under the
  // tracked name
  aliasOf(a, p, code) {
    if (code !== '??' && code !== 'A') return false
    const ts = this.sameFile(a, p)
    return ts.length === 1 && ts[0] !== p
  }
  // whether what this computer shows of a pair it cannot tell apart is changed: its content is none of the pair's (or it is gone). Which of
  // the two names is meant is not known, so such a change never goes up — it is counted 「확인이 필요해요」 and kept
  async pairChanged(e, a, key) {
    const ts = a.byKey.get(key) || []
    for (const t of ts) {
      const sha = await blobOf(path.join(e.dir, ...t.split('/')), a.algo).catch(() => null)
      if (sha) return !ts.some((x) => a.head.get(x)?.sha === sha)
    }
    return true
  }

  // ---------- seat:prepare ----------
  async prepare(m) {
    if (this.other) return { ok: false, why: 'other_user' }
    const vid = String(m?.variation || '')
    const folderId = String(m?.folderId || '')
    const epoch = Number(m?.epoch)
    if (!UUID.test(vid) || !UUID.test(folderId) || !Number.isInteger(epoch) || epoch < 1 || !m.token) return { ok: false, why: 'invalid' }
    try { G.checkRef(m.branch) } catch { return { ok: false, why: 'invalid' } }
    // (an older word than the one this computer has: never acted on)
    const had = this.get(vid)
    if (had && Number(had.epoch) > epoch) { this.log(`[seats] ${var8(vid)}: prepare for epoch ${epoch} refused — this computer has ${had.epoch}`); return { ok: false, why: 'stale' } }
    this.failed.delete(vid)
    if (Number(m.at)) this.prepAt.set(vid, Number(m.at))
    return this.locked(vid, async () => {
      let e = this.get(vid)
      if (e && Number(e.epoch) > epoch) return { ok: false, why: 'stale' }
      // said again for the seat it already has: ready again — only when its working copy was added completely (a prepare that stopped half
      // way — the app quit during worktree add — goes to the trash and is added anew below)
      if (e && Number(e.epoch) === epoch && e.state !== 'left' && e.dir && fs.existsSync(e.dir)) {
        if (isAdded(e) && await this.checkCopy(e).then(() => true, () => false)) return this.becomeReady(e)
        if (!isAdded(e)) { await this.aside(e, 'unfinished'); e = this.mark(vid, { dir: null }) }
      }
      // a working copy of an earlier seat of this variation still here: what it has goes its own way first (never into this one)
      if (e && e.dir && fs.existsSync(e.dir)) {
        const l = await this.leftoverNow(e)
        if (this.get(vid)) {
          // (a terminal or a program holds that folder: said as it is — closing it lets the leftover go, then this prepare works)
          const why = l?.why === 'in_use' ? 'in_use' : 'leftover'
          this.fail(vid, why)
          this.send({ type: 'seat:failed', variation: vid, epoch, why })
          return { ok: false, why }
        }
      } else if (e) this.drop(vid)
      this.secret(m.token)
      const person = m.person && typeof m.person === 'object' ? { name: String(m.person.name || '').slice(0, 80), email: String(m.person.email || '').slice(0, 120) } : null
      const dir = this.placeFor(folderId, vid, m.title)
      e = { variationId: vid, folderId, folderName: String(m.folderName || '').slice(0, 120), title: String(m.title || '').slice(0, 120), branch: String(m.branch), dir,
        epoch, head: null, pushedAt: null, autoSave: m.autoSave !== false, state: 'preparing', why: null, dirty: 0, ahead: 0, branchOk: true, flagged: 0, person, added: false }
      this.put(e)
      // (a large folder's first fetch takes longer than a move may: the server hears that this computer is still at it)
      const beat = () => this.send({ type: 'seat:preparing', variation: vid, epoch })
      beat()
      const beating = setInterval(beat, this.prepareBeatMs)
      beating.unref?.()
      let made = false
      try {
        // (a folder at that place with no record of it — left behind by an older app, a crash: never reused, never mixed in — to the trash;
        // one that cannot be moved fails this prepare out loud)
        if (fs.existsSync(dir)) await this.aside({ ...e }, 'orphan')
        const url = this.urlOf(m)
        const repo = await this.ensureRepo(folderId, person)
        const ref = `refs/remotes/lite/${vid}`
        await this.git(['fetch', '-q', '--no-tags', '--no-recurse-submodules', url, `+refs/heads/${e.branch}:${ref}`],
          { gitDir: repo, cwd: path.dirname(repo), token: m.token, url, timeout: NETWORK_MS })
        const tip = (await this.git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { gitDir: repo, cwd: path.dirname(repo), check: false })).trim()
        if (!tip) throw new G.GitError('the variation is not on the server')
        fs.mkdirSync(path.dirname(dir), { recursive: true })
        made = true
        await this.git(['worktree', 'add', '-q', '-B', e.branch, dir, ref], { gitDir: repo, cwd: path.dirname(repo) })
        await this.checkAdded(e, tip)
        e = this.mark(vid, { head: tip, added: true })
        clearInterval(beating)
        return this.becomeReady(e)
      } catch (err) {
        this.log(`[seats] ${var8(vid)}: prepare failed — ${err.message}`)
        this.send({ type: 'seat:failed', variation: vid, epoch, why: 'git' })
        // (what was made of it goes to the trash — nothing of the person's is in a copy that never became ready)
        if (made && fs.existsSync(dir) && this.inside(dir)) await this.aside(e, 'unfinished').catch((x) => this.log(`[seats] ${x.message}`))
        this.drop(vid)
        this.fail(vid, 'failed')
        return { ok: false, why: 'failed' }
      } finally { clearInterval(beating) }
    })
  }
  fail(vid, why) { this.failed.set(vid, { why, at: Date.now() }); this.changed() }
  // ready → the server holds the seat here (seat:held); a seat that went elsewhere meanwhile → what is here goes its own way
  // (said again whenever the server still has it moving — a prepare said twice, seat:list — since its answer may not have come here. A
  // refusal never takes the working copy away by itself: whether the seat is gone is for seat:list to say)
  async becomeReady(e) {
    const vid = e.variationId
    const head = await this.headOf(e)
    const r = await this.ask({ type: 'seat:ready', variation: vid, epoch: e.epoch, head }, ['seat:held'])
    const cur = this.get(vid)
    if (!cur || Number(cur.epoch) !== Number(e.epoch)) return { ok: false, why: 'stale' }
    if (r.type === 'seat:held') {
      const n = this.mark(vid, { state: ['held', 'blocked'].includes(cur.state) ? cur.state : 'held', why: cur.state === 'preparing' ? null : cur.why })
      if (!this.watchers.has(vid)) this.watchOne(n)
      this.statusSoon(vid, true)
      return { ok: true }
    }
    if (['held', 'blocked'].includes(cur.state)) return { ok: true }
    if (r.why === 'stale' || r.why === 'not_here') { this.mark(vid, { why: r.why }); this.fail(vid, r.why) }
    return { ok: false, why: String(r.why || 'refused') }
  }

  // ---------- watching: save points and counts ----------
  watchOne(e) {
    const vid = e.variationId
    this.watch(vid, e.dir, { quietMs: this.quietMs, onChange: () => this.statusSoon(vid), onQuiet: () => this.auto(vid, 'quiet') })
    if (!this.turnHub.get(vid)) this.turnHub.add(vid, e.dir, { onEnd: () => this.auto(vid, 'turn') })
  }
  unwatchOne(vid) {
    this.unwatch(vid)
    this.turnHub.remove(vid)
    clearTimeout(this.statusTimer.get(vid))
    this.statusTimer.delete(vid)
  }
  turnBusy(vid) { return !!this.turnHub.get(vid)?.busy }
  // a save point the app makes by itself (the files went quiet · a CLI's turn ended · the link came back): only with the switch on
  auto(vid, why) {
    const e = this.get(vid)
    if (!e || e.autoSave === false || !['held', 'blocked'].includes(e.state)) return
    if (!this.connected) { this.later(vid); return }
    this.round(vid, why).catch((err) => this.log(`[seats] ${err.message}`))
  }
  // the counts the screens show (저장 안 한 변경 N · 안 올린 저장 지점 N · 다른 가지): at most one message per variation every statusMs
  statusSoon(vid, now = false) {
    if (this.statusTimer.has(vid)) return
    const wait = now ? 0 : Math.max(0, (this.statusAt.get(vid) || 0) + this.statusMs - Date.now())
    const t = setTimeout(() => { this.statusTimer.delete(vid); this.sendStatus(vid).catch((err) => this.log(`[seats] status ${err.message}`)) }, wait)
    t.unref?.()
    this.statusTimer.set(vid, t)
  }
  // (dirty counts a changed pair too — unsure: how many of them, which never go up as they are)
  async counts(e) {
    const st = split0(await this.git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'], { cwd: e.dir, check: false }))
    const a = st.length ? await this.aliasesOf(e).catch(() => null) : null
    let dirty = 0
    const pairs = new Set()
    for (const x of st) {
      const code = x.slice(0, 2).trim()
      const rel = x.slice(3)
      if (a && this.sameFile(a, rel).length > 1) { pairs.add(a.fold(rel)); continue }
      if (a && this.aliasOf(a, rel, code)) continue
      dirty++
    }
    const unsureFiles = []
    for (const k of pairs) if (await this.pairChanged(e, a, k)) unsureFiles.push(a.byKey.get(k).join(' · '))
    const unsure = unsureFiles.length
    const branchOk = await this.branchOk(e)
    const ahead = e.head ? await this.beyond(e, e.head).catch(() => 0) : 0
    return { dirty: dirty + unsure, unsure, unsureFiles: unsureFiles.slice(0, 10), ahead, branchOk }
  }
  async sendStatus(vid) {
    const e = this.get(vid)
    if (!e || !['held', 'blocked'].includes(e.state) || !e.dir || !fs.existsSync(e.dir)) return
    const c = await this.counts(e)
    this.statusAt.set(vid, Date.now())
    this.mark(vid, c)
    // (counts only — the names of the files to check stay on this PC)
    this.send({ type: 'seat:status', variation: vid, epoch: e.epoch, dirty: c.dirty, ahead: c.ahead, branchOk: c.branchOk, unsure: c.unsure })
  }

  // ---------- commit as is ----------
  // why a staged file stays out of the commit (it stays on disk as it is) → reason | null
  async leftOut(e, rel, mode) {
    if (mode === '120000' || mode === '160000') return 'structure'
    if (CONTROL.has(rel.split('/').pop().toLowerCase())) return 'structure'
    if (SY.groupOf(this.rules, rel) === 'secret') return 'secret'
    let st
    try { st = await fsp.lstat(path.join(e.dir, ...rel.split('/'))) } catch { return null }
    if (st.isSymbolicLink()) return 'structure'
    if (!st.isFile()) return null
    if (st.size > this.rules.limits.largeFileBytes) return 'large'
    if (st.size && st.size <= this.rules.limits.textMaxBytes) {
      const buf = await fsp.readFile(path.join(e.dir, ...rel.split('/'))).catch(() => null)
      if (buf && !SY.looksBinary(buf) && SY.shapeHits(this.rules, buf.toString('utf8')).some((h) => h.level === 'block')) return 'secret'
    }
    return null
  }
  // everything in the working copy committed as it is — new, changed and deleted files — but the ones that stay out (index only: the files
  // on disk are not touched) → {commit (sha | null: nothing to commit), flagged}
  async commitAsIs(e, message) {
    // (only in a working copy that is one of the app's — never in a repository git would find around it)
    await this.checkCopy(e)
    const cwd = e.dir
    await this.git(['add', '-A'], { cwd })
    const st = split0(await this.git(['diff', '--cached', '--name-status', '-z', '--no-renames'], { cwd }))
    const changed = []
    for (let i = 0; i + 1 < st.length; i += 2) if (st[i] !== 'D') changed.push({ st: st[i], path: st[i + 1] })
    const modes = new Map()
    if (changed.length) for (const l of split0(await this.git(['ls-files', '-s', '-z'], { cwd }))) { const tab = l.indexOf('\t'); modes.set(l.slice(tab + 1), l.split(' ')[0]) }
    const out = []
    for (const c of changed) if (await this.leftOut(e, c.path, modes.get(c.path))) out.push(c)
    if (out.length) {
      const added = out.filter((c) => c.st === 'A')
      const tracked = out.filter((c) => c.st !== 'A')
      if (added.length) await this.git(['update-index', '-z', '--force-remove', '--stdin'], { cwd, input: `${added.map((c) => c.path).join('\0')}\0` })
      if (tracked.length) {
        // (back to what the last commit had for it — HEAD read whole: a path given to git on its command line would be composed on a Mac)
        const { head } = await this.aliasesOf(e)
        const lines = tracked.filter((c) => head.has(c.path)).map((c) => `${head.get(c.path).mode} ${head.get(c.path).sha}\t${c.path}`)
        if (lines.length) await this.git(['update-index', '-z', '--index-info'], { cwd, input: `${lines.join('\0')}\0` })
      }
    }
    // What only names a tracked file another way never goes up as a second file or a deletion: an added alias (a Mac's composed name of an
    // NFD one) leaves the index — and when git saw the tracked name gone, that name takes the alias's content. A pair this computer shows as
    // one file (README.md · readme.md) stays out of the commit as HEAD has it: which name was meant is not known. Nothing on disk is touched
    // — the pair is counted 「확인이 필요해요」 and kept in the trash if its copy goes.
    const staged = split0(await this.git(['diff', '--cached', '--name-status', '-z', '--no-renames'], { cwd }))
    const pairs = new Set()
    const namesOf = new Map() // pair key → its names ('Plan.md · plan.md') — only a pair whose content here is neither of HEAD's
    if (staged.length) {
      const a = await this.aliasesOf(e)
      const codes = new Map()
      for (let i = 0; i + 1 < staged.length; i += 2) codes.set(staged[i + 1], staged[i])
      const index = new Map()
      for (const l of split0(await this.git(['ls-files', '-s', '-z'], { cwd }))) { const tab = l.indexOf('\t'); const [mode, sha] = l.slice(0, tab).split(' '); index.set(l.slice(tab + 1), { mode, sha }) }
      const drop = []
      const set = [] // [path, {mode, sha}]
      for (const [rel, code] of codes) {
        const ts = this.sameFile(a, rel)
        if (ts.length > 1) {
          pairs.add(a.fold(rel))
          namesOf.set(a.fold(rel), ts.join(' · '))
          if (a.head.has(rel)) set.push([rel, a.head.get(rel)])
          else drop.push(rel)
        } else if (code === 'A' && this.aliasOf(a, rel, 'A')) {
          drop.push(rel)
          if (codes.get(ts[0]) === 'D' && index.has(rel)) set.push([ts[0], index.get(rel)])
        }
      }
      if (set.length) await this.git(['update-index', '-z', '--index-info'], { cwd, input: `${set.map(([r, x]) => `${x.mode} ${x.sha}\t${r}`).join('\0')}\0` })
      if (drop.length) await this.git(['update-index', '-z', '--force-remove', '--stdin'], { cwd, input: `${drop.join('\0')}\0` })
      // (a pair just as it came — the copy shows one of its two contents — has nothing to check)
      for (const k of [...pairs]) if (!(await this.pairChanged(e, a, k))) { pairs.delete(k); namesOf.delete(k) }
    }
    const left = split0(await this.git(['diff', '--cached', '--name-only', '-z'], { cwd }))
    const unsureFiles = [...pairs].map((k) => namesOf.get(k)).filter(Boolean).slice(0, 10)
    if (!left.length) return { commit: null, flagged: out.length, unsure: pairs.size, unsureFiles }
    const p = e.person || {}
    const u = this.userFn() || {}
    const name = String(p.name || u.name || 'Process GPT Lite').slice(0, 80)
    const email = String(p.email || `${this.userId || 'desktop'}@users.pgpt-lite.local`).slice(0, 120)
    await this.git(['commit', '-q', '--no-verify', '-m', message], { cwd, env: { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email } })
    return { commit: await this.headOf(e), flagged: out.length, unsure: pairs.size, unsureFiles }
  }

  // commit as is → a token for this variation at this epoch → push its seat branch → {head, pushed, flagged} | {why}
  async upload(e, message) {
    const c = await this.commitAsIs(e, message)
    const head = await this.headOf(e)
    if (!head) return { why: 'failed' }
    if (head === e.head) return { head, pushed: false, flagged: c.flagged, unsureFiles: c.unsureFiles }
    const t = await this.ask({ type: 'seat:token', variation: e.variationId, epoch: e.epoch, for: 'push' }, ['seat:token'])
    if (t.type !== 'seat:token' || !t.token) return { why: String(t.why || 'refused'), head, flagged: c.flagged }
    // (a token for another epoch than this working copy's: this computer no longer has the seat — nothing is pushed)
    if (Number(t.epoch) !== Number(e.epoch)) { this.log(`[seats] ${var8(e.variationId)}: a token for epoch ${t.epoch}, this working copy is ${e.epoch} — not pushed`); return { why: 'stale', head, flagged: c.flagged } }
    const branch = seatBranch(e.variationId, e.epoch)
    if (t.branch !== branch) throw new G.GitError('the token is not for this working copy\'s branch')
    this.secret(t.token)
    const url = this.urlOf(t)
    await this.git(['push', '--porcelain', '--no-verify', '--no-follow-tags', url, `+HEAD:refs/heads/${branch}`], { cwd: e.dir, token: t.token, url, timeout: NETWORK_MS })
    return { head, pushed: true, flagged: c.flagged, unsureFiles: c.unsureFiles }
  }

  // ---------- a save point (자동 · 「지금 올리기」 · seat:save) ----------
  saveNow(vid) { return this.round(String(vid || ''), 'asked') }
  round(vid, why = 'quiet') {
    return this.locked(vid, async () => {
      const e = this.get(vid)
      if (!e) return { ok: false, why: 'not_here' }
      if (this.other) return { ok: false, why: 'other_user' }
      if (!['held', 'blocked'].includes(e.state)) return { ok: false, why: e.state }
      if (!this.connected) { this.later(vid); return { ok: false, why: 'offline' } }
      this.busy.add(vid); this.changed()
      try {
        if (!(await this.branchOk(e))) { this.mark(vid, { why: 'branch', branchOk: false }); return { ok: false, why: 'branch' } }
        const p = await this.upload(e, SAVE_MESSAGE)
        if (p.why) return this.refused(e, p.why, p)
        if (!p.pushed) { this.mark(vid, { flagged: p.flagged, why: p.flagged ? 'flagged' : (e.why === 'branch' ? null : e.why) }); this.statusSoon(vid, true); return { ok: true, changed: false } }
        const r = await this.ask({ type: 'seat:pushed', variation: vid, epoch: e.epoch, head: p.head }, ['seat:taken'], this.takeMs)
        if (r.type === 'seat:taken') {
          this.mark(vid, { state: 'held', why: p.flagged ? 'flagged' : null, head: p.head, pushedAt: new Date().toISOString(), flagged: p.flagged, paths: [] })
          this.statusSoon(vid, true)
          return { ok: true, head: p.head, why }
        }
        return this.refused(e, String(r.why || 'refused'), r)
      } catch (err) {
        this.log(`[seats] ${var8(vid)}: save failed — ${err.message}`)
        this.mark(vid, { why: 'failed' })
        return { ok: false, why: 'failed' }
      } finally { this.busy.delete(vid); this.changed() }
    })
  }
  // a round the server or the network did not take
  async refused(e, why, r = {}) {
    const vid = e.variationId
    // (busy: the server is moving or saving this variation right now — the same round again later)
    if (why === 'offline' || why === 'timeout' || why === 'busy') { this.later(vid); return { ok: false, why } }
    // this computer no longer has the seat: what is here goes its own way (a variation of its own)
    if (why === 'stale' || why === 'not_here') { await this.leftoverNow(e); return { ok: false, why: 'moved' } }
    this.mark(vid, { state: 'blocked', why: String(why).slice(0, 40), paths: Array.isArray(r.paths) ? r.paths.slice(0, 20).map((x) => ({ path: String(x?.path || x || '').slice(0, 300), reason: x?.reason || null })) : [] })
    return { ok: false, why }
  }

  // ---------- 돌려놓기 ----------
  async waitTurn(vid) {
    const until = Date.now() + this.turnWaitMs
    while (this.turnBusy(vid) && Date.now() < until) await new Promise((r) => setTimeout(r, 500))
  }
  release(vid, { auto = false } = {}) {
    vid = String(vid || '')
    return this.locked(vid, async () => {
      const e = this.get(vid)
      if (!e || e.state === 'left' || e.state === 'preparing') return { ok: false, why: e ? e.state : 'not_here' }
      if (this.other) return { ok: false, why: 'other_user' }
      if (!this.connected) return { ok: false, why: 'offline' }
      if (!(await this.branchOk(e))) { this.mark(vid, { why: 'branch', branchOk: false }); return { ok: false, why: 'branch' } }
      // (a CLI working here finishes its turn first — what it writes then goes up too)
      await this.waitTurn(vid)
      // (a terminal or a program still in the folder: the person closes it first — never renamed from under it)
      if (await this.inUse(e.dir)) { this.mark(vid, { why: 'in_use' }); return { ok: false, why: 'in_use' } }
      // (asked from elsewhere while a pair this PC shows as one file is changed: which name was meant only its person can say — they
      // give it back themselves, told the names; the server hears why, without them)
      if (auto) {
        const c = await this.counts(e).catch(() => null)
        if (c?.unsure) { this.mark(vid, { ...c, why: 'unsure' }); return { ok: false, why: 'unsure', unsure: c.unsure, unsureFiles: c.unsureFiles } }
      }
      const was = e.state
      this.mark(vid, { state: 'returning' })
      this.busy.add(vid)
      try {
        const p = await this.upload(e, RELEASE_MESSAGE)
        if (p.why === 'stale' || p.why === 'not_here') { const l = await this.leftoverNow(e); return { ok: true, left: l.left || null, kept: l.kept || 0 } }
        if (p.why) { this.mark(vid, { state: was, why: p.why }); return { ok: false, why: p.why } }
        let r = await this.ask({ type: 'seat:release', variation: vid, epoch: e.epoch, head: p.pushed ? p.head : null }, ['seat:released'], this.takeMs)
        let left = null
        if (r.type !== 'seat:released' && r.why === 'diverged') {
          // what is here cannot go onto the variation (its history was rewritten): it goes up as a variation of its own, the seat goes back
          // as the server has it
          const l = await this.leftPush(e, p.head)
          if (!l.ok) { this.mark(vid, { state: was, why: l.why }); return { ok: false, why: l.why } }
          left = l.newVariation
          r = await this.ask({ type: 'seat:release', variation: vid, epoch: e.epoch, head: null }, ['seat:released'], this.takeMs)
        }
        if (r.type === 'seat:released') {
          // (the server has it back: a working copy that cannot be moved aside now stays as a leftover here — never held again)
          let kept
          // (what the server has is p.head — a commit made here meanwhile, in a terminal, is not: remove keeps all of it then)
          try { kept = await this.remove(e, { head: p.head }) } catch (err) {
            this.log(`[seats] ${var8(vid)}: given back, but the working copy could not be moved aside — ${err.message}`)
            this.mark(vid, { state: 'left', why: 'remove' })
            return { ok: false, why: 'remove' }
          }
          this.drop(vid)
          const unsureFiles = p.unsureFiles || []
          this.emit('released', { variationId: vid, title: e.title, folderName: e.folderName, kept, auto, unsureFiles })
          return { ok: true, kept, unsureFiles, ...(left ? { left } : {}) }
        }
        if (r.why === 'stale' || r.why === 'not_here') { const l = await this.leftoverNow(e); return { ok: true, left: l.left || null, kept: l.kept || 0 } }
        this.mark(vid, { state: was, why: String(r.why || 'refused').slice(0, 40) })
        return { ok: false, why: String(r.why || 'refused') }
      } catch (err) {
        this.log(`[seats] ${var8(vid)}: release failed — ${err.message}`)
        this.mark(vid, { state: was, why: 'failed' })
        return { ok: false, why: 'failed' }
      } finally { this.busy.delete(vid); this.changed() }
    })
  }

  // ---------- a working copy whose seat is gone ----------
  // what it has beyond what the server took → a variation of its own (seat:left); nothing → it just goes. Up refused or offline: it stays
  // as a leftover (listed, never thrown away by itself). → {ok, left (the new variation | null), kept} (the caller holds the lock)
  async leftoverNow(e) {
    if (!e) return { ok: true }
    const vid = e.variationId
    if (!e.dir || !fs.existsSync(e.dir) || !this.inside(e.dir)) { this.unwatchOne(vid); this.drop(vid); return { ok: true, left: null, kept: 0 } }
    // (a CLI working here finishes its turn first, as for 「돌려놓기」 — what it writes then is part of what goes up)
    await this.waitTurn(vid)
    // (a terminal or a program still in the folder: it stays a leftover here until they are closed — the next list tries again)
    if (await this.inUse(e.dir)) { this.mark(vid, { state: 'left', why: 'in_use' }); this.leftLater(vid); return { ok: false, why: 'in_use' } }
    this.unwatchOne(vid)
    try {
      let base = e.head
      if (!base) base = (await this.git(['rev-parse', '--verify', '--quiet', `refs/remotes/lite/${vid}^{commit}`], { gitDir: this.repoOf(e), cwd: path.dirname(this.repoOf(e)), check: false })).trim() || null
      const c = await this.commitAsIs(e, LEFT_MESSAGE)
      const head = await this.headOf(e)
      // (git that cannot say where the working copy is: it stays — a working copy is never removed on a guess)
      if (!head) throw new G.GitError('the working copy has no head')
      if (base && (await this.beyond(e, base)) === 0) {
        const kept = await this.remove(e, { kind: 'gone', head: base })
        this.drop(vid)
        // (nothing new for the server — but what only this PC had, .env and the like, is said to have gone to the trash)
        if (kept) this.emit('trashed', { variationId: vid, title: e.title, folderName: e.folderName, kept, why: 'gone', unsureFiles: c.unsureFiles || [] })
        return { ok: true, left: null, kept, flagged: c.flagged }
      }
      if (!this.connected) { this.mark(vid, { state: 'left', why: 'offline' }); return { ok: false, why: 'offline' } }
      const l = await this.leftPush(e, head)
      if (!l.ok) { this.mark(vid, { state: 'left', why: l.why }); return { ok: false, why: l.why } }
      // (up: what the server took is this head now — a removal that fails below is tried again later, never the push)
      this.mark(vid, { head, leftAs: l.newVariation?.id || null })
      this.emit('left', { variationId: vid, title: e.title, folderName: e.folderName, newVariation: l.newVariation })
      const kept = await this.remove({ ...e, head }, { kind: 'gone', head })
      this.drop(vid)
      return { ok: true, left: l.newVariation, kept }
    } catch (err) {
      this.log(`[seats] ${var8(vid)}: leftover — ${err.message}`)
      this.mark(vid, { state: 'left', why: 'failed' })
      return { ok: false, why: 'failed' }
    }
  }
  // (a leftover a terminal or a program holds: tried again every few minutes while it is so — not only when the next list comes)
  leftLater(vid) {
    if (this.leftTimers.has(vid)) return
    const t = setTimeout(() => {
      this.leftTimers.delete(vid)
      const e = this.get(vid)
      if (!e || e.state !== 'left' || e.why !== 'in_use') return
      this.locked(vid, () => this.leftoverIfGone(vid)).catch((err) => this.log(`[seats] ${var8(vid)}: leftover again — ${err.message}`))
    }, this.leftRetryMs)
    t.unref?.()
    this.leftTimers.set(vid, t)
  }
  // HEAD up as the variation's leftover from this computer (a one-time token for pgpt-agent/left-<variation id>-<dev8>/) → {ok, newVariation} | {why}
  async leftPush(e, head) {
    const vid = e.variationId
    const t = await this.ask({ type: 'seat:token', variation: vid, epoch: e.epoch, for: 'left' }, ['seat:token'])
    if (t.type !== 'seat:token' || !t.token) return { ok: false, why: String(t.why || 'refused') }
    const branch = String(t.branch || '')
    G.checkRef(branch)
    if (!branch.startsWith(`pgpt-agent/left-${vid}-`)) throw new G.GitError('not a leftover branch of this variation')
    this.secret(t.token)
    const url = this.urlOf(t)
    await this.git(['push', '--porcelain', '--no-verify', '--no-follow-tags', url, `+${head}:refs/heads/${branch}`], { cwd: e.dir, token: t.token, url, timeout: NETWORK_MS })
    const r = await this.ask({ type: 'seat:left', variation: vid, head }, ['seat:left-taken'], this.takeMs)
    if (r.type !== 'seat:left-taken') return { ok: false, why: String(r.why || 'refused') }
    const nv = r.newVariation && typeof r.newVariation === 'object' ? { id: String(r.newVariation.id || ''), title: String(r.newVariation.title || '').slice(0, 160) } : null
    return { ok: true, newVariation: nv }
  }

  // The working copy goes — never deleted on a guess: the whole folder is moved into the app's trash (<root>/trash/<day>-<var8>-<kind>), then git
  // forgets the worktree; the folder's objects stay (the next working copy of this folder comes quicker). A copy that is not the app's own
  // (checkCopy) is not touched unless `all` (「남은 변경 버리기」 — the person said so in a system dialog: moved as it is). A working copy the
  // server has everything of (given back · gone with nothing new) keeps in the trash only what this PC alone had: a file goes from the trash
  // copy only when its content is what HEAD has for it (its blob — read in the trash, after the move: nothing written meanwhile is lost), or
  // when git never carries it and it is rebuilt anyway (an ignored node_modules · a target/ beside Cargo.toml — rebuildable()). Changes left
  // out of a commit (secrets, links, big files), a pair this computer shows as one file and everything else stay. A folder that cannot be
  // moved (a terminal holds it on Windows) throws: the caller keeps the copy. → how many files stay in the trash (everything for `all`)
  async remove(e, { all = false, kind = 'given', head = e.head } = {}) {
    const vid = e.variationId
    let kept = 0
    if (e.dir && fs.existsSync(e.dir)) {
      if (!this.inside(e.dir)) throw new G.GitError('not a working copy of the app')
      let a = null
      let ignored = []
      if (!all) {
        await this.checkCopy(e)
        // (asked strictly: a status or a HEAD git could not give stops here — the caller keeps the working copy)
        const raw = split0(await this.git(['status', '--porcelain=v1', '-z', '--ignored=matching', '--untracked-files=all', '--no-renames'], { cwd: e.dir }))
        ignored = raw.filter((x) => x.startsWith('!! ')).map((x) => ({ rel: x.slice(3).replace(/\/+$/, ''), dir: x.endsWith('/') }))
          .filter((x) => x.rel && !x.rel.split('/').some((p) => p === '..' || p === '.git'))
        // (head: the commit the server took. The trash copy is trimmed against it only while the working copy is still there: a commit made
        // here since — in a terminal while the app waited for the server — is this PC's alone, so all of the copy stays, and the commit
        // stays reachable in the app's repository, refs/kept/<variation>-<time>, past the branch going)
        const live = await this.headOf(e)
        if (head && live === head) a = await this.aliasesOf(e, head)
        else if (live) await this.keepCommit(e, live)
      }
      this.unwatchOne(vid)
      const bin = await this.moveToTrash(e.dir, vid, all ? 'left' : kind)
      if (a) {
        try { kept = await this.trimBin(bin, a, ignored) } catch (err) { this.log(`[seats] trash trim ${err.message}`); kept = await countFiles(bin) }
      } else kept = await countFiles(bin)
    } else this.unwatchOne(vid)
    await this.forgetWorktree(e)
    return kept
  }
  // an ignored path git never carries that is rebuilt anyway: the rebuildable group (node_modules · __pycache__ · .next …), and target/ ·
  // venv/ only beside what builds them (REBUILT_WHEN)
  rebuildable(bin, rel, isDir) {
    if (SY.groupOf(this.rules, rel, isDir) !== 'rebuildable') return false
    const segs = rel.split('/')
    const dirs = this.rules.groups?.rebuildable?.dirs
    const i = segs.findIndex((s, j) => (j < segs.length - 1 || isDir) && !!dirs?.has?.(s.toLowerCase()))
    const when = i >= 0 ? REBUILT_WHEN[segs[i].toLowerCase()] : null
    return when ? when(path.join(bin, ...segs.slice(0, i)), path.join(bin, ...segs.slice(0, i + 1))) : true
  }
  // what of a trash copy goes (see remove) → how many files stay
  async trimBin(bin, a, ignored) {
    const rebuilt = ignored.filter((x) => this.rebuildable(bin, x.rel, x.dir))
    const isRebuilt = (rel) => rebuilt.some((x) => rel === x.rel || rel.startsWith(`${x.rel}/`))
    const asServer = async (rel, p) => {
      const ts = this.sameFile(a, rel)
      if (!ts.length) return false
      let st
      try { st = await fsp.lstat(p) } catch { return false }
      const sha = await blobOf(p, a.algo).catch(() => null)
      if (!sha) return false
      // (the same content and the same kind: an executable bit the server has not is this PC's too)
      const exec = !!(st.mode & 0o100)
      return ts.some((t) => { const h = a.head.get(t); return h && h.sha === sha && (process.platform === 'win32' || h.mode === '120000' || (h.mode === '100755') === exec) })
    }
    let kept = 0
    const walk = async (d, rel) => {
      let ents = []
      try { ents = await fsp.readdir(d, { withFileTypes: true }) } catch { return }
      for (const x of ents) {
        const r = rel ? `${rel}/${x.name}` : x.name
        const p = path.join(d, x.name)
        if (x.isDirectory()) {
          if (isRebuilt(r)) { await fsp.rm(p, { recursive: true, force: true }).catch(() => { kept++ }); continue }
          await walk(p, r)
          if (!(await fsp.readdir(p).catch(() => [''])).length) await fsp.rmdir(p).catch(() => {})
          continue
        }
        if (isRebuilt(r) || await asServer(r, p)) await fsp.rm(p, { force: true }).catch(() => { kept++ })
        else kept++
        if ((kept + 1) % 500 === 0) await yieldNow()
      }
    }
    await walk(bin, '')
    return kept
  }
  // a folder at a working copy's place that is not (or no longer) one: to the trash as it is, said to the person → files moved
  async aside(e, why) {
    if (!e?.dir || !fs.existsSync(e.dir) || !this.inside(e.dir)) return 0
    const kept = await countFiles(e.dir, ['.git'])
    this.unwatchOne(e.variationId)
    await this.moveToTrash(e.dir, e.variationId, why === 'orphan' ? 'orphan' : 'unfinished')
    await this.forgetWorktree(e)
    if (kept) this.emit('trashed', { variationId: e.variationId, title: e.title || '', folderName: e.folderName || '', kept, why })
    return kept
  }
  // (a rename on the same disk — nothing copied, nothing deleted; across volumes (EXDEV): only with no program in the folder, copied, checked
  // file by file — the same files, each of the same size and content — then the original deleted. The worktree's .git pointer is dropped
  // from what is in the trash)
  async moveToTrash(dir, vid, kind) {
    await fsp.mkdir(this.trashRoot, { recursive: true })
    const base = `${day()}-${var8(vid)}`
    let bin = path.join(this.trashRoot, `${base}-${kind}`)
    for (let i = 2; fs.existsSync(bin); i++) bin = path.join(this.trashRoot, `${base}-${i}-${kind}`)
    try { fs.renameSync(dir, bin) } catch (err) {
      if (err.code !== 'EXDEV') throw err
      if (await this.inUse(dir)) throw new G.GitError('a program is still in the working copy — it stays')
      await fsp.cp(dir, bin, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false })
      if (!(await sameTrees(dir, bin))) { await fsp.rm(bin, { recursive: true, force: true }).catch(() => {}); throw new G.GitError('the copy to the trash came out different — the working copy stays') }
      await fsp.rm(dir, { recursive: true, force: true })
    }
    try { if (fs.lstatSync(path.join(bin, '.git')).isFile()) fs.rmSync(path.join(bin, '.git')) } catch { /* none */ }
    return bin
  }
  // a commit only this PC has (made after what the server took) kept reachable in the folder's repository — refs/kept/<variation>-<day>-<time>,
  // emptied with the trash after 30 days
  async keepCommit(e, sha) {
    const t = new Date()
    const ref = `refs/kept/${e.variationId}-${day(t)}-${String(t.getHours()).padStart(2, '0')}${String(t.getMinutes()).padStart(2, '0')}${String(t.getSeconds()).padStart(2, '0')}`
    const repo = this.repoOf(e)
    await this.git(['update-ref', ref, sha], { gitDir: repo, cwd: path.dirname(repo) })
    this.log(`[seats] ${var8(e.variationId)}: a commit the server does not have (${String(sha).slice(0, 8)}) kept as ${ref}`)
    return ref
  }
  // git forgets a worktree that is gone, and the app's own branch and fetched ref of it
  async forgetWorktree(e) {
    const repo = this.repoOf(e)
    if (!fs.existsSync(path.join(repo, 'HEAD'))) return
    const at = { gitDir: repo, cwd: path.dirname(repo), check: false }
    await this.git(['worktree', 'prune'], at).catch(() => {})
    if (e.branch && !(await this.branchInUse(repo, e.branch))) await this.git(['update-ref', '-d', `refs/heads/${e.branch}`], at).catch(() => {})
    await this.git(['update-ref', '-d', `refs/remotes/lite/${e.variationId}`], at).catch(() => {})
  }
  async branchInUse(repo, branch) {
    const out = await this.git(['worktree', 'list', '--porcelain'], { gitDir: repo, cwd: path.dirname(repo), check: false }).catch(() => '')
    return out.split('\n').some((l) => l.trim() === `branch refs/heads/${branch}`)
  }
  trashDir() { return this.trashRoot }
  // whether a process of this person has its current folder in the working copy (a terminal, a CLI): lsof on macOS · Linux; elsewhere (and
  // without lsof) no — a rename Windows refuses keeps the copy as a leftover instead
  inUse(dir) {
    if (process.platform === 'win32' || !dir) return Promise.resolve(false)
    const real = realOf(dir)
    const under = (p) => p === real || p.startsWith(real + path.sep)
    return new Promise((resolve) => {
      execFile('lsof', ['-a', '-u', String(os.userInfo().uid), '-d', 'cwd', '-Fpcn'], { timeout: 8000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
        if (err && !stdout) return resolve(false)
        // (records: p<pid> c<command> n<folder> — git itself is not a reason to wait: the app's own status · commit run there, and a person's
        // git ends by itself)
        let pid = 0, cmd = ''
        for (const l of String(stdout).split('\n')) {
          if (l.startsWith('p')) { pid = Number(l.slice(1)); cmd = '' } else if (l.startsWith('c')) cmd = l.slice(1)
          else if (l.startsWith('n') && under(l.slice(1)) && pid !== process.pid && !/^git(-|$)/.test(cmd)) return resolve(true)
        }
        resolve(false)
      })
    })
  }
  // The trash: older than 30 days goes, and nothing before — what is there is what only this PC had. Over its size (maxBytes) the person is
  // told ('trash-full' {bytes, maxBytes} — a notification; say: false keeps it quiet). Asynchronous and a little at a time: a large
  // node_modules never holds the app up.
  async cleanTrash(now = Date.now(), { maxBytes = this.trashMaxBytes, say = true } = {}) {
    for (const dir of [this.oldTrash]) {
      for (const n of await fsp.readdir(dir).catch(() => [])) {
        const m = /^(\d{4})(\d{2})(\d{2})-/.exec(n)
        if (m && now - new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() > TRASH_DAYS * 86400_000) await fsp.rm(path.join(dir, n), { recursive: true, force: true }).catch(() => {})
      }
    }
    const bins = []
    for (const n of await fsp.readdir(this.trashRoot).catch(() => [])) {
      const m = /^(\d{4})(\d{2})(\d{2})-.*-([a-z]+)$/.exec(n) || /^(\d{4})(\d{2})(\d{2})-/.exec(n)
      if (!m) continue
      const p = path.join(this.trashRoot, n)
      const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime()
      if (now - t > TRASH_DAYS * 86400_000) { await fsp.rm(p, { recursive: true, force: true }).catch(() => {}); continue }
      const st = await fsp.stat(p).catch(() => null)
      if (!st) continue
      bins.push({ p, kind: m[4] || '', bytes: (await sizeStat(p)).bytes })
    }
    // (the commits kept for a copy that went with one the server did not have — refs/kept/<variation>-<day>-<time>: their 30 days too)
    for (const f of await fsp.readdir(this.root).catch(() => [])) {
      const repo = path.join(this.root, f, 'repo')
      if (f === 'trash' || !fs.existsSync(path.join(repo, 'HEAD'))) continue
      const at = { gitDir: repo, cwd: path.dirname(repo), check: false }
      const refs = (await this.git(['for-each-ref', '--format=%(refname)', 'refs/kept/'], at).catch(() => '')).split('\n').filter(Boolean)
      for (const r of refs) {
        const m = /-(\d{4})(\d{2})(\d{2})-\d{6}$/.exec(r)
        if (m && now - new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() > TRASH_DAYS * 86400_000) await this.git(['update-ref', '-d', r], at).catch(() => {})
      }
    }
    const total = bins.reduce((n, b) => n + b.bytes, 0)
    if (maxBytes > 0 && total > maxBytes && say) { this.fullSaidAt = now; this.emit('trash-full', { bytes: total, maxBytes, bins: bins.length }) }
    return { bytes: total }
  }

  // ---------- seat:list — the seats the server says this computer holds ----------
  // (each decision that changes something is taken again inside the variation's lock, against the latest list: a list that came in
  // meanwhile — the seat came back, a prepare ran — wins over the one that queued it)
  async reconcile(list, at = 0) {
    if (this.other) return
    const items = new Map((Array.isArray(list) ? list : []).filter((x) => UUID.test(String(x?.variation || ''))).map((x) => [String(x.variation), x]))
    this.lastList = items
    this.lastListAt = Number(at) || 0
    const bad = (err) => this.log(`[seats] ${err.message}`)
    for (const e of this.store.all()) {
      const vid = e.variationId
      const it = items.get(vid)
      // gone, or moved on since (another epoch): what is here goes its own way
      if (!it || Number(it.epoch) !== Number(e.epoch)) { this.locked(vid, () => this.leftoverIfGone(vid)).catch(bad); continue }
      if (!e.dir || !fs.existsSync(e.dir)) { this.send({ type: 'seat:failed', variation: vid, epoch: e.epoch, why: 'missing' }); this.drop(vid); continue }
      if (typeof it.autoSave === 'boolean' && it.autoSave !== (e.autoSave !== false)) this.mark(vid, { autoSave: it.autoSave })
      if (it.state === 'moving') { this.locked(vid, () => this.readyIfAdded(vid, Number(it.epoch))).catch(bad); continue }
      if (it.state === 'held') {
        if (!['held', 'blocked'].includes(e.state)) this.mark(vid, { state: 'held' })
        if (!this.watchers.has(vid)) this.watchOne(this.get(vid))
        this.statusSoon(vid, true)
        // (a save point each time the app comes back: what was done while it was off or offline goes up now)
        this.auto(vid, 'linkup')
      }
    }
    for (const [vid, it] of items) if (!this.get(vid)) this.send({ type: 'seat:failed', variation: vid, epoch: Number(it.epoch) || 0, why: 'missing' })
    this.drain()
  }

  listed(vid) { return this.lastList?.get(String(vid)) || null }
  // (in the lock) the latest list does not have this working copy at its epoch: the leftover way
  async leftoverIfGone(vid) {
    const cur = this.get(vid)
    if (!cur) return null
    const it = this.listed(vid)
    if (it && Number(it.epoch) === Number(cur.epoch)) return null
    // (a list the server made before the seat:prepare this computer last had for it: older news — the prepare stands)
    if (this.lastListAt && (this.prepAt.get(vid) || 0) > this.lastListAt) return null
    return this.leftoverNow(cur)
  }
  // (in the lock) the server still has it moving: ready again only for a copy that was added completely; one that stopped half way (the app
  // quit during worktree add) is not one — the server hears it failed (보관 중), and what was made goes to the trash
  async readyIfAdded(vid, epoch) {
    const cur = this.get(vid)
    if (!cur || Number(cur.epoch) !== epoch) return null
    if (isAdded(cur) && await this.checkCopy(cur).then(() => true, () => false)) return this.becomeReady(cur)
    this.send({ type: 'seat:failed', variation: vid, epoch, why: 'unfinished' })
    // (a folder that cannot be moved aside keeps its record: the next list tries again — nothing is left behind unrecorded)
    try { await this.aside(cur, 'unfinished') } catch (err) { this.log(`[seats] ${err.message}`); this.mark(vid, { state: 'left', why: 'aside' }); return null }
    this.drop(vid)
    return null
  }

  // ---------- what the page asks (through main — ids only) ----------
  // wait until this computer holds the variation (the page asked the server for it; the server's seat:prepare does the work)
  open(vid, ms = this.openMs) {
    vid = String(vid || '')
    const asked = Date.now()
    return new Promise((resolve) => {
      let timer = null
      const done = (r) => { clearTimeout(timer); this.off('state', check); resolve(r) }
      const check = () => {
        const e = this.get(vid)
        if (e && ['held', 'blocked'].includes(e.state)) return done({ ok: true })
        if (e?.state === 'left') return done({ ok: false, why: e.why === 'in_use' ? 'in_use' : 'leftover' })
        const f = this.failed.get(vid)
        if (f && f.at >= asked - 30_000) return done({ ok: false, why: f.why })
        return null
      }
      this.on('state', check)
      timer = setTimeout(() => done({ ok: false, why: 'timeout' }), ms)
      timer.unref?.()
      check()
    })
  }
  setAuto(vid, on) {
    vid = String(vid || '')
    const e = this.mark(vid, { autoSave: !!on })
    if (!e) return { ok: false, why: 'not_here' }
    this.send({ type: 'seat:prefs', variation: vid, autoSave: !!on })
    return { ok: true, autoSave: !!on }
  }
  dropLeft(vid) {
    vid = String(vid || '')
    return this.locked(vid, async () => {
      const e = this.get(vid)
      if (!e || e.state !== 'left') return { ok: false, why: 'not_left' }
      // (what never reached the server is not thrown away: the whole working copy goes to the app's trash)
      const kept = await this.remove(e, { all: true })
      if (kept) this.emit('trashed', { variationId: vid, title: e.title, folderName: e.folderName, kept, why: 'dropped' })
      this.drop(vid)
      return { ok: true, kept }
    })
  }
}

// (asynchronous, and yielding now and then: a large tree never holds the app's main process up)
const yieldNow = () => new Promise((r) => setImmediate(r))
async function walkFiles(dir, skip, onFile) {
  let n = 0
  const walk = async (d, depth) => {
    if (depth > 60) return
    let ents = []
    try { ents = await fsp.readdir(d, { withFileTypes: true }) } catch { return }
    for (const x of ents) {
      if (!depth && skip.includes(x.name)) continue
      const p = path.join(d, x.name)
      if (x.isDirectory()) await walk(p, depth + 1)
      else { await onFile(p); if (++n % 500 === 0) await yieldNow() }
    }
  }
  await walk(dir, 0)
  return n
}
const countFiles = (dir, skip = []) => walkFiles(dir, skip, () => {})
async function sizeStat(dir) {
  let bytes = 0
  const files = await walkFiles(dir, [], async (p) => { try { bytes += (await fsp.lstat(p)).size } catch { /* gone */ } })
  return { files, bytes }
}
// a file's git blob id as git would store it (the link's text for a link) — streamed; null for what is neither
async function blobOf(p, algo = 'sha1') {
  const st = await fsp.lstat(p)
  const h = crypto.createHash(algo)
  if (st.isSymbolicLink()) { const t = Buffer.from(await fsp.readlink(p)); h.update(`blob ${t.length}\0`); h.update(t); return h.digest('hex') }
  if (!st.isFile()) return null
  h.update(`blob ${st.size}\0`)
  let n = 0
  await new Promise((resolve, reject) => fs.createReadStream(p).on('data', (c) => { n += c.length; h.update(c) }).on('end', resolve).on('error', reject))
  return n === st.size ? h.digest('hex') : null
}
// whether two folders hold the same files — each of the same kind, size and content (a copy across disks, checked before the original goes)
async function sameTrees(a, b) {
  const list = async (dir) => {
    const out = new Map()
    await walkFiles(dir, [], async (p) => {
      const rel = path.relative(dir, p)
      const st = await fsp.lstat(p).catch(() => null)
      out.set(rel, st ? `${st.isSymbolicLink() ? 'l' : 'f'} ${st.size} ${await blobOf(p).catch(() => 'x')}` : 'gone')
    })
    return out
  }
  const [x, y] = await Promise.all([list(a), list(b)])
  if (x.size !== y.size) return false
  for (const [k, v] of x) if (y.get(k) !== v || v === 'gone') return false
  return true
}

module.exports = { WorkingCopies, TurnWatch, TurnHub, wcGit, setTap, ALLOWED, WORKTREE, claudeKey, titleSlug, seatBranch, foldFor, SAVE_MESSAGE, RELEASE_MESSAGE, LEFT_MESSAGE }
