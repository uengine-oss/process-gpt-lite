-- 개선안(lib/ontology/improveplans.js · flowplan.js, 설계 docs/auto-ax-onboarding/design-improve-on-map.md §5.3 · §6): 지도의 병목 보기에서
-- 「고쳐 보기」로 만든 안. 읽은 지도의 시점 · 측정 범위 · 고칠 것(levers) · 예상(before · after)을 지니고, 합의(의견, pro_map_opinions)에 올려
-- 관리자가 정하면 효력일이 찍힌다. 정한 뒤 「시행 전후」는 효력일 뒤의 실행 기록으로 다시 잰다(저장하지 않음). 여러 번 돌려도 된다.
-- 새 테이블만 만든다 — 공용 테이블(todolist · bpm_proc_inst · proc_def)과 다른 기능의 테이블은 그대로다.
create table if not exists pro_improve_plans (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     text not null,
  proc_key      text not null,
  name          text not null,
  levers        jsonb not null default '[]'::jsonb,
  words         text,
  map_at        timestamptz not null default now(),
  theta         float8,
  measure       jsonb,
  baseline      jsonb,
  predicted     jsonb,
  notes         jsonb not null default '[]'::jsonb,
  status        text not null default 'draft' check (status in ('draft', 'voted', 'decided', 'declined')),
  opinion_id    uuid,
  effective_at  timestamptz,
  decided_by    text,
  decided_note  text,
  decided_at    timestamptz,
  batch         uuid,
  members_added jsonb not null default '[]'::jsonb,
  created_by    text not null,
  created_name  text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists pro_improve_plans_proc on pro_improve_plans (tenant_id, proc_key, created_at desc);
create index if not exists pro_improve_plans_opinion on pro_improve_plans (tenant_id, opinion_id);
alter table pro_improve_plans enable row level security;
