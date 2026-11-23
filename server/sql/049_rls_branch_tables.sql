-- Row level security on the tables 021_billing_plans … 039_branch_conditions made without it
-- (billing, agentic BPM, the demo scenarios, AI candidates, branch conditions). Like every other pro_* table:
-- RLS on and no policy — only the server (its own database connection) reads and writes them, and PostgREST
-- with the anon or authenticated key sees nothing. Safe to run more than once; a table not made yet is skipped.
do $$
declare t text;
begin
  foreach t in array array[
    'pro_billing_subscriptions', 'pro_billing_seats', 'pro_billing_requests',
    'pro_billing_invoices', 'pro_billing_ledger',
    'pro_billing_usage', 'pro_billing_offsets', 'pro_billing_plan_history',
    'pro_policies', 'pro_policy_decisions', 'pro_policy_actions', 'pro_strategy_objectives', 'pro_strategy_links',
    'pro_decision_briefs', 'pro_optimizations',
    'pro_outbox', 'pro_purchase_orders',
    'pro_release_plans', 'pro_release_findings', 'pro_release_requests', 'pro_release_deployments', 'pro_optimization_cards',
    'pro_ai_candidates', 'pro_branch_conditions'
  ] loop
    if to_regclass('public.' || t) is not null then
      execute format('alter table public.%I enable row level security', t);
    end if;
  end loop;
end $$;
