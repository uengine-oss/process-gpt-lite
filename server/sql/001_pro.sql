-- pgpt-pro schema (lives beside process-gpt tables in the same Supabase DB)
create table if not exists pro_profile (
  user_id uuid primary key,
  name text, email text, birth date,
  lat double precision, lon double precision, place text,
  onboarded_at timestamptz, created_at timestamptz default now()
);

create table if not exists pro_threads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  kind text not null default 'chat',            -- chat | project
  title text,
  status text,                                  -- null | working | needs_input
  conversation_id text,                         -- deepagents conversation id
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists pro_threads_user on pro_threads(user_id, kind, updated_at desc);

create table if not exists pro_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references pro_threads(id) on delete cascade,
  role text not null,                           -- user | agent | system
  kind text not null default 'text',            -- text | doc | task | vault | file | chip | divider
  content jsonb not null default '{}',
  created_at timestamptz default now()
);
create index if not exists pro_messages_thread on pro_messages(thread_id, created_at);

create table if not exists pro_actions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  verb text not null,                           -- Reply | Remind | Add | Pay | Review | Release ...
  text text not null,
  icon text, due text,
  prompt text,                                  -- what the agent does when tapped
  source jsonb,                                 -- e.g. {mail_id, from, subject}
  status text default 'open',                   -- open | running | done | dismissed
  created_at timestamptz default now()
);
create index if not exists pro_actions_user on pro_actions(user_id, status, created_at desc);

create table if not exists pro_panels (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  title text not null, icon text,
  spec jsonb not null,                          -- {html, css, script}
  data jsonb default '{}',
  refresh jsonb,                                -- {prompt, every_minutes}
  sort int default 100,
  updated_at timestamptz default now()
);

create table if not exists pro_schedules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  name text not null,
  cron text not null,
  prompt text not null,
  thread_id uuid,                               -- where results are posted
  job_name text,
  last_run timestamptz,
  created_at timestamptz default now()
);

-- Envelope encryption: one DEK per user, wrapped by the server KEK.
create table if not exists pro_vault_keys (
  user_id uuid primary key,
  kek_id text not null,
  wrapped_dek text not null,                    -- base64(iv|tag|ciphertext)
  created_at timestamptz default now()
);

create table if not exists pro_vault_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  kind text not null,                           -- login | card | apikey | oauth
  site text not null,                           -- domain or provider
  label text,                                   -- username / masked card
  secret text not null,                         -- base64(iv|tag|ciphertext) under user DEK
  status text,                                  -- null | rejected | not_logged_in
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists pro_vault_items_user on pro_vault_items(user_id, kind);

create table if not exists pro_mail_accounts (
  user_id uuid primary key,
  provider text not null,                       -- gmail | imap | demo
  address text,
  vault_item uuid,
  cursor text,                                  -- last uid / history id
  last_poll timestamptz
);

create table if not exists pro_mail_seen (
  user_id uuid not null,
  mail_id text not null,
  primary key (user_id, mail_id)
);

-- process instance threads point at bpm_proc_inst.proc_inst_id
alter table pro_threads add column if not exists ref text;
create index if not exists pro_threads_ref on pro_threads(user_id, ref);
