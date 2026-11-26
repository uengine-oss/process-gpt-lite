-- Process GPT 의 가입 승인 중 Lite 가 기대는 부분만 — 시험이 한 트랜잭션 안에 넣고 ROLLBACK 한다(server/test/invite-only.integration.test.js).
-- 원본: process-gpt-vue3 supabase/migrations/20260908000001_membership_approvals.sql · 20261119000001_membership_approval_setting.sql
-- (운영은 2026-11-19 묶음으로 둘 다 들어 있다). 글자는 원본 그대로이고, 다음만 다르다:
--   · 검사 제약(users_membership_status_check)은 넣지 않았다 — 값은 'pending' · 'approved' · 'rejected' 뿐이고, 시험이 그 셋만 쓴다.
--   · CREATE TABLE · CREATE FUNCTION 은 IF NOT EXISTS · OR REPLACE 로(운영 묶음과 같다).
--   · RLS 정책 · 게이트(membership_access_gate · users_membership_read_gate)와 RPC 는 넣지 않았다: Lite 서버는 DB 에 직접 붙어
--     정책을 지나지 않는다. 회원 판단 · 승인 · 거절은 Lite 가 같은 행을 같은 값으로 바꾼다.

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS membership_status text NOT NULL DEFAULT 'approved';
ALTER TABLE public.users ALTER COLUMN membership_status SET DEFAULT 'pending';

CREATE TABLE IF NOT EXISTS public.signup_requests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL,
    tenant_id text NOT NULL,
    username text,
    email text NOT NULL,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
    reject_reason text,
    reviewed_by text,
    reviewed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (user_id, tenant_id) REFERENCES public.users(id, tenant_id) ON DELETE CASCADE,
    UNIQUE (user_id, tenant_id)
);

CREATE OR REPLACE FUNCTION public.queue_membership_signup() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    IF NEW.membership_status = 'pending' AND NOT COALESCE(NEW.is_agent, false) THEN
        INSERT INTO public.signup_requests(user_id, tenant_id, username, email)
        VALUES (NEW.id, NEW.tenant_id, NEW.username, COALESCE(NEW.email, ''))
        ON CONFLICT (user_id, tenant_id) DO NOTHING;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER queue_membership_signup AFTER INSERT ON public.users
FOR EACH ROW EXECUTE FUNCTION public.queue_membership_signup();


CREATE TABLE IF NOT EXISTS public.membership_settings (
    id boolean PRIMARY KEY DEFAULT true CHECK (id),
    require_approval boolean NOT NULL DEFAULT true
);
INSERT INTO public.membership_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;
ALTER TABLE public.membership_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.membership_settings FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.membership_settings TO service_role;
COMMENT ON TABLE public.membership_settings IS
    '가입 승인 설정(배포 전체, 행 하나). require_approval=true 설치형 기본값, false 는 누구나 들어오는 데모 서버.';

CREATE OR REPLACE FUNCTION public.membership_require_approval() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT COALESCE((SELECT require_approval FROM public.membership_settings WHERE id), true);
$$;

-- 2. 판단 함수 -----------------------------------------------------------------
-- 이 테넌트의 (승인된) 회원인가. 승인을 받지 않는 배포에서는 회원이기만 하면 된다.
CREATE OR REPLACE FUNCTION public.membership_approved() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid()
        AND tenant_id = public.tenant_id()
        AND (membership_status = 'approved' OR NOT public.membership_require_approval()));
$$;
CREATE OR REPLACE FUNCTION public.membership_admin() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid()
        AND tenant_id = public.tenant_id()
        AND (membership_status = 'approved' OR NOT public.membership_require_approval())
        AND (is_admin OR lower(role) IN ('admin','superadmin')));
$$;


-- 4. 가입할 때 ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_membership_access() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    required boolean := public.membership_require_approval();
BEGIN
    IF TG_OP = 'INSERT' THEN
        -- An upsert of an existing account must not reset its granted role.
        IF EXISTS (SELECT 1 FROM public.users WHERE id = NEW.id AND tenant_id = NEW.tenant_id) THEN
            RETURN NEW;
        END IF;
        IF NOT required OR COALESCE(NEW.is_agent, false) THEN
            -- 승인을 받지 않는 배포: 가입 흐름이 정한 역할 그대로 곧바로 회원이다.
            NEW.membership_status := 'approved';
        ELSIF EXISTS (SELECT 1 FROM public.tenants t WHERE t.id = NEW.tenant_id AND t.owner = NEW.id) THEN
            -- 새 테넌트를 만든 사람: 승인해 줄 관리자가 아직 없다.
            NEW.membership_status := 'approved';
        ELSE
            NEW.membership_status := 'pending';
            NEW.role := 'viewer';
            NEW.is_admin := false;
        END IF;
        RETURN NEW;
    END IF;

    IF NOT required THEN
        RETURN NEW;
    END IF;
    IF auth.role() IN ('authenticated','anon') AND NOT public.membership_admin()
        AND (NEW.role IS DISTINCT FROM OLD.role OR NEW.is_admin IS DISTINCT FROM OLD.is_admin
            OR NEW.membership_status IS DISTINCT FROM OLD.membership_status
            OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.id IS DISTINCT FROM OLD.id
            OR NEW.permission_ids IS DISTINCT FROM OLD.permission_ids
            OR NEW.is_agent IS DISTINCT FROM OLD.is_agent) THEN
        RAISE EXCEPTION '관리자만 권한과 가입 상태를 변경할 수 있습니다.' USING ERRCODE = '42501';
    END IF;
    -- Pre-registration hooks may assign roles after the auth insert. Approval still comes first.
    IF NEW.membership_status <> 'approved' THEN
        NEW.role := 'viewer';
        NEW.is_admin := false;
    END IF;
    RETURN NEW;
END;
$$;


CREATE OR REPLACE FUNCTION public.membership_close_signup_when_open() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    IF NEW.status = 'pending' AND NOT public.membership_require_approval() THEN
        NEW.status := 'approved';
        NEW.reviewed_by := 'system:approval-off';
        NEW.reviewed_at := now();
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS membership_close_signup_when_open ON public.signup_requests;
CREATE TRIGGER membership_close_signup_when_open BEFORE INSERT OR UPDATE ON public.signup_requests
FOR EACH ROW EXECUTE FUNCTION public.membership_close_signup_when_open();


CREATE TRIGGER guard_membership_access BEFORE INSERT OR UPDATE ON public.users
FOR EACH ROW EXECUTE FUNCTION public.guard_membership_access();
