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
| 대화 안에서 보낸 메시지는 그 대화로 이어짐(요청에 conversation id) | — | F-CV-05 | feature | ✅ |
| 산출물 스택: 대화의 파일이 더미로, 누르면 부채꼴(≤fanMax), 많으면 격자, Esc 로 접기 | `ArtifactStack.vue` | F-CV-03 | feature | ✅ |
| 스택에서 누르면 카드와 같은 편집기(엑셀→이음오피스, SVG→VectorCraft) | `artifacts.js` | F-CV-04 | feature | ✅ |
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

### 10. 보관함·브라우저 에이전트 (spec `pgpt-pro_credential-vault` · `pgpt-pro_vault-key-management` · `pgpt-pro_browser-credential-handoff` · `pgpt-pro_browser-decision-gates`, 영상 `n5SBj_iRbig`)

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
| 설치 번들: 스크립트 문법·compose(lite/full/mining)·인계 기록 스키마·nginx 경로 | `install/` | S-50…S-52 | smoke | ✅ |
| 설치 스택에 대고 전체 스위트 | `PGPT_URL=http://localhost:18080` | (전체) | 모두 | ◐ |

## 단계별 시험 수

| 단계 | 파일 | 시험 수 |
|---|---|---|
| smoke | `tests/smoke/*.spec.js` (5개) | 57 |
| feature | `tests/feature/*.spec.js` (14개) | 89 (서버 단위 시험 4묶음 포함, 회의 F-MT-01…06) |
| agent | `tests/agent/*.spec.js` (4개) | 14 (회의 A-14) |
| 합계 | | 160 |

openspec 명세 13개의 요구사항 112개: 덮음 73 · 일부 20 · 공백 19. 명세 밖의 기능 요건(영상·최근 추가 기능: 대화 목록·산출물 스택·로봇 버튼·끊김 복구·유휴 타임아웃·DB 풀·멘션·예약·설치 번들 등) 31개: 덮음 27 · 일부 1 · 공백 3.

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
