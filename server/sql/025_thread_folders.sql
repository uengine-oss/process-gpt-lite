-- A thread's folder (2026-11-18): reading uses the folder's main, writing always goes through a variation,
-- 반영 merges it back. A project works on one variation of its folder that lives as long as the project
-- (mode 'project'); a chat has a folder attached for reference (mode 'ref') and changes it only on a
-- short variation the turn makes (lib/folders/work.js startChatWork). lib/folders/threadFolders.js
create table if not exists pro_thread_folders (
  thread_id uuid primary key references pro_threads(id) on delete cascade,
  user_id uuid not null,
  folder_id uuid not null references pro_folders(id) on delete cascade,
  mode text not null check (mode in ('project', 'ref')),
  -- project: its own variation; ref: the short variation of the last change asked in the chat
  variation_id uuid references pro_folder_variations(id) on delete set null,
  -- process instances started in the project: their agent steps work on the project's variation
  instances text[] not null default '{}',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists pro_thread_folders_folder on pro_thread_folders (folder_id);
create index if not exists pro_thread_folders_instances on pro_thread_folders using gin (instances) where mode = 'project';
