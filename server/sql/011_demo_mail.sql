-- Demo mail that "arrives" in a demo mailbox (provider 'demo'): POST /api/mail/demo-arrive puts a
-- fictional message here and polls, the way a real inbox would get it. Never real mail.
create table if not exists pro_demo_mail (
  user_id uuid not null,
  mail_id text not null,
  sender text not null,
  subject text not null,
  body text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, mail_id)
);

-- Drafts a mail started (lib/mail.js): a 한글 draft takes minutes in office-mcp, so it is written down
-- and picked up again if this server restarts in the meantime.
create table if not exists pro_draft_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  thread_id uuid not null,
  args jsonb not null,
  status text not null default 'running',
  created_at timestamptz not null default now()
);
