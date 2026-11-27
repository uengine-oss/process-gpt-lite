// The team tool for agents at /mcp/team (pgpt-team — one of the built-in tool servers, mcp/toolServers.js: bound for everyone by the
// hub, the common MCP list in production). ask_teammate: a value only a teammate knows is missing — the person is asked whether to ask
// that teammate on the messenger (lib/askTeammate.js). The call sends nothing: it checks the teammate (this company's team, not oneself)
// and hands back a signed offer that the chat turn turns into the card 「○○님께 메신저로 물어볼까요?」. Its description is the skill's
// (skills/ask-teammate prompts/tool.md · tool-en.md), so a company may change it.
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { userFromJwt } from '../lib/supa.js'
import { signedIn } from '../lib/people.js'
import { asUser, langOf } from '../lib/lang.js'
import * as AT from '../lib/askTeammate.js'

const SCHEMA = {
  type: 'object',
  properties: {
    member: { type: 'string', description: '물어볼 팀원의 이름 또는 이메일 / the teammate\'s name or e-mail' },
    reason: { type: 'string', description: '왜 필요한지 한 문장 / why it is needed, one sentence' },
    fields: {
      type: 'array', description: '채울 항목 / the items to fill',
      items: { type: 'object', properties: {
        label: { type: 'string', description: '짧은 이름 / a short label' },
        hint: { type: 'string', description: '적는 법(선택) / how to write it (optional)' },
        line: { type: 'string', description: '파일에서 빈칸이 있는 줄, 글자 그대로(선택) / the file\'s line holding the blank, verbatim (optional)' },
        blank: { type: 'string', description: '그 줄 안의 빈칸 표시(선택) / the blank marker in that line (optional)' },
      }, required: ['label'] },
    },
    file: { type: 'string', description: '빈칸이 든 초안 파일 이름(선택) / the draft file\'s name (optional)' },
  },
  required: ['member', 'reason', 'fields'],
}
export async function tools(lang = 'ko') {
  const sk = await AT.askSkill()
  const description = (lang === 'en' ? sk.prompts['tool-en'] : sk.prompts.tool) || sk.prompts.tool
  return [{ name: 'ask_teammate', description, inputSchema: SCHEMA }]
}
// one line of JSON: deepagents streams the result as text, which the chat turn reads back (lib/askTeammate.js offerFromOutput)
const text = (o) => ({ content: [{ type: 'text', text: typeof o === 'string' ? o : JSON.stringify(o) }] })

export async function callTool(user, name, args = {}) {
  if (name !== 'ask_teammate') return { isError: true, ...text(`unknown tool ${name}`) }
  const r = await AT.offerFor(user, args)
  return r.ok ? text(r) : { isError: true, ...text(r) }
}

function buildServer(user) {
  const server = new Server({ name: 'pgpt-team', version: '1.0.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await tools(user ? await langOf(user.id) : 'ko') }))
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    if (!user) return { isError: true, ...text('unauthorized: call with the user JWT (Authorization: Bearer {{user_jwt}})') }
    try {
      console.log(`[mcp] team.${params.name} user=${user.id.slice(0, 8)}`)
      // an agent's call carries no language header: the caller's saved language and company (lib/lang.js)
      return await asUser(user.id, () => callTool(user, params.name, params.arguments || {}))
    } catch (e) { return { isError: true, ...text(e.message) } }
  })
  return server
}

// mounted before the generic /mcp/:connector route
export function mountTeam(app) {
  app.post('/mcp/team', async (req, res) => {
    let jwt = (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
    if (/^\{\{\s*user_jwt\s*\}\}$/.test(jwt)) jwt = ''
    const u = jwt ? await userFromJwt(jwt) : null
    if (jwt && !u) return res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'unauthorized: invalid or expired user JWT' }, id: null })
    const user = u ? { id: u.id, email: u.email, name: (await signedIn(u)).name, jwt } : null
    const server = buildServer(user)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => { transport.close(); server.close() })
    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)
  })
}
