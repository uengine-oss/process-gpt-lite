// Who may hand what to whom: teammates of the one tenant (pro_team_members) only, never oneself, a
// role resolved through its tenant-wide holder, and a small per-user send budget.
import { config } from '../../config.js'
import { L } from '../lang.js'
import { q } from '../supa.js'

const T = () => config.tenantId

export class TeamError extends Error {
  constructor(status, message) { super(message); this.status = status }
}

export async function isMember(userId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(userId || ''))) return false
  const [r] = await q('select 1 from pro_team_members where tenant_id=$1 and user_id=$2', [T(), userId])
  return !!r
}

export async function requireMember(user) {
  if (!(await isMember(user.id))) throw new TeamError(403, L('팀원끼리만 주고받을 수 있어요. 설정 → 팀·역할에서 팀에 추가해 달라고 해 주세요.', 'Only teammates can send to each other. Ask to be added to the team in Settings → Team & roles.'))
}

export async function people(ids) {
  if (!ids.length) return []
  return q(`select u.id, u.email, u.username as name from pro_team_members m
            join users u on u.id=m.user_id and u.tenant_id=m.tenant_id
            where m.tenant_id=$1 and m.user_id = any($2::uuid[])`, [T(), ids])
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
  return rows.map((p) => ({ ...p, name: p.name || p.email.split('@')[0], via: out.get(p.id) }))
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
