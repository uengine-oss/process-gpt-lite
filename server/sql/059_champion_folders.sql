-- 챔피언 폴더(스펙 openspec/specs/champion-folders — 2026-11-26): 에이전트를 잘 쓰는 사람이 데스크톱 앱에서 자기 컴퓨터의 폴더를 골라 관리형 공유 폴더로
-- 올린다. 여러 번 돌려도 된다. 새 테이블만 만든다(056 · 057 · 058 은 다른 가지 몫).
--   pro_folder_sources — 폴더를 올리는 컴퓨터: 폴더 하나 × 기기 하나. 경로는 두지 않는다(이름표만 — 그 컴퓨터에서의 폴더 이름).
--                        올리는 가지는 기기마다 하나(pgpt-agent/sync-<기기 8자>/main), 상태(active · paused · blocked · removed)와 멈춘 까닭,
--                        마지막으로 받은 머리와 시각, 그 컴퓨터가 받은 main, 마지막 올리기의 숫자(report — 파일 · 크기 · 뺀 갈래별 수 ·
--                        확인할 파일 수. 경로나 값은 두지 않는다).
--   pro_folder_kit     — main 에서 찾은 에이전트 자산(스킬 · 명령 · 지침 · 규칙 · 스펙 …): 자리로 찾고, 이름 · 설명은 머리말에서.
--                        runs: 그 폴더에서 일하는 사람의 컴퓨터에서 무엇을 실행하는 설정(훅 · MCP 서버 · 허용 목록)이 들었나.
-- 「챔피언 폴더」 표시는 pro_folders.settings.champion = {by, at} (열을 더하지 않는다).
-- RLS 는 켜고 정책은 두지 않는다(다른 pro_* 처럼 서버만 읽고 쓴다).
create table if not exists pro_folder_sources (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       text not null,
  folder_id       uuid not null references pro_folders(id) on delete cascade,
  user_id         uuid not null,
  device_id       uuid not null,
  label           text not null,
  direction       text not null default 'up' check (direction in ('up', 'both', 'down')),
  branch          text not null,
  state           text not null default 'active' check (state in ('active', 'paused', 'blocked', 'removed')),
  why             text,
  last_head       text,
  last_pushed_at  timestamptz,
  seen_main       text,
  report          jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (folder_id, device_id)
);
create index if not exists pro_folder_sources_user on pro_folder_sources (tenant_id, user_id);
alter table pro_folder_sources enable row level security;

create table if not exists pro_folder_kit (
  folder_id    uuid not null references pro_folders(id) on delete cascade,
  path         text not null,
  platform     text not null,
  type         text not null,
  name         text,
  description  text,
  sha          text,
  runs         boolean not null default false,
  updated_at   timestamptz not null default now(),
  primary key (folder_id, path)
);
alter table pro_folder_kit enable row level security;
