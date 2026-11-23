// Regression cases for the guardrails (plan.md P4: 시뮬레이션 테스트케이스): every case in agentic-cases.json —
// an action with its facts and the decision the seed catalog must give — against a tenant that has only the
// catalog (its policies as seeded, all on). A change to a policy or to the PDP that moves a decision fails here.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { evaluate, policiesOf } from '../lib/policy/pdp.js'
import { CATALOG } from '../lib/policy/catalog.js'
import { q, pool } from '../lib/supa.js'

const TEN = 'agentic-regression'
const CASES = JSON.parse(fs.readFileSync(new URL('./agentic-cases.json', import.meta.url), 'utf8'))
after(async () => {
  await q('delete from pro_policies where tenant_id=$1', [TEN])
  await pool.end()
})

test('seed the catalog for a clean tenant', async () => {
  await q('delete from pro_policies where tenant_id=$1', [TEN])
  assert.equal((await policiesOf(TEN)).length, CATALOG.length)
})

for (const c of CASES) {
  test(c.name, async () => {
    const r = await evaluate({ tenant: TEN, userId: null, action: { kind: c.kind, facts: c.facts } })
    assert.equal(r.decision, c.expect, `${c.name}: ${r.matched.map((m) => `${m.id}=${m.decision}`).join(', ')}`)
    if (c.approver) assert.equal(r.approver, c.approver)
  })
}
