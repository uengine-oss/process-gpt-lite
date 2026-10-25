-- 프로세스 마이닝(인계 기반 프로세스 식별 → 정식 등록 → 메일 라우팅). lib/mining/*
-- 인계 기록 자체는 process-gpt handover_events 에 쌓는다(마이너가 그대로 읽음). 여기는 pgpt-pro 쪽 메타만.

-- 메일 한 통 = 한 케이스(case_id = handover_events.origin_room_id). 추천 화면의 '사례'
create table if not exists pro_mining_cases (
  case_id text primary key,
  tenant_id text not null,
  user_id uuid not null,
  mail_id text,
  customer text,
  subject text,
  files text[] not null default '{}',  -- 이 케이스가 만든 산출물 이름(팀 공유를 케이스에 잇는 근거)
  demo boolean not null default false,  -- 시연용으로 직접 넣은 과거 사례
  created_at timestamptz not null default now()
);

-- 마이너가 찾은 반복 패턴 → 관리자 추천 → 정식 등록(proc_def) 또는 보류
create table if not exists pro_mining_suggestions (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  pattern_key text not null,
  process_id text not null,
  name text not null,
  summary text,
  pattern jsonb not null,       -- /patterns 한 묶음(단계·역할·도구·빈도·사례)
  definition jsonb,             -- 마이너가 도출한 proc_def JSON(draft)
  pr_id uuid,                   -- resource_pull_requests (마이너가 연 제안)
  version_uuid uuid,            -- proc_def_version (draft)
  status text not null default 'suggested' check (status in ('suggested','registered','held')),
  proc_def_id text,
  match jsonb,                  -- 다음 메일을 이 프로세스로 보낼 기준
  decided_by uuid,
  decided_at timestamptz,
  saved jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, pattern_key)
);

-- 정식 등록된 프로세스로 시작된 메일 처리(어느 메일이 어느 인스턴스가 됐나)
create table if not exists pro_mining_runs (
  proc_inst_id text primary key,
  tenant_id text not null,
  suggestion_id uuid references pro_mining_suggestions(id) on delete set null,
  user_id uuid not null,
  mail jsonb not null,
  created_at timestamptz not null default now()
);
