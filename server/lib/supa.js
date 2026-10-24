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
export async function ensureUser(email, name) {
  const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 })
  let user = list?.users?.find((u) => u.email === email)
  if (!user) {
    const { data, error } = await admin.auth.admin.createUser({
      email, email_confirm: true, user_metadata: { name, tenant_id: config.tenantId },
    })
    if (error) throw error
    user = data.user
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

export async function refresh(refreshToken) {
  const res = await fetch(`${config.supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: { apikey: config.anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken }),
  })
  return res.json()
}

export async function userFromJwt(jwt) {
  const { data, error } = await admin.auth.getUser(jwt)
  if (error) return null
  return data.user
}
