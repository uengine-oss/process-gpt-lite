// Where this device keeps the person's sign-in — the session the server gave (access and refresh token; src/api.js auth reads it).
//   In a browser (the web, a phone): the page's localStorage, as before.
//   In the desktop app (desktop/ 0.2.6+, window.pglDesktop.session): the app keeps it, sealed with the system's keychain — not in the
//   page's storage. A sign-in kept in the page's storage (an older app, a window without the app's bridge) moves there when the page
//   loads and leaves the storage; `moved` tells the caller, which renews the session once (api.js) so the pair that was in the storage
//   is spent. Where the app cannot seal it (some Linux, or the keychain said no) the page's storage, as in a browser.
// No imports: src/i18n/lang.js, imported first, reads it too.
export const KEY = 'pgpt-pro-session'

// desktop: window.pglDesktop.session ({sealed(), get(), set(v) → kept?, clear()}) · storage: window.localStorage
export function makeSessionStore({ desktop = null, storage = null } = {}) {
  let sealed = null
  try { sealed = desktop && typeof desktop.sealed === 'function' && desktop.sealed() === true ? desktop : null } catch { sealed = null }
  let moved = false
  if (sealed && storage) {
    let old = null
    try { old = storage.getItem(KEY) } catch { old = null }
    if (old != null) {
      // (the app could not keep it — the keychain said no: this page goes on with its storage, nothing is lost)
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

const win = typeof window === 'undefined' ? null : window
const pick = (fn) => { try { return fn() || null } catch { return null } }
export const sessionStore = makeSessionStore({ desktop: pick(() => win?.pglDesktop?.session), storage: pick(() => win?.localStorage) })
