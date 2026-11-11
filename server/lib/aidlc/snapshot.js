// What a running bolt can be put back to (docs/robo-dlc/plan-intake.md §8): the project's files as they were
// when the bolt started, kept as a Git object under refs/lite/. Discarding the bolt puts back the files it
// changed and sets aside the files it made — but never the AI-DLC record (aidlc/): what was asked, decided
// and reviewed stays, with the discard written next to it. When commits were made since, nothing is put
// back by Lite: the range is reported for a person to revert.
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
// no hooks, no pager, no prompts: this runs on the server, beside the session that works in the same folder
const git = async (root, ...args) => (await run('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=lite', '-c', 'user.email=lite@localhost', ...args],
  { cwd: root, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } })).stdout
const lines = (s) => s.split('\0').filter(Boolean)
// what a discard leaves alone: the AI-DLC record and its set-up
export const KEEP = ['aidlc/', '.claude/', '.aidlc/']
const kept = (p) => KEEP.some((k) => p === k.slice(0, -1) || p.startsWith(k))
const safeId = (id) => String(id).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120)

export async function isRepo(root) {
  return git(root, 'rev-parse', '--is-inside-work-tree').then((s) => s.trim() === 'true', () => false)
}

// → { ref, object, head, untracked: [path], at } (null: not a Git repository)
export async function take(root, id) {
  if (!(await isRepo(root))) return null
  const head = (await git(root, 'rev-parse', 'HEAD')).trim()
  // the tracked files as they are now, as a commit that is on no branch (empty: nothing differs from HEAD)
  const object = (await git(root, 'stash', 'create', `lite snapshot ${safeId(id)}`)).trim() || head
  const ref = `refs/lite/snap/${safeId(id)}`
  await git(root, 'update-ref', ref, object)
  const untracked = lines(await git(root, 'ls-files', '--others', '--exclude-standard', '-z'))
  return { ref, object, head, untracked, at: new Date().toISOString() }
}

// What has changed since the snapshot, outside the record: { moved, changed: [path], made: [path] }
export async function since(root, snap) {
  const head = (await git(root, 'rev-parse', 'HEAD')).trim()
  const moved = head === snap.head ? null : { from: snap.head, to: head, commits: (await git(root, 'rev-list', '--count', `${snap.head}..${head}`).catch(() => '0')).trim() }
  const changed = lines(await git(root, 'diff', '--name-only', '-z', snap.object, '--')).filter((p) => !kept(p))
  const before = new Set(snap.untracked || [])
  const made = lines(await git(root, 'ls-files', '--others', '--exclude-standard', '-z')).filter((p) => !kept(p) && !before.has(p))
  return { moved, changed, made }
}

// Put the files back. → { restored: [path], removed: [path], aside, moved, record: 'kept' }
//   restored: files the bolt changed or deleted, as they were · removed: files the bolt made, moved to `aside`
//   (inside .git, so nothing is lost) · moved: commits were made since the snapshot — nothing was touched
export async function restore(root, snap, id) {
  const diff = await since(root, snap)
  if (diff.moved) return { restored: [], removed: [], aside: null, moved: diff.moved, record: 'kept' }
  const inSnap = new Set(lines(await git(root, 'ls-tree', '-r', '--name-only', '-z', snap.object)))
  const back = diff.changed.filter((p) => inSnap.has(p))
  // tracked since (added to the index by the bolt) but not in the snapshot: out of the index, then set aside like the rest
  const added = diff.changed.filter((p) => !inSnap.has(p))
  for (let i = 0; i < back.length; i += 200) await git(root, 'checkout', snap.object, '--', ...back.slice(i, i + 200))
  // the index as HEAD has it, the files as the snapshot had them: what was staged before stays only as a file change
  if (back.length) await git(root, 'reset', '-q', '--', ...back.slice(0, 2000)).catch(() => {})
  for (let i = 0; i < added.length; i += 200) await git(root, 'rm', '-q', '--cached', '--ignore-unmatch', '--', ...added.slice(i, i + 200))
  const out = [...new Set([...added, ...diff.made])]
  const gitDir = path.resolve(root, (await git(root, 'rev-parse', '--git-dir')).trim())
  const aside = out.length ? path.join(gitDir, 'lite-discarded', `${safeId(id)}-${Date.now()}`) : null
  const removed = []
  for (const p of out) {
    const from = path.join(root, p)
    if (!(await fs.stat(from).catch(() => null))) continue
    const to = path.join(aside, p)
    await fs.mkdir(path.dirname(to), { recursive: true })
    await fs.rename(from, to)
    removed.push(p)
  }
  return { restored: back, removed, aside, moved: null, record: 'kept' }
}

export async function drop(root, snap) {
  if (snap?.ref) await git(root, 'update-ref', '-d', snap.ref).catch(() => {})
}
