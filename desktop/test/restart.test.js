'use strict'
// The app restarts while a run of its CLI is on (spec local-agents LA-TERM-RESUME — 2026-11-28: a run that waited for 「끝내기」 had its
// first message pasted again when the desktop app came back, and the CLI did the same request over). With the fake interactive CLIs
// (test/fixtures/fake-tui.js), a git smart-HTTP server and the server's side of the link recorded here. What is checked:
//   · the CLI took the run's first message and its turn ended → the app quits → the server offers the same job (with the CLI's session)
//     → the session goes on (--resume · codex resume) and nothing is pasted: the run waits again for 「끝내기」 (chat · step · Codex)
//   · a chat's turns go on from their number after the restart (the server takes each turn once), a step's note keeps its summary
//   · the CLI never took the first message (the app went off first) → the run starts anew with it, in a new session
//   · the CLI was working → a line that says to finish (not the first message)
//   · the run is still here (its session alive) and the server offers it again → accepted, its terminal announced again, no paste
//   · only words the server added to a chat's message after the CLI took it go in
//   · what goes in first, by the run's record only (firstWords) — a record an older app wrote is read as that app did
// Run: cd desktop && node --test test/restart.test.js
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

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pgl-restart-'))
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
// (every runner made here is stopped at the end: a run a failed check left open would hold the process)
const made = []
test.after(async () => { for (const r of made) r.stop(); await pause(300); await srv?.close(); rmQuiet(ROOT) })

const sent = []
// the server's side of the link: recorded; an accept is confirmed, a reply acknowledged
const linkFor = (r) => ({ send: (m) => {
  sent.push(JSON.parse(JSON.stringify(m)))
  if (m.type === 'accept') setImmediate(() => r.handle({ type: 'accepted', jobId: m.jobId }))
  if (m.type === 'reply') setImmediate(() => r.handle({ type: 'replied', jobId: m.jobId, turn: m.turn }))
  return true
} })
const waitFor = async (fn, ms = 20000) => { const t = Date.now(); for (;;) { const v = fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 50)) } }
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
const of = (id, type) => sent.filter((m) => m.jobId === id && (!type || m.type === type))
const fakeLog = () => (fs.existsSync(process.env.FAKE_CLI_LOG) ? fs.readFileSync(process.env.FAKE_CLI_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [])
// what the CLI of a session took as messages (each one a paste + Enter — or Codex's first message from its command line)
const took = (cli) => fakeLog().filter((x) => x.session === cli && x.received).map((x) => x.received)
const starts = (cli) => fakeLog().filter((x) => x.session === cli && x.args)
const opens = (jobId) => sent.filter((m) => m.type === 'term-open' && m.ref === jobId)
const show = (ref, file) => execFileSync('git', ['show', `${ref}:${file}`], { cwd: origin.dir }).toString()
const dataDir = path.join(ROOT, 'data')
function runner(opts = {}) {
  const r = new Runner({ dataDir, server: srv.base, searchPath: SEARCH, sessionEnv: ENV, settleMs: 60_000,
    caps: { 'claude-code': { installed: true, runnable: true, version: '9.9.9' }, codex: { installed: true, runnable: true, version: '9.9.9' } }, ...opts })
  r.setLink(linkFor(r))
  r.welcome({ user: { id: USER, name: '윤태호' } })
  made.push(r)
  return r
}
let n = 0
const git = () => ({ path: srv.path, token: TOKEN, line: 'main', base: 'main', branch: `pgpt-agent/local-restart${n}-${Date.now().toString(36)}`, folder: { id: FOLDER, slug: 'f', name: '내 PC 에이전트 작업' } })
function chatJob(agent, message, extra = {}) {
  n++
  return { kind: 'chat', id: crypto.randomUUID(), todoId: `chat:${n}`, instId: null, instName: '', activity: '메인 채팅', agent, label: agent === 'codex' ? 'Codex' : 'Claude Code',
    mode: 'complete', lang: 'ko', prompt: `[이 대화의 앞부분 — 최근 1개]\n- 나: 안녕\n\n[윤태호 님의 메시지]\n${message}`, message, person: { id: USER, name: '윤태호', email: 'yoon@example.test' },
    skills: [], chat: { key: `${THREAD}:restart-${n}`, threadId: THREAD, title: '메인 채팅' }, git: git(), ...extra }
}
function stepJob(agent, work) {
  n++
  return { id: crypto.randomUUID(), todoId: `t${n}`, instId: `inst-restart-${n}`, instName: '가나정밀 세미나 견적', activity: `견적서 초안 ${n}`, agent, label: 'Claude Code',
    mode: 'complete', lang: 'ko', prompt: `「산출물/0${n}_견적서/」 폴더 안에 두세요.\n${work}`, outDir: `산출물/0${n}_견적서`, resultFile: '결과.md',
    person: { id: USER, name: '윤태호', email: 'yoon@example.test' }, skills: [], git: git() }
}
// the app quits: its CLIs stop, the runs are not reported (the server offers them again)
async function quit(r, jobId) {
  const sids = opens(jobId).map((m) => m.sid)
  r.stop()
  await waitFor(() => sids.every((sid) => sent.some((m) => m.type === 'term-exit' && m.sid === sid)))
  await pause(300)
  assert.equal(of(jobId, 'done').length + of(jobId, 'failed').length, 0, 'not reported')
}
// the run came back and the CLI can take input (SessionStart · Codex at once): it waits again (idle, said after the restart) — then
// long enough for a paste to have landed
async function settledBack(jobId, cli, runsBefore, from) {
  await waitFor(() => starts(cli).length > runsBefore)
  const sid = await waitFor(() => opens(jobId).length > 1 && opens(jobId).at(-1).sid)
  await waitFor(() => sent.slice(from).some((m) => m.type === 'idle' && m.jobId === jobId && m.until))
  await pause(1200)
  return sid
}
// the same job offered again after the restart, with the CLI's session — and the run's line as the server has it then: each turn's
// branch was brought onto the chat's line there (chat.js bringIn), so the run goes on from it
const again = (j, cli, extra = {}) => ({ ...j, git: j.kind === 'chat' ? { ...j.git, line: j.git.branch, base: j.git.branch } : j.git, resume: { sessionId: cli }, ...extra })

test('LA-TERM-RESUME-01 채팅: 첫 말을 받은 CLI 의 턴이 끝나 「끝내기」를 기다리던 중 앱이 다시 켜지면, 같은 세션에 붙기만 하고 아무것도 붙여 넣지 않는다 — 다음 말의 턴 번호는 이어진다', async () => {
  const r1 = runner()
  const j = chatJob('claude-code', 'WRITE 회의록.md :: 안건 1. 예산')
  r1.handle({ type: 'job', job: j })
  const reply = await waitFor(() => of(j.id, 'reply')[0])
  assert.equal(reply.turn, 1)
  await waitFor(() => of(j.id, 'idle').some((m) => m.until))
  const cli = opens(j.id)[0].cli
  assert.deepEqual(took(cli).length, 1)
  const rec = r1.record(j.id)
  await quit(r1, j.id)
  // the app is back: the server offers the same job, with the CLI's session (its own — the run was going)
  const r2 = runner()
  const from = sent.length
  r2.handle({ type: 'job', job: again(j, cli) })
  await settledBack(j.id, cli, 1, from)
  const runs = starts(cli)
  assert.equal(runs.length, 2)
  assert.deepEqual(runs[1].args.slice(0, 2), ['--resume', cli])
  assert.equal(took(cli).length, 1, 'nothing pasted again')
  assert.ok(!fakeLog().some((x) => x.session === cli && x.typed), 'nothing typed')
  // it waits for 「끝내기」 again; the person's next words go into the same session, as turn 2 (turn 1 is the server's already)
  assert.equal(r2.steer(j.id, 's1', 'WRITE 할일.md :: 견적서 보내기', '윤태호', USER), true)
  const second = await waitFor(() => of(j.id, 'reply').find((m) => m.turn === 2))
  assert.deepEqual(second.files, ['할일.md'])
  assert.equal(of(j.id, 'reply').filter((m) => m.turn === 1).length, 1, 'no second turn 1')
  assert.deepEqual(took(cli), ['[이 대화의 앞부분 — 최근 1개]\n- 나: 안녕\n\n[윤태호 님의 메시지]\nWRITE 회의록.md :: 안건 1. 예산', 'WRITE 할일.md :: 견적서 보내기'])
  await r2.handle({ type: 'finish', jobId: j.id })
  const done = await waitFor(() => of(j.id, 'done')[0] || of(j.id, 'failed')[0])
  assert.equal(done.type, 'done', JSON.stringify(done))
  assert.equal(done.sessionId, cli)
  assert.equal(show(j.git.branch, '회의록.md'), '안건 1. 예산\n')
  // what the judgment came from — the run's record before the restart: the CLI took the first message, its turn ended, one turn so far
  assert.equal(rec.cli, cli)
  assert.equal(rec.given, true)
  assert.equal(rec.turn, 'ended')
  assert.equal(rec.turns, 1)
  await r2.handle({ type: 'finished', jobId: j.id, state: 'done', line: 'main' })
})

test('LA-TERM-RESUME-02 단계: 턴이 끝난 뒤 앱이 다시 켜지면 붙여 넣지 않고 다시 기다린다 — 「끝내기」로 끝나고 결과.md 에는 꺼지기 전의 요약이 그대로', async () => {
  const r1 = runner()
  const j = stepJob('claude-code', 'WRITE_OUT 초안.md :: 첫 초안')
  r1.handle({ type: 'job', job: j })
  await waitFor(() => of(j.id, 'idle').some((m) => m.until))
  const cli = opens(j.id)[0].cli
  assert.equal(took(cli).length, 1)
  const rec = r1.record(j.id)
  await quit(r1, j.id)
  const r2 = runner()
  const from = sent.length
  r2.handle({ type: 'job', job: again(j, cli) })
  await settledBack(j.id, cli, 1, from)
  assert.equal(took(cli).length, 1, 'nothing pasted again — not the step prompt, not 「하던 일을 마저 끝내세요」')
  await r2.handle({ type: 'finish', jobId: j.id })
  const done = await waitFor(() => of(j.id, 'done')[0] || of(j.id, 'failed')[0])
  assert.equal(done.type, 'done', JSON.stringify(done))
  assert.deepEqual(done.files.sort(), [`${j.outDir}/결과.md`, `${j.outDir}/초안.md`].sort())
  assert.match(done.summary, /초안\.md 에 썼어요/)
  assert.match(show(j.git.branch, `${j.outDir}/결과.md`), /초안\.md 에 썼어요/)
  assert.equal(show(j.git.branch, `${j.outDir}/초안.md`), '첫 초안\n')
  assert.equal(rec.turn, 'ended')
  await r2.handle({ type: 'finished', jobId: j.id, state: 'done' })
  assert.equal(r2.record(j.id), null, 'the record goes with the run')
})

test('LA-TERM-RESUME-03 Codex 채팅: 턴이 끝난 뒤 다시 켜지면 `codex resume <세션>` 만 — 명령줄에 첫 메시지(프롬프트 파일)를 다시 주지 않는다', async () => {
  const r1 = runner()
  const j = chatJob('codex', 'WRITE 코덱스.md :: 한 번만')
  r1.handle({ type: 'job', job: j })
  await waitFor(() => of(j.id, 'reply')[0])
  await waitFor(() => of(j.id, 'idle').some((m) => m.until))
  const cli = of(j.id, 'session')[0].sessionId
  assert.equal(took(cli).length, 1)
  await quit(r1, j.id)
  const r2 = runner()
  const from = sent.length
  r2.handle({ type: 'job', job: again(j, cli) })
  await settledBack(j.id, cli, 1, from)
  const back = starts(cli)[1]
  assert.deepEqual(back.args.slice(0, 2), ['resume', cli])
  assert.ok(!back.args.some((a) => a.includes('.pgl-run/prompt.md')), JSON.stringify(back.args))
  assert.equal(took(cli).length, 1, 'nothing given again')
  await r2.handle({ type: 'finish', jobId: j.id })
  const done = await waitFor(() => of(j.id, 'done')[0] || of(j.id, 'failed')[0])
  assert.equal(done.type, 'done', JSON.stringify(done))
  await r2.handle({ type: 'finished', jobId: j.id, state: 'done', line: 'main' })
})

test('LA-TERM-RESUME-04 CLI 가 첫 말을 받지 못한 채(Enter 가 모두 사라짐) 앱이 꺼졌으면: 다시 켜진 뒤 새 실행처럼 새 세션에 첫 말을 한 번 넣는다', async () => {
  process.env.FAKE_TUI_DROP_ENTER = '20'
  let r1
  let j
  let cli
  let rec
  try {
    r1 = runner()
    j = chatJob('claude-code', 'WRITE 첫말.md :: 늦게라도 한 번')
    r1.handle({ type: 'job', job: j })
    cli = await waitFor(() => opens(j.id)[0]?.cli)
    await waitFor(() => fakeLog().some((x) => x.session === cli && x.droppedEnter))
    assert.equal(took(cli).length, 0)
    rec = r1.record(j.id)
    await quit(r1, j.id)
  } finally { delete process.env.FAKE_TUI_DROP_ENTER }
  const r2 = runner()
  // (no turn of it was pushed: its line is as it was)
  r2.handle({ type: 'job', job: { ...j, resume: { sessionId: cli } } })
  const reply = await waitFor(() => of(j.id, 'reply')[0])
  assert.equal(reply.turn, 1)
  assert.deepEqual(reply.files, ['첫말.md'])
  const fresh = opens(j.id).at(-1).cli
  assert.notEqual(fresh, cli, 'a new session')
  assert.ok(starts(fresh)[0].args.includes('--session-id'))
  assert.equal(starts(cli).length, 1, 'the session that never took it is not resumed')
  assert.deepEqual(took(fresh).length, 1)
  assert.ok(took(fresh)[0].startsWith('[이 대화의 앞부분'), 'its first message, as a run that starts now')
  assert.equal(rec.given, false, 'the record said the CLI never took it')
  await r2.handle({ type: 'finish', jobId: j.id })
  await waitFor(() => of(j.id, 'done')[0])
  await r2.handle({ type: 'finished', jobId: j.id, state: 'done', line: 'main' })
})

test('LA-TERM-RESUME-05 CLI 가 일하던 중에 앱이 꺼졌으면: 같은 세션에 「하던 일을 마저 끝내세요」 한 줄 — 첫 말은 다시 넣지 않는다', async () => {
  const r1 = runner()
  const j = chatJob('claude-code', 'SLEEP 6000\nWRITE 늦은.md :: 안 씀')
  r1.handle({ type: 'job', job: j })
  const open = await waitFor(() => opens(j.id)[0])
  const cli = open.cli
  await waitFor(() => sent.some((m) => m.type === 'hook' && m.sid === open.sid && m.event === 'UserPromptSubmit'))
  await waitFor(() => sent.some((m) => m.type === 'pty' && m.sid === open.sid && m.data.includes('Working')))
  const rec = r1.record(j.id)
  await quit(r1, j.id)
  const r2 = runner()
  // (no turn of it was pushed: its line is as it was)
  r2.handle({ type: 'job', job: { ...j, resume: { sessionId: cli } } })
  const reply = await waitFor(() => of(j.id, 'reply')[0])
  assert.equal(reply.turn, 1)
  const words = took(cli)
  assert.equal(words.length, 2)
  assert.match(words[1], /다시 켜져서 같은 세션을 이어서 해요\. 하던 일을 마저 끝내세요\./)
  assert.equal(words.filter((w) => w.includes('SLEEP 6000')).length, 1, 'the first message went in once')
  assert.equal(rec.turn, 'working')
  await r2.handle({ type: 'finish', jobId: j.id })
  await waitFor(() => of(j.id, 'done')[0])
  await r2.handle({ type: 'finished', jobId: j.id, state: 'done', line: 'main' })
})

test('LA-TERM-RESUME-06 실행이 이 앱에 살아 있는데 서버가 같은 일을 다시 건네면: 그 세션에 그대로 붙는다(받음 · 터미널 다시 알림) — CLI 를 새로 띄우지도, 붙여 넣지도 않는다', async () => {
  const r = runner()
  const j = chatJob('claude-code', 'WRITE 살아있음.md :: 그대로')
  r.handle({ type: 'job', job: j })
  await waitFor(() => of(j.id, 'reply')[0])
  await waitFor(() => of(j.id, 'idle').some((m) => m.until))
  const open = opens(j.id)[0]
  const accepts = of(j.id, 'accept').length
  await r.handle({ type: 'job', job: { ...j, resume: { sessionId: open.cli } } })
  assert.equal(of(j.id, 'accept').length, accepts + 1, 'it is this desktop\'s again')
  const reopen = opens(j.id).at(-1)
  assert.equal(opens(j.id).length, 2)
  assert.equal(reopen.sid, open.sid, 'the same terminal')
  assert.match(reopen.replay, /Claude Code \(fake\)/, 'with the screen so far')
  assert.ok(of(j.id, 'idle').at(-1).until, 'and its wait')
  await pause(800)
  assert.equal(starts(open.cli).length, 1, 'no CLI started again')
  assert.equal(took(open.cli).length, 1, 'nothing pasted')
  await r.handle({ type: 'finish', jobId: j.id })
  const done = await waitFor(() => of(j.id, 'done')[0] || of(j.id, 'failed')[0])
  assert.equal(done.type, 'done', JSON.stringify(done))
  await r.handle({ type: 'finished', jobId: j.id, state: 'done', line: 'main' })
})

test('LA-TERM-RESUME-07 다시 켜진 사이 서버가 채팅 메시지에 덧붙인 말이 있으면 그 말만 넣는다', async () => {
  const r1 = runner()
  const j = chatJob('claude-code', 'WRITE 처음.md :: 처음 말')
  r1.handle({ type: 'job', job: j })
  await waitFor(() => of(j.id, 'reply')[0])
  await waitFor(() => of(j.id, 'idle').some((m) => m.until))
  const cli = opens(j.id)[0].cli
  await quit(r1, j.id)
  // (the run waited in the server's queue meanwhile, and the person sent more: the server added it to the run's message — chat.js send)
  const more = 'WRITE 추가.md :: 덧붙인 말'
  const r2 = runner()
  r2.handle({ type: 'job', job: again(j, cli, { message: `${j.message}\n\n${more}`, prompt: `${j.prompt}\n\n${more}` }) })
  const second = await waitFor(() => of(j.id, 'reply').find((m) => m.turn === 2))
  assert.deepEqual(second.files, ['추가.md'])
  assert.deepEqual(took(cli).slice(1), [more], 'only the words added')
  await r2.handle({ type: 'finish', jobId: j.id })
  await waitFor(() => of(j.id, 'done')[0])
  await r2.handle({ type: 'finished', jobId: j.id, state: 'done', line: 'main' })
})

test('LA-TERM-RESUME-08 무엇을 먼저 넣나: 실행 기록으로만 정한다(말의 뜻을 읽지 않음) — 이전 앱이 쓴 기록은 그 앱처럼', () => {
  const r = new Runner({ dataDir: path.join(ROOT, 'unit'), server: 'http://127.0.0.1:1' })
  const GO_ON = '이 앱이 다시 켜져서 같은 세션을 이어서 해요. 하던 일을 마저 끝내세요.'
  const chat = { kind: 'chat', lang: 'ko', prompt: '[앞부분]\n\n[메시지]\n견적서 정리해 줘', message: '견적서 정리해 줘' }
  const step = { lang: 'ko', prompt: '단계 프롬프트' }
  const mark = (s) => ({ n: s.length, h: crypto.createHash('sha1').update(s).digest('hex').slice(0, 16) })
  const first = (job, from) => r.firstWords({ job, resumeFrom: from })
  // a run that starts · the chat's next run in the chat's session (not this run's own record)
  assert.deepEqual(first(chat, null), { prompt: chat.prompt, wait: false })
  assert.deepEqual(first(step, null), { prompt: step.prompt, wait: false })
  assert.deepEqual(first(chat, { cli: 'c', own: false }), { prompt: chat.message, wait: false })
  // a record an older app wrote (no given): as it did
  assert.deepEqual(first(chat, { cli: 'c', own: true }), { prompt: chat.message, wait: false })
  assert.deepEqual(first(step, { cli: 'c', own: true }), { prompt: GO_ON, wait: false })
  // the CLI never took the first message (a session that went on from the chat's earlier one)
  assert.deepEqual(first(chat, { cli: 'c', own: true, given: false, resumed: true }), { prompt: chat.message, wait: false })
  // it was working · its turn had ended
  assert.deepEqual(first(chat, { cli: 'c', own: true, given: true, turn: 'working', msg: mark(chat.message) }), { prompt: GO_ON, wait: false })
  assert.deepEqual(first(step, { cli: 'c', own: true, given: true, turn: 'working' }), { prompt: GO_ON, wait: false })
  assert.deepEqual(first(chat, { cli: 'c', own: true, given: true, turn: 'ended', msg: mark(chat.message) }), { prompt: '', wait: true })
  assert.deepEqual(first(step, { cli: 'c', own: true, given: true, turn: 'ended' }), { prompt: '', wait: true })
  // words added after the message the CLI took: only those · a message that does not begin with the one taken: nothing
  assert.deepEqual(first({ ...chat, message: `${chat.message}\n\n목차도 넣어 줘` }, { cli: 'c', own: true, given: true, turn: 'ended', msg: mark(chat.message) }), { prompt: '목차도 넣어 줘', wait: false })
  assert.deepEqual(first({ ...chat, message: '다른 말이 훨씬 더 길게 들어온 경우' }, { cli: 'c', own: true, given: true, turn: 'ended', msg: mark(chat.message) }), { prompt: '', wait: true })
  // English
  assert.equal(first({ ...step, lang: 'en' }, { cli: 'c', own: true, given: true, turn: 'working' }).prompt, 'This app was restarted and this session goes on. Finish the work you were doing.')
})
