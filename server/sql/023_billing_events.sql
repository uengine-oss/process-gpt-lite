-- 사용 이벤트 원장과 요금제 변경 이력(lib/plans/meter.js, lib/plans/history.js).
--
-- LiteLLM 은 호출을 막지 않고 사용량을 메모리 큐에 넣었다가 몇 초마다 litellm."LiteLLM_SpendLogs" 에
-- 몰아서 쓴다(호출 하나 = 한 줄, 추가만 됨). 그 표를 이벤트 스트림으로 읽는 소비자 루프가 호출마다 한 줄을
-- pro_billing_usage 에 남긴다: 누가·어느 회사·어느 기능·어느 모델·토큰·원가·크레딧, 그리고 그때의 요금제.
-- 같은 호출은 한 번만(request_id), 어디까지 읽었는지는 pro_billing_offsets, 소비자는 한 서버만(advisory lock).
--
-- 요금제가 달 중간에 바뀌면 pro_billing_plan_history 의 구간마다 좌석료를 일할로 나누고, 회사 풀도 구간의
-- 몫만큼 합친다. Idempotent: safe to run again.

create table if not exists pro_billing_usage (
  request_id text primary key,
  tenant_id text not null,
  user_id text,
  pool text,                        -- seat | extra (the company's purchased credits)
  feature text,
  model text,
  prompt_tokens int,
  completion_tokens int,
  cost_usd numeric not null,
  credits numeric,
  catalog text,
  plan text,                        -- the plan in effect when the call was made
  status text,
  at timestamptz not null,
  recorded_at timestamptz not null default now()
);
create index if not exists pro_billing_usage_tenant_at on pro_billing_usage (tenant_id, at desc);

create table if not exists pro_billing_offsets (
  name text primary key,
  last_at timestamptz,
  events bigint not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists pro_billing_plan_history (
  id bigserial primary key,
  tenant_id text not null,
  catalog text not null,
  plan text not null,
  billing text not null default 'month',
  effective_from timestamptz not null default now(),
  effective_to timestamptz,
  changed_by uuid
);
create index if not exists pro_billing_plan_history_tenant on pro_billing_plan_history (tenant_id, effective_from desc);
