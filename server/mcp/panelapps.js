// Panel-app tools for agents at /mcp/panelapps (registered like /mcp/folders: a tenant MCP entry
// and an mcp-hub server bound for everyone). The caller's JWT decides which apps it sees — the
// apps of folders that user is a member of — and writes need the folder's 'editor' role.
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { userFromJwt, q } from '../lib/supa.js'
import * as P from '../lib/panelApps/service.js'
import { L, asUser } from '../lib/lang.js'

const TOOLS = [
  {
    name: 'panel_app_list',
    description: '[패널 앱] 사용자가 쓸 수 있는 데이터 패널 앱(리드 관리, 휴가 일수 관리 같은 Home 패널) 목록과 각 앱의 항목. 데이터 원본은 공유 폴더의 xlsx 입니다.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'panel_app_create',
    description: '[패널 앱] 설명으로 새 데이터 패널 앱을 설계해 만듭니다(공유 폴더에 xlsx 와 정의 파일을 만들고 Home 에 올림). folder 를 주면 그 공유 폴더에 둡니다.',
    inputSchema: { type: 'object', properties: { description: { type: 'string' }, folder: { type: 'string', description: '공유 폴더 이름(선택)' } }, required: ['description'] },
  },
  {
    name: 'panel_app_rows',
    description: '[패널 앱] 한 앱의 모든 행(계산 열 포함). 각 행의 _id 로 고칠 행을 가리킵니다.',
    inputSchema: { type: 'object', properties: { app: { type: 'string', description: '앱 이름 또는 id' } }, required: ['app'] },
  },
  {
    name: 'panel_app_add_row',
    description: '[패널 앱] 앱에 행 하나를 더합니다. values 의 키는 항목 key 또는 한국어 머리글.',
    inputSchema: { type: 'object', properties: { app: { type: 'string' }, values: { type: 'object' } }, required: ['app', 'values'] },
  },
  {
    name: 'panel_app_append_event',
    description: '[패널 앱] 기록(이벤트) 방식 앱에 기록 하나를 더합니다(예: 휴가 부여·휴가 신청·휴가 취소). 기록은 고치거나 지울 수 없고, 잘못된 기록은 ref 로 원래 기록을 가리키는 취소·정정 기록을 더합니다. 호출한 사용자의 권한(본인 기록만 등)이 데이터베이스에서 적용됩니다.',
    inputSchema: { type: 'object', properties: { app: { type: 'string' }, type: { type: 'string', description: '기록 종류(이름 또는 key)' }, entity: { type: 'string', description: '대상(예: 팀원 이름)' }, ref: { type: 'string', description: '취소·정정할 원래 기록의 id' }, values: { type: 'object' } }, required: ['app', 'type'] },
  },
  {
    name: 'panel_app_update_row',
    description: '[패널 앱] 한 행의 일부 항목을 고칩니다(id 는 panel_app_rows 의 _id).',
    inputSchema: { type: 'object', properties: { app: { type: 'string' }, id: { type: 'string' }, values: { type: 'object' } }, required: ['app', 'id', 'values'] },
  },
]

const text = (o) => ({ content: [{ type: 'text', text: typeof o === 'string' ? o : JSON.stringify(o, null, 1) }] })
const strip = ({ _row, _v, ...r }) => r

async function resolve(user, key) {
  const apps = await P.listApps(user, { all: true })
  const k = String(key || '').trim()
  const a = apps.find((x) => x.id === k || x.title === k) || apps.find((x) => x.title.includes(k) || k.includes(x.title))
  if (!a) throw new Error(L(`'${k}' 패널 앱을 찾지 못했어요(구성원인 폴더의 앱만 보여요).`, `I couldn't find the panel app '${k}' (only apps of folders you are a member of are shown).`))
  return a
}

async function callTool(user, name, args = {}) {
  if (name === 'panel_app_list') {
    const apps = await P.listApps(user, { all: true })
    return text(apps.length ? apps.map((a) => ({ id: a.id, title: a.title, folder: a.folder.name, role: a.role, fields: P.describe(a.def) })) : L('쓸 수 있는 패널 앱이 없어요.', 'There are no panel apps you can use.'))
  }
  if (name === 'panel_app_create') {
    const d = await P.design(args.description)
    if (d.kind === 'live') return text(L('실시간 외부 데이터 위젯이라 데이터 앱이 아니에요. 채팅에서 "패널 만들어줘" 로 요청해 주세요.', 'That is a live external-data widget, not a data app. Ask for it in the chat with "make a panel".'))
    const app = await P.createApp(user, { description: args.description, def: d.def, rows: d.rows, folderHint: args.folder ? L(`${args.folder} 폴더`, `${args.folder} folder`) : '' })
    return text({ created: app.title, id: app.id, folder: app.folder.name, storage: app.tier === 'db' ? L('데이터베이스(행 단위 권한·개인정보 가림). 시트는 보는 사람마다 볼 수 있는 것만 담긴 사본', "database (row-level access, personal data masked); a sheet opens as a copy with only what that person may see") : L(`공유 폴더의 ${app.sheetPath}`, `${app.sheetPath} in the shared folder`), kind: app.kind === 'events' ? L('기록(이벤트)을 쌓고 요약은 다시 계산', 'keeps records (events) and replays the summaries') : L('목록', 'list'), fields: P.describe(app.def), privacy: app.privacy.map((l) => l.text), rules: app.rules || app.eventRules })
  }
  const a = await resolve(user, args.app)
  // everything below runs with the caller's own permissions (masked fields come back empty)
  if (name === 'panel_app_rows') {
    const r = await P.rows(user, a.id)
    if (r.kind === 'events') {
      const label = (t) => a.def.events.find((e) => e.type === t)?.label || t
      const nm = (id) => r.people.find((p) => p.id === id)?.name || id
      return text({ app: a.title, projections: r.projections, events: r.events.map((e) => ({ id: e.id, at: e.at, by: nm(e.by), type: label(e.type), entity: nm(e.entity), ref: e.ref, ...Object.fromEntries(a.def.fields.map((f) => [f.label, (e._hidden || []).includes(f.key) ? L('(비공개)', '(private)') : e[f.key]])), cancelled: !!e.closedBy })) })
    }
    return text({ app: a.title, rows: r.rows.map(({ _hidden, ...x }) => { const o = strip(x); for (const k of _hidden || []) o[k] = L('(비공개)', '(private)'); return o }) })
  }
  if (name === 'panel_app_append_event') {
    const r = await P.appendEvent(user, a.id, { type: args.type, entity: args.entity, ref: args.ref, values: args.values || {} })
    return text({ appended: { id: r.event.id, type: args.type }, projections: r.projections })
  }
  if (name === 'panel_app_add_row') {
    const r = await P.write(user, a.id, { add: args.values || {} })
    return text({ added: strip(r.row || {}), total: r.rows.length })
  }
  if (name === 'panel_app_update_row') {
    const r = await P.write(user, a.id, { update: { id: String(args.id), vals: args.values || {} } })
    return text({ updated: strip(r.row || {}) })
  }
  return { isError: true, ...text(`unknown tool ${name}`) }
}

function buildServer(user) {
  const server = new Server({ name: 'pgpt-panelapps', version: '1.0.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    if (!user) return { isError: true, ...text('unauthorized: call with the user JWT (Authorization: Bearer {{user_jwt}})') }
    try {
      console.log(`[mcp] panelapps.${params.name} user=${user.id.slice(0, 8)}`)
      // an agent's call carries no language header: the caller's saved language (lib/lang.js)
      return await asUser(user.id, () => callTool(user, params.name, params.arguments || {}))
    } catch (e) { return { isError: true, ...text(e.message) } }
  })
  return server
}

// mounted before the generic /mcp/:connector route
export function mountPanelApps(app) {
  app.post('/mcp/panelapps', async (req, res) => {
    let jwt = (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
    if (/^\{\{\s*user_jwt\s*\}\}$/.test(jwt)) jwt = ''
    const u = jwt ? await userFromJwt(jwt) : null
    if (jwt && !u) return res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'unauthorized: invalid or expired user JWT' }, id: null })
    let user = null
    if (u) {
      const [p] = await q('select name from pro_profile where user_id=$1', [u.id])
      user = { id: u.id, email: u.email, name: p?.name || u.user_metadata?.name || u.email.split('@')[0], jwt }
    }
    const server = buildServer(user)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => { transport.close(); server.close() })
    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)
  })
}
