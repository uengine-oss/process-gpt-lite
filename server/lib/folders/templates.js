// Template folders (템플릿 폴더 — spec openspec/specs/template-folders, 2026-11-27 사용자: 「템플릿 폴더는 어떤 프로젝트를 시작할때 참고하는 …
// 이 템플릿 폴더가 선택되어 시작되면 해당 프로젝트에 템플릿 폴더가 참조로 연결된 이 프로젝트 전용 폴더가 생기고 결과물은 전용 폴더내에만 남게
// 될 것임. 작업 도중 원본 폴더 자체에 뭔가의 개선이 필요한 내용은 PR 처럼 요청될 수 있겠지」 · 「프로젝트 폴더는 별도로 관리될 수 있도록 "폴더"
// 목록에 나와서는 안되고 해당 프로젝트에서만 보이게」).
//
// A managed folder its owner marks as a template (settings.template). Starting a project from it (「템플릿으로 시작」, or 새 프로젝트 with
// the template chosen) gives the project its own workspace: a variation of the template, made at once from the template's main at that
// moment (source.template: the template, the start commit, the outputs folder). That variation is the project's only — it is in no 변형
// list, no folder card's counts, no merge, and every read of it is refused to anyone but the project's person (its holder). The project's
// agent works in it (threadFolders.js prepareProjectWork) and reads the template's reference slots through the folder tools.
// The workspace is never merged into the template. 「원본에 반영 요청」 takes only files that came from the template (they were in it at the
// start commit, outside the outputs folder) into a new ordinary variation of the template, on its current main: the template's owner
// reviews and merges it like any other. Outputs never travel with it.
// An optional TEMPLATE.md at the template's root says what it is for (description) and where outputs go (outputs, 산출물/ by default) —
// its YAML front matter, read like a SKILL.md's.
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { config } from '../../config.js'
import { q } from '../supa.js'
import { emit } from '../bus.js'
import { L } from '../lang.js'
import * as G from './git.js'
import * as S from './service.js'

const T = () => config.tenantId
const err = (status, message, code) => Object.assign(new Error(message), { status, ...(code ? { code } : {}) })
export const TEMPLATE_FILE = 'TEMPLATE.md'
export const DEFAULT_OUTPUTS = '산출물'

// ---------- what a template is ----------
export const isTemplate = (folder) => !!folder?.settings?.template && folder.kind === 'managed'
// a project's workspace made from a template (its variation's source says which template and from which commit)
export const isWorkspace = (v) => !!v?.source?.template
// the one person who sees a workspace: the project's (the variation's holder)
export const mayView = (v, user) => !isWorkspace(v) || (v.holder_type === 'user' && !!user?.id && String(v.holder_id) === String(user.id))
// SQL: a variation row that is not a project's workspace (alias v.)
export const LISTED = `not (coalesce(v.source, '{}'::jsonb) ? 'template')`

// one line of a YAML front matter (key: value, a quoted value, or a folded > / | block of indented lines)
function frontValue(head, key) {
  const lines = head.split('\n')
  const i = lines.findIndex((l) => new RegExp(`^${key}\\s*:`).test(l))
  if (i < 0) return ''
  const v = lines[i].replace(new RegExp(`^${key}\\s*:\\s*`), '').trim()
  if (v && !/^[>|][-+]?$/.test(v)) return v.replace(/^["']|["']$/g, '')
  const out = []
  for (const l of lines.slice(i + 1)) { if (!/^\s+\S/.test(l)) break; out.push(l.trim()) }
  return out.join(' ')
}
// the outputs folder as written ('산출물/', './out', '') → a folder path ('산출물'), or the default
export function outputsOf(raw) {
  const p = String(raw || '').replace(/\\/g, '/').split('/').filter((x) => x && x !== '.').join('/')
  if (!p || p.split('/').some((x) => x === '..' || x === '.git')) return DEFAULT_OUTPUTS
  return p.slice(0, 120)
}
// TEMPLATE.md's front matter → {description, outputs}
export function parseTemplateFile(md = '') {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(String(md))
  const head = fm ? fm[1].replace(/\r/g, '') : ''
  const body = fm ? String(md).slice(fm[0].length) : String(md)
  const description = (frontValue(head, 'description') || body.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#')) || '').slice(0, 300)
  return { description, outputs: outputsOf(frontValue(head, 'outputs')) }
}
// what the folder screen and the project are told about a template: null for a folder that is not one
export async function infoOf(folder, rev = null) {
  if (!isTemplate(folder)) return null
  const at = rev || folder.default_branch
  const md = await G.git(folder.repo_path, ['show', `${at}:${TEMPLATE_FILE}`], { check: false })
  const parsed = md ? parseTemplateFile(md) : { description: '', outputs: DEFAULT_OUTPUTS }
  return { ...parsed, file: !!md, since: folder.settings.template.at || null }
}
// owner: mark or unmark (projects already started keep their workspace). templateSettings: the folder's settings with the mark as asked —
// refused for a folder that may not be a template (the PATCH route and setTemplate both go through it)
export function templateSettings(folder, user, on) {
  // (a work folder of an instance started from a mail — lib/mailWork.js — is that instance's, never a starting point)
  if (on && (folder.kind !== 'managed' || folder.settings?.work)) throw err(400, L('관리형 공유 폴더만 템플릿으로 쓸 수 있어요.', 'Only a managed shared folder can be a template.'))
  const settings = { ...(folder.settings || {}) }
  if (on) settings.template = folder.settings?.template || { by: String(user.id), at: new Date().toISOString() }
  else delete settings.template
  return settings
}
export async function setTemplate(folder, user, on) {
  const settings = templateSettings(folder, user, on)
  await q('update pro_folders set settings=$2, updated_at=now() where id=$1', [folder.id, settings])
  emit(user.id, 'folders', { slug: folder.slug })
  return { template: !!on }
}

// ---------- a project from a template ----------
// (the whole thread id: two projects never share a branch; -n for the next workspace of the same project)
const branchOf = (thread, n) => `${S.WORKSPACE_PREFIX}${String(thread.id).replace(/-/g, '')}${n > 1 ? `-${n}` : ''}`
// The project's workspace: a variation of the template from its main now, held by the project's person, ready (nothing changed yet).
export async function makeWorkspace(user, thread, folder) {
  if (!isTemplate(folder)) throw err(400, L('템플릿이 아닌 폴더예요.', "That folder isn't a template."))
  const info = await infoOf(folder)
  const commit = await G.head(folder.repo_path, folder.default_branch)
  const [{ n }] = await q(`select count(*)::int as n from pro_folder_variations where folder_id=$1 and source->>'thread_id'=$2`, [folder.id, String(thread.id)])
  // a branch that is there already (a row taken away, a branch left behind) is never taken over: the next free one
  let k = n + 1
  while (await G.branchExists(folder.repo_path, branchOf(thread, k)) || (await q('select 1 from pro_folder_variations where folder_id=$1 and branch=$2', [folder.id, branchOf(thread, k)])).length) {
    if (++k > n + 50) throw err(409, L('작업 공간을 만들 자리를 찾지 못했어요.', "Couldn't find a place for the workspace."))
  }
  const v = await S.createVariation(folder, {
    title: thread.title || L('프로젝트', 'Project'), kind: 'person', branch: branchOf(thread, k), base: commit,
    holder: { type: 'user', id: user.id, name: user.name }, createdBy: user.id,
    source: { label: L(`${user.name} 님의 프로젝트 「${thread.title || ''}」 · 템플릿 「${folder.name}」에서 시작`, `${user.name}'s project "${thread.title || ''}" · started from the template "${folder.name}"`),
      thread_id: String(thread.id), project: true, engine: 'deepagents',
      template: { folder_id: String(folder.id), slug: folder.slug, name: folder.name, commit, outputs: info.outputs, at: new Date().toISOString() } },
  })
  // (the row is this project's — not one that was there under the same branch)
  if (String(v.holder_id) !== String(user.id) || v.source?.thread_id !== String(thread.id) || !v.source?.template) throw err(409, L('작업 공간을 만들지 못했어요.', "Couldn't make the workspace."))
  await q(`update pro_folder_variations set status='ready', updated_at=now() where id=$1 and status='open'`, [v.id])
  await q('update pro_thread_folders set variation_id=$2, updated_at=now() where thread_id=$1', [thread.id, v.id])
  return S.variationById(v.id)
}
// 「템플릿으로 시작」 on the template's screen: the project (named as asked) with its folder link and its workspace
export async function startProject(user, folder, { title } = {}) {
  if (!isTemplate(folder)) throw err(400, L('템플릿으로 지정된 폴더에서만 시작할 수 있어요.', 'You can start a project only from a folder marked as a template.'))
  const name = String(title || '').replace(/[\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60)
  if (!name) throw err(400, L('프로젝트 이름을 적어 주세요.', 'Please enter a project name.'))
  const [thread] = await q(`insert into pro_threads(user_id,kind,title) values ($1,'project',$2) returning *`, [user.id, name])
  await q(`insert into pro_thread_folders (thread_id, user_id, folder_id, mode) values ($1,$2,$3,'project')
           on conflict (thread_id) do update set folder_id=$3, mode='project', variation_id=null, updated_at=now()`, [thread.id, user.id, folder.id])
  await makeWorkspace(user, thread, folder)
  return thread
}

// ---------- 원본에 반영 요청 ----------
const inside = (dir, p) => !!dir && (p === dir || p.startsWith(`${dir}/`))
// The files a workspace may send to its template: changed (or deleted) files that were in the template at the start commit, outside the
// outputs folder → {files: [{path, change, add?, del?, binary?}], outputs: [{path, change}], template, start}
export async function candidates(folder, v) {
  if (!isWorkspace(v)) throw err(400, L('템플릿에서 시작한 프로젝트의 작업 공간이 아니에요.', "This isn't a workspace of a project started from a template."))
  const start = v.source.template.commit || v.base_commit
  const outputs = outputsOf(v.source.template.outputs)
  const changes = await G.changes(folder.repo_path, start, v.branch)
  const had = new Set((await G.lsTree(folder.repo_path, start)).map((f) => f.path))
  const files = [], outs = []
  for (const c of changes) (had.has(c.path) && !inside(outputs, c.path) ? files : outs).push(c)
  const sent = (v.source.requests || []).slice(-10)
  return { files, outputs: outs, outputsDir: outputs, template: { slug: folder.slug, name: folder.name }, start, sent }
}

const blobOf = async (repo, rev, rel) => (await G.git(repo, ['rev-parse', '--verify', '-q', `${rev}:${rel}`], { check: false })).trim() || null
// the path's mode and object at a rev (ls-tree -z: a name with a line break stays one entry) → {mode, type} | null
async function entryOf(repo, rev, rel) {
  // (--literal-pathspecs: the name as it is — `:(…)` or `*` in it are not pathspec magic)
  const out = (await G.git(repo, ['--literal-pathspecs', 'ls-tree', '-z', rev, '--', rel], { check: false })).split('\0').find((e) => e && e.slice(e.indexOf('\t') + 1) === rel)
  if (!out) return null
  const [mode, type] = out.slice(0, out.indexOf('\t')).split(' ')
  return { mode, type }
}
// only plain files travel: no link (120000), no submodule (160000), no folder
const PLAIN = new Set(['100644', '100755'])
const isBinary = (buf) => !!buf && buf.subarray(0, 8000).includes(0)
// git merge-file: its exit status says it — 0 clean, 1..127 that many conflicts; anything else (a signal, git not found, an error status)
// is a failure, never read as a merge → {status: 'clean'|'conflict', out}
export function mergeFile(cwd, files) {
  return new Promise((resolve, reject) => {
    execFile('git', ['merge-file', '-p', '-L', 'main', '-L', 'start', '-L', 'project', ...files], { cwd, env: G.gitEnv(), encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 60000 }, (e, out, errOut) => {
      if (!e) return resolve({ status: 'clean', out })
      if (Number.isInteger(e.code) && e.code > 0 && e.code < 128 && !e.signal && !e.killed) return resolve({ status: 'conflict', out })
      reject(Object.assign(new Error(`git merge-file failed: ${String(errOut || e.message).slice(0, 200)}`), { status: 500 }))
    })
  })
}

// What one chosen file becomes on top of the template's main: the workspace's version when main still has the start's, a three-way merge
// of the line changes when main moved on meanwhile, or a conflict → {path, blob|null (deleted), mode} | {path, conflict: true}
async function resolveFile(repo, { start, main, head }, rel, tmp) {
  const [b, m, h] = await Promise.all([blobOf(repo, start, rel), blobOf(repo, main, rel), blobOf(repo, head, rel)])
  const [he, me, be] = await Promise.all([h ? entryOf(repo, head, rel) : null, m ? entryOf(repo, main, rel) : null, b ? entryOf(repo, start, rel) : null])
  // (a version there whose entry cannot be read as a plain file — a link, a sub-repository, a name git reads otherwise — is not sent)
  const plain = (e) => !!e && PLAIN.has(e.mode) && e.type === 'blob'
  if ((h && !plain(he)) || (m && !plain(me))) return { path: rel, odd: true }
  if (m === b) return { path: rel, blob: h, mode: he?.mode || null }
  if (m === h) return { path: rel, same: true }
  if (!b || !m || !h) return { path: rel, conflict: true }
  const read = async (sha) => G.git(repo, ['cat-file', 'blob', sha], { buffer: true })
  const [bb, mb, hb] = await Promise.all([read(b), read(m), read(h)])
  if (isBinary(bb) || isBinary(mb) || isBinary(hb)) return { path: rel, conflict: true }
  const id = crypto.randomBytes(4).toString('hex')
  const f = (x) => path.join(tmp, `${id}-${x}`)
  await Promise.all([fs.writeFile(f('main'), mb, { mode: 0o600 }), fs.writeFile(f('base'), bb, { mode: 0o600 }), fs.writeFile(f('head'), hb, { mode: 0o600 })])
  const merged = await mergeFile(tmp, [f('main'), f('base'), f('head')])
  if (merged.status !== 'clean') return { path: rel, conflict: true }
  const blob = (await G.git(repo, ['hash-object', '-w', '--stdin'], { input: merged.out })).trim()
  // (the workspace changed the file's mode too — executable or not: that goes with it; otherwise main's)
  return { path: rel, blob, mode: be && he.mode !== be.mode ? he.mode : me.mode }
}

// POST …/variations/:vid/propose {paths, title?, note?} — the project's person. → {variation, files}
export async function propose(folder, v, user, { paths, title, note } = {}) {
  if (!isWorkspace(v)) throw err(400, L('템플릿에서 시작한 프로젝트의 작업 공간에서만 보낼 수 있어요.', 'Only a workspace of a project started from a template can send this.'))
  if (!mayView(v, user)) throw err(404, L('변형을 찾지 못했어요.', "I couldn't find that variation."))
  const want = [...new Set((Array.isArray(paths) ? paths : []).map((p) => S.safeRel(p)))].slice(0, 200)
  if (!want.length) throw err(400, L('원본에 보낼 파일을 골라 주세요.', 'Please choose the files to send to the original.'))
  const c = await candidates(folder, v)
  const allowed = new Map(c.files.map((f) => [f.path, f]))
  const refused = want.filter((p) => !allowed.has(p))
  if (refused.length) throw err(400, L(`템플릿에서 온 파일만 보낼 수 있어요 — 결과물은 이 프로젝트에만 남아요: ${refused.slice(0, 3).join(', ')}`, `Only files that came from the template can be sent — the outputs stay in this project: ${refused.slice(0, 3).join(', ')}`), 'tpl_not_template_file')
  const repo = folder.repo_path
  const main = await G.head(repo, folder.default_branch)
  const head = await G.head(repo, `refs/heads/${v.branch}`)
  // (a folder only this server's user may read: the merge's three versions are written there)
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pgl-tpl-'))
  await fs.chmod(tmp, 0o700)
  try {
    const done = []
    for (const p of want) done.push(await resolveFile(repo, { start: c.start, main, head }, p, tmp))
    const odd = done.filter((x) => x.odd).map((x) => x.path)
    if (odd.length) throw err(400, L(`보통 파일만 보낼 수 있어요(링크 · 하위 저장소는 안 돼요): ${odd.slice(0, 3).join(', ')}`, `Only plain files can be sent (no link, no sub-repository): ${odd.slice(0, 3).join(', ')}`), 'tpl_not_plain')
    const clash = done.filter((x) => x.conflict).map((x) => x.path)
    if (clash.length) throw err(409, L(`템플릿에서도 그 사이 같은 곳이 바뀌었어요: ${clash.join(', ')} — 템플릿 주인과 먼저 맞춰 주세요.`, `The template changed the same place meanwhile: ${clash.join(', ')} — please settle it with the template's owner first.`), 'tpl_conflict')
    const changed = done.filter((x) => !x.same)
    if (!changed.length) throw err(409, L('템플릿에 이미 같은 내용이 있어요.', 'The template already has the same content.'), 'tpl_same')
    // the commit: main's tree with these files as decided — built in a temporary index (no work tree, nothing else of the workspace)
    const env = { GIT_INDEX_FILE: path.join(tmp, 'index') }
    await G.git(repo, ['read-tree', main], { env })
    // (-z: one NUL after each entry — a path may hold a line break)
    const add = changed.filter((x) => x.blob).map((x) => `${x.mode} ${x.blob}\t${x.path}\0`)
    if (add.length) await G.git(repo, ['update-index', '-z', '--index-info'], { env, input: add.join('') })
    const gone = changed.filter((x) => !x.blob).map((x) => x.path)
    if (gone.length) await G.git(repo, ['update-index', '--force-remove', '-z', '--stdin'], { env, input: `${gone.join('\0')}\0` })
    const tree = (await G.git(repo, ['write-tree'], { env })).trim()
    const name = String(title || '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || L(`${v.title}에서 온 개선`, `Improvement from ${v.title}`)
    const msg = `${name}\n\n${L(`프로젝트 「${v.title}」에서 보낸 반영 요청`, `Sent from the project "${v.title}"`)}${note ? `\n\n${String(note).slice(0, 1000)}` : ''}`
    const who = { GIT_AUTHOR_NAME: user.name || 'pgpt-pro', GIT_AUTHOR_EMAIL: user.email || 'folders@pgpt-pro.local', GIT_COMMITTER_NAME: user.name || 'pgpt-pro', GIT_COMMITTER_EMAIL: user.email || 'folders@pgpt-pro.local' }
    const commit = (await G.git(repo, ['commit-tree', tree, '-p', main, '-m', msg], { env: who })).trim()
    // an ordinary variation of the template (it shows in its 변형 list), from main, with that one commit
    // (a branch name never there before — never one to take over)
    let branch
    do branch = `var/u/${String(user.id).replace(/[^A-Za-z0-9]/g, '').slice(0, 8)}/req-${crypto.randomBytes(5).toString('hex')}`
    while (await G.branchExists(repo, branch))
    // (what the template's members see of it: the files and the note — not which workspace or project it came from, beyond the label)
    const fresh = await S.createVariation(folder, { title: name, kind: 'person', base: main, branch, holder: { type: 'user', id: user.id, name: user.name }, createdBy: user.id,
      source: { label: L(`${user.name} 님이 프로젝트 「${v.title}」에서 보낸 반영 요청`, `Merge request from ${user.name}'s project "${v.title}"`), request: { paths: changed.map((x) => x.path), note: note ? String(note).slice(0, 1000) : null } } })
    if (fresh.branch !== branch || fresh.head_commit !== main) throw err(409, L('반영 요청을 만들지 못했어요. 다시 보내 주세요.', "Couldn't make the request. Please send it again."))
    await G.git(repo, ['update-ref', `refs/heads/${branch}`, commit, main])
    await q(`update pro_folder_variations set head_commit=$2, status='ready', updated_at=now() where id=$1`, [fresh.id, commit])
    const sent = { variation_id: fresh.id, paths: changed.map((x) => x.path), at: new Date().toISOString() }
    await q(`update pro_folder_variations set source = jsonb_set(coalesce(source, '{}'::jsonb), '{requests}', coalesce(source->'requests', '[]'::jsonb) || $2::jsonb) where id=$1`, [v.id, JSON.stringify([sent])])
    await notifyOwners(folder, user, fresh, changed.map((x) => x.path), note)
    return { variation: await S.variationById(fresh.id), files: sent.paths }
  } finally { await fs.rm(tmp, { recursive: true, force: true }).catch(() => {}) }
}
async function notifyOwners(folder, user, v, paths, note) {
  const owners = (await q(`select principal_id as id from pro_folder_members where folder_id=$1 and principal_type='user' and role='owner'`, [folder.id])).map((x) => x.id)
  const shown = paths.slice(0, 3).join(', ') + (paths.length > 3 ? L(` 외 ${paths.length - 3}개`, ` and ${paths.length - 3} more`) : '')
  for (const id of owners.filter((x) => x && x !== String(user.id))) {
    const title = L(`${user.name}님이 템플릿 「${folder.name}」에 반영을 요청했어요`, `${user.name} asked to merge into the template "${folder.name}"`)
    const text = L(`${shown}${note ? ` — ${String(note).slice(0, 200)}` : ''} · 검토하고 「이 변형 반영」으로 넣을 수 있어요.`, `${shown}${note ? ` — ${String(note).slice(0, 200)}` : ''} · Review it and merge it with "Merge this variation".`)
    await q(`insert into notifications(id,user_id,title,type,description,url,from_user_id,tenant_id) values (gen_random_uuid(),$1,$2,'folder_request',$3,$4,$5,$6)`,
      [id, title.slice(0, 200), text, `/folders/${folder.slug}/v/${v.id}`, user.email || String(user.id), T()]).catch((e) => console.warn('[templates] notice', e.message))
    emit(id, 'notifications', {})
  }
}
