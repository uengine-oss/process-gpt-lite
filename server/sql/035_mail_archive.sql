-- 메일 보관함(design-v0.3 §16): 읽은 메일을 그 메일함 주인 몫으로 남긴다 — 지난 메일 읽기와 들어온 메일 모두. 나중에 다시 셈하거나
-- 다른 일에 쓸 때 메일 서버를 다시 부르지 않는다. 회사 지도(그래프)와 메일 이력(pro_mail_history)에는 지금처럼 원문을 남기지 않고,
-- 여기는 주인만 연다(서버가 주인의 요청으로만 읽는다, RLS 켜고 정책 없음). 주인이 메일 연결을 끊거나 지우면 함께 지운다.
create table if not exists pro_mail_archive (
  tenant_id text not null,
  owner_id uuid not null,
  provider text not null,                 -- gmail | imap | demo
  mail_id text not null,                  -- the provider's id
  thread_id text,
  occurred_at timestamptz,
  from_addr text,
  to_addrs text[] not null default '{}',
  cc_addrs text[] not null default '{}',
  subject text,
  body text,                              -- the whole body as text (html turned into text)
  new_part text,                          -- what its sender wrote now (quoted earlier mail cut off)
  labels text[] not null default '{}',    -- INBOX · SENT …
  attachments jsonb not null default '[]',-- [{name, type, size, attachment_id?, fields?, file?}] — a file not kept is fetched again by its id
  source text not null default 'history', -- history (지난 메일 읽기) | intake (들어온 메일)
  read_at timestamptz not null default now(),
  primary key (tenant_id, owner_id, mail_id)
);
create index if not exists pro_mail_archive_when on pro_mail_archive (tenant_id, owner_id, occurred_at desc);
alter table pro_mail_archive enable row level security;
