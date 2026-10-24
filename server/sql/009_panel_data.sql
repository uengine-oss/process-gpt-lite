-- 패널 앱 2단계(db): 행 단위 접근 규칙이 있는 앱의 데이터는 panel_data 스키마의 표에 두고 RLS 로 지킨다.
-- 표·정책·트리거는 서버가 정의(JSON)에서 고정 템플릿으로 만든다(lib/panelApps/rules.js). 이 파일은 바탕만.
create schema if not exists panel_data;
revoke all on schema panel_data from public, anon;
grant usage on schema panel_data to authenticated, service_role;

-- the caller's role in a folder, as a rank: 0 none, 1 viewer, 2 runner, 3 editor, 4 owner.
-- security definer: policies may read folder membership without granting pro_folder_members.
create or replace function panel_data.folder_role(fid uuid) returns int
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(max(case m.role when 'owner' then 4 when 'editor' then 3 when 'runner' then 2 when 'viewer' then 1 else 0 end), 0)
  from public.pro_folder_members m
  where m.folder_id = fid and m.principal_type = 'user' and m.principal_id = auth.uid()::text
$$;
revoke all on function panel_data.folder_role(uuid) from public, anon;
grant execute on function panel_data.folder_role(uuid) to authenticated;

alter table pro_panel_apps add column if not exists tier text not null default 'sheet';
alter table pro_panel_apps add column if not exists db_table text;

create table if not exists pro_panel_app_migrations (
  id bigserial primary key,
  app_id uuid not null references pro_panel_apps(id) on delete cascade,
  version int not null,
  kind text not null,              -- create | alter | rules | upgrade | drop
  statements text[] not null,
  destructive boolean not null default false,
  applied_by uuid,
  applied_at timestamptz default now(),
  note text
);
