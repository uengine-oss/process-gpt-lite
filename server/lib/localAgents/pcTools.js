// A person's own CLI proposes a skill or a folder of their PC — 「스킬을 등록할까요?」 · 「폴더를 올릴까요?」 (design docs/local-agents/design.md
// §13, spec openspec/specs/local-agents · champion-folders). The user's words (2026-11-27): 「그냥 채팅의 대화로 로컬 에이전트를 선택하여 내 pc 에
// 있는 스킬중 어떤 스킬을 등록해줘라고 하면 서버에 스킬을 등록한다.. 그러려면 로컬 에이전트쪽에 process gpt 의 mcp나 api 가 등록되긴해야할것」 ·
// 「폴더 등록 또한 채팅으로 시킬 수 있겠지」.
// The desktop app (0.2.8 — caps liteTools) gives a chat run's CLI an MCP server of its own (desktop/src/mcp · runner/tools.js). It reads the
// PC's files itself and calls this server with the run's TOOL TOKEN — minted for that run alone in its job (chat.js prepare): this person,
// this device, this chat job, while the job is on (offered · running), 90 minutes at most. With it the app may only list the person's skills
// and folders and make a PROPOSAL. A proposal is the person's alone: a card in the chat of that run; nothing is registered or uploaded until
// they press its button (only they can — someone else's card is 404). It goes away after an hour.
//   skill   — the files come here (checked again: their paths, the secrets' names, the keys of a sure shape, the size, a SKILL.md at the top;
//             the run settings in it read here, not taken from the app) and wait in a place of the server's own (<folders>/.pc-proposals/<id>).
//             「등록」 → the person's own skill (folders/skills.js saveDraftPrivate — the skill-creator's road), or 「회사 스킬」 — installed for
//             everyone (skills.js share), by the existing rule: a skill's author may share it, and the person registering it is its author;
//             once more confirmed when it has run settings.
//   folder  — only the app's preview comes here (no path: the folder's name on the PC). 「올리기」 → the Lite folder is made as the page makes a
//             champion folder (service.createFolder champion), and the app that proposed it is asked over its link (tools:upload) to bind
//             and upload it with the champion folders' own engine (desktop sync.js FolderSync.bind); its answer (tools:uploaded) finishes the
//             card — or, when nothing went up, the empty folder goes away again and the card can be pressed again.
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { config } from '../../config.js'
import { q } from '../supa.js'
import { emit } from '../bus.js'
import { L, withLang, langOf } from '../lang.js'
import * as H from './hub.js'
// (a failure says what failed, never where on the server — the folder screen's own rule: the folders' roots, then any path, by its name)
const hidePaths = async (m) => (await import('../../routes/folders.js')).hidePaths(m)

const T = () => config.tenantId
const err = (status, message, code = null) => Object.assign(new Error(message), { status, ...(code ? { code } : {}) })
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const TOKEN_MINUTES = 90
export const PROPOSAL_MINUTES = 60
export const PENDING_MAX = 10
// a skill's size (the desktop's runner/tools.js — the same)
export const SKILL_MAX_FILES = 300
export const SKILL_MAX_BYTES = 8 * 1024 * 1024
const KINDS = ['skill', 'folder']
const CONTROL = ['gitignore', 'gitattributes', 'gitmodules', 'lfsconfig']
const clean = (s, n = 200) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n)

// ---------- the run's tool token ----------
// "plt1.<payload>.<signature>": {tenant, user, device, job, exp} — a key of its own derived from the service key
const key = () => {
  if (!config.serviceKey) throw new Error('tool tokens need SERVICE_ROLE_KEY')
  return crypto.createHmac('sha256', String(config.serviceKey)).update('pc-tools:v1').digest()
}
const sign = (body) => crypto.createHmac('sha256', key()).update(`plt1.${body}`).digest('base64url')
export function mintToken({ tenant = T(), user, device, job, minutes = TOKEN_MINUTES, now = Date.now() } = {}) {
  if (!UUID.test(String(user)) || !UUID.test(String(device)) || !UUID.test(String(job))) throw new Error('a tool token names its person, device and job')
  const body = Buffer.from(JSON.stringify({ tenant, user: String(user), device: String(device), job: String(job), scope: 'pc-tools', exp: Math.floor(now / 1000 + minutes * 60) })).toString('base64url')
  return `plt1.${body}.${sign(body)}`
}
// the claims, or null (malformed, forged, expired, another kind)
export function verifyToken(token, { now = Date.now() } = {}) {
  const m = /^plt1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(String(token || '').trim())
  if (!m) return null
  let want
  try { want = Buffer.from(sign(m[1]), 'base64url') } catch { return null }
  const got = Buffer.from(m[2], 'base64url')
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null
  let c
  try { c = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8')) } catch { return null }
  if (!c || c.scope !== 'pc-tools' || typeof c.tenant !== 'string' || ![c.user, c.device, c.job].every((x) => UUID.test(String(x))) || !Number.isFinite(c.exp)) return null
  if (c.exp * 1000 <= now) return null
  return c
}
// Checked on every request, so a token still in its time stops at once when any of this changes: the device is linked (not revoked) and the
// person's, the job is that device's chat run of that person and is on now → {user, device, job}
export async function access(claims) {
  const [d] = await q('select id, user_id, revoked_at, name from pro_local_devices where id=$1 and tenant_id=$2', [claims.device, claims.tenant])
  if (!d || d.revoked_at || String(d.user_id) !== claims.user) throw err(403, 'this desktop is not linked any more', 'device')
  const [j] = await q('select * from pro_local_jobs where id=$1 and tenant_id=$2', [claims.job, claims.tenant])
  if (!j || j.kind !== 'chat' || String(j.user_id) !== claims.user || String(j.device_id || '') !== claims.device) throw err(403, 'this token is not for a chat run of this desktop', 'job')
  if (!['offered', 'running'].includes(j.state)) throw err(403, 'this chat run is over — the tools close with it', 'job_over')
  const [p] = await q('select name, email from pro_profile where user_id::text=$1', [claims.user])
  return { user: { id: claims.user, name: p?.name || p?.email || '', email: p?.email || '' }, device: d, job: j }
}

// ---------- read-only lists ----------
export async function mySkills(ctx) {
  const SK = await import('../folders/skills.js')
  const list = await SK.listSkills(ctx.user)
  return { skills: list.slice(0, 300).map((s) => ({ name: s.name, where: s.visibility === 'private' ? 'mine (private)' : 'company', mine: !!s.mine, description: s.folder?.description || '' })) }
}
export async function myFolders(ctx) {
  const S = await import('../folders/service.js')
  const list = await S.listFolders(ctx.user)
  return { folders: list.slice(0, 300).map((f) => ({ name: f.name, role: f.role, kind: f.kind, fromPc: !!f.settings?.champion, agentAssets: f.kit || null })) }
}

// ---------- what a proposal carries ----------
// a skill's name: letters, digits, '-' and '_' (a space becomes '-'), 64 at most — the folder name runs read it by
export function skillName(v) {
  const n = String(v ?? '').normalize('NFC').trim().replace(/\s+/g, '-').slice(0, 64)
  return /^[\p{L}\p{N}][\p{L}\p{N}_-]*$/u.test(n) ? n : null
}
// a path inside the proposal: '/' between names, none empty, '.', '..' or .git, no backslash or NUL, 512 bytes at most
export function safeRel(rel) {
  const r = String(rel ?? '').normalize('NFC')
  if (!r || Buffer.byteLength(r) > 512 || /[\\\0]/.test(r) || r.startsWith('/')) return null
  const segs = r.split('/')
  if (segs.some((s) => !s || s === '.' || s === '..' || s.toLowerCase() === '.git')) return null
  return r
}
const GROUPS = ['gitignore', 'secret', 'personal', 'rebuildable', 'large', 'structure']
const WARNINGS = ['own_git', 'empty', 'too_big', 'too_many']
const int = (v, max = Number.MAX_SAFE_INTEGER) => Math.max(0, Math.min(max, Math.floor(Number(v) || 0)))
const strs = (a, n, len = 200) => (Array.isArray(a) ? a.slice(0, n).map((x) => clean(x, len)).filter(Boolean) : [])
// what the app left out, by group (its preview) — only the known groups, a few samples each
const excludedOf = (a) => (Array.isArray(a) ? a : []).filter((g) => GROUPS.includes(g?.group)).slice(0, GROUPS.length)
  .map((g) => ({ group: g.group, count: int(g.count), samples: strs(g.samples, 5) }))
// a folder's preview as the champion folders' sheet shows it (desktop sync.js scan → preview) — only its known fields, bounded
export function previewOf(p = {}) {
  return {
    files: int(p.files), bytes: int(p.bytes),
    top: (Array.isArray(p.top) ? p.top : []).slice(0, 40).map((t) => ({ path: clean(t?.path, 300), files: int(t?.files), bytes: int(t?.bytes) })).filter((t) => t.path),
    excluded: excludedOf(p.excluded),
    flagged: (Array.isArray(p.flagged) ? p.flagged : []).slice(0, 200).map((f) => ({ path: clean(f?.path, 300), line: int(f?.line, 1e7) || null, reason: clean(f?.reason, 40), level: f?.level === 'block' ? 'block' : 'check' })).filter((f) => f.path),
    kit: (Array.isArray(p.kit) ? p.kit : []).slice(0, 300).map((k) => ({ platform: clean(k?.platform, 20), type: clean(k?.type, 20), path: clean(k?.path, 300), name: clean(k?.name, 120), description: clean(k?.description, 300), runs: !!k?.runs })).filter((k) => k.path),
    warnings: strs(p.warnings, 8, 20).filter((w) => WARNINGS.includes(w)),
  }
}

// ---------- proposals ----------
const stageRoot = async () => path.join((await import('../folders/service.js')).foldersRoot(), '.pc-proposals')
const stageDir = async (id) => path.join(await stageRoot(), String(id))
const unstage = async (id) => fs.rm(await stageDir(id), { recursive: true, force: true }).catch(() => {})
// proposals past their hour: expired (their files go) — on each new proposal and each look at one
export async function sweep(userId = null) {
  const gone = await q(`update pro_pc_proposals set state='expired' where tenant_id=$1 and state='pending' and expires_at < now() ${userId ? 'and user_id=$2' : ''} returning *`, userId ? [T(), userId] : [T()])
  for (const p of gone) { if (p.kind === 'skill') await unstage(p.id); await noteCard(p).catch(() => {}) }
  return gone.length
}
// one proposal at a time per person on this server (the count of waiting ones and the new one's insert together — no database lock: a
// lock held over the shared pool waits on the pool itself, #118)
const chains = new Map()
function oneAtATime(userId, fn) {
  const k = `${T()}:${userId}`
  const run = (chains.get(k) || Promise.resolve()).catch(() => {}).then(fn)
  const tail = run.catch(() => {})
  chains.set(k, tail)
  tail.then(() => { if (chains.get(k) === tail) chains.delete(k) })
  return run
}
// Now and then (the server's background — not with PRO_BACKGROUND=0): every company's proposals past their hour expire; a skill's files go
// as soon as its proposal is no longer waiting (registered, dropped, expired, failed) — and whatever else is left in the staging place (a
// proposal deleted, a server stopped midway); a press that has waited for two hours without an end is ended (its files go)
export async function sweepAll() {
  await sweep()
  const stale = await q(`select * from pro_pc_proposals where tenant_id=$1 and state='working' and decided_at < now() - interval '2 hours'`, [T()])
  for (const p of stale) {
    if (p.kind === 'folder') await settleUpload(p, { ok: false, why: 'pc_offline' }).catch(() => {})
    else await setState(p, ['working'], { state: 'failed', error: 'timeout' }).catch(() => {})
  }
  let ids = []
  try { ids = await fs.readdir(await stageRoot()) } catch { return }
  const live = new Set((await q(`select id::text from pro_pc_proposals where tenant_id=$1 and kind='skill' and state in ('pending','working')`, [T()])).map((r) => r.id))
  for (const id of ids) if (!live.has(id)) await unstage(id)
}
let sweeper = null
export function startSweeper(forEachTenant, { everyMs = 10 * 60_000 } = {}) {
  if (sweeper) return
  const run = () => forEachTenant(() => sweepAll(), 'pc-tools sweep').catch((e) => console.warn('[pc-tools] sweep', e.message))
  sweeper = setInterval(run, everyMs)
  sweeper.unref?.()
  run()
}
async function limit(ctx) {
  await sweep(ctx.user.id)
  const [{ n }] = await q(`select count(*)::int as n from pro_pc_proposals where tenant_id=$1 and user_id=$2 and state='pending'`, [T(), ctx.user.id])
  if (n >= PENDING_MAX) throw err(429, L(`확인을 기다리는 제안이 이미 ${n}개예요 — 사용자에게 채팅의 카드를 먼저 정리해 달라고 요청해 주세요.`, `${n} proposals already wait for the person — ask them to deal with the cards in the chat first.`), 'too_many_pending')
}
// the card in the run's chat (in its conversation, when the run is of one)
async function card(ctx, row) {
  const c = ctx.job.chat || {}
  const content = { ...cardContent(row), ...(c.conv ? { conv: c.conv } : {}) }
  const [m] = await q(`insert into pro_messages(thread_id, role, kind, content) values ($1,'agent','pc_proposal',$2) returning *`, [ctx.job.thread_id, content])
  await q('update pro_threads set updated_at=now() where id=$1', [ctx.job.thread_id])
  await q('update pro_pc_proposals set message_id=$2 where id=$1', [row.id, m.id])
  emit(String(row.user_id), 'message', m)
  return m
}
// what the card's message keeps (the card reads the rest — GET /pc-proposals/:id)
function cardContent(row) {
  const s = row.summary || {}
  const text = row.kind === 'skill' ? L(`스킬을 등록할까요? · ${row.name}`, `Register this skill? · ${row.name}`) : L(`폴더를 올릴까요? · ${row.name}`, `Upload this folder? · ${row.name}`)
  return { text, owner: String(row.user_id), pc: { id: row.id, kind: row.kind, state: row.state, name: row.name, files: s.files ?? s.preview?.files ?? null, bytes: s.bytes ?? s.preview?.bytes ?? null, result: row.result || null, error: row.error || null } }
}
async function noteCard(row) {
  if (!row.message_id) return
  const [m] = await q(`update pro_messages set content = content || $2::jsonb where id=$1 returning *`, [row.message_id, JSON.stringify(await withLang(await langOf(String(row.user_id)).catch(() => 'ko'), () => cardContent(row)))])
  if (m) emit(String(row.user_id), 'message', m)
}

// POST /api/local-agents/tools/skills/propose {name, description, scope, source:{where, label}, files:[{path, size, data}], summary}
export async function proposeSkill(ctx, body = {}) { return oneAtATime(ctx.user.id, () => proposeSkillNow(ctx, body)) }
async function proposeSkillNow(ctx, body) {
  await limit(ctx)
  const SK = await import('../folders/skills.js')
  const SEC = await import('../folders/secrets.js')
  const KIT = await import('../folders/kit.js')
  const { RUN_SETTINGS } = await import('./chat.js')
  const name = skillName(body.name)
  if (!name) throw err(400, L('스킬 이름은 글자 · 숫자 · - · _ 로 64자까지 쓸 수 있어요 — 사용자에게 이름을 물어보고 name 에 넣어 다시 요청해 주세요.', 'A skill name is letters, digits, - and _, 64 at most — ask the person for a name and call again with name.'), 'bad_name')
  if (await SK.visibility(name)) throw err(409, L(`「${name}」라는 스킬이 이미 있어요 — 사용자에게 다른 이름을 물어보고 name 에 넣어 다시 요청해 주세요.`, `A skill named "${name}" already exists — ask the person for another name and call again with name.`), 'name_taken')
  const list = Array.isArray(body.files) ? body.files : []
  if (list.length > SKILL_MAX_FILES) throw err(413, L(`스킬로 올리기에는 파일이 너무 많아요(${SKILL_MAX_FILES}개까지).`, `Too many files for a skill (${SKILL_MAX_FILES} at most).`), 'too_many')
  const files = []
  const seen = new Set()
  let bytes = 0
  const refused = []
  const dropped = []
  for (const f of list) {
    const rel = safeRel(f?.path)
    if (!rel || seen.has(rel.toLowerCase())) throw err(400, L('스킬 안의 파일 경로가 올바르지 않아요.', 'A file path in the skill is not valid.'), 'bad_path')
    seen.add(rel.toLowerCase())
    const buf = Buffer.from(String(f?.data || ''), 'base64')
    bytes += buf.length
    if (bytes > SKILL_MAX_BYTES) throw err(413, L('스킬로 올리기에는 너무 커요(8 MB까지).', 'Too big for a skill (8 MB at most).'), 'too_big')
    // (looked at again here: a secret's name, a key of a sure shape — the app should have left them out; git's own control files
    // (.gitignore · .gitattributes · .gitmodules · .lfsconfig) are only left out — the skill's folder here is the server's own repository)
    const why = SEC.refusalOf(rel, buf)
    if (why && CONTROL.includes(why.reason)) { dropped.push(rel); continue }
    if (why) { refused.push({ path: rel, ...why }); continue }
    files.push({ path: rel, buf })
  }
  if (refused.length) throw err(422, L(`비밀 정보가 담겼거나 따로 관리하는 파일이 있어 받지 않았어요: ${refused.slice(0, 5).map((r) => r.path).join(', ')}`, `Not taken: it holds secret or control files — ${refused.slice(0, 5).map((r) => r.path).join(', ')}`), 'refused')
  const md = files.find((f) => f.path === 'SKILL.md')
  if (!md) throw err(400, L('맨 위에 SKILL.md 가 없어서 스킬이 아니에요.', 'There is no SKILL.md at the top, so it is not a skill.'), 'no_skill_md')
  // what would run on the computer of whoever uses it, and what the skill says it is — read here from its SKILL.md
  const text = md.buf.toString('utf8')
  const { summarizeSkill } = await import('../skills.js')
  const fm = summarizeSkill(text.slice(0, 64 * 1024).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n'))
  const runs = KIT.frontRuns(text.slice(0, 1024 * 1024), { truncated: md.buf.length > 1024 * 1024 })
  const fold = (p) => p.split('/').map((n) => n.toLowerCase().replace(/[. ]+$/, '')).join('/')
  const runFiles = files.map((f) => f.path).filter((p) => RUN_SETTINGS.some((x) => fold(p) === x || fold(p).endsWith(`/${x}`)))
  const s = body.summary || {}
  const where = ['claude', 'codex', 'agents', 'work', 'other'].includes(body.source?.where) ? body.source.where : 'other'
  const excluded = excludedOf(s.excluded)
  if (dropped.length) {
    const g = excluded.find((x) => x.group === 'structure') || (excluded.push({ group: 'structure', count: 0, samples: [] }), excluded.at(-1))
    g.count += dropped.length
    g.samples = [...g.samples, ...dropped].slice(0, 5)
  }
  const summary = { files: files.length, bytes, runs, runFiles, excluded, flagged: int(s.flagged, 1e6), warnings: strs(s.warnings, 8, 20).filter((w) => WARNINGS.includes(w)),
    source: { where, label: clean(body.source?.label, 120) }, list: files.slice(0, 60).map((f) => ({ path: f.path, size: f.buf.length })), more: Math.max(0, files.length - 60) }
  const id = crypto.randomUUID()
  const dir = await stageDir(id)
  try {
    for (const f of files) {
      const to = path.join(dir, ...f.path.split('/'))
      await fs.mkdir(path.dirname(to), { recursive: true })
      await fs.writeFile(to, f.buf)
    }
  } catch (e) { await unstage(id); throw e }
  const [row] = await q(`insert into pro_pc_proposals (id, tenant_id, user_id, kind, device_id, job_id, thread_id, name, description, scope, summary, expires_at)
                         values ($1,$2,$3,'skill',$4,$5,$6,$7,$8,$9,$10, now() + make_interval(mins => $11)) returning *`,
  [id, T(), ctx.user.id, ctx.device.id, ctx.job.id, ctx.job.thread_id, name, clean(fm.description, 1000), body.scope === 'company' ? 'company' : 'mine', summary, PROPOSAL_MINUTES])
  await card(ctx, row)
  console.log(`[pc-tools] skill proposal ${id.slice(0, 8)} '${name}' user=${ctx.user.id.slice(0, 8)} files=${files.length}${runs.length || runFiles.length ? ' runs' : ''}`)
  return { id, name, state: 'pending', expiresInMinutes: PROPOSAL_MINUTES }
}

// POST /api/local-agents/tools/folders/propose {pickId, label, name, preview}
export async function proposeFolder(ctx, body = {}) { return oneAtATime(ctx.user.id, () => proposeFolderNow(ctx, body)) }
async function proposeFolderNow(ctx, body) {
  await limit(ctx)
  const link = H.linkOf(T(), String(ctx.device.id))
  if (!link?.caps?.liteFolders) throw err(409, L('이 PC 앱은 지금 폴더를 올릴 수 없어요.', 'This desktop app cannot upload folders now.'), 'folders_off')
  if (!UUID.test(String(body.pickId || ''))) throw err(400, 'pickId', 'bad_pick')
  const preview = previewOf(body.preview)
  if (!preview.files || preview.warnings.includes('empty')) throw err(400, L('올릴 파일이 없어요.', 'There is nothing to upload.'), 'empty')
  for (const w of ['too_big', 'too_many']) if (preview.warnings.includes(w)) throw err(413, L('챔피언 폴더 한도(200 MB · 2만 개)를 넘어요.', 'It is over the folder limits (200 MB, 20,000 files).'), w)
  const label = clean(body.label, 120)
  const name = clean(body.name || label, 80)
  if (!name) throw err(400, L('폴더 이름이 없어요.', 'The folder has no name.'), 'bad_name')
  const [row] = await q(`insert into pro_pc_proposals (tenant_id, user_id, kind, device_id, job_id, thread_id, name, pick_id, summary, expires_at)
                         values ($1,$2,'folder',$3,$4,$5,$6,$7,$8, now() + make_interval(mins => $9)) returning *`,
  [T(), ctx.user.id, ctx.device.id, ctx.job.id, ctx.job.thread_id, name, String(body.pickId), { label, preview, device: clean(ctx.device.name, 80) }, PROPOSAL_MINUTES])
  await card(ctx, row)
  console.log(`[pc-tools] folder proposal ${row.id.slice(0, 8)} '${name}' user=${ctx.user.id.slice(0, 8)} files=${preview.files}`)
  return { id: row.id, name, state: 'pending', expiresInMinutes: PROPOSAL_MINUTES }
}

// ---------- the card ----------
async function own(user, id) {
  if (!UUID.test(String(id))) throw err(404, L('제안을 찾지 못했어요.', "Couldn't find the proposal."))
  const [row] = await q('select * from pro_pc_proposals where id=$1 and tenant_id=$2', [String(id), T()])
  // (only its person's: someone else's — even in a room they share — is not found)
  if (!row || String(row.user_id) !== String(user.id)) throw err(404, L('제안을 찾지 못했어요.', "Couldn't find the proposal."))
  return row
}
async function current(row) {
  if (row.state === 'pending' && new Date(row.expires_at).getTime() < Date.now()) { await sweep(String(row.user_id)); return (await q('select * from pro_pc_proposals where id=$1', [row.id]))[0] }
  // (an upload whose PC went away before it answered — gone for a minute, or back on a new link since the press, which never answers that
  // press: back to the card, or done when the folder got its files after all)
  if (row.kind === 'folder' && row.state === 'working') {
    const link = H.linkOf(T(), String(row.device_id))
    const pressed = new Date(row.decided_at || row.created_at).getTime()
    if ((!link && Date.now() - pressed > 60_000) || (link && new Date(link.since).getTime() > pressed)) return settleUpload(row, { ok: false, why: 'pc_offline' })
  }
  return row
}
// A confirmation bound to exactly what the card shows (name, kind, what goes up, run settings, where it may go): 「등록」 · 「올리기」 must bring
// it back; a card changed since, or one shown more than 15 minutes ago, is refused (409 stale) and shown again
const SECRET = crypto.randomBytes(32)
const CONFIRM_MS = 15 * 60_000
const hashOf = (row, extra) => crypto.createHash('sha256').update(JSON.stringify([row.id, row.kind, row.name, row.summary, row.state, extra])).digest('hex')
const mac = (userId, h, at) => crypto.createHmac('sha256', SECRET).update(`${userId}:${h}:${at}`).digest('base64url')
export const confirmFor = (userId, row, extra, at = Date.now()) => `${at}.${mac(userId, hashOf(row, extra), at)}`
export function confirmOk(userId, row, extra, token, now = Date.now()) {
  const [at, m] = String(token || '').split('.')
  const t = Number(at)
  if (!t || !m || now - t > CONFIRM_MS || t > now + 60_000) return false
  const want = Buffer.from(mac(userId, hashOf(row, extra), t)), got = Buffer.from(m)
  return want.length === got.length && crypto.timingSafeEqual(want, got)
}
// what may be chosen on a skill's card: 「내 스킬」, and 「회사 스킬」 (installed for everyone's agents) by the rule of the skill folder's own
// 「전사에 공유」 — its author may share it (folders/skills.js share), and whoever registers it here is its author
const optionsOf = async (user, row) => (row.kind === 'skill' ? { company: true } : {})
async function nameTaken(row, name = row.name) {
  if (row.kind === 'skill') return !!(await (await import('../folders/skills.js')).visibility(name))
  return (await q('select 1 from pro_folders where tenant_id=$1 and name=$2', [T(), name])).length > 0
}
async function viewOf(user, row) {
  const options = await optionsOf(user, row)
  const s = row.summary || {}
  return {
    id: row.id, kind: row.kind, state: row.state, name: row.name, description: row.description || '', scope: row.scope || 'mine',
    ...(row.kind === 'skill'
      ? { files: s.files, bytes: s.bytes, list: s.list || [], more: s.more || 0, excluded: s.excluded || [], flagged: s.flagged || 0, runs: s.runs || [], runFiles: s.runFiles || [], warnings: s.warnings || [], source: s.source || {} }
      : { label: s.label || '', device: s.device || '', preview: s.preview || {} }),
    options, nameTaken: row.state === 'pending' ? await nameTaken(row) : false,
    expiresAt: row.expires_at, result: row.result || null, error: row.error || null,
    pcOnline: row.kind === 'folder' ? !!H.linkOf(T(), String(row.device_id)) : undefined,
    confirm: row.state === 'pending' ? confirmFor(String(user.id), row, options) : null,
  }
}
export async function view(user, id) { return viewOf(user, await current(await own(user, id))) }

async function setState(row, from, patch) {
  const sets = Object.keys(patch).map((k, i) => `${k}=$${i + 3}`).join(', ')
  const [x] = await q(`update pro_pc_proposals set ${sets} where id=$1 and state = any($2::text[]) returning *`, [row.id, from, ...Object.values(patch).map((v) => (v && typeof v === 'object' ? JSON.stringify(v) : v))])
  if (x) await noteCard(x)
  return x || null
}
function open(row) {
  if (row.state === 'expired') throw err(409, L('한 시간이 지나 제안이 만료됐어요 — 채팅에서 다시 부탁해 주세요.', 'This proposal ran out after an hour — ask again in the chat.'), 'expired')
  if (row.state === 'working') throw err(409, L('이미 처리하는 중이에요.', 'This is already being done.'), 'already')
  if (row.state !== 'pending') throw err(409, L('이미 끝난 제안이에요.', 'This proposal is already closed.'), 'closed')
}

// POST /api/pc-proposals/:id/register {scope, confirm, companyOk, name} — 「등록」 (「회사 스킬」: companyOk — the card's second check, always;
// with run settings it says so)
export async function register(user, id, { scope = 'mine', confirm, companyOk = false, name = null, jwt = null } = {}) {
  let row = await current(await own(user, id))
  if (row.kind !== 'skill') throw err(400, L('스킬 제안이 아니에요.', 'This is not a skill proposal.'))
  open(row)
  const options = await optionsOf(user, row)
  if (!confirmOk(String(user.id), row, options, confirm)) throw err(409, L('카드 내용이 바뀌었거나 오래됐어요. 카드를 다시 확인하고 눌러 주세요.', 'The card changed or was shown too long ago. Check it again and press it.'), 'stale')
  const company = scope === 'company'
  if (company && !options.company) throw err(403, L('이 스킬은 회사 스킬로 등록할 수 없어요. 「내 스킬」로 등록해 주세요.', "This skill can't be registered as a company skill — register it as yours."), 'not_allowed')
  const s = row.summary || {}
  const runs = (s.runs || []).length + (s.runFiles || []).length > 0
  if (company && companyOk !== true) {
    throw runs ? err(409, L('실행 설정이 있는 스킬을 회사 스킬로 등록하려면 한 번 더 확인해 주세요.', 'A skill with run settings needs one more confirmation to become a company skill.'), 'runs_confirm')
      : err(409, L('회사 스킬로 등록하려면 한 번 더 확인해 주세요.', 'A company skill needs one more confirmation.'), 'company_confirm')
  }
  const want = name != null && String(name).trim() ? skillName(name) : row.name
  if (!want) throw err(400, L('스킬 이름은 글자 · 숫자 · - · _ 로 64자까지예요.', 'A skill name is letters, digits, - and _, 64 at most.'), 'bad_name')
  if (await nameTaken(row, want)) throw err(409, L(`「${want}」라는 스킬이 이미 있어요 — 다른 이름을 적어 주세요.`, `A skill named "${want}" already exists — write another name.`), 'name_taken')
  // (one press: the proposal is claimed before anything is made)
  row = await setState(row, ['pending'], { state: 'working', decided_at: new Date().toISOString(), name: want, scope: company ? 'company' : 'mine', error: null })
  if (!row) throw err(409, L('이미 처리하는 중이거나 끝난 제안이에요.', 'This proposal is already being done or closed.'), 'already')
  const SK = await import('../folders/skills.js')
  let folder
  try {
    folder = await SK.saveDraftPrivate(user, await stageDir(row.id), want)
  } catch (e) {
    console.warn(`[pc-tools] register ${row.id.slice(0, 8)}: ${e.message}`)
    const said = clean(await hidePaths(e.message), 200)
    await setState(row, ['working'], { state: 'failed', error: said })
    await unstage(row.id)
    // (the name it took for this press, while no folder came of it: free again)
    await q(`delete from pro_skill_visibility where tenant_id=$1 and skill_name=$2 and author_id=$3 and folder_id is null
             and not exists (select 1 from pro_folders f where f.tenant_id=$1 and f.kind='skill' and f.settings->>'skill_name'=$2)`, [T(), want, user.id]).catch(() => {})
    throw err(e.status || 500, L(`스킬을 등록하지 못했어요: ${said}`, `Couldn't register the skill: ${said}`), 'failed')
  }
  let visibility = 'private'
  let shareError = null
  if (company) {
    try { await SK.share(folder, user, jwt); visibility = 'tenant' } catch (e) { shareError = clean(await hidePaths(e.message), 200); console.warn(`[pc-tools] share ${row.id.slice(0, 8)}: ${e.message}`) }
  }
  await unstage(row.id)
  const done = await setState(row, ['working'], { state: 'done', result: { slug: folder.slug, name: want, visibility, ...(shareError ? { shareError } : {}) } })
  emit(String(user.id), 'folders', { slug: folder.slug })
  console.log(`[pc-tools] skill '${want}' registered (${visibility}) user=${String(user.id).slice(0, 8)}`)
  return viewOf(user, done || row)
}

// POST /api/pc-proposals/:id/upload {confirm, name} — 「올리기」
export async function upload(user, id, { confirm, name = null } = {}) {
  let row = await current(await own(user, id))
  if (row.kind !== 'folder') throw err(400, L('폴더 제안이 아니에요.', 'This is not a folder proposal.'))
  open(row)
  if (!confirmOk(String(user.id), row, await optionsOf(user, row), confirm)) throw err(409, L('카드 내용이 바뀌었거나 오래됐어요. 카드를 다시 확인하고 눌러 주세요.', 'The card changed or was shown too long ago. Check it again and press it.'), 'stale')
  const link = H.linkOf(T(), String(row.device_id))
  if (!link || link.userId !== String(user.id) || !link.caps?.liteFolders) throw err(409, L('이 폴더가 있는 PC 의 앱이 꺼져 있어요 — 켜고 다시 눌러 주세요.', 'The app on the PC with this folder is off — turn it on and press again.'), 'pc_offline')
  const want = clean(name != null && String(name).trim() ? name : row.name, 80)
  if (!want) throw err(400, L('폴더 이름을 적어 주세요.', 'Please enter a folder name.'), 'bad_name')
  if (await nameTaken(row, want)) throw err(409, L('같은 이름의 폴더가 이미 있어요 — 다른 이름을 적어 주세요.', 'A folder with that name already exists — write another name.'), 'name_taken')
  row = await setState(row, ['pending'], { state: 'working', decided_at: new Date().toISOString(), name: want, error: null })
  if (!row) throw err(409, L('이미 처리하는 중이거나 끝난 제안이에요.', 'This proposal is already being done or closed.'), 'already')
  const S = await import('../folders/service.js')
  let folder
  try { folder = await S.createFolder(user, { name: want, champion: true }) } catch (e) {
    await setState(row, ['working'], { state: 'pending', error: clean(e.message, 300) })
    throw e
  }
  await q(`update pro_pc_proposals set result=$2 where id=$1`, [row.id, JSON.stringify({ folderId: folder.id, slug: folder.slug })])
  row = { ...row, result: { folderId: folder.id, slug: folder.slug } }
  // the app that proposed it binds and uploads it — the champion folders' own engine (only a pick it made for this proposal)
  if (!link.send({ type: 'tools:upload', proposalId: row.id, pickId: row.pick_id, folderId: folder.id, folderName: folder.name })) {
    await S.discardEmptyChampion(folder, 'owner').catch(() => {})
    await setState(row, ['working'], { state: 'pending', result: null, error: 'pc_offline' })
    throw err(409, L('이 폴더가 있는 PC 의 앱과 연결이 끊겼어요 — 다시 눌러 주세요.', 'The link to the app on that PC dropped — press again.'), 'pc_offline')
  }
  console.log(`[pc-tools] folder '${want}' → ${link.name} (${row.id.slice(0, 8)})`)
  return viewOf(user, (await q('select * from pro_pc_proposals where id=$1', [row.id]))[0])
}

// the app's answer (tools:uploaded {proposalId, ok, why, pushed}) — or the PC gone before it answered
async function settleUpload(row, { ok, why = null, pushed = null }) {
  const S = await import('../folders/service.js')
  const folder = row.result?.folderId ? await S.folderById(row.result.folderId).catch(() => null) : null
  if (ok && folder) {
    const done = await setState(row, ['working'], { state: 'done', result: { ...row.result, slug: folder.slug, name: folder.name, ...(pushed ? { pushed: { files: int(pushed.files), bytes: int(pushed.bytes) } } : {}) } })
    emit(String(row.user_id), 'folders', { slug: folder.slug })
    return done || row
  }
  // nothing went up: the folder made for it goes away again (only while it is empty — else it did go up, and it is done)
  if (folder) {
    try { await S.discardEmptyChampion(folder, 'owner') } catch {
      return (await setState(row, ['working'], { state: 'done', result: { ...row.result, slug: folder.slug, name: folder.name } })) || row
    }
  }
  // (a pick the app no longer has — it was restarted — cannot be pressed again; anything else can)
  const final = ['no_pick', 'folders_off', 'other_user', 'already_bound', 'changed'].includes(why)
  return (await setState(row, ['working'], { state: final ? 'failed' : 'pending', result: null, error: clean(why || 'failed', 60) })) || row
}
export async function uploaded(link, msg) {
  const id = String(msg.proposalId || '')
  if (!UUID.test(id)) return
  const [row] = await q(`select * from pro_pc_proposals where id=$1 and tenant_id=$2 and device_id=$3 and user_id=$4 and kind='folder'`, [id, link.tenant, link.id, link.userId])
  if (!row || row.state !== 'working') return
  const out = await settleUpload(row, { ok: msg.ok === true, why: msg.why ? String(msg.why) : null, pushed: msg.pushed || null })
  console.log(`[pc-tools] folder upload ${id.slice(0, 8)}: ${out.state}${out.error ? ` (${out.error})` : ''}`)
}
export const handles = (msg) => typeof msg?.type === 'string' && msg.type.startsWith('tools:')
export async function receive(link, msg) { if (msg.type === 'tools:uploaded') return uploaded(link, msg) }

// POST /api/pc-proposals/:id/drop — 「그만두기」
export async function drop(user, id) {
  const row = await current(await own(user, id))
  open(row)
  const x = await setState(row, ['pending'], { state: 'dropped', decided_at: new Date().toISOString() })
  if (!x) throw err(409, L('이미 처리하는 중이거나 끝난 제안이에요.', 'This proposal is already being done or closed.'), 'already')
  if (row.kind === 'skill') await unstage(row.id)
  return viewOf(user, x)
}

// ---------- what a run's CLI is told (chat.js prepare) ----------
// for a desktop with the tools: the token; for one without, a note in the prompt (the CLI says to update the app when the person asks for
// it — its own judgement of what they asked)
export function forRun(job, link) {
  if (!link?.caps?.liteTools) return null
  return { token: mintToken({ user: String(job.user_id), device: String(link.id), job: String(job.id) }), minutes: TOKEN_MINUTES }
}
export { KINDS }
