// git for shared folders. Only this server runs git on a folder's repository — never an agent
// (the agent edits files in its checkout; the server commits what changed, like cli-agent does).
import { execFile } from 'node:child_process'

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

// paths stay as UTF-8 (core.quotepath=false), no pager, no hooks or editors of the host's config
const BASE = ['-c', 'core.quotepath=false', '-c', 'core.pager=cat', '-c', 'advice.detachedHead=false', '-c', 'core.hooksPath=/dev/null']

export function git(cwd, args, { buffer = false, check = true, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile('git', [...BASE, ...args], { cwd, env: ENV, timeout: TIMEOUT, maxBuffer: 256 * 1024 * 1024, encoding: buffer ? 'buffer' : 'utf8' }, (err, stdout, stderr) => {
      if (err && check) return reject(new GitError(args, err.code, stderr, stdout))
      resolve(buffer ? stdout : String(stdout))
    })
    if (input != null) { child.stdin.write(input); child.stdin.end() }
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

// stage everything and commit; returns the new head or null when nothing changed
export async function commitAll(cwd, message, author = {}) {
  await git(cwd, ['add', '-A'])
  const staged = (await git(cwd, ['diff', '--cached', '--name-only'])).trim()
  if (!staged) return null
  await git(cwd, [...who(author.name, author.email), 'commit', '-q', '-m', message])
  return head(cwd)
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
