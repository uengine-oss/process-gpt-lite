-- 내 PC 의 스킬 · 폴더를 채팅으로 서버에 — 제안과 확인 카드(server/lib/localAgents/pcTools.js · 설계 docs/local-agents/design.md §13 ·
-- 스펙 openspec/specs/local-agents 「채팅에서 내 PC 의 스킬 · 폴더를 등록 제안」 · champion-folders 「채팅으로 폴더 올리기 제안」).
-- 채팅에서 「Claude Code · 내 PC」에게 「내 PC 의 ○○ 스킬을 등록해 줘」 · 「이 폴더 올려 줘」라고 하면, 그 PC 의 CLI 가 데스크톱 앱이 준
-- Process GPT 도구(MCP)를 불러 「제안」을 만든다. 제안은 채팅의 확인 카드(「스킬을 등록할까요?」 · 「폴더를 올릴까요?」)로 보이고,
-- 그 사람이 카드의 「등록」 · 「올리기」를 눌러야 등록 · 업로드된다. 한 시간 뒤에는 사라진다.
--   kind        'skill' — 스킬 폴더의 파일은 서버 디스크의 임시 자리(폴더 뿌리 아래 .pc-proposals/<id>)에 두고, 「등록」이면 그 사람의 스킬로
--               (그리고 권한이 있으면 회사 스킬로) 만든다. 'folder' — 미리 보기만 두고, 「올리기」면 서버가 폴더를 만든 뒤 그 PC 의 앱이
--               챔피언 폴더와 같은 엔진으로 올린다(pick_id 는 그 앱이 만든 제안의 고른 폴더 — 경로는 서버에 오지 않는다).
--   state       pending · working(등록 · 올리는 중) · done · dropped(그만두기) · expired · failed
--   summary     카드가 보여 주는 것: 파일 수 · 크기 · 뺀 것과 까닭 · 실행 설정 · 에이전트 자산 · 어디서(이 PC 의 어떤 자리 — 경로 없이)
-- 서버(BFF)만 읽고 쓴다. RLS 는 다른 pro_* 처럼 켜고 정책은 두지 않는다. anon 은 아무것도 못 본다.
-- 더하기만 한다. 여러 번 돌려도 된다.
create table if not exists pro_pc_proposals (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    text not null,
  user_id      uuid not null,
  kind         text not null check (kind in ('skill', 'folder')),
  device_id    uuid,
  job_id       uuid,
  thread_id    uuid,
  message_id   uuid,
  name         text not null,
  description  text,
  scope        text,
  pick_id      text,
  summary      jsonb not null default '{}',
  state        text not null default 'pending' check (state in ('pending', 'working', 'done', 'dropped', 'expired', 'failed')),
  result       jsonb,
  error        text,
  expires_at   timestamptz not null,
  created_at   timestamptz not null default now(),
  decided_at   timestamptz
);
create index if not exists pro_pc_proposals_user on pro_pc_proposals (tenant_id, user_id, state, created_at desc);
alter table pro_pc_proposals enable row level security;
revoke all on pro_pc_proposals from anon;
