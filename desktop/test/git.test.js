'use strict'
// The job clones' git (src/runner/git.js — the folders local steps and chats work in, under the app's data folder): what a folder's
// files cannot make this computer do. The folder token goes only to the folder's own address (http.<address>.extraHeader — an
// .lfsconfig's lfs.url or any other address never gets it); a link the folder holds is checked out as a plain file with the link's
// text (core.symlinks=false); info/attributes turns off every filter (LFS's, or one a person's git config names) and line-ending change,
// whatever the folder's .gitattributes says. The server is test/helpers/gitServer.js (git http-backend behind a Bearer token).
// Run: cd desktop && node --test test/git.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')
const G = require('../src/runner/git')
const { gitServer, makeRepo } = require('./helpers/gitServer')

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pgl-git-'))
const rmQuiet = (d) => { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) } catch (e) { console.warn(`left ${d}: ${e.code}`) } }
const TOKEN = `pgf1.${crypto.randomBytes(12).toString('base64url')}.${crypto.randomBytes(16).toString('base64url')}`
let srv, elsewhere, repo
const url = () => `${srv.base}${srv.path}`

test.before(async () => {
  // a folder whose .gitattributes asks for a filter and CRLF line ends, and which holds a link (recorded as one — mode 120000 — whatever
  // this system can make on disk)
  repo = makeRepo(path.join(ROOT, 'srv', 'f'), { 'a.txt': 'plain\n', '.gitattributes': '*.txt filter=evil text eol=crlf\n' })
  const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: repo.dir, input: '../../outside/secret' }).toString().trim()
  repo.git('update-index', '--add', '--cacheinfo', `120000,${blob},link`)
  repo.git('commit', '-qm', 'a link')
  srv = await gitServer({ repo: repo.dir, token: TOKEN, prefix: '/api/local-git/f.git' })
  // another address (an LFS server a folder's .lfsconfig could name): it records what it is sent
  elsewhere = await gitServer({ repo: repo.dir, token: 'not-this', prefix: '/lfs/f.git' })
})
test.after(async () => { await srv?.close(); await elsewhere?.close(); rmQuiet(ROOT) })

test('토큰은 그 폴더의 주소로만: http.<주소>.extraHeader — 주소 없이 토큰만은 쓰지 않는다', () => {
  const env = G.authEnv(TOKEN, [], url())
  const keys = Object.keys(env).filter((k) => k.startsWith('GIT_CONFIG_KEY_')).map((k) => env[k])
  assert.ok(keys.includes(`http.${new URL(url()).href}.extraHeader`))
  assert.ok(!keys.includes('http.extraHeader'), '모든 주소로 가는 머리글은 없다')
  assert.throws(() => G.authEnv(TOKEN, []), /only with the address/)
  assert.throws(() => G.authEnv(TOKEN, [], 'file:///etc/passwd'), /not used here/)
  assert.deepEqual(Object.keys(G.authEnv('', [])).filter((k) => /^GIT_CONFIG_VALUE_/.test(k)).map((k) => G.authEnv('', [])[k]).filter((v) => v.includes('Bearer')), [])
})

test('다른 주소(예: .lfsconfig 의 lfs.url)로 가는 요청에는 토큰이 실리지 않는다', async () => {
  const dir = path.join(ROOT, 'clone-a')
  await G.sync(dir, { url: url(), token: TOKEN, base: 'main' })
  assert.ok(srv.seen.length > 0 && srv.seen.every((h) => h === `Bearer ${TOKEN}`), '그 폴더의 주소에는 실린다')
  // a request the folder's files could make git send elsewhere, under the same token environment
  await G.git(dir, ['ls-remote', `${elsewhere.base}${elsewhere.path}`], { token: TOKEN, url: url(), check: false })
  assert.ok(elsewhere.seen.length > 0, '다른 주소로 요청이 갔다')
  assert.ok(elsewhere.seen.every((h) => !h.includes(TOKEN)), '그 요청에는 토큰이 없다')
  // the clone's own config never holds it either
  assert.ok(!fs.readFileSync(path.join(dir, '.git', 'config'), 'utf8').includes(TOKEN))
})

test('폴더의 링크는 링크로 받지 않는다(core.symlinks=false) · 필터와 줄 끝 바꾸기는 돌지 않는다(info/attributes)', async () => {
  const dir = path.join(ROOT, 'clone-b')
  await G.sync(dir, { url: url(), token: TOKEN, base: 'main' })
  assert.equal(fs.readFileSync(path.join(dir, '.git', 'info', 'attributes'), 'utf8'), G.NEUTRAL)
  // a filter the person's git config names (here: this clone's config) — it would change what is checked out
  execFileSync('git', ['config', 'filter.evil.smudge', 'sed s/plain/SMUDGED/'], { cwd: dir })
  await G.branch(dir, 'pgpt-agent/local-t1', 'main')
  const link = path.join(dir, 'link')
  assert.equal(fs.lstatSync(link).isSymbolicLink(), false, '링크가 아니라 보통 파일')
  assert.equal(fs.readFileSync(link, 'utf8'), '../../outside/secret')
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'plain\n', '필터도 CRLF 바꾸기도 돌지 않았다')
  const attrs = execFileSync('git', ['check-attr', 'filter', 'text', '--', 'a.txt'], { cwd: dir }).toString()
  assert.match(attrs, /a\.txt: filter: unset/)
  assert.match(attrs, /a\.txt: text: unset/)
  // a clone an older app made (no info/attributes yet) gets it at its next sync
  fs.rmSync(path.join(dir, '.git', 'info', 'attributes'))
  await G.sync(dir, { url: url(), token: TOKEN, base: 'main' })
  assert.equal(fs.readFileSync(path.join(dir, '.git', 'info', 'attributes'), 'utf8'), G.NEUTRAL)
})

test('올리기 · 따라가기도 그 클론의 주소로만 토큰을 보낸다', async () => {
  const dir = path.join(ROOT, 'clone-b')
  fs.writeFileSync(path.join(dir, 'new.md'), '새 글\n')
  assert.ok(await G.commit(dir, 'a step', { name: '김담당', email: 'kim@example.test' }))
  const seen = srv.seen.length
  assert.equal(await G.push(dir, 'pgpt-agent/local-t1', { token: TOKEN }), true)
  assert.equal(repo.git('show', 'pgpt-agent/local-t1:new.md'), '새 글\n')
  assert.ok(await G.follow(dir, { token: TOKEN, base: 'main' }))
  assert.ok(srv.seen.length > seen && srv.seen.slice(seen).every((h) => h === `Bearer ${TOKEN}`))
  assert.equal(G.checkUrl(await G.originOf(dir)), new URL(url()).href)
})
