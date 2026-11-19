-- 업무 범주: 무엇을 요청받은 업무인가(행사 견적·매장 설계 …). 마이닝이 이 값으로 사례를 묶는다.
-- 2026-11-06 회의: "식별의 기본 전략은 하나의 의도" — 단계 이름 겹침은 묶는 근거가 아니다.
-- 업무가 끝날 때 한 번 정해 저장한다. 다시 판단하지 않아야 같은 입력에 같은 묶음이 나온다.
alter table pro_mining_cases add column if not exists category text;

-- 'ai' = 업무가 끝날 때 판단한 값, 'admin' = 관리자가 식별 화면에서 고른 값(판단을 덮고, 다시 판단하지 않는다)
alter table pro_mining_cases add column if not exists category_by text;
alter table pro_mining_cases drop constraint if exists pro_mining_cases_category_by_check;
alter table pro_mining_cases add constraint pro_mining_cases_category_by_check
  check (category_by is null or category_by in ('ai', 'admin'));

-- 마이너가 "확인 필요"로 돌려준 사유(no_category · no_core_step). 비어 있으면 묻지 않는다.
alter table pro_mining_cases add column if not exists category_ask text;

create index if not exists pro_mining_cases_category_idx on pro_mining_cases (tenant_id, category);
