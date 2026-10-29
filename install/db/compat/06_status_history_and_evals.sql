-- 작업 항목 상태 이력(todolist_status_history)과 스킬·정의 평가 기록(resource_eval_*).
-- 이력은 프로세스 개선(server/lib/improve — 병목·가치 흐름·크리티컬 패스)의 원천이고,
-- 평가 기록은 deepagents 의 스킬 만들기(core/skills/eval_tools.py)가 남긴다.
-- process-gpt 운영 DB 의 정의와 같다(2026-10-29 시스템 카탈로그에서 확인). 서브모듈의 스키마 파일에는 없다.
-- 이미 만들어졌으면 건너뛴다(다시 실행할 때 트리거·정책을 지우고 만들며 표를 잠그지 않게).
select (to_regclass('public.todolist_status_history') is not null
        and to_regclass('public.resource_eval_results') is not null
        and exists (select 1 from pg_trigger where tgname = 'trg_record_todolist_status_change')
       ) as lite_history_ready \gset
\if :lite_history_ready
\else

-- ============================================================================
-- 작업 항목 상태 이력: todolist.status 가 바뀔 때마다 한 줄
-- ============================================================================
create table if not exists public.todolist_status_history (
    id                   bigserial   not null,
    tenant_id            text        not null default public.tenant_id(),
    todo_id              uuid        not null,
    proc_inst_id         text,
    activity_id          text,
    from_status          public.todo_status,
    to_status            public.todo_status not null,
    changed_at           timestamptz not null default now(),
    changed_by           text,
    changed_by_is_agent  boolean     not null default false,
    rework_seq           integer     not null default 0,
    draft_status         public.draft_status,
    feedback_status      text,
    is_estimated         boolean     not null default false,
    constraint todolist_status_history_pkey primary key (id)
);
create index if not exists idx_tsh_inst on public.todolist_status_history (proc_inst_id, changed_at);
create index if not exists idx_tsh_tenant on public.todolist_status_history (tenant_id, changed_at desc);
create index if not exists idx_tsh_todo on public.todolist_status_history (todo_id, changed_at);

create or replace function public.record_todolist_status_change()
 returns trigger
 language plpgsql
as $function$
declare
    v_from  todo_status;
    v_seq   int;
begin
    if TG_OP = 'UPDATE' then
        -- status 가 실제로 바뀐 경우만. UPDATE OF status 는 값이 같아도 발화한다.
        if NEW.status is not distinct from OLD.status then
            return NEW;
        end if;
        v_from := OLD.status;
    else
        v_from := null;   -- 배정
    end if;

    -- IN_PROGRESS 로 들어갈 때마다 세션 번호를 올린다.
    if NEW.status = 'IN_PROGRESS' then
        select count(*) into v_seq
          from public.todolist_status_history
         where todo_id = NEW.id and to_status = 'IN_PROGRESS';
    else
        select coalesce(max(rework_seq), 0) into v_seq
          from public.todolist_status_history
         where todo_id = NEW.id;
    end if;

    insert into public.todolist_status_history (
        tenant_id, todo_id, proc_inst_id, activity_id,
        from_status, to_status, changed_at,
        changed_by, changed_by_is_agent, rework_seq,
        draft_status, feedback_status, is_estimated
    ) values (
        coalesce(NEW.tenant_id, public.tenant_id()),
        NEW.id, NEW.proc_inst_id, NEW.activity_id,
        v_from, NEW.status, now(),
        NEW.user_id, (NEW.agent_mode is not null), v_seq,
        NEW.draft_status, NEW.feedback_status, false
    );

    return NEW;
end;
$function$;

drop trigger if exists trg_record_todolist_status_change on public.todolist;
create trigger trg_record_todolist_status_change
    after insert or update of status on public.todolist
    for each row execute function public.record_todolist_status_change();

alter table public.todolist_status_history enable row level security;
DROP POLICY IF EXISTS todolist_status_history_insert_policy ON public.todolist_status_history;
create policy todolist_status_history_insert_policy on public.todolist_status_history
    for insert to authenticated with check (tenant_id = public.tenant_id());
DROP POLICY IF EXISTS todolist_status_history_select_policy ON public.todolist_status_history;
create policy todolist_status_history_select_policy on public.todolist_status_history
    for select to authenticated using (tenant_id = public.tenant_id());

-- ============================================================================
-- 평가 기록: 묶음(suite) → 시험 사례(case) → 실행(run) → 결과(result)
-- ============================================================================
create table if not exists public.resource_eval_suites (
    id                      uuid        not null default gen_random_uuid(),
    tenant_id               text        not null default public.tenant_id(),
    resource_type           text        not null,
    resource_id             text        not null,
    source_conversation_id  text,
    created_by              uuid,
    created_at              timestamptz not null default now(),
    updated_at              timestamptz not null default now(),
    baseline_ref            text,
    constraint resource_eval_suites_pkey primary key (id),
    constraint resource_eval_suites_tenant_resource_key unique (tenant_id, resource_type, resource_id),
    constraint resource_eval_suites_type_check check (resource_type = any (array['skill', 'bpmn', 'dmn']))
);
create index if not exists idx_resource_eval_suites_tenant on public.resource_eval_suites (tenant_id, resource_type, resource_id);

create table if not exists public.resource_eval_cases (
    id               uuid        not null default gen_random_uuid(),
    suite_id         uuid        not null,
    tenant_id        text        not null default public.tenant_id(),
    eval_name        text        not null,
    prompt           text        not null,
    expected_output  text,
    files            jsonb       not null default '[]'::jsonb,
    assertions       jsonb       not null default '[]'::jsonb,
    "position"       integer     not null default 0,
    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now(),
    constraint resource_eval_cases_pkey primary key (id),
    constraint resource_eval_cases_suite_id_fkey foreign key (suite_id) references public.resource_eval_suites (id) on delete cascade,
    constraint resource_eval_cases_suite_name_key unique (suite_id, eval_name)
);
create index if not exists idx_resource_eval_cases_suite on public.resource_eval_cases (suite_id, "position");

create table if not exists public.resource_eval_runs (
    id               uuid        not null default gen_random_uuid(),
    suite_id         uuid        not null,
    tenant_id        text        not null default public.tenant_id(),
    resource_type    text        not null,
    resource_id      text        not null,
    trigger          text        not null default 'pull_request',
    pr_id            uuid,
    base_ref         text,
    head_ref         text,
    base_digest      text,
    head_digest      text,
    status           text        not null default 'running',
    error            text,
    pass_rate        numeric(5,4),
    base_pass_rate   numeric(5,4),
    broken_count     integer     not null default 0,
    fixed_count      integer     not null default 0,
    summary          jsonb       not null default '{}'::jsonb,
    created_by       uuid,
    started_at       timestamptz not null default now(),
    finished_at      timestamptz,
    constraint resource_eval_runs_pkey primary key (id),
    constraint resource_eval_runs_suite_id_fkey foreign key (suite_id) references public.resource_eval_suites (id) on delete cascade,
    constraint resource_eval_runs_pr_id_fkey foreign key (pr_id) references public.resource_pull_requests (id) on delete cascade,
    constraint resource_eval_runs_pr_required check ((trigger <> 'pull_request') or (pr_id is not null)),
    constraint resource_eval_runs_status_check check (status = any (array['running', 'succeeded', 'failed'])),
    constraint resource_eval_runs_trigger_check check (trigger = any (array['creation', 'pull_request', 'manual', 'backfill']))
);
create index if not exists idx_resource_eval_runs_pr on public.resource_eval_runs (pr_id, started_at desc);
create index if not exists idx_resource_eval_runs_suite on public.resource_eval_runs (suite_id, started_at desc);

create table if not exists public.resource_eval_results (
    id           uuid        not null default gen_random_uuid(),
    run_id       uuid        not null,
    case_id      uuid,
    tenant_id    text        not null default public.tenant_id(),
    eval_name    text        not null,
    variant      text        not null,
    passed       integer     not null default 0,
    total        integer     not null default 0,
    pass_rate    numeric(5,4),
    assertions   jsonb       not null default '[]'::jsonb,
    outputs_dir  text,
    notes        text,
    created_at   timestamptz not null default now(),
    constraint resource_eval_results_pkey primary key (id),
    constraint resource_eval_results_run_id_fkey foreign key (run_id) references public.resource_eval_runs (id) on delete cascade,
    constraint resource_eval_results_case_id_fkey foreign key (case_id) references public.resource_eval_cases (id) on delete set null,
    constraint resource_eval_results_run_case_variant_key unique (run_id, eval_name, variant),
    constraint resource_eval_results_variant_check check (variant = any (array['base', 'head', 'with_skill', 'without_skill']))
);
create index if not exists idx_resource_eval_results_run on public.resource_eval_results (run_id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['resource_eval_suites','resource_eval_cases','resource_eval_runs','resource_eval_results'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I_tenant_policy ON public.%I', t, t);
    EXECUTE format('CREATE POLICY %I_tenant_policy ON public.%I FOR ALL TO authenticated USING (tenant_id = public.tenant_id()) WITH CHECK (tenant_id = public.tenant_id())', t, t);
  END LOOP;
END $$;

-- PostgREST 가 새 표를 바로 보게
notify pgrst, 'reload schema';
\endif
