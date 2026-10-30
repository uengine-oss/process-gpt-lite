// HTTP routes of the purchase scenario (pgpt-pro/docs/agentic-bpm/plan.md §6 2, lib/scenarios/purchase): start a
// request, the approval inbox (live critical-path order + the briefs), deciding an option, placing the order from the
// draft, and the before/after measurements.
import express from 'express'
import { q } from '../lib/supa.js'
import { config } from '../config.js'
import { L } from '../lib/lang.js'
import { startProcess } from '../lib/engine.js'
import { forEachTenant } from '../lib/tenant.js'
import { DEF_ID, ACT } from '../lib/scenarios/purchase/process.js'
import { inbox, briefFor, decideOption, placeOrder, follow, startSweep, factsOf } from '../lib/scenarios/purchase/brief.js'
import { ordersOf, orderView } from '../lib/scenarios/purchase/orders.js'
import { measure } from '../lib/scenarios/purchase/measure.js'
import { canSeeInstance } from '../lib/processes.js'

const T = () => config.tenantId
const send = (res, p) => p.then((x) => res.json(x)).catch((e) => {
  if (!e.status) console.warn('[purchase]', e.stack || e.message)
  res.status(e.status || 500).json({ error: e.message, ...(e.policy ? { policy: e.policy } : {}) })
})
const bad = (m) => Object.assign(new Error(m), { status: 400 })

export function scenarioPurchaseRoutes(auth) {
  const r = express.Router()
  // briefs are made as steps come up for instances started or decided here (follow); with background jobs on
  // (or PRO_PURCHASE_WATCH=1) a sweep also catches the rest — a development server (PRO_BACKGROUND=0) leaves it off
  if (process.env.PRO_BACKGROUND !== '0' || process.env.PRO_PURCHASE_WATCH === '1') startSweep(forEachTenant)

  // a purchase request (the start form of 「구매 요청」), as the person signed in
  r.post('/purchase/requests', auth, (req, res) => send(res, (async () => {
    const b = req.body || {}
    const quantity = Math.round(Number(b.quantity))
    const unitPrice = Math.round(Number(b.unitPrice ?? b.unit_price ?? 0)) || (Number(b.amount) && quantity ? Math.round(Number(b.amount) / quantity) : 0)
    const amount = Math.round(Number(b.amount) || quantity * unitPrice)
    if (!String(b.item || '').trim()) throw bad(L('품목을 적어 주세요.', 'Name the item.'))
    if (!(quantity >= 1) || !(unitPrice > 0)) throw bad(L('수량과 단가를 확인해 주세요.', 'Check the quantity and the unit price.'))
    if (!String(b.supplier || '').trim()) throw bad(L('공급사를 적어 주세요.', 'Name the supplier.'))
    const values = {
      item: String(b.item).trim(), quantity, unit_price: unitPrice, amount, supplier: String(b.supplier).trim(),
      supplier_new: b.supplierNew === true || b.supplier_new === '예' ? '예' : '아니오', reason: String(b.reason || '').trim(),
    }
    const out = await startProcess({ me: req.user, defId: DEF_ID, values })
    follow(out.instId)
    return out
  })()))

  // my requests and where they are
  r.get('/purchase/requests', auth, (req, res) => send(res, (async () => {
    const rows = await q(`select i.proc_inst_id, i.proc_inst_name, i.status::text as status, i.current_activity_ids, i.start_date from bpm_proc_inst i
      where i.tenant_id=$1 and lower(i.proc_def_id)=$2 and exists (select 1 from todolist t where t.proc_inst_id=i.proc_inst_id and t.activity_id=$3 and t.user_id like '%'||$4||'%')
        and not coalesce(i.variables_data @> '{"seed":"purchase-demo"}'::jsonb, false)
      order by i.start_date desc nulls last limit 30`, [T(), DEF_ID, ACT.request, String(req.user.id)])
    const out = []
    for (const i of rows) {
      const f = await factsOf(i.proc_inst_id)
      const orders = (await ordersOf(i.proc_inst_id)).map(orderView)
      out.push({ instId: i.proc_inst_id, name: i.proc_inst_name, status: i.status, current: i.current_activity_ids, start: i.start_date,
        item: f.item, quantity: f.quantity, amount: f.amount, supplier: f.supplier, lead: f.lead, finance: f.finance, approved: f.approved, rejected: f.rejected, order: orders.at(-1) || null })
    }
    return { requests: out }
  })()))

  // the approval inbox: my open approvals in live critical-path order, each with its brief
  r.get('/purchase/inbox', auth, (req, res) => send(res, inbox(req.user)))
  // one brief (the work item card and the chat card read it); ?open=1 by the assignee marks the item opened
  r.get('/purchase/briefs/:todoId', auth, (req, res) => send(res, briefFor(req.user, req.params.todoId, { open: req.query.open === '1' })))
  r.post('/purchase/briefs/:todoId/decide', auth, (req, res) => send(res, decideOption(req.user, req.params.todoId, req.body || {})))
  // the order from the draft (purchase.order through the policies: allowed only once approved)
  r.post('/purchase/orders/:instId/place', auth, (req, res) => send(res, placeOrder(req.user, req.params.instId, req.body || {})))
  r.get('/purchase/orders/:instId', auth, (req, res) => send(res, (async () => {
    if (!(await canSeeInstance(req.params.instId, req.user))) throw Object.assign(new Error(L('이 요청을 볼 권한이 없어요.', "You can't see this request.")), { status: 403 })
    return { orders: (await ordersOf(req.params.instId)).map(orderView) }
  })()))
  // before / after (lib/scenarios/purchase/measure.js)
  r.get('/purchase/measure', auth, (req, res) => send(res, measure()))
  return r
}
