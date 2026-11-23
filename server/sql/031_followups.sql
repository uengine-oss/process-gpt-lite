-- 후행 습관(spec pgpt-pro_followup-habits): 결과물을 받으면 습관처럼 시키는 다음 일. 한 사람의 것이고 팀과 나누지 않는다.
create table if not exists pro_followups (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  user_id uuid not null,
  event_cls text not null,                   -- 어떤 결과물이 나왔을 때: slides | doc | sheet | pdf | audio | image | video
  action text not null,                      -- 무엇을: 그 사람이 한 말 그대로
  ask text,                                  -- 먼저 물을 때 쓰는 말(「…드릴까요?」)
  files jsonb not null default '[]',         -- 그 말과 함께 올린 파일(로고 등)
  origin text not null default 'observed',   -- observed: 지켜보다 배움 | told: 「앞으로 …」라고 직접 말함
  seen int not null default 1,
  accepted int not null default 0,
  declined int not null default 0,
  declined_run int not null default 0,       -- 연달아 거절한 수: 쌓이면 그만 묻는다
  state text not null default 'on',          -- on | muted
  last_asked_conv text,                      -- 한 대화에서는 한 번만 묻는다
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists pro_followups_who on pro_followups (tenant_id, user_id, event_cls);
alter table pro_followups enable row level security;
