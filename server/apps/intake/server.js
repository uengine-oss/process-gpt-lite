// 작업 접수 (docs/robo-dlc/plan-intake.md §2–§6, plan-p3-impl.md) as an MCP App: anyone in the project says what
// they want done; the plan Lite proposes for it — scope, what it touches, what it collides with — is shown as a
// card; the people who take in work start it, queue it after the work in flight, or fold it in. The requests,
// the line and who may do what are Lite's (lite-host: aidlc_intake*); this app is their screen.
import { z } from 'zod'
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server'

const VIEW = 'ui://intake/view'
const run = (fn) => async (args) => {
  try {
    const value = await fn(args || {})
    return { content: [{ type: 'text', text: JSON.stringify(value).slice(0, 1500) }], structuredContent: { value } }
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: e.message }], structuredContent: { error: e.message, status: e.status || 500 } }
  }
}

export default function register(server, ctx) {
  const host = (name) => (args) => ctx.host.call(name, args)
  const A = { folder: z.string().optional().describe('the shared folder that holds the AI-DLC record (its slug); left out on an address made for one folder') }
  const ui = (visibility) => ({ ui: { resourceUri: VIEW, ...(visibility ? { visibility } : {}) } })
  registerAppResource(server, '작업 접수', VIEW, { description: 'New work for the AI-DLC project: the request, the proposed plan, and the inbox of requests' },
    async () => ({ contents: [{ uri: VIEW, mimeType: RESOURCE_MIME_TYPE, text: await ctx.screen() }] }))
  registerAppTool(server, 'intake_open', {
    title: 'Work intake', description: 'The requests of a folder\'s AI-DLC project with the plan proposed for each (scope, units touched, conflicts with the bolts in the line), the work in flight, and what this person may do.',
    inputSchema: { ...A, r: z.string().optional().describe('a request to open') }, _meta: ui(),
  }, run(({ folder }) => ctx.host.call('aidlc_intake', { folder })))
  registerAppTool(server, 'intake_propose', {
    title: 'Ask for work', description: 'Ask for a piece of work in plain words. The plan for it is worked out in the background (about a minute) and shown on the intake screen.',
    inputSchema: { ...A, body: z.string().describe('what should be done, in the person\'s own words'), source: z.string().optional() }, _meta: ui(['app', 'model']),
  }, run(host('aidlc_intake_propose')))
  registerAppTool(server, 'intake_again', { title: 'Work the plan out again', description: 'Estimate a request again after a failure.', inputSchema: { ...A, id: z.string() }, _meta: ui(['app']) }, run(host('aidlc_intake_again')))
  registerAppTool(server, 'intake_impact', {
    title: 'Confirm what it touches', description: 'The architect confirms or corrects the units a request touches.',
    inputSchema: { ...A, id: z.string(), units: z.array(z.string()).optional(), note: z.string().optional() }, _meta: ui(['app']),
  }, run(host('aidlc_intake_impact')))
  registerAppTool(server, 'intake_approve', {
    title: 'Take the request in', description: 'Start it now, queue it after the work in flight, or fold it into that work (mode: now | after | merge). A folder Claude Code opens for the first time answers { status: "trust" }: nothing started — the person is asked whether the folder is trusted, and the call is made again with trust: true.',
    inputSchema: { ...A, id: z.string(), scope: z.string().optional(), mode: z.string().optional(), fast: z.boolean().optional(), note: z.string().optional(), trust: z.boolean().optional() }, _meta: ui(['app']),
  }, run(host('aidlc_intake_approve')))
  registerAppTool(server, 'intake_triage', {
    title: 'Later, or not at all', description: 'Put a request off or decline it with a reason (action: later | decline), or take one\'s own request back (withdraw).',
    inputSchema: { ...A, id: z.string(), action: z.string(), note: z.string().optional() }, _meta: ui(['app']),
  }, run(host('aidlc_intake_triage')))
  // a request that collides with a bolt of the line: what discarding that bolt would mean, and doing it
  registerAppTool(server, 'intake_discard_preview', { title: 'What discarding a bolt means', description: 'Before discarding a bolt a request collides with.', inputSchema: { ...A, key: z.string() }, _meta: ui(['app']) }, run(host('aidlc_line_discard_preview')))
  registerAppTool(server, 'intake_discard', {
    title: 'Discard the bolt it collides with', description: 'Discard a bolt of the line in favour of a request, with the reason.',
    inputSchema: { ...A, key: z.string(), reason: z.string(), dependents: z.string().optional(), forRequest: z.string().nullable().optional(), archive: z.boolean().optional() }, _meta: ui(['app']),
  }, run(host('aidlc_line_discard')))
}
