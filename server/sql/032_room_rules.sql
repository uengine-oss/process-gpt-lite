-- 방 규칙(spec pgpt-pro_room-rules): "앞으로 이 방에 올리는 링크·파일은 …". 프로젝트 방 하나의 약속이고, 사람이 "곧바로"라고 했으니 묻지 않고 실행한다.
create table if not exists pro_room_rules (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  user_id uuid not null,
  thread_id uuid not null references pro_threads(id) on delete cascade,
  said text not null,                      -- 그 사람이 한 말 그대로
  action text not null,                    -- 링크나 파일이 올라오면 할 일
  runs int not null default 0,
  created_at timestamptz not null default now()
);
create unique index if not exists pro_room_rules_one on pro_room_rules (thread_id);
alter table pro_room_rules enable row level security;
