// Vault envelope encryption against the real database, with a throwaway keyring so the server's
// KEK is never touched. The chain KEK → DEK → item is re-derived here independently of lib/vault.js.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgpt-vault-test-'))
const keyringFile = path.join(dir, 'keyring.json')
const kek0 = crypto.randomBytes(32)
const kekId = (k) => crypto.createHash('sha256').update(k).digest('hex').slice(0, 12)
fs.writeFileSync(keyringFile, JSON.stringify({ current: kekId(kek0), keys: [{ id: kekId(kek0), key: kek0.toString('base64') }] }), { mode: 0o600 })
process.env.PRO_VAULT_KEYRING = keyringFile
delete process.env.PRO_VAULT_KEK

const vault = await import('../lib/vault.js')
const { q, pool } = await import('../lib/supa.js')

const users = []
const newUser = () => { const u = crypto.randomUUID(); users.push(u); return u }
const keyring = () => new Map(JSON.parse(fs.readFileSync(keyringFile, 'utf8')).keys.map((k) => [k.id, Buffer.from(k.key, 'base64')]))
function open(key, blob, aad) {
  const b = Buffer.from(blob, 'base64')
  const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12))
  d.setAAD(Buffer.from(aad))
  d.setAuthTag(b.subarray(12, 28))
  return Buffer.concat([d.update(b.subarray(28)), d.final()])
}
const dekAad = (u, v) => (v > 1 ? `dek:${u}:v${v}` : `dek:${u}`)

after(async () => {
  for (const t of ['pro_vault_items', 'pro_vault_keys', 'pro_vault_audit']) await q(`delete from ${t} where user_id = any($1)`, [users])
  await pool.end()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('a login is stored only as ciphertext under a per-user DEK wrapped by the KEK', async () => {
  const u = newUser()
  const item = await vault.putItem(u, 'login', 'https://www.Shop.test/login', { username: 'kim@shop.test', password: 'Pa55-word-77' })
  assert.equal(item.site, 'shop.test')
  assert.equal(item.label, 'kim@shop.test')

  const [key] = await q('select * from pro_vault_keys where user_id=$1', [u])
  const [row] = await q('select * from pro_vault_items where id=$1', [item.id])
  assert.equal(key.kek_id, kekId(kek0))
  // nothing secret in the stored row, in clear or base64
  const stored = JSON.stringify(row) + JSON.stringify(key)
  assert.ok(!stored.includes('Pa55-word-77'))
  assert.ok(!stored.includes(Buffer.from('Pa55-word-77').toString('base64')))
  assert.ok(!stored.includes(kek0.toString('base64')), 'KEK is not in the database')

  // independent unwrap: KEK → DEK → item
  const dek = open(kek0, key.wrapped_dek, dekAad(u, 1))
  assert.equal(dek.length, 32)
  const data = JSON.parse(open(dek, row.secret, `item:${u}:login:shop.test`).toString())
  assert.deepEqual(data, { username: 'kim@shop.test', password: 'Pa55-word-77' })
  // the item is not readable with the KEK directly, nor under another site/user binding
  assert.throws(() => open(kek0, row.secret, `item:${u}:login:shop.test`))
  assert.throws(() => open(dek, row.secret, `item:${u}:login:evil.test`))
  assert.throws(() => open(dek, row.secret, `item:${crypto.randomUUID()}:login:shop.test`))
})

test('listing and proof never return a secret, and proof checks all pass', async () => {
  const u = newUser()
  await vault.putItem(u, 'login', 'shop.test', { username: 'lee', password: 'Secret-Proof-1' })
  await vault.putItem(u, 'card', 'ignored', { number: '4242 4242 4242 4242', exp: '12/30', cvv: '123', name: 'LEE' })
  const list = await vault.listItems(u)
  assert.equal(list.length, 2)
  for (const i of list) assert.equal(i.secret, undefined)
  const proof = await vault.proof(u)
  const text = JSON.stringify([list, proof])
  for (const s of ['Secret-Proof-1', '4242424242424242', '"123"']) assert.ok(!text.includes(s), `${s} leaked`)
  assert.equal(proof.ok, true)
  assert.equal(proof.kek.stored_in_database, false)
  assert.deepEqual(proof.items.find((i) => i.kind === 'card').fields.sort(), ['cvv', 'exp', 'name', 'number'])
})

test('a ciphertext moved to another site no longer opens', async () => {
  const u = newUser()
  const item = await vault.putItem(u, 'login', 'bank.test', { username: 'park', password: 'Moved-Secret-9' })
  await q('update pro_vault_items set site=$2 where id=$1', [item.id, 'attacker.test'])
  await assert.rejects(vault.useItem(u, item.id))
})

test('several accounts per site; the same account updates in place', async () => {
  const u = newUser()
  const a = await vault.putItem(u, 'login', 'mail.test', { username: 'Work@corp.test', password: 'one-1111' })
  const b = await vault.putItem(u, 'login', 'mail.test', { username: 'me@home.test', password: 'two-2222' })
  const a2 = await vault.putItem(u, 'login', 'mail.test', { username: 'work@corp.test', password: 'three-3333' })
  assert.notEqual(a.id, b.id)
  assert.equal(a2.id, a.id)
  assert.equal(a2.created, false)
  assert.equal((await vault.candidates(u, 'login', 'accounts.mail.test')).length, 2, 'parent domain matches')
  assert.equal((await vault.useItem(u, a.id)).password, 'three-3333')
  const actions = (await vault.listAudit(u)).map((r) => r.action).reverse()
  assert.deepEqual(actions, ['create', 'create', 'update', 'fill'])
})

test('cards are validated and kept apart by number', async () => {
  const u = newUser()
  await assert.rejects(vault.putItem(u, 'card', '', { number: '4242 4242 4242 4241', exp: '12/30', cvv: '123' }), /카드 번호/)
  await assert.rejects(vault.putItem(u, 'card', '', { number: '4242424242424242', exp: '01/20', cvv: '123' }), /만료/)
  await assert.rejects(vault.putItem(u, 'card', '', { number: '4242424242424242', exp: '12/30', cvv: '12' }), /CVV/)
  const visa = await vault.putItem(u, 'card', '', { number: '4242 4242 4242 4242', exp: '12/30', cvv: '123' })
  const mc = await vault.putItem(u, 'card', '', { number: '5555 5555 5555 4444', exp: '11/29', cvv: '321' })
  assert.equal(visa.label, 'Visa •••• 4242')
  assert.equal(mc.label, 'Mastercard •••• 4444')
  assert.equal((await vault.candidates(u, 'card', 'wallet')).length, 2)
})

test('a captured login is sealed at once but used only after the user confirms it', async () => {
  const u = newUser()
  const saved = await vault.putItem(u, 'login', 'shop.test', { username: 'choi', password: 'old-pass-1' })
  const same = await vault.putItem(u, 'login', 'shop.test', { username: 'choi', password: 'old-pass-1' }, { status: 'captured' })
  assert.equal(same.unchanged, true)
  const cap = await vault.putItem(u, 'login', 'shop.test', { username: 'choi', password: 'new-pass-2' }, { status: 'captured', actor: 'browser-agent' })
  assert.notEqual(cap.id, saved.id)
  const [row] = await q('select secret, status from pro_vault_items where id=$1', [cap.id])
  assert.equal(row.status, 'captured')
  assert.ok(!row.secret.includes('new-pass-2'))
  assert.deepEqual((await vault.candidates(u, 'login', 'shop.test')).map((r) => r.id), [saved.id], 'unconfirmed capture is not used')
  await vault.confirmItem(u, cap.id)
  const now = await vault.candidates(u, 'login', 'shop.test')
  assert.deepEqual(now.map((r) => r.id), [cap.id], 'confirmed capture replaces the old one')
  assert.equal((await vault.useItem(u, cap.id)).password, 'new-pass-2')
})

test('KEK rotation rewraps DEKs without touching item ciphertext; the old KEK can then be dropped', async () => {
  const u = newUser()
  const item = await vault.putItem(u, 'login', 'rotate.test', { username: 'jung', password: 'Rotate-Me-5' })
  const [before] = await q('select secret from pro_vault_items where id=$1', [item.id])
  const out = await vault.rotateKek({ userIds: users })
  assert.notEqual(out.kekId, kekId(kek0))
  assert.ok(out.rewrapped >= 1)
  const [key] = await q('select kek_id, wrapped_dek, dek_version from pro_vault_keys where user_id=$1', [u])
  const [afterRow] = await q('select secret from pro_vault_items where id=$1', [item.id])
  assert.equal(key.kek_id, out.kekId)
  assert.equal(afterRow.secret, before.secret, 'items untouched by KEK rotation')
  const kek1 = keyring().get(out.kekId)
  const dek = open(kek1, key.wrapped_dek, dekAad(u, key.dek_version))
  assert.throws(() => open(kek0, key.wrapped_dek, dekAad(u, key.dek_version)), 'old KEK no longer unwraps')
  assert.equal(JSON.parse(open(dek, afterRow.secret, `item:${u}:login:rotate.test`).toString()).password, 'Rotate-Me-5')
  const pruned = await vault.pruneKeks()
  assert.ok(pruned.removed.includes(kekId(kek0)))
  assert.ok(!keyring().has(kekId(kek0)))
})

test('DEK rotation re-encrypts every item under a new DEK version', async () => {
  const u = newUser()
  const a = await vault.putItem(u, 'login', 'dek.test', { username: 'han', password: 'Dek-Rotate-3' })
  const c = await vault.putItem(u, 'card', '', { number: '4242424242424242', exp: '12/30', cvv: '999' })
  const [k1] = await q('select * from pro_vault_keys where user_id=$1', [u])
  const before = await q('select id, secret from pro_vault_items where user_id=$1 order by id', [u])
  const out = await vault.rotateDek(u)
  assert.equal(out.items, 2)
  const [k2] = await q('select * from pro_vault_keys where user_id=$1', [u])
  const now = await q('select id, secret, dek_version from pro_vault_items where user_id=$1 order by id', [u])
  assert.equal(k2.dek_version, k1.dek_version + 1)
  now.forEach((r, i) => { assert.notEqual(r.secret, before[i].secret); assert.equal(r.dek_version, k2.dek_version) })
  const kek = keyring().get(k2.kek_id)
  const oldDek = open(keyring().get(k1.kek_id) || kek, k1.wrapped_dek, dekAad(u, k1.dek_version))
  const newDek = open(kek, k2.wrapped_dek, dekAad(u, k2.dek_version))
  assert.throws(() => open(oldDek, now[0].secret, `item:${u}:${now[0].id === a.id ? 'login:dek.test' : 'card:wallet'}`))
  assert.equal((await vault.useItem(u, a.id)).password, 'Dek-Rotate-3')
  assert.equal((await vault.useItem(u, c.id)).cvv, '999')
  assert.ok(newDek.length === 32)
  assert.ok((await vault.listAudit(u)).some((r) => r.action === 'rotate_dek'))
})
