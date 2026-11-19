-- 관리자가 확정한 프로세스 정의 (2026-11-10).
-- 단계 빈도는 필수·옵션의 초안이고, 확정은 관리자가 한다. 관리자에게 보인 추천은 관리자 확인 없이
-- 바뀌지 않는다 — 같은 업무의 새 사례는 제안(proposal)으로 오고, 관리자가 반영하거나 넣지 않는다.

-- 관리자가 확정한 단계: {"재무 검토": "optional", "계약 검토": "required"}. 없는 단계는 빈도 초안을 따른다.
alter table pro_mining_suggestions add column if not exists confirmed jsonb not null default '{}'::jsonb;
-- 같은 업무의 새 사례: {case_ids, case_count, variants, frequency, core_by_frequency, new_steps, at}
alter table pro_mining_suggestions add column if not exists proposal jsonb;
-- 관리자가 이 프로세스가 아니라고 한 사례(다른 프로세스로 옮겼거나 제안에서 넣지 않은 사례)
alter table pro_mining_suggestions add column if not exists excluded jsonb not null default '[]'::jsonb;

-- 추천마다 관리자와 나눈 대화. change 는 그 말로 실제로 바뀐 것(서버가 실행한 것)
create table if not exists pro_mining_talk (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  suggestion_id uuid not null references pro_mining_suggestions(id) on delete cascade,
  user_id text,
  role text not null check (role in ('admin', 'agent')),
  text text not null,
  change jsonb,
  created_at timestamptz not null default now()
);
create index if not exists pro_mining_talk_suggestion_idx on pro_mining_talk (suggestion_id, created_at);
