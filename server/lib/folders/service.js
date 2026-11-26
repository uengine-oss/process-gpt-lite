// Shared folders (공유 폴더) — design 안 2: each folder is a git repository whose working tree is
// `main` (people upload and edit it like a drive; every change is committed with its author).
// A variation is a branch; it is checked out only while someone works on it — an agent run gets it
// inside its own run folder (deepagents: /workspace/.bpmn/<room>/folders/<slug>, cli-agent: its
// worktree), a person gets it under <root>/.people. Only this server runs git.
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import os from 'node:os'
import { config } from '../../config.js'
import { q, admin } from '../supa.js'
import * as G from './git.js'
import { PGPT_ROOT } from '../paths.js'
import { L } from '../lang.js'
// a reference slot is read only in the folder that holds it (folders/refs.js)
import * as REFS from './refs.js'
import * as PS from '../privateStore.js'
import { people } from '../people.js'
import { isAdmin } from '../team.js'
import { assertNoLink } from '../noLinks.js'
import { kitCounts } from './kit.js'

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
      (select count(*) from pro_folder_variations v where v.folder_id=f.id and v.status in ('open','ready','conflicted') and ${UNLISTED})::int as live,
      (select count(*) from pro_folder_variations v where v.folder_id=f.id and v.status='open' and ${UNLISTED})::int as open,
      (select count(*) from pro_folder_variations v where v.folder_id=f.id and v.status='ready' and ${UNLISTED})::int as ready
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
  const [v] = await q(`select title, holder_name, status, updated_at from pro_folder_variations v where folder_id=$1 and ${UNLISTED} order by updated_at desc limit 1`, [f.id])
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
  await REFS.assertWritable(folder, p)
  await assertNoLink(folder.repo_path, p)
  const host = path.join(folder.repo_path, p)
  await fs.mkdir(path.dirname(host), { recursive: true })
  await fs.writeFile(host, buf)
  return commitMain(folder, { name: user.name, email: user.email }, L(`올리기: ${p}`, `Upload: ${p}`))
}
export async function removeFile(folder, user, rel) {
  if (folder.kind === 'linked') throw err(400, L('연결형 폴더의 파일은 지울 수 없어요.', "Files of a linked folder can't be deleted."))
  const p = safeRel(rel)
  await REFS.assertWritable(folder, p)
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
  return publishBlob(folder, p, sha, { private: await privateRef(folder, ref) })
}
// a version only some may read (a project's workspace, or a commit no shared branch holds): its copy is never at the shared public address
export async function privateRef(folder, ref) {
  if (!ref || ref === 'main') return false
  if (COMMIT.test(String(ref))) return !(await sharedCommit(folder, String(ref)))
  const v = /^[0-9a-f-]{36}$/.test(String(ref)) ? await variationById(ref) : null
  return !!v?.source?.template || isWorkspaceBranch(v?.branch)
}
// one version of a file by its blob id (a file mention opens the version it named, lib/fileRefs.js). private: in the private bucket,
// handed out by a signed address for an hour (PS.folderKey — never the content-addressed public copy everyone can guess)
export async function publishBlob(folder, rel, sha, { private: priv = false } = {}) {
  const p = safeRel(rel)
  if (!/^[0-9a-f]{40}$/.test(String(sha || '')) || (await G.git(folder.repo_path, ['cat-file', '-t', sha], { check: false })).trim() !== 'blob') throw err(404, L('파일이 없어요.', "That file isn't there."))
  if (priv) {
    const key = PS.folderKey({ tenant: T(), folderId: folder.id, sha }, p)
    if (!(await PS.exists(key))) await PS.put(key, await G.git(folder.repo_path, ['cat-file', 'blob', sha], { buffer: true }), MIME[path.extname(p).slice(1).toLowerCase()] || 'application/octet-stream')
    return { url: await PS.signedUrl(key, 3600), name: path.basename(p), sha, private: true }
  }
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
  await REFS.assertWritable(folder, p)
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
// …for this person: a project's workspace made from a template (source.template — folders/templates.js) exists only for the project's
// person; anyone else is told it is not there
export const UNLISTED = `not (coalesce(v.source, '{}'::jsonb) ? 'template')`
export const visibleTo = (v, user) => !v?.source?.template || (v.holder_type === 'user' && !!user?.id && String(v.holder_id) === String(user.id))
export async function variationFor(folder, id, user) {
  const v = await variation(folder, id)
  if (!visibleTo(v, user)) throw err(404, L('변형을 찾지 못했어요.', "I couldn't find that variation."))
  return v
}
// a workspace's branch (folders/templates.js) — the prefix nothing else in a folder uses; git tokens never advertise it (gitHttp.js)
export const WORKSPACE_PREFIX = 'var/t/'
// (a ref name in any spelling git reads as a branch — refs/heads/x, heads/x, x)
export const isWorkspaceBranch = (b) => String(b || '').replace(/^(refs\/)?heads\//, '').startsWith(WORKSPACE_PREFIX)
// the folder's branches that hold this commit: full ref names (for-each-ref %(refname) — never the short form, which may read heads/…)
async function branchesHolding(folder, sha) {
  return (await G.git(folder.repo_path, ['for-each-ref', '--format=%(refname)', '--contains', String(sha), 'refs/heads/'], { check: false }))
    .split('\n').map((x) => x.trim()).filter((x) => x.startsWith('refs/heads/')).map((x) => x.slice('refs/heads/'.length))
}
// A commit this person may read — an ALLOWLIST: it is on main, or on the branch of a variation row of this folder they may see. A branch
// with no row (a desktop's run branch, one left behind) gives nothing, nor does a commit no branch holds. workspaces: false — not even
// their own workspace counts (a new variation may not start inside one: its outputs would be in a variation everyone sees).
export async function commitVisible(folder, sha, user, { workspaces = true } = {}) {
  if (!COMMIT.test(String(sha || ''))) return false
  if ((await G.git(folder.repo_path, ['cat-file', '-t', String(sha)], { check: false })).trim() !== 'commit') return false
  const heads = await branchesHolding(folder, sha)
  if (!heads.length) return false
  if (heads.includes(folder.default_branch)) return true
  const rows = await q(`select branch, holder_type, holder_id, source from pro_folder_variations where folder_id=$1 and branch = any($2::text[])`, [folder.id, heads])
  return rows.some((v) => visibleTo(v, user) && (workspaces || !v.source?.template) && !(!v.source?.template && isWorkspaceBranch(v.branch)))
}
// A commit anyone of the folder may read (main, or a variation row that is no one's workspace): what is published to the shared public
// address; anything else is published privately (publishBlob { private })
export async function sharedCommit(folder, sha) {
  if (!COMMIT.test(String(sha || ''))) return false
  const heads = await branchesHolding(folder, sha)
  if (heads.includes(folder.default_branch)) return true
  if (!heads.length) return false
  const rows = await q(`select branch, source from pro_folder_variations where folder_id=$1 and branch = any($2::text[])`, [folder.id, heads])
  return rows.some((v) => !v.source?.template && !isWorkspaceBranch(v.branch))
}
// a ref a route was given (main, a commit, a variation id): refused when it names a workspace — or a commit only a workspace holds — this
// person may not see
export async function assertRefVisible(folder, ref, user) {
  if (!ref || ref === 'main') return null
  if (COMMIT.test(String(ref))) {
    if (!(await commitVisible(folder, String(ref), user))) throw err(404, L('그 판을 찾지 못했어요.', "I couldn't find that version."))
    return null
  }
  return variationFor(folder, ref, user)
}
// What a person may start a new variation from (POST …/variations {base}): main, a variation they may see — not a workspace (its
// outputs would leave it: 「원본에 반영 요청」 sends what may) — or a commit they may read. Nothing else (no branch name, no git revision).
export async function baseFor(folder, base, user) {
  const b = String(base ?? '').trim()
  if (!b || b === 'main') return 'main'
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(b)) {
    const v = await variationFor(folder, b, user)
    if (v.source?.template) throw err(409, L('프로젝트의 작업 공간에서는 새 변형을 만들지 않아요. 템플릿 파일의 고침은 「원본에 반영 요청」으로 보내 주세요.', "No new variation is made from a project's workspace. Send the template files you fixed with “Request a merge into the original”."))
    return v.id
  }
  if (COMMIT.test(b)) {
    if (!(await commitVisible(folder, b, user, { workspaces: false }))) throw err(404, L('그 판을 찾지 못했어요.', "I couldn't find that version."))
    return b
  }
  throw err(400, L('기준은 main, 변형, 또는 판(커밋)이어야 해요.', 'The base must be main, a variation or a version (commit).'))
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
    // the base is a variation id, a commit, or the exact name of a branch there (never a revision expression — git.js branchExists)
    const bv = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(String(base)) ? await variation(folder, base).catch(() => null) : null
    if (bv) baseRef = bv.branch
    else if (COMMIT.test(String(base))) baseRef = String(base)
    else if (await G.branchExists(folder.repo_path, String(base))) baseRef = String(base)
    else throw err(400, L(`기준을 찾지 못했어요: ${String(base).slice(0, 80)}`, `I couldn't find the base: ${String(base).slice(0, 80)}`))
    // (nothing grows from a project's workspace but its own work: its files would be in a variation everyone sees — templates.js)
    if (bv?.source?.template || isWorkspaceBranch(baseRef)) throw err(409, L('프로젝트의 작업 공간에서는 새 변형을 만들지 않아요.', "No new variation is made from a project's workspace."))
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

// put a variation's branch on disk at `dir` (reused when it is already there)
export async function checkout(folder, v, dir) {
  const list = await G.worktrees(folder.repo_path)
  const here = list.find((w) => path.resolve(w.path) === path.resolve(dir))
  if (here && here.branch === v.branch) { await setWorktree(v, dir); return dir }
  // the branch may be out at another place (an earlier run that was not released): free it
  const other = list.find((w) => w.branch === v.branch)
  if (other) await release(folder, { ...v, worktree_path: other.path }, { keep: true })
  await fs.mkdir(path.dirname(dir), { recursive: true })
  if (here) await G.git(folder.repo_path, ['worktree', 'remove', '--force', dir], { check: false })
  await fs.rm(dir, { recursive: true, force: true })
  await G.git(folder.repo_path, ['worktree', 'prune'])
  await G.git(folder.repo_path, ['worktree', 'add', '-q', dir, v.branch])
  await setWorktree(v, dir)
  return dir
}
const setWorktree = (v, dir) => q('update pro_folder_variations set worktree_path=$2, locked=false, updated_at=now() where id=$1', [v.id, dir])

// commit what changed in the checkout; the variation becomes ready for review
export async function commitVariation(folder, v, author, message) {
  if (!v.worktree_path) return null
  const sha = await G.commitAll(v.worktree_path, message || `${v.title}`, author).catch((e) => { if (e.code === 'ref_unchecked') throw e; console.warn('[folders] commit', e.message); return null })
  const head = await G.head(folder.repo_path, `refs/heads/${v.branch}`)
  await q(`update pro_folder_variations set head_commit=$2, status=case when status in ('open','conflicted') then 'ready' else status end, updated_at=now() where id=$1`, [v.id, head])
  await touch(folder)
  return sha
}

// take the checkout off disk; the branch (the variation's content) stays
export async function release(folder, v, { keep = false } = {}) {
  if (v.worktree_path) {
    await G.git(folder.repo_path, ['worktree', 'remove', '--force', v.worktree_path], { check: false })
    await fs.rm(v.worktree_path, { recursive: true, force: true }).catch(() => {})
    await G.git(folder.repo_path, ['worktree', 'prune'], { check: false })
  }
  if (!keep) await q('update pro_folder_variations set worktree_path=null, updated_at=now() where id=$1', [v.id])
}

export async function variations(folder) {
  // (a project's workspace made from a template is the project's only — folders/templates.js: never in the folder's list)
  const rows = await q(`select * from pro_folder_variations v where folder_id=$1 and ${UNLISTED} order by updated_at desc`, [folder.id])
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

export async function discard(folder, v) {
  if (v.worktree_path) await release(folder, v)
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
// Only a linked repository's agent branches (pgpt-agent/…, the names linkedCandidates lists), each by its exact name: never a revision
// expression, never a workspace's branch, never a branch of a managed folder (its desktops' run branches, a branch left behind)
export async function importBranches(folder, user, names) {
  if (folder.kind !== 'linked') throw err(400, L('가져오기는 연결형 폴더의 에이전트 브랜치만 해요.', 'Only a linked folder\'s agent branches can be imported.'))
  const out = []
  for (const raw of Array.isArray(names) ? names.slice(0, 200) : []) {
    const name = String(raw || '')
    if (!/^pgpt-agent\//.test(name) || isWorkspaceBranch(name) || !(await G.branchExists(folder.repo_path, name))) continue
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
