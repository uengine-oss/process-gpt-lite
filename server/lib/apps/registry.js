// Lite apps, contract v2 = MCP Apps (docs/robo-dlc/plan-mcp-apps.md). One folder under server/apps per app:
//   manifest.json  Lite's own part (io.uengine.lite): name, icon, where it mounts, the waits it handles, its entry tool
//   server.js      export default (server, ctx) => { … } — an MCP server: tools, and its screens as ui:// resources
//                  (registerAppTool / registerAppResource of @modelcontextprotocol/ext-apps/server). Lite's own
//                  functions only through ctx, which is a client of the lite-host MCP server (lib/apps/host.js);
//                  never the host's modules (test/apps.test.js checks the imports)
//   ui/            the screen's files (index.html and what it loads), shown in a sandboxed iframe by the host's
//                  MCP Apps bridge (src/apps/AppFrame.vue)
//   sql/*.sql      the app's own tables, each file applied once (lite_migrations 'app:<id>/<file>')
// Each app answers MCP at /api/apps/<id>/mcp (Streamable HTTP, as the signed-in person) — the same address an
// app run as its own service would have. Take a folder out and its tools, screens and cards are gone.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import express from 'express'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { q, pool } from '../supa.js'
import { makeContext } from './context.js'
import { hostServer } from './host.js'
import { registerPanels, PANELS_MANIFEST, PANELS_DIR } from './builtin/panels/index.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const APPS_DIR = path.join(HERE, '../../apps')
export const RUNTIME_DIR = path.join(HERE, 'runtime')
export const CONTRACT = 2
// the MCP Apps view SDK, served to the screens (an ES module: imported with CORS from a sandboxed frame)
const EXT_APPS = createRequire(import.meta.url).resolve('@modelcontextprotocol/ext-apps/app-with-deps')

const ID = /^[a-z][a-z0-9-]{1,30}$/
const MOUNTS = ['folder', 'sheet', 'panel']
const HANDLES = ['aidlc.questions', 'aidlc.approval']
const REQUIRES = ['aidlc']
const TOOL = /^[a-z][a-z0-9_]{1,62}$/
const bad = (id, why) => Object.assign(new Error(`app ${id}: ${why}`), { status: 500 })

// a manifest as the host uses it, or an error saying what is wrong
export function checkManifest(m, dirName) {
  const id = m?.id
  if (!ID.test(String(id || '')) || id !== dirName) throw bad(dirName, 'id must match the folder name (a-z, 0-9, -)')
  if (m.contract !== CONTRACT) throw bad(id, `contract ${m.contract} is not ${CONTRACT}`)
  if (!/^\d+\.\d+\.\d+$/.test(String(m.version || ''))) throw bad(id, 'version must be x.y.z')
  if (!m.name?.ko || !m.name?.en) throw bad(id, 'name needs ko and en')
  if (!TOOL.test(String(m.entry || ''))) throw bad(id, 'entry must name the tool that opens its screen')
  const list = (k, allowed) => {
    const v = m[k] || []
    if (!Array.isArray(v)) throw bad(id, `${k} must be a list`)
    for (const x of v) if (!allowed.includes(x)) throw bad(id, `${k}: unknown ${x}`)
    return [...new Set(v)]
  }
  return {
    id, version: m.version, contract: m.contract, name: m.name, icon: m.icon || '🧩', description: m.description || null,
    entry: m.entry, requires: list('requires', REQUIRES), mounts: list('mounts', MOUNTS), handles: list('handles', HANDLES),
  }
}

const apps = new Map() // id -> { manifest, dir, register }
// apps that come with the host (lib/apps/builtin): the Home panels' screen
const BUILTINS = [{ manifest: PANELS_MANIFEST, dir: PANELS_DIR, register: registerPanels }]

export async function loadApps(dir = APPS_DIR) {
  apps.clear()
  for (const b of BUILTINS) apps.set(b.manifest.id, b)
  const names = fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name).sort() : []
  for (const name of names) {
    const appDir = path.join(dir, name)
    try {
      const manifest = checkManifest(JSON.parse(fs.readFileSync(path.join(appDir, 'manifest.json'), 'utf8')), name)
      const mod = await import(pathToFileURL(path.join(appDir, 'server.js')).href)
      if (typeof mod.default !== 'function') throw bad(name, 'server.js must export default (server, ctx) => …')
      // a dry registration: the entry tool must be there
      const probe = new McpServer({ name, version: manifest.version })
      mod.default(probe, makeContext(manifest, null))
      if (!probe._registeredTools?.[manifest.entry]) throw bad(name, `entry tool ${manifest.entry} is not registered`)
      apps.set(manifest.id, { manifest, dir: appDir, register: mod.default })
    } catch (e) {
      // one broken app does not stop the others or the server
      console.warn('[apps] not loaded:', name, e.message)
    }
  }
  return [...apps.keys()]
}

export const list = () => [...apps.values()].map((a) => a.manifest)
export const get = (id) => apps.get(id) || null

// an app's MCP server for one person (user null: the server itself)
export function appServer(id, user) {
  const a = apps.get(id)
  if (!a) throw Object.assign(new Error('no such app'), { status: 404 })
  const ctx = makeContext(a.manifest, user)
  const server = new McpServer({ name: id, version: a.manifest.version })
  a.register(server, ctx)
  return { server, ctx }
}

// call an app's tool from this server, in memory (the watcher's hooks; tests)
export async function callAppTool(id, name, args = {}, user = null) {
  const { server, ctx } = appServer(id, user)
  const [x, y] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'lite-host', version: '1.0.0' })
  await Promise.all([server.connect(x), client.connect(y)])
  try {
    const r = await client.callTool({ name, arguments: args })
    if (r.isError) throw Object.assign(new Error(r.structuredContent?.error || r.content?.[0]?.text || 'app error'), { status: r.structuredContent?.status || 500 })
    return r.structuredContent?.value ?? r.structuredContent ?? null
  } finally {
    await Promise.all([client.close(), server.close()]).catch(() => {})
    await ctx.close?.()
  }
}

// a wait the watcher found (lib/aidlc/watch.js), opened in the app that handles its kind; the app may pass
// on one (lite_wait_accepts) and may tell more people (lite_wait_notify) — both tools of its own server
export const waitHash = (key) => crypto.createHash('sha1').update(key).digest('hex').slice(0, 12)
export const appWaitUrl = (id, slug, key) => `/apps/${id}/${slug}?w=${waitHash(key)}`
export function handlerFor(kind) {
  for (const a of apps.values()) {
    if (!a.manifest.handles.includes(kind)) continue
    const id = a.manifest.id
    return {
      id,
      accepts: (folder, wait) => callAppTool(id, 'lite_wait_accepts', { folder: folder.slug, wait }).then((v) => v !== false),
      notify: (folder, wait, url, told) => callAppTool(id, 'lite_wait_notify', { folder: folder.slug, folderName: folder.name, wait, url, told: [...told] }),
    }
  }
  return null
}
export const handlerIds = () => [...apps.values()].filter((a) => a.manifest.handles.length).map((a) => a.manifest.id)

// each app's sql/*.sql once, in name order
export async function migrate() {
  await q('create table if not exists public.lite_migrations (name text primary key, applied_at timestamptz default now())')
  for (const a of apps.values()) {
    const sqlDir = path.join(a.dir, 'sql')
    if (!fs.existsSync(sqlDir)) continue
    for (const f of fs.readdirSync(sqlDir).filter((x) => /^\d+_[a-z0-9_-]+\.sql$/.test(x)).sort()) {
      const name = `app:${a.manifest.id}/${f}`
      const [done] = await q('select 1 from public.lite_migrations where name=$1', [name])
      if (done) continue
      const c = await pool.connect()
      try {
        await c.query('begin')
        await c.query(fs.readFileSync(path.join(sqlDir, f), 'utf8'))
        await c.query('insert into public.lite_migrations(name) values ($1)', [name])
        await c.query('commit')
      } catch (e) {
        await c.query('rollback').catch(() => {})
        console.warn('[apps] migration failed:', name, e.message)
        throw e
      } finally { c.release() }
      console.log('[apps] applied', name)
    }
  }
}

// A screen runs in a sandboxed frame with no origin: what it loads (its files, the runtime, the view SDK as an
// ES module) comes with CORS; a file opened outside its frame still gets no origin (CSP sandbox).
const SANDBOX_CSP = 'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox'
const staticHeaders = (res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Content-Security-Policy', SANDBOX_CSP)
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Cache-Control', 'no-cache')
}
const staticOpts = { index: false, setHeaders: staticHeaders }

// MCP over Streamable HTTP, stateless: a fresh server for each request, as the signed-in person
async function serveMcp(req, res, server, done) {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  res.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}); done?.() })
  try {
    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)
  } catch (e) {
    console.warn('[apps] mcp', req.path, e.message)
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'internal error' }, id: null })
  }
}
const noSessions = (req, res) => res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'stateless: POST only' }, id: null })

export function mountApps(app, auth, { folderHasAidlc }) {
  app.get('/api/apps/_runtime/ext-apps.js', (req, res) => { staticHeaders(res); res.type('text/javascript').sendFile(EXT_APPS) })
  app.use('/api/apps/_runtime', express.static(RUNTIME_DIR, staticOpts))
  // which apps there are (the host draws their buttons and links from this)
  app.get('/api/apps', auth, (req, res) => res.json(list()))
  // the apps that apply to one folder (requires: aidlc → the folder holds an AI-DLC record)
  app.get('/api/apps/for/:folder', auth, async (req, res) => {
    try {
      const has = await folderHasAidlc(req.params.folder, req.user)
      res.json(list().filter((m) => m.requires.every((x) => x !== 'aidlc' || has)))
    } catch (e) { res.status(e.status || 500).json({ error: e.message }) }
  })
  // lite-host for an app running as its own service (it passes on the person's token)
  app.post('/api/apps/_host/mcp', auth, (req, res) => serveMcp(req, res, hostServer({ appId: String(req.query.app || 'external').slice(0, 32), user: req.user })))
  app.get('/api/apps/_host/mcp', noSessions)
  for (const a of apps.values()) {
    const { id } = a.manifest
    const ui = path.join(a.dir, 'ui')
    if (fs.existsSync(ui)) app.use(`/api/apps/${id}/ui`, express.static(ui, staticOpts))
    app.post(`/api/apps/${id}/mcp`, auth, (req, res) => {
      const { server, ctx } = appServer(id, { id: req.user.id, name: req.user.name, email: req.user.email })
      return serveMcp(req, res, server, () => ctx.close?.())
    })
    app.get(`/api/apps/${id}/mcp`, noSessions)
    app.delete(`/api/apps/${id}/mcp`, noSessions)
  }
}
