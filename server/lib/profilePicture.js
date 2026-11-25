// A person's picture (2026-11-25 「내 프로필 사진 어떻게 바꾸냐? Process GPT 버전과 일관성고려하여」): one field, users.profile —
// the row of process-gpt's users table that Process GPT's own account settings write — so a picture set in either app shows in both.
// What may be saved there from Lite, and what of a stored value Lite shows; no database, no network here (routes/profilePicture.js).
//
// Saved (checkPicture): one of Process GPT's preset pictures (the same root path its account settings save,
// src/components/pages/account-settings/profileImage.ts), a picture this person uploaded to this install's storage
// (files bucket, their own pgpt-pro/<id>/avatar/ folder), or nothing. Anything else — another site's address (a tracking pixel),
// someone else's upload, a data: URL, another bucket — is refused.
// Shown (shownPicture): what is stored, from whichever app, when it is a picture on this origin, in this install's storage or on
// an avatar host (Google's); Process GPT's column default (/images/defaultUser.png, its "no picture") and anything else show the
// initial instead.
//
// The Google picture (2026-11-25 「프로필 사진은 기본적으로 social login 인 경우는 구글에 설정된 이미지가 나오는게」): someone signed in
// with Google has their Google account's picture as the default. It is read only from what the auth server or this server wrote —
// the Google identity's data (GoTrue, ProcessGPT's Supabase Google sign-in) or app_metadata.google_picture (Lite's own Google
// sign-in) — never from user_metadata, which the person can write themselves, and only on an avatar host (PRO_AVATAR_HOSTS,
// https *.googleusercontent.com). The order: an explicit choice in users.profile, else the Google picture, else the initial.
// The Google picture also fills an empty users.profile (as Process GPT's own social sign-up did), and while users.profile holds a
// Google address it follows the account's current one — Lite never takes a Google address as a choice (checkPicture), so one
// there is always "the Google default". Clearing a choice writes that default back (defaultValue).

// Process GPT's 18 presets, in its order (Lite keeps copies in public/assets/images/profile/ for an install without Process GPT)
export const PRESET_DIR = '/assets/images/profile/'
export const PRESETS = [
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `${PRESET_DIR}${n}.jpg`),
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => `${PRESET_DIR}user-${n}.jpg`),
]
const PRESET_SET = new Set(PRESETS)
// users.profile's column default in process-gpt (init.sql): an account nobody gave a picture
export const NO_PICTURE = '/images/defaultUser.png'
// an upload: what the browser makes (a 256 px square) is far under this
export const MAX_UPLOAD = 1024 * 1024
export const UPLOAD_TYPES = { 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/png': 'png' }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const bad = (message) => Object.assign(new Error(message), { status: 400 })
const trimBase = (u) => String(u || '').replace(/\/+$/, '')
// public objects of this install's storage: <supabase>/storage/v1/object/public/<bucket>/<key>
export const publicBase = (supabaseUrl) => `${trimBase(supabaseUrl)}/storage/v1/object/public/`
// the storage key of a person's uploaded pictures (the files bucket; the prefix every other file of theirs has)
export const uploadPrefix = (userId) => `pgpt-pro/${userId}/avatar/`
export const uploadUrl = (supabaseUrl, key) => `${publicBase(supabaseUrl)}files/${key}`

// nothing in it that could end the attribute, start a query or a fragment, or climb out of the folder
const plain = (s) => !/[\s"'<>\\?#]|\.\.|%2e/i.test(s)

// Avatar hosts (PRO_AVATAR_HOSTS, comma-separated): `*.example.com` (https, any subdomain of it or itself), `host.example.com`
// (https, that host), or an origin `https://host[:port]` — `http://` only for this machine (127.0.0.1 · localhost: tests' stand-in host)
export const DEFAULT_AVATAR_HOSTS = '*.googleusercontent.com'
const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])$/
export function parseAvatarHosts(spec = DEFAULT_AVATAR_HOSTS) {
  return String(spec ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean).flatMap((e) => {
    if (/^https?:\/\//.test(e)) {
      let u
      try { u = new URL(e) } catch { return [] }
      if (u.protocol === 'http:' && !LOOPBACK.test(u.hostname)) return []
      return [{ origin: u.origin }]
    }
    const m = /^(\*\.)?([a-z0-9-]+(\.[a-z0-9-]+)+)$/.exec(e)
    return m ? [{ host: m[2], sub: !!m[1] }] : []
  })
}
const hostsOf = (o) => (Array.isArray(o?.avatarHosts) ? o.avatarHosts : parseAvatarHosts(o?.avatarHosts ?? DEFAULT_AVATAR_HOSTS))
// a picture on one of the avatar hosts: an absolute address, no credentials, nothing that could break out of the attribute
export function onAvatarHost(v, opts = {}) {
  if (typeof v !== 'string' || v.length > 2000 || /[\s"'<>\\]/.test(v)) return false
  let u
  try { u = new URL(v) } catch { return false }
  if (u.username || u.password || !/^https?:$/.test(u.protocol) || !/^https?:\/\//i.test(v)) return false
  return hostsOf(opts).some((h) => (h.origin ? u.origin === h.origin
    : u.protocol === 'https:' && (u.hostname === h.host || (h.sub && u.hostname.endsWith(`.${h.host}`)))))
}

// the Google account's picture of an auth user (supabase-js User: identities, app_metadata), when it is on an avatar host
export function googlePictureOf(authUser, opts = {}) {
  const id = (authUser?.identities || []).find((i) => i?.provider === 'google')?.identity_data || {}
  for (const v of [id.picture, id.avatar_url, authUser?.app_metadata?.google_picture]) if (onAvatarHost(v, opts)) return v
  return null
}
// nothing chosen: no value, or Process GPT's "no picture"
export const unset = (stored) => typeof stored !== 'string' || !stored.trim() || stored.trim() === NO_PICTURE
// what to write to users.profile on sign-in, or null for nothing: the Google picture fills an empty field and follows the account
// while the field holds a Google address; a choice (a preset, an upload, anything else) is never touched
export function seedValue(stored, google, opts = {}) {
  if (!google) return null
  if (unset(stored)) return google
  return onAvatarHost(stored.trim(), opts) && stored.trim() !== google ? google : null
}
// what clearing the choice writes: the Google picture for someone who has one, else the column's default (null)
export const defaultValue = (google) => google || null
// the picture the screens show: the stored one, else the Google one, else none (the initial)
export const resolvePicture = (stored, google, opts = {}) => shownPicture(stored, opts) || google || null

// what a person may save as their own picture → the value to store (null = no picture), or throws {status: 400}
export function checkPicture(value, { userId, supabaseUrl }) {
  if (value == null) return null
  if (typeof value !== 'string') throw bad('picture')
  const v = value.trim()
  if (!v) return null
  if (v.length > 600) throw bad('picture')
  if (PRESET_SET.has(v)) return v
  if (!UUID.test(String(userId || '')) || !/^https?:\/\/[^/]/.test(String(supabaseUrl || ''))) throw bad('picture')
  // exactly <this install's storage>/files/pgpt-pro/<this person>/avatar/<name>.<jpg|webp|png> — the name is all that may vary
  const mine = uploadUrl(supabaseUrl, uploadPrefix(String(userId).toLowerCase()))
  if (!v.startsWith(mine) || !/^[A-Za-z0-9_-]{1,80}\.(jpg|jpeg|webp|png)$/.test(v.slice(mine.length))) throw bad('picture')
  return v
}

// the storage key of an uploaded picture of this person (for removing it once nothing shows it), else null
export function ownUploadKey(value, { userId, supabaseUrl }) {
  try { checkPicture(value, { userId, supabaseUrl }) } catch { return null }
  if (!value || PRESET_SET.has(value)) return null
  return value.slice(`${publicBase(supabaseUrl)}files/`.length)
}

// a stored users.profile (written by Lite, Process GPT or anything else) → the picture Lite shows, or null for the initial
export function shownPicture(stored, opts = {}) {
  const { supabaseUrl } = opts
  if (typeof stored !== 'string') return null
  const v = stored.trim()
  if (!v || v === NO_PICTURE || v.length > 2000) return null
  if (PRESET_SET.has(v)) return v
  // an image on this origin (Process GPT's own /images/… and /assets/images/…): same site, nothing third-party
  if (/^\/(assets\/)?images\/[A-Za-z0-9_\-/.]+\.(png|jpe?g|webp|gif)$/i.test(v) && !v.includes('..') && !v.includes('//')) return v
  // a public object of this install's storage (any bucket: Process GPT's chat images too)
  const base = supabaseUrl ? publicBase(supabaseUrl) : ''
  if (base && v.startsWith(base) && v.length > base.length && plain(v.slice(base.length))) return v
  // a Google account's picture (written by the sign-in, by Process GPT's social sign-up, or as someone's default)
  if (onAvatarHost(v, opts)) return v
  return null
}

// an uploaded picture's type from its first bytes (never from what the request says): JPEG, WebP or PNG, else null
export function sniffImage(buf) {
  if (!buf || buf.length < 12) return null
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp'
  if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return 'image/png'
  return null
}
