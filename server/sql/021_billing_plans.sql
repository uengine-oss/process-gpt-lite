-- 요금제(lib/plans): 회사(테넌트)마다 고른 요금제, 사람마다 좌석, 요금제·추가 사용량 요청.
-- 한도 자체는 LiteLLM 이 가진다(같은 Postgres 의 litellm 스키마). 이 표는 "무엇을 걸어야 하는가"이고,
-- lib/plans/apply.js 가 그것을 LiteLLM 의 키·구성원·팀 한도로 옮긴다. Idempotent: safe to run again.

create table if not exists pro_billing_subscriptions (
  tenant_id text primary key,
  catalog text not null default 'claude',
  plan text not null default 'free',
  billing text not null default 'month' check (billing in ('month', 'year')),
  -- Team: 좌석 한도를 넘은 사용에 쓰는 회사 월 풀(0 = 추가 사용량 끔). Enterprise: 회사 월 지출 한도(0 = 없음)
  extra_usage_usd numeric not null default 0 check (extra_usage_usd >= 0),
  updated_by uuid,
  updated_at timestamptz not null default now()
);

create table if not exists pro_billing_seats (
  tenant_id text not null,
  user_id uuid not null,
  seat text not null,
  -- 관리자가 정한 이 사람의 월 한도(USD, 비우면 좌석 기본값)
  limit_usd numeric check (limit_usd is null or limit_usd >= 0),
  updated_by uuid,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, user_id)
);

create table if not exists pro_billing_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  user_id uuid not null,
  kind text not null check (kind in ('plan', 'seat', 'extra_usage')),
  wanted text,
  note text,
  status text not null default 'open' check (status in ('open', 'done', 'declined')),
  decided_by uuid,
  decided_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists pro_billing_requests_open on pro_billing_requests (tenant_id) where status = 'open';
