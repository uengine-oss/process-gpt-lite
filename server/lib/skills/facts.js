// What is true for this person right now, as the router is told it (design 2.2 facts, 4 「시스템 사실」):
// their scheduled tasks, panel apps, folders, processes, teammates, the skills their agent can use, and
// the turn's own state (attached files, the open document, a process being designed). Names and ids
// only at the first stage; a skill's second stage gets the details it needs (a process's first-step
// keys, an app's fields). Nothing here reads what the person said.
import { q } from '../supa.js'
import { config } from '../../config.js'
import { L } from '../lang.js'
import { listSchedules } from '../scheduler.js'
import { history } from '../store.js'
import { listDefinitions, getDefinition } from '../processes.js'
import { listTeam, listAssignments } from '../team.js'
import { listSkills } from '../missions.js'
import * as PanelApps from '../panelApps/service.js'
import * as S from '../folders/service.js'
import * as SK from '../folders/skills.js'
import * as TF from '../folders/threadFolders.js'
import { processesWithHistory } from '../improve/service.js'

// provider names a skill's metadata.facts and an argument's x-enum-from may use
export const FACT_NAMES = ['schedules', 'recent_schedules', 'telegram', 'apps', 'folders', 'attached_folder', 'processes', 'improvable', 'team', 'members', 'agent_skills', 'my_skills', 'mission_skills']

// metadata.available_when: whether the skill is offered at all in this state
export const CONDITIONS = {
  always: () => true,
  has_schedules: (f) => f.schedules.length > 0,
  has_apps: (f) => f.apps.length > 0,
  has_team: (f) => f.team.length > 0,
  has_improvable: (f) => f.improvable.length > 0,
  // a change is proposed on a shared folder's variation: not while a process is being designed, not from
  // a Home card answering a mail (attached files go along to the folder's run)
  folder_change_possible: (f) => !f.noFolder && !f.generation && (f.folders.length > 0 || !!f.attachedFolder?.canChange),
}

// the scheduled tasks a conversation's last exchange is about: the ids its 「예약됨」 chips and run dividers
// carry, newest first (store.history rows: { kind, content })
export function recentScheduleIds(rows) {
  const ids = []
  for (const r of [...(rows || [])].reverse()) {
    const id = r?.content?.scheduleId
    if (id && !ids.includes(id)) ids.push(id)
  }
  return ids
}

const id8 = (id) => String(id || '').slice(0, 8)

// ---- production: the facts of one turn ----
export async function gatherFacts({ user, session, threadId, files = [], openDoc = null, generation = null, noFolder = false }) {
  const userId = user.id
  const safe = (p, v) => p.catch((e) => { console.warn('[skills] fact', e.message); return v })
  const [schedules, rows, telegram, apps, folders, link, processes, improvable, team, agentSkills, mySkills] = await Promise.all([
    safe(listSchedules(userId), []),
    safe(history(threadId, 6), []),
    safe(import('../telegram.js').then((t) => t.telegramStatus(userId)), { connected: false, linked: false, bot: null }),
    safe(PanelApps.listApps(user, { all: true }), []),
    safe(changeableFolders(user), []),
    safe(TF.linkOf(threadId), null),
    safe(listDefinitions().then((d) => d.slice(0, 12)), []),
    safe(processesWithHistory(), []),
    safe(teamWithRoles(userId), []),
    safe(listSkills(session?.access_token), []),
    safe(SK.privateSkills(user), []),
  ])
  // a project's own folder is changed on the project's own variation, by the agent's turn (lib/agent.js
  // delegate, folders/threadFolders.js prepareProjectWork) — never on a short one
  const ownProject = link?.mode === 'project' ? link.slug : null
  let attachedFolder = null
  if (link?.mode === 'ref') {
    const role = await safe(S.folderById(link.folder_id).then((f) => S.roleOf(f, user)), null)
    attachedFolder = { slug: link.slug, name: link.name, canChange: !!role && S.RANK[role] >= S.RANK.runner, folderId: link.folder_id }
  }
  const recent = recentScheduleIds(rows.slice(-5)).map(id8)
  return {
    schedules: schedules.slice(0, 15).map((s) => ({ id: id8(s.id), name: s.name, paused: !!s.paused, full: s.id })),
    recentSchedules: recent,
    telegram: { connected: !!telegram.connected, linked: !!telegram.linked, bot: telegram.bot || null },
    apps: apps.map((a) => ({ id: id8(a.id), title: a.title, kind: a.kind === 'events' ? 'events' : 'table', fields: PanelApps.describe(a.def), full: a.id })),
    folders: ownProject ? folders.filter((x) => x.slug !== ownProject) : folders,
    attachedFolder,
    processes: processes.map((d) => ({ id: d.id, name: d.name })),
    improvable: improvable.map((p) => ({ id: p.id, name: p.name })),
    team,
    agentSkills: agentSkills.map((k) => ({ name: k.name, description: firstSentence(k.description) })),
    mySkills: mySkills.map((k) => ({ name: k.name })),
    files: files.map((f) => ({ name: f.name })),
    openDoc: openDoc ? { app: openDoc.app, title: openDoc.title, file: openDoc.file, editor: openDoc.editor || null } : null,
    generation: generation || null,
    noFolder: !!noFolder,
    // second-stage details, read only when a skill needs them
    more: { processes: () => processDetails(processes) },
  }
}

const firstSentence = (d) => { const t = String(d || '').replace(/\s+/g, ' ').trim(); const i = t.search(/[.。!?](\s|$)/); return (i > 0 ? t.slice(0, i + 1) : t).slice(0, 160) }

// shared folders the person may propose a change to (runner and up), and the skills they can change
async function changeableFolders(user) {
  const rows = await q(`select f.slug, f.name from pro_folders f join pro_folder_members m on m.folder_id=f.id and m.principal_type='user' and m.principal_id=$2
                        where f.tenant_id=$1 and f.kind='managed' and m.role in ('owner','editor','runner') order by f.updated_at desc nulls last limit 30`, [config.tenantId, String(user.id)])
  const skills = (await SK.listSkills(user).catch(() => [])).filter((k) => k.mine || k.folder).slice(0, 20)
  return [...rows.map((f) => ({ slug: f.slug, name: f.name, kind: 'managed' })), ...skills.map((k) => ({ slug: `skill:${k.name}`, name: k.name, kind: 'skill' }))]
}

async function teamWithRoles(userId) {
  const team = (await listTeam()).filter((m) => m.id !== userId)
  if (!team.length) return []
  const roles = await listAssignments(null).catch(() => [])
  return team.map((m) => ({ id: m.id, name: m.name, email: m.email, roles: roles.filter((r) => r.user_id === m.id && r.proc_def_id === '*').map((r) => r.role) }))
}

async function processDetails(list) {
  const out = []
  for (const d of list) {
    const def = await getDefinition(d.id).catch(() => null)
    out.push({ id: d.id, name: d.name, startKeys: (def?.startForm?.fields || []).map((f) => f.key) })
  }
  return out
}

// ---- what the router's arguments may be (x-enum-from) ----
export function enumsOf(f) {
  return {
    schedules: f.schedules.map((s) => s.id),
    recent_schedules: f.recentSchedules,
    apps: f.apps.map((a) => a.id),
    folders: [...f.folders.map((x) => x.slug), ...(f.attachedFolder?.canChange ? ['attached'] : [])],
    attached_folder: f.attachedFolder ? ['attached'] : [],
    processes: f.processes.map((p) => p.id),
    improvable: f.improvable.map((p) => p.id),
    members: [...new Set(f.team.flatMap((m) => [m.name, m.email, ...(m.roles || [])].filter(Boolean)))],
    team: f.team.map((m) => m.name),
    agent_skills: f.agentSkills.map((k) => k.name),
    my_skills: f.mySkills.map((k) => k.name),
    // a scheduled run can use an installed skill or the author's own unshared one (lib/missions.js)
    mission_skills: [...new Set([...f.agentSkills.map((k) => k.name), ...f.mySkills.map((k) => k.name)])],
    telegram: [],
  }
}
// a choice's label for an id (the ask the server makes when the router left an argument out)
export function labelOf(f, from, id) {
  const hit = from === 'schedules' ? f.schedules.find((s) => s.id === id)?.name
    : from === 'apps' ? f.apps.find((a) => a.id === id)?.title
    : from === 'processes' || from === 'improvable' ? [...f.processes, ...f.improvable].find((p) => p.id === id)?.name
    : from === 'folders' ? (id === 'attached' ? f.attachedFolder?.name : f.folders.find((x) => x.slug === id)?.name)
    : null
  return hit || id
}

// ---- the facts as the router reads them ----
// names: which providers to show; detail: the second stage (fields, first-step keys)
export function factLines(f, names, { detail = false } = {}) {
  const want = new Set(names)
  const lines = []
  const add = (label, items) => { if (items) lines.push(`- ${label}: ${items}`) }
  if (want.has('schedules')) add(L('내 예약 작업(id 이름)', 'My scheduled tasks (id name)'), f.schedules.length ? f.schedules.map((s) => `${s.id} ${s.name}${s.paused ? L('(멈춤)', ' (paused)') : ''}`).join(' / ') : L('없음', 'none'))
  if (want.has('recent_schedules') && f.recentSchedules.length) add(L('이 대화에서 방금 만들거나 돌린 예약', 'Scheduled task this conversation just made or ran'), f.recentSchedules.map((id) => `${id} ${labelOf(f, 'schedules', id)}`).join(' / '))
  if (want.has('telegram')) add(L('내 텔레그램 봇', 'My Telegram bot'), f.telegram.connected && f.telegram.linked ? L(`연결됨(@${f.telegram.bot})`, `connected (@${f.telegram.bot})`) : L('연결 안 됨', 'not connected'))
  if (want.has('apps')) add(L('내 패널 앱(id 제목)', 'My panel apps (id title)'), f.apps.length ? f.apps.map((a) => `${a.id} ${a.title}${a.kind === 'events' ? L('(기록형)', ' (record-keeping)') : ''}${detail ? ` [${a.fields}]` : ''}`).join(' / ') : L('없음', 'none'))
  if (want.has('folders')) add(L('변경을 제안할 수 있는 폴더(slug 이름)', 'Folders I can propose changes to (slug name)'), f.folders.length ? f.folders.map((x) => `${x.slug} ${x.name}`).join(' / ') : L('없음', 'none'))
  if ((want.has('attached_folder') || want.has('folders')) && f.attachedFolder) add(L('이 대화에 붙은 폴더', 'Folder attached to this chat'), `${f.attachedFolder.name}${f.attachedFolder.canChange ? L(' (변경 제안 가능 → folder: attached)', ' (changes can be proposed → folder: attached)') : L(' (보기만)', ' (view only)')}`)
  if (want.has('processes')) add(L('프로세스(id 이름)', 'Processes (id name)'), f.processes.length ? f.processes.map((p) => `${p.id} ${p.name}${detail && p.startKeys?.length ? L(` (첫 단계 입력: ${p.startKeys.join(', ')})`, ` (first-step inputs: ${p.startKeys.join(', ')})`) : ''}`).join(' / ') : L('없음', 'none'))
  if (want.has('improvable')) add(L('실행 기록이 있는 프로세스(id 이름)', 'Processes with a run history (id name)'), f.improvable.length ? f.improvable.map((p) => `${p.id} ${p.name}`).join(' / ') : L('없음', 'none'))
  if (want.has('team') || want.has('members')) add(L('팀원(이름 · 역할)', 'Teammates (name · role)'), f.team.length ? f.team.map((m) => `${m.name}${m.roles?.length ? ` · ${m.roles.join(', ')}` : ''}`).join(' / ') : L('없음', 'none'))
  if ((want.has('agent_skills') || want.has('mission_skills')) && f.agentSkills.length) add(L('에이전트 스킬(에이전트에 넘기면 씀)', 'Agent skills (used when handed to the agent)'), f.agentSkills.map((k) => `${k.name} — ${k.description}`).join(' / '))
  if ((want.has('my_skills') || want.has('mission_skills')) && f.mySkills.length) add(L('내 스킬(공유 전, 에이전트가 씀)', 'My skills (not shared yet, used by the agent)'), f.mySkills.map((k) => k.name).join(', '))
  return lines
}
// the turn's own state, shown at both stages
export function turnLines(f) {
  const lines = []
  if (f.files.length) lines.push(`- ${L('이 메시지에 첨부된 파일', 'Files attached to this message')}: ${f.files.map((x) => x.name).join(', ')}`)
  if (f.openDoc) lines.push(`- ${L('채팅 옆에 열린 문서', 'Document open next to the chat')}: ${f.openDoc.title} · ${f.openDoc.file}`)
  if (f.generation) lines.push(`- ${L('프로세스 설계 진행 중', 'A process is being designed')}`)
  return lines
}
