-- 프로세스 개선 (병목·가치 흐름·제약·크리티컬 패스·what-if·개선 적용). lib/improve/*
-- 분석은 process-gpt 의 원천 테이블(todolist_status_history·events·todolist·bpm_proc_inst·proc_def_version)을 그대로 읽는다.
-- 여기는 pgpt-pro 쪽 메타만: 마지막으로 알린 제약(새 제약일 때만 알림)과 적용한 개선안 기록.
-- Idempotent: safe to run again.

create table if not exists pro_improve_state (
  tenant_id text not null,
  proc_def_id text not null,
  constraint_key text not null,          -- '<자원>|<단계 이름>' — 바뀌면 새 제약
  step_name text,
  resource_name text,
  rho double precision,
  wait_share double precision,
  detected_at timestamptz not null default now(),
  checked_at timestamptz not null default now(),
  primary key (tenant_id, proc_def_id)
);

create table if not exists pro_improve_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  proc_def_id text not null,
  from_version text,
  to_version text not null,
  arcv_id text not null,                  -- proc_def_version.arcv_id of the new version
  changes jsonb not null,                 -- [{type, step, ..., text}]
  predicted jsonb,                        -- what-if before/after at the time of applying
  notes jsonb,
  applied_by uuid,
  applied_at timestamptz not null default now()
);
create index if not exists pro_improve_runs_def on pro_improve_runs (tenant_id, proc_def_id, applied_at);

-- the improvement tools in the tenant's MCP list (like the folder tools), reached with the user's JWT
update tenants set mcp = jsonb_set(coalesce(mcp, '{"mcpServers":{}}'::jsonb), '{mcpServers,pgpt-improve}',
  '{"url": "http://localhost:8787/mcp/improve", "type": "streamable-http", "enabled": true, "headers": {"Authorization": "Bearer {{user_jwt}}"}, "is_default": false}'::jsonb, true)
where id = 'localhost';
