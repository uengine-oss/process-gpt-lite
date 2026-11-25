# Process GPT Lite 회귀 테스트 스위트 (pgpt-pro e2e)

지금까지 만든 Process GPT Lite(코드명 pgpt-pro)의 기능 요건을, 시연 영상의 흐름과 openspec 명세의 시나리오에 맞춰 한 번에 다시 확인하는 테스트 묶음입니다. 세 단계(tier)로 나뉘어 있어 배포 전 관문(gate)으로 쓸 수 있습니다.

| 단계 | 무엇을 | 모델 호출 | 시간(개발 PC 기준) | 명령 |
|---|---|---|---|---|
| **smoke** | 기동·로그인·세션 갱신, 모든 최상위 화면이 페이지 오류 없이 뜸, 보안 울타리(작업실 403·터미널/라이브 티켓·출처·라이브 제어 포트 pid·MCP JWT·보관함 비밀 없음·패널 RLS·k-익명), 정적 경로(gzip), 설치 번들 | 없음 | 30초 안팎 | `npm run test:smoke` |
| **feature** | 고정 데이터로 서버 API·MCP 를 직접 불러 기능을 확인(공유 폴더·스킬 공유·패널 앱·예약·팀/역할/알림·프로세스·대화 목록·산출물 스택), 화면 동작(ConversationBar·ArtifactStack·편집기·라이브 공동 편집·다이얼·멘션·끊김 복구) | 없음 (프로세스 시험만 process-gpt 엔진 사용) | 5~8분 | `npm run test:feature` |
| **agent** | 시연 영상의 사용자 여정을 실제 모델·에이전트로 끝까지. 문구가 아니라 남는 결과(대화 id·행·파일·카드 종류)를 확인 | 있음 | 30~90분 | `npm run test:agent` |

`npm run test:all` 은 세 단계를 한 번에 돌립니다.

## 실행

```bash
cd e2e
npm install
npx playwright install chromium     # 처음 한 번
npm run test:smoke                  # → reports/smoke/html, reports/smoke/junit.xml
npm run test:feature                # → reports/feature/…
npm run test:agent                  # → reports/agent/…
npm run report                      # 마지막 HTML 보고서 열기 (RT_REPORT=smoke|feature|agent|all)
npm run cleanup                     # 중간에 끊긴 실행이 남긴 시험 데이터 정리
```

- 실패한 시험은 스크린샷·화면 녹화·trace 를 `reports/<단계>/artifacts/` 에 남깁니다 (`npx playwright show-trace <trace.zip>`).
- HTML 보고서 `reports/<단계>/html/index.html`, JUnit `reports/<단계>/junit.xml` (CI 에 그대로 연결).
- 한 파일·한 시험만: `npx playwright test --project=feature tests/feature/folders.spec.js -g F-FO-05`.

### 환경 변수

| 변수 | 기본값 | 뜻 |
|---|---|---|
| `PGPT_URL` | `http://localhost:5180` | 웹 앱 주소(Vite 개발 서버 또는 설치 스택의 nginx) |
| `API_URL` | `PGPT_URL` 을 주면 같은 값, 아니면 `http://localhost:8787` | BFF(`/api`) 주소 |
| `MCP_URL` | `API_URL` | `/mcp/*` (BFF 에 직접 닿아야 함 — nginx·vite 는 넘기지 않음) |
| `PGPT_DB_URL` | 로컬 서버면 process-gpt `.env` 의 `POSTGRES_PASSWORD` 로 `127.0.0.1:54322` | 시드·정리용 DB. 없으면 DB 가 필요한 시험은 건너뜀 |
| `PGPT_SERVER_DIR` | `../server` | 모델 없이 고정 정의로 패널 앱을 만드는 등 서버 모듈을 프로세스 안에서 쓰는 시험. 없으면 건너뜀 |
| `PGPT_ROOT` / `PGPT_WORKSPACE` / `PGPT_SKILLS_DIR` | `PGPT_ROOT` → 이 저장소의 `backends/process-gpt` → `~/process-gpt` 중 `.env` 가 있는 곳 | 키(.env)·deepagents 작업 공간·테넌트 스킬 폴더(스킬 공유 시험) |
| `PGPT_LOGIN_CODE` | `000000` | 데모 로그인 코드. 데모 로그인을 끈 서버면 `MAILPIT_URL` 로 메일함에서 코드를 읽음 |
| `MAILPIT_URL` | (없음) | 예: 설치 번들의 `http://localhost:18025` |
| `PGPT_INSTALL_DIR` | `../install` 또는 이웃 `process-gpt-lite/install` | 설치 번들 시험 |
| `RT_WORKERS` | 3 (agent 2) | 동시 실행 수 |

설치 번들(`install/`, Docker Compose)에 대고 돌리기:

```bash
PGPT_URL=http://localhost:18080 MAILPIT_URL=http://localhost:18025 npm run test:smoke
# DB·MCP 를 직접 여는 시험은 PGPT_DB_URL / MCP_URL 을 주지 않으면 건너뜁니다
```

### 시험 계정과 데이터 격리

- 모든 시험은 `pro-rt-<영역>@uengine.org` 계정만 씁니다(`lib/api.js` 가 다른 주소로의 로그인을 거부). 실제 사용자 계정은 건드리지 않습니다.
- 만든 것(폴더·패널 앱·예약·보관함 항목·스킬·프로세스 인스턴스·역할 지정)은 이름에 실행 id(`RT_RUN`)를 붙이고 시험이 끝나면 지웁니다. 실행이 끝나면 시험 계정을 팀 목록·역할에서 뺍니다(`lib/teardown.js`).
- 프로세스 시험이 시작한 인스턴스는 남은 작업 항목을 취소하고 숨겨서 누구의 Home 에도 카드가 남지 않게 합니다.

## 테스트 카탈로그

표기: ✅ 덮음 · ◐ 일부 · ✗ 아직 없음(아래 "남은 공백"). 영상은 YouTube id (`https://youtu.be/<id>`).

### 1. 기동·인증·화면 (영상: 둘러보기 `wrPlOhwYPcw`, 전체 소개 `ZcvPM4yh2GE`)

| 기능 요건 | 근거 | 시험 | 단계 | |
|---|---|---|---|---|
| 서버 설정(`/api/config`)은 비밀 없이 기능·보관함 키 id 만 | — | S-01 | smoke | ✅ |
| 웹 앱이 뜬다 | — | S-02 | smoke | ✅ |
| 데모 로그인·`/api/me`·토큰 없음/틀림 401·틀린 코드 400 | — | S-03, S-04 | smoke | ✅ |
| 세션 갱신(refresh) | — | S-05 | smoke | ✅ |
| 실시간 이벤트 SSE hello · 롱폴링 | agent-workroom: SSE 를 막는 프록시 뒤에서도 실시간 | S-06, S-07, F-RS-02 | smoke/feature | ✅ |
| 채팅·홈(Dock)·프로젝트·폴더·설정 8개 탭·작업실·로그인 화면이 오류 없이 | — | S-10…S-17 | smoke | ✅ |
| 홈 버튼: 원형 집 아이콘(로봇 아이콘은 되돌림), 누르면 Home 접기/펴기 | — | S-11 | smoke | ✅ |
| 모바일 폭(≤760px): 홈·채팅·프로젝트 탭 | 영상 `yVHodTrDwHg` 140s | S-17 | smoke | ✅ |
| 온보딩(생년월일→세리프 인사), 실시간 하늘·밤 테마, 메일 연결·할일 버튼 | 영상 `wrPlOhwYPcw` 0–48s | — | — | ✗ |

### 2. 대화 맥락 라우터·대화 목록·산출물 스택 (영상 `oL_mfiQBCPU`)

| 기능 요건 | 근거 | 시험 | 단계 | |
|---|---|---|---|---|
| 메시지마다 어느 대화의 후속인지 판단(새 주제는 새 대화, 후속은 원래 대화) | 영상 0–47s | A-01 | agent | ✅ (현재 실패 — 결함 B4) |
| `/api/conversations`: 내 대화만, 최근 순 | — | F-CV-01 | feature | ✅ |
| ConversationBar: "대화 N개", 고르면 `/chat/c/:cid`, 그 대화의 메시지만, 전체로 돌아가기 | — | F-CV-02 | feature | ✅ |
| 「채팅」 두 번 누르기로 여는 왼쪽 대화 목록(같은 `/chat/c/:cid`) | 사용자 11-24 | 36절 F-CT-01~10 | feature | ✅ |
| 대화 안에서 보낸 메시지는 그 대화로 이어짐(요청에 conversation id) | — | F-CV-05 | feature | ✅ |
| 산출물 스택: 화면의 파일이 더미로(고른 대화 · 2026-11-24 부터 전체 채팅 · 프로젝트 방도), 누르면 부채꼴(≤fanMax), 많으면 격자, Esc 로 접기 | `ArtifactStack.vue`, 스펙 `chat-artifacts` | F-CV-03 · 37절 F-AS-06 · 07 | feature | ✅ |
| 스택에서 누르면 카드와 같은 곳(엑셀→이음오피스, SVG→보기 화면 → 「VectorCraft 로 편집」→VectorCraft) — 980px 화면(더미) | `artifacts.js`, 스펙 `chat-media-preview` | F-CV-04 | feature | ✅ |
| 넓은 화면은 오른쪽 칸의 산출물 목록(접으면 띠), 문서가 열리면 비킴 | 사용자 11-24, 스펙 `chat-artifacts` | 37절 F-AS-01~08 | feature | ✅ |
| 문서가 페이지 옆에 열려도 왼쪽 칸(Home · 대화 · 프로젝트 · 루틴 목록) · 채팅 · 문서가 겹치지 않음(나란히, 아니면 목록 접힘) | 사용자 11-24, 스펙 `chat-artifacts` | 38절 F-DL-01~06 | feature | ✅ |
| 판단 전략(judge→logprob→json) 측정 | context-router 명세 | — | — | ✗ (process-gpt 쪽 eval) |

### 3. 끊김에 강한 채팅

| 기능 요건 | 근거 | 시험 | 단계 | |
|---|---|---|---|---|
| 응답 스트림이 done 없이 끊기면 "생각하는 중"을 거두고 메시지를 다시 읽음 | `stores/app.js send()` | F-RS-01 | feature | ✅ |
| 에이전트가 `PRO_STREAM_IDLE_MS` 동안 말이 없으면 기다리기를 멈추고 "에이전트가 한동안 응답하지 않아…" | `lib/agent.js` | F-RS-03 | feature | ✅ |
| DB 가 쉬는 연결을 끊어도 풀 오류 처리기로 서버가 죽지 않음 | `lib/supa.js pool.on('error')` | F-RS-04 | feature | ✅ |

### 4. 공유 폴더 (spec `pgpt-pro_shared-folders`, 영상 `uam0ffMMu7U`)

| 요구사항 | 시나리오 | 시험 | 단계 | |
|---|---|---|---|---|
| 공유 폴더를 만들고 등록한다 | 관리형 폴더 만들기 · git 저장소가 아닌 경로 등록 | F-FO-01, F-FO-02 | feature | ✅ |
| 구성원과 권한으로 공유한다 | 구성원이 아닌 사용자 · 보기 권한으로 편집 시도 | F-FO-03 | feature | ✅ |
| 드라이브처럼 파일을 다룬다 | 파일 올리기 | F-FO-01, S-32 | feature/smoke | ✅ |
| 변형을 만든다 | 같은 일을 세 갈래로 | F-FO-06 | feature | ✅ |
| 에이전트가 변형 위에서 실행된다 | 폴더가 지정된 단계 | A-10 (채팅 요청) | agent | ◐ |
| 프로세스 인스턴스가 변형을 이어 쌓는다 | 초안 다음의 검토 단계 | — | — | ✗ |
| 변형을 비교한다 | 문서 변형 비교 | F-FO-04 | feature | ✅ |
| 고른 변형을 일괄 반영한다 | 충돌 없는 일괄 반영 · 셋 중 하나만 | F-FO-04, F-FO-06 | feature | ✅ |
| 반영 충돌을 해결한다 | 같은 줄을 고친 두 변형 (멈춤·main 그대로·한쪽 선택) | F-FO-05 | feature | ✅ (문서 충돌 ✗) |
| 변형을 인계한다 | 구성원이 아닌 사람에게 인계 | F-FO-07 | feature | ◐ (에이전트에게 넘기기 ✗) |
| 작업실에서 변형을 연다 | 체크아웃→작업실 저장=커밋 | F-FO-04 (variationWith) | feature | ◐ |
| 폴더를 보존하고 정리한다 | 버린·반영한 변형 | F-FO-08 | feature | ◐ |
| 폴더 목록 · 폴더 안 · 파일 미리보기 | 드라이브처럼 둘러보기 · 미리보기 | F-FO-10, S-13 | feature/smoke | ✅ |
| 변형의 차이를 본다 | 참석자 명단 변형 | F-FO-04 | feature | ◐ (한글 문서 ✗) |
| 폴더를 색인한다 · 색인으로 찾는다 | 낱말로 찾기 · 구성원이 아닌 폴더 · 에이전트 카탈로그(MCP) | F-FO-09 | feature | ✅ |
| 연결형 저장소의 에이전트 브랜치 가져오기 | 제품 저장소 등록 | F-FO-02 (거절만) | feature | ◐ |

### 5. 스킬 공유 (spec `pgpt-pro_skill-sharing`, 영상 `KKsUf4BGf7I`)

| 요구사항 | 시험 | 단계 | |
|---|---|---|---|
| 새 스킬은 내 스킬로 시작한다(저장 직후 공유 질문, 남에게 안 보임) | F-SK-01 | feature | ✅ |
| 스킬을 전사에 공유한다(작성자만) | F-SK-02 | feature | ✅ |
| 스킬 폴더에서 변형으로 고친다 · 반영 요청을 보낸다(작성자 Home 알림) | F-SK-03 | feature | ✅ |
| 작성자와 에이전트 담당자만 반영한다(그 밖 403) | F-SK-04 | feature | ✅ |
| 에이전트 담당자를 정한다(담당자가 되면 반영 가능, 남의 에이전트는 못 넘김) | F-SK-06 | feature | ✅ |
| 반영되면 모두가 새 버전을 쓴다 · 기여 기록 | F-SK-05 | feature | ✅ |
| 병합 전에 검증한다(변경 전후 채점) | — | — | ✗ (모델 채점) |
| 채팅으로 스킬 만들기 → 그 스킬의 초안 카드 | A-08 | agent | ✅ (현재 실패 — 결함 B5) |

### 6. 패널 앱 (spec `changes/pgpt-pro-panel-apps`, 영상 `sXCp1JerNYQ` · `YAlt_TRWhaE` · `5U4pDgw2kiU`)

| 요구사항 | 시험 | 단계 | |
|---|---|---|---|
| 말 한마디로 데이터 패널 앱을 만든다 | A-02 | agent | ✅ (실시간 위젯 ✗) |
| 데이터 원본은 공유 폴더의 스프레드시트 | F-PA-02 | feature | ✅ |
| 패널에서 등록·조회·수정(필수 누락 거절) | F-PA-01 | feature | ✅ |
| 동시에 고쳐도 덮어쓰지 않는다 | F-PA-01 | feature | ✅ |
| 스프레드시트 편집기와 같은 데이터(시트에서 고친 값이 패널에) | F-PA-02 | feature | ✅ |
| 폴더 구성원과 공유 · 구성원이 아닌 사용자 | F-PA-03 | feature | ✅ |
| 채팅과 에이전트 도구로 행을 다룬다 | F-PA-03 (MCP), A-03 (채팅) | feature/agent | ✅ |
| 숨길 것이 있으면 데이터베이스에 둔다 | S-41, F-UT-02 | smoke/feature | ✅ |
| 규칙은 정해진 어휘로만, 서버가 컴파일(주입 거절) | F-PA-04 | feature | ✅ |
| 남의 행은 데이터베이스가 막는다(공유 캘린더) | S-40, F-PA-05 | smoke/feature | ✅ |
| 기록을 쌓고 요약은 다시 계산(부여·신청·취소) | F-PA-06 | feature | ✅ |
| 기록은 고치거나 지울 수 없다(시트에서 지난 기록 고치기 거절 포함) | F-PA-06, F-UT-02 | feature | ✅ |
| 기록 종류마다 할 수 있는 사람(스스로 부여 불가) | F-PA-06, S-41 | feature/smoke | ✅ |
| 항목마다 민감도, 기본으로 가림 | S-41 | smoke | ✅ |
| 민감한 숫자의 팀 합계는 세 명 이상일 때만 | S-41 | smoke | ✅ |
| 만든 사람이 보안 기본값을 확인한다(낮추면 확인·감사) | F-PA-08 | feature | ✅ |
| 모든 통로에서 같은 규칙(API·MCP) | S-41, F-PA-03 | smoke/feature | ◐ (스냅샷·검색 ✗) |
| Home 패널 카드 | F-PA-07 | feature | ✅ |
| Home 패널 카드에서 db 단계 앱의 내 행 지우기 | F-PA-09 | feature | ✅ (B2 고침) |

### 7. 이음오피스 편집기 (spec `pgpt-pro_office-editor`, 영상 `5J0w5A9ylN0` · `39F2rgTL5B0`)

| 요구사항 | 시험 | 단계 | |
|---|---|---|---|
| 에이전트가 만든 문서는 그 자리에서 편집(한글·워드 요청 → 카드 → 편집기) | A-04, F-ED-01 | agent/feature | ✅ |
| 문서를 저장소 URL 로 확보 | A-04 | agent | ◐ |
| 편집본 저장(카드가 편집본, 이전 주소는 versions, 남의 카드 404) | F-ED-03 | feature | ✅ |
| 열린 문서를 대화로 바로 고친다(라이브) | F-ED-02 (도구로 셀 고침 → 화면) | feature | ◐ (대화→모델 ✗) |
| 이음오피스 MCP 는 pgpt-pro 를 거쳐, 문서가 열린 동안만 | F-ED-01 | feature | ✅ |
| 도우미는 하나 — 편집기의 AI 버튼은 대화로 | F-ED-04 (`assistant=parent`) | feature | ◐ |
| 최대화 다이얼 | F-ED-04 (엑셀 + ArtCraft 5종) | feature | ✅ |
| 누르면 멘션(click-to-mention) | F-ED-05 (셀 범위), F-ED-08 (한글 그림) | feature | ✅ |
| 편집기 머리줄: 왼쪽 형식 타일(카드와 같은 색)·오른쪽 이음오피스 로고, 좁으면 로고 숨김 | F-ED-06 | feature | ✅ |
| 한글 실시간 편집(표 읽기·칸 채우기 `office_live_hwp_table`, 글 바꾸기 `office_live_hwp_text`) | F-ED-07 | feature | ✅ (대화→모델은 ✗) |
| 한글 그림 ↔ 포토크래프트 왕복(@이미지 → 포토크래프트로 꺼내 라이브 → "한글 문서에 넣기", 검수 기록) | F-ED-08 | feature | ✅ (모델이 그림을 고치는 부분은 A-11 과 같은 경로) |

### 8. ArtCraft 앱 (spec `pgpt-pro_craft-apps`, 영상 CAD `QyfrjwhBSsw` · Vector `Wu4qx_VWY2A` · Photo `qVRwjYTMISI` · Sound `HizUJkrQowk` · Film `rjLw7C5ZN5k` · 라이브 `izcVNcW37J0`)

| 요구사항 | 시험 | 단계 | |
|---|---|---|---|
| 같은 출처의 웹 앱(5종, wasm/js gzip) | S-30, F-CR-<앱> | smoke/feature | ✅ |
| 도면 카드는 CADCraft 로 연다 | F-CR-cadcraft, A-05 | feature/agent | ✅ |
| 그림 · 소리 · 영상 카드는 먼저 보기 화면, PhotoCraft · VectorCraft · SoundCraft · FilmCraft 는 그 화면의 「… 로 편집」으로만(스펙 `chat-media-preview`) | F-CR-<앱> · F-ED-04 · A-06 · A-11 (보기 화면을 거쳐 연다), 46절 F-MP-03 · 05 | feature/agent | ✅ |
| 에이전트는 CADCraft MCP 로 그린다 | A-05 | agent | ✅ |
| 한글 표시 | — | — | ✗ (화면 비교 필요) |
| 열린 앱을 에이전트와 함께 고친다(라이브) | F-CR-10 (도구로 레이어 추가), A-06 (대화로) | feature/agent | ✅ |
| 라이브 제어 포트는 그 사용자의 CLI 만(pid·토큰) | S-25 ×5앱, S-24 | smoke | ✅ |
| 열린 앱이 에이전트 맥락이 된다 | F-CR-<앱> (열린 동안 도구가 열린 화면을 읽음), A-06 | feature/agent | ✅ |
| 편집 뒤 검수: 요청대로 됐는지·빠진 게 없는지(그림 선 비율·사내 모델 비교, CAD 객체 수, 문서 표·행·수식), 실패면 한 번 고쳐 다시, 그래도면 되돌리고 알림, 편집본 카드에 "검수됨" | F-UT-05 (선 비율·손실 판정), A-11 (도면 색 바꾸기 → 선 70% 이상 + 검수 메모) | feature/agent | ◐ (문서·CAD 검수는 대화로만 확인) |
| 옆 시트와 최대화 다이얼 | F-ED-04 (SVG·PNG·DXF·WAV·MP4) | feature | ✅ |
| CADCraft·SoundCraft 웹 페이지 API | F-CR-cadcraft, F-CR-soundcraft (열린 화면 읽기), F-ED-04 (다이얼) | feature | ◐ (대화로 고치기 ✗) |
| PhotoCraft 웹 페이지 API | F-CR-photocraft, F-CR-10 | feature | ◐ (미리보기 요청 ✗) |
| 앱이 저장하면 편집본이 올라가고 카드가 편집본을 가리킨다 | F-CR-11 | feature | ✅ |
| ArtCraft 가 든 설치는 다섯 앱을 모두 낸다(spec `craft-apps`): `/api/config` 의 web·cli, `/craft/<앱>/` 페이지, wasm `application/wasm`+gzip, 브라우저에서 `window.<앱>`·캔버스 — 앱이 없으면 건너뛰지 않고 실패 | C-IN-<앱>, C-IN-<앱>-boot (`deploy/craft-install.spec.js`, 로그인 없음: `PGPT_ROOT_URL=https://<회사>.process-gpt.io` 또는 `PGPT_LITE_URL=…`), 서버 `test/craftInstall.test.js`(`PRO_CRAFT_WEB_ROOT` 를 준 설치 이미지 안에서) | deploy/단위 | ✅ |
| 에이전트와 디스크를 나누지 않는 설치(운영)에서 앱 도구: 사람마다 대신 폴더, 쓸 수 있는 대화 폴더만 storage 사본으로 받기·올리기(다른 사람의 대화 폴더는 열지도 쓰지도 않음, 구성원인 공유 폴더 실행 방은 됨), 내 첨부 주소, 카드, 경로는 `/workspace` 안에서만, 하루 뒤 정리 | 서버 `test/craftWork.test.js` | 단위 | ✅ (운영 deepagents 를 거친 대화는 배포 뒤 확인) |

### 9. 에이전트 작업실 (spec `pgpt-pro_agent-workroom`, 영상 `ppLKYAAGf78` · `jDbjGIMrc5o`)

| 요구사항 | 시험 | 단계 | |
|---|---|---|---|
| 실행의 작업 폴더를 연다 | S-15, F-WR-03 (공유 폴더 작업실) | smoke/feature | ◐ (Claude Code 단계 작업실 ✗) |
| 사람이 코드를 주입(저장=커밋, 그 사이 바뀌면 409) | F-WR-01 | feature | ✅ |
| 스티어링 | — | — | ✗ (진행 중인 deepagents 턴 필요) |
| 작업실 접근 권한(남의 작업실 403) | S-20, S-21 | smoke | ✅ |
| 터미널 연결(티켓 없음 401·다른 출처 403·재사용 401), 비밀 환경 변수 없음 | S-23, F-WR-02 | smoke/feature | ✅ |
| 공개 접속(터널 도메인은 접근 암호) | S-34 | smoke | ✅ |
| agent-share 와 같은 화면(파일은 터미널 자리, 마크다운 미리보기) | F-WR-03 | feature | ✅ |
| 공유 폴더와 같은 파일 보기 | F-WR-03 | feature | ◐ (한글 문서 ✗) |
| 경로 탈출 거절 | S-22 | smoke | ✅ |
| SSE 를 막는 프록시 뒤에서도 실시간 | F-RS-02 | feature | ✅ |

### 10. 보관함·브라우저 에이전트 (spec `pgpt-pro_credential-vault` · `pgpt-pro_vault-key-management` · `pgpt-pro_browser-credential-handoff` · `pgpt-pro_browser-decision-gates`, 영상 `n5SBj_iRbig` · 작업 독 `X_tziV39e2M` · 메일로 온 인증 코드 `OqXlJt5n27M`)

| 요구사항 | 시험 | 단계 | |
|---|---|---|---|
| 봉투 암호화 저장(DB 엔 암호문만, 옮기면 못 엶) | F-UT-01 | feature | ✅ |
| 항목 종류와 입력 검증(잘못된/만료된 카드) | S-28 | smoke | ✅ |
| 비밀 값을 돌려주지 않는 조회와 응답 | S-27 | smoke | ✅ |
| 사이트별 여러 계정·여러 장의 카드, 화면엔 이름·끝 4자리 | F-VA-01 | feature | ✅ |
| 값을 보여주지 않는 수정·삭제, 남의 항목 | S-29 | smoke | ✅ |
| 감지된 항목의 확인과 폐기 | F-UT-01, F-UT-03 | feature | ✅ |
| 보관함 활동 기록 · 값을 보여주지 않는 검증 | F-VA-02 | feature | ✅ |
| KEK 공급원과 식별(보안 정보 조회) | S-01, F-VA-02 | smoke/feature | ✅ |
| KEK 교체 · 폐기된 KEK 정리 · DEK 교체 · 전수 검증 | F-UT-01 (`server/test/vault.test.js`) | feature | ✅ |
| 브라우저 작업 독: 일하는 동안 입력창 옆 원형 실시간 썸네일 → 누르면 가운데 카드(작업 카드 그대로, 계획·확장·취소), Esc·✕ 로 닫힘, 끝나면 사라짐, 조치가 필요하면 주황 테두리 → 답할 카드로 | F-BD-01, F-BD-02 | feature | ✅ |
| 작업 카드 알약: 일하는 동안 지금 하는 일(status 이벤트)로 바뀜 | — | — | ◐ (실제 브라우저 작업 영상으로 확인) |
| 메일로 온 인증 코드: 카드로 묻는 동안 메일함에서 그 사이트의 메일을 찾아 서버가 바로 입력, 사람이 먼저면 사람 값, 다른 사이트 메일은 안 씀, 끄기, 무인 실행, 모델에 코드 없음 | `server/test/browser-mail-otp.test.js` (5), `mail-code.test.js` (19, 사례 `mail-code-cases.json`) | 서버 | ✅ |
| 인증 코드 카드: 「메일함에서 … 인증 메일을 찾고 있어요」, 「메일에서 찾은 인증 코드 입력됨 · 도메인」(코드 없이), 설정 › 보안 스위치, 시험용 사이트 메일 → 그 주소의 데모 메일함 | F-MO-01…03 | feature | ✅ |
| 업그레이드 후 기존 데이터 유지(단일 키 파일→키링) · 메모리 안의 DEK 수명 · 키 작업 기록 | — | — | ✗ |
| 로그인·결제 카드 요구를 보관함으로, 여러 항목 선택, 비밀 값을 모델에 노출하지 않는 서버 측 입력, 거부된 비밀번호 갱신, 일회용 값 직접 전달, 요청 닫기, 직접 제어 중 입력 감지, 결제 직전 승인 (9개 요구사항) | F-UT-03 (`server/test/browser-vault.test.js`, 모델 대역 서버가 받은 요청에 비밀 0건) | feature | ✅ (부하가 크면 흔들림 — 재시도 2회) |
| 사람이 없는 실행 · 응답 없는 요청의 만료(서버 재시작) | — | — | ✗ |
| 브라우저 결정 게이트(빠른 판단·조기 종료·측정) | — | — | ✗ (`scripts/bench-browser-gates.mjs`) |
| 커넥터 목록, 토큰은 보관함에(응답엔 없음) | F-CN-01 | feature | ✅ |

### 11. 팀·역할·알림·프로세스 (spec `pgpt-pro_role-based-notifications`, 영상 둘러보기 `wrPlOhwYPcw`, 프로세스 `19Ap3J_XLHs`, 역할 알림 영상은 유튜브 미게시)

| 요구사항 | 시험 | 단계 | |
|---|---|---|---|
| 역할 담당자에게 단계를 배정 · 아무도 맡지 않은 역할은 시작한 사람 | F-PR-02 | feature | ✅ (B3 고침) |
| 알림은 process-gpt 의 notifications 를 그대로 | F-PR-02, F-TM-03 | feature | ✅ |
| 홈의 "조치 필요" 카드와 바로 결정 | F-PR-02 (카드), — (선택지 버튼 제출) | feature | ◐ |
| 대화 중 팀원·역할에게 요청 | F-TM-03 | feature | ◐ (없는 팀원 ✗) |
| 팀과 역할 설정 | F-TM-01, F-TM-02 | feature | ✅ |
| 스킬과 프로세스의 알림 범위(예약 스킬 결과) | — | — | ✗ |
| 프로세스 정의·BPMN·시작·진행·완료 | F-PR-01, F-PR-02 | feature | ✅ |
| 채팅으로 프로세스 찾기 → 프로세스 카드 | A-07 | agent | ✅ |
| 남의 인스턴스 열람 범위 | S-33 | smoke | ✅ (B1 고침) |
| 역할 목록 상한(많이 쓰는 역할부터 300개) | F-TM-02 | feature | ✅ |
| 프로세스 스피너는 에이전트가 실제로 일할 때만, 사람 단계는 "담당자 확인 대기" | F-PR-04 | feature | ✅ |
| 검토 카드의 앞 단계 산출물 칩: 참여자·담당자만(아니면 403), 열면 검토자 자신의 카드 | F-PR-03 | feature | ✅ |

### 12. 예약·미션·연동 (영상 `yVHodTrDwHg`)

| 기능 요건 | 시험 | 단계 | |
|---|---|---|---|
| 미션 만들기(pg_cron 등록)·목록·다음 실행·일시정지·실행 에이전트(Claude Code)·실행 기록·지우면 cron 해제, 남의 미션 404 | F-SC-01 | feature | ✅ |
| cron 콜백 비밀 확인 | F-SC-02 | feature | ✅ |
| KST 예약식 → GMT 변환·다음 실행 | F-SC-03 | feature | ✅ |
| 채팅으로 예약 → 예약 칩 | A-09 | agent | ✅ |
| 바뀐 게 없으면 채팅에 아무것도 남기지 않음, 앞 실행이 돌면 다음 회차 건너뜀 | — | — | ✗ |

### 13a. 팀 공유·받은 편지함·@팀원·메신저 (설계 `process-gpt/openspec/changes/pgpt-pro-team-sharing`)

| 요구사항 | 시험 | 단계 | |
|---|---|---|---|
| 산출물을 팀원에게 공유: 받는 사람마다 허가, 원본 저장 주소는 내려가지 않음, 받은 편지함·알림, 열면 자기 사본 카드, 보낸 사람만 취소 | F-TS-01 | feature | ✅ |
| 팀원이 아니면 보내지도 받지도 못함(403), 남의 카드 404, 자신·빈 수신자·없는 역할 400 | F-TS-02 | feature | ✅ |
| "@" 제안: 자주 주고받은 팀원 먼저, 팀 밖·나는 없음, 판단 모델(`PRO_JUDGE_URL`)이 없어도 빈도 순 | F-TS-03 | feature | ✅ (판단 모델이 고른 "관계된 팀원" 순위 ✗) |
| 메신저(process-gpt 대화방 위): 1:1 하나, 그룹, 안 읽은 수·읽음, 남의 대화 404, 팀에서 빠진 사람이 있으면 403 | F-TS-04 | feature | ✅ |
| 채팅에서 @팀원에게 요청: 대화 발췌와 함께, 내 대화엔 "보냈어요" 칩, "이어서 작업"은 받은 사람만 | F-TS-05 | feature | ◐ ("이어서 작업"의 에이전트 실행 ✗) |
| 메신저 대화방은 process-gpt `chat_rooms`/`chats` 그 자체(같은 방·같은 메시지 모양, process-gpt 쪽에서 쓴 메시지가 pgpt-pro 에 보이고 안 읽음으로 셈) | F-TS-06 | feature | ✅ |
| 팀 대화 속 에이전트 제안: 잡담은 제안 없음(규칙), 업무 요청은 판단 모델로 종류까지 → 요청받은 사람에게만 카드, 보낸 사람은 못 시작, 감지에 큰 모델 0회 | F-TA-01 | feature | ✅ (판단 모델 없으면 건너뜀) |
| 제안 아니요는 나만 숨김, 대화별 AI 제안 끄기, 구성원 밖 404 | F-TA-02 | feature | ✅ (시작 → 에이전트 결과·파일 공유는 두 브라우저 수동 확인, 자동 시험 ✗) |

### 13c. 대화방 원격 회의·도우미·자동 회의록 (설계 `process-gpt/openspec/changes/pgpt-pro-meetings`, 영상 `4oOsqX72vII`)

| 요구사항 | 시험 | 단계 | |
|---|---|---|---|
| 방에서 회의 시작·참여, 방 구성원만(시작·참여·상태·신호·소리·글·방 메시지 모두 404), 방에 회의 카드 하나를 제자리 갱신 | F-MT-01 | feature | ✅ |
| 신호(offer/answer/ICE)는 회의에 들어온 두 사람 사이에만, 기존 SSE/롱폴링 `meeting` 이벤트로 | F-MT-02 | feature | ✅ |
| 받아쓰기·기록 동의: 동의 안 하면 소리·글 403, 회의록에 "동의하지 않은 분" | F-MT-03 | feature | ✅ |
| 의도 → 자료(규칙 → 판단 모델, 잡담은 건너뜀, 큰 모델 0회), 볼 수 있는 사람에게만·저장소 URL 없음, 열면 내 사본, 부탁 → 시작/아니요 제안(회의록 블록 아래) | F-MT-04 | feature | ✅ (판단 모델 없으면 건너뜀) |
| 회의록 블록: 문장마다 행을 만들지 않고 한 행 갱신, 회의 끝내기 → 최종 회의록(참여자·시간·줄 수)·끝 카드, 기록은 process-gpt 모양(assistant 행 + 글) | F-MT-05 | feature | ✅ |
| 방별 도우미 끄기: 영상 회의만(소리·글 403), 방엔 시작·끝 카드만 | F-MT-06 | feature | ✅ |
| 공유 폴더 문서도 자료: 받아쓴 영어 낱말(셉→SAP)·파일 종류(PDF)로 골라 말한 사람에게 바로 열기, 폴더 밖 사람에겐 이름도 안 감, 못 찾으면 도우미가 말함, 「자료 찾기」로 직접 찾아 띄우기(남의 폴더 문서는 404) | F-MT-07 | feature | ✅ (말 단계는 판단 모델·LLM 없으면 건너뜀) |
| 자료 띄우기 › 내 컴퓨터에서: 올린 파일이 내 파일 카드로 자료에 오르고(회의 밖 사람 404), 띄우기 전엔 상대가 못 보고, 모두에게 띄우면 상대는 자기 사본으로 연다 · 폴더 문서를 띄우면 폴더 밖 사람에게 띄운 사람의 사본으로 | F-MT-08 · F-MT-07 | feature | ✅ |
| 가짜 카메라·마이크 두 브라우저: 메시 연결, 화자별 자막, 자료가 둘 모두에게, 모두에게 띄우기 동기화, 부탁 시작 → 결과 자료, 끝 → 방에 회의록 | A-14 | agent | ✅ (OpenAI TTS 로 시험 말소리를 만듦 — 키 없으면 건너뜀) |
| 세 사람·평면도(CAD)·프로세스 진행 상황(단계 산출물 칩)·발표자 무대·회의록 스크롤 | — | — | ◐ (시연 녹화 스크립트로 확인, 자동 시험 ✗) |
| TURN 이 필요한 망(대칭 NAT), 7명 이상(SFU) | — | — | ✗ (운영 후속) |

### 13b. 메일 → 초안 · 프로세스 마이닝 → 정식 등록 → 자동 라우팅 (`lib/mail.js` · `lib/mining/*`)

| 요구사항 | 시험 | 단계 | |
|---|---|---|---|
| 고객 메일이 문서를 요청하면 묻지 않고 초안(홈 "초안 검토" 카드 + 파일 카드), 메일 한 통이 마이닝 케이스로 | A-12 | agent | ✅ (평면도·한글 제안서까지 가는 설계 요청은 ✗ — 수십 분) |
| 데모 메일함에서만 도착(`/api/mail/demo-arrive`, 아니면 400) | A-12 | agent | ✅ |
| CADCraft 가 없는 설치는 평면도 없이 나머지 초안만 | — | — | ✗ (Docker lite 에서 수동 확인) |
| 추천·등록·보류는 관리자만 | F-MN-01 | feature | ✅ |
| 인계 기록 → process-miner 가 패턴으로 묶고 순서대로 도출 → 정식 등록 계약(단계·폼·시작/끝) | F-MN-02 | feature | ✅ (miner :8014 없으면 건너뜀) |
| 다음 메일 라우팅 기준(형식 2개·낱말 2개) | F-MN-03 | feature | ✅ |
| 등록된 프로세스와 맞는 메일 → 그 프로세스로 시작(프로세스 카드·`pro_mining_runs`) | A-13 | agent | ✅ (등록된 추천이 없으면 건너뜀) |
| 관리자 화면(MiningView)에서 흐름 보기·정식 등록 | — | — | ✗ (관리자 계정이 필요 — 시험 계정은 관리자가 아님) |
| 관리자가 추천 화면의 대화로 근거를 묻고, 단계를 옵션으로 정하면 언제 건너뛰는지 되묻고 조건을 들으면 정식 등록 정의에 배타 게이트웨이와 두 흐름의 조건(관리자 조건과 그 반대)을 넣어 새 버전으로 저장 · ProcessGPT 엔진이 그 조건대로 분기 · 다시 찾아도 그대로 · 새 사례는 제안으로 · 사례 옮기기 · 관리자가 정한 범주가 다음 판단에 이어짐 (단계 구성이 다른 정식 등록 프로세스 두 개) | A-MN-10 (`mining-admin-talk.spec.js`) | agent | 8088/lite 에서 (시험 계정 `pro-rt-mining-admin` 을 관리자로 바꿈, 테넌트의 기존 추천 세 개를 씀. 엔진 분기는 `process-gpt-completion/polling_service` 가 옆에 있을 때) |
| 관리자가 대화로 택일 갈래(견적서 작성)의 조건을 고치면 새 버전으로 저장 · 모든 분기 흐름에 조건, 기본 흐름 없음 · 데모 메일이 업무 범주로 정식 등록 프로세스를 시작 · 폴링 서비스가 저장된 조건대로 갈래를 골라 인스턴스를 진행 (고객 회신 제외) | A-MN-11 (`mining-branch-run.spec.js`) | agent | 8088/lite + 폴링 서비스 |
| 구성이 다른 두 정식 등록 프로세스(행사 견적·고객 회신: 계약서 요청 여부 / 설계 제안·견적 대응: 견적 합계 5천만 원)에서 갈래마다 데모 메일 한 통 · 업무 범주로 그 프로세스가 시작 · 에이전트 단계 뒤 엔진이 저장된 조건대로 참인 흐름 하나로 감 (합계 갈래는 그 인스턴스의 견적 합계로 판정) | A-MN-12 (`mining-branch-run-others.spec.js`) | agent | 8088/lite + 폴링 서비스 + deepagents·office-mcp |
| 관리자가 대화로 행사 견적(계약 검토)·설계 제안(재무 검토)의 옵션 조건을 같은 뜻의 다른 말로 고치면 새 버전 하나로 저장(`by:'admin'`, 반대 조건은 업무 말) · 다음 메일이 그 새 버전으로 시작되고 엔진이 그 문장으로 판정 | A-MN-13 (`mining-branch-admin-others.spec.js`) | agent | 8088/lite + 폴링 서비스 + deepagents·office-mcp·cadcraft-cli |
| 연습 메일로 새 업무 사례를 쌓아(일부만 검토 공유) 마이닝이 만든 추천에서, 업무 흐름이 정하지 못한 분기가 확인 필요로 남음(초안과 맞은 건수 또는 "초안 없음", 정식 등록 막힘) · 확정 전 미리보기 BPMN 에 조건 없음 · "초안대로" 또는 대화로 확정하면 `by:'admin'`, 반대쪽도 업무 말 조건 · 이미 닫힌 같은 사례는 이어 씀 | A-MN-14 (`mining-undecided-admin.spec.js`) | agent | 8088/lite + deepagents (시험 계정 `pro-rt-mining-finance` 를 검토자로) |
| 정의에서 필수·옵션 읽기·게이트웨이 넣고 빼기·저장 전 이벤트 정리 / 경계·제안 계산·말에서 단계·사례 가리기 | `server/test/mining-shape.test.js` · `server/test/mining-admin.test.js` · process-miner `tests/test_lite_admin_boundary.py` | unit | ✅ |

### 13d. 프로세스 개선 — 병목·가치 흐름·제약 이론·크리티컬 패스·개선 실행 (`lib/improve/*`, 설계 `process-gpt/openspec/changes/pgpt-pro-process-improvement`)

| 요구사항 | 시험 | 단계 | |
|---|---|---|---|
| 리드타임 분해: process-gpt `leadtime.py` 원본 시험 17개 이식(사람 0초 회귀·겹침·불변식) + 확장(미리 만든 TODO·사람 착수·검토 대기·재작업) | F-UT-06 (`server/test/improve-leadtime.test.js`) | feature | ✅ |
| CPM: 순차·병렬(ES/EF/LS/LF/여유)·배타 게이트웨이 시나리오·루프 기대 반복·진행 중 건의 남은 경로, VSM 흐름 효율, 제약, what-if 6종 | F-UT-06 (`server/test/improve-cpm.test.js`) | feature | ✅ |
| 분석 API: 참여하지 않은 사람 403, 병목 점수 합 100, 인스턴스 분해 합 = 리드타임, 제약 = 재무 검토 담당, 5단계, 크리티컬 패스·여유, p80 > 중앙값 | F-IM-01 | feature | ✅ |
| what-if: 사전 초안·기준 미만 건너뛰기·인원 추가로 리드타임 감소, 건너뛰기 비율은 기록에서, 불가능한 변경은 400 | F-IM-02 | feature | ✅ |
| 새 제약 알림은 소유자에게 한 번(같은 제약이면 다시 안 보냄) | F-IM-03 | feature | ✅ |
| MCP `/mcp/improve` 도구 6개, JWT 없으면 거부, 숫자는 결정적 계산 | F-IM-04 | feature | ✅ |
| 개선 적용: 확인 필수·소유자/관리자만, process-gpt 저장 경로로 새 버전(`proc_def_version` major, parent, BPMN snapshot), PI Flag, 적용 기록, 버전 비교 | F-IM-05 | feature | ✅ |
| 개선 화면 다섯 탭이 오류 없이(열지도·VSM·5단계·간트·what-if) | F-IM-06 | feature | ✅ |
| 담당자가 작업 항목을 처음 열면 `events.human_checked` 한 번(사람 착수 신호) | F-IM-07 | feature | ✅ |
| 채팅 "○○ 프로세스 어디가 병목이야? 어떻게 줄여?" → 계산 결과 + 모델 설명 + 개선 카드 | — | — | ✗ (모델 문장이 매번 달라 수동 확인 — 튜토리얼 20장) |
| 개선 적용 뒤 실제 엔진으로 새 버전 인스턴스 실행·버전 비교 | — | — | ◐ (튜토리얼 시드 `scripts/seed-improve-demo.mjs --run` 으로 수동) |

### 13. SNS 트렌드 대응·Android·설치

| 기능 요건 | 근거 | 시험 | 단계 | |
|---|---|---|---|---|
| SNS 트렌드 데일리 대응(알림·worktree 구현·승인·재시작 재개) | spec `pgpt-pro_sns-trend-response`, 영상 `YkwYQHiRwFs` | — | — | ✗ (수십 분짜리 cli-agent·브라우저 실행) |
| Android 앱(서버 주소 설정·다른 사이트 링크) | spec `pgpt-pro_android-app`, 영상 `TYg7S1WJ0YQ` | — | — | ✗ (에뮬레이터 필요) |
| 데스크톱 앱(Electron): 서버 고르기·로그인·화면·제목 영역(신호등·끄는 띠·단추)·밝음/어두움·넓은/좁은 폭·바깥 링크·연결 실패·알림·메뉴·Google 로그인 창 안·하나만 실행·창 자리 기억·브라우저 무변화 | spec `openspec/specs/desktop-app`, `desktop/` | D-01…D-11 (`tests/desktop/desktop.spec.js`, `--project=desktop`, 묶은 앱은 `PGL_DESKTOP_EXE`) | desktop | ✅ (macOS 만) |
| 설치 번들: 스크립트 문법·compose(lite/full/mining)·인계 기록 스키마·nginx 경로 | `install/` | S-50…S-53 | smoke | ✅ |
| 영어 모드 다듬기: 워드 그림 ↔ 포토크래프트(영어·한국어), 앱 이름으로 Craft 도구, 영어 이름 지목, 패널 설계 토큰·금액(한·영), 브라우저 구매 차단·결과 문장, 테스트 상점 영어판, 설치 스크립트 언어 | `english-fixes.spec.js`, `server/test/en-fix.test.js`, `browser-tasks.test.js` | F-EN-01…04, S-53 | feature·smoke | ✅ (F-EN-04 는 모델 호출) |
| 설치 스택에 대고 전체 스위트 | `PGPT_URL=http://localhost:18080` | (전체) | 모두 | ◐ |

### 13e. 사용량·요금제 (`lib/plans/*`, 설계 `pgpt-pro/docs/billing/tenant-billing-design.md`, 영상 `bpYwayg_6Co` · 요금제 화면 `d3UtRrwus7M`)

| 기능 요건 | 근거 | 시험 | 단계 | |
|---|---|---|---|---|
| 요금제 탭: 지금 요금제의 다음 것을 먼저, 큰 가격·사용량 배지·할 수 있는 일(잰 값으로 센 수)·맨 아래 안내, 팀원은 「바꿔 달라고 요청」, 지금 요금제는 누를 수 없음 | `UsagePlan.vue`, `lib/plans/equivalents.js` | F-PL-01 | feature | ✅ (PRO_LLM_KEYS=litellm 서버) |
| 할 수 있는 일의 수 = 요금제 사용량 ÷ 실제로 시켜 본 일의 비용(2자리로 내림), 쓴 만큼 요금제는 일 하나의 값 | `jobs.json` (`scripts/measure-plan-jobs.mjs`) | `server/test/plans-equivalents.test.js` | 단위 | ✅ |
| 일의 비용을 다시 재기(모델·프롬프트가 바뀌면) | `scripts/measure-plan-jobs.mjs --write` | — | — | ✗ (실제 모델 호출, 수동) |
| 한도·일할 정산·이벤트 소비자 | `server/test/plans.e2e.mjs`, `plans-prorate.test.js`, `llm-keys.e2e.mjs` | — | 서버 | ✅ |

### 14. 튜토리얼 결함 고침 — 개인정보·채팅·브라우저·메일·프로필 (`docs/tutorial-findings.md`)

| 기능 요건 | 근거 | 시험 | 단계 | |
|---|---|---|---|---|
| 다른 사람 문서는 내 대화에 파일 카드로 붙지 않음: 이번 턴에 쓴 파일·이 대화 폴더(`.bpmn/<대화>`)·턴 중에 바뀐 파일만, deepagents 가 끝에 다시 올린 hwpx 는 원본 경로로 판단 | 결함 #6·#39 (`lib/provenance.js`) | F-UT-08 | feature | ✅ |
| 에이전트에게 새 파일은 이 대화 폴더에, 참고는 내 첨부·받은 공유(`uploads/<나>`)·공유 폴더에서만 쓰라고 알림 | 결함 #6·#39 | F-UT-08 | feature | ✅ |
| 답을 기다리는 중 같은 대화에 보낸 메시지는 "대기" 후 이어서 답(앞 턴이 취소되지 않음), 다른 대화는 나란히 | 결함 #31·#32 (`lib/turns.js`) | F-UT-08, F-FX-A07 | feature | ✅ |
| 채팅 멈추기 버튼 → deepagents `/chat/stop`, "답을 멈췄어요", 멈춘 턴의 스크립트는 카드가 안 됨 | 결함 #25 | F-UT-08, F-FX-A07 | feature | ✅ |
| 공유하지 않은 내 스킬을 파일과 함께 부르면 스킬 위치·첨부가 함께 감, 빈 답은 안내 문장 | 결함 #18 | F-UT-08 | feature | ✅ |
| 빠른 답 버튼은 질문으로 끝나는 짧은 선택지에만(보고문의 글머리 목록은 그대로) | 결함 #30 (`src/replies.js`) | F-UT-08, F-FX-A06 | feature | ✅ |
| 브라우저 두 번째 작업은 대기(카드 "대기", 따로 취소), 앞 작업이 끝나면 시작 | 결함 #29 | F-UT-08, F-FX-A08 | feature | ✅ |
| 브라우저 동작이 하나도 없으면 "완료" 대신 "확인 필요", 요약에는 실제로 한 동작만 | 결함 #28 | F-UT-08, F-FX-A08 | feature | ✅ |
| 팀원 추가·빼기·전체 역할 지정은 관리자(users.is_admin·tenants.owner)만, 뺀 사람은 다시 들어오지 않음, 화면은 읽기 전용 | 결함 #1 | F-FX-A01, F-TM-01 | feature | ✅ |
| 데모 메일함 발신 도메인은 `.example`, 홈 카드는 데모 메일함이면 로고(favicon)를 부르지 않음 | 결함 #24 | F-FX-A02 | feature | ✅ |
| 연습 메일 받기(달빛커피 2호점 제안·견적 요청 등 고정 메일) — 설정 › 시스템·계정 | 결함 #26 | F-FX-A03 | feature | ✅ |
| 설정 › 계정 › 연결에서 메일 연결(Gmail·IMAP·데모) 바꾸기 | 결함 #27 | F-FX-A04 | feature | ✅ |
| 표시 이름: 설정 › 계정에서 바꾸고, 온보딩에서 한 번 물음 | 결함 #23 | F-FX-A05 | feature | ✅ |

### 15. 튜토리얼 결함 고침 2 — 프로세스 엔진·정의·마이닝·미션·패널·작업실 (`docs/tutorial-findings.md`)

| 기능 요건 | 근거 | 시험 | 단계 | |
|---|---|---|---|---|
| 진행 중인 인스턴스는 시작한 정의 버전으로 끝까지(새 버전 저장 뒤에도), 새 인스턴스는 새 버전 — completion `upsert_process_instance` 가 버전을 시작 때 한 번만 찍음 | 결함 #41 (process-gpt-completion `feat/pin-instance-version`) | F-FX2-01 | feature | ✅ |
| 대화로 만든 프로세스 저장: 작업 폴더(`/.bpmn/…`)를 찾아 폼·에이전트(에이전트 사용자 생성·정의의 id 연결)·스킬까지 저장, 저장된 카드의 「흐름 보기」가 펼쳐져 화면에 들어옴 | 결함 #40 (`bridge/save_generated.py`, `lib/missions.js workspaceHostPath`, `ProcessCard.vue`) | F-FX2-02 | feature | ✅ |
| 마이닝 정식 등록: 병렬 게이트웨이는 `gateWayType` 까지 넘겨 BPMN 에 parallelGateway 로 그림 | 결함 #33 (`lib/mining/service.js buildContract`) | F-FX2-03 | feature | ✅ |
| 에이전트 단계가 잠깐의 오류(DB 복구 모드·연결 끊김·시간 초과)로 실패하면 간격을 늘려 최대 3번 다시 줄 세움, 그 밖·한도 초과는 시작한 사람에게 Home 알림, 인스턴스 화면에 실패 이유와 「다시 시도」 | 결함 #42 (`lib/stepRetry.js`) | F-UT-07, F-FX2-04 | feature | ✅ |
| 팀 공유는 받는 사람의 역할(재무 담당→재무 검토, 디자이너→디자인 검토)·공유 메모로 단계 이름, 고객 회신 뒤의 공유는 사례에 넣지 않음, 사례가 절반 넘게 겹치는 묶음은 같은 추천(이름도 겹치지 않게), 묶는 규칙은 마이닝 화면에 안내 | 결함 #22·#43·#21 (`lib/mining/recorder.js`, `service.js sameSuggestion`) | F-FX2-05 | feature | ✅ |
| 예약 실행 실패(스킬·프로세스·프롬프트 모두)는 실행 기록·채팅·Home 알림에, DB 가 실행을 기록조차 못 하면 몇 분 뒤 다시, 결과 줄(MISSION_RESULT) 없는 정상 실행은 성공(변동 여부 모름)으로 알림, 미션용 스킬에는 결과 줄 단계를 넣음 | 결함 #15·#17 (`lib/missions.js`) | F-UT-07, F-FX2-06 | feature | ✅ |
| 패널 숫자 칸: "3,800만 원"·"1억 2천만 원" 같은 한국어 금액, 띄어쓰기 없는 머리글, 답 문구의 같은 칸 반복 없음 | 결함 #12 (`lib/panelApps/sheet.js parseKoNumber`) | F-UT-07, F-FX2-07 | feature | ✅ |
| 요약 타일의 큰 금액은 타일 폭에 맞춰 줄어들고 줄바꿈(옆 타일로 넘치지 않음, 폭 1280) | 결함 #13 (`PanelAppCard.vue`·`PanelEventsBody.vue`) | F-FX2-07 | feature | ✅ |
| 기록형 패널 설계가 시간 초과면 작은 단계(종류 → 그 종류의 모양)로 다시, 모든 설계 호출에 토큰 상한, 끝내 안 되면 알아듣는 말 | 결함 #11 (`lib/panelApps/service.js design`) | F-UT-07 | feature | ✅ |
| 대화 폴더 밖 `/workspace/<이름>` 파일 카드는 "눌러서 열기" → 저장소 사본(문서는 편집기, 글은 text/plain), 남의 카드 404·작업 공간 밖 400 | 결함 #14 (`lib/fileCards.js`, `src/artifacts.js`) | F-FX2-08 | feature | ✅ |
| 스킬 변형 검증은 20분 기한, 기한을 넘긴 'running'(서버 재시작 등)은 실패로 닫혀 다시 검증 가능, 화면은 경과 분·연결 끊김을 표시 | 결함 #19 (`lib/folders/skills.js`) | F-FX2-09 | feature | ✅ |
| CADCraft 도면 글자의 ㎡·㎥ 는 m²·m³ 로(웹 글꼴에 단위 기호가 없음) | 결함 #10 (`mcp/craft.js plainUnits`, `lib/floorPlan.js`) | F-UT-07 | feature | ✅ |

### 16. Agentic BPM — 정책·가드레일·결정 원장·대안 경로 최적화 (spec `pgpt-pro_agentic-guardrails`, 설계 `pgpt-pro/docs/agentic-bpm/plan.md`, 영상 메일 `-1VuYuna3EA` · 결정 브리프 `zsqKdt57lU0` · 출시 대안 `Pws7Y-HNSHk` · 리포트 `wpwh7QEoRXM`)

판단 사례 30개(`server/test/agentic-cases.json` → `agentic-regression.test.js`)와 시나리오 E2E(`server/test/scenario-{mail,release,purchase}.e2e.mjs`)는 서버 시험으로 돈다.
`cd server && node --test test/policy.test.js test/agentic-regression.test.js`, 시나리오는 BFF 를 띄우고 `node test/scenario-mail.e2e.mjs` 다.

| 요구사항 | 시험 | 단계 | |
|---|---|---|---|
| 정책 카탈로그: 근거·승인자 역할, 켜고 끄기는 관리자만(403), 틀린 정책은 400 | F-AG-01 | feature | ✅ |
| 가장 엄격한 판단·허용 오차·정책 없는 행위는 허용, 시험해 보기는 원장에 남지 않음 | F-AG-02, 판단 사례 30 | feature, 서버 | ✅ |
| 하루 21번째 외부 메일 → 팀장 승인(시간 창 한도) | `policy.test.js`, 메일 E2E 7단계 | 서버 | ✅ |
| 외부 메일: 실행 후 기록, 10분 안 회수, 두 번째 회수 409, 남이 회수 403 | F-AG-03 | feature | ✅ |
| 개인정보 든 외부 메일: 보관(보낸편지함에 없음), 본인 승인 403(관리자여도), 역할 없는 사람 403, 다른 승인자가 승인 → 요청자 이름으로 실행, 처리된 요청 409, 원장에는 건수·종류만 | F-AG-04 | feature | ✅ |
| 원장 공개 범위(팀원은 자기 판단만), 리포트는 관리자만 | F-AG-05 | feature | ✅ |
| 채팅 메일 요청(send_mail): 사내 허용·외부 기록·명단 승인·명단 전체 차단·대외비 보안 담당자, 카드와 승인 뒤 카드 바뀜 | 메일 E2E(`--no-chat` 없이) | 서버 | ✅ |
| 금요일 출시: 막힘 → 대안 넷(사전 판단·시뮬레이션·점수), 필수 제약 위반 제외, 릴리스 책임자의 선택이 곧 승인, 요청자는 고를 수 없음(403), 우선순위 바꾸면 순위 바뀜·다시 실행, 보안 점검 실패 → 예외 권한자·없으면 멈춤 | 릴리스 E2E 6단계 | 서버 | ✅ |
| 구매 승인: 결정 브리프(선택지별 추가 승인·남은 리드타임·근거), 승인 전 초안·재고 확인, 승인 전 발주 409·요청자 발주 403, 두 승인 뒤 인계 꾸러미 발주, 반려 보상(초안 취소·원장 되돌림), 주공정 여유 순 승인함 | 구매 E2E 26개(`server/test/scenario-purchase.e2e.mjs --reset`) | 서버 | ✅ (전후 측정의 "후"는 스크립트 승인자라 동작 확인만) |
| 원장에서 배우는 정책 조정(완화·강화·대안), 적용하면 결정이 바뀌고 버전이 오름, 리포트 집계 | `server/test/agentic-insights.test.js` | 서버 | ✅ |
| 화면: 정책·가드레일 세 탭, 승인자 알림 → 원장 줄 강조 → 승인, 전략맵 | 영상(녹화 중 단언) | — | ◐ (Playwright 화면 시험 ✗) |

### 17. 팀 맥락 공유 — 자동 참고·참고 요청·팀 활동·공개 등급 (설계 `process-gpt/openspec/changes/pgpt-pro-team-context`, 영상 ① `Cm6MyQ_h8qE`(2판, 1판 `7jat7FFJeKw`) · ② `VJpa1aKFbUo` · ③ `2zOfxuP5zEU`)

판정 사례(`server/test/context-visibility-cases.json` 39 · `refer-cases.json` 16)와 HTTP E2E(시드 회사 team-demo, 실제 임베딩·모델)는 서버 시험으로 돈다.
`cd server && node --test test/context-visibility.test.js test/refer.test.js test/context-grade.test.js test/team-activity.test.js test/context-policy.test.js test/repeat.test.js`(92),
E2E 는 BFF 를 `PRO_TENANT_HOSTS=…,team.localhost=team-demo` 로 띄우고 `node scripts/seed-team-context.mjs --reset` 뒤 `node test/{context-share,context-grade,team-activity,context-policy,repeat,guard-reading}.e2e.mjs` 다. 글을 읽는 품질의 하한은 `node test/guard-eval.e2e.mjs`(사례 `test/guard-eval/`, 실제 모델, 스펙 `pgpt-pro_guardrail-reading`).
팀원 맥락 참고의 결정은 회사 정책(`context-policy-cases.json` 14 — 실제 정책 엔진), 같은 요청 판별은 `repeat-cases.json` 10(실제 게이트웨이 모델, `repeat.e2e.mjs` ④).

| 요구사항 | 시험 | 단계 | |
|---|---|---|---|
| 공개 등급 판정: 범위(팀·부서·회사)×깊이(제목·요약·원문), 장·관리자 덧씌움, 민감, 조직도 밖, 두 팀, 허락 만료 직전·직후·회수·다른 대화 | 판정 사례 39 | 서버 | ✅ |
| 자동 참고 고르기: 기준 0.55·회색 0.45~0.55 판정 0.5·판정 실패·고정·빼기·세 대화 빼기 학습·요청 후보 0.5·상한, 인용 블록 | 고르기 사례 16 | 서버 | ✅ |
| 글 읽기: 돌려 말한 글은 모델이 읽어 묻기, 낱말만 같은 글은 자동 허용, 주민번호 형식은 모델 없이 묻기, 계좌·전화 형식은 모델이 읽음, 같은 글은 다시 안 부름, 정책 끄면 안 읽음, 모델이 끊기면 낱말·`regex` 기록과 낱말에 안 걸려도 묻기(`unread`), 복귀 후 다시 읽음, 확률을 주지 않는 모델은 낱말로 운영 | `guard-reading.test.js` 14, `guard-reading.e2e.mjs` 15단계, F-TC-09·10 | 서버·feature | ✅ |
| 읽는 품질 하한: 맥락 잡음 95%↑·오탐 25%↓, 메일 잡음 90%↑·오탐 20%↓, 낱말 먼저보다 나쁘지 않음 | `guard-eval.e2e.mjs`(고정 사례) | 서버 | ✅ |
| 경쟁사 가격 → 내 맥락(원문)+같은 팀 요약, 박하늘 원문 표지 0, 「분기 정리」 후보 아님, 관계없는 질문, 빼기, 끄기, 2초 안 | `context-share.e2e.mjs` 1–4 | 서버 | ✅ |
| 같은 팀 자동 허용·다른 대화는 요약·하루 모음 카드, 다른 팀 묻기→홈 카드→원문·7일·턴 빼고 허락·409, 민감 묻기, 비공개 404(관리자 포함), 30건 429, 3일 만료, 쓰인 곳·회수 | `context-share.e2e.mjs` 5–8 | 서버 | ✅ |
| 등급 바꾸기·422(민감 전체 공개)·주인 아니면 404, 민감 제안·승인·무시, 미리보기(새로·장·관리자·허락), 열람 기록, 기본 등급 | `context-grade.e2e.mjs` 16단계(확인 63), `context-grade.test.js` 11 | 서버 | ✅ |
| 팀 활동 카드(팀장·다른 팀·관리자 차이, 문장 없음), 시간순 깊이, 원문 보기 자동 허용, 조직도 403/모아 보기, 겹침(보는 사람의 글로만), 관리자 눈, 비공개로 바꾸면 바로 빠짐(진행 중 작업 줄 제목 누출 고침) | `team-activity.e2e.mjs` 12단계, `team-activity.test.js` 16 | 서버 | ✅ |
| 칩(주인·깊이·원문 요청·빼기·고정·자동 참고 끄기), 요청 후보 상태(요청함·허락됨·다시 답하기), 홈 카드에서 허락 → 카드 내려감·요청자 결과 | F-TC-01…03 | feature | ✅ |
| 팀 탭·설정 › 공유와 허락 화면 | F-TC-04·05 | feature | ✅ |
| 회사 정책: 카탈로그 정책 셋(민감 표시 → 주인, 민감할 수 있는 주제 → 주인, 기록), 주제 목록 검증(깨진 패턴·빈 이름 400), 낱말 경계(인사이트 ≠ 인사), 무시한 제안은 주제 없음, 원장 한 줄 제목 가림, 정책 끄기·주제 목록 바꾸기 | `context-policy.test.js` 5(판정 사례 14) | 서버 | ✅ |
| 참고 요청 ↔ 정책·원장: 자동 허락 「기록」→ 회수 「회수함」, 주제(성과급→급여)면 같은 팀도 묻기·요청자에게 주제 없음·홈 카드 정책 줄, 원장 승인 단추 없음·승인 API 404, 주인 허락·거절이 원장에(승인자), 무시한 제안은 규칙대로, 주제 정책 끄면 규칙대로·고정 줄 바뀜, 3일 만료 「만료」, 요약 때 민감 제안 + 홈 카드 한 장 | `context-policy.e2e.mjs` 13단계(확인 35) | 서버 | ✅ |
| 같은 요청 알아보기: 후보는 보는 깊이의 글만(예문은 원문 깊이에서만), 좁히기 0.8/0.6·같은 문장 하나·최근 답 먼저, 모델 답 → 카드(stale 제외·맥락마다 하나·최대 2), 카드에 답 본문 없음 | `repeat.test.js` 5 | 서버 | ✅ |
| 이미 한 요청 → 카드(에이전트 안 부름) → 그 답 보기 → 새로 하기(fresh, 에이전트 답) → 30분 안 같은 문장은 다시 시켜 보기, 표 ↔ 그래프 다름, 같은 팀 제목 깊이 → 403 → 요청하기(자동 허락·원장) → 팀원 답·본 기록 → 회수 뒤 403, 비공개 맥락 후보 아님, 판별 사례 10 | `repeat.e2e.mjs` 11단계(확인 22) | 서버 | ✅ |
| 설정 › 정책 팀원 맥락 참고 셋(주제 칩·주인이 홈 카드에서)·원장 「주인 결정 대기」 승인 단추 없음, 홈 카드 정책·주제 줄·민감 표시 제안 카드·공유와 허락 고정 줄 둘, 「이미 한 요청」 카드(그 답 보기·요청하기·새로 하기 fresh) | F-TC-06…08 | feature | ✅ |
| 실제 턴: 라우터는 원래 메시지로 맥락을 고르고, 에이전트가 [1]·[2] 로 인용, 허락 뒤 다시 답하면 원문 내용 반영, 말만 바꾼 같은 요청 → 카드·그 답 보기, 같은 팀이 한 일 → 요청하기 → 그 답 | 영상 ①(녹화 중 단언) | — | ◐ |
| 실제 턴: 성과급 정리 → 요약 때 민감 제안 카드 → 같은 팀 원문 요청이 묻기 → 홈 카드 정책 줄 → 거절 → 민감 승인 → 원장 | 영상 ③(녹화 중 단언) | — | ◐ |

### 18. 후행 습관 — 결과물 뒤에 늘 시키는 일을 배워 먼저 묻기 (spec `pgpt-pro_followup-habits`, 영상 `l2urEzo6zko`)

| 요구사항 | 시험 | 단계 | |
|---|---|---|---|
| 슬라이드 → 후행 작업 2회 → 세 번째에 묻고, 네를 누르면 그 대화에서 실행(실제 에이전트) | A-FU-01 | agent | ✅ |
| 후행 작업 기록, 감사·내용 질문 제외, 다른 말로 같은 일 | `server/test/followups.e2e.mjs` 3·5·6 | HTTP | ✅ |
| 결과물에 대한 말은 그 대화의 에이전트로(라우터 우회, 「이미 한 요청」 제외) | `followups.e2e.mjs` 4, A-FU-01 | HTTP·agent | ✅ |
| 묻는 조건: 2회, 한 대화 한 번, 같은 종류, 후행 결과로는 안 물음 | `followups.e2e.mjs` 7·8·11, `followups-cases.json` | HTTP·단위 | ✅ |
| 카드: 질문, 세 버튼, 근거 한 줄 | F-FU-01 | feature | ✅ |
| 네·아니요·다시 묻지 않기, 연달아 3회 거절이면 끔(경계) | F-FU-02·03·04·05, `followups.test.js` | feature·단위 | ✅ |
| 말로 수락·사양·다른 말 | `followups.e2e.mjs` 10·12·13, `eval` answer | HTTP | ✅ |
| 직접 말한 습관(에이전트 없이), 예약·말투는 제외 | `followups.e2e.mjs` 18·19, `eval` explicit | HTTP | ✅ |
| 빠른 답도 화면 아래까지(수정 전 실패 확인) | F-FU-10 | feature | ✅ |
| 설정 › 습관: 끄기·켜기·지우기, 남의 것 404 | F-FU-05·06·07, `followups.e2e.mjs` 14·15·17 | feature·HTTP | ✅ |
| 모델이 못 읽으면 배우지 않고 규칙으로 묻기 | `followups.e2e.mjs` 20 | HTTP | ✅ |
| 판단 품질 하한(사례 260건) | `node scripts/eval-followups.mjs all test --check` | 측정 | ✅ |
| 물어봐도 되는가: 묻지 않아도 될 때 묻는 경우가 남음(test 85~88%, dev 67~75%) | `eval` fits | 측정 | ◐ |
| 영어 모드 | F-FU-09, `followups.test.js` | feature·단위 | ◐ (영어 모델 판단은 재지 않음) |
| 수락 뒤 이어지는 둘째 후행 작업, 메일 수신 같은 다른 사건, 자동 실행, 프로세스 승격 | — | — | ✗ |

### 19. 방 규칙 — 약속 한 번, 링크만 붙이면 내장 브라우저가 실행 (spec `pgpt-pro_room-rules`)

| 요구사항 | 시험 | 단계 | |
|---|---|---|---|
| 규칙을 말하면 에이전트 없이 기억, 규칙이 아닌 말 제외, 다른 말로 해도 규칙(실제 모델), 프로젝트 방에서만 | `server/test/room-rules.e2e.mjs` 1·2·3·8 | HTTP | ✅ |
| 링크만 붙이면 묻지 않고 내장 브라우저가 NotebookLM 에서 시작, 취소, 끄면 안 돈다, 사이트 일이 아니면 에이전트로 | `room-rules.e2e.mjs` 5·6·7·9 | HTTP | ✅ |
| 규칙 표시·끄기·없는 방·다른 사람 | F-RR-01·02·03·04 | feature | ✅ |
| 어떤 말을 모델에게 읽힐지, 링크·파일·덧붙인 말 나누기, 사이트 안내 | `room-rules.test.js`, `room-rules-cases.json` | 단위 | ✅ |
| 카드 먼저(계획이 느려도·실패해도·취소), 기다리기(동작 수 안 씀)·안 끝남·취소, 파일 받기·올리기, 진행 알리기 | `browser-long-work.test.js`(실제 Chromium, 작은 사이트) | 단위 | ✅ |
| 직접 제어로 로그인: 화면 전체, 보이는 자리 클릭, 입력 순서, 붙여넣기, 입력기 키, 로그 미기록, 돌려주기 | `takeover.e2e.mjs`(실제 화면) | HTTP·화면 | ✅ |
| 로그인 뒤 실제 NotebookLM: 소스·슬라이드·오디오 생성, 파일 카드 | 사람이 로그인한 프로필로 실행 | 수동 | ✗ 미확인 |

### 20. 회사 프로세스 지도 — 메일 이력 · 채팅 인계로 Ontological 에 프로세스 온톨로지, 스냅샷 실행, 고정 · 은퇴 (spec `pgpt-pro_process-ontology`, 설계 `pgpt-pro/docs/auto-ax-onboarding/design-v0.2.md` · `design-v0.3.md`, 영상 지도 `onto-map-ko`(glG1BW1LMb4) · 실행 `onto-run-ko`(ueqW6Hk1l80) · 검토 `onto-review-ko`(upi0oXxPWMI) · 역할과 습관 `onto-roles-ko`(EqtVqj_e_us) · 사건과 타이머 `onto-triggers-ko`(NsZcm2Z3i_k))

데모 테넌트 `ax-demo`(`node server/scripts/ax-demo.mjs --reset --seed`)에서 돈다: `PGPT_URL=http://ax.localhost:5191 API_URL=http://ax.localhost:8790 PGPT_TENANT=ax-demo PGPT_DB_URL=…`. F-PO 는 지도가 셈해진 뒤(S1) 돌고, 지도가 없으면 건너뛴다.

| 요구사항 | 시험 | 단계 | |
|---|---|---|---|
| 지난 메일 90일 깔때기(규칙 거르기 · 스레드마다 한 번 읽기 · 결과물 메일은 보낸 사람의 일 · 검토는 역할), 지도에는 문장 없음 | `server/test/ontology-map.e2e.mjs` 1~3 | HTTP | ✅ |
| 메일 보관함: 읽은 메일은 주인 몫으로 본문 · 첨부 목록까지, 다른 사람 404, 메일 이력 · 지도에 문장 없음, 다시 읽을 때 메일 서버 안 부름 | `ontology-archive.e2e.mjs`(S1b), `ontology-gmail.test.js` | HTTP·단위 | ✅ |
| 메일 본문 전체(인용 자르기) · 보낸 첨부의 양식 칸(늘 있는 칸) · Gmail(모의 서버) | `ontology-mailbody.test.js` · `ontology-gmail.test.js`, `ontology-map.e2e.mjs` 「메일에서 찾은 정해진 때」 | 단위·HTTP | ✅ |
| 정해진 때: 메일 날짜의 주기 + 메일이 말한 주기(반복되는 그 일에만), 건이 이끄는 일은 아님 → 시계 없는 타이머 사건 | `ontology-map.e2e.mjs` 「메일에서 찾은 정해진 때」, `ontology-mailbody.test.js` | HTTP·단위 | ✅ |
| 채팅 핸드오버와 메일 이력을 같은 건으로, 긴 지시문도 일 이름 하나로 | `ontology-map.e2e.mjs` 4·10 | HTTP | ✅ |
| 지도(일 · 관계 · 묶음) · 시점 고르기(주마다 다시 셈) | `ontology-map.e2e.mjs` 4·9, F-PO-01·03 | HTTP·feature | ✅ |
| 배운 조건(견적 합계 1천만 원, 하나씩 빼고 맞히기 > 늘 많은 쪽) | `ontology-map.e2e.mjs` 5, F-PO-02, `ontology-stats.test.js` | HTTP·feature·단위 | ✅ |
| 드문 경로는 θ 기본에서 빠지고 은퇴 후보가 아님, 은퇴 후보(조건부 포아송, 「최근 N일」) | `ontology-map.e2e.mjs` 6·7, F-PO-02, `ontology-cases.json` | HTTP·feature·단위 | ✅ |
| 자동 값(θ 재생 적합도 무릎 · 반감기 로그 우도 · 띠 1위 맞히기) | `ontology-map.e2e.mjs` 8, F-PO-01, `ontology-cases.json` | HTTP·feature·단위 | ✅ |
| 온보딩 요약 카드, 빈 그래프(서버가 도는 중 초기화 포함)는 오류가 아니라 빈 지도 | `ontology-map.e2e.mjs` 1·12 | HTTP | ✅ |
| 정답 대비 되찾음(데모 메일함의 정답 흐름) | `ontology-map.e2e.mjs` 11(재현율 0.99, 같은 이름 0.86) | 측정 | ✅ |
| 묶음 채택 · 일 정의 초안(메일의 양식 칸 → 점검 항목) · SKILL.md 형식 왕복 | `ontology-run.e2e.mjs` 1·2, F-PO-07 | HTTP·feature | ✅ |
| 시작 일(주 경로의 일마다 예/아니오) · 앞 일 건너뜀 · 스냅샷(요청 접수 맨 앞, 같은 키 다시 씀) | `ontology-run.e2e.mjs` 3·4, F-PO-04 | HTTP·feature | ✅ |
| 업무 에이전트가 양식대로 새 견적서 · 점검 항목마다 판단(rich text 칸 포함) · 엔진이 배운 조건으로 재무 검토 | `ontology-run.e2e.mjs` 5·6, `ontology-taskdef.test.js` | agent·단위 | ✅ |
| 검토 안건 · 은퇴(관리자만) · 지난 시점에는 살아 있음 · 앞날짜 고정 · 결정 원장 · 되돌리기 | `ontology-review.e2e.mjs` 1~6, F-PO-05·06 | HTTP·feature | ✅ |
| 화면: 지도 · θ · 값 보기 · 검토 안건 · 스냅샷 | F-PO-08 | feature | ✅ |
| 사건 · 프로세스 소속(한 일이 여러 프로세스에) · 역할(사람 · 지표, 정의 초안은 관리자만) | `ontology-map.e2e.mjs` 「사건 · 소속 · 역할」, F-PO-09·10, `ontology-structure.test.js` | HTTP·feature·단위 | ✅ |
| 개인 습관 → 역할 루틴, 공개 설정(관리자만, 이름 · 말 없이), 역할 정의 확정, 영업 4명 | `ontology-roles.e2e.mjs` 1~6, F-PO-11 | HTTP·feature | ✅ |
| 일의 방법 공유 → 실제 실행의 걸린 시간 → 가장 빠른 방법을 스킬로, 새 사람에게 회사가 고른 방법 | `ontology-roles.e2e.mjs` 7~10, F-PO-12 | agent·feature | ✅ |
| 승격 단계(관찰 · 제안 · 자동, 관리자만, 결정 원장), 제안 단계의 메일 · 채팅 제안 카드 | `ontology-triggers.e2e.mjs` 1~3, F-PO-13 | HTTP·feature | ✅ |
| 자동 단계의 사람 단계는 초안 모드(에이전트 초안이 먼저) | `ontology-run.e2e.mjs` 7 | agent | ✅ |
| 꼭 · 선택을 이벤트 → 태스크 간선에서 프로세스마다: 저장 · 다시 열기 · 이력 · 원장, 같은 태스크를 쓰는 다른 프로세스는 그대로, map 엔진이 실행 중에 바꾼 간선 · 중간 시작에도 따름(꼭이면 건너뛰기는 까닭만 물음) | `server/test/ontology-edgecond.e2e.mjs` 1~4(로컬 Lite, 19개), `ontology-edgecond.test.js` | HTTP·단위 | ✅ |
| 타이머 사건: 사람의 예약 → 역할 루틴 단계, 그래프에서 멈추면 실행 안 함, 회사 타이머(제안이면 묻고 자동이면 시작), 메일의 「예약 걸까요?」 | `ontology-triggers.e2e.mjs` 4~9, F-PO-14·15 | HTTP·feature | ✅ |
| 병목 보기: 일마다 할 일 = 지도 엔진 · 스냅샷 건의 todolist 행을 activity_id 로 센 수, 병목 = 할 일이 가장 많은 우리 쪽 사람 단계(에이전트 · 바깥 역할 제외) | `ontology-flow.e2e.mjs` S1, F-PO-16, `ontology-flowtime.test.js` | HTTP·feature·단위 | ✅ |
| 흔한 길(크리티컬 패스): 엔진처럼 매번 가장 흔한 길, 지난 건의 시간 · 지금 줄이 선 곳은 쌓인 것 치우는 시간(리틀의 법칙), 가장 긴 고리 = 병목, 시간 몫(기대 방문) | `ontology-flow.e2e.mjs` S2, F-PO-16·17, `ontology-flowtime.test.js` | HTTP·feature·단위 | ✅ |
| 회사의 제약: 모든 프로세스의 할 일을 역할로 · 한 사람당, 두 프로세스에 걸친 디자이너 | `ontology-flow.e2e.mjs` S3, `ontology-flowtime.test.js` | HTTP·단위 | ✅ |
| 실시간: 할 일에서 내면 지도 엔진이 다음 단계를 열고 할 일 수가 따라 움직임 · 관리자만 건 제목 · 지난 날짜는 그때 열린 것 | `ontology-flow.e2e.mjs` S4·S5, F-PO-16 | HTTP·feature | ✅ |
| 건 화면에서 내 단계 내기: 맡은 사람에게만 그 단계의 양식(runView `mine` — 사람 차례이고 todolist.user_id 쉼표 목록에 그 사람, 건의 주인 · 다른 사람에게는 없음), 루틴 탭(지도) › 진행 중인 루틴 · `/projects/p/<instId>` 에서 그 건의 인스턴스 화면(건의 BPMN · 목록 · 「내 입력이 필요해요」 — 2026-11-24 전에는 지도의 건 화면, 33 절)으로, 내면 지도 엔진이 다음 단계(제안서 작성)를 열고 목록에 보임(데모 출연진 김민지, 시드 다시 씀) | `ontology-case-submit.e2e.mjs` C1~C4, F-PO-18 | HTTP·feature | ✅ |
| `/improve` 넘기기(설계 `design-improve-on-map.md` §7 · 결정 4): 목록 → 지도의 병목 보기(`?view=flow`), 지도 프로세스의 스냅샷 정의 → 그 프로세스의 병목 보기(`GET /improve/:defId/map`), 지도에 없는 정의는 옛 개선 화면 그대로, 루틴 목록에는 「프로세스 지도 →」와 「클래식 개선 분석」(`?classic=1`, 그 안에서는 클래식에 머묾) | F-PO-18·19, `improve.spec.js` F-IM-01~07 | feature | ✅ |
| 고쳐 보기(what-if, 설계 §5): 지도의 수단(에이전트 · AI 초안 먼저 · 건너뛰기 · 빼기 · 나란히 · 다른 역할 · 사람 더하기 · 들어오는 건)을 얹으면 앞 · 뒤(지금 들어오면 · 보통 건 · 병목 할 일 · 역할 가동률 · 한 달 사람 시간), 앞 = 병목 보기의 흔한 길, 아무것도 쓰지 않음, 지도 꼬리표 「할 일 8 → n」, 규칙은 옛 what-if(얼랭 C · 같음 시험) | `ontology-improve.e2e.mjs` S6, F-PO-20·21, `ontology-flowplan.test.js` | HTTP·feature·단위 | ✅ |
| 개선안: 앞 · 뒤를 지닌 채 저장 · 나란히 · 합의에 올림(의견) · 같은 의견 · 상충(하는 이) · 관리자가 고르면 정함(고친 기록 한 묶음 · 역할 구성원 · 효력일 · 결정 원장), 관리자 아니면 403 | `ontology-improve.e2e.mjs` S7·S8, F-PO-20·21 | HTTP·feature | ✅ |
| 한 단계만 AI 초안 먼저(set_runner draft): 정한 뒤 지도 엔진이 그 단계를 초안 단계로 엶 · 말로 고치기 미리 보기의 예상 효과 | `ontology-improve.e2e.mjs` S9, `ontology-flowplan.test.js` | HTTP·단위 | ◐ 말로 고치기의 예상 효과는 모델이 필요해 회귀에 없음(손으로 · 영상으로 확인) |
| 시행 전후: 효력일 뒤 실행 기록으로 다시 재서 전 · 예상 · 실측 · 견준 말, 병목이 옮겨 가면 알림(시험용 `seed-flow-demo.mjs --after`) | `ontology-improve.e2e.mjs` S10, `ontology-flowplan.test.js` | HTTP·단위 | ✅ |
| 근무 시간에서 공휴일 · 회사의 쉬는 날(`PRO_HOLIDAYS`) 뺌 | `ontology-flowplan.test.js` | 단위 | ✅ |
| 루틴 탭(2026-11-19): 「루틴」 → 회사 프로세스 지도(지도 없는 회사는 루틴 목록), 지도 머리 「진행 중인 루틴 n」 → 목록에 Lite 건(지도에서 바로 도는 건은 인스턴스 화면 · 스냅샷 건은 지도의 건 화면으로 — 33 절)과 클래식 인스턴스(인스턴스 화면으로)가 꼬리표와 함께 · 「모두 · Lite · 클래식」 칩, 그냥 `/improve` 는 지도의 병목 보기 · 클래식 개선 분석은 목록의 링크로만 | F-PO-18 · 22 | feature | ✅ |
| 머리 단추 세 칸(2026-11-20): 보기 · 고치기 · 운영, 칸의 항목마다 한 줄 설명, 운영 칸 단추에 이 프로세스의 단계, 열린 패널의 칸이 칠해짐, 다시 누르기 · Esc · 바깥 누르기로 닫힘, 휴대폰 폭(390)에서 목록이 화면 안 | F-PO-23 | feature | ✅ |
| P5(정의 프로세스를 지도에 올리기 · 견주기에 시간 몫 · 튜토리얼 20~22장 다시 쓰기), 머리 숫자를 그래프 속성으로, 채팅의 개선 질문(improveTurn)을 지도 프로세스로 | — | — | ✗ 남은 것 |
| 습관(열린 일 프로세스에서 다음 일 묻기)이 굳은 길에서 실제로 묻는 장면, 실제 Gmail 메일함, 설치판 Ontological(소스 공개 결정 대기), 메일 보관함 보관 기간 · 연결 끊기 | — | — | ✗ |
### 21. ProcessGPT 포털에서 넘어온 휴대폰 — 데스크톱 화면으로 돌아가기 (process-gpt 스펙 `gateway_mobile-web-access`, 결정 D-1112-30)

ProcessGPT 포털의 설정 › 테마 설정 「휴대폰 화면」에서 「라이트 모드」를 고른 휴대폰은 같은 주소의 `/lite/`(이 앱)로 이동합니다. `/lite` 아래에서 열린 앱을 대상으로 실행해야 F-PT-03이 실행됩니다(`PGPT_URL=http://…/lite`). 그 밖의 설치 환경에서는 해당 항목이 없는지만 확인합니다.

| 기능 요건 | 근거 | 시험 | 단계 | |
|---|---|---|---|---|
| 설정 시트에 「Process GPT 데스크톱 화면으로」 줄은 `/lite` 아래에서 떴고 포털에서 라이트 모드로 넘어온 휴대폰(`mobileView=lite`)일 때만 보임 — 넘어온 휴대폰이 아니면 없음 | D-1112-30 (`SettingsSheet.vue`) | F-PT-01 | feature | ✅ |
| 따로 설치한 Lite(루트에서 뜸)에서는 `mobileView=lite` 가 남아 있어도 줄이 없음 | D-1112-30 | F-PT-02 | feature | ✅ |
| 줄을 누르면 포털 `/definition-map?mobileView=desktop` 으로 감(휴대폰 390×844) — 포털이 그 값을 받아 데스크톱 버전으로 바꾸는 것은 process-gpt-vue3 F-MV-20 | D-1112-30 | F-PT-03 | feature | ✅ |

### 17. 휴대폰 검토 11-21 — 홈 알림 카드 · 루틴 열기/닫기 · 지금 실행 · 텔레그램 (스펙 `phone-home-and-routine` · `scheduled-task-run-and-telegram`, 결정 D-1121-01~07, 영상 `mobile-review-1121-ko`)

390×844 휴대폰 화면, 손가락 밀기는 CDP 터치. F-MR-01~05 · 08 은 고치기 전 프런트(main 0d32fe9)에서 모두 실패하고 고친 뒤 통과한다(F-MR-02: 고치기 전 아래 카드가 왼쪽으로 105px 밀림). 텔레그램은 모의 Bot API(`scripts/mock-telegram.mjs`, `PRO_TELEGRAM_API`)로 본다.

| 기능 요건 | 근거 | 시험 | 단계 | |
|---|---|---|---|---|
| 알림 제목에 든 ```json · 긴 instance_id 가 카드에 안 보이고, 카드 · ✕ 가 화면 안, 홈 목록이 옆으로 스크롤되지 않음 | D-1121-01 | F-MR-01 · R-1121-01·02 | feature · 단위 | ✅ |
| ✕ 로 닫는 동안 아래 카드의 가로 위치가 그대로(±2px), 알림은 확인됨으로 저장 | D-1121-01 | F-MR-02 | feature | ✅ |
| 옆으로 짧게 밀면 제자리, 1/3 넘게 밀면 닫힘 | D-1121-01 | F-MR-03 | feature | ✅ |
| 홈 카드로 루틴을 열 때 응답이 느려도 메인 채팅이 비치지 않고 「루틴 여는 중…」, ‹ 로 닫으면 홈 | D-1121-02 | F-MR-04 | feature | ✅ |
| 없는 루틴은 사유 · 「다시 시도」 · 「닫기」, 주소로 바로 열면 ‹ 는 루틴 목록 | D-1121-02 | F-MR-05 | feature | ✅ |
| 넓은 표가 든 답도 말풍선이 휴대폰 폭 안(고치기 전 오른쪽 끝 440px), 표만 옆으로 스크롤 | D-1121-07 | F-MR-08 | feature | ✅ |
| 브라우저가 그린 뒤로 가기에는 앱 전환 효과를 겹치지 않음 | D-1121-02 | — (실기기 Chrome 만 hasUAVisualTransition 을 줌) | — | ✗ |
| 「곧바로 하나 정도 한번 실행해 봐」 → 새 예약 없이 그 작업을 manual 로 실행, 「지금 실행 · 이름」 칩 | D-1121-03 | F-MR-06 · R-1121-04·06 | feature · 단위 | ✅ |
| 「급등락이 감지되면 내 텔레그램 봇으로 알려줘」 → 작업 전달에 텔레그램, 봇 없으면 연결 카드, 스위치 API · 남의 작업 404 | D-1121-04 | F-MR-07 · R-1121-05 | feature · 단위 | ✅ |
| 서버가 텔레그램에 연결하지 못하면 503 + 이유(오류 코드 · 호스트, 토큰 없음)를 카드에 표시, 앞단이 HTML 오류 페이지(Cloudflare 502)를 돌려줘도 마크업 대신 「서버가 응답하지 못했어요 (502)」 — 서버는 `PRO_TELEGRAM_API` 를 아무도 듣지 않는 포트로 띄운다 | 운영 휴대폰 화면 11-23 | F-TG-01·02 · `telegram.test.js` | feature · 단위 | ✅ |
| 텔레그램 쓰는 법 질문 · 텔레그램 채널 새 예약은 가로채지 않음, 다른 실행 대상(프로세스 · 스크립트)은 「지금 실행」 아님, 짐작 코드만 빼고 단위(ETF · KST) 유지, 문장 속 JSON 은 안 자름 | 병합 전 검토 | R-1121-10~13 | 단위 | ✅ |
| 링크로 연 대화만 연결(이름으로 찾은 /start 는 안내) | D-1121-04 · 검토 | `telegram.test.js` | 단위 | ✅ |
| 텔레그램 연결 · 대화 연결 · 시험 메시지 · 긴 글 나눠 보내기 · 토큰 비노출 · 잘못된 토큰 · 차단 · 끊기 | D-1121-04 | `server/test/telegram.test.js` (9) | 단위(DB) | ✅ |
| 연결된 봇으로 예약 결과가 가고 실행 기록에 telegram sent | D-1121-04 | 영상 `mobile-review-1121-ko` 녹화 단언 | 녹화 | ◐ |
| 「어떻게 했나요」 — 단계 · 읽은 호스트 · 검색어, 명령 · 키는 안 보임 | D-1121-05 | R-1121-07 | 단위 | ✅ |
| 주가 요청에 공개 시세 출처 · 종목 찾기 안내, 예약 지시의 짐작한 코드 제거 | D-1121-06 | R-1121-08·09 | 단위 | ✅ |
| `**굵게**` 뒤 한국어 조사 | D-1121-06 | R-1121-03 | 단위 | ✅ |

## 단계별 시험 수

| 단계 | 파일 | 시험 수 |
|---|---|---|
| smoke | `tests/smoke/*.spec.js` (6개) | 74 |
| feature | `tests/feature/*.spec.js` (31개) | 201 (프로세스 지도 F-PO-01…23, 방 규칙 F-RR-01…04, 후행 습관 F-FU-01…10, 서버 단위 시험 4묶음 포함, 회의 F-MT-01…08, 팀 맥락 공유 F-TC-01…10, 포털에서 넘어온 휴대폰 F-PT-01…03, 대화 속 그림 · 소리 · 영상 F-MP-01…08) |
| agent | `tests/agent/*.spec.js` (14개) | 33 (회의 A-14, 후행 습관 A-FU-01) |
| 합계 | | 308 (`npx playwright test --list` 로 센 2026-11-20 의 300 + F-MP-01…08) |

openspec 명세 13개의 요구사항 112개: 덮음 73 · 일부 20 · 공백 19. 명세 밖의 기능 요건(영상·최근 추가 기능: 대화 목록·산출물 스택·로봇 버튼·끊김 복구·유휴 타임아웃·DB 풀·멘션·예약·설치 번들 등) 31개: 덮음 27 · 일부 1 · 공백 3.


### 18. 휴대폰 녹화 11-21 — NotebookLM 방 규칙 · 브라우저 스킬 · 멈춘 이유와 할 일 (스펙 `room-rules` · `browser-handoff` · `project-room` · `office-mobile`, 결정 D-1121-08~11)

모델 판정은 가짜 판정 서버(`PRO_JUDGE_URL`)로 모델 없이 보고, 실제 사내 모델 확인은 `server/test/room-rules.e2e.mjs` · `browser-walls.live.mjs` 로 따로. 증거 표는 `openspec/specs/room-rules/e2e/README.md`.

| 기능 요건 | 근거 | 시험 | 단계 | |
|---|---|---|---|---|
| 프로젝트 방의 말은 다른 지름길보다 먼저 방 판정(set_rule · run_rule · other, 0.7), 규칙은 안내 메시지에 | D-1121-08 | `room-rules.test.js` · `browser-replaces-turn.test.js` | 단위 | ✅ |
| 규칙 막대 · 끄기 · 다른 사람은 못 봄 | D-1121-08 | F-RR-01~04 · F-NB-06 | feature | ✅ |
| 사이트 지식은 `skills/<이름>/SKILL.md`, 본문은 read_skill 로만(시스템 프롬프트에 없음) | D-1121-08 | `browser-long-work.test.js` · `browser-walls.e2e.mjs` | 단위 · e2e | ✅ |
| 막힌 화면은 새 페이지마다 판정 → 로그인 필요면 모델 턴 없이 「로그인 필요 · <사이트>」 · 「직접 로그인」 | D-1121-10 | `browser-walls.e2e.mjs` · F-NB-01·02 | e2e · feature | ✅ |
| 누르는 자리 물결 · 요소 이름 알약 · 새 탭 따라가기 · 헛돎 5턴 · 프로필 /data · 잠금 정리 | D-1121-10 | `browser-walls.e2e.mjs` · F-NB-03 | e2e · feature | ✅ |
| 바로잡는 말이면(판정 0.7) 앞 작업을 멈추고 이유, 규칙 실행은 아무것도 대신하지 않음, 앞 첨부는 따라가지 않음 | D-1121-09 | `browser-replaces-turn.test.js` | 단위 | ✅ |
| 새 프로젝트 즉시 응답 · 실패 시 글 돌려주기 · 소리 파일 플레이어 | D-1121-09·10 | `new-project-fast.test.js` · F-NB-04·05 | 단위 · feature | ✅ |
| 휴대폰에서 접힌 리본은 탭 줄도 숨김 · PPT 폭 맞춤 · ‹ › | D-1121-11 | F-OM-01~04 | feature | ✅ |
| 운영에서 사람이 직접 로그인한 뒤 NotebookLM 슬라이드 · 오디오가 끝까지 만들어져 카드로 옴 | D-1121-10 | — (사람의 구글 로그인 필요) | — | ✗ |
### 22. 휴대폰 11-23 — 메일 카드 원문 · 답장 초안 · 직접 보내기, 팀원 메시지의 보낸 사람, Home 카드 닫기 (스펙 `mail-reply-review` · `phone-home-and-routine`, 결정 D-1123-02·03·04)

390×844 휴대폰 화면. 메일 시험(F-ML)의 서버는 가짜 모델로 띄운다: `PRO_LLM_BASE_URL=http://127.0.0.1:59998/v1`(시험 파일이 그 포트에 가짜 모델을 띄움, 포트는 `RT_FAKE_LLM_PORT`). 메일함은 데모 메일함이다.

| 기능 요건 | 근거 | 시험 | 단계 | |
|---|---|---|---|---|
| 메일 카드를 누르면 원문(보낸 사람 · 본문)과 답장 초안이 열리고 에이전트 실행 · 발송이 없음, 받는 사람은 원문의 보낸 사람(카드 지시의 내 주소가 아님), 초안은 카드에 남음 | D-1123-02 | F-ML-01 | feature | ✅ |
| 초안을 고쳐 「보내기」를 눌러야 보냄, 카드가 Home 에서 사라지고 채팅에 「…에게 답장 「제목」을 보냈어요.」 | D-1123-02 | F-ML-02 | feature | ✅ |
| 답장이 할 일이 아닌 메일 카드(Review)는 원문만, 「답장도 쓰기」 · 「에이전트에게 맡기기」를 눌러야 시작(32 의 `mail-card-actions`) | D-1123-02 | F-ML-03 | feature | ✅ |
| 이전 화면의 `POST /api/actions/:id/run` 은 409 `reply_in_card`, 카드 그대로 | D-1123-02 | F-ML-04 | feature | ✅ |
| 메일이 메일함에 없으면 이유가 보이고, 답장이 일이 아닌 카드는 「에이전트에게 맡기기」 | D-1123-02 · 검토 | F-ML-05 | feature | ✅ |
| 올리지 못한 첨부가 있으면 「보내기」를 막고 안내, 빼면 보냄 | D-1123-02 · 검토 | F-ML-06 | feature | ✅ |
| 고친 초안에서 「다시 쓰기」는 한 번 더 눌러야 새로 씀 | D-1123-02 · 검토 | F-ML-07 | feature | ✅ |
| Gmail 같은 스레드(In-Reply-To · References · threadId) · 초안 파일 첨부(카드 주소의 호스트로는 가지 않고 저장소 키로) · 두 번 못 보냄(동시에 두 번 눌러도 한 번) · 보내다 실패하면 카드가 남음 · 보내기 권한 없으면 403 · 남의 파일 · 폴더 밖 경로(`../`) · 11개 이상 400 · 메일함 확인은 연결한 회사에서(고치기 전 `localhost`) | D-1123-02 | `server/test/mailReply.integration.test.js` | 단위 | ✅ |
| 팀원 메시지 카드에 보낸 사람(알림에 없으면 방의 같은 글을 쓴 사람), 1:1 방 이름은 되풀이하지 않음, 단체 방은 방 이름도 | D-1123-03 | F-MS-01 · 02 · `server/test/noticeSender.integration.test.js` | feature · 단위 | ✅ |
| Home 의 메일 · 업무 카드도 닫음: 휴대폰에서 ✕ 늘 보임, 밀어서 닫기(여는 누름 아님), 업무는 새로 열어도 Home 에 없고 루틴 「내 입력이 필요해요」에 남음, 메일은 받은 편지함 › 메일에서 다시 열기, 워크아이템 알림을 닫으면 「Submit」 카드로 안 돌아옴 | D-1123-04 | F-HD-01~03 · `server/test/homeCards.integration.test.js` | feature · 단위 | ✅ |
| 실제 Gmail 로 보내기 · IMAP 임시 보관함 | D-1123-02 | — (Gmail 은 가짜 fetch 로 요청 모양만 확인) | — | ◐ |

### 23. 운영 화면 11-23 — 공유 폴더 파일을 붙이지 않아도 찾고, 채팅에서 이음오피스로 바로 열기 (스펙 `folder-find-open`, 결정 D-1123-05)

에이전트 없이: 서버 시험은 `folder_*` 도구를 직접 부르고, 화면 시험은 보내기를 가로채고 파일 카드를 실시간 이벤트로 넣는다.

| 기능 요건 | 근거 | 시험 | 단계 | |
|---|---|---|---|---|
| 폴더를 붙이지 않아도 구성원인 모든 폴더에서 낱말마다 따로 찾고, 많이 맞은 파일부터(「장진영 이력서」 → `이력서/장진영_프로필.docx`) | D-1123-05 | `server/test/folderFindOpen.test.js` | 단위 | ✅ |
| 맞는 이름이 없으면 쓸 수 있는 폴더 전체를 돌려 에이전트가 고름 | D-1123-05 | `server/test/folderFindOpen.test.js` | 단위 | ✅ |
| docx · pptx · xlsx · hwpx 본문을 unzip 없이 읽음, `folder_read` 가 본문을 돌려줌, 예전에 못 읽은 문서는 시작할 때 다시 | D-1123-05 | `server/test/folderFindOpen.test.js` | 단위 | ✅ |
| `folder_open` → 파일 카드(open), 같은 판은 같은 사본, 구성원이 아니면 못 엶, 이름이 여러 폴더에 걸리면 고르게 함, 큰 압축 문서는 풀지 않음 | D-1123-05 | `server/test/folderFindOpen.test.js` | 단위 | ✅ |
| 말을 보낸 화면은 카드가 오자마자 이음오피스를 엶 · 다른 기기 · 다른 대화의 카드는 열지 않음 · 만들어 준 문서는 눌러야 열림 | D-1123-05 | F-FO-01~04 | feature | ✅ |
| 실제 에이전트가 「장진영 이력서를 열어줘」에 `folder_catalog` → `folder_open` 을 고름 | D-1123-05 | — (운영 확인) | — | ◐ |

### 24. 휴대폰 녹화 11-24 — 공유 폴더 문서를 이음오피스에서 고치면 폴더에 저장, 열리는 동안 안내 (스펙 `folder-edit-save`, 결정 D-1124-01)

실제 이음오피스 호스트가 있어야 한다. 개발 서버의 `/office`를 `PRO_OFFICE_TARGET`으로 넘기고, 운영 이미지 ecea940을 로컬 컨테이너로 띄워 시험했다. 띄우는 명령은 `openspec/specs/folder-edit-save/e2e/README.md`에 있다.

| 기능 요건 | 근거 | 시험 | 단계 | |
|---|---|---|---|---|
| 편집자는 편집으로 열고, 손을 멈추면 폴더 main에 저장해 이력에 남김 | D-1124-01 | F-FE-01 | feature | ✅ |
| 고치고 바로 닫아도 닫기 전에 저장, 다시 열면 그대로 | D-1124-01 | F-FE-02 | feature | ✅ |
| 한 번 연 편집은 이력 한 줄(같은 세션은 접음, 가지가 서 있으면 접지 않음, 내용이 같으면 커밋 없음) | D-1124-01 | F-FE-03 · `server/test/folderEditSave.test.js` | feature · 단위 | ✅ |
| 연 뒤 다른 사람이 먼저 고쳤으면 「(이름 수정본)」으로 옆에, 번호 | D-1124-01 | F-FE-04 · `server/test/folderEditSave.test.js` | feature · 단위 | ✅ |
| 보기 권한은 휴대폰에서도 「보기 전용」, 입력하면 안내, 폴더 그대로 | D-1124-01 | F-FE-05 | feature | ✅ |
| 휴대폰 폭: 「자동 저장」 → 「고치는 중」, 닫으면 저장 | D-1124-01 | F-FE-06 | feature | ✅ |
| 채팅의 `folder_open` 카드 문서도 폴더에 저장, 카드가 새 버전을 기준으로 | D-1124-01 | F-FE-07 · `server/test/folderEditSave.test.js` | feature · 단위 | ✅ |
| 편집기가 그려질 때까지 「문서를 여는 중…」, 3초 넘으면 까닭 | D-1124-01 | F-FE-08 | feature | ✅ |
| 그 폴더의 편집본만 받음(다른 폴더 · 원래 사본 · 하위 경로 · 형식 거절), 그 편집의 커밋엔 그 파일만, 지운 파일은 수정본, 모두 되돌리면 이력 줄 없음 | D-1124-01 | `server/test/folderEditSave.test.js` | 단위 | ✅ |
| 보기 권한인 사람이 채팅 카드로 연 폴더 문서는 보기 전용(저장 오류 되풀이 없음) | D-1124-01 | F-FE-09 · `server/test/folderEditSave.test.js` | feature · 단위 | ✅ |
| 고치는 중에 다른 카드를 눌러도 먼저 폴더에 저장 | D-1124-01 | F-FE-10 | feature | ✅ |
| 엑셀 · PPT · 한글을 실제 화면에서 고쳐 저장 | D-1124-01 | — (저장 방법은 운영 이미지로 실측, 화면 시험은 워드만) | — | ◐ |
| 운영 휴대폰에서 이력서를 고치고 닫은 뒤 폴더 이력 확인 | D-1124-01 | — (반영 뒤) | — | ✗ |

### 25. 운영 화면 11-24 — 채팅의 메일 칩, 메일로 인스턴스를 시작하거나 잇기 (스펙 `mail-thread-flow`, 설계 `docs/mail-thread-flow/design.md`)

서버는 가짜 모델(`PRO_LLM_BASE_URL=http://127.0.0.1:59998/v1`)로 띄우고, 지도 엔진은 끈다(`PRO_ONTOLOGY_BOLT_URL=`). 가짜 모델은 시험 파일이 띄우며 같은 포트를 쓰므로 F-ML 과 동시에 돌리지 않는다. 메일함은 데모 메일함이고, 지도의 읽기는 카드에 남은 결과를 쓴다. 띄우는 명령은 `openspec/specs/mail-thread-flow/e2e/README.md`에 있다.

| 기능 요건 | 근거 | 시험 | 단계 | |
|---|---|---|---|---|
| 「모닝 브리프」 요약 아래 메일 카드마다 칩 → 원문 · 답장 시트 → 「Home 카드로」 누르면 그 카드가 빛남(PC · 휴대폰) | 사용자 11-24 | F-MT-01 · 02 · `server/test/mailFlow.integration.test.js` | feature · 단위 | ✅ |
| 시트가 「이 메일은 ‘…’의 시작으로 보여요 — 진행할까요?」라고 물음: 새로 시작 · 진행 중인 …에 잇기(판정 모델 · 같은 일 %) · 이번엔 안 해요. Home 카드에도 한 줄, 관찰 단계는 권하지 않음, 연다고 시작되지 않음 | 사용자 11-24 | F-MT-03 · 05 · `mailFlow.integration` | feature · 단위 | ✅ |
| 잇기 → `/routines/<instId>`, 메일이 인스턴스 대화의 사건, 메인 채팅엔 없음, Home 카드 · 브리프 칩이 「루틴 · …」, 거기서 보낸 답장은 인스턴스에 | 11-18 결정 | F-MT-04 · 05 · `mailFlow.integration` | feature · 단위 | ✅ |
| 새로 시작: 지도가 읽은 프로세스만, 메일이 건의 요청, 두 번 안 됨(409), 실패하면 이유 · 카드는 묶이지 않음 | 사용자 11-24 | F-MT-06 · 07(시작 응답만 대역) · `mailFlow.integration`(시작은 대역) | feature · 단위 | ✅ |
| 같은 Gmail 스레드의 새 메일은 모델 없이 진행 중인 인스턴스로(인스턴스 대화 · 「메일이 이어졌어요」 알림), 끝난 인스턴스로는 아님 | 사용자 11-24 | `mailFlow.integration`(가짜 Gmail 로 두 번 수집) | 단위 | ✅ |
| 자동 단계 프로세스는 메일로 저절로 시작해 인스턴스 대화 · Home 알림으로만, 제안 단계는 카드의 시트에서 물음 | 11-18 결정 | `mailFlow.integration` | 단위 | ✅ |
| 실제 지도 엔진(Ontological)으로 지도를 읽고 시작하기 | — | — (로컬 엔진이 꺼져 있었음) | — | ◐ |

### 26. 일의 작업 폴더 — 메일과 단계 결과가 한곳에, 들어올 때 지도와 견주기 (스펙 `mail-work-folder`, 설계 `docs/mail-work-folder/design.md`)

25 와 같은 서버(가짜 모델 59998, 지도 엔진 끔)에 `PRO_FOLDERS_ROOT=<임시 폴더>`를 더해 띄운다. 시험 프로세스에도 같은 `PRO_FOLDERS_ROOT`를 준다(F-MW-04 가 서버 모듈을 직접 부른다). 띄우는 명령은 `openspec/specs/mail-work-folder/e2e/README.md`에 있다. 25 의 잇기 시험(F-MT-04 · 05)도 이제 작업 폴더를 만들므로 정리에서 지운다.

| 기능 요건 | 근거 | 시험 | 단계 | |
|---|---|---|---|---|
| 메일로 시작하거나 메일을 이은 일에 작업 폴더 하나(주인은 메일 주인, 이름은 인스턴스, 역할을 맡은 동료는 보기), 첫 메일은 `메일/01_<날짜>_<제목>.eml` · `.md`, 그 사람의 커밋 | 사용자 11-24 | F-MW-01 · `server/test/mailWork.integration.test.js` | feature · 단위 | ✅ |
| 인스턴스 화면의 「작업 폴더」(메일 N통 · 단계 결과 N개) → 폴더, 폴더 머리의 「작업 폴더」 · 「루틴 · …」, 인스턴스 대화에 폴더 칩(메인 채팅엔 없음) | 11-18 결정 | F-MW-01 · 02(휴대폰, 옆으로 넘치지 않음) | feature | ✅ |
| 다음 메일을 이으면(잇기 · 같은 Gmail 스레드) `메일/02_…`, 같은 메일은 두 번 안 들어감, 첨부는 `메일/NN_첨부/`, Gmail 원문 그대로 | 사용자 11-24 | F-MW-03 · `mailWork.integration`(가짜 Gmail) | feature · 단위 | ✅ |
| 메일 시트의 「작업 폴더 · …」, 폴더 목록의 「작업 폴더」 표시 | — | F-MW-03 | feature | ✅ |
| 끝난 단계의 파일 · 값은 인스턴스 라인 `inst/<id>`의 `산출물/NN_<단계>/`(main 은 반영 전까지 그대로), 뒤에 온 메일도 라인에, 다음 단계는 메일과 결과를 읽음(`stepContext` · doc-draft 의 `work`) | 사용자 11-24 | F-MW-04 · `mailWork.integration` | feature · 단위 | ✅ |
| 카드가 생긴 메일은 들어올 때 지도와 견줌(문서 요청이 아니어도): 자동은 저절로 시작, 제안은 카드가 묻고 시트는 다시 읽지 않음, 관찰은 아무것도 안 함, 같은 스레드의 다음 메일은 새 건을 만들지 않음, 진행 중인 같은 일(판정 모델)이면 자동이라도 시작하지 않음 | 사용자 11-24 | `mailWork.integration`(지도의 읽기 · 시작 · 판정은 대역) | 단위 | ✅ |
| 다른 엔진(deepagents · cli-agent)의 단계는 그 폴더의 인스턴스 라인부터, deepagents 단계의 체크아웃은 Storage 를 오가고 다른 파드가 남긴 고침 · 새 파일 · 지움이 커밋에 | 운영 공백 | `mailWork.integration`(로컬 Storage) | 단위 | ✅ |
| 실제 지도 엔진으로 들어온 메일을 읽고 자동 시작 · 첫 단계까지 | — | — (로컬 엔진이 꺼져 있었음) | — | ◐ |
| 운영 deepagents 가 엔진 단계의 방을 Storage 에서 받기 | — | — (deepagents 쪽 변경 필요 — 설계 §6) | — | ✗ |

### 27. 링크 미리보기 — 메시지의 링크를 카드로 (스펙 `link-preview`)

시험 파일이 로컬 가짜 사이트(`127.0.0.1:59981`, `RT_LP_SITE_PORT`)를 띄운다. 서버는 그 한 곳만 읽도록 `PRO_LINK_PREVIEW_ALLOW_HOSTS=127.0.0.1:59981`로 띄운다(시험에서만 쓰고, 게이트웨이 뒤에서는 무시된다). 공용 인터넷에는 나가지 않는다. 사이트 포트가 이 파일의 것이라 한 워커로 돈다(`mode: 'serial'`). F-LP-04 는 회사(`localhost`)의 스위치를 잠깐 껐다 켜고, 끝나면 행을 지운다. 띄우는 명령은 `openspec/specs/link-preview/e2e/README.md`에 있다.

| 기능 요건 | 근거 | 시험 | 단계 | |
|---|---|---|---|---|
| 채팅의 내 말 · 에이전트 답의 링크 아래 카드(그림 · 제목 · 두 줄 설명 · 사이트 · 도메인), 넓은 그림은 위에, 누르면 새 탭(opener 없음), 낮 · 밤 테마 | 사용자 11-24 | F-LP-01 | feature | ✅ |
| 동영상(og:type video · YouTube)은 썸네일과 재생 표시, YouTube 는 페이지를 못 읽어도 썸네일 | 사용자 11-24 | F-LP-01 · `server/test/linkPreview.test.js` | feature · 단위 | ✅ |
| 코드 안 · 서명 링크는 카드 없음, 링크 없는 메시지는 그대로, 읽는 동안 뼈대 | 사용자 11-24 | F-LP-01 | feature | ✅ |
| 카드를 다는 링크: 처음 세 개 · 같은 링크는 하나 · 코드 안 · 이 앱 · 파일은 빼고, 주소에 붙여 쓴 한국어는 떼기 | 사용자 11-24 | F-LP-05(브라우저 없이) | feature | ✅ |
| 팀 메신저: 동료 메시지의 카드는 왼쪽, 내 메시지의 카드는 오른쪽 | 사용자 11-24 | F-LP-02 | feature | ✅ |
| 휴대폰(390px): 카드는 세 개까지, 화면 너비 안(채팅 탭 · 팀 메시지), 작은 그림은 왼쪽, 그림 없는 카드 | 사용자 11-24 | F-LP-03 | feature | ✅ |
| 서버: 서명 · 사설 · 클러스터 · 허락하지 않은 포트 · ftp 는 읽지 않음(사이트에 요청 없음), 로그인 필요(401), 주소 없음 400 | SSRF | F-LP-04 · `linkPreview.test.js` | feature · 단위 | ✅ |
| 이름이 사설 IP 로 풀림 · 공개와 섞임 · 사설로 넘겨주기 · 넘겨주기 4번 · 512KB 넘는 본문 · gzip 폭탄 · HTML 아님 · 5초 · 확인한 IP 로만 연결 | SSRF | `linkPreview.test.js`(가짜 사이트 · DNS 대역) | 단위 | ✅ |
| 하루 기억(실패는 30분) · 회사마다 따로 · 동시에 물어도 한 번 · 한 사람 1분 한도(429) | — | `linkPreview.test.js` | 단위 | ✅ |
| 회사 관리자 스위치(설정 › 시스템 설정): 관리자 아니면 403, 끄면 카드 · 읽기 없음(기억한 카드도 지움), 다시 켜면 보임 | 사용자 11-24 | F-LP-04 · `server/test/linkPreview.integration.test.js` | feature · 단위 | ✅ |
| 실제 공개 사이트(YouTube · 뉴스 등)의 카드 | — | — (시험은 공용 인터넷에 나가지 않음) | — | ◐ |

### 28. 운영 화면 11-24 — 메신저에 컴퓨터의 파일 끌어다 놓기 · 들어온 문서를 폴더에 정리 (스펙 `messenger-drop-folder`)

서버는 가짜 모델(`PRO_LLM_BASE_URL=http://127.0.0.1:<RT_FAKE_LLM_PORT, 기본 59998>/v1`)로 띄운다. 시험 파일이 그 포트에 보기 글자의 확률을 돌려주는 가짜 판정 모델을 띄우며, 같은 포트를 쓰는 F-ML · F-MT · F-MW 와 동시에 돌리지 않는다. 띄우는 명령은 `openspec/specs/messenger-drop-folder/e2e/README.md`에 있다. 끌어다 놓기는 Playwright 의 DataTransfer 끌기 이벤트(`dragenter` · `dragover` · `drop`)로 시험한다.

| 기능 요건 | 근거 | 시험 | 단계 | |
|---|---|---|---|---|
| 열린 대화에 놓으면 「여기에 놓으면 보내요」 → 진행 칩 → 보내면 받는 사람이 같은 바이트를 받음, 보낸 사람의 메인 채팅엔 아무것도 없음 | 사용자 11-24 | F-MD-01 · `server/test/filing.integration.test.js` | feature · 단위 | ✅ |
| 메신저 위의 놓기를 채팅 입력창이 가져가지 않음(대화가 없으면 아무것도 안 함), 닫으면 채팅 전체 놓기 그대로 | 사용자 11-24 | F-MD-02 | feature | ✅ |
| 받은 파일 · 채팅의 파일 카드에 「‘견적서/2026’에 정리할까요? (확신 N%)」 → 정리 → 폴더 main 에 내 이름의 커밋 · 「정리했어요 · 열기」 → 폴더에서 그 파일 · 이력, 맞는 폴더가 없으면 「새 폴더 만들기」 | 사용자 11-24 | F-MD-03 · `filing.integration` | feature · 단위 | ✅ |
| 판정은 카드마다 한 번(다시 열어도 판정 모델을 부르지 않음), 남의 카드 404 · 보기 권한 폴더 403 · 고르기 목록에 없음 | 사용자 11-24 | F-MD-03 · `filing.integration` | feature · 단위 | ✅ |
| 휴대폰: 「내 컴퓨터에서」 · 붙여 넣기 · 파일마다 한 줄 · 「다른 폴더 고르기」 · 옆으로 넘치지 않음 | 사용자 11-24 | F-MD-04 | feature | ✅ |
| 파일 50MB(413) · 빈 파일 400 · 남의 카드는 보낼 수 없음 · `.json` 파일도 바이트 그대로 | — | F-MD-05 · `filing.integration` | feature · 단위 | ✅ |
| 후보: 편집 이상 관리형만(보기 · 실행 · 연결형 · 스킬 아님), 일의 작업 폴더는 그 일의 문서만, 첫 글자 확률 → 하위 폴더, JSON 대체, 같은 내용은 다시 안 넣음, 같은 이름은 (2), 메일 첨부 | 사용자 11-24 | `filing.integration` | 단위 | ✅ |
| 실제 메일함(Gmail · IMAP)의 첨부를 메일 시트에서 정리 | — | — (데모 메일함엔 첨부가 없음 · 서버 시험은 메일 원문을 대역으로) | — | ◐ |
| 워크트리 테이블이 있는 DB(운영)에서 받은 사람의 브랜치 카드로 판정 · 정리 | — | — (로컬 DB 에 `artifact_branches` 없음 — 사본 길만 실측) | — | ◐ |

### 29. 운영 화면 11-24 — 메신저에서 누른 문서가 어느 화면에서든 열리고, 메신저를 붙여 두고 일하기 (스펙 `messenger-dock`)

Vite 개발 서버에 대고 돌린다. 회사 프로세스 지도는 개발 서버의 가짜 응답(`/process-map?mock=1`)으로 띄운다. 받은 사람 쪽 폴더 추천은 시험 파일이 `RT_FAKE_LLM_PORT`(기본 59998)에 띄운 가짜 판정 모델이 답한다. 같은 포트를 쓰는 F-MD · F-ML · F-MT · F-MW 와 동시에 돌리지 않는다(`mode: 'serial'`, `RT_WORKERS=1`). 문서 패널의 이음오피스 화면까지 보려면 이음오피스 호스트를 띄운다(없어도 패널 · 편집기 주소 검사는 통과). 띄우는 명령은 `openspec/specs/messenger-dock/e2e/README.md`에 있다. 머리 끌기는 Playwright 의 마우스(`down` · `move` · `up`)로, 너비는 마우스와 ←/→로 시험한다.

| 기능 요건 | 근거 | 시험 | 단계 | |
|---|---|---|---|---|
| 지도 · 폴더 화면에서 메신저의 PDF · 워드 칩 → 그 화면 그대로 문서 패널(이음오피스 `pdf` · `docs`), 보낸 사람은 원본 · 받은 사람은 사본, 받은 편지함 「편집기에서 열기」, 떠 있는 메신저는 비켜 줌 | 사용자 11-24 | F-MO-01 · `server/test/openPlan.test.js` | feature · 단위 | ✅ |
| 볼 수 없는 형식은 파일 아래에 이유와 「새 창에서 열기」(11-25 부터 경고가 아니라 차분한 안내), 메신저는 그대로, 열린 문서를 못 바꾸면 그 까닭 | 사용자 11-24 · 11-25 | F-MO-07 · 46절 F-MP-04 · `openPlan.test.js` | feature · 단위 | ✅ |
| 머리를 끌면 왼쪽 · 문서 패널 · 오른쪽 자리, 가운데는 떠 있기 · 위치 단추 메뉴 | 사용자 11-24 | F-MO-02 · 03 · 08 · `server/test/messengerDock.test.js` | feature · 단위 | ✅ |
| 붙여 두면 가림막 없음: 위쪽 막대로 채팅에 가도 그 자리, 채팅 입력, 메신저에서 연 문서는 옆에(메신저 안 닫힘), Esc 로 안 닫힘, 닫으면 페이지 전체 | 사용자 11-24 | F-MO-02 | feature | ✅ |
| 문서 패널에 넣기: 문서 패널 안 문서 오른쪽(페이지는 문서만 열렸을 때와 같은 폭), 문서가 없거나 닫으면 오른쪽 열 | 사용자 11-24 | F-MO-03 · `messengerDock.test.js` | feature · 단위 | ✅ |
| 너비(마우스 · ←/→, 320–720) · 자리가 새로 고침 뒤에도 그대로(기기에 남김, 저장소가 막혀도 기본값) · 1000px 아래 창은 떠 있기 | 사용자 11-24 | F-MO-04 · `messengerDock.test.js` | feature · 단위 | ✅ |
| 390px: 위치 단추 · 너비 손잡이 없음(붙인 자리가 남아 있어도 전체 화면 시트), 옆으로 넘치지 않음, PDF 열림 | 사용자 11-24 | F-MO-05 | feature | ✅ |
| 붙여 둔 메신저에 끌어다 놓아 보내기(받는 사람이 받음, 채팅 입력창은 안 가져감), 옆 채팅 화면에 놓으면 채팅에 첨부 | PR #31 | F-MO-06 | feature | ✅ |
| 밤 테마: 끄는 자리 상자 · 패널 안 메신저 | 사용자 11-24 | F-MO-08 | feature | ✅ |
| 데스크톱 앱: 붙인 열 · 머리가 창 이동 띠가 아님(`no-drag`), 왼쪽 열은 신호등 아래(44px), 메신저의 PDF 는 패널 · zip 링크는 시스템 브라우저 | 사용자 11-24 | — (Electron 으로 따로 실측, 스펙 e2e README) | — | ◐ |
| 받은 사람별 고친 파일 줄 · 폴더 「열기」 · 「이어서 작업」 뒤에도 붙인 메신저가 남음 | — | — (로컬 DB 에 워크트리 테이블 없음 · 코드 검토만) | — | ◐ |
| Windows · Linux 데스크톱 앱의 오른쪽 창 단추 피하기 | — | — (macOS 에서만 실측) | — | ✗ |

### 30. 프로세스 단계를 담당자 컴퓨터의 Claude Code · Codex 로(그 사람의 대화형 CLI 를 터미널에서) — 사람과 기기를 넘나드는 협업(같은 터미널 보기 · 제안 · 입력은 CLI 를 가진 사람만), 서버의 스킬, 로컬 노하우 모으기 (스펙 `local-agents`, 설계 `docs/local-agents/design.md`)

세 Playwright 파일은 자기 스택(BFF `PRO_BACKGROUND=0` + Vite, 빈 포트, 회사 `localagent-ui` · `localagent-mobile` · `localagent-collab`)을 스스로 띄우고 지운다(`e2e/lib/localStack.js`). 사람 이름은 지어낸 것이다. CLI 는 가짜 — 터미널(주 길)은 `desktop/test/fixtures/fake-tui.js`(raw 입력 · 붙여 넣기 · Claude Code 의 훅과 기록 · Codex rollout), 헤드리스(예비 길)는 `fake-cli.js`. 모델은 부르지 않는다. 실제 `claude` · `codex` 는 `server/test/localAgents.smoke.mjs` 로 따로(사람의 구독, 또는 회사 모델 게이트웨이). 명령은 `openspec/specs/local-agents/e2e/README.md`.

| 기능 요건 | 근거 | 시험 | 단계 | |
|---|---|---|---|---|
| 데스크톱 앱에서 로그인하면 이 컴퓨터를 저절로 잇고(토큰은 페이지 저장소에 없음), 설정에 「이 컴퓨터 · 연결됨」 · CLI 버전 · 로그인 | 사용자 11-24 | L-01 | desktop | ✅ |
| A 의 단계는 A 의 데스크톱에서(「로컬 에이전트 실행 중 · Claude Code」 알약), 다른 사람의 데스크톱으로는 가지 않음 | 사용자 11-24 | L-02 · `server/test/localAgents.test.js` | desktop · 단위 | ✅ |
| B 의 다음 단계는 B 의 데스크톱이 A 의 결과(인스턴스 라인)를 먼저 받아 시작(앱 안의 node-pty 터미널, B 의 창에 B 의 터미널), 실행 중 인스턴스 화면에서 입력 → 같은 세션에 반영 | 사용자 11-24 | L-02 · L-03 · `localAgents.e2e.mjs` 1–2 | desktop · e2e | ✅ |
| 로컬 실행을 끄면 다음 단계는 「PC 앱이 켜지면 시작」으로 기다리고, 켜면 돈다 | 사용자 11-24 | L-04 · `localAgents.e2e.mjs` 3 | desktop · e2e | ✅ |
| 휴대폰(390px)에서 실행 카드(누가 · 어느 컴퓨터 · 단계 · 상태 · 걸린 시간 · 그 CLI 의 터미널)가 새로 고침 없이 바뀌고, 입력이 PC 의 runner · CLI 입력에 닿아 「반영」, 옆으로 넘치지 않음 | 사용자 11-24(추가) | M-01 | feature | ✅ |
| 참여자(작업자 아님)는 같은 터미널을 실시간으로 보기만(입력 403), 바깥 사람은 실행 목록 · 입력 · 터미널 403 · 알림 없음 | 사용자 11-24(추가) | M-02 · `localAgents.e2e.mjs` 2 | feature · e2e | ✅ |
| PC 가 꺼져 있으면 「PC 앱이 켜지면 시작」(Home 카드에도), 휴대폰에서 「기다리지 않고 업무 에이전트에게 맡기기」 | 사용자 11-24(추가) | M-03 · `localAgents.e2e.mjs` 4 | feature · e2e | ✅ |
| 데스크톱이 꺼져 있고 「서버에 맡기기」면 바로 서버 에이전트, 기다릴 시간이 지나면 서버, 거절 · 바쁨 · 끊김 처리, 입력 상태(받음 · 반영 · 못 함) | — | `localAgents.test.js` · `localAgents.e2e.mjs` | 단위 · e2e | ✅ |
| 실행은 사람의 대화형 CLI 를 터미널(node-pty)에서: `SessionStart` 뒤 붙여 넣기, `Stop` 훅 · rollout 으로 턴의 끝, 앱 다시 켜기 → 같은 세션(`--resume`), 폴더 신뢰, 주인의 타자만, 단계 아닌 세션의 훅 · 지켜보는 파일 | 사용자 11-24(결정) | `desktop/test/terminal.test.js` · `localAgents.test.js`(중계) | 단위 | ✅ |
| 터미널 하나를 여럿이: 보는 사람과 작업자가 작업자 데스크톱 터미널의 바이트 그대로 받음, 보는 사람의 입력은 서버가 버림, 작업자의 입력은 CLI 에, 바깥 사람 표 403, 서버의 「지금 화면」 | 사용자 11-24(결정) | `localAgents.e2e.mjs` 2 · C-01 | e2e · feature | ✅ |
| runner 헤드리스(예비 길): 폴더 토큰이 `.git/config` · 로그 · 보고함에 없음, 정해진 명령만, 폴더 밖 경로 거절, Codex 는 멈추고 resume | — | `desktop/test/runner.test.js` | 단위 | ✅ |
| 실제 대화형 Claude Code 2.1.330 을 터미널로(회사 스킬 · 실행 중 입력 · 훅으로 끝), 헤드리스 Claude Code · Codex 0.162.1 한 번씩 + 입력 | 사용자 11-24 | `localAgents.smoke.mjs tty · both · skill` → `openspec/specs/local-agents/e2e/results/smoke.md` | 손 | ✅ |
| 두 사람 협업: 윤태호의 PC 실행을 서하린이 휴대폰(390px)에서 같은 터미널(읽기 전용)로 보며 제안 두 개 → 윤태호의 입력란에 칩으로 쌓임(알림 · Home) → 윤태호가 하나 버리고 하나를 골라 고쳐 입력 → 그의 CLI 에(가짜 CLI 기록에 고친 글) → 서하린의 화면 「고쳐서 입력함」 · 서하린은 보내기 없음 · 직접 입력 403 · 바깥 사람 403 | 사용자 11-24(핵심) | C-01 · `localAgents.e2e.mjs` 2 · `localAgents.test.js` | feature · e2e · 단위 | ✅ |
| 제안의 종류: 의견 · 역할자의 결정(고른 항목) — 둘 다 작업자의 입력란에, 넣는 것은 작업자만 | 조정 11-24 | `localAgents.test.js` | 단위 | ✅ |
| 결과가 인스턴스 라인으로, 다음 담당자(서하린)의 PC 가 그 결과로 시작 | 사용자 11-24 | C-02 · `localAgents.e2e.mjs` 1–2 | feature · e2e | ✅ |
| 서버의 회사 스킬이 로컬 실행의 CLI 자리에(Claude `.claude/skills`, Codex `.pgl-skills` + `AGENTS.md`), 실행마다 최신, 결과에 안 들어감, 읽기 전용 토큰, 남의 비공개 스킬 제외 | 사용자 11-24(핵심) | C-01 · `runner.test.js` · `localAgents.test.js` · 실제 `localAgents.smoke.mjs skill` | feature · 단위 · 손 | ✅ |
| 로컬 실행에서 배운 것(입력 — 제안한 사람 · 넣은 사람, 기억, 스킬 수정) → 판정 → 후보(출처) → 프로세스 담당자가 「이 일에 반영」 → 활동 정의의 「배운 것」, 다른 사람은 403, Home 카드 | 사용자 11-24(핵심) | C-03 · `localAgents.e2e.mjs` 2 · `localAgents.test.js` | feature · e2e · 단위 | ✅ |
| 스킬 수정 후보 → 「스킬에 반영 요청」(스킬 폴더 변형 · 반영 요청, 원본 그대로, 다른 사람 403) | 사용자 11-24 | `localAgents.test.js` | 단위 | ✅ |
| 지도의 일 패널 「에이전트」 화면, 지도(Ontological)의 일 정의에 배운 것 반영 | — | — (Ontological 이 필요해 자동 시험 없음, front matter 읽기 · 쓰기와 프로세스 정의 쪽 반영은 시험) | — | ◐ |
| 공개 git 경로 `/api/local-git/`: 링크된 기기의 그 일 토큰만(없음 401 · 클러스터 토큰 403 · 끊은 기기 403), 그 일의 작업 폴더 · 보낸 스킬 폴더만, 올리기는 도는 동안 그 일의 가지로만 | 검토 11-24 | `localAgents.e2e.mjs` 6 · `localAgents.test.js` | e2e · 단위 | ✅ |
| 검토 수정: 서버가 받기를 확인해야 시작 · 거둔 제안 취소 · 기기 설정을 바꿔도 실행 유지 · 다시 시도 · 관문 먼저 · 에이전트 되돌리기 · 같은 폴더는 차례로 · 폴더 자신의 AGENTS.md 그대로 · 세션 지우기 · 보낸 스킬만 | 검토 11-24 | `localAgents.test.js` · `runner.test.js` | 단위 | ✅ |
| 운영 주소에서 git 경로 · 링크 · 터미널 WebSocket 에 닿기, OpenHands 실행, 실제 대화형 Codex, Windows(ConPTY) | — | — (운영 설정 · 실측 필요) | — | ◐ |

### 31. 사람 단계의 입력 화면 — 에이전트가 만든 A2UI 화면 (스펙 `step-ui-a2ui`, 설계 `docs/a2ui-step-ui/design.md`)

서버는 가짜 모델(`PRO_LLM_BASE_URL=http://127.0.0.1:<RT_FAKE_LLM_PORT, 기본 59987>/v1`)로 띄우고 지도 저장소는 비워 둔다(`PRO_ONTOLOGY_BOLT_URL=`). 시험 파일이 그 포트에 가짜 모델을 띄운다. step-ui 프롬프트에는 `server/test/fixtures/step-ui-review.json` 화면을, 판정에는 「A」를 돌려준다. 건은 엔진이 쓰는 모양대로 DB 에 넣고, 할 일 카드는 시험 계정의 메인 채팅에 둔다. 한 워커로 돈다(`serial`). 띄우는 명령은 `openspec/specs/step-ui-a2ui/e2e/README.md`에 있다.

| 기능 요건 | 근거 | 시험 | 단계 | |
|---|---|---|---|---|
| 사람 단계가 열리면 화면을 만들어 둠(엔진은 기다리지 않음) · `GET /todos/:id`에 `form` 옆 `ui` · 모델이 본 입력(일 정의 · 요청 · 앞 단계 · 언어) | 사용자 11-24 | `server/test/stepUi.integration.test.js` | 단위 | ✅ |
| 할 일 카드: 「준비하고 있어요」 → 화면(보기 · 숫자 · 날짜 · 확인 · 긴 글 · 버튼 둘), 필수 칸 전엔 보내기 꺼짐, 한국어로 채워 내면 읽기 전용 · 「제출됨」 · 새로 고침 뒤에도 같음, DB 에 값 · result · a2ui | 사용자 11-24 | F-SU-01 | feature | ✅ |
| 처음 연 화면은 빨갛지 않음 · 쓴 칸만 안내 · 꺼진 보내기를 누르면 모두, 맡은 사람이 아니면 403 · 화면에 없는 버튼 400 | — | F-SU-02 · `stepUi.integration` | feature · 단위 | ✅ |
| 모델이 엉뚱한 화면을 두 번 → 글 칸 하나로 냄(물은 횟수 2 · 까닭 기록), 화면으로 내기는 409 | 사용자 11-24 | F-SU-03 · `stepUi.integration` | feature · 단위 | ✅ |
| 휴대폰 390px: 페이지 · 카드 · 칸 · 버튼 줄이 넘치지 않음 | — | F-SU-04 | feature | ✅ |
| 낮 · 밤 테마의 글 · 칸 · 보내기 색, 페이지 color-scheme 은 그대로 | — | F-SU-05 | feature | ✅ |
| 받는 화면: 공식 v1.0 스키마 + 서버 검사(v0.9 바인딩 · theme · 모르는 부품 · 없는 id · 고리 · 크기 · javascript: 주소 · 경로 · 예약어 · 버튼 · 비밀번호 칸 · numeric), 낸 값 다시 보기(꼴 · 보기 · 길이 · 확인), result 글, 다시 묻기 · 글 칸 · 비밀 판정 | 보안 | `server/test/stepUi.test.js` | 단위 | ✅ |
| 먼저 열면 그때 만듦 · 꺼 두면 없음 · 영어를 쓰는 사람은 영어로 · 초안 단계는 초안이 온 뒤 그것을 첫 값으로 · 비밀을 묻는 화면은 쓰지 않음 | 사용자 11-24 | `stepUi.integration` | 단위 | ✅ |
| 실제 모델(`frentis-ai-model`, 추론 low)로 지어낸 일 여섯 개 | — | `server/scripts/eval-step-ui.mjs` | 수동 | ✅ |
| 건 화면(지도 › 건 보기)의 같은 카드 | — | — (지도 저장소가 있어야 열림 — 같은 TodoCard) | — | ◐ |

### 32. 운영 화면 11-24 — 일정 카드는 일정 양식과 「캘린더에 추가」, 그 밖의 카드는 맡기기, 동사는 사람의 언어로 (스펙 `mail-card-actions`)

서버는 가짜 모델(`PRO_LLM_BASE_URL=http://127.0.0.1:<RT_FAKE_LLM_PORT, 기본 59967>/v1`)과 가짜 Google(`PRO_GOOGLE_GMAIL_URL=http://127.0.0.1:<RT_FAKE_GOOGLE_PORT, 기본 59966>/gmail/v1`, `PRO_GOOGLE_CALENDAR_URL=…/calendar/v3`)로 띄운다. 둘 다 시험 파일이 띄우므로 한 워커로 돈다(`mode: 'serial'`, `RT_WORKERS=1`). F-MC-04 는 Gmail 메일함의 Google 연결을 서버 모듈로 보관함에 넣는다(시험 프로세스와 서버가 같은 보관함 키 파일을 씀). 같은 서버에 F-ML · F-MT · F-MW · F-HD 를 이어 돌릴 때는 앞 묶음의 가짜 모델이 판정 모델의 첫 글자 확률에도 답해야 한다. 확률이 없는 답을 받으면 서버가 판정 읽기를 10분 쉬어, 뒤 묶음의 「잇기」가 사라진다(F-ML 의 가짜 모델도 이제 답한다). 띄우는 명령은 `openspec/specs/mail-card-actions/e2e/README.md`에 있다.

| 기능 요건 | 근거 | 시험 | 단계 | |
|---|---|---|---|---|
| 일이 정해지지 않은 일정 카드를 Home 에서 열면 판정 모델이 일정으로 읽고 「일정 정보를 읽는 중…」 → 일정 양식(제목 · 내일 · 15:00 · 링크). 답장은 「답장도 쓰기」 아래, 맡기기 없음, 아무것도 만들지 않음, Home 카드가 「일정 추가」로 바뀜 | 사용자 11-24 | F-MC-01 · `server/test/mailCard.integration.test.js` | feature · 단위 | ✅ |
| 브리프 칩 「일정 추가 · …」 → 같은 양식, 메일 비서가 정한 카드는 다시 묻지 않음 | 사용자 11-24 | F-MC-02 | feature | ✅ |
| 시각 · 길이를 고쳐 「캘린더에 추가」 → 「기록했어요 · <날짜 시간>」(데모 메일함), 카드는 끝나 Home 에서 빠지고 채팅에 남음 | 사용자 11-24 | F-MC-03 · `mailCard.integration` | feature · 단위 | ✅ |
| Google: 「캘린더에 추가했어요 · …」 · 「캘린더에서 보기」, 한 번만 만듦, 같은 일정(제목 · 시작)이 있으면 「이미 캘린더에 있어요」, 두 번 누름 · 동시에 두 번 | 사용자 11-24 | F-MC-04 · `mailCard.integration`(가짜 Google) | feature · 단위 | ✅ |
| 답장 카드는 그대로: 머리 「답장」, 초안이 바로, 양식 · 「답장도 쓰기」 · 맡기기 없음, 판정하지 않음 | 사용자 11-24 | F-MC-05 · F-ML-01~07 | feature | ✅ |
| 그 밖의 카드(Pay): 「에이전트에게 맡기기」가 할 일과 함께 큰 단추, 「답장도 쓰기」 → 초안 | 사용자 11-24 | F-MC-06 · F-ML-03 · 05 | feature | ✅ |
| 동사는 사람의 언어로: Home · 칩 · 받은 편지함에 「일정 추가」 · 「납부」 · 「답장」 · 「검토」, 영어 화면은 Add to calendar · Pay · Reply · Review | 사용자 11-24 | F-MC-07 · F-MT-01 | feature | ✅ |
| 390px: 칩 · 양식 · 단추 · 맡기기 카드가 화면 안, 양식에서 바로 추가 | 사용자 11-24 | F-MC-08 | feature | ✅ |
| 판정: 첫 글자 확률, 문턱 아래는 그 밖의 일, JSON 대체, 모델이 꺼지면 남기지 않음, 카드마다 한 번 | — | `server/test/mailCard.test.js` · `mailCard.integration` | 단위 | ✅ |
| 일정 정리: 받은 때 기준, 다른 시간대 변환, 서머타임, 시각 없음(종일 · 묻기), 없는 날짜 · 위험한 링크 버림, 읽기 실패는 빈 양식 | — | `mailCard.test.js` | 단위 | ✅ |
| 데모 메일함은 기록만, 캘린더 권한 없음 · Google 연결 없음 403, Google 거절 502(카드 남음), 남의 카드 403 | — | `mailCard.integration` | 단위 | ✅ |
| 메일 비서가 카드의 일(kind)을 정하고 브리프 칩이 그 종류를 앎, 브리프가 대신 하겠다고 말하지 않음 | 사용자 11-24 | `mailCard.integration`(가짜 모델) · 실제 모델 확인(`results/real-model.txt`) | 단위 | ✅ |
| 실제 Google 캘린더에 만들기 | — | — (시험은 가짜 Google) | — | ◐ |

### 33. 지도에서 바로 도는 건의 인스턴스 화면 — 회사 지도가 아니라 그 건의 BPMN 으로 (스펙 `map-case-view`)

서버는 `PRO_BACKGROUND=0` 이면 된다(`server/.env` 그대로든 `PRO_ONTOLOGY_BOLT_URL=` 이든 통과). 건은 엔진이 남기는 모양대로 DB 에 넣고(`server/test/fixtures/map-case-view.mjs` — 지어낸 회사 · 사람), 로컬에 지도 저장소가 없어 `GET /api/ontology/cases/:id/flow` 만 시험이 답한다. 그 응답은 서버 코드(`mapengine.js` `flowFor` → `casebpmn.js`)를 시험 프로세스에서 고정 지도로 돌린 것이다. 한 워커로 돈다(`serial`). 명령은 `openspec/specs/map-case-view/e2e/README.md`에 있다.

| 기능 요건 | 근거 | 시험 | 단계 | |
|---|---|---|---|---|
| 메일 칩 · 루틴 목록 · Home 카드 · 알림 · `/projects/p/…` · 채팅 시작 카드의 「인스턴스 열기」로 연 지도 건은 `/routines/<인스턴스>`에 머묾(회사 지도로 넘기지 않음) | 사용자 11-24 | F-CV-01 · 04 · 08 | feature | ✅ |
| 진행 상황은 다이어그램부터: 건의 BPMN(역할 레인 · 사람 이름 · 업무 에이전트 레인 · 갈림), 상태 색과 범례, 넓은 화면은 대화 칸보다 넓은 카드에 왼쪽에서 오른쪽 | 사용자 11-24 | F-CV-01 · `server/test/map-case-view.test.js` | feature · 단위 | ✅ |
| 목록 · 다이어그램 · 서버의 단계(진행 막대 · 「내 입력이 필요해요」)가 같은 상태, 입력 카드는 하나 | 사용자 11-24 | F-CV-02 · `map-case-view.test.js` | feature · 단위 | ✅ |
| 건의 방식 · 멈추기 · 이어 가기, 「이 건 다루기」(맡는 사람 · 지도 고정 · 옮기기), 「회사 지도에서 이 건 보기 →」 | 사용자 11-24 | F-CV-02 · 03 | feature | ✅ |
| 지도의 건 패널: 흐름도가 맨 위, 머리의 「크게 보기」(왼쪽에서 오른쪽) · 「인스턴스 열기」 | 사용자 11-24 | F-CV-03 | feature | ✅ |
| 휴대폰 390px: 위에서 아래, 페이지 · 대화 칸이 넘치지 않음, ‹ 로 닫기 | 사용자 11-24 | F-CV-06 | feature | ✅ |
| 밤 테마: 흐름도의 글 · 머리 · 범례 | — | F-CV-07 | feature | ✅ |
| 정의가 있는 인스턴스(클래식 · 스냅샷)는 그대로: 목록부터(목록만), 정의의 BPMN, 병목 링크, 건의 흐름도를 묻지 않음 | — | F-CV-05 | feature | ✅ |
| 실제 지도 저장소로 그린 흐름도 · 낸 뒤 다음 단계 | — | F-PO-18(고쳐 둠 — ax-demo 시드 · 지도 저장소가 있어야 돎) | feature | ◐ |
| 「제안」 카드의 「흐름 보기」: 선택하기 전에 제안된 시작 작업부터의 스냅샷 BPMN · 단계 순서 확인, 보기만 해서는 시작되지 않음 · 휴대폰 시트 | 사용자 11-25 | F-CV-09 | feature | ✅ |

### 34. 로컬 에이전트 실행을 「대화」와 「터미널」 두 보기로 — Lite 의 모양으로 보는 같은 세션, CLI 가 묻는 것, 턴 뒤 기다리기 · 끝내기 (스펙 `local-agents`, 설계 `docs/local-agents/design.md` 5.11 · 6.2)

`local-agents-view.spec.js` 는 30절의 파일들처럼 자기 스택(BFF `PRO_BACKGROUND=0` + Vite, 회사 `localagent-view`, 8889 · 5289 부터 빈 포트, 끝난 터미널을 4초 뒤 메모리에서 빼는 `PRO_LOCAL_TERM_KEEP_MS=4000`)을 띄우고 지운다. 윤태호의 PC 는 데스크톱 앱의 runner 그대로이고 CLI 는 가짜(`desktop/test/fixtures/fake-tui.js` — 실제 Claude Code 2.1.331 처럼 세션 jsonl 을 쓰고 `PermissionRequest` 훅을 부르며, `THINK` · `SAY` · `EDIT` · `BASH` · `SKILL` · `ASK` · `CHOOSE` 를 한다). 모델은 부르지 않는다. 물음의 키는 이 맥의 실제 Claude Code 로 따로 쟀다(`openspec/specs/local-agents/e2e/results/smoke.md` 끝). 명령은 `openspec/specs/local-agents/e2e/README.md`.

| 기능 요건 | 근거 | 시험 | 단계 | |
|---|---|---|---|---|
| 실행 카드에 「대화」 · 「터미널」: 데스크톱의 작업자는 「터미널」, 휴대폰(390px) · 다른 사람은 「대화」로 열리고, 고른 보기는 그 브라우저에 남음 | 사용자 11-24 | F-LV-01 · 02 | feature | ✅ |
| 「대화」는 CLI 의 기록(Claude jsonl · Codex rollout)에서: 단계 프롬프트(접힘) · 생각(접힘) · 「스킬 사용 · 견적-규칙」 · 「만듦 · 견적서.md」 · 「고침 · 견적서.md」 · 「명령 실행 · …」 · 「작업 중…」, 새로 고침 없이 늘어남 | 사용자 11-24 | F-LV-03 · `desktop/test/conversation.test.js` | feature · 단위 | ✅ |
| 「고침」을 펼치면 차이가 그 상자 안에서(390px 화면은 넘치지 않음), 「명령 실행」은 명령과 출력 | 사용자 11-24 | F-LV-04 | feature | ✅ |
| 입력에 누구의 말인지 — 「서하린 제안 · 윤태호 입력」(두 사람의 대화에) | 사용자 11-24 | F-LV-05 · `conversation.test.js` | feature · 단위 | ✅ |
| CLI 의 물음(권한 · 고르기): 작업자만 누름 → PTY 에 `1` · `2` · `Esc` · 항목 번호, 다른 사람은 「윤태호님의 답을 기다려요」 · 답 403, 닫힌 물음 409 | 사용자 11-24 | F-LV-06 · `conversation.test.js` · `localAgents.test.js` · 실측 2.1.331(`results/smoke.md`) | feature · 단위 · 손 | ✅ |
| 턴이 끝나면 기다림: 작업자에게 「끝내기」 · 「N분 동안 새 입력이 없으면 저절로 끝나요」, 다른 사람에게 「윤태호님이 끝내기를 기다려요」, 제안이 기다림을 다시 시작, 「끝내기」는 작업자만(403), 기본 5분 · 데스크톱 설정 | 사용자 11-24(협업) · 영상 녹화 | F-LV-07 · `conversation.test.js`(settle 규칙) | feature · 단위 | ✅ |
| 끝난 실행: 터미널은 마지막 턴의 화면(CLI 가 닫히며 지운 화면이 아님), 대화는 일에 남은 기록에서(서버 메모리에서 빠진 뒤에도) | 영상 녹화 | F-LV-08 · `localAgents.test.js` | feature · 단위 | ✅ |
| 터미널은 Lite 의 색: 밝은 rgb(251,251,253) · 어두운 rgb(29,29,31) 바탕, 16색 4.5:1 이상, 테마를 바꾸면 그 자리에서, 390px | 사용자 11-24 | F-LV-09 · `server/test/localTermTheme.test.js` | feature · 단위 | ✅ |
| 휴대폰(390px)의 폴더 변경안: 제목이 한 줄, 단추 · 바뀐 파일 목록 · 차이가 차례로, 넘치지 않음 — 폴더 · 폴더 목록도 | 영상 녹화 | F-LV-10 | feature | ✅ |
| 카드가 보이자마자 「터미널에 연결하는 중…」, 터미널이 열리면 곧바로(서버가 보는 사람을 붙잡아 둠) | 영상 녹화 | F-LV-01 · `localAgents.test.js`(일찍 붙기) | feature · 단위 | ✅ |
| Home 알림 · 실행 카드의 이름 조사(「윤태호가 고쳐서 입력했어요」 · 「Claude Code가 「견적서 작성」을 끝냈어요」 · 「Claude Code로」) | 영상 녹화 | `server/test/josa.test.js` · F-LV-09(카드 글) | 단위 · feature | ✅ |
| 여러 물음을 한 번에 묻는 고르기: 물음마다 번호, 끝에 Enter(실측 2.1.331) | 사용자 11-24 | `conversation.test.js` 「고르기 물음 …」 · 실측 `results/smoke.md` | 단위 · 손 | ✅ |
| Codex 의 승인 창을 카드로 | — | — (Codex 의 기록 · 훅에 남지 않음 — 터미널에서 답함) | — | ◐ |

### 35. 오늘의 배경 사진 — 날짜 · 날씨 패널에서 그날의 사진을 골라 배경으로 (스펙 `daily-background`)

서버는 가짜 Commons 에 묻도록 `PRO_BG_COMMONS_API=http://127.0.0.1:59971/w/api.php`로 띄운다(시험에서만 쓰고, 게이트웨이 뒤에서는 무시된다). 가짜 Commons(`127.0.0.1:59971`, `RT_BG_SITE_PORT`)는 시험 파일이 띄우고, 지어낸 SVG 풍경 열한 장을 답한다. 공용 인터넷에는 나가지 않는다. 사이트 포트가 이 파일의 것이고 F-BG-05 가 회사(`localhost`)의 스위치를 잠깐 끄므로 한 워커로 돈다(`serial`). F-BG-03 은 Playwright 의 가짜 시계로 다음 날 아침을 연다. 시험은 Playwright 자신의 Chromium 으로 돈다. 명령은 `openspec/specs/daily-background/e2e/README.md`에 있다.

| 기능 요건 | 근거 | 시험 | 단계 | |
|---|---|---|---|---|
| 패널 머리에 오늘 날짜 · 24절기(한국 표준시, 황경 15°마다), 장소는 오른쪽 | 사용자 11-24 | F-BG-01 · 03 · `server/test/background.test.js` | feature · 단위 | ✅ |
| 하늘이 첫 칸, 그날의 사진 6~10장(절기 둘 · 계절과 시간대 · 날씨 · 계절 · 오늘의 사진 · 멋진 풍경 한 장)과 주제 이름, 같은 날 같은 차례 | 사용자 11-24 | F-BG-01 · `background.test.js` | feature · 단위 | ✅ |
| 무드 칩(차분 · 따뜻 · 시원 · 활기): 그 무드의 주제 둘이 앞, 다시 누르면 처음 차례 | 사용자 11-24 | F-BG-04 · `background.test.js` | feature · 단위 | ✅ |
| 누르면 바로 배경(1.2초 겹쳐 바뀜), 서버에 그 사람의 선택으로, 새로 고침 · 다른 기기에서도 같음 | 사용자 11-24 | F-BG-02 · `background.integration.test.js` | feature · 단위 | ✅ |
| 「오늘만」(기본)은 그 사람의 다음 날 하늘, 「계속 두기」는 남음 | 사용자 11-24 | F-BG-03 · `background.test.js` · integration | feature · 단위 | ✅ |
| 하늘로 돌아가기(선택을 지움, 출처도 사라짐) | — | F-BG-04 · integration | feature · 단위 | ✅ |
| 출처(제목 · 작가 · 라이선스 · 출처 사이트)를 패널과 넓은 화면의 구석에, 원본 · 작가 · 라이선스 페이지로 링크 | 라이선스 | F-BG-02 · 06 | feature | ✅ |
| 다시 써도 되는 라이선스만(CC0 · PD · CC BY · CC BY-SA · FAL · KOGL 1), NC · ND · GFDL 만 · 제한 표시 · 세로 · 작은 원본은 뺌, 작가 칸의 안내 표 · 메일 주소는 이름만 | 라이선스 | `background.test.js`(기록한 Commons 답) | 단위 | ✅ |
| 그림은 그 사이트의 CDN 에서 바로, referrer 없이, 창에 맞는 표준 너비(srcset), 휴대폰은 3840 없음, 데이터 절약이면 가장 작은 것 | — | F-BG-01 · 02 · 06 | feature | ✅ |
| 밝은 · 어두운 사진, 낮 · 밤 테마에서 가림막으로 읽힘, 움직임 줄이기면 바로 바뀜 | — | F-BG-07 · 08 | feature | ✅ |
| 그림을 못 불러오면 하늘 + 안내 한 줄, 다시 누르면 다시 받음 | — | F-BG-08 | feature | ✅ |
| 회사 관리자 스위치(설정 › 시스템 설정, 기본 켬): 끄면 띠 없음 · 모두 하늘 · 사이트에 묻지 않음 · 저장 403, 관리자 아니면 403, 다시 켜면 선택이 돌아옴 | 사용자 11-24 | F-BG-05 · integration | feature · 단위 | ✅ |
| Unsplash · Pexels 키(선택): 보관함에 암호화, 화면에는 「저장됨」만, 일부 주제를 그 사이트에서, Unsplash 는 utm 링크와 download 알림 | 각 사이트 지침 | integration(가짜 Unsplash) · `background.test.js` | 단위 | ✅ |
| 서버: 고정 API 호스트만 · 넘겨주기 안 따름 · 6초 · 3MB, 회사 + 날짜마다 하루 기억, 보낸 사진을 다시 확인(다른 호스트 · 라이선스 · 「얼마나」 400), 로그인 401 | SSRF | F-BG-10 · `background.test.js` · integration | feature · 단위 | ✅ |
| 휴대폰 390px: 띠만 옆으로, 페이지는 밀리지 않음 | 사용자 11-24 | F-BG-06 | feature | ✅ |
| 데스크톱 앱: 사진이 끌기 띠를 가리지 않음(누름을 받지 않음), 구석 출처 링크는 `no-drag` | — | F-BG-09(브라우저에서 `html.pgl-desktop`) | feature | ◐ |
| 실제 Wikimedia Commons 의 그날 후보 | — | — (시험은 공용 인터넷에 나가지 않음 · 스펙의 e2e/README.md 「실제 …로 한 번」) | — | ◐ |
| 실제 Unsplash · Pexels 키 | — | — | — | ◐ |

### 36. 채팅의 대화 목록 — 「채팅」을 두 번 누르면 왼쪽에 대화 목록, 고르면 그 대화만 (스펙 `chat-thread-list`)

판단 모델(context-router)이 나눈 대화(`context_threads`)를 프로젝트 · 루틴 목록과 같은 왼쪽 칸에 보여 준다. 시험은 계정마다 대화 네 개를 지어 넣고 모델 없이 돈다(serial, Playwright 자체 Chromium). 명령은 `openspec/specs/chat-thread-list/e2e/README.md`에 있다.

| 기능 요건 | 근거 | 시험 | 단계 | |
|---|---|---|---|---|
| 「채팅」 두 번 누르기(다른 탭에서도)로 열고 닫음, 탭에 「두 번 누르면 대화 목록」 | 사용자 11-24 | F-CT-01 · 04 · 05 · `server/test/chatThreadList.test.js` | feature · 단위 | ✅ |
| 한 번 누르기는 그대로 — 기다리지 않음(0.25초 안), 두 번째 클릭은 다시 이동하지 않음, 세 번째는 무시 | 사용자 11-24 | F-CT-05 · CT-U-06~10 | feature · 단위 | ✅ |
| 행: 최근 순, 제목 · 한 줄(요지 · 마지막 요청) · 시각(대화 막대와 같은 말) · 메시지 수, 맨 위 「전체 대화」, 대화가 없으면 안내 | — | F-CT-01 · 10 · CT-U-01 · 03 · 04 | feature · 단위 | ✅ |
| 고르면 `/chat/c/:cid`(그 대화의 메시지만, 행 강조, 목록은 열린 채), 대화 막대와 늘 같음, 「전체 대화」 | 사용자 11-24 | F-CT-02 | feature | ✅ |
| 찾기: 제목 · 요지 · 요약에서 낱말마다(글자 맞춤), Esc | — | F-CT-03 · CT-U-02 | feature · 단위 | ✅ |
| Home 과 같은 칸을 나눠 씀(Home 단추 · 알림이 목록을 닫고, 목록이 Home 을 닫음), ✕, 대화 막대의 「대화 목록 펼치기」 | — | F-CT-04 | feature | ✅ |
| 열린 채인지 이 브라우저에 기억(`pgl-chat-thread-list`), 저장소가 막혀도 동작 | — | F-CT-06 · CT-U-05 | feature · 단위 | ✅ |
| 새 턴(실시간 이벤트)이 오면 목록이 따라옴, 2.5초 뒤 요약을 다시 받음 | — | F-CT-09 | feature | ✅ |
| 휴대폰 390px: 한 화면짜리 시트, 고르면 닫히고 그 대화, 옆으로 밀리지 않음, 두 번 탭으로 닫기 · 한 번 탭 · 홈 탭 · ✕ | 사용자 11-24 | F-CT-07 | feature | ✅ |
| 밤 테마(넓은 화면 · 휴대폰) | — | F-CT-08 | feature | ✅ |
| iOS Safari 의 실제 두 번 탭 | — | — (0.4초 간격 대체 규칙만 CT-U-08) | — | ◐ |

### 37. 채팅 · 프로젝트의 산출물 — 넓으면 오른쪽 목록, 좁으면 입력창을 가리지 않는 더미 (스펙 `chat-artifacts`)

산출물 더미는 대화를 하나 고른 화면에만 있었다. 이제 전체 채팅 · 고른 대화 · 프로젝트 방마다 그 화면의 파일이 보인다. 채팅 칸(512px + 양옆 40px) 옆에 300px 를 둘 자리가 있으면 오른쪽 칸에 늘 보이는 목록으로, 없으면 Dock 모양 더미로 보이고, 문서가 열리면 비켜 있는다. 시험은 대화 맥락 시험과 같은 채팅(파일 13개)과 파일 두 개짜리 프로젝트 방으로 돈다. 명령은 `openspec/specs/chat-artifacts/e2e/README.md`에 있다.

| 기능 요건 | 근거 | 시험 | 단계 | |
|---|---|---|---|---|
| 범위: 전체 채팅(행에 나온 대화) · 고른 대화 · 프로젝트 방, 루틴 · 새 프로젝트 · 휴대폰 Home 에는 없음 | 사용자 11-24 | F-AS-01 · 02 · 07 · `server/test/chatArtifacts.test.js` | feature · 단위 | ✅ |
| 넓은 화면의 오른쪽 목록: 종류 표 · 이름 · 시각, 「산출물 N」, 7개 이상이면 찾기, 채팅은 남은 폭 가운데로, 모서리 시계는 자리가 없으면 감춤 | 사용자 11-24 | F-AS-01 · 05 · AS-U-03 · 04 | feature · 단위 | ✅ |
| 누르면 채팅 카드와 같은 곳(문서는 이음오피스 패널), 행의 공유 단추 | 사용자 11-24 | F-AS-03 · 04 · 06 | feature | ✅ |
| 문서가 열려 있으면 목록 · 더미 모두 비킴, 닫으면 돌아옴 | — | F-AS-03 · 06 | feature | ✅ |
| 접으면 아이콘만 있는 띠(64px), 이 브라우저에 기억(`pgl-artifact-list`) | — | F-AS-04 · AS-U-06 | feature · 단위 | ✅ |
| 오른쪽에 붙인 메신저: 목록은 그 왼쪽, 자리가 모자라면 더미, 서로 겹치지 않음 | PR #32 | F-AS-05 · AS-U-04 | feature · 단위 | ✅ |
| 더미는 입력창 옆(여유가 있으면) · 위(「멈추기」 알약보다 위), 여러 줄 입력이면 함께 올라감 | — | F-AS-06 · AS-U-05 | feature · 단위 | ✅ |
| 휴대폰 390px: 작은 더미(48px), 입력창 위, 옆으로 밀리지 않음, 부채꼴 | — | F-AS-07 | feature | ✅ |
| 밝은 · 밤 테마 | — | F-AS-01 · 06 · 08 | feature | ✅ |
| 왼쪽 · 문서 패널에 붙인 메신저 | — | — (같은 페이지 폭 규칙, 화면은 오른쪽만) | — | ◐ |

### 38. 채팅에서 메시지를 받을 에이전트를 고른다 — 「기본」 · 「Claude Code · 내 PC」 · 「Codex · 내 PC」 (스펙 `local-agents` 「채팅에서 고르는 에이전트」, 설계 `docs/local-agents/design.md` §12)

`chat-agent-picker.spec.js` 는 30절의 파일들처럼 자기 스택(BFF `PRO_BACKGROUND=0` + Vite, 회사 `chatagent-ui`, 8892 · 5292 부터 빈 포트)을 띄우고 지운다. 서버의 에이전트 · completion · 맥락 라우터는 아무 데도 아닌 주소(`127.0.0.1:9`)로 둔다 — 공용 deepagents 를 부르지 않는다(F-CA-05 의 「기본」 답은 그래서 서버 에이전트의 실패 답이다). 윤태호의 PC 는 데스크톱 앱의 runner 그대로이고 CLI 는 가짜(`desktop/test/fixtures/fake-tui.js`). 모델은 부르지 않는다. 화면 사진은 `openspec/specs/local-agents/e2e/results/chat-agent/`. 명령은 `openspec/specs/local-agents/e2e/README.md`.

| 기능 요건 | 근거 | 시험 | 단계 | |
|---|---|---|---|---|
| 입력창의 칩: 「기본」, PC 앱이 없으면 내 PC 항목은 꺼진 채 까닭 · 내려받기 링크, 꺼진 항목은 고를 수 없음 | 사용자 11-24 | F-CA-01 · `server/test/chatAgents.test.js` | feature · 단위 | ✅ |
| PC 앱이 이어지면 새로 고침 없이 켜짐(그 데스크톱이 알린 CLI 만 · 기기 이름), 실행 끔 · 0.2.2 전 판은 까닭과 함께 꺼짐 | 사용자 11-24 | F-CA-01 · `chatAgents.test.js` | feature · 단위 | ✅ |
| 키보드: ↓ 로 열기, ↓ · Enter 로 고르기, 포커스는 칩으로, Esc 로 닫기 | 접근성 | F-CA-02 | feature | ✅ |
| 보내면: 메시지 아래 「→ Claude Code · 내 PC」, 실행 카드(「대화 / 터미널」, 「내 폴더 「내 PC 에이전트 작업 · 윤태호」」), CLI 의 마지막 말이 답 메시지로, 만든 파일이 파일 카드로(그 폴더의 원본에), 서버 에이전트는 부르지 않음 | 사용자 11-24 | F-CA-02 · `server/test/chatAgents.e2e.mjs` · `desktop/test/chat.test.js` | feature · 통합 · 단위 | ✅ |
| 이어서 보낸 메시지는 같은 CLI 세션(실행 카드 하나, 답 하나 더) · 닫힌 뒤의 메시지는 새 실행이 그 세션을 이어(`--resume`) · 닫히는 사이의 메시지는 다음 실행이 받음 | 사용자 11-24 | F-CA-03 · `chatAgents.e2e.mjs` · `chatAgents.test.js` · `chat.test.js` | feature · 통합 · 단위 | ✅ |
| 고른 것은 대화마다 · 사람마다 서버에(새로 고침 · 다른 브라우저 같음, 프로젝트는 따로) | 사용자 11-24 | F-CA-04 · `chatAgents.test.js` | feature · 단위 | ✅ |
| 다시 「기본」: 요청에 `agent` 없음, 실행 카드 없음, 서버 에이전트가 답함 | 사용자 11-24 | F-CA-05 | feature | ✅ |
| PC 가 꺼지면: 칩이 꺼짐 표시, 「PC 앱이 꺼져 있어요」, 실행 카드 「PC 앱 연결이 끊겼어요」 · 「기본으로 다시 보내기」(그 글이 기본으로) · 새 메시지는 「PC 앱이 켜지면 시작」 | 사용자 11-24 | F-CA-06 · `chatAgents.e2e.mjs` | feature · 통합 | ✅ |
| 프로젝트: 그 폴더의 프로젝트 변형에 파일(원본 그대로), 편집자가 아니면 403(메시지 아래 까닭), 폴더 구성원은 보기만 | 사용자 11-24 | `chatAgents.e2e.mjs` · `chatAgents.test.js` | 통합 · 단위 | ✅ |
| 다른 사람: 보기 · 입력 · 끝내기 · 다시 보내기 403, 그의 대화에 보내기 404, 그녀의 메시지는 그녀의 PC 를 기다림(남의 PC 로 가지 않음) | 사용자 11-24 | `chatAgents.e2e.mjs` · `chatAgents.test.js` | 통합 · 단위 | ✅ |
| 휴대폰 390px 밝게 · 어둡게: 칩은 입력창 위, 목록은 화면 안, 옆으로 넘치지 않음 · 책상의 어두운 테마 | — | F-CA-07 · 08 | feature | ✅ |
| 넓은 창에서 입력창만 좁을 때(460px 미만): 칩은 입력창 위 줄로, 안내 문구는 한 줄로 · 넓어지면 칩은 다시 안으로 | 사용자 11-25 | F-CA-09 | feature | ✅ |
| 맥락으로 나눈 대화(`/chat/c/:id`) 안에서 보내기 · 그 대화의 산출물 스택 | 사용자 11-24 | `chatAgents.test.js`(대화 열쇠) · `chatAgents.e2e.mjs`(대화마다의 선택) — 화면은 모델 없이 그 대화를 만들 수 없음 | 단위 · 통합 | ◐ |
| 실제 Claude Code · Codex 로 채팅 메시지 | — | — (가짜 대화형 CLI 로만) | — | ◐ |

**데스크톱 앱 안에서(11-25 보고).** 「일렉트론에서 실행했는데도... 에이전트 선택이 안됨」 — 그 앱은 0.1.0(로컬 에이전트 전 판, runner 다리 없음)이라 이 컴퓨터를 짝짓지 못했는데, 고르기는 앱 안에서 「PC 앱을 설치하고 로그인하면 쓸 수 있어요」라고 했다. `chat-agent-desktop.spec.js` 는 자기 스택(회사 `chatagent-desk`, 8930 · 5330 부터, `PRO_DESKTOP_LATEST=0.2.3`)에서 브라우저 페이지에 데스크톱 preload 의 `window.pglDesktop` 을 넣는다 — 옛 앱(다리 없음) 또는 가짜 runner 다리(짝짓기 한 번 실패 뒤 성공, 이어지지는 않음).

| 기능 요건 | 근거 | 시험 | 단계 | |
|---|---|---|---|---|
| 브라우저에서는 그대로(「PC 앱을 설치하고 로그인하면 …」 · 「PC 앱 내려받기」), 앱 버전 줄 없음 | 사용자 11-25 | F-CA-09 | feature | ✅ |
| 0.1.0 앱 안: 「PC 앱이 오래돼 …」, 지금 · 최신 버전, 「최신 버전 받기」, Tab 으로 링크, 설정도 같은 말, 390px 어둡게 | 사용자 11-25 | F-CA-10 | feature | ✅ |
| 연결을 해제해 둔 앱: 「이 컴퓨터 연결」 — 실패하면 까닭(그 토큰은 거둠), 다시 누르면 짝지어 「연결 중」, CLI 항목은 그대로 | 사용자 11-25 | F-CA-11 · `chatAgents.test.js`(알리지 않은 데스크톱) | feature · 단위 | ✅ |
| 이어진 앱이 가장 새 릴리스보다 오래됨: 「PC 앱 새 버전(…)이 나왔어요」 · 「내려받기」, 설정도 | 사용자 11-25 | F-CA-12 · `server/test/desktopRelease.test.js`(릴리스 고르기 · 버전 순서 · 기다리지 않음 · 못 읽으면 없음) | feature · 단위 | ✅ |
| 실제 Electron 0.1.0 · 0.2.x 앱 안에서 | — | — (preload 의 `window.pglDesktop` 모양을 그대로 흉내 냄) | — | ◐ |

```bash
cd server && node --test test/desktopRelease.test.js test/chatAgents.test.js
cd e2e && npx playwright test --project=feature tests/feature/chat-agent-desktop.spec.js
```

### 39. 문서 옆의 왼쪽 칸 — 목록 · 채팅 · 문서가 겹치지 않음 (스펙 `chat-artifacts`)

운영 화면(11-24, 약 2000px 창)에서 사용자가 보고한 문제다. 「프로젝트에서 산출물을 열어보면 이렇게 목록과 대화내용이 겹쳐진다.」 문서 패널이 옆에 열리면 전역 CSS(`OfficeSheet.vue`의 `body.craft-side .main .center { left: 0 }`)가 채팅 칸을 창 왼쪽 끝부터 다시 놓았고, 그 위에 왼쪽 목록이 그대로 남아 있었다. 고친 뒤에는 `MainView.vue`가 문서 패널의 실제 폭을 잰다. 그리고 `src/leftColumn.js`의 규칙을 따른다. 왼쪽 칸(420px) · 채팅(512px + 양옆 40px) · 문서가 나란히 들어가면 셋을 나란히 둔다. 들어가지 않으면 목록을 접고 위쪽 막대 Home 옆의 「≡ 프로젝트 · 루틴 · 대화」 단추로 채팅 위에 펼친다. Home 은 열 때 채팅 위에 펼쳐진다. 시험마다 1280 · 1440 · 1600 · 2000px 에서 문서를 연다. 그리고 문서 패널 · 채팅 칸 · 입력창 · 왼쪽 칸 · 단추 · 탭 · 붙여 둔 메신저의 상자가 서로 겹치지 않는지 본다. 화면 사진은 `openspec/specs/chat-artifacts/e2e/results/f-dl-*.png`에 있다.

```bash
cd server && node --test test/docLayout.test.js
cd e2e && PGPT_URL=http://localhost:5283 API_URL=http://127.0.0.1:8883 RT_WORKERS=1 npx playwright test tests/feature/doc-layout.spec.js --project=feature
```

| 기능 요건 | 근거 | 시험 | 단계 | |
|---|---|---|---|---|
| 자리 규칙: 문서 옆에 왼쪽 칸 + 채팅 + 문서가 들어가면(문서 960px 기준 1972px 이상, ArtCraft 앱 840px 기준 1852px) 나란히, 아니면 목록 접힘 · Home 은 채팅 위 | 사용자 11-24 | DL-U-01~05 | 단위 | ✅ |
| 프로젝트: 채팅의 파일 카드로 연 문서 — 2000px 은 목록 · 채팅 · 문서 나란히, 1280 · 1440 · 1600px 은 목록 접힘 + 「≡ 프로젝트」, 닫으면 목록 | 사용자 11-24 | F-DL-01 | feature | ✅ |
| 접힌 목록: 단추로 채팅 위에 펼침(문서 · 단추와 겹치지 않는 판), Esc · 바깥 · 단추로 접힘, 다른 프로젝트를 고르면 그 방으로 가고 접힘(문서는 그대로), 창을 넓히면 나란히 | — | F-DL-02 | feature | ✅ |
| 루틴: 루틴 화면에 연 문서(메신저 · 카드가 여는 것과 같은 `app.setOfficeDoc`) — 같은 규칙, 「루틴 목록 펼치기」 | — | F-DL-03 | feature | ✅ |
| 채팅 · Home: 문서를 열면 Home 은 비킴(예전대로), 다시 열면 2000px 은 나란히 · 좁으면 채팅 위(Esc · Home 단추로 닫힘) | — | F-DL-04 | feature | ✅ |
| 채팅 · 대화 목록: 문서가 열려도 숨기지 않고 같은 규칙(「≡ 대화」), 펼쳐서 대화를 고르면 `/chat/c/:cid` · 접힘, 밤 테마 | — | F-DL-05 | feature | ✅ |
| 붙여 둔 메신저(오른쪽 · 왼쪽 2000px, 문서 패널 안 2000px, 오른쪽 1440 · 2600px): 페이지 폭 · 패널 폭으로 정함, 메신저와도 겹치지 않음 | PR #32 | F-DL-06 · DL-U-03 | feature · 단위 | ✅ |

### 40. 운영 화면 11-24 — 회의가 끝나면 회의록이 열린 대화에 바로 (회의 · 메신저)

「회의가 끝나면 회의가 끝난 회의록을 부착해주는데, 이게 곧바로 반영안되고 나갔다 들어와야 업데이트됨」. 회의 카드 · 「회의 자료」 · 최종 회의록은 회의 도우미가 방에 쓰는 행이라 대화방 피드(chats 트리거 → LISTEN)로만 열린 화면에 닿았는데, 게이트웨이 뒤(운영)의 피드는 기본 테넌트의 방만 보았다. 회의는 API 로 시작 · 자료 띄우기 · 끝내기(카메라 없음), 두 사람은 그 대화를 브라우저에 열어 둔다. 받아쓴 말이 없으면 회의록은 규칙으로 정리된다(모델 없음). 서버는 `PRO_BACKGROUND=0`(피드 없음)으로 띄워도 통과해야 한다 — 기록 행은 피드 없이 바로 간다. 다른 실행의 정리(`lib/teardown.js`)가 시험 계정을 팀에서 빼므로 시험 중에는 1초마다 팀에 다시 넣는다.

| 기능 요건 | 근거 | 시험 | 단계 | |
|---|---|---|---|---|
| 대화를 열어 둔 두 사람에게 회의 카드(「회의 중」) · 「회의 자료」 · 「회의가 끝났어요」 · 📝 회의록이 나갔다 들어오지 않아도 보임, 대화 목록 줄도 회의록, 보고 있는 대화엔 안 읽음 표시 없음 | 사용자 11-24 | F-MM-01 · `server/test/meetingRecordLive.test.js` RL-U-01 | feature · 단위 | ✅ |
| 메신저를 닫았다 열어도 · 새로 고쳐도 카드는 하나씩(메시지 id 로 합침, 여는 동안 실시간으로 온 것도 남음) | 사용자 11-24 | F-MM-01 · `server/test/messageMerge.test.js` MM-U-01~03 | feature · 단위 | ✅ |
| 회의에 들어오지 않은 방 사람에게도 기록 행이 실시간 메시지로, 같은 내용은 한 번, 「회의록이 생겼어요」(`meeting` · `minutes`)도 방 사람 모두에게 | 사용자 11-24 | F-MM-02 · RL-U-01 · 02 | feature · 단위 | ✅ |
| 게이트웨이 뒤: 기본 테넌트가 아닌 회사(Lite 를 쓰는 테넌트)의 방 행도 피드가 보냄, 한 서버는 맡지 않은 테넌트의 방을 여전히 안 보냄 | 사용자 11-24 | RL-U-03 · 04 | 단위 | ✅ |
| 운영(게이트웨이 · 실제 회의 화면에서 「회의 끝내기」) | — | — (배포 뒤 확인) | — | ◐ |

### 41. 채팅 입력창의 받아쓰기 — 켜 두면 끌 때까지 듣고, 저절로 보내지 않는다 (`src/useDictation.js`)

전에는 첫 쉼에서 인식이 끝났고, 마이크 자리에 보내기(↑)가 들어와서 이어 말하려고 다시 누르면 보내졌다. 브라우저의 음성 인식은 `addInitScript` 의 가짜(중간 · 확정 결과, 쉼 = `no-speech` 뒤 끝, 오류)로 바꾸고, 보내기(`POST /api/threads/*/messages`)는 가로채서 센다. 모델 · 마이크는 쓰지 않는다. 화면 사진은 `e2e/reports/voice-dictation/`(`RT_SHOTS` 로 바꿈).

| 기능 요건 | 근거 | 시험 | 단계 | |
|---|---|---|---|---|
| 누르면 켜짐(`continuous` · 중간 결과 · ko-KR), 「듣는 중…」 · `aria-pressed` · 「받아쓰기 멈추기」, 말이 들어와도 마이크는 그 자리(보내기는 왼쪽), 넓은 화면의 에이전트 칩과 겹치지 않음 | 사용자 11-24 | F-VD-01 · DV-U-02 | feature · 단위 | ✅ |
| 쉼(세션 끝)에도 꺼지지 않고 다음 세션이 이어 받아 적음, 확정된 말은 뒤에 붙고 들리는 중인 말은 그 뒤에 보임, 듣는 동안 손으로 고친 글은 남음 | 사용자 11-24 | F-VD-02 · DV-U-03~05 | feature · 단위 | ✅ |
| 마이크를 다시 누르면 멈추고 다시 켜지지 않음, 멈춘 뒤에도 마이크는 그 자리(이어 받아쓰기), 보내기 단추를 눌러야 한 번 보냄 | 사용자 11-24 | F-VD-03 · DV-U-06 | feature · 단위 | ✅ |
| 듣는 중 Enter: 받아쓰기를 먼저 끄고 보냄, 그 뒤에 들린 말은 비운 입력창에 돌아오지 않음 | 사용자 11-24 | F-VD-04 · DV-U-07 | feature · 단위 | ✅ |
| 길게 누르면(0.35초 넘게) 누르는 동안만, 떼면 멈춤 · 짧게 누르면 켜진 채 · 키보드 Enter · Space 로 켜고 끄기 · 손가락으로 길게 누르기 | 사용자 11-24 | F-VD-05 · 06 · DV-U-01 · 08 | feature · 단위 | ✅ |
| 휴대폰 390px 밝게 · 어둡게: 클립 · 보내기 · 마이크 · 「듣는 중…」 · 에이전트 칩이 겹치지 않고 화면 안, 긴 오류 문구는 따로 한 줄 | — | F-VD-06 | feature | ✅ |
| 받아쓰기는 보내지 않음(켜기 · 쉼 · 끄기 · 길게 누르기 · 오류를 거쳐도 보낸 요청 0) | 사용자 11-24 | F-VD-01~07 · DV-U-10 | feature · 단위 | ✅ |
| 오류: 마이크 권한은 끄고 까닭을 보여 줌, `aborted` · `no-speech` 는 이어 들음, 데스크톱 앱은 브라우저 인식기 대신 서버 받아쓰기(53절), 음성 인식도 마이크 API 도 없는 브라우저는 예전 안내 | — · 사용자 11-25 | F-VD-07 · DV-U-09 | feature · 단위 | ✅ |
| 실제 Chrome 음성 인식 · 실제 데스크톱 앱(Electron)에서의 받아쓰기 | — | — (가짜 인식기로만, 데스크톱은 `pgl-desktop` 를 붙여 흉내) | — | ◐ |

### 43. 서버 브라우저가 멈춘 것처럼 보이지 않는다 — 걸음마다 한도 · 「기다리는 중 …」 · 다시 시도 · 그만두기 (스펙 `browser-handoff` 「걸음마다 한도가 있고, 멈춘 것처럼 보이지 않는다」)

근거: 2026-11-24 사용자 보고 「이 작업을 시켰는데, 멈췄음... 브라우저가 먹통이 된」(계룡대 인근 숙소 검색) · 「순수 모바일에서는 이 작업이 가능해야」. 실제 사이트에서 다시 잰 전후 비교는 `openspec/specs/browser-handoff/e2e/results/server-browser-stall-1124.txt`. 시험 사이트는 `server/test/fixtures/heavy.mjs`(지어낸 숙소 · 카페, 인터넷 없음). F-BW-03·04 는 이 시험 프로세스 안에서 서버 모듈로 진짜 Chromium 작업을 돌리고(대본대로 답하지 않는 모델), 그 이벤트를 화면의 store 로, 카드의 단추 요청을 page.route 로 그 작업에 잇는다(모델 없음). 휴대폰 사진은 `BW_SHOTS=<폴더>`.

| 기능 요건 | 근거 | 시험 | 단계 | |
|---|---|---|---|---|
| 걸음마다 한도(`bounded`) · 취소는 cancel, 다시 시도는 retry 로 그 자리에서 끝남 | 사용자 11-24 | `browserSteps.test.js` | 단위 | ✅ |
| 끝나지 않는 페이지(load · networkidle 없음) · 문서가 끝까지 오지 않는 페이지 · 응답 없는 주소 · 실패한 이동 뒤 다음 이동 | 사용자 11-24 | `browserSteps.test.js` · `browser-stall.test.js` | 단위 · 통합 | ✅ |
| 아주 큰 페이지(노드 6만+)를 한도 · 크기 안에, 입력 칸 먼저, 지난 번호 없음, 내리면 새 글 | 사용자 11-24 | `browserSteps.test.js` | 단위 | ✅ |
| 화면 안의 iframe(다른 출처)을 읽고 그 안에서 누름, 1×1 추적 프레임은 건너뜀 | 실측 11-24(지도) | `browserSteps.test.js` · `browser-stall.test.js` | 단위 · 통합 | ✅ |
| 감시: 20초 움직임 없음 → 카드 `stall`, 다음 걸음에서 거둠, 사람을 기다리는 동안은 아님 | 사용자 11-24 | `browserSteps.test.js` · `browser-stall.test.js` | 단위 · 통합 | ✅ |
| 실시간 화면 초당 3장 · 느린 연결엔 쌓지 않음 · 긴 폴링 버퍼엔 마지막 프레임만 | 실측 11-24(초당 9.6장) | `browserSteps.test.js` · `browser-stall.test.js` | 단위 · 통합 | ✅ |
| 이 서버의 멈춘 Chromium 이 쥔 프로필 잠금만 풀기(자기 자신 · 다른 프로그램은 그대로) | 사용자 11-24 | `browserSteps.test.js` | 단위 | ✅ |
| 잠금 링크가 없는 프로필(headless shell): 세션의 브라우저 프로세스를 명령줄로 찾아 멈춤, 다른 프로세스는 그대로 | 사용자 11-24 | `browserSteps.test.js` | 단위 | ✅ |
| 사람의 승인을 기다리는 동안은 동작 하나의 한도에 들지 않음(결제 단추 → 승인 카드 → 늦게 승인해도 누름) | 회귀 방지 | `browser-stall.test.js` | 통합 | ✅ |
| 무거운 페이지에서 검색 → 정리가 25초 안 · 칸에 쓴 값을 기다리면 바로 · 일 없는 페이지에서는 기다리지 않음(판정) | 실측 11-24 | `browser-stall.test.js` | 통합 | ✅ |
| 모델이 답하지 않음 → 「기다리는 중 · AI 모델의 답」 → 다시 시도로 그 걸음만 / 그만두기 2초 안 · 다음 작업이 같은 브라우저 | 사용자 11-24 | `browser-stall.test.js` · F-BW-03 · F-BW-04 | 통합 · feature | ✅ |
| 렌더러가 답하지 않는 페이지 뒤의 작업은 새 탭(또는 새 브라우저)에서 | 사용자 11-24 | `browser-stall.test.js` | 통합 | ✅ |
| 같은 화면 · 같은 동작이 세 번 되풀이되면 사람에게 넘김(되풀이 감지, 화면이 바뀌는 되풀이만) | 실측 11-24(동작 40번) | `browser-stall.test.js` · `browser-vault.test.js` | 통합 | ✅ |
| 프레임 안의 목록은 그 안의 요소를 주고 내림(휠이 그 위에서) | 실측 11-24(지도) | `browser-stall.test.js` | 통합 | ✅ |
| 취소된 작업의 알약은 「취소함 · <제목>」, 줄 · 독 · 상태 줄이 사라짐 | 사용자 11-24 | F-BW-03 | feature | ✅ |
| 휴대폰(390): 멈춘 카드의 줄 · 흐르는 시간 · 두 단추가 화면 안, 단추가 그 카드의 작업으로 | 사용자 11-24 | F-BW-01 | feature | ✅ |
| 넓은 화면: 독 호박색 테두리 · 가운데 카드 · 확장 화면에도 줄, 움직이면 사라짐 | 사용자 11-24 | F-BW-02 | feature | ✅ |
| 실제 사이트(네이버 여행 · 숙소 검색 · 야놀자 · 네이버 지도 · 연합뉴스)를 사내 모델로 전후 비교 | 사용자 11-24 | `results/server-browser-stall-1124.txt` | 실측 | ✅ |

### 42. 파일 멘션 — 폴더 · 채팅 · 받은 파일을 끌어다 대화방에 링크로, AI 채팅에 질문으로, 폴더에 파일로 · 메신저의 @AI (스펙 `messenger-file-mention`)

메신저를 왼쪽에 붙이고 폴더 탭에서 「이력서」 폴더를 연 넓은 화면(사용자 11-24 화면)에서, 앱의 모든 파일(폴더 줄 · 채팅 카드 · 산출물 더미와 목록 · 받은 멘션과 공유 칩 · 회의 자료)이 같은 끌기 내용(`application/x-pgl-file`)으로 끌리고 세 곳(메신저 대화 · AI 채팅 입력창 · 폴더)이 받는다. 끌기는 Playwright 의 DataTransfer 끌기 이벤트로 시험한다 — `dragstart` 를 끄는 것에(화면이 끌기 내용을 싣는다), `dragenter` · `dragover` · `drop` 을 놓는 곳에. 서버는 가짜 모델(`PRO_LLM_BASE_URL=http://127.0.0.1:<RT_FAKE_LLM_PORT, 기본 59961>/v1`, `PRO_JUDGE_URL=`)과 가짜 deepagents(`PRO_DEEPAGENTS_URL=http://127.0.0.1:<RT_FAKE_AGENT_PORT, 기본 59962>`)로 띄우고, 둘 다 시험 파일이 띄운다. 띄우는 명령은 `openspec/specs/messenger-file-mention/e2e/README.md`. 사람 이름 · 파일은 지어낸 것이다(윤태호 · 서하린 · 한도윤, 「차은솔_이력서.docx」).

| 기능 요건 | 근거 | 시험 | 단계 | |
|---|---|---|---|---|
| 폴더 옆에 붙인 메신저: 파일 줄을 대화에 끌면 「여기에 놓으면 링크로 멘션해요」 → 「링크」 칩(폴더 이름) → ⌘ 로 고른 여러 줄 → 보내면 참조만(복사본 · 공유 없음), 받는 사람의 멘션 카드 → 문서 패널, 편집기 없는 형식은 폴더의 그 파일 | 사용자 11-24 | F-FM-01 · `server/test/fileMention.integration.test.js` | feature · 단위 | ✅ |
| 컴퓨터의 파일 놓기는 그대로 올라감(끌기 종류로 가림) | PR #31 | F-FM-02 · `fileMention.test.js` | feature · 단위 | ✅ |
| 「@」 목록에 「AI」와 대화의 사람들, AI 칩, 「@AI … 이력서 첨부해」 → AI 가 판정 모델로 고른 파일을 링크로 올림, 폴더를 못 읽는 사람은 이름으로 알림 | 사용자 11-24 | F-FM-03 · `fileMention.test.js` · `fileMention.integration` | feature · 단위 | ✅ |
| 부탁한 사람이 읽을 수 없는 폴더의 파일은 후보 · 판정 모델이 읽는 글 · 답 어디에도 없음, 찾지 못하면 그렇다고 답함, 대화방의 「AI 제안」은 다시 카드로 만들지 않음 | 사용자 11-24 | `fileMention.integration` | 단위 | ✅ |
| 권한 없는 사람: 「폴더 권한이 없어요 · 권한 요청」(열기 403, 바뀜 여부도 숨김) → 「권한을 요청했어요」 → 폴더 주인의 알림(그 사람이 골라진 공유 창), 같은 요청은 한 번, 구성원이 되면 열림 | 사용자 11-24 | F-FM-04 · `fileMention.integration` | feature · 단위 | ✅ |
| 멘션한 뒤 바뀐 파일: 「멘션한 뒤에 바뀌었어요 · 최신 열기」, 카드는 멘션한 때의 판, 최신은 main(편집자는 그 자리에서 고침) | 사용자 11-24 | F-FM-04 · `fileMention.integration` | feature · 단위 | ✅ |
| 채팅의 파일 카드 · 펼친 산출물 더미 · 오른쪽 목록을 대화에 끌면 「여기에 놓으면 공유해요」 → 「공유」 칩 → 지금의 공유(받는 사람의 사본) | 조정 11-24 | F-FM-05 | feature | ✅ |
| 폴더에서 연 카드 · 프로젝트가 폴더에서 만든 파일은 링크(프로젝트 변형이면 그 변형 · 구성원만 열림 · 「반영 전 변형」, 반영 뒤엔 main), 그 폴더 자신에는 넣지 않음(409) | 조정 11-24 | `fileMention.test.js`(카드의 종류) · `fileMention.integration`(폴더에서 연 카드 · 프로젝트 변형) | 단위 | ✅ |
| 받은 파일을 폴더에 끌면 「이 폴더에 넣기」 → 「‘<폴더>’에 넣었어요 · 열기」(내 이름의 커밋), 보기 권한이면 「편집 권한이 있어야 …」 · 403, 다른 폴더의 파일은 출처를 커밋 메시지에, 같은 내용은 다시 안 넣음 | 사용자 11-24(추가) | F-FM-06 · `fileMention.integration` | feature · 단위 | ✅ |
| 받은 멘션을 AI 채팅 입력창에 끌면 「AI에게 이 파일로 묻기」 → 칩 → 보낸 말에 칩, 에이전트가 받은 요청에 「folder_read 도구(folder, path)로 읽으세요」(가짜 deepagents 가 받은 본문으로 확인), 읽을 수 없으면 칩에 까닭(403) | 사용자 11-24(추가) | F-FM-07 · `fileMention.integration` | feature · 단위 | ✅ |
| 채팅의 파일 카드를 프로젝트의 폴더 막대에 끌면 그 폴더에 들어감 | 사용자 11-24(추가) | F-FM-08 | feature | ✅ |
| 휴대폰 390px: 멘션 카드 · 「@」 목록 · AI 칩이 화면 안, 옆으로 넘치지 않음, 카드를 누르면 문서 패널 | 사용자 11-24 | F-FM-09 | feature | ✅ |
| 휴대폰 390px 채팅 입력창: 놓은 파일 칩 · 에이전트 고르기 줄(#41) · 보내기와 마이크(#44, 마이크가 끝)가 겹치지 않음, 밝은 · 밤 | 합치기 11-24 | F-FM-10 | feature | ✅ |
| 확인 중인 칩은 기다렸다가 그 말과 함께, 다른 보내기 길은 입력창의 칩을 안 가져감, 빈 요청 400 · 쓸 수 없는 파일만이면 에이전트에 안 감, 파일 하나가 실패해도 나머지는 감 | PR #45 리뷰 | F-FM-11 · `fileMention.integration`(리뷰 7) | feature · 단위 | ✅ |
| 권한 요청 알림으로 연 공유 창은 한 번만(닫으면 다시 안 열림) · 변형의 파일은 「변형 「이름」 · 반영 전」 | PR #45 리뷰 | F-FM-04 · F-FM-12 | feature | ✅ |
| 페이지가 보낸 blob 은 그 경로의 판일 때만(다른 파일의 내용을 이름만 빌려 열 수 없음) · 내가 보낸 공유도 폴더에 · @AI 가 다시 붙인 공유는 원래 주인의 것 · 「@AI」 메시지를 쓴 사람에게 권한 요청 알림 · 회의의 더 고른 자료도 분당 한도 안 | PR #45 리뷰 | `fileMention.integration`(리뷰 2 · 4 · 6 · 8) · `fileMention.test.js`(리뷰 10) | 단위 | ✅ |
| 입력창에서 「… · 내 PC」 에이전트를 골라 보내면 놓은 파일은 사본 주소로 그 CLI 에(폴더 도구가 없음), 보낸 말에 칩 | 합치기 11-24 | `fileMention.integration`(사본 주소) | 단위 | ◐ |
| 폴더 화면처럼 채팅을 거치지 않은 화면의 붙인 메신저도 실시간(AI 의 답 · 「AI가 찾는 중…」) | — | F-FM-03 | feature | ✅ |
| 회의 도우미의 자료 고르기 · 일 종류가 @AI 와 같은 함수(`assistHelp.js`) | 사용자 11-24 | `fileMention.test.js` · 회귀 `meetings.spec.js` · `meetingAnswers.test.js` | feature · 단위 | ◐ |
| 실제 판정 모델로 「… 이력서 첨부해」의 정확도, 이음오피스 호스트에서 연 문서의 화면, 회의 자료 카드에서 끌기, 프로젝트 변형 파일을 화면에서 끌기 | — | — (가짜 모델 · 이음오피스 호스트 없음 · 회의는 WebRTC 가 필요) | — | ✗ |

### 44. 로그인 벽에서 보관함 먼저 — 저장된 로그인이면 사람 없이 넣어 들어가고, 없으면 카드에 저장하거나 직접 로그인 (스펙 `browser-handoff` 「보관함의 로그인으로 로그인 벽을 넘는다」)

근거: 2026-11-24 휴대폰 사진(네이버 예약 → nid.naver.com 로그인 화면, 「직접 로그인」만) · 「로그인이 왜 vault 를 이용하여 암호관리를 호출하지 않는것인가」. 서버 흐름은 진짜 Chromium · 실제 DB · 대본대로 움직이는 모델 · 가짜 판정 서버 · 지어낸 로그인 사이트(`server/test/fixtures/loginWall.mjs`, login.fixture.test — 브라우저 안에서 답하고 밖으로 나가지 않음)로 `server/test/browser-wall-vault.e2e.mjs` 가 확인합니다. 진짜 계정은 쓰지 않습니다. 화면은 카드 내용을 DB 에 두고 휴대폰(390)에서 봅니다(모델 없음). 휴대폰 사진은 `LV_SHOTS=<폴더>`. 네이버 공개 로그인 화면에서 `fill()` 과 키 입력을 지어낸 값으로 비교한 기록(네트워크를 막아 로그인 시도 없음)은 `openspec/specs/browser-handoff/e2e/results/login-wall-vault-1124.txt`.

| 기능 요건 | 근거 | 시험 | 단계 | |
|---|---|---|---|---|
| 로그인 벽 + 저장된 로그인(상위 도메인 fixture.test) → 사람을 부르지 않고 넣어 보내고, 로그인한 화면에서 모델이 이어서 함(`needs_input` 없음, 보관함 · 고르기 카드 없음) | 사용자 11-24 | `browser-wall-vault.e2e.mjs` | 통합 | ✅ |
| 아이디 · 비밀번호를 키로 하나씩(칸이 받은 keydown 수), 값이 든 칸이 화면에 가려지지 않은 순간 없음, 카드의 `signingIn` 을 두었다가 거둠, 상태 줄 「보관함의 로그인으로 들어가는 중 · fixture.test」, 감사 기록 fill 두 줄 | 사용자 11-24 · 네이버 칸 실측 | `browser-wall-vault.e2e.mjs` | 통합 | ✅ |
| 같은 회사의 다른 하위 도메인(app.fixture.test 에 저장 → login.fixture.test), 상위 도메인이 먼저, 여럿이 쓰는 호스팅(github.io)의 이웃에는 안 줌, `ownerDomain`(naver.com · shop.co.kr · 주소 · localhost) | 사용자 지시 | `browser-wall-vault.e2e.mjs` | 통합 · 단위 | ✅ |
| 저장된 로그인 없음 → `need: login` · 저장하거나 직접 로그인하라는 이유 · 보관함 요청 카드(login/request/login.fixture.test), 카드에 저장하면 바로 넣어 이어서 함(모델은 로그인 뒤에만) | 사용자 11-24 | `browser-wall-vault.e2e.mjs` | 통합 | ✅ |
| 넣은 뒤 사람 확인 → 「보관함에 저장된 로그인 정보로 …에 로그인하려 했는데, …에서 사람인지 확인하는 절차를 추가로 요구해요 …」, 확인 화면의 비밀번호 칸에 보관함의 것을 다시 넣어 둠, 사람이 직접 제어로 확인하면 저절로 이어짐 | 사용자 지시 | `browser-wall-vault.e2e.mjs` | 통합 | ✅ |
| 틀린 비밀번호 → 항목 거부됨 · 보관함의 고침 카드(update, itemId · 아이디 이름표) → 고치면 다시 넣어 이어서 함(감사: create · reject · update) | 사용자 지시 | `browser-wall-vault.e2e.mjs` | 통합 | ✅ |
| 인증 코드 → 모델이 지금 화면(코드 화면)을 보고 코드 카드(`need_secret`) → 사람이 넣은 코드로 이어서 함 | 사용자 지시 | `browser-wall-vault.e2e.mjs` · 메일에서 찾기는 `browser-mail-otp.test.js` | 통합 | ✅ |
| 비밀번호 · 틀린 비밀번호 · 코드가 이벤트 · 서버 로그 · 모델 요청 · 판정 요청에 없음, 아이디도 모델 · 판정 요청에 없음 | 사용자 지시 | `browser-wall-vault.e2e.mjs` | 통합 | ✅ |
| 실시간 화면 프레임(OCR, tesseract 가 있을 때): 같은 글꼴의 대조 낱말은 읽히고, 입력 중 프레임의 아이디 칸은 가려진 점들, 아이디 · 비밀번호는 어느 프레임에도 없음 | 사용자 지시 | `browser-wall-vault.e2e.mjs` | 통합 | ✅ |
| 로그인 단추만 있는 첫 화면 → 모델이 폼으로, 그곳(스킬 `sign_in` 의 호스트)의 폼에서는 보관함이 넣고 Enter 로 안 보내지는 폼은 모델이 단추만 누름, 지난번 거부된 비밀번호는 고친 뒤에 | 회귀 | `browser-walls.e2e.mjs` | 통합 | ✅ |
| 휴대폰 390: 「보관함의 로그인으로 들어가는 중 · naver.com」 줄이 채팅 카드와 확장 화면에 | 사용자 지시 | F-LV-01 | feature | ✅ |
| 휴대폰 390: 저장된 로그인 없음 — 이유 · 「직접 로그인」 · 「로그인 정보 저장」(보관함 카드로 스크롤) · 「멈추기」가 화면 안, 직접 제어 화면에서 보관함 카드가 이유 아래(겹치지 않음) | 사용자 지시 | F-LV-02 | feature | ✅ |
| 휴대폰 390: 틀린 비밀번호의 이유와 고침 카드(새 비밀번호 · 다시 로그인), 저장 단추 없음 | 사용자 지시 | F-LV-03 | feature | ✅ |
| 휴대폰 390: 넣은 뒤 추가 확인의 이유와 「직접 로그인」 | 사용자 지시 | F-LV-04 | feature | ✅ |
| 실제 네이버에서 키 입력으로 로그인이 통과하는지(자동입력 방지 문자 없이) · 실제 판정 모델이 로그인 뒤 화면을 고르는 정확도 | — | — (진짜 계정으로 로그인하지 않음 · 가짜 판정) | — | ✗ |

### 45. 메일에 답장만 하지 않는다 — 시트의 할 일 줄 · 이 회사 알아보기 · 채팅에서 이어서 · 메일을 멘션으로 (스펙 `mail-card-actions`)

휴대폰의 답장 시트(원문 · 받는 사람 · 참조 · 제목 · 본문 · 파일 첨부 · 다시 쓰기 · 보내기뿐)를 보며 사용자가 한 말: 「메일에 대해서 무조건 답장만 하지는 않는다. 그 회사에 대해서 추가적으로 알아볼 수 도 있고.. 기타 액션을 할 수 있어야 하는데... 채팅에 멘션해서 뭔가 후속 작업을 할 수 있어야하는디」. 서버는 가짜 모델(`PRO_LLM_BASE_URL=http://127.0.0.1:<RT_FAKE_LLM_PORT, 기본 59981>/v1`)과 가짜 deepagents(`PRO_DEEPAGENTS_URL=http://127.0.0.1:<RT_FAKE_AGENT_PORT, 기본 59982>`)로 띄우고, 둘 다 시험 파일이 띄우므로 한 워커로 돈다(`mode: 'serial'`, `RT_WORKERS=1`). 메일함은 데모 메일함(보내지 않음), 끌기는 DataTransfer 끌기 이벤트로 시험한다. 띄우는 명령은 `openspec/specs/mail-card-actions/e2e/README.md`. 사람 · 회사 · 메일은 지어낸 것이다(한지우 · 서민재, 하늘데이터 윤서진).

| 기능 요건 | 근거 | 시험 | 단계 | |
|---|---|---|---|---|
| 답장 시트: 원문 아래 「이 메일로 · 이 회사 알아보기 · 채팅에서 이어서 · (판정 모델이 고른) 회의 잡기 · 제안서 초안」 한 줄, 그 아래 답장이 그대로(고쳐서 보내면 「기록했어요」) | 사용자 11-24 | F-MF-01 · `server/test/mailFollow.integration.test.js` | feature · 단위 | ✅ |
| 알약은 무엇을 할지 먼저 말하고(무엇을 읽고 · 결과가 어디에 · 보내지 않음) 그 단추를 눌러야 실행, 여는 것만으로는 에이전트 · 보내기 · 만들기 없음 | 사용자 11-24 | F-MF-01 · F-MF-06 | feature | ✅ |
| 다음 할 일은 판정 모델이 스킬의 목록에서(첫 글자 확률 · 문턱 · 셋까지 · 「그 밖」 제외 · JSON 대체 · 카드에 남아 다시 묻지 않음 · 판정 모델이 없으면 고정 둘만 · 프로세스 시작은 지도가 읽었을 때만 · 폴더에 정리는 첨부가 있을 때만) | — | `mailFollow.test.js` · `mailFollow.integration` | 단위 | ✅ |
| 「이 회사 알아보기」 → 「하는 중…」 → 「회사 알아본 결과 · 열기」(시트 · Home 카드) → 그 메일의 대화(요청 · 메일 칩 · 답), 대화 목록에 「haneul-data.example 알아보기」 | 사용자 11-24 | F-MF-02 · `mailFollow.integration` | feature · 단위 | ✅ |
| 에이전트 요청에 메일의 맥락(보낸 사람 · 받은 때 · 제목 · 첨부 · Gmail 스레드 링크 · 본문, 본문은 자료로)과 「Lite 가 아는 것」(같은 도메인의 이전 메일), 메일을 보내지 말라는 지시, 다시 눌러도 한 번 | — | F-MF-02 · `mailFollow.integration` | feature · 단위 | ✅ |
| 인스턴스에 이어진 메일: 그 인스턴스 대화에서 돌고 작업 폴더에 `조사/01_<날짜>_….md`(다음 단계가 읽음), 메인 채팅에는 없음 | 스펙 mail-thread-flow | `mailFollow.integration` | 단위 | ✅ |
| 「채팅에서 이어서」 → 채팅 입력창의 메일 칩(봉투 · 제목 · 보낸 사람) → 「이 제안 검토해서 장단점 정리해 줘」 → 에이전트가 메일을 맥락으로 받음, 보낸 말의 칩은 시트를 다시 엶 | 사용자 11-24 | F-MF-03 · `mailFollow.integration`(runTurn) | feature · 단위 | ✅ |
| Home 카드 · 시트 손잡이를 AI 채팅에 끌면 「AI에게 이 메일로 묻기」 → 칩(같은 메일은 한 번), 끄는 동안 시트가 흐려짐 · 남의 메일은 404 | 사용자 11-24 | F-MF-04 · `mailFollow.integration` | feature · 단위 | ✅ |
| 메신저에 끌면 「여기에 놓으면 메일을 멘션해요」 → 메일 칩(「본문도 공유」 꺼짐) → 동료는 요약만(본문 없음, 열기 403) → 「본문 보기 요청」(주인에게 알림 한 번) → 주인이 「본문 공유」 → 동료가 본문을 봄, 방 밖 404 · 공유를 그만두면 403 · 방에 본문을 저장하지 않음 | 사용자 11-24 · 결정(권한) | F-MF-05 · `mailFollow.integration` · `mailFollow.test.js` | feature · 단위 | ✅ |
| 「동료에게 공유」 → 메신저가 열려 메일이 대화를 기다림 → 대화를 고르면 메일 칩 | — | F-MF-07 | feature | ✅ |
| 휴대폰 390px 밝은 · 밤: 할 일 줄은 한 줄(옆으로 넘김), 페이지가 넘치지 않음, 할 일의 말 · 단추가 화면 안, 답장 보내기 | 사용자 11-24 | F-MF-06 | feature | ✅ |
| 실제 모델 · deepagents 의 회사 조사 결과, 에이전트가 「보내지 마세요」를 지키는지(지시일 뿐), 영어 화면 스크린숏, 사람 손의 실제 끌기 | — | — (가짜 모델 · 가짜 deepagents) | — | ✗ |

### 46. BPMN 흐름도의 화살촉 — 밝은 테마와 밤 테마에서 모든 흐름이 촉으로 끝난다 (스펙 `map-case-view` 「흐름도의 흐름은 화살촉으로 끝난다」)

사용자 보고(2026-11-25): 밤 테마의 인스턴스 다이어그램에서 흐름이 모두 촉 없는 선으로 보였다(「마커 촉이 어디로 날라갔니?」). bpmn-js 는 흐름마다 화살촉(`<marker>`)을 그 흐름의 그림 안 `<defs>` 에 자기 기본색(거의 검정)으로 그린다. 화면의 테마 CSS 는 선만 칠해서 촉이 어두운 칸에 묻혔다. 이제 bpmn-js 의 기본색이 CSS 변수다(`src/lib/bpmnInk.js`). 그래서 촉이 그 흐름의 선과 같은 잉크로 칠해지고 테마가 바뀌면 바로 따라간다. 시험이 스택을 따로 띄운다(`lib/localStack.js`, 테넌트 `bpmnarrow-ui`, 8910 · 5310 부터). 모델 · 공유 서비스는 없고, 사람은 지어낸 이름이다. 명령과 읽는 방법은 `openspec/specs/map-case-view/e2e/README.md` 「화살촉 시험」에 있다.

| 기능 요건 | 근거 | 시험 | 단계 | |
|---|---|---|---|---|
| 정의가 있는 인스턴스의 다이어그램(담당자 · 고객 · 프로젝트 관리 · 주임 레인, 「… 다음」 배타 갈림, 병렬 갈림, 끝): 순서 흐름 15개의 `marker-end` 가 같은 문서의 `<marker>` 하나를 가리킨다. 촉은 선과 같은 잉크이고, 밝은 테마에선 어둡게 · 밤 테마에선 밝게 보인다. 다시 그리지 않고 테마를 바꿔도, 처음부터 밤으로 열어도 같다 | 사용자 11-25 | F-BA-01 | feature | ✅ |
| 메시지 흐름(시작 동그라미 · 끝 화살촉) · 방향 있는 연관 · 데이터 연관 · 조건 흐름의 마름모 · 기본 흐름의 빗금이 두 테마에서 보인다 | — | F-BA-02 | feature | ✅ |
| 지도에서 바로 도는 건의 흐름도: 건이 간 굵은 선의 촉은 진하고 가지 않은 길의 촉은 흐린 선의 색이다. 「크게 보기」(Teleport)에서도 촉이 있다 | 사용자 11-25 | F-BA-03 | feature | ✅ |
| 프로세스 개선(HeatBpmn)의 병목 열지도 · 크리티컬 패스: 모든 흐름에 촉이 있고, 크리티컬 패스의 주황 선은 주황 촉이다 | — | F-BA-04 | feature | ✅ |
| 운영 기준 경로 `/lite/` 빌드에서 촉이 같은 문서의 `<marker>` 를 가리킨다 | — | 손으로 한 번(`map-case-view/e2e/README.md`) | — | ◐ |
| 지도의 건 패널 · 프로세스 정의 카드 · 마이닝 미리보기(같은 `BpmnView`) | — | — (같은 부품, 따로 시험 없음) | — | ◐ |

### 47. 대화 속 그림 · 소리 · 영상 — 그 자리에서 보고 듣고, 편집기는 편집할 때만 (스펙 `chat-media-preview`)

운영 메신저(11-25, 휴대폰 폭 · 밤 테마)에서 받은 `download.m4a` 는 회색 FILE 칩과 빨간 「⚠ 앱 안에서 열 수 없는 형식이에요」, 공유된 `image.png` 는 IMG 칩과 「⚠ 이 설치에는 PhotoCraft 앱이 없어…」뿐이었다. 사용자: 「대화창안에서 기본적인 음성 / 이미지가 미리보기 등의 출력이 안되다니.. 포토크래프트등의 편집기는 편집의 의도가 있을따만 시도하는 것이고.」 `chat-media-preview.spec.js` 는 38절처럼 자기 스택(BFF `PRO_BACKGROUND=0` + Vite, 회사 `chatmedia-ui`, 8900 · 5300 부터 빈 포트)을 띄우고 지운다. 모델 · 공용 서비스는 부르지 않는다. PhotoCraft 는 시험용 껍데기(`PRO_CRAFT_WEB_ROOT` 에 캔버스 하나 — 놓인 파일 이름을 적어 둠)이고, 「PhotoCraft 가 없는 설치」는 `/api/config` 의 `craft` 를 바꿔 본다. 그림 · m4a · mp4 는 ffmpeg 로 만든 진짜 파일이다(Chrome 채널: AAC · H.264 재생). 사람은 지어낸 이름(윤태호 · 한지민 · 서민재). 화면 사진은 `openspec/specs/chat-media-preview/e2e/results/`, 명령은 `openspec/specs/chat-media-preview/e2e/README.md`.

| 기능 요건 | 근거 | 시험 | 단계 | |
|---|---|---|---|---|
| 그림 · 소리 · 영상인지: 저장된 형식(MIME) 먼저, 없거나 `octet-stream` 이면 확장자(이름 → 주소), 브라우저가 못 그리는 PSD · HEIC 는 아님(TIFF 는 앱이 그림 — 아래 줄), 칩은 IMG · AUD · VID | 사용자 11-25 | `server/test/openPlan.test.js` · `tiff.test.js` · F-MP-01 · 05 | 단위 · feature | ✅ |
| 메신저: 그림 미리보기(불러와짐 · 240px 안 · 비율 · 테두리가 그림 크기 · lazy), m4a 재생 막대(길이), mp4 플레이어(playsinline · 길이), 경고 상자 없음 | 사용자 11-25 | F-MP-01 | feature | ✅ |
| 미리보기 · 칩을 누르면 앱의 보기 화면(편집기 · 문서 패널 아님): 그림 누르면 원래 크기 · 다시 누르면 맞춤, Esc · 바깥 누르기 · ✕로 닫힘, 떠 있는 메신저는 그대로 | 사용자 11-25 | F-MP-02 · 07 | feature | ✅ |
| 「PhotoCraft 로 편집」은 그 설치에 PhotoCraft 가 있을 때만 — 누르면 문서 패널에 PhotoCraft, 받은 사람의 사본이 앱으로 들어감 · m4a(편집기 없음) · mp4(이 설치에 FilmCraft 없음)에는 단추 없음 | 사용자 11-25 | F-MP-02 · 03 · 04 · `openPlan.test.js`(edit) | feature · 단위 | ✅ |
| PhotoCraft 가 없는 설치: 그림은 그대로 보기 화면, 편집 단추 · 「PhotoCraft 앱이 없어」 없음 · 볼 수 없는 zip 은 차분한 안내(경고 색 · 표시 없음)와 「새 창에서 열기」 | 사용자 11-25 | F-MP-04 · `openPlan.test.js` | feature · 단위 | ✅ |
| AI 채팅의 파일 카드: 미리보기 · 재생 막대(preload none) · 영상, 「눌러서 크게 보기」 · 「눌러서 열기」, 카드 → 보기 화면 → 「PhotoCraft 로 편집」 → PhotoCraft | 사용자 11-25 | F-MP-05 · F-NB-04 · 07 | feature | ✅ |
| 미디어 주소: 받은 사람 · 보낸 사람만 200, 대화방 밖 404 · 로그인 없이 401, 대화방이 받는 메시지에 저장소 열쇠 없음, 구간 요청 206, 형식 없이 저장된 m4a 는 `audio/mp4`, `inline=1` 은 그림 · 소리 · 영상만(zip 은 내려받기), CSP sandbox · nosniff | 결정(권한 그대로) | F-MP-01 · 06 · team-sharing · F-MD-01 | feature | ✅ |
| 화면이 쓰는 주소에 로그인 토큰 없음: 공유 · 사람에 묶인 15분 서명 주소(`u` · `exp` · `inline` · `sig`, 서버만의 HMAC 키), 메시지에 실려 옴 · 만료나 불러오기 실패면 `GET …/link` 로 새로, 바꾼 주소 403 · 만료 401 · 다른 사람으로 맞게 서명해도 404 · 다른 회사 403, 화면의 모든 그림 · 소리 · 영상 주소와 링크에 `token=` · `eyJ…` 없음 | 검토 11-25 | `server/test/mediaLink.test.js` · F-MP-01 · 02 · 06 · 07 · 08 | 단위 · feature | ✅ |
| 서명이 맞아도 권한은 다시: 팀에서 빠지면 403(돌아오면 200), 공유를 거두면 받은 사람 · 보낸 사람의 주소 모두 404, 화면의 미리보기는 경고 없이 「미리 볼 수 없어요」 | 검토 11-25 | F-MP-08 | feature | ✅ |
| 휴대폰 390px 밝은 · 밤: 미리보기 · 재생 막대 · 영상이 메시지 안, 옆으로 넘치지 않음, 보기 화면의 닫기 · 새 창 · 편집 단추가 화면 안 | 사용자 11-25 | F-MP-07 | feature | ✅ |
| **TIFF · 팩스**(운영 11-25 「tif 파일을 웹에서 못 열어보나?」): 메신저 미리보기는 첫 쪽(작게 · 「2쪽」 · 캔버스에 검은 점), 보기 화면 ‹ 1 / 2 › → 2쪽(다른 그림) · ← · 누르면 확대 · 「내려받기」, 204 × 98 dpi 는 두 배 높이(1728 × 2290), 읽는 폭 860px 까지, 해독기는 TIFF 가 화면에 나올 때만 받음 | 사용자 11-25 | F-MP-09 · `tiff.test.js` | feature · 단위 | ✅ |
| 손상된 TIFF · 5만 × 5만이라 적힌 TIFF: 해독하지 않고 차분한 「이 TIFF 는 열 수 없어요 · 내려받기」(미리보기 · 보기 화면, 큰 것은 「너무 큰 TIFF 예요」), 고리 진 디렉터리 · 값이 너무 많은 태그 · 쪽 수 상한 거절, 끝나지 않는 해독은 작업자를 멈춤 | 사용자 11-25 | F-MP-09 · `tiff.test.js` | feature · 단위 | ✅ |
| AI 채팅의 팩스 카드: IMG · 「눌러서 크게 보기」 · 첫 쪽 미리보기 → 보기 화면 2쪽, 편집 단추 없음 · 채팅 첨부의 TIFF 는 서버가 쪽마다 PNG(비공개 버킷 `chat/<회사>/<사람>/<업로드>/page-<n>.png` 서명 주소 · 작업 공간이면 같은 폴더), 손상된 것은 `pagesError` · 에이전트에게 넘기는 말은 이 업로드의 쪽 그림만 | 사용자 11-25 | F-MP-10 · `tiff.test.js` | feature · 단위 | ✅ |
| 팩스 · 휴대폰 390px 밝은 · 밤: 미리보기가 메시지 안, 보기 화면에서 한 쪽이 화면 폭에 맞아 통째로(쪽 넘기기 단추 위), 단추가 화면 안, 옆으로 넘치지 않음 | 사용자 11-25 | F-MP-11 | feature | ✅ |
| TIFF 를 Safari · iPhone 에서 · 공유 폴더 미리보기(`FileView` → `TiffView` inline)를 화면으로 · 운영 저장소에서 | — | — (Chrome 으로만 · 폴더 미리보기는 같은 부품, 따로 화면 시험 없음) | — | ◐ |
| 운영 저장소(Supabase)의 실제 주소 · 큰 영상의 넘겨 보기 · iPhone Safari 재생 · 영어 화면 | — | — (로컬 저장소 · Chrome 으로만) | — | ✗ |

### 48. 프로젝트 안의 주제 — 프로젝트의 메시지도 판단 모델이 그 프로젝트의 주제로 나눈다 (스펙 `project-room` 「프로젝트 안의 주제」)

사용자(11-25): 「홈 채팅에서 주제를 자동 분류하듯이 하나의 프로젝트 내에서도 서브 레벨로 주제들이 자동 분류될 수 있어야 한다」. 프로젝트의 메시지마다 Lite 가 맥락 라우터(`POST /route`)에 그 프로젝트의 주제만 후보로 주고, 사용자 자리에는 프로젝트의 열쇠(`<사람>/project/<프로젝트>`)를 준다. 주제마다 에이전트 대화가 따로이고 `context_threads` 에 그 열쇠로 남는다(SQL 변경 없음). `project-topics.spec.js` 는 자기 스택(BFF `PRO_BACKGROUND=0` + Vite, 회사 `projtopics-ui`, 8940 · 5340 부터 빈 포트)과 이 파일이 띄우는 가짜 셋(맥락 라우터 :8947 — 메시지의 낱말로 정함, deepagents :8948, 모델 :8949 — 채팅 라우터는 늘 DELEGATE)으로 돈다. 공용 deepagents · completion · 맥락 라우터 · 판단 서버는 부르지 않는다(판단 서버 · MCP 허브 · 온톨로지는 `127.0.0.1:9`). 지어낸 사람은 한서윤. 화면 사진은 `openspec/specs/project-room/e2e/results/`, 명령은 `openspec/specs/project-room/e2e/README.md`.

| 기능 요건 | 근거 | 시험 | 단계 | |
|---|---|---|---|---|
| 프로젝트의 메시지는 그 프로젝트의 주제 가운데서 나뉨 — 라우터의 후보는 이 프로젝트의 주제와 진행 중인 요청뿐(메인 채팅 · 다른 프로젝트 없음), 사람의 말만, 새 주제는 새 대화, 이어지는 말은 그 대화 | 사용자 11-25 | F-PS-01 · PT-U-02~05 | feature · 단위 | ✅ |
| 주제의 기록(제목 · 요약 · 요지 · 요청 수)은 프로젝트의 열쇠로, 메인 채팅의 대화 목록(`/api/conversations`)에 섞이지 않음, `GET /api/threads/:id/topics` | — | F-PS-01 · PT-U-01 · 06 | feature · 단위 | ✅ |
| 채팅 위 「주제 N개 · 주제별로 보기」(둘 이상일 때만), 왼쪽 목록에서 열린 프로젝트 아래 한 단계 들여 쓴 주제 행, 답 위 「↳ 새 주제 · …」 | 사용자 11-25 | F-PS-01 · 03 · PT-U-09 · 10 | feature · 단위 | ✅ |
| 메시지마다 주제: 답 · 그 턴의 카드는 그 대화, 다음 메시지 뒤에 온 앞 턴의 카드는 앞 주제 | — | F-PS-01 · PT-U-08 | feature · 단위 | ✅ |
| 주제 하나로 좁히기(`/projects/:id/t/:주제` — 막대 · 왼쪽 행 · 답 위 표시), 「이 주제의 산출물」, 거기서 보낸 말은 라우터 없이 그 주제로, 「전체」 | 사용자 11-25 | F-PS-02 · 03 · PT-U-11 | feature · 단위 | ✅ |
| 주제가 생기기 전의 프로젝트: 원래 대화가 프로젝트 이름의 첫 주제(라우터가 답했을 때만 기록) | — | F-PS-04 | feature | ✅ |
| 폴더에서 일하는 프로젝트: 변형은 하나, 턴의 작업 폴더는 그 턴의 주제 대화 안, 턴은 한 번에 하나 | — | F-PS-07 · PT-U-07 | feature · 단위 | ✅ |
| 라우터가 닿지 않거나 없으면 예전처럼(프로젝트가 서 있는 대화, 실패 답 없음, 기록 없음, 막대 없음) | — | F-PS-08 · PT-U-02 | feature · 단위 | ✅ |
| 휴대폰 390px(밝은 · 밤): 막대 · 주제 창이 화면 안, 옆으로 밀리지 않음, 고르면 그 주제 · 밤 테마의 고른 행 | — | F-PS-05 · 06 | feature | ✅ |
| 실제 판단 모델이 프로젝트 메시지를 나누는 품질 | — | — (가짜 라우터만) | — | ✗ |

### 49. 문서에서 고른 부분을 채팅으로 고친다 — 입력창의 칩 · 라이브 MCP 로 그 자리만 · 문서의 대화에 · 적용 안 된 편집은 그렇다고 (스펙 `office-live-edit`)

사용자 보고(2026-11-25, 운영 녹화 「화면 기록 오전 6.57.42」): 회의록_템플릿.docx 의 표 글씨를 골라 「중앙정렬」이라고 보냈더니 에이전트는 「세로 정렬을 중앙으로 맞췄습니다」라고 했지만 문서는 그대로였다. 그 요청은 「새 주제」로 갔고, 다음 요청 중에는 「연결 안 됨」이 떴다. 편집기 안의 「AI 수정 요청」(지금 보내기 · 대기열에 추가)은 Lite 에서 숨겨 둔 편집기 자체 AI 로만 가서 채팅에 아무것도 남지 않았다. 지금은 이렇게 동작한다. 편집기(office-host `page-live.mjs`)가 고른 부분을 알린다(`{type:'selection'}`). 입력창은 그것을 칩으로 보인다(`src/docSelection.js`). 메시지가 그 자리(블록 · 표 칸 범위)를 에이전트에 넘긴다. 에이전트는 Lite 의 `/mcp/ieumoffice-live-editor` 로 그 칸만 고친다. 편집기가 「바뀐 곳 없음」이라 한 편집은 답에서 그렇다고 말한다(`server/lib/officeEdits.js`). 「AI 수정 요청」은 Lite 안에서만 숨긴다.

시험은 자기 스택을 띄운다(`lib/localStack.js`, 테넌트 `office-ask`, 8950 · 5350 부터). 실제 이음오피스 편집기도 이 시험이 따로 띄운다(`lib/officeHost.js`, 5395 부터, `RT_OFFICE_HOST_DIR` = 빌드한 process-gpt-office-host). 가짜 deepagents 겸 가짜 맥락 라우터는 실제 Lite MCP 를 사용자 토큰으로 부른다. 라우터는 요청마다 「새 주제」를 고른다. 시험과 Vite 사이의 프록시는 서버가 사라졌다 돌아오는 상황을 흉내 낸다. 모델은 쓰지 않는다. 사람(한서윤)은 지어낸 이름이다. 화면 사진은 `openspec/specs/office-live-edit/e2e/results/`.

두 번째 보고(2026-11-25 12:57, 스크린샷): 「@표 1 · 1~3행 1~4열 "회의명 일시 장소/방식 작성자 참석자"」를 골라 「글씨가 표 위에 붙어있다. 중앙정렬」이라고 보냈다. 편집기는 「setTableCellFormat: 10」을, 검수는 「편집기 확인 … ✓」를 보였지만 글씨는 칸 위에 그대로였다. 행 높이 없이 문단 아래 간격(문서 기본값 200 twips)만으로 높은 칸이라 가운데로 옮길 자리가 없었고, 에이전트가 함께 보낸 문단 간격 0 은 선택의 from·to(칸 하나)에만 갔다. 지금은 office-host 가 세로 정렬을 바꾼 칸의 문단 위아래 간격을 정렬대로 옮기고(칸 높이는 그대로), 편집 뒤 문서를 다시 읽어 결과에 `check`(칸의 vAlign · fill · borders 와 글이 놓인 자리, 문단의 값과 화면 정렬)를 싣는다. Lite 는 그것으로 요청한 서식이 문서에 있는지 보고(`server/lib/officeEdits.js`), 없으면 에이전트에 오류로, 답은 「반영되지 않았어요」로 바꾼다. 표 선택은 고른 칸을 행마다 덮는 `textRanges` 를 함께 넘긴다. 재현 문서는 `fixtures/meeting-minutes-labels.py`(python-docx 기본값, 운영 문서와 같은 꼴).

```bash
RT_OFFICE_HOST_DIR=/path/to/process-gpt-office-host npx playwright test --project=feature tests/feature/office-ask.spec.js
# 포트를 정해 돌릴 때: RT_OA_PORTS=<BFF>,<Vite>,<office host>,<가짜 서버들>  (기본 8950,5350,5395,8955)
cd ../server && node --test test/officeAsk.test.js test/officeEdits.test.js test/live-links.test.js
```

| 기능 요건 | 근거 | 시험 | 단계 | |
|---|---|---|---|---|
| 표 칸을 고르면 입력창에 「@표 1 · 3행 2열 "…"」 칩. 보내면 메시지 앞에 붙고 칩은 사라진다. 에이전트 턴에 고른 글 · 블록 · 표 범위(0부터) · 열린 문서가 간다 | 사용자 11-25 | F-OA-01 · `officeAsk.test.js` OA-U-01·03 | feature · 단위 | ✅ |
| 에이전트가 라이브 MCP(`office_live_apply_ops` setTableCellFormat vAlign)로 그 칸만 세로 가운데로 바꾼다. 열린 편집기의 그 칸이 바로 바뀌고 옆 칸은 그대로다. 검수는 「편집기 확인」으로 ⚠ 없음 | 사용자 11-25 | F-OA-01 | feature | ✅ |
| 칩은 고른 것을 따라간다(다른 칸 · 선택 풀기). ✕ 를 누르면 같은 선택에는 다시 뜨지 않는다. 밤 테마의 색 | 사용자 11-25 | F-OA-02 · OA-U-02 | feature · 단위 | ✅ |
| Lite 안의 편집기에는 「AI 수정 요청」이 없다. 편집기를 따로 열면 있다 | 사용자 11-25(위임 결정) | F-OA-03 | feature | ✅ |
| 편집기가 「바뀐 곳 없음」이라 한 편집: 에이전트에는 오류로 가고, 답은 「요청한 수정이 … 반영되지 않았어요」로 바뀐다(「맞췄어요」 없음) | 사용자 11-25 | F-OA-04 · OA-U-05·06 | feature · 단위 | ✅ |
| 열린 문서에 대한 요청은 그 카드의 대화로 가고 라우터를 거치지 않는다. 카드가 대화에 없으면 첫 요청이 간 대화로 간다 | 사용자 11-25 | F-OA-01 · F-OA-05 · OA-U-04 | feature · 단위 | ✅ |
| 요청 도중 서버가 20초 사라져도 「다시 연결하는 중…」만 보이고 「연결 안 됨」은 보이지 않는다. 돌아오면 저절로 「대화와 연결됨」, 편집은 적용된다 | 운영 11-25 06:58(배포의 파드 교체) | F-OA-06 | feature | ✅ |
| 390px 휴대폰(밝은 · 밤): 다이얼에 같은 칩, 화면 밖으로 넘치지 않음 | — | F-OA-07 | feature | ✅ |
| 이웃한 길 「@ 가리키기」: 표를 누르면 칩, 보내면 메시지 앞에 붙고 에이전트 맥락에 「가리킨 대상」. 밝은 테마에서도 읽히는 칩 색 | — | F-OA-08 | feature | ✅ |
| 에이전트 안내: 고른 부분의 자리로 setTableCellFormat, 바뀐 곳이 없으면 했다고 하지 않기 | — | `live-links.test.js` | 단위 | ✅ |
| 칸이 문단 아래 간격으로만 높은 표에서 1~3행 1~4열 「중앙정렬」(운영 에이전트가 보낸 연산 그대로): 다섯 라벨이 칸 가운데(글자 상자로 잼), 행 높이 그대로, 결과 「문서에서 확인함」, 검수 「편집기 확인 … (문서에서 확인함)」 ⚠ 없음, 저장한 파일의 열 칸 `w:vAlign` center, 다시 열어도 가운데 | 운영 11-25 12:57 | F-OA-09 · office-host `page-live.test.mjs` | feature · 단위 | ✅ |
| 요청한 서식이 문서에 나타나지 않은 편집(칸 안 글 아래 빈 문단): 에이전트에는 「…문서에 나타나지 않았어요」 오류와 그 칸 · 글 위아래 자리, 답은 「요청한 수정이 … 반영되지 않았어요. 편집기는 받아들였지만 문서에서 확인되지 않았어요」 | 운영 11-25 12:57 | F-OA-10 · `officeEdits.test.js` OE-U-01·05 | feature · 단위 | ✅ |
| 서식 확인은 세로 정렬만이 아니다: 칸 색(값과 화면) · 테두리 · 문단 가로 정렬(값과 화면) · 대상 없음. 확인 자료가 없는 이전 office-host 는 「편집기 보고 … (문서에서 확인하지 못함)」으로 ✓ 근거가 아님 | 운영 11-25 12:57 | `officeEdits.test.js` OE-U-02·03·04 | 단위 | ✅ |
| 표 선택은 고른 칸 전체를 행마다 덮는 `textRanges` 를 넘기고, 안내는 칸 안 글의 문단 · 글꼴 연산을 그것으로 보내게 한다(선택의 from·to 는 첫 칸 하나) | 운영 11-25 12:57 | OA-U-07 · `live-links.test.js` · office-host `page-live.test.mjs` | 단위 | ✅ |
| 한글 · 엑셀의 고른 부분(지금은 워드만 알림) | — | — | — | ✗ |
| 운영 `/lite/` 경로 · 실제 에이전트(모델)가 이 안내대로 setTableCellFormat 을 고르는지 | — | — (모델 · 운영) | — | ◐ |

### 50. 설치된 도구는 에이전트에게도 이어져 있다 — 운영 점검이 확인한다 (스펙 `agent-tools`)

사용자(11-25, 운영): 「photocraft 도 채팅과 연결이 안되네.. 전체적으로 도구들의 mcp 를 통한 제어가 기본 스펙인데 문제가 있군 회귀테스트를 돌려」. PhotoCraft 를 열어 둔 채 「배경색을 옅은 하늘색으로」 → 에이전트 「PhotoCraft 편집 도구가 현재 연결되지 않아 …」. 편집기와 CLI 는 운영 서버에 있었지만(C-IN-* 통과) 회사의 MCP 목록(`tenants.mcp.mcpServers`)에 ArtCraft 도구가 없었다. 로컬은 목록이 차 있어 F-ED-* · F-CR-* 가 모두 통과했다 — 이 절이 그 틈을 잡는다. 사용자 결정 「기본 툴들은 공통 mcp 이므로, 테넌트에 따로 등록 관계없이 등록될 수 있도록」에 따라 이제 기본 도구는 deepagents 의 공통 MCP 목록(`COMMON_MCP_SERVERS`)으로 모든 회사에 닿는다(스펙 `craft-apps`). 서버가 `/api/config` 에 `agentTools`(기본 도구 9개, 참 · 거짓)와 `agentToolsVia`(출처: `tenant` · `common`, 막는 것: 회사의 같은 이름 항목이 다른 곳을 가리키면 `tenant-overrides-common-with-other-url`, 허브가 답하는데 그 이름이 없으면 `hub-filtered`)를 낸다(`server/lib/agentTools.js`, 이름 목록 `server/mcp/toolServers.js` — 허브 묶음 · deepagents 공통 목록과 같은 이름). 주소 · 헤더 · 키는 내지 않는다(S-01 이 확인).

```bash
PGPT_ROOT_URL=https://uengine.process-gpt.io npx playwright test --project=deploy tests/deploy/agent-tools.spec.js   # 운영, 로그인 없이 읽기만
PGPT_LITE_URL=http://localhost:5180 npx playwright test --project=deploy tests/deploy/agent-tools.spec.js            # 로컬 · Docker(…:18080)
cd server && node --test test/agentTools.test.js
```

| 기능 요건 | 근거 | 시험 | 단계 | |
|---|---|---|---|---|
| 서버가 회사마다 기본 도구의 연결 상태를 알린다(참 · 거짓 · 출처 이름만), 알리지 않는 서버는 「too old to report agentTools」로 실패 | 사용자 11-25 | D-AT-00, S-01 | deploy · smoke | ✅ |
| 웹 편집기와 CLI 가 설치된 ArtCraft 앱은 에이전트 도구로도 이어져 있다 — 없으면 앱 이름과 「missing tenant MCP registration」(낡은 같은 이름 항목이면 「stale tenant MCP registration」, 허브가 거르면 「mcp-hub … does not have」)으로 실패 | 사용자 11-25 | D-AT-cadcraft · vectorcraft · photocraft · soundcraft · filmcraft | deploy | ✅ (운영: 서버 배포 전 「too old」 10건 실패, 11-25) |
| 이음오피스 편집기를 내는 설치(`/office/sheets/` 가 편집기 페이지)는 편집 도구(`pgpt-ieumoffice-live-editor`)가 이어져 있다 | 앞선 보고(「AI 수정 요청」 미반영) | D-AT-office | deploy | ✅ |
| 공유 폴더 · 패널 앱 · 프로세스 개선은 늘 이어져 있다 | — | D-AT-folders · panelapps · improve | deploy | ✅ |
| 판단 규칙: tenant(켜진 항목, 주소가 이 서버의 `/mcp/<경로>`, 사람의 토큰, 에이전트가 다른 곳이면 localhost 아님 — 키 이름은 보지 않음) · common(`/mcp/common` 의 이름, 회사의 같은 이름 항목이 url · command 를 가지면 그 항목이 이김, 없으면 얹힘 · `enabled:false` 는 끔). 허브는 출처가 아니고 거르기만(`hub-filtered`). 회사 목록을 못 읽으면 모두 false, 허브 · 공통 목록이 없거나 404 면 그것만 빠짐, 1분 기억(실패 10초) | deepagents `merge_common_mcp_servers` | 서버 `test/agentTools.test.js` (17) | 단위 | ✅ |
| 허브가 묶는 목록 · 공통 목록 이름 · ArtCraft 앱 · 이음오피스 이름이 한 목록 | — | 서버 `test/agentTools.test.js` 「이름은 한 목록」 | 단위 | ✅ |
| 에이전트가 실제로 열린 PhotoCraft · 이음오피스를 대화로 고친다(운영) | 사용자 11-25 | A-06 · A-11(로컬, 실제 모델), 운영은 D-AT 통과 뒤 사람 확인 | agent | ◐ |

### 51. 브라우저 작업은 내 PC 의 브라우저에서 — 데스크톱이 켜져 있으면 그 PC, 휴대폰만이면 서버 (스펙 `browser-handoff` 「브라우저 작업은 내 PC 의 브라우저에서도 돈다」 · 「PC 마다 동의한 작업만 그 PC 로 간다」 · 「PC 의 브라우저는 작업이 쥔 동안만 일하고, 끝이 있다」 · 「PC 가 꺼지면 …」 · 「보관함 값은 그 사람의 PC 로 …」, `local-agents`)

근거: 2026-11-24 「이 부분도 일렉트론 버전에서는 로컬 브라우저를 이용하는게 더 효율적이지 않을까?」 · 「그래도 순수 모바일에서는 이 작업이 가능해야하니」. 서버 쪽 시험은 진짜 데스크톱 코드(데스크톱 앱의 로컬 러너 + 브라우저, `desktop/test/helpers/browser-host.js` 를 Electron 으로)가 시험 서버의 링크에 기기 토큰으로 붙어서 한다 — `desktop/` 에서 `npm ci` 가 필요하고, Electron 이 없으면 원격 쪽 시험은 건너뛴다. 사이트는 지어낸 가게(`server/test/fixtures/drivers.mjs`, 다른 출처 iframe 포함), 모델 · 판정은 대본. 화면 시험(LB)은 진짜 앱을 Playwright `_electron` 으로 띄우고 같은 사람이 휴대폰 폭(390) 웹에서 본다 — BFF(8873) · Vite(5273) · 대본 모델 · 사이트를 시험이 띄운다. 실제 사이트 · 실제 모델 실측은 `server/scripts/measure-browser-where.mjs`(결과 `openspec/specs/browser-handoff/e2e/results/local-browser-1125.txt`).

| 기능 요건 | 근거 | 시험 | 단계 | |
|---|---|---|---|---|
| 두 드라이버(서버 Chromium · PC 브라우저)가 같은 동작을 같게: 열기 · 읽기(다른 출처 iframe 의 단추와 글) · 이름 · 비밀 칸 · 자리 · 입력 + Enter · iframe 안 누르기 · 날짜 칸 · 보관함 값(읽기 · 낱말 · 글에 없음, 그림은 칠함) · 키 하나씩 + Enter(대문자 · 기호) · 스크롤 · 파일 칸 · 파일 고르개 · 새 탭 · 스스로 닫히는 창 · 받은 파일 · 끝나지 않는 페이지 · 직접 제어 · 실시간 화면 | 설계 | `server/test/browserDriver.test.js` | 단위 · 통합 | ✅ |
| 페이지 읽기 스크립트의 데스크톱 사본이 서버의 것과 같음, 어디서 도나(PC 마다의 설정 own · all · off, 단계 실행 끔, 남이 시킨 작업, 링크 · 0.2.2), 내부망 주소(서버 · 데스크톱 같은 판단), 링크가 끊기면 기다리던 호출이 바로 끝남 | 설계 · 검토 11-25 #8 | `browserDriver.test.js` | 단위 | ✅ |
| 링크 조각: 바이트로 재어 1MB 아래(한글 40만 자 양쪽), 쓰지 않는 링크의 조각은 받지 않음(400개 → 0바이트 · RSS), 한 링크에 메시지 둘 · 조각 수 · 바이트 끝, 링크 객체마다(옛 링크가 늦게 닫혀도 새 링크의 조각은 남음) | 검토 11-25 #1 · #2 · #11 | `browserDriver.test.js` · `desktop/test/browser.test.js` | 단위 | ✅ |
| 링크 조각(재검토): 작업이 쥐지 않은 링크(드라이버만 남은)의 조각은 받지 않음, 모든 링크를 합친 끝(두 PC 7MB + 7MB > 12MB → 나중 것 버림 · 그 나머지 조각도 안 받음), 버린다는 로그는 링크마다 1분에 한 번, 링크가 닫히면 합계가 돌아옴 · RemoteDriver 의 holding(begin → 참, idle → 거짓) | 재검토 11-25 N5 | `browserDriver.test.js` | 단위 | ✅ |
| 내부망 판단(재검토): `[::ffff:127.0.0.1]` · `[::ffff:7f00:1]` · `localhost.` · `127.0.0.1.` · 한 단어 이름 · `.local` · `.lan` · `.internal` · `.intranet` · `.localdomain` · `.home.arpa` · 10진/16진 IPv4 — 서버 `privateAddress` 와 데스크톱 `privateHost` 가 같고, 공개 이름(`example.com.` · `local.example.com`) · 공개 IPv6 는 아님 | 재검토 11-25 N2 | `browserDriver.test.js` · `desktop/test/browser.test.js` | 단위 | ✅ |
| 두 드라이버: 페이지의 confirm · alert 는 상자 없이 취소 · 넘김, 다음 읽기에 `[dialog] …` 한 번 · 한글 40만 자 페이지(링크 그대로, PC 낱말 20만 자까지) · 새 탭으로 받는 파일(빈 탭 닫힘, 일은 원래 페이지 — 탭이 되기 전에 끝난 다운로드도) · 하나뿐인 창이 스스로 닫혀도 다음 일은 새 탭에서 | 검토 11-25 #5 · #2 · #7 · #10 | `browserDriver.test.js` | 통합 | ✅ |
| PC 만: 크기를 말하지 않는 큰 파일은 받는 도중 413 · 작업이 끝나면(idle) 페이지를 비우고 프레임 · 받은 파일을 보내지 않음, begin 부터 다시 · 사람이 없는 작업(begin noPrivate)은 127.0.0.1 을 열지 않음 · ⌘V · Ctrl+V 거절 · 창 열두 개 → 탭 8개까지 · 그리지 못하는 페이지의 모델 그림은 없음(가리기 전 그림 아님) | 검토 11-25 #6 · #7 · #8 · #12 | `browserDriver.test.js` | 통합 | ✅ |
| 두 드라이버(재검토): 「떠날까요?」(beforeunload)를 건 페이지에서 다음 주소로 감 · 스크립트가 만든 빈 iframe 의 alert 와 `frames[]` 의 confirm 도 상자 없이(페이지가 이어서 움직이고 말은 다음 읽기에) | 재검토 11-25 N1 · N7 | `browserDriver.test.js` | 통합 | ✅ |
| PC 만(재검토): beforeunload 페이지에 보관함 값을 넣고 idle → `about:blank` · noPrivate 가 쥔 동안 이미 열린 페이지의 fetch · 그림 · 새 창 · 폼 · `localtest.me` fetch 가 사이트에 하나도 닿지 않음, `localtest.me` · `127.0.0.1.nip.io`(이 PC 의 DNS 로 풀어서) · `[::ffff:127.0.0.1]` · `localhost.` 열지 않음, 놓으면 다시 감 · 작업 사이 보이는 창에서 사람이 받은 파일은 그 PC 의 다운로드 폴더로(「(2)」), 서버로는 안 감 · 보였다가 숨은 창은 새 숨은 탭으로 바뀌어 다음 동작이 됨 · 탭이 없을 때 곁의 동작 다섯이 한꺼번에 와도 새 탭 하나 | 재검토 11-25 N1 · N2 · N4 · N8 | `browserDriver.test.js` | 통합 | ✅ |
| PC 에서 끝까지: 카드 「내 PC · 시험 PC」, 실시간 프레임이 그 카드로, 끝난 카드에 마지막 화면 | 사용자 11-24 | `server/test/browser-local.test.js` | 통합 | ✅ |
| PC 에서 멈춤 → 「기다리는 중 · AI 모델의 답」 → 「다시 시도」는 그 걸음만 · 「그만두기」는 2초 안 | PR #46 | `browser-local.test.js` | 통합 | ✅ |
| 보관함 로그인: 비밀번호는 그 사람의 PC 링크로 한 번(`fillSecret`)만, 다른 사람의 링크 · 서버 로그 · 이벤트 · 모델 요청 · 대화에 없음, 모델의 그림에서 칠해짐, PC 에서 친 로그인은 보관함으로 안 감 | 설계(비밀) | `browser-local.test.js` | 통합 | ✅ |
| 로그인 벽에서 보관함 먼저(PR #48)가 PC 에서: 키 하나씩 · Enter · 사람에게 묻지 않음 | PR #48 · 조정 11-25 | `browser-local.test.js` · 서버 쪽 `browser-wall-vault.e2e.mjs` | 통합 | ✅ |
| PC 꺼짐 → 「PC 연결 끊김」 카드, 2.5초 동안 저절로 옮기지 않음, 「PC가 다시 켜지면」 → 같은 PC 가 돌아오면 그 PC 에서 같은 페이지로 | 사용자 지시 | `browser-local.test.js` | 통합 | ✅ |
| PC 꺼짐 → 「서버에서 이어서」 → 서버 브라우저가 같은 주소를 열어 끝냄, 모델에게 그 사실 | 사용자 지시 | `browser-local.test.js` | 통합 | ✅ |
| PC 의 설정 「쓰지 않음」이면 PC 가 켜져 있어도 서버, 「내가 시킨 작업만」이면 PC — `GET /api/browser/where` 가 그대로 · 「이 컴퓨터에서 단계 실행」을 끈 PC 로는 「모두」여도 가지 않음 | 사용자 지시 · 검토 11-25 #8a · #9 | `browser-local.test.js` | 통합 | ✅ |
| 사람이 없는 작업 · 남이 시킨 작업은 기본으로 서버(`not-own`), PC 가 「모두」면 PC — 시작 주소(127.0.0.1) · `goto`(192.168.0.1) 는 열지 않고 모델이 까닭을 들음, PC 에 그 주소가 가지 않고 `begin` 은 `noPrivate: true` | 검토 11-25 #8b · #8c | `browser-local.test.js` | 통합 | ✅ |
| 서버 브라우저가 열리지 않으면 줄 선 두 작업의 카드가 「브라우저를 열지 못해 …」 실패로 끝나고 줄이 이어짐(10초 안) | 검토 11-25 #3 | `browser-local.test.js` | 통합 | ✅ |
| 이어진 PC 의 브라우저가 거듭 열리지 않으면 다시 열기는 3번까지, 카드 「거듭 열리지 않아 …」, 그 뒤로 열지 않음 | 검토 11-25 #10 | `browser-local.test.js` | 통합 | ✅ |
| 계획하는 동안 취소한 작업은 그동안 쥔 PC 의 브라우저를 놓음(begin 뒤에 idle) | 재검토 11-25 N3a | `browser-local.test.js` | 통합 | ✅ |
| PC 에서 사람이 필요한 채로 끝난 작업: 이유는 「이 PC에서 보기」(「직접 제어」 아님), 카드 `pcKept: true`, idle `keep: true`, 끝난 뒤에도 「이 PC에서 보기」 · 숨기기, 다음 작업이 쥐면 앞 카드 `pcKept: false` · 보기 거절 | 재검토 11-25 N4 | `browser-local.test.js` | 통합 | ✅ |
| 사람이 시키지 않은 작업(`own: false` — 회사 루틴 자동 실행)은 「모두」인 PC 에서도 begin `noPrivate: true` · 내부망 `goto` 거절 · `runTurn({ auto: true })` 가 시작한 브라우저 작업은 `own: false`, 사람이 보낸 말은 `own: true` | 재검토 11-25 N6 | `browser-local.test.js` · `browser-replaces-turn.test.js` | 통합 | ✅ |
| 데스크톱: 링크가 끊기면 브라우저가 쥔 상태를 놓음(linkDown · 반쯤 온 조각 버림, 페이지는 둠) · 새 탭은 동작 안에서(시간 끝 안 · 실패하면 그 동작이 그 까닭으로 실패) | 재검토 11-25 N3b · N8 | `desktop/test/browser.test.js` | 단위 | ✅ |
| 데스크톱 쪽: 이름 붙은 동작만(코드 · 모르는 동작 거절), 그 데스크톱에 로그인한 사람만, 조각(바이트 · 끝), 로그에 값 없음, 웹 주소만, begin · idle · 창이 닫힌 뒤 새 탭, 내부 주소, 기본 인증은 앱 창이 서버로 갈 때만, PC 의 설정(기본 own · 다시 켜도 남음), 닫으면 세션을 놓음 | 설계 · 검토 11-25 #2 · #8 · #9 · #12 | `desktop/test/browser.test.js` | 단위 | ✅ |
| 진짜 앱: 로그인하면 `caps.browser` · 앱 0.2.3 · `prefs.browser: 'own'`, 앱 설정의 「브라우저 작업은 이 PC에서」를 「모두」 · 「쓰지 않음」으로 바꾸면 서버가 곧바로 따름, 다른 칸(실행 전에 묻기)을 바꿔도 남음 | 사용자 지시 · 검토 11-25 #9 | LB-01 | desktop | ✅ |
| 진짜 앱 + 휴대폰 390: 휴대폰의 설정은 읽기만(PC 마다의 설정, 바꾸는 칸 없음), 웹에서 시킨 작업이 PC 에서 돎 — 휴대폰 · 앱 카드에 「내 PC · 테스트 맥」과 실시간 화면, 서버 Chromium 프로필 없음 | 사용자 11-24 · 검토 11-25 #9 | LB-02 | desktop | ✅ |
| 진짜 앱 + 휴대폰 390: 사람이 필요한 순간 「직접 확인 · 이 PC에서 보기 · 멈추기」, 「이 PC에서 보기」 → PC 에 그 창(제목은 페이지 출처부터, 전체 화면 안 됨), 그 창에서 한 일 뒤 「제어 돌려주기」로 끝남 | 사용자 지시 · 검토 11-25 #12 | LB-03 | desktop | ✅ |
| 휴대폰 390 고정 카드: 확장 화면의 단추줄은 「직접 제어」 · 「제어 돌려주기」 · 「서버에서 이어서」 가운데 하나만, 「이 PC에서 보기」 → `/api/browser/show {taskId}` | 검토 11-25 #4 | F-LB-01 `e2e/tests/feature/local-browser-card.spec.js` | feature | ✅ |
| 휴대폰 390 고정 카드: PC 연결이 끊긴 카드의 「서버에서 이어서 · PC가 다시 켜지면 · 멈추기」와 `/api/browser/route {taskId, to}`, 확장 화면에는 「서버에서 이어서」만 | 검토 11-25 #4 | F-LB-02 | feature | ✅ |
| 웹의 설정은 읽기만: 「내가 시킨 브라우저 작업」 · 「단계 · 예약 브라우저 작업」이 어디서 도는지와 PC 마다의 설정(꺼진 단계 실행 포함), 입력 · 고르개 없음 | 검토 11-25 #9 | F-LB-03 | feature | ✅ |
| 휴대폰 390 고정 카드: PC 에서 사람이 필요한 채로 끝난 카드(`pcKept`)는 「다시 시도 · 이 PC에서 보기」 → `/api/browser/show {taskId}`, 다른 작업이 쓴 카드(`pcKept: false`)는 「다시 시도」만 | 재검토 11-25 N4 | F-LB-04 | feature | ✅ |
| 실제 사이트(네이버 여행 숙소 · 연합뉴스)를 사내 모델로 PC 와 서버에서 | 사용자 지시 | `measure-browser-where.mjs` | 실측 | ✅ |
| Windows 의 숨은 창 · 스크린캐스트 · 키 입력, 묶은(패키지) 앱으로 브라우저 작업, 사람의 진짜 로그인 | — | — (맥 arm64 · 개발 실행만, 진짜 계정 없음) | — | ✗ |

### 52. 프로필 사진 — Process GPT 와 같은 칸(`users.profile`), 기본 사진 · 내 사진 · 지우기 (스펙 `profile-picture`)

근거: 2026-11-25 사용자 「내 프로필 사진 어떻게 바꾸냐? Process GPT 버전과 일관성고려하여」 — Lite 의 설정 머리와 위 막대는 이름 첫 글자뿐이었다. 같은 날 덧붙임 「프로필 사진은 기본적으로 social login 인 경우는 구글에 설정된 이미지가 나오는게」. `profile-picture.spec.js` 는 자기 스택(BFF `PRO_BACKGROUND=0` + Vite, 회사 `avatar-ui`, 8990 · 5391 부터 빈 포트 — 5390 은 이 PC 의 이음오피스 호스트 자리)을 띄우고 지운다. 모델 · 공용 서비스는 부르지 않는다. 올리는 사진은 ffmpeg 로 만든 진짜 그림(640×400 PNG · 300×500 JPEG). 사람은 지어낸 이름(김서연 · 박도윤 · 이하준 — 구글로 로그인한 사람: 그 사람의 `auth.identities` 에 provider `google` 행을 넣어 흉내, 사진은 127.0.0.1 의 가짜 그림 호스트를 `PRO_AVATAR_HOSTS` 로 허용). 기본 사진 18장은 Process GPT(process-gpt-vue3) 의 `public/assets/images/profile/` 과 같은 바이트를 Lite 의 `public/assets/images/profile/` 에 둔다(출처 · MIT 고지 `NOTICE.txt`). 화면 사진은 `openspec/specs/profile-picture/e2e/results/`, 명령은 `openspec/specs/profile-picture/e2e/README.md`.

| 기능 요건 | 근거 | 시험 | 단계 | |
|---|---|---|---|---|
| 저장할 수 있는 값: 기본 사진 18장(글자 그대로) · 이 설치 저장소 `files/pgpt-pro/<나>/avatar/<이름>.jpg·jpeg·webp·png` · 빈 값 — 다른 사이트 · `//` · `data:` · `javascript:` · 남의 폴더 · 내 다른 폴더 · 다른 버킷 · 서명 주소 · `?` · `#` · `..` · `%2e` · 하위 폴더 · 18장에 없는 경로 · `/images/defaultUser.png` · 문자열 아닌 값은 400 | 사용자 지시(검사) | `server/test/profilePicture.test.js` · F-AV-06 | 단위 · feature | ✅ |
| 보여 줄 값: 기본 사진 · 이 사이트의 `/images/…` · `/assets/images/…` 그림 · 이 설치 저장소의 공개 그림만, `/images/defaultUser.png`(Process GPT 의 「사진 없음」) · 다른 사이트 · 이상한 경로는 `null` | 설계 | `profilePicture.test.js` · F-AV-05 | 단위 · feature | ✅ |
| 업로드는 앞 바이트가 JPEG · WebP · PNG 일 때만(HTML · SVG · JSON 400), 1MB 넘으면 413, 로그인 없이 401, 남의 행은 그대로 | 사용자 지시(검사) | `profilePicture.test.js` · F-AV-06 | 단위 · feature | ✅ |
| 기본 사진 고르기: 설정 머리(카메라 표시) → 창 → 18장(Process GPT 순서, 모두 불러와짐) → 누르면 저장 · 창 닫힘, 설정 머리와 위 막대가 새로 고침 없이 그 사진, `users.profile` = `/assets/images/profile/user-3.jpg`, 새로 고쳐도 · 창의 테두리 · 프로필 줄 「Process GPT에도 같은 사진이 보여요」 | 사용자 11-25 | F-AV-01 | feature | ✅ |
| 기본 사진은 사이트 뿌리(게이트웨이 뒤면 Process GPT 의 파일) 다음 Lite 의 사본(`/lite/assets/…`), Lite 를 도메인 뿌리에 두면 뿌리가 곧 사본 · 18장 파일이 Lite 에 있고 JPEG · 화면과 서버의 목록이 같음 | 사용자 지시 | `profilePicture.test.js` | 단위 | ✅ |
| 내 사진 올리기: 브라우저에서 가운데 정사각형 256×256 WebP, 주소는 내 폴더, 위 막대 · 설정 · 프로필 줄에 보임, 다시 올리면 앞의 것은 저장소에서 지움 | 사용자 지시 | F-AV-02 · `profilePicture.test.js`(자르기) | feature · 단위 | ✅ |
| 사진 지우기: 이름 첫 글자, `users.profile` 은 열의 기본값(`/images/defaultUser.png`), `user.picture` = `null`, 올린 사진은 지움 | 사용자 지시 | F-AV-03 | feature | ✅ |
| Process GPT 가 DB 에 쓴 사진(`/assets/images/profile/5.jpg`)을 Lite 가 보여 줌 — 나의 위 막대, 팀원의 팀·역할 목록 · 메신저 대화 목록(사진 없는 사람은 첫 글자) | 사용자 지시 | F-AV-04 | feature | ✅ |
| 깨진 사진(없는 파일 · 지워진 업로드)은 오류 없이 이름 첫 글자(밤 테마) · 다른 사이트 주소는 브라우저가 요청조차 하지 않음 | 사용자 지시 | F-AV-05 | feature | ✅ |
| 휴대폰 390px 밝은 · 밤: 위 막대 · 설정 머리 · 사진 고르기 창(모든 단추가 화면 안) · 프로필 줄, 옆으로 넘치지 않음 | 사용자 지시 | F-AV-07 | feature | ✅ |
| 구글 사진: 인증 서버의 기록(구글 identity `picture` → `avatar_url`, Lite 자체 구글 로그인의 `app_metadata.google_picture`)에서만 — `user_metadata` 는 읽지 않음, 허용 호스트(`PRO_AVATAR_HOSTS`, 기본 https `*.googleusercontent.com`, http 는 이 PC 만; 닮은 호스트 · `@` · 따옴표 거절), 보여 주는 순서 고른 것 → 구글 → 첫 글자, 채우기는 빈 칸만 · 구글 주소가 든 동안은 계정을 따름, 되돌리기는 구글 사진(없으면 열의 기본값) | 사용자 11-25 덧붙임 | `profilePicture.test.js` | 단위 | ✅ |
| 구글로 로그인한 사람: 처음 열면 구글 사진(`user.picture` = `pictureDefault`), `users.profile` 에 채움, 리퍼러 없이 요청(`referrerpolicy=no-referrer`), 「프로필」 줄 「Google 계정의 사진이에요」 · 창에 되돌릴 단추 없음 → 기본 사진을 고르면 그것이 이기고 다시 열어도 그대로 · 화면이 보낸 구글 주소는 400 → 「Google 사진으로」는 구글 사진(DB 도) · 팀원에게도 → 구글 계정이 사진을 바꾸면 따라감 → 열리지 않는 구글 사진은 첫 글자 | 사용자 11-25 덧붙임 | F-AV-08 | feature | ✅ |
| 회의의 카메라 끈 칸 · 메신저의 받은 편지함 · 보낸 사람 · @ 고르기 · 공유 폴더의 사람 동그라미에도 사진(같은 부품) | 설계 | — (화면 시험은 팀 목록 · 메신저 대화 목록만) | — | ◐ |
| 운영(`/lite`)에서 Process GPT 의 파일이 먼저 · 없을 때 Lite 의 사본으로 넘어가는 것을 실제 게이트웨이에서, Process GPT 화면에 Lite 가 올린 사진, 진짜 구글 로그인(GoTrue 의 구글 제공자 · Lite 자체 구글 로그인의 `app_metadata`) · 진짜 googleusercontent 사진, Safari · HEIC 사진 | — | — (개발 스택 · Chrome 으로만, 넘어가기는 단위 시험, 구글 로그인은 identity 행으로 흉내) | — | ✗ |

### 53. 받아쓰기 — 서버의 자가 시험 · 데스크톱 앱 · Android 앱의 입력창 받아쓰기 (스펙 `speech-to-text`)

사용자(11-25): 「지금 서버에 위스퍼모델이 없는 것 같아 위스퍼 모델이 있어야 바다쓰기 이런게 되는데 그것도 반영을 좀 해줘」. 입력창의 마이크는 브라우저의 음성 인식만 써서 데스크톱 앱 · Android 앱 · Firefox 에서는 받아쓰지 못했고, 운영의 받아쓰기(litellm-proxy 의 `gpt-4o-mini-transcribe`, 대체 `whisper-1` — 서비스 키에는 `whisper-1` 이 없음)가 되는지는 회의에서 말해 보기 전에는 알 수 없었다. 이제 서버가 묶어 둔 1.3초 소리(`server/fixtures/stt/selftest-ko.wav`)를 회의와 같은 주소 · 키 · 모델로 받아써 보고 `/api/config` 의 `transcribe`(`ok` · `model` · `ms` · `at` · `error` 코드 · `fallback`)로 알린다. 로컬 끝까지 확인은 `openspec/specs/speech-to-text/e2e/README.md`.

```bash
PGPT_ROOT_URL=https://uengine.process-gpt.io npx playwright test --project=deploy tests/deploy/stt.spec.js   # 운영, 로그인 없이 읽기만
PGPT_LITE_URL=http://localhost:8787 npx playwright test --project=deploy tests/deploy/stt.spec.js            # 로컬 · Docker(…:18080)
cd server && node --test test/transcribeSelfTest.test.js test/dictation.test.js
```

| 기능 요건 | 근거 | 시험 | 단계 | |
|---|---|---|---|---|
| 서버가 받아쓰기를 스스로 시험해 알린다: 통과면 ok · 모델 · ms, 대체 모델만 답하면 fallback, 실패는 코드(`no-key` · `timeout` · `unreachable` · `http-<상태>` · `bad-answer` · `empty` · `mismatch`), 알리지 않는 서버는 「too old to report transcribe」 | 사용자 11-25 | D-STT-01, STT-U-02~05 | deploy · 단위 | ✅ |
| 답에 주소 · 키 · 상위 서버 원문이 없다 | 설계 | D-STT-02, S-01, STT-U-02 · 04 | deploy · smoke · 단위 | ✅ |
| 시험 소리(1.3초)가 5초 안에 받아 적힌다(`STT_FAST_MS`) | 설계(입력창 받아쓰기의 기다림) | D-STT-03 | deploy | ✅ |
| 키가 둘째 모델(`whisper-1`)을 거절하는 운영: 첫 모델이 되면 둘째에는 묻지 않음, 둘 다 안 되면 `lastError` 에 첫 모델의 까닭(`first`), 첫 모델도 거절이면 `http-401` | 운영 11-25 | STT-U-11 | 단위 | ✅ |
| 켜질 때 한 번 · 10분마다(실패 뒤 1분), 같이 불러도 한 번, `PRO_TRANSCRIBE_SELFTEST_MIN=0` 이면 하지 않음, `/api/config` 는 기다리지 않음 | 설계 | STT-U-06 · 07 | 단위 | ✅ |
| 받아쓰기 실패는 사람의 말로(503 「받아쓰기 서버가 응답하지 않아요」), 원문은 `lastError` 에만 | 설계 | STT-U-08, 서버 `meetingTeamFixes.test.js` 「받아쓰기: 첫 모델이 …」 | 단위 | ✅ |
| `POST /api/dictation`: 로그인한 사람의 조각 → 글(주 언어), 짧은 소리 400 · 로그인 없이 401 · 지어낸 말은 빈 글 · 서버가 없으면 503 · 한 사람 동시 3개(넘으면 429) | 사용자 11-25 | STT-U-09 · 10 | 단위 | ✅ |
| 브라우저에 음성 인식이 없으면(데스크톱 앱 · Android 앱 · Firefox) 입력창 받아쓰기는 서버로: 「듣는 중」, 조각마다 바로 보냄, 말한 차례대로 붙음, 끄면 말하던 조각까지(답이 3초 넘어도), 보내기면 오던 글 버림, 서버 실패 · 마이크 권한 · 마이크 없음은 까닭을 말하고 멈춤, 보내지 않음 | 사용자 11-25 | DV-U-11~14 | 단위 | ✅ |
| 화면에서: 데스크톱 앱(`pgl-desktop`) · 음성 인식 없는 브라우저에서 가짜 마이크(소리 굽이) → `POST /api/dictation`(WAV · 토큰) 조각마다, 늦게 온 첫 답도 차례대로, 끄면 말하던 조각까지 · 마이크 꺼짐, 서버 503 이면 그 까닭 · 꺼짐, 보낸 요청 0 | 사용자 11-25 | F-VD-08 (· F-VD-07 데스크톱 마이크 권한) | feature | ✅ |
| 로컬에서 끝까지: Lite BFF → litellm v1.82.3 → OpenAI 형식 받아쓰기 서버, `/api/dictation` · 회의 조각 → 회의록 · 자가 시험 · 실제 브라우저(데스크톱 표시)의 마이크 → 입력창 | 사용자 11-25 | `openspec/specs/speech-to-text/e2e/README.md` 「로컬 끝까지」 | 실측 | ✅ |
| 진짜 데스크톱 앱(Electron) · Android 앱에서 말하는 화면 시험, 운영 키로 받아쓰기 | — | — (가짜 마이크 · 로컬 서버로만, 운영은 배포 뒤 D-STT-01~03) | — | ◐ |
### 54. 모델 호환 — 주 모델을 Claude 로 바꿔도 판정 · JSON 답이 돈다 (스펙 `llm-model-compat`)

사용자(11-25): 「이 앤트로픽 키로 서비스하는 기본 모델을 바꾸자.」 Claude는 로그 확률을 제공하지 않고, 스키마 없는 `json_object`에 대응하는 기능이 없어 프롬프트에 따라 JSON을 `` ```json `` 울타리로 감싸 답한다(운영 측정 5/5). 확률은 `PRO_LLM_ODDS_MODEL`로 읽고, JSON을 요청한 답이 울타리 하나로 감싸져 있으면 이를 벗겨 읽는다(`server/lib/jsonReply.js`). 운영 litellm-proxy 훅(`claude_compat` 7)도 같은 처리를 한다.

```bash
cd server && node --test test/llm-json-fence.test.js test/llm-logprob.test.js
```

| 기능 요건 | 근거 | 시험 | 단계 | |
|---|---|---|---|---|
| 확률 읽기는 `PRO_LLM_ODDS_MODEL`(비우면 주 모델), 이름을 준 호출은 그대로 | 사용자 11-25 | `llm-logprob.test.js` | 단위 | ✅ |
| 설치판: `.env` 의 `LLM_ODDS_MODEL` → 서버 `PRO_LLM_ODDS_MODEL`(비우면 빈 값 = 주 모델), `.env.example` 에 있음 | 설계 | JF-U-06 | 단위 | ✅ |
| 모델이 temperature 를 거절하면(Claude 5.5 「`temperature` is deprecated for this model.」 포함) 빼고 다시 보내고 그 모델에는 다음부터 처음부터 뺌 | 설계 | JF-U-07 | 단위 | ✅ |
| JSON 을 청한 답이 울타리 하나뿐이고 안이 JSON 이면 안쪽을 답으로(chatJson · `chat({json:true})` 직접 읽기 모두) | 운영 측정 11-25 | JF-U-01(사례표 `json-fence-cases.json`) · 02 · 03 | 단위 | ✅ |
| 그 밖의 답(앞뒤 말 · 다른 언어 · 깨진 안 · 한 줄 울타리)과 JSON 을 청하지 않은 답은 손대지 않음, 깨진 안은 「not JSON」 으로 실패 | 설계 | JF-U-01 · 04 · 05 | 단위 | ✅ |
| 운영 프록시가 json_object 울타리를 벗긴다(claude_compat 7) | 운영 측정 11-25 | `openspec/specs/llm-model-compat/e2e/README.md` 「실측」 | 실측 | ✅ |
| 실제 Claude 로 Lite 의 모든 JSON 판정 프롬프트를 돌려 보는 회귀 | — | — (모델 비용, 대표 프롬프트만 실측) | — | ◐ |

### 55. 메일 첨부 — 그 자리에서 열고, 채팅으로 묻고, 동료와 나눈다 · 공개 주소 없이 (스펙 `mail-attachments`)

사용자(11-25, 메일 시트 「… 2026년 11월 급여대장 확인 후 확정·발송」의 회색 첨부 칩을 보며): 「메일 첨부를 곧바로 이음오피스 등의 도구로 열어보거나 채팅으로 해당 메일에 대한 질의/액션을 취할 수 있는 뭔가 흐름이 있어야」. 이제 첨부 칩을 누르면 문서는 이음오피스, 그림 · 소리 · 영상은 보기 화면, 그 밖은 「내려받기」로 열린다. 칩의 ⋯ 와 「이 메일로」 줄에는 「이 첨부로 묻기」가 있다. 바이트는 메일을 정리한 폴더의 사본이 있으면 그것을, 없으면 그 사람의 메일함에서 받아 만든 비공개 사본(비공개 버킷 `lite-private`)을 쓴다. 편집기 · 에이전트 · 보기 화면에는 서명 주소만 가고, 공개 주소(`/object/public/`)는 생기지 않는다. 서버 `lib/mailAttachments.js` · `lib/privateStore.js` · `routes/mailAttachments.js`, 화면 `src/mailAttach.js`. 시험은 자기 스택을 띄운다(`lib/localStack.js` — 테넌트 `mailatt-ui`, 8930 · 5330 부터). 실제 이음오피스 편집기(`lib/officeHost.js`, 5395 부터 — 시트 엔진 `xlsx-sidecar` 를 체크아웃에서 찾도록 이번에 고침), 가짜 Google(Gmail 원문 · 첨부) · 가짜 deepagents(받은 첨부를 실제로 열어 합계를 셈) · 가짜 모델(채팅 라우터 DELEGATE)은 시험 파일이 띄운다. BFF 의 `PGPT_ROOT` 는 임시 폴더라 개발 PC 의 에이전트 작업 공간에 쓰지 않는다. 사람 · 회사는 지어낸 것이다(한지우 · 서민재, 세무법인 오가람, 하늘테크). 명령과 증거는 `openspec/specs/mail-attachments/e2e/README.md`.

```bash
cd e2e && RT_WORKERS=1 npx playwright test --project=feature tests/feature/mail-attachments.spec.js
cd server && node --test test/mailAttachments.test.js && node --test --test-concurrency=1 test/mailAttachments.integration.test.js
```

같은 날의 독립 검토(11-25)가 찾은 여섯 가지(#1~#6)를 고치고 시험을 더했다 — 표의 아래쪽 「검토 11-25」 줄.

| 기능 요건 | 근거 | 시험 | 단계 | |
|---|---|---|---|---|
| 첨부 칩은 동작이다: xlsx → 이음오피스(시트가 닫히고, 셀 값이 메일의 파일 그대로), 칩에 종류 · 크기 · ⋯(열기 · 이 첨부로 묻기 · 내려받기) | 사용자 11-25 | F-MA-01 · F-MA-02 | feature | ✅ |
| 그림 → 보기 화면(시트 위, Esc 로 시트로), zip → 차분한 「앱 안에서 열지 않는 형식이에요 · 내려받기」, 문서도 「내려받기」, 남의 HTML 은 그리지 않음 | 사용자 11-25 | F-MA-02 · `mailAttachments.test.js` | feature · 단위 | ✅ |
| 공개 주소 없음: 편집기는 저장소 서명 주소(10분), 보기 · 내려받기는 이 서버 경로의 서명 주소(15분, 토큰 없음), 네트워크(요청 · JSON 응답)에 `/object/public/` 없음, 같은 열쇠의 공개 주소는 열리지 않음, 버킷은 비공개, 열쇠는 ASCII(이름 없음) | 요청(급여대장) | F-MA-01 · 02 · 03 · 05 · 07 · 08 · `mailAttachments.integration`(문서) · `mailAttachments.test.js` | feature · 단위 | ✅ |
| 비공개 사본은 한 번(카드가 기억, 두 번째는 메일함을 읽지 않음) | — | `mailAttachments.integration`(문서) | 단위 | ✅ |
| 폴더에 없는 첨부를 고쳐 「저장」 → 내 채팅의 비공개 파일 카드(주소 없음 · 「편집본 · 나만 볼 수 있어요」 · 공유 단추 없음), 「편집본을 내 채팅에 파일로 저장했어요 · 나만 볼 수 있어요」, 카드로 다시 열면 편집본, 시트에 「편집본 · 내 채팅의 파일」 | 요청 | F-MA-01 · `mailAttachments.integration`(편집본) | feature · 단위 | ✅ |
| 정리된 메일(「만들고 정리」 · 작업 폴더) → 폴더의 사본(폴더에서 고친 값), 저장은 폴더 main 의 커밋, 폴더 권한이 없어지면 메일의 사본 | 요청 · 스펙 `folder-edit-save` | F-MA-05 · `mailAttachments.integration`(정리된 메일) | feature · 단위 | ✅ |
| 「이 첨부로 묻기」(칩의 ⋯) → 입력창에 메일 칩 + 첨부 칩 → 에이전트가 메일 맥락(한 번)과 첨부를 파일로 받음(작업 공간의 경로, 없으면 30분 서명 주소) → 가짜 에이전트가 급여대장을 읽어 합계 확인, 보낸 말의 첨부 칩이 다시 엶 | 요청 | F-MA-03 · `mailAttachments.integration`(에이전트) | feature · 단위 | ✅ |
| 「이 메일로」 줄의 「이 첨부로 묻기」(첨부가 있을 때만 · 고정) → 첨부 모두 칩, 첨부 칩을 AI 입력창에 끌면 「AI에게 이 첨부로 묻기」 · 시트가 비킴 | 요청 | F-MA-04 · `mailFollow.test.js` · `mailFollow.integration` | feature · 단위 | ✅ |
| 다른 사람: 열기 · 경로 · 끌기 404(이름 없이), 주인의 서명 주소에서 사람만 바꾸면 403, 지난 주소 401, 로그에 첨부 이름 · 바이트 없음 | 요청 | F-MA-06 · `mailAttachments.integration` · `mailAttachments.test.js` | feature · 단위 | ✅ |
| 메신저에 끌어 놓기 → 「여기에 놓으면 첨부를 멘션해요 · 동료에게는 이름만 보여요」, 칩의 「파일도 공유」(꺼짐) → 동료는 이름 · 요약만(열기 403) → 열기 요청(주인에게 알림 한 번) → 주인이 「파일 공유」(그 파일만, 주인의 카드에 남음) → 동료가 「보기 전용」으로 엶 → 「공유 그만두기」 → 다시 잠김(경로 주소도 404), 방에 열쇠 · 주소 없음, 방 밖 404 | 요청 · PR #49 규칙 | F-MA-07 · `mailAttachments.integration`(메신저) | feature · 단위 | ✅ |
| 휴대폰 390px 밝은 · 밤: 칩 · ⋯ 메뉴 · 「내려받기」가 화면 안, 옆으로 넘치지 않음, 문서 패널이 화면 전체 | 요청 | F-MA-08 | feature | ✅ |
| **검토 11-25 #1** 에이전트에게 넘긴 첨부는 턴의 끝에 카드(공개 사본)가 되지 않음: `/workspace/uploads/` 아래는 늘, 이름 · 자리를 바꾼 사본 · 저장소에 올라간 사본도 내용(SHA-256)이 같으면 — 그 턴의 진짜 산출물은 그대로 카드, 「not attached」 로그에 첨부 이름 없음 | 검토 11-25 | MA-R1(`mailAttachments.test.js`) · `mailAttachments.integration` MA-R1(`runTurn` → 가짜 deepagents 가 사본을 남기고 답에 적음) | 단위 · 통합 | ✅ |
| **#2** 같은 폴더 파일을 메일 시트와 메신저 링크로 열면 카드가 따로(비공개 카드에 주소 없음 · 링크 카드에 비공개 열쇠 없음), 어느 순서로 열어도 · 둘 다 폴더에 저장, 비공개 카드에 공개 주소의 저장은 거절(`saveKindOf`) | 검토 11-25 | MA-R2(단위) · `mailAttachments.integration` MA-R2 | 단위 · 통합 | ✅ |
| **#3** 메일함은 크기부터(Gmail `sizeEstimate` · IMAP `size`) — 큰 메일은 원문을 받지 않고 413, 메일함 요청에 시간 한도(504), 한 첨부는 동시에 한 번만 받음, 413 · 504 는 5분 기억(404 는 아님), 칩 · 메신저 멘션은 카드가 아는 것(`source.att_meta`)만 — 메일함을 읽지 않음 | 검토 11-25 | MA-R3(단위: 동시 · 기억) · `mailAttachments.integration` MA-R3(크기 먼저 · 동시 · 멘션) | 단위 · 통합 | ✅ |
| **#4** 첨부는 번호로, 이름은 양쪽을 같이 다듬어 견줌(NFC · 겹친 빈칸 · NBSP · 전각 빈칸 · 폭 없는 글자 · 앞뒤 빈칸, 200자로 잘린 긴 이름은 앞 100자 이상) — 열기 · 정리된 폴더 찾기 · 메신저 | 검토 11-25 | MA-R4(단위) · `mailAttachments.integration` MA-R4 | 단위 · 통합 | ✅ |
| **#5** 메일 시트의 첨부 아래 「공유 중 · <대화방> · 끄기」, 방을 나간 주인도 끔(시트 · 메시지의 「공유 그만두기」), 끄면 방의 메시지 카드도 곧바로 잠김, 새로 공유는 방에 있어야 | 검토 11-25 | F-MA-07(시트의 「끄기」) · `mailAttachments.integration` MA-R5 | feature · 통합 | ✅ |
| **팩스(TIFF) 첨부**(운영 11-25 「[KT 스마트메시지 Plus] 팩스 메시지 도착알림」의 `arrive_….tif` 가 FILE · 「앱 안에서 열지 않는 형식이에요」뿐): 칩 IMG → 보기 화면 ‹ 1 / 2 › → 2쪽(그려진 그림), 이 서버 경로의 서명 주소(`image/tiff` 그대로), 손상된 TIFF 는 「이 TIFF 는 열 수 없어요」 · 「내려받기」 | 사용자 11-25 | F-MA-09 · `mailAttachments.integration`(팩스) | feature · 통합 | ✅ |
| 팩스 「이 첨부로 묻기」 → 에이전트가 팩스와 쪽마다 PNG(1728 × 2290)를 받음 — 작업 공간이면 팩스 옆 `<이름>-page<n>.png`, 아니면 비공개 서명 주소(`…/page-<n>.png`), 넘긴 쪽 그림도 턴의 끝에 카드가 되지 않음(handed), 손상된 TIFF 는 이유와 함께 파일만 | 사용자 11-25 | F-MA-09(가짜 에이전트가 PNG 를 열어 봄) · `mailAttachments.integration`(팩스) | feature · 통합 | ✅ |
| 팩스 · 휴대폰 390px 밝은 · 밤: 칩 · 보기 화면 · 쪽 넘기기가 화면 안, 한 쪽이 통째로 | 사용자 11-25 | F-MA-10 | feature | ✅ |
| **#6** 작업 공간에 쓸 때 쓸 때마다 무작위 폴더, 거쳐 가는 폴더가 링크면 쓰지 않음, 파일은 `O_EXCL \| O_NOFOLLOW` · 0600 | 검토 11-25 | MA-R6(`mailAttachments.test.js`) · F-MA-03(경로 모양) | 단위 · feature | ✅ |
| 실제 Gmail 의 원문 크기 한도 · 수십 MB 첨부의 실제 시간, IMAP 메일함(크기 · 시간 한도 포함), 운영 deepagents 가 서명 주소로 받는 것, 운영 저장소에 비공개 버킷이 처음 생기는 것, 실제 모델의 답, 영어 화면 | — | — (가짜 Gmail · 로컬 저장소 · 가짜 에이전트) | — | ✗ |

### 설치 번들에 대고 돌리기 (Docker Compose)

```bash
cd install && PW=$(grep ^POSTGRES_PASSWORD= .env | cut -d= -f2-); D=$(grep ^LITE_DATA_DIR= .env | cut -d= -f2-); cd ../e2e
PGPT_URL=http://localhost:18080 MAILPIT_URL=http://localhost:18025 PGPT_TENANT=lite \
PGPT_WORKSPACE=$D/deepagents/workspace/lite PGPT_SKILLS_DIR=$D/deepagents/skills/lite/local \
npm run test:smoke   # DB·MCP·miner 를 직접 여는 시험은 PGPT_DB_URL·MCP_URL·MINER_URL 을 열어 줘야(compose override 의 ports) 돈다
```

작업 공간 폴더(`$D/deepagents/workspace/<테넌트>`)는 첫 에이전트 실행 때 생기므로 스킬 공유 시험 전에 없으면 만들어 둡니다.

### Docker lite 에서 건너뛰는 시험

설치 번들의 lite 프로필에는 ArtCraft 앱, 개발 PC 의 BFF 소스, process-miner 가 없습니다. 그 시험은 실패가 아니라 이유를 단 건너뜀으로 끝납니다:
`/api/config` 의 `craft` 가 없다고 하면 S-30·F-CR-*·F-ED-04(ArtCraft)·F-ED-08·F-CV-04(SVG 부분)·A-05·A-06·A-11,
DB 를 직접 열 수 없으면(`PGPT_DB_URL` 없음) 시드가 필요한 시험, 서버 소스가 없으면(`lib` 픽스처) 단위·모듈 시험, 로컬 서버가 아니면 S-25(lsof),
miner 가 없으면 F-MN-02.

## 남은 공백(다음에 채울 것)

- 모델 채점·긴 실행이 필요한 것: 스킬 병합 전 검증, SNS 트렌드 프로세스 전체, 프로세스 인스턴스가 변형을 이어 쌓기, 작업실 스티어링, 브라우저 결정 게이트 측정.
- 화면 비교가 필요한 것: ArtCraft 한글 글꼴, 하늘·밤 테마, 온보딩 애니메이션.
- 장비가 필요한 것: Android 에뮬레이터.
- 서버 재시작이 필요한 것: 응답 없는 보관함 요청의 만료, 재시작 뒤 알림 유지(개발 서버를 함부로 재시작하지 않기 위해 뺌).

## 알려진 제품 결함 (이 스위트가 찾은 것)

실패로 남겨 두었습니다. 고쳐지면 시험이 저절로 통과합니다.

| id | 시험 | 내용 |
|---|---|---|
| B1 (고침) | S-33 | `GET /api/instances` 와 `GET /api/instances/:id` 가 참여하지 않은 사용자에게도 테넌트의 모든 인스턴스와 산출물(보고서·파일 URL)을 돌려준다. 같은 단계의 작업실은 `canAccess` 로 막혀 있다. |
| B2 (고침) | F-PA-05, F-PA-09 | db 단계 패널 앱에서 자기 행을 지우면 409 "다른 사람이 먼저 고쳤어요". `PanelAppCard.vue` 가 `?_v=` 에 타임스탬프(`…+00`)를 인코딩하지 않고 보내 `+` 가 공백이 된다. |
| B3 (고침) | F-PR-02 | 팀·역할에서 아무도 맡지 않은 역할이 시작한 사람이 아니라 정의에 들어 있던 기본 담당자(`demo@localhost`)에게 간다. 명세: "담당자가 없는 역할 … 은 일을 시작한 사람이 SHALL 맡는다". `engine.startProcess` 가 비어 있지 않은 `endpoint` 를 그대로 둔다. |
| B4 | A-01 | 대화 맥락 라우터가 전혀 다른 주제("부산 출장 숙소" 다음 "회사 유튜브 채널 새 이름")를 판단 모델(Qwen3-4B, `strategy: judge`, `confidence: 1`)로 같은 대화에 이어 붙인다. 새 사용자에서 3번 모두 재현. |
| B5 | A-08 | 채팅으로 스킬을 만들면 초안이 대화 폴더가 아니라 테넌트 공용 `/workspace/.bpmn/skills/<이름>` 에 써지고, 초안 카드는 그 턴에 지나간 마지막 `SKILL.md` 를 집어 다른 스킬(`slack-weekly-summary`)을 보여 준다. 요청한 스킬은 따로 만들어져 있는데 카드가 엉뚱한 스킬을 가리킴(2회 재현). 같은 요청을 다시 하면 기존 폴더만 "확인"하고 카드가 아예 안 나오기도 한다. |
| B6 (고침) | A-03 | 패널 앱("할 일")을 쓰는 사람의 "다음주 월요일에 휴양림 가는 일정 추가"가 "일정" 낱말 때문에 라우터를 건너뛰고 연결도 안 된 캘린더 커넥터로 바로 가 행이 안 생긴다. 이제 패널 앱이 있으면 실제로 연결된 커넥터가 있을 때만 바로 보낸다(`lib/agent.js connectorFirst`). |
| B7 (고침) | F-ED-01·02·04·07 (Docker) | 설치 번들의 server 에 `PRO_OFFICE_HOST_URL`·`PRO_OFFICE_MCP_URL` 이 없어 열린 문서의 `office_live_*` 도구가 안 보이고(라이브 편집 불가) 메일 한글 초안이 office-mcp 에 닿지 못한다. |
| B8 (고침) | F-WR-02 (Docker) | 작업실 터미널이 `$SHELL` 이 없으면 `/bin/zsh` 를 띄우는데 server 이미지엔 zsh 가 없어 `execvp failed`. 있는 셸(zsh→bash→sh)로. |
| B9 (고침) | (개발 스택 BFF 가 죽음) | DB 가 복구 모드일 때 배경 작업이 다시 연결하며 낸 거절 하나(`57P03`)가 처리되지 않아 BFF 프로세스가 끝난다. 처리되지 않은 거절은 기록만 하도록(`index.js`). |

## 최근 실행 결과 (2026-10-26, v0.1.0 준비)

개발 스택(Vite :5180 → BFF :8787):

| 단계 | 결과 | 시간 |
|---|---|---|
| smoke | 57 중 57 통과 | 1.3분 |
| feature | 83 중 83 통과 (부하가 큰 때 F-CV-02·F-CV-03·F-ED-05·F-PA-09 가 화면이 늦게 떠 한 번씩 실패 — 단독 재실행 통과, F-UT-03 은 재시도로 통과) | 2.5분 |
| agent | 13 중 11 통과 · 2 실패(A-01 = B4, A-08 = B5, 알려진 결함). A-03 은 B6 고친 뒤 첫 시도에 통과. A-11·A-12 는 Docker VM 메모리가 바닥나 DB 가 복구 모드에 들어간 동안 실패했다가, 부하가 줄어든 뒤 다시 돌려 재시도로 통과([flaky]) | 44분 + 재확인 11분 |

설치 번들(`install/`, 새로 받은 main 의 얕은 클론, lite + mining 프로필, 포트 18180, 시험 워커 1):

| 단계 | 결과 |
|---|---|
| smoke | 57 중 41 통과 · 14 건너뜀(ArtCraft 없음: S-30 ×5 · 컨테이너 BFF 라 호스트 lsof 불가: S-25 ×5 · 서버 소스(`lib`) 필요: S-33·S-40·S-41 · 로컬 BFF 전용: S-34) · 2 실패(S-10·S-11 — 화면이 늦게 떠, 같은 시험 재실행 통과) |
| feature | 83 중 30 통과 · 39 건너뜀(ArtCraft 없음: F-CR-* ×7·F-ED-04 ×5·F-ED-08 · 서버 소스 `lib`·호스트 스킬 폴더 필요: F-PA-* ×9·F-SK-* ×6·F-UT-* ×5·F-RS-03·04·F-SC-03·F-TM-03·F-MN-03 · miner 를 호스트에 열지 않음: F-MN-02 · 앞 시험 실패로 안 돈 F-CV-04·05) · 12 실패 → 고친 것: B7·B8, 프로세스 엔진이 없는 lite 에서는 건너뜀, 역할 경합(락). F-CV-03·F-FO-10 은 재실행 통과. 고친 번들로 다시 올린 스택의 재확인은 개발 DB 보호를 위해 중단(아래) |
| agent | 돌리지 않음 — 시험 스택이 떠 있는 동안 개발 스택의 supabase-db 가 두 번 복구 모드에 들어감(Docker VM 31GB 중 남은 메모리 1.3~2.5GB) |

## 구조

```
e2e/
  playwright.config.js     세 단계(project)·보고서·trace/스크린샷 설정
  lib/env.js               주소·DB·소스 위치(환경 변수)
  lib/api.js               로그인(pro-rt-* 만)·JSON 호출·MCP·채팅 SSE·첨부 올리기
  lib/fixtures.js          as(area) · pageAs(area) · db · cleanup · lib(서버 모듈)
  lib/db.js · seed.js      시드(대화·파일 카드·폴더)·정리, 작은 PNG/SVG/DXF/WAV/XLSX/MP4 생성
  lib/panel.js · chatseed.js · net.js · agent.js
  lib/teardown.js · cleanup-cli.js
  tests/smoke/*            health-auth · screens · security · panel-privacy · installer
  tests/feature/*          folders · skills · panel-apps · conversations · editors-live · resilience ·
                           team-process · schedules · workroom · vault-connectors · server-unit
  tests/agent/journeys.spec.js
```

### 쓸 때 주의

- ArtCraft(egui) 앱은 dpr 1 에서만 배치가 맞습니다 — 설정의 `deviceScaleFactor: 1` 을 바꾸지 마세요.
- 산출물 스택의 더미는 늘 흔들립니다(애니메이션) — `click({ force: true })`, 펼친 뒤 잠깐 기다렸다 누릅니다.
- 이음오피스 시트는 문서를 다 읽으면 키보드 포커스를 가져갑니다 — 다이얼 입력 전에 문서 준비를 기다립니다.
- agent 단계는 모델 답이 흔들리므로 한 번 더 시도합니다(`retries: 1`). `[flaky]` 표시가 붙은 시험은 실패해도 같은 단계의 다른 시험과 함께 판단하세요.
