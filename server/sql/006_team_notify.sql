-- Team and role-based routing of work. Notifications themselves stay in process-gpt's
-- `notifications` table (its todolist trigger already notifies todolist.user_id); pgpt-pro only
-- decides who that user is and reads the table for the Home "needs action" panel.

-- Who in the tenant pgpt-pro can hand work to.
create table if not exists pro_team_members (
  tenant_id text not null,
  user_id uuid not null,
  added_by uuid,
  created_at timestamptz default now(),
  primary key (tenant_id, user_id)
);

-- Process role → teammate. proc_def_id '*' is the tenant-wide default for that role name
-- (e.g. 제품 책임자 → 김민지 for every process); a process-specific row wins.
create table if not exists pro_role_assignments (
  tenant_id text not null,
  proc_def_id text not null default '*',
  role text not null,
  user_id uuid not null,
  updated_by uuid,
  updated_at timestamptz default now(),
  primary key (tenant_id, proc_def_id, role)
);
