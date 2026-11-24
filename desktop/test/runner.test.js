'use strict'
// The local runner (src/runner) in its headless fallback (mode 'headless' — where no terminal can be made) with fake CLIs
// (test/fixtures/fake-cli.js — the arguments, stdin and JSON output of Claude Code 2.1.330 and Codex 0.162.1) against a git smart-HTTP
// server that wants the job's token: sync → run → steer → commit → push, what it refuses, and that no token reaches .git/config or a log.
// The link is a fake: what the runner sends is recorded, the test plays the server. (The terminal path: test/terminal.test.js.)
// Run: cd desktop && node --test test/runner.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')
const C = require('../src/runner/clis')
const G = require('../src/runner/git')
const { Runner } = require('../src/runner/runner')
const { gitServer, makeRepo } = require('./helpers/gitServer')
const { fakeBin } = require('./helpers/fakeBin')

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pgl-runner-'))
const BIN = fakeBin(path.join(ROOT, 'bin'))
const SEARCH = [BIN, '/usr/bin', '/bin'].join(path.delimiter)
process.env.FAKE_CLI_HOME = path.join(ROOT, 'fake-home')
process.env.FAKE_CLI_LOG = path.join(ROOT, 'fake.log')
const TOKEN = `pgf1.${crypto.randomBytes(12).toString('base64url')}.${crypto.randomBytes(16).toString('base64url')}`
const FOLDER = crypto.randomUUID()
const USER = crypto.randomUUID()
let srv, origin, skillSrv, skillRepo
const SKILL_TOKEN = `pgf1.${crypto.randomBytes(12).toString('base64url')}.${crypto.randomBytes(16).toString('base64url')}`
const SKILL_FOLDER = crypto.randomUUID()
const skill = () => ({ name: '견적-규칙', folder: { id: SKILL_FOLDER, slug: 'skill-x' }, url: `${skillSrv.base}${skillSrv.path}`, token: SKILL_TOKEN })
test.before(async () => {
  skillRepo = makeRepo(path.join(ROOT, 'srv-skill', 's'), { 'SKILL.md': '---\nname: 견적-규칙\ndescription: 견적서는 부가세 포함 금액으로\n---\n금액은 늘 부가세 포함으로 적는다.\n', 'examples/a.md': '예시\n' })
  skillSrv = await gitServer({ repo: skillRepo.dir, token: SKILL_TOKEN, prefix: '/api/git/s.git' })
  origin = makeRepo(path.join(ROOT, 'srv', 'f'), { '안내문.md': '# 안내문\n초안\n' })
  origin.git('checkout', '-q', '-b', 'inst/abc')
  fs.writeFileSync(path.join(origin.dir, '산출물.md'), '앞 단계 결과\n')
  origin.git('add', '-A'); origin.git('commit', '-qm', 'step 1')
  origin.git('checkout', '-q', 'main')
  srv = await gitServer({ repo: origin.dir, token: TOKEN })
})
test.after(async () => { await srv?.close(); await skillSrv?.close(); fs.rmSync(ROOT, { recursive: true, force: true }) })

const sent = []
// the server's side of the link: what the runner sends is recorded; an accept is confirmed (the server's 'accepted') unless ack is off
const linkFor = (r, { ack = true } = {}) => ({ send: (m) => { sent.push(JSON.parse(JSON.stringify(m))); if (ack && m.type === 'accept') setImmediate(() => r.handle({ type: 'accepted', jobId: m.jobId })); return true } })
const waitFor = async (fn, ms = 20000) => { const t = Date.now(); for (;;) { const v = fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 50)) } }
const of = (id, type) => sent.filter((m) => m.jobId === id && (!type || m.type === type))
const logs = []
function runner(opts = {}, { ack = true } = {}) {
  const r = new Runner({ mode: 'headless', dataDir: path.join(ROOT, 'data'), server: srv.base, searchPath: SEARCH, caps: { 'claude-code': { installed: true, runnable: true, version: '9.9.9' }, codex: { installed: true, runnable: true, version: '9.9.9' } },
    log: (s) => logs.push(s), ...opts })
  r.setLink(linkFor(r, { ack }))
  r.welcome({ user: { id: USER, name: '김담당' } })
  return r
}
let n = 0
function job(agent, prompt, extra = {}) {
  n++
  return { id: crypto.randomUUID(), todoId: `t${n}`, instId: `inst-abc-${n}`, instName: '세미나 견적', activity: `견적서 작성 ${n}`, agent, label: agent === 'codex' ? 'Codex' : 'Claude Code',
    mode: 'complete', lang: 'ko', prompt: `「산출물/0${n}_견적서/」 폴더 안에 두세요.\n${prompt}`, outDir: `산출물/0${n}_견적서`, resultFile: '결과.md',
    person: { id: USER, name: '김담당', email: 'kim@example.test' },
    git: { path: srv.path, token: TOKEN, line: 'inst/abc', base: 'inst/abc', branch: `pgpt-agent/local-${n}-${Date.now().toString(36)}`, folder: { id: FOLDER, slug: 'f', name: 'f' } }, ...extra }
}
const show = (ref, file) => execFileSync('git', ['show', `${ref}:${file}`], { cwd: origin.dir }).toString()

test('CLI 출력 읽기: Claude Code stream-json · Codex --json', () => {
  assert.deepEqual(C.parse('claude-code', JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' })), [{ type: 'session', id: 's1' }])
  assert.deepEqual(C.parse('claude-code', JSON.stringify({ type: 'user', isReplay: true, message: { content: '방향' } })), [{ type: 'ack', text: '방향' }])
  assert.deepEqual(C.parse('claude-code', JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '좋아요' }, { type: 'tool_use', name: 'Write', input: { file_path: 'a.md' } }] } })),
    [{ type: 'text', text: '좋아요' }, { type: 'tool', name: 'Write', brief: 'a.md' }])
  assert.deepEqual(C.parse('claude-code', JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '끝', session_id: 's1' })), [{ type: 'result', text: '끝', error: false, session: 's1' }])
  assert.deepEqual(C.parse('codex', JSON.stringify({ type: 'thread.started', thread_id: 'th1' })), [{ type: 'session', id: 'th1' }])
  assert.deepEqual(C.parse('codex', JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '했어요' } })), [{ type: 'text', text: '했어요' }])
  assert.deepEqual(C.parse('codex', JSON.stringify({ type: 'turn.completed', usage: {} })), [{ type: 'result', text: '', error: false }])
  assert.deepEqual(C.parse('codex', 'not json'), [])
})

test('명령은 CLI 마다 고정: 서버가 보낸 것은 명령이 되지 않는다', () => {
  const c = C.command('claude-code', { phase: 'start', session: 'abc' })
  assert.equal(c.bin, 'claude')
  assert.ok(c.args.includes('--input-format') && c.args.includes('stream-json') && c.args.includes('--replay-user-messages'))
  assert.deepEqual(c.args.slice(c.args.indexOf('--session-id'), c.args.indexOf('--session-id') + 2), ['--session-id', 'abc'])
  assert.ok(C.command('claude-code', { phase: 'resume', session: 'abc' }).args.includes('--resume'))
  const x = C.command('codex', { phase: 'start', cwd: '/w' })
  assert.deepEqual(x.args.slice(0, 2), ['exec', '--json'])
  assert.equal(x.args.at(-1), '-')
  assert.deepEqual(C.command('codex', { phase: 'resume', session: 'th1' }).args.slice(0, 3), ['exec', 'resume', '--json'])
  assert.equal(C.command('openhands', {}), null)
  // a job's own words never become an argument (the prompt goes on stdin)
  assert.ok(!C.command('claude-code', { session: 'abc', prompt: 'rm -rf / $(x)' }).args.some((a) => a.includes('rm -rf /') || a.includes('$(')))
  assert.ok(!C.command('codex', { cwd: '/w', prompt: 'rm -rf /' }).args.some((a) => a.includes('rm -rf /')))
})

test('CLI 찾기: 설치 · 버전 · 로그인 상태 (가짜 CLI)', async () => {
  const caps = await C.detect({ searchPath: SEARCH })
  assert.equal(caps['claude-code'].installed, true)
  assert.equal(caps['claude-code'].version, '9.9.9')
  assert.equal(caps['claude-code'].loggedIn, true)
  assert.equal(caps.codex.version, '9.9.9-fake')
  assert.equal(caps.codex.loggedIn, true)
  assert.equal(caps.openhands.installed, false)
})

test('Claude Code: 맞추기 → 실행 → 커밋 → 올리기, 토큰은 .git/config 에도 로그에도 없다', async () => {
  const r = runner()
  const j = job('claude-code', 'READ 산출물.md\nWRITE_OUT 견적서.md :: 견적 초안 1')
  await r.handle({ type: 'job', job: j })
  const done = await waitFor(() => of(j.id, 'done')[0] || of(j.id, 'failed')[0])
  assert.equal(done.type, 'done', JSON.stringify(done))
  assert.equal(of(j.id, 'accept').length, 1)
  assert.ok(of(j.id, 'session')[0].sessionId)
  assert.equal(done.pushed, true)
  assert.deepEqual(done.files.sort(), [`${j.outDir}/결과.md`, `${j.outDir}/견적서.md`].sort())
  assert.match(done.summary, /산출물\.md: 앞 단계 결과/, '앞 단계 결과(인스턴스 라인)를 읽었다')
  assert.equal(show(j.git.branch, `${j.outDir}/견적서.md`), '견적 초안 1\n')
  assert.match(show(j.git.branch, `${j.outDir}/결과.md`), /Claude Code \(김담당 님의 컴퓨터\)/)
  const author = execFileSync('git', ['log', '-1', '--format=%an <%ae>', j.git.branch], { cwd: origin.dir }).toString().trim()
  assert.equal(author, '김담당 <kim@example.test>')
  // the folder token: only as the request header, never kept or logged
  const dir = r.dirFor(j)
  assert.ok(!fs.readFileSync(path.join(dir, '.git', 'config'), 'utf8').includes(TOKEN))
  assert.ok(srv.seen.every((h) => h === `Bearer ${TOKEN}`))
  assert.ok(!logs.join('\n').includes(TOKEN))
  assert.ok(!fs.readFileSync(path.join(ROOT, 'data', 'outbox.json'), 'utf8').includes(TOKEN))
  // progress went to the server
  assert.ok(of(j.id, 'progress').flatMap((m) => m.lines).some((l) => l.kind === 'tool' && /Write/.test(l.text)))
  // the server confirms: the outbox empties and the folder follows the line
  await r.handle({ type: 'finished', jobId: j.id, state: 'done' })
  assert.equal(JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'outbox.json'), 'utf8')).length, 0)
  assert.equal(r.jobs.size, 0)
})

test('Claude Code 조종: 실행 중에 보낸 지시가 같은 세션에 바로 들어간다(멈추지 않음)', async () => {
  const r = runner()
  const j = job('claude-code', 'SLEEP 1500\nWRITE_OUT 처음.md :: 처음 계획')
  const run = r.handle({ type: 'job', job: j })
  await waitFor(() => of(j.id, 'progress').flatMap((m) => m.lines).some((l) => /sleep/.test(l.text)))
  r.steer(j.id, 's1', 'WRITE_OUT 바뀐방향.md :: 사람이 바꾼 방향', '김담당')
  await run
  const done = await waitFor(() => of(j.id, 'done')[0] || of(j.id, 'failed')[0])
  assert.equal(done.type, 'done', JSON.stringify(done))
  assert.deepEqual(of(j.id, 'steered').map((m) => [m.steerId, m.how]), [['s1', 'live']])
  assert.equal(show(j.git.branch, `${j.outDir}/바뀐방향.md`), '사람이 바꾼 방향\n')
  // one process: the steer did not restart it
  const runs = fs.readFileSync(process.env.FAKE_CLI_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((x) => x.args && x.session === of(j.id, 'session')[0].sessionId)
  assert.equal(runs.length, 1)
  assert.match(show(j.git.branch, `${j.outDir}/결과.md`), /실행 중에 바꾼 방향[\s\S]*김담당: WRITE_OUT 바뀐방향/)
})

test('Codex 조종: 멈추고 같은 세션을 이어서(resume) 실행한다', async () => {
  const r = runner()
  const j = job('codex', 'SLEEP 3000\nWRITE_OUT 처음.md :: 처음 계획')
  const run = r.handle({ type: 'job', job: j })
  await waitFor(() => of(j.id, 'session')[0])
  r.steer(j.id, 's2', 'WRITE_OUT 바뀐방향.md :: 코덱스 새 방향', '김담당')
  await run
  const done = await waitFor(() => of(j.id, 'done')[0] || of(j.id, 'failed')[0])
  assert.equal(done.type, 'done', JSON.stringify(done))
  assert.deepEqual(of(j.id, 'steered').map((m) => [m.steerId, m.how]), [['s2', 'resume']])
  const thread = of(j.id, 'session')[0].sessionId
  const runs = fs.readFileSync(process.env.FAKE_CLI_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((x) => x.kind === 'codex' && x.session === thread)
  assert.ok(runs.some((x) => x.interrupted), '처음 실행은 멈췄다')
  assert.ok(runs.some((x) => x.args?.[1] === 'resume' && x.args.includes(thread)), 'exec resume <thread>')
  assert.equal(show(j.git.branch, `${j.outDir}/바뀐방향.md`), '코덱스 새 방향\n')
})

test('실행 직전에 다시 맞춘다: 기다리는 동안 인스턴스 라인이 움직였으면 새 결과에서 시작한다', async () => {
  const r = runner({
    prefs: () => ({ enabled: true, ask: true }),
    // while the person is asked, another step's result lands on the line
    ask: async () => {
      origin.git('checkout', '-q', 'inst/abc')
      fs.writeFileSync(path.join(origin.dir, '산출물.md'), '다른 사람이 방금 고친 결과\n')
      origin.git('commit', '-qam', 'step 2 by someone else')
      origin.git('checkout', '-q', 'main')
      return true
    },
  })
  const j = job('claude-code', 'READ 산출물.md\nWRITE_OUT a.md :: x')
  await r.handle({ type: 'job', job: j })
  const done = await waitFor(() => of(j.id, 'done')[0] || of(j.id, 'failed')[0])
  assert.equal(done.type, 'done', JSON.stringify(done))
  assert.match(done.summary, /다른 사람이 방금 고친 결과/)
})

test('거절: 로컬 실행 꺼짐 · 묻고 거절 · 없는 CLI · 자리 없음 · 폴더 밖 경로', async () => {
  let r = runner({ prefs: () => ({ enabled: false }) })
  let j = job('claude-code', 'WRITE_OUT a.md :: x')
  await r.handle({ type: 'job', job: j })
  assert.equal(of(j.id, 'decline')[0].reason, 'disabled')
  r = runner({ prefs: () => ({ enabled: true, ask: true }), ask: async () => false })
  j = job('claude-code', 'WRITE_OUT a.md :: x')
  await r.handle({ type: 'job', job: j })
  assert.equal(of(j.id, 'decline')[0].reason, 'declined')
  assert.equal(of(j.id, 'accept').length, 0)
  r = runner({ caps: { 'claude-code': { installed: false } } })
  j = job('claude-code', 'x')
  await r.handle({ type: 'job', job: j })
  assert.equal(of(j.id, 'decline')[0].reason, 'unable')
  r = runner({ maxJobs: 0 })
  j = job('claude-code', 'x')
  await r.handle({ type: 'job', job: j })
  assert.equal(of(j.id, 'decline')[0].reason, 'busy')
  r = runner()
  for (const outDir of ['../밖', '/etc/x', '.git/hooks']) {
    j = job('claude-code', 'x', { outDir })
    await r.handle({ type: 'job', job: j })
    assert.equal(of(j.id, 'decline')[0]?.reason, 'invalid', outDir)
  }
  // another person's job (the server never sends one; the runner checks anyway)
  j = job('claude-code', 'x', { person: { id: crypto.randomUUID(), name: '남' } })
  await r.handle({ type: 'job', job: j })
  assert.equal(of(j.id, 'decline')[0].reason, 'invalid')
  // only http(s) remotes, plain branch names
  assert.throws(() => G.checkUrl('file:///etc'), /not used/)
  assert.throws(() => G.checkUrl('ext::sh -c x'), /not a URL|not used/)
  assert.throws(() => G.checkUrl('http://u:p@h/x'), /credentials/)
  assert.throws(() => G.checkRef('a..b'), /branch/)
})

test('CLI 가 실패하면 failed 로 알리고, 확인을 받을 때까지 outbox 에 둔다', async () => {
  const r = runner()
  const j = job('claude-code', 'FAIL 양식 파일이 없어요')
  await r.handle({ type: 'job', job: j })
  const f = await waitFor(() => of(j.id, 'failed')[0])
  assert.match(f.error, /양식 파일이 없어요/)
  assert.ok(JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'outbox.json'), 'utf8')).some((m) => m.jobId === j.id))
  // a link that came back gets it again
  const again = sent.length
  r.welcome({ user: { id: USER } })
  assert.ok(sent.slice(again).some((m) => m.jobId === j.id && m.type === 'failed'))
  await r.handle({ type: 'finished', jobId: j.id, state: 'failed' })
  assert.ok(!JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'outbox.json'), 'utf8')).some((m) => m.jobId === j.id))
})

test('서버의 스킬: 작업 폴더의 Claude Code 자리에 최신으로 놓이고, 커밋되지 않으며, CLI 가 고친 스킬 · 기억과 조종(제안한 사람 · 입력한 사람) 뒤의 일이 배운 것으로 돌아간다', async () => {
  const r = runner()
  const notices = []
  r.on('notice', (n) => notices.push(n))
  const j = job('claude-code', 'SLEEP 1200\nWRITE_OUT 견적서.md :: 견적\nSKILLNOTE 견적-규칙 :: 할인은 따로 적는다\nMEMORY :: 이 회사는 견적서 끝에 담당자 연락처를 넣는다', { skills: [skill()] })
  const run = r.handle({ type: 'job', job: j })
  await waitFor(() => of(j.id, 'progress').flatMap((m) => m.lines).some((l) => /sleep/.test(l.text)))
  // a participant suggests a prompt: the worker hears of it (nothing goes into the CLI) — then the worker puts it in
  r.handle({ type: 'suggestion', jobId: j.id, by: '서하린', text: 'WRITE_OUT 비고.md :: 서하린의 제안' })
  r.handle({ type: 'steer', jobId: j.id, steerId: 'sx', text: 'WRITE_OUT 비고.md :: 서하린의 제안 — 고침', by: '김담당', byId: USER, from: '서하린' })
  await run
  const done = await waitFor(() => of(j.id, 'done')[0] || of(j.id, 'failed')[0])
  assert.equal(done.type, 'done', JSON.stringify(done))
  assert.match(done.summary, /스킬: 견적-규칙/, 'CLI 가 .claude/skills 에서 스킬을 보았다')
  assert.ok(of(j.id, 'progress').flatMap((m) => m.lines).some((l) => /스킬 1개를 받았어요: 견적-규칙/.test(l.text)))
  // not part of the work's commits
  assert.ok(!done.files.some((f) => f.startsWith('.claude') || f === 'CLAUDE.md'), done.files.join(','))
  // what it learned: its skill edit, its memory, the steer and what it did right after
  const k = done.knowhow
  assert.equal(k.skills.length, 1)
  assert.equal(k.skills[0].name, '견적-규칙')
  assert.equal(k.skills[0].folderId, SKILL_FOLDER)
  assert.deepEqual(k.skills[0].files.map((f) => f.path), ['SKILL.md'])
  assert.match(k.skills[0].files[0].text, /할인은 따로 적는다/)
  assert.match(k.memory.find((m) => m.file === 'CLAUDE.md').text, /담당자 연락처/)
  assert.equal(k.steers[0].by, '김담당', '입력한 사람')
  assert.equal(k.steers[0].from, '서하린', '제안한 사람')
  assert.equal(k.steers[0].how, 'live')
  assert.ok(k.steers[0].after.some((x) => /비고\.md/.test(x)), JSON.stringify(k.steers[0]))
  assert.deepEqual(notices.map((n) => [n.kind, n.by]), [['suggestion', '서하린']], '제안은 알리고, 자기 입력은 알리지 않는다')
  // the skill token was never written or logged either
  assert.ok(!logs.join('\n').includes(SKILL_TOKEN))
  // the skill is current on the next job: a change on its main arrives
  fs.writeFileSync(path.join(skillRepo.dir, 'SKILL.md'), '---\nname: 견적-규칙\n---\n새 판\n')
  skillRepo.git('commit', '-qam', 'v2')
  const j2 = job('claude-code', 'READ .claude/skills/견적-규칙/SKILL.md', { skills: [skill()] })
  await r.handle({ type: 'job', job: j2 })
  const d2 = await waitFor(() => of(j2.id, 'done')[0] || of(j2.id, 'failed')[0])
  assert.match(d2.summary, /새 판/)
  assert.equal(d2.knowhow.skills.length, 0, '고치지 않은 스킬은 배운 것이 아니다')
})

test('Codex 에는 스킬을 .pgl-skills 에 두고 AGENTS.md 로 가리킨다', async () => {
  const r = runner()
  const j = job('codex', 'READ AGENTS.md\nWRITE_OUT a.md :: x', { skills: [skill()] })
  await r.handle({ type: 'job', job: j })
  const done = await waitFor(() => of(j.id, 'done')[0] || of(j.id, 'failed')[0])
  assert.equal(done.type, 'done', JSON.stringify(done))
  assert.match(done.summary, /스킬: 견적-규칙/)
  assert.match(done.summary, /- 견적-규칙: \.pgl-skills\/견적-규칙\/SKILL\.md/)
  assert.ok(!done.files.some((f) => f === 'AGENTS.md' || f.startsWith('.pgl-skills')))
  assert.deepEqual(done.knowhow.memory, [], '앱이 쓴 AGENTS.md 는 배운 것이 아니다')
})

test('서버가 받았다고(accepted) 할 때까지 폴더도 CLI 도 건드리지 않고, 거둔 제안(cancel)은 돌리지 않는다 · 끊겼다 이어지면 다시 묻는다', async () => {
  const r = runner({}, { ack: false })
  const j = job('claude-code', 'WRITE_OUT a.md :: x')
  const run = r.handle({ type: 'job', job: j })
  await waitFor(() => of(j.id, 'accept')[0])
  await new Promise((res) => setTimeout(res, 800))
  assert.equal(of(j.id, 'session').length + of(j.id, 'progress').length, 0, '확인 전에는 아무것도 하지 않는다')
  await r.handle({ type: 'cancel', jobId: j.id, reason: 'withdrawn' })
  await run
  assert.equal(of(j.id, 'done').length + of(j.id, 'failed').length, 0)
  assert.equal(r.jobs.has(j.id), false)
  // confirmed: it runs
  const k = job('claude-code', 'WRITE_OUT b.md :: y')
  const run2 = r.handle({ type: 'job', job: k })
  await waitFor(() => of(k.id, 'accept')[0])
  await r.handle({ type: 'accepted', jobId: k.id })
  await run2
  assert.equal((await waitFor(() => of(k.id, 'done')[0] || of(k.id, 'failed')[0])).type, 'done')
  // the link dropped before the answer: the accept is said again when it is back
  const m = job('claude-code', 'WRITE_OUT c.md :: z')
  const run3 = r.handle({ type: 'job', job: m })
  await waitFor(() => of(m.id, 'accept')[0])
  r.welcome({ user: { id: USER, name: '김담당' } })
  assert.equal(of(m.id, 'accept').length, 2)
  await r.handle({ type: 'accepted', jobId: m.id })
  await run3
  assert.equal((await waitFor(() => of(m.id, 'done')[0] || of(m.id, 'failed')[0])).type, 'done')
})

test('같은 폴더의 다음 일은 앞 일을 서버가 받아들이고(finished) 폴더가 라인을 따라간 뒤에 시작한다', async () => {
  const r = runner()
  const j1 = job('claude-code', 'WRITE_OUT 앞.md :: 앞')
  const j2 = job('claude-code', 'WRITE_OUT 뒤.md :: 뒤', { instId: j1.instId })
  await r.handle({ type: 'job', job: j1 })
  assert.equal((await waitFor(() => of(j1.id, 'done')[0] || of(j1.id, 'failed')[0])).type, 'done')
  const run2 = r.handle({ type: 'job', job: j2 })
  await new Promise((res) => setTimeout(res, 800))
  assert.equal(of(j2.id, 'progress').length, 0, '앞 일이 끝나기 전에는 폴더를 건드리지 않는다')
  await r.handle({ type: 'finished', jobId: j1.id, state: 'done' })
  await run2
  assert.equal((await waitFor(() => of(j2.id, 'done')[0] || of(j2.id, 'failed')[0])).type, 'done')
})

test('작업 폴더가 지닌 AGENTS.md · CLAUDE.md · .claude/ 는 지우지도 덮어쓰지도 않는다 — 회사 스킬은 겹치지 않는 자리에', async () => {
  const repo = makeRepo(path.join(ROOT, 'srv-tracked', 't'), { 'AGENTS.md': '# 우리 저장소 규칙\n', 'CLAUDE.md': '# 팀 메모\n', '.claude/settings.json': '{"permissions":{}}\n',
    '.claude/skills/견적-규칙/SKILL.md': '---\nname: 견적-규칙\n---\n저장소의 판\n' })
  const s2 = await gitServer({ repo: repo.dir, token: TOKEN })
  const show2 = (ref, file) => execFileSync('git', ['show', `${ref}:${file}`], { cwd: repo.dir }).toString()
  try {
    for (const agent of ['codex', 'claude-code']) {
      const r = runner()
      const branch = `pgpt-agent/tracked-${agent}-${Date.now().toString(36)}`
      const j = job(agent, `WRITE_OUT a.md :: x${agent === 'claude-code' ? '\nMEMORY :: 견적서 끝에 연락처' : ''}`, { skills: [skill()],
        git: { url: `${s2.base}${s2.path}`, path: s2.path, token: TOKEN, line: 'main', base: 'main', branch, folder: { id: crypto.randomUUID(), slug: 't', name: 't' } } })
      await r.handle({ type: 'job', job: j })
      const done = await waitFor(() => of(j.id, 'done')[0] || of(j.id, 'failed')[0])
      assert.equal(done.type, 'done', JSON.stringify(done))
      assert.equal(show2(branch, 'AGENTS.md'), '# 우리 저장소 규칙\n', `${agent}: AGENTS.md 그대로`)
      assert.equal(show2(branch, '.claude/settings.json'), '{"permissions":{}}\n', `${agent}: .claude/settings.json 그대로`)
      assert.equal(show2(branch, '.claude/skills/견적-규칙/SKILL.md'), '---\nname: 견적-규칙\n---\n저장소의 판\n', `${agent}: 저장소의 스킬 그대로`)
      assert.ok(!done.files.some((f) => f === 'AGENTS.md' || f.startsWith('.claude/') || f.startsWith('.pgl-skills')), `${agent}: ${done.files.join(',')}`)
      if (agent === 'codex') {
        // the company skill where Codex reads it, the pointer in its prompt (the folder's own AGENTS.md is left alone)
        assert.match(done.summary, /스킬: 견적-규칙/)
        const got = fs.readFileSync(process.env.FAKE_CLI_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((x) => x.kind === 'codex' && x.received)
        assert.ok(got.some((x) => x.received.includes('.pgl-skills/견적-규칙/SKILL.md')), '스킬 안내는 프롬프트로')
        assert.deepEqual(done.knowhow.memory, [])
      } else {
        // what it added to the folder's own CLAUDE.md is the memory it learned — not the folder's note before it
        assert.equal(show2(branch, 'CLAUDE.md'), '# 팀 메모\n\n- 견적서 끝에 연락처\n')
        const mem = done.knowhow.memory.find((m) => m.file === 'CLAUDE.md')
        assert.ok(mem && /견적서 끝에 연락처/.test(mem.text) && !/팀 메모/.test(mem.text), JSON.stringify(done.knowhow.memory))
        assert.ok(of(j.id, 'progress').flatMap((m) => m.lines).some((l) => /견적-규칙/.test(l.text) && /작업 폴더/.test(l.text)), '같은 이름의 저장소 스킬이 있음을 알린다')
      }
      await r.handle({ type: 'finished', jobId: j.id, state: 'done' })
    }
  } finally { await s2.close() }
})
