-- 링크 미리보기(lib/linkPreview.js): 회사마다 끄고 켠다. 행이 없으면 켬(제품 기본값).
-- 읽은 페이지의 제목 · 설명 · 그림 주소는 서버 메모리에만 두고(하루), 데이터베이스에는 남기지 않는다 — 이 테이블은 스위치 하나다.
-- 다른 회사 설정(pro_onto_settings · pro_run_settings)처럼 회사 하나에 한 행, RLS 는 켜고 정책은 두지 않는다(서버만 읽고 쓴다).
-- 여러 번 실행해도 된다.
create table if not exists pro_link_preview_settings (
  tenant_id  text primary key,
  enabled    boolean not null default true,
  updated_by uuid,
  updated_at timestamptz not null default now()
);
alter table pro_link_preview_settings enable row level security;
