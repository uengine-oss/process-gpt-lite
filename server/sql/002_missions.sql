-- Missions: a scheduled run of a deepagents skill (no process instance).
alter table pro_schedules add column if not exists skill text;          -- null = free prompt (old behaviour)
alter table pro_schedules add column if not exists params jsonb default '{}';
alter table pro_schedules add column if not exists notify text default 'on_change'; -- on_change | always | never
alter table pro_schedules add column if not exists paused boolean default false;
alter table pro_schedules add column if not exists state jsonb default '{}';  -- e.g. {"seen": [...]} carried between runs

create table if not exists pro_mission_runs (
  id uuid primary key default gen_random_uuid(),
  schedule_id uuid not null references pro_schedules(id) on delete cascade,
  trigger text default 'cron',                  -- cron | manual
  started_at timestamptz default now(),
  finished_at timestamptz,
  status text default 'running',                -- running | done | failed
  changed boolean,
  summary text,
  result jsonb,
  conversation_id text
);
create index if not exists pro_mission_runs_schedule on pro_mission_runs(schedule_id, started_at desc);
