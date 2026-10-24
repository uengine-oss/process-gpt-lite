// Envelope-encrypted vault.
//   KEK  (key-encryption key): 32 bytes held only by this server, outside the database — a 0600
//        keyring file or env. kek_id = sha256(KEK)[:12]. The keyring may hold retired KEKs so a
//        rotation can rewrap DEKs without downtime; DEKs found under a retired KEK are rewrapped
//        under the current one the next time they are opened.
//   DEK  (data-encryption key): 32 random bytes per user, stored only wrapped by a KEK.
//        dek_version is bumped when the DEK is replaced and every item re-encrypted.
//   item: AES-256-GCM under the user's DEK; AAD binds (user_id, kind, site) so a ciphertext copied
//        to another user, kind or site fails authentication.
// Plaintext secrets never leave the server; the UI and the model only ever see labels/masks.
import crypto from 'node:crypto'
import fs from 'node:fs'
import { config } from '../config.js'
import { q, pool } from './supa.js'

export const KINDS = ['login', 'card', 'apikey', 'oauth']
// fields that must never appear outside the ciphertext (usernames are labels, not secrets)
const SECRET_FIELDS = ['password', 'number', 'cvv', 'key', 'access_token', 'refresh_token']

export class VaultError extends Error {
  constructor(message, status = 400) { super(message); this.status = status }
}

// ---------- keyring (KEKs) ----------
const kekIdOf = (key) => crypto.createHash('sha256').update(key).digest('hex').slice(0, 12)

function loadKeyring() {
  const keys = new Map()
  if (config.vaultKek) {
    // env-sourced: nothing is written to disk; rotation is done by the operator (see rotateKek)
    for (const b64 of [config.vaultKek, ...config.vaultKekRetired]) {
      const key = Buffer.from(b64, 'base64')
      keys.set(kekIdOf(key), key)
    }
    return { source: 'env', current: kekIdOf(Buffer.from(config.vaultKek, 'base64')), keys }
  }
  if (!fs.existsSync(config.vaultKeyringFile)) {
    // first run, or upgrade from the single-key file: that key becomes version 1 of the keyring
    const legacy = fs.existsSync(config.vaultKekFile) && fs.readFileSync(config.vaultKekFile, 'utf8').trim()
    const key = legacy ? Buffer.from(legacy, 'base64') : crypto.randomBytes(32)
    writeKeyring({ current: kekIdOf(key), keys: [{ id: kekIdOf(key), key: key.toString('base64'), created_at: new Date().toISOString() }] })
  }
  const file = JSON.parse(fs.readFileSync(config.vaultKeyringFile, 'utf8'))
  for (const k of file.keys) keys.set(k.id, Buffer.from(k.key, 'base64'))
  return { source: 'file', current: file.current, keys, meta: file.keys.map(({ key, ...m }) => m) }
}

function writeKeyring(file) {
  const tmp = config.vaultKeyringFile + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, config.vaultKeyringFile)
}

let ring = loadKeyring()
if (ring.keys.get(ring.current)?.length !== 32) throw new Error('vault KEK must be 32 bytes (base64)')

// ---------- AES-256-GCM ----------
function seal(key, plaintext, aad) {
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', key, iv)
  c.setAAD(Buffer.from(aad))
  const ct = Buffer.concat([c.update(plaintext), c.final()])
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64')
}
function open(key, blob, aad) {
  const b = Buffer.from(blob, 'base64')
  const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12))
  d.setAAD(Buffer.from(aad))
  d.setAuthTag(b.subarray(12, 28))
  return Buffer.concat([d.update(b.subarray(28)), d.final()])
}

// ---------- DEKs ----------
// version 1 keeps the original AAD so DEKs wrapped before versioning still open
const dekAad = (userId, version) => (version > 1 ? `dek:${userId}:v${version}` : `dek:${userId}`)
const DEK_TTL_MS = 10 * 60 * 1000
const dekCache = new Map() // userId -> { dek, version, at }

function forget(userId) {
  const hit = dekCache.get(userId)
  if (hit) { hit.dek.fill(0); dekCache.delete(userId) }
}
setInterval(() => {
  for (const [userId, hit] of dekCache) if (Date.now() - hit.at > DEK_TTL_MS) forget(userId)
}, 60000).unref()

async function dekFor(userId) {
  const hit = dekCache.get(userId)
  if (hit && Date.now() - hit.at < DEK_TTL_MS) return hit
  forget(userId)
  let [row] = await q('select kek_id, wrapped_dek, dek_version from pro_vault_keys where user_id=$1', [userId])
  if (!row) {
    const fresh = crypto.randomBytes(32)
    await q('insert into pro_vault_keys(user_id,kek_id,wrapped_dek) values ($1,$2,$3) on conflict (user_id) do nothing',
      [userId, ring.current, seal(ring.keys.get(ring.current), fresh, dekAad(userId, 1))])
    fresh.fill(0)
    ;[row] = await q('select kek_id, wrapped_dek, dek_version from pro_vault_keys where user_id=$1', [userId])
  }
  const kek = ring.keys.get(row.kek_id)
  if (!kek) throw new VaultError(`vault KEK ${row.kek_id} is not in the keyring`, 500)
  const dek = open(kek, row.wrapped_dek, dekAad(userId, row.dek_version))
  if (row.kek_id !== ring.current) {
    await q('update pro_vault_keys set kek_id=$2, wrapped_dek=$3 where user_id=$1 and kek_id=$4',
      [userId, ring.current, seal(ring.keys.get(ring.current), dek, dekAad(userId, row.dek_version)), row.kek_id])
    await audit(userId, 'rotate_kek', { actor: 'admin', detail: { from: row.kek_id, to: ring.current, lazy: true } })
  }
  const entry = { dek, version: row.dek_version, at: Date.now() }
  dekCache.set(userId, entry)
  return entry
}

// ---------- items ----------
const aadOf = (userId, kind, site) => `item:${userId}:${kind}:${site}`
export const normSite = (s) => String(s || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0]
const digits = (s) => String(s || '').replace(/\D/g, '')

function identityOf(kind, data) {
  if (kind === 'login') return String(data.username || data.email || '').trim().toLowerCase()
  if (kind === 'card') return digits(data.number)
  return '' // apikey / oauth: one per site
}
// HMAC under a DEK-derived key: tells two accounts (or cards) apart without storing the identity
function fingerprintOf(dek, kind, data) {
  const k = Buffer.from(crypto.hkdfSync('sha256', dek, Buffer.alloc(0), 'pgpt-pro vault fingerprint', 32))
  return crypto.createHmac('sha256', k).update(`${kind}:${identityOf(kind, data)}`).digest('hex').slice(0, 32)
}

export function cardBrand(number) {
  const n = digits(number)
  if (/^4/.test(n)) return 'Visa'
  if (/^(5[1-5]|2(2[2-9]|[3-6]\d|7[01]|720))/.test(n)) return 'Mastercard'
  if (/^3[47]/.test(n)) return 'Amex'
  if (/^35/.test(n)) return 'JCB'
  if (/^62/.test(n)) return 'UnionPay'
  if (/^(6011|65)/.test(n)) return 'Discover'
  return '카드'
}
function luhn(n) {
  let sum = 0
  for (let i = 0; i < n.length; i++) {
    let d = Number(n[n.length - 1 - i])
    if (i % 2) { d *= 2; if (d > 9) d -= 9 }
    sum += d
  }
  return sum % 10 === 0
}

function validate(kind, site, data) {
  if (!KINDS.includes(kind)) throw new VaultError('지원하지 않는 보관함 항목이에요.')
  if (!data || typeof data !== 'object') throw new VaultError('저장할 내용이 없어요.')
  if (kind === 'login') {
    if (!site) throw new VaultError('사이트를 입력해 주세요.')
    if (!data.password) throw new VaultError('비밀번호를 입력해 주세요.')
  }
  if (kind === 'card') {
    const n = digits(data.number)
    if (n.length < 13 || n.length > 19 || !luhn(n)) throw new VaultError('카드 번호를 확인해 주세요.')
    const m = /^(\d{2})\/(\d{2})$/.exec(String(data.exp || ''))
    if (!m || +m[1] < 1 || +m[1] > 12) throw new VaultError('만료일을 MM/YY 형식으로 입력해 주세요.')
    if (new Date(2000 + +m[2], +m[1], 1) <= new Date()) throw new VaultError('만료된 카드예요.')
    if (!/^\d{3,4}$/.test(String(data.cvv || ''))) throw new VaultError('CVV를 확인해 주세요.')
  }
  if (kind === 'apikey' && !data.key) throw new VaultError('API 키를 입력해 주세요.')
}

function displayOf(kind, data) {
  if (kind === 'card') {
    const brand = cardBrand(data.number)
    const last4 = digits(data.number).slice(-4)
    return { label: `${brand} •••• ${last4}`, meta: { brand, last4 } }
  }
  if (kind === 'apikey') return { label: `${String(data.key || '').slice(0, 4)}…`, meta: {} }
  return { label: data.username || data.email || '', meta: {} }
}

export async function audit(userId, action, { item, kind, site, actor = 'user', taskId, detail } = {}) {
  await q(`insert into pro_vault_audit(user_id,item_id,kind,site,action,actor,task_id,detail) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [userId, item?.id || null, item?.kind || kind || null, item?.site || site || null, action, actor, taskId || null, detail || {}])
}

// Create, or update the same account (same site + username, same card number).
// status 'captured' = taken from a form the user typed into; kept sealed until they confirm it.
export async function putItem(userId, kind, site, data, { actor = 'user', taskId, status = null } = {}) {
  site = kind === 'card' ? 'wallet' : normSite(site)
  validate(kind, site, data)
  if (kind === 'card') data = { ...data, number: digits(data.number) }
  const { dek, version } = await dekFor(userId)
  const fp = fingerprintOf(dek, kind, data)
  const secret = seal(dek, Buffer.from(JSON.stringify(data)), aadOf(userId, kind, site))
  const { label, meta } = displayOf(kind, data)
  const find = (f) => q('select id, status, secret from pro_vault_items where user_id=$1 and kind=$2 and site=$3 and fingerprint=$4', [userId, kind, site, f]).then((r) => r[0])
  if (status === 'captured') {
    // typing what is already saved is not news; a different password is held beside the saved one
    // (fingerprint suffix) and replaces it only when the user confirms
    const saved = await find(fp)
    if (saved && !SECRET_FIELDS.some((f) => (data[f] ?? '') !== ((JSON.parse(open(dek, saved.secret, aadOf(userId, kind, site)).toString()))[f] ?? ''))) {
      return { id: saved.id, kind, site, label, status: saved.status, created: false, unchanged: true }
    }
  }
  const key = status === 'captured' ? `${fp}:captured` : fp
  let row = await find(key)
  const created = !row
  if (row) {
    await q(`update pro_vault_items set secret=$1,label=$2,meta=$3,status=$4,dek_version=$5,updated_at=now() where id=$6`,
      [secret, label, meta, status, version, row.id])
  } else {
    ;[row] = await q(`insert into pro_vault_items(user_id,kind,site,label,secret,fingerprint,meta,status,dek_version)
                      values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`, [userId, kind, site, label, secret, key, meta, status, version])
  }
  const item = { id: row.id, kind, site, label, status, created }
  await audit(userId, status === 'captured' ? 'capture' : created ? 'create' : 'update', { item, actor, taskId })
  return item
}

async function rowOf(userId, id) {
  const [row] = await q('select * from pro_vault_items where id=$1 and user_id=$2', [id, userId])
  if (!row) throw new VaultError('보관함 항목을 찾을 수 없어요.', 404)
  return row
}
async function decrypt(userId, row) {
  const { dek } = await dekFor(userId)
  return JSON.parse(open(dek, row.secret, aadOf(userId, row.kind, row.site)).toString())
}

// Change some fields (a new password after the site rejected the old one); clears the status.
export async function updateItem(userId, id, patch, { actor = 'user', taskId } = {}) {
  const row = await rowOf(userId, id)
  const data = { ...await decrypt(userId, row), ...Object.fromEntries(Object.entries(patch || {}).filter(([, v]) => v !== '' && v != null)) }
  validate(row.kind, row.site, data)
  const { dek, version } = await dekFor(userId)
  const fp = fingerprintOf(dek, row.kind, data)
  const [clash] = await q('select id from pro_vault_items where user_id=$1 and kind=$2 and site=$3 and fingerprint=$4 and id<>$5', [userId, row.kind, row.site, fp, id])
  if (clash) throw new VaultError('같은 계정이 이미 저장돼 있어요.', 409)
  const { label, meta } = displayOf(row.kind, data)
  await q(`update pro_vault_items set secret=$1,label=$2,meta=$3,fingerprint=$4,status=null,dek_version=$5,updated_at=now() where id=$6`,
    [seal(dek, Buffer.from(JSON.stringify(data)), aadOf(userId, row.kind, row.site)), label, meta, fp, version, id])
  const item = { id, kind: row.kind, site: row.site, label, status: null }
  await audit(userId, 'update', { item, actor, taskId })
  return item
}

// Saved items usable on a site: exact host first, then parent/child domains (accounts.google.com ↔ google.com).
export async function candidates(userId, kind, site) {
  site = kind === 'card' ? 'wallet' : normSite(site)
  const rows = await q(`select id, kind, site, label, status, meta, last_used_at from pro_vault_items
                        where user_id=$1 and kind=$2 and coalesce(status,'') <> 'captured'
                        order by last_used_at desc nulls last, updated_at desc`, [userId, kind])
  const exact = rows.filter((r) => r.site === site)
  return exact.length ? exact : rows.filter((r) => site.endsWith('.' + r.site) || r.site.endsWith('.' + site))
}

// Server-side only: the browser agent fills these straight into the page.
export async function useItem(userId, id, { actor = 'browser-agent', taskId, field } = {}) {
  const row = await rowOf(userId, id)
  const data = await decrypt(userId, row)
  await q('update pro_vault_items set last_used_at=now(), use_count=use_count+1 where id=$1', [id])
  await audit(userId, 'fill', { item: row, actor, taskId, detail: field ? { field } : {} })
  return data
}

// Server-side only: used by the mail poller and connectors (one item per site).
export async function getSecret(userId, kind, site) {
  const [row] = await candidates(userId, kind, site)
  if (!row) return null
  return { id: row.id, site: row.site, ...await decrypt(userId, await rowOf(userId, row.id)) }
}

export async function listItems(userId) {
  return q(`select id, kind, site, label, status, meta, last_used_at, use_count, created_at, updated_at
            from pro_vault_items where user_id=$1 order by kind, site, updated_at desc`, [userId])
}

export async function setStatus(userId, id, status, { actor = 'browser-agent', taskId, detail } = {}) {
  const row = await rowOf(userId, id)
  await q('update pro_vault_items set status=$1 where id=$2', [status, id])
  if (status === 'rejected') await audit(userId, 'reject', { item: row, actor, taskId, detail })
}

export async function confirmItem(userId, id) {
  const row = await rowOf(userId, id)
  if (row.status !== 'captured') return
  // the same account may already be saved: the confirmed capture replaces it
  const fp = row.fingerprint.replace(/:captured$/, '')
  const [old] = await q('delete from pro_vault_items where user_id=$1 and kind=$2 and site=$3 and fingerprint=$4 returning id', [userId, row.kind, row.site, fp])
  await q('update pro_vault_items set status=null, fingerprint=$2, updated_at=now() where id=$1', [id, fp])
  await audit(userId, 'confirm', { item: row, detail: old ? { replaced: old.id } : {} })
}

export async function deleteItem(userId, id, { actor = 'user' } = {}) {
  const row = await rowOf(userId, id)
  await q('delete from pro_vault_items where id=$1', [id])
  await audit(userId, row.status === 'captured' ? 'discard' : 'delete', { item: row, actor })
}

export const listAudit = (userId, limit = 50) =>
  q(`select id, item_id, kind, site, action, actor, task_id, detail, created_at from pro_vault_audit
     where user_id=$1 order by created_at desc limit $2`, [userId, Math.min(Number(limit) || 50, 200)])

// ---------- proof: what is stored, and that it behaves like envelope encryption ----------
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')

export async function proof(userId) {
  const { dek, version } = await dekFor(userId)
  const [key] = await q('select kek_id, wrapped_dek, dek_version, created_at, rotated_at from pro_vault_keys where user_id=$1', [userId])
  const wrapped = Buffer.from(key.wrapped_dek, 'base64')
  const rows = await q('select * from pro_vault_items where user_id=$1 order by kind, site', [userId])
  const fails = (fn) => { try { fn(); return false } catch { return true } }
  const items = rows.map((r) => {
    const aad = aadOf(userId, r.kind, r.site)
    const blob = Buffer.from(r.secret, 'base64')
    let data = null
    try { data = JSON.parse(open(dek, r.secret, aad).toString()) } catch { /* reported below */ }
    const flipped = Buffer.from(blob); flipped[flipped.length - 1] ^= 1
    const values = data ? SECRET_FIELDS.map((f) => data[f]).filter((v) => typeof v === 'string' && v.length >= 3) : []
    const stored = JSON.stringify(r)
    return {
      id: r.id, kind: r.kind, site: r.site, label: r.label, status: r.status, dek_version: r.dek_version,
      ciphertext: { bytes: blob.length, iv: blob.subarray(0, 12).toString('hex'), sha256: sha(blob).slice(0, 16) },
      aad,
      fields: data ? Object.keys(data) : [],
      checks: {
        decrypts_with_user_dek: !!data,
        rejects_other_site: fails(() => open(dek, r.secret, aadOf(userId, r.kind, r.site + '.other'))),
        rejects_other_user: fails(() => open(dek, r.secret, aadOf(crypto.randomUUID(), r.kind, r.site))),
        rejects_tampering: fails(() => open(dek, flipped.toString('base64'), aad)),
        rejects_kek_as_dek: fails(() => open(ring.keys.get(ring.current), r.secret, aad)),
        no_plaintext_in_row: values.every((v) => !stored.includes(v) && !stored.includes(Buffer.from(v).toString('base64'))),
      },
    }
  })
  return {
    algorithm: 'AES-256-GCM envelope (KEK → per-user DEK → item)',
    kek: { id: key.kek_id, current: ring.current, in_keyring: ring.keys.has(key.kek_id), source: ring.source, versions: ring.keys.size, stored_in_database: false },
    dek: { version: key.dek_version, wrapped_bytes: wrapped.length, wrapped_sha256: sha(wrapped).slice(0, 16), aad: dekAad(userId, version), unwraps_with_kek: true, created_at: key.created_at, rotated_at: key.rotated_at },
    items,
    ok: items.every((i) => Object.values(i.checks).every(Boolean)),
  }
}

// ---------- key management (scripts/vault-admin.mjs) ----------
// New KEK becomes current; every DEK (or only those of userIds) is rewrapped. Items are untouched.
export async function rotateKek({ userIds } = {}) {
  if (ring.source !== 'file') {
    throw new VaultError('KEK comes from PRO_VAULT_KEK: set it to the new key, move the old one into PRO_VAULT_KEK_RETIRED, restart, then run "rewrap".', 409)
  }
  const key = crypto.randomBytes(32)
  const file = JSON.parse(fs.readFileSync(config.vaultKeyringFile, 'utf8'))
  file.keys.push({ id: kekIdOf(key), key: key.toString('base64'), created_at: new Date().toISOString() })
  file.current = kekIdOf(key)
  writeKeyring(file)
  ring = loadKeyring()
  return { kekId: ring.current, ...await rewrap({ userIds }) }
}

export async function rewrap({ userIds } = {}) {
  const rows = await q(`select user_id, kek_id from pro_vault_keys where kek_id <> $1 ${userIds ? 'and user_id = any($2)' : ''}`,
    userIds ? [ring.current, userIds] : [ring.current])
  for (const r of rows) { forget(r.user_id); await dekFor(r.user_id) } // dekFor rewraps under the current KEK
  return { rewrapped: rows.length }
}

// Drop retired KEKs no DEK refers to any more.
export async function pruneKeks() {
  if (ring.source !== 'file') throw new VaultError('env-sourced keyring: remove the key from PRO_VAULT_KEK_RETIRED instead', 409)
  const used = new Set((await q('select distinct kek_id from pro_vault_keys')).map((r) => r.kek_id))
  const file = JSON.parse(fs.readFileSync(config.vaultKeyringFile, 'utf8'))
  const removed = file.keys.filter((k) => k.id !== file.current && !used.has(k.id)).map((k) => k.id)
  file.keys = file.keys.filter((k) => !removed.includes(k.id))
  writeKeyring(file)
  ring = loadKeyring()
  return { removed, kept: file.keys.map((k) => k.id) }
}

// Replace a user's DEK and re-encrypt all their items in one transaction.
export async function rotateDek(userId) {
  await dekFor(userId) // make sure a DEK exists and sits under the current KEK
  const db = await pool.connect()
  let count = 0
  try {
    await db.query('begin')
    const { rows: [k] } = await db.query('select kek_id, wrapped_dek, dek_version from pro_vault_keys where user_id=$1 for update', [userId])
    const old = open(ring.keys.get(k.kek_id), k.wrapped_dek, dekAad(userId, k.dek_version))
    const next = crypto.randomBytes(32)
    const version = k.dek_version + 1
    const { rows } = await db.query('select id, kind, site, secret, fingerprint from pro_vault_items where user_id=$1 for update', [userId])
    for (const r of rows) {
      const aad = aadOf(userId, r.kind, r.site)
      const data = JSON.parse(open(old, r.secret, aad).toString())
      const fp = fingerprintOf(next, r.kind, data) + (r.fingerprint?.endsWith(':captured') ? ':captured' : '')
      await db.query('update pro_vault_items set secret=$1, fingerprint=$2, dek_version=$3 where id=$4',
        [seal(next, Buffer.from(JSON.stringify(data)), aad), fp, version, r.id])
      count++
    }
    await db.query('update pro_vault_keys set kek_id=$2, wrapped_dek=$3, dek_version=$4, rotated_at=now() where user_id=$1',
      [userId, ring.current, seal(ring.keys.get(ring.current), next, dekAad(userId, version)), version])
    await db.query('commit')
    old.fill(0); next.fill(0)
  } catch (e) {
    await db.query('rollback')
    throw e
  } finally {
    db.release()
    forget(userId)
  }
  await audit(userId, 'rotate_dek', { actor: 'admin', detail: { items: count } })
  return { userId, items: count }
}

// Open every item of every user; back-fills fingerprint/meta on rows written before vault v2.
export async function verifyAll() {
  const users = (await q('select user_id, kek_id from pro_vault_keys')).map((r) => r.user_id)
  const out = { users: users.length, items: 0, ok: 0, failed: [], backfilled: 0, kek_ids: {} }
  for (const userId of users) {
    let dek
    try { ({ dek } = await dekFor(userId)) } catch (e) { out.failed.push({ userId, error: e.message }); continue }
    for (const r of await q('select * from pro_vault_items where user_id=$1', [userId])) {
      out.items++
      try {
        const data = JSON.parse(open(dek, r.secret, aadOf(userId, r.kind, r.site)).toString())
        out.ok++
        if (!r.fingerprint) {
          const { label, meta } = displayOf(r.kind, data)
          await q('update pro_vault_items set fingerprint=$1, label=$2, meta=$3 where id=$4', [fingerprintOf(dek, r.kind, data), label, meta, r.id])
          out.backfilled++
        }
      } catch (e) { out.failed.push({ id: r.id, error: e.message }) }
    }
  }
  for (const r of await q('select kek_id, count(*)::int n from pro_vault_keys group by kek_id')) out.kek_ids[r.kek_id] = r.n
  return out
}

export const vaultInfo = () => ({
  kekId: ring.current, provider: ring.source, keyVersions: ring.keys.size,
  algorithm: 'AES-256-GCM envelope (KEK → per-user DEK → item)',
})
