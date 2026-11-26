// Supabase access: admin client, DB pool and session minting for users that
// signed in through our own Google/email flow.
import { createClient } from '@supabase/supabase-js'
import pg from 'pg'
import { config } from '../config.js'

export const admin = createClient(config.supabaseUrl, config.serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})

// process-gpt's engine (completion) writes its work times — bpm_proc_inst / todolist start_date, end_date,
// due_date, the only `timestamp without time zone` columns we read — as Asia/Seoul wall-clock time
// (datetime.now(pytz.timezone('Asia/Seoul')) into a naive column). pg would read them in this server's own
// time zone: right on a Korean laptop, nine hours late on a UTC pod ("오전 2:08 시작" for 오후 5:08). Read
// them as Seoul time wherever this runs; write ours the same way (ENGINE_NOW).
export const ENGINE_TZ = 'Asia/Seoul'
export const ENGINE_NOW = `(now() at time zone '${ENGINE_TZ}')`
export const engineTime = (s) => (s == null || !/^\d{4}-\d\d-\d\d/.test(s) ? s : new Date(`${s.replace(' ', 'T')}+09:00`))
pg.types.setTypeParser(pg.types.builtins.TIMESTAMP, engineTime)

export const pool = new pg.Pool(config.db)
// an idle client dropped by the DB (restart, recovery mode) is discarded by the pool; without a
// listener the 'error' event would take the whole server down
pool.on('error', (e) => console.warn('[db] idle client error:', e.message))
export const q = (text, params) => pool.query(text, params).then((r) => r.rows)

// The auth user and its public.users row, created on first sight (sign-in, or a teammate added
// to the team before they ever signed in).
// With more than one tenant on this server (lib/tenant.js), an account belongs to the tenant it was
// made on (app_metadata.tenant_id, written here for every tenant but the default one, so accounts of
// the default tenant are made exactly as before) and is not let into another one.
// An auth user by address (already lower-case: GoTrue keeps addresses so): the database first — listUsers answers one page (1,000), so
// past that a known account looked new and createUser refused it, 「A user with this email address has already been registered」 (the
// dev stack, 1,090 accounts, 2026-11-25); the page as before where the auth schema cannot be read. (email = …, not lower(email):
// GoTrue's unique index on email for accounts that are not SSO ones answers it.)
export const normEmail = (email) => String(email || '').trim().toLowerCase()
// (exported for invitations — lib/membership.js: an address that already has an account is invited without making another)
// (an address the database does not know has no account: the sign-in screens ask for unknown addresses too — lib/membership.js —
// and must not page through the auth server's users each time)
export async function authUserByEmail(email) {
  const rows = await q('select id from auth.users where email = $1 and not is_sso_user limit 1', [email]).catch(() => null)
  if (rows?.[0]) {
    const { data } = await admin.auth.admin.getUserById(rows[0].id)
    if (data?.user) return data.user
  }
  if (rows) return null
  const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 })
  return list?.users?.find((u) => u.email === email) || null
}

// (the address as GoTrue keeps it — lower case, no spaces — so 「Kim@Corp.com」 is the account kim@corp.com and its rows say so)
// The account only, and the tenant's row in tenants: a membership (the users row) is made by lib/membership.js addRow, always as
// 'pending' and then approved by whoever lets the person in — a row made here in passing would have been a membership nobody granted
// (sql/058's column default is 'approved').
export async function ensureUser(email0, name) {
  const email = normEmail(email0)
  let user = await authUserByEmail(email)
  const { multiTenant, DEFAULT_TENANT, tenantOfAuthUser, TenantMismatch, forgetTenant, ensureTenantRow } = await import('./tenant.js')
  await ensureTenantRow(config.tenantId)
  if (!user) {
    const { data, error } = await admin.auth.admin.createUser({
      email, email_confirm: true, user_metadata: { name, tenant_id: config.tenantId },
      ...(multiTenant() && config.tenantId !== DEFAULT_TENANT ? { app_metadata: { tenant_id: config.tenantId } } : {}),
    })
    if (error) throw error
    user = data.user
  } else if (multiTenant() && tenantOfAuthUser(user) !== config.tenantId) {
    // an account nobody has used here yet (made by GoTrue when the sign-in code was sent, or by
    // process-gpt) goes to the tenant it first signs in on; one in use stays where it is
    const [used] = await q('select 1 from pro_profile where user_id=$1', [user.id])
    if (used || config.tenantId === DEFAULT_TENANT) throw new TenantMismatch(tenantOfAuthUser(user))
    const { data, error } = await admin.auth.admin.updateUserById(user.id, { app_metadata: { ...(user.app_metadata || {}), tenant_id: config.tenantId } })
    if (error) throw error
    user = data.user
    forgetTenant(user.id)
  }
  return user
}

// A fresh session for an approved member of this request's (or job's) tenant (access_token is what deepagents expects as user_jwt).
// Anyone else — waiting for an administrator, let go, or with no row here (a job whose tenant fell back to the default) — gets none,
// and nothing is written for them: the status is read before anything else.
// One person's sessions are minted one at a time: a new sign-in link makes the one before it invalid, so two
// routines starting in the same minute failed with otp_expired (production 11-22, 08:00 and 09:00 KST). Each
// caller still gets a session of its own (a login and a job never share refresh tokens). A link spent by
// someone else meanwhile (another server minting for the same person) is tried once more.
const minting = new Map() // email → the mint in progress
export async function sessionFor(email, name) {
  const key = String(email || '').trim().toLowerCase()
  const before = minting.get(key) || Promise.resolve()
  const mine = before.catch(() => {}).then(() => mintSession(email, name))
  minting.set(key, mine)
  try { return await mine } finally { if (minting.get(key) === mine) minting.delete(key) }
}
async function mintSession(email0, name, retried = false) {
  const email = normEmail(email0)
  const user = await authUserByEmail(email)
  if (!user || (await memberStatus(user.id, config.tenantId)) !== 'approved') {
    const { L } = await import('./lang.js')
    throw Object.assign(new Error(L('이 회사의 승인된 구성원이 아니에요.', 'Not an approved member of this company.')), { status: 403, code: 'invite_only' })
  }
  const { data: link, error: linkErr } = await admin.auth.admin.generateLink({ type: 'magiclink', email })
  if (linkErr) throw linkErr
  const res = await fetch(`${config.supabaseUrl}/auth/v1/verify`, {
    method: 'POST',
    headers: { apikey: config.anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', token_hash: link.properties.hashed_token }),
  })
  const session = await res.json()
  if (!session.access_token && session.error_code === 'otp_expired' && !retried) return mintSession(email, name, true)
  if (!session.access_token) throw new Error('session mint failed: ' + JSON.stringify(session).slice(0, 200))
  return { user: { id: user.id, email, name: name || email.split('@')[0] }, session }
}

// The person of a token, or null when Supabase refuses it (4xx). A timeout or 5xx from a slow or restarting
// auth server is no answer about the token: with { unavailable: true } it throws instead, so auth() can say
// 503 and the client keeps its session rather than signing the person out mid-task.
export async function userFromJwt(jwt, { unavailable = false } = {}) {
  const { data, error } = await admin.auth.getUser(jwt)
  if (!error) return data.user
  if (unavailable && !(error.status >= 400 && error.status < 500)) throw Object.assign(new Error(`auth server unavailable: ${error.message}`), { status: 503 })
  return null
}

export async function refresh(refreshToken) {
  const res = await fetch(`${config.supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: { apikey: config.anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken }),
  })
  const j = await res.json().catch(() => ({}))
  // a refused refresh token (4xx) ends the session; a failing auth server (5xx) does not
  return res.status >= 500 ? { ...j, unavailable: true } : j
}

// Membership (2026-11-25 사용자: 「초대를 해준 사람에 한해서만 로그인 할 수 있는 거야」). public.users has one row per tenant a
// person joined, and Process GPT's 가입 승인 (vue3 20260908000001 · 20261119000001) gives each row membership_status:
// 'approved' · 'pending' (a sign-up waiting for an administrator) · 'rejected'. Only 'approved' is a member here. A database without
// the column (before that migration: an install, the dev stack before sql/056) has no waiting room: every row is approved. Read
// through to_jsonb, like people.js reads pro_profile.lang, so the same query answers on both. The tenant's owner (tenants.owner — the
// one who made the company; Process GPT's trigger lets them straight in) is approved whatever the row says.
export const STATUS = (a = 'u') => `coalesce(to_jsonb(${a})->>'membership_status', 'approved')`
export const APPROVED = (a = 'u') => `(${STATUS(a)} = 'approved')`
// an administrator of the company by their row: Process GPT's is_admin, or its admin roles (membership_admin(): is_admin or admin · superadmin)
export const ADMINISH = (a = 'u') => `(coalesce(${a}.is_admin, false) or lower(coalesce(${a}.role, '')) in ('admin', 'superadmin'))`
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// 'approved' | 'pending' | 'rejected' | null (no row in that tenant)
export async function memberStatus(userId, tenantId, query = q) {
  if (!UUID.test(String(userId || ''))) return null
  const [r] = await query(`select ${STATUS('u')} as status,
                             exists (select 1 from tenants t where t.id = u.tenant_id and t.owner::text = u.id::text) as owner
                           from users u where u.id = $1 and u.tenant_id = $2`, [String(userId), tenantId])
  if (!r) return null
  return r.owner ? 'approved' : r.status
}

// whether a user is an approved member of a tenant. Remembered a minute when yes, a few seconds when no (someone an administrator
// just approved — here or in Process GPT — gets in on the next try); forgetMember after a change made here.
const members = new Map()
export async function isMember(userId, tenantId) {
  const k = `${userId}|${tenantId}`, hit = members.get(k)
  if (hit && hit.at > Date.now() - (hit.ok ? 60000 : 5000)) return hit.ok
  const ok = (await memberStatus(userId, tenantId)) === 'approved'
  members.set(k, { ok, at: Date.now() })
  return ok
}
// An MCP gateway's caller (/mcp/*: an agent working as the person of its user_jwt) must be an approved member of the request's company:
// → null, or the JSON-RPC answer to send instead (403)
export async function mcpRefusal(user) {
  if (!user || (await isMember(user.id, config.tenantId))) return null
  return { jsonrpc: '2.0', error: { code: -32003, message: 'forbidden: not an approved member of this company' }, id: null }
}
export function forgetMember(userId) {
  for (const k of [...members.keys()]) if (k.startsWith(`${userId}|`)) members.delete(k)
}

// a background job's tick for each tenant it serves (lib/tenant.js forEachTenant)
export async function eachTenant(fn) {
  const { forEachTenant } = await import('./tenant.js')
  return forEachTenant(fn)
}

// whether an address is an approved member of a tenant (its row approved, or the tenant's owner)
export async function isMemberEmail(email, tenantId) {
  return (await q(`select 1 from users u where lower(u.email) = lower($1) and u.tenant_id = $2
                     and (${APPROVED('u')} or exists (select 1 from tenants t where t.id = u.tenant_id and t.owner::text = u.id::text))`,
  [String(email || ''), tenantId])).length > 0
}
