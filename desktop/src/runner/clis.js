'use strict'
// The CLI agents this desktop can run for its person's process steps (design docs/local-agents/design.md): which are installed,
// their versions and whether they are signed in, the fixed command for each (never a command the server sends), and their output
// read into a few plain events. No Electron here: unit-tested with fake CLIs (desktop/test/runner.test.js).
//   Claude Code — `claude -p --input-format stream-json --output-format stream-json --replay-user-messages`: the prompt and every steer
//                 go in on stdin as user messages, so a person's steer reaches the running session without stopping it (measured
//                 2026-11-24 with Claude Code 2.1.330: a message sent during a tool call is taken after it, in the same turn).
//                 A steer after the process ended resumes the same session (`--resume <id>`), the way Ontological Studio's code apps
//                 and the workroom go on with a session.
//   Codex       — `codex exec --json`: no input while it runs, so a steer stops the run (SIGINT) and `codex exec resume <thread> -`
//                 goes on in the same session with it.
//   OpenHands   — only detected: its headless flags were not verified on a machine that has it, so it is not run (runnable false).
const { execFile } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const CLIS = {
  'claude-code': { bin: 'claude', label: 'Claude Code' },
  codex: { bin: 'codex', label: 'Codex' },
  openhands: { bin: 'openhands', label: 'OpenHands' },
}
// what Claude Code may use without asking (no one can answer a permission prompt in -p): the files of its folder and a few reading
// commands. acceptEdits lets it write inside the folder; git stays the runner's own (it commits and pushes); nothing that reaches the
// network or runs a script — a step's prompt carries mail text, which is not the person's own words.
// (Skill: the company's skills put in .claude/skills for the run — runner/skills.js)
const CLAUDE_TOOLS = 'Read,Write,Edit,MultiEdit,Glob,Grep,TodoWrite,Skill,Bash(ls:*),Bash(cat:*),Bash(head:*),Bash(wc:*),Bash(mkdir:*)'
const CLAUDE_DENY = 'Bash(git:*),Bash(curl:*),Bash(wget:*),Bash(rm -rf:*),WebFetch'

const WIN = process.platform === 'win32'

// An app opened from Finder gets PATH=/usr/bin:/bin:/usr/sbin:/sbin: the usual install places too (Ontological Studio's rule).
// Windows: npm's global shims (claude.cmd · codex.cmd), the native Claude Code installer (claude.exe in ~\.local\bin), scoop · pnpm · bun,
// and Git for Windows (the runner's git)
function augmentedPath(base = process.env.PATH || '') {
  const home = os.homedir()
  const env = (k) => process.env[k] || ''
  const extra = WIN
    ? [env('APPDATA') && path.join(env('APPDATA'), 'npm'), path.join(home, '.local', 'bin'), path.join(home, 'scoop', 'shims'),
        env('LOCALAPPDATA') && path.join(env('LOCALAPPDATA'), 'pnpm'), path.join(home, '.bun', 'bin'),
        env('ProgramFiles') && path.join(env('ProgramFiles'), 'Git', 'cmd'), env('LOCALAPPDATA') && path.join(env('LOCALAPPDATA'), 'Programs', 'Git', 'cmd')]
    : ['/opt/homebrew/bin', '/usr/local/bin', path.join(home, '.local', 'bin'), path.join(home, '.bun', 'bin'), path.join(home, '.volta', 'bin'),
        path.join(home, '.npm-global', 'bin'), path.join(home, '.claude', 'local')]
  const dirs = base.split(path.delimiter).filter(Boolean)
  const seen = (d) => dirs.some((x) => (WIN ? x.toLowerCase() === d.toLowerCase() : x === d))
  for (const d of extra) if (d && !seen(d)) dirs.push(d)
  return dirs.join(path.delimiter)
}

// Windows: the PATHEXT order (claude.exe before claude.cmd in one folder); never the extensionless sh script npm also writes there
function which(name, searchPath = augmentedPath()) {
  const exts = WIN ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter((e) => /^\.(com|exe|bat|cmd)$/i.test(e)) : ['']
  for (const dir of searchPath.split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const p = path.join(dir, name + ext.toLowerCase())
      try { fs.accessSync(p, fs.constants.X_OK); if (fs.statSync(p).isFile()) return p } catch { /* not here */ }
    }
  }
  return null
}

// ---------- starting a CLI on Windows ----------
// npm's claude.cmd · codex.cmd are batch files: Node refuses to start them without a shell (CVE-2024-27980) and ConPTY runs only
// programs, so they go through cmd.exe — `cmd.exe /d /s /c "<command>"`, the whole command quoted once and every argument escaped the
// way cross-spawn does it: quoted for the program (MSVCRT rules), then each cmd.exe metacharacter behind a caret — twice, because the
// batch file's %* is parsed by cmd.exe once more (agent-share pty_session.py ConPtySession takes the same road). A .exe (the native
// claude.exe) starts directly.
const CMD_META = /([()\][%!^"`<>&|;, *?])/g
function quoteArg(arg) {
  let out = '"'
  let bs = 0
  for (const ch of String(arg)) {
    if (ch === '\\') { bs++; continue }
    if (ch === '"') { out += `${'\\'.repeat(bs * 2 + 1)}"`; bs = 0; continue }
    out += '\\'.repeat(bs) + ch
    bs = 0
  }
  return `${out}${'\\'.repeat(bs * 2)}"`
}
const isBatch = (file) => /\.(cmd|bat)$/i.test(String(file || ''))
const comspec = () => process.env.ComSpec || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe')
// the command line cmd.exe runs for a batch file and its arguments (what goes inside /c "…")
function batchLine(file, args = []) {
  const cmd = String(file).replace(CMD_META, '^$1')
  return [cmd, ...args.map((a) => quoteArg(a).replace(CMD_META, '^$1').replace(CMD_META, '^$1'))].join(' ')
}
// → {file, args, verbatim}: how to start `file args` on this computer (child_process: windowsVerbatimArguments = verbatim;
// node-pty: args as one string when verbatim)
function startSpec(file, args = [], platform = process.platform) {
  if (platform !== 'win32' || !isBatch(file)) return { file, args, verbatim: false }
  return { file: comspec(), args: ['/d', '/s', '/c', `"${batchLine(file, args)}"`], verbatim: true }
}

// a process and everything it started: Windows has no signals to send down a tree (a CLI under cmd.exe would live on), so taskkill /T /F
function killTree(pid, signal = 'SIGTERM') {
  if (!pid) return
  if (WIN) {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {})
    return
  }
  try { process.kill(pid, signal) } catch { /* gone */ }
}

// the environment a CLI runs in: the person's own (their CLI's sign-in, their keys), without what would confuse it or leak —
// a parent Claude Code session's markers, git configuration given by environment (a folder token), Electron's own switch
function cliEnv(extra = {}, searchPath = augmentedPath()) {
  const env = {}
  for (const [k, v] of Object.entries(process.env)) {
    // (a parent Claude Code's markers make a child think it is a sub-session; its own config folder is the person's sign-in)
    if ((k.startsWith('CLAUDE') && k !== 'CLAUDE_CONFIG_DIR') || k.startsWith('GIT_CONFIG_') || k.toUpperCase() === 'ELECTRON_RUN_AS_NODE' || k.startsWith('PGL_')) continue
    if (/^path$/i.test(k)) continue
    env[k] = v
  }
  return { ...env, PATH: searchPath, ...extra }
}

const run = (file, args, { timeout = 8000, env } = {}) => new Promise((resolve) => {
  const s = startSpec(file, args)
  execFile(s.file, s.args, { timeout, env: env || cliEnv(), maxBuffer: 1024 * 1024, windowsVerbatimArguments: s.verbatim, windowsHide: true },
    (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') }))
})
const versionOf = (text) => (/(\d+\.\d+\.\d+(?:[-.][\w.]+)?)/.exec(text || '') || [])[1] || null

// → { 'claude-code': {installed, version, loggedIn, runnable, path}, … } (loggedIn null: could not tell; no account name is kept)
async function detect({ searchPath = augmentedPath() } = {}) {
  const out = {}
  for (const [id, c] of Object.entries(CLIS)) {
    const p = which(c.bin, searchPath)
    if (!p) { out[id] = { installed: false, version: null, loggedIn: null, runnable: false }; continue }
    const env = cliEnv({}, searchPath)
    const v = await run(p, ['--version'], { env })
    let loggedIn = null
    if (id === 'claude-code') {
      const s = await run(p, ['auth', 'status'], { env })
      try { loggedIn = !!JSON.parse(s.stdout).loggedIn } catch { loggedIn = s.code === 0 ? null : false }
    } else if (id === 'codex') {
      const s = await run(p, ['login', 'status'], { env })
      loggedIn = s.code === 0 ? /logged in/i.test(`${s.stdout}\n${s.stderr}`) : false
    }
    out[id] = { installed: true, version: versionOf(`${v.stdout} ${v.stderr}`), loggedIn, runnable: id !== 'openhands', path: p }
  }
  return out
}

// ---------- the commands (fixed; the server only says which agent) ----------
// phase start | resume; session: Claude Code's id (ours, a UUID) or Codex's thread id (from its first event)
function command(agent, { phase = 'start', session = '', cwd = '' } = {}) {
  if (agent === 'claude-code') {
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--replay-user-messages',
      ...(phase === 'resume' ? ['--resume', session] : ['--session-id', session]),
      '--permission-mode', 'acceptEdits', '--allowed-tools', CLAUDE_TOOLS, '--disallowed-tools', CLAUDE_DENY,
      // the person's own hooks · MCP servers · settings stay out of a step run (as Ontological Studio's code apps)
      '--setting-sources', 'project', '--strict-mcp-config']
    return { bin: CLIS[agent].bin, args, input: 'stream' }
  }
  if (agent === 'codex') {
    // the prompt on stdin ('-'): it is not shown in the process list
    const args = phase === 'resume'
      ? ['exec', 'resume', '--json', '--skip-git-repo-check', '-c', 'sandbox_mode="workspace-write"', '-c', 'approval_policy="never"', session, '-']
      : ['exec', '--json', '--skip-git-repo-check', '-s', 'workspace-write', '-c', 'approval_policy="never"', '-C', cwd, '-']
    return { bin: CLIS[agent].bin, args, input: 'text' }
  }
  return null
}

// a user message for Claude Code's stdin
const userLine = (text) => `${JSON.stringify({ type: 'user', message: { role: 'user', content: String(text) } })}\n`

// ---------- reading their output ----------
// one line of a CLI's JSON output → events: {type: session, id} · {type: text, text} · {type: tool, name, brief} · {type: ack, text}
// (Claude Code took a message we sent) · {type: result, text, error} (a turn ended) · {type: failed, text}
const short = (v, n = 160) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n)
function briefOf(name, input = {}) {
  const i = input || {}
  return short(i.file_path || i.path || i.command || i.pattern || i.description || i.url || '', 120)
}
function parse(agent, line) {
  let e
  try { e = JSON.parse(line) } catch { return [] }
  if (!e || typeof e !== 'object') return []
  if (agent === 'claude-code') {
    if (e.type === 'system' && e.subtype === 'init' && e.session_id) return [{ type: 'session', id: e.session_id }]
    if (e.type === 'user' && e.isReplay) {
      const c = e.message?.content
      return [{ type: 'ack', text: typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => b.text || '').join('') : '' }]
    }
    if (e.type === 'assistant') {
      const out = []
      for (const b of e.message?.content || []) {
        if (b?.type === 'text' && b.text?.trim()) out.push({ type: 'text', text: b.text })
        else if (b?.type === 'tool_use') out.push({ type: 'tool', name: b.name, brief: briefOf(b.name, b.input) })
      }
      return out
    }
    if (e.type === 'result') return [{ type: 'result', text: String(e.result || ''), error: !!e.is_error || e.subtype !== 'success', session: e.session_id || null }]
    return []
  }
  if (agent === 'codex') {
    if (e.type === 'thread.started' && e.thread_id) return [{ type: 'session', id: e.thread_id }]
    if (e.type === 'item.completed' || e.type === 'item.started') {
      const it = e.item || {}
      if (it.type === 'agent_message' && e.type === 'item.completed') return [{ type: 'text', text: String(it.text || '') }]
      if (it.type === 'command_execution' && e.type === 'item.started') return [{ type: 'tool', name: 'shell', brief: short(it.command, 120) }]
      if (it.type === 'file_change' && e.type === 'item.completed') return [{ type: 'tool', name: 'edit', brief: short((it.changes || []).map((c) => c.path).join(', '), 120) }]
      return []
    }
    if (e.type === 'turn.completed') return [{ type: 'result', text: '', error: false }]
    if (e.type === 'turn.failed') return [{ type: 'result', text: short(e.error?.message, 400), error: true }]
    if (e.type === 'error') return [{ type: 'failed', text: short(e.message, 400) }]
    return []
  }
  return []
}

module.exports = { CLIS, CLAUDE_TOOLS, augmentedPath, which, cliEnv, detect, command, userLine, parse, versionOf, startSpec, batchLine, quoteArg, isBatch, killTree }
