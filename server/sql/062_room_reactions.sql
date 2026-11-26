-- 대화방 말풍선 반응(2026-11-26 사용자 「다른 사람 말풍선에 좋아요 확인했음 사랑해 웃음 등을 붙힐 수 있게」, 스펙 openspec/specs/room-reactions,
-- server/lib/team/reactions.js). 팀 메신저의 메시지는 Process GPT 의 chats 행이고(014_team_rooms.sql), Process GPT 에는 반응을 둘 자리가 없다.
-- 그래서 반응은 이 테이블의 행 하나다: 누가(user_id) 어느 메시지에(chat_uuid) 어떤 반응을(reaction). 한 사람은 한 메시지에 반응마다 한 번.
--   reaction  정해 둔 여섯 가지 열쇠 중 하나 — like 👍 좋아요 · check ✅ 확인했음 · love ❤️ 사랑해 · laugh 😂 웃음 · wow 😮 놀람 · thanks 🙏 감사
--   room_id   그 메시지의 방(chats.id = chat_rooms.id). 방이나 메시지가 지워지면 반응도 지워진다.
-- 서버(BFF)가 읽고 쓴다. 다른 pro_* 처럼 RLS 를 켜고, 화면 키(authenticated)로는 같은 회사(tenant_id = public.tenant_id())이면서 그 방의 사람
-- (public.pro_room_is_member, 014)인 경우에만 읽을 수 있다. 쓰는 정책은 두지 않는다 — 쓰기는 서버만 한다. anon 은 아무것도 못 본다.
-- 대화방 이름(chat_rooms.name)은 Process GPT 의 칸을 그대로 쓰므로 SQL 이 필요 없다.
-- 더하기만 한다. 여러 번 돌려도 된다.

create table if not exists pro_chat_reactions (
  tenant_id   text not null,
  room_id     text not null references chat_rooms(id) on delete cascade,
  chat_uuid   text not null references chats(uuid) on delete cascade,
  user_id     uuid not null,
  reaction    text not null,
  created_at  timestamptz not null default now(),
  primary key (chat_uuid, user_id, reaction),
  constraint pro_chat_reactions_kind check (reaction in ('like', 'check', 'love', 'laugh', 'wow', 'thanks'))
);
create index if not exists pro_chat_reactions_room on pro_chat_reactions (room_id, chat_uuid);

alter table pro_chat_reactions enable row level security;
revoke all on pro_chat_reactions from anon;
drop policy if exists pro_chat_reactions_read on pro_chat_reactions;
create policy pro_chat_reactions_read on pro_chat_reactions for select to authenticated
  using (tenant_id = public.tenant_id() and public.pro_room_is_member(room_id));
