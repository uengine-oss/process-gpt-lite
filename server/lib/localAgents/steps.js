// A process step run by the assignee's own CLI agent (lib/localAgents — design docs/local-agents/design.md). This file joins the
// queue (jobs.js) to the process: which work items are local, whose desktop runs them, what the desktop gets (the instance's work
// folder over git, a token for it, the prompt), what the result does to the step, the server agent when the desktop is off, and the
// instance's conversation, which follows the run live.
//   the worker   — work items with agent_orch pgpt-pro-local (the map engine and the snapshots write it when the activity names a local
//                  agent) are claimed like the business agent's (fetch_pending_task), pass the run mode's gate, and become jobs
//   prepare      — the instance's work folder (made when the instance has none), its line inst/<id> (what the earlier steps left), a
//                  branch of its own pgpt-agent/local-…, the folder's git token (gitHttp.js: this folder, push to pgpt-agent/* only)
//   complete     — the pushed branch is a variation of the folder and goes onto the instance line (line.js advanceLine), and the step
//                  gets its result the business agent's way (run.js finishStep): done, or a draft the person checks and hands in
//   delegate     — the server agent: the business agent here, or deepagents · cli-agent (their workers take the item)
//   note         — one card in the instance's conversation (the assignee's, and the case owner's) that follows the job
import { config } from '../../config.js'
import { q, admin } from '../supa.js'
import { emit } from '../bus.js'
import { addMessage, updateMessage } from '../store.js'
import { L, langOf, withLang, langInstruction } from '../lang.js'
import { withTenant, servesTenant, forEachTenant } from '../tenant.js'
import * as A from './agents.js'
import * as J from './jobs.js'
import * as H from './hub.js'
import * as KH from './knowhow.js'
import * as R from './relay.js'

const T = () => config.tenantId
const CONSUMER = `pgpt-pro-local-${process.pid}`
const LABEL = (a) => L(A.LABEL, A.LABEL_EN)[a] || a
const todoOf = async (id) => (await q('select * from todolist where id::text=$1', [String(id)]))[0] || null
const caseOwnerOf = async (instId) => {
  const [c] = await q(`select started_by::text as started_by from pro_po_cases where tenant_id=$1 and $2 = any(instances) limit 1`, [T(), String(instId)]).catch(() => [])
  return c?.started_by || null
}

// ---------- which step, whose desktop ----------
export async function settingsFor(row) {
  const own = A.normalize(row?.agent_config?.local)
  if (own) return own
  const { actOf } = await import('../ontology/run.js')
  return A.normalize((await actOf(row).catch(() => ({})))?.localAgent)
}

// the person among the work item's assignees (not an agent; an e-mail is read as that person), else the case's owner, else the
// instance's first person
export async function assigneeFor(row) {
  const ids = String(row.user_id || '').split(',').map((x) => x.trim()).filter(Boolean)
  const agents = new Set(ids.length ? (await q(`select id::text as id from users where is_agent and id::text = any($1)`, [ids]).catch(() => [])).map((r) => r.id) : [])
  const mails = ids.filter((x) => x.includes('@')).map((x) => x.toLowerCase())
  const emails = new Map(mails.length ? (await q(`select lower(email) as email, user_id::text as id from pro_profile where lower(email) = any($1)`, [mails])).map((r) => [r.email, r.id]) : [])
  const who = A.assigneeOf(row.user_id, { agents, emails })
  if (who) return who
  const inst = row.root_proc_inst_id || row.proc_inst_id
  return (await caseOwnerOf(inst)) || (await (await import('../mining/worker.js')).ownerOf(row).catch(() => null))
}

// what of the gate a job keeps (finishStep · holdForSend read these)
const slim = (g = {}) => ({ act: g.act || 'run', why: g.why || [], ...(g.draftFirst ? { draftFirst: true } : {}), ...(g.stepId ? { stepId: g.stepId } : {}), ...(g.caseId ? { caseId: g.caseId } : {}) })

// (tests replace gate: the step's gate — runmode.gateStep: wait for a person · skip · run, draft first)
export const deps = { gate: async (row) => (await import('../ontology/runmode.js')).gateStep(row) }

// a claimed work item → its job (null: the gate holds it, or it is not a local step after all)
export async function take(row, { gate: given = null } = {}) {
  // the gate first, whoever runs it: it may hold the step for a person (hitl) or want a draft first
  const gate = given || await deps.gate(row).catch((e) => { console.warn('[local-agents] gate', e.message); return { act: 'run' } })
  if (gate.act === 'wait' || gate.act === 'skip') return null
  const s = await settingsFor(row)
  if (!s) {
    // (an activity whose local setting was removed meanwhile): the business agent, as before — with what the gate said
    console.warn(`[local-agents] ${row.activity_name}: no local agent set — the business agent runs it`)
    await runOnServer.fn(row, slim(gate))
    return null
  }
  const userId = await assigneeFor(row)
  if (!userId) {
    await failRow(row, 'no person to run this step for', L('이 단계를 맡은 사람을 찾지 못했어요', 'Nobody was found to run this step for'))
    return null
  }
  await q(`update todolist set agent_config = coalesce(agent_config, '{}'::jsonb) || $2 where id=$1`, [row.id, { local: s }])
  const [pp] = await q('select name, email from pro_profile where user_id::text=$1', [String(userId)]).catch(() => [])
  return J.enqueue({ todoId: row.id, instId: row.root_proc_inst_id || row.proc_inst_id, activity: row.activity_name, userId, personName: pp?.name || pp?.email || '', ...s,
    mode: String(row.agent_mode || '').toUpperCase() === 'DRAFT' ? 'draft' : 'complete', gate: slim(gate) })
}

// ---------- what the desktop gets ----------
async function personOf(userId) {
  const [p] = await q('select name, email from pro_profile where user_id::text=$1', [String(userId)])
  return { id: String(userId), name: p?.name || p?.email || '', email: p?.email || '' }
}
const gitPublic = () => String(process.env.PRO_GIT_PUBLIC_URL || '').trim().replace(/\/+$/, '')

// link: the desktop it goes to — its folder tokens are that device's for this job (the public git path takes only those)
export async function prepare(job, link = null) {
  const row = await todoOf(job.todo_id)
  if (!row) throw new Error('the work item is gone')
  const { actOf } = await import('../ontology/run.js')
  const act = await actOf(row).catch(() => ({}))
  const W = await import('../mailWork.js')
  const S = await import('../folders/service.js')
  const G = await import('../folders/git.js')
  const { mintToken } = await import('../folders/gitHttp.js')
  const inst = job.proc_inst_id
  const [i] = await q('select proc_inst_name from bpm_proc_inst where proc_inst_id=$1', [inst]).catch(() => [])
  const instName = i?.proc_inst_name || inst
  // the instance's work folder (a mail made it, or it is made now — owned by the case's owner, else the assignee)
  let folder = await W.workFolderOf(inst)
  if (!folder) folder = await W.ensureWorkFolder((await caseOwnerOf(inst)) || job.user_id, { instId: inst, name: instName })
  if (folder.kind === 'linked') throw new Error('a linked folder is not served over git')
  // (what the instance's finished steps left is recorded onto the line first: stepContext)
  const ctx = await W.stepContext(inst).catch((e) => { console.warn('[local-agents] work folder', e.message); return null })
  folder = await S.folderById(folder.id)
  const work = folder.settings?.work || {}
  const line = work.line || W.lineOf(inst)
  const base = await G.branchExists(folder.repo_path, line) ? line : folder.default_branch
  const dirs = W.dirsOf(work)
  const n = W.nextNumber((await G.lsTree(folder.repo_path, base)).map((x) => x.path), dirs.outputs)
  const out = `${dirs.outputs}/${W.pad(n)}_${W.safeName(job.activity_name, 40, L('단계', 'step'))}`
  const person = await personOf(job.user_id)
  const lang = await langOf(job.user_id).catch(() => 'ko')
  // the skills the server agent would get for this activity, and the person's own private ones — each its skill folder, read only
  const skills = await skillsFor(job, act, link).catch((e) => { console.warn('[local-agents] skills', e.message); return [] })
  const prompt = await withLang(lang, () => promptFor({ job, act, instName, person, ctx, out, skills }))
  // the run was going when its desktop app went away (a restart): the same CLI session goes on, on the same run branch
  const resume = job.session_id && job.started_at && job.run_branch ? { sessionId: job.session_id } : null
  return {
    todoId: String(job.todo_id), instId: inst, instName, activity: job.activity_name, agent: job.agent, label: A.LABEL[job.agent] || job.agent, mode: job.mode,
    prompt, outDir: out, resultFile: dirs.result, person, lang, skills,
    git: {
      path: `/api/local-git/${folder.id}.git`, url: gitPublic() ? `${gitPublic()}/api/local-git/${folder.id}.git` : null,
      // (pushes only to this job's own branches; read and push only while this job is this device's — devices.js gitAccess)
      token: mintToken({ tenant: T(), folderId: folder.id, push: `pgpt-agent/local-${String(job.id).slice(0, 8)}-`, ...deviceScope(job, link) }),
      line, base, branch: resume ? job.run_branch : `pgpt-agent/local-${String(job.id).slice(0, 8)}-${Date.now().toString(36)}`,
      folder: { id: folder.id, slug: folder.slug, name: folder.name },
    },
    ...(resume ? { resume } : {}),
  }
}

// The skills of a step: the activity's own (its task definition's skills) and those of the agent the activity names (agent_skills) — the
// set the server agent would load for it — and the person's own private skills (their runs follow them, folders/skills.js). Only skills
// that are files (a skill folder, made from its installed or private copy the first time); Lite's own step skills (doc-draft …) are not.
// Someone else's private skill is never sent. Each goes as its folder over git, with a token that may only read.
export async function skillNames(act = {}, userId) {
  const names = new Set((act.skills || []).map(String))
  if (act.agent) for (const r of await q(`select skill_name from agent_skills where tenant_id=$1 and user_id::text=$2`, [T(), String(act.agent)]).catch(() => [])) names.add(r.skill_name)
  const own = (await q(`select skill_name from pro_skill_visibility where tenant_id=$1 and visibility='private' and author_id::text=$2`, [T(), String(userId)]).catch(() => [])).map((r) => r.skill_name)
  return { shared: [...names], own }
}
// a desktop job's folder token: that device, that job (the public path /api/local-git takes only these), a day at most
const deviceScope = (job, link) => (link?.id ? { scope: 'device', device: link.id, job: job.id, hours: Math.min(24, Number(config.gitTokenHours) || 24) } : {})

export async function skillsFor(job, act, link = null) {
  const SK = await import('../folders/skills.js')
  const { mintToken } = await import('../folders/gitHttp.js')
  const { shared, own } = await skillNames(act, job.user_id)
  const out = []
  for (const name of [...new Set([...shared, ...own])]) {
    const vis = await SK.visibility(name).catch(() => null)
    if (vis?.visibility === 'private' && String(vis.author_id) !== String(job.user_id)) continue
    const folder = (await SK.skillFolder(name)) || (vis ? await SK.ensureSkillFolder(name).catch(() => null) : null)
    if (!folder) continue
    out.push({ name, own: own.includes(name), folder: { id: folder.id, slug: folder.slug }, path: `/api/local-git/${folder.id}.git`,
      url: gitPublic() ? `${gitPublic()}/api/local-git/${folder.id}.git` : null, token: mintToken({ tenant: T(), folderId: folder.id, push: '', ...deviceScope(job, link) }) })
  }
  return out
}

async function promptFor({ job, act, instName, person, ctx, out, skills = [] }) {
  let tpl = ''
  try { tpl = await (await import('../ontology/discovery.js')).prompt('local-step') } catch { /* the bundled skill has it */ }
  const fill = (s, v) => String(s || '').replace(/\{(\w+)\}/g, (_, k) => v[k] ?? '')
  const definition = [act.description, act.instruction].filter(Boolean).join('\n').trim() || L(`「${job.activity_name}」 단계의 일을 하세요.`, `Do the work of the step "${job.activity_name}".`)
  const checkpoints = act.checkpoints?.length ? `\n${L('[점검 항목] 만든 결과는 다음을 모두 지켜야 해요', '[Checkpoints] What you make must keep all of these')}:\n${act.checkpoints.map((c) => `- ${c}`).join('\n')}\n` : ''
  const mode = job.mode === 'draft'
    ? L('- 이 결과는 담당자가 확인하고 고쳐서 내는 초안이에요. 담당자가 판단할 것(금액 확정 · 발송 · 약속)은 정하지 말고 초안으로 두세요.', '- This is a draft the assignee checks and hands in. Leave what the assignee decides (final amounts, sending, promises) as a draft.')
    : ''
  const outputs = (act.outputs || []).map((o) => (typeof o === 'string' ? o : [o.name, o.format, o.template ? L(`양식 ${o.template}`, `form ${o.template}`) : ''].filter(Boolean).join(' · '))).filter(Boolean)
  const io = outputs.length ? `\n${L('[내놓는 것]', '[What it hands over]')}\n${outputs.map((o) => `- ${o}`).join('\n')}\n` : ''
  const skillText = skills.length
    ? L(`[스킬] 이 일에 쓰는 회사 스킬이 작업 폴더에 있어요: ${skills.map((k) => `「${k.name}」`).join(' · ')}. 해당하는 일이면 그 스킬(SKILL.md)의 방법대로 하세요.`,
      `[Skills] The company skills for this work are in the work folder: ${skills.map((k) => `"${k.name}"`).join(' · ')}. Where one applies, do it its way (its SKILL.md).`)
    : ''
  const text = fill(tpl || '「{step}」 단계\n{definition}\n{work}\n결과는 {out}/ 에 두세요.', {
    inst: instName, step: job.activity_name, person: person.name || L('담당자', 'the assignee'), agent: A.LABEL[job.agent] || job.agent,
    definition, checkpoints: `${checkpoints}${io}`, work: ctx?.note?.trim() || L('(아직 앞 단계 결과가 없어요)', '(no earlier results yet)'), out, mode, skills: skillText,
  })
  return `${text.trim()}${langInstruction()}`
}

// ---------- the result ----------
export async function complete(job, result) {
  const row = await todoOf(job.todo_id)
  if (!row) throw new Error('the work item is gone')
  const { actOf, finishStep } = await import('../ontology/run.js')
  const act = await actOf(row).catch(() => ({}))
  const S = await import('../folders/service.js')
  const G = await import('../folders/git.js')
  const { advanceLine } = await import('../folders/line.js')
  const label = A.LABEL[job.agent] || job.agent
  let head = null
  let v = null
  const folder = job.folder_id ? await S.folderById(job.folder_id) : null
  if (folder && result.branch && result.pushed) {
    // (only this job's own branch — what its token could push; never another run's branch the desktop names)
    if (!result.branch.startsWith(`pgpt-agent/local-${String(job.id).slice(0, 8)}-`) || !(await G.branchExists(folder.repo_path, result.branch))) throw new Error(`the branch ${result.branch} did not arrive`)
    const bhead = await G.head(folder.repo_path, `refs/heads/${result.branch}`)
    ;[v] = await q(`insert into pro_folder_variations (folder_id, branch, title, kind, status, base_commit, head_commit, holder_type, holder_id, holder_name, source)
                    values ($1,$2,$3,'run','ready',$4,$5,'agent',$6,$7,$8) on conflict (folder_id, branch) do update set head_commit=$5 returning *`,
    [folder.id, result.branch, job.activity_name || L('프로세스 단계', 'Process step'), await G.mergeBase(folder.repo_path, folder.default_branch, result.branch), bhead,
      `local:${job.agent}`, label, { label: job.activity_name, todo_id: String(job.todo_id), proc_inst_id: job.proc_inst_id, engine: `local:${job.agent}`, device: job.device_id, job: job.id }])
    head = await advanceLine(folder, job.line, bhead, { instId: job.proc_inst_id })
    import('../folders/indexer.js').then((x) => x.changeCard(folder, v)).catch(() => {})
  }
  const values = {
    result: result.summary || L(`${label}가 「${job.activity_name}」를 끝냈어요.`, `${label} finished "${job.activity_name}".`),
    agent: label,
    ...(v ? { branch: result.branch, files: result.files || [], folder_variation: { name: L(`작업 폴더의 변경안 · ${job.activity_name}`, `Work folder change · ${job.activity_name}`), folder: folder.slug, variation: v.id, branch: v.branch, url: `/folders/${folder.slug}/v/${v.id}` } } : {}),
  }
  await withLang(await langOf(job.user_id).catch(() => 'ko'), () => finishStep({ row, act, gate: job.gate || {}, values, owner: String(job.user_id), isDraft: job.mode === 'draft',
    who: L(`${label} (담당자의 컴퓨터)`, `${label} (the assignee's computer)`), checks: [] }))
  return { head }
}

// ---------- the server agent ----------
// (tests replace fn: the business agent calls a model)
export const runOnServer = {
  fn: async (row, gate, owner = null) => {
    const tenant = T()
    // outside the sweep: the business agent may take minutes
    setImmediate(() => withTenant(tenant, async () => {
      try { await (await import('../ontology/run.js')).runStep(row, gate, { owner }) } catch (e) {
        console.warn('[local-agents] server agent', row.activity_name, e.message)
        await failRow(row, e.message, null)
      }
    }))
  },
}
export async function delegate(job) {
  const row = await todoOf(job.todo_id)
  if (!row || ['DONE', 'CANCELLED', 'SUBMITTED'].includes(String(row.status))) return
  await q(`update todolist set agent_config = (coalesce(agent_config, '{}'::jsonb) - 'local') || $2 where id=$1`,
    [row.id, { local_delegated: { agent: job.agent, why: job.why, at: new Date().toISOString() } }])
  if (job.server_agent === 'onto') return runOnServer.fn({ ...row, agent_config: { ...(row.agent_config || {}) } }, job.gate || {}, String(job.user_id))
  // deepagents · cli-agent: their own worker takes the item (a cli-agent step gets the work folder on the line — mailWork.stepFolders)
  await q(`update todolist set agent_orch=$2, draft_status=null, consumer=null where id=$1`, [row.id, job.server_agent])
}

async function failRow(row, raw, friendly) {
  await q(`update todolist set draft_status='FAILED', consumer=null where id=$1`, [row.id])
  const { events } = await import('../mining/worker.js')
  await events([{ job_id: `local-${String(row.id).slice(0, 8)}`, todo_id: row.id, proc_inst_id: row.proc_inst_id, crew_type: A.ORCH, event_type: 'error',
    data: { raw_error: String(raw || '').slice(0, 800), ...(friendly ? { friendly } : {}) } }]).catch(() => {})
}
export async function fail(job, error) {
  const row = await todoOf(job.todo_id)
  if (row) await failRow(row, error, L(`담당자의 컴퓨터에서 ${A.LABEL[job.agent] || job.agent} 실행이 멈췄어요: ${String(error).slice(0, 160)}`, `The ${A.LABEL_EN[job.agent] || job.agent} run on the assignee's computer stopped: ${String(error).slice(0, 160)}`))
}

// a job whose step is closed (handed in by hand, moved, rewound): it does not run any more
export async function cancelled(job) {
  if (!['queued', 'offered', 'running'].includes(job.state)) return false
  const row = await todoOf(job.todo_id)
  return !row || ['DONE', 'CANCELLED', 'SUBMITTED'].includes(String(row.status)) || (row.agent_orch && row.agent_orch !== A.ORCH)
}

// ---------- who sees it, who suggests, who steers ----------
// sees and suggests: whoever can see the instance (processes.js canSeeInstance — its participants, the people of its steps, admins). Its
// live card is pushed to them (the person of the job, the case's owner, the instance's participants and the people of its other steps), on
// whatever screen they have it open — the desktop app, a browser, a phone. What they write is a suggested prompt: it stacks at the run's
// input and never goes to the CLI by itself (2026-11-24, the user's rule: 「그것을 입력버튼으로 실제 입력시키는 당사자는 해당 cli를 가진 사람만」).
// steers (puts a suggestion, or their own words, into the CLI): only the worker — the person whose computer runs it.
// hands a waiting run to the server: the worker and who may edit the work.
// decides on what the run learned: knowhow.js mayDecide.
export async function viewersOf(job) {
  const inst = String(job.proc_inst_id)
  const [i] = await q('select participants from bpm_proc_inst where proc_inst_id=$1', [inst]).catch(() => [])
  const rows = await q(`select user_id from todolist where proc_inst_id=$1 or root_proc_inst_id=$1`, [inst]).catch(() => [])
  const ids = [String(job.user_id), await caseOwnerOf(inst), ...((i?.participants || []).map(String)), ...rows.flatMap((r) => String(r.user_id || '').split(',').map((x) => x.trim()))]
  const uuids = [...new Set(ids.filter((x) => /^[0-9a-f-]{36}$/i.test(x || '')))]
  if (!uuids.length) return []
  // (not the agents among them)
  const agents = new Set((await q(`select id::text as id from users where is_agent and id::text = any($1)`, [uuids]).catch(() => [])).map((r) => r.id))
  return uuids.filter((u) => !agents.has(u))
}
export async function canSee(user, instId) {
  const { canSeeInstance } = await import('../processes.js')
  return canSeeInstance(instId, user)
}
export const isWorker = (user, job) => String(job.user_id) === String(user.id)
export async function maySteer(user, job) { return isWorker(user, job) }
export async function mayDelegate(user, job) { return isWorker(user, job) || editRights(user, job) }
export async function editRights(user, job) {
  if ((await caseOwnerOf(job.proc_inst_id)) === String(user.id)) return true
  const f = job.folder_id ? (await import('../folders/service.js')).folderById(job.folder_id) : (await import('../mailWork.js')).workFolderOf(job.proc_inst_id)
  const folder = await f.catch(() => null)
  if (!folder) return false
  const S = await import('../folders/service.js')
  const role = await S.roleOf(folder, user).catch(() => null)
  return !!role && S.RANK[role] >= S.RANK.editor
}

// ---------- the card ----------
const hhmm = (d) => new Date(d).toLocaleTimeString(L('ko-KR', 'en-US'), { hour: 'numeric', minute: '2-digit', timeZone: process.env.PRO_TZ || 'Asia/Seoul' })
export function stateText(job, { device = '' } = {}) {
  const a = LABEL(job.agent)
  const until = job.wait_minutes ? new Date(new Date(job.created_at).getTime() + job.wait_minutes * 60_000) : null
  const server = LABEL(job.server_agent)
  switch (job.state) {
    case 'queued':
      if (job.why === 'busy') return L(`담당자의 PC 앱이 다른 일을 하는 중 — 차례가 오면 ${a}(으)로 시작해요`, `The assignee's desktop app is busy — ${a} starts this when its turn comes`)
      return L(`PC 앱이 켜지면 시작 — 담당자의 데스크톱이 꺼져 있어 기다리는 중이에요${until ? `. ${hhmm(until)}까지 켜지지 않으면 ${server}에게 맡겨요` : ''}`,
        `Starts when the desktop app is on — waiting: the assignee's desktop is off${until ? `. Handed to the ${server} if it is not on by ${hhmm(until)}` : ''}`)
    case 'offered': return L(`담당자의 데스크톱${device ? `(${device})` : ''}에 보냈어요 — 시작을 기다려요`, `Sent to the assignee's desktop${device ? ` (${device})` : ''} — waiting for it to start`)
    case 'running': return job.why === 'link-lost'
      ? L(`데스크톱 연결이 끊겼어요 — ${a}는 계속 실행 중일 수 있어요. 다시 연결되면 이어서 알려요`, `The desktop's link dropped — ${a} may still be running; it reports when it is back`)
      : L(`로컬 에이전트 실행 중 · ${a}${device ? ` (${device})` : ''}`, `Local agent running · ${a}${device ? ` (${device})` : ''}`)
    case 'done': return L(`${a}가 끝냈어요 — 결과를 이 일의 작업 폴더에 넣었어요`, `${a} finished — the result is in this work's folder`)
    case 'failed': return L(`로컬 실행이 멈췄어요: ${String(job.error || '').slice(0, 160)}`, `The local run stopped: ${String(job.error || '').slice(0, 160)}`)
    case 'cancelled': return L('단계가 닫혀 로컬 실행을 멈췄어요', 'The step was closed, so the local run stopped')
    case 'delegated': return ({
      offline: L(`담당자의 데스크톱이 꺼져 있어 ${server}에게 맡겼어요`, `The assignee's desktop is off, so it went to the ${server}`),
      timeout: L(`${job.wait_minutes}분을 기다려도 데스크톱이 켜지지 않아 ${server}에게 맡겼어요`, `The desktop was not on after ${job.wait_minutes} minutes, so it went to the ${server}`),
      declined: L(`담당자가 이번 로컬 실행을 하지 않기로 해 ${server}에게 맡겼어요`, `The assignee declined this local run, so it went to the ${server}`),
      disabled: L(`담당자의 데스크톱에서 로컬 실행이 꺼져 있어 ${server}에게 맡겼어요`, `Local runs are off on the assignee's desktop, so it went to the ${server}`),
      unable: L(`담당자의 데스크톱에 ${a}가 없어 ${server}에게 맡겼어요`, `${a} is not on the assignee's desktop, so it went to the ${server}`),
      manual: L(`기다리지 않고 ${server}에게 맡겼어요`, `Handed to the ${server} without waiting`),
    }[job.why] || L(`${server}에게 맡겼어요`, `Handed to the ${server}`))
    default: return ''
  }
}
const STEER_WHY = () => ({ ended: L('실행이 먼저 끝나 반영하지 못했어요', 'The run ended before it could take it'), failed: L('실행이 멈춰 반영하지 못했어요', 'The run stopped before it could take it'),
  cancelled: L('실행을 멈춰 반영하지 못했어요', 'The run was stopped'), delegated: L('서버에 맡겨져 반영하지 못했어요', 'The step went to the server agent'),
  finishing: L('결과를 올리는 중이라 받지 못했어요', 'It was already handing in its result'), 'not-running': L('데스크톱에서 이 실행이 이미 끝났어요', 'The run was no longer on the desktop'), refused: L('데스크톱이 받지 않았어요', 'The desktop did not take it') })
export const steerState = (s) => (s.applied ? 'applied' : s.failed ? 'failed' : s.received ? 'received' : s.sent ? 'sent' : 'pending')

const deviceName = (job) => (job.device_id ? H.linkOf(T(), String(job.device_id))?.name : '') || job.device_name || ''
// the card (Message.vue local_run, the instance page, the Home card); who: the person looking (what they may do with it)
export function cardOf(job, { canSteer = null, canDelegate = null, worker = false, decide = null } = {}) {
  const live = ['running', 'offered'].includes(job.state)
  const why = STEER_WHY()
  const steers = (job.steers || []).map((s) => ({ id: s.id, text: s.text, name: s.name, from: s.from?.name || null, suggestionId: s.from?.suggestionId || null, at: s.at, state: steerState(s), sent: !!s.sent, received: !!s.received,
    applied: s.applied || null, failed: !!s.failed, reason: s.failed ? why[s.reason] || s.reason || '' : null }))
  return {
    jobId: job.id, todoId: String(job.todo_id), instId: job.proc_inst_id, activity: job.activity_name, agent: job.agent, label: A.LABEL[job.agent] || job.agent,
    person: job.person_name || '', device: deviceName(job) || null, state: job.state, why: job.why || null, text: stateText(job, { device: deviceName(job) }),
    steering: steers.some((s) => ['sent', 'received', 'pending'].includes(s.state)), lines: (job.lines || []).slice(-12), steers,
    files: job.result?.files?.slice(0, 20) || [], branch: job.result?.branch || null, mode: job.mode, offline: job.offline, serverAgent: job.server_agent,
    serverLabel: LABEL(job.server_agent),
    waitUntil: job.state === 'queued' && job.wait_minutes ? new Date(new Date(job.created_at).getTime() + job.wait_minutes * 60_000).toISOString() : null,
    createdAt: job.created_at, startedAt: job.started_at, finishedAt: job.finished_at,
    canSteer: canSteer == null ? live : !!canSteer && live, canDelegate: !!canDelegate && job.state === 'queued',
    // the participants' suggested prompts (waiting · used · dismissed) — only the worker puts one in; what the run learned
    suggestions: (job.suggestions || []).slice(-30).map((c) => ({ id: c.id, name: c.name, text: c.text, at: c.at, state: c.state || 'waiting', usedBy: c.usedBy || null,
      usedAt: c.usedAt || null, edited: !!c.edited, usedText: c.usedText || null, kind: c.kind || 'opinion', option: c.option ?? null })),
    // the run's terminal (the person's interactive CLI, relayed — relay.js): viewers open it with a ticket; only the worker types
    terminal: !!job.terminal,
    canSuggest: true, worker: !!worker, owner: job.person_name || '',
    knowhow: (job.knowhow || []).map((k) => KH.view(k, { canDecide: !!decide?.[k.kind] })),
  }
}
// what this person may do with a job
async function rights(user, job) {
  const steer = await maySteer(user, job).catch(() => false)
  const decide = {}
  for (const kind of new Set((job.knowhow || []).filter((k) => k.state === 'proposed').map((k) => k.kind))) decide[kind] = await KH.mayDecide(user, job, { kind }).catch(() => false)
  return { canSteer: steer, canDelegate: await mayDelegate(user, job).catch(() => false), worker: isWorker(user, job), decide }
}
export async function cardFor(user, job) { return cardOf(job, await rights(user, job)) }

// The job's card, pushed live: one card in the instance's conversation of its person and of the case's owner (kept current), and the
// card itself to everyone who can see the instance (the instance page and the Home card follow it — 'local_run', no reload)
const STATE_CHANGES = new Set(['waiting', 'busy', 'offered', 'running', 'done', 'failed', 'delegated', 'cancelled', 'link-lost'])
export async function note(job, what) {
  const owner = await caseOwnerOf(job.proc_inst_id)
  const users = [...new Set([String(job.user_id), owner].filter(Boolean))]
  if (what === 'link-lost') job = { ...job, why: 'link-lost' }
  const ids = { ...(job.message_ids || {}) }
  for (const u of users) {
    await withLang(await langOf(u).catch(() => 'ko'), async () => {
      const content = cardOf(job, await rights({ id: u }, job))
      const { instanceThread } = await import('../engine.js')
      if (ids[u]) await updateMessage(u, ids[u], content)
      else {
        const th = await instanceThread(u, job.proc_inst_id)
        const m = await addMessage(u, th, 'agent', 'local_run', content)
        ids[u] = m.id
      }
    })
  }
  if (JSON.stringify(ids) !== JSON.stringify(job.message_ids || {})) await q('update pro_local_jobs set message_ids=$2 where id=$1', [job.id, JSON.stringify(ids)])
  for (const u of await viewersOf(job)) {
    await withLang(await langOf(u).catch(() => 'ko'), async () => {
      emit(u, 'local_run', { instId: job.proc_inst_id, jobId: job.id, state: job.state, what, card: cardOf(job, await rights({ id: u }, job)) })
      if (STATE_CHANGES.has(what)) emit(u, 'process', { instId: job.proc_inst_id, type: 'changed' })
    })
  }
}

// ---------- steering ----------
// what the job's person (or someone who may steer it) types in the instance's conversation while the run goes is a steer, not a new turn
export async function runningJobOf(instId) {
  const [j] = await q(`select * from pro_local_jobs where tenant_id=$1 and proc_inst_id=$2 and state in ('running','offered') order by created_at desc limit 1`, [T(), String(instId)])
  return j || null
}
export async function steerFromThread(user, thread, text) {
  if (!thread || thread.kind !== 'process' || !thread.ref || !String(text || '').trim()) return null
  const job = await runningJobOf(thread.ref)
  if (!job || !(await maySteer(user, job))) return null
  await addMessage(user.id, thread.id, 'user', 'text', { text: String(text).slice(0, 4000) })
  const r = await J.steer(job, user, text)
  const a = LABEL(job.agent)
  await addMessage(user.id, thread.id, 'agent', 'chip', { icon: 'send', localSteer: r.steer.id,
    text: r.delivered ? L(`${a}에게 전했어요 — 실행을 멈추지 않고 반영해요`, `Passed to ${a} — it takes it without stopping the run`)
      : L(`데스크톱이 이어지면 ${a}에게 전할게요`, `${a} gets it as soon as the desktop is linked`) })
  return r
}
// 「서버에 맡기기」 on a waiting run: the activity's server agent takes it now
export async function delegateNow(user, job) {
  if (job.state !== 'queued') throw Object.assign(new Error(L('기다리는 실행만 서버에 맡길 수 있어요.', 'Only a waiting run can be handed to the server.')), { status: 409 })
  return J.delegate(job, 'manual')
}

// A suggested prompt for the run (anyone who sees the instance). The worker hears of it: a notification on their desktop (the runner) and a
// Home card; it waits in the run's stack for them.
export async function suggestOn(user, job, text, { kind = 'opinion', option = null } = {}) {
  const r = await J.suggest(job, user, text, { kind, option })
  if (!isWorker(user, job)) {
    const link = job.device_id ? H.linkOf(T(), String(job.device_id)) : null
    if (link) link.send({ type: 'suggestion', jobId: job.id, by: user.name || '', text: r.suggestion.text, kind: r.suggestion.kind })
    const { notifyInstance } = await import('../engine.js')
    await withLang(await langOf(String(job.user_id)).catch(() => 'ko'), () => notifyInstance(String(job.user_id), job.proc_inst_id, {
      type: 'local_suggestion', title: L(`${user.name || '참여자'}의 제안 · ${job.activity_name}`, `Suggestion from ${user.name || 'a participant'} · ${job.activity_name}`),
      text: r.suggestion.text.slice(0, 200) })).catch((e) => console.warn('[local-agents] suggestion notice', e.message))
  }
  return r
}
// The worker puts words into the CLI: their own, or a suggestion they loaded (as it was, or edited) — the steer says whose suggestion it
// was; the suggestion is used, and its writer hears so. Nobody else may (403).
export async function steerAs(user, job, text, suggestionId = null) {
  if (!isWorker(user, job)) throw Object.assign(new Error(L('입력은 그 CLI 를 가진 사람(실행하는 사람)만 해요. 제안으로 올리면 그 사람이 골라 입력해요.', 'Only the person whose CLI it is can put words into it. Suggest it: they pick it and put it in.')), { status: 403 })
  let s = null
  if (suggestionId) {
    s = (job.suggestions || []).find((x) => x.id === suggestionId)
    if (!s) throw Object.assign(new Error(L('그 제안을 찾지 못했어요.', 'That suggestion was not found.')), { status: 404 })
    if (s.state !== 'waiting') throw Object.assign(new Error(L('이미 입력했거나 버린 제안이에요.', 'That suggestion was already used or dropped.')), { status: 409 })
  }
  const out = await J.steer(job, user, text, s ? { from: { id: s.by, name: s.name, suggestionId: s.id } } : {})
  if (!s) return out
  const t = String(text || '').trim()
  const j = await J.markSuggestion(out.job, s.id, { state: 'used', steerId: out.steer.id, usedAt: new Date().toISOString(), usedBy: user.name || '', ...(t !== s.text ? { edited: true, usedText: t.slice(0, 2000) } : {}) })
  await note(j, 'suggestion')
  if (String(s.by) !== String(user.id)) {
    const { notifyInstance } = await import('../engine.js')
    await withLang(await langOf(String(s.by)).catch(() => 'ko'), () => notifyInstance(String(s.by), job.proc_inst_id, {
      type: 'local_suggestion_used', title: L(`제안이 입력됐어요 · ${job.activity_name}`, `Your suggestion went in · ${job.activity_name}`),
      text: L(`${user.name || '실행하는 사람'}이 ${t !== s.text ? '고쳐서 ' : ''}입력했어요: ${t.slice(0, 160)}`, `${user.name || 'The worker'} put it in${t !== s.text ? ' (edited)' : ''}: ${t.slice(0, 160)}`) })).catch(() => {})
  }
  return { ...out, job: j }
}
export async function dismissSuggestion(user, job, id) {
  if (!isWorker(user, job)) throw Object.assign(new Error(L('제안을 버리는 것은 그 CLI 를 가진 사람만 해요.', 'Only the person whose CLI it is can drop a suggestion.')), { status: 403 })
  const s = (job.suggestions || []).find((x) => x.id === id)
  if (!s) throw Object.assign(new Error(L('그 제안을 찾지 못했어요.', 'That suggestion was not found.')), { status: 404 })
  if (s.state !== 'waiting') throw Object.assign(new Error(L('이미 입력했거나 버린 제안이에요.', 'That suggestion was already used or dropped.')), { status: 409 })
  const j = await J.markSuggestion(job, id, { state: 'dismissed', dismissedAt: new Date().toISOString() })
  await note(j, 'suggestion')
  return j
}
// what the run learned: candidates (knowhow.js), decided by a person
export async function learned(job, raw) {
  const list = await KH.learn(job, raw)
  if (list.length) await note((await J.byId(job.id)) || job, 'knowhow')
}
export async function decideKnowhow(user, job, id, action) {
  const j = await KH.decide(user, job, id, action)
  await note(j, 'knowhow')
  return j
}

// the instance page: its local runs, as this person may use them
export async function instanceView(instId, user) {
  const jobs = await J.ofInstance(instId)
  return Promise.all(jobs.map((j) => cardFor(user, j)))
}
// Home: the runs that are on now (waiting, sent, running) of instances this person sees — one per instance, the newest
export async function activeFor(user) {
  const rows = await q(`select distinct on (j.proc_inst_id) j.* from pro_local_jobs j where j.tenant_id=$1 and j.state in ('queued','offered','running')
                        order by j.proc_inst_id, j.created_at desc limit 100`, [T()])
  const out = []
  for (const j of rows) if (String(j.user_id) === String(user.id) || await canSee(user, j.proc_inst_id).catch(() => false)) out.push(await cardFor(user, j))
  return out
}

// ---------- the worker ----------
let busy = false
async function claim() {
  if (busy) return
  busy = true
  try {
    for (let n = 0; n < 5; n++) {
      const { data, error } = await admin.rpc('fetch_pending_task', { p_agent_orch: A.ORCH, p_consumer: CONSUMER, p_limit: 1, p_env: 'dev' })
      if (error) throw new Error(error.message)
      const row = data?.[0]
      if (!row) return
      if (!servesTenant(row.tenant_id)) { await admin.from('todolist').update({ draft_status: null, consumer: null }).eq('id', row.id); return }
      console.log('[local-agents] claimed', row.id, row.activity_name)
      await withTenant(row.tenant_id, () => take(row)).catch(async (e) => {
        console.warn('[local-agents] take', e.message)
        await withTenant(row.tenant_id, () => failRow(row, e.message, null)).catch(() => {})
      })
    }
  } catch (e) { console.warn('[local-agents] claim', e.message) } finally { busy = false }
}

let sweeping = false
// before sql/052 has been run on a database the sweep says so once and waits ten minutes, instead of a warning every 5 seconds
let missingUntil = 0
export async function sweepAll() {
  if (sweeping || Date.now() < missingUntil) return
  sweeping = true
  const missing = (e) => e?.code === '42P01' || /relation "pro_local_[a-z_]+" does not exist/.test(String(e?.message))
  try {
    await forEachTenant(() => J.sweep().catch((e) => {
      if (!missing(e)) throw e
      if (!missingUntil || Date.now() >= missingUntil) console.warn('[local-agents] tables missing (run sql/052_local_agents.sql) — sweep paused 10 min')
      missingUntil = Date.now() + 600_000
    }), 'local-agents')
  } catch (e) { console.warn('[local-agents] sweep', e.message) } finally { sweeping = false }
}

export function wire() {
  J.setHooks({ prepare, complete, delegate, fail, note, cancelled, learned })
  H.setHandlers({ online: J.onOnline, caps: J.onCaps, message: J.onMessage, offline: J.onOffline })
  // a step's run in the person's terminal (relay.js kind 'step', ref = the job): opened only by the desktop the job was given to;
  // watched by whoever sees the instance; its last screen kept on the job
  R.registerKind('step', {
    open: async (link, ref) => { const j = await J.byId(ref); return !!j && String(j.user_id) === link.userId && String(j.device_id) === link.id },
    view: async (user, ref) => { const j = await J.byId(ref); return !!j && canSee(user, j.proc_inst_id) },
    opened: async (S) => { const [j] = await q('update pro_local_jobs set terminal=true, updated_at=now() where id=$1 returning *', [S.ref]); if (j) await note(j, 'terminal') },
    exit: async (S) => { await q('update pro_local_jobs set screen=$2, screen_size=$3 where id=$1', [S.ref, S.buf.slice(-64 * 1024), JSON.stringify({ cols: S.cols, rows: S.rows })]) },
    stored: async (ref) => { const j = await J.byId(ref); return j?.screen ? { buf: j.screen, cols: j.screen_size?.cols, rows: j.screen_size?.rows, agent: j.agent } : null },
  })
}

let started = false
export function startLocalAgents(server) {
  wire()
  if (server) { H.attach(server); R.attach(server) }
  if (started || process.env.PRO_LOCAL_AGENT_WORKER === '0') return
  started = true
  setInterval(claim, Number(process.env.PRO_LOCAL_AGENT_TICK_MS || 3000))
  setInterval(sweepAll, 5000)
  console.log(`[local-agents] polling agent_orch=${A.ORCH} as ${CONSUMER}`)
}
