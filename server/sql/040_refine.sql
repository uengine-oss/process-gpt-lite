-- 프로세스 다듬기 ① 바로잡기 · ② 단계 가르기(plan-process-refinement §3 · §4, lib/ontology/refine.js).
-- 찾은 지도는 그대로 두고, 고친 것은 따로 쌓는다(원칙 1): pro_corrections 은 프로세스마다 「뒤집기 · 끊기 · 잇기 · 이름 바꾸기 ·
-- 합치기 · 더하기 · 빼기」 한 줄씩(누가 · 왜 · AI 제안이었는지). 다듬은 흐름 = 찾은 흐름 + 이 줄들을 차례로 얹은 것, 줄을 지우면 되돌아간다.
-- pro_refine_reviews 는 AI 가 본 것(순서 점검 review: 요약 · 고칠 곳(issues, 각 status open · accepted · dismissed) · 「사실은 이럴 것」 proposed)과
-- 단계 분류(classes: 일마다 gate · human · ai · drop · skipped · none, AI 제안과 사람이 정한 것). 프롬프트나 사실이 바뀌면 version · facts_hash 가 달라진다.
create table if not exists pro_refine_reviews (
  tenant_id   text not null,
  proc_key    text not null,
  review      jsonb,                                  -- {summary, issues:[{id,kind,title,why,evidence,fix,status}], proposed:{steps,flows}}
  classes     jsonb not null default '{}'::jsonb,     -- {[task]: {class, why, by: ai|person, decided, ai:{class,why}, pinned_here}}
  model       text not null default '',
  version     text not null default '',
  facts_hash  text not null default '',
  made_at     timestamptz not null default now(),
  primary key (tenant_id, proc_key)
);
alter table pro_refine_reviews enable row level security;

create table if not exists pro_corrections (
  id        uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  proc_key  text not null,
  op        text not null,                            -- reverse_edge | remove_edge | add_edge | rename_task | merge_task | add_task | remove_task
  args      jsonb not null default '{}'::jsonb,
  why       text not null default '',
  source    text not null default 'person' check (source in ('ai', 'person')),
  issue_id  text,                                     -- the review's issue it came from (accepted), if any
  by_user   text,
  at        timestamptz not null default now()
);
create index if not exists pro_corrections_t on pro_corrections (tenant_id, proc_key, at);
alter table pro_corrections enable row level security;
