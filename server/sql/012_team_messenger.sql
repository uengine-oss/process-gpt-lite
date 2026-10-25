-- Team sharing and messenger (팀 공유·메신저): teammates hand each other artifacts, mention each
-- other from chat and talk 1:1 or in small groups. A share is a per-recipient grant the server checks
-- (pro_shares); the sender's storage URL never leaves the server.
-- Design: process-gpt/openspec/changes/pgpt-pro-team-sharing/design.md

create table if not exists pro_dm_threads (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  kind text not null check (kind in ('direct', 'group')),
  direct_key text,                 -- 1:1: the two user ids, sorted, joined by ':'
  title text,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, direct_key)
);

create table if not exists pro_dm_members (
  thread_id uuid not null references pro_dm_threads(id) on delete cascade,
  user_id uuid not null,
  last_read_at timestamptz not null default now(),
  joined_at timestamptz not null default now(),
  primary key (thread_id, user_id)
);
create index if not exists pro_dm_members_user on pro_dm_members(user_id);

create table if not exists pro_dm_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references pro_dm_threads(id) on delete cascade,
  tenant_id text not null,
  sender_id uuid not null,
  kind text not null default 'text' check (kind in ('text', 'share', 'mention')),
  body text not null default '',
  artifacts jsonb not null default '[]',   -- [{name, kind, sourceId, shares: {recipientId: shareId}}]
  context jsonb,                           -- mention: {title, conversationId, excerpt: [..]}
  created_at timestamptz not null default now()
);
create index if not exists pro_dm_messages_thread on pro_dm_messages(thread_id, created_at desc);
create index if not exists pro_dm_messages_sender on pro_dm_messages(tenant_id, sender_id, created_at desc);

create table if not exists pro_shares (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  owner_id uuid not null,
  recipient_id uuid not null,
  dm_message_id uuid references pro_dm_messages(id) on delete set null,
  source_message_id uuid,          -- the owner's pro_messages file card
  name text not null,
  bucket text not null,
  object_key text not null,        -- never sent to the client
  note text,
  copy_message_id uuid,            -- the recipient's own copy (pro_messages), made on first open
  created_at timestamptz not null default now(),
  opened_at timestamptz,
  revoked_at timestamptz
);
create index if not exists pro_shares_recipient on pro_shares(tenant_id, recipient_id, created_at desc);

-- Row level security: the server writes with the service connection; through PostgREST a signed-in
-- user reads only threads they belong to and shares they own or received. No write policies.
alter table pro_dm_threads enable row level security;
alter table pro_dm_members enable row level security;
alter table pro_dm_messages enable row level security;
alter table pro_shares enable row level security;
revoke all on pro_dm_threads, pro_dm_members, pro_dm_messages, pro_shares from anon;

create or replace function public.pro_dm_is_member(tid uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.pro_dm_members m where m.thread_id = tid and m.user_id = auth.uid())
$$;
revoke all on function public.pro_dm_is_member(uuid) from public, anon;
grant execute on function public.pro_dm_is_member(uuid) to authenticated;

drop policy if exists pro_dm_threads_read on pro_dm_threads;
create policy pro_dm_threads_read on pro_dm_threads for select to authenticated using (public.pro_dm_is_member(id));
drop policy if exists pro_dm_members_read on pro_dm_members;
create policy pro_dm_members_read on pro_dm_members for select to authenticated using (public.pro_dm_is_member(thread_id));
drop policy if exists pro_dm_messages_read on pro_dm_messages;
create policy pro_dm_messages_read on pro_dm_messages for select to authenticated using (public.pro_dm_is_member(thread_id));
drop policy if exists pro_shares_read on pro_shares;
create policy pro_shares_read on pro_shares for select to authenticated using (owner_id = auth.uid() or recipient_id = auth.uid());
