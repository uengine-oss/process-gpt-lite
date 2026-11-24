-- 채팅에서 고르는 에이전트(lib/localAgents/chat.js · 설계 docs/local-agents/design.md §12): 채팅 입력창 옆에서 「기본」(서버의 업무 에이전트)
-- 대신 「Claude Code · 내 PC」 · 「Codex · 내 PC」를 고르면, 그 메시지는 보낸 사람 자신의 데스크톱 앱이 그 사람의 CLI 로 돌린다.
-- 여러 번 돌려도 된다. 더하기만 한다 — 이미 있는 테이블의 열을 지우거나 바꾸지 않는다.
--   pro_local_jobs.kind      — 로컬 일의 종류: 'step'(프로세스 단계, 지금까지의 모든 행) · 'chat'(채팅 메시지). 비우면 'step'.
--   pro_local_jobs.thread_id — 'chat' 의 대화(pro_threads.id). 'chat' 은 todo_id 에 'chat:<uuid>' 를 둔다(단계와 겹치지 않게).
--   pro_local_jobs.chat      — 'chat' 의 나머지: 대화 열쇠(대화 · 그 안의 갈래), 폴더(프로젝트 폴더의 변형 · 내 PC 에이전트 폴더),
--                              보낸 메시지들, 올라온 답(턴 번호 — 같은 답을 두 번 올리지 않게), 잇는 CLI 세션.
--   pro_chat_agents          — 사람이 대화마다 고른 에이전트(메인 채팅 · 프로젝트 · 맥락으로 나눈 대화마다 한 행). 웹 · 휴대폰 ·
--                              데스크톱 앱에서 같은 선택이 보인다.
-- RLS 는 켜고 정책은 두지 않는다(다른 pro_* 처럼 서버만 읽고 쓴다).
alter table pro_local_jobs add column if not exists kind text not null default 'step';
alter table pro_local_jobs add column if not exists thread_id uuid;
alter table pro_local_jobs add column if not exists chat jsonb;
create index if not exists pro_local_jobs_chat on pro_local_jobs (tenant_id, user_id, thread_id, created_at desc) where kind = 'chat';

create table if not exists pro_chat_agents (
  tenant_id   text not null,
  user_id     uuid not null,
  chat_key    text not null,
  agent       text not null,
  updated_at  timestamptz not null default now(),
  primary key (tenant_id, user_id, chat_key)
);
alter table pro_chat_agents enable row level security;
