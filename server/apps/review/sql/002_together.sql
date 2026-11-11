-- 검토 보드 · 함께 고르기 (server/apps/review): how a stage is reviewed (together: everyone picks, picks shown once you
-- have picked; roles: each card decided by its role), and the stage decider's word on a card the team split on.
create table if not exists app_review_modes (
  tenant_id text not null,
  folder_id uuid not null,
  stage text not null,
  mode text not null default 'together',   -- together | roles
  updated_by uuid,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, folder_id, stage)
);
create table if not exists app_review_settled (
  tenant_id text not null,
  folder_id uuid not null,
  item_key text not null,
  user_id uuid not null,                   -- the decider who settled it
  stance text not null,                    -- as a pick: agree | choose · accept | fix | reject
  choice text,
  note text,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, folder_id, item_key)
);
