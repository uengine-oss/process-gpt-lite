-- 변형의 자리(작업본은 한 곳에 — 스펙 openspec/specs/variation-seats, server/lib/folders/seats.js, 2026-11-26). 사용자 요청: 「폴더내 작업실을 누르면
-- 일렉트론에 연결된 모바일이나 일렉트론내 해당 워크트리를 클론하여 작업할 수 있고 로컬 폴더 작업 결과를 서버로 동기화 할 수 있다. 작업본이 여러군데
-- 흩어져서는 안되니 잘 설계해」.
-- 변형(공유 폴더의 가지 하나)을 고칠 수 있게 디스크에 펼친 작업 트리 = 작업본. 그 작업본이 있는 곳 = 자리. 자리는 변형마다 하나다:
--   행 없음                         보관 중 — 가지만 있다(아무도 고치지 않는다)
--   place='server', run='workroom'   서버 작업실에서 — 그 사람이 웹 작업실의 파일 · 셸로 고친다
--   place='server', run='agent'      서버 에이전트가 — 그 실행이 고친다
--   place='device'                   ○○의 PC 에서 — 그 기기의 그 사람만 고친다(지금은 채팅의 「내 PC」 실행, 다음 단계에서 데스크톱 작업본)
--   state='moving' · 'returning'     넘기는 중 — 끝날 때까지 아무도 고치지 않는다(기한 deadline 이 지나면 보관 중으로)
-- 기본 키가 변형이라 자리는 둘이 될 수 없다. 자리가 바뀔 때마다 pro_folder_variations.seat_epoch 가 1 씩 오르고(행이 지워져도 남는다) 그 값이
-- 행의 epoch 에 적힌다 — 옛 자리에서 온 쓰기 · 올리기(지난 회차)는 그 값으로 가려 거절한다.
--   user_id   자리를 가진 사람(사람의 id, 서버 에이전트 실행이면 그 에이전트의 id). device_id 는 pro_local_devices.id, job_id 는 그 자리를 쥔
--             로컬 실행(pro_local_jobs.id — 채팅의 「내 PC」 실행이 끝나면 자리를 내려놓는다)
--   recall    돌려 달라는 요청 {by, at, why}. 폴더 소유자는 요청 뒤 24시간 답이 없고 그 PC 가 꺼져 있을 때만 가져올 수 있다
-- pro_variation_seat_log 는 자리가 옮겨 간 기록이다(누가 · 언제 · 어디서 어디로).
-- RLS 는 켜고 정책은 두지 않는다(다른 pro_* 처럼 서버만 읽고 쓴다). 더하기만 한다. 여러 번 돌려도 된다.

alter table pro_folder_variations add column if not exists seat_epoch int not null default 0;

create table if not exists pro_variation_seats (
  variation_id uuid primary key references pro_folder_variations(id) on delete cascade,
  tenant_id    text not null,
  folder_id    uuid not null references pro_folders(id) on delete cascade,
  place        text not null check (place in ('server', 'device')),
  state        text not null default 'held' check (state in ('moving', 'held', 'returning')),
  user_id      text not null,
  device_id    uuid,
  run          text,
  job_id       uuid,
  epoch        int  not null,
  head         text,
  dirty        int  not null default 0,
  ahead        int  not null default 0,
  auto_save    boolean not null default true,
  watch        text not null default 'me' check (watch in ('me', 'folder')),
  since        timestamptz not null default now(),
  seen_at      timestamptz,
  pushed_at    timestamptz,
  deadline     timestamptz,
  recall       jsonb,
  constraint pro_variation_seats_device check ((place = 'device') = (device_id is not null))
);
-- (what runs in a server agent's place — work: turn · chat · step · handover · knowhow; ref: that run's own id — and when this server
-- last said it is still running it, seen_at: a run that stops saying so died with its process and is put away; a step deepagents runs
-- outside this server is never put away by that)
alter table pro_variation_seats add column if not exists work text;
alter table pro_variation_seats add column if not exists ref text;
create index if not exists pro_variation_seats_device on pro_variation_seats (tenant_id, device_id) where device_id is not null;
create index if not exists pro_variation_seats_folder on pro_variation_seats (folder_id);
create index if not exists pro_variation_seats_job on pro_variation_seats (job_id) where job_id is not null;
alter table pro_variation_seats enable row level security;

-- A variation's disk lock (what follows a seat decision on disk — a commit, a checkout, a removal — one at a time, across servers): a lease
-- row, renewed while the work goes on and free once `until` has passed (a server that stopped leaves nothing held for long)
create table if not exists pro_variation_locks (
  variation_id uuid primary key,
  owner        text not null,
  until        timestamptz not null
);
alter table pro_variation_locks enable row level security;

create table if not exists pro_variation_seat_log (
  id           bigint generated always as identity primary key,
  tenant_id    text not null,
  variation_id uuid not null,
  folder_id    uuid not null,
  at           timestamptz not null default now(),
  by_user      text,
  action       text not null,
  from_place   text,
  to_place     text,
  device_id    uuid,
  epoch        int,
  head         text,
  note         text
);
create index if not exists pro_variation_seat_log_v on pro_variation_seat_log (variation_id, at desc);
alter table pro_variation_seat_log enable row level security;
