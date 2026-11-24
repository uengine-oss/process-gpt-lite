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
//   'files' [{path, content, deleted}]   the watched paths changed (watch option — e.g. a repo's aidlc/ folder)
//   'exit' {code}
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const C = require('./clis')
const P = require('./pty')

const SCROLLBACK = 400 * 1024
const POLL_MS = 250
const PASTE_ENTER_MS = 350
const WATCH_MAX = 256 * 1024
// agent-share's _NO_ACCOUNT_SWITCH: the screen is shared, so no one switches the CLI's account from it
const NO_ACCOUNT_SWITCH = { DISABLE_LOGOUT_COMMAND: '1', DISABLE_LOGIN_COMMAND: '1' }
const HOOKS = ['SessionStart', 'UserPromptSubmit', 'Stop', 'StopFailure', 'Notification']
const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
const short = (v, n = 160) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n)

// Claude Code's global config (where a folder's trust is kept): $CLAUDE_CONFIG_DIR/.claude.json, else ~/.claude.json
const claudeConfigFile = (env = process.env) => (env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(os.homedir(), '.claude.json'))
const claudeHome = (env = process.env) => env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
const codexHome = (env = process.env) => env.CODEX_HOME || path.join(os.homedir(), '.codex')

// A folder the runner made for a job is trusted in Claude Code — what the person would do in the trust dialog, written the way Claude
// Code itself tells to (projects[<folder>].hasTrustDialogAccepted in its config), only for folders under the runner's own data folder.
// (atomic replace; if a running Claude Code overwrites it meanwhile, the dialog shows in the terminal and the person answers it there)
function trustClaudeFolder(dir, { root, env = process.env } = {}) {
  const real = fs.realpathSync(dir)
  if (root) { const r = fs.realpathSync(root); if (real !== r && !real.startsWith(r + path.sep)) throw new Error('not a runner folder') }
  const file = claudeConfigFile(env)
  let conf = {}
  let mode = 0o600
  try { const st = fs.statSync(file); mode = st.mode & 0o777; conf = JSON.parse(fs.readFileSync(file, 'utf8')) || {} } catch (e) { if (e.code !== 'ENOENT') return false }
  if (conf.projects?.[real]?.hasTrustDialogAccepted === true) return true
  conf.projects = conf.projects || {}
  conf.projects[real] = { ...(conf.projects[real] || {}), hasTrustDialogAccepted: true }
  const tmp = `${file}.pgl-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, JSON.stringify(conf, null, 2), { mode })
  fs.renameSync(tmp, file)
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

class CliSession extends EventEmitter {
  // id: this session's own id (the runner's; relayed to the server) · agent: 'claude-code' | 'codex' · cwd: the repo or worktree it works in
  // resume: the CLI's session id to go on with · prompt: the first message (given once the CLI is ready, as a person would paste it)
  // stateDir: where its settings and hook file live (never inside cwd) · trustRoot: folders under it may be marked trusted
  // watch: paths under cwd whose changes are reported ('files') · env: extra environment (e.g. a model gateway) · cols/rows
  constructor({ id = crypto.randomUUID(), agent, cwd, resume = null, prompt = '', stateDir, trustRoot = null, searchPath = C.augmentedPath(), env = {},
    watch = [], cols = 100, rows = 30, log = () => {}, pty = null } = {}) {
    super()
    Object.assign(this, { id, agent, cwd, resume, firstPrompt: prompt, stateDir, trustRoot, searchPath, extraEnv: env, watchPaths: watch, cols, rows, logFn: log })
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
    const spec = this.agent === 'codex' ? this.codexArgs() : this.claudeArgs()
    const bin = C.which(spec.bin, this.searchPath)
    if (!bin) throw new Error(`${spec.bin} not found`)
    this.startedAt = Date.now()
    this.log(`${bin} ${spec.args.map((a) => (a.length > 80 ? `${a.slice(0, 77)}…` : a)).join(' ')}`)
    this.p = this.ptyMod.spawn(bin, spec.args, { name: 'xterm-256color', cols: this.cols, rows: this.rows, cwd: this.cwd, env })
    this.p.onData((d) => {
      this.buf = (this.buf + d).slice(-SCROLLBACK)
      this.emit('data', d)
    })
    this.p.onExit(({ exitCode }) => { this.exited = true; this.stopTimers(); this.poll(); this.emit('exit', { code: exitCode }) })
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
    const cmd = (name) => ({ hooks: [{ type: 'command', command: `printf '%s ' ${sq(name)} >> ${sq(this.hookFile)} && cat >> ${sq(this.hookFile)} && echo >> ${sq(this.hookFile)}` }] })
    const settings = { hooks: Object.fromEntries(HOOKS.map((h) => [h, [cmd(h)]])) }
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
    const timer = setTimeout(() => { if (!this.exited) this.p.write('\r'); this.draining = false; this.drain() }, PASTE_ENTER_MS)
    this.timers.push(timer)
  }
  resize(cols, rows) {
    const c = Math.max(20, Math.min(400, cols | 0)), r = Math.max(5, Math.min(200, rows | 0))
    if (this.exited || !this.p || (c === this.cols && r === this.rows)) return
    this.cols = c; this.rows = r
    try { this.p.resize(c, r) } catch { /* gone */ }
  }
  kill() {
    if (this.exited || !this.p) return
    try { this.p.kill() } catch { /* gone */ }
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
    else if (event === 'UserPromptSubmit') { this.busy = true; this.emit('turn-start', { prompt: String(data.prompt || '') }) }
    else if (event === 'Stop') {
      this.pollTranscriptNow()
      this.busy = false
      this.emit('turn-end', { summary: data.last_assistant_message || this.lastText || '' })
    } else if (event === 'StopFailure') { this.busy = false; this.emit('turn-failed', { error: short(data.error || data.message || 'stopped on an error', 400) }) }
    else if (event === 'Notification') this.emit('attention', { message: short(data.message, 300), type: data.notification_type || null })
  }
  pollTranscriptNow() { if (this.tx) for (const e of this.tx.read()) this.onClaudeEntry(e) }
  onClaudeEntry(e) {
    if (!e || e.isSidechain) return
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
        else if (b?.type === 'tool_use') this.emit('tool', { name: b.name, brief: briefOf(b.input) })
      }
    }
  }

  pollCodex() {
    if (!this.tx) {
      // its rollout: by the session id when resuming, else the first new one in this folder
      const files = codexRollouts(this.env, this.startedAt)
      let hit = null
      for (const f of files) {
        if (this.cli && f.endsWith(`-${this.cli}.jsonl`)) { hit = f; break }
        if (this.cli) continue
        let born = 0
        try { const st = fs.statSync(f); born = st.birthtimeMs || st.ctimeMs } catch { continue }
        if (born < this.startedAt - 5000) continue
        const meta = codexMeta(f)
        if (meta?.cwd && safeReal(meta.cwd) === this.realCwd) { hit = f; break }
      }
      if (!hit) return
      this.tx = new Tail(hit)
      // (a resumed rollout: what it already holds is history, not this session's turns)
      if (this.resume) { this.tx.read() }
    }
    for (const e of this.tx.read()) this.onCodexEntry(e)
  }
  onCodexEntry(e) {
    const p = e?.payload
    if (!p) return
    if (e.type === 'session_meta' && p.id && !this.cli) { this.cli = p.id; this.emit('session', p.id); return }
    if (e.type === 'event_msg') {
      if (p.type === 'user_message' && p.message) { this.busy = true; this.becomeReady(); this.emit('turn-start', { prompt: p.message }); this.emit('prompt', { text: p.message }) }
      else if (p.type === 'agent_message' && p.message) { this.lastText = p.message; this.emit('text', { text: p.message }) }
      else if (p.type === 'task_complete') { this.busy = false; this.emit('turn-end', { summary: p.last_agent_message || this.lastText || '' }) }
      else if (p.type === 'error' || p.type === 'stream_error') this.emit('attention', { message: short(p.message, 300), type: 'error' })
      return
    }
    if (e.type === 'response_item' && ['function_call', 'custom_tool_call', 'local_shell_call'].includes(p.type)) {
      let brief = ''
      try { const a = typeof p.arguments === 'string' ? JSON.parse(p.arguments) : p.arguments || p.input || {}; brief = briefOf({ command: Array.isArray(a.command) ? a.command.join(' ') : a.command, ...a }) } catch { brief = short(p.arguments || p.input, 120) }
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

const PROMPT_POINTER = 'Read .pgl-run/prompt.md in this folder and do the work it describes. / 이 폴더의 .pgl-run/prompt.md 를 읽고 거기 적힌 일을 하세요.'
const safeReal = (p) => { try { return fs.realpathSync(p) } catch { return p } }
function briefOf(input = {}) {
  const i = input || {}
  return short(i.file_path || i.path || i.command || i.pattern || i.description || i.url || '', 120)
}

module.exports = { CliSession, Tail, trustClaudeFolder, claudeConfigFile, codexRollouts, codexMeta, PROMPT_POINTER }
