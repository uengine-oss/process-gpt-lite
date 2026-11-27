// Shared folders over git smart HTTP — for agents that do not share this server's disk.
// A process step on cli-agent gets its folder as a URL (PRO_GIT_URL/api/git/<folder id>.git) and a token
// (work.js stepOne): cli-agent runs in its own pod with its own volume, where the folder's repository path
// does not exist. It clones over HTTP, works on its branch, and pushes `pgpt-agent/<run>` back here.
//   - the token (HMAC, keyed from this server's service key) names one tenant and one folder, how long it
//     lasts, and the branch prefix it may push to; it is the only way in (no sign-in cookie or session here)
//   - git http-backend (CGI) does the protocol; this file decides who and what
//   - a push may only create or move refs/heads/<prefix>…; deleting, tags, main or any other ref are
//     refused before git sees the push, with git's own status report ("remote rejected" on the client)
//   - a push runs in the folder's serial lock (service.js), like every write to the repository, so it
//     never overlaps a save in main or the nightly gc (gc.js)
//   - git itself checks what a push brought before any ref moves (pushCheck.js, its pre-receive hook): a push that uses what its token
//     cannot read is dropped whole
// Only this server runs git on the repository; agents only send and receive objects.
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import os from 'node:os'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { config } from '../../config.js'
import { q } from '../supa.js'
import { withTenant, servesTenant } from '../tenant.js'
import * as G from './git.js'
import * as S from './service.js'
import { hiddenBy } from './pushCheck.js'

export { hiddenBy }
export const PUSH_PREFIX = 'pgpt-agent/'
export const TOKEN_HOURS = () => config.gitTokenHours // PRO_GIT_TOKEN_HOURS (default 72): cli-agent keeps a run's workspace (and so its clone) 72 hours
export const MAX_PUSH = 200 * 1024 * 1024 // the folder upload limit (routes/folders.js)
const REALM = 'Process GPT Lite folders'
const ZERO = /^0{40}$|^0{64}$/
const OID = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/

// ---------- token ----------
// "pgf1.<payload>.<signature>", both base64url; payload {tenant, folder, push, exp (seconds)} — and for a desktop's local agent
// (lib/localAgents) {scope: 'device', device, job}: the token of one job on one linked desktop — or {scope: 'sync', device} (job ''): the
// token of one folder a linked desktop uploads (champion folders, lib/folders/sources.js); the only two kinds the public path takes
const key = () => {
  if (!config.serviceKey) throw new Error('folder git tokens need SERVICE_ROLE_KEY')
  return crypto.createHmac('sha256', String(config.serviceKey)).update('folder-git:v1').digest()
}
const sign = (body) => crypto.createHmac('sha256', key()).update(`pgf1.${body}`).digest('base64url')

// (seat, epoch: a desktop's working-copy token — variation seats, design P1: one variation at one epoch; devices.js seatAccess checks it)
export function mintToken({ tenant = config.tenantId, folderId, push = PUSH_PREFIX, hours = TOKEN_HOURS(), now = Date.now(), scope = null, device = null, job = null, seat = null, epoch = null } = {}) {
  if (!folderId) throw new Error('a folder git token names its folder')
  const extra = scope ? { scope: String(scope), device: String(device || ''), job: String(job || ''), ...(seat ? { seat: String(seat), epoch: Number(epoch) || 0 } : {}) } : {}
  const body = Buffer.from(JSON.stringify({ tenant, folder: String(folderId), push, exp: Math.floor(now / 1000 + hours * 3600), ...extra })).toString('base64url')
  return `pgf1.${body}.${sign(body)}`
}

// the token's claims, or null (malformed, forged, expired)
export function verifyToken(token, { now = Date.now() } = {}) {
  const m = /^pgf1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(String(token || '').trim())
  if (!m) return null
  let want
  try { want = Buffer.from(sign(m[1]), 'base64url') } catch { return null }
  const got = Buffer.from(m[2], 'base64url')
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null
  let c
  try { c = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8')) } catch { return null }
  if (!c || typeof c.tenant !== 'string' || typeof c.folder !== 'string' || typeof c.push !== 'string' || !Number.isFinite(c.exp)) return null
  if (c.exp * 1000 <= now) return null
  return c
}

// Authorization: Bearer <token> — or Basic with the token as the password (any user name), so a plain
// `git clone http://x:<token>@host/api/git/<id>.git` works too
export function tokenOf(req) {
  const h = String(req.headers.authorization || '')
  const bearer = /^Bearer\s+(.+)$/i.exec(h)
  if (bearer) return bearer[1].trim()
  const basic = /^Basic\s+(.+)$/i.exec(h)
  if (!basic) return null
  const plain = Buffer.from(basic[1].trim(), 'base64').toString('utf8')
  const i = plain.indexOf(':')
  return i >= 0 ? plain.slice(i + 1) : null
}

// ---------- what a push asks for ----------
// The receive-pack request: pkt-lines "<old> <new> <ref>[\0capabilities]" (shallow lines may come first),
// a flush, then (push options and) the pack. → {commands: [{old, new, ref}], caps: Set} or throws — also past MAX_COMMANDS refs (a desktop,
// a sync or a cli-agent run pushes one or two: a push of thousands is no one's)
export const MAX_COMMANDS = 20
export function parseCommands(buf) {
  const commands = []
  let caps = new Set()
  let at = 0
  while (true) {
    if (at + 4 > buf.length) throw new Error('truncated push request')
    const hex = buf.toString('latin1', at, at + 4)
    if (!/^[0-9a-f]{4}$/i.test(hex)) throw new Error('malformed push request')
    const len = parseInt(hex, 16)
    if (len === 0) break // flush: the commands are over
    if (len < 4 || at + len > buf.length) throw new Error('malformed push request')
    let line = buf.subarray(at + 4, at + len)
    at += len
    const nul = line.indexOf(0)
    if (nul >= 0) {
      if (!commands.length) caps = new Set(line.subarray(nul + 1).toString('utf8').trim().split(/\s+/).filter(Boolean))
      line = line.subarray(0, nul)
    }
    const text = line.toString('utf8').replace(/\n$/, '')
    if (text.startsWith('shallow ')) continue
    const [old, neu, ref, ...rest] = text.split(' ')
    if (rest.length || !OID.test(old || '') || !OID.test(neu || '') || !ref) throw new Error('malformed push request')
    commands.push({ old, new: neu, ref })
    if (commands.length > MAX_COMMANDS) throw new Error(`a push may update at most ${MAX_COMMANDS} refs`)
  }
  return { commands, caps }
}

// null when every ref update may go through, else the reason for each refused ref
export function refusals(commands, prefix = PUSH_PREFIX) {
  // a token with no push prefix only reads (the skills a desktop's local agent gets — lib/localAgents/steps.js)
  if (!prefix) return (commands.length ? commands : [{ ref: '(none)' }]).map((c) => ({ ref: c.ref, why: 'this token may only read' }))
  const out = []
  const branch = new RegExp(`^refs/heads/${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[A-Za-z0-9._/-]+$`)
  for (const c of commands) {
    let why = null
    if (ZERO.test(c.new)) why = 'deleting refs is not allowed here'
    else if (!branch.test(c.ref) || c.ref.includes('..') || c.ref.includes('//') || /\.lock$|\/$|\/\./.test(c.ref)) why = `only refs/heads/${prefix}* may be pushed here`
    if (why) out.push({ ref: c.ref, why })
  }
  if (!commands.length) return [{ ref: '(none)', why: 'no ref to update' }]
  return out.length ? out : null
}

const pkt = (s) => {
  const b = Buffer.isBuffer(s) ? s : Buffer.from(s, 'utf8')
  return Buffer.concat([Buffer.from((b.length + 4).toString(16).padStart(4, '0')), b])
}
// receive-pack's own status report: every command "ng" (the push is all or nothing), told on side band 1
// when the client asked for one, with the reason also on band 2 so git prints it as "remote: …"
export function rejectionReport(commands, refused, caps) {
  const why = new Map(refused.map((r) => [r.ref, r.why]))
  const report = Buffer.concat([
    pkt('unpack ok\n'),
    ...commands.map((c) => pkt(`ng ${c.ref} ${why.get(c.ref) || 'another ref in this push was refused'}\n`)),
    Buffer.from('0000'),
  ])
  const band = caps.has('side-band-64k') ? 65515 : caps.has('side-band') ? 995 : 0
  if (!band) return report
  const parts = [pkt(Buffer.concat([Buffer.from([2]), Buffer.from(`Process GPT Lite: ${refused[0].why}\n`)]))]
  for (let i = 0; i < report.length; i += band) parts.push(pkt(Buffer.concat([Buffer.from([1]), report.subarray(i, i + band)])))
  parts.push(Buffer.from('0000'))
  return Buffer.concat(parts)
}

// ---------- the route ----------
const SERVICES = new Set(['git-upload-pack', 'git-receive-pack'])
const deny = (res, status, text, headers = {}) => { if (!res.headersSent) res.status(status).set({ 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache', ...headers }).end(`${text}\n`) }

// the request body, up to `limit` bytes (gunzipped when the client compressed it) → Buffer, or null (too big)
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const parts = []
    let n = 0
    let over = false
    req.on('data', (d) => { if (over) return; n += d.length; if (n > limit) { over = true; parts.length = 0 } else parts.push(d) })
    req.on('end', () => {
      if (over) return resolve(null)
      let buf = Buffer.concat(parts)
      if (/gzip/i.test(String(req.headers['content-encoding'] || ''))) {
        try { buf = zlib.gunzipSync(buf, { maxOutputLength: limit }) } catch (e) { return e.code === 'ERR_BUFFER_TOO_LARGE' || /larger than/i.test(e.message) ? resolve(null) : reject(e) }
      }
      resolve(buf)
    })
    req.on('error', reject)
  })
}

// git http-backend as a CGI program: its header block (Status:, Content-Type: …) becomes the response's,
// the rest streams through. `body`: a Buffer already read, else the request streams into it. hold: the response is not ended here
// (the caller ends it — after() has looked at the push first, so the client's push is over only then). check: a push's pre-receive check
// ({hooks, hide, reason} — pushCheck.js): git runs it on what came, in quarantine, before any ref moves
function backend(req, res, folder, pathInfo, body, { hold = false, hide = [], check = null } = {}) {
  return new Promise((resolve) => {
    const cfg = [
      ['http.receivepack', 'true'], // the token stands for REMOTE_USER: pushing is allowed, within refusals() above
      ['receive.denyDeletes', 'true'],
      ['receive.fsckObjects', 'true'],
      ['receive.autogc', 'false'], // no gc after a push either: the nightly pass packs (gc.js)
      ['gc.auto', '0'],
      // (a push: only our check — and every pack is kept as a pack, so the bases git adds to a thin one are among what came and are
      // checked too; small pushes would otherwise be unpacked with their bases taken from the repository unseen)
      ['core.hooksPath', check ? check.hooks : '/dev/null'],
      ...(check ? [['receive.unpackLimit', '1']] : []),
      // every desktop's sync branches are hidden from every other token — not listed, not fetched, not pushed to (transfer.hideRefs: both
      // upload-pack and receive-pack; syncHidden below); a sync token sees its own device's (what it pushed and what the server put back)
      ...hide.map((r) => ['transfer.hideRefs', r]),
    ]
    const env = {
      ...G.gitEnv(),
      GIT_PROJECT_ROOT: folder.repo_path,
      GIT_HTTP_EXPORT_ALL: '1',
      PATH_INFO: pathInfo,
      REQUEST_METHOD: req.method,
      QUERY_STRING: new URL(req.originalUrl || req.url, 'http://x').search.slice(1),
      CONTENT_TYPE: String(req.headers['content-type'] || ''),
      REMOTE_USER: 'folder-agent',
      REMOTE_ADDR: String(req.socket?.remoteAddress || ''),
      GIT_CONFIG_COUNT: String(cfg.length),
      ...Object.fromEntries(cfg.flatMap(([k, v], i) => [[`GIT_CONFIG_KEY_${i}`, k], [`GIT_CONFIG_VALUE_${i}`, v]])),
      ...(check ? { PGPT_PUSH_NODE: process.execPath, PGPT_PUSH_CHECK: CHECK_FILE, PGPT_PUSH_HIDE: check.hide, PGPT_PUSH_REASON: check.reason } : {}),
    }
    if (body) env.CONTENT_LENGTH = String(body.length)
    else {
      if (req.headers['content-encoding']) env.HTTP_CONTENT_ENCODING = String(req.headers['content-encoding'])
      if (req.headers['content-length'] && !req.headers['transfer-encoding']) env.CONTENT_LENGTH = String(req.headers['content-length'])
    }
    // protocol v0 only (the client's Git-Protocol header is not passed on): under v2 upload-pack hands out any object it holds
    // by id, so hidden sync branches and rolled-back pushes could be fetched by a token that knows an id; v0 serves only the
    // tips it advertises
    const child = spawn('git', ['http-backend'], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let head = Buffer.alloc(0)
    let started = false
    let err = ''
    const finish = () => { if (!started) deny(res, 502, 'git did not answer'); else if (!hold) res.end(); resolve() }
    child.stderr.on('data', (d) => { if (err.length < 4000) err += d })
    child.stdout.on('data', (d) => {
      if (started) { res.write(d); return }
      head = Buffer.concat([head, d])
      const crlf = head.indexOf('\r\n\r\n')
      const lf = head.indexOf('\n\n')
      const end = crlf >= 0 && (lf < 0 || crlf < lf) ? crlf + 4 : lf >= 0 ? lf + 2 : -1
      if (end < 0) { if (head.length > 64 * 1024) { child.kill(); deny(res, 502, 'git sent no header') } return }
      started = true
      let status = 200
      for (const line of head.subarray(0, end).toString('latin1').split(/\r?\n/).filter(Boolean)) {
        const i = line.indexOf(':')
        if (i < 0) continue
        const k = line.slice(0, i).trim()
        const v = line.slice(i + 1).trim()
        if (/^status$/i.test(k)) status = parseInt(v, 10) || 200
        else res.setHeader(k, v)
      }
      res.status(status)
      const rest = head.subarray(end)
      if (rest.length) res.write(rest)
    })
    child.on('error', (e) => { err += e.message; finish() })
    child.on('close', (code) => {
      if (code && err) console.warn(`[folders git] ${folder.id.slice(0, 8)} ${req.method} ${pathInfo}: ${err.trim().slice(0, 300)}`)
      finish()
    })
    // a client that goes away takes git with it
    res.on('close', () => { if (child.exitCode == null) child.kill() })
    child.stdin.on('error', () => {})
    if (body) child.stdin.end(body)
    else req.pipe(child.stdin)
  })
}

// /api/git/<folder id>.git/{info/refs?service=…, git-upload-pack, git-receive-pack}
// Mounted ahead of the session and tenant middleware (index.js): the token is the whole of the auth,
// and the tenant is the token's.
// device: the public path for the desktop app's local agents (/api/local-git — the only git path the public address serves; /api/git
// stays inside the cluster): only a token minted for one job on one linked desktop (scope 'device'), and only while that device is
// linked (not revoked) and the job is its own — check(claims, {push}) says so (lib/localAgents/devices.js gitAccess) — at most
// DEVICE_RATE requests a minute per device. Reads its folder; pushes only to the job's own branch prefix (the token's push).
// The same path takes a desktop's sync token (scope 'sync' — a champion folder its computer uploads, lib/folders/sources.js): one device,
// one folder, no job; check() looks again at the device, the folder's source row and the person's role in the folder on every request
// (devices.js syncAccess), and after() looks at what such a push brought in, still inside the folder's lock (a file that must not be
// there puts the branch back at once).
// The desktops' sync branches of a folder (refs/heads/pgpt-agent/sync-<device 8>/…), as git's hidden-ref entries: git hides whole ref
// path parts, so each device's part is named — those there now and those of every computer bound to the folder (bound before its first
// push: a branch is never there unhidden). A sync token's own device's part is left out. → ['refs/heads/pgpt-agent/sync-…', …]
export const SYNC_PART = `${PUSH_PREFIX}sync-`
const ownPart = (claims) => (claims?.scope === 'sync' && String(claims.push || '').startsWith(SYNC_PART) ? `refs/heads/${String(claims.push).replace(/\/+$/, '')}` : null)
export async function syncHidden(folder, claims) {
  const parts = new Set()
  for (const r of (await G.git(folder.repo_path, ['for-each-ref', '--format=%(refname)', `refs/heads/${PUSH_PREFIX}`])).split('\n')) {
    const m = /^(refs\/heads\/pgpt-agent\/sync-[^/]+)(\/|$)/.exec(r.trim())
    if (m) parts.add(m[1])
  }
  // (before sql/059 there is no such table: no computer is bound anywhere)
  const bound = await q('select device_id::text as d from pro_folder_sources where folder_id=$1', [folder.id]).catch((e) => { if (e.code === '42P01') return []; throw e })
  for (const r of bound) parts.add(`refs/heads/${SYNC_PART}${r.d.slice(0, 8)}`)
  parts.delete(ownPart(claims))
  return [...parts]
}
// The person a desktop job's token works for (its job's person, when the job is of this folder) — null for any other token
export async function personOf(folder, claims) {
  if (claims?.scope !== 'device' || !claims.job) return null
  const [job] = await q('select user_id::text as user_id, folder_id::text as folder_id, chat from pro_local_jobs where id::text=$1', [String(claims.job)]).catch(() => [])
  if (!job?.user_id || String(job.folder_id || job.chat?.folderId || '') !== String(folder.id)) return null
  return job.user_id
}
// Projects' workspaces made from a template (refs/heads/var/t/…, folders/templates.js) are hidden from every token — not listed, not
// fetched, not pushed to. A desktop job's token sees its person's own: their workspaces in this folder and what a computer left of them
// (seats.js leftover) — all of it theirs to read: git's hidden-ref entries are read in order, a later `!ref` shows a ref an earlier entry hid.
export const WORKSPACE_REFS = `refs/heads/${S.WORKSPACE_PREFIX}`
export async function workspaceHidden(folder, claims, person) {
  const out = [WORKSPACE_REFS]
  const who = person === undefined ? await personOf(folder, claims) : person
  if (!who) return out
  const rows = await q(`select branch from pro_folder_variations where folder_id=$1 and source ? 'template' and holder_type='user' and holder_id::text=$2
                        and status not in ('merged','discarded') order by created_at`, [folder.id, String(who)]).catch(() => [])
  for (const r of rows) if (S.isWorkspaceBranch(r.branch)) out.push(`!refs/heads/${r.branch}`)
  return out
}
// The desktops' run branches (lib/localAgents): refs/heads/pgpt-agent/local/<person>/<job 8>-<time> — each holds what its person may read
// and others may not (a project's workspace, folders/templates.js). The whole of pgpt-agent/local/ is hidden from every token but its
// person's own part (one entry each, however many runs there are). Desktops up to 0.2.5 push whatever branch the server names, so every
// run gets the new name; a run that started before it keeps its old one (pgpt-agent/local-<job 8>-…, RUN_PART) until it is brought in —
// those few are named one by one.
export const RUN_DIR = `${PUSH_PREFIX}local/`
export const RUN_PART = `${PUSH_PREFIX}local-`
const personPart = (id) => String(id || '').toLowerCase().replace(/[^0-9a-z-]/g, '').slice(0, 64) || 'someone'
const job8 = (job) => String(job.id).slice(0, 8)
// a job's own run branches (what its token may push) — and the name of a new one, or the one it is resuming
export const runPrefix = (job) => `${RUN_DIR}${personPart(job.user_id)}/${job8(job)}-`
export const legacyRunPrefix = (job) => `${RUN_PART}${job8(job)}-`
export const isRunOf = (job, branch) => { const b = String(branch || ''); return b.startsWith(runPrefix(job)) || b.startsWith(legacyRunPrefix(job)) }
export const runBranchFor = (job, resume = null) => (resume && isRunOf(job, resume) ? resume : `${runPrefix(job)}${Date.now().toString(36)}`)
export const runPushFor = (job, branch) => (String(branch || '').startsWith(legacyRunPrefix(job)) ? legacyRunPrefix(job) : runPrefix(job))
export async function runHidden(folder, claims, person) {
  const who = person === undefined ? await personOf(folder, claims) : person
  const own = claims?.scope === 'device' ? String(claims.push || '') : ''
  const out = [`refs/heads/${RUN_DIR}`]
  if (who) out.push(`!refs/heads/${RUN_DIR}${personPart(who)}`)
  const ownPerson = /^pgpt-agent\/local\/([^/]+)\//.exec(own)
  if (ownPerson && ownPerson[1] !== personPart(who)) out.push(`!refs/heads/${RUN_DIR}${ownPerson[1]}`)
  const legacy = (await G.git(folder.repo_path, ['for-each-ref', '--format=%(refname)', `refs/heads/${PUSH_PREFIX}`], { check: false })).split('\n').map((x) => x.trim())
    .filter((r) => r.startsWith(`refs/heads/${RUN_PART}`))
  if (!legacy.length) return out
  const mine = new Set(who ? (await q(`select left(id::text, 8) as j from pro_local_jobs where user_id::text=$1 and (folder_id::text=$2 or chat->>'folderId'=$2)`, [String(who), folder.id])
    .catch(() => [])).map((r) => r.j) : [])
  for (const r of legacy) {
    const b = r.slice('refs/heads/'.length)
    if ((own.startsWith(RUN_PART) && b.startsWith(own)) || mine.has(b.slice(RUN_PART.length, RUN_PART.length + 8))) continue
    out.push(r)
  }
  return out
}
// everything this token may not see: other desktops' sync branches, other people's runs, workspaces not its person's
export async function hiddenFor(folder, claims) {
  const who = await personOf(folder, claims)
  return [...await syncHidden(folder, claims), ...await runHidden(folder, claims, who), ...await workspaceHidden(folder, claims, who)]
}

// ---------- the pre-receive check (pushCheck.js) ----------
const CHECK_FILE = fileURLToPath(new URL('./pushCheck.js', import.meta.url))
const HOOK = '#!/bin/sh\n# Process GPT Lite: the check of a push over git HTTP (server lib/folders/pushCheck.js)\nexec "$PGPT_PUSH_NODE" "$PGPT_PUSH_CHECK"\n'
const hookDirs = new Map()
// the hook runs (a folder mounted without exec would refuse every push): started once with nothing to check, it must say yes
const runs = (dir) => new Promise((resolve) => {
  const child = spawn(path.join(dir, 'pre-receive'), [], { env: { ...G.gitEnv(), PGPT_PUSH_NODE: process.execPath, PGPT_PUSH_CHECK: CHECK_FILE }, stdio: ['pipe', 'ignore', 'ignore'] })
  child.on('error', () => resolve(false))
  child.on('close', (code) => resolve(code === 0))
  child.stdin.on('error', () => {})
  child.stdin.end()
})
async function writeHook(dir) {
  await fs.mkdir(dir, { recursive: true, mode: 0o755 })
  const file = path.join(dir, 'pre-receive')
  const had = await fs.readFile(file, 'utf8').catch(() => null)
  if (had !== HOOK) { await fs.writeFile(`${file}.tmp`, HOOK, { mode: 0o755 }); await fs.rename(`${file}.tmp`, file) }
  await fs.chmod(file, 0o755)
  return (await runs(dir)) ? dir : null
}
// the hooks folder receive-pack is given (core.hooksPath) — only this pre-receive in it: beside the folders, else in the server's temporary
// folder; when it can run nowhere, pushes fail (nothing is taken unchecked)
export function hooks() {
  const key = S.foldersRoot()
  if (!hookDirs.has(key)) {
    hookDirs.set(key, (async () => {
      const dir = await writeHook(path.join(key, '.hooks')).catch(() => null)
        || await writeHook(await fs.mkdtemp(path.join(os.tmpdir(), 'pgpt-hooks-'))).catch(() => null)
      if (!dir) throw new Error('the push check (pre-receive hook) cannot run here')
      return dir
    })().catch((e) => { hookDirs.delete(key); throw e }))
  }
  return hookDirs.get(key)
}
// the refs of a push that now point where it asked (what a refused push asked for never stands)
export async function stood(folder, commands) {
  const want = commands.filter((c) => !ZERO.test(c.new))
  if (!want.length) return []
  const now = new Map((await G.git(folder.repo_path, ['for-each-ref', '--format=%(objectname) %(refname)', ...new Set(want.map((c) => c.ref))], { check: false }))
    .split('\n').map((l) => l.trim().split(' ')).filter((p) => p.length === 2).map(([o, r]) => [r, o]))
  return want.filter((c) => now.get(c.ref) === c.new)
}
// a push that names another desktop's sync branch (any token but that desktop's own sync token): refused like any other foreign ref
export const syncRefusals = (commands, claims) => {
  const own = ownPart(claims)
  const out = commands.filter((c) => c.ref.startsWith(`refs/heads/${SYNC_PART}`) && !(own && (c.ref === own || c.ref.startsWith(`${own}/`))))
    .map((c) => ({ ref: c.ref, why: 'a desktop\'s sync branch may be pushed only by that desktop' }))
  return out.length ? out : null
}
const DEVICE_RATE = 120
const hits = new Map() // device → [times]
function overRate(device, now = Date.now()) {
  const list = (hits.get(device) || []).filter((t) => now - t < 60_000)
  list.push(now)
  hits.set(device, list)
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < 60_000)) hits.delete(k)
  return list.length > DEVICE_RATE
}
export function gitRoutes({ maxPush = MAX_PUSH, device = false, check = null, after = null } = {}) {
  return async (req, res) => {
    const m = /^\/([0-9a-f-]{36})\.git(\/info\/refs|\/git-upload-pack|\/git-receive-pack)$/.exec(req.path)
    if (!m) return deny(res, 404, 'not found')
    const [, folderId, pathInfo] = m
    const service = pathInfo === '/info/refs' ? String(req.query?.service || '') : pathInfo.slice(1)
    if (!SERVICES.has(service)) return deny(res, 403, 'only the smart protocol is served here')
    if ((pathInfo === '/info/refs') !== (req.method === 'GET')) return deny(res, 405, 'method not allowed')
    const claims = verifyToken(tokenOf(req))
    if (!claims) return deny(res, 401, 'a folder token is needed', { 'WWW-Authenticate': `Basic realm="${REALM}"` })
    if (claims.folder !== folderId) return deny(res, 403, 'this token is for another folder')
    if (!servesTenant(claims.tenant)) return deny(res, 403, 'this server does not serve the token\'s tenant')
    if (device && !(claims.device && ((claims.scope === 'device' && claims.job) || claims.scope === 'sync'))) return deny(res, 403, 'only a linked desktop\'s job or sync token is served here')
    // (a desktop's token — job or sync — only on its own path, where its device, folder and role are checked on every request)
    if (!device && claims.scope) return deny(res, 403, 'a desktop\'s token is not served here')
    if (device && overRate(claims.device)) return deny(res, 429, 'too many requests from this desktop — try again in a minute')
    return withTenant(claims.tenant, async () => {
      try {
        if (device) {
          const why = await (check || (async () => 'no device check'))(claims, { push: service === 'git-receive-pack' })
          if (why) return deny(res, 403, why)
        }
        const [folder] = await q('select * from pro_folders where id=$1 and tenant_id=$2', [folderId, claims.tenant])
        if (!folder) return deny(res, 404, 'no such folder')
        if (folder.kind === 'linked') return deny(res, 403, 'a linked folder is not served over git')
        const hide = await hiddenFor(folder, claims)
        if (service !== 'git-receive-pack' || pathInfo === '/info/refs') return await backend(req, res, folder, pathInfo, null, { hide })
        // a push: which refs it may name is decided here, before git sees it; what it brought, by git's pre-receive check (pushCheck.js)
        const body = await readBody(req, maxPush)
        if (!body) return deny(res, 413, `a push may carry at most ${Math.round(maxPush / 1024 / 1024)} MB`)
        let parsed
        try { parsed = parseCommands(body) } catch (e) { return deny(res, 400, e.message) }
        const refused = refusals(parsed.commands, claims.push) || syncRefusals(parsed.commands, claims)
        if (refused) {
          console.warn(`[folders git] ${folder.slug} push refused: ${refused.map((r) => `${r.ref} (${r.why})`).join(', ')}`)
          // (a client that asked for no status report gets a plain 403)
          if (!parsed.caps.has('report-status') && !parsed.caps.has('report-status-v2')) return deny(res, 403, refused[0].why)
          return res.status(200).set({ 'Content-Type': 'application/x-git-receive-pack-result', 'Cache-Control': 'no-cache' }).end(rejectionReport(parsed.commands, refused, parsed.caps))
        }
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pgpt-push-'))
        try {
          const check = { hooks: await hooks(), hide: path.join(dir, 'hide.json'), reason: path.join(dir, 'reason') }
          await fs.writeFile(check.hide, JSON.stringify(hide), { mode: 0o600 })
          await S.serial(folder.id, async () => {
            await backend(req, res, folder, pathInfo, body, { hold: true, hide, check })
            const why = await fs.readFile(check.reason, 'utf8').catch(() => '')
            if (why) console.warn(`[folders git] ${folder.slug} push refused: ${why}`)
            // (after() sees only the refs that stood — one ref refused by git keeps none of the others from being looked at)
            const done = await stood(folder, parsed.commands)
            if (after && done.length) await after(claims, folder, done).catch((e) => console.warn('[folders git] after push', e.message))
            if (!res.writableEnded) res.end()
            if (done.length) console.log(`[folders git] ${folder.slug} pushed ${done.map((c) => c.ref.replace('refs/heads/', '')).join(', ')}`)
          })
        } finally { await fs.rm(dir, { recursive: true, force: true }).catch(() => {}) }
      } catch (e) {
        console.warn('[folders git]', e.message)
        deny(res, 500, 'git request failed')
      }
    })
  }
}

// the repository a cli-agent step is given (work.js stepOne): with PRO_GIT_URL, the folder over HTTP and a
// token for it; without, the repository's path (local development: cli-agent shares this disk)
export function projectRepoFor(folder, { now = Date.now() } = {}) {
  const base = String(config.gitUrl || '').trim().replace(/\/+$/, '')
  if (!base || folder.kind === 'linked') return { project_repo: folder.repo_path }
  return { project_repo: `${base}/api/git/${folder.id}.git`, project_repo_token: mintToken({ tenant: config.tenantId, folderId: folder.id, now }) }
}
