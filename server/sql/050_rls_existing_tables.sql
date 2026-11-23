-- Process GPT Lite: Lite 가 만든 테이블(112개, server/sql 의 create table) 가운데 RLS 가 꺼진 것에 RLS 를 켠다.
-- 정책은 두지 않는다 — 다른 pro_* 테이블처럼 서버(서비스 키 · 직접 DB 연결, 소유자)만 읽고 쓰고, anon · authenticated 키로는 보이지 않는다.
-- Lite 화면은 이 테이블을 PostgREST 로 읽지 않는다(모두 서버 API 를 거친다). 여러 번 실행해도 된다. 없는 테이블은 건너뛴다.
-- 실행 전 확인(켜질 테이블): select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and c.relname like 'pro\_%' and not c.relrowsecurity order by 1;
-- 실행 뒤 확인(0 이 나와야 한다): 위 쿼리의 행 수
do $$
declare t text;
begin
  foreach t in array array[
    'pro_profile', 'pro_threads', 'pro_messages', 'pro_actions', 'pro_panels', 'pro_schedules',
    'pro_vault_keys', 'pro_vault_items', 'pro_mail_accounts', 'pro_mail_seen', 'pro_mission_runs', 'pro_vault_audit',
    'pro_team_members', 'pro_role_assignments', 'pro_folders', 'pro_folder_members', 'pro_folder_variations', 'pro_folder_integrations',
    'pro_folder_files', 'pro_panel_apps', 'pro_panel_app_prefs', 'pro_skill_visibility', 'pro_agent_owners', 'pro_skill_verifications',
    'pro_panel_app_migrations', 'pro_panel_app_audit', 'pro_demo_mail', 'pro_draft_jobs', 'pro_dm_threads', 'pro_dm_members',
    'pro_dm_messages', 'pro_shares', 'pro_mining_cases', 'pro_mining_suggestions', 'pro_mining_runs', 'pro_chat_reads',
    'pro_room_suggestions', 'pro_meetings', 'pro_meeting_participants', 'pro_meeting_segments', 'pro_meeting_materials', 'pro_improve_state',
    'pro_improve_runs', 'pro_team_removed', 'pro_step_retries', 'pro_translations', 'pro_billing_subscriptions', 'pro_billing_seats',
    'pro_billing_requests', 'pro_billing_invoices', 'pro_billing_ledger', 'pro_billing_usage', 'pro_billing_offsets', 'pro_billing_plan_history',
    'pro_policies', 'pro_policy_decisions', 'pro_policy_actions', 'pro_strategy_objectives', 'pro_strategy_links', 'pro_decision_briefs',
    'pro_optimizations', 'pro_mining_talk', 'pro_outbox', 'pro_thread_folders', 'pro_purchase_orders', 'pro_push_subscriptions',
    'pro_release_plans', 'pro_release_findings', 'pro_release_requests', 'pro_release_deployments', 'pro_optimization_cards', 'pro_context_shares',
    'pro_sharing_rules', 'pro_team_leads', 'pro_access_requests', 'pro_grants', 'pro_refers', 'pro_refer_edits',
    'pro_context_refs', 'pro_context_views', 'pro_context_digests', 'pro_context_repeats', 'pro_context_readings', 'pro_followups',
    'pro_mail_history', 'pro_onto_jobs', 'pro_onto_labels', 'pro_po_cases', 'pro_onto_answers', 'pro_onto_settings',
    'pro_habit_shares', 'pro_role_members', 'pro_mail_archive', 'pro_mail_reads', 'pro_case_links', 'pro_ai_candidates',
    'pro_branch_conditions', 'pro_refine_reviews', 'pro_corrections', 'pro_run_settings', 'pro_run_modes', 'pro_run_step_rules',
    'pro_case_runs', 'pro_case_steps', 'pro_step_requirements', 'pro_form_names', 'pro_form_choices', 'pro_form_formats',
    'pro_map_opinions', 'pro_map_text_pairs', 'pro_edge_conditions', 'pro_improve_plans'
  ] loop
    if to_regclass('public.' || t) is not null then
      execute format('alter table public.%I enable row level security', t);
    end if;
  end loop;
end $$;
