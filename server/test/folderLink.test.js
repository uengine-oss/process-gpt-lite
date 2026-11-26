// 「저장소 연결」 — registering a repository on this server's own disk as a folder is for an install that
// serves one company: off behind the ProcessGPT gateway (PRO_TENANT_FROM_HEADER=1, production) and with more
// tenants by host name (PRO_TENANT_HOSTS), and PRO_FOLDERS_LINK=0 turns it off on an install too. Who may (an
// administrator) and where (never a place this server keeps folders in) is in e2e F-FO-02.
//   cd server && node --test test/folderLink.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { config } from '../config.js'
import { linkingOn, mayLink } from '../lib/folders/service.js'

test('linking a repository on the server is only for an install that serves one company', async () => {
  const saved = { fromHeader: config.tenantFromHeader, hosts: config.tenantHosts, env: process.env.PRO_FOLDERS_LINK }
  try {
    Object.assign(config, { tenantFromHeader: false, tenantHosts: '' })
    delete process.env.PRO_FOLDERS_LINK
    assert.equal(linkingOn(), true)
    config.tenantFromHeader = true
    assert.equal(linkingOn(), false, 'behind the gateway (production)')
    assert.equal(await mayLink({ id: '00000000-0000-0000-0000-000000000001' }), false)
    config.tenantFromHeader = false
    config.tenantHosts = 'en.localhost=en-demo'
    assert.equal(linkingOn(), false, 'more tenants by host name')
    config.tenantHosts = ''
    process.env.PRO_FOLDERS_LINK = '0'
    assert.equal(linkingOn(), false, 'turned off on an install')
    delete process.env.PRO_FOLDERS_LINK
    assert.equal(await mayLink(null), false, 'nobody signed in')
  } finally {
    Object.assign(config, { tenantFromHeader: saved.fromHeader, tenantHosts: saved.hosts })
    if (saved.env === undefined) delete process.env.PRO_FOLDERS_LINK
    else process.env.PRO_FOLDERS_LINK = saved.env
  }
})

// where a linked repository really is: its own top folder; never in the folders base, never a worktree whose
// git data is in the base, never a folder that holds the base
test('linkTarget: the top folder of a repository outside the folders base, nothing else', async () => {
  const fsp = await import('node:fs/promises')
  const os = await import('node:os')
  const path = await import('node:path')
  const { execFileSync } = await import('node:child_process')
  const { linkTarget } = await import('../lib/folders/service.js')
  const tmp = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'pgl-link-')))
  const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', ...a], { cwd, stdio: 'pipe' })
  const saved = config.foldersRoot
  try {
    const outer = path.join(tmp, 'outer') // holds the base
    const base = path.join(outer, 'base')
    config.foldersRoot = base
    await fsp.mkdir(path.join(base, 't1', 'kept'), { recursive: true })
    git(path.join(base, 't1', 'kept'), 'init', '-q', '-b', 'main')
    git(path.join(base, 't1', 'kept'), 'commit', '-q', '--allow-empty', '-m', 'x')
    const mine = path.join(tmp, 'mine')
    await fsp.mkdir(path.join(mine, 'sub'), { recursive: true })
    git(mine, 'init', '-q', '-b', 'main')
    git(mine, 'commit', '-q', '--allow-empty', '-m', 'x')
    assert.equal(await linkTarget(mine), mine)
    const code = async (p) => linkTarget(p).then(() => 200, (e) => e.status)
    assert.equal(await code(path.join(mine, 'sub')), 400, 'a folder inside a work tree is not a repository top')
    assert.equal(await code(path.join(base, 't1', 'kept')), 400, 'inside the base')
    // a worktree of a kept folder made outside the base: its git data is in the base
    const wt = path.join(tmp, 'wt')
    git(path.join(base, 't1', 'kept'), 'worktree', 'add', '-q', wt)
    assert.equal(await code(wt), 400, 'worktree of a kept folder')
    // a repository that holds the base
    git(outer, 'init', '-q', '-b', 'main')
    git(outer, 'commit', '-q', '--allow-empty', '-m', 'x')
    assert.equal(await code(outer), 400, 'holds the base')
    assert.equal(await code(path.join(tmp, 'nothing')), 400, 'not a repository')
  } finally {
    config.foldersRoot = saved
    await fsp.rm(tmp, { recursive: true, force: true })
  }
})

// a workroom is a git work tree: its .git (folder or file) is never read, written or listed through it
test('workroom paths never reach the repository data', async () => {
  const { gitPart } = await import('../lib/workroom.js')
  for (const p of ['.git', '.git/config', 'a/.GIT/hooks/pre-commit', 'x\\.git\\config', '.Git /x', '.git./x']) assert.equal(gitPart(p), true, p)
  for (const p of ['.gitignore', '.gitattributes', '.github/workflows/a.yml', 'docs/.gitkeep', 'a.git.md', 'README.md']) assert.equal(gitPart(p), false, p)
})
