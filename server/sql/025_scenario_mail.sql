-- Agentic BPM 시나리오 3 — 외부 메일·자료 공유 (pgpt-pro/docs/agentic-bpm/plan.md §6, lib/scenarios/mail.js).
-- 시연용 보낸편지함: 에이전트가 정책(lib/policy)을 거쳐 "보낸" 메일이 여기에 남는다. 실제로 메일을 보내지는 않는다.
-- Idempotent: safe to run again.

create table if not exists pro_outbox (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  user_id uuid,                              -- 보낸(시킨) 사람: 승인 뒤 실행돼도 요청한 사람
  recipients jsonb not null default '[]',    -- ["kim@globex.com", …]
  subject text,
  body text,
  attachments jsonb not null default '[]',   -- [{name, size, source: demo|chat|inline, text}]
  status text not null default 'sent' check (status in ('sent', 'recalled')),
  decision_id uuid,                          -- pro_policy_decisions.id (원장의 판단)
  created_at timestamptz not null default now(),
  recalled_at timestamptz                    -- 기록·감사(HOTL)로 보낸 메일을 10분 안에 회수한 시각
);
create index if not exists pro_outbox_user on pro_outbox (tenant_id, user_id, created_at desc);
create index if not exists pro_outbox_decision on pro_outbox (decision_id);
