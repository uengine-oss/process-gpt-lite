// The usage event consumer. LiteLLM never makes a call wait for its bookkeeping: it queues the spend in memory
// and writes it to litellm."LiteLLM_SpendLogs" every few seconds — one row per call, only ever added to. This
// loop reads that table as an event stream and keeps Lite's own ledger, pro_billing_usage: one row per call
// with the company, person, pool (seat or purchased credits), feature, model, tokens, cost, credits and the plan
// in effect when the call was made (pro_billing_plan_history) — what invoices and the back office read.
//
//   - off the call path: a timer every PRO_BILLING_METER_MS (5 s), never awaited by a request
//   - idempotent: a call is recorded once (request_id); each pass re-reads a little behind its offset
//     (LOOKBACK), because rows land in LiteLLM's batches, not in call order
//   - one consumer: the server holding the advisory lock reads; the others skip the pass
//   - pg_notify('pro_billing_usage', {tenant, n}) after a pass, for anyone who wants to react at once
import { q, pool } from '../supa.js'
import * as K from '../llmKeys.js'
import { usdPerCredit } from './catalog.js'

const LOCK = 7_120_431
const LOOKBACK = "interval '3 minutes'"
const BATCH = 1000

export async function pass() {
  const client = await pool.connect()
  try {
    const [{ locked }] = (await client.query('select pg_try_advisory_lock($1) as locked', [LOCK])).rows
    if (!locked) return { skipped: true }
    try {
      await client.query(`insert into pro_billing_offsets(name, last_at) values ('spendlogs', now() - interval '1 day') on conflict do nothing`)
      const { rows: [off] } = await client.query(`select last_at from pro_billing_offsets where name='spendlogs'`)
      // LiteLLM keeps UTC without a time zone; ours are timestamptz
      const { rows } = await client.query(`
        with ev as (
          select s.request_id, s."startTime" at time zone 'utc' as at, s.spend, s.prompt_tokens, s.completion_tokens, s.status,
                 coalesce(s.model_group, s.model) as model, s.request_tags,
                 coalesce(k.metadata->>'tenant', h.tenant_id) as tenant_id, coalesce(k.metadata->>'user', s."user") as user_id,
                 coalesce(k.metadata->>'pool', 'seat') as pool
          from litellm."LiteLLM_SpendLogs" s
          left join litellm."LiteLLM_VerificationToken" k on k.token = s.api_key
          left join lateral (select substring(s.team_id from '^pgpt-(.*?)(-extra)?$') as tenant_id) h on true
          where s."startTime" at time zone 'utc' > $1::timestamptz - ${LOOKBACK} and s.team_id like 'pgpt-%'
          order by s."startTime" limit ${BATCH})
        insert into pro_billing_usage(request_id, tenant_id, user_id, pool, feature, model, prompt_tokens, completion_tokens, cost_usd, credits, catalog, plan, status, at)
        select ev.request_id, ev.tenant_id, ev.user_id, ev.pool,
               (select replace(t, 'feature:', '') from jsonb_array_elements_text(coalesce(ev.request_tags, '[]'::jsonb)) t where t like 'feature:%' limit 1),
               ev.model, ev.prompt_tokens, ev.completion_tokens, coalesce(ev.spend, 0), round((coalesce(ev.spend, 0) / $2)::numeric, 3),
               coalesce(ph.catalog, sub.catalog), coalesce(ph.plan, sub.plan), ev.status, ev.at
        from ev
        left join lateral (select catalog, plan from pro_billing_plan_history p where p.tenant_id = ev.tenant_id and p.effective_from <= ev.at
                           and coalesce(p.effective_to, 'infinity') > ev.at order by p.effective_from desc limit 1) ph on true
        left join pro_billing_subscriptions sub on sub.tenant_id = ev.tenant_id
        where ev.tenant_id is not null
        on conflict (request_id) do nothing
        returning tenant_id, at`, [off.last_at, usdPerCredit()])
      // the offset moves to the newest call of this batch (not of the table: a full batch leaves the rest for the next pass)
      const { rows: [mx] } = await client.query(`select max(at) as m from (select "startTime" at time zone 'utc' as at from litellm."LiteLLM_SpendLogs"
        where "startTime" at time zone 'utc' > $1::timestamptz - ${LOOKBACK} and team_id like 'pgpt-%' order by "startTime" limit ${BATCH}) b`, [off.last_at])
      await client.query(`update pro_billing_offsets set last_at = greatest(last_at, coalesce($1, last_at)), events = events + $2, updated_at = now() where name='spendlogs'`, [mx.m, rows.length])
      const byTenant = {}
      for (const r of rows) byTenant[r.tenant_id] = (byTenant[r.tenant_id] || 0) + 1
      for (const [tenant, n] of Object.entries(byTenant)) await client.query('select pg_notify($1, $2)', ['pro_billing_usage', JSON.stringify({ tenant, n })])
      return { recorded: rows.length, byTenant }
    } finally {
      await client.query('select pg_advisory_unlock($1)', [LOCK])
    }
  } finally {
    client.release()
  }
}

// the consumer's state, for the back office: how far it has read, how many events, how far behind LiteLLM
export async function status() {
  const [o] = await q(`select last_at, events, updated_at from pro_billing_offsets where name='spendlogs'`)
  const [l] = await q(`select max("startTime" at time zone 'utc') as newest from litellm."LiteLLM_SpendLogs" where team_id like 'pgpt-%'`).catch(() => [{}])
  return { lastAt: o?.last_at || null, events: Number(o?.events || 0), passAt: o?.updated_at || null, newest: l?.newest || null }
}

let timer = null
export function startMeter() {
  if (!K.enabled() || timer) return
  const every = Number(process.env.PRO_BILLING_METER_MS || 5000)
  let running = false
  timer = setInterval(() => {
    if (running) return
    running = true
    pass().catch((e) => console.warn('[meter]', e.message)).finally(() => { running = false })
  }, every)
  timer.unref()
}
