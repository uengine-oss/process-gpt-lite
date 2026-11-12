// 일의 방법 공유(design-v0.3 §10): a habit has a goal (the task it does, named on the company map) and people reach the
// same goal in different ways. When a habit becomes one (seen twice), its owner is asked whether to share the way with the
// company. A shared way is a nominee for its task, shown with who shared it, how long it takes when it runs and how often
// it is taken up; an admin turns the one the company picks into a skill of that task (deepagents' own /skills/upload), and
// the same role's people who do not have the habit are offered that way (lib/followups.js offer).
// Nothing is shared without the owner saying so; the graph never holds the words (build.js counts roles and tasks only).
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { config } from '../../config.js'
import { q } from '../supa.js'
import { addMessage, updateMessage } from '../store.js'
import { nameHabits } from './names.js'
import { cypher, ontologyEnabled } from './store.js'
import { CLS_KO } from './structure.js'
import { shownRoutine } from './structure.js'

const T = () => config.tenantId
const err = (status, message) => Object.assign(new Error(message), { status })
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim()

// a person's role: a role they were made a member of, else the role they own in the assignments
export async function roleOfUser(userId) {
  const [r] = await q(`select role from (select role, 0 as o from pro_role_members where tenant_id=$1 and user_id::text=$2
                                         union all select role, 1 from pro_role_assignments where tenant_id=$1 and user_id::text=$2 and proc_def_id='*') x order by o limit 1`, [T(), String(userId)])
  return r?.role || null
}
export async function setMember(me, role, userId, on) {
  if (on) await q(`insert into pro_role_members (tenant_id, role, user_id, added_by) values ($1,$2,$3,$4) on conflict do nothing`, [T(), role, userId, me.id])
  else await q('delete from pro_role_members where tenant_id=$1 and role=$2 and user_id=$3', [T(), role, userId])
  return { role, userId, on: !!on }
}
const taskOfWords = async (words) => (await nameHabits([words]).catch(() => new Map())).get(clean(words)) || null

// asked once per habit, right after 「이 순서를 기억할게요」
export async function askShare(user, threadId, h) {
  if (!ontologyEnabled()) return null
  const [done] = await q('select 1 from pro_habit_shares where tenant_id=$1 and followup_id=$2', [T(), h.id])
  if (done) return null
  return addMessage(user.id, threadId, 'agent', 'habit-share', { followupId: h.id, cls: h.event_cls, action: h.action, state: 'pending',
    text: `이 방법을 회사에 공유할까요? 같은 일을 하는 동료에게 방법 후보로 보이고(이름 · 걸린 시간 · 받아들인 비율과 함께), 회사가 고르면 그 일의 스킬이 돼요.` })
}

export async function answerShare(user, { messageId, followupId, answer }) {
  if (!['shared', 'private'].includes(answer)) throw err(400, 'answer 는 shared · private 예요.')
  const [h] = await q('select * from pro_followups where id=$1 and user_id=$2 and tenant_id=$3', [followupId, user.id, T()])
  if (!h) throw err(404, '습관을 찾지 못했어요.')
  const task = answer === 'shared' ? await taskOfWords(h.action) : null
  const how = answer === 'shared' ? [h.action, ...(h.files || []).map((f) => `파일: ${f.name}`)].join('\n') : null
  const [row] = await q(`insert into pro_habit_shares (tenant_id, user_id, followup_id, answer, task, role, cls, how)
                         values ($1,$2,$3,$4,$5,$6,$7,$8)
                         on conflict (tenant_id, followup_id) do update set answer=excluded.answer, task=excluded.task, role=excluded.role, how=excluded.how,
                           status=case when excluded.answer='shared' then 'nominated' else 'withdrawn' end, updated_at=now() returning *`,
  [T(), user.id, followupId, answer, task, await roleOfUser(user.id), h.event_cls, how])
  if (messageId) {
    const [m] = await q(`select m.id from pro_messages m join pro_threads t on t.id=m.thread_id where m.id=$1 and t.user_id=$2`, [messageId, user.id])
    if (m) await updateMessage(user.id, messageId, { state: answer, task })
  }
  await syncWay(row.id).catch((e) => console.warn('[ontology] way', e.message))
  return row
}

// a habit that ran (accepted, then the agent finished): how long it took, for the way's numbers
export async function recordRun(followupId, minutes) {
  if (!followupId || !Number.isFinite(minutes)) return
  const rows = await q(`update pro_habit_shares set minutes = case when runs = 0 or minutes is null then $2 else (minutes * runs + $2) / (runs + 1) end, runs = runs + 1, updated_at=now()
           where followup_id=$1 returning id`, [followupId, minutes]).catch(() => [])
  for (const r of rows) await syncWay(r.id).catch(() => {})
}

// the shared ways of one goal: who, how, how long, how often taken up — the fastest that people keep taking first
const QUALITY_BAR = 0.6
export async function waysFor(task) {
  const rows = await q(`select s.id, s.task, s.role, s.cls, s.how, s.runs, s.minutes, s.status, s.skill_name, s.created_at, s.user_id::text as user_id, s.followup_id::text as followup_id,
                               coalesce(p.name, u.username, u.email) as name, f.accepted, f.declined, f.seen
                          from pro_habit_shares s join pro_followups f on f.id = s.followup_id
                          left join pro_profile p on p.user_id = s.user_id
                          left join users u on u.id = s.user_id and u.tenant_id = s.tenant_id
                         where s.tenant_id=$1 and s.answer='shared' and s.status <> 'withdrawn' ${task ? 'and s.task=$2' : ''}
                         order by s.created_at`, task ? [T(), task] : [T()])
  const ways = rows.map((r) => {
    const asked = (r.accepted || 0) + (r.declined || 0)
    return { ...r, taken: asked ? r.accepted / asked : null, minutes: r.minutes == null ? null : Math.round(r.minutes * 10) / 10 }
  })
  const ok = ways.filter((w) => w.runs > 0 && w.minutes != null && (w.taken == null || w.taken >= QUALITY_BAR))
  const best = ok.sort((a, b) => a.minutes - b.minutes)[0] || null
  return ways.map((w) => ({ ...w, best: best?.id === w.id }))
}

// the graph holds the shared ways too (the process's source of truth, design-v0.3 §10): a Way under its task, with who shared
// it (they said yes), how, its numbers and whether it became the task's skill
export async function syncWay(id) {
  if (!ontologyEnabled()) return
  const [w] = (await waysFor(null).catch(() => [])).filter((x) => x.id === id)
  const [gone] = w ? [] : await q(`select id, status from pro_habit_shares where id=$1`, [id])
  if (!w && !gone) return
  if (!w) { await cypher('MATCH (x:Way {key:$key}) SET x.status=$status RETURN x.key AS key', { key: id, status: 'withdrawn' }, { reason: '방법 공유 거둠' }).catch(() => {}); return }
  const props = { key: w.id, task: w.task || '', role: w.role || '', cls: w.cls || '', how: w.how || '', by: w.name || '', minutes: w.minutes, runs: w.runs || 0,
    taken: w.taken, status: w.status, skill: w.skill_name || '' }
  await cypher(`MERGE (x:Way {key:$key}) SET x.task=$task, x.role=$role, x.cls=$cls, x.how=$how, x.by=$by, x.minutes=$minutes, x.runs=$runs, x.taken=$taken, x.status=$status, x.skill=$skill`,
    props, { actor: w.name || '', reason: '일의 방법' })
  if (w.task) {
    const [linked] = await cypher('MATCH (t:Task {key:$task})-[r:HAS_WAY]->(x:Way {key:$key}) RETURN x.key AS key', { task: w.task, key: w.id }).catch(() => [])
    if (!linked) await cypher('MATCH (t:Task {key:$task}), (x:Way {key:$key}) CREATE (t)-[:HAS_WAY]->(x)', { task: w.task, key: w.id }).catch(() => {})
  }
}

// the company picks a way: it becomes a skill of the task (SKILL.md through deepagents' /skills/upload), listed in the
// task's definition, and the way is marked as the skill
const slug = (s) => String(s).normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 40) || 'way'
export function skillOf(w) {
  const name = `${slug(w.task)}-${String(w.id).slice(0, 6)}`
  const md = `---
name: ${name}
description: 「${w.task}」을(를) 회사가 고른 방법대로 한다 — ${CLS_KO[w.cls] || w.cls} 결과물 뒤에 ${w.role || '담당'}가 하던 방법(${w.name}님 공유)
---

# ${w.task}

${CLS_KO[w.cls] || w.cls} 결과물이 나오면 이어서 한다. ${w.role || '담당'} 가운데 ${w.name}님이 공유한 방법을 회사가 골랐다${w.minutes != null ? `(평균 ${w.minutes}분, ${w.runs}번 실행` : ''}${w.taken != null ? `, 물었을 때 받아들인 비율 ${Math.round(w.taken * 100)}%)` : w.minutes != null ? ')' : ''}.

## 하는 일
${String(w.how || '').split('\n').filter(Boolean).map((l, i) => `${i + 1}. ${l}`).join('\n')}

## 지킬 것
- 방금 만든 결과물에 한다. 결과물의 다른 내용은 바꾸지 않는다.
- 끝나면 바뀐 파일을 올리고, 무엇을 했는지 한 줄로 알린다.
`
  return { name, md }
}
async function uploadSkill({ name, md, jwt, ownerId }) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pro-way-'))
  try {
    await fs.mkdir(path.join(tmp, name))
    await fs.writeFile(path.join(tmp, name, 'SKILL.md'), md)
    const zip = path.join(tmp, `${name}.zip`)
    await new Promise((resolve, reject) => execFile('zip', ['-qr', zip, name], { cwd: tmp }, (e) => (e ? reject(e) : resolve())))
    const form = new FormData()
    form.set('tenant_id', T())
    form.set('owner_id', ownerId)
    form.set('file', new Blob([await fs.readFile(zip)]), `${name}.zip`)
    const r = await fetch(`${config.deepagentsUrl}/skills/upload`, { method: 'POST', headers: { Authorization: `Bearer ${jwt}` }, body: form })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) throw err(502, `스킬을 올리지 못했어요(${j.error || r.status}).`)
    return j
  } finally { await fs.rm(tmp, { recursive: true, force: true }) }
}
export async function makeSkill(me, id, jwt) {
  const [w] = (await waysFor(null)).filter((x) => x.id === id)
  if (!w) throw err(404, '방법을 찾지 못했어요.')
  if (!w.task) throw err(400, '이 방법의 목표(일 이름)를 아직 정하지 못했어요.')
  const { name, md } = skillOf(w)
  await uploadSkill({ name, md, jwt, ownerId: me.id })
  // the task's definition lists its skills (the snapshot reads them from there): add this one, or start a definition
  const { getTask, saveDefinition, parseDefinition, toDefinition } = await import('./taskdef.js')
  const t = await getTask(w.task).catch(() => null)
  const { front, body } = parseDefinition(t?.definition || '')
  const skills = [...new Set([...(Array.isArray(front.skills) ? front.skills : []), name])]
  const next = toDefinition({ name: w.task, kind: 'task', role: front.role || w.role || '', runner: front.runner || 'agent', ...front, skills }, body || `## 하는 일\n1. 스킬 ${name} 의 방법대로 한다.`)
  await saveDefinition(me, w.task, next)
  await q(`update pro_habit_shares set status='skill', skill_name=$2, updated_at=now() where id=$1`, [id, name])
  await syncWay(id).catch(() => {})
  return { name, task: w.task, skill: md }
}

// the same role's routine for a person who has no habit of this kind of result: the step most of the role takes, in the
// way the company picked (or the fastest shared way)
export async function routineFor(userId, classes, settings) {
  if (!ontologyEnabled() || !classes?.length) return null
  const role = await roleOfUser(userId)
  if (!role) return null
  const rows = []
  for (const cls of classes) {
    const r = await cypher(`MATCH (e:Event {key:$key})-[t:TRIGGERS]->(x:Task) RETURN x.key AS task, t.people AS people, t.shared AS shared, t.source AS source, t.status AS status`,
      { key: `artifact:@${role}:${cls}` }).catch(() => [])
    for (const x of r) if (x.status !== 'retired' && shownRoutine(x, settings)) rows.push({ ...x, cls })
  }
  const top = rows.sort((a, b) => (b.people || 0) - (a.people || 0))[0]
  if (!top) return null
  const ways = await waysFor(top.task).catch(() => [])
  const way = ways.find((w) => w.status === 'skill') || ways.find((w) => w.best) || null
  return { role, task: top.task, people: top.people || 0, cls: top.cls, way: way ? { id: way.id, followupId: way.followup_id, name: way.name, how: way.how, minutes: way.minutes, skill: way.skill_name || null } : null }
}
