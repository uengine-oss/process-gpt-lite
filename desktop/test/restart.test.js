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
//   · a Codex chat run that resumes the chat's earlier session keeps its record too (and its resumed rollout's new message is seen)
//   · a chat turn's answer the server did not get — made, or not made yet — is said (made) again after the restart
//   · a chat cut off mid-turn keeps its folder (what the turn wrote stays) · the record says not taken but the CLI's own record has the
//     message → the same session goes on · a failed run's record goes, old records are swept · words added to a live run go in
//   · a template run keeps its left-off files out of its commits after a restart · a week-old record keeps what the run needs to go on
//   · only the run's first message counts in the CLI's record (not a /command) · unconfirmed answers go before the report · a folder another
//     run used meanwhile is brought back to the line, and the CLI is told
// Run: cd desktop && node --test test/restart.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { Runner } = require('../src/runner/runner')
const { tookFirst } = require('../src/runner/session')
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
  // (its own new session, kept because the CLI's record changed under it: the whole prompt, as it was given)
  assert.deepEqual(first(chat, { cli: 'c', own: true, given: false, resumed: false, keepSession: true }), { prompt: chat.prompt, wait: false })
  // it was working · its turn had ended
  assert.deepEqual(first(chat, { cli: 'c', own: true, given: true, turn: 'working', msg: mark(chat.message) }), { prompt: GO_ON, wait: false })
  assert.deepEqual(first(step, { cli: 'c', own: true, given: true, turn: 'working' }), { prompt: GO_ON, wait: false })
  assert.deepEqual(first(chat, { cli: 'c', own: true, given: true, turn: 'ended', msg: mark(chat.message) }), { prompt: '', wait: true })
  assert.deepEqual(first(step, { cli: 'c', own: true, given: true, turn: 'ended' }), { prompt: '', wait: true })
  // words added after the message the CLI took: only those · a message that does not begin with the one taken: nothing
  assert.deepEqual(first({ ...chat, message: `${chat.message}\n\n목차도 넣어 줘` }, { cli: 'c', own: true, given: true, turn: 'ended', msg: mark(chat.message) }), { prompt: '목차도 넣어 줘', wait: false })
  assert.deepEqual(first({ ...chat, message: '다른 말이 훨씬 더 길게 들어온 경우' }, { cli: 'c', own: true, given: true, turn: 'ended', msg: mark(chat.message) }), { prompt: '', wait: true })
  // it was working and the server added words meanwhile: the line to finish, then those words
  assert.deepEqual(first({ ...chat, message: `${chat.message}\n\n목차도 넣어 줘` }, { cli: 'c', own: true, given: true, turn: 'working', msg: mark(chat.message) }), { prompt: `${GO_ON}\n\n목차도 넣어 줘`, wait: false })
  // an empty message taken is no mark: what comes later is not told apart from it — nothing
  assert.deepEqual(first({ ...chat, message: '\n\n뒤에 온 말' }, { cli: 'c', own: true, given: true, turn: 'ended', msg: undefined }), { prompt: '', wait: true })
  assert.deepEqual(first({ ...chat, message: '\n\n뒤에 온 말' }, { cli: 'c', own: true, given: true, turn: 'ended', msg: { n: 0, h: mark('').h } }), { prompt: '', wait: true })
  // English
  assert.equal(first({ ...step, lang: 'en' }, { cli: 'c', own: true, given: true, turn: 'working' }).prompt, 'This app was restarted and this session goes on. Finish the work you were doing.')
})

test('LA-TERM-RESUME-09 Codex 채팅의 다음 메시지(채팅의 앞 세션을 이음): 세션을 서버에 알리고 실행 기록을 남긴다 — 기다리던 중 다시 켜져도 그 메시지를 다시 주지 않고 턴 번호가 이어진다', async () => {
  const r1 = runner()
  const j1 = chatJob('codex', 'WRITE 첫째.md :: 하나')
  r1.handle({ type: 'job', job: j1 })
  await waitFor(() => of(j1.id, 'reply')[0])
  const S1 = of(j1.id, 'session')[0].sessionId
  await r1.handle({ type: 'finish', jobId: j1.id })
  await waitFor(() => of(j1.id, 'done')[0])
  await r1.handle({ type: 'finished', jobId: j1.id, state: 'done', line: 'main' })
  // the chat's next message: a new run that resumes the chat's session (the server's resumeOf), from the line the first run's turn went to
  const j2 = { ...chatJob('codex', 'WRITE 둘째.md :: 둘'), chat: j1.chat, resume: { sessionId: S1 } }
  j2.git = { ...j2.git, line: j1.git.branch, base: j1.git.branch }
  r1.handle({ type: 'job', job: j2 })
  // (Codex takes it from its command line at once — before the runner's first look at the resumed rollout: it is seen all the same)
  const reply = await waitFor(() => of(j2.id, 'reply')[0])
  assert.equal(reply.turn, 1)
  assert.deepEqual(reply.files, ['둘째.md'])
  await waitFor(() => of(j2.id, 'idle').some((m) => m.until))
  assert.equal(of(j2.id, 'session')[0]?.sessionId, S1, 'the server hears which session the run goes on with')
  const rec = r1.record(j2.id)
  const before = took(S1).length
  assert.equal(before, 2)
  await quit(r1, j2.id)
  const r2 = runner()
  const from = sent.length
  r2.handle({ type: 'job', job: again(j2, S1) })
  await settledBack(j2.id, S1, 2, from)
  assert.equal(took(S1).length, before, 'the message is not given again')
  assert.ok(!starts(S1)[2].args.some((a) => a.includes('.pgl-run/prompt.md')), JSON.stringify(starts(S1)[2].args))
  // its next words: turn 2 (turn 1 is the server's already)
  assert.equal(r2.steer(j2.id, 's9', 'WRITE 셋째.md :: 셋', '윤태호', USER), true)
  const second = await waitFor(() => of(j2.id, 'reply').find((m) => m.turn === 2))
  assert.deepEqual(second.files, ['셋째.md'])
  await r2.handle({ type: 'finish', jobId: j2.id })
  const done = await waitFor(() => of(j2.id, 'done')[0] || of(j2.id, 'failed')[0])
  assert.equal(done.type, 'done', JSON.stringify(done))
  assert.equal(rec?.cli, S1)
  assert.equal(rec.given, true)
  assert.equal(rec.turns, 1)
  await r2.handle({ type: 'finished', jobId: j2.id, state: 'done', line: 'main' })
})

test('LA-TERM-RESUME-10 턴의 답이 서버에 닿기 전에 앱이 꺼지면: 실행 기록에 남은 그 답을 다시 켠 뒤 보낸다', async () => {
  const r1 = runner()
  const base = linkFor(r1)
  // (the link took nothing of the answer: it went down right at the turn's end)
  r1.setLink({ send: (m) => (m.type === 'reply' ? false : base.send(m)) })
  const j = chatJob('claude-code', 'WRITE 답.md :: 잃지 않음')
  r1.handle({ type: 'job', job: j })
  await waitFor(() => of(j.id, 'idle').some((m) => m.until))
  await waitFor(() => r1.record(j.id)?.replies?.some((x) => x.type === 'reply' && x.turn === 1))
  assert.equal(of(j.id, 'reply').length, 0, 'the server has no answer')
  const cli = opens(j.id)[0].cli
  await quit(r1, j.id)
  const r2 = runner()
  r2.handle({ type: 'job', job: again(j, cli) })
  const reply = await waitFor(() => of(j.id, 'reply')[0])
  assert.equal(reply.turn, 1)
  assert.deepEqual(reply.files, ['답.md'])
  assert.match(reply.text, /답\.md 에 썼어요/)
  // (the server has it: the record no longer keeps it)
  await waitFor(() => r2.record(j.id) && !r2.record(j.id).replies)
  assert.equal(took(cli).length, 1, 'nothing pasted')
  await r2.handle({ type: 'finish', jobId: j.id })
  const done = await waitFor(() => of(j.id, 'done')[0] || of(j.id, 'failed')[0])
  assert.equal(done.type, 'done', JSON.stringify(done))
  await r2.handle({ type: 'finished', jobId: j.id, state: 'done', line: 'main' })
})

test('LA-TERM-RESUME-11 턴이 끝났는데 답을 만들기 전에(커밋을 올리기 전) 앱이 꺼지면: 다시 켠 뒤 그 턴의 파일을 커밋해 올리고 그 턴의 답을 보낸다', async () => {
  const r1 = runner()
  const j = chatJob('claude-code', 'WRITE 먼저.md :: 첫 턴')
  r1.handle({ type: 'job', job: j })
  await waitFor(() => of(j.id, 'reply')[0])
  await waitFor(() => of(j.id, 'idle').some((m) => m.until))
  const cli = opens(j.id)[0].cli
  await quit(r1, j.id)
  // what the app left when it went off right after the CLI's second turn ended: the turn in the record, its answer not made — one of its
  // files committed here but not pushed, another not committed yet
  const dir = r1.dirFor(j)
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim()
  fs.writeFileSync(path.join(dir, '나중.md'), '둘째 턴\n')
  execFileSync('git', ['add', '나중.md'], { cwd: dir })
  execFileSync('git', ['-c', 'user.name=시험', '-c', 'user.email=t@example.test', 'commit', '-qm', 'turn 2'], { cwd: dir })
  fs.writeFileSync(path.join(dir, '또.md'), '커밋 전\n')
  const rec = r1.record(j.id)
  r1.remember(j.id, { ...rec, turns: 2, replies: [{ turn: 2, text: '요약: 나중.md · 또.md 에 썼어요', before: head }] })
  const r2 = runner()
  r2.handle({ type: 'job', job: again(j, cli) })
  const second = await waitFor(() => of(j.id, 'reply').find((m) => m.turn === 2))
  assert.deepEqual(second.files.sort(), ['나중.md', '또.md'])
  assert.equal(second.pushed, true)
  assert.equal(second.text, '요약: 나중.md · 또.md 에 썼어요')
  assert.equal(show(j.git.branch, '나중.md'), '둘째 턴\n')
  assert.equal(show(j.git.branch, '또.md'), '커밋 전\n')
  assert.equal(of(j.id, 'reply').filter((m) => m.turn === 1).length, 1, 'turn 1 was the server\'s already')
  assert.equal(took(cli).length, 1, 'nothing pasted')
  await r2.handle({ type: 'finish', jobId: j.id })
  const done = await waitFor(() => of(j.id, 'done')[0] || of(j.id, 'failed')[0])
  assert.equal(done.type, 'done', JSON.stringify(done))
  await r2.handle({ type: 'finished', jobId: j.id, state: 'done', line: 'main' })
})

test('LA-TERM-RESUME-12 채팅이 일하던 중에 앱이 꺼지면: 작업 폴더를 그대로 두고(그 턴이 이미 쓴 파일이 남음) 같은 세션에 「마저 끝내세요」 — 그 파일은 턴의 답과 함께 간다', async () => {
  const r1 = runner()
  const j = chatJob('claude-code', 'WRITE 앞.md :: 먼저\nSLEEP 6000\nWRITE 뒤.md :: 나중')
  r1.handle({ type: 'job', job: j })
  const open = await waitFor(() => opens(j.id)[0])
  const dir = r1.dirFor(j)
  await waitFor(() => fs.existsSync(path.join(dir, '앞.md')))
  await waitFor(() => r1.record(j.id)?.turn === 'working')
  await quit(r1, j.id)
  const r2 = runner()
  // (no turn of it was pushed: its line is as it was)
  r2.handle({ type: 'job', job: { ...j, resume: { sessionId: open.cli } } })
  await waitFor(() => took(open.cli).length >= 2)
  assert.match(took(open.cli)[1], /하던 일을 마저 끝내세요/)
  assert.equal(fs.readFileSync(path.join(dir, '앞.md'), 'utf8'), '먼저\n', 'what the turn wrote is still there')
  const reply = await waitFor(() => of(j.id, 'reply')[0])
  assert.deepEqual(reply.files, ['앞.md'])
  await r2.handle({ type: 'finish', jobId: j.id })
  const done = await waitFor(() => of(j.id, 'done')[0] || of(j.id, 'failed')[0])
  assert.equal(done.type, 'done', JSON.stringify(done))
  assert.equal(show(j.git.branch, '앞.md'), '먼저\n')
  await r2.handle({ type: 'finished', jobId: j.id, state: 'done', line: 'main' })
})

test('LA-TERM-RESUME-13 실행 기록에는 받았다는 표시가 없어도 CLI 자신의 기록에 그 메시지가 있으면(훅을 읽기 전에 꺼짐): 새로 시작하지 않고 같은 세션에 「마저 끝내세요」', async () => {
  const r1 = runner()
  const j = chatJob('claude-code', 'SLEEP 4000\nWRITE 훅.md :: 늦게 읽힌 훅')
  r1.handle({ type: 'job', job: j })
  const open = await waitFor(() => opens(j.id)[0])
  await waitFor(() => r1.record(j.id)?.turn === 'working')
  await quit(r1, j.id)
  // (as the app leaves it when it goes off after the CLI took the message and before its hook was read)
  const rec = r1.record(j.id)
  assert.equal(rec.txFrom, 0)
  r1.remember(j.id, { ...rec, given: false, turn: undefined })
  const r2 = runner()
  r2.handle({ type: 'job', job: { ...j, resume: { sessionId: open.cli } } })
  await waitFor(() => took(open.cli).length >= 2)
  assert.equal(starts(open.cli).length, 2, 'the same session went on')
  assert.deepEqual(starts(open.cli)[1].args.slice(0, 2), ['--resume', open.cli])
  assert.match(took(open.cli)[1], /하던 일을 마저 끝내세요/)
  assert.equal(took(open.cli).filter((w) => w.includes('SLEEP 4000')).length, 1, 'the first message went in once')
  await waitFor(() => of(j.id, 'reply')[0])
  await r2.handle({ type: 'finish', jobId: j.id })
  await waitFor(() => of(j.id, 'done')[0])
  await r2.handle({ type: 'finished', jobId: j.id, state: 'done', line: 'main' })
})

test('LA-TERM-RESUME-14 실패한 실행의 기록은 지운다 · 7일 넘게 아무것도 쓰지 않은 실행 기록은 이어 가는 데 필요한 것만 남기고(CLI 의 말은 지움) 세션 폴더는 지우며, 90일이 지나면 기록도 지운다(채팅의 세션 기록은 둔다) · 기록은 통째로만 쓴다', async () => {
  const r = runner()
  const j = chatJob('claude-code', 'WRITE 실패전.md :: x\nFAIL 일부러 실패')
  r.handle({ type: 'job', job: j })
  const failed = await waitFor(() => of(j.id, 'failed')[0])
  assert.match(failed.error, /일부러 실패/)
  assert.equal(r.record(j.id), null, 'the failed run\'s record went')
  await r.handle({ type: 'finished', jobId: j.id, state: 'failed' })
  const sdir = path.join(dataDir, 'sessions')
  assert.ok(!fs.readdirSync(sdir).some((x) => x.endsWith('.tmp')), 'no half-written file left beside a record')
  // the app starts with a record nothing wrote for 8 days, one for 91 days, one of today, a chat's own record
  const old = crypto.randomUUID()
  const older = crypto.randomUUID()
  const fresh = crypto.randomUUID()
  fs.writeFileSync(path.join(sdir, `${old}.json`), JSON.stringify({ cli: 'x', agent: 'claude-code', dir: '/w', start: 'a'.repeat(40), given: true, turn: 'ended', turns: 2,
    summary: '오래된 마지막 말', msg: { n: 3, h: 'abc' }, replies: [{ turn: 2, text: '확인받지 못한 답' }] }))
  fs.writeFileSync(path.join(sdir, `${older}.json`), JSON.stringify({ cli: 'w', given: true }))
  fs.mkdirSync(path.join(sdir, old))
  fs.writeFileSync(path.join(sdir, old, 'hooks.jsonl'), 'Stop {"last_assistant_message":"오래된 마지막 말"}\n')
  fs.writeFileSync(path.join(sdir, `${fresh}.json`), JSON.stringify({ cli: 'y' }))
  const chatRec = path.join(sdir, 'chat-0123456789abcdef-claude-code.json')
  fs.writeFileSync(chatRec, JSON.stringify({ cli: 'z' }))
  const eight = (Date.now() - 8 * 86400_000) / 1000
  const ninetyOne = (Date.now() - 91 * 86400_000) / 1000
  for (const f of [`${old}.json`, path.join(old, 'hooks.jsonl'), old, path.basename(chatRec)]) fs.utimesSync(path.join(sdir, f), eight, eight)
  fs.utimesSync(path.join(sdir, `${older}.json`), ninetyOne, ninetyOne)
  const r2 = runner()
  assert.deepEqual(r2.record(old), { cli: 'x', agent: 'claude-code', dir: '/w', start: 'a'.repeat(40), given: true, turn: 'ended', turns: 2 }, 'only what the run needs to go on — no words')
  assert.ok(Math.abs(fs.statSync(path.join(sdir, `${old}.json`)).mtimeMs - eight * 1000) < 2000, 'when it was last written stays')
  assert.ok(!fs.existsSync(path.join(sdir, old)), 'its session folder (hooks — the CLI\'s last words)')
  assert.ok(!fs.existsSync(path.join(sdir, `${older}.json`)), 'after 90 days the record goes')
  assert.ok(fs.existsSync(path.join(sdir, `${fresh}.json`)), 'today\'s stays')
  assert.ok(fs.existsSync(chatRec), 'a chat\'s own record stays')
})

test('LA-TERM-RESUME-15 살아 있는 실행을 서버가 덧붙인 말과 함께 다시 건네면: 그 말만 같은 세션에 넣는다(누구의 조종도 아님)', async () => {
  const r = runner()
  const j = chatJob('claude-code', 'WRITE 원래.md :: 처음')
  r.handle({ type: 'job', job: j })
  await waitFor(() => of(j.id, 'reply')[0])
  await waitFor(() => of(j.id, 'idle').some((m) => m.until))
  const cli = opens(j.id)[0].cli
  const more = 'WRITE 덧붙임.md :: 대기열에서 붙은 말'
  await r.handle({ type: 'job', job: { ...j, message: `${j.message}\n\n${more}`, prompt: `${j.prompt}\n\n${more}`, resume: { sessionId: cli } } })
  const second = await waitFor(() => of(j.id, 'reply').find((m) => m.turn === 2))
  assert.deepEqual(second.files, ['덧붙임.md'])
  assert.deepEqual(took(cli).slice(1), [more], 'only the words added')
  assert.equal(starts(cli).length, 1, 'no CLI started again')
  assert.equal(of(j.id, 'steered').length, 0, 'not anyone\'s steer')
  await r.handle({ type: 'finish', jobId: j.id })
  const done = await waitFor(() => of(j.id, 'done')[0] || of(j.id, 'failed')[0])
  assert.equal(done.type, 'done', JSON.stringify(done))
  await r.handle({ type: 'finished', jobId: j.id, state: 'done', line: 'main' })
})

test('LA-TERM-RESUME-16 템플릿을 고칠 수 없는 사람의 채팅(projectSettings false)이 다시 켜진 뒤에도: 꺼 둔 스킬의 머리말이 바뀐 채 올라가지 않는다', async () => {
  const SKILL = '---\nname: 양식\ndescription: 회사 양식\nhooks:\n  PreToolUse: []\nallowed-tools: Bash\n---\n# 양식\n'
  origin.git('checkout', '-q', '-b', 'tpl-restart', 'main')
  fs.mkdirSync(path.join(origin.dir, '.claude/skills/양식'), { recursive: true })
  fs.writeFileSync(path.join(origin.dir, '.claude/skills/양식/SKILL.md'), SKILL)
  origin.git('add', '-A', '-f'); origin.git('commit', '-qm', 'template'); origin.git('checkout', '-q', 'main')
  const r1 = runner()
  const j = chatJob('claude-code', 'WRITE 산출물/가.md :: 1', { projectSettings: false })
  j.git = { ...j.git, line: 'tpl-restart', base: 'tpl-restart' }
  r1.handle({ type: 'job', job: j })
  const reply1 = await waitFor(() => of(j.id, 'reply')[0])
  assert.deepEqual(reply1.files, ['산출물/가.md'])
  await waitFor(() => of(j.id, 'idle').some((m) => m.until))
  const cli = opens(j.id)[0].cli
  const rec = r1.record(j.id)
  await quit(r1, j.id)
  const r2 = runner()
  const from = sent.length
  r2.handle({ type: 'job', job: again(j, cli) })
  await settledBack(j.id, cli, 1, from)
  // (on this PC the skill stays left off — its front matter without the run keys — and is not committed)
  assert.doesNotMatch(fs.readFileSync(path.join(r2.dirFor(j), '.claude/skills/양식/SKILL.md'), 'utf8'), /hooks|allowed-tools/)
  assert.equal(r2.steer(j.id, 's16', 'WRITE 산출물/나.md :: 2', '윤태호', USER), true)
  const reply2 = await waitFor(() => of(j.id, 'reply').find((m) => m.turn === 2))
  assert.deepEqual(reply2.files, ['산출물/나.md'])
  await r2.handle({ type: 'finish', jobId: j.id })
  const done = await waitFor(() => of(j.id, 'done')[0] || of(j.id, 'failed')[0])
  assert.equal(done.type, 'done', JSON.stringify(done))
  assert.equal(show(j.git.branch, '.claude/skills/양식/SKILL.md'), SKILL, 'the template skill as it is')
  assert.ok(rec.leftOff?.includes('.claude/skills/양식/SKILL.md'), 'the record says which files the run leaves off')
  await r2.handle({ type: 'finished', jobId: j.id, state: 'done', line: 'main' })
})

test('LA-TERM-RESUME-17 앱이 8일 동안 꺼져 있다가 같은 일을 다시 받아도: 기록의 이어 가는 부분은 남아 첫 말을 다시 넣지 않는다(CLI 의 말과 세션 폴더만 지움)', async () => {
  const r1 = runner()
  const j = chatJob('claude-code', 'WRITE 여드레.md :: 한 번')
  r1.handle({ type: 'job', job: j })
  await waitFor(() => of(j.id, 'reply')[0])
  await waitFor(() => of(j.id, 'idle').some((m) => m.until))
  const cli = opens(j.id)[0].cli
  await quit(r1, j.id)
  const sdir = path.join(dataDir, 'sessions')
  const eight = (Date.now() - 8 * 86400_000) / 1000
  fs.utimesSync(path.join(sdir, `${j.id}.json`), eight, eight)
  for (const f of fs.readdirSync(path.join(sdir, j.id))) fs.utimesSync(path.join(sdir, j.id, f), eight, eight)
  fs.utimesSync(path.join(sdir, j.id), eight, eight)
  const r2 = runner()
  const rec = r2.record(j.id)
  assert.equal(rec.cli, cli)
  assert.equal(rec.given, true)
  assert.equal(rec.turn, 'ended')
  assert.equal(rec.summary, undefined, 'the CLI\'s last words went')
  assert.ok(!fs.existsSync(path.join(sdir, j.id)), 'its session folder (hooks) went')
  const from = sent.length
  r2.handle({ type: 'job', job: again(j, cli) })
  await settledBack(j.id, cli, 1, from)
  assert.equal(took(cli).length, 1, 'nothing pasted again')
  await r2.handle({ type: 'finish', jobId: j.id })
  const done = await waitFor(() => of(j.id, 'done')[0] || of(j.id, 'failed')[0])
  assert.equal(done.type, 'done', JSON.stringify(done))
  await r2.handle({ type: 'finished', jobId: j.id, state: 'done', line: 'main' })
})

test('LA-TERM-RESUME-18 CLI 의 기록에서 받은 것으로 치는 것은 그 실행의 첫 말뿐: 터미널에 친 명령(/cost)만 있으면 받지 않은 것 — 첫 말을 한 번 넣는다 · 기록 파일이 바뀌었거나 줄었으면 알 수 없음', async () => {
  process.env.FAKE_TUI_DROP_ENTER = '20'
  let r1
  let j
  let cli
  try {
    r1 = runner()
    j = chatJob('claude-code', 'WRITE 명령.md :: 첫 말')
    r1.handle({ type: 'job', job: j })
    cli = await waitFor(() => opens(j.id)[0]?.cli)
    await waitFor(() => fakeLog().some((x) => x.session === cli && x.droppedEnter))
    await quit(r1, j.id)
  } finally { delete process.env.FAKE_TUI_DROP_ENTER }
  // what Claude Code records for a local slash command typed in its terminal (its transcript had nothing of this session before)
  const root = path.join(ENV.CLAUDE_CONFIG_DIR, 'projects')
  const real = fs.realpathSync(r1.dirFor(j))
  const tx = path.join(root, real.replace(/[^a-zA-Z0-9]/g, '-'), `${cli}.jsonl`)
  fs.mkdirSync(path.dirname(tx), { recursive: true })
  fs.appendFileSync(tx, `${JSON.stringify({ type: 'user', message: { role: 'user', content: '<command-name>/cost</command-name>\n<command-message>cost</command-message>\n<command-args></command-args>' }, sessionId: cli })}\n`)
  const r2 = runner()
  r2.handle({ type: 'job', job: { ...j, resume: { sessionId: cli } } })
  const reply = await waitFor(() => of(j.id, 'reply')[0])
  assert.deepEqual(reply.files, ['명령.md'])
  const last = opens(j.id).at(-1).cli
  assert.ok(took(last).some((w) => w.includes('WRITE 명령.md')), 'the first message went in')
  await r2.handle({ type: 'finish', jobId: j.id })
  await waitFor(() => of(j.id, 'done')[0])
  await r2.handle({ type: 'finished', jobId: j.id, state: 'done', line: 'main' })
  // the judgment itself: the first message counts, a command does not; a file not the one at the start, or shorter than where it stood: unknown
  const env = { CLAUDE_CONFIG_DIR: ENV.CLAUDE_CONFIG_DIR }
  const id = crypto.randomUUID()
  const f = path.join(root, 'unit', `${id}.jsonl`)
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, `${JSON.stringify({ type: 'user', message: { content: '<command-name>/cost</command-name>' } })}\n`)
  const texts = ['[윤태호 님의 메시지]\nWRITE 판정.md :: y']
  assert.deepEqual(tookFirst({ agent: 'claude-code', cli: id, env, from: 0, texts }), { took: 'not', exists: true })
  fs.appendFileSync(f, `${JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: '[윤태호 님의 메시지]\nWRITE 판정.md :: y' }] } })}\n`)
  assert.deepEqual(tookFirst({ agent: 'claude-code', cli: id, env, from: 0, texts }), { took: 'took', exists: true })
  assert.deepEqual(tookFirst({ agent: 'claude-code', cli: id, env, from: 0, texts, file: path.join(root, 'elsewhere', `${id}.jsonl`) }), { took: 'unknown', exists: true })
  assert.deepEqual(tookFirst({ agent: 'claude-code', cli: id, env, from: fs.statSync(f).size + 10, texts }), { took: 'unknown', exists: true })
  assert.deepEqual(tookFirst({ agent: 'claude-code', cli: crypto.randomUUID(), env, from: 0, texts }), { took: 'not', exists: false })
})

test('LA-TERM-RESUME-19 실행이 끝났는데 서버가 그 턴의 답을 받았다고 하기 전이면: 답을 보고(done)보다 앞에 두어, 다시 이어질 때(앱을 다시 켜도) 답을 먼저 보낸다', async () => {
  const r1 = runner()
  const base = linkFor(r1)
  // (the link went down at the turn's end: neither the answer nor the report reached the server)
  r1.setLink({ send: (m) => (['reply', 'done'].includes(m.type) ? false : base.send(m)) })
  const j = chatJob('claude-code', 'WRITE 끝답.md :: 보고보다 먼저')
  r1.handle({ type: 'job', job: j })
  await waitFor(() => r1.record(j.id)?.replies?.some((x) => x.type === 'reply'))
  await waitFor(() => of(j.id, 'idle').some((m) => m.until))
  await r1.handle({ type: 'finish', jobId: j.id })
  await waitFor(() => r1.outbox.some((m) => m.jobId === j.id && m.type === 'done'))
  assert.deepEqual(r1.outbox.filter((m) => m.jobId === j.id).map((m) => [m.type, m.turn ?? null]), [['reply', 1], ['done', null]])
  assert.equal(r1.record(j.id), null)
  r1.stop()
  // the app is back: what waits in its outbox goes in order — the answer, then the report
  const from = sent.length
  const r2 = runner()
  const said = sent.slice(from).filter((m) => m.jobId === j.id).map((m) => m.type)
  assert.deepEqual(said.filter((t) => t === 'reply' || t === 'done'), ['reply', 'done'])
  const reply = sent.slice(from).find((m) => m.jobId === j.id && m.type === 'reply')
  assert.deepEqual(reply.files, ['끝답.md'])
  // (the server confirms it: it leaves the outbox; the report stays until 'finished')
  await waitFor(() => !r2.outbox.some((m) => m.jobId === j.id && m.type === 'reply'))
  await r2.handle({ type: 'finished', jobId: j.id, state: 'done', line: 'main' })
  assert.equal(r2.outbox.filter((m) => m.jobId === j.id).length, 0)
})

test('LA-TERM-RESUME-20 그 사이 다른 실행이 작업 폴더를 썼으면(같은 채팅의 다른 CLI): 폴더를 서버의 상태로 다시 맞추고, CLI 는 다음 말과 함께 그 사실을 듣는다', async () => {
  const r1 = runner()
  const j = chatJob('claude-code', 'WRITE 원본.md :: 첫 턴')
  r1.handle({ type: 'job', job: j })
  await waitFor(() => of(j.id, 'reply')[0])
  await waitFor(() => of(j.id, 'idle').some((m) => m.until))
  const cli = opens(j.id)[0].cli
  await quit(r1, j.id)
  // another run of the chat (its Codex) used the folder meanwhile: its own branch, its own file
  const dir = r1.dirFor(j)
  execFileSync('git', ['checkout', '-q', '-b', 'pgpt-agent/local-other'], { cwd: dir })
  fs.writeFileSync(path.join(dir, '남의것.md'), '다른 실행\n')
  execFileSync('git', ['add', '남의것.md'], { cwd: dir })
  execFileSync('git', ['-c', 'user.name=시험', '-c', 'user.email=t@example.test', 'commit', '-qm', 'other run'], { cwd: dir })
  const r2 = runner()
  const from = sent.length
  r2.handle({ type: 'job', job: again(j, cli) })
  await settledBack(j.id, cli, 1, from)
  assert.equal(took(cli).length, 1, 'nothing pasted while it waits')
  assert.equal(execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: dir }).toString().trim(), j.git.branch, 'on the run\'s branch again')
  assert.ok(!fs.existsSync(path.join(dir, '남의것.md')), 'the other run\'s file is not in this run')
  assert.equal(fs.readFileSync(path.join(dir, '원본.md'), 'utf8'), '첫 턴\n', 'what this run pushed is there (from the line)')
  assert.equal(r2.steer(j.id, 's20', 'WRITE 다음.md :: 둘', '윤태호', USER), true)
  const second = await waitFor(() => of(j.id, 'reply').find((m) => m.turn === 2))
  assert.deepEqual(second.files, ['다음.md'])
  const words = took(cli).at(-1)
  assert.match(words, /^\[알림\] 앱이 다시 켜지는 사이 이 작업 폴더를 다른 실행이 썼어요/)
  assert.match(words, /WRITE 다음\.md :: 둘$/)
  assert.deepEqual(of(j.id, 'steered').filter((m) => m.steerId === 's20').map((m) => m.how), ['live'], 'the steer is still known as taken')
  await r2.handle({ type: 'finish', jobId: j.id })
  const done = await waitFor(() => of(j.id, 'done')[0] || of(j.id, 'failed')[0])
  assert.equal(done.type, 'done', JSON.stringify(done))
  await r2.handle({ type: 'finished', jobId: j.id, state: 'done', line: 'main' })
})
