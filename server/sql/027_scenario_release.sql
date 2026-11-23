-- Agentic BPM 시나리오 1 「금요일 출시」(pgpt-pro/docs/agentic-bpm/plan.md §6, P3): 출시 계획과 QA 에이전트의 발견,
-- 출시 요청, 그리고 시연용 배포 기록. 실제로 어디에도 배포하지 않는다 — pro_release_deployments 는 "배포했다고
-- 치고" 남기는 시연 기록이다. 대안 최적화 자체는 024 의 pro_optimizations 에 남고, 여기에는 그 카드만 둔다.
-- Idempotent: safe to run again.

-- 출시 계획: 이번에 내보낼 기능들(개인정보를 다루는지)과 계획한 대상·시각, 빌드의 보안 점검 결과
create table if not exists pro_release_plans (
  tenant_id text not null,
  id text not null,
  title text not null,
  planned_for timestamptz,          -- 계획한 출시 시각(시연: 금요일 16:00)
  audience text not null default 'public' check (audience in ('public', 'beta', 'internal')),
  features jsonb not null default '[]',   -- [{name, pii, summary}]
  security_scan text not null default 'passed',   -- passed | failed | pending
  created_at timestamptz not null default now(),
  primary key (tenant_id, id)
);

-- QA 에이전트(또는 사람)가 찾은 문제: 기능 하나, 분류(개인정보·보안·품질), 심각도, 고치는 데 드는 날 추정
create table if not exists pro_release_findings (
  id text not null,
  tenant_id text not null,
  plan_id text not null,
  feature text not null,
  category text not null check (category in ('privacy', 'security', 'quality')),
  severity text not null default 'high' check (severity in ('high', 'medium', 'low')),
  title text not null,
  detail text,
  fix_days int,                     -- 고치는 데 드는 날(추정). 없으면 언제 고칠지 모른다
  status text not null default 'open' check (status in ('open', 'fixed')),
  found_by text,                    -- 'QA 에이전트' …
  created_at timestamptz not null default now(),
  primary key (tenant_id, id)
);

-- 출시 요청 한 건: 누가, 어떤 사실(facts)로 요청했고, 정책 판단과 그 뒤 최적화가 무엇이었나
create table if not exists pro_release_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  plan_id text not null,
  user_id uuid,
  facts jsonb not null,
  decision_id uuid,                 -- pro_policy_decisions
  decision text,
  optimization_id uuid,             -- pro_optimizations
  created_at timestamptz not null default now()
);
create index if not exists pro_release_requests_tenant on pro_release_requests (tenant_id, created_at desc);

-- 시연용 배포 기록(실제 배포 아님): 실행기 release.deploy 가 남기고, 되돌리기는 rolled_back 으로 바꾼다.
-- planned/scheduled 는 고른 대안의 뒤 단계(조치 후 공개 등) — 그때 다시 정책을 거쳐야 실제로 나간다.
create table if not exists pro_release_deployments (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  plan_id text not null,
  optimization_id uuid,
  alternative text,
  decision_id uuid,
  audience text not null,
  rollout int not null default 100,     -- 대상 중 몇 % 에게(카나리)
  features jsonb not null default '[]',
  status text not null check (status in ('deployed', 'scheduled', 'planned', 'rolled_back')),
  scheduled_for timestamptz,
  note text,
  created_by uuid,
  created_at timestamptz not null default now()
);
create index if not exists pro_release_deployments_tenant on pro_release_deployments (tenant_id, created_at desc);

-- 최적화 카드: 한 최적화의 'optimize' 대화 카드가 누구의 어느 메시지인지(상태가 바뀌면 모두 고친다)
create table if not exists pro_optimization_cards (
  optimization_id uuid not null,
  user_id uuid not null,
  message_id uuid not null,
  chooser boolean not null default false,   -- 이 사람이 대안을 고를 수 있다(책임자)
  primary key (optimization_id, user_id)
);
