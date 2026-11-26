// A desktop's device token (lib/localAgents): the signed-in page asks for one (POST /api/local-agents/devices) and hands it to the
// desktop app's main process through its preload bridge; main keeps it (encrypted with the OS keychain) and sends it as the first
// message of its link (hub.js). One token = one person on one device; only its hash is kept here, so a token is shown once.
// Revoked from the settings (DELETE …/devices/:id): its link is closed at once and the token is refused from then on.
import crypto from 'node:crypto'
import { config } from '../../config.js'
import { q } from '../supa.js'

const T = () => config.tenantId
export const PREFIX = 'pld1_'
export const MAX_DEVICES = 10
const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n)

export const hashOf = (token) => crypto.createHash('sha256').update(String(token || '')).digest('hex')
export const looksLike = (token) => typeof token === 'string' && /^pld1_[A-Za-z0-9_-]{43}$/.test(token)
export const newToken = () => `${PREFIX}${crypto.randomBytes(32).toString('base64url')}`

// a new device for this person (the oldest active ones are let go past MAX_DEVICES) → { device, token }
export async function issue(user, { name = '', platform = '', appVersion = '' } = {}) {
  const token = newToken()
  const [d] = await q(`insert into pro_local_devices (tenant_id, user_id, name, platform, app_version, token_hash)
                       values ($1,$2,$3,$4,$5,$6) returning *`,
  [T(), user.id, clean(name, 80) || 'Desktop', clean(platform, 20) || null, clean(appVersion, 30) || null, hashOf(token)])
  const extra = await q(`select id from pro_local_devices where tenant_id=$1 and user_id=$2 and revoked_at is null order by created_at desc offset $3`, [T(), user.id, MAX_DEVICES])
  if (extra.length) await q(`update pro_local_devices set revoked_at=now() where id = any($1)`, [extra.map((x) => x.id)])
  return { device: view(d), token }
}

// the device a token stands for (any tenant: the link comes outside a request's tenant), or null (unknown, revoked, malformed)
export async function byToken(token) {
  if (!looksLike(token)) return null
  const [d] = await q(`select * from pro_local_devices where token_hash=$1`, [hashOf(token)])
  if (!d || d.revoked_at) return null
  return d
}

export async function list(user) {
  return (await q(`select * from pro_local_devices where tenant_id=$1 and user_id=$2 order by revoked_at nulls first, coalesce(last_seen_at, created_at) desc limit 30`, [T(), user.id])).map(view)
}

// only the person's own device; → the row revoked, or null
export async function revoke(user, id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) return null
  const [d] = await q(`update pro_local_devices set revoked_at=coalesce(revoked_at, now()) where id=$1 and tenant_id=$2 and user_id=$3 returning *`, [id, T(), user.id])
  return d ? view(d) : null
}

// Whether a desktop's job token may use the public git path now (folders/gitHttp.js device): its device is linked (not revoked), the job
// is that device's, of that folder — and for a push, still running there (offered · running). → null when it may, else why not.
export async function gitAccess(claims, { push = false } = {}) {
  if (claims?.scope === 'sync') return syncAccess(claims, { push })
  if (claims?.scope === 'seat') return seatAccess(claims, { push })
  if (claims?.scope === 'left') return leftAccess(claims, { push })
  if (!/^[0-9a-f-]{36}$/i.test(String(claims?.device || '')) || !/^[0-9a-f-]{36}$/i.test(String(claims?.job || ''))) return 'not a desktop job token'
  const [d] = await q('select revoked_at from pro_local_devices where id=$1 and tenant_id=$2', [claims.device, claims.tenant])
  if (!d || d.revoked_at) return 'this desktop is not linked any more'
  const [j] = await q('select state, device_id, folder_id, sent_skills from pro_local_jobs where id=$1 and tenant_id=$2', [claims.job, claims.tenant])
  if (!j || String(j.device_id || '') !== claims.device) return 'this job is not this desktop\'s'
  // (the job's work folder, or a skill folder it was given — read only)
  const skill = (j.sent_skills || []).some((k) => String(k.folderId) === claims.folder)
  if (String(j.folder_id || '') !== claims.folder && !skill) return 'this job does not use that folder'
  if (push && !(['offered', 'running'].includes(j.state) && !skill)) return 'this job is not running on this desktop'
  if (!['offered', 'running', 'done', 'failed'].includes(j.state)) return 'this job is over'
  return null
}

// The same for a desktop's sync token (champion folders — folders/sources.js: a folder the person's computer uploads, no job): checked on
// every request, so a token that is still valid stops working the moment any of these changes — its device is linked (not revoked), the
// folder is still synced from that device (its source row is there and on), the folder is a managed one of the token's company, and the
// device's person now holds at least viewer (fetch) / editor (push) in it. → null when it may, else why not.
export async function syncAccess(claims, { push = false } = {}) {
  if (claims?.scope !== 'sync' || !/^[0-9a-f-]{36}$/i.test(String(claims?.device || ''))) return 'not a desktop sync token'
  const [d] = await q('select user_id, revoked_at from pro_local_devices where id=$1 and tenant_id=$2', [claims.device, claims.tenant])
  if (!d || d.revoked_at) return 'this desktop is not linked any more'
  const [s] = await q('select state, user_id from pro_folder_sources where folder_id=$1 and device_id=$2 and tenant_id=$3', [claims.folder, claims.device, claims.tenant])
  if (!s || s.state === 'removed') return 'this folder is not synced from this desktop any more'
  if (s.state === 'paused') return 'syncing this folder from this desktop is paused'
  if (String(s.user_id) !== String(d.user_id)) return 'this folder is synced by someone else on this desktop'
  const [f] = await q('select * from pro_folders where id=$1 and tenant_id=$2', [claims.folder, claims.tenant])
  if (!f || f.kind !== 'managed') return 'this folder is not synced over git'
  const { roleOf, RANK } = await import('../folders/service.js')
  const role = await roleOf(f, { id: String(d.user_id) })
  if (!role || RANK[role] < RANK[push ? 'editor' : 'viewer']) return push ? 'uploading to this folder needs the editor role' : 'this folder is not shared with you'
  return null
}

// The same for a desktop's working-copy token (variation seats — folders/seats.js · seatLink.js, spec variation-seats; desktop 0.2.6):
// one variation on one device at one epoch, checked on every request — the
// device is linked (not revoked), the variation's seat is that device's and still at the token's epoch (a push from an older epoch is
// refused before git sees it), the folder is a managed one of the token's company, and the device's person holds at least runner in it.
// → null when it may, else why not.
export async function seatAccess(claims, { push = false } = {}) {
  if (claims?.scope !== 'seat' || !/^[0-9a-f-]{36}$/i.test(String(claims?.device || '')) || !/^[0-9a-f-]{36}$/i.test(String(claims?.seat || ''))) return 'not a desktop working-copy token'
  const [d] = await q('select user_id, revoked_at from pro_local_devices where id=$1 and tenant_id=$2', [claims.device, claims.tenant])
  if (!d || d.revoked_at) return 'this desktop is not linked any more'
  const [s] = await q('select place, state, device_id, user_id, epoch, folder_id from pro_variation_seats where variation_id=$1 and tenant_id=$2', [claims.seat, claims.tenant])
    .catch((e) => { if (e.code === '42P01') return []; throw e })
  if (!s || s.place !== 'device' || String(s.device_id) !== String(claims.device)) return 'this working copy is not on this desktop any more'
  if (Number(s.epoch) !== Number(claims.epoch)) return 'this working copy moved since this token was given (an older epoch)'
  if (String(s.folder_id) !== String(claims.folder)) return 'this token is for another folder'
  if (String(s.user_id) !== String(d.user_id)) return 'this working copy is someone else\'s on this desktop'
  if (push && s.state === 'moving') return 'this working copy is still being prepared'
  const [f] = await q('select * from pro_folders where id=$1 and tenant_id=$2', [claims.folder, claims.tenant])
  if (!f || f.kind !== 'managed') return 'this folder is not served over git'
  const { roleOf, RANK } = await import('../folders/service.js')
  const role = await roleOf(f, { id: String(d.user_id) })
  if (!role || RANK[role] < RANK.runner) return 'working on this folder needs the runner role'
  return null
}

// The same for a desktop's leftover token (scope 'left' — folders/seatLink.js): a computer that lost a variation's seat (taken while it was
// off, put away meanwhile) brings back what it still had as a variation of its own, never into the variation itself. One push: the token
// names a random `once` that a push which went through uses up (usedOnce). Checked on every request — the device is linked, the variation
// is of the token's folder and company, the device's person is its holder or that device held its seat before (the seat log), the
// folder is a managed one and the person holds at least runner in it. → null when it may, else why not.
// The use is kept in the seat log too (action 'left-push', note 'once:<value>'): a server that restarted, or another process of it, refuses
// the same token as well (review 11-26 #11); the memory only answers first.
const usedOnce = new Map() // once → when it was used (kept past the token's hour)
const ONCE_NOTE = (once) => `once:${String(once)}`
export async function useOnce(claims, now = Date.now()) {
  const once = claims?.once
  if (!once) return
  usedOnce.set(String(once), now)
  if (usedOnce.size > 5000) for (const [k, t] of usedOnce) if (now - t > 2 * 3600_000) usedOnce.delete(k)
  await q(`insert into pro_variation_seat_log (tenant_id, variation_id, folder_id, by_user, action, device_id, epoch, note)
           select $1, $2::uuid, $3::uuid, (select user_id::text from pro_local_devices where id=$4::uuid), 'left-push', $4::uuid, $5, $6`,
  [claims.tenant, claims.seat, claims.folder, claims.device, Number(claims.epoch) || 0, ONCE_NOTE(once)]).catch((e) => console.warn('[seats] once', e.message))
}
export async function onceUsed(claims) {
  const once = String(claims?.once || '')
  if (usedOnce.has(once)) return true
  const [row] = await q(`select 1 from pro_variation_seat_log where variation_id=$1 and tenant_id=$2 and action='left-push' and note=$3 limit 1`, [claims.seat, claims.tenant, ONCE_NOTE(once)])
    .catch((e) => { if (e.code === '42P01') return []; throw e })
  return !!row
}
export async function leftAccess(claims, { push = false } = {}) {
  if (claims?.scope !== 'left' || !/^[0-9a-f-]{36}$/i.test(String(claims?.device || '')) || !/^[0-9a-f-]{36}$/i.test(String(claims?.seat || '')) || !claims.once) return 'not a desktop leftover token'
  if (await onceUsed(claims)) return 'this leftover token was used already'
  const [d] = await q('select user_id, revoked_at from pro_local_devices where id=$1 and tenant_id=$2', [claims.device, claims.tenant])
  if (!d || d.revoked_at) return 'this desktop is not linked any more'
  const [f] = await q('select * from pro_folders where id=$1 and tenant_id=$2', [claims.folder, claims.tenant])
  if (!f || f.kind !== 'managed') return 'this folder is not served over git'
  const [v] = await q('select holder_type, holder_id from pro_folder_variations where id=$1 and folder_id=$2', [claims.seat, claims.folder])
  if (!v) return 'this token is for another folder'
  if (!(v.holder_type === 'user' && String(v.holder_id) === String(d.user_id))) {
    const [had] = await q('select 1 from pro_variation_seat_log where variation_id=$1 and device_id=$2 and tenant_id=$3 limit 1', [claims.seat, claims.device, claims.tenant])
      .catch((e) => { if (e.code === '42P01') return []; throw e })
    if (!had) return 'this variation was never on this desktop'
  }
  const { roleOf, RANK } = await import('../folders/service.js')
  const role = await roleOf(f, { id: String(d.user_id) })
  if (!role || RANK[role] < RANK[push ? 'runner' : 'viewer']) return 'working on this folder needs the runner role'
  return null
}

// what the desktop reported (hello / caps): kept for the settings screen and for dispatching; only the known keys, short strings
export function capsOf(raw = {}) {
  const clis = {}
  for (const id of ['claude-code', 'codex', 'openhands']) {
    const c = raw?.clis?.[id]
    if (!c || typeof c !== 'object') continue
    clis[id] = { installed: !!c.installed, version: clean(c.version, 40) || null, loggedIn: typeof c.loggedIn === 'boolean' ? c.loggedIn : null,
      runnable: c.runnable !== false }
  }
  // (chat: it runs chat messages for its person's CLI — desktop 0.2.2, the composer's agent picker · browser: it has a browser the
  // server's browser agent can drive — desktop 0.2.3, lib/browserRemote.js)
  // (folders: it uploads folders its person picked — champion folders, desktop 0.2.5 · seats: it keeps working copies of variations —
  // 「이 PC 에서 작업」, desktop 0.2.6, folders/seatLink.js)
  return { clis, maxJobs: Math.max(1, Math.min(4, Number(raw?.maxJobs) || 2)), terminal: raw?.terminal === true, conversation: raw?.conversation === true, chat: raw?.chat === true,
    browser: raw?.browser === true, folders: raw?.folders === true, seats: raw?.seats === true }
}
// browser: 「브라우저 작업은 내 PC에서」 — this PC's own setting (desktop 0.2.3): 'own' (the person's own tasks, the default) · 'all' (also tasks
// nobody watches) · 'off' (lib/browserRemote.js routeOf)
export const prefsOf = (raw = {}) => ({ enabled: raw?.enabled !== false, ask: raw?.ask === true, browser: ['off', 'own', 'all'].includes(raw?.browser) ? raw.browser : 'own' })

export async function seen(id, { caps, prefs, name, appVersion } = {}) {
  await q(`update pro_local_devices set last_seen_at=now(), caps=coalesce($2, caps), prefs=coalesce($3, prefs), name=coalesce($4, name), app_version=coalesce($5, app_version) where id=$1`,
    [id, caps ? JSON.stringify(caps) : null, prefs ? JSON.stringify(prefs) : null, name ? clean(name, 80) : null, appVersion ? clean(appVersion, 30) : null])
}

export function view(d) {
  return { id: d.id, name: d.name, platform: d.platform, appVersion: d.app_version, caps: d.caps || {}, prefs: d.prefs || {},
    createdAt: d.created_at, lastSeenAt: d.last_seen_at, revoked: !!d.revoked_at }
}
