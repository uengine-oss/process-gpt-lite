// A sign-in this tab started itself (/auth/done takes no other — web and the desktop app's window alike). Before the page leaves for
// Google (LoginView.vue), this tab's sessionStorage keeps that a sign-in is under way — a random value, when and which way:
//   · Lite's own 「Google로 계속하기」 (an installed Lite): the value goes with it (/api/auth/google/start?n=…, kept in the server's
//     state) and comes back on the address (/auth/done?n=…); the session is taken only when it is the one kept here
//   · ProcessGPT's Supabase sign-in behind the gateway: its redirect_to is the plain /auth/done — the session is taken only when this
//     tab has such a sign-in under way
// Either way once (what is kept goes at the first look) and within SIGN_IN_MS.
const KEY = 'pgl-sign-in'
export const SIGN_IN_MS = 30 * 60 * 1000
const storeOf = () => { try { return window.sessionStorage } catch { return null } }

// via: 'own' (Lite's own sign-in) or 'sso' (ProcessGPT's). → the value for this sign-in ('' when this tab cannot keep one: the
// sign-in then is not taken)
export function startSignIn(store = storeOf(), now = Date.now(), { via = 'own' } = {}) {
  const bytes = new Uint8Array(24)
  globalThis.crypto.getRandomValues(bytes)
  const n = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
  try { store.setItem(KEY, JSON.stringify({ n, at: now, via })) } catch { return '' }
  return n
}

// Whether the fragment /auth/done was opened with is Supabase's (#access_token=… · #error=…), not Lite's own (#<JSON>)
export function fromSupabase(hash) {
  const raw = String(hash || '').replace(/^#/, '')
  return !!raw && !raw.startsWith('%7B') && !raw.startsWith('{')
}

// whether /auth/done (its query: location.search; sso: the fragment is Supabase's) comes back from the sign-in this tab started
export function takeSignIn(search, store = storeOf(), now = Date.now(), { sso = false } = {}) {
  let kept = null
  try { kept = JSON.parse(store.getItem(KEY) || 'null') } catch { kept = null }
  try { store.removeItem(KEY) } catch { /* nothing kept */ }
  const at = Number(kept?.at)
  if (typeof kept?.n !== 'string' || kept.n.length < 32 || !Number.isFinite(at) || now < at || now - at > SIGN_IN_MS) return false
  if (sso) return kept.via === 'sso'
  return kept.via !== 'sso' && new URLSearchParams(String(search || '')).get('n') === kept.n
}

// whose session it is: the access token's subject (the person's id), or null
export function subjectOf(session) {
  try { return JSON.parse(atob(String(session?.access_token || '').split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).sub || null } catch { return null }
}

// What /auth/done does with what came back (got: src/authFragment.js sessionFromFragment) — mine: takeSignIn's answer; here: the
// session this device is signed in with, if any; who: its person (src/api.js sessionUser):
//   'refuse' — not a sign-in this tab started, and nobody is signed in here: nothing is taken, the sign-in screen says why
//   'stay'   — someone is signed in here: they stay as they are (a sign-in that was not this tab's, or another person's session)
//   'fail'   — this tab's sign-in came back without a session (Google said no)
//   'take'   — sign in with it
export function doneStep({ mine, got, here = null, who = null }) {
  if (!mine) return here ? 'stay' : 'refuse'
  if (here && (!got?.session || subjectOf(got.session) !== who)) return 'stay'
  return got?.session ? 'take' : 'fail'
}
