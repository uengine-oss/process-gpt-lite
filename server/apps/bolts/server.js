// 볼트 보드 (docs/robo-dlc/plan-review.md §3.2) as an MCP App: intent → bolts (delivery-planning/bolt-plan.md) →
// units (units-generation) → each unit's construction stages from the audit; the unit the session is on now,
// its progress, its artifacts, and the session's screen. Tools here, the screen is ui://bolts/view; Lite's
// record only through ctx (lite-host).
import { z } from 'zod'
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server'
import { stageTimes, buildUnitTree, unitBolts, UNIT_STAGES } from './tree.js'

const VIEW = 'ui://bolts/view'
const run = (fn) => async (args) => {
  try {
    const value = await fn(args || {})
    return { content: [{ type: 'text', text: JSON.stringify(value).slice(0, 1500) }], structuredContent: { value } }
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: e.message }], structuredContent: { error: e.message, status: e.status || 500 } }
  }
}
const err = (status, message) => Object.assign(new Error(message), { status })
const LABEL = {
  UNIT_STARTED: ['단계 시작', 'stage started'], UNIT_COMPLETED: ['단계 끝', 'stage done'], PLAN_APPROVAL_BLOCKED: ['코드 계획 승인 대기', 'code plan awaits approval'],
  PLAN_APPROVAL_RECORDED: ['코드 계획 승인', 'code plan approved'], CHECKPOINT_VERIFICATION_RECORDED: ['체크포인트 검증', 'checkpoint check'],
  GATE_APPROVED: ['유닛 승인', 'unit approved'], REVIEW_COMPLETED: ['검토 끝', 'review done'], CHANGE_ACCEPTED: ['변경 받아들임', 'change accepted'], SENSOR_FAILED: ['센서 실패', 'sensor failed'],
}

export default function register(server, ctx) {
  const L = ctx.L
  async function tree({ folder }) {
    const w = await ctx.aidlc.open(folder)
    const units = await w.unitMetrics()
    const events = await w.events()
    const plan = await w.bolts(units.map((u) => u.name))
    const session = await w.session()
    const complete = /complete/i.test(w.intent?.status || '')
    const rows = buildUnitTree({ units, plan, times: stageTimes(events), events, now: w.unit, complete })
    return {
      folder: w.folder, intent: w.intent, stage: w.stage, now: w.unit, session: { running: session.running, workroom: session.workroom, prompt: session.choice && { kind: session.choice.kind, title: session.choice.title } },
      stageNames: Object.fromEntries(UNIT_STAGES.map((s) => [s, w.describeStage(s).name])),
      units: rows, plan: plan.map(({ n, name, units: us }) => ({ n, name, units: us })),
    }
  }
  // one unit: its row, what happened to it lately, its documents
  async function unit({ folder, name }) {
    const w = await ctx.aidlc.open(folder)
    const units = await w.unitMetrics()
    const u = units.find((x) => x.name === name)
    if (!u) throw err(404, 'no such unit')
    const events = (await w.events()).filter((e) => e.unit === name)
    const times = stageTimes(events).get(name) || new Map()
    const docs = (await w.docs()).filter((d) => d.unit === name)
    // (the stages' own times, as on the tree: a late UNIT_STARTED undercounts the unit's work)
    const staged = [...times.values()].reduce((n, s) => n + (s.min || 0), 0)
    const row = { ...u, workMin: Math.max(u.workMin || 0, Math.round((staged - (u.humanMin || 0)) * 10) / 10) }
    return {
      unit: row, running: !!w.unit && w.unit.unit === name, now: w.unit,
      bolts: unitBolts(events, name, { complete: /complete/i.test(w.intent?.status || '') }),
      stages: UNIT_STAGES.map((s) => ({ slug: s, name: w.describeStage(s).name, role: w.describeStage(s).role, state: u.stages?.[s] || 'pending', min: times.get(s)?.min ?? null })),
      events: events.filter((e) => LABEL[e.event]).slice(-12).reverse().map((e) => ({ ts: e.ts, what: L(...LABEL[e.event]), stage: w.describeStage(e.stage).name, detail: e.fields?.Verified ? `${e.fields.Verified === 'true' ? '✓' : '✗'} ${e.fields['Command'] || ''}`.trim() : '' })),
      docs: docs.map((d) => ({ path: d.path, name: d.path.split('/').pop(), stage: w.describeStage(d.stage).name, order: UNIT_STAGES.indexOf(d.stage) })).sort((a, b) => a.order - b.order),
    }
  }
  // the shared session's screen now (the folder's members see it in the workroom too)
  async function screen({ folder, lines }) {
    const w = await ctx.aidlc.open(folder)
    const text = await w.screen(Number(lines) || 32)
    const s = await w.session()
    return { running: text != null, text: text || '', now: w.unit, prompt: s.choice && { kind: s.choice.kind, title: s.choice.title }, workroom: s.workroom }
  }
  const A = { folder: z.string().optional().describe('the shared folder that holds the AI-DLC record (its slug); left out on an address made for one folder') }
  registerAppResource(server, '볼트 보드', VIEW, { description: 'Bolts, units and their construction stages, and the session building the unit now' },
    async () => ({ contents: [{ uri: VIEW, mimeType: RESOURCE_MIME_TYPE, text: await ctx.screen() }] }))
  registerAppTool(server, 'bolts_open', {
    title: 'Bolt board', description: 'The AI-DLC work of a folder as its units, each with its design stages and its bolts (the passes that build it, with their checks and send-backs), and the unit the team session is building now.',
    inputSchema: { ...A, unit: z.string().optional() }, _meta: { ui: { resourceUri: VIEW } },
  }, run(tree))
  registerAppTool(server, 'bolts_unit', {
    title: 'A unit\'s progress', description: 'One unit: stages with times, recent events, its artifacts.',
    inputSchema: { ...A, name: z.string() }, _meta: { ui: { resourceUri: VIEW, visibility: ['app', 'model'] } },
  }, run(unit))
  registerAppTool(server, 'bolts_screen', {
    title: 'The session screen', description: 'The last lines of the team session\'s Claude Code screen.',
    inputSchema: { ...A, lines: z.number().optional() }, _meta: { ui: { resourceUri: VIEW, visibility: ['app'] } },
  }, run(screen))
}
