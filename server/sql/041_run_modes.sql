-- 실행 방식(lib/ontology/runmode.js): 찾은 프로세스의 건이 돌 때 사람이 어디서 끼는가.
--   사람이 지켜봄(hotl, 제품 기본): 일이 오면 저절로 진행 — 사람이 책임지기로 한 단계와 되돌릴 수 없는 단계(회사 밖으로 나가는 일)에서만
--   멈춰 묻고, 지켜보는 사람은 언제든 멈출 수 있다.
--   단계마다 사람이 정함(hitl): 단계마다 「다음은 X예요 — 진행할까요?」를 건의 주인에게 묻는다.
-- 방식은 단계마다 그때 읽는다(스냅샷에 굳히지 않는다) — 바꾸면 돌던 건의 다음 단계부터 바뀌고, 다시 바꾸면 돌아간다.
-- 바꾼 것은 모두 결정 원장(pro_policy_decisions)에도 남는다. 새 표만 — 기존 공용 표는 고치지 않는다.

-- 회사 기본값(없으면 스킬 규칙 runMode.default, 그것도 없으면 hotl)
create table if not exists pro_run_settings (
  tenant_id    text primary key,
  default_mode text not null default 'hotl' check (default_mode in ('hotl', 'hitl')),
  updated_by   uuid,
  updated_at   timestamptz not null default now()
);
alter table pro_run_settings enable row level security;

-- 프로세스마다(없으면 회사 기본값)
create table if not exists pro_run_modes (
  tenant_id  text not null,
  proc_key   text not null,
  mode       text not null check (mode in ('hotl', 'hitl')),
  updated_by uuid,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, proc_key)
);
alter table pro_run_modes enable row level security;

-- 단계 하나를 따로 정한 것: auto = 되돌릴 수 없는 단계여도 묻지 않고 진행(조직이 명시적으로 정함) · ask = 사람이 지켜봄이어도 늘 묻는다
create table if not exists pro_run_step_rules (
  tenant_id text not null,
  proc_key  text not null,
  task      text not null,
  policy    text not null check (policy in ('auto', 'ask')),
  by_user   text,
  at        timestamptz not null default now(),
  primary key (tenant_id, proc_key, task)
);
alter table pro_run_step_rules enable row level security;

-- 건 하나의 멈춤(멈추기 · 이어 가기)
create table if not exists pro_case_runs (
  case_id    uuid primary key,
  tenant_id  text not null,
  paused     boolean not null default false,
  paused_by  uuid,
  paused_at  timestamptz,
  updated_at timestamptz not null default now()
);
alter table pro_case_runs enable row level security;

-- 건이 닿은 단계마다 관문이 본 것: 저절로 진행(auto) · 사람을 기다림(waiting, 까닭) · 사람이 정함(go · stop · other) · 다시 봄(released) ·
-- 옮기며 닫힘(moved). 되돌릴 수 없는 단계가 보냈을 것(sent: 이 판은 실제로 보내지 않고 내용만 남긴다).
create table if not exists pro_case_steps (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   text not null,
  case_id     uuid not null,
  proc_inst_id text not null,
  todo_id     uuid not null unique,
  task        text not null,
  kind        text not null check (kind in ('agent', 'draft', 'person')),  -- 에이전트가 하는 단계 · 사람 단계의 초안 · 사람 단계
  mode        text not null check (mode in ('hotl', 'hitl')),             -- 그 단계가 왔을 때 읽은 방식
  state       text not null check (state in ('auto', 'waiting', 'go', 'released', 'moved')),
  why         text[] not null default '{}',                                -- responsible · irreversible · hitl · paused · ask
  reversible  boolean not null default true,
  hold_item   boolean not null default false,                              -- 확인 전까지 그 사람의 할 일 목록에 보이지 않게
  proposal    jsonb,                                                       -- {from, to, p, cond, why, others:[{to, p, cond}]}
  preview     jsonb,                                                       -- 되돌릴 수 없는 단계: 나가기 전에 보여 줄 초안 {to, subject, text}
  decision    text check (decision in ('go', 'stop', 'other')),
  decided_by  uuid,
  decided_at  timestamptz,
  sent        jsonb,                                                       -- {to, subject, body, at, stub: true}
  message_id  uuid,                                                        -- 물어본 카드
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists pro_case_steps_case on pro_case_steps (tenant_id, case_id, created_at);
create index if not exists pro_case_steps_waiting on pro_case_steps (tenant_id) where state = 'waiting';
alter table pro_case_steps enable row level security;
