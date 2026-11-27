'use strict'
// The Process GPT tools of a chat run (design docs/local-agents/design.md §13, desktop 0.2.8): what the stdio MCP server the CLI starts
// (mcp/server.js) hands to the app. The person asks their own CLI in the chat — 「내 PC 의 ○○ 스킬을 등록해 줘」, 「이 폴더 올려 줘」 — and
// the CLI, reading the tools' descriptions (mcp/tools.js), calls one. Nothing here reads the person's words.
//   lite_list_pc_skills   the skills on this computer: Claude Code's (~/.claude/skills or $CLAUDE_CONFIG_DIR/skills), Codex's
//                         ($CODEX_HOME/skills, ~/.agents/skills), the run's work folder's .claude/skills — or under a folder the person named
//   lite_list_my_skills   the person's skills on the server (theirs and the company's) — read-only, with the run's tool token
//   lite_propose_skill    one skill folder, read here by the app (the model never carries a file): the champion folders' scan (sync.js —
//                         the same groups, key shapes, links and git control files left out), a SKILL.md at its top, a skill's size; then
//                         the files go to the server as a PROPOSAL, which shows the card 「스킬을 등록할까요?」 in the chat. Registered only
//                         when the person presses 「등록」 there.
//   lite_list_my_folders  the shared folders the person is a member of — read-only
//   lite_propose_folder   one folder of this computer: the champion folders' own pick and first look (sync.js FolderSync.pick — the same
//                         checks, the same preview); the preview goes to the server, which shows 「폴더를 올릴까요?」. When the person presses
//                         「올리기」 there, the server makes the Lite folder and asks this app over its link (tools:upload) to bind and upload
//                         it — FolderSync.bind, the existing upload, with the card as the person's yes. The server names only a pick this app
//                         made for a proposal of one of its runs: it never names a path, and a pick of the page's own dialog is never bound
//                         this way.
// Which folders: one the person or the list named, as an absolute path, ~/…, or relative to the CLI's work folder (never escaping it). Never
// a link (the named folder itself — the folder it points to may be named instead), the disk's or a volume's top, the home folder or above
// it, the system's folders (~/Library, /System, /usr, C:\Windows, AppData …), anything in the CLIs' own homes (~/.claude, ~/.codex,
// ~/.agents — only their skills folders may be named), any hidden folder right under the home folder (~/.ssh, ~/.kube, ~/.docker, ~/.config,
// keyrings, browser profiles …) and what is in it, a folder of the champion folders' secret or personal groups anywhere on its path (.ssh,
// .aws, .gnupg, .claude/projects, .codex/sessions, .vscode …), or this app's data.
// A folder proposed from a chat goes up only as it was shown: the card's 「올리기」 makes the upload look at it again (checked again, its real
// path unchanged), and when what would go up is not what the proposal's first look found (each path with its size), nothing goes up —
// the card says the folder changed.
// The channel: one local socket of this app — a unix socket in a temporary folder only this user can open (0700), a named pipe on
// Windows (which any local program may open: there the boundary is the key). Each chat run has its own key, 32 random bytes, in the MCP
// server's config file (0600, in the run's own state folder) — a call without it gets nothing — and the run's token for the server stays in
// this process.
const crypto = require('node:crypto')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const SY = require('./sync')
const RS = require('./runSettings')
const MT = require('../mcp/tools')

const WIN = process.platform === 'win32'
const CASELESS = process.platform === 'darwin' || WIN
// a skill's size (a folder's limits are the champion folders' own — secret-shapes.json)
const SKILL_MAX_FILES = 300
const SKILL_MAX_BYTES = 8 * 1024 * 1024
const LIST_MAX = 200
const HTTP_MS = 120_000
const nfc = (s) => String(s).normalize('NFC')
const T = (lang, ko, en) => (lang === 'en' ? en : ko)
const sizeText = (b) => (b >= 100 * 1024 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round((b || 0) / 1024))} KB`)
const isInside = (child, parent) => { const r = path.relative(parent, child); return r === '' || (!!r && !r.startsWith('..') && !path.isAbsolute(r)) }
const same = (a, b) => (CASELESS ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b))
const realOr = (p) => { try { return fs.realpathSync(p) } catch { return path.resolve(p) } }

// ---------- which folder ----------
// the text a tool was given → an absolute path, or {error}: '~' and '~/…' are the home folder; a relative path is the work folder's and may
// not leave it
function resolvePath(input, { cwd, home = os.homedir() } = {}) {
  const s = String(input ?? '').trim()
  if (!s || s.length > 4096 || s.includes('\0')) return { error: 'bad_path' }
  let abs
  if (s === '~' || s.startsWith('~/') || (WIN && s.startsWith('~\\'))) abs = path.resolve(home, s.slice(2))
  else if (s.startsWith('~')) return { error: 'bad_path' }
  else if (path.isAbsolute(s)) abs = path.resolve(s)
  else {
    if (!cwd) return { error: 'bad_path' }
    abs = path.resolve(cwd, s)
    if (!isInside(abs, path.resolve(cwd))) return { error: 'escapes' }
  }
  return { abs: nfc(abs) }
}

// the system's own folders: never one of them, never inside one (exact: only that folder itself — a person's folder may be below it)
function systemFolders(home = os.homedir(), env = process.env) {
  if (WIN) {
    const e = (k) => env[k] || ''
    return { inside: [e('SystemRoot') || 'C:\\Windows', e('ProgramFiles'), e('ProgramFiles(x86)'), e('ProgramData'), e('APPDATA'), e('LOCALAPPDATA'), path.join(home, 'AppData')].filter(Boolean),
      exact: [path.join(path.parse(home).root, 'Users')] }
  }
  return { inside: ['/System', '/Library', '/usr', '/bin', '/sbin', '/etc', '/private/etc', '/dev', '/proc', '/sys', '/boot', '/root', '/Applications', path.join(home, 'Library')],
    exact: ['/Users', '/home', '/Volumes', '/private', '/var', '/private/var', '/tmp', '/private/tmp', '/opt', '/mnt', '/media'] }
}

// why this folder is not one to send, or null → {error} | {real}
async function checkFolder(abs, { home = os.homedir(), env = process.env, dataDir = null, rules = SY.compileRules() } = {}) {
  let st
  try { st = await fsp.lstat(abs) } catch { return { error: 'not_found' } }
  // (the named folder itself is never a link: the folder it leads to is named instead — nothing is followed)
  if (st.isSymbolicLink()) return { error: 'link' }
  if (!st.isDirectory()) return { error: 'not_folder' }
  const real = nfc(await fsp.realpath(abs))
  if (path.parse(real).root === real || (CASELESS && path.parse(real).root.toLowerCase() === real.toLowerCase())) return { error: 'system_folder' }
  const h = realOr(home)
  if (same(real, h) || isInside(h, real)) return { error: 'home_folder' }
  const sys = systemFolders(home, env)
  for (const d of sys.inside) { const r = realOr(d); if (same(real, r) || isInside(real, r)) return { error: 'system_folder' } }
  for (const d of sys.exact) if (same(real, realOr(d))) return { error: 'system_folder' }
  // the CLIs' own homes (their sign-ins, settings, histories, sessions): nothing in them but their skills folders
  const homes = cliHomes(home, env).map(realOr)
  const inSkills = homes.some((d) => isInside(real, path.join(d, 'skills')))
  if (!inSkills && homes.some((d) => same(real, d) || isInside(real, d))) return { error: 'cli_home' }
  // a folder of the champion folders' secret or personal groups anywhere on the way (.ssh, .aws, .gnupg · .claude/projects, .codex/sessions,
  // .vscode …) — by the names on its whole path
  const rel = path.relative(path.parse(real).root, real).split(path.sep).join('/')
  const g = SY.groupOf(rules, rel, true)
  if (g === 'secret') return { error: 'secret_folder' }
  if (g === 'personal') return { error: 'personal_folder' }
  // a hidden folder right under the home folder, and what is in it: a program's own place (~/.kube, ~/.docker, ~/.config, keyrings, browser
  // profiles …) — the CLIs' skills folders aside
  const under = path.relative(h, real)
  if (!inSkills && under && !under.startsWith('..') && !path.isAbsolute(under) && under.split(path.sep)[0].startsWith('.')) return { error: 'hidden_folder' }
  if (dataDir) {
    const data = realOr(dataDir)
    if (isInside(data, real) || isInside(real, path.dirname(data))) return { error: 'app_folder' }
  }
  try { await fsp.access(real, fs.constants.R_OK) } catch { return { error: 'not_readable' } }
  return { real }
}

// the CLIs' own homes on this computer (the run's environment names theirs when they moved them)
const cliHomes = (home = os.homedir(), env = process.env) => [env.CLAUDE_CONFIG_DIR, path.join(home, '.claude'), env.CODEX_HOME, path.join(home, '.codex'), path.join(home, '.agents')].filter(Boolean)

// what the person sees of where a folder is: the home folder as ~ (never sent to the server — only the CLI hears it)
const shown = (p, home = os.homedir()) => (isInside(p, home) ? `~${path.sep}${path.relative(home, p)}`.replace(/[\\/]$/, '') : p)

// ---------- skills on this computer ----------
// where a CLI keeps the skills it finds by itself (env: the run's — its config folders)
function skillRoots({ cwd = null, home = os.homedir(), env = process.env } = {}) {
  const claude = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude')
  const codex = env.CODEX_HOME || path.join(home, '.codex')
  return [
    { where: 'claude', dir: path.join(claude, 'skills') },
    { where: 'codex', dir: path.join(codex, 'skills') },
    { where: 'agents', dir: path.join(home, '.agents', 'skills') },
    ...(cwd ? [{ where: 'work', dir: path.join(cwd, '.claude', 'skills') }] : []),
  ]
}
// a SKILL.md's head → {name, description}
async function headOf(file) {
  let fh
  try {
    fh = await fsp.open(file, 'r')
    const b = Buffer.alloc(16384)
    const { bytesRead } = await fh.read(b, 0, b.length, 0)
    const text = b.subarray(0, bytesRead).toString('utf8')
    const fm = SY.frontMatter(text)
    return { name: String(fm.name || '').slice(0, 80), description: String(fm.description || '').replace(/\s+/g, ' ').slice(0, 300), runs: RS.frontRuns(text, { truncated: bytesRead >= b.length }) }
  } catch { return null } finally { await fh?.close().catch(() => {}) }
}
// the skills in one folder: the folder itself when it holds a SKILL.md, else each folder one level down that does. A link is listed as one
// (its own target named — never read through)
async function skillsIn(dir, where, home) {
  const out = []
  let st
  try { st = await fsp.lstat(dir) } catch { return out }
  if (st.isSymbolicLink() || !st.isDirectory()) return out
  if (fs.existsSync(path.join(dir, 'SKILL.md'))) {
    const h = await headOf(path.join(dir, 'SKILL.md'))
    if (h) out.push({ name: h.name || path.basename(dir), description: h.description, path: shown(dir, home), where, runs: h.runs.length > 0 })
    return out
  }
  let ents = []
  try { ents = await fsp.readdir(dir, { withFileTypes: true }) } catch { return out }
  for (const e of ents.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (out.length >= LIST_MAX) break
    if (e.name.startsWith('.')) continue
    const p = path.join(dir, e.name)
    if (e.isSymbolicLink()) {
      let to = null
      try { to = path.resolve(dir, await fsp.readlink(p)) } catch { /* unreadable */ }
      out.push({ name: e.name, description: '', path: shown(p, home), where, link: true, ...(to ? { pointsTo: shown(to, home) } : {}) })
      continue
    }
    if (!e.isDirectory() || !fs.existsSync(path.join(p, 'SKILL.md'))) continue
    const h = await headOf(path.join(p, 'SKILL.md'))
    if (h) out.push({ name: h.name || e.name, description: h.description, path: shown(p, home), where, runs: h.runs.length > 0 })
  }
  return out
}

// ---------- a skill read here ----------
// the champion folders' scan of the skill folder (sync.js — the same rules), then its files → {skill} | {error, detail}
// git's own control files of a skill folder (its .gitignore · .gitattributes — the scan already leaves .gitmodules · .lfsconfig out): a
// skill's folder on the server is the server's own repository, so they stay here (counted as left out)
const CONTROL = new Set(['.gitignore', '.gitattributes', '.gitmodules', '.lfsconfig'])
const isControl = (rel) => CONTROL.has(String(rel).split('/').pop().trim().toLowerCase())
async function packSkill(dir, { gitDir, rules = SY.compileRules(), places } = {}) {
  const s = await SY.scan(dir, { gitDir, rules, ...(places ? { places } : {}) })
  const control = s.files.filter(isControl)
  if (control.length) {
    s.files = s.files.filter((r) => !isControl(r))
    const g = s.preview.excluded.find((x) => x.group === 'structure') || (s.preview.excluded.push({ group: 'structure', count: 0, samples: [] }), s.preview.excluded.at(-1))
    g.count += control.length
    g.samples = [...g.samples, ...control].slice(0, 5)
  }
  if (!s.files.includes('SKILL.md')) return { error: 'no_skill_md' }
  if (s.files.length > SKILL_MAX_FILES) return { error: 'too_many', detail: { files: s.files.length, max: SKILL_MAX_FILES } }
  const files = []
  let bytes = 0
  for (const rel of s.files) {
    const abs = path.join(dir, ...rel.split('/'))
    // (each file once more as it is now: a plain file inside the folder, never a link)
    const st = await fsp.lstat(abs).catch(() => null)
    if (!st || !st.isFile() || st.isSymbolicLink()) continue
    if (!isInside(realOr(abs), dir)) continue
    bytes += st.size
    if (bytes > SKILL_MAX_BYTES) return { error: 'too_big', detail: { bytes, max: SKILL_MAX_BYTES } }
    const buf = await fsp.readFile(abs)
    files.push({ path: rel, size: buf.length, data: buf.toString('base64') })
  }
  const md = files.find((f) => f.path === 'SKILL.md')
  const text = Buffer.from(md.data, 'base64').toString('utf8')
  const fm = SY.frontMatter(text)
  // what would run on the computer of whoever uses it: the front matter's run keys (hooks, allowed-tools …) and settings files in it
  const runs = RS.frontRuns(text)
  const runFiles = files.map((f) => f.path).filter((p) => RS.FILES.some((x) => p.toLowerCase() === x || p.toLowerCase().endsWith(`/${x}`)))
  return {
    skill: {
      name: String(fm.name || '').trim(), description: String(fm.description || '').replace(/\s+/g, ' ').trim().slice(0, 1000),
      files, bytes: files.reduce((n, f) => n + f.size, 0), runs, runFiles,
      excluded: s.preview.excluded, flagged: s.report.flagged || 0, warnings: s.preview.warnings.filter((w) => w !== 'empty'),
    },
  }
}

// ---------- what the CLI is told ----------
const WHY = {
  bad_path: ['경로를 알아볼 수 없어요', 'that path could not be read'],
  escapes: ['작업 폴더 밖을 가리키는 상대 경로예요. 절대 경로나 ~/로 시작하는 경로를 알려 주세요', 'the relative path leaves the working folder — name it with an absolute path or ~/'],
  not_found: ['그런 폴더가 없어요', 'there is no such folder'],
  not_folder: ['폴더가 아니에요', 'that is not a folder'],
  link: ['링크(바로 가기)는 따라가지 않아요. 링크가 가리키는 실제 폴더를 알려 주세요', 'links are not followed — name the folder the link points to'],
  system_folder: ['디스크 최상위 폴더나 시스템 폴더는 보낼 수 없어요', 'the top of a disk or a system folder cannot be sent'],
  home_folder: ['홈 폴더 전체는 보낼 수 없어요. 그 안의 폴더를 골라 주세요', 'the whole home folder cannot be sent — pick a folder inside it'],
  cli_home: ['CLI 설정 폴더와 그 안의 폴더는 보낼 수 없어요(스킬 폴더만 보낼 수 있어요). 로그인 정보와 사용 기록이 들어 있어요', 'a CLI\'s own settings folder and what is in it cannot be sent (only its skills folder) — it holds sign-ins and histories'],
  personal_folder: ['CLI 대화 기록이나 편집기 설정처럼 이 PC에만 보관하는 폴더는 보낼 수 없어요', 'a folder kept on this PC only (a CLI\'s histories, an editor\'s settings) cannot be sent'],
  hidden_folder: ['홈 폴더 바로 아래에 있는 숨김 폴더(~/.kube · ~/.docker · ~/.config처럼 프로그램이 쓰는 곳)는 보낼 수 없어요', 'a hidden folder right under the home folder (a program\'s own place, like ~/.kube, ~/.docker, ~/.config) cannot be sent'],
  secret_folder: ['인증 정보를 보관하는 폴더(.ssh · .aws · .gnupg)는 보낼 수 없어요', 'a folder for secret keys (.ssh, .aws, .gnupg) cannot be sent'],
  app_folder: ['이 앱의 데이터 폴더는 보낼 수 없어요', 'this app\'s own data cannot be sent'],
  not_readable: ['그 폴더를 읽을 수 없어요', 'that folder cannot be read'],
  no_skill_md: ['그 폴더의 최상위에 SKILL.md가 없어 스킬로 인식할 수 없어요', 'there is no SKILL.md at the top of that folder, so it is not a skill'],
  too_many: ['스킬은 파일 300개까지 올릴 수 있어요. 파일이 너무 많으니 폴더로 올리기(lite_propose_folder)를 권해 주세요', 'too many files for a skill (300 at most) — suggest uploading it as a folder (lite_propose_folder)'],
  too_big: ['스킬은 8 MB까지 올릴 수 있어요. 용량이 너무 크니 폴더로 올리기(lite_propose_folder)를 권해 주세요', 'too big for a skill (8 MB at most) — suggest uploading it as a folder (lite_propose_folder)'],
  empty: ['올릴 파일이 없어요', 'there is nothing to upload in it'],
  folders_off: ['이 PC 앱이 서버와 연동되지 않아 지금은 폴더를 올릴 수 없어요', 'this desktop app cannot upload folders now (not paired with the server)'],
  other_user: ['이 PC 앱에 다른 사람이 로그인해 있어요', 'someone else is signed in to this desktop app'],
  stopped: ['이 PC 앱이 멈췄어요', 'this desktop app stopped'],
  no_token: ['이번 실행에서는 Process GPT 도구를 쓸 수 없어요. 채팅에서 요청을 다시 보내 주세요', 'the Process GPT tools are not available in this run — send the message again from the chat'],
  offline: ['서버에 연결하지 못했어요', 'the server could not be reached'],
}
const why = (lang, code, extra = '') => `${T(lang, ...(WHY[code] || [code, code]))}${extra}`
const fail = (text) => ({ text, isError: true })

// ---------- the tools ----------
class ToolDesk extends EventEmitter {
  // dataDir: the app's data folder (the scan's own repository, never inside a folder that goes up) · server: the Lite base address ·
  // folders: the champion folders' engine (sync.js FolderSync) of this person on this server, or null · send(msg): the link ·
  // fetchImpl: the server's API (tests) · home: whose home folder (tests)
  constructor({ dataDir, server, folders = null, send = () => false, fetchImpl = (...a) => globalThis.fetch(...a), log = () => {}, home = os.homedir(), rules = SY.compileRules() } = {}) {
    super()
    this.dataDir = path.resolve(dataDir)
    this.server = String(server || '').replace(/\/+$/, '')
    this.folders = folders
    this.sendFn = send
    this.fetch = fetchImpl
    this.logFn = log
    this.home = home
    this.rules = rules
    this.runs = new Map()      // key → {jobId, cwd, lang, env, token, at}
    this.proposed = new Map()  // pickId → {proposalId, key, at} (a folder proposed from a run — the only picks tools:upload may bind)
    this.listener = null
    this.addr = null
    this.secrets = new Set()
  }
  log(...a) { let s = a.join(' '); for (const t of this.secrets) if (t) s = s.split(t).join('***'); this.logFn(s) }
  gitDir() { return path.join(this.dataDir, 'tools', 'scan.git') }

  // ---------- the local channel ----------
  async listen() {
    if (this.addr) return this.addr
    if (this.listening) return this.listening
    this.listening = (async () => {
      let addr
      if (WIN) addr = `\\\\.\\pipe\\pgl-tools-${crypto.randomBytes(12).toString('hex')}`
      else {
        // (a socket's path has room for about 100 characters: the system's temporary folder, else /tmp)
        let base = os.tmpdir()
        if (path.join(base, 'pgl-t-XXXXXX', 's').length > 100) base = '/tmp'
        this.sockDir = fs.mkdtempSync(path.join(base, 'pgl-t-'))
        fs.chmodSync(this.sockDir, 0o700)
        addr = path.join(this.sockDir, 's')
      }
      const srv = net.createServer((sock) => this.serve(sock))
      await new Promise((res, rej) => { srv.once('error', rej); srv.listen(addr, () => { srv.off('error', rej); res() }) })
      srv.on('error', (e) => this.log(`[tools] ${e.message}`))
      this.listener = srv
      this.addr = addr
      return addr
    })().finally(() => { this.listening = null })
    return this.listening
  }
  serve(sock) {
    let buf = ''
    sock.setEncoding('utf8')
    sock.on('error', () => {})
    sock.on('data', async (d) => {
      buf += d
      if (buf.length > 1024 * 1024) return sock.destroy()
      const n = buf.indexOf('\n')
      if (n < 0) return
      const line = buf.slice(0, n)
      buf = ''
      let m = null
      try { m = JSON.parse(line) } catch { /* broken */ }
      const r = m && typeof m === 'object' ? await this.call(String(m.key || ''), String(m.tool || ''), m.args || {}).catch((e) => fail(String(e?.message || e))) : fail('unreadable')
      try { sock.end(`${JSON.stringify({ id: m?.id ?? null, text: r.text, isError: !!r.isError })}\n`) } catch { /* gone */ }
    })
  }

  // A chat run opens the tools for its CLI → {file, program} — the MCP server's config (its key; written 0600 in the run's state folder) and
  // how the CLI starts it. ctx: {jobId, cwd, lang, env (the CLI's), token (the server's tool token of this run)}
  async open({ stateDir, jobId, cwd, lang = 'ko', env = process.env, token = null } = {}) {
    const ipc = await this.listen()
    const key = crypto.randomBytes(32).toString('hex')
    this.runs.set(key, { jobId: String(jobId || ''), cwd: cwd ? path.resolve(cwd) : null, lang: lang === 'en' ? 'en' : 'ko', env, token: token || null, at: Date.now() })
    if (token) this.secrets.add(token)
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    const file = path.join(stateDir, 'lite-tools.json')
    fs.writeFileSync(file, JSON.stringify({ ipc, key, lang }), { mode: 0o600 })
    return { key, file, program: mcpProgram(file) }
  }
  close(key) {
    const r = this.runs.get(key)
    this.runs.delete(key)
    if (r?.token) this.secrets.delete(r.token)
  }
  stop() {
    this.runs.clear()
    this.proposed.clear()
    try { this.listener?.close() } catch { /* gone */ }
    this.listener = null
    this.addr = null
    if (this.sockDir) { try { fs.rmSync(this.sockDir, { recursive: true, force: true }) } catch { /* gone */ } this.sockDir = null }
  }

  // ---------- one call ----------
  async call(key, tool, args = {}) {
    const run = this.runs.get(key)
    if (!run) return fail('This run\'s Process GPT tools are closed (the run ended). / 이 실행의 Process GPT 도구가 닫혔어요.')
    if (!MT.NAMES.includes(tool)) return fail(`Unknown tool: ${tool}`)
    const a = args && typeof args === 'object' ? args : {}
    this.log(`[tools] ${tool} (${run.jobId.slice(0, 8)})`)
    if (tool === 'lite_list_pc_skills') return this.listPcSkills(run, a)
    if (tool === 'lite_propose_skill') return this.proposeSkill(run, a)
    if (tool === 'lite_propose_folder') return this.proposeFolder(run, a)
    if (tool === 'lite_list_my_skills') return this.listServer(run, 'skills')
    if (tool === 'lite_list_my_folders') return this.listServer(run, 'folders')
    return fail(`Unknown tool: ${tool}`)
  }
  async folderOf(run, input, { skill = false } = {}) {
    const r = resolvePath(input, { cwd: run.cwd, home: this.home })
    if (r.error) return r
    let abs = r.abs
    // (a skill's SKILL.md named: its folder)
    if (skill && path.basename(abs) === 'SKILL.md') {
      const st = await fsp.lstat(abs).catch(() => null)
      if (st?.isFile()) abs = path.dirname(abs)
    }
    return checkFolder(abs, { home: this.home, env: run.env, dataDir: this.dataDir, rules: this.rules })
  }

  async listPcSkills(run, { under } = {}) {
    let list = []
    if (under) {
      const f = await this.folderOf(run, under)
      if (f.error) return fail(why(run.lang, f.error))
      list = await skillsIn(f.real, 'named', this.home)
    } else {
      for (const r of skillRoots({ cwd: run.cwd, home: this.home, env: run.env })) list.push(...await skillsIn(r.dir, r.where, this.home))
    }
    const where = { claude: 'Claude Code (personal)', codex: 'Codex', agents: 'agents', work: 'this work folder', named: 'the folder named' }
    return { text: JSON.stringify({ skills: list.slice(0, LIST_MAX).map((s) => ({ ...s, where: where[s.where] || s.where })),
      note: list.some((s) => s.link) ? 'Entries with link: true are links; to propose one, pass the folder in pointsTo.' : undefined }) }
  }

  async api(run, p, { method = 'GET', body = null } = {}) {
    if (!run.token) return { error: 'no_token' }
    let r
    try {
      r = await this.fetch(`${this.server}/api/local-agents/tools${p}`, { method, signal: AbortSignal.timeout(HTTP_MS),
        headers: { Authorization: `Bearer ${run.token}`, 'X-PGL-Lang': run.lang, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
    } catch (e) { this.log(`[tools] ${method} ${p}: ${e.message}`); return { error: 'offline' } }
    let j = null
    try { j = await r.json() } catch { /* not JSON */ }
    if (!r.ok) return { error: 'server', status: r.status, message: String(j?.error || `HTTP ${r.status}`), code: j?.code || null }
    return { ok: true, data: j }
  }
  async listServer(run, what) {
    const r = await this.api(run, `/${what}`)
    if (r.error) return fail(r.error === 'server' ? r.message : why(run.lang, r.error))
    return { text: JSON.stringify(r.data) }
  }

  async proposeSkill(run, { path: p, name, scope } = {}) {
    const f = await this.folderOf(run, p, { skill: true })
    if (f.error) return fail(why(run.lang, f.error))
    if (!run.token) return fail(why(run.lang, 'no_token'))
    fs.mkdirSync(path.dirname(this.gitDir()), { recursive: true })
    const k = await packSkill(f.real, { gitDir: this.gitDir(), rules: this.rules })
    if (k.error) return fail(why(run.lang, k.error))
    const s = k.skill
    const where = skillRoots({ cwd: run.cwd, home: this.home, env: run.env }).find((r) => isInside(f.real, realOr(r.dir)))?.where || 'other'
    const body = { name: String(name || s.name || path.basename(f.real)).trim().slice(0, 80), description: s.description, scope: scope === 'company' ? 'company' : 'mine',
      source: { where, label: path.basename(f.real) }, files: s.files,
      summary: { files: s.files.length, bytes: s.bytes, excluded: s.excluded, flagged: s.flagged, runs: s.runs, runFiles: s.runFiles, warnings: s.warnings } }
    const r = await this.api(run, '/skills/propose', { method: 'POST', body })
    if (r.error) return fail(r.error === 'server' ? r.message : why(run.lang, r.error))
    const left = (s.excluded || []).reduce((n, g) => n + g.count, 0) + (s.flagged || 0)
    return { text: T(run.lang,
      `제안했어요. 채팅에 「스킬을 등록할까요?」 카드가 떴어요. 스킬 「${r.data.name}」, 파일 ${s.files.length}개(${sizeText(s.bytes)})${left ? `, 제외한 항목 ${left}개` : ''}예요.${s.runs.length || s.runFiles.length ? ' 실행 설정이 있어요.' : ''} ` +
      `아직 등록되지 않았어요. 사람이 ${r.data.expiresInMinutes || 60}분 안에 카드에서 「등록」을 눌러야 등록돼요. 사람에게 카드를 확인해 달라고 말하고 여기서 멈추세요. 도구를 다시 부르지 마세요.`,
      `Proposed. A card 「스킬을 등록할까요?」 (Register this skill?) is now in the chat — the skill "${r.data.name}", ${s.files.length} files (${sizeText(s.bytes)})${left ? `, ${left} left out` : ''}${s.runs.length || s.runFiles.length ? ', with run settings' : ''}. ` +
      `It is NOT registered yet: the person presses 「등록」 (Register) on the card (within ${r.data.expiresInMinutes || 60} minutes). Ask them to check the card and stop here — do not call this again.`) }
  }

  async proposeFolder(run, { path: p, name } = {}) {
    const fs_ = this.folders
    if (!fs_) return fail(why(run.lang, 'folders_off'))
    const f = await this.folderOf(run, p)
    if (f.error) return fail(why(run.lang, f.error))
    if (!run.token) return fail(why(run.lang, 'no_token'))
    // the champion folders' own pick and first look (the same checks and preview as 「내 PC 폴더 올리기」)
    const pick = await fs_.pick(f.real)
    if (pick.error) return fail(why(run.lang, pick.error))
    const pv = pick.preview || {}
    for (const w of ['empty', 'too_big', 'too_many']) if ((pv.warnings || []).includes(w)) return fail(why(run.lang, w === 'empty' ? 'empty' : w, w === 'empty' ? '' : T(run.lang, ' — 챔피언 폴더 한도(200 MB · 파일 2만 개)를 넘어요', ' — over the folder limits (200 MB, 20,000 files)')))
    const r = await this.api(run, '/folders/propose', { method: 'POST', body: { pickId: pick.pickId, label: pick.label, name: String(name || pick.label).trim().slice(0, 80), preview: pv } })
    if (r.error) return fail(r.error === 'server' ? r.message : why(run.lang, r.error))
    for (const [k, x] of this.proposed) if (Date.now() - x.at > 2 * 3600_000) this.proposed.delete(k)
    // (what the card shows: what this look would upload — the upload must find the same; and where, with the run's environment, to check
    // the folder again then — the run may be over by the time the card is pressed)
    this.proposed.set(pick.pickId, { proposalId: String(r.data.id), at: Date.now(), seen: fs_.picks.get(pick.pickId)?.seen || null, dir: f.real, env: run.env })
    const left = (pv.excluded || []).reduce((n, g) => n + g.count, 0)
    const kit = (pv.kit || []).length
    return { text: T(run.lang,
      `제안했어요. 채팅에 「폴더를 올릴까요?」 카드가 떴어요. 폴더 「${r.data.name}」, 파일 ${pv.files}개(${sizeText(pv.bytes)})${left ? `, 제외한 항목 ${left}개` : ''}${kit ? `, 에이전트 자산 ${kit}개` : ''}예요. ` +
      `아직 업로드되지 않았어요. 사람이 ${r.data.expiresInMinutes || 60}분 안에 카드에서 「올리기」를 눌러야 업로드돼요. 사람에게 카드를 확인해 달라고 말하고 여기서 멈추세요. 도구를 다시 부르지 마세요.`,
      `Proposed. A card 「폴더를 올릴까요?」 (Upload this folder?) is now in the chat — "${r.data.name}", ${pv.files} files (${sizeText(pv.bytes)})${left ? `, ${left} left out` : ''}${kit ? `, ${kit} agent assets` : ''}. ` +
      `Nothing is uploaded yet: the person presses 「올리기」 (Upload) on the card (within ${r.data.expiresInMinutes || 60} minutes). Ask them to check the card and stop here — do not call this again.`) }
  }

  // ---------- the server's word over the link ----------
  handles(msg) { return typeof msg?.type === 'string' && msg.type.startsWith('tools:') }
  async handle(msg) {
    if (msg.type !== 'tools:upload') return
    const proposalId = String(msg.proposalId || '')
    const pickId = String(msg.pickId || '')
    const answer = (o) => this.sendFn({ type: 'tools:uploaded', proposalId, ...o })
    const mine = this.proposed.get(pickId)
    // (only a pick this app made for that proposal — never the page's own dialog's, never a path)
    if (!mine || mine.proposalId !== proposalId) return answer({ ok: false, why: 'no_pick' })
    if (!this.folders) return answer({ ok: false, why: 'folders_off' })
    // the folder as the proposal found it: checked again (the same rules), its real path the one that was looked at — a folder renamed or
    // replaced by a link meanwhile is not followed
    const pick = this.folders.picks.get(pickId)
    if (!pick) return answer({ ok: false, why: 'no_pick' })
    const again = await checkFolder(pick.dir, { home: this.home, env: mine.env || process.env, dataDir: this.dataDir, rules: this.rules })
    let real = null
    try { real = nfc(fs.realpathSync(pick.dir)) } catch { /* gone */ }
    const gone = (why) => { this.proposed.delete(pickId); this.folders.picks.delete(pickId); this.log(`[tools] upload ${proposalId.slice(0, 8)}: ${why}`); return answer({ ok: false, why }) }
    if (again.error || real !== pick.dir || again.real !== pick.dir || (mine.dir && mine.dir !== pick.dir)) return gone('changed')
    this.emit('notice', { kind: 'pc-upload', folderName: String(msg.folderName || '').slice(0, 120) })
    // the champion folders' own first upload — the person's yes was the card's 「올리기」, for what the card showed: the upload's own look must
    // find the same files (each path with its size) as the proposal's, or nothing goes up
    let changed = false
    const yes = async (now) => {
      const seen = mine.seen
      if (!seen || now?.fingerprint !== seen.fingerprint || now?.files !== seen.files || now?.bytes !== seen.bytes) { changed = true; return false }
      return true
    }
    const r = await this.folders.bind({ pickId, folderId: String(msg.folderId || ''), folderName: String(msg.folderName || '').slice(0, 120) }, { confirm: yes })
      .catch((e) => ({ ok: false, why: 'failed', error: e.message }))
    if (!r.ok && changed) return gone('changed')
    if (r.ok) this.proposed.delete(pickId)
    this.log(`[tools] upload ${proposalId.slice(0, 8)}: ${r.ok ? 'ok' : r.why}`)
    answer({ ok: !!r.ok, why: r.ok ? null : String(r.why || 'failed'), ...(r.pushed ? { pushed: r.pushed } : {}), ...(Array.isArray(r.paths) ? { paths: r.paths.slice(0, 20) } : {}) })
  }
}

// How a CLI starts the MCP server: the desktop app's own binary as its node (ELECTRON_RUN_AS_NODE — no window, no app; the RunAsNode fuse
// stays as Electron ships it: scripts/adhoc-sign.js), or this Node in a plain runner (tests)
function mcpProgram(configFile) {
  const script = path.join(__dirname, '..', 'mcp', 'server.js')
  if (process.versions.electron) return { command: process.execPath, args: [script, '--config', configFile], env: { ELECTRON_RUN_AS_NODE: '1' } }
  return { command: process.execPath, args: [script, '--config', configFile], env: {} }
}

module.exports = { ToolDesk, resolvePath, checkFolder, skillRoots, skillsIn, packSkill, mcpProgram, systemFolders, SKILL_MAX_FILES, SKILL_MAX_BYTES, WHY }
