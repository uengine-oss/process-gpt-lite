// The sign-in steps of the auth server this app signs people in with (GoTrue: /auth/v1/authorize · /auth/v1/callback ·
// /auth/v1/verify), which this server's own browser does not open (lib/browserServer.js guardSignIn). Where they are taken:
//   · the auth server's own address (PRO_SUPABASE_URL, and PRO_SUPABASE_PUBLIC_URL when it is another)
//   · this app's own addresses, which pass /auth/v1/* on to it — the installed app's web server (install/docker/nginx.conf), the
//     ProcessGPT gateway on every company address (<tenant>.process-gpt.io, and under /lite) — the public address, the tenants' own
//     host names (PRO_TENANT_HOSTS) and, behind the gateway, the public host's siblings under its parent domain
// The Google connection this app makes itself (lib/googleConnect.js: Google's consent screen, /api/auth/google/*) is not one of them.
import { config } from '../config.js'

const STEPS = ['authorize', 'callback', 'verify']
const hostOf = (u) => { try { return new URL(String(u)).hostname.toLowerCase().replace(/\.+$/, '') } catch { return '' } }

// { hosts, parents }: the host names, and (behind the gateway) the parent domains whose hosts all count
export function signInPlaces(cfg = config) {
  const hosts = new Set([cfg.supabaseUrl, cfg.supabasePublicUrl, cfg.publicUrl].map(hostOf).filter(Boolean))
  for (const pair of String(cfg.tenantHosts || '').split(',')) {
    const h = pair.split('=')[0].trim().toLowerCase().replace(/\.+$/, '')
    if (h) hosts.add(h)
  }
  const parents = []
  if (cfg.tenantFromHeader) {
    const parent = hostOf(cfg.publicUrl).split('.').slice(1).join('.')
    if (parent.includes('.')) parents.push(parent)
  }
  return { hosts: [...hosts], parents }
}

// Whether an address is one of those steps: the path holds /auth/v1/authorize · callback · verify (any case, %-encoded or not, under
// any prefix — /lite/auth/v1/… — and with anything after it) on one of those hosts. Read from the parsed address.
export function isSignInStep(url, places = signInPlaces()) {
  let u
  try { u = new URL(String(url)) } catch { return false }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  const host = u.hostname.toLowerCase().replace(/\.+$/, '')
  if (!places.hosts.includes(host) && !places.parents.some((p) => host === p || host.endsWith(`.${p}`))) return false
  let path = u.pathname
  for (let i = 0; i < 3; i++) {
    let next = path
    try { next = decodeURIComponent(path) } catch { break }
    if (next === path) break
    path = next
  }
  const parts = path.toLowerCase().split(/[/\\]/).filter(Boolean)
  for (let i = 0; i + 2 < parts.length; i++) {
    if (parts[i] === 'auth' && parts[i + 1] === 'v1' && STEPS.some((s) => parts[i + 2].startsWith(s))) return true
  }
  return false
}

// The page loads to look at (CDP Fetch.enable patterns): documents only — a page, a frame, each hop of a redirect — on those hosts.
// isSignInStep decides; every other request is never paused.
// (each host as the address may spell it: with a user name before it, with the root's trailing dot after it, then a path or a port)
export function stepPatterns(places = signInPlaces()) {
  const names = [...places.hosts, ...places.parents.flatMap((p) => [p, `*.${p}`])]
  const urls = names.flatMap((h) => [h, `*@${h}`]).flatMap((h) => [h, `${h}.`]).flatMap((h) => [`*://${h}/*`, `*://${h}:*`])
  return urls.map((urlPattern) => ({ urlPattern, resourceType: 'Document', requestStage: 'Request' }))
}
