// Home panels as an MCP App (contract v2, docs/robo-dlc/plan-mcp-apps.md). Built into the host: a panel is a
// row of pro_panels (html, script, data) that a model wrote or that is one of the ready-made AI-DLC
// dashboards. The screen ui://panels/view is one runtime; panel_view hands it the panel, and the old panel.*
// calls are the tools here — always as the panel's owner.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server'
import { q } from '../../../supa.js'
import { config } from '../../../../config.js'
import { savePanelData, proxyFetch } from '../../../panels.js'
import { chat } from '../../../llm.js'
import { L } from '../../../lang.js'
import * as A from '../../../aidlc/service.js'

export const PANELS_DIR = path.dirname(fileURLToPath(import.meta.url))
export const PANELS_MANIFEST = {
  id: 'panels', version: '2.0.0', contract: 2, name: { ko: '홈 패널', en: 'Home panels' }, icon: '🧩', description: null,
  entry: 'panel_view', requires: [], mounts: ['panel'], handles: [], builtin: true,
}
const VIEW = 'ui://panels/view'
const err = (status, message) => Object.assign(new Error(message), { status })
const run = (fn) => async (args) => {
  try {
    const value = await fn(args || {})
    return { content: [{ type: 'text', text: JSON.stringify(value ?? null).slice(0, 1500) }], structuredContent: { value: value ?? null } }
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: e.message }], structuredContent: { error: e.message, status: e.status || 500 } }
  }
}

// panel.aidlc(path) reads the AI-DLC dashboards (routes/aidlc.js) for the panel: only those reads, and only
// paths below /api/aidlc/ — no '..', no encoded slashes or dots that could step outside it.
const AIDLC_PATH = /^[A-Za-z0-9._~%-]+(\/[A-Za-z0-9._~%-]+)*(\?[A-Za-z0-9._~%=&-]*)?$/
export function aidlcApiPath(p) {
  const s = String(p || '')
  if (!AIDLC_PATH.test(s) || /(^|\/)\.{1,2}(\/|\?|$)/.test(s) || /%2[ef]|%5c/i.test(s)) throw new Error('panel.aidlc: path not allowed')
  return `/aidlc/${s}`
}
async function aidlcRead(path, user) {
  aidlcApiPath(path)
  const [route, query] = String(path).split('?')
  const qs = new URLSearchParams(query || '')
  const parts = route.split('/').map(decodeURIComponent)
  if (parts.length === 1 && parts[0] === 'projects') return A.projects(user)
  if (parts.length === 2 && parts[1] === 'intents') return A.intents(parts[0], user)
  if (parts.length === 5 && parts[1] === 'intents') {
    const [folder, , space, slug, what] = parts
    if (what === 'summary') return A.summary(folder, user, space, slug)
    if (what === 'timeline') return A.timeline(folder, user, space, slug, { limit: Math.min(Number(qs.get('limit')) || 50, 500) })
    if (what === 'questions') return A.questions(folder, user, space, slug)
    if (what === 'reviews') return A.reviews(folder, user, space, slug)
  }
  throw err(404, 'panel.aidlc: no such read')
}

export function registerPanels(server, ctx) {
  const user = ctx.user
  const mine = async (id) => {
    if (!user) throw err(401, 'sign in')
    const [p] = await q('select id, title, icon, spec, data from pro_panels where id=$1 and user_id=$2', [id, user.id])
    if (!p) throw err(404, 'panel not found')
    return p
  }
  registerAppResource(server, '홈 패널', VIEW, { description: 'A Home panel: its own html and script, run in the sandbox' },
    async () => ({ contents: [{ uri: VIEW, mimeType: RESOURCE_MIME_TYPE, text: await ctx.screen() }] }))
  registerAppTool(server, 'panel_view', {
    title: 'A Home panel', description: 'One of my Home panels, to show.', inputSchema: { id: z.string(), folder: z.string().optional() }, _meta: { ui: { resourceUri: VIEW } },
  }, run(async ({ id }) => { const p = await mine(id); return { id: p.id, title: p.title, html: p.spec?.html || '', script: p.spec?.script || '', data: p.data || {} } }))
  const app = { _meta: { ui: { resourceUri: VIEW, visibility: ['app'] } } }
  registerAppTool(server, 'panel_save', { description: 'Save the panel\'s data', inputSchema: { id: z.string(), data: z.any() }, ...app },
    run(async ({ id, data }) => { await mine(id); return savePanelData(user.id, id, data) }))
  registerAppTool(server, 'panel_fetch', { description: 'GET a public JSON API through the server', inputSchema: { url: z.string() }, ...app },
    run(({ url }) => proxyFetch(url)))
  registerAppTool(server, 'panel_ask', { description: 'A short answer from the model', inputSchema: { prompt: z.string() }, ...app },
    run(async ({ prompt }) => (await chat({ model: config.llm.fastModel, messages: [{ role: 'system', content: L('짧게 한국어로 답해.', 'Answer briefly in English.') }, { role: 'user', content: String(prompt).slice(0, 4000) }] })).content))
  registerAppTool(server, 'panel_aidlc', { description: 'Read the AI-DLC dashboards (read only)', inputSchema: { path: z.string() }, ...app },
    run(({ path }) => aidlcRead(path, user)))
}
