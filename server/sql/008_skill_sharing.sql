-- Skills as shared folders (스킬 공유): a skill is a folder of kind 'skill' whose main is the skill's
-- files; changes are variations (branches), a 반영 요청 is a process-gpt resource_pull_requests row,
-- and only the skill's author or the boss of an agent that uses it may merge.
-- Design: process-gpt/openspec/changes/pgpt-pro-skill-sharing/design.md

alter table pro_folders drop constraint if exists pro_folders_kind_check;
alter table pro_folders add constraint pro_folders_kind_check check (kind in ('managed', 'linked', 'skill'));

-- who may use a skill: 'private' = its author (and the author's own runs) only, 'tenant' = everyone.
-- Skills installed before this existed are tenant-wide (that is how process-gpt treats them).
create table if not exists pro_skill_visibility (
  tenant_id text not null,
  skill_name text not null,
  visibility text not null default 'private' check (visibility in ('private', 'tenant')),
  author_id uuid not null,
  folder_id uuid references pro_folders(id) on delete set null,
  asked_at timestamptz,          -- "전사에 공유하시겠어요?" after the first successful use
  shared_at timestamptz,
  shared_by uuid,
  created_at timestamptz default now(),
  primary key (tenant_id, skill_name)
);

-- an agent's boss (에이전트 보스): the person responsible for it. A boss of any agent that uses a
-- skill may merge changes to that skill.
create table if not exists pro_agent_owners (
  tenant_id text not null,
  agent_user_id uuid not null,
  owner_user_id uuid not null,
  set_by uuid,
  updated_at timestamptz default now(),
  primary key (tenant_id, agent_user_id)
);

-- pre-merge verification of a skill change: the same cases run on main (base) and on the
-- variation (head), each graded
create table if not exists pro_skill_verifications (
  id uuid primary key default gen_random_uuid(),
  folder_id uuid not null references pro_folders(id) on delete cascade,
  variation_id uuid not null references pro_folder_variations(id) on delete cascade,
  pr_id uuid,
  mode text not null default 'local' check (mode in ('local', 'provider')),
  status text not null default 'running' check (status in ('running', 'succeeded', 'failed')),
  cases jsonb not null default '[]',
  results jsonb not null default '[]',   -- [{case, base:{pass, note}, head:{pass, note}}]
  summary jsonb,
  error text,
  created_by uuid,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
