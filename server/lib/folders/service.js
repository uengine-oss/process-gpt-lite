// Shared folders (공유 폴더) — design 안 2: each folder is a git repository whose working tree is
// `main` (people upload and edit it like a drive; every change is committed with its author).
// A variation is a branch; it is checked out only while someone works on it — an agent run gets it
// inside its own run folder (deepagents: /workspace/.bpmn/<room>/folders/<slug>, cli-agent: its
// worktree), a person gets it under <root>/.people. Only this server runs git.
import fs from 'node:fs/promises'
import { readlinkSync } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { config } from '../../config.js'
import { q, admin } from '../supa.js'
import * as G from './git.js'
import { PGPT_ROOT } from '../paths.js'
import { L } from '../lang.js'
import * as PS from '../privateStore.js'
import { people } from '../people.js'
import { isAdmin } from '../team.js'
import { assertNoLink } from '../noLinks.js'
import { kitCounts } from './kit.js'
import { stillHeld } from './diskLease.js'

const T = () => config.tenantId
const PGPT = PGPT_ROOT
// folder repositories live outside the deepagents workspace (and outside any other repository), so
// the sandbox never sees a folder's history or other variations — only the checkout a run is given
// inside its own run folder
// (both per tenant, read when used: one server can serve more than one tenant — lib/tenant.js)
export const foldersRoot = () => path.join(config.foldersRoot || path.join(os.homedir(), 'pgpt-folders'), config.tenantId)
export const workspaceDir = () => path.join(PGPT, 'services/deepagents/workspace', config.tenantId)

export const RANK = { viewer: 1, runner: 2, editor: 3, owner: 4 }
const err = (status, message) => Object.assign(new Error(message), { status })

// ---------- folders & permissions ----------
// a linked folder (a repository registered where it is) exists only where linking is on (linkingOn)
const usable = (f) => (f && (f.kind !== 'linked' || linkingOn()) ? f : null)
export async function folderBySlug(slug) {
  const [f] = await q('select * from pro_folders where tenant_id=$1 and slug=$2', [T(), slug])
  return usable(f)
}
export async function folderById(id) {
  const [f] = await q('select * from pro_folders where id=$1', [id])
  return usable(f)
}
export async function roleOf(folder, user) {
  if (!folder || !user) return null
  const [m] = await q(`select role from pro_folder_members where folder_id=$1 and principal_type='user' and principal_id=$2`, [folder.id, String(user.id)])
  if (folder.kind !== 'skill') return m?.role || null
  // a skill: its author owns it, the boss of an agent using it may merge (editor), and a shared
  // skill is open to everyone in the tenant for looking and proposing (runner)
  const name = folder.settings?.skill_name
  const [v] = await q(`select coalesce(v.visibility, 'tenant') as visibility, coalesce(v.author_id, t.owner_id)::text as author
                       from (select $2::text as n) x left join pro_skill_visibility v on v.tenant_id=$1 and v.skill_name=x.n
                       left join tenant_skills t on t.tenant_id=$1 and t.skill_name=x.n`, [T(), name])
  const [boss] = await q(`select 1 from agent_skills a join pro_agent_owners o on o.agent_user_id=a.user_id and o.tenant_id=a.tenant_id
                          where a.tenant_id=$1 and a.skill_name=$2 and o.owner_user_id::text=$3 limit 1`, [T(), name, String(user.id)])
  const roles = [m?.role, v?.author === String(user.id) ? 'owner' : null, boss ? 'editor' : null, v?.visibility === 'tenant' ? 'runner' : null].filter(Boolean)
  return roles.sort((a, b) => RANK[b] - RANK[a])[0] || null
}
// the folder, refused unless the user holds at least `need`
export async function access(slug, user, need = 'viewer') {
  const folder = await folderBySlug(slug)
  if (!folder) throw err(404, L('폴더를 찾지 못했어요.', "I couldn't find that folder."))
  const role = await roleOf(folder, user)
  if (!role) throw err(403, L('이 폴더의 구성원이 아니에요.', "You aren't a member of this folder."))
  if (RANK[role] < RANK[need]) throw err(403, L(`이 작업에는 '${need}' 권한이 필요해요.`, `This needs the '${need}' role.`))
  return { folder, role }
}
export async function readableFolderIds(userId) {
  return (await q(`select f.id from pro_folders f join pro_folder_members m on m.folder_id=f.id and m.principal_type='user' and m.principal_id=$2
                   where f.tenant_id=$1 and (f.kind <> 'linked' or $3)`, [T(), String(userId), linkingOn()])).map((r) => r.id)
}

const slugify = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
async function freeSlug(base) {
  let slug = base || `folder-${crypto.randomBytes(3).toString('hex')}`
  for (let i = 2; await folderBySlug(slug); i++) slug = `${base || 'folder'}-${i}`
  return slug
}

const GITATTRIBUTES = `# documents and media cannot be merged line by line: a conflict is resolved by choosing a side
*.docx binary
*.xlsx binary
*.pptx binary
*.hwp binary
*.hwpx binary
*.pdf binary
*.png binary
*.jpg binary
*.jpeg binary
*.psd binary
*.dxf -text
*.mp4 binary
*.wav binary
*.mp3 binary
`

// A champion folder's own attributes (its repository's info/attributes, above any .gitattributes the uploaded folder carries — git reads
// that file first): every file is taken byte for byte (no line-ending change, no filter, no keyword or encoding rewrite) and merged by
// git's own line merge (no merge driver the folder names, like union, which would combine both sides without a conflict); documents and
// media stay binary as in every folder.
export const CHAMPION_ATTRIBUTES = `# a champion folder: what the uploaded folder's own .gitattributes says does not change how this server checks out or merges
* -text -filter -ident -working-tree-encoding !eol !merge
${GITATTRIBUTES}`
export async function championAttributes(dir) {
  const f = path.join(dir, '.git', 'info', 'attributes')
  if ((await fs.readFile(f, 'utf8').catch(() => '')) === CHAMPION_ATTRIBUTES) return false
  await fs.mkdir(path.dirname(f), { recursive: true })
  await fs.writeFile(f, CHAMPION_ATTRIBUTES)
  return true
}
// champion: a folder a person's computer uploads (champion folders — folders/sources.js): its first commit has no file at all (the
// attributes go to the repository's own info/attributes), so the first snapshot from that computer, made on top of it, deletes nothing
export async function createFolder(user, { name, description = '', slug, champion = false }) {
  name = String(name || '').trim()
  if (!name) throw err(400, L('폴더 이름을 적어 주세요.', 'Please enter a folder name.'))
  if ((await q('select 1 from pro_folders where tenant_id=$1 and name=$2', [T(), name])).length) throw err(409, L('같은 이름의 폴더가 이미 있어요.', 'A folder with that name already exists.'))
  slug = await freeSlug(slugify(slug) || slugify(name))
  const dir = path.join(foldersRoot(), slug)
  await fs.mkdir(dir, { recursive: true })
  await G.git(dir, ['init', '-q', '-b', 'main'])
  if (champion) {
    await championAttributes(dir)
    await G.git(dir, [...G.who(user.name, user.email), 'commit', '-q', '--allow-empty', '-m', L('폴더 만들기', 'Create folder')])
  } else {
    await fs.writeFile(path.join(dir, '.gitattributes'), GITATTRIBUTES)
    await G.commitAll(dir, L('폴더 만들기', 'Create folder'), { name: user.name, email: user.email })
  }
  const settings = champion ? { champion: { by: String(user.id), at: new Date().toISOString() } } : {}
  const [f] = await q(`insert into pro_folders (tenant_id, slug, name, description, kind, repo_path, created_by, settings)
                       values ($1,$2,$3,$4,'managed',$5,$6,$7) returning *`, [T(), slug, name, description, dir, user.id, settings])
  await q(`insert into pro_folder_members (folder_id, principal_type, principal_id, role, added_by) values ($1,'user',$2,'owner',$3)`, [f.id, String(user.id), user.id])
  return f
}
// A champion folder whose upload never happened (the person said no on their computer, or it failed): it goes away again — only while
// main has no file and nothing was made in it, and only by its owner.
export async function discardEmptyChampion(folder, role) {
  if (!folder.settings?.champion || folder.kind !== 'managed') throw err(400, L('내 PC 에서 올리려고 만든 폴더만 이렇게 지울 수 있어요.', 'Only a folder made for an upload from a computer can be removed this way.'))
  if (role !== 'owner') throw err(403, L('폴더 소유자만 지울 수 있어요.', 'Only the folder owner can remove it.'))
  const files = (await G.lsTree(folder.repo_path, folder.default_branch)).length
  const [{ n }] = await q('select count(*)::int as n from pro_folder_variations where folder_id=$1', [folder.id])
  if (files || n) throw err(409, L('이미 파일이 올라간 폴더예요.', 'Files are already in this folder.'))
  await q('delete from pro_folders where id=$1', [folder.id])
  if (folder.repo_path && path.resolve(folder.repo_path).startsWith(path.resolve(foldersRoot()) + path.sep)) await fs.rm(folder.repo_path, { recursive: true, force: true })
  return { ok: true }
}

// Registering a repository that is on this server's own disk is for an install that serves one
// company (on its own PC or server): never on a server that serves several companies (behind the
// ProcessGPT gateway, or more tenants by host name), only that company's administrators, and never
// a place this server already keeps folders in (those have their own members). PRO_FOLDERS_LINK=0
// turns it off on an install too.
export const linkingOn = () => !config.tenantFromHeader && !config.tenantHosts && process.env.PRO_FOLDERS_LINK !== '0'
export async function mayLink(user) { return linkingOn() && !!user?.id && (await isAdmin(user)) }

// Where a repository to link really is: its own top folder, refused when it or its git data (a
// worktree keeps its data in the repository it came from) is in the folders base, or holds the base.
export async function linkTarget(repoPath) {
  const given = path.resolve(String(repoPath || ''))
  if (!(await G.isRepo(given))) throw err(400, L('git 저장소가 아니에요.', "That isn't a git repository."))
  // the repository's own top folder (not a folder inside some other work tree), and where its git data
  // lives (a worktree's data is in the repository it came from): neither may be in the folders base,
  // and the base may not be inside it
  const real = async (p) => fs.realpath(p).catch(() => path.resolve(p))
  const top = await real((await G.git(given, ['rev-parse', '--show-toplevel'])).trim())
  if (top !== (await real(given))) throw err(400, L('저장소의 맨 위 폴더를 골라 주세요.', "Pick the repository's top folder."))
  const common = await real(path.resolve(top, (await G.git(top, ['rev-parse', '--git-common-dir'])).trim()))
  const base = await real(config.foldersRoot || path.join(os.homedir(), 'pgpt-folders'))
  const within = (p, b) => p === b || p.startsWith(b + path.sep)
  if (within(top, base) || within(common, base) || within(base, top)) throw err(400, L('이미 폴더로 관리되는 곳이에요. 그 폴더의 구성원으로 초대받아 주세요.', 'That place is already kept as a folder. Ask to be invited to it.'))
  return top
}

// An existing repository registered as it is: nothing in it is changed (its branches and
// worktrees are only listed), its current branch stands for main.
export async function linkRepo(user, { repoPath, name, description = '' }) {
  if (!linkingOn()) throw err(403, L('이 서버에서는 저장소를 연결할 수 없어요. 새 폴더를 만들어 파일을 올려 주세요.', "Repositories can't be linked on this server. Create a folder and upload the files instead."))
  if (!(await isAdmin(user))) throw err(403, L('저장소 연결은 관리자만 할 수 있어요.', 'Only an administrator can link a repository.'))
  const dir = await linkTarget(repoPath)
  const existing = (await q('select * from pro_folders where tenant_id=$1 and repo_path=$2', [T(), dir]))[0]
  if (existing) throw err(409, L('이 저장소는 이미 연결돼 있어요. 그 폴더의 구성원으로 초대받아 주세요.', 'This repository is already linked. Ask to be invited to that folder.'))
  return registerLinked(user, dir, { name, description })
}
// the row of a linked folder, after linkRepo's checks (tests make linked folders with it directly)
export async function registerLinked(user, dir, { name, description = '' } = {}) {
  const branch = (await G.git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
  const main = (await G.branchExists(dir, 'main')) ? 'main' : branch
  const slug = await freeSlug(slugify(name || path.basename(dir)))
  const [f] = await q(`insert into pro_folders (tenant_id, slug, name, description, kind, repo_path, default_branch, created_by)
                       values ($1,$2,$3,$4,'linked',$5,$6,$7) returning *`, [T(), slug, name || path.basename(dir), description || L(`연결형 · ${dir}`, `Linked · ${dir}`), dir, main, user.id])
  await q(`insert into pro_folder_members (folder_id, principal_type, principal_id, role, added_by) values ($1,'user',$2,'owner',$3)`, [f.id, String(user.id), user.id])
  return f
}

// ---------- listing ----------
export async function listFolders(user) {
  const rows = await q(`select f.*, m.role,
      (select count(*) from pro_folder_variations v where v.folder_id=f.id and v.status in ('open','ready','conflicted'))::int as live,
      (select count(*) from pro_folder_variations v where v.folder_id=f.id and v.status='open')::int as open,
      (select count(*) from pro_folder_variations v where v.folder_id=f.id and v.status='ready')::int as ready
    from pro_folders f join pro_folder_members m on m.folder_id=f.id and m.principal_type='user' and m.principal_id=$2
    where f.tenant_id=$1 and f.kind <> 'skill' and (f.kind <> 'linked' or $3) order by f.updated_at desc`, [T(), String(user.id), linkingOn()])
  // (everyone's members at once: one lookup of names for the whole list, not one per folder)
  const all = await membersOfFolders(rows.map((f) => f.id))
  // (the agent assets found in each, by type — a card's 「스킬 6 · 명령 4」: kit.js)
  const kits = await kitCounts(rows.map((f) => f.id)).catch(() => new Map())
  for (const f of rows) {
    f.members = all.get(String(f.id)) || []
    f.activity = await lastActivity(f)
    f.kit = kits.get(String(f.id)) || null
  }
  return rows.map(publicFolder)
}
export function publicFolder(f) {
  const { repo_path, ...rest } = f
  return { ...rest, repo: f.kind === 'linked' ? repo_path : undefined }
}
export async function members(folderId) {
  return (await membersOfFolders([folderId])).get(String(folderId)) || []
}
// folder id → its members, for many folders in one query and one lookup of names: a person by the name every screen shows
// (lib/people.js), an agent by its own. resolve: the lookup (tests count its calls)
export async function membersOfFolders(folderIds, { resolve = people } = {}) {
  const ids = [...new Set((folderIds || []).map(String))]
  const out = new Map(ids.map((id) => [id, []]))
  if (!ids.length) return out
  const rows = await q(`select m.folder_id::text as folder_id, m.principal_type as type, m.principal_id as id, m.role,
              coalesce(p.name, u.username, m.principal_id) as name, u.email, coalesce(u.is_agent, m.principal_type='agent') as is_agent, u.agent_type
            from pro_folder_members m
            left join users u on u.id::text = m.principal_id and u.tenant_id=$2
            left join pro_profile p on p.user_id::text = m.principal_id
            where m.folder_id = any($1::uuid[]) order by array_position(array['owner','editor','runner','viewer'], m.role), m.created_at`, [ids, T()])
  const by = await resolve([...new Set(rows.filter((r) => r.type === 'user').map((r) => r.id))])
  for (const { folder_id: f, ...r } of rows) out.get(f)?.push(r.type === 'user' && by.get(String(r.id)) ? { ...r, name: by.get(String(r.id)).name } : r)
  return out
}
async function lastActivity(f) {
  const [v] = await q(`select title, holder_name, status, updated_at from pro_folder_variations where folder_id=$1 order by updated_at desc limit 1`, [f.id])
  const [c] = (await G.log(f.repo_path, f.default_branch, 1)) || []
  const vAt = v ? new Date(v.updated_at) : null
  const cAt = c ? new Date(c.at) : null
  if (vAt && (!cAt || vAt > cAt)) return { at: vAt, text: `${v.holder_name || ''} · ${v.title} (${statusText(v.status)})` }
  if (cAt) return { at: cAt, text: `${c.name} · ${c.msg}` }
  return null
}
export const STATUS = { open: '작업 중', ready: '반영 대기', conflicted: '충돌', merged: '반영됨', discarded: '버림' }
export const STATUS_EN = { open: 'in progress', ready: 'ready to merge', conflicted: 'conflict', merged: 'merged', discarded: 'discarded' }
export const statusText = (s) => L(STATUS, STATUS_EN)[s]

export async function setMember(folder, me, { type = 'user', id, role }) {
  if (!RANK[role]) throw err(400, L('권한은 owner·editor·runner·viewer 중 하나예요.', 'The role is one of owner, editor, runner, viewer.'))
  await q(`insert into pro_folder_members (folder_id, principal_type, principal_id, role, added_by) values ($1,$2,$3,$4,$5)
           on conflict (folder_id, principal_type, principal_id) do update set role=$4`, [folder.id, type, String(id), role, me.id])
}
export async function removeMember(folder, { type = 'user', id }) {
  const owners = await q(`select principal_id from pro_folder_members where folder_id=$1 and role='owner' and principal_type='user'`, [folder.id])
  if (owners.length === 1 && owners[0].principal_id === String(id)) throw err(400, L('마지막 소유자는 뺄 수 없어요.', "The last owner can't be removed."))
  await q('delete from pro_folder_members where folder_id=$1 and principal_type=$2 and principal_id=$3', [folder.id, type, String(id)])
}

// ---------- main ----------
// One writer at a time in a folder's main (its working tree is shared): commits, IeumOffice saves and the
// fast-forward that ends a merge go through here, so one does not sweep up what another is writing.
const locks = new Map()
export function serial(key, fn) {
  const run = (locks.get(key) || Promise.resolve()).then(fn, fn)
  const tail = run.catch(() => {})
  locks.set(key, tail)
  tail.then(() => { if (locks.get(key) === tail) locks.delete(key) })
  return run
}

// a person's edit in main (upload, workroom, terminal) becomes a commit with its author
export async function commitMainNow(folder, author, message) {
  if (folder.kind === 'linked') return null
  const sha = await G.commitAll(folder.repo_path, message || L('파일 고침', 'Edit files'), author)
  if (sha) await touch(folder)
  return sha
}
export const commitMain = (folder, author, message) => serial(folder.id, () => commitMainNow(folder, author, message))
export const touch = (folder) => q('update pro_folders set updated_at=now() where id=$1', [folder.id])

export function safeRel(rel) {
  const p = path.posix.normalize(String(rel || '').replace(/\\/g, '/').replace(/^\/+/, ''))
  if (!p || p === '.' || p.startsWith('..') || p.split('/').some((s) => s === '.git' || s === '..')) throw err(400, L('올바르지 않은 경로예요.', 'That path is not valid.'))
  return p
}

export async function upload(folder, user, rel, buf) {
  if (folder.kind === 'linked') throw err(400, L('연결형 폴더에는 아직 올릴 수 없어요.', "You can't upload to a linked folder yet."))
  const p = safeRel(rel)
  await assertNoLink(folder.repo_path, p)
  const host = path.join(folder.repo_path, p)
  await fs.mkdir(path.dirname(host), { recursive: true })
  await fs.writeFile(host, buf)
  return commitMain(folder, { name: user.name, email: user.email }, L(`올리기: ${p}`, `Upload: ${p}`))
}
export async function removeFile(folder, user, rel) {
  if (folder.kind === 'linked') throw err(400, L('연결형 폴더의 파일은 지울 수 없어요.', "Files of a linked folder can't be deleted."))
  const p = safeRel(rel)
  await assertNoLink(folder.repo_path, p)
  await fs.rm(path.join(folder.repo_path, p), { force: true })
  return commitMain(folder, { name: user.name, email: user.email }, L(`지우기: ${p}`, `Delete: ${p}`))
}

// files of main (from the index) or of a variation (from git)
export async function tree(folder, ref) {
  if (!ref || ref === 'main') {
    const rows = await q(`select path, kind, size, sha, mtime, author, card is not null as has_card, card, card_error from pro_folder_files where folder_id=$1 order by path`, [folder.id])
    if (rows.length || folder.kind === 'linked') return rows
  }
  const v = ref && ref !== 'main' ? await variation(folder, ref) : null
  const r = v ? v.branch : folder.default_branch
  const files = await G.lsTree(folder.repo_path, r)
  const touched = await G.lastTouch(folder.repo_path, r)
  return files.filter((f) => f.path !== '.gitattributes' || folder.settings?.champion).map((f) => ({ ...f, author: touched.get(f.path)?.name, mtime: touched.get(f.path)?.at }))
}
// what a ref names in git: main (or nothing), a variation (its id), or a commit of the folder (its 40-hex id — a file mention
// keeps the commit it was made at: lib/fileRefs.js)
export const COMMIT = /^[0-9a-f]{40}$/
export async function revOf(folder, ref) {
  if (!ref || ref === 'main') return folder.default_branch
  if (COMMIT.test(String(ref))) {
    const ok = (await G.git(folder.repo_path, ['cat-file', '-t', String(ref)], { check: false })).trim() === 'commit'
    if (!ok) throw err(404, L('그 판을 찾지 못했어요.', "I couldn't find that version."))
    return String(ref)
  }
  return (await variation(folder, ref)).branch
}
// the blob a path has at a rev ('' when it is not there)
export async function blobAt(folder, rev, rel) {
  return (await G.git(folder.repo_path, ['rev-parse', '--verify', '-q', `${rev}:${safeRel(rel)}`], { check: false })).trim()
}
export async function readBlob(folder, ref, rel) {
  const p = safeRel(rel)
  const r = await revOf(folder, ref)
  return G.show(folder.repo_path, r, p).catch(() => { throw err(404, L('파일이 없어요.', "That file isn't there.")) })
}
// IeumOffice and the ArtCraft apps load documents only from storage: a copy of one version of a file
// (content-addressed, so the same blob is uploaded once) — the folder screen's 열기 and an agent's
// folder_open share it
export const MIME = {
  md: 'text/markdown; charset=utf-8', txt: 'text/plain; charset=utf-8', csv: 'text/csv; charset=utf-8', json: 'application/json', py: 'text/plain; charset=utf-8', js: 'text/plain; charset=utf-8',
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', wav: 'audio/wav', mp3: 'audio/mpeg',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', hwpx: 'application/hwp+zip', hwp: 'application/x-hwp', dxf: 'image/vnd.dxf', psd: 'image/vnd.adobe.photoshop',
}
export async function publishFile(folder, rel, ref) {
  const p = safeRel(rel)
  const r = await revOf(folder, ref)
  const sha = (await G.git(folder.repo_path, ['rev-parse', `${r}:${p}`], { check: false })).trim()
  if (!sha) throw err(404, L('파일이 없어요.', "That file isn't there."))
  return publishBlob(folder, p, sha)
}
// one version of a file by its blob id (a file mention opens the version it named, lib/fileRefs.js)
export async function publishBlob(folder, rel, sha) {
  const p = safeRel(rel)
  if (!/^[0-9a-f]{40}$/.test(String(sha || '')) || (await G.git(folder.repo_path, ['cat-file', '-t', sha], { check: false })).trim() !== 'blob') throw err(404, L('파일이 없어요.', "That file isn't there."))
  const ext = (path.extname(p).slice(1).toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin')
  const key = `pgpt-pro/folders/${folder.id}/${sha}.${ext}`
  const { data: there } = await admin.storage.from('files').list(`pgpt-pro/folders/${folder.id}`, { search: `${sha}.${ext}` })
  if (!there?.length) {
    const { error } = await admin.storage.from('files').upload(key, await G.git(folder.repo_path, ['cat-file', 'blob', sha], { buffer: true }), { contentType: MIME[ext] || 'application/octet-stream', upsert: true })
    if (error) throw error
  }
  return { url: `${config.supabaseUrl}/storage/v1/object/public/files/${key}`, name: path.basename(p), sha }
}

// ---------- an edit made in IeumOffice ----------
// The folder screen opens main's file in IeumOffice for an editor of the folder. The editor saves its copy
// next to the published one (office-host: pgpt-pro/folders/<folder>/edited-<stem>_<time>.<ext>); that copy
// becomes the file in main, with its author, like an upload. One editing session is one entry in 이력:
// its later saves fold into its commit while that commit is still main's newest and nothing stands on it.
// When main's file changed after the editor opened it (someone else saved), the edit is kept beside it as
// "<name> (<who> 수정본)" — never over the other person's version (nor bringing back a file someone deleted).
export const OFFICE_EDIT = new Set(['docx', 'xlsx', 'pptx', 'hwpx', 'hwp'])
// the storage key of an editor's copy of this folder's file, or null (any other object is refused)
export function editedObject(folder, url) {
  let u
  try { u = new URL(String(url)) } catch { return null }
  const m = /\/storage\/v1\/object\/(?:public|authenticated|sign)\/files\/(.+)$/.exec(u.pathname)
  if (!m) return null
  let key
  try { key = decodeURIComponent(m[1]) } catch { return null }
  const dir = `pgpt-pro/folders/${folder.id}/`
  const name = key.startsWith(dir) ? key.slice(dir.length) : ''
  return /^edited-[A-Za-z0-9._-]+$/.test(name) ? key : null
}
// …or of its private copy (a mail's attachment filed here, opened from the mail — lib/mailAttachments.js: never a public address):
// {bucket, key} in the private bucket beside folders/<tenant>/<folder>/, or null
export function editedPrivateObject(folder, url) {
  const o = PS.objectOfUrl(url)
  if (!o || o.bucket !== PS.BUCKET) return null
  let dir
  try { dir = PS.folderDir({ tenant: T(), folderId: folder.id }) } catch { return null }
  return PS.editedIn(dir, o.key) ? o : null
}
async function copyPath(folder, rel, user) {
  const ext = path.posix.extname(rel)
  const stem = rel.slice(0, rel.length - ext.length)
  const who = String(user.name || String(user.email || '').split('@')[0] || L('나', 'me')).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').trim().slice(0, 30) || L('나', 'me')
  for (let n = 1; n < 50; n++) {
    const p = `${stem} (${L(`${who} 수정본`, `${who}'s edit`)}${n > 1 ? ` ${n}` : ''})${ext}`
    const there = (await G.git(folder.repo_path, ['rev-parse', '--verify', '-q', `${folder.default_branch}:${p}`], { check: false })).trim()
    if (!there) return p
  }
  throw err(409, L('수정본 이름을 정하지 못했어요.', "Couldn't name the edited copy."))
}
export async function saveOfficeEdit(folder, user, { path: rel, base, url, session } = {}) {
  if (folder.kind === 'linked') throw err(400, L('연결형 폴더의 파일은 여기서 고칠 수 없어요.', "Files of a linked folder can't be edited here."))
  const p = safeRel(rel)
  const ext = path.extname(p).slice(1).toLowerCase()
  if (!OFFICE_EDIT.has(ext)) throw err(400, L('이음오피스로 고쳐 저장하는 형식이 아니에요.', "This format isn't saved from IeumOffice."))
  const priv = editedObject(folder, url) ? null : editedPrivateObject(folder, url)
  const key = priv ? priv.key : editedObject(folder, url)
  if (!key || path.extname(key).slice(1).toLowerCase() !== ext) throw err(400, L('저장한 편집본을 찾지 못했어요.', "I couldn't find the saved copy."))
  const { data, error } = await admin.storage.from(priv ? PS.BUCKET : 'files').download(key)
  if (error || !data) throw err(404, L('저장한 편집본을 받지 못했어요.', "I couldn't fetch the saved copy."))
  const buf = Buffer.from(await data.arrayBuffer())
  if (!buf.length) throw err(400, L('편집본이 비어 있어요.', 'The saved copy is empty.'))
  const sid = String(session || '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 40)
  const blobAt = async (x) => (await G.git(folder.repo_path, ['rev-parse', '--verify', '-q', `${folder.default_branch}:${x}`], { check: false })).trim()
  return serial(folder.id, async () => {
    const now = await blobAt(p)
    // the version the editor opened is no longer main's (changed, or deleted): keep this edit beside it
    const moved = base ? now !== String(base) : !!now
    const target = moved ? await copyPath(folder, p, user) : p
    await assertNoLink(folder.repo_path, target)
    const host = path.join(folder.repo_path, target)
    await fs.mkdir(path.dirname(host), { recursive: true })
    await fs.writeFile(host, buf)
    const author = { name: user.name, email: user.email }
    const message = `${L(`이음오피스에서 고침: ${target}`, `Edited in IeumOffice: ${target}`)}${sid ? `\n\nOffice-Session: ${sid}` : ''}`
    const fold = !!sid && await G.canFold(folder.repo_path, folder.default_branch, { message, path: target, email: author.email || 'folders@pgpt-pro.local' })
    const done = await G.commitPath(folder.repo_path, target, message, author, { amend: fold })
    if (done) await touch(folder)
    return { path: target, sha: await blobAt(target), commit: done?.commit || null, copied: target !== p, folded: !!done && fold, undone: !!done?.dropped }
  })
}
export async function history(folder, limit = 40) {
  return G.log(folder.repo_path, folder.default_branch, limit)
}

// ---------- variations ----------
export async function variation(folder, id) {
  if (!/^[0-9a-f-]{36}$/.test(String(id))) throw err(404, L('변형을 찾지 못했어요.', "I couldn't find that variation."))
  const [v] = await q('select * from pro_folder_variations where id=$1 and folder_id=$2', [id, folder.id])
  if (!v) throw err(404, L('변형을 찾지 못했어요.', "I couldn't find that variation."))
  return v
}
export async function variationById(id) {
  const [v] = await q('select * from pro_folder_variations where id=$1', [id])
  return v || null
}
const short = (s, n = 24) => slugify(s).slice(0, n) || crypto.randomBytes(3).toString('hex')

// base: 'main' | a variation id | a branch name. kind run/chat → var/run/<id>, person → var/u/<who>/<title>
export async function createVariation(folder, { title, kind = 'person', base, holder, source = {}, createdBy, branch }) {
  const id = crypto.randomUUID()
  let baseRef = folder.default_branch
  if (base && base !== 'main') {
    const bv = /^[0-9a-f-]{36}$/.test(base) ? await variation(folder, base).catch(() => null) : null
    baseRef = bv ? bv.branch : base
  }
  if (!branch) {
    branch = kind === 'person' || kind === 'handover'
      ? `var/u/${String(holder?.id || 'me').replace(/[^A-Za-z0-9]/g, '').slice(0, 8)}/${slugify(title).slice(0, 24) || id.slice(0, 8)}`
      : `var/run/${(source.todo_id || id).replace(/-/g, '').slice(0, 12)}`
  }
  const baseSha = await G.head(folder.repo_path, baseRef)
  if (!baseSha) throw err(400, L(`기준을 찾지 못했어요: ${baseRef}`, `I couldn't find the base: ${baseRef}`))
  if (!(await G.branchExists(folder.repo_path, branch))) await G.git(folder.repo_path, ['branch', branch, baseSha])
  const [v] = await q(`insert into pro_folder_variations (id, folder_id, branch, title, kind, status, base_commit, head_commit, holder_type, holder_id, holder_name, source, created_by)
                       values ($1,$2,$3,$4,$5,'open',$6,$6,$7,$8,$9,$10,$11)
                       on conflict (folder_id, branch) do update set updated_at=now() returning *`,
  [id, folder.id, branch, title || L('새 변형', 'New variation'), kind, baseSha, holder?.type || 'user', holder?.id ? String(holder.id) : null, holder?.name || null, source, createdBy || null])
  await touch(folder)
  return v
}

// put a variation's branch on disk at `dir` (reused when it is already there). Which place may have it is the seat's to say
// (folders/seats.js openServer — the only caller besides tests); a place this takes the branch from is committed as it is first
// (variation seats: nothing a place held is thrown away when the branch moves)
export async function checkout(folder, v, dir) {
  // (a retire that stopped mid-way — a pod killed — left the branch's old entry locked: freed first, or 409 while it may still go on)
  await stillHeld('checkout')
  if ((await freeStoppedRetires(folder.repo_path, { branch: v.branch })).waiting) {
    throw Object.assign(err(409, L('다른 서버가 이 변형의 작업본을 치우고 있어요. 잠시 후 다시 시도해 주세요.', 'Another server is putting this variation\'s working copy away. Try again in a moment.')), { why: 'busy' })
  }
  const list = await G.worktrees(folder.repo_path)
  const here = list.find((w) => path.resolve(w.path) === path.resolve(dir))
  if (here && here.branch === v.branch && await fs.stat(dir).catch(() => null)) { await setWorktree(v, dir); return dir }
  // the branch may be out at another place (an earlier run that was not released): what it holds is kept, then it is freed
  const other = list.find((w) => w.branch === v.branch)
  if (other) {
    await keepWhatIsThere(folder, other.path, other.branch)
    await release(folder, { ...v, worktree_path: other.path }, { keep: true })
  }
  await fs.mkdir(path.dirname(dir), { recursive: true })
  // what is at `dir` now — another branch's checkout, or a folder left there — leaves it the safe way (committed as it is, moved aside
  // when git does not carry everything): never deleted
  if (here?.branch) await keepWhatIsThere(folder, here.path, here.branch)
  await retire(folder.repo_path, dir)
  await G.git(folder.repo_path, ['worktree', 'prune'])
  await stillHeld('checkout')
  await G.git(folder.repo_path, ['worktree', 'add', '-q', dir, v.branch])
  await setWorktree(v, dir)
  return dir
}
const setWorktree = (v, dir) => q('update pro_folder_variations set worktree_path=$2, locked=false, updated_at=now() where id=$1', [v.id, dir])
// a checkout about to go off disk: what it holds is committed as it is (the author: that branch's holder), never reset or cleaned. A commit
// git refuses (a file it cannot read, a lock, the time running out) throws: the caller then moves and removes nothing
export async function keepWhatIsThere(folder, dir, branch) {
  if (!dir || !branch || !(await fs.stat(dir).catch(() => null))) return null
  const [owner] = await q('select holder_name, holder_id from pro_folder_variations where folder_id=$1 and branch=$2', [folder.id, branch]).catch(() => [])
  const [p] = owner?.holder_id ? await q('select name, email from pro_profile where user_id::text=$1', [String(owner.holder_id)]).catch(() => []) : []
  let sha
  await stillHeld('commit')
  await clearStaleLocks(dir, branch).catch(() => 0)
  try { sha = await G.commitAll(dir, L('작업실에서 옮김', 'Moved from the workroom'), { name: p?.name || owner?.holder_name || 'Process GPT Lite', email: p?.email || undefined }) } catch (e) {
    const why = (await import('./seats.js')).gitWhy(e)
    throw Object.assign(new Error(L(`작업본의 변경을 저장하지 못해 옮기지 않았어요 — 작업본은 그대로예요 (${why})`, `The working copy's changes could not be saved, so it did not move — it is as it was (${why})`)), { status: 409, why: 'unsaved' })
  }
  if (sha) await q('update pro_folder_variations set head_commit=$3, updated_at=now() where folder_id=$1 and branch=$2', [folder.id, branch, await G.head(folder.repo_path, `refs/heads/${branch}`)])
  return sha
}
// A stale git lock — index.lock / HEAD.lock of a checkout, or its branch's ref lock — left by a git that was killed (a pod stopped
// mid-commit, a shell's `git commit` closed with its workroom): removed when it is older than twice git's time limit and no process has it
// open. A lock git may still be using is left alone (the commit then fails and nothing moves). Looked for only before a move (a place
// leaving the disk: keepWhatIsThere · seats commitAsIs) and when git refused a commit (commitVariation tries once more) — not on every save.
export const STALE_LOCK_MS = 2 * 60_000
// (only lsof's plain 「nobody」 — exit 1, nothing printed — counts as not open: lsof missing, out of time, refused or any other answer
// counts as open, and the lock stays)
const openBy = (file) => new Promise((resolve) => execFile('lsof', ['-t', '--', file], { timeout: 5000 }, (e, out) => resolve(!(e && e.code === 1 && !String(out || '').trim()))))
export async function clearStaleLocks(dir, branch = null) {
  const gitDir = (await G.git(dir, ['rev-parse', '--absolute-git-dir'], { check: false })).trim()
  if (!gitDir) return 0
  const common = path.resolve(dir, (await G.git(dir, ['rev-parse', '--git-common-dir'], { check: false })).trim() || gitDir)
  const files = [path.join(gitDir, 'index.lock'), path.join(gitDir, 'HEAD.lock'), ...(branch ? [path.join(common, 'refs', 'heads', `${branch}.lock`)] : [])]
  let n = 0
  for (const f of files) {
    const st = await fs.stat(f).catch(() => null)
    if (!st || Date.now() - st.mtimeMs < STALE_LOCK_MS || await openBy(f)) continue
    await fs.rm(f, { force: true })
    console.warn(`[folders] removed a stale git lock (${path.basename(f)}, ${Math.round((Date.now() - st.mtimeMs) / 60000)} min old)`)
    n++
  }
  return n
}
// What git does not carry in a checkout, as [{path, kind}] — kind: ignored (.gitignore), untracked or changed (git could not take it),
// repo (a repository inside it: git keeps only a link to that); null when it cannot tell (git failed). A directory git does not carry at
// all is one entry (node_modules, a cache, a new folder — moved as one); the walk for repositories inside goes through what git carries
// only. gitDir: the checkout's own git folder in its repository (retire found it there — not from the checkout's `.git` file)
export async function leftIn(dir, { gitDir = null } = {}) {
  let out
  const where = gitDir ? ['--git-dir', gitDir, '--work-tree', dir] : []
  try { out = await G.git(dir, [...where, 'status', '--porcelain', '--ignored', '--untracked-files=normal', '-z']) } catch { return null }
  const left = []
  const parts = out.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const x = parts[i]
    if (!/^.. /.test(x)) continue
    const code = x.slice(0, 2)
    left.push({ path: x.slice(3).replace(/\/$/, ''), kind: code === '!!' ? 'ignored' : code === '??' ? 'untracked' : 'changed' })
    if (/^R|^C/.test(code)) i++ // (a rename names its source next)
  }
  const listed = new Set(left.map((l) => path.join(dir, l.path)))
  const walk = async (d, depth) => {
    for (const e of await fs.readdir(d, { withFileTypes: true }).catch(() => [])) {
      if (e.name === '.git') { if (d !== dir) left.push({ path: path.relative(dir, d), kind: 'repo' }); continue }
      const full = path.join(d, e.name)
      if (e.isDirectory() && depth < 16 && !listed.has(full)) await walk(full, depth + 1)
    }
  }
  await walk(dir, 0)
  return left
}
// Where a checkout goes while it leaves the disk: beside the folders or the agents' workspace it belongs to (same filesystem: a rename),
// never inside a room's tree
function stagingFor(dir) {
  const base = [foldersRoot(), workspaceDir()].map((b) => path.resolve(b)).find((b) => path.resolve(dir).startsWith(b + path.sep))
  const name = `${path.basename(dir)}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`
  return base ? path.join(base, '.retiring', name) : `${dir}.retiring-${crypto.randomBytes(3).toString('hex')}`
}
export const keptRootOf = () => path.join(foldersRoot(), '.kept')
// one path moved into the kept folder: a rename (same filesystem), else — another filesystem (the agents' workspace mounted apart from the
// folders) — a copy: what the path holds is noted first (each file's size and times), copied (plain files and folders only — a link, a
// FIFO, a socket or a device is not copied: listed as skipped), and the original removed only when it is still exactly what was noted
// (nothing written, added or gone meanwhile — a sandbox may still write through the move) and the copy holds every noted file at its
// size. Otherwise the copy is removed again and the original stays (false). → false | {skipped: [paths not copied]}
async function keepPath(from, to) {
  await fs.mkdir(path.dirname(to), { recursive: true })
  try { await fs.rename(from, to); return { skipped: [] } } catch (e) { if (e.code !== 'EXDEV') return false }
  if (await fs.lstat(to).catch(() => null)) return false
  let before
  try { before = await snapshot(from) } catch { return false }
  try {
    await fs.cp(from, to, { recursive: true, dereference: false, verbatimSymlinks: true, errorOnExist: true, force: false,
      filter: async (src) => { const st = await fs.lstat(src); return st.isDirectory() || st.isFile() } })
    // (the copy checked first, the original last: the gap between that last look and its removal is as short as it can be)
    if (!(await holdsSnapshot(to, before)) || !sameSnapshot(before, await snapshot(from))) throw new Error('the original changed while it was copied, or the copy is not whole')
  } catch {
    await fs.rm(to, { recursive: true, force: true }).catch(() => {})
    return false
  }
  await fs.rm(from, { recursive: true, force: true }).catch(() => {})
  return { skipped: before.skipped }
}
// what a path holds now: files rel → {size, mtimeMs, ctimeMs}, folders rel → 'dir'; links aside, other kinds (FIFO, socket, device) listed
async function snapshot(root) {
  const files = new Map(), skipped = []
  const walk = async (abs, rel) => {
    const st = await fs.lstat(abs)
    if (st.isDirectory()) {
      files.set(rel, 'dir')
      for (const e of (await fs.readdir(abs)).sort()) await walk(path.join(abs, e), rel ? `${rel}/${e}` : e)
    } else if (st.isFile()) files.set(rel, { size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs })
    else if (!st.isSymbolicLink()) skipped.push(rel || path.basename(abs))
  }
  await walk(root, '')
  return { files, skipped }
}
const sameSnapshot = (a, b) => a.files.size === b.files.size && a.skipped.join('\0') === b.skipped.join('\0')
  && [...a.files].every(([k, x]) => { const y = b.files.get(k); return x === 'dir' ? y === 'dir' : !!y && y !== 'dir' && y.size === x.size && y.mtimeMs === x.mtimeMs && y.ctimeMs === x.ctimeMs })
async function holdsSnapshot(to, snap) {
  for (const [rel, x] of snap.files) {
    const st = await fs.lstat(rel ? path.join(to, rel) : to).catch(() => null)
    if (!st || (x === 'dir' ? !st.isDirectory() : !st.isFile() || st.size !== x.size)) return false
  }
  return true
}
const sizeOf = async (p) => { const st = await fs.lstat(p).catch(() => null); if (!st) return 0; if (!st.isDirectory()) return st.size; let n = 0; for (const e of await fs.readdir(p)) n += await sizeOf(path.join(p, e)); return n }
// While a checkout is moved out of the way it stays locked in its repository (its worktree entry's `locked` file — what `git worktree lock`
// writes — with RETIRE_MARK, this server and the time in it): a `git worktree prune` that another variation's move runs meanwhile would
// otherwise forget it once its folder is gone from where it was — git could no longer tell what it carries, and the whole folder would be
// kept. The entry is found from the repository: the one under <common>/worktrees whose gitdir names this folder (the checkout's own `.git`
// file is only a hint — its shell may have rewritten it). A lock with the mark is a retire's of this server (left by one that stopped
// mid-way): taken over. Any other lock is someone else's: left as it is. → the entry, to unlock afterwards; null when there is none
const RETIRE_MARK = 'pgl-retire'
const RETIRE_MARK_V1 = 'leaving the disk (Process GPT Lite)' // (what the first version wrote)
export const STALE_RETIRE_MS = 10 * 60_000
// past this a retire counts as stopped whatever its pid says (a pid is reused)
export const RETIRE_CEILING_MS = 3 * STALE_RETIRE_MS
// Who this process is, as a retire's mark and note say it: the host name and pid, the pid namespace (Linux: /proc/self/ns/pid — two
// servers with one host name may each be pid 1 in their own; elsewhere the machine has one) and a token made at start (no other process
// has it)
const BOOT = crypto.randomBytes(6).toString('hex')
const PID_NS = process.platform === 'linux' ? (() => { try { return readlinkSync('/proc/self/ns/pid').replace(/\D/g, '') || null } catch { return null } })() : process.platform
export const retireNs = () => PID_NS
const real = (p) => fs.realpath(p).catch(() => null)
// a path as one spelling (its folder's real path — a root reached through a link, /var and /private/var, is the same place)
const keyOf = async (p) => path.join((await real(path.dirname(p))) || path.dirname(p), path.basename(p))
const retiring = new Set() // entries this process is retiring now (keyOf)
async function commonOf(repo) {
  if ((await fs.lstat(path.join(repo, '.git')).catch(() => null))?.isDirectory()) return path.join(repo, '.git')
  const c = (await G.git(repo, ['rev-parse', '--git-common-dir'], { check: false })).trim()
  return c ? path.resolve(repo, c) : null
}
// is `admin` the worktree entry of `dir` in this repository: right under <common>/worktrees, and its gitdir names `dir`
async function entryOf(common, admin, dir) {
  if (!admin || (await real(path.dirname(admin))) !== (await real(path.join(common, 'worktrees')))) return false
  const gd = (await fs.readFile(path.join(admin, 'gitdir'), 'utf8').catch(() => '')).trim()
  return !!gd && path.basename(gd) === '.git' && (await real(path.dirname(gd))) === (await real(dir))
}
async function adminOf(repo, dir) {
  const common = await commonOf(repo)
  if (!common) return null
  const hint = (await fs.readFile(path.join(dir, '.git'), 'utf8').catch(() => '')).match(/^gitdir:\s*(.+)$/m)?.[1]?.trim()
  if (hint && await entryOf(common, path.resolve(dir, hint), dir)) return path.resolve(dir, hint)
  for (const name of await fs.readdir(path.join(common, 'worktrees')).catch(() => [])) {
    if (await entryOf(common, path.join(common, 'worktrees', name), dir)) return path.join(common, 'worktrees', name)
  }
  return null
}
const lockOf = (admin) => fs.readFile(path.join(admin, 'locked'), 'utf8').catch(() => null) // null: not locked
const retireLock = (reason) => reason != null && (reason.startsWith(RETIRE_MARK) || reason.trim() === RETIRE_MARK_V1)
async function holdWorktree(repo, dir) {
  if (!(await fs.lstat(path.join(dir, '.git')).catch(() => null))?.isFile()) return null
  const admin = await adminOf(repo, dir)
  if (!admin) return null
  const reason = await lockOf(admin)
  if (reason != null && !retireLock(reason)) return null
  await fs.writeFile(path.join(admin, 'locked'), `${RETIRE_MARK} ${os.hostname()}:${process.pid} ${new Date().toISOString()} boot=${BOOT}${PID_NS ? ` ns=${PID_NS}` : ''}`)
  retiring.add(await keyOf(admin))
  return admin
}
async function letGo(admin) {
  retiring.delete(await keyOf(admin))
  await fs.rm(path.join(admin, 'locked'), { force: true }).catch(() => {})
}
const markOf = (reason) => {
  const m = /^pgl-retire (\S+):(\d+) (\S+)(.*)$/s.exec(reason || '')
  if (!m) return null
  const kv = Object.fromEntries([...m[4].matchAll(/(\w+)=(\S+)/g)].map((x) => [x[1], x[2]]))
  return { host: m[1], pid: Number(m[2]), boot: kv.boot || null, ns: kv.ns || null }
}
// did the retire that wrote this lock stop (ranStopped — its age is the lock file's own time, not the clock of the server that wrote it) ·
// of the first version (no server in it — no such server runs any more): at once for the caller that holds that variation's lease (mine)
async function retireStopped(admin, reason, olderThan, mine = false) {
  if (mine && reason.trim() === RETIRE_MARK_V1) return true
  const st = await fs.stat(path.join(admin, 'locked')).catch(() => null)
  return ranStopped(markOf(reason), st ? Date.now() - st.mtimeMs : NaN, olderThan, retiring.has(await keyOf(admin)))
}
// did the retire `who` ran ({host, pid, boot, ns} — from its mark or note; null: it did not say) stop, `age` ms after its mark was
// written: this process's (its token) unless it is `going` on now · any other once older than RETIRE_CEILING_MS · one of this host and
// this pid namespace when its pid is gone · any other (another server, another namespace, an older version's) once older than `olderThan`
function ranStopped(who, age, olderThan, going) {
  if (who?.boot && who.boot === BOOT) return !going
  if (Number.isFinite(age) && age > RETIRE_CEILING_MS) return true
  if (who && who.host === os.hostname() && who.pid && who.ns && who.ns === PID_NS) {
    // (this process's pid with another token: an earlier run of this server that got the same pid — stopped)
    if (who.pid === process.pid) return true
    try { process.kill(who.pid, 0); return false } catch (e) { return e.code === 'ESRCH' }
  }
  return Number.isFinite(age) && age > olderThan
}
// The staging copies of retires that stopped mid-way (a pod killed after the move, before what git does not carry was kept): kept whole in
// <folders>/.kept/<variation>/<time> and recorded on the variation like any kept folder (「따로 남긴 파일」, removed after the usual days).
// Which retire and for which variation is in its note beside it (<staging>.json — retire writes it before the move and touches it while it
// runs: the note's time says the retire still goes on). A copy with no note (an older version's) goes by when it was moved there (its
// ctime — a rename sets it). The copy is claimed first, at once for everyone: <staging>.claim made only if it is not there (open 'wx') —
// its server, touched while the copy moves; a claim whose server stopped is taken over (the same rule). A copy gone meanwhile was kept by
// someone else: nothing failed. One that cannot be kept (a file that cannot be read, an original that changed while it was copied) is
// tried again later and later (<staging>.fail — 1 min, doubling up to a day), and recorded on the variation once (action 'keep-failed').
// A note, failure mark or claim whose copy is gone is removed once it is old. → how many were kept
const staged = new Set() // staging copies this process's retires (or sweeps) are working on now (keyOf)
const claiming = new Set() // copies a sweep of this process is claiming or moving now (keyOf)
export async function claimCopy(staging) {
  const file = `${staging}.claim`
  const me = JSON.stringify({ host: os.hostname(), pid: process.pid, boot: BOOT, ns: PID_NS })
  for (let i = 0; i < 2; i++) {
    try {
      const h = await fs.open(file, 'wx')
      try { await h.writeFile(me) } finally { await h.close() }
      return file
    } catch (e) { if (e.code !== 'EEXIST') return null }
    let who = null, raw = null
    try { raw = await fs.readFile(file, 'utf8'); who = JSON.parse(raw) } catch { /* being written, or gone */ }
    const st = await fs.stat(file).catch(() => null)
    if (st && !ranStopped(who, Date.now() - st.mtimeMs, STALE_RETIRE_MS, false)) return null
    // a stopped claim is taken over by moving it aside under a name of its own: only one rename of it succeeds, so two sweeps that both
    // judged it stopped do not both go on (removing it and making a new one let the second remove the first one's fresh claim)
    const aside = `${file}.stale-${BOOT}-${crypto.randomBytes(3).toString('hex')}`
    try { await fs.rename(file, aside) } catch { return null }
    // (what was moved aside is the claim judged stopped — not one another sweep made in its place meanwhile: that one goes back, by a link
    // that fails if a claim is there again, and this sweep leaves the copy alone)
    const got = await fs.readFile(aside, 'utf8').catch(() => null)
    if (raw === null || got !== raw) {
      await fs.link(aside, file).catch(() => {})
      await fs.rm(aside, { force: true }).catch(() => {})
      return null
    }
    await fs.rm(aside, { force: true }).catch(() => {})
  }
  return null
}
export const RETIRE_TOUCH_MS = () => Math.max(10, Number(process.env.PRO_RETIRE_TOUCH_MS) || 60_000)
// while something works on a retire's copy, its lock and note say so (their time moves on)
function touching(...files) {
  const timer = setInterval(() => { const t = new Date(); for (const f of files) if (f) fs.utimes(f, t, t).catch(() => {}) }, RETIRE_TOUCH_MS())
  timer.unref?.()
  return () => clearInterval(timer)
}
export async function keepStoppedStagings() {
  let n = 0
  for (const base of new Set([foldersRoot(), workspaceDir()])) {
    const root = path.join(base, '.retiring')
    const names = await fs.readdir(root).catch(() => [])
    for (const name of names) {
      const staging = path.join(root, name)
      // (a note — or a failure mark — whose copy is gone, from a retire that stopped between writing it and the move: removed once old)
      if (/\.(json|fail|claim)$/.test(name)) {
        const copy = staging.replace(/\.(json|fail|claim)$/, '')
        const st = await fs.stat(staging).catch(() => null)
        if (st && !names.includes(path.basename(copy)) && !staged.has(await keyOf(copy)) && Date.now() - st.mtimeMs > STALE_RETIRE_MS) await fs.rm(staging, { force: true }).catch(() => {})
        continue
      }
      const here = await fs.lstat(staging).catch(() => null)
      if (!here?.isDirectory()) continue
      const key = await keyOf(staging)
      if (claiming.has(key)) continue
      let note = null
      try { note = JSON.parse(await fs.readFile(`${staging}.json`, 'utf8')) } catch { /* no note */ }
      const noteAt = note ? (await fs.stat(`${staging}.json`).catch(() => null))?.mtimeMs : null
      const at = noteAt ?? here.ctimeMs
      const who = note ? { host: note.host, pid: note.pid, boot: note.boot || null, ns: note.ns || null } : null
      if (!ranStopped(who, Date.now() - at, STALE_RETIRE_MS, staged.has(key))) continue
      let fail = null
      try { fail = JSON.parse(await fs.readFile(`${staging}.fail`, 'utf8')) } catch { /* not failed before */ }
      if (fail?.next && Date.parse(fail.next) > Date.now()) continue
      let [v] = note?.vid ? await q('select id, folder_id from pro_folder_variations where id=$1', [note.vid]).catch(() => []) : []
      if (!v && note?.repo && note?.branch) {
        [v] = await q('select v.id, v.folder_id from pro_folder_variations v join pro_folders f on f.id=v.folder_id where f.repo_path=$1 and v.branch=$2', [note.repo, note.branch]).catch(() => [])
      }
      if (claiming.has(key)) continue
      claiming.add(key)
      let ok = false, claim = null, stop = () => {}
      const keptDir = path.join(keptRootOf(), String(v?.id || 'none'), `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(2).toString('hex')}`)
      try {
        claim = await claimCopy(staging)
        if (!claim || !(await fs.lstat(staging).catch(() => null))) continue // (someone else has it, or kept it already)
        stop = touching(claim, `${staging}.json`)
        ok = await keepPath(staging, keptDir)
      } finally {
        stop()
        if (claim) await fs.rm(claim, { force: true }).catch(() => {})
        claiming.delete(key)
      }
      if (!ok && !(await fs.lstat(staging).catch(() => null))) continue // (kept by someone else meanwhile: nothing failed)
      if (!ok) {
        const tries = (Number(fail?.tries) || 0) + 1
        const next = new Date(Date.now() + Math.min(86400_000, 60_000 * 2 ** (tries - 1))).toISOString()
        await fs.writeFile(`${staging}.fail`, JSON.stringify({ tries, next })).catch(() => {})
        console.warn(`[folders] a stopped retire's copy could not be kept (try ${tries}, again after ${next}) — left at ${staging}`)
        if (v && tries === 1) {
          await q(`insert into pro_variation_seat_log (tenant_id, variation_id, folder_id, by_user, action, note) values ($1,$2,$3,null,'keep-failed',$4)`,
            [T(), v.id, v.folder_id, JSON.stringify({ copy: name, why: 'it could not be copied whole, or it changed while it was copied' })]).catch(() => {})
        }
        continue
      }
      const now = new Date()
      await fs.utimes(keptDir, now, now).catch(() => {})
      await fs.rm(`${staging}.json`, { force: true })
      await fs.rm(`${staging}.fail`, { force: true })
      if (v) {
        await q(`insert into pro_variation_seat_log (tenant_id, variation_id, folder_id, by_user, action, note) values ($1,$2,$3,null,'kept',$4)`,
          [T(), v.id, v.folder_id, JSON.stringify({ dir: path.relative(keptRootOf(), keptDir), count: -1, bytes: await sizeOf(keptDir).catch(() => 0), mode: note?.mode || 'person', why: null, ...(ok.skipped?.length ? { skipped: ok.skipped.slice(0, 50) } : {}) })])
          .catch((e) => { if (e.code !== '42P01') console.warn('[folders] kept record', e.message) })
      }
      n++
    }
  }
  return n
}
// Worktree entries a retire left locked when it stopped mid-way (a pod killed): their folder is gone and the lock carries RETIRE_MARK.
// Unlocked and pruned, so their branch can be checked out again. branch: the caller holds that variation's lease (checkout) — its entry is
// freed once the retire that locked it surely stopped or a minute passed; the others (and the sweep's) after STALE_RETIRE_MS. A lock of
// this process's retire going on now is never touched. → {freed, waiting: the branch's entry is still locked by a retire that may go on}
export async function freeStoppedRetires(repo, { branch = null } = {}) {
  const common = await commonOf(repo)
  if (!common) return { freed: 0, waiting: false }
  let freed = 0, waiting = false
  for (const name of await fs.readdir(path.join(common, 'worktrees')).catch(() => [])) {
    const admin = path.join(common, 'worktrees', name)
    if (retiring.has(await keyOf(admin))) continue
    const reason = await lockOf(admin)
    if (!retireLock(reason)) continue
    const gd = (await fs.readFile(path.join(admin, 'gitdir'), 'utf8').catch(() => '')).trim()
    if (!gd || await fs.stat(path.dirname(gd)).catch(() => null)) continue
    const mine = !!branch && (await fs.readFile(path.join(admin, 'HEAD'), 'utf8').catch(() => '')).trim() === `ref: refs/heads/${branch}`
    if (await retireStopped(admin, reason, mine ? 60_000 : STALE_RETIRE_MS, mine)) { await letGo(admin); freed++ } else if (mine) waiting = true
  }
  if (freed) await G.git(repo, ['worktree', 'prune'], { check: false })
  return { freed, waiting }
}
// A checkout (or a folder left where one goes) leaves the disk, nothing in it lost:
//   1. it is moved out of the way first (an atomic rename, locked in its repository meanwhile — holdWorktree) — nothing writes into it any
//      more and nothing new shows up where it was
//   2. what git does not carry is found (leftIn): mode 'person' (a person's workroom, or not known) keeps all of it; mode 'agent' (a server
//      agent run) drops what .gitignore names — caches, logs, node_modules it made — and keeps the rest; mode 'all' keeps everything git
//      lists as not saved (a run whose commit failed)
//   3. only those paths are moved to <folders>/.kept/<variation>/<time> (outside every room; removed keptDays after that time), the rest is
//      deleted. The kept folder's own time is now (a whole folder moved there keeps its old time otherwise)
// → {kept: how many paths were kept (-1: could not tell — the whole folder was kept), keptDir, bytes}
export async function retire(repo, dir, { mode = 'person', vid = null } = {}) {
  await stillHeld('retire')
  if (!dir || !(await fs.stat(dir).catch(() => null))) { await G.git(repo, ['worktree', 'prune'], { check: false }); return { kept: 0 } }
  const staging = stagingFor(dir)
  await fs.mkdir(path.dirname(staging), { recursive: true })
  const held = await holdWorktree(repo, dir)
  // (its note, beside the copy until it is gone: who moved it and for which variation — a pod killed meanwhile leaves the copy to the
  // sweep, keepStoppedStagings)
  const note = `${staging}.json`
  const branch = held ? (await fs.readFile(path.join(held, 'HEAD'), 'utf8').catch(() => '')).match(/^ref: refs\/heads\/(.+)$/m)?.[1] || null : null
  const key = await keyOf(staging)
  staged.add(key)
  const stop = touching(held && path.join(held, 'locked'), note)
  let keptDir = null, bytes = 0, stuck = false, whole = false, left = []
  const skipped = []
  try {
    await fs.writeFile(note, JSON.stringify({ vid, repo, branch, mode, host: os.hostname(), pid: process.pid, boot: BOOT, ns: PID_NS, at: new Date().toISOString() }))
    await fs.rename(dir, staging)
    const checkout = !!(await fs.stat(path.join(staging, '.git')).catch(() => null))
    left = checkout ? await leftIn(staging, { gitDir: held }) : (await fs.readdir(staging).catch(() => [])).map((n) => ({ path: n, kind: 'untracked' }))
    whole = left === null
    if (!whole) {
      // (a run's ignored paths go first — also those inside a new folder that is kept whole: `?? tools/` with `!! tools/node_modules/`)
      if (mode === 'agent') {
        for (const l of left) {
          const p = path.join(staging, l.path)
          if (l.kind === 'ignored' && p.startsWith(staging + path.sep)) await fs.rm(p, { recursive: true, force: true }).catch(() => {})
        }
      }
      const seen = new Set()
      left = left.filter((l) => !(mode === 'agent' && l.kind === 'ignored') && !seen.has(l.path) && seen.add(l.path))
    }
    if (whole || left.length) {
      keptDir = path.join(keptRootOf(), String(vid || 'none'), `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(2).toString('hex')}`)
      if (whole) {
        const r = await keepPath(staging, keptDir)
        if (!r) stuck = true
        else { bytes = await sizeOf(keptDir).catch(() => 0); skipped.push(...r.skipped) }
      } else {
        for (const l of left) {
          const from = path.join(staging, l.path)
          if (!(await fs.lstat(from).catch(() => null))) continue
          bytes += await sizeOf(from).catch(() => 0)
          const r = await keepPath(from, path.join(keptDir, l.path))
          if (!r) stuck = true
          else skipped.push(...r.skipped.map((x) => `${l.path}/${x}`))
        }
      }
      const now = new Date()
      await fs.utimes(keptDir, now, now).catch(() => {})
    }
    if (stuck) console.warn(`[folders] some of what git does not carry could not be moved to the kept folder — left at ${staging}`)
    else await fs.rm(staging, { recursive: true, force: true }).catch(() => {})
  } finally {
    stop()
    staged.delete(key)
    if (!(await fs.lstat(staging).catch(() => null))) await fs.rm(note, { force: true }).catch(() => {})
    if (held) await letGo(held)
  }
  await G.git(repo, ['worktree', 'prune'], { check: false })
  return { kept: whole ? -1 : left.length, keptDir, bytes, staging: stuck ? staging : null, skipped }
}

// commit what changed in the checkout; the variation becomes ready for review
// strict: a commit git refuses throws (a run's end — folders/seats.js finishRun — keeps everything then) instead of being logged
// (a stale git lock is looked for only when git refuses: cleared when it surely is one, then the commit is tried once more)
export async function commitVariation(folder, v, author, message, { strict = false } = {}) {
  if (!v.worktree_path) return null
  await stillHeld('commit')
  const commit = () => G.commitAll(v.worktree_path, message || `${v.title}`, author)
  const sha = await commit()
    .catch(async (e) => { if (await clearStaleLocks(v.worktree_path, v.branch).catch(() => 0)) return commit(); throw e })
    .catch((e) => { if (strict) throw e; console.warn('[folders] commit', e.message); return null })
  const head = await G.head(folder.repo_path, `refs/heads/${v.branch}`)
  await q(`update pro_folder_variations set head_commit=$2, status=case when status in ('open','conflicted') then 'ready' else status end, updated_at=now() where id=$1`, [v.id, head])
  await touch(folder)
  return sha
}

// take the checkout off disk (retire: what git does not carry is moved aside, never deleted); the branch (the variation's content) stays.
// Its seat is the seat module's to end (folders/seats.js endRun · closeServer) — a release never drops a seat. → {kept, aside}
// mode: whose place it was (retire) — 'person' unless the caller knows it was a server agent run; who: that place's person (the record)
export async function release(folder, v, { keep = false, mode = 'person', who = null, why = null } = {}) {
  const gone = v.worktree_path ? await retire(folder.repo_path, v.worktree_path, { mode, vid: v.id }) : { kept: 0 }
  if (!keep) await q('update pro_folder_variations set worktree_path=null, updated_at=now() where id=$1', [v.id])
  // what was kept is recorded on the variation (its screen lists it with a download until it is removed — folders/seats.js keptOf)
  if (gone.keptDir && v.id) {
    await q(`insert into pro_variation_seat_log (tenant_id, variation_id, folder_id, by_user, action, note) values ($1,$2,$3,$4,'kept',$5)`,
      [T(), v.id, folder.id, who ? String(who) : null, JSON.stringify({ dir: path.relative(keptRootOf(), gone.keptDir), count: gone.kept, bytes: gone.bytes || 0, mode, why, ...(gone.skipped?.length ? { skipped: gone.skipped.slice(0, 50) } : {}) })])
      .catch((e) => { if (e.code !== '42P01') console.warn('[folders] kept record', e.message) })
  }
  return gone
}

export async function variations(folder) {
  const rows = await q('select * from pro_folder_variations where folder_id=$1 order by updated_at desc', [folder.id])
  for (const v of rows) {
    if (['open', 'ready', 'conflicted'].includes(v.status)) Object.assign(v, await G.aheadBehind(folder.repo_path, folder.default_branch, v.branch))
  }
  return rows
}

// a merged variation is compared with where it started (main already contains it)
const baseOf = (folder, v) => (['merged', 'discarded'].includes(v.status) && v.base_commit ? v.base_commit : folder.default_branch)
export async function variationDetail(folder, v) {
  const changes = await G.changes(folder.repo_path, baseOf(folder, v), v.branch)
  const commits = await G.log(folder.repo_path, `${baseOf(folder, v)}..${v.branch}`, 30)
  return { ...v, ...(await G.aheadBehind(folder.repo_path, folder.default_branch, v.branch)), changes, commits }
}

// both sides of one file for the diff view: the version where the branch left main, and the branch's
export async function fileDiff(folder, v, rel) {
  const p = safeRel(rel)
  const base = await G.mergeBase(folder.repo_path, baseOf(folder, v), v.branch)
  const a = base ? await G.show(folder.repo_path, base, p).catch(() => null) : null
  const b = await G.show(folder.repo_path, v.branch, p).catch(() => null)
  const binary = (buf) => buf && buf.subarray(0, 8000).includes(0)
  if (binary(a) || binary(b) || /\.(docx|xlsx|pptx|hwpx?|pdf|png|jpe?g|psd|mp4|wav|mp3|dxf|svg)$/i.test(p)) return { path: p, binary: true, base: base || null }
  return { path: p, binary: false, base: a ? a.toString('utf8') : '', head: b ? b.toString('utf8') : '' }
}

export async function setStatus(v, status) {
  await q('update pro_folder_variations set status=$2, updated_at=now() where id=$1', [v.id, status])
}

// (what its checkout still held is committed first: the branch keeps it for the retention time like the rest)
export async function discard(folder, v) {
  if (v.worktree_path) {
    await keepWhatIsThere(folder, v.worktree_path, v.branch)
    await release(folder, v)
  }
  await setStatus(v, 'discarded')
}

// a linked repository's agent branches and worktrees, shown — never changed — so the user can
// take the ones worth keeping in as variations
export async function linkedCandidates(folder) {
  const [list, wts, known] = await Promise.all([
    G.branches(folder.repo_path), G.worktrees(folder.repo_path),
    q('select branch from pro_folder_variations where folder_id=$1', [folder.id]),
  ])
  const have = new Set(known.map((r) => r.branch))
  const agent = list.filter((b) => /^pgpt-agent\//.test(b.name))
  let missing = 0
  for (const w of wts) if (w.path !== folder.repo_path && !(await fs.stat(w.path).catch(() => null))) missing++
  return {
    branches: agent.map((b) => ({ ...b, imported: have.has(b.name), worktree: wts.find((w) => w.branch === b.name)?.path || null })),
    worktrees: wts.filter((w) => path.resolve(w.path) !== path.resolve(folder.repo_path)).length,
    staleWorktrees: missing,
  }
}
export async function importBranches(folder, user, names) {
  const out = []
  for (const name of names || []) {
    if (!(await G.branchExists(folder.repo_path, name))) continue
    const [t] = await q(`select t.id, t.activity_name, t.proc_inst_id, i.proc_inst_name from todolist t left join bpm_proc_inst i on i.proc_inst_id=t.proc_inst_id
                         where t.output->'worktree'->>'branch'=$1 limit 1`, [name])
    const base = await G.mergeBase(folder.repo_path, folder.default_branch, name)
    const head = await G.head(folder.repo_path, `refs/heads/${name}`)
    const [v] = await q(`insert into pro_folder_variations (folder_id, branch, title, kind, status, base_commit, head_commit, holder_type, holder_id, holder_name, source, created_by)
                         values ($1,$2,$3,'imported','ready',$4,$5,'agent','cliagents','Claude Code',$6,$7)
                         on conflict (folder_id, branch) do nothing returning *`,
    [folder.id, name, t ? `${t.activity_name} ${L('(가져온 변형)', '(imported variation)')}` : `${name} ${L('(가져온 변형)', '(imported variation)')}`, base, head,
      { label: t ? `${t.proc_inst_name || t.proc_inst_id} · ${t.activity_name}` : L('이전 cli-agent 실행', 'Earlier cli-agent run'), todo_id: t?.id, proc_inst_id: t?.proc_inst_id, engine: 'cliagents' }, user.id])
    if (v) out.push(v)
  }
  return out
}

// where an agent run of a deepagents conversation (or instance) gets its checkout
export const runCheckoutDir = (room, folder) => path.join(workspaceDir(), '.bpmn', room.replace(/[^A-Za-z0-9._-]+/g, '_'), 'folders', folder.slug)
export const runCheckoutContainer = (room, folder) => `/workspace/.bpmn/${room.replace(/[^A-Za-z0-9._-]+/g, '_')}/folders/${folder.slug}`
export const personCheckoutDir = (user, v) => path.join(foldersRoot(), '.people', String(user.id).slice(0, 8), v.id)
