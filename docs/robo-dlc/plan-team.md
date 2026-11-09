# Robo-DLC Lite P1 — 팀이 함께 하는 AI-DLC (몹 정교화 · 몹 구축 · 쉘 개입 · 사람 판단)

- 브랜치: `feat/robo-dlc` (P0 대시보드 위에 쌓음). P0 기획은 `plan.md`.
- 계기(2026-11-09 사용자): "각 몹 정교화, 몹 구축 단계에서 팀원들이 모여 화상회의를 하면서 지금 만들어진 요구사항 등을 합의하는 과정이
  순서대로 와야 하고, Claude Code로 코드를 만드는 동안 언제든 쉘을 열어 진행을 보고, 중요한 결정은 사람에게 알림으로 넘어와 코딩 중간이든
  개입하는 과정이 보여야 한다." P0 영상은 끝난 기록을 패널별로 훑고, 첫 단계 하나만 실제로 돌렸다. 팀이 함께 일하는 장면이 없었다.

## 1. 실측으로 확인한 것 (11-09, 대화형 Claude Code 2.1.319 + AI-DLC 2.11.2, tmux)

| 사람이 끼어드는 곳 | 화면(Claude Code) | 감사 기록 | Lite가 넘길 입력 |
|---|---|---|---|
| 질문 답하는 방식 | 선택 창 「1 Guide me · 2 I'll edit the file · 3 Chat」 | `DECISION_RECORDED` (Question Kind answer-mode, Options) | 숫자 `2` → 파일에 답을 적은 뒤 `done` |
| 요약 확인 | 선택 창 「1 Looks correct · 2 Request changes」 | `DECISION_RECORDED` (Checkpoint Consolidated Summary Confirmation) | `1` 또는 `2` |
| 단계 승인 | 선택 창 「1 Approve · 2 Request Changes · 3 Type something」 + 검토 지적 목록 | `STAGE_AWAITING_APPROVAL` | `1`, 또는 `3` 뒤 수정 요청 글 |
| 구현 계획 승인 (plan_approval) | 선택 창(예상) | `PLAN_APPROVAL_BLOCKED` 등 | 숫자 |
| 판단이 갈리는 질문(몹 단계 중간) | 질문 파일에 새 질문 + 선택 창 | `DECISION_RECORDED` | 숫자 또는 파일 답 |

- 숫자 키 하나로 선택 창이 골라지고, AI-DLC는 이를 사람의 답(`QUESTION_ANSWERED`, Person Reply)으로 기록한다. 사람 확인 가드도 통과한다.
- 처음 여는 저장소는 신뢰 창(기본값 "No, exit")이 뜬다. 사람이 공유 쉘에서 한 번 고른다.
- 선택 창이 떠 있는지는 화면 끝의 "Enter to select · ↑/↓ to navigate" 로 안다(작업실 세션이 화면 글자를 400KB 갖고 있다).

## 2. 계승할 Lite 기능 (조사: 작업실·회의·알림)

| 필요한 것 | 있음 | 새로 |
|---|---|---|
| 같이 보는 Claude Code 쉘 | 작업실 터미널: node-pty 하나에 여러 사람이 붙어 보고 입력(`server/lib/workroom.js`), 폴더 방의 cwd 는 연결 저장소 경로 | 연결형 AI-DLC 폴더에 작업실 단추, `claude` 모드, 아무도 안 볼 때도 세션 유지, 서버가 세션에 글을 넣는 함수(`send`), 선택 창 감지 |
| 사람에게 넘기기 | 홈 카드 `notifyUser`(SSE 즉시), 역할 → 사람(`pro_role_assignments`) | AI-DLC 단계 역할 → 사람(폴더별 역할표), 감시기(감사 기록에서 "지금 사람을 기다리는 것"), 결정 화면(선택지·승인·수정 요청 글·쉘 열기·회의 열기), 결정 원장 |
| 몹 회의 | 팀 대화방, 화상 회의(받아쓰기·자료·회의록·할 일 카드) | AI-DLC 팀 대화방(역할표 사람들), 자료에 질문 파일·산출물, 회의록 → "합의한 답을 질문 파일에 적기" 카드 → 파일에 적고 세션에 `done` |
| 진행 보기 | P0 대시보드 6종 | 작업 현황에 "지금 누가 무엇을" 과 쉘 열기 |

## 3. 시나리오 (핸즈온 레벨 2 순서를 그대로)

새 저장소 `robo-dlc-demo/team-app`, 범위 `classic`, 작은 앱(유닛 2개 안팎). 역할표: 팀 리드 한지수(진행), PO 오세린, 아키텍트, 개발자, QA.

| # | 핸즈온 장 | AI-DLC | 팀이 하는 일(Lite) |
|---|---|---|---|
| S1 | 9 팀 규칙 | practices-discovery 질문 | 팀 리드가 폴더에서 「AI-DLC 세션 시작」, 쉘에서 `/aidlc classic "…"`. 질문 카드 → 팀 리드가 답 |
| S2 | 10 요구사항 | requirements-analysis 질문 → 요약 확인 → 승인 | **몹 정교화 회의**: PO·아키텍트·개발자·QA 가 대화방 회의, 자료에 질문 파일. 회의록 → 「답 적기」 카드(PO) → 파일에 적고 `done` → 요약 확인 카드 → 승인 카드(PO) |
| S3 | 11 스토리·화면 | user-stories(AI 몹) 중간 판단 질문 | 판단 질문 카드 → PO 가 고름 |
| S4 | 12~13 도메인·유닛·API | 승인 관문, 반려 한 번 | 아키텍트가 결정 화면에서 「수정 요청」 + 글 → 세션에 들어감 → 고친 뒤 승인 |
| S5 | 14 볼트 계획 | delivery-planning 승인 | **몹 구축 회의**: 볼트 순서·담당 합의 → 팀 리드 승인 |
| S6 | 15~17 구현 | 유닛별 계획 승인 → 코드 생성 | 개발자: 계획 승인 카드 → 작업실 쉘에서 코드 생성을 지켜봄. **코딩 중 결정**(검증 실패·권한·판단 질문) 카드 → 쉘을 열고 직접 입력해 개입 |
| S7 | 18 빌드·테스트 | 승인 | QA 가 결과를 보고 승인 |

각 행이 시험(E2E 단계) · 녹화 마크 · 스펙 시나리오 · 튜토리얼 30장 「따라 하기」가 된다.

## 4. 구현 단위

| 단위 | 내용 | 파일 |
|---|---|---|
| C1 세션 | 폴더별 AI-DLC 세션 = 작업실 폴더 방 `claude` 모드(cwd 연결 저장소), 유지, `send(text)`·`key(n)`·`screenTail()`·`choosing()` | `server/lib/aidlc/session.js`, `workroom.js` 작은 확장, 라우트 |
| C2 역할표 | 폴더별 AI-DLC 역할(team-lead·product·architect·developer·quality …) → 사람 | `server/sql/0NN_aidlc_team.sql`, 띠의 역할 편집 |
| C3 감시기 | 연결 AI-DLC 폴더마다 10초: 지금 사람을 기다리는 것(질문 대기·요약 확인·승인 대기·계획 승인·판단 질문)을 찾아 역할 담당자에게 카드(한 번만), 끝나면 카드 닫음 | `server/lib/aidlc/watch.js` |
| C4 결정 화면 | 카드 → `/aidlc/:folder/decide` : 질문·검토 지적·선택지, 승인·수정 요청(글)·선택, 쉘 열기, 몹 회의 열기. 결정은 원장에 남기고 세션에 입력 | `src/views/AidlcDecide.vue`, `routes/aidlc.js` |
| C5 몹 회의 | 폴더의 AI-DLC 팀 대화방(역할표 사람들), 회의 자료에 질문 파일·산출물(연결 폴더 파일 한 개 보기), 회의록 → 「답 적기」 카드 → 질문 파일 `[Answer]:` 쓰기 + 세션 `done` | `server/lib/aidlc/mob.js`, 회의 자료 종류 `folder-file` |

결정: 승인·답은 Lite 화면에서 해도 실제 입력은 공유 쉘의 선택 창으로 들어간다(AI-DLC의 사람 확인 가드와 감사 기록이 그대로 남도록). 세션이 선택 창을 띄우지 않았을 때 들어온 결정은 쉘에 넣지 않고 "아직 묻지 않았어요"로 돌려준다.

## 5. 위험

- 대화형 Claude Code 한 세션 = 사용자 Claude 계정. 여러 팀원이 같은 세션을 함께 쓰는 것은 계정 정책 확인이 필요하다(PoC 는 데모 계정 한 명).
- 긴 실행: classic 한 판이 몇 시간. 녹화는 압축 구간으로, 시험은 단계별 고정 기록 + 실제 세션 짧은 판.
- 선택 창 감지가 화면 글자에 기댄다(Claude Code 버전에 따라 문구가 바뀔 수 있음) → 감지 실패 시 쉘을 열라는 안내로 떨어진다.
