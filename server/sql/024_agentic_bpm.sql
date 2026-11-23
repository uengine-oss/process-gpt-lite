-- Agentic BPM PoC (docs: pgpt-pro/docs/agentic-bpm/plan.md): 정책·가드레일, 결정 원장, 승인 대기,
-- 전략 그래프(Lite 로컬 — process-gpt strategy 서비스는 AGE 가 있는 Postgres 를 요구), 결정 브리프, 대안 최적화.
-- Idempotent: safe to run again.

-- 정책 카탈로그: 회사마다 켜고 끄며, 내용(spec)은 lib/policy/dsl.js 의 JSON DSL
create table if not exists pro_policies (
  tenant_id text not null,
  id text not null,
  version int not null default 1,
  enabled boolean not null default true,
  spec jsonb not null,
  updated_by uuid,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id)
);

-- 결정 원장: 행위 하나에 대한 판단과 그 결과(무엇을, 왜, 누가 승인, 어떻게 끝났나)
create table if not exists pro_policy_decisions (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  user_id uuid,                     -- 행위를 한(시킨) 사람
  action_kind text not null,        -- mail.send, browser.payment, release.deploy, purchase.order, …
  subject text,                     -- 사람이 읽는 한 줄 ("kim@globex.com 에게 메일 '견적서'")
  facts jsonb not null,             -- 판단에 쓴 사실(수신자 외부 여부, 개인정보 수, 금액 …), 원문은 담지 않는다
  decision text not null check (decision in ('allow', 'allow_audit', 'require_approval', 'deny')),
  matched jsonb not null default '[]',   -- [{id, decision, explain, sources, approver}]
  dry_run boolean not null default false,
  status text not null default 'decided' check (status in ('decided', 'pending', 'approved', 'rejected', 'executed', 'undone', 'failed', 'expired')),
  approver_role text,
  approved_by uuid,
  approved_at timestamptz,
  result jsonb,
  ref text,                         -- 이 판단을 부른 것(대화 메시지, 업무 항목, 최적화 id)
  created_at timestamptz not null default now()
);
create index if not exists pro_policy_decisions_tenant on pro_policy_decisions (tenant_id, created_at desc);
create index if not exists pro_policy_decisions_window on pro_policy_decisions (tenant_id, user_id, action_kind, created_at desc) where not dry_run;
create index if not exists pro_policy_decisions_pending on pro_policy_decisions (tenant_id) where status = 'pending';

-- 승인을 받으면 실행할 행위(실행기 이름과 그 입력): lib/policy/pep.js 가 승인 뒤 다시 부른다
create table if not exists pro_policy_actions (
  decision_id uuid primary key references pro_policy_decisions(id) on delete cascade,
  executor text not null,
  payload jsonb not null,
  undo_until timestamptz            -- 기록·감사(HOTL)로 실행한 일을 되돌릴 수 있는 시각
);

-- 전략 그래프(Lite 로컬): 전략목표와 그 기여 간선
create table if not exists pro_strategy_objectives (
  tenant_id text not null,
  id text not null,
  perspective text not null default 'customer' check (perspective in ('financial', 'customer', 'process', 'learning')),
  name text not null,
  priority int not null default 3 check (priority between 1 and 5),   -- 1 = 가장 높음
  risk_appetite jsonb not null default '{}',    -- {privacy: 'low', schedule: 'medium', …}
  constraints jsonb not null default '[]',      -- [{policy: 'release-open-pii', level: 'must'|'should'}]
  kpi jsonb,                                    -- {name, target, unit, direction}
  parent text,                                  -- 상위 목표(DAG)
  primary key (tenant_id, id)
);
create table if not exists pro_strategy_links (
  tenant_id text not null,
  source text not null,             -- 'activity:<proc_def>/<activity>' | 'feature:<name>' | 'policy:<id>'
  objective text not null,
  relation text not null default 'contributes' check (relation in ('contributes', 'protects')),
  weight numeric not null default 1,
  primary key (tenant_id, source, objective, relation)
);

-- 결정 브리프: 사람 승인 단계에 미리 붙여 두는 요약·선택지·추천·선행 실행
create table if not exists pro_decision_briefs (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  todo_id text not null,
  proc_inst_id text,
  brief jsonb not null,             -- {summary, options:[{id,label,effects,policy}], recommendation, evidence}
  speculative jsonb not null default '[]',   -- [{id, title, status: done|cancelled|kept, undo}]
  created_at timestamptz not null default now(),
  decided_option text,
  decided_at timestamptz,
  unique (tenant_id, todo_id)
);

-- 대안 최적화: 막힌 행위(또는 목표를 위협하는 제약) → 대안들의 정책 검증·시뮬레이션·전략 점수 → 고른 것
create table if not exists pro_optimizations (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  user_id uuid,
  trigger jsonb not null,           -- {kind: 'policy_block'|'constraint', decision_id, action, finding}
  alternatives jsonb not null default '[]',
  chosen text,
  status text not null default 'proposed' check (status in ('proposed', 'chosen', 'executed', 'stopped', 'escalated')),
  explain text,
  created_at timestamptz not null default now(),
  decided_by uuid,
  decided_at timestamptz
);
create index if not exists pro_optimizations_tenant on pro_optimizations (tenant_id, created_at desc);
