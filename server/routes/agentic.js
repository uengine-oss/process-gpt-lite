// HTTP routes for the Agentic BPM PoC core (plan.md): the policy catalog and its switches, the decision ledger,
// approvals and undo (lib/policy), the strategy graph (lib/strategy). The scenarios add their own routers
// (routes/scenario-*.js).
import express from 'express'
import { q } from '../lib/supa.js'
import { config } from '../config.js'
import { L } from '../lib/lang.js'
import { isAdmin } from '../lib/team.js'
import { policiesOf, savePolicy, setEnabled, evaluate } from '../lib/policy/pdp.js'
import { answer, undo, canApprove } from '../lib/policy/pep.js'
import { graphOf, saveObjective, saveLink, removeObjective } from '../lib/strategy/graph.js'

const send = (res, p) => p.then((x) => res.json(x)).catch((e) => {
  if (!e.status) console.warn('[agentic]', e.stack || e.message)
  res.status(e.status || 500).json({ error: e.message })
})
const T = () => config.tenantId
async function mustAdmin(me) {
  if (!(await isAdmin(me))) throw Object.assign(new Error(L('관리자만 바꿀 수 있어요.', 'Only administrators can change this.')), { status: 403 })
}

export function agenticRoutes(auth) {
  const r = express.Router()

  // the catalog: every policy with its switch
  r.get('/policies', auth, (req, res) => send(res, (async () => ({ admin: await isAdmin(req.user), policies: await policiesOf(T(), { all: true }) }))()))
  r.put('/policies/:id', auth, (req, res) => send(res, (async () => {
    await mustAdmin(req.user)
    if (req.body.spec) await savePolicy(req.user, { ...req.body.spec, id: req.params.id }, { enabled: req.body.enabled !== false })
    else await setEnabled(req.user, req.params.id, req.body.enabled)
    return { ok: true }
  })()))
  // try an action against the policies without running or recording it
  r.post('/policies/evaluate', auth, (req, res) => send(res, evaluate({ userId: req.user.id, action: req.body })))

  // the ledger: decisions (an administrator sees everyone's, a person their own and those they may approve)
  r.get('/decisions', auth, (req, res) => send(res, (async () => {
    const admin = await isAdmin(req.user)
    const rows = await q(`select d.id, d.user_id, u.username as name, d.action_kind, d.subject, d.facts, d.decision, d.matched, d.dry_run, d.status,
        d.approver_role, d.approved_by, d.approved_at, d.result, d.created_at, a.undo_until
      from pro_policy_decisions d left join users u on u.id=d.user_id and u.tenant_id=d.tenant_id left join pro_policy_actions a on a.decision_id=d.id
      where d.tenant_id=$1 and ($2 or d.user_id=$3 or d.status='pending') and ($4::text is null or d.status=$4) and ($5 or not d.dry_run)
      order by d.created_at desc limit 200`, [T(), admin, req.user.id, req.query.status || null, req.query.dry === '1'])
    const out = []
    for (const d of rows) {
      const mayDecide = d.status === 'pending' && await canApprove(req.user, d.approver_role)
      if (admin || String(d.user_id) === String(req.user.id) || mayDecide) out.push({ ...d, mayDecide })
    }
    return { admin, decisions: out }
  })()))
  r.post('/decisions/:id/approve', auth, (req, res) => send(res, answer(req.user, req.params.id, true, req.body?.note || '')))
  r.post('/decisions/:id/reject', auth, (req, res) => send(res, answer(req.user, req.params.id, false, req.body?.note || '')))
  r.post('/decisions/:id/undo', auth, (req, res) => send(res, undo(req.user, req.params.id)))

  // the strategy graph
  r.get('/strategy', auth, (req, res) => send(res, graphOf()))
  r.put('/strategy/objectives/:id', auth, (req, res) => send(res, (async () => { await mustAdmin(req.user); await saveObjective({ ...req.body, id: req.params.id }); return graphOf() })()))
  r.delete('/strategy/objectives/:id', auth, (req, res) => send(res, (async () => { await mustAdmin(req.user); await removeObjective(req.params.id); return graphOf() })()))
  r.put('/strategy/links', auth, (req, res) => send(res, (async () => { await mustAdmin(req.user); await saveLink(req.body); return graphOf() })()))

  return r
}
