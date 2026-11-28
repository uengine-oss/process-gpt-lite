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
| 에이전트가 말을 전한다 | 「말 전하기: 브라우저를 잡고 있지 않은 작업에는 아무것도 전하지 않는다」 |
| 다른 사람의 작업 | 「작업 찾기: 이 사람의 것만 …」 |
| 에이전트가 먼저 답을 끝냈다 · 사람이 그사이에 다른 말을 했다 | 「이어 하기: 턴이 끝난 뒤 끝난 작업은 한 번만 이어서 …」 |
| (도구 설명에 이 서버의 브라우저 스킬을 데이터로 제공한다) | 「도구 설명: …」 · 「시작 주소: …」 |
| (기본 도구 목록에 포함하고 허브에는 한 번만 묶는다) | `agentTools.test.js` 「내장 브라우저(pgpt-browser): …」 · 「이름은 한 목록 …」 · 「shape: …」 |

2026-11-28: agentBrowser 9개 · agentTools 18개가 통과했다.

## 통합 (실제 DB · 실제 로그인 토큰 · 실제 HTTP MCP · 실제 Chromium, 가짜 모델 · 가짜 deepagents 스트림)

```bash
cd server && node --test --test-concurrency=1 test/agentBrowser.integration.test.js
```

| 시험 | 본 것 |
|---|---|
| AB-I-01 | 사람의 턴 도중에 `browser_task` 호출(토큰 + `X-Conversation-Id`) → 해당 방에 카드가 나타나고 목표에 「읽기만」이 붙지 않는다. 계획 카드에는 「에이전트 · 브라우저」가 표시된다. 결과에는 요약 · 주소 · 페이지 글 · 받은 파일(채팅의 파일 카드와 같은 파일)이 포함된다. 작업이 끝난 뒤에도 방은 「일하는 중」이며, 답은 카드 뒤에 온다 |
| AB-I-02 | 다른 사람의 대화 id → 호출을 거절하고 어느 방에도 카드를 표시하지 않는다. 다른 사람의 작업 id로 기다리거나 말을 전하는 호출도 거절한다 |
| AB-I-03 | 턴이 끝난 뒤 같은 대화에서 호출 → 읽기만 한다(목표 끝에 「읽기만」이 붙는다) |
| AB-I-04 | `PRO_BROWSER_TOOL_MS=1500`에서 `running` + `task_id`를 반환한다. `browser_task_say` → 카드에 `steered.by = agent`가 기록된다. 턴이 먼저 끝나면 같은 대화에서 한 번 이어서 진행한다(메시지에 결과 · 받은 파일 포함, 사람 메시지에 `handback` · `composed` 표시) |

2026-11-28: 4개가 통과했다(약 13초).

## 화면 (Playwright, `e2e/tests/feature/agent-browser.spec.js`)

```bash
cd e2e && ~/.claude/tools/lite/reclock.sh run agent-browser -- npx playwright test --project=feature tests/feature/agent-browser.spec.js --workers=1
```

자기 스택(회사 `agentbrowser-ui`, BFF 9061 · Vite 5461 부터 빈 포트), 가짜 모델 · 판정(9066), 가짜 deepagents(9067 — 스트림 도중에 Lite 의 `/mcp/browser` 를 사람의 토큰과 `X-Conversation-Id` 로 부른다), 사이트는 `server/test/fixtures/studio.mjs`. 브라우저 작업은 그 BFF 의 진짜 Chromium 이 한다. `PRO_BROWSER_TOOL_MS=4000` 이라 첫 부름은 `running` 으로 돌아오고 에이전트는 `browser_task_wait` 로 결과를 받는다.

| 시험 | 스펙 시나리오 | 사진 |
|---|---|---|
| F-AB-01 | NotebookLM 같은 사이트에서 하는 작업 · 4분이 넘는 작업 | `results/f-ab-01-pc-working.png` · `results/f-ab-01-pc-answered.png` |
| F-AB-02 | 브라우저가 사람에게 묻는다 | `results/f-ab-02-pc-asking.png` · `results/f-ab-02-pc-answered.png` |
| F-AB-03 | 에이전트가 먼저 답을 끝냈다 | `results/f-ab-03-pc-handback.png` |
| F-AB-04 | 다른 사람의 대화 | `results/f-ab-04-pc-refused.png` |
| F-AB-05 | 휴대폰(390, 밝은 화면 · 어두운 화면) | `results/f-ab-05-phone-working-{light,dark}.png` · `results/f-ab-05-phone-answered-{light,dark}.png` |

2026-11-28: 6개가 통과했다(1.1분). 같은 잠금 안에서 plan-guard(F-PG 6) · work-folders(F-WF 7)도 함께 실행해 19개가 통과했다.

## 실제 deepagents로 확인 (2026-11-28, 사람이 직접 한 번 확인)

deepagents의 원격 기본 브랜치(origin/master 277a8c9)를 별도로 체크아웃해 9069에서 실행했다. 공통 MCP 목록에는 이 작업 트리의 BFF(9061)를 가리키는 `/mcp/browser` 한 줄만 넣었다(헤더 `Authorization: Bearer {{user_jwt}}` · `X-Conversation-Id: {{conversation_id}}`). 모델은 회사 게이트웨이를 사용했다. 회사 MCP 목록이 없는 시험 회사(`agentbrowser-rc`)에서 시험 사용자가 채팅에 「위키백과 한국어판 사이트의 검색창에 「경복궁」을 입력해 검색하고, 나온 문서의 첫 문단을 읽어서 세 줄 요약 보고서를 워드 문서로 만들어 줘. 위키백과 내용은 사이트에서 직접 확인해 줘.」라고 보냈다.

- deepagents는 `pgpt-browser`를 불러왔고(「MCP tools 로드 완료: ['pgpt-browser', …]」), 스스로 `browser_task`를 선택했다. BFF 기록: `[agent-browser] start attended via turn … host=ko.wikipedia.org`.
- 요청을 보낸 지 19초 만에 작업 카드가 나타났다. 당시 계획 카드도 표시되어 있었고, 처리 줄에는 「에이전트 · 브라우저」가 표시되었다(`results/real-deepagents-working.png`).
- 브라우저 작업은 46초(동작 5번) 만에 끝났다. 에이전트는 결과(첫 문단 원문)를 받아 남은 단계(세 줄 요약 · 워드 문서)를 이어서 진행했고, 150초에 답을 반환했다(`results/real-deepagents-answer.png`). 계획 지킴이는 턴을 멈추지 않았다.
- NotebookLM 자체는 서버 브라우저에 구글 로그인이 필요해 시험하지 않았다.
- 로컬 회사 `localhost` 의 회사 MCP 목록에는 `pgpt-browser` 가 이미 `localhost:8787` 을 가리키는 항목으로 있다. 같은 이름의 회사 항목은 공통 항목을 덮으므로(스펙 `agent-tools`) 그 회사에서는 개발 BFF 로 간다.
