'use strict'
// 챔피언 폴더 (src/runner/sync.js — desktop 0.2.5): a folder the person picked, kept as a Lite folder through a shadow repository of the
// app's own. The link is a fake (the test plays the server: sync:bind → bound, sync:token → a token and the folder's git path, sync:pushed
// → main moved on, as server/lib/folders does); the folder's git server is real (git http-backend behind a Bearer token —
// test/helpers/gitServer.js) over a bare repository whose main starts as the server's champion folder does: one commit with no files.
// Pinned here: what goes up and what stays (the folder's .gitignore, the app's groups, the shapes of keys — reported as file + line +
// reason, never the value), the agent assets found, the person's yes before the first upload, and that the picked folder is only read
// (its files, times and its own .git byte for byte the same; no file or .git made in it; only git commands that never write a work tree).
// Run: cd desktop && node --test test/sync.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')
const S = require('../src/runner/sync')
const G = require('../src/runner/git')
const settings = require('../src/settings')
const { gitServer } = require('./helpers/gitServer')

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pgl-sync-'))
const rmQuiet = (d) => { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) } catch (e) { console.warn(`left ${d}: ${e.code}`) } }
const DATA = path.join(ROOT, 'app', 'local-agents')
const USER = crypto.randomUUID()
const FOLDER = crypto.randomUUID()
const DEVICE8 = 'a1b2c3d4'
const BRANCH = `pgpt-agent/sync-${DEVICE8}/main`
const TOKEN = `pgf1.${crypto.randomBytes(12).toString('base64url')}.${crypto.randomBytes(16).toString('base64url')}`
// key-shaped text made here, never written in this file as it is (the repository is public; a scanner would stop it)
const FAKE = {
  github: `${'gh'}${'p_'}${'Zx9Q'.repeat(9)}`,
  pem: `-----BEGIN ${'OPENSSH PRIVATE'} KEY-----`,
  env: `${crypto.randomBytes(24).toString('base64').replace(/[+/=]/g, 'k')}Q7z`,
  dotenv: `${crypto.randomBytes(18).toString('hex')}`,
}
const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex')
const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...a], { cwd, stdio: 'pipe' }).toString()
const calls = []
S.setTap((c) => calls.push(c))
let symlinks = true

// ---------- the person's folder ----------
const PICKED = path.join(ROOT, 'people', '영업 제안 키트')
const OUTSIDE = path.join(ROOT, 'people', 'outside.txt')
function put(rel, text) { const f = path.join(PICKED, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text) }
function makeChampion() {
  fs.mkdirSync(PICKED, { recursive: true })
  put('README.md', '# 영업 제안 키트\n견적 · 제안서를 만드는 폴더\n')
  put('docs/가이드.md', '# 가이드\nAPI 키는 이 폴더에 두지 않아요.\n')
  // the folder's own .gitignore — and a `!` that tries to bring .env back (the app's groups come first)
  put('.gitignore', 'dist/\nnotes.txt\n!.env\n')
  put('dist/app.js', 'console.log(1)\n')
  put('notes.txt', '메모\n')
  put('.env', `API_KEY=${FAKE.dotenv}\n`)
  put('.env.example', 'API_KEY=\n')
  put('certs/server.pem', `${FAKE.pem}\nAAAA\n`)
  put('.claude/settings.local.json', '{"permissions":{"allow":["Bash(rm:*)"]}}\n')
  put('.claude/settings.json', '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo done"}]}]}}\n')
  put('.claude/skills/견적-정리/SKILL.md', '---\nname: 견적-정리\ndescription: >\n  견적서를 부가세 포함\n  금액으로 정리한다\n---\n본문\n')
  put('.claude/commands/opsx/apply.md', '---\ndescription: "변경을 적용한다"\n---\n$ARGUMENTS\n')
  put('.claude/agents/reviewer.md', '---\nname: reviewer\ndescription: 검토하는 하위 에이전트\n---\n')
  put('.claude/projects/session.jsonl', '{"type":"user"}\n')
  put('CLAUDE.md', '# 이 폴더에서는\n견적은 부가세 포함\n')
  put('AGENTS.md', '# Agents\n')
  put('.codex/skills/요약/SKILL.md', '---\nname: 요약\ndescription: 회의록을 요약한다\n---\n')
  put('.cursor/rules/style.mdc', '---\ndescription: 글 쓰는 방식\n---\n')
  put('openspec/specs/quote/spec.md', '# quote\n')
  put('openspec/changes/add-x/proposal.md', '# add x\n')
  put('node_modules/pkg/index.js', 'module.exports = 1\n')
  put('node_modules/pkg/.env', 'X=1\n')
  put('.aws/config', '[default]\n')
  // git's own control files: a submodule list, LFS's settings (its lfs.url would name where requests go)
  put('.gitmodules', '[submodule "x"]\n\tpath = x\n\turl = https://example.test/x.git\n')
  put('.lfsconfig', '[lfs]\n\turl = https://example.test/lfs\n')
  put('.DS_Store', '\0\0\0\u0001Bud1')
  put('config/app.txt', `server: example.test\ntoken: ${FAKE.github}\n`)
  put('config/settings.sh', `export SERVICE_TOKEN="${FAKE.env}"\n`)
  put('notes-keys/key.txt', `${FAKE.pem}\nnot really\n`)
  put('.mcp.json', '{"mcpServers":{}}\n')
  fs.writeFileSync(path.join(PICKED, 'big.bin'), '')
  fs.truncateSync(path.join(PICKED, 'big.bin'), 51 * 1024 * 1024)
  // another repository inside (left out as a whole — its .git is never opened by the app)
  put('vendor/lib/a.txt', 'lib\n')
  git(path.join(PICKED, 'vendor', 'lib'), 'init', '-q')
  fs.writeFileSync(OUTSIDE, '밖\n')
  try {
    fs.symlinkSync(OUTSIDE, path.join(PICKED, 'outside-link'))
    fs.symlinkSync('README.md', path.join(PICKED, 'inside-link'))
  } catch { symlinks = false }
  // the person's own repository (its history, remote and config are theirs: never read or changed)
  git(PICKED, 'init', '-q', '-b', 'main')
  git(PICKED, 'remote', 'add', 'origin', 'https://example.test/kit.git')
  git(PICKED, 'add', 'README.md')
  git(PICKED, 'commit', '-qm', '내 이력')
}
// every file, folder and link of the picked folder: size · time · bytes (the person's .git included)
function treeOf(dir) {
  const out = {}
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name)
      const r = rel ? `${rel}/${e.name}` : e.name
      const st = fs.lstatSync(abs)
      if (st.isSymbolicLink()) out[r] = `link ${fs.readlinkSync(abs)} ${st.mtimeMs}`
      else if (st.isDirectory()) { out[`${r}/`] = `dir ${st.mtimeMs}`; walk(abs, r) } else out[r] = `${st.size} ${st.mtimeMs} ${st.size > 1048576 ? '' : sha1(fs.readFileSync(abs))}`
    }
  }
  walk(dir, '')
  return out
}

// ---------- the server ----------
const BARE = path.join(ROOT, 'srv', `${FOLDER}.git`)
const bare = (...a) => git(BARE, ...a).trim()
const isAncestor = (a, b) => { try { git(BARE, 'merge-base', '--is-ancestor', a, b); return true } catch { return false } }
let srv
const sent = []
const logs = []
// how the fake server answers (a test may change it): the server's main moves to the pushed head — ahead, or merged
const plays = {
  bind: (m) => ({ type: 'sync:bound', folderId: m.folderId, sourceId: crypto.randomUUID(), branch: BRANCH }),
  token: (m) => ({ type: 'sync:token', folderId: m.folderId, token: TOKEN, url: srv.path, branch: BRANCH, main: bare('rev-parse', 'refs/heads/main'), person: { name: '박챔피언', email: 'champion@example.test' } }),
  pushed: (m) => {
    assert.equal(bare('rev-parse', `refs/heads/${BRANCH}`), m.head, '올린 머리가 그 기기의 가지에 있다')
    const main = bare('rev-parse', 'refs/heads/main')
    if (isAncestor(main, m.head)) bare('update-ref', 'refs/heads/main', m.head)
    else {
      const tree = bare('merge-tree', '--write-tree', main, m.head).split('\n')[0]
      bare('update-ref', 'refs/heads/main', bare('commit-tree', tree, '-p', main, '-p', m.head, '-m', '맞춤'))
    }
    return { type: 'sync:taken', folderId: m.folderId, main: bare('rev-parse', 'refs/heads/main') }
  },
  unbind: (m) => ({ type: 'sync:unbound', folderId: m.folderId }),
}
let fsync = null
function link(m) {
  sent.push(JSON.parse(JSON.stringify(m)))
  const k = { 'sync:bind': 'bind', 'sync:token': 'token', 'sync:pushed': 'pushed', 'sync:unbind': 'unbind' }[m.type]
  const r = k && plays[k] && plays[k](m)
  if (r) setImmediate(() => fsync.handle(r))
  return true
}
function makeSync(opts = {}) {
  settings.init(path.join(ROOT, 'app'))
  const f = new S.FolderSync({ dataDir: DATA, server: srv.base, userId: USER, store: settings.folderStore(srv.base, USER), send: link, device: { name: '테스트 맥' },
    user: () => ({ id: USER, name: '박챔피언' }), log: (s) => logs.push(s), askMs: 5000, takeMs: 10000, ...opts })
  f.linkUp({ id: USER, name: '박챔피언' })
  fsync = f
  return f
}
const yes = async () => true
const at = (ref, file) => git(BARE, 'show', `${ref}:${file}`)
const filesAt = (ref) => git(BARE, 'ls-tree', '-r', '--name-only', '-z', ref).split('\0').filter(Boolean).sort()

test.before(async () => {
  makeChampion()
  fs.mkdirSync(BARE, { recursive: true })
  git(BARE, 'init', '-q', '--bare', '-b', 'main')
  // the server's champion folder: a first commit with no files (its .gitattributes is in the repository's info/attributes)
  const empty = git(BARE, 'mktree').trim() || '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
  bare('update-ref', 'refs/heads/main', bare('commit-tree', empty, '-m', '폴더를 만들었어요'))
  srv = await gitServer({ repo: BARE, token: TOKEN, prefix: `/api/local-git/${FOLDER}.git` })
})
test.after(async () => { await srv?.close(); S.setTap(null); rmQuiet(ROOT) })

test('규칙 파일: 서버의 것과 같다(kit-places.json · secret-shapes.json)', (t) => {
  for (const f of ['kit-places.json', 'secret-shapes.json']) {
    const mine = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'runner', f), 'utf8'))
    assert.equal(mine.version, 1, f)
    const theirs = path.join(__dirname, '..', '..', 'server', 'lib', 'folders', f)
    if (!fs.existsSync(theirs)) { t.diagnostic(`${f}: server copy not there yet`); continue }
    assert.deepEqual(mine, JSON.parse(fs.readFileSync(theirs, 'utf8')), `desktop/src/runner/${f} 는 server/lib/folders/${f} 의 사본이어야 한다`)
  }
  // every shape compiles, every place has a platform the file names
  const rules = S.compileRules()
  assert.ok(rules.shapes.length >= 10)
  const places = require('../src/runner/kit-places.json')
  for (const p of places.places) assert.ok(places.platforms[p.platform], p.glob)
})

test('이름 규칙: 비밀 · 개인 설정 · 다시 만들 수 있는 것 (이름과 경로만 본다)', () => {
  const R = S.compileRules()
  const g = (p, d) => S.groupOf(R, p, d)
  assert.equal(g('.env'), 'secret')
  assert.equal(g('app/.env.local'), 'secret')
  assert.equal(g('.env.example'), null, '.env.example 은 올라간다')
  assert.equal(g('keys/server.PEM'), 'secret')
  assert.equal(g('home/.ssh/config'), 'secret')
  assert.equal(g('id_ed25519'), 'secret')
  assert.equal(g('id_ed25519.pub'), null, '공개 키는 올라간다')
  assert.equal(g('.claude/settings.local.json'), 'personal')
  assert.equal(g('sub/.claude/settings.local.json'), 'personal')
  assert.equal(g('.claude/projects', true), 'personal')
  assert.equal(g('.claude/projects/a/b.jsonl'), 'personal')
  assert.equal(g('.claude/settings.json'), null)
  assert.equal(g('.claude/skills/x/SKILL.md'), null)
  assert.equal(g('.vscode', true), 'personal')
  assert.equal(g('web/node_modules', true), 'rebuildable')
  assert.equal(g('a/.DS_Store'), 'rebuildable')
  assert.equal(g('target.md'), null, '「target」 폴더만 — 같은 이름의 파일은 아님')
  assert.equal(g('docs/README.md'), null)
  // the same rules as gitignore lines (the shadow's info/exclude)
  assert.ok(R.patterns.includes('.env') && R.patterns.includes('!.env.example') && R.patterns.includes('**/.claude/settings.local.json') && R.patterns.includes('node_modules/'))
})

test('열쇠 생김새: 파일 · 줄 · 까닭만, 값은 돌려주지 않는다', () => {
  const R = S.compileRules()
  const hits = S.shapeHits(R, `첫 줄\ntoken = ${FAKE.github}\n${FAKE.pem}\nexport DB_PASSWORD='${FAKE.env}'\nPATH=/usr/local/bin:/usr/bin\nNAME=hello-world-hello-world\n`)
  assert.deepEqual(hits.map((h) => [h.line, h.reason, h.level]), [[2, 'github_token', 'block'], [3, 'private_key', 'block'], [4, 'env_assignment', 'check']])
  assert.ok(!JSON.stringify(hits).includes(FAKE.github) && !JSON.stringify(hits).includes(FAKE.env))
  assert.deepEqual(S.shapeHits(R, '# 안내\nAPI 키는 .env 에 두세요\nVERSION=1.2.3\n'), [])
  assert.equal(S.assignmentHit('SECRET=aaaaaaaaaaaaaaaaaaaaaaaaaaaa', R.shapes.find((s) => s.kind === 'assignment')), false, '고르게 섞이지 않은 값')
  // a script's line of code — a call or an index — is not a key (a company skill's Word kit, msaschool_docx.py — left out as 「확인이 필요해요」 before)
  const code = "    doc = Doc(client_logo='gana-precision.png')          # 고객사 로고가 없으면 생략\n                mar = OxmlElement('w:tcMar')\n        borders = OxmlElement('w:tblBorders')\nrows = sheet[Row3Col7Value]\nwidth = layout.columns.widthOf(column_index)\n"
  assert.deepEqual(S.shapeHits(R, code), [], '코드 줄')
  // …while values with symbols, a string prefix, a trailing ; or a list are still keys
  const r = (n = 24) => crypto.randomBytes(n).toString('base64').replace(/[+/=]/g, '').slice(0, n)
  const keys = [
    `API_TOKEN=${FAKE.env}`,
    `AZURE_STORAGE_CONNECTION_STRING=DefaultEndpointsProtocol=https;AccountName=ganaprecision;AccountKey=${r(40)}==;EndpointSuffix=core.windows.net`,
    'DB_PASSWORD=aB3$dE6^gH9(jK2)mN5,pQ8wX',
    `SECRET_KEY = b'${r(32)}'`,
    `SIGNING_KEY = r'${r(32)}'`,
    `app.secret_key = b'${r(32)}'`,
    `SESSION_SECRET=${r(32)};`,
    `API_KEYS=${r(24)},${r(24)},${r(24)}`,
  ]
  for (const k of keys) assert.deepEqual(S.shapeHits(R, `${k}\n`).map((h) => h.reason), ['env_assignment'], k.replace(/=.*/, '=…'))
})

test('자산 자리 · 머리말', () => {
  assert.equal(S.globMatch('.claude/skills/*/SKILL.md', '.claude/skills/견적/SKILL.md'), true)
  assert.equal(S.globMatch('.claude/skills/*/SKILL.md', '.claude/skills/a/b/SKILL.md'), false)
  assert.equal(S.globMatch('.claude/commands/**/*.md', '.claude/commands/opsx/apply.md'), true)
  assert.equal(S.globMatch('.claude/commands/**/*.md', '.claude/commands/top.md'), true)
  assert.equal(S.globMatch('**/CLAUDE.md', 'CLAUDE.md'), true)
  assert.equal(S.globMatch('**/CLAUDE.md', 'web/CLAUDE.md'), true)
  assert.equal(S.globMatch('.github/prompts/*.prompt.md', '.github/prompts/a.prompt.md'), true)
  assert.equal(S.globMatch('.github/prompts/*.prompt.md', '.github/prompts/a.md'), false)
  assert.deepEqual(S.frontMatter('---\nname: "견적"\ndescription: |\n  두 줄\n  설명\nallowed-tools: Read\n---\n본문'), { name: '견적', description: '두 줄 설명', 'allowed-tools': 'Read' })
  assert.deepEqual(S.frontMatter('# 머리말 없음'), {})
})

test('자산의 「실행」 표시: 머리말에 훅 · 허용 도구 · 권한 모드 같은 실행 키가 있는 스킬 · 명령 · 에이전트 (서버 kit.js 와 같은 목록)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pgl-kitruns-'))
  const files = {
    '.claude/skills/실행/SKILL.md': '---\nname: 실행\ndescription: 쓰이면 훅이 걸린다\nhooks:\n  PreToolUse: []\n---\n본문\n',
    '.claude/skills/조용/SKILL.md': '---\nname: 조용\ndescription: 글만\n---\nhooks: 본문에만 있는 말\n',
    '.claude/agents/검토자.md': '---\nname: 검토자\ndescription: 검토\npermissionMode: bypassPermissions\n---\n',
    '.claude/commands/배포.md': '---\ndescription: 배포\nallowed-tools: Bash(git push:*)\n---\n',
  }
  try {
    for (const [k, v] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, k)), { recursive: true }); fs.writeFileSync(path.join(root, k), v) }
    const kit = Object.fromEntries((await S.kitOf(root, Object.keys(files))).map((k) => [k.path, k.runs]))
    assert.deepEqual(kit, { '.claude/skills/실행/SKILL.md': true, '.claude/skills/조용/SKILL.md': false, '.claude/agents/검토자.md': true, '.claude/commands/배포.md': true })
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
  // names in any case: on macOS and Windows .Claude/Agents is where the CLI finds .claude/agents
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'pgl-kitruns-'))
  const mixed = { '.Claude/Agents/evil.md': '---\nname: evil\nhooks: {}\n---\n', '.Claude/Skills/x/skill.md': '---\nname: x\nallowed_tools: Bash\n---\n' }
  try {
    for (const [k, v] of Object.entries(mixed)) { fs.mkdirSync(path.dirname(path.join(other, k)), { recursive: true }); fs.writeFileSync(path.join(other, k), v) }
    const kit = Object.fromEntries((await S.kitOf(other, Object.keys(mixed))).map((k) => [k.path, `${k.type}:${k.runs}`]))
    assert.deepEqual(kit, { '.Claude/Agents/evil.md': 'agent:true', '.Claude/Skills/x/skill.md': 'skill:true' })
  } finally { fs.rmSync(other, { recursive: true, force: true }) }
})

test('F-CH-01 미리 보기: 올릴 것 · 뺀 것(갈래와 까닭) · 확인이 필요한 파일 · 찾은 에이전트 자산', async () => {
  const f = makeSync()
  const before = treeOf(PICKED)
  const r = await f.pick(PICKED)
  assert.ok(r.pickId && r.label === '영업 제안 키트', JSON.stringify(r).slice(0, 200))
  const p = r.preview
  const ex = Object.fromEntries(p.excluded.map((e) => [e.group, e]))
  assert.deepEqual(ex.gitignore.samples.sort(), ['dist/', 'notes.txt'])
  assert.deepEqual(ex.secret.samples.sort(), ['.aws/', '.env', 'certs/server.pem'], '폴더의 .gitignore 가 「!.env」 라고 해도 .env 는 빠진다')
  assert.deepEqual(ex.personal.samples.sort(), ['.claude/projects/', '.claude/settings.local.json'])
  assert.deepEqual(ex.rebuildable.samples.sort(), ['.DS_Store', 'node_modules/'])
  assert.deepEqual(ex.large.samples, ['big.bin'])
  // only plain files go up: every link (to inside the folder too), another repository, git's control files
  assert.deepEqual(ex.structure.samples.sort(), ['.gitmodules', '.lfsconfig', ...(symlinks ? ['inside-link', 'outside-link'] : []), 'vendor/lib/'])
  assert.deepEqual(p.flagged.map((x) => [x.path, x.line, x.reason, x.includable]), [
    ['.mcp.json', 0, 'runs_config', true], ['config/app.txt', 2, 'github_token', false], ['config/settings.sh', 1, 'env_assignment', true], ['notes-keys/key.txt', 1, 'private_key', false]])
  assert.equal(p.flaggedIncluded, 0)
  // what goes up
  const up = ['.claude/agents/reviewer.md', '.claude/commands/opsx/apply.md', '.claude/settings.json', '.claude/skills/견적-정리/SKILL.md', '.codex/skills/요약/SKILL.md',
    '.cursor/rules/style.mdc', '.env.example', '.gitignore', 'AGENTS.md', 'CLAUDE.md', 'README.md', 'docs/가이드.md', 'openspec/changes/add-x/proposal.md', 'openspec/specs/quote/spec.md']
  assert.equal(p.files, up.length)
  assert.ok(p.top.some((t) => t.path === '.claude/' && t.files === 4) && p.top.some((t) => t.path === 'README.md'))
  assert.ok(p.warnings.includes('own_git'), '이미 git 인 폴더: 지난 이력은 올라가지 않는다')
  const kit = Object.fromEntries(p.kit.map((k) => [`${k.platform}:${k.type}:${k.name}`, k]))
  assert.equal(kit['claude:skill:견적-정리'].description, '견적서를 부가세 포함 금액으로 정리한다')
  assert.equal(kit['claude:command:opsx:apply'].description, '변경을 적용한다')
  assert.ok(kit['claude:agent:reviewer'] && kit['claude:instructions:CLAUDE.md'] && kit['codex:instructions:AGENTS.md'] && kit['codex:skill:요약'] && kit['cursor:rules:style.mdc'])
  assert.equal(kit['claude:settings:settings.json'].runs, true)
  assert.ok(kit['spec:spec:quote'] && kit['spec:change:add-x'])
  // the values never leave: not in the preview
  const all = JSON.stringify(r)
  for (const v of Object.values(FAKE)) assert.ok(!all.includes(v), 'a matched value is not in the preview')
  assert.ok(!all.includes(PICKED), 'the path is not in what the page gets')
  // the person's choices: a folder left out; files to check (level 'check') and a rebuildable folder brought back in — but never a secret
  // (by name, or a folder of them, or one inside a folder brought back), a sure key shape ('block'), a link, git's control files, or
  // anything outside the folder — whatever the page sends
  const q = await f.preview(r.pickId, { exclude: ['openspec'], include: ['config/settings.sh', '.mcp.json', 'node_modules', 'config/app.txt', 'notes-keys/key.txt', '.env', '.aws',
    'node_modules/pkg/.env', 'inside-link', 'outside-link', '.gitmodules', '.lfsconfig', 'vendor/lib', '../escape', '/abs', '.git/config'] })
  assert.ok(!q.kit.some((k) => k.platform === 'spec'))
  assert.ok(q.flagged.some((x) => x.path === 'config/settings.sh'), '넣어도 확인이 필요한 파일로 보인다')
  assert.equal(q.files, up.length - 2 + 3, '스펙 두 파일 빼고, 확인 파일 둘(settings.sh · .mcp.json)과 node_modules 의 파일 하나')
  assert.equal(q.flaggedIncluded, 2)
  const qx = Object.fromEntries(q.excluded.map((e) => [e.group, e]))
  assert.equal(qx.rebuildable.samples.includes('node_modules/'), false)
  assert.deepEqual(qx.secret.samples.sort(), ['.aws/', '.env', 'certs/server.pem', 'node_modules/pkg/.env'])
  assert.deepEqual(qx.structure.samples.sort(), ['.gitmodules', '.lfsconfig', ...(symlinks ? ['inside-link', 'outside-link'] : []), 'vendor/lib/'])
  const sx = await S.scan(PICKED, { gitDir: path.join(DATA, 'x-scan.git'), include: ['config/app.txt', 'notes-keys/key.txt', 'config/settings.sh', '.env', '.aws'] })
  assert.ok(!sx.files.includes('config/app.txt') && !sx.files.includes('notes-keys/key.txt') && !sx.files.includes('.env') && !sx.files.some((x) => x.startsWith('.aws/')))
  assert.ok(sx.files.includes('config/settings.sh'))
  assert.deepEqual([sx.flaggedIn, sx.report.flagged, sx.report.flaggedIncluded], [1, 3, 1])
  // the server's limits on one snapshot (secret-shapes.json): too many files is said before anything goes
  const raw = require('../src/runner/secret-shapes.json')
  const tight = await S.scan(PICKED, { gitDir: path.join(DATA, 'x-scan.git'), rules: S.compileRules({ ...raw, limits: { ...raw.limits, headMaxFiles: 3 } }) })
  assert.ok(tight.preview.warnings.includes('too_many'))
  assert.deepEqual(treeOf(PICKED), before, '미리 보기는 폴더를 읽기만 한다')
})

test('고르면 안 되는 폴더: 디스크 전체 · 홈 · 앱 데이터를 품은 폴더', async () => {
  const f = makeSync()
  assert.deepEqual(await f.pick(path.parse(ROOT).root), { error: 'system_folder' })
  assert.deepEqual(await f.pick(os.homedir()), { error: 'home_folder' })
  assert.deepEqual(await f.pick(path.join(ROOT, 'app')), { error: 'app_folder' })
  assert.deepEqual(await f.pick(ROOT), { error: 'app_folder' })
  assert.deepEqual(await f.pick(path.join(ROOT, 'nope')), { error: 'not_found' })
  assert.deepEqual(await f.pick(path.join(PICKED, 'README.md')), { error: 'not_folder' })
})

test('동의하지 않으면(시스템 창 「취소」) 서버에 아무것도 가지 않는다', async () => {
  const f = makeSync()
  const r = await f.pick(PICKED)
  const n = sent.length
  // (the person brought back a file to check: the dialog is told how many go with it)
  const asked = []
  assert.deepEqual(await f.bind({ pickId: r.pickId, folderId: FOLDER, folderName: '영업 제안 키트', include: ['config/settings.sh', 'config/app.txt'] }, { confirm: async (x) => { asked.push(x); return false } }),
    { ok: false, why: 'cancelled' })
  assert.equal(asked[0].flaggedIn, 1, '확실한 열쇠 모양(app.txt)은 넣을 수 없고, 확인 수준(settings.sh)만 함께')
  const words = S.uploadQuestion({ ...asked[0], host: 'acme.example.test' })
  assert.equal(words.message, `파일 ${asked[0].files}개(${asked[0].bytes >= 102400 ? `${(asked[0].bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(asked[0].bytes / 1024))} KB`})를 acme.example.test 의 폴더 '영업 제안 키트'로 올립니다 — 확인이 필요한 파일 1개도 함께 올라가요`)
  // (the other flagged files stay here: the dialog says how many — F-CH-09)
  assert.equal(asked[0].flaggedOut, asked[0].report.flagged)
  assert.ok(asked[0].flaggedOut > 0)
  assert.match(words.detail, new RegExp(`확인이 필요한 파일 ${asked[0].flaggedOut}개는 빼고, 함께 올리기로 고른 1개는`))
  assert.deepEqual(await f.bind({ pickId: r.pickId, folderId: FOLDER, folderName: '영업 제안 키트' }), { ok: false, why: 'cancelled' }, '물을 곳이 없으면 올리지 않는다')
  assert.equal(sent.length, n)
  assert.deepEqual(f.list(), [])
  // the server says no (the person is not an editor of that folder): nothing kept here either
  const was = plays.bind
  plays.bind = (m) => ({ type: 'sync:refused', folderId: m.folderId, why: 'not_editor' })
  try { assert.deepEqual(await f.bind({ pickId: r.pickId, folderId: FOLDER, folderName: '영업 제안 키트' }, { confirm: yes }), { ok: false, why: 'not_editor' }) } finally { plays.bind = was }
  assert.deepEqual(f.list(), [])
  assert.throws(() => bare('rev-parse', '--verify', '--quiet', `refs/heads/${BRANCH}`), '이 기기의 가지는 아직 없다')
})

test('동의한 뒤 바뀐 폴더: 첫 올리기는 「예」 한 그대로만 — 그 뒤 더한 파일 · 같은 크기로 고친 파일 · 링크로 바뀐 위 폴더 · 스냅숏이 읽는 동안 고친 파일이면 아무것도 올리지 않는다(changed)', async () => {
  const f = makeSync()
  const top = path.join(ROOT, 'people2')
  const dir = path.join(top, '견적 자료')
  const write = (rel, text) => { const x = path.join(dir, ...rel.split('/')); fs.mkdirSync(path.dirname(x), { recursive: true }); fs.writeFileSync(x, text) }
  write('README.md', '# 견적 자료\n')
  write('양식/견적서.md', '| 품목 | 금액 |\n')
  // after the yes (inside it — the person's yes was for what the dialog said), before the first round looked
  const cases = [
    ['a file added', () => write('나중.md', '# 나중에\n')],
    ['an edit of the same size', () => write('README.md', '# 견적 자랴\n')],
    ...(symlinks ? [['the folder above it replaced by a link', () => { fs.renameSync(top, `${top}-옛것`); fs.symlinkSync(`${top}-옛것`, top, process.platform === 'win32' ? 'junction' : 'dir') }]] : []),
    // (while the round's snapshot reads the files — after its own look found them as they were: the look after the snapshot stops it)
    ['an edit while the snapshot reads them', () => write('README.md', '# 견적 자뢰\n'), 'snapshot'],
  ]
  for (const [what, change, when = 'yes'] of cases) {
    const r = await f.pick(dir)
    assert.ok(r.pickId, what)
    const id = crypto.randomUUID()
    const n = sent.length
    let once = false
    if (when === 'snapshot') S.setTap((c) => { calls.push(c); if (!once && c.sub === 'update-index' && c.args.includes('--add')) { once = true; change() } })
    let out
    try { out = await f.bind({ pickId: r.pickId, folderId: id, folderName: '견적 자료' }, { confirm: async () => { if (when === 'yes') change(); return true } }) } finally { S.setTap((c) => calls.push(c)) }
    assert.deepEqual(out, { ok: false, why: 'changed' }, what)
    if (when === 'snapshot') assert.ok(once, 'the change came while the snapshot read the files')
    const mine = sent.slice(n).filter((m) => m.folderId === id).map((m) => m.type)
    assert.deepEqual(mine, when === 'yes' ? ['sync:bind', 'sync:unbind'] : ['sync:bind', 'sync:token', 'sync:unbind'], `${what}: nothing pushed — the source row undone`)
    assert.ok(!f.list().some((e) => e.folderId === id), `${what}: nothing kept here`)
    if (fs.lstatSync(top).isSymbolicLink()) { if (process.platform === 'win32') fs.rmdirSync(top); else fs.unlinkSync(top); fs.renameSync(`${top}-옛것`, top) }
  }
  assert.throws(() => bare('rev-parse', '--verify', '--quiet', `refs/heads/${BRANCH}`), '이 기기의 가지는 아직 없다')
  rmQuiet(top)
})

test('F-CH-09 확인 창: 확인이 필요한 파일 가운데 빼는 수와 함께 올리는 수 — 시트가 뺄 파일을 이름으로 넘겨도(이 훑기는 그 파일을 읽지 않는다)', async () => {
  const f = makeSync()
  const n = sent.length
  const r = await f.pick(PICKED)
  const flagged = [...new Set(r.preview.flagged.map((x) => x.path))].sort()
  assert.ok(flagged.length >= 3, JSON.stringify(flagged))
  assert.ok(flagged.includes('config/settings.sh') && flagged.includes('config/app.txt'))
  const asked = []
  const no = async (x) => { asked.push(x); return false }
  // as the sheet (SourceSheet.vue) sends it: every flagged file it keeps out by name in exclude, the one brought back in include
  assert.deepEqual(await f.bind({ pickId: r.pickId, folderId: FOLDER, folderName: '영업 제안 키트', include: ['config/settings.sh'], exclude: flagged.filter((x) => x !== 'config/settings.sh') }, { confirm: no }),
    { ok: false, why: 'cancelled' })
  assert.equal(asked[0].report.flagged, 0, '이 훑기의 보고만으로는 0 — 녹화(11-26)에서 확인 창이 빼는 파일을 말하지 않은 까닭')
  assert.equal(asked[0].flaggedIn, 1)
  assert.equal(asked[0].flaggedOut, flagged.length - 1)
  const both = S.uploadQuestion({ ...asked[0], host: 'acme.example.test' })
  assert.match(both.message, / — 확인이 필요한 파일 1개도 함께 올라가요$/)
  assert.match(both.detail, new RegExp(`확인이 필요한 파일 ${flagged.length - 1}개는 빼고, 함께 올리기로 고른 1개는`))
  // none brought back, all kept out by name (the video's case: one Slack webhook-shaped file) — it still says so
  await f.bind({ pickId: r.pickId, folderId: FOLDER, folderName: '영업 제안 키트', exclude: flagged }, { confirm: no })
  assert.equal(asked[1].flaggedIn, 0)
  assert.equal(asked[1].flaggedOut, flagged.length)
  const out = S.uploadQuestion({ ...asked[1], host: 'acme.example.test' })
  assert.doesNotMatch(out.message, /확인이 필요한/)
  assert.match(out.detail, new RegExp(`확인이 필요한 파일 ${flagged.length}개는 빼고 올려요\\.$`))
  // nothing named: this scan's own count, the same
  await f.bind({ pickId: r.pickId, folderId: FOLDER, folderName: '영업 제안 키트' }, { confirm: no })
  assert.equal(asked[2].flaggedOut, flagged.length)
  assert.equal(asked[2].report.flagged, flagged.length)
  // a flagged file inside a top folder left out stays here too (counted once)
  await f.bind({ pickId: r.pickId, folderId: FOLDER, folderName: '영업 제안 키트', exclude: ['config'] }, { confirm: no })
  assert.equal(asked[3].flaggedOut, flagged.length)
  // the words by themselves: none · only out · only in · both, in Korean and English (a file, files)
  const q = (o) => S.uploadQuestion({ files: 3, bytes: 2048, folderName: '키트', host: 'h.test', report: { excluded: { secret: 1, personal: 0 } }, ...o })
  assert.equal(q({}).detail, '이 컴퓨터의 폴더는 읽기만 하고 아무것도 쓰지 않아요. 비밀 · 개인 설정으로 보이는 1개는 올리지 않아요.')
  assert.equal(q({ flaggedOut: 0, report: { excluded: {}, flagged: 2 } }).detail, '이 컴퓨터의 폴더는 읽기만 하고 아무것도 쓰지 않아요.', 'flaggedOut 이 오면 그것을 따른다')
  assert.match(q({ report: { excluded: {}, flagged: 2 } }).detail, /확인이 필요한 파일 2개는 빼고 올려요\.$/, '없으면 보고의 수')
  assert.match(q({ flaggedIn: 2 }).detail, /함께 올리기로 고른 확인 파일 2개는 내용 그대로 서버에 남아요\.$/)
  assert.equal(q({ flaggedOut: 1, flaggedIn: 1, lang: 'en' }).detail,
    'The folder on this computer is only read, nothing is written to it. 1 file that looks secret or personal stays here. 1 flagged file stays here; 1 flagged file you chose goes to the server as it is.')
  assert.match(q({ flaggedOut: 2, lang: 'en' }).detail, /2 flagged files stay here\.$/)
  assert.deepEqual(sent.slice(n), [], '취소했으니 서버로는 아무것도')
  assert.deepEqual(f.list(), [])
})

test('F-CH-02 · F-CH-03 올리기: 동의 → 원본 등록 → 첫 올리기 — 서버 main 에 파일이 있고 비밀 · 개인 설정은 없다, 고른 폴더는 그대로', async () => {
  const f = makeSync()
  const before = treeOf(PICKED)
  const r = await f.pick(PICKED)
  const asked = []
  const out = await f.bind({ pickId: r.pickId, folderId: FOLDER, folderName: '영업 제안 키트' }, { confirm: async (x) => { asked.push(x); return true } })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(out.folderId, FOLDER)
  assert.equal(asked.length, 1)
  assert.equal(asked[0].files, r.preview.files)
  assert.equal(out.pushed.files, r.preview.files)
  // the messages: bind (the folder's label, not its path), token, pushed (counts only)
  const mine = sent.filter((m) => m.folderId === FOLDER)
  assert.deepEqual(mine.slice(-3).map((m) => m.type), ['sync:bind', 'sync:token', 'sync:pushed'])
  assert.equal(mine.at(-3).label, '영업 제안 키트')
  const rep = mine.at(-1).report
  assert.deepEqual(Object.keys(rep.excluded).sort(), [...S.GROUPS].sort())
  assert.equal(rep.excluded.secret, 3)
  assert.equal(rep.flagged, 4)
  assert.equal(rep.flaggedIncluded, 0)
  assert.equal(asked[0].flaggedIn, 0)
  assert.ok(!JSON.stringify(sent).includes(PICKED), '경로는 서버로 가지 않는다')
  // the server's main: the files, the agent assets — not .env, not the person's settings.local.json, not what was flagged
  const main = filesAt('refs/heads/main')
  for (const x of ['README.md', 'CLAUDE.md', '.claude/skills/견적-정리/SKILL.md', '.claude/settings.json', '.env.example', 'docs/가이드.md']) assert.ok(main.includes(x), x)
  for (const x of ['.env', '.claude/settings.local.json', 'certs/server.pem', 'config/app.txt', 'config/settings.sh', '.mcp.json', 'big.bin', 'notes.txt', 'node_modules/pkg/index.js', 'vendor/lib/a.txt',
    '.claude/projects/session.jsonl', '.aws/config', '.gitmodules', '.lfsconfig', 'inside-link', 'outside-link']) {
    assert.ok(!main.includes(x), `${x} 는 올라가지 않는다`)
  }
  // only plain files: no link (120000) or submodule (160000) entry anywhere in what went up
  assert.ok(git(BARE, 'ls-tree', '-r', 'refs/heads/main').trim().split('\n').every((l) => l.startsWith('100644 ') || l.startsWith('100755 ')))
  assert.ok(!main.some((x) => x.startsWith('.git/') || x.includes('/.git/')))
  assert.equal(at('refs/heads/main', 'docs/가이드.md'), '# 가이드\nAPI 키는 이 폴더에 두지 않아요.\n')
  const head = bare('rev-parse', 'refs/heads/main')
  assert.equal(git(BARE, 'log', '-1', '--format=%an <%ae>|%s', head).trim(), '박챔피언 <champion@example.test>|동기화', '컴퓨터 이름은 메시지에 없다')
  assert.ok(!git(BARE, 'log', '--format=%B', head).includes(os.hostname()))
  assert.equal(git(BARE, 'rev-list', '--count', head).trim(), '2', '스냅숏 하나 — 그 사람의 지난 이력은 올라가지 않는다')
  // the picked folder: the same, byte for byte and time for time — its own .git too; no .git, no file made in it
  assert.deepEqual(treeOf(PICKED), before)
  assert.equal(git(PICKED, 'remote', 'get-url', 'origin').trim(), 'https://example.test/kit.git')
  // the token: only as the request header — not in the shadow's config, not in a log, not on any git command line
  const shadow = f.gitDirOf(FOLDER)
  assert.ok(fs.existsSync(path.join(shadow, 'HEAD')) && shadow.startsWith(DATA))
  assert.equal(path.basename(path.dirname(path.dirname(path.dirname(shadow)))), 'sync', '<data>/sync/<서버>/<사람>/<폴더>.git')
  assert.equal(fs.readFileSync(path.join(shadow, 'info', 'attributes'), 'utf8'), G.NEUTRAL)
  assert.ok(!fs.readFileSync(path.join(shadow, 'config'), 'utf8').includes(TOKEN))
  assert.ok(srv.seen.length > 0 && srv.seen.every((h) => h === `Bearer ${TOKEN}`))
  assert.ok(!logs.join('\n').includes(TOKEN))
  assert.ok(!calls.some((c) => c.args.some((a) => a.includes(TOKEN))))
  // the registry: this server, this person — the path only there
  const [e] = f.list()
  assert.deepEqual([e.folderId, e.label, e.state, e.why, e.files], [FOLDER, '영업 제안 키트', 'synced', null, r.preview.files])
  assert.ok(e.lastPushedAt && !('path' in e))
  assert.equal(settings.folderStore(srv.base, USER).get(FOLDER).path, fs.realpathSync.native(PICKED).normalize('NFC'))
  assert.equal(f.pathOf(FOLDER), settings.folderStore(srv.base, USER).get(FOLDER).path)
  assert.deepEqual(await f.bind({ pickId: (await f.pick(PICKED)).pickId, folderId: crypto.randomUUID(), folderName: 'x' }, { confirm: yes }), { ok: false, why: 'already_bound' })
})

test('「지금 올리기」: 바뀐 것만 그 위에 — 웹에서 고친 것은 서버의 병합이 지킨다', async () => {
  const f = makeSync()
  const first = bare('rev-parse', `refs/heads/${BRANCH}`)
  // nothing changed: nothing pushed
  const n = sent.length
  const same = await f.syncNow(FOLDER)
  assert.deepEqual([same.ok, same.changed], [true, false])
  assert.equal(sent.slice(n).filter((m) => m.type === 'sync:pushed').length, 0)
  // someone edited the folder on the web meanwhile: main moved on past this computer's upload
  const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: BARE, input: '웹에서 고친 글\n' }).toString().trim()
  const base = bare('rev-parse', 'refs/heads/main^{tree}')
  const webTree = execFileSync('git', ['mktree', '-z'], { cwd: BARE, input: `${git(BARE, 'ls-tree', '-z', base)}100644 blob ${blob}\t웹에서.md\0` }).toString().trim()
  bare('update-ref', 'refs/heads/main', git(BARE, '-c', 'user.name=웹', '-c', 'user.email=w@w', 'commit-tree', webTree, '-p', bare('rev-parse', 'refs/heads/main'), '-m', '웹 편집').trim())
  // the person changed their folder: one file edited, one new, one deleted
  put('README.md', '# 영업 제안 키트\n고친 줄\n')
  put('docs/새 문서.md', '새 문서\n')
  fs.rmSync(path.join(PICKED, 'docs', '가이드.md'))
  const snap = treeOf(PICKED)
  const r = await f.syncNow(FOLDER)
  assert.equal(r.ok, true, JSON.stringify(r))
  const head = bare('rev-parse', `refs/heads/${BRANCH}`)
  assert.equal(bare('rev-parse', `${head}^`), first, '지난 올리기 위에(서버 main 위가 아니라) — 웹 편집을 되돌리지 않는다')
  const main = filesAt('refs/heads/main')
  assert.ok(main.includes('웹에서.md'), '웹에서 고친 것은 남는다')
  assert.ok(main.includes('docs/새 문서.md') && !main.includes('docs/가이드.md'))
  assert.equal(at('refs/heads/main', 'README.md'), '# 영업 제안 키트\n고친 줄\n')
  assert.deepEqual(treeOf(PICKED), snap, '받기는 없다(P0) — 웹에서 고친 것이 내 폴더에 말없이 들어오지 않는다')
  assert.ok(!fs.existsSync(path.join(PICKED, '웹에서.md')))
})

test('서버가 거절하면(비밀) 멈춤과 까닭 — 다음 올리기는 거절된 머리가 아니라 그 앞에서', async () => {
  const f = makeSync()
  const tipBefore = bare('rev-parse', `refs/heads/${BRANCH}`)
  put('docs/메모.md', '한 줄 더\n')
  const was = plays.pushed
  // the server finds a key the desktop did not and puts the branch back
  plays.pushed = (m) => { bare('update-ref', `refs/heads/${BRANCH}`, tipBefore); return { type: 'sync:refused', folderId: m.folderId, why: 'secret', paths: [{ path: 'docs/메모.md', line: 1, reason: 'github_token' }, { path: '../밖', line: 1, reason: 'x' }] } }
  let r
  try { r = await f.syncNow(FOLDER) } finally { plays.pushed = was }
  const said = [{ path: 'docs/메모.md', line: 1, reason: 'github_token' }]
  assert.deepEqual([r.ok, r.why, r.paths], [false, 'secret', said])
  const [e] = f.list()
  assert.deepEqual([e.state, e.why, e.paths], ['blocked', 'secret', said])
  // the person leaves it out and uploads again: on top of the head the server kept
  settings.folderStore(srv.base, USER).put({ ...settings.folderStore(srv.base, USER).get(FOLDER), exclude: ['docs/메모.md'] })
  put('docs/메모2.md', '다른 메모\n')
  const r2 = await f.syncNow(FOLDER)
  assert.equal(r2.ok, true, JSON.stringify(r2))
  const head = bare('rev-parse', `refs/heads/${BRANCH}`)
  assert.equal(bare('rev-parse', `${head}^`), tipBefore)
  assert.ok(!filesAt('refs/heads/main').includes('docs/메모.md'))
  assert.equal(f.list()[0].state, 'synced')
})

test('링크로 오는 말: sync:refused · sync:behind · 늦게 온 sync:taken (createLocalRunner 가 넘긴다)', async () => {
  const { createLocalRunner } = require('../src/runner')
  const dir = path.join(ROOT, 'runner-data')
  settings.init(path.join(ROOT, 'app'))
  const r = createLocalRunner({ server: srv.base, token: 't', dataDir: dir, prefs: () => ({ enabled: true }), ask: async () => false, folders: settings.folderStore(srv.base, USER), userId: USER })
  try {
    assert.ok(r.folders)
    const states = []
    r.ev.on('folders', (l) => states.push(l))
    r.link.emit('welcome', { user: { id: USER, name: '박챔피언' }, device: { id: crypto.randomUUID(), name: 'x' } })
    assert.equal(r.folders.connected, true)
    r.link.emit('message', { type: 'sync:behind', folderId: FOLDER, main: 'abc' })
    assert.equal(r.folders.list()[0].state, 'behind')
    r.link.emit('message', { type: 'sync:refused', folderId: FOLDER, why: 'not_editor' })
    assert.deepEqual([r.folders.list()[0].state, r.folders.list()[0].why], ['blocked', 'not_editor'])
    r.link.emit('message', { type: 'sync:taken', folderId: FOLDER, main: 'abc' })
    assert.deepEqual([r.folders.list()[0].state, r.folders.list()[0].why], ['synced', null])
    r.link.emit('message', { type: 'sync:refused', folderId: FOLDER, why: 'paused' })
    assert.deepEqual([r.folders.list()[0].state, r.folders.list()[0].why], ['paused', 'paused'])
    r.link.emit('message', { type: 'sync:resumed', folderId: FOLDER })
    assert.deepEqual([r.folders.list()[0].state, r.folders.list()[0].why], ['synced', null])
    assert.ok(states.length >= 3)
    r.link.emit('down')
    assert.equal(r.folders.connected, false)
    assert.deepEqual(await r.folders.syncNow(FOLDER), { ok: false, why: 'offline' })
  } finally { r.stop() }
})

test('다른 사람이 이 앱에 로그인하면 앞 사람의 폴더는 멈춘다 — 그 사람의 이름으로 올라가지 않는다', async () => {
  const f = makeSync()
  f.linkUp({ id: crypto.randomUUID(), name: '다른 사람' })
  assert.deepEqual(await f.syncNow(FOLDER), { ok: false, why: 'other_user' })
  assert.deepEqual(await f.pick(PICKED), { error: 'other_user' })
  // another person's record on this server: their own list, empty
  const other = settings.folderStore(srv.base, crypto.randomUUID())
  assert.deepEqual(other.all(), [])
  assert.equal(settings.folderStore(srv.base, USER).all().length, 1)
  assert.deepEqual(settings.folderStore('https://other.example.test', USER).all(), [], '서버마다 따로')
})

test('한 PC 의 두 사람: 그림자 저장소가 사람마다 따로 — 한 사람이 끊어도 다른 사람의 것은 그대로', async () => {
  const f = makeSync()
  const OTHER = crypto.randomUUID()
  const g = new S.FolderSync({ dataDir: DATA, server: srv.base, userId: OTHER, store: settings.folderStore(srv.base, OTHER), send: () => true })
  assert.notEqual(g.gitDirOf(FOLDER), f.gitDirOf(FOLDER))
  assert.equal(path.dirname(path.dirname(g.gitDirOf(FOLDER))), path.dirname(path.dirname(f.gitDirOf(FOLDER))), '같은 서버 아래')
  // the other person's record of the same folder id (as if they had connected it too), and its shadow
  settings.folderStore(srv.base, OTHER).put({ folderId: FOLDER, path: PICKED, label: 'x', state: 'synced' })
  fs.mkdirSync(g.gitDirOf(FOLDER), { recursive: true })
  g.handle({ type: 'sync:unbound', folderId: FOLDER })
  assert.ok(!fs.existsSync(g.gitDirOf(FOLDER)))
  assert.ok(fs.existsSync(path.join(f.gitDirOf(FOLDER), 'HEAD')), '앞 사람의 그림자 저장소는 남는다')
  assert.equal(settings.folderStore(srv.base, USER).all().length, 1)
})

test('연결 끊기: 그림자 저장소와 이 PC 의 기록만 지운다 — 고른 폴더 · 서버 폴더는 그대로', async () => {
  const f = makeSync()
  const before = treeOf(PICKED)
  const main = bare('rev-parse', 'refs/heads/main')
  const shadow = f.gitDirOf(FOLDER)
  assert.ok(fs.existsSync(shadow))
  assert.deepEqual(await f.unbind(FOLDER), { ok: true })
  assert.equal(sent.at(-1).type, 'sync:unbind')
  assert.ok(!fs.existsSync(shadow))
  assert.deepEqual(f.list(), [])
  assert.deepEqual(treeOf(PICKED), before)
  assert.equal(bare('rev-parse', 'refs/heads/main'), main)
  // the server removed the source by itself (the owner, on the web): this computer forgets it too
  const g = makeSync()
  settings.folderStore(srv.base, USER).put({ folderId: FOLDER, path: PICKED, label: 'x', state: 'active' })
  g.handle({ type: 'sync:unbound', folderId: FOLDER })
  assert.deepEqual(g.list(), [])
})

test('고른 폴더에는 쓰지 않는다: 동기화가 부르는 git 은 정해진 것뿐, 모두 앱 데이터의 그림자 저장소에서', async () => {
  assert.ok(calls.length > 20)
  const deny = ['reset', 'clean', 'checkout', 'restore', 'switch', 'stash', 'merge', 'rebase', 'rm', 'mv', 'worktree', 'apply', 'am', 'pull', 'gc', 'config', 'remote', 'add', 'commit']
  for (const c of calls) {
    assert.ok(S.ALLOWED.has(c.sub) && !deny.includes(c.sub), c.sub)
    assert.ok(path.resolve(c.gitDir).startsWith(path.resolve(DATA)), `GIT_DIR ${c.gitDir}`)
    if (c.sub !== 'init') assert.equal(c.args[0], `--git-dir=${c.gitDir}`)
    if (c.workTree) assert.ok(['ls-files', 'check-ignore', 'update-index'].includes(c.sub), `${c.sub} 는 작업 트리를 쓰지 않는다`)
    if (c.sub === 'fetch' || c.sub === 'push') assert.ok(c.args.some((a) => a.startsWith(srv.base)), '토큰은 그 폴더의 주소로만')
  }
  // the module refuses anything else, and never reaches for the runner's helpers that reset or check out a folder
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'runner', 'sync.js'), 'utf8')
  for (const h of ['G.branch', 'G.sync(', 'G.follow', 'G.commit(', 'G.git(', 'G.push(']) assert.ok(!src.includes(h), h)
  for (const sub of ['reset', 'clean', 'checkout', 'stash', 'merge']) assert.ok(!src.includes(`'${sub}'`), sub)
  const gitDir = path.join(DATA, 'refuse.git')
  for (const sub of ['reset', 'clean', 'checkout', 'restore', 'stash', 'config']) {
    await assert.rejects(S.shadowGit(gitDir, PICKED, [sub, '-q']), /not used by the folder sync/, sub)
  }
  assert.ok(!fs.existsSync(gitDir))
})
