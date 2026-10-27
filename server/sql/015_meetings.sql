-- Remote meetings in a team room (회의) — process-gpt chat_rooms/chats stay the room and its record.
-- A meeting belongs to one room; only the room's people may join, signal, upload audio or read it.
-- What the meeting leaves in the room is ordinary chats rows (messages.pgpt.kind = meeting |
-- meeting-transcript | meeting-material | meeting-minutes), so process-gpt's UI reads them as text.
-- Design: process-gpt/openspec/changes/pgpt-pro-meetings/design.md
-- Idempotent: safe to run again.

create table if not exists pro_meetings (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  room_id text not null references chat_rooms(id) on delete cascade,
  started_by uuid not null,
  state text not null default 'live' check (state in ('live', 'ended')),
  agent boolean not null default true,     -- the room's assistant (transcription, materials) for this meeting
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  card_uuid text,                          -- chats row: the meeting card (updated in place)
  minutes_uuid text,                       -- chats row: the final minutes
  summary jsonb
);
create index if not exists pro_meetings_room on pro_meetings(room_id, started_at desc);
-- one live meeting per room
create unique index if not exists pro_meetings_one_live on pro_meetings(room_id) where state = 'live';

create table if not exists pro_meeting_participants (
  meeting_id uuid not null references pro_meetings(id) on delete cascade,
  user_id uuid not null,
  name text,
  consent boolean not null default false,  -- transcription + room record
  consent_ever boolean not null default false,
  joined_at timestamptz not null default now(),
  left_at timestamptz,
  seen_at timestamptz not null default now(),
  primary key (meeting_id, user_id)
);

create table if not exists pro_meeting_segments (
  id bigserial primary key,
  meeting_id uuid not null references pro_meetings(id) on delete cascade,
  room_id text not null,
  user_id uuid not null,
  speaker text not null,
  text text not null,
  at timestamptz not null default now(),
  ms integer,                              -- transcription time
  audio_ms integer,                        -- length of the spoken piece
  block_uuid text                          -- the chats row (회의록 블록) it was written into
);
create index if not exists pro_meeting_segments_meeting on pro_meeting_segments(meeting_id, id);

create table if not exists pro_meeting_materials (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references pro_meetings(id) on delete cascade,
  room_id text not null,
  kind text not null check (kind in ('file', 'process', 'panel', 'folder', 'result')),
  ref jsonb not null,                      -- ids only (message / share / instance / app / variation), never storage URLs
  key text not null,                       -- kind + ref id: one material once per meeting
  title text not null,
  reason text,
  segment_id bigint,
  by_agent boolean not null default true,
  found_for uuid,                          -- whose access found it (the speaker)
  presented_by uuid,
  presented_at timestamptz,
  chat_uuid text,                          -- the room card, once it is recorded there
  judge jsonb,
  created_at timestamptz not null default now(),
  unique (meeting_id, key)
);

alter table pro_room_suggestions add column if not exists anchor_uuid text;
alter table pro_room_suggestions add column if not exists meeting_id uuid;

-- read access for the room's people only (writes go through the BFF)
do $$ declare t text; begin
  foreach t in array array['pro_meetings', 'pro_meeting_segments', 'pro_meeting_materials'] loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on %I from anon', t);
    execute format('drop policy if exists %I on %I', t || '_read', t);
    execute format('create policy %I on %I for select to authenticated using (public.pro_room_is_member(room_id))', t || '_read', t);
  end loop;
end $$;
alter table pro_meeting_participants enable row level security;
revoke all on pro_meeting_participants from anon;
drop policy if exists pro_meeting_participants_read on pro_meeting_participants;
create policy pro_meeting_participants_read on pro_meeting_participants for select to authenticated
  using (exists (select 1 from pro_meetings m where m.id = meeting_id and public.pro_room_is_member(m.room_id)));
