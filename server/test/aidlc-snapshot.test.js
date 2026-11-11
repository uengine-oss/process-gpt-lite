// Robo-DLC Lite P3: the snapshot a running bolt is put back to (lib/aidlc/snapshot.js), on a scratch Git
// repository: the files the bolt changed, deleted and made — and the AI-DLC record, which stays.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import * as S from '../lib/aidlc/snapshot.js'

async function repo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aidlc-snap-'))
  const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@pgpt.test', ...a], { cwd: root, encoding: 'utf8' })
  const write = async (p, text) => { await fs.mkdir(path.dirname(path.join(root, p)), { recursive: true }); await fs.writeFile(path.join(root, p), text) }
  const read = (p) => fs.readFile(path.join(root, p), 'utf8').catch(() => null)
  git('init', '-q', '-b', 'main')
  await write('src/mail.ts', 'send once\n'); await write('src/tick.ts', 'tick\n'); await write('aidlc/audit.md', 'start\n'); await write('.gitignore', 'node_modules/\n')
  git('add', '-A'); git('commit', '-q', '-m', 'base')
  return { root, git, write, read }
}

test('되돌리기: 고친 파일·지운 파일은 예전대로, 새로 만든 파일은 따로 보관, 기록(aidlc/)은 그대로', async () => {
  const { root, git, write, read } = await repo()
  // 볼트 시작 전부터 있던 작업: 커밋 안 한 수정과 새 파일
  await write('src/tick.ts', 'tick v2 (before the bolt)\n'); await write('notes.txt', 'mine\n')
  const snap = await S.take(root, 'i:261112-dup-mail:u5')
  assert.equal(snap.untracked.includes('notes.txt'), true)
  assert.notEqual(snap.object, snap.head)
  // 볼트가 한 일
  await write('src/mail.ts', 'send twice?\n'); await write('src/tick.ts', 'tick v3 (the bolt)\n'); await fs.rm(path.join(root, '.gitignore'))
  await write('src/dedupe.ts', 'new\n'); await write('test/dedupe.test.ts', 'new test\n'); git('add', 'test/dedupe.test.ts')
  await write('aidlc/audit.md', 'start\nbolt worked\n'); await write('aidlc/spaces/x/plan.md', 'plan\n'); await write('node_modules/x/index.js', 'dep\n')
  const d = await S.since(root, snap)
  assert.deepEqual([d.moved, d.changed.sort(), d.made.sort()], [null, ['.gitignore', 'src/mail.ts', 'src/tick.ts', 'test/dedupe.test.ts'], ['node_modules/x/index.js', 'src/dedupe.ts']])
  const r = await S.restore(root, snap, 'i:261112-dup-mail:u5')
  assert.deepEqual(r.restored.sort(), ['.gitignore', 'src/mail.ts', 'src/tick.ts'])
  assert.deepEqual(r.removed.sort(), ['node_modules/x/index.js', 'src/dedupe.ts', 'test/dedupe.test.ts'])
  assert.deepEqual([await read('src/mail.ts'), await read('src/tick.ts'), await read('.gitignore'), await read('notes.txt')], ['send once\n', 'tick v2 (before the bolt)\n', 'node_modules/\n', 'mine\n'])
  assert.deepEqual([await read('src/dedupe.ts'), await read('test/dedupe.test.ts')], [null, null])
  // 버린 파일은 지우지 않고 .git 안에 둔다
  assert.equal(await fs.readFile(path.join(r.aside, 'src/dedupe.ts'), 'utf8'), 'new\n')
  // 기록은 남는다
  assert.deepEqual([await read('aidlc/audit.md'), await read('aidlc/spaces/x/plan.md')], ['start\nbolt worked\n', 'plan\n'])
  // 볼트 전의 상태 그대로: 커밋 안 한 수정 하나, 스테이징 없음
  assert.equal(git('status', '--porcelain', '--', 'src', 'test', '.gitignore').trim(), 'M src/tick.ts')
  await S.drop(root, snap)
  assert.equal(git('for-each-ref', 'refs/lite').trim(), '')
  await fs.rm(root, { recursive: true, force: true })
})

test('깨끗한 작업 폴더에서 시작한 볼트 · 그 뒤 커밋이 생겼으면 손대지 않고 범위만 알린다', async () => {
  const { root, git, write, read } = await repo()
  const snap = await S.take(root, 'b1')
  assert.equal(snap.object, snap.head)
  await write('src/mail.ts', 'changed\n')
  assert.deepEqual((await S.restore(root, snap, 'b1')).restored, ['src/mail.ts'])
  assert.equal(await read('src/mail.ts'), 'send once\n')
  await write('src/mail.ts', 'changed again\n'); git('commit', '-q', '-am', 'the session committed')
  await write('src/tick.ts', 'after the commit\n')
  const r = await S.restore(root, snap, 'b1')
  assert.equal(r.moved.commits, '1')
  assert.deepEqual([r.restored, r.removed], [[], []])
  assert.equal(await read('src/tick.ts'), 'after the commit\n')
  await fs.rm(root, { recursive: true, force: true })
})

test('Git 저장소가 아니면 스냅샷 없음', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aidlc-nogit-'))
  assert.equal(await S.take(dir, 'x'), null)
  await fs.rm(dir, { recursive: true, force: true })
})
