// This Lite server's own addresses — shared by where a browser task runs (lib/browserRemote.js routeOf) and what the desktop app is
// told about this server (/api/config appOrigins).
import { config } from '../config.js'
import { urlOf } from './tenant.js'

// Whether an address is a page of this Lite server itself: the same host (any case, no trailing dot) on the same port — or both on
// a default port, either scheme (http 80 ≡ https 443) — as its public address or the tenant's own; behind the ProcessGPT gateway
// also the public host's siblings under the same parent domain (<tenant>.process-gpt.io — lib/workroom.js companyAddress); and for
// a server on this machine (a public address on localhost, *.localhost, 127/8, ::1) any of those names on the same port.
// http(s) and ws(s) only; anything else, or an address that does not parse, is not.
const WEB = new Set(['http:', 'https:', 'ws:', 'wss:'])
const DEFAULT_PORT = { 'http:': 80, 'ws:': 80, 'https:': 443, 'wss:': 443 }
function placeOf(u) {
  let x
  try { x = new URL(String(u)) } catch { return null }
  if (!WEB.has(x.protocol)) return null
  const host = x.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '')
  return host ? { host, port: x.port ? Number(x.port) : DEFAULT_PORT[x.protocol] } : null
}
const samePort = (a, b) => a.port === b.port || ([80, 443].includes(a.port) && [80, 443].includes(b.port))
const loopback = (h) => h === 'localhost' || h.endsWith('.localhost') || /^127\.\d+\.\d+\.\d+$/.test(h) || h === '::1' ||
  /^::ffff:127\.\d+\.\d+\.\d+$/.test(h) || /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(h)
export function liteOwnPage(url, { publicUrl = config.publicUrl, tenantUrl = urlOf(config.tenantId), gateway = config.tenantFromHeader } = {}) {
  const at = placeOf(url)
  if (!at) return false
  const pub = publicUrl ? placeOf(publicUrl) : null
  for (const base of [pub, tenantUrl ? placeOf(tenantUrl) : null]) {
    if (!base || !samePort(at, base)) continue
    if (at.host === base.host || (loopback(base.host) && loopback(at.host))) return true
  }
  if (gateway && pub && samePort(at, pub)) {
    const parent = pub.host.split('.').slice(1).join('.')
    if (parent.includes('.') && at.host.endsWith('.' + parent)) return true
  }
  return false
}

// the origins this server is reached at by its own account — its public address and the tenant's (a tunnel's address when that is the
// public one): the desktop app keeps its agent browser off them too, by whatever address it is connected to this server
export function ownOrigins({ publicUrl = config.publicUrl, tenantUrl = urlOf(config.tenantId) } = {}) {
  const out = []
  for (const u of [publicUrl, tenantUrl]) {
    try { const o = new URL(String(u)).origin; if (/^https?:/.test(o) && !out.includes(o)) out.push(o) } catch { /* not an address */ }
  }
  return out
}
