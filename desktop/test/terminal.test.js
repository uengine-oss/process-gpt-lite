'use strict'
// The local runner's main path: the person's interactive CLI in a terminal (src/runner/session.js — node-pty, as agent-share runs it),
// with fake interactive CLIs (test/fixtures/fake-tui.js — raw-mode input, bracketed paste, Claude Code's hooks from --settings and its
// session jsonl, Codex's rollout). What is checked:
//   · the prompt goes in once the CLI says it can take input (SessionStart), the turn's end comes from the CLI (Stop hook · rollout), and
//     the step is then committed and pushed as before
//   · the relayed bytes are the terminal's own bytes (what a web viewer is sent is what the desktop's terminal shows)
//   · the owner's typing reaches the CLI; input on behalf of someone else is ignored here too
//   · a steer (a suggestion the owner loaded and edited) is typed into the CLI and counted as taken from its transcript
//   · the app restarts mid-run: the same CLI session goes on (--resume) in the folder as it was left
//   · a generic session (not a step) relays its hook events and the files of the paths it watches (a repo's aidlc/)
//   · the folder is trusted in Claude Code's config (its own config folder here — never the person's)
// Run: cd desktop && node --test test/terminal.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { Runner } = require('../src/runner/runner')
const P = require('../src/runner/pty')
const { claudeKey } = require('../src/runner/session')
const { gitServer, makeRepo } = require('./helpers/gitServer')
const { fakeBin, systemPath } = require('./helpers/fakeBin')

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pgl-term-'))
// (Windows: a process just stopped may hold a file in it for a moment)
const rmQuiet = (d) => { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) } catch (e) { console.warn(`left ${d}: ${e.code}`) } }
const BIN = fakeBin(path.join(ROOT, 'bin'))
const SEARCH = [BIN, ...systemPath()].join(path.delimiter)
process.env.FAKE_CLI_LOG = path.join(ROOT, 'fake.log')
const ENV = { CLAUDE_CONFIG_DIR: path.join(ROOT, 'claude'), CODEX_HOME: path.join(ROOT, 'codex') }
fs.mkdirSync(ENV.CLAUDE_CONFIG_DIR, { recursive: true })
const TOKEN = `pgf1.${crypto.randomBytes(12).toString('base64url')}.${crypto.randomBytes(16).toString('base64url')}`
const FOLDER = crypto.randomUUID()
const USER = crypto.randomUUID()
let srv, origin
test.before(async () => {
  origin = makeRepo(path.join(ROOT, 'srv', 'f'), { '안내문.md': '# 안내문\n' })
  origin.git('checkout', '-q', '-b', 'inst/t')
  fs.writeFileSync(path.join(origin.dir, '산출물.md'), '앞 단계 결과\n')
  origin.git('add', '-A'); origin.git('commit', '-qm', 'step 1')
  origin.git('checkout', '-q', 'main')
  srv = await gitServer({ repo: origin.dir, token: TOKEN })
})
test.after(async () => { await srv?.close(); rmQuiet(ROOT) })

const sent = []
// the server's side of the link: recorded; an accept is confirmed (the server's 'accepted')
const linkFor = (r) => ({ send: (m) => { sent.push(JSON.parse(JSON.stringify(m))); if (m.type === 'accept') setImmediate(() => r.handle({ type: 'accepted', jobId: m.jobId })); return true } })
const waitFor = async (fn, ms = 20000) => { const t = Date.now(); for (;;) { const v = fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 50)) } }
const of = (id, type) => sent.filter((m) => m.jobId === id && (!type || m.type === type))
const sidOf = (jobId) => sent.find((m) => m.type === 'term-open' && m.ref === jobId)?.sid
const bytesOf = (sid) => sent.filter((m) => m.type === 'pty' && m.sid === sid).map((m) => m.data).join('')
// the text those bytes show (Windows' ConPTY redraws what the CLI wrote: a run of spaces can come as a cursor move)
const screenOf = (bytes) => bytes.replace(/\x1b\[(\d*)C/g, (_, n) => ' '.repeat(Number(n || 1))).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
const fakeLog = () => fs.readFileSync(process.env.FAKE_CLI_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
const dataDir = path.join(ROOT, 'data')
function runner(opts = {}) {
  const r = new Runner({ dataDir, server: srv.base, searchPath: SEARCH, sessionEnv: ENV, settleMs: 600,
    caps: { 'claude-code': { installed: true, runnable: true, version: '9.9.9' }, codex: { installed: true, runnable: true, version: '9.9.9' } }, ...opts })
  r.setLink(linkFor(r))
  r.welcome({ user: { id: USER, name: '김담당' } })
  return r
}
let n = 0
function job(agent, prompt, extra = {}) {
  n++
  return { id: crypto.randomUUID(), todoId: `t${n}`, instId: `inst-t-${n}`, instName: '세미나 견적', activity: `견적서 작성 ${n}`, agent, label: agent === 'codex' ? 'Codex' : 'Claude Code',
    mode: 'complete', lang: 'ko', prompt: `「산출물/0${n}_견적서/」 폴더 안에 두세요.\n${prompt}`, outDir: `산출물/0${n}_견적서`, resultFile: '결과.md',
    person: { id: USER, name: '김담당', email: 'kim@example.test' },
    git: { path: srv.path, token: TOKEN, line: 'inst/t', base: 'inst/t', branch: `pgpt-agent/term-${n}-${Date.now().toString(36)}`, folder: { id: FOLDER, slug: 'f', name: 'f' } }, ...extra }
}
const show = (ref, file) => execFileSync('git', ['show', `${ref}:${file}`], { cwd: origin.dir }).toString()

test('터미널 모듈(node-pty)이 이 런타임에서 뜬다 — 없으면 headless 로 돈다', () => {
  assert.ok(P.load(), P.why())
  assert.equal(runner().interactive(), true)
  assert.equal(runner({ mode: 'headless' }).interactive(), false)
})

test('Claude Code 터미널: 준비되면 프롬프트를 붙여 넣고, Stop 훅으로 끝을 알아 커밋 · 올리기 — 보내는 바이트는 터미널의 바이트 그대로', async () => {
  const r = runner()
  const j = job('claude-code', 'READ 산출물.md\nSLEEP 800\nWRITE_OUT 견적서.md :: 견적 초안')
  await r.handle({ type: 'job', job: j })
  const done = await waitFor(() => of(j.id, 'done')[0] || of(j.id, 'failed')[0])
  assert.equal(done.type, 'done', JSON.stringify(done))
  assert.equal(done.terminal, true)
  assert.deepEqual(done.files.sort(), [`${j.outDir}/결과.md`, `${j.outDir}/견적서.md`].sort())
  assert.match(done.summary, /산출물\.md: 앞 단계 결과/)
  assert.equal(show(j.git.branch, `${j.outDir}/견적서.md`), '견적 초안\n')
  // its own session id, a terminal opened for the step, the PTY's bytes relayed, its hook events relayed (Claude Code's SessionStart · Stop)
  const sid = sidOf(j.id)
  assert.ok(sid)
  const open = sent.find((m) => m.type === 'term-open' && m.sid === sid)
  assert.equal(open.kind, 'step')
  assert.equal(of(j.id, 'session')[0].sessionId, open.cli)
  const bytes = bytesOf(sid)
  assert.match(screenOf(bytes), /Claude Code \(fake\)/)
  // (the fake joins the path the system's way: 산출물\01_견적서\… on Windows)
  assert.match(screenOf(bytes), /Write\(산출물[\\/]01_견적서[\\/]견적서\.md\)/)
  assert.ok(bytes.includes('\x1b[?2004h'), 'the raw bytes, escapes and all')
  const hooks = sent.filter((m) => m.type === 'hook' && m.sid === sid).map((m) => m.event)
  assert.ok(hooks.includes('SessionStart') && hooks.includes('UserPromptSubmit') && hooks.includes('Stop'), hooks.join(','))
  assert.ok(sent.some((m) => m.type === 'term-exit' && m.sid === sid))
  // the prompt went in as a paste once it could take input (its first message is the prompt), and the folder was trusted beforehand
  const log = fakeLog().filter((x) => x.session === open.cli)
  assert.ok(log.find((x) => x.received)?.received.startsWith('「산출물/01_견적서/」'))
  assert.ok(!log.some((x) => x.trustAsked), 'no trust question: the runner marked its folder trusted')
  const conf = JSON.parse(fs.readFileSync(path.join(ENV.CLAUDE_CONFIG_DIR, '.claude.json'), 'utf8'))
  assert.equal(conf.projects[claudeKey(fs.realpathSync(r.dirFor(j)))].hasTrustDialogAccepted, true)
  // the hooks: Claude Code's exec form — a program and its arguments, no shell command line (the same on macOS and Windows)
  const settings = JSON.parse(fs.readFileSync(log[0].args[log[0].args.indexOf('--settings') + 1], 'utf8'))
  for (const ev of ['SessionStart', 'UserPromptSubmit', 'Stop', 'StopFailure', 'Notification']) {
    const h = settings.hooks[ev][0].hooks[0]
    assert.ok(path.isAbsolute(h.command) && Array.isArray(h.args) && h.args.includes(ev), JSON.stringify(h))
  }
  assert.ok(!fakeLog().some((x) => x.hookError), JSON.stringify(fakeLog().filter((x) => x.hookError)))
  // the person's settings stay (no --setting-sources), our hooks come in a session settings file, edits go without asking
  assert.ok(log[0].args.includes('--settings') && log[0].args.includes('--session-id') && !log[0].args.includes('--setting-sources') && !log[0].args.includes('-p'))
  // no token anywhere a CLI or a log sees
  assert.ok(!bytes.includes(TOKEN))
  await r.handle({ type: 'finished', jobId: j.id, state: 'done' })
  assert.equal(r.record(j.id), null, 'the session record goes with the run')
})

test('붙여 넣은 첫 메시지의 Enter 가 사라지면(바쁜 컴퓨터) 자리표시가 입력란에 남은 것을 보고 Enter 를 다시 눌러 턴이 시작된다', async () => {
  process.env.FAKE_TUI_DROP_ENTER = '1'
  try {
    const r = runner()
    const j = job('claude-code', `${'제안서 목차와 참고 자료를 읽고 정리해 주세요. '.repeat(4)}\nWRITE_OUT 메모.md :: 다시 누른 Enter 로 시작`)
    await r.handle({ type: 'job', job: j })
    const done = await waitFor(() => of(j.id, 'done')[0] || of(j.id, 'failed')[0], 30000)
    assert.equal(done.type, 'done', JSON.stringify(done))
    const sid = sidOf(j.id)
    const open = sent.find((m) => m.type === 'term-open' && m.sid === sid)
    const log = fakeLog().filter((x) => x.session === open.cli)
    assert.ok(log.some((x) => x.droppedEnter), 'the first Enter was lost')
    assert.equal(log.filter((x) => x.received).length, 1, 'the message went in once')
    assert.match(screenOf(bytesOf(sid)), /\[Pasted text #1 \+\d+ lines\]/)
    assert.equal(show(j.git.branch, `${j.outDir}/메모.md`), '다시 누른 Enter 로 시작\n')
    await r.handle({ type: 'finished', jobId: j.id, state: 'done' })
  } finally { delete process.env.FAKE_TUI_DROP_ENTER }
})

test('입력은 터미널 주인만: 주인이 친 글은 CLI 에, 다른 사람 이름으로 온 입력은 무시 · 조종(고친 제안)은 붙여 넣어 같은 턴에 반영', async () => {
  const r = runner()
  const j = job('claude-code', 'SLEEP 1500\nSLEEP 1500\nWRITE_OUT 처음.md :: 처음 계획')
  const run = r.handle({ type: 'job', job: j })
  const sid = await waitFor(() => sidOf(j.id))
  await waitFor(() => bytesOf(sid).includes('Working'))
  const cli = sent.find((m) => m.type === 'term-open' && m.sid === sid).cli
  await r.handle({ type: 'pty-input', sid, data: '남의글', byId: crypto.randomUUID() })
  await r.handle({ type: 'pty-input', sid, data: 'WRITE_OUT 직접.md :: 주인이 직접 침', byId: USER })
  await r.handle({ type: 'pty-input', sid, data: '\r', byId: USER })
  await waitFor(() => fakeLog().some((x) => x.session === cli && x.typed === 'WRITE_OUT 직접.md :: 주인이 직접 침'))
  // the owner sends a suggestion they edited (the server says whose it was) — typed in as one paste + Enter
  assert.equal(r.steer(j.id, 's1', 'WRITE_OUT 바뀐방향.md :: 서하린 제안을 고침', '김담당', USER, '서하린'), true)
  await run
  const done = await waitFor(() => of(j.id, 'done')[0] || of(j.id, 'failed')[0])
  assert.equal(done.type, 'done', JSON.stringify(done))
  const log = fakeLog().filter((x) => x.session === cli)
  assert.ok(!log.some((x) => String(x.typed || '').includes('남의글')), 'input on behalf of someone else never reached the CLI')
  assert.ok(log.some((x) => x.received === 'WRITE_OUT 바뀐방향.md :: 서하린 제안을 고침'), JSON.stringify(log.filter((x) => x.received)))
  assert.ok(log.some((x) => x.received === 'WRITE_OUT 직접.md :: 주인이 직접 침'), 'what the owner typed and entered')
  assert.equal(show(j.git.branch, `${j.outDir}/직접.md`), '주인이 직접 침\n')
  assert.deepEqual(of(j.id, 'steered').map((m) => [m.steerId, m.how]), [['s1', 'live']])
  assert.equal(show(j.git.branch, `${j.outDir}/바뀐방향.md`), '서하린 제안을 고침\n')
  const k = done.knowhow.steers.find((s) => s.steerId === 's1')
  assert.equal(k.from, '서하린')
  assert.equal(k.by, '김담당')
  await r.handle({ type: 'finished', jobId: j.id, state: 'done' })
})

test('앱이 실행 중에 다시 켜지면: 같은 CLI 세션(--resume)을 남은 폴더에서 이어서 끝낸다', async () => {
  let r = runner()
  const j = job('claude-code', 'WRITE_OUT 앞부분.md :: 껐다 켜기 전\nSLEEP 6000\nWRITE_OUT 뒷부분.md :: 안 씀')
  r.handle({ type: 'job', job: j })
  const sid = await waitFor(() => sidOf(j.id))
  await waitFor(() => bytesOf(sid).includes('Working'))
  const rec = await waitFor(() => r.record(j.id))
  assert.ok(rec.cli && rec.dir && rec.start)
  // the app quits: the CLI stops; the run is not reported (the server will offer it again)
  r.stop()
  await waitFor(() => sent.some((m) => m.type === 'term-exit' && m.sid === sid))
  await new Promise((res) => setTimeout(res, 300))
  assert.equal(of(j.id, 'done').length + of(j.id, 'failed').length, 0)
  assert.ok(r.record(j.id), 'kept for the next start')
  // the app is back: the server offers the same job with the CLI's session
  r = runner()
  await r.handle({ type: 'job', job: { ...j, resume: { sessionId: rec.cli } } })
  const done = await waitFor(() => of(j.id, 'done')[0] || of(j.id, 'failed')[0], 30000)
  assert.equal(done.type, 'done', JSON.stringify(done))
  const runs = fakeLog().filter((x) => x.session === rec.cli && x.args)
  assert.equal(runs.length, 2)
  assert.deepEqual(runs[1].args.slice(0, 2), ['--resume', rec.cli])
  assert.equal(runs[1].resumed, true)
  assert.ok(fakeLog().some((x) => x.session === rec.cli && /다시 켜져서 같은 세션을 이어서/.test(x.received || '')))
  // what it wrote before the restart is in the result (the folder was not reset)
  assert.equal(show(j.git.branch, `${j.outDir}/앞부분.md`), '껐다 켜기 전\n')
  await r.handle({ type: 'finished', jobId: j.id, state: 'done' })
})

test('Codex 터미널: 첫 메시지는 명령줄로(프롬프트 파일을 가리킴), 끝은 rollout 의 task_complete, 조종은 붙여 넣기', async () => {
  const r = runner()
  const j = job('codex', 'SLEEP 1500\nWRITE_OUT 처음.md :: 코덱스 처음')
  const run = r.handle({ type: 'job', job: j })
  const sid = await waitFor(() => sidOf(j.id))
  await waitFor(() => of(j.id, 'session')[0])
  r.steer(j.id, 's2', 'WRITE_OUT 코덱스방향.md :: 붙여 넣은 방향', '김담당', USER)
  await run
  const done = await waitFor(() => of(j.id, 'done')[0] || of(j.id, 'failed')[0])
  assert.equal(done.type, 'done', JSON.stringify(done))
  assert.deepEqual(of(j.id, 'steered').map((m) => [m.steerId, m.how]), [['s2', 'live']])
  assert.equal(show(j.git.branch, `${j.outDir}/코덱스방향.md`), '붙여 넣은 방향\n')
  const thread = of(j.id, 'session')[0].sessionId
  const first = fakeLog().find((x) => x.session === thread && x.args)
  // trusted for the session on the command line (no config written), the prompt itself not in the arguments
  assert.ok(first.args.some((a) => a.endsWith('trust_level="trusted"')))
  assert.ok(!first.args.some((a) => a.includes('WRITE_OUT')))
  assert.ok(!fakeLog().some((x) => x.session === thread && x.trustAsked))
  assert.match(screenOf(bytesOf(sid)), /OpenAI Codex \(fake\)/)
  await r.handle({ type: 'finished', jobId: j.id, state: 'done' })
})

test('단계가 아닌 세션(개발 저장소): 훅 이벤트와 지켜보는 경로(aidlc/)의 바뀐 파일이 링크로 간다', async () => {
  const r = runner()
  const repo = path.join(dataDir, 'repos', 'dev1')
  fs.mkdirSync(repo, { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: repo })
  const S = r.openSession({ kind: 'dev', ref: 'repo-1', agent: 'claude-code', cwd: repo, prompt: 'WRITE aidlc/질문.md :: 어느 쪽으로 할까요?\nWRITE src/a.js :: x', stateDir: path.join(dataDir, 'sessions', 'dev1'), watch: ['aidlc'] })
  const open = sent.find((m) => m.type === 'term-open' && m.sid === S.id)
  assert.deepEqual([open.kind, open.ref], ['dev', 'repo-1'])
  const files = await waitFor(() => sent.find((m) => m.type === 'files' && m.sid === S.id && m.files.some((f) => f.path === 'aidlc/질문.md')))
  assert.equal(files.files.find((f) => f.path === 'aidlc/질문.md').content, '어느 쪽으로 할까요?\n')
  assert.ok(!sent.some((m) => m.type === 'files' && m.sid === S.id && m.files.some((f) => f.path.startsWith('src/'))), 'only the watched paths')
  await waitFor(() => sent.some((m) => m.type === 'hook' && m.sid === S.id && m.event === 'Stop'))
  const stop = sent.find((m) => m.type === 'hook' && m.sid === S.id && m.event === 'Stop')
  assert.match(stop.data.last_assistant_message, /aidlc\/질문\.md 에 썼어요/)
  assert.ok(!JSON.stringify(stop.data).includes(ROOT), 'no local paths go to the server')
  S.kill()
  await waitFor(() => sent.some((m) => m.type === 'term-exit' && m.sid === S.id))
})
