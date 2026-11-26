// Who may come into a company (2026-11-25 사용자: 「URL만 있으면 소셜 로그인으로 바로 그냥 로그인 되버리나? 그래서는 안되고 우리가
// 초대를 해준 사람에 한해서만 로그인 할 수 있는 거야 … 소셜 로그인 된다고 해서 그냥 바로 가입이 되면 안 돼 로그인이 되어서도 안되고」).
//
// A company's people are its approved members: public.users rows of the tenant with membership_status 'approved' (Process GPT's 가입
// 승인 — vue3 migrations 20260908000001 · 20261119000001; a database without the column counts every row approved — lib/supa.js STATUS)
// and the company's owner. Someone else who signs in — Google (Process GPT's Supabase behind the gateway, or an install's own client) or
// an e-mail code — is refused before a session is kept. The refusal screen offers 「가입 요청 보내기」: pressing it keeps a join request in
// Lite's own table (pro_join_requests, sql/058) — not a users row, so it works the same whether or not the deployment approves new rows
// by itself (membership_settings.require_approval). A sign-up waiting in Process GPT (a 'pending' users row) is a request too. An
// administrator invites people (Process GPT's own invite: completion POST /invite-user — the same account, row and mail as its 「사용자
// 초대」 — or, on an install without the process engine, the same steps here), approves or declines requests, and ends a membership
// (「내보내기」: the row becomes 'rejected', and everything the person could still reach Lite with ends — endAccess). Rows already there
// stay as they are.
//
// A membership row is only ever made here (addRow), as 'pending', and approved right after by whoever lets the person in — never in
// passing (lib/supa.js ensureUser makes the account only).
//
// Joining an existing company needs an invitation. Making a new one does not: Process GPT's tenant creation approves its owner, and an
// install's first person in becomes its owner and administrator (claimCompany — one person only, even when two sign in at once). The
// local demo code (PRO_DEMO_LOGIN, never on in production or the install bundle) proves nothing about an address — anyone can type an
// administrator's — so on an install it still signs up a new address as before (the dev stack's tests); behind the gateway it lets in
// members only, as it always has.
import crypto from 'node:crypto'
import { config } from '../config.js'
import { q, pool, admin as supabase, normEmail, authUserByEmail, ensureUser, memberStatus, forgetMember, STATUS, APPROVED, ADMINISH } from './supa.js'
import { L } from './lang.js'
import { named, localPart, displayName, forget as forgetName } from './people.js'

const T = () => config.tenantId
const gateway = () => !!config.tenantFromHeader
export const EMAIL = /^[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export class MemberError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; Object.assign(this, extra) }
}

// whether this database has the status column (Process GPT's 가입 승인, or Lite's sql/058): without it a membership cannot wait or end.
// Asked again every minute — a migration can come while the server runs.
let column = { at: 0, has: false }
export async function hasStatusColumn(query = q) {
  if (query === q && Date.now() - column.at < 60_000) return column.has
  const [r] = await query(`select exists (select 1 from pg_attribute where attrelid = 'users'::regclass and attname = 'membership_status' and not attisdropped) as has`)
  if (query === q) column = { at: Date.now(), has: !!r?.has }
  return !!r?.has
}
const hasTable = async (name, query = q) => !!(await query('select to_regclass($1) is not null as has', [name]))[0]?.has

// ---------- what the refused person sees ----------
// {code, title, detail, pending, company, email, canRequest, ticket}: the sentences in the request's language. company: the tenant
// (Process GPT names a company by its address, <tenant>.process-gpt.io). canRequest: the screen offers 「가입 요청 보내기」, with the
// ticket that proves who signed in (the session is gone by then — POST /api/auth/join-request).
export function refusal({ pending = false, email = '', tenant = T(), canRequest = false, ticket = null } = {}) {
  const title = L('초대받은 분만 들어올 수 있어요.', 'Only invited people can come in.')
  const detail = pending
    ? L('가입 요청을 보냈어요 · 관리자가 승인하면 들어올 수 있어요', 'Your request to join was sent · you can come in once an administrator approves it')
    : L('이 회사의 관리자에게 초대를 요청해 주세요.', 'Please ask an administrator of this company for an invitation.')
  return { code: 'invite_only', error: `${title} ${detail}`, title, detail, pending: !!pending, company: tenant, email: email || '',
    canRequest: !!(canRequest && ticket), ...(canRequest && ticket ? { ticket } : {}) }
}

// ---------- the ticket a refused sign-in may ask to join with ----------
// "pgj1.<payload>.<signature>": {sub, email, tenant, exp} for 30 minutes, signed with a key derived from the service key (as the folder
// git tokens are) — only someone whose sign-in proved the address gets one.
const TICKET_MIN = 30
const ticketKey = () => {
  if (!config.serviceKey) throw new Error('join tickets need SERVICE_ROLE_KEY')
  return crypto.createHmac('sha256', String(config.serviceKey)).update('join-request:v1').digest()
}
const signTicket = (body) => crypto.createHmac('sha256', ticketKey()).update(`pgj1.${body}`).digest('base64url')
export function joinTicket({ userId, email, tenant = T(), now = Date.now() }) {
  const body = Buffer.from(JSON.stringify({ sub: String(userId), email: normEmail(email), tenant, exp: Math.floor(now / 1000) + TICKET_MIN * 60 })).toString('base64url')
  return `pgj1.${body}.${signTicket(body)}`
}
export function readTicket(t, { now = Date.now() } = {}) {
  const m = /^pgj1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(String(t || ''))
  if (!m) return null
  const want = Buffer.from(signTicket(m[1]), 'base64url'), got = Buffer.from(m[2], 'base64url')
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null
  let c
  try { c = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8')) } catch { return null }
  if (!c || !UUID.test(String(c.sub || '')) || typeof c.tenant !== 'string' || !Number.isFinite(c.exp) || c.exp * 1000 <= now) return null
  return c
}

// ---------- requests ----------
// Lite's own record of a request (pro_join_requests: pending · approved · rejected), this tenant's
export async function requestOf(userId, query = q) {
  if (!UUID.test(String(userId || ''))) return null
  return (await query('select * from pro_join_requests where tenant_id=$1 and user_id=$2', [T(), String(userId)]).catch(() => []))[0] || null
}
// where a person stands here: 'approved' · 'pending' (a sign-up waiting in Process GPT, or a request kept here) · 'rejected' (declined or
// let go) · null (nothing yet)
export async function standing(userId, query = q) {
  const s = await memberStatus(userId, T(), query)
  if (s) return s
  const r = await requestOf(userId, query)
  return r?.status === 'pending' || r?.status === 'rejected' ? r.status : null
}
// 「가입 요청 보내기」: kept once (pressing again changes nothing); someone declined or let go is not asked again → where they stand now
export async function keepRequest({ userId, email, name = null }, query = q) {
  const now = await standing(userId, query)
  if (now) return now
  const addr = normEmail(email)
  await query(`insert into pro_join_requests (tenant_id, user_id, email, name) values ($1,$2,$3,$4) on conflict (tenant_id, user_id) do nothing`,
    [T(), String(userId), addr, name || localPart(addr) || addr])
  return standing(userId, query)
}

// The button is open to anyone who can sign in somewhere, so it has limits:
//   - one person presses at most once a minute (per company)
//   - one address asks at most PRO_JOIN_REQUESTS_PER_ADDRESS_PER_DAY companies a day (3) — throwaway accounts cannot ask everywhere
//   - a company takes at most PRO_JOIN_REQUESTS_PER_HOUR new requests an hour (30), counting only those still waiting: requests an
//     administrator declined free their place, so a burst of throwaway requests the administrator turns down does not keep real people
//     out for the rest of the hour
const PER_HOUR = () => Math.max(1, Number(process.env.PRO_JOIN_REQUESTS_PER_HOUR) || 30)
const PER_ADDRESS_DAY = () => Math.max(1, Number(process.env.PRO_JOIN_REQUESTS_PER_ADDRESS_PER_DAY) || 3)
const AGAIN_MS = 60_000
const pressed = new Map() // tenant|user → at
export async function requestToJoin(ticket) {
  const c = readTicket(ticket)
  if (!c) throw new MemberError(400, L('요청할 수 있는 시간이 지났어요. 다시 로그인한 뒤 요청해 주세요.', 'The time to send a request has passed. Sign in again, then send it.'))
  if (c.tenant !== T()) throw new MemberError(403, L('이 회사의 요청이 아니에요.', 'This request is not for this company.'))
  const k = `${c.tenant}|${c.sub}`, at = pressed.get(k)
  if (at && Date.now() - at < AGAIN_MS) throw new MemberError(429, L('잠시 뒤에 다시 눌러 주세요.', 'Please try again in a moment.'))
  pressed.set(k, Date.now())
  if (pressed.size > 5000) for (const [x, t] of pressed) if (Date.now() - t > AGAIN_MS) pressed.delete(x)
  const was = await standing(c.sub)
  if (!was) {
    const [a] = await q(`select count(*)::int as n from pro_join_requests where email=$1 and created_at > now() - interval '1 day'`, [normEmail(c.email)])
    if ((a?.n || 0) >= PER_ADDRESS_DAY()) throw new MemberError(429, L('오늘은 이 주소로 더 요청할 수 없어요. 내일 다시 보내 주세요.', "This address can't send more requests today. Please send it again tomorrow."))
    const [n] = await q(`select count(*)::int as n from pro_join_requests where tenant_id=$1 and status='pending' and created_at > now() - interval '1 hour'`, [T()])
    if ((n?.n || 0) >= PER_HOUR()) throw new MemberError(429, L('지금은 가입 요청이 많아요. 잠시 뒤에 다시 보내 주세요.', 'Too many requests to join right now. Please send it again later.'))
  }
  // (the name they go by, by the rule every screen uses — the auth record's own name, a Google sign-in's: lib/people.js displayName)
  const { data } = await supabase.auth.admin.getUserById(c.sub).catch(() => ({ data: null }))
  const md = data?.user?.user_metadata || {}
  const name = displayName({ email: c.email, metaName: md.name, metaFullName: md.full_name }) || null
  const now = await keepRequest({ userId: c.sub, email: c.email, name })
  return refusal({ pending: now === 'pending', email: c.email })
}

// The decision for a sign-in that proved an address (an e-mail code, Google) — before any session is given:
//   {ok: true}                          an approved member
//   {ok: true, first: true}             the first person of a company nobody runs yet (install) — finishLogin claims it, or refuses
//   {ok: true, demo: true}              the demo code on an install (development)
//   {ok: false, refusal}                anyone else: what their screen says, and — when they have an account and nothing is pending or
//                                       declined — the ticket to ask to join with. Nothing is written.
export async function decideSignIn(email0, { demo = false } = {}) {
  const email = normEmail(email0)
  const account = await authUserByEmail(email).catch(() => null)
  const status = account ? await memberStatus(account.id, T()) : null
  if (status === 'approved') return { ok: true }
  if (!gateway() && !status) {
    if (!(await companyHasAdmin())) return { ok: true, first: true }
    if (demo) return { ok: true, demo: true }
  }
  return { ok: false, refusal: await refusalFor(account, email) }
}
async function refusalFor(account, email) {
  const now = account ? await standing(account.id) : null
  const canRequest = !!account && !now
  return refusal({ pending: now === 'pending', email, canRequest, ticket: canRequest ? joinTicket({ userId: account.id, email }) : null })
}
// The same for someone already holding a session (Google through Process GPT's Supabase, a Process GPT session taken from its cookies)
export async function refuseSession(user) {
  if ((await memberStatus(user.id, T())) === 'approved') return { ok: true }
  return { ok: false, refusal: await refusalFor(user, user.email) }
}

// An administrator (or owner) of this company already, among its approved people — no one: the first person in becomes it (install)
export async function companyHasAdmin(query = q) {
  const [r] = await query(`select exists (select 1 from users u where u.tenant_id=$1 and ${ADMINISH('u')} and not coalesce(u.is_agent,false) and ${APPROVED('u')})
                             or exists (select 1 from tenants where id=$1 and owner is not null) as has`, [T()]).catch(() => [{ has: true }])
  return !!r?.has
}
// The first person makes the company: they become its owner only if nobody is yet (one conditional update — of two people signing in at
// once, one wins), then their row, approved as its administrator. → whether they did.
export async function claimCompany(userId, email, name, query = q) {
  if (await companyHasAdmin(query)) return false
  const [won] = await query('update tenants set owner=$1 where id=$2 and owner is null returning id', [String(userId), T()]).catch(() => [])
  if (!won) return false
  await addRow(userId, email, name, query)
  await approveRow(userId, { admin: true, by: userId }, query)
  console.log(`[members] ${String(userId).slice(0, 8)} made ${T()} and is its first administrator`)
  return true
}

// ---------- rows ----------
// A membership row, as 'pending' (where the column is) — whoever lets the person in approves it right after. Process GPT's approval
// trigger may approve it on its own (a deployment without approval): the approval that follows is the same.
export async function addRow(userId, email0, name, query = q) {
  const email = normEmail(email0)
  const status = await hasStatusColumn(query)
  await query(`insert into users (id, username, email, tenant_id, role, is_admin, is_agent, is_draft${status ? ', membership_status' : ''})
               values ($1, $2, $3, $4, 'user', false, false, false${status ? ", 'pending'" : ''}) on conflict (id, tenant_id) do nothing`,
  [String(userId), name || localPart(email) || email, email, T()])
  forgetMember(userId)
}
// A row made a member: approved, and the requests about it closed as approved by who did it. Its role stays as it is (editor, reviewer,
// admin …); an empty one — or 'viewer' on a row that was waiting or let go, which is what Process GPT's approval trigger and endRow leave
// there, not a role anyone chose — becomes 'user' (Process GPT's invite); an invitation as administrator makes it 'admin'. Process GPT's approval trigger
// turns a newly inserted row into 'pending' (its own invite's row too) — this is the approval that follows. Without the column: nothing
// to approve, the row is the membership.
export async function approveRow(userId, { admin = false, by = null } = {}, query = q) {
  if (await hasStatusColumn(query)) {
    await query(`update users set membership_status = 'approved',
                   role = case when $3 then 'admin'
                               when coalesce(role, '') = '' then 'user'
                               when lower(role) = 'viewer' and coalesce(to_jsonb(users)->>'membership_status', 'approved') <> 'approved' then 'user'
                               else role end,
                   is_admin = case when $3 then true else coalesce(is_admin, false) end
                 where id = $1 and tenant_id = $2`, [String(userId), T(), !!admin])
  } else if (admin) {
    await query(`update users set role = 'admin', is_admin = true where id = $1 and tenant_id = $2`, [String(userId), T()])
  }
  await closeRequest(userId, 'approved', by, query)
  forgetMember(userId)
}
async function closeRequest(userId, status, by, query = q) {
  await query(`update pro_join_requests set status = $3, reviewed_by = $4, reviewed_at = now() where tenant_id = $2 and user_id = $1 and status <> $3`,
    [String(userId), T(), status, by ? String(by) : null]).catch((e) => console.warn('[members] request close', e.message))
  if (!(await hasTable('signup_requests', query))) return
  await query(`update signup_requests set status = $3, reviewed_by = $4, reviewed_at = now(), updated_at = now(),
                 reject_reason = case when $3 = 'rejected' then reject_reason else null end
               where user_id = $1 and tenant_id = $2 and status = 'pending'`, [String(userId), T(), status, by ? String(by) : null])
    .catch((e) => console.warn('[members] request close', e.message))
}
// a row's membership ended (a request declined, a member let go): 'rejected', no role, not an administrator — Process GPT's reject
export async function endRow(userId, by, query = q) {
  if (!(await hasStatusColumn(query))) {
    throw new MemberError(409, L('이 회사의 데이터베이스는 아직 가입 상태를 저장하지 못해요. 관리자가 Lite 의 SQL(058)을 적용해야 해요.',
      "This company's database can't keep membership states yet. An administrator needs to apply Lite's SQL (058)."))
  }
  await query(`update users set membership_status = 'rejected', role = 'viewer', is_admin = false where id = $1 and tenant_id = $2`, [String(userId), T()])
  await closeRequest(userId, 'rejected', by, query)
  forgetMember(userId)
}

const onTeam = async (userId, by) => {
  await q('delete from pro_team_removed where tenant_id=$1 and user_id=$2', [T(), userId])
  await q('insert into pro_team_members(tenant_id,user_id,added_by) values ($1,$2,$3) on conflict do nothing', [T(), userId, by])
}

// The people waiting, oldest first: rows of this tenant with 'pending' (a sign-up in Process GPT) and Lite's own requests of people with no
// row here — with when they asked
export async function listRequests() {
  const withSignups = await hasTable('signup_requests')
  const rows = (await hasStatusColumn())
    ? await q(`select u.id::text as id, u.email, u.username as name${withSignups ? ', s.created_at as asked_at' : ', null::timestamptz as asked_at'}
               from users u ${withSignups ? 'left join signup_requests s on s.user_id = u.id and s.tenant_id = u.tenant_id' : ''}
               where u.tenant_id = $1 and ${STATUS('u')} = 'pending' and not coalesce(u.is_agent, false) limit 200`, [T()])
    : []
  const kept = await q(`select r.user_id::text as id, r.email, r.name, r.created_at as asked_at from pro_join_requests r
                        where r.tenant_id = $1 and r.status = 'pending'
                          and not exists (select 1 from users u where u.id = r.user_id and u.tenant_id = r.tenant_id) limit 200`, [T()]).catch(() => [])
  const all = [...rows, ...kept.filter((k) => !rows.some((r) => r.id === k.id))]
    .sort((a, b) => (a.asked_at ? new Date(a.asked_at) : Infinity) - (b.asked_at ? new Date(b.asked_at) : Infinity) || String(a.email).localeCompare(String(b.email)))
  return (await named(all)).map((r) => ({ id: r.id, email: r.email, name: r.name, askedAt: r.asked_at }))
}

async function rowOf(userId, query = q) {
  if (!UUID.test(String(userId || ''))) return null
  const [r] = await query(`select u.id::text as id, u.email, ${STATUS('u')} as status, ${ADMINISH('u')} as admin,
                         coalesce(u.is_agent,false) as agent, exists (select 1 from tenants t where t.id = u.tenant_id and t.owner::text = u.id::text) as owner
                       from users u where u.id = $1 and u.tenant_id = $2`, [String(userId), T()])
  return r || null
}
const notFound = () => new MemberError(404, L('이 회사에서 그 사람을 찾지 못했어요.', "That person isn't in this company."))

export async function approve(me, userId) {
  const r = await rowOf(userId)
  if (r) {
    if (r.agent || r.status === 'approved') throw notFound()
    await approveRow(r.id, { by: me.id })
    await onTeam(r.id, me.id)
    return { id: r.id, email: r.email, status: 'approved' }
  }
  // a request kept here: the row is made now, then approved
  const req = await requestOf(userId)
  if (!req || req.status !== 'pending') throw notFound()
  await addRow(req.user_id, req.email, req.name)
  await approveRow(req.user_id, { by: me.id })
  await onTeam(String(req.user_id), me.id)
  forgetName(req.user_id)
  return { id: String(req.user_id), email: req.email, status: 'approved' }
}
export async function reject(me, userId) {
  const r = await rowOf(userId)
  if (r) {
    if (r.agent || r.status !== 'pending') throw notFound()
    await endRow(r.id, me.id)
    return { id: r.id, email: r.email, status: 'rejected' }
  }
  const req = await requestOf(userId)
  if (!req || req.status !== 'pending') throw notFound()
  await closeRequest(req.user_id, 'rejected', me.id)
  return { id: String(req.user_id), email: req.email, status: 'rejected' }
}

// Who else runs the company if this person goes: approved administrators and the owner, people only
async function otherAdmins(userId, query = q) {
  const [r] = await query(`select count(*)::int as n from users u where u.tenant_id = $1 and u.id::text <> $2 and not coalesce(u.is_agent,false) and ${APPROVED('u')}
                         and (${ADMINISH('u')} or exists (select 1 from tenants t where t.id = u.tenant_id and t.owner::text = u.id::text))`, [T(), String(userId)])
  return r?.n || 0
}
// 「내보내기」: not oneself, not the company's owner, not the last administrator
export async function removable(me, userId, row = null) {
  if (String(userId) === String(me.id)) return false
  const r = row || await rowOf(userId)
  if (!r || r.owner) return false
  return !r.admin || (await otherAdmins(userId)) > 0
}
// the same for a whole list (GET /api/team), in one query: the company's administrators (approved, people) and its owner
export async function removableAll(me, list) {
  const [r] = await q(`select (select owner::text from tenants where id = $1) as owner,
                         coalesce((select array_agg(u.id::text) from users u where u.tenant_id = $1 and not coalesce(u.is_agent,false) and ${APPROVED('u')}
                                     and ${ADMINISH('u')}), '{}') as admins`, [T()])
  const admins = new Set([...(r?.admins || []), ...(r?.owner ? [r.owner] : [])])
  return list.map((m) => {
    const id = String(m.id)
    return { ...m, removable: id !== String(me.id) && id !== r?.owner && !(admins.has(id) && admins.size <= 1) }
  })
}
// The checks and the change in one transaction, one membership change of this company at a time (an advisory lock on the tenant): two
// administrators letting each other go at once cannot leave the company with none.
export async function remove(me, userId) {
  if (String(userId) === String(me.id)) throw new MemberError(400, L('나 자신은 내보낼 수 없어요.', "You can't remove yourself."))
  const c = await pool.connect()
  const tx = (sql, p) => c.query(sql, p).then((x) => x.rows)
  let r
  try {
    await c.query('begin')
    await c.query("select pg_advisory_xact_lock(hashtext('pgl-membership:' || $1))", [T()])
    r = await rowOf(userId, tx)
    if (!r || r.agent || r.status !== 'approved') throw notFound()
    if (r.owner) throw new MemberError(400, L('회사를 만든 사람은 내보낼 수 없어요.', "The person who made the company can't be removed."))
    if (r.admin && (await otherAdmins(r.id, tx)) === 0) throw new MemberError(400, L('마지막 관리자는 내보낼 수 없어요. 다른 관리자를 먼저 정해 주세요.', "The last administrator can't be removed. Make someone else an administrator first."))
    await endRow(r.id, me.id, tx)
    await c.query('commit')
  } catch (e) {
    await c.query('rollback').catch(() => {})
    throw e
  } finally { c.release() }
  forgetMember(r.id)
  const team = await import('./team.js')
  await team.removeMember(r.id, me.id)
  await endAccess(r.id)
  return { id: r.id, email: r.email, status: 'rejected' }
}

// Everything a person let go could still reach this company with ends: their linked desktops' tokens here, their places in this
// company's rooms, direct conversations, shared folders and live meetings, this company's routines (paused), and the event streams they
// opened for this company. Their auth sessions are the account's, not a company's: they end only when the person is an approved member
// of no other company — someone who also works elsewhere stays signed in there (and in Process GPT), and this company's door (every
// request, the MCP gateways, folder git, desktops) is closed to them all the same. (A folder git token names its person and is checked at
// each request — lib/folders/gitHttp.js.) Each step on its own: one that fails is logged, not fatal. → {sessions: whether they ended}
export async function endAccess(userId) {
  const id = String(userId), t = T()
  const step = async (what, sql, p) => q(sql, p).catch((e) => { console.warn(`[members] end access: ${what}`, e.message); return [] })
  const [elsewhere] = await step('other companies', `select exists (select 1 from users u where u.id = $1::uuid and u.tenant_id <> $2 and ${APPROVED('u')}) as yes`, [id, t])
  const sessions = !elsewhere?.yes
  if (sessions) {
    await step('sessions', 'delete from auth.sessions where user_id = $1::uuid', [id])
    await step('refresh tokens', 'delete from auth.refresh_tokens where user_id = $1', [id])
  }
  await step('desktops', 'update pro_local_devices set revoked_at = coalesce(revoked_at, now()) where tenant_id = $2 and user_id = $1::uuid', [id, t])
  await step('rooms', `update chat_rooms set participants = (select coalesce(jsonb_agg(p), '[]'::jsonb) from jsonb_array_elements(participants) p where p->>'id' is distinct from $1)
                       where tenant_id = $2 and participants @> jsonb_build_array(jsonb_build_object('id', $1::text))`, [id, t])
  await step('direct conversations', 'delete from pro_dm_members m using pro_dm_threads d where m.thread_id = d.id and d.tenant_id = $2 and m.user_id = $1::uuid', [id, t])
  await step('folders', `delete from pro_folder_members m using pro_folders f where m.folder_id = f.id and f.tenant_id = $2 and m.principal_type = 'user' and m.principal_id = $1`, [id, t])
  await step('meetings', `delete from pro_meeting_participants p using pro_meetings m where p.meeting_id = m.id and m.tenant_id = $2 and m.state = 'live' and p.user_id = $1::uuid`, [id, t])
  await step('routines', 'update pro_schedules set paused = true where user_id = $1::uuid and tenant_id = $2', [id, t])
  const { closeStreams } = await import('./bus.js')
  closeStreams(id, t)
  return { sessions }
}

// ---------- invitations ----------
// Process GPT's invite (completion POST /invite-user, services/completion/database.py invite_user): an address without an account gets
// Supabase's invitation mail (a link to set a password) and an account; one with an account gets Process GPT's 「테넌트에 초대되었습니다」
// mail; either way a users row of the tenant (role 'user', is_admin as asked). The tenant goes in the input and, as completion reads it,
// in X-Forwarded-Host. → {userId} or null when completion is not there (an install without the process engine) or refused.
async function inviteThroughProcessGpt(email, isAdmin) {
  const url = String(config.completionUrl || '').replace(/\/$/, '')
  if (!url) return null
  try {
    const r = await fetch(`${url}/invite-user`, {
      method: 'POST', signal: AbortSignal.timeout(20_000),
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-Host': `${T()}.process-gpt.local` },
      body: JSON.stringify({ input: { email, is_admin: !!isAdmin, tenant_id: T() } }),
    })
    if (!r.ok) { console.warn('[members] completion invite-user', r.status, (await r.text()).slice(0, 200)); return null }
    const j = await r.json().catch(() => ({}))
    return { userId: j.user_id || (await authUserByEmail(email))?.id || null, mailed: true }
  } catch (e) {
    console.warn('[members] completion invite-user unreachable:', e.message)
    return null
  }
}

// The same steps here: Supabase's invitation mail for a new address (the link brings them to this Lite's sign-in), the account without
// the mail when the auth server cannot send one (no mail server), and the users row. An address that already has an account gets no mail
// from here (Process GPT's existing-account mail needs its SMTP): the administrator tells them.
async function inviteHere(email) {
  let mailed = false
  if (!(await authUserByEmail(email))) {
    const { error } = await supabase.auth.admin.inviteUserByEmail(email, {
      redirectTo: `${String(config.publicUrl).replace(/\/$/, '')}/login`, data: { name: localPart(email), tenant_id: T() },
    })
    if (error) console.warn('[members] invitation mail:', error.message)
    else mailed = true
  }
  const user = await ensureUser(email, localPart(email))
  await addRow(user.id, email, localPart(email))
  return { userId: user.id, mailed }
}

// emails: one or more addresses (a list, or text with commas, spaces or lines between them). → one result per address:
//   {email, result: 'invited' (mailed: true|false) | 'approved' (was waiting or let go) | 'member' (already in) | 'invalid'}
export async function invite(me, emails, { admin = false } = {}) {
  const list = [...new Set((Array.isArray(emails) ? emails : String(emails || '').split(/[\s,;]+/)).map(normEmail).filter(Boolean))]
  if (!list.length) throw new MemberError(400, L('초대할 이메일 주소를 적어 주세요.', 'Please enter the e-mail addresses to invite.'))
  if (list.length > 20) throw new MemberError(400, L('한 번에 20명까지 초대할 수 있어요.', 'You can invite up to 20 people at a time.'))
  const out = []
  for (const email of list) {
    if (!EMAIL.test(email)) { out.push({ email, result: 'invalid' }); continue }
    try { out.push(await inviteOne(me, email, admin)) } catch (e) {
      console.warn('[members] invite', e.message)
      out.push({ email, result: 'failed', error: e.status ? e.message : L('초대하지 못했어요.', "Couldn't invite.") })
    }
  }
  return out
}
async function inviteOne(me, email, admin) {
  const account = await authUserByEmail(email)
  const status = account ? await memberStatus(account.id, T()) : null
  if (status === 'approved') return { email, id: account.id, result: 'member' }
  if (status === 'pending') {
    // they asked (a sign-up waiting here): the invitation is the approval
    await approveRow(account.id, { admin, by: me.id })
    await onTeam(account.id, me.id)
    return { email, id: account.id, result: 'approved' }
  }
  if (status === 'rejected') {
    // declined or let go before: invited again the way a new address is — with a mail telling them, never by a quiet flip
    const mailed = await tellInvited(email)
    await approveRow(account.id, { admin, by: me.id })
    await onTeam(account.id, me.id)
    return { email, id: account.id, result: 'invited', mailed }
  }
  let done = await inviteThroughProcessGpt(email, admin)
  // (completion answered but left no row here — the person still needs one)
  if (done?.userId && !(await memberStatus(done.userId, T()))) done = { ...(await inviteHere(email)), mailed: done.mailed }
  if (!done?.userId) done = await inviteHere(email)
  // the row Process GPT (or addRow) made — 'pending' — approved by this invitation; a request they had kept is closed with it
  await approveRow(done.userId, { admin, by: me.id })
  await onTeam(done.userId, me.id)
  forgetName(done.userId)
  return { email, id: done.userId, result: 'invited', mailed: !!done.mailed }
}

// an administrator added someone without an invitation mail (「+ 팀원 추가」, POST /api/team), or the demo code let a new address in:
// their row made if missing, and approved. Someone declined or let go before is told by mail, as a re-invitation is.
export async function admit(userId, email, name, by) {
  const was = await memberStatus(userId, T())
  if (was === 'approved') return
  if (was === 'rejected' && email) await tellInvited(email)
  await addRow(userId, email, name)
  await approveRow(userId, { by })
}

// The mail an address with an account gets when invited (again): the auth server's sign-in mail, its link back to this Lite's sign-in
// (Process GPT's own 「테넌트에 초대되었습니다」 mail goes only through its invite of a new row). → whether the auth server took it.
async function tellInvited(email) {
  const r = await fetch(`${config.supabaseUrl}/auth/v1/otp?redirect_to=${encodeURIComponent(`${String(config.publicUrl).replace(/\/$/, '')}/login`)}`, {
    method: 'POST', headers: { apikey: config.anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: normEmail(email), create_user: false }),
  }).catch((e) => { console.warn('[members] invitation mail:', e.message); return null })
  if (r && !r.ok) console.warn('[members] invitation mail:', r.status, (await r.text().catch(() => '')).slice(0, 160))
  return !!r?.ok
}
