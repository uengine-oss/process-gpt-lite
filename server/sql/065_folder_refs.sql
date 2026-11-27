-- 폴더 참조(스펙 openspec/specs/folder-refs — 2026-11-26): 공유 폴더 안에 다른 폴더 · 그 하위 폴더 · 파일 하나를 가리키는 「참조 자리」를 둔다.
-- 내용은 원본 폴더에만 있고, 구성하는 폴더의 git 저장소에는 아무것도 들어가지 않는다(gitlink · .gitmodules 없음). 서버가 읽을 때마다
-- 보는 사람의 원본 권한을 확인해 푼다(server/lib/folders/refs.js resolve).
-- 더하기만 한다. 여러 번 돌려도 된다. RLS 는 켜고 정책은 두지 않는다(다른 pro_* 처럼 서버만 읽고 쓴다).
--   pro_folder_refs        — 자리 하나: 구성하는 폴더 · 자리 경로 · 이름표 · 원본(폴더 · 경로 · 종류) · 따라가기/고정
--   pro_folder_ref_events  — 참조에 일어난 일(추가만): added · removed · renamed · access_requested … (구성하는 폴더가 지워지면 함께 지워진다)
--   pro_thread_folders.refs_off — 대화 하나에서 끈 자리(다음 단계에서 쓴다)
-- 같은 회사 안에서만: 서버 코드가 두 폴더를 그 회사에서 찾는 것에 더해, 트리거가 행 · 구성하는 폴더 · 원본의 회사가 다르면 거절한다.
create table if not exists pro_folder_refs (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         text not null,
  folder_id         uuid not null references pro_folders(id) on delete cascade,
  slot              text not null,
  label             text not null,
  source_folder_id  uuid references pro_folders(id) on delete set null,
  source_path       text not null default '',
  source_type       text not null check (source_type in ('folder', 'dir', 'file')),
  track             text not null default 'main' check (track in ('main', 'pin')),
  pinned_commit     text,
  seen_commit       text,
  created_by        uuid,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (folder_id, slot),
  check (track <> 'pin' or pinned_commit is not null),
  check (source_folder_id is distinct from folder_id)
);
create index if not exists pro_folder_refs_source on pro_folder_refs (source_folder_id);
alter table pro_folder_refs enable row level security;

create or replace function pro_folder_refs_same_tenant() returns trigger language plpgsql set search_path = public, pg_temp as $$
declare
  own text;
  src text;
begin
  -- (the source going away clears it — on delete set null — even when the composing folder goes in the same statement)
  if tg_op = 'UPDATE' and new.source_folder_id is null and new.folder_id = old.folder_id and new.tenant_id = old.tenant_id then
    return new;
  end if;
  select tenant_id into own from pro_folders where id = new.folder_id;
  if own is null or own <> new.tenant_id then
    raise exception 'pro_folder_refs: folder % is not in tenant %', new.folder_id, new.tenant_id using errcode = '23514';
  end if;
  if new.source_folder_id is not null then
    select tenant_id into src from pro_folders where id = new.source_folder_id;
    if src is null or src <> new.tenant_id then
      raise exception 'pro_folder_refs: source % is not in tenant %', new.source_folder_id, new.tenant_id using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists pro_folder_refs_same_tenant on pro_folder_refs;
create trigger pro_folder_refs_same_tenant before insert or update of tenant_id, folder_id, source_folder_id on pro_folder_refs
  for each row execute function pro_folder_refs_same_tenant();

create table if not exists pro_folder_ref_events (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  text not null,
  folder_id  uuid not null,
  ref_id     uuid not null,
  actor      uuid,
  kind       text not null,
  detail     jsonb not null default '{}'::jsonb,
  at         timestamptz not null default now()
);
create index if not exists pro_folder_ref_events_ref on pro_folder_ref_events (ref_id, kind, actor);
alter table pro_folder_ref_events enable row level security;
-- once_key: an event that happens at most once (an access request — once a day per person and slot), claimed by the insert itself
alter table pro_folder_ref_events add column if not exists once_key text;
create unique index if not exists pro_folder_ref_events_once on pro_folder_ref_events (once_key) where once_key is not null;
-- the composing folder going takes its reference records with it
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'pro_folder_ref_events_folder_fk') then
    delete from pro_folder_ref_events e where not exists (select 1 from pro_folders f where f.id = e.folder_id);
    alter table pro_folder_ref_events add constraint pro_folder_ref_events_folder_fk foreign key (folder_id) references pro_folders(id) on delete cascade;
  end if;
end $$;

alter table pro_thread_folders add column if not exists refs_off uuid[] not null default '{}';
