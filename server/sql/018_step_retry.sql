-- 에이전트 단계 재시도(lib/stepRetry.js). process-gpt 에이전트 SDK 는 실행 중 오류가 나면 todolist.draft_status 를 FAILED 로 두고
-- 다시 집지 않는다. DB 복구 모드·연결 끊김·모델 시간 초과처럼 잠깐의 오류였으면 이 서버가 몇 번(간격을 늘려 가며) 다시 줄 세우고,
-- 그래도 안 되면 시작한 사람에게 알려 「다시 시도」를 누르게 한다. 여기는 그 횟수·마지막 오류만 남긴다(작업 자체는 todolist 그대로).
-- Idempotent: safe to run again.

create table if not exists pro_step_retries (
  todo_id text primary key,
  tenant_id text not null,
  proc_inst_id text,
  attempts int not null default 0,        -- 자동으로 다시 줄 세운 횟수
  manual int not null default 0,          -- 사람이 「다시 시도」를 누른 횟수
  last_error text,
  transient boolean,                      -- 마지막 실패가 잠깐의 오류로 보였는지
  failed_at timestamptz,                  -- 마지막으로 FAILED 를 본 때(같은 실패를 두 번 세지 않음)
  retried_at timestamptz,
  gave_up_at timestamptz,                 -- 자동 재시도를 멈추고 사람에게 알린 때
  updated_at timestamptz not null default now()
);
create index if not exists pro_step_retries_inst on pro_step_retries (proc_inst_id);
