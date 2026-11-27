// 폴더를 끌어다 놓아 올리기 — the server's side (folders/service.js uploadMany · upload, spec openspec/specs/champion-folders 「컴퓨터의 폴더를
// 끌어다 놓아 올린다」): with the local database and real git. What a request writes is one commit; each file is looked at again and the
// ones not kept are said back with their reason; what git does not take is not left on the disk; a commit that fails puts the written
// paths back; one upload's limits count all its requests; only a managed folder takes a folder.
// Run: node --test test/folderDropUpload.test.js  (folders in a temporary directory, rows in the tenant "folder-drop-test", removed after)
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'

const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'pgl-folderdrop-'))
const TENANT = 'folder-drop-test'
process.env.PRO_TENANT_ID = TENANT
process.env.PRO_FOLDERS_ROOT = path.join(ROOT, 'folders')
process.env.PRO_LLM_BASE_URL = 'http://127.0.0.1:9/v1'
process.env.PRO_TENANT_HOSTS = ''

const { q, pool } = await import('../lib/supa.js')
const db = await q('select 1 from pro_folders limit 1').then(() => true).catch(() => false)
const S = await import('../lib/folders/service.js')
const G = await import('../lib/folders/git.js')
const R = await import('../lib/folders/refs.js')
const SECRETS = await import('../lib/folders/secrets.js')
const owner = { id: crypto.randomUUID(), name: '정하윤', email: 'fd-owner@example.test' }
const skip = !db && 'no database'
after(async () => {
  if (db) await q('delete from pro_folders where tenant_id=$1', [TENANT]).catch(() => {})
  await pool.end()
  await fs.rm(ROOT, { recursive: true, force: true })
})
const b = (t) => Buffer.from(t)
const sid = () => crypto.randomBytes(8).toString('hex')
const folder = async (label) => S.createFolder(owner, { name: `${label} ${crypto.randomBytes(3).toString('hex')}` })
const main = (f) => execFileSync('git', ['ls-tree', '-r', '--name-only', '-z', 'main'], { cwd: f.repo_path }).toString().split('\0').filter(Boolean)
const log = (f) => execFileSync('git', ['log', '--format=%an|%s', 'main'], { cwd: f.repo_path }).toString().trim().split('\n')
const onDisk = (f, p) => fsSync.existsSync(path.join(f.repo_path, p))
const untracked = (f) => execFileSync('git', ['status', '--porcelain', '-z', '--untracked-files=all'], { cwd: f.repo_path }).toString().split('\0').filter(Boolean)
const why = (out) => Object.fromEntries(out.refused.map((x) => [x.path, `${x.reason}${x.line ? `:${x.line}` : ''}`]))

test('DR-U-01 한 요청은 한 커밋 — 경로 그대로, 올린 사람 이름 · 「폴더 올리기: 이름 · 파일 N개」', { skip }, async () => {
  const f = await folder('견적 키트')
  const out = await S.uploadMany(f, owner, [{ path: '키트/README.md', buf: b('# 키트\n') }, { path: '키트/docs/쓰는 법.md', buf: b('고객의 말로\n') }],
    { label: '키트', part: 2, parts: 3, session: sid() })
  assert.deepEqual(out.written.sort(), ['키트/README.md', '키트/docs/쓰는 법.md'])
  assert.deepEqual(out.refused, [])
  assert.ok(main(f).includes('키트/docs/쓰는 법.md'))
  assert.equal(log(f)[0], '정하윤|폴더 올리기: 키트 · 파일 2개 (2/3)')
  assert.deepEqual(untracked(f), [])
})

test('DR-U-02 파일마다 다시 본다 — 비밀 이름 · 제어 파일 · 속성 파일 · 열쇠 모양 · 문서 경로가 아님(git 제어 경로의 여러 철자) · 대소문자만 다른 두 번째', { skip }, async () => {
  const f = await folder('다시 보기')
  const PEM = `-----BEGIN ${'RSA PRIVATE'} KEY-----`
  const items = [
    ['k/ok.md', 'ok'], ['k/.env', 'A=1'], ['k/.gitmodules', '[x]'], ['k/sub/.gitattributes', '* filter=x'], ['k/key.txt', `a\n${PEM}\n`],
    ['.GIT/config', 'x'], ['a/.Git/x', 'x'], ['.git./x', 'x'], ['.git /x', 'x'], ['GIT~1/config', 'x'], ['a/.git::$INDEX_ALLOCATION/x', 'x'], ['.g\u200cit/x', 'x'], ['../out.md', 'x'],
    ['k/Readme.md', 'one'], ['k/README.md', 'two'],
    [`k/${'한글'.normalize('NFD')}.md`, 'nfd'],
  ].map(([p, t]) => ({ path: p, buf: b(t) }))
  const out = await S.uploadMany(f, owner, items, { label: 'k', session: sid() })
  assert.deepEqual(why(out), { 'k/.env': 'name', 'k/.gitmodules': 'gitmodules', 'k/sub/.gitattributes': 'gitattributes', 'k/key.txt': 'private_key:2',
    '.GIT/config': 'path', 'a/.Git/x': 'path', '.git./x': 'path', '.git /x': 'path', 'GIT~1/config': 'path', 'a/.git::$INDEX_ALLOCATION/x': 'path', '.g\u200cit/x': 'path',
    '../out.md': 'path', 'k/README.md': 'clash' })
  assert.deepEqual(out.written.sort(), ['k/Readme.md', `k/${'한글'.normalize('NFC')}.md`, 'k/ok.md'].sort())
  for (const p of ['.GIT/config', 'a/.Git/x', '.git./x', '.git /x', 'GIT~1/config', '.git::$INDEX_ALLOCATION/x']) {
    await assert.rejects(S.upload(f, owner, p, b('x')), (e) => e.status === 400, p)
    await assert.rejects(S.removeFile(f, owner, p), (e) => e.status === 400, p)
  }
  await assert.rejects(S.upload(f, owner, 'a/.gitattributes', b('* -text')), (e) => e.status === 400)
  // nothing of them on the disk
  assert.deepEqual(untracked(f), [])
  assert.ok(!onDisk(f, 'k/.env') && !onDisk(f, 'k/sub/.gitattributes'))
})

test('DR-U-03 폴더의 .gitignore 가 빼는 이름은 쓰지 않고 「ignored」로, 한 파일 올리기는 까닭과 함께 거절 — .gitignore 자체는 올리지 않는다', { skip }, async () => {
  const f = await folder('gitignore')
  // the folder's own .gitignore, there before (a champion folder carries one, a workroom can write one)
  fsSync.writeFileSync(path.join(f.repo_path, '.gitignore'), '*.log\nbuild/\n')
  await G.commitAll(f.repo_path, 'ignore', { name: '정하윤', email: 'fd-owner@example.test' })
  let out = await S.uploadMany(f, owner, [{ path: 'a.log', buf: b('log') }, { path: 'build/x.js', buf: b('1') }, { path: 'app.js', buf: b('ok') }, { path: 'sub/.gitignore', buf: b('*\n') }],
    { label: 'g', session: sid() })
  assert.deepEqual(out.written, ['app.js'])
  assert.deepEqual(why(out), { 'a.log': 'ignored', 'build/x.js': 'ignored', 'sub/.gitignore': 'gitignore' })
  assert.ok(!onDisk(f, 'a.log') && !onDisk(f, 'build') && !onDisk(f, 'sub'))
  assert.deepEqual(untracked(f), [])
  assert.equal(log(f)[0], '정하윤|폴더 올리기: g · 파일 1개')
  // a single upload of such a name: said, nothing written · a .gitignore is not taken
  await assert.rejects(S.upload(f, owner, 'later.log', b('x')), (e) => e.status === 409 && e.code === 'ignored')
  assert.ok(!onDisk(f, 'later.log'))
  await assert.rejects(S.upload(f, owner, '.gitignore', b('')), (e) => e.status === 400)
  await assert.rejects(S.upload(f, owner, 'a/.GITIGNORE', b('')), (e) => e.status === 400)
  assert.deepEqual(untracked(f), [])
})

test('DR-U-07 이미 있는 파일 · 폴더와 대소문자만 다른 이름은 쓰지 않는다(어느 서버에서나) — 있던 파일은 그대로, 맥의 이름 형식도 하나로', { skip }, async () => {
  const f = await folder('대소문자')
  await S.uploadMany(f, owner, [{ path: 'README.md', buf: b('원래\n') }, { path: 'docs/a.md', buf: b('a') }], { session: sid() })
  const out = await S.uploadMany(f, owner, [{ path: 'readme.md', buf: b('덮어쓰기\n') }, { path: 'Docs/b.md', buf: b('b') }, { path: 'docs/c.md', buf: b('c') }], { session: sid() })
  assert.deepEqual(out.written, ['docs/c.md'])
  assert.deepEqual(why(out), { 'readme.md': 'clash', 'Docs/b.md': 'clash' })
  await assert.rejects(S.upload(f, owner, 'readme.md', b('덮어쓰기\n')), (e) => e.status === 409 && e.code === 'clash')
  // the same name again in its own case is an update, not a clash
  await S.upload(f, owner, 'README.md', b('고침\n'))
  assert.equal(fsSync.readFileSync(path.join(f.repo_path, 'README.md'), 'utf8'), '고침\n')
  assert.ok(main(f).includes('README.md') && !main(f).includes('readme.md'))
  assert.deepEqual(untracked(f), [])
  // a name in a Mac's Unicode form goes in as one form
  await S.upload(f, owner, `${'한글'.normalize('NFD')}.md`, b('x'))
  assert.ok(main(f).includes(`${'한글'.normalize('NFC')}.md`))
  assert.deepEqual(untracked(f), [])
})

test('DR-U-04 커밋이 실패하면 쓴 경로를 되돌린다 — 새 파일은 지우고, 있던 파일은 마지막 커밋대로', { skip }, async () => {
  const f = await folder('되돌리기')
  await S.uploadMany(f, owner, [{ path: 'keep.md', buf: b('first\n') }], { session: sid() })
  let fail = true
  G.onBeforeCommit(async (cwd) => { if (fail && path.resolve(cwd) === path.resolve(f.repo_path)) throw new Error('commit refused here') })
  await assert.rejects(S.uploadMany(f, owner, [{ path: 'keep.md', buf: b('second\n') }, { path: 'new/one.md', buf: b('new') }], { session: sid() }), /commit refused/)
  fail = false
  assert.equal(fsSync.readFileSync(path.join(f.repo_path, 'keep.md'), 'utf8'), 'first\n')
  assert.ok(!onDisk(f, 'new/one.md') && !onDisk(f, 'new'))
  assert.deepEqual(untracked(f), [])
})

test('DR-U-05 참조 자리 · 연결형 · 스킬 폴더 — 자리는 그 파일만, 관리형이 아니면 요청째 400', { skip }, async () => {
  const src = await folder('원본')
  await S.upload(src, owner, '가격표.md', b('가격'))
  const comp = await folder('구성')
  await R.add(comp, 'owner', owner, { source: src.slug, slot: '자료' })
  const out = await S.uploadMany(comp, owner, [{ path: '자료/덮기.md', buf: b('x') }, { path: '내 것.md', buf: b('y') }], { session: sid() })
  assert.deepEqual(out.written, ['내 것.md'])
  assert.deepEqual(why(out), { '자료/덮기.md': 'ref_readonly' })
  for (const kind of ['linked', 'skill', 'template']) {
    await assert.rejects(S.uploadMany({ ...comp, kind }, owner, [{ path: 'a.md', buf: b('a') }], { session: sid() }), (e) => e.status === 400, kind)
  }
})

test('DR-U-06 한 번의 올리기(묶음 표시)는 여러 요청을 합쳐 파일 수 · 크기 한도를 넘지 못한다, 묶음 표시가 없으면 400', { skip }, async () => {
  const f = await folder('한도')
  const session = sid()
  const tiny = (n, at) => Array.from({ length: n }, (_, i) => ({ path: `${at}/${i}.txt`, buf: Buffer.alloc(1) }))
  const max = SECRETS.BATCH.uploadFiles
  // (counted before anything is written: a request over the limit writes nothing)
  await assert.rejects(S.uploadMany(f, owner, tiny(max + 1, 'a'), { session }), (e) => e.status === 413 && e.code === 'upload_limit' && e.limit.kind === 'files')
  await S.uploadMany(f, owner, tiny(3, 'b'), { session: sid() })
  const s2 = sid()
  await assert.rejects(S.uploadMany(f, owner, [{ path: 'big.bin', buf: Buffer.alloc(1) }], { session: s2 }).then(() =>
    S.uploadMany(f, owner, tiny(max, 'c'), { session: s2 })), (e) => e.status === 413 && e.limit.max === max)
  assert.ok(!main(f).some((p) => p.startsWith('a/') || p.startsWith('c/')))
  await assert.rejects(S.uploadMany(f, owner, tiny(1, 'd'), {}), (e) => e.status === 400)
})

test('DR-U-08 작업실에 쓰기도 git 제어 경로의 여러 철자는 쓰기 전에 거절 — 아무것도 생기지 않는다', async () => {
  const W = await import('../lib/workroom.js')
  const dir = fsSync.realpathSync(await fs.mkdtemp(path.join(ROOT, 'room-')))
  const room = { kind: 'chat', id: 'x', root: dir, cwd: dir }
  for (const p of ['GIT~1/config', 'git~1/HEAD', '.git::$INDEX_ALLOCATION/x', '.Git/config', '.git./x', '.g‌it/x']) {
    await assert.rejects(W.writeFile(room, p, '[core]\n'), (e) => e.status === 400, p)
  }
  assert.deepEqual(fsSync.readdirSync(dir), [])
  // an ordinary name next to them is written
  await W.writeFile(room, 'git~2/a.md', 'a')
  assert.ok(fsSync.existsSync(path.join(dir, 'git~2/a.md')))
})
