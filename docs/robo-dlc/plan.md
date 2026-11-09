# Robo-DLC Lite — Process GPT Lite 패널로 만드는 AI-DLC 팀 워크스페이스

- 브랜치: `feat/robo-dlc` (기준 `origin/main` 21a9ef0)
- 상위 기획: `uengine-platform/robo-dlc/plan.md` (독립 제품 판). 이 문서는 **Process GPT Lite와만 통합하는 판**이다.
- 표기: [있음] Lite에 이미 있는 것 · [새로] 이번에 만드는 것 · [다음] 뒤 단계

## 1. 한 줄

AI-DLC로 일하는 팀이 Lite **홈 패널**에서 작업 진행, 사람 대기, 볼트, 품질, 질문·승인을 역할별로 보고, **패널 앱**으로 역할 배정과 승인 원장을 관리한다. AI-DLC 저장소는 **연결형 공유 폴더**로 붙인다.

## 2. Lite에서 계승하는 것

| 필요한 것 | Lite 기존 기능 | 쓰는 방식 |
|---|---|---|
| 프로젝트 연결·권한 | 공유 폴더 `POST /api/folders/link`(연결형 git 저장소), 구성원 역할 viewer·runner·editor·owner [있음] | AI-DLC 저장소를 연결형 폴더로 붙이고, 폴더 구성원만 AI-DLC 화면을 봄 |
| 대시보드 | 홈 패널(`pro_panels`, 샌드박스 iframe 런타임 `panel.*`) [있음] | 런타임에 읽기 전용 `panel.aidlc(path)`를 더함 [새로] |
| 사용자가 말로 만드는 대시보드 | 패널 생성기(`generatePanel`) [있음] | 생성 프롬프트에 `panel.aidlc` 사용법을 더함 [다음] |
| 데이터 앱 | 패널 앱(xlsx·db 단계, 행 규칙, 이벤트 소싱, 가림) [있음] | 역할 배정표, 승인 원장, 검토 기준표 [다음] |
| 진행 방식(AI-DLC 실행) | cliagents(Claude Code 실행·세션 이어 가기), 작업실 터미널 [있음] | 연결 폴더에서 `claude -p "/aidlc …"` + `--resume` [다음] |
| 몹 세션 | 대화방 원격 회의(받아쓰기·회의록) [있음] | 도메인 설계 같은 단계에 역할들을 모아 회의, 회의록 → 질문 답 초안 [다음] |
| 흐름 분석 | 프로세스 마이닝 [있음] | 감사 기록을 이벤트 로그로 넘김(케이스 = 작업·유닛) [다음] |

## 3. 추가할 대시보드(홈 패널)

모두 감사 기록·상태 파일·질문 파일·검토 파일에서 계산한다. 별도 입력이 없다.

| # | 패널 | 보는 사람 | 보여 주는 것 | 데이터 | 단계 |
|---|---|---|---|---|---|
| D1 | AI-DLC 작업 현황 | 모두 | 단계 레일(완료·진행·대기·건너뜀), 현재 단계와 담당 역할, 다음 할 일, 지금 기다리는 관문과 대기 시간 | `summary` | P0 |
| D2 | 사람 대기 | 딜리버리 리드, 승인자 | 단계별 AI 작업 시간 vs 사람 대기 시간, 반려 횟수, 오래 기다린 순 | `summary.stages` | P0 |
| D3 | 볼트 보드 | 딜리버리 리드, 개발자 | 유닛 의존·상태·소요 시간·체크포인트 검증(성공·실패) | `summary.units` | P0 |
| D4 | 품질 | QA, 아키텍트 | 센서 실행·실패, 검토 판정(READY·NOT-READY)과 남은 Major, 체크포인트 검증 | `summary.quality` + `reviews` | P0 |
| D5 | 감사 타임라인 | 모두, 컴플라이언스 | 최근 사건 흐름(질문·답·승인·반려·검증) | `timeline` | P0 |
| D6 | 내 질문함 | 역할별(PO·아키텍트·…) | 답이 비어 있는 질문과 보기, 질문 파일 위치 | `questions` | P0 보기 / P1 답하기 |
| D7 | 승인 대기 | 승인자 | 관문 대기 중인 단계, 문서·검토 의견 요약, 승인·수정 요청 단추 | `summary.pendingGate` | P1 |
| D8 | 검증 피로 신호 | 승인자, 컴플라이언스 | 문서 크기 대비 너무 짧은 승인, 같은 사람의 연속 승인 | 승인 원장 | P2 |

## 4. 추가할 앱(패널 앱)

| # | 앱 | 단계 | 항목 | 규칙 |
|---|---|---|---|---|
| A1 | 역할 배정표 | db | 사람, 역할(PO·디자이너·아키텍트·딜리버리 리드·개발자·QA·보안·컴플라이언스·운영·승인자), 프로젝트, 받을 주제 | 행 수정은 owner·editor |
| A2 | 승인 원장 | db·이벤트 소싱 | 단계·유닛, 판정(승인·수정 요청), 승인자, 역할, 문서 해시, 남은 Major, 시각 | 추가만(수정·삭제 불가), 요청자 ≠ 승인자 |
| A3 | 검토 기준표 | xlsx | 단계별 확인 항목(영향 범위, 되돌리기 경로, 보안 규칙 …) | 팀 리드 수정 |
| A4 | 승인 정책 | db | 「보안 문서는 보안 담당 승인」, 「Major가 남으면 승인 불가」 같은 규칙 | 정책 엔진 병합 뒤 [다음] |

## 5. 행동과 안전장치 [다음]

- 질문 답하기: 질문 파일(`*-questions.md`)을 폼으로 그려 `[Answer]:`를 채우고, 진행 방식이면 세션을 이어 「done」을 보낸다.
- 승인·수정 요청: 패널 스크립트는 모델이 쓴 코드이므로 **직접 보내지 않는다**. 패널은 요청만 하고, 부모 창이 승인자 이름·역할·문서를 보여 주는 확인 창을 띄운다. 사람이 누르면 승인 원장(A2)에 남기고 엔진에 전달한다. AI-DLC의 사람 확인 가드는 모든 프롬프트를 사람 입력으로 보기 때문이다.
- 유닛 선점: `aidlc --claim <unit>`을 단추로 감싼다.

## 6. 구조 (P0)

```
홈 패널(iframe) ── panel.aidlc('<folder>/intents/<space>/<slug>/summary')
   │ postMessage
PanelFrame.vue ── GET /api/aidlc/<path> 만 대신 부름(읽기 전용, 경로 검사)
   │
routes/aidlc.js ── 폴더 구성원(viewer 이상)만
   │
lib/aidlc/record.js   aidlc/ 기록 읽기(상태·감사·질문·검토·유닛), 폴더 밖 경로 거부
lib/aidlc/metrics.js  단계·유닛별 AI 작업/사람 대기, 반려, 센서, 체크포인트
lib/aidlc/stages.js   AI-DLC 2.11.2 단계 33개와 담당 역할
lib/aidlc/presets.js  D1~D6 패널(LLM 없이 정해진 HTML·스크립트)
```

API (모두 GET, 폴더 slug 기준):
- `/api/aidlc/projects` — 내가 볼 수 있는 폴더 중 `aidlc/spaces`가 있는 것
- `/api/aidlc/:folder/intents` — 작업 목록
- `/api/aidlc/:folder/intents/:space/:slug/summary` — 상태·단계 레일·지표·대기 관문·유닛·품질
- `/api/aidlc/:folder/intents/:space/:slug/timeline?limit=` — 최근 사건
- `/api/aidlc/:folder/intents/:space/:slug/questions` — 질문 파일과 답 상태
- `/api/aidlc/:folder/intents/:space/:slug/reviews` — 검토 판정과 지적
- `POST /api/aidlc/:folder/panels` — D1~D6 패널을 홈에 추가

## 7. 단계

| 단계 | 내용 |
|---|---|
| P0 (이번) | 읽기 모듈·지표·API, `panel.aidlc`, 프리셋 패널 D1~D6, 단위 시험(실습 기록 고정 자료) |
| P1 | 역할 배정표(A1)·승인 원장(A2), 질문 답하기 폼, 승인 확인 창, 생성 프롬프트에 `panel.aidlc` |
| P2 | 진행 방식: cliagents로 `claude -p "/aidlc …"`·`--resume`, 상태 변화 알림(bus) |
| P3 | 몹 세션(회의), 프로세스 마이닝 연결, 승인 정책(A4), 검증 피로 신호(D8) |

## 8. 결정과 위험

- 폴더 작업 사본을 읽는다(커밋 전 진행도 보임). 관찰 방식(개발자 로컬 실행)에서는 저장소에 올라온 기록만 보인다.
- AI-DLC 2.11.2 파일 이름·사건 이름에 기대므로, 실습 기록을 고정 자료로 한 시험이 깨지면 버전 변경을 의심한다.
- 연결형 폴더는 서버가 읽을 수 있는 경로여야 한다(설치판에서는 마운트 필요).
