// 「다른 이름으로 저장」 of a chat's document open in IeumOffice (spec openspec/specs/folder-edit-save 「채팅의 문서」, 2026-11-27 production
// recording: the text editor's 「다른 이름으로 저장…」 did nothing — the web host answers every file dialog with 「cancelled」).
// In Lite it saves the document as a new file card with the name given, in the conversation the card belongs to; the card itself stays
// on the version it had (the editor writes one edited copy per opening, so a card that already stands on that copy is first moved to a
// copy of its own — keepVersion — before the editor writes the new name's content into it).
// Only a plain chat card: not a private one (a mail's attachment), not a shared folder's (its saves are the folder's commits), not a
// received share's (its saves are commits on its branch) — the sheet hides the editor's 「다른 이름으로 저장」 for those.
// What may be copied: the card's own file, or the editor's edited copy (edited-…) beside it, or a file under this person's own prefix —
// in the same format as the card. Copies are made by storage itself (no bytes through this server), up to MAX, and always go under this
// person's own prefix (pgpt-pro/<person>/copies/). savedCopyOk is the same rule for a card's ordinary save (POST /api/messages/:id/file).
import crypto from 'node:crypto'
import { config } from '../config.js'
import { q, admin } from './supa.js'
import { objectOfUrl } from './privateStore.js'
import { extOf, editable } from './office.js'
import { aside, ownsConversation } from './ownConversations.js'
import { L } from './lang.js'

const BUCKET = 'files'
const MAX = 50 * 1024 * 1024
const fail = (status, message) => Object.assign(new Error(message), { status })
const dirOf = (key) => String(key).replace(/[^/]*$/, '')
// a stored object by its address — on this server's storage address or the one the office host hands out (config.supabasePublicUrl)
const storageObject = (url) => objectOfUrl(url) || (config.supabasePublicUrl ? objectOfUrl(url, config.supabasePublicUrl) : null)
const baseOf = (key) => String(key).split('/').pop()
const publicUrl = (key) => `${config.supabaseUrl}/storage/v1/object/public/${BUCKET}/${key.split('/').map(encodeURIComponent).join('/')}`
// the editor's edited copy of a stored object: edited-<stem>_<yyyymmddhhmmss>.<ext> (office host documents.mjs editedObjectPath)
const EDITED = /^edited-.+_\d{14}\.[A-Za-z0-9]{1,8}$/
const ownPrefix = (user) => `pgpt-pro/${user.id}/`
const own = (user, o) => !!o && o.bucket === BUCKET && o.key.startsWith(ownPrefix(user)) && !o.key.split('/').includes('..')
// a name's direction controls (U+202A–202E, U+2066–2069) and control characters go: they make a name read other than it is
const CONTROLS = /[\u0000-\u001f\u007f‪-‮⁦-⁩]/g

/** a name 「다른 이름으로 저장」 may give this card's file: the same format, a file name only → the name, or null */
export function copyName(name, original) {
  const n = String(name ?? '').replace(CONTROLS, ' ').replace(/[<>:"/\\|?*]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!n || n.length > 200 || n.startsWith('.')) return null
  if (!extOf(original) || extOf(n) !== extOf(original) || !editable(n)) return null
  return n
}

// where a card's own copies are: bucket + folder of its address and of the versions it stood on
function cardDirs(c) {
  return new Set([c?.url, ...(Array.isArray(c?.versions) ? c.versions : [])].map((u) => storageObject(u)).filter(Boolean).map((o) => `${o.bucket}/${dirOf(o.key)}`))
}

/**
 * A card's ordinary save (POST /api/messages/:id/file, not a private card): the address must be the editor's edited copy beside the
 * card's own file (or a version it stood on), or a file of this person's own (an ArtCraft app's save goes up as their attachment).
 */
export function savedCopyOk(user, card, url) {
  const o = storageObject(url)
  if (!o) return false
  if (own(user, o)) return true
  return EDITED.test(baseOf(o.key)) && cardDirs(card?.content).has(`${o.bucket}/${dirOf(o.key)}`)
}

// my own plain chat file card, or a refusal
async function plainCard(user, id) {
  const [m] = await q(`select m.* from pro_messages m join pro_threads t on t.id=m.thread_id where m.id=$1 and t.user_id=$2 and m.kind='file'`, [id, user.id])
  if (!m) throw fail(404, L('파일 카드를 찾지 못했어요.', "I couldn't find the file card."))
  const c = m.content || {}
  const no = () => fail(400, L('이 파일은 여기서 다른 이름으로 저장할 수 없어요.', "This file can't be saved under another name here."))
  if (c.private || c.folder?.slug || c.branch) throw no()
  const o = storageObject(c.url)
  if (!o || o.bucket !== BUCKET) throw no()
  // (the format the card says it is, and the file it stands on)
  const ext = extOf(c.name || '')
  if (!ext || !editable(c.name) || extOf(o.key) !== ext) throw no()
  return { m, c, o, ext }
}

// how big a stored object is (bytes), or null when storage does not say
async function sizeOf(key) {
  const info = await admin.storage.from(BUCKET).info(key).catch(() => null)
  if (info?.data?.size != null) return Number(info.data.size)
  const l = await admin.storage.from(BUCKET).list(dirOf(key).replace(/\/$/, ''), { search: baseOf(key), limit: 5 }).catch(() => null)
  const hit = l?.data?.find((x) => x.name === baseOf(key))
  return hit?.metadata?.size != null ? Number(hit.metadata.size) : null
}

// a copy of a stored object under this person's own prefix, made by storage → its key
async function copyToOwn(user, key, ext) {
  const size = await sizeOf(key)
  if (size == null && !(await admin.storage.from(BUCKET).exists(key).then((r) => r.data, () => false))) throw fail(404, L('저장한 편집본을 찾지 못했어요.', "I couldn't find the saved copy."))
  if (size != null && size > MAX) throw fail(413, L('파일이 너무 커요(50MB 초과).', 'The file is too large (over 50 MB).'))
  const to = `${ownPrefix(user)}copies/${crypto.randomUUID()}.${ext}`
  const { error } = await admin.storage.from(BUCKET).copy(key, to)
  if (error) throw fail(/not.?found/i.test(error.message || '') ? 404 : 502, L('저장한 편집본을 복사하지 못했어요.', "Couldn't copy the saved file."))
  return to
}

/**
 * The card keeps the version it stands on — the editor's copy of this opening, which the editor is about to write over: a copy of its
 * own (under this person's prefix). Only when the card still stands on that copy (a save meanwhile wins). → the card
 */
export async function keepVersion(user, id) {
  const { m, c, o, ext } = await plainCard(user, id)
  if (!EDITED.test(baseOf(o.key))) throw fail(400, L('지킬 편집본이 없어요.', 'There is no edited copy to keep.'))
  const key = await copyToOwn(user, o.key, ext)
  const [u] = await q(`update pro_messages set content = content || jsonb_build_object('url', $2::text) where id=$1 and content->>'url' = $3 returning *`, [m.id, publicUrl(key), c.url])
  if (u) return u
  // (moved meanwhile: the copy is not needed)
  await admin.storage.from(BUCKET).remove([key]).catch(() => {})
  return (await q('select * from pro_messages where id=$1', [m.id]))[0]
}

/**
 * A new file card with the name given, holding `url` (the editor's edited copy beside the card, or a file of mine) or, without it, the
 * card's own version — in the conversation the page says the card is in (when it is this person's). → the new card
 */
export async function saveCardAs(user, id, { url, name, conversationId } = {}) {
  const { m, c, o, ext } = await plainCard(user, id)
  const n = copyName(name, c.name)
  if (!n) throw fail(400, L(`같은 형식(.${ext})의 파일 이름을 적어 주세요.`, `Give it a file name of the same format (.${ext}).`))
  const src = url ? storageObject(url) : o
  if (!src || src.bucket !== BUCKET || extOf(src.key) !== ext || (url && !savedCopyOk(user, m, url))) throw fail(400, L('저장한 편집본을 찾지 못했어요.', "I couldn't find the saved copy."))
  const key = await copyToOwn(user, src.key, ext)
  const conv = conversationId && (await ownsConversation(user.id, conversationId)) ? { conversationId: String(conversationId) } : null
  const content = { name: n, url: publicUrl(key), ext, ...(c.type ? { type: c.type } : {}), savedAs: { from: m.id, name: c.name || '' }, ...aside(conv) }
  const [made] = await q(`insert into pro_messages(thread_id, role, kind, content) values ($1, 'agent', 'file', $2) returning *`, [m.thread_id, content])
  return made
}
