// LiteLLM's own budgets as Lite's quota (PRO_LLM_KEYS=litellm). A company (tenant) is a LiteLLM team
// (team_id pgpt-<tenant>), a person is a member of it, and every model call goes out with that person's key
// in that company. The company's plan (lib/plans) decides the limits on that key (a short usage window,
// models, speed) and on the membership (a week or a billing month); LiteLLM enforces them and keeps the spend
// per company, person, key and feature tag. A Team company may also open an "extra usage" pool: a second
// team, pgpt-<tenant>-extra, whose budget is the pool, used once a person's own limits are reached.
// Off (the default): every call uses PRO_LLM_API_KEY, as before.
//
// Keys are not stored here: a key is derived from PRO_LLM_KEY_SECRET, the tenant, the person (and the pool),
// and LiteLLM keeps only its hash. The first call with a key LiteLLM does not know creates the team, the
// person, the membership and the key (admin key PRO_LITELLM_ADMIN_KEY), applies the plan to it, and is sent again.
import crypto from 'node:crypto'
import { config } from '../config.js'
import { usage } from './usage.js'
import { L, locale } from './lang.js'
import { q } from './supa.js'

export const enabled = () => config.llmKeys.mode === 'litellm'
export const NO_LIMIT = 1e6

// background work no person started (scans, sweeps): the company's own key
export const SYSTEM = 'system'
export const teamOf = (tenant) => `pgpt-${tenant}`
export const extraTeamOf = (tenant) => `pgpt-${tenant}-extra`
export const memberOf = (tenant, userId) => (userId === SYSTEM ? `${SYSTEM}:${tenant}` : userId)
export const keyOf = (tenant, userId, pool = 'seat') =>
  `sk-pgpt-${crypto.createHmac('sha256', config.llmKeys.secret).update(`${tenant}\n${userId}${pool === 'extra' ? '\nextra' : ''}`).digest('base64url').slice(0, 40)}`
// how LiteLLM keeps a key (LiteLLM_VerificationToken.token)
export const tokenOf = (key) => crypto.createHash('sha256').update(key).digest('hex')

// the key and tags for a call made now; a person's own key, else the company's
export function current(pool = 'seat') {
  if (!enabled()) return { key: config.llm.apiKey }
  if (!config.llmKeys.secret) throw new Error('PRO_LLM_KEYS=litellm needs PRO_LLM_KEY_SECRET')
  const tenant = config.tenantId
  const { userId, feature } = usage()
  const who = userId || SYSTEM
  return { key: keyOf(tenant, who, pool), tenant, userId: who, pool, tags: [`feature:${feature || 'other'}`, ...(pool === 'extra' ? ['pool:extra'] : [])] }
}

export async function admin(path, body) {
  const res = await fetch(`${config.llmKeys.adminUrl}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${config.llmKeys.adminKey}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  })
  if (res.ok) return res.json()
  const text = await res.text()
  // made by an earlier call (or another server): fine
  if ((res.status === 400 || res.status === 409) && /already|exist/i.test(text)) return null
  throw Object.assign(new Error(`LiteLLM ${path} ${res.status}: ${text.slice(0, 200)}`), { status: res.status })
}

const provisioned = new Map()
export function provision({ key, tenant, userId, pool = 'seat' }) {
  if (!provisioned.has(key)) {
    const member = memberOf(tenant, userId)
    const team = pool === 'extra' ? extraTeamOf(tenant) : teamOf(tenant)
    const run = (async () => {
      // the extra pool's team is made by the plan (lib/plans/apply.js) when an administrator opens it
      if (pool === 'seat') await admin('/team/new', { team_id: team, team_alias: tenant, metadata: { tenant } })
      await admin('/user/new', { user_id: member, auto_create_key: false })
      // every member gets a limit row from the start (none set = no limit): LiteLLM caches a membership for a
      // minute, and a limit given later to a member without one only counts once that entry expires
      await admin('/team/member_add', { team_id: team, member: { role: 'user', user_id: member }, max_budget_in_team: NO_LIMIT })
      // LiteLLM wants key aliases unique: the alias carries the key's fingerprint, so a new PRO_LLM_KEY_SECRET
      // (every key changes) makes new keys next to the old ones instead of failing on their aliases
      const fp = tokenOf(key).slice(0, 8)
      await admin('/key/generate', { key, user_id: member, team_id: team, key_alias: `${tenant}/${userId}${pool === 'extra' ? '/extra' : ''}#${fp}`, metadata: { tenant, user: userId, pool } })
      const { applyMember } = await import('./plans/apply.js')
      await applyMember(tenant, userId, { pool })
    })()
    provisioned.set(key, run)
    run.catch(() => provisioned.delete(key))
  }
  return provisioned.get(key)
}

const utc = (t) => (t ? new Date(String(t).replace(' ', 'T') + (/[Zz+]/.test(String(t).slice(10)) ? '' : 'Z')) : null)
// when the budget that refused a call opens again (LiteLLM's tables, same Postgres)
async function resetsAt(scope, auth) {
  try {
    if (scope === 'session') return utc((await q('select budget_reset_at::text from litellm."LiteLLM_VerificationToken" where token=$1', [tokenOf(auth.key)]))[0]?.budget_reset_at)
    if (scope === 'period') return utc((await q(`select b.budget_reset_at::text from litellm."LiteLLM_TeamMembership" m join litellm."LiteLLM_BudgetTable" b on b.budget_id=m.budget_id
      where m.team_id=$1 and m.user_id=$2`, [teamOf(auth.tenant), memberOf(auth.tenant, auth.userId)]))[0]?.budget_reset_at)
    const team = scope === 'extra' ? extraTeamOf(auth.tenant) : teamOf(auth.tenant)
    return utc((await q('select budget_reset_at::text from litellm."LiteLLM_TeamTable" where team_id=$1', [team]))[0]?.budget_reset_at)
  } catch { return null }
}

const when = (d) => d && d.toLocaleString(locale(), { timeZone: process.env.PRO_TZ || 'Asia/Seoul', month: 'short', day: 'numeric', weekday: 'short', hour: 'numeric', minute: '2-digit' })
export class QuotaError extends Error {
  constructor(scope, { resetsAt: at = null, detail = '', period = null } = {}) {
    const t = when(at)
    const what = {
      session: L(`5시간 사용 한도에 도달했어요.${t ? ` ${t}에 다시 쓸 수 있어요.` : ''}`, `You've reached your 5-hour usage limit.${t ? ` It resets ${t}.` : ''}`),
      period: period === '30d'
        ? L(`이번 결제 기간의 사용량을 다 썼어요.${t ? ` ${t}에 초기화돼요.` : ''}`, `You've used this billing period's usage.${t ? ` It resets ${t}.` : ''}`)
        : L(`이번 주 사용 한도에 도달했어요.${t ? ` ${t}에 초기화돼요.` : ''}`, `You've reached your weekly usage limit.${t ? ` It resets ${t}.` : ''}`),
      extra: L(`회사의 추가 사용량 한도까지 다 썼어요.${t ? ` ${t}에 다시 열려요.` : ''}`, `The company's extra usage is used up.${t ? ` It reopens ${t}.` : ''}`),
      company: L(`회사의 이번 달 사용 한도에 도달했어요.${t ? ` ${t}에 다시 열려요.` : ''}`, `The company's monthly usage limit is reached.${t ? ` It reopens ${t}.` : ''}`),
      feature: L('이 기능의 사용 한도에 도달했어요.', 'This feature\'s usage limit is reached.'),
    }[scope]
    super(`${what} ${L('더 쓰려면 설정 › 사용량·요금제에서 요금제 변경을 요청하세요.', 'For more, ask for a plan change in Settings › Usage & plan.')}`)
    Object.assign(this, { code: 'quota_exceeded', scope, status: 429, resetsAt: at, detail })
  }
}
export class ModelError extends Error {
  constructor(detail) {
    super(L('지금 요금제에서는 이 모델을 쓸 수 없어요. 설정 › 사용량·요금제에서 요금제를 확인하세요.', 'This model is not part of your plan. See Settings › Usage & plan.'))
    Object.assign(this, { code: 'model_not_allowed', status: 403, detail })
  }
}

// LiteLLM's refusal text says which budget ran out: "User=… in Team=…" the person's membership (their week
// or billing month), "Team=…" the team's (the company's cap, or the extra pool), "Tag=…" a feature's; no
// name: the key's own (the 5-hour session)
const scopeOf = (text, pool) => (/User=\S+ in Team=/.test(text) ? 'period' : /Team=/.test(text) ? (pool === 'extra' ? 'extra' : 'company')
  : /Tag=/.test(text) ? 'feature' : pool === 'extra' ? 'extra' : 'session')
const unknownKey = (text) => /token_not_found|invalid proxy server token|unable to find token/i.test(text)
const modelRefused = (text) => /model_access_denied|not allowed to access model|can only access models/i.test(text)

let extraCache = new Map()
async function extraOpen(tenant) {
  const hit = extraCache.get(tenant)
  if (hit && hit.at > Date.now() - 15000) return hit.open
  const { extraOpen: open } = await import('./plans/apply.js')
  const v = await open(tenant).catch(() => false)
  extraCache.set(tenant, { at: Date.now(), open: v })
  return v
}
export const forgetExtra = (tenant) => extraCache.delete(tenant)

// A membership limit (the week) can come back in the key's own words ("Budget has been exceeded! Current
// cost: …, Max budget: …", no names): which one ran out is the one whose amount it names — as LiteLLM has
// them now (the plan's, or one an operator set by hand).
async function sortOut(scope, text, auth) {
  if (scope !== 'session' || auth.pool !== 'seat') return scope
  const max = Number(String(text).match(/Max budget: ([\d.e+-]+)/)?.[1])
  if (!Number.isFinite(max)) return scope
  const [r] = await q(`select k.max_budget::float8 key_max, b.max_budget::float8 member_max from litellm."LiteLLM_VerificationToken" k
    left join litellm."LiteLLM_TeamMembership" m on m.team_id=k.team_id and m.user_id=k.user_id
    left join litellm."LiteLLM_BudgetTable" b on b.budget_id=m.budget_id where k.token=$1`, [tokenOf(auth.key)]).catch(() => [])
  const near = (a, b) => b != null && Math.abs(a - b) <= 1e-9 + 1e-6 * b
  if (r && near(max, r.member_max) && !near(max, r.key_max)) return 'period'
  return scope
}

// one request with one key: an unknown key is made (and the plan applied to it) and the request sent again
async function attempt(make, auth) {
  let res = await make(auth)
  if (res.status === 401) {
    const text = await res.text()
    if (modelRefused(text)) throw new ModelError(text.slice(0, 300))
    if (!unknownKey(text)) return { res: new Response(text, { status: 401 }) }
    await provision(auth)
    res = await make(auth)
    if (res.status === 401) {
      const t2 = await res.text()
      if (modelRefused(t2)) throw new ModelError(t2.slice(0, 300))
      return { res: new Response(t2, { status: 401 }) }
    }
  }
  if (res.status === 400) {
    const text = await res.text()
    if (/budget_exceeded|ExceededBudget|Budget has been exceeded/i.test(text)) return { refused: scopeOf(text, auth.pool), text }
    return { res: new Response(text, { status: 400 }) }
  }
  return { res }
}

// send(auth) makes the request with {key, tags}. A spent session or period limit goes on in the company's
// extra usage pool when it is open; otherwise (or once the pool is spent) it is a QuotaError. Other answers
// come back as they are.
export async function send(make) {
  const auth = current()
  if (!enabled()) return make(auth)
  let r = await attempt(make, auth)
  if (r.res) return r.res
  // the person's own period (a week, the billing month, or an administrator's monthly limit) words the refusal
  const periodOf = async () => (await (await import('./plans/apply.js')).limitsFor(auth.tenant, auth.userId).catch(() => null))?.period?.duration || null
  if ((r.refused === 'session' || r.refused === 'period') && await extraOpen(auth.tenant)) {
    // (either of the person's own limits: the pool takes over)
    const extra = current('extra')
    const r2 = await attempt(make, extra)
    if (r2.res) return r2.res
    throw new QuotaError('extra', { resetsAt: await resetsAt('extra', extra), detail: r2.text.slice(0, 300) })
  }
  const scope = await sortOut(r.refused, r.text, auth)
  throw new QuotaError(scope, { resetsAt: await resetsAt(scope, auth), detail: r.text.slice(0, 300), period: await periodOf() })
}

// the body fields that put a call on its feature tag (none when off)
export const bodyTags = (auth) => (auth.tags ? { metadata: { tags: auth.tags } } : {})
