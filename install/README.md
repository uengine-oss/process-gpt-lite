# Process GPT Lite 설치 (Docker Compose)

PC 한 대(macOS · Linux · Windows WSL2)에 Process GPT Lite를 명령 하나로 설치합니다.

```bash
git clone https://github.com/uengine-oss/process-gpt-lite.git
cd process-gpt-lite/install
./install.sh
```

또는 한 줄로(저장소를 `~/process-gpt-lite`에 받고 같은 설치를 실행합니다):

```bash
curl -fsSL https://raw.githubusercontent.com/uengine-oss/process-gpt-lite/main/install/get.sh | bash
```

설치가 끝나면 http://localhost:18080 에 접속해 관리자 이메일을 입력합니다. 로그인 코드는 번들 메일함 http://localhost:18025 로 갑니다(SMTP를 설정하면 실제 메일로 갑니다).

## 준비물

| 항목 | 최소 | 권장 |
|---|---|---|
| Docker | Docker Desktop 4.x 또는 Docker Engine 24+ (Compose v2) | |
| Docker에 할당한 메모리 | 6GB (실행 중 약 1.5GB 사용) | 8GB 이상(첫 빌드) |
| CPU | 4코어 | 8코어 |
| 디스크 | 20GB (이미지 약 11GB + 빌드 캐시) | 30GB |
| LLM | OpenAI 호환 API 주소·키·모델 이름 | |

## 프로필

| 프로필 | 들어 있는 것 | 용도 |
|---|---|---|
| `lite` (기본) | 웹·BFF(pgpt-pro), Supabase 최소 구성(postgres·auth·rest·storage·kong), 메일함(mailpit), deepagents + 샌드박스, office-mcp(문서 생성), 이음오피스 편집기(office-host) | 채팅·에이전트·문서 생성/편집·공유 폴더·패널 앱·보관함·브라우저 에이전트 |
| `full` (실험) | lite + 프로세스 엔진(completion, polling) + mcp-hub | BPM 프로세스 시작·진행, MCP 서버 거버넌스 |
| `mining` (선택, `--with-mining`) | lite/full 에 더해 process-miner | 반복된 메일 업무(초안·팀 공유)의 인계 기록에서 반복 흐름을 찾아 관리자에게 추천(흐름·사례 보기, 보류). **정식 등록은 아직 컨테이너에서 안 됨**: 등록·채팅의 프로세스 초안 저장은 process-gpt 의 Python 저장 코드(save_contract, deepagents venv)를 쓰는데 server 이미지에 없습니다 — 개발 설치(저장소 + backends)에서는 됩니다 |

lite에 넣지 않은 것과 이유:

- context-router + 판단 모델: 판단 모델(Qwen3-4B·bge-m3)이 GPU/큰 메모리를 씁니다. 따로 띄운 뒤 `.env`의 `CONTEXT_ROUTER_URL`, `BROWSER_GATES=on`으로 연결합니다. 채팅의 "@" 팀원 제안은 `JUDGE_URL`(판단 서버 `/judge`)이 있으면 지금 일과 관계된 팀원을 함께 고르고, 비워 두면 자주 주고받은 순서만 씁니다.
- cli-agent(Claude Code·Codex 실행): 사용자 구독 로그인과 호스트 CLI가 필요해 컨테이너 번들에 맞지 않습니다.
- ArtCraft 앱: 웹 빌드는 Rust 빌드가 필요하고 CLI는 운영체제별 바이너리입니다. `server-data` 볼륨의 `/data/craft/<app>/`에 웹 빌드를 넣으면 `/craft/<app>/`으로 열립니다. 없으면 그 형식의 파일(.dxf·.svg·.png·.wav·.mp4)은 편집기 대신 링크로 열리고, 메일 초안은 평면도 없이 제안서·견적서만 만들며, 한글 그림을 포토크래프트로 꺼내는 기능은 꺼집니다(`/api/config` 의 `craft` 가 앱별로 알려 줌).
- memento(문서 검색·RAG): 이미지가 큽니다(2~11GB). 있으면 `MEMENTO_URL`로 연결합니다.

## 명령

| 하고 싶은 것 | 명령 |
|---|---|
| 설치·시작(다시 실행해도 안전) | `./install.sh` |
| 비대화 설치 | `LLM_API_KEY=… LLM_BASE_URL=… LLM_MODEL=… ADMIN_EMAIL=… ./install.sh --yes` |
| 포트 바꾸기 | `./install.sh --port 28080` |
| full 프로필 | `./install.sh --profile full` |
| 프로세스 마이닝 켜기/끄기 | `./install.sh --with-mining` / `./install.sh --without-mining` |
| 업그레이드(git pull → 빌드 → 마이그레이션 → 재시작) | `./install.sh --upgrade` |
| 멈추기(데이터 유지) | `./install.sh --uninstall` |
| 모두 지우기(볼륨·데이터·이미지·.env) | `./install.sh --uninstall --purge` |
| 상태·로그 | `docker compose ps`, `docker compose logs -f server deepagents` |

`.env`는 처음 실행할 때 만들어지고(권한 0600) 비밀 값(JWT 비밀키와 그 키로 서명한 anon/service 키, DB 비밀번호, 보관함 KEK, cron 비밀값)이 자동으로 채워집니다. 비밀 값은 화면이나 로그에 찍지 않습니다. 업그레이드해도 그대로 유지됩니다.

## 구성

```
브라우저 ──▶ web (nginx :18080)
              ├─ /            Vue SPA (vite build)
              ├─ /api/*       server (Node BFF, SSE·웹소켓)
              ├─ /office/*    office-host (이음오피스 편집기)
              ├─ /craft/*     server (ArtCraft 웹앱, 설치한 경우)
              └─ /auth|rest|storage/v1/*  kong ─▶ auth · rest · storage
server ──▶ deepagents ──▶ 샌드박스 컨테이너(호스트 Docker, 테넌트당 1개)
                      └─▶ MCP: office-mcp · office-host · server(/mcp/folders, /mcp/panelapps)
migrate (1회) : process-gpt 스키마 → 호환 보정(db/compat, 인계 기록 handover_events 포함) → pgpt-pro server/sql → 버킷·테넌트·MCP 등록
process-miner (mining 프로필) ──▶ db (handover_events 읽기, 제안은 draft 버전·PR 로만)
```

- 공개 주소 하나(`PUBLIC_URL`)를 브라우저와 서비스가 함께 씁니다. 주소가 localhost이면 server·office-mcp·office-host 안에서 그 포트를 web으로 넘깁니다(`LOOPBACK_FORWARD`).
- deepagents는 호스트 Docker로 샌드박스를 띄웁니다(`/var/run/docker.sock` 마운트). 작업 폴더는 호스트의 `data/deepagents/`이고 컨테이너 안에서도 같은 절대 경로로 보이게 해 샌드박스가 같은 폴더를 씁니다.
- 소스 위치는 저장소 구조를 따릅니다: `..`(pgpt-pro), `../backends/process-gpt`, `../backends/office-host`. 다른 곳에 있으면 `.env`의 `PGPT_SRC`, `PROCESS_GPT_SRC`, `OFFICE_HOST_SRC`를 바꿉니다.
- 미리 빌드한 이미지를 쓰려면 `.env`에 `LITE_IMAGE_PREFIX=ghcr.io/uengine-oss/process-gpt-lite`, `LITE_TAG=<버전>`을 넣습니다. 설치가 빌드 대신 `docker compose pull`을 합니다.

## 다른 PC에서 접속

`.env`에서 `PUBLIC_URL=http://<이 PC의 IP>:18080`, `LITE_BIND=0.0.0.0`으로 바꾸고 `./install.sh`를 다시 실행합니다. 이때는 SMTP를 설정하세요. 번들 메일함(18025)은 이 PC에서만 열립니다. 인터넷에 열 때는 앞에 HTTPS 리버스 프록시를 두세요.

## 문제 해결

| 증상 | 확인 |
|---|---|
| `포트 18080 를 다른 프로그램이 쓰고 있습니다` | `./install.sh --port 28080` |
| 로그인 코드가 안 옴 | http://localhost:18025 메일함, `docker compose logs auth` |
| 채팅이 답하지 않음 | `.env`의 `LLM_*` 값, `docker compose logs deepagents` |
| 에이전트 도구가 멈춤 | Docker 소켓 권한(Linux: 사용자가 docker 그룹), `docker ps | grep deepagent-sandbox` |
| `DB 마이그레이션이 실패했습니다` | `docker compose logs migrate` |
| 문서가 편집기에서 빈 화면 | `docker compose logs office-host` — `fetch failed`면 `PUBLIC_URL`과 `LOOPBACK_FORWARD` |
| Windows | WSL2 안에 Docker Engine을 설치해 쓰는 것을 권장합니다. Docker Desktop(WSL 연동)에서는 샌드박스 폴더 공유를 아직 확인하지 못했습니다 |
| 빌드가 메모리 부족으로 실패 | Docker 메모리를 8GB 이상으로, 다른 컨테이너를 잠시 멈춤 |

## Kubernetes(kind)

아직 제공하지 않습니다. deepagents가 호스트 Docker 소켓으로 샌드박스를 띄우는 구조라 kind 노드(containerd)에서는 그대로 돌지 않습니다. 다음 단계 설계는 `kind/README.md`를 보세요.
