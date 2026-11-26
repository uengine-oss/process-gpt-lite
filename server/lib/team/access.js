// Who may hand what to whom: teammates of the one tenant (pro_team_members) only, never oneself, a
// role resolved through its tenant-wide holder, and a small per-user send budget.
import { config } from '../../config.js'
import { L } from '../lang.js'
import { q } from '../supa.js'
import { named } from '../people.js'

const T = () => config.tenantId

export class TeamError extends Error {
  constructor(status, message) { super(message); this.status = status }
}

export async function isMember(userId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(userId || ''))) return false
  const [r] = await q('select 1 from pro_team_members where tenant_id=$1 and user_id=$2', [T(), userId])
  if (r) return true
  return admitTenantPerson(userId)
}

// The ids among these that are not on the team, in one query for the usual case (everyone is) — each one missing is then asked as
// isMember asks (the gateway's first-sight admission). A room's post and an invite check all their people this way (a room has no size
// limit since 2026-11-27: one query, not one per person).
export async function notOnTeam(ids) {
  const list = [...new Set((ids || []).map(String))]
  const bad = list.filter((id) => !/^[0-9a-f-]{36}$/i.test(id))
  const ok = list.filter((id) => !bad.includes(id))
  const have = ok.length ? new Set((await q('select user_id::text as id from pro_team_members where tenant_id=$1 and user_id = any($2::uuid[])', [T(), ok])).map((r) => r.id)) : new Set()
  const out = [...bad]
  for (const id of ok.filter((x) => !have.has(x))) if (!(await isMember(id))) out.push(id)
  return out
}

// Behind the ProcessGPT gateway the team is the tenant's people (public.users): a ProcessGPT room holds
// colleagues who never opened Lite, and someone joined the team only on their first Lite visit
// (team.ensureMember) — so posting into such a room was refused ("…님은 더 이상 팀원이 아니에요"), and a
// meeting's 시작 failed before its agent ran (2026-11-18, the uengine 「단체」 room: 2 of 8 on the team).
// A person of the tenant is admitted on first sight there, unless an administrator removed them.
async function admitTenantPerson(userId) {
  if (!config.tenantFromHeader) return false
  const [a] = await q(`insert into pro_team_members(tenant_id,user_id,added_by)
                       select $1, u.id, u.id from users u
                       where u.id::text=$2 and u.tenant_id=$1 and not coalesce(u.is_agent,false)
                         and not exists (select 1 from pro_team_removed x where x.tenant_id=$1 and x.user_id=u.id)
                       on conflict do nothing returning user_id`, [T(), String(userId)])
  if (a) return true
  const [r] = await q('select 1 from pro_team_members where tenant_id=$1 and user_id=$2', [T(), userId])
  return !!r
}

export async function requireMember(user) {
  if (!(await isMember(user.id))) throw new TeamError(403, L('팀원끼리만 주고받을 수 있어요. 설정 → 팀·역할에서 팀에 추가해 달라고 해 주세요.', 'Only teammates can send to each other. Ask to be added to the team in Settings → Team & roles.'))
}

// teammates by id: name — the one every screen shows (lib/people.js); username — Process GPT's own (users.username, else the address's
// local part), for what is written into its rows (a share's handover_events — lib/mining/recorder.js)
export async function people(ids) {
  if (!ids.length) return []
  const rows = await q(`select u.id, u.email, u.username as name from pro_team_members m
            join users u on u.id=m.user_id and u.tenant_id=m.tenant_id
            where m.tenant_id=$1 and m.user_id = any($2::uuid[])`, [T(), ids])
  return (await named(rows)).map((p, i) => ({ ...p, username: rows[i].name || String(rows[i].email || '').split('@')[0] }))
}

// [{type:'user', id} | {type:'role', role}] → distinct teammates (not me). Anyone not on the team is a 403.
export async function resolveRecipients(me, to) {
  const list = Array.isArray(to) ? to.slice(0, 8) : []
  if (!list.length) throw new TeamError(400, L('받을 사람을 골라 주세요.', 'Please choose who receives it.'))
  const out = new Map()
  for (const r of list) {
    let id = null, via = null
    if (r?.type === 'role') {
      const [a] = await q(`select user_id from pro_role_assignments where tenant_id=$1 and proc_def_id='*' and role=$2`, [T(), String(r.role || '')])
      if (!a) throw new TeamError(400, L(`'${r.role}' 역할을 맡은 사람이 없어요.`, `Nobody holds the '${r.role}' role.`))
      id = a.user_id; via = String(r.role)
    } else id = String(r?.id || '')
    if (id === me.id) continue
    if (!(await isMember(id))) throw new TeamError(403, L('팀원에게만 보낼 수 있어요.', 'You can send only to teammates.'))
    if (!out.has(id)) out.set(id, via)
  }
  if (!out.size) throw new TeamError(400, L('본인에게는 보낼 수 없어요.', "You can't send it to yourself."))
  const rows = await people([...out.keys()])
  return rows.map((p) => ({ ...p, via: out.get(p.id) }))
}

// at most LIMIT sends per user in any minute (shares, mentions and messages together)
const LIMIT = 20
const sent = new Map() // userId -> [timestamps]
export function rateLimit(userId, cost = 1) {
  const now = Date.now()
  const list = (sent.get(userId) || []).filter((t) => now - t < 60000)
  if (list.length + cost > LIMIT) throw new TeamError(429, L('잠시 뒤에 다시 보내 주세요. 1분에 보낼 수 있는 양을 넘었어요.', 'Please send again in a moment. You went over what can be sent in a minute.'))
  for (let i = 0; i < cost; i++) list.push(now)
  sent.set(userId, list)
}
