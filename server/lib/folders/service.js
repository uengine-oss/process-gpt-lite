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
import { q } from '../supa.js'
import * as G from './git.js'
import { PGPT_ROOT } from '../paths.js'
import { L } from '../lang.js'

const T = () => config.tenantId
const PGPT = PGPT_ROOT
// folder repositories live outside the deepagents workspace (and outside any other repository), so
// the sandbox never sees a folder's history or other variations — only the checkout a run is given
// inside its own run folder
export const FOLDERS_ROOT = path.join(config.foldersRoot || path.join(os.homedir(), 'pgpt-folders'), config.tenantId)
export const WORKSPACE = path.join(PGPT, 'services/deepagents/workspace', config.tenantId)

export const RANK = { viewer: 1, runner: 2, editor: 3, owner: 4 }
const err = (status, message) => Object.assign(new Error(message), { status })

// ---------- folders & permissions ----------
export async function folderBySlug(slug) {
  const [f] = await q('select * from pro_folders where tenant_id=$1 and slug=$2', [T(), slug])
  return f || null
}
export async function folderById(id) {
  const [f] = await q('select * from pro_folders where id=$1', [id])
  return f || null
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
                   where f.tenant_id=$1`, [T(), String(userId)])).map((r) => r.id)
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

export async function createFolder(user, { name, description = '', slug }) {
  name = String(name || '').trim()
  if (!name) throw err(400, L('폴더 이름을 적어 주세요.', 'Please enter a folder name.'))
  if ((await q('select 1 from pro_folders where tenant_id=$1 and name=$2', [T(), name])).length) throw err(409, L('같은 이름의 폴더가 이미 있어요.', 'A folder with that name already exists.'))
  slug = await freeSlug(slugify(slug) || slugify(name))
  const dir = path.join(FOLDERS_ROOT, slug)
  await fs.mkdir(dir, { recursive: true })
  await G.git(dir, ['init', '-q', '-b', 'main'])
  await fs.writeFile(path.join(dir, '.gitattributes'), GITATTRIBUTES)
  await G.commitAll(dir, L('폴더 만들기', 'Create folder'), { name: user.name, email: user.email })
  const [f] = await q(`insert into pro_folders (tenant_id, slug, name, description, kind, repo_path, created_by)
                       values ($1,$2,$3,$4,'managed',$5,$6) returning *`, [T(), slug, name, description, dir, user.id])
  await q(`insert into pro_folder_members (folder_id, principal_type, principal_id, role, added_by) values ($1,'user',$2,'owner',$3)`, [f.id, String(user.id), user.id])
  return f
}

// An existing repository registered as it is: nothing in it is changed (its branches and
// worktrees are only listed), its current branch stands for main.
export async function linkRepo(user, { repoPath, name, description = '' }) {
  const dir = path.resolve(String(repoPath || ''))
  if (!(await G.isRepo(dir))) throw err(400, L('git 저장소가 아니에요.', "That isn't a git repository."))
  const existing = (await q('select * from pro_folders where tenant_id=$1 and repo_path=$2', [T(), dir]))[0]
  if (existing) return existing
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
    where f.tenant_id=$1 and f.kind <> 'skill' order by f.updated_at desc`, [T(), String(user.id)])
  for (const f of rows) {
    f.members = await members(f.id)
    f.activity = await lastActivity(f)
  }
  return rows.map(publicFolder)
}
export function publicFolder(f) {
  const { repo_path, ...rest } = f
  return { ...rest, repo: f.kind === 'linked' ? repo_path : undefined }
}
export async function members(folderId) {
  return q(`select m.principal_type as type, m.principal_id as id, m.role,
              coalesce(p.name, u.username, m.principal_id) as name, u.email, coalesce(u.is_agent, m.principal_type='agent') as is_agent, u.agent_type
            from pro_folder_members m
            left join users u on u.id::text = m.principal_id and u.tenant_id=$2
            left join pro_profile p on p.user_id::text = m.principal_id
            where m.folder_id=$1 order by array_position(array['owner','editor','runner','viewer'], m.role), m.created_at`, [folderId, T()])
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
// a person's edit in main (upload, workroom, terminal) becomes a commit with its author
export async function commitMain(folder, author, message) {
  if (folder.kind === 'linked') return null
  const sha = await G.commitAll(folder.repo_path, message || L('파일 고침', 'Edit files'), author)
  if (sha) await touch(folder)
  return sha
}
export const touch = (folder) => q('update pro_folders set updated_at=now() where id=$1', [folder.id])

export function safeRel(rel) {
  const p = path.posix.normalize(String(rel || '').replace(/\\/g, '/').replace(/^\/+/, ''))
  if (!p || p === '.' || p.startsWith('..') || p.split('/').some((s) => s === '.git' || s === '..')) throw err(400, L('올바르지 않은 경로예요.', 'That path is not valid.'))
  return p
}

export async function upload(folder, user, rel, buf) {
  if (folder.kind === 'linked') throw err(400, L('연결형 폴더에는 아직 올릴 수 없어요.', "You can't upload to a linked folder yet."))
  const p = safeRel(rel)
  const host = path.join(folder.repo_path, p)
  await fs.mkdir(path.dirname(host), { recursive: true })
  await fs.writeFile(host, buf)
  return commitMain(folder, { name: user.name, email: user.email }, L(`올리기: ${p}`, `Upload: ${p}`))
}
export async function removeFile(folder, user, rel) {
  if (folder.kind === 'linked') throw err(400, L('연결형 폴더의 파일은 지울 수 없어요.', "Files of a linked folder can't be deleted."))
  const p = safeRel(rel)
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
  return files.filter((f) => f.path !== '.gitattributes').map((f) => ({ ...f, author: touched.get(f.path)?.name, mtime: touched.get(f.path)?.at }))
}
export async function readBlob(folder, ref, rel) {
  const p = safeRel(rel)
  const v = ref && ref !== 'main' ? await variation(folder, ref) : null
  return G.show(folder.repo_path, v ? v.branch : folder.default_branch, p).catch(() => { throw err(404, L('파일이 없어요.', "That file isn't there.")) })
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
  const sha = await G.commitAll(v.worktree_path, message || `${v.title}`, author).catch((e) => { console.warn('[folders] commit', e.message); return null })
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
export const runCheckoutDir = (room, folder) => path.join(WORKSPACE, '.bpmn', room.replace(/[^A-Za-z0-9._-]+/g, '_'), 'folders', folder.slug)
export const runCheckoutContainer = (room, folder) => `/workspace/.bpmn/${room.replace(/[^A-Za-z0-9._-]+/g, '_')}/folders/${folder.slug}`
export const personCheckoutDir = (user, v) => path.join(FOLDERS_ROOT, '.people', String(user.id).slice(0, 8), v.id)
