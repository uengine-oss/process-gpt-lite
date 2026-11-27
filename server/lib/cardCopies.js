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
import { q, admin, pool } from './supa.js'
import { objectOfUrl } from './privateStore.js'
import { extOf, editable, EDITOR_BY_EXT } from './office.js'
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
  // (already on a copy of its own — kept before, e.g. for a 「다른 이름으로 저장」 tried again): nothing to do. Not the editor's own copy of a
  // file under copies/ (copies/edited-…_<time>: a card opened from a copy and saved) — that one the editor is about to write over: kept
  if (o.bucket === BUCKET && o.key.startsWith(`${ownPrefix(user)}copies/`) && !EDITED.test(baseOf(o.key))) return m
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

// ---------- copies nothing points at any more ----------
// The copies made here (pgpt-pro/<person>/copies/<uuid>.<ext>, and the editor's own copy of one opened from there,
// copies/edited-<uuid>_<time>.<ext>) are left behind when their card moves on — a save after keepVersion, a card or thread deleted. Once
// a month past their last write (greatest of created_at and updated_at: a copy written over again is not old) and named by nothing that
// may still need it, they go.
// What the job relies on (spec folder-edit-save) — only what names a copy now, never how a card came to stand where it does:
//   - a card's address moves: its save keeps the address before in `versions` (POST /api/messages/:id/file, the ask-a-teammate draft);
//     keepVersion moves a card off the editor's copy of this opening onto a copy of its own and keeps no record of that copy (the editor
//     writes over it; the frame may still hand it back as its last save — a moment later, never a month); a folder's card follows the
//     folder's newest version (lib/fileRefs.js — a folder's address, never a copy here); a card, or a thread with its cards, can be
//     deleted (lib/folders/filing.js drops a card just made twice). Whatever stops naming a copy lets it go once it is a month unwritten.
//   - so everything that can name a copy is looked at, every run: pro_messages (every message's content — cards, their versions, any text
//     that quotes an address), pro_shares.object_key (a share's object) and SCANS below — a 참조's message · used · requestable, a
//     schedule's prompt · params · state, a 내 PC job (the whole row), a 후행 습관's files, a direct message's body · artifacts, a draft
//     job's args, Process GPT's todolist output · output_url · draft where it is in the same database. A scan that fails stops the run
//     (nothing is removed on a partial picture). Not looked at — they hold ids, never storage addresses: pro_meeting_materials (ref: ids
//     only), pro_context_shares.
// PRO_COPIES_GC: off · dry (this release's default: logs each key and size it would remove) · on (removes, and logs each key removed).
// Its own nightly run (PRO_COPIES_GC_CRON, default 03:30 KST), one server at a time (a session advisory lock, on one connection of the
// pool — behind a transaction-mode pooler that would not hold: production runs one server, review #111), at most MAX_PER_RUN a night,
// paged by (age, name) so copies still named never hold the rest back.
// Exactly the two names made here: copyToOwn's copies/<uuid>.<ext> and the office host's edited copy of one, editedObjectPath:
// edited-<stem>_<yyyymmddhhmmss>.<ext> with the stem of the copy (an edited copy of an edited copy keeps the first stem) — <ext> the card's
// format, lower case (extOf here, the host's extname().toLowerCase()), one of the formats an editor opens. Anything else under copies/ is not
// this job's.
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const EXTS = Object.keys(EDITOR_BY_EXT).filter((e) => /^[a-z0-9]{1,8}$/.test(e)).sort((a, b) => b.length - a.length).join('|')
export const COPY_NAME_RE = `^pgpt-pro/${UUID}/copies/(edited-${UUID}_[0-9]{14}|${UUID})\\.(${EXTS})$`
// the same in a text that names it — as a key or an address, also percent-encoded (%2F), and not the start of a longer name
const SEP = '(?:/|%2[Ff])'
const COPY_KEY = new RegExp(`pgpt-pro${SEP}(${UUID})${SEP}copies${SEP}((?:edited-${UUID}_[0-9]{14}|${UUID})\\.(?:${EXTS}))(?![A-Za-z0-9])`, 'g')
const MAX_PER_RUN = 1000
const LOCK = 'pgpt-lite/copies-gc'
// where an address of a copy may be kept, besides the file cards — [table, column] (column null: the whole row), each looked at only where
// it is (a database without that feature has no such table or column). pro_messages and pro_shares are always there.
const SCANS = [
  ['pro_refers', 'message'], ['pro_refers', 'used'], ['pro_refers', 'requestable'],
  ['pro_schedules', 'prompt'], ['pro_schedules', 'params'], ['pro_schedules', 'state'],
  ['pro_local_jobs', null],
  ['pro_followups', 'files'],
  ['pro_dm_messages', 'body'], ['pro_dm_messages', 'artifacts'],
  ['pro_draft_jobs', 'args'],
  ['todolist', 'output'], ['todolist', 'output_url'], ['todolist', 'draft'],
]
// (a text that may hold one: /copies/ as it is or percent-encoded)
const MAY_NAME = '(/|%2[Ff])copies(/|%2[Ff])'

// the copies anything still names → Set of keys
async function namedCopies() {
  const used = new Set()
  const note = (text) => { for (const k of String(text || '').matchAll(COPY_KEY)) used.add(`pgpt-pro/${k[1]}/copies/${k[2]}`) }
  const tables = new Set((await q(`select table_name as t from information_schema.tables where table_schema='public'`)).map((r) => r.t))
  const columns = new Set((await q(`select table_name || '.' || column_name as c from information_schema.columns where table_schema='public'`)).map((r) => r.c))
  for (const r of await q(`select content::text as t from pro_messages where content::text ~ $1`, [MAY_NAME])) note(r.t)
  for (const r of await q(`select object_key as t from pro_shares where object_key ~ $1`, [MAY_NAME])) note(r.t)
  for (const [table, column] of SCANS) {
    if (!tables.has(table) || (column && !columns.has(`${table}.${column}`))) continue
    // (names from the list above only — never from input)
    const what = column ? `"${column}"::text` : 'x::text'
    for (const r of await q(`select ${what} as t from "${table}" x where ${what} ~ $1`, [MAY_NAME])) note(r.t)
  }
  return used
}

/** the copies a month past their last write that nothing names → [{key, size}] (at most `max`); prefix: only under it (tests) */
export async function unusedCopies({ days = 30, prefix = 'pgpt-pro/', max = MAX_PER_RUN, page = 500 } = {}) {
  const used = await namedCopies()
  const out = []
  let after = null
  for (;;) {
    // (the age goes back as text: a JS Date keeps milliseconds only, and a row whose time has microseconds would come round again)
    const rows = await q(`select name, greatest(created_at, coalesce(updated_at, created_at))::text as age, coalesce((metadata->>'size')::bigint, 0) as size
                         from storage.objects
                         where bucket_id=$1 and name like $2 and name ~ $3
                           and greatest(created_at, coalesce(updated_at, created_at)) < now() - make_interval(days => $4::int)
                           and ($5::timestamptz is null or (greatest(created_at, coalesce(updated_at, created_at)), name) > ($5::timestamptz, $6::text))
                         order by greatest(created_at, coalesce(updated_at, created_at)), name limit $7`, [BUCKET, `${prefix}%`, COPY_NAME_RE, days, after?.age ?? null, after?.name ?? '', page])
    for (const r of rows) {
      if (used.has(r.name)) continue
      out.push({ key: r.name, size: Number(r.size) || 0 })
      if (out.length >= max) return out
    }
    if (rows.length < page) return out
    after = rows[rows.length - 1]
  }
}

/** one run: {mode, count, keys} — dry lists, on removes; busy when another server runs it */
export async function cleanCopies({ mode = config.copiesGc, ...opts } = {}) {
  if (mode !== 'on' && mode !== 'dry') return { mode: 'off', count: 0, keys: [] }
  const client = await pool.connect()
  try {
    const got = (await client.query('select pg_try_advisory_lock(hashtext($1)) as ok', [LOCK])).rows[0]?.ok
    if (!got) return { mode, busy: true, count: 0, keys: [] }
    try {
      const list = await unusedCopies(opts)
      if (mode === 'dry') {
        for (const c of list) console.log(`[copies gc] dry: would remove ${c.key} (${c.size} B)`)
        return { mode, count: list.length, keys: list.map((c) => c.key) }
      }
      const keys = list.map((c) => c.key)
      for (let i = 0; i < keys.length; i += 100) {
        const part = keys.slice(i, i + 100)
        const { error } = await admin.storage.from(BUCKET).remove(part)
        if (error) throw new Error(error.message)
        for (const k of part) console.log(`[copies gc] removed ${k}`)
      }
      return { mode, count: keys.length, keys }
    } finally { await client.query('select pg_advisory_unlock(hashtext($1))', [LOCK]).catch(() => {}) }
  } finally { client.release() }
}

// the nightly run (PRO_BACKGROUND=0 never starts it: index.js) — its own schedule and switch, apart from the folders' gc
let timer = null
export function startCopiesGc(cron = config.copiesGcCron) {
  if (timer || !cron || cron === 'off' || config.copiesGc === 'off') return
  const plan = async () => {
    const { nextRun } = await import('./scheduler.js')
    const at = nextRun(cron)
    if (!at) return console.warn(`[copies gc] no next run for '${cron}'`)
    timer = setTimeout(async () => {
      try {
        const r = await cleanCopies()
        if (r.busy) console.log('[copies gc] another server is running it')
        else console.log(`[copies gc] ${r.mode}: ${r.count} copies nothing names${r.mode === 'dry' ? ' (not removed — PRO_COPIES_GC=on removes)' : ' removed'}`)
      } catch (e) { console.warn(`[copies gc] ${e.message}`) }
      timer = null
      plan()
    }, Math.max(1000, at.getTime() - Date.now()))
    timer.unref?.()
  }
  plan()
}
