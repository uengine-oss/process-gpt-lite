# 시험과 증거

모델은 부르지 않는다(실제 CLI 스모크만 빼고). 판정 모델이 필요한 곳(배운 것 후보)은 단위 시험에서 대역을 쓰고, 실제 BFF 시험에서는 모델 주소가 답하지 않아 「판정 못 함」 길을 탄다. 서버 시험은 로컬 DB 를 쓰고, 시험마다 자기 회사(`localagent-test` · `localagent-e2e` · `localagent-ui` · `localagent-mobile` · `localagent-collab` · `localagent-view` · `localagent-smoke` · 채팅의 에이전트 `chatagent-test` · `chatagent-e2e` · `chatagent-ui`)에 행을 두었다가 끝나면 지운다. 폴더는 임시 디렉터리에 만든다. BFF · Vite 는 시험이 빈 포트(8811– · 8831– · 8851– · 8871– · 8889– · 8891– / 5231– · 5271– · 5289– · 5291–)에 스스로 띄우고 끝나면 내린다(`PRO_BACKGROUND=0`, `PRO_ONTOLOGY_WORKER=0`).

CLI 는 가짜다.
- 터미널(주 길): `desktop/test/fixtures/fake-tui.js` — PTY 에서 raw 모드로 읽고 친 글을 보여 주며, 붙여 넣기 + Enter 를 메시지로 받는다. Claude Code 2.1.330 처럼 `--session-id` · `--resume` · `--settings` 의 훅(`SessionStart` · `UserPromptSubmit` · `Stop` · `StopFailure`)을 돌리고, 세션 기록을 `$CLAUDE_CONFIG_DIR/projects/<폴더>/<세션>.jsonl` 에 쓰며, 설정이 폴더를 신뢰하지 않으면 신뢰 질문을 띄운다. Codex 0.162.1 처럼 명령줄의 첫 메시지를 스스로 넣고 rollout(`session_meta` · `user_message` · 함수 호출 · `agent_message` · `task_complete`)을 쓴다. 일하는 중에 붙여 넣은 메시지는 지금 할 일 다음에 같은 턴에서 받는다. 「대화」 보기와 물음을 위해 실제 2.1.331 의 기록 모양대로 `THINK`(생각 블록) · `SAY`(말, markdown) · `EDIT <파일> :: <앞> => <뒤>`(Edit 과 `structuredPatch`) · `BASH <명령> :: <출력>` · `SKILL <이름>` · `ASK <명령>`(권한 확인 — `PermissionRequest` 훅, 실제와 같은 창, `1` · `2` 면 돌리고 `Esc` 면 거절하고 턴을 `Stop` 없이 멈춤) · `CHOOSE <물음> :: <가> | <나> [;; <물음2> :: …]`(AskUserQuestion — 물음마다 번호, 답은 `선택.md`)도 한다. 닫힐 때는 실제처럼 화면을 지우고 「Resume this session with …」를 남긴다.
- 헤드리스(예비 길): `desktop/test/fixtures/fake-cli.js` — `claude -p` stream-json · `codex exec --json` 의 인자 · stdin · 출력 그대로.
- 둘 다 프롬프트의 지시 줄 `WRITE` · `WRITE_OUT` · `READ` · `SLEEP` · `SKILLNOTE` · `MEMORY` · `FAIL` 만 하고, 처음에 자기 자리에서 본 스킬(`보이는 스킬: …`)을 말한다. `$FAKE_CLI_LOG` 에 받은 메시지(`received`)와 따로 친 글(`typed`)을 남긴다.
- 시험의 runner 는 CLI 의 설정 폴더를 임시로 준다(`CLAUDE_CONFIG_DIR` · `CODEX_HOME`) — runner 가 폴더 신뢰를 쓰는 곳이 사람의 `~/.claude.json` 이 되지 않게.

사람 이름은 모두 지어낸 것이다.

```bash
# 서버: 설정 · 기기 토큰 · 배정 · 기다림 · 입력 상태 · 링크 · 제안 → 입력(작업자만) · 제안의 종류 · 터미널 중계 · 스킬 고르기 · 배운 것(판정 대역)
cd server && node --test test/localAgents.test.js
# 이름에 맞는 조사 · 터미널의 색(대비)
cd server && node --test test/josa.test.js test/localTermTheme.test.js
# 데스크톱 runner: 터미널(가짜 대화형 CLI, node-pty) + 헤드리스(가짜 CLI) + git HTTP(토큰 필요), 스킬 놓기 · 배운 것 · 알림,
# 대화 항목(Claude jsonl · Codex rollout 고정 자료 test/fixtures/transcripts/) · 물음과 키 · 턴 뒤 기다리기(test/conversation.test.js)
cd desktop && npm install && npm test
# 실제 BFF + 두 사람의 runner(데스크톱 앱 코드, 터미널) + 참여자 · 바깥 사람 + 터미널 보는 사람(WebSocket)
cd server && node test/localAgents.e2e.mjs
# Playwright: Electron 앱 두 개 · 휴대폰 · 두 사람 협업(390px 휴대폰 + 1280px 데스크톱 브라우저)
cd e2e && npx playwright test --project=desktop tests/desktop/local-agents.spec.js
cd e2e && npx playwright test --project=feature tests/feature/local-agents-mobile.spec.js tests/feature/local-agents-collab.spec.js
# Playwright: 「대화」 · 「터미널」 두 보기, CLI 의 물음, 턴 뒤 기다리기 · 끝내기, 끝난 실행, 밝은 · 어두운 테마, 휴대폰의 폴더 변경안
cd e2e && npx playwright test --project=feature tests/feature/local-agents-view.spec.js
# 실제 CLI(사람의 구독을 씀 — 필요할 때만)
cd server && LA_SMOKE_GATEWAY=1 LA_SMOKE_ANTHROPIC_BASE_URL=… LA_SMOKE_ANTHROPIC_AUTH_TOKEN=… LA_SMOKE_ANTHROPIC_MODEL=… node test/localAgents.smoke.mjs tty   # 대화형 Claude Code 를 터미널로(게이트웨이 · 임시 설정 폴더)
cd server && node test/localAgents.smoke.mjs both    # 헤드리스 claude · codex 입력 한 번씩
cd server && node test/localAgents.smoke.mjs skill   # 헤드리스 Claude Code 가 서버의 회사 스킬을 씀
# 채팅에서 고르는 에이전트(설계 §12): 고르기 · 대화마다의 선택 · chat 일 · 같은 세션 · 턴의 답 · 권한(가짜 링크, DB 에 sql/055)
cd server && node --test test/chatAgents.test.js
# 데스크톱 runner 의 chat 일: 대화의 폴더 · 턴마다 커밋 · push · reply · 같은 PTY · --resume · 기록이 없으면 새 세션
cd desktop && node --test test/chat.test.js
# 실제 BFF + runner(가짜 대화형 CLI): 보내기 → 답 + 파일 카드 · 이어서 · 끝내기 뒤 resume · 다른 사람 · 꺼짐 · 다시 보내기 · 프로젝트 변형
# (서버의 에이전트 · completion · 맥락 라우터는 127.0.0.1:9 — 공용 서비스를 부르지 않음. @xterm/headless 가 server/node_modules 에 없으면 NODE_PATH 로)
cd server && CA_PORT=8892 node test/chatAgents.e2e.mjs
# Playwright: 입력창의 칩 · 꺼진 항목 · 키보드 · 태그 · 카드 · 답 · 파일 카드 · 이어서 · 대화마다 남음 · 다시 기본 · 꺼짐 · 390px · 어두운 테마
cd e2e && npx playwright test --project=feature tests/feature/chat-agent-picker.spec.js
```

## 두 사람 영상 다시 만들기 (A 의 데스크톱 runner + B 의 휴대폰 브라우저)

자동으로(가짜 CLI, 장면 그대로): `local-agents-collab.spec.js` 가 그 장면이다 — 윤태호의 PC(runner, 터미널 안의 Claude Code, 회사 스킬 「견적-규칙」)가 「견적서 작성」을 돌리고, 서하린이 390px 휴대폰에서 윤태호의 터미널을 그대로(읽기 전용) 보며 프롬프트 두 개를 제안 → 윤태호의 1280px 화면에서 그 터미널 아래 입력란 위에 칩으로 쌓임 → 윤태호가 하나 버리고 하나를 골라 고쳐 입력 → 두 사람의 터미널에 그 CLI 가 받아 쓰는 것이 보임 → 서하린의 화면 「윤태호가 고쳐서 입력함」 → 결과가 인스턴스 라인에 → 서하린의 다음 단계가 서하린의 PC 에서 그 결과로 시작 → 윤태호가 배운 것을 반영.

```bash
cd e2e && npx playwright test --project=feature tests/feature/local-agents-collab.spec.js --headed
# 사진: results/c01-phone-suggest.png · c01-desk-stacked.png · c01-desk-sent.png · c01-phone-used.png · c03-desk-knowhow.png
```

손으로(실제 Claude Code 로, 녹화용):
1. 스택 — `PRO_PORT=8891 PRO_BACKGROUND=0 PRO_ONTOLOGY_WORKER=0 node server/index.js`, `PRO_API_TARGET=http://127.0.0.1:8891 node node_modules/vite/bin/vite.js --port 5291 --host 0.0.0.0`(휴대폰이 같은 망에서 `http://<맥 IP>:5291` 로 열도록).
2. A 의 데스크톱 — `cd desktop && npm install && env -u ELECTRON_RUN_AS_NODE npm start` → 서버 `127.0.0.1:5291` → A 로 로그인 → 설정 › 계정 › 「내 컴퓨터의 에이전트 · 연결됨」. A 의 Claude Code 는 한 번은 그 사람 터미널에서 띄워 처음 설정을 끝내 둔다(안 그러면 처음 설정 창이 실행 카드의 터미널에 뜨고 A 가 거기서 답해야 한다).
3. 활동 — 지도의 일 패널 「에이전트」에서 「Claude Code — 담당자의 컴퓨터」(지도가 없으면 시험처럼 프로세스 정의 활동에 `skills` · 지시를 두고 `agent_orch = pgpt-pro-local` 단계를 A 에게).
4. 단계가 오면 A 의 데스크톱 창의 인스턴스 화면(`/routines/<인스턴스>`)에 실행 카드와 A 자신의 Claude Code 터미널(입력 가능)이 보인다.
5. B 의 휴대폰 — `http://<맥 IP>:5291/projects/p/<인스턴스>` 에 B 로 로그인 → 같은 터미널(읽기 전용) → 「프롬프트 제안하기」에 쓰고 보냄.
6. A 의 데스크톱에 알림 · 카드의 입력란 위에 B 의 칩 → 눌러 입력란에 넣고 고쳐서 보냄 → 두 화면의 터미널에 Claude Code 가 그 글을 받는 것 → B 의 휴대폰에 「A 가 고쳐서 입력함」.
7. 끝나면 카드의 「배운 것」에서 A(프로세스 담당자)가 「이 일에 반영」.

## 시나리오 ↔ 시험

| 스펙 시나리오 | 시험 |
|---|---|
| **두 보기** 기본 보기와 고른 보기 | `local-agents-view.spec.js` F-LV-01 · 02 |
| **두 보기** CLI 가 기록을 쓰는 대로 대화가 늘어난다 | F-LV-03 · 04 · `conversation.test.js` 「Claude Code 세션 jsonl → 대화 항목 …」 · 「Codex rollout → …」 · 「대화가 링크로 간다 …」 · `localAgents.test.js` 「대화 중계 …」 · 「터미널 · 대화를 보는 사람 …」 |
| **두 보기** 누구의 입력인지 대화에 남는다 | F-LV-05 · `conversation.test.js` 「대화가 링크로 간다 …」(`steerId` · `from` · `by`) |
| **두 보기** Lite 의 색으로 보는 터미널 | F-LV-09 · `server/test/localTermTheme.test.js` |
| **물음** 권한 확인 | F-LV-06(서하린 403 · CLI 기록 `answered: '1'`) · `conversation.test.js` 「CLI 가 허락을 물으면 …」 · 「CLI 가 묻는 것과 답하는 키 …」 · `localAgents.test.js` 「대화 중계 …」(작업자만 · 열린 것만) · 실측 `results/smoke.md` 끝 |
| **물음** 거절하면 턴이 멈추고 사람을 기다린다 | `conversation.test.js` 「CLI 가 허락을 물으면 …」(`Esc` · `turn interrupted` · 그 뒤 파일 없음) · 실측 `results/smoke.md` 끝 |
| **물음** 고르기 | `conversation.test.js` 「고르기 물음(AskUserQuestion) …」(한 물음 · 두 물음 + Enter) · 실측(한 물음 · 두 물음) `results/smoke.md` 끝 |
| **기다리기** 첫 초안 뒤에 기다린다 | F-LV-07 · `conversation.test.js` 「턴이 끝난 뒤 기다리기 …」(규칙) · 「턴이 끝나면 기다리고 …」 · `localAgents.test.js` 「턴 뒤 기다림(idle) …」 |
| **기다리기** 제안이 기다림을 다시 시작한다 | F-LV-07(`idle_until` 이 뒤로) · `conversation.test.js` 「턴이 끝나면 기다리고 …」 |
| **기다리기** 끝내기 | F-LV-07(서하린 403 · 윤태호 → 끝남) · `conversation.test.js` 「턴이 끝나면 기다리고 …」 |
| **결과** 끝난 실행의 마지막 화면과 대화 | F-LV-08(일의 `screen` 에 마지막 답, 「Resume this session」 없음 · 메모리에서 빠진 뒤 대화) · `localAgents.test.js` 「터미널 · 대화를 보는 사람 …」(`term-keep`) |
| **결과** 휴대폰에서 결과의 변경안을 본다 | F-LV-10 |
| **협업** 휴대폰으로 같은 터미널을 본다 | `local-agents-collab.spec.js` C-01(두 화면의 터미널 글이 같음, 휴대폰은 `data-owner=no` · 키 없음) · `localAgents.e2e.mjs` 2(보는 사람과 작업자가 받은 바이트 = 작업자 데스크톱 터미널의 바이트) · `terminal.test.js` 「…보내는 바이트는 터미널의 바이트 그대로」 |
| **협업** 제안이 입력란에 쌓인다 | C-01(칩 둘 · Home 알림 `local_suggestion`) · `localAgents.e2e.mjs` 2 · `runner.test.js` 「서버의 스킬 …」(제안 알림 `notice`) |
| **협업** CLI 를 가진 사람이 골라 고쳐 입력한다 | C-01(버리기 · 넣기 · 고치기 · 가짜 CLI 기록에 고친 글 · 휴대폰 「고쳐서 입력함」 · `local_suggestion_used`) · `localAgents.e2e.mjs` 2 · `terminal.test.js` 「입력은 터미널 주인만 …」 · `server/test/josa.test.js`(「윤태호가」) |
| **협업** 다른 사람은 입력하지 못한다 | C-01(보내기 없음 · `POST …/steer` 403 · 바깥 사람 제안 403) · `localAgents.e2e.mjs` 2(보는 사람의 터미널 입력은 버려짐 · 바깥 사람 표 403) · `localAgents.test.js` 「터미널 중계 …」 |
| **협업** 역할을 가진 사람의 결정도 제안으로 쌓인다 | `localAgents.test.js` 「제안의 종류 …」 |
| **협업** 결과가 다음 담당자에게 이어진다 | C-02 · `localAgents.e2e.mjs` 1–2 · `local-agents.spec.js` L-03 |
| **터미널** 내 터미널과 똑같이 | 실제 `results/smoke-tty-2026-11-24.json`(`SessionStart` → 붙여 넣기 → `UserPromptSubmit` → 입력 → `Stop`) · `terminal.test.js` 「Claude Code 터미널 …」 · L-02(Electron 앱 안의 node-pty, `terminal = true`) |
| **터미널** 터미널에 직접 친다 | `localAgents.e2e.mjs` 2(작업자가 친 `터미널.md` 가 결과에, 보는 사람의 `몰래.md` 는 없음) · `terminal.test.js` 「입력은 터미널 주인만 …」 |
| **터미널** 앱이 다시 켜지면 같은 세션을 이어서 | `terminal.test.js` 「앱이 실행 중에 다시 켜지면 …」(`--resume <같은 세션>`, 꺼지기 전 파일이 결과에) |
| **터미널** 터미널을 만들 수 없는 곳 | `runner.test.js`(헤드리스 전체) · `terminal.test.js` 「터미널 모듈 …」 · 실제 `results/smoke-claude-2026-11-24.json` · `smoke-codex-2026-11-24.json` |
| **스킬** 회사 스킬대로 만든다 | 실제 `results/smoke-tty-2026-11-24.json`(터미널) · `smoke-skill-2026-11-24.json`(헤드리스, `Skill` 도구) · C-01 · `localAgents.e2e.mjs` 2(`스킬: 견적-규칙`) |
| **스킬** 스킬은 늘 최신, 결과에는 들어가지 않는다 | `runner.test.js` 「서버의 스킬 …」 · 「Codex 에는 스킬을 .pgl-skills 에 …」 · `localAgents.test.js` 「스킬 고르기 …」(읽기 전용 토큰, 남의 비공개 스킬 제외) · C-01(결과에 `.claude` 없음) |
| **배운 것** 제안에서 온 입력이 활동의 노하우가 된다 | C-03(「서하린 제안 · 윤태호 입력」, 반영 → 정의에 출처) · `localAgents.e2e.mjs` 2(B 403, A 반영, Home 알림) · `localAgents.test.js` 「배운 것: …」 · `terminal.test.js`(입력의 `from` · `by`) |
| **배운 것** 이번 건에만 해당하는 말은 후보가 아니다 | `localAgents.test.js` 「배운 것: …」(판정 대역) |
| **배운 것** 에이전트가 고친 스킬은 스킬의 반영 요청으로 | `runner.test.js` 「서버의 스킬 …」(고친 SKILL.md 가 돌아옴) · `localAgents.test.js` 「배운 것: …」 · 「스킬 수정 후보 → 「스킬에 반영 요청」 …」 |
| 활동에 Claude Code 를 정한다 | `localAgents.test.js` 「일 정의(front matter)가 에이전트 설정을 지닌다」 · 「활동 설정: …」 (지도의 일 패널 화면은 Ontological 이 필요해 자동 시험 없음) |
| 아무 데스크톱도 알리지 않은 CLI | `localAgents.e2e.mjs` 2(catalog 대수) · `localAgents.test.js` 「연결: …」 — 화면의 잠금은 손으로 확인 |
| 로그인하면 저절로 잇는다 | `local-agents.spec.js` L-01(토큰이 페이지 저장소에 없음) |
| 연결을 끊는다 | `localAgents.e2e.mjs` 6 · `localAgents.test.js` 「기기 토큰 …」 · 「연결: … 끊은 토큰은 4401 …」 |
| 켜져 있으면 바로 | `local-agents.spec.js` L-02(알약, 터미널로 실행) · `localAgents.e2e.mjs` 1 · `localAgents.test.js` 「켜져 있으면 그 사람의 데스크톱으로 …」 |
| 기다리다가 켜지면 돈다 | `localAgents.e2e.mjs` 3 · `local-agents.spec.js` L-04 · `localAgents.test.js` 「꺼져 있고 「기다리기」면 대기 …」 |
| 서버에 맡긴다 | `localAgents.e2e.mjs` 4 · `localAgents.test.js` 「꺼져 있고 「서버에 맡기기」면 …」 |
| 기다릴 시간이 지났다 | `localAgents.test.js` 「기다리는 시간이 지나면 서버 에이전트로」 |
| 휴대폰에서 바로 서버에 맡긴다 | `local-agents-mobile.spec.js` M-03 · `localAgents.e2e.mjs` 4 · `localAgents.test.js` 「기다리는 실행의 카드 …」 |
| 두 사람이 이어서 한다 | `localAgents.e2e.mjs` 1–2 · `local-agents.spec.js` L-03 · C-02 · `runner.test.js` 「실행 직전에 다시 맞춘다」 · 「… 토큰은 .git/config 에도 로그에도 없다」 |
| Claude Code 를 멈추지 않고 조종한다 | `local-agents.spec.js` L-03(「Claude Code에 입력했어요」 · `live`) · `localAgents.e2e.mjs` 2 · `terminal.test.js` · 실제 `results/smoke-tty-2026-11-24.json` |
| Codex 도 같은 세션의 터미널에서 | `localAgents.e2e.mjs` 5(한 세션 · 멈추지 않음 · `live`) · `terminal.test.js` 「Codex 터미널 …」 |
| 반영하기 전에 끝났다 | `localAgents.test.js` 「조종의 상태: …」 |
| 휴대폰에서 보고 조종한다 | `local-agents-mobile.spec.js` M-01(터미널 줄이 늘어남, 입력 반영) |
| 참여자는 보기만, 바깥 사람은 막힌다 | M-02 · `localAgents.e2e.mjs` 2 · C-01 |
| Home 카드 | M-03 · `localAgents.e2e.mjs` 2(`/local-agents/active`) · C-03(배운 것 알림) |
| 단계가 아닌 개발 세션 | `terminal.test.js` 「단계가 아닌 세션(개발 저장소) …」 · `localAgents.test.js` 「터미널 중계 …」(훅 · 파일이 듣는 쪽에) |
| 지금 화면 | `localAgents.e2e.mjs` 2(`GET …/screen` — 작업자가 친 글의 메아리, 입력 · 버린 입력 수) · `localAgents.test.js` 「터미널 중계 …」 |
| 끊은 기기와 클러스터의 토큰은 공개 git 경로에서 막힌다 | `localAgents.e2e.mjs` 6(401 · 403 · 링크된 기기 200 · 끊은 뒤 403, runner 의 원격 주소가 `/api/local-git/`) · `localAgents.test.js` 「공개 git 경로 …」(gitAccess · 라우트) |
| 작업 폴더 자신의 AGENTS.md 는 그대로 | `runner.test.js` 「작업 폴더가 지닌 AGENTS.md · CLAUDE.md · .claude/ …」 |
| 거둔 일은 돌지 않는다 | `localAgents.test.js` 「받겠다는 말(accept)에 서버가 답한다 …」 · `runner.test.js` 「서버가 받았다고(accepted) 할 때까지 …」 |
| (검토 수정) 기기 설정을 바꿔도 실행 유지 · 다시 시도 · 관문 먼저 · 에이전트 되돌리기 · 활동 에이전트 제한 · 세션 지우기 · 보낸 스킬만 · 같은 폴더는 차례로 | `localAgents.test.js` 해당 시험들 · `runner.test.js` 「같은 폴더의 다음 일은 …」 |
| 로컬 실행을 끈다 | L-04 · `localAgents.test.js` 「로컬 실행을 끈 데스크톱에는 보내지 않는다」 · `runner.test.js` 「거절: …」 |
| 폴더 밖을 가리키는 일 | `runner.test.js` 「거절: … 폴더 밖 경로」 |

## 채팅에서 고르는 에이전트 — 시나리오 ↔ 시험

| 시나리오 | 시험 |
|---|---|
| PC 앱이 없으면 내 PC 항목은 꺼져 있다 | F-CA-01(까닭 · 내려받기 링크 · 꺼진 항목을 눌러도 「기본」) · `chatAgents.test.js` 「고르기에 보이는 것 …」 · `chatAgents.e2e.mjs` 2 |
| PC 를 이으면 켜진다 | F-CA-01(목록을 연 채 `local_presence` 로 켜짐, 「윤태호의 맥」) · `chatAgents.test.js` 「고르기에 보이는 것 …」(그 데스크톱이 알린 CLI 만 · 실행 끔 · 0.2.2 전 판) |
| 키보드로 고르고 보낸다 | F-CA-02(↓ · ↓ · Enter, 포커스는 칩, 태그 · 카드 · 답 · 파일 카드) · `chatAgents.e2e.mjs` 3(내 폴더 main 에 `회의록.md`, 서버 에이전트의 답 없음) · `chatAgents.test.js` 「메시지 → 보낸 사람 자신의 데스크톱에만 …」 · `desktop/test/chat.test.js` 「채팅 메시지 …」 |
| 이어서 보내면 같은 세션 | F-CA-03(카드 하나, 답 둘, CLI 세션 하나) · `chatAgents.e2e.mjs` 4 · `chatAgents.test.js` 「같은 대화 · 같은 에이전트 …」 · `chat.test.js` 「채팅 메시지 …」(같은 PTY) |
| 끝난 뒤의 메시지는 그 세션을 잇는다 | `chatAgents.e2e.mjs` 5(`claude --resume <같은 세션>`) · `chatAgents.test.js` 「같은 대화 · 같은 에이전트 …」(`resume`, 프롬프트의 요약, 닫히는 사이의 메시지는 다음 실행으로) · `chat.test.js` 「그 대화의 다음 실행 …」(기록이 있으면 잇고 없으면 새 세션) |
| 고른 것은 대화마다 남는다 | F-CA-04(새로 고침 · 다른 브라우저 · 프로젝트는 「기본」) · `chatAgents.e2e.mjs` 2(메인 채팅 · 맥락 대화 · 다른 사람) · `chatAgents.test.js` 「고른 것은 대화마다 …」 |
| 다시 기본 | F-CA-05(요청에 `agent` 없음, 실행 카드 없음, 서버 에이전트의 답 — 시험에서는 모델이 없어 그 실패 답) |
| PC 가 꺼지면 기본으로 다시 보낸다 | F-CA-06(칩의 꺼짐 표시 · 「PC 앱 연결이 끊겼어요」 · 다시 보내기의 요청 글 · 「기본 에이전트로 다시 보냈어요」 · 새 메시지는 「PC 앱이 켜지면 시작」) · `chatAgents.e2e.mjs` 7 · `chatAgents.test.js` 「누가: …」(다시 보내기 → 취소 · 데스크톱에 `cancel`) |
| 프로젝트 폴더 | `chatAgents.e2e.mjs` 8(변형 `var/p/…` 에 `설계.md`, main 에 없음, 파일 카드는 사본, 구성원 보기 200 · 입력 403, 실행자의 보내기 403 + 메시지 아래 까닭) · `chatAgents.test.js` 「누가: …」 |
| 다른 사람 | `chatAgents.e2e.mjs` 6(보기 · 입력 · 끝내기 · 다시 보내기 · 터미널 표 403, 대화 404, 그녀의 메시지는 그녀의 PC 를 기다림) · `chatAgents.test.js` 「메시지 → …」(남의 데스크톱으로 가지 않음) · 「누가: …」 |
| 휴대폰과 어두운 테마 | F-CA-07 · 08(390px 밝게 · 어둡게, 목록이 화면 안, 넘치지 않음 · 책상의 어두운 테마) |

## 결과 — 채팅에서 고르는 에이전트 (2026-11-24 밤, 이 맥, 가지 `feat/chat-agent-picker`, SQL 055 를 돌린 로컬 DB)

| 시험 | 결과 |
|---|---|
| `server/test/chatAgents.test.js` | 7/7 |
| `desktop/test/chat.test.js` | 3/3 |
| `server/test/chatAgents.e2e.mjs`(BFF 8892 · runner · 가짜 대화형 CLI) | 8/8 |
| `e2e/tests/feature/chat-agent-picker.spec.js` (F-CA-01–08) | 7/7 (두 번 돌려 두 번 다 통과) |
| 회귀 `server/test/localAgents.test.js` · `josa.test.js` · `localTermTheme.test.js` | 31/31 · 3/3 · 2/2 |
| 회귀 `server/test/localAgents.e2e.mjs` | 9/9 |
| 회귀 `desktop` `npm test` | 46 통과 · 4 건너뜀(Windows 전용) / 50 |
| 회귀 Playwright C · M · F-LV (`local-agents-collab` · `-mobile` · `-view`) | 3/3 · 3/3 · 8/8 |
| 회귀 Playwright L (`tests/desktop/local-agents.spec.js`, Electron — `env -u ELECTRON_RUN_AS_NODE`) | 4/4 |
| 회귀 채팅 · 입력창(이 가지의 BFF 8893 + Vite 5293 에 대고 `PGPT_URL`): `conversations` · `resilience` · `folder-open` · `message-sender` · `followups`, smoke `screens` | 25/25 · 15/15 |

시험 중에 고친 것: (1) 목록을 연 순간 서버에 다시 묻는 답이, 그 사이 고른 것을 「기본」으로 덮던 경합 — 고른 뒤에 온 답은 선택을 덮지 않게(`src/chatAgent.js`). (2) 목록 위에 머문 마우스가 Enter 로 고르는 항목을 바꾸던 것 — 포커스가 있는 항목을 고르게. (3) 휴대폰에서 칩이 입력창 안에 있어 글 칸이 좁아지고 목록이 화면 왼쪽 밖으로 나가던 것 — 칩을 입력창 위로, 목록은 화면 양옆 16px 안에.

사진(`results/chat-agent/`): `ca01-no-desktop.png`(PC 앱이 없음 — 꺼진 항목 · 까닭 · 내려받기) · `ca01-desktop-linked.png`(PC 가 이어진 뒤 — 「윤태호의 맥」) · `ca02-sent-answer-file.png`(태그 · 실행 카드 「터미널」 · 답 · 파일 카드 · 칩 「Claude Code · 내 PC」) · `ca03-follow-up.png`(이어서 보낸 메시지 — 카드 하나, 답 둘) · `ca06-picker-off.png`(PC 가 꺼짐 — 칩의 꺼짐 표시, 연결이 끊긴 카드의 「기본으로 다시 보내기」) · `ca06-offline-card.png`(다시 보낸 메시지와 「PC 앱이 켜지면 시작」 카드) · `ca07-phone-light.png` · `ca07-phone-dark.png`(390px — 입력창 위의 칩과 화면 안의 목록) · `ca08-desk-dark-card.png` · `ca08-desk-dark-menu.png`(어두운 테마) · `desktop-app-composer.png`(데스크톱 앱(Electron) 창의 입력창에도 칩 — L-02 회귀에서 찍힘)

## 결과 — 「대화」 · 「터미널」 두 보기, CLI 의 물음, 턴 뒤 기다리기 (2026-11-24 저녁, 이 맥, 가지 `fix/local-agents-polish`)

| 시험 | 결과 |
|---|---|
| `server/test/localAgents.test.js` | 31/31 (더한 것: 「대화 중계 …」 · 「터미널 · 대화를 보는 사람 …」 · 「턴 뒤 기다림(idle) …」) |
| `server/test/josa.test.js` · `server/test/localTermTheme.test.js` | 3/3 · 2/2 |
| `desktop` `npm test` | 43 통과 · 4 건너뜀(Windows 전용 — origin/main 에서도 같음) / 47 (더한 것: `conversation.test.js` 9) |
| `server/test/localAgents.e2e.mjs` | 9/9 |
| `e2e/tests/feature/local-agents-view.spec.js` | 8/8 (F-LV-01–10) |
| `e2e/tests/feature/local-agents-collab.spec.js` · `local-agents-mobile.spec.js` | 3/3 · 3/3 (휴대폰의 기본 보기가 「대화」가 되어, 터미널의 글을 보는 C-01 · M-01 · M-02 는 「터미널」을 누르게 고침) |
| `e2e/tests/desktop/local-agents.spec.js` | 4/4 |
| 실제 Claude Code 2.1.331 프로브(물음과 키) | `results/smoke.md` 끝 — 허락 `1` · 앞으로 묻지 않기 `2` · 거절 `Esc` · 한 물음 고르기의 번호 · 여러 물음의 번호들과 Enter. 화면의 「4. No」는 게이트웨이가 500 을 돌려 재지 못했다(쓰지 않음 — 거절은 `Esc`) |

시험 중에 본 것: 한 번은 M-02 의 실행이 끝나는 순간 「단계가 닫혀 로컬 실행을 멈췄어요」가 되어 끝 보고가 거절됐다 — 결과로 단계를 닫는 사이에 sweep 이 그 단계를 손으로 닫힌 것으로 본 경합(origin/main 에도 있던 것). `jobs.sweep` 이 결과를 받아들이는 중인 실행을 건드리지 않게 고치고 「턴 뒤 기다림(idle) …」 시험에 넣었다. 고친 뒤 C · M 6/6.

사진: `results/lv01-desk-term.png`(작업자의 책상 — 「터미널」, Lite 의 어두운 색) · `lv02-phone-chat.png`(서하린의 휴대폰 — 「대화」) · `lv04-phone-diff.png`(「고침 · 견적서.md」의 차이) · `lv05-desk-attribution.png`(「서하린 제안 · 윤태호 입력」) · `lv06-phone-ask-wait.png`(「윤태호님의 답을 기다려요」) · `lv06-desk-ask.png`(허락 · 앞으로 묻지 않기 · 거절) · `lv07-desk-idle.png`(「끝내기」 · 「2분 동안 새 입력이 없으면 저절로 끝나요」) · `lv07-phone-idle.png`(「윤태호님이 끝내기를 기다려요」) · `lv08-desk-ended-term.png`(끝난 실행의 마지막 턴 화면) · `lv08-phone-ended-chat.png`(끝난 실행의 대화) · `lv09-phone-light-term.png` · `lv09-phone-light-chat.png` · `lv09-phone-dark-term.png` · `lv09-phone-dark-chat.png` · `lv10-phone-variation.png` · `lv10-phone-variation-diff.png` · `lv10-phone-folder.png` · `lv10-phone-folders.png`(휴대폰의 폴더 화면)

## 결과 (2026-11-24, 이 맥)

| 시험 | 결과 |
|---|---|
| `server/test/localAgents.test.js` | 28/28 |
| `desktop` `npm test` (터미널 6 + runner 헤드리스 14 + 기존 10) | 30/30 |
| `server/test/localAgents.e2e.mjs` | 9/9 |
| `e2e/tests/desktop/local-agents.spec.js` | 4/4 |
| `e2e/tests/feature/local-agents-mobile.spec.js` | 3/3 |
| `e2e/tests/feature/local-agents-collab.spec.js` | 3/3 |
| 실제 스모크 | 대화형 Claude Code 를 터미널로 16.2초(입력 `live`, 회사 스킬 규칙대로), 헤드리스 Claude Code 13.2초(`live`) · Codex 24.6초(`resume`) · 회사 스킬 — `results/smoke.md` |
| 묶은 데스크톱 앱(mac arm64, `electron-builder --dir`) | node-pty 가 `app.asar.unpacked` 에(실행 권한 있는 `spawn-helper`), 묶인 앱의 Electron 에서 PTY 가 뜸 — 확인 뒤 지움 |

사진: `results/l01-settings-linked.png` · `l02-pill-running.png` · `l03-instance-steer.png` · `l03-instance-done.png` · `l04-settings-off.png` · `l04-instance-waiting.png` · `m01-phone-running.png` · `m01-phone-steered.png` · `m02-phone-viewer.png` · `m03-phone-home.png` · `m03-phone-waiting.png` · `c01-phone-suggest.png` · `c01-desk-stacked.png` · `c01-desk-sent.png` · `c01-phone-used.png` · `c03-desk-knowhow.png`
