-- 초대받은 사람만 들어온다(2026-11-25 사용자: 「우리가 초대를 해준 사람에 한해서만 로그인 할 수 있는 거야」, lib/membership.js).
-- 여러 번 돌려도 된다. 더하기만 한다(3 의 정책은 같은 이름으로 다시 만든다 — 조건을 하나 더할 뿐이다). (번호 056 · 057 은 운영의 056_skill_packs · 057_policies 몫이다.)
--
-- 1) public.users.membership_status
--    Lite 는 회사의 구성원을 public.users 의 행 중 membership_status 가 'approved' 인 것(과 회사를 만든 사람)으로 본다. 이 열은
--    Process GPT 의 가입 승인(process-gpt-vue3 20260908000001_membership_approvals.sql)이 만든다. 그 이주가 없는 DB(설치판 · 개발
--    스택)에는 열이 없어서, 관리자가 「내보내기」 한 사람을 막을 수 없다(Lite 는 열이 없으면 모든 행을 승인으로 보고, 거절 · 내보내기에
--    409 로 답한다). 아래 문장은 그 이주의 첫 줄과 똑같다.
--      · 열이 없는 DB: 열을 더한다. 이미 있는 행은 모두 'approved'(지금 들어오던 사람은 그대로 들어온다), 기본값도 'approved'.
--        Process GPT 의 트리거 · 정책 · 검사 제약 · signup_requests 는 만들지 않는다. Lite 는 새 행을 늘 'pending' 으로 적고, 들여보내는
--        사람이 곧바로 승인한다.
--      · 열이 이미 있는 DB(운영 *.process-gpt.io — 2026-11-19 묶음): 「column already exists, skipping」 알림만 내고 아무것도 바꾸지
--        않는다. 열의 기본값('pending') · 행의 값 · 제약 · 트리거 모두 그대로다.
--      · Process GPT 의 이주를 나중에 적용해도 된다(그 이주도 ADD COLUMN IF NOT EXISTS 로 이 열을 그대로 쓴다). 그래서 제약
--        (users_membership_status_check)과 signup_requests 는 여기서 만들지 않는다.
alter table public.users add column if not exists membership_status text not null default 'approved';

-- 2) pro_join_requests — 거절 화면의 「가입 요청 보내기」가 남기는 Lite 의 가입 요청
--    users 행을 만들지 않는다: 승인을 받지 않는 배포(membership_settings.require_approval = false)에서는 Process GPT 의 트리거가 새
--    행을 곧바로 승인해, 행으로 남긴 요청은 그대로 가입이 되어 버린다. 그래서 요청은 이 테이블에 두고, 관리자가 승인할 때 행을 만든다.
--    status: pending(기다림) · approved(승인 — 그때 users 행이 생김) · rejected(거절 — 다시 요청되지 않음). 회사 · 사람마다 한 행.
--    운영에도 필요하다(새 테이블). RLS 는 켜고 정책은 두지 않는다(다른 pro_* 처럼 서버만 읽고 쓴다).
create table if not exists pro_join_requests (
  tenant_id   text not null,
  user_id     uuid not null,
  email       text not null,
  name        text,
  status      text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at  timestamptz not null default now(),
  reviewed_by uuid,
  reviewed_at timestamptz,
  primary key (tenant_id, user_id)
);
create index if not exists pro_join_requests_pending on pro_join_requests (tenant_id, created_at) where status = 'pending';
alter table pro_join_requests enable row level security;

-- 3) 공유(pro_shares)를 PostgREST 로 직접 읽는 길도 승인된 구성원만
--    Lite 서버가 요청마다 하는 구성원 확인을 pro_shares_read 정책(sql/012)에도 둔다: 주인 · 받는 사람이 그 공유의 회사에서 승인된
--    구성원(또는 회사를 만든 사람)일 때만 읽는다. 열이 없는 DB 에서는 행이 있으면 구성원이다(Lite 와 같은 규칙).
--    pro_is_member 는 SECURITY DEFINER 로 users · tenants 를 읽는다(정책 안의 하위 쿼리가 users 의 RLS 를 다시 타지 않게).
create or replace function public.pro_is_member(t text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.users u where u.id = auth.uid() and u.tenant_id = t
                   and coalesce(to_jsonb(u)->>'membership_status', 'approved') = 'approved')
      or exists (select 1 from public.tenants x where x.id = t and x.owner::text = auth.uid()::text)
$$;
revoke all on function public.pro_is_member(text) from public, anon;
grant execute on function public.pro_is_member(text) to authenticated;

drop policy if exists pro_shares_read on pro_shares;
create policy pro_shares_read on pro_shares for select to authenticated
  using ((owner_id = auth.uid() or recipient_id = auth.uid()) and public.pro_is_member(tenant_id));
