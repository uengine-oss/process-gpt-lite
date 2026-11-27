'use strict'
// A chat message for this person's CLI (job kind 'chat', 0.2.2 — server lib/localAgents/chat.js, the composer's agent picker), with the
// fake interactive CLIs (test/fixtures/fake-tui.js) and a git smart-HTTP server. What is checked:
//   · it runs in the chat's own folder (one per chat and folder), relayed as a session of kind 'chat'; its first message is the prompt
//   · at the turn's end the turn's files are committed and pushed on the run's branch and 'reply' carries the CLI's last words and those
//     files — said again on a new link until the server says 'replied'
//   · the session waits for the next message after its turn (the next words are typed into the same CLI), and when it ends there is no
//     step note (결과.md); the chat's session record stays for the next run
//   · the chat's next run resumes the same CLI session (--resume) when this computer has it, with only the person's new words; without the
//     record it starts afresh with the prompt (the chat's recap)
//   · a chat job without its chat is refused
// Run: cd desktop && node --test test/chat.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { Runner } = require('../src/runner/runner')
const { gitServer, makeRepo } = require('./helpers/gitServer')
const { fakeBin, systemPath } = require('./helpers/fakeBin')

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pgl-chat-'))
const rmQuiet = (d) => { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) } catch (e) { console.warn(`left ${d}: ${e.code}`) } }
const BIN = fakeBin(path.join(ROOT, 'bin'))
const SEARCH = [BIN, ...systemPath()].join(path.delimiter)
process.env.FAKE_CLI_LOG = path.join(ROOT, 'fake.log')
const ENV = { CLAUDE_CONFIG_DIR: path.join(ROOT, 'claude'), CODEX_HOME: path.join(ROOT, 'codex') }
fs.mkdirSync(ENV.CLAUDE_CONFIG_DIR, { recursive: true })
const TOKEN = `pgf1.${crypto.randomBytes(12).toString('base64url')}.${crypto.randomBytes(16).toString('base64url')}`
const FOLDER = crypto.randomUUID()
const USER = crypto.randomUUID()
const THREAD = crypto.randomUUID()
let srv, origin
test.before(async () => {
  origin = makeRepo(path.join(ROOT, 'srv', 'f'), { '메모.md': '# 메모\n' })
  srv = await gitServer({ repo: origin.dir, token: TOKEN })
})
test.after(async () => { await srv?.close(); rmQuiet(ROOT) })

const sent = []
// the server's side of the link: recorded; an accept is confirmed; a reply is acknowledged only when `ack` says so
let ack = true
const linkFor = (r) => ({ send: (m) => {
  sent.push(JSON.parse(JSON.stringify(m)))
  if (process.env.CHAT_DEBUG && !['pty', 'tx'].includes(m.type)) console.log(new Date().toISOString().slice(17, 23), 'sent', m.type, m.event || m.turn || m.reason || '')
  if (m.type === 'accept') setImmediate(() => r.handle({ type: 'accepted', jobId: m.jobId }))
  if (m.type === 'reply' && ack) setImmediate(() => r.handle({ type: 'replied', jobId: m.jobId, turn: m.turn }))
  return true
} })
const waitFor = async (fn, ms = 20000) => { const t = Date.now(); for (;;) { const v = fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 50)) } }
const of = (id, type) => sent.filter((m) => m.jobId === id && (!type || m.type === type))
const fakeLog = () => (fs.existsSync(process.env.FAKE_CLI_LOG) ? fs.readFileSync(process.env.FAKE_CLI_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [])
const show = (ref, file) => execFileSync('git', ['show', `${ref}:${file}`], { cwd: origin.dir }).toString()
const dataDir = path.join(ROOT, 'data')
function runner(opts = {}) {
  const r = new Runner({ dataDir, server: srv.base, searchPath: SEARCH, sessionEnv: ENV, settleMs: 60_000, log: (s) => { if (process.env.CHAT_DEBUG) console.log(new Date().toISOString().slice(17, 23), s) },
    caps: { 'claude-code': { installed: true, runnable: true, version: '9.9.9' }, codex: { installed: true, runnable: true, version: '9.9.9' } }, ...opts })
  r.setLink(linkFor(r))
  r.welcome({ user: { id: USER, name: '윤태호' } })
  return r
}
let n = 0
function chatJob(agent, message, extra = {}) {
  n++
  return { kind: 'chat', id: crypto.randomUUID(), todoId: `chat:${n}`, instId: null, instName: '', activity: '메인 채팅', agent, label: agent === 'codex' ? 'Codex' : 'Claude Code',
    mode: 'complete', lang: 'ko', prompt: `[이 대화의 앞부분 — 최근 1개]\n- 나: 안녕\n\n[윤태호 님의 메시지]\n${message}`, message, person: { id: USER, name: '윤태호', email: 'yoon@example.test' },
    skills: [], chat: { key: THREAD, threadId: THREAD, title: '메인 채팅' },
    git: { path: srv.path, token: TOKEN, line: 'main', base: 'main', branch: `pgpt-agent/local-chat${n}-${Date.now().toString(36)}`, folder: { id: FOLDER, slug: 'f', name: '내 PC 에이전트 작업' } }, ...extra }
}

let first, sessionId
test('채팅 메시지: 대화의 폴더에서 돌고, 턴이 끝나면 그 턴의 파일을 올리고 마지막 말과 함께 reply — 세션은 다음 메시지를 기다린다', async () => {
  const r = runner()
  first = chatJob('claude-code', 'WRITE 회의록.md :: 안건 1. 예산')
  // (not awaited: handle() returns when the run is over)
  r.handle({ type: 'job', job: first })
  const reply = await waitFor(() => of(first.id, 'reply')[0])
  assert.equal(reply.turn, 1)
  assert.match(reply.text, /회의록\.md 에 썼어요/)
  assert.equal(reply.pushed, true)
  assert.deepEqual(reply.files, ['회의록.md'])
  assert.equal(show(first.git.branch, '회의록.md'), '안건 1. 예산\n')
  // the chat's own folder, a session of kind 'chat', the prompt as its first message
  assert.match(path.basename(r.dirFor(first)), /^chat-[0-9a-f]{16}-/)
  const open = sent.find((m) => m.type === 'term-open' && m.ref === first.id)
  assert.equal(open.kind, 'chat')
  sessionId = open.cli
  assert.ok(fakeLog().find((x) => x.session === sessionId && x.received)?.received.startsWith('[이 대화의 앞부분'))
  // it waits after its turn: the next words go into the same CLI
  assert.equal(of(first.id, 'done').length, 0)
  assert.equal(r.steer(first.id, 's1', 'WRITE 할일.md :: 견적서 보내기', '윤태호', USER), true)
  const second = await waitFor(() => of(first.id, 'reply').find((m) => m.turn === 2))
  assert.deepEqual(second.files, ['할일.md'])
  assert.equal(new Set(fakeLog().filter((x) => x.received).map((x) => x.session)).size, 1)
  // 「끝내기」: it ends — no step note, the chat's record stays, the run's own goes
  await r.handle({ type: 'finish', jobId: first.id })
  const done = await waitFor(() => of(first.id, 'done')[0] || of(first.id, 'failed')[0])
  assert.equal(done.type, 'done', JSON.stringify(done))
  assert.equal(done.sessionId, sessionId)
  assert.throws(() => show(first.git.branch, '결과.md'), 'no 결과.md for a chat')
  assert.equal(r.chatRecord(first)?.cli, sessionId)
  assert.equal(r.record(first.id), null)
  await r.handle({ type: 'finished', jobId: first.id, state: 'done', line: 'main' })
  // nothing of the CLI's own places is committed into the folder
  const files = execFileSync('git', ['ls-tree', '-r', '--name-only', first.git.branch], { cwd: origin.dir }).toString().split('\n').filter(Boolean)
  assert.ok(!files.some((f) => f.startsWith('.claude/') || f.startsWith('.pgl-run/')), files.join(','))
})

test('그 대화의 다음 실행: 이 컴퓨터에 세션이 있으면 같은 세션을 잇고(--resume) 새 말만 넣는다 · 없으면 처음부터(요약과 함께)', async () => {
  const r = runner()
  // (the server brought the first run's branch onto the chat's line: here the line is that branch)
  const next = chatJob('claude-code', 'READ 회의록.md', { resume: { sessionId } })
  next.git = { ...next.git, line: first.git.branch, base: first.git.branch }
  r.handle({ type: 'job', job: next })
  const reply = await waitFor(() => of(next.id, 'reply')[0])
  assert.match(reply.text, /회의록\.md: 안건 1\. 예산/)
  const started = fakeLog().filter((x) => x.args && x.session === sessionId)
  assert.ok(started.some((x) => x.resumed), 'claude --resume <the chat\'s session>')
  const took = fakeLog().filter((x) => x.session === sessionId && x.received).map((x) => x.received)
  assert.equal(took[took.length - 1], 'READ 회의록.md', 'only the new words')
  await r.handle({ type: 'finish', jobId: next.id })
  await waitFor(() => of(next.id, 'done')[0])
  await r.handle({ type: 'finished', jobId: next.id, state: 'done', line: 'main' })
  // another chat (its own key): no record of it here — a new session with the prompt, though the server named a session
  const other = chatJob('claude-code', 'WRITE 다른.md :: x', { chat: { key: `${THREAD}:conv-b`, threadId: THREAD, title: '다른 대화' }, resume: { sessionId } })
  r.handle({ type: 'job', job: other })
  await waitFor(() => of(other.id, 'reply')[0])
  const open = sent.find((m) => m.type === 'term-open' && m.ref === other.id)
  assert.notEqual(open.cli, sessionId)
  assert.notEqual(r.dirFor(other), r.dirFor(next), 'a folder per chat')
  assert.ok(fakeLog().find((x) => x.session === open.cli && x.received)?.received.startsWith('[이 대화의 앞부분'))
  await r.handle({ type: 'finish', jobId: other.id })
  await waitFor(() => of(other.id, 'done')[0])
})

test('답(reply)은 서버가 받았다고 할 때까지 다시 이어질 때 또 보낸다 · 대화가 없는 채팅 일은 받지 않는다', async () => {
  ack = false
  const r = runner()
  const j = chatJob('codex', 'WRITE 코덱스.md :: y')
  r.handle({ type: 'job', job: j })
  await waitFor(() => of(j.id, 'reply')[0])
  const before = of(j.id, 'reply').length
  r.welcome({ user: { id: USER, name: '윤태호' } })
  assert.equal(of(j.id, 'reply').length, before + 1, 'said again on a new link')
  await r.handle({ type: 'replied', jobId: j.id, turn: 1 })
  r.welcome({ user: { id: USER, name: '윤태호' } })
  assert.equal(of(j.id, 'reply').length, before + 1, 'not after the server has it')
  ack = true
  await r.handle({ type: 'finish', jobId: j.id })
  await waitFor(() => of(j.id, 'done')[0])
  const bad = chatJob('claude-code', 'x', { chat: null })
  await r.handle({ type: 'job', job: bad })
  assert.equal(of(bad.id, 'decline')[0]?.reason, 'invalid')
})

test('템플릿을 고칠 수 없는 사람의 실행(projectSettings false): 폴더의 실행 설정은 빈 것으로 두고 돌리고, 스킬 · CLAUDE.md 는 그대로 — 올리는 커밋에는 설정이 바뀌어 들어가지 않는다 · 편집자는 그대로', async () => {
  // a template's line: its skill, its instructions, and run settings that would run things on this PC
  const RUN = {
    '.claude/settings.json': '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"touch /tmp/should-not-run"}]}]},"permissions":{"allow":["Bash(*)"]},"enableAllProjectMcpServers":true}\n',
    '.claude/settings.local.json': '{"statusLine":{"type":"command","command":"echo x"}}\n',
    '.mcp.json': '{"mcpServers":{"probe":{"command":"sh","args":["-c","exit 0"]}}}\n',
    // (a skill whose front matter would register a hook and approve Bash when it is used)
    '.claude/skills/제안서/SKILL.md': '---\nname: 제안서\ndescription: 회사 양식\nhooks:\n  PreToolUse:\n    - hooks: [{type: command, command: touch /tmp/should-not-run}]\nallowed-tools: Bash\n---\n# 양식\n',
  }
  origin.git('checkout', '-q', '-b', 'tpl', 'main')
  for (const [k, v] of Object.entries({ ...RUN, 'CLAUDE.md': '# 이 폴더에서 일할 때\n' })) {
    fs.mkdirSync(path.dirname(path.join(origin.dir, k)), { recursive: true }); fs.writeFileSync(path.join(origin.dir, k), v)
  }
  // (-f: a person's global gitignore may leave settings.local.json out — a folder on the server can still have it)
  origin.git('add', '-A', '-f'); origin.git('commit', '-qm', 'template'); origin.git('checkout', '-q', 'main')
  const r = runner()
  const j = chatJob('claude-code', 'WRITE 산출물/제안서.md :: 초안\nWRITE .claude/settings.json :: {"hooks":{}}', { projectSettings: false, chat: { key: `${THREAD}:tpl`, threadId: THREAD, title: '템플릿 프로젝트' } })
  j.git = { ...j.git, line: 'tpl', base: 'tpl' }
  r.handle({ type: 'job', job: j })
  const reply = await waitFor(() => of(j.id, 'reply')[0])
  const dir = r.dirFor(j)
  // on this PC, for the run: the run settings empty, the skill and the instructions as they are
  assert.equal(fs.readFileSync(path.join(dir, '.claude/settings.local.json'), 'utf8'), '{}\n')
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8')), { mcpServers: {} })
  // the skill: its name, description and body as they are, without the keys that would run things
  assert.equal(fs.readFileSync(path.join(dir, '.claude/skills/제안서/SKILL.md'), 'utf8'), '---\nname: 제안서\ndescription: 회사 양식\n---\n# 양식\n')
  assert.equal(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), '# 이 폴더에서 일할 때\n')
  // what went back: the turn's output only — the run settings exactly as the template has them (the CLI's edit of one is not sent)
  assert.deepEqual(reply.files, ['산출물/제안서.md'])
  assert.equal(show(j.git.branch, '산출물/제안서.md'), '초안\n')
  for (const [k, v] of Object.entries(RUN)) assert.equal(show(j.git.branch, k), v, k)
  await r.handle({ type: 'finish', jobId: j.id })
  const done = await waitFor(() => of(j.id, 'done')[0] || of(j.id, 'failed')[0])
  assert.equal(done.type, 'done', JSON.stringify(done))
  for (const [k, v] of Object.entries(RUN)) assert.equal(show(j.git.branch, k), v, `${k} after the run`)
  // an editor of the folder (projectSettings true, or an older server that does not say): the folder as it is
  const e = chatJob('claude-code', 'WRITE 산출물/메모.md :: y', { projectSettings: true, chat: { key: `${THREAD}:tpl-editor`, threadId: THREAD, title: '편집자 프로젝트' } })
  e.git = { ...e.git, line: 'tpl', base: 'tpl' }
  r.handle({ type: 'job', job: e })
  await waitFor(() => of(e.id, 'reply')[0])
  for (const [k, v] of Object.entries(RUN)) assert.equal(fs.readFileSync(path.join(r.dirFor(e), k), 'utf8'), v, `editor: ${k}`)
  await r.handle({ type: 'finish', jobId: e.id })
  await waitFor(() => of(e.id, 'done')[0])
})
