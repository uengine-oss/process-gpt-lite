# Robo-DLC Lite P4 — 대화로 물은 것도 카드로 · 추정 없이 바로 시작 · 볼트마다 작업 트리

- 브랜치: `feat/mcp-apps` (P3 위). 커밋 `3a05ffa`(훅·대화로 물은 것) · `41d190b`(바로 시작·작업 트리) 이후.
- 계기(2026-11-14 사용자): "이런 몹 일라버레이션 의사결정 상황이 됐다는 걸 어떻게 알려서 보내주나 … 그 이벤트를 어떻게 지금 개최하는 거지?" ·
  "작업 폴더는 볼트별로 작업 폴더가 만들어져야 되지 않나?" · "UI로 못하는 이유" → "그래 진행해".

## 1. 무엇이 문제였나 — 실제 판 2(비품 대여)에서

| 본 것 | 원인 | 결과 |
|---|---|---|
| AI-DLC 가 승인을 선택 창 없이 대화로 물었다(「Build and Test를 승인할까요? 1. **Approve** 2. **Request Changes**」) — 세 번 | 감시기는 8초마다 **화면의 선택 창**과 **답이 빈 질문 파일**만 본다 | 카드가 생기지 않았고, 하나를 놓쳐 세션이 약 41시간 멈췄다. 볼트 보드는 그 시간을 u5 의 「AI 작업 43.5시간」 으로 셌다 |
| 「코드 생성으로 넘어가겠습니다.」 라고 말하고 멈춘 세션 | 같은 까닭 | 누군가 「계속」 이라고 말할 때까지 멈춤 |
| 모든 볼트가 main 작업 사본에 바로 썼다 | AI-DLC 의 기본은 `unit-major` + `serial`. 병렬(`swarm`)일 때만 볼트마다 작업 트리를 만든다 | 볼트 하나만 버리기 어렵고(P3 은 시작 전 스냅숏으로 되돌림), 유닛을 나란히 못 만든다 |
| 시작은 터미널에서 `/aidlc classic "…"` 를 쳤다 | 작업 접수(P3)는 그 판보다 늦게 생겼고, 접수는 늘 약 1분짜리 계획안을 거친다 | 범위를 이미 아는 사람도 계획안을 기다려야 했다 |

## 2. 확인한 사실

- **Claude Code 훅(2.1.325, 실험 `scratchpad/hooklab`)**: `--settings <파일>` 로 넘긴 훅이 돈다. `Stop` 에 `last_assistant_message`(세션이 멈추며 한 말 그대로), `UserPromptSubmit` 에 `prompt`, 60초 쉬면 `Notification` 의 `notification_type: idle_prompt`.
- **멈춘 화면**: 입력창(가로줄 사이 `❯`)이 비었고, 도는 스피너가 없다(`✶ Razzle-dazzling… (14s · ↓ 1.0k tokens)`, `✻ Waiting for 1 background agent to finish` 는 일하는 중, `✻ Worked for 4s · done 8:14 AM` 은 끝난 턴의 요약). 녹화해 둔 화면 fixture 로 확인.
- **AI-DLC 2.11.2 swarm**(설치본 `.claude/` 를 읽어 확인, 실제 판 3 에서 다시 확인):
  - 작업 트리 `<저장소>/.aidlc/worktrees/bolt-<id8>_<유닛>`, 가지 이름도 같다(`<id8>` = 인텐트 UUID 끝 8자리). 승인되면 `aidlc engine worktree merge --strategy squash` 로 커밋 「Bolt <slug>」 하나. 버리면 `refs/aidlc/parked/…` 에 보관하고 `restore` 로 되살린다.
  - 같은 세션이 지휘하고, 한 묶음(DAG batch)의 유닛마다 Task 하위 에이전트가 동시에 돈다. 일꾼의 진행은 **작업 트리 안의 감사 기록 조각**에 쌓이고 병합 때 본 기록으로 합쳐진다(`AUDIT_MERGED`).
  - 감사 사건: `BOLT_STARTED` · `WORKTREE_CREATED`(작업 트리 경로·가지) · `SWARM_STARTED` · 묶음 체크포인트(`DECISION_RECORDED` Swarm Batch Approval) · `SWARM_UNIT_CONVERGED` · `SWARM_SOURCE_MERGED`(실제 병합의 증거) · `SWARM_UNIT_FAILED`/`BOLT_FAILED` · `WORKTREE_DISCARDED`.
  - 사람에게 묻는 것: 묶음 계획 승인·묶음 체크포인트·실패의 Retry/Abort 는 **선택 창**. 작업 트리를 만들기 전 「승인된 소스를 커밋해 주세요」 는 **대화로** 묻는다(「Never commit automatically」) — 이번에 고친 공백이 바로 여기에 걸린다.
  - 병렬은 `stage-major` + `swarm` 이어야 하고, 사람의 말로만 켠다. Construction 전에는 `--message` 없이도 설정할 수 있고, 문서가 정한 때는 딜리버리 계획(「단위를 동시에 만들지」 질문)이다. classic 은 스켈레톤이 꺼져 있다(feature·mvp 등은 첫 유닛을 먼저 끝까지 만든 뒤 병렬).
  - 한 저장소에서 두 세션이 서로 다른 인텐트를 동시에 진행하는 것은 문서가 보장하지 않는다(세션마다 인텐트 연결 파일은 있지만 `.current-session` 등 공유 파일이 있다). 병렬 인텐트가 필요하면 저장소 사본이나 바깥 작업 트리를 따로 쓰는 편이 안전하다 — 이번 범위 밖.

## 3. 이번에 한 것

| 칸 | 내용 | 어디 |
|---|---|---|
| 훅 | 팀 세션을 띄울 때 `--settings` 로 훅 셋(Stop·UserPromptSubmit·Notification)을 넘긴다. 훅은 `curl` 로 이 서버의 `/api/aidlc/hook/<세션>` 에 알리고(로컬·세션별 서명만 받음, 실패해도 세션은 안 기다림), 받으면 그 폴더를 바로 다시 본다 | `lib/aidlc/hooks.js`, `routes/aidlc.js`, 설정·키는 `~/.pgpt-lite/aidlc-hooks`(600) |
| 대화로 물은 것 | 선택 창도 빈 질문 파일도 없는데 세션이 멈춰 있으면 대기 하나: 훅이 준 말(없으면 화면의 마지막 말, 같은 화면이 6초 서 있어야). 말에서 고를 것을 읽는다 — 굵은 번호 목록(승인), `**done**` 같은 답할 말, 물음표(답), 아무것도 없으면 「멈춰 있어요」 + 「계속 진행해 주세요」 | `lib/aidlc/ask.js`, `watch.js` |
| 결정 화면 | 「대화로 물은 승인/물음/멈춘 세션」 칸: 세션의 말, 고를 말 단추(Request Changes·Other 는 글을 받는다), 직접 적어 보내기 → 입력창에 그대로, 결정 기록에 남음 | `src/views/AidlcDecide.vue`, `POST /api/aidlc/:folder/reply` |
| 추정 없이 바로 시작 | 접수 권한자가 범위를 고르고 계획안 없이 시작 단계로. 계획안 칸에는 고른 범위만 | `lib/aidlc/intake.js` `proposeDirect`, `apps/intake` |
| 볼트마다 작업 트리 | 시작 옵션. 고르면 요청 뒤에 「구축은 유닛을 병렬로, 볼트마다 작업 트리에서 진행해 주세요(stage-major + swarm).」 — AI-DLC 가 사람의 말로 켜고 작업 트리를 스스로 만든다. 유닛으로 나뉘는 범위(classic·feature·mvp·enterprise·workshop·infra)는 기본으로 켬 | `intake.js` `begin`, `pro_aidlc_requests.worktrees`(sql 042) |

## 4. 결정 (위임받아 정함 — `docs/decisions` D-1114-01~03)

- **D-1114-01 대기를 알아내는 길은 셋**: 화면의 선택 창 → 답이 빈 질문 파일 → 멈춘 세션의 말(훅, 없으면 화면). 훅은 빠르게 알려 주는 길일 뿐, 없어도 화면으로 같은 대기를 만든다(서버가 다시 떠도 같다). 프로젝트 파일(`.claude/settings*.json`)에는 아무것도 쓰지 않는다.
- **D-1114-02 볼트 격리는 AI-DLC 의 swarm 에 맡긴다**: Lite 가 작업 트리를 따로 만들지 않는다. 사람이 고른 말을 요청에 붙이고, 만들기·병합·보관은 엔진이 한다(D-1112-25 를 구체화). 한 유닛 범위는 기본으로 끈다.
- **D-1114-03 추정 없이 시작은 접수 권한자만**: 줄과의 부딪힘을 살피지 않으므로, 그 책임을 지는 사람만 건너뛸 수 있다.

## 5. 시나리오 — 시험 · 녹화 · 스펙 · 튜토리얼

등장인물은 30~32장과 같다(팀 리드 한지수, PO 오세린, 아키텍트 최민준, 개발 강다은, QA 윤서준). 실제 판 3: 「팀 공지 게시판」(classic, 저장소 `robo-dlc-demo/notice-board`).

- **S1 바로 시작** — 한지수가 작업 접수에 요청을 적고 범위 classic → 「추정 없이 바로 시작」 → 계획안 칸에 고른 범위와 「볼트마다 작업 트리」(켜짐) → 「이 계획으로 시작」 → 처음 여는 폴더라 「믿고 시작」 → 세션이 「유닛 병렬 구축으로 진행합니다」.
- **S2 대화로 물은 것** — 세션이 선택 창 없이 대화로 묻고 멈춘다(실제 판에서는 승인된 소스 커밋 요청 등) → 훅이 알리고 그 단계 역할에게 카드 → 결정 화면의 「대화로 물음」 칸에서 고르거나 적어 보냄 → 입력창에 그대로 들어가고 카드는 내려간다.
- **S3 작업 트리에서 나란히** — 묶음 계획 승인 뒤 유닛마다 작업 트리가 생기고 볼트가 동시에 돈다 → 볼트 보드에서 볼트마다 작업 트리 → 승인되면 「Bolt <유닛>」 커밋으로 합쳐진다.

시험: `server/test/aidlc-ask.test.js`(실제 판 2 의 말 9개 사례 + 녹화 화면), `aidlc-team.e2e.test.js`(훅 → 6초 안 카드 → 답), `aidlc-intake.e2e.test.js` S5, Playwright F-RD-14(훅 없이 화면으로) · F-RD-15.

## 6. 남은 공백

- 병렬 인텐트(한 저장소에서 세션 둘)는 하지 않았다 — §2 마지막 줄.
- 훅 주소는 세션을 띄운 서버의 포트에 묶인다. 서버를 다른 포트로 옮기면 그 세션의 설정 파일을 다시 쓰면 된다(실제 판 3 에서 그렇게 했다 — 다른 세션이 같은 포트를 잡음).
