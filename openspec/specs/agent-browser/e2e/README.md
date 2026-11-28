# 시험과 증거

## 단위 (브라우저와 모델 없이 실행하며, 데이터베이스가 있으면 해당 부분도 시험한다)

```bash
cd server && node --test --test-concurrency=1 test/agentBrowser.test.js test/agentTools.test.js
```

| 스펙 시나리오 | 시험 |
|---|---|
| 사람의 메시지에 답하는 턴 · 사람이 없는 실행 | 「사람이 있는 턴: …」 · 「사람이 있으면 그 사람의 작업으로(own · 사람 말 · 계획), 없으면 읽기만 …」 |
| 다른 사람의 대화 | 「대화 → 방: … 다른 사람의 대화는 거절 …」 · 「사람이 있으면 … 다른 사람의 대화는 시작조차 하지 않는다」 |
| 4분이 넘는 작업 · 브라우저가 사람에게 묻는다 | 「기다림: 끝나면 결과 …, 새 질문이면 바로 waiting_for_person, 아니면 시간이 되면 지금 모양」 |
| 파일만 보낸 메시지에 답하는 작업과 사람이 없는 실행은 저장된 로그인을 쓰지 않는다 | 「사람이 있는 턴: …」 · 「사람이 있으면 …」(글 없는 메시지 · `PRO_BROWSER_TOOL_LOGINS`) |
| 사람이 말하지 않은 지우기 · 자기 작업 공간에서 만들기 | 「바깥에 영향을 주는 동작: …」 · 「판정이 읽는 것: 동작 · 사이트 · 페이지 · 사람의 말뿐 …」 |
| 오래 걸리는 작업 도중에 멈추기 | 「멈추기: 그 턴에서 에이전트가 시작한 작업도 멈추고 …」 |
| 에이전트가 말을 전한다 | 「말 전하기: 이 대화에서 에이전트가 시작한 작업에만 …」 |
| (내부망 · 시작 주소 · 동시 작업 수) | 「에이전트가 시작한 작업은 … PC 의 내부망을 열지 않는다」 · 「시작 주소: …」 · 「동시에 진행되는 에이전트의 작업은 …」 |
| 다른 사람의 작업 | 「작업 찾기: 이 사람의 것만 … 카드에서 다시 만든 기록은 사람의 것으로 돌지 않는다」 |
| 에이전트가 먼저 답을 끝낸 경우 · 사람이 그사이에 다른 말을 한 경우 | 「이어 하기: 메시지에는 작업 id 와 상태만(사이트의 글 없음) …」 |
| (도구 설명에 이 서버의 브라우저 스킬을 데이터로 제공한다) | 「도구 설명: …」 · 「시작 주소: …」 |
| (기본 도구 목록에 포함하고 허브에는 한 번만 묶는다) | `agentTools.test.js` 「내장 브라우저(pgpt-browser): …」 · 「이름은 한 목록 …」 · 「shape: …」 |

2026-11-29(보안 검토 반영): agentBrowser 14개 · agentTools 18개가 통과했다.

## 통합 (실제 DB · 실제 로그인 토큰 · 실제 HTTP MCP · 실제 Chromium, 가짜 모델 · 가짜 deepagents 스트림)

```bash
cd server && node --test --test-concurrency=1 test/agentBrowser.integration.test.js
```

| 시험 | 본 것 |
|---|---|
| AB-I-01 | 사람의 턴 도중에 `browser_task` 호출(토큰 + `X-Conversation-Id`) → 해당 방에 카드가 나타나고 목표에 「읽기만」이 붙지 않는다. 계획 카드에는 「에이전트 · 브라우저」가 표시된다. 결과에는 요약 · 주소 · 페이지 글 · 받은 파일(채팅의 파일 카드와 같은 파일)이 포함된다. 작업이 끝난 뒤에도 방은 「일하는 중」이며, 답은 카드 뒤에 온다 |
| AB-I-02 | 다른 사람의 대화 id → 호출을 거절하고 어느 방에도 카드를 표시하지 않는다. 다른 사람의 작업 id로 기다리거나 말을 전하는 호출도 거절한다 |
| AB-I-03 | 턴이 끝난 뒤 같은 대화에서 호출하면 읽기만 한다(목표 끝에 「읽기만」 표시). 「생성」을 누르려 하면 누르지 않고 메모에 「읽기만 함」을 남긴다. 로그인 칸에 저장된 로그인을 입력하지 않고 메모에 「저장된 로그인을 쓰지 않음」을 남긴다 |
| AB-I-04 | `PRO_BROWSER_TOOL_MS=1500`에서 `running` + `task_id`를 반환한다. `browser_task_say`를 호출하면 카드에 `steered.by = agent`가 기록된다. 턴이 먼저 끝나면 같은 대화에서 한 번 이어서 진행한다. 메시지에는 작업 id와 상태만 있고 사이트의 글은 없으며, 결과(요약 · 받은 파일)는 `browser_task_wait`로 읽는다. 사람 메시지에 `handback` · `composed`를 표시한다 |
| AB-I-05 | 사람이 말하지 않은 「delete 삭제」는 해당 단추와 사이트를 적은 승인 카드에서 멈춘다(`need: approve`). 판정에서는 사람의 말을 읽고 에이전트가 쓴 목표는 읽지 않는다. 「취소」를 누르면 해당 단추를 누르지 않고 목록을 그대로 유지한다. 자기 작업 공간의 「생성」은 카드 없이 진행한다 |
| AB-I-06 | 멈추기를 누르면 해당 턴에서 에이전트가 시작한 작업 카드가 「에이전트의 답을 멈춰서 이 작업도 멈췄어요.」로 끝나며, 이어서 진행하지 않는다 |

2026-11-29(보안 검토 반영): 6개가 통과했다.

## 화면 (Playwright, `e2e/tests/feature/agent-browser.spec.js`)

```bash
cd e2e && npx playwright test --project=feature tests/feature/agent-browser.spec.js --workers=1   # 공용 녹화 잠금 안에서
```

자기 스택(회사 `agentbrowser-ui`, BFF 9061 · Vite 5461 부터 빈 포트), 가짜 모델 · 판정(9066), 가짜 deepagents(9067 — 스트림 도중에 Lite 의 `/mcp/browser` 를 사람의 토큰과 `X-Conversation-Id` 로 부른다), 사이트는 `server/test/fixtures/studio.mjs`. 브라우저 작업은 그 BFF 의 진짜 Chromium 이 한다. `PRO_BROWSER_TOOL_MS=4000` 이라 첫 부름은 `running` 으로 돌아오고 에이전트는 `browser_task_wait` 로 결과를 받는다.

| 시험 | 스펙 시나리오 | 사진 |
|---|---|---|
| F-AB-01 | NotebookLM 같은 사이트에서 하는 작업 · 4분이 넘는 작업 | `results/f-ab-01-pc-working.png` · `results/f-ab-01-pc-answered.png` |
| F-AB-02 | 브라우저가 사람에게 묻는다 | `results/f-ab-02-pc-asking.png` · `results/f-ab-02-pc-answered.png` |
| F-AB-03 | 에이전트가 먼저 답을 끝냈다 | `results/f-ab-03-pc-handback.png` |
| F-AB-04 | 다른 사람의 대화 | `results/f-ab-04-pc-refused.png` |
| F-AB-05 | 휴대폰(390, 밝은 화면 · 어두운 화면) | `results/f-ab-05-phone-working-{light,dark}.png` · `results/f-ab-05-phone-answered-{light,dark}.png` |
| F-AB-06 | 사람이 말하지 않은 지우기(PC · 휴대폰 390) | `results/f-ab-06-pc-approval.png` · `results/f-ab-06-phone-approval.png` |

2026-11-28: 6개가 통과했다(1.1분). 같은 잠금 안에서 plan-guard(F-PG 6) · work-folders(F-WF 7)도 함께 실행해 19개가 통과했다. 2026-11-29(보안 검토 반영): F-AB 8개가 통과했다(1.1분).

## 실제 deepagents로 확인 (2026-11-28, 사람이 직접 한 번 확인)

deepagents의 원격 기본 브랜치(origin/master 277a8c9)를 별도로 체크아웃해 9069에서 실행했다. 공통 MCP 목록에는 이 작업 트리의 BFF(9061)를 가리키는 `/mcp/browser` 한 줄만 넣었다(헤더 `Authorization: Bearer {{user_jwt}}` · `X-Conversation-Id: {{conversation_id}}`). 모델은 회사 게이트웨이를 사용했다. 회사 MCP 목록이 없는 시험 회사(`agentbrowser-rc`)에서 시험 사용자가 채팅에 「위키백과 한국어판 사이트의 검색창에 「경복궁」을 입력해 검색하고, 나온 문서의 첫 문단을 읽어서 세 줄 요약 보고서를 워드 문서로 만들어 줘. 위키백과 내용은 사이트에서 직접 확인해 줘.」라고 보냈다.

- deepagents는 `pgpt-browser`를 불러왔고(「MCP tools 로드 완료: ['pgpt-browser', …]」), 스스로 `browser_task`를 선택했다. BFF 기록: `[agent-browser] start attended via turn … host=ko.wikipedia.org`.
- 요청을 보낸 지 19초 만에 작업 카드가 나타났다. 당시 계획 카드도 표시되어 있었고, 처리 줄에는 「에이전트 · 브라우저」가 표시되었다(`results/real-deepagents-working.png`).
- 브라우저 작업은 46초(동작 5번) 만에 끝났다. 에이전트는 결과(첫 문단 원문)를 받아 남은 단계(세 줄 요약 · 워드 문서)를 이어서 진행했고, 150초에 답을 반환했다(`results/real-deepagents-answer.png`). 계획 지킴이는 턴을 멈추지 않았다.
- NotebookLM 자체는 서버 브라우저에 구글 로그인이 필요해 시험하지 않았다.
- 로컬 회사 `localhost` 의 회사 MCP 목록에는 `pgpt-browser` 가 이미 `localhost:8787` 을 가리키는 항목으로 있다. 같은 이름의 회사 항목은 공통 항목을 덮으므로(스펙 `agent-tools`) 그 회사에서는 개발 BFF 로 간다.
