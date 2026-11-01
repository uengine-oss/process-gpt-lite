// 범위 사다리의 원천 = Process GPT 조직도(configuration 'organization'). 팀 노드(isTeam) 아래 사람 노드, 중첩 = 상위.
// 장은 pro_team_leads(조직도 JSON 에는 장 칸이 없다), 관리자는 Lite 의 관리자(users.is_admin 또는 테넌트 owner)와
// Process GPT 역할 사다리(users.role 이 admin 이상).
// 조직도가 바뀌면 30초 안에 다시 읽는다(스펙: 1분 안의 다음 요청부터).
import { q } from '../supa.js'
import { config } from '../../config.js'

const LEVEL = { superadmin: 120, admin: 100, owner: 80, editor: 60, reviewer: 40, viewer: 20 }
const cache = new Map() // tenant -> org
export const forget = () => cache.clear()

export function parseChart(chart) {
  const nodes = new Map(), people = new Map()
  const walk = (n, parent, path) => {
    if (!n) return
    const d = n.data || {}
    const id = String(n.id ?? d.id)
    const isTeam = id === 'root' || !!d.isTeam
    if (isTeam) {
      nodes.set(id, { id, name: d.name || n.name || id, parent, children: [] })
      if (parent && nodes.get(parent)) nodes.get(parent).children.push(id)
      for (const c of n.children || []) walk(c, id, [...path, id])
      return
    }
    if (d.isAgent) return                                        // AI 직원 노드는 사람 범위에 들지 않는다
    const p = people.get(id) || { id, name: d.name || n.name || '', email: d.email || '', role: d.role || '', teams: [], paths: [] }
    p.teams.push(parent); p.paths.push(path)
    people.set(id, p)
  }
  walk(chart, null, [])
  return { nodes, people }
}

export async function orgOf(tenant = config.tenantId) {
  const hit = cache.get(tenant)
  if (hit && Date.now() - hit.at < 30000) return hit
  const row = (await q(`select value from configuration where key = 'organization' and tenant_id = $1`, [tenant]))[0]
  const { nodes, people } = parseChart(row?.value?.chart)
  const leads = new Map((await q(`select node_id, user_id from pro_team_leads where tenant_id = $1`, [tenant])).map((r) => [r.node_id, String(r.user_id)]))
  const users = await q(`select id, username, email, role, is_admin from users where tenant_id = $1 and coalesce(is_agent, false) = false`, [tenant])
  const owner = (await q(`select owner from tenants where id = $1`, [tenant]).catch(() => []))[0]?.owner
  const admins = new Set(users.filter((u) => u.is_admin || String(u.id) === String(owner) || (LEVEL[String(u.role || '').toLowerCase()] || 0) >= 100).map((u) => String(u.id)))
  for (const u of users) { const p = people.get(String(u.id)); if (p) { p.name = p.name || u.username; p.email = p.email || u.email } }
  const org = { tenant, at: Date.now(), nodes, people, leads, admins, users }
  cache.set(tenant, org)
  return org
}

// 팀 노드의 부서 = 그 바로 위 노드(위가 루트면 부서는 회사 전체와 같다)
const deptOf = (org, team) => org.nodes.get(team)?.parent || team
function under(org, nodeId, personId) {
  const p = org.people.get(String(personId))
  return !!p && p.paths.some((path, i) => path.includes(nodeId) || p.teams[i] === nodeId)
}
export function peopleUnder(org, nodeId) { return [...org.people.values()].filter((p) => under(org, nodeId, p.id)) }

// 보는 사람(viewer)과 주인(owner)의 관계
export function relation(org, viewer, owner, { via = 'jwt' } = {}) {
  const v = String(viewer), o = String(owner)
  if (v === o) return { self: true, member: true, sameTeam: true, sameDept: true, lead: null, admin: org.admins.has(v), via }
  const pv = org.people.get(v), po = org.people.get(o)
  const member = !!(pv && po)
  if (!member) return { self: false, member: false, sameTeam: false, sameDept: false, lead: null, admin: false, via }
  const sameTeam = pv.teams.some((t) => po.teams.includes(t))
  const sameDept = pv.teams.some((t) => po.teams.some((u) => deptOf(org, t) === deptOf(org, u)))
  // 보는 사람이 장인 노드가 주인 위에 있으면(주인이 그 노드 아래) 장 덧씌움
  let lead = null
  for (const [node, uid] of org.leads) if (uid === v && under(org, node, o) && org.leads.get(node) !== o) { lead = node; break }
  const admin = org.admins.has(v)
  return { self: false, member, sameTeam, sameDept, lead, admin, via }
}

export const personName = (org, id) => org.people.get(String(id))?.name || org.users.find((u) => String(u.id) === String(id))?.username || '알 수 없음'
export const teamName = (org, id) => { const p = org.people.get(String(id)); return p ? p.teams.map((t) => org.nodes.get(t)?.name).filter(Boolean).join(', ') : '' }
// 보는 사람이 장인 노드들(관리자는 루트)
export function ledNodes(org, viewer) {
  const v = String(viewer), out = []
  if (org.admins.has(v)) out.push('root')
  for (const [node, uid] of org.leads) if (uid === v) out.push(node)
  return out
}
// 범위(scope) 안의 사람: team | department | company
export function peopleInScope(org, viewer, scope = 'team') {
  const pv = org.people.get(String(viewer))
  if (!pv) return []
  if (scope === 'company') return [...org.people.values()]
  const nodes = scope === 'department' ? pv.teams.map((t) => deptOf(org, t)) : pv.teams
  return [...org.people.values()].filter((p) => nodes.some((n) => under(org, n, p.id)))
}
