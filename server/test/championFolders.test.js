// Champion folders, P0 (spec openspec/specs/champion-folders): a person's computer uploads a folder they picked into a managed shared folder.
//   - the agent assets in main are found by where they are (kit-places.json: path patterns), names and descriptions from front matter
//   - what must not go up (secret-shapes.json): secrets' file names and the format of known keys — never a value in what comes back
//   - a desktop's sync token is checked on every request: the device linked, the folder's source on, the person's role now
//   - the sources' life: bind → token → a pushed snapshot into main (+ assets) · a key in a push → the branch put back, main untouched ·
//     paused · removed · unbind; a champion folder's first commit has no file; an empty one can be removed again
// Run: node --test test/championFolders.test.js  (the parts with a database need the local one; folders go to a temporary directory,
// in the test tenant "champion-test", and everything is removed afterwards)
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'

const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'pgl-champion-'))
const TENANT = 'champion-test'
process.env.PRO_TENANT_ID = TENANT
process.env.PRO_FOLDERS_ROOT = path.join(ROOT, 'folders')
process.env.PRO_LLM_BASE_URL = 'http://127.0.0.1:9/v1'
const KIT = await import('../lib/folders/kit.js')
const SEC = await import('../lib/folders/secrets.js')

// key-shaped text is made here, never written in this file (a test file is a file of the repository too)
const pem = () => crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' })
const ghToken = () => ['gh', 'p_', crypto.randomBytes(30).toString('base64').replace(/[^A-Za-z0-9]/g, '').padEnd(36, 'x').slice(0, 36)].join('')

// ---------- path patterns ----------
test('CH-U-01 경로 무늬: ** 는 마디 0개 이상, * 는 마디 안, 앞에 **/ 가 없으면 폴더 맨 위부터', () => {
  const m = KIT.matchGlob
  assert.ok(m('.claude/skills/*/SKILL.md', '.claude/skills/견적-규칙/SKILL.md'))
  assert.ok(!m('.claude/skills/*/SKILL.md', '.claude/skills/a/b/SKILL.md'))
  assert.ok(!m('.claude/skills/*/SKILL.md', 'x/.claude/skills/a/SKILL.md'))
  assert.ok(m('**/CLAUDE.md', 'CLAUDE.md'))
  assert.ok(m('**/CLAUDE.md', 'docs/guide/CLAUDE.md'))
  assert.ok(m('.claude/commands/**/*.md', '.claude/commands/opsx/apply.md'))
  assert.ok(m('.claude/commands/**/*.md', '.claude/commands/apply.md'))
  assert.ok(!m('.claude/commands/**/*.md', '.claude/commands/apply.txt'))
  assert.ok(m('.github/prompts/*.prompt.md', '.github/prompts/plan.prompt.md'))
  // characters of a regular expression are plain in a pattern
  assert.ok(m('notes (v1)?.md', 'notes (v1)?.md') && !m('a.md', 'abmd') && !m('a?c.md', 'abc.md'))
})

// ---------- assets ----------
test('CH-U-02 자산 자리: 플랫폼마다 정해진 자리의 파일만, 이름은 자리에서', () => {
  const at = (p) => { const pl = KIT.placeOf(p); return pl ? `${pl.platform}:${pl.type}` : null }
  assert.equal(at('.claude/skills/x/SKILL.md'), 'claude:skill')
  assert.equal(at('.claude/commands/opsx/apply.md'), 'claude:command')
  assert.equal(at('.claude/agents/reviewer.md'), 'claude:agent')
  assert.equal(at('CLAUDE.md'), 'claude:instructions')
  assert.equal(at('web/CLAUDE.md'), 'claude:instructions')
  assert.equal(at('.claude/settings.json'), 'claude:settings')
  assert.equal(at('.mcp.json'), 'claude:mcp')
  assert.equal(at('AGENTS.md'), 'codex:instructions')
  assert.equal(at('.codex/skills/y/SKILL.md'), 'codex:skill')
  assert.equal(at('.agents/skills/y/SKILL.md'), 'codex:skill')
  assert.equal(at('.codex/prompts/review.md'), 'codex:prompt')
  assert.equal(at('.cursor/rules/a.mdc'), 'cursor:rules')
  assert.equal(at('.cursorrules'), 'cursor:rules')
  assert.equal(at('GEMINI.md'), 'gemini:instructions')
  assert.equal(at('.github/copilot-instructions.md'), 'copilot:instructions')
  assert.equal(at('.github/prompts/plan.prompt.md'), 'copilot:prompt')
  assert.equal(at('openspec/specs/y/spec.md'), 'spec:spec')
  assert.equal(at('openspec/changes/add-x/proposal.md'), 'spec:change')
  assert.equal(at('openspec/changes/archive/2026-01-01-x/proposal.md'), null)
  assert.equal(at('specs/login/spec.md'), 'spec:spec')
  for (const p of ['README.md', 'docs/skills/SKILL.md', '.claude/settings.local.json', 'src/agents.md', '.claude/skills/SKILL.md']) assert.equal(at(p), null, p)
  const it = (p, text) => KIT.itemOf(KIT.placeOf(p), p, text)
  assert.equal(it('.claude/skills/견적-규칙/SKILL.md').name, '견적-규칙')
  // a command as Claude Code calls it (/opsx:apply)
  assert.equal(it('.claude/commands/opsx/apply.md').name, 'opsx:apply')
  assert.equal(it('.claude/commands/ship.md').name, 'ship')
  assert.equal(it('.github/prompts/plan.prompt.md').name, 'plan.prompt.md')
  assert.equal(it('.cursor/rules/a.mdc').name, 'a.mdc')
  assert.equal(it('openspec/specs/y/spec.md').name, 'y')
  assert.equal(it('docs/CLAUDE.md').name, 'CLAUDE.md')
})

test('CH-U-03 이름 · 설명은 머리말(YAML)에서 — 한 줄 · 따옴표 · 여러 줄(>) · CRLF, 머리말이 없으면 지침의 첫 제목', () => {
  const it = (p, text) => KIT.itemOf(KIT.placeOf(p), p, text)
  const a = it('.claude/skills/quote/SKILL.md', '---\nname: 견적서 만들기\ndescription: "고객 요청 메일로 견적서를 만든다"\n---\n\n# 견적\n')
  assert.equal(a.name, '견적서 만들기')
  assert.equal(a.description, '고객 요청 메일로 견적서를 만든다')
  const b = it('.codex/skills/r/SKILL.md', '---\r\nname: review\r\ndescription: >\r\n  Reviews a pull request\r\n  line by line.\r\n---\r\nbody\r\n')
  assert.equal(b.name, 'review')
  assert.equal(b.description, 'Reviews a pull request line by line.')
  const c = it('.claude/commands/ship.md', '---\ndescription: 기능 하나를 끝까지\nallowed-tools: Bash(git:*)\n---\n$ARGUMENTS\n')
  assert.equal(c.name, 'ship')
  assert.equal(c.description, '기능 하나를 끝까지')
  assert.equal(it('CLAUDE.md', '# 이 저장소에서 일하는 법\n\n- 한국어로\n').description, '이 저장소에서 일하는 법')
  assert.equal(it('AGENTS.md', 'no heading here').description, null)
  // a front matter's name in a place named by its folder still wins; no front matter → the folder's name
  assert.equal(it('.claude/skills/x/SKILL.md', '# X skill').name, 'x')
})

test('CH-U-04 실행되는 설정: 훅 · 허용 목록 · MCP 서버가 들었을 때만', () => {
  const it = (p, j) => KIT.itemOf(KIT.placeOf(p), p, typeof j === 'string' ? j : JSON.stringify(j))
  assert.equal(it('.claude/settings.json', { hooks: { PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'npm run lint' }] }] } }).runs, true)
  assert.equal(it('.claude/settings.json', { permissions: { allow: ['Bash(npm test)'] } }).runs, true)
  assert.equal(it('.claude/settings.json', { permissions: { allow: [] }, model: 'opus' }).runs, false)
  assert.equal(it('.claude/settings.json', 'not json').runs, false)
  assert.equal(it('.mcp.json', { mcpServers: { files: { command: 'npx' } } }).runs, true)
  assert.equal(it('.mcp.json', { mcpServers: {} }).runs, false)
  assert.equal(it('.codex/config.toml', 'model = "o4"').runs, true)
  assert.equal(KIT.itemOf(KIT.placeOf('.claude/settings.json'), '.claude/settings.json').runs, true, '읽기 전에는 자리가 말하는 대로')
  assert.equal(it('CLAUDE.md', '# x').runs, false)
})

// ---------- what must not go up ----------
test('CH-U-05 빼는 이름: 비밀 · 개인 설정 · 다시 만들 수 있는 것 (예외: .env.example · 공개 키 · 발표 파일 .key) — 대소문자 없이', () => {
  const g = SEC.groupOf
  for (const p of ['.env', 'app/.env.local', 'deploy/server.pem', 'keys/id_ed25519', '.ssh/config', 'home/.aws/credentials', '.npmrc', 'gcp/service-account-prod.json',
    '.codex/auth.json', '.claude/.credentials.json', 'App/.ENV', 'x/.git-credentials']) assert.equal(g(p), 'secret', p)
  for (const p of ['.env.example', 'app/.env.sample', 'keys/id_ed25519.pub', 'docs/env.md', '발표/11월.key', 'docs/.ssh.md']) assert.notEqual(g(p), 'secret', p)
  for (const p of ['.claude/settings.local.json', '.claude/projects/x/1.jsonl', '.codex/sessions/a.jsonl', '.vscode/settings.json', '.cursor/mcp.json']) assert.equal(g(p), 'personal', p)
  for (const p of ['node_modules/a/index.js', 'web/.next/build.js', '.DS_Store', 'py/__pycache__/a.pyc']) assert.equal(g(p), 'rebuildable', p)
  for (const p of ['CLAUDE.md', '.claude/settings.json', '.claude/skills/x/SKILL.md', 'README.md', '.mcp.json']) assert.equal(g(p), null, p)
})

test('CH-U-06 확실한 열쇠의 생김새(block)만 서버가 본다 — 줄 번호와 이름만, 값은 돌려주지 않는다', () => {
  const key = pem()
  const hit = SEC.blockIn(`# 배포 메모\n\n${key}`)
  assert.deepEqual(hit, { line: 3, reason: 'private_key' })
  assert.ok(!JSON.stringify(hit).includes(key.split('\n')[1]), '값이 없다')
  assert.deepEqual(SEC.blockIn(`GITHUB_TOKEN=${ghToken()}\n`), { line: 1, reason: 'github_token' })
  // what may be one (an AWS key id, a long random value) is asked on the desktop, not refused here
  assert.equal(SEC.blockIn(`aws_access_key_id = ${'AKIA'}${'IOSFODNN7EXAMPLE'}\nAPI_SECRET="${crypto.randomBytes(24).toString('base64')}"`), null)
  assert.equal(SEC.blockIn('name: 견적서 만들기\nTITLE=hello-world-of-quotes-and-orders\nversion = 1.2.3\n'), null)
  // binary is not read
  assert.equal(SEC.blockIn(Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(key)])), null)
})

test('CH-U-07 서버가 거절하는 것: 비밀 이름의 파일, 확실한 생김새가 든 파일 — 경로 · 줄 · 까닭만', async () => {
  const files = [{ path: 'docs/deploy.md', size: 10, body: `memo\n${pem()}` }, { path: '.env', size: 3, body: 'A=1' }, { path: 'CLAUDE.md', size: 5, body: '# hi' },
    { path: 'notes.txt', size: 5, body: `x = "${crypto.randomBytes(24).toString('hex')}Ab"` }]
  const out = await SEC.refusedIn(files, async (f) => Buffer.from(f.body))
  assert.deepEqual(out, [{ path: 'docs/deploy.md', line: 2, reason: 'private_key' }, { path: '.env', line: null, reason: 'name' }])
})

test('CH-U-08 데이터 파일 두 개는 고쳐 쓸 수 있는 JSON 이고, 데스크톱에도 같은 사본(있을 때)', async () => {
  const here = path.dirname(new URL(import.meta.url).pathname)
  for (const f of ['kit-places.json', 'secret-shapes.json']) {
    const ours = await fs.readFile(path.join(here, '../lib/folders', f), 'utf8')
    JSON.parse(ours)
    const theirs = await fs.readFile(path.join(here, '../../desktop/src/runner', f), 'utf8').catch(() => null)
    if (theirs != null) assert.deepEqual(JSON.parse(theirs), JSON.parse(ours), `desktop/src/runner/${f}`)
  }
  for (const s of SEC.SHAPES.shapes) if (s.pattern) new RegExp(s.pattern) // every shape compiles in JavaScript
})

// ---------- with the database ----------
const { q, pool } = await import('../lib/supa.js')
const db = await q('select 1 from pro_folder_sources limit 1').then(() => true).catch(() => false)
const S = await import('../lib/folders/service.js')
const G = await import('../lib/folders/git.js')
const SRC = await import('../lib/folders/sources.js')
const D = await import('../lib/localAgents/devices.js')
const { mintToken, verifyToken } = await import('../lib/folders/gitHttp.js')
const { reindex } = await import('../lib/folders/indexer.js')
const made = []
const owner = { id: crypto.randomUUID(), name: '박챔피언', email: 'champion-owner@example.test' }
const mate = { id: crypto.randomUUID(), name: '김동료', email: 'champion-mate@example.test' }
after(async () => {
  if (db) {
    for (const t of ['pro_folder_sources', 'pro_local_devices', 'pro_folders']) await q(`delete from ${t} where tenant_id=$1`, [TENANT]).catch(() => {})
  }
  await pool.end()
  await fs.rm(ROOT, { recursive: true, force: true })
})
const gitc = (cwd, args) => new Promise((resolve, reject) => execFile('git', ['-c', 'user.name=champion', '-c', 'user.email=champion@example.test', '-c', 'core.hooksPath=/dev/null', ...args],
  { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (e, out, errOut) => (e ? reject(new Error(`${args.join(' ')}: ${errOut}`)) : resolve(String(out).trim()))))
async function device(user, name = '맥북') {
  const [d] = await q(`insert into pro_local_devices (tenant_id, user_id, name, token_hash) values ($1,$2,$3,$4) returning *`, [TENANT, user.id, name, crypto.randomBytes(16).toString('hex')])
  return d
}
// a link as the hub hands it to a message handler, its replies kept
const linkOf = (d) => { const sent = []; return { id: d.id, tenant: TENANT, userId: String(d.user_id), name: d.name, sent, send: (m) => { sent.push(m); return true }, last: (t) => sent.filter((m) => m.type === t).at(-1) } }
// a snapshot like the desktop's: files on top of `parent`, pushed to the branch (directly — the HTTP path is the e2e's)
async function snapshot(folder, branch, files, { parent = null } = {}) {
  const dir = await fs.mkdtemp(path.join(ROOT, 'pc-'))
  await gitc(dir, ['init', '-q', '-b', 'work'])
  await gitc(dir, ['fetch', '-q', folder.repo_path, `+refs/heads/*:refs/remotes/origin/*`])
  await gitc(dir, ['reset', '-q', '--hard', parent || 'origin/main'])
  for (const [p, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, p)), { recursive: true })
    if (body == null) await fs.rm(path.join(dir, p), { force: true })
    else await fs.writeFile(path.join(dir, p), body)
  }
  await gitc(dir, ['add', '-A'])
  await gitc(dir, ['commit', '-q', '--allow-empty', '-m', '동기화 · 맥북'])
  const head = await gitc(dir, ['rev-parse', 'HEAD'])
  const old = await G.head(folder.repo_path, `refs/heads/${branch}`)
  await gitc(dir, ['push', '-q', '--force', folder.repo_path, `HEAD:refs/heads/${branch}`])
  return { head, old: old || '0'.repeat(40) }
}
const KITFILES = {
  '.claude/skills/x/SKILL.md': '---\nname: 견적 규칙\ndescription: 견적서를 만들 때 지킬 것\n---\n\n본문\n',
  'CLAUDE.md': '# 영업 제안 키트\n',
  'AGENTS.md': '# Codex 에게\n',
  '.cursor/rules/a.mdc': '---\ndescription: 문서 규칙\nglobs: "*.md"\n---\n규칙\n',
  'openspec/specs/y/spec.md': '# 견적 스펙\n',
  '견적/양식.md': '# 견적 양식\n',
}

test('CH-U-09 챔피언 폴더는 첫 커밋에 파일이 없고(속성은 저장소 안쪽에), 표시가 남으며, 비어 있을 때만 다시 지울 수 있다', { skip: !db && 'no database' }, async () => {
  const f = await S.createFolder(owner, { name: `영업 제안 키트 ${crypto.randomBytes(2).toString('hex')}`, champion: true })
  made.push(f)
  assert.deepEqual(await G.lsTree(f.repo_path, 'main'), [])
  assert.match(await fs.readFile(path.join(f.repo_path, '.git', 'info', 'attributes'), 'utf8'), /\*\.docx binary/)
  await assert.rejects(fs.stat(path.join(f.repo_path, '.gitattributes')))
  assert.equal(f.settings.champion.by, owner.id)
  assert.equal(await S.roleOf(f, owner), 'owner')
  // an ordinary folder keeps its .gitattributes in main and is not removed this way
  const plain = await S.createFolder(owner, { name: `보통 폴더 ${crypto.randomBytes(2).toString('hex')}` })
  made.push(plain)
  assert.deepEqual((await G.lsTree(plain.repo_path, 'main')).map((x) => x.path), ['.gitattributes'])
  await assert.rejects(S.discardEmptyChampion(plain, 'owner'), (e) => e.status === 400)
  await assert.rejects(S.discardEmptyChampion(f, 'editor'), (e) => e.status === 403)
  assert.deepEqual(await S.discardEmptyChampion(f, 'owner'), { ok: true })
  assert.equal(await S.folderById(f.id), null)
  await assert.rejects(fs.stat(f.repo_path))
})

test('CH-U-10 자산 찾기: main 이 움직이면 표가 따라온다(바뀐 것만 다시 읽고, 없어진 것은 빠진다)', { skip: !db && 'no database' }, async () => {
  const f = await S.createFolder(owner, { name: `자산 ${crypto.randomBytes(2).toString('hex')}`, champion: true })
  made.push(f)
  for (const [p, body] of Object.entries(KITFILES)) { await fs.mkdir(path.dirname(path.join(f.repo_path, p)), { recursive: true }); await fs.writeFile(path.join(f.repo_path, p), body) }
  await S.commitMain(f, owner, '올림')
  await reindex(f, { cards: false })
  const kit = await KIT.kitOf(f)
  assert.deepEqual(kit.map((k) => `${k.platform}:${k.type}:${k.path}`), [
    'claude:skill:.claude/skills/x/SKILL.md', 'claude:instructions:CLAUDE.md', 'codex:instructions:AGENTS.md', 'cursor:rules:.cursor/rules/a.mdc', 'spec:spec:openspec/specs/y/spec.md'])
  assert.equal(kit[0].name, '견적 규칙')
  assert.equal(kit[0].description, '견적서를 만들 때 지킬 것')
  assert.equal(kit[3].description, '문서 규칙')
  assert.equal(kit[1].description, '영업 제안 키트')
  await fs.writeFile(path.join(f.repo_path, '.claude/skills/x/SKILL.md'), '---\nname: 견적 규칙 2판\ndescription: 바뀜\n---\n')
  await fs.rm(path.join(f.repo_path, 'AGENTS.md'))
  await S.commitMain(f, owner, '고침')
  await reindex(f, { cards: false })
  const again = await KIT.kitOf(f)
  assert.equal(again.find((k) => k.type === 'skill').name, '견적 규칙 2판')
  assert.ok(!again.some((k) => k.path === 'AGENTS.md'))
  const counts = await KIT.kitCounts([f.id])
  assert.deepEqual(counts.get(String(f.id)), { skill: 1, instructions: 1, rules: 1, spec: 1 })
})

test('CH-U-11 동기화 토큰은 요청마다: 기기 · 원본 · 역할을 지금 본다', { skip: !db && 'no database' }, async () => {
  const f = await S.createFolder(owner, { name: `토큰 ${crypto.randomBytes(2).toString('hex')}`, champion: true })
  made.push(f)
  await S.setMember(f, owner, { type: 'user', id: mate.id, role: 'editor' })
  const dOwner = await device(owner), dMate = await device(mate, '김동료의 PC')
  const claims = (d) => verifyToken(mintToken({ tenant: TENANT, folderId: f.id, push: SRC.prefixOf(d.id), scope: 'sync', device: d.id, hours: 1 }))
  // not bound yet
  assert.match(await D.syncAccess(claims(dMate), { push: false }), /not synced/)
  const L = linkOf(dMate)
  await SRC.receive(L, { type: 'sync:bind', folderId: f.id, label: '/Users/kim/영업 키트' })
  const bound = L.last('sync:bound')
  assert.equal(bound.branch, `pgpt-agent/sync-${dMate.id.slice(0, 8)}/main`)
  const [row] = await q('select * from pro_folder_sources where id=$1', [bound.sourceId])
  assert.equal(row.label, '영업 키트', '경로가 아니라 이름만')
  assert.equal(await D.syncAccess(claims(dMate), { push: true }), null)
  assert.equal(await D.gitAccess(claims(dMate), { push: true }), null, 'the public path takes it')
  // the person's role now: a viewer still reads, cannot push
  await S.setMember(f, owner, { type: 'user', id: mate.id, role: 'viewer' })
  assert.equal(await D.syncAccess(claims(dMate), { push: false }), null)
  assert.match(await D.syncAccess(claims(dMate), { push: true }), /editor/)
  await S.removeMember(f, { type: 'user', id: mate.id })
  assert.match(await D.syncAccess(claims(dMate), { push: false }), /not shared/)
  await S.setMember(f, owner, { type: 'user', id: mate.id, role: 'editor' })
  // paused · removed · another device of the same folder · revoked
  await q(`update pro_folder_sources set state='paused' where id=$1`, [bound.sourceId])
  assert.match(await D.syncAccess(claims(dMate), { push: false }), /paused/)
  await q(`update pro_folder_sources set state='removed' where id=$1`, [bound.sourceId])
  assert.match(await D.syncAccess(claims(dMate), { push: false }), /not synced/)
  await q(`update pro_folder_sources set state='active' where id=$1`, [bound.sourceId])
  assert.match(await D.syncAccess(claims(dOwner), { push: false }), /not synced/, '그 기기의 원본이 아니면')
  await q('update pro_local_devices set revoked_at=now() where id=$1', [dMate.id])
  assert.match(await D.syncAccess(claims(dMate), { push: false }), /not linked/)
  // another company's token for this folder: its device is not there
  assert.match(await D.syncAccess({ ...claims(dOwner), tenant: 'champion-other' }, { push: false }), /not linked/)
  assert.match(await D.syncAccess({ ...claims(dOwner), scope: 'device' }, {}), /not a desktop sync token/)
})

test('CH-U-12 원본의 한 바퀴: 묶기 → 토큰 → 올린 머리가 main 으로(자산 표까지) → 열쇠가 든 올리기는 가지를 되돌리고 main 은 그대로 → 멈춤 · 끊기', { skip: !db && 'no database' }, async () => {
  const f = await S.createFolder(owner, { name: `한 바퀴 ${crypto.randomBytes(2).toString('hex')}`, champion: true })
  made.push(f)
  const d = await device(owner)
  const L = linkOf(d)
  // refusals before anything: an ordinary folder, another company's folder, a folder I am not in
  const plain = await S.createFolder(owner, { name: `보통 ${crypto.randomBytes(2).toString('hex')}` })
  made.push(plain)
  await SRC.receive(L, { type: 'sync:bind', folderId: plain.id, label: 'x' })
  assert.equal(L.last('sync:refused').why, 'not_managed')
  await SRC.receive(L, { type: 'sync:bind', folderId: crypto.randomUUID(), label: 'x' })
  assert.equal(L.last('sync:refused').why, 'no_folder')
  const Lm = linkOf(await device(mate))
  await SRC.receive(Lm, { type: 'sync:bind', folderId: f.id, label: 'x' })
  assert.equal(Lm.last('sync:refused').why, 'no_folder')
  await S.setMember(f, owner, { type: 'user', id: mate.id, role: 'viewer' })
  await SRC.receive(Lm, { type: 'sync:bind', folderId: f.id, label: 'x' })
  assert.equal(Lm.last('sync:refused').why, 'not_editor')
  await SRC.receive(L, { type: 'sync:token', folderId: f.id })
  assert.equal(L.last('sync:refused').why, 'no_folder', '묶기 전')

  await SRC.receive(L, { type: 'sync:bind', folderId: f.id, label: '영업 제안 키트' })
  const { branch } = L.last('sync:bound')
  await SRC.receive(L, { type: 'sync:token', folderId: f.id })
  const tok = L.last('sync:token')
  assert.equal(tok.branch, branch)
  assert.equal(tok.path, `/api/local-git/${f.id}.git`)
  assert.equal(tok.main, await G.head(f.repo_path, 'refs/heads/main'))
  const c = verifyToken(tok.token)
  assert.equal(c.scope, 'sync')
  assert.equal(c.device, d.id)
  assert.equal(c.push, `pgpt-agent/sync-${d.id.slice(0, 8)}/`)
  assert.ok(Math.abs(c.exp - (Date.now() / 1000 + 3600)) < 10, '1시간')

  const main0 = tok.main
  const one = await snapshot(f, branch, KITFILES)
  await SRC.afterPush(c, f, [{ old: one.old, new: one.head, ref: `refs/heads/${branch}` }])
  await SRC.receive(L, { type: 'sync:pushed', folderId: f.id, head: one.head, report: { files: 6, bytes: 300, excluded: { secret: 1, personal: 2, nope: 9 }, flagged: 0, paths: ['/x'] } })
  const taken = L.last('sync:taken')
  assert.equal(taken.main, one.head, '앞감기')
  assert.equal(await G.head(f.repo_path, 'refs/heads/main'), one.head)
  assert.equal(await fs.readFile(path.join(f.repo_path, 'CLAUDE.md'), 'utf8'), KITFILES['CLAUDE.md'], 'main 의 작업 파일도')
  assert.equal((await KIT.kitOf(f)).length, 5)
  assert.ok((await S.tree(f)).some((x) => x.path === '견적/양식.md'))
  const [src] = await SRC.list(f, owner)
  assert.equal(src.label, '영업 제안 키트')
  assert.equal(src.mine, true)
  assert.deepEqual(src.report, { files: 6, bytes: 300, excluded: { gitignore: 0, secret: 1, personal: 2, rebuildable: 0, large: 0, structure: 0 }, flagged: 0 })
  assert.ok(src.lastPushedAt)
  assert.equal(main0 !== one.head, true)

  // a key in the next snapshot: put back at once (after the push), refused with where — main as it was
  const key = pem()
  const two = await snapshot(f, branch, { 'deploy/key.txt': `서버 열쇠\n${key}`, '견적/양식.md': '# 견적 양식 2판\n' }, { parent: one.head })
  await SRC.afterPush(c, f, [{ old: two.old, new: two.head, ref: `refs/heads/${branch}` }])
  assert.equal(await G.head(f.repo_path, `refs/heads/${branch}`), one.head, '가지는 직전 머리로')
  await SRC.receive(L, { type: 'sync:pushed', folderId: f.id, head: two.head, report: {} })
  const no = L.last('sync:refused')
  assert.equal(no.why, 'secret')
  assert.deepEqual(no.paths, [{ path: 'deploy/key.txt', line: 2, reason: 'private_key' }])
  assert.ok(!JSON.stringify(L.sent).includes(key.split('\n')[1]), '값은 어디에도')
  assert.equal(await G.head(f.repo_path, 'refs/heads/main'), one.head, 'main 그대로')
  // another branch under the device's prefix (the token may push there): looked at the same way, put back (gone — it was new)
  const side = await snapshot(f, `${SRC.prefixOf(d.id)}side`, { 'side/.env': 'A=1\n' }, { parent: one.head })
  await SRC.afterPush(c, f, [{ old: side.old, new: side.head, ref: `refs/heads/${SRC.prefixOf(d.id)}side` }])
  assert.equal(await G.head(f.repo_path, `refs/heads/${SRC.prefixOf(d.id)}side`), null, '옆 가지도 되돌림')
  assert.equal(await G.head(f.repo_path, `refs/heads/${branch}`), one.head)
  // the same, when the desktop reports before anyone looked (no after()): sync:pushed checks too
  const three = await snapshot(f, branch, { '.env': 'TOKEN=1\n' }, { parent: one.head })
  await SRC.receive(L, { type: 'sync:pushed', folderId: f.id, head: three.head, report: {} })
  assert.deepEqual(L.last('sync:refused').paths, [{ path: '.env', line: null, reason: 'name' }])
  assert.equal(await G.head(f.repo_path, `refs/heads/${branch}`), one.head)
  // a key added and removed again within the commits of one push is still found
  const four = await snapshot(f, branch, { 'a.pem': key }, { parent: one.head })
  const five = await snapshot(f, branch, { 'a.pem': null, 'ok.md': 'ok\n' }, { parent: four.head })
  await SRC.receive(L, { type: 'sync:pushed', folderId: f.id, head: five.head, report: {} })
  assert.equal(L.last('sync:refused').why, 'secret')
  // a clean one goes in (and the refusal is forgotten)
  const six = await snapshot(f, branch, { '견적/양식.md': '# 견적 양식 2판\n' }, { parent: one.head })
  await SRC.receive(L, { type: 'sync:pushed', folderId: f.id, head: six.head, report: { files: 6 } })
  assert.equal(L.last('sync:taken').main, six.head)
  assert.equal((await SRC.list(f, owner))[0].why, null)

  // main moved on the web meanwhile (no overlap): merged
  await fs.writeFile(path.join(f.repo_path, '웹에서.md'), '웹에서 고침\n')
  const seven = await snapshot(f, branch, { 'CLAUDE.md': '# 영업 제안 키트 2판\n' }, { parent: six.head })
  await SRC.receive(L, { type: 'sync:pushed', folderId: f.id, head: seven.head, report: {} })
  const merged = L.last('sync:taken').main
  assert.notEqual(merged, seven.head)
  assert.equal(await G.mergeBase(f.repo_path, seven.head, merged), seven.head, 'main 이 그 머리를 품는다')
  assert.ok((await G.lsTree(f.repo_path, 'main')).some((x) => x.path === '웹에서.md'))
  // …and with an overlap: main stays, the desktop hears it is behind
  await fs.writeFile(path.join(f.repo_path, 'CLAUDE.md'), '# 웹에서 바꾼 제목\n')
  await S.commitMain(f, owner, '웹 고침')
  const mainNow = await G.head(f.repo_path, 'refs/heads/main')
  const eight = await snapshot(f, branch, { 'CLAUDE.md': '# PC 에서 바꾼 제목\n' }, { parent: seven.head })
  await SRC.receive(L, { type: 'sync:pushed', folderId: f.id, head: eight.head, report: {} })
  assert.equal(L.last('sync:behind').main, mainNow)
  assert.equal(await G.head(f.repo_path, 'refs/heads/main'), mainNow)
  assert.equal((await SRC.list(f, owner))[0].why, 'conflict')

  // pause (by the folder owner) · the token refused · on again · removed · unbind from the desktop
  const sid = (await SRC.list(f, owner))[0].id
  await assert.rejects(SRC.setState(f, mate, 'viewer', sid, 'paused'), (e) => e.status === 403)
  await SRC.setState(f, owner, 'owner', sid, 'paused')
  await SRC.receive(L, { type: 'sync:token', folderId: f.id })
  assert.equal(L.last('sync:refused').why, 'paused')
  await SRC.setState(f, owner, 'owner', sid, 'active')
  await SRC.receive(L, { type: 'sync:token', folderId: f.id })
  assert.ok(L.last('sync:token'))
  await SRC.remove(f, owner, 'owner', sid)
  assert.deepEqual(await SRC.list(f, owner), [])
  await SRC.receive(L, { type: 'sync:token', folderId: f.id })
  assert.equal(L.last('sync:refused').why, 'source_removed')
  await SRC.receive(L, { type: 'sync:bind', folderId: f.id, label: '다시' })
  assert.ok(L.last('sync:bound'), '다시 묶으면 같은 줄이 살아난다')
  await SRC.receive(L, { type: 'sync:unbind', folderId: f.id })
  assert.equal(L.last('sync:unbound').folderId, f.id)
  const [r] = await q('select state from pro_folder_sources where folder_id=$1 and device_id=$2', [f.id, d.id])
  assert.equal(r.state, 'removed')
  // the folder is not empty any more: it is not removed by the cancel path
  await assert.rejects(S.discardEmptyChampion(await S.folderById(f.id), 'owner'), (e) => e.status === 409)
  // a revoked device is refused everything
  await q('update pro_local_devices set revoked_at=now() where id=$1', [d.id])
  await SRC.receive(L, { type: 'sync:bind', folderId: f.id, label: 'x' })
  assert.equal(L.last('sync:refused').why, 'device_revoked')
})
