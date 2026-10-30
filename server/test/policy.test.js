// lib/policy: the JSONLogic subset, the DSL validator, and the PDP/PEP against the database (a made-up tenant,
// removed at the end): strictest wins, tolerance, the window, approval then execution, undo.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../lib/policy/jsonlogic.js'
import { validate } from '../lib/policy/dsl.js'
import { CATALOG } from '../lib/policy/catalog.js'
import { evaluate, decide, policiesOf } from '../lib/policy/pdp.js'
import { registerExecutor, guard, answer, undo } from '../lib/policy/pep.js'
import { withTenant } from '../lib/tenant.js'
import { q, pool } from '../lib/supa.js'

const TEN = 'localhost'
const ME = { id: '1b0cd880-86db-4803-8b9c-f3cbc3ca66af', name: '테스트' }   // pro-team-owner
const made = []
after(async () => {
  if (made.length) await q('delete from pro_policy_decisions where id = any($1::uuid[])', [made])
  // the notices this file's requests sent — to the approvers and back to the requester — would sit on their Home
  await q(`delete from notifications where tenant_id=$1 and type='policy' and title ~ ' — (pii|plain) out$'`, [TEN])
  await pool.end()
})

test('jsonlogic: comparisons, and/or, some, var paths', () => {
  const f = { external: true, pii_count: 3, open_findings: { privacy: 1 }, features: [{ name: 'a', pii: false }, { name: 'b', pii: true }] }
  assert.equal(apply({ and: [{ var: 'external' }, { '>': [{ var: 'pii_count' }, 0] }] }, f), true)
  assert.equal(apply({ '>': [{ var: 'open_findings.privacy' }, 0] }, f), true)
  assert.equal(apply({ some: [{ var: 'features' }, { var: 'pii' }] }, f), true)
  assert.equal(apply({ in: [{ var: 'x' }, ['internal', 'beta']] }, { x: 'beta' }), true)
  assert.throws(() => apply({ nope: [1] }, {}), /unknown operator/)
})

test('every catalog policy is valid', () => {
  for (const s of CATALOG) assert.deepEqual(validate(s), [], s.id)
})

test('the strictest decision wins; tolerance softens; facts decide', async () => {
  await policiesOf(TEN)
  const mail = (facts) => evaluate({ tenant: TEN, userId: null, action: { kind: 'mail.send', facts } })
  assert.equal((await mail({ external: false, pii_count: 0 })).decision, 'allow')
  assert.equal((await mail({ external: true, pii_count: 0 })).decision, 'allow_audit')
  const pii = await mail({ external: true, pii_count: 3 })
  assert.equal(pii.decision, 'require_approval'); assert.equal(pii.approver, '개인정보 책임자')
  assert.equal((await mail({ external: true, pii_count: 120 })).decision, 'deny')
  const pay = (amount) => evaluate({ tenant: TEN, action: { kind: 'browser.payment', facts: { amount } } })
  assert.equal((await pay(105000)).decision, 'allow_audit')      // within ₩110,000
  assert.equal((await pay(130000)).decision, 'require_approval')
  assert.equal((await pay(6000000)).decision, 'deny')
  const rel = (facts) => evaluate({ tenant: TEN, action: { kind: 'release.deploy', facts: { security_scan: 'passed', weekday: 3, hour: 10, ...facts } } })
  assert.equal((await rel({ audience: 'public', open_findings: { privacy: 1 }, features: [{ name: 'share', pii: true }] })).decision, 'deny')
  assert.equal((await rel({ audience: 'internal', open_findings: { privacy: 1 }, features: [{ name: 'share', pii: true }] })).decision, 'allow_audit')
})

test('the window: past 20 external mails a day, approval', async () => {
  const userId = '00000000-0000-4000-8000-0000000000a1'
  for (let i = 0; i < 20; i++) {
    const d = await decide({ tenant: TEN, userId, action: { kind: 'mail.send', subject: `w${i}`, facts: { external: true, pii_count: 0 } } })
    made.push(d.id)
    assert.equal(d.decision, 'allow_audit', `mail ${i + 1}`)
  }
  const d = await decide({ tenant: TEN, userId, action: { kind: 'mail.send', subject: 'w21', facts: { external: true, pii_count: 0 } } })
  made.push(d.id)
  assert.equal(d.decision, 'require_approval')
  assert.equal(d.matched.find((m) => m.id === 'mail-external').notes[0].kind, 'window')
  assert.equal(d.approver, '팀장')
  // the 21st mail carries personal data too: two policies want approval, the daily count (audit) gives way
  const p = await evaluate({ tenant: TEN, userId, action: { kind: 'mail.send', facts: { external: true, pii_count: 3 } } })
  assert.equal(p.decision, 'require_approval')
  assert.equal(p.approver, '개인정보 책임자')
})

test('the PEP: approval runs the kept action as the requester; undo inside the window', async () => {
  const ran = []
  registerExecutor('test.echo', { run: async (p, ctx) => { ran.push({ p, ctx }); return { ok: 1 } }, undo: async () => { ran.push('undone') }, undoMinutes: 5 })
  await withTenant(TEN, async () => {
    const held = await guard({ me: ME, kind: 'mail.send', subject: 'pii out', facts: { external: true, pii_count: 2 }, executor: 'test.echo', payload: { n: 1 } })
    made.push(held.decisionId)
    assert.equal(held.status, 'pending'); assert.equal(ran.length, 0)
    // the requester never approves their own request, administrator or role holder or not
    await assert.rejects(answer(ME, held.decisionId, true, 'mine'), (e) => e.status === 403)
    // the 개인정보 책임자 (이도윤, also an administrator) approves: the kept action runs as the requester
    const [lee] = await q("select id from users where tenant_id='localhost' and lower(email)='pro-mine3-admin@uengine.org'")
    const r = await answer({ id: lee.id, name: '이도윤' }, held.decisionId, true, 'ok')
    assert.equal(r.status, 'executed'); assert.equal(ran[0].ctx.userId, ME.id)
    const audited = await guard({ me: ME, kind: 'mail.send', subject: 'plain out', facts: { external: true, pii_count: 0 }, executor: 'test.echo', payload: { n: 2 } })
    made.push(audited.decisionId)
    assert.equal(audited.decision, 'allow_audit'); assert.equal(audited.status, 'executed'); assert.ok(audited.undoUntil)
    const u = await undo(ME, audited.decisionId)
    assert.equal(u.status, 'undone'); assert.ok(ran.includes('undone'))
  })
})
