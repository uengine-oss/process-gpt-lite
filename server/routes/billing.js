// HTTP routes for 사용량·요금제 (lib/plans): my usage windows, the company's plan and seats, requests for more.
// Changing the plan or a seat is the administrators'; anyone may ask (an upgrade, a seat, extra usage) and the
// administrators get a notification. No payment here: the bill is an estimate from the seats and the usage.
import express from 'express'
import { q } from '../lib/supa.js'
import { config } from '../config.js'
import { L } from '../lib/lang.js'
import { isAdmin } from '../lib/team.js'
import { notifyUser } from '../lib/notify.js'
import * as K from '../lib/llmKeys.js'
import { catalog, catalogName, usdPerCredit } from '../lib/plans/catalog.js'
import { subscriptionOf, planOf, applyPlan, applyMember } from '../lib/plans/apply.js'
import { windowsOf, companyOf, catalogView } from '../lib/plans/usage.js'

const send = (res, p) => p.then((x) => res.json(x)).catch((e) => {
  if (!e.status) console.warn('[billing]', e.stack || e.message)
  res.status(e.status || 500).json({ error: e.message })
})
const bad = (msg) => Object.assign(new Error(msg), { status: 400 })
const T = () => config.tenantId

async function mustAdmin(me) {
  if (!(await isAdmin(me))) throw Object.assign(new Error(L('관리자만 바꿀 수 있어요.', 'Only administrators can change this.')), { status: 403 })
}
const admins = (tenant) => q(`select u.id from users u where u.tenant_id=$1 and u.is_admin
  union select t.owner from tenants t where t.id=$1 and t.owner is not null`, [tenant])

export function billingRoutes(auth) {
  const r = express.Router()

  r.get('/billing', auth, (req, res) => send(res, (async () => {
    if (!K.enabled()) return { enabled: false }
    const sub = await subscriptionOf(T())
    const admin = await isAdmin(req.user)
    const out = { enabled: true, admin, catalog: catalogView(sub.catalog, L), subscription: sub, me: await windowsOf(T(), req.user.id, sub) }
    if (admin) {
      out.company = await companyOf(T())
      out.requests = await q(`select r.id, r.kind, r.wanted, r.note, r.created_at, u.username as name, u.email from pro_billing_requests r
        left join users u on u.id=r.user_id and u.tenant_id=r.tenant_id where r.tenant_id=$1 and r.status='open' order by r.created_at`, [T()])
    } else {
      out.myRequests = await q(`select id, kind, wanted, status, created_at from pro_billing_requests where tenant_id=$1 and user_id=$2 order by created_at desc limit 5`, [T(), req.user.id])
    }
    return out
  })()))

  // the company's plan: {plan, billing, extraUsageUsd} — applied to LiteLLM at once
  r.put('/billing/plan', auth, (req, res) => send(res, (async () => {
    await mustAdmin(req.user)
    const sub = await subscriptionOf(T())
    const name = req.body.catalog || sub.catalog || catalogName()
    const c = catalog(name)
    if (!c) throw bad(`unknown catalog ${name}`)
    const plan = String(req.body.plan || sub.plan)
    const p = c.plans[plan]
    if (!p) throw bad(L(`없는 요금제예요: ${plan}`, `No such plan: ${plan}`))
    const [{ n }] = await q('select count(*)::int n from pro_team_members where tenant_id=$1', [T()])
    if (p.maxSeats && n > p.maxSeats) throw bad(L(`${p.name}은 최대 ${p.maxSeats}석이에요. 지금 팀원은 ${n}명이에요.`, `${p.name} has at most ${p.maxSeats} seats; the team has ${n}.`))
    const billing = req.body.billing === 'year' ? 'year' : 'month'
    // the pool (Team) or spend limit (Enterprise): in USD, or in credits on a credit catalog (extraCredits)
    const extra = req.body.extraCredits != null ? Math.max(0, Number(req.body.extraCredits) || 0) * usdPerCredit()
      : req.body.extraUsageUsd != null ? Math.max(0, Number(req.body.extraUsageUsd) || 0) : sub.extra_usage_usd
    await q(`insert into pro_billing_subscriptions(tenant_id, catalog, plan, billing, extra_usage_usd, updated_by, updated_at) values ($1,$2,$3,$4,$5,$6,now())
      on conflict (tenant_id) do update set catalog=$2, plan=$3, billing=$4, extra_usage_usd=$5, updated_by=$6, updated_at=now()`, [T(), name, plan, billing, extra, req.user.id])
    await q(`update pro_billing_requests set status='done', decided_by=$2, decided_at=now() where tenant_id=$1 and status='open' and kind in ('plan','extra_usage')`, [T(), req.user.id])
    return applyPlan(T())
  })()))

  // a person's seat (and an admin's monthly limit for them): {seat, limitUsd}
  r.put('/billing/seats/:userId', auth, (req, res) => send(res, (async () => {
    await mustAdmin(req.user)
    const sub = await subscriptionOf(T())
    const seat = String(req.body.seat || '')
    if (!planOf(sub).seats.includes(seat)) throw bad(L(`이 요금제에 없는 좌석이에요: ${seat}`, `This plan has no ${seat} seat`))
    // the person's monthly limit, in USD or credits (limitCredits); empty: the seat's own
    const raw = req.body.limitCredits ?? req.body.limitUsd
    const limit = raw === '' || raw == null ? null : Math.max(0, Number(raw)) * (req.body.limitCredits != null ? usdPerCredit() : 1)
    await q(`insert into pro_billing_seats(tenant_id, user_id, seat, limit_usd, updated_by, updated_at) values ($1,$2,$3,$4,$5,now())
      on conflict (tenant_id, user_id) do update set seat=$3, limit_usd=$4, updated_by=$5, updated_at=now()`, [T(), req.params.userId, seat, limit, req.user.id])
    await q(`update pro_billing_requests set status='done', decided_by=$3, decided_at=now() where tenant_id=$1 and user_id=$2 and status='open' and kind='seat'`, [T(), req.params.userId, req.user.id])
    return applyMember(T(), req.params.userId, { sub })
  })()))

  // asking for more: {kind: plan|seat|extra_usage, wanted, note} → every administrator is notified
  r.post('/billing/requests', auth, (req, res) => send(res, (async () => {
    const kind = String(req.body.kind || '')
    if (!['plan', 'seat', 'extra_usage'].includes(kind)) throw bad('kind: plan | seat | extra_usage')
    const wanted = String(req.body.wanted || '').slice(0, 40), note = String(req.body.note || '').slice(0, 500)
    const [row] = await q(`insert into pro_billing_requests(tenant_id, user_id, kind, wanted, note) values ($1,$2,$3,$4,$5) returning id, created_at`, [T(), req.user.id, kind, wanted, note])
    const what = { plan: L(`요금제를 ${wanted}(으)로`, `the plan to ${wanted}`), seat: L(`좌석을 ${wanted}(으)로`, `a ${wanted} seat`), extra_usage: L('추가 사용량을', 'extra usage') }[kind]
    for (const a of await admins(T())) {
      if (String(a.id) === String(req.user.id)) continue
      await notifyUser(a.id, {
        type: 'billing', url: '/settings/usage',
        title: L('AI 사용량 요청', 'AI usage request'),
        text: L(`${req.user.name}님이 ${what} 바꿔 달라고 요청했어요.${note ? ` "${note}"` : ''}`, `${req.user.name} asks for ${what}.${note ? ` "${note}"` : ''}`),
      })
    }
    return row
  })()))

  r.post('/billing/requests/:id/decline', auth, (req, res) => send(res, (async () => {
    await mustAdmin(req.user)
    await q(`update pro_billing_requests set status='declined', decided_by=$3, decided_at=now() where tenant_id=$1 and id=$2`, [T(), req.params.id, req.user.id])
    return { ok: true }
  })()))

  return r
}
