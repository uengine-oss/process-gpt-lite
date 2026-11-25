// A private storage bucket for what must never have a public address (2026-11-25 — a mail's attachment, here a payroll file: 「메일 첨부를
// 곧바로 이음오피스 등의 도구로 열어보거나 …」). Lite's other files live in the public `files` bucket (a known open issue: every key there
// is readable by its /object/public/ address); this one is created private, and is read only
//   · by this server (the service key), streamed through a route that checks the person again (lib/mailAttachments.js), or
//   · through a short-lived signed address (/storage/v1/object/sign/…?token=…) handed to the one who may read it — the IeumOffice host, the
//     agent's sandbox.
// Keys are ASCII and say whose they are (the name a person sees travels in the database, never in a key or a log):
//   mail/<tenant>/<person>/<card>/<n>-<sha16>/attachment.<ext>    one attachment of one mail card, as it arrived
//   mail/<tenant>/<person>/<card>/<n>-<sha16>/edited-…              the editor's saved copies beside it (office-host editedObjectPath)
//   folders/<tenant>/<folder>/<blob sha>.<ext>                     a shared folder's file opened from a mail (one version, by its blob)
//   folders/<tenant>/<folder>/edited-…                             the editor's saved copies of those
// Pure helpers first (server/test/mailAttachments.test.js), then storage.
import { config } from '../config.js'
import { admin, q } from './supa.js'

export const BUCKET = process.env.PRO_PRIVATE_BUCKET || 'lite-private'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HEX = /^[0-9a-f]+$/

// ---------- keys (pure) ----------
// a key segment from anything: ASCII letters, digits, . _ - only
export const seg = (s) => String(s ?? '').replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_').slice(0, 80) || '_'
// a file's extension, ASCII (no extension: bin)
export const extOf = (name) => {
  const n = String(name || '').split('?')[0]
  const e = n.includes('.') ? n.split('.').pop().toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12) : ''
  return e || 'bin'
}
// where one attachment of a mail card is kept: its own folder (the editor saves its copies beside it)
export function mailDir({ tenant, userId, actionId, i, sha }) {
  if (!UUID.test(String(userId)) || !UUID.test(String(actionId))) throw new Error('a person and a card (ids) are needed')
  if (!Number.isInteger(i) || i < 0 || i > 999) throw new Error('an attachment number is needed')
  if (!HEX.test(String(sha || '')) || String(sha).length < 16) throw new Error('a content hash is needed')
  return `mail/${seg(tenant)}/${String(userId).toLowerCase()}/${String(actionId).toLowerCase()}/${i}-${String(sha).slice(0, 16)}`
}
export const mailKey = (x, name) => `${mailDir(x)}/attachment.${extOf(name)}`
// the prefix of every copy of one card's attachment n (any content): mail/<t>/<person>/<card>/<n>-
export const mailPrefix = ({ tenant, userId, actionId, i }) => `mail/${seg(tenant)}/${String(userId).toLowerCase()}/${String(actionId).toLowerCase()}/${i}-`
export function folderDir({ tenant, folderId }) {
  if (!UUID.test(String(folderId))) throw new Error('a folder id is needed')
  return `folders/${seg(tenant)}/${String(folderId).toLowerCase()}`
}
export function folderKey({ tenant, folderId, sha }, name) {
  if (!/^[0-9a-f]{40}$/.test(String(sha || ''))) throw new Error('a blob id is needed')
  return `${folderDir({ tenant, folderId })}/${sha}.${extOf(name)}`
}
// a key of ours that is safe to hand to storage: no empty, "." or ".." segment, no backslash, ASCII
export const safeKey = (k) => {
  const key = String(k || '')
  return !!key && key.length < 600 && /^[A-Za-z0-9._/-]+$/.test(key) && key.split('/').every((s) => s && s !== '.' && s !== '..')
}
// an editor's saved copy beside `dir` (office-host: edited-<stem>_<time>.<ext>), nothing deeper
export const editedIn = (dir, key) => safeKey(key) && String(key).startsWith(`${dir}/`) && /^edited-[A-Za-z0-9._-]+$/.test(String(key).slice(dir.length + 1))
export const dirOf = (key) => String(key || '').split('/').slice(0, -1).join('/')

// A storage address of this deployment (public, signed or authenticated form — the editor answers its saves in the public form even for a
// private bucket: office-host uploadToStorage) → {bucket, key}, else null. The same storage however the address names it (the editor may
// write localhost where the server wrote 127.0.0.1).
export function objectOfUrl(url, base = config.supabaseUrl) {
  let u, b
  try { u = new URL(String(url || '')); b = new URL(String(base || '')) } catch { return null }
  const loop = (h) => (['localhost', '127.0.0.1', '[::1]'].includes(h) ? 'loopback' : h)
  if (loop(u.hostname) !== loop(b.hostname) || (u.port || (u.protocol === 'https:' ? '443' : '80')) !== (b.port || (b.protocol === 'https:' ? '443' : '80'))) return null
  const m = /^\/storage\/v1\/object\/(?:public\/|sign\/|authenticated\/)?([^/]+)\/(.+)$/.exec(u.pathname)
  if (!m) return null
  let key
  try { key = m[2].split('/').map(decodeURIComponent).join('/') } catch { return null }
  return safeKey(key) ? { bucket: decodeURIComponent(m[1]), key } : null
}
// what a signed address looks like (and never the public one): …/storage/v1/object/sign/<bucket>/<key>?token=…
export const isSignedUrl = (url, bucket = BUCKET) => /\/storage\/v1\/object\/sign\//.test(String(url)) && String(url).includes(`/sign/${bucket}/`) && /[?&]token=/.test(String(url))
export const isPublicUrl = (url) => /\/storage\/v1\/object\/public\//.test(String(url))

// ---------- storage ----------
let ready = null
// the bucket, made private the first time (and made private again if someone opened it up)
export function ensureBucket() {
  ready ||= (async () => {
    const { data, error } = await admin.storage.getBucket(BUCKET)
    if (error || !data) {
      const made = await admin.storage.createBucket(BUCKET, { public: false })
      // (another server made it meanwhile)
      if (made.error && !/exist/i.test(made.error.message || '')) throw new Error(`private bucket: ${made.error.message}`)
      return true
    }
    if (data.public) {
      const fixed = await admin.storage.updateBucket(BUCKET, { public: false })
      if (fixed.error) throw new Error(`private bucket is public and could not be closed: ${fixed.error.message}`)
      console.warn('[private-store] the bucket was public: made private again')
    }
    return true
  })().catch((e) => { ready = null; throw e })
  return ready
}

export async function exists(key) {
  if (!safeKey(key)) return false
  return (await q('select 1 from storage.objects where bucket_id=$1 and name=$2', [BUCKET, key])).length > 0
}
// the newest object whose key starts with `prefix` (an editor's saved copy), or null
export async function newest(prefix) {
  const [r] = await q('select name from storage.objects where bucket_id=$1 and starts_with(name, $2) order by updated_at desc nulls last, created_at desc limit 1', [BUCKET, String(prefix)])
  return r?.name || null
}
export async function put(key, buf, type = 'application/octet-stream') {
  if (!safeKey(key)) throw new Error('not a key of ours')
  await ensureBucket()
  const { error } = await admin.storage.from(BUCKET).upload(key, buf, { contentType: type || 'application/octet-stream', upsert: true })
  if (error) throw new Error(`private store: ${error.message}`)
  return key
}
export async function bytes(key) {
  if (!safeKey(key)) throw Object.assign(new Error('not a key of ours'), { status: 400 })
  const { data, error } = await admin.storage.from(BUCKET).download(key)
  if (error || !data) throw Object.assign(new Error('gone'), { status: 410 })
  return { buf: Buffer.from(await data.arrayBuffer()), type: data.type || '' }
}
// a signed address for `seconds` (the one who gets it reads that object only, until then)
export async function signedUrl(key, seconds) {
  if (!safeKey(key)) throw new Error('not a key of ours')
  await ensureBucket()
  const { data, error } = await admin.storage.from(BUCKET).createSignedUrl(key, Math.max(30, Math.min(3600, Math.round(seconds))))
  if (error || !data?.signedUrl) throw new Error(`private store: ${error?.message || 'no signed address'}`)
  return data.signedUrl
}
// the object as storage serves it — a part when asked (Range: a player seeks, Safari plays only so), streamed (lib/team/shares.js stream)
export async function stream(key, range) {
  if (!safeKey(key)) throw Object.assign(new Error('not a key of ours'), { status: 400 })
  const path = key.split('/').map(encodeURIComponent).join('/')
  const r = await fetch(`${config.supabaseUrl}/storage/v1/object/${encodeURIComponent(BUCKET)}/${path}`, {
    headers: { Authorization: `Bearer ${config.serviceKey}`, apikey: config.serviceKey, ...(range ? { Range: String(range) } : {}) },
  })
  if (!r.ok && r.status !== 416) {
    await r.body?.cancel().catch(() => {})
    throw Object.assign(new Error('gone'), { status: 410 })
  }
  return r
}
