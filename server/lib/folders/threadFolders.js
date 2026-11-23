// A thread's folder (pro_thread_folders, sql/025). Reading uses the folder's main; writing always goes
// through a variation; 반영 merges it back. A project and a chat differ only in how long the variation lives:
// - project (mode 'project'): one variation of the folder that lives as long as the project. Every agent
//   turn of the project gets it checked out in the project's conversation folder and the server commits
//   what the agent changed after the turn; the project header's 반영 is the merge point. Process
//   instances started in the project get the folder for their agent steps (projectStepFolders).
// - chat (mode 'ref'): the folder is attached for reference — the agent reads main. A change asked of it
//   runs on a short variation (work.js startChatWork), the folder need not be named in the text.
import crypto from 'node:crypto'
import { config } from '../../config.js'
import { q } from '../supa.js'
import { emit } from '../bus.js'
import { addMessage } from '../store.js'
import * as G from './git.js'
import * as S from './service.js'
import { reindex, changeCard } from './indexer.js'
import { rules } from './runner.js'
import { pushRoomDir, pullRoomChanges } from '../roomStore.js'
import { L } from '../lang.js'

const T = () => config.tenantId
const err = (status, message) => Object.assign(new Error(message), { status })
const LIVE = ['open', 'ready', 'conflicted']

// ---------- decisions (pure) ----------
// A change asked of the files ("안내문 고쳐줘", "폴더에 회의록 만들어 줘") — not a question about them
// ("바뀐 게 뭐야?", "어디를 고쳐야 해?") and not a document the chat writes from them ("이 폴더 내용으로 보고서 작성해 줘").
const CHANGE = /(고쳐|수정해|수정\s*(좀|부탁)|다듬어|바꿔|변경해|추가해|넣어|빼\s*(줘|주세요)|삭제해|지워|업데이트해|채워|보완해|손봐|덮어써)(?!야)/
const MAKE_IN = /(폴더|파일)\s*(에|안에|속에)\s*[^.?!\n]{0,30}(만들어|작성해|저장해|써\s*(줘|주세요)|올려|넣어)|(만들어|작성해|저장해)[^.?!\n]{0,12}(폴더|파일)\s*(에|안에)/
const CHANGE_EN = /\b(fix|edit|revise|update|change|insert|remove|delete|rewrite|correct|amend|rename|append)\b|\badd\b[^.?!\n]{0,40}\b(to|in|into)\b/i
const MAKE_IN_EN = /\b(write|create|save|put|make|draft)\b[^.?!\n]{0,40}\b(in|into|to) (the|this|that) (folder|file)\b/i
const QUESTION_EN = /^\s*(what|which|where|why|how|should|do|does|did|is|are|can you tell)\b[^?]*\?\s*$/i
export function asksChange(text) {
  const t = String(text || '')
  if (CHANGE.test(t) || MAKE_IN.test(t)) return true
  return (CHANGE_EN.test(t) || MAKE_IN_EN.test(t)) && !QUESTION_EN.test(t)
}

// The folder a chat turn changes on a short variation (folderTurn), or null:
// - a folder the text names (work.js folderFor) — except the project's own folder: a project changes
//   that one on its own variation (prepareProjectWork), never on a short one
// - else the chat's attached folder when the text asks for a change and the person may propose one
export function folderTarget({ link, named, text, blocked = false, canChange = false }) {
  if (link?.mode === 'project' && named && named.id === link.folder_id) return null
  if (named) return named
  if (blocked || link?.mode !== 'ref' || !canChange || !asksChange(text)) return null
  return { id: link.folder_id, slug: link.slug, name: link.name, attached: true }
}

// folderTarget with the person's role in the attached folder (a viewer only reads it): a folder row or null
export async function chatFolderTarget({ user, link, named, text, blocked = false }) {
  let canChange = false
  if (link?.mode === 'ref' && !named && !blocked && asksChange(text)) {
    const role = await S.roleOf(await S.folderById(link.folder_id), user)
    canChange = !!role && S.RANK[role] >= S.RANK.runner
  }
  const t = folderTarget({ link, named, text, blocked, canChange })
  return t?.attached ? S.folderById(t.id) : t
}

// the label the composer chip shows: 참고, or 변형 작업 중 while a variation of it is open
export const chipState = (p) => (p?.mode === 'ref' && p.working ? 'working' : p?.mode === 'ref' ? 'ref' : p?.mode === 'project' ? 'project' : null)

// ---------- the link ----------
export async function linkOf(threadId) {
  if (!threadId) return null
  const [l] = await q(`select l.*, f.slug, f.name, f.kind as folder_kind, f.repo_path, f.default_branch
                       from pro_thread_folders l join pro_folders f on f.id=l.folder_id where l.thread_id=$1`, [threadId])
  return l || null
}

// what a thread payload carries: {id, slug, name, mode, variation, working}
export async function payloadOf(l) {
  if (!l) return null
  const v = l.variation_id ? await S.variationById(l.variation_id) : null
  const live = !!v && LIVE.includes(v.status)
  const ab = live ? await G.aheadBehind(l.repo_path, l.default_branch, v.branch).catch(() => ({ ahead: 0, behind: 0 })) : null
  return {
    id: l.folder_id, slug: l.slug, name: l.name, mode: l.mode,
    variation: v ? { id: v.id, branch: v.branch, title: v.title, status: v.status, ahead: ab?.ahead || 0, behind: ab?.behind || 0, url: `/folders/${l.slug}/v/${v.id}` } : null,
    working: live,
  }
}
export const folderPayload = async (threadId) => payloadOf(await linkOf(threadId))

// thread rows with their folder (GET /api/threads)
export async function withFolders(rows) {
  if (!rows?.length) return rows
  const links = await q(`select l.*, f.slug, f.name, f.kind as folder_kind, f.repo_path, f.default_branch
                         from pro_thread_folders l join pro_folders f on f.id=l.folder_id where l.thread_id = any($1)`, [rows.map((r) => r.id)])
  const by = new Map(links.map((l) => [String(l.thread_id), l]))
  return Promise.all(rows.map(async (r) => ({ ...r, folder: await payloadOf(by.get(String(r.id))).catch(() => null) })))
}

// the thread again, with its folder, for the page (its 'thread' event)
export async function announce(userId, threadId) {
  const [t] = await q('select * from pro_threads where id=$1', [threadId])
  if (t) emit(userId, 'thread', { ...t, folder: await folderPayload(threadId).catch(() => null) })
}

async function folderFrom(user, key, need) {
  const k = String(key || '').trim()
  if (!k) throw err(400, L('폴더를 골라 주세요.', 'Please choose a folder.'))
  const folder = /^[0-9a-f-]{36}$/.test(k) ? await S.folderById(k) : await S.folderBySlug(k)
  if (!folder || folder.tenant_id !== T()) throw err(404, L('폴더를 찾지 못했어요.', "I couldn't find that folder."))
  if (folder.kind === 'skill') throw err(400, L('스킬 폴더는 붙일 수 없어요.', "A skill's folder can't be attached."))
  const { role } = await S.access(folder.slug, user, need)
  return { folder, role }
}

// 새 프로젝트: the folder it works in — one the person may propose changes to (runner and up), or a new one
// they own. Checked before the project is made, so a refusal makes no project.
export async function projectFolder(user, { folder, newFolder } = {}) {
  if (newFolder && String(newFolder).trim()) {
    const f = await S.createFolder(user, { name: String(newFolder).trim().slice(0, 80) })
    reindex(f).catch((e) => console.warn('[folders] new project folder index', e.message))
    return f
  }
  if (!folder) return null
  return (await folderFrom(user, folder, 'runner')).folder
}

export async function linkProject(user, thread, folder) {
  if (!folder) return null
  await q(`insert into pro_thread_folders (thread_id, user_id, folder_id, mode) values ($1,$2,$3,'project')
           on conflict (thread_id) do update set folder_id=$3, mode='project', variation_id=null, updated_at=now()`, [thread.id, user.id, folder.id])
  return folderPayload(thread.id)
}

// 📎 폴더 붙이기 (a chat, or a project that has no folder of its own): for reference
export async function attach(user, thread, key) {
  const { folder } = await folderFrom(user, key, 'viewer')
  const cur = await linkOf(thread.id)
  if (cur?.mode === 'project') throw err(409, L('이 프로젝트는 이미 폴더에서 작업하고 있어요.', 'This project already works in a folder.'))
  await q(`insert into pro_thread_folders (thread_id, user_id, folder_id, mode) values ($1,$2,$3,'ref')
           on conflict (thread_id) do update set folder_id=$3, mode='ref', variation_id=null, updated_at=now()`, [thread.id, user.id, folder.id])
  await announce(user.id, thread.id)
  return folderPayload(thread.id)
}
// the chip's ×: the attachment goes, the folder and any variation made from the chat stay
export async function detach(user, thread) {
  const cur = await linkOf(thread.id)
  if (cur?.mode === 'project') throw err(409, L('프로젝트의 폴더는 뗄 수 없어요.', "A project's folder can't be detached."))
  await q(`delete from pro_thread_folders where thread_id=$1 and mode='ref'`, [thread.id])
  await announce(user.id, thread.id)
  return null
}

// a chat change on the attached folder (folderTurn): the chip shows 변형 작업 중 while that variation is open
export async function noteVariation(user, threadId, folder, v) {
  const [r] = await q(`update pro_thread_folders set variation_id=$3, updated_at=now() where thread_id=$1 and folder_id=$2 and mode='ref' returning thread_id`, [threadId, folder.id, v.id])
  if (r) await announce(user.id, threadId)
}

// ---------- chat: reading the attached folder ----------
const listing = (files, n = 40) => files.slice(0, n).map((f) => `- ${f.path}${f.summary ? ` — ${String(f.summary).slice(0, 120)}` : ''}`).join('\n') + (files.length > n ? `\n- … (+${files.length - n})` : '')
export async function refHint(link) {
  if (link?.mode !== 'ref') return ''
  const files = (await q(`select path, card->>'abstract' as summary from pro_folder_files where folder_id=$1 order by path limit 200`, [link.folder_id]).catch(() => []))
  return L(`\n\n(이 대화에는 공유 폴더 '${link.name}' 가 참고 자료로 붙어 있어요. 기준본(main)을 읽기만 해요: folder_files 도구(folder: '${link.slug}')로 파일 목록과 문서 요약을, folder_read 도구로 파일 내용을 볼 수 있어요. 사용자가 파일을 열어 달라고 하면 folder_open 도구로 화면에 열어 주세요.
이 폴더의 파일:
${listing(files) || '(아직 파일 없음)'}
이 폴더의 파일을 직접 고치거나 그 안에 저장하지 마세요. 바꿔야 하면 사용자가 바꿔 달라고 할 때 변형에서 바꾸고, 사람이 검토해 반영해요.)`,
  `\n\n(The shared folder '${link.name}' is attached to this chat for reference. Read its main version only: the folder_files tool (folder: '${link.slug}') lists its files with document summaries, and folder_read shows a file's content. When the user asks to open a file, open it on their screen with the folder_open tool.
Files in this folder:
${listing(files) || '(no files yet)'}
Do not change files in this folder or save into it. A change is made on a variation when the user asks for one, and a person reviews and merges it.)`)
}

// ---------- project: its own variation ----------
const branchOf = (thread, n) => `var/p/${String(thread.id).replace(/-/g, '').slice(0, 8)}${n > 1 ? `-${n}` : ''}`
export async function ensureProjectVariation(user, thread, link) {
  const folder = await S.folderById(link.folder_id)
  const cur = link.variation_id ? await S.variationById(link.variation_id) : null
  if (cur && LIVE.includes(cur.status)) return { folder, v: cur }
  // first turn, or the last one was merged (반영) or discarded: a new variation from main, named after the project
  const [{ n }] = await q(`select count(*)::int as n from pro_folder_variations where folder_id=$1 and source->>'thread_id'=$2`, [folder.id, String(thread.id)])
  const v = await S.createVariation(folder, {
    title: thread.title || L('프로젝트', 'Project'), kind: 'person', branch: branchOf(thread, n + 1),
    holder: { type: 'user', id: user.id, name: user.name }, createdBy: user.id,
    source: { label: L(`${user.name} 님의 프로젝트 「${thread.title || ''}」`, `${user.name}'s project "${thread.title || ''}"`), thread_id: String(thread.id), project: true, engine: 'deepagents' },
  })
  await q('update pro_thread_folders set variation_id=$2, updated_at=now() where thread_id=$1', [thread.id, v.id])
  return { folder, v }
}

// Before an agent turn of a project with a folder: the project's variation checked out in its conversation
// folder (a conversation id is given now when the project has none yet — the agent keeps one it is given),
// and what to tell the agent. `finishProjectWork` commits after the turn.
export async function prepareProjectWork({ user, thread }) {
  if (thread?.kind !== 'project') return null
  const link = await linkOf(thread.id)
  if (link?.mode !== 'project') return null
  let conv = thread.conversation_id
  if (!conv) {
    const fresh = crypto.randomUUID().replace(/-/g, '')
    const [r] = await q('update pro_threads set conversation_id=$2 where id=$1 and conversation_id is null returning conversation_id', [thread.id, fresh])
    conv = r?.conversation_id || (await q('select conversation_id from pro_threads where id=$1', [thread.id]))[0]?.conversation_id || fresh
  }
  const { folder, v } = await ensureProjectVariation(user, thread, link)
  await q(`update pro_folder_variations set status='open', updated_at=now() where id=$1 and status='ready'`, [v.id])
  const before = await G.head(folder.repo_path, `refs/heads/${v.branch}`)
  const dir = S.runCheckoutDir(conv, folder)
  await S.checkout(folder, v, dir)
  const container = S.runCheckoutContainer(conv, folder)
  // the agent may run on another pod, with no disk in common: it gets the files from storage
  const seeded = await pushRoomDir(dir, container)
  const files = (await G.lsTree(folder.repo_path, v.branch)).filter((f) => f.path !== '.gitattributes').map((f) => ({ path: f.path }))
  const note = L(`\n\n(이 프로젝트는 공유 폴더 '${folder.name}' 에서 작업해요. 이 프로젝트의 변형 '${v.branch}' 이 작업 폴더에 열려 있어요: ${container}
이 폴더의 파일:
${listing(files) || '(아직 파일 없음)'}
폴더의 파일은 이 작업 폴더에서 읽고 고치세요. ${rules()} 여기서 바꾼 것은 원본(main)이 아니라 이 프로젝트의 변형에 쌓이고, 사람이 프로젝트 위의 「반영」으로 원본에 넣어요. 그래서 '수정했어요'처럼 원본이 바뀐 것처럼 말하지 말고 '프로젝트 변형에 담았어요'처럼 말해 주세요.)`,
  `\n\n(This project works in the shared folder '${folder.name}'. The project's variation '${v.branch}' is open in the working folder: ${container}
Files in this folder:
${listing(files) || '(no files yet)'}
Read and change the folder's files in this working folder. ${rules()} What you change here goes into the project's variation, not the original (main); a person merges it with 「반영」 above the project. So do not say "I updated it" as if the original changed — say "I put it in the project's variation".)`)
  return { user, thread, conv, folder, v, dir, container, seeded, before, note }
}

// After the turn: the agent's changes committed to the project's variation (it stays — no card each
// turn), a chip when files changed, and the header refreshed
export async function finishProjectWork(work, { stopped = false } = {}) {
  const { user, thread, folder, v, container, seeded, before } = work
  const cur = await S.variationById(v.id)
  await pullRoomChanges(container, seeded, cur.worktree_path || work.dir, { wait: !stopped })
  await S.commitVariation(folder, cur, { name: user.name, email: user.email }, L(`프로젝트 「${thread.title || ''}」 작업`, `Project "${thread.title || ''}" work`))
  await S.release(folder, await S.variationById(v.id))
  const after = await S.variationById(v.id)
  const changed = before && after.head_commit && after.head_commit !== before ? await G.changes(folder.repo_path, before, after.branch).catch(() => []) : []
  if (changed.length) {
    changeCard(folder, after).catch(() => {})
    await addMessage(user.id, thread.id, 'agent', 'chip', { icon: 'check', folderVariation: after.id,
      text: L(`'${folder.name}' 폴더의 프로젝트 변형에 담았어요 · ${changed.map((c) => c.path.split('/').pop()).slice(0, 4).join(', ')} · 반영 전까지 원본은 그대로예요`,
        `Put in the project's variation of '${folder.name}' · ${changed.map((c) => c.path.split('/').pop()).slice(0, 4).join(', ')} · the original stays as it is until it is merged`) })
    emit(user.id, 'folders', { slug: folder.slug, variation: after.id })
  }
  await announce(user.id, thread.id)
  return { changed, variation: after }
}

// ---------- process instances started in a project ----------
// the instance a project's process card started (routes/process.js start)
export async function linkInstance(userId, messageId, instId) {
  if (!messageId || !instId) return
  await q(`update pro_thread_folders l set instances = array_append(l.instances, $3), updated_at=now()
           from pro_messages m join pro_threads t on t.id=m.thread_id
           where m.id=$1 and t.user_id=$2 and l.thread_id=t.id and l.mode='project' and not ($3 = any(l.instances))`, [messageId, userId, instId])
}

// Agent steps of those instances get the project's folder (work.js stepTick then runs them on a variation):
// the first one starts from the project's variation, later ones from the instance line (@previous).
// The step has to be seen before its agent picks it up — the same window the folder steps already have.
export async function projectStepFolders() {
  const rows = await q(`select t.id, t.proc_inst_id, t.root_proc_inst_id, l.folder_id, l.variation_id
                        from todolist t join pro_thread_folders l on l.mode='project' and coalesce(t.root_proc_inst_id, t.proc_inst_id) = any(l.instances)
                        join pro_folders f on f.id=l.folder_id and f.tenant_id=$1
                        where t.tenant_id=$1 and t.agent_orch is not null and t.agent_orch <> 'pgpt-pro-folders'
                        and not (coalesce(t.agent_config, '{}'::jsonb) ? 'folder') and t.status::text not in ('DONE','SUBMITTED','COMPLETED','CANCELLED')
                        and t.updated_at > now() - interval '2 days'`, [T()])
  for (const row of rows) {
    try {
      const folder = await S.folderById(row.folder_id)
      const v = row.variation_id ? await S.variationById(row.variation_id) : null
      const inst = row.root_proc_inst_id || row.proc_inst_id
      const line = `inst/${String(inst).replace(/[^A-Za-z0-9]/g, '').slice(-12)}`
      const base = await G.branchExists(folder.repo_path, line) ? '@previous' : v && LIVE.includes(v.status) ? `var:${v.branch}` : 'main'
      await q(`update todolist set agent_config = coalesce(agent_config, '{}'::jsonb) || $2 where id=$1 and not (coalesce(agent_config, '{}'::jsonb) ? 'folder')`, [row.id, { folder: folder.id, base_ref: base }])
    } catch (e) { console.warn('[folders] project step', row.id, e.message) }
  }
}
