// 산출물 보기 (docs/robo-dlc/plan-review.md §3.3) as an MCP App: one document of a folder's AI-DLC record, whole,
// focused on the part a review or a question points at. Tools here, the screen is ui://artifact/view; Lite's
// record only through ctx (lite-host).
import { z } from 'zod'
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server'
import { renderDoc, findHeading } from './render.js'

const VIEW = 'ui://artifact/view'
// a tool's answer: the value for the screen, a short text for a model
const run = (fn) => async (args) => {
  try {
    const value = await fn(args || {})
    return { content: [{ type: 'text', text: JSON.stringify(value).slice(0, 1500) }], structuredContent: { value } }
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: e.message }], structuredContent: { error: e.message, status: e.status || 500 } }
  }
}

export default function register(server, ctx) {
  async function doc({ folder, path, focus = '' }) {
    const w = await ctx.aidlc.open(folder)
    const d = await w.readDoc(String(path || ''))
    const { html, headings, title } = renderDoc(d.text)
    const all = await w.docs()
    const stage = w.describeStage(d.stage)
    const siblings = all.filter((x) => x.phase === d.phase && x.stage === d.stage && x.unit === d.unit).map((x) => ({ path: x.path, name: x.path.split('/').pop() }))
    focus = String(focus || '').slice(0, 200)
    return {
      kind: 'doc', path: d.path, name: d.path.split('/').pop(), phase: d.phase, unit: d.unit || null, stage: { slug: d.stage, name: stage.name, role: stage.role },
      title, html, headings, mtime: d.mtime, siblings, docs: all.map((x) => x.path),
      focus: focus ? { text: focus, heading: findHeading(headings, focus)?.id || null } : null, intent: w.intent,
    }
  }
  async function docs({ folder }) {
    const w = await ctx.aidlc.open(folder)
    const all = await w.docs()
    return { kind: 'docs', intent: w.intent, docs: all.map((x) => ({ ...x, stageName: w.describeStage(x.stage).name, name: x.path.split('/').pop() })) }
  }
  const A = { folder: z.string().optional().describe('the shared folder that holds the AI-DLC record (its slug); left out on an address made for one folder') }

  registerAppResource(server, '산출물 보기', VIEW, { description: 'An AI-DLC document, whole, with the part under review in focus' },
    async () => ({ contents: [{ uri: VIEW, mimeType: RESOURCE_MIME_TYPE, text: await ctx.screen() }] }))
  // the entry: a document (path, focus on a section) or, with no path, the record's documents
  registerAppTool(server, 'artifact_open', {
    title: 'Open an AI-DLC artifact',
    description: 'Show one document of the folder\'s AI-DLC record whole, focused on a section (focus: a heading or an ID like ADR-004); with no path, the list of documents.',
    inputSchema: { ...A, path: z.string().optional(), focus: z.string().optional(), quote: z.string().optional() },
    _meta: { ui: { resourceUri: VIEW } },
  }, run((a) => (a.path ? doc(a) : docs(a))))
  registerAppTool(server, 'artifact_doc', {
    title: 'Read an AI-DLC artifact', description: 'One document of the record, rendered, with its headings and the stage\'s other documents.',
    inputSchema: { ...A, path: z.string(), focus: z.string().optional() }, _meta: { ui: { resourceUri: VIEW, visibility: ['app'] } },
  }, run(doc))
  registerAppTool(server, 'artifact_docs', {
    title: 'List AI-DLC artifacts', description: 'The documents of the folder\'s AI-DLC record, by stage.',
    inputSchema: A, _meta: { ui: { resourceUri: VIEW, visibility: ['app'] } },
  }, run(docs))
}
