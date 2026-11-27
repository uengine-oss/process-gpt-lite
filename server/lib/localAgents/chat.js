// A chat message for its sender's own CLI agent (design docs/local-agents/design.md §12 — the user's request 2026-11-24: 「채팅 입력창
// 보낼때 기본, codex, claude code 등 cli 에이전트를 선택할 수 있는 옵션이 대화창에 있으면 좋겠음」). The composer's picker names who answers
// the message: 「기본」 (the server's business agent, lib/agent.js — as before) or 「Claude Code · 내 PC」 · 「Codex · 내 PC」 — the CLIs the
// person's own desktop app reports. A local one becomes a local job of kind 'chat' (pro_local_jobs, sql/055) that goes to the sender's
// own desktop only and runs there as their interactive CLI in a terminal (the generic session layer: runner.openSession kind 'chat',
// relay.js registerKind('chat')) — never on someone else's desktop, never on the server.
//   one session per chat and agent  — a chat is a thread, or one conversation of the main chat (key: thread[:conversation]). While its
//                                     run is on (running, or waiting after its turn — settle.js), the next message goes into the same CLI
//                                     as its owner's input (a steer); after it ended (the wait ran out, 「끝내기」), the next message starts
//                                     a run that resumes the same CLI session (--resume · codex resume) on the same folder — or, when
//                                     the desktop no longer has it, a new session that is given a short recap of the chat
//   the folder                      — a project thread with a folder of its own: that folder, on the project's variation (the place the
//                                     server agent's project turns commit — edit rights needed); any other chat (the main chat, its
//                                     conversations, a project without a folder of its own): the person's own folder 「내 PC 에이전트
//                                     작업 · <이름>」, made on first use, private to them, whose main takes each turn's files at once
//   each turn                       — the desktop commits and pushes what the turn changed (the run's branch, the device-scoped folder
//                                     token), then says 'reply': the branch goes onto the chat's line here, the CLI's last words become a
//                                     normal assistant message, and each file the turn made or changed a file card
//   the card                        — one local_run message per run in the chat (LocalRunCard 「대화 / 터미널」), kept current
//   failures                        — the desktop off (the run waits for it), the link lost, the CLI failed: the card says why and offers
//                                     「기본으로 다시 보내기」 (fallback): the run stops and the page sends the same words to the server agent
// Who: only the sender's own desktop runs it and only the sender puts words in (steer · finish · answer · fallback); a project folder's
// members may watch its runs (the same rule as a step: they see, they do not type). The server agent is not called for these messages.
import crypto from 'node:crypto'
import fs from 'node:fs'
import { config } from '../../config.js'
import { q } from '../supa.js'
import { emit } from '../bus.js'
import { addMessage, updateMessage } from '../store.js'
import { L, langOf, withLang, langInstruction } from '../lang.js'
import * as A from './agents.js'
import * as J from './jobs.js'
import * as H from './hub.js'
import * as D from './devices.js'
import * as R from './relay.js'
import * as ST from './steps.js'
import { josa, eulReul } from '../josa.js'
import { latestDesktop } from './desktopRelease.js'
import { pageRefs } from '../attachments.js'

const T = () => config.tenantId
export const KIND = 'chat'
// what the picker offers (OpenHands is found but not run yet — design §9)
export const AGENTS = ['claude-code', 'codex']
export const DOWNLOAD = 'https://www.uengine.org/contents/processgptlite.html#desktop'
const LIVE = ['queued', 'offered', 'running']
const RECAP_N = 10
const CARDS_MAX = 8
const err = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra })
const LABEL = (a) => L(A.LABEL, A.LABEL_EN)[a] || a
const HERE = () => L('내 PC', 'My PC')

// ---------- which chat ----------
// A chat: a thread, or one conversation of the main chat (the context router's — the page's filtered view /chat/c/:cid)
const CONV = /^[A-Za-z0-9_.:-]{1,80}$/
export const convOf = (c) => { const id = typeof c === 'object' && c ? c.id : c; return CONV.test(String(id || '')) ? String(id) : null }
export const keyOf = (threadId, conv = null) => (conv ? `${threadId}:${conv}` : String(threadId))
export const isAgent = (a) => AGENTS.includes(a)

// ---------- what the picker shows ----------
// The person's local agents now: the CLIs their desktops report — the ones that are on say it now; when none is on, what they said last
// (or both, when no desktop was ever linked), shown disabled with why. available: this message can go there now.
export async function availability(user) {
  const links = H.linksOf(T(), user.id)
  const devices = (await D.list(user).catch(() => [])).filter((d) => !d.revoked)
  const out = [{ id: 'default', label: L('기본', 'Default'), where: L('서버의 업무 에이전트', "the server's business agent"), available: true }]
  for (const id of AGENTS) {
    const label = LABEL(id)
    const has = links.filter((l) => l.caps?.clis?.[id]?.installed)
    const base = { id, label, where: HERE(), devices: has.map((l) => l.name) }
    if (links.length) {
      // a desktop is on: only the CLIs it reports
      if (!has.length) continue
      const ok = has.filter((l) => l.caps.clis[id].runnable !== false && l.prefs?.enabled !== false && l.caps.chat)
      const loggedOut = has.every((l) => l.caps.clis[id].loggedIn === false)
      if (ok.length) out.push({ ...base, available: true, ...(loggedOut ? { note: L(`${label} 에 로그인이 필요할 수 있어요 — 터미널에서 로그인해요`, `${label} may need a sign-in — sign in in its terminal`) } : {}) })
      else if (has.some((l) => l.prefs?.enabled === false)) out.push({ ...base, available: false, why: L('PC 앱에서 에이전트 실행이 꺼져 있어요 — 설정 › 계정 › 내 컴퓨터의 에이전트에서 켜요', 'Agent runs are off in the desktop app — turn them on in Settings › Account › Agents on my computer') })
      // (a desktop before 0.2.2 runs steps but not chat messages)
      else if (has.every((l) => !l.caps.chat)) out.push({ ...base, available: false, why: L('PC 앱을 새 판(0.2.2 이상)으로 올리면 채팅에서 쓸 수 있어요', 'Update the desktop app (0.2.2 or later) to use it from the chat'), update: true })
      else out.push({ ...base, available: false, why: L(`이 PC 에서 ${eulReul(label)} 실행할 수 없어요`, `${label} cannot run on this computer`) })
      continue
    }
    // none is on: what the linked desktops said last time (any CLI when none was ever linked, or none has reported its CLIs yet —
    // a desktop just paired, before its first link)
    const reported = devices.filter((d) => Object.keys(d.caps?.clis || {}).length)
    if (reported.length && !reported.some((d) => d.caps.clis[id]?.installed)) continue
    out.push({ ...base, devices: devices.filter((d) => d.caps?.clis?.[id]?.installed).map((d) => d.name), available: false,
      why: devices.length ? L('PC 앱이 꺼져 있어요', 'The desktop app is off') : L('PC 앱을 설치하고 로그인하면 쓸 수 있어요', 'Install the desktop app and sign in to use it') })
  }
  // latest: the newest desktop app — a page inside an older one offers it (desktopRelease.js)
  return { agents: out, desktop: { linked: devices.length, online: links.length, names: links.map((l) => l.name), latest: latestDesktop() }, download: DOWNLOAD }
}

// the agent the person chose for a chat (one row per chat; none: 기본)
export async function choiceOf(user, key) {
  const [r] = await q('select agent from pro_chat_agents where tenant_id=$1 and user_id=$2 and chat_key=$3', [T(), user.id, String(key)]).catch(() => [])
  return r && (r.agent === 'default' || isAgent(r.agent)) ? r.agent : 'default'
}
export async function choose(user, key, agent) {
  const k = String(key || '').slice(0, 200)
  if (!k) throw err(400, 'key')
  if (agent !== 'default' && !isAgent(agent)) throw err(400, L('고를 수 있는 에이전트가 아니에요.', 'That is not an agent you can pick.'))
  if (agent === 'default') await q('delete from pro_chat_agents where tenant_id=$1 and user_id=$2 and chat_key=$3', [T(), user.id, k])
  else await q(`insert into pro_chat_agents (tenant_id, user_id, chat_key, agent) values ($1,$2,$3,$4)
                on conflict (tenant_id, user_id, chat_key) do update set agent=$4, updated_at=now()`, [T(), user.id, k, agent])
  return agent
}

// ---------- the folder ----------
async function personOf(userId) {
  const [p] = await q('select name, email from pro_profile where user_id::text=$1', [String(userId)])
  return { id: String(userId), name: p?.name || p?.email || '', email: p?.email || '' }
}
// The person's own folder for their local CLI's chats: made once (a second message while it is made waits for it), owned by them alone
// (no one else is a member), kept by settings.local_chat.owner
const making = new Map()
export async function personalFolder(user) {
  const find = async () => (await q(`select * from pro_folders where tenant_id=$1 and settings->'local_chat'->>'owner' = $2 order by created_at limit 1`, [T(), String(user.id)]))[0] || null
  const have = await find()
  if (have) return have
  const k = `${T()}:${user.id}`
  if (!making.has(k)) {
    making.set(k, (async () => {
      const again = await find()
      if (again) return again
      const S = await import('../folders/service.js')
      const me = await personOf(user.id)
      const base = `${L('내 PC 에이전트 작업', 'My PC agent work')} · ${me.name || user.name || L('나', 'me')}`.slice(0, 70)
      let name = base
      for (let n = 2; (await q('select 1 from pro_folders where tenant_id=$1 and name=$2', [T(), name])).length; n++) name = `${base} (${n})`
      const f = await S.createFolder({ ...me, id: user.id }, { name, slug: `mypc-${String(user.id).replace(/-/g, '').slice(0, 8)}`,
        description: L('채팅에서 「내 PC」 에이전트(Claude Code · Codex)가 만든 파일 — 나만 봐요', 'Files your agents on "My PC" (Claude Code · Codex) made from the chat — only you see them') })
      const [row] = await q(`update pro_folders set settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('local_chat', $2::jsonb) where id=$1 returning *`, [f.id, JSON.stringify({ owner: String(user.id), at: new Date().toISOString() })])
      return row
    })().finally(() => making.delete(k)))
  }
  return making.get(k)
}
// where a chat's runs work: {folder, mode: 'project' | 'personal', line (the branch its runs start from and come back to), variation,
// template (a project started from a template: {name, outputs} — its runs work in the person's own workspace)}
// A project folder needs edit rights (a viewer or a runner of it is refused — 403); a linked folder is not served over git (409).
// A project started from a template works in its person's own workspace (folders/templates.js): the right that started it — runner, the
// same a server agent's turn there needs — is enough (it is never merged into the template; its files reach the template only by
// 「원본에 반영 요청」, which its owner reviews).
export async function folderFor(user, thread) {
  const S = await import('../folders/service.js')
  if (thread.kind === 'project') {
    const TF = await import('../folders/threadFolders.js')
    const link = await TF.linkOf(thread.id)
    if (link?.mode === 'project') {
      const folder = await S.folderById(link.folder_id)
      if (!folder) throw err(404, L('이 프로젝트의 폴더를 찾지 못했어요.', "I couldn't find this project's folder."))
      if (folder.kind === 'linked') throw err(409, L('연결형 폴더에서 일하는 프로젝트는 내 PC 에이전트로 보낼 수 없어요 — 기본으로 보내 주세요.', 'A project in a linked folder cannot go to an agent on your PC — send it to Default.'))
      const TPL = await import('../folders/templates.js')
      const cur = link.variation_id ? await S.variationById(link.variation_id) : null
      // (the same choice ensureProjectVariation makes: the project's workspace, or a new one from the template's main)
      const workspace = TPL.isWorkspace(cur) ? TPL.mayView(cur, user) : !cur && TPL.isTemplate(folder)
      const role = await S.roleOf(folder, user)
      if (workspace) {
        if (!role || S.RANK[role] < S.RANK.runner) throw err(403, L(`이 프로젝트의 템플릿 ${eulReul(`「${folder.name}」`)} 쓸 수 있는 사람(실행 이상)만 내 PC 에이전트로 보낼 수 있어요.`, `Only someone who may use this project's template "${folder.name}" (runner or above) can send to an agent on their PC.`))
      } else if (!role || S.RANK[role] < S.RANK.editor) throw err(403, L(`이 프로젝트의 폴더 「${folder.name}」를 고칠 수 있는 사람(편집자 이상)만 내 PC 에이전트로 보낼 수 있어요.`, `Only someone who may edit this project's folder "${folder.name}" (editor or above) can send to an agent on their PC.`))
      const { v } = await TF.ensureProjectVariation(user, thread, link)
      const tpl = TPL.isWorkspace(v) ? { name: v.source.template.name || folder.name, outputs: TPL.outputsOf(v.source.template.outputs) } : null
      // (below editor: the run leaves the folder's own run settings off — prepare; only a desktop that can goes — jobs.js freeLinks)
      return { folder, mode: 'project', line: v.branch, variation: v.id, template: tpl, projectSettings: S.RANK[role] >= S.RANK.editor }
    }
  }
  const folder = await personalFolder(user)
  return { folder, mode: 'personal', line: folder.default_branch, variation: null, projectSettings: true }
}

// ---------- sending ----------
// the chat's run that is on now with this agent (waiting for the desktop · sent · running), or null
export async function openJob(user, threadId, key, agent) {
  const [j] = await q(`select * from pro_local_jobs where tenant_id=$1 and user_id=$2 and kind='chat' and thread_id=$3 and chat->>'key'=$4 and agent=$5
                       and state in ('queued','offered','running') order by created_at desc limit 1`, [T(), user.id, threadId, key, agent])
  return j || null
}
// the chat's last run with this agent that had a CLI session (the next run resumes it)
async function lastSession(user, threadId, key, agent) {
  const [j] = await q(`select session_id from pro_local_jobs where tenant_id=$1 and user_id=$2 and kind='chat' and thread_id=$3 and chat->>'key'=$4 and agent=$5
                       and session_id is not null order by created_at desc limit 1`, [T(), user.id, threadId, key, agent])
  return j?.session_id || null
}

// A short recap of the chat for a CLI that starts without its session: its last words (the person's, the agents'), oldest first
async function recapOf(thread, conv, beforeId) {
  const rows = await q(`select id, role, kind, content, created_at from pro_messages where thread_id=$1 and kind in ('text','doc') order by created_at desc limit 60`, [thread.id])
  const out = []
  for (const m of rows) {
    if (m.id === beforeId) continue
    // (in one conversation of the main chat: its own messages, as far as they say so)
    if (conv && m.content?.conv && m.content.conv !== conv && m.content?.context?.conversationId !== conv) continue
    const t = String(m.content?.text || '').trim()
    if (!t || m.content?.failed) continue
    const who = m.role === 'user' ? L('나', 'Me') : m.content?.localAgent ? LABEL(m.content.localAgent.id) : L('기본 에이전트', 'Default agent')
    out.unshift(`- ${who}: ${t.replace(/\s+/g, ' ').slice(0, 500)}`)
    if (out.length >= RECAP_N) break
  }
  return out.length ? `${L(`[이 대화의 앞부분 — 최근 ${out.length}개]`, `[Earlier in this chat — the last ${out.length}]`)}\n${out.join('\n')}\n\n` : ''
}
// (template: a project started from a template — its own workspace, told as the server agent's turns there are: threadFolders.workspaceNote)
async function promptFor({ person, folder, mode, recap, message, template = null }) {
  let tpl = ''
  try { tpl = await (await import('../ontology/discovery.js')).prompt('local-chat') } catch { /* the bundled skill has it */ }
  const fill = (s, v) => String(s || '').replace(/\{(\w+)\}/g, (_, k) => v[k] ?? '')
  const where = template
    ? L(` — 템플릿 「${template.name}」에서 시작한 이 프로젝트 전용 작업 공간이에요(여기서 바꾼 것은 이 프로젝트에만 남고 템플릿 원본은 바뀌지 않아요). 결과물은 '${template.outputs}/' 아래에 새 파일로 두고, 템플릿의 안내(TEMPLATE.md) · 양식 · 스킬(.claude/skills)을 따라 일하세요. 템플릿 파일 자체(양식 · 스킬)를 고쳐야 하면 작업 공간의 그 파일을 고치고, ${person.name || '사용자'} 님이 프로젝트 위의 「원본에 반영 요청」으로 그 파일만 보낼 수 있다고 알려 주세요`,
      ` — this project's own workspace, started from the template "${template.name}" (what changes here stays in this project; the template's original does not change). Put outputs as new files under '${template.outputs}/' and follow the template's notes (TEMPLATE.md), forms and skills (.claude/skills). If a template file itself (a form, a skill) needs fixing, fix it in the workspace and tell ${person.name || 'the user'} they can send just that file with 「원본에 반영 요청」 above the project`)
    : mode === 'project' ? L(' — 이 프로젝트의 변형이에요(원본은 사람이 「반영」으로 바꿔요)', " — this project's variation (a person merges it into the original)") : ''
  const text = fill(tpl || '{recap}[{person} 님의 메시지]\n{message}', {
    recap, folder: folder.name, person: person.name || L('사용자', 'the user'), message, where,
  })
  return `${text.trim()}${langInstruction()}`
}
// what a message carries: its words, and the files attached to it (named, with their links — the CLI reads them if it needs to)
function wordsOf(text, files = []) {
  const t = String(text || '').trim().slice(0, 8000)
  const fs_ = (Array.isArray(files) ? files : []).filter((f) => f && (f.url || f.name)).slice(0, 10)
  if (!fs_.length) return t
  // (a TIFF's page pictures by their signed addresses — lib/attachments.js pageRefs: the PC has no server workspace)
  const pages = (f) => pageRefs({ ...f, path: null }).map((u, n) => `\n  ${L(`${n + 1}쪽 그림(PNG)`, `page ${n + 1} (PNG)`)} — ${u}`).join('')
  return `${t}\n\n${L('[첨부한 파일]', '[Attached files]')}\n${fs_.map((f) => `- ${f.name || 'file'}${f.url ? ` — ${f.url}` : ''}${pages(f)}`).join('\n')}`
}

// The composer sent a message to a local agent: the message in the chat (tagged with its agent), then — into the chat's running CLI as
// its owner's input, onto the run that waits for the desktop, or a new run (the same CLI session when there was one). The server agent is
// not called. → {jobId, steered, queued, delivered}
export async function send({ user, thread, text, agent, conversation = null, files = [], refs = [], clientId = null }) {
  if (!isAgent(agent)) throw err(400, L('고를 수 있는 에이전트가 아니에요.', 'That is not an agent you can pick.'))
  if (!['chat', 'project'].includes(thread.kind)) throw err(400, L('이 대화에서는 기본 에이전트만 쓸 수 있어요.', 'Only the default agent answers here.'))
  // files dragged onto the composer (lib/fileRefs.js — read with the person's own access): by their addresses, since the CLI on the PC has
  // neither the folder tools nor the server's workspace; the message keeps them as chips, as the server agent's does
  const pointed = Array.isArray(refs) && refs.length ? await (await import('../fileRefs.js')).turnRefs(user, refs, { copies: true }).catch((e) => { console.warn('[file-refs] local', e.message); return null }) : null
  let words = wordsOf(text, files)
  if (pointed?.context) words = [words || L('첨부한 파일을 확인해 줘', 'Please look at the attached files'), pointed.context].join('\n\n')
  if (!words) throw err(400, 'empty')
  const conv = convOf(conversation)
  const convTitle = typeof conversation === 'object' && conversation?.title ? String(conversation.title).slice(0, 80) : null
  const key = keyOf(thread.id, conv)
  // (the message is in the chat first, whatever happens next: a refusal — a project folder the person may not edit — is said under it)
  const tag = { id: agent, label: LABEL(agent), where: HERE() }
  const msg = await addMessage(user.id, thread.id, 'user', 'text', { text: String(text || '').trim().slice(0, 8000) || (pointed?.shown?.length ? L('첨부한 파일을 확인해 줘', 'Please look at the attached files') : ''), agent: tag,
    ...(pointed?.shown?.length ? { refs: pointed.shown } : {}), ...(conv ? { conv } : {}),
    // (the page's id for it — lib/sendOnce.js: the same message sent again is taken once)
    ...(clientId ? { clientId: String(clientId) } : {}) })
  for (const f of (Array.isArray(files) ? files : []).slice(0, 10)) if (f?.url || f?.name) await addMessage(user.id, thread.id, 'user', 'file', { name: f.name, url: f.url, ...(conv ? { conv } : {}) })
  const open = await openJob(user, thread.id, key, agent)
  const where = open ? null : await folderFor(user, thread)
  const said = { id: msg.id, text: words, at: new Date().toISOString() }
  if (open && ['offered', 'running'].includes(open.state)) {
    const r = await J.steer(open, user, words)
    await q(`update pro_local_jobs set chat = jsonb_set(coalesce(chat, '{}'::jsonb), '{messages}', coalesce(chat->'messages', '[]'::jsonb) || $2::jsonb) where id=$1`, [open.id, JSON.stringify([{ ...said, steerId: r.steer.id }])])
    return { jobId: open.id, steered: true, delivered: r.delivered }
  }
  if (open) {
    // still waiting for the desktop: the message goes with the one it starts with
    const [j] = await q(`update pro_local_jobs set prompt = coalesce(prompt, '') || $2, chat = jsonb_set(jsonb_set(coalesce(chat, '{}'::jsonb), '{messages}', coalesce(chat->'messages', '[]'::jsonb) || $3::jsonb),
                           '{message}', to_jsonb(coalesce(chat->>'message', '') || $2)), updated_at=now() where id=$1 returning *`, [open.id, `\n\n${words}`, JSON.stringify([said])])
    await note(j, 'queued')
    return { jobId: open.id, queued: true }
  }
  const person = await personOf(user.id)
  const lang = await langOf(user.id).catch(() => 'ko')
  const recap = await recapOf(thread, conv, msg.id)
  const prompt = await withLang(lang, () => promptFor({ person, folder: where.folder, mode: where.mode, recap, message: words, template: where.template }))
  const resumeOf = await lastSession(user, thread.id, key, agent)
  const title = (conv && convTitle) || thread.title || L('채팅', 'Chat')
  const chat = { key, threadId: String(thread.id), conv, convTitle, title, mode: where.mode, folderId: where.folder.id, folderName: where.folder.name, folderSlug: where.folder.slug,
    line: where.line, variation: where.variation, message: words, messages: [said], replies: [], carded: [], ...(resumeOf ? { resumeOf } : {}),
    ...(where.projectSettings === false ? { leaveOff: true } : {}) }
  let j
  try {
    ;[j] = await q(`insert into pro_local_jobs (tenant_id, user_id, todo_id, kind, thread_id, activity_name, agent, mode, offline, server_agent, person_name, chat, prompt, folder_id, line)
                    values ($1,$2,$3,'chat',$4,$5,$6,'complete','wait','onto',$7,$8,$9,$10,$11) returning *`,
    [T(), user.id, `chat:${crypto.randomUUID()}`, thread.id, title.slice(0, 120), agent, person.name || user.name || '', JSON.stringify(chat), prompt, where.folder.id, where.line])
  } catch (e) {
    if (/column .*(kind|thread_id|chat)|pro_chat_agents/.test(String(e.message))) throw err(503, L('서버에 sql/055_chat_agents.sql 이 아직 없어요 — 관리자에게 알려 주세요.', 'The server is missing sql/055_chat_agents.sql — tell your administrator.'))
    throw e
  }
  // the run's card, right under the message
  const card = await addMessage(user.id, thread.id, 'agent', 'local_run', cardOf(j, { worker: true }))
  ;[j] = await q('update pro_local_jobs set message_ids=$2 where id=$1 returning *', [j.id, JSON.stringify({ [String(user.id)]: card.id })])
  console.log(`[local-agents] chat ${String(thread.id).slice(0, 8)} → ${agent}${resumeOf ? ' (same session)' : ''}`)
  j = await J.route(j)
  return { jobId: j.id, started: true }
}

// ---------- what the desktop gets ----------
// a folder's files that make a CLI run things on the PC by themselves (hooks · permissions · MCP servers · helpers): left off for a person
// who may not edit the folder (the desktop's runSettings.js — the same list)
export const RUN_SETTINGS = ['.claude/settings.json', '.claude/settings.local.json', '.mcp.json', '.codex/config.toml']
// a desktop too old to leave them off (no leaveOffSettings in its caps) does not get such a run
export const OUTDATED = () => L('이 PC 앱은 템플릿의 실행 설정을 끄고 실행할 수 없어요 — PC 앱을 새 버전으로 올려 주세요.', "This desktop app can't leave a template's run settings off — please update the desktop app.")
// said once in the chat (the first run that left them off)
// a path's names as a file system that ignores case (macOS, Windows) takes them — `.Claude/Agents/x.md` is where the CLI finds
// .claude/agents: case folded, the dots and spaces Windows drops from a name's end dropped (the desktop's runSettings.js fold)
const fold = (rel) => String(rel).split('/').map((n) => n.toLowerCase().replace(/[. ]+$/, ''))
// a file the CLI reads front matter from — any SKILL.md, a .md under a .claude/agents or .claude/commands folder, nested too, names in any
// case (the desktop's runSettings.js isFrontFile)
export function isFrontFile(rel) {
  const segs = fold(rel)
  const base = segs[segs.length - 1] || ''
  if (base === 'skill.md') return true
  if (!base.endsWith('.md')) return false
  for (let i = 0; i < segs.length - 2; i++) if (segs[i] === '.claude' && (segs[i + 1] === 'agents' || segs[i + 1] === 'commands')) return true
  return false
}
// what of the folder's line at `ref` the run leaves off: its settings files, and the skills · commands · agents whose front matter names
// run keys (lib/folders/kit.js frontRuns — read as the badge reads it)
async function runSettingsAt(folder, ref) {
  const G = await import('../folders/git.js')
  const { frontRuns } = await import('../folders/kit.js')
  const tree = await G.lsTree(folder.repo_path, ref)
  const files = tree.map((f) => f.path).filter((p) => RUN_SETTINGS.includes(fold(p).join('/')))
  const front = []
  // (a file's head, as the desktop reads it — HEAD_MAX there; one too long to read here counts)
  for (const f of tree.filter((x) => isFrontFile(x.path)).slice(0, 500)) {
    if (Number(f.size) > 8 * 1024 * 1024) { front.push(f.path); continue }
    const buf = await G.git(folder.repo_path, ['cat-file', 'blob', f.sha], { buffer: true }).catch(() => null)
    const head = buf?.subarray(0, 1024 * 1024)
    if (head && frontRuns(head.toString('utf8'), { truncated: buf.length > head.length }).length) front.push(f.path)
  }
  return { files, front }
}
async function settingsNote(job, folder, { files, front }) {
  const [seen] = await q(`select 1 from pro_messages where thread_id=$1 and content->>'settingsOff' = 'true' limit 1`, [job.thread_id])
  if (seen) return
  const c = job.chat || {}
  await withLang(await langOf(String(job.user_id)).catch(() => 'ko'), () => {
    const what = [...(files.length ? [files.join(', ')] : []),
      ...(front.length ? [L(`스킬 · 명령 · 에이전트 ${front.length}개의 머리말(훅 · 허용 도구 등)`, `the front matter of ${front.length} skill(s), command(s) or agent(s) (hooks, allowed tools, …)`)] : [])]
    return addMessage(String(job.user_id), job.thread_id, 'agent', 'text', {
      text: L(SETTINGS_OFF_KO, SETTINGS_OFF_EN).replace('{folder}', folder.name).replace('{what}', what.join(' · ')),
      note: true, settingsOff: true, settingsOffFiles: [...files, ...front], ...(c.conv ? { conv: c.conv } : {}),
    })
  })
}
const SETTINGS_OFF_KO = '이번 실행에서는 템플릿 「{folder}」의 실행 설정({what})을 켜지 않았어요. 실행 설정은 템플릿을 고칠 수 있는 사람(편집자 이상)의 PC에서만 켜져요. 스킬의 내용과 CLAUDE.md는 그대로 사용하지만, 도구를 쓸 때 PC가 허용 여부를 물어볼 수 있어요.'
const SETTINGS_OFF_EN = 'This run left the run settings of the template "{folder}" ({what}) off. Run settings turn on only on the PCs of people who can edit the template (editors and above). The skills\' content and CLAUDE.md are used as usual, but your PC may ask before a tool is used.'
const gitPublic = () => String(process.env.PRO_GIT_PUBLIC_URL || '').trim().replace(/\/+$/, '')
export async function prepare(job, link = null) {
  const c = job.chat || {}
  const S = await import('../folders/service.js')
  const G = await import('../folders/git.js')
  const { mintToken, runBranchFor, runPushFor } = await import('../folders/gitHttp.js')
  const folder = await S.folderById(c.folderId || job.folder_id)
  if (!folder) throw new Error('the folder is gone')
  if (folder.kind === 'linked') throw new Error('a linked folder is not served over git')
  let line = c.line || folder.default_branch
  // a project's variation that was merged (반영) or dropped meanwhile: the project's live one now
  if (c.mode === 'project' && c.variation) {
    let v = await S.variationById(c.variation)
    if (!v || !['open', 'ready', 'conflicted'].includes(v.status)) {
      const [thread] = await q('select * from pro_threads where id=$1', [job.thread_id])
      const TF = await import('../folders/threadFolders.js')
      const lk = thread ? await TF.linkOf(thread.id) : null
      if (!lk || lk.mode !== 'project') throw new Error('the project no longer works in this folder')
      const { v: nv } = await TF.ensureProjectVariation({ id: String(job.user_id), name: job.person_name || '' }, thread, lk)
      line = nv.branch
      v = nv
      await q(`update pro_local_jobs set chat = chat || jsonb_build_object('line', $2::text, 'variation', $3::text) where id=$1`, [job.id, nv.branch, nv.id])
    }
    // One working copy per variation (folders/seats.js): this computer takes the project variation's seat for the run — the person's own
    // server workroom gives it up (saved as it is), a server agent's running turn or another place refuses it (the run then says why and
    // offers 「기본으로 다시 보내기」). The seat goes when the run ends (note).
    if (link?.id) {
      const seat = await (await import('../folders/seats.js')).claimDevice(folder, v, { user: { id: String(job.user_id), name: job.person_name || '' }, device: link.id, job: job.id })
      // (the run remembers it had a seat: what it pushes after losing it is not brought in — bringIn)
      if (!seat.legacy) await q(`update pro_local_jobs set chat = coalesce(chat, '{}'::jsonb) || jsonb_build_object('seat', $2::int) where id=$1`, [job.id, seat.epoch])
    }
  }
  const base = await G.branchExists(folder.repo_path, line) ? line : folder.default_branch
  // The folder's own run settings (Claude Code's project hooks · permissions · MCP servers · status line · helpers, Codex's project config)
  // run on the PC only for someone who may edit the folder — who could put them there anyway. A template's runner works in their own
  // workspace (folderFor): the desktop leaves those files off for the run (job.projectSettings false — skills and CLAUDE.md stay), says so
  // once in the chat, and never sends them back changed. A desktop too old to leave them off does not get the run.
  const role = await S.roleOf(folder, { id: String(job.user_id) }).catch(() => null)
  const projectSettings = c.mode !== 'project' || (!!role && S.RANK[role] >= S.RANK.editor)
  if (!projectSettings) {
    if (link && !link.caps?.leaveOffSettings) throw new Error(OUTDATED())
    const off = await runSettingsAt(folder, base).catch((e) => { console.warn('[local-agents] chat run settings', e.message); return { files: [], front: [] } })
    if (off.files.length || off.front.length) await settingsNote(job, folder, off).catch((e) => console.warn('[local-agents] chat settings note', e.message))
  }
  const person = await personOf(job.user_id)
  const lang = await langOf(job.user_id).catch(() => 'ko')
  // this run's own session when it was running before (its desktop app restarted), else the chat's last session — the desktop resumes it
  // when it still has it, and otherwise starts afresh with the prompt (its recap)
  const own = job.session_id && job.started_at ? job.session_id : null
  const resume = own || c.resumeOf || null
  const scope = link?.id ? { scope: 'device', device: link.id, job: job.id, hours: Math.min(24, Number(config.gitTokenHours) || 24) } : {}
  // (this run's own branch — pgpt-agent/local/<person>/<job>-…, gitHttp.js; a run resumed keeps the branch it had, an old name too)
  const branch = runBranchFor(job, own ? job.run_branch : null)
  return {
    kind: KIND, todoId: String(job.todo_id), instId: null, instName: c.title || '', activity: c.title || L('채팅', 'Chat'), agent: job.agent, label: A.LABEL[job.agent] || job.agent,
    mode: 'complete', prompt: job.prompt, message: c.message || '', person, lang, skills: [], projectSettings,
    chat: { key: c.key, threadId: String(job.thread_id), title: c.title || '' },
    git: {
      path: `/api/local-git/${folder.id}.git`, url: gitPublic() ? `${gitPublic()}/api/local-git/${folder.id}.git` : null,
      token: mintToken({ tenant: T(), folderId: folder.id, push: runPushFor(job, branch), ...scope }),
      line: base, base, branch,
      folder: { id: folder.id, slug: folder.slug, name: folder.name },
    },
    ...(resume ? { resume: { sessionId: resume } } : {}),
  }
}

// ---------- each turn's answer ----------
const isAncestor = async (G, repo, a, b) => !!a && !!b && (await G.mergeBase(repo, a, b)) === a
// The run's pushed head onto the chat's line: the person's own folder's main (its working tree follows — a fast-forward, else a merge;
// a conflict leaves main as it was), or the project's variation (moved like an instance line; merged in its worktree when it is checked
// out). → {head, into} (into: the ref the files are published from), or null when nothing could be brought in
async function bringIn(job, branch) {
  const c = job.chat || {}
  const S = await import('../folders/service.js')
  const G = await import('../folders/git.js')
  const folder = await S.folderById(job.folder_id || c.folderId)
  if (!folder) return null
  // (only this run's own branch — what its token could push)
  const { isRunOf } = await import('../folders/gitHttp.js')
  if (!isRunOf(job, branch) || !(await G.branchExists(folder.repo_path, branch))) return null
  // (the run's branch goes once what it holds is somewhere else — brought in, or kept as a leftover: run branches never pile up)
  const drop = () => G.git(folder.repo_path, ['update-ref', '-d', `refs/heads/${branch}`, head], { check: false })
  const head = await G.head(folder.repo_path, `refs/heads/${branch}`)
  const person = await personOf(job.user_id)
  const who = { name: person.name || 'Process GPT Lite', email: person.email || undefined }
  const msg = L(`${A.LABEL[job.agent] || job.agent} (내 PC) — ${c.title || '채팅'}`, `${A.LABEL_EN[job.agent] || job.agent} (my PC) — ${c.title || 'chat'}`)
  if (c.mode !== 'project') {
    // (an edit made in main meanwhile — the folder screen, the editor — is kept first; folders/line.js, shared with champion folders' sync)
    const { intoMain } = await import('../folders/line.js')
    const ok = !(await intoMain(folder, head, { who, message: msg })).conflicted
    await S.touch(folder)
    import('../folders/indexer.js').then((x) => x.reindex(folder, { cards: false }).then(() => x.cardsSoon(folder))).catch(() => {})
    if (!ok) console.warn(`[local-agents] chat: ${branch} conflicts with main of '${folder.slug}' — left on its branch`)
    const now = ok ? await G.head(folder.repo_path, folder.default_branch) : head
    if (ok && await isAncestor(G, folder.repo_path, head, now)) await drop()
    return { folder, head: now, conflicted: !ok }
  }
  const v = await S.variationById(c.variation)
  if (!v) return { folder, head, conflicted: true }
  // one working copy per variation (folders/seats.js): a run that no longer holds the variation's seat (its person took it back, it moved)
  // brings nothing into it — what it pushed becomes a variation of its own, 「… — <PC>에 남아 있던 변경」 (never thrown away, never mixed in)
  const SE = await import('../folders/seats.js')
  const holds = await SE.jobHolds(v.id, job.id)
  if (holds === false || (holds === null && c.seat != null)) {
    const left = await SE.leftover(folder, v, head, { user: String(job.user_id), where: job.device_name || '' }).catch((e) => { console.warn('[local-agents] chat leftover', e.message); return null })
    // (its leftover holds the same commits — kept as privately as a workspace when it is one: the run's branch goes)
    if (left) await drop()
    return { folder, head, conflicted: true, leftover: left?.id || null }
  }
  let now = null
  if (v.worktree_path && fs.existsSync(v.worktree_path)) {
    // (checked out — a server agent turn of the project has it open): merged there, so its worktree follows
    await S.serial(folder.id, async () => {
      await G.git(v.worktree_path, [...G.who(who.name, who.email), 'merge', '--no-edit', '-q', '-m', msg, head], { check: false })
      if ((await G.git(v.worktree_path, ['diff', '--name-only', '--diff-filter=U'], { check: false })).trim()) await G.git(v.worktree_path, ['merge', '--abort'], { check: false })
    })
    now = await G.head(folder.repo_path, `refs/heads/${v.branch}`)
  } else {
    const { advanceLine } = await import('../folders/line.js')
    now = await advanceLine(folder, v.branch, head, { record: false })
  }
  await q(`update pro_folder_variations set head_commit=$2, status=case when status='open' then 'ready' else status end, updated_at=now() where id=$1`, [v.id, now])
  if (holds) await SE.pushed(v.id, now)
  await S.touch(folder)
  const after = await S.variationById(v.id)
  const brought = await isAncestor(G, folder.repo_path, head, now)
  // brought in: the run's branch goes (what it holds is in the variation now). A project's workspace made from a template
  // (folders/templates.js) gets no 「반영하면 …」 card (it is never merged — as finishProjectWork)
  if (brought) await drop()
  if (!after?.source?.template) import('../folders/indexer.js').then((x) => x.changeCard(folder, after)).catch(() => {})
  emit(String(job.user_id), 'folders', { slug: folder.slug, variation: v.id })
  import('../folders/threadFolders.js').then((x) => x.announce(String(job.user_id), job.thread_id)).catch(() => {})
  return { folder, head: now, conflicted: !brought }
}

// a copy of one file as it is at `commit`, in storage (content-addressed — the folder screen's 열기 does the same: service.publishFile)
async function publishAt(folder, rel, commit) {
  const S = await import('../folders/service.js')
  const G = await import('../folders/git.js')
  const p = S.safeRel(rel)
  const sha = (await G.git(folder.repo_path, ['rev-parse', `${commit}:${p}`], { check: false })).trim()
  if (!/^[0-9a-f]{40}$/.test(sha)) return null
  // (the same copy the folder screen makes — at the shared public address only for a version everyone of the folder may read; a project's
  // workspace, or a run's branch no one else sees, is published privately: folders/service.js)
  const pub = await S.publishBlob(folder, p, sha, { private: !(await S.sharedCommit(folder, commit)) })
  return { url: pub.url, key: pub.key || null, private: !!pub.private, name: p.split('/').pop(), sha }
}
// the files a turn made or changed that become cards: the folder's own files (not the app's or the CLI's hidden ones), a few at most
export const cardable = (files) => [...new Set((Array.isArray(files) ? files : []).map((f) => String(f || '').replace(/\\/g, '/')))]
  .filter((p) => p && !p.split('/').some((s) => s.startsWith('.') || s === '..') && !['CLAUDE.md', 'AGENTS.md'].includes(p)).slice(0, CARDS_MAX)

// file cards for what a turn changed, published from where it now is (main, the project's variation — or the run's own branch when it
// could not be brought in); a file already carded at the same version is not carded again
async function fileCards(job, files, at) {
  const c = job.chat || {}
  const out = []
  if (!at?.folder) return out
  const S = await import('../folders/service.js')
  const role = c.mode === 'personal' ? 'owner' : null
  for (const p of cardable(files)) {
    const pub = await publishAt(at.folder, p, at.head).catch((e) => { console.warn('[local-agents] chat file', p, e.message); return null })
    if (!pub) continue
    if ((c.carded || []).some((x) => x.path === p && x.sha === pub.sha)) continue
    // the person's own folder: its documents open in the editor and save back into it; a project's are copies (its folder changes through
    // its variation and 반영)
    const editable = role === 'owner' && S.OFFICE_EDIT.has(p.split('.').pop().toLowerCase())
    // (a private copy: the card keeps its key — each opening signs a fresh address, lib/fileCards.js — never an address that runs out)
    const m = await addMessage(String(job.user_id), job.thread_id, 'agent', 'file', { name: pub.name, ...(pub.private ? { private: { key: pub.key } } : { url: pub.url }),
      ...(c.mode === 'personal' ? { folder: { slug: at.folder.slug, name: at.folder.name, path: p, sha: pub.sha, editable } } : {}),
      localRun: { jobId: job.id, agent: job.agent, folder: at.folder.name, path: p, mode: c.mode }, ...(c.conv ? { conv: c.conv } : {}) })
    out.push({ path: p, sha: pub.sha, msg: m.id })
  }
  return out
}
// the answer as a normal assistant message (in a conversation of the main chat: of that conversation, as the router's pinned answers are)
async function answer(job, text) {
  const c = job.chat || {}
  const t = String(text || '').trim().slice(0, 16000)
  if (!t) return null
  const ctx = c.conv ? { context: { title: c.convTitle || c.title || '', action: 'continue', conversationId: c.conv, strategy: 'pinned', confidence: 1 }, conv: c.conv } : {}
  const m = await addMessage(String(job.user_id), job.thread_id, 'agent', 'text', { text: t, localAgent: { id: job.agent, label: A.LABEL[job.agent] || job.agent, where: HERE(), jobId: job.id }, ...ctx })
  if (c.conv) import('../context/digest.js').then((x) => x.rebuildSoon(String(job.user_id), c.conv)).catch(() => {})
  return m
}
// a turn ended on the desktop: {turn, text, branch, commit, pushed, files}
export async function reply(job, msg) {
  const turn = Number(msg.turn) || 0
  const c0 = job.chat || {}
  if ((c0.replies || []).some((r) => r.turn === turn)) return
  // (claimed first: the same turn said twice at once posts once)
  const [claimed] = await q(`update pro_local_jobs set chat = jsonb_set(chat, '{replies}', coalesce(chat->'replies', '[]'::jsonb) || $2::jsonb), updated_at=now()
                             where id=$1 and not exists (select 1 from jsonb_array_elements(coalesce(chat->'replies', '[]'::jsonb)) r where (r->>'turn')::int = $3) returning *`,
  [job.id, JSON.stringify([{ turn, at: new Date().toISOString() }]), turn])
  if (!claimed) return
  let j = claimed
  const at = msg.pushed && msg.branch ? await bringIn(j, String(msg.branch)).catch((e) => { console.warn('[local-agents] chat bring-in', e.message); return null }) : null
  await withLang(await langOf(String(j.user_id)).catch(() => 'ko'), async () => {
    const m = await answer(j, msg.text)
    const cards = await fileCards(j, msg.files, at)
    ;[j] = await q(`update pro_local_jobs set chat = jsonb_set(jsonb_set(chat, '{carded}', coalesce(chat->'carded', '[]'::jsonb) || $2::jsonb), '{replies}',
                      (select jsonb_agg(case when (r->>'turn')::int = $3 then r || $4::jsonb else r end) from jsonb_array_elements(chat->'replies') r)), updated_at=now() where id=$1 returning *`,
    [j.id, JSON.stringify(cards.map(({ path, sha }) => ({ path, sha }))), turn, JSON.stringify({ msg: m?.id || null, files: cards.map((x) => x.path), conflicted: !!at?.conflicted })])
  })
  await note(j, 'reply')
}

// ---------- the run's end ----------
// The session ended (the wait after its turn ran out, 「끝내기」): what it pushed last (a change after its last answer) comes in too;
// messages that never reached its CLI (sent as it was closing) start the next run of the chat — the same session
export async function complete(job, result) {
  let out = null
  if (result.pushed && result.branch) {
    const at = await bringIn(job, result.branch).catch((e) => { console.warn('[local-agents] chat bring-in', e.message); return null })
    if (at) {
      out = { head: at.head }
      const cards = await withLang(await langOf(String(job.user_id)).catch(() => 'ko'), () => fileCards(job, result.files, at))
      if (cards.length) await q(`update pro_local_jobs set chat = jsonb_set(chat, '{carded}', coalesce(chat->'carded', '[]'::jsonb) || $2::jsonb) where id=$1`, [job.id, JSON.stringify(cards.map(({ path, sha }) => ({ path, sha })))])
    }
  }
  return out
}
async function carryOver(job) {
  const lost = (job.steers || []).filter((s) => s.failed && !s.applied)
  if (!lost.length) return
  const [thread] = await q('select * from pro_threads where id=$1', [job.thread_id])
  if (!thread) return
  const c = job.chat || {}
  // (the messages are in the chat already: only the run is started — its first message is what did not get in)
  const words = lost.map((s) => s.text).join('\n\n')
  const where = await folderFor({ id: String(job.user_id), name: job.person_name || '' }, thread).catch(() => null)
  if (!where) return
  const person = await personOf(job.user_id)
  const lang = await langOf(job.user_id).catch(() => 'ko')
  const prompt = await withLang(lang, () => promptFor({ person, folder: where.folder, mode: where.mode, recap: '', message: words, template: where.template }))
  const chat = { ...c, message: words, messages: lost.map((s) => ({ text: s.text, at: s.at })), replies: [], carded: [], line: where.line, variation: where.variation, folderId: where.folder.id,
    leaveOff: where.projectSettings === false || undefined,
    resumeOf: job.session_id || c.resumeOf || null }
  let [j] = await q(`insert into pro_local_jobs (tenant_id, user_id, todo_id, kind, thread_id, activity_name, agent, mode, offline, server_agent, person_name, chat, prompt, folder_id, line)
                     values ($1,$2,$3,'chat',$4,$5,$6,'complete','wait','onto',$7,$8,$9,$10,$11) returning *`,
  [T(), job.user_id, `chat:${crypto.randomUUID()}`, job.thread_id, job.activity_name, job.agent, job.person_name, JSON.stringify(chat), prompt, where.folder.id, where.line])
  const card = await addMessage(String(job.user_id), job.thread_id, 'agent', 'local_run', cardOf(j, { worker: true }))
  ;[j] = await q('update pro_local_jobs set message_ids=$2 where id=$1 returning *', [j.id, JSON.stringify({ [String(job.user_id)]: card.id })])
  await J.route(j)
}

// ---------- the card ----------
// a run that is on while its desktop's link is gone (the desktop app quit, the PC slept) — said from the hub's presence, not only from the
// moment it went (onOffline's note): a later change of the card still says so
const linkLost = (job) => ['running', 'offered'].includes(job.state) && (job.why === 'link-lost' || (!!job.device_id && !H.linkOf(T(), String(job.device_id))))
export function stateText(job) {
  const a = LABEL(job.agent)
  const dev = (job.device_id ? H.linkOf(T(), String(job.device_id))?.name : '') || job.device_name || ''
  const same = !!job.chat?.resumeOf
  switch (job.state) {
    case 'queued':
      if (job.why === 'busy') return L(`PC 앱이 다른 일을 하는 중이에요 — 차례가 오면 ${a}에게 보내요`, `The desktop app is busy — this goes to ${a} when its turn comes`)
      return L(`PC 앱이 꺼져 있어요 — 켜지면 ${a}에게 보내요. 지금 답이 필요하면 기본으로 다시 보낼 수 있어요`, `The desktop app is off — this goes to ${a} when it is on. If you need an answer now, send it to Default instead`)
    case 'offered': return L(`내 PC${dev ? `(${dev})` : ''}에 보냈어요 — 시작을 기다려요`, `Sent to my PC${dev ? ` (${dev})` : ''} — waiting for it to start`)
    case 'running':
      if (linkLost(job)) return L(`PC 앱 연결이 끊겼어요 — ${a}${josa(a, '은', '는')} 계속 실행 중일 수 있어요. 다시 연결되면 이어서 알려요`, `The desktop app's link dropped — ${a} may still be running; it reports when it is back`)
      return L(`내 PC 에서 ${a} 실행 중${dev ? ` (${dev})` : ''}${same ? ' · 같은 세션을 이어서' : ''}`, `${a} running on my PC${dev ? ` (${dev})` : ''}${same ? ' · same session' : ''}`)
    case 'done': return L('세션을 닫았어요 — 다음 메시지는 같은 세션을 이어요', 'Session closed — the next message goes on in the same session')
    case 'failed': return L(`멈췄어요: ${String(job.error || '').slice(0, 200)}`, `Stopped: ${String(job.error || '').slice(0, 200)}`)
    case 'cancelled': return job.why === 'fallback' ? L('기본 에이전트로 다시 보냈어요', 'Sent to the default agent instead') : L('멈췄어요', 'Stopped')
    // (the desktop did not take it: its person said no in 「실행 전에 묻기」, its local runs are off, or it could not run that CLI)
    case 'delegated': return job.why === 'fallback' ? L('기본 에이전트로 다시 보냈어요', 'Sent to the default agent instead') : ({
      declined: L('PC 에서 이번에는 실행하지 않기로 했어요', 'It was declined on the PC this time'),
      disabled: L('PC 앱에서 에이전트 실행이 꺼져 있어요', 'Agent runs are off in the desktop app'),
      unable: L(`PC 에서 ${eulReul(a)} 실행할 수 없어요`, `${a} cannot run on the PC`),
      unprepared: L(`PC 로 보낼 준비를 하지 못했어요: ${String(job.error || '').slice(0, 160)}`, `It could not be prepared for the PC: ${String(job.error || '').slice(0, 160)}`),
    }[job.why] || L('PC 에서 실행하지 못했어요', 'It could not run on the PC'))
    default: return ''
  }
}
// the run as its card shows it (LocalRunCard — chat: true): the step card's parts (state, lines, steers, terminal, conversation, the wait)
// with the chat's own words, its folder, and 「기본으로 다시 보내기」 when the run cannot answer now
export function cardOf(job, { worker = false } = {}) {
  const c = job.chat || {}
  const base = ST.cardOf(job, { canSteer: false, canDelegate: false, worker })
  const live = ['running', 'offered'].includes(job.state)
  const stuck = (['failed', 'delegated'].includes(job.state) && job.why !== 'fallback') || (job.state === 'queued' && job.why !== 'busy') || linkLost(job)
  return {
    ...base, chat: true, kind: KIND, threadId: job.thread_id ? String(job.thread_id) : null, conv: c.conv || null, instId: null, activity: c.title || '',
    text: stateText(job),
    // (a run that lived before its kind was known by the card: the step's rule — its terminal is a 'chat' session here)
    conversation: (Array.isArray(job.transcript) && job.transcript.length > 0) || (live && !!(job.device_id && H.linkOf(T(), String(job.device_id))?.caps?.conversation)) || (R.stats(R.find(T(), KIND, job.id))?.items || 0) > 0,
    folder: c.folderId ? { name: c.folderName || '', slug: c.folderSlug || '', mode: c.mode || 'personal' } : null,
    files: (c.carded || []).map((x) => x.path).slice(-20), replies: (c.replies || []).length, resumed: !!c.resumeOf,
    canSuggest: !worker, suggestions: base.suggestions,
    canFallback: !!worker && stuck,
  }
}
// who may see a chat run: its sender; and, for a project's folder, its members (they watch — they never type)
// (a project's workspace made from a template is its person's alone — folders/templates.js: nobody else sees its runs either)
export async function canSee(user, job) {
  if (String(job.user_id) === String(user.id)) return true
  if (job.chat?.mode !== 'project' || !job.folder_id) return false
  const S = await import('../folders/service.js')
  if (job.chat?.variation) {
    const TPL = await import('../folders/templates.js')
    const v = await S.variationById(job.chat.variation).catch(() => null)
    if (!v || TPL.isWorkspace(v)) return false
  }
  return !!(await S.roleOf(await S.folderById(job.folder_id), user).catch(() => null))
}
export async function cardFor(user, job) { return cardOf(job, { worker: String(job.user_id) === String(user.id) }) }

// the card follows the run: its message in the chat (the sender's), and the card itself to whoever has it on screen
export async function note(job, what) {
  if (what === 'link-lost') job = { ...job, why: 'link-lost' }
  // a run that ended gives back the project variation's seat it held (folders/seats.js) — after its last push came in (complete)
  if (['done', 'failed', 'cancelled', 'delegated'].includes(job.state)) await import('../folders/seats.js').then((x) => x.releaseJob(job)).catch((e) => console.warn('[local-agents] chat seat', e.message))
  const u = String(job.user_id)
  await withLang(await langOf(u).catch(() => 'ko'), async () => {
    const content = cardOf(job, { worker: true })
    const id = job.message_ids?.[u]
    if (id) await updateMessage(u, id, content)
    emit(u, 'local_run', { jobId: job.id, threadId: job.thread_id, state: job.state, what, card: content })
  })
  // (messages sent while it was closing: the next run of the chat)
  if (what === 'done') carryOver(job).catch((e) => console.warn('[local-agents] chat carry-over', e.message))
}

// 「기본으로 다시 보내기」: only the sender; the run stops (when it is still on) and the words that got no answer go back to the page,
// which sends them to the default agent
export async function fallback(user, job) {
  if (String(job.user_id) !== String(user.id)) throw err(403, L('이 실행을 보낸 사람만 다시 보낼 수 있어요.', 'Only the person who sent it can send it again.'))
  let j = job
  if (LIVE.includes(job.state)) j = await J.cancel(job, 'fallback')
  else if (['failed', 'done', 'cancelled', 'delegated'].includes(job.state)) {
    const [x] = await q(`update pro_local_jobs set why='fallback', updated_at=now() where id=$1 returning *`, [job.id])
    j = x || job
    await note(j, 'fallback')
  }
  const c = job.chat || {}
  const last = (c.replies || []).reduce((m, r) => Math.max(m, Date.parse(r.at) || 0), 0)
  const text = (c.messages || []).filter((m) => (Date.parse(m.at) || 0) > last).map((m) => m.text).join('\n\n') || c.message || ''
  return { text, threadId: String(job.thread_id), conv: c.conv || null, card: cardOf(j, { worker: true }) }
}

// ---------- wiring ----------
export function wireChat() {
  J.setKindHooks(KIND, { prepare, complete, reply, note, fail: async () => {}, delegate: async () => {}, learned: async () => {},
    // (a chat run is not a step: nothing closes it but its own end — or its thread going away)
    cancelled: async (job) => !!job.thread_id && !(await q('select 1 from pro_threads where id=$1', [job.thread_id]).catch(() => [{}])).length })
  // its terminal (relay.js kind 'chat', ref = the job): opened only by the desktop the job was given to, watched by who may see it
  const terminalDesk = (j) => !!(j.device_id && H.linkOf(T(), String(j.device_id))?.caps?.terminal)
  R.registerKind(KIND, {
    open: async (link, ref) => { const j = await J.byId(ref); return !!j && j.kind === KIND && String(j.user_id) === link.userId && String(j.device_id) === link.id },
    view: async (user, ref) => { const j = await J.byId(ref); return !!j && j.kind === KIND && canSee(user, j) },
    opened: async (S) => { const [j] = await q('update pro_local_jobs set terminal=true, updated_at=now() where id=$1 returning *', [S.ref]); if (j) await note(j, 'terminal') },
    exit: async (S) => {
      const [j] = await q('update pro_local_jobs set screen=$2, screen_size=$3, transcript=$4 where id=$1 returning *', [S.ref, S.buf.slice(-64 * 1024), JSON.stringify({ cols: S.cols, rows: S.rows }), JSON.stringify(R.txToKeep(S))])
      if (j && R.txOf(S).length) await note(j, 'transcript')
    },
    stored: async (ref) => {
      const j = await J.byId(ref)
      if (!j?.screen && !(Array.isArray(j?.transcript) && j.transcript.length)) return null
      return { buf: j.screen || '', cols: j.screen_size?.cols, rows: j.screen_size?.rows, agent: j.agent, tx: j.transcript || [] }
    },
    pending: async (ref) => { const j = await J.byId(ref); return !!j && ['offered', 'running'].includes(j.state) && !j.terminal && terminalDesk(j) },
  })
}
