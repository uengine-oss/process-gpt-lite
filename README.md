# Process GPT Lite

**대화로 일하는 AI 업무 비서 — Process GPT 위에서 동작합니다.**
**A chat-first AI work assistant built on [Process GPT](https://github.com/uengine-oss/process-gpt).**

- 제품 소개 / Product page: https://www.uengine.org/contents/processgptlite.html
- 라이선스 / License: [MIT](LICENSE) · 코드명 / codename `pgpt-pro`

Process GPT Lite는 실시간 하늘 배경과 유리 카드 UI(hark 스타일)로 된 Vue 3 앱과 Express BFF입니다. 사용자는 채팅 하나로 프로세스를 만들고 실행하며, 브라우저 에이전트·스킬·예약 미션·문서 편집·패널 앱을 씁니다. 실행 엔진·에이전트·저장소는 Process GPT 백엔드(deepagents, completion, Supabase …)를 그대로 쓰고, 이 저장소에는 Lite 전용 화면과 BFF만 있습니다.

Process GPT Lite is a Vue 3 app plus an Express BFF with a live-sky, glass-card UI. One chat lets you create and run business processes, delegate to a browser agent, save skills, schedule missions, edit office documents and build panel apps. Execution, agents and storage are the unchanged Process GPT backends; this repository holds only the Lite UI and BFF.

## 주요 기능 / Features

- **채팅 · 프로젝트 · Home** — 대화 맥락 라우터가 메시지를 알맞은 대화로 보냄 / context-routed conversations
- **프로세스(BPM)** — 대화로 프로세스 생성, BPMN 보기, 시작 폼·할 일·진행 상황·산출물 / create and run BPMN processes by chat
- **브라우저 에이전트** — 실시간 화면, 계획, 직접 제어, 조치 필요 카드, 판단 게이트 / live browser agent with handoff
- **보관함** — KEK/DEK 봉투 암호화(AES-256-GCM), 비밀값은 모델에게 가지 않음 / credential vault; secrets never reach the model
- **외부 연동 · 스킬 · 예약 미션** — Google·YouTube·Slack·GitHub·Notion 커넥터 MCP, mcp-hub 등록, pg_cron 미션 / connectors, skills, missions
- **역할 기반 알림 · 팀 협업** — 역할 담당자에게 단계 배정, 대화 중 동료 지목 / role-based notifications
- **에이전트 작업실** — cli-agent(Claude Code) 작업 폴더와 터미널 / agent workroom
- **문서 편집** — 이음오피스(HWP·Word·Excel·PowerPoint·PDF 원본 형식) / IeumOffice editor via office-host
- **ArtCraft** — CAD·벡터·이미지·소리·영상 편집기와 MCP / ArtCraft editors (see [artcraft/](artcraft/README.md))
- **공유 폴더 · 스킬 공유 · 패널 앱** — git 기반 폴더, 스킬 개선 제안·비교, 이벤트 소싱 패널과 행 단위 보안 / shared folders, skill sharing, panel apps with RLS
- **Android 앱** — 서버 주소만 넣으면 쓰는 래퍼 앱([android/](android/)) / Android wrapper app

## 시연 영상 / Demo videos

| 영상 / Video |
|---|
| [Process GPT Lite 전체 소개 (5분) / Full introduction](https://youtu.be/ZcvPM4yh2GE) |
| [Process GPT Lite 둘러보기 / Overview](https://youtu.be/wrPlOhwYPcw) |
| [대화 맥락 라우터 / Context router](https://youtu.be/oL_mfiQBCPU) |
| [대화로 프로세스 만들기 / Create a process by chat](https://youtu.be/19Ap3J_XLHs) |
| [외부 연동 · 스킬 · 예약 미션 / Connectors, skills, scheduled missions](https://youtu.be/yVHodTrDwHg) |
| [SNS 트렌드 데일리 대응 / Daily SNS trend response](https://youtu.be/YkwYQHiRwFs) |
| [에이전트 작업실: Claude Code 가 주화면, 산출물은 옆에서 / Agent workroom](https://youtu.be/jDbjGIMrc5o) |
| [보관함 / Credential vault](https://youtu.be/n5SBj_iRbig) |
| [Android 앱 / Android app](https://youtu.be/TYg7S1WJ0YQ) |
| [이음오피스로 문서 바로 편집 / Edit documents in IeumOffice](https://youtu.be/5J0w5A9ylN0) |
| [CADCraft 도면 / CAD drawings](https://youtu.be/QyfrjwhBSsw) |
| [VectorCraft 벡터 그림 / Vector art](https://youtu.be/Wu4qx_VWY2A) |
| [PhotoCraft 레이어 이미지 / Layered images](https://youtu.be/qVRwjYTMISI) |
| [SoundCraft 소리 / Sound](https://youtu.be/HizUJkrQowk) |
| [FilmCraft 영상 편집 / Video editing](https://youtu.be/rjLw7C5ZN5k) |
| [PhotoCraft 라이브 공동 편집 / Live co-editing](https://youtu.be/izcVNcW37J0) |
| [공유 폴더 / Shared folders](https://youtu.be/uam0ffMMu7U) |
| [스킬 공유 / Skill sharing](https://youtu.be/KKsUf4BGf7I) |
| [패널 앱 만들기 / Panel apps](https://youtu.be/sXCp1JerNYQ) |
| [이벤트 소싱 휴가 관리 / Event-sourced leave tracking](https://youtu.be/YAlt_TRWhaE) |
| [공유 캘린더와 행 단위 보안 / Shared calendar & row-level security](https://youtu.be/5U4pDgw2kiU) |

## 아키텍처 / Architecture

```
브라우저 / Android (Vue 3 + Pinia, :5180)
   │  /api /office /craft  (Vite proxy)
   ▼
server/  BFF (Express, :8787)
   ├─ 채팅 ───────────→ context-router (:8895, 선택) → deepagents /chat/stream (:8888)
   ├─ 프로세스 ────────→ completion /complete (:8099) + polling-service
   ├─ 로그인·저장 ─────→ Supabase GoTrue / Postgres (:54321 / :54322)
   ├─ 커넥터 MCP ──────→ /mcp/<google|youtube|slack|github|notion>, mcp-hub (:8500) 등록
   ├─ 예약 작업 ───────→ pg_cron → pg_net → /api/cron/fire
   ├─ 작업실 ─────────→ cli-agent (:8890)
   ├─ 문서 ───────────→ office-host (:5390), office-mcp
   ├─ 보관함          KEK/DEK 봉투 암호화
   └─ 브라우저 에이전트  Playwright + CDP screencast
```

## 저장소 구성 / Repository layout

```
process-gpt-lite/
├── src/                 Vue 3 SPA
├── public/
├── server/              Express BFF (lib/, mcp/, routes/, sql/, test/, bridge/)
├── android/             Android wrapper app (Kotlin)
├── skills/              기본 스킬 / bundled skills
├── artcraft/            ArtCraft 업스트림 패치·빌드 스크립트 (바이너리 없음 / no binaries)
├── install/             설치 번들 (Docker Compose) / installer
└── backends/            git submodules
    ├── process-gpt/     uengine-oss/process-gpt  (branch feat/pgpt-lite)
    └── office-host/     uengine-oss/process-gpt-office-host  (main)
```

### 서브모듈 / Submodules

`backends/process-gpt`는 Process GPT 모노레포이고, 그 안에 다시 수십 개의 서브모듈이 있습니다. `--recurse-submodules`로 전부 받지 말고 Lite에 필요한 것만 받으세요.
`backends/process-gpt` is the Process GPT monorepo with many nested submodules of its own. Instead of `--recurse-submodules`, fetch only what Lite needs:

```bash
git clone https://github.com/uengine-oss/process-gpt-lite.git
cd process-gpt-lite
git submodule update --init backends/process-gpt backends/office-host
(cd backends/process-gpt && git submodule update --init \
    services/deepagents services/completion services/office-mcp services/mcp-validator \
    services/cli-agent services/bpmn-extractor skills/bpmn-process-generation-skill)
```

| 백엔드 / Backend | 위치 / Path | 용도 / Used for |
|---|---|---|
| Supabase 스택 · mcp-hub | `backends/process-gpt/docker-infra` | 인증·DB·pg_cron, MCP 등록 / auth, DB, cron, MCP registry |
| deepagents ⚠️ | `services/deepagents` | 채팅 에이전트, 스킬 / chat agent, skills |
| completion (+ polling-service) | `services/completion` | 프로세스 실행 / process execution |
| context-router | `services/context-router` | 대화 라우팅, 판단 게이트 (선택) / routing, decision gates (optional) |
| mcp-hub, mcp-validator | `services/mcp-hub`, `services/mcp-validator` | 커넥터 MCP 등록·검증 / connector registration |
| office-mcp, office-host | `services/office-mcp`, `backends/office-host` | 문서 생성·편집 / documents |
| cli-agent | `services/cli-agent` | 에이전트 작업실 (선택) / agent workroom (optional) |
| bpmn-process-generation-skill, bpmn-extractor | `skills/…`, `services/bpmn-extractor` | 대화로 프로세스 생성·저장 / process generation |

> ⚠️ `process-gpt-deepagents` 저장소는 현재 비공개입니다. 접근 권한이 없으면 이 서브모듈은 받을 수 없습니다.
> The `process-gpt-deepagents` repository is currently private; you need access to fetch it.

## 설치 (Docker Compose) / Install

Docker 만 있으면 한 줄로 설치합니다. 자세한 내용은 [install/README.md](install/README.md).
One line with Docker installed — see [install/README.md](install/README.md).

```bash
curl -fsSL https://raw.githubusercontent.com/uengine-oss/process-gpt-lite/main/install/get.sh | bash
```

## 빠른 시작 (개발자용) / Quick start (developers)

소스에서 직접 실행하려면 / To run from source by hand:

```bash
# 0) Process GPT 백엔드 실행 (backends/process-gpt/README.md 참고)
#    Supabase stack, deepagents (:8888), completion (:8099) + polling-service

# 1) 스키마 (최초 한 번) / schema, once
for f in server/sql/0*.sql; do docker exec -i supabase-db psql -U postgres -d postgres < "$f"; done

# 2) BFF 서버 / server
cp server/.env.example server/.env    # 값 채우기 / fill in
cd server && npm ci && npx playwright install chromium && npm start      # :8787

# 3) 프런트 / web app (repository root)
npm ci && npx vite                                                       # http://localhost:5180
```

- 키(`ANON_KEY`, `SERVICE_ROLE_KEY`, `POSTGRES_PASSWORD` …)는 `$PGPT_ROOT/.env`(기본 `backends/process-gpt/.env`, 없으면 `~/process-gpt/.env`)에서 읽고, `server/.env`가 덮어씁니다. / Keys are read from the process-gpt `.env`; `server/.env` overrides.
- 로컬 데모 로그인: 아무 이메일 + 코드 `000000`. 운영에서는 반드시 `PRO_DEMO_LOGIN=0`. / Demo login: any email + code `000000`; disable it in production.
- `?hour=21`처럼 주소에 시간을 붙이면 밤하늘을 미리 볼 수 있습니다.
- 공개 터널로 열 때는 `server/.public-access.example`을 참고해 basic-auth 쌍을 두세요. / For public tunnels see `server/.public-access.example`.

검증 / checks: `cd server && npm test`, `npm run build`.

## 상세 / Details (한국어)

### 구성

```
브라우저 (Vue 3 + Pinia, :5180)
   │  /api  (Vite 프록시)
   ▼
server/  BFF (Express, :8787)
   ├─ 채팅 위임 ─────────→ process-gpt deepagents  POST /chat/stream (:8888, SSE)
   ├─ 로그인·저장 ───────→ Supabase GoTrue / Postgres (:54321 / :54322)
   ├─ 예약 작업 ─────────→ pg_cron → pg_net → /api/cron/fire
   ├─ LLM (라우팅, 패널 생성, 메일 분류, 브라우저 판단) → OpenAI 호환 API
   ├─ 보관함  KEK/DEK 봉투 암호화 (AES-256-GCM)
   ├─ 브라우저 에이전트  Playwright + CDP 스크린캐스트
   └─ 메일 폴러  Gmail API(OAuth) | IMAP | 데모 메일함
```

| 기능 | 구현 위치 |
|---|---|
| 온보딩: 로그인 → 생년월일 → 소개 문장 → 메일 연결 → 주기적 메일 분석 | `src/views/*`, `server/lib/mail.js`, `/api/onboard/*` |
| 채팅·프로젝트, 문서 카드, 상태 shimmer | `server/lib/agent.js`, `src/components/ChatColumn.vue`, `Message.vue` |
| 브라우저 사용(실시간 화면, 계획, 직접 제어, 조치 필요) | `server/lib/browser.js`, `TaskCard.vue`, `HandoffView.vue` |
| 보관함(로그인, 카드, API 키, OAuth 토큰) | `server/lib/vault.js`, `VaultCard.vue`, 설정 → 계정/지갑 |
| 주기 실행 작업(대화 중 "매일 8시에…") | `server/lib/scheduler.js` (KST → GMT 변환, 다음 실행 시각 계산) |
| 패널(말로 설명하면 미니앱 생성) | `server/lib/panels.js`, `PanelFrame.vue`, `panelRuntime.js` |
| 실시간 하늘, 낮/밤 테마 | `src/sky/*` (태양 위치, 팔레트, 셰이더, Open-Meteo) |

### 프로세스 (process-gpt BPM)

| 하고 싶은 것 | 화면 | 내부 |
|---|---|---|
| 프로세스 목록·보기 | 채팅 "어떤 프로세스 있어?" → 카탈로그 → 프로세스 카드(설명, 흐름 보기) | `proc_def.definition` 시퀀스를 시작 이벤트부터 따라가 단계 순서를 만듦 (`server/lib/processes.js`) |
| 시작 | 프로세스 카드의 시작 폼(`form_def.fields_json`) → 시작 | completion `POST /complete` (`server/lib/engine.js`) |
| 내 할 일·폼 입력 | Home 주황 `Submit/Review` 버튼, 채팅의 결재 카드, 인스턴스 페이지의 "내 입력이 필요해요" | `todolist` 조회, 제출도 `/complete` (task_id 포함) |
| 진행 상황 | 프로젝트 탭 → 프로세스 → 인스턴스 페이지(진행률, 단계 타임라인) | 5초마다 갱신. 내 차례가 오면 채팅에 폼 카드가 자동으로 올라옴 |
| 산출물 | 인스턴스 페이지 "산출물": 긴 리포트 필드는 문서 카드, 파일 필드는 파일 칩 | `todolist.output`, `output_url`, Storage `files` 버킷 |
| 인스턴스에 대해 묻기 | 인스턴스 페이지 하단 컴포저 | 인스턴스별 대화 스레드(`pro_threads.ref`), 상태를 context로 붙여 deepagents에 위임 |

다음 단계로 넘기는 일은 process-gpt **polling-service**가, 에이전트 단계는 **deepagents**가 맡습니다. polling-service가 꺼져 있으면 인스턴스가 SUBMITTED에서 멈춥니다.

```bash
cd backends/process-gpt/services/completion/polling_service
PYTHONPATH=.. ../.venv/bin/python main.py
```

끝까지 돌려볼 수 있는 데모 정의 **출장비 정산**(사람 폼 → 정산 검토 에이전트 → 사람 결재)은 `node server/sql/seed-demo-process.mjs`로 등록합니다. 아직 아무도 맡지 않은 사람 역할은 시작한 사람에게 배정됩니다(1인 데모용 기본값).

### 프로세스 생성 · BPMN · 브라우저 단계

모두 process-gpt 백엔드 코드를 그대로 호출합니다.

| 기능 | 쓰는 process-gpt 기능 | pgpt-pro가 하는 일 |
|---|---|---|
| 프로세스 생성 ("○○ 프로세스 만들어줘") | deepagents `/chat/stream` + `bpmn-process-generation-skill` → `process_result`. 저장은 스킬의 `save_to_supabase.save_contract`, XML은 bpmn-extractor의 `ProcessGPTBPMNXmlGenerator.create_bpmn_xml`(프런트 `createBpmnXml` 포트) | 대화 중계, 선택지를 빠른 답장 칩으로 표시, 초안 카드 → "프로세스로 저장" 시 [bridge/save_generated.py](server/bridge/save_generated.py)를 deepagents venv로 실행. 저장 전에 `_complete_one_process`로 작업 폴더에서 최종 계약을 다시 조립 |
| BPMN 다이어그램 | `proc_def_version.snapshot` → `proc_def.bpmn` (프런트 `getRawDefinition`과 같은 순서) | bpmn-js로 렌더, 단계 상태 색칠(완료 초록 / 내 차례 주황 / 진행 중 강조), 크게 보기 |
| 브라우저 미션 단계 | 활동의 `orchestration = 'browser-automation-agent'`, RPC `fetch_pending_task` / `record_events_bulk` / `save_task_result` | process-gpt 저장소에 없는 이 오케스트레이션의 워커를 제공([server/lib/browserWorker.js](server/lib/browserWorker.js)). Playwright로 사이트를 조작하고, 결과를 활동 폼에 채워 제출 → polling-service가 다음 단계로 진행 |

데모 정의 **공급사 카탈로그 단가 조사**(조사 요청 → 브라우저 에이전트가 books.toscrape.com 조사 → 견적 검토)는 `node server/sql/seed-browser-process.mjs`로 등록합니다. 이 스크립트도 같은 `save_contract` 경로로 저장합니다.

### 외부 연동 · 스킬 · 미션 (hark의 연결·예약된 작업)

**연결 → 스킬 → 미션** 3층이고, 각 층은 process-gpt 기능을 그대로 씁니다.

| 층 | process-gpt 쪽 | pgpt-pro 쪽 |
|---|---|---|
| 연결 | `systems`(업무 시스템 레지스트리), mcp-hub 서버·바인딩·도구 카탈로그, `external_api_health` | 커넥터 MCP 게이트웨이 `/mcp/<google·youtube·slack·github·notion>` ([server/mcp/](server/mcp/)). 호출한 사용자의 JWT로 그 사용자 보관함 토큰을 꺼내 실행. 기동 시 커넥터마다 `systems` 행 + hub 서버(`system:<id>` 태그) + 헬스 행을 맞춤([server/lib/systems.js](server/lib/systems.js)). 연결 탭에서 연결하면 hub에 사용자 바인딩 |
| 스킬 | deepagents 스킬(테넌트 스킬, `/skills/upload`, `PUT /skills/{name}/files`), skill-creator, `/스킬명` 고정(Pinned Skills), frontmatter `metadata.include_tools` | "○○ 스킬 만들어줘" → skill-creator 결과를 스킬 초안 카드로 → 저장(+주기). 기본 스킬 [skills/youtube-schedule-to-calendar](skills/youtube-schedule-to-calendar/SKILL.md) |
| 미션 | Supabase pg_cron + pg_net | `pro_schedules.skill/params/state/notify` + `pro_mission_runs`. 매 실행은 새 대화에서 `/스킬명 …`. 스킬이 끝에 `MISSION_RESULT: {...}`를 내면 본 항목(state)을 누적하고, 바뀐 게 있을 때만 채팅에 알림 ([server/lib/missions.js](server/lib/missions.js)) |

process-gpt에 넣은 작은 변경(공통 기능):
- deepagents `core/llm/mcp.py` `resolve_user_placeholders`: MCP 연결 headers·env의 `{{user_jwt}}`·`{{user_email}}`을 요청 사용자 값으로 치환(값이 없으면 그 서버를 뺌). `executor.py`에서 호출.
- polling-service `mcp_processor.py`: 사용자 자리표시자가 필요한 서버는 서비스 태스크(사용자 JWT 없음)에서 건너뜀.
- frontend `ProcessGPTBackend.getSystemList/getSystem`: 빈 껍데기 → `systems` + 연결된 mcp-hub 서버·도구. 프로세스 생성기의 "외부 시스템 가이드"가 채워짐.

로컬 주소 주의: mcp-hub 검증기는 컨테이너 안(`host.docker.internal`), deepagents는 호스트(`localhost`)에서 돕니다. `PRO_MCP_VALIDATE_BASE` / `PRO_MCP_RUNTIME_BASE`로 바꿀 수 있고, 엔진을 컨테이너로 돌리면 둘을 같게 두면 됩니다.


### 설정 (`server/.env`, 모두 선택)

| 키 | 기본값 | 설명 |
|---|---|---|
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | 없음 | Google 로그인(기본 프로필) 및 별도 메일 연결(Gmail·캘린더 읽기). 리디렉션 URI `http://localhost:5180/api/auth/google/callback` |
| `PRO_VAULT_KEK` | 첫 실행 시 `server/.vault-keyring.json` 생성(0600) | 32바이트 base64. 운영 환경에서는 KMS나 Secret Manager로 주입하세요 |
| `PRO_LLM_MODEL` / `PRO_LLM_FAST_MODEL` | gpt-4.1 / gpt-4.1-mini | |
| `PRO_MAIL_POLL_SECONDS` | 300 | |
| `PRO_TENANT_ID` | localhost | process-gpt 테넌트 |
| `PRO_DEMO_LOGIN` | 켜짐 | `0`이면 코드 `000000`을 막습니다 |

### 보관함 설계

- KEK는 서버에만 둡니다. 사용자마다 DEK를 하나씩 만들어 KEK로 감싸고 `pro_vault_keys`에 저장합니다. 각 항목은 DEK로 AES-256-GCM 암호화하고, AAD에 (사용자, 종류, 사이트)를 묶습니다.
- 화면과 LLM에는 사이트, 라벨, 카드 끝 4자리만 갑니다. 브라우저 에이전트는 `fill_secret(field)` 도구로 "어느 칸에 무엇을 넣을지"만 정합니다. 실제 값은 서버가 꺼내 페이지에 직접 입력합니다.
- 결제·전송·삭제처럼 되돌리기 어려운 동작은 직전에 `need_user`로 사용자 승인을 받습니다.

### 알려진 제약

- 브라우저 세션은 서버 메모리에 있습니다. 서버를 다시 시작하면 진행 중이던 작업은 "중단됨"으로 표시됩니다.
- 패널 프록시(`/api/panel-proxy`)는 https와 공인 호스트 이름만 허용합니다. 다만 DNS가 내부 IP로 풀리는 경우까지 막지는 않습니다. 운영 환경에서는 egress 프록시 뒤에 두세요.
- Google OAuth 클라이언트가 없으면 메일은 IMAP(앱 비밀번호)이나 데모 메일함으로만 연결할 수 있습니다.

### Google 앱 등록

Google Cloud → Google Auth Platform에서 `process gpt pro` 앱의 브랜딩과 대상 사용자를 설정하고, 클라이언트 유형을 **웹 애플리케이션**으로 만듭니다.

- 승인된 JavaScript 원본: `http://localhost:5180`
- 승인된 리디렉션 URI: `http://localhost:5180/api/auth/google/callback`
- 발급받은 키는 `server/.env`에 저장하고 서버를 다시 시작합니다 (`server/.env.example` 참고). 클라이언트 보안 비밀번호는 브라우저 코드에 넣지 않습니다.
- 로그인은 `openid email profile`만 요청합니다. 로그인 후 **메일 연결 → Google 계정**을 누르면 Gmail·캘린더 읽기를 추가 요청합니다. 이 기능을 사용하려면 해당 프로젝트의 Gmail API와 Google Calendar API를 활성화하세요.
- 외부 앱의 테스트 모드라면 로그인할 계정을 테스트 사용자에 추가합니다.
- 인증 요청은 브라우저 쿠키와 연결되고 10분 뒤 만료됩니다. 인증 코드는 PKCE로 검증합니다.

검증: `cd server && npm test`, 프런트 빌드: `npm run build`.

## 관련 저장소 / Related

- Process GPT: https://github.com/uengine-oss/process-gpt
- 이음오피스 문서 편집 백엔드 / office host: https://github.com/uengine-oss/process-gpt-office-host
- ArtCraft (storytold): https://github.com/storytold
