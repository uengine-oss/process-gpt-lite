// git for shared folders. Only this server runs git on a folder's repository — never an agent
// (the agent edits files in its checkout; the server commits what changed, like cli-agent does).
import { execFile, spawn } from 'node:child_process'

const TIMEOUT = 60000
// the server may have been started from a shell that exported git's per-process overrides
const ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|NAMESPACE|CEILING)/.test(k)))
ENV.GIT_TERMINAL_PROMPT = '0'
ENV.LC_ALL = 'C.UTF-8'

export class GitError extends Error {
  constructor(args, code, stderr, stdout) {
    super(`git ${args.slice(0, 3).join(' ')} failed: ${String(stderr || stdout || '').trim().slice(0, 400)}`)
    this.code = code; this.stderr = String(stderr || ''); this.stdout = String(stdout || '')
  }
}

// paths stay as UTF-8 (core.quotepath=false), no pager, no hooks, file monitor or editors of the host's config; links are checked out as plain files.
// gc.auto=0: git never starts an automatic gc in the middle of a save (a commit that triggers one would
// repack a big folder while the person waits); folders are packed by the nightly pass instead (gc.js).
const BASE = ['-c', 'core.quotepath=false', '-c', 'core.pager=cat', '-c', 'advice.detachedHead=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.symlinks=false', '-c', 'gc.auto=0']
// what the git HTTP backend (gitHttp.js) starts from: the same environment, nothing of the host's git overrides
export const gitEnv = () => ({ ...ENV })

// how many git processes this server started (the tests hold reads under a reference slot to a few per request)
export const stats = { spawns: 0 }
// env: more variables for this one call (a temporary index: GIT_INDEX_FILE — folders/templates.js builds a commit without a work tree)
export function git(cwd, args, { buffer = false, check = true, input, timeout = TIMEOUT, env = null } = {}) {
  stats.spawns++
  return new Promise((resolve, reject) => {
    const child = execFile('git', [...BASE, ...args], { cwd, env: env ? { ...ENV, ...env } : ENV, timeout, maxBuffer: 256 * 1024 * 1024, encoding: buffer ? 'buffer' : 'utf8' }, (err, stdout, stderr) => {
      if (err && check) return reject(new GitError(args, err.code, stderr, stdout))
      resolve(buffer ? stdout : String(stdout))
    })
    if (input != null) { child.stdin.write(input); child.stdin.end() }
  })
}

// The contents of many blobs from one `git cat-file --batch` (not one git per file): each blob is handed to onBlob(sha, buffer) as it
// arrives, so only one is held at a time. Fails closed — a missing object, something that is not a blob, output cut short, a git error
// or the time running out rejects (the caller treats that as "could not be checked").
export function catBatch(cwd, shas, onBlob, { timeout = TIMEOUT } = {}) {
  const want = [...shas]
  if (!want.length) return Promise.resolve(0)
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...BASE, 'cat-file', '--batch'], { cwd, env: ENV, stdio: ['pipe', 'pipe', 'pipe'] })
    let buf = Buffer.alloc(0)
    let at = 0          // the next object asked for
    let need = null     // {sha, size} of the blob being read
    let failed = null
    let err = ''
    const fail = (e) => { if (!failed) { failed = e; try { child.kill() } catch { /* gone */ } } }
    const timer = setTimeout(() => fail(new Error('git cat-file --batch: out of time')), timeout)
    child.stderr.on('data', (d) => { if (err.length < 2000) err += d })
    child.stdout.on('data', (d) => {
      if (failed) return
      buf = buf.length ? Buffer.concat([buf, d]) : d
      for (;;) {
        if (!need) {
          const nl = buf.indexOf(10)
          if (nl < 0) return
          const [sha, type, size] = buf.subarray(0, nl).toString('latin1').split(' ')
          buf = buf.subarray(nl + 1)
          if (sha !== want[at] || type !== 'blob' || !/^\d+$/.test(size || '')) return fail(new Error(`git cat-file --batch: ${want[at]} is ${type || 'missing'}`))
          need = { sha, size: Number(size) }
        }
        if (buf.length < need.size + 1) return
        const body = buf.subarray(0, need.size)
        buf = buf.subarray(need.size + 1)
        try { onBlob(need.sha, body) } catch (e) { return fail(e) }
        need = null
        at++
      }
    })
    child.on('error', fail)
    child.on('close', (code) => {
      clearTimeout(timer)
      if (failed) return reject(failed)
      if (code) return reject(new Error(`git cat-file --batch exited ${code}: ${err.trim().slice(0, 200)}`))
      if (at !== want.length) return reject(new Error(`git cat-file --batch: ${want.length - at} of ${want.length} objects did not come`))
      resolve(at)
    })
    child.stdin.on('error', () => {})
    child.stdin.end(want.join('\n') + '\n')
  })
}

export const who = (name, email) => ['-c', `user.name=${name || 'pgpt-pro'}`, '-c', `user.email=${email || 'folders@pgpt-pro.local'}`]

export async function head(cwd, ref = 'HEAD') {
  return (await git(cwd, ['rev-parse', '--verify', '--quiet', ref], { check: false })).trim() || null
}
export async function isRepo(dir) {
  return (await git(dir, ['rev-parse', '--is-inside-work-tree'], { check: false })).trim() === 'true'
}
export async function branchExists(cwd, branch) {
  return !!(await head(cwd, `refs/heads/${branch}`))
}

// every file of a ref: [{path, size, sha}]
export async function lsTree(cwd, ref) {
  const out = await git(cwd, ['ls-tree', '-r', '-l', '-z', '--full-tree', ref], { check: false })
  return out.split('\0').filter(Boolean).map((line) => {
    const [meta, path] = line.split('\t')
    const [, type, sha, size] = meta.split(/\s+/)
    return type === 'blob' ? { path, sha, size: Number(size) || 0 } : null
  }).filter(Boolean)
}

// last commit touching each path in a ref (one pass over history)
export async function lastTouch(cwd, ref, limit = 400) {
  const out = await git(cwd, ['log', ref, `-n${limit}`, '--name-only', '--format=\u0001%H\u0002%an\u0002%ae\u0002%aI\u0002%s'], { check: false })
  const map = new Map()
  for (const block of out.split('\u0001').filter(Boolean)) {
    const [header, ...files] = block.split('\n')
    const [sha, name, email, at, subject] = header.split('\u0002')
    for (const f of files.map((x) => x.trim()).filter(Boolean)) if (!map.has(f)) map.set(f, { sha, name, email, at, subject })
  }
  return map
}

export async function log(cwd, range, limit = 50) {
  const out = await git(cwd, ['log', range, `-n${limit}`, '--format=%H\u0002%h\u0002%an\u0002%ae\u0002%aI\u0002%s'], { check: false })
  return out.split('\n').filter(Boolean).map((l) => {
    const [sha, short, name, email, at, msg] = l.split('\u0002')
    return { sha, short, name, email, at, msg }
  })
}

export async function show(cwd, ref, path) {
  return git(cwd, ['show', `${ref}:${path}`], { buffer: true })
}

// what runs before commitAll stages a work tree: registered by the modules that keep paths out of a commit (folders/refs.js — a folder's
// reference slots). Each gives the paths to leave out; they stay in the work tree as they are (nothing is deleted or unstaged beyond
// them). A step that fails stops the commit.
const beforeCommit = []
export const onBeforeCommit = (fn) => { beforeCommit.push(fn) }
// stage everything (but what a step leaves out) and commit; returns the new head or null when nothing changed
export async function commitAll(cwd, message, author = {}) {
  const leave = []
  for (const fn of beforeCommit) leave.push(...((await fn(cwd)) || []))
  await git(cwd, ['add', '-A'])
  if (leave.length) {
    // (those paths back to the last commit's state in the index only — the files stay as they are; when that fails nothing is committed)
    try { await git(cwd, ['reset', '-q', '--', ...leave.map((p) => `:(literal)${p}`)]) } catch (e) {
      await git(cwd, ['reset', '-q'], { check: false })
      throw Object.assign(new Error(`some paths could not be left out of the commit: ${e.message}`), { status: 503, code: 'ref_unchecked' })
    }
  }
  const staged = (await git(cwd, ['diff', '--cached', '--name-only'])).trim()
  if (!staged) return null
  await git(cwd, [...who(author.name, author.email), 'commit', '-q', '-m', message])
  return head(cwd)
}

// One file only (whatever else the working tree holds stays out). amend: fold into HEAD — an editing
// session's later saves (see canFold); when the session's edits were all undone the fold would be empty
// (git refuses it): the session's commit goes away instead. → {commit, dropped} | null (nothing changed)
export async function commitPath(cwd, rel, message, author = {}, { amend = false } = {}) {
  await git(cwd, ['add', '--', rel])
  if (!(await git(cwd, ['diff', '--cached', '--name-only', '--', rel])).trim()) return null
  try {
    if (amend && !(await git(cwd, ['diff', '--cached', '--name-only', 'HEAD^', '--', rel])).trim()) {
      await git(cwd, ['reset', '-q', '--soft', 'HEAD^'])
      return { commit: await head(cwd), dropped: true }
    }
    await git(cwd, [...who(author.name, author.email), 'commit', '-q', ...(amend ? ['--amend', '--date=now'] : []), '-m', message, '--only', '--', rel])
  } catch (e) {
    await git(cwd, ['reset', '-q', '--', rel], { check: false })
    throw e
  }
  return { commit: await head(cwd), dropped: false }
}

// May the next save of one editing session fold into `branch`'s newest commit? Only when that commit is
// this session's own (same message, which carries the session id, and author), changed only `path`, is
// recent, has a parent, and no other branch stands on it (a variation made since keeps its base).
export async function canFold(cwd, branch, { message, path, email, withinMs = 15 * 60_000 }) {
  const [sha, ae, ct, ...body] = (await git(cwd, ['log', '-1', '--format=%H%x00%ae%x00%ct%x00%B', branch], { check: false })).split('\0')
  if (!sha || body.join('\0').trim() !== String(message).trim() || ae !== email) return false
  if (Date.now() - Number(ct) * 1000 > withinMs) return false
  if (!(await git(cwd, ['rev-parse', '--verify', '-q', `${sha}^`], { check: false })).trim()) return false
  const files = (await git(cwd, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', sha], { check: false })).split('\0').filter(Boolean)
  if (files.length !== 1 || files[0] !== path) return false
  const on = (await git(cwd, ['branch', '--contains', sha, '--format=%(refname:short)'], { check: false })).split('\n').map((x) => x.trim()).filter(Boolean)
  return on.length === 1 && on[0] === branch
}

// changes a branch made since it left `base` (three-dot): [{path, change, add, del, binary}]
export async function changes(cwd, base, ref) {
  const range = `${base}...${ref}`
  const status = await git(cwd, ['diff', '--name-status', '-z', '--no-renames', range], { check: false })
  const parts = status.split('\0').filter(Boolean)
  const out = []
  for (let i = 0; i < parts.length; i += 2) out.push({ change: parts[i][0], path: parts[i + 1] })
  const num = await git(cwd, ['diff', '--numstat', '-z', '--no-renames', range], { check: false })
  for (const rec of num.split('\0').filter(Boolean)) {
    const [add, del, path] = rec.split('\t')
    const c = out.find((x) => x.path === path)
    if (c) Object.assign(c, add === '-' ? { binary: true } : { add: Number(add), del: Number(del) })
  }
  return out
}

export async function aheadBehind(cwd, base, ref) {
  const out = (await git(cwd, ['rev-list', '--left-right', '--count', `${base}...${ref}`], { check: false })).trim()
  const [behind, ahead] = out.split(/\s+/).map(Number)
  return { ahead: ahead || 0, behind: behind || 0 }
}

export async function mergeBase(cwd, a, b) {
  return (await git(cwd, ['merge-base', a, b], { check: false })).trim() || null
}

// local branches with their tip (for a linked repository's listing)
export async function branches(cwd) {
  const out = await git(cwd, ['for-each-ref', '--format=%(refname:short)\u0002%(objectname:short)\u0002%(committerdate:iso-strict)\u0002%(authorname)\u0002%(subject)', 'refs/heads'], { check: false })
  return out.split('\n').filter(Boolean).map((l) => {
    const [name, sha, at, author, subject] = l.split('\u0002')
    return { name, sha, at, author, subject }
  })
}

// registered worktrees: [{path, head, branch, prunable}]
export async function worktrees(cwd) {
  const out = await git(cwd, ['worktree', 'list', '--porcelain'], { check: false })
  return out.split('\n\n').filter(Boolean).map((b) => {
    const w = {}
    for (const line of b.split('\n')) {
      const [k, ...v] = line.split(' ')
      if (k === 'worktree') w.path = v.join(' ')
      else if (k === 'HEAD') w.head = v[0]
      else if (k === 'branch') w.branch = v[0].replace('refs/heads/', '')
      else if (k === 'prunable') w.prunable = true
    }
    return w
  })
}
