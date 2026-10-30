// The policy decision point. An action — {kind, subject, facts} — is checked against the company's enabled
// policies (lib/policy/catalog.js seeds them, Settings › 정책 turns them on or off): each policy in scope whose
// rule matches gives a decision, tolerance can soften it to "record only", a window (how many such actions
// this person did in the span) can harden it, and the strictest decision wins. Every decision, including a
// dry run (the optimizer checking an alternative before choosing it), goes into the ledger with the facts and
// the policies that matched. Deterministic: no model call.
import { q } from '../supa.js'
import { config } from '../../config.js'
import { apply, truthy } from './jsonlogic.js'
import { CATALOG } from './catalog.js'
import { inScope, strictest, spanMs, validate } from './dsl.js'

const T = () => config.tenantId
const get = (o, path) => String(path).split('.').reduce((v, k) => (v == null ? v : v[k]), o)

// the company's policies; the catalog seeds a company the first time (new catalog entries join later ones too)
export async function policiesOf(tenant = T(), { all = false } = {}) {
  const have = await q('select id from pro_policies where tenant_id=$1', [tenant])
  const known = new Set(have.map((r) => r.id))
  for (const spec of CATALOG.filter((s) => !known.has(s.id))) {
    await q('insert into pro_policies(tenant_id, id, spec) values ($1,$2,$3) on conflict do nothing', [tenant, spec.id, spec])
  }
  const rows = await q(`select id, version, enabled, spec, updated_at from pro_policies where tenant_id=$1 ${all ? '' : 'and enabled'} order by id`, [tenant])
  return all ? rows : rows.map((r) => r.spec)
}

export async function savePolicy(me, spec, { enabled = true, tenant = T() } = {}) {
  const errs = validate(spec)
  if (errs.length) throw Object.assign(new Error(errs.join('; ')), { status: 400 })
  await q(`insert into pro_policies(tenant_id, id, spec, enabled, updated_by) values ($1,$2,$3,$4,$5)
    on conflict (tenant_id, id) do update set spec=$3, enabled=$4, version=pro_policies.version+1, updated_by=$5, updated_at=now()`,
  [tenant, spec.id, spec, enabled, me?.id || null])
}

export async function setEnabled(me, id, enabled, tenant = T()) {
  await q('update pro_policies set enabled=$3, updated_by=$4, updated_at=now() where tenant_id=$1 and id=$2', [tenant, id, !!enabled, me?.id || null])
}

// how many of this person's actions the policy matched in its window (the action being decided not counted)
async function windowCount(tenant, userId, kind, policyId, span) {
  const [r] = await q(`select count(*)::int n from pro_policy_decisions where tenant_id=$1 and user_id is not distinct from $2 and action_kind=$3
    and not dry_run and created_at > now() - ($4::bigint * interval '1 millisecond') and matched @> $5::jsonb`,
  [tenant, userId || null, kind, spanMs(span), JSON.stringify([{ id: policyId }])])
  return r.n
}

// evaluate without writing (tests, the optimizer's comparisons): {decision, matched, approver}
export async function evaluate({ tenant = T(), userId = null, action }) {
  const specs = (await policiesOf(tenant)).filter((s) => inScope(s, action.kind))
  const facts = action.facts || {}
  const matched = []
  for (const s of specs) {
    if (s.when !== undefined && !truthy(apply(s.when, facts))) continue
    let decision = s.decide
    const notes = []
    if (s.tolerance) {
      const v = Number(get(facts, s.tolerance.field))
      if (Number.isFinite(v) && v <= Number(s.tolerance.limit) * (1 + Number(s.tolerance.over))) {
        decision = 'allow_audit'
        notes.push({ kind: 'tolerance', value: v, limit: s.tolerance.limit, over: s.tolerance.over })
      }
    }
    if (s.window) {
      const n = await windowCount(tenant, userId, action.kind, s.id, s.window.span)
      if (n >= Number(s.window.count)) {
        decision = strictest([decision, s.window.then])
        notes.push({ kind: 'window', count: n + 1, limit: s.window.count, span: s.window.span })
      }
    }
    matched.push({ id: s.id, category: s.category, decision, title: s.title, explain: s.explain, sources: s.sources || [], approver: s.approver?.role || null, notes })
  }
  const decision = matched.length ? strictest(matched.map((m) => m.decision)) : 'allow'
  // who approves (or may grant an exception): the role of the policy that set the decision; when several set it, an
  // audit policy (a daily count, say) gives way — personal data in the 21st mail of the day still goes to the 개인정보 책임자
  const setters = matched.filter((m) => m.decision === decision && m.approver)
  const approver = (setters.find((m) => m.category !== 'audit') || setters[0])?.approver || null
  return { decision, matched, approver }
}

// decide and write the ledger row: {id, decision, matched, approver, dryRun}
export async function decide({ tenant = T(), userId = null, action, dryRun = false, ref = null }) {
  const r = await evaluate({ tenant, userId, action })
  const status = dryRun ? 'decided' : r.decision === 'require_approval' ? 'pending' : 'decided'
  const [row] = await q(`insert into pro_policy_decisions(tenant_id, user_id, action_kind, subject, facts, decision, matched, dry_run, status, approver_role, ref)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id, created_at`,
  [tenant, userId, action.kind, action.subject || null, action.facts || {}, r.decision, JSON.stringify(r.matched), dryRun, status, r.approver, ref])
  return { id: row.id, at: row.created_at, ...r, dryRun }
}
