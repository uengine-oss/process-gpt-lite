-- 지난 메일 다시 읽기(온보딩을 여러 번): 스레드마다 어떤 메일까지 어느 판의 「프로세스 찾기」 스킬로 읽었는지 남긴다.
-- 다시 읽을 때 새 메일이 붙은 스레드와, 스킬이 바뀐 뒤(규칙 · 프롬프트) 아직 그 판으로 읽지 않은 스레드만 모델이 읽는다.
create table if not exists pro_mail_reads (
  tenant_id text not null,
  owner_id uuid not null,
  thread_id text not null,
  mail_ids text[] not null default '{}',  -- the thread's mails when it was read
  skill_version text not null default '',
  read_at timestamptz not null default now(),
  primary key (tenant_id, owner_id, thread_id)
);
alter table pro_mail_reads enable row level security;
