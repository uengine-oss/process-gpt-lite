// The purchase scenario's order book (sql/026_scenario_purchase.sql) and the two executors the PEP runs
// (lib/policy/pep.js registerExecutor): 'purchase.order_draft' — the reversible preparation run before approval
// (an order draft and a stock check at the supplier), undone by cancelling the draft; 'purchase.order' — the order
// itself after approval, made from the draft so nobody types the request again. A demo order book: nothing is sent
// to a supplier, and the stock check is made-up data (labelled so wherever it is shown).
import crypto from 'node:crypto'
import { q } from '../../supa.js'
import { config } from '../../../config.js'
import { registerExecutor } from '../../policy/pep.js'
import { L } from '../../lang.js'

const T = () => config.tenantId

// business days after a date (weekends skipped), as YYYY-MM-DD
function addWorkdays(from, n) {
  const d = new Date(from)
  for (let k = 0; k < n;) { d.setUTCDate(d.getUTCDate() + 1); if (d.getUTCDay() % 6) k++ }
  return d.toISOString().slice(0, 10)
}

/** a supplier stock check — demo data: the same supplier and item always give the same answer */
export function stockCheck({ supplier, item, quantity, supplierNew }, now = Date.now()) {
  const h = crypto.createHash('sha1').update(`${supplier}|${item}`).digest()
  const onHand = 3 + (h[0] % 38)
  const enough = onHand >= quantity
  const leadDays = (supplierNew ? 5 : 2) + (h[1] % 4) + (enough ? 0 : 7)
  return { demo: true, onHand, enough, leadDays, deliveryBy: addWorkdays(now, leadDays), checkedAt: new Date(now).toISOString() }
}

const note = (what, by, text = '') => ({ at: new Date().toISOString(), what, by: by || null, note: text })
async function nextNo() {
  const [r] = await q(`select nextval('pro_purchase_order_no')::int n`)
  return `PO-2026-${String(r.n).padStart(4, '0')}`
}

export async function liveOrder(instId) {
  const [po] = await q(`select * from pro_purchase_orders where tenant_id=$1 and proc_inst_id=$2 and status <> 'cancelled' order by created_at desc limit 1`, [T(), instId])
  return po || null
}
export async function ordersOf(instId) {
  return q(`select * from pro_purchase_orders where tenant_id=$1 and proc_inst_id=$2 order by created_at`, [T(), instId])
}
export const orderView = (po) => po && ({
  id: po.id, poNo: po.po_no, status: po.status, item: po.item, quantity: po.quantity, unitPrice: Number(po.unit_price), amount: Number(po.amount),
  supplier: po.supplier, supplierNew: po.supplier_new, stock: po.stock, history: po.history, createdAt: po.created_at,
  placedAt: po.placed_at, cancelledAt: po.cancelled_at, cancelReason: po.cancel_reason, draftDecision: po.draft_decision, orderDecision: po.order_decision,
})

// the quantity the approver settled on: the draft follows (a note in its history)
export async function adjustDraft(instId, { quantity, amount, by }) {
  const po = await liveOrder(instId)
  if (!po || po.status !== 'draft' || (po.quantity === quantity && Number(po.amount) === amount)) return po
  const [x] = await q(`update pro_purchase_orders set quantity=$2, amount=$3, history = history || $4::jsonb where id=$1 returning *`,
    [po.id, quantity, amount, JSON.stringify([note('adjusted', by, L(`수량 ${po.quantity} → ${quantity}`, `quantity ${po.quantity} → ${quantity}`))])])
  return x
}

registerExecutor('purchase.order_draft', {
  // payload: {instId, item, quantity, unitPrice, amount, supplier, supplierNew}
  async run(p, ctx) {
    const have = await liveOrder(p.instId)
    if (have) return { poId: have.id, poNo: have.po_no, stock: have.stock, reused: true }
    const stock = stockCheck(p)
    const [po] = await q(`insert into pro_purchase_orders(tenant_id, proc_inst_id, po_no, status, item, quantity, unit_price, amount, supplier, supplier_new, stock, draft_decision, history)
      values ($1,$2,$3,'draft',$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`,
    [T(), p.instId, await nextNo(), p.item, p.quantity, p.unitPrice, p.amount, p.supplier, !!p.supplierNew, stock, ctx.decisionId, JSON.stringify([note('drafted', ctx.userId, L('승인 전 선행 실행', 'prepared before approval'))])])
    return { poId: po.id, poNo: po.po_no, stock }
  },
  // compensation: the draft is cancelled (nothing reached a supplier, so nothing else to take back)
  async undo(p, result, ctx) {
    await q(`update pro_purchase_orders set status='cancelled', cancelled_at=now(), cancel_reason=$2, history = history || $3::jsonb where id=$1 and status='draft'`,
      [result?.poId, p.reason || null, JSON.stringify([note('cancelled', ctx?.userId, p.reason || '')])])
  },
})

registerExecutor('purchase.order', {
  // payload: {instId, quantity, amount, deliveryBy?, note?} — the live draft becomes the order; without one a new order is made
  async run(p, ctx) {
    const po = await liveOrder(p.instId)
    if (po?.status === 'placed') return { poId: po.id, poNo: po.po_no, fromDraft: true, already: true, deliveryBy: po.stock?.deliveryBy || null }
    if (po) {
      const [x] = await q(`update pro_purchase_orders set status='placed', quantity=$2, amount=$3, placed_at=now(), placed_by=$4, order_decision=$5, history = history || $6::jsonb where id=$1 returning *`,
        [po.id, p.quantity, p.amount, ctx.userId || null, ctx.decisionId, JSON.stringify([note('placed', ctx.userId, p.note || '')])])
      return { poId: x.id, poNo: x.po_no, fromDraft: true, deliveryBy: x.stock?.deliveryBy || null }
    }
    const stock = stockCheck(p)
    const [x] = await q(`insert into pro_purchase_orders(tenant_id, proc_inst_id, po_no, status, item, quantity, unit_price, amount, supplier, supplier_new, stock, order_decision, placed_at, placed_by, history)
      values ($1,$2,$3,'placed',$4,$5,$6,$7,$8,$9,$10,$11,now(),$12,$13) returning *`,
    [T(), p.instId, await nextNo(), p.item, p.quantity, p.unitPrice, p.amount, p.supplier, !!p.supplierNew, stock, ctx.decisionId, ctx.userId || null, JSON.stringify([note('placed', ctx.userId, p.note || '')])])
    return { poId: x.id, poNo: x.po_no, fromDraft: false, deliveryBy: stock.deliveryBy }
  },
})
