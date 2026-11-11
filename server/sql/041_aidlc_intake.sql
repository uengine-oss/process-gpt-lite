-- Robo-DLC Lite P3: work intake and the bolt line (docs/robo-dlc/plan-intake.md). Safe to run again.

-- a piece of work someone asked for in a folder's AI-DLC project: a request with the plan Lite proposed for
-- it. It waits in the inbox (asked by someone who may not start work), in the line (approved, started after
-- the work in front of it), or it became an intent of the record (intent = the intent's directory name).
create table if not exists pro_aidlc_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  folder_id uuid not null,
  user_id uuid not null,            -- who asked
  source text not null default 'app',   -- app | chat
  body text not null,
  title text,
  status text not null default 'estimating',  -- estimating | proposed | inbox | queued | started | merged | later | declined | failed
  estimate jsonb,                   -- lib/aidlc/compose.js: scores with their evidence, what it touches, the plan, conflicts
  scope text,                       -- the scope it was started with (the estimate's, or the one a person chose)
  start_mode text,                  -- now | after | merge
  fast boolean not null default false,  -- the fast lane: in front of the other waiting work
  intent text,                      -- the intent's directory name, once the record has it
  decided_by uuid,
  decided_at timestamptz,
  note text,
  known_intents jsonb,              -- the intents the record had when this was started: the new one is this request's
  head_told_at timestamptz,         -- when the people who take in work were told the line's head is free for it
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists pro_aidlc_requests_folder on pro_aidlc_requests (tenant_id, folder_id, created_at);

-- what people decided about a bolt of the line (the line itself is read from the record and the requests):
-- its release, a hold, that it was discarded and why, the saved state a running bolt can be put back to
create table if not exists pro_aidlc_line (
  tenant_id text not null,
  folder_id uuid not null,
  bolt_key text not null,           -- i:<intent dir>:<unit> | r:<request id>:<unit>
  bucket text,                      -- shipped | now | next | tail (null: where the line puts it)
  hold boolean not null default false,
  discarded_at timestamptz,
  discarded_by uuid,
  discard_reason text,
  stop_by uuid,                     -- someone asked for this bolt to be stopped: who, why, when
  stop_reason text,
  stop_at timestamptz,
  stop_security boolean not null default false,   -- a security reason: the session was paused at once
  discarded_for text,               -- the request (id) it gave way to
  restored jsonb,                   -- what the discard put back: { files, kept, ref }
  snapshot text,                    -- git object of the working tree when the bolt started
  snapshot_head text,
  snapshot_untracked jsonb,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, folder_id, bolt_key)
);
