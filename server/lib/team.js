// Teammates and who plays which process role. A process step goes to the person bound to its
// role; process-gpt's todolist trigger then notifies exactly that person.
import { config } from '../config.js'
import { q, ensureUser, APPROVED, ADMINISH } from './supa.js'
// the name every screen shows (lib/people.js), not users.username alone
import { named, forget } from './people.js'
// an approved membership (lib/membership.js): someone waiting for an administrator or let go is nobody's teammate here
import { admit, claimCompany } from './membership.js'

const T = () => config.tenantId

// the team with the names every screen shows; withUsername: Process GPT's username too (resolveMember matches what people type
// against either)
// admin: an administrator of the company (users.is_admin · its admin role · the tenant's owner) — the screens keep the last one
async function teamRows({ withUsername = false } = {}) {
  const rows = await q(`select u.id, u.email, u.username as name,
              ${ADMINISH('u')}
                or exists (select 1 from tenants t where t.id = u.tenant_id and t.owner::text = u.id::text) as admin
            from pro_team_members m
            join users u on u.id = m.user_id and u.tenant_id = m.tenant_id
            where m.tenant_id=$1 and ${APPROVED('u')} order by m.created_at`, [T()])
  return (await named(rows)).map((p, i) => (withUsername ? { ...p, username: rows[i].name } : p))
}
export const listTeam = () => teamRows()

// Who may change the team and the tenant-wide role holders: process-gpt's tenant administrators —
// users.is_admin, or the tenant's owner (tenants.owner, process-gpt checkTenantOwner).
// (an approved one: Process GPT's own check, membership_admin(), asks for the approved row too)
export async function isAdmin(me) {
  const [r] = await q(`select (select coalesce(bool_or(${ADMINISH('u')}), false) from users u where u.id::text=$1 and u.tenant_id=$2 and ${APPROVED('u')})
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
// The first one makes the company (lib/membership.js claimCompany): its owner — only if nobody is yet — and an approved administrator.
// → whether they did (false: the company had someone already, or another first person won).
export async function claimFirstAdmin(userId) {
  const [u] = await q('select email, username from users where id=$1 and tenant_id=$2', [userId, T()]).catch(() => [])
  const email = u?.email || (await q('select email from auth.users where id=$1', [userId]).catch(() => []))[0]?.email || ''
  return claimCompany(userId, email, u?.username || null)
}

// Adding someone who never signed in creates their account, so work can be routed to them
// before their first visit.
// An administrator adding someone is their invitation (approved — lib/membership.js admit), without the invitation mail (「초대」 sends it).
export async function addMember(me, email, name) {
  const u = await ensureUser(String(email).trim().toLowerCase(), name)
  await admit(u.id, u.email, name, me.id)
  if (name) await q('update users set username=$1 where id=$2 and tenant_id=$3', [name, u.id, T()])
  if (name) forget(u.id)
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
  return named(await q(`select a.proc_def_id, a.role, a.user_id, u.username as name, u.email from pro_role_assignments a
            join users u on u.id = a.user_id and u.tenant_id = a.tenant_id
            where a.tenant_id=$1 and ($2::text is null or a.proc_def_id in ($2, '*'))
            order by a.proc_def_id <> '*', a.role`, [T(), defId ? defId.toLowerCase() : null]), { id: 'user_id' })
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
  const team = await teamRows({ withUsername: true })
  // (the name every screen uses, and Process GPT's username: 「서연님」 finds the one whose username is 김서연 while Lite calls her
  // Seoyeon Kim)
  const part = (n) => !!n && n.length >= 2 && (n.includes(s) || s.includes(n))
  const hit = team.find((m) => m.email === s.toLowerCase()) || team.find((m) => m.name === s || m.username === s) ||
    team.find((m) => part(m.name) || part(m.username))
  if (hit) { const { username, ...p } = hit; return { ...p, via: 'name' } }
  const [a] = await q(`select a.role, u.id, u.email, u.username as name from pro_role_assignments a
                       join users u on u.id=a.user_id and u.tenant_id=a.tenant_id and ${APPROVED('u')}
                       where a.tenant_id=$1 and a.proc_def_id='*' and (lower(a.role)=lower($2) or lower($2) like '%'||lower(a.role)||'%') limit 1`, [T(), s])
  return a ? { ...(await named([{ id: a.id, email: a.email, name: a.name }]))[0], via: 'role', role: a.role } : null
}

// Human roles the tenant's processes use (agents' roles excluded), with the processes they appear in.
export async function roleCatalog() {
  const rows = await q(`select d.id, d.name, r->>'name' as role from proc_def d, jsonb_array_elements(coalesce(d.definition->'roles','[]'::jsonb)) r
                        where d.tenant_id=$1 and coalesce(d.isdeleted,false)=false and coalesce(r->>'origin','') <> 'used'`, [T()]).catch(() => [])
  // one entry per role whatever its capitals, named as the team assigned it (else as first written)
  const assigned = new Map((await q(`select distinct role from pro_role_assignments where tenant_id=$1`, [T()]).catch(() => [])).map((r) => [roleKey(r.role), r.role]))
  const by = {}, names = {}, defs = {}
  for (const r of rows) {
    if (!r.role) continue
    const k = roleKey(r.role)
    names[k] ??= assigned.get(k) || r.role
    ;(by[k] ||= []).push(r.name || r.id)
    ;(defs[k] ||= new Map()).set(r.id.toLowerCase(), r.name || r.id)
  }
  // defs: the processes using the role (id → name), so a process's own holder can be shown and changed
  return Object.entries(by).map(([k, processes]) => ({ role: names[k], processes: [...new Set(processes)].slice(0, 6), defs: Object.fromEntries(defs[k]) }))
    .sort((a, b) => b.processes.length - a.processes.length || a.role.localeCompare(b.role, 'ko')).slice(0, 300)
}
