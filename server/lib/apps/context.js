// The context an app's MCP server is built with, for one request (contract v2, docs/robo-dlc/plan-mcp-apps.md).
// Everything of Lite goes through the lite-host MCP server (lib/apps/host.js) — here over an in-memory
// link, as the person who called the app (or the server itself, for the watcher's hooks) — so an app
// that runs as its own service makes the same calls over HTTP. What stays in-process: the app's own
// tables (ctx.db, apps embedded in this server only) and the language helpers.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { q } from '../supa.js'
import { config } from '../../config.js'
import { L, isEn } from '../lang.js'
import { hostServer } from './host.js'

const err = (status, message) => Object.assign(new Error(message), { status })

// an MCP client to lite-host as `user` (null: the server)
export async function hostLink({ appId, user }) {
  const server = hostServer({ appId, user })
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: appId, version: '1.0.0' })
  await Promise.all([server.connect(a), client.connect(b)])
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args })
    if (r.isError) throw err(r.structuredContent?.status || 500, r.structuredContent?.error || r.content?.[0]?.text || 'host error')
    return r.structuredContent?.value ?? null
  }
  return { call, close: () => Promise.all([client.close(), server.close()]).catch(() => {}) }
}

// stage and role names don't change while the server runs: read once
let catalog = null
async function catalogOf(link) {
  if (!catalog) {
    const c = await link.call('aidlc_catalog')
    catalog = { bySlug: Object.fromEntries(c.stages.map((s) => [s.slug, s])), roles: c.roles }
  }
  return catalog
}

// a folder's AI-DLC work through lite-host: the same shape apps used in contract v1
async function openWork(link, slug) {
  const cat = await catalogOf(link)
  const w = await link.call('aidlc_work', { folder: slug })
  const f = { folder: slug }
  const call = (name, extra) => link.call(name, { ...f, ...(extra || {}) })
  return {
    ...w,
    describeStage: (s) => cat.bySlug[s] || { slug: s, number: null, phase: null, name: s, role: null, roleKey: null },
    roleName: (k) => cat.roles[k] || k,
    roleKeys: Object.keys(cat.roles),
    fresh: () => call('aidlc_fresh'),
    questions: () => call('aidlc_questions'),
    reviews: () => call('aidlc_reviews'),
    units: () => call('aidlc_units'),
    bolts: (units) => call('aidlc_bolts', { units }),
    events: () => call('aidlc_events'),
    unitMetrics: () => call('aidlc_unit_metrics'),
    docs: () => call('aidlc_docs'),
    readDoc: (path) => call('aidlc_read_doc', { path }),
    refs: (text, stage) => call('aidlc_refs', { text: String(text || ''), stage: stage || undefined }),
    members: () => call('aidlc_members'),
    holders: (roleKey) => call('aidlc_holders', { roleKey }),
    deciders: (roleKey) => call('aidlc_deciders', { roleKey: roleKey || null }),
    mayDecide: (roleKey) => call('aidlc_may_decide', { roleKey: roleKey || null }),
    session: () => call('aidlc_session'),
    screen: (lines) => call('aidlc_screen', { lines }),
    decide: (body) => call('aidlc_decide', body),
    answers: (body) => call('aidlc_answers', body),
    mob: (opts) => call('aidlc_mob', { only: opts?.only }),
  }
}

// The context for one request of app `manifest`, as `user` (null: the watcher's hooks)
export function makeContext(manifest, user) {
  const id = manifest.id
  let link = null
  const host = async () => (link ||= await hostLink({ appId: id, user }))
  return {
    contract: 2,
    app: { id, version: manifest.version },
    user: user ? { id: user.id, name: user.name } : null,
    db: { q },                       // the app's own tables (app_<id>_*), apps embedded in this server only
    L, isEn,
    tenant: () => config.tenantId,
    host: { call: async (name, args) => (await host()).call(name, args) },
    aidlc: { open: async (slug) => openWork(await host(), slug) },
    events: { toFolder: async (folder, type, data) => (await host()).call('events_publish', { folder: folder.slug || folder, type, data }) },
    notify: async (userId, card) => (await host()).call('notify_user', { userId, title: card.title, text: card.text, url: card.url }),
    close: () => link?.close(),
  }
}
