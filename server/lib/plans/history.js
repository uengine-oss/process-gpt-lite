// Which plan a company was on, when (pro_billing_plan_history): one row per stretch. A month with a change is
// billed by the days of each plan (일할 계산), and its pool is each plan's share of the month — so moving up on
// the 15th pays the new seats for the rest of the month only, and moving down after a heavy fortnight does not
// bring a fresh month of credits.
import { q } from '../supa.js'

// this month in UTC (LiteLLM's monthly budgets reset on the 1st, 00:00 UTC)
export function monthBounds(d = new Date()) {
  return { from: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)), to: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)) }
}

// a change of plan (catalog or billing cycle): the open stretch ends now, the new one starts. The very first
// change also writes the plan the company had since the month began.
export async function recordChange(tenant, before, after, by = null) {
  if (before && before.catalog === after.catalog && before.plan === after.plan && before.billing === after.billing) return false
  const [open] = await q('select id from pro_billing_plan_history where tenant_id=$1 and effective_to is null', [tenant])
  if (open) await q('update pro_billing_plan_history set effective_to=now() where id=$1', [open.id])
  else if (before) {
    await q(`insert into pro_billing_plan_history(tenant_id, catalog, plan, billing, effective_from, effective_to) values ($1,$2,$3,$4,$5,now())`,
      [tenant, before.catalog, before.plan, before.billing, monthBounds().from])
  }
  await q(`insert into pro_billing_plan_history(tenant_id, catalog, plan, billing, changed_by) values ($1,$2,$3,$4,$5)`, [tenant, after.catalog, after.plan, after.billing, by])
  return true
}

// the month cut into the plans it had: [{catalog, plan, billing, from, to, frac, days}], the last one reaching
// the month's end; no history: the whole month on the plan now
export async function segmentsOf(tenant, sub, { from, to } = monthBounds()) {
  const rows = await q(`select catalog, plan, billing, greatest(effective_from, $2) s, least(coalesce(effective_to, $3), $3) e from pro_billing_plan_history
    where tenant_id=$1 and effective_from < $3 and coalesce(effective_to, $3) > $2 order by effective_from`, [tenant, from, to])
  const segs = rows.length ? rows.map((r) => ({ catalog: r.catalog, plan: r.plan, billing: r.billing, from: new Date(r.s), to: new Date(r.e) }))
    : [{ catalog: sub.catalog, plan: sub.plan, billing: sub.billing, from, to }]
  // before the first recorded stretch: on its plan; the open stretch: to the month's end
  segs[0].from = from
  segs[segs.length - 1].to = to
  const total = to - from
  return segs.filter((s) => s.to > s.from).map((s) => ({ ...s, frac: (s.to - s.from) / total, days: Math.round(((s.to - s.from) / 864e5) * 10) / 10 }))
}
