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
// Only this server runs git on the repository; agents only send and receive objects.
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { spawn } from 'node:child_process'
import { config } from '../../config.js'
import { q, isMember } from '../supa.js'
import { withTenant, servesTenant } from '../tenant.js'
import * as G from './git.js'
import * as S from './service.js'

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

// user: the person the token works for (a step's assignee) — each request checks they are still an approved member of the tenant
export function mintToken({ tenant = config.tenantId, folderId, push = PUSH_PREFIX, hours = TOKEN_HOURS(), now = Date.now(), scope = null, device = null, job = null, user = null } = {}) {
  if (!folderId) throw new Error('a folder git token names its folder')
  const extra = { ...(scope ? { scope: String(scope), device: String(device || ''), job: String(job || '') } : {}),
    ...(/^[0-9a-f-]{36}$/i.test(String(user || '')) ? { user: String(user) } : {}) }
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
// a flush, then (push options and) the pack. → {commands: [{old, new, ref}], caps: Set} or throws
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
// (the caller ends it — after() has looked at the push first, so the client's push is over only then)
function backend(req, res, folder, pathInfo, body, { hold = false, hide = [] } = {}) {
  return new Promise((resolve) => {
    const cfg = [
      ['http.receivepack', 'true'], // the token stands for REMOTE_USER: pushing is allowed, within refusals() above
      ['receive.denyDeletes', 'true'],
      ['receive.fsckObjects', 'true'],
      ['receive.autogc', 'false'], // no gc after a push either: the nightly pass packs (gc.js)
      ['gc.auto', '0'],
      ['core.hooksPath', '/dev/null'],
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
    // the person it works for, still an approved member — a membership that ended (「내보내기」) ends the token too (lib/membership.js)
    if (claims.user && !(await isMember(claims.user, claims.tenant))) return deny(res, 403, 'the token\'s person is not a member of this company any more')
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
        const hide = await syncHidden(folder, claims)
        if (service !== 'git-receive-pack' || pathInfo === '/info/refs') return await backend(req, res, folder, pathInfo, null, { hide })
        // a push: what it would change is decided here, before git sees it
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
        await S.serial(folder.id, async () => {
          await backend(req, res, folder, pathInfo, body, { hold: !!after, hide })
          if (after) {
            await after(claims, folder, parsed.commands).catch((e) => console.warn('[folders git] after push', e.message))
            if (!res.writableEnded) res.end()
          }
        })
        console.log(`[folders git] ${folder.slug} pushed ${parsed.commands.map((c) => c.ref.replace('refs/heads/', '')).join(', ')}`)
      } catch (e) {
        console.warn('[folders git]', e.message)
        deny(res, 500, 'git request failed')
      }
    })
  }
}

// the repository a cli-agent step is given (work.js stepOne): with PRO_GIT_URL, the folder over HTTP and a
// token for it; without, the repository's path (local development: cli-agent shares this disk)
export function projectRepoFor(folder, { now = Date.now(), user = null } = {}) {
  const base = String(config.gitUrl || '').trim().replace(/\/+$/, '')
  if (!base || folder.kind === 'linked') return { project_repo: folder.repo_path }
  return { project_repo: `${base}/api/git/${folder.id}.git`, project_repo_token: mintToken({ tenant: config.tenantId, folderId: folder.id, now, user }) }
}
