-- 검토 보드 (server/apps/review): each person's stance on one review item, and the comments with their evidence.
create table if not exists app_review_marks (
  tenant_id text not null,
  folder_id uuid not null,
  item_key text not null,       -- q:<question file>#Q2@<hash of the question> | r:<review file>#R-02
  user_id uuid not null,
  stance text not null,         -- question: agree | choose | object | ask · finding: accept | fix | reject | object
  choice text,                  -- question: an option key, or 'X' with the text in note
  note text,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, folder_id, item_key, user_id)
);
create table if not exists app_review_comments (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  folder_id uuid not null,
  item_key text not null,
  user_id uuid not null,
  body text not null,
  evidence jsonb not null default '[]',   -- [{ path, focus, label } | { url, label }]
  created_at timestamptz not null default now()
);
create index if not exists app_review_comments_item on app_review_comments (tenant_id, folder_id, item_key, created_at);
