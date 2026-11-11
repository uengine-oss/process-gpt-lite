// lite-host: what Lite offers its apps, as an MCP server (docs/robo-dlc/plan-mcp-apps.md §1). An app reaches
// a folder's AI-DLC work, its people, the team session, the two ways a decision gets into that session,
// live events to the folder and Home cards — all as tools of this server, always as one person (or, for
// the watcher's hooks, as the server itself). Apps in this process call it over an in-memory link; an app
// running as its own service calls the same tools at /api/apps/_host/mcp with the person's token.
import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { config } from '../../config.js'
import { emit } from '../bus.js'
import { notifyUser } from '../notify.js'
import * as F from '../folders/service.js'
import * as R from '../aidlc/record.js'
import * as M from '../aidlc/metrics.js'
import * as AS from '../aidlc/session.js'
import * as TM from '../aidlc/team.js'
import * as MOB from '../aidlc/mob.js'
import { STAGES, describeStage, roleName, ROLE_KEYS } from '../aidlc/stages.js'

const err = (status, message) => Object.assign(new Error(message), { status })
const pub = (f) => ({ id: f.id, slug: f.slug, name: f.name })

// one folder's AI-DLC work as this person (null: the server's own look, for the watcher's hooks)
async function work(slug, user) {
  const { folder, role } = user ? await F.access(R.safeName(slug), user, 'viewer') : { folder: await F.folderBySlug(R.safeName(slug)), role: 'viewer' }
  if (!folder) throw err(404, 'folder not found')
  if (!folder.repo_path || !(await R.hasAidlc(folder.repo_path))) throw err(404, 'no AI-DLC record in this folder')
  const cur = await TM.currentIntent(folder.repo_path)
  return { folder, role, cur, dir: cur?.dir }
}
const need = (w) => { if (!w.dir) throw err(404, 'no AI-DLC work in this folder'); return w.dir }
const sessionOf = (folder) => AS.sessionName(config.tenantId, folder.slug)

// The tools: name → [input shape, (args, who) => value]. Every folder tool takes `folder` (its slug).
const F_ = { folder: z.string() }
const TOOLS = {
  aidlc_catalog: [{}, () => ({ stages: STAGES.map((s) => describeStage(s.slug)), roles: Object.fromEntries(ROLE_KEYS.map((k) => [k, roleName(k)])) })],
  aidlc_work: [F_, async ({ folder }, who) => {
    const w = await work(folder, who.user)
    const { cur } = w
    return {
      folder: pub(w.folder), role: w.role, canEdit: F.RANK[w.role] >= F.RANK.editor,
      intent: cur && { space: cur.space, slug: cur.slug, scope: cur.scope, status: cur.state.status, project: cur.state.project },
      stage: cur?.stage || null, unit: cur?.unit || null, stateStage: cur ? describeStage(cur.state.currentStage) : null,
    }
  }],
  aidlc_fresh: [F_, async ({ folder }, who) => { const w = await work(folder, who.user); if (w.dir) R.forget(w.dir); return true }],
  aidlc_questions: [F_, async ({ folder }, who) => R.listQuestions(need(await work(folder, who.user)))],
  aidlc_reviews: [F_, async ({ folder }, who) => R.listReviews(need(await work(folder, who.user)))],
  aidlc_units: [F_, async ({ folder }, who) => R.readUnits(need(await work(folder, who.user)))],
  aidlc_bolts: [{ ...F_, units: z.array(z.string()).optional() }, async ({ folder, units }, who) => R.readBolts(need(await work(folder, who.user)), units || [])],
  aidlc_events: [F_, async ({ folder }, who) => R.readAudit(need(await work(folder, who.user)))],
  aidlc_unit_metrics: [F_, async ({ folder }, who) => { const dir = need(await work(folder, who.user)); return M.unitMetrics(await R.readAudit(dir), await R.readUnits(dir)) }],
  aidlc_docs: [F_, async ({ folder }, who) => R.docList(need(await work(folder, who.user)))],
  aidlc_read_doc: [{ ...F_, path: z.string() }, async ({ folder, path }, who) => R.readDoc(need(await work(folder, who.user)), path)],
  aidlc_refs: [{ ...F_, text: z.string(), stage: z.string().optional() }, async ({ folder, text, stage }, who) => { const dir = need(await work(folder, who.user)); return R.resolveRefs(text, await R.docList(dir), stage) }],
  aidlc_members: [F_, async ({ folder }, who) => (await F.members((await work(folder, who.user)).folder.id)).filter((m) => m.type === 'user' && !m.is_agent).map((m) => ({ id: m.id, name: m.name, role: m.role }))],
  aidlc_holders: [{ ...F_, roleKey: z.string() }, async ({ folder, roleKey }, who) => TM.holders((await work(folder, who.user)).folder.id, roleKey)],
  aidlc_deciders: [{ ...F_, roleKey: z.string().nullable().optional() }, async ({ folder, roleKey }, who) => TM.deciders((await work(folder, who.user)).folder, roleKey || null)],
  aidlc_may_decide: [{ ...F_, roleKey: z.string().nullable().optional() }, async ({ folder, roleKey }, who) => {
    const w = await work(folder, who.user)
    if (!who.user) return false
    if (F.RANK[w.role] >= F.RANK.editor) return true
    return roleKey ? (await TM.holders(w.folder.id, roleKey)).some((p) => p.id === who.user.id) : false
  }],
  aidlc_session: [F_, async ({ folder }, who) => {
    const w = await work(folder, who.user)
    const name = sessionOf(w.folder)
    const running = await AS.has(name)
    const choice = running ? AS.parseChoice(await AS.screen(name).catch(() => '')) : null
    return { running, workroom: `/workroom/aidlc/${w.folder.slug}`, choice: choice && { ...choice, kind: TM.promptKind(choice), title: TM.promptTitle(TM.promptKind(choice), w.cur?.stage?.name || '') } }
  }],
  // the last lines of the session's screen that have something on them (the terminal leaves rows blank)
  aidlc_screen: [{ ...F_, lines: z.number().optional() }, async ({ folder, lines = 40 }, who) => {
    const w = await work(folder, who.user)
    const name = sessionOf(w.folder)
    if (!(await AS.has(name))) return null
    const text = await AS.screen(name).catch(() => '')
    return text.split('\n').filter((l) => l.trim()).slice(-Math.min(Math.max(lines, 5), 120)).join('\n')
  }],
  aidlc_decide: [{ ...F_, fingerprint: z.string().optional(), option: z.number(), text: z.string().optional() }, async ({ folder, ...body }, who) => {
    if (!who.user) throw err(403, 'a person decides')
    return TM.decide(folder, who.user, body)
  }],
  aidlc_answers: [{ ...F_, path: z.string(), answers: z.record(z.string(), z.string()), proposalId: z.string().optional() }, async ({ folder, ...body }, who) => {
    if (!who.user) throw err(403, 'a person decides')
    return TM.submitAnswers(folder, who.user, body)
  }],
  aidlc_mob: [{ ...F_, only: z.array(z.string()).optional() }, async ({ folder, only }, who) => {
    if (!who.user) throw err(403, 'a person starts a meeting')
    return MOB.startMob(folder, who.user, { only })
  }],
  // live to everyone in the folder who has Lite open: the SSE event 'app', for this app's screens only
  events_publish: [{ ...F_, type: z.string(), data: z.any().optional() }, async ({ folder, type, data }, who) => {
    const { folder: f } = await work(folder, who.user)
    for (const m of await F.members(f.id)) if (m.type === 'user' && !m.is_agent) emit(m.id, 'app', { app: who.appId, folder: f.slug, type, data: data ?? {} })
    return true
  }],
  // a Home card (the server's own hooks only: a person's app cannot send cards in others' names)
  notify_user: [{ userId: z.string(), title: z.string(), text: z.string().optional(), url: z.string().optional() }, async ({ userId, title, text, url }, who) => {
    if (who.user) throw err(403, 'cards come from the server')
    await notifyUser(userId, { type: 'aidlc', title, text: text || '', url: url || null })
    return true
  }],
}
export const HOST_TOOLS = Object.keys(TOOLS)

// the lite-host server for one app and one person (user null: the server itself)
export function hostServer({ appId, user }) {
  const server = new McpServer({ name: 'lite-host', version: '1.0.0' })
  const who = { appId, user }
  for (const [name, [shape, fn]] of Object.entries(TOOLS)) {
    server.registerTool(name, { description: name.replace(/_/g, ' '), inputSchema: shape }, async (args) => {
      try {
        const value = await fn(args || {}, who)
        return { content: [{ type: 'text', text: JSON.stringify(value ?? null).slice(0, 2000) }], structuredContent: { value: value ?? null } }
      } catch (e) {
        if (!e.status) console.warn('[lite-host]', appId, name, e.message)
        return { isError: true, content: [{ type: 'text', text: e.message }], structuredContent: { error: e.message, status: e.status || 500 } }
      }
    })
  }
  return server
}
