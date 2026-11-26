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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CONTROL = new Set(['.gitmodules', '.lfsconfig'])
// the commits the app makes (their author is the person; no machine name in them)
const SAVE_MESSAGE = '저장 지점'
const RELEASE_MESSAGE = '돌려놓기'
const LEFT_MESSAGE = '남아 있던 변경'

const split0 = (s) => String(s || '').split('\0').filter(Boolean)
const isInside = (child, parent) => { const r = path.relative(parent, child); return !!r && !r.startsWith('..') && !path.isAbsolute(r) }
const var8 = (vid) => String(vid).slice(0, 8)
const seatBranch = (vid, epoch) => `pgpt-agent/seat-${var8(vid)}-${Number(epoch)}/head`
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
// every call: links as plain files, no hooks, no signing, no submodules, protocol v0, no automatic gc
function quietPairs(hooks) {
  return [['core.symlinks', 'false'], ['core.hooksPath', hooks], ['core.fsmonitor', 'false'], ['core.precomposeUnicode', 'true'], ['commit.gpgSign', 'false'],
    ['push.gpgSign', 'false'], ['gc.auto', '0'], ['maintenance.auto', 'false'], ['submodule.recurse', 'false'], ['fetch.recurseSubmodules', 'false'],
    ['push.recurseSubmodules', 'no'], ['protocol.version', '0'], ['advice.detachedHead', 'false'], ['init.defaultBranch', 'main']]
}
function wcGit(args, { gitDir = null, cwd, hooks, token = '', url = '', input = null, env = {}, timeout = LOCAL_MS, check = true } = {}) {
  const sub = args[0]
  if (!ALLOWED.has(sub) || (sub === 'worktree' && !WORKTREE.has(args[1]))) return Promise.reject(new G.GitError(`git ${sub}${sub === 'worktree' ? ` ${args[1]}` : ''} is not used on a working copy`))
  const full = [...(gitDir ? [`--git-dir=${gitDir}`] : []), ...args]
  try { tap?.({ sub, args: full, gitDir, cwd }) } catch { /* tests */ }
  const e = { ...baseEnv(), GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '', LC_ALL: 'C', ...G.authEnv(token, quietPairs(hooks), url), ...env }
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
class TurnWatch {
  constructor(dir, { claudeHome, codexHome, every = TURN_MS, onEnd = () => {}, onStart = () => {}, since = Date.now() } = {}) {
    let real = dir
    try { real = fs.realpathSync(dir) } catch { /* as it is */ }
    this.dir = real
    this.claudeDir = claudeHome ? path.join(claudeHome, 'projects', claudeKey(real)) : null
    this.codexHome = codexHome || null
    this.every = every
    this.onEnd = onEnd
    this.onStart = onStart
    this.since = since
    this.files = new Map() // file → {off, partial, kind}
    this.busy = false
    this.lastEnd = 0
    this.timer = null
  }
  start() { if (!this.timer) { this.timer = setInterval(() => this.poll(), this.every); this.timer.unref?.() } return this }
  stop() { clearInterval(this.timer); this.timer = null }
  poll() {
    try { this.pollClaude() } catch { /* not there yet */ }
    try { this.pollCodex() } catch { /* not there yet */ }
  }
  follow(file, kind) {
    let st
    try { st = fs.statSync(file) } catch { return [] }
    let f = this.files.get(file)
    // (a session already there before the working copy was watched: only what it writes from now on)
    if (!f) { f = { off: st.mtimeMs < this.since - 1000 ? st.size : 0, partial: '', kind }; this.files.set(file, f) }
    if (st.size < f.off) f.off = 0
    if (st.size === f.off) return []
    const fd = fs.openSync(file, 'r')
    try {
      const b = Buffer.alloc(Math.min(st.size - f.off, 8 * 1024 * 1024))
      fs.readSync(fd, b, 0, b.length, f.off)
      f.off += b.length
      const lines = (f.partial + b.toString('utf8')).split('\n')
      f.partial = lines.pop()
      return lines.filter((l) => l.trim()).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
    } finally { fs.closeSync(fd) }
  }
  pollClaude() {
    if (!this.claudeDir || !fs.existsSync(this.claudeDir)) return
    for (const n of fs.readdirSync(this.claudeDir)) {
      if (!n.endsWith('.jsonl')) continue
      for (const e of this.follow(path.join(this.claudeDir, n), 'claude')) this.claude(e)
    }
  }
  claude(e) {
    if (e?.type === 'user' && !e.isMeta) {
      const c = e.message?.content
      if (typeof c === 'string' || (Array.isArray(c) && !c.some((b) => b?.type === 'tool_result'))) this.start_()
    } else if (e?.type === 'assistant' && ['end_turn', 'stop_sequence'].includes(e.message?.stop_reason)) this.end()
    else if (e?.type === 'system' && ['stop_hook_summary', 'turn_duration'].includes(e.subtype)) this.end()
  }
  pollCodex() {
    if (!this.codexHome) return
    const now = Date.now()
    for (let d = new Date(now - 86400_000); d <= new Date(now + 86400_000); d = new Date(d.getTime() + 86400_000)) {
      const dir = path.join(this.codexHome, 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'))
      let names = []
      try { names = fs.readdirSync(dir) } catch { continue }
      for (const n of names) {
        if (!/^rollout-.*\.jsonl$/.test(n)) continue
        const file = path.join(dir, n)
        const known = this.files.get(file)
        if (known?.kind === 'other') continue
        if (!known) {
          let cwd = null
          try { for (const l of fs.readFileSync(file, 'utf8').split('\n').slice(0, 20)) { try { const e = JSON.parse(l); if (e?.type === 'session_meta') { cwd = e.payload?.cwd || null; break } } catch { /* partial */ } } } catch { continue }
          if (!cwd) continue
          let real = cwd
          try { real = fs.realpathSync(cwd) } catch { /* as it is */ }
          if (real !== this.dir) { this.files.set(file, { kind: 'other' }); continue }
        }
        for (const e of this.follow(file, 'codex')) this.codex(e)
      }
    }
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

// ---------- the working copies of one person on one server ----------
// store: this server's and this person's entries in the app's settings (settings.seatStore) — the only place a path is kept.
// send(msg): the link (runner/link.js). Events: 'state' (list()) · 'recall' {variationId, title, folderName, by, why} · 'left' {variationId,
// title, folderName, newVariation} · 'released' {variationId, title, kept}
class WorkingCopies extends Uploader {
  constructor({ dataDir, server, userId, store, send = () => false, device = {}, user = () => null, log = () => {}, rules = SY.compileRules(),
    askMs = 30_000, takeMs = TAKE_MS, quietMs = Number(process.env.PGL_SEAT_QUIET_MS) || QUIET_MS, statusMs = Number(process.env.PGL_SEAT_STATUS_MS) || STATUS_MS, scanMs = SCAN_MS, turnMs = TURN_MS,
    turnWaitMs = TURN_WAIT_MS, openMs = OPEN_MS, claudeHome = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
    codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), watchFn } = {}) {
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
    this.busy = new Set()
    this.turns = new Map()
    this.statusAt = new Map()
    this.statusTimer = new Map()
    this.failed = new Map() // variation → {why, at}: a prepare that did not make it (open() says so)
    this.other = false
    this.scan = null
    this.cleanTrash()
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
    for (const t of this.turns.values()) t.stop()
    this.turns.clear()
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
  // the working copy of a variation: the one already there for its id, else <var8>-<title>
  wtDirOf(folderId, vid, title) {
    const wt = path.join(this.folderDir(folderId), 'wt')
    try { const had = fs.readdirSync(wt).find((n) => n === var8(vid) || n.startsWith(`${var8(vid)}-`)); if (had) return path.join(wt, had) } catch { /* none yet */ }
    const slug = titleSlug(title)
    return path.join(wt, slug ? `${var8(vid)}-${slug}` : var8(vid))
  }
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
  async beyond(e, base) {
    if (!base) return 1
    return Number((await this.git(['rev-list', '--count', `${base}..HEAD`], { cwd: e.dir, check: false })).trim() || 0)
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
      if (e && Number(e.epoch) === epoch && e.state !== 'left' && e.dir && fs.existsSync(e.dir)) return this.becomeReady(e)
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
      const dir = this.wtDirOf(folderId, vid, m.title)
      e = { variationId: vid, folderId, folderName: String(m.folderName || '').slice(0, 120), title: String(m.title || '').slice(0, 120), branch: String(m.branch), dir,
        epoch, head: null, pushedAt: null, autoSave: m.autoSave !== false, state: 'preparing', why: null, dirty: 0, ahead: 0, branchOk: true, flagged: 0, person }
      this.put(e)
      let made = false
      try {
        const url = this.urlOf(m)
        const repo = await this.ensureRepo(folderId, person)
        await this.git(['fetch', '-q', '--no-tags', '--no-recurse-submodules', url, `+refs/heads/${e.branch}:refs/remotes/lite/${var8(vid)}`],
          { gitDir: repo, cwd: path.dirname(repo), token: m.token, url, timeout: NETWORK_MS })
        const tip = (await this.git(['rev-parse', '--verify', '--quiet', `refs/remotes/lite/${var8(vid)}^{commit}`], { gitDir: repo, cwd: path.dirname(repo), check: false })).trim()
        if (!tip) throw new G.GitError('the variation is not on the server')
        if (!fs.existsSync(path.join(dir, '.git'))) {
          fs.mkdirSync(path.dirname(dir), { recursive: true })
          await this.git(['worktree', 'add', '-q', '-B', e.branch, dir, `refs/remotes/lite/${var8(vid)}`], { gitDir: repo, cwd: path.dirname(repo) })
          made = true
        }
        e = this.mark(vid, { head: tip })
        return this.becomeReady(e)
      } catch (err) {
        this.log(`[seats] ${var8(vid)}: prepare failed — ${err.message}`)
        this.send({ type: 'seat:failed', variation: vid, epoch, why: 'git' })
        if (made) await this.remove(e).catch(() => {})
        this.drop(vid)
        this.fail(vid, 'failed')
        return { ok: false, why: 'failed' }
      }
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
    if (!this.turns.has(vid)) {
      this.turns.set(vid, new TurnWatch(e.dir, { claudeHome: this.claudeHome, codexHome: this.codexHome, every: this.turnMs, onEnd: () => this.auto(vid, 'turn') }).start())
    }
  }
  unwatchOne(vid) {
    this.unwatch(vid)
    this.turns.get(vid)?.stop()
    this.turns.delete(vid)
    clearTimeout(this.statusTimer.get(vid))
    this.statusTimer.delete(vid)
  }
  turnBusy(vid) { return !!this.turns.get(vid)?.busy }
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
    const ahead = e.head ? await this.beyond(e, e.head) : 0
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
    await this.git(['push', '--porcelain', '--no-verify', url, `+HEAD:refs/heads/${branch}`], { cwd: e.dir, token: t.token, url, timeout: NETWORK_MS })
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
          const kept = await this.remove(e)
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
    this.unwatchOne(vid)
    if (!e.dir || !fs.existsSync(e.dir) || !this.inside(e.dir)) { this.drop(vid); return { ok: true, left: null, kept: 0 } }
    try {
      let base = e.head
      if (!base) base = (await this.git(['rev-parse', '--verify', '--quiet', `refs/remotes/lite/${var8(vid)}^{commit}`], { gitDir: this.repoOf(e), cwd: e.dir, check: false })).trim() || null
      const c = await this.commitAsIs(e, LEFT_MESSAGE)
      const head = await this.headOf(e)
      // (git that cannot say where the working copy is: it stays — a working copy is never removed on a guess)
      if (!head) throw new G.GitError('the working copy has no head')
      if (base && (await this.beyond(e, base)) === 0) {
        const kept = await this.remove(e)
        this.drop(vid)
        return { ok: true, left: null, kept, flagged: c.flagged }
      }
      if (!this.connected) { this.mark(vid, { state: 'left', why: 'offline' }); return { ok: false, why: 'offline' } }
      const l = await this.leftPush(e, head)
      if (!l.ok) { this.mark(vid, { state: 'left', why: l.why }); return { ok: false, why: l.why } }
      const kept = await this.remove(e)
      this.drop(vid)
      this.emit('left', { variationId: vid, title: e.title, folderName: e.folderName, newVariation: l.newVariation })
      return { ok: true, left: l.newVariation, kept }
    } catch (err) {
      this.log(`[seats] ${var8(vid)}: leftover — ${err.message}`)
      this.mark(vid, { state: 'left', why: 'failed' })
      return { ok: false, why: 'failed' }
    }
  }
  // HEAD up as the variation's leftover from this computer (a one-time token for pgpt-agent/left-<var8>-<dev8>/) → {ok, newVariation} | {why}
  async leftPush(e, head) {
    const vid = e.variationId
    const t = await this.ask({ type: 'seat:token', variation: vid, epoch: e.epoch, for: 'left' }, ['seat:token'])
    if (t.type !== 'seat:token' || !t.token) return { ok: false, why: String(t.why || 'refused') }
    const branch = String(t.branch || '')
    G.checkRef(branch)
    if (!branch.startsWith(`pgpt-agent/left-${var8(vid)}-`)) throw new G.GitError('not a leftover branch of this variation')
    this.secret(t.token)
    const url = this.urlOf(t)
    await this.git(['push', '--porcelain', '--no-verify', url, `+${head}:refs/heads/${branch}`], { cwd: e.dir, token: t.token, url, timeout: NETWORK_MS })
    const r = await this.ask({ type: 'seat:left', variation: vid, head }, ['seat:left-taken'], this.takeMs)
    if (r.type !== 'seat:left-taken') return { ok: false, why: String(r.why || 'refused') }
    const nv = r.newVariation && typeof r.newVariation === 'object' ? { id: String(r.newVariation.id || ''), title: String(r.newVariation.title || '').slice(0, 160) } : null
    return { ok: true, newVariation: nv }
  }

  // the working copy goes: what git does not carry (new files left out, ignored ones — .env, builds —, changes kept out) is moved to the app's
  // trash first (<data>/trash/<day>-<var8>, 30 days), then the worktree is removed; the folder's objects stay → how many files were kept
  // all: everything in it goes to the trash, not only what git does not carry (「남은 변경 버리기」 — what never reached the server is kept
  // there too, 30 days)
  async remove(e, { all = false } = {}) {
    const vid = e.variationId
    this.unwatchOne(vid)
    let kept = 0
    const repo = this.repoOf(e)
    if (e.dir && fs.existsSync(e.dir) && this.inside(e.dir)) {
      // (asked strictly: a status git could not give stops here — the caller keeps the working copy — rather than taking it for empty)
      const raw = all ? [] : split0(await this.git(['status', '--porcelain=v1', '-z', '--ignored=matching', '--untracked-files=all', '--no-renames'], { cwd: e.dir }))
      const listed = all ? fs.readdirSync(e.dir).filter((n) => n !== '.git') : raw.map((x) => x.slice(3).replace(/\/+$/, ''))
      const rels = [...new Set(listed.filter((r) => r && !r.split('/').some((p) => p === '..' || p === '.git')))]
      if (rels.length) {
        let trash = path.join(this.trashRoot, `${day()}-${var8(vid)}`)
        for (let i = 2; fs.existsSync(trash); i++) trash = path.join(this.trashRoot, `${day()}-${var8(vid)}-${i}`)
        for (const rel of rels) {
          const from = path.join(e.dir, ...rel.split('/'))
          let st
          try { st = fs.lstatSync(from) } catch { continue }
          const to = path.join(trash, ...rel.split('/'))
          kept += st.isDirectory() ? countFiles(from) : 1
          fs.mkdirSync(path.dirname(to), { recursive: true })
          try { fs.renameSync(from, to) } catch { fs.cpSync(from, to, { recursive: true, dereference: false, verbatimSymlinks: true }) }
        }
      }
      await this.git(['worktree', 'remove', '--force', e.dir], { gitDir: repo, cwd: path.dirname(repo), check: false })
    }
    await this.git(['worktree', 'prune'], { gitDir: repo, cwd: path.dirname(repo), check: false }).catch(() => {})
    if (e.dir && fs.existsSync(e.dir) && this.inside(e.dir)) fs.rmSync(e.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    // (the app's own branch and fetched ref of it; the objects stay — the next working copy of this folder comes quicker)
    if (fs.existsSync(path.join(repo, 'HEAD'))) {
      if (e.branch) await this.git(['update-ref', '-d', `refs/heads/${e.branch}`], { gitDir: repo, cwd: path.dirname(repo), check: false }).catch(() => {})
      await this.git(['update-ref', '-d', `refs/remotes/lite/${var8(vid)}`], { gitDir: repo, cwd: path.dirname(repo), check: false }).catch(() => {})
    }
    return kept
  }
  cleanTrash(now = Date.now()) {
    let names = []
    try { names = fs.readdirSync(this.trashRoot) } catch { return }
    for (const n of names) {
      const m = /^(\d{4})(\d{2})(\d{2})-/.exec(n)
      if (!m) continue
      const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime()
      if (now - t > TRASH_DAYS * 86400_000) { try { fs.rmSync(path.join(this.trashRoot, n), { recursive: true, force: true }) } catch { /* next time */ } }
    }
  }

  // ---------- seat:list — the seats the server says this computer holds ----------
  async reconcile(list) {
    if (this.other) return
    const items = new Map((Array.isArray(list) ? list : []).filter((x) => UUID.test(String(x?.variation || ''))).map((x) => [String(x.variation), x]))
    for (const e of this.store.all()) {
      const vid = e.variationId
      const it = items.get(vid)
      // gone, or moved on since (another epoch): what is here goes its own way
      if (!it || Number(it.epoch) !== Number(e.epoch)) { this.locked(vid, () => this.leftoverNow(this.get(vid))).catch((err) => this.log(`[seats] ${err.message}`)); continue }
      if (!e.dir || !fs.existsSync(e.dir)) { this.send({ type: 'seat:failed', variation: vid, epoch: e.epoch, why: 'missing' }); this.drop(vid); continue }
      if (typeof it.autoSave === 'boolean' && it.autoSave !== (e.autoSave !== false)) this.mark(vid, { autoSave: it.autoSave })
      if (it.state === 'moving') { this.locked(vid, () => this.becomeReady(this.get(vid))).catch((err) => this.log(`[seats] ${err.message}`)); continue }
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
      this.drop(vid)
      return { ok: true, kept }
    })
  }
}

function countFiles(dir) {
  let n = 0
  const walk = (d, depth) => {
    if (depth > 60) return
    let ents = []
    try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const x of ents) { if (x.isDirectory()) walk(path.join(d, x.name), depth + 1); else n++ }
  }
  walk(dir, 0)
  return n
}

module.exports = { WorkingCopies, TurnWatch, wcGit, setTap, ALLOWED, WORKTREE, claudeKey, titleSlug, seatBranch, SAVE_MESSAGE, RELEASE_MESSAGE, LEFT_MESSAGE }
