// Whether a push over git HTTP may stand (gitHttp.js) — decided by git itself before any ref moves: receive-pack runs this file as its
// pre-receive hook, when the pushed objects are still in git's quarantine (GIT_QUARANTINE_PATH) and no ref has changed. A hook that says no
// makes git drop what came and update nothing, so nothing unchecked is ever fetched, listed or brought in.
// A token reads only part of a folder (gitHttp.js hidden refs: other desktops' sync and run branches, projects' workspaces). A push may
// not use what its token cannot read. What the client sent are the first objects of the pack git kept (receive.unpackLimit=1: always a
// pack) — as many as the pack's header says, which is what git read of it; what index-pack --fix-thin added after them are the bases of a
// thin pack's deltas, copied in from the repository:
//   1. every object a new tip takes in that the refs the token sees do not already hold is one the client sent, and every commit the
//      client sent is one a new tip reaches (nothing rides along unreferenced)
//   2. every base git added is held by a ref the token sees: in the tree of a commit the new tips stand on (step 1 showed those are the
//      token's to see) or of a ref the token was shown
// An object the client sent whole is its own, whatever else holds the same bytes. The checks are a fixed handful of git processes, whatever
// the number of refs, with no walk of the folder's history (no git per command, no ref list on a command line); the hook has a time limit.
// Only node's own modules: git starts this file as a process of its own (gitHttp.js hooks()).
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ZERO = /^0{40}$|^0{64}$/
const OID = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/

// git's hidden-ref rule (transfer.hideRefs, read in order — a later !ref shows what an earlier entry hid; trailing slashes do not count;
// an entry hides that ref and everything under it)
export function hiddenBy(ref, hide) {
  let hidden = false
  for (const e of hide || []) {
    const neg = e.startsWith('!')
    const pat = (neg ? e.slice(1) : e).replace(/\/+$/, '')
    if (pat && (ref === pat || ref.startsWith(`${pat}/`))) hidden = !neg
  }
  return hidden
}

// (the git processes running now: a check that runs out of time stops them before it goes — they would go on outside the folder's lock)
const running = new Set()
export const stopAll = () => { for (const c of running) { try { c.kill('SIGKILL') } catch { /* gone */ } } }
function run(args, { cwd, env, input = '' }) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    running.add(child)
    child.on('exit', () => running.delete(child))
    const out = []
    let err = ''
    child.stdout.on('data', (d) => out.push(d))
    child.stderr.on('data', (d) => { if (err.length < 2000) err += d })
    child.on('error', reject)
    child.on('close', (code) => (code ? reject(new Error(`git ${args[0]}: ${err.trim().slice(0, 300)}`)) : resolve(Buffer.concat(out).toString('utf8'))))
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}
// the object ids at the start of each line (rev-list --objects: "<id> <path>"; cat-file --batch-check: "<id>" or "<id> missing")
const idsOf = (text, { missing = null } = {}) => text.split('\n').map((l) => l.trim()).filter(Boolean)
  .filter((l) => missing === null || / missing$/.test(l) === missing).map((l) => l.split(' ')[0]).filter((x) => OID.test(x))
const lines = (list) => (list.length ? `${list.join('\n')}\n` : '')

// The objects of the push's pack in the order git wrote them → [{id, at}] by offset, or null when that cannot be told (more than one pack,
// an index that does not list every object the kept pack's header counts — the same object twice)
async function packedOf(quarantine, { cwd, env }) {
  const dir = path.join(quarantine, 'pack')
  const idx = (fs.existsSync(dir) ? fs.readdirSync(dir) : []).filter((f) => f.endsWith('.idx'))
  if (idx.length > 1) return null
  const out = []
  if (idx.length) {
    const text = await run(['show-index'], { cwd, env, input: fs.readFileSync(path.join(dir, idx[0])) })
    for (const l of text.split('\n')) {
      const [at, id] = l.trim().split(' ')
      if (OID.test(id || '') && /^\d+$/.test(at || '')) out.push({ id, at: Number(at) })
    }
    // (the kept pack's header: what the client sent and what git added, each object once)
    const head = Buffer.alloc(12)
    const fd = fs.openSync(path.join(dir, idx[0].replace(/\.idx$/, '.pack')), 'r')
    try { fs.readSync(fd, head, 0, 12, 0) } finally { fs.closeSync(fd) }
    if (head.toString('latin1', 0, 4) !== 'PACK' || head.readUInt32BE(8) !== out.length) return null
  }
  out.sort((a, b) => a.at - b.at)
  return out
}

// commands: [{old, new, ref}]; hide: the token's hidden-ref entries; count: the objects the client's pack holds (its header — gitHttp.js
// reads it from the request); env: the hook's (quarantine included) → null, or why it may not stand
export async function check({ commands, hide, count, cwd = process.cwd(), env = process.env }) {
  const tips = [...new Set((commands || []).filter((c) => !ZERO.test(c.new)).map((c) => c.new))]
  if (!tips.length) return null
  if (!Number.isInteger(count) || count < 0) return 'the push could not be checked (no object count)'
  const refs = (await run(['for-each-ref', '--format=%(refname)'], { cwd, env })).split('\n').map((x) => x.trim()).filter(Boolean)
  const seen = refs.filter((r) => !hiddenBy(r, hide))
  const quarantine = env.GIT_QUARANTINE_PATH || ''
  // (only what came: the quarantine without the repository behind it — and only the repository, without what came)
  const came = { ...env }
  delete came.GIT_ALTERNATE_OBJECT_DIRECTORIES
  const here = { ...env }
  for (const k of ['GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_QUARANTINE_PATH']) delete here[k]
  const packed = quarantine ? await packedOf(quarantine, { cwd, env: came }) : []
  if (!packed) return 'the push could not be checked (its pack cannot be read object by object)'
  if (quarantine && idsOf(await run(['cat-file', '--batch-all-objects', '--batch-check=%(objectname)'], { cwd, env: came })).length > packed.length) {
    return 'the push could not be checked (objects outside its pack)'
  }
  // (the client's: the first `count` objects of the pack — whatever bytes came after them, git read only those; fewer is not told apart)
  if (packed.length < count) return 'the push could not be checked (its pack holds fewer objects than it says)'
  const client = new Set(packed.slice(0, count).map((o) => o.id))
  const added = packed.slice(count).map((o) => o.id)
  // 1. what the new tips take in beyond what the token already sees: only what the client sent
  const taken = idsOf(await run(['rev-list', '--objects', '--stdin'], { cwd, env, input: lines([...tips, ...seen.map((r) => `^${r}`)]) }))
  const absent = taken.filter((id) => !client.has(id))
  if (absent.length) return `it names ${absent.length} object(s) that did not come with it and that this token cannot read`
  // …and no commit of the client's that no new tip reaches (a real push never sends one)
  const types = client.size ? (await run(['cat-file', '--batch-check=%(objectname) %(objecttype)'], { cwd, env: came, input: lines([...client]) })).split('\n') : []
  const sentCommits = types.map((l) => l.trim().split(' ')).filter(([id, t]) => t === 'commit' && OID.test(id)).map(([id]) => id)
  const inTaken = new Set(taken)
  const aside = sentCommits.filter((id) => !inTaken.has(id))
  if (aside.length) {
    const stray = new Set(idsOf(await run(['rev-list', '--stdin'], { cwd, env, input: lines([...aside, ...tips.map((t) => `^${t}`)]) })))
    if (aside.some((id) => stray.has(id))) return 'it carries commits none of its refs reach'
  }
  // 2. the bases git added for a thin pack: held by a ref the token sees
  if (!added.length) return null
  const rest = new Set(added)
  // (the parents of the commits the new tips take in — never of a commit the client sent aside)
  const commits = sentCommits.filter((id) => inTaken.has(id))
  const parents = commits.length ? (await run(['rev-list', '--parents', '--no-walk', '--stdin'], { cwd, env, input: lines(commits) })).split('\n')
    .flatMap((l) => l.trim().split(' ').slice(1)).filter((id) => OID.test(id) && !client.has(id)) : []
  // (the trees of the commits the push stands on — where git takes a thin pack's bases from — then those of the refs it was shown)
  for (const from of [[...new Set(parents)], seen]) {
    if (!rest.size || !from.length) continue
    for (const id of idsOf(await run(['rev-list', '--objects', '--no-walk', '--stdin'], { cwd, env: here, input: lines(from) }))) rest.delete(id)
  }
  return rest.size ? `it is built on ${rest.size} object(s) this token cannot read` : null
}

// ---------- as git's pre-receive hook ----------
// stdin: "<old> <new> <ref>" per ref; PGPT_PUSH_HIDE: a file with the token's hidden-ref entries (JSON); PGPT_PUSH_REASON: where the
// reason of a refusal is written for the server's log. Any failure refuses (nothing stands that was not checked).
async function hook() {
  const chunks = []
  for await (const c of process.stdin) chunks.push(c)
  const commands = Buffer.concat(chunks).toString('utf8').split('\n').map((l) => l.trim().split(' ')).filter((p) => p.length === 3).map(([old, neu, ref]) => ({ old, new: neu, ref }))
  // (nothing asked: the server's own probe that the hook can run — gitHttp.js hooks())
  if (!commands.length) return 0
  let why
  // (a check that runs out of time refuses: the folder's lock is held while it runs)
  const limit = setTimeout(() => { stopAll(); refuse('the push could not be checked in time').finally(() => process.exit(1)) }, Number(process.env.PGPT_PUSH_CHECK_MS) || CHECK_MS)
  limit.unref?.()
  try {
    const hide = JSON.parse(fs.readFileSync(String(process.env.PGPT_PUSH_HIDE || ''), 'utf8'))
    const count = /^\d+$/.test(String(process.env.PGPT_PUSH_COUNT || '')) ? Number(process.env.PGPT_PUSH_COUNT) : null
    why = await check({ commands, hide: Array.isArray(hide) ? hide : [], count })
  } catch (e) { why = `the push could not be checked (${e.message})` }
  clearTimeout(limit)
  if (!why) return 0
  await refuse(why)
  return 1
}
export const CHECK_MS = 120_000
async function refuse(why) {
  try { if (process.env.PGPT_PUSH_REASON) fs.writeFileSync(process.env.PGPT_PUSH_REASON, why) } catch { /* the refusal stands */ }
  process.stderr.write('Process GPT Lite: this push is refused — it refers to objects this token may not use\n')
}
const self = (() => { try { return fs.realpathSync(fileURLToPath(import.meta.url)) } catch { return '' } })()
const started = (() => { try { return process.argv[1] ? fs.realpathSync(process.argv[1]) : '' } catch { return '' } })()
if (self && self === started) hook().then((code) => process.exit(code), () => process.exit(1))
