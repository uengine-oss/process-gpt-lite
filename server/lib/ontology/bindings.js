// 역할마다 맡을 사람(sql/045 pro_po_cases.bindings): 건을 시작할 때, 시작 일부터 펼친 흐름(run.js unfold — 흐름도의 BPMN 과 같은 펼침)에서
// 사람이 하는 단계가 있는 역할마다 누가 맡는지를 엔진이 쓰는 그대로 풀어 보여 준다 — 잘못 맡겨진 사람을 시작할 때 잡으려고(나중에 인계로
// 고치지 않게). 풀이: 설정의 팀 · 역할 담당자(pro_role_assignments, 회사 전체 '*') → 없으면 이 역할을 프로세스마다 정해 둔 담당자(한 명이면
// 그 사람, 여럿이면 「여러 명 · 정해야 해요」) → 없으면 시작한 사람(mapengine.js personOf · engine.js startProcess 와 같다) → 시작한 사람도
// 없으면 「맡을 사람 없음」. 에이전트가 하는 단계는 「업무 에이전트」로 보이고 묻지 않는다.
// 제안(시작을 묻는)이면 묻는 카드에서 바꾼 뒤 시작하고, 자동이면 「시작했어요」 카드에서 바꾼다 — 바꾸면 그 역할의 끝나지 않은 단계만 그
// 사람에게 가고(열린 할 일의 사람을 바꾸고 알림, 결정 원장 한 줄, 인계 기록은 남기지 않는다) 뒤에 생기는 단계도 이 건에서는 그 사람에게 간다.
// 회사 설정은 그대로다.
import { config } from '../../config.js'
import { q } from '../supa.js'
import { roleKey } from '../team.js'
import { END } from './stats.js'
import { unfold } from './run.js'
import { taskDefinition } from './taskdef.js'

const T = () => config.tenantId
const err = (status, message) => Object.assign(new Error(message), { status })
export const AGENT_ROLE = '업무 에이전트'
export const FROM_KO = {
  settings: '설정의 팀 · 역할 담당자', process: '이 프로세스에 정해 둔 담당자', starter: '시작한 사람(설정에 담당자 없음)', picked: '이 건에서 바꿈',
  several: '여러 명 · 정해야 해요', none: '맡을 사람 없음', agent: '에이전트가 해요',
}
export const unbound = (b) => !!b && b.from !== 'agent' && !b.userId
// the role a step is filed under (mapengine.js createItem)
export const roleOfTask = (t, runner) => (runner === 'agent' ? AGENT_ROLE : t?.role || '담당자')

// one role's person, as the engine resolves it (pure). star: the tenant-wide holder · others: holders of the role set per process ·
// starter: who starts the case · names: id → name
export function bindingFor(role, { star = null, others = [], starter = null, names = new Map() } = {}) {
  const nm = (id) => names.get(String(id)) || ''
  if (star) return { role, userId: String(star), name: nm(star), from: 'settings' }
  const uniq = [...new Set(others.map(String))]
  if (uniq.length === 1) return { role, userId: uniq[0], name: nm(uniq[0]), from: 'process' }
  if (uniq.length > 1) return { role, userId: null, name: '', from: 'several', candidates: uniq.map((id) => ({ id, name: nm(id) })) }
  if (starter) return { role, userId: String(starter), name: nm(starter), from: 'starter' }
  return { role, userId: null, name: '', from: 'none' }
}

// the roles of a flow unfolded from entry: [{role, tasks, agent}] — a person's role once with its steps, the agent's steps under 업무 에이전트
export async function rolesOfFlow(view, entry, theta) {
  const th = Number.isFinite(theta) ? theta : view?.proc?.theta ?? 0.05
  const { nodes } = unfold(view, entry, th)
  const out = new Map()
  for (const k of nodes) {
    if (k === END) continue
    const t = view.tasks.get(k)
    if (!t) continue
    const d = await taskDefinition(t.key, t)
    const role = roleOfTask(t, d.runner)
    const r = out.get(roleKey(role)) || { role, tasks: [], agent: d.runner === 'agent' }
    r.tasks.push(t.key)
    out.set(roleKey(role), r)
  }
  return [...out.values()]
}

// the bindings of a case about to start (or of a role met later): roles → people, with where each came from. picks: [{role, userId}] a
// person chose (the ask card) — a pick must be one of the tenant's people.
export async function resolveBindings(view, entry, { starter = null, theta, picks = [], roles = null } = {}) {
  const list = roles || (await rolesOfFlow(view, entry, theta))
  const people = list.filter((r) => !r.agent)
  const keys = people.map((r) => roleKey(r.role))
  const rows = keys.length ? await q(`select proc_def_id, role, user_id::text as user_id from pro_role_assignments where tenant_id=$1`, [T()]) : []
  const picked = new Map((picks || []).filter((p) => p?.role && p.userId).map((p) => [roleKey(p.role), String(p.userId)]))
  const ids = [...new Set([...rows.map((r) => r.user_id), ...picked.values(), ...(starter ? [String(starter)] : [])])]
  const names = new Map((ids.length ? await q(`select id::text as id, coalesce(nullif(username,''), email) as name from users where tenant_id=$1 and id::text = any($2)`, [T(), ids]) : []).map((u) => [u.id, u.name]))
  const out = []
  for (const r of list) {
    if (r.agent) { out.push({ role: r.role, userId: null, name: '', from: 'agent', tasks: r.tasks }); continue }
    const k = roleKey(r.role)
    const mine = rows.filter((x) => roleKey(x.role) === k)
    let b = bindingFor(r.role, { star: mine.find((x) => x.proc_def_id === '*')?.user_id || null, others: mine.filter((x) => x.proc_def_id !== '*').map((x) => x.user_id), starter, names })
    const p = picked.get(k)
    if (p) {
      if (!names.has(p)) throw err(400, `「${r.role}」에 고른 사람을 이 회사에서 찾지 못했어요.`)
      if (p !== b.userId) b = { role: r.role, userId: p, name: names.get(p), from: 'picked', was: b.from }
    }
    out.push({ ...b, tasks: r.tasks })
  }
  return out
}

export const findBinding = (bindings, role) => (Array.isArray(bindings) ? bindings : []).find((b) => roleKey(b.role) === roleKey(role)) || null

// bpm_proc_inst.role_bindings in the shape the BPM engine writes ([{name, endpoint, default, origin, resolutionRule}]) · participants
export function roleBindingsOf(bindings = [], agent = null) {
  return (bindings || []).map((b) => b.from === 'agent'
    ? { name: b.role, origin: 'used', default: agent || '', endpoint: agent || '', resolutionRule: '' }
    : { name: b.role, origin: 'created', default: b.userId ? [b.userId] : [], endpoint: b.userId ? [b.userId] : [], resolutionRule: `프로세스 지도: ${FROM_KO[b.from] || b.from}` })
}

// what a card or the case view shows
export const bindingsView = (bindings = []) => (bindings || []).map((b) => ({ role: b.role, userId: b.userId || null, name: b.name || '', from: b.from, fromKo: FROM_KO[b.from] || '',
  tasks: b.tasks || [], ...(b.candidates ? { candidates: b.candidates } : {}), ...(b.changedAt ? { changedAt: b.changedAt, changedBy: b.changedBy || '' } : {}), unbound: unbound(b) }))
