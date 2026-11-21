-- A company's changes to a safety policy (server/lib/policies.js; decision 1, 2026-11-21).
-- The defaults live in policies/<name>.json (repository, per language). A row adds words (raises a
-- floor) or takes default words out (lowers it — an administrator's explicit act only, by_admin=true).
-- Append-only: the current words are every row folded in order, and the rows are the change history.
create table if not exists pro_policy_changes (
  id bigserial primary key,
  tenant_id text not null,
  policy text not null,            -- purchase | privacy (the file name)
  list text not null default 'words',
  level text not null,             -- purchase | payment (purchase); personal | sensitive | note (privacy)
  add_words text[] not null default '{}',
  remove_words text[] not null default '{}',
  by_user text not null,
  by_admin boolean not null default false,
  note text,
  created_at timestamptz not null default now(),
  check (cardinality(remove_words) = 0 or by_admin)
);
create index if not exists pro_policy_changes_tenant on pro_policy_changes(tenant_id, policy, id);
alter table pro_policy_changes enable row level security;
revoke all on pro_policy_changes from anon, authenticated;
-- history is never edited
create or replace function public.pro_policy_changes_append_only() returns trigger language plpgsql as $$
begin raise exception 'pro_policy_changes is append-only'; end $$;
drop trigger if exists pro_policy_changes_append_only on pro_policy_changes;
create trigger pro_policy_changes_append_only before update or delete on pro_policy_changes
  for each row execute function public.pro_policy_changes_append_only();
