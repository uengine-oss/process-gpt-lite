-- 말로 프로세스 지도 고치기 · 더하기 · 의견(lib/ontology/editmap.js · opinions.js). 여러 번 돌려도 된다.
-- 이 기능이 만든 우리 표만 고친다 — 공용 표(todolist · bpm_proc_inst · proc_def · notifications)는 그대로다.

-- 고친 기록(040)에 「말로 고침」: 사람이 말한 것을 동작으로 옮겨 적용한 줄(source said, why = 그 사람의 말). 한 번 말한 것의 줄은 같은
-- batch 를 지니고, 의견에서 온 줄은 그 의견(opinion_id)을 가리킨다 — 「고친 기록」에서 누구의 의견이었는지 보인다.
alter table pro_corrections drop constraint if exists pro_corrections_source_check;
alter table pro_corrections add constraint pro_corrections_source_check check (source in ('ai', 'person', 'said'));
alter table pro_corrections add column if not exists batch text;
alter table pro_corrections add column if not exists opinion_id uuid;

-- 의견: 일하면서 누구나 언제든 말하는 개선(적용되지 않고 모인다). 말한 범위(단계 · 관계), 말, 옮긴 동작(ops, 못 옮기면 []), 누가 · 어느 역할 ·
-- 어디서(지도 · 채팅 · 건의 단계), 상태(open → applied | declined | merged | superseded)와 정한 사람의 한 줄.
-- ops_key: 동작을 맞춰 적은 것의 지문 — 같은 사람이 같은 동작을 또 말하면 새 행이 아니고(열린 동안), 다른 사람이면 「같은 의견」으로 센다.
create table if not exists pro_map_opinions (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   text not null,
  proc_key    text not null,
  scope       jsonb,                                   -- {tasks:[…], ways:[{from,to}]} | null (프로세스 전체)
  words       text not null default '',
  ops         jsonb not null default '[]'::jsonb,      -- [{op, args}] (맞춰 적은 동작)
  ops_key     text not null,
  by_user     text not null,                           -- users.id
  by_name     text,
  role        text,
  source      text not null default 'map' check (source in ('map', 'chat', 'step')),
  case_id     uuid,
  todo_id     uuid,
  task        text,
  message_id  uuid,
  state       text not null default 'open' check (state in ('open', 'applied', 'declined', 'merged', 'superseded')),
  note        text,
  decided_by  text,
  decided_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists pro_map_opinions_t on pro_map_opinions (tenant_id, proc_key, state, created_at);
create unique index if not exists pro_map_opinions_once on pro_map_opinions (tenant_id, proc_key, ops_key, by_user) where state = 'open';
alter table pro_map_opinions enable row level security;

-- 글로 쓴 두 갈림길 조건이 같은 뜻인지(의견끼리 상충을 볼 때 한 번만 묻고 남긴다)
create table if not exists pro_map_text_pairs (
  tenant_id text not null,
  pair      text not null,                             -- sha1(두 글을 맞춰 정렬한 것)
  same      boolean not null,
  model     text,
  at        timestamptz not null default now(),
  primary key (tenant_id, pair)
);
alter table pro_map_text_pairs enable row level security;
