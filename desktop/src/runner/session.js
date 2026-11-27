'use strict'
// One interactive CLI session on this computer (design docs/local-agents/design.md §4.4): the person's own `claude` or `codex` in a
// PTY — their sign-in, their settings, slash commands, the same screen as in their own terminal (the way agent-share runs it:
// agent_share/pty_session.py · sessions.py). Not tied to a process step: a step's job is one kind of session (runner.js), and a
// later kind (a developer's AI-DLC session in a repo) is another.
//
// What it gives its owner (the runner), all from what the CLI itself produces — never guessed from the screen's text:
//   'data'        the PTY's bytes (the runner relays them to the server, where every viewer sees the same screen)
//   'hook'        a Claude Code hook event (SessionStart · UserPromptSubmit · Stop · StopFailure · Notification), from the session's own
//                 --settings file (the hooks write to a file here; the runner relays them over its authenticated link — the CLI never
//                 calls the server)
//   'ready'       the CLI can take input (Claude Code: SessionStart; Codex: its first prompt was given on the command line)
//   'session'     the CLI's own session id (Claude Code: ours, --session-id; Codex: its rollout's session_meta)
//   'prompt'      a user message the CLI took (its transcript: Claude Code's session jsonl · Codex's rollout)
//   'tool' · 'text'  what it did and said (the transcript)
//   'turn-start' · 'turn-end' {summary} · 'turn-failed' {error}   (Claude Code: UserPromptSubmit · Stop · StopFailure hooks;
//                 Codex: the rollout's user_message · task_complete)
//   'attention' {message}   it waits for the person (a permission prompt, idle) — Claude Code's Notification hook
//   'tx' [items]  the conversation, item by item (transcript.js — from its own records; turn · ask · ask-done from its hooks): what the
//                 run card's 「대화」 view shows
//   'turn-interrupted'  the turn stopped without its end (Esc, a refused tool use — its records say so; no Stop hook comes)
//   'files' [{path, content, deleted}]   the watched paths changed (watch option — e.g. a repo's aidlc/ folder)
//   'exit' {code}
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const C = require('./clis')
const P = require('./pty')
const TX = require('./transcript')
const ASK = require('./prompts')

const SCROLLBACK = 400 * 1024
const POLL_MS = 250
const PASTE_ENTER_MS = 350
// Claude Code shows a long paste as one placeholder in its input box (「[Pasted text #1 +9 lines]」). An Enter that reaches it while it is still
// taking the paste in (a busy computer) is lost, and the message sits in the box unsent — the run then waits for nothing (2026-11-27: a chat
// run's first message stayed there for 10 minutes). So after the Enter of a message given while the CLI was not working, when no
// UserPromptSubmit came, its turn did not end meanwhile, no question is open and the input box's own line still holds the placeholder,
// Enter is pressed again — 3 times at most. (A message given while it works waits in Claude Code's queue: no check for it.)
const SUBMIT_CHECK_MS = 2500
const SUBMIT_TRIES = 3
const PASTE_HELD = /^\[Pasted text #\d+[^\]\n]*\]\s*$/
// the input box's line on the screen: the last line that starts with Claude Code's prompt (❯, or > inside the older box │ > …│) → its text
function inputLine(text) {
  const lines = String(text || '').split(/\r\n|\n|\r/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^\s*(?:❯|│\s*>)\s?(.*?)\s*│?\s*$/.exec(lines[i])
    if (m) return m[1]
  }
  return null
}
const plainText = (s) => String(s || '').replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '').replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '').replace(/\x1b./g, '')
const WATCH_MAX = 256 * 1024
// agent-share's _NO_ACCOUNT_SWITCH: the screen is shared, so no one switches the CLI's account from it
const NO_ACCOUNT_SWITCH = { DISABLE_LOGOUT_COMMAND: '1', DISABLE_LOGIN_COMMAND: '1' }
const HOOKS = ['SessionStart', 'UserPromptSubmit', 'Stop', 'StopFailure', 'Notification']
// PermissionRequest (the dialog it shows and what it asks — prompts.js) only where the CLI knows it: an event name an older Claude Code
// does not know would make it refuse the session's settings (measured with 2.1.331; added in 2.0.45)
const PERMISSION_HOOK_FROM = [2, 0, 45]
const newer = (v, min) => { const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(v || '')); if (!m) return false; const a = m.slice(1).map(Number); for (let i = 0; i < 3; i++) if (a[i] !== min[i]) return a[i] > min[i]; return true }
const KEY_GAP_MS = 500
const short = (v, n = 160) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n)
const WIN = process.platform === 'win32'

// The program a hook runs (hook.js — it appends the event to the session's hook file): Claude Code's exec form, no shell on any system.
// Plain Node runs the script; the desktop app runs its own binary (its node) with --pgl-hook, which main.js takes before the app starts
// (in a development run the binary is Electron itself and the app folder comes first).
function hookProgram() {
  if (process.versions.electron && process.type === 'browser') {
    const { app } = require('electron')
    return { command: process.execPath, args: [...(app.isPackaged ? [] : [app.getAppPath()]), '--pgl-hook'] }
  }
  return { command: process.execPath, args: [path.join(__dirname, 'hook.js')] }
}

// Claude Code's global config (where a folder's trust is kept): $CLAUDE_CONFIG_DIR/.claude.json, else ~/.claude.json
const claudeConfigFile = (env = process.env) => (env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(os.homedir(), '.claude.json'))
const claudeHome = (env = process.env) => env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
const codexHome = (env = process.env) => env.CODEX_HOME || path.join(os.homedir(), '.codex')
// how Claude Code names a folder in its config: the resolved path in NFC, with forward slashes on Windows (C:/Users/…)
const claudeKey = (p, platform = process.platform) => { const n = path.resolve(p).normalize('NFC'); return platform === 'win32' ? n.replace(/\\/g, '/') : n }

// A folder the runner made for a job is trusted in Claude Code — what the person would do in the trust dialog, written the way Claude
// Code itself tells to (projects[<folder>].hasTrustDialogAccepted in its config), only for folders under the runner's own data folder.
// (atomic replace; if a running Claude Code overwrites it meanwhile, the dialog shows in the terminal and the person answers it there)
function trustClaudeFolder(dir, { root, env = process.env } = {}) {
  const real = fs.realpathSync(dir)
  if (root) { const r = fs.realpathSync(root); if (real !== r && !real.startsWith(r + path.sep)) throw new Error('not a runner folder') }
  const key = claudeKey(real)
  const file = claudeConfigFile(env)
  let conf = {}
  let mode = 0o600
  try { const st = fs.statSync(file); mode = st.mode & 0o777; conf = JSON.parse(fs.readFileSync(file, 'utf8')) || {} } catch (e) { if (e.code !== 'ENOENT') return false }
  if (conf.projects?.[key]?.hasTrustDialogAccepted === true) return true
  conf.projects = conf.projects || {}
  conf.projects[key] = { ...(conf.projects[key] || {}), hasTrustDialogAccepted: true }
  const tmp = `${file}.pgl-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, JSON.stringify(conf, null, 2), { mode })
  // (Windows: a rename over a file another process has open fails for a moment — tried again, then the dialog is the person's)
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, file); break } catch (e) {
      if (!WIN || i >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) { try { fs.rmSync(tmp, { force: true }) } catch { /* gone */ } throw e }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
    }
  }
  return true
}

// One growing JSON-lines file read from where it was left (agent-share transcript.py: byte offset, the unfinished last line kept)
class Tail {
  constructor(file) { this.file = file; this.offset = 0; this.partial = '' }
  read() {
    let size
    try { size = fs.statSync(this.file).size } catch { return [] }
    if (size < this.offset) { this.offset = 0; this.partial = '' }
    if (size === this.offset) return []
    const fd = fs.openSync(this.file, 'r')
    try {
      const buf = Buffer.alloc(size - this.offset)
      fs.readSync(fd, buf, 0, buf.length, this.offset)
      this.offset = size
      const lines = (this.partial + buf.toString('utf8')).split('\n')
      this.partial = lines.pop()
      return lines.filter((l) => l.trim()).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
    } finally { fs.closeSync(fd) }
  }
}

// Codex keeps each session in <CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<time>-<uuid>.jsonl; its session_meta has the id and folder
// (agent-share codex_usage.py: find by id, or the first new one in this folder)
function codexRollouts(env, since) {
  const out = []
  const start = new Date(since - 86400_000)
  for (let d = new Date(start); d <= new Date(Date.now() + 86400_000); d = new Date(d.getTime() + 86400_000)) {
    const dir = path.join(codexHome(env), 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'))
    try { for (const f of fs.readdirSync(dir)) if (/^rollout-.*\.jsonl$/.test(f)) out.push(path.join(dir, f)) } catch { /* no such day */ }
  }
  return out
}
function codexMeta(file) {
  try {
    const head = fs.readFileSync(file, 'utf8').split('\n').slice(0, 20)
    for (const l of head) { try { const e = JSON.parse(l); if (e?.type === 'session_meta') return { id: e.payload?.id || null, cwd: e.payload?.cwd || null } } catch { /* partial */ } }
  } catch { /* gone */ }
  return null
}

// a Codex session's rollout by its id, whatever day it began (a session resumed days later) → path or null
function codexRolloutOf(env, id) {
  const root = path.join(codexHome(env), 'sessions')
  const ls = (d) => { try { return fs.readdirSync(d).sort().reverse() } catch { return [] } }
  for (const y of ls(root)) for (const m of ls(path.join(root, y))) for (const d of ls(path.join(root, y, m))) {
    const f = ls(path.join(root, y, m, d)).find((x) => x.endsWith(`-${id}.jsonl`))
    if (f) return path.join(root, y, m, d, f)
  }
  return null
}
// the CLI's own record of a session (Claude Code's transcript · Codex's rollout), by the session's id → path or null
function cliRecordOf({ agent, cli, env = process.env }) {
  if (!cli) return null
  if (agent === 'codex') return codexRolloutOf(env, cli)
  const root = path.join(claudeHome(env), 'projects')
  try { for (const d of fs.readdirSync(root)) { const f = path.join(root, d, `${cli}.jsonl`); if (fs.existsSync(f)) return f } } catch { /* none yet */ }
  return null
}
const sizeOf = (f) => { try { return f ? fs.statSync(f).size : 0 } catch { return 0 } }
// Whether the CLI took a person's message into the session after the first `from` bytes of its own record — a user message there (not a
// tool's result, not its own notes; Codex: a user_message). Read from the CLI's record only, never from the screen.
function tookSince({ agent, cli, env = process.env, from = 0 }) {
  const f = cliRecordOf({ agent, cli, env })
  if (!f) return false
  const t = new Tail(f)
  t.offset = Math.max(0, Number(from) || 0)
  for (const e of t.read()) {
    if (agent === 'codex') { if (e?.type === 'event_msg' && e.payload?.type === 'user_message' && String(e.payload.message || '').trim()) return true; continue }
    if (e?.type !== 'user' || e.isMeta || e.isSidechain) continue
    const c = e.message?.content
    if (typeof c === 'string' ? c.trim() : Array.isArray(c) && !c.some((b) => b?.type === 'tool_result') && c.some((b) => b?.type === 'text' && String(b.text || '').trim())) return true
  }
  return false
}

class CliSession extends EventEmitter {
  // id: this session's own id (the runner's; relayed to the server) · agent: 'claude-code' | 'codex' · cwd: the repo or worktree it works in
  // resume: the CLI's session id to go on with · prompt: the first message (given once the CLI is ready, as a person would paste it)
  // stateDir: where its settings and hook file live (never inside cwd) · trustRoot: folders under it may be marked trusted
  // watch: paths under cwd whose changes are reported ('files') · env: extra environment (e.g. a model gateway) · cols/rows
  // version: the CLI's version (which hook events it knows) · annotate(item): the owner's word on a conversation item before it goes out
  constructor({ id = crypto.randomUUID(), agent, cwd, resume = null, prompt = '', stateDir, trustRoot = null, searchPath = C.augmentedPath(), env = {},
    watch = [], cols = 100, rows = 30, log = () => {}, pty = null, version = null, annotate = null } = {}) {
    super()
    Object.assign(this, { id, agent, cwd, resume, firstPrompt: prompt, stateDir, trustRoot, searchPath, extraEnv: env, watchPaths: watch, cols, rows, logFn: log, version })
    this.annotate = annotate || ((it) => it)
    this.prompt0 = String(prompt || '')
    this.asks = new Map()     // the questions it shows now (prompts.js), oldest first
    this.calls = new Map()    // tool calls without a result yet: call → {name, input}
    this.ptyMod = pty || P.load()
    this.buf = ''
    this.cli = resume || null
    this.ready = false
    this.queue = []        // what waits for the CLI to be ready
    this.lastInputAt = 0
    this.exited = false
    this.busy = false
    this.timers = []
  }

  log(m) { this.logFn(`[session ${this.id.slice(0, 8)}] ${m}`) }

  // ---------- start ----------
  start() {
    if (!this.ptyMod) throw new Error(`no terminal module: ${P.why()}`)
    fs.mkdirSync(this.stateDir, { recursive: true, mode: 0o700 })
    this.realCwd = fs.realpathSync(this.cwd)
    const env = C.cliEnv({ TERM: 'xterm-256color', COLORTERM: 'truecolor', ...NO_ACCOUNT_SWITCH, ...this.extraEnv }, this.searchPath)
    this.env = env
    // (a resumed Codex session: its rollout as it is now — what it holds is history; what Codex writes after is this session's)
    if (this.agent === 'codex' && this.resume) {
      const f = codexRolloutOf(env, this.resume)
      if (f) { try { this.rolloutFrom = { file: f, size: fs.statSync(f).size } } catch { /* gone */ } }
    }
    const spec = this.agent === 'codex' ? this.codexArgs() : this.claudeArgs()
    const bin = C.which(spec.bin, this.searchPath)
    if (!bin) throw new Error(`${spec.bin} not found`)
    this.startedAt = Date.now()
    this.log(`${bin} ${spec.args.map((a) => (a.length > 80 ? `${a.slice(0, 77)}…` : a)).join(' ')}`)
    // (Windows: claude.cmd · codex.cmd through cmd.exe, the command line given to ConPTY as it is — clis.startSpec)
    const s = C.startSpec(bin, spec.args)
    this.p = this.ptyMod.spawn(s.file, s.verbatim ? s.args.join(' ') : s.args, { name: 'xterm-256color', cols: this.cols, rows: this.rows, cwd: this.cwd, env })
    this.p.onData((d) => {
      this.buf = (this.buf + d).slice(-SCROLLBACK)
      this.emit('data', d)
    })
    this.p.onExit(({ exitCode }) => {
      this.exited = true; this.stopTimers(); this.poll(); this.emit('exit', { code: exitCode })
      // (Windows: a pseudo console whose program ended keeps its pipes and output thread until it is killed — released here)
      if (WIN) setTimeout(() => this.release(), 200)
    })
    this.timers.push(setInterval(() => this.poll(), POLL_MS))
    if (this.watchPaths.length) this.startWatch()
    // (Codex took its first message from the command line: it can take more once its rollout shows that message — or at once, without one)
    if (this.agent === 'codex' && !this.codexFirst) this.becomeReady()
    return this
  }

  claudeArgs() {
    this.cli = this.resume || crypto.randomUUID()
    // the hooks write what they get to a file of this session; nothing in them talks to a network
    this.hookFile = path.join(this.stateDir, 'hooks.jsonl')
    fs.writeFileSync(this.hookFile, '')
    // exec form (command + args): spawned directly by Claude Code, no shell — the same on macOS and Windows (hook.js)
    const prog = hookProgram()
    const cmd = (name) => ({ hooks: [{ type: 'command', command: prog.command, args: [...prog.args, name, this.hookFile] }] })
    const events = [...HOOKS, ...(newer(this.version, PERMISSION_HOOK_FROM) ? ['PermissionRequest'] : [])]
    const settings = { hooks: Object.fromEntries(events.map((h) => [h, [cmd(h)]])) }
    this.settingsFile = path.join(this.stateDir, 'settings.json')
    fs.writeFileSync(this.settingsFile, JSON.stringify(settings, null, 2), { mode: 0o600 })
    if (this.trustRoot) { try { trustClaudeFolder(this.cwd, { root: this.trustRoot, env: this.env }) } catch (e) { this.log(`trust: ${e.message}`) } }
    this.emit('session', this.cli)
    // the person's own settings, sign-in and commands stay (no --setting-sources); edits inside the work folder go without asking
    return { bin: C.CLIS['claude-code'].bin, args: [...(this.resume ? ['--resume', this.cli] : ['--session-id', this.cli]), '--settings', this.settingsFile, '--permission-mode', 'acceptEdits'] }
  }

  codexArgs() {
    // trusted for this session only (on the command line — the person's config.toml is not written), no update dialog in a run
    const trust = `projects.${JSON.stringify(this.realCwd)}.trust_level="trusted"`
    const args = [...(this.resume ? ['resume', this.resume] : []), '-c', trust, '-c', 'check_for_update_on_startup=false', '-C', this.realCwd]
    // the first message: a short pointer to the prompt file (the prompt itself stays out of the process list); Codex submits it itself
    // once its composer is up — whatever dialog the person's setup shows first
    if (this.firstPrompt) {
      const f = path.join(this.cwd, '.pgl-run', 'prompt.md')
      fs.mkdirSync(path.dirname(f), { recursive: true })
      fs.writeFileSync(f, this.firstPrompt)
      args.push(PROMPT_POINTER)
      this.firstPrompt = ''
      this.codexFirst = true
    }
    // (a resumed session is the one it names: said now, as Claude Code's is — its rollout's session_meta is history)
    if (this.resume) this.emit('session', this.resume)
    return { bin: C.CLIS.codex.bin, args }
  }

  becomeReady() {
    if (this.ready) return
    this.ready = true
    // (the first message goes first; what was given meanwhile — a steer — follows it)
    if (this.firstPrompt) { const p = this.firstPrompt; this.firstPrompt = ''; this.queue.unshift(p) }
    this.emit('ready')
    this.drain()
  }

  // ---------- input ----------
  // what a person types (the CLI's owner — the server drops everyone else's): straight into the PTY
  write(data) {
    if (this.exited || !this.p) return false
    this.lastInputAt = Date.now()
    this.p.write(String(data))
    return true
  }
  // a whole message, as a person pastes it and presses Enter (bracketed paste, then Enter on its own so the CLI submits it)
  submit(text) {
    const t = String(text || '')
    if (!t.trim() || this.exited) return false
    this.queue.push(t)
    this.drain()
    return true
  }
  drain() {
    if (!this.ready || this.draining || !this.queue.length || this.exited) return
    this.draining = true
    const t = this.queue.shift()
    this.lastInputAt = Date.now()
    this.p.write(`\x1b[200~${t.replace(/\x1b\[20[01]~/g, '')}\x1b[201~`)
    const timer = setTimeout(() => {
      if (!this.exited) { this.p.write('\r'); if (this.agent === 'claude-code' && !this.busy) this.unsent = { at: Date.now(), tries: 0 } }
      this.draining = false; this.drain()
    }, PASTE_ENTER_MS)
    this.timers.push(timer)
  }
  // The owner's answer to what the CLI asks (prompts.js): the keys a person would press, only while that ask is still open (a key sent
  // after the dialog went away would land in the CLI's input as text) → true, or why not
  answer(askId, answer, by = '') {
    const ask = this.asks.get(String(askId || ''))
    if (!ask || this.exited) return 'closed'
    const keys = ASK.keysFor(ask, answer)
    if (!keys.length) return 'invalid'
    this.asks.delete(ask.id)
    this.lastInputAt = Date.now()
    keys.forEach((k, i) => { const t = setTimeout(() => { if (!this.exited) this.p.write(k) }, i * KEY_GAP_MS); this.timers.push(t) })
    this.emitTx([{ id: `${ask.id}:done`, t: 'ask-done', at: new Date().toISOString(), ask: ask.id, answer: ASK.answerText(ask, answer), by: String(by || '').slice(0, 60) || undefined }])
    return true
  }
  // the asks still open (a viewer that comes later sees them in the conversation)
  openAsks() { return [...this.asks.values()] }
  resize(cols, rows) {
    const c = Math.max(20, Math.min(400, cols | 0)), r = Math.max(5, Math.min(200, rows | 0))
    if (this.exited || !this.p || (c === this.cols && r === this.rows)) return
    this.cols = c; this.rows = r
    try { this.p.resize(c, r) } catch { /* gone */ }
  }
  kill() {
    if (this.exited || !this.p) return
    // Windows: the CLI and what it started (cmd.exe → claude → its tools) as one tree, then the pseudo console itself
    if (WIN) {
      require('node:child_process').execFile('taskkill', ['/PID', String(this.p.pid), '/T', '/F'], { windowsHide: true }, () => this.release())
      return
    }
    try { this.p.kill() } catch { /* gone */ }
  }
  // Windows: the pseudo console, its pipes and its output thread closed (once — after the program ended or was stopped; pty.dispose)
  release() {
    if (!WIN || this.released || !this.p) return
    this.released = true
    P.dispose(this.p)
  }
  stopTimers() { for (const t of this.timers) { clearInterval(t); clearTimeout(t) } this.timers = []; this.watcher?.close(); this.watcher = null }

  // ---------- what the CLI produced ----------
  poll() {
    if (this.agent === 'claude-code') this.pollClaude()
    else this.pollCodex()
  }

  pollClaude() {
    for (const h of this.readHooks()) this.onHook(h)
    if (!this.tx && this.cli) {
      // its transcript: <config>/projects/<folder>/<session>.jsonl (the folder name is Claude Code's own; found by the session id)
      const f = this.transcriptPath || this.findTranscript()
      if (f && fs.existsSync(f)) this.tx = new Tail(f)
    }
    if (this.tx) for (const e of this.tx.read()) this.onClaudeEntry(e)
    this.resubmit()
  }
  // the pasted message still in Claude Code's input box after its Enter (SUBMIT_CHECK_MS): Enter again
  resubmit() {
    const u = this.unsent
    if (!u || this.exited || this.busy || this.asks.size || Date.now() - u.at < SUBMIT_CHECK_MS) return
    if (u.tries >= SUBMIT_TRIES || !PASTE_HELD.test(inputLine(plainText(this.buf.slice(-6000))) || '')) { this.unsent = null; return }
    u.tries++
    u.at = Date.now()
    this.log(`the message is still in the input box — Enter again (${u.tries})`)
    this.p.write('\r')
  }
  readHooks() {
    // a line: "<Event> <json>" (the hook command's printf, then its stdin)
    const out = []
    let raw = ''
    try { const size = fs.statSync(this.hookFile).size; if (size <= (this.hookOff || 0)) return out; const fd = fs.openSync(this.hookFile, 'r'); const b = Buffer.alloc(size - (this.hookOff || 0)); fs.readSync(fd, b, 0, b.length, this.hookOff || 0); fs.closeSync(fd); this.hookOff = size; raw = (this.hookPartial || '') + b.toString('utf8') } catch { return out }
    const lines = raw.split('\n')
    this.hookPartial = lines.pop()
    for (const l of lines) {
      const m = /^(\w+) (.*)$/.exec(l.trim())
      if (!m) continue
      let data = {}
      try { data = JSON.parse(m[2]) } catch { /* empty input */ }
      out.push({ event: m[1], data })
    }
    return out
  }
  findTranscript() {
    const root = path.join(claudeHome(this.env), 'projects')
    try { for (const d of fs.readdirSync(root)) { const f = path.join(root, d, `${this.cli}.jsonl`); if (fs.existsSync(f)) return f } } catch { /* none yet */ }
    return null
  }
  onHook({ event, data }) {
    // (what reaches the server: the event and a few plain fields — no local paths, no tool inputs)
    const brief = { session_id: data.session_id || null, message: data.message ? short(data.message, 400) : undefined, notification_type: data.notification_type,
      source: data.source, error: data.error ? short(data.error, 400) : undefined, last_assistant_message: data.last_assistant_message ? String(data.last_assistant_message).slice(0, 4000) : undefined }
    this.emit('hook', { event, data: JSON.parse(JSON.stringify(brief)) })
    if (data.transcript_path && !this.transcriptPath) this.transcriptPath = data.transcript_path
    if (event === 'SessionStart') this.becomeReady()
    else if (event === 'UserPromptSubmit') { this.unsent = null; this.busy = true; this.closeAsks(); this.turnItem('start'); this.emit('turn-start', { prompt: String(data.prompt || '') }) }
    else if (event === 'Stop') {
      this.unsent = null
      this.pollTranscriptNow()
      this.busy = false
      this.closeAsks()
      this.turnItem('end')
      this.emit('turn-end', { summary: data.last_assistant_message || this.lastText || '' })
    } else if (event === 'StopFailure') { this.busy = false; this.closeAsks(); this.turnItem('failed', short(data.error || data.message || '', 300)); this.emit('turn-failed', { error: short(data.error || data.message || 'stopped on an error', 400) }) }
    else if (event === 'PermissionRequest') { this.pollTranscriptNow(); this.openAsk(ASK.fromPermissionRequest(data, { rel: (s) => this.rel(s) })) }
    else if (event === 'Notification') {
      // (an older Claude Code: its permission prompt is known only from this — the call that waits is the last one without a result)
      if (data.notification_type === 'permission_prompt' && !this.asks.size) { this.pollTranscriptNow(); this.openAsk(ASK.fromNotification(data, [...this.calls.values()].pop() || null, { rel: (s) => this.rel(s) })) }
      this.emit('attention', { message: short(data.message, 300), type: data.notification_type || null })
    }
  }
  // ---------- the conversation (transcript.js) and what it asks (prompts.js) ----------
  rel(s) {
    let t = String(s ?? '')
    // (the longer spelling first: /private/var/… before /var/… on macOS)
    const whole = t
    const dirs = [this.cwd, this.realCwd].filter(Boolean).sort((a, b) => b.length - a.length)
    for (const d of dirs) { t = t.split(`${d}${path.sep}`).join(''); if (path.sep === '\\') t = t.split(`${d.replace(/\\/g, '/')}/`).join('') }
    // Windows: a file of the work folder reads as it does on the other systems (산출물/…, not 산출물\…) — only when the whole
    // value was that file's path; text that merely mentions one (a command) is left as written
    if (path.sep === '\\' && dirs.some((d) => whole.startsWith(`${d}\\`) || whole.startsWith(`${d.replace(/\\/g, '/')}/`))) t = t.replace(/\\/g, '/')
    return t
  }
  emitTx(items) {
    const out = items.map((it) => this.annotate(it) || it).filter(Boolean)
    if (out.length) this.emit('tx', out)
  }
  turnItem(state, error = '') { this.emitTx([{ id: `turn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, t: 'turn', at: new Date().toISOString(), state, ...(error ? { error } : {}) }]) }
  openAsk(ask) {
    if (!ask) return
    this.asks.set(ask.id, ask)
    this.emitTx([{ id: ask.id, t: 'ask', at: new Date().toISOString(), ask }])
  }
  // asks the CLI no longer shows: answered in the terminal, the tool went on (its result), the turn ended or stopped
  closeAsks(tool = null) {
    for (const a of [...this.asks.values()]) {
      if (tool && a.tool !== tool) continue
      this.asks.delete(a.id)
      this.emitTx([{ id: `${a.id}:done`, t: 'ask-done', at: new Date().toISOString(), ask: a.id }])
      if (tool) break
    }
  }
  // what the CLI's records said, as conversation items: its tool calls are followed (a result closes the ask about it), a stopped turn
  // is the end of that turn
  records(items) {
    for (const it of items) {
      if (it.t === 'tool') this.calls.set(it.call, { name: it.name, input: it.input })
      else if (it.t === 'result') { const c = this.calls.get(it.call); this.calls.delete(it.call); if (c) this.closeAsks(c.name) }
    }
    // (the step's own first message — the prompt the runner pasted, or Codex's pointer to its prompt file)
    if (this.prompt0 && !this.sawFirst) for (const it of items) if (it.t === 'user' && (sameStart(it.text, this.prompt0) || sameStart(it.text, PROMPT_POINTER))) { it.first = true; this.sawFirst = true; break }
    this.emitTx(items)
    if (items.some((it) => it.t === 'note' && it.kind === 'interrupted') && this.busy) {
      this.busy = false
      this.calls.clear()
      this.closeAsks()
      this.turnItem('interrupted')
      this.emit('turn-interrupted', {})
    }
  }
  pollTranscriptNow() { if (this.tx) for (const e of this.tx.read()) this.onClaudeEntry(e) }
  onClaudeEntry(e) {
    if (!e || e.isSidechain) return
    this.records(TX.fromClaude(e, { rel: (s) => this.rel(s) }))
    const content = e.message?.content
    if (e.type === 'user' && !e.isMeta) {
      let text = null
      if (typeof content === 'string') text = content
      else if (Array.isArray(content) && !content.some((b) => b?.type === 'tool_result')) text = content.filter((b) => b?.type === 'text').map((b) => b.text || '').join('\n')
      if (text && text.trim()) this.emit('prompt', { text })
    } else if (e.type === 'attachment' && e.attachment?.type === 'queued_command') {
      const p = e.attachment.prompt
      const text = typeof p === 'string' ? p : Array.isArray(p) ? p.map((b) => b?.text || '').join('\n') : ''
      if (text.trim()) this.emit('prompt', { text })
    } else if (e.type === 'assistant' && Array.isArray(content)) {
      for (const b of content) {
        if (b?.type === 'text' && b.text?.trim()) { this.lastText = b.text; this.emit('text', { text: b.text }) }
        else if (b?.type === 'tool_use') this.emit('tool', { name: b.name, brief: briefOf(b.input, (x) => this.rel(x)) })
      }
    }
  }

  pollCodex() {
    if (!this.tx) {
      // its rollout: by the session id when resuming, else the first new one in this folder
      const files = this.rolloutFrom ? [this.rolloutFrom.file] : codexRollouts(this.env, this.startedAt)
      let hit = null
      for (const f of files) {
        if (this.cli && f.endsWith(`-${this.cli}.jsonl`)) { hit = f; break }
        if (this.cli) continue
        let born = 0
        try { const st = fs.statSync(f); born = st.birthtimeMs || st.ctimeMs } catch { continue }
        if (born < this.startedAt - 5000) continue
        const meta = codexMeta(f)
        if (meta?.cwd && samePath(meta.cwd, this.realCwd)) { hit = f; break }
      }
      if (!hit) return
      this.tx = new Tail(hit)
      // (a resumed rollout: what it held when the session started is history, not this session's turns — read from there, so a message
      // Codex took before this first look is not skipped; a rollout not found at the start: what it holds at this first look)
      if (this.resume) { if (this.rolloutFrom?.file === hit) this.tx.offset = this.rolloutFrom.size; else this.tx.read() }
    }
    for (const e of this.tx.read()) this.onCodexEntry(e)
  }
  onCodexEntry(e) {
    const p = e?.payload
    if (!p) return
    if (e.type === 'session_meta' && p.id && !this.cli) { this.cli = p.id; this.emit('session', p.id); return }
    if (e.type === 'event_msg' && p.type === 'user_message' && p.message && !this.busy) this.turnItem('start')
    this.records(TX.fromCodex(e, { rel: (s) => this.rel(s) }))
    if (e.type === 'event_msg') {
      if (p.type === 'user_message' && p.message) { this.busy = true; this.becomeReady(); this.emit('turn-start', { prompt: p.message }); this.emit('prompt', { text: p.message }) }
      else if (p.type === 'agent_message' && p.message) { this.lastText = p.message; this.emit('text', { text: p.message }) }
      else if (p.type === 'task_complete') { this.busy = false; this.turnItem('end'); this.emit('turn-end', { summary: p.last_agent_message || this.lastText || '' }) }
      else if (p.type === 'error' || p.type === 'stream_error') this.emit('attention', { message: short(p.message, 300), type: 'error' })
      return
    }
    if (e.type === 'response_item' && ['function_call', 'custom_tool_call', 'local_shell_call'].includes(p.type)) {
      let brief = ''
      try { const a = typeof p.arguments === 'string' ? JSON.parse(p.arguments) : p.arguments || p.input || {}; brief = briefOf({ ...a, command: Array.isArray(a.command) ? a.command.join(' ') : a.command }, (x) => this.rel(x)) } catch { brief = short(p.arguments || p.input, 120) }
      this.emit('tool', { name: p.name || (p.type === 'local_shell_call' ? 'shell' : 'tool'), brief })
    }
  }

  // ---------- watched paths ----------
  startWatch() {
    const pending = new Map()
    let timer = null
    const flush = () => {
      timer = null
      const files = []
      for (const rel of pending.keys()) {
        const abs = path.join(this.cwd, rel)
        let st = null
        try { st = fs.statSync(abs) } catch { /* deleted */ }
        if (!st) files.push({ path: rel, deleted: true })
        else if (st.isFile()) files.push({ path: rel, size: st.size, mtime: st.mtimeMs, content: st.size <= WATCH_MAX ? fs.readFileSync(abs, 'utf8') : null })
      }
      pending.clear()
      if (files.length) this.emit('files', files)
    }
    try {
      this.watcher = fs.watch(this.cwd, { recursive: true }, (_ev, name) => {
        if (!name) return
        const rel = String(name).split(path.sep).join('/')
        if (!this.watchPaths.some((w) => rel === w || rel.startsWith(`${w.replace(/\/+$/, '')}/`))) return
        pending.set(rel, true)
        if (!timer) { timer = setTimeout(flush, 300); this.timers.push(timer) }
      })
    } catch (e) { this.log(`watch: ${e.message}`) }
  }
}

// the step's first message as the CLI recorded it (its first words — a paste may come back with its line breaks changed)
const sameStart = (a, b) => { const n = (x) => String(x || '').replace(/\s+/g, ' ').trim().slice(0, 60); return !!n(b) && n(a).startsWith(n(b)) }
const PROMPT_POINTER = 'Read .pgl-run/prompt.md in this folder and do the work it describes. / 이 폴더의 .pgl-run/prompt.md 를 읽고 거기 적힌 일을 하세요.'
const safeReal = (p) => { try { return fs.realpathSync(p) } catch { return p } }
// one folder however it is spelled (Windows: \\?\ prefix, either slash, any case)
function samePath(a, b) {
  const n = (p) => { const r = safeReal(String(p || '').replace(/^\\\\\?\\/, '')); return WIN ? path.resolve(r).replace(/\//g, '\\').toLowerCase() : r }
  return n(a) === n(b)
}
// (the folder's own path first, then clipped: a work folder's absolute path is long — 산출물/… must survive the clip)
function briefOf(input = {}, rel = (s) => s) {
  const i = input || {}
  return short(rel(String(i.file_path || i.path || i.command || i.pattern || i.description || i.url || '')), 120)
}

module.exports = { CliSession, Tail, inputLine, trustClaudeFolder, claudeConfigFile, claudeKey, codexRollouts, codexMeta, codexRolloutOf, cliRecordOf, sizeOf, tookSince, samePath, hookProgram, PROMPT_POINTER }
