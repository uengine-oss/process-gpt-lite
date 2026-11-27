// The ways into this app's own sign-in, which this server's own browser does not take (lib/browserServer.js watchTabs): it never
// signs in to Lite or ProcessGPT as anyone — whether the agent, a page or the person's own takeover drives it.
//   · the auth server's sign-in steps (GoTrue /auth/v1/authorize · callback · verify · token · otp · signup · recover · magiclink · sso):
//     any request, on the auth server's own address and on this app's addresses, which pass /auth/v1/* on to it
//   · Lite's own sign-in API (/api/auth/email/start · /api/auth/email/verify · /api/auth/google/start · /api/auth/refresh): any request
//   · ProcessGPT's single sign-on (/pi-system-backend/auth/sso/…): any request
//   · the sign-in screens, as pages: Lite's /login and /auth/done; ProcessGPT's /auth/login · /auth/register · /auth/forgot-password ·
//     /auth/reset-password · /auth/two-step · /tenant/register and /auth (where its single sign-on comes back)
// Lite's paths with or without its public path in front (/lite behind the gateway). Where: the auth server's steps on the auth
// server's address (PRO_SUPABASE_URL, and PRO_SUPABASE_PUBLIC_URL when it is another) and on this app's own — the installed app's
// web server (install/docker/nginx.conf), the ProcessGPT gateway on every company address (<tenant>.process-gpt.io): the public
// address, the tenants' own host names (PRO_TENANT_HOSTS) and, behind the gateway, the public host's siblings under its parent
// domain; the sign-in API and screens on this app's own pages only (lib/liteOwn.js liteOwnPage: those hosts on the app's own port).
// The Google connection this app makes in that browser (lib/googleConnect.js mode 'browser': Google's consent screen,
// /api/auth/google/callback, /api/auth/google/done) is not one of them.
import { config } from '../config.js'
import { liteOwnPage } from './liteOwn.js'
import { urlOf } from './tenant.js'

const AUTH_STEPS = ['authorize', 'callback', 'verify', 'token', 'otp', 'signup', 'recover', 'magiclink', 'sso']
const LITE_API = ['/api/auth/email/start', '/api/auth/email/verify', '/api/auth/google/start', '/api/auth/refresh']
const API_STARTS = ['/pi-system-backend/auth/sso/']
const SCREENS = ['/login', '/auth/done', '/auth', '/auth/login', '/auth/register', '/auth/forgot-password', '/auth/reset-password', '/auth/two-step', '/tenant/register']
const hostOf = (u) => { try { return new URL(String(u)).hostname.toLowerCase().replace(/\.+$/, '') } catch { return '' } }
const pathOf = (u) => { try { return new URL(String(u)).pathname.replace(/\/+$/, '') } catch { return '' } }

// { hosts, parents, prefixes, app }: the host names, (behind the gateway) the parent domains whose hosts all count, the paths Lite may
// be served under, and what tells this app's own pages (liteOwnPage's options)
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
  const prefixes = [...new Set([pathOf(cfg.publicUrl).toLowerCase(), '/lite'].filter(Boolean))]
  const app = { publicUrl: cfg.publicUrl || '', tenantUrl: cfg === config ? urlOf(config.tenantId) : (cfg.tenantUrl || null), gateway: !!cfg.tenantFromHeader }
  return { hosts: [...hosts], parents, prefixes, app }
}

// whether an address is on one of those hosts (http · https) — a loopback name for a loopback one (localhost ≡ 127.0.0.1 ≡ ::1 ≡
// *.localhost: lib/liteOwn.js does the same)
const loopback = (h) => h === 'localhost' || h.endsWith('.localhost') || /^127\.\d+\.\d+\.\d+$/.test(h) || h === '::1' || h === '[::1]'
export function onPlaces(url, places = signInPlaces()) {
  let u
  try { u = new URL(String(url)) } catch { return false }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  const host = u.hostname.toLowerCase().replace(/\.+$/, '')
  return places.hosts.includes(host) || places.parents.some((p) => host === p || host.endsWith(`.${p}`)) ||
    (loopback(host) && places.hosts.some(loopback))
}

// Whether a request is a way into the sign-in (document: it is a page load — a page, a frame, a hop of a redirect). Read from the
// parsed address: its path decoded (%-encoding, any case, doubled slashes), the auth server's steps under any prefix and with anything
// after them.
export function isSignInStep(url, places = signInPlaces(), { document = true } = {}) {
  if (!onPlaces(url, places)) return false
  let path = new URL(String(url)).pathname
  for (let i = 0; i < 3; i++) {
    let next = path
    try { next = decodeURIComponent(path) } catch { break }
    if (next === path) break
    path = next
  }
  const parts = path.toLowerCase().split(/[/\\]/).filter(Boolean)
  for (let i = 0; i + 2 < parts.length; i++) {
    if (parts[i] === 'auth' && parts[i + 1] === 'v1' && AUTH_STEPS.some((s) => parts[i + 2].startsWith(s))) return true
  }
  // (the sign-in API and screens: this app's own pages only — another site's /login is its own)
  if (!places.app || !liteOwnPage(url, places.app)) return false
  const full = `/${parts.join('/')}`
  const paths = [full, ...(places.prefixes || []).filter((p) => full.startsWith(`${p}/`)).map((p) => full.slice(p.length))]
  if (paths.some((p) => LITE_API.includes(p) || API_STARTS.some((s) => `${p}/`.startsWith(s)))) return true
  return document && paths.some((p) => SCREENS.includes(p))
}

// The requests to look at (CDP Fetch.enable patterns): every request, of any kind, to those hosts (its path however it is written —
// %-encoded, doubled slashes — is read by isSignInStep, which decides). Every other request is never paused.
// (each host as the address may spell it: with a user name before it, with the root's trailing dot after it, then a path or a port)
export function stepPatterns(places = signInPlaces()) {
  const names = [...places.hosts, ...places.parents.flatMap((p) => [p, `*.${p}`])].flatMap((h) => [h, `*@${h}`]).flatMap((h) => [h, `${h}.`])
  return names.flatMap((h) => [`*://${h}/*`, `*://${h}:*`]).map((urlPattern) => ({ urlPattern, requestStage: 'Request' }))
}
