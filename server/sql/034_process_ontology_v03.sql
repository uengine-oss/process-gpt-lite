-- 회사 프로세스 지도 v0.3 (design-v0.3 §4 · §10): 개인 습관을 지도에 보이는 설정, 습관을 회사에 공유한 기록(추천 후보 · 스킬).
-- 개인 습관 자체는 sql/031 의 pro_followups 그대로다. 그래프에는 역할 · 일 이름 · 사람 수만 쓴다(lib/ontology/build.js).

create table if not exists pro_onto_settings (
  tenant_id text primary key,
  habit_publish text not null default 'threshold',   -- threshold: 같은 역할에서 min 명 이상(또는 본인이 공유) | all: 모두(이름 없이) | off
  habit_min_people int not null default 3,
  updated_by uuid,
  updated_at timestamptz not null default now()
);
alter table pro_onto_settings enable row level security;

-- 습관이 알려졌을 때 「이 방법을 회사에 공유할까요?」의 답. 공유하면 그 일의 방법 후보(추천)로 올라가고,
-- 걸린 시간 · 품질과 함께 같은 목표(일)의 다른 방법과 견주며, 고르면 그 일의 세부 스킬이 된다.
create table if not exists pro_habit_shares (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  user_id uuid not null,
  followup_id uuid not null,
  answer text not null,                                -- shared | private
  task text,                                           -- 목표(그 습관이 하는 일, 지도의 일 이름)
  role text,
  cls text,
  how text,                                            -- 공유한 방법(그 사람이 한 말과 올린 파일 이름) — 공유한 것만 남는다
  runs int not null default 0,
  minutes real,                                        -- 그 습관을 실행해 끝나기까지 걸린 시간(분, 평균)
  quality jsonb not null default '{}',                 -- {accepted, declined, redo} — 받아들인 비율 등
  status text not null default 'nominated',            -- nominated | skill | withdrawn
  skill_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists pro_habit_shares_one on pro_habit_shares (tenant_id, followup_id);
create index if not exists pro_habit_shares_task on pro_habit_shares (tenant_id, task);
alter table pro_habit_shares enable row level security;

-- 역할의 사람들(한 역할에 여럿): 관리자가 넣고, 지도 셈이 그래프의 PLAYS(assigned) 로 옮긴다. 일을 아직 안 한 새 사람도 역할에 속한다.
-- (sql/006 의 pro_role_assignments 는 역할마다 담당 한 명 — 알림 받는 사람 — 이고, 그 사람도 여기 사람으로 친다)
create table if not exists pro_role_members (
  tenant_id text not null,
  role text not null,
  user_id uuid not null,
  added_by uuid,
  created_at timestamptz not null default now(),
  primary key (tenant_id, role, user_id)
);
alter table pro_role_members enable row level security;
