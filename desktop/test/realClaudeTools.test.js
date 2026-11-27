'use strict'
// The Process GPT tools with this computer's real interactive `claude` (opt-in — real model calls; desktop 0.2.8, spec
// openspec/specs/local-agents 「채팅에서 내 PC의 스킬 · 폴더 등록 제안」): the desktop's own runner (a terminal, node-pty) runs a chat job whose
// CLI is given the app's MCP server (runner/tools.js · mcp/server.js). The person only says 「내 PC 의 견적-규칙 스킬을 등록해 줘」 — nothing
// names a tool: the CLI reads the tools' descriptions, finds the skill on this computer and proposes it; the stand-in server records the
// proposal (its files, no path of the PC). Nothing is registered: the CLI is told to stop at the card.
// It runs only with a model to call (Anthropic Messages API) and a throwaway Claude Code config folder — never the person's own:
//   PGL_REAL_CLAUDE_BASE_URL=… PGL_REAL_CLAUDE_TOKEN=… PGL_REAL_CLAUDE_MODEL=… node --test test/realClaudeTools.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { Runner } = require('../src/runner/runner')
const { ToolDesk } = require('../src/runner/tools')
const C = require('../src/runner/clis')
const { gitServer, makeRepo } = require('./helpers/gitServer')

const BASE_URL = process.env.PGL_REAL_CLAUDE_BASE_URL
const MODEL = process.env.PGL_REAL_CLAUDE_MODEL
const skip = !BASE_URL || !process.env.PGL_REAL_CLAUDE_TOKEN || !MODEL || !C.which('claude') ? 'set PGL_REAL_CLAUDE_BASE_URL · _TOKEN · _MODEL (and have claude)' : false
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pgl-realtools-')))
const CONF = path.join(ROOT, 'claude')
const HOME = path.join(ROOT, 'home')
fs.mkdirSync(CONF, { recursive: true })
fs.writeFileSync(path.join(CONF, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'light', autoUpdates: false }))
fs.writeFileSync(path.join(CONF, 'settings.json'), JSON.stringify({ env: { CLAUDE_CODE_EFFORT_LEVEL: 'low', MAX_THINKING_TOKENS: '0', DISABLE_AUTOUPDATER: '1' } }))
// her skills, where Claude Code keeps its own
const put = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t) }
put(path.join(CONF, 'skills', '견적-규칙', 'SKILL.md'), '---\nname: 견적-규칙\ndescription: 견적서를 회사 양식으로 쓰고, 부가세는 따로 적는 법\n---\n# 견적 규칙\n부가세는 따로 적어요.\n')
put(path.join(CONF, 'skills', '견적-규칙', 'templates', '견적서.md'), '| 품목 | 수량 | 금액 |\n')
put(path.join(CONF, 'skills', '견적-규칙', '.env'), 'QUOTE_API_KEY=abc\n')
put(path.join(CONF, 'skills', '회의록-정리', 'SKILL.md'), '---\nname: 회의록-정리\ndescription: 회의록을 안건 · 결정 · 할 일로 정리해요\n---\n')
fs.mkdirSync(HOME, { recursive: true })
// (its home is a throwaway one too: what it does with ~ never reaches the person's own)
const ENV = { HOME, CLAUDE_CONFIG_DIR: CONF, ANTHROPIC_BASE_URL: BASE_URL || '', ANTHROPIC_AUTH_TOKEN: process.env.PGL_REAL_CLAUDE_TOKEN || '', ANTHROPIC_MODEL: MODEL || '',
  ANTHROPIC_DEFAULT_HAIKU_MODEL: MODEL || '', ANTHROPIC_DEFAULT_SONNET_MODEL: MODEL || '', ANTHROPIC_DEFAULT_OPUS_MODEL: MODEL || '', DISABLE_AUTOUPDATER: '1',
  // (Claude Code 2.1.332 defers MCP tools behind its ToolSearch: it found and loaded ours that way, but the company's model gateway answers
  // the deferred tools' references with a server error — so the tools load with the session, as the runner's own default for chat runs
  // does (runner.js toolSearchEnv); PGL_REAL_CLAUDE_TOOL_SEARCH=true against Anthropic's own API keeps the search)
  ENABLE_TOOL_SEARCH: process.env.PGL_REAL_CLAUDE_TOOL_SEARCH || 'false' }
const VERSION = (() => { try { return execFileSync(C.which('claude'), ['--version']).toString().match(/\d+\.\d+\.\d+/)?.[0] || null } catch { return null } })()
const TOKEN = `pgf1.${crypto.randomBytes(12).toString('base64url')}.${crypto.randomBytes(16).toString('base64url')}`
const TOOL_TOKEN = `plt1.${crypto.randomBytes(12).toString('base64url')}.${crypto.randomBytes(16).toString('base64url')}`
const USER = crypto.randomUUID()
let srv, origin
test.before(async () => {
  if (skip) return
  origin = makeRepo(path.join(ROOT, 'srv', 'f'), { 'README.md': '# 내 PC 에이전트 작업\n' })
  srv = await gitServer({ repo: origin.dir, token: TOKEN })
})
test.after(async () => { await srv?.close(); try { fs.rmSync(ROOT, { recursive: true, force: true }) } catch { /* left */ } })

// the server's tool API, as a stand-in: what it was sent
const calls = []
const fetchImpl = async (url, opts = {}) => {
  const body = opts.body ? JSON.parse(opts.body) : null
  calls.push({ url: String(url), method: opts.method || 'GET', auth: opts.headers?.Authorization, body })
  const p = new URL(url).pathname
  const json = p.endsWith('/skills') ? { skills: [] } : p.endsWith('/folders') ? { folders: [] } : { id: crypto.randomUUID(), name: body?.name, state: 'pending', expiresInMinutes: 60 }
  return { ok: true, status: 200, json: async () => json }
}
const sent = []
const linkFor = (r) => ({ send: (m) => {
  sent.push(JSON.parse(JSON.stringify(m)))
  if (m.type === 'accept') setImmediate(() => r.handle({ type: 'accepted', jobId: m.jobId }))
  if (m.type === 'reply') setImmediate(() => r.handle({ type: 'replied', jobId: m.jobId, turn: m.turn }))
  return true
} })
const waitFor = async (fn, ms) => { const t = Date.now(); for (;;) { const v = fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 200)) } }
const of = (id, type) => sent.filter((m) => m.jobId === id && (!type || m.type === type))
const sidOf = (jobId) => sent.find((m) => m.type === 'term-open' && m.ref === jobId)?.sid
const items = (sid) => sent.filter((m) => m.type === 'tx' && (!sid || m.sid === sid)).flatMap((m) => m.items || [])

test('실제 Claude Code: 「내 PC 의 견적-규칙 스킬을 등록해 줘」 — 도구 설명만 보고 PC 의 스킬을 찾아 lite_propose_skill 로 제안하고, 카드를 확인해 달라며 멈춘다', { skip, timeout: 600_000 }, async () => {
  const DATA = path.join(ROOT, 'app', 'data')
  const desk = new ToolDesk({ dataDir: DATA, server: srv.base, home: HOME, fetchImpl })
  const r = new Runner({ dataDir: DATA, server: srv.base, searchPath: C.augmentedPath(), sessionEnv: ENV, settleMs: 60_000, tools: desk,
    caps: { 'claude-code': { installed: true, runnable: true, version: VERSION } } })
  r.setLink(linkFor(r))
  r.welcome({ user: { id: USER, name: '정하윤' } })
  const message = '내 PC 의 견적-규칙 스킬을 Process GPT 에 등록해 줘'
  const j = { kind: 'chat', id: crypto.randomUUID(), todoId: 'chat:1', instId: null, instName: '', activity: '채팅', agent: 'claude-code', label: 'Claude Code', mode: 'complete', lang: 'ko',
    prompt: message, message, person: { id: USER, name: '정하윤', email: 'jung@example.test' }, skills: [], projectSettings: true,
    chat: { key: 'real-tools', threadId: crypto.randomUUID(), title: '채팅' }, tools: { token: TOOL_TOKEN, minutes: 90 },
    git: { path: srv.path, token: TOKEN, line: 'main', base: 'main', branch: `pgpt-agent/local/${USER}/tools-${Date.now().toString(36)}`, folder: { id: crypto.randomUUID(), slug: 'f', name: '내 PC 에이전트 작업' } } }
  r.handle({ type: 'job', job: j })
  // (whatever else the CLI asks about on its way — a command, a file outside the work folder: no; the tools are allowed already)
  const seen = new Set()
  const t0 = Date.now()
  let reply
  for (;;) {
    reply = of(j.id, 'reply')[0] || of(j.id, 'failed')[0]
    if (reply) break
    const sid = sidOf(j.id)
    for (const it of sid ? items(sid) : []) {
      if (it.t !== 'ask' || it.ask?.kind !== 'permission' || seen.has(it.ask.id)) continue
      seen.add(it.ask.id)
      await r.handle({ type: 'pty-answer', sid, ask: it.ask.id, answer: 'no', byId: USER, by: '정하윤' })
    }
    if (Date.now() - t0 > 480_000) throw new Error('no reply')
    await new Promise((res) => setTimeout(res, 500))
  }
  // (what the CLI did, for whoever reads the run)
  const used = items(sidOf(j.id)).filter((it) => it.t === 'tool').map((it) => it.name)
  console.log(`# reply: ${reply.type} · tools the CLI used: ${used.join(', ') || '(none)'} · calls to the server: ${calls.map((c) => new URL(c.url).pathname).join(', ') || '(none)'}`)
  console.log(`# its answer: ${String(reply.text || reply.error || '').replace(/\s+/g, ' ').slice(0, 600)}`)
  assert.equal(reply.type, 'reply', JSON.stringify(reply))
  const proposals = calls.filter((c) => c.url.endsWith('/api/local-agents/tools/skills/propose'))
  assert.equal(proposals.length, 1, `one proposal: ${JSON.stringify(calls.map((c) => c.url))}`)
  const p = proposals[0]
  assert.equal(p.auth, `Bearer ${TOOL_TOKEN}`)
  assert.equal(p.body.name, '견적-규칙')
  assert.deepEqual(p.body.files.map((f) => f.path).sort(), ['SKILL.md', 'templates/견적서.md'], '.env left out')
  assert.ok(!JSON.stringify(p.body).includes(ROOT), 'no path of this PC')
  const tools = items(sidOf(j.id)).filter((it) => it.t === 'tool').map((it) => it.name)
  assert.ok(tools.includes('mcp__process_gpt_lite__lite_propose_skill'), `the tool it chose: ${tools.join(', ')}`)
  await r.handle({ type: 'finish', jobId: j.id })
  await waitFor(() => of(j.id, 'done')[0] || of(j.id, 'failed')[0], 60_000)
  desk.stop()
})
