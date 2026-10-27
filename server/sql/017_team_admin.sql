-- 팀원 빼기가 유지되도록: GET /api/team 은 로그인한 사람을 팀에 넣지만(처음 쓰는 사람의 온보딩),
-- 관리자가 뺀 사람은 다시 넣지 않는다. 관리자가 다시 추가하면 이 기록이 지워진다(lib/team.js).
create table if not exists pro_team_removed (
  tenant_id text not null,
  user_id uuid not null,
  removed_by uuid,
  removed_at timestamptz default now(),
  primary key (tenant_id, user_id)
);
