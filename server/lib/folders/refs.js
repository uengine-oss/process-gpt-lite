// Folder references (폴더 참조 — spec openspec/specs/folder-refs, design P0). A managed shared folder can hold 「참조 자리」: a path in
// it (the slot) that points at another folder of the same company — the whole folder, a sub-folder of it, or one file — whose content
// stays there (the source). A reference is a row the server keeps (pro_folder_refs, sql/065); nothing goes into the folder's git tree
// (no gitlink, no .gitmodules), so the rules on what a folder's tree may hold do not change.
//
// Everything that reads through a slot goes through resolve(), here and nowhere else: on every read it looks at the reader's role in
// the source now (service.js roleOf). A member of the composing folder who is not a member of the source sees a locked slot — its
// label only: no name, path, count, version or content of the source. A slot is named 「참조 N」 unless the person adding it names it
// (the name is what every member sees). A reference inside a referenced folder is not followed (depth 1): the source is read from its
// own git tree, never through its own references. The source is found again in this company on every read.
// In the composing folder the slot wins and is read only: a person's write there is refused, what a commit of this server would sweep
// up there is left out of it (and left where it is — nothing is deleted), and a file a commit from elsewhere put there later stays
// hidden while the slot is there.
import fs from 'node:fs/promises'
import path from 'node:path'
import { config } from '../../config.js'
import { q, ENGINE_TZ } from '../supa.js'
import { emit } from '../bus.js'
import { linkOnPath } from '../noLinks.js'
import { L } from '../lang.js'
import { ro } from '../josa.js'
import * as G from './git.js'
import * as S from './service.js'

const T = () => config.tenantId
const err = (status, message, code) => Object.assign(new Error(message), { status, ...(code ? { code } : {}) })
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const MAX_REFS = 200
// how much of the slots' files is listed: one slot in the tree, the whole tree, and what an agent is handed at once (the rest is said
// to be there — `count` · `more` — and read through the tools or the original folder)
export const SLOT_FILES = 2000
export const TREE_FILES = 5000
export const AGENT_FILES = 400
const AT_ONCE = 4

// what a route answers for an error: its own words when it has a status, never a server's internal message otherwise
export function answerOf(e) {
  if (e?.status) return { status: e.status, body: { error: e.message, ...(typeof e.code === 'string' && e.code.startsWith('ref_') ? { code: e.code } : {}) } }
  return { status: 500, body: { error: L('처리하지 못했어요. 잠시 뒤 다시 해 주세요.', "That didn't work. Please try again in a moment.") } }
}

// at most `n` at once
export async function eachLimit(items, n, fn) {
  const out = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const k = next++; out[k] = await fn(items[k], k) }
  }))
  return out
}

// ---------- rows ----------
// (before sql/065 is applied the table is missing: no references, the server works as before)
const missing = (e) => e?.code === '42P01'
export async function rowsOf(folderId) {
  return q('select * from pro_folder_refs where folder_id=$1 and tenant_id=$2 order by slot', [folderId, T()]).catch((e) => { if (missing(e)) return []; throw e })
}
// many folders' slot paths at once: folder id → [slot]
export async function slotsOf(folderIds) {
  const ids = [...new Set((folderIds || []).map(String))]
  if (!ids.length) return new Map()
  const rows = await q('select folder_id::text as f, slot from pro_folder_refs where tenant_id=$1 and folder_id = any($2::uuid[])', [T(), ids]).catch((e) => { if (missing(e)) return []; throw e })
  const out = new Map()
  for (const r of rows) { if (!out.has(r.f)) out.set(r.f, []); out.get(r.f).push(r.slot) }
  return out
}
// (paths are compared in one Unicode form: a Mac's NFD name and a slot kept in NFC are the same slot)
const nfc = (s) => String(s || '').normalize('NFC')
const inside = (slot, p) => { const a = nfc(slot), b = nfc(p); return b === a || b.startsWith(`${a}/`) }
// two paths on one another (the same, or one inside the other)
export const overlaps = (a, b) => inside(a, b) || inside(b, a)
// under one of these slots
export const underSlot = (slots, p) => (slots || []).some((s) => inside(s, p))
// the reference whose slot is rel or holds it (slots never overlap — add checks it)
export const slotOf = (rows, rel) => rows.find((r) => inside(r.slot, rel)) || null
const parents = (p) => { const out = []; let i = p.indexOf('/'); while (i > 0) { out.push(p.slice(0, i)); i = p.indexOf('/', i + 1) } return out }

// what git has at each (rev, path): 'blob' | 'tree' | null — one cat-file for all of them, exact paths (no pattern); a name git does not
// know comes back as "<name> missing", never read as a type
export async function typesOfMany(repo, pairs) {
  const list = (pairs || []).filter((x) => x.rev && x.path && !/[\n\r]/.test(x.path) && !/[\n\r]/.test(x.rev))
  if (!list.length) return []
  const res = await G.git(repo, ['cat-file', '--batch-check=%(objecttype)'], { input: list.map((x) => `${x.rev}:${x.path}`).join('\n') + '\n', check: false })
  const lines = res.split('\n')
  return list.map((x, i) => ({ ...x, type: lines[i] === 'blob' || lines[i] === 'tree' ? lines[i] : null }))
}
export async function typesAt(repo, rev, paths) {
  const want = [...new Set(paths)]
  const out = new Map(want.map((p) => [p, null]))
  for (const x of await typesOfMany(repo, want.map((p) => ({ rev, path: p })))) out.set(x.path, x.type)
  return out
}
// at which of these revs something takes the slot: a file or folder at it, or a file where one of its parent folders would be
async function takenAt(repo, revs, slot) {
  const pairs = revs.flatMap((rev) => [slot, ...parents(slot)].map((p) => ({ rev, path: p })))
  const got = await typesOfMany(repo, pairs)
  return new Set(revs.filter((rev) => got.some((x) => x.rev === rev && (x.path === slot ? !!x.type : x.type === 'blob'))))
}

// ---------- a source, once per request (cache) ----------
// its row, found again in this company (a folder of another one never resolves, however the row came in), or null
function sourceOf(sid, cache) {
  if (!sid) return Promise.resolve(null)
  const key = `f:${sid}`
  if (!cache.has(key)) {
    cache.set(key, (async () => {
      const [f] = await q('select * from pro_folders where id=$1 and tenant_id=$2', [sid, T()])
      return f && f.kind !== 'skill' && (f.kind !== 'linked' || S.linkingOn()) ? f : null
    })())
  }
  return cache.get(key)
}
const roleIn = (src, user, cache) => {
  const key = `r:${src.id}:${user?.id}`
  if (!cache.has(key)) cache.set(key, S.roleOf(src, user).catch(() => null))
  return cache.get(key)
}
const headOf = (src, cache) => {
  const key = `h:${src.id}`
  if (!cache.has(key)) cache.set(key, G.head(src.repo_path, src.default_branch))
  return cache.get(key)
}
// a pinned reference's commit (one main passed through), or null
async function pinOf(src, r) {
  const c = String(r.pinned_commit || '')
  const ok = /^[0-9a-f]{40}$/.test(c) && (await G.git(src.repo_path, ['cat-file', '-t', c], { check: false })).trim() === 'commit'
  return ok ? c : null
}

// Every reference of these rows as one reader sees it: [{r, st}], st = {state, source?, role?, rev?}. source is there only for a reader
// who may read the source. ok · locked (not a member of the source) · dangling (the source, or the path in it, is gone).
// Per source, once: its row, the reader's role, the head of its main and the types of all the paths asked of it (one cat-file); at most
// four sources at a time. check: false — the path's existence is left to the read (resolve: a gone path answers 404 there).
async function states(rows, user, { cache = new Map(), check = true } = {}) {
  if (!rows.length) return []
  const bySrc = new Map()
  for (const r of rows) {
    const k = String(r.source_folder_id || '')
    if (!bySrc.has(k)) bySrc.set(k, [])
    bySrc.get(k).push(r)
  }
  const info = new Map()
  await eachLimit([...bySrc.entries()], AT_ONCE, async ([sid, list]) => {
    const src = await sourceOf(sid, cache)
    const role = src && user ? await roleIn(src, user, cache) : null
    if (!src || !role) return info.set(sid, { src, role })
    const head = await headOf(src, cache)
    const paths = check ? list.filter((r) => r.track !== 'pin' && r.source_type !== 'folder').map((r) => r.source_path) : []
    info.set(sid, { src, role, head, types: head && paths.length ? await typesAt(src.repo_path, head, paths) : new Map() })
  })
  return eachLimit(rows, AT_ONCE, async (r) => {
    const i = info.get(String(r.source_folder_id || ''))
    if (!i?.src) return { r, st: { state: 'dangling' } }
    if (!i.role) return { r, st: { state: 'locked' } }
    const pinned = r.track === 'pin'
    const rev = pinned ? await pinOf(i.src, r) : i.head
    if (!rev) return { r, st: { state: 'dangling', source: i.src, role: i.role } }
    if (check && r.source_type !== 'folder') {
      const t = pinned ? (await typesAt(i.src.repo_path, rev, [r.source_path])).get(r.source_path) : i.types.get(r.source_path)
      if (t !== (r.source_type === 'file' ? 'blob' : 'tree')) return { r, st: { state: 'dangling', source: i.src, role: i.role } }
    }
    return { r, st: { state: 'ok', source: i.src, role: i.role, rev } }
  })
}

// ---------- the one resolver ----------
// rel in a folder's main, for this reader →
//   null                                                  not under a slot: the folder's own file, as before
//   {ref, state: 'ok', source, role, rev, path, type}     read `path` (null: nothing there) of `source` at `rev`
//   {ref, state: 'locked' | 'dangling'}                   nothing of the source
// The slot wins over a file of this folder at that path (one a commit from elsewhere put there after the slot was made).
export async function resolve(folder, rel, user, { rows, cache } = {}) {
  if (!folder || folder.kind !== 'managed') return null
  const p = S.safeRel(rel)
  rows = rows || await rowsOf(folder.id)
  const r = slotOf(rows, p)
  if (!r) return null
  const [{ st }] = await states([r], user, { cache, check: false })
  if (st.state !== 'ok') return { ref: r, state: st.state }
  // (what is below the slot, by parts — the slot's part count is the same in either Unicode form)
  const inner = p.split('/').slice(r.slot.split('/').length).join('/')
  const at = r.source_type === 'file' ? (inner ? null : r.source_path) : [r.source_path, inner].filter(Boolean).join('/') || null
  return { ref: r, state: 'ok', source: st.source, role: st.role, rev: st.rev, path: at, type: r.source_type }
}
// what a route says when a slot gives nothing to this reader (null: read on — through the slot or the folder's own file)
export function refusal(res) {
  if (!res || res.state === 'ok') return null
  if (res.state === 'locked') return err(403, L('볼 수 없는 참조예요. 원본 폴더의 구성원만 내용을 봐요.', "This reference can't be read. Only members of its original folder see its content."), 'ref_locked')
  return err(404, L('원본에서 찾을 수 없는 참조예요.', "This reference's original can't be found."), 'ref_dangling')
}

// ---------- what people see ----------
const PUBLIC_KIND = { managed: 'managed', linked: 'linked' }
// one reference for this reader. A locked one carries no source information at all (its shape is fixed by the tests).
// hidden: files of this folder a commit from elsewhere put under the slot (the slot wins; they show again when the slot goes)
function view(r, st, { names = new Map(), asked = new Set(), hidden = new Map(), counts = new Map() } = {}) {
  const base = { id: r.id, slot: r.slot, label: r.label, state: st.state, by: names.get(String(r.created_by)) || null, ...(hidden.get(r.slot) ? { hidden: hidden.get(r.slot) } : {}) }
  if (st.state === 'locked') return { ...base, requested: asked.has(String(r.id)) }
  if (!st.source) return base
  const from = { slug: st.source.slug, name: st.source.name, path: r.source_path, kind: PUBLIC_KIND[st.source.kind] || 'managed' }
  return { ...base, type: r.source_type, track: r.track, from, ...(counts.has(r.id) ? { count: counts.get(r.id) } : {}) }
}
async function namesOf(ids) {
  const list = [...new Set(ids.filter(Boolean).map(String))]
  if (!list.length) return new Map()
  const { people } = await import('../people.js')
  const by = await people(list).catch(() => new Map())
  return new Map(list.map((id) => [id, by.get(id)?.name || null]))
}
async function askedBy(user, ids) {
  if (!user?.id || !ids.length) return new Set()
  const rows = await q(`select distinct ref_id::text as id from pro_folder_ref_events where tenant_id=$1 and actor::text=$2 and kind='access_requested' and ref_id = any($3::uuid[])`,
    [T(), String(user.id), ids]).catch(() => [])
  return new Set(rows.map((x) => x.id))
}
// files of this folder under its slots (one query): slot → how many
// (counted here, with the same comparison as every slot match — a path a Mac wrote in NFD counts under its NFC slot)
async function hiddenOf(folder, slots) {
  if (!slots.length) return new Map()
  // only the paths at or under a slot, in either form (NFC · NFD) — a large folder's whole index is not read for this (review of #97);
  // the count itself stays the same NFC comparison every slot match uses (inside)
  const forms = [...new Set(slots.flatMap((s) => [String(s).normalize('NFC'), String(s).normalize('NFD')]))]
  const like = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`)
  const rows = await q(`select path from pro_folder_files where folder_id=$1 and (path = any($2::text[]) or path like any($3::text[]))`,
    [folder.id, forms, forms.map((s) => `${like(s)}/%`)]).catch(() => [])
  const out = new Map()
  for (const { path: p } of rows) {
    const s = slots.find((x) => inside(x, p))
    if (s) out.set(s, (out.get(s) || 0) + 1)
  }
  return out
}
// how many files each readable slot holds (its source's index at the head of main; one query per source) → ref id → n
async function countsOf(all) {
  const out = new Map()
  const bySrc = new Map()
  for (const { r, st } of all) if (st.state === 'ok' && r.track !== 'pin') { const k = st.source.id; if (!bySrc.has(k)) bySrc.set(k, { src: st.source, list: [] }); bySrc.get(k).list.push(r) }
  await eachLimit([...bySrc.values()], AT_ONCE, async ({ src, list }) => {
    const rows = await q(`select x.id::text as id, count(f.path)::int as n from unnest($2::uuid[], $3::text[], $4::text[]) as x(id, p, t)
                          left join pro_folder_files f on f.folder_id=$1 and (case when x.t='file' then f.path = x.p when x.p = '' then true else starts_with(f.path, x.p || '/') end)
                          group by x.id`, [src.id, list.map((r) => r.id), list.map((r) => r.source_type === 'folder' ? '' : r.source_path), list.map((r) => r.source_type)]).catch(() => [])
    for (const x of rows) out.set(x.id, x.n)
  })
  return out
}
// GET /folders/:slug/refs — the folder's slots for this reader
export async function list(folder, user, { cache = new Map() } = {}) {
  const rows = await rowsOf(folder.id)
  if (!rows.length) return []
  const all = await states(rows, user, { cache })
  const [names, asked, hidden, counts] = await Promise.all([namesOf(rows.map((r) => r.created_by)), askedBy(user, rows.map((r) => r.id)), hiddenOf(folder, rows.map((r) => r.slot)), countsOf(all)])
  return all.map(({ r, st }) => view(r, st, { names, asked, hidden, counts }))
}

// the files of a readable slot, at the slot's paths — from the source's index when it reads the head of main (cards, authors), else
// from git at that version. Only the source's own files: its references are not followed. source_path: where it is in the source
// (its kind is read from there — a slot need not carry the file's extension).
async function filesOf(r, st, { limit = SLOT_FILES, cache = new Map() } = {}) {
  const src = st.source
  const prefix = r.source_type === 'folder' ? '' : r.source_path
  let rows = []
  if (limit <= 0) return []
  if (st.rev === await headOf(src, cache)) {
    rows = r.source_type === 'file'
      ? await q(`select path, kind, size, sha, mtime, author, card is not null as has_card, card from pro_folder_files where folder_id=$1 and path=$2`, [src.id, r.source_path])
      : await q(`select path, kind, size, sha, mtime, author, card is not null as has_card, card from pro_folder_files where folder_id=$1 and ($2 = '' or starts_with(path, $2 || '/'))
                 order by path limit $3`, [src.id, prefix, limit])
  }
  if (!rows.length) {
    rows = (await G.lsTree(src.repo_path, st.rev))
      .filter((f) => (r.source_type === 'file' ? f.path === r.source_path : !prefix || f.path.startsWith(`${prefix}/`)))
      .filter((f) => f.path !== '.gitattributes' || src.settings?.champion)
      .slice(0, limit).map((f) => ({ path: f.path, kind: (f.path.split('.').pop() || '').toLowerCase(), size: f.size, sha: f.sha }))
  }
  return rows.map((f) => ({ ...f, source_path: f.path, path: r.source_type === 'file' ? r.slot : `${r.slot}/${prefix ? f.path.slice(prefix.length + 1) : f.path}`, ref: { id: r.id, slot: r.slot } }))
}
// the readable slots' files for the folder's tree (main only — a variation's screen shows its own changes); at most slotMax of a slot
// and totalMax in all (the slot's count says how many there are)
export async function treeRows(folder, user, { slotMax = SLOT_FILES, totalMax = TREE_FILES, cache = new Map() } = {}) {
  const out = []
  for (const { r, st } of await states(await rowsOf(folder.id), user, { cache })) {
    if (st.state !== 'ok') continue
    const room = totalMax - out.length
    if (room <= 0) break
    out.push(...(await filesOf(r, st, { limit: Math.min(slotMax, room), cache })))
  }
  return out
}
// a folder's own file rows without those under a slot (the slot wins)
export async function ownRows(folder, rows, { slots } = {}) {
  slots = slots || (await rowsOf(folder.id)).map((r) => r.slot)
  return slots.length ? rows.filter((f) => !underSlot(slots, f.path)) : rows
}
// the index row of a file read through a slot (the preview's card and 「참조된 자료 · 원본 열기」)
export async function fileRow(res) {
  const [row] = res.rev === await G.head(res.source.repo_path, res.source.default_branch)
    ? await q('select path, kind, size, sha, mtime, author, card, card_error from pro_folder_files where folder_id=$1 and path=$2', [res.source.id, res.path]) : []
  return { ...(row || { path: res.path }), ref: { id: res.ref.id, slot: res.ref.slot, label: res.ref.label, from: { slug: res.source.slug, name: res.source.name, path: res.path } } }
}

// ---------- the agent's view (server/mcp/folders.js · the chat's note) ----------
// {refs: [{name, slot, state, type?, from?}], files: [{path, size, summary, keywords, ref}], more} — files only of readable slots, at
// most totalMax of them (more: how many were left out)
export async function agentView(folder, user, { files = true, totalMax = AGENT_FILES, cache = new Map() } = {}) {
  const all = await states(await rowsOf(folder.id), user, { cache })
  const refs = all.map(({ r, st }) => ({ name: r.label, slot: r.slot, state: st.state, ...(st.source ? { type: r.source_type, from: st.source.name } : {}) }))
  if (!files) return { refs }
  const out = []
  for (const { r, st } of all) {
    if (st.state !== 'ok') continue
    const room = totalMax - out.length
    if (room <= 0) break
    out.push(...(await filesOf(r, st, { limit: room, cache })).map((f) => ({ path: f.path, size: f.size, summary: f.card?.abstract || null, keywords: f.card?.keywords || [], ref: r.slot })))
  }
  const counts = await countsOf(all)
  const total = [...counts.values()].reduce((a, b) => a + b, 0)
  return { refs, files: out, more: Math.max(0, total - out.length) }
}
// the catalog's references of many folders at once: folder id → [{name, slot, state, from?}] (folders without any are left out)
export async function summaries(folderIds, user) {
  const ids = [...new Set((folderIds || []).map(String))]
  if (!ids.length) return new Map()
  const rows = await q('select * from pro_folder_refs where tenant_id=$1 and folder_id = any($2::uuid[]) order by slot', [T(), ids]).catch((e) => { if (missing(e)) return []; throw e })
  const out = new Map()
  const cache = new Map()
  for (const fid of [...new Set(rows.map((r) => String(r.folder_id)))]) {
    const all = await states(rows.filter((r) => String(r.folder_id) === fid), user, { cache })
    out.set(fid, all.map(({ r, st }) => ({ name: r.label, slot: r.slot, state: st.state, ...(st.source ? { type: r.source_type, from: st.source.name } : {}) })))
  }
  return out
}
// What an agent reading the attached folder is told about its slots (threadFolders.js refHint)
// (a project's folder too: its agent reads the slots with the same tools — folders/threadFolders.js prepareProjectWork)
export async function hint(link, user) {
  if (!['ref', 'project'].includes(link?.mode) || !user) return ''
  const folder = await S.folderById(link.folder_id).catch(() => null)
  if (!folder || folder.tenant_id !== T()) return ''
  const { refs } = await agentView(folder, user, { files: false }).catch(() => ({ refs: [] }))
  if (!refs.length) return ''
  const line = (x) => (x.state === 'ok'
    ? L(`- ${x.slot}${x.type === 'file' ? '' : '/'} — 원본: 「${x.from}」 폴더${x.type === 'folder' ? ' 전체' : x.type === 'dir' ? '의 하위 폴더' : '의 파일'}`, `- ${x.slot}${x.type === 'file' ? '' : '/'} — original: the "${x.from}" folder${x.type === 'folder' ? '' : x.type === 'dir' ? ' (a sub-folder of it)' : ' (one file of it)'}`)
    : x.state === 'locked' ? L(`- ${x.slot} — 이 사용자가 볼 수 없는 참조예요(내용 없음)`, `- ${x.slot} — a reference this user can't read (no content)`)
      : L(`- ${x.slot} — 원본을 찾을 수 없는 참조예요`, `- ${x.slot} — a reference whose original can't be found`))
  return L(`\n\n(이 폴더에는 다른 폴더의 자료를 가리키는 참조 자리가 있어요. 자리 아래 파일은 같은 폴더 이름(folder: '${link.slug}')과 '자리/파일' 경로로 folder_files · folder_read 도구에서 읽어요:
${refs.map(line).join('\n')}
참조된 자료는 읽기만 해요. 고쳐야 하면 무엇을 왜 고쳐야 하는지 답에 적고, 원본 폴더에서 고쳐 달라고 사용자에게 말해 주세요.)`,
  `\n\n(This folder has reference slots that point at material in other folders. Files under a slot are read with the folder_files and folder_read tools, with the same folder (folder: '${link.slug}') and the path 'slot/file':
${refs.map(line).join('\n')}
Referenced material is read only. If it needs changing, say in your answer what should change and why, and ask the user to change it in its original folder.)`)
}

// ---------- adding, renaming, removing ----------
const cleanName = (s) => String(s || '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80)
// a path in the source as given ('', a sub-folder or a file): slashes at either end and doubled ones taken away first, then checked
export function sourcePathOf(given) {
  const p = String(given || '').replace(/\\/g, '/').split('/').filter(Boolean).join('/')
  return p ? S.safeRel(p) : ''
}
// a slot path from what was typed: no control characters, '/' between parts only, no part '.git' or '..' (safeRel). A file's extension
// is put on only when asked for (keepExt) and not typed already — the name is what every member sees.
function slotPath(s, { type, sourcePath, keepExt = false }) {
  let p = String(s || '').normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, '').split('/').map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean).join('/')
  p = S.safeRel(p)
  const ext = keepExt && type === 'file' ? path.posix.extname(sourcePath || '') : ''
  if (ext && path.posix.extname(p).toLowerCase() !== ext.toLowerCase()) p = `${p}${ext}`
  if (p.length > 200) throw err(400, L('자리 이름이 너무 길어요.', 'That slot name is too long.'))
  return p
}
// the first 「참조 N」 no slot takes
export const defaultName = (n) => L(`참조 ${n}`, `Reference ${n}`)
function freeName(rows) {
  for (let n = 1; ; n++) { const name = defaultName(n); if (!rows.some((r) => overlaps(r.slot, name) || r.label === name)) return name }
}
async function event(folder, refId, actor, kind, detail = {}) {
  await q('insert into pro_folder_ref_events (tenant_id, folder_id, ref_id, actor, kind, detail) values ($1,$2,$3,$4,$5,$6)', [T(), folder.id, refId, actor || null, kind, detail]).catch(() => {})
}
// The slot is free: no other reference on it, nothing of this folder there — in main, and in no open variation (committed on its branch,
// or written in its checkout and not saved yet: that file would otherwise be left out of the variation's next commit)
async function assertFree(folder, slot, rows, exceptId = null) {
  if (rows.some((x) => String(x.id) !== String(exceptId) && overlaps(x.slot, slot))) throw err(409, L('그 자리에는 이미 참조가 있어요. 다른 이름을 적어 주세요.', 'There is already a reference there. Please choose another name.'), 'ref_taken')
  if ((await takenAt(folder.repo_path, [folder.default_branch], slot)).size) throw err(409, L('그 자리에 이 폴더의 파일이 있어요. 다른 이름을 적어 주세요.', 'A file of this folder is already there. Please choose another name.'), 'ref_taken')
  // (projects' workspaces are not looked into, nor named: they are their persons' only — folders/templates.js; their own commits leave a
  // slot's path out like any variation's — slotGuard)
  const open = await q(`select id, title, branch, worktree_path from pro_folder_variations v where folder_id=$1 and status in ('open','ready','conflicted') and ${S.UNLISTED}`, [folder.id])
  if (!open.length) return
  const onBranch = await takenAt(folder.repo_path, open.map((v) => `refs/heads/${v.branch}`), slot)
  const onDisk = async (v) => {
    if (!v.worktree_path) return false
    for (const p of [slot, ...parents(slot)]) {
      const st = await fs.lstat(path.join(v.worktree_path, p)).catch(() => null)
      if (st && (p === slot || !st.isDirectory())) return true
    }
    return false
  }
  const hit = (await eachLimit(open, AT_ONCE, async (v) => (onBranch.has(`refs/heads/${v.branch}`) || await onDisk(v) ? v : null))).find(Boolean)
  if (hit) throw err(409, L(`열린 변형 ‘${hit.title}’에 그 경로의 파일이 있어요. 다른 이름을 적거나, 그 변형을 먼저 반영하거나 정리해 주세요.`, `The open variation ‘${hit.title}’ has a file at that path. Choose another name, or merge or tidy that variation first.`), 'ref_taken')
}
const mayCompose = (folder, role) => {
  if (folder.kind !== 'managed') throw err(400, L('참조는 관리형 공유 폴더에만 둘 수 있어요.', 'References can only be kept in a managed shared folder.'))
  if (S.RANK[role] < S.RANK.editor) throw err(403, L("참조를 바꾸려면 이 폴더의 'editor' 권한이 필요해요.", "Changing references needs the 'editor' role in this folder."))
}

// POST /folders/:slug/refs {source, path?, slot?, label?, keepExt?} — an editor of the folder who may read the source (viewer and up).
// Without a name the slot is 「참조 N」. New references follow the source's main.
export async function add(folder, role, user, { source, path: srcRel = '', slot, label, keepExt = false } = {}) {
  mayCompose(folder, role)
  const key = String(source || '').trim()
  if (!key) throw err(400, L('참조할 폴더를 골라 주세요.', 'Please choose a folder to reference.'))
  const [src] = UUID.test(key) ? await q('select * from pro_folders where id=$1 and tenant_id=$2', [key, T()]) : await q('select * from pro_folders where slug=$1 and tenant_id=$2', [key, T()])
  // (a folder that is not there, of another company, a linked one where linking is off, or one this person is not a member of: one and
  // the same answer — whether it exists, and what kind it is, is said only to its members)
  const usable = src && src.tenant_id === T() && (src.kind !== 'linked' || S.linkingOn()) && await S.roleOf(src, user)
  if (!usable) throw err(404, L('원본 폴더를 찾지 못했어요. 내가 구성원인 폴더만 참조로 더할 수 있어요.', "I couldn't find the original folder. Only folders you are a member of can be referenced."))
  if (src.kind === 'skill') throw err(400, L('스킬 폴더는 참조할 수 없어요.', "A skill's folder can't be referenced."))
  if (String(src.id) === String(folder.id)) throw err(400, L('폴더가 자기 자신을 참조할 수는 없어요.', "A folder can't reference itself."))
  const p = sourcePathOf(srcRel)
  let type = 'folder'
  if (p) {
    const head = await G.head(src.repo_path, src.default_branch)
    const t = (await typesAt(src.repo_path, head, [p])).get(p)
    if (!t) throw err(404, L('원본 폴더에서 그 경로를 찾지 못했어요.', "That path isn't in the original folder."))
    type = t === 'blob' ? 'file' : 'dir'
  }
  const rows = await rowsOf(folder.id)
  if (rows.length >= MAX_REFS) throw err(409, L(`참조는 폴더 하나에 ${MAX_REFS}개까지예요.`, `A folder holds at most ${MAX_REFS} references.`))
  const name = cleanName(label) || cleanName(slot ? String(slot).split('/').pop() : '') || freeName(rows)
  const s = slotPath(slot || name.replace(/\//g, '·'), { type, sourcePath: p, keepExt: keepExt === true })
  await assertFree(folder, s, rows)
  let r
  try {
    ;[r] = await q(`insert into pro_folder_refs (tenant_id, folder_id, slot, label, source_folder_id, source_path, source_type, track, created_by)
                    values ($1,$2,$3,$4,$5,$6,$7,'main',$8) returning *`, [T(), folder.id, s, name || s, src.id, p, type, user.id])
  } catch (e) {
    if (e.code === '23505') throw err(409, L('그 자리에는 이미 참조가 있어요. 다른 이름을 적어 주세요.', 'There is already a reference there. Please choose another name.'), 'ref_taken')
    if (e.code === '23514') throw err(400, L('같은 회사의 폴더만 참조할 수 있어요.', 'Only folders of the same company can be referenced.'))
    throw e
  }
  await event(folder, r.id, user.id, 'added', { slot: s, type })
  emit(user.id, 'folders', { slug: folder.slug })
  const [{ st }] = await states([r], user)
  return view(r, st, { names: await namesOf([r.created_by]) })
}
async function own(folder, id) {
  if (!UUID.test(String(id || ''))) throw err(404, L('참조를 찾지 못했어요.', "I couldn't find that reference."))
  const [r] = await q('select * from pro_folder_refs where id=$1 and folder_id=$2 and tenant_id=$3', [id, folder.id, T()]).catch((e) => { if (missing(e)) return []; throw e })
  if (!r) throw err(404, L('참조를 찾지 못했어요.', "I couldn't find that reference."))
  return r
}
// PATCH /folders/:slug/refs/:id {slot?, label?} — the slot's name (an editor; the source is not looked at). The name is taken as typed.
export async function rename(folder, role, user, id, { slot, label } = {}) {
  mayCompose(folder, role)
  const r = await own(folder, id)
  const name = label != null ? cleanName(label) : null
  if (label != null && !name) throw err(400, L('자리 이름을 적어 주세요.', 'Please enter a name for the slot.'))
  let s = r.slot
  if (slot != null || name) {
    const base = slot != null ? String(slot) : [...r.slot.split('/').slice(0, -1), name.replace(/\//g, '·')].join('/')
    s = slotPath(base, { type: r.source_type, sourcePath: r.source_path })
    if (s !== r.slot) await assertFree(folder, s, await rowsOf(folder.id), r.id)
  }
  if (s !== r.slot) await S.serial(folder.id, () => sweepLeftovers(folder, [r.slot], folder.repo_path, { by: 'renamed' }))
  const [n] = await q('update pro_folder_refs set slot=$2, label=$3, updated_at=now() where id=$1 returning *', [r.id, s, name || r.label]).catch((e) => {
    if (e.code === '23505') throw err(409, L('그 자리에는 이미 참조가 있어요. 다른 이름을 적어 주세요.', 'There is already a reference there. Please choose another name.'), 'ref_taken')
    throw e
  })
  await event(folder, r.id, user.id, 'renamed', { from: r.slot, to: s })
  emit(user.id, 'folders', { slug: folder.slug })
  const [{ st }] = await states([n], user)
  return view(n, st, { names: await namesOf([n.created_by]) })
}
// DELETE /folders/:slug/refs/:id — the slot goes, the source stays as it is (an editor who cannot read the source may remove it too)
export async function remove(folder, role, user, id) {
  mayCompose(folder, role)
  const r = await own(folder, id)
  // (what lies at the slot in main's working tree is moved aside first: the next commit sweeps nothing in that nobody saw)
  await S.serial(folder.id, () => sweepLeftovers(folder, [r.slot], folder.repo_path, { by: 'removed' }))
  await q('delete from pro_folder_refs where id=$1', [r.id])
  await event(folder, r.id, user.id, 'removed', { slot: r.slot })
  emit(user.id, 'folders', { slug: folder.slug })
  return { ok: true }
}

// POST /folders/:slug/refs/:id/request-access — a member who sees the slot locked asks the source's owners. The request is the existing
// folder access notice (type folder_access, the same address as a file mention's 「권한 요청」: it opens the source's 공유 sheet with the
// person picked) — no access of its own per reference: accepted, it is membership of the source. Once a day per person and slot (the
// record is claimed first: requests at the same moment send one). The answer says nothing about the source (not who was told).
export const requestUrl = (slug, userId) => `/folders/${slug}?share=${userId}`
// the company's date of a moment (PRO_TIME_ZONE, Asia/Seoul by default): 「하루에 한 번」 is counted in it
export const dayOf = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: process.env.PRO_TIME_ZONE || ENGINE_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
export async function requestAccess(folder, user, id) {
  const r = await own(folder, id)
  const src = await sourceOf(r.source_folder_id, new Map())
  if (!src) throw err(404, L('원본을 찾을 수 없는 참조예요.', "This reference's original can't be found."))
  if (await S.roleOf(src, user)) return { requested: false, access: true }
  const day = dayOf(new Date())
  const [claim] = await q(`insert into pro_folder_ref_events (tenant_id, folder_id, ref_id, actor, kind, detail, once_key) values ($1,$2,$3,$4,'access_requested','{}',$5)
                           on conflict (once_key) where once_key is not null do nothing returning id`, [T(), folder.id, r.id, user.id, `access:${r.id}:${user.id}:${day}`])
  if (!claim) return { requested: true }
  const owners = (await q(`select principal_id as id from pro_folder_members where folder_id=$1 and principal_type='user' and role='owner'`, [src.id])).map((x) => x.id)
  const url = requestUrl(src.slug, user.id)
  for (const id2 of owners.filter((x) => x && x !== String(user.id))) {
    const [u] = await q('select id::text as id, email from users where id::text=$1 and tenant_id=$2', [id2, T()])
    if (!u) continue
    const [dup] = await q(`select 1 from notifications where tenant_id=$1 and user_id = any($2) and type='folder_access' and url=$3 and coalesce(is_checked,false)=false limit 1`, [T(), [u.id, u.email], url])
    if (dup) continue
    const title = L(`${user.name}님이 「${src.name}」 폴더 권한을 요청했어요`, `${user.name} asked for access to the "${src.name}" folder`)
    const text = L(`다른 폴더에 둔 참조 「${r.label}」${ro(r.label)} 이 폴더의 자료를 읽으려고 해요. 폴더의 「공유」에서 구성원으로 추가할 수 있어요.`,
      `They want to read this folder's material through a reference, "${r.label}", kept in another folder. Add them in the folder's Share.`)
    await q(`insert into notifications(id,user_id,title,type,description,url,from_user_id,tenant_id) values (gen_random_uuid(),$1,$2,'folder_access',$3,$4,$5,$6)`,
      [u.id, title.slice(0, 200), text, url, user.email || String(user.id), T()])
    emit(u.id, 'notifications', {})
  }
  return { requested: true }
}

// ---------- writes under a slot ----------
// where what was left at a slot of main's work tree is kept: in the folder's own directory, ignored by git (its info/exclude, and left
// out of every commit besides), so main stays clean and editors find it in the workroom — never inside a slot, never a commit's
export const LEFTOVER = '.slot-leftover'
// A person's write into the composing folder at rel (올리기 · 지우기 · 이음오피스 저장 · 작업실 · 폴더에 넣기): refused where a reference
// is — the slot wins, also over a file a commit from elsewhere put there — and in the place leftovers are kept (nothing there is saved)
export async function assertWritable(folder, rel) {
  if (!folder || folder.kind !== 'managed') return
  const p = S.safeRel(rel)
  if (inside(LEFTOVER, p)) throw err(409, L('참조 자리에서 옮겨 둔 파일의 보관 자리예요. 여기에는 저장되지 않아요 — 내려받아 필요한 곳에 올려 주세요.', "This is where files moved off reference slots are kept; nothing is saved here — download them and upload where they belong."), 'ref_readonly')
  const rows = await rowsOf(folder.id)
  if (!rows.length) return
  if (rows.some((r) => overlaps(r.slot, p))) throw err(409, L('참조된 자료예요. 원본 폴더에서 고쳐 주세요.', 'This is referenced material. Change it in its original folder.'), 'ref_readonly')
}
// the slots a new file may not take (filing picks another name beside them)
export async function slotPaths(folder) {
  if (!folder || folder.kind !== 'managed') return []
  return (await rowsOf(folder.id)).map((r) => r.slot)
}
// The paths a commit of this work tree leaves out for these slots: each in both Unicode forms (a Mac may have written the other), none
// behind a symbolic link (git takes no path beyond one, and nothing can be written there through the tree anyway)
async function leavePaths(dir, slots) {
  const out = []
  for (const s of slots) {
    for (const form of new Set([s.normalize('NFC'), s.normalize('NFD')])) {
      const parent = form.includes('/') ? form.slice(0, form.lastIndexOf('/')) : ''
      if (parent && await linkOnPath(dir, parent)) continue
      out.push(form)
    }
  }
  return out
}

// Before any commit this server makes of a folder's work tree (git.js commitAll — main's working tree, or a variation's checkout): the
// folder's slot paths are kept out of it, nothing is deleted. In main's working tree what lies at a slot is moved to the folder's
// leftover place first (main stays clean, and nothing there is swept in later — under someone else's name — once the slot goes), and its
// editors are told once where it is. In a variation's checkout it stays where it is and the person whose run it was is told in their
// conversation. When the slots cannot be looked up the commit is refused (it could sweep a slot in).
// guardDeps: the query it uses (the tests make it fail)
export const guardDeps = { q }
const unchecked = () => err(503, L('참조 자리를 확인하지 못해 저장하지 않았어요. 잠시 뒤 다시 해 주세요.', "The reference slots couldn't be checked, so nothing was saved. Please try again in a moment."), 'ref_unchecked')
export async function slotGuard(cwd) {
  let v, folder, rows
  try {
    ;[v] = await guardDeps.q('select * from pro_folder_variations where worktree_path=$1 limit 1', [cwd])
    ;[folder] = v ? await guardDeps.q('select * from pro_folders where id=$1', [v.folder_id]) : await guardDeps.q('select * from pro_folders where repo_path=$1 limit 1', [cwd])
    if (!folder || folder.kind !== 'managed') return []
    rows = await guardDeps.q('select slot from pro_folder_refs where folder_id=$1', [folder.id])
  } catch (e) {
    if (missing(e)) return []
    console.warn('[folders] refs: the slots could not be looked up — commit refused', e.message)
    throw unchecked()
  }
  const slots = rows.map((r) => r.slot)
  const main = !v
  const leave = await leavePaths(cwd, slots)
  if (main && await fs.stat(path.join(cwd, LEFTOVER)).then(() => true, () => false)) {
    leave.push(LEFTOVER)
    await expireLeftovers(cwd).catch((e) => console.warn('[folders] refs: leftover expiry', e.message))
  }
  if (!slots.length) return leave
  if (main) {
    await sweepLeftovers(folder, slots, cwd, { leave })
    return leave
  }
  const paths = await writtenAt(cwd, leave.filter((p) => p !== LEFTOVER)).catch(() => [])
  if (paths.length) {
    console.warn(`[folders] refs: ${paths.length} write(s) at a reference slot of '${folder.slug}' left out of the commit (variation ${v.id})`)
    await noteLeftOut(v, paths)
  }
  return leave
}
G.onBeforeCommit(slotGuard)
// what is written (changed, new, staged, deleted) at these paths in a work tree
async function writtenAt(dir, paths) {
  if (!paths.length) return []
  const st = await G.git(dir, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...paths.map((s) => `:(literal)${s}`)], { check: false })
  const parts = st.split('\0')
  const out = []
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i]
    if (!e) continue
    out.push(e.slice(3))
    if (e[0] === 'R' || e[0] === 'C') { i++; if (parts[i]) out.push(parts[i]) } // (a rename names where it came from next)
  }
  return [...new Set(out)]
}
// Main's working tree at these slots made clean again: a new file is moved to <folder>/.slot-leftover/<time>/<its path>, a changed file
// that main has is copied there and put back as main has it (a file main has and the tree lost is put back too). Nothing is deleted.
// The folder's editors get one notice that says where. → {stamp, paths} (paths: what was moved or copied)
export async function sweepLeftovers(folder, slots, dir = folder.repo_path, { leave = null, by = 'commit' } = {}) {
  const specs = leave ? leave.filter((p) => p !== LEFTOVER) : await leavePaths(dir, slots)
  const written = (await writtenAt(dir, specs)).filter((p) => specs.some((s) => inside(s, p)))
  if (!written.length) return { stamp: null, paths: [] }
  // (a leftover place that is not a plain folder of this one — a link — is never written through: the files stay, left out of commits)
  if (await linkOnPath(dir, LEFTOVER)) { console.warn(`[folders] refs: ${folder.slug} ${LEFTOVER} is a link — leftovers left in place`); return { stamp: null, paths: [] } }
  await keepOutOfGit(dir)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const types = await typesAt(dir, 'HEAD', written)
  const moved = []
  for (const p of written) {
    if (await linkOnPath(dir, path.posix.dirname(p) === '.' ? '' : path.posix.dirname(p))) continue
    const from = path.join(dir, p)
    const st = await fs.lstat(from).catch(() => null)
    if (!st || st.isDirectory()) continue
    const to = path.join(dir, LEFTOVER, stamp, p)
    await fs.mkdir(path.dirname(to), { recursive: true })
    // (moved, never copied: the same file goes aside, so a shell still writing it keeps writing into the kept one — a file main has is put
    // back below from main. Gone meanwhile: another sweep of this folder — a commit not under the folder's lock — moved it already.)
    try { await fs.rename(from, to) } catch (e) { if (e.code === 'ENOENT') continue; throw e }
    moved.push(p)
  }
  // the index and the tree back to main's for these paths (a file main has is put back as main has it)
  await G.git(dir, ['reset', '-q', '--', ...specs.map((s) => `:(literal)${s}`)], { check: false })
  const tracked = written.filter((p) => types.get(p))
  if (tracked.length) await G.git(dir, ['checkout', '-q', 'HEAD', '--', ...tracked.map((p) => `:(literal)${p}`)], { check: false })
  if (moved.length) {
    console.warn(`[folders] refs: ${moved.length} file(s) at a reference slot of '${folder.slug}' moved to ${LEFTOVER}/${stamp} (${by})`)
    await noteEditors(folder, moved, stamp)
  }
  return { stamp, paths: moved }
}
// this folder's git never sees the leftover place (its own .gitignore cannot bring it back either: commitAll leaves it out too)
async function keepOutOfGit(dir) {
  const f = path.join(dir, '.git', 'info', 'exclude')
  const now = await fs.readFile(f, 'utf8').catch(() => '')
  if (now.split('\n').includes(`/${LEFTOVER}/`)) return
  await fs.mkdir(path.dirname(f), { recursive: true })
  await fs.writeFile(f, `${now}${now && !now.endsWith('\n') ? '\n' : ''}/${LEFTOVER}/\n`)
}
// how long what was moved aside is kept (then a commit of main removes it)
export const LEFTOVER_DAYS = 30
// the editors' notice of a sweep: {title, description}
export function leftoverNotice(folder, paths, stamp) {
  const shown = paths.slice(0, 3).map((x) => `‘${x}’`).join(', ') + (paths.length > 3 ? L(` 외 ${paths.length - 3}개`, ` and ${paths.length - 3} more`) : '')
  const where = `${LEFTOVER}/${stamp}/`
  return {
    title: L(`‘${folder.name}’ 폴더의 참조 자리에 놓인 파일 ${paths.length}개를 옮겨 두었어요`, `${paths.length} file(s) left at a reference slot of ‘${folder.name}’ were moved aside`).slice(0, 200),
    description: L(`${shown} — 참조 자리는 원본을 읽는 자리라 이 폴더에 담지 않았어요. 작업실의 ${where} 에 있고, ${LEFTOVER_DAYS}일이 지나면 지워져요. 필요하면 그 전에 내려받아 주세요.`,
      `${shown} — a reference slot reads its original, so these were not put in this folder. They are in the workroom at ${where} and are removed after ${LEFTOVER_DAYS} days; download them before then if you need them.`),
  }
}
async function noteEditors(folder, paths, stamp) {
  const people = (await q(`select principal_id as id from pro_folder_members where folder_id=$1 and principal_type='user' and role in ('owner','editor')`, [folder.id]).catch(() => [])).map((x) => x.id)
  const n = leftoverNotice(folder, paths, stamp)
  for (const id of people) {
    await q(`insert into notifications(id,user_id,title,type,description,url,tenant_id) values (gen_random_uuid(),$1,$2,'folder_slot_leftover',$3,$4,$5)`, [id,
      n.title, n.description, `/workroom/folder/${folder.slug}`, T()]).catch((e) => console.warn('[folders] refs leftover notice', e.message))
    emit(id, 'notifications', {})
  }
}
// What was moved aside more than LEFTOVER_DAYS ago goes (a commit of main does it): each <time> folder by its name, else its own time
export async function expireLeftovers(dir, { now = Date.now() } = {}) {
  const base = path.join(dir, LEFTOVER)
  if (await linkOnPath(dir, LEFTOVER)) return []
  const gone = []
  for (const e of await fs.readdir(base, { withFileTypes: true }).catch(() => [])) {
    if (!e.isDirectory()) continue
    const m = /^(\d{4}-\d\d-\d\d)T(\d\d)-(\d\d)-(\d\d)-(\d{3})Z$/.exec(e.name)
    const at = m ? Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`) : (await fs.lstat(path.join(base, e.name)).catch(() => null))?.mtimeMs
    if (at && now - at > LEFTOVER_DAYS * 86400_000) { await fs.rm(path.join(base, e.name), { recursive: true, force: true }); gone.push(e.name) }
  }
  if (gone.length) console.warn(`[folders] refs: ${gone.length} leftover set(s) older than ${LEFTOVER_DAYS} days removed in ${dir}`)
  return gone
}
// (once per file: the files said already are kept on the variation — source.refs_noted — so the next commits, with the same file still
// in the checkout, say nothing again)
async function noteLeftOut(v, all) {
  const thread = v?.source?.thread_id
  if (!thread || v.holder_type !== 'user' || !v.holder_id) return
  const [cur] = await q('select source from pro_folder_variations where id=$1', [v.id]).catch(() => [])
  const said = new Set((cur?.source?.refs_noted || []).map(nfc))
  const paths = all.filter((p) => !said.has(nfc(p)))
  if (!paths.length) return
  await q(`update pro_folder_variations set source = jsonb_set(coalesce(source, '{}'::jsonb), '{refs_noted}', $2::jsonb) where id=$1`,
    [v.id, JSON.stringify([...said, ...paths.map(nfc)].slice(-500))]).catch((e) => console.warn('[folders] refs note record', e.message))
  const shown = paths.slice(0, 3).map((x) => `‘${x}’`).join(', ') + (paths.length > 3 ? L(` 외 ${paths.length - 3}개`, ` and ${paths.length - 3} more`) : '')
  const { addMessage } = await import('../store.js')
  await addMessage(v.holder_id, thread, 'agent', 'chip', { icon: 'info', refsReadOnly: paths.slice(0, 20),
    text: L(`참조된 자료 ${shown}는 읽기 전용이라 변형에 담지 않았어요 · 그 파일은 작업 폴더에 그대로 두었고 지우지 않았어요 · 고쳐야 하면 원본 폴더에서 고쳐 주세요`,
      `The referenced material ${shown} is read only here, so it was not put in the variation · the files stay in the working folder, nothing was deleted · change it in its original folder`) }).catch((e) => console.warn('[folders] refs note', e.message))
}
