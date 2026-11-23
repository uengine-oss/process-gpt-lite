-- 단계의 꼭 · 선택(lib/ontology/steprule.js): 프로세스의 단계마다 조직이 약속한 단계(꼭 하는 단계 — 품질)와 건에 따라 해도 되고 안 해도
-- 되는 단계(선택), 그리고 사안에 따라(금액 · 글로 쓴 조건) 바뀌는 규칙. 지도에서 단계를 눌러 정한다(관리자). 바꾼 것은 결정 원장에도.
--   required: 이 프로세스의 스냅샷이 늘 지나가고(고정과 같다) 에이전트가 건너뛰지 않는다. 사람이 지나치려 하면 까닭을 받는다.
--   optional: 단계가 열릴 때 이 건에 필요한지 읽어 건너뛰거나(사람이 지켜봄) 늘 묻는다(단계마다 사람이 정함).
--   null: 지도대로(규칙만 둔 단계).
-- 새 표 하나와, 041 의 우리 표 pro_case_steps 에 열 몇 개 — 기존 공용 표는 고치지 않는다. 여러 번 돌려도 된다.

create table if not exists pro_step_requirements (
  tenant_id   text not null,
  proc_key    text not null,
  task        text not null,                                     -- 지도에서 누른 단계(일의 key)
  requirement text check (requirement in ('required', 'optional')),
  rules       jsonb not null default '[]'::jsonb,                -- [{when:{field:'amount', op:'>=', value} | {text}, then:'required'|'optional'}], 위에서부터 맞는 첫 규칙
  reason      text,
  by_user     text,
  at          timestamptz not null default now(),
  primary key (tenant_id, proc_key, task)
);
alter table pro_step_requirements enable row level security;

-- 건의 단계마다: 그 건에서 읽은 꼭 · 선택(requirement), 무엇이 맞았는지(matched: 규칙 · 근거 · 확률), 선택 단계면 이 건에 필요한지 읽은 것(need),
-- 건너뛰었으면 그 까닭(skip: {reason, by, at})
alter table pro_case_steps add column if not exists requirement text;
alter table pro_case_steps add column if not exists matched jsonb;
alter table pro_case_steps add column if not exists need jsonb;
alter table pro_case_steps add column if not exists skip jsonb;
-- 상태에 skipped(건너뜀), 사람이 정한 것에 skip(건너뛰기)
alter table pro_case_steps drop constraint if exists pro_case_steps_state_check;
alter table pro_case_steps add constraint pro_case_steps_state_check check (state in ('auto', 'waiting', 'go', 'released', 'moved', 'skipped'));
alter table pro_case_steps drop constraint if exists pro_case_steps_decision_check;
alter table pro_case_steps add constraint pro_case_steps_decision_check check (decision in ('go', 'stop', 'other', 'skip'));
