// A short-lived signed address of one share for one person: the messenger's picture · sound · video previews and the viewer's
// 「새 창에서 열기」 load the file from GET /api/team/shares/:id/raw without the sign-in token in the address (an <img> or an
// <audio> sends no header, and an address with the token in it ends up in proxy logs and the browser's history — 2026-11-25).
//   /team/shares/<id>/raw?u=<person>&exp=<unix seconds>[&inline=1]&sig=<base64url HMAC-SHA256>
// The signature covers the tenant, the share, the person, the expiry and the inline flag, under a key only the server holds
// (derived from its service key with a fixed label — the service key itself never leaves the server). A valid signature only
// says who is asking: the route still checks that person against the share (revoked, not theirs → 404) as for a signed-in call.
// Pure (no config, no database): server/test/mediaLink.test.js.
import crypto from 'node:crypto'

export const LINK_TTL_S = 15 * 60
// expiries fall on 5-minute marks, so the address of a file stays the same for a while (the browser's cache keeps the picture)
const STEP_S = 5 * 60
// nothing signed here lives longer than this (an expiry further out is not one of ours)
const MAX_AHEAD_S = LINK_TTL_S + STEP_S + 60
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** the signing key: HMAC of a fixed label under the server's secret (never the secret itself) */
export function linkKey(secret) {
  if (!secret) throw new Error('no secret to sign media links with')
  return crypto.createHmac('sha256', String(secret)).update('pgpt-lite/team-share-media-link/v1').digest()
}

const payload = ({ tenant, id, userId, exp, inline }) => ['v1', String(tenant || ''), String(id).toLowerCase(), String(userId).toLowerCase(), String(exp), inline ? '1' : '0'].join('|')
const mac = (key, p) => crypto.createHmac('sha256', key).update(p).digest()

/** → {u, exp, sig, inline} for share `id` read by `userId` */
export function signLink({ key, tenant, id, userId, inline = false, now = Date.now(), exp }) {
  if (!UUID.test(String(id)) || !UUID.test(String(userId))) throw new Error('a share and a person (ids) are needed')
  const e = exp ?? Math.ceil((Math.floor(now / 1000) + LINK_TTL_S) / STEP_S) * STEP_S
  return { u: String(userId).toLowerCase(), exp: e, sig: mac(key, payload({ tenant, id, userId, exp: e, inline })).toString('base64url'), inline: !!inline }
}

/** the address under /api for a signed link */
export const linkPath = (id, { u, exp, sig, inline }) =>
  `/team/shares/${encodeURIComponent(id)}/raw?u=${encodeURIComponent(u)}&exp=${exp}${inline ? '&inline=1' : ''}&sig=${encodeURIComponent(sig)}`

/** 'ok' | 'expired' | 'bad' — the signature first (an altered link is 'bad' whatever its expiry), compared in constant time */
export function verifyLink({ key, tenant, id, u, exp, sig, inline = false, now = Date.now() }) {
  const e = String(exp ?? '')
  if (!UUID.test(String(id || '')) || !UUID.test(String(u || '')) || !/^\d{1,12}$/.test(e) || !/^[A-Za-z0-9_-]{43}$/.test(String(sig || ''))) return 'bad'
  const want = mac(key, payload({ tenant, id, userId: u, exp: e, inline }))
  const got = Buffer.from(String(sig), 'base64url')
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return 'bad'
  const t = Math.floor(now / 1000)
  if (Number(e) > t + MAX_AHEAD_S) return 'bad'
  return Number(e) <= t ? 'expired' : 'ok'
}

/** the expiry (unix seconds) of a signed address, or 0 */
export const linkExpiry = (path) => Number(/[?&]exp=(\d+)/.exec(String(path || ''))?.[1] || 0)
