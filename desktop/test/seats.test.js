'use strict'
// 작업본은 한 곳에 — a variation's working copy on this computer (src/runner/seats.js, desktop 0.2.7; spec openspec/specs/variation-seats).
// The link is a fake (the test plays the server: seat:prepare → ready → held, seat:token for this variation at this epoch, seat:pushed →
// the variation's branch moves forward, seat:release → released, seat:left → a variation of its own, as server/lib/folders/seatLink.js
// does); the folder's git server is real (git http-backend behind a Bearer token — test/helpers/gitServer.js) over a bare repository that
// plays the folder: main and the variation's branch var/u/…/report.
// Pinned here: the working copy is made, changed and removed only under the app's data folder (a folder of the person's untouched); one
// place per variation id; the app commits what is there as it is (new · changed · deleted) and leaves out links, repositories inside,
// git's control files, a secret's name and a key's shape — on disk as they were; it never resets, cleans or checks out the working copy;
// a word from an older epoch is never acted on; a working copy whose seat is gone comes up as a variation of its own (or just goes when it
// has nothing new; or stays as a leftover when that is refused); save points after the files go quiet and at a CLI's turn end, with the
// switch per variation; 돌려놓기 moves what git does not carry to the app's trash. And the shared engine (upload.js).
// Run: cd desktop && node --test test/seats.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')
const W = require('../src/runner/seats')
const U = require('../src/runner/upload')
const SY = require('../src/runner/sync')
const settings = require('../src/settings')
const { gitServer } = require('./helpers/gitServer')

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pgl-seats-')))
const rmQuiet = (d) => { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) } catch (e) { console.warn(`left ${d}: ${e.code}`) } }
const DATA = path.join(ROOT, 'app', 'local-agents')
const CLAUDE = path.join(ROOT, 'claude-config')
const CODEX = path.join(ROOT, 'codex-home')
const USER = crypto.randomUUID()
const FOLDER = crypto.randomUUID()
const DEV8 = 'd1e2f3a4'
const TOKEN = `pgf1.${crypto.randomBytes(12).toString('base64url')}.${crypto.randomBytes(16).toString('base64url')}`
const FAKE_GH = `${'gh'}${'p_'}${'Zx9Q'.repeat(9)}`
const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...a], { cwd, stdio: 'pipe' }).toString()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// a wait that runs out says why: each working copy's record (state · why · epoch · whether its folder is there), the prepares that failed,
// the last seat messages the app sent and the app's last log lines (its git errors among them) — on every platform the same
const explain = () => {
  const w = typeof wc === 'undefined' ? null : wc
  if (!w) return ''
  const v8 = (x) => String(x || '').slice(0, 8)
  const recs = w.store.all().map((e) => `${v8(e.variationId)} ${e.state}${e.why ? `/${e.why}` : ''} epoch ${e.epoch} dir ${e.dir ? (fs.existsSync(e.dir) ? 'there' : 'gone') : 'none'}`)
  const failed = [...(w.failed || new Map())].map(([k, f]) => `${v8(k)} ${f.why}`)
  const msgs = (typeof sent === 'undefined' ? [] : sent).slice(-10).map((m) => `${m.type} ${v8(m.variation)}${m.why ? ` ${m.why}` : ''}${m.epoch != null ? ` e${m.epoch}` : ''}`)
  const lines = (typeof logs === 'undefined' ? [] : logs).slice(-10)
  return `\n  records: ${recs.join(' | ') || '-'}\n  failed: ${failed.join(' | ') || '-'}\n  sent: ${msgs.join(' | ') || '-'}\n  log:\n    ${lines.join('\n    ') || '-'}`
}
const waitFor = async (fn, ms = 8000, what = '') => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error(`timed out: ${what}${explain()}`); await sleep(40) } }
// A working copy deleted outside the app, as Finder · Explorer would. On Windows a folder the app watches (and runs git in) cannot be
// removed while it does — Explorer says it is in use — so there the app first lets go of it, as it would once the folder is gone; the
// engine's way with a folder that is gone is the same after that.
async function deleteOutside(dir, w = null, vid = null) {
  if (process.platform === 'win32' && w && vid) { w.unwatchOne(vid); await settled(w, vid) }
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
}
// A working copy deleted outside the app, the way it can happen on this computer. On Windows the app keeps a folder it watches and runs
// git in (Explorer says it is in use — accepted: the app protects it), so there the app is stopped first, the folder deleted, and the app
// started again on the same records: the next start finds the folder gone, and the same 「없어졌어요」 path runs from there. Elsewhere the
// folder goes while the app watches it. → the engine to go on with
async function deletedOutside(dir, w, vid) {
  if (process.platform !== 'win32') { fs.rmSync(dir, { recursive: true, force: true }); return w }
  w.stop()
  await settled(w, vid)
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
  return make()
}
// a file rewritten in place (on Windows the .git file of a worktree is hidden, and a write that replaces a hidden file is refused)
function rewrite(file, text) {
  const fd = fs.openSync(file, 'r+')
  try { fs.ftruncateSync(fd, 0); fs.writeSync(fd, text, 0) } finally { fs.closeSync(fd) }
}
// what the app was asked to do about a variation has all been done (its lock is first in, first out: nothing waits on time)
const settled = (w, vid) => w.locked(vid, async () => {})
// a program with its current folder in a working copy (a terminal, a CLI): started, and seen the way the app sees it (lsof) before the
// test goes on — close() ends it and waits until the app no longer sees it
async function programIn(w, dir) {
  const { spawn } = require('node:child_process')
  const sh = spawn('sleep', ['120'], { cwd: dir, stdio: 'ignore' })
  await waitFor(() => w.inUse(dir), 20000, 'the program seen in the folder')
  return {
    async close() {
      if (sh.exitCode === null && sh.signalCode === null) { const gone = new Promise((r) => sh.once('exit', r)); sh.kill(); await gone }
      await waitFor(async () => !(await w.inUse(dir)), 20000, 'the program gone')
    },
  }
}
const calls = []
W.setTap((c) => calls.push(c))
const NEVER = ['reset', 'clean', 'checkout', 'restore', 'stash', 'rebase', 'merge', 'switch', 'pull', 'am', 'cherry-pick', 'revert', 'rm', 'mv']

// ---------- a folder of the person's (never touched) ----------
const PERSON = path.join(ROOT, 'people', '내 문서')
function treeOf(dir) {
  const out = {}
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name)
      const r = rel ? `${rel}/${e.name}` : e.name
      const st = fs.lstatSync(abs)
      if (st.isDirectory()) { out[`${r}/`] = `dir ${st.mtimeMs}`; walk(abs, r) } else out[r] = `${st.size} ${st.mtimeMs}`
    }
  }
  walk(dir, '')
  return out
}

// ---------- the server ----------
const BARE = path.join(ROOT, 'srv', `${FOLDER}.git`)
const bare = (...a) => git(BARE, ...a).trim()
const rev = (ref) => { try { return bare('rev-parse', '--verify', '--quiet', `${ref}^{commit}`) } catch { return null } }
const isAncestor = (a, b) => { try { git(BARE, 'merge-base', '--is-ancestor', a, b); return true } catch { return false } }
const filesAt = (ref) => git(BARE, 'ls-tree', '-r', '--name-only', '-z', ref).split('\0').filter(Boolean).sort()
const at = (ref, file) => git(BARE, 'show', `${ref}:${file}`)
let srv
// the variations the fake server knows: vid → {branch, epoch, state, title}
const vars = new Map()
const sent = []
const logs = []
let wc = null
const left8 = (vid) => `pgpt-agent/left-${vid}-${DEV8}/head`
// how the fake server answers (a test may change one)
const plays = {
  ready: (m) => { const v = vars.get(m.variation); if (!v || v.epoch !== m.epoch) return { type: 'seat:refused', variation: m.variation, why: 'stale' }; v.state = 'held'; return { type: 'seat:held', variation: m.variation, epoch: m.epoch, head: m.head } },
  token: (m) => {
    const v = vars.get(m.variation)
    if (m.for === 'left') return { type: 'seat:token', variation: m.variation, for: 'left', token: TOKEN, path: srv.path, url: null, push: left8(m.variation).replace(/head$/, ''), branch: left8(m.variation), person: { name: '박작업', email: 'work@example.test' } }
    if (!v || v.epoch !== m.epoch || v.state !== 'held') return { type: 'seat:refused', variation: m.variation, for: 'push', why: 'stale' }
    return { type: 'seat:token', variation: m.variation, for: 'push', token: TOKEN, path: srv.path, url: null, epoch: v.epoch, branch: W.seatBranch(m.variation, v.epoch),
      push: W.seatBranch(m.variation, v.epoch).replace(/head$/, ''), head: rev(v.branch), person: { name: '박작업', email: 'work@example.test' } }
  },
  pushed: (m) => take(m),
  release: (m) => {
    if (m.head) { const r = take(m); if (r.type !== 'seat:taken') return r }
    const v = vars.get(m.variation)
    v.state = null
    v.epoch++
    return { type: 'seat:released', variation: m.variation, head: rev(v.branch) }
  },
  left: (m) => {
    const tip = rev(`refs/heads/${left8(m.variation)}`)
    if (tip !== m.head) return { type: 'seat:refused', variation: m.variation, why: 'conflict' }
    const v = vars.get(m.variation)
    const id = crypto.randomUUID()
    bare('branch', `var/u/left/${id.slice(0, 8)}`, m.head)
    bare('update-ref', '-d', `refs/heads/${left8(m.variation)}`)
    return { type: 'seat:left-taken', variation: m.variation, newVariation: { id, title: `${v.title} — 테스트 맥에 남아 있던 변경` } }
  },
}
function take(m) {
  const v = vars.get(m.variation)
  if (!v || v.epoch !== m.epoch) return { type: 'seat:refused', variation: m.variation, why: 'stale' }
  const tip = rev(`refs/heads/${W.seatBranch(m.variation, m.epoch)}`)
  if (tip !== m.head) return { type: 'seat:refused', variation: m.variation, why: 'conflict' }
  const vh = rev(v.branch)
  if (!isAncestor(vh, m.head)) return { type: 'seat:refused', variation: m.variation, why: 'diverged' }
  bare('update-ref', `refs/heads/${v.branch}`, m.head, vh)
  return { type: 'seat:taken', variation: m.variation, head: m.head }
}
function link(m) {
  sent.push(JSON.parse(JSON.stringify(m)))
  const k = { 'seat:ready': 'ready', 'seat:token': 'token', 'seat:pushed': 'pushed', 'seat:release': 'release', 'seat:left': 'left' }[m.type]
  const r = k && plays[k] && plays[k](m)
  // (the server names the message it answers — seat:refused {re})
  if (r && r.type === 'seat:refused' && !r.re) r.re = m.type
  if (r) setImmediate(() => wc?.handle(r))
  return true
}
const sentOf = (type, vid) => sent.filter((m) => m.type === type && (!vid || m.variation === vid))
function make(opts = {}) {
  settings.init(path.join(ROOT, 'app'))
  const w = new W.WorkingCopies({ dataDir: DATA, server: srv.base, userId: USER, store: settings.seatStore(srv.base, USER), send: link, device: { name: '테스트 맥' },
    user: () => ({ id: USER, name: '박작업' }), log: (s) => { logs.push(s); if (process.env.SEATS_TEST_LOG) process.stderr.write(`[app] ${s}\n`) }, askMs: 5000, takeMs: 10000, quietMs: 60_000, statusMs: 30, turnMs: 60, turnWaitMs: 1500,
    claudeHome: CLAUDE, codexHome: CODEX, ...opts })
  w.linkUp({ id: USER, name: '박작업' })
  wc = w
  return w
}
// a variation of the folder on the server (its branch from main) and the seat:prepare the server would send for it
function variation(title, files = {}, vid = crypto.randomUUID()) {
  const branch = `var/u/${USER.replace(/-/g, '').slice(0, 8)}/${vid}`
  bare('branch', branch, 'main')
  if (Object.keys(files).length) {
    const work = path.join(ROOT, 'seed', vid)
    git(path.join(ROOT), 'clone', '-q', '-b', branch, BARE, work)
    for (const [p, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(work, p)), { recursive: true }); fs.writeFileSync(path.join(work, p), body) }
    git(work, 'add', '-A'); git(work, 'commit', '-qm', 'seed'); git(work, 'push', '-q', 'origin', branch)
  }
  vars.set(vid, { branch, epoch: 1, state: 'moving', title })
  return vid
}
const prepareMsg = (vid, o = {}) => {
  const v = vars.get(vid)
  return { type: 'seat:prepare', variation: vid, folderId: FOLDER, folderName: '영업 제안 키트', title: v.title, branch: v.branch, head: rev(v.branch), epoch: v.epoch, autoSave: true,
    token: TOKEN, path: srv.path, url: null, push: W.seatBranch(vid, v.epoch).replace(/head$/, ''), person: { name: '박작업', email: 'work@example.test' }, ...o }
}
async function prepared(w, vid, o) {
  w.handle(prepareMsg(vid, o))
  return waitFor(() => ['held', 'blocked'].includes(w.get(vid)?.state) && w.get(vid), 15000, 'held')
}
const put = (dir, rel, text) => { const f = path.join(dir, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text) }

let personBefore = null
test.before(async () => {
  fs.mkdirSync(PERSON, { recursive: true })
  fs.writeFileSync(path.join(PERSON, '메모.md'), '# 내 메모\n')
  personBefore = treeOf(PERSON)
  fs.mkdirSync(CLAUDE, { recursive: true })
  fs.mkdirSync(BARE, { recursive: true })
  git(BARE, 'init', '-q', '--bare', '-b', 'main')
  const work = path.join(ROOT, 'seed', 'main')
  git(ROOT, 'clone', '-q', BARE, work)
  put(work, 'README.md', '# 영업 제안 키트\n')
  put(work, 'docs/제안서.md', '# 제안서\n고객의 말로 시작한다.\n')
  put(work, 'docs/지울 것.md', '지워질 파일\n')
  put(work, '.gitignore', 'dist/\n')
  fs.symlinkSync('README.md', path.join(work, 'guide-link'))
  git(work, 'add', '-A'); git(work, 'commit', '-qm', 'first'); git(work, 'push', '-q', 'origin', 'HEAD:main')
  srv = await gitServer({ repo: BARE, token: TOKEN, prefix: `/api/local-git/${FOLDER}.git` })
})
test.after(async () => { wc?.stop(); await srv?.close(); W.setTap(null); rmQuiet(ROOT) })

// ---------- the shared engine ----------
test('upload.js: 링크로 묻고 답 받기 · 시간 초과 · 오프라인 · 하나씩 · 토큰은 기록에 없음 · .git 은 보지 않음', async () => {
  const out = []
  const u = new U.Uploader({ server: 'http://127.0.0.1:1/lite/', send: (m) => { out.push(m); return m.ok !== false }, prefix: 'seat:', key: 'variation', askMs: 80, log: (s) => out.push(s) })
  assert.ok(u.handles({ type: 'seat:token' }) && !u.handles({ type: 'sync:token' }))
  const p = u.ask({ type: 'seat:token', variation: 'v1' }, ['seat:token'])
  assert.equal(u.answer({ type: 'seat:token', variation: 'v2' }), false, '다른 변형의 답은 아님')
  assert.equal(u.answer({ type: 'seat:token', variation: 'v1', token: 'x' }), true)
  assert.equal((await p).token, 'x')
  const r = u.ask({ type: 'seat:token', variation: 'v1' }, ['seat:token'])
  u.answer({ type: 'seat:refused', variation: 'v1', why: 'stale' })
  assert.equal((await r).why, 'stale', '거절도 답')
  assert.equal((await u.ask({ type: 'seat:ready', variation: 'v1' }, ['seat:held'])).why, 'timeout')
  assert.equal((await u.ask({ type: 'seat:ready', variation: 'v1', ok: false }, ['seat:held'])).why, 'offline')
  const w = u.ask({ type: 'seat:ready', variation: 'v1' }, ['seat:held'], 5000)
  u.linkDown()
  assert.equal((await w).why, 'offline', '링크가 끊기면 기다림도 끝')
  // one thing at a time per key
  const order = []
  await Promise.all([u.locked('k', async () => { await sleep(30); order.push(1) }), u.locked('k', async () => order.push(2)), u.locked('j', async () => order.push(0))])
  assert.deepEqual(order, [0, 1, 2])
  u.secret('pgf1.secret.token')
  u.log('push with pgf1.secret.token failed')
  assert.ok(out.includes('push with *** failed'))
  assert.equal(u.urlOf({ path: '/api/local-git/x.git' }), 'http://127.0.0.1:1/lite/api/local-git/x.git')
  assert.throws(() => u.urlOf({ url: 'file:///etc' }))
  assert.throws(() => u.urlOf({ url: 'https://u:p@example.test/x.git' }))
  // the quiet watcher: once, after quietMs without a change; .git is not a change
  let cb = null
  const fake = new U.Uploader({ watchFn: (dir, f) => { cb = f; return { close() {} } } })
  let quiet = 0
  let seen = 0
  fake.watch('a', '/x', { quietMs: 120, onQuiet: () => quiet++, onChange: () => seen++ })
  cb('change', '.git'); cb('change', '.git/index')
  assert.equal(seen, 0)
  cb('change', 'a.md'); await sleep(70); cb('change', 'b.md'); await sleep(70)
  assert.equal(quiet, 0, '바뀔 때마다 다시 센다')
  await sleep(120)
  assert.equal(quiet, 1)
  await sleep(150)
  assert.equal(quiet, 1, '한 번만')
  fake.later('a'); fake.later('a'); fake.later('b')
  assert.deepEqual(fake.drain().sort(), ['a', 'b'])
  assert.deepEqual(fake.drain(), [])
  fake.stop()
})

// ---------- the working copy ----------
let V1, e1
test('받기: 앱 데이터 아래에만 저장소와 작업 트리 — 링크는 평범한 파일, 사람의 폴더는 그대로, 같은 변형은 한 자리', async () => {
  V1 = variation('보고서 손보기')
  const w = make()
  calls.length = 0
  e1 = await prepared(w, V1)
  const root = path.join(DATA, 'folders', SY.serverKey(srv.base), SY.personKey(USER), FOLDER.slice(0, 8))
  assert.equal(e1.dir, path.join(root, 'wt', `${V1.slice(0, 8)}-보고서-손보기`))
  assert.ok(fs.existsSync(path.join(root, 'repo', 'HEAD')), '받은 객체는 앱 데이터의 저장소에')
  assert.equal(fs.readFileSync(path.join(e1.dir, 'docs', '제안서.md'), 'utf8'), '# 제안서\n고객의 말로 시작한다.\n')
  assert.ok(!fs.lstatSync(path.join(e1.dir, 'guide-link')).isSymbolicLink(), '서버의 링크는 링크로 풀지 않는다')
  assert.equal(git(e1.dir, 'symbolic-ref', 'HEAD').trim(), `refs/heads/${vars.get(V1).branch}`)
  assert.equal(git(e1.dir, 'status', '--porcelain').trim(), '', '사람의 git 으로 봐도 깨끗하다(core.symlinks=false 가 저장소에)')
  assert.equal(fs.readFileSync(path.join(root, 'repo', 'info', 'attributes'), 'utf8'), '* -text -filter -ident -working-tree-encoding\n')
  const ready = sentOf('seat:ready', V1)
  assert.equal(ready.length, 1)
  assert.deepEqual([ready[0].epoch, ready[0].head], [1, rev(vars.get(V1).branch)])
  assert.ok(!JSON.stringify(w.list()).includes(ROOT), '목록에 경로가 없다')
  assert.equal(w.pathOf(V1), e1.dir)
  // every git call: inside the app's data folder, and never one that rewrites a working tree
  for (const c of calls) {
    assert.ok(!NEVER.includes(c.sub), `git ${c.sub}`)
    for (const d of [c.cwd, c.gitDir].filter(Boolean)) assert.ok(d.startsWith(DATA), `${c.sub} in ${d}`)
  }
  assert.ok(calls.some((c) => c.sub === 'worktree' && c.args.includes('add')))
  // the same variation said again: the same place, no second working copy
  w.handle(prepareMsg(V1))
  await waitFor(() => sentOf('seat:ready', V1).length === 2, 5000, 'ready again')
  assert.equal(fs.readdirSync(path.join(root, 'wt')).length, 1)
  assert.equal(w.list().length, 1)
  assert.deepEqual(treeOf(PERSON), personBefore, '사람의 폴더는 그대로')
  // the person's own `git push` has nowhere to go with a token: no remote keeps one
  assert.ok(!fs.readFileSync(path.join(root, 'repo', 'config'), 'utf8').includes(TOKEN))
  assert.ok(!logs.join('\n').includes(TOKEN))
})

test('있는 그대로 커밋: 새 파일 · 고친 파일 · 지운 파일은 올라가고, .env · 열쇠 생김새 · 링크 · .gitmodules · 안의 저장소는 빠지고 디스크에 그대로', async () => {
  const w = wc
  calls.length = 0
  const d = e1.dir
  put(d, 'docs/새 문서.md', '# 새 문서\n')
  put(d, 'docs/제안서.md', '# 제안서\n고객의 말로 시작한다.\n마감은 금요일.\n')
  fs.rmSync(path.join(d, 'docs', '지울 것.md'))
  put(d, '.env', `API_KEY=${crypto.randomBytes(18).toString('hex')}\n`)
  put(d, 'config/app.txt', `server: example.test\ntoken: ${FAKE_GH}\n`)
  put(d, '.gitmodules', '[submodule "x"]\n\tpath = x\n\turl = https://example.test/x.git\n')
  fs.symlinkSync('/etc/hosts', path.join(d, 'hosts-link'))
  put(d, 'vendor/lib/a.txt', 'lib\n')
  git(path.join(d, 'vendor', 'lib'), 'init', '-q'); git(path.join(d, 'vendor', 'lib'), 'add', '-A'); git(path.join(d, 'vendor', 'lib'), 'commit', '-qm', 'x')
  // a file the server had as a link, changed here (its type stays a link in git): it stays out
  fs.writeFileSync(path.join(d, 'guide-link'), '/etc/passwd')
  const r = await w.saveNow(V1)
  assert.equal(r.ok, true, JSON.stringify(r))
  const vb = vars.get(V1).branch
  const head = rev(vb)
  assert.equal(head, r.head, '변형 가지가 올린 데까지 앞으로')
  assert.equal(rev(`refs/heads/${W.seatBranch(V1, 1)}`), head, '자기 회차의 가지로 올렸다')
  const files = filesAt(vb)
  assert.ok(files.includes('docs/새 문서.md'))
  assert.ok(!files.includes('docs/지울 것.md'), '지운 것도 그대로')
  assert.match(at(vb, 'docs/제안서.md'), /마감은 금요일/)
  for (const out of ['.env', 'config/app.txt', '.gitmodules', 'hosts-link', 'vendor/lib']) assert.ok(!files.includes(out), `${out} 은 빠진다`)
  assert.equal(git(BARE, 'cat-file', '-p', `${vb}:guide-link`).trim(), 'README.md', '서버의 링크 항목은 바뀌지 않았다')
  assert.equal(git(BARE, 'log', '-1', '--format=%an <%ae>|%s', vb).trim(), '박작업 <work@example.test>|저장 지점')
  for (const keep of ['.env', 'config/app.txt', '.gitmodules', 'vendor/lib/a.txt']) assert.ok(fs.existsSync(path.join(d, keep)), `${keep} 은 디스크에 그대로`)
  assert.ok(fs.lstatSync(path.join(d, 'hosts-link')).isSymbolicLink())
  const e = w.get(V1)
  assert.equal(e.head, head)
  assert.ok(e.flagged >= 5, `flagged ${e.flagged}`)
  assert.equal(w.list()[0].why, 'flagged')
  assert.ok(e.pushedAt)
  const pushed = sentOf('seat:pushed', V1).at(-1)
  assert.deepEqual([pushed.epoch, pushed.head], [1, head])
  for (const c of calls) assert.ok(!NEVER.includes(c.sub), `git ${c.sub}`)
  // the counts: 저장 안 한 변경 (what stayed out) · 다른 가지 아님
  await waitFor(() => sentOf('seat:status', V1).some((m) => m.dirty >= 5), 5000, 'status')
  const st = sentOf('seat:status', V1).at(-1)
  assert.deepEqual([st.epoch, st.branchOk, st.ahead], [1, true, 0])
  assert.ok(!JSON.stringify(st).includes('.env'), '이름 · 경로 없이 수만')
  // nothing new: no push
  const before = sentOf('seat:token', V1).length
  assert.equal((await w.saveNow(V1)).changed, false)
  assert.equal(sentOf('seat:token', V1).length, before)
})

test('작업본에서 reset · clean · checkout 같은 것은 부르지 않는다 — 부르려 해도 거절', async () => {
  for (const sub of ['reset', 'clean', 'checkout', 'restore', 'stash', 'rebase', 'merge', 'switch', 'pull']) {
    await assert.rejects(W.wcGit([sub, '-q'], { cwd: e1.dir }), /not used on a working copy/)
  }
  await assert.rejects(W.wcGit(['worktree', 'move', 'a', 'b'], { cwd: e1.dir }), /not used/)
  for (const c of calls) assert.ok(!NEVER.includes(c.sub))
})

test('다른 가지로 바뀌어 있으면 올리지 않는다 — 사람이 돌아오면 다시', async () => {
  const w = wc
  git(e1.dir, 'symbolic-ref', 'HEAD', 'refs/heads/elsewhere')
  const r = await w.saveNow(V1)
  assert.deepEqual([r.ok, r.why], [false, 'branch'])
  assert.equal(w.list()[0].branchOk, false)
  git(e1.dir, 'symbolic-ref', 'HEAD', `refs/heads/${vars.get(V1).branch}`)
  assert.equal((await w.saveNow(V1)).ok, true)
})

test('저장 지점: 조용해진 뒤 한 번(그 전에는 아님) · CLI 의 턴이 끝날 때 · 스위치를 끄면 저절로는 안 올림', async () => {
  wc.stop()
  // (1.5 s of quiet, the two writes 0.3 s apart: a file event that comes late does not make a save point early — the check after the
  // second write runs on a timer due before any quiet one)
  const w = make({ quietMs: 1500 })
  await waitFor(() => w.watchers.has(V1), 2000, 'watching again after a restart')
  const vb = vars.get(V1).branch
  const h0 = rev(vb)
  put(e1.dir, 'docs/a.md', '1\n')
  await sleep(300)
  put(e1.dir, 'docs/a.md', '2\n')
  const last = Date.now()
  await sleep(600)
  assert.equal(rev(vb), h0, '바뀐 지 1.5초가 안 됐다')
  await waitFor(() => rev(vb) !== h0, 15000, 'the quiet save point')
  assert.ok(Date.now() - last >= 1500, '마지막 변경에서 조용한 시간이 지난 뒤')
  assert.match(at(vb, 'docs/a.md'), /^2/)
  const h1 = rev(vb)
  await sleep(2000)
  assert.equal(rev(vb), h1, '한 번만')
  // the turn of a CLI in the working copy ended (Claude Code's own record)
  w.stop()
  const w2 = make({ quietMs: 60_000 })
  await waitFor(() => !!w2.turnHub.get(V1), 2000, 'turns watched')
  put(e1.dir, 'docs/b.md', 'claude 가 쓴 것\n')
  const key = W.claudeKey(fs.realpathSync(e1.dir))
  const tx = path.join(CLAUDE, 'projects', key, 's1.jsonl')
  fs.mkdirSync(path.dirname(tx), { recursive: true })
  fs.appendFileSync(tx, `${JSON.stringify({ type: 'user', message: { role: 'user', content: '문서를 고쳐 줘' } })}\n`)
  await waitFor(() => w2.turnBusy(V1), 3000, 'turn started')
  assert.equal(rev(vb), h1)
  fs.appendFileSync(tx, `${JSON.stringify({ type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: '고쳤어요' }] } })}\n`)
  fs.appendFileSync(tx, `${JSON.stringify({ type: 'system', subtype: 'stop_hook_summary' })}\n`)
  await waitFor(() => rev(vb) !== h1, 5000, 'the turn-end save point')
  assert.ok(filesAt(vb).includes('docs/b.md'))
  assert.equal(w2.turnBusy(V1), false)
  // Codex: its rollout's task_complete, in a session whose folder is this working copy
  const h2 = rev(vb)
  const now = new Date()
  const cdir = path.join(CODEX, 'sessions', String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'))
  fs.mkdirSync(cdir, { recursive: true })
  const ro = path.join(cdir, 'rollout-test-1.jsonl')
  fs.writeFileSync(ro, `${JSON.stringify({ type: 'session_meta', payload: { id: 'c1', cwd: e1.dir } })}\n${JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: '고쳐 줘' } })}\n`)
  await waitFor(() => w2.turnBusy(V1), 3000, 'codex turn started')
  put(e1.dir, 'docs/c.md', 'codex 가 쓴 것\n')
  fs.appendFileSync(ro, `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } })}\n`)
  await waitFor(() => rev(vb) !== h2, 5000, 'the codex turn-end save point')
  // the switch off: nothing goes up by itself
  assert.deepEqual(w2.setAuto(V1, false), { ok: true, autoSave: false })
  assert.deepEqual(sentOf('seat:prefs', V1).at(-1), { type: 'seat:prefs', variation: V1, autoSave: false })
  w2.stop()
  const w3 = make({ quietMs: 300 })
  const h3 = rev(vb)
  put(e1.dir, 'docs/d.md', '스위치 끔\n')
  fs.appendFileSync(tx, `${JSON.stringify({ type: 'user', message: { role: 'user', content: '또' } })}\n${JSON.stringify({ type: 'assistant', message: { stop_reason: 'end_turn' } })}\n`)
  await sleep(1200)
  assert.equal(rev(vb), h3, '자동으로 올리기를 끄면 저절로 올리지 않는다')
  // …but the server's word (the switch on the web) turns it on again, and 「지금 올리기」 always goes
  w3.handle({ type: 'seat:prefs', variation: V1, autoSave: true })
  assert.equal(w3.get(V1).autoSave, true)
  w3.setAuto(V1, false)
  // (the tests after this one: the app as it starts in make() — no save point 0.3 s after each file they write)
  w3.stop()
  make()
})

test('돌려놓기: 있는 그대로 올리고 서버가 받은 뒤에만 치운다 — git 이 싣지 않는 파일은 앱 휴지통으로, 사람의 폴더는 그대로', async () => {
  const w = wc
  const vb = vars.get(V1).branch
  put(e1.dir, 'dist/out.js', 'console.log(1)\n')
  put(e1.dir, 'docs/마지막.md', '돌려놓기 직전에 쓴 것\n')
  const dir = e1.dir
  const r = await w.release(V1)
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.ok(filesAt(vb).includes('docs/마지막.md'), '자동으로 올리기를 꺼도 돌려놓을 때는 올린다')
  const rel = sentOf('seat:release', V1).at(-1)
  assert.equal(rel.head, rev(vb))
  assert.ok(!fs.existsSync(dir), '작업 트리는 없다')
  assert.equal(w.get(V1), null)
  assert.ok(r.kept >= 5, `kept ${r.kept}`)
  const trash = fs.readdirSync(w.trashDir()).find((n) => n.includes(`-${V1.slice(0, 8)}-`))
  assert.ok(trash)
  for (const f of ['.env', 'dist/out.js', 'config/app.txt', 'vendor/lib/a.txt']) assert.ok(fs.existsSync(path.join(w.trashDir(), trash, ...f.split('/'))), `휴지통에 ${f}`)
  const repo = path.join(DATA, 'folders', SY.serverKey(srv.base), SY.personKey(USER), FOLDER.slice(0, 8), 'repo')
  assert.ok(fs.existsSync(path.join(repo, 'HEAD')), '받은 객체는 다음을 위해 남긴다')
  assert.ok(!git(repo, 'worktree', 'list').includes(dir))
  assert.deepEqual(treeOf(PERSON), personBefore)
})

test('지난 회차는 이 PC 에서 거절: 더 오래된 준비는 무시 · 다른 회차의 토큰으로는 올리지 않는다', async () => {
  const w = wc
  const v = variation('회차 시험')
  vars.get(v).epoch = 3
  await prepared(w, v)
  const readies = sentOf('seat:ready', v).length
  w.handle(prepareMsg(v, { epoch: 2 }))
  await settled(w, v)
  assert.equal(sentOf('seat:ready', v).length, readies, '옛 회차의 준비는 듣지 않는다')
  assert.equal(w.get(v).epoch, 3)
  // the server's token is for epoch 4: this working copy (3) does not push
  const real = plays.token
  plays.token = (m) => (m.for === 'push' ? { ...real(m), epoch: 4, branch: W.seatBranch(v, 4) } : real(m))
  put(w.get(v).dir, 'x.md', 'x\n')
  const dir = w.get(v).dir
  const r = await w.saveNow(v)
  plays.token = real
  assert.equal(r.ok, false)
  assert.equal(rev(`refs/heads/${W.seatBranch(v, 3)}`), null, '자기 회차 가지로도 올리지 않았다')
  assert.equal(rev(`refs/heads/${W.seatBranch(v, 4)}`), null)
  // what it had went the leftover way: a variation of its own
  assert.ok(sentOf('seat:left', v).length === 1)
  assert.ok(!fs.existsSync(dir))
})

test('자리를 잃은 PC: 서버 목록에 없으면 남은 변경을 새 변형으로 · 새 것이 없으면 그냥 치움 · 올리지 못하면 「남은 변경」으로 둔다', async () => {
  const w = wc
  const lostEvents = []
  w.on('left', (n) => lostEvents.push(n))
  const a = variation('남는 변경 있음')
  const b = variation('새 것 없음')
  const c = variation('올리기 거절')
  for (const v of [a, b, c]) await prepared(w, v)
  put(w.get(a).dir, 'docs/오프라인에서 쓴 것.md', '꺼진 동안 쓴 것\n')
  put(w.get(c).dir, 'docs/남을 것.md', '남는다\n')
  const dirs = [a, b, c].map((v) => w.get(v).dir)
  // the server says the seats are gone (taken from the web while this PC was off); c's leftover token is refused
  const real = plays.token
  plays.token = (m) => (m.variation === c && m.for === 'left' ? { type: 'seat:refused', variation: c, for: 'left', why: 'not_runner' } : real(m))
  const tokensB = sentOf('seat:token', b).length
  w.handle({ type: 'seat:list', seats: [] })
  await waitFor(() => !w.get(a) && !w.get(b) && w.get(c)?.state === 'left', 10000, 'reconciled')
  assert.equal(lostEvents.length, 1)
  assert.match(lostEvents[0].newVariation.title, /남아 있던 변경$/)
  const nb = git(BARE, 'for-each-ref', '--format=%(refname)', 'refs/heads/var/u/left/').trim().split('\n').filter(Boolean)
  assert.ok(nb.some((ref) => filesAt(ref).includes('docs/오프라인에서 쓴 것.md')), '새 변형의 가지에 남은 변경')
  assert.equal(sentOf('seat:token', b).length, tokensB, '새 것이 없으면 올리지 않고 치운다')
  assert.ok(!fs.existsSync(dirs[0]) && !fs.existsSync(dirs[1]))
  assert.ok(fs.existsSync(path.join(dirs[2], 'docs', '남을 것.md')), '올리지 못한 것은 그대로 둔다')
  assert.deepEqual(w.leftovers().map((x) => [x.variationId, x.state, x.why]), [[c, 'left', 'not_runner']])
  assert.ok(!w.list().some((x) => x.variationId === c), '작업본 목록에는 없고 남은 변경 목록에')
  // a new seat for that variation while its leftover is here: refused here (never two working copies of one variation)
  vars.get(c).epoch = 2
  w.handle(prepareMsg(c, { epoch: 2 }))
  await waitFor(() => sentOf('seat:failed', c).length, 5000, 'failed')
  assert.equal(sentOf('seat:failed', c).at(-1).why, 'leftover')
  plays.token = real
  // the person lets it go (main asks in a system dialog first): to the app's trash
  const d = await w.dropLeft(c)
  assert.equal(d.ok, true)
  assert.ok(!fs.existsSync(dirs[2]))
  assert.equal(w.get(c), null)
  // (never thrown away: the whole working copy — what reached no server too — is in the app's trash, 30 days)
  const bin = fs.readdirSync(w.trashDir()).filter((n) => n.includes(c.slice(0, 8))).map((n) => path.join(w.trashDir(), n, 'docs', '남을 것.md'))
  assert.ok(bin.some((f) => fs.existsSync(f)), '버린 남은 변경도 휴지통에')
  // a seat the server lists that this computer does not have (its app data was wiped): it says so
  const ghost = crypto.randomUUID()
  w.handle({ type: 'seat:list', seats: [{ variation: ghost, folderId: FOLDER, epoch: 5, state: 'held' }] })
  await waitFor(() => sentOf('seat:failed', ghost).length, 3000, 'missing')
  assert.equal(sentOf('seat:failed', ghost)[0].why, 'missing')
})

test('git 이 답하지 못하면 작업본을 치우지 않는다 — 커밋 · 상태를 못 읽은 작업본은 「남은 변경」으로 그대로', async () => {
  const w = wc
  const v = variation('망가진 git')
  await prepared(w, v)
  const dir = w.get(v).dir
  put(dir, 'docs/살려야 할 것.md', '지우면 안 된다\n')
  // the working copy's link to its repository broken (another tool, a disk error): git cannot read it any more
  const dotgit = path.join(dir, '.git')
  const was = fs.readFileSync(dotgit, 'utf8')
  rewrite(dotgit, 'gitdir: /nowhere/at/all\n')
  w.handle({ type: 'seat:list', seats: [] })
  await waitFor(() => w.get(v)?.state === 'left', 6000, 'kept as left')
  assert.equal(w.get(v).why, 'failed')
  assert.ok(fs.existsSync(path.join(dir, 'docs', '살려야 할 것.md')), '파일이 그대로')
  // let go by the person later (after it is readable again)
  rewrite(dotgit, was)
  assert.equal((await w.dropLeft(v)).ok, true)
})

test('이어질 때 맞추기: 서버 목록에 있으면 저장 지점 한 번 · 넘기는 중이면 준비됐다고 다시 말함 · 다른 사람이 로그인하면 아무것도 안 함', async () => {
  const w = wc
  const v = variation('다시 이어짐')
  await prepared(w, v)
  put(w.get(v).dir, 'docs/꺼진 동안.md', '링크가 끊긴 동안 쓴 것\n')
  w.linkDown()
  assert.deepEqual(await w.saveNow(v), { ok: false, why: 'offline' })
  w.linkUp({ id: USER })
  const before = rev(vars.get(v).branch)
  w.handle({ type: 'seat:list', seats: [{ variation: v, folderId: FOLDER, epoch: 1, state: 'held', autoSave: true }] })
  await waitFor(() => rev(vars.get(v).branch) !== before, 6000, 'saved on link up')
  assert.ok(filesAt(vars.get(v).branch).includes('docs/꺼진 동안.md'))
  // the server still has it moving (its seat:held did not reach here): ready again — and a refusal of it never takes the working copy away
  const readies = sentOf('seat:ready', v).length
  w.handle({ type: 'seat:list', seats: [{ variation: v, folderId: FOLDER, epoch: 1, state: 'moving' }] })
  await waitFor(() => sentOf('seat:ready', v).length === readies + 1, 3000, 'ready again')
  const real = plays.ready
  plays.ready = (m) => ({ type: 'seat:refused', variation: m.variation, why: 'stale' })
  w.handle({ type: 'seat:list', seats: [{ variation: v, folderId: FOLDER, epoch: 1, state: 'moving' }] })
  await waitFor(() => sentOf('seat:ready', v).length === readies + 2, 3000, 'ready again')
  await settled(w, v)
  plays.ready = real
  assert.equal(w.get(v).state, 'held', '거절만으로는 치우지 않는다 — 서버 목록이 말한다')
  assert.ok(fs.existsSync(w.get(v).dir))
  // someone else signed in on this app: nothing of this person's goes up in their name
  w.linkUp({ id: crypto.randomUUID() })
  assert.deepEqual(await w.saveNow(v), { ok: false, why: 'other_user' })
  w.linkUp({ id: USER })
  // the server asks for it back on behalf of its own person elsewhere (seat:recall auto): the release round by itself
  w.handle({ type: 'seat:recall', variation: v, epoch: 1, auto: true })
  await waitFor(() => !w.get(v), 6000, 'given back')
  // someone else asks: only a notice
  const v2 = variation('돌려 달라는 요청')
  await prepared(w, v2)
  const notes = []
  w.on('recall', (n) => notes.push(n))
  w.handle({ type: 'seat:recall', variation: v2, epoch: 1, auto: false, by: '김동료', why: '오늘 반영해요' })
  assert.deepEqual(notes.map((n) => [n.title, n.by, n.why]), [['돌려 달라는 요청', '김동료', '오늘 반영해요']])
  assert.ok(w.get(v2), '저절로 돌려놓지 않는다')
  await w.release(v2)
})

// ---------- review of P1 (11-26): each of these failed before its fix ----------
const wtRoot = () => path.join(DATA, 'folders', SY.serverKey(srv.base), SY.personKey(USER), FOLDER.slice(0, 8), 'wt')
const trashBins = (needle, file) => { const t = wc.trashDir(); try { return fs.readdirSync(t).filter((n) => n.includes(needle)).map((n) => path.join(t, n)).filter((d) => !file || fs.existsSync(path.join(d, ...file.split('/')))) } catch { return [] } }
// the seats the server lists for this computer: everything the engine holds now (a test's seat:list never drops another test's copies)
const heldNow = (w, but = null) => w.store.all().filter((x) => x.variationId !== but && x.state !== 'left').map((x) => ({ variation: x.variationId, folderId: FOLDER, epoch: Number(x.epoch), state: 'held' }))
const claudeLines = (...es) => es.map((e) => JSON.stringify(e)).join('\n') + '\n'
const PROMPT = { type: 'user', message: { role: 'user', content: '보고서를 고쳐 줘' } }
const ENDED = { type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: '고쳤어요' }] } }

test('검토 1 — .git 이 없어진 작업본: git 이 바깥 저장소로 올라가 커밋하지 않고, 작업본은 지우지 않는다', async () => {
  // the app's data folder inside a repository of the person's (a dotfiles repository at ~), with an edit of theirs not committed
  const HOME = path.join(ROOT, 'home')
  fs.mkdirSync(HOME, { recursive: true })
  git(HOME, 'init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(HOME, '.zshrc'), 'x\n')
  git(HOME, 'add', '-A'); git(HOME, 'commit', '-qm', 'home')
  fs.writeFileSync(path.join(HOME, '.zshrc'), 'x\n사람이 고친 줄\n')
  const head0 = git(HOME, 'rev-parse', 'HEAD').trim()
  const prev = wc
  const w = make({ dataDir: path.join(HOME, 'Library', 'App', 'local-agents'), store: settings.seatStore('http://home.test', USER) })
  try {
    const v = variation('바깥 저장소')
    const e = await prepared(w, v)
    put(e.dir, 'work.txt', '한 시간 동안 한 일\n')
    put(e.dir, 'README.md', '# 고친 제목\n')
    // the working copy's .git file gone (a tool, a half-done removal on Windows)
    fs.rmSync(path.join(e.dir, '.git'))
    w.handle({ type: 'seat:list', seats: [] })
    await waitFor(() => w.get(v)?.state === 'left', 8000, 'kept as a leftover')
    assert.equal(git(HOME, 'rev-parse', 'HEAD').trim(), head0, '바깥 저장소에 커밋하지 않는다')
    assert.equal(git(HOME, 'diff', '--cached', '--name-only').trim(), '', '바깥 저장소의 인덱스에도 아무것도 올리지 않는다')
    assert.match(git(HOME, 'status', '--porcelain'), /\.zshrc/, '사람이 고친 줄은 그대로 커밋되지 않은 채')
    assert.ok(fs.existsSync(e.dir), '작업본은 그 자리에')
    assert.equal(fs.readFileSync(path.join(e.dir, 'work.txt'), 'utf8'), '한 시간 동안 한 일\n')
    assert.equal(sentOf('seat:token', v).filter((m) => m.for === 'left').length, 0, '무엇인지 모르는 것을 올리지 않는다')
  } finally { w.stop(); wc = prev }
})

test('검토 2 — 치울 때는 작업본 전체를 앱 휴지통으로 옮기고, 자리를 잃은 작업본은 도는 CLI 의 턴이 끝나기를 기다린다', async () => {
  const w = wc
  const v = variation('통째로 휴지통')
  const e = await prepared(w, v)
  put(e.dir, 'docs/새 글.md', '새 글\n')
  const r = await w.release(v)
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.ok(!fs.existsSync(e.dir))
  // (given back: the server has every committed file — only what this PC alone had stays in the trash, review 2nd #4)
  assert.equal(trashBins(v.slice(0, 8), 'README.md').length, 0, '서버에 있는 파일은 휴지통에 남기지 않는다')
  // a CLI working in a copy whose seat went: the leftover waits for its turn to end
  const v2 = variation('턴 기다리기')
  const e2 = await prepared(w, v2)
  const proj = path.join(CLAUDE, 'projects', W.claudeKey(fs.realpathSync(e2.dir)))
  fs.mkdirSync(proj, { recursive: true })
  fs.writeFileSync(path.join(proj, 'turn.jsonl'), claudeLines(PROMPT))
  await waitFor(() => w.turnBusy(v2), 8000, 'the turn seen')
  put(e2.dir, 'docs/CLI 가 쓰는 중.md', '반쯤\n')
  const tokens = sentOf('seat:token', v2).length
  const turnWait = w.turnWaitMs
  w.turnWaitMs = 60_000
  try {
    w.handle({ type: 'seat:list', seats: heldNow(w, v2) })
    await sleep(500)
    assert.equal(sentOf('seat:token', v2).length, tokens, '턴이 도는 동안에는 올리지 않는다')
    fs.appendFileSync(path.join(proj, 'turn.jsonl'), claudeLines(ENDED))
    await waitFor(() => !w.get(v2), 15000, 'leftover after the turn')
  } finally { w.turnWaitMs = turnWait }
  assert.ok(sentOf('seat:left', v2).length, '턴이 끝난 뒤에 남은 변경으로 올린다')
})

test('검토 3 · 4 — 작업본 자리는 변형 id 전체로: 남겨진 폴더는 휴지통으로 · 앞 8자리가 같은 두 변형은 따로 · 받는 동안 서버에 알린다', async () => {
  const w = wc
  const v = variation('남겨진 폴더')
  const stale = path.join(wtRoot(), `${v.slice(0, 8)}-남겨진-폴더`)
  put(stale, '옛 파일.md', '옛 것\n') // a folder the app left behind, with no record of it
  const e = await prepared(w, v)
  assert.ok(fs.existsSync(path.join(e.dir, 'README.md')))
  assert.ok(!fs.existsSync(path.join(e.dir, '옛 파일.md')), '남겨진 것은 새 작업본에 섞이지 않는다')
  assert.ok(trashBins(v.slice(0, 8), '옛 파일.md').length, '남겨진 것은 버리지 않고 휴지통에')
  assert.ok(sentOf('seat:preparing', v).length >= 1, '받는 동안 서버에 알린다(넘기기 기한을 늘림)')
  // another variation whose id starts with the same 8 characters
  const twin = variation('쌍둥이', {}, v.slice(0, 8) + crypto.randomUUID().slice(8))
  const t = await prepared(w, twin)
  assert.notEqual(t.dir, w.get(v).dir)
  put(t.dir, '쌍둥이.md', 'x\n')
  assert.ok(!fs.existsSync(path.join(w.get(v).dir, '쌍둥이.md')), '두 변형이 한 작업본을 나눠 쓰지 않는다')
  assert.equal(w.get(v).state, 'held')
  await w.release(twin)
  await w.release(v)
})

test('검토 5 — 서버 목록은 잠금 안에서 다시 본다: 그사이 다시 온 목록에 있으면 치우지 않는다', async () => {
  const w = wc
  const v = variation('목록 다시 보기')
  const e = await prepared(w, v)
  let open
  const hold = w.locked(v, () => new Promise((r) => { open = r }))
  w.handle({ type: 'seat:list', seats: heldNow(w, v) })
  w.handle({ type: 'seat:list', seats: heldNow(w) })
  // (the lock is taken a moment later — both lists wait behind it)
  await waitFor(() => open, 5000, 'the lock held')
  open()
  await hold
  await settled(w, v)
  assert.equal(w.get(v)?.state, 'held', '마지막 목록에 있는 자리')
  assert.ok(fs.existsSync(e.dir))
  assert.equal(sentOf('seat:left', v).length, 0)
  await w.release(v)
})

test('검토 6 — 받다가 멈춘 작업본(준비 중)은 그대로 준비됐다고 하지 않고 다시 받는다', async () => {
  const w = wc
  const v = variation('받다가 멈춤')
  const dir = path.join(wtRoot(), `${v.slice(0, 8)}-받다가-멈춤`)
  put(dir, 'README.md', '반쯤 쓴 파일') // a worktree add that died half way: no .git, half the files
  w.store.put({ variationId: v, folderId: FOLDER, folderName: '영업 제안 키트', title: '받다가 멈춤', branch: vars.get(v).branch, dir, epoch: 1, state: 'preparing', head: null, autoSave: true })
  const e = await prepared(w, v)
  assert.ok(fs.existsSync(path.join(e.dir, '.git')), '작업 트리를 새로 더했다')
  assert.equal(fs.readFileSync(path.join(e.dir, 'README.md'), 'utf8'), '# 영업 제안 키트\n')
  await w.release(v)
  // after a restart the server still has it moving, and the copy never finished: failed, never ready
  const v2 = variation('목록에서 넘기는 중')
  const dir2 = path.join(wtRoot(), `${v2.slice(0, 8)}-목록에서-넘기는-중`)
  put(dir2, 'README.md', '반쯤')
  w.store.put({ variationId: v2, folderId: FOLDER, title: '목록에서 넘기는 중', branch: vars.get(v2).branch, dir: dir2, epoch: 1, state: 'preparing', head: null, autoSave: true })
  w.handle({ type: 'seat:list', seats: [...heldNow(w, v2), { variation: v2, folderId: FOLDER, epoch: 1, state: 'moving' }] })
  await waitFor(() => sentOf('seat:failed', v2).length, 5000, 'failed')
  assert.equal(sentOf('seat:ready', v2).length, 0, '다 받지 못한 작업본은 준비됐다고 하지 않는다')
})

test('검토 7 — 서버가 돌려받은 뒤 작업본을 치우지 못하면 「남은 변경」으로 둔다(다시 쥔 것으로 돌아가지 않음)', async () => {
  const w = wc
  const v = variation('치우지 못함')
  const e = await prepared(w, v)
  put(e.dir, 'dist/out.js', 'x\n')
  const trash = w.trashDir()
  fs.mkdirSync(trash, { recursive: true })
  fs.renameSync(trash, `${trash}.bak`)
  fs.writeFileSync(trash, 'a file where the trash folder goes')
  try {
    const r = await w.release(v)
    assert.equal(r.ok, false)
    assert.equal(w.get(v)?.state, 'left', '서버에서는 이미 보관 중 — 이 PC 에서는 남은 변경')
    assert.ok(fs.existsSync(path.join(e.dir, 'dist', 'out.js')), '아무것도 잃지 않는다')
  } finally { fs.rmSync(trash); fs.renameSync(`${trash}.bak`, trash) }
  assert.equal((await w.dropLeft(v)).ok, true)
})

test('검토 8 — 거절은 그 말에 대한 답일 때만 기다림을 끝낸다(re)', async () => {
  const u = new U.Uploader({ send: () => true, prefix: 'seat:', key: 'variation', askMs: 2000 })
  const p = u.ask({ type: 'seat:release', variation: 'v1' }, ['seat:released'])
  assert.equal(u.answer({ type: 'seat:refused', variation: 'v1', re: 'seat:status', why: 'rate_limited' }), false, '다른 말에 대한 거절')
  assert.equal(u.answer({ type: 'seat:refused', variation: 'v1', re: 'seat:release', why: 'stale' }), true)
  assert.equal((await p).why, 'stale')
  u.stop()
})

test('검토 9 — CLI 기록 읽기: 이미 있던 턴은 다시 세지 않고, 세션 정보가 없는 Codex 기록은 한 번만 보고, 지켜보는 것은 하나', async () => {
  const dir = path.join(ROOT, 'turns', 'a')
  fs.mkdirSync(dir, { recursive: true })
  const proj = path.join(CLAUDE, 'projects', W.claudeKey(fs.realpathSync(dir)))
  fs.mkdirSync(proj, { recursive: true })
  // a session written to just now, with a turn that already ended
  fs.writeFileSync(path.join(proj, 'old.jsonl'), claudeLines(PROMPT, ENDED))
  const hub = new W.TurnHub({ claudeHome: CLAUDE, codexHome: CODEX, every: 40 })
  let ends = 0
  hub.add('a', dir, { onEnd: () => ends++ })
  await sleep(200)
  assert.equal(ends, 0, '이미 있던 턴은 저장 지점이 아니다')
  fs.appendFileSync(path.join(proj, 'old.jsonl'), claudeLines(PROMPT, ENDED))
  await waitFor(() => ends === 1, 3000, 'new turn')
  // a Codex rollout with no session_meta at its head: looked at once, remembered
  const d = new Date()
  const cdir = path.join(CODEX, 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'))
  fs.mkdirSync(cdir, { recursive: true })
  const roll = path.join(cdir, 'rollout-nometa.jsonl')
  fs.writeFileSync(roll, `${JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'x'.repeat(1000) } })}\n`.repeat(80))
  await waitFor(() => hub.codexFiles.get(roll)?.kind === 'other', 8000, 'the rollout looked at')
  // one scanner for every working copy
  const dir2 = path.join(ROOT, 'turns', 'b')
  fs.mkdirSync(dir2, { recursive: true })
  hub.add('b', dir2, { onEnd: () => {} })
  assert.equal(hub.timers(), 1)
  hub.stop()
  assert.equal(hub.timers(), 0)
})

test('검토 10 — 앱 휴지통: 옮긴 것을 알리고, 열 곳을 주고, 30일이 지나면 비우며 너무 크면 알린다(3차 검토 4: 그 전에는 비우지 않음)', async () => {
  const w = wc
  const notes = []
  w.on('trashed', (n) => notes.push(n))
  const v = variation('조용히 옮기지 않기')
  const e = await prepared(w, v)
  put(e.dir, '.env', 'A=1\n') // never committed (a secret's name): nothing new for the server, but it is this PC's
  w.handle({ type: 'seat:list', seats: heldNow(w, v) })
  await waitFor(() => !w.get(v), 8000, 'removed')
  assert.ok(notes.some((n) => n.variationId === v && n.kept >= 1), '휴지통으로 옮긴 것을 알린다')
  assert.equal(w.trashDir(), path.join(w.root, 'trash'))
  assert.ok(w.trashTimer, '때마다 비운다')
  // past 30 days a trash folder goes; over the size cap nothing goes before that — the person is told
  const day = (n) => { const t = new Date(Date.now() - n * 86400_000); return `${t.getFullYear()}${String(t.getMonth() + 1).padStart(2, '0')}${String(t.getDate()).padStart(2, '0')}` }
  const old = path.join(w.trashDir(), `${day(31)}-cap00000-given`)
  const older = path.join(w.trashDir(), `${day(2)}-cap00001-given`)
  const newer = path.join(w.trashDir(), `${day(0)}-cap00002-given`)
  for (const d of [old, older, newer]) { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'big.bin'), Buffer.alloc(4096)) }
  const full = []
  const on = (n) => full.push(n)
  w.on('trash-full', on)
  try { await w.cleanTrash(Date.now(), { maxBytes: 6000 + trashBytes(w.trashDir(), [old, older, newer]) }) } finally { w.off('trash-full', on) }
  assert.ok(!fs.existsSync(old), '30일이 지난 것은 비운다')
  assert.ok(fs.existsSync(older) && fs.existsSync(newer), '크기 한도로는 비우지 않는다')
  assert.equal(full.length, 1, '너무 크면 알린다')
})
function trashBytes(dir, but) {
  let n = 0
  const walk = (d) => { for (const x of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, x.name); if (but.includes(p)) continue; if (x.isDirectory()) walk(p); else n += fs.lstatSync(p).size } }
  walk(dir)
  return n
}

test('검토 12 — git 은 바깥 설정을 따르지 않는다(전역 설정 · 리다이렉트 · 태그 · 객체 검사 · 위로 찾기), 가지 이름에는 변형 id 전체', async () => {
  const full = 'abcdef12-0000-4000-8000-000000000001'
  assert.equal(W.seatBranch(full, 3), `pgpt-agent/seat-${full}-3/head`)
  const w = wc
  const v = variation('바깥 설정 막기')
  const e = await prepared(w, v)
  calls.length = 0
  put(e.dir, 'a.md', 'a\n')
  assert.equal((await w.saveNow(v)).ok, true)
  const push = calls.find((c) => c.sub === 'push')
  assert.ok(push?.args.includes('--no-follow-tags'), '태그를 따라 올리지 않는다')
  assert.ok(calls.length > 3)
  for (const c of calls) {
    assert.equal(c.env?.GIT_CONFIG_GLOBAL, process.platform === 'win32' ? 'NUL' : '/dev/null', `${c.sub}: 사람의 전역 설정 없이`)
    assert.equal(c.env?.GIT_CONFIG_NOSYSTEM, '1')
    assert.equal(c.config?.['http.followRedirects'], 'false')
    assert.equal(c.config?.['fetch.fsckObjects'], 'true')
    assert.equal(c.config?.['push.followTags'], 'false')
    if (c.cwd && !c.gitDir) assert.ok(c.env?.GIT_CEILING_DIRECTORIES, `${c.sub}: 위로 찾아 올라가지 않는다`)
  }
  await w.release(v)
})

// ---------- second review (11-26): each failed before its fix ----------
// a variation whose branch carries entries written as they are (no precomposition: an NFD Hangul name, names that differ only in case)
function variationRaw(title, entries) {
  const vid = variation(title)
  const { branch } = vars.get(vid)
  const idx = path.join(ROOT, `raw-${vid}.index`)
  const env = { ...process.env, GIT_INDEX_FILE: idx }
  const raw = (...a) => execFileSync('git', ['-c', 'core.precomposeUnicode=false', ...a], { cwd: BARE, env, stdio: 'pipe' }).toString().trim()
  raw('read-tree', branch)
  for (const [p, body] of Object.entries(entries)) {
    const sha = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: BARE, input: body }).toString().trim()
    raw('update-index', '--add', '--cacheinfo', `100644,${sha},${p}`)
  }
  const tree = raw('write-tree')
  const commit = raw('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit-tree', tree, '-p', rev(branch), '-m', 'raw names')
  raw('update-ref', `refs/heads/${branch}`, commit)
  fs.rmSync(idx, { force: true })
  return vid
}
const NFD = '보고서.txt'.normalize('NFD')
const pathsAt = (ref) => execFileSync('git', ['-c', 'core.precomposeUnicode=false', 'ls-tree', '-r', '--name-only', '-z', ref], { cwd: BARE }).toString().split('\0').filter(Boolean)
const binsOf = (w, vid) => { try { return fs.readdirSync(w.trashDir()).filter((n) => n.includes(vid.slice(0, 8))).map((n) => path.join(w.trashDir(), n)) } catch { return [] } }
const filesIn = (dir) => { const out = []; const walk = (d, rel) => { for (const x of fs.readdirSync(d, { withFileTypes: true })) { const r = rel ? `${rel}/${x.name}` : x.name; if (x.isDirectory()) walk(path.join(d, x.name), r); else out.push(r) } }; walk(dir, ''); return out.sort() }

test('재검토 1 — 맥의 한글 NFD 이름 · 대소문자만 다른 두 파일: 받을 수 있고, 첫 저장이 겹친 파일 · 지움을 올리지 않는다', { skip: process.platform !== 'darwin' && 'the file names of macOS' }, async () => {
  const w = wc
  const v = variationRaw('한글 이름', { [NFD]: '보고서 처음\n', 'Notes.md': 'upper\n', 'notes.md': 'lower\n' })
  const e = await prepared(w, v)
  assert.equal(w.get(v).state, 'held', '받을 수 있다')
  const before = pathsAt(vars.get(v).branch)
  // the person edits the report (the file the Mac shows with a composed name) and saves
  fs.writeFileSync(path.join(e.dir, '보고서.txt'), '보고서 고침\n')
  const r = await w.saveNow(v)
  assert.equal(r.ok, true, JSON.stringify(r))
  const after = pathsAt(vars.get(v).branch)
  assert.equal(after.filter((p) => p.normalize('NFC') === '보고서.txt').length, 1, '같은 이름의 두 번째 파일을 만들지 않는다')
  assert.deepEqual(after.filter((p) => p.toLowerCase() === 'notes.md').sort(), ['Notes.md', 'notes.md'], '대소문자 쌍은 지워지지 않는다')
  assert.equal(at(vars.get(v).branch, 'notes.md'), 'lower\n')
  assert.equal(at(vars.get(v).branch, 'Notes.md'), 'upper\n')
  assert.deepEqual(after.filter((p) => !before.includes(p)), [], '이름만 다른 새 파일이 생기지 않는다')
  await w.release(v)
})

test('재검토 2 — 남은 변경을 올린 뒤 치우지 못해도, 다시 이어질 때 같은 것을 또 올리지 않는다', async () => {
  const w = wc
  const v = variation('한 번만 올리기')
  const e = await prepared(w, v)
  put(e.dir, 'docs/남을 것.md', '한 번만\n')
  const trash = w.trashDir()
  fs.mkdirSync(trash, { recursive: true })
  fs.renameSync(trash, `${trash}.bak`)
  fs.writeFileSync(trash, 'a file where the trash goes')
  try {
    w.handle({ type: 'seat:list', seats: heldNow(w, v) })
    await waitFor(() => w.get(v)?.state === 'left', 8000, 'left after a failed move')
    assert.equal(sentOf('seat:left', v).length, 1)
    w.handle({ type: 'seat:list', seats: heldNow(w, v) })
    await settled(w, v)
    assert.equal(sentOf('seat:left', v).length, 1, '같은 머리를 또 올리지 않는다')
  } finally { fs.rmSync(trash); fs.renameSync(`${trash}.bak`, trash) }
  w.handle({ type: 'seat:list', seats: heldNow(w, v) })
  await waitFor(() => !w.get(v), 8000, 'moved on the next try')
  assert.equal(sentOf('seat:left', v).length, 1)
})

test('재검토 4 — 휴지통: 서버에 있는 것은 바로 지우고 이 PC 에만 있던 것만 남기며, 서버에 닿지 못한 변경은 30일 전에는 비우지 않는다', async () => {
  const w = wc
  const v = variation('서버에 있는 것은 지움')
  const e = await prepared(w, v)
  put(e.dir, '.env', 'A=1\n')
  put(e.dir, 'node_modules/pkg/index.js', 'module.exports = 1\n')
  put(e.dir, 'docs/새 글.md', '서버로 올라갈 글\n')
  assert.equal((await w.release(v)).ok, true)
  const [bin] = binsOf(w, v)
  assert.ok(bin, '휴지통에 자리가 있다')
  assert.deepEqual(filesIn(bin), ['.env'], '서버에 있는 파일 · 다시 만들 수 있는 것은 남기지 않는다')
  // a let-go leftover (never reached the server) is never evicted by the size cap before 30 days
  const v2 = variation('버린 남은 변경')
  const e2 = await prepared(w, v2)
  put(e2.dir, 'docs/서버에 없음.md', 'x'.repeat(8000))
  const real = plays.token
  plays.token = (m) => (m.variation === v2 && m.for === 'left' ? { type: 'seat:refused', variation: v2, for: 'left', why: 'not_runner' } : real(m))
  w.handle({ type: 'seat:list', seats: heldNow(w, v2) })
  await waitFor(() => w.get(v2)?.state === 'left', 8000, 'left')
  plays.token = real
  assert.equal((await w.dropLeft(v2)).ok, true)
  const [kept] = binsOf(w, v2)
  const cleaned = w.cleanTrash(Date.now(), { maxBytes: 1 })
  assert.ok(cleaned instanceof Promise, '휴지통 비우기는 기다리지 않게(async)')
  await cleaned
  assert.ok(fs.existsSync(path.join(kept, 'docs', '서버에 없음.md')), '서버에 닿지 못한 변경은 30일 동안 둔다')
})

test('재검토 5 — 사람의 git 설정 가운데 네트워크(프록시 · 인증서)만 이어받는다', async () => {
  const w = wc
  const conf = path.join(ROOT, 'person.gitconfig')
  fs.writeFileSync(conf, '[http]\n\tproxy = http://proxy.example.test:3128\n\tsslCAInfo = /etc/company-ca.pem\n[alias]\n\tst = status\n[push]\n\tpushOption = ci.skip\n')
  const was = process.env.GIT_CONFIG_GLOBAL
  process.env.GIT_CONFIG_GLOBAL = conf
  try {
    const pairs = await w.netConfig(srv.base)
    const m = Object.fromEntries(pairs)
    assert.equal(m['http.proxy'], 'http://proxy.example.test:3128')
    assert.equal(m['http.sslCAInfo'] || m['http.sslcainfo'], '/etc/company-ca.pem')
    assert.ok(!pairs.some(([k]) => /alias|pushoption/i.test(k)), '그 밖의 설정은 따르지 않는다')
  } finally { if (was === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = was }
})

test('재검토 6 — 휴지통은 작업본과 같은 자리 아래 · 다른 디스크면 복사해 확인한 뒤 지움 · 치우지 못하면 실패를 알리고 기록을 둔다', async () => {
  const w = wc
  assert.ok(w.trashDir().startsWith(w.root + path.sep), '작업본과 같은 자리 아래')
  // a rename across volumes (EXDEV): copied, checked, then deleted
  const v = variation('다른 디스크')
  const e = await prepared(w, v)
  put(e.dir, '.env', 'B=2\n')
  const rename = fs.renameSync
  let once = true
  fs.renameSync = (a, b) => { if (once && a === e.dir) { once = false; const err = new Error('cross-device'); err.code = 'EXDEV'; throw err } return rename(a, b) }
  try { assert.equal((await w.release(v)).ok, true) } finally { fs.renameSync = rename }
  assert.ok(!fs.existsSync(e.dir))
  assert.ok(binsOf(w, v).some((b) => fs.existsSync(path.join(b, '.env'))), '복사본이 휴지통에')
  // a folder left behind that cannot be moved aside: the prepare fails out loud (seat:failed, open says so)
  const v2 = variation('옮길 수 없는 폴더')
  const stale = path.join(wtRoot(), `${v2.slice(0, 8)}-옮길-수-없는-폴더`)
  put(stale, '옛 것.md', '옛 것\n')
  fs.renameSync = (a, b) => { if (a === stale) { const err = new Error('busy'); err.code = 'EBUSY'; throw err } return rename(a, b) }
  try {
    const waiting = w.open(v2, 8000)
    w.handle(prepareMsg(v2))
    assert.equal((await waiting).ok, false)
    await waitFor(() => sentOf('seat:failed', v2).length, 5000, 'failed said')
  } finally { fs.renameSync = rename }
  assert.ok(fs.existsSync(path.join(stale, '옛 것.md')), '옮기지 못한 것은 그대로')
  // the server still has a seat moving whose copy never finished, and its folder cannot be moved: the record stays
  const v3 = variation('기록은 남김')
  const dir3 = path.join(wtRoot(), `${v3.slice(0, 8)}-기록은-남김`)
  put(dir3, 'README.md', '반쯤')
  w.store.put({ variationId: v3, folderId: FOLDER, title: '기록은 남김', branch: vars.get(v3).branch, dir: dir3, epoch: 1, state: 'preparing', head: null, autoSave: true, added: false })
  fs.renameSync = (a, b) => { if (a === dir3) { const err = new Error('busy'); err.code = 'EBUSY'; throw err } return rename(a, b) }
  try {
    w.handle({ type: 'seat:list', seats: [...heldNow(w, v3), { variation: v3, folderId: FOLDER, epoch: 1, state: 'moving' }] })
    await waitFor(() => sentOf('seat:failed', v3).length, 5000, 'failed')
    await settled(w, v3)
    assert.ok(w.get(v3), '옮기지 못하면 기록을 지우지 않는다')
  } finally { fs.renameSync = rename }
})

test('재검토 7 — 준비 뒤에 도착한 옛 서버 목록은 그 자리를 치우지 않는다', async () => {
  const w = wc
  const v = variation('늦게 온 목록')
  const e = await prepared(w, v, { at: Date.now() })
  w.handle({ type: 'seat:list', at: Date.now() - 60_000, seats: heldNow(w, v) })
  await settled(w, v)
  assert.equal(w.get(v)?.state, 'held', '준비보다 오래된 목록')
  assert.ok(fs.existsSync(e.dir))
  await w.release(v)
})

test('재검토 8 — 돌려놓을 때 작업본 폴더에서 도는 프로그램이 있으면 기다려 달라고 한다 · Codex 기록 목록은 정리한다', async () => {
  const w = wc
  const v = variation('열린 터미널')
  const e = await prepared(w, v)
  if (process.platform !== 'win32') {
    const p = await programIn(w, e.dir)
    try {
      const r = await w.release(v)
      assert.deepEqual([r.ok, r.why], [false, 'in_use'], '터미널 · CLI 가 그 폴더에 있으면 옮기지 않는다')
      assert.ok(fs.existsSync(e.dir))
    } finally { await p.close() }
  }
  assert.equal((await w.release(v)).ok, true)
  // the Codex rollouts the scanner knows: files that are gone are forgotten
  const hub = w.turnHub
  hub.codexFiles.set(path.join(CODEX, 'sessions', '2000', '01', '01', 'rollout-gone.jsonl'), { kind: 'other' })
  hub.pollCodex(true)
  assert.equal([...hub.codexFiles.keys()].some((k) => k.endsWith('rollout-gone.jsonl')), false)
})

// ---------- the third review (11-26) ----------
// whether this disk tells case apart (macOS · Windows usually do not)
const caseless = (() => { try { const d = path.join(ROOT, 'CaseProbe'); fs.mkdirSync(d, { recursive: true }); return fs.existsSync(path.join(ROOT, 'caseprobe')) } catch { return false } })()
const dayAgo = (n) => { const t = new Date(Date.now() - n * 86400_000); return `${t.getFullYear()}${String(t.getMonth() + 1).padStart(2, '0')}${String(t.getDate()).padStart(2, '0')}` }

test('3차 검토 1 — 한 파일로 보는 이름은 그 컴퓨터대로: 한글 조합(NFC)은 맥에서만, 대소문자는 파일 시스템이 가리지 않을 때만', () => {
  const nfd = '보고서.txt'.normalize('NFD')
  const nfc = '보고서.txt'
  const mac = W.foldFor('darwin', true)
  assert.equal(mac(nfd), mac(nfc))
  assert.equal(mac('Guide.md'), mac('guide.md'))
  const linux = W.foldFor('linux', false)
  assert.notEqual(linux(nfd), linux(nfc), '리눅스에서 두 이름은 두 파일')
  assert.notEqual(linux('Guide.md'), linux('guide.md'))
  const win = W.foldFor('win32', true)
  assert.notEqual(win(nfd), win(nfc), 'Windows 도 NFC · NFD 는 두 파일')
  assert.equal(win('Guide.md'), win('guide.md'))
  assert.notEqual(W.foldFor('darwin', false)('Guide.md'), W.foldFor('darwin', false)('guide.md'), '대소문자를 가리는 맥 볼륨')
})

test('3차 검토 1 — 대소문자만 다른 두 파일 가운데 이 PC 에 보이는 것을 고치면: 「확인이 필요해요」로 세고, 올리지 않고, 돌려놓으면 휴지통에 남는다', { skip: !caseless && 'a disk that tells case apart' }, async () => {
  const w = wc
  const v = variationRaw('대소문자 쌍', { 'Guide.md': 'upper original\n', 'guide.md': 'lower original\n' })
  const e = await prepared(w, v)
  await w.sendStatus(v)
  assert.deepEqual([w.get(v).dirty, w.get(v).unsure || 0], [0, 0], '받은 그대로는 바뀐 것이 없다')
  const [name] = fs.readdirSync(e.dir).filter((n) => n.toLowerCase() === 'guide.md')
  fs.writeFileSync(path.join(e.dir, name), '한 시간 동안 고친 것\n')
  await w.sendStatus(v)
  assert.equal(w.get(v).unsure, 1, '「확인이 필요해요」 1')
  assert.equal(w.list().find((x) => x.variationId === v).unsure, 1)
  assert.ok(w.get(v).dirty >= 1, '저장 안 한 변경으로도 센다')
  assert.equal((await w.saveNow(v)).ok, true)
  assert.equal(at(vars.get(v).branch, 'Guide.md'), 'upper original\n', '어느 쪽인지 모르니 올리지 않는다')
  assert.equal(at(vars.get(v).branch, 'guide.md'), 'lower original\n')
  const g = await w.release(v)
  assert.equal(g.ok, true, JSON.stringify(g))
  assert.ok(g.kept >= 1, '이 PC 에만 있는 것이 있다')
  const [bin] = binsOf(w, v)
  assert.ok(filesIn(bin).some((f) => fs.readFileSync(path.join(bin, f), 'utf8').includes('한 시간 동안 고친 것')), '고친 것은 휴지통에 남는다')
})

test('3차 검토 2 — 휴지통에서 지우는 것은 내용이 서버와 같은 파일뿐(상태를 본 뒤에 쓴 파일도 남음) · 프로그램이 폴더에 있으면 남은 변경도 옮기지 않는다', async () => {
  const w = wc
  const v = variation('상태 뒤에 쓴 파일')
  const e = await prepared(w, v)
  const real = w.git.bind(w)
  w.git = async (args, o) => { const out = await real(args, o); if (args[0] === 'status' && args.includes('--ignored=matching')) put(e.dir, 'docs/방금 쓴 글.md', '상태를 본 뒤에 저장\n'); return out }
  let g
  try { g = await w.release(v) } finally { delete w.git }
  assert.equal(g.ok, true, JSON.stringify(g))
  const [bin] = binsOf(w, v)
  assert.ok(fs.existsSync(path.join(bin, 'docs', '방금 쓴 글.md')), '서버에 없는 내용은 남는다')
  assert.ok(!fs.existsSync(path.join(bin, 'docs', '제안서.md')), '서버와 같은 파일은 지운다')
  if (process.platform === 'win32') return
  const v2 = variation('터미널이 열린 남은 변경')
  const e2 = await prepared(w, v2)
  put(e2.dir, 'docs/남을 것.md', '터미널이 열려 있음\n')
  const p = await programIn(w, e2.dir)
  try {
    w.handle({ type: 'seat:list', seats: heldNow(w, v2) })
    await waitFor(() => w.get(v2)?.state === 'left', 8000, 'kept as a leftover')
    assert.equal(w.get(v2).why, 'in_use')
    assert.ok(fs.existsSync(path.join(e2.dir, 'docs', '남을 것.md')), '옮기지 않는다')
  } finally { await p.close() }
  w.handle({ type: 'seat:list', seats: heldNow(w, v2) })
  await waitFor(() => !w.get(v2), 8000, 'moved once the terminal closed')
  assert.equal(sentOf('seat:left', v2).length, 1)
})

test('3차 검토 3 — 다른 디스크로 옮길 때는 파일마다 비교: 수와 크기가 같아도 내용이 다르면 원래 것을 지우지 않는다', async () => {
  const w = wc
  const fsp = require('node:fs/promises')
  const v = variation('다른 디스크 · 파일마다')
  const e = await prepared(w, v)
  put(e.dir, '.env', 'AAAA\n')
  const rename = fs.renameSync
  const cp = fsp.cp
  fs.renameSync = (a, b) => { if (a === e.dir) { const err = new Error('cross-device'); err.code = 'EXDEV'; throw err } return rename(a, b) }
  fsp.cp = async (a, b, o) => { await cp(a, b, o); if (a === e.dir) fs.writeFileSync(path.join(b, '.env'), 'BBBB\n') }
  let g
  try { g = await w.release(v) } finally { fs.renameSync = rename; fsp.cp = cp }
  assert.equal(g.ok, false, '옮기지 못했다고 한다')
  assert.equal(fs.readFileSync(path.join(e.dir, '.env'), 'utf8'), 'AAAA\n', '원래 것은 그대로')
  assert.ok(!binsOf(w, v).some((b) => fs.existsSync(path.join(b, '.env'))), '다르게 나온 복사본은 남기지 않는다')
  assert.equal(w.get(v)?.state, 'left')
  assert.equal((await w.dropLeft(v)).ok, true)
})

test('3차 검토 4 — 휴지통이 크기 한도를 넘어도 30일 전에는 비우지 않고 알린다', async () => {
  const w = wc
  const v = variation('한도를 넘은 휴지통')
  const e = await prepared(w, v)
  put(e.dir, '.env', 'C=3\n')
  assert.equal((await w.release(v)).ok, true)
  const [bin] = binsOf(w, v)
  const older = path.join(w.trashDir(), `${dayAgo(3)}-cap00003-given`)
  put(older, '.env.local', 'old\n')
  const notes = []
  const on = (n) => notes.push(n)
  w.on('trash-full', on)
  try { await w.cleanTrash(Date.now(), { maxBytes: 1 }) } finally { w.off('trash-full', on) }
  assert.ok(fs.existsSync(path.join(older, '.env.local')), '돌려놓은 작업본에서 남긴 것도 30일 전에는 지우지 않는다')
  assert.ok(fs.existsSync(path.join(bin, '.env')))
  assert.equal(notes.length, 1, '한도를 넘었다고 알린다')
  assert.ok(notes[0].bytes > 1)
})

test('3차 검토 5 — 다시 만들 수 있는 것만 지운다: 빌드 파일이 옆에 없는 target · 커밋에서 뺀 큰 파일은 남긴다', async () => {
  const w = wc
  const v = variation('다시 만들 수 있는 것', { '.gitignore': 'dist/\ntarget/\nnode_modules/\n', 'rust/Cargo.toml': '[package]\nname = "x"\n' })
  const e = await prepared(w, v)
  put(e.dir, 'target/내 자료.xlsx', '사람이 만든 자료')
  put(e.dir, 'rust/target/debug/app', 'binary')
  put(e.dir, 'node_modules/pkg/index.js', 'module.exports = 1\n')
  put(e.dir, 'web/.next/cache/big.bin', 'y'.repeat(4096))
  const rules = w.rules
  w.rules = { ...rules, limits: { ...rules.limits, largeFileBytes: 1000 } }
  let g
  try { g = await w.release(v) } finally { w.rules = rules }
  assert.equal(g.ok, true, JSON.stringify(g))
  const [bin] = binsOf(w, v)
  const kept = filesIn(bin)
  assert.ok(kept.includes('target/내 자료.xlsx'), '빌드 파일이 옆에 없는 target 은 사람의 것')
  assert.ok(kept.includes('web/.next/cache/big.bin'), '커밋에서 뺀 큰 파일은 남긴다')
  assert.ok(!kept.includes('rust/target/debug/app'), 'Cargo.toml 옆의 target 은 다시 만든다')
  assert.ok(!kept.includes('node_modules/pkg/index.js'))
})

test('3차 검토 6 — 「여기로 가져오기」(seat:recall auto)를 터미널 때문에 못 하면 서버에 그렇다고 답한다', { skip: process.platform === 'win32' && 'lsof' }, async () => {
  const w = wc
  const v = variation('가져오기 · 열린 터미널')
  const e = await prepared(w, v)
  const notes = []
  const on = (n) => notes.push(n)
  w.on('recall', on)
  const p = await programIn(w, e.dir)
  try {
    w.handle({ type: 'seat:recall', variation: v, epoch: vars.get(v).epoch, auto: true })
    await waitFor(() => sentOf('seat:refused', v).length, 8000, 'refused said')
    const m = sentOf('seat:refused', v)[0]
    assert.deepEqual([m.re, m.why, m.epoch], ['seat:recall', 'in_use', vars.get(v).epoch])
    assert.ok(fs.existsSync(e.dir))
    assert.ok(notes.some((n) => n.variationId === v && n.inUse), '이 PC 에도 알린다')
  } finally { await p.close(); w.off('recall', on) }
  assert.equal((await w.release(v)).ok, true)
})

// ---------- the fourth review (11-26) ----------
test('4차 검토 1 — 돌려놓기를 기다리는 동안 터미널에서 커밋하면: 서버가 받은 머리가 아니니 휴지통에서 지우지 않고, 그 커밋은 앱 저장소에 남는다', async () => {
  const w = wc
  const v = variation('기다리는 동안 커밋')
  const e = await prepared(w, v)
  put(e.dir, 'docs/올라갈 글.md', '올라감\n')
  const real = plays.release
  let local = null
  plays.release = (m) => {
    if (m.variation === v && !local) {
      put(e.dir, 'new-work.txt', '터미널에서 커밋\n')
      git(e.dir, 'add', 'new-work.txt')
      git(e.dir, 'commit', '-qm', 'my own commit')
      local = git(e.dir, 'rev-parse', 'HEAD').trim()
    }
    return real(m)
  }
  let g
  try { g = await w.release(v) } finally { plays.release = real }
  assert.equal(g.ok, true, JSON.stringify(g))
  const [bin] = binsOf(w, v)
  assert.ok(fs.existsSync(path.join(bin, 'new-work.txt')), '서버가 받지 않은 커밋의 파일은 휴지통에 남는다')
  const repo = path.join(w.folderDir(FOLDER), 'repo')
  const kept = execFileSync('git', ['for-each-ref', '--format=%(objectname)', 'refs/kept/'], { cwd: repo }).toString().trim().split('\n')
  assert.ok(kept.includes(local), '그 커밋은 앱 저장소에 남는다(refs/kept/)')
  // (kept as long as the trash: past 30 days the ref goes)
  const stale = `refs/kept/${v}-${dayAgo(31)}-120000`
  git(repo, 'update-ref', stale, local)
  await w.cleanTrash(Date.now(), { say: false })
  const after = execFileSync('git', ['for-each-ref', '--format=%(refname)', 'refs/kept/'], { cwd: repo }).toString().trim().split('\n')
  assert.ok(!after.includes(stale) && after.length >= 1, '30일이 지난 것만 지운다')
  // the usual give-back (nothing committed meanwhile) still keeps only what the server lacks
  const v2 = variation('보통의 돌려놓기')
  const e2 = await prepared(w, v2)
  put(e2.dir, 'docs/올라갈 글.md', '올라감\n')
  assert.equal((await w.release(v2)).ok, true)
  assert.deepEqual(filesIn(binsOf(w, v2)[0]), [], '서버가 받은 것은 남기지 않는다')
})

test('4차 검토 2 — 확인이 필요한 파일이 있으면 「여기로 가져오기」(자동)는 돌려놓지 않고 그렇다고 답하며, 직접 돌려놓으면 그 이름을 알린다', { skip: !caseless && 'a disk that tells case apart' }, async () => {
  const w = wc
  const v = variationRaw('쌍이 있는 돌려놓기', { 'Plan.md': 'upper\n', 'plan.md': 'lower\n' })
  const e = await prepared(w, v)
  assert.deepEqual((await w.commitAsIs(w.get(v), '저장 지점')).unsureFiles, [], '받은 그대로의 쌍은 확인할 것이 없다')
  const [name] = fs.readdirSync(e.dir).filter((n) => n.toLowerCase() === 'plan.md')
  fs.writeFileSync(path.join(e.dir, name), '고친 계획\n')
  const asked = []
  const on1 = (n) => asked.push(n)
  w.on('recall', on1)
  try {
    w.handle({ type: 'seat:recall', variation: v, epoch: vars.get(v).epoch, auto: true })
    await waitFor(() => sentOf('seat:refused', v).length, 8000, 'refused said')
  } finally { w.off('recall', on1) }
  const m = sentOf('seat:refused', v)[0]
  assert.deepEqual([m.re, m.why], ['seat:recall', 'unsure'])
  assert.ok(fs.existsSync(e.dir), '그대로 둔다')
  assert.ok(asked.some((n) => n.variationId === v && n.unsure), '이 PC 에도 알린다')
  await w.sendStatus(v)
  assert.deepEqual(w.list().find((x) => x.variationId === v).unsureFiles, ['Plan.md · plan.md'], '앱 화면은 그 이름을 안다')
  assert.ok(!JSON.stringify(sentOf('seat:status', v)).includes('Plan.md'), '서버에는 이름을 보내지 않는다')
  const notes = []
  const on2 = (n) => notes.push(n)
  w.on('released', on2)
  let g
  try { g = await w.release(v) } finally { w.off('released', on2) }
  assert.equal(g.ok, true, JSON.stringify(g))
  assert.deepEqual(g.unsureFiles, ['Plan.md · plan.md'])
  assert.deepEqual(notes.at(-1)?.unsureFiles, ['Plan.md · plan.md'], '알림에도 그 이름')
})

test('4차 검토 3 — 터미널 때문에 남은 변경을 옮기지 못하면 때마다 다시 하고, 그동안 다시 받으려 하면 까닭을 그대로 말한다', { skip: process.platform === 'win32' && 'lsof' }, async () => {
  const w = wc
  const was = w.leftRetryMs
  w.leftRetryMs = 300
  const v = variation('때마다 다시')
  const e = await prepared(w, v)
  put(e.dir, 'docs/남을 것.md', '터미널이 열려 있음\n')
  const p = await programIn(w, e.dir)
  try {
    w.handle({ type: 'seat:list', seats: heldNow(w, v) })
    await waitFor(() => w.get(v)?.why === 'in_use', 8000, 'in use')
    // asked to have it again meanwhile: the reason is the open terminal, not 「남은 변경」
    vars.get(v).epoch++
    vars.get(v).state = 'moving'
    const waiting = w.open(v, 8000)
    w.handle(prepareMsg(v))
    assert.equal((await waiting).why, 'in_use')
    await waitFor(() => sentOf('seat:failed', v).length, 8000, 'failed said')
    assert.equal(sentOf('seat:failed', v).at(-1).why, 'in_use')
  } finally { await p.close() }
  // no new seat:list: the app tries again by itself
  try { await waitFor(() => !w.get(v), 15000, 'moved by the retry') } finally { w.leftRetryMs = was }
  assert.equal(sentOf('seat:left', v).length, 1)
})

// ---------- the index shared with the person's own git (flaky runs under load, 11-26) ----------
test('흔들림 1 — 앱의 git 은 인덱스의 선택 잠금을 잡지 않는다: 사람이 같은 폴더에서 git add 를 해도 앱의 상태 보기 때문에 실패하지 않는다', async () => {
  const w = wc
  const v = variation('인덱스 함께 쓰기', Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`docs/f${i}.md`, `${i}\n`])))
  const e = await prepared(w, v)
  calls.length = 0
  await w.counts(w.get(v))
  const st = calls.filter((c) => c.sub === 'status')
  assert.ok(st.length && st.every((c) => c.env.GIT_OPTIONAL_LOCKS === '0'), '상태 보기는 잠금 없이')
  // the person's `git add` while the app keeps looking at the counts (each look after files changed refreshes the index)
  const { execFile } = require('node:child_process')
  const add = () => new Promise((resolve) => execFile('git', ['add', '-A'], { cwd: e.dir }, (err, _o, stderr) => resolve(err ? String(stderr) : null)))
  const failed = []
  for (let i = 0; i < 40; i++) {
    for (let k = 0; k < 20; k++) fs.utimesSync(path.join(e.dir, 'docs', `f${k}.md`), new Date(), new Date(Date.now() - i * 1000 - k))
    const [r] = await Promise.all([add(), w.counts(w.get(v)), w.counts(w.get(v))])
    if (r) failed.push(r)
  }
  assert.deepEqual(failed, [], '사람의 git add 가 index.lock 때문에 실패하지 않는다')
  git(e.dir, 'reset', '-q')
  assert.equal((await w.release(v)).ok, true)
})

test('흔들림 2 — 사람의 git 이 인덱스를 잠그고 있으면 앱의 저장 지점은 잠시 기다렸다가 만든다', async () => {
  const w = wc
  const v = variation('잠긴 인덱스')
  const e = await prepared(w, v)
  put(e.dir, 'docs/잠긴 동안.md', '잠긴 동안 고침\n')
  const lock = path.join(git(e.dir, 'rev-parse', '--absolute-git-dir').trim(), 'index.lock')
  fs.writeFileSync(lock, '')
  const freed = new Promise((r) => setTimeout(() => { fs.rmSync(lock, { force: true }); r() }, 500))
  const r = await w.saveNow(v)
  await freed
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.ok(filesAt(vars.get(v).branch).includes('docs/잠긴 동안.md'))
  assert.equal((await w.release(v)).ok, true)
})

test('흔들림 3 — 앱이 막 띄우는 자기 프로세스(fork 와 exec 사이)는 폴더를 쓰는 프로그램으로 세지 않는다 · 사람이 띄운 node 는 센다', { skip: process.platform === 'win32' && 'lsof' }, async () => {
  const w = wc
  const v = variation('막 띄운 프로세스')
  const e = await prepared(w, v)
  const { spawn } = require('node:child_process')
  const real = fs.realpathSync(e.dir)
  const cwdOf = (pid) => { try { return execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']).toString().split('\n').find((l) => l.startsWith('n'))?.slice(1) } catch { return null } }
  // the app's own binary as its child, in the folder — what lsof sees for an instant while the app starts git there
  const own = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { cwd: e.dir, stdio: 'ignore' })
  try {
    await waitFor(() => cwdOf(own.pid) === real, 15000, 'the child in the folder')
    assert.equal(await w.inUse(e.dir), false, '앱 자신의 자식(아직 exec 전)은 세지 않는다')
  } finally { own.kill() }
  // a node program the person started there (a dev server in their terminal — not the app's child): it counts
  const out = execFileSync('/bin/sh', ['-c', '( cd "$1" && exec "$2" -e "setTimeout(() => {}, 60000)" ) </dev/null >/dev/null 2>&1 & echo $!', 'sh', e.dir, process.execPath]).toString().trim()
  const theirs = Number(out)
  try {
    await waitFor(() => cwdOf(theirs) === real, 15000, 'their program in the folder')
    assert.equal(await w.inUse(e.dir), true, '사람이 띄운 node 는 센다')
  } finally { try { process.kill(theirs) } catch { /* gone */ } }
  await waitFor(async () => !(await w.inUse(e.dir)), 15000, 'gone')
  assert.equal((await w.release(v)).ok, true)
})

// ---------- review of PR #112 (11-27): each failed before its fix ----------
const appRepo = () => path.join(path.dirname(wtRoot()), 'repo')
const whyOf = (w, v) => w.list().find((x) => x.variationId === v)?.why ?? null

test('5차 검토 1 — 끝나지 않은 병합 · cherry-pick · rebase 는 커밋하지도 올리지도 않는다(「병합 중」) · merge --abort 는 그대로 된다 · CLI 의 턴 가운데 조용해져도 안 올림', async () => {
  const w = wc || make()
  const v = variation('병합 중', { '계획.md': '첫 줄\n' })
  const e = await prepared(w, v)
  const branch = vars.get(v).branch
  // the person's own git in their terminal: a side line of work, then a merge of it that conflicts
  git(e.dir, 'checkout', '-q', '-b', `side-${v.slice(0, 8)}`)
  put(e.dir, '계획.md', '옆 줄\n'); git(e.dir, 'commit', '-qam', '옆')
  git(e.dir, 'checkout', '-q', branch)
  put(e.dir, '계획.md', '내 줄\n'); git(e.dir, 'commit', '-qam', '내 것')
  const mine = git(e.dir, 'rev-parse', 'HEAD').trim()
  assert.throws(() => git(e.dir, 'merge', `side-${v.slice(0, 8)}`), '충돌')
  assert.ok(git(e.dir, 'ls-files', '-u').trim(), '충돌이 색인에')
  const server = rev(branch)
  const tokens = sentOf('seat:token', v).length
  assert.deepEqual(await w.saveNow(v), { ok: false, why: 'in_progress' })
  assert.equal(git(e.dir, 'rev-parse', 'HEAD').trim(), mine, '병합을 대신 끝내지 않는다')
  assert.equal(sentOf('seat:token', v).length, tokens, '올리지 않는다')
  assert.equal(rev(branch), server)
  assert.equal(whyOf(w, v), 'in_progress', '화면에 「병합 중이라 올리지 않았어요」')
  // resolved in the index but not committed: still a merge under way (MERGE_HEAD)
  put(e.dir, '계획.md', '합친 줄\n'); git(e.dir, 'add', '계획.md')
  assert.equal(git(e.dir, 'ls-files', '-u').trim(), '')
  assert.equal((await w.saveNow(v)).why, 'in_progress')
  // 돌려놓기 waits for it too — the working copy stays
  assert.equal((await w.release(v)).why, 'in_progress')
  assert.ok(fs.existsSync(e.dir))
  // the person aborts: their branch as it was — and the next save point takes it
  git(e.dir, 'merge', '--abort')
  assert.equal(git(e.dir, 'status', '--porcelain').trim(), '')
  assert.equal(fs.readFileSync(path.join(e.dir, '계획.md'), 'utf8'), '내 줄\n')
  assert.equal((await w.saveNow(v)).ok, true)
  assert.equal(rev(branch), mine)
  assert.equal(whyOf(w, v), null)
  // a cherry-pick that stopped (CHERRY_PICK_HEAD), a rebase under way (rebase-merge/ — no branch checked out then): the same
  assert.throws(() => git(e.dir, 'cherry-pick', `side-${v.slice(0, 8)}`))
  assert.equal((await w.saveNow(v)).why, 'in_progress')
  git(e.dir, 'cherry-pick', '--abort')
  assert.throws(() => git(e.dir, 'rebase', `side-${v.slice(0, 8)}`))
  assert.equal((await w.saveNow(v)).why, 'in_progress', '가지가 떨어져 있어도 「병합 중」')
  git(e.dir, 'rebase', '--abort')
  assert.equal(git(e.dir, 'symbolic-ref', 'HEAD').trim(), `refs/heads/${branch}`)
  // the files going quiet in the middle of a CLI's turn there: no save point (its end makes one)
  put(e.dir, '턴 가운데.md', '쓰는 중\n')
  const turn = w.turnHub.get(v)
  turn.busy = true
  turn.startedAt = Date.now()
  const before = sentOf('seat:token', v).length
  w.auto(v, 'quiet')
  await settled(w, v)
  assert.equal(sentOf('seat:token', v).length, before, '턴이 끝나기 전에는 올리지 않는다')
  turn.busy = false
  w.auto(v, 'turn')
  await waitFor(() => filesAt(branch).includes('턴 가운데.md'), 6000, 'the turn end saves')
  await w.release(v)
})

test('5차 검토 2 — 앱 밖에서 지운 작업본: 다음 「이 PC 에서 작업」이 막히지 않고, 그 가지에만 있던 안 올린 커밋은 앱 저장소(refs/kept)에 남는다', async () => {
  let w = wc || make()
  const v = variation('밖에서 지움')
  const e = await prepared(w, v)
  put(e.dir, '메모.md', '안 올린 메모\n'); git(e.dir, 'add', '-A'); git(e.dir, 'commit', '-qm', '안 올림')
  const unsent = git(e.dir, 'rev-parse', 'HEAD').trim()
  w = await deletedOutside(e.dir, w, v)
  // the server lists it held: this PC says it is missing (보관 중 there), git here forgets the working copy
  w.handle({ type: 'seat:list', seats: heldNow(w) })
  await waitFor(() => !w.get(v), 6000, 'forgotten')
  assert.equal(sentOf('seat:failed', v).at(-1)?.why, 'missing')
  assert.ok(git(appRepo(), 'for-each-ref', '--format=%(objectname)', 'refs/kept/').includes(unsent), '안 올린 커밋은 refs/kept 에')
  // opened on this PC again (the next epoch): it works
  const sv = vars.get(v)
  sv.epoch = 2; sv.state = 'moving'
  const e2 = await prepared(w, v)
  assert.ok(fs.existsSync(path.join(e2.dir, 'README.md')))
  // deleted again, and the next prepare comes straight away (no list in between): it works too
  w = await deletedOutside(e2.dir, w, v)
  sv.epoch = 3; sv.state = 'moving'
  w.handle(prepareMsg(v))
  const e3 = await waitFor(() => Number(w.get(v)?.epoch) === 3 && w.get(v).state === 'held' && w.get(v), 15000, 'held at epoch 3')
  assert.ok(fs.existsSync(path.join(e3.dir, 'README.md')))
  // a seat the server still has moving and this PC has no record of yet (its prepare on the way): never said to be missing
  const ghost = crypto.randomUUID()
  w.handle({ type: 'seat:list', seats: [...heldNow(w), { variation: ghost, folderId: FOLDER, epoch: 1, state: 'moving' }] })
  await settled(w, v)
  assert.equal(sentOf('seat:failed', ghost).length, 0)
  w.handle({ type: 'seat:list', seats: [...heldNow(w), { variation: ghost, folderId: FOLDER, epoch: 1, state: 'held' }] })
  await waitFor(() => sentOf('seat:failed', ghost).length === 1, 3000, 'a held seat it does not have is said')
  await w.release(v)
})

test('5차 검토 7 — 폴더 저장소 자체 설정(설정 불러오기 · 주소 바꾸기 · http.*)이 있으면 서버로 보내지 않는다 · 인증서는 언제나 확인 · 가지 이름은 - 로 시작하지 않는다', async () => {
  const w = wc || make()
  const v = variation('설정 울타리')
  const e = await prepared(w, v)
  const seat = () => rev(`refs/heads/${W.seatBranch(v, vars.get(v).epoch)}`)
  for (const [k, val] of [['include.path', path.join(ROOT, 'elsewhere.gitconfig')], [`url.http://127.0.0.1:9/.insteadOf`, srv.base], ['http.sslVerify', 'false'], ['http.proxy', 'http://127.0.0.1:9']]) {
    git(appRepo(), 'config', k, val)
    put(e.dir, 'a.md', `${k}\n`)
    const before = seat()
    assert.deepEqual(await w.saveNow(v), { ok: false, why: 'config' }, k)
    assert.equal(seat(), before, `${k}: 올리지 않는다`)
    assert.equal(whyOf(w, v), 'config')
    git(appRepo(), 'config', '--unset', k)
  }
  calls.length = 0
  assert.equal((await w.saveNow(v)).ok, true)
  const push = calls.find((c) => c.sub === 'push')
  assert.equal(push.config['http.sslVerify'], 'true')
  assert.equal(whyOf(w, v), null)
  const G = require('../src/runner/git')
  for (const bad of ['-x', '--upload-pack=x']) assert.throws(() => G.checkRef(bad), bad)
  assert.deepEqual(await w.prepare({ ...prepareMsg(v), branch: '--upload-pack=touch' }), { ok: false, why: 'invalid' })
  await w.release(v)
})

// ---------- re-review of PR #112 (11-27): each failed before its fix ----------
const keptRefs = () => git(appRepo(), 'for-each-ref', '--format=%(objectname) %(refname)', 'refs/kept/').trim().split('\n').filter(Boolean)
const reachable = (sha) => { try { git(appRepo(), 'cat-file', '-e', `${sha}^{commit}`); return keptRefs().some((l) => l.startsWith(sha)) } catch { return false } }

test('6차 검토 A1 · A4 — 폴더가 지워진 채 자리를 잃은 작업본: 안 올린 커밋은 refs/kept 에 남고(다시 받고 돌려놓아도), 그 사람에게 한 번 알리고 폴더에 한 줄', async () => {
  const w = wc || make()
  const v = variation('지운 채 잃음')
  const e = await prepared(w, v)
  put(e.dir, '터미널.md', '터미널에서 커밋\n'); git(e.dir, 'add', '-A'); git(e.dir, 'commit', '-qm', '터미널에서')
  const unsent = git(e.dir, 'rev-parse', 'HEAD').trim()
  const notes = []
  w.on('kept', (n) => notes.push(n))
  await deleteOutside(e.dir, w, v)
  // the seat goes elsewhere meanwhile (taken while off): the list has it no more — the leftover way, with the folder already gone
  const sv = vars.get(v)
  sv.epoch = 2; sv.state = null
  w.handle({ type: 'seat:list', seats: heldNow(w, v) })
  await waitFor(() => !w.get(v), 6000, 'gone the leftover way')
  assert.ok(reachable(unsent), '안 올린 커밋은 refs/kept 에')
  // opened here again, then given back: the kept commit is still there
  sv.epoch = 3; sv.state = 'moving'
  const e3 = await prepared(w, v)
  assert.notEqual(git(e3.dir, 'rev-parse', 'HEAD').trim(), unsent, '새 작업본은 서버의 머리에서')
  assert.equal((await w.release(v)).ok, true)
  assert.ok(reachable(unsent), '돌려놓은 뒤에도 남는다')
  // said once, and listed with the folder (no path)
  assert.equal(notes.filter((n) => n.variationId === v).length, 1)
  const listed = w.keptOf(FOLDER).filter((k) => k.variationId === v)
  assert.equal(listed.length, 1)
  assert.deepEqual(Object.keys(listed[0]).sort(), ['at', 'folderId', 'ref', 'title', 'variationId'])
  assert.ok(!JSON.stringify(listed).includes(ROOT))
})

test('6차 검토 A5 — 보관하지 못하면 그 가지를 지우지 않고, 다음 받기도 그 가지를 덮지 않는다(받지 않음)', async () => {
  const w = wc || make()
  const v = variation('보관 실패')
  const e = await prepared(w, v)
  put(e.dir, '남길 것.md', '남길 것\n'); git(e.dir, 'add', '-A'); git(e.dir, 'commit', '-qm', '남길 것')
  const unsent = git(e.dir, 'rev-parse', 'HEAD').trim()
  const branch = vars.get(v).branch
  await deleteOutside(e.dir, w, v)
  const real = w.keepCommit
  w.keepCommit = async () => { throw new Error('no room to keep it') }
  try {
    w.handle({ type: 'seat:list', seats: heldNow(w) })
    await waitFor(() => !w.get(v), 6000, 'forgotten')
    assert.equal(git(appRepo(), 'rev-parse', `refs/heads/${branch}`).trim(), unsent, '가지는 그대로')
    const sv = vars.get(v)
    sv.epoch = 2; sv.state = 'moving'
    w.handle(prepareMsg(v))
    await waitFor(() => sentOf('seat:failed', v).some((m) => m.epoch === 2), 6000, 'prepare refused')
    await settled(w, v)
    assert.equal(git(appRepo(), 'rev-parse', `refs/heads/${branch}`).trim(), unsent, '받기가 가지를 덮지 않는다')
  } finally { w.keepCommit = real }
  // the keep works again: the next prepare keeps it, then opens
  const sv = vars.get(v)
  sv.epoch = 3; sv.state = 'moving'
  w.handle(prepareMsg(v))
  await waitFor(() => Number(w.get(v)?.epoch) === 3 && w.get(v).state === 'held', 15000, 'held at 3')
  assert.ok(reachable(unsent))
  await w.release(v)
})

test('6차 검토 A3 — 앱이 켜진 채 폴더를 지우면: 「지금 올리기」 · 「여기로 가져오기」가 바로 「없어졌어요」로 답하고, 다시 이어지지 않아도 다시 받는다', async () => {
  let w = wc || make()
  const v = variation('켜진 채 지움')
  const e = await prepared(w, v)
  w = await deletedOutside(e.dir, w, v)
  assert.deepEqual(await w.saveNow(v), { ok: false, why: 'missing' })
  assert.equal(sentOf('seat:failed', v).at(-1)?.why, 'missing')
  assert.equal(w.get(v), null)
  const sv = vars.get(v)
  sv.epoch = 2; sv.state = 'moving'
  w.handle(prepareMsg(v))
  const e2 = await waitFor(() => Number(w.get(v)?.epoch) === 2 && w.get(v).state === 'held' && w.get(v), 15000, 'held at 2')
  // 「여기로 가져오기」 from elsewhere with the folder gone: said back at once — as the recall's answer, or already by the app's own look at it
  w = await deletedOutside(e2.dir, w, v)
  w.handle({ type: 'seat:recall', variation: v, epoch: 2, auto: true })
  await waitFor(() => sentOf('seat:refused', v).some((m) => m.re === 'seat:recall' && m.why === 'missing') || sentOf('seat:failed', v).some((m) => m.epoch === 2 && m.why === 'missing'), 6000, 'said back')
  await settled(w, v)
  assert.equal(w.get(v), null)
  assert.ok(!logs.some((l) => /not installed/.test(l)), 'git 이 없다고 하지 않는다')
})

test('6차 검토 A2c — 훅 폴더는 아예 없다(/dev/null): 예전 판이 가리키던 자리에 누가 훅을 넣어도 돌지 않는다', async () => {
  const w = wc || make()
  const v = variation('훅 없음')
  const e = await prepared(w, v)
  const none = process.platform === 'win32' ? 'NUL' : '/dev/null'
  assert.equal(git(appRepo(), 'config', 'core.hooksPath').trim(), none)
  const marker = path.join(ROOT, 'hook-ran')
  for (const h of ['post-commit', 'reference-transaction', 'pre-push']) {
    const f = path.join(w.root, 'no-hooks', h)
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, `#!/bin/sh\necho ${h} >> "${marker}"\n`, { mode: 0o755 })
  }
  calls.length = 0
  put(e.dir, 'b.md', 'b\n')
  assert.equal((await w.saveNow(v)).ok, true)
  assert.equal(fs.existsSync(marker), false, '훅이 돌지 않는다')
  assert.ok(calls.every((c) => c.config['core.hooksPath'] === none))
  await w.release(v)
})

test('6차 검토 A2b — 다른 객체 저장소(objects/info/alternates) · core.alternateRefsCommand 가 있으면 서버로 보내지 않는다', async () => {
  const w = wc || make()
  const v = variation('다른 저장소')
  const e = await prepared(w, v)
  const alt = path.join(appRepo(), 'objects', 'info', 'alternates')
  fs.writeFileSync(alt, `${path.join(BARE, 'objects')}\n`)
  put(e.dir, 'c.md', 'c\n')
  try { assert.deepEqual(await w.saveNow(v), { ok: false, why: 'config' }, 'alternates') } finally { fs.rmSync(alt, { force: true }) }
  git(appRepo(), 'config', 'core.alternateRefsCommand', 'true')
  try { assert.deepEqual(await w.saveNow(v), { ok: false, why: 'config' }, 'alternateRefsCommand') } finally { git(appRepo(), 'config', '--unset', 'core.alternateRefsCommand') }
  assert.equal((await w.saveNow(v)).ok, true)
  await w.release(v)
})

test('6차 검토 A2a — 작업 트리별 설정은 --git-dir 로 받을 때도 본다: 그 설정에 프록시가 있으면 다음 받기를 하지 않는다', async () => {
  const w = wc || make()
  const v = variation('작업 트리별 설정')
  await prepared(w, v)
  git(appRepo(), 'config', 'core.repositoryformatversion', '1')
  git(appRepo(), 'config', 'extensions.worktreeConfig', 'true')
  git(appRepo(), 'config', '--worktree', 'http.proxy', 'http://127.0.0.1:9')
  try {
    const v2 = variation('작업 트리별 설정 둘')
    w.handle(prepareMsg(v2))
    await waitFor(() => sentOf('seat:failed', v2).length, 15000, 'prepare refused')
    assert.equal(sentOf('seat:failed', v2).at(-1).why, 'config')
    assert.equal(w.get(v2), null)
  } finally {
    git(appRepo(), 'config', '--worktree', '--unset', 'http.proxy')
    git(appRepo(), 'config', '--unset', 'extensions.worktreeConfig')
    git(appRepo(), 'config', 'core.repositoryformatversion', '0')
  }
  await w.release(v)
})

test('6차 검토 A6 — PC 가 받은 머리가 서버가 준비 요청에 적은 머리가 아니면 작업본을 열지 않고(moved) 시트가 다시 확인하게 한다', async () => {
  const w = wc || make()
  const v = variation('머리가 다름')
  const waiting = w.open(v, 15000)
  w.handle(prepareMsg(v, { head: '0'.repeat(40) }))
  assert.deepEqual(await waiting, { ok: false, why: 'moved' })
  assert.equal(sentOf('seat:failed', v).at(-1)?.why, 'moved')
  assert.equal(w.get(v), null)
  assert.ok(!fs.existsSync(path.join(wtRoot(), `${v.slice(0, 8)}-머리가-다름`)), '작업본을 남기지 않는다')
})

// ---------- Windows (CI 11-27: every prepare stopped short of held) ----------
test('Windows — 앱 데이터 폴더가 짧은 이름(8.3)이거나 대소문자가 달라도 작업본을 확인한다(git 은 긴 이름으로 말한다)', { skip: process.platform !== 'win32' && 'Windows only' }, async () => {
  const w = wc || make()
  const v = variation('short name')
  const e = await prepared(w, v)
  // (the app data folder here is under TEMP, usually a short 8.3 name on a Windows account, while git says the long one: the prepare above
  // reached held only because the two are taken for one folder. The same record in another case is still the app's own working copy)
  await w.checkCopy(e)
  await w.checkCopy({ ...e, dir: e.dir.toUpperCase() })
  assert.equal((await w.release(v)).ok, true)
})

test('createLocalRunner: caps.seats 를 알리고 seat:* 를 넘긴다 · 페이지는 open 으로 기다린다', async () => {
  wc.stop()
  const { createLocalRunner } = require('../src/runner')
  settings.init(path.join(ROOT, 'app'))
  const out = []
  const r = createLocalRunner({ server: srv.base, token: 't', dataDir: DATA, prefs: () => ({ enabled: true }), ask: async () => false, seats: settings.seatStore(srv.base, USER), userId: USER,
    seatOpts: { askMs: 5000, claudeHome: CLAUDE, codexHome: CODEX } })
  try {
    r.link.send = (m) => { out.push(m); const k = { 'seat:ready': 'ready' }[m.type]; const ans = k && plays[k](m); if (ans) setImmediate(() => r.link.emit('message', ans)); return true }
    wc = r.seats
    assert.ok(r.seats)
    assert.equal(r.link.helloFn().caps.seats, true, '0.2.7: 이 PC 에서 작업할 수 있다')
    r.link.emit('welcome', { user: { id: USER, name: '박작업' }, device: { id: crypto.randomUUID(), name: 'x' } })
    assert.equal(r.seats.connected, true)
    const v = variation('페이지에서 열기')
    const waiting = r.seats.open(v, 15000)
    r.link.emit('message', prepareMsg(v))
    assert.deepEqual(await waiting, { ok: true })
    const seen = []
    r.ev.on('seats', (l) => seen.push(l))
    r.link.emit('message', { type: 'seat:prefs', variation: v, autoSave: false })
    assert.equal(seen.at(-1).find((x) => x.variationId === v).autoSave, false)
    r.link.emit('down')
    assert.equal(r.seats.connected, false)
  } finally { r.stop() }
})
