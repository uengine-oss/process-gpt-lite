// Which tenant a piece of work runs in. config.tenantId reads it, so every query and service call that
// names the tenant follows it. Three ways to run:
//   - one tenant (PRO_TENANT_ID, default localhost): the install's, no lookups — as it always was
//   - behind the ProcessGPT gateway (PRO_TENANT_FROM_HEADER=1, <tenant>.process-gpt.io/lite): each request
//     names its own (X-Tenant-Id; the agents' MCP calls: the tenant in the caller's JWT), the person must be
//     a member (public.users), and background jobs go round the tenants that use Lite
//   - more tenants on their own host names (PRO_TENANT_HOSTS="en.localhost=en-demo": http://en.localhost:5180
//     is the English demo tenant on the same Vite and server, i18n/EN-DEMO.md). Process GPT takes the tenant
//     from the subdomain too; here only the hosts listed count:
//   - a request: the signed-in person's tenant (below); before sign-in, the host's
//   - a person's tenant: the one their account was made on — auth app_metadata.tenant_id, which only
//     the service key can write — when this server serves it; otherwise the default tenant (every
//     account made before this existed). An account cannot sign in on another tenant's host.
//   - background work for a person (mail, missions, process steps, cards): that person's tenant
//     (asUser in lib/lang.js); work for a tenant (scans, sweeps, registries): once per tenant
import { config } from '../config.js'
import { tenantStore } from './tenantStore.js'
import { L } from './lang.js'

const ID = /^[A-Za-z0-9_-]{1,64}$/
const HOSTS = new Map(String(config.tenantHosts || '').split(',').map((s) => s.trim()).filter(Boolean)
  .map((s) => s.split('=').map((x) => x.trim()))
  .filter(([h, t]) => h && t && ID.test(t))
  .map(([h, t]) => [h.toLowerCase(), t]))

export const DEFAULT_TENANT = config.defaultTenantId
const gateway = () => !!config.tenantFromHeader
// more than one tenant by host name (the gateway's own rule wins when both are set)
export const multiTenant = () => HOSTS.size > 0 && !gateway()
export const tenants = () => [...new Set([DEFAULT_TENANT, ...(multiTenant() ? HOSTS.values() : [])])]
export const servesTenant = (t) => !!t && (gateway() || tenants().includes(t))
export const tenant = () => config.tenantId
export const currentTenant = () => tenantStore.getStore()?.tenant
// the host names that reach a tenant (EN-DEMO.md, the sign-in refusal)
export const hostsOf = (t) => [...HOSTS].filter(([, x]) => x === t).map(([h]) => h)

export function withTenant(t, fn) {
  return tenantStore.run({ tenant: servesTenant(t) ? t : DEFAULT_TENANT }, fn)
}

// the host a request came to: Vite proxies /api with the browser's Host (changeOrigin: false);
// a proxy that rewrites Host passes the original as X-Forwarded-Host
export function hostTenant(req) {
  const raw = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().toLowerCase()
  const host = raw.replace(/^\[(.*)\](:\d+)?$/, '$1').replace(/:\d+$/, '')
  return HOSTS.get(host) || DEFAULT_TENANT
}

// an auth user (GoTrue, or a row of auth.users read as {app_metadata}) → its tenant here
export function tenantOfAuthUser(u) {
  const t = u?.app_metadata?.tenant_id ?? u?.raw_app_meta_data?.tenant_id
  return servesTenant(t) ? t : DEFAULT_TENANT
}

// a person's tenant by id (background work, the /mcp gateways). Cached for a little while: it only
// changes when an account is moved (scripts/en-demo.mjs).
const cache = new Map() // userId -> {t, at}
const TTL_MS = 60_000
export async function tenantOf(userId) {
  if (!multiTenant() || !userId) return DEFAULT_TENANT
  const id = String(userId)
  const hit = cache.get(id)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.t
  if (!/^[0-9a-f-]{36}$/i.test(id)) return DEFAULT_TENANT
  const { q } = await import('./supa.js')
  const [r] = await q('select raw_app_meta_data from auth.users where id=$1', [id]).catch(() => [])
  const t = tenantOfAuthUser(r)
  cache.set(id, { t, at: Date.now() })
  return t
}
export function forgetTenant(userId) { cache.delete(String(userId)) }

// (one tenant, or the gateway's: the work stays in the tenant it started in)
export async function asTenantOf(userId, fn) {
  if (!multiTenant()) return fn()
  return withTenant(await tenantOf(userId), fn)
}

// Behind the gateway: every tenant with someone who has used Lite (the list is refreshed each minute)
let liteTenants = { at: 0, ids: [] }
async function gatewayTenants() {
  if (liteTenants.at < Date.now() - 60000) {
    const { q } = await import('./supa.js')
    const rows = await q('select distinct u.tenant_id from users u where exists (select 1 from pro_threads t where t.user_id = u.id)')
    liteTenants = { at: Date.now(), ids: rows.map((r) => r.tenant_id) }
  }
  return liteTenants.ids
}

// A served tenant other than the default needs its process-gpt tenants row (users.tenant_id refers to
// it) and the agents need its MCP list there: this server's own gateways (pgpt-*), copied from the
// default tenant's list — never the other servers registered for the default tenant's demos.
const ensured = new Set()
export async function ensureTenantRow(t, ownerId = null) {
  if (!servesTenant(t) || t === DEFAULT_TENANT || (ensured.has(t) && !ownerId)) return
  const { q } = await import('./supa.js')
  const [d] = await q('select mcp from tenants where id=$1', [DEFAULT_TENANT]).catch(() => [])
  const ours = Object.fromEntries(Object.entries(d?.mcp?.mcpServers || {}).filter(([k]) => k.startsWith('pgpt-')))
  await q(`insert into tenants (id, owner, mcp) values ($1, $2, $3)
           on conflict (id) do update set mcp = jsonb_set(coalesce(tenants.mcp, '{"mcpServers":{}}'::jsonb), '{mcpServers}',
             coalesce(tenants.mcp->'mcpServers', '{}'::jsonb) || ($3::jsonb->'mcpServers'), true),
             owner = coalesce(tenants.owner, excluded.owner), is_deleted = false, deleted_at = null`,
  [t, ownerId, { mcpServers: ours }])
  ensured.add(t)
}

// fn once in every tenant this server serves (one failing tenant does not stop the others); with one
// tenant, fn as it is
export async function forEachTenant(fn, label = 'tenant') {
  if (!gateway() && !multiTenant()) return Promise.resolve().then(fn).catch((e) => console.warn(`[${label}]`, e?.message || e))
  for (const t of gateway() ? await gatewayTenants() : tenants()) {
    try { await withTenant(t, fn) } catch (e) { console.warn(`[${label}] ${t}:`, e?.message || e) }
  }
}

// The subject of a bearer token, read without checking it: it only picks the tenant the request
// runs in. Whatever uses the token checks it (auth(), the /mcp gateways), so a forged token gets
// no further than a wrong tenant for a request that is refused anyway.
export function jwtSubject(jwt) {
  const part = String(jwt || '').split('.')[1]
  if (!part) return null
  try { return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))?.sub || null } catch { return null }
}

// Express: the request's tenant (req.tenantId; auth() enters it again — a body parser in a route's own
// chain runs outside the request's async context)
//   gateway: the X-Tenant-Id it sets from the address; the agents' MCP calls come straight from
//            deepagents, so there the tenant in the caller's JWT (the token is verified where it is used)
//   hosts:   the token's person when there is a token, else the host's
const bearer = (req) => (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || (typeof req.query?.token === 'string' ? req.query.token : '')
const jwtTenant = (jwt) => { try { return JSON.parse(Buffer.from(String(jwt).split('.')[1], 'base64url')).app_metadata?.tenant_id || '' } catch { return '' } }
export function tenantMiddleware() {
  return (req, res, next) => {
    if (gateway()) {
      const t = (req.path.startsWith('/mcp') ? '' : String(req.headers['x-tenant-id'] || '').trim()) || jwtTenant(bearer(req))
      if (!t) return next()
      req.tenantId = t
      return withTenant(t, next)
    }
    if (!multiTenant()) return next()
    const jwt = bearer(req)
    const sub = /^\{\{/.test(jwt) ? null : jwtSubject(jwt)
    if (!sub) { req.tenantId = hostTenant(req); return withTenant(req.tenantId, next) }
    tenantOf(sub).then((t) => { req.tenantId = t; withTenant(t, next) }, next)
  }
}

// the web address of a tenant: the default one at PRO_PUBLIC_URL, the others on their host, same port
export function urlOf(t) {
  if (t === DEFAULT_TENANT) return config.publicUrl
  const h = hostsOf(t)[0]
  if (!h) return null
  try { const u = new URL(config.publicUrl); u.hostname = h; return u.origin } catch { return `http://${h}` }
}

export class TenantMismatch extends Error {
  constructor(t) {
    const at = urlOf(t)
    super(at
      ? L(`이 계정은 다른 작업 공간(${t})의 계정이에요. ${at} 에서 로그인해 주세요.`, `This account belongs to another workspace (${t}). Please sign in at ${at}.`)
      : L(`이 계정은 다른 작업 공간(${t})의 계정이에요.`, `This account belongs to another workspace (${t}).`))
    this.status = 403
  }
}
