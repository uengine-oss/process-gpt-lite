-- 팀 맥락 공유 (openspec changes/pgpt-pro-team-context): 대화 맥락을 기억처럼 자동 참고하고, 팀원의 맥락은 공개 등급·허락으로만.
--   대화 맥락 = context-router 가 나눈 context_threads(사람마다 conversation_id). 그 표는 라우터 것이라 손대지 않고 옆에 둔다.
--   공개 등급(visibility) private|listed|summary|open × 범위(reach) team|department|company, 민감(sensitive) none|proposed|confirmed.
--   등급 행이 없는 맥락은 주인의 기본 등급(pro_sharing_rules), 규칙 행도 없으면 private — 이 기능 전의 사용자는 그대로다.
--   범위의 원천은 Process GPT 조직도(configuration 'organization'), 장은 pro_team_leads(조직도 JSON 에는 장 칸이 없다).
--   모든 표는 BFF 만 읽고 쓴다(RLS 를 켜고 정책을 두지 않는다 — PostgREST 로는 아무것도 안 보인다). 여러 번 돌려도 같다.

create table if not exists pro_context_shares (
  tenant_id text not null,
  user_id uuid not null,
  conversation_id text not null,
  visibility text not null default 'summary',
  reach text not null default 'team',
  sensitive text not null default 'none',
  purpose text not null default '',                 -- 제목 깊이에 함께 보이는 한 줄 목적(주인이 쓴다)
  sensitive_dismissed_at timestamptz,                -- 주인이 민감 표시 제안을 무시함(다시 제안하지 않는다)
  updated_at timestamptz not null default now(),
  primary key (tenant_id, user_id, conversation_id),
  constraint pro_context_shares_chk check (visibility in ('private','listed','summary','open') and reach in ('team','department','company') and sensitive in ('none','proposed','confirmed'))
);

create table if not exists pro_sharing_rules (
  tenant_id text not null,
  user_id uuid not null,
  rules jsonb not null default '[]',                -- [{who: team|department|company|user:<id>, decision: allow|ask|deny, depth, duration}] — 비면 기본 규칙
  default_visibility text not null default 'summary',
  default_reach text not null default 'team',
  updated_at timestamptz not null default now(),
  primary key (tenant_id, user_id)
);

create table if not exists pro_team_leads (
  tenant_id text not null,
  node_id text not null,
  user_id uuid not null,
  primary key (tenant_id, node_id)
);

create table if not exists pro_access_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  requester uuid not null,
  owner uuid not null,
  conversation_id text not null,
  target_title text not null default '',
  depth text not null,                              -- summary | content
  doing text not null default '',
  note text not null default '',
  thread_id uuid,                                   -- 요청을 누른 대화(이 작업 동안 허락의 범위)
  status text not null default 'pending',          -- pending | granted | denied | expired
  via text,                                         -- auto | owner | expiry
  decision jsonb not null default '{}',
  grant_id uuid,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '3 days',
  decided_at timestamptz
);
alter table pro_context_shares add column if not exists sensitive_dismissed_at timestamptz;
-- 이 요청을 판단한 정책 결정(결정 원장 pro_policy_decisions 의 행). 허락·거절·만료·회수 때 그 행의 상태를 고친다
alter table pro_access_requests add column if not exists policy_decision uuid;

create index if not exists pro_access_requests_owner on pro_access_requests (tenant_id, owner, status, created_at desc);
create index if not exists pro_access_requests_requester on pro_access_requests (tenant_id, requester, created_at desc);

create table if not exists pro_grants (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  owner uuid not null,
  grantee uuid not null,
  conversation_id text not null,
  target_title text not null default '',
  depth text not null,
  duration text not null,                           -- task | 7d | forever
  thread_id uuid,                                   -- duration = task: 그 대화에서만
  until timestamptz,
  exclude jsonb not null default '[]',              -- 뺀 턴(메시지 id)
  via text not null default 'owner',
  request_id uuid,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index if not exists pro_grants_grantee on pro_grants (tenant_id, grantee, conversation_id) where revoked_at is null;

-- 자동 참고 한 번(턴)과 사람이 칩을 뺀·고정한 기록
create table if not exists pro_refers (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  user_id uuid not null,
  thread_id uuid,
  message text not null default '',
  used jsonb not null default '[]',
  requestable jsonb not null default '[]',
  skipped text,
  ms integer,
  created_at timestamptz not null default now()
);
create table if not exists pro_refer_edits (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  user_id uuid not null,
  thread_id uuid,
  owner uuid,
  conversation_id text,
  action text not null,                             -- drop | pin | unpin | off | on
  created_at timestamptz not null default now()
);
create index if not exists pro_refer_edits_user on pro_refer_edits (tenant_id, user_id, created_at);

-- 참고 기록: 누가 어느 대화에서 누구의 어떤 맥락을 어떤 깊이·근거로 썼나(「내 맥락이 쓰인 곳」)
create table if not exists pro_context_refs (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  refer_id uuid,
  viewer uuid not null,
  owner uuid not null,
  thread_id uuid,
  turn_title text not null default '',
  conversation_id text not null,
  item_title text not null default '',
  depth text not null,
  basis text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists pro_context_refs_owner on pro_context_refs (tenant_id, owner, created_at desc);

-- 열람 기록: 원문은 건마다, 요약은 사람·맥락·날짜별로 모은다
create table if not exists pro_context_views (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  viewer uuid not null,
  owner uuid not null,
  conversation_id text,
  item_title text not null default '',
  depth text not null,
  basis text not null default '',
  day date not null default current_date,
  count integer not null default 1,
  last_at timestamptz not null default now()
);
create index if not exists pro_context_views_owner on pro_context_views (tenant_id, owner, last_at desc);

-- 맥락 단위 요약(요약 깊이에 보이는 것, 팀 활동 카드의 재료): 라우터의 summary 는 최근 요청·답 원문 조각이라 따로 만든다
create table if not exists pro_context_digests (
  tenant_id text not null,
  user_id uuid not null,
  conversation_id text not null,
  summary text not null default '',
  decisions jsonb not null default '[]',
  questions jsonb not null default '[]',
  kinds jsonb not null default '{}',                -- {조사: 4, 문서 작성: 2, …}
  prompt_types jsonb not null default '[]',         -- [{name, count, examples:[문장]}]
  turns integer not null default 0,
  last_at timestamptz,
  built_at timestamptz not null default now(),
  primary key (tenant_id, user_id, conversation_id)
);

do $$
declare t text;
begin
  foreach t in array array['pro_context_shares','pro_sharing_rules','pro_team_leads','pro_access_requests','pro_grants','pro_refers','pro_refer_edits','pro_context_refs','pro_context_views','pro_context_digests'] loop
    execute format('alter table %I enable row level security', t);
  end loop;
end $$;
