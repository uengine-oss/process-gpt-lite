// Safety policy data (lib/policies.js, decision 1 2026-11-21): the words a floor reads are data in
// policies/*.json; matching is format only; a company adds words, only an administrator takes default
// words out, and every change is kept (pro_policy_changes, sql/029 — on the local database, cleaned up).
// Run: node --test test/policies.test.js
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
process.env.SERVICE_ROLE_KEY ||= 'unit-test'
const POL = await import('../lib/policies.js')
const { q, pool } = await import('../lib/supa.js')
const db = await q('select 1 from pro_policy_changes limit 1').then(() => true).catch(() => false)
const tenant = `policy-test-${crypto.randomUUID().slice(0, 8)}`
after(async () => { if (db) await q('alter table pro_policy_changes disable trigger pro_policy_changes_append_only').then(() => q('delete from pro_policy_changes where tenant_id=$1', [tenant])).finally(() => q('alter table pro_policy_changes enable trigger pro_policy_changes_append_only')).catch(() => {}); await pool.end() })

test('matching is format: whole Latin words (or a stem*), Hangul/Han/kana as parts without spaces, =whole label', () => {
  const t = (s) => s.normalize('NFKC').toLowerCase()
  assert.equal(POL.termIn(t('Pay ₩12,000'), 'pay'), true)
  assert.equal(POL.termIn(t('Display options'), 'pay'), false, 'a word inside another word is not it')
  assert.equal(POL.termIn(t('Payment history'), 'pay'), false)
  assert.equal(POL.termIn(t('diagnosis date'), 'diagnos*'), true)
  assert.equal(POL.termIn(t('agenda'), 'age'), false)
  assert.equal(POL.termIn(t('바로 구매하기'), '바로구매'), true, 'spaces do not matter in Hangul')
  assert.equal(POL.termIn(t('결제 내역'), '=결제'), false, '=word is the whole label only')
  assert.equal(POL.termIn(t('결제'), '=결제'), true)
  assert.equal(POL.termIn(t('ＡＤＤ　ＴＯ　ＣＡＲＴ'), 'add to cart'), true, 'full-width and ideographic spaces')
})

test('levels: the highest level whose words appear, in any language of the policy', () => {
  assert.equal(POL.levelByWords('purchase', 'words', '注文を確定する').level, 'payment')
  assert.equal(POL.levelByWords('purchase', 'words', 'In den Warenkorb').level, 'purchase')
  assert.equal(POL.levelByWords('purchase', 'words', 'Order history').level, 'none')
  assert.equal(POL.levelByWords('privacy', 'words', '緊急連絡先', { levels: ['public', 'personal', 'sensitive'] }).level, 'personal')
  assert.equal(POL.strictest('purchase', 'none', 'payment', 'purchase'), 'payment')
  assert.equal(POL.strictest('privacy', 'internal', 'bogus'), 'internal')
})

test('a company raises a floor with its own words; taking words out is an administrator\'s act, recorded', { skip: !db }, async () => {
  const word = `zz${crypto.randomUUID().slice(0, 6)}`
  assert.equal(POL.levelByWords('purchase', 'words', `${word} now`, { tenant }).level, 'none')
  await POL.change({ tenant, policy: 'purchase', level: 'purchase', add: [word], by: 'u-member' })
  assert.equal(POL.levelByWords('purchase', 'words', `${word} now`, { tenant }).level, 'purchase')
  assert.equal(POL.levelByWords('purchase', 'words', `${word} now`, { tenant: 'another-company' }).level, 'none', 'per company')
  await assert.rejects(POL.change({ tenant, policy: 'purchase', level: 'purchase', remove: ['add to cart'], by: 'u-member' }), (e) => e.status === 403 && e.code === 'POLICY_LOWER_ADMIN_ONLY')
  await assert.rejects(q(`insert into pro_policy_changes(tenant_id, policy, level, remove_words, by_user, by_admin) values ($1,'purchase','purchase','{x}','u',false)`, [tenant]), /check/i, 'the table refuses it too')
  await POL.change({ tenant, policy: 'purchase', level: 'purchase', remove: ['add to cart'], by: 'u-admin', admin: true, note: 'the shop UI uses it for a wishlist' })
  assert.equal(POL.levelByWords('purchase', 'words', 'Add to cart', { tenant }).level, 'none')
  assert.equal(POL.levelByWords('purchase', 'words', 'Add to cart', { tenant: 'another-company' }).level, 'purchase')
  const h = await POL.history(tenant, 'purchase')
  assert.deepEqual(h.map((r) => [r.by_user, r.by_admin, r.add_words, r.remove_words]), [['u-member', false, [word], []], ['u-admin', true, [], ['add to cart']]])
  await assert.rejects(q('update pro_policy_changes set by_admin=false where tenant_id=$1', [tenant]), /append-only/)
})

test('privacy: the strictest of the designer, the reviewer, the policy words and the type floor', async () => {
  const PV = await import('../lib/panelApps/privacy.js')
  const def = { kind: 'list', title: 'x', fields: [
    { key: 'who', label: 'Owner', type: 'person' },
    { key: 'reach', label: 'Ping me at', type: 'email', sensitivity: 'public' },
    { key: 'cell_x', label: 'Line', type: 'phone' },
    { key: 'take', label: 'Monthly amount received', type: 'number', sensitivity: 'internal' },
    { key: 'sku', label: 'SKU', type: 'text' },
  ] }
  const lv = (d) => Object.fromEntries(d.fields.map((f) => [f.key, f.sensitivity]))
  // the type floor reads no words: an email or phone field is personal whatever its label
  assert.deepEqual(lv(PV.classify(def)), { who: 'internal', reach: 'personal', cell_x: 'personal', take: 'internal', sku: 'internal' })
  // the reviewer's proposal raises; it never lowers what the floor or the designer said
  assert.deepEqual(lv(PV.classify(def, { proposals: { take: 'sensitive', reach: 'public', sku: 'public' } })), { who: 'internal', reach: 'personal', cell_x: 'personal', take: 'sensitive', sku: 'internal' })
})
