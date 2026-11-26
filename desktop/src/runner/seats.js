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
const { spawn } = require('node:child_process')
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
  'symbolic-ref', 'ls-files', 'ls-tree', 'diff'])
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
function wcGit(args, { gitDir = null, cwd, hooks, token = '', url = '', input = null, env = {}, timeout = LOCAL_MS, check = true, ceiling = null } = {}) {
  const sub = args[0]
  if (!ALLOWED.has(sub) || (sub === 'worktree' && !WORKTREE.has(args[1]))) return Promise.reject(new G.GitError(`git ${sub}${sub === 'worktree' ? ` ${args[1]}` : ''} is not used on a working copy`))
  const full = [...(gitDir ? [`--git-dir=${gitDir}`] : []), ...args]
  const pairs = quietPairs(hooks)
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
  pollCodex() {
    if (!this.codexHome || !this.watchers.size) return
    const byDir = new Map([...this.watchers.values()].map((t) => [t.dir, t]))
    for (const file of this.rollouts()) {
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
    codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), watchFn, prepareBeatMs = PREPARE_BEAT_MS,
    trashMaxBytes = (Number(process.env.PGL_SEAT_TRASH_MAX_MB) || TRASH_MAX_MB) * 1024 * 1024 } = {}) {
    super({ server, send, log, prefix: 'seat:', key: 'variation', askMs, ...(watchFn ? { watchFn } : {}) })
    this.userId = String(userId || '')
    this.dataDir = path.resolve(dataDir)
    this.root = path.join(this.dataDir, 'folders', SY.serverKey(this.server), SY.personKey(this.userId))
    this.trashRoot = path.join(this.dataDir, 'trash')
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
    this.trashMaxBytes = trashMaxBytes
    this.busy = new Set()
    this.turnHub = new TurnHub({ claudeHome, codexHome, every: turnMs })
    this.lastList = null // the server's latest seat:list (variation → {epoch, state}) — looked at again inside each variation's lock
    this.statusAt = new Map()
    this.statusTimer = new Map()
    this.failed = new Map() // variation → {why, at}: a prepare that did not make it (open() says so)
    this.other = false
    this.scan = null
    this.cleanTrash()
    // (the trash is emptied of what is older than 30 days, or over its size, now and every few hours)
    this.trashTimer = setInterval(() => this.cleanTrash(), TRASH_EVERY_MS)
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
      dirty: e.dirty || 0, ahead: e.ahead || 0, branchOk: e.branchOk !== false, flagged: e.flagged || 0, pushedAt: e.pushedAt || null, autoSave: e.autoSave !== false,
      busy: this.busy.has(e.variationId) }
  }
  list() { return this.store.all().filter((e) => e.state !== 'left').map((e) => this.view(e)) }
  leftovers() { return this.store.all().filter((e) => e.state === 'left').map((e) => this.view(e)) }
  // the working copy's folder (main opens it in Finder · a terminal; the page never learns it)
  pathOf(vid) { const e = this.get(vid); return e?.dir && this.inside(e.dir) && fs.existsSync(e.dir) ? e.dir : null }
  inside(dir) { return isInside(path.resolve(dir), this.root) }
  git(args, o = {}) { return wcGit(args, { hooks: this.hooks, ...o }) }

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
  }
  // what the server sends (seat:*): a waiter's answer, or the server's own word
  handle(msg) {
    if (this.answer(msg)) return
    if (this.other) return
    const vid = String(msg?.variation || '')
    const bad = (e) => this.log(`[seats] ${msg.type} ${var8(vid)}: ${e.message}`)
    switch (msg.type) {
      case 'seat:list': this.reconcile(msg.seats).catch(bad); return
      case 'seat:prepare': this.prepare(msg).catch(bad); return
      case 'seat:save': if (this.get(vid)) this.round(vid, 'asked').catch(bad); return
      case 'seat:recall': {
        const e = this.get(vid)
        if (!e) return
        if (msg.auto) { this.release(vid, { auto: true }).catch(bad); return }
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
  async checkAdded(e, tip) {
    await this.checkCopy(e)
    if (split0(await this.git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: e.dir })).length) throw new G.GitError('the working copy was not added cleanly')
    if (tip && (await this.headOf(e)) !== tip) throw new G.GitError('the working copy is not at the head it was given')
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
        await this.leftoverNow(e)
        if (this.get(vid)) {
          this.fail(vid, 'leftover')
          this.send({ type: 'seat:failed', variation: vid, epoch, why: 'leftover' })
          return { ok: false, why: 'leftover' }
        }
      } else if (e) this.drop(vid)
      this.secret(m.token)
      const person = m.person && typeof m.person === 'object' ? { name: String(m.person.name || '').slice(0, 80), email: String(m.person.email || '').slice(0, 120) } : null
      const dir = this.placeFor(folderId, vid, m.title)
      e = { variationId: vid, folderId, folderName: String(m.folderName || '').slice(0, 120), title: String(m.title || '').slice(0, 120), branch: String(m.branch), dir,
        epoch, head: null, pushedAt: null, autoSave: m.autoSave !== false, state: 'preparing', why: null, dirty: 0, ahead: 0, branchOk: true, flagged: 0, person, added: false }
      // (a folder at that place with no record of it — left behind by an older app, a crash: never reused, never mixed in — to the trash)
      if (fs.existsSync(dir)) await this.aside({ ...e }, 'orphan')
      this.put(e)
      // (a large folder's first fetch takes longer than a move may: the server hears that this computer is still at it)
      const beat = () => this.send({ type: 'seat:preparing', variation: vid, epoch })
      beat()
      const beating = setInterval(beat, this.prepareBeatMs)
      beating.unref?.()
      let made = false
      try {
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
        if (made && fs.existsSync(dir)) await this.aside(e, 'unfinished').catch((x) => this.log(`[seats] ${x.message}`))
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
  async counts(e) {
    const dirty = split0(await this.git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'], { cwd: e.dir, check: false })).length
    const branchOk = await this.branchOk(e)
    const ahead = e.head ? await this.beyond(e, e.head).catch(() => 0) : 0
    return { dirty, ahead, branchOk }
  }
  async sendStatus(vid) {
    const e = this.get(vid)
    if (!e || !['held', 'blocked'].includes(e.state) || !e.dir || !fs.existsSync(e.dir)) return
    const c = await this.counts(e)
    this.statusAt.set(vid, Date.now())
    this.mark(vid, c)
    this.send({ type: 'seat:status', variation: vid, epoch: e.epoch, ...c })
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
        // (back to what the last commit had for it)
        const info = split0(await this.git(['ls-tree', '-z', 'HEAD', '--', ...tracked.map((c) => c.path)], { cwd }))
        const lines = info.map((l) => { const [meta, p] = [l.slice(0, l.indexOf('\t')), l.slice(l.indexOf('\t') + 1)]; const [mode, , sha] = meta.split(' '); return `${mode} ${sha}\t${p}` })
        if (lines.length) await this.git(['update-index', '-z', '--index-info'], { cwd, input: `${lines.join('\0')}\0` })
      }
    }
    const left = split0(await this.git(['diff', '--cached', '--name-only', '-z'], { cwd }))
    if (!left.length) return { commit: null, flagged: out.length }
    const p = e.person || {}
    const u = this.userFn() || {}
    const name = String(p.name || u.name || 'Process GPT Lite').slice(0, 80)
    const email = String(p.email || `${this.userId || 'desktop'}@users.pgpt-lite.local`).slice(0, 120)
    await this.git(['commit', '-q', '--no-verify', '-m', message], { cwd, env: { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email } })
    return { commit: await this.headOf(e), flagged: out.length }
  }

  // commit as is → a token for this variation at this epoch → push its seat branch → {head, pushed, flagged} | {why}
  async upload(e, message) {
    const c = await this.commitAsIs(e, message)
    const head = await this.headOf(e)
    if (!head) return { why: 'failed' }
    if (head === e.head) return { head, pushed: false, flagged: c.flagged }
    const t = await this.ask({ type: 'seat:token', variation: e.variationId, epoch: e.epoch, for: 'push' }, ['seat:token'])
    if (t.type !== 'seat:token' || !t.token) return { why: String(t.why || 'refused'), head, flagged: c.flagged }
    // (a token for another epoch than this working copy's: this computer no longer has the seat — nothing is pushed)
    if (Number(t.epoch) !== Number(e.epoch)) { this.log(`[seats] ${var8(e.variationId)}: a token for epoch ${t.epoch}, this working copy is ${e.epoch} — not pushed`); return { why: 'stale', head, flagged: c.flagged } }
    const branch = seatBranch(e.variationId, e.epoch)
    if (t.branch !== branch) throw new G.GitError('the token is not for this working copy\'s branch')
    this.secret(t.token)
    const url = this.urlOf(t)
    await this.git(['push', '--porcelain', '--no-verify', '--no-follow-tags', url, `+HEAD:refs/heads/${branch}`], { cwd: e.dir, token: t.token, url, timeout: NETWORK_MS })
    return { head, pushed: true, flagged: c.flagged }
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
          try { kept = await this.remove(e) } catch (err) {
            this.log(`[seats] ${var8(vid)}: given back, but the working copy could not be moved aside — ${err.message}`)
            this.mark(vid, { state: 'left', why: 'remove' })
            return { ok: false, why: 'remove' }
          }
          this.drop(vid)
          this.emit('released', { variationId: vid, title: e.title, folderName: e.folderName, kept, auto })
          return { ok: true, kept, ...(left ? { left } : {}) }
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
    this.unwatchOne(vid)
    try {
      let base = e.head
      if (!base) base = (await this.git(['rev-parse', '--verify', '--quiet', `refs/remotes/lite/${vid}^{commit}`], { gitDir: this.repoOf(e), cwd: path.dirname(this.repoOf(e)), check: false })).trim() || null
      const c = await this.commitAsIs(e, LEFT_MESSAGE)
      const head = await this.headOf(e)
      // (git that cannot say where the working copy is: it stays — a working copy is never removed on a guess)
      if (!head) throw new G.GitError('the working copy has no head')
      if (base && (await this.beyond(e, base)) === 0) {
        const kept = await this.remove(e)
        this.drop(vid)
        // (nothing new for the server — but what only this PC had, .env and the like, is said to have gone to the trash)
        if (kept) this.emit('trashed', { variationId: vid, title: e.title, folderName: e.folderName, kept, why: 'gone' })
        return { ok: true, left: null, kept, flagged: c.flagged }
      }
      if (!this.connected) { this.mark(vid, { state: 'left', why: 'offline' }); return { ok: false, why: 'offline' } }
      const l = await this.leftPush(e, head)
      if (!l.ok) { this.mark(vid, { state: 'left', why: l.why }); return { ok: false, why: l.why } }
      const kept = await this.remove(e)
      this.drop(vid)
      this.emit('left', { variationId: vid, title: e.title, folderName: e.folderName, newVariation: l.newVariation, kept })
      return { ok: true, left: l.newVariation, kept }
    } catch (err) {
      this.log(`[seats] ${var8(vid)}: leftover — ${err.message}`)
      this.mark(vid, { state: 'left', why: 'failed' })
      return { ok: false, why: 'failed' }
    }
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

  // The working copy goes — never deleted: the whole folder is moved into the app's trash (<data>/trash/<day>-<var8>, 30 days and a size cap),
  // then git forgets the worktree; the folder's objects stay (the next working copy of this folder comes quicker). A copy that is not
  // the app's own (checkCopy) is not touched unless `all` (「남은 변경 버리기」 — the person said so in a system dialog: moved as it is). A
  // folder that cannot be moved (a terminal holds it on Windows) throws: the caller keeps the copy. → how many files only this PC had
  // (what git does not carry: new files left out, ignored ones, changes kept out — everything for `all`)
  async remove(e, { all = false } = {}) {
    const vid = e.variationId
    let kept = 0
    if (e.dir && fs.existsSync(e.dir)) {
      if (!this.inside(e.dir)) throw new G.GitError('not a working copy of the app')
      if (!all) {
        await this.checkCopy(e)
        // (asked strictly: a status git could not give stops here — the caller keeps the working copy)
        const raw = split0(await this.git(['status', '--porcelain=v1', '-z', '--ignored=matching', '--untracked-files=all', '--no-renames'], { cwd: e.dir }))
        for (const x of raw) {
          const rel = x.slice(3).replace(/\/+$/, '')
          if (!rel || rel.split('/').some((p) => p === '..' || p === '.git')) continue
          let st
          try { st = fs.lstatSync(path.join(e.dir, ...rel.split('/'))) } catch { continue }
          kept += st.isDirectory() ? countFiles(path.join(e.dir, ...rel.split('/'))) : 1
        }
      } else kept = countFiles(e.dir, ['.git'])
      this.unwatchOne(vid)
      await this.moveToTrash(e.dir, vid)
    } else this.unwatchOne(vid)
    await this.forgetWorktree(e)
    return kept
  }
  // a folder at a working copy's place that is not (or no longer) one: to the trash as it is, said to the person → files moved
  async aside(e, why) {
    if (!e?.dir || !fs.existsSync(e.dir) || !this.inside(e.dir)) return 0
    const kept = countFiles(e.dir, ['.git'])
    this.unwatchOne(e.variationId)
    await this.moveToTrash(e.dir, e.variationId)
    await this.forgetWorktree(e)
    if (kept) this.emit('trashed', { variationId: e.variationId, title: e.title || '', folderName: e.folderName || '', kept, why })
    return kept
  }
  // (one rename on the same disk: nothing is copied, nothing deleted; the worktree's .git pointer is dropped from the moved copy)
  async moveToTrash(dir, vid) {
    fs.mkdirSync(this.trashRoot, { recursive: true })
    let bin = path.join(this.trashRoot, `${day()}-${var8(vid)}`)
    for (let i = 2; fs.existsSync(bin); i++) bin = path.join(this.trashRoot, `${day()}-${var8(vid)}-${i}`)
    fs.renameSync(dir, bin)
    try { if (fs.lstatSync(path.join(bin, '.git')).isFile()) fs.rmSync(path.join(bin, '.git')) } catch { /* none */ }
    return bin
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
  // the trash: older than 30 days goes; over its size (maxBytes), the oldest go first — the newest is always kept
  cleanTrash(now = Date.now(), { maxBytes = this.trashMaxBytes } = {}) {
    let names = []
    try { names = fs.readdirSync(this.trashRoot) } catch { return }
    const bins = []
    for (const n of names) {
      const m = /^(\d{4})(\d{2})(\d{2})-/.exec(n)
      if (!m) continue
      const p = path.join(this.trashRoot, n)
      const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime()
      if (now - t > TRASH_DAYS * 86400_000) { try { fs.rmSync(p, { recursive: true, force: true }) } catch { /* next time */ } continue }
      let mt = 0
      try { mt = fs.statSync(p).mtimeMs } catch { continue }
      bins.push({ p, key: `${n.slice(0, 8)}-${String(Math.floor(mt)).padStart(15, '0')}`, bytes: bytesOf(p) })
    }
    if (!(maxBytes > 0)) return
    bins.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    let total = bins.reduce((n, b) => n + b.bytes, 0)
    while (total > maxBytes && bins.length > 1) {
      const b = bins.shift()
      try { fs.rmSync(b.p, { recursive: true, force: true }); total -= b.bytes } catch { break }
    }
  }

  // ---------- seat:list — the seats the server says this computer holds ----------
  // (each decision that changes something is taken again inside the variation's lock, against the latest list: a list that came in
  // meanwhile — the seat came back, a prepare ran — wins over the one that queued it)
  async reconcile(list) {
    if (this.other) return
    const items = new Map((Array.isArray(list) ? list : []).filter((x) => UUID.test(String(x?.variation || ''))).map((x) => [String(x.variation), x]))
    this.lastList = items
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
    return this.leftoverNow(cur)
  }
  // (in the lock) the server still has it moving: ready again only for a copy that was added completely; one that stopped half way (the app
  // quit during worktree add) is not one — the server hears it failed (보관 중), and what was made goes to the trash
  async readyIfAdded(vid, epoch) {
    const cur = this.get(vid)
    if (!cur || Number(cur.epoch) !== epoch) return null
    if (isAdded(cur) && await this.checkCopy(cur).then(() => true, () => false)) return this.becomeReady(cur)
    this.send({ type: 'seat:failed', variation: vid, epoch, why: 'unfinished' })
    await this.aside(cur, 'unfinished').catch((err) => this.log(`[seats] ${err.message}`))
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
        if (e?.state === 'left') return done({ ok: false, why: 'leftover' })
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

function countFiles(dir, skip = []) {
  let n = 0
  const walk = (d, depth) => {
    if (depth > 60) return
    let ents = []
    try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const x of ents) { if (!depth && skip.includes(x.name)) continue; if (x.isDirectory()) walk(path.join(d, x.name), depth + 1); else n++ }
  }
  walk(dir, 0)
  return n
}
function bytesOf(dir) {
  let n = 0
  const walk = (d, depth) => {
    if (depth > 60) return
    let ents = []
    try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const x of ents) { const p = path.join(d, x.name); if (x.isDirectory()) walk(p, depth + 1); else { try { n += fs.lstatSync(p).size } catch { /* gone */ } } }
  }
  walk(dir, 0)
  return n
}

module.exports = { WorkingCopies, TurnWatch, TurnHub, wcGit, setTap, ALLOWED, WORKTREE, claudeKey, titleSlug, seatBranch, SAVE_MESSAGE, RELEASE_MESSAGE, LEFT_MESSAGE }
