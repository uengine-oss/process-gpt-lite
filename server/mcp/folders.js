// Shared-folder tools for agents at /mcp/folders (registered like the ArtCraft apps: a tenant MCP
// entry, an mcp-hub server bound for everyone). The caller's JWT decides which folders it sees —
// only folders that user is a member of. The agent picks a folder and its files from the index
// (file list + document cards); changing files happens on a variation the chat prepares.
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { userFromJwt } from '../lib/supa.js'
import { catalog } from '../lib/folders/indexer.js'
import * as S from '../lib/folders/service.js'

const TOOLS = [
  {
    name: 'folder_catalog',
    description: '[공유 폴더] 사용자가 쓸 수 있는 공유 폴더 목록과 각 폴더의 파일·문서 카드 요약을 돌려줍니다. query 를 주면 폴더 이름·파일 이름·문서 요약·키워드(전문 색인이 켜진 폴더는 본문까지)에서 찾은 것만 돌려줍니다. 사내 문서·자료가 어느 폴더에 있는지 찾을 때 먼저 쓰세요.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: '찾을 낱말(선택)' } } },
  },
  {
    name: 'folder_files',
    description: '[공유 폴더] 한 폴더의 기준본(main) 파일 목록(경로·크기·수정자·문서 카드 요약). path 를 주면 그 아래만. 파일 내용을 바꾸려면 사용자에게 "<폴더 이름> 폴더의 … 고쳐줘" 처럼 요청하게 하세요 — 변형이 만들어지고 사람이 검토해 반영합니다.',
    inputSchema: { type: 'object', properties: { folder: { type: 'string', description: '폴더 이름 또는 slug' }, path: { type: 'string', description: '하위 경로(선택)' } }, required: ['folder'] },
  },
]

const text = (o) => ({ content: [{ type: 'text', text: typeof o === 'string' ? o : JSON.stringify(o, null, 1) }] })

async function callTool(user, name, args = {}) {
  if (name === 'folder_catalog') {
    const out = await catalog(user.id, args.query ? String(args.query) : '')
    return text(out.length ? out : (args.query ? `'${args.query}' 와(과) 맞는 폴더·문서가 없어요.` : '쓸 수 있는 공유 폴더가 없어요.'))
  }
  if (name === 'folder_files') {
    const ids = await S.readableFolderIds(user.id)
    const all = await catalog(user.id, '')
    const key = String(args.folder || '').trim()
    const f = all.find((x) => x.slug === key || x.name === key) || all.find((x) => x.name.includes(key) || key.includes(x.name))
    if (!f || !ids.length) return text(`'${key}' 폴더를 찾지 못했어요(구성원인 폴더만 보여요).`)
    const prefix = String(args.path || '').replace(/^\/+/, '')
    return text({ folder: f.name, slug: f.slug, files: f.files.filter((x) => !prefix || x.path.startsWith(prefix)) })
  }
  return { isError: true, ...text(`unknown tool ${name}`) }
}

function buildServer(user) {
  const server = new Server({ name: 'pgpt-folders', version: '1.0.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    if (!user) return { isError: true, ...text('unauthorized: call with the user JWT (Authorization: Bearer {{user_jwt}})') }
    try {
      console.log(`[mcp] folders.${params.name} user=${user.id.slice(0, 8)}`)
      return await callTool(user, params.name, params.arguments || {})
    } catch (e) { return { isError: true, ...text(e.message) } }
  })
  return server
}

// mounted before the generic /mcp/:connector route
export function mountFolders(app) {
  app.post('/mcp/folders', async (req, res) => {
    let jwt = (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
    if (/^\{\{\s*user_jwt\s*\}\}$/.test(jwt)) jwt = ''
    const user = jwt ? await userFromJwt(jwt) : null
    if (jwt && !user) return res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'unauthorized: invalid or expired user JWT' }, id: null })
    const server = buildServer(user)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => { transport.close(); server.close() })
    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)
  })
}
