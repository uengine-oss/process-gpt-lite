// 볼트 줄 (docs/robo-dlc/plan-intake.md §7–§10, plan-p3-impl.md) as an MCP App: every bolt of the project in one
// line — released, this release, the next, the tail where new work stacks — with the dependencies between them.
// The people the project gave it to move a bolt to another release, hold it, discard it, start the next work
// and release; anyone may ask for a bolt to be stopped. The line is Lite's (lite-host: aidlc_intake, aidlc_line_*).
import { z } from 'zod'
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server'

const VIEW = 'ui://line/view'
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
  registerAppResource(server, '볼트 줄', VIEW, { description: 'Every bolt of the project in one line, by release, with dependencies; move, hold, stop, discard, release' },
    async () => ({ contents: [{ uri: VIEW, mimeType: RESOURCE_MIME_TYPE, text: await ctx.screen() }] }))
  registerAppTool(server, 'line_open', {
    title: 'Bolt line', description: 'The one line of bolts of a folder\'s AI-DLC project: each bolt\'s state, release (shipped, now, next, tail), what it waits for, holds, stop requests and discards, and what this person may do.',
    inputSchema: { ...A, b: z.string().optional().describe('a bolt to open (its key)') }, _meta: ui(),
  }, run(({ folder }) => ctx.host.call('aidlc_intake', { folder })))
  registerAppTool(server, 'line_move', {
    title: 'Move a bolt to another release', description: 'bucket: now | next | tail. A move that would break a dependency is not made: the blockers come back, with the bolts that must move along (together: true moves them).',
    inputSchema: { ...A, key: z.string(), bucket: z.string(), together: z.boolean().optional() }, _meta: ui(['app']),
  }, run(host('aidlc_line_move')))
  registerAppTool(server, 'line_hold', { title: 'Hold a bolt, or let it go on', description: 'hold: true | false.', inputSchema: { ...A, key: z.string(), hold: z.boolean().optional(), reason: z.string().optional() }, _meta: ui(['app']) }, run(host('aidlc_line_hold')))
  registerAppTool(server, 'line_stop_request', {
    title: 'Ask for a bolt to be stopped', description: 'Anyone in the project, with the reason. security: true pauses the session at once.',
    inputSchema: { ...A, key: z.string(), reason: z.string(), security: z.boolean().optional() }, _meta: ui(['app']),
  }, run(host('aidlc_line_stop_request')))
  registerAppTool(server, 'line_release', { title: 'Release', description: 'Release the bolts of a release (bucket, default now) once all are finished.', inputSchema: { ...A, bucket: z.string().optional() }, _meta: ui(['app']) }, run(host('aidlc_line_release')))
  registerAppTool(server, 'line_discard_preview', { title: 'What discarding a bolt means', description: 'The kind of discard, the bolts that wait for it, the files that would be put back.', inputSchema: { ...A, key: z.string() }, _meta: ui(['app']) }, run(host('aidlc_line_discard_preview')))
  registerAppTool(server, 'line_discard', {
    title: 'Discard a bolt', description: 'With the reason. dependents: hold | discard | keep.',
    inputSchema: { ...A, key: z.string(), reason: z.string(), dependents: z.string().optional(), forRequest: z.string().nullable().optional(), archive: z.boolean().optional() }, _meta: ui(['app']),
  }, run(host('aidlc_line_discard')))
  // the head of the line is free: a person starts the work that is next
  registerAppTool(server, 'line_start', { title: 'Start the next work', description: 'Start a queued request now. A folder Claude Code opens for the first time answers { status: "trust" }: the person is asked, and the call is made again with trust: true.', inputSchema: { ...A, id: z.string(), trust: z.boolean().optional() }, _meta: ui(['app']) },
    run(({ folder, id, trust }) => ctx.host.call('aidlc_intake_approve', { folder, id, mode: 'now', trust })))
}
