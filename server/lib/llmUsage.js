// What a company, and each person in it, spent on models this month — read straight from LiteLLM's tables,
// which live in the same Postgres as Lite (schema litellm, its own role; Lite's role reads only). The rows
// are LiteLLM's daily spend per team / tag and key; a key is one person in one company (lib/llmKeys.js).
import { q } from './supa.js'
import { teamOf } from './llmKeys.js'

const MONTH = `date >= to_char(date_trunc('month', now() at time zone 'utc'), 'YYYY-MM-DD')`

export async function monthOf(tenant, { people = false } = {}) {
  const team = teamOf(tenant)
  const [total] = await q(`select coalesce(sum(spend),0)::float8 spend, coalesce(sum(successful_requests),0)::int calls
    from litellm."LiteLLM_DailyTeamSpend" where team_id=$1 and ${MONTH}`, [team])
  const [budget] = await q(`select max_budget::float8, budget_duration, budget_reset_at, spend::float8 counter
    from litellm."LiteLLM_TeamTable" where team_id=$1`, [team])
  const features = await q(`select replace(g.tag, 'feature:', '') feature, sum(g.spend)::float8 spend, sum(g.successful_requests)::int calls
    from litellm."LiteLLM_DailyTagSpend" g join litellm."LiteLLM_VerificationToken" k on k.token = g.api_key
    where k.team_id=$1 and g.tag like 'feature:%' and g.${MONTH} group by 1 order by 2 desc`, [team])
  const out = { tenant, month: total, budget: budget || null, features }
  if (people) {
    out.people = await q(`select k.user_id, p.name, sum(d.spend)::float8 spend, sum(d.successful_requests)::int calls,
        m.spend::float8 counter, b.max_budget::float8 "limit"
      from litellm."LiteLLM_DailyTeamSpend" d join litellm."LiteLLM_VerificationToken" k on k.token = d.api_key
      left join pro_profile p on p.user_id::text = k.user_id
      left join litellm."LiteLLM_TeamMembership" m on m.team_id = k.team_id and m.user_id = k.user_id
      left join litellm."LiteLLM_BudgetTable" b on b.budget_id = m.budget_id
      where d.team_id=$1 and d.${MONTH} group by k.user_id, p.name, m.spend, b.max_budget order by 3 desc`, [team])
  }
  // the no-limit row every member gets (lib/llmKeys.js NO_LIMIT) is no limit
  for (const p of out.people || []) if (p.limit >= 1e6) p.limit = null
  return out
}

export async function mineOf(tenant, userId) {
  const [r] = await q(`select coalesce(sum(d.spend),0)::float8 spend, coalesce(sum(d.successful_requests),0)::int calls
    from litellm."LiteLLM_DailyTeamSpend" d join litellm."LiteLLM_VerificationToken" k on k.token = d.api_key
    where d.team_id=$1 and k.user_id=$2 and d.${MONTH}`, [teamOf(tenant), userId])
  return r
}
