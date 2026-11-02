-- 맥락 글을 읽은 값(spec pgpt-pro_guardrail-reading): 글이 바뀌지 않았으면 모델을 다시 부르지 않는다.
-- 모델이 응답하지 않아 낱말 규칙으로 대신한 결과는 남기지 않는다(다음에 모델이 읽게).
create table if not exists pro_context_readings (
  tenant_id text not null,
  user_id text not null,
  conversation_id text not null,
  text_hash text not null,                          -- 읽은 글 + 주제 이름 + 질문 판
  topic text,                                       -- 주제 이름(민감하다고 읽었을 때), 아니면 null
  p real,                                           -- 민감할 확률(형식 일치면 null)
  source text not null,                             -- format | logprob
  model text,
  read_at timestamptz not null default now(),
  primary key (tenant_id, user_id, conversation_id)
);
alter table pro_context_readings enable row level security;
