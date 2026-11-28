// Shared-folder tools for agents at /mcp/folders (registered like the ArtCraft apps: a tenant MCP
// entry, an mcp-hub server bound for everyone). The caller's JWT decides which folders it sees —
// only folders that user is a member of. The agent picks a folder and its files from the index
// (file list + document cards); changing files happens on a variation the chat prepares.
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { q } from '../lib/supa.js'
import { mcpRoute } from '../lib/mcpAuth.js'
import { catalog, extract } from '../lib/folders/indexer.js'
import * as S from '../lib/folders/service.js'
import { L, asUser } from '../lib/lang.js'
import { editable } from '../lib/office.js'
// reference slots: read through the one resolver, with the caller's role in the source (lib/folders/refs.js)
import * as REFS from '../lib/folders/refs.js'

const TOOLS = [
  {
    name: 'folder_catalog',
    description: '[공유 폴더] 사용자가 구성원인 공유 폴더 목록과 각 폴더의 파일·문서 카드 요약을 돌려줍니다. 사내 문서·자료(이력서·계약서·보고서 등)를 찾을 때는 사용자가 폴더를 붙이지 않았어도 먼저 이 도구로 찾으세요. query 에는 찾을 낱말을 띄어 써서 주세요(예: "장진영 이력서") — 낱말마다 폴더 이름·파일 이름·문서 요약·키워드(전문 색인이 켜진 폴더는 본문까지)에서 따로 찾고, 많이 맞은 파일부터 돌려줍니다(matched = 맞은 낱말 수). 맞는 것이 없으면 쓸 수 있는 폴더 전체 목록을 돌려주니, 이름과 요약을 보고 직접 고르세요(이력서가 "프로필"이라는 이름일 수도 있어요).',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: '찾을 낱말들, 띄어 쓰기로 구분(선택)' } } },
  },
  {
    name: 'folder_files',
    description: '[공유 폴더] 한 폴더의 기준본(main) 파일 목록(경로·크기·수정자·문서 카드 요약). 다른 폴더를 가리키는 참조 자리(refs)가 있으면 그 자리 아래 파일도 \'자리/파일\' 경로로 함께 나와요(읽기 전용, 볼 수 없는 참조는 이름만). path 를 주면 그 아래만. 파일 내용을 바꾸려면 사용자에게 "<폴더 이름> 폴더의 … 고쳐줘" 처럼 요청하게 하세요 — 변형이 만들어지고 사람이 검토해 반영합니다.',
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
// folders this user is a member of. (The catalog here carries no reference slots: finding a folder does not look at its sources.)
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
    // (this catalog says each folder's reference slots — names and states, the original's name only to its readers)
    const out = await catalog(user.id, query, { refs: true })
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
    // (the files of the slots this user may read, at the slots' paths; a locked slot by its name only)
    const { folder } = await S.access(f.slug, user)
    // (at most a few hundred of the slots' files at once — more: how many are left, read with folder_read by path or a narrower path)
    const { refs, files: slotFiles, more } = await REFS.agentView(folder, user)
    const files = [...f.files, ...slotFiles].filter((x) => !prefix || x.path.startsWith(prefix))
    return text({ folder: f.name, slug: f.slug, files, ...(refs.length ? { refs } : {}), ...(more ? { more } : {}) })
  }
  if (name === 'folder_read') {
    // only folders this user is a member of (S.access), only main
    const { folder: f, near } = await findFolder(user, args.folder)
    if (!f) return noFolder(args.folder, near)
    const { folder: own } = await S.access(f.slug, user)
    const asked = S.safeRel(args.path)
    // under a reference slot: the source's file, read with this user's role in the source (locked: nothing of it)
    const via = await REFS.resolve(own, asked, user)
    if (via?.state === 'locked') return text({ folder: own.name, path: asked, locked: true, note: L('이 사용자가 볼 수 없는 참조예요. 원본 폴더의 구성원만 내용을 봐요(사용자는 폴더 화면의 「접근 요청」으로 요청할 수 있어요).', "This user can't read this reference. Only members of its original folder see its content (they can ask with 「접근 요청」 on the folder screen).") })
    if (via?.state === 'dangling') return text({ folder: own.name, path: asked, note: L('원본에서 찾을 수 없는 참조예요.', "This reference's original can't be found.") })
    const ok = via?.state === 'ok' ? via : null
    if (ok && !ok.path) return text(L('파일이 없어요.', "That file isn't there."))
    const folder = ok ? ok.source : own
    const p = ok ? ok.path : asked
    const buf = ok ? await S.readBlob(folder, ok.rev, p) : await S.readBlob(folder, 'main', p)
    const from = ok ? { referenced: { slot: ok.ref.slot, from: folder.name, path: p, readOnly: true } } : {}
    if (BINARY.test(p) || buf.subarray(0, 8000).includes(0)) {
      const [row] = await q('select card, body from pro_folder_files where folder_id=$1 and path=$2', [folder.id, p]).catch(() => [])
      // the text of a document is read now when the index kept none (full text is kept only for big folders)
      const body = row?.body || (DOC.test(p) ? (await extract(p, buf).catch(() => ({ text: '' }))).text : '')
      return text({ folder: own.name, path: asked, ...from, binary: !body, summary: row?.card?.abstract || null, keywords: row?.card?.keywords || [],
        text: body ? String(body).slice(0, 30000) : null, ...(body && body.length > 30000 ? { truncated: true } : {}) })
    }
    const s = buf.toString('utf8')
    return text({ folder: own.name, path: asked, ...from, text: s.slice(0, 30000), truncated: s.length > 30000 })
  }
  if (name === 'folder_open') {
    const { folder: f, near } = await findFolder(user, args.folder)
    if (!f) return noFolder(args.folder, near)
    const { folder: own, role: ownRole } = await S.access(f.slug, user)
    const asked = S.safeRel(args.path)
    // under a reference slot: the source's file card, read only from here (the original is edited in its own folder — 「원본 열기」)
    const via = await REFS.resolve(own, asked, user)
    const no = REFS.refusal(via)
    if (no) return text({ folder: own.name, path: asked, ...(via.state === 'locked' ? { locked: true } : {}), note: no.message })
    const ok = via?.state === 'ok' ? via : null
    if (ok && !ok.path) return text(L('파일이 없어요.', "That file isn't there."))
    const folder = ok ? ok.source : own
    const role = ok ? ok.role : ownRole
    const p = ok ? ok.path : asked
    const pub = ok ? await S.publishFile(folder, p, ok.rev) : await S.publishFile(folder, p)
    // a format no editor or player in the app takes: the link only, for the answer to give
    if (!editable(pub.name)) return text({ folder: folder.name, path: p, url: pub.url, note: L('이 형식은 앱 안에서 열 수 없어요. 링크를 알려 주세요.', "This format doesn't open inside the app. Give the link instead.") })
    // {file_url, file_name}: the shape lib/agent.js makes a file card of (documentFrom); open: the
    // person asked to see it, so their screen opens it as the card arrives
    // folder_ref: the folder and the version opened — the chat's editor saves back into the folder
    // (POST /api/messages/:id/file), beside it when someone changed it in the meantime
    // editable: an editor of the folder, a format IeumOffice saves (others open it read-only)
    const canEdit = !ok && folder.kind !== 'linked' && S.RANK[role] >= S.RANK.editor && S.OFFICE_EDIT.has(p.split('.').pop().toLowerCase())
    // (one line of JSON: the agent's stream passes it on as text, which the card is read back from — lib/office.js parseToolOutput)
    return { content: [{ type: 'text', text: JSON.stringify({ file_url: pub.url, file_name: pub.name, open: true, folder: folder.name, path: p, folder_ref: { slug: folder.slug, name: folder.name, path: p, sha: pub.sha, editable: canEdit },
      ...(ok ? { note: L(`참조된 자료라 여기서는 읽기만 해요. 고치려면 원본 폴더 「${folder.name}」에서 열어 고쳐요.`, `Referenced material — read only here. To change it, open it in its original folder "${folder.name}".`) } : {}) }) }] }
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
  // (the person by the screen API's rules — lib/mcpAuth.js)
  app.post('/mcp/folders', mcpRoute(async (req, res, { user }) => {
    const server = buildServer(user)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => { transport.close(); server.close() })
    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)
  }))
}
