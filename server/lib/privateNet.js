// Addresses on this server's own network, which this server's browser does not open (lib/browserServer.js guardSignIn): loopback
// (localhost, *.localhost, 127/8, ::1), private, link-local, CGNAT and the other non-public ranges, a cluster's Service range
// (lib/linkPreview.js isBlockedAddress — the link preview's own rules), names of one label (a container's or a Service's short name:
// web, kong, mailpit …), names that only mean something inside a network (*.svc, *.cluster.local, *.internal, *.local, *.lan …), and
// — for a page load — a name that resolves to such an address (this machine's resolver, as the browser resolves it). Not even a page
// load, a frame or a page's own request goes there.
//   · This app's own address is not one of them (lib/liteOwn.js liteOwnPage: its public address, and on a server on this machine any
//     of its loopback names on the same port) — there the sign-in rules apply (lib/signInSteps.js).
//   · PRO_BROWSER_PRIVATE_ALLOW: addresses a company's tasks may open on its own network (comma separated: an origin
//     http://intranet.corp:8080, a host any port intranet.corp, or *.corp.example — a host of letters, digits, dots and hyphens or an
//     IP address, a suffix of two labels or more ending in a name; any other entry is left out, and said in the log). Empty by default.
//   · The browser's own forward proxy (HTTPS_PROXY · HTTP_PROXY · ALL_PROXY, a --proxy-server, or wpad when it detects one) is reached
//     by its name however short (hostRules).
//   · A mailbox (Mailpit — the bundled install's sign-in mail, a name whose first label is mailpit, or its port 8025 on such an
//     address) is never opened, allowed or not.
import dns from 'node:dns'
import net from 'node:net'
import { config } from '../config.js'
import { isBlockedAddress, hostRefusal } from './linkPreview.js'
import { liteOwnPage } from './liteOwn.js'

const MAIL_PORT = 8025
const hostOf = (u) => u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '')
const portOf = (u) => Number(u.port) || ({ 'http:': 80, 'ws:': 80, 'https:': 443, 'wss:': 443 })[u.protocol] || 0

// the allowed addresses (read when the browser starts: PRO_BROWSER_PRIVATE_ALLOW, else config). Only what reads as one is taken: a
// host of letters, digits, dots and hyphens, or an IP address; *. and a suffix of two labels or more whose last one is a name (not
// *.0.5, which would be every address ending so); an origin of http(s) with such a host and nothing after it. Nothing else — no *, no
// spaces, nothing Chromium's resolver rules would read as their own words (hostRules) — is taken.
const NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/
const goodHost = (h) => NAME.test(h) || !!net.isIP(h)
const goodSuffix = (x) => NAME.test(x) && x.includes('.') && /[a-z]/.test(x.split('.').at(-1))
export function allowedPrivate(raw = process.env.PRO_BROWSER_PRIVATE_ALLOW ?? config.browserPrivateAllow) {
  const out = []
  for (const x of String(raw || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    let entry = null
    if (/^https?:\/\/[^/?#]+\/?$/.test(x)) {
      try { const u = new URL(x); if (!u.username && !u.password && goodHost(hostOf(u))) entry = { origin: `${u.protocol}//${hostOf(u)}:${portOf(u)}` } } catch { /* below */ }
    } else if (x.startsWith('*.')) {
      if (goodSuffix(x.slice(2))) entry = { suffix: x.slice(1) }
    } else {
      const h = x.replace(/^\[|\]$/g, '')
      if (goodHost(h)) entry = { host: h }
    }
    if (entry) out.push(entry)
    else console.warn('[browser] PRO_BROWSER_PRIVATE_ALLOW: left out, not an address, a host or *.suffix:', JSON.stringify(x.slice(0, 80)))
  }
  return out
}
const isAllowed = (u, allow) => allow.some((a) => (a.origin && a.origin === `${u.protocol}//${hostOf(u)}:${portOf(u)}`) || (a.host && a.host === hostOf(u)) ||
  (a.suffix && hostOf(u).endsWith(a.suffix)))

// a mailbox, by its name or its port on a private address — never opened
export function isMailbox(url) {
  let u
  try { u = new URL(String(url)) } catch { return false }
  const h = hostOf(u)
  return h.split('.')[0] === 'mailpit' || (portOf(u) === MAIL_PORT && !!hostRefusal(h))
}

// resolving a name for a page load: as the browser does (the system's resolver, its search domains too), a minute's memory
const resolved = new Map() // host -> { at, blocked }
const RESOLVE_MS = 60000
const SLOW_MS = 5000
const lookupAll = (host) => dns.promises.lookup(host, { all: true })
async function resolvesPrivate(host, lookup = lookupAll, now = Date.now()) {
  const hit = resolved.get(host)
  if (hit && now - hit.at < RESOLVE_MS) return hit.blocked
  let blocked
  try {
    const addrs = await Promise.race([lookup(host), new Promise((_, no) => setTimeout(() => no(new Error('slow')), 5000).unref?.())])
    blocked = (addrs || []).some((a) => isBlockedAddress(a.address))
  } catch (e) {
    // (a name that does not resolve opens nowhere anyway; one the resolver does not answer in time is not opened — and asked again
    // a few seconds later, not remembered for the minute)
    blocked = e?.message === 'slow'
    if (blocked) { resolved.set(host, { at: now - RESOLVE_MS + SLOW_MS, blocked }); return blocked }
  }
  resolved.set(host, { at: now, blocked })
  while (resolved.size > 1000) resolved.delete(resolved.keys().next().value)
  return blocked
}
export const forgetResolved = () => resolved.clear()

// 'private' | 'mailbox' | null: whether a request is refused as going to this server's own network (document: a page load —
// only then is a name resolved)
export async function privateRefusal(url, { document = false, allow = allowedPrivate(), lookup } = {}) {
  let u
  try { u = new URL(String(url)) } catch { return null }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(u.protocol)) return null
  if (isMailbox(url)) return 'mailbox'
  if (liteOwnPage(url) || isAllowed(u, allow)) return null
  const h = hostOf(u)
  if (hostRefusal(h)) return 'private'
  if (document && !net.isIP(h) && await resolvesPrivate(h, lookup)) return 'private'
  return null
}

// The requests to look at (CDP Fetch.enable patterns): every page load (its name is resolved), and of any kind those that go by
// name or number to such an address — loopback, the private and other non-public IPv4 ranges (and the cluster Service range of
// lib/linkPreview.js DEFAULT_DENY_CIDRS), IPv6 by number, names under the inside-only suffixes, names with the root's trailing dot.
// Names of one label never resolve in this browser (hostRules); every other request is never paused.
const SUFFIXES = ['localhost', 'local', 'localdomain', 'internal', 'intranet', 'lan', 'corp', 'home.arpa', 'svc', 'cluster.local']
export function privatePatterns() {
  const starts = ['0', '10', '127', '169.254', '192.168', '192.0.0', '192.0.2', '192.88.99', '198.51.100', '203.0.113', '198.18', '198.19']
  for (let b = 16; b <= 31; b++) starts.push(`172.${b}`)
  for (let b = 64; b <= 127; b++) starts.push(`100.${b}`)
  for (let a = 224; a <= 255; a++) starts.push(String(a))
  for (let c = 224; c <= 239; c++) starts.push(`34.118.${c}`)
  const urls = [...starts.map((s) => `*://${s}.*`), '*://[*', '*://localhost*', '*://*./*', '*://*.:*',
    ...SUFFIXES.flatMap((s) => [`*://*.${s}/*`, `*://*.${s}:*`, `*://*.${s}./*`, `*://*.${s}.:*`])]
  return [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }, ...urls.map((urlPattern) => ({ urlPattern, requestStage: 'Request' }))]
}

// The forward proxy this browser goes through, by name: what Chromium reads from the environment (HTTPS_PROXY · HTTP_PROXY ·
// ALL_PROXY, either case) and from its own flags (--proxy-server, wpad for --proxy-auto-detect), and Playwright's proxy option
export function proxyHosts({ env = process.env, args = [], proxy = null } = {}) {
  const out = new Set()
  const add = (v) => {
    for (const one of String(v || '').split(/[;,]/)) {
      const raw = one.trim().replace(/^[a-z]+=/i, '')
      if (!raw) continue
      try { out.add(hostOf(new URL(raw.includes('://') ? raw : `http://${raw}`))) } catch { /* not an address */ }
    }
  }
  for (const k of ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY']) add(env[k] ?? env[k.toLowerCase()])
  for (const a of args) {
    if (a.startsWith('--proxy-server=')) add(a.slice('--proxy-server='.length))
    if (a === '--proxy-auto-detect') out.add('wpad')
  }
  if (proxy?.server) add(proxy.server)
  return [...out].filter(Boolean)
}

// The browser's own resolver: a name of one label resolves to nothing (Chromium --host-resolver-rules), but localhost, IPv6 numbers
// (the patterns above decide on those), the allowed one-label names and the browser's own proxy — never a mailbox. (only names
// allowedPrivate and proxyHosts took, and only of letters, digits and hyphens, ever reach the flag)
export function hostRules(allow = allowedPrivate(), { proxies = proxyHosts() } = {}) {
  const own = allow.flatMap((a) => (a.host ? [a.host] : a.origin ? [new URL(a.origin).hostname.replace(/^\[|\]$/g, '')] : []))
  let pub = ''
  try { pub = new URL(config.publicUrl).hostname.toLowerCase() } catch { /* none */ }
  const oneLabel = (h) => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(h) && h !== 'mailpit'
  const keep = [...new Set(['localhost', ...own, ...proxies, pub].filter(oneLabel))]
  return ['MAP * ~NOTFOUND', 'EXCLUDE *.*', 'EXCLUDE *:*', ...keep.map((h) => `EXCLUDE ${h}`)].join(', ')
}
