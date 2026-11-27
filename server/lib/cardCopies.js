// 「다른 이름으로 저장」 of a chat's document open in IeumOffice (spec openspec/specs/folder-edit-save 「채팅의 문서」, 2026-11-27 production
// recording: the text editor's 「다른 이름으로 저장…」 did nothing — the web host answers every file dialog with 「cancelled」).
// In Lite it saves the document as a new file card with the name given, in the conversation the card belongs to; the card itself stays
// on the version it had (the editor writes one edited copy per opening, so a card that already stands on that copy is first moved to a
// copy of its own — keepVersion — before the editor writes the new name's content into it).
// Only a plain chat card: not a private one (a mail's attachment), not a shared folder's (its saves are the folder's commits), not a
// received share's (its saves are commits on its branch) — the sheet hides the editor's 「다른 이름으로 저장」 for those.
import crypto from 'node:crypto'
import { config } from '../config.js'
import { q, admin } from './supa.js'
import { objectOfUrl } from './privateStore.js'
import { extOf, editable, mimeOf } from './office.js'
import { aside, ownsConversation } from './ownConversations.js'
import { L } from './lang.js'

const BUCKET = 'files'
const fail = (status, message) => Object.assign(new Error(message), { status })
const dirOf = (key) => String(key).replace(/[^/]*$/, '')
const publicUrl = (key) => `${config.supabaseUrl}/storage/v1/object/public/${BUCKET}/${key.split('/').map(encodeURIComponent).join('/')}`

/** a name 「다른 이름으로 저장」 may give this card's file: the same format, a file name only → the name, or null */
export function copyName(name, original) {
  const n = String(name ?? '').replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!n || n.length > 200 || n.startsWith('.')) return null
  if (extOf(n) !== extOf(original) || !editable(n)) return null
  return n
}

// my own plain chat file card, or a refusal
async function plainCard(user, id) {
  const [m] = await q(`select m.* from pro_messages m join pro_threads t on t.id=m.thread_id where m.id=$1 and t.user_id=$2 and m.kind='file'`, [id, user.id])
  if (!m) throw fail(404, L('파일 카드를 찾지 못했어요.', "I couldn't find the file card."))
  const c = m.content || {}
  if (c.private || c.folder?.slug || c.branch) throw fail(400, L('이 파일은 여기서 다른 이름으로 저장할 수 없어요.', "This file can't be saved under another name here."))
  const own = objectOfUrl(c.url)
  if (!own || own.bucket !== BUCKET) throw fail(400, L('이 파일은 여기서 다른 이름으로 저장할 수 없어요.', "This file can't be saved under another name here."))
  return { m, c, own }
}

// the stored object of `url` when it lies beside this card's own copies (where the editor puts its edited copy), else null
function besideCard(c, url) {
  const o = objectOfUrl(url)
  if (!o || o.bucket !== BUCKET) return null
  const dirs = new Set([c.url, ...(Array.isArray(c.versions) ? c.versions : [])].map((u) => objectOfUrl(u)).filter((x) => x?.bucket === BUCKET).map((x) => dirOf(x.key)))
  return dirs.has(dirOf(o.key)) ? o : null
}

// a copy of a stored object beside it, under a new key → its key
async function copyBeside(key, name) {
  const { data, error } = await admin.storage.from(BUCKET).download(key)
  if (error || !data) throw fail(404, L('저장한 편집본을 찾지 못했어요.', "I couldn't find the saved copy."))
  const buf = Buffer.from(await data.arrayBuffer())
  const to = `${dirOf(key)}${crypto.randomUUID()}.${extOf(name) || 'bin'}`
  const up = await admin.storage.from(BUCKET).upload(to, buf, { contentType: mimeOf(name), upsert: false })
  if (up.error) throw fail(502, L('저장소에 올리지 못했어요.', "Couldn't upload it to storage."))
  return to
}

/**
 * The card keeps the version it stands on: a copy of its own (beside it) — the editor is about to write over the copy it saved before.
 * → the card (updated)
 */
export async function keepVersion(user, id) {
  const { m, c, own } = await plainCard(user, id)
  const key = await copyBeside(own.key, c.name || own.key)
  const [u] = await q(`update pro_messages set content = content || jsonb_build_object('url', $2::text) where id=$1 returning *`, [m.id, publicUrl(key)])
  return u
}

/**
 * A new file card with the name given, holding `url` (the copy the editor just saved, beside the card) or, without it, the card's own
 * version — in the conversation the page says the card is in (when it is this person's). → the new card
 */
export async function saveCardAs(user, id, { url, name, conversationId } = {}) {
  const { m, c, own } = await plainCard(user, id)
  const n = copyName(name, c.name || own.key)
  if (!n) throw fail(400, L(`같은 형식(.${extOf(c.name || own.key)})의 파일 이름을 적어 주세요.`, `Give it a file name of the same format (.${extOf(c.name || own.key)}).`))
  const src = url ? besideCard(c, url) : own
  if (!src) throw fail(400, L('저장한 편집본을 찾지 못했어요.', "I couldn't find the saved copy."))
  const key = await copyBeside(src.key, n)
  const conv = conversationId && (await ownsConversation(user.id, conversationId)) ? { conversationId: String(conversationId) } : null
  const content = { name: n, url: publicUrl(key), ext: extOf(n), ...(c.type ? { type: c.type } : {}), savedAs: { from: m.id, name: c.name || '' }, ...aside(conv) }
  const [made] = await q(`insert into pro_messages(thread_id, role, kind, content) values ($1, 'agent', 'file', $2) returning *`, [m.thread_id, content])
  return made
}
