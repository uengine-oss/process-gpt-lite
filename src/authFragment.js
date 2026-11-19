// The fragment Supabase's Google sign-in comes back with (server/lib/sso.js):
//   #access_token=…&refresh_token=…&expires_at=…   or   #error=…&error_description=…
// and Lite's own sign-ins' (Google through the server, mail.js): #<encoded JSON {user, session}>.
export function sessionFromFragment(hash) {
  const raw = String(hash || '').replace(/^#/, '')
  if (!raw) return null
  if (raw.startsWith('%7B') || raw.startsWith('{')) {
    try { return JSON.parse(decodeURIComponent(raw)) } catch { return null }
  }
  const p = new URLSearchParams(raw)
  if (p.get('error') || p.get('error_description')) return { error: p.get('error_description') || p.get('error') }
  const access_token = p.get('access_token'), refresh_token = p.get('refresh_token')
  if (!access_token || !refresh_token) return null
  return { session: { access_token, refresh_token, expires_at: Number(p.get('expires_at')) || undefined }, sso: true }
}
