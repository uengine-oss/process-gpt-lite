-- Team messenger on process-gpt's own chat (계승): 1:1·group threads are process-gpt chat_rooms and their
-- messages are chats rows, written the way process-gpt's frontend writes them, so a room is the same room
-- in both UIs (participants incl. agents, chat_insert_trigger notifications, realtime on chats).
-- pgpt-pro keeps only what process-gpt has no place for:
--   chat_rooms.context.pgpt  {kind: direct|group, direct_key, assist}
--   chats.messages.pgpt      {kind: share|mention|agent|assist, artifacts, context, by}
--   pro_shares               per-recipient grants for artifacts (now pointing at room id + chats uuid)
--   pro_chat_reads           last read time per member (process-gpt only has a per-room unread flag)
--   pro_room_suggestions     team assist suggestions (lib/team/assist.js)
-- The earlier pro_dm_* tables (012) are migrated below and left in place, unused (deprecated, see note).
-- Design: process-gpt/openspec/changes/pgpt-pro-team-sharing/design.md ("계승 매핑")

-- a chats row's time: process-gpt writes timeStamp as epoch ms (legacy UI) or ISO text (new UI, agents)
create or replace function public.pro_chat_ts(m jsonb) returns timestamptz language sql stable as $$
  select case
    when jsonb_typeof(m->'timeStamp') = 'number' then to_timestamp((m->>'timeStamp')::double precision / 1000)
    when m->>'timeStamp' ~ '^\d{12,}$' then to_timestamp((m->>'timeStamp')::double precision / 1000)
    when m->>'timeStamp' is not null and m->>'timeStamp' <> '' then (m->>'timeStamp')::timestamptz
    else null end
$$;

create table if not exists pro_chat_reads (
  room_id text not null references chat_rooms(id) on delete cascade,
  user_id uuid not null,
  last_read_at timestamptz not null default now(),
  primary key (room_id, user_id)
);
alter table pro_chat_reads enable row level security;
revoke all on pro_chat_reads from anon;
drop policy if exists pro_chat_reads_own on pro_chat_reads;
create policy pro_chat_reads_own on pro_chat_reads for select to authenticated using (user_id = auth.uid());

-- shares point at the room and the chats row now
alter table pro_shares add column if not exists room_id text;
alter table pro_shares add column if not exists chat_uuid text;
alter table pro_shares drop constraint if exists pro_shares_dm_message_id_fkey;

create table if not exists pro_room_suggestions (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  room_id text not null references chat_rooms(id) on delete cascade,
  chat_uuid text not null unique,     -- the chats row that prompted it
  work text not null,                 -- WorkAssistantGenerator-style work type (StartProcessInstance, CreateSpreadsheet, …)
  title text not null,
  reason text,
  process_id text,                    -- StartProcessInstance: the proc_def it would start
  audience uuid[] not null,           -- who is offered it (the people asked)
  dismissed uuid[] not null default '{}',
  state text not null default 'open' check (state in ('open', 'running', 'done', 'failed')),
  started_by uuid,
  result_uuid text,                   -- the chats row with the result
  judge jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists pro_room_suggestions_room on pro_room_suggestions(room_id, created_at desc);
alter table pro_room_suggestions enable row level security;
revoke all on pro_room_suggestions from anon;
-- a participant of the room (by uid in chat_rooms.participants)
create or replace function public.pro_room_is_member(rid text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.chat_rooms r, jsonb_array_elements(r.participants) p
                 where r.id = rid and p->>'id' = auth.uid()::text)
$$;
revoke all on function public.pro_room_is_member(text) from public, anon;
grant execute on function public.pro_room_is_member(text) to authenticated;
drop policy if exists pro_room_suggestions_read on pro_room_suggestions;
create policy pro_room_suggestions_read on pro_room_suggestions for select to authenticated using (public.pro_room_is_member(room_id));

-- live delivery: every new or updated chats row (from either UI or an agent) wakes the BFF, which fans
-- it out to the room's people over its event stream (SSE / long poll)
create or replace function public.pro_chats_notify() returns trigger language plpgsql as $$
begin
  perform pg_notify('pro_chats', json_build_object('uuid', NEW.uuid, 'id', NEW.id, 'op', TG_OP)::text);
  return NEW;
end $$;
drop trigger if exists pro_chats_notify on public.chats;
create trigger pro_chats_notify after insert or update on public.chats for each row execute function public.pro_chats_notify();

-- ---- migrate pro_dm_* (012) into process-gpt chat rooms (ids kept: room id = thread uuid) ----
do $$
begin
  if to_regclass('public.pro_dm_threads') is null then return; end if;
  insert into chat_rooms(id, participants, message, name, primary_agent_id, tenant_id, context)
  select t.id::text,
         coalesce((select jsonb_agg(jsonb_build_object('id', u.id::text, 'email', u.email, 'username', u.username,
                     'profile', '/images/defaultUser.png', 'agent_type', null, 'is_agent', false) order by mb.joined_at)
                   from pro_dm_members mb join users u on u.id = mb.user_id and u.tenant_id = t.tenant_id
                   where mb.thread_id = t.id), '[]'::jsonb),
         (select jsonb_build_object('msg', left(coalesce(nullif(m.body, ''), '파일 공유'), 50), 'type', 'text', 'createdAt', to_char(m.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
            from pro_dm_messages m where m.thread_id = t.id order by m.created_at desc limit 1),
         t.title, null, t.tenant_id,
         jsonb_build_object('pgpt', jsonb_build_object('kind', t.kind, 'direct_key', t.direct_key,
           'assist', coalesce((to_jsonb(t)->>'assist')::boolean, true), 'migrated_from', 'pro_dm_threads'))
  from pro_dm_threads t
  on conflict (id) do nothing;

  -- old messages are history, not news: no chat notification, no live fan-out for them
  if exists (select 1 from pg_trigger where tgrelid = 'public.chats'::regclass and tgname = 'chat_insert_trigger') then
    alter table public.chats disable trigger chat_insert_trigger;
  end if;
  alter table public.chats disable trigger pro_chats_notify;
  insert into chats(uuid, id, messages, tenant_id, thread_id)
  select m.id::text, m.thread_id::text,
         jsonb_strip_nulls(jsonb_build_object('uuid', m.id::text, 'role', 'user',
           'content', coalesce(nullif(m.body, ''), (select '📎 ' || string_agg(a->>'name', ', ') from jsonb_array_elements(m.artifacts) a)),
           'timeStamp', to_char(m.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
           'email', u.email, 'name', u.username, 'userName', u.username, 'userId', m.sender_id::text,
           'pgpt', case when m.kind = 'text' and m.artifacts = '[]'::jsonb then null
                        else jsonb_strip_nulls(jsonb_build_object('kind', m.kind, 'artifacts', m.artifacts, 'context', m.context)) end)),
         m.tenant_id, null
  from pro_dm_messages m left join users u on u.id = m.sender_id and u.tenant_id = m.tenant_id
  on conflict (uuid) do nothing;
  if exists (select 1 from pg_trigger where tgrelid = 'public.chats'::regclass and tgname = 'chat_insert_trigger') then
    alter table public.chats enable trigger chat_insert_trigger;
  end if;
  alter table public.chats enable trigger pro_chats_notify;

  insert into pro_chat_reads(room_id, user_id, last_read_at)
  select mb.thread_id::text, mb.user_id, mb.last_read_at from pro_dm_members mb
  where exists (select 1 from chat_rooms r where r.id = mb.thread_id::text)
  on conflict do nothing;

  update pro_shares s set room_id = m.thread_id::text, chat_uuid = m.id::text
  from pro_dm_messages m where s.dm_message_id = m.id and s.chat_uuid is null;
end $$;

-- pro_dm_threads / pro_dm_members / pro_dm_messages are no longer read or written (deprecated); they are
-- kept so this migration can be checked against them. Drop them in a later migration once confirmed.
comment on table pro_dm_threads is 'deprecated by 014_team_rooms.sql (messenger now on chat_rooms/chats)';
