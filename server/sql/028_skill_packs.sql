-- 업무 팩(skills/packs/<팩>/): 한 업종의 업무 지식(스킬 묶음)을 회사가 고를 때만 그 회사(테넌트)에 설치한다
-- (설계 docs/mobile-review-1121/skill-routing-design.md 4.4·4.5, 2026-11-21 결정 3). 기본 설치에는 없다.
-- 스킬 자체는 deepagents 의 테넌트 스킬(POST /skills/upload)로 올라가고, 여기는 Lite 쪽 원장만 둔다.
-- 서버만 자기 연결로 읽고 쓴다(다른 pro_* 테이블처럼 RLS 켬, 정책 없음). 여러 번 돌려도 같다.

-- 회사가 켠 팩. enabled=false 는 관리자가 끈 팩(그 팩의 스킬을 다시 설치하지 않는다)
create table if not exists pro_skill_packs (
  tenant_id text not null,
  pack text not null,
  enabled boolean not null default true,
  version text,                       -- 마지막으로 맞춘 팩 버전(pack.json)
  updated_by uuid,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, pack)
);

-- 팩이 올린 스킬 하나하나의 설치 원장
--   installed: 우리가 올린 그대로 있음(sha256 = 올린 묶음의 내용 해시)
--   diverged : 회사가 고쳐 내용 해시가 달라짐 — 새 버전이 와도 덮어쓰지 않는다
--   conflict : 같은 이름의 스킬이 이미 있었음(회사 것) — 덮어쓰지 않는다
--   disabled : 팩을 꺼서 지웠거나, 회사가 지움 — 관리자가 다시 켜기 전에는 설치하지 않는다
--   failed   : 올리기 실패(다음 켜기·버전 확인 때 다시 시도)
create table if not exists pro_skill_installs (
  tenant_id text not null,
  skill_name text not null,
  pack text not null,
  version text,
  sha256 text,
  state text not null check (state in ('installed', 'diverged', 'conflict', 'disabled', 'failed')),
  note text,
  installed_by uuid,
  installed_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, skill_name)
);
create index if not exists pro_skill_installs_pack on pro_skill_installs (tenant_id, pack);

alter table pro_skill_packs enable row level security;
alter table pro_skill_installs enable row level security;

-- 메일 사례가 요청받은 문서(메일 분류가 고른 종류·스킬·파일 이름): 초안 단계 이름을 확장자 사전이 아니라
-- 이 사실로 정한다(lib/mining/recorder.js recordDrafts)
alter table pro_mining_cases add column if not exists items jsonb;

-- 알림의 하위 종류(팀 공유 'share' · 멘션 'mention' …). process-gpt 의 notifications 테이블은 건드리지 않고
-- Lite 가 만든 알림의 구조화 필드만 옆에 둔다 — 화면이 제목 문구를 읽어 종류를 짐작하지 않게(lib/team/messenger.js)
create table if not exists pro_notification_subtypes (
  notification_id uuid primary key,
  tenant_id text not null,
  subtype text not null,
  created_at timestamptz not null default now()
);
alter table pro_notification_subtypes enable row level security;
