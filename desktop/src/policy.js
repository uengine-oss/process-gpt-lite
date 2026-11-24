'use strict'
// Where a URL may open (no Electron here: unit-tested in test/policy.test.js).
//   app      — the chosen Lite server's origin: in the window. The whole origin, not only the Lite path:
//              behind the ProcessGPT gateway (<tenant>.process-gpt.io/lite) ProcessGPT itself is on the
//              same origin and shares its sign-in cookies with Lite.
//   auth     — a sign-in page the window passes through and comes back from: the server's Supabase
//              (its /api/config sso.google address) and Google's account pages. In the window too.
//   external — any other web or mail address: the system browser or mail app.
//   blocked  — anything else (file:, javascript:, data:, a custom scheme): nowhere.

// accounts.google.com, and the country domains a Google sign-in sets its cookie on (accounts.google.co.kr)
const GOOGLE_ACCOUNTS = /^accounts\.google\.(?:com|[a-z]{2,3}(?:\.[a-z]{2})?)$/i
const GOOGLE_EXTRA = new Set(['accounts.youtube.com'])
const loopback = (host) => /^(?:localhost|(?:[a-z0-9-]+\.)*localhost|127\.0\.0\.1|\[::1\])$/i.test(host)

function originOf(url) {
  try { return new URL(url).origin } catch { return '' }
}

function kind(url, { server, authOrigins = [] } = {}) {
  let u
  try { u = new URL(url) } catch { return 'blocked' }
  if (u.protocol === 'mailto:' || u.protocol === 'tel:') return 'external'
  if (url === 'about:blank') return 'app'
  // a blob: the page made itself (a file it saves): its origin is the page's
  if (u.protocol === 'blob:') return originOf(u.pathname) && originOf(u.pathname) === originOf(server) ? 'app' : 'blocked'
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'blocked'
  if (server && u.origin === originOf(server)) return 'app'
  const secure = u.protocol === 'https:' || loopback(u.hostname)
  if (secure && (authOrigins.includes(u.origin) || GOOGLE_ACCOUNTS.test(u.hostname) || GOOGLE_EXTRA.has(u.hostname.toLowerCase()))) return 'auth'
  return 'external'
}

// what the system may be asked to open (shell.openExternal)
const openable = (url) => /^(?:https?|mailto|tel):/i.test(String(url || ''))

// The server's basic-auth gate (a tunnel's) is answered with the saved pair only for the app's own window — its default session — on the
// chosen server's origin: never for the browser the server's agent drives on this PC (its own session partition), even when a page there
// goes to that address (app.on('login') in main.js)
function answersGate({ mainSession = false, isProxy = false, url = '', server = '' } = {}) {
  return !!mainSession && !isProxy && !!server && !!originOf(url) && originOf(url) === originOf(server)
}

module.exports = { kind, openable, originOf, loopback, answersGate }
