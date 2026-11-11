// The IeumOffice editors (process-gpt office-host at /office/<editor>/) as an MCP App (contract v2,
// docs/robo-dlc/plan-mcp-apps.md §5). Built into the host. The screen ui://office/editor runs behind the sandbox proxy
// (origin: true: the editor keeps its settings in its origin and the page used to reach into its document) and holds
// the editor in a frame of that same origin. The editor's own message protocol (source 'ieum-office' / 'process-gpt')
// is unchanged: the screen passes the editor's messages to the page as Lite's notification 'office' and the page's to
// the editor through the screen tool office_post; what the page did inside the editor's document (fold the ribbon or
// the 한글 tool box, hide the AI dock) are the screen's tools too.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server'

export const OFFICE_DIR = path.dirname(fileURLToPath(import.meta.url))
export const OFFICE_MANIFEST = {
  id: 'office', version: '2.0.0', contract: 2, name: { ko: '이음오피스 편집기', en: 'IeumOffice editors' }, icon: '📄', description: null,
  entry: 'office_open', requires: [], mounts: ['sheet'], handles: [], origin: true, builtin: true,
}
export const EDITORS = ['docs', 'sheets', 'slides', 'pdf', 'markdown', 'html', 'mindmap', 'hwp']
const VIEW = 'ui://office/editor'
const UI = { csp: {}, permissions: { clipboardWrite: {} } }

export function registerOffice(server) {
  registerAppResource(server, '이음오피스 편집기', VIEW, { description: 'An IeumOffice editor with the document open in it', _meta: { ui: UI } },
    async () => ({ contents: [{ uri: VIEW, mimeType: RESOURCE_MIME_TYPE, text: fs.readFileSync(path.join(OFFICE_DIR, 'ui', 'index.html'), 'utf8'), _meta: { ui: UI } }] }))
  registerAppTool(server, 'office_open', {
    title: 'Open in IeumOffice', description: 'A document in its IeumOffice editor (the page hands the editor\'s address to the screen).',
    inputSchema: { editor: z.string(), name: z.string().optional(), readOnly: z.boolean().optional() }, _meta: { ui: { resourceUri: VIEW } },
  }, async ({ editor, name, readOnly }) => {
    if (!EDITORS.includes(editor)) return { isError: true, content: [{ type: 'text', text: 'no such editor' }], structuredContent: { error: 'no such editor', status: 404 } }
    const value = { editor, name: name || '', readOnly: !!readOnly }
    return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: { value } }
  })
}
