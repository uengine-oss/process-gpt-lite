// What the decision ledger teaches (plan.md P4): suggestions to retune policies, and the month's report.
//
// Suggestions (an administrator applies them in the report page; nothing changes by itself):
//   - an approval policy whose requests are almost always approved, after a wait, is a candidate for
//     "record and allow" (Human-on-the-Loop): the wait it would save is the evidence
//   - a record-only policy whose actions are often taken back (undo) or failed is a candidate for approval
//   - a blocking policy that people keep running into is a candidate for an alternative path (the optimizer)
// The report: decisions by result and category, how long approvals waited, what ran unattended, what was
// stopped, the optimizer's outcomes, and the approvals that had a decision brief prepared versus those that did not.
import { q } from '../supa.js'
import { config } from '../../config.js'
import { policiesOf } from './pdp.js'

const T = () => config.tenantId
const HOUR = 3600

export async function suggestions({ tenant = T(), days = 30, minCount = 5 } = {}) {
  const specs = Object.fromEntries((await policiesOf(tenant, { all: true })).map((r) => [r.id, r]))
  // per policy: the decisions it took part in (live ones only), how they ended, how long approvals took
  const rows = await q(`select m->>'id' as policy, m->>'decision' as decision, d.status,
      extract(epoch from (d.approved_at - d.created_at))::float8 as wait_s
    from pro_policy_decisions d, jsonb_array_elements(d.matched) m
    where d.tenant_id=$1 and not d.dry_run and d.created_at > now() - ($2::int * interval '1 day')`, [tenant, days])
  const by = {}
  for (const r of rows) {
    const p = (by[r.policy] ||= { policy: r.policy, n: 0, approval: 0, approved: 0, rejected: 0, waits: [], audit: 0, undone: 0, failed: 0, denied: 0 })
    p.n++
    if (r.decision === 'require_approval') {
      p.approval++
      if (['approved', 'executed'].includes(r.status) && r.wait_s != null) { p.approved++; p.waits.push(r.wait_s) }
      if (r.status === 'rejected') p.rejected++
    } else if (r.decision === 'allow_audit') {
      p.audit++
      if (r.status === 'undone') p.undone++
      if (r.status === 'failed') p.failed++
    } else if (r.decision === 'deny') p.denied++
  }
  const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] }
  const out = []
  for (const p of Object.values(by)) {
    const spec = specs[p.policy]?.spec
    if (!spec) continue
    const decided = p.approved + p.rejected
    if (spec.decide === 'require_approval' && decided >= minCount && p.rejected / decided <= 0.05) {
      out.push({ policy: p.policy, kind: 'loosen', from: 'require_approval', to: 'allow_audit', evidence: { requests: p.approval, approved: p.approved, rejected: p.rejected, medianWaitHours: +(median(p.waits) / HOUR).toFixed(1) },
        reason: ['거의 모두 승인됩니다. 실행 후 기록·감사로 바꾸면 그만큼의 승인 대기가 사라집니다.', 'Almost every request is approved; record-and-allow would remove the wait.'] })
    }
    if (spec.decide === 'allow_audit' && p.audit >= minCount && (p.undone + p.failed) / p.audit >= 0.1) {
      out.push({ policy: p.policy, kind: 'tighten', from: 'allow_audit', to: 'require_approval', evidence: { actions: p.audit, undone: p.undone, failed: p.failed },
        reason: ['실행 뒤 되돌리거나 실패한 비율이 높습니다. 사전 승인으로 바꾸는 것을 검토하세요.', 'Many of these are taken back or fail afterwards; consider approval first.'] })
    }
    if (spec.decide === 'deny' && p.denied >= minCount) {
      out.push({ policy: p.policy, kind: 'alternative', evidence: { blocked: p.denied },
        reason: ['자주 막힙니다. 막히는 일을 허용 범위 안에서 해낼 대안 경로(최적화)를 마련하세요.', 'People keep running into this; give them an allowed path (the optimizer).'] })
    }
  }
  return out.sort((a, b) => (b.evidence.requests || b.evidence.actions || b.evidence.blocked) - (a.evidence.requests || a.evidence.actions || a.evidence.blocked))
}

// apply one suggestion: the policy's decision changes (a new version of it), only by an administrator (route)
export async function applySuggestion(me, s, tenant = T()) {
  const [row] = await q('select spec from pro_policies where tenant_id=$1 and id=$2', [tenant, s.policy])
  if (!row) throw Object.assign(new Error('no such policy'), { status: 404 })
  const spec = { ...row.spec, decide: s.to }
  if (s.to === 'require_approval' && !spec.approver?.role) spec.approver = { role: '팀장' }
  await q(`update pro_policies set spec=$3, version=version+1, updated_by=$4, updated_at=now() where tenant_id=$1 and id=$2`, [tenant, s.policy, spec, me.id])
  return spec
}

export async function report({ tenant = T(), days = 30 } = {}) {
  const since = `now() - (${Number(days) | 0} * interval '1 day')`
  const byDecision = await q(`select decision, status, count(*)::int n from pro_policy_decisions where tenant_id=$1 and not dry_run and created_at > ${since} group by 1, 2`, [tenant])
  const byCategory = await q(`select m->>'category' as category, d.decision, count(distinct d.id)::int n from pro_policy_decisions d, jsonb_array_elements(d.matched) m
    where d.tenant_id=$1 and not d.dry_run and d.created_at > ${since} and m->>'decision' = d.decision group by 1, 2`, [tenant])
  const [wait] = await q(`select count(*)::int n, percentile_cont(0.5) within group (order by extract(epoch from (approved_at - created_at)))::float8 as median_s
    from pro_policy_decisions where tenant_id=$1 and not dry_run and decision='require_approval' and approved_at is not null and created_at > ${since}`, [tenant])
  const optim = await q(`select status, count(*)::int n from pro_optimizations where tenant_id=$1 and created_at > ${since} group by 1`, [tenant])
  // approvals that had a decision brief prepared (scenario P2): how long from the brief to the decision
  const [briefs] = await q(`select count(*)::int n, count(decided_at)::int decided,
      percentile_cont(0.5) within group (order by extract(epoch from (decided_at - created_at)))::float8 as median_s
    from pro_decision_briefs where tenant_id=$1 and created_at > ${since}`, [tenant])
  const count = (pred) => byDecision.filter(pred).reduce((a, r) => a + r.n, 0)
  return {
    days,
    totals: {
      decisions: count(() => true),
      unattended: count((r) => r.decision === 'allow' && r.status === 'executed'),
      audited: count((r) => r.decision === 'allow_audit'),
      undone: count((r) => r.status === 'undone'),
      approvals: count((r) => r.decision === 'require_approval'),
      pending: count((r) => r.status === 'pending'),
      rejected: count((r) => r.status === 'rejected'),
      blocked: count((r) => r.decision === 'deny'),
    },
    approvalWaitMedianHours: wait?.median_s != null ? +(wait.median_s / HOUR).toFixed(2) : null,
    byDecision, byCategory, optimizations: optim,
    briefs: { ...briefs, medianHours: briefs?.median_s != null ? +(briefs.median_s / HOUR).toFixed(2) : null },
    suggestions: await suggestions({ tenant, days }),
  }
}
