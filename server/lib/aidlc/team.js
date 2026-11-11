// AI-DLC as a team (docs/robo-dlc/plan-team.md): who plays which AI-DLC role in a folder, the folder's
// Claude Code session, and the decisions people make in Lite — a choice in the session's selection
// prompt, or the answers a team agreed on written into a question file — typed into that session for
// them and kept in a ledger.
import { q } from '../supa.js'
import { config } from '../../config.js'
import { L, isEn } from '../lang.js'
import * as F from '../folders/service.js'
import * as R from './record.js'
import * as AS from './session.js'
import * as M from './metrics.js'
import { describeStage, roleName, ROLE_KEYS } from './stages.js'

const T = () => config.tenantId
const err = (status, message) => Object.assign(new Error(message), { status })

// ---------- roles ----------
// a person's display name (the profile name, else the account's)
const PEOPLE = 'left join users u on u.id = r.user_id and u.tenant_id = r.tenant_id left join pro_profile p on p.user_id = r.user_id'
const WHO = 'coalesce(p.name, u.username, u.email)'
export async function holders(folderId, roleKey) {
  const rows = await q(`select r.user_id, ${WHO} as name from pro_aidlc_roles r ${PEOPLE}
                        where r.tenant_id=$1 and r.folder_id=$2 and r.role_key=$3 order by r.created_at`, [T(), folderId, roleKey])
  return rows.map((x) => ({ id: x.user_id, name: x.name }))
}
export async function roles(slug, user) {
  const { folder } = await F.access(R.safeName(slug), user, 'viewer')
  const rows = await q(`select r.role_key, r.user_id, ${WHO} as name from pro_aidlc_roles r ${PEOPLE}
                        where r.tenant_id=$1 and r.folder_id=$2 order by r.created_at`, [T(), folder.id])
  return ROLE_KEYS.map((k) => ({ roleKey: k, role: roleName(k), people: rows.filter((x) => x.role_key === k).map((x) => ({ id: x.user_id, name: x.name })) }))
}
// the folder's owners and editors set the roles; only its members can be given one
export async function setRole(slug, user, { roleKey, userIds = [] }) {
  const { folder } = await F.access(R.safeName(slug), user, 'editor')
  if (!ROLE_KEYS.includes(roleKey)) throw err(400, 'unknown role')
  for (const id of userIds) if (!(await F.roleOf(folder, { id }))) throw err(400, 'not a member of the folder')
  await q('delete from pro_aidlc_roles where tenant_id=$1 and folder_id=$2 and role_key=$3', [T(), folder.id, roleKey])
  for (const id of [...new Set(userIds)]) await q('insert into pro_aidlc_roles(tenant_id,folder_id,role_key,user_id) values ($1,$2,$3,$4) on conflict do nothing', [T(), folder.id, roleKey, id])
  return roles(slug, user)
}

// ---------- where the work is ----------
// the intent being worked on: the engine's active intent, else the newest one not complete
export async function currentIntent(root) {
  const list = (await R.listIntents(root)).filter((i) => !i.archived)
  if (!list.length) return null
  const active = await import('node:fs/promises').then((fs) => fs.readFile(`${root}/aidlc/spaces/${list[0].space}/intents/active-intent`, 'utf8')).then((s) => s.trim(), () => '')
  const hit = list.find((i) => i.dirName === active || i.slug === active) || list.filter((i) => i.status !== 'complete').at(-1) || list.at(-1)
  const { dir } = await R.intentDir(root, hit.space, hit.slug)
  const state = await R.readState(dir)
  let stage = describeStage(state.currentStage)
  // construction runs unit by unit: the stage is the unit's (the code plan is the developer's)
  const unit = stage?.phase === 'construction' ? M.unitNow(await R.readAudit(dir)) : null
  if (unit) stage = describeStage(unit.stage)
  return { ...hit, dir, state, stage, unit }
}

// a prompt read off the session screen, in words a person reads on a card
export function promptKind(choice) {
  const labels = choice.options.map((o) => o.label).join(' | ')
  if (/^Approve\b/m.test(choice.options.map((o) => o.label).join('\n'))) return 'approval'
  if (/Looks correct/i.test(labels)) return 'summary'
  if (/Guide me|edit the file/i.test(labels)) return 'answer-mode'
  if (/Do you want to proceed|don't ask again/i.test(`${choice.question} ${labels}`)) return 'permission'
  return 'choice'
}
export const promptTitle = (kind, stageName) => ({
  approval: L(`${stageName} 승인`, `Approve ${stageName}`),
  summary: L(`${stageName} 요약 확인`, `Confirm the ${stageName} summary`),
  'answer-mode': L(`${stageName} 질문에 답하는 방식`, `How to answer the ${stageName} questions`),
  permission: L('Claude Code 가 권한을 묻고 있어요', 'Claude Code asks for permission'),
  choice: L(`${stageName} — 결정이 필요해요`, `${stageName} — a decision is needed`),
}[kind])

// the role a wait belongs to: the stage's, except a tool permission while code is written — the developer's
export const waitRole = (stage, choice) => (choice && promptKind(choice) === 'permission' && stage?.phase === 'construction' ? 'developer' : stage?.roleKey || null)

// who decides a wait: the role's people; with nobody in the role, the folder's owners
export async function deciders(folder, roleKey) {
  const people = roleKey ? await holders(folder.id, roleKey) : []
  if (people.length) return people
  return (await F.members(folder.id)).filter((m) => m.type === 'user' && m.role === 'owner' && !m.is_agent).map((m) => ({ id: m.id, name: m.name }))
}
async function mayDecide(folder, user, roleKey) {
  const role = await F.roleOf(folder, user)
  if (role && F.RANK[role] >= F.RANK.editor) return true
  return roleKey ? (await holders(folder.id, roleKey)).some((p) => p.id === user.id) : false
}

// ---------- the session ----------
const nameOf = (folder) => AS.sessionName(T(), folder.slug)
export async function sessionInfo(slug, user) {
  const { folder, role } = await F.access(R.safeName(slug), user, 'viewer')
  const name = nameOf(folder)
  const running = await AS.has(name)
  const choice = running ? AS.parseChoice(await AS.screen(name).catch(() => '')) : null
  const aidlc = !!folder.repo_path && (await R.hasAidlc(folder.repo_path))
  return { aidlc, running, name, choice, canType: F.RANK[role] >= F.RANK.editor, canStart: F.RANK[role] >= F.RANK.editor && aidlc }
}
export async function startSession(slug, user) {
  const { folder } = await F.access(R.safeName(slug), user, 'editor')
  if (!(await R.hasAidlc(folder.repo_path))) throw err(400, 'no AI-DLC record in this folder')
  return AS.start({ name: nameOf(folder), cwd: folder.repo_path, lang: isEn() ? 'en' : 'ko' })
}
export async function stopSession(slug, user) {
  const { folder } = await F.access(R.safeName(slug), user, 'owner')
  await AS.stop(nameOf(folder))
  return { stopped: true }
}

// ---------- the decision page ----------
export async function decideView(slug, user) {
  const { folder } = await F.access(R.safeName(slug), user, 'viewer')
  const cur = await currentIntent(folder.repo_path)
  const name = nameOf(folder)
  const running = await AS.has(name)
  const choice = running ? AS.parseChoice(await AS.screen(name).catch(() => '')) : null
  const stage = cur?.stage || null
  const roleKey = waitRole(stage, choice)
  const questions = cur ? (await R.listQuestions(cur.dir)).filter((f) => !stage || f.stage === stage.slug || f.questions.some((x) => !x.answer)) : []
  const reviews = cur ? (await R.listReviews(cur.dir)).filter((r) => r.stage === stage?.slug && (!cur.unit || !r.unit || r.unit === cur.unit.unit)).slice(-1) : []
  // what the stage produced (the originals an approval is about) and where each finding points
  const allDocs = cur ? await R.docList(cur.dir) : []
  const docs = allDocs.filter((d) => d.stage === stage?.slug && (!cur.unit || !d.unit || d.unit === cur.unit.unit) && !/-questions\.md$|\/reviews\/|\/memory\.md$/.test(d.path))
    .map((d) => ({ path: d.path, name: d.path.split('/').pop() }))
  for (const r of reviews) for (const f of r.findings) f.refs = R.resolveRefs(f.location, allDocs, stage?.slug)
  // the mob's proposal for a question file still waiting (one for a file already answered is past)
  const waiting = new Set(questions.filter((f) => f.questions.some((x) => !x.answer && !x.summary)).map((f) => f.path))
  const [proposal] = await q(`select id, questions_path, answers, created_at from pro_aidlc_proposals where tenant_id=$1 and folder_id=$2 and used_at is null
                              and questions_path = any($3) order by created_at desc limit 1`, [T(), folder.id, [...waiting]])
  const ledger = await q(`select d.stage, d.kind, d.question, d.choice, d.note, d.created_at, ${WHO} as who from pro_aidlc_decisions d
                          left join users u on u.id = d.user_id and u.tenant_id = d.tenant_id left join pro_profile p on p.user_id = d.user_id
                          where d.tenant_id=$1 and d.folder_id=$2 order by d.created_at desc limit 12`, [T(), folder.id])
  return {
    folder: { slug: folder.slug, name: folder.name },
    intent: cur && { space: cur.space, slug: cur.slug, scope: cur.scope, status: cur.state.status },
    stage, role: roleKey && roleName(roleKey), deciders: roleKey ? await deciders(folder, roleKey) : [],
    canDecide: await mayDecide(folder, user, roleKey),
    session: { running, choice: choice && { ...choice, kind: promptKind(choice), title: promptTitle(promptKind(choice), stage?.name || '') } },
    // (the summary confirmation is answered in the session's prompt, not as a question here)
    questions: questions.map((f) => { const qs = f.questions.filter((x) => !x.summary); return { path: f.path, stage: describeStage(f.stage).name, open: qs.filter((x) => !x.answer).length, questions: qs } }),
    review: reviews[0] || null, docs, unit: cur?.unit || null, proposal: proposal || null, ledger,
  }
}

async function record(folder, user, { stage, kind, question, choice, note }) {
  await q(`insert into pro_aidlc_decisions(tenant_id,folder_id,intent,stage,kind,question,choice,note,user_id) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [T(), folder.id, null, stage, kind, question?.slice(0, 1000) || null, choice?.slice(0, 500) || null, note?.slice(0, 2000) || null, user.id])
}

// a choice in the prompt on screen (the fingerprint says it is the prompt the person saw)
export async function decide(slug, user, { fingerprint, option, text }) {
  const { folder } = await F.access(R.safeName(slug), user, 'viewer')
  const cur = await currentIntent(folder.repo_path)
  const name = nameOf(folder)
  if (!(await AS.has(name))) throw err(409, 'no session')
  const choice = AS.parseChoice(await AS.screen(name))
  if (!(await mayDecide(folder, user, waitRole(cur?.stage, choice)))) throw err(403, 'not yours to decide')
  const out = await AS.answer(name, { fingerprint, option, text })
  await record(folder, user, { stage: cur?.state.currentStage, kind: 'prompt', question: choice ? `${choice.title} ${choice.question}`.trim() : '', choice: out.answered, note: text || null })
  return out
}

// answers to a question file (typed on the page, or agreed in a mob meeting and confirmed here),
// then the session is told they are there
export async function submitAnswers(slug, user, { path: rel, answers, proposalId }) {
  const { folder } = await F.access(R.safeName(slug), user, 'viewer')
  const cur = await currentIntent(folder.repo_path)
  if (!cur) throw err(404, 'no AI-DLC work in this folder')
  if (!(await mayDecide(folder, user, cur.stage?.roleKey))) throw err(403, 'not yours to decide')
  const written = await R.writeAnswers(cur.dir, rel, answers || {})
  // a proposal for this file is done with once its answers are written (by it or by hand)
  await q('update pro_aidlc_proposals set used_at=now() where tenant_id=$1 and folder_id=$2 and questions_path=$3 and used_at is null and id is distinct from $4', [T(), folder.id, rel, proposalId || null])
  if (proposalId) {
    await q('update pro_aidlc_proposals set used_at=now() where id=$1 and tenant_id=$2 and folder_id=$3', [proposalId, T(), folder.id])
    // the meeting's "answers agreed" card has done its job
    await q(`update notifications set is_checked=true where tenant_id=$1 and type='aidlc' and url=$2`, [T(), `/aidlc/${folder.slug}/decide?p=${proposalId}`])
  }
  await record(folder, user, { stage: cur.state.currentStage, kind: 'answers', question: rel, choice: Object.entries(written).map(([k, v]) => `${k}: ${v}`).join(' · '), note: proposalId ? 'mob meeting' : null })
  const name = nameOf(folder)
  let told = false
  if (await AS.has(name)) {
    // asked how to answer: "I'll edit the file", then say they are written
    const choice = AS.parseChoice(await AS.screen(name))
    const edit = choice?.options.find((o) => /edit the file/i.test(o.label))
    if (edit) { await AS.sendKey(name, String(edit.n)); await new Promise((r) => setTimeout(r, 1500)) }
    if (!choice || edit) { await AS.sendText(name, L('질문 파일에 답을 적었어요. done', 'The answers are in the questions file. done')); told = true }
  }
  return { written, told }
}
