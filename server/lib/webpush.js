// Web Push: a Home card reaches a phone or a PC even when Lite is closed (2026-11-18: "웹앱으로 설치했을 때도
// 노티가 들어오면 아이콘에 숫자가 나오면 좋겠다" — Android's launcher counts the notifications an installed web
// app has shown). The browser gives a subscription (its push service endpoint + keys, src/browserNotify.js),
// kept in pro_push_subscriptions; a new notifications row (lib/notify.js feedOnce) is sent to each of the
// person's subscriptions; the service worker (public/sw.js) shows it and sets the badge.
// Built on node:crypto, no package: the message encryption of RFC 8291 (aes128gcm, RFC 8188) and the
// VAPID signature of RFC 8292. The server's VAPID key pair is made on first start and kept next to the
// vault keyring (production: the PVC, /data/vapid.json), or given as PRO_VAPID_PUBLIC_KEY/PRIVATE_KEY.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { config } from '../config.js'
import { q } from './supa.js'

const b64u = (buf) => Buffer.from(buf).toString('base64url')
const unb64u = (s) => Buffer.from(String(s || ''), 'base64url')

// ---- the server's identity (VAPID) ----
let keys = null
export function vapidKeys() {
  if (keys) return keys
  if (process.env.PRO_VAPID_PUBLIC_KEY && process.env.PRO_VAPID_PRIVATE_KEY) {
    keys = { publicKey: process.env.PRO_VAPID_PUBLIC_KEY, privateKey: process.env.PRO_VAPID_PRIVATE_KEY }
    return keys
  }
  const file = process.env.PRO_VAPID_FILE || path.join(path.dirname(config.vaultKeyringFile), 'vapid.json')
  try { keys = JSON.parse(fs.readFileSync(file, 'utf8')); if (keys.publicKey && keys.privateKey) return keys } catch { /* made below */ }
  const e = crypto.createECDH('prime256v1'); e.generateKeys()
  keys = { publicKey: b64u(e.getPublicKey()), privateKey: b64u(pad32(e.getPrivateKey())), createdAt: new Date().toISOString() }
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(keys), { mode: 0o600 }) } catch (err) {
    console.warn('[push] VAPID keys could not be saved — they change on restart and old subscriptions stop:', err.message)
  }
  return keys
}
const pad32 = (b) => (b.length >= 32 ? b : Buffer.concat([Buffer.alloc(32 - b.length), b]))

// the private key as a signing key (a JWK needs x and y: from the public point)
function signingKey(k = vapidKeys()) {
  const pub = unb64u(k.publicKey)
  return crypto.createPrivateKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', d: k.privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) } })
}

// Authorization: vapid t=<JWT ES256 for the push service's origin>, k=<public key> (RFC 8292)
export function vapidAuth(endpoint, { k = vapidKeys(), now = Date.now(), subject } = {}) {
  const aud = new URL(endpoint).origin
  const sub = subject || process.env.PRO_VAPID_SUBJECT || (String(config.publicUrl || '').startsWith('https:') ? config.publicUrl : 'mailto:noreply@process-gpt.io')
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }))
  const body = b64u(JSON.stringify({ aud, exp: Math.floor(now / 1000) + 12 * 3600, sub }))
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${body}`), { key: signingKey(k), dsaEncoding: 'ieee-p1363' })
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${k.publicKey}`
}

// ---- the message (RFC 8291 §3.4 and RFC 8188, one record) ----
// salt and asPrivate only for the RFC's own example (test); otherwise fresh each message
export function encrypt(plaintext, { p256dh, auth }, { salt = crypto.randomBytes(16), asPrivate = null } = {}) {
  const uaPublic = unb64u(p256dh), authSecret = unb64u(auth)
  const as = crypto.createECDH('prime256v1')
  if (asPrivate) as.setPrivateKey(unb64u(asPrivate)); else as.generateKeys()
  const asPublic = as.getPublicKey()
  const ecdhSecret = as.computeSecret(uaPublic)
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic])
  const ikm = Buffer.from(crypto.hkdfSync('sha256', ecdhSecret, authSecret, keyInfo, 32))
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16))
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12))
  const c = crypto.createCipheriv('aes-128-gcm', cek, nonce)
  const ct = Buffer.concat([c.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([2])])), c.final(), c.getAuthTag()])
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096)
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, ct])
}

// ---- subscriptions ----
export async function subscribe(me, sub, ua = '') {
  const endpoint = String(sub?.endpoint || '')
  const p256dh = sub?.keys?.p256dh, auth = sub?.keys?.auth
  if (!/^https:\/\//.test(endpoint) || !p256dh || !auth) throw Object.assign(new Error('bad subscription'), { status: 400 })
  await q(`insert into pro_push_subscriptions(endpoint, user_id, tenant_id, p256dh, auth, ua) values ($1,$2,$3,$4,$5,$6)
           on conflict (endpoint) do update set user_id=excluded.user_id, tenant_id=excluded.tenant_id, p256dh=excluded.p256dh, auth=excluded.auth, ua=excluded.ua, fails=0`,
  [endpoint, me.id, config.tenantId, p256dh, auth, String(ua).slice(0, 200)])
  return { ok: true }
}
export async function unsubscribe(me, endpoint) {
  await q('delete from pro_push_subscriptions where endpoint=$1 and user_id=$2', [String(endpoint || ''), me.id])
  return { ok: true }
}

export const stats = { sent: 0, gone: 0, failed: 0, lastError: null }
async function sendOne(s, payload) {
  const body = encrypt(JSON.stringify(payload), s)
  const r = await fetch(s.endpoint, {
    method: 'POST', signal: AbortSignal.timeout(10000), body,
    headers: { TTL: '86400', Urgency: 'high', 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', Authorization: vapidAuth(s.endpoint) },
  })
  if (r.status === 404 || r.status === 410) { stats.gone++; await q('delete from pro_push_subscriptions where endpoint=$1', [s.endpoint]); return }
  if (!r.ok) { stats.failed++; stats.lastError = `${r.status} ${(await r.text().catch(() => '')).slice(0, 160)}`; await q('update pro_push_subscriptions set fails=fails+1 where endpoint=$1', [s.endpoint]); return }
  stats.sent++
  await q('update pro_push_subscriptions set last_ok_at=now(), fails=0 where endpoint=$1', [s.endpoint])
}

// one Home card to every device of the person (a table that is not there yet: nothing, quietly)
export async function pushTo(userId, payload) {
  const subs = await q('select * from pro_push_subscriptions where user_id=$1 and tenant_id=$2 and fails < 10', [userId, config.tenantId]).catch(() => [])
  for (const s of subs) await sendOne(s, payload).catch((e) => { stats.failed++; stats.lastError = e.message })
  return subs.length
}
