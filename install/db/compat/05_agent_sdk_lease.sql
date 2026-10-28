-- 작업 점유 시한(lease): deepagents 가 쓰는 process-gpt-agent-sdk 0.11.0 은 fetch_pending_task 를
-- p_lease_seconds·p_max_claims 까지 6개 인자로 부르고, 수행 중에는 renew_task_lease, 끝나면
-- release_task_lease 를 부른다. process-gpt init.sql 에는 4-인자 fetch_pending_task 만 있어서
-- full 프로필(DEEPAGENTS_PROCESS_POLLING=true)의 폴링이 "Could not find the function" 으로 실패하고,
-- 프로세스의 에이전트 단계가 집히지 않는다.
-- 출처: uengine-oss/process-gpt-agent-sdk processgpt_agent_sdk/function.sql (85a3760) 의 lease 부분.
-- 새 두 인자는 기본값이 있어 4-인자 호출도 그대로 동작한다. init.sql 이 4-인자판을 다시 만들어도
-- compat 은 매 실행 스키마 뒤에 적용되므로 6-인자판 하나로 정리된다.

DROP FUNCTION IF EXISTS public.fetch_pending_task(text, text, integer, text);
DROP FUNCTION IF EXISTS public.fetch_pending_task(text, text, integer, text, integer);
DROP FUNCTION IF EXISTS public.fetch_pending_task(text, text, integer, text, integer, integer);

CREATE OR REPLACE FUNCTION public.fetch_pending_task(
  p_agent_orch     text,
  p_consumer       text,
  p_limit          integer,
  p_env            text,
  p_lease_seconds  integer DEFAULT NULL,
  p_max_claims     integer DEFAULT 3
)
RETURNS SETOF todolist
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  v_max_claims integer := GREATEST(coalesce(p_max_claims, 3), 1);
BEGIN
  -- 상한에 닿은 만료 점유는 FAILED 로 끝낸다(같은 지점에서 죽는 작업의 무한 재집행 방지)
  UPDATE todolist AS t
     SET draft_status = 'FAILED',
         lease_until  = NULL
   WHERE t.status = 'IN_PROGRESS'
     AND t.draft_status = 'STARTED'
     AND t.lease_until IS NOT NULL
     AND t.lease_until < now()
     AND coalesce(t.claim_count, 0) >= v_max_claims
     AND (p_agent_orch IS NULL OR p_agent_orch = '' OR t.agent_orch::text = p_agent_orch);

  RETURN QUERY
    WITH cte AS (
      SELECT t.id
      FROM todolist AS t
      WHERE t.status = 'IN_PROGRESS'
        AND (p_agent_orch IS NULL OR p_agent_orch = '' OR t.agent_orch::text = p_agent_orch)
        AND (
          (t.agent_mode IN ('DRAFT','COMPLETE') AND t.draft IS NULL AND t.draft_status IS NULL)
          OR t.draft_status = 'FB_REQUESTED'
          -- 점유가 만료된 작업(집은 워커가 더 이상 연장하지 못함)
          OR (
            t.draft_status = 'STARTED'
            AND t.lease_until IS NOT NULL
            AND t.lease_until < now()
            AND coalesce(t.claim_count, 0) < v_max_claims
          )
        )
      ORDER BY t.start_date
      LIMIT p_limit
      FOR UPDATE SKIP LOCKED
    ),
    upd AS (
      UPDATE todolist AS t
         SET draft_status = 'STARTED',
             consumer     = p_consumer,
             lease_until  = CASE
                              WHEN p_lease_seconds IS NULL OR p_lease_seconds <= 0 THEN NULL
                              ELSE now() + make_interval(secs => p_lease_seconds)
                            END,
             claim_count  = CASE
                              WHEN t.draft_status = 'STARTED' THEN coalesce(t.claim_count, 0) + 1
                              ELSE 1
                            END
        FROM cte
       WHERE t.id = cte.id
       RETURNING t.*
    )
    SELECT * FROM upd;
END;
$$;

GRANT EXECUTE ON FUNCTION public.fetch_pending_task(text, text, integer, text, integer, integer) TO anon;

CREATE OR REPLACE FUNCTION public.renew_task_lease(
  p_todo_id       uuid,
  p_consumer      text,
  p_lease_seconds integer
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  v_status   text;
  v_consumer text;
  v_until    timestamptz;
BEGIN
  IF p_todo_id IS NULL OR coalesce(p_consumer, '') = '' OR coalesce(p_lease_seconds, 0) <= 0 THEN
    RETURN jsonb_build_object('renewed', false, 'reason', 'bad_request');
  END IF;

  SELECT t.draft_status::text, t.consumer
    INTO v_status, v_consumer
    FROM todolist AS t
   WHERE t.id = p_todo_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('renewed', false, 'reason', 'missing');
  END IF;
  IF v_status IS DISTINCT FROM 'STARTED' THEN
    RETURN jsonb_build_object('renewed', false, 'reason', 'not_started', 'draft_status', v_status);
  END IF;
  IF v_consumer IS DISTINCT FROM p_consumer THEN
    RETURN jsonb_build_object('renewed', false, 'reason', 'not_owner', 'consumer', v_consumer);
  END IF;

  UPDATE todolist
     SET lease_until = now() + make_interval(secs => p_lease_seconds)
   WHERE id = p_todo_id
   RETURNING lease_until INTO v_until;

  RETURN jsonb_build_object('renewed', true, 'reason', 'ok', 'lease_until', v_until);
END;
$$;

GRANT EXECUTE ON FUNCTION public.renew_task_lease(uuid, text, integer) TO anon;

CREATE OR REPLACE FUNCTION public.release_task_lease(
  p_todo_id  uuid,
  p_consumer text
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  v_rows integer;
BEGIN
  IF p_todo_id IS NULL OR coalesce(p_consumer, '') = '' THEN
    RETURN false;
  END IF;
  UPDATE todolist AS t
     SET lease_until = NULL
   WHERE t.id = p_todo_id
     AND t.consumer = p_consumer;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END;
$$;

GRANT EXECUTE ON FUNCTION public.release_task_lease(uuid, text) TO anon;

-- 회수 후보(만료된 점유)를 찾는 조건 그대로의 인덱스
CREATE INDEX IF NOT EXISTS idx_todolist_lease_reclaim
ON todolist (status, draft_status, lease_until);
