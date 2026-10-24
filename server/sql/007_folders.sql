-- Shared folders (공유 폴더): a git repository per folder whose working tree is `main`, variations
-- as branches checked out only while someone (a person or an agent run) works on them, batch
-- merges into `main`, and an index (file list → document cards → full text) people and agents
-- search. Design: process-gpt/openspec/changes/pgpt-pro-shared-folders/design.md (안 2).
-- Only pgpt-pro tables; process-gpt's own tables are read and written through their existing
-- contracts (todolist, chat_rooms, handover_events).

create table if not exists pro_folders (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  slug text not null,
  name text not null,
  description text default '',
  kind text not null default 'managed' check (kind in ('managed', 'linked')),
  repo_path text not null,                 -- host path of the repository (working tree = main)
  default_branch text not null default 'main',
  settings jsonb not null default '{}',    -- {fulltext: bool, check_cmd: text}
  index_state jsonb not null default '{}', -- {state, files, cards, size, at, fulltext}
  created_by uuid,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (tenant_id, slug)
);

-- principal_type user: principal_id = auth user id; agent: an agent id (users.is_agent) or engine name
create table if not exists pro_folder_members (
  folder_id uuid not null references pro_folders(id) on delete cascade,
  principal_type text not null default 'user' check (principal_type in ('user', 'agent', 'role')),
  principal_id text not null,
  role text not null check (role in ('owner', 'editor', 'runner', 'viewer')),
  added_by uuid,
  created_at timestamptz default now(),
  primary key (folder_id, principal_type, principal_id)
);

create table if not exists pro_folder_variations (
  id uuid primary key default gen_random_uuid(),
  folder_id uuid not null references pro_folders(id) on delete cascade,
  branch text not null,
  title text not null,
  kind text not null default 'person' check (kind in ('run', 'instance', 'person', 'chat', 'handover', 'imported')),
  status text not null default 'open' check (status in ('open', 'ready', 'conflicted', 'merged', 'discarded')),
  base_commit text,
  head_commit text,
  holder_type text not null default 'user',
  holder_id text,
  holder_name text,
  source jsonb not null default '{}',      -- {label, proc_inst_id, todo_id, room_id, thread_id, engine}
  worktree_path text,                      -- set while checked out
  locked boolean not null default false,   -- while being handed over
  change_card jsonb,                       -- 바뀐 점 {summary, files:{path: line}, generated_at}
  created_by uuid,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (folder_id, branch)
);
create index if not exists pro_folder_variations_folder on pro_folder_variations (folder_id, status);

create table if not exists pro_folder_integrations (
  id uuid primary key default gen_random_uuid(),
  folder_id uuid not null references pro_folders(id) on delete cascade,
  variation_ids uuid[] not null,
  policy text not null default 'stop' check (policy in ('stop', 'agent', 'choose')),
  status text not null default 'running' check (status in ('running', 'conflicted', 'resolving', 'done', 'aborted')),
  steps jsonb not null default '[]',       -- [{variation_id, ok, resolved}]
  conflicts jsonb not null default '[]',   -- [{path, binary, variation_id}]
  base_commit text,
  result_commit text,
  worktree_path text,
  proc_inst_id text,
  created_by uuid,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- the index of main: tier 0 (file list) for every file, tier 1 (document card) for documents,
-- tier 2 (extracted text) when the folder's full-text index is on
create table if not exists pro_folder_files (
  folder_id uuid not null references pro_folders(id) on delete cascade,
  path text not null,
  kind text,
  size bigint,
  sha text,                 -- blob hash in main
  mtime timestamptz,
  author text,
  card jsonb,               -- memento doc_card shape {abstract, n_pages, generated_at, generation_model} + keywords
  card_sha text,            -- the blob the card was made from (skip unchanged)
  card_error text,
  body text,                -- extracted text (full-text tier only)
  updated_at timestamptz default now(),
  primary key (folder_id, path)
);

-- the folder tools in the tenant's MCP list (like the ArtCraft apps), reached with the user's JWT
update tenants set mcp = jsonb_set(coalesce(mcp, '{"mcpServers":{}}'::jsonb), '{mcpServers,pgpt-folders}',
  '{"url": "http://localhost:8787/mcp/folders", "type": "streamable-http", "enabled": true, "headers": {"Authorization": "Bearer {{user_jwt}}"}, "is_default": false}'::jsonb, true)
where id = 'localhost';
