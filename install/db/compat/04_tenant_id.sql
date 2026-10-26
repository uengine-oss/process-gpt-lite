-- public.tenant_id(): process-gpt migration.sql 의 정의(현재 요청에 JWT 가 없으면 NULL)로 되돌린다.
-- migrate.sh 는 init.sql → migration.sql → init.sql 순서로 스키마를 만드는데, 마지막 init.sql 이 예전 정의
-- (current_setting('request.jwt.claims') — missing_ok 없음)로 덮어써서, PostgREST 밖의 연결(pgpt-pro 서버)에서
-- tenant_id 기본값이 계산될 때 'unrecognized configuration parameter "request.jwt.claims"' 로 실패한다.
-- 예: chats 에 행을 넣으면 process-gpt 트리거(handle_chat_insert)가 tenant_id 없이 notifications 에 넣는다 →
-- 팀 메신저·공유·@멘션이 모두 500. compat 은 매 실행 스키마 뒤에 적용되므로 새 설치와 업그레이드 모두 고친다.
create or replace function public.tenant_id()
returns text
language sql stable
as $$
    select
        nullif(
            ((current_setting('request.jwt.claims', true)::jsonb ->>  'app_metadata')::jsonb ->> 'tenant_id'),
            ''
        )::text
$$;
