#!/usr/bin/env node
'use strict'
// A stand-in for `claude` and `codex` in the local-agent tests (desktop/test, server/test/localAgents.e2e.mjs): the same arguments,
// stdin and JSON output as the real CLIs (Claude Code 2.1.330, Codex 0.162.1, measured 2026-11-24), without a model. What it does is
// written in its prompt, one directive per line:
//   WRITE <path> :: <text>      write a file (inside the folder only)
//   WRITE_OUT <name> :: <text>  write a file into the step's output folder (the 「…/」 the prompt names)
//   READ <path>                 read a file; its text goes into the summary
//   SLEEP <ms>                  wait (a steer can come in meanwhile)
//   FAIL <text>                 end with an error
// Steering: Claude Code reads further user messages on stdin while it works and replays each one it takes (as --replay-user-messages
// does), after the directive at hand; Codex stops on SIGINT, and `codex exec resume <id> -` goes on. Every run is logged to
// $FAKE_CLI_LOG (JSON lines: the CLI, its arguments, its cwd) and a session's history kept in $FAKE_CLI_HOME.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const kind = process.env.FAKE_CLI_KIND || (path.basename(process.argv[1]).includes('codex') ? 'codex' : 'claude')
const args = process.argv.slice(2)
const home = process.env.FAKE_CLI_HOME || path.join(require('node:os').tmpdir(), 'fake-cli-home')
fs.mkdirSync(path.join(home, 'sessions'), { recursive: true })
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (o) => { if (process.env.FAKE_CLI_LOG) fs.appendFileSync(process.env.FAKE_CLI_LOG, `${JSON.stringify({ kind, at: Date.now(), cwd: process.cwd(), ...o })}\n`) }
const arg = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null }

if (args[0] === '--version') { console.log(kind === 'codex' ? 'codex-cli 9.9.9-fake' : '9.9.9 (Claude Code fake)'); process.exit(0) }
if (kind === 'claude' && args[0] === 'auth') { console.log(JSON.stringify({ loggedIn: true, authMethod: 'fake' })); process.exit(0) }
if (kind === 'codex' && args[0] === 'login') { console.log('Logged in using a fake account'); process.exit(0) }

const inside = (rel) => { const p = path.resolve(process.cwd(), rel); if (!p.startsWith(process.cwd() + path.sep)) throw new Error(`outside the folder: ${rel}`); return p }
let outDir = null
const summary = []
let session = null
const sessionFile = () => path.join(home, 'sessions', `${session}.json`)
const remember = (text) => { const s = fs.existsSync(sessionFile()) ? JSON.parse(fs.readFileSync(sessionFile(), 'utf8')) : { messages: [] }; s.messages.push(text); fs.writeFileSync(sessionFile(), JSON.stringify(s)) }

// the skills it finds where its real counterpart reads them (Claude Code: .claude/skills, Codex: AGENTS.md → .pgl-skills)
const skillRoot = () => (kind === 'codex' ? '.pgl-skills' : path.join('.claude', 'skills'))
function seenSkills() {
  try { return fs.readdirSync(skillRoot()).filter((n) => fs.existsSync(path.join(skillRoot(), n, 'SKILL.md'))).sort() } catch { return [] }
}
let told = false
function tellSkills(say) {
  if (told) return
  told = true
  const names = seenSkills()
  log({ session, skills: names, agentsMd: fs.existsSync('AGENTS.md') })
  if (names.length) { summary.push(`스킬: ${names.join(', ')}`); say(`보이는 스킬: ${names.join(', ')}`) }
}

// the directives of one message → done one by one; between them `between()` may take a steer (Claude Code)
async function work(text, { tool, between }) {
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
      tool('Bash', `sleep ${Number(d[1]) / 1000}`)
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
    } else if ((d = /^FAIL (.*)$/.exec(line))) {
      throw Object.assign(new Error(d[1]), { fail: true })
    } else continue
    if (between) await between()
  }
}

async function claude() {
  session = arg('--resume') || arg('--session-id') || crypto.randomUUID()
  log({ args, session })
  out({ type: 'system', subtype: 'init', session_id: session, cwd: process.cwd(), tools: ['Read', 'Write'] })
  const queue = []
  let ended = false
  let buf = ''
  let wake = null
  process.stdin.on('data', (d) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1)
      try { const m = JSON.parse(line); if (m.type === 'user') { const t = typeof m.message.content === 'string' ? m.message.content : ''; queue.push(t); log({ session, received: t.slice(0, 400) }) } } catch { /* not ours */ }
    }
    if (wake) { wake(); wake = null }
  })
  process.stdin.on('end', () => { ended = true; if (wake) { wake(); wake = null } })
  const next = () => new Promise((r) => { if (queue.length || ended) r(); else wake = r })
  const tool = (name, input) => { const id = `toolu_${crypto.randomBytes(4).toString('hex')}`; out({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input: { file_path: input } }] } }); out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } }) }
  for (;;) {
    await next()
    if (!queue.length && ended) break
    const text = queue.shift()
    out({ type: 'user', isReplay: true, message: { role: 'user', content: text } })
    remember(text)
    tellSkills((t) => out({ type: 'assistant', message: { content: [{ type: 'text', text: t }] } }))
    let turns = 1
    try {
      // a steer that comes in while it works is taken after the step at hand, in the same turn
      const between = async () => { while (queue.length) { const s = queue.shift(); out({ type: 'user', isReplay: true, message: { role: 'user', content: s } }); remember(s); turns++; await work(s, { tool }) } }
      await work(text, { tool, between })
      await sleep(30)
      await between()
      const said = `요약: ${summary.join(' · ') || '할 일이 없었어요'}`
      out({ type: 'assistant', message: { content: [{ type: 'text', text: said }] } })
      out({ type: 'result', subtype: 'success', is_error: false, num_turns: turns, result: said, session_id: session })
    } catch (e) {
      out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: e.message, session_id: session })
      process.exitCode = 1
    }
  }
}

async function codex() {
  const resume = args[1] === 'resume'
  const pos = args.filter((a, i) => !a.startsWith('-') && !['exec', 'resume'].includes(a) && !['-c', '-s', '-C', '--cd', '--sandbox', '--config'].includes(args[i - 1]))
  session = resume ? pos[0] : crypto.randomUUID()
  log({ args, session })
  const prompt = await new Promise((r) => { let s = ''; process.stdin.on('data', (d) => { s += d }); process.stdin.on('end', () => r(s)) })
  log({ session, received: prompt.slice(-400) })
  process.on('SIGINT', () => { log({ interrupted: true, session }); process.exit(130) })
  if (resume) { const s = JSON.parse(fs.readFileSync(sessionFile(), 'utf8')); outDir = s.outDir || null }
  else { const m = /「([^」\n]+?)\/」/.exec(prompt); outDir = m ? m[1] : null; fs.writeFileSync(sessionFile(), JSON.stringify({ messages: [], outDir })) }
  out({ type: 'thread.started', thread_id: session })
  out({ type: 'turn.started' })
  const tool = (name, input) => { out({ type: 'item.started', item: { id: crypto.randomUUID(), type: 'command_execution', command: `${name} ${input}`, status: 'in_progress' } }) }
  tellSkills((t) => out({ type: 'item.completed', item: { id: crypto.randomUUID(), type: 'agent_message', text: t } }))
  try {
    await work(prompt, { tool })
    const s = fs.existsSync(sessionFile()) ? JSON.parse(fs.readFileSync(sessionFile(), 'utf8')) : { messages: [] }
    s.messages.push(prompt); s.outDir = outDir
    fs.writeFileSync(sessionFile(), JSON.stringify(s))
    out({ type: 'item.completed', item: { id: crypto.randomUUID(), type: 'agent_message', text: `요약: ${summary.join(' · ') || '할 일이 없었어요'}` } })
    out({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } })
  } catch (e) {
    out({ type: 'turn.failed', error: { message: e.message } })
    process.exitCode = 1
  }
}

;(kind === 'codex' ? codex() : claude()).catch((e) => { process.stderr.write(`${e.stack}\n`); process.exit(2) })
