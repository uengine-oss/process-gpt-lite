// Agents working in shared folders.
// 1) Chat: "11월 세미나 폴더의 안내문 고쳐줘" — the request names a folder the user can use and asks
//    for a change: a new variation (one per run) is checked out inside the deepagents conversation's
//    run folder, the agent edits there, the server commits, and the chat gets a card that opens the
//    variation for review and merge.
// 2) Process steps: a step whose agent_config names a folder runs on a variation too —
//    cli-agent gets the folder repository as its project_repo (its own worktree flow, unchanged),
//    deepagents gets a checkout in the instance's run folder and its instruction is told where.
//    Steps of one instance chain on the instance line (inst/<id>), which `@previous` follows.
import crypto from 'node:crypto'
import { config } from '../../config.js'
import { q, eachTenant } from '../supa.js'
import { addMessage } from '../store.js'
import { emit } from '../bus.js'
import * as G from './git.js'
import * as S from './service.js'
import { changeCard, catalog } from './indexer.js'
import { RULES, rules } from './runner.js'
import * as SK from './skills.js'
import { L, asUser, withLang, langOf } from '../lang.js'

const T = () => config.tenantId
const EDIT = /고쳐|고치|수정|다듬|바꿔|바꾸|변경|추가|넣어|빼|삭제|작성|만들어|정리|업데이트|반영해|번역|채워|보완|손봐/
// the same request in English ("fix the notice in the November seminar folder")
const EDIT_EN = /\b(fix|edit|revise|update|change|add|insert|remove|delete|write|rewrite|correct|translate|fill( in)?|polish|improve|tidy|clean up|amend|draft)\b/i
const words = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').split(' ').filter((w) => w.length >= 2)

// the folder a chat request is about, if it asks for a change in one
export async function folderFor(user, text) {
  if (!EDIT.test(text) && !EDIT_EN.test(text)) return null
  // "○○ 스킬 이렇게 고쳐줘": the skill's folder (made from its files the first time)
  if (/스킬|skill/i.test(text)) {
    const norm = (x) => String(x).toLowerCase().replace(/[-_\s]+/g, '')
    const said = norm(text)
    const hit = (await SK.listSkills(user)).filter((k) => said.includes(norm(k.name))).sort((a, b) => b.name.length - a.name.length)[0]
    if (hit) {
      const f = await SK.ensureSkillFolder(hit.name)
      const role = await S.roleOf(f, user)
      if (role && S.RANK[role] >= S.RANK.runner) return f
    }
  }
  const rows = await q(`select f.* from pro_folders f join pro_folder_members m on m.folder_id=f.id and m.principal_type='user' and m.principal_id=$2
                        where f.tenant_id=$1 and f.kind='managed' and m.role in ('owner','editor','runner')`, [T(), String(user.id)])
  return folderMatch(text, rows)
}

// The folder (of `folders`) a change request names. It has to point at the folder: its whole name,
// or the word 폴더/folder with most of the name. Part of the name alone is not enough — a folder named
// after a customer ("Moonlight Coffee Store 2") shares words with every request about that customer
// ("…drafts for Moonlight Coffee. Please write a draft reply mail."), and those are not folder edits.
export function folderMatch(text, folders) {
  const said = words(text)
  const saysFolder = /폴더|\bfolders?\b/i.test(text)
  const low = String(text).toLowerCase()
  let best = null
  for (const f of folders || []) {
    const name = words(f.name)
    const hit = name.filter((w) => said.some((s) => s === w || (w.length >= 3 && s.startsWith(w)) || (s.length >= 3 && w.startsWith(s)))).length
    const full = low.includes(String(f.name).toLowerCase()) || (!!f.slug && text.includes(f.slug))
    const score = full ? 99 : hit / Math.max(1, name.length)
    if ((full || (saysFolder && ((hit >= 2 && score >= 0.5) || (name.length === 1 && hit === 1)))) && (!best || score > best.score)) best = { f, score }
  }
  return best?.f || null
}

// a shared folder's run room (startChatWork): one variation's work, never the main chat's conversation
export async function isFolderRoom(conversationId) {
  if (!conversationId) return false
  const [r] = await q(`select 1 from pro_folder_variations where source->>'room_id' = $1 limit 1`, [String(conversationId)])
  return !!r
}

// prepare the variation and the instruction; `finish` commits after the agent's turn
export async function startChatWork({ user, folder, text, threadId }) {
  const room = crypto.randomUUID()
  const v = await S.createVariation(folder, {
    title: text.replace(/\s+/g, ' ').slice(0, 40), kind: 'chat', holder: { type: 'user', id: user.id, name: user.name },
    source: { label: L(`${user.name} 님의 채팅 요청`, `Chat request from ${user.name}`), room_id: room, thread_id: threadId, engine: 'deepagents', request: text.slice(0, 500) }, createdBy: user.id,
  })
  await S.checkout(folder, v, S.runCheckoutDir(room, folder))
  const [cat] = await catalog(user.id).then((c) => c.filter((x) => x.slug === folder.slug))
  const listing = (cat?.files || []).map((f) => `- ${f.path}${f.summary ? ` — ${f.summary}` : ''}`).join('\n')
  const message = L(`${text}

(공유 폴더 '${folder.name}' 의 새 변형 '${v.branch}' 에서 작업합니다. 작업 폴더: ${S.runCheckoutContainer(room, folder)}
이 폴더의 파일:
${listing || '(아직 파일 없음)'}
${RULES} 고친 뒤 무엇을 바꿨는지 해요체로 짧게 알려 주세요. 기준본(main)에는 사람이 검토하고 반영합니다.)`, `${text}

(You are working on a new variation '${v.branch}' of the shared folder '${folder.name}'. Working folder: ${S.runCheckoutContainer(room, folder)}
Files in this folder:
${listing || '(no files yet)'}
${rules()} When you are done, say briefly in English what you changed. A person reviews it and merges it into main.)`)
  return { room, v, message }
}

export async function finishChatWork({ user, folder, v, threadId }) {
  const cur = await S.variationById(v.id)
  await S.commitVariation(folder, cur, { name: user.name, email: user.email }, L(`채팅 요청: ${cur.title}`, `Chat request: ${cur.title}`))
  await S.release(folder, cur)
  const after = await S.variationById(v.id)
  const changed = await G.changes(folder.repo_path, folder.default_branch, after.branch)
  if (!changed.length) {
    await S.discard(folder, after)
    return addMessage(user.id, threadId, 'agent', 'chip', { icon: 'check', text: L(`'${folder.name}' 폴더에서 바뀐 파일이 없어 변형을 남기지 않았어요`, `No files changed in the '${folder.name}' folder, so no variation was kept`) })
  }
  const card = await changeCard(folder, after).catch(() => null)
  // the change itself names the variation better than the request did
  const named = card?.title || card?.summary?.replace(/[.。]\s*$/, '').slice(0, 40)
  if (named) { await q('update pro_folder_variations set title=$2 where id=$1', [after.id, named]); after.title = named }
  // a change to someone else's skill goes to its author (and the bosses of agents using it) as a 반영 요청
  let requested = null
  if (folder.kind === 'skill' && !(await SK.canMerge(folder, user))) {
    const pr = await SK.requestMerge(folder, await S.variationById(after.id), user).catch((e) => { console.warn('[skills] request', e.message); return null })
    const vis = await SK.visibility(folder.settings.skill_name)
    const [a] = vis?.author_id ? await q('select username from users where id=$1 and tenant_id=$2', [vis.author_id, T()]) : []
    if (pr) requested = { pr: pr.id, to: a?.username || L('작성자', 'author') }
  }
  const msg = await addMessage(user.id, threadId, 'agent', 'folder_variation', {
    skill: folder.kind === 'skill' ? folder.settings.skill_name : undefined, requested,
    folder: folder.slug, folderName: folder.name, variation: after.id, title: after.title, branch: after.branch,
    summary: card?.summary || '', files: changed.map((c) => ({ path: c.path, change: c.change })), url: `/folders/${folder.slug}/v/${after.id}`,
  })
  emit(user.id, 'folders', { slug: folder.slug, variation: after.id })
  return msg
}

// ---------- process steps ----------
const handled = new Map() // todo id → stage
const baseOf = async (folder, row) => {
  const want = String(row.agent_config?.base_ref || 'main')
  if (want.startsWith('var:')) return want.slice(4)
  if (want === '@previous') {
    const inst = row.root_proc_inst_id || row.proc_inst_id
    const line = inst ? `inst/${inst.replace(/[^A-Za-z0-9]/g, '').slice(-12)}` : null
    if (line && await G.branchExists(folder.repo_path, line)) return line
  }
  return folder.default_branch
}
async function instanceLine(folder, row, head) {
  const inst = row.root_proc_inst_id || row.proc_inst_id
  if (!inst || !head) return
  const line = `inst/${inst.replace(/[^A-Za-z0-9]/g, '').slice(-12)}`
  await G.git(folder.repo_path, ['branch', '-f', line, head])
  const [i] = await q('select proc_inst_name from bpm_proc_inst where proc_inst_id=$1', [inst])
  await q(`insert into pro_folder_variations (folder_id, branch, title, kind, status, base_commit, head_commit, holder_type, holder_id, holder_name, source)
           values ($1,$2,$3,'instance','ready',$4,$5,'user',null,$7,$6)
           on conflict (folder_id, branch) do update set head_commit=$5, status='ready', updated_at=now()`,
  [folder.id, line, L(`${i?.proc_inst_name || inst} — 인스턴스 라인`, `${i?.proc_inst_name || inst} — instance line`), await G.mergeBase(folder.repo_path, folder.default_branch, head), head, { label: i?.proc_inst_name || inst, proc_inst_id: inst }, L('프로세스', 'Process')])
}

async function stepTick() {
  const rows = await q(`select id, status::text as status, agent_orch, agent_config, output, proc_inst_id, root_proc_inst_id, activity_name, query, user_id
                        from todolist where tenant_id=$1 and agent_config ? 'folder' and not (agent_config ? 'variation')
                        and agent_orch is not null and agent_orch <> 'pgpt-pro-folders'
                        and updated_at > now() - interval '2 days'`, [T()])
  for (const row of rows) {
    // a step runs in the saved language of the person it is for (its assignee)
    await withLang(await stepLang(row), () => stepOne(row))
  }
}
// todolist.user_id: a user id, or e-mail(s) — the first one names the person
async function stepLang(row) {
  const who = String(row.user_id || '').split(',')[0].trim()
  if (!who) return 'ko'
  if (/^[0-9a-f-]{36}$/.test(who)) return langOf(who)
  const [p] = await q('select user_id from pro_profile where email=$1', [who]).catch(() => [])
  return p ? langOf(p.user_id) : 'ko'
}
async function stepOne(row) {
  {
    try {
      const key = String(row.agent_config.folder)
      const folder = /^[0-9a-f-]{36}$/.test(key) ? await S.folderById(key) : await S.folderBySlug(key)
      if (!folder) return
      const [v] = await q(`select * from pro_folder_variations where folder_id=$1 and source->>'todo_id'=$2`, [folder.id, row.id])
      const done = ['DONE', 'SUBMITTED', 'COMPLETED'].includes(row.status)
      if (row.agent_orch === 'cliagents') {
        // cli-agent keeps its own worktree flow: give it the folder repository as its project
        if (!row.agent_config.project_repo && !done) {
          const base = await baseOf(folder, row)
          await q(`update todolist set agent_config = agent_config || $2 where id=$1`, [row.id, { project_repo: folder.repo_path, base_ref: base }])
        }
        const wt = row.output?.worktree
        if (done && wt?.branch && !v) {
          const [nv] = await q(`insert into pro_folder_variations (folder_id, branch, title, kind, status, base_commit, head_commit, holder_type, holder_id, holder_name, source)
                                values ($1,$2,$3,'run','ready',$4,$5,'agent','cliagents','Claude Code',$6) on conflict (folder_id, branch) do update set head_commit=$5 returning *`,
          [folder.id, wt.branch, row.activity_name || L('프로세스 단계', 'Process step'), await G.mergeBase(folder.repo_path, folder.default_branch, wt.branch), await G.head(folder.repo_path, `refs/heads/${wt.branch}`),
            { label: row.activity_name, todo_id: row.id, proc_inst_id: row.proc_inst_id, engine: 'cliagents' }])
          await instanceLine(folder, row, nv.head_commit)
          changeCard(folder, nv).catch(() => {})
        }
        return
      }
      // deepagents (and other in-process engines): a checkout in the instance's run folder
      const room = row.root_proc_inst_id || row.proc_inst_id || row.id
      if (!v && !done) {
        const nv = await S.createVariation(folder, { title: row.activity_name || L('프로세스 단계', 'Process step'), kind: 'run', base: await baseOf(folder, row),
          holder: { type: 'agent', id: row.agent_orch || 'deepagents', name: row.activity_name || L('에이전트', 'Agent') },
          source: { label: row.activity_name, todo_id: row.id, proc_inst_id: row.proc_inst_id, room_id: room, engine: row.agent_orch || 'deepagents' } })
        await S.checkout(folder, nv, S.runCheckoutDir(room, folder))
        const note = L(`\n\n[Folder] 공유 폴더 '${folder.name}' 의 변형 ${nv.branch} 에서 작업하세요. 작업 폴더: ${S.runCheckoutContainer(room, folder)}\n${RULES}`,
          `\n\n[Folder] Work on variation ${nv.branch} of the shared folder '${folder.name}'. Working folder: ${S.runCheckoutContainer(room, folder)}\n${rules()}\n[Instruction] Write your answer, and the text of any file you create or change, in English.`)
        if (!String(row.query || '').includes('[Folder]')) await q('update todolist set query = coalesce(query,\'\') || $2 where id=$1', [row.id, note])
        handled.set(row.id, 'prepared')
      } else if (v && done && v.status === 'open') {
        await S.commitVariation(folder, v, { name: v.holder_name || 'agent', email: 'agent@pgpt-pro.local' }, L(`${row.activity_name || '단계'} 결과`, `${row.activity_name || 'Step'} result`))
        const cur = await S.variationById(v.id)
        await S.release(folder, cur)
        await instanceLine(folder, row, (await S.variationById(v.id)).head_commit)
        changeCard(folder, await S.variationById(v.id)).catch(() => {})
        await q(`update todolist set output = coalesce(output,'{}'::jsonb) || $2 where id=$1`, [row.id, { folder_variation: { folder: folder.slug, variation: v.id, branch: v.branch, url: `/folders/${folder.slug}/v/${v.id}` } }])
      }
    } catch (e) { console.warn('[folders] step', row.id, e.message) }
  }
}

// A server restart ends the chat turns that were running (their stream was this process). The
// agent may still be writing for a moment, so after a grace period whatever the checkout holds is
// committed and the variation is handed to the person as usual.
const STARTED = new Date()
async function recoverChatRuns() {
  const rows = await q(`select v.*, f.slug from pro_folder_variations v join pro_folders f on f.id=v.folder_id
                        where f.tenant_id=$1 and v.kind='chat' and v.status='open' and v.worktree_path is not null and v.created_at < $2`, [T(), STARTED])
  for (const v of rows) {
    try {
      const folder = await S.folderById(v.folder_id)
      const user = { id: v.holder_id, name: v.holder_name, email: null }
      // the chat's person gets the card in their saved language
      await asUser(v.holder_id, async () => {
        if (!v.source?.thread_id) { await S.commitVariation(folder, v, user, L(`채팅 요청(중단 후 저장): ${v.title}`, `Chat request (saved after a stop): ${v.title}`)); await S.release(folder, await S.variationById(v.id)); return }
        await finishChatWork({ user, folder, v, threadId: v.source.thread_id })
      })
      console.log('[folders] recovered chat run', v.id)
    } catch (e) { console.warn('[folders] recover', v.id, e.message) }
  }
}

let timer
export function startFolderSteps() {
  if (timer) return
  setTimeout(() => recoverChatRuns().catch((e) => console.warn('[folders] recover', e.message)), 90000)
  const tick = () => eachTenant(stepTick).catch((e) => console.warn('[folders] steps', e.message)).finally(() => { timer = setTimeout(tick, 4000) })
  timer = setTimeout(tick, 5000)
}
