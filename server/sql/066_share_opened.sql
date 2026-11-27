-- 공유한 파일을 받은 사람이 열어 봤는지(2026-11-26 사용자 휴대폰 화면, 단체방 「보냄 · 공유」 카드의 「… 아직 그대로」: 「아직그대로는 뭔가?
-- 혹시 확인여부 ㅡ 파일을 열어서 봤는지라면 좋은데 ○○○께서 열어보셨다는데 아직그대로로 표시된」 — 스펙 openspec/specs/team-sharing,
-- server/lib/team/shares.js recordOpen · receipts).
-- pro_shares 는 받는 사람 × 파일마다 한 행이다(012). 처음 연 때는 이미 opened_at 에 있었다(받은 사람이 사본을 처음 열 때만 적혔다).
-- 이제 받은 사람이 그 파일을 여는 모든 길(메신저 · 받은 편지함의 칩, 보기 화면, 「이어서 작업」, 자기 사본)에서 처음 연 때(opened_at)와
-- 마지막으로 연 때(last_opened_at)를 적는다. 보낸 사람의 카드가 받은 사람마다 「안 열어 봄」 · 「열어 봄 · 언제」를 이 두 칸으로 보여 준다.
--   last_opened_at  받은 사람이 마지막으로 연 때. 이미 열었던 행은 처음 연 때로 채운다.
--   pro_shares_chat 보낸 사람의 카드가 메시지(chat_uuid)로 받은 사람들을 찾는 색인
-- 서버(BFF)만 쓴다. RLS 는 다른 pro_* 처럼 켜 두고, 읽기 정책 pro_shares_read(012: 화면 키로는 그 공유를 보낸 사람과 받은 사람만 그 행을
-- 읽는다)는 건드리지 않는다. 쓰기 정책은 없다(쓰기는 서버만). anon 은 아무것도 못 본다.
-- 더하기만 한다. 여러 번 돌려도 된다.

alter table pro_shares add column if not exists last_opened_at timestamptz;
update pro_shares set last_opened_at = opened_at where last_opened_at is null and opened_at is not null;
create index if not exists pro_shares_chat on pro_shares (tenant_id, chat_uuid);

alter table pro_shares enable row level security;
revoke all on pro_shares from anon;
