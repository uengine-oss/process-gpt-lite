// The app badge: how many Home cards wait (src/browserNotify.js announce · src/main.js). Where it shows:
//   - the desktop app (desktop/, Electron): over its bridge (pglDesktop.setBadge — desktop/src/preload.js) to the Dock (macOS),
//     the taskbar button (Windows) and the tray icon. Only there: Electron's own navigator.setAppBadge would draw a second,
//     different badge on Windows' taskbar button, and the tray would not know.
//   - an installed web app (PWA) where the browser has the Badging API: navigator.setAppBadge on its icon
// No imports: server/test/appBadge.test.js runs it under Node with stand-ins for window and navigator.
export const badgeCount = (n) => {
  const v = Math.floor(Number(n))
  return v > 0 ? Math.min(v, 9999) : 0
}

export function showBadge(n, { win = globalThis.window, nav = globalThis.navigator } = {}) {
  const k = badgeCount(n)
  try {
    if (typeof win?.pglDesktop?.setBadge === 'function') { win.pglDesktop.setBadge(k); return 'desktop' }
  } catch { /* an older app */ }
  try {
    if (!nav || !('setAppBadge' in nav)) return null
    // (both return promises: a refusal — no permission, not installed — is not an error of the page)
    const p = k ? nav.setAppBadge(k) : nav.clearAppBadge()
    p?.catch?.(() => {})
    return 'pwa'
  } catch { return null }
}
