-- Objects pgpt-pro (and the agent SDK) use that process-gpt docker-infra init.sql/migration.sql do
-- not create on a fresh database. Shapes copied from a running process-gpt database (schema only)
-- and from services/context-router/sql, services/agent-feedback/skill_contributions.sql.
-- Idempotent; remove entries here once upstream init.sql carries them.

-- connector/system registry (pgpt-pro lib/systems.js)
create table if not exists public.systems (
    id text primary key,
    tenant_id text not null,
    name text not null,
    system_type text,
    category text,
    description text,
    shortcut_link text,
    is_active integer default 1 not null,
    responsible_org_id text,
    responsible_person text,
    registration_status text default 'active' not null,
    created_at timestamptz default now() not null,
    updated_at timestamptz default now() not null,
    created_by text,
    created_by_display text,
    deleted_at timestamptz,
    deleted_by text
);
create index if not exists systems_tenant_id_idx on public.systems (tenant_id);
create index if not exists systems_tenant_name_idx on public.systems (tenant_id, name);

create table if not exists public.external_api_health (
    id uuid default gen_random_uuid() primary key,
    tenant_id varchar(255) default 'default' not null,
    integration_target_name varchar(255) not null,
    call_address text not null,
    health_status varchar(20) not null check (health_status in ('정상', '비정상')),
    last_check_time timestamptz default now() not null,
    error_message_log text,
    manual_sync_enabled boolean default true not null,
    last_manual_sync_requested_at timestamptz,
    created_at timestamptz default now() not null,
    updated_at timestamptz default now() not null
);
create index if not exists idx_external_api_health_tenant_target on public.external_api_health (tenant_id, integration_target_name);

-- columns newer services write
alter table public.users add column if not exists permission_ids uuid[] default '{}'::uuid[] not null;
alter table public.users add column if not exists department_id text;
alter table public.users add column if not exists department_name text;
alter table public.users add column if not exists employee_no text;
alter table public.users add column if not exists org_code text;
alter table public.users add column if not exists org_name text;
alter table public.users add column if not exists last_seen_at timestamptz;
-- process-gpt-agent-sdk 0.11 work-item leases
alter table public.todolist add column if not exists lease_until timestamptz;
alter table public.todolist add column if not exists claim_count integer default 0 not null;
alter table public.todolist add column if not exists executor_dept_id text;
alter table public.todolist add column if not exists executor_dept_name text;
alter table public.proc_def add column if not exists description text;
alter table public.proc_def add column if not exists saved_at timestamptz;
alter table public.proc_def add column if not exists deleted_at timestamptz;
alter table public.proc_def add column if not exists deleted_by text;
alter table public.proc_def add column if not exists deleted_from jsonb;
alter table public.proc_def add column if not exists domain_id text;
alter table public.proc_def add column if not exists major_process_id text;
alter table public.proc_def add column if not exists mega_process_id text;
alter table public.proc_def_version add column if not exists owner text;

-- services/agent-feedback/skill_contributions.sql
-- openspec change: strategy-contribution-attribution
--
-- Records which humans contributed to each skill (created it, modified it, or
-- had a SKILL feedback proposal approved that produced/changed it), so
-- GET /api/skills/{skill_name}/contributors can compute a per-skill
-- contribution share. This repo does not own the Supabase schema (no
-- migration tooling here); apply this against the project's Supabase
-- instance directly.

CREATE TABLE IF NOT EXISTS public.skill_contributions (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            text NOT NULL,
    skill_name           text NOT NULL,
    contributor_user_id  text NOT NULL,
    contributor_name     text,
    contribution_type    text NOT NULL
                           CHECK (contribution_type IN ('CREATED', 'MODIFIED', 'PROPOSAL_APPROVED')),
    source_proposal_id   uuid,
    created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS skill_contributions_skill_idx
    ON public.skill_contributions (tenant_id, skill_name);

-- services/context-router/sql/001_context_threads.sql, 002_context_gist.sql
-- Contexts the router has seen for each user: one row per conversation it routed to.
-- The router reads the most recent ones as candidates for the next message.
create table if not exists public.context_threads (
  tenant_id text not null,
  user_id text not null,
  conversation_id text not null,
  title text not null,
  summary text default '',
  kind text default 'conversation',
  turns int default 0,
  updated_at timestamptz default now(),
  created_at timestamptz default now(),
  primary key (tenant_id, user_id, conversation_id)
);
create index if not exists context_threads_recent on public.context_threads (tenant_id, user_id, updated_at desc);
grant select, insert, update, delete on public.context_threads to service_role;
-- Earlier turns of a context, folded into keywords each time its summary is replaced, so a
-- long-running conversation stays findable without keeping its history.
alter table public.context_threads add column if not exists gist text default '';
