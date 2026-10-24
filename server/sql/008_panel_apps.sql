-- 패널 앱: 공유 폴더의 apps/<이름>.panel.json + apps/<이름>.xlsx 가 원본, 이 표는 Home 목록용 색인
create table if not exists pro_panel_apps (
  id uuid primary key default gen_random_uuid(),
  folder_id uuid not null references pro_folders(id) on delete cascade,
  title text not null,
  icon text,
  def_path text not null,
  sheet_path text not null,
  def jsonb not null,
  def_sha text,
  created_by uuid,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (folder_id, def_path)
);
create table if not exists pro_panel_app_prefs (
  user_id uuid not null,
  app_id uuid not null references pro_panel_apps(id) on delete cascade,
  hidden boolean not null default false,
  sort int,
  primary key (user_id, app_id)
);
