-- 건 이어 묶기(design-v0.3 §22): 메일 스레드 · 대화 대상 하나가 한 건이라 같은 고객 · 프로젝트의 일이 여러 건으로 끊긴다.
-- AI 가 건들의 관계(같은 고객 · 프로젝트 · 목적)를 읽어 정한 덩어리. 지도 셈(loadEvents)이 건 id 를 덩어리 id 로 바꿔 센다.
-- 다시 셀 때는 아직 이 표에 없는 건(또는 다른 판으로 읽은 건)만 모델이 본다.
create table if not exists pro_case_links (
  tenant_id text not null,
  case_id text not null,
  stream_id text,                 -- the chunk this case belongs to (null: a routine or nothing to join)
  stream text,                    -- the work stream's name (customer · project · purpose)
  why text,                       -- the model's reason, short
  version text not null default '',
  made_at timestamptz not null default now(),
  primary key (tenant_id, case_id)
);
create index if not exists pro_case_links_stream on pro_case_links (tenant_id, stream_id);
alter table pro_case_links enable row level security;
