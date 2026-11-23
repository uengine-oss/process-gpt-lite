-- 프로세스 온톨로지(spec pgpt-pro_process-ontology, docs/auto-ax-onboarding/design-v0.2.md).
-- The ontology itself (tasks, NEXT edges, bundles, values) lives in Ontological DB (lib/ontology/store.js, over Bolt).
-- These tables hold what is not knowledge: facts read from mail, the jobs that read them, the label → task cache,
-- the cases a snapshot runs, and the answers to habit questions. New tables only: handover_events is shared with
-- Process GPT and is not changed (mail history is kept here and read together with it).

-- 메일 이력: one row per mail that is work (the reader's funnel kept it), as a handover from sender to recipients
create table if not exists pro_mail_history (
  id bigserial primary key,
  tenant_id text not null,
  owner_id uuid not null,                 -- whose mailbox it came from (only they may open the mail again)
  mail_id text not null,                  -- the provider's id (to open it again with the owner's token)
  case_id text not null,                  -- thread (or a re-linked forward)
  occurred_at timestamptz not null,
  from_addr text,                         -- inside people by address; outside people masked (hash@domain)
  to_addrs text[] not null default '{}',
  from_role text,
  to_role text,
  activity_label text,                    -- what the reader said this mail does (a short task name)
  act text,                               -- request | reply | forward | approve | notify
  artifacts jsonb not null default '[]',  -- [{name, type}] attachment names and kinds only
  subject_hash text,
  attrs jsonb not null default '{}',     -- facts a condition can learn from: {amount} (원, the total a mail states)
  created_at timestamptz not null default now(),
  unique (tenant_id, mail_id)
);
create index if not exists pro_mail_history_case on pro_mail_history (tenant_id, case_id, occurred_at);
alter table pro_mail_history enable row level security;

-- 작업: long jobs with progress and resume ("1,240통 중 800통 읽음 · 일 14개")
create table if not exists pro_onto_jobs (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  user_id uuid,
  kind text not null,                     -- mail_history | build
  status text not null default 'running', -- running | done | failed
  total int not null default 0,
  done int not null default 0,
  kept int not null default 0,            -- mails that are work
  found int not null default 0,           -- tasks found so far
  cursor text,                            -- where to resume
  detail jsonb not null default '{}',
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists pro_onto_jobs_t on pro_onto_jobs (tenant_id, kind, started_at desc);
alter table pro_onto_jobs enable row level security;

-- 일 이름 맞추기: a raw activity text → the task it is (so the model is asked once per text)
create table if not exists pro_onto_labels (
  tenant_id text not null,
  raw_hash text not null,
  raw text not null,
  task text not null,
  how text not null,                      -- same | alias | model | candidate
  act text,                               -- request | deliver | approve | notify: whose work it was
  created_at timestamptz not null default now(),
  primary key (tenant_id, raw_hash)
);
alter table pro_onto_labels enable row level security;

-- 건: a case that runs on snapshots (one or more engine instances: a jump closes one and opens the next)
create table if not exists pro_po_cases (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  bundle text not null,
  entry_task text not null,
  started_by uuid,
  trigger jsonb not null default '{}',    -- {kind: mail|chat|manual, subject, from, text}
  entry_odds jsonb,                       -- the entry decision: {choice, probabilities, asked}
  instances text[] not null default '{}',
  snapshots text[] not null default '{}',
  history jsonb not null default '[]',    -- [{task, state: done|skipped|moved, at}]
  status text not null default 'running', -- running | done | ended_early
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists pro_po_cases_t on pro_po_cases (tenant_id, created_at desc);
alter table pro_po_cases enable row level security;

-- 습관 묻기의 답: what the person did with "지난번처럼 …로 넘길까요?" (calibrates when to ask)
create table if not exists pro_onto_answers (
  id bigserial primary key,
  tenant_id text not null,
  user_id uuid,
  case_id uuid,
  from_task text not null,
  to_task text not null,
  p double precision not null,
  accepted boolean not null,
  created_at timestamptz not null default now()
);
create index if not exists pro_onto_answers_t on pro_onto_answers (tenant_id, created_at desc);
alter table pro_onto_answers enable row level security;
