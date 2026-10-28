// Skills as shared folders (스킬 공유). A skill's folder (kind 'skill') holds its files on main;
// changes are variations; a 반영 요청 is process-gpt's resource_pull_requests row; only the author
// (tenant_skills.owner_id / pro_skill_visibility.author_id) or the boss of an agent that uses the
// skill (pro_agent_owners × agent_skills) may merge.
// Visibility: a new skill is private — it is NOT installed as a tenant skill (so no one else's
// run can load or list it); the author's own runs get a copy at /workspace/.pro-skills/<uid>/<name>
// and are told to follow it. Sharing installs it (deepagents /skills/upload → tenant_skills), and
// after every merge the installed (or private) copy is brought in line with main.
// When the tenant has a git provider (tenant_git_config), process-gpt's own skill repository and PR
// routes hold the branches; that mode is detected and reported (see design.md) — locally there is
// none, so the folder's own git does the work.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { config } from '../../config.js'
import { q } from '../supa.js'
import { chat } from '../llm.js'
import { emit } from '../bus.js'
import * as G from './git.js'
import * as S from './service.js'
import { reindex } from './indexer.js'
import { runAgent } from './runner.js'
import { addMessage } from '../store.js'
import { PGPT_ROOT } from '../paths.js'
import { L, isEn, langOf } from '../lang.js'

const T = () => config.tenantId
const PGPT = PGPT_ROOT
const err = (status, message) => Object.assign(new Error(message), { status })
export const installedDir = (name) => path.join(PGPT, 'services/deepagents/skills', config.tenantId, 'local', name)
const privateRoot = (userId) => path.join(S.workspaceDir(), '.pro-skills', String(userId).slice(0, 8))
export const privateDir = (userId, name) => path.join(privateRoot(userId), name)
export const privateContainer = (userId, name) => `/workspace/.pro-skills/${String(userId).slice(0, 8)}/${name}`
const exists = (p) => fs.stat(p).then(() => true, () => false)
const run = (cmd, args, opts = {}) => new Promise((res, rej) => execFile(cmd, args, { maxBuffer: 64 << 20, ...opts }, (e, out) => (e ? rej(e) : res(out))))

export async function providerConfigured() {
  const [r] = await q('select count(*)::int as n from tenant_git_config where tenant_id=$1', [T()]).catch(() => [{ n: 0 }])
  return r.n > 0
}

// visibility of a skill: its row, or — for a skill installed before sharing existed — tenant-wide
export async function visibility(name) {
  const [v] = await q('select * from pro_skill_visibility where tenant_id=$1 and skill_name=$2', [T(), name])
  if (v) return v
  const [ts] = await q('select owner_id from tenant_skills where tenant_id=$1 and skill_name=$2', [T(), name])
  if (ts || await exists(installedDir(name))) return { skill_name: name, visibility: 'tenant', author_id: ts?.owner_id || null, legacy: true }
  return null
}
export async function bossesOf(name) {
  return (await q(`select distinct o.owner_user_id::text as id from agent_skills a join pro_agent_owners o on o.agent_user_id=a.user_id and o.tenant_id=a.tenant_id
                   where a.tenant_id=$1 and a.skill_name=$2`, [T(), name])).map((r) => r.id)
}
export async function canMerge(folder, user) {
  const name = folder.settings?.skill_name
  const v = await visibility(name)
  if (v?.author_id && String(v.author_id) === String(user.id)) return true
  return (await bossesOf(name)).includes(String(user.id))
}

// ---------- folders ----------
export async function skillFolder(name) {
  const [f] = await q(`select * from pro_folders where tenant_id=$1 and kind='skill' and settings->>'skill_name'=$2`, [T(), name])
  return f || null
}
const slugFor = (name) => `skill-${String(name).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || crypto.createHash('sha1').update(name).digest('hex').slice(0, 8)}`

// a skill's folder, made from its files the first time someone opens it (installed or private)
export async function ensureSkillFolder(name, { fromDir, author } = {}) {
  const found = await skillFolder(name)
  if (found) return found
  const vis = await visibility(name)
  const src = fromDir || (vis?.visibility === 'private' && vis.author_id ? privateDir(vis.author_id, name) : installedDir(name))
  if (!(await exists(src))) throw err(404, L(`'${name}' 스킬의 파일을 찾지 못했어요.`, `I couldn't find the files of the skill '${name}'.`))
  let slug = slugFor(name)
  for (let i = 2; await S.folderBySlug(slug); i++) slug = `${slugFor(name)}-${i}`
  const dir = path.join(S.foldersRoot(), slug)
  await fs.mkdir(dir, { recursive: true })
  await G.git(dir, ['init', '-q', '-b', 'main'])
  await fs.cp(src, dir, { recursive: true, filter: (p) => !/(^|\/)(\.git|__pycache__|\.DS_Store)(\/|$)/.test(p) })
  const authorId = author?.id || vis?.author_id || null
  const [u] = authorId ? await q('select username, email from users where id=$1 and tenant_id=$2', [authorId, T()]) : []
  await G.commitAll(dir, L(`스킬 '${name}' 가져오기`, `Import skill '${name}'`), { name: author?.name || u?.username || L('스킬 작성자', 'Skill author'), email: author?.email || u?.email })
  const md = await fs.readFile(path.join(dir, 'SKILL.md'), 'utf8').catch(() => '')
  const desc = (/^description:\s*(.+)$/m.exec(md)?.[1] || '').replace(/^["']|["']$/g, '').slice(0, 160)
  const [f] = await q(`insert into pro_folders (tenant_id, slug, name, description, kind, repo_path, settings, created_by)
                       values ($1,$2,$3,$4,'skill',$5,$6,$7) returning *`, [T(), slug, name, desc || L('스킬', 'Skill'), dir, { skill_name: name }, authorId])
  if (authorId) await q(`insert into pro_folder_members (folder_id, principal_type, principal_id, role, added_by) values ($1,'user',$2,'owner',$3) on conflict do nothing`, [f.id, String(authorId), authorId])
  if (vis && !vis.legacy) await q('update pro_skill_visibility set folder_id=$3 where tenant_id=$1 and skill_name=$2', [T(), name, f.id])
  await reindex(f).catch(() => {})
  return f
}

// the skills a person can see in the folder screen: shared ones, and their own private ones
export async function listSkills(user) {
  const names = new Set((await fs.readdir(path.dirname(installedDir('x'))).catch(() => [])).filter((n) => !n.startsWith('.')))
  for (const r of await q('select skill_name from tenant_skills where tenant_id=$1', [T()])) names.add(r.skill_name)
  const vis = await q('select * from pro_skill_visibility where tenant_id=$1', [T()])
  for (const v of vis) names.add(v.skill_name)
  const folders = new Map((await q(`select f.*, (select count(*) from pro_folder_variations v where v.folder_id=f.id and v.status in ('open','ready','conflicted'))::int as live
                                    from pro_folders f where tenant_id=$1 and kind='skill'`, [T()])).map((f) => [f.settings?.skill_name, f]))
  const owners = new Map((await q('select skill_name, owner_id from tenant_skills where tenant_id=$1', [T()])).map((r) => [r.skill_name, String(r.owner_id)]))
  const users = new Map((await q('select id::text, username from users where tenant_id=$1', [T()])).map((r) => [r.id, r.username]))
  const out = []
  for (const name of names) {
    const v = vis.find((x) => x.skill_name === name)
    const visibilityOf = v?.visibility || 'tenant'
    const author = v?.author_id ? String(v.author_id) : owners.get(name) || null
    if (visibilityOf === 'private' && author !== String(user.id)) continue
    const f = folders.get(name)
    out.push({ name, visibility: visibilityOf, author: author ? { id: author, name: users.get(author) || '' } : null, mine: author === String(user.id), folder: f ? { slug: f.slug, live: f.live, updated_at: f.updated_at, description: f.description } : null })
  }
  return out.sort((a, b) => (b.mine - a.mine) || String(b.folder?.updated_at || '').localeCompare(String(a.folder?.updated_at || '')) || a.name.localeCompare(b.name))
}

// ---------- a new skill (from skill-creator's draft) starts private ----------
export async function saveDraftPrivate(user, hostDir, name) {
  if (await visibility(name)) throw err(409, L(`'${name}' 이름의 스킬이 이미 있어요.`, `A skill named '${name}' already exists.`))
  await q(`insert into pro_skill_visibility (tenant_id, skill_name, visibility, author_id) values ($1,$2,'private',$3)`, [T(), name, user.id])
  const f = await ensureSkillFolder(name, { fromDir: hostDir, author: user })
  await materialize(f)
  return f
}

// main of the skill folder → where runs read it (installed tenant skill, or the author's copy)
export async function materialize(folder) {
  const name = folder.settings.skill_name
  const v = await visibility(name)
  const target = v?.visibility === 'private' ? privateDir(v.author_id, name) : installedDir(name)
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pro-skill-'))
  try {
    await run('sh', ['-c', `git -C "$1" archive --format=tar ${folder.default_branch} | tar -x -C "$2"`, 'sh', folder.repo_path, tmp])
    await fs.rm(target, { recursive: true, force: true })
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.cp(tmp, target, { recursive: true })
  } finally { fs.rm(tmp, { recursive: true, force: true }).catch(() => {}) }
  return target
}

// 전사에 공유: install as a tenant skill (deepagents' own upload: tenant_skills row, owner = author)
export async function share(folder, user, jwt) {
  const name = folder.settings.skill_name
  const v = await visibility(name)
  if (!v || String(v.author_id) !== String(user.id)) throw err(403, L('스킬을 공유할 수 있는 사람은 작성자예요.', 'Only the author can share the skill.'))
  if (v.visibility === 'tenant') return { shared: true }
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pro-skill-'))
  try {
    const dir = path.join(tmp, name)
    await fs.mkdir(dir)
    await run('sh', ['-c', `git -C "$1" archive --format=tar main | tar -x -C "$2"`, 'sh', folder.repo_path, dir])
    await run('zip', ['-qr', `${name}.zip`, name], { cwd: tmp })
    const form = new FormData()
    form.set('tenant_id', config.tenantId)
    form.set('owner_id', user.id)
    form.set('file', new Blob([await fs.readFile(path.join(tmp, `${name}.zip`))]), `${name}.zip`)
    const r = await fetch(`${config.deepagentsUrl}/skills/upload`, { method: 'POST', headers: { Authorization: `Bearer ${jwt}` }, body: form })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) throw err(r.status, j.error || L(`스킬을 설치하지 못했어요 (${r.status})`, `I couldn't install the skill (${r.status})`))
  } finally { fs.rm(tmp, { recursive: true, force: true }).catch(() => {}) }
  await q(`update pro_skill_visibility set visibility='tenant', shared_at=now(), shared_by=$3 where tenant_id=$1 and skill_name=$2`, [T(), name, user.id])
  await fs.rm(privateDir(user.id, name), { recursive: true, force: true }).catch(() => {})
  await materialize(folder)
  return { shared: true }
}
export async function keepPrivate(folder, user) {
  await q(`update pro_skill_visibility set asked_at=coalesce(asked_at, now()) where tenant_id=$1 and skill_name=$2 and author_id=$3`, [T(), folder.settings.skill_name, user.id])
}

// a private skill the author names in chat ("/이름" or the name itself): where their run reads it
export async function privateSkillFor(user, text) {
  const mine = await q(`select skill_name from pro_skill_visibility where tenant_id=$1 and author_id=$2 and visibility='private'`, [T(), user.id])
  const t = String(text || '')
  const hit = mine.find((r) => t.includes(`/${r.skill_name}`) || (/스킬|skill/i.test(t) && (t.includes(r.skill_name) || t.includes(r.skill_name.replace(/-/g, ' ')))))
  if (!hit) return null
  const f = await skillFolder(hit.skill_name)
  if (f) await materialize(f)
  return { name: hit.skill_name, path: `${privateContainer(user.id, hit.skill_name)}/SKILL.md`, folder: f }
}

// ---------- 반영 요청 (resource_pull_requests) ----------
async function prTriggerExists() {
  const [r] = await q(`select count(*)::int as n from pg_trigger where tgname='feedback_merge_request_notification_trigger'`)
  return r.n > 0
}
export async function prOf(v) {
  if (!v.source?.pr_id) return null
  const [pr] = await q('select * from resource_pull_requests where id=$1', [v.source.pr_id])
  return pr || null
}

export async function requestMerge(folder, v, user, { title, description } = {}) {
  const name = folder.settings.skill_name
  const existing = await prOf(v)
  if (existing && ['OPEN', 'CHANGES_REQUESTED', 'APPROVED'].includes(existing.status)) return existing
  const vis = await visibility(name)
  const reviewer = vis?.author_id || null
  const [pr] = await q(`insert into resource_pull_requests (tenant_id, resource_type, resource_id, branch_name, base_branch, title, description, status, requester_id, reviewer_id)
                        values ($1,'skill',$2,$3,$4,$5,$6,'OPEN',$7,$8) returning *`,
  [T(), name, v.branch, folder.default_branch, title || v.title, description || v.change_card?.summary || '', [user.id], reviewer])
  await q(`update pro_folder_variations set source = source || $2, updated_at=now() where id=$1`, [v.id, { pr_id: pr.id }])
  // the owner hears about it from process-gpt's own trigger when it is installed; bosses (and the
  // owner otherwise) get the same kind of notification from here
  const to = new Set(await bossesOf(name))
  if (reviewer && !(await prTriggerExists())) to.add(String(reviewer))
  to.delete(String(user.id))
  for (const id of to) {
    await q(`insert into notifications (id, user_id, type, title, description, url, is_checked, time_stamp, from_user_id, tenant_id)
             values (gen_random_uuid(),$1,'merge_request',$2,$3,$4,false,now(),$5,$6)`,
    // in the recipient's saved language
    (await langOf(id)) === 'en'
      ? [id, `[Skill] Merge request — ${name}`, `${user.name} asked you to merge their changes to the '${name}' skill: ${pr.title}`, `/folders/${folder.slug}/v/${v.id}`, user.email || user.id, T()]
      : [id, `[스킬] 반영 요청 — ${name}`, `${user.name} 님이 '${name}' 스킬에 바꾼 점을 반영해 달라고 요청했어요: ${pr.title}`, `/folders/${folder.slug}/v/${v.id}`, user.email || user.id, T()])
    emit(id, 'notifications', {})
  }
  return pr
}

// after a merge: the run copy follows main, the PRs close, contributors are credited
export async function afterMerge(folder, variationIds, user) {
  const name = folder.settings?.skill_name
  if (!name) return
  await materialize(folder).catch((e) => console.warn('[skills] materialize', e.message))
  const vis = await visibility(name)
  for (const id of variationIds) {
    const v = await S.variationById(id)
    const pr = await prOf(v)
    const requester = pr?.requester_id?.[0] || v.created_by || (v.holder_type === 'user' ? v.holder_id : null)
    // the review is done: its Home cards go away
    await q(`update notifications set is_checked=true where tenant_id=$1 and url=$2`, [T(), `/folders/${folder.slug}/v/${v.id}`])
    if (pr) {
      await q(`update resource_pull_requests set status='MERGED', merged_at=now() where id=$1`, [pr.id])
      await q(`insert into resource_pr_reviews (pr_id, tenant_id, reviewer_id, action, comment) values ($1,$2,$3,'APPROVED',$4)`, [pr.id, T(), user.id, L('병합', 'Merged')])
    }
    if (requester) {
      const [u] = await q('select username from users where id::text=$1 and tenant_id=$2', [String(requester), T()])
      const type = pr && String(requester) !== String(vis?.author_id) ? 'PROPOSAL_APPROVED' : 'MODIFIED'
      await q(`insert into skill_contributions (tenant_id, skill_name, contributor_user_id, contributor_name, contribution_type, source_proposal_id) values ($1,$2,$3,$4,$5,$6)`,
        [T(), name, String(requester), u?.username || v.holder_name || null, type, pr?.id || null])
    }
  }
}

export async function contributions(name) {
  return q(`select contributor_user_id as id, contributor_name as name, contribution_type as type, created_at from skill_contributions
            where tenant_id=$1 and skill_name=$2 order by created_at desc limit 50`, [T(), name])
}

// ---------- agent bosses ----------
export async function agentsUsing(name) {
  return q(`select a.user_id::text as id, u.username as name, u.agent_type, o.owner_user_id::text as boss_id, b.username as boss_name
            from agent_skills a join users u on u.id=a.user_id and u.tenant_id=a.tenant_id
            left join pro_agent_owners o on o.agent_user_id=a.user_id and o.tenant_id=a.tenant_id
            left join users b on b.id=o.owner_user_id and b.tenant_id=a.tenant_id
            where a.tenant_id=$1 and a.skill_name=$2 order by u.username`, [T(), name])
}
export async function setBoss(me, agentId, ownerId) {
  const [cur] = await q('select owner_user_id from pro_agent_owners where tenant_id=$1 and agent_user_id=$2', [T(), agentId])
  // the current boss hands it over; an agent without a boss can be claimed by anyone in the tenant
  if (cur && String(cur.owner_user_id) !== String(me.id)) throw err(403, L('이 에이전트의 담당자만 바꿀 수 있어요.', "Only this agent's owner can change it."))
  await q(`insert into pro_agent_owners (tenant_id, agent_user_id, owner_user_id, set_by) values ($1,$2,$3,$4)
           on conflict (tenant_id, agent_user_id) do update set owner_user_id=$3, set_by=$4, updated_at=now()`, [T(), agentId, ownerId, me.id])
}

// ---------- pre-merge verification ----------
// Local mode (no git provider): the same cases run with main's and the variation's skill, each
// graded. Cases come from the skill's saved scenarios when process-gpt has them, otherwise two are
// written from the variation's SKILL.md. With a provider, process-gpt's own verification route runs.
async function versionDir(folder, ref, room) {
  const dir = path.join(S.workspaceDir(), '.bpmn', room, 'skill', folder.settings.skill_name)
  await fs.rm(dir, { recursive: true, force: true })
  await fs.mkdir(dir, { recursive: true })
  await run('sh', ['-c', `git -C "$1" archive --format=tar "$3" | tar -x -C "$2"`, 'sh', folder.repo_path, dir, ref])
  return `/workspace/.bpmn/${room}/skill/${folder.settings.skill_name}`
}
async function writeCases(folder, v) {
  const md = (await G.show(folder.repo_path, v.branch, 'SKILL.md').catch(() => Buffer.from(''))).toString('utf8').slice(0, 6000)
  const changed = v.change_card?.summary || ''
  const m = await chat({ model: config.llm.fastModel, temperature: 0, json: true, messages: [
    { role: 'system', content: '스킬의 병합 전 회귀 검증 시나리오를 만든다. JSON 으로만: {"cases":[{"prompt":"사용자가 이 스킬에 줄 실제 요청 한 문장(필요한 입력값 포함)","expect":"좋은 결과가 갖춰야 할 점 1~2문장"}]} — 2개. 하나는 기존 핵심 동작, 하나는 이번 변경과 관련된 동작. 외부 계정·로그인이 필요 없는 요청으로.' },
    { role: 'user', content: `이번 변경: ${changed}\n\nSKILL.md:\n${md}` }] })
  return (JSON.parse(m.content).cases || []).slice(0, 2)
}
async function grade(c, output) {
  const m = await chat({ model: config.llm.fastModel, temperature: 0, json: true, messages: [
    { role: 'system', content: '스킬 실행 결과를 채점한다. 기대의 핵심(무엇을 담아야 하는지)을 갖췄으면 통과, 핵심이 빠졌거나 틀렸으면 실패. 사소한 문구·서식 차이나 덧붙인 설명은 실패 사유가 아니다. JSON 으로만: {"pass": true|false, "note": "판단 근거 한 문장(해요체)"}' },
    { role: 'user', content: `요청: ${c.prompt}\n기대: ${c.expect}\n\n결과:\n${String(output).slice(0, 6000)}` }] })
  const j = JSON.parse(m.content)
  return { pass: !!j.pass, note: String(j.note || '') }
}

// A verification runs in this server's memory: it has a deadline, and a row still 'running' long past
// it (the server restarted mid-run, or the agent never answered) is closed as failed when read.
const VERIFY_MS = () => Number(process.env.PRO_VERIFY_MS || 20 * 60000)

export async function verify(folder, v, user, jwt) {
  if (await providerConfigured()) {
    const pr = await prOf(v)
    if (!pr?.git_pr_number) throw err(409, L('git 공급자 모드에서는 process-gpt 의 병합 요청 번호가 있어야 검증할 수 있어요.', "In git provider mode a process-gpt merge request number is needed to verify."))
    const r = await fetch(`${config.deepagentsUrl}/skills/${encodeURIComponent(folder.settings.skill_name)}/pull-requests/${pr.git_pr_number}/verification?tenant_id=${config.tenantId}`,
      { method: 'POST', headers: { Authorization: `Bearer ${jwt}` } })
    return { mode: 'provider', ...(await r.json().catch(() => ({}))) }
  }
  const pr = await prOf(v)
  const [row] = await q(`insert into pro_skill_verifications (folder_id, variation_id, pr_id, mode, status, created_by) values ($1,$2,$3,'local','running',$4) returning *`,
    [folder.id, v.id, pr?.id || null, user.id])
  const stop = AbortSignal.timeout(VERIFY_MS())
  ;(async () => {
    try {
      const cases = await writeCases(folder, v)
      await q('update pro_skill_verifications set cases=$2 where id=$1', [row.id, JSON.stringify(cases)])
      const one = async (c, i, side) => {
        const room = `fold-verify-${row.id.slice(0, 8)}-${side}-${i}`
        const base = await versionDir(folder, side === 'base' ? folder.default_branch : v.branch, room)
        const out = await runAgent({ jwt, user, conversationId: room, signal: stop, message: L(`아래 요청을 이 스킬 문서의 절차대로 처리하세요: ${base}/SKILL.md (같은 폴더의 파일도 참고). 설치된 다른 스킬은 쓰지 마세요. 사람에게 되묻지 말고 필요한 값은 합리적으로 정해 끝까지 처리하세요.\n\n요청: ${c.prompt}`, `Handle the request below by following this skill document: ${base}/SKILL.md (see the files in the same folder too). Do not use other installed skills. Do not ask anyone back; choose any value you need sensibly and finish.\n\nRequest: ${c.prompt}`) })
        if (stop.aborted) throw stop.reason
        return { ...(await grade(c, out)), output: out.slice(0, 1500) }
      }
      const results = await Promise.all(cases.map(async (c, i) => {
        const [base, head] = await Promise.all([one(c, i, 'base'), one(c, i, 'head')])
        return { case: c, base, head }
      }))
      const summary = { cases: results.length, base_pass: results.filter((r) => r.base.pass).length, head_pass: results.filter((r) => r.head.pass).length, broken: results.filter((r) => r.base.pass && !r.head.pass).length }
      await q(`update pro_skill_verifications set status='succeeded', results=$2, summary=$3, updated_at=now() where id=$1`, [row.id, JSON.stringify(results), summary])
    } catch (e) {
      const why = stop.aborted || e?.name === 'TimeoutError' || e?.name === 'AbortError'
        ? L(`시간 초과 — ${Math.round(VERIFY_MS() / 60000)}분 안에 끝나지 않아 멈췄어요. 시나리오가 너무 크거나 에이전트가 응답하지 않았어요.`, `Timed out — stopped after ${Math.round(VERIFY_MS() / 60000)} min. The scenario was too big or the agent did not answer.`)
        : String(e?.message || e)
      await q(`update pro_skill_verifications set status='failed', error=$2, updated_at=now() where id=$1 and status='running'`, [row.id, why.slice(0, 400)])
    }
    emit(user.id, 'folders', { slug: folder.slug, variation: v.id })
  })()
  return row
}
export async function latestVerification(v) {
  const [r] = await q('select * from pro_skill_verifications where variation_id=$1 order by created_at desc limit 1', [v.id])
  if (r?.status === 'running' && Date.now() - new Date(r.created_at).getTime() > VERIFY_MS() + 2 * 60000) {
    const [x] = await q(`update pro_skill_verifications set status='failed', error=$2, updated_at=now() where id=$1 and status='running' returning *`,
      [r.id, L('검증이 중단됐어요(서버가 다시 시작됐거나 시간 안에 끝나지 않았어요). 다시 검증해 주세요.', 'The verification stopped (the server restarted or it ran out of time). Please verify again.')])
    return x || r
  }
  return r || null
}

// "전사에 공유하시겠어요?" once more, after the first successful use of a private skill
export async function askShareAfterUse(user, threadId, name) {
  const [v] = await q(`update pro_skill_visibility set asked_at=now() where tenant_id=$1 and skill_name=$2 and author_id=$3 and visibility='private' and asked_at is null returning *`, [T(), name, user.id])
  if (!v) return null
  const f = await skillFolder(name)
  return addMessage(user.id, threadId, 'agent', 'skill_share', { skill: name, folder: f?.slug, after: 'use' })
}
