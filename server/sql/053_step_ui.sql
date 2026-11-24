-- 단계 입력 화면(lib/stepUi, 스펙 step-ui-a2ui): 지도에서 바로 도는 건(mapengine.js)의 사람 단계가 열리면, 그 단계의 일 정의 · 요청 ·
-- 앞 단계 결과 · 에이전트 초안을 읽어 모델이 A2UI v1.0 입력 화면(createSurface 메시지 하나)을 만든다. 할 일(todolist 행) 하나에 한 행.
-- 이 화면은 그 건 · 그 단계에서 그때 만든 것이고 양식 정의가 아니다 — form_def · proc_def 에는 아무것도 쓰지 않는다(일 정의는 양식 없이
-- 스킬 형식 그대로). 낸 값은 지금처럼 todolist.output 에 {<formId>: 값} 으로 들어가고, 이 테이블은 화면만 기억한다.
-- RLS 는 켜고 정책은 두지 않는다(다른 pro_* 테이블처럼 서버만 읽고 쓴다). 여러 번 실행해도 된다.
create table if not exists pro_step_ui (
  todo_id      uuid primary key,                  -- 이 화면이 붙은 할 일(todolist.id)
  tenant_id    text not null,
  proc_inst_id text not null,
  status       text not null check (status in ('making', 'ready', 'fallback')),  -- 만드는 중 · 쓸 수 있음 · 못 만들어 글 한 칸으로
  surface      jsonb,                             -- 검사를 통과한 createSurface 메시지(ready 일 때)
  catalog_id   text,
  lang         text not null default 'ko',        -- 맡은 사람의 화면 언어로 만들었다
  basis        text,                              -- 무엇을 보고 만들었는지(초안)의 지문 — 초안이 바뀌면 다시 만든다
  model        text,
  tries        int not null default 0,            -- 모델에게 물은 횟수(검사에 걸리면 한 번 더)
  ms           int,                               -- 만드는 데 걸린 시간
  errors       jsonb,                             -- 못 만든 까닭(검사 메시지 — 사람이 쓴 값은 담지 않는다)
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists pro_step_ui_inst on pro_step_ui (tenant_id, proc_inst_id);
alter table pro_step_ui enable row level security;
