-- 약속 알림(2026-11-26 사용자 「그 메일이나 그 톡에서 유입된 정보를 기반으로 어떤 일정이나 그런 맥락이 파악이 되면 그 맥락에 따라서 해당 일정
-- 때에 해당 담당자에게 알림을 보통 노티를 주거든 … 그런 기능이 지금 현재 있나 우리가? 없으면 추가해줘.」, 스펙 openspec/specs/agenda-reminders,
-- server/lib/agenda/*). 메일과 팀 메신저 대화방에서 정한 약속을 모델이 읽어 남기고, 그때가 되면 그 약속의 사람에게 알린다.
--   pro_agenda_items      약속 하나: 어디서 읽었나(대화방과 메시지 · 메일함 주인과 메일), 제목 · 때(시각이 있으면 starts_at + tz, 종일이면
--                         all_day_date) · 곳 · 링크 · 챙길 것 · 메모, 누구의 약속인가(participants), 상태(active · changed · cancelled ·
--                         dismissed), 판(version — 때나 곳이 바뀌면 하나 오르고 알림을 다시 잡는다), 「이건 아니에요」를 누른 사람,
--                         캘린더에 넣은 사람, 읽은 모델과 판정, 바뀐 기록(history)
--   pro_agenda_reminders  한 사람에게 보낼 알림 한 번: 그날 아침(day) · 시작 전(before), 보낼 때(due_at), 보낸 때(sent_at), 결과(outcome).
--                         보내기는 `update … where sent_at is null … returning` 으로 한 서버만 집는다.
--   pro_agenda_rooms      대화방마다 어디까지 읽었나(read_upto · 최근에 읽은 메시지 seen)와 지금 읽는 서버(reader · reading_at — 두 서버가 같은 메시지를 두 번
--                         읽지 않게)
--   pro_agenda_feedback   「이건 아니에요」 — 모델이 잘못 읽은 약속의 기록(그때의 약속 그대로)
--   pro_profile.agenda    한 사람의 약속 알림 설정 {on, leadMin} — null 이면 기본(켬 · 시작 1시간 전)
-- 같은 회사 울타리: 알림 · 피드백은 (item_id, tenant_id) 로 약속을 가리켜 다른 회사의 약속에 붙지 못하고, 대화방의 약속과 읽은 자리는 그 방의
-- 회사와 같아야 한다(트리거). 다른 pro_* 처럼 RLS 를 켜고 정책은 두지 않는다 — 서버의 직접 연결만 읽고 쓴다.
-- 더하기만 한다. 여러 번 돌려도 된다.

create table if not exists pro_agenda_items (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         text not null,
  source_kind       text not null,
  room_id           text references chat_rooms(id) on delete cascade,
  message_ids       text[] not null default '{}',
  mail_owner        uuid,
  mail_id           text,
  source            jsonb not null default '{}'::jsonb,
  title             text not null,
  starts_at         timestamptz,
  all_day_date      date,
  tz                text not null default 'Asia/Seoul',
  duration_min      int,
  location          text not null default '',
  link              text not null default '',
  bring             text not null default '',
  notes             text not null default '',
  audience          text not null default 'room',
  participants      uuid[] not null default '{}',
  dismissed_by      uuid[] not null default '{}',
  status            text not null default 'active',
  version           int not null default 1,
  calendar          jsonb not null default '{}'::jsonb,
  created_by_model  jsonb not null default '{}'::jsonb,
  history           jsonb not null default '[]'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint pro_agenda_items_kind check (source_kind in ('room', 'mail')),
  constraint pro_agenda_items_status check (status in ('active', 'changed', 'cancelled', 'dismissed')),
  constraint pro_agenda_items_audience check (audience in ('room', 'people', 'owner')),
  constraint pro_agenda_items_when check ((starts_at is not null) <> (all_day_date is not null)),
  constraint pro_agenda_items_source check (
    (source_kind = 'room' and room_id is not null and mail_owner is null and mail_id is null)
    or (source_kind = 'mail' and mail_owner is not null and mail_id is not null and room_id is null)),
  constraint pro_agenda_items_tenant unique (id, tenant_id)
);
create index if not exists pro_agenda_items_room on pro_agenda_items (tenant_id, room_id, status);
create index if not exists pro_agenda_items_owner on pro_agenda_items (tenant_id, mail_owner, status);
create index if not exists pro_agenda_items_people on pro_agenda_items using gin (participants);

create table if not exists pro_agenda_reminders (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     text not null,
  item_id       uuid not null,
  user_id       uuid not null,
  slot          text not null,
  version       int not null,
  due_at        timestamptz not null,
  sent_at       timestamptz,
  cancelled_at  timestamptz,
  outcome       text,
  created_at    timestamptz not null default now(),
  constraint pro_agenda_reminders_item foreign key (item_id, tenant_id) references pro_agenda_items (id, tenant_id) on delete cascade,
  constraint pro_agenda_reminders_slot check (slot in ('day', 'before')),
  constraint pro_agenda_reminders_one unique (item_id, user_id, slot, version)
);
create index if not exists pro_agenda_reminders_due on pro_agenda_reminders (tenant_id, due_at) where sent_at is null and cancelled_at is null;
create index if not exists pro_agenda_reminders_user on pro_agenda_reminders (user_id, item_id);

create table if not exists pro_agenda_rooms (
  room_id     text primary key references chat_rooms(id) on delete cascade,
  tenant_id   text not null,
  read_upto   timestamptz not null default now(),
  reader      text,
  reading_at  timestamptz,
  fails       int not null default 0,
  last_read   jsonb,
  updated_at  timestamptz not null default now()
);

create table if not exists pro_agenda_feedback (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   text not null,
  item_id     uuid not null,
  user_id     uuid not null,
  verdict     text not null default 'not_a_plan',
  item        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  constraint pro_agenda_feedback_item foreign key (item_id, tenant_id) references pro_agenda_items (id, tenant_id) on delete cascade,
  constraint pro_agenda_feedback_verdict check (verdict in ('not_a_plan'))
);
create index if not exists pro_agenda_feedback_item on pro_agenda_feedback (item_id);

alter table pro_profile add column if not exists agenda jsonb;
-- 대화방에서 최근에 읽은 메시지(검토 #4): 메시지의 시각은 쓴 사람의 시계라(chats 에는 서버의 순서가 없다) 읽을 때마다 read_upto 10분 앞까지 다시 보고,
-- 여기 있는 메시지는 건너뛴다
alter table pro_agenda_rooms add column if not exists seen text[] not null default '{}';

-- 대화방의 약속 · 읽은 자리는 그 방의 회사 것만
create or replace function public.pro_agenda_same_tenant() returns trigger language plpgsql set search_path = public as $$
begin
  if new.room_id is not null and not exists (select 1 from chat_rooms r where r.id = new.room_id and r.tenant_id = new.tenant_id) then
    raise exception 'pro_agenda: room % is not in tenant %', new.room_id, new.tenant_id using errcode = '23514';
  end if;
  return new;
end $$;
drop trigger if exists pro_agenda_items_same_tenant on pro_agenda_items;
create trigger pro_agenda_items_same_tenant before insert or update of room_id, tenant_id on pro_agenda_items
  for each row execute function public.pro_agenda_same_tenant();
drop trigger if exists pro_agenda_rooms_same_tenant on pro_agenda_rooms;
create trigger pro_agenda_rooms_same_tenant before insert or update of room_id, tenant_id on pro_agenda_rooms
  for each row execute function public.pro_agenda_same_tenant();

alter table pro_agenda_items enable row level security;
alter table pro_agenda_reminders enable row level security;
alter table pro_agenda_rooms enable row level security;
alter table pro_agenda_feedback enable row level security;
revoke all on pro_agenda_items, pro_agenda_reminders, pro_agenda_rooms, pro_agenda_feedback from anon, authenticated;
