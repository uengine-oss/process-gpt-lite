// Which Google OAuth client a company's Google connection uses (2026-11-22 decision ①).
//   1. the company's own, saved by one of its administrators in Settings › 시스템 설정 (Client ID and
//      Client secret; the secret is write-only and never shown again)
//   2. this install's GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET (an installed Lite's default)
// Behind the ProcessGPT gateway one server serves every company and production has no env client, so
// each company brings its own client and registers its own address with it.
//
// Where it is kept: the vault (lib/vault.js), envelope-encrypted like a person's items, under a vault
// subject that stands for the company — a UUID derived from the tenant id. pro_vault_keys and
// pro_vault_items key their rows by a bare uuid (no foreign key to auth.users, RLS without policies: the
// server writes over its own database connection), so a company subject needs no new table or SQL. The
// subject's DEK is its own, and the item's AAD binds the subject, kind and site like any other.
import crypto from 'node:crypto'
import { config } from '../config.js'
import { putItem, getSecret, candidates, deleteItem, VaultError } from './vault.js'
import { L } from './lang.js'

const KIND = 'oauth'
const SITE = 'google-oauth-client'

// The company's vault subject: a name-based UUID (RFC 4122 v5 layout) of the tenant id. Never a
// person's id: those are GoTrue's random v4 UUIDs, and nobody signs in as this one.
export function companySubject(tenant) {
  const h = crypto.createHash('sha1').update(`pgpt-lite:company:${String(tenant)}`).digest()
  h[6] = (h[6] & 0x0f) | 0x50
  h[8] = (h[8] & 0x3f) | 0x80
  const x = h.subarray(0, 16).toString('hex')
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`
}

// read on every /api/config, so kept for a little while; a save or a removal here forgets it at once
// (one server: behind the gateway Lite runs as a single pod)
const TTL_MS = 30_000
const cache = new Map() // tenant -> { at, value }
const loading = new Map() // tenant -> { gen, read } in progress
const generations = new Map() // tenant -> n
const genOf = (k) => generations.get(k) || 0
// (a read begun before a save must not put the old value back: it is of an older generation — per tenant, so
// one company's save does not keep another's read out of the cache)
const forget = (tenant) => { const k = String(tenant); cache.delete(k); loading.delete(k); generations.set(k, genOf(k) + 1) }

function load(tenant) {
  const k = String(tenant)
  if (!loading.has(k)) {
    const gen = genOf(k)
    const read = getSecret(companySubject(tenant), KIND, SITE)
      .then((sec) => {
        const value = sec?.client_id && sec?.client_secret
          ? { clientId: sec.client_id, clientSecret: sec.client_secret, source: 'company', savedAt: sec.saved_at || null } : null
        if (gen === genOf(k)) cache.set(k, { at: Date.now(), value })
        return value
      })
      .finally(() => { if (loading.get(k)?.read === read) loading.delete(k) })
    loading.set(k, { gen, read })
  }
  return loading.get(k).read
}
// an answer that has gone stale is given at once and read again behind it (GET /api/config is the
// pod's readiness and liveness probe: it must not wait on the database each time)
async function companyClient(tenant) {
  const hit = cache.get(String(tenant))
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value
  if (hit) { load(tenant).catch((e) => console.warn('[google client]', e.message)); return hit.value }
  return load(tenant).catch((e) => { console.warn('[google client]', e.message); return null })
}

const envClient = () => (config.google.clientId && config.google.clientSecret
  ? { clientId: config.google.clientId, clientSecret: config.google.clientSecret, source: 'env' } : null)

// The client a tenant's Google connection uses now: the company's, else this install's, else null.
export async function clientFor(tenant = config.tenantId) {
  return (await companyClient(tenant)) || envClient()
}

// The client that issued a saved token (its id is kept with the token): refreshing it needs that one.
// A token from before ids were kept came from this install's client (the only one there was).
export async function clientById(tenant, clientId) {
  const company = await companyClient(tenant)
  const env = envClient()
  if (!clientId) return env || company
  return [company, env].find((c) => c?.clientId === clientId) || null
}

// What the admin screen shows: never the secret.
export async function clientInfo(tenant = config.tenantId) {
  const company = await companyClient(tenant)
  return {
    company: company ? { clientId: company.clientId, savedAt: company.savedAt } : null,
    env: !!envClient(),
    using: company ? 'company' : envClient() ? 'env' : null,
  }
}

const clean = (v) => String(v ?? '').trim()
// a pasted value with a space or line break in it is a copy mistake, not a client id or secret
const oneWord = (v) => v.length > 0 && v.length <= 512 && !/\s/.test(v)

// Saves the company's client (by: the administrator, for the audit trail). Leaving the secret empty
// keeps the one saved before (changing only the id).
export async function saveClient(tenant, { clientId, clientSecret } = {}, by = null) {
  const id = clean(clientId)
  let secret = clean(clientSecret)
  if (!oneWord(id)) throw new VaultError(L('Client ID를 확인해 주세요.', 'Please check the Client ID.'))
  // (no new secret: the saved one is kept only for the same Client ID — a secret belongs to one client)
  if (!secret) {
    const prev = await getSecret(companySubject(tenant), KIND, SITE)
    if (prev?.client_id && prev.client_id !== id) throw new VaultError(L('Client ID를 바꾸면 그 클라이언트의 Client secret도 함께 넣어 주세요.', 'A new Client ID needs its own Client secret too.'))
    secret = prev?.client_secret || ''
  }
  if (!oneWord(secret)) throw new VaultError(L('Client secret을 넣어 주세요.', 'Please enter the Client secret.'))
  await putItem(companySubject(tenant), KIND, SITE, { username: id, client_id: id, client_secret: secret, saved_at: new Date().toISOString() },
    { actor: 'admin', detail: { tenant: String(tenant), by } })
  // one client per company: a previous one (another Client ID) goes, its secret with it — connections made
  // with it have to be made again (the admin screen says so)
  const subject = companySubject(tenant)
  for (const row of await candidates(subject, KIND, SITE)) if (row.username && row.username !== id) await deleteItem(subject, row.id, { actor: 'admin', detail: { tenant: String(tenant), by, replaced: row.username } })
  forget(tenant)
  return clientInfo(tenant)
}

export async function removeClient(tenant, by = null) {
  const subject = companySubject(tenant)
  for (const row of await candidates(subject, KIND, SITE)) await deleteItem(subject, row.id, { actor: 'admin', detail: { tenant: String(tenant), by } })
  forget(tenant)
  return clientInfo(tenant)
}
