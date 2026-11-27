// Whether a push over git HTTP may stand (gitHttp.js) — decided by git itself before any ref moves: receive-pack runs this file as its
// pre-receive hook, when the pushed objects are still in git's quarantine (GIT_QUARANTINE_PATH) and no ref has changed. A hook that says no
// makes git drop what came and update nothing, so nothing unchecked is ever fetched, listed or brought in.
// A token reads only part of a folder (gitHttp.js hidden refs: other desktops' sync and run branches, projects' workspaces). A push may
// not use what its token cannot read:
//   1. every object a new tip takes in that the refs the token sees do not already hold came with the push — a commit, tree or blob
//      named only by its id (a new commit over a hidden tree) is refused
//   2. an object of the push that was here before (the base of a delta git copied in from the repository) is not one that only refs
//      hidden from the token hold
// The checks are a fixed handful of git processes, whatever the number of refs (no git per command, no ref list on a command line).
// Only node's own modules: git starts this file as a process of its own (gitHttp.js hooks()).
import { spawn } from 'node:child_process'
import fs from 'node:fs'
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

function run(args, { cwd, env, input = '' }) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
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

// commands: [{old, new, ref}]; hide: the token's hidden-ref entries; env: the hook's (quarantine included) → null, or why it may not stand
export async function check({ commands, hide, cwd = process.cwd(), env = process.env }) {
  const tips = [...new Set((commands || []).filter((c) => !ZERO.test(c.new)).map((c) => c.new))]
  if (!tips.length) return null
  const refs = (await run(['for-each-ref', '--format=%(refname)'], { cwd, env })).split('\n').map((x) => x.trim()).filter(Boolean)
  const seen = refs.filter((r) => !hiddenBy(r, hide))
  const quarantine = env.GIT_QUARANTINE_PATH || ''
  // (only what came: the quarantine without the repository behind it — and only the repository, without what came)
  const came = { ...env }
  delete came.GIT_ALTERNATE_OBJECT_DIRECTORIES
  const here = { ...env }
  for (const k of ['GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_QUARANTINE_PATH']) delete here[k]
  // 1. what the new tips take in beyond what the token already sees
  const taken = idsOf(await run(['rev-list', '--objects', '--stdin'], { cwd, env, input: lines([...tips, ...seen.map((r) => `^${r}`)]) }))
  if (taken.length) {
    if (!quarantine) return 'it names objects that did not come with it'
    const absent = idsOf(await run(['cat-file', '--batch-check=%(objectname)'], { cwd, env: came, input: lines(taken) }), { missing: true })
    if (absent.length) return `it names ${absent.length} object(s) that did not come with it and that this token cannot read`
  }
  // 2. what came that was here already: only what the token sees (a thin pack's delta bases from the refs it was shown)
  if (!quarantine) return null
  const brought = idsOf(await run(['cat-file', '--batch-all-objects', '--batch-check=%(objectname)'], { cwd, env: came }))
  if (!brought.length) return null
  const had = idsOf(await run(['cat-file', '--batch-check=%(objectname)'], { cwd, env: here, input: lines(brought) }), { missing: false })
  if (!had.length) return null
  const rest = new Set(had)
  // (the tips' own trees first — where a thin pack's bases are)
  for (const id of idsOf(await run(['rev-list', '--objects', '--no-walk', '--stdin'], { cwd, env: here, input: lines(seen) }))) rest.delete(id)
  if (!rest.size) return null
  // what is left counts only when a hidden ref holds it: an object no ref holds (what an earlier push left when it was put back — the
  // same desktop sends it again) is anyone's to send. The hidden refs' own objects first; the whole history the token sees only for those
  const hidden = refs.filter((r) => hiddenBy(r, hide))
  if (!hidden.length) return null
  const behind = new Set(idsOf(await run(['rev-list', '--objects', '--stdin'], { cwd, env: here, input: lines([...hidden, ...seen.map((r) => `^${r}`)]) })))
  const suspect = [...rest].filter((id) => behind.has(id))
  if (!suspect.length) return null
  const all = new Set(idsOf(await run(['rev-list', '--objects', '--stdin'], { cwd, env: here, input: lines(seen) })))
  const bad = suspect.filter((id) => !all.has(id))
  return bad.length ? `it is built on ${bad.length} object(s) this token cannot read` : null
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
  try {
    const hide = JSON.parse(fs.readFileSync(String(process.env.PGPT_PUSH_HIDE || ''), 'utf8'))
    why = await check({ commands, hide: Array.isArray(hide) ? hide : [] })
  } catch (e) { why = `the push could not be checked (${e.message})` }
  if (!why) return 0
  try { if (process.env.PGPT_PUSH_REASON) fs.writeFileSync(process.env.PGPT_PUSH_REASON, why) } catch { /* the refusal stands */ }
  process.stderr.write('Process GPT Lite: this push is refused — it refers to objects this token may not use\n')
  return 1
}
const self = (() => { try { return fs.realpathSync(fileURLToPath(import.meta.url)) } catch { return '' } })()
const started = (() => { try { return process.argv[1] ? fs.realpathSync(process.argv[1]) : '' } catch { return '' } })()
if (self && self === started) hook().then((code) => process.exit(code), () => process.exit(1))
