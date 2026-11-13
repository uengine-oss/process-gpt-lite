// 역할(design-v0.3 §3.2 · §3.3): a role is a point of view on expertise — what it is for, which competencies it needs, who
// plays it (people, later agents) and what it carries in the company's processes. The numbers come from the map
// (structure.js); the definition and competencies are drafted by the model from that evidence and confirmed by an admin,
// the same way a task's definition is.
import { chatJson } from '../llm.js'
import { cypher, readGraph } from './store.js'
import { CLS_KO, shownRoutine } from './structure.js'
import { prompt } from './discovery.js'
import { habitSettings } from './service.js'

const err = (status, message) => Object.assign(new Error(message), { status })
const J = (s, d) => { try { return typeof s === 'string' ? JSON.parse(s) : s ?? d } catch { return d } }

export async function roleView(key) {
  const g = await readGraph()
  const role = g.roles.find((r) => r.key === key)
  if (!role) throw err(404, '역할을 찾지 못했어요.')
  const people = new Map(g.performers.map((p) => [p.key, p]))
  const tasks = new Map(g.tasks.map((t) => [t.key, t]))
  const performers = g.plays.filter((p) => p.to === key).sort((a, b) => b.n - a.n)
    .map((p) => ({ id: p.from, name: people.get(p.from)?.name || p.from, agent: !!people.get(p.from)?.is_agent, n: p.n, share: p.share, assigned: !!p.assigned }))
  const doing = g.performedBy.filter((p) => p.to === key).sort((a, b) => b.n - a.n)
    .map((p) => ({ task: p.from, n: p.n, share: p.share, skills: tasks.get(p.from)?.skills || [], checkpoints: tasks.get(p.from)?.checkpoints || [], single: (role.single_tasks || []).includes(p.from) }))
  const routines = g.processes.filter((p) => p.kind === 'routine' && p.role === key)
  // the role's routine steps the habit setting lets through (the same rule as the map, design-v0.3 §4)
  const settings = await habitSettings()
  const own = g.triggers.filter((t) => String(t.scope) === `role:${key}`)
  const routineTasks = own.filter((t) => shownRoutine(t, settings)).map((t) => ({ task: t.to, people: t.people, source: t.source, event: t.from, autonomy: t.autonomy || 'ask' }))
  const hiddenRoutines = own.length - routineTasks.length
  const ways = (g.ways || []).filter((w) => w.role === key)
  return { role: { ...role, competencies: J(role.competencies, []) }, performers, tasks: doing, routines: routines.map((p) => p.key), routineTasks, hiddenRoutines, ways }
}

// prompt: the process-discovery skill's prompts/draft-role.md
export async function draftRole(key) {
  const v = await roleView(key)
  const evidence = {
    role: key, tasks: v.tasks.slice(0, 12).map((t) => ({ task: t.task, times: t.n, skills: t.skills, checkpoints: t.checkpoints.slice(0, 4) })),
    results: (v.role.artifacts || []).map((c) => CLS_KO[c] || c), routine: v.routineTasks.map((r) => `${r.task}(${r.people}명)`),
    agent_share: v.role.agent_share, members: v.role.members, single_person_tasks: v.role.single_tasks || [],
  }
  const r = await chatJson(await prompt('draft-role'), JSON.stringify(evidence), { temperature: 0, timeoutMs: 60000 })
  return { definition: String(r?.definition || ''), competencies: (r?.competencies || []).slice(0, 8).map((c) => ({ name: String(c.name || ''), evidence: String(c.evidence || '') })).filter((c) => c.name), evidence }
}

export async function saveRole(me, key, { definition, competencies }) {
  const list = (Array.isArray(competencies) ? competencies : []).map((c) => ({ name: String(c.name || '').slice(0, 60), evidence: String(c.evidence || '').slice(0, 200) })).filter((c) => c.name)
  const rows = await cypher('MATCH (r:Role {key:$key}) SET r.definition=$definition, r.competencies=$competencies, r.confirmed=true, r.confirmed_by=$by RETURN r.key AS key',
    { key, definition: String(definition || '').slice(0, 600), competencies: JSON.stringify(list), by: me.email || String(me.id) },
    { actor: me.email || String(me.id), reason: '역할 정의 확정', validFrom: new Date().toISOString() })
  if (!rows.length) throw err(404, '역할을 찾지 못했어요.')
  return roleView(key)
}
