// Where this device keeps the person's sign-in — the session the server gave (access and refresh token; src/api.js auth reads it).
//   In a browser (the web, a phone): the page's localStorage, as before.
//   In the desktop app (desktop/ 0.2.6+, window.pglDesktop.session): the app keeps it, sealed with the system's keychain — not in the
//   page's storage. A sign-in kept in the page's storage by an older app moves there the first time the page loads and leaves the
//   storage; `moved` tells the caller, which renews the session (spendMoved) so the pair that was in the storage is spent. Once the app
//   has kept this server's sign-in (keptBefore), a copy found in the page's storage later is removed and never taken. Where the app
//   cannot seal it (some Linux, or the keychain said no) the page's storage, as in a browser.
// No imports: src/i18n/lang.js, imported first, reads it too.
export const KEY = 'pgpt-pro-session'

// desktop: window.pglDesktop.session ({sealed(), keptBefore(), get(), set(v) → kept?, clear()}) · storage: window.localStorage
export function makeSessionStore({ desktop = null, storage = null } = {}) {
  let sealed = null
  try { sealed = desktop && typeof desktop.sealed === 'function' && desktop.sealed() === true ? desktop : null } catch { sealed = null }
  let moved = false
  if (sealed && storage) {
    let old = null
    try { old = storage.getItem(KEY) } catch { old = null }
    let kept = false
    try { kept = typeof sealed.keptBefore === 'function' && sealed.keptBefore() === true } catch { kept = false }
    if (old != null && kept) {
      // (the app keeps this server's sign-in already: a copy in the page's storage is not taken — a sign-out stays a sign-out)
      try { storage.removeItem(KEY) } catch { /* not there */ }
    } else if (old != null) {
      // (the app could not keep it — the keychain said no, or its settings could not be written: this page goes on with its storage)
      if (old && !sealed.set(old)) sealed = null
      else {
        moved = !!old
        try { storage.removeItem(KEY) } catch { /* not there */ }
      }
    }
  }
  return {
    sealed: !!sealed,
    moved,
    read() {
      try { return sealed ? sealed.get() ?? null : storage?.getItem(KEY) ?? null } catch { return null }
    },
    write(v) {
      try { if (sealed) sealed.set(String(v)); else storage?.setItem(KEY, String(v)) } catch { /* private mode */ }
    },
    remove() {
      try { if (sealed) sealed.clear(); else storage?.removeItem(KEY) } catch { /* private mode */ }
    },
  }
}

// A sign-in that moved from the page's storage (moved) is marked spend until a renewal goes through — refresh() → true (renewed: the new
// pair carries no mark — src/api.js refreshToken), false (refused: there is nothing left to spend — the mark goes), null or an error (the
// server did not answer: tried again later, 5 s doubling up to 5 min, and at the next load, the mark being kept with the sign-in). One
// taken from ProcessGPT (host) is ProcessGPT's to renew.
export function spendMoved({ auth, refresh, moved = false, later = (fn, ms) => setTimeout(fn, ms) }) {
  const s = auth.get()
  if (moved && s && !s.host && !s.spend) auth.set({ ...s, spend: true })
  let wait = 0
  const again = () => { wait = Math.min(Math.max(wait * 2, 5000), 300000); later(go, wait) }
  function go() {
    const now = auth.get()
    if (!now?.spend || now.host) return
    Promise.resolve().then(refresh).then((ok) => {
      if (ok === false) {
        const x = auth.get()
        if (x?.spend) { const { spend: _spent, ...rest } = x; auth.set(rest) }
      } else if (ok !== true) again()
    }, again)
  }
  later(go, 0)
}

const win = typeof window === 'undefined' ? null : window
const pick = (fn) => { try { return fn() || null } catch { return null } }
export const sessionStore = makeSessionStore({ desktop: pick(() => win?.pglDesktop?.session), storage: pick(() => win?.localStorage) })
