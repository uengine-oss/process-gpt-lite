// A sign-in this tab started itself (/auth/done takes no other — web and the desktop app's window alike). Before the page leaves for
// Google (Lite's own 「Google로 계속하기」, or ProcessGPT's Supabase sign-in behind the gateway: LoginView.vue), a random value is kept
// in this tab's sessionStorage and goes with the sign-in: the address it comes back to carries it (?n=…, as redirect_to's query for
// Supabase, through /api/auth/google/start's state for Lite's own). AuthDone.vue takes the session only when the value it comes back with
// is the one kept here — once (the kept value goes at the first look), within SIGN_IN_MS.
const KEY = 'pgl-sign-in'
export const SIGN_IN_MS = 30 * 60 * 1000
const storeOf = () => { try { return window.sessionStorage } catch { return null } }

// → the value for this sign-in ('' when this tab cannot keep one: the sign-in then is not taken)
export function startSignIn(store = storeOf(), now = Date.now()) {
  const bytes = new Uint8Array(24)
  globalThis.crypto.getRandomValues(bytes)
  const n = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
  try { store.setItem(KEY, JSON.stringify({ n, at: now })) } catch { return '' }
  return n
}

// whether the address /auth/done was opened at (its query: location.search) comes back from the sign-in this tab started
export function takeSignIn(search, store = storeOf(), now = Date.now()) {
  let kept = null
  try { kept = JSON.parse(store.getItem(KEY) || 'null') } catch { kept = null }
  try { store.removeItem(KEY) } catch { /* nothing kept */ }
  const n = new URLSearchParams(String(search || '')).get('n') || ''
  const at = Number(kept?.at)
  return typeof kept?.n === 'string' && kept.n.length >= 32 && n === kept.n && Number.isFinite(at) && now >= at && now - at <= SIGN_IN_MS
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
