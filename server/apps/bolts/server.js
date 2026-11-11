// 볼트 보드 (docs/robo-dlc/plan-review.md §3.2): intent → bolts (delivery-planning/bolt-plan.md) → units
// (units-generation) → each unit's construction stages from the audit; the unit the session is on now,
// its progress, its artifacts, and the session's screen. Uses the host context only.
import { stageTimes, buildTree, UNIT_STAGES } from './tree.js'

const err = (status, message) => Object.assign(new Error(message), { status })
const LABEL = {
  UNIT_STARTED: ['단계 시작', 'stage started'], UNIT_COMPLETED: ['단계 끝', 'stage done'], PLAN_APPROVAL_BLOCKED: ['코드 계획 승인 대기', 'code plan awaits approval'],
  PLAN_APPROVAL_RECORDED: ['코드 계획 승인', 'code plan approved'], CHECKPOINT_VERIFICATION_RECORDED: ['체크포인트 검증', 'checkpoint check'],
  GATE_APPROVED: ['유닛 승인', 'unit approved'], REVIEW_COMPLETED: ['검토 끝', 'review done'], CHANGE_ACCEPTED: ['변경 받아들임', 'change accepted'], SENSOR_FAILED: ['센서 실패', 'sensor failed'],
}

export default (ctx) => {
  const L = ctx.L
  async function tree(slug, user) {
    const w = await ctx.aidlc.open(slug, user)
    const units = await w.unitMetrics()
    const events = await w.events()
    const bolts = await w.bolts(units.map((u) => u.name))
    const session = await w.session()
    const rows = buildTree({ bolts, units, times: stageTimes(events), now: w.unit })
    return {
      folder: w.folder, intent: w.intent, stage: w.stage, now: w.unit, session: { running: session.running, workroom: session.workroom, prompt: session.choice && { kind: session.choice.kind, title: session.choice.title } },
      stageNames: Object.fromEntries(UNIT_STAGES.map((s) => [s, w.describeStage(s).name])),
      bolts: rows,
    }
  }
  return {
    routes(r) {
      r.get('/:folder/tree', (req) => tree(req.params.folder, req.user))
      // one unit: its row, what happened to it lately, its documents
      r.get('/:folder/unit/:name', async (req) => {
        const w = await ctx.aidlc.open(req.params.folder, req.user)
        const name = String(req.params.name)
        const units = await w.unitMetrics()
        const u = units.find((x) => x.name === name)
        if (!u) throw err(404, 'no such unit')
        const events = (await w.events()).filter((e) => e.unit === name)
        const times = stageTimes(events).get(name) || new Map()
        const docs = (await w.docs()).filter((d) => d.unit === name)
        // (the stages' own times, as on the tree: a late UNIT_STARTED undercounts the unit's work)
        const staged = [...times.values()].reduce((n, s) => n + (s.min || 0), 0)
        const unit = { ...u, workMin: Math.max(u.workMin || 0, Math.round((staged - (u.humanMin || 0)) * 10) / 10) }
        return {
          unit, running: !!w.unit && w.unit.unit === name, now: w.unit,
          stages: UNIT_STAGES.map((s) => ({ slug: s, name: w.describeStage(s).name, role: w.describeStage(s).role, state: u.stages?.[s] || 'pending', min: times.get(s)?.min ?? null })),
          events: events.filter((e) => LABEL[e.event]).slice(-12).reverse().map((e) => ({ ts: e.ts, what: L(...LABEL[e.event]), stage: w.describeStage(e.stage).name, detail: e.fields?.Verified ? `${e.fields.Verified === 'true' ? '✓' : '✗'} ${e.fields['Command'] || ''}`.trim() : '' })),
          docs: docs.map((d) => ({ path: d.path, name: d.path.split('/').pop(), stage: w.describeStage(d.stage).name, order: UNIT_STAGES.indexOf(d.stage) })).sort((a, b) => a.order - b.order),
        }
      })
      // the shared session's screen now (the folder's members see it in the workroom too)
      r.get('/:folder/screen', async (req) => {
        const w = await ctx.aidlc.open(req.params.folder, req.user)
        const text = await w.screen(Number(req.query.lines) || 32)
        const s = await w.session()
        return { running: text != null, text: text || '', now: w.unit, prompt: s.choice && { kind: s.choice.kind, title: s.choice.title }, workroom: s.workroom }
      })
    },
  }
}
