// A person's picture (lib/profilePicture.js): users.profile of their row in this request's tenant — the field Process GPT's
// account settings write, so a change in either app shows in both. Someone signed in with Google has their Google picture as the
// default: it fills an empty field when they come in (GET /api/me), and clearing a choice puts it back.
//   PUT  /api/me/picture {picture}       one of Process GPT's presets, an upload of mine (my own storage folder), or null/'' to clear
//   POST /api/me/picture/upload (bytes)  a picture the page made (a square JPEG · WebP · PNG) → my storage folder → saved as above
//   GET  /api/people/pictures            {id: picture} of this company's people who have one (the initials elsewhere become faces)
//   GET  /api/people                     {id: {name, picture, email}} of this company's people — the one name and face every screen shows
//                                        (lib/people.js: the same rule as the names in rooms, lists and notices)
// PUT and the upload answer {picture, pictureDefault}: what the screens show (null = the initial) and the default (the Google picture
// or null). Only the caller's own row is ever written; a Google address comes only from the auth server's record, never the page.
import crypto from 'node:crypto'
import express from 'express'
import { config } from '../config.js'
import { q, admin } from '../lib/supa.js'
import { L } from '../lib/lang.js'
import {
  checkPicture, ownUploadKey, sniffImage, uploadPrefix, uploadUrl, MAX_UPLOAD, UPLOAD_TYPES,
  googlePictureOf, seedValue, defaultValue, resolvePicture, onAvatarHost,
} from '../lib/profilePicture.js'
import { pictureOpts as opts, everyone, forget } from '../lib/people.js'
const googleOf = (authUser) => googlePictureOf(authUser, opts())

// my picture for GET /api/me — {picture, pictureDefault}. On the way, the Google picture fills an empty users.profile (or follows the
// account while the field holds a Google address), so Process GPT shows the same picture; a choice is never overwritten.
export async function myPicture(userId, authUser) {
  const google = googleOf(authUser)
  const [u] = await q('select profile from users where id=$1 and tenant_id=$2', [userId, config.tenantId]).catch(() => [])
  let stored = u?.profile
  const seed = u ? seedValue(stored, google, opts()) : null
  if (seed) {
    // (only if nothing changed it meanwhile: another tab's choice wins)
    const [w] = await q('update users set profile=$3 where id=$1 and tenant_id=$2 and profile is not distinct from $4 returning profile',
      [userId, config.tenantId, seed, stored]).catch((e) => { console.warn('[picture] seed', e.message); return [] })
    if (w) { stored = w.profile; forget(userId) }
  }
  return { picture: resolvePicture(stored, google, opts()), pictureDefault: google }
}

// the Google picture Lite's own Google sign-in saw (installed Lite: no Google identity on the auth user), kept where only this
// server writes (app_metadata) — the same place googlePictureOf reads; another host or none clears it
export async function rememberGooglePicture(userId, picture) {
  const v = onAvatarHost(picture, opts()) ? picture : null
  const { data } = await admin.auth.admin.getUserById(userId)
  if (!data?.user || (data.user.app_metadata?.google_picture ?? null) === v) return
  const { error } = await admin.auth.admin.updateUserById(userId, { app_metadata: { ...(data.user.app_metadata || {}), google_picture: v } })
  if (error) console.warn('[picture] google', error.message)
}

// writes my row only; null puts back the default — my Google picture, else the column's default (what a new account has; Process
// GPT shows its own placeholder for it)
async function savePicture(req, value) {
  const google = googleOf(req.authUser)
  const [before] = await q('select profile from users where id=$1 and tenant_id=$2', [req.user.id, config.tenantId])
  if (!before) throw Object.assign(new Error(L('이 회사에서 내 계정을 찾지 못했어요.', "I couldn't find your account in this company.")), { status: 404 })
  const next = value ?? defaultValue(google)
  const [after] = next == null
    ? await q('update users set profile=default where id=$1 and tenant_id=$2 returning profile', [req.user.id, config.tenantId])
    : await q('update users set profile=$3 where id=$1 and tenant_id=$2 returning profile', [req.user.id, config.tenantId, next])
  // the upload it replaced goes once no row shows it (the same person in another company may still)
  const old = ownUploadKey(before.profile, { userId: req.user.id, supabaseUrl: config.supabaseUrl })
  if (old && before.profile !== after?.profile) {
    const [used] = await q('select 1 from users where profile=$1 limit 1', [before.profile]).catch(() => [{}])
    if (!used) admin.storage.from('files').remove([old]).then(({ error }) => error && console.warn('[picture] remove', error.message), () => {})
  }
  forget(req.user.id)
  return { picture: resolvePicture(after?.profile, google, opts()), pictureDefault: google }
}

const refused = () => L('이 사진은 쓸 수 없어요. 기본 사진에서 고르거나 내 사진을 올려 주세요.', "That picture can't be used. Pick one of the presets or upload your own.")

export function profilePictureRoutes(auth) {
  const r = express.Router()
  r.put('/me/picture', auth, async (req, res) => {
    let value
    try { value = checkPicture(req.body?.picture, { userId: req.user.id, supabaseUrl: config.supabaseUrl }) } catch { return res.status(400).json({ error: refused() }) }
    try { res.json(await savePicture(req, value)) } catch (e) { res.status(e.status || 500).json({ error: e.message }) }
  })
  r.post('/me/picture/upload', auth, express.raw({ type: () => true, limit: MAX_UPLOAD }), async (req, res) => {
    const buf = Buffer.isBuffer(req.body) ? req.body : null
    const type = sniffImage(buf)
    if (!type) return res.status(400).json({ error: L('JPG · PNG · WebP 사진만 올릴 수 있어요.', 'Only JPG, PNG or WebP pictures can be uploaded.') })
    // storage keys are ASCII: my own folder, a fresh name (never one that is already there)
    const key = `${uploadPrefix(req.user.id)}${crypto.randomUUID()}.${UPLOAD_TYPES[type]}`
    const { error } = await admin.storage.from('files').upload(key, buf, { contentType: type, upsert: false, cacheControl: '31536000' })
    if (error) {
      console.warn('[picture] upload', error.message)
      return res.status(502).json({ error: L('사진을 올리지 못했어요. 잠시 뒤에 다시 해 주세요.', "I couldn't upload the picture. Please try again in a moment.") })
    }
    try {
      // (the same check as a saved address: an upload is saved only as an address PUT would take)
      res.json(await savePicture(req, checkPicture(uploadUrl(config.supabaseUrl, key), { userId: req.user.id, supabaseUrl: config.supabaseUrl })))
    } catch (e) {
      admin.storage.from('files').remove([key]).catch(() => {})
      res.status(e.status || 500).json({ error: e.message })
    }
  })
  // people only (not the company's agents), and only who has a picture Lite would show (their choice, else their Google picture)
  r.get('/people/pictures', auth, async (req, res) => {
    const out = {}
    for (const p of await everyone()) if (p.picture) out[p.id] = p.picture
    res.json(out)
  })
  // everyone's name and picture (people only): the circles and the names that know only who (src/people.js)
  r.get('/people', auth, async (req, res) => {
    const out = {}
    // (the address too: the lists tell same-named people apart by it — src/sameNames.js)
    for (const p of await everyone()) out[p.id] = { name: p.name, picture: p.picture, email: p.email }
    res.json(out)
  })
  return r
}
