// Shared folders over git smart HTTP (lib/folders/gitHttp.js): cli-agent runs in its own pod with its own
// disk, so a process step gets its folder as <PRO_GIT_URL>/api/git/<folder id>.git and a token, clones it,
// and pushes its branch pgpt-agent/<run> back.
//   - the token names one tenant and one folder, expires, and is the only way in (Bearer, or Basic password)
//   - a push may only create or move refs/heads/pgpt-agent/…: main, other branches, tags and deletes are
//     refused before git sees them, and the client says "remote rejected"
//   - a push runs in the folder's serial lock, a push over the cap is refused, a gzipped push works
//   - without PRO_GIT_URL a step still gets the repository's path (local development)
// Run: node --test test/folderGitRemote.test.js  (the HTTP part needs the local database; folders go to a
// temporary directory, in the test tenant "gitremote-test", and are removed afterwards)
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import express from 'express'

const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'pgl-gitremote-'))
process.env.PRO_TENANT_ID = 'gitremote-test'
process.env.PRO_FOLDERS_ROOT = path.join(ROOT, 'folders')
// a finished step's variation gets a change card from the model: here nothing answers, so no model is called
process.env.PRO_LLM_BASE_URL = 'http://127.0.0.1:9/v1'
const { config } = await import('../config.js')
const H = await import('../lib/folders/gitHttp.js')

// ---------- token ----------
test('토큰: 만든 그대로 읽히고, 고치거나 기한이 지나면 읽히지 않는다', () => {
  const t = H.mintToken({ tenant: 'gitremote-test', folderId: '11111111-2222-3333-4444-555555555555' })
  const c = H.verifyToken(t)
  assert.equal(c.tenant, 'gitremote-test')
  assert.equal(c.folder, '11111111-2222-3333-4444-555555555555')
  assert.equal(c.push, 'pgpt-agent/')
  assert.ok(Math.abs(c.exp - (Date.now() / 1000 + 72 * 3600)) < 5, '기본 72시간')
  const [, body, sig] = t.split('.')
  const forged = Buffer.from(JSON.stringify({ ...c, folder: '99999999-2222-3333-4444-555555555555' })).toString('base64url')
  assert.equal(H.verifyToken(`pgf1.${forged}.${sig}`), null, '다른 폴더로 고친 토큰')
  assert.equal(H.verifyToken(`pgf1.${body}.${sig.slice(0, -2)}AA`), null, '서명을 고친 토큰')
  assert.equal(H.verifyToken(H.mintToken({ folderId: 'f', hours: -1 })), null, '기한이 지난 토큰')
  assert.equal(H.verifyToken(t, { now: Date.now() + 73 * 3600e3 }), null, '73시간 뒤')
  for (const bad of ['', 'x', 'pgf1.a.b', `pgf2.${body}.${sig}`, null]) assert.equal(H.verifyToken(bad), null, String(bad))
})

test('토큰은 Bearer 로도, Basic 의 비밀번호로도 받는다', () => {
  assert.equal(H.tokenOf({ headers: { authorization: 'Bearer pgf1.a.b' } }), 'pgf1.a.b')
  const basic = (s) => ({ headers: { authorization: `Basic ${Buffer.from(s).toString('base64')}` } })
  assert.equal(H.tokenOf(basic('x:pgf1.a.b')), 'pgf1.a.b')
  assert.equal(H.tokenOf(basic('anyone:pgf1.c.d')), 'pgf1.c.d')
  assert.equal(H.tokenOf(basic('no-colon')), null)
  assert.equal(H.tokenOf({ headers: {} }), null)
})

// ---------- what a push asks for ----------
const Z = '0'.repeat(40)
const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const pkt = (s) => { const b = Buffer.from(s); return Buffer.concat([Buffer.from((b.length + 4).toString(16).padStart(4, '0')), b]) }
const request = (cmds, caps = 'report-status side-band-64k agent=git/2') => Buffer.concat([
  ...cmds.map(([o, n, r], i) => pkt(`${o} ${n} ${r}${i === 0 ? `\0${caps}` : ''}\n`)), Buffer.from('0000'), Buffer.from('PACK…'),
])

test('밀어 넣기 요청의 명령을 읽는다(능력·shallow 줄 포함), 깨진 요청은 거절', () => {
  const body = Buffer.concat([pkt(`shallow ${A}\n`), request([[Z, A, 'refs/heads/pgpt-agent/r1'], [A, B, 'refs/heads/pgpt-agent/r2']])])
  const { commands, caps } = H.parseCommands(body)
  assert.deepEqual(commands, [{ old: Z, new: A, ref: 'refs/heads/pgpt-agent/r1' }, { old: A, new: B, ref: 'refs/heads/pgpt-agent/r2' }])
  assert.ok(caps.has('report-status') && caps.has('side-band-64k'))
  assert.throws(() => H.parseCommands(Buffer.from('zz')), /truncated|malformed/)
  assert.throws(() => H.parseCommands(Buffer.concat([pkt('hello world\n'), Buffer.from('0000')])), /malformed/)
  assert.throws(() => H.parseCommands(Buffer.from('00ffabc')), /malformed/)
})

test('pgpt-agent/ 아래 가지를 만들거나 옮기는 것만 된다', () => {
  assert.equal(H.refusals([{ old: Z, new: A, ref: 'refs/heads/pgpt-agent/r1' }, { old: A, new: B, ref: 'refs/heads/pgpt-agent/x/y' }]), null)
  const why = (ref, old = A, neu = B) => H.refusals([{ old, new: neu, ref }])?.[0]?.why
  assert.match(why('refs/heads/pgpt-agent/r1', A, Z), /deleting/)
  for (const ref of ['refs/heads/main', 'refs/heads/inst/abc', 'refs/heads/var/run/x', 'refs/tags/v1', 'refs/heads/pgpt-agent-x', 'refs/heads/pgpt-agent/',
    'refs/heads/pgpt-agent/../main', 'refs/heads/pgpt-agent/a.lock', 'refs/heads/pgpt-agent//a', 'refs/pgpt-agent/x', 'HEAD']) {
    assert.match(why(ref) || '', /only refs\/heads\/pgpt-agent\/\*/, ref)
  }
  // all or nothing: one bad ref refuses the push
  assert.equal(H.refusals([{ old: Z, new: A, ref: 'refs/heads/pgpt-agent/ok' }, { old: A, new: B, ref: 'refs/heads/main' }]).length, 1)
})

test('거절은 receive-pack 의 상태 보고로: 사이드밴드 1 에 ng, 2 에 까닭', () => {
  const cmds = [{ old: A, new: B, ref: 'refs/heads/main' }]
  const out = H.rejectionReport(cmds, H.refusals(cmds), new Set(['report-status', 'side-band-64k']))
  const frames = []
  for (let at = 0; at < out.length;) {
    const len = parseInt(out.toString('latin1', at, at + 4), 16)
    if (!len) { frames.push(null); at += 4; continue }
    frames.push(out.subarray(at + 4, at + len)); at += len
  }
  assert.equal(frames.at(-1), null, '끝은 flush')
  assert.equal(frames[0][0], 2)
  assert.match(frames[0].subarray(1).toString(), /Process GPT Lite: only refs\/heads\/pgpt-agent\/\*/)
  const report = Buffer.concat(frames.filter((f) => f && f[0] === 1).map((f) => f.subarray(1))).toString()
  assert.match(report, /unpack ok\n/)
  assert.match(report, /ng refs\/heads\/main only refs\/heads\/pgpt-agent\/\* may be pushed here\n/)
  // without a side band: the plain report
  assert.match(H.rejectionReport(cmds, H.refusals(cmds), new Set(['report-status'])).toString(), /^000eunpack ok\n.*ng refs\/heads\/main/s)
})

test('PRO_GIT_URL 이 있으면 단계에 주소와 토큰을, 없으면 저장소 경로를 준다', () => {
  const folder = { id: '11111111-2222-3333-4444-555555555555', kind: 'managed', repo_path: '/data/folders/t/slug' }
  const was = config.gitUrl
  try {
    config.gitUrl = ''
    assert.deepEqual(H.projectRepoFor(folder), { project_repo: '/data/folders/t/slug' })
    config.gitUrl = 'http://process-gpt-lite-server.default.svc.cluster.local:8787/'
    const r = H.projectRepoFor(folder)
    assert.equal(r.project_repo, 'http://process-gpt-lite-server.default.svc.cluster.local:8787/api/git/11111111-2222-3333-4444-555555555555.git')
    const c = H.verifyToken(r.project_repo_token)
    assert.equal(c.folder, folder.id)
    assert.equal(c.tenant, 'gitremote-test')
    // a linked folder is not served over git: it keeps its path
    assert.deepEqual(H.projectRepoFor({ ...folder, kind: 'linked' }), { project_repo: '/data/folders/t/slug' })
  } finally { config.gitUrl = was }
})

// ---------- over HTTP, with real git ----------
const { q, pool } = await import('../lib/supa.js')
const db = await q('select 1 from pro_folders limit 1').then(() => true).catch(() => false)
const S = await import('../lib/folders/service.js')
const G = await import('../lib/folders/git.js')
const made = []
let server, base, smallServer, smallBase
before(async () => {
  if (!db) return
  const app = express()
  app.use('/api/git', H.gitRoutes())
  server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
  base = `http://127.0.0.1:${server.address().port}`
  const small = express()
  small.use('/api/git', H.gitRoutes({ maxPush: 64 * 1024 }))
  smallServer = await new Promise((r) => { const s = small.listen(0, '127.0.0.1', () => r(s)) })
  smallBase = `http://127.0.0.1:${smallServer.address().port}`
})
after(async () => {
  server?.close(); smallServer?.close()
  for (const f of made) await q('delete from pro_folders where id=$1', [f.id]).catch(() => {})
  await pool.end()
  await fs.rm(ROOT, { recursive: true, force: true })
})

const gitc = (cwd, args, env = {}) => new Promise((resolve) => {
  execFile('git', ['-c', 'credential.helper=', '-c', 'user.name=agent', '-c', 'user.email=agent@example.test', ...args],
    { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env } }, (err, stdout, stderr) => resolve({ code: err ? err.code || 1 : 0, stdout, stderr }))
})
const basicUrl = (b, f, tok) => `${b.replace('http://', `http://x:${encodeURIComponent(tok)}@`)}/api/git/${f.id}.git`
const user = { id: crypto.randomUUID(), name: 'git 시험', email: `gitremote-${Date.now()}@example.test` }
async function folderWithFile(name) {
  const f = await S.createFolder(user, { name: `${name} ${Date.now()}` })
  made.push(f)
  await S.upload(f, user, '안내문.md', Buffer.from('# 안내문\n초안\n'))
  return f
}

test('토큰으로 내려받고 pgpt-agent/ 가지를 올린다, main 은 그대로', { skip: !db }, async () => {
  const f = await folderWithFile('git 원격')
  const tok = H.mintToken({ folderId: f.id })
  const dir = path.join(ROOT, 'clone-basic')
  let r = await gitc(ROOT, ['clone', '-q', basicUrl(base, f, tok), dir])
  assert.equal(r.code, 0, r.stderr)
  assert.equal(await fs.readFile(path.join(dir, '안내문.md'), 'utf8'), '# 안내문\n초안\n')
  // Bearer as a header (what cli-agent sends), the URL without credentials
  const dir2 = path.join(ROOT, 'clone-bearer')
  r = await gitc(ROOT, ['-c', `http.extraHeader=Authorization: Bearer ${tok}`, 'clone', '-q', `${base}/api/git/${f.id}.git`, dir2])
  assert.equal(r.code, 0, r.stderr)

  await gitc(dir2, ['checkout', '-q', '-b', 'pgpt-agent/run1'])
  await fs.writeFile(path.join(dir2, '안내문.md'), '# 안내문\n에이전트가 고침\n')
  await gitc(dir2, ['commit', '-qam', '고침'])
  const mainBefore = await G.head(f.repo_path, 'refs/heads/main')
  r = await gitc(dir2, ['-c', `http.extraHeader=Authorization: Bearer ${tok}`, 'push', 'origin', 'pgpt-agent/run1'])
  assert.equal(r.code, 0, r.stderr)
  assert.ok(await G.branchExists(f.repo_path, 'pgpt-agent/run1'))
  assert.equal((await G.show(f.repo_path, 'pgpt-agent/run1', '안내문.md')).toString(), '# 안내문\n에이전트가 고침\n')
  assert.equal(await G.head(f.repo_path, 'refs/heads/main'), mainBefore)
  // the folder's working tree (main) is untouched
  assert.equal(await fs.readFile(path.join(f.repo_path, '안내문.md'), 'utf8'), '# 안내문\n초안\n')
})

test('main · 태그 · 다른 가지 · 지우기는 「remote rejected」, 저장소는 그대로', { skip: !db }, async () => {
  const f = await folderWithFile('git 거절')
  const tok = H.mintToken({ folderId: f.id })
  const auth = ['-c', `http.extraHeader=Authorization: Bearer ${tok}`]
  const dir = path.join(ROOT, 'clone-reject')
  await gitc(ROOT, [...auth, 'clone', '-q', `${base}/api/git/${f.id}.git`, dir])
  await fs.writeFile(path.join(dir, '안내문.md'), '몰래 main 을 고침\n')
  await gitc(dir, ['commit', '-qam', 'main 직접'])
  const mainBefore = await G.head(f.repo_path, 'refs/heads/main')

  let r = await gitc(dir, [...auth, 'push', 'origin', 'HEAD:main'])
  assert.notEqual(r.code, 0)
  assert.match(r.stderr, /\[remote rejected\] HEAD -> main \(only refs\/heads\/pgpt-agent\/\* may be pushed here\)/)
  assert.match(r.stderr, /remote: Process GPT Lite: only refs\/heads\/pgpt-agent\/\*/)
  assert.equal(await G.head(f.repo_path, 'refs/heads/main'), mainBefore)

  r = await gitc(dir, [...auth, 'push', 'origin', 'HEAD:refs/heads/inst/abc'])
  assert.match(r.stderr, /\[remote rejected\]/)
  await gitc(dir, ['tag', 'v1'])
  r = await gitc(dir, [...auth, 'push', 'origin', 'v1'])
  assert.match(r.stderr, /\[remote rejected\] v1 -> v1/)
  // a push with one allowed and one refused ref changes nothing
  r = await gitc(dir, [...auth, 'push', 'origin', 'HEAD:refs/heads/pgpt-agent/mixed', 'HEAD:main'])
  assert.notEqual(r.code, 0)
  assert.equal(await G.branchExists(f.repo_path, 'pgpt-agent/mixed'), false)
  // deleting even an agent branch
  r = await gitc(dir, [...auth, 'push', 'origin', 'HEAD:refs/heads/pgpt-agent/keep'])
  assert.equal(r.code, 0, r.stderr)
  r = await gitc(dir, [...auth, 'push', 'origin', '--delete', 'pgpt-agent/keep'])
  assert.match(r.stderr, /\[remote rejected\] pgpt-agent\/keep \(deleting refs is not allowed here\)/)
  assert.ok(await G.branchExists(f.repo_path, 'pgpt-agent/keep'))
  assert.deepEqual((await G.branches(f.repo_path)).map((b) => b.name).sort(), ['main', 'pgpt-agent/keep'])
})

test('토큰이 없거나 맞지 않으면 401 · 403 · 404', { skip: !db }, async () => {
  const f = await folderWithFile('git 인증')
  const refs = (headers = {}, id = f.id, q2 = '?service=git-upload-pack') => fetch(`${base}/api/git/${id}.git/info/refs${q2}`, { headers })
  let r = await refs()
  assert.equal(r.status, 401)
  assert.match(r.headers.get('www-authenticate'), /^Basic realm="/)
  r = await refs({ authorization: `Bearer ${H.mintToken({ folderId: f.id, hours: -1 })}` })
  assert.equal(r.status, 401, '기한이 지난 토큰')
  r = await refs({ authorization: 'Bearer pgf1.bm9wZQ.bm9wZQ' })
  assert.equal(r.status, 401, '위조한 토큰')
  r = await refs({ authorization: `Bearer ${H.mintToken({ folderId: crypto.randomUUID() })}` })
  assert.equal(r.status, 403, '다른 폴더의 토큰')
  r = await refs({ authorization: `Bearer ${H.mintToken({ tenant: 'not-served-tenant', folderId: f.id })}` })
  assert.equal(r.status, 403, '이 서버가 받지 않는 회사')
  const other = crypto.randomUUID()
  r = await refs({ authorization: `Bearer ${H.mintToken({ folderId: other })}` }, other)
  assert.equal(r.status, 404, '없는 폴더')
  r = await refs({ authorization: `Bearer ${H.mintToken({ folderId: f.id })}` }, f.id, '')
  assert.equal(r.status, 403, '예전(dumb) 방식은 받지 않는다')
  r = await refs({ authorization: `Bearer ${H.mintToken({ folderId: f.id })}` })
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('content-type'), 'application/x-git-upload-pack-advertisement')
  // a linked folder (an existing repository registered as it is) is not served
  const seed = path.join(ROOT, 'linked-src')
  await fs.mkdir(seed, { recursive: true })
  await G.git(seed, ['init', '-q', '-b', 'main'])
  await fs.writeFile(path.join(seed, 'a.txt'), 'a')
  await G.commitAll(seed, 'a')
  const linked = await S.registerLinked(user, seed, { name: `연결형 ${Date.now()}` })
  made.push(linked)
  r = await refs({ authorization: `Bearer ${H.mintToken({ folderId: linked.id })}` }, linked.id)
  assert.equal(r.status, 403)
  // the route answers nothing else
  assert.equal((await fetch(`${base}/api/git/${f.id}.git/HEAD`, { headers: { authorization: `Bearer ${H.mintToken({ folderId: f.id })}` } })).status, 404)
})

test('밀어 넣기는 폴더의 직렬 잠금 안에서: 진행 중인 main 쓰기가 끝난 뒤에 들어간다', { skip: !db }, async () => {
  const f = await folderWithFile('git 잠금')
  const tok = H.mintToken({ folderId: f.id })
  const auth = ['-c', `http.extraHeader=Authorization: Bearer ${tok}`]
  const dir = path.join(ROOT, 'clone-lock')
  await gitc(ROOT, [...auth, 'clone', '-q', `${base}/api/git/${f.id}.git`, dir])
  await gitc(dir, ['checkout', '-q', '-b', 'pgpt-agent/locked'])
  await fs.writeFile(path.join(dir, 'b.md'), 'b\n')
  await gitc(dir, ['add', '-A'])
  await gitc(dir, ['commit', '-qm', 'b'])
  let release
  const order = []
  const writing = S.serial(f.id, () => new Promise((r) => { release = r }).then(() => order.push('main write done')))
  const pushing = gitc(dir, [...auth, 'push', 'origin', 'pgpt-agent/locked']).then((r) => { order.push('push done'); return r })
  await new Promise((r) => setTimeout(r, 1500))
  assert.deepEqual(order, [], '잠금이 풀리기 전에는 끝나지 않는다')
  assert.equal(await G.branchExists(f.repo_path, 'pgpt-agent/locked'), false)
  release()
  await writing
  const r = await pushing
  assert.equal(r.code, 0, r.stderr)
  assert.deepEqual(order, ['main write done', 'push done'])
  assert.ok(await G.branchExists(f.repo_path, 'pgpt-agent/locked'))
})

test('한도를 넘는 밀어 넣기는 413, gzip 으로 보낸 요청도 읽는다', { skip: !db }, async () => {
  const f = await folderWithFile('git 한도')
  const tok = H.mintToken({ folderId: f.id })
  const auth = ['-c', `http.extraHeader=Authorization: Bearer ${tok}`]
  const dir = path.join(ROOT, 'clone-big')
  await gitc(ROOT, [...auth, 'clone', '-q', `${smallBase}/api/git/${f.id}.git`, dir])
  await gitc(dir, ['checkout', '-q', '-b', 'pgpt-agent/big'])
  await fs.writeFile(path.join(dir, 'big.bin'), crypto.randomBytes(256 * 1024))
  await gitc(dir, ['add', '-A'])
  await gitc(dir, ['commit', '-qm', 'big'])
  const r = await gitc(dir, [...auth, 'push', 'origin', 'pgpt-agent/big'])
  assert.notEqual(r.code, 0)
  assert.match(r.stderr, /413/)
  assert.equal(await G.branchExists(f.repo_path, 'pgpt-agent/big'), false)

  // gzip: a ref update to a commit the server already has, with an empty pack
  const main = await G.head(f.repo_path, 'refs/heads/main')
  const header = Buffer.from([0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2, 0, 0, 0, 0])
  const pack = Buffer.concat([header, crypto.createHash('sha1').update(header).digest()])
  const body = Buffer.concat([pkt(`${Z} ${main} refs/heads/pgpt-agent/gz\0report-status side-band-64k\n`), Buffer.from('0000'), pack])
  const res = await fetch(`${base}/api/git/${f.id}.git/git-receive-pack`, {
    method: 'POST', body: zlib.gzipSync(body),
    headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/x-git-receive-pack-request', 'content-encoding': 'gzip' },
  })
  assert.equal(res.status, 200)
  const text = Buffer.from(await res.arrayBuffer()).toString('latin1')
  assert.match(text, /ok refs\/heads\/pgpt-agent\/gz/)
  assert.equal(await G.head(f.repo_path, 'refs/heads/pgpt-agent/gz'), main)
  // and a gzipped push to main is refused the same way
  const bad = Buffer.concat([pkt(`${main} ${main} refs/heads/main\0report-status\n`), Buffer.from('0000'), pack])
  const res2 = await fetch(`${base}/api/git/${f.id}.git/git-receive-pack`, {
    method: 'POST', body: zlib.gzipSync(bad),
    headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/x-git-receive-pack-request', 'content-encoding': 'gzip' },
  })
  assert.match(Buffer.from(await res2.arrayBuffer()).toString(), /ng refs\/heads\/main only refs\/heads\/pgpt-agent/)
})

test('끝난 단계: 올라온 가지는 그 단계의 변형이 되고, 올라온 것이 없으면 변형을 만들지 않는다', { skip: !db }, async () => {
  const { stepOne } = await import('../lib/folders/work.js')
  const f = await folderWithFile('git 단계')
  const variations = async () => q('select branch, kind, status, head_commit, holder_id, source from pro_folder_variations where folder_id=$1', [f.id])
  const row = (id, branch) => ({ id, status: 'DONE', agent_orch: 'cliagents', agent_config: { folder: f.id, project_repo: 'x' }, output: { worktree: { branch, pushed: !!branch } }, activity_name: '안내문 다듬기', proc_inst_id: null })
  // nothing pushed (the run changed nothing): no branch here, no variation
  await stepOne(row(crypto.randomUUID(), 'pgpt-agent/nothing'))
  assert.deepEqual(await variations(), [])
  // pushed over HTTP: the branch becomes the step's variation, ready for review
  const tok = H.mintToken({ folderId: f.id })
  const auth = ['-c', `http.extraHeader=Authorization: Bearer ${tok}`]
  const dir = path.join(ROOT, 'clone-step')
  await gitc(ROOT, [...auth, 'clone', '-q', `${base}/api/git/${f.id}.git`, dir])
  await gitc(dir, ['checkout', '-q', '-b', 'pgpt-agent/step1'])
  await fs.writeFile(path.join(dir, '안내문.md'), '# 안내문\n단계가 고침\n')
  await gitc(dir, ['commit', '-qam', '단계'])
  assert.equal((await gitc(dir, [...auth, 'push', 'origin', 'pgpt-agent/step1'])).code, 0)
  const todo = crypto.randomUUID()
  await stepOne(row(todo, 'pgpt-agent/step1'))
  const [v] = await variations()
  assert.equal(v.branch, 'pgpt-agent/step1')
  assert.equal(v.kind, 'run'); assert.equal(v.status, 'ready'); assert.equal(v.holder_id, 'cliagents')
  assert.equal(v.head_commit, await G.head(f.repo_path, 'refs/heads/pgpt-agent/step1'))
  assert.equal(v.source.todo_id, todo)
  assert.deepEqual((await G.changes(f.repo_path, 'main', v.branch)).map((c) => c.path), ['안내문.md'])
})

test('index.js: git 경로는 본문 파서·세션·회사 미들웨어보다 앞에 붙는다', async () => {
  const src = await fs.readFile(new URL('../index.js', import.meta.url), 'utf8')
  const at = (s) => { const i = src.indexOf(s); assert.ok(i >= 0, s); return i }
  assert.ok(at("app.use('/api/git', gitRoutes())") < at("app.use(express.json({ limit: '2mb' }))"))
  assert.ok(at("app.use('/api/git', gitRoutes())") < at('app.use(tenantMiddleware())'))
})
