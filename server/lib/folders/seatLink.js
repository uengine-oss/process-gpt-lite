// A variation's working copy on its person's computer (작업본은 한 곳에 P1 — spec openspec/specs/variation-seats, folders/seats.js; desktop
// 0.2.6 desktop/src/runner/seats.js). The user's request (2026-11-26): 「폴더내 작업실을 누르면 일렉트론에 연결된 모바일이나 일렉트론내 해당
// 워크트리를 클론하여 작업할 수 있고 로컬 폴더 작업 결과를 서버로 동기화 할 수 있다. 작업본이 여러군데 흩어져서는 안되니 잘 설계해」.
// The seat moves to a computer (seats.claimDevice, state moving) and the computer is told over its link (localAgents/hub.js) to make the
// working copy — a clone of the folder and a git worktree of the variation's branch under the app's data folder. Once it says ready the seat
// is held there; what it commits comes back through the public git path (/api/local-git, gitHttp.js) on a branch of its own epoch
// (pgpt-agent/seat-<variation id>-<epoch>/head) and the server moves the variation's branch forward to it — only forward: nothing else moves
// that branch while the seat is there, so a head that is not ahead means the rules were broken somewhere and it is refused. Giving the seat
// back (「돌려놓기」) pushes what is there as it is first. A computer that lost the seat (taken while it was off, put away meanwhile) never
// pushes into the variation again: its old token is refused, and what it still had comes in as a variation of its own (seats.leftover —
// 「<title> — <PC>에 남아 있던 변경」) through a one-push token on pgpt-agent/left-<variation id>-<device 8>/head.
// Every message is looked up in the link's company and for the link's person only; nothing here takes a path from a computer or sends one.
//   PC → server   seat:ready · seat:failed · seat:token {for: push | left} · seat:pushed · seat:release · seat:status · seat:prefs · seat:left ·
//                 seat:refused {re: 'seat:recall'} (what the server asked it cannot do now — pcSays)
//   server → PC   seat:list · seat:prepare · seat:held · seat:token · seat:taken · seat:released · seat:left-taken · seat:refused ·
//                 seat:save · seat:recall · seat:prefs
// why (seat:refused): stale (another epoch) · not_here (the seat is not this computer's) · not_runner · no_variation · device_revoked ·
//   diverged (not ahead of the variation) · secret · structure · too_big · unchecked (what came in, sources.js inspect) · conflict ·
//   busy (the variation's lease is held elsewhere — try again later) · rate_limited
import crypto from 'node:crypto'
import { config } from '../../config.js'
import { q } from '../supa.js'
import { emit } from '../bus.js'
import { person } from '../people.js'
import * as G from './git.js'
import * as S from './service.js'
import * as SE from './seats.js'
import * as D from '../localAgents/devices.js'
import { mintToken } from './gitHttp.js'
import { inspect } from './sources.js'
import { stillHeld } from './diskLease.js'

const T = () => config.tenantId
export const TOKEN_HOURS = 1
const UUID = /^[0-9a-f-]{36}$/i
const OID = /^[0-9a-f]{40}$/
const ZERO = /^0{40}$/
const legacyNone = (e) => { if (e?.code === '42P01' || e?.code === '42703') return []; throw e }

// ---------- names ----------
// (the whole variation id: two variations whose ids start alike never share a branch)
export const seatPrefix = (vid, epoch) => `pgpt-agent/seat-${String(vid)}-${Number(epoch) || 0}/`
export const seatBranch = (vid, epoch) => `${seatPrefix(vid, epoch)}head`
export const leftPrefix = (vid, deviceId) => `pgpt-agent/left-${String(vid)}-${String(deviceId).slice(0, 8)}/`
export const leftBranch = (vid, deviceId) => `${leftPrefix(vid, deviceId)}head`
export const handles = (msg) => typeof msg?.type === 'string' && msg.type.startsWith('seat:')
const isAncestor = async (repo, a, b) => !!a && !!b && (await G.mergeBase(repo, a, b)) === a
const gitPath = (folder) => `/api/local-git/${folder.id}.git`
const publicUrl = (p) => { const pub = String(process.env.PRO_GIT_PUBLIC_URL || '').trim().replace(/\/+$/, ''); return pub ? `${pub}${p}` : null }

// ---------- a link's pace ----------
// a link may ask this often: a working copy reports its counts at most every 10 s and a person has up to 20 of them; past it the link is
// told so and nothing is done
export const RATE = { perMinute: 240 }
const asked = new WeakMap() // link → [times]
function tooOften(link, now = Date.now()) {
  const list = (asked.get(link) || []).filter((t) => now - t < 60_000)
  list.push(now)
  asked.set(link, list)
  return list.length > RATE.perMinute
}

// ---------- what a push was refused for ----------
// The after hook (afterPush, inside the folder's lock) puts a refused push's branch back at once; the computer learns why when it says
// seat:pushed · seat:release · seat:left for that head. Kept in memory (one server process, like the links themselves).
const refused = new Map() // variation → {head, why, paths, limit, at}
function remember(vid, head, no) {
  refused.set(String(vid), { head, why: no.why, paths: no.paths || null, limit: no.limit || null, at: Date.now() })
  if (refused.size > 2000) for (const [k, r] of refused) if (Date.now() - r.at > 3600_000) refused.delete(k)
}
function refusalFor(vid, head) {
  const r = refused.get(String(vid))
  if (!r || r.head !== head) return null
  return { why: r.why, ...(r.paths ? { paths: r.paths } : {}), ...(r.limit ? { limit: r.limit } : {}) }
}

// gitHttp after(): right after a working-copy (seat) or leftover (left) token's push, still inside the folder's lock — what must not be
// there (a link, another repository, git's control files, a file or a tree too big, the shape of a key — sources.js inspect, the same list
// as a champion folder's) never stays reachable on the branch it came to. A leftover token's push that went through uses it up.
export async function afterPush(claims, folder, commands) {
  if (!['seat', 'left'].includes(claims?.scope)) return
  const v = await S.variationById(String(claims.seat))
  if (!v || String(v.folder_id) !== String(folder.id)) return
  const vhead = await G.head(folder.repo_path, `refs/heads/${v.branch}`)
  let through = false
  for (const c of commands) {
    if (!c.ref.startsWith(`refs/heads/${claims.push}`) || ZERO.test(c.new)) continue
    const base = vhead && await isAncestor(folder.repo_path, vhead, c.new) ? vhead : await G.mergeBase(folder.repo_path, v.branch, c.new)
    const no = await inspect(folder, base, c.new)
    if (!no) { through = true; continue }
    if (!ZERO.test(c.old)) await G.git(folder.repo_path, ['update-ref', c.ref, c.old, c.new], { check: false })
    else await G.git(folder.repo_path, ['update-ref', '-d', c.ref, c.new], { check: false })
    remember(v.id, c.new, no)
    console.warn(`[seats] ${folder.slug}: a push from ${String(claims.device).slice(0, 8)} for ${v.id.slice(0, 8)} was refused (${no.why}${no.paths ? `, ${no.paths.length} file(s)` : ''}) — its branch is put back`)
  }
  if (claims.scope === 'left' && through) await D.useOnce({ ...claims, folder: folder.id })
}

// ---------- who may ----------
// the variation (of the link's company) and its folder, and the link's person's role in it → {v, folder, role} | {why}
async function lookup(link, vid) {
  if (!UUID.test(String(vid || ''))) return { why: 'no_variation' }
  const [d] = await q('select revoked_at from pro_local_devices where id=$1 and tenant_id=$2', [link.id, link.tenant])
  if (!d || d.revoked_at) return { why: 'device_revoked' }
  const [v] = await q('select v.* from pro_folder_variations v join pro_folders f on f.id=v.folder_id where v.id=$1 and f.tenant_id=$2', [vid, link.tenant])
  if (!v) return { why: 'no_variation' }
  const folder = await S.folderById(v.folder_id)
  if (!folder || folder.tenant_id !== link.tenant || folder.kind !== 'managed') return { why: 'no_variation' }
  return { v, folder, role: await S.roleOf(folder, { id: link.userId }) }
}
// whether a seat is this computer's working copy (not a chat run's — those have their job) — and at the epoch the computer says
const here = (seat, link) => !!seat && seat.place === 'device' && String(seat.device_id) === String(link.id) && String(seat.user_id) === String(link.userId) && !seat.job_id
// (the epoch is always said: a message without one is taken for an older one)
const whyNot = (seat, link, epoch) => (!here(seat, link) ? 'not_here' : epoch == null || epoch === '' || Number(seat.epoch) !== Number(epoch) ? 'stale' : null)

// every member of the folder sees the seat's words change (where, the counts, the last push) without reloading
async function told(folder, vid, also = null) {
  const rows = await q(`select principal_id from pro_folder_members where folder_id=$1 and principal_type='user'`, [folder.id]).catch(() => [])
  const ids = new Set(rows.map((r) => String(r.principal_id)))
  if (also) ids.add(String(also))
  for (const id of ids) emit(id, 'folders', { slug: folder.slug, variation: vid })
}

// ---------- to a computer ----------
async function linkOf(tenant, deviceId) {
  const H = await import('../localAgents/hub.js')
  return H.linkOf(tenant, String(deviceId || ''))
}
// a message to a computer of this company, if its link is on → whether it went
export async function tell(deviceId, msg, tenant = T()) {
  const link = await linkOf(tenant, deviceId)
  return !!link && link.send(msg)
}
// The computer's working copies as the server has them: right after its link comes on (it makes its own list match — what it has that is
// not here any more goes the leftover way), and again whenever one of its seats changed elsewhere (taken while it was off, put away when a
// move ran out of time). Moves that ran out of time count as none. Only an app that keeps working copies (caps.seats) is told.
export async function linkOn(link) {
  if (!link?.caps?.seats) return false
  const rows = await q(`select variation_id::text as variation, folder_id::text as folder, epoch, state, auto_save, deadline, place from pro_variation_seats
                        where tenant_id=$1 and device_id=$2 and user_id=$3 and place='device' and job_id is null`, [link.tenant, link.id, String(link.userId)]).catch(legacyNone)
  // (at: the server's time — a computer drops a list older than the seat:prepare it last had for a variation)
  return link.send({ type: 'seat:list', at: Date.now(), seats: rows.filter((r) => !SE.stale(r, null)).map((r) => ({ variation: r.variation, folderId: r.folder, epoch: Number(r.epoch), state: r.state, autoSave: r.auto_save !== false })) })
}
export async function refreshList(deviceId, tenant = T()) {
  const link = await linkOf(tenant, deviceId)
  return link ? linkOn(link) : false
}
// The words that go with a token: the folder's address on the public git path, and the person the commits are by (the name every screen
// shows for them)
async function tokenBase(link, folder) {
  const p = gitPath(folder)
  const who = await person(link.userId).catch(() => null)
  return { path: p, url: publicUrl(p), person: { name: who?.name || '', email: who?.email || '' } }
}
const seatToken = (link, folder, vid, epoch) => mintToken({ tenant: link.tenant, folderId: folder.id, push: seatPrefix(vid, epoch), scope: 'seat', device: link.id, seat: vid, epoch, hours: TOKEN_HOURS })
// 「이 PC 에서 작업」: the seat is this computer's now (moving — seats.claimDevice) and it is told to make the working copy at that epoch. The
// token is that epoch's: it fetches now (seatAccess lets a moving seat read) and pushes once the seat is held. → whether it went
export async function prepare(link, folder, v, { epoch, autoSave = true }) {
  const base = await tokenBase(link, folder)
  return link.send({ type: 'seat:prepare', at: Date.now(), variation: v.id, folderId: folder.id, folderName: folder.name, title: v.title, branch: v.branch,
    head: await G.head(folder.repo_path, `refs/heads/${v.branch}`), epoch: Number(epoch), autoSave: autoSave !== false,
    token: seatToken(link, folder, v.id, epoch), push: seatPrefix(v.id, epoch), ...base })
}

// ---------- the link's messages ----------
export async function receive(link, msg) {
  const vid = String(msg?.variation || '')
  // (re: the message this answers — the computer's waits end only on the answer to their own message)
  const refuse = (why, extra = {}) => link.send({ type: 'seat:refused', variation: vid, re: msg.type, why, ...extra })
  if (tooOften(link)) return refuse('rate_limited', msg.type === 'seat:token' ? { for: msg.for === 'left' ? 'left' : 'push' } : {})
  try {
    if (msg.type === 'seat:ready') return await ready(link, vid, msg, refuse)
    if (msg.type === 'seat:failed') return await failed(link, vid, msg)
    if (msg.type === 'seat:preparing') return await preparing(link, vid, msg)
    if (msg.type === 'seat:token') return await token(link, vid, msg, refuse)
    if (msg.type === 'seat:pushed') return await pushedIn(link, vid, msg, refuse)
    if (msg.type === 'seat:release') return await release(link, vid, msg, refuse)
    if (msg.type === 'seat:status') return await status(link, vid, msg)
    if (msg.type === 'seat:prefs') return await prefs(link, vid, msg)
    if (msg.type === 'seat:left') return await left(link, vid, msg, refuse)
    if (msg.type === 'seat:refused') return await pcRefused(link, vid, msg)
  } catch (e) {
    // (the variation's lease is held elsewhere a while — a move, a save: the computer tries again later)
    if (e.why === 'busy') return refuse('busy', msg.type === 'seat:token' ? { for: msg.for === 'left' ? 'left' : 'push' } : {})
    console.warn(`[seats] ${msg.type} ${vid.slice(0, 8)}:`, e.message)
    return refuse('conflict')
  }
}

// the working copy is there, at the variation's head: the seat is held (a ready said again after its move ran out of time still counts
// while nothing else took the seat — the row is still this computer's at that epoch)
async function ready(link, vid, msg, refuse) {
  const at = await lookup(link, vid)
  if (at.why) return refuse(at.why)
  const head = String(msg.head || '')
  const vhead = await G.head(at.folder.repo_path, `refs/heads/${at.v.branch}`)
  // (held already at that epoch — a ready said again after its answer was lost — is answered held whatever the working copy has done since;
  // a move ends only at the head the computer was given)
  const out = await SE.transition(vid, (vv, seat) => {
    const why = whyNot(seat, link, msg.epoch)
    if (why) return { ok: false, why }
    if (seat.state === 'held') return { ok: true, next: seat, bump: false, clear: false, action: 'same' }
    if (head && vhead && head !== vhead) return { ok: false, why: 'stale' }
    return SE.decide(seat, { type: 'settle', epoch: msg.epoch }, { v: vv })
  }, { by: link.userId })
  if (out.legacy) return refuse('no_variation')
  if (!out.ok) return refuse(out.why)
  link.send({ type: 'seat:held', variation: vid, epoch: Number(out.seat.epoch), head: vhead })
  await told(at.folder, vid, link.userId)
}

// the computer is still fetching the folder and adding the working copy (a large folder's first fetch takes longer than a move may): this
// computer's seat at that epoch, still moving, gets its deadline again. No reply.
async function preparing(link, vid, msg) {
  if (!UUID.test(vid) || msg.epoch == null) return
  await q(`update pro_variation_seats set deadline = now() + ($6 || ' milliseconds')::interval where variation_id=$1 and device_id=$2 and epoch=$3 and tenant_id=$4
             and user_id=$5 and place='device' and state='moving' and job_id is null`, [vid, link.id, Number(msg.epoch) || 0, link.tenant, String(link.userId), String(SE.MOVE_MS)]).catch(legacyNone)
}

// the computer could not make the working copy (or no longer has it): the seat goes (보관 중 — the branch has everything it last took)
async function failed(link, vid, msg) {
  if (!UUID.test(vid)) return
  const out = await SE.transition(vid, (vv, seat) => (!whyNot(seat, link, msg.epoch) ? { ok: true, next: null, bump: true, clear: false, action: 'fail' } : { ok: false, why: 'none' }),
    { by: link.userId, note: String(msg.why || '').slice(0, 100) })
  if (!out.ok || out.legacy) return
  await q(`update pro_folder_variations set status='ready', updated_at=now() where id=$1 and status='open'`, [vid])
  const f = await S.folderById(out.v.folder_id)
  if (f) await told(f, vid, link.userId)
}

// A token for one round: push — this computer's held seat at that epoch, its own epoch's branch only (1 hour) · left — what this computer
// still has of a variation whose seat it lost, its own leftover branch only, one push (devices.js leftAccess)
async function token(link, vid, msg, refuse) {
  const forWhat = msg.for === 'left' ? 'left' : 'push'
  const no = (why) => refuse(why, { for: forWhat })
  const at = await lookup(link, vid)
  if (at.why) return no(at.why)
  const { v, folder, role } = at
  if (!role || S.RANK[role] < S.RANK.runner) return no('not_runner')
  const base = { type: 'seat:token', variation: vid, for: forWhat, ...(await tokenBase(link, folder)) }
  if (forWhat === 'push') {
    const seat = await SE.seatOf(vid, { v })
    const why = whyNot(seat, link, msg.epoch)
    if (why) return no(why)
    if (seat.state !== 'held') return no('stale')
    const push = seatPrefix(vid, seat.epoch)
    return link.send({ ...base, push, branch: `${push}head`, epoch: Number(seat.epoch), head: await G.head(folder.repo_path, `refs/heads/${v.branch}`),
      token: seatToken(link, folder, vid, seat.epoch) })
  }
  const once = crypto.randomBytes(8).toString('hex')
  const claims = { scope: 'left', device: link.id, seat: vid, once, tenant: link.tenant, folder: folder.id }
  if (await D.leftAccess(claims, { push: true })) return no('not_runner')
  const push = leftPrefix(vid, link.id)
  return link.send({ ...base, push, branch: `${push}head`, epoch: Number(msg.epoch) || 0,
    token: mintToken({ tenant: link.tenant, folderId: folder.id, push, scope: 'left', device: link.id, seat: vid, epoch: Number(msg.epoch) || 0, once, hours: TOKEN_HOURS }) })
}

// the variation's disk lease (seats.onDisk) for one short step on the server — never across the computer's own work; a lease held elsewhere
// longer than SAVE_WAIT_MS says busy, and the computer tries again later
const leased = (vid, fn) => SE.onDisk(String(vid), fn, { wait: SE.SAVE_WAIT_MS })

// What the computer pushed to its epoch's branch goes into the variation, in the folder's lock: only from this computer's held seat at
// that epoch, only the head that is on that branch now (a refused push was put back — its reason is said), only forward. The caller holds
// the variation's lease (the same order as every move of a seat: lease, then the folder's lock), so a take or a move never falls between
// the check and the branch moving.
// → {taken, head, again?} | {why, paths?, limit?}
async function absorb(link, at, epoch, head) {
  const { v, folder } = at
  return S.serial(folder.id, async () => {
    const cur = await S.variationById(v.id)
    const seat = await SE.seatOf(v.id, { v: cur })
    const why = whyNot(seat, link, epoch)
    if (why) return { why }
    if (seat.state !== 'held') return { why: 'stale' }
    const tip = await G.head(folder.repo_path, `refs/heads/${seatBranch(v.id, seat.epoch)}`)
    if (tip !== head) return refusalFor(v.id, head) || { why: 'conflict' }
    const vhead = await G.head(folder.repo_path, `refs/heads/${cur.branch}`)
    if (vhead === head) return { taken: true, head, again: true }
    if (vhead && !(await isAncestor(folder.repo_path, vhead, head))) return { why: 'diverged' }
    // (the variation's lease still ours — a lease lost meanwhile stops here, before the branch moves)
    await stillHeld('absorb')
    await G.git(folder.repo_path, ['update-ref', `refs/heads/${cur.branch}`, head, ...(vhead ? [vhead] : [])])
    await q('update pro_folder_variations set head_commit=$2, updated_at=now() where id=$1', [v.id, head])
    await SE.pushed(v.id, head)
    return { taken: true, head }
  })
}
// after the variation moved: the folder's time, its 「바뀐 점」 card (a little later — it reads the change), everyone's screens
async function afterTaken(link, at, head) {
  await S.touch(at.folder)
  const { changeCard } = await import('./indexer.js')
  changeCard(at.folder, { ...at.v, head_commit: head }).catch(() => {})
  await told(at.folder, at.v.id, link.userId)
}
const refusalWords = (r) => ({ ...(r.paths ? { paths: r.paths } : {}), ...(r.limit ? { limit: r.limit } : {}) })

// a save point came up (seat:pushed {head, epoch}) → seat:taken · seat:refused
async function pushedIn(link, vid, msg, refuse) {
  const at = await lookup(link, vid)
  if (at.why) return refuse(at.why)
  const head = String(msg.head || '')
  if (!OID.test(head)) return refuse('conflict')
  const r = await leased(vid, () => absorb(link, at, msg.epoch, head))
  if (r.why) return refuse(r.why, refusalWords(r))
  if (!r.again) await afterTaken(link, at, head)
  else await SE.pushed(vid, head)
  link.send({ type: 'seat:taken', variation: vid, head })
}

// 「돌려놓기」 from the computer: what it pushed last (head — committed as it was there) goes in first; then the seat is none (보관 중), the
// variation is ready to review, its epoch's branch goes. The computer takes its working copy off disk only after seat:released.
async function release(link, vid, msg, refuse) {
  const at = await lookup(link, vid)
  if (at.why) return refuse(at.why)
  const head = msg.head ? String(msg.head) : null
  if (head && !OID.test(head)) return refuse('conflict')
  // (what it pushed goes in and the seat goes back as one step under the variation's lease)
  const done = await leased(vid, async () => {
    let r = null
    if (head) {
      r = await absorb(link, at, msg.epoch, head)
      if (r.why) return { refused: r }
    }
    const out = await SE.transition(vid, (vv, seat) => {
      const why = whyNot(seat, link, msg.epoch)
      if (why) return { ok: false, why }
      return SE.decide(seat, { type: 'release', by: link.userId, epoch: msg.epoch, system: true }, { v: vv })
    }, { by: link.userId, note: 'released from the PC' })
    return { r, out }
  })
  if (done.refused) return refuse(done.refused.why, refusalWords(done.refused))
  if (done.r && !done.r.again) await afterTaken(link, at, head)
  const out = done.out
  if (out.legacy) return refuse('no_variation')
  if (!out.ok) return refuse(out.why === 'moving' ? 'stale' : out.why)
  await q(`update pro_folder_variations set status='ready', updated_at=now() where id=$1 and status in ('open','conflicted')`, [vid])
  const vhead = await S.serial(at.folder.id, async () => {
    await G.git(at.folder.repo_path, ['update-ref', '-d', `refs/heads/${seatBranch(vid, msg.epoch)}`], { check: false })
    return G.head(at.folder.repo_path, `refs/heads/${at.v.branch}`)
  })
  link.send({ type: 'seat:released', variation: vid, head: vhead })
  await told(at.folder, vid, link.userId)
}

// the computer's counts (저장 안 한 변경 · 안 올린 저장 지점) — numbers only, never a file name
const count = (x) => Math.max(0, Math.min(1_000_000, Math.floor(Number(x) || 0)))
async function status(link, vid, msg) {
  if (!UUID.test(vid)) return
  const rows = await q(`update pro_variation_seats set dirty=$4, ahead=$5, seen_at=now() where variation_id=$1 and device_id=$2 and epoch=$3 and tenant_id=$6
                          and user_id=$7 and place='device' and job_id is null returning folder_id, dirty, ahead`,
  [vid, link.id, Number(msg.epoch) || 0, count(msg.dirty), count(msg.ahead), link.tenant, String(link.userId)]).catch(legacyNone)
  if (!rows.length) return
  const f = await S.folderById(rows[0].folder_id)
  if (f) await told(f, vid, link.userId)
}
// The computer cannot do now what the server asked of it — 「여기로 가져오기」 (seat:recall auto) while a terminal or a program is open in the
// working copy, or another branch is checked out there: the page that waits says so (the seat's view, pcSays) for a few minutes, until the
// seat moves on or the person tries again. Kept in memory: the link and the page's poll are this server's.
const PC_SAYS = new Set(['in_use', 'branch', 'remove', 'failed', 'offline'])
const PC_SAYS_MS = 10 * 60_000
const pcSaid = new Map() // variation → {why, at, epoch, device}
async function pcRefused(link, vid, msg) {
  if (!UUID.test(vid) || msg.re !== 'seat:recall' || !PC_SAYS.has(String(msg.why))) return
  const at = await lookup(link, vid)
  if (at.why) return
  const seat = await SE.seatOf(vid, { v: at.v })
  if (whyNot(seat, link, msg.epoch)) return
  const [d] = await q('select name from pro_local_devices where id=$1', [link.id]).catch(() => [])
  pcSaid.set(vid, { why: String(msg.why), at: Date.now(), epoch: Number(seat.epoch), device: String(d?.name || link.name || '').slice(0, 80) })
  if (pcSaid.size > 2000) for (const [k, x] of pcSaid) if (Date.now() - x.at > PC_SAYS_MS) pcSaid.delete(k)
  await told(at.folder, vid, link.userId)
}
// what the computer that holds the seat said back (null when nothing, or it is about another epoch, or old) → {why, device, at}
export function pcSays(vid, seat) {
  const s = pcSaid.get(String(vid))
  if (!s) return null
  if (!seat || Number(seat.epoch) !== s.epoch || Date.now() - s.at > PC_SAYS_MS) { pcSaid.delete(String(vid)); return null }
  return { why: s.why, device: s.device, at: new Date(s.at).toISOString() }
}
export const pcSaysClear = (vid) => pcSaid.delete(String(vid))

// 「자동으로 올리기」 switched on the computer
async function prefs(link, vid, msg) {
  if (!UUID.test(vid) || typeof msg.autoSave !== 'boolean') return
  await q(`update pro_variation_seats set auto_save=$4 where variation_id=$1 and device_id=$2 and tenant_id=$3 and user_id=$5 and place='device' and job_id is null`,
    [vid, link.id, link.tenant, msg.autoSave, String(link.userId)]).catch(legacyNone)
}

// What a computer that lost the seat still had (seat:left {head} — pushed to its leftover branch with a one-push token): a variation of its
// own, 「<title> — <PC>에 남아 있던 변경」, held by that person and merged only through the batch merge (seats.leftover); never mixed into the
// variation it came from. The leftover branch goes (the new variation's branch holds it). Nothing the variation lacks → no new variation.
async function left(link, vid, msg, refuse) {
  const at = await lookup(link, vid)
  if (at.why) return refuse(at.why)
  const head = String(msg.head || '')
  if (!OID.test(head)) return refuse('conflict')
  if (await D.leftAccess({ scope: 'left', device: link.id, seat: vid, once: crypto.randomBytes(4).toString('hex'), tenant: link.tenant, folder: at.folder.id }, { push: true })) return refuse('not_runner')
  const r = await leased(vid, () => S.serial(at.folder.id, async () => {
    const branch = leftBranch(vid, link.id)
    const tip = await G.head(at.folder.repo_path, `refs/heads/${branch}`)
    if (tip !== head) return refusalFor(vid, head) || { why: 'conflict' }
    // (the same leftover said again — its computer could not move the copy aside and tries once more: the variation it already made)
    const [had] = await q(`select * from pro_folder_variations where folder_id=$1 and kind='imported' and source->>'left_of'=$2 and head_commit=$3 order by created_at limit 1`, [at.folder.id, vid, head])
    const [d] = await q('select name from pro_local_devices where id=$1', [link.id])
    await stillHeld('left')
    const nv = had || await SE.leftover(at.folder, await S.variationById(vid), head, { user: link.userId, where: d?.name || 'PC' })
    await G.git(at.folder.repo_path, ['update-ref', '-d', `refs/heads/${branch}`, head], { check: false })
    return { nv }
  }))
  if (r.why) return refuse(r.why, refusalWords(r))
  link.send({ type: 'seat:left-taken', variation: vid, newVariation: r.nv ? { id: r.nv.id, title: r.nv.title } : null })
  await told(at.folder, r.nv?.id || vid, link.userId)
}

// A computer let go in the settings (its device token revoked): its working copies' seats go (보관 중 — the branches have what it last
// pushed). What it still has comes back the leftover way if its person links it again; until then nothing of it reaches the server.
export async function deviceGone(deviceId, by = null) {
  const rows = await q(`select variation_id from pro_variation_seats where tenant_id=$1 and device_id=$2 and place='device' and job_id is null`, [T(), String(deviceId)]).catch(legacyNone)
  for (const r of rows) {
    const out = await SE.transition(r.variation_id, (vv, seat) => (seat && seat.place === 'device' && String(seat.device_id) === String(deviceId) && !seat.job_id
      ? { ok: true, next: null, bump: true, clear: false, action: 'release' } : { ok: false, why: 'none' }), { by, note: 'device revoked' }).catch(() => null)
    if (!out?.ok) continue
    await q(`update pro_folder_variations set status='ready', updated_at=now() where id=$1 and status='open'`, [r.variation_id])
    const f = await S.folderById(out.v.folder_id)
    if (f) await told(f, r.variation_id, by)
  }
  return rows.length
}
