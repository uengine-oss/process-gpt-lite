-- 오늘의 배경 사진(lib/background): 한 사람의 배경 선택과 회사 스위치. 여러 번 실행해도 된다.
-- 한 사람의 선택은 pro_profile 의 열 하나(휴대폰 · 데스크톱 · 웹이 같은 값을 읽는다). null 이면 기본 하늘이다.
--   { "photo": {사진 주소 · 출처}, "keep": "today" | "always", "day": "YYYY-MM-DD", "at": … }
alter table pro_profile add column if not exists background jsonb;

-- 회사마다 끄고 켠다. 행이 없으면 켬(제품 기본값). 사진 사이트가 준 후보는 서버 메모리에만 둔다(하루) — 이 테이블은 스위치 하나다.
-- 다른 회사 설정(pro_link_preview_settings 등)처럼 회사 하나에 한 행, RLS 는 켜고 정책은 두지 않는다(서버만 읽고 쓴다).
-- Unsplash · Pexels 키는 여기 두지 않는다: 보관함(pro_vault_items)에 회사 몫으로 암호화해 둔다.
create table if not exists pro_background_settings (
  tenant_id  text primary key,
  enabled    boolean not null default true,
  updated_by uuid,
  updated_at timestamptz not null default now()
);
alter table pro_background_settings enable row level security;
