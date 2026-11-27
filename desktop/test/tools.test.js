'use strict'
// The Process GPT tools a chat run's CLI gets (desktop 0.2.8 — src/mcp/server.js · src/runner/tools.js, spec openspec/specs/local-agents
// 「채팅에서 내 PC 의 스킬 · 폴더를 등록 제안」 · champion-folders 「채팅으로 폴더 올리기 제안」). No CLI and no server: the stdio MCP server is
// called as an MCP client would (JSON-RPC over its stdin · stdout), the server's API is a stand-in that records what it was sent.
//   DT-01 which folder: ~, a path relative to the work folder (never leaving it), absolute; never a link, the disk's top, the home folder or
//         above, the system's folders (~/Library, /System, /usr …), anything in the CLIs' homes but their skills folders, a hidden folder
//         right under the home folder (~/.kube, ~/.docker, ~/.config/gcloud …), a secret's or a personal folder anywhere (.ssh ·
//         .claude/projects · .codex/sessions · .vscode), this app's data
//   DT-02 the skills on this PC: Claude Code's ($CLAUDE_CONFIG_DIR/skills), Codex's, the work folder's — name and description from SKILL.md;
//         a link listed as one (where it points), never read through; `under` a folder the person named
//   DT-03 a skill read here: the champion folders' scan — secrets, personal settings, rebuildable, links, keys of a sure shape and files to
//         check left out, and git's control files (.gitignore · .gitattributes); SKILL.md at its top; a skill's size; its run settings
//   DT-04 the stdio MCP server: initialize · tools/list (five tools) · tools/call through the app's channel with the run's key; a closed run
//         (or a wrong key) answers nothing of it
//   DT-05 lite_propose_skill: the files go to the server with the run's token as a proposal — no path of this PC, no token in the config
//         file; what the CLI is told: not registered until 「등록」
//   DT-06 lite_propose_folder: the champion folders' own pick and preview; the server's tools:upload binds only a pick made for that
//         proposal (never the page's own, never a path) with the card as the person's yes
//   DT-07 the CLI's command line: Claude Code --mcp-config (the app's server beside the person's own) and its tools allowed; Codex -c
//         mcp_servers.…; none without the tools
//   DT-08 the app says it has them (caps liteTools · liteFolders); the packaged app can run the server as node (RunAsNode left as shipped)
//   DT-10 (in DT-06) a folder changed between the proposal and 「올리기」 — a file added, a size, an edit of the same size, two files
//         swapped by name, the folder replaced by a link — uploads nothing: 'changed' (and that pick is gone); unchanged, it goes
//   DT-09 a chat run's Claude Code gets ENABLE_TOOL_SEARCH=false (the tools load with the session — the company gateway cannot take
//         Claude Code's deferred tool references); the person's own env or the runner's setting wins; not for a step, not for Codex
//   node --test test/tools.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')
const TL = require('../src/runner/tools')
const SY = require('../src/runner/sync')
const MT = require('../src/mcp/tools')
const { CliSession, codexMcp } = require('../src/runner/session')

const WIN = process.platform === 'win32'
// (macOS's own temporary folder is under /var — a system folder the tools refuse, the person's temporary files with it: this PC's folders
// for the test are made under /tmp there)
const TMP = process.platform === 'darwin' ? '/tmp' : os.tmpdir()
// (the disk's own spelling, as the tools read a folder — realpathSync.native: on Windows the long name, not RUNNER~1)
const ROOT = fs.realpathSync.native(fs.mkdtempSync(path.join(TMP, 'pgl-tools-')))
const HOME = path.join(ROOT, 'home')
const DATA = path.join(ROOT, 'app', 'data')
const WORK = path.join(ROOT, 'work')
const CLAUDE = path.join(HOME, '.claude')
// (this PC's environment for HOME: on Windows its AppData is HOME's — the runner's own %TEMP% is in its real LOCALAPPDATA, a system folder
// the tools refuse, and the test's folders outside HOME are there)
const ENV = { ...process.env, CLAUDE_CONFIG_DIR: CLAUDE, CODEX_HOME: path.join(HOME, '.codex'),
  ...(WIN ? { APPDATA: path.join(HOME, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(HOME, 'AppData', 'Local') } : {}) }
const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text) }
const SKILL = (name, desc, extra = '') => `---\nname: ${name}\ndescription: ${desc}\n${extra}---\n# ${name}\n본문\n`
fs.mkdirSync(DATA, { recursive: true })
fs.mkdirSync(WORK, { recursive: true })
// (whatever a failing test left open goes too: the MCP servers it started, the app's channel)
const kids = []
let desk, srv
test.after(() => {
  for (const k of kids) try { k.kill() } catch { /* gone */ }
  desk?.stop()
  try { fs.rmSync(ROOT, { recursive: true, force: true }) } catch { /* gone */ }
})

// a stand-in for the server's API (what it was sent)
function server({ status = 200, answer = (p, body) => ({ id: crypto.randomUUID(), name: body?.name || '', state: 'pending', expiresInMinutes: 60 }) } = {}) {
  const calls = []
  const fetchImpl = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : null
    calls.push({ url, method: opts.method || 'GET', auth: opts.headers?.Authorization, body })
    const p = new URL(url).pathname
    return { ok: status < 400, status, json: async () => (status < 400 ? answer(p, body) : { error: 'nope', code: 'x' }) }
  }
  return { calls, fetchImpl }
}
const memStore = () => { const m = new Map(); return { get: (id) => m.get(String(id)) || null, put: (e) => m.set(String(e.folderId), e), all: () => [...m.values()], drop: (id) => m.delete(String(id)) } }

test('DT-01 어느 폴더: ~ · 작업 폴더 기준 상대 경로(밖으로 못 나감) · 절대 경로 — 링크 · 디스크 맨 위 · 홈과 그 위 · 시스템 폴더 · CLI 의 집 · 비밀 폴더 · 앱 데이터는 거절', async () => {
  const r = (s) => TL.resolvePath(s, { cwd: WORK, home: HOME })
  assert.equal(r('~').abs, HOME)
  assert.equal(r('~/a/b').abs, path.join(HOME, 'a', 'b'))
  assert.equal(r('sub/x').abs, path.join(WORK, 'sub', 'x'))
  assert.equal(r('../밖').error, 'escapes')
  assert.equal(r('sub/../../밖').error, 'escapes')
  assert.equal(r('~other/x').error, 'bad_path')
  assert.equal(r('a\0b').error, 'bad_path')
  assert.equal(r('').error, 'bad_path')
  assert.equal(TL.resolvePath('rel', { cwd: null }).error, 'bad_path')
  const check = (p) => TL.checkFolder(p, { home: HOME, env: ENV, dataDir: DATA })
  put(path.join(HOME, 'skills', 'a', 'SKILL.md'), SKILL('a', 'x'))
  assert.equal((await check(path.join(HOME, 'skills', 'a'))).real, path.join(HOME, 'skills', 'a'))
  fs.symlinkSync(path.join(HOME, 'skills', 'a'), path.join(HOME, 'skills', 'link-a'), WIN ? 'junction' : 'dir')
  assert.equal((await check(path.join(HOME, 'skills', 'link-a'))).error, 'link')
  assert.equal((await check(path.parse(ROOT).root)).error, 'system_folder')
  assert.equal((await check(HOME)).error, 'home_folder')
  assert.equal((await check(ROOT)).error, 'home_folder', 'above the home folder')
  fs.mkdirSync(path.join(HOME, 'Library', 'Mail'), { recursive: true })
  if (!WIN) assert.equal((await check(path.join(HOME, 'Library', 'Mail'))).error, 'system_folder', '~/Library')
  if (process.platform === 'darwin') assert.equal((await check('/System/Library')).error, 'system_folder')
  if (!WIN) assert.equal((await check('/usr/bin')).error, 'system_folder')
  fs.mkdirSync(CLAUDE, { recursive: true })
  assert.equal((await check(CLAUDE)).error, 'cli_home')
  // nothing in a CLI's home but its skills folder (its sessions, histories, settings — ~/.claude/projects, ~/.codex/sessions)
  for (const d of [path.join(CLAUDE, 'projects', 'x'), path.join(CLAUDE, 'plugins'), path.join(HOME, '.codex', 'sessions'), path.join(HOME, '.agents', 'memory')]) {
    fs.mkdirSync(d, { recursive: true })
    assert.equal((await check(d)).error, 'cli_home', d)
  }
  for (const d of [path.join(CLAUDE, 'skills', 'quote'), path.join(HOME, '.codex', 'skills', 'q'), path.join(HOME, '.agents', 'skills', 'q')]) {
    fs.mkdirSync(d, { recursive: true })
    assert.equal((await check(d)).real, d, d)
  }
  // a hidden folder right under the home folder, and what is in it — a program's own place
  for (const d of [path.join(HOME, '.kube'), path.join(HOME, '.docker', 'contexts'), path.join(HOME, '.azure'), path.join(HOME, '.config', 'gcloud'), path.join(HOME, '.config', 'gh'),
    path.join(HOME, '.mozilla', 'firefox'), path.join(HOME, '.local', 'share', 'keyrings')]) {
    fs.mkdirSync(d, { recursive: true })
    assert.equal((await check(d)).error, 'hidden_folder', d)
  }
  // the champion folders' personal places, wherever the folder is (outside the home folder too)
  for (const d of [path.join(ROOT, 'work2', 'proj', '.claude', 'projects'), path.join(ROOT, 'work2', 'proj', '.codex', 'sessions', 'a'), path.join(ROOT, 'work2', 'proj', '.vscode')]) {
    fs.mkdirSync(d, { recursive: true })
    assert.equal((await check(d)).error, 'personal_folder', d)
  }
  // (a hidden folder deeper down is a person's own: a project's .github)
  fs.mkdirSync(path.join(HOME, 'proj', '.github'), { recursive: true })
  assert.equal((await check(path.join(HOME, 'proj', '.github'))).real, path.join(HOME, 'proj', '.github'))
  fs.mkdirSync(path.join(HOME, '.ssh', 'keys'), { recursive: true })
  assert.equal((await check(path.join(HOME, '.ssh', 'keys'))).error, 'secret_folder')
  assert.equal((await check(DATA)).error, 'app_folder')
  assert.equal((await check(path.join(HOME, 'nope'))).error, 'not_found')
  assert.equal((await check(path.join(HOME, 'skills', 'a', 'SKILL.md'))).error, 'not_folder')
  // the system's state and each person's temporary and cache folders (/var · /private/var — macOS's /var/folders/…/T · C), Homebrew's,
  // snap's per-app homes on Linux (their own hidden folders inside — ~/snap/firefox/common/.mozilla)
  if (!WIN) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pgl-tools-tmp-'))
    try {
      for (const d of ['/var/log', '/private/var/db', process.platform === 'darwin' ? tmp : null, '/opt/homebrew/bin'].filter((x) => x && fs.existsSync(x))) {
        assert.equal((await check(d)).error, 'system_folder', d)
      }
    } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
    fs.mkdirSync(path.join(HOME, 'snap', 'firefox', 'common', '.mozilla'), { recursive: true })
    assert.equal((await check(path.join(HOME, 'snap', 'firefox', 'common', '.mozilla'))).error, 'system_folder', '~/snap')
    // /var's system places, not /var as a whole: a home under it (Fedora Silverblue's /var/home) and a site's folder (/var/www/…) are a
    // person's own; /run/user (each person's runtime files)
    const VAR = process.platform === 'darwin' ? '/private/var' : '/var'
    const vh = path.join(VAR, 'home', 'hy')
    for (const [p, sys] of [[path.join(vh, 'proj'), false], [path.join(VAR, 'www', 'site'), false], [path.join(VAR, 'log', 'x'), true], [path.join(VAR, 'lib', 'containers'), true],
      [path.join(VAR, 'folders', 'ab', 'cd', 'T', 'x'), true], [path.join(VAR, 'cache', 'x'), true], [VAR, true], ['/run/user/1000/x', true]]) {
      assert.equal(TL.systemFolderOf(p, vh, ENV), sys, p)
    }
    // (all of /var is the system's but a person's places — a /var child no list names is refused too; a site's data under /var/srv is not)
    for (const [p, sys] of [[path.join(VAR, 'setup', 'x'), true], [path.join(VAR, 'boot', 'x'), true], [path.join(VAR, 'srv', 'data'), false]]) {
      assert.equal(TL.systemFolderOf(p, vh, ENV), sys, p)
    }
    // (a home set inside a system folder opens the home only, never its neighbours)
    if (process.platform !== 'win32') {
      assert.equal(TL.systemFolderOf('/usr/bin', '/usr/local/x', ENV), true, 'a home under /usr: /usr/bin stays the system\'s')
      assert.equal(TL.systemFolderOf('/usr/local/x/proj', '/usr/local/x', ENV), false, 'what is in that home is the person\'s')
    }
    // (a real one: a home made under /var — macOS's own temporary folder is there — its folders are the person's)
    if (process.platform === 'darwin') {
      const tmpHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pgl-varhome-')))
      try {
        fs.mkdirSync(path.join(tmpHome, 'proj'), { recursive: true })
        assert.equal((await TL.checkFolder(path.join(tmpHome, 'proj'), { home: tmpHome, env: ENV, dataDir: DATA })).real, path.join(tmpHome, 'proj'), 'a home under /var')
        assert.equal((await TL.checkFolder(path.dirname(tmpHome), { home: tmpHome, env: ENV, dataDir: DATA })).error, 'home_folder', 'its way there')
      } finally { fs.rmSync(tmpHome, { recursive: true, force: true }) }
    }
    // a cloud drive's folders under ~/Library (Dropbox · OneDrive · Google Drive · iCloud Drive) are a person's work — not the place itself,
    // not a drive's top, not the rest of ~/Library
    for (const [rel, ok] of [[['CloudStorage', 'Dropbox', '영업'], true], [['Mobile Documents', 'iCloud~md~obsidian', 'Documents', '금고'], true],
      [['Mobile Documents', 'com~apple~CloudDocs', '자료'], true], [['CloudStorage'], false], [['CloudStorage', 'Dropbox'], false], [['Mobile Documents'], false],
      [['Mobile Documents', 'com~apple~CloudDocs'], false], [['Application Support', 'x'], false],
      // (an app's own iCloud data — mail, text replacements — and its Documents folder's top; a drive's hidden cache or trash)
      [['Mobile Documents', 'com~apple~mail', 'x'], false], [['Mobile Documents', 'com~apple~TextInput', 'x'], false],
      [['Mobile Documents', 'iCloud~md~obsidian', 'Documents'], false], [['CloudStorage', 'Dropbox', '.dropbox.cache'], false],
      [['Mobile Documents', 'com~apple~CloudDocs', '.Trash', 'x'], false]]) {
      const d = path.join(HOME, 'Library', ...rel)
      fs.mkdirSync(d, { recursive: true })
      const c = await check(d)
      if (ok) assert.equal(c.real, d, d)
      else assert.equal(c.error, 'system_folder', d)
    }
    // a volume's top (not what is in it)
    assert.equal(TL.volumeTop('/run/media/hy'), true)
    assert.equal(TL.volumeTop('/Volumes/USB'), true)
    assert.equal(TL.volumeTop('/Volumes/USB/proj'), false)
    assert.equal(TL.volumeTop('/media/hy/USB'), true)
    assert.equal(TL.volumeTop('/run/media/hy/USB'), true)
    assert.equal(TL.volumeTop('/mnt/data'), true)
    assert.equal(TL.volumeTop('/mnt/data/proj'), false)
  }
  // a CLI home named in another case than the disk's (a Mac's or Windows' disk reads both as one): still that CLI's home
  if (process.platform === 'darwin' || WIN) {
    const conf = path.join(ROOT, 'conf', 'Claude-Config')
    fs.mkdirSync(path.join(conf, 'projects', 'x'), { recursive: true })
    fs.mkdirSync(path.join(conf, 'skills', 'q'), { recursive: true })
    const other = { ...ENV, CLAUDE_CONFIG_DIR: path.join(ROOT, 'conf', 'claude-config') }
    assert.equal((await TL.checkFolder(path.join(conf, 'projects', 'x'), { home: HOME, env: other, dataDir: DATA })).error, 'cli_home')
    assert.equal((await TL.checkFolder(path.join(conf, 'skills', 'q'), { home: HOME, env: other, dataDir: DATA })).real, path.join(conf, 'skills', 'q'))
  }
})

test('DT-02 이 PC 의 스킬: Claude Code · Codex · 작업 폴더 — 이름 · 설명은 SKILL.md 에서, 링크는 링크로(가리키는 곳만), under 로 사람이 말한 폴더', async () => {
  put(path.join(CLAUDE, 'skills', '견적-규칙', 'SKILL.md'), SKILL('견적-규칙', '견적서를 회사 양식으로 써요', 'allowed-tools: Bash\n'))
  put(path.join(CLAUDE, 'skills', 'meeting', 'SKILL.md'), SKILL('회의록', '회의록을 정리해요'))
  fs.mkdirSync(path.join(CLAUDE, 'skills', 'empty-dir'), { recursive: true })
  put(path.join(HOME, 'elsewhere', 'linked', 'SKILL.md'), SKILL('linked', 'x'))
  fs.symlinkSync(path.join(HOME, 'elsewhere', 'linked'), path.join(CLAUDE, 'skills', 'linked'), WIN ? 'junction' : 'dir')
  put(path.join(HOME, '.codex', 'skills', 'codex-one', 'SKILL.md'), SKILL('codex-one', 'Codex 의 스킬'))
  put(path.join(WORK, '.claude', 'skills', 'project-one', 'SKILL.md'), SKILL('project-one', '작업 폴더의 스킬'))
  const desk = new TL.ToolDesk({ dataDir: DATA, server: 'http://srv', home: HOME })
  const run = { cwd: WORK, env: ENV, lang: 'ko', jobId: 'j' }
  const r = JSON.parse((await desk.listPcSkills(run)).text)
  const by = Object.fromEntries(r.skills.map((s) => [s.name, s]))
  assert.equal(by['견적-규칙'].description, '견적서를 회사 양식으로 써요')
  assert.equal(by['견적-규칙'].runs, true, 'its run settings are said')
  assert.equal(by['견적-규칙'].path, `~${path.sep}${path.join('.claude', 'skills', '견적-규칙')}`)
  assert.equal(by['회의록'].where, 'Claude Code (personal)')
  assert.equal(by.linked.link, true)
  assert.equal(by.linked.pointsTo, `~${path.sep}${path.join('elsewhere', 'linked')}`)
  assert.equal(by.linked.description, '', 'not read through')
  assert.equal(by['codex-one'].where, 'Codex')
  assert.equal(by['project-one'].where, 'this work folder')
  assert.ok(!by['empty-dir'])
  assert.match(r.note, /pointsTo/)
  const u = JSON.parse((await desk.listPcSkills(run, { under: '~/elsewhere' })).text)
  assert.deepEqual(u.skills.map((s) => s.name), ['linked'])
  assert.equal((await desk.listPcSkills(run, { under: '~' })).isError, true, 'the home folder itself')
})

const SKILL_DIR = path.join(HOME, 'skills', 'proposal')
function skillFolder() {
  fs.rmSync(SKILL_DIR, { recursive: true, force: true })
  put(path.join(SKILL_DIR, 'SKILL.md'), SKILL('제안서-쓰기', '제안서를 회사 양식으로 써요', 'hooks:\n  PreToolUse: []\n'))
  put(path.join(SKILL_DIR, 'templates', '표지.md'), '# 표지\n')
  put(path.join(SKILL_DIR, '.env'), 'API_KEY=1\n')
  put(path.join(SKILL_DIR, 'id_rsa'), 'x\n')
  put(path.join(SKILL_DIR, '.claude', 'settings.local.json'), '{}\n')
  put(path.join(SKILL_DIR, 'node_modules', 'x', 'index.js'), 'x\n')
  put(path.join(SKILL_DIR, 'keys.txt'), `token = ghp_${'a1B2'.repeat(9)}\n`)
  put(path.join(SKILL_DIR, 'conf.sh'), 'SECRET_VALUE=aZ3kQ9mW2xP7vL5nR8tY4uJ6\n')
  put(path.join(SKILL_DIR, '.mcp.json'), JSON.stringify({ mcpServers: { x: { command: 'x' } } }))
  put(path.join(SKILL_DIR, '.gitignore'), 'node_modules/\n')
  put(path.join(SKILL_DIR, 'templates', '.gitattributes'), '* text=auto\n')
  // (a name Windows and a Mac read as .lfsconfig: case aside, a trailing dot dropped)
  if (!WIN) put(path.join(SKILL_DIR, 'docs', '.LFSCONFIG.'), '[lfs]\n\turl = https://example.test/lfs\n')
  fs.symlinkSync(path.join(HOME, 'elsewhere'), path.join(SKILL_DIR, 'out-link'), WIN ? 'junction' : 'dir')
}

test('DT-03 여기서 읽는 스킬: 챔피언 폴더의 검사 그대로 — 비밀 · 개인 설정 · 다시 만들 것 · 링크 · 확실한 열쇠 · 확인할 파일은 빼고, 맨 위 SKILL.md · 크기 · 실행 설정', async () => {
  skillFolder()
  const gitDir = path.join(DATA, 'tools', 'scan.git')
  const k = await TL.packSkill(SKILL_DIR, { gitDir })
  assert.ok(k.skill, JSON.stringify(k))
  const paths = k.skill.files.map((f) => f.path).sort()
  assert.deepEqual(paths, ['SKILL.md', 'templates/표지.md'])
  assert.equal(Buffer.from(k.skill.files.find((f) => f.path === 'templates/표지.md').data, 'base64').toString(), '# 표지\n')
  const groups = Object.fromEntries(k.skill.excluded.map((g) => [g.group, g.count]))
  assert.ok(groups.secret >= 2, '.env · id_rsa')
  assert.ok(groups.personal >= 1, 'settings.local.json')
  assert.ok(groups.rebuildable >= 1, 'node_modules')
  // (Windows: git does not list a junction at all — what it leads to stays out all the same, the paths above — so only the control files count)
  assert.ok(groups.structure >= (WIN ? 2 : 3), 'the link, and git\'s control files (.gitignore · .gitattributes) — the server keeps a skill in its own repository')
  assert.ok(k.skill.excluded.find((g) => g.group === 'structure').samples.some((x) => x.endsWith('.gitattributes')))
  if (!WIN) assert.ok(groups.structure >= 4, 'docs/.LFSCONFIG. is .lfsconfig')
  assert.equal(k.skill.flagged, 3, 'a sure key, a value to check and a .mcp.json (it runs things — a file to check) stay out')
  assert.deepEqual(k.skill.runs, ['hooks'])
  assert.deepEqual(k.skill.runFiles, [])
  assert.equal(k.skill.name, '제안서-쓰기')
  // no SKILL.md at its top
  const plain = path.join(HOME, 'plain')
  put(path.join(plain, 'docs', 'SKILL.md'), SKILL('x', 'y'))
  assert.equal((await TL.packSkill(plain, { gitDir })).error, 'no_skill_md')
  // too many files for a skill
  const many = path.join(HOME, 'many')
  put(path.join(many, 'SKILL.md'), SKILL('many', 'm'))
  for (let i = 0; i < TL.SKILL_MAX_FILES; i++) put(path.join(many, 'f', `${i}.md`), 'x')
  assert.equal((await TL.packSkill(many, { gitDir })).error, 'too_many')
})

// the stdio MCP server as an MCP client calls it → {call(method, params), notify, close}
function mcp(file) {
  const p = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'mcp', 'server.js'), '--config', file], { stdio: ['pipe', 'pipe', 'pipe'] })
  kids.push(p)
  let buf = ''
  const waiting = new Map()
  p.stdout.on('data', (d) => {
    buf += d
    let n
    while ((n = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, n); buf = buf.slice(n + 1)
      const m = JSON.parse(line)
      waiting.get(m.id)?.(m); waiting.delete(m.id)
    }
  })
  let id = 0
  return {
    call: (method, params = {}) => new Promise((res) => { const i = ++id; waiting.set(i, res); p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: i, method, params })}\n`) }),
    notify: (method, params = {}) => p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`),
    close: () => new Promise((res) => { p.once('exit', res); p.stdin.end() }),
  }
}
const textOf = (m) => m.result?.content?.[0]?.text || ''

test('DT-04 stdio MCP 서버: initialize · tools/list(다섯) · tools/call 은 이 실행의 열쇠로 앱에 — 닫힌 실행 · 틀린 열쇠는 아무것도 못 한다', async () => {
  srv = server()
  desk = new TL.ToolDesk({ dataDir: DATA, server: 'http://srv.test/lite', home: HOME, fetchImpl: srv.fetchImpl })
  const stateDir = path.join(DATA, 'sessions', 'job-1')
  const open = await desk.open({ stateDir, jobId: crypto.randomUUID(), cwd: WORK, lang: 'ko', env: ENV, token: 'plt1.run-token.sig' })
  const conf = JSON.parse(fs.readFileSync(open.file, 'utf8'))
  assert.deepEqual(Object.keys(conf).sort(), ['ipc', 'key', 'lang'], 'no server token in the file')
  if (!WIN) assert.equal(fs.statSync(open.file).mode & 0o777, 0o600)
  assert.deepEqual(open.program.args.slice(-2), ['--config', open.file])
  const c = mcp(open.file)
  const init = await c.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
  assert.equal(init.result.protocolVersion, '2025-06-18')
  assert.equal(init.result.serverInfo.name, MT.SERVER_NAME)
  c.notify('notifications/initialized')
  const list = await c.call('tools/list')
  assert.deepEqual(list.result.tools.map((t) => t.name), ['lite_list_pc_skills', 'lite_list_my_skills', 'lite_propose_skill', 'lite_list_my_folders', 'lite_propose_folder'])
  assert.match(list.result.tools.find((t) => t.name === 'lite_propose_skill').description, /NOTHING is registered until the person presses 「등록」/)
  const pcs = await c.call('tools/call', { name: 'lite_list_pc_skills', arguments: {} })
  assert.ok(JSON.parse(textOf(pcs)).skills.some((s) => s.name === '견적-규칙'))
  const unknown = await c.call('tools/call', { name: 'rm_rf', arguments: {} })
  assert.equal(unknown.result.isError, true)
  assert.equal((await c.call('nope')).error.code, -32601)
  assert.deepEqual((await c.call('ping')).result, {})
  // the run ends: its key no longer answers
  desk.close(open.key)
  const after = await c.call('tools/call', { name: 'lite_list_pc_skills', arguments: {} })
  assert.equal(after.result.isError, true)
  assert.match(textOf(after), /closed/)
  await c.close()
  // a wrong key on the same channel
  const bad = path.join(stateDir, 'bad.json')
  fs.writeFileSync(bad, JSON.stringify({ ...conf, key: 'f'.repeat(64) }))
  const c2 = mcp(bad)
  assert.equal((await c2.call('tools/call', { name: 'lite_list_pc_skills', arguments: {} })).result.isError, true)
  await c2.close()
})

test('DT-05 lite_propose_skill: 파일은 이 실행의 토큰으로 서버에 「제안」으로 — PC 의 경로 없음 · CLI 에게는 「등록」을 눌러야 등록된다고', async () => {
  skillFolder()
  const token = 'plt1.the-run.token'
  const open = await desk.open({ stateDir: path.join(DATA, 'sessions', 'job-2'), jobId: crypto.randomUUID(), cwd: WORK, lang: 'ko', env: ENV, token })
  const c = mcp(open.file)
  await c.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
  const r = await c.call('tools/call', { name: 'lite_propose_skill', arguments: { path: '~/skills/proposal', scope: 'company' } })
  assert.equal(r.result.isError, undefined, textOf(r))
  assert.match(textOf(r), /「스킬을 등록할까요\?」 카드/)
  assert.match(textOf(r), /「등록」을 눌러야 등록돼요/)
  assert.match(textOf(r), /실행 설정이 있어요/)
  const sent = srv.calls.at(-1)
  assert.equal(sent.url, 'http://srv.test/lite/api/local-agents/tools/skills/propose')
  assert.equal(sent.auth, `Bearer ${token}`)
  assert.equal(sent.body.name, '제안서-쓰기')
  assert.equal(sent.body.scope, 'company')
  assert.deepEqual(sent.body.source, { where: 'other', label: 'proposal' })
  assert.deepEqual(sent.body.files.map((f) => f.path).sort(), ['SKILL.md', 'templates/표지.md'])
  assert.ok(!JSON.stringify(sent.body).includes(HOME), 'no path of this PC')
  // a skill in Claude Code's own folder says so; a named SKILL.md is its folder; a name given
  await c.call('tools/call', { name: 'lite_propose_skill', arguments: { path: path.join(CLAUDE, 'skills', '견적-규칙', 'SKILL.md'), name: '견적 규칙 v2' } })
  assert.deepEqual(srv.calls.at(-1).body.source, { where: 'claude', label: '견적-규칙' })
  assert.equal(srv.calls.at(-1).body.name, '견적 규칙 v2')
  // refused here, nothing sent
  const n = srv.calls.length
  for (const [p, why] of [['../밖', /작업 폴더 밖/], ['~', /홈 폴더/], ['~/skills/link-a', /링크/], ['~/.ssh/keys', /\.ssh/], ['~/plain', /SKILL\.md/]]) {
    const x = await c.call('tools/call', { name: 'lite_propose_skill', arguments: { path: p } })
    assert.equal(x.result.isError, true, p)
    assert.match(textOf(x), why, p)
  }
  assert.equal(srv.calls.length, n, 'nothing went to the server')
  // the server's own refusal is what the CLI hears (a name taken — ask the person)
  const no = server({ status: 409 })
  desk.fetch = no.fetchImpl
  const x = await c.call('tools/call', { name: 'lite_propose_skill', arguments: { path: '~/skills/proposal' } })
  assert.equal(x.result.isError, true)
  desk.fetch = srv.fetchImpl
  // a run without a token from the server: the tools say so
  const open2 = await desk.open({ stateDir: path.join(DATA, 'sessions', 'job-3'), jobId: crypto.randomUUID(), cwd: WORK, lang: 'en', env: ENV, token: null })
  const c3 = mcp(open2.file)
  const y = await c3.call('tools/call', { name: 'lite_propose_skill', arguments: { path: '~/skills/proposal' } })
  assert.match(textOf(y), /not available in this run/)
  await c3.close()
  await c.close()
})

test('DT-06 · DT-10 lite_propose_folder: 챔피언 폴더의 pick · 미리 보기 그대로, tools:upload 는 그 제안의 pick 만 묶는다(페이지의 pick · 경로는 아님) — 카드가 그 사람의 「예」, 그사이 바뀐 폴더는 올리지 않는다', async () => {
  const sent = []
  const folders = new SY.FolderSync({ dataDir: DATA, server: 'http://srv.test/lite', userId: 'u-1', store: memStore(), send: (m) => { sent.push(m); return true } })
  folders.linkUp({ id: 'u-1' })
  const binds = []
  // (the champion folders' bind as far as its yes: its own look at the folder, then confirm — no server here)
  folders.bind = async (v, { confirm }) => {
    const p = folders.picks.get(v.pickId)
    const look = await folders.scanOf(p.dir, folders.scratch(), [], [])
    const yes = await confirm({ fingerprint: look.fingerprint, files: look.report.files, bytes: look.report.bytes })
    binds.push({ ...v, yes })
    return yes ? { ok: true, folderId: v.folderId, pushed: { files: look.report.files, bytes: look.report.bytes } } : { ok: false, why: 'cancelled' }
  }
  const s = server()
  const answers = []
  const d = new TL.ToolDesk({ dataDir: DATA, server: 'http://srv.test/lite', home: HOME, fetchImpl: s.fetchImpl, folders, send: (m) => { answers.push(m); return true } })
  const run = { cwd: WORK, env: ENV, lang: 'ko', jobId: 'j', token: 'plt1.t.s' }
  const kit = path.join(HOME, '영업 키트')
  put(path.join(kit, 'README.md'), '# 영업 키트\n')
  put(path.join(kit, '.claude', 'skills', '견적', 'SKILL.md'), SKILL('견적', '견적서'))
  put(path.join(kit, '.env'), 'X=1\n')
  const r = await d.proposeFolder(run, { path: '~/영업 키트' })
  assert.equal(r.isError, undefined, r.text)
  assert.match(r.text, /「폴더를 올릴까요\?」 카드/)
  assert.match(r.text, /「올리기」를 눌러야 업로드돼요/)
  const body = s.calls.at(-1).body
  assert.equal(s.calls.at(-1).url, 'http://srv.test/lite/api/local-agents/tools/folders/propose')
  assert.equal(body.label, '영업 키트')
  assert.equal(body.preview.files, 2)
  assert.ok(body.preview.excluded.some((g) => g.group === 'secret'))
  assert.ok(body.preview.kit.some((k) => k.type === 'skill'))
  assert.ok(!JSON.stringify(body).includes(HOME), 'no path of this PC')
  // (the server's answer named the proposal: the app keeps which pick it was for)
  const [pickId, mine] = [...d.proposed.entries()][0]
  assert.equal(pickId, body.pickId)
  // a pick of the page's own dialog (not proposed from a run) is never bound this way
  const pagePick = await folders.pick(kit)
  await d.handle({ type: 'tools:upload', proposalId: mine.proposalId, pickId: pagePick.pickId, folderId: crypto.randomUUID(), folderName: 'x' })
  assert.deepEqual(answers.at(-1), { type: 'tools:uploaded', proposalId: mine.proposalId, ok: false, why: 'no_pick' })
  // another proposal's id with this pick: no
  await d.handle({ type: 'tools:upload', proposalId: crypto.randomUUID(), pickId, folderId: crypto.randomUUID(), folderName: 'x' })
  assert.equal(answers.at(-1).why, 'no_pick')
  assert.equal(binds.length, 0)
  // the card's 「올리기」: the champion folders' bind, the card as the yes
  const folderId = crypto.randomUUID()
  await d.handle({ type: 'tools:upload', proposalId: mine.proposalId, pickId, folderId, folderName: '영업 키트' })
  assert.deepEqual(binds, [{ pickId, folderId, folderName: '영업 키트', yes: true }])
  assert.deepEqual(answers.at(-1), { type: 'tools:uploaded', proposalId: mine.proposalId, ok: true, why: null, pushed: { files: 2, bytes: body.preview.bytes } })
  // the same again: done once
  await d.handle({ type: 'tools:upload', proposalId: mine.proposalId, pickId, folderId, folderName: '영업 키트' })
  assert.equal(answers.at(-1).why, 'no_pick')
  // refused here: the home folder, a system folder, nothing to upload
  assert.match((await d.proposeFolder(run, { path: '~' })).text, /홈 폴더/)
  fs.mkdirSync(path.join(HOME, 'empty'), { recursive: true })
  assert.match((await d.proposeFolder(run, { path: '~/empty' })).text, /올릴 파일이 없어요/)
  // an app without the champion folders' engine
  const none = new TL.ToolDesk({ dataDir: DATA, server: 'http://srv', home: HOME, fetchImpl: s.fetchImpl })
  assert.match((await none.proposeFolder(run, { path: '~/영업 키트' })).text, /폴더를 올릴 수 없어요/)

  // ---- DT-10 the card shows what goes up: changed since the proposal → nothing goes up, 「changed」
  const proposeAgain = async (p = '~/영업 키트') => { const x = await d.proposeFolder(run, { path: p }); assert.equal(x.isError, undefined, x.text); return [...d.proposed.entries()].at(-1) }
  const press = async ([pid, m]) => { await d.handle({ type: 'tools:upload', proposalId: m.proposalId, pickId: pid, folderId: crypto.randomUUID(), folderName: '영업 키트' }); return answers.at(-1) }
  // a file added after the proposal
  let p1 = await proposeAgain()
  put(path.join(kit, '추가.md'), '# 나중에 넣은 파일\n')
  let a = await press(p1)
  assert.equal(a.ok, false)
  assert.equal(a.why, 'changed')
  assert.equal(binds.at(-1).yes, false, 'the upload\'s own look did not match: no yes')
  assert.equal(d.proposed.has(p1[0]), false)
  assert.equal(folders.picks.has(p1[0]), false, 'that pick cannot be bound later')
  // the same files, one of them a different size
  p1 = await proposeAgain()
  put(path.join(kit, 'README.md'), '# 영업 키트 — 고친 판\n')
  a = await press(p1)
  assert.equal(a.why, 'changed')
  // the same size, other bytes: an edit that keeps the size
  p1 = await proposeAgain()
  put(path.join(kit, 'README.md'), '# 영업 키트 — 고친 팬\n')
  a = await press(p1)
  assert.equal(a.why, 'changed', 'an edit of the same size')
  // two files of the same size swapped by name
  put(path.join(kit, '가.md'), 'AAAA\n')
  put(path.join(kit, '나.md'), 'BBBB\n')
  p1 = await proposeAgain()
  fs.renameSync(path.join(kit, '가.md'), path.join(kit, '다.md'))
  fs.renameSync(path.join(kit, '나.md'), path.join(kit, '가.md'))
  fs.renameSync(path.join(kit, '다.md'), path.join(kit, '나.md'))
  a = await press(p1)
  assert.equal(a.why, 'changed', 'the same names and sizes, other files')
  // a permission or an attribute changed, the bytes the same (a Finder tag, a cloud app's own marks): the same file — it goes
  p1 = await proposeAgain()
  fs.chmodSync(path.join(kit, 'README.md'), 0o600)
  if (process.platform === 'darwin') require('node:child_process').execFileSync('xattr', ['-w', 'com.example.tag', '빨강', path.join(kit, 'README.md')])
  a = await press(p1)
  assert.equal(a.ok, true, 'not another file')
  // the folder replaced by a link to another one (its real path is no longer the one looked at)
  p1 = await proposeAgain()
  const n = binds.length
  fs.renameSync(kit, `${kit}-옛것`)
  fs.symlinkSync(`${kit}-옛것`, kit, WIN ? 'junction' : 'dir')
  a = await press(p1)
  assert.equal(a.why, 'changed')
  assert.equal(binds.length, n, 'not even looked at for an upload')
  if (WIN) fs.rmdirSync(kit); else fs.unlinkSync(kit)
  fs.renameSync(`${kit}-옛것`, kit)
  // unchanged: it goes
  p1 = await proposeAgain()
  a = await press(p1)
  assert.equal(a.ok, true)
  folders.stop()
})

test('DT-07 CLI 의 명령: Claude Code 는 --mcp-config(내 MCP 옆에) · 도구 허용, Codex 는 -c mcp_servers.… — 도구가 없으면 아무것도', () => {
  const program = { command: '/Applications/Process GPT Lite.app/Contents/MacOS/Process GPT Lite', args: ['/x/app.asar/src/mcp/server.js', '--config', '/d/lite-tools.json'], env: { ELECTRON_RUN_AS_NODE: '1' } }
  const stateDir = path.join(DATA, 'sessions', 'args')
  const S = new CliSession({ agent: 'claude-code', cwd: WORK, stateDir, tools: { program }, pty: {}, env: {} })
  fs.mkdirSync(stateDir, { recursive: true })
  S.env = ENV
  const a = S.claudeArgs()
  const i = a.args.indexOf('--mcp-config')
  assert.ok(i > 0)
  assert.ok(!a.args.includes('--strict-mcp-config'), 'the person\'s own MCP servers stay')
  const conf = JSON.parse(fs.readFileSync(a.args[i + 1], 'utf8'))
  assert.deepEqual(conf.mcpServers[MT.SERVER_NAME], { type: 'stdio', ...program })
  const settings = JSON.parse(fs.readFileSync(S.settingsFile, 'utf8'))
  assert.deepEqual(settings.permissions.allow, MT.NAMES.map((n) => `mcp__process_gpt_lite__${n}`))
  assert.ok(settings.hooks.Stop)
  const none = new CliSession({ agent: 'claude-code', cwd: WORK, stateDir: path.join(DATA, 'sessions', 'args2'), pty: {}, env: {} })
  fs.mkdirSync(none.stateDir, { recursive: true })
  none.env = ENV
  const b = none.claudeArgs()
  assert.ok(!b.args.includes('--mcp-config'))
  assert.equal(JSON.parse(fs.readFileSync(none.settingsFile, 'utf8')).permissions, undefined)
  const cx = codexMcp({ program })
  assert.deepEqual(cx.filter((x, k) => k % 2 === 0), ['-c', '-c', '-c', '-c'])
  assert.equal(cx[1], `mcp_servers.process_gpt_lite.command=${JSON.stringify(program.command)}`)
  assert.equal(cx[3], `mcp_servers.process_gpt_lite.args=${JSON.stringify(program.args)}`)
  assert.equal(cx[5], 'mcp_servers.process_gpt_lite.env={ELECTRON_RUN_AS_NODE="1"}')
  assert.deepEqual(codexMcp(null), [])
})

test('DT-08 앱이 알린다(liteTools · liteFolders) · 포장한 앱은 자기 바이너리를 node 로 MCP 서버를 띄운다(RunAsNode 는 그대로)', async () => {
  const { createLocalRunner } = require('../src/runner')
  const hellos = []
  class WS { constructor() { this.readyState = 1; setTimeout(() => this.onopen?.(), 0) } send(t) { hellos.push(JSON.parse(t)) } close() {} }
  const r = createLocalRunner({ server: 'http://srv.test', token: 'pld1_x', dataDir: path.join(ROOT, 'runner-a'), prefs: () => ({ enabled: true }), WS, searchPath: '/nowhere', folders: memStore(), userId: 'u' })
  await r.start()
  await new Promise((res) => setTimeout(res, 20))
  const caps = hellos.find((h) => h.type === 'hello').caps
  assert.equal(caps.liteTools, true)
  assert.equal(caps.liteFolders, true)
  r.stop()
  const hellos2 = []
  class WS2 extends WS { send(t) { hellos2.push(JSON.parse(t)) } }
  const r2 = createLocalRunner({ server: 'http://srv.test', token: 'pld1_x', dataDir: path.join(ROOT, 'runner-b'), prefs: () => ({ enabled: true }), WS: WS2, searchPath: '/nowhere', tools: false })
  await r2.start()
  await new Promise((res) => setTimeout(res, 20))
  assert.equal(hellos2.find((h) => h.type === 'hello').caps.liteTools, false)
  r2.stop()
  // plain Node here; the app's own binary with ELECTRON_RUN_AS_NODE in the app (its fuse left as Electron ships it)
  const p = TL.mcpProgram('/d/c.json')
  assert.equal(p.command, process.execPath)
  assert.match(p.args[0], /src[\\/]mcp[\\/]server\.js$/)
  const { FUSES } = require('../scripts/adhoc-sign')
  assert.notEqual(FUSES.runAsNode, false, 'the RunAsNode fuse must stay on: the CLI starts the tools with the app\'s own binary')
  desk?.stop()
})

test('DT-09 채팅 실행의 Claude Code 에는 ENABLE_TOOL_SEARCH=false(도구는 세션과 함께) — 그 사람의 환경 · runner 설정이 이기고, 단계 · Codex 에는 없음', async () => {
  const { Runner } = require('../src/runner/runner')
  const C = require('../src/runner/clis')
  // what the run hands its session (openSession is stopped right there) → its env
  const envOf = async (r, kind, agent = 'claude-code') => {
    let got = null
    r.openSession = (o) => { got = o; throw new Error('stop here') }
    const job = { id: crypto.randomUUID(), kind, agent, lang: 'ko', prompt: 'x', message: 'x', label: agent }
    const out = await r.runInteractive({ job, dir: WORK, early: [], live: [] })
    assert.equal(out.ok, false)
    return got.env
  }
  const was = process.env.ENABLE_TOOL_SEARCH
  delete process.env.ENABLE_TOOL_SEARCH
  try {
    const r = new Runner({ dataDir: path.join(ROOT, 'runner-ts'), server: 'http://srv.test', toolSearch: null })
    assert.deepEqual(await envOf(r, 'chat'), { ENABLE_TOOL_SEARCH: 'false' })
    assert.deepEqual(await envOf(r, 'step'), {}, 'a process step: as it was')
    assert.deepEqual(await envOf(r, 'chat', 'codex'), {}, 'Codex has no such search')
    // the runner's setting
    assert.deepEqual(await envOf(new Runner({ dataDir: path.join(ROOT, 'runner-ts'), server: 'http://srv.test', toolSearch: 'auto' }), 'chat'), { ENABLE_TOOL_SEARCH: 'auto' })
    // the CLI environment the runner was given (tests: their own) · the person's own environment — passed on as it is
    assert.deepEqual(await envOf(new Runner({ dataDir: path.join(ROOT, 'runner-ts'), server: 'http://srv.test', toolSearch: null, sessionEnv: { ENABLE_TOOL_SEARCH: 'true' } }), 'chat'), {})
    process.env.ENABLE_TOOL_SEARCH = 'true'
    assert.deepEqual(await envOf(r, 'chat'), {})
    assert.equal(C.cliEnv({}).ENABLE_TOOL_SEARCH, 'true', 'the person\'s own value reaches the CLI')
    assert.equal(C.cliEnv({ ENABLE_TOOL_SEARCH: 'false' }).ENABLE_TOOL_SEARCH, 'false', 'the run\'s value is the CLI\'s')
  } finally { if (was === undefined) delete process.env.ENABLE_TOOL_SEARCH; else process.env.ENABLE_TOOL_SEARCH = was }
})
