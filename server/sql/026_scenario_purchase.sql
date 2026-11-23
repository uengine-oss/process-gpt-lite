-- Agentic BPM PoC, 구매 시나리오 (pgpt-pro/docs/agentic-bpm/plan.md §6 2, lib/scenarios/purchase):
-- 발주서. 승인 전에 미리 만드는 초안(선행 실행, 반려되면 취소 = 보상)과 승인 뒤의 실제 발주를 한 줄로 둔다.
-- 데모용 발주 원장이다 — 실제 ERP·공급사 시스템과 연결되지 않는다(재고 확인도 데모 데이터).
-- Idempotent: safe to run again.

create table if not exists pro_purchase_orders (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  proc_inst_id text not null,
  po_no text not null,
  status text not null default 'draft' check (status in ('draft', 'cancelled', 'placed')),
  item text,
  quantity int,
  unit_price numeric,
  amount numeric,
  supplier text,
  supplier_new boolean not null default false,
  stock jsonb,                          -- 공급사 재고·납기 확인 결과 {available, leadDays, checkedAt, demo: true}
  draft_decision uuid,                  -- 초안을 만든 판단 (pro_policy_decisions, purchase.order speculative)
  order_decision uuid,                  -- 실제 발주 판단 (purchase.order approved)
  history jsonb not null default '[]',  -- [{at, what, by, note}] 초안·수량 조정·취소·발주
  created_at timestamptz not null default now(),
  placed_at timestamptz,
  placed_by uuid,
  cancelled_at timestamptz,
  cancel_reason text
);
-- 인스턴스 하나에 살아 있는(취소되지 않은) 발주서는 하나
create unique index if not exists pro_purchase_orders_live on pro_purchase_orders (tenant_id, proc_inst_id) where status <> 'cancelled';
create index if not exists pro_purchase_orders_inst on pro_purchase_orders (tenant_id, proc_inst_id);
-- 발주 번호 PO-2026-5001 … (동시에 만든 초안끼리 번호가 겹치지 않게)
create sequence if not exists pro_purchase_order_no start 5001;
create unique index if not exists pro_purchase_orders_no on pro_purchase_orders (tenant_id, po_no);
