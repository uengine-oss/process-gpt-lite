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
// IPv4 inside IPv6, as the URL parser writes it — mapped (::ffff:7f00:1 for [::ffff:127.0.0.1]), translated (::ffff:0:7f00:1) or the old
// compatible form (::7f00:1) — is that IPv4 address
function v4of(h) {
  const dotted = /^::(?:ffff:(?:0:)?)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(h)
  if (dotted) return dotted[1]
  const hex = /^::(?:ffff:(?:0:)?)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h)
  if (!hex) return null
  const hi = parseInt(hex[1], 16), lo = parseInt(hex[2], 16)
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`
}
// a host as it is compared: lower case, no brackets, no trailing dot, IPv4 inside IPv6 as plain IPv4
const bare = (h) => { const b = String(h || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '').replace(/%.*$/, ''); return v4of(b) || b }
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
// appOrigins: the server's own addresses by its own account (its /api/config — its public address, a tunnel's): the same server
function agentMay(url, { server = '', authOrigins = [], appOrigins = [], selfHosts = [] } = {}) {
  const s = String(url || '')
  if (s === 'about:blank') return true
  // (a blob: the app's page made: the app's own)
  if (/^blob:/i.test(s)) return !(server && kind(s, { server }) === 'app')
  const p = placeOf(s)
  if (!p) return true
  const self = selfHosts.map(bare)
  if (server && samePlace(p, placeOf(server), self)) return false
  return ![...authOrigins, ...(server ? appOrigins : [])].some((o) => samePlace(p, placeOf(o), self))
}
const appPlaces = ({ server = '', authOrigins = [], appOrigins = [] } = {}) => (server ? [server, ...authOrigins, ...appOrigins] : []).map(placeOf).filter((p) => p && p.host)
// Names are resolved too (browser/host.js, with this browser's own resolver): a name that resolves to this PC is one of this PC's names.
//   appNames(ctx): the names of the app's server and sign-in (not addresses, not already this PC's) — resolved to learn whether they are here
//   nameToCheck(url, ctx): a request's host name (not an address, not already this PC's) on the port of the app's server or sign-in when that
//     is on this PC — the request is refused when it resolves to this PC (any of its addresses)
//   hereAddress(address, selfHosts): an address a name resolved to is this PC's — loopback (127/8, ::1, 0.0.0.0, ::, IPv4 inside IPv6) or
//     one of this PC's own
const ipLiteral = (h) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(h) || h.includes(':')
const hereHost = (h, self) => loopName(h) || self.includes(h)
function appNames(ctx = {}) {
  const self = (ctx.selfHosts || []).map(bare)
  return [...new Set(appPlaces(ctx).filter((p) => !ipLiteral(p.host) && !hereHost(p.host, self)).map((p) => p.host))]
}
function nameToCheck(url, ctx = {}) {
  const p = placeOf(url)
  const self = (ctx.selfHosts || []).map(bare)
  if (!p || !p.host || ipLiteral(p.host) || hereHost(p.host, self)) return null
  const here = appPlaces(ctx).filter((a) => hereHost(a.host, self))
  return here.some((a) => a.port === p.port || (atDefault(a) && atDefault(p))) ? p.host : null
}
const hereAddress = (address, selfHosts = []) => { const h = bare(address); return !!h && (loopName(h) || selfHosts.map(bare).includes(h)) }

// The part of a name its owner holds (accounts.shop.example → shop.example, lite.acme.co.kr → acme.co.kr); an address or a single name is
// itself. A name under the app's (its server's, its sign-in's, its own addresses') may be the app by another name.
const SECOND = new Set(['co', 'or', 'go', 'ac', 'ne', 're', 'com', 'net', 'org', 'gov', 'edu'])
function siteOf(host) {
  const h = bare(host)
  if (!h || ipLiteral(h) || !h.includes('.')) return h
  const p = h.split('.')
  return p.slice(SECOND.has(p.at(-2)) && p.at(-1).length === 2 ? -3 : -2).join('.')
}
const appSites = (ctx) => [...new Set(appPlaces(ctx).map((p) => p.host).filter((h) => !ipLiteral(h) && !loopName(h) && h.includes('.')).map(siteOf))]
const underAppSite = (host, ctx = {}) => { const h = bare(host); return appSites(ctx).some((s) => h === s || h.endsWith(`.${s}`)) }
// A name that may be this PC's, its network's or the app's — one label (intranet), the network's own endings (*.local · *.lan · *.internal ·
// *.intranet · *.localdomain · *.home.arpa · *.localhost), or under the app's names: one that does not resolve is not opened on the app's
// port (nothing else is refused for a lookup that failed)
const NET_SUFFIX = /\.(localhost|local|lan|internal|intranet|localdomain|home\.arpa)$/
// A request on the port of the app's server (or of an address it gives for itself) when that port is not 80 · 443: marked, whatever its
// host is and whatever that resolves to
function onAppPort(url, { server = '', appOrigins = [] } = {}) {
  const p = placeOf(url)
  if (!p || !server) return false
  return [server, ...appOrigins].map(placeOf).some((a) => a && !atDefault(a) && a.port === p.port)
}
const couldBeLocal = (host, ctx = {}) => { const h = bare(host); return !!h && (!h.includes('.') || NET_SUFFIX.test(h) || underAppSite(h, ctx)) }

// The web app's own screens: the first part of each path its router has (src/main.js routes — test/policy.test.js checks this list
// against that file). Its sign-in's return page (/auth/…) is not one a link opens.
const APP_SCREENS = ['', 'login', 'welcome', 'chat', 'routines', 'projects', 'settings', 'workroom', 'folders', 'mining', 'improve', 'process-map',
  'strategy', 'agentic', 'backoffice', 'team-activity', 'context']
const NOT_FROM_LINKS = ['auth']
// Which window a page of the app's own window opens a new window's address in (main.js setWindowOpenHandler):
//   'main'     — a screen of the web app itself (the server's address under its path, on one of APP_SCREENS — a link in the chat to a
//                project, a folder): the app's window shows it, by the web app's own router (main.js — nothing reloads); the web app keeps
//                its sign-in only through that window
//   'child'    — the server's other addresses (its /api/, the files it serves, /craft/ · /assets/ · /_lite/ …, a download, ProcessGPT's
//                own pages behind the gateway): a window of its own
//   'outside'  — a sign-in page or any other web or mail address: the system browser or mail app
//   'none'     — nowhere (also the web app's sign-in return page)
function windowFor(url, ctx = {}) {
  const k = kind(url, ctx)
  if (k === 'external' || k === 'auth') return 'outside'
  if (k !== 'app' || url === 'about:blank') return 'none'
  let u, base
  try { u = new URL(url); base = new URL(ctx.server) } catch { return 'child' }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.origin !== base.origin) return 'child'
  const root = base.pathname.replace(/\/+$/, '')
  const p = u.pathname
  if (root && p !== root && !p.startsWith(`${root}/`)) return 'child'
  const first = (p.slice(root.length) || '/').split('/')[1] || ''
  if (NOT_FROM_LINKS.includes(first)) return 'none'
  return APP_SCREENS.includes(first) ? 'main' : 'child'
}

// The server's basic-auth gate (a tunnel's) is answered with the saved pair only for the app's own window — its default session — on the
// chosen server's origin: never for the browser the server's agent drives on this PC (its own session partition), even when a page there
// goes to that address (app.on('login') in main.js)
function answersGate({ mainSession = false, isProxy = false, url = '', server = '' } = {}) {
  return !!mainSession && !isProxy && !!server && !!originOf(url) && originOf(url) === originOf(server)
}

module.exports = { kind, openable, originOf, loopback, answersGate, agentMay, appNames, nameToCheck, hereAddress, windowFor, APP_SCREENS, NOT_FROM_LINKS, bare, siteOf, underAppSite, couldBeLocal, onAppPort }
