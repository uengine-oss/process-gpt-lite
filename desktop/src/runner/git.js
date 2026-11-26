'use strict'
// The instance's work folder on this computer (design docs/local-agents/design.md §4): a git clone of the folder the Lite server serves
// over HTTP (server/lib/folders/gitHttp.js), one per instance under the app's data folder. The folder token of a job goes to git as a
// request header through GIT_CONFIG_* in the environment — never into .git/config, never on a command line (the process list), never in
// a log (cli-agent core/worktree.py does the same) — and only for the folder's own address (http.<that address>.extraHeader), so a request
// to anywhere else a folder's files may name (an .lfsconfig's lfs.url, a submodule) never carries it.
// What a folder holds cannot make this computer run or follow anything: links are checked out as plain files holding the link's text
// (core.symlinks=false), and info/attributes turns off every filter (LFS's, or one the person's git config names), line-ending change and
// $Id$ expansion, whatever the folder's own .gitattributes says (NEUTRAL — the champion folders' shadow repository uses the same line).
//   sync    — fetch the instance line (the earlier steps' results), else main
//   branch  — the run's own branch pgpt-agent/<run> from it, the folder made clean first (the app's folder: no one edits it by hand)
//   commit  — everything the agent changed, as the step's person
//   push    — the run's branch back; the server takes it onto the line
//   follow  — after the server took it: the folder shows the line again (the next step on this computer starts from there)
const { execFile } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { which, augmentedPath } = require('./clis')

const TIMEOUT = 120_000
const NETWORK = 600_000

// The folder is the server's byte for byte: no line-ending conversion here, whatever the person's git says (Git for Windows installs
// core.autocrlf=true, which would turn every file CRLF on checkout and could show files the run never touched as changed); deep paths
// under %APPDATA% work on Windows (core.longpaths). extra: more [key, value] pairs for this call (the folder sync's shadow repository —
// sync.js — turns off hooks, signing and the person's own excludes this way)
// A token goes with the address it is for (url — the folder's git address): http.<url>.extraHeader, which git (and git-lfs) send only to
// that address and below it.
function authEnv(token, extra = [], url = '') {
  const pairs = [['credential.helper', ''], ['core.quotepath', 'false'], ['core.autocrlf', 'false'], ['core.longpaths', 'true'],
    ['protocol.allow', 'never'], ['protocol.https.allow', 'always'], ['protocol.http.allow', 'always'], ...extra]
  if (token) {
    if (!url) throw new GitError('a folder token goes only with the address it is for')
    pairs.push([`http.${checkUrl(url)}.extraHeader`, `Authorization: Bearer ${token}`])
  }
  const env = { GIT_CONFIG_COUNT: String(pairs.length) }
  pairs.forEach(([k, v], i) => { env[`GIT_CONFIG_KEY_${i}`] = k; env[`GIT_CONFIG_VALUE_${i}`] = v })
  return env
}

class GitError extends Error {}
// the line every clone's (and the shadow repository's) info/attributes holds: the folder's bytes as they are, nothing run on them
const NEUTRAL = '* -text -filter -ident -working-tree-encoding\n'

// which git: the one on PATH, else where it is usually installed (an app opened from Finder or the Start menu may not have it on PATH;
// Git for Windows: C:\Program Files\Git\cmd)
let gitBin = null
function gitPath() {
  if (gitBin) return gitBin
  gitBin = which('git', augmentedPath()) || 'git'
  return gitBin
}
const NO_GIT = process.platform === 'win32'
  ? 'git is not installed on this computer — install Git for Windows (https://git-scm.com/download/win) and run the step again'
  : 'git is not installed on this computer — install it (macOS: xcode-select --install) and run the step again'

// git in `dir`; a token (for `url` — the folder's address) never shows up in what is thrown
function git(dir, args, { token = '', url = '', timeout = TIMEOUT, check = true } = {}) {
  const env = {}
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_CONFIG_') && k !== 'GIT_DIR' && k !== 'GIT_WORK_TREE') env[k] = v
  Object.assign(env, { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '', LC_ALL: 'C' }, authEnv(token, [['core.symlinks', 'false']], url))
  return new Promise((resolve, reject) => {
    execFile(gitPath(), args, { cwd: dir, env, timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err && err.code === 'ENOENT' && !fs.existsSync(dir)) return check ? reject(new GitError(`git ${args.slice(0, 2).join(' ')} failed: no folder ${dir}`)) : resolve('')
      if (err && err.code === 'ENOENT') return check ? reject(new GitError(NO_GIT)) : resolve('')
      if (err && check) {
        let why = `${String(stderr || '').trim()} ${String(stdout || '').trim()}`.trim() || err.message
        if (token) why = why.split(token).join('***')
        return reject(new GitError(`git ${args.slice(0, 2).join(' ')} failed: ${why.slice(0, 500)}`))
      }
      resolve(String(stdout || ''))
    })
  })
}

// only http(s) addresses: a job never makes git open a file, ssh or ext:: transport
function checkUrl(url) {
  let u
  try { u = new URL(url) } catch { throw new GitError('the folder address is not a URL') }
  if (!['http:', 'https:'].includes(u.protocol)) throw new GitError(`git over ${u.protocol} is not used here`)
  if (u.username || u.password) throw new GitError('the folder address may not carry credentials')
  return u.href
}
// a ref name the server gave: plain branch names only
const REF = /^(?!.*\.\.)(?!.*\/\/)(?!.*\.lock$)[A-Za-z0-9._-][A-Za-z0-9._/-]{0,180}$/
const checkRef = (r) => { if (!REF.test(String(r || ''))) throw new GitError(`not a branch name: ${String(r).slice(0, 60)}`); return r }

const head = async (dir, ref = 'HEAD') => (await git(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { check: false })).trim() || null

// the clone (made the first time), its remote set to `url`, and `base` fetched → the sha of origin/<base>
async function sync(dir, { url, token, base }) {
  const remote = checkUrl(url)
  checkRef(base)
  if (!fs.existsSync(path.join(dir, '.git'))) {
    fs.mkdirSync(dir, { recursive: true })
    await git(dir, ['init', '-q', '-b', 'main'])
    await git(dir, ['remote', 'add', 'origin', remote])
    // what the agent's tools leave aside (its temp folder) is never committed
    fs.appendFileSync(path.join(dir, '.git', 'info', 'exclude'), '\n.tmp/\n.pgl-run/\n')
  } else {
    await git(dir, ['remote', 'set-url', 'origin', remote])
  }
  // (every time: a clone made by an older app gets it too)
  fs.mkdirSync(path.join(dir, '.git', 'info'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.git', 'info', 'attributes'), NEUTRAL)
  await git(dir, ['fetch', '-q', '--prune', 'origin', `+refs/heads/${base}:refs/remotes/origin/${base}`], { token, url: remote, timeout: NETWORK })
  const sha = await head(dir, `refs/remotes/origin/${base}`)
  if (!sha) throw new GitError(`${base} is not on the server`)
  return sha
}

// the run's branch from origin/<base>, the folder made clean first (what an earlier, broken run left)
async function branch(dir, name, base) {
  checkRef(name); checkRef(base)
  await git(dir, ['reset', '-q', '--hard'], { check: false })
  await git(dir, ['clean', '-fdq', '-e', '.tmp/'], { check: false })
  await git(dir, ['checkout', '-q', '-B', name, `refs/remotes/origin/${base}`])
  return head(dir)
}
// commits on the run's branch beyond where it started
const ahead = async (dir, from) => Number((await git(dir, ['rev-list', '--count', `${from}..HEAD`], { check: false })).trim() || 0)

async function commit(dir, message, { name = 'Process GPT Lite', email = 'desktop@pgpt-lite.local' } = {}) {
  await git(dir, ['add', '-A'])
  const staged = (await git(dir, ['diff', '--cached', '--name-only'])).trim()
  if (!staged) return null
  await git(dir, ['-c', `user.name=${name || 'Process GPT Lite'}`, '-c', `user.email=${email || 'desktop@pgpt-lite.local'}`, 'commit', '-q', '-m', message])
  return head(dir)
}
// what the run's branch changed against where it started
async function changed(dir, from) {
  return (await git(dir, ['diff', '--name-only', `${from}..HEAD`], { check: false })).split('\n').map((s) => s.trim()).filter(Boolean)
}
// the address the clone was made from (sync set it): the one its token is for
const originOf = async (dir) => checkUrl((await git(dir, ['remote', 'get-url', 'origin'])).trim())
async function push(dir, name, { token }) {
  checkRef(name)
  await git(dir, ['push', '--porcelain', 'origin', `HEAD:refs/heads/${name}`], { token, url: await originOf(dir), timeout: NETWORK })
  return true
}
// the folder back on the line (detached: the line is the server's), after the server took the run in
async function follow(dir, { token, base }) {
  checkRef(base)
  await git(dir, ['fetch', '-q', 'origin', `+refs/heads/${base}:refs/remotes/origin/${base}`], { token, url: await originOf(dir), timeout: NETWORK })
  await git(dir, ['checkout', '-q', '--detach', `refs/remotes/origin/${base}`])
  return head(dir)
}

module.exports = { git, gitPath, authEnv, checkUrl, checkRef, sync, branch, ahead, commit, changed, push, follow, head, originOf, GitError, NEUTRAL }
