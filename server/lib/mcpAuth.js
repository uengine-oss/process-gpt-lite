// Who an MCP call is for (the /mcp gateways, mcp/*.js). MCP 경로도 화면 API 와 같은 로그인 확인(회사 소속 포함)을 쓴다:
// the same rules as auth() in index.js, in one place for every gateway.
// The caller's Supabase JWT comes as Authorization: Bearer … (deepagents fills in {{user_jwt}}).
//   - no token, or the placeholder {{user_jwt}} left as it is (mcp-hub's validator, health checks, tool caches): no person — the
//     anonymous catalog, as before (every tool call then answers 「unauthorized」)
//   - a token the auth server refuses: 401
//   - the auth server could not answer (slow, restarting): 503 + X-Auth-Retry, as auth() — no answer about the token
//   - behind the ProcessGPT gateway (PRO_TENANT_FROM_HEADER=1): a token that names its tenant (app_metadata.tenant_id — the tenant
//     the request works in, lib/tenant.js tenantMiddleware) needs a person who is a member of it (public.users), or 403, as auth();
//     a token without that claim goes on as before (the tenant resolved as it always was), noted in a debug line
//   - tenants by host name (PRO_TENANT_HOSTS): the call runs in the person's own tenant, as auth()
//   - one tenant: the person, as before
import { config } from '../config.js'
import { userFromJwt, isMember } from './supa.js'
import { multiTenant, tenantOfAuthUser, withTenant, jwtTenant } from './tenant.js'

const PLACEHOLDER = /^\{\{\s*user_jwt\s*\}\}$/
const UNAVAILABLE = { status: 503, code: -32000, message: 'auth unavailable', retry: true }

// → { user, jwt, placeholder, tenantId } (user null: the anonymous catalog) | { status, code, message, retry? }
export async function mcpUser(req) {
  const jwt = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  if (!jwt || PLACEHOLDER.test(jwt)) return { user: null, jwt: '', placeholder: !!jwt, tenantId: null }
  let u
  try { u = await userFromJwt(jwt, { unavailable: true }) } catch { return UNAVAILABLE }
  if (!u) return { status: 401, code: -32001, message: 'unauthorized: invalid or expired user JWT' }
  if (config.tenantFromHeader && !jwtTenant(jwt)) {
    console.debug(`[mcp-auth] ${String(u.id).slice(0, 8)}: no tenant claim in the token, tenant ${config.tenantId} as before`)
  } else if (config.tenantFromHeader) {
    let ok
    // (the membership could not be read: no answer either way, the caller retries — the call does not go on without it)
    try { ok = await isMember(u.id, config.tenantId) } catch { return UNAVAILABLE }
    if (!ok) return { status: 403, code: -32001, message: 'not a member of this tenant' }
  }
  return { user: u, jwt, placeholder: false, tenantId: multiTenant() ? tenantOfAuthUser(u) : null }
}

// a refused call as JSON-RPC (stateless streamable HTTP: no request id yet)
export function refuseMcp(res, r) {
  if (r.retry) res.set('X-Auth-Retry', '1')
  return res.status(r.status).json({ jsonrpc: '2.0', error: { code: r.code, message: r.message }, id: null })
}

// an MCP route behind the check: handler(req, res, { user, jwt, placeholder }) runs in the tenant auth() would run it in
export function mcpRoute(handler) {
  return async (req, res) => {
    const who = await mcpUser(req)
    if (who.status) return refuseMcp(res, who)
    return who.tenantId ? withTenant(who.tenantId, () => handler(req, res, who)) : handler(req, res, who)
  }
}
