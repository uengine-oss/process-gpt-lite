// Supabase access: admin client, DB pool and session minting for users that
// signed in through our own Google/email flow.
import { createClient } from '@supabase/supabase-js'
import pg from 'pg'
import { config } from '../config.js'

export const admin = createClient(config.supabaseUrl, config.serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})

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
export async function ensureUser(email, name) {
  const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 })
  let user = list?.users?.find((u) => u.email === email)
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
  await q(
    `insert into public.users (id, username, email, tenant_id, role, is_admin, is_agent, is_draft, permission_ids)
     values ($1,$2,$3,$4,'user',false,false,false,'{}') on conflict (id, tenant_id) do nothing`,
    [user.id, name || email.split('@')[0], email, config.tenantId],
  ).catch((e) => console.warn('[users] insert failed:', e.message))
  return user
}

// Ensure the user exists, then return a fresh session (access_token is what deepagents expects
// as user_jwt).
export async function sessionFor(email, name) {
  const user = await ensureUser(email, name)
  const { data: link, error: linkErr } = await admin.auth.admin.generateLink({ type: 'magiclink', email })
  if (linkErr) throw linkErr
  const res = await fetch(`${config.supabaseUrl}/auth/v1/verify`, {
    method: 'POST',
    headers: { apikey: config.anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', token_hash: link.properties.hashed_token }),
  })
  const session = await res.json()
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

// whether a user belongs to a tenant (public.users has one row per tenant a person joined)
const members = new Map()
export async function isMember(userId, tenantId) {
  const k = `${userId}|${tenantId}`, hit = members.get(k)
  if (hit && hit.at > Date.now() - 60000) return hit.ok
  const ok = (await q('select 1 from users where id=$1 and tenant_id=$2', [userId, tenantId])).length > 0
  members.set(k, { ok, at: Date.now() })
  return ok
}

// a background job's tick for each tenant it serves (lib/tenant.js forEachTenant)
export async function eachTenant(fn) {
  const { forEachTenant } = await import('./tenant.js')
  return forEachTenant(fn)
}

// whether an email already has an account in a tenant
export async function isMemberEmail(email, tenantId) {
  return (await q('select 1 from users where lower(email) = lower($1) and tenant_id = $2', [String(email || ''), tenantId])).length > 0
}
