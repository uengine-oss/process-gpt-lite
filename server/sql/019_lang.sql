-- 언어(영어 모드): 사람마다 고른 화면·에이전트 언어. 요청에는 X-PGL-Lang 헤더가 먼저이고, 헤더가 없거나
-- 배경 작업(메일 폴러·미션·마이닝·회의·프로세스 단계·알림)은 그 일의 주인·받는 사람의 이 값을 쓴다(lib/lang.js). 비어 있으면 ko.
-- Idempotent: safe to run again.

alter table pro_profile add column if not exists lang text;
do $$ begin
  alter table pro_profile add constraint pro_profile_lang_check check (lang is null or lang in ('ko', 'en'));
exception when duplicate_object then null;
end $$;
