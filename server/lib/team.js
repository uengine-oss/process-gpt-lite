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

// Adding someone who never signed in creates their account, so work can be routed to them
// before their first visit.
export async function addMember(me, email, name) {
  const u = await ensureUser(String(email).trim().toLowerCase(), name)
  if (name) await q('update users set username=$1 where id=$2 and tenant_id=$3', [name, u.id, T()])
  await q(`insert into pro_team_members(tenant_id,user_id,added_by) values ($1,$2,$3) on conflict do nothing`, [T(), u.id, me.id])
  return { id: u.id, email: u.email, name: name || u.email.split('@')[0] }
}

export async function removeMember(userId) {
  await q('delete from pro_team_members where tenant_id=$1 and user_id=$2', [T(), userId])
  await q('delete from pro_role_assignments where tenant_id=$1 and user_id=$2', [T(), userId])
}

// The signed-in user is always on the team (the first one to look creates it).
export async function ensureMember(me) {
  await q(`insert into pro_team_members(tenant_id,user_id,added_by) values ($1,$2,$2) on conflict do nothing`, [T(), me.id])
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

// role name → user id for one process: the process-specific assignment wins over the tenant default.
export async function roleMap(defId) {
  const rows = await q(`select proc_def_id, role, user_id from pro_role_assignments where tenant_id=$1 and proc_def_id in ($2,'*')`,
    [T(), String(defId).toLowerCase()])
  const out = {}
  for (const r of rows.sort((a, b) => (a.proc_def_id === '*') - (b.proc_def_id === '*'))) out[r.role] ??= r.user_id
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
                       where a.tenant_id=$1 and a.proc_def_id='*' and (a.role=$2 or $2 like '%'||a.role||'%') limit 1`, [T(), s])
  return a ? { id: a.id, email: a.email, name: a.name, via: 'role', role: a.role } : null
}

// Human roles the tenant's processes use (agents' roles excluded), with the processes they appear in.
export async function roleCatalog() {
  const rows = await q(`select d.id, d.name, r->>'name' as role from proc_def d, jsonb_array_elements(coalesce(d.definition->'roles','[]'::jsonb)) r
                        where d.tenant_id=$1 and coalesce(d.isdeleted,false)=false and coalesce(r->>'origin','') <> 'used'`, [T()]).catch(() => [])
  const by = {}
  for (const r of rows) if (r.role) (by[r.role] ||= []).push(r.name || r.id)
  return Object.entries(by).map(([role, processes]) => ({ role, processes: [...new Set(processes)].slice(0, 6) }))
    .sort((a, b) => b.processes.length - a.processes.length || a.role.localeCompare(b.role, 'ko')).slice(0, 300)
}
