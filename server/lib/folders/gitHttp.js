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
import { q } from '../supa.js'
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
// "pgf1.<payload>.<signature>", both base64url; payload {tenant, folder, push, exp (seconds)}
const key = () => {
  if (!config.serviceKey) throw new Error('folder git tokens need SERVICE_ROLE_KEY')
  return crypto.createHmac('sha256', String(config.serviceKey)).update('folder-git:v1').digest()
}
const sign = (body) => crypto.createHmac('sha256', key()).update(`pgf1.${body}`).digest('base64url')

export function mintToken({ tenant = config.tenantId, folderId, push = PUSH_PREFIX, hours = TOKEN_HOURS(), now = Date.now() } = {}) {
  if (!folderId) throw new Error('a folder git token names its folder')
  const body = Buffer.from(JSON.stringify({ tenant, folder: String(folderId), push, exp: Math.floor(now / 1000 + hours * 3600) })).toString('base64url')
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
// the rest streams through. `body`: a Buffer already read, else the request streams into it.
function backend(req, res, folder, pathInfo, body) {
  return new Promise((resolve) => {
    const cfg = [
      ['http.receivepack', 'true'], // the token stands for REMOTE_USER: pushing is allowed, within refusals() above
      ['receive.denyDeletes', 'true'],
      ['receive.fsckObjects', 'true'],
      ['receive.autogc', 'false'], // no gc after a push either: the nightly pass packs (gc.js)
      ['gc.auto', '0'],
      ['core.hooksPath', '/dev/null'],
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
    if (req.headers['git-protocol']) env.GIT_PROTOCOL = String(req.headers['git-protocol'])
    const child = spawn('git', ['http-backend'], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let head = Buffer.alloc(0)
    let started = false
    let err = ''
    const finish = () => { if (!started) deny(res, 502, 'git did not answer'); else res.end(); resolve() }
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
export function gitRoutes({ maxPush = MAX_PUSH } = {}) {
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
    return withTenant(claims.tenant, async () => {
      try {
        const [folder] = await q('select * from pro_folders where id=$1 and tenant_id=$2', [folderId, claims.tenant])
        if (!folder) return deny(res, 404, 'no such folder')
        if (folder.kind === 'linked') return deny(res, 403, 'a linked folder is not served over git')
        if (service !== 'git-receive-pack' || pathInfo === '/info/refs') return await backend(req, res, folder, pathInfo)
        // a push: what it would change is decided here, before git sees it
        const body = await readBody(req, maxPush)
        if (!body) return deny(res, 413, `a push may carry at most ${Math.round(maxPush / 1024 / 1024)} MB`)
        let parsed
        try { parsed = parseCommands(body) } catch (e) { return deny(res, 400, e.message) }
        const refused = refusals(parsed.commands, claims.push)
        if (refused) {
          console.warn(`[folders git] ${folder.slug} push refused: ${refused.map((r) => `${r.ref} (${r.why})`).join(', ')}`)
          // (a client that asked for no status report gets a plain 403)
          if (!parsed.caps.has('report-status') && !parsed.caps.has('report-status-v2')) return deny(res, 403, refused[0].why)
          return res.status(200).set({ 'Content-Type': 'application/x-git-receive-pack-result', 'Cache-Control': 'no-cache' }).end(rejectionReport(parsed.commands, refused, parsed.caps))
        }
        await S.serial(folder.id, () => backend(req, res, folder, pathInfo, body))
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
export function projectRepoFor(folder, { now = Date.now() } = {}) {
  const base = String(config.gitUrl || '').trim().replace(/\/+$/, '')
  if (!base || folder.kind === 'linked') return { project_repo: folder.repo_path }
  return { project_repo: `${base}/api/git/${folder.id}.git`, project_repo_token: mintToken({ tenant: config.tenantId, folderId: folder.id, now }) }
}
