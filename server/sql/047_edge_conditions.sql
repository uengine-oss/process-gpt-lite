-- 간선 설정(edge-step-condition, lib/ontology/edgecond.js): 이벤트 → 태스크 간선(TRIGGERS)마다, 프로세스마다 그 간선으로 들어오는
-- 다음 태스크의 조건(꼭 · 선택 · 사안에 따라)과 단계 분류(사람이 꼭 · AI가 맡음 · 걷어냄 · 건너뛰었지만 해야 함)를 정한다. 지도의
-- 사건 보기에서 간선을 눌러 정한다(관리자). 같은 간선을 쓰는 다른 프로세스에는 걸리지 않는다.
-- 이력 표: 저장할 때마다 한 줄 — (proc_key, event, task)마다 가장 늦은 줄이 지금 설정이다. 「지도에서 바로」 실행은 지금 설정을,
-- 「프로세스 정의로」 실행은 스냅샷을 만든 때의 설정(at <= 그때 가운데 가장 늦은 줄)을 읽는다. 지우기는 빈 설정 한 줄(cleared).
-- task 는 지도의 일 key(다듬기에서 이름을 바꿔도 그대로인 것 — 다듬은 흐름의 origin, 다듬기에서 더한 일은 그 이름).
-- 새 표 하나 — 기존 공용 표는 고치지 않는다. 여러 번 돌려도 된다.

create table if not exists pro_edge_conditions (
  id          bigserial primary key,
  tenant_id   text not null,
  proc_key    text not null,
  event       text not null,                                     -- 이벤트 key(mail · message · timer:… · artifact:<일>:<종류> · done:<일>)
  task        text not null,                                     -- 그 간선이 여는 일(지도의 일 key)
  requirement text check (requirement in ('required', 'optional')),
  rules       jsonb not null default '[]'::jsonb,                -- [{when:{field:'amount', op, value} | {text}, then:'required'|'optional'}], 위에서부터 맞는 첫 규칙
  class       jsonb,                                             -- {class: human|ai|drop|skipped, why, by: ai|person, decided, ai:{class, why}} | null
  cleared     boolean not null default false,                    -- 이 줄로 설정을 비움
  reason      text,
  by_user     text,
  at          timestamptz not null default now()
);
create index if not exists pro_edge_conditions_edge on pro_edge_conditions (tenant_id, proc_key, event, task, at desc);
alter table pro_edge_conditions enable row level security;
