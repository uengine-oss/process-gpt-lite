-- Robo-DLC Lite P1: AI-DLC as a team (docs/robo-dlc/plan-team.md). Safe to run again.

-- who plays which AI-DLC role in a folder's project (lib/aidlc/stages.js role keys: product, architect,
-- developer, quality, team-lead, …); a role may have several people
create table if not exists pro_aidlc_roles (
  tenant_id text not null,
  folder_id uuid not null,
  role_key text not null,
  user_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, folder_id, role_key, user_id)
);

-- every decision a person made in Lite and the session received (the approval ledger: added to, never changed)
create table if not exists pro_aidlc_decisions (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  folder_id uuid not null,
  intent text,
  stage text,
  kind text not null,          -- prompt | answers
  question text,
  choice text,
  note text,
  user_id uuid not null,
  created_at timestamptz not null default now()
);
create index if not exists pro_aidlc_decisions_folder on pro_aidlc_decisions (tenant_id, folder_id, created_at desc);

-- what the watcher already told people about (one card per wait), closed when the wait is over
create table if not exists pro_aidlc_waits (
  tenant_id text not null,
  folder_id uuid not null,
  wait_key text not null,
  kind text not null,          -- prompt | questions
  stage text,
  role_key text,
  title text,
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  primary key (tenant_id, folder_id, wait_key)
);

-- answers a mob meeting agreed on, waiting for the person who confirms them on the decision page
create table if not exists pro_aidlc_proposals (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  folder_id uuid not null,
  questions_path text not null,
  answers jsonb not null,      -- { "Q1": { "answer": "A", "why": "…" }, … }
  meeting_id uuid,
  room_id text,
  created_at timestamptz not null default now(),
  used_at timestamptz
);
