// Connector MCP gateway (streamable HTTP, stateless) at /mcp.
// The caller's Supabase JWT (Authorization: Bearer …) identifies the user; each tool runs with
// that user's own token from the vault, so one tenant-level MCP registration in process-gpt
// serves every user. Only connectors the user has connected show up in tools/list.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { userFromJwt } from '../lib/supa.js'
import { google } from './connectors/google.js'
import { youtube } from './connectors/youtube.js'
import { slackConnector, githubConnector, notionConnector } from './connectors/saas.js'

export const CONNECTORS = [google, youtube, slackConnector, githubConnector, notionConnector]

const HUB = process.env.PRO_MCP_HUB_URL || 'http://127.0.0.1:8500'
export const hubServerName = (connector) => `pgpt-${connector}`
// tools that need no account (ArtCraft apps, mcp/craft.js): bound for everyone
const ALWAYS = ['pgpt-folders', 'pgpt-panelapps', 'pgpt-cadcraft', 'pgpt-vectorcraft', 'pgpt-photocraft', 'pgpt-soundcraft', 'pgpt-filmcraft', 'pgpt-ieumoffice-live-editor']

// process-gpt's mcp-hub lets an agent (in chat: the chatting user) use only the servers bound to
// it. Bind the hub server of every connector the user has connected; keep unrelated bindings.
export async function ensureHubBinding(userId, tenantId) {
  const h = { 'X-Tenant-Id': tenantId, 'Content-Type': 'application/json' }
  try {
    const servers = await (await fetch(`${HUB}/servers`, { headers: h })).json()
    const byName = new Map((Array.isArray(servers) ? servers : servers.servers || servers.items || []).map((x) => [x.name, x]))
    const ours = new Set([...CONNECTORS.map((c) => byName.get(hubServerName(c.name))?.id), ...ALWAYS.map((n) => byName.get(n)?.id)].filter(Boolean))
    const want = ALWAYS.map((n) => byName.get(n)?.id).filter(Boolean)
    for (const c of CONNECTORS) {
      const srv = byName.get(hubServerName(c.name))
      if (srv && await c.connected(userId).catch(() => false)) want.push(srv.id)
    }
    const cur = await (await fetch(`${HUB}/agents/${userId}/bindings`, { headers: h })).json()
    const keep = (Array.isArray(cur) ? cur : cur.bindings || [])
      .filter((b) => !ours.has(b.server_id))
      .map((b) => ({ server_id: b.server_id, allowed_tools: b.allowed_tools ?? null, enabled: b.enabled !== false }))
    const next = [...keep, ...want.map((id) => ({ server_id: id, allowed_tools: null, enabled: true }))]
    const r = await fetch(`${HUB}/agents/${userId}/bindings`, { method: 'PUT', headers: h, body: JSON.stringify(next) })
    return { bound: want.length, ok: r.ok }
  } catch (e) {
    return { bound: 0, ok: false, reason: e.message }
  }
}

export async function connectorStatus(userId) {
  return Promise.all(CONNECTORS.map(async (c) => ({ name: c.name, title: c.title, connected: await c.connected(userId).catch(() => false), tools: c.tools.map((t) => t.name) })))
}

// user = null: anonymous catalog (mcp-hub validation, health checks, tool cache). Every tool is
// listed so the hub can govern them, but calling any of them requires the user's JWT.
async function buildServer(user, only) {
  const server = new McpServer({ name: only ? `pgpt-${only}` : 'pgpt-connectors', version: '1.0.0' })
  for (const c of CONNECTORS.filter((x) => !only || x.name === only)) {
    // A per-connector endpoint always lists its tools (an MCP server with none fails the client's
    // tools/list); calls on a connector the user has not connected explain how to connect it.
    const connected = user ? await c.connected(user.id).catch(() => false) : false
    if (user && !connected && !only) continue
    for (const t of c.tools) {
      if (user && connected && c.allowed && !(await c.allowed(user.id, t.name))) continue
      server.registerTool(t.name, { description: t.description, inputSchema: t.input }, async (args) => {
        if (!user) return { isError: true, content: [{ type: 'text', text: 'unauthorized: call with the user JWT (Authorization: Bearer {{user_jwt}})' }] }
        console.log(`[mcp] ${t.name} user=${user.id.slice(0, 8)}`)
        if (!connected) return { isError: true, content: [{ type: 'text', text: `${c.title} 이(가) 연결되지 않았어요. 설정 → 계정 → 연결에서 연결한 뒤 다시 시도하세요.` }] }
        try {
          const out = await t.run(user.id, args || {})
          return { content: [{ type: 'text', text: JSON.stringify(out, null, 1) }] }
        } catch (e) {
          return { isError: true, content: [{ type: 'text', text: e.message }] }
        }
      })
    }
  }
  return server
}

export function mountConnectors(app) {
  // /mcp serves every connector; /mcp/<name> one connector, so each can be its own
  // mcp-hub server and its own entry in process-gpt's system registry (systems).
  app.post(['/mcp', '/mcp/:connector'], async (req, res) => {
    const only = req.params.connector
    if (only && !CONNECTORS.some((c) => c.name === only)) return res.status(404).json({ jsonrpc: '2.0', error: { code: -32601, message: `unknown connector ${only}` }, id: null })
    let jwt = (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
    // the hub's validator sends the registered header as-is; an unresolved placeholder means "no user"
    if (/^\{\{\s*user_jwt\s*\}\}$/.test(jwt)) jwt = ''
    const user = jwt ? await userFromJwt(jwt) : null
    // a token that is present but invalid is an error; no token at all gets the anonymous catalog
    if (jwt && !user) return res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'unauthorized: invalid or expired user JWT' }, id: null })
    const server = await buildServer(user, only)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => { transport.close(); server.close() })
    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)
  })
  // stateless server: no SSE stream or session teardown
  const notAllowed = (req, res) => res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null })
  app.get(['/mcp', '/mcp/:connector'], notAllowed)
  app.delete(['/mcp', '/mcp/:connector'], notAllowed)
}
