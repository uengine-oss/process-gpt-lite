-- 다국어 협업(회의 통역 · 메신저 자동 번역). 사람마다 "주 언어"(말하고 읽는 언어)가 있고, 화면 언어(lang: ko|en)와는 따로다.
-- 회의: 참여자의 주 언어로 받아쓰고, 듣는 사람의 주 언어로 자막(원문 + 번역)과 통역 음성을 준다(lib/meetings/interpret.js).
-- 메신저: 읽는 사람의 주 언어와 다른 메시지는 번역해서 보여 준다 — (원문, 대상 언어)마다 한 번 번역해 아래 표에 둔다(lib/translate.js).
-- 설계: process-gpt/openspec/changes/pgpt-pro-meeting-interpretation/design.md
-- Idempotent: safe to run again.

-- 주 언어: null = 화면 언어를 따름. 두 글자 언어 코드(lib/mainLang.js MAIN_LANGS)
alter table pro_profile add column if not exists main_lang text;
do $$ begin
  alter table pro_profile add constraint pro_profile_main_lang_check check (main_lang is null or main_lang ~ '^[a-z]{2}$');
exception when duplicate_object then null;
end $$;

-- 회의: 이 회의의 통역 스위치(null = 언어가 섞이면 켬), 참여자의 주 언어와 듣기 방식(통역 | 원래 소리)
alter table pro_meetings add column if not exists interp boolean;
alter table pro_meeting_participants add column if not exists lang text;
alter table pro_meeting_participants add column if not exists listen text not null default 'interp';
do $$ begin
  alter table pro_meeting_participants add constraint pro_meeting_participants_listen_check check (listen in ('interp', 'original'));
exception when duplicate_object then null;
end $$;
-- 자막 한 줄: 말한 언어와 다른 언어로의 번역 {"en": "...", "ja": "..."}
alter table pro_meeting_segments add column if not exists lang text;
alter table pro_meeting_segments add column if not exists tr jsonb;

-- 번역 캐시: (테넌트, 원문 해시, 대상 언어)마다 한 번. 서버만 읽고 쓴다(브라우저 키로는 못 읽음).
create table if not exists pro_translations (
  tenant_id text not null,
  hash text not null,                  -- sha256(종류 + 정리한 원문)
  lang text not null,                  -- 대상 언어
  src_lang text,                       -- 원문 언어(모델이 알아본 것)
  text text not null,                  -- 번역문 (원문과 같은 언어였으면 원문 그대로, same=true)
  same boolean not null default false,
  model text,
  ms integer,
  created_at timestamptz not null default now(),
  primary key (tenant_id, hash, lang)
);
alter table pro_translations enable row level security;
revoke all on pro_translations from anon, authenticated;
