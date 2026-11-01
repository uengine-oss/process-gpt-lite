-- 메일로 온 인증 코드: 브라우저 작업이 일회용 코드를 기다리는 동안, 그 사람의 연결된 메일함에서 그 사이트가 보낸 코드를
-- 찾아 바로 넣을지(lib/mailCode.js). 기본은 켬 — 메일함을 연결한 사람에게만 해당하고, 설정 › 보안에서 끈다.
-- Idempotent: safe to run again.

alter table pro_profile add column if not exists mail_codes boolean not null default true;
