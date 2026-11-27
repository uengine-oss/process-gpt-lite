#!/usr/bin/env node
'use strict'
// A stand-in for the interactive `claude` and `codex` in a PTY (desktop/test/terminal.test.js, server/test/localAgents.e2e.mjs, the
// Playwright local-agent tests): it reads its terminal in raw mode and echoes what is typed, takes a bracketed paste + Enter as a
// message, and records and signals what the real ones do — without a model:
//   Claude Code (2.1.330, measured 2026-11-24 on this Mac): `--session-id <id>` | `--resume <id>`, `--settings <file>` whose hooks it runs
//     (SessionStart when it can take input — after the folder-trust question, which it asks unless its config trusts the folder —,
//     UserPromptSubmit, Stop with last_assistant_message, StopFailure); its transcript in $CLAUDE_CONFIG_DIR/projects/<folder>/<id>.jsonl.
//     A hook with `args` is Claude Code's exec form (2.1.331: the program spawned directly, no shell); without, a shell command. Its
//     config names a folder by its resolved path in NFC, with forward slashes on Windows (C:/Users/…).
//     A message pasted while it works is taken into the running turn, after the directive at hand.
//   Codex (0.162.1): `[resume <id>] -c projects."<dir>".trust_level="trusted" … -C <dir> [prompt]` — the prompt on the command line is
//     submitted by itself; its rollout in $CODEX_HOME/sessions/Y/M/D/rollout-<time>-<id>.jsonl (session_meta, user_message, function
//     calls, agent_message, task_complete).
// The work is written in the message, one directive per line (as fake-cli.js): WRITE · WRITE_OUT · READ · SLEEP · SKILLNOTE · MEMORY ·
// FAIL. Each message it takes is logged to $FAKE_CLI_LOG ({kind, session, received}) and each chunk typed outside a paste ({typed}).
// For the 「대화」 view and what the CLI asks (measured with the real 2.1.331 — desktop/src/runner/prompts.js), Claude Code also:
//   THINK :: <text>                 a thinking block          SAY :: <markdown>  its words (\n for a new line)
//   EDIT <file> :: <old> => <new>    an Edit in the output folder, with its structured patch
//   BASH <command> :: <output>       a Bash call and its output
//   SKILL <name>                     the Skill tool
//   ASK <command>                    a Bash call that needs the person's permission: PermissionRequest hook, the dialog
//                                    (1. Yes · 2. Yes, and don't ask again · 3. … auto mode · 4. No · Esc to cancel); '1' / '2' run it,
//                                    Esc refuses it — the tool use is rejected and the turn stops without its Stop hook ({answered})
//   CHOOSE <q> :: <a> | <b> [;; <q2> :: <c> | <d>]   AskUserQuestion: the menu; a number picks the option of each question in turn
//                                    (several: then their review, Enter submits) and the answers go into 선택.md in the output folder
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { execSync, spawnSync } = require('node:child_process')

const kind = process.env.FAKE_CLI_KIND || (path.basename(process.argv[1]).includes('codex') ? 'codex' : 'claude')
const args = process.argv.slice(2)
const arg = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (o) => { if (process.env.FAKE_CLI_LOG) fs.appendFileSync(process.env.FAKE_CLI_LOG, `${JSON.stringify({ kind, tui: true, at: Date.now(), cwd: process.cwd(), ...o })}\n`) }
const screen = (s) => process.stdout.write(s.replace(/\n/g, '\r\n'))
const cwd = fs.realpathSync(process.cwd())
const inside = (rel) => { const p = path.resolve(cwd, rel); if (!p.startsWith(cwd + path.sep)) throw new Error(`outside the folder: ${rel}`); return p }
const now = () => new Date().toISOString()

let session = null
let outDir = null
let summary = []
let busy = false
const waiting = []

// ---------- the record each CLI keeps ----------
let record = () => {}
let fire = () => {}
let txFile = null
if (kind === 'claude') {
  const conf = process.env.CLAUDE_CONFIG_DIR || path.join(require('node:os').homedir(), '.claude')
  session = arg('--resume') || arg('--session-id') || crypto.randomUUID()
  txFile = path.join(conf, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${session}.jsonl`)
  fs.mkdirSync(path.dirname(txFile), { recursive: true })
  record = (e) => fs.appendFileSync(txFile, `${JSON.stringify({ ...e, sessionId: session, cwd, timestamp: now() })}\n`)
  let hooks = {}
  try { hooks = JSON.parse(fs.readFileSync(arg('--settings'), 'utf8')).hooks || {} } catch { /* no settings */ }
  fire = (name, extra = {}) => {
    const input = JSON.stringify({ session_id: session, transcript_path: txFile, cwd, hook_event_name: name, ...extra })
    for (const group of hooks[name] || []) for (const h of group.hooks || []) {
      if (h.type !== 'command') continue
      try {
        if (Array.isArray(h.args)) {
          const r = spawnSync(h.command, h.args, { input, stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true })
          if (r.error || r.status !== 0) throw new Error(r.error?.message || `exit ${r.status}: ${String(r.stderr || '').slice(0, 300)}`)
        } else execSync(h.command, { input, stdio: ['pipe', 'ignore', 'ignore'], ...(process.platform === 'win32' ? {} : { shell: '/bin/sh' }) })
      } catch (e) { log({ hookError: name, message: e.message }) }
    }
  }
} else {
  const home = process.env.CODEX_HOME || path.join(require('node:os').homedir(), '.codex')
  session = args[0] === 'resume' ? args[1] : crypto.randomUUID()
  const d = new Date()
  const day = path.join(home, 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'))
  const found = (() => { try { for (const y of fs.readdirSync(path.join(home, 'sessions'))) for (const m of fs.readdirSync(path.join(home, 'sessions', y))) for (const dd of fs.readdirSync(path.join(home, 'sessions', y, m))) for (const f of fs.readdirSync(path.join(home, 'sessions', y, m, dd))) if (f.endsWith(`-${session}.jsonl`)) return path.join(home, 'sessions', y, m, dd, f) } catch { /* none */ } return null })()
  txFile = found || path.join(day, `rollout-${d.toISOString().replace(/[:.]/g, '-')}-${session}.jsonl`)
  fs.mkdirSync(path.dirname(txFile), { recursive: true })
  let started = !!found
  record = (e) => {
    if (!started) { started = true; fs.appendFileSync(txFile, `${JSON.stringify({ timestamp: now(), type: 'session_meta', payload: { id: session, cwd, originator: 'fake' } })}\n`) }
    fs.appendFileSync(txFile, `${JSON.stringify({ timestamp: now(), ...e })}\n`)
  }
}
// (a resumed session finds where its step's output goes in what it was told before)
if (fs.existsSync(txFile)) { const m = /「([^」\n]+?)\/」/.exec(fs.readFileSync(txFile, 'utf8')); if (m) outDir = m[1] }

function tool(name, input, { fields = null, result = 'ok', use = null, isError = false } = {}) {
  screen(`\x1b[36m⏺\x1b[0m ${name}(${input})\n`)
  if (kind === 'claude') {
    const id = `toolu_${crypto.randomBytes(4).toString('hex')}`
    record({ type: 'assistant', uuid: crypto.randomUUID(), message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input: fields || { file_path: path.resolve(cwd, input) } }] } })
    record({ type: 'user', uuid: crypto.randomUUID(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: result, ...(isError ? { is_error: true } : {}) }] }, ...(use ? { toolUseResult: use } : {}) })
  } else {
    const call = `call_${crypto.randomBytes(4).toString('hex')}`
    record({ type: 'response_item', payload: { type: 'function_call', name, call_id: call, arguments: JSON.stringify({ command: `${name} ${input}` }) } })
    record({ type: 'response_item', payload: { type: 'function_call_output', call_id: call, output: JSON.stringify({ output: String(result), metadata: { exit_code: 0 } }) } })
  }
}
// a dialog of the CLI (a permission, a choice): the next keys are its own; → the key that closed it
let dialog = null
const ask = () => new Promise((resolve) => { dialog = resolve })
function say(text) {
  screen(`\x1b[37m⏺\x1b[0m ${text}\n`)
  if (kind === 'claude') record({ type: 'assistant', uuid: crypto.randomUUID(), message: { role: 'assistant', content: [{ type: 'text', text }] } })
  else record({ type: 'event_msg', payload: { type: 'agent_message', message: text } })
}
function think(text) {
  screen('\x1b[90m✻ Thinking…\x1b[0m\n')
  if (kind === 'claude') record({ type: 'assistant', uuid: crypto.randomUUID(), message: { role: 'assistant', content: [{ type: 'thinking', thinking: text, signature: 'x' }] } })
  else record({ type: 'event_msg', payload: { type: 'agent_reasoning', text } })
}
function took(text) {
  log({ session, received: text.slice(0, 600) })
  if (kind === 'claude') record({ type: 'user', message: { role: 'user', content: text } })
  else record({ type: 'event_msg', payload: { type: 'user_message', message: text } })
}

const skillRoot = () => (kind === 'codex' ? '.pgl-skills' : path.join('.claude', 'skills'))
let told = false
function tellSkills() {
  if (told) return
  told = true
  let names = []
  try { names = fs.readdirSync(skillRoot()).filter((n) => fs.existsSync(path.join(skillRoot(), n, 'SKILL.md'))).sort() } catch { /* none */ }
  log({ session, skills: names, agentsMd: fs.existsSync('AGENTS.md') })
  if (names.length) { summary.push(`스킬: ${names.join(', ')}`); say(`보이는 스킬: ${names.join(', ')}`) }
}

// the directives of one message, one by one; between them a message pasted meanwhile is taken into the same turn
async function work(text) {
  // (Codex's first message points at the prompt file)
  if (/\.pgl-run\/prompt\.md/.test(text) && fs.existsSync('.pgl-run/prompt.md')) text = `${text}\n${fs.readFileSync('.pgl-run/prompt.md', 'utf8')}`
  const m = /「([^」\n]+?)\/」/.exec(text)
  if (m) outDir = m[1]
  for (const raw of String(text).split('\n')) {
    const line = raw.trim()
    let d
    if ((d = /^WRITE_OUT (.+?) :: (.*)$/.exec(line))) {
      const rel = path.join(outDir || '.', d[1])
      tool('Write', rel)
      fs.mkdirSync(path.dirname(inside(rel)), { recursive: true })
      fs.writeFileSync(inside(rel), `${d[2]}\n`)
      summary.push(`${rel} 에 썼어요`)
    } else if ((d = /^WRITE (.+?) :: (.*)$/.exec(line))) {
      tool('Write', d[1])
      fs.mkdirSync(path.dirname(inside(d[1])), { recursive: true })
      fs.writeFileSync(inside(d[1]), `${d[2]}\n`)
      summary.push(`${d[1]} 에 썼어요`)
    } else if ((d = /^READ (.+)$/.exec(line))) {
      tool('Read', d[1])
      let t = ''
      try { t = fs.readFileSync(inside(d[1]), 'utf8').trim() } catch { t = '(없음)' }
      summary.push(`${d[1]}: ${t}`)
    } else if ((d = /^SLEEP (\d+)$/.exec(line))) {
      tool('Bash', `sleep ${Number(d[1]) / 1000}`, { fields: { command: `sleep ${Number(d[1]) / 1000}` } })
      screen('\x1b[33m✻ Working…\x1b[0m\n')
      await sleep(Number(d[1]))
    } else if ((d = /^SKILLNOTE (.+?) :: (.*)$/.exec(line))) {
      const f = path.join(skillRoot(), d[1], 'SKILL.md')
      tool('Edit', f)
      fs.appendFileSync(inside(f), `\n${d[2]}\n`)
      summary.push(`${d[1]} 스킬에 적었어요`)
    } else if ((d = /^MEMORY :: (.*)$/.exec(line))) {
      const f = kind === 'codex' ? 'AGENTS.md' : 'CLAUDE.md'
      tool('Write', f)
      fs.appendFileSync(inside(f), `\n- ${d[1]}\n`)
    } else if ((d = /^THINK :: (.*)$/.exec(line))) {
      think(d[1])
    } else if ((d = /^SAY :: (.*)$/.exec(line))) {
      say(d[1].replace(/\\n/g, '\n'))
      summary.push(d[1].slice(0, 40))
    } else if ((d = /^EDIT (.+?) :: (.*?) => (.*)$/.exec(line))) {
      const rel = path.join(outDir || '.', d[1])
      const before = fs.existsSync(inside(rel)) ? fs.readFileSync(inside(rel), 'utf8') : ''
      const after = before.includes(d[2]) ? before.replace(d[2], d[3]) : `${before}${d[3]}\n`
      fs.mkdirSync(path.dirname(inside(rel)), { recursive: true })
      fs.writeFileSync(inside(rel), after)
      // (its structured patch as Claude Code writes it: context, the old line, the new line)
      const ls = before.split('\n')
      const at = Math.max(0, ls.findIndex((l) => l.includes(d[2])))
      const lines = [...(at > 0 ? [` ${ls[at - 1]}`] : []), `-${ls[at] ?? ''}`, `+${(ls[at] ?? '').replace(d[2], d[3])}`]
      tool('Edit', rel, { fields: { file_path: inside(rel), old_string: d[2], new_string: d[3], replace_all: false },
        result: `The file ${inside(rel)} has been updated successfully.`, use: { filePath: inside(rel), oldString: d[2], newString: d[3], originalFile: before,
          structuredPatch: [{ oldStart: Math.max(1, at), oldLines: at > 0 ? 2 : 1, newStart: Math.max(1, at), newLines: at > 0 ? 2 : 1, lines }], userModified: false, replaceAll: false } })
      summary.push(`${rel} 을 고쳤어요`)
    } else if ((d = /^BASH (.+?) :: (.*)$/.exec(line))) {
      tool('Bash', d[1], { fields: { command: d[1] }, result: d[2], use: { stdout: d[2], stderr: '', interrupted: false, isImage: false } })
    } else if ((d = /^SKILL (.+)$/.exec(line))) {
      tool('Skill', d[1], { fields: { skill: d[1] }, result: `Launching skill: ${d[1]}` })
    } else if ((d = /^ASK (.+)$/.exec(line))) {
      // a Bash call that needs permission (as 2.1.331 shows it)
      const id = `toolu_${crypto.randomBytes(4).toString('hex')}`
      const input = { command: d[1], description: '허락이 필요한 명령' }
      screen(`\x1b[36m⏺\x1b[0m Bash(${d[1]})\n  ⎿  Waiting…\n`)
      record({ type: 'assistant', uuid: crypto.randomUUID(), message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input }] } })
      fire('PermissionRequest', { tool_name: 'Bash', tool_input: input, permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: d[1] }], behavior: 'allow', destination: 'localSettings' }] })
      screen(` Bash command\n ${d[1]}\n Do you want to proceed?\n ❯ 1. Yes\n   2. Yes, and don't ask again for: ${d[1].split(' ')[0]} *\n   3. Yes, and switch to auto mode\n   4. No\n Esc to cancel · Tab to amend\n`)
      const key = await ask()
      log({ session, answered: key === '\x1b' ? 'esc' : key })
      if (key === '1' || key === '2') {
        record({ type: 'user', uuid: crypto.randomUUID(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: `(ran) ${d[1]}` }] }, toolUseResult: { stdout: `(ran) ${d[1]}`, stderr: '', interrupted: false, isImage: false } })
        screen(`  ⎿  (ran) ${d[1]}\n`)
        summary.push(`${d[1]} 실행함`)
      } else {
        record({ type: 'user', uuid: crypto.randomUUID(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: "The user doesn't want to proceed with this tool use.", is_error: true }] }, toolUseResult: 'User rejected tool use' })
        record({ type: 'user', uuid: crypto.randomUUID(), rowSource: 'harness', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } })
        screen('  ⎿  Interrupted · What should Claude do instead?\n')
        throw Object.assign(new Error('interrupted'), { interrupted: true })
      }
    } else if ((d = /^CHOOSE (.+)$/.exec(line))) {
      const qs = d[1].split(' ;; ').map((part) => { const [q, opts] = part.split(' :: '); return { question: q.trim(), header: '선택', options: String(opts || '').split('|').map((o) => ({ label: o.trim(), description: `${o.trim()} 쪽으로 해요` })), multiSelect: false } })
      const id = `toolu_${crypto.randomBytes(4).toString('hex')}`
      record({ type: 'assistant', uuid: crypto.randomUUID(), message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input: { questions: qs } }] } })
      fire('PermissionRequest', { tool_name: 'AskUserQuestion', tool_input: { questions: qs } })
      const answers = {}
      for (const q of qs) {
        screen(` ☐ ${q.header}\n${q.question}\n${q.options.map((o, i) => `${i ? '  ' : '❯ '}${i + 1}. ${o.label}`).join('\n')}\n  ${q.options.length + 1}. Type something.\nEnter to select · ↑/↓ to navigate · Esc to cancel\n`)
        const key = await ask()
        log({ session, answered: key === '\x1b' ? 'esc' : key })
        const o = q.options[Number(key) - 1]
        if (!o) throw Object.assign(new Error('interrupted'), { interrupted: true })
        answers[q.question] = o.label
      }
      // (several questions: their review — Enter or 1 submits, as 2.1.331)
      if (qs.length > 1) {
        screen(`←  ${qs.map((q) => `☒ ${q.header}`).join('  ')}  ✔ Submit  →\nReview your answers\n${Object.entries(answers).map(([q, a]) => ` ● ${q}\n   → ${a}`).join('\n')}\n❯ 1. Submit answers\n  2. Cancel\n`)
        const key = await ask()
        log({ session, answered: key === '\r' ? 'enter' : key === '\x1b' ? 'esc' : key })
        if (key !== '\r' && key !== '1') throw Object.assign(new Error('interrupted'), { interrupted: true })
      }
      record({ type: 'user', uuid: crypto.randomUUID(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: `Your questions have been answered: ${Object.entries(answers).map(([q, a]) => `"${q}"="${a}"`).join(', ')}` }] }, toolUseResult: { questions: qs, answers } })
      screen(`⏺ Answered Claude's questions:\n${Object.entries(answers).map(([q, a]) => `  ⎿  · ${q} → ${a}`).join('\n')}\n`)
      const rel = path.join(outDir || '.', '선택.md')
      fs.mkdirSync(path.dirname(inside(rel)), { recursive: true })
      fs.writeFileSync(inside(rel), `${Object.values(answers).join('\n')}\n`)
      summary.push(`고른 것: ${Object.values(answers).join(', ')}`)
    } else if ((d = /^FAIL (.*)$/.exec(line))) {
      throw Object.assign(new Error(d[1]), { fail: true })
    } else continue
    while (waiting.length) { const s = waiting.shift(); took(s); await work(s) }
  }
}

async function turn(text) {
  busy = true
  if (kind === 'claude') fire('UserPromptSubmit', { prompt: text })
  took(text)
  tellSkills()
  try {
    await work(text)
    await sleep(30)
    while (waiting.length) { const s = waiting.shift(); took(s); await work(s) }
    const said = `요약: ${summary.join(' · ') || '할 일이 없었어요'}`
    say(said)
    if (kind === 'claude') fire('Stop', { stop_hook_active: false, last_assistant_message: said })
    else record({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: said } })
  } catch (e) {
    // (refused at a dialog: the turn stops — no Stop hook, the CLI waits for its person)
    if (e.interrupted) { waiting.length = 0 } else {
      screen(`\x1b[31m${e.message}\x1b[0m\n`)
      if (kind === 'claude') fire('StopFailure', { error: e.message })
      else record({ type: 'event_msg', payload: { type: 'error', message: e.message } })
    }
  }
  busy = false
  screen('\x1b[1m❯\x1b[0m ')
  if (waiting.length) turn(waiting.shift())
}
function submit(text) {
  if (!text.trim()) return
  if (busy) { waiting.push(text); screen(`\x1b[90m(대기: ${text.slice(0, 40)})\x1b[0m\n`); return }
  turn(text)
}

// ---------- the terminal ----------
let line = ''
let paste = null
let pastes = 0
// FAKE_TUI_DROP_ENTER=n: the first n Enters after a paste are lost (a busy computer: Claude Code still taking the paste in)
let dropEnter = Number(process.env.FAKE_TUI_DROP_ENTER || 0)
let afterPaste = false
let trusted = true
let onTrust = null
function feed(chunk) {
  let typed = ''
  let s = chunk
  while (s.length) {
    if (paste !== null) {
      const end = s.indexOf('\x1b[201~')
      if (end < 0) { paste += s; s = ''; break }
      paste += s.slice(0, end); line += paste; screen(paste.length > 80 ? (kind === 'claude' ? `[Pasted text #${++pastes} +${paste.split('\n').length - 1} lines]` : `[붙여 넣은 글 ${paste.split('\n').length}줄]`) : paste); paste = null; afterPaste = true; s = s.slice(end + 6); continue
    }
    if (s.startsWith('\x1b[200~')) { paste = ''; s = s.slice(6); continue }
    // (a dialog takes the next key: a number, or Esc on its own)
    if (dialog && (s[0] === '\x1b' ? !/^\x1b\[/.test(s) : /[0-9\r]/.test(s[0]))) { const f = dialog; dialog = null; f(s[0]); s = s.slice(1); continue }
    if (s[0] === '\x1b') { const m = /^\x1b\[[0-9;?]*[A-Za-z~]/.exec(s); s = s.slice(m ? m[0].length : 1); continue }
    const c = s[0]; s = s.slice(1)
    if (c === '\r' || c === '\n') {
      if (onTrust) { const f = onTrust; onTrust = null; f(); continue }
      if (afterPaste && dropEnter > 0) { dropEnter--; log({ session, droppedEnter: true }); continue }
      afterPaste = false
      const t = line; line = ''; screen('\n'); submit(t); continue
    }
    if (c === '\x7f') { if (line) { line = line.slice(0, -1); screen('\b \b') } continue }
    if (c === '\x03') { log({ session, ctrlC: true }); line = ''; screen('^C\n'); continue }
    if (c < ' ') continue
    typed += c; line += c; screen(c)
  }
  if (typed) log({ session, typed })
}

async function main() {
  if (process.stdin.isTTY) process.stdin.setRawMode(true)
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', feed)
  screen('\x1b[?2004h')
  log({ args, session, resumed: kind === 'claude' ? !!arg('--resume') : args[0] === 'resume' })
  if (kind === 'claude') {
    let conf = {}
    try { conf = JSON.parse(fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR || '', '.claude.json'), 'utf8')) } catch { /* none */ }
    const key = process.platform === 'win32' ? cwd.normalize('NFC').replace(/\\/g, '/') : cwd.normalize('NFC')
    trusted = conf.projects?.[key]?.hasTrustDialogAccepted === true
  } else trusted = args.some((a, i) => args[i - 1] === '-c' && a.includes(JSON.stringify(cwd)) && a.endsWith('trust_level="trusted"'))
  if (!trusted) {
    log({ session, trustAsked: true })
    screen('Do you trust the files in this folder?\n❯ 1. Yes, I trust this folder   2. No, exit\nEnter to confirm\n')
    await new Promise((r) => { onTrust = r })
  }
  screen(`\x1b[1m✻ ${kind === 'claude' ? 'Claude Code' : 'OpenAI Codex'} (fake)\x1b[0m · ${session.slice(0, 8)}\n\x1b[1m❯\x1b[0m `)
  if (kind === 'claude') fire('SessionStart', { source: arg('--resume') ? 'resume' : 'startup' })
  else {
    const flags = new Set(['-c', '-C', '--cd', '-s', '--sandbox', '--config', '-m', '--model'])
    const pos = args.filter((a, i) => !a.startsWith('-') && !flags.has(args[i - 1]) && !(args[0] === 'resume' && i <= 1))
    if (pos.length) setTimeout(() => submit(pos[pos.length - 1]), 100)
  }
  // closed (the runner ends the step): as the real one, it clears its screen and leaves a line on how to go on in this session
  const bye = () => {
    screen(`\x1b[2J\x1b[H${kind === 'claude' ? `Resume this session with:\nclaude --resume ${session}` : `To continue this session, run codex resume ${session}`}\n`)
    setTimeout(() => process.exit(0), 30)
  }
  process.on('SIGHUP', bye)
  process.on('SIGTERM', bye)
}
main().catch((e) => { process.stderr.write(`${e.stack}\n`); process.exit(2) })
