// HTTP routes of scenario 1 「금요일 출시」 (pgpt-pro/docs/agentic-bpm/plan.md §6, lib/scenarios/release.js) and the
// path optimizer's records (lib/optimize): request a release, the optimizations with their alternatives, the
// accountable person's choice, a re-run against today's strategy graph (preview or a new optimization), stop.
import express from 'express'
import { L } from '../lib/lang.js'
import { isAdmin } from '../lib/team.js'
import { requestRelease, planOf, findingsOf, deployments, DEMO_PLAN, ACCOUNTABLE } from '../lib/scenarios/release.js'
import { load, list, choose, rerun, stop, cardOf } from '../lib/optimize/index.js'
import { canApprove } from '../lib/policy/pep.js'
import { MODEL } from '../lib/optimize/simulate.js'
import { WEIGHTS } from '../lib/optimize/score.js'

const send = (res, p) => p.then((x) => res.json(x)).catch((e) => {
  if (!e.status) console.warn('[release]', e.stack || e.message)
  res.status(e.status || 500).json({ error: e.message })
})

// what a screen needs of one optimization: the card's view plus the full alternatives (sims, score parts, phases)
async function view(o, me) {
  return { ...(await cardOf(o)), created_at: o.created_at, decided_at: o.decided_at, user_id: o.user_id, requester: o.requester || null,
    mayChoose: o.status === 'proposed' && await canApprove(me, o.trigger?.accountableRole || ACCOUNTABLE), full: o.alternatives }
}

export function scenarioReleaseRoutes(auth) {
  const r = express.Router()

  // the release plan, the QA agent's findings, and the demo deployment log
  r.get('/release/plan', auth, (req, res) => send(res, (async () => {
    const plan = await planOf(req.query.id || DEMO_PLAN.id)
    return { plan, findings: await findingsOf(plan.id), deployments: await deployments(), accountable: ACCOUNTABLE }
  })()))
  r.post('/release/requests', auth, (req, res) => send(res, requestRelease(req.user, req.body || {})))

  // optimizations (newest first) and one of them
  r.get('/release/optimizations', auth, (req, res) => send(res, (async () => {
    const rows = await list({ limit: Math.min(50, Number(req.query.limit) || 20), kind: 'release.deploy' })
    return { optimizations: await Promise.all(rows.map((o) => view(o, req.user))), model: MODEL, weights: WEIGHTS, admin: await isAdmin(req.user) }
  })()))
  r.get('/release/optimizations/:id', auth, (req, res) => send(res, (async () => view(await load(req.params.id), req.user))()))
  r.post('/release/optimizations/:id/choose', auth, (req, res) => send(res, (async () => {
    if (!req.body?.alternative) throw Object.assign(new Error(L('고를 대안을 알려 주세요.', 'Which alternative?')), { status: 400 })
    return view(await choose(req.user, req.params.id, String(req.body.alternative)), req.user)
  })()))
  // preview: the same alternatives scored against today's graph, nothing written; otherwise a new optimization
  r.post('/release/optimizations/:id/rerun', auth, (req, res) => send(res, (async () => {
    const b = req.body || {}
    const out = await rerun(req.user, req.params.id, { preview: !!b.preview, ask: b.ask, unheldRoles: Array.isArray(b.unheldRoles) ? b.unheldRoles : undefined })
    return out.preview ? out : view(out, req.user)
  })()))
  r.post('/release/optimizations/:id/stop', auth, (req, res) => send(res, (async () => view(await stop(req.user, req.params.id, req.body?.note || ''), req.user))()))

  return r
}
