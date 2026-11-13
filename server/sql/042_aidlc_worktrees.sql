-- Robo-DLC Lite P4: whether a request's bolts each build in their own worktree (docs/robo-dlc/plan-p4.md).
-- The person chooses it when taking the request in; the words go into the request the session is given, and
-- AI-DLC itself makes the worktrees (stage-major + swarm). Safe to run again.
alter table pro_aidlc_requests add column if not exists worktrees boolean not null default false;
