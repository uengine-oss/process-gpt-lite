-- Web Push (2026-11-18): the browsers and installed web apps of a person that get their Home cards as
-- system notifications even when Lite is closed (lib/webpush.js). One row per push-service endpoint.
create table if not exists pro_push_subscriptions (
  endpoint text primary key,
  user_id uuid not null,
  tenant_id text not null,
  p256dh text not null,
  auth text not null,
  ua text,
  created_at timestamptz default now(),
  last_ok_at timestamptz,
  fails int not null default 0
);
create index if not exists pro_push_subscriptions_user on pro_push_subscriptions (user_id, tenant_id);
-- read and written by the server only (like every pro_* table): no policies
alter table pro_push_subscriptions enable row level security;
