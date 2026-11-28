// IeumOffice's MCP (process-gpt office-host, POST /office/mcp) behind pgpt-pro at /mcp/ieumoffice-live-editor.
// Its office_live_* tools edit a document the person has open in the page (OfficeEditorFrame),
// in front of them; office-host checks the user's token and finds that person's open editors.
// Here the calls pass through with the caller's JWT; tools and schemas are office-host's own. An edit call's result is
// read on the way back (lib/officeEdits.js): one that changed nothing, or whose format the document does not show (the
// result's `check` — what office-host reads back from the open document), goes to the agent as an error that says so, and
// the turn knows whether its edits were applied.
//
// Like the ArtCraft apps (mcp/craft.js), the tools count against the agent's tool limit, so a user
// sees them only while a document is open in the editor (lib/craftLive.js, app 'ieumoffice') or
// for ACTIVE_MS after one was; otherwise one small tool that says how to start.
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { config } from '../config.js'
import { liveFor } from '../lib/craftLive.js'
import { mcpRoute } from '../lib/mcpAuth.js'
import { editOutcome, notAppliedResult, recordEdit, forAgent } from '../lib/officeEdits.js'

// The registered name (mcp-hub server `pgpt-<name>`, tenant MCP key) is long on purpose: deepagents
// trims tools over its limit (110) from the front of the tenant's MCP list, which jsonb keeps
// ordered by key length — a short key would lose these tools first. /mcp/office is the short alias.
export const OFFICE_MCP = 'ieumoffice-live-editor'
const ACTIVE_MS = 30 * 60 * 1000
const active = new Map() // userId → until
export function activateOffice(userId) { active.set(userId, Date.now() + ACTIVE_MS) }
const isActive = (userId) => !!liveFor(userId, 'ieumoffice') || (active.get(userId) || 0) > Date.now()

// creating documents stays with office-mcp (skills + store_and_render); this is for open ones
const KEEP = /^office_(live_|guide$|read_document$)/
const idleTool = {
  name: 'office_live_status',
  description: '[이음오피스] 사용자가 편집기에 연 문서를 그 자리에서 고치는 도구(office_live_*)는 문서가 채팅 옆 이음오피스 편집기에 열려 있을 때만 보여요. 지금은 열린 문서가 없어요 — 고칠 문서가 있으면 채팅 카드에서 열어 달라고 하세요.',
  inputSchema: { type: 'object', properties: {} },
}

export async function withClient(jwt, fn) {
  const client = new Client({ name: 'pgpt-pro', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL('/office/mcp', config.officeHostUrl), { requestInit: { headers: { Authorization: `Bearer ${jwt}` } } }))
  try { return await fn(client) } finally { client.close().catch(() => {}) }
}

let catalog = null
async function tools(jwt) {
  if (!catalog) catalog = (await withClient(jwt, (c) => c.listTools())).tools.filter((t) => KEEP.test(t.name))
    .map((t) => ({ ...t, description: `[이음오피스] ${t.description || ''}` }))
  return catalog
}

function buildServer(user, jwt) {
  const server = new Server({ name: 'pgpt-office', version: '1.0.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    if (!user || !isActive(user.id)) return { tools: [idleTool] }
    try { return { tools: await tools(jwt) } } catch (e) { console.warn('[mcp] office tools', e.message); return { tools: [idleTool] } }
  })
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    if (!user) return { isError: true, content: [{ type: 'text', text: 'unauthorized: call with the user JWT (Authorization: Bearer {{user_jwt}})' }] }
    if (params.name === idleTool.name) return { content: [{ type: 'text', text: JSON.stringify({ open: !!liveFor(user.id, 'ieumoffice'), file: liveFor(user.id, 'ieumoffice')?.file || null }) }] }
    if (!KEEP.test(params.name)) return { isError: true, content: [{ type: 'text', text: `unknown tool: ${params.name}` }] }
    console.log(`[mcp] office.${params.name} user=${user.id.slice(0, 8)}`)
    let result
    try {
      result = await withClient(jwt, (c) => c.callTool({ name: params.name, arguments: params.arguments || {} }, undefined, { timeout: 90_000 }))
    } catch (e) {
      result = { isError: true, content: [{ type: 'text', text: e.message }] }
    }
    const done = editOutcome(params.name, params.arguments, result)
    if (done) {
      recordEdit(user.id, params.name, done)
      if (!done.applied) console.log(`[mcp] office.${params.name} not applied: ${String(done.why || '').slice(0, 160)}`)
      if (done.nothing || done.unmet) return notAppliedResult(done)
    }
    return forAgent(result, done)
  })
  return server
}

export function mountOffice(app) {
  // (the person by the screen API's rules — lib/mcpAuth.js; jwt: '' for the anonymous catalog)
  app.post([`/mcp/${OFFICE_MCP}`, '/mcp/office'], mcpRoute(async (req, res, { user, jwt }) => {
    const server = buildServer(user, jwt)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => { transport.close(); server.close() })
    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)
  }))
}
