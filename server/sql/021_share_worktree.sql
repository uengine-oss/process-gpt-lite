-- Team shares on the handover artifact worktree (공유 = 분기): a share commits the sender's
-- conversation and starts a branch per recipient from that commit, in the recipient's own work
-- conversation (a project thread whose deepagents conversation id is the branch room `pro:<thread id>`).
-- Rows without branch_room_id are the copy-style shares made before this and open as before.
-- Worktree tables/functions: process-gpt handover-artifact-worktree (install/db/compat/04_artifact_worktree.sql).
-- Design: process-gpt/openspec/changes/pgpt-pro-share-worktree/design.md

alter table pro_shares add column if not exists source_room_id text;   -- sender's branch room (pro:<thread>)
alter table pro_shares add column if not exists branch_room_id text;   -- recipient's branch room (pro:<work thread>)
alter table pro_shares add column if not exists path text;             -- the file's path in the trees
alter table pro_shares add column if not exists base_commit_id uuid;   -- sender commit the batch split from
alter table pro_shares add column if not exists start_commit_id uuid;  -- recipient branch's first head
alter table pro_shares add column if not exists batch_id uuid;         -- one share action, every recipient
alter table pro_shares add column if not exists merged_commit_id uuid; -- branch head last gathered back
create index if not exists pro_shares_source_room on pro_shares(source_room_id) where branch_room_id is not null;
create index if not exists pro_shares_branch_room on pro_shares(branch_room_id) where branch_room_id is not null;

-- the work conversation a share (recv:<message>:<recipient>) or a gathering (collect:<batch>) opened
alter table pro_threads add column if not exists share_ref text;
create unique index if not exists pro_threads_share_ref on pro_threads(user_id, share_ref) where share_ref is not null;
