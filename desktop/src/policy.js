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

// ---------- the browser the server's agent drives on this PC (browser/host.js) ----------
// It never opens — nor sends a request to — the Lite app it is part of, or that app's sign-in: the chosen server (kind 'app': its whole
// origin — and its host on the same port by the other scheme, or http on 80 for https on 443), the server's Supabase sign-in origin(s)
// (authOrigins, the same way), and for a server on this PC the same port by another of this PC's names (localhost · 127.0.0.1 · [::1] ·
// selfHosts: this PC's own addresses and names). about:blank stays open to it. The host's own rules come on top (web addresses only,
// this PC's network for a task nobody watches). A window shown on this PC tells the person why (main.js browserNotice).
const DEFAULT_PORT = { 'http:': '80', 'https:': '443' }
const bare = (h) => String(h || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '')
const loopName = (h) => h === 'localhost' || h.endsWith('.localhost') || /^127\.\d+\.\d+\.\d+$/.test(h) || h === '::1' || h === '0.0.0.0' || h === '::' ||
  /^::ffff:(?:127\.|7f[0-9a-f]{2}:)/.test(h)
// (a WebSocket's address is its server's: ws → http, wss → https)
function placeOf(url) {
  let u
  try { u = new URL(String(url).replace(/^ws(s?):/i, 'http$1:')) } catch { return null }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  return { scheme: u.protocol, host: bare(u.hostname), port: u.port || DEFAULT_PORT[u.protocol] }
}
const atDefault = (p) => p.port === DEFAULT_PORT[p.scheme]
// the same server: the same host on the same port (by either scheme — the same socket), or on the default ports of both
function samePlace(a, b, selfHosts = []) {
  if (!a || !b) return false
  if (a.port !== b.port && !(atDefault(a) && atDefault(b))) return false
  if (a.host === b.host) return true
  // a server on this PC answers on its port by any of this PC's names
  const here = (h) => loopName(h) || selfHosts.includes(h)
  return here(a.host) && here(b.host)
}
function agentMay(url, { server = '', authOrigins = [], selfHosts = [] } = {}) {
  const s = String(url || '')
  if (s === 'about:blank') return true
  // (a blob: the app's page made: the app's own)
  if (/^blob:/i.test(s)) return !(server && kind(s, { server }) === 'app')
  const p = placeOf(s)
  if (!p) return true
  const self = selfHosts.map(bare)
  if (server && samePlace(p, placeOf(server), self)) return false
  return !authOrigins.some((o) => samePlace(p, placeOf(o), self))
}

// The server's basic-auth gate (a tunnel's) is answered with the saved pair only for the app's own window — its default session — on the
// chosen server's origin: never for the browser the server's agent drives on this PC (its own session partition), even when a page there
// goes to that address (app.on('login') in main.js)
function answersGate({ mainSession = false, isProxy = false, url = '', server = '' } = {}) {
  return !!mainSession && !isProxy && !!server && !!originOf(url) && originOf(url) === originOf(server)
}

module.exports = { kind, openable, originOf, loopback, answersGate, agentMay }
