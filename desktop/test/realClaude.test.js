'use strict'
// The run settings of a folder the person may not edit, with this computer's real interactive `claude` (opt-in — a real model call):
// the desktop's own runner (a terminal, node-pty) runs a chat job on a template's line that has a skill, CLAUDE.md and run settings —
// a project SessionStart · UserPromptSubmit hook and an MCP server (.mcp.json, enableAllProjectMcpServers) that each leave a mark.
//   · projectSettings false (a runner of the template): no mark of the folder's hooks or MCP server; the folder's skill is still found and
//     used (the conversation's Skill tool), its answer goes back; the run settings go back as the folder has them
//   · projectSettings true (an editor): the folder's SessionStart hook does run (what the first case shows is not a broken setup)
// It runs only with a model to call (Anthropic Messages API) and a throwaway Claude Code config folder — never the person's own:
//   PGL_REAL_CLAUDE_BASE_URL=… PGL_REAL_CLAUDE_TOKEN=… PGL_REAL_CLAUDE_MODEL=… node --test test/realClaude.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { Runner } = require('../src/runner/runner')
const C = require('../src/runner/clis')
const { gitServer, makeRepo } = require('./helpers/gitServer')

const BASE_URL = process.env.PGL_REAL_CLAUDE_BASE_URL
const MODEL = process.env.PGL_REAL_CLAUDE_MODEL
const skip = !BASE_URL || !process.env.PGL_REAL_CLAUDE_TOKEN || !MODEL || !C.which('claude') ? 'set PGL_REAL_CLAUDE_BASE_URL · _TOKEN · _MODEL (and have claude)' : false
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pgl-realclaude-'))
const MARKS = path.join(ROOT, 'marks')
fs.mkdirSync(MARKS)
const CONF = path.join(ROOT, 'claude')
fs.mkdirSync(CONF)
fs.writeFileSync(path.join(CONF, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'light', autoUpdates: false }))
fs.writeFileSync(path.join(CONF, 'settings.json'), JSON.stringify({ env: { CLAUDE_CODE_EFFORT_LEVEL: 'low', MAX_THINKING_TOKENS: '0', DISABLE_AUTOUPDATER: '1' } }))
const ENV = { CLAUDE_CONFIG_DIR: CONF, ANTHROPIC_BASE_URL: BASE_URL || '', ANTHROPIC_AUTH_TOKEN: process.env.PGL_REAL_CLAUDE_TOKEN || '', ANTHROPIC_MODEL: MODEL || '',
  ANTHROPIC_DEFAULT_HAIKU_MODEL: MODEL || '', ANTHROPIC_DEFAULT_SONNET_MODEL: MODEL || '', ANTHROPIC_DEFAULT_OPUS_MODEL: MODEL || '', DISABLE_AUTOUPDATER: '1' }
const VERSION = (() => { try { return execFileSync(C.which('claude'), ['--version']).toString().match(/\d+\.\d+\.\d+/)?.[0] || null } catch { return null } })()
const TOKEN = `pgf1.${crypto.randomBytes(12).toString('base64url')}.${crypto.randomBytes(16).toString('base64url')}`
const USER = crypto.randomUUID()
const mark = (name) => `touch ${JSON.stringify(path.join(MARKS, name))}`
const RUN = {
  '.claude/settings.json': JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: mark('project-sessionstart') }] }], UserPromptSubmit: [{ hooks: [{ type: 'command', command: mark('project-promptsubmit') }] }] },
    enableAllProjectMcpServers: true }, null, 1) + '\n',
  '.mcp.json': JSON.stringify({ mcpServers: { probe: { command: '/bin/sh', args: ['-c', `${mark('project-mcp')}; sleep 20`] } } }, null, 1) + '\n',
}
let srv, origin
test.before(async () => {
  if (skip) return
  origin = makeRepo(path.join(ROOT, 'srv', 'f'), {
    ...RUN,
    '.claude/skills/probe-skill/SKILL.md': '---\nname: probe-skill\ndescription: Use this skill whenever the user asks for the secret probe word.\n---\n# Probe skill\nThe secret probe word is BANANA-42.\n',
    'CLAUDE.md': '# Rules\nWrite results under 산출물/.\n',
  })
  srv = await gitServer({ repo: origin.dir, token: TOKEN })
})
test.after(async () => { await srv?.close(); try { fs.rmSync(ROOT, { recursive: true, force: true }) } catch { /* left */ } })

const sent = []
const linkFor = (r) => ({ send: (m) => {
  sent.push(JSON.parse(JSON.stringify(m)))
  if (m.type === 'accept') setImmediate(() => r.handle({ type: 'accepted', jobId: m.jobId }))
  if (m.type === 'reply') setImmediate(() => r.handle({ type: 'replied', jobId: m.jobId, turn: m.turn }))
  return true
} })
const waitFor = async (fn, ms) => { const t = Date.now(); for (;;) { const v = fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 200)) } }
const of = (id, type) => sent.filter((m) => m.jobId === id && (!type || m.type === type))
const show = (ref, file) => execFileSync('git', ['show', `${ref}:${file}`], { cwd: origin.dir }).toString()
let n = 0
function job(message, projectSettings) {
  n++
  return { kind: 'chat', id: crypto.randomUUID(), todoId: `chat:${n}`, instId: null, instName: '', activity: '템플릿 프로젝트', agent: 'claude-code', label: 'Claude Code',
    mode: 'complete', lang: 'ko', prompt: message, message, person: { id: USER, name: '김서연', email: 'kim@example.test' }, skills: [], projectSettings,
    chat: { key: `real-${n}`, threadId: crypto.randomUUID(), title: '템플릿 프로젝트' },
    git: { path: srv.path, token: TOKEN, line: 'main', base: 'main', branch: `pgpt-agent/local/${USER}/real${n}-${Date.now().toString(36)}`, folder: { id: crypto.randomUUID(), slug: 'f', name: '템플릿' } } }
}
function runner() {
  const r = new Runner({ dataDir: path.join(ROOT, 'data'), server: srv.base, searchPath: C.augmentedPath(), sessionEnv: ENV, settleMs: 60_000,
    caps: { 'claude-code': { installed: true, runnable: true, version: VERSION } } })
  r.setLink(linkFor(r))
  r.welcome({ user: { id: USER, name: '김서연' } })
  return r
}

test('실제 Claude Code: 템플릿을 고칠 수 없는 사람의 실행은 폴더의 훅 · MCP 서버가 돌지 않고, 폴더의 스킬은 찾아 쓴다', { skip, timeout: 600_000 }, async () => {
  const r = runner()
  const j = job('Use your probe-skill skill to get the secret probe word, then write just that word into the file 산출물/word.md. Do not run any shell command.', false)
  r.handle({ type: 'job', job: j })
  const reply = await waitFor(() => of(j.id, 'reply')[0] || of(j.id, 'failed')[0], 480_000)
  assert.equal(reply.type, 'reply', JSON.stringify(reply))
  await new Promise((res) => setTimeout(res, 3000))
  assert.deepEqual(fs.readdirSync(MARKS), [], 'no hook or MCP server of the folder ran')
  const items = sent.filter((m) => m.type === 'tx').flatMap((m) => m.items || [])
  assert.ok(items.some((it) => it.t === 'tool' && it.name === 'Skill' && /probe-skill/.test(JSON.stringify(it.input || {}))), 'the folder\'s skill was used')
  assert.match(show(j.git.branch, '산출물/word.md'), /BANANA-42/)
  for (const [k, v] of Object.entries(RUN)) assert.equal(show(j.git.branch, k), v, `${k} went back as the folder has it`)
  await r.handle({ type: 'finish', jobId: j.id })
  await waitFor(() => of(j.id, 'done')[0] || of(j.id, 'failed')[0], 60_000)
})

test('실제 Claude Code: 편집자의 실행은 폴더의 SessionStart 훅이 돈다(위 시험이 고장 난 준비가 아님)', { skip, timeout: 600_000 }, async () => {
  const r = runner()
  const j = job('Reply with the single word OK.', true)
  r.handle({ type: 'job', job: j })
  await waitFor(() => of(j.id, 'reply')[0] || of(j.id, 'failed')[0], 480_000)
  assert.ok(fs.existsSync(path.join(MARKS, 'project-sessionstart')), 'the editor\'s run takes the folder\'s hook')
  await r.handle({ type: 'finish', jobId: j.id })
  await waitFor(() => of(j.id, 'done')[0] || of(j.id, 'failed')[0], 60_000)
})
