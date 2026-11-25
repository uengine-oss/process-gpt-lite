// 메일 첨부를 그 자리에서 열고, 채팅으로 묻고, 동료와 나눈다 (2026-11-25 사용자: 「메일 첨부를 곧바로 이음오피스 등의 도구로 열어보거나 채팅으로
// 해당 메일에 대한 질의/액션을 취할 수 있는 뭔가 흐름이 있어야」 — 메일 시트의 회색 칩 「2026년 11월 … 급여대장.xlsx」가 아무 일도 하지 않았다).
// 스펙 openspec/specs/mail-attachments.
//
// Where the bytes come from (one source):
//   · the mail was filed (폴더에 정리 — source.filing[name].filed) or went into its work's folder (lib/mailWork.js) and the file is still
//     there: THAT copy. A document opens in IeumOffice from a private copy of that version, and its saves are commits in the folder
//     (POST /messages/:id/file → folders/service.js saveOfficeEdit), as a folder file opened anywhere else.
//   · otherwise the person's own mailbox (their Google · IMAP connection, lib/mailReply.js sourceOf), once: the attachment is kept as a
//     PRIVATE copy (lib/privateStore.js — never the public `files` bucket) and the card remembers it (source.att_copies[n]).
// How it is handed out — never an /object/public/ address:
//   · IeumOffice (office-host fetches its document itself): a signed storage address, OPEN_TTL_S. Its saves land beside the copy; a save
//     of a mail's own copy becomes the person's private file card in their chat (saved) — 「내 채팅에 저장했어요 · 나만 볼 수 있어요」.
//   · the viewer (a picture · sound · video) and 「내려받기」: this server's route GET /api/mail/attachments/:card/:n/raw, signed for one
//     person for 15 minutes (as lib/team/mediaLink.js — no sign-in token in an address), checked again on every request.
//   · the agent (lib/fileRefs.js turnRefs): the file in its workspace where that is on this machine (the way chat attachments go), else a
//     signed storage address for AGENT_TTL_S.
// Who may: the mail's owner (the mailbox's person, pro_actions.user_id) — anyone else's id is not found (404, nothing said). In the
// messenger the others see the name and the mail's summary only, until the owner shares that attachment with that room — kept on the
// owner's card (source.att_share[n][room]), as a mail body is (lib/mailMention.js); stopping it closes it again.
// No attachment bytes or names are written to the log.
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import { constants as fsConst } from 'node:fs'
import path from 'node:path'
import { config } from '../config.js'
import { q } from './supa.js'
import { emit } from './bus.js'
import { L } from './lang.js'
import * as MM from './mailMention.js'
import * as P from './privateStore.js'
import { LINK_TTL_S } from './team/mediaLink.js'
import { isTiffName, isTiffBytes, tiffToPngs, pageName, reasonOf } from './tiff.js'

const T = () => config.tenantId
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ROOM = /^[\w.:-]{1,120}$/
const fail = (status, message, code) => Object.assign(new Error(message), { status, ...(code && { code }) })
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
export const OPEN_TTL_S = 10 * 60
export const AGENT_TTL_S = 30 * 60
export const MAX_BYTES = 50 * 1024 * 1024
export const MAX_INDEX = 99

// ---------- what a file is (pure) ----------
// documents IeumOffice opens (not HTML: a mail's HTML is someone else's page — it is downloaded, never rendered on this origin)
const OFFICE = { docx: 'docs', odt: 'docs', xlsx: 'sheets', xlsm: 'sheets', xls: 'sheets', csv: 'sheets', pptx: 'slides', pdf: 'pdf', hwp: 'hwp', hwpx: 'hwp',
  md: 'markdown', markdown: 'markdown', txt: 'markdown', xmind: 'mindmap' }
// (a TIFF — a fax — is a picture too: the page draws it itself, src/tiff.js; the agent gets its pages as PNG, agentFile)
const IMAGE = new Set(['png', 'jpg', 'jpeg', 'jfif', 'gif', 'webp', 'svg', 'avif', 'bmp', 'ico', 'apng', 'tif', 'tiff'])
const AUDIO = new Set(['mp3', 'm4a', 'aac', 'wav', 'ogg', 'oga', 'opus', 'flac', 'weba'])
const VIDEO = new Set(['mp4', 'm4v', 'mov', 'webm', 'ogv'])
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/pjpeg', 'image/gif', 'image/webp', 'image/svg+xml', 'image/avif', 'image/bmp', 'image/x-icon', 'image/vnd.microsoft.icon', 'image/apng',
  'image/tiff', 'image/tiff-fx', 'image/x-tiff'])
const GENERIC = new Set(['', 'application/octet-stream', 'binary/octet-stream', 'application/unknown'])
export const MEDIA_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif', bmp: 'image/bmp',
  tif: 'image/tiff', tiff: 'image/tiff',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac', weba: 'audio/webm',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', ogv: 'video/ogg' }
const ext = (name) => { const e = P.extOf(name); return e === 'bin' ? '' : e }
// {kind: 'office', editor} | {kind: 'media', media: image|audio|video} | {kind: 'file'} — a document by its name; a picture · sound · video
// by its type when it has a telling one, else its name (as src/mediaKind.js)
export function kindOf({ name, type } = {}) {
  const e = ext(name)
  if (OFFICE[e]) return { kind: 'office', editor: OFFICE[e] }
  const t = String(type || '').toLowerCase().split(';')[0].trim()
  if (!GENERIC.has(t)) {
    if (IMAGE_TYPES.has(t)) return { kind: 'media', media: 'image' }
    if (t.startsWith('audio/')) return { kind: 'media', media: 'audio' }
    if (t.startsWith('video/')) return { kind: 'media', media: 'video' }
    if (!IMAGE.has(e) && !AUDIO.has(e) && !VIDEO.has(e)) return { kind: 'file' }
  }
  return IMAGE.has(e) ? { kind: 'media', media: 'image' } : AUDIO.has(e) ? { kind: 'media', media: 'audio' } : VIDEO.has(e) ? { kind: 'media', media: 'video' } : { kind: 'file' }
}
// the type a picture · sound · video is served with (one stored without its type still shows and plays), else what it was stored with
export function rawType(name, stored) {
  const t = String(stored || '').split(';')[0].trim().toLowerCase()
  if (t && !GENERIC.has(t)) return String(stored)
  return MEDIA_TYPES[ext(name)] || 'application/octet-stream'
}
// An attachment is found by its number n; its name is only checked. Names are compared the same way on both sides: NFC, every run of
// white space (NBSP · ideographic space · zero-width too) as one space, trimmed — and a name cut short somewhere (a chip keeps 200
// characters) still matches its whole when the first 100 characters or more agree (review 11-25 #4).
export const normName = (s) => String(s ?? '').normalize('NFC').replace(/[\s\u200b\u200c\u200d\u2060\ufeff]+/g, ' ').trim()
export function sameName(a, b) {
  const x = normName(a), y = normName(b)
  if (!x || !y) return false
  if (x === y) return true
  const n = Math.min(x.length, y.length)
  return n >= 100 && x.slice(0, n) === y.slice(0, n)
}
// what the card already knows of attachment n (no mailbox read): the sheet's list (source.att_meta — lib/mailReply.js mailOfCard), its
// private copy, else the name the sheet's row kept (source.follow.atts) → {name, size, type} or null
export function knownOf(card, i) {
  const m = card?.source?.att_meta?.[i]
  if (m?.name) return { name: String(m.name), size: Number(m.size) || 0, type: String(m.type || '') }
  const c = card?.source?.att_copies?.[String(i)]
  if (c?.name) return { name: String(c.name), size: Number(c.size) || 0, type: String(c.type || '') }
  const f = card?.source?.follow?.atts?.[i]
  return f ? { name: String(f), size: 0, type: '' } : null
}
export const attIndex = (v) => { if (v == null || v === '' || typeof v === 'boolean') return null; const n = Number(v); return Number.isInteger(n) && n >= 0 && n <= MAX_INDEX ? n : null }

// ---------- the signed address of this server's route (pure) ----------
// /mail/attachments/<card>/<n>/raw?u=<person>&exp=<unix s>[&r=<room>][&inline=1]&sig=<base64url HMAC-SHA256> — the signature covers the
// tenant, the card, the attachment's number, the person, the room (a colleague's link: the room the owner shared it with), the expiry and
// the inline flag, under a key only the server holds (its service key with a label of its own — a team share's link is not one of these).
const LABEL = 'pgpt-lite/mail-attachment-link/v1'
const STEP_S = 5 * 60
const MAX_AHEAD_S = LINK_TTL_S + STEP_S + 60
export function linkKeyOf(secret) {
  if (!secret) throw new Error('no secret to sign attachment links with')
  return crypto.createHmac('sha256', String(secret)).update(LABEL).digest()
}
const payload = ({ tenant, actionId, i, userId, room, exp, inline }) =>
  ['v1', String(tenant || ''), String(actionId).toLowerCase(), String(i), String(userId).toLowerCase(), String(room || ''), String(exp), inline ? '1' : '0'].join('|')
const mac = (key, p) => crypto.createHmac('sha256', key).update(p).digest()
export function signAtt({ key, tenant, actionId, i, userId, room = '', inline = false, now = Date.now(), exp }) {
  if (!UUID.test(String(actionId)) || !UUID.test(String(userId)) || attIndex(i) == null) throw new Error('a card, an attachment and a person are needed')
  if (room && !ROOM.test(String(room))) throw new Error('not a room')
  const e = exp ?? Math.ceil((Math.floor(now / 1000) + LINK_TTL_S) / STEP_S) * STEP_S
  return { u: String(userId).toLowerCase(), r: String(room || ''), exp: e, inline: !!inline, sig: mac(key, payload({ tenant, actionId, i, userId, room, exp: e, inline })).toString('base64url') }
}
export const attPath = (actionId, i, s) => `/mail/attachments/${encodeURIComponent(String(actionId).toLowerCase())}/${i}/raw?u=${encodeURIComponent(s.u)}&exp=${s.exp}${s.r ? `&r=${encodeURIComponent(s.r)}` : ''}${s.inline ? '&inline=1' : ''}&sig=${encodeURIComponent(s.sig)}`
// 'ok' | 'expired' | 'bad' — the signature first (an altered address is 'bad' whatever its expiry), compared in constant time
export function verifyAtt({ key, tenant, actionId, i, u, r = '', exp, sig, inline = false, now = Date.now() }) {
  const e = String(exp ?? '')
  if (!UUID.test(String(actionId || '')) || attIndex(i) == null || !UUID.test(String(u || '')) || (r && !ROOM.test(String(r))) || !/^\d{1,12}$/.test(e) || !/^[A-Za-z0-9_-]{43}$/.test(String(sig || ''))) return 'bad'
  const want = mac(key, payload({ tenant, actionId, i: attIndex(i), userId: u, room: r, exp: e, inline }))
  const got = Buffer.from(String(sig), 'base64url')
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return 'bad'
  const t = Math.floor(now / 1000)
  if (Number(e) > t + MAX_AHEAD_S) return 'bad'
  return Number(e) <= t ? 'expired' : 'ok'
}
let linkKey = null
const key = () => (linkKey ||= linkKeyOf(config.serviceKey))
export const linkFor = (actionId, i, userId, { room = '', inline = false } = {}) => attPath(actionId, i, signAtt({ key: key(), tenant: T(), actionId, i, userId, room, inline }))
export const checkLink = (q0) => verifyAtt({ key: key(), tenant: T(), actionId: q0.actionId, i: q0.i, u: q0.u, r: q0.r || '', exp: q0.exp, sig: q0.sig, inline: q0.inline === '1' || q0.inline === true })

// ---------- who may see it (pure) ----------
// a colleague's state of an attachment mentioned in the messenger (as mailMention.js mailRefState):
//   mine — the owner · shared — the owner shared it with this room · summary — everyone else · requested — asked · gone — the card is gone
export const attRefState = ({ mine = false, share = null, requested = false, gone = false } = {}) => MM.mailRefState({ mine, share, requested, gone })
export const sharedRoomsOf = (card, i) => Object.keys(card?.source?.att_share?.[String(i)] || {})
export const attSharedWith = (card, i, roomId) => !!roomId && sharedRoomsOf(card, i).includes(String(roomId))
// what a message keeps of an attachment mention (and what every viewer gets): never the bytes, never an address
export const publicAttRef = (r) => ({ type: 'mailatt', actionId: r.actionId, i: r.i, owner: r.owner, ownerName: r.ownerName || '', name: r.name || '', size: Number(r.size) || 0,
  subject: r.subject || '', from: r.from || '', domain: r.domain || '', date: r.date || null, share: r.share === 'room' ? 'room' : null })

// ---------- the card and the mail ----------
const cardOf = (userId, actionId) => MM.cardOf(userId, actionId)
async function ownersCard(r) {
  const [a] = UUID.test(String(r.actionId || '')) ? await q(`select * from pro_actions where id=$1 and user_id::text=$2 and source ? 'mail_id' and status <> 'deleted'`, [r.actionId, String(r.owner || '')]) : []
  return a || null
}
// a whole message larger than this is not fetched: an attachment of MAX_BYTES base64-encoded, with its mail around it
export const MAX_RAW_BYTES = Math.ceil(MAX_BYTES * 1.4) + 2 * 1024 * 1024
// the mail with its attachments' bytes, from the owner's own mailbox — its size first, a larger one is refused before any byte comes
// (deps.source: tests)
async function mailWithFiles(userId, card, deps = {}) {
  if (deps.source) return deps.source(userId, card)
  const [acc] = await q('select provider, address from pro_mail_accounts where user_id=$1', [userId])
  if (!acc) throw fail(409, L('연결된 메일함이 없어요. 설정에서 메일을 연결해 주세요.', 'No mailbox is connected. Connect your mail in Settings.'))
  return (await import('./mailReply.js')).sourceOf(userId, acc.provider, card.source.mail_id, { to: acc.address || '', maxBytes: MAX_RAW_BYTES })
}
// One fetch at a time per attachment (a second open while the first is reading the mailbox waits for it), and a mail too large or a
// mailbox too slow is remembered for a while (not asked again on every press, every viewer, every colleague) — review 11-25 #3.
const inflight = new Map()           // `${tenant}:${card}:${n}` → the copy being made
const failures = new Map()           // same key → {status, message, code, until}
export const FAILURE_TTL_MS = 5 * 60_000
const REMEMBER = new Set([413, 504])
export const forgetFailures = () => failures.clear()
// The private copy of attachment n (made once, from the owner's mailbox): {key, name, type, size, sha, sha256, at, buf?}. A name that
// does not match the mail's (sameName — a different mail under the same id) is not found.
export async function ensureCopy(ownerId, card, i, name, deps = {}) {
  const kept = card.source?.att_copies?.[String(i)]
  if (kept && (!name || sameName(kept.name, name)) && P.safeKey(kept.key) && kept.key.startsWith(P.mailPrefix({ tenant: T(), userId: ownerId, actionId: card.id, i })) && await P.exists(kept.key)) return kept
  const key = `${T()}:${card.id}:${i}`
  const was = failures.get(key)
  if (was && was.until > Date.now()) throw fail(was.status, was.message, was.code)
  let job = inflight.get(key)
  if (!job) {
    job = makeCopy(ownerId, card, i, deps).catch((e) => {
      if (REMEMBER.has(e.status)) failures.set(key, { status: e.status, message: e.message, code: e.code, until: Date.now() + FAILURE_TTL_MS })
      throw e
    }).finally(() => inflight.delete(key))
    inflight.set(key, job)
  }
  const copy = await job
  if (name && !sameName(copy.name, name)) throw fail(404, L('메일에서 이 첨부를 찾지 못했어요.', "I couldn't find this attachment in the mail."))
  return copy
}
async function makeCopy(ownerId, card, i, deps) {
  const mail = await mailWithFiles(ownerId, card, deps)
  const a = (mail.attachments || [])[i]
  if (!a) throw fail(404, L('메일에서 이 첨부를 찾지 못했어요.', "I couldn't find this attachment in the mail."))
  const buf = Buffer.isBuffer(a.content) ? a.content : Buffer.from(a.content || '')
  if (!buf.length) throw fail(400, L('빈 첨부예요.', 'The attachment is empty.'))
  if (buf.length > MAX_BYTES) throw fail(413, L('첨부가 너무 커요(50MB 초과).', 'The attachment is too large (over 50 MB).'))
  const sha = crypto.createHash('sha256').update(buf).digest('hex')
  const k = P.mailKey({ tenant: T(), userId: ownerId, actionId: card.id, i, sha }, a.name)
  await P.put(k, buf, rawType(a.name, a.type))
  const copy = { key: k, name: String(a.name), type: String(a.type || ''), size: buf.length, sha: sha.slice(0, 16), sha256: sha, at: new Date().toISOString() }
  const [row] = await q(`update pro_actions set source = jsonb_set(source, '{att_copies}', coalesce(source->'att_copies', '{}'::jsonb) || jsonb_build_object($2::text, $3::jsonb))
                         where id=$1 and user_id=$4 returning *`, [card.id, String(i), JSON.stringify(copy), ownerId])
  if (row) card.source = row.source
  return { ...copy, buf }
}

// The copy in a shared folder the person can still read: the mail was filed there (source.filing[name].filed), or the attachment went into
// its work's folder with the mail (lib/mailWork.js addMail: 메일/NN_첨부/<name>) — and the file is still on main. → {folder, role, path, sha,
// editable} or null (none, gone, or no access any more: the mail's own copy then).
export async function folderCopyOf(user, card, i, name) {
  const S = await import('./folders/service.js')
  const tries = []
  // (the filing is kept under the attachment's name as the sheet sent it: found by sameName, not by the exact string)
  const fkey = name ? Object.keys(card.source?.filing || {}).find((k) => sameName(k, name)) : null
  const filed = fkey ? card.source.filing[fkey]?.filed : null
  if (filed?.slug && filed?.path) tries.push({ slug: filed.slug, path: filed.path })
  const wf = card.source?.inst?.folder
  if (wf?.slug) {
    const f = await S.folderBySlug(wf.slug).catch(() => null)
    const work = f?.settings?.work
    const e = (work?.mails || []).find((m) => String(m.mailId) === String(card.source.mail_id))
    const nm = e?.attachments?.[i]
    if (nm) {
      const W = await import('./mailWork.js')
      const d = W.dirsOf(work)
      tries.push({ slug: wf.slug, path: `${d.mail}/${W.pad(e.n)}_${d.attach}/${nm}` })
    }
  }
  for (const t of tries) {
    try {
      const { folder, role } = await S.access(t.slug, user)
      if (folder.kind === 'skill') continue
      const p = S.safeRel(t.path)
      const sha = await S.blobAt(folder, folder.default_branch, p)
      if (!sha) continue
      return { folder, role, path: p, sha, editable: folder.kind === 'managed' && S.RANK[role] >= S.RANK.editor && S.OFFICE_EDIT.has(P.extOf(p)) }
    } catch { /* no access, not there: the next, else the mail's own copy */ }
  }
  return null
}
// a folder's version, privately (one object per blob)
export async function privateBlob(folder, rel, sha) {
  const k = P.folderKey({ tenant: T(), folderId: folder.id, sha }, rel)
  if (!(await P.exists(k))) {
    const G = await import('./folders/git.js')
    await P.put(k, await G.git(folder.repo_path, ['cat-file', 'blob', sha], { buffer: true }), rawType(rel, ''))
  }
  return k
}
// the card the office panel opens a folder copy with (a conversation no list shows — as fileRefs.js open): its saves go into the folder
async function folderCard(user, fc, k, att) {
  const { filesThread, LINKS_REF } = await import('./team/uploads.js')
  const t = await filesThread(user.id, LINKS_REF)
  const folder = { slug: fc.folder.slug, name: fc.folder.name, path: fc.path, sha: fc.sha, editable: fc.editable }
  const content = { name: path.posix.basename(fc.path), private: { key: k }, folder, mailAtt: att }
  // (only a private card of its own — the same file opened from a messenger link has its own card with a public address, lib/fileRefs.js
  // open: one card for both mixed the two and broke the save — review 11-25 #2)
  const [had] = await q(`select * from pro_messages where thread_id=$1 and kind='file' and content ? 'private' and content->'folder'->>'slug'=$2 and content->'folder'->>'path'=$3
                         and content->'folder'->>'sha'=$4 order by created_at desc limit 1`, [t.id, folder.slug, folder.path, folder.sha])
  const [m] = had
    ? await q(`update pro_messages set content = (content - 'url') || $2::jsonb where id=$1 returning *`, [had.id, JSON.stringify({ private: content.private, folder, mailAtt: att })])
    : await q(`insert into pro_messages(thread_id,role,kind,content) values ($1,'agent','file',$2) returning *`, [t.id, content])
  return m
}

// ---------- opening (the owner) ----------
// POST /mail/attachments/:card/:n/open {name, download?} → a plan the page carries out (src/mailAttach.js) — download: a 「내려받기」 address
// whatever the file is:
//   {how: 'office', url (signed storage, OPEN_TTL_S), name, editor, from: 'folder'|'mail', message?, folder?, edited?}
//   {how: 'view', media, url (this server's route, signed for me), name, from}
//   {how: 'download', url, name, from}
export async function open(user, actionId, iRaw, { name, download = false } = {}, deps = {}) {
  const i = attIndex(iRaw)
  if (i == null) throw fail(404, L('첨부를 찾지 못했어요.', "I couldn't find that attachment."))
  const card = await cardOf(user.id, actionId)
  // the attachment is n; its name is the card's (the sheet's list), checked against what the page sent
  const known = knownOf(card, i)
  if (known && name && !sameName(known.name, name)) throw fail(404, L('메일에서 이 첨부를 찾지 못했어요.', "I couldn't find this attachment in the mail."))
  const nm = known?.name || normName(name).slice(0, 300)
  if (!nm) throw fail(400, L('어느 첨부인지 알려 주세요.', 'Say which attachment.'))
  const k = kindOf({ name: nm, type: known?.type || card.source?.att_copies?.[String(i)]?.type })
  const fc = await folderCopyOf(user, card, i, nm)
  const att = { actionId: card.id, i, name: nm, subject: card.source?.subject || '' }
  if (k.kind === 'office' && !download) {
    if (fc) {
      const objKey = await privateBlob(fc.folder, fc.path, fc.sha)
      const m = await folderCard(user, fc, objKey, att)
      return { how: 'office', from: 'folder', editor: k.editor, url: await P.signedUrl(objKey, OPEN_TTL_S), name: m.content.name, message: { id: m.id }, folder: m.content.folder }
    }
    const copy = await ensureCopy(user.id, card, i, nm, deps)
    return { how: 'office', from: 'mail', editor: k.editor, url: await P.signedUrl(copy.key, OPEN_TTL_S), name: copy.name, edited: card.source?.att_edits?.[String(i)] || null }
  }
  // (the route serves the folder's copy when there is one, else the mail's — made now; the copy also tells the route the attachment's
  // name. With a folder copy a mailbox that cannot be read this time does not stop it: the route finds the name in the sheet's row)
  await ensureCopy(user.id, card, i, nm, deps).catch((e) => { if (!fc) throw e })
  const media = k.kind === 'media' && !download
  return { how: media ? 'view' : 'download', ...(media ? { media: k.media } : {}), url: linkFor(card.id, i, user.id, { inline: media }), name: nm, from: fc ? 'folder' : 'mail' }
}

// GET /mail/attachments/:card/:n/raw — what the signed address (or a signed-in owner) may read now: the owner the folder's copy when there
// is one, else the mail's; a colleague (room: the room the address was signed for) the attachment as it arrived, only while the owner
// shares it with that room and they are in it. Anyone else, or a share stopped: 404. → {key, name, type}
export async function rawOf(viewer, actionId, iRaw, { room = '' } = {}, deps = {}) {
  const i = attIndex(iRaw)
  const [card] = i != null && UUID.test(String(actionId || '')) ? await q(`select * from pro_actions where id=$1 and source ? 'mail_id' and status <> 'deleted'`, [String(actionId)]) : []
  if (!card) throw fail(404, L('첨부를 찾지 못했어요.', "I couldn't find that attachment."))
  const owner = String(card.user_id) === String(viewer.id)
  const kept = card.source?.att_copies?.[String(i)]
  if (owner && !room) {
    // (its name: the copy's, else the sheet's row — lib/mailFollow.js keeps the attachments' names on the card)
    const nm = knownOf(card, i)?.name || ''
    const fc = nm ? await folderCopyOf(viewer, card, i, nm) : null
    if (fc) return { key: await privateBlob(fc.folder, fc.path, fc.sha), name: nm, type: rawType(nm, kept?.type) }
    const copy = await ensureCopy(viewer.id, card, i, kept?.name || '', deps)
    return { key: copy.key, name: copy.name, type: rawType(copy.name, copy.type) }
  }
  if (!room) throw fail(404, L('첨부를 찾지 못했어요.', "I couldn't find that attachment."))
  const { memberThread } = await import('./team/messenger.js')
  if (!attSharedWith(card, i, room) || !(await memberThread(viewer, room))) throw fail(404, L('첨부를 찾지 못했어요.', "I couldn't find that attachment."))
  const copy = await ensureCopy(card.user_id, card, i, kept?.name || '', deps)
  return { key: copy.key, name: copy.name, type: rawType(copy.name, copy.type) }
}

// ---------- an edited attachment (not in a folder): the person's own private file card ----------
// POST /mail/attachments/:card/:n/saved — the editor saved its copy beside the mail's (office-host: edited-<stem>_<time>.<ext> in the same
// private folder); the newest one there becomes a file card in the person's chat (private: no address, opened by a signed one — lib/fileCards.js),
// or that card again for later saves of the same session. The card says where it is (source.att_edits[n]).
export async function saved(user, actionId, iRaw, { session = '' } = {}) {
  const i = attIndex(iRaw)
  if (i == null) throw fail(404, L('첨부를 찾지 못했어요.', "I couldn't find that attachment."))
  const card = await cardOf(user.id, actionId)
  const copy = card.source?.att_copies?.[String(i)]
  if (!copy?.key) throw fail(404, L('열어 둔 첨부를 찾지 못했어요.', "I couldn't find the attachment that was opened."))
  const dir = P.dirOf(copy.key)
  const k = await P.newest(`${dir}/edited-`)
  if (!k || !P.editedIn(dir, k)) throw fail(404, L('저장한 편집본을 찾지 못했어요.', "I couldn't find the saved copy."))
  const sid = String(session || '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 40)
  const att = { actionId: card.id, i, name: copy.name, subject: card.source?.subject || '', from: MM.senderOf(card.source?.from).name || '' }
  const { mainThread, addMessage } = await import('./store.js')
  const t = await mainThread(user.id)
  // the same editing session (or the same saved object) is one card
  const [had] = await q(`select m.* from pro_messages m join pro_threads th on th.id=m.thread_id where th.user_id=$1 and m.kind='file' and m.content->'mailAtt'->>'actionId'=$2
                         and (m.content->'mailAtt'->>'i')::int=$3 and (m.content->'private'->>'key'=$4 or ($5 <> '' and m.content->>'session'=$5)) order by m.created_at desc limit 1`,
  [user.id, card.id, i, k, sid])
  let m
  if (had) {
    ;[m] = await q(`update pro_messages set content = (content - 'url') || $2::jsonb where id=$1 returning *`, [had.id, JSON.stringify({ private: { key: k }, edited: true, savedAt: new Date().toISOString() })])
    emit(user.id, 'message', m)
  } else {
    m = await addMessage(user.id, t.id, 'agent', 'file', { name: copy.name, ext: P.extOf(copy.name), private: { key: k }, edited: true, mailAtt: att, ...(sid ? { session: sid } : {}), savedAt: new Date().toISOString() })
  }
  const [row] = await q(`update pro_actions set source = jsonb_set(source, '{att_edits}', coalesce(source->'att_edits', '{}'::jsonb) || jsonb_build_object($2::text, $3::jsonb))
                         where id=$1 and user_id=$4 returning *`, [card.id, String(i), JSON.stringify({ msgId: m.id, threadId: m.thread_id, at: new Date().toISOString() }), user.id])
  if (row) emit(user.id, 'action', row)
  return { message: m, where: 'chat' }
}

// Which way an editor's save of a file card goes (POST /messages/:id/file): 'private' — a private card saved into the private bucket
// (savePrivateCard); 'refuse' — a private card the editor answered with any other address (never put an address on it); 'public' —
// every other card, as before. Decided by the card and the bucket of the address together (review 11-25 #2).
export function saveKindOf(card, url) {
  const priv = !!card?.content?.private?.key
  const inPrivate = P.objectOfUrl(url)?.bucket === P.BUCKET
  return priv ? (inPrivate ? 'private' : 'refuse') : 'public'
}
// A private file card's save (POST /messages/:id/file, the card has no address): the editor's copy must be one of ours beside it — a
// folder copy is committed to the folder (its editors only), a mail attachment's edit keeps the card on the newest copy. Never an address.
// → the message (updated), or null when this is not a private card
export async function savePrivateCard(user, m, { url, session } = {}) {
  const c = m?.content || {}
  if (!c.private?.key) return null
  const obj = P.objectOfUrl(url)
  if (!obj || obj.bucket !== P.BUCKET) throw fail(400, L('저장한 편집본을 찾지 못했어요.', "I couldn't find the saved copy."))
  if (c.folder?.slug && c.folder.editable === true) {
    const S = await import('./folders/service.js')
    let save
    try {
      const { folder } = await S.access(c.folder.slug, user, 'editor')
      const r = await S.saveOfficeEdit(folder, { name: user.name, email: user.email, id: user.id }, { path: c.folder.path, base: c.folder.sha, url, session: String(session || m.id) })
      if (r.commit) {
        await (await import('./folders/indexer.js')).reindex(folder, { cards: false }).catch((e) => console.warn('[mail-att] index', e.code || e.name || 'error'))
      }
      save = { ok: true, path: r.path, copied: r.copied, at: new Date().toISOString() }
      const [u] = await q(`update pro_messages set content = (content - 'url') || jsonb_build_object('folder', $2::jsonb, 'folder_save', $3::jsonb, 'edited', true) where id=$1 returning *`,
        [m.id, { ...c.folder, path: r.path, sha: r.sha }, save])
      return u
    } catch (e) {
      const [u] = await q(`update pro_messages set content = (content - 'url') || jsonb_build_object('folder_save', $2::jsonb) where id=$1 returning *`, [m.id, { ok: false, error: e.message, at: new Date().toISOString() }])
      return u
    }
  }
  const dir = P.dirOf(c.private.key)
  if (c.folder || !P.editedIn(dir, obj.key) || !obj.key.startsWith(P.mailPrefix({ tenant: T(), userId: user.id, actionId: c.mailAtt?.actionId || '00000000-0000-0000-0000-000000000000', i: Number(c.mailAtt?.i ?? -1) }))) {
    throw fail(400, L('이 파일의 편집본이 아니에요.', "That isn't a copy of this file."))
  }
  const [u] = await q(`update pro_messages set content = (content - 'url') || $2::jsonb where id=$1 returning *`, [m.id, JSON.stringify({ private: { key: obj.key }, edited: true, savedAt: new Date().toISOString() })])
  return u
}
// a private card opened (lib/fileCards.js openFileCard): its content with a signed address for this opening — never stored
export async function openPrivateCard(c) {
  if (!c?.private?.key) return null
  return { ...c, url: await P.signedUrl(c.private.key, OPEN_TTL_S) }
}

// ---------- the AI chat: the attachment as a file the agent reads ----------
// The private copy, handed over the way chat attachments are (lib/attachments.js): into the agent's workspace when that is on this
// machine (a path, no address at all), else a signed storage address for AGENT_TTL_S. copies: an address always (a CLI on the person's PC).
// deps.workspace(): the workspace's host folder or null (tests) → {line, shown, handed: {path, sha256}, pages: [{path, sha256}]} — handed:
// what this turn gave the agent, so the turn's end never makes a file card (a public copy) of it again (lib/agent.js delegate — review
// 11-25 #1); pages: the same for a TIFF's page pictures.
// A TIFF (a fax — 2026-11-25 「tif 파일을 웹에서 못 열어보나?」) also goes as its pages, each a PNG (lib/tiff.js), so a model that reads
// pictures reads the fax: beside it in the workspace, else private objects beside the copy (<copy's folder>/page-<n>.png) by signed address.
export async function agentFile(user, actionId, iRaw, name, { copies = false } = {}, deps = {}) {
  const i = attIndex(iRaw)
  if (i == null) throw fail(404, L('첨부를 찾지 못했어요.', "I couldn't find that attachment."))
  const card = await cardOf(user.id, actionId)
  const copy = await ensureCopy(user.id, card, i, name, deps)
  // (a copy made before its full hash was kept: read once to know it)
  let buf = copy.buf || null
  let sha256 = copy.sha256 || null
  if (!sha256) { buf ||= (await P.bytes(copy.key)).buf; sha256 = crypto.createHash('sha256').update(buf).digest('hex') }
  const subject = clean(card.source?.subject) || L('(제목 없음)', '(no subject)')
  const shown = { as: 'mailatt', name: copy.name, actionId: card.id, i, subject }
  const of = L(`메일 「${subject}」의 첨부`, `an attachment of the mail "${subject}"`)
  // a TIFF: its pages as pictures (a damaged or giant one: the agent is told why there are none — it still has the file)
  let pics = null
  if (isTiffName(copy.name, copy.type) || (buf && isTiffBytes(buf))) {
    buf ||= (await P.bytes(copy.key)).buf
    pics = isTiffBytes(buf) ? await (deps.tiffToPngs || tiffToPngs)(buf).catch((e) => ({ error: e })) : { error: { code: 'broken' } }
    if (pics.error && !pics.error.code) console.warn('[mail-att] tiff', pics.error.name || 'error')
  }
  const extra = (pics?.pages || []).map((p, n) => ({ name: pageName(copy.name, n + 1), buf: p.png, sha256: crypto.createHash('sha256').update(p.png).digest('hex') }))
  if (!copies) {
    // (the error's code only: a file system message names the file)
    const rel = await toWorkspace(user, { ...copy, buf }, deps, extra).catch((e) => { console.warn('[mail-att] workspace', e.code || e.name || 'error'); return null })
    if (rel) {
      const pages = extra.map((x) => ({ path: path.posix.join(path.posix.dirname(rel), fileName(x.name)), sha256: x.sha256 }))
      return { line: L(`- ${rel} (${copy.name} · ${of})`, `- ${rel} (${copy.name} · ${of})`) + pagesLine(pics, pages.map((x) => x.path)), shown, handed: { path: rel, sha256 }, pages }
    }
  }
  const url = await P.signedUrl(copy.key, AGENT_TTL_S)
  const urls = []
  for (const [n, x] of extra.entries()) {
    const k = `${P.dirOf(copy.key)}/page-${n + 1}.png`
    await P.put(k, x.buf, 'image/png')
    urls.push(await P.signedUrl(k, AGENT_TTL_S))
  }
  return { line: L(`- ${copy.name} (${of}) — 비공개 주소예요. ${AGENT_TTL_S / 60}분 안에 받아 읽으세요: ${url}`, `- ${copy.name} (${of}) — a private address, open for ${AGENT_TTL_S / 60} minutes; download it and read it: ${url}`)
    + pagesLine(pics, urls, true), shown, handed: { path: null, sha256 }, pages: extra.map((x) => ({ path: null, sha256: x.sha256 })) }
}
// the words that hand a TIFF's page pictures over (paths in the workspace, or signed addresses), or why there are none
export function pagesLine(pics, where, signed = false) {
  if (!pics) return ''
  if (pics.error || !where.length) {
    const [ko, en] = reasonOf(pics.error)
    return L(`\n  (이 TIFF 는 ${ko} 쪽 그림으로 바꾸지 못했어요.)`, `\n  (This TIFF could not be turned into page pictures: ${en}.)`)
  }
  const list = where.map((w, n) => `${n + 1}쪽 ${w}`).join(', ')
  const listEn = where.map((w, n) => `page ${n + 1} ${w}`).join(', ')
  const more = pics.total > where.length ? L(` (전체 ${pics.total}쪽 가운데 앞 ${where.length}쪽)`, ` (the first ${where.length} of ${pics.total} pages)`) : ''
  return signed
    ? L(`\n  팩스·TIFF 라서 쪽마다 그림(PNG)으로 바꿔 두었어요 — 그림을 보고 읽으세요(비공개 주소, ${AGENT_TTL_S / 60}분)${more}: ${list}`,
      `\n  A fax/TIFF: each page is also a PNG picture — look at the pictures to read it (private addresses, ${AGENT_TTL_S / 60} minutes)${more}: ${listEn}`)
    : L(`\n  팩스·TIFF 라서 쪽마다 그림(PNG)으로도 두었어요 — 그림을 열어 보고 읽으세요${more}: ${list}`, `\n  A fax/TIFF: each page is also a PNG picture beside it — open the pictures to read it${more}: ${listEn}`)
}
const fileName = (raw) => {
  const n = path.basename(String(raw || 'file')).replace(/[\u0000-\u001f\\/:*?"<>|]/g, '_').trim()
  return n && n !== '.' && n !== '..' ? n.slice(0, 160) : 'file'
}
// Into the agent's workspace, where anything in the sandbox can also write (local · Docker): a folder of its own, named at random for this
// one write (as lib/attachments.js — nobody can lay a link there beforehand), every folder on the way checked to be a plain folder and
// not a link, and the file created new without following a link (O_EXCL | O_NOFOLLOW) — review 11-25 #6. → the sandbox path, or null
// extra: more files for the same folder ([{name, buf}] — a TIFF's page pictures), written the same way
export async function toWorkspace(user, copy, deps = {}, extra = []) {
  const { workspaceHostPath } = await import('./missions.js')
  const { PGPT_ROOT } = await import('./paths.js')
  // (the tenant's own workspace folder first: deepagents keeps one per tenant — lib/attachments.js)
  const shared = path.join(PGPT_ROOT, 'services', 'deepagents', 'workspace')
  if (!deps.workspace && await fs.stat(shared).then((x) => x.isDirectory(), () => false)) await fs.mkdir(path.join(shared, config.tenantId), { recursive: true }).catch(() => {})
  const root = deps.workspace ? await deps.workspace() : await workspaceHostPath('/workspace').catch(() => null)
  if (!root) return null
  const realRoot = await fs.realpath(root)
  const parts = ['uploads', String(user.id), 'mail', crypto.randomUUID()]
  let dir = realRoot
  for (const [k, seg] of parts.entries()) {
    dir = path.join(dir, seg)
    // the random folder is made here and must be new; the ones above it may be there already — as plain folders only
    if (k === parts.length - 1) await fs.mkdir(dir, { mode: 0o700 })
    else await fs.mkdir(dir, { mode: 0o755 }).catch((e) => { if (e.code !== 'EEXIST') throw e })
    const st = await fs.lstat(dir)
    if (st.isSymbolicLink() || !st.isDirectory()) throw Object.assign(new Error('not a plain folder'), { code: 'ENOTDIR' })
  }
  if ((await fs.realpath(dir)) !== dir) throw Object.assign(new Error('the folder moved'), { code: 'ENOTDIR' })
  const name = fileName(copy.name)
  const write = async (n, buf) => {
    const fh = await fs.open(path.join(dir, n), fsConst.O_WRONLY | fsConst.O_CREAT | fsConst.O_EXCL | (fsConst.O_NOFOLLOW || 0), 0o600)
    try { await fh.writeFile(buf) } finally { await fh.close() }
  }
  await write(name, copy.buf || (await P.bytes(copy.key)).buf)
  for (const x of extra) await write(fileName(x.name), x.buf)
  return `/workspace/${parts.join('/')}/${name}`
}

// a dropped attachment → what the chip shows (lib/fileRefs.js resolve): the mail's name for it, from the card when it has a copy, else the mail
export async function resolveAtt(user, actionId, iRaw, name) {
  const i = attIndex(iRaw)
  if (i == null) throw fail(404, L('첨부를 찾지 못했어요.', "I couldn't find that attachment."))
  const card = await cardOf(user.id, actionId)
  const meta = await metaOf(user.id, card, i, name)
  const who = MM.senderOf(card.source?.from)
  return { as: 'mailatt', name: meta.name, att: { actionId: card.id, i, name: meta.name, size: meta.size, subject: card.source?.subject || '', from: who.name } }
}
// the attachment's name, size and type as the card knows them (knownOf) — a chip and a messenger mention never read the mailbox or the
// bytes (review 11-25 #3). A card that knows nothing of it yet (its sheet never opened): the sheet is where a chip comes from.
async function metaOf(ownerId, card, i, name) {
  const k = knownOf(card, i)
  if (k && (!name || sameName(k.name, name))) return k
  throw fail(404, L('메일 시트에서 첨부를 다시 골라 주세요.', 'Pick the attachment again from the mail sheet.'))
}

// ---------- the messenger ----------
// the owner shares attachment n with a room, or no longer (their own card only)
export async function setShare(ownerId, actionId, iRaw, roomId, on) {
  const i = attIndex(iRaw)
  const room = String(roomId || '')
  if (i == null || !ROOM.test(room)) throw fail(400, L('대화방을 알 수 없어요.', "I don't know which room."))
  const [row] = on
    ? await q(`update pro_actions set source = jsonb_set(jsonb_set(source, '{att_share}', coalesce(source->'att_share', '{}'::jsonb)), array['att_share', $3::text],
                 coalesce(source->'att_share'->$3, '{}'::jsonb) || jsonb_build_object($4::text, jsonb_build_object('at', now())))
               where id=$1 and user_id=$2 and status <> 'deleted' returning *`, [actionId, ownerId, String(i), room])
    : await q(`update pro_actions set source = jsonb_set(jsonb_set(source, '{att_share}', coalesce(source->'att_share', '{}'::jsonb)), array['att_share', $3::text],
                 coalesce(source->'att_share'->$3, '{}'::jsonb) - $4::text)
               where id=$1 and user_id=$2 and status <> 'deleted' returning *`, [actionId, ownerId, String(i), room])
  if (!row) throw fail(404, L('메일을 찾지 못했어요.', "I couldn't find that mail."))
  emit(ownerId, 'action', row)
  return row
}
// The rooms the owner shares this mail's attachments with, for the mail sheet — with each room's name, also a room the owner has left
// (review 11-25 #5: the share stays on the card, and only its owner can take it back) → {shares: [{i, name, room, title, at}]}
export async function sharesOf(user, actionId) {
  const card = await cardOf(user.id, actionId)
  const list = []
  for (const [n, rooms] of Object.entries(card.source?.att_share || {})) {
    for (const [room, v] of Object.entries(rooms || {})) list.push({ i: Number(n), name: knownOf(card, Number(n))?.name || '', room, at: v?.at || null })
  }
  const ids = [...new Set(list.map((x) => x.room))]
  // (a room's name, else — a room of two — the other people in it, as the messenger names it for this person)
  const others = (ps) => (Array.isArray(ps) ? ps : []).filter((p) => p && !p.is_agent && String(p.id) !== String(user.id)).map((p) => p.username || p.email || '').filter(Boolean).join(', ')
  const titles = ids.length ? Object.fromEntries((await q('select id, name, participants from chat_rooms where id = any($1) and tenant_id=$2', [ids, T()])).map((r) => [r.id, r.name || others(r.participants)])) : {}
  return { shares: list.map((x) => ({ ...x, title: titles[x.room] || '' })).sort((a, b) => a.i - b.i || String(a.at).localeCompare(String(b.at))) }
}
// 「끄기」 on the mail sheet: the owner stops sharing attachment n with a room — no need to be in it (still or any more)
export async function unshare(user, actionId, iRaw, room) {
  const i = attIndex(iRaw)
  if (i == null) throw fail(404, L('첨부를 찾지 못했어요.', "I couldn't find that attachment."))
  const card = await cardOf(user.id, actionId)
  await setShare(user.id, card.id, i, room, false)
  // the room's messages that mention it say so at once (each member's card follows: no 「열기」 any more — the card decides either way)
  const rows = await q(`select uuid, id, messages from chats where id=$1 and tenant_id=$2 and messages->'pgpt'->'refs' @> $3::jsonb`,
    [String(room), T(), JSON.stringify([{ type: 'mailatt', actionId: card.id, i }])]).catch(() => [])
  const { deliver } = await import('./team/messenger.js')
  for (const row of rows) {
    const refs = row.messages?.pgpt?.refs || []
    for (const [k, r] of refs.entries()) {
      if (r?.type !== 'mailatt' || String(r.actionId) !== String(card.id) || Number(r.i) !== i || String(r.owner) !== String(user.id)) continue
      await q(`update chats set messages = jsonb_set(messages, $2::text[], $3::jsonb) where uuid=$1 and tenant_id=$4`, [row.uuid, ['pgpt', 'refs', String(k)], JSON.stringify({ ...r, share: null, sharedAt: null }), T()])
    }
    await deliver(row.uuid)
  }
  return sharesOf(user, card.id)
}
// an attachment mention to send, checked as the sender (the owner): {type: 'mailatt', actionId, i, name?, share?} → what the message keeps;
// 「파일도 공유」 (share) is recorded on the owner's card for that room
export async function forSend(user, x, { roomId = null } = {}) {
  const i = attIndex(x?.i)
  if (i == null) throw fail(400, L('첨부가 올바르지 않아요.', 'The attachment is not valid.'))
  const card = await cardOf(user.id, x.actionId)
  const meta = await metaOf(user.id, card, i, x.name ? String(x.name) : '')
  if (x.share === true) {
    const { memberThread } = await import('./team/messenger.js')
    const t = await memberThread(user, roomId)
    if (!t) throw fail(404, L('대화를 찾지 못했어요.', "I couldn't find that conversation."))
    await setShare(user.id, card.id, i, t.id, true)
  }
  const who = MM.senderOf(card.source?.from)
  return { type: 'mailatt', actionId: card.id, i, owner: user.id, ownerName: user.name || '', name: meta.name, size: meta.size || 0, subject: card.source?.subject || '',
    from: who.name, domain: who.domain, date: card.created_at, share: x.share === true ? 'room' : null, ...(x.share === true ? { sharedAt: new Date().toISOString() } : {}) }
}
const requestUrl = (roomId, messageId) => `/pro/team/${roomId}/${messageId}`
// each viewer's state of an attachment mention (lib/fileRefs.js decorate) → {card, share} — the owner's card decides, for this room
export async function stateOf(viewer, r, m) {
  const mine = String(r.owner || '') === String(viewer.id)
  const card = await ownersCard(r).catch(() => null)
  const share = card && attSharedWith(card, r.i, m.threadId) ? 'room' : null
  let requested = false
  if (!mine && card && !share) {
    const [asked] = await q(`select 1 from notifications where tenant_id=$1 and type='mail_access' and from_user_id=$2 and url=$3 and coalesce(is_checked, false) = false limit 1`,
      [T(), viewer.email || viewer.id, requestUrl(m.threadId, m.id)]).catch(() => [])
    requested = !!asked
  }
  return { card: attRefState({ mine, share, requested, gone: !card }), share }
}
// 「열기」 on a mention: the owner — their own attachment (the page opens it as from the sheet); someone the owner shared it with (this
// room) — read only: a document in the editor (a signed address), a picture · sound · video in the viewer and anything else downloaded
// (this server's route, signed for them and this room); anyone else — refused (403)
export async function openRef(viewer, row, r, deps = {}) {
  if (String(r.owner) === String(viewer.id)) {
    await cardOf(viewer.id, r.actionId)
    return { type: 'mailatt', mine: true, actionId: r.actionId, i: r.i, name: r.name }
  }
  const card = await ownersCard(r)
  if (!card) throw fail(404, L('첨부를 찾을 수 없어요.', "The attachment can't be found."))
  if (!attSharedWith(card, r.i, row.id)) throw fail(403, L('메일 주인이 이 첨부를 공유하지 않았어요. 「열기 요청」을 보내 보세요.', "The mail's owner hasn't shared this attachment. Ask to open it."), 'att_summary')
  const copy = await ensureCopy(card.user_id, card, r.i, r.name || '', deps)
  const k = kindOf({ name: copy.name, type: copy.type })
  if (k.kind === 'office') return { type: 'mailatt', mine: false, plan: { how: 'office', editor: k.editor, url: await P.signedUrl(copy.key, OPEN_TTL_S), name: copy.name, readOnly: true } }
  const media = k.kind === 'media'
  return { type: 'mailatt', mine: false, plan: { how: media ? 'view' : 'download', ...(media ? { media: k.media } : {}), url: linkFor(card.id, r.i, viewer.id, { room: row.id, inline: media }), name: copy.name } }
}
// 「열기 요청」: the owner is told once (a notice that opens the messenger at that message, where 「파일 공유」 is)
export async function request(viewer, row, r) {
  if (String(r.owner) === String(viewer.id)) return { requested: false, open: true }
  const card = await ownersCard(r)
  if (!card) throw fail(404, L('첨부를 찾을 수 없어요.', "The attachment can't be found."))
  if (attSharedWith(card, r.i, row.id)) return { requested: false, open: true }
  const url = requestUrl(row.id, row.uuid)
  const [u] = await q('select id::text as id, email from users where id::text=$1 and tenant_id=$2', [String(r.owner), T()])
  if (u) {
    const [dup] = await q(`select 1 from notifications where tenant_id=$1 and user_id = any($2) and type='mail_access' and url=$3 and from_user_id=$4 and coalesce(is_checked, false) = false limit 1`, [T(), [u.id, u.email], url, viewer.email || viewer.id])
    if (!dup) {
      await q(`insert into notifications(id,user_id,title,type,description,url,from_user_id,tenant_id) values (gen_random_uuid(),$1,$2,'mail_access',$3,$4,$5,$6)`,
        [u.id, L(`${viewer.name}님이 메일 첨부 열기를 요청했어요`, `${viewer.name} asked to open a mail attachment`).slice(0, 200),
          L(`멘션한 첨부 「${r.name || ''}」를 열어 보고 싶어 해요. 메신저의 그 카드에서 「파일 공유」를 누르면 이 대화방 사람들이 열 수 있어요.`,
            `They want to open the attachment "${r.name || ''}" you mentioned. Press "Share the file" on its card in the messenger to let this room open it.`), url, viewer.email || viewer.id, T()])
      emit(u.id, 'notifications', {})
    }
  }
  return { requested: true }
}
// 「파일 공유」 · 「공유 그만두기」 (the owner only): the room can open it, or no longer — every member's card changes at once
export async function share(owner, row, index, on) {
  const r = (row.messages?.pgpt?.refs || [])[index]
  if (!r || r.type !== 'mailatt') throw fail(404, L('멘션한 첨부를 찾지 못했어요.', "I couldn't find the mentioned attachment."))
  if (String(r.owner) !== String(owner.id)) throw fail(403, L('메일 주인만 첨부를 공유할 수 있어요.', "Only the mail's owner can share the attachment."), 'not_owner')
  await cardOf(owner.id, r.actionId)
  await setShare(owner.id, r.actionId, r.i, row.id, on)
  const next = { ...r, share: on ? 'room' : null, ...(on ? { sharedAt: new Date().toISOString() } : { sharedAt: null }) }
  const [updated] = await q(`update chats set messages = jsonb_set(messages, $2::text[], $3::jsonb) where uuid=$1 and tenant_id=$4 returning uuid, id, messages`,
    [row.uuid, ['pgpt', 'refs', String(index)], JSON.stringify(next), T()])
  // the requests are answered once every attachment of this message the owner mentioned is open to the room (a request names the message,
  // not one of its files — the notice opens the messenger there)
  if (on) {
    const atts = (row.messages?.pgpt?.refs || []).map((x, k) => [x, k]).filter(([x]) => x?.type === 'mailatt' && String(x.owner) === String(owner.id))
    const card = await cardOf(owner.id, r.actionId)
    const all = atts.every(([x]) => String(x.actionId) !== String(card.id) || attSharedWith(card, x.i, row.id))
    if (all) await q(`update notifications set is_checked=true where tenant_id=$1 and type='mail_access' and url=$2`, [T(), requestUrl(row.id, row.uuid)]).catch(() => {})
  }
  return updated
}
