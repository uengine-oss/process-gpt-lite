// Lite apps, contract v1 (docs/robo-dlc/plan-review.md §2). One folder under server/apps per app:
//   manifest.json  what it is, where it mounts, which bridge calls and events it may use, which waits it handles
//   server.js      export default (ctx) => ({ routes(r), waits? }) — over the host context `ctx` only,
//                  never the host's own modules (test/apps.test.js checks the imports)
//   ui/            static files run in a sandboxed iframe that talks to the host through src/apps/bridge.js
//   sql/*.sql      the app's own tables, each file applied once (lite_migrations 'app:<id>/<file>')
// Take a folder out and its routes, screens and cards are gone; the rest of Lite runs as before.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import express from 'express'
import { q, pool } from '../supa.js'
import { makeContext } from './context.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const APPS_DIR = path.join(HERE, '../../apps')
export const RUNTIME_DIR = path.join(HERE, 'runtime')
export const CONTRACT = 1

const ID = /^[a-z][a-z0-9-]{1,30}$/
export const CAPABILITIES = ['api', 'navigate', 'openApp', 'open', 'me']
const MOUNTS = ['folder', 'sheet']
const HANDLES = ['aidlc.questions', 'aidlc.approval']
const REQUIRES = ['aidlc']
const EVENT = /^[a-z][a-z0-9.-]{0,40}$/
const bad = (id, why) => Object.assign(new Error(`app ${id}: ${why}`), { status: 500 })

// a manifest as the host uses it, or an error saying what is wrong
export function checkManifest(m, dirName) {
  const id = m?.id
  if (!ID.test(String(id || '')) || id !== dirName) throw bad(dirName, 'id must match the folder name (a-z, 0-9, -)')
  if (m.contract !== CONTRACT) throw bad(id, `contract ${m.contract} is not ${CONTRACT}`)
  if (!/^\d+\.\d+\.\d+$/.test(String(m.version || ''))) throw bad(id, 'version must be x.y.z')
  if (!m.name?.ko || !m.name?.en) throw bad(id, 'name needs ko and en')
  const list = (k, allowed) => {
    const v = m[k] || []
    if (!Array.isArray(v)) throw bad(id, `${k} must be a list`)
    for (const x of v) if (allowed instanceof RegExp ? !allowed.test(x) : !allowed.includes(x)) throw bad(id, `${k}: unknown ${x}`)
    return [...new Set(v)]
  }
  return {
    id, version: m.version, contract: m.contract, name: m.name, icon: m.icon || '🧩', description: m.description || null,
    requires: list('requires', REQUIRES), mounts: list('mounts', MOUNTS), capabilities: list('capabilities', CAPABILITIES),
    events: list('events', EVENT), handles: list('handles', HANDLES),
  }
}

const apps = new Map() // id -> { manifest, dir, server }

export async function loadApps(dir = APPS_DIR) {
  apps.clear()
  const names = fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name).sort() : []
  for (const name of names) {
    const appDir = path.join(dir, name)
    try {
      const manifest = checkManifest(JSON.parse(fs.readFileSync(path.join(appDir, 'manifest.json'), 'utf8')), name)
      const mod = await import(pathToFileURL(path.join(appDir, 'server.js')).href)
      const server = (mod.default || (() => ({})))(makeContext(manifest)) || {}
      apps.set(manifest.id, { manifest, dir: appDir, server })
    } catch (e) {
      // one broken app does not stop the others or the server
      console.warn('[apps] not loaded:', name, e.message)
    }
  }
  return [...apps.keys()]
}

export const list = () => [...apps.values()].map((a) => a.manifest)
export const get = (id) => apps.get(id) || null

// a wait the watcher found (lib/aidlc/watch.js), opened in the app that handles its kind
export const waitHash = (key) => crypto.createHash('sha1').update(key).digest('hex').slice(0, 12)
export const appWaitUrl = (id, slug, key) => `/apps/${id}/${slug}?w=${waitHash(key)}`
export function handlerFor(kind) {
  for (const a of apps.values()) if (a.manifest.handles.includes(kind)) return { id: a.manifest.id, notify: a.server.waits?.notify || null, accepts: a.server.waits?.accepts || null }
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

// An app's ui is our code, but what it shows (an AI-DLC document) is not: served with a CSP sandbox,
// a page opened outside its iframe still has no origin (no token, no storage of this site).
const SANDBOX_CSP = 'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox'
const staticOpts = { index: 'index.html', setHeaders: (res) => { res.setHeader('Content-Security-Policy', SANDBOX_CSP); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Cache-Control', 'no-cache') } }

// The router an app writes its routes on: a handler returns the JSON to send; an error with a status
// is sent as { error } with that status. Every route needs a signed-in person (req.user).
function appRouter(id) {
  const r = express.Router()
  const wrap = (fn) => async (req, res) => {
    try { const out = await fn(req, res); if (out !== undefined && !res.headersSent) res.json(out) } catch (e) {
      if (!e.status) console.warn(`[app ${id}]`, req.method, req.path, e.message)
      if (!res.headersSent) res.status(e.status || 500).json({ error: e.message })
    }
  }
  const api = {}
  for (const m of ['get', 'post', 'put', 'delete']) api[m] = (p, fn) => r[m](p, wrap(fn))
  return { r, api }
}

export function mountApps(app, auth, { folderHasAidlc }) {
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
  for (const a of apps.values()) {
    const { id } = a.manifest
    const ui = path.join(a.dir, 'ui')
    if (fs.existsSync(ui)) app.use(`/api/apps/${id}/ui`, express.static(ui, staticOpts))
    const { r, api } = appRouter(id)
    try { a.server.routes?.(api) } catch (e) { console.warn('[apps] routes failed:', id, e.message); continue }
    app.use(`/api/apps/${id}`, auth, r)
  }
}
