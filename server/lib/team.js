// Teammates and who plays which process role. A process step goes to the person bound to its
// role; process-gpt's todolist trigger then notifies exactly that person.
import { config } from '../config.js'
import { q, ensureUser } from './supa.js'

const T = () => config.tenantId

export async function listTeam() {
  return q(`select u.id, u.email, u.username as name from pro_team_members m
            join users u on u.id = m.user_id and u.tenant_id = m.tenant_id
            where m.tenant_id=$1 order by m.created_at`, [T()])
}

// Who may change the team and the tenant-wide role holders: process-gpt's tenant administrators —
// users.is_admin, or the tenant's owner (tenants.owner, process-gpt checkTenantOwner).
export async function isAdmin(me) {
  const [r] = await q(`select (select coalesce(bool_or(u.is_admin), false) from users u where u.id::text=$1 and u.tenant_id=$2)
                         or exists (select 1 from tenants t where t.id=$2 and t.owner::text=$1) as admin`, [String(me.id), T()]).catch(() => [])
  return !!r?.admin
}

// A process's own role holders: an administrator, or that process's owner (proc_def.owner, the
// 담당자 process-gpt's definition dialog edits). A process nobody owns is anyone's to set, as in
// process-gpt (ProcessDefinitionVersionDialog: isOwnerUser = !owner || owner === me). The
// tenant-wide holder ('*', every process using the role name) is the administrators' only.
export async function canAssign(me, defId) {
  if (await isAdmin(me)) return true
  const def = String(defId || '*').toLowerCase()
  if (def === '*') return false
  const [d] = await q('select owner from proc_def where lower(id)=$1 and tenant_id=$2', [def, T()]).catch(() => [])
  if (!d) return false
  return !d.owner || String(d.owner) === String(me.id)
}

// A fresh install has its administrator from install.sh (ADMIN_EMAIL, users.is_admin + tenants.owner).
// Anywhere else nothing would make one: then the first person to sign in becomes the administrator.
export async function claimFirstAdmin(userId) {
  const [r] = await q(`select exists (select 1 from users where tenant_id=$1 and is_admin and not coalesce(is_agent,false))
                         or exists (select 1 from tenants where id=$1 and owner is not null) as has`, [T()]).catch(() => [{ has: true }])
  if (r?.has) return false
  await q(`update users set is_admin=true, role='admin' where id=$1 and tenant_id=$2`, [userId, T()])
  await q(`update tenants set owner=$1 where id=$2 and owner is null`, [userId, T()]).catch(() => {})
  console.log(`[team] ${String(userId).slice(0, 8)} is the first administrator of ${T()}`)
  return true
}

// Adding someone who never signed in creates their account, so work can be routed to them
// before their first visit.
export async function addMember(me, email, name) {
  const u = await ensureUser(String(email).trim().toLowerCase(), name)
  if (name) await q('update users set username=$1 where id=$2 and tenant_id=$3', [name, u.id, T()])
  await q('delete from pro_team_removed where tenant_id=$1 and user_id=$2', [T(), u.id])
  await q(`insert into pro_team_members(tenant_id,user_id,added_by) values ($1,$2,$3) on conflict do nothing`, [T(), u.id, me.id])
  return { id: u.id, email: u.email, name: name || u.email.split('@')[0] }
}

export async function removeMember(userId, by) {
  await q('delete from pro_team_members where tenant_id=$1 and user_id=$2', [T(), userId])
  await q('delete from pro_role_assignments where tenant_id=$1 and user_id=$2', [T(), userId])
  // remembered, so their next visit does not put them back (ensureMember)
  await q(`insert into pro_team_removed(tenant_id,user_id,removed_by) values ($1,$2,$3) on conflict (tenant_id,user_id) do update set removed_by=excluded.removed_by, removed_at=now()`, [T(), userId, by || null])
}

// The signed-in user joins the team on first sight. In Lite the team is the people of this tenant:
// teammate chat, sharing, meetings and role routing only work between team members, and nobody would
// otherwise be able to add the very first one — so signing in is the admission. Someone an
// administrator removed stays removed.
export async function ensureMember(me) {
  await q(`insert into pro_team_members(tenant_id,user_id,added_by) select $1,$2,$2
           where not exists (select 1 from pro_team_removed where tenant_id=$1 and user_id=$2) on conflict do nothing`, [T(), me.id])
}

export async function listAssignments(defId) {
  return q(`select a.proc_def_id, a.role, a.user_id, u.username as name, u.email from pro_role_assignments a
            join users u on u.id = a.user_id and u.tenant_id = a.tenant_id
            where a.tenant_id=$1 and ($2::text is null or a.proc_def_id in ($2, '*'))
            order by a.proc_def_id <> '*', a.role`, [T(), defId ? defId.toLowerCase() : null])
}

export async function assign(me, { defId, role, userId }) {
  const def = (defId || '*').toLowerCase()
  if (!userId) {
    await q('delete from pro_role_assignments where tenant_id=$1 and proc_def_id=$2 and role=$3', [T(), def, role])
    return null
  }
  await q(`insert into pro_role_assignments(tenant_id,proc_def_id,role,user_id,updated_by) values ($1,$2,$3,$4,$5)
           on conflict (tenant_id,proc_def_id,role) do update set user_id=excluded.user_id, updated_by=excluded.updated_by, updated_at=now()`,
  [T(), def, role, userId, me.id])
  return { defId: def, role, userId }
}

// Role names compare without case or extra spaces: a generated process's "Proposal Team Lead" is the team's
// "Proposal team lead".
export const roleKey = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase()

// roleKey(role name) → user id for one process: the process-specific assignment wins over the tenant default.
export async function roleMap(defId) {
  const rows = await q(`select proc_def_id, role, user_id from pro_role_assignments where tenant_id=$1 and proc_def_id in ($2,'*')`,
    [T(), String(defId).toLowerCase()])
  const out = {}
  for (const r of rows.sort((a, b) => (a.proc_def_id === '*') - (b.proc_def_id === '*'))) out[roleKey(r.role)] ??= r.user_id
  return out
}

// "김민지", "minji@…", "제품 책임자" → a teammate. A role name resolves through the tenant-wide
// assignment, so "제품 책임자에게 알려줘" reaches whoever holds that role.
export async function resolveMember(text) {
  const s = String(text || '').replace(/(님|씨|에게|한테|께)$/u, '').trim()
  if (!s) return null
  const team = await listTeam()
  const hit = team.find((m) => m.email === s.toLowerCase()) || team.find((m) => m.name === s) ||
    team.find((m) => m.name?.length >= 2 && (m.name.includes(s) || s.includes(m.name)))
  if (hit) return { ...hit, via: 'name' }
  const [a] = await q(`select a.role, u.id, u.email, u.username as name from pro_role_assignments a
                       join users u on u.id=a.user_id and u.tenant_id=a.tenant_id
                       where a.tenant_id=$1 and a.proc_def_id='*' and (lower(a.role)=lower($2) or lower($2) like '%'||lower(a.role)||'%') limit 1`, [T(), s])
  return a ? { id: a.id, email: a.email, name: a.name, via: 'role', role: a.role } : null
}

// Human roles the tenant's processes use (agents' roles excluded), with the processes they appear in.
export async function roleCatalog() {
  const rows = await q(`select d.id, d.name, r->>'name' as role from proc_def d, jsonb_array_elements(coalesce(d.definition->'roles','[]'::jsonb)) r
                        where d.tenant_id=$1 and coalesce(d.isdeleted,false)=false and coalesce(r->>'origin','') <> 'used'`, [T()]).catch(() => [])
  // one entry per role whatever its capitals, named as the team assigned it (else as first written)
  const assigned = new Map((await q(`select distinct role from pro_role_assignments where tenant_id=$1`, [T()]).catch(() => [])).map((r) => [roleKey(r.role), r.role]))
  const by = {}, names = {}
  for (const r of rows) {
    if (!r.role) continue
    const k = roleKey(r.role)
    names[k] ??= assigned.get(k) || r.role
    ;(by[k] ||= []).push(r.name || r.id)
  }
  return Object.entries(by).map(([k, processes]) => ({ role: names[k], processes: [...new Set(processes)].slice(0, 6) }))
    .sort((a, b) => b.processes.length - a.processes.length || a.role.localeCompare(b.role, 'ko')).slice(0, 300)
}
