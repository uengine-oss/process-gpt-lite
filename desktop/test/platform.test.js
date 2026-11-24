'use strict'
// What the local runner does differently on each system (src/runner/clis.js · hook.js · session.js · git.js):
//   · a Claude Code hook is a program and its arguments (hook.js), no shell — it keeps a path with spaces and a multi-line message whole
//   · Windows: claude.cmd · codex.cmd (npm's shims) start through cmd.exe with every argument intact — spaces, quotes, backslashes, % ^ & ( ) !
//     and Korean — under child_process and under ConPTY (node-pty); a .exe wins over a .cmd in one folder; a CLI and what it started stop
//     together (taskkill /T)
//   · Claude Code's config names a folder with forward slashes on Windows
//   · the work folder's git never converts line endings
// The Windows cases need cmd.exe and ConPTY: elsewhere they are skipped, with the reason.
// Run: cd desktop && node --test test/platform.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync, spawn, spawnSync } = require('node:child_process')
const C = require('../src/runner/clis')
const G = require('../src/runner/git')
const P = require('../src/runner/pty')
const { claudeKey, samePath } = require('../src/runner/session')

const WIN = process.platform === 'win32'
const ONLY_WIN = WIN ? false : 'needs cmd.exe and ConPTY (Windows only)'
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pgl-platform-'))
// (Windows: a process just stopped may hold a file in it for a moment)
const rmQuiet = (d) => { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) } catch (e) { console.warn(`left ${d}: ${e.code}`) } }
test.after(() => rmQuiet(ROOT))

// arguments a runner gives a CLI, and worse: a folder with spaces and parentheses, Codex's -c with quotes and backslashes, cmd.exe's
// metacharacters, an empty one, Korean
const NASTY = ['--settings', 'C:\\Users\\Kim Lee (dev)\\AppData\\Roaming\\Process GPT Lite\\s.json', `projects.${JSON.stringify('C:\\work dir\\x')}.trust_level="trusted"`,
  'a&b|c<d>e^f', '100%', '%PATH%', 'wow!', 'end\\', 'say "hi"', '', '이 폴더의 .pgl-run/prompt.md 를 읽고']
// a program that writes the arguments it got as JSON to a file (not to the screen, which ConPTY redraws), and a batch file in front of it
// the way npm writes one (… %*)
function echoBin(dir) {
  fs.mkdirSync(dir, { recursive: true })
  const js = path.join(dir, 'echo-args.js')
  const out = path.join(dir, 'args.json')
  fs.writeFileSync(js, `require('node:fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2)))\n`)
  if (WIN) fs.writeFileSync(path.join(dir, 'echo args.cmd'), `@echo off\r\nsetlocal\r\n"${process.execPath}" "${js}" %*\r\n`)
  return { js, cmd: path.join(dir, 'echo args.cmd'), got: () => JSON.parse(fs.readFileSync(out, 'utf8')) }
}

test('훅: 셸 없이 프로그램과 인자로 — 빈칸 있는 경로, 여러 줄 메시지가 한 줄로 온전히', () => {
  const dir = path.join(ROOT, 'hook dir (1)')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'hooks.jsonl')
  const input = `${JSON.stringify({ session_id: 's', last_assistant_message: '요약\n둘째 줄 "따옴표" $HOME %PATH%' })}\n`
  for (const ev of ['SessionStart', 'Stop']) {
    const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'runner', 'hook.js'), ev, file], { input })
    assert.equal(r.status, 0, String(r.stderr))
  }
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
  assert.equal(lines.length, 2)
  assert.match(lines[0], /^SessionStart \{/)
  assert.equal(JSON.parse(lines[1].slice('Stop '.length)).last_assistant_message, '요약\n둘째 줄 "따옴표" $HOME %PATH%')
  // (an event name is a word; anything else is not written)
  assert.equal(spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'runner', 'hook.js'), 'a b', file], { input }).status, 0)
  assert.equal(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length, 2)
})

test('macOS · Linux: 프로그램은 그대로 시작한다(셸 없음)', () => {
  const s = C.startSpec('/usr/local/bin/claude', ['--x', 'a b'], 'darwin')
  assert.deepEqual(s, { file: '/usr/local/bin/claude', args: ['--x', 'a b'], verbatim: false })
  assert.equal(C.startSpec('C:\\npm\\claude.exe', ['a'], 'win32').verbatim, false, '.exe 는 바로')
  assert.equal(C.startSpec('C:\\npm\\claude.cmd', ['a'], 'win32').verbatim, true, '.cmd 는 cmd.exe 로')
})

test('Claude Code 설정의 폴더 이름: Windows 는 앞으로 빗금, 어디서나 NFC', () => {
  assert.ok(!claudeKey(ROOT, 'win32').includes('\\'))
  if (WIN) assert.equal(claudeKey('C:\\Users\\kim\\work'), 'C:/Users/kim/work')
  assert.equal(claudeKey('/tmp/a\u1100\u1161', 'darwin'), path.resolve('/tmp/a\uAC00'))
  assert.ok(samePath(ROOT, fs.realpathSync(ROOT)))
})

test('작업 폴더의 git: 줄 끝을 바꾸지 않는다(core.autocrlf=false) · 긴 경로(core.longpaths)', async () => {
  const env = G.authEnv('')
  const pairs = Object.fromEntries(Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, i) => [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]))
  assert.equal(pairs['core.autocrlf'], 'false')
  assert.equal(pairs['core.longpaths'], 'true')
  // a CRLF file and an LF file go in and come out byte for byte, even where the person's git says autocrlf=true
  const dir = path.join(ROOT, 'eol')
  fs.mkdirSync(dir, { recursive: true })
  await G.git(dir, ['init', '-q', '-b', 'main'])
  await G.git(dir, ['config', 'core.autocrlf', 'true'])
  fs.writeFileSync(path.join(dir, 'crlf.txt'), 'a\r\nb\r\n')
  fs.writeFileSync(path.join(dir, 'lf.txt'), 'a\nb\n')
  await G.commit(dir, 'eol', { name: 't', email: 't@t' })
  assert.equal(await G.git(dir, ['show', 'HEAD:crlf.txt']), 'a\r\nb\r\n')
  assert.equal(await G.git(dir, ['show', 'HEAD:lf.txt']), 'a\nb\n')
  assert.deepEqual((await G.git(dir, ['status', '--porcelain'])).trim(), '')
  assert.ok(path.isAbsolute(G.gitPath()) || G.gitPath() === 'git')
})

test('Windows: claude.cmd 같은 배치 파일에 인자가 그대로 간다 — child_process', { skip: ONLY_WIN }, () => {
  const { cmd, got } = echoBin(path.join(ROOT, 'bin a'))
  const s = C.startSpec(cmd, NASTY)
  assert.equal(s.verbatim, true)
  execFileSync(s.file, s.args, { windowsVerbatimArguments: true, encoding: 'utf8' })
  assert.deepEqual(got(), NASTY)
})

test('Windows: 배치 파일을 ConPTY(node-pty)에서 — 인자가 그대로 간다', { skip: ONLY_WIN }, async () => {
  const pty = P.load()
  assert.ok(pty, P.why())
  const { cmd, got } = echoBin(path.join(ROOT, 'bin b'))
  const s = C.startSpec(cmd, NASTY)
  const p = pty.spawn(s.file, s.args.join(' '), { name: 'xterm-256color', cols: 120, rows: 30, cwd: ROOT, env: process.env })
  let out = ''
  p.onData((d) => { out += d })
  const code = await new Promise((resolve) => p.onExit(({ exitCode }) => resolve(exitCode)))
  // (a pseudo console keeps its pipes and output thread until it is closed, even after its program ended — as CliSession.release does)
  setTimeout(() => P.dispose(p), 200)
  assert.equal(code, 0, out)
  assert.deepEqual(got(), NASTY)
})

test('Windows: 한 폴더에 claude.exe 와 claude.cmd 가 있으면 .exe(PATHEXT 순서), 확장자 없는 sh 스크립트는 고르지 않는다', { skip: ONLY_WIN }, () => {
  const dir = path.join(ROOT, 'which')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'claude'), '#!/bin/sh\n')
  assert.equal(C.which('claude', dir), null)
  fs.writeFileSync(path.join(dir, 'claude.cmd'), '@echo off\r\n')
  assert.equal(C.which('claude', dir).toLowerCase(), path.join(dir, 'claude.cmd').toLowerCase())
  fs.copyFileSync(process.execPath, path.join(dir, 'claude.exe'))
  assert.equal(C.which('claude', dir).toLowerCase(), path.join(dir, 'claude.exe').toLowerCase())
})

test('Windows: CLI 를 멈추면 그것이 띄운 프로세스까지 함께 멈춘다(taskkill /T)', { skip: ONLY_WIN }, async () => {
  const dir = path.join(ROOT, 'tree')
  fs.mkdirSync(dir, { recursive: true })
  const pidFile = path.join(dir, 'grandchild.pid')
  // cmd.exe → a batch → node, which starts another node that would outlive a plain kill
  const js = path.join(dir, 'parent.js')
  fs.writeFileSync(js, `const { spawn } = require('node:child_process'); const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); setInterval(() => {}, 1000)\n`)
  fs.writeFileSync(path.join(dir, 'cli.cmd'), `@echo off\r\n"${process.execPath}" "${js}" %*\r\n`)
  const s = C.startSpec(path.join(dir, 'cli.cmd'), [])
  const child = spawn(s.file, s.args, { windowsVerbatimArguments: true, stdio: 'ignore' })
  const t = Date.now()
  while (!fs.existsSync(pidFile) && Date.now() - t < 15000) await new Promise((r) => setTimeout(r, 100))
  const grand = Number(fs.readFileSync(pidFile, 'utf8'))
  const alive = (pid) => execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8' }).includes(String(pid))
  assert.ok(alive(grand))
  const closed = new Promise((r) => child.on('close', r))
  C.killTree(child.pid)
  await closed
  const t2 = Date.now()
  while (alive(grand) && Date.now() - t2 < 10000) await new Promise((r) => setTimeout(r, 200))
  assert.equal(alive(grand), false, 'the CLI\'s own child is gone too')
})
