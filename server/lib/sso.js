// Google sign-in behind the ProcessGPT gateway (<tenant>.process-gpt.io/lite, 2026-11-18).
// There the accounts are ProcessGPT's own Supabase project's, and Lite's own Google OAuth (mail.js,
// GOOGLE_CLIENT_ID/SECRET) would need every company's address registered with Google. The project's
// Google provider (Supabase Authentication → Sign In / Providers) needs one: its /auth/v1/callback.
// The page sends the person there with its own address as redirect_to (allowed by the project's
// Redirect URLs, https://*.process-gpt.io/lite/**) and takes the session from the fragment it comes
// back with (AuthDone.vue); auth() then lets in only the members of the address's tenant.
//
// Whether the provider is on is read from the project's public settings, at most once a minute, in the
// background: /api/config is the readiness probe and never waits on it.
import { config } from '../config.js'

const state = { at: 0, google: false }

export function refreshSso(fetchImpl = fetch) {
  if (!config.tenantFromHeader || !config.supabaseUrl || !config.anonKey) return Promise.resolve(false)
  state.at = Date.now()
  return fetchImpl(`${config.supabaseUrl}/auth/v1/settings`, { headers: { apikey: config.anonKey }, signal: AbortSignal.timeout(5000) })
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => { if (j) state.google = !!j.external?.google; return state.google })
    .catch(() => state.google)
}

// {google: '<project>/auth/v1/authorize?provider=google'} or null; the page adds redirect_to
export function ssoInfo() {
  if (!config.tenantFromHeader) return null
  if (Date.now() - state.at > 60_000) refreshSso()
  return state.google ? { google: `${config.supabaseUrl.replace(/\/$/, '')}/auth/v1/authorize?provider=google` } : null
}

