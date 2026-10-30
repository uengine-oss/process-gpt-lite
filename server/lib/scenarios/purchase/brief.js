// 승인 대기 줄이기 (pgpt-pro/docs/agentic-bpm/plan.md §5 P2) for the purchase process: when a person's step of
// 「구매 요청」 comes up, the work they would do first is done before they open it.
//  - 팀장 승인 / 재무 승인 → a decision brief: the request in a few lines, the options (승인 · 수량 조정 후 승인 ·
//    반려) each with what it changes — the extra approvals the policies would ask for (a PDP dry run of
//    purchase.approve), the remaining lead time if decided now (the live CPM, lib/improve/live.js) — and a
//    recommendation with its evidence (numbers from the history; only the wording comes from the model).
//  - before approval, the reversible preparation runs through the PEP (purchase.order with speculative:true →
//    'purchase.order_draft': an order draft and a stock check, demo data); a rejection cancels it (compensation).
//  - 발주 → a hand-over package: the request, the decisions and their reasons, the draft — the order is placed from
//    the draft (purchase.order with approved:true → 'purchase.order') without typing anything again.
// The brief lands in pro_decision_briefs and as a chat card (kind 'brief') for the person the step is for.
//
// When briefs are made: right after a request starts or a decision is made here, this module follows the instance
// for a few minutes (follow()) and makes the brief of the next step as soon as the engine opens it; the approval
// inbox and the work item card make a missing one on demand; and with background jobs on (or PRO_PURCHASE_WATCH=1)
// a sweep every few seconds also catches steps reached any other way and decisions made on the plain form.
import { q } from '../../supa.js'
import { config } from '../../../config.js'
import { L, asUser, locale } from '../../lang.js'
import { chatJson } from '../../llm.js'
import { decide as pdpDecide } from '../../policy/pdp.js'
import { guard, executorOf, canApprove } from '../../policy/pep.js'
import { addMessage, updateMessage, mainThread } from '../../store.js'
import { notifyUser } from '../../notify.js'
import { submitTodo } from '../../engine.js'
import { markOpened } from '../../improve/signal.js'
import { canSeeInstance } from '../../processes.js'
import { liveModel, remainingOf, predicted, liveQueue, span, approvalProcessesOf } from '../../improve/live.js'
import { percentile, numberOf } from '../../improve/analyze.js'
import { withTenant } from '../../tenant.js'
import { DEF_ID, DEF_NAME, ACT, FINANCE_THRESHOLD, formId, APPROVE, REJECT, ROLES } from './process.js'
import { liveOrder, orderView, adjustDraft } from './orders.js'

const T = () => config.tenantId
const err = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra })
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
const STEPS = [ACT.lead, ACT.finance, ACT.order]
const won = (n) => (n == null ? '-' : `₩${Math.round(n).toLocaleString(locale())}`)
const ref = (instId) => `purchase:${instId}`
const DONE = ['DONE', 'SUBMITTED']

// ---------- what the instance says so far ----------
const outOf = (t, act) => (t?.output && (t.output[formId(act)] || (Object.values(t.output).every((v) => v && typeof v === 'object') ? {} : t.output))) || {}
export async function factsOf(instId) {
  const rows = await q(`select t.id::text as id, t.activity_id, t.activity_name, t.status::text as status, t.output, t.user_id, t.updated_at,
      coalesce(u.username, t.username) as name, u.id::text as uid
    from todolist t left join users u on u.id::text = substring(t.user_id from '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}') and u.tenant_id = t.tenant_id
    where t.proc_inst_id=$1 order by t.start_date asc nulls first, t.updated_at asc`, [instId])
  const [inst] = await q('select proc_inst_name, status::text as status, current_activity_ids from bpm_proc_inst where proc_inst_id=$1', [instId])
  const by = {}
  for (const r of rows) by[r.activity_id] = r // the latest run of each step
  const req = outOf(by[ACT.request], ACT.request)
  const quantity = numberOf(req.quantity), unitPrice = numberOf(req.unit_price)
  const amount = numberOf(req.amount) ?? (quantity && unitPrice ? quantity * unitPrice : null)
  const step = (act, keys) => {
    const t = by[act]
    if (!t || !DONE.includes(t.status)) return null
    const o = outOf(t, act)
    return { by: t.name, byId: t.uid, at: t.updated_at, ...Object.fromEntries(Object.entries(keys).map(([k, f]) => [k, o[f]])) }
  }
  const lead = step(ACT.lead, { decision: 'lead_decision', quantity: 'approved_quantity', amount: 'approved_amount', comment: 'lead_comment' })
  if (lead) { lead.quantity = numberOf(lead.quantity); lead.amount = numberOf(lead.amount) }
  const finance = step(ACT.finance, { decision: 'finance_decision', comment: 'finance_comment' })
  const order = step(ACT.order, { poNo: 'po_number', quantity: 'order_quantity', amount: 'order_amount', deliveryBy: 'delivery_date', note: 'order_note' })
  const approvedQuantity = lead?.decision === APPROVE ? lead.quantity ?? quantity : quantity
  const approvedAmount = lead?.decision === APPROVE ? lead.amount ?? amount : amount
  const financeNeeded = approvedAmount > FINANCE_THRESHOLD
  return {
    instId, instName: inst?.proc_inst_name || DEF_NAME, status: inst?.status || null, current: inst?.current_activity_ids || [],
    item: req.item || '', quantity, unitPrice: unitPrice ?? (amount && quantity ? amount / quantity : null), amount,
    supplier: req.supplier || '', supplierNew: ['예', 'yes', 'true', true].includes(req.supplier_new), reason: req.reason || '',
    requester: { id: by[ACT.request]?.uid || null, name: by[ACT.request]?.name || '' },
    lead, finance, order, approvedQuantity, approvedAmount, financeNeeded,
    approved: lead?.decision === APPROVE && (!financeNeeded || finance?.decision === APPROVE),
    rejected: lead?.decision === REJECT || finance?.decision === REJECT,
    todos: by,
  }
}

// the branch ahead, from the request: over ₩10M an approval goes on to 재무 승인 (what the gateway and the
// purchase-finance policy both say). Unknown until the request is read: no prediction.
export function predictBranches(values, m) {
  if (values.lead_decision) return null // the engine has taken (or is taking) the branch
  const amount = numberOf(values.approved_amount) ?? numberOf(values.amount)
  if (amount == null) return null
  const pr = m.p.seq_lead_reject ?? 0
  return amount > FINANCE_THRESHOLD ? { seq_lead_finance: 1 - pr, seq_lead_order: 0, seq_lead_reject: pr } : { seq_lead_finance: 0, seq_lead_order: 1 - pr, seq_lead_reject: pr }
}
const branchAt = (step, choice, amount) => (step === ACT.lead
  ? choice === 'reject' ? { seq_lead_reject: 1, seq_lead_finance: 0, seq_lead_order: 0 }
    : amount > FINANCE_THRESHOLD ? { seq_lead_reject: 0, seq_lead_finance: 1, seq_lead_order: 0 } : { seq_lead_reject: 0, seq_lead_finance: 0, seq_lead_order: 1 }
  : step === ACT.finance ? (choice === 'reject' ? { seq_fin_reject: 1, seq_fin_order: 0 } : { seq_fin_reject: 0, seq_fin_order: 1 }) : {})

// ---------- the evidence: numbers from this process's history (deterministic) ----------
function evidenceOf(f, m, step) {
  const ex = m.a.executions.filter((x) => x.done && x.instId !== f.instId)
  const reqs = ex.filter((x) => x.activityId === ACT.request)
  const leadOf = new Map(ex.filter((x) => x.activityId === ACT.lead).map((x) => [x.instId, x.values]))
  const finOf = new Map(ex.filter((x) => x.activityId === ACT.finance).map((x) => [x.instId, x.values]))
  const orderOf = new Map(ex.filter((x) => x.activityId === ACT.order).map((x) => [x.instId, x.values]))
  const big = f.amount > FINANCE_THRESHOLD
  const out = []
  const band = reqs.filter((x) => (numberOf(x.values.amount) > FINANCE_THRESHOLD) === big && leadOf.has(x.instId))
  const ok = band.filter((x) => leadOf.get(x.instId).lead_decision === APPROVE)
  const adj = ok.filter((x) => numberOf(leadOf.get(x.instId).approved_quantity) < numberOf(x.values.quantity))
  if (band.length) out.push({ key: 'band', n: band.length, k: ok.length, adjusted: adj.length,
    text: L(`같은 금액대(1,000만 원 ${big ? '초과' : '이하'}) 요청 ${band.length}건 중 팀장 승인 ${ok.length}건(${Math.round(ok.length / band.length * 100)}%), 그중 수량 조정 ${adj.length}건`,
      `Of ${band.length} requests in the same band (${big ? 'over' : 'up to'} ₩10M) the team lead approved ${ok.length} (${Math.round(ok.length / band.length * 100)}%), ${adj.length} with the quantity cut`) })
  if (big || step === ACT.finance) {
    const fin = [...finOf.values()]
    const fok = fin.filter((v) => v.finance_decision === APPROVE).length
    if (fin.length) out.push({ key: 'finance', n: fin.length, k: fok, text: L(`재무 승인 ${fin.length}건 중 승인 ${fok}건(${Math.round(fok / fin.length * 100)}%)`, `Finance approved ${fok} of ${fin.length} (${Math.round(fok / fin.length * 100)}%)`) })
  }
  const sup = reqs.filter((x) => x.values.supplier === f.supplier && orderOf.has(x.instId)).length
  out.push({ key: 'supplier', n: sup, text: sup ? L(`${f.supplier}: 지난 3개월 발주 ${sup}건`, `${f.supplier}: ${sup} orders in the last three months`)
    : L(`${f.supplier}: 거래 기록 없음${f.supplierNew ? ' (신규 공급사)' : ''}`, `${f.supplier}: no orders on record${f.supplierNew ? ' (a new supplier)' : ''}`) })
  const same = reqs.filter((x) => x.values.item === f.item)
  const unit = percentile(same.map((x) => numberOf(x.values.unit_price)).filter((v) => v != null), 0.5)
  if (unit && f.unitPrice) {
    const d = Math.round((f.unitPrice / unit - 1) * 100)
    out.push({ key: 'price', median: unit, diff: d, text: L(`${f.item} 단가 중앙값 ${won(unit)} — 이번 ${won(f.unitPrice)}(${d > 0 ? '+' : ''}${d}%)`, `${f.item}: median unit price ${won(unit)} — this one ${won(f.unitPrice)} (${d > 0 ? '+' : ''}${d}%)`) })
  }
  const qty = percentile(same.map((x) => numberOf(x.values.quantity)).filter((v) => v != null), 0.5)
  if (qty && f.quantity) out.push({ key: 'quantity', median: Math.round(qty), text: L(`${f.item} 요청 수량 중앙값 ${Math.round(qty)}개 — 이번 ${f.quantity}개`, `${f.item}: median quantity ${Math.round(qty)} — this one ${f.quantity}`) })
  return { lines: out, medianQuantity: qty ? Math.round(qty) : null }
}

// the quantity a 수량 조정 suggests, and why: under ₩10M (no 재무 승인), else the usual quantity, else half first
function suggestQuantity(f, medianQuantity) {
  if (!f.quantity || !f.unitPrice || f.quantity <= 1) return null
  if (f.amount > FINANCE_THRESHOLD) {
    const n = Math.floor(FINANCE_THRESHOLD / f.unitPrice)
    if (n >= 1 && n < f.quantity) return { quantity: n, basis: L('1,000만 원 이하가 되는 최대 수량 — 재무 승인 없이 진행', 'the most that stays within ₩10M — no finance approval') }
  }
  if (medianQuantity && medianQuantity < f.quantity) return { quantity: medianQuantity, basis: L('지난 3개월 이 품목 요청 수량의 중앙값', 'the median quantity asked for this item in the last three months') }
  return { quantity: Math.max(1, Math.round(f.quantity / 2)), basis: L('절반만 먼저 (예시)', 'half first (an example)') }
}

// ---------- the options and their effects ----------
async function approvalsIf(f, amount, approverId, step) {
  const d = await pdpDecide({ userId: approverId, dryRun: true, ref: ref(f.instId),
    action: { kind: 'purchase.approve', subject: L(`구매 승인 — ${f.item} ${won(amount)}`, `Purchase approval — ${f.item} ${won(amount)}`), facts: { amount, supplier_new: f.supplierNew, category: f.item } } })
  const here = step === ACT.finance ? ROLES.finance : ROLES.lead
  return {
    decisionId: d.id, decision: d.decision,
    approvals: d.matched.filter((x) => x.decision === 'require_approval').map((x) => ({ policy: x.id, role: x.approver, title: x.title, explain: x.explain, current: x.approver === here,
      when: x.approver === ROLES.finance ? L('재무 승인 단계', 'the finance approval step') : x.approver === ROLES.buyer ? L('발주 단계에서 확인', 'checked at the order step') : '' })),
  }
}
function leadTimeIf(m, f, step, choice, amount, now) {
  const r = remainingOf(m, f.instId, { p: branchAt(step, choice, amount), now, decideNow: step })
  return r ? { remainingSec: r.remainingSec, expectedEnd: r.expectedEnd, next: r.pathNames } : null
}

async function decisionOptions(f, m, step, approverId, ev) {
  const now = Date.now()
  // as things usually go: decided after the usual wait at this step
  const pUsual = step === ACT.lead ? predictBranches({ amount: f.amount }, m) : null
  const usual = remainingOf(m, f.instId, { p: pUsual, now })
  const opt = async (id, label, { quantity, amount, choice, basis }) => {
    const lt = leadTimeIf(m, f, step, choice, amount, now)
    const pol = choice === 'reject' ? null : await approvalsIf(f, amount, approverId, step)
    return {
      id, label, quantity, amount, basis: basis || null,
      effects: {
        ...lt, approvals: pol?.approvals || [], extraApprovals: (pol?.approvals || []).filter((x) => !x.current).map((x) => x.role),
        savedSec: usual && lt ? Math.max(0, usual.remainingSec - lt.remainingSec) : null,
        compensation: choice === 'reject' ? L('미리 만든 발주서 초안을 취소해요', 'the order draft made in advance is cancelled') : null,
      },
      policy: pol && { decisionId: pol.decisionId, decision: pol.decision },
    }
  }
  const qty = step === ACT.finance ? f.approvedQuantity : f.quantity
  const amt = step === ACT.finance ? f.approvedAmount : f.amount
  const options = [await opt('approve', L('승인', 'Approve'), { quantity: qty, amount: amt, choice: 'approve' })]
  if (step === ACT.lead) {
    const s = suggestQuantity(f, ev.medianQuantity)
    if (s) options.push(await opt('adjust', L('수량 조정 후 승인', 'Approve a smaller quantity'), { quantity: s.quantity, amount: s.quantity * f.unitPrice, choice: 'approve', basis: s.basis }))
  }
  options.push(await opt('reject', L('반려', 'Reject'), { quantity: 0, amount: 0, choice: 'reject' }))
  return { options, usualSec: usual?.remainingSec ?? null }
}

// the wording of the recommendation comes from the model; the choice must be one of the options, and the
// evidence it may use is what was computed above. Without a model: a rule.
async function recommend(f, step, options, ev, live) {
  const ids = options.map((o) => o.id)
  const facts = {
    step: step === ACT.lead ? '팀장 승인' : '재무 승인',
    request: { item: f.item, quantity: f.quantity, unit_price: f.unitPrice, amount: f.amount, supplier: f.supplier, new_supplier: f.supplierNew, reason: f.reason },
    team_lead_decision: f.lead ? { decision: f.lead.decision, quantity: f.lead.quantity, amount: f.lead.amount, comment: f.lead.comment } : undefined,
    options: options.map((o) => ({ id: o.id, label: o.label, quantity: o.quantity, amount: o.amount, extra_approvals: o.effects.extraApprovals, remaining_lead_time: o.effects.remainingSec != null ? span(o.effects.remainingSec) : null, basis: o.basis })),
    evidence: ev.lines.map((x) => x.text),
    queue: live?.reason || null,
  }
  try {
    const r = await chatJson(
      `너는 구매 승인자를 돕는 비서다. 승인자가 열기 전에 결정 브리프의 추천을 쓴다. 주어진 선택지 id 중 하나만 고르고, 주어진 근거(숫자)만 인용해 두 문장 이내로 이유를 쓴다. 근거에 없는 사실(예산 잔액, 계약 조건, 사람 이름)을 지어내지 않는다. 결정은 승인자가 한다. JSON 하나로 답한다: {"option": "${ids.join('|')}", "text": "<이유 두 문장 이내, 해요체>"}`,
      JSON.stringify(facts), { temperature: 0.2, maxTokens: 300, timeoutMs: 30000 })
    if (ids.includes(r?.option) && String(r?.text || '').trim()) return { option: r.option, text: String(r.text).trim().slice(0, 400), by: 'model' }
  } catch (e) { console.warn('[purchase] recommendation', e.message) }
  const price = ev.lines.find((x) => x.key === 'price')
  const option = price?.diff >= 30 && ids.includes('adjust') ? 'adjust' : 'approve'
  return { option, by: 'rule', text: option === 'adjust' ? L('단가가 평소보다 높아 수량을 줄여 승인하는 쪽을 권해요.', 'The unit price is well above usual: approving a smaller quantity is suggested.')
    : L('같은 금액대 요청은 대부분 승인됐고, 미리 확인한 재고로 바로 발주할 수 있어요.', 'Most requests in this band were approved, and the stock checked in advance lets the order go out at once.') }
}

// ---------- speculative preparation (before approval) and its compensation ----------
function specOf(po) {
  if (!po) return []
  const s = po.stock || {}
  return [
    { id: 'po_draft', title: L('발주서 초안', 'Order draft'), status: po.status === 'cancelled' ? 'cancelled' : po.status === 'placed' ? 'used' : 'done',
      poId: po.id, poNo: po.po_no, quantity: po.quantity, amount: Number(po.amount), supplier: po.supplier, decisionId: po.draft_decision, at: po.created_at,
      text: L(`${po.po_no} · ${po.item} ${po.quantity}개 · ${won(Number(po.amount))} · ${po.supplier}`, `${po.po_no} · ${po.item} × ${po.quantity} · ${won(Number(po.amount))} · ${po.supplier}`),
      undo: L('반려되면 초안을 취소해요', 'cancelled if the request is rejected'), cancelReason: po.cancel_reason || null, cancelledAt: po.cancelled_at || null },
    { id: 'stock_check', title: L('공급사 재고 확인', 'Supplier stock check'), status: 'done', demo: true, result: s,
      text: L(`재고 ${s.onHand}개 · ${s.enough ? '수량 충분' : '수량 부족'} · 납기 ${s.leadDays}영업일(${s.deliveryBy}까지)`, `${s.onHand} in stock · ${s.enough ? 'enough' : 'not enough'} · delivery in ${s.leadDays} business days (by ${s.deliveryBy})`),
      note: L('데모 데이터 — 실제 공급사 시스템과 연결되지 않아요', 'Demo data — not connected to a real supplier system') },
  ]
}

// the order draft and the stock check, through the PEP as a speculative purchase.order (allowed before approval)
async function prepare(f) {
  const have = await liveOrder(f.instId)
  if (have) return { spec: specOf(have) }
  const g = await guard({
    me: { id: f.requester.id, name: f.requester.name }, kind: 'purchase.order', ref: ref(f.instId),
    subject: L(`발주서 초안 — ${f.item} ${f.quantity}개 · ${f.supplier}`, `Order draft — ${f.item} × ${f.quantity} · ${f.supplier}`),
    facts: { amount: f.amount, approved: false, speculative: true }, executor: 'purchase.order_draft',
    payload: { instId: f.instId, item: f.item, quantity: f.quantity, unitPrice: f.unitPrice, amount: f.amount, supplier: f.supplier, supplierNew: f.supplierNew },
  })
  if (g.status !== 'executed') return { spec: [{ id: 'po_draft', title: L('발주서 초안', 'Order draft'), status: 'blocked', decision: g.decision, decisionId: g.decisionId, text: g.error || g.matched.map((x) => x.title?.[0]).join(' · ') }] }
  return { spec: specOf(await liveOrder(f.instId)) }
}

async function refreshCards(instId) {
  const po = await liveOrder(instId) || (await q(`select * from pro_purchase_orders where tenant_id=$1 and proc_inst_id=$2 order by created_at desc limit 1`, [T(), instId]))[0]
  const spec = specOf(po)
  for (const b of await q(`select * from pro_decision_briefs where tenant_id=$1 and proc_inst_id=$2`, [T(), instId])) {
    if (!spec.length) continue
    // a hand-over shows the order as it is now (draft → placed / cancelled)
    const brief = b.brief?.kind === 'handover' && po ? { ...b.brief, draft: orderView(po) } : b.brief
    await q('update pro_decision_briefs set speculative=$2, brief=$3 where id=$1', [b.id, JSON.stringify(spec), JSON.stringify(brief)])
    if (b.brief?.messageId && b.brief?.approverId) await updateMessage(b.brief.approverId, b.brief.messageId, { brief: viewOf({ ...b, brief, speculative: spec }) }).catch(() => {})
  }
}

/** compensation: the speculative draft of an instance is cancelled (a rejection, or the instance ended without an order) */
export async function compensate(instId, reason, by = null) {
  const po = await liveOrder(instId)
  if (!po || po.status !== 'draft') return null
  await executorOf('purchase.order_draft').undo({ reason }, { poId: po.id }, { userId: by, tenant: T(), decisionId: po.draft_decision })
  // the ledger: the speculative action that made the draft was taken back
  if (po.draft_decision) await q(`update pro_policy_decisions set status='undone', result = coalesce(result, '{}'::jsonb) || $2::jsonb where id=$1`, [po.draft_decision, JSON.stringify({ compensated: true, reason, at: new Date().toISOString() })])
  await refreshCards(instId)
  return { poId: po.id, poNo: po.po_no, status: 'cancelled', reason }
}

// ---------- building a brief ----------
const viewOf = (row) => row && ({ id: row.id, todoId: row.todo_id, instId: row.proc_inst_id, ...row.brief, speculative: row.speculative, decidedOption: row.decided_option, decidedAt: row.decided_at })

async function buildDecision(t, f, m, approverId) {
  const step = t.activity_id
  const ev = evidenceOf(f, m, step)
  const [live] = (await liveQueue([DEF_ID], { predict: { [DEF_ID]: predictBranches } })).filter((x) => x.todoId === String(t.id))
  const { spec } = await prepare(f)
  const { options, usualSec } = await decisionOptions(f, m, step, approverId, ev)
  const rec = await recommend(f, step, options, ev, live)
  const prep = predicted(m, [{ type: 'predraft', step: ACT.order, saving: 0.5 }])
  return {
    brief: {
      state: 'ready', kind: 'decision', step, stepName: t.activity_name, instName: f.instName, defId: DEF_ID, approverId,
      summary: { item: f.item, quantity: f.quantity, unitPrice: f.unitPrice, amount: f.amount, supplier: f.supplier, supplierNew: f.supplierNew, reason: f.reason, requester: f.requester.name },
      previous: f.lead ? [{ step: L('팀장 승인', 'Team lead approval'), by: f.lead.by, decision: f.lead.decision, quantity: f.lead.quantity, amount: f.lead.amount, comment: f.lead.comment, at: f.lead.at }] : [],
      options, usualSec, recommendation: { ...rec, evidence: ev.lines.map((x) => x.text) },
      live: live ? { reason: live.reason, critical: live.critical, slackSec: live.slackSec, remainingSec: live.remainingSec, waitedSec: live.waitedSec } : null,
      prepEffect: { kind: 'predraft', step: ACT.order, ...prep, note: L('what-if 「사전 초안」(발주 작업 50% 절감)의 예측', 'what-if "pre-draft" (order work −50%) prediction') },
      prefill: step === ACT.lead ? { lead_decision: APPROVE, approved_quantity: f.quantity, approved_amount: f.amount } : { finance_decision: APPROVE },
    },
    spec,
  }
}

async function buildHandover(t, f, m, approverId) {
  const po = await liveOrder(f.instId) || (await prepare(f), await liveOrder(f.instId))
  const d = orderView(po)
  const prior = await q(`select brief, decided_option from pro_decision_briefs where tenant_id=$1 and proc_inst_id=$2 and brief->>'kind'='decision' order by created_at`, [T(), f.instId])
  const reasons = prior.map((b) => b.brief?.recommendation?.text).filter(Boolean)
  const checks = []
  const pol = await approvalsIf(f, f.approvedAmount, approverId, ACT.order)
  for (const x of pol.approvals.filter((y) => y.role === ROLES.buyer)) checks.push({ policy: x.policy, text: L(`${x.title?.[0]} — ${x.explain?.[0]}`, `${x.title?.[1]} — ${x.explain?.[1]}`) })
  if (d?.stock && !d.stock.enough) checks.push({ key: 'stock', text: L(`재고 부족(${d.stock.onHand}개) — 납기 ${d.stock.leadDays}영업일`, `Not enough stock (${d.stock.onHand}) — ${d.stock.leadDays} business days`) })
  const [live] = (await liveQueue([DEF_ID], { predict: { [DEF_ID]: predictBranches } })).filter((x) => x.todoId === String(t.id))
  const lt = remainingOf(m, f.instId, { now: Date.now(), decideNow: ACT.order })
  const note = L(`${f.supplier} — 초안 ${d?.poNo || ''}대로 발주${d?.stock ? ` · 재고 확인(데모) 납기 ${d.stock.deliveryBy}` : ''}`, `${f.supplier} — ordered as drafted (${d?.poNo || ''})${d?.stock ? ` · stock checked (demo), delivery by ${d.stock.deliveryBy}` : ''}`)
  return {
    brief: {
      state: 'ready', kind: 'handover', step: ACT.order, stepName: t.activity_name, instName: f.instName, defId: DEF_ID, approverId,
      summary: { item: f.item, quantity: f.approvedQuantity, requestedQuantity: f.quantity, unitPrice: f.unitPrice, amount: f.approvedAmount, supplier: f.supplier, supplierNew: f.supplierNew, reason: f.reason, requester: f.requester.name },
      decisions: [f.lead && { step: L('팀장 승인', 'Team lead approval'), by: f.lead.by, decision: f.lead.decision, quantity: f.lead.quantity, amount: f.lead.amount, comment: f.lead.comment, at: f.lead.at },
        f.finance && { step: L('재무 승인', 'Finance approval'), by: f.finance.by, decision: f.finance.decision, comment: f.finance.comment, at: f.finance.at }].filter(Boolean),
      reasons, checks, draft: d,
      options: [{ id: 'place', label: L('초안대로 발주', 'Place the order as drafted'), quantity: f.approvedQuantity, amount: f.approvedAmount, effects: { remainingSec: lt?.remainingSec ?? null, approvals: [] } }],
      live: live ? { reason: live.reason, critical: live.critical, slackSec: live.slackSec, remainingSec: live.remainingSec, waitedSec: live.waitedSec } : null,
      prefill: { po_number: d?.poNo || '', order_quantity: f.approvedQuantity, order_amount: f.approvedAmount, delivery_date: d?.stock?.deliveryBy || '', order_note: note },
    },
    spec: specOf(po),
  }
}

async function postCard(row) {
  const b = row.brief
  const uid = b.approverId
  if (!uid) return
  const th = await mainThread(uid)
  const msg = await addMessage(uid, th.id, 'agent', 'brief', { todoId: row.todo_id, instId: row.proc_inst_id, briefId: row.id, brief: viewOf(row) })
  await q(`update pro_decision_briefs set brief = brief || $2::jsonb where id=$1`, [row.id, JSON.stringify({ messageId: msg.id })])
  await notifyUser(uid, {
    type: 'brief', url: '/settings/approvals',
    title: b.kind === 'handover' ? L(`인계 꾸러미 — ${b.stepName} · ${b.summary.item}`, `Hand-over — ${b.stepName} · ${b.summary.item}`) : L(`결정 브리프 — ${b.stepName} · ${b.summary.item}`, `Decision brief — ${b.stepName} · ${b.summary.item}`),
    text: b.kind === 'handover' ? L('승인 내용과 발주서 초안이 준비돼 있어요. 한 번에 발주할 수 있어요.', 'The decisions and the order draft are ready: one click places the order.')
      : L(`선택지와 영향, 추천을 미리 정리했어요${b.live?.critical ? ' · 주공정 위' : ''}.`, `Options, their effects and a recommendation are ready${b.live?.critical ? ' · on the critical path' : ''}.`),
  }).catch(() => {})
}

/** the brief of a work item of this process, made now if it is missing (one server makes it: the row is claimed first) */
export async function ensureBrief(todoId) {
  for (let i = 0; i < 40; i++) {
    const [have] = await q(`select * from pro_decision_briefs where tenant_id=$1 and todo_id=$2`, [T(), String(todoId)])
    if (have?.brief?.state === 'ready') return have
    if (have && Date.now() - new Date(have.created_at).getTime() < 90000) { await new Promise((r) => setTimeout(r, 1000)); continue }
    if (have) await q('delete from pro_decision_briefs where id=$1 and brief->>$2 = $3', [have.id, 'state', 'building'])
    const [t] = await q('select * from todolist where id::text=$1', [String(todoId)])
    if (!t || String(t.proc_def_id).toLowerCase() !== DEF_ID || !STEPS.includes(t.activity_id) || DONE.includes(t.status)) return have || null
    const [claim] = await q(`insert into pro_decision_briefs(tenant_id, todo_id, proc_inst_id, brief) values ($1,$2,$3,'{"state":"building"}') on conflict (tenant_id, todo_id) do nothing returning id`, [T(), String(todoId), t.proc_inst_id])
    if (!claim) continue
    try {
      const approverId = String(t.user_id || '').match(UUID)?.[0] || null
      const built = await asUser(approverId, async () => {
        const f = await factsOf(t.proc_inst_id)
        const m = await liveModel(DEF_ID, { fresh: true })
        return t.activity_id === ACT.order ? buildHandover(t, f, m, approverId) : buildDecision(t, f, m, approverId)
      })
      const [row] = await q(`update pro_decision_briefs set brief=$2, speculative=$3 where id=$1 returning *`, [claim.id, JSON.stringify(built.brief), JSON.stringify(built.spec)])
      await asUser(approverId, () => postCard(row))
      return (await q('select * from pro_decision_briefs where id=$1', [claim.id]))[0]
    } catch (e) {
      await q('delete from pro_decision_briefs where id=$1', [claim.id])
      throw e
    }
  }
  throw err(503, L('결정 브리프를 만드는 중이에요. 잠시 뒤 다시 열어 주세요.', 'The brief is still being made. Open it again in a moment.'))
}

const isMine = (t, me) => String(t.user_id || '').includes(String(me.id)) || (me.email && String(t.user_id || '').includes(me.email))

/** a brief for the API: {brief} or {brief: null} (not a work item of this process) */
export async function briefFor(me, todoId, { open = false } = {}) {
  const [t] = await q('select * from todolist where id::text=$1 and tenant_id=$2', [String(todoId), T()])
  if (!t || String(t.proc_def_id).toLowerCase() !== DEF_ID || !STEPS.includes(t.activity_id)) return { brief: null }
  const mine = isMine(t, me)
  if (!mine && !(await canSeeInstance(t.proc_inst_id, me))) throw err(403, L('이 요청을 볼 권한이 없어요.', "You can't see this request."))
  const [row] = await q(`select * from pro_decision_briefs where tenant_id=$1 and todo_id=$2`, [T(), String(todoId)])
  const ready = row?.brief?.state === 'ready' ? row : DONE.includes(t.status) ? row : await ensureBrief(todoId)
  // the assignee looking at the brief is when they started on the item (lib/improve/signal.js)
  if (open && mine) await markOpened(t, me).catch(() => {})
  return { brief: viewOf(ready) || null, mine, status: t.status }
}

// ---------- deciding from the brief ----------
async function openTodo(me, todoId) {
  const [t] = await q('select * from todolist where id::text=$1 and tenant_id=$2', [String(todoId), T()])
  if (!t || String(t.proc_def_id).toLowerCase() !== DEF_ID) throw err(404, L('작업 항목을 찾지 못했어요.', "I couldn't find that work item."))
  if (DONE.includes(t.status)) throw err(409, L('이미 처리된 항목이에요.', 'Already done.'))
  if (!isMine(t, me)) throw err(403, L('이 단계를 맡은 사람만 결정할 수 있어요.', 'Only the person this step is for can decide it.'))
  return t
}

/** choose an option of a decision brief: the work item is submitted with the matching values */
export async function decideOption(me, todoId, { option, quantity, comment } = {}) {
  const t = await openTodo(me, todoId)
  if (![ACT.lead, ACT.finance].includes(t.activity_id)) throw err(400, L('승인 단계가 아니에요.', 'Not an approval step.'))
  const row = await ensureBrief(todoId)
  const o = (row.brief.options || []).find((x) => x.id === option)
  if (!o) throw err(400, L('그런 선택지는 없어요.', 'No such option.'))
  const f = await factsOf(t.proc_inst_id)
  const reject = option === 'reject'
  const qty = option === 'adjust' ? Math.max(1, Math.min(Number(quantity) || o.quantity, f.quantity || Infinity)) : o.quantity
  const amount = reject ? 0 : t.activity_id === ACT.finance ? f.approvedAmount : Math.round(qty * f.unitPrice)
  const asRecommended = row.brief.recommendation?.option === option
  const say = String(comment || '').trim() || (reject ? L(asRecommended ? '결정 브리프의 추천대로 반려' : '반려', asRecommended ? 'Rejected as the brief recommended' : 'Rejected')
    : option === 'adjust' ? L(`수량 ${qty}개로 조정해 승인`, `Approved with the quantity cut to ${qty}`) : L(asRecommended ? '결정 브리프의 추천대로 승인' : '승인', asRecommended ? 'Approved as the brief recommended' : 'Approved'))
  const values = t.activity_id === ACT.lead
    ? { lead_decision: reject ? REJECT : APPROVE, approved_quantity: reject ? 0 : qty, approved_amount: amount, lead_comment: say }
    : { finance_decision: reject ? REJECT : APPROVE, finance_comment: say }
  await markOpened(t, me).catch(() => {})
  await submitTodo({ me, todoId: t.id, values })
  const decision = { option, label: o.label, quantity: reject ? 0 : qty, amount, comment: say, by: me.name, byId: me.id, at: new Date().toISOString(), via: 'brief' }
  const [saved] = await q(`update pro_decision_briefs set decided_option=$2, decided_at=now(), brief = brief || $3::jsonb where id=$1 returning *`, [row.id, option, JSON.stringify({ decision })])
  let compensation = null
  if (reject) compensation = await compensate(t.proc_inst_id, L(`${t.activity_name}에서 반려`, `rejected at ${t.activity_name}`), me.id)
  else if (option === 'adjust') { await adjustDraft(t.proc_inst_id, { quantity: qty, amount, by: me.id }); await refreshCards(t.proc_inst_id) }
  const fresh = (await q('select * from pro_decision_briefs where id=$1', [saved.id]))[0]
  if (fresh.brief?.messageId) await updateMessage(me.id, fresh.brief.messageId, { brief: viewOf(fresh) }).catch(() => {})
  follow(t.proc_inst_id)
  return { ok: true, decision, compensation, brief: viewOf(fresh) }
}

/** the order: allowed by the policies only once approved (purchase-order-before-approval); made from the draft */
export async function placeOrder(me, instId, { note } = {}) {
  const f = await factsOf(instId)
  if (!f.item) throw err(404, L('구매 요청을 찾지 못했어요.', "I couldn't find that purchase request."))
  const t = f.todos[ACT.order]
  const open = t && !DONE.includes(t.status) && f.current.includes(ACT.order) ? t : null
  // the order step's assignee; with no open order step (before approval, or after it closed) the 구매 담당
  // role holder or an administrator — the policies then decide whether an order may go out at all
  const [row] = open ? await q('select * from todolist where id::text=$1', [open.id]) : []
  if (open ? !isMine(row, me) : !(await canApprove(me, ROLES.buyer))) throw err(403, L('발주는 구매 담당이 해요.', 'Purchasing places the order.'))
  const g = await guard({
    me, kind: 'purchase.order', ref: ref(instId),
    subject: L(`발주 — ${f.item} ${f.approvedQuantity}개 · ${won(f.approvedAmount)} · ${f.supplier}`, `Order — ${f.item} × ${f.approvedQuantity} · ${won(f.approvedAmount)} · ${f.supplier}`),
    facts: { amount: f.approvedAmount, approved: f.approved, speculative: false }, executor: 'purchase.order',
    payload: { instId, item: f.item, quantity: f.approvedQuantity, unitPrice: f.unitPrice, amount: f.approvedAmount, supplier: f.supplier, supplierNew: f.supplierNew, note: note || '' },
  })
  const policy = { decisionId: g.decisionId, decision: g.decision, status: g.status, matched: g.matched.map((x) => ({ id: x.id, decision: x.decision, title: x.title, explain: x.explain })) }
  if (g.status === 'blocked') throw err(409, L('정책이 막았어요: 승인 전에는 발주할 수 없어요.', 'Blocked by policy: no order before approval.'), { policy })
  if (g.status !== 'executed') return { policy, placed: false }
  let submitted = false
  if (open) {
    const [row] = await q(`select * from pro_decision_briefs where tenant_id=$1 and todo_id=$2`, [T(), open.id])
    const po = orderView(await liveOrder(instId))
    const values = { ...(row?.brief?.prefill || {}), po_number: po?.poNo || g.result?.poNo, order_quantity: f.approvedQuantity, order_amount: f.approvedAmount, ...(note ? { order_note: note } : {}) }
    await markOpened(open, me).catch(() => {})
    await submitTodo({ me, todoId: open.id, values })
    submitted = true
    if (row) {
      const decision = { option: 'place', label: L('초안대로 발주', 'Placed as drafted'), poNo: po?.poNo, by: me.name, byId: me.id, at: new Date().toISOString(), via: 'brief', fromDraft: !!g.result?.fromDraft }
      await q(`update pro_decision_briefs set decided_option='place', decided_at=now(), brief = brief || $2::jsonb where id=$1`, [row.id, JSON.stringify({ decision })])
    }
  }
  await refreshCards(instId)
  return { policy, placed: true, order: orderView(await liveOrder(instId)), fromDraft: !!g.result?.fromDraft, submitted }
}

// ---------- decisions made elsewhere (the plain form), instances that ended ----------
function optionFromOutput(act, o, f) {
  if (act === ACT.order) return 'place'
  const dec = act === ACT.lead ? o.lead_decision : o.finance_decision
  if (dec === REJECT) return 'reject'
  if (act === ACT.lead && numberOf(o.approved_quantity) != null && f.quantity && numberOf(o.approved_quantity) < f.quantity) return 'adjust'
  return 'approve'
}
export async function settle() {
  const open = await q(`select b.*, t.activity_id, t.status::text as tstatus, t.output, t.user_id as tuser from pro_decision_briefs b join todolist t on t.id::text=b.todo_id
    where b.tenant_id=$1 and b.decided_option is null and b.brief->>'state'='ready' and t.status::text in ('DONE','SUBMITTED')`, [T()])
  for (const b of open) {
    const f = await factsOf(b.proc_inst_id)
    const option = optionFromOutput(b.activity_id, outOf(b, b.activity_id), f)
    const decision = { option, via: 'form', at: new Date().toISOString() }
    await q(`update pro_decision_briefs set decided_option=$2, decided_at=now(), brief = brief || $3::jsonb where id=$1`, [b.id, option, JSON.stringify({ decision })])
    const uid = String(b.tuser || '').match(UUID)?.[0]
    if (option === 'reject') await compensate(b.proc_inst_id, L('양식에서 반려', 'rejected on the form'), uid)
    // the order step submitted on the plain form: the order is still placed through the policies, from the draft
    if (option === 'place' && (await liveOrder(b.proc_inst_id))?.status === 'draft') {
      const [u] = uid ? await q('select id, email, username as name from users where id::text=$1 and tenant_id=$2', [uid, T()]) : []
      if (u) await guard({ me: u, kind: 'purchase.order', ref: ref(b.proc_inst_id), subject: L(`발주 — ${f.item}`, `Order — ${f.item}`), facts: { amount: f.approvedAmount, approved: f.approved, speculative: false },
        executor: 'purchase.order', payload: { instId: b.proc_inst_id, item: f.item, quantity: f.approvedQuantity, unitPrice: f.unitPrice, amount: f.approvedAmount, supplier: f.supplier, supplierNew: f.supplierNew } })
    }
    await refreshCards(b.proc_inst_id)
  }
  // ended without an order (rejected at 재무 승인 on the form, or stopped): the draft is cancelled
  const ended = await q(`select p.proc_inst_id from pro_purchase_orders p join bpm_proc_inst i on i.proc_inst_id=p.proc_inst_id
    where p.tenant_id=$1 and p.status='draft' and i.status::text='COMPLETED'`, [T()])
  for (const x of ended) await compensate(x.proc_inst_id, L('발주 없이 끝남', 'ended without an order'))
}

async function openWithoutBrief(instId = null) {
  return q(`select t.id::text as id from todolist t join bpm_proc_inst i on i.proc_inst_id=t.proc_inst_id
    where t.tenant_id=$1 and lower(t.proc_def_id)=$2 and ($4::text is null or t.proc_inst_id=$4) and i.status::text <> 'COMPLETED' and coalesce(t.agent_orch,'')=''
      and t.activity_id = any($3) and (t.status::text='IN_PROGRESS' or (t.status::text in ('TODO','NEW') and t.activity_id = any(i.current_activity_ids)))
      and not exists (select 1 from pro_decision_briefs b where b.tenant_id=t.tenant_id and b.todo_id=t.id::text)`, [T(), DEF_ID, STEPS, instId])
}

// follow one instance for a while: the next step's brief as soon as the engine opens it
const following = new Map()
export function follow(instId, ms = 4 * 60000) {
  if (following.has(instId)) return
  const tenant = T()
  const end = Date.now() + ms
  let busy = false
  const tick = () => withTenant(tenant, async () => {
    if (busy) return
    busy = true
    try {
      for (const r of await openWithoutBrief(instId)) await ensureBrief(r.id)
      const [i] = await q('select status::text as status from bpm_proc_inst where proc_inst_id=$1', [instId])
      if (i?.status === 'COMPLETED') { await settle(); stop() } else if (Date.now() > end) stop()
    } catch (e) { console.warn('[purchase] follow', e.message) } finally { busy = false }
  })
  const stop = () => { clearInterval(following.get(instId)); following.delete(instId) }
  following.set(instId, setInterval(tick, 2500))
  tick()
}

// the sweep (background jobs on, or PRO_PURCHASE_WATCH=1): steps reached any other way, decisions on the plain form
let sweeping = false
export function startSweep(forEachTenant) {
  const run = async () => {
    if (sweeping) return
    sweeping = true
    try {
      await forEachTenant(async () => {
        const [d] = await q('select 1 from proc_def where id=$1 and tenant_id=$2', [DEF_ID, T()])
        if (!d) return
        for (const r of await openWithoutBrief()) await ensureBrief(r.id).catch((e) => console.warn('[purchase] brief', e.message))
        await settle()
      }, 'purchase')
    } finally { sweeping = false }
  }
  setTimeout(run, 8000)
  setInterval(run, 5000).unref?.()
}

/** the approval inbox: my open approval items (and hand-overs) of the approval processes, least slack first */
export async function inbox(me) {
  const { defs, acts } = await approvalProcessesOf(me, [DEF_ID])
  const all = await liveQueue(defs, { predict: { [DEF_ID]: predictBranches } })
  const mine = all.filter((x) => (String(x.userId || '').includes(String(me.id)) || (me.email && String(x.userId || '').includes(me.email)))
    && (x.defId.toLowerCase() === DEF_ID ? STEPS.includes(x.activityId) : acts.has(`${x.defId.toLowerCase()}|${x.activityId}`)))
  await Promise.all(mine.filter((x) => x.defId.toLowerCase() === DEF_ID).map(async (x) => {
    try { x.brief = viewOf(await ensureBrief(x.todoId)) } catch (e) { x.briefError = e.message }
  }))
  mine.forEach((x, i) => { x.rank = i + 1 })
  return { items: mine, queued: all.length, generatedAt: new Date().toISOString() }
}
