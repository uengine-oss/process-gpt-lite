-- AI 후보(design-v0.3 §24, lib/ontology/candidates.js): 회사 지도의 일마다 AI(에이전트 · 스킬)가 맡을 수 있는지 —
-- 모델의 판단(fit · how · why · skills · needs · risk)과 그때 본 사실(facts), 사람의 검토(status: proposed · accepted · rejected).
-- 사실이나 판단 프롬프트가 바뀐 일만 다시 묻는다(facts_hash · version). 검토는 다시 물어도 남는다.
create table if not exists pro_ai_candidates (
  tenant_id   text not null,
  task        text not null,
  fit         text not null default 'none',
  how         text not null default 'person',
  why         text not null default '',
  skills      jsonb not null default '[]'::jsonb,
  needs       jsonb not null default '[]'::jsonb,
  risk        text not null default '',
  human       jsonb not null default '[]'::jsonb,   -- 사람이 꼭 해야 하는 까닭 [{key,name,by: rule|model|both,hit}]
  facts       jsonb not null default '{}'::jsonb,
  facts_hash  text not null default '',
  version     text not null default '',
  status      text not null default 'proposed',
  note        text not null default '',
  decided_by  text,
  decided_at  timestamptz,
  made_at     timestamptz not null default now(),
  primary key (tenant_id, task)
);
