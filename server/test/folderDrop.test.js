// 폴더를 끌어다 놓아 올리기 (2026-11-27, 사용자 녹화 11-27): the page's walk of a dropped folder and its plan (src/folderDrop.js) — following
// folders down, leaving out git's data · secrets · personal settings · what can be rebuilt · git's control files · large files · keys of
// a sure shape, the limits of one upload, the names (a dropped folder's name, a new folder's contents) — read with the champion folders'
// own rules (lib/folders/secret-shapes.json through secrets.js pageRules), and the server's own look at each uploaded file (refusalOf).
// Spec: openspec/specs/champion-folders. The screens: e2e/tests/feature/folder-drop.spec.js (F-FD-…).
import test from 'node:test'
import assert from 'node:assert/strict'
import { compileRules, groupOf, dirGroupOf, structureOf, walk, fromPicked, planOf, leftCount, shapesIn, batchesOf, sendPlan, remoteOf, cleanRemote, entriesOf } from '../../src/folderDrop.js'
import { pageRules, refusalOf, groupOf as serverGroupOf } from '../lib/folders/secrets.js'

const rules = compileRules(pageRules())
// key-shaped text made here (the repository is public: no key-shaped literal in this file)
const FAKE_GH = `${'gh'}${'p_'}${'Q7x2'.repeat(9)}`
const PEM = `-----BEGIN ${'RSA PRIVATE'} KEY-----`

// a stand-in for the browser's FileSystemEntry tree of a drop: {name: text | {…}}; `batch` entries per readEntries call (Chrome gives 100)
function fileLike(text, size) {
  const b = new Blob([text])
  return size == null ? b : Object.defineProperty(b, 'size', { value: size })
}
function tree(name, spec, { batch = 2, parent = '' } = {}) {
  const fullPath = `${parent}/${name}`
  if (typeof spec === 'string' || spec instanceof Blob) {
    const f = typeof spec === 'string' ? fileLike(spec) : spec
    return { isFile: true, isDirectory: false, name, fullPath, file: (ok) => ok(f) }
  }
  const kids = Object.entries(spec).map(([n, s]) => tree(n, s, { batch, parent: fullPath }))
  return {
    isFile: false, isDirectory: true, name, fullPath,
    createReader() { let i = 0; return { readEntries(ok) { const b = kids.slice(i, i + batch); i += batch; setTimeout(() => ok(b), 0) } } },
    // (no .git here: repo() below makes one)
    getDirectory(_p, _o, _ok, no) { no(new Error('none')) },
    getFile(_p, _o, _ok, no) { no(new Error('none')) },
  }
}
// a dropped folder that is a git repository: its .git folder and .git/config, as the browser's entries give them
function repo(name, files, gitConfig) {
  const t = tree(name, files)
  const cfg = { isFile: true, name: 'config', fullPath: `/${name}/.git/config`, file: (ok) => ok(fileLike(gitConfig)) }
  t.getFile = (p, _o, ok, no) => (p === '.git/config' && gitConfig != null ? ok(cfg) : no(new Error('none')))
  t.getDirectory = (p, _o, ok, no) => (p === '.git' && '.git' in files ? ok({ isDirectory: true }) : no(new Error('none')))
  return t
}

const PROJECT = {
  'README.md': '# 견적 키트\n',
  'docs': { '안내.md': '고객의 말로 시작한다\n', '표.csv': 'a,b\n1,2\n' },
  'src': { 'app.js': 'console.log(1)\n', 'config.js': `const token = '${FAKE_GH}'\n` },
  '.git': { 'config': '[core]\n', 'objects': { 'ab': 'x' } },
  'node_modules': { 'pkg': { 'index.js': 'module.exports = 1\n' } },
  'pkgs': { 'web': { 'node_modules': { 'x.js': '1' }, 'main.js': 'ok\n' } },
  '.env': 'API_KEY=1\n',
  '.env.example': 'API_KEY=\n',
  '.vscode': { 'settings.json': '{}' },
  '.claude': { 'settings.local.json': '{}', 'settings.json': '{}', 'skills': { 'quote': { 'SKILL.md': '---\nname: quote\n---\n' } } },
  '.gitmodules': '[submodule "x"]\n',
  'key.pem': PEM,
  'video.mp4': fileLike('v', 60 * 1024 * 1024),
  '.DS_Store': 'x',
}

test('the page reads the files with the same groups as the server (and the desktop)', () => {
  for (const p of ['.env', 'a/.env.local', '.env.example', 'id_rsa', 'id_rsa.pub', '.ssh/config', 'x/.aws/credentials', 'node_modules/a.js', 'a/node_modules/b/c.js',
    '.vscode/settings.json', '.claude/settings.local.json', '.claude/settings.json', '.claude/projects/x/y.jsonl', 'docs/a.md', 'cert.PEM', 'Thumbs.db',
    '.codex/auth.json', 'deep/.codex/auth.json', 'target/x.class', 'src/target.js', 'a.pyc', '.pyc']) {
    assert.equal(groupOf(p, rules), serverGroupOf(p), p)
  }
  assert.equal(groupOf('.env', rules), 'secret')
  assert.equal(groupOf('.env.example', rules), null)
  assert.equal(groupOf('a/node_modules/b.js', rules), 'rebuildable')
  assert.equal(groupOf('.claude/settings.local.json', rules), 'personal')
})

test('folders the walk never goes into: git data, and the rules\' folders', () => {
  assert.equal(dirGroupOf('p/.git', rules), 'git')
  assert.equal(dirGroupOf('p/.GIT', rules), 'git')
  assert.equal(dirGroupOf('p/node_modules', rules), 'rebuildable')
  assert.equal(dirGroupOf('p/.ssh', rules), 'secret')
  assert.equal(dirGroupOf('p/.claude/projects', rules), 'personal')
  assert.equal(dirGroupOf('p/.claude', rules), null)
  assert.equal(dirGroupOf('p/docs', rules), null)
  assert.equal(structureOf('a/.gitmodules'), 'structure')
  assert.equal(structureOf('a/.LFSCONFIG'), 'structure')
  assert.equal(structureOf('a/gitmodules.md'), null)
})

test('a dropped folder is followed down with its name first; .git and node_modules are not walked into', async () => {
  const scan = await walk([repo('견적 키트', PROJECT, '[core]\n\tbare = false\n[remote "origin"]\n\turl = https://kim:tok3n@github.com/acme/quote-kit.git\n')], rules)
  const rels = scan.files.map((f) => f.rel).sort()
  assert.ok(rels.includes('견적 키트/docs/안내.md'))
  assert.ok(rels.includes('견적 키트/pkgs/web/main.js'))
  assert.ok(!rels.some((r) => r.includes('/.git/') || r.includes('node_modules')), rels.join(' '))
  assert.deepEqual(scan.pruned.map((p) => `${p.rel}:${p.group}`).sort(), ['견적 키트/.git:git', '견적 키트/.vscode:personal', '견적 키트/node_modules:rebuildable', '견적 키트/pkgs/web/node_modules:rebuildable'])
  assert.deepEqual(scan.roots, [{ name: '견적 키트', dir: true }])
  // the remote's address — never a name or a token in it
  assert.deepEqual(scan.git, { remote: 'github.com/acme/quote-kit', worktree: false })
  assert.equal(scan.truncated, false)
})

test('what stays here and why; what goes up keeps its path from the drop', async () => {
  const scan = await walk([repo('견적 키트', PROJECT, '')], rules)
  const plan = planOf(scan, rules)
  const paths = plan.up.map((u) => u.path).sort()
  assert.deepEqual(paths, ['견적 키트/.claude/settings.json', '견적 키트/.claude/skills/quote/SKILL.md', '견적 키트/.env.example', '견적 키트/README.md',
    '견적 키트/docs/안내.md', '견적 키트/docs/표.csv', '견적 키트/pkgs/web/main.js', '견적 키트/src/app.js', '견적 키트/src/config.js'])
  assert.deepEqual(plan.left.secret.sort(), ['견적 키트/.env', '견적 키트/key.pem'])
  assert.deepEqual(plan.left.personal, ['견적 키트/.claude/settings.local.json'])
  assert.deepEqual(plan.places.personal, ['견적 키트/.vscode/'])
  assert.deepEqual(plan.left.rebuildable, ['견적 키트/.DS_Store'])
  assert.deepEqual(plan.left.structure, ['견적 키트/.gitmodules'])
  assert.deepEqual(plan.left.large, ['견적 키트/video.mp4'])
  assert.deepEqual(plan.places.git, ['견적 키트/.git/'])
  assert.equal(plan.places.rebuildable.length, 2)
  assert.equal(plan.base, '견적 키트')
  assert.equal(plan.files, 9)
  assert.equal(plan.over.length, 0)
  assert.equal(leftCount(plan), 2 + 1 + 1 + 1 + 1 + 1 + 1 + 2)
  // the tops are the dropped folder's own entries, biggest first
  assert.ok(plan.tops.some((t) => t.top === 'docs/' && t.files === 2))
  assert.ok(plan.tops.some((t) => t.top === 'README.md' && t.files === 1))
})

test('a key of a sure shape stays here: its line and the shape, not the value', async () => {
  const scan = await walk([repo('견적 키트', PROJECT, '')], rules)
  const hits = await shapesIn(planOf(scan, rules).up, rules)
  assert.deepEqual(hits, [{ rel: '견적 키트/src/config.js', line: 1, reason: 'github_token' }])
  const plan = planOf(scan, rules, { shapes: hits })
  assert.deepEqual(plan.left.shape, ['견적 키트/src/config.js'])
  assert.ok(!plan.up.some((u) => u.rel.endsWith('config.js')))
  assert.ok(!JSON.stringify(plan.shapes).includes(FAKE_GH))
})

test('a new folder from the dropped one holds its contents (its name is the folder\'s); unticked tops stay here', async () => {
  const scan = await walk([repo('견적 키트', PROJECT, '')], rules)
  const plan = planOf(scan, rules, { strip: true, exclude: new Set(['docs/']) })
  const paths = plan.up.map((u) => u.path)
  assert.ok(paths.includes('README.md'))
  assert.ok(paths.includes('src/app.js'))
  assert.ok(!paths.some((p) => p.startsWith('docs/')))
  assert.ok(plan.tops.find((t) => t.top === 'docs/').out)
})

test('over one upload\'s limits: it says which limit and the biggest parts', async () => {
  const small = { ...rules, limits: { ...rules.limits, headMaxFiles: 10, pushMaxBytes: 20 } }
  const scan = await walk([tree('big', { a: { '1.txt': 'aaaaaaaaaa', '2.txt': 'bbbbbbbbbb' }, b: { '3.txt': 'cccccccccc' }, 'c.txt': 'd' })], small)
  const plan = planOf(scan, small)
  assert.deepEqual(plan.over.map((o) => o.kind), ['bytes'])
  assert.deepEqual(plan.biggest.map((t) => t.top), ['a/', 'b/'])
  const plan2 = planOf(scan, { ...small, limits: { ...small.limits, headMaxFiles: 2, pushMaxBytes: 1e9 } })
  assert.deepEqual(plan2.over, [{ kind: 'files', value: 4, max: 2, more: false }])
  // a walk stopped at its cap: more files than counted
  const capped = await walk([tree('big', { a: { '1.txt': 'a', '2.txt': 'b' }, 'c.txt': 'd' })], rules, { max: 2 })
  assert.equal(capped.truncated, true)
  assert.equal(planOf(capped, rules).over[0].more, true)
})

test('several things dropped at once keep their own names; plain files of a browser without entries too', async () => {
  const scan = await walk([tree('a.txt', 'x'), tree('docs', { 'b.md': 'y' })], rules)
  const plan = planOf(scan, rules)
  assert.deepEqual(plan.up.map((u) => u.path).sort(), ['a.txt', 'docs/b.md'])
  assert.equal(plan.base, '')
  const f = fileLike('z')
  const dt = { items: [{ kind: 'file', getAsFile: () => f }], files: [f] }
  const es = entriesOf(dt)
  assert.equal(es.length, 1)
  assert.equal(es[0].plain, f)
})

test('「폴더 올리기」 (webkitdirectory): the same plan from the browser\'s whole list', () => {
  const at = (rel, text = 'x') => Object.assign(fileLike(text), { name: rel.split('/').pop(), webkitRelativePath: rel })
  const scan = fromPicked([at('kit/README.md'), at('kit/.git/HEAD'), at('kit/.git/objects/aa'), at('kit/node_modules/p/i.js'), at('kit/src/a.js'), at('kit/.env')], rules)
  assert.deepEqual(scan.roots, [{ name: 'kit', dir: true }])
  assert.deepEqual(scan.pruned, [{ rel: 'kit/.git', group: 'git' }, { rel: 'kit/node_modules', group: 'rebuildable' }])
  assert.deepEqual(scan.git, { remote: '', worktree: false })
  const plan = planOf(scan, rules)
  assert.deepEqual(plan.up.map((u) => u.path), ['kit/README.md', 'kit/src/a.js'])
  assert.deepEqual(plan.left.secret, ['kit/.env'])
})

test('a remote\'s address: origin first, no name · password · token', () => {
  assert.equal(remoteOf('[remote "upstream"]\n\turl = git@gitlab.com:a/b.git\n[remote "origin"]\n\turl = https://x-access-token:abc@github.com/o/r.git\n'), 'github.com/o/r')
  assert.equal(remoteOf('[remote "upstream"]\n\turl = git@gitlab.com:a/b.git\n'), 'gitlab.com:a/b')
  assert.equal(remoteOf('[core]\n\turl = nope\n'), '')
  assert.equal(cleanRemote('ssh://git@host.example:2222/team/repo.git/'), 'host.example:2222/team/repo')
})

test('a large folder goes in several requests (files · bytes), the last one says it is the last', async () => {
  const up = Array.from({ length: 5 }, (_, i) => ({ rel: `f${i}`, path: `f${i}`, size: 10 }))
  assert.deepEqual(batchesOf(up, { files: 2, bytes: 1000 }).map((b) => b.length), [2, 2, 1])
  assert.deepEqual(batchesOf(up, { files: 100, bytes: 25 }).map((b) => b.length), [2, 2, 1])
  assert.deepEqual(batchesOf([{ size: 100 }, { size: 1 }], { files: 10, bytes: 50 }).map((b) => b.length), [1, 1])
  const seen = []
  const r = await sendPlan({ up }, { label: 'kit', send: async (b, m) => { seen.push(m); return { written: b.map((u) => u.path), refused: m.final ? [{ path: 'x', reason: 'name' }] : [] } } })
  assert.equal(r.written, 5)
  assert.deepEqual(r.refused, [{ path: 'x', reason: 'name' }])
  assert.deepEqual(seen.map((m) => [m.part, m.parts, m.final]), [[1, 1, true]])
})

test('the server looks again at each uploaded file: a secret\'s name, git\'s control files, a large file, a key of a sure shape', () => {
  assert.deepEqual(refusalOf('kit/.env', Buffer.from('A=1')), { reason: 'name', line: null })
  assert.deepEqual(refusalOf('kit/.gitmodules', Buffer.from('')), { reason: 'gitmodules', line: null })
  assert.deepEqual(refusalOf('kit/a.txt', Buffer.from(`ok\n${PEM}\n`)), { line: 2, reason: 'private_key' })
  assert.equal(refusalOf('kit/.env.example', Buffer.from('A=')), null)
  assert.equal(refusalOf('kit/readme.md', Buffer.from('# hi')), null)
  const limits = pageRules().limits
  assert.equal(limits.largeFileBytes, 50 * 1024 * 1024)
  assert.equal(limits.headMaxFiles, 20000)
  assert.ok(pageRules().block.every((s) => s.id && s.pattern) && pageRules().block.length > 5)
})

test('a folder that leads back into itself ends: at a depth no real folder has (said as not read)', async () => {
  // a folder whose only entry is itself again (a link the browser would follow)
  const loop = { isFile: false, isDirectory: true, name: 'loop', fullPath: '/loop',
    createReader() { let done = false; return { readEntries(ok) { const b = done ? [] : [loop]; done = true; setTimeout(() => ok(b)) } } },
    getDirectory: (_p, _o, _ok, no) => no(new Error('none')), getFile: (_p, _o, _ok, no) => no(new Error('none')) }
  const scan = await walk([loop], rules)
  assert.equal(scan.files.length, 0)
  assert.equal(scan.unreadable.length, 1)
})
