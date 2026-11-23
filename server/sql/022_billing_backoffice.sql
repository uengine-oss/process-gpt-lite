-- 빌링 백오피스(운영자, routes/backoffice.js): 회사 이름, 청구서, 크레딧 장부.
-- 결제 대행 연동 전이라 청구서는 운영자가 발행하고 입금을 확인한다(issued → paid, 또는 void).
-- 충전 크레딧은 입금 확인 뒤 운영자가 등록하고, 회사의 월 충전 풀(extra_usage_usd)에 더해진다.
-- Idempotent: safe to run again.

alter table pro_billing_subscriptions add column if not exists company_name text;

create table if not exists pro_billing_invoices (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  period text not null,                       -- 'YYYY-MM'
  catalog text not null,
  plan text not null,
  currency text not null,
  lines jsonb not null,                       -- monthlyBill() lines at the time of issue
  net numeric not null,
  total numeric not null,
  status text not null default 'issued' check (status in ('issued', 'paid', 'void')),
  issued_by uuid,
  issued_at timestamptz not null default now(),
  paid_ref text,
  paid_by uuid,
  paid_at timestamptz
);
-- one live invoice a company a month (a void one may be issued again)
create unique index if not exists pro_billing_invoices_live on pro_billing_invoices (tenant_id, period) where status <> 'void';

create table if not exists pro_billing_ledger (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  kind text not null check (kind in ('purchase', 'adjust')),
  credits numeric not null,
  amount numeric,                             -- what was paid for it (KRW on a credit catalog)
  ref text,                                   -- the bank transfer or order it came from
  note text,
  created_by uuid,
  created_at timestamptz not null default now()
);
create index if not exists pro_billing_ledger_tenant on pro_billing_ledger (tenant_id, created_at desc);
