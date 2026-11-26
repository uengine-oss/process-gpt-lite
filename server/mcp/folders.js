// Shared-folder tools for agents at /mcp/folders (registered like the ArtCraft apps: a tenant MCP
// entry, an mcp-hub server bound for everyone). The caller's JWT decides which folders it sees —
// only folders that user is a member of. The agent picks a folder and its files from the index
// (file list + document cards); changing files happens on a variation the chat prepares.
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { userFromJwt, q, mcpRefusal } from '../lib/supa.js'
import { catalog, extract } from '../lib/folders/indexer.js'
import * as S from '../lib/folders/service.js'
import { L, asUser } from '../lib/lang.js'
import { editable } from '../lib/office.js'

const TOOLS = [
  {
    name: 'folder_catalog',
    description: '[공유 폴더] 사용자가 구성원인 공유 폴더 목록과 각 폴더의 파일·문서 카드 요약을 돌려줍니다. 사내 문서·자료(이력서·계약서·보고서 등)를 찾을 때는 사용자가 폴더를 붙이지 않았어도 먼저 이 도구로 찾으세요. query 에는 찾을 낱말을 띄어 써서 주세요(예: "장진영 이력서") — 낱말마다 폴더 이름·파일 이름·문서 요약·키워드(전문 색인이 켜진 폴더는 본문까지)에서 따로 찾고, 많이 맞은 파일부터 돌려줍니다(matched = 맞은 낱말 수). 맞는 것이 없으면 쓸 수 있는 폴더 전체 목록을 돌려주니, 이름과 요약을 보고 직접 고르세요(이력서가 "프로필"이라는 이름일 수도 있어요).',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: '찾을 낱말들, 띄어 쓰기로 구분(선택)' } } },
  },
  {
    name: 'folder_files',
    description: '[공유 폴더] 한 폴더의 기준본(main) 파일 목록(경로·크기·수정자·문서 카드 요약). path 를 주면 그 아래만. 파일 내용을 바꾸려면 사용자에게 "<폴더 이름> 폴더의 … 고쳐줘" 처럼 요청하게 하세요 — 변형이 만들어지고 사람이 검토해 반영합니다.',
    inputSchema: { type: 'object', properties: { folder: { type: 'string', description: '폴더 이름 또는 slug' }, path: { type: 'string', description: '하위 경로(선택)' } }, required: ['folder'] },
  },
  {
    name: 'folder_read',
    description: '[공유 폴더] 한 폴더의 기준본(main)에 있는 파일 하나의 내용을 읽습니다(읽기 전용). 텍스트 파일은 본문을, 워드·한글·파워포인트·엑셀·PDF 는 추출한 본문을, 이미지 같은 파일은 문서 카드 요약을 돌려줍니다. 내용을 참고해 답할 때 쓰세요. 사용자가 파일을 "열어 줘/보여 줘" 하면 folder_open 을 쓰세요.',
    inputSchema: { type: 'object', properties: { folder: { type: 'string', description: '폴더 이름 또는 slug' }, path: { type: 'string', description: '파일 경로(folder_files 의 path)' } }, required: ['folder', 'path'] },
  },
  {
    name: 'folder_open',
    description: '[공유 폴더] 사용자가 공유 폴더의 파일을 열어 달라거나 보여 달라고 할 때 씁니다. 채팅에 그 파일 카드를 붙이고 사용자의 화면에 바로 엽니다 — 워드·한글·엑셀·파워포인트·PDF 는 이음오피스 편집기로, 그림·소리·영상은 그 자리에서. 내용을 읽기만 할 때는 folder_read 를 쓰세요. 연 뒤에는 무엇을 열었는지(폴더·파일 이름)만 짧게 말하면 됩니다.',
    inputSchema: { type: 'object', properties: { folder: { type: 'string', description: '폴더 이름 또는 slug' }, path: { type: 'string', description: '파일 경로(folder_catalog·folder_files 의 path)' } }, required: ['folder', 'path'] },
  },
]
const BINARY = /\.(docx|xlsx|pptx|hwpx?|pdf|png|jpe?g|gif|webp|psd|mp4|mov|webm|wav|mp3|zip|dxf)$/i
const DOC = /\.(docx|xlsx|pptx|hwpx|pdf)$/i

const text = (o) => ({ content: [{ type: 'text', text: typeof o === 'string' ? o : JSON.stringify(o, null, 1) }] })

// a folder by its slug or name, else the one folder whose name holds the given one or is held in it
// ("이력서" for "이력서 모음") — several such folders: none, the agent is shown them to choose. Only
// folders this user is a member of.
async function findFolder(user, key) {
  const all = await catalog(user.id, '')
  const k = String(key || '').trim()
  const exact = all.find((x) => x.slug === k || x.name === k)
  if (exact || !k) return { folder: exact || null, all }
  const near = all.filter((x) => x.name.includes(k) || k.includes(x.name))
  return { folder: near.length === 1 ? near[0] : null, near, all }
}
const noFolder = (key, near = []) => near.length > 1
  ? text({ error: L(`'${key}' 와(과) 맞는 폴더가 여럿이에요. 이름이나 slug 로 하나를 골라 다시 부르세요.`, `Several folders match '${key}'. Call again with one name or slug.`), folders: near.map((x) => ({ name: x.name, slug: x.slug })) })
  : text(L(`'${key}' 폴더를 찾지 못했어요(구성원인 폴더만 보여요).`, `I couldn't find the folder '${key}' (only folders you are a member of are shown).`))
// the fallback list (nothing matched) stays small: names and short summaries, a few hundred files at most
const FALLBACK = { perFolder: 40, total: 300, summary: 160 }

export async function callTool(user, name, args = {}) {
  if (name === 'folder_catalog') {
    const query = args.query ? String(args.query) : ''
    const out = await catalog(user.id, query)
    if (out.length) return text(out)
    const all = query ? await catalog(user.id, '') : []
    if (!all.length) return text(L('쓸 수 있는 공유 폴더가 없어요.', 'There are no shared folders you can use.'))
    // nothing named it: every folder the user may use, for the agent to judge by names and summaries
    let room = FALLBACK.total
    const folders = all.map((f) => {
      const files = f.files.slice(0, Math.max(0, Math.min(FALLBACK.perFolder, room)))
      room -= files.length
      return { name: f.name, slug: f.slug, description: f.description || undefined,
        files: files.map((x) => ({ path: x.path, ...(x.summary ? { summary: String(x.summary).slice(0, FALLBACK.summary) } : {}) })),
        ...(f.files.length > files.length ? { more: f.files.length - files.length } : {}) }
    })
    return text({ note: L(`'${query}' 의 낱말이 이름·요약에 없어서 쓸 수 있는 폴더 전체를 보여 줘요. 이름과 요약을 보고 맞는 파일을 고르세요(more 가 있는 폴더는 folder_files 로 나머지를 볼 수 있어요).`, `No name or summary holds the words of '${query}', so here is every folder you can use. Pick the file by its name and summary (a folder with "more" lists the rest with folder_files).`),
      folders })
  }
  if (name === 'folder_files') {
    const { folder: f, near } = await findFolder(user, args.folder)
    if (!f) return noFolder(args.folder, near)
    const prefix = String(args.path || '').replace(/^\/+/, '')
    return text({ folder: f.name, slug: f.slug, files: f.files.filter((x) => !prefix || x.path.startsWith(prefix)) })
  }
  if (name === 'folder_read') {
    // only folders this user is a member of (S.access), only main
    const { folder: f, near } = await findFolder(user, args.folder)
    if (!f) return noFolder(args.folder, near)
    const { folder } = await S.access(f.slug, user)
    const p = S.safeRel(args.path)
    const buf = await S.readBlob(folder, 'main', p)
    if (BINARY.test(p) || buf.subarray(0, 8000).includes(0)) {
      const [row] = await q('select card, body from pro_folder_files where folder_id=$1 and path=$2', [folder.id, p]).catch(() => [])
      // the text of a document is read now when the index kept none (full text is kept only for big folders)
      const body = row?.body || (DOC.test(p) ? (await extract(p, buf).catch(() => ({ text: '' }))).text : '')
      return text({ folder: folder.name, path: p, binary: !body, summary: row?.card?.abstract || null, keywords: row?.card?.keywords || [],
        text: body ? String(body).slice(0, 30000) : null, ...(body && body.length > 30000 ? { truncated: true } : {}) })
    }
    const s = buf.toString('utf8')
    return text({ folder: folder.name, path: p, text: s.slice(0, 30000), truncated: s.length > 30000 })
  }
  if (name === 'folder_open') {
    const { folder: f, near } = await findFolder(user, args.folder)
    if (!f) return noFolder(args.folder, near)
    const { folder, role } = await S.access(f.slug, user)
    const p = S.safeRel(args.path)
    const pub = await S.publishFile(folder, p)
    // a format no editor or player in the app takes: the link only, for the answer to give
    if (!editable(pub.name)) return text({ folder: folder.name, path: p, url: pub.url, note: L('이 형식은 앱 안에서 열 수 없어요. 링크를 알려 주세요.', "This format doesn't open inside the app. Give the link instead.") })
    // {file_url, file_name}: the shape lib/agent.js makes a file card of (documentFrom); open: the
    // person asked to see it, so their screen opens it as the card arrives
    // folder_ref: the folder and the version opened — the chat's editor saves back into the folder
    // (POST /api/messages/:id/file), beside it when someone changed it in the meantime
    // editable: an editor of the folder, a format IeumOffice saves (others open it read-only)
    const canEdit = folder.kind !== 'linked' && S.RANK[role] >= S.RANK.editor && S.OFFICE_EDIT.has(p.split('.').pop().toLowerCase())
    // (one line of JSON: the agent's stream passes it on as text, which the card is read back from — lib/office.js parseToolOutput)
    return { content: [{ type: 'text', text: JSON.stringify({ file_url: pub.url, file_name: pub.name, open: true, folder: folder.name, path: p, folder_ref: { slug: folder.slug, name: folder.name, path: p, sha: pub.sha, editable: canEdit } }) }] }
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
      // an agent's call carries no language header: the caller's saved language (lib/lang.js)
      return await asUser(user.id, () => callTool(user, params.name, params.arguments || {}))
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
    // (an approved member of the request's company only — lib/membership.js)
    { const no = await mcpRefusal(user); if (no) return res.status(403).json(no) }
    const server = buildServer(user)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => { transport.close(); server.close() })
    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)
  })
}
