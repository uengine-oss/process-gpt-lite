// The ArtCraft apps' own MCP servers (`<app>-cli mcp`, stdio) behind pgpt-pro at /mcp/<app>
// (cadcraft, vectorcraft, photocraft, soundcraft, filmcraft). deepagents opens a new MCP session
// per tool call, so a headless document would be gone between "draw" and "save"; here each user
// keeps one CLI process per app (one open document) until it sits idle. Tools and schemas pass
// through untouched; `/workspace/…` strings in the arguments map to the deepagents workspace on
// this host (and back in the results), so a saved file shows up as a card in chat.
import fs from 'node:fs'
import path from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import { config } from '../config.js'
import { liveFor, liveEvents } from '../lib/craftLive.js'
import { userFromJwt } from '../lib/supa.js'
import { workspaceHostPath } from '../lib/missions.js'

const IDLE_MS = 20 * 60 * 1000
// how each CLI runs headless; `roots` = it confines file access to --automation-*-root folders
export const CRAFT_APPS = {
  cadcraft: { args: [] },
  vectorcraft: { args: ['--headless'], roots: true },
  photocraft: { args: [], roots: true },
  soundcraft: { args: [], roots: true },
  filmcraft: { args: [] },
}
// What this install has of each app: the web build under craftWebRoot/<app>/ and its CLI (an
// absolute path, or a name on PATH). An install without ArtCraft (the Docker lite profile) opens
// those files as plain downloads and draws no floor plans; nothing else changes.
function onPath(cmd) {
  if (!cmd) return false
  if (cmd.includes('/')) { try { fs.accessSync(cmd, fs.constants.X_OK); return true } catch { return false } }
  return (process.env.PATH || '').split(path.delimiter).some((d) => { try { fs.accessSync(path.join(d, cmd), fs.constants.X_OK); return true } catch { return false } })
}
let status = null
export function craftStatus() {
  if (status && Date.now() - status.at < 60_000) return status.apps
  const apps = Object.fromEntries(Object.keys(CRAFT_APPS).map((app) => [app, {
    web: fs.existsSync(path.join(config.craftWebRoot || '', app, 'index.html')), cli: onPath(config.craftCli[app]) }]))
  status = { at: Date.now(), apps }
  return apps
}
export const craftAvailable = (app) => !!craftStatus()[app]?.cli
const sessions = new Map() // `${app}:${userId}` → { client, timer }
const catalogs = new Map()

async function connect(app) {
  const args = ['mcp', ...CRAFT_APPS[app].args]
  if (CRAFT_APPS[app].roots) {
    const root = await workspaceHostPath('/workspace')
    args.push('--automation-read-root', root, '--automation-write-root', root)
  }
  const client = new Client({ name: 'pgpt-pro', version: '1.0.0' })
  await client.connect(new StdioClientTransport({ command: config.craftCli[app], args, stderr: 'ignore' }))
  return client
}

// Live (lib/craftLive.js): while the person has the app open in the page, a bridge CLI drives that
// window instead (`--connect/--bridge 127.0.0.1:PORT`, its token in the environment); the port only
// answers this process (craftLive checks the peer's pid). Path rules stay as for headless.
class TrackedTransport extends StdioClientTransport {
  async start() { await super.start(); this.onPid?.(this.pid) }
}
async function connectLive(app, live) {
  const client = new Client({ name: 'pgpt-pro', version: '1.0.0' })
  const transport = new TrackedTransport({ command: config.craftCli[app], args: ['mcp', ...live.cliArgs()], env: { ...getDefaultEnvironment(), ...live.cliEnv() }, stderr: 'ignore' })
  transport.onPid = (pid) => live.allowPid(pid)
  await client.connect(transport)
  return client
}
const liveSessions = new Map() // live.id → { client }
liveEvents.on('closed', (live) => {
  const s = liveSessions.get(live.id)
  liveSessions.delete(live.id)
  s?.client.then((c) => c.close()).catch(() => {})
})
async function liveSessionFor(live) {
  let s = liveSessions.get(live.id)
  if (!s) {
    s = { client: connectLive(live.app, live) }
    liveSessions.set(live.id, s)
    s.client.then((c) => { c.onclose = () => { if (liveSessions.get(live.id) === s) liveSessions.delete(live.id) } })
      .catch(() => liveSessions.delete(live.id))
  }
  return s.client
}

async function sessionFor(app, userId) {
  const live = liveFor(userId, app)
  if (live) return liveSessionFor(live)
  const key = `${app}:${userId}`
  let s = sessions.get(key)
  if (!s) {
    s = { client: await connect(app) }
    s.client.onclose = () => sessions.delete(key)
    sessions.set(key, s)
  }
  clearTimeout(s.timer)
  s.timer = setTimeout(() => { sessions.delete(key); s.client.close().catch(() => {}) }, IDLE_MS)
  return s.client
}

// Tools a headless session can't use (they drive a running app's window) stay out of the list.
const HEADLESS_ONLY_NOT = /^(ui_|jobs_)|^(screenshot|control_call|session_list|parity|click|drag|key|menu_invoke|select_tool|pointer_gesture|press_key|type_text|invoke_menu|open_panel)$/
const title = (app) => app[0].toUpperCase() + app.slice(1).replace('craft', 'Craft')

// the tool list does not depend on the document: read it once from a throwaway process. The apps
// share tool names (command_run, render_preview…) and an agent sees all of them at once, so each
// is published as `<app>_<tool>` (description first names the app); calls drop the prefix again.
async function tools(app) {
  if (catalogs.has(app)) return catalogs.get(app)
  const c = await connect(app)
  try {
    catalogs.set(app, (await c.listTools()).tools.filter((t) => !HEADLESS_ONLY_NOT.test(t.name))
      .map((t) => ({ ...t, name: `${app}_${t.name}`, description: `[${title(app)}] ${t.description || ''}` })))
  } finally { c.close().catch(() => {}) }
  return catalogs.get(app)
}

// deepagents loads every MCP server of the tenant into every chat and keeps only so many tools
// (the model's limit); five apps' full sets would crowd out everything else. So an app lists its
// tools only for a user whose recent message asked for that kind of work (lib/office.js
// craftAppsFor, recorded by the agent before each run), for ACTIVE_MS so follow-ups still edit;
// otherwise one small tool that switches it on for the next turn.
const ACTIVE_MS = 30 * 60 * 1000
const active = new Map() // `${app}:${userId}` → until
export function activateCraft(userId, apps) {
  const want = apps.filter((app) => CRAFT_APPS[app])
  if (!want.length) return
  // one app's full set at a time: several (~30 tools each) push the agent past its tool limit, and
  // deepagents then drops MCP tools from the front — office-mcp's generate_hwpx/docx first
  for (const app of Object.keys(CRAFT_APPS)) if (!want.includes(app)) active.delete(`${app}:${userId}`)
  for (const app of want) active.set(`${app}:${userId}`, Date.now() + ACTIVE_MS)
}
const isActive = (app, userId) => (active.get(`${app}:${userId}`) || 0) > Date.now()
const switchTool = (app) => ({
  name: `${app}_start`,
  description: `[${title(app)}] ${title(app)} 도구를 이 대화에서 켭니다(다음 메시지부터 전체 도구가 보임). 사용자가 ${title(app)}로 만들거나 고치자고 할 때만 부르세요.`,
  inputSchema: { type: 'object', properties: {} },
})

// the agent works in its sandbox's /workspace; the CLIs run on this host
async function toHost(value, root) {
  if (typeof value === 'string') {
    // FilmCraft and CADCraft have no automation roots: any other absolute path would reach the host
    if (/^(\/|~\/|[A-Za-z]:\\)/.test(value) && !value.startsWith('/workspace')) throw new Error(`only paths under /workspace are allowed: ${value}`)
    if (!value.startsWith('/workspace')) return value
    const host = path.resolve(root, '.' + value.slice('/workspace'.length))
    if (host !== root && !host.startsWith(root + path.sep)) throw new Error(`path outside /workspace: ${value}`)
    // a file saved into a conversation's own folder (/workspace/.bpmn/<conversation>/…, where the
    // agent is told to keep its output) may be the first thing there: the folder is made for it
    if (/^\/workspace\/\.bpmn\/[^/]+\/.+\.[A-Za-z0-9]{2,6}$/.test(value)) await fs.promises.mkdir(path.dirname(host), { recursive: true }).catch(() => {})
    return host
  }
  if (Array.isArray(value)) return Promise.all(value.map((v) => toHost(v, root)))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = await toHost(v, root)
    return out
  }
  return value
}

// CADCraft's web build has no face with the CJK unit signs (NanumGothic lacks ㎡ ㎥ …), so "12㎡" in a
// drawing shows as "12□" in the editor; drawings get the plain-letter form (m², m³), which every face has
const UNIT_SIGNS = { '㎡': 'm²', '㎥': 'm³', '㎠': 'cm²', '㎟': 'mm²', '㎢': 'km²', '㎝': 'cm', '㎜': 'mm', '㎞': 'km', '㎏': 'kg' }
export function plainUnits(value) {
  if (typeof value === 'string') return value.replace(/[㎡㎥㎠㎟㎢㎝㎜㎞㎏]/g, (c) => UNIT_SIGNS[c])
  if (Array.isArray(value)) return value.map(plainUnits)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plainUnits(v)]))
  return value
}
const forApp = (app, args) => (app === 'cadcraft' ? plainUnits(args) : args)

// the same tools, called by this server for work it starts on its own (lib/mail.js draws a floor
// plan a customer mail asks for): the user's own session, the same /workspace path rules
export async function callCraft(userId, app, name, args = {}) {
  const root = await workspaceHostPath('/workspace')
  name = name.startsWith(`${app}_`) ? name.slice(app.length + 1) : name
  console.log(`[mcp] ${app}.${name} user=${userId.slice(0, 8)} (server)`)
  const out = await (await sessionFor(app, userId)).callTool({ name, arguments: forApp(app, await toHost(args, root)) })
  const text = (out.content || []).filter((c) => c.type === 'text').map((c) => c.text.split(root).join('/workspace')).join('\n')
  if (out.isError) throw new Error(`${app}.${name}: ${text.slice(0, 300)}`)
  return text
}

function buildServer(app, user, { agentNoToken = false } = {}) {
  const server = new Server({ name: `pgpt-${app}`, version: '1.0.0' }, { capabilities: { tools: {} } })
  // anonymous (mcp-hub's catalog, health checks): everything; a user: per activation; an agent whose
  // {{user_jwt}} was not filled in: only the switch — its calls fail anyway, and the full sets of five
  // apps push the agent past its tool limit (office-mcp's tools are dropped first)
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: (!user && !agentNoToken) || (user && isActive(app, user.id)) ? await tools(app) : [switchTool(app)] }))
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    if (!user) return { isError: true, content: [{ type: 'text', text: 'unauthorized: call with the user JWT (Authorization: Bearer {{user_jwt}})' }] }
    if (params.name === `${app}_start`) {
      activateCraft(user.id, [app])
      return { content: [{ type: 'text', text: `${title(app)} 도구를 켰어요. 사용자에게 같은 요청을 한 번 더 보내 달라고 하세요.` }] }
    }
    try {
      const root = await workspaceHostPath('/workspace')
      const args = forApp(app, await toHost(params.arguments || {}, root))
      const name = params.name.startsWith(`${app}_`) ? params.name.slice(app.length + 1) : params.name
      console.log(`[mcp] ${app}.${name} user=${user.id.slice(0, 8)}${liveFor(user.id, app) ? ' (live)' : ''}`)
      const out = await (await sessionFor(app, user.id)).callTool({ name, arguments: args })
      for (const c of out.content || []) if (c.type === 'text') c.text = c.text.split(root).join('/workspace')
      return out
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: e.message }] }
    }
  })
  return server
}

// mounted before the generic /mcp/:connector route
export function mountCraft(app) {
  app.post(Object.keys(CRAFT_APPS).map((a) => `/mcp/${a}`), async (req, res) => {
    const name = req.path.split('/').pop()
    let jwt = (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
    const agentNoToken = /^\{\{\s*user_jwt\s*\}\}$/.test(jwt)
    if (agentNoToken) jwt = ''
    const user = jwt ? await userFromJwt(jwt) : null
    if (jwt && !user) return res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'unauthorized: invalid or expired user JWT' }, id: null })
    const server = buildServer(name, user, { agentNoToken })
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => { transport.close(); server.close() })
    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)
  })
}
