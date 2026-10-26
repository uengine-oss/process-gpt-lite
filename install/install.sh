#!/usr/bin/env bash
# Process GPT Lite installer (Docker Compose, single machine: macOS / Linux / Windows WSL2)
#
#   ./install.sh                  install or start (idempotent: keeps .env, data and secrets)
#   ./install.sh --profile full   lite + process engine (completion/polling) + mcp-hub
#   ./install.sh --with-mining    also process-miner (repeated work → process recommendations)
#   ./install.sh --upgrade        update sources (git), rebuild/pull images, migrate, restart
#   ./install.sh --uninstall      stop and remove containers (data kept)
#   ./install.sh --uninstall --purge   also delete volumes, data folder and built images
#
# Non-interactive: LLM_API_KEY=... LLM_BASE_URL=... LLM_MODEL=... ADMIN_EMAIL=... ./install.sh --yes
# Secrets are written only to .env (mode 0600) and never printed.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

ACTION=install PROFILE="" YES=0 PURGE=0 NO_GIT=0 MINING="" FRESH=0
while [ $# -gt 0 ]; do
  case "$1" in
    --upgrade) ACTION=upgrade ;;
    --uninstall) ACTION=uninstall ;;
    --purge) PURGE=1 ;;
    --profile) PROFILE="$2"; shift ;;
    --profile=*) PROFILE="${1#*=}" ;;
    --port) PORT_ARG="$2"; shift ;;
    --with-mining) MINING=1 ;;
    --without-mining) MINING=0 ;;
    -y|--yes) YES=1 ;;
    --no-git) NO_GIT=1 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "알 수 없는 옵션: $1" >&2; exit 2 ;;
  esac
  shift
done

say()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[주의]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[오류]\033[0m %s\n' "$*" >&2; exit 1; }
T0=$(date +%s)

# ── prerequisites ────────────────────────────────────────────
command -v docker >/dev/null || die "Docker가 없습니다. https://docs.docker.com/get-docker/ 에서 설치하세요."
docker compose version >/dev/null 2>&1 || die "Docker Compose v2(docker compose)가 필요합니다."
docker info >/dev/null 2>&1 || die "Docker 데몬에 연결할 수 없습니다. Docker Desktop/엔진을 켜세요."
command -v openssl >/dev/null || die "openssl이 필요합니다."
command -v curl >/dev/null || die "curl이 필요합니다."

ENVF="$HERE/.env"
getenv() { [ -f "$ENVF" ] && grep -E "^$1=" "$ENVF" | tail -1 | cut -d= -f2- || true; }
setenv() { # setenv KEY VALUE  (value never echoed)
  local k="$1" v="$2" tmp
  tmp="$(mktemp "$HERE/.env.XXXXXX")"
  if grep -qE "^$k=" "$ENVF"; then
    awk -v k="$k" -v v="$v" 'BEGIN{FS=OFS="="} $1==k{print k "=" v; next} {print}' "$ENVF" > "$tmp"
  else
    cat "$ENVF" > "$tmp"; printf '%s=%s\n' "$k" "$v" >> "$tmp"
  fi
  chmod 600 "$tmp"; mv "$tmp" "$ENVF"
}
compose() {
  local extra=()
  [ "$(getenv LITE_MINING)" = 1 ] && extra=(--profile mining)
  docker compose --env-file "$ENVF" --profile "$(getenv LITE_PROFILE)" ${extra[@]+"${extra[@]}"} "$@"
}

# ── uninstall ────────────────────────────────────────────────
if [ "$ACTION" = uninstall ]; then
  [ -f "$ENVF" ] || die ".env가 없습니다(설치된 적이 없음)."
  say "컨테이너를 내립니다"
  if [ "$PURGE" = 1 ]; then
    docker compose --env-file "$ENVF" --profile lite --profile full --profile mining down -v --rmi local --remove-orphans
  else
    docker compose --env-file "$ENVF" --profile lite --profile full --profile mining down --remove-orphans
  fi
  docker rm -f "deepagent-sandbox-$(getenv LITE_TENANT)" >/dev/null 2>&1 || true
  docker network rm "$(getenv COMPOSE_PROJECT_NAME)-sandbox" >/dev/null 2>&1 || true
  if [ "$PURGE" = 1 ]; then
    d="$(getenv LITE_DATA_DIR)"
    # the sandbox writes as root: remove through a container
    if [ -n "$d" ] && [ -d "$d/deepagents" ]; then
      docker run --rm -v "$d:/d" alpine:3.20 rm -rf /d/deepagents >/dev/null 2>&1 || true
      rmdir "$d" 2>/dev/null || true
    fi
    rm -f "$ENVF"
    say "데이터·볼륨·이미지·.env를 모두 지웠습니다."
  else
    say "멈췄습니다. 데이터는 남아 있습니다(다시 시작: ./install.sh, 완전 삭제: --uninstall --purge)."
  fi
  exit 0
fi

# ── sources (process-gpt-lite repository: install/ next to backends/) ──
src_of() { local v; v="$(getenv "$1")"; [ -n "$v" ] && echo "$v" || echo "$2"; }
abspath() { (cd "$HERE" && cd "$1" 2>/dev/null && pwd) || true; }
ensure_sources() {
  local root; root="$(abspath ..)"
  if [ "$NO_GIT" = 0 ] && command -v git >/dev/null && git -C "$root" rev-parse --git-dir >/dev/null 2>&1; then
    if [ -f "$root/.gitmodules" ]; then
      say "백엔드 서브모듈을 받습니다(필요한 것만)"
      git -C "$root" submodule update --init backends/process-gpt backends/office-host 2>/dev/null || true
      local pg="$root/backends/process-gpt"
      if [ -d "$pg" ]; then
        local subs=(services/deepagents services/office-mcp skills/bpmn-process-generation-skill)
        [ "$(getenv LITE_PROFILE)" = full ] && subs+=(services/completion)
        git -C "$pg" submodule update --init "${subs[@]}" 2>/dev/null || true
      fi
      [ -d "$root/backends/office-host" ] && git -C "$root/backends/office-host" submodule update --init ieumoffice 2>/dev/null || true
    fi
  fi
  # process-miner (mining profile): process-gpt's feat/pgpt-lite-mining, only services/process-miner
  if [ "$(getenv LITE_MINING)" = 1 ] && [ -z "$(getenv PROCESS_MINER_SRC)" ]; then
    local mr="$HERE/.src/process-gpt-mining"
    if [ ! -d "$mr/.git" ]; then
      say "process-miner 소스를 받습니다(process-gpt feat/pgpt-lite-mining, services/process-miner 만)"
      mkdir -p "$HERE/.src"
      git clone -q --depth 1 --branch "${MINER_BRANCH:-feat/pgpt-lite-mining}" --filter=blob:none --sparse \
        https://github.com/uengine-oss/process-gpt.git "$mr" || die "process-miner 소스를 받지 못했습니다."
      git -C "$mr" sparse-checkout set services/process-miner
    elif [ "$ACTION" = upgrade ] && [ "$NO_GIT" = 0 ]; then
      git -C "$mr" pull -q --ff-only || warn "process-miner 소스 git pull 실패 — 지금 소스로 계속합니다."
    fi
    [ -f "$mr/services/process-miner/Dockerfile" ] || die "process-miner 소스가 없습니다($mr)."
  fi
  local pg oh pp
  pp="$(abspath "$(src_of PGPT_SRC ..)")"
  pg="$(abspath "$(src_of PROCESS_GPT_SRC ../backends/process-gpt)")"
  oh="$(abspath "$(src_of OFFICE_HOST_SRC ../backends/office-host)")"
  [ -f "$pp/server/index.js" ] || die "pgpt-pro 소스를 찾을 수 없습니다(PGPT_SRC)."
  [ -f "$pg/docker-infra/volumes/db/init.sql" ] || die "process-gpt 소스를 찾을 수 없습니다(PROCESS_GPT_SRC). git clone --recurse-submodules 로 받았는지 확인하세요."
  [ -f "$pg/services/deepagents/server.py" ] || die "deepagents 소스가 없습니다($pg/services/deepagents)."
  [ -f "$pg/services/office-mcp/main.py" ] || die "office-mcp 소스가 없습니다($pg/services/office-mcp)."
  [ -d "$oh/ieumoffice/apps" ] || die "이음오피스 소스가 없습니다($oh/ieumoffice). office-host 저장소의 서브모듈을 받으세요."
}

# ── .env: create once, fill what is missing (idempotent) ─────
b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
jwt() { # jwt ROLE SECRET
  local now exp h p s
  now=$(date +%s); exp=$((now + 10 * 365 * 24 * 3600))
  h=$(printf '{"alg":"HS256","typ":"JWT"}' | b64url)
  p=$(printf '{"role":"%s","iss":"supabase","iat":%d,"exp":%d}' "$1" "$now" "$exp" | b64url)
  s=$(printf '%s.%s' "$h" "$p" | openssl dgst -sha256 -hmac "$2" -binary | b64url)
  printf '%s.%s.%s' "$h" "$p" "$s"
}
ask() { # ask KEY PROMPT DEFAULT [secret]
  local cur; cur="$(getenv "$1")"
  local fromenv="${!1:-}"
  if [ -n "$fromenv" ]; then setenv "$1" "$fromenv"; return; fi
  # a new .env carries .env.example's values: offer them as defaults on the first install only
  if [ -n "$cur" ] && [ "$FRESH" = 0 ]; then return; fi
  local def="${cur:-$3}"
  if [ "$YES" = 1 ] || [ ! -t 0 ]; then [ -z "$def" ] || setenv "$1" "$def"; return 0; fi
  local v
  if [ "${4:-}" = secret ]; then read -r -s -p "$2: " v; echo; else read -r -p "$2 [${def}]: " v; fi
  setenv "$1" "${v:-$def}"
}
prepare_env() {
  if [ ! -f "$ENVF" ]; then
    say ".env를 만듭니다"
    (umask 077; cp "$HERE/.env.example" "$ENVF")
    FRESH=1
  fi
  chmod 600 "$ENVF"
  [ -n "$PROFILE" ] && setenv LITE_PROFILE "$PROFILE"
  [ -n "${PORT_ARG:-}" ] && { setenv LITE_HTTP_PORT "$PORT_ARG"; setenv PUBLIC_URL "http://localhost:$PORT_ARG"; }
  case "$(getenv LITE_PROFILE)" in lite|full) ;; *) die "--profile 은 lite 또는 full 입니다." ;; esac
  [ "$(getenv LITE_PROFILE)" = full ] && setenv DEEPAGENTS_PROCESS_POLLING true
  if [ "$MINING" = 1 ]; then setenv LITE_MINING 1; setenv MINER_URL http://process-miner:8014
  elif [ "$MINING" = 0 ]; then setenv LITE_MINING 0; setenv MINER_URL ""; fi

  ask LLM_BASE_URL "LLM 주소(OpenAI 호환)" "https://api.openai.com/v1"
  ask LLM_API_KEY "LLM API 키(입력은 화면에 보이지 않습니다)" "" secret
  ask LLM_MODEL "기본 모델" "gpt-4.1"
  ask LLM_FAST_MODEL "빠른 모델(라우팅·분류)" "$(getenv LLM_MODEL)"
  ask ADMIN_EMAIL "첫 관리자 이메일" "admin@pgpt-lite.local"
  [ -n "$(getenv LLM_API_KEY)" ] || warn "LLM_API_KEY가 비어 있습니다. 채팅이 응답하지 않습니다(.env에 넣고 ./install.sh 다시 실행)."

  # secrets: generated once, kept across upgrades
  [ -n "$(getenv POSTGRES_PASSWORD)" ] || setenv POSTGRES_PASSWORD "$(openssl rand -hex 24)"
  if [ -z "$(getenv JWT_SECRET)" ] || [ -z "$(getenv ANON_KEY)" ] || [ -z "$(getenv SERVICE_ROLE_KEY)" ]; then
    local js; js="$(openssl rand -hex 32)"
    setenv JWT_SECRET "$js"
    setenv ANON_KEY "$(jwt anon "$js")"
    setenv SERVICE_ROLE_KEY "$(jwt service_role "$js")"
  fi
  [ -n "$(getenv VAULT_KEK)" ] || setenv VAULT_KEK "$(openssl rand -base64 32)"
  [ -n "$(getenv CRON_SECRET)" ] || setenv CRON_SECRET "$(openssl rand -hex 16)"

  # absolute paths and the loopback forward for a localhost public URL
  setenv LITE_INSTALL_DIR "$HERE"
  [ -n "$(getenv LITE_DATA_DIR)" ] || setenv LITE_DATA_DIR "$HERE/data"
  local url host port
  url="$(getenv PUBLIC_URL)"; host="$(echo "$url" | sed -E 's#^[a-z]+://([^/:]+).*#\1#')"
  port="$(echo "$url" | sed -nE 's#^[a-z]+://[^/:]+:([0-9]+).*#\1#p')"; port="${port:-80}"
  case "$host" in localhost|127.0.0.1) setenv LOOPBACK_FORWARD "$port=web:80" ;; *) setenv LOOPBACK_FORWARD "" ;; esac
  for k in PGPT_SRC PROCESS_GPT_SRC OFFICE_HOST_SRC; do [ -n "$(getenv $k)" ] || setenv "$k" "$(grep -E "^$k=" "$HERE/.env.example" | cut -d= -f2-)"; done
  mkdir -p "$(getenv LITE_DATA_DIR)/deepagents/workspace" "$(getenv LITE_DATA_DIR)/deepagents/skills"
}

# WSL mirrored networking drops SYNs to closed ports instead of refusing them: bound the probe
port_open() {
  if command -v timeout >/dev/null; then timeout 3 bash -c "exec 3<>/dev/tcp/127.0.0.1/$1" 2>/dev/null
  else (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; fi
}

preflight() {
  local mem cpus port mport
  mem=$(docker info --format '{{.MemTotal}}' 2>/dev/null || echo 0)
  cpus=$(docker info --format '{{.NCPU}}' 2>/dev/null || echo 0)
  [ "$mem" -ge $((7 * 1024 * 1024 * 1024)) ] || warn "Docker에 할당된 메모리가 8GB 미만입니다($((mem / 1024 / 1024))MB). 이음오피스 빌드·실행이 느리거나 실패할 수 있습니다."
  [ "$cpus" -ge 4 ] || warn "Docker CPU가 4개 미만입니다."
  port="$(getenv LITE_HTTP_PORT)"; mport="$(getenv LITE_MAIL_PORT)"
  for p in "$port" "$mport"; do
    if port_open "$p"; then
      if ! docker ps --filter "label=com.docker.compose.project=$(getenv COMPOSE_PROJECT_NAME)" --format '{{.Ports}}' | grep -q ":$p->"; then
        die "포트 $p 를 다른 프로그램이 쓰고 있습니다. ./install.sh --port <다른 포트> 로 바꾸세요."
      fi
    fi
  done
}

build_or_pull() {
  if [ "$(getenv LITE_IMAGE_PREFIX)" != pgpt-lite ]; then
    say "이미지를 받습니다($(getenv LITE_IMAGE_PREFIX):$(getenv LITE_TAG))"
    compose pull
  else
    say "이미지를 빌드합니다(처음에는 20~40분, 이음오피스가 가장 오래 걸립니다)"
    compose build ${1:-}
  fi
}

wait_ready() {
  local url="http://127.0.0.1:$(getenv LITE_HTTP_PORT)" i
  say "서비스가 준비되기를 기다립니다"
  for i in $(seq 1 180); do
    if curl -fsS "$url/api/config" >/dev/null 2>&1 \
       && [ "$(docker inspect -f '{{.State.Health.Status}}' "$(compose ps -q deepagents)" 2>/dev/null)" = healthy ]; then
      return 0
    fi
    if [ -n "$(compose ps -a --format '{{.Service}} {{.State}} {{.ExitCode}}' migrate 2>/dev/null | awk '$2=="exited" && $3!="0"')" ]; then
      compose logs --no-color --tail 40 migrate >&2; die "DB 마이그레이션이 실패했습니다."
    fi
    sleep 5
  done
  compose ps >&2
  die "15분 안에 준비되지 않았습니다. 'docker compose logs <서비스>' 로 원인을 확인하세요."
}

create_admin() {
  local email url anon svc uid
  email="$(getenv ADMIN_EMAIL)"; url="http://127.0.0.1:$(getenv LITE_HTTP_PORT)"
  anon="$(getenv ANON_KEY)"; svc="$(getenv SERVICE_ROLE_KEY)"
  # GoTrue admin API (service key from .env, sent in headers only). 422 = already exists.
  local code i
  for i in $(seq 1 12); do
    code="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$url/auth/v1/admin/users" \
      -H "apikey: $svc" -H "Authorization: Bearer $svc" -H 'Content-Type: application/json' \
      -d "{\"email\":\"$email\",\"email_confirm\":true,\"user_metadata\":{\"name\":\"관리자\",\"tenant_id\":\"$(getenv LITE_TENANT)\"}}" || true)"
    case "$code" in 200|201|422) break ;; esac
    sleep 5
  done
  uid="$(compose exec -T db psql -U postgres -d postgres -tAc "select id from auth.users where email='$email'" | tr -d '[:space:]')"
  [ -n "$uid" ] || die "관리자 계정을 만들지 못했습니다(auth 로그 확인: docker compose logs auth)."
  compose exec -T db psql -U postgres -d postgres -q -v ON_ERROR_STOP=1 \
    -v uid="$uid" -v email="$email" -v tenant="$(getenv LITE_TENANT)" >/dev/null <<'SQL'
insert into public.users (id, username, email, tenant_id, role, is_admin, is_agent, is_draft, permission_ids)
values (:'uid', '관리자', :'email', :'tenant', 'admin', true, false, false, '{}')
on conflict (id, tenant_id) do update set is_admin = true, role = 'admin';
update public.tenants set owner = :'uid' where id = :'tenant' and owner is null;
SQL
  : "$anon"
}

up() {
  say "시작합니다(프로필: $(getenv LITE_PROFILE))"
  compose up -d --remove-orphans
  wait_ready
  create_admin
}

summary() {
  local url mail
  url="$(getenv PUBLIC_URL)"; mail="http://localhost:$(getenv LITE_MAIL_PORT)"
  cat <<EOF

  Process GPT Lite 가 준비됐습니다  ($(( $(date +%s) - T0 ))초)

    주소        $url
    관리자      $(getenv ADMIN_EMAIL)
    로그인 코드  이메일을 입력하면 코드가 메일함으로 갑니다 → $mail
                (SMTP를 .env에 설정하면 실제 메일로 갑니다)

    상태        docker compose ps
    로그        docker compose logs -f server deepagents
    업그레이드  ./install.sh --upgrade
    멈추기      ./install.sh --uninstall   (데이터 유지, --purge 는 모두 삭제)

EOF
}

case "$ACTION" in
  install)
    prepare_env; ensure_sources; preflight
    build_or_pull
    up; summary ;;
  upgrade)
    [ -f "$ENVF" ] || die "먼저 ./install.sh 로 설치하세요."
    prepare_env
    if [ "$NO_GIT" = 0 ] && command -v git >/dev/null && git -C .. rev-parse --git-dir >/dev/null 2>&1; then
      say "소스를 업데이트합니다(git pull)"
      git -C .. pull --ff-only || warn "git pull 실패 — 로컬 변경을 확인하세요. 지금 소스로 계속합니다."
    fi
    ensure_sources; preflight
    build_or_pull --pull
    compose up -d --force-recreate migrate >/dev/null 2>&1 || true
    up; summary ;;
esac
