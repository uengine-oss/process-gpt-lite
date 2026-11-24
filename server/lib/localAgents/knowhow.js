// What a local run learned (lib/localAgents — design docs/local-agents/design.md §5.7). When a desktop finishes a step it sends back what
// changed the run: the steers (who, when, what the run did after each), what the CLI wrote into its own memory (CLAUDE.md, AGENTS.md) and
// its edits to the skills it was given. Nothing of it is applied by itself:
//   - a steer or a memory note → the judge (decide.js oddsOf, the skill's prompt local-knowhow) reads whether it is a way of doing this
//     activity from now on (rule) or only this case's (once); what may be a rule becomes a candidate for the activity
//   - a skill edit → a candidate to propose to the skill (its folder's variation and 반영 요청 — the skill's author or boss merges)
// Candidates are kept on the job (pro_local_jobs.knowhow), shown on the run's card in the instance and on the owner's Home card; a person
// applies one: an activity's know-how goes into its definition (the map's task, or the process definition's activity) under 「배운 것」
// with where it came from — 「<사람>의 로컬 실행에서 배움 (<날짜>)」 — so the next run of the activity gets it, local or on the server.
import crypto from 'node:crypto'
import { config } from '../../config.js'
import { q } from '../supa.js'
import { L, langOf, withLang } from '../lang.js'
import * as A from './agents.js'
import * as J from './jobs.js'

const T = () => config.tenantId
const clean = (s, n) => String(s ?? '').replace(/\u0000/g, '').trim().slice(0, n)
const err = (status, message) => Object.assign(new Error(message), { status })
const day = (d = new Date()) => new Date(d).toLocaleDateString('sv-SE', { timeZone: process.env.PRO_TZ || 'Asia/Seoul' })
// (tests replace fn: the judge reads with a model)
export const judge = { fn: async (state, question, options) => (await import('../decide.js')).oddsOf(state, question, options) }
const MIN = () => Number(process.env.PRO_LOCAL_KNOWHOW_MIN || 0.5)

// what the desktop sent, kept to its known shape and sizes
export function sanitize(learned = {}) {
  const steers = (Array.isArray(learned.steers) ? learned.steers : []).slice(0, 20).map((s) => ({ id: clean(s.steerId || s.id, 40), text: clean(s.text, 2000), by: clean(s.by, 80), from: clean(s.from, 80),
    how: clean(s.how, 20), after: (Array.isArray(s.after) ? s.after : []).slice(0, 8).map((x) => clean(x, 300)) })).filter((s) => s.text)
  const memory = (Array.isArray(learned.memory) ? learned.memory : []).slice(0, 4).map((m) => ({ file: clean(m.file, 80), text: clean(m.text, 4000) })).filter((m) => m.text && /^(CLAUDE|AGENTS)\.md$/.test(m.file))
  const skills = (Array.isArray(learned.skills) ? learned.skills : []).slice(0, 10).map((k) => ({ name: clean(k.name, 80), folderId: clean(k.folderId, 40),
    files: (Array.isArray(k.files) ? k.files : []).slice(0, 20).map((f) => ({ path: clean(f.path, 200), text: String(f.text ?? '').slice(0, 200_000) }))
      .filter((f) => f.path && !f.path.startsWith('/') && !f.path.split('/').includes('..') && !f.path.startsWith('.git')) })).filter((k) => k.name && k.files.length)
  return { steers, memory, skills }
}

// a finished run's lessons → candidates on the job (and who is told)
export async function learn(job, learned) {
  const { steers, memory, skills } = sanitize(learned)
  if (!steers.length && !memory.length && !skills.length) return []
  const row = (await q('select * from todolist where id::text=$1', [String(job.todo_id)]))[0]
  const { actOf } = await import('../ontology/run.js')
  const act = row ? await actOf(row).catch(() => ({})) : {}
  const definition = [act.description, act.instruction].filter(Boolean).join('\n').slice(0, 2000) || '(정의 없음)'
  const person = job.person_name || ''
  const at = new Date().toISOString()
  let tpl = ''
  try { tpl = await (await import('../ontology/discovery.js')).prompt('local-knowhow') } catch { /* the bundled skill has it */ }
  const fill = (s, v) => String(s || '').replace(/\{(\w+)\}/g, (_, k) => v[k] ?? '')
  const out = []
  const read = async (kind, text, after) => {
    const state = fill(tpl, { step: job.activity_name, person, agent: A.LABEL[job.agent] || job.agent, definition, kind, text, after: after || '(없음)' })
    const r = await judge.fn(state, `「${job.activity_name}」 단계에서 이것은?`, [
      { key: 'rule', label: `앞으로 「${job.activity_name}」 단계를 할 때마다 지킬 일의 방식` },
      { key: 'once', label: '이번 건에만 해당하는 지시' },
    ]).catch(() => null)
    return r?.probabilities ? Number(r.probabilities.rule) : null
  }
  const base = (source, extra) => ({ id: `k${crypto.randomBytes(5).toString('hex')}`, state: 'proposed', source, from: { person, device: job.device_name || '', at }, ...extra })
  for (const s of steers) {
    // (both sides: who suggested it, who put it in)
    const who = s.from ? `${s.from} 제안 · ${s.by} 입력` : s.by
    const p = await read('사람이 실행 중에 바꾼 방향', `${who ? `${who}: ` : ''}${s.text}`, s.after.join('\n'))
    if (p == null || p >= MIN()) out.push(base('steer', { kind: 'activity', text: s.text, by: s.by, ...(s.from ? { suggestedBy: s.from } : {}), p, unjudged: p == null }))
  }
  for (const m of memory) {
    const p = await read(`에이전트가 스스로 적은 기억(${m.file})`, m.text, '')
    if (p == null || p >= MIN()) out.push(base('memory', { kind: 'activity', text: m.text.slice(0, 1200), file: m.file, p, unjudged: p == null }))
  }
  for (const k of skills) out.push(base('skill', { kind: 'skill', text: L(`「${k.name}」 스킬을 고쳤어요: ${k.files.map((f) => f.path).join(', ')}`, `Edited the skill "${k.name}": ${k.files.map((f) => f.path).join(', ')}`), skill: k }))
  if (!out.length) return []
  const [j] = await q(`update pro_local_jobs set knowhow = coalesce(knowhow, '[]'::jsonb) || $2::jsonb, updated_at=now() where id=$1 returning *`, [job.id, JSON.stringify(out)])
  // the people who decide: the case's owner (else the worker) and the process's owner — a Home card that opens the instance
  const { notifyInstance } = await import('../engine.js')
  const [c] = await q(`select started_by::text as id from pro_po_cases where tenant_id=$1 and $2 = any(instances) limit 1`, [T(), job.proc_inst_id]).catch(() => [])
  const [d] = row?.proc_def_id ? await q('select owner from proc_def where id=$1 and tenant_id=$2', [row.proc_def_id, T()]).catch(() => []) : []
  for (const u of [...new Set([c?.id || String(job.user_id), d?.owner ? String(d.owner) : null].filter((x) => /^[0-9a-f-]{36}$/i.test(x || '')))]) {
    await withLang(await langOf(u).catch(() => 'ko'), () => notifyInstance(u, job.proc_inst_id, {
      type: 'local_knowhow', title: L(`배운 것 ${out.length}개 · ${job.activity_name}`, `${out.length} lesson(s) · ${job.activity_name}`),
      text: L(`${person}의 로컬 실행에서 나온 것이에요. 반영할지 정해 주세요.`, `From ${person}'s local run. Decide whether to apply them.`),
    })).catch((e) => console.warn('[local-agents] know-how notice', e.message))
  }
  return j?.knowhow || out
}

// ---------- deciding ----------
export const provenance = (c) => L(`${c.from?.person || '담당자'}의 로컬 실행에서 배움 (${day(c.from?.at)})`, `Learned from ${c.from?.person || "the assignee"}'s local run (${day(c.from?.at)})`)

// may this person apply (or drop) this candidate: an activity's know-how changes how everyone does the activity — the process's owner or
// an administrator (team.js canAssign); a skill edit is a proposal (its author or boss merges) — the worker or an administrator
export async function mayDecide(user, job, c) {
  const team = await import('../team.js')
  if (await team.isAdmin(user)) return true
  if (c.kind === 'skill') return String(job.user_id) === String(user.id)
  const [t] = await q('select proc_def_id from todolist where id::text=$1', [String(job.todo_id)])
  const [d] = t?.proc_def_id ? await q('select owner from proc_def where id=$1 and tenant_id=$2', [t.proc_def_id, T()]) : []
  return !!d?.owner && String(d.owner) === String(user.id)
}

export async function decide(user, job, id, action) {
  const c = (job.knowhow || []).find((x) => x.id === id)
  if (!c) throw err(404, L('그 후보를 찾지 못했어요.', 'That candidate was not found.'))
  if (c.state !== 'proposed') throw err(409, L('이미 정한 후보예요.', 'That candidate was already decided.'))
  if (!(await mayDecide(user, job, c))) throw err(403, c.kind === 'skill' ? L('담당자나 관리자만 스킬에 제안할 수 있어요.', 'Only the assignee or an administrator can propose it to the skill.')
    : L('이 프로세스의 담당자나 관리자만 반영할 수 있어요.', "Only the process's owner or an administrator can apply it."))
  if (action === 'dismiss') return J.setKnowhow(job, id, { state: 'dismissed', decidedBy: user.name || '', decidedAt: new Date().toISOString() })
  if (action !== 'apply') throw err(400, 'action 은 apply · dismiss 예요.')
  const target = c.kind === 'skill' ? await toSkill(user, job, c) : await toActivity(user, job, c)
  return J.setKnowhow(job, id, { state: 'applied', decidedBy: user.name || '', decidedAt: new Date().toISOString(), target })
}

// an activity's know-how into its definition, under 「배운 것」, with where it came from. A case of the company's process map: the map's task
// (its definition — every later case and snapshot reads it); otherwise the process definition's activity (what the step reads, actOf)
const HEAD = () => L('## 배운 것', '## Learned')
export function withLesson(body, line) {
  const b = String(body || '').trimEnd()
  const h = HEAD()
  return b.includes(h) ? `${b}\n${line}` : `${b}${b ? '\n\n' : ''}${h}\n${line}`
}
async function toActivity(user, job, c) {
  const line = `- ${String(c.text).replace(/\s+/g, ' ').trim()} — ${provenance(c)}`
  const [t] = await q('select * from todolist where id::text=$1', [String(job.todo_id)])
  const [cs] = await q(`select id from pro_po_cases where tenant_id=$1 and $2 = any(instances) limit 1`, [T(), job.proc_inst_id]).catch(() => [])
  if (cs) {
    const D = await import('../ontology/taskdef.js')
    const task = await D.getTask(job.activity_name)
    const { front, body } = D.parseDefinition(task.definition || '')
    await D.saveDefinition(user, job.activity_name, D.toDefinition(task.definition ? front : { name: job.activity_name, kind: 'task' }, withLesson(body, line)))
    return { where: 'map', task: job.activity_name, line }
  }
  if (!t?.proc_def_id) throw err(409, L('이 단계는 정의가 없어 반영할 곳이 없어요.', 'This step has no definition to apply it to.'))
  const [d] = await q('select definition from proc_def where id=$1 and tenant_id=$2', [t.proc_def_id, T()])
  const act = (d?.definition?.activities || []).find((a) => a.id === t.activity_id)
  if (!act) throw err(409, L('정의에서 이 단계를 찾지 못했어요.', 'The step is not in the definition.'))
  await q(`update proc_def set definition = jsonb_set(definition, '{activities}', (
             select jsonb_agg(case when a->>'id' = $3 then a || jsonb_build_object('instruction', $4::text) else a end order by n)
             from jsonb_array_elements(definition->'activities') with ordinality as x(a, n))) where id=$1 and tenant_id=$2`, [t.proc_def_id, T(), t.activity_id, withLesson(act.instruction || '', line)])
  return { where: 'process', process: t.proc_def_id, activity: t.activity_id, line }
}

// a skill edit → the skill folder's variation with those files, and its 반영 요청 (folders/skills.js — the author or a boss merges)
async function toSkill(user, job, c) {
  const S = await import('../folders/service.js')
  const SK = await import('../folders/skills.js')
  const G = await import('../folders/git.js')
  const fs = await import('node:fs/promises')
  const path = await import('node:path')
  const folder = c.skill?.folderId ? await S.folderById(c.skill.folderId) : await SK.skillFolder(c.skill?.name)
  if (!folder || folder.kind !== 'skill') throw err(404, L('그 스킬 폴더를 찾지 못했어요.', 'The skill folder was not found.'))
  const v = await S.createVariation(folder, { title: L(`${job.activity_name} 로컬 실행에서 고친 점`, `Changes from a local run of ${job.activity_name}`), kind: 'person',
    holder: { type: 'user', id: user.id, name: user.name }, createdBy: user.id, source: { label: provenance(c), local_job: job.id, todo_id: String(job.todo_id) } })
  const dir = path.join(S.foldersRoot(), '.local-knowhow', `${folder.slug}-${crypto.randomBytes(3).toString('hex')}`)
  await S.checkout(folder, v, dir)
  for (const f of c.skill.files) {
    const p = path.join(dir, S.safeRel(f.path))
    await fs.mkdir(path.dirname(p), { recursive: true })
    await fs.writeFile(p, f.text)
  }
  const cur = await S.variationById(v.id)
  await S.commitVariation(folder, cur, { name: user.name, email: user.email }, `${provenance(c)}: ${c.skill.files.map((f) => f.path).join(', ')}`)
  await S.release(folder, await S.variationById(v.id))
  const after = await S.variationById(v.id)
  const changed = await G.changes(folder.repo_path, folder.default_branch, after.branch).catch(() => [])
  if (!changed.length) { await S.discard(folder, after).catch(() => {}); return { where: 'skill', skill: folder.settings?.skill_name, unchanged: true } }
  const pr = await SK.requestMerge(folder, after, user, { title: L(`${provenance(c)}`, `${provenance(c)}`), description: c.text }).catch((e) => { console.warn('[local-agents] skill request', e.message); return null })
  return { where: 'skill', skill: folder.settings?.skill_name, variation: after.id, url: `/folders/${folder.slug}/v/${after.id}`, pr: pr?.id || null }
}

// what a card shows of the candidates
export function view(c, { canDecide = false } = {}) {
  return { id: c.id, kind: c.kind, source: c.source, text: c.text, by: c.by || '', suggestedBy: c.suggestedBy || null, file: c.file || null, skill: c.skill ? { name: c.skill.name, files: c.skill.files.map((f) => f.path) } : null,
    p: c.p ?? null, unjudged: !!c.unjudged, state: c.state, provenance: provenance(c), target: c.target || null, decidedBy: c.decidedBy || null, canDecide: canDecide && c.state === 'proposed' }
}
