// HTTP routes for the billing back office (빌링 백오피스): the operators of this install (PRO_BILLING_OPERATORS,
// e-mail addresses) see every company's plan, usage and bill, switch plans, record purchased credits once the
// money is in, issue the month's invoices and mark them paid. No payment provider yet: invoices are issued by
// hand and paid by bank transfer (issued → paid, or void).
import express from 'express'
import { q } from '../lib/supa.js'
import { L } from '../lib/lang.js'
import { withTenant, tenants } from '../lib/tenant.js'
import * as K from '../lib/llmKeys.js'
import { catalog, catalogName, usdPerCredit } from '../lib/plans/catalog.js'
import { subscriptionOf, planOf, applyPlan } from '../lib/plans/apply.js'
import { companyOf, catalogView } from '../lib/plans/usage.js'
import { monthOf } from '../lib/llmUsage.js'
import { recordChange } from '../lib/plans/history.js'
import * as meter from '../lib/plans/meter.js'

const send = (res, p) => p.then((x) => res.json(x)).catch((e) => {
  if (!e.status) console.warn('[backoffice]', e.stack || e.message)
  res.status(e.status || 500).json({ error: e.message })
})
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status })
const operators = () => String(process.env.PRO_BILLING_OPERATORS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
export const isOperator = (me) => !!me?.email && operators().includes(String(me.email).toLowerCase())
function mustOperate(me) {
  if (!K.enabled()) throw bad(L('사용량 한도가 꺼져 있어요 (PRO_LLM_KEYS=litellm).', 'Usage limits are off (PRO_LLM_KEYS=litellm).'), 404)
  if (!isOperator(me)) throw bad(L('운영자만 볼 수 있어요.', 'Operators only.'), 403)
}
const period = () => new Date().toISOString().slice(0, 7)

// the companies on the books: every one with a plan, and the tenants this server serves
async function companies() {
  const rows = await q('select tenant_id from pro_billing_subscriptions order by tenant_id')
  return [...new Set([...tenants(), ...rows.map((r) => r.tenant_id)])]
}

// one company's line on the board (the month so far)
async function summaryOf(tenant) {
  const c = await withTenant(tenant, () => companyOf(tenant))
  const sub = c.subscription
  const cat = catalog(sub.catalog)
  const [inv] = await q(`select id, status, total from pro_billing_invoices where tenant_id=$1 and period=$2 and status<>'void'`, [tenant, period()])
  const seats = {}
  for (const p of c.people) seats[p.seat] = (seats[p.seat] || 0) + 1
  return {
    tenant, name: sub.company_name || tenant, catalog: sub.catalog, plan: sub.plan, planName: planOf(sub).name, billing: sub.billing,
    currency: cat.currency, unit: cat.unit, people: c.people.length, seats,
    month: c.month, pool: c.pool, extra: c.extra, bill: c.bill, invoice: inv || null,
  }
}

export function backofficeRoutes(auth) {
  const r = express.Router()

  r.get('/backoffice/billing', auth, (req, res) => send(res, (async () => {
    mustOperate(req.user)
    const list = []
    for (const t of await companies()) list.push(await summaryOf(t))
    const invoices = await q(`select i.id, i.tenant_id, s.company_name, i.period, i.plan, i.currency, i.total, i.status, i.issued_at, i.paid_at, i.paid_ref
      from pro_billing_invoices i left join pro_billing_subscriptions s on s.tenant_id=i.tenant_id order by i.issued_at desc limit 50`)
    return { period: period(), usdPerCredit: usdPerCredit(), companies: list, invoices, meter: await meter.status() }
  })()))

  // one company: people, features, the bill, its invoices and credit ledger
  r.get('/backoffice/billing/:tenant', auth, (req, res) => send(res, (async () => {
    mustOperate(req.user)
    const t = req.params.tenant
    const c = await withTenant(t, () => companyOf(t))
    const usage = await monthOf(t, {})
    return {
      tenant: t, period: period(), company: c, catalog: catalogView(c.subscription.catalog, L), features: usage.features,
      invoices: await q('select * from pro_billing_invoices where tenant_id=$1 order by issued_at desc limit 24', [t]),
      ledger: await q('select * from pro_billing_ledger where tenant_id=$1 order by created_at desc limit 24', [t]),
      // the newest usage events of the company (lib/plans/meter.js) and how far the consumer has read
      events: await q(`select u.request_id, u.at, u.user_id, p.name, u.pool, u.feature, u.model, u.prompt_tokens, u.completion_tokens, u.credits, u.plan, u.status
        from pro_billing_usage u left join pro_profile p on p.user_id::text = u.user_id where u.tenant_id=$1 order by u.at desc limit 12`, [t]),
      meter: await meter.status(),
      history: await q('select catalog, plan, billing, effective_from, effective_to from pro_billing_plan_history where tenant_id=$1 order by effective_from desc limit 6', [t]),
    }
  })()))

  // switch a company's plan (and billing cycle, name): applied to LiteLLM at once
  r.put('/backoffice/billing/:tenant/plan', auth, (req, res) => send(res, (async () => {
    mustOperate(req.user)
    const t = req.params.tenant
    const sub = await subscriptionOf(t)
    const name = req.body.catalog || sub.catalog || catalogName()
    const c = catalog(name)
    if (!c?.plans[req.body.plan || sub.plan]) throw bad(L('없는 요금제예요.', 'No such plan.'))
    const plan = req.body.plan || sub.plan
    const billing = req.body.billing === 'year' ? 'year' : req.body.billing === 'month' ? 'month' : sub.billing
    // the stretch so far stays on the old plan: the month is billed by days of each (lib/plans/history.js)
    await recordChange(t, sub, { catalog: name, plan, billing }, req.user.id)
    await q(`insert into pro_billing_subscriptions(tenant_id, catalog, plan, billing, company_name, updated_by, updated_at) values ($1,$2,$3,$4,$5,$6,now())
      on conflict (tenant_id) do update set catalog=$2, plan=$3, billing=$4, company_name=coalesce($5, pro_billing_subscriptions.company_name), updated_by=$6, updated_at=now()`,
    [t, name, plan, billing, req.body.name || null, req.user.id])
    return withTenant(t, () => applyPlan(t))
  })()))

  // purchased credits, recorded once the money is in: they join the company's monthly pool of extra usage
  r.post('/backoffice/billing/:tenant/credits', auth, (req, res) => send(res, (async () => {
    mustOperate(req.user)
    const t = req.params.tenant
    const credits = Number(req.body.credits)
    if (!(credits > 0)) throw bad(L('크레딧 수를 적어 주세요.', 'Enter the credits.'))
    const sub = await subscriptionOf(t)
    if (!planOf(sub).extraUsage) throw bad(L(`${planOf(sub).name} 요금제에는 충전 크레딧이 없어요.`, `The ${planOf(sub).name} plan has no purchased credits.`))
    await q(`insert into pro_billing_ledger(tenant_id, kind, credits, amount, ref, note, created_by) values ($1,'purchase',$2,$3,$4,$5,$6)`,
      [t, credits, req.body.amount ?? credits * Number(process.env.PRO_CREDIT_KRW || 10), req.body.ref || null, req.body.note || null, req.user.id])
    await q(`insert into pro_billing_subscriptions(tenant_id, catalog, plan, extra_usage_usd) values ($1,$2,$3,$4)
      on conflict (tenant_id) do update set extra_usage_usd = pro_billing_subscriptions.extra_usage_usd + $4, updated_at=now()`,
    [t, sub.catalog, sub.plan, credits * usdPerCredit()])
    return withTenant(t, () => applyPlan(t))
  })()))

  // the month's invoice from the bill as it stands (one live invoice a company a month)
  r.post('/backoffice/billing/:tenant/invoices', auth, (req, res) => send(res, (async () => {
    mustOperate(req.user)
    const t = req.params.tenant
    const c = await withTenant(t, () => companyOf(t))
    const b = c.bill
    const [row] = await q(`insert into pro_billing_invoices(tenant_id, period, catalog, plan, currency, lines, net, total, issued_by)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict (tenant_id, period) where status <> 'void' do nothing returning *`,
    [t, period(), c.subscription.catalog, c.subscription.plan, b.currency, JSON.stringify(b.lines), b.net ?? b.total, b.total, req.user.id])
    if (!row) throw bad(L('이번 달 청구서가 이미 있어요. 무효로 돌린 뒤 다시 발행하세요.', 'This month already has an invoice. Void it to issue again.'), 409)
    return row
  })()))

  r.post('/backoffice/billing/invoices/:id/paid', auth, (req, res) => send(res, (async () => {
    mustOperate(req.user)
    const [row] = await q(`update pro_billing_invoices set status='paid', paid_ref=$2, paid_by=$3, paid_at=now() where id=$1 and status='issued' returning *`,
      [req.params.id, req.body.ref || null, req.user.id])
    if (!row) throw bad(L('발행된 청구서만 입금 확인할 수 있어요.', 'Only an issued invoice can be marked paid.'))
    return row
  })()))

  r.post('/backoffice/billing/invoices/:id/void', auth, (req, res) => send(res, (async () => {
    mustOperate(req.user)
    const [row] = await q(`update pro_billing_invoices set status='void' where id=$1 and status='issued' returning *`, [req.params.id])
    if (!row) throw bad(L('발행된 청구서만 무효로 돌릴 수 있어요.', 'Only an issued invoice can be voided.'))
    return row
  })()))

  return r
}

