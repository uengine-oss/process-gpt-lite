// Whether this tenant's agent gets each built-in tool server (mcp/toolServers.js): /api/config agentTools, booleans only.
// The agents (process-gpt-deepagents) load the servers of the tenant's tenants.mcp.mcpServers merged with process-gpt's
// common list (COMMON_MCP_SERVERS: the user's decision of 2026-11-25, 「기본 툴들은 공통 mcp 이므로, 테넌트에 따로 등록
// 관계없이 등록될 수 있도록」). An editor and its CLI on this server with none of these behind it is the 2026-11-25
// production fault (「PhotoCraft 편집 도구가 현재 연결되지 않아 …」): the page opens the app, the agent cannot reach it.
// The deploy check (e2e tests/deploy/agent-tools.spec.js, D-AT-*) fails on it.
// A tool counts as wired when one of these holds; `via` says which (labels only — no URL, header or key leaves here):
//   tenant  tenants.mcp.mcpServers has an entry, under any key (keys differ between installs), that reaches this server:
//           enabled, its URL path ends at /mcp/<path>, it passes the person's token (Authorization … {{user_jwt}}; without it
//           every call is refused as unauthorized), and its host is not a loopback one where the agents run elsewhere
//   common  deepagents' common list (GET <PRO_DEEPAGENTS_URL>/mcp/common → {servers: [names]}) has the name and that common
//           entry is the one the agent gets. deepagents (merge_common_mcp_servers) lets a tenant entry of the same name win:
//           with a url or command it replaces the common entry outright; without one it is laid over it ({enabled:false}
//           switches it off, {enabled:true} keeps the common URL). deepagents does not tell the common URLs: the name is trusted.
// and two labels that are not sources (each can only make a tool false):
//   tenant-overrides-common-with-other-url  the tenant has its own entry under the built-in name with a url (or command)
//           that does not reach this server (a row copied from another install, a loopback address, an old path): it
//           replaces the common entry, so the agent gets that one. Shown whether or not the common list is up yet.
//   hub-filtered  an mcp-hub answers here (PRO_MCP_HUB_URL; local development) and does not have the server by name. A hub
//           never gives the agent a server — the connection always comes from the tenant list or the common list — but
//           deepagents drops the servers the hub does not allow, so the tool is not wired. Production has no hub.
// Fails closed: when the tenant's row cannot be read (database error, timeout) every tool is false. A hub or a common list
// that does not answer is just not there (a deepagents without /mcp/common answers 404).
// Cached per tenant for a minute (the page and the pod's probe read /api/config often), a failure for 10 seconds; the
// common list for a minute.
import { config } from '../config.js'
import { LITE_TOOL_SERVERS } from '../mcp/toolServers.js'

const TTL_MS = 60_000
const FAIL_TTL_MS = 10_000
const DB_TIMEOUT_MS = 1500
const HUB_TIMEOUT_MS = 1000
const COMMON_TIMEOUT_MS = 1500
const USER_TOKEN = '{{user_jwt}}'
export const OVERRIDDEN = 'tenant-overrides-common-with-other-url'
export const HUB_FILTERED = 'hub-filtered'
const SOURCES = new Set(['tenant', 'common'])
export const wired = (via) => via.some((s) => SOURCES.has(s)) && !via.includes(HUB_FILTERED)

const urlOf = (u) => { try { return new URL(String(u)) } catch { return null } }
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0'])
const isLoopback = (u) => !!u && (LOOPBACK.has(u.hostname) || u.hostname.endsWith('.localhost'))
// Where the agents run: on this machine (local development: a loopback URL reaches this server) or elsewhere — behind the
// ProcessGPT gateway (deepagents in its own pod), or when this server's address for engines and agents (PRO_MCP_RUNTIME_BASE,
// the Docker install's http://server:8787; PRO_GIT_URL, the cluster Service) is not a loopback one
export const agentsElsewhere = () => !!config.tenantFromHeader
  || [process.env.PRO_MCP_RUNTIME_BASE, config.gitUrl].some((b) => { const u = b && urlOf(b); return !!u && !isLoopback(u) })

const hasTarget = (cfg) => !!cfg && typeof cfg === 'object' && (!!cfg.url || !!cfg.command)
const passesUserToken = (cfg) => Object.entries(cfg.headers || {}).some(([k, v]) => k.toLowerCase() === 'authorization' && String(v).includes(USER_TOKEN))
// this entry (enabled or not) is addressed to this server's /mcp/<path> for the tool
function addressedHere(tool, cfg, elsewhere) {
  const u = urlOf(cfg?.url)
  if (!u || (elsewhere && isLoopback(u))) return false
  const p = u.pathname.replace(/\/+$/, '')
  return tool.paths.some((x) => p.endsWith(`/mcp/${x}`))
}
// an entry the agent would use to reach this server's tool: enabled, addressed here, with the person's token
export const reaches = (tool, cfg, elsewhere = agentsElsewhere()) => !!cfg && typeof cfg === 'object' && cfg.enabled !== false
  && addressedHere(tool, cfg, elsewhere) && passesUserToken(cfg)
export const tenantReaches = (tool, servers, elsewhere = agentsElsewhere()) => Object.values(servers || {}).some((cfg) => reaches(tool, cfg, elsewhere))

// The decision, without I/O. hub, common: Set of server names, or null (not there). tenant: the tenant's mcpServers
// object, null when it has none, undefined when it could not be read (→ nothing). elsewhere: agentsElsewhere().
// → {key: [labels]}
export function decide({ hub = null, common = null, tenant, elsewhere = agentsElsewhere() }) {
  const out = {}
  for (const tool of LITE_TOOL_SERVERS) {
    const via = []
    if (tenant !== undefined) {
      const own = tenant?.[tool.server]
      const off = own?.enabled === false
      if (tenantReaches(tool, tenant, elsewhere)) via.push('tenant')
      // the tenant's own entry of that name replaces the common one when it names a place of its own
      if (!off && !hasTarget(own) && common?.has(tool.server)) via.push('common')
      if (hasTarget(own) && !addressedHere(tool, own, elsewhere)) via.push(OVERRIDDEN)
      if (hub && !hub.has(tool.server)) via.push(HUB_FILTERED)
    }
    out[tool.key] = via
  }
  return out
}

// {key: x} → {office, folders, panelapps, improve, craft: {app: …}} (the /api/config shape)
export function shape(byKey, f = (v) => v) {
  const out = { craft: {} }
  for (const [key, v] of Object.entries(byKey)) {
    if (key.startsWith('craft.')) out.craft[key.slice('craft.'.length)] = f(v)
    else out[key] = f(v)
  }
  return out
}
export const none = () => decide({ tenant: undefined })

// server names out of a list answer: ["pgpt-x", …], [{name}, …], {servers: […]} or {items: […]}
const namesOf = (body) => new Set((Array.isArray(body) ? body : body?.servers || body?.items || [])
  .map((x) => (typeof x === 'string' ? x : x?.name)).filter((n) => typeof n === 'string' && n))

async function getJson(url, { headers = {}, timeout }) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(timeout) })
  if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status })
  return r.json()
}
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error(`${what}: no answer in ${ms} ms`)), ms).unref?.())])

// deps (tests): readTenant(t) → mcpServers object | null, throws when it cannot read; hubServers(t) / commonServers() →
// Set of names, or null when that one is not there
export function agentToolsChecker({
  hubUrl = process.env.PRO_MCP_HUB_URL || 'http://127.0.0.1:8500',
  deepagentsUrl = config.deepagentsUrl,
  readTenant, hubServers, commonServers, elsewhere,
  now = Date.now, log = (m) => console.warn(m),
} = {}) {
  readTenant ||= async (t) => {
    const { q } = await import('./supa.js')
    const [row] = await q('select mcp from tenants where id=$1', [t])
    return row ? (row.mcp?.mcpServers || {}) : null
  }
  hubServers ||= (t) => getJson(`${hubUrl.replace(/\/+$/, '')}/servers`, { headers: { 'X-Tenant-Id': t }, timeout: HUB_TIMEOUT_MS })
    .then(namesOf, () => null)
  commonServers ||= () => getJson(`${String(deepagentsUrl || '').replace(/\/+$/, '')}/mcp/common`, { timeout: COMMON_TIMEOUT_MS })
    .then(namesOf, () => null)

  let common = null // {at, names: Promise<Set|null>}
  const commonNow = () => {
    if (!common || now() - common.at >= TTL_MS) common = { at: now(), names: Promise.resolve().then(commonServers).catch(() => null) }
    return common.names
  }

  const cache = new Map() // tenant → {at, ttl, result: Promise}
  const unwired = new Map() // tenant → the last "not wired" line logged
  async function compute(t) {
    const [read, hub, commonNames] = await Promise.all([
      withTimeout(Promise.resolve().then(() => readTenant(t)), DB_TIMEOUT_MS, 'tenant MCP list').then((servers) => ({ servers }), (error) => ({ error })),
      Promise.resolve().then(() => hubServers(t)).catch(() => null),
      commonNow(),
    ])
    const failed = 'error' in read
    const via = decide({ hub, common: commonNames, tenant: failed ? undefined : read.servers, elsewhere: elsewhere ?? agentsElsewhere() })
    const missing = Object.entries(via).filter(([, v]) => !wired(v))
      .map(([k, v]) => `${k.replace(/^craft\./, '')}${v.includes(OVERRIDDEN) ? ' (its own tenant entry points elsewhere)' : v.includes(HUB_FILTERED) ? ' (the mcp-hub does not have it)' : ''}`)
    const line = failed ? `tenant MCP list unreadable (${String(read.error?.message || read.error).slice(0, 120)}): reporting no tools`
      : missing.length ? `not wired to the agent: ${missing.join(', ')} (no tenant MCP entry or common list reaches this server)` : ''
    if (line !== (unwired.get(t) || '')) { unwired.set(t, line); if (line) log(`[agent-tools] ${t}: ${line}`) }
    return { via, failed }
  }

  // → {tools: {office, folders, …, craft: {app: bool}}, via: the same shape with the sources}
  async function forTenant(t) {
    let hit = cache.get(t)
    if (!hit || now() - hit.at >= hit.ttl) {
      hit = { at: now(), ttl: TTL_MS, result: compute(t) }
      cache.set(t, hit)
      hit.result.then((r) => { if (r.failed) hit.ttl = FAIL_TTL_MS }, () => { hit.ttl = FAIL_TTL_MS })
    }
    const { via } = await hit.result.catch(() => ({ via: none() }))
    return { tools: shape(via, wired), via: shape(via) }
  }
  return { forTenant, forget: () => { cache.clear(); common = null } }
}

export const agentTools = agentToolsChecker()
