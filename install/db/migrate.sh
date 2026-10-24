#!/bin/bash
# Process GPT Lite database migrations (runs in the one-shot `migrate` service).
#   1. process-gpt's schema: docker-infra/volumes/db/init.sql + migration.sql, once. Upstream
#      init.sql alone does not build a fresh database (it references columns only migration.sql
#      adds), so: init (tolerant) -> migration (tolerant) -> init again; both are written to be
#      re-runnable. The core tables are checked afterwards.
#   2. pgpt-pro server/sql/NNN_*.sql, in order, each once (public.lite_migrations)
#   3. seed.sql: buckets, PostgREST schemas, the tenant and its MCP servers (idempotent)
set -euo pipefail
PSQL=(psql -v ON_ERROR_STOP=1 -X -q)

echo "[migrate] waiting for storage schema"
for i in $(seq 1 120); do
  if "${PSQL[@]}" -tAc "select to_regclass('storage.buckets') is not null" 2>/dev/null | grep -q t; then break; fi
  sleep 2
done
"${PSQL[@]}" -tAc "select to_regclass('storage.buckets') is not null" | grep -q t || { echo "[migrate] storage schema never appeared"; exit 1; }
"${PSQL[@]}" -c "create table if not exists public.lite_migrations (name text primary key, applied_at timestamptz default now())"

if [ "$("${PSQL[@]}" -tAc "select 1 from public.lite_migrations where name='process-gpt/schema'")" != "1" ]; then
  echo "[migrate] process-gpt schema (init.sql, migration.sql)"
  P=/lite/process-gpt-db
  run_tolerant() { (psql -X -q -f "$1" 2>&1 || true) | grep -c 'ERROR' || true; }
  e1=$(run_tolerant $P/init.sql); e2=$(run_tolerant $P/migration.sql)
  for c in /lite/db/compat/*.sql; do psql -X -q -v ON_ERROR_STOP=1 -f "$c" >/dev/null; done
  # second pass: whatever failed for a missing column now applies; "already exists" is expected
  e3=$( (psql -X -q -f $P/init.sql 2>&1 | grep 'ERROR' | grep -v 'already exists' || true) | sort -u | tee /dev/stderr | wc -l | tr -d ' ')
  [ -f $P/migration-cliagents.sql ] && psql -X -q -f $P/migration-cliagents.sql >/dev/null 2>&1 || true
  echo "[migrate] first pass errors: init=$e1 migration=$e2; unresolved after second pass: $e3"
  for t in tenants users todolist chats proc_def bpm_proc_inst notifications; do
    "${PSQL[@]}" -tAc "select to_regclass('public.$t') is not null" | grep -q t || { echo "[migrate] table public.$t is missing"; exit 1; }
  done
  "${PSQL[@]}" -c "insert into public.lite_migrations(name) values ('process-gpt/schema')"
fi

# compatibility shims for objects newer process-gpt services expect (idempotent, every run)
for c in /lite/db/compat/*.sql; do psql -X -q -v ON_ERROR_STOP=1 -f "$c" >/dev/null; done

for f in $(ls /lite/pgpt-sql/[0-9]*.sql | sort); do
  n=$(basename "$f")
  if [ "$("${PSQL[@]}" -tAc "select 1 from public.lite_migrations where name='$n'")" = "1" ]; then continue; fi
  echo "[migrate] apply $n"
  "${PSQL[@]}" -1 -f "$f"
  "${PSQL[@]}" -c "insert into public.lite_migrations(name) values ('$n')"
done

echo "[migrate] seed (tenant=${LITE_TENANT})"
"${PSQL[@]}" -v tenant="${LITE_TENANT}" -f /lite/db/seed.sql
"${PSQL[@]}" -c "notify pgrst, 'reload schema'"
echo "[migrate] done"
