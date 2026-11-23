-- 갈림길 조건(design-v0.3 §25, lib/ontology/conditions.js): 한 일 뒤에 길이 여럿일 때 갈래마다 「어떤 경우에 이쪽으로 가는가」를 글로.
-- 그 갈래로 간 실제 건(메일 · 대화)을 예시로 모델이 뽑는다. 스냅샷의 배타 갈림 조건과 실행 중 다음 단계 추천이 이 글을 쓴다.
-- 숫자로 배운 조건(금액 문턱)은 그래프의 관계에 따로 있다. 사실이나 프롬프트가 바뀐 갈림길만 다시 묻는다(facts_hash · version).
create table if not exists pro_branch_conditions (
  tenant_id   text not null,
  from_task   text not null,
  to_task     text not null,               -- '__end__' 은 「여기서 끝」
  cond        text not null default '',    -- 「고객이 금액 조정을 요청하면」 — 못 가리면 ''
  signals     jsonb not null default '[]'::jsonb,  -- 판단할 때 볼 것
  confidence  text not null default 'low', -- high | mid | low
  examples    jsonb not null default '[]'::jsonb,  -- 근거로 본 건 [{ref, at, said}]
  n           integer not null default 0,
  p           double precision not null default 0,
  note        text not null default '',     -- 갈림길 전체에 대한 말(예: 「기록만으로는 가리기 어려움」)
  model       text not null default '',
  version     text not null default '',
  facts_hash  text not null default '',
  made_at     timestamptz not null default now(),
  primary key (tenant_id, from_task, to_task)
);
