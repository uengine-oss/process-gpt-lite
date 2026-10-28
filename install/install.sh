#!/usr/bin/env bash
# Process GPT Lite installer (Docker Compose, single machine: macOS / Linux / Windows WSL2)
#
#   ./install.sh                  install or start (idempotent: keeps .env, data and secrets)
#   ./install.sh --profile full   lite + process engine (completion/polling) + mcp-hub
#   ./install.sh --with-mining    also process-miner (repeated work → process recommendations)
#   ./install.sh --with-craft     also the ArtCraft apps (drawings, images, sound, video; first build 30+ min)
#   ./install.sh --upgrade       update sources (git), rebuild/pull images, migrate, restart
#   ./install.sh --uninstall      stop and remove containers (data kept)
#   ./install.sh --uninstall --purge   also delete volumes, data folder and built images
#   ./install.sh --lang en|ko     language of the questions and messages (default: Korean when the
#                                 locale — LC_ALL / LC_MESSAGES / LANG — is Korean, otherwise English)
#
# Non-interactive: LLM_API_KEY=... LLM_BASE_URL=... LLM_MODEL=... ADMIN_EMAIL=... ./install.sh --yes
# Secrets are written only to .env (mode 0600) and never printed.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

ACTION=install PROFILE="" YES=0 PURGE=0 NO_GIT=0 MINING="" CRAFT="" FRESH=0 UI_LANG="${LITE_LANG:-}"
# the language of what this script says: --lang, else LITE_LANG, else the locale (Korean only when it is ko*)
prev=""
for a in "$@"; do
  case "$a" in --lang=*) UI_LANG="${a#*=}" ;; esac
  [ "$prev" = --lang ] && UI_LANG="$a"
  prev="$a"
done
if [ -z "$UI_LANG" ]; then
  case "${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}" in ko*|KO*) UI_LANG=ko ;; *) UI_LANG=en ;; esac
fi
case "$UI_LANG" in ko|en) ;; *) UI_LANG=en ;; esac
t() { if [ "$UI_LANG" = ko ]; then printf '%s' "$1"; else printf '%s' "$2"; fi; } # t KOREAN ENGLISH

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
    --with-craft) CRAFT=1 ;;
    --without-craft) CRAFT=0 ;;
    -y|--yes) YES=1 ;;
    --no-git) NO_GIT=1 ;;
    --lang) shift ;;
    --lang=*) ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "$(t '알 수 없는 옵션' 'Unknown option'): $1" >&2; exit 2 ;;
  esac
  shift
done

say()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[%s]\033[0m %s\n' "$(t 주의 warning)" "$*" >&2; }
die()  { printf '\033[1;31m[%s]\033[0m %s\n' "$(t 오류 error)" "$*" >&2; exit 1; }
T0=$(date +%s)

# ── prerequisites ────────────────────────────────────────────
command -v docker >/dev/null || die "$(t 'Docker가 없습니다. https://docs.docker.com/get-docker/ 에서 설치하세요.' 'Docker is not installed. Install it from https://docs.docker.com/get-docker/.')"
docker compose version >/dev/null 2>&1 || die "$(t 'Docker Compose v2(docker compose)가 필요합니다.' 'Docker Compose v2 (docker compose) is required.')"
docker info >/dev/null 2>&1 || die "$(t 'Docker 데몬에 연결할 수 없습니다. Docker Desktop/엔진을 켜세요.' 'Cannot reach the Docker daemon. Start Docker Desktop or the Docker engine.')"
command -v openssl >/dev/null || die "$(t 'openssl이 필요합니다.' 'openssl is required.')"
command -v curl >/dev/null || die "$(t 'curl이 필요합니다.' 'curl is required.')"

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
  [ "$(getenv LITE_MINING)" = 1 ] && extra+=(--profile mining)
  [ "$(getenv LITE_CRAFT)" = 1 ] && extra+=(--profile craft)
  docker compose --env-file "$ENVF" --profile "$(getenv LITE_PROFILE)" ${extra[@]+"${extra[@]}"} "$@"
}

# ── uninstall ────────────────────────────────────────────────
if [ "$ACTION" = uninstall ]; then
  [ -f "$ENVF" ] || die "$(t '.env가 없습니다(설치된 적이 없음).' 'There is no .env (it was never installed).')"
  say "$(t '컨테이너를 내립니다' 'Stopping the containers')"
  if [ "$PURGE" = 1 ]; then
    docker compose --env-file "$ENVF" --profile lite --profile full --profile mining --profile craft down -v --rmi local --remove-orphans
  else
    docker compose --env-file "$ENVF" --profile lite --profile full --profile mining --profile craft down --remove-orphans
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
    say "$(t '데이터·볼륨·이미지·.env를 모두 지웠습니다.' 'Deleted the data, volumes, images and .env.')"
  else
    say "$(t '멈췄습니다. 데이터는 남아 있습니다(다시 시작: ./install.sh, 완전 삭제: --uninstall --purge).' 'Stopped. Your data is kept (start again: ./install.sh, delete everything: --uninstall --purge).')"
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
      say "$(t '백엔드 서브모듈을 받습니다(필요한 것만)' 'Fetching the backend submodules (only what is needed)')"
      git -C "$root" submodule update --init backends/process-gpt backends/office-host 2>/dev/null || true
      local pg="$root/backends/process-gpt"
      if [ -d "$pg" ]; then
        # bpmn-extractor: its BPMN XML generator is what the bridge saves generated processes with
        local subs=(services/deepagents services/office-mcp services/bpmn-extractor skills/bpmn-process-generation-skill)
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
      say "$(t 'process-miner 소스를 받습니다(process-gpt feat/pgpt-lite-mining, services/process-miner 만)' 'Fetching the process-miner source (process-gpt feat/pgpt-lite-mining, services/process-miner only)')"
      mkdir -p "$HERE/.src"
      git clone -q --depth 1 --branch "${MINER_BRANCH:-feat/pgpt-lite-mining}" --filter=blob:none --sparse \
        https://github.com/uengine-oss/process-gpt.git "$mr" || die "$(t 'process-miner 소스를 받지 못했습니다.' 'Could not fetch the process-miner source.')"
      git -C "$mr" sparse-checkout set services/process-miner
    elif [ "$ACTION" = upgrade ] && [ "$NO_GIT" = 0 ]; then
      git -C "$mr" pull -q --ff-only || warn "$(t 'process-miner 소스 git pull 실패 — 지금 소스로 계속합니다.' 'git pull of the process-miner source failed — continuing with the current source.')"
    fi
    [ -f "$mr/services/process-miner/Dockerfile" ] || die "$(t 'process-miner 소스가 없습니다' 'The process-miner source is missing') ($mr)."
  fi
  local pg oh pp
  pp="$(abspath "$(src_of PGPT_SRC ..)")"
  pg="$(abspath "$(src_of PROCESS_GPT_SRC ../backends/process-gpt)")"
  oh="$(abspath "$(src_of OFFICE_HOST_SRC ../backends/office-host)")"
  [ -f "$pp/server/index.js" ] || die "$(t 'pgpt-pro 소스를 찾을 수 없습니다(PGPT_SRC).' 'Cannot find the pgpt-pro source (PGPT_SRC).')"
  [ -f "$pg/docker-infra/volumes/db/init.sql" ] || die "$(t 'process-gpt 소스를 찾을 수 없습니다(PROCESS_GPT_SRC). git clone --recurse-submodules 로 받았는지 확인하세요.' 'Cannot find the process-gpt source (PROCESS_GPT_SRC). Check that you cloned with git clone --recurse-submodules.')"
  [ -f "$pg/services/deepagents/server.py" ] || die "$(t 'deepagents 소스가 없습니다' 'The deepagents source is missing') ($pg/services/deepagents)."
  [ -f "$pg/services/office-mcp/main.py" ] || die "$(t 'office-mcp 소스가 없습니다' 'The office-mcp source is missing') ($pg/services/office-mcp)."
  [ -d "$oh/ieumoffice/apps" ] || die "$(t '이음오피스 소스가 없습니다' 'The IeumOffice source is missing') ($oh/ieumoffice). $(t 'office-host 저장소의 서브모듈을 받으세요.' 'Fetch the submodule of the office-host repository.')"
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
    say "$(t '.env를 만듭니다' 'Creating .env')"
    (umask 077; cp "$HERE/.env.example" "$ENVF")
    FRESH=1
  fi
  chmod 600 "$ENVF"
  [ -n "$PROFILE" ] && setenv LITE_PROFILE "$PROFILE"
  [ -n "${PORT_ARG:-}" ] && { setenv LITE_HTTP_PORT "$PORT_ARG"; setenv PUBLIC_URL "http://localhost:$PORT_ARG"; }
  case "$(getenv LITE_PROFILE)" in lite|full) ;; *) die "$(t '--profile 은 lite 또는 full 입니다.' '--profile is lite or full.')" ;; esac
  [ "$(getenv LITE_PROFILE)" = full ] && setenv DEEPAGENTS_PROCESS_POLLING true
  if [ "$MINING" = 1 ]; then setenv LITE_MINING 1; setenv MINER_URL http://process-miner:8014
  elif [ "$MINING" = 0 ]; then setenv LITE_MINING 0; setenv MINER_URL ""; fi
  [ -n "$CRAFT" ] && setenv LITE_CRAFT "$CRAFT"

  ask LLM_BASE_URL "$(t 'LLM 주소(OpenAI 호환)' 'LLM address (OpenAI-compatible)')" "https://api.openai.com/v1"
  ask LLM_API_KEY "$(t 'LLM API 키(입력은 화면에 보이지 않습니다)' 'LLM API key (not shown as you type)')" "" secret
  ask LLM_MODEL "$(t '기본 모델' 'Default model')" "gpt-4.1"
  ask LLM_FAST_MODEL "$(t '빠른 모델(라우팅·분류)' 'Fast model (routing and classification)')" "$(getenv LLM_MODEL)"
  ask ADMIN_EMAIL "$(t '첫 관리자 이메일' 'First admin email')" "admin@pgpt-lite.local"
  [ -n "$(getenv LLM_API_KEY)" ] || warn "$(t 'LLM_API_KEY가 비어 있습니다. 채팅이 응답하지 않습니다(.env에 넣고 ./install.sh 다시 실행).' 'LLM_API_KEY is empty, so chat will not answer (put it in .env and run ./install.sh again).')"

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
  [ "$mem" -ge $((7 * 1024 * 1024 * 1024)) ] || warn "$(t "Docker에 할당된 메모리가 8GB 미만입니다($((mem / 1024 / 1024))MB). 이음오피스 빌드·실행이 느리거나 실패할 수 있습니다." "Docker has less than 8 GB of memory ($((mem / 1024 / 1024)) MB). Building and running IeumOffice may be slow or fail.")"
  [ "$cpus" -ge 4 ] || warn "$(t 'Docker CPU가 4개 미만입니다.' 'Docker has fewer than 4 CPUs.')"
  port="$(getenv LITE_HTTP_PORT)"; mport="$(getenv LITE_MAIL_PORT)"
  for p in "$port" "$mport"; do
    if port_open "$p"; then
      if ! docker ps --filter "label=com.docker.compose.project=$(getenv COMPOSE_PROJECT_NAME)" --format '{{.Ports}}' | grep -q ":$p->"; then
        die "$(t "포트 $p 를 다른 프로그램이 쓰고 있습니다. ./install.sh --port <다른 포트> 로 바꾸세요." "Port $p is used by another program. Choose another one with ./install.sh --port <port>.")"
      fi
    fi
  done
}

build_or_pull() {
  if [ "$(getenv LITE_IMAGE_PREFIX)" != pgpt-lite ]; then
    say "$(t '이미지를 받습니다' 'Pulling the images') ($(getenv LITE_IMAGE_PREFIX):$(getenv LITE_TAG))"
    compose pull
  else
    say "$(t '이미지를 빌드합니다(처음에는 20~40분, 이음오피스가 가장 오래 걸립니다)' 'Building the images (20–40 minutes the first time; IeumOffice takes longest)')"
    [ "$(getenv LITE_CRAFT)" = 1 ] && say "$(t 'ArtCraft 앱 다섯 개도 소스에서 빌드합니다(처음 한 번 30분 이상, 이후 캐시)' 'Also building the five ArtCraft apps from source (30+ minutes once, cached afterwards)')"
    compose build ${1:-}
  fi
}

wait_ready() {
  local url="http://127.0.0.1:$(getenv LITE_HTTP_PORT)" i
  say "$(t '서비스가 준비되기를 기다립니다' 'Waiting for the services to be ready')"
  for i in $(seq 1 180); do
    if curl -fsS "$url/api/config" >/dev/null 2>&1 \
       && [ "$(docker inspect -f '{{.State.Health.Status}}' "$(compose ps -q deepagents)" 2>/dev/null)" = healthy ]; then
      return 0
    fi
    if [ -n "$(compose ps -a --format '{{.Service}} {{.State}} {{.ExitCode}}' migrate 2>/dev/null | awk '$2=="exited" && $3!="0"')" ]; then
      compose logs --no-color --tail 40 migrate >&2; die "$(t 'DB 마이그레이션이 실패했습니다.' 'The database migration failed.')"
    fi
    sleep 5
  done
  compose ps >&2
  die "$(t "15분 안에 준비되지 않았습니다. 'docker compose logs <서비스>' 로 원인을 확인하세요." "Not ready within 15 minutes. Check the cause with 'docker compose logs <service>'.")"
}

create_admin() {
  local email url anon svc uid admin
  email="$(getenv ADMIN_EMAIL)"; url="http://127.0.0.1:$(getenv LITE_HTTP_PORT)"
  admin="$(t 관리자 Admin)"
  anon="$(getenv ANON_KEY)"; svc="$(getenv SERVICE_ROLE_KEY)"
  # GoTrue admin API (service key from .env, sent in headers only). 422 = already exists.
  local code i
  for i in $(seq 1 12); do
    code="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$url/auth/v1/admin/users" \
      -H "apikey: $svc" -H "Authorization: Bearer $svc" -H 'Content-Type: application/json' \
      -d "{\"email\":\"$email\",\"email_confirm\":true,\"user_metadata\":{\"name\":\"$admin\",\"tenant_id\":\"$(getenv LITE_TENANT)\"}}" || true)"
    case "$code" in 200|201|422) break ;; esac
    sleep 5
  done
  uid="$(compose exec -T db psql -U postgres -d postgres -tAc "select id from auth.users where email='$email'" | tr -d '[:space:]')"
  [ -n "$uid" ] || die "$(t '관리자 계정을 만들지 못했습니다(auth 로그 확인: docker compose logs auth).' 'Could not create the admin account (check the auth log: docker compose logs auth).')"
  compose exec -T db psql -U postgres -d postgres -q -v ON_ERROR_STOP=1 \
    -v uid="$uid" -v email="$email" -v tenant="$(getenv LITE_TENANT)" -v admin="$admin" >/dev/null <<'SQL'
insert into public.users (id, username, email, tenant_id, role, is_admin, is_agent, is_draft, permission_ids)
values (:'uid', :'admin', :'email', :'tenant', 'admin', true, false, false, '{}')
on conflict (id, tenant_id) do update set is_admin = true, role = 'admin';
update public.tenants set owner = :'uid' where id = :'tenant' and owner is null;
SQL
  : "$anon"
}

up() {
  say "$(t '시작합니다(프로필' 'Starting (profile'): $(getenv LITE_PROFILE))"
  compose up -d --remove-orphans
  wait_ready
  create_admin
}

summary() {
  local url mail
  url="$(getenv PUBLIC_URL)"; mail="http://localhost:$(getenv LITE_MAIL_PORT)"
  if [ "$UI_LANG" = ko ]; then
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
  else
    cat <<EOF

  Process GPT Lite is ready  ($(( $(date +%s) - T0 )) s)

    Address      $url
    Admin        $(getenv ADMIN_EMAIL)
    Login code   enter your email and the code goes to the mailbox → $mail
                 (set SMTP in .env to send real mail)

    Status       docker compose ps
    Logs         docker compose logs -f server deepagents
    Upgrade      ./install.sh --upgrade
    Stop         ./install.sh --uninstall   (keeps data; --purge deletes everything)

EOF
  fi
}

case "$ACTION" in
  install)
    prepare_env; ensure_sources; preflight
    build_or_pull
    up; summary ;;
  upgrade)
    [ -f "$ENVF" ] || die "$(t '먼저 ./install.sh 로 설치하세요.' 'Install first with ./install.sh.')"
    prepare_env
    if [ "$NO_GIT" = 0 ] && command -v git >/dev/null && git -C .. rev-parse --git-dir >/dev/null 2>&1; then
      say "$(t '소스를 업데이트합니다(git pull)' 'Updating the sources (git pull)')"
      git -C .. pull --ff-only || warn "$(t 'git pull 실패 — 로컬 변경을 확인하세요. 지금 소스로 계속합니다.' 'git pull failed — check your local changes. Continuing with the current sources.')"
    fi
    ensure_sources; preflight
    build_or_pull --pull
    compose up -d --force-recreate migrate >/dev/null 2>&1 || true
    up; summary ;;
esac
