// Folder references (폴더 참조 — spec openspec/specs/folder-refs, design P0). A managed shared folder can hold 「참조 자리」: a path in
// it (the slot) that points at another folder of the same company — the whole folder, a sub-folder of it, or one file — whose content
// stays there (the source). A reference is a row the server keeps (pro_folder_refs, sql/065); nothing goes into the folder's git tree
// (no gitlink, no .gitmodules), so the rules on what a folder's tree may hold do not change.
//
// Everything that reads through a slot goes through resolve(), here and nowhere else: on every read it looks at the reader's role in
// the source now (service.js roleOf). A member of the composing folder who is not a member of the source sees a locked slot — its
// label only: no name, path, count, version or content of the source. A reference inside a referenced folder is not followed (depth 1):
// the source is read from its own git tree, never through its own references. The source is found again in this company on every read.
// In the composing folder the slot is read only: a person's write there is refused, an agent's write there is not kept (and said so).
import path from 'node:path'
import { config } from '../../config.js'
import { q } from '../supa.js'
import { emit } from '../bus.js'
import { L } from '../lang.js'
import * as G from './git.js'
import * as S from './service.js'

const T = () => config.tenantId
const err = (status, message, code) => Object.assign(new Error(message), { status, ...(code ? { code } : {}) })
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const MAX_REFS = 200
// files of one slot listed in the folder's tree (a big linked repository is read through the tools)
export const SLOT_FILES = 2000

// ---------- rows ----------
// (before sql/065 is applied the table is missing: no references, the server works as before)
const missing = (e) => e?.code === '42P01'
export async function rowsOf(folderId) {
  return q('select * from pro_folder_refs where folder_id=$1 and tenant_id=$2 order by slot', [folderId, T()]).catch((e) => { if (missing(e)) return []; throw e })
}
const inside = (slot, p) => p === slot || p.startsWith(`${slot}/`)
// two paths on one another (the same, or one inside the other)
export const overlaps = (a, b) => inside(a, b) || inside(b, a)
// the reference whose slot is rel or holds it (slots never overlap — add checks it)
export const slotOf = (rows, rel) => rows.find((r) => inside(r.slot, rel)) || null
const parents = (p) => { const out = []; let i = p.indexOf('/'); while (i > 0) { out.push(p.slice(0, i)); i = p.indexOf('/', i + 1) } return out }

// what git has at each path of a rev: 'blob' | 'tree' | null (one cat-file for all of them, exact paths — no pattern)
export async function typesAt(repo, rev, paths) {
  const list = [...new Set(paths)].filter((p) => p && !/[\n\r]/.test(p))
  const out = new Map(list.map((p) => [p, null]))
  if (!list.length || !rev) return out
  // (only the type is printed; a name git does not know comes back as "<name> missing" — never read as a type, whatever the name holds)
  const res = await G.git(repo, ['cat-file', '--batch-check=%(objecttype)'], { input: list.map((p) => `${rev}:${p}`).join('\n') + '\n', check: false })
  const lines = res.split('\n')
  list.forEach((p, i) => { const t = lines[i] || ''; out.set(p, t === 'blob' || t === 'tree' ? t : null) })
  return out
}
// the slots a file of the composing folder itself already takes (the real file wins: the slot shows 「이름 겹침」 and gives nothing):
// something at the slot, or a file where one of its parent folders would be
export async function occupied(repo, rev, slots) {
  const types = await typesAt(repo, rev, slots.flatMap((s) => [s, ...parents(s)]))
  return new Set(slots.filter((s) => types.get(s) || parents(s).some((p) => types.get(p) === 'blob')))
}

// the source of a reference, found again in this company (a folder of another one never resolves, however the row came in), or null
async function sourceOf(r, cache) {
  if (!r.source_folder_id) return null
  const key = `f:${r.source_folder_id}`
  if (!cache.has(key)) {
    cache.set(key, (async () => {
      const [f] = await q('select * from pro_folders where id=$1 and tenant_id=$2', [r.source_folder_id, T()])
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
// the version a reference reads: its pinned commit, or the head of the source's main (following, the default)
async function revOf(src, r) {
  if (r.track === 'pin') {
    const c = String(r.pinned_commit || '')
    const ok = /^[0-9a-f]{40}$/.test(c) && (await G.git(src.repo_path, ['cat-file', '-t', c], { check: false })).trim() === 'commit'
    return ok ? c : null
  }
  return G.head(src.repo_path, src.default_branch)
}

// One reference as one reader sees it: {state, source?, role?, rev?}. source is there only for a reader who may read the source.
//   ok · locked (not a member of the source) · dangling (the source or the path is gone) · shadowed (a file of this folder took the slot)
async function stateOf(r, user, { shadow = false, cache = new Map() } = {}) {
  const src = await sourceOf(r, cache)
  const role = src && user ? await roleIn(src, user, cache) : null
  if (shadow) return { state: 'shadowed', ...(role ? { source: src, role } : {}) }
  if (!src) return { state: 'dangling' }
  if (!role) return { state: 'locked' }
  const rev = await revOf(src, r)
  if (!rev) return { state: 'dangling', source: src, role }
  if (r.source_type !== 'folder') {
    const t = (await typesAt(src.repo_path, rev, [r.source_path])).get(r.source_path)
    if (t !== (r.source_type === 'file' ? 'blob' : 'tree')) return { state: 'dangling', source: src, role }
  }
  return { state: 'ok', source: src, role, rev }
}

// every reference of a folder with its state for this reader: [{r, st}]
async function states(folder, user, { rows } = {}) {
  rows = rows || await rowsOf(folder.id)
  if (!rows.length) return []
  const occ = await occupied(folder.repo_path, folder.default_branch, rows.map((r) => r.slot))
  const cache = new Map()
  return Promise.all(rows.map(async (r) => ({ r, st: await stateOf(r, user, { shadow: occ.has(r.slot), cache }) })))
}

// ---------- the one resolver ----------
// rel in a folder's main, for this reader →
//   null                                                  not under a slot: the folder's own file, as before
//   {ref, state: 'ok', source, role, rev, path, type}     read `path` (null: nothing there) of `source` at `rev`
//   {ref, state: 'locked' | 'dangling' | 'shadowed'}      locked: nothing of the source; shadowed: the folder's own file is read instead
export async function resolve(folder, rel, user, { rows } = {}) {
  if (!folder || folder.kind !== 'managed') return null
  const p = S.safeRel(rel)
  rows = rows || await rowsOf(folder.id)
  const r = slotOf(rows, p)
  if (!r) return null
  const shadow = (await occupied(folder.repo_path, folder.default_branch, [r.slot])).has(r.slot)
  const st = await stateOf(r, user, { shadow })
  if (st.state !== 'ok') return { ref: r, state: st.state }
  const inner = p === r.slot ? '' : p.slice(r.slot.length + 1)
  const at = r.source_type === 'file' ? (inner ? null : r.source_path) : [r.source_path, inner].filter(Boolean).join('/') || null
  return { ref: r, state: 'ok', source: st.source, role: st.role, rev: st.rev, path: at, type: r.source_type }
}
// what a route says when a slot gives nothing to this reader (null: read on — through the slot or the folder's own file)
export function refusal(res) {
  if (!res || res.state === 'ok' || res.state === 'shadowed') return null
  if (res.state === 'locked') return err(403, L('볼 수 없는 참조예요. 원본 폴더의 구성원만 내용을 봐요.', "This reference can't be read. Only members of its original folder see its content."), 'ref_locked')
  return err(404, L('원본에서 찾을 수 없는 참조예요.', "This reference's original can't be found."), 'ref_dangling')
}

// ---------- what people see ----------
const PUBLIC_KIND = { managed: 'managed', linked: 'linked' }
// one reference for this reader. A locked one carries no source information at all (its shape is fixed by the tests).
function view(r, st, { names = new Map(), asked = new Set() } = {}) {
  const base = { id: r.id, slot: r.slot, label: r.label, state: st.state, by: names.get(String(r.created_by)) || null }
  if (st.state === 'locked') return { ...base, requested: asked.has(String(r.id)) }
  if (!st.source) return base
  const from = { slug: st.source.slug, name: st.source.name, path: r.source_path, kind: PUBLIC_KIND[st.source.kind] || 'managed' }
  return { ...base, type: r.source_type, track: r.track, from }
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
// GET /folders/:slug/refs — the folder's slots for this reader
export async function list(folder, user) {
  const all = await states(folder, user)
  if (!all.length) return []
  const [names, asked] = await Promise.all([namesOf(all.map((x) => x.r.created_by)), askedBy(user, all.map((x) => x.r.id))])
  return all.map(({ r, st }) => view(r, st, { names, asked }))
}

// the files of a readable slot, at the slot's paths — from the source's index when it reads the head of main (cards, authors), else
// from git at that version. Only the source's own files: its references are not followed.
async function filesOf(r, st, { limit = SLOT_FILES } = {}) {
  const src = st.source
  const prefix = r.source_type === 'folder' ? '' : r.source_path
  let rows = []
  if (st.rev === await G.head(src.repo_path, src.default_branch)) {
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
// the readable slots' files for the folder's tree (main only — a variation's screen shows its own changes)
export async function treeRows(folder, user) {
  const out = []
  for (const { r, st } of await states(folder, user)) if (st.state === 'ok') out.push(...(await filesOf(r, st)))
  return out
}
// the index row of a file read through a slot (the preview's card and 「참조된 자료 · 원본 열기」)
export async function fileRow(res) {
  const [row] = res.rev === await G.head(res.source.repo_path, res.source.default_branch)
    ? await q('select path, kind, size, sha, mtime, author, card, card_error from pro_folder_files where folder_id=$1 and path=$2', [res.source.id, res.path]) : []
  return { ...(row || { path: res.path }), ref: { id: res.ref.id, slot: res.ref.slot, label: res.ref.label, from: { slug: res.source.slug, name: res.source.name, path: res.path } } }
}

// ---------- the agent's view (server/mcp/folders.js · the chat's note) ----------
// {refs: [{name, slot, state, type?, from?}], files: [{path, size, summary, keywords, ref}]} — files only of readable slots
export async function agentView(folder, user, { files = true } = {}) {
  const all = await states(folder, user)
  const refs = all.map(({ r, st }) => ({ name: r.label, slot: r.slot, state: st.state, ...(st.source ? { type: r.source_type, from: st.source.name } : {}) }))
  const out = []
  if (files) for (const { r, st } of all) if (st.state === 'ok') out.push(...(await filesOf(r, st, { limit: 400 })).map((f) => ({ path: f.path, size: f.size, summary: f.card?.abstract || null, keywords: f.card?.keywords || [], ref: r.slot })))
  return { refs, files: out }
}
// the catalog's references of many folders at once: folder id → [{name, slot, state, from?}] (folders without any are left out)
export async function summaries(folderIds, user) {
  const ids = [...new Set((folderIds || []).map(String))]
  if (!ids.length) return new Map()
  const rows = await q('select * from pro_folder_refs where tenant_id=$1 and folder_id = any($2::uuid[]) order by slot', [T(), ids]).catch((e) => { if (missing(e)) return []; throw e })
  const out = new Map()
  for (const fid of [...new Set(rows.map((r) => String(r.folder_id)))]) {
    const folder = await S.folderById(fid)
    if (!folder || folder.tenant_id !== T()) continue
    out.set(fid, (await agentView(folder, user, { files: false })).refs)
  }
  return out
}
// What an agent reading the attached folder is told about its slots (threadFolders.js refHint)
export async function hint(link, user) {
  if (link?.mode !== 'ref' || !user) return ''
  const folder = await S.folderById(link.folder_id).catch(() => null)
  if (!folder || folder.tenant_id !== T()) return ''
  const { refs } = await agentView(folder, user, { files: false }).catch(() => ({ refs: [] }))
  const shown = refs.filter((x) => x.state !== 'shadowed')
  if (!shown.length) return ''
  const line = (x) => (x.state === 'ok'
    ? L(`- ${x.slot}${x.type === 'file' ? '' : '/'} — 원본: 「${x.from}」 폴더${x.type === 'folder' ? ' 전체' : x.type === 'dir' ? '의 하위 폴더' : '의 파일'}`, `- ${x.slot}${x.type === 'file' ? '' : '/'} — original: the "${x.from}" folder${x.type === 'folder' ? '' : x.type === 'dir' ? ' (a sub-folder of it)' : ' (one file of it)'}`)
    : x.state === 'locked' ? L(`- ${x.slot} — 이 사용자가 볼 수 없는 참조예요(내용 없음)`, `- ${x.slot} — a reference this user can't read (no content)`)
      : L(`- ${x.slot} — 원본을 찾을 수 없는 참조예요`, `- ${x.slot} — a reference whose original can't be found`))
  return L(`\n\n(이 폴더에는 다른 폴더의 자료를 가리키는 참조 자리가 있어요. 자리 아래 파일은 같은 폴더 이름(folder: '${link.slug}')과 '자리/파일' 경로로 folder_files · folder_read 도구에서 읽어요:
${shown.map(line).join('\n')}
참조된 자료는 읽기만 해요. 고쳐야 하면 무엇을 왜 고쳐야 하는지 답에 적고, 원본 폴더에서 고쳐 달라고 사용자에게 말해 주세요.)`,
  `\n\n(This folder has reference slots that point at material in other folders. Files under a slot are read with the folder_files and folder_read tools, with the same folder (folder: '${link.slug}') and the path 'slot/file':
${shown.map(line).join('\n')}
Referenced material is read only. If it needs changing, say in your answer what should change and why, and ask the user to change it in its original folder.)`)
}

// ---------- adding, renaming, removing ----------
const cleanName = (s) => String(s || '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80)
// a slot path from what was typed: no control characters, '/' between parts only, no part '.git' or '..' (safeRel)
function slotPath(s, { type, sourcePath }) {
  let p = String(s || '').replace(/[\u0000-\u001f\u007f]/g, '').split('/').map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean).join('/')
  p = S.safeRel(p)
  // a file's slot keeps the file's kind (its extension decides how it opens)
  const ext = type === 'file' ? path.posix.extname(sourcePath || '') : ''
  if (ext && path.posix.extname(p).toLowerCase() !== ext.toLowerCase()) p = `${p}${ext}`
  if (p.length > 200) throw err(400, L('자리 이름이 너무 길어요.', 'That slot name is too long.'))
  return p
}
async function event(folder, refId, actor, kind, detail = {}) {
  await q('insert into pro_folder_ref_events (tenant_id, folder_id, ref_id, actor, kind, detail) values ($1,$2,$3,$4,$5,$6)', [T(), folder.id, refId, actor || null, kind, detail]).catch(() => {})
}
// the slot is free: no other reference on it, nothing of this folder there
async function assertFree(folder, slot, rows, exceptId = null) {
  if (rows.some((x) => String(x.id) !== String(exceptId) && overlaps(x.slot, slot))) throw err(409, L('그 자리에는 이미 참조가 있어요. 다른 이름을 적어 주세요.', 'There is already a reference there. Please choose another name.'), 'ref_taken')
  if ((await occupied(folder.repo_path, folder.default_branch, [slot])).has(slot)) throw err(409, L('그 자리에 이 폴더의 파일이 있어요. 다른 이름을 적어 주세요.', 'A file of this folder is already there. Please choose another name.'), 'ref_taken')
}
const mayCompose = (folder, role) => {
  if (folder.kind !== 'managed') throw err(400, L('참조는 관리형 공유 폴더에만 둘 수 있어요.', 'References can only be kept in a managed shared folder.'))
  if (S.RANK[role] < S.RANK.editor) throw err(403, L("참조를 바꾸려면 이 폴더의 'editor' 권한이 필요해요.", "Changing references needs the 'editor' role in this folder."))
}

// POST /folders/:slug/refs {source, path?, slot?, label?} — an editor of the folder who may read the source (viewer and up). New
// references follow the source's main.
export async function add(folder, role, user, { source, path: srcRel = '', slot, label } = {}) {
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
  const p = srcRel && String(srcRel).replace(/^\/+|\/+$/g, '') ? S.safeRel(srcRel) : ''
  let type = 'folder'
  if (p) {
    const head = await G.head(src.repo_path, src.default_branch)
    const t = (await typesAt(src.repo_path, head, [p])).get(p)
    if (!t) throw err(404, L('원본 폴더에서 그 경로를 찾지 못했어요.', "That path isn't in the original folder."))
    type = t === 'blob' ? 'file' : 'dir'
  }
  const name = cleanName(label) || cleanName(slot ? String(slot).split('/').pop() : '') || (p ? path.posix.basename(p) : cleanName(src.name))
  const s = slotPath(slot || name.replace(/\//g, '·'), { type, sourcePath: p })
  const rows = await rowsOf(folder.id)
  if (rows.length >= MAX_REFS) throw err(409, L(`참조는 폴더 하나에 ${MAX_REFS}개까지예요.`, `A folder holds at most ${MAX_REFS} references.`))
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
  const st = await stateOf(r, user)
  return view(r, st, { names: await namesOf([r.created_by]) })
}
async function own(folder, id) {
  if (!UUID.test(String(id || ''))) throw err(404, L('참조를 찾지 못했어요.', "I couldn't find that reference."))
  const [r] = await q('select * from pro_folder_refs where id=$1 and folder_id=$2 and tenant_id=$3', [id, folder.id, T()]).catch((e) => { if (missing(e)) return []; throw e })
  if (!r) throw err(404, L('참조를 찾지 못했어요.', "I couldn't find that reference."))
  return r
}
// PATCH /folders/:slug/refs/:id {slot?, label?} — the slot's name (an editor; the source is not looked at)
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
  const [n] = await q('update pro_folder_refs set slot=$2, label=$3, updated_at=now() where id=$1 returning *', [r.id, s, name || r.label]).catch((e) => {
    if (e.code === '23505') throw err(409, L('그 자리에는 이미 참조가 있어요. 다른 이름을 적어 주세요.', 'There is already a reference there. Please choose another name.'), 'ref_taken')
    throw e
  })
  await event(folder, r.id, user.id, 'renamed', { from: r.slot, to: s })
  emit(user.id, 'folders', { slug: folder.slug })
  return view(n, await stateOf(n, user, { shadow: (await occupied(folder.repo_path, folder.default_branch, [n.slot])).has(n.slot) }), { names: await namesOf([n.created_by]) })
}
// DELETE /folders/:slug/refs/:id — the slot goes, the source stays as it is (an editor who cannot read the source may remove it too)
export async function remove(folder, role, user, id) {
  mayCompose(folder, role)
  const r = await own(folder, id)
  await q('delete from pro_folder_refs where id=$1', [r.id])
  await event(folder, r.id, user.id, 'removed', { slot: r.slot })
  emit(user.id, 'folders', { slug: folder.slug })
  return { ok: true }
}

// POST /folders/:slug/refs/:id/request-access — a member who sees the slot locked asks the source's owners. The request is the existing
// folder access notice (type folder_access, the same address as a file mention's 「권한 요청」: it opens the source's 공유 sheet with the
// person picked) — no access of its own per reference: accepted, it is membership of the source. The answer says nothing about the
// source (not who was told).
export const requestUrl = (slug, userId) => `/folders/${slug}?share=${userId}`
export async function requestAccess(folder, user, id) {
  const r = await own(folder, id)
  const src = await sourceOf(r, new Map())
  if (!src) throw err(404, L('원본을 찾을 수 없는 참조예요.', "This reference's original can't be found."))
  if (await S.roleOf(src, user)) return { requested: false, access: true }
  const [again] = await q(`select 1 from pro_folder_ref_events where tenant_id=$1 and ref_id=$2 and actor::text=$3 and kind='access_requested' and at > now() - interval '1 day' limit 1`,
    [T(), r.id, String(user.id)])
  if (again) return { requested: true }
  const owners = (await q(`select principal_id as id from pro_folder_members where folder_id=$1 and principal_type='user' and role='owner'`, [src.id])).map((x) => x.id)
  const url = requestUrl(src.slug, user.id)
  for (const id2 of owners.filter((x) => x && x !== String(user.id))) {
    const [u] = await q('select id::text as id, email from users where id::text=$1 and tenant_id=$2', [id2, T()])
    if (!u) continue
    const [dup] = await q(`select 1 from notifications where tenant_id=$1 and user_id = any($2) and type='folder_access' and url=$3 and coalesce(is_checked,false)=false limit 1`, [T(), [u.id, u.email], url])
    if (dup) continue
    const title = L(`${user.name}님이 「${src.name}」 폴더 권한을 요청했어요`, `${user.name} asked for access to the "${src.name}" folder`)
    const text = L(`다른 폴더에 둔 참조 「${r.label}」로 이 폴더의 자료를 읽으려고 해요. 폴더의 「공유」에서 구성원으로 추가할 수 있어요.`,
      `They want to read this folder's material through a reference, "${r.label}", kept in another folder. Add them in the folder's Share.`)
    await q(`insert into notifications(id,user_id,title,type,description,url,from_user_id,tenant_id) values (gen_random_uuid(),$1,$2,'folder_access',$3,$4,$5,$6)`,
      [u.id, title.slice(0, 200), text, url, user.email || String(user.id), T()])
    emit(u.id, 'notifications', {})
  }
  await event(folder, r.id, user.id, 'access_requested', {})
  return { requested: true }
}

// ---------- writes under a slot ----------
// A person's write into the composing folder's main at rel (올리기 · 지우기 · 이음오피스 저장 · 작업실 · 폴더에 넣기): refused where a
// reference is (a slot a file of this folder already took is that file's, as before)
// at: {repo, rev} — a variation's checkout is measured against its own line (as its commit is — dropSlotWrites), main otherwise
export async function assertWritable(folder, rel, { at = null } = {}) {
  if (!folder || folder.kind !== 'managed') return
  const rows = await rowsOf(folder.id)
  if (!rows.length) return
  const p = S.safeRel(rel)
  const hit = rows.filter((r) => overlaps(r.slot, p))
  if (!hit.length) return
  const occ = await occupied(at?.repo || folder.repo_path, at?.rev || folder.default_branch, hit.map((r) => r.slot))
  if (hit.some((r) => !occ.has(r.slot))) throw err(409, L('참조된 자료예요. 원본 폴더에서 고쳐 주세요.', 'This is referenced material. Change it in its original folder.'), 'ref_readonly')
}
// the slots a new file may not take (filing picks another name beside them)
export async function slotPaths(folder) {
  if (!folder || folder.kind !== 'managed') return []
  return (await rowsOf(folder.id)).map((r) => r.slot)
}

// Before any commit of a variation's checkout (git.js commitAll — service.js commitVariation is the one that makes them): the variation
// whose checkout it is, and what was written at its folder's slots left out
G.onBeforeCommit(async (cwd) => {
  const [v] = await q('select * from pro_folder_variations where worktree_path=$1 limit 1', [cwd]).catch(() => [])
  if (!v) return
  const folder = await S.folderById(v.folder_id)
  if (folder) await dropSlotWrites(folder, v, cwd)
})
// What a run (an agent, a terminal) left at a slot in a variation's checkout is not kept — the referenced material is read only in
// the composing folder — and the person whose run it was is told in their conversation. A slot the variation's own files already take
// is theirs. Called before a variation's commit (service.js commitVariation) → the paths left out.
export async function dropSlotWrites(folder, v, dir) {
  if (!dir || folder?.kind !== 'managed') return []
  const rows = await rowsOf(folder.id).catch(() => [])
  if (!rows.length) return []
  const occ = await occupied(dir, 'HEAD', rows.map((r) => r.slot))
  const slots = rows.map((r) => r.slot).filter((s) => !occ.has(s))
  if (!slots.length) return []
  const specs = slots.map((s) => `:(literal)${s}`)
  const st = await G.git(dir, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...specs], { check: false })
  const parts = st.split('\0')
  const paths = []
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i]
    if (!e) continue
    paths.push(e.slice(3))
    if (e[0] === 'R' || e[0] === 'C') i++ // (a rename names where it came from next)
  }
  if (!paths.length) return []
  // unstaged, then removed (git removes a link as the link itself, never what it points at)
  await G.git(dir, ['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', ...specs], { check: false })
  await G.git(dir, ['clean', '-f', '-d', '-q', '--', ...specs], { check: false })
  console.warn(`[folders] refs: ${paths.length} write(s) at a reference slot of '${folder.slug}' not kept (variation ${v?.id})`)
  const thread = v?.source?.thread_id
  if (thread && v.holder_type === 'user' && v.holder_id) {
    const shown = paths.slice(0, 3).map((x) => `‘${x}’`).join(', ') + (paths.length > 3 ? L(` 외 ${paths.length - 3}개`, ` and ${paths.length - 3} more`) : '')
    const { addMessage } = await import('../store.js')
    await addMessage(v.holder_id, thread, 'agent', 'chip', { icon: 'info', refsReadOnly: paths.slice(0, 20),
      text: L(`참조된 자료 ${shown}는 읽기 전용이라 바꾼 내용을 담지 않았어요 · 고쳐야 하면 원본 폴더에서 고쳐 주세요`,
        `The referenced material ${shown} is read only here, so the changes to it were not kept · change it in its original folder` ) }).catch((e) => console.warn('[folders] refs note', e.message))
  }
  return paths
}
