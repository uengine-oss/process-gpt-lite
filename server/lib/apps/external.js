// MCP Apps from other servers, shown in Lite (docs/robo-dlc/plan-mcp-apps.md §7). The servers are the tenant's own MCP
// registry (tenants.mcp.mcpServers — what process-gpt's agents use; Lite's own pgpt-* left out), plus, on a development
// server, PRO_APPS_EXTERNAL ({"name": {"url": …}}) so a trial needs no change to the shared registry. Lite never hands
// a server's address or headers to the page: the page speaks MCP to /api/apps/x/<name>/mcp and this server passes
// the conversation on (Streamable HTTP, session id included). Their screens are third-party code: the page shows them
// only in a frame that cannot reach Lite (src/apps/AppFrame.vue).
import { q } from '../supa.js'
import { config } from '../../config.js'

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/
let cache = { at: 0, tenant: null, servers: {} }

function devServers() {
  try { return JSON.parse(process.env.PRO_APPS_EXTERNAL || '{}') } catch { console.warn('[apps] PRO_APPS_EXTERNAL is not JSON'); return {} }
}

// name -> { url, headers } for the tenant of this request
export async function externalServers() {
  const tenant = config.tenantId
  if (cache.tenant !== tenant || Date.now() - cache.at > 60_000) {
    const [t] = await q('select mcp from tenants where id=$1', [tenant]).catch(() => [])
    const servers = {}
    for (const [name, s] of Object.entries({ ...(t?.mcp?.mcpServers || {}), ...devServers() })) {
      if (!NAME.test(name) || name.startsWith('pgpt-') || s?.enabled === false || !/^https?:\/\//.test(String(s?.url || ''))) continue
      servers[name] = { url: s.url, headers: s.headers || {} }
    }
    cache = { at: Date.now(), tenant, servers }
  }
  return cache.servers
}

const PASS_UP = ['content-type', 'accept', 'mcp-protocol-version', 'mcp-session-id', 'last-event-id']
const PASS_DOWN = ['content-type', 'mcp-session-id', 'cache-control']

// one MCP request of the page, passed on to the server `name` (its registered headers added here)
export async function relay(req, res, name) {
  const s = (await externalServers())[name]
  if (!s) return res.status(404).json({ jsonrpc: '2.0', error: { code: -32001, message: 'no such MCP server' }, id: null })
  const headers = { ...Object.fromEntries(PASS_UP.filter((h) => req.headers[h]).map((h) => [h, req.headers[h]])), ...s.headers }
  const ctrl = new AbortController()
  res.on('close', () => ctrl.abort())
  try {
    const r = await fetch(s.url, { method: req.method, headers, body: req.method === 'POST' ? JSON.stringify(req.body) : undefined, signal: ctrl.signal, redirect: 'error' })
    res.status(r.status)
    for (const h of PASS_DOWN) if (r.headers.get(h)) res.setHeader(h, r.headers.get(h))
    if (!r.body) return res.end()
    for await (const chunk of r.body) res.write(chunk)
    res.end()
  } catch (e) {
    if (ctrl.signal.aborted) return
    console.warn('[apps] external', name, e.message)
    if (!res.headersSent) res.status(502).json({ jsonrpc: '2.0', error: { code: -32002, message: 'the MCP server did not answer' }, id: null })
    else res.end()
  }
}
