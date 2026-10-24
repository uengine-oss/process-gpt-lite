-- 패널 앱: 이벤트 소싱·기본 보안. 감사 기록과 생성 직후 보안 기본값 확인 여부.
alter table pro_panel_apps add column if not exists kind text not null default 'list';   -- list | events
alter table pro_panel_apps add column if not exists privacy_ack boolean not null default true; -- false until the creator reviews the defaults
create table if not exists pro_panel_app_audit (
  id bigserial primary key,
  app_id uuid references pro_panel_apps(id) on delete cascade,
  user_id uuid,
  action text not null,        -- rules | loosen | read_sensitive | snapshot | privacy_ack | convert
  detail jsonb not null default '{}',
  at timestamptz default now()
);
create index if not exists pro_panel_app_audit_app on pro_panel_app_audit(app_id, at desc);
