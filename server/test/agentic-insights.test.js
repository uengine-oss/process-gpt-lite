// lib/policy/insights.js against a made-up tenant (removed at the end): ledger rows written directly — an approval
// policy whose requests are all approved after a wait, a record-only policy that is often taken back, a blocking
// policy people keep running into — give loosen / tighten / alternative suggestions; applying one changes the
// policy's decision and raises its version; the report counts what the ledger holds.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { suggestions, applySuggestion, report } from '../lib/policy/insights.js'
import { policiesOf } from '../lib/policy/pdp.js'
import { q, pool } from '../lib/supa.js'

const TEN = 'agentic-insights-rt'
const ADMIN = { id: '00000000-0000-4000-8000-0000000000b1' }
after(async () => {
  await q('delete from pro_policy_decisions where tenant_id=$1', [TEN])
  await q('delete from pro_policies where tenant_id=$1', [TEN])
  await pool.end()
})

async function row(policy, decision, status, waitHours = null) {
  await q(`insert into pro_policy_decisions(tenant_id, user_id, action_kind, subject, facts, decision, matched, dry_run, status, approved_at, created_at)
    values ($1, $2, 'mail.send', 'rt', '{}', $3, $4, false, $5, case when $6::float8 is null then null else now() end, now() - make_interval(secs => coalesce($6::float8, 0) * 3600))`,
  [TEN, ADMIN.id, decision, JSON.stringify([{ id: policy, decision, category: 'privacy' }]), status, waitHours])
}

test('suggestions from the ledger: loosen, tighten, alternative — and applying one', async () => {
  await q('delete from pro_policy_decisions where tenant_id=$1', [TEN])
  await q('delete from pro_policies where tenant_id=$1', [TEN])
  await policiesOf(TEN)
  for (let i = 0; i < 6; i++) await row('mail-external-pii', 'require_approval', 'executed', 3)   // all approved, 3 h each
  for (let i = 0; i < 6; i++) await row('mail-external', 'allow_audit', i < 2 ? 'undone' : 'executed')   // 2 of 6 taken back
  for (let i = 0; i < 5; i++) await row('mail-bulk-pii', 'deny', 'decided')   // a blocked action stays 'decided' in the ledger
  const s = await suggestions({ tenant: TEN })
  const by = Object.fromEntries(s.map((x) => [x.policy, x]))
  assert.deepEqual([by['mail-external-pii']?.kind, by['mail-external-pii']?.to], ['loosen', 'allow_audit'])
  assert.equal(by['mail-external-pii'].evidence.approved, 6)
  assert.equal(by['mail-external-pii'].evidence.medianWaitHours, 3)
  assert.deepEqual([by['mail-external']?.kind, by['mail-external']?.to], ['tighten', 'require_approval'])
  assert.equal(by['mail-bulk-pii']?.kind, 'alternative')

  const [before] = await q('select version from pro_policies where tenant_id=$1 and id=$2', [TEN, 'mail-external-pii'])
  const spec = await applySuggestion(ADMIN, by['mail-external-pii'], TEN)
  assert.equal(spec.decide, 'allow_audit')
  const [now] = await q('select version, spec from pro_policies where tenant_id=$1 and id=$2', [TEN, 'mail-external-pii'])
  assert.equal(now.version, before.version + 1)
  assert.equal(now.spec.decide, 'allow_audit')
})

test('the report counts the ledger', async () => {
  const r = await report({ tenant: TEN, days: 30 })
  assert.equal(r.totals.decisions, 17)
  assert.equal(r.totals.approvals, 6)
  assert.equal(r.totals.undone, 2)
  assert.equal(r.totals.blocked, 5)
  assert.equal(r.approvalWaitMedianHours, 3)
})
