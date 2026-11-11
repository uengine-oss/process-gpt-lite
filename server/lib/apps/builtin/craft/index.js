// The ArtCraft editors (CADCraft · VectorCraft · PhotoCraft · SoundCraft · FilmCraft) as an MCP App (contract v2,
// docs/robo-dlc/plan-mcp-apps.md §5). Built into the host. The screen ui://craft/editor runs behind the sandbox proxy
// (origin: true: the builds keep settings and fonts in their origin) and holds the app's web build in a frame of
// that same origin, so it can hand the file over and catch saves the way the page used to from outside. What the
// page and the screen pass each other: the file (the screen's tool craft_file), saves and exports
// (ui/download-file), the screen's state (Lite's notification) and live requests (the screen's tool craft_request).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server'
import { CRAFT_APPS, craftStatus } from '../../../../mcp/craft.js'

export const CRAFT_DIR = path.dirname(fileURLToPath(import.meta.url))
export const CRAFT_MANIFEST = {
  id: 'craft', version: '2.0.0', contract: 2, name: { ko: 'ArtCraft 편집기', en: 'ArtCraft editors' }, icon: '🎨', description: null,
  entry: 'craft_open', requires: [], mounts: ['sheet'], handles: [], origin: true, builtin: true,
}
const VIEW = 'ui://craft/editor'
const err = (status, message) => Object.assign(new Error(message), { status })

export function registerCraft(server) {
  registerAppResource(server, 'ArtCraft 편집기', VIEW, {
    description: 'An ArtCraft web app with the file open in it',
    // its own origin's files only (the build, its fonts); the clipboard for copy and paste inside the app
    _meta: { ui: { csp: {}, permissions: { clipboardWrite: {} } } },
  }, async () => ({ contents: [{ uri: VIEW, mimeType: RESOURCE_MIME_TYPE, text: fs.readFileSync(path.join(CRAFT_DIR, 'ui', 'index.html'), 'utf8'), _meta: { ui: { csp: {}, permissions: { clipboardWrite: {} } } } }] }))
  registerAppTool(server, 'craft_open', {
    title: 'Open in an ArtCraft app', description: 'A file in its ArtCraft web app (the page hands the file to the screen).',
    inputSchema: { app: z.string(), name: z.string().optional(), lang: z.enum(['ko', 'en']).optional() }, _meta: { ui: { resourceUri: VIEW } },
  }, async ({ app, name, lang }) => {
    try {
      if (!Object.hasOwn(CRAFT_APPS, app)) throw err(404, 'no such ArtCraft app')
      if (!craftStatus()[app]?.web) throw err(404, `${app} is not installed here`)
      const value = { app, name: name || '', lang: lang || 'ko' }
      return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: { value } }
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: e.message }], structuredContent: { error: e.message, status: e.status || 500 } }
    }
  })
}
