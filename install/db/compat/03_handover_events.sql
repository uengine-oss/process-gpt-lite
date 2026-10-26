-- 인계 기록(handover_events)과 역량 모델 — 프로세스 마이닝(server/lib/mining, process-miner)이 쓰는 표.
-- process-gpt feat/pgpt-lite-mining 의 docker-infra/volumes/db/migration.sql 추가분과 같다(멱등).
-- 서브모듈(feat/pgpt-lite)의 스키마에 아직 없어서 설치 번들이 보정한다.


-- ============================================================================
-- 핸드오버 이벤트 로그 (2026-08-12)
-- 상세 주석은 services/frontend/supabase/migrations/20260812_handover_events.sql 참고
-- ============================================================================
-- ============================================================================
-- 핸드오버 이벤트 로그
--
-- 채팅방(/chat)과 워크아이템에서 발생하는 "업무 이관" 을 구조화된 이벤트로
-- 축적한다. process-miner 서비스가 이 로그로부터 핸드오버 네트워크(조직 마이닝)와
-- 프로세스 정의(제어 흐름 마이닝)를 도출한다.
--
-- 사람과 AI 에이전트는 모두 public.users 한 테이블에 있으므로(is_agent 플래그로만
-- 구분) 이 로그도 둘을 구분하지 않는다. from_is_agent / to_is_agent 는 분석 편의를
-- 위한 비정규화 스냅샷일 뿐이며, 네트워크는 하나로 계산된다.
--
-- source
--   chat_handover    : 사용자가 채팅방에서 '인계하기' 버튼을 눌러 명시적으로 넘김
--   agent_delegation : 채팅방에서 에이전트에게 암묵적으로 위임됨(초대/라우팅)
--   todolist         : 기존 BPMN 인스턴스 실행 이력에서 역산된 이관
-- ============================================================================

create table if not exists public.handover_events (
    id                    uuid        not null default gen_random_uuid(),
    tenant_id             text        not null default public.tenant_id(),

    -- 핸드오버 체인 = 하나의 업무 케이스(프로세스 마이닝의 Case ID)
    case_id               text        not null,
    source                text        not null,
    is_explicit           boolean     not null default true,

    -- 이관 전/후 컨텍스트
    from_room_id          text        null,
    to_room_id            text        null,
    from_task_id          uuid        null,
    to_task_id            uuid        null,

    -- 리소스(사람 또는 에이전트)
    from_user_id          text        null,
    from_user_name        text        null,
    from_role             text        null,
    from_is_agent         boolean     not null default false,
    to_user_id            text        not null,
    to_user_name          text        null,
    to_role               text        null,
    to_is_agent           boolean     not null default false,
    agent_orch            text        null,

    -- 활동 라벨
    activity_label        text        null,  -- 넘기는 사람이 적은 "지금까지 한 일"
    next_activity_label   text        null,  -- 넘기는 사람이 적은 "다음에 할 일"
    norm_activity_label   text        null,  -- process-miner 가 채우는 정규화 라벨
    instruction           text        null,
    reason                text        null,

    -- 산출물 / 참여 에이전트
    artifact_refs         jsonb       not null default '[]'::jsonb,
    participant_agents    jsonb       not null default '[]'::jsonb,
    trigger_message_uuid  text        null,

    proc_def_id           text        null,

    -- 타이밍
    occurred_at           timestamptz not null default now(),
    returned_at           timestamptz null,   -- 에이전트가 결과를 돌려준 시각
    handover_latency_sec  integer     null,   -- 직전 이벤트로부터의 이관 지연

    created_at            timestamptz not null default now(),
    updated_at            timestamptz not null default now(),

    constraint handover_events_pkey primary key (id),
    constraint handover_events_source_check check (
        source in ('chat_handover', 'agent_delegation', 'todolist')
    ),
    constraint handover_events_tenant_id_fkey foreign key (tenant_id)
        references public.tenants (id) on update cascade on delete cascade
) tablespace pg_default;

create index if not exists idx_handover_events_case
    on public.handover_events (tenant_id, case_id, occurred_at);
create index if not exists idx_handover_events_from_user
    on public.handover_events (tenant_id, from_user_id);
create index if not exists idx_handover_events_to_user
    on public.handover_events (tenant_id, to_user_id);
create index if not exists idx_handover_events_from_room
    on public.handover_events (tenant_id, from_room_id);
create index if not exists idx_handover_events_to_room
    on public.handover_events (tenant_id, to_room_id);
-- process-miner 의 미처리 행 스캔용
create index if not exists idx_handover_events_unlabeled
    on public.handover_events (tenant_id, occurred_at)
    where norm_activity_label is null;

-- todolist 실행 이력 역산 시 같은 워크아이템이 두 번 들어오지 않도록
create unique index if not exists uq_handover_events_todolist
    on public.handover_events (source, to_task_id)
    where to_task_id is not null;

-- 암묵 위임 중복 방지: 같은 방·같은 에이전트·같은 트리거 메시지는 1건
-- (새로고침 후 스트림 재접속 시 중복 삽입 차단)
--
-- WHERE 절 없는 전체 인덱스여야 한다. 부분 인덱스로 만들면 PostgREST 의
-- upsert(onConflict=...) 가 술어를 지정할 수 없어 "no unique or exclusion
-- constraint matching the ON CONFLICT specification" 로 실패한다.
-- trigger_message_uuid 는 암묵 위임에만 채워지고 나머지 source 는 NULL 인데,
-- Postgres 기본값(NULLS DISTINCT)에서 NULL 은 서로 충돌하지 않으므로
-- chat_handover / todolist 행에는 아무 제약도 걸리지 않는다.
create unique index if not exists uq_handover_events_agent_delegation
    on public.handover_events (from_room_id, to_user_id, trigger_message_uuid);

drop trigger if exists handover_events_updated_at on public.handover_events;
create trigger handover_events_updated_at
    before update on public.handover_events
    for each row execute function public.update_updated_at_column();

-- RLS (resource_pull_requests 패턴과 동일)
alter table public.handover_events enable row level security;

DROP POLICY IF EXISTS handover_events_insert_policy ON public.handover_events;
create policy handover_events_insert_policy on public.handover_events
    for insert to authenticated with check (tenant_id = public.tenant_id());
DROP POLICY IF EXISTS handover_events_select_policy ON public.handover_events;
create policy handover_events_select_policy on public.handover_events
    for select to authenticated using (tenant_id = public.tenant_id());
DROP POLICY IF EXISTS handover_events_update_policy ON public.handover_events;
create policy handover_events_update_policy on public.handover_events
    for update to authenticated using (tenant_id = public.tenant_id());
DROP POLICY IF EXISTS handover_events_delete_policy ON public.handover_events;
create policy handover_events_delete_policy on public.handover_events
    for delete to authenticated using (tenant_id = public.tenant_id());


-- ============================================================================
-- 핸드오버 스레드 상관키(origin_room_id)
--
-- 이메일 스레드가 References/In-Reply-To 로 루트 Message-ID 를 앞으로 끌고 가듯,
-- 인계도 "이 업무가 최초로 시작된 방" 을 인계받는 방으로 계속 전파한다.
-- 그래야 A→B→C→D 로 이어진 인계가 Gmail 의 forward 묶음처럼 한 스레드로 모인다.
--
-- case_id 와의 관계:
--   origin_room_id — 구조적 상관키. 항상 채워지며 스레드 묶음의 기준.
--   case_id        — 분석용 케이스 키. 지금은 origin_room_id 와 같은 값이지만,
--                    나중에 업무 키(견적번호 등)나 케이스 분할이 도입되면 갈라진다.
-- 둘을 분리해 두어야 나중에 case 를 쪼개도 스레드 표시는 깨지지 않는다.
-- ============================================================================

alter table public.handover_events
    add column if not exists origin_room_id text;

-- 기존 행 백필: 지금까지는 case_id 가 곧 루트 방 id 였다.
update public.handover_events
set origin_room_id = case_id
where origin_room_id is null;

create index if not exists idx_handover_events_origin_room
    on public.handover_events (tenant_id, origin_room_id, occurred_at);

comment on column public.handover_events.origin_room_id is
    '이 업무가 최초로 시작된 채팅방 id. 인계받는 방으로 계속 전파되어 스레드 묶음의 기준이 된다.';
comment on column public.handover_events.case_id is
    '프로세스 마이닝의 Case ID. 기본값은 origin_room_id 이며 업무 키 도입 시 분리될 수 있다.';


-- ============================================================================
-- 역량(capability) 기반 조직 모델
--
-- 지금까지 조직도에는 "누가 어느 팀인가"만 있었고, "이 일을 하려면 어떤 역량이
-- 필요한가 / 누가 그 일을 맡을 자격이 있는가" 를 표현할 방법이 없었다.
-- 그래서 프로세스의 다음 단계 담당자를 사람 이름으로만 지정할 수밖에 없었고,
-- 인계 기록에서 조직 구조를 도출해도 붙일 자리가 없었다.
--
-- 세 층으로 나눈다:
--   org_capabilities        역량 사전 (예: 견적 산출, 계약 검토, 승인 권한)
--   user_capabilities       누가 어떤 역량을 가졌나 (관측 근거와 함께)
--   activity_eligibility    어떤 활동을 하려면 어떤 역량/역할/부서여야 하나
--
-- user_capabilities 는 사람이 직접 등록할 수도 있고(source='declared'),
-- 인계 기록에서 도출할 수도 있다(source='observed'). 도출된 것은 근거 건수를
-- 함께 남겨 "왜 이 사람이 후보인가" 를 설명할 수 있게 한다.
-- ============================================================================

create table if not exists public.org_capabilities (
    id           uuid        not null default gen_random_uuid(),
    tenant_id    text        not null default public.tenant_id(),
    name         text        not null,
    description  text        null,
    -- 이 역량이 처음 어떻게 생겼는지: 사람이 정의 / 인계 기록에서 도출
    origin       text        not null default 'declared',
    created_at   timestamptz not null default now(),
    constraint org_capabilities_pkey primary key (id),
    constraint org_capabilities_origin_check check (origin in ('declared', 'observed')),
    constraint org_capabilities_tenant_fkey foreign key (tenant_id)
        references public.tenants (id) on update cascade on delete cascade
);
create unique index if not exists uq_org_capabilities_name
    on public.org_capabilities (tenant_id, name);

create table if not exists public.user_capabilities (
    id             uuid        not null default gen_random_uuid(),
    tenant_id      text        not null default public.tenant_id(),
    user_id        text        not null,          -- users.id (사람 또는 에이전트)
    capability_id  uuid        not null,
    -- declared: 관리자가 등록 / observed: 인계 기록에서 도출
    source         text        not null default 'declared',
    -- 도출 근거 건수. 왜 후보로 떴는지 설명하는 데 쓴다.
    evidence_count integer     not null default 0,
    proficiency    text        null,              -- 예: primary / backup
    created_at     timestamptz not null default now(),
    updated_at     timestamptz not null default now(),
    constraint user_capabilities_pkey primary key (id),
    constraint user_capabilities_source_check check (source in ('declared', 'observed')),
    constraint user_capabilities_capability_fkey foreign key (capability_id)
        references public.org_capabilities (id) on update cascade on delete cascade,
    constraint user_capabilities_tenant_fkey foreign key (tenant_id)
        references public.tenants (id) on update cascade on delete cascade
);
create unique index if not exists uq_user_capabilities
    on public.user_capabilities (tenant_id, user_id, capability_id);

-- 활동 → 자격 요건. 담당자를 사람 이름으로 못 박지 않고
-- "이 역량을 가진 사람 / 이 역할 / 이 부서" 로 풀 수 있게 한다.
create table if not exists public.activity_eligibility (
    id                   uuid        not null default gen_random_uuid(),
    tenant_id            text        not null default public.tenant_id(),
    proc_def_id          text        null,        -- 아직 제안 단계면 비어 있을 수 있다
    activity_name        text        not null,
    required_capability  uuid        null,
    required_role        text        null,
    required_department  text        null,
    -- 이 요건이 어떻게 정해졌는지
    origin               text        not null default 'observed',
    evidence_count       integer     not null default 0,
    created_at           timestamptz not null default now(),
    constraint activity_eligibility_pkey primary key (id),
    constraint activity_eligibility_origin_check check (origin in ('declared', 'observed')),
    constraint activity_eligibility_capability_fkey foreign key (required_capability)
        references public.org_capabilities (id) on update cascade on delete set null,
    constraint activity_eligibility_tenant_fkey foreign key (tenant_id)
        references public.tenants (id) on update cascade on delete cascade
);
create index if not exists idx_activity_eligibility_lookup
    on public.activity_eligibility (tenant_id, activity_name);

drop trigger if exists user_capabilities_updated_at on public.user_capabilities;
create trigger user_capabilities_updated_at
    before update on public.user_capabilities
    for each row execute function public.update_updated_at_column();

-- RLS (resource_pull_requests 패턴과 동일)
alter table public.org_capabilities enable row level security;
alter table public.user_capabilities enable row level security;
alter table public.activity_eligibility enable row level security;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['org_capabilities','user_capabilities','activity_eligibility'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I_insert_policy ON public.%I', t, t);
    EXECUTE format('CREATE POLICY %I_insert_policy ON public.%I FOR INSERT TO authenticated WITH CHECK (tenant_id = public.tenant_id())', t, t);
    EXECUTE format('DROP POLICY IF EXISTS %I_select_policy ON public.%I', t, t);
    EXECUTE format('CREATE POLICY %I_select_policy ON public.%I FOR SELECT TO authenticated USING (tenant_id = public.tenant_id())', t, t);
    EXECUTE format('DROP POLICY IF EXISTS %I_update_policy ON public.%I', t, t);
    EXECUTE format('CREATE POLICY %I_update_policy ON public.%I FOR UPDATE TO authenticated USING (tenant_id = public.tenant_id())', t, t);
    EXECUTE format('DROP POLICY IF EXISTS %I_delete_policy ON public.%I', t, t);
    EXECUTE format('CREATE POLICY %I_delete_policy ON public.%I FOR DELETE TO authenticated USING (tenant_id = public.tenant_id())', t, t);
  END LOOP;
END $$;

comment on table public.org_capabilities is '역량 사전. 프로세스 단계가 요구하는 능력을 이름으로 다룬다.';
comment on table public.user_capabilities is '누가 어떤 역량을 가졌나. observed 는 인계 기록에서 도출된 것이며 evidence_count 가 근거 건수다.';
comment on table public.activity_eligibility is '활동 수행 자격. 담당자를 이름이 아니라 역량/역할/부서로 풀 수 있게 한다.';
