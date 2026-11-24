-- 내 컴퓨터의 CLI 에이전트(로컬 실행, lib/localAgents · 설계 docs/local-agents/design.md): 데스크톱 앱이 사람마다 자기 컴퓨터의 Claude Code ·
-- Codex 로 프로세스 단계를 돌린다. 여러 번 돌려도 된다. 새 테이블만 만든다 — 공용 테이블(todolist · bpm_proc_inst)은 그대로다.
--   pro_local_devices — 데스크톱 한 대 = 한 사람의 기기 토큰 하나(해시만 둔다). 설정 화면에서 끊으면 revoked_at.
--   pro_local_jobs    — 단계 하나를 로컬에서 돌리는 일(대기 · 보냄 · 실행 · 끝 · 실패 · 서버에 맡김 · 취소). 단계(todolist 행) 하나에 하나.
--                       그 실행의 조종(steers — 실행하는 사람만 입력) · 참여자가 올린 프롬프트 제안(suggestions — 대기 · 입력됨 · 버림) ·
--                       배운 것 후보(knowhow)를 함께 지닌다. 실행이 사람의 대화형 CLI(터미널)로 돌았으면 terminal, 끝난 화면의 끝부분(screen —
--                       서버가 다시 켜진 뒤에도 보는 사람이 마지막 화면을 본다)과 그 크기(screen_size)도. 그 실행에 보낸 스킬 폴더(sent_skills —
--                       데스크톱이 돌려준 스킬 수정은 이 폴더들에 대해서만 받는다). 실행의 대화(transcript — CLI 자신의 기록에서 읽은 항목,
--                       끝난 실행의 「대화」 보기)와, 턴이 끝나고 사람들을 기다리는 동안 저절로 끝날 때(idle_until)도.
-- RLS 는 켜고 정책은 두지 않는다(다른 pro_* 처럼 서버만 읽고 쓴다).
create table if not exists pro_local_devices (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     text not null,
  user_id       uuid not null,
  name          text not null,
  platform      text,
  app_version   text,
  token_hash    text not null unique,
  caps          jsonb not null default '{}'::jsonb,
  prefs         jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz,
  revoked_at    timestamptz
);
create index if not exists pro_local_devices_user on pro_local_devices (tenant_id, user_id) where revoked_at is null;
alter table pro_local_devices enable row level security;

create table if not exists pro_local_jobs (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      text not null,
  user_id        uuid not null,
  todo_id        text not null,
  proc_inst_id   text,
  activity_name  text,
  agent          text not null,
  mode           text not null default 'complete' check (mode in ('complete', 'draft')),
  offline        text not null default 'server' check (offline in ('server', 'wait')),
  server_agent   text not null default 'onto',
  wait_minutes   integer,
  state          text not null default 'queued' check (state in ('queued', 'offered', 'running', 'done', 'failed', 'delegated', 'cancelled')),
  why            text,
  device_id      uuid,
  device_name    text,
  person_name    text,
  folder_id      uuid,
  line           text,
  run_branch     text,
  session_id     text,
  prompt         text,
  gate           jsonb,
  result         jsonb,
  error          text,
  steers         jsonb not null default '[]'::jsonb,
  suggestions    jsonb not null default '[]'::jsonb,
  knowhow        jsonb not null default '[]'::jsonb,
  lines          jsonb not null default '[]'::jsonb,
  message_ids    jsonb not null default '{}'::jsonb,
  sent_skills    jsonb not null default '[]'::jsonb,
  terminal       boolean not null default false,
  screen         text,
  screen_size    jsonb,
  transcript     jsonb,
  idle_until     timestamptz,
  created_at     timestamptz not null default now(),
  offered_at     timestamptz,
  started_at     timestamptz,
  finished_at    timestamptz,
  updated_at     timestamptz not null default now(),
  unique (tenant_id, todo_id)
);
-- (a database that has the table from before these columns: they are added)
alter table pro_local_jobs add column if not exists device_name text;
alter table pro_local_jobs add column if not exists person_name text;
alter table pro_local_jobs add column if not exists suggestions jsonb not null default '[]'::jsonb;
alter table pro_local_jobs add column if not exists knowhow jsonb not null default '[]'::jsonb;
alter table pro_local_jobs add column if not exists sent_skills jsonb not null default '[]'::jsonb;
alter table pro_local_jobs add column if not exists terminal boolean not null default false;
alter table pro_local_jobs add column if not exists screen text;
alter table pro_local_jobs add column if not exists screen_size jsonb;
alter table pro_local_jobs add column if not exists transcript jsonb;
alter table pro_local_jobs add column if not exists idle_until timestamptz;
create index if not exists pro_local_jobs_open on pro_local_jobs (tenant_id, user_id, created_at) where state in ('queued', 'offered', 'running');
create index if not exists pro_local_jobs_inst on pro_local_jobs (tenant_id, proc_inst_id);
alter table pro_local_jobs enable row level security;
