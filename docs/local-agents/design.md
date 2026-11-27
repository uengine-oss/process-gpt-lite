# 내 컴퓨터의 CLI 에이전트로 프로세스 단계를 돌린다 — 설계 (1단계)

2026-11-24 · 가지 `feat/local-cli-agents` · 스펙 `openspec/specs/local-agents`

## 1. 왜

- Lite 데스크톱 앱(Electron)은 사람마다 **자기 컴퓨터의 CLI 에이전트**(Claude Code · Codex · OpenHands)를 필요할 때 부르려고 만든 것이다.
- 서버에서 Claude Code 를 돌리면 두 가지가 걸린다.
  - 여러 사람이 서버의 계정 하나를 같이 쓰게 된다(이용 조건 문제).
  - 부하가 서버에 쌓인다.
- 그래서 각자의 CLI 를 각자의 구독으로, 각자의 컴퓨터에서 그대로 쓴다.
- 회사 프로세스 지도의 활동마다 「이 일은 Claude Code 로」, 「저 일은 Codex 로」를 정한다. 나에게 배정된 단계가 오면 켜져 있는 내 데스크톱 앱이 그 CLI 로 단계를 돌리고, 결과(초안)가 나에게 온다.
- 데스크톱이 꺼져 있을 때는 활동마다 정한 대로 서버에 맡기거나, 켜질 때까지 기다린다. 앱이 켜지면 기다리던 일을 돌린다.
- 인스턴스의 작업 폴더는 git 저장소다.
  - 내 단계가 돌기 전에 내 컴퓨터의 폴더가 앞 사람의 결과를 받는다.
  - 내가 끝내면 그 결과가 서버로 올라가 다음 사람에게 이어진다.
- 실행 중에 사람이 방향을 바꿀 수 있어야 한다(조종, steering).
- 실행 중인 일은 다른 기기(휴대폰 웹 포함)에서도 보이고 조종할 수 있어야 한다(2026-11-24 추가 요구).
- **스펙의 핵심(같은 날 추가)**: 스킬 · 프로세스 지도가 공유돼 있으니 로컬 실행도 서버의 스킬을 쓰고, 로컬의 입력 등에서 생긴 노하우는 서버로 모이고, 인스턴스의 참여자는 다른 사람의 CLI 실행을 보고 프롬프트를 제안한다 — 사람과 기기를 넘나드는 협업.
- **입력은 CLI 를 가진 사람만(같은 날 사용자 규칙)**: 「타인이 의견을 넣을 수 있다(프롬프트). 해당 의견이 해당 ssh 터미널의 입력란에 추천으로 쌓인다. 그것을 입력버튼으로 실제 입력시키는 당사자는 해당 cli를 가진 사람만이 할 수 있다.」 — 앞서 만든 「조종 허용(나만 · 팀원 · 고칠 수 있는 사람)」과 「의견 → 조종」은 걷어 냈다.
- **실행은 터미널로(같은 날 사용자 결정)**: 「cliagent 실행은 기존에 만들어뒀던 ssh 터미널 기능을 이용한다. agent share 의 것. 그래야 해당 cli client 와 동일한 결과를 낼 수 있으므로」 — 단계를 사람 자신의 대화형 `claude` · `codex` 로 PTY 안에서 돌리고, 그 터미널을 모든 보는 사람에게 그대로 보인다. 헤드리스(`-p` · `exec`)는 PTY 를 만들 수 없을 때만 쓰는 예비 길이다.
- **보기 두 가지(같은 날 사용자 질문)**: 「ssh 터미널이지만, 보기 모드에 따라 원하는 경우는 우리 디자인에 맞춰서 스타일링이 가능할까?」 — 같은 세션을 실행 카드에서 「대화」(CLI 자신의 기록을 Lite 의 부품으로)와 「터미널」(Lite 의 색 · 글꼴 · 카드 틀로 입힌 그 화면)로 본다(5.11). 실행은 여전히 사람의 대화형 CLI 이고, 「대화」는 화면을 긁지 않고 CLI 의 세션 기록에서 만든다.

## 2. 참고한 구현

| 가져온 것 | 어디서 |
|---|---|
| CLI 찾기(로그인 셸 밖의 PATH 보강, `which`), Claude Code 기본 · Codex 선택 | Ontological Studio `src/main/services.js` (`augmentedPath`, `resolveAgent`) |
| `claude -p --output-format stream-json --verbose --session-id` 로 시작하고 `--resume` 으로 같은 세션을 잇기, `--setting-sources project --strict-mcp-config` 로 사람의 훅·MCP 를 빼기, 허용 도구 목록 | Ontological Studio `resources/code_app_turn.py` |
| 같은 세션을 이어서 사람이 조종하기(작업실의 Claude Code `--resume`) | Lite `server/lib/workroom.js` |
| 대상 폴더를 cwd 로 두고 `claude -p` + `--resume` 반복 | Robo Architect · AI-DLC 실측(메모 robo-aidlc-integration) |
| clone → `pgpt-agent/<run>` 가지 → 커밋 → push, 토큰은 `GIT_CONFIG_*` 환경변수의 요청 머리글로만(`.git/config` · 명령줄 · 로그에 남기지 않음) | cli-agent `core/worktree.py` (읽기만, 고치지 않음) |
| 폴더를 git smart HTTP 로 내주기, 폴더 하나 · `pgpt-agent/*` 만 쓰는 토큰 | Lite `server/lib/folders/gitHttp.js` |
| 인스턴스 라인 `inst/<id>`, 작업 폴더, 단계 결과 `산출물/NN_<단계>/` | Lite `server/lib/folders/line.js` · `server/lib/mailWork.js` |
| 단계 일꾼(`fetch_pending_task`), 실행 방식의 관문(`gateStep`), 결과 저장(`save_task_result` · 지도 엔진 `finishItem`) | Lite `server/lib/ontology/run.js` · `runmode.js` · `mapengine.js` |
| WebSocket 하나(JSON 메시지), 1회용 표 대신 토큰을 첫 메시지로 | Lite 작업실 터미널 · 회의 음성 링크(서버 `ws`) |
| 대화형 CLI 를 PTY 로 띄우기, 계정 바꾸기 명령 끄기(`DISABLE_LOGIN_COMMAND` · `DISABLE_LOGOUT_COMMAND`), 부모 Claude Code 의 표지 빼기, `--session-id` 로 기록을 찾고 `--resume` 으로 잇기, 세션마다의 `--settings` 파일 | agent-share `agent_share/pty_session.py` · `sessions.py`(읽기만 — 비공개 저장소라 파일을 옮기지 않았다) |
| Claude Code 의 세션 기록 jsonl(`<config>/projects/<폴더>/<세션>.jsonl`)과 Codex rollout(`<CODEX_HOME>/sessions/Y/M/D/rollout-*.jsonl`, `session_meta` 로 폴더 맞추기)을 오프셋으로 이어 읽기 | agent-share `transcript.py` · `codex_usage.py` |
| 터미널 프로토콜(input · resize 나감 / session · output · exit 들어옴, 붙을 때 지금까지의 화면을 다시 보냄), xterm.js, 휴대폰의 키 줄 | Lite `src/components/WorkroomTerminal.vue` · `server/lib/workroom.js`(agent-share 와 같은 프로토콜) |
| 휴대폰 손가락 관성 스크롤, 「/」 목록 항목을 탭해 고르기, Ctrl+C · Ctrl+D 두 번 막기 | agent-share `static/index.html` |
| Robo-DLC 의 훅 묶음(Stop · StopFailure · UserPromptSubmit · Notification 을 `--settings` 로) | Lite `origin/feat/mcp-apps` `server/lib/aidlc/hooks.js`(병합 전, 읽기만) |

agent-share 는 서버가 CLI 를 띄우는 구조다. 여기서는 그 방식(PTY · 세션 설정 · 기록 읽기 · 프로토콜)을 그대로 쓰되 PTY 는 **작업자의 데스크톱**에서 띄우고, 그 바이트를 데스크톱의 링크로 서버에 보내 서버가 보는 사람들에게 내준다(5.10). 링크는 Lite 가 이미 쓰는 WebSocket(`ws`)으로 했다.

## 3. 전체 그림

```
 회사 프로세스 지도(활동의 에이전트 설정)                    Lite 서버                                    각자의 데스크톱 앱(Electron main)
 agent: local:claude-code ──▶ 지도 엔진 · 스냅샷이        ┌─ 단계 일꾼(pgpt-pro-local) ─ 관문(gateStep)    ┌─ 링크(WebSocket, 나가는 연결만)
 when_offline: wait|server     todolist 행을               │   → 일(pro_local_jobs) 큐 · 배정            │   hello(기기 토큰) · 할 수 있는 CLI
 server_agent, wait_minutes    agent_orch=pgpt-pro-local  │   → 그 사람의 데스크톱에만 job 보냄 ─────────┼──▶ runner: 폴더 맞추기(git fetch)
                               로 만든다                   │   ← 진행 · 조종 반영 · done/failed ◀──────────┼─── CLI 실행(고정 명령) · 조종
                                                            ├─ git HTTP(/api/git/<폴더>.git, 폴더 토큰) ◀──┼─── push pgpt-agent/local-…
                                                            └─ 결과 → 인스턴스 라인 · 단계 끝/초안 · 카드      └─ 상태 표시(Dock · 화면의 알약)
 휴대폰 · 브라우저: 인스턴스 화면 · Home 카드 ◀── SSE(local_run) ── 카드를 볼 수 있는 모든 사람에게 실시간

 터미널(5.10):  데스크톱 runner ── PTY(사람의 claude · codex) ── 바이트 · 훅 · 지켜보는 파일 ──링크──▶ 서버 relay.js(화면 모델 · 되감기)
                보는 사람(웹 · 휴대폰 · 작업자 자신의 창) ◀── /api/local-agents/term (agent-share 프로토콜) ── 입력은 작업자 것만 ──▶ 링크 ──▶ PTY
```

## 4. 활동 설정 (어디에 두나)

활동의 설정은 지금처럼 **일 정의**(지도의 Task 노드 `definition_md`, SKILL.md 모양의 front matter)에 둔다. 새 테이블은 만들지 않는다.

```yaml
---
name: 견적서 작성
kind: task
runner: draft                 # agent: 끝까지(결과로 단계를 끝냄) · draft: 초안만(담당자가 확인하고 냄)
agent: "local:claude-code"    # local:claude-code · local:codex · local:openhands · (서버) deepagents · cliagents · 비우면 업무 에이전트
when_offline: wait            # server: 서버에 맡기기 · wait: 켜질 때까지 기다리기
server_agent: onto            # 맡길 서버 에이전트: onto(업무 에이전트) · deepagents · cliagents
wait_minutes: 120             # (wait 일 때) 이만큼 기다려도 안 켜지면 서버에 맡김. 비우면 계속 기다림
---
```

- 화면: 프로세스 지도 › 일 패널 › 「에이전트」(`OntoTaskAgent.vue`). 관리자가 바꾼다. `PUT /api/ontology/tasks/:key/agent`(`taskdef.setAgent` → `agents.agentPatch`)가 front matter 를 고친다.
- 활동의 에이전트로 고를 수 있는 것은 **업무 에이전트와 담당자 컴퓨터의 CLI** 다. deepagents · Claude Code(서버)는 활동의 에이전트로는 받지 않는다(400): 엔진(`contractOf` · `createItem`)은 활동의 `agent` 를 읽지 않고 에이전트 단계를 늘 업무 에이전트로 돌려 왔다(검토 지적 11-24). 그 둘은 데스크톱이 꺼져 있을 때 **맡길 서버 에이전트**로만 남겼다 — 그때는 단계의 `agent_orch` 를 그 값으로 바꿔 그 일꾼이 집게 한다(5.3). 이 맥에서는 그 일꾼들(공유 deepagents · cli-agent)을 띄울 수 없어 지도 엔진의 건이 그 일꾼으로 끝까지 가는지 확인하지 못했다.
- 로컬 CLI 를 고르면 사람의 단계는 「초안만」이 된다. 그 전의 것(사람의 일 · 초안 · 에이전트의 일)을 `runner_before_local` 에 두었다가, 업무 에이전트로 되돌리면 그대로 돌려놓는다(검토 지적 11-24 — 전에는 「초안만」이 남아 사람의 단계가 업무 에이전트의 초안 단계로 굳었다).
- 로컬 에이전트는 **어느 데스크톱이 그 CLI 가 있다고 알렸을 때만** 고를 수 있다(`GET /api/local-agents/catalog` 의 연결된 대수). 이미 골라 둔 것은 그대로 보인다.
- 로컬 에이전트를 고르면서 하는 사람이 `person` 이면 `draft`(초안만)로 둔다.
- 읽는 곳: `taskDefinition()` 이 `local: {agent, offline, serverAgent, waitMinutes}` 를 돌려준다(`lib/localAgents/agents.js settingsOf`). 이번에 front matter 의 `runner: draft` 도 읽게 했다(전에는 다듬기의 덮어쓰기에서만 읽었다).

엔진에 들어가는 곳:
- **지도에서 바로**(`mapengine.createItem`): 로컬이면 `agent_orch = pgpt-pro-local`, `agent_config.local = {...}`, 담당 사람(그 역할의 사람, 없으면 건의 주인)을 `user_id` 에 함께 넣는다.
- **프로세스 정의로**(스냅샷 `run.contractOf`): 로컬이면 활동의 `orchestration = pgpt-pro-local`, 사람의 레인에 두고(`업무 에이전트` 레인이 아님), 활동에 `localAgent` 를 붙인다. completion 엔진이 만든 행을 우리 일꾼이 집는다.
- `agent_orch` 는 text 열이어서 값을 더해도 DB 를 바꿀 일이 없다. 다른 서버의 일꾼(업무 에이전트 `pgpt-pro-onto`, deepagents, cli-agent)은 이 값을 집지 않는다.

## 5. 서버 (`server/lib/localAgents/`)

| 파일 | 하는 일 |
|---|---|
| `agents.js` | 활동 설정 읽기 · 쓰기, 담당자 찾기, 순수 함수(시험 쉬움) |
| `devices.js` | 기기 토큰 발급 · 확인 · 끊기(해시만 보관) |
| `hub.js` | 데스크톱 링크(WebSocket `/api/local-agents/link`), 접속 상태(메모리) |
| `jobs.js` | 일 큐와 배정, 데스크톱이 보낸 메시지, 조종 전달, 기다림 시간 지나면 서버로 |
| `steps.js` | 프로세스와 잇기: 단계 일꾼, 작업 폴더 · 프롬프트 준비, 결과 넣기, 서버에 맡기기, 카드 · 실시간 알림, 권한, 제안 · 입력 |
| `relay.js` | 중계되는 터미널: 세션(종류 · 대상), 화면 모델(@xterm/headless), 보는 사람의 WebSocket(`/api/local-agents/term`), 입력은 주인 것만, 훅 · 지켜보는 파일을 듣는 쪽에 |
| `knowhow.js` | 로컬 실행의 노하우 판정 · 후보 · 반영 |
| `chat.js` | 채팅에서 고른 내 PC 의 CLI(일의 종류 `chat`, §12): 고르기 목록 · 대화마다의 선택, 메시지 → 일 · 같은 세션에 이어서, 작업 폴더(프로젝트 변형 · 내 PC 에이전트 폴더), 턴마다의 답 · 파일 카드, 기본으로 다시 보내기 |
| `routes/localAgents.js` | 페이지용 HTTP |

### 5.1 기기 토큰과 링크
- 데스크톱 앱 안에서 로그인한 페이지가 `POST /api/local-agents/devices` 로 토큰(`pld1_` + 32바이트)을 받아, preload 다리(`pglDesktop.localRunner.pair`)로 main 에 넘긴다. **main 은 페이지의 쿠키나 localStorage 를 읽지 않는다.** main 은 토큰을 OS 키체인(safeStorage)으로 암호화해 `desktop-settings.json` 의 `runner[서버]` 에 둔다.
- 서버에는 토큰의 sha256 만 남긴다(`pro_local_devices.token_hash`). 토큰 하나 = 한 사람의 기기 하나. 한 사람당 활성 기기 10대까지(넘으면 오래된 것부터 끊음).
- 링크: main 이 `wss://<서버>/api/local-agents/link` 로 나가는 연결 하나를 연다. 내 컴퓨터에는 포트를 열지 않는다. 첫 메시지 `hello` 에 토큰을 싣는다(주소에 넣지 않아 프록시 로그에 남지 않음). 10초 안에 hello 가 없거나, 토큰이 없거나 끊겼으면 `4401` 로 닫는다. 같은 기기의 새 링크는 옛 링크를 `4409` 로 대신한다. 25초마다 ping.
- 끊기: 설정의 「연결 해제」(`DELETE /api/local-agents/devices/:id`)는 즉시 링크를 `4401` 로 닫고, 그 뒤로 토큰을 받지 않는다. 데스크톱은 4401 을 받으면 다시 붙지 않는다. 로그아웃하면 그 컴퓨터의 토큰을 끊고 잊는다. 이 컴퓨터를 스스로 끊은 사람은 다음 로그인 때 저절로 다시 잇지 않는다(설정에서 「연결하기」).
- `hello` 에는 기기 이름 · OS · 앱 버전, CLI 별 `{installed, version, loggedIn, runnable}`, 설정 `{enabled, ask}`, 지금 돌리고 있는 일 id 가 들어간다. 로그인 상태는 `claude auth status`(JSON 의 `loggedIn` 만), `codex login status` 로 본다. 계정 이름은 보내지 않는다.

### 5.2 큐와 배정 (`pro_local_jobs`, 단계 하나에 일 하나)
상태: `queued`(기다림) → `offered`(데스크톱에 보냄) → `running` → `done` / `failed`, 또는 `delegated`(서버에 맡김) / `cancelled`(단계가 닫힘).

- 단계 일꾼이 `fetch_pending_task('pgpt-pro-local')` 로 행을 집는다(업무 에이전트와 같은 방식, `PRO_BACKGROUND=0` 에서도 돎, `PRO_LOCAL_AGENT_WORKER=0` 이면 끔). 실행 방식의 관문(`gateStep`)이 기다리라면 기다린다.
- 일의 주인은 **단계의 담당 사람**이다: `user_id` 가운데 에이전트가 아닌 첫 사람(이메일은 그 사람으로), 없으면 건의 주인.
- 일은 **그 사람의 링크에만** 간다. CLI 가 있고, 로컬 실행이 켜져 있고, 자리가 있는(기본 동시 2개) 데스크톱 가운데 가장 최근에 붙은 것. 데스크톱이 보낸 메시지는 자기 사람 · 자기 기기에 준 일에 대해서만 받는다.
- 켜진 데스크톱이 없으면 활동 설정대로: `server` → 바로 서버 에이전트, `wait` → 기다림(「PC 앱이 켜지면 시작」). `wait_minutes` 가 지나면 서버로. 앱이 켜지면 오래된 것부터, 동시 한도 안에서 보낸다.
- 데스크톱이 「이번에는 하지 않기」를 누르거나 로컬 실행이 꺼져 있으면 서버로, 바쁘면 다시 큐로.
- 받지 않은 채 링크가 끊기면 다시 큐로. 받은 일은 링크가 끊겨도 그 데스크톱의 것으로 둔다(CLI 는 계속 돌 수 있음). 다시 붙을 때(hello) 그 일을 갖고 있다고 하지 않으면(앱을 다시 켬) 다시 보낸다. 링크가 그대로인 채 기기의 설정 · CLI 가 바뀌었다는 말(`caps`)에는 큐만 다시 돌리고 갖고 있는 일은 건드리지 않는다(검토 지적 11-24 — 「실행 전에 묻기」를 실행 중에 켜면 돌던 일을 다시 큐에 넣던 것). `caps` 에도 지금 돌리는 일 id 를 싣는다.
- **받기는 서버가 확인한다**: 데스크톱은 `accept` 를 보내고 서버의 `accepted` 를 받아야 폴더 · CLI 를 건드린다. 서버는 그 일이 아직 그 기기에 보낸 상태일 때만 `running` 으로 바꾸고 `accepted` 를, 아니면(그 사이 거둠 — 서버에 맡김, 다른 곳으로 다시 보냄) `cancel` 을 보낸다. 보낸 일을 거둘 때(서버에 맡김, 답 없는 제안을 다시 큐로)는 그 기기에 `cancel` 을 먼저 보낸다. 데스크톱은 60초(`PGL_RUNNER_ACCEPT_MS`) 안에 답이 없으면 놓고, 링크가 다시 이어지면 기다리던 `accept` 를 다시 보낸다. 그래서 링크가 깜박인 사이 서버와 데스크톱이 같은 단계를 함께 돌지 않는다(검토 지적 11-24).
- **「다시 시도」**: 일이 끝난 뒤(실패 · 취소 · 서버에 맡김 · 끝남) 그 단계가 다시 집히면 새 실행이다 — 지금의 활동 설정으로 다시 큐에 넣고 앞 실행의 세션 · 입력 · 줄은 잇지 않는다(검토 지적 11-24 — 서버에 맡겼던 단계를 다시 시도하면 아무것도 돌지 않고 단계가 잡힌 채 남던 것).
- **관문 먼저**: 단계를 집으면 관문(`gateStep`)을 먼저 지난다 — 활동의 로컬 설정이 그 사이 없어져 업무 에이전트로 돌릴 때도(검토 지적 11-24 — 그때는 관문 없이 돌아 「초안 먼저」 · 사람 기다림을 건너뛰던 것).
- 단계가 손으로 닫히거나 옮겨지면 일을 멈추라고 보낸다. 다만 결과를 받아들이는 중인 실행(일에 결과가 적혔고 아직 실행 중 — 그 단계는 그 결과로 닫히는 중)은 건드리지 않는다(2026-11-24 — 그 사이 sweep 이 「단계가 닫혀 로컬 실행을 멈췄어요」로 바꾸고 데스크톱의 끝 보고를 거절한 적이 있다, M-02).

### 5.3 서버에 맡기기
- `onto`(업무 에이전트): `run.runStep` 을 이 서버에서 돌린다(담당 사람을 넘김).
- `deepagents` · `cliagents`: 행의 `agent_orch` 를 바꾸고 `draft_status` 를 비워 그 일꾼이 집게 한다.
- 행의 `agent_config.local` 을 지우고 `local_delegated` 를 남긴다. 기다리는 일은 사람이 「기다리지 않고 … 맡기기」로 바로 맡길 수도 있다(`POST /api/local-agents/jobs/:id/delegate`).

### 5.4 데스크톱이 받는 것
```
{ id, todoId, instId, instName, activity, agent, label, mode, lang, prompt, outDir, resultFile, person:{id,name,email},
  git:{ path:'/api/local-git/<폴더>.git', url(PRO_GIT_PUBLIC_URL 이 있을 때), token(그 기기 · 그 일의 폴더 토큰, 24시간, pgpt-agent/local-<일>-* 만), line:'inst/<id>', base, branch:'pgpt-agent/local-<일>-<시각>', folder },
  skills:[…], resume?:{ sessionId } }
```
- `resume`: 이 일이 실행 중이었는데(세션 id · 시작 시각 · 실행 가지가 있음) 그 데스크톱이 사라졌다가 다시 붙어 다시 보내는 것 — 가지 이름은 그때의 것을 그대로 준다. 실패한 일을 「다시 시도」하면 세션을 비우고 처음부터.
- 작업 폴더: 인스턴스의 작업 폴더(메일로 시작했으면 그것, 없으면 지금 만든다 — 주인은 건의 주인, 없으면 담당자). 끝난 단계의 결과를 먼저 라인에 적는다(`stepContext`).
- 산출 폴더: 라인의 `산출물/NN_<단계>/`(다음 번호).
- 프롬프트: 스킬 프롬프트 `skills/process-discovery/prompts/local-step.md`(일 정의 · 점검 항목 · 작업 폴더의 메일과 앞 결과 · 결과를 둘 곳 · git 을 쓰지 말 것 · 초안이면 그 뜻). 영어 모드면 영어 지시를 붙인다.

### 5.5 결과
- 데스크톱이 `done` 을 보내면 올라온 가지가 **그 일의 가지**(`pgpt-agent/local-<일>-…`)인지, 폴더에 있는지 보고, 그 가지를 폴더의 변형(`run`, 반영 대기)으로 만들고 인스턴스 라인에 넣는다(`line.advanceLine`: 앞으로 감기, 그 사이 라인이 움직였으면 merge).
- 단계 결과는 업무 에이전트와 같은 길로 넣는다(`run.finishStep`으로 뽑아 둠): 되돌릴 수 없는 단계면 초안으로 두고 사람을 기다림, 지도의 건이면 `finishItem`, 아니면 `save_task_result`. `mode=draft` 면 담당자의 초안으로 남는다.
- 값: `{result: 요약, agent, branch, files, folder_variation}`.
- 메일 작업 폴더의 「끝난 단계 기록」은 이 단계를 건너뛴다(데스크톱이 이미 `결과.md` 를 산출 폴더에 씀).

### 5.6 보기와 조종 (다른 기기 · 휴대폰 포함)
- **볼 수 있는 사람**: 인스턴스를 볼 수 있는 사람(`canSeeInstance`: 참여자, 단계의 사람, 관리자). `GET /api/local-agents/instances/:id` · `GET /api/local-agents/jobs/:id` 는 그 밖의 사람에게 `403`.
- **입력하는 사람**: 작업자(그 CLI 를 가진 사람)만(5.7). **서버에 맡기기**: 작업자와 건의 주인 · 작업 폴더 편집자. 그 밖의 참여자는 보고 제안만 한다(입력 · 맡기기는 `403`).
- **실시간**: 일의 상태가 바뀔 때, 진행이 올 때(약 0.8초마다 모아서), 조종이 오갈 때마다 서버가 카드를 그 인스턴스를 볼 수 있는 사람들(담당자 · 건의 주인 · 참여자 · 다른 단계의 사람)에게 앱의 SSE(`/api/events`, 이벤트 `local_run`)로 민다. 화면은 새로 읽지 않고 그 카드만 바꾼다.
- **카드**(`LocalRunCard.vue`, 인스턴스 화면 · 인스턴스 대화 · Home 카드): 누가 어느 컴퓨터에서(사람 · 기기 이름), 어느 단계, 상태(PC 앱이 켜지면 시작 · 보냄 · 실행 중 · 방향 전달 중 · 끝남 · 멈춤 · 서버에 맡김), 걸린 시간(1초마다), **그 CLI 의 터미널**(`LocalTerminal.vue`, 5.10 — 헤드리스 실행과 대화 속 작은 카드는 최근 도구 · 글 줄), 입력 목록과 그 상태, 제안 칩, 입력란(작업자) 또는 제안란(그 밖의 사람), 휴대폰 폭에서도 넘치지 않음, 기다리는 일의 「서버에 맡기기」.
- **입력의 길**: 작업자가 카드의 입력란에 쓴 글(직접, 또는 고른 제안 — `{text, suggestionId}`), 또는 인스턴스 대화에 쓴 글(`POST /api/threads/:id/messages` 가 실행 중인 로컬 일이 있고 쓴 사람이 작업자면 새 대화 턴 대신 입력으로) → `POST /api/local-agents/jobs/:id/steer` → 일에 저장(`steers`) → 그 데스크톱 링크로 `steer` → runner 가 터미널에 붙여 넣기 + Enter. 작업자는 터미널에 직접 칠 수도 있다(5.10).
- **입력의 상태**: `보내는 중`(데스크톱이 이어지면 보냄) → `데스크톱에 보냄` → `데스크톱이 받음`(runner 의 `steer-received`) → `반영`(runner 의 `steered`: 터미널에서는 늘 `live` — CLI 의 기록에 그 글이 들어감. 헤드리스에서는 `live` · `resume` · `restart` · `before-start`), 또는 `못 함 — 까닭`(runner 의 `steer-failed`: 결과를 올리는 중 · 이미 끝남, 또는 반영 전에 실행이 끝남 · 멈춤 · 서버에 맡겨짐).
- 대화방 규칙(2026-11-18)대로 메인 채팅에는 아무것도 더하지 않는다. 카드는 인스턴스의 대화(담당자 · 건의 주인)에만 하나씩 두고 고쳐 쓴다.

### 5.7 함께 일하기 — 보기 · 제안 · 입력은 CLI 를 가진 사람만 (스펙의 핵심)
- **보기**: 인스턴스를 볼 수 있는 사람 모두(5.6). 작업자의 터미널을 그대로(5.10), 작업자가 아니면 읽기 전용.
- **제안**: 그 사람들 누구나 실행에 프롬프트를 제안한다(`POST /api/local-agents/jobs/:id/suggestions {text, kind, option}`, 일의 `suggestions`). 종류는 `opinion`(의견, 기본)과 `decision`(역할을 가진 사람이 CLI 가 보인 선택지에서 고른 것 — `option` 에 고른 항목). 제안은 CLI 로 가지 않고 터미널 아래 입력란 위에 칩(누가 · 언제, 결정이면 「<이름> 결정 · <항목>」)으로 쌓인다. 작업자에게는 데스크톱 시스템 알림(runner 의 `notice`, main 의 알림)과 Home 카드(`notifications` type `local_suggestion`)가 간다.
- **입력은 작업자만**: 작업자가 칩을 누르면 입력란에 들어오고, 고쳐서 보내면(`POST …/steer {text, suggestionId}`) 터미널에 붙여 넣기 + Enter 로 들어간다. 입력에는 `from`(제안한 사람)이 남아 「<제안한 사람> 제안 · <작업자> 입력」으로 보이고, 제안은 `used`(`usedBy` · 고쳤으면 `edited` · `usedText`)가 되며, 제안한 사람에게 「제안이 입력됐어요」(`local_suggestion_used`)가 간다. 작업자는 제안을 버린다(`POST …/suggestions/:sid/dismiss`, `dismissed`). 이미 쓴 제안은 다시 쓸 수 없다(409).
- **403**: 작업자가 아닌 사람의 입력 · 제안 버리기, 인스턴스를 볼 수 없는 사람의 제안 · 보기 · 터미널 열기. 터미널에 보낸 작업자 아닌 사람의 입력은 서버가 버린다(5.10). 데스크톱도 그 사람 아닌 이름으로 온 터미널 입력을 받지 않는다.
- 결정(`decision`)이 누구의 것인지(역할을 가진 사람인지)는 이번 단계에서 가리지 않는다 — AI-DLC 를 데스크톱으로 옮기는 다음 단계가 역할자 화면에서 이 종류로 보낸다(10절).

### 5.8 로컬 실행도 서버의 스킬 · 프로세스 지도를
- 데스크톱이 받는 일에 `skills` 를 싣는다(`steps.skillsFor`): 활동의 일 정의가 지정한 스킬(`act.skills`) + 활동이 부르는 에이전트의 스킬(`agent_skills`) — 서버 에이전트가 그 활동에 받았을 것 — 과 담당자 자신의 비공개 스킬(`pro_skill_visibility`). 파일이 있는 스킬만(스킬 폴더, 없으면 설치본 · 비공개 사본에서 처음 만든다 — `folders/skills.js ensureSkillFolder`). 남의 비공개 스킬은 보내지 않는다.
- 각 스킬은 그 스킬 폴더의 git 주소와 **읽기만 하는 토큰**(`mintToken({push: ''})` — `gitHttp.refusals` 가 push 를 모두 거절, 그 기기 · 그 일의 것)으로 간다. 별도의 스킬 저장소를 만들지 않았다. 보낸 스킬 폴더는 일에 적어 둔다(`sent_skills`).
- 데스크톱(`runner/skills.js`)은 실행마다 스킬 폴더 main 을 캐시 clone(`<data>/local-agents/skills/`)으로 받아 CLI 가 스스로 읽는 자리에 둔다: Claude Code `.claude/skills/<이름>/`(허용 도구에 `Skill`), Codex `.pgl-skills/<이름>/` + `AGENTS.md`(스킬 목록과 「해당하면 그 SKILL.md 의 방법대로」). `.claude/` · `.pgl-skills/` · `CLAUDE.md` · `AGENTS.md` 는 작업 폴더의 `.git/info/exclude` 에 있어 일의 결과로 올라가지 않는다. 실행 전마다 앞 실행이 남긴 것만(추적하지 않는 파일, `git clean -X`) 지우고 다시 둔다.
- **작업 폴더 자신의 파일은 그대로**(검토 지적 11-24): 폴더가 추적하는 `AGENTS.md` · `CLAUDE.md` · `.claude/…`(예: `.claude/settings.json`, 폴더 자신의 스킬)는 지우지도 덮어쓰지도 않는다. 같은 자리에 폴더 자신의 스킬이 있으면 회사 스킬은 놓지 않고(진행 줄에 알림) 폴더의 것을 쓴다. Codex 인데 폴더가 `AGENTS.md` 를 지니면 스킬 안내는 그 파일 대신 프롬프트에 붙인다. CLI 가 폴더의 `CLAUDE.md` 에 더한 것은 일의 결과로 커밋되고, 배운 것(기억)으로는 더한 부분만 보낸다.
- 프롬프트(`local-step.md`)에 일 정의 · 점검 항목 · 내놓는 것(`act.outputs`) · 작업 폴더의 메일과 앞 결과 · 받은 스킬 이름이 들어간다(서버 단계와 같은 재료).
- 실측: 실제 Claude Code 2.1.330 이 `.claude/skills` 의 스킬을 불러 그 규칙대로 결과를 냈다 — 헤드리스(`--setting-sources project`, `Skill` 도구)와 터미널(대화형, 사람의 설정 그대로) 모두(`openspec/specs/local-agents/e2e/results/smoke.md`).

### 5.9 로컬 실행의 노하우 모으기 (`knowhow.js`)
- 데스크톱은 `done` 에 `knowhow` 를 싣는다: 조종(누가 · 반영 방식 · 그 뒤 실행이 한 도구 · 글 6줄), 에이전트가 쓴 `CLAUDE.md` · `AGENTS.md`(앱이 쓴 부분 빼고), 받은 스킬을 고친 파일.
- 서버는 조종 · 기억 하나하나를 판정(`decide.js oddsOf`, 스킬 프롬프트 `prompts/local-knowhow.md`, 보기 「앞으로 이 단계를 할 때마다 지킬 일의 방식」 · 「이번 건에만」)으로 읽어, `rule` 확률이 기준(`PRO_LOCAL_KNOWHOW_MIN`, 기본 0.5) 이상이면 후보로 둔다. 판정할 수 없으면(모델 없음) 「판정 못 함」으로 둔다. 정규식 · 낱말 규칙은 쓰지 않는다. 스킬 수정은 그대로 스킬 후보.
- 스킬 수정 후보는 **그 일에 보낸 스킬 폴더**(`sent_skills` — 폴더 id 와 이름이 같아야)에 대해서만 만든다. 데스크톱이 다른 폴더(남의 비공개 스킬 등)를 말하면 버리고, 「스킬에 반영 요청」 때도 다시 본다(403)(검토 지적 11-24).
- 후보는 일의 `knowhow` 에 둔다(새 테이블 없음). 실행 카드에 출처(「<사람>의 로컬 실행에서 배움 (<날짜>)」)와 함께 보이고, 건의 주인(없으면 작업자)과 프로세스 담당자(`proc_def.owner`)에게 Home 카드(`notifications` type `local_knowhow`, 인스턴스로 열림)가 간다.
- 반영(`POST …/knowhow/:kid {action}`): 활동의 노하우는 관리자나 프로세스 담당자만 — 회사 프로세스 지도의 건이면 그 일의 정의(`taskdef.saveDefinition`), 아니면 프로세스 정의의 활동 지시(`proc_def.definition.activities[].instruction`)의 「## 배운 것」에 「- <글> — <출처>」. 다음 실행은 그 정의를 읽는다(로컬 · 서버 모두). 스킬 수정은 작업자나 관리자가 「스킬에 반영 요청」 — 그 스킬 폴더의 변형(파일을 그대로 커밋)과 `requestMerge`(작성자 · 상사에게 알림, 기존 흐름). 버리기는 같은 사람들.
- 입력이 제안에서 왔으면 후보에 `suggestedBy`(제안한 사람)와 `by`(넣은 작업자)가 함께 남는다(「<제안한 사람> 제안 · <작업자> 입력」).
- 「습관」(followups.js)으로는 보내지 않았다: 그 길은 「결과물 뒤에 사람이 시키는 일」을 배우는 것이라, 실행 중 입력(일의 방식)과 뜻이 다르다(사용자 결정 항목).

### 5.10 터미널 중계 (`relay.js`)
- **세션**: 데스크톱이 연 CLI 세션 하나(runner 의 세션 id, CLI 자신의 세션 id, 종류 `kind` 와 대상 `ref`). 단계 실행은 종류 `step`(대상 = 그 일 id) 하나다. 종류마다 `registerKind(kind, {open(link, ref), view(user, ref), opened, exit, stored})` — 누가 그 세션을 열 수 있는지(데스크톱: `step` 은 그 일을 받은 바로 그 기기), 누가 볼 수 있는지(사람: `step` 은 그 인스턴스를 볼 수 있는 사람).
- **링크로 오는 것**(데스크톱 → 서버, hub 가 받아 relay 에): `term-open {sid, kind, ref, agent, cli, cols, rows, replay?}` · `pty {sid, data}`(40ms 마다 모음) · `term-session {sid, cli}` · `hook {sid, event, data}` · `files {sid, files:[{path, content|deleted}]}` · `tx {sid, items, replay?}`(대화 — 5.11, 120ms 마다 모음) · `term-keep {sid}`(지금 화면을 남길 화면으로 — 턴이 끝날 때 · CLI 를 닫기 직전) · `answer-failed {sid, ask, reason}` · `term-exit {sid, code}`. 다른 사람의 세션 · 다른 기기의 세션에 대한 것은 버린다.
- **보는 사람**: `POST /api/local-agents/jobs/:id/term` → 1회용 표(60초, 볼 수 있는 사람만, `owner` = 작업자인지) → `wss://…/api/local-agents/term?ticket=…&streams=term,tx`(같은 출처만 — 작업실 터미널과 같은 문지기). `streams` 는 받을 흐름(`term` 화면의 바이트 · `tx` 대화, 기본 `term`)이고, 붙은 뒤 `{type:'subscribe', streams, replay?}` 로 더 받는다(그 흐름을 처음부터 다시 보냄). 붙으면 `session {owner, live, cols, rows, agent, device}` 과 고른 흐름의 지금까지(`output replay` · `tx replay`), 그 뒤로 `output` · `tx` · `size` · `exit` · `detached` · `attached` · `answer-failed`. 서버에 이 세션이 없고(서버가 다시 켜짐 · 메모리에서 지움) 일에 마지막 화면 · 대화가 있으면 그것을 읽기 전용으로 보인다.
- **일찍 붙기(2026-11-24 제품 영상 녹화에서 — 카드가 뜬 뒤 3–4초 뒤에야 터미널이 붙었다)**: 실행 카드는 일이 보내지자마자 나오는데, 터미널은 데스크톱이 폴더를 맞추고 스킬을 받은 뒤 열린다. 카드는 그 데스크톱이 터미널로 돌린다고 알렸으면(링크의 `caps.terminal` — 카드의 `terminalSoon`) 바로 터미널 틀과 「터미널에 연결하는 중…」을 보이고 표를 받아 붙는다. 서버는 아직 세션이 없으면 종류의 `pending(ref)`(일이 보냄 · 실행 중이고 그 기기가 터미널로 돈다)를 보고 보는 사람을 붙잡아 두었다가(`waiting`, 10분까지) 세션이 열리는 순간 `session` 과 화면을 보낸다.
- **입력**: 보는 사람의 `input` · `resize` 는 작업자 것만 그 데스크톱 링크로(`pty-input {sid, data, byId}` · `pty-resize`). 다른 사람 것은 버리고 센다(`stats.dropped`). 화면 크기는 runner 가 정한 80×28 을 기본으로 둔다 — 보는 사람의 화면은 글자 크기를 줄여 맞추고, 넓으면 터미널 상자 안에서만 옆으로 움직인다(작업자의 크기 바꾸기는 프로토콜에 있으나 화면은 아직 보내지 않는다).
- **화면 모델**: 세션마다 `@xterm/headless` 에 바이트를 그대로 먹인다. `screenOf(S)` = 보이는 줄 · 커서 · 크기(「지금 화면에 무엇이 있는지」 — 선택 창을 알아보는 watcher 가 쓸 것), `GET /api/local-agents/jobs/:id/screen`. 되감기용 바이트는 400KB 까지.
- **훅 · 파일**: `events`(EventEmitter: `open` · `hook` · `files` · `exit`)로 서버 안의 듣는 쪽에 전한다. 훅 이벤트에는 사건 이름과 몇 가지 평문(`session_id` · `message` · `notification_type` · `source` · `error` · `last_assistant_message`)만 — 이 컴퓨터의 경로 · 도구 입력은 보내지 않는다. 지켜보는 파일은 세션을 열 때 정한 경로(예: `aidlc/`) 아래 256KB 이하 글만.
- **남기는 것**: 세션이 끝나면 `step` 은 마지막 화면 64KB 와 크기를 일에(`screen` · `screen_size`), 대화를 일에(`transcript` — 최근 것부터 512KB), 터미널이 있었음을(`terminal`) 남긴다. 링크가 끊기면 세션은 `detached` 로 남고, 다시 붙으면 데스크톱이 열린 세션을 지금까지의 화면 · 대화와 함께 다시 알린다(서버가 다시 켜졌을 때도 — 대화는 서버에 없는 항목만 받는다).
- **마지막 화면은 마지막 턴의 화면(2026-11-24 제품 영상 녹화에서)**: 전에는 CLI 가 끝날 때(`term-exit`)의 바이트 끝부분을 남겼는데, Claude Code 는 닫히면서 화면을 지우고 「Resume this session with …」만 남겨 끝난 카드의 터미널이 거의 비어 보였다. 이제 데스크톱이 턴이 끝날 때마다와 CLI 를 닫기 직전에 `term-keep` 을 보내고, 서버는 그때 화면 모델(@xterm/headless)의 마지막 300줄을 색 · 굵기 그대로 다시 그릴 수 있는 바이트로 떠 둔다(`relay.snapshot`). `term-exit` 에서는 그것을 되감기 · 일의 `screen` 으로 쓰고, 보고 있던 사람에게도 그 화면을 다시 보낸다(CLI 의 작별 화면 대신). 끝난 실행의 「대화」는 일의 `transcript` 에서 온다.
- **메모리에서 지우기**(검토 지적 11-24): CLI 가 끝난 세션은 `PRO_LOCAL_TERM_KEEP_MS`(기본 10분) 뒤, 데스크톱이 사라져 돌아오지 않는 세션은 `PRO_LOCAL_TERM_DETACH_MS`(기본 1시간) 뒤에 화면 모델을 닫고 지운다(보던 사람의 연결도 닫음). 그 뒤 보는 사람은 일에 남은 마지막 화면을 받는다.
- 서버 한 대 기준(메모리) — hub 의 접속 상태와 같은 가정.

### 5.11 「대화」와 「터미널」 — 같은 세션의 두 보기 (2026-11-24 사용자 질문)
- **무엇을 보이나**: 실행 카드에 「대화」 · 「터미널」 단추. 「대화」(`LocalConversation.vue`)는 그 세션의 대화를 Lite 의 부품으로, 「터미널」(`LocalTerminal.vue`)은 그 CLI 의 화면을 Lite 의 색으로. 입력란과 제안 칩은 두 보기가 함께 쓴다(카드의 것). 기본은 작업자가 아닌 사람과 휴대폰(760px 이하)은 「대화」, 데스크톱의 작업자는 「터미널」. 보는 사람이 고른 것은 그 브라우저에 남는다(`localStorage pgl.localRun.view`, 못 쓰면 기본). 연결은 카드에 하나(`src/localRelay.js`)이고, 보기가 보일 때 그 흐름을 받는다(`subscribe`).
- **어디서 오나 — 화면이 아니라 CLI 자신의 기록**: 데스크톱의 세션(`session.js`)이 이미 턴의 끝을 알려고 이어 읽던 기록을 항목으로 바꾼다(`transcript.js`). Claude Code 는 세션 jsonl(`<config>/projects/<폴더>/<세션>.jsonl`)의 `user` · `assistant`(글 · `thinking` · `tool_use`) · 도구 결과(`tool_result` + `toolUseResult` — 고친 곳의 `structuredPatch`, 명령의 `stdout`, 읽은 줄 수, 물음의 답) · 줄 서 있던 입력(`queued_command`) · 슬래시 명령. 기록 관리 항목(`mode` · `permission-mode` · `file-history-snapshot` · `api-request(-blob)` · 환경 · 스킬 목록 첨부 · `system`)과 하위 에이전트(`isSidechain`) · `isMeta` 는 뺀다. Codex 는 rollout 의 `event_msg`(`user_message` · `agent_message` · `agent_reasoning` · `turn_aborted`)와 `response_item`(`function_call` · `local_shell_call` · `custom_tool_call apply_patch` · 그 출력 — `exit_code`). `response_item` 의 `message` · `reasoning` 은 같은 말의 사본이라 뺀다. 턴의 시작 · 끝 · 멈춤과 물음은 훅에서(`turn` · `ask` · `ask-done`).
- **항목**(`{id, t, at, …}`): `user {text, first?, cmd?, steerId?, from?, by?}` · `text` · `thinking` · `tool {call, name, input:{path, command, description, skill, pattern, old, new, content, todos, questions…}}` · `result {call, ok, out?, patch?, answers?, kind?}` · `note {kind: interrupted | error | command}` · `turn {state: start | end | failed | interrupted}` · `ask` · `ask-done`. 작업 폴더 안의 경로는 그 폴더의 것으로(`산출물/…`), 긴 글은 자른다(글 12,000자 · 출력 4,000자 · 고친 앞뒤 8,000자 · 차이 400줄). **가리는 것은 없다** — 터미널이 보이는 것과 같은 노출이고, 같은 사람(터미널을 볼 수 있는 사람)만 본다.
- **누구의 말인지**: runner 가 터미널에 넣은 입력(작업자의 글, 고른 제안)이 CLI 의 기록에 나타나면 그 항목에 `steerId` · `from`(제안한 사람) · `by`(작업자)를 붙인다 → 「서하린 제안 · 윤태호 입력」. 단계의 첫 프롬프트는 `first`(「단계 프롬프트」, 접힘), 작업자가 터미널에 직접 친 것은 「윤태호 입력」.
- **서버**: `relay.js` 가 세션마다 항목을 바이트처럼 둔다 — 모양(아는 종류 · id) · 크기(한 항목 64KB) 검사, 한도(`PRO_LOCAL_TX_ITEMS` 2000개 · `PRO_LOCAL_TX_BYTES` 1.5MB, 오래된 것부터 버림), 메모리에서 지우는 때도 바이트와 같다(`keepMs` · `detachMs`). 끝나면 일의 `transcript` 에. `GET /api/local-agents/jobs/:id/transcript`(같은 권한).
- **보이는 모양**: 글은 markdown 을 안전하게(`src/safeMarkdown.js` — marked 뒤 허용한 요소 · 속성만, http(s) · mailto 링크만), 생각은 접힘, 도구는 한 줄씩 — 「파일 읽음 · 견적서.md」, 「만듦 · 견적서.md」, 「고침 · 견적서.md」(펼치면 차이 — CLI 의 `structuredPatch`, 없으면 고친 앞뒤), 「명령 실행」(펼치면 명령과 출력), 「스킬 사용 · 견적-규칙」, 「찾음 · …」, 「웹 읽음 · …」, 「할 일 정리」 … 결과가 오기 전에는 점이 깜박이고, 실패면 빨갛다. 턴이 도는 동안 「작업 중…」. 차이 · 출력은 그 상자 안에서만 옆으로 · 아래로 움직인다(휴대폰 390px 에서도 화면은 넘치지 않음).
- **CLI 가 묻는 것**(`prompts.js`, 실측 2026-11-24 — 이 맥의 Claude Code 2.1.331 을 PTY 에서 임시 설정 폴더 · 회사 모델 게이트웨이로): 허락 창은 `PermissionRequest` 훅(`tool_name` · `tool_input` · `permission_suggestions`, 2.0.45 이후 — 그 전 판에는 넣지 않고 `Notification` 의 `permission_prompt` 와 기록의 결과 없는 마지막 도구 호출로), 고르기 창은 `AskUserQuestion` 도구의 입력. 화면은 「❯ 1. Yes / 2. Yes, and don't ask again for: python3 * / 3. Yes, and switch to auto mode / 4. No · Esc to cancel · Tab to amend」, 고르기는 「1. Markdown / 2. Plain text / 3. Type something. / 4. Chat about this」. 키: 허락 `1` · 앞으로 묻지 않기 `2`(제안 규칙이 있을 때만) · 거절 `Esc`(그 도구를 거절하고 턴이 멈춘다 — `Stop` 훅 없이 「Interrupted · What should Claude do instead?」, 기록에 `[Request interrupted by user for tool use]`) · 고르기는 그 항목의 번호(한 물음은 바로 답이 됨 — 실측). 여러 물음을 한 번에 묻으면 물음이 탭(「← ☐ Currency ☐ VAT ✔ Submit →」)으로 보이고, 번호마다 그 물음에 답하고 다음으로 넘어간 뒤 「Review your answers ❯ 1. Submit answers 2. Cancel」에서 Enter 로 낸다 — 그래서 물음마다 번호, 끝에 Enter(실측: `2` · `1` · Enter → 「USD」 · 「Yes」). 자동 모드(3)는 내놓지 않는다(사람의 모드를 세션 끝까지 바꾸므로). Codex 의 승인 창은 rollout 에도 훅에도 남지 않아 카드로 만들지 않는다(작업자가 터미널에서 답함).
  - 카드: 작업자에게만 선택 단추, 다른 사람에게는 「윤태호님의 답을 기다려요」. 누르면 `POST /api/local-agents/jobs/:id/answer {ask, answer}`(작업자만 — 그 밖 403, 이미 닫힌 물음 409) → 서버가 그 세션의 데스크톱에 `pty-answer {sid, ask, answer, byId}` → runner 가 그 물음이 아직 열려 있을 때만 키를 누른다(창이 닫힌 뒤 누른 키는 CLI 입력란에 글자로 들어가므로 — 실측). 물음은 결과가 오거나 턴이 끝나거나 멈추면 닫힌다(`ask-done`).
- **터미널의 모양**(`src/localTermTheme.js`): xterm.js 의 색을 `src/styles/base.css` 의 토큰에서 — 어두운 바탕(카드의 rgb 29 29 31, 글 --text-primary, 커서 --color-info)과 밝은 바탕(rgb 251 251 253, 글 rgb 29 29 31, 커서 #005AD7). ANSI 16색은 뜻을 지키며(빨강은 빨강) 토큰에 맞춘 것으로, 모두 바탕과 4.5:1 이상(시험). CLI 가 24비트 색으로 칠한 것은 xterm 의 `minimumContrastRatio` 4.5 가 끌어올린다. `<html data-theme>` 이 바뀌면 그 자리에서 바뀐다. 글꼴은 고정폭(SF Mono · Menlo · Consolas) 다음에 한글이 두 칸 폭인 D2Coding · Nanum Gothic Coding, 그다음 시스템 한글. 카드 틀(모서리 14px, hairline).

### 5.12 브라우저 작업도 내 PC 에서 (데스크톱 0.2.3, 2026-11-25)

같은 링크로 서버의 브라우저 에이전트가 그 사람 PC 의 브라우저(데스크톱 앱 안의 숨은 창, `desktop/src/browser/`)를 움직인다. 에이전트 루프는 서버에 그대로 두고 페이지를 움직이는 드라이버만 바꾼다(`server/lib/browserServer.js` · `browserRemote.js`, 링크 쪽 `localAgents/browserLink.js`). 어디서 도는지 · Electron 을 고른 까닭 · 링크의 동작 · 보관함 값을 PC 로 보내는 결정과 위험 · PC 가 꺼졌을 때는 별도 문서 `docs/local-agents/browser.md` 에 있다.

## 6. 데스크톱 (`desktop/src/runner/`)

| 파일 | 하는 일 |
|---|---|
| `clis.js` | CLI 찾기 · 버전 · 로그인, 고정 명령, 출력 읽기 |
| `git.js` | 작업 폴더 맞추기 · 가지 · 커밋 · push · 라인 따라가기 |
| `runner.js` | 일 하나를 처음부터 끝까지, 입력, 보고함(outbox), 중계되는 세션(`openSession` — 바이트 · 대화 · 남길 화면), 턴 뒤 기다리기 · 끝내기, CLI 의 물음에 답하기, 다시 켜졌을 때 이어서 |
| `session.js` | 대화형 CLI 세션 하나(PTY): 세션 설정 · 훅 파일, 첫 프롬프트 붙여 넣기, 기록(jsonl · rollout) 읽기 → 대화 항목, CLI 의 물음(열림 · 닫힘 · 답의 키), 지켜보는 경로, 폴더 신뢰 |
| `transcript.js` | CLI 의 기록 한 줄 → 대화 항목(Claude Code jsonl · Codex rollout, 순수 함수) |
| `prompts.js` | CLI 가 묻는 것(허락 · 고르기)과 그 답의 키(실측 2.1.331) |
| `settle.js` | 턴이 끝난 뒤 기다리기의 규칙(순수 함수) |
| `pty.js` | node-pty 불러오기(못 불러오면 헤드리스) |
| `link.js` | 서버 링크(다시 붙기 1초 → 30초) |
| `skills.js` | 서버의 스킬을 CLI 자리에 두기 · 바뀐 스킬과 기억 찾기 |
| `index.js` | 셋을 묶어 main 에 하나 |

### 6.1 폴더 맞추기 (sync)
- 위치: `<userData>/local-agents/work/<서버 해시>/<인스턴스>-<폴더>` (앱의 데이터 폴더 안, 인스턴스마다 하나).
- 주소: `git.url`, 없으면 데스크톱이 쓰는 서버 주소 + `git.path`. http(s) 만(`protocol.allow=never` + http · https 만 허용), 주소에 자격 증명이 있으면 거절, 가지 이름은 단순한 이름만.
- 토큰은 `GIT_CONFIG_COUNT/KEY/VALUE` 의 `http.extraHeader = Authorization: Bearer …` 로만. `.git/config` · 명령줄 · 로그 · 보고함 파일에 남기지 않는다(시험으로 확인).
- 순서: 받기(fetch 라인, 없으면 main) → 폴더를 깨끗이 하고 `pgpt-agent/local-…` 가지를 라인에서 만든다 → **CLI 를 띄우기 직전에 한 번 더 받는다**. 기다리는 동안(묻는 창, 큐, 다른 사람의 단계) 라인이 움직였으면 새 라인에서 다시 만든다.
- 끝나면 `산출 폴더/결과.md`(한 일 · 끝난 때 · 실행 중에 바꾼 방향 · 요약)를 쓰고 커밋(작성자 = 담당자)하고 가지를 올린다. 서버가 받았다고 하면(`finished`) 폴더를 새 라인으로 옮겨 둔다(다음 단계가 이 컴퓨터에서 바로 시작).
- 한 폴더에서는 한 번에 하나(같은 인스턴스의 나란한 두 단계는 차례로). 다음 일은 앞 일을 서버가 받아들이고(`finished`) 폴더가 라인을 따라간(`follow`) 뒤에 시작한다 — 늦어도 10분(검토 지적 11-24 — 앞 일의 `checkout --detach` 와 다음 일의 맞추기가 겹치던 것).

### 6.2 CLI 실행 — 사람 자신의 대화형 CLI 를 터미널에서 (주 길)
- **PTY**: node-pty 1.1.0(N-API 미리 빌드 — Node 와 Electron 에서 같은 바이너리, mac arm64/x64 · Windows x64/arm64(ConPTY)). `desktop/package.json` 의 의존성, 설치 뒤 `scripts/pty-helper.js` 가 mac 의 `spawn-helper` 에 실행 권한을 준다(1.1.0 이 빠뜨림 — 없으면 `posix_spawnp failed`). electron-builder 는 `asarUnpack: node_modules/node-pty/**`, `npmRebuild: false`(다시 빌드하지 않음). mac arm64 로 묶어 앱 안에서 뜨는 것을 확인했다.
- **Claude Code**: `claude --session-id <uuid>`(다시 켜졌을 때 `--resume <uuid>`) `--settings <세션 설정> --permission-mode acceptEdits`. 세션 설정(`<userData>/local-agents/sessions/<일>/settings.json`, 0600)에는 훅만: `SessionStart` · `UserPromptSubmit` · `Stop` · `StopFailure` · `Notification` 이 받은 JSON 을 그 세션의 `hooks.jsonl` 에 덧붙인다(네트워크 없음). 사람의 설정 · 로그인 · 훅 · MCP · 슬래시 명령은 그대로(설정 소스를 줄이지 않는다).
  - 첫 프롬프트: `SessionStart` 훅이 온 뒤(신뢰 창 · 처음 설정 창이 떠 있으면 오지 않는다 — 2026-11-24 실측) 붙여 넣기(`ESC[200~…ESC[201~`) 후 350ms 뒤 Enter.
  - 폴더 신뢰: 앱이 만든 작업 폴더(데이터 폴더 아래)만 Claude Code 의 설정(`$CLAUDE_CONFIG_DIR/.claude.json`, 없으면 `~/.claude.json`)의 `projects[<폴더 실제 경로>].hasTrustDialogAccepted = true` 로 둔다(그 CLI 가 안내하는 방법, 원자적으로 바꿔 쓰기). 다른 Claude Code 가 그 사이에 덮어쓰면 신뢰 창이 터미널에 뜨고 작업자가 답한다.
  - 턴의 끝: `Stop` 훅(마지막 답 `last_assistant_message`), 실패는 `StopFailure`. 진행 줄(도구 · 글)과 입력이 들어간 것은 세션 기록 jsonl(`<config>/projects/<폴더>/<세션>.jsonl`, 세션 id 로 찾음)을 오프셋으로 이어 읽어 안다.
- **Codex**: `codex [resume <thread>] -c projects."<폴더>".trust_level="trusted" -c check_for_update_on_startup=false -C <폴더> "<프롬프트 파일을 읽으라는 한 줄>"` — 신뢰와 업데이트 창 끄기는 그 세션의 명령줄 설정으로만(사람의 config.toml 은 쓰지 않음). 프롬프트는 작업 폴더의 `.pgl-run/prompt.md`(커밋하지 않음)에 두고 명령줄에는 그것을 가리키는 한 줄만(프로세스 목록에 프롬프트가 보이지 않게). Codex 가 그 첫 메시지를 스스로 넣는다. 세션 id · 진행 · 턴의 끝은 rollout(`session_meta` · `user_message` · 함수 호출 · `agent_message` · `task_complete`)으로.
- **단계의 끝**(결정 2026-11-24, §10-6): 턴이 끝나면 실행은 **기다린다** — 인스턴스의 사람들이 첫 결과를 보고 제안하고, 작업자가 입력할 시간. 기다리는 동안 작업자의 카드에는 「끝내기」와 「5분 동안 새 입력이 없으면 저절로 끝나요」, 다른 사람의 카드에는 「윤태호님이 끝내기를 기다려요 — 지금 제안하면 이어서 입력할 수 있어요」. 새 제안(누구든) · 작업자의 입력(카드 · 인스턴스 대화) · 작업자의 타자 · CLI 의 물음에 답하기 · 새 턴이 기다림을 처음부터 다시 시작한다. 기다림 동안 아무것도 없으면 끝(기본 5분 — 데스크톱 설정 「턴이 끝난 뒤 기다리기」 1 · 3 · 5 · 10 · 30 · 60분, 또는 `PGL_RUNNER_SETTLE_MS`), 작업자가 「끝내기」를 누르면 바로(CLI 가 일하는 중이면 그 턴이 끝난 뒤). 터미널에 넣었지만 아직 기록에 없는 입력은 끝을 붙잡는다(20초 한도). CLI 가 턴을 멈추면(Esc · 거절한 도구 — `Stop` 훅이 오지 않는다) 그것도 턴의 끝으로 보고 기다린다. 규칙은 `settle.js`(순수 함수, 시험). 데스크톱은 저절로 끝날 때를 서버에 알린다(`idle {jobId, until}`, 일의 `idle_until`) — 카드가 그것을 보인다. 「끝내기」는 `POST /api/local-agents/jobs/:id/finish`(작업자만, 그 밖 403) → 데스크톱 링크로 `finish`. 끝나면 CLI 를 닫고 결과를 쓴다. 한 번에 60분까지. (`PGL_RUNNER_IDLE_FINISH_MS` 는 없앴다 — 친 글도 입력이라 기다림을 다시 시작한다.)
  - 왜(사용자 요구, 2026-11-24): 「여러 사람이 참여하고 있는 인스턴스에 내가 하고 있는 cliclient 작업에 타인이 의견을 넣을 수 있다(프롬프트). 해당 의견이 해당 ssh 터미널의 입력란에 추천으로 쌓인다.」 — 턴이 끝나고 3초 뒤 끝내면 첫 초안을 본 참여자의 제안이 늘 늦었다(제품 영상 녹화에서 30초로 늘려야 했다).
- **환경**: 사람 자신의 것에서 부모 Claude Code 의 표지(`CLAUDE*`, 단 `CLAUDE_CONFIG_DIR` 은 둠), `GIT_CONFIG_*`, `ELECTRON_RUN_AS_NODE`, `PGL_*` 를 빼고 `TERM=xterm-256color` · `COLORTERM=truecolor` · `DISABLE_LOGIN_COMMAND=1` · `DISABLE_LOGOUT_COMMAND=1`(agent-share 처럼 — 여럿이 보는 화면에서 계정을 바꾸지 않게).
- **다시 켜졌을 때**: runner 는 세션 id 를 알면 `<userData>/local-agents/sessions/<일>.json`(0600: CLI 세션 · 폴더 · 시작 커밋 · 산출 폴더)에 적는다. 앱이 끝나면 CLI 를 멈추되 그 기록은 남긴다. 서버가 같은 일을 `resume` 과 함께 다시 보내면, 기록이 맞을 때 폴더를 되돌리지 않고 같은 세션을 이어(`--resume` · `codex resume`) 「이 앱이 다시 켜져서 같은 세션을 이어서 해요. 하던 일을 마저 끝내세요.」를 넣는다. 일이 끝나거나 취소되면 기록을 지운다.
- **사람을 기다릴 때**: `PermissionRequest` · `Notification` 훅(권한 확인 등)이 오면 진행 줄에 남기고 main 이 「「<단계>」 — 터미널에서 답을 기다려요」 알림을 띄운다. 작업자는 「대화」의 물음 카드(5.11)나 자기 창(또는 휴대폰)의 터미널에서 답한다.

### 6.2.1 헤드리스 (예비 길 — PTY 를 만들 수 없을 때, `mode: 'headless'` · `PGL_RUNNER_MODE=headless`)
- **Claude Code**: `claude -p --input-format stream-json --output-format stream-json --verbose --replay-user-messages --session-id <uuid> --permission-mode acceptEdits --allowed-tools Read,Write,Edit,MultiEdit,Glob,Grep,TodoWrite,Skill,Bash(ls:*),Bash(cat:*),Bash(head:*),Bash(wc:*),Bash(mkdir:*) --disallowed-tools Bash(git:*),Bash(curl:*),Bash(wget:*),Bash(rm -rf:*),WebFetch --setting-sources project --strict-mcp-config`. 입력은 stdin 의 user 메시지, `--replay-user-messages` 로 받아들인 것을 안다(멈추지 않음, `live`). 끝난 뒤 온 입력은 `--resume`(`resume`).
- **Codex**: `codex exec --json --skip-git-repo-check -s workspace-write -c approval_policy="never" -C <폴더> -`. 실행 중 입력은 SIGINT 로 멈추고 `codex exec resume <thread> -`(`resume`).
- 입력 글 앞에 「[사람이 실행 중에 방향을 바꿨어요 — 이름] 지금까지 한 일을 바탕으로, 이제부터 다음을 따르세요」를 붙인다(터미널에서는 사람이 친 그대로).
- **OpenHands**: 찾기만 한다. 이 맥에 없어 플래그를 확인하지 못했다 → 실행하지 않음(`runnable:false`).

### 6.3 입력 (터미널)
- 작업자의 입력(카드의 입력란 · 인스턴스 대화)은 서버의 `steer` 로 와서 터미널에 붙여 넣기 + Enter 로 들어간다. CLI 가 일하는 중이면 그 CLI 가 하는 대로(Claude Code 는 같은 턴에 받아들임 — 실측: 실행 중에 넣은 입력이 `UserPromptSubmit` 를 거쳐 같은 턴에서 반영, `Stop` 은 한 번), 끝난 뒤면 새 턴.
- CLI 가 아직 입력을 받을 수 없으면(첫 프롬프트 전) 첫 프롬프트 뒤에 차례로 넣는다. 반영은 그 글(앞 80자)이 CLI 의 기록(사람 메시지 · 대기 중이던 입력)에 나타날 때 `steered live`.
- 작업자가 터미널에 직접 치는 글은 서버의 `pty-input` 으로 와서 그대로 PTY 에(입력 기록은 CLI 자신의 기록).

### 6.4 안전
- 자기 링크로 온 일만, 자기 사람의 일만(서버도 막고, runner 도 `person.id` 를 본다), 서버가 확인한 일만(`accepted`), 자기 폴더(데이터 폴더 아래)에서만. 산출 폴더가 작업 폴더 밖(`..`, 절대 경로, `.git`)이면 거절.
- 설정 › 계정 › 「내 컴퓨터의 에이전트」: 「이 컴퓨터에서 단계 실행」(끄면 그 데스크톱으로 보내지 않음 — 활동 설정대로 서버 또는 기다림), 「실행 전에 묻기」(시스템 창: 이 컴퓨터에서 실행 / 이번에는 하지 않기).
- 로그에 토큰 없음(runner 는 받은 폴더 토큰을 로그에서 가린다).
- 끝난 보고(done/failed)는 서버가 받았다고 할 때까지 `<userData>/local-agents/outbox.json`(0600)에 두고 다시 붙을 때 다시 보낸다(토큰 없음).
- 앱을 끝내면 돌던 CLI 를 멈춘다(서버는 다시 붙을 때 그 일을 세션과 함께 다시 보내고, 데스크톱은 같은 세션을 잇는다 — 6.2).
- 터미널의 입력은 이 데스크톱의 사람 것만(서버가 막고, runner 도 `byId` 를 본다). 터미널 · 중계되는 훅 · 파일에는 토큰이 없다(폴더 토큰은 runner 의 git 호출에만, CLI 의 환경에서는 `GIT_CONFIG_*` 를 뺀다).
- 폴더 신뢰는 앱이 만든 작업 폴더(데이터 폴더 아래)에만 쓴다.

### 6.5 화면
- 데스크톱 앱: 실행 중이면 화면 오른쪽 아래 알약 「로컬 에이전트 실행 중 · Claude Code」, macOS Dock 배지 ●.
- 페이지 다리(`pglDesktop.localRunner`: status · mayPair · pair · forget · setPrefs · detect · onState). main 은 고른 서버의 페이지(main 창)에서 온 요청에만 답한다. 상태에 `terminal`(이 데스크톱이 터미널로 돌리는지).
- 작업자 자신의 터미널: 데스크톱 앱의 창도 Lite 페이지이므로 같은 실행 카드의 터미널(`LocalTerminal.vue`)이 서버를 거쳐 그 PTY 에 붙는다(작업자 = 입력 가능, 커서 · 휴대폰 키 줄). Ctrl+C · Ctrl+D 를 3초 안에 다시 누르면 두 번째는 보내지 않고 알린다(agent-share). 휴대폰에서는 손가락 관성 스크롤, 작업자의 Claude Code 「/」 목록 항목 탭.
- 설정 › 계정 › 「내 컴퓨터의 에이전트」의 「턴이 끝난 뒤 기다리기」(1 · 3 · 5 · 10 · 30 · 60분, 기본 5분 — `desktop-settings.json` 의 `runnerPrefs.finishMinutes`).

## 7. 시험

| 무엇 | 어디 | 결과(2026-11-24) |
|---|---|---|
| 활동 설정 · 기기 토큰 · 배정 · 기다림 · 시간 지남 · 남의 데스크톱 · 거절 · 입력 상태 · 손으로 맡기기 · 링크(WebSocket) · 제안 → 입력(작업자만, 403) · 제안의 종류(의견 · 결정) · 터미널 중계(자기 일만 열기, 같은 바이트, 주인 입력만, 화면 모델, 훅 · 파일, 다시 붙기) · 스킬 고르기 · 배운 것(판정 대역) (검토 수정 11-24: 기기 설정 바꿔도 실행 유지 · 다시 시도 · 관문 먼저 · 에이전트 되돌리기 · 활동 에이전트 제한 · 받기 확인과 거두기 · 세션 지우기 · 보낸 스킬만 · 공개 git 경로) | `server/test/localAgents.test.js` (가짜 링크) | 28/28 |
| runner 헤드리스(예비 길): 맞추기 → 실행 → 입력 → 커밋 → 올리기, 토큰이 남지 않음, 거절, 실패 보고, 스킬 놓기, 배운 것 · 서버 확인 전에는 아무것도 하지 않음 · 같은 폴더는 앞 일의 finished 뒤 · 폴더 자신의 AGENTS.md · CLAUDE.md · .claude/ 그대로 | `desktop/test/runner.test.js` (가짜 CLI · git HTTP) | 14/14 |
| runner 터미널(주 길): node-pty, `SessionStart` 뒤 붙여 넣기 · `Stop` 으로 끝 · 커밋, 중계 바이트 = 터미널 바이트, 주인의 타자만 CLI 에, 고친 제안 붙여 넣기, 앱 다시 켜기 → `--resume`, Codex(명령줄 첫 메시지 · rollout), 단계 아닌 세션의 훅 · 지켜보는 파일, 폴더 신뢰 | `desktop/test/terminal.test.js` (가짜 대화형 CLI `fake-tui.js`) | 6/6 (데스크톱 전체 30/30) |
| 실제 BFF + 두 사람의 runner(터미널): 공개 git 경로(`/api/local-git`)로 맞추기 · 올리기(토큰 없음 401 · 클러스터 토큰 403 · 끊은 기기 403), A → B 이어받기, 참여자의 제안 → 작업자만 입력(403), 터미널(보는 사람과 작업자가 작업자 데스크톱의 바이트 그대로 받음 · 보는 사람의 입력은 버림 · 작업자의 입력은 CLI 에 · 바깥 사람 403 · 지금 화면), 회사 스킬, 배운 것 반영(403 포함), 꺼져 있을 때 기다림 · 서버, Codex 입력(같은 세션), 기기 끊기 | `server/test/localAgents.e2e.mjs` | 9/9 |
| Electron 앱 두 개(Playwright `_electron`): 저절로 연결 · 알약 · 앱 안의 node-pty 로 터미널 실행 · B 가 자기 창의 터미널을 보며 입력 · 로컬 실행 끔 → 기다림 | `e2e/tests/desktop/local-agents.spec.js` | 4/4 |
| 휴대폰(390px) 브라우저에서 터미널 실시간 보기 · 입력 · 권한 · 「PC 앱이 켜지면 시작」 · 서버에 맡기기 · Home 카드 | `e2e/tests/feature/local-agents-mobile.spec.js` | 3/3 |
| 대화 · 터미널 두 보기(5.11): 기본 보기 · 고른 것 남기기 · 기록이 쓰이는 대로 늘어남 · 차이 · 「서하린 제안 · 윤태호 입력」 · CLI 의 물음(작업자만, PTY 에 1) · 턴 뒤 기다림 · 끝내기 · 끝난 실행의 마지막 화면과 대화 · 밝은/어두운 테마 · 휴대폰의 폴더 변경안 | `e2e/tests/feature/local-agents-view.spec.js` (F-LV-01–10) | 스펙 e2e/README 의 결과 |
| 대화 항목(Claude jsonl · Codex rollout 고정 자료) · CLI 의 물음과 키 · 기다리기 규칙 · runner 의 대화 중계 · 물음에 답 · 끝내기 | `desktop/test/conversation.test.js` | 스펙 e2e/README 의 결과 |
| 대화 중계의 모양 · 크기 · 한도 · 다시 붙기 · 물음(작업자만 · 열린 것만) · 보는 사람의 흐름 · 일찍 붙기 · 남길 화면 · 이름에 맞는 조사 | `server/test/localAgents.test.js` · `server/test/josa.test.js` | 스펙 e2e/README 의 결과 |
| 두 사람 협업: 휴대폰(390px) 서하린이 같은 터미널(읽기 전용)을 보며 제안 → 윤태호(1280px)가 고르고 고쳐 입력 → 그의 CLI 에 → 서하린의 화면 「고쳐서 입력함」 · 서하린의 입력 403 → 다음 담당자의 PC 가 이어받음 → 배운 것 반영 · 회사 스킬 | `e2e/tests/feature/local-agents-collab.spec.js` | 3/3 |
| 실제 대화형 Claude Code 를 터미널로: 회사 스킬 · 실행 중 입력 · 훅으로 끝 | `server/test/localAgents.smoke.mjs tty`(회사 모델 게이트웨이) | 끝남 16.2초, 입력 반영 `live` |
| 실제 `claude` · `codex` 헤드리스 한 번씩 + 입력 · 회사 스킬 | `server/test/localAgents.smoke.mjs both · skill` | 끝남, 입력 반영 |

## 8. 운영에 필요한 것
- **SQL**: `server/sql/052_local_agents.sql`(새 테이블 두 개 `pro_local_devices` · `pro_local_jobs` — 제안 · 배운 것 · 터미널의 마지막 화면 · 보낸 스킬 폴더 열 포함, RLS 켬, 여러 번 돌려도 됨). 운영 Supabase 에 한 번 돌려야 한다.
- **서버 의존성**: `@xterm/headless@5.5.0`(server/package.json · lock, 순수 JS). 없으면 화면 모델 없이 되감기 바이트로만 답한다.
- **git 주소를 데스크톱이 닿게 — 이 가지에 만든 가장 좁은 열림**: `/lite/api/git/` 는 그대로 막아 둔다(클러스터 안 Service 만, 결정 D-1124-04 · PR #23). 데스크톱 전용 경로 `/api/local-git/` 를 따로 연다.
  - BFF(`gitHttp.gitRoutes({device: true})`)는 그 경로에서 **그 기기 · 그 일의 토큰**(`scope: 'device'`, 24시간)만 받는다. 클러스터 안 일꾼의 폴더 토큰은 403, 토큰이 없으면 401 — 무엇을 열어 보기 전에.
  - 매 요청 `devices.gitAccess` 가 확인한다: 기기가 끊기지 않았고(끊으면 곧바로 403), 일이 그 기기의 것이며, 그 일의 작업 폴더(또는 그 일에 보낸 스킬 폴더 — 읽기만)인지.
  - push 는 그 일이 보냄 · 실행 중일 때만, 그 일의 가지(`pgpt-agent/local-<일>-*`)로만 된다(지우기 · 태그 · 다른 가지는 git 이 보기 전에 거절). 기기마다 분당 120 요청까지(넘으면 429).
  - 웹 nginx(`install/docker/nginx.conf` — 운영 lite-web 이미지도 같은 파일): `location /api/local-git/` 에 IP 마다 분당 60(+30) `limit_req`, 200MB, 요청 버퍼링 끔. `/api/git/` 404 는 그대로다. 문법은 `nginx:1.27-alpine` 의 `nginx -t` 로 확인했다.
  - 운영 게이트웨이가 `/lite/**` 를 lite-web 으로 넘기고 있으면 더 할 일은 없다. 따로 둔 공개 주소를 쓰려면 `PRO_GIT_PUBLIC_URL`.
- **WebSocket**: 웹 nginx 는 `location /api/` 에 `proxy_http_version 1.1` · `Upgrade` · `Connection $connection_upgrade` · 읽기 3600초를 두고 있어 `/api/local-agents/link`(데스크톱 — 25초마다 ping) · `/api/local-agents/term`(보는 사람)의 업그레이드를 그대로 넘긴다. 바꿀 것은 없다. 남은 것은 게이트웨이(Spring Cloud Gateway)가 `/lite/api/**` 업그레이드를 넘기는지다. 작업실 터미널(`/lite/api/workroom/term`)이 운영에서 쓰이고 있으니 같은 길이다 — 운영에서 한 번 확인한다(이 가지에서는 하지 않음). 데스크톱의 링크에는 Origin 이 없다(hub 는 Origin 을 보지 않고 첫 메시지의 기기 토큰으로 막는다). 보는 사람의 터미널은 같은 출처 검사(`companyAddress`)를 지난다.
- **서버 한 대 기준**: 접속 상태가 메모리에 있다. Lite 서버를 여러 대로 늘리면 링크와 일이 다른 서버에 있을 수 있다(작업실 터미널과 같은 가정).
- 환경변수(모두 선택): 서버 `PRO_GIT_PUBLIC_URL`, `PRO_LOCAL_AGENT_WORKER=0`(일꾼 끔), `PRO_LOCAL_AGENT_TICK_MS`(기본 3000), `PRO_LOCAL_KNOWHOW_MIN`(기본 0.5), `PRO_LOCAL_TERM_KEEP_MS`(기본 600000) · `PRO_LOCAL_TERM_DETACH_MS`(기본 3600000), `PRO_LOCAL_TX_ITEMS`(기본 2000) · `PRO_LOCAL_TX_BYTES`(기본 1572864). 데스크톱 `PGL_RUNNER_MODE=headless`(터미널 대신 헤드리스), `PGL_RUNNER_SETTLE_MS`(턴 뒤 기다리기 — 없으면 데스크톱 설정, 기본 5분), `PGL_RUNNER_ACCEPT_MS`(기본 60000).
- **SQL 다시 한 번**: `052_local_agents.sql` 에 열 두 개를 더했다(`transcript jsonb` — 끝난 실행의 대화, `idle_until timestamptz` — 턴 뒤 기다림). 여러 번 돌려도 되니 운영 Supabase 에 다시 돌린다.
- **데스크톱 0.2.1**: runner 가 바뀌었다(대화 중계 · 물음 · 기다리기 · 남길 화면). 0.2.0 데스크톱도 서버와 계속 맞물린다(「대화」 · 물음 카드 · 「끝내기」가 없고, 단계는 예전처럼 3초 뒤 끝난다).
- k8s: 위 nginx · 게이트웨이 경로 외에는 없다. 데스크톱 앱은 새 판을 다시 묶어 배포해야 한다(node-pty 가 들어감 — mac arm64 로 묶어 확인만, 배포는 하지 않음).

## 9. 남은 일 · 한계
- OpenHands 실행(플래그 실측 필요).
- 실제 대화형 Codex 실행(가짜로만 시험 — 헤드리스는 실측). Windows(ConPTY · Claude Code 의 훅을 도는 Git Bash) 실측.
- 사람의 Claude Code 가 처음 설정(테마)을 끝내지 않았으면 그 창이 터미널에 떠 첫 프롬프트가 기다린다(이 맥이 그렇다 — 실측은 게이트웨이와 따로 둔 설정 폴더로 했다). 앱이 「터미널에서 처음 설정을 끝내 주세요」를 알리지는 않는다.
- 작업자의 화면에서 터미널 크기를 바꾸는 것(프로토콜 · 서버 · runner 는 있고 화면이 보내지 않음). 보는 사람이 여럿일 때 누구의 크기를 따를지는 정하지 않았다.
- 회사 프로세스 지도의 「지도에서 바로」 건 화면(프로세스 지도의 건 보기)에는 로컬 실행 카드를 아직 붙이지 않았다(인스턴스 화면 · 대화 · Home 카드에는 있음).
- 서버가 여러 대일 때의 링크 공유.
- 게이트웨이의 접근 암호(basic auth)가 걸린 터널 주소에서는 Node 의 WebSocket 이 머리글을 못 실어 링크가 안 될 수 있다.
- 회사 사설 인증서(TLS 가로채기)를 쓰는 망에서 Electron main 의 Node TLS 가 그 인증서를 믿지 않을 수 있다.
- Process GPT 의 todolist 알림 트리거가 「끝까지」 로컬 단계도 담당자에게 「입력」 카드로 알린다(Home 카드에 로컬 실행 상태 줄을 붙여 뜻을 보완했다).

## 10. 사용자 결정이 필요한 것
1. git 공개 경로: 데스크톱 전용 `/lite/api/local-git/`(그 기기 · 그 일의 토큰만, 위 §8)를 이 가지에서 열었다. 이대로 운영에 낼지 — 노출 수준을 바꾸는 결정이다.
2. 작업 폴더가 담당자의 컴퓨터로 내려간다(메일 원문 포함). 메일 작업 폴더의 「메일 문장은 주인 몫」 원칙과 부딪힌다 — 로컬 단계에서는 허용할지, 메일 폴더는 빼고 내려보낼지.
3. 터미널 실행은 사람의 설정을 그대로 쓴다(그 사람의 훅 · MCP · 권한 · 플러그인이 돈다 — 「그 사람의 터미널과 같은 결과」). 헤드리스에서 쓰던 「설정 소스는 project 만 · 허용 도구 목록」은 예비 길에만 남았다. 터미널에도 도구를 좁힐지(`--disallowed-tools` 등).
4. 권한 모드 `acceptEdits`(작업 폴더의 파일 고치기는 묻지 않음, 셸 명령은 사람의 설정대로 묻거나 허용). 무인 단계에서 셸 명령을 물으면 작업자가 터미널에서 답해야 끝난다 — 더 열지(사람의 auto 모드) 닫을지.
5. 폴더 신뢰를 앱이 사람의 `~/.claude.json` 에 쓴다(앱이 만든 작업 폴더만). 쓰지 않고 작업자가 처음 한 번 터미널에서 답하게 할지.
6. ~~단계의 끝을 「턴이 끝나고 3초 동안 아무 일 없음」으로 본다. 끝까지 하는 단계에서 작업자가 더 대화하고 싶을 때 「끝내기」 단추를 두고 자동 끝을 끌지.~~ **정함(2026-11-24)**: 턴이 끝나면 기다리고(기본 5분, 데스크톱 설정 · `PGL_RUNNER_SETTLE_MS`), 새 제안 · 입력이 기다림을 다시 시작하며, 작업자는 「끝내기」로 바로 끝낸다(6.2). 까닭: 사용자의 협업 요구(「여러 사람이 참여하고 있는 인스턴스에 내가 하고 있는 cliclient 작업에 타인이 의견을 넣을 수 있다(프롬프트). 해당 의견이 해당 ssh 터미널의 입력란에 추천으로 쌓인다.」) — 3초로는 첫 초안을 본 참여자의 제안이 늘 늦었다(제품 영상 녹화에서 30초로 늘려야 했다).
7. 작업자의 타자도 서버를 거쳐 PTY 로 간다(어느 기기에서나 같은 길). 데스크톱 앱 창에서는 링크 없이 바로 PTY 에 붙게 할지(지연 · 서버가 꺼졌을 때).
8. 노하우의 「습관」 길: 실행 중 입력은 활동의 정의(「배운 것」)로만 보냈다. 사람마다의 습관(followups)으로도 보낼지.
9. 활동의 노하우를 반영할 사람: 관리자 · 프로세스 담당자(`proc_def.owner`). 지도의 일은 관리자만 고치는 지금 규칙과 같게 둘지, 건의 주인에게도 열지.
10. 판정 기준(`PRO_LOCAL_KNOWHOW_MIN` 0.5)과, 모델이 없을 때 「판정 못 함」으로 모두 올리는 것(지금) vs 올리지 않는 것.
11. 로그아웃하면 그 컴퓨터의 토큰을 끊는다. 로그아웃 뒤에도 그 사람의 일을 계속 받게 할지.
12. 결정(`decision`) 제안을 누가 보낼 수 있는지: 지금은 참여자 누구나(작업자만 넣음). AI-DLC 단계에서 역할자만으로 좁힐지.

## 11. AI-DLC 를 데스크톱으로 옮길 때 (다음 단계, 이번에는 만들지 않음)
Robo-DLC(`origin/feat/mcp-apps` 의 `server/lib/aidlc/*` — 서버 tmux 의 대화형 Claude Code, 화면 · 질문 파일 watcher, `--settings` 훅, 역할자 결정 화면, 헤드리스 intake, bolt worktree)를 개발 담당자의 데스크톱 runner 로 옮길 때 이번 구조에 꽂는 자리:
- (a) **일반 세션**: `runner.openSession({kind, ref, agent, cwd, resume, prompt, stateDir, watch})` — 단계에 묶이지 않은 PTY CLI 세션(세션 id · 이어서 하기). 단계 실행은 `kind: 'step'`, 채팅의 메시지는 `kind: 'chat'`(§12 — 서버가 데스크톱에 보내는 일의 종류도 처음으로 둘이 됐다). 다음 단계는 `kind: 'aidlc'`(ref = 저장소 · bolt)를 서버에 `registerKind` 하면 된다. 남은 일: 서버가 데스크톱에 「이 저장소에서 세션을 열어라」를 보내는 메시지(지금은 runner 가 단계 일로만 연다), 저장소 · worktree 를 데스크톱에서 고르는 화면.
- (b) **훅 중계**: CLI 의 훅은 세션 설정 파일에서 로컬 파일로만 쓰고, runner 가 자기 링크로 `hook` 을 보낸다(CLI 가 서버 주소를 부르지 않음). `relay.events.on('hook')` 로 받는다. 지금 훅은 SessionStart · UserPromptSubmit · Stop · StopFailure · Notification(hooks.js 와 같은 묶음).
- (c) **서버의 화면 모델**: `@xterm/headless` 에 중계 바이트를 먹이고 `relay.screenOf(S)`(+`flushed`)로 「지금 화면」 — tmux watcher 의 `capture-pane` 자리. 선택 창 알아보기(watch.js 의 판정)는 그 위에 다음 단계에서.
- (d) **폴더 지켜보기 중계**: 세션을 열 때 `watch: ['aidlc']` 처럼 경로를 주면 runner 가 그 아래 바뀐 파일(256KB 이하 글, 지움 포함)을 300ms 모아 `files` 로 보내고, `relay.filesOf(S)` · `events.on('files')` 로 읽는다.
- (e) **제안의 종류**: 제안에 `kind: 'opinion' | 'decision'` 과 `option`(고른 항목). 역할자의 결정은 작업자의 입력란에 「<이름> 결정 · <항목>」으로 쌓이고, 보내는 것은 작업자만. 남은 일: 역할자 판정(누가 결정할 수 있는지), 결정을 CLI 의 선택 창에 맞는 키(번호 · 화살표)로 바꾸는 것.

## 12. 채팅에서 고르는 에이전트 (2026-11-24, 가지 `feat/chat-agent-picker`)

사용자 요청: 「채팅 입력창 보낼때 기본, codex, claude code 등 cli 에이전트를 선택할 수 있는 옵션이 대화창에 있으면 좋겠음.」 — 11절이 남겨 둔 「일반 세션」을 단계가 아닌 종류로 처음 쓴다(`kind: 'chat'`).

### 12.1 고르기 (`src/components/ComposerAgent.vue` · `src/chatAgent.js`)
- 입력창의 보내기 옆 칩: 「기본」(서버의 업무 에이전트, `lib/agent.js` — 지금까지와 같음) · 「Claude Code · 내 PC」 · 「Codex · 내 PC」. 목록(`role=listbox`)은 칩에서 Enter · Space · ↑ · ↓ 로 열고, ↑ · ↓ · Home · End 로 움직여 Enter · Space 로 고르며, Esc · Tab 으로 닫는다. 고르는 것은 포커스가 있는 항목이다(목록 위에 머문 마우스가 Enter 의 대상을 바꾸지 않게).
- 무엇이 보이나(`GET /api/local-agents/chat?key=` → `chat.availability`): 켜진 데스크톱이 있으면 그 데스크톱들이 알린 CLI 만(설치됨). 실행할 수 없음 · 로컬 실행 끔 · 0.2.2 전 판(채팅을 받지 못함 — `caps.chat` 없음)이면 꺼진 채 까닭과 함께. 켜진 데스크톱이 없으면 이은 데스크톱들이 마지막에 알린 CLI(이은 적이 없으면 둘 다)를 「PC 앱이 꺼져 있어요」(이은 적 없음: 「PC 앱을 설치하고 로그인하면 쓸 수 있어요」)로 끄고, 아래에 데스크톱 앱 내려받기 링크(`https://www.uengine.org/contents/processgptlite.html#desktop`). 데스크톱이 이어지거나 끊기거나 caps 를 다시 알리면 서버가 그 사람에게 `local_presence` 를 보내 목록을 다시 읽는다(새로 고침 없음).
- 칩이 있는 곳: 메인 채팅, 그 안의 맥락 대화(`/chat/c/:cid`), 프로젝트. 새 프로젝트(아직 방 없음) · 루틴(인스턴스) · 새 패널 만들기 · 열린 앱 위의 입력창에는 없다. 휴대폰 폭(760px 이하)에서는 입력창 위 오른쪽 줄에 두고(입력창의 글 칸 폭을 지키려고), 목록은 화면 양옆 16px 안에 고정으로 편다.
- 고른 것을 어디에: 대화 열쇠(`<thread>` 또는 `<thread>:<conversation>`)마다 사람마다 서버에(`pro_chat_agents`, `PUT /api/local-agents/chat/choice` — 「기본」은 행을 지움) 그리고 그 브라우저에(`localStorage pgl.chatAgent` — 서버 답이 오기 전에 바로 보이게). 서버의 것이 이긴다. 다만 서버에 묻는 사이에 이 화면에서 고른 것은 그 답이 덮지 않는다.
- 보낼 때: 입력창이 보내기 직전에 그 대화의 에이전트를 스토어에 한 번 넘긴다(`app.nextAgent`) — `MainView.vue` 를 고치지 않으려고. 스토어의 `send` 가 그것을 받아 `POST /api/threads/:id/messages` 에 `agent` 를 싣는다. 칩이 꺼진 내 PC 를 가리켜도 그대로 보낸다(실행이 PC 앱을 기다리고 카드가 「기본으로 다시 보내기」를 내놓음). 목록에 아예 없는 CLI(켜진 데스크톱에 그 CLI 가 없음)면 「기본」으로. 입력창이 아닌 길(답 단추, 카탈로그, 패널 만들기)은 늘 「기본」이다.

### 12.2 보내기 (`server/lib/localAgents/chat.js`)
- `POST /api/threads/:id/messages {text, agent, conversation, files}` 에 `agent` 가 `claude-code` · `codex` 면 서버의 에이전트를 부르지 않고 `chat.send`: 메시지를 채팅에 먼저 남기고(`content.agent = {id, label, where: '내 PC'}`, 첨부는 사용자의 파일 메시지로), 그다음 —
  - 같은 대화 · 같은 에이전트의 실행이 **보냄 · 실행 중**이면 그 실행의 입력(`J.steer` — 작업자의 입력과 같은 길, 터미널에 붙여 넣기 + Enter). 새 실행을 만들지 않는다.
  - **기다림**(PC 앱이 꺼짐)이면 그 실행의 프롬프트 · 메시지 뒤에 붙는다.
  - 없으면 새 실행: `pro_local_jobs` 의 행 하나(`kind='chat'`, `todo_id='chat:<uuid>'` — 단계와 겹치지 않게, `thread_id`, `chat` jsonb). `offline='wait'`(서버에 저절로 맡기지 않음), `wait_minutes` 없음. 그 대화의 이 에이전트의 앞 실행에 CLI 세션이 있었으면 `chat.resumeOf` 에 둔다. 실행 카드를 메시지 바로 아래에 둔다(`local_run`, `message_ids`). 그다음 큐(`J.route`) — 단계와 같은 배정이다: **그 사람의 링크에만**, 그 CLI 가 있고 로컬 실행이 켜져 있고 채팅을 받는(`caps.chat`) 데스크톱으로.
  - 거절(프로젝트 폴더를 고칠 권한 없음 · 연결형 폴더 · sql/055 없음)은 메시지 아래 실패 답(「내 PC 에이전트로 보내지 못했어요 — …」, `localRefused`)과 스트림의 `error`.
- 프롬프트(스킬 프롬프트 `skills/process-discovery/prompts/local-chat.md`): 대화의 최근 말(10개, 한 말 500자 — 사람 · 기본 에이전트 · 그 CLI 의 이름으로), 작업 폴더 안내(무엇이 맞춰져 있는지, 폴더 밖에 쓰지 말 것, git 을 쓰지 말 것, 답은 채팅에 그대로 올라감), 그 사람의 메시지. 데스크톱에는 프롬프트와 **메시지만**(`message`)을 함께 보낸다 — 세션을 이을 수 있으면 메시지만 넣는다.
- `jobs.js` 는 종류마다 훅을 둔다(`setKindHooks('chat', …)` — prepare · complete · reply · note · cancelled, 맡기기 · 실패 · 배운 것은 하지 않음). 큐 · 배정 · 받기 확인 · 거두기 · sweep · 조종 · 제안은 단계와 같은 코드다. 데스크톱의 새 메시지 `reply` 는 `J.onMessage` 가 받아 종류의 `reply` 훅에 주고 `replied {turn}` 으로 답한다.

### 12.3 작업 폴더 (결정)
- **자기 폴더에서 일하는 프로젝트**(`pro_thread_folders.mode='project'`): 그 폴더의 **프로젝트 변형**(`threadFolders.ensureProjectVariation` — 서버 에이전트의 프로젝트 턴이 커밋하는 바로 그 가지 `var/p/<id>`)이 대화의 라인이다. 데스크톱은 그 가지에서 자기 실행 가지(`pgpt-agent/local-<일>-…`)를 만들고, 서버는 올라온 머리를 그 변형으로 가져온다(앞으로 감기, 아니면 merge — 그 변형이 서버 에이전트 턴 때문에 작업 트리에 열려 있으면 그 트리에서 merge, 그 밖에는 `line.advanceLine(…, {record: false})`). 원본(main)은 사람이 프로젝트 위의 「반영」으로 바꾼다. **편집자 이상**만 보낼 수 있다(실행자 · 보는 사람은 403). 연결형 폴더는 git 으로 내주지 않아 409.
- **그 밖의 대화**(메인 채팅, 그 안의 맥락 대화, 자기 폴더가 없는 프로젝트 — 참고로 붙인 폴더는 건드리지 않는다): 그 사람만의 폴더 「내 PC 에이전트 작업 · <이름>」(관리형, slug `mypc-<사람 8자>`, `settings.local_chat.owner`, 구성원은 그 사람 owner 하나)을 처음 보낼 때 만든다. 그 폴더의 **main** 이 라인이다. 올라온 머리는 폴더의 main 작업 트리로 `merge --ff-only`, 안 되면 merge(충돌이면 main 은 그대로, 결과는 실행 가지에 남음) — 그 전에 main 에서 사람이 고친 것을 먼저 커밋한다(폴더 화면의 「반영」 끝과 같은 순서). 그 뒤 색인을 다시 만든다.
- 왜: 결과가 서버의 폴더로 돌아와야(폴더 화면 · 파일 카드 · 산출물 스택 · 공유) 채팅이 서버 에이전트의 답과 같은 자리에 산출물을 둔다. 프로젝트는 이미 「프로젝트의 변형 + 반영」으로 일하므로 같은 길을 탄다. 메인 채팅에는 폴더가 없어서 사람마다 하나 만든다(남이 보지 않게 그 사람만). 대화마다 폴더를 따로 만들면 폴더 목록이 대화 수만큼 늘어 하나로 두었다 — 데스크톱의 작업 폴더(clone)는 대화마다 따로다(그 CLI 세션이 그 폴더에 산다).
- git 토큰: 단계와 같다 — 그 기기 · 그 일의 토큰(24시간, push 는 그 일의 가지에만), 매 요청 `devices.gitAccess`.

### 12.4 턴마다 (데스크톱 → 서버)
- 데스크톱(runner, 0.2.2): `kind:'chat'` 이면 대화마다 폴더(`<data>/local-agents/work/<서버>/chat-<대화 열쇠 sha1 16자>-<폴더 8자>`), 중계 세션의 종류 `chat`(대상 = 그 일). `.claude/` · `.codex/` · `.pgl-run/` · `.tmp/` 는 `.git/info/exclude` — CLI 가 폴더마다 두는 설정(신뢰 · 「앞으로 묻지 않기」)은 서버 폴더에 올라가지 않는다. 스킬 · 결과.md · 배운 것은 없다.
- CLI 의 턴이 끝나면(Claude Code `Stop` 훅 · Codex `task_complete`) 그 턴이 바꾼 것을 커밋 · push 하고 `reply {jobId, turn, text(마지막 말), branch, commit, pushed, files}` 를 보낸다. 서버가 `replied {turn}` 할 때까지 들고 있다가 다시 이어지면 또 보낸다(서버는 턴 번호로 한 번만 받는다). 턴들의 git 은 차례로 한다.
- 서버(`chat.reply`): 그 일의 가지일 때만 라인으로 가져오고(12.3), 마지막 말을 **보통의 답 메시지**로(`kind 'text'`, `content.localAgent = {id, label, where, jobId}`, 맥락 대화에서는 `context {conversationId, action: 'continue', strategy: 'pinned'}` 와 `conv` — 서버 에이전트의 답처럼 그 대화의 갈래 · 산출물 스택에 들어가고, 그 대화의 요약(`context/digest.rebuildSoon`)도 다시 만든다), 그 턴의 파일을 **파일 카드**로(숨은 경로 · `CLAUDE.md` · `AGENTS.md` 는 빼고 8개까지, 그 커밋의 내용을 저장소에 올린 사본 — 내 폴더의 문서는 `folder` 를 붙여 편집기에서 열면 그 폴더에 저장, 프로젝트의 것은 사본). 같은 파일 · 같은 내용은 다시 카드로 만들지 않는다(`chat.carded`).

### 12.5 세션 (같은 대화 · 같은 에이전트)
- 실행 하나 = CLI 세션 하나(PTY 하나). 턴이 끝나면 단계처럼 기다린다(`settle.js` — 데스크톱 설정 「턴이 끝난 뒤 기다리기」, 기본 5분). 그 사이 오는 메시지는 같은 PTY 로(위). 기다림이 다 되거나 「끝내기」면 닫는다 — 마지막 커밋 · push 와 `done`(서버: 남은 머리를 가져오고 남은 파일을 카드로). 채팅은 결과를 기다리는 사람이 없어 저절로 닫혀도 잃는 것이 없다 — 다음 메시지가 세션을 잇는다.
- 닫힌 뒤의 메시지: 새 실행이 `resume: {sessionId}`(앞 실행의 CLI 세션)를 받는다. 데스크톱은 그 대화의 세션 기록(`<data>/local-agents/sessions/chat-<열쇠>-<CLI>.json` — CLI 세션 · 폴더)이 맞고 같은 폴더면 `claude --resume` · `codex resume` 으로 잇고 메시지만 넣는다. 기록이 없으면(다른 컴퓨터, 지운 데이터) 새 세션에 프롬프트(대화 요약 + 폴더 안내 + 메시지)를 넣는다. 폴더는 매번 라인에서 다시 맞춘다(턴마다 올렸으므로 잃는 것이 없음).
- 닫히는 사이에 보낸 메시지(데스크톱이 「결과를 올리는 중」이라 받지 못한 입력)는 `done` 뒤 서버가 그 말로 다음 실행을 바로 만든다(같은 세션을 이어).
- 한 실행은 60분까지 — 채팅은 그때 실패가 아니라 닫힘(다음 메시지가 잇는다).
- 앱이 실행 중에 다시 켜지면 단계와 같다: 서버가 같은 일을 그 일의 세션으로 다시 보내고 데스크톱이 잇는다.

### 12.6 실패 · 꺼짐 · 「기본으로 다시 보내기」
- 카드(`chat.cardOf` — 단계 카드의 모양에 `chat: true`, 폴더, 답 수): 기다림 「PC 앱이 꺼져 있어요 — 켜지면 …에게 보내요. 지금 답이 필요하면 기본으로 다시 보낼 수 있어요」, 바쁨, 보냄, 실행 중(「같은 세션을 이어서」), 연결 끊김(링크가 없으면 그때 알린 것이 아니어도 늘 그렇게 — hub 의 지금 상태로), 닫힘 「세션을 닫았어요 — 다음 메시지는 같은 세션을 이어요」, 멈춤(까닭), PC 에서 받지 않음(묻고 거절 · 로컬 실행 끔 · 실행할 수 없음).
- 「기본으로 다시 보내기」(보낸 사람만, 기다림 · 연결 끊김 · 멈춤 · 받지 않음일 때): `POST /api/local-agents/jobs/:id/fallback` — 실행이 아직 열려 있으면 취소하고(데스크톱에 `cancel`), 마지막 답 뒤에 보낸 메시지들의 글을 돌려준다. 화면이 그 글을 「기본」으로 다시 보낸다(서버의 에이전트가 답하는 보통의 메시지 — 사용자 메시지가 한 번 더 보인다). 카드는 「기본 에이전트로 다시 보냈어요」.
- 단계와 달리 서버에 저절로 맡기지 않는다: 채팅의 메시지를 누가 답할지는 사람이 고른 것이다.

### 12.7 누가
- 실행하는 것: 보낸 사람 자신의 데스크톱만(배정이 `user_id` 의 링크만 본다). 보는 것: 보낸 사람, 그리고 프로젝트 변형에서 도는 실행이면 그 폴더의 구성원(`chat.canSee` — 단계의 「인스턴스를 볼 수 있는 사람」에 맞춘 것. 대화 자체는 그 사람의 것이라 구성원이 그 카드를 여는 길은 지금 API 뿐이다). 입력 · 끝내기 · 물음에 답하기 · 다시 보내기: 보낸 사람만(그 밖 403). 다른 사람의 대화에 보내기는 404(대화가 그 사람의 것이 아님). 제안은 단계처럼 볼 수 있는 사람이 올릴 수 있다(데스크톱 알림만, Home 카드 없음).
- 채팅의 실행은 Home 의 「지금 도는 실행」에 넣지 않는다(인스턴스가 없음 — `activeFor` 는 `proc_inst_id` 가 있는 것만).
- 데스크톱의 「실행 전에 묻기」(시스템 창)는 채팅의 일에는 묻지 않는다 — 단계는 누가 배정해 오는 것이라 묻지만, 채팅의 메시지는 그 사람이 방금 자기 채팅에서 보낸 것이다. 「이 컴퓨터에서 단계 실행」을 끈 데스크톱에는 채팅의 일도 가지 않는다(칩에 「PC 앱에서 에이전트 실행이 꺼져 있어요」).

### 12.8 운영에 필요한 것
- **SQL `server/sql/055_chat_agents.sql`**(더하기만, 여러 번 돌려도 됨): `pro_local_jobs` 에 `kind`(기본 `'step'`) · `thread_id` · `chat` 열과 색인 하나, 새 테이블 `pro_chat_agents`(RLS 켬). 없으면 칩은 보이지만 내 PC 로 보내면 503 과 안내.
- **데스크톱 0.2.2**: runner 가 바뀜(`kind 'chat'`, `reply`, 대화의 세션 기록, `caps.chat`). 0.2.1 데스크톱에는 채팅의 일을 보내지 않는다(칩이 「새 판으로 올리면 …」).
- 새 환경변수는 없다.

### 12.9 시험
| 무엇 | 어디 | 결과(2026-11-24) |
|---|---|---|
| 고르기(데스크톱 caps: 없음 · 꺼짐 · 켜짐 · 실행 끔 · 0.2.2 전 · 없는 CLI), 대화 · 사람마다의 선택, chat 일 만들기(그 사람의 데스크톱에만), 같은 세션 이어 쓰기 · 닫힌 뒤 resume · 닫히는 사이의 메시지, 턴의 답 한 번, 권한(403 · 구성원은 보기만 · 편집자 아님 403) | `server/test/chatAgents.test.js` | 7/7 |
| runner: 대화의 폴더 · `chat` 세션 · 턴마다 커밋 · push · reply, 같은 PTY 로 이어서, 결과.md 없음, 대화의 세션 기록으로 `--resume`, 기록이 없으면 새 세션(요약), reply 다시 보내기, 대화 없는 일 거절 | `desktop/test/chat.test.js` | 3/3 (데스크톱 전체 46 통과 · 4 건너뜀) |
| 실제 BFF + runner(가짜 대화형 CLI): 고르기 · 보내기 → 답 + 파일 카드(내 폴더 main) · 이어서 · 끝내기 뒤 `--resume` · 다른 사람 403/404 · 꺼짐 → 기다림 · 다시 보내기 · 프로젝트 변형(원본 그대로) · 구성원 보기만 · 실행자 403 | `server/test/chatAgents.e2e.mjs` | 8/8 |
| 화면: 칩 · 꺼진 항목과 까닭 · 내려받기 · PC 가 이어지면 켜짐 · 키보드로 고르기 · 태그 · 카드 · 답 · 파일 카드 · 이어서 · 대화마다 남음 · 다시 기본 · 꺼짐과 다시 보내기 · 390px 밝게/어둡게 · 어두운 테마 | `e2e/tests/feature/chat-agent-picker.spec.js` F-CA-01–08 | 7/7 |

## 13. 채팅에서 내 PC 의 스킬 · 폴더를 등록 제안 (2026-11-27, 가지 `feat/local-skill-register`, 데스크톱 0.2.8)

사용자 요청: 「그냥 채팅의 대화로 로컬 에이전트를 선택하여 내 pc 에 있는 스킬중 어떤 스킬을 등록해줘라고 하면 서버에 스킬을 등록한다.. 그러려면 로컬 에이전트쪽에 process gpt 의 mcp나 api 가 등록되긴해야할것」 · 「폴더 등록 또한 채팅으로 시킬 수 있겠지」. 스펙 `local-agents` 「채팅에서 내 PC의 스킬 · 폴더 등록 제안」 · `champion-folders` 「채팅으로 폴더 업로드 제안」.

### 13.1 흐름
1. 채팅에서 「Claude Code · 내 PC」(또는 Codex)를 고르고 「내 PC 의 견적-규칙 스킬을 등록해 줘」 · 「~/영업 키트 올려 줘」라고 보낸다 — 12절의 채팅 실행이다.
2. 그 실행의 CLI 에는 앱이 더한 MCP 서버 `process_gpt_lite` 가 있다. CLI 가 도구 설명을 보고 스스로 부른다(앱 · 서버는 사람의 말을 읽지 않는다).
3. 도구가 앱에 닿으면 앱이 그 PC 의 폴더를 챔피언 폴더의 검사로 읽고, 실행의 도구 토큰으로 서버에 **제안**한다.
4. 서버가 그 실행의 대화에 카드(`pro_messages.kind = 'pc_proposal'`)를 낸다 — 「스킬을 등록할까요?」 · 「폴더를 올릴까요?」. 도구는 CLI 에게 「카드에서 「등록」 · 「올리기」를 눌러야 해요 — 여기서 멈추세요」라고 답한다.
5. 그 사람이 카드를 누르면(휴대폰에서도) 스킬은 서버가 등록하고, 폴더는 서버가 챔피언 폴더를 만든 뒤 그 PC 의 앱이 올린다. 카드는 「등록했어요 · 열기」 · 「올렸어요 · 열기」가 된다.

### 13.2 데스크톱 (`desktop/src/mcp/` · `desktop/src/runner/tools.js`)
- **stdio MCP 서버**(`src/mcp/server.js`, 도구 정의 `src/mcp/tools.js`): 의존성 없는 JSON-RPC(initialize · tools/list · tools/call · ping). CLI 가 앱 자신의 실행 파일로 띄운다 — `ELECTRON_RUN_AS_NODE=1`(창도 앱도 없음; 묶은 앱의 RunAsNode 퓨즈는 Electron 기본 그대로, `scripts/adhoc-sign.js` FUSES 는 쿠키 봉인만). 개발용 Electron 45.3.2 로 asar 안의 스크립트를 띄워 확인했다. 시험 · 순수 Node runner 에서는 그 Node 로.
- **앞문일 뿐**: MCP 서버는 서버 토큰도 파일도 만지지 않는다. 호출을 앱의 로컬 통로로 넘긴다 — 그 사용자만 여는 임시 폴더(0700)의 유닉스 소켓, Windows 는 이름 있는 파이프(이 PC 의 어느 프로그램이든 열 수 있다 — 경계는 열쇠다). 실행마다 바뀌는 열쇠(32바이트)가 있어야 무엇이든 되고, MCP 서버의 설정 파일(`<sessions>/<job>/lite-tools.json`, 0600)에는 통로 · 열쇠 · 언어만 있다. 실행이 끝나면 열쇠는 닫힌다.
- **CLI 에 넘기기**(`session.js`): Claude Code `--mcp-config <세션 폴더>/mcp.json`(그 사람의 MCP 서버는 그대로 — `--strict-mcp-config` 없음) + 세션 설정의 `permissions.allow` 에 다섯 도구(`mcp__process_gpt_lite__…` — 제안만 하므로 묻지 않음, 사람의 「예」는 카드). Codex `-c mcp_servers.process_gpt_lite.command · args · env · tool_timeout_sec=600`(그 사람의 `config.toml` 은 쓰지 않음).
- **도구** — `lite_list_pc_skills`(Claude Code `$CLAUDE_CONFIG_DIR/skills` 또는 `~/.claude/skills` · Codex `$CODEX_HOME/skills` · `~/.agents/skills` · 작업 폴더의 `.claude/skills` · 또는 `under`; SKILL.md 머리말의 이름 · 설명, 링크는 링크로 — 가리키는 곳만 알려 줌) · `lite_list_my_skills` · `lite_list_my_folders`(서버, 읽기만) · `lite_propose_skill({path, name?, scope?})` · `lite_propose_folder({path, name?})`.
- **어느 폴더**(`resolvePath` · `checkFolder`): 절대 · `~/` · 작업 폴더 기준 상대(탈출 거절). 그 폴더 자체가 링크면 거절(따라가지 않음 — 가리키는 폴더를 말하게), 디스크 맨 위 · 볼륨 맨 위(`/Volumes/<이름>` · `/media/<사람>/<이름>` · `/mnt/<이름>`) · 홈과 그 위 · 시스템 폴더와 그 안(`~/Library` — 그 안의 클라우드 드라이브 폴더 `CloudStorage/<드라이브>/…` · `Mobile Documents/com~apple~CloudDocs/…` · `Mobile Documents/<앱>/Documents/…` 는 예외, 그 자리 · 드라이브의 맨 위 · 앱의 iCloud 데이터 · 드라이브 안의 숨은 폴더는 거절 — · `/System` · `/usr` · `/etc` · `/var` — 사람마다의 임시 · 캐시 폴더 `/var/folders/…/T` · `C` 도, 그 아래 홈 · `/var/www` · `/var/srv` 는 빼고 — · `/opt/homebrew` · `/snap` · `~/snap` · `/run/user` … · Windows `SystemRoot` · `ProgramFiles` · `ProgramData` · `AppData`) · `/Users` · `/Volumes` · `/var` · `/tmp` · `/opt` · `/run` 그 자체 · CLI 의 집(`~/.claude` · `~/.codex` · `~/.agents`)과 그 안(그 `skills` 폴더만 예외) · 홈 바로 아래의 숨은 폴더와 그 안(`~/.kube` · `~/.docker` · `~/.config` · 키링 · 브라우저 프로필 …) · 경로 어디에든 비밀 · 개인 묶음의 폴더(`.ssh` · `.aws` · `.claude/projects` · `.codex/sessions` · `.vscode` …) · 앱 데이터. 실제 경로는 디스크의 표기로 읽는다(`realpathSync.native` — `CLAUDE_CONFIG_DIR` 를 디스크와 다른 대소문자로 적어도 그 폴더). `/var` 전체가 아니라 시스템 영역(`folders` · `db` · `log` · `lib` · `cache` · `spool` · `tmp` · `run` 등)만 거절한다. `/var/home` 아래의 홈(Fedora Silverblue 등)과 `/var/www/<사이트>`는 사용자 폴더로 취급한다. 홈을 포함한 시스템 폴더는 「안쪽 전체 거절」에서 제외한다(홈으로 가는 경로 자체는 여전히 거절한다). `/run/user`는 내부 전체를 거절하고, `/run/media/<사람>`은 볼륨 최상위 폴더로 간주하여 거절한다.
- **스킬 읽기**(`packSkill`): 챔피언 폴더의 `scan()` 그대로(같은 `secret-shapes.json` — 비밀 · 개인 설정 · 다시 만들 것 · 50MB 넘는 파일 · 링크 · 하위 저장소 · git 제어 파일 · 확인할 파일과 확실한 열쇠 모양은 빠짐; `.mcp.json` 도 확인할 파일이라 빠짐). 스킬에서는 git 제어 파일(`.gitignore` · `.gitattributes`)도 빼고 「따로 관리」로 센다 — 서버의 스킬 폴더는 서버의 저장소다. 이름은 Windows · Mac 이 읽는 대로 본다(대소문자 무시, 끝의 점 · 빈칸 무시 — `.LFSCONFIG.` 도 `.lfsconfig`; 서버 `secrets.js` · 챔피언 `scan` 도 같다). 맨 위 `SKILL.md` 필수, 300개 · 8 MB. 머리말의 실행 키(`runSettings.frontRuns`)를 알려 준다. 파일은 base64 로 `POST /api/local-agents/tools/skills/propose` — 이 PC 의 경로는 보내지 않는다(어디서 왔는지는 `claude` · `codex` · `agents` · `work` · `other` 와 폴더 이름만).
- **폴더**(`proposeFolder`): 챔피언 폴더의 `FolderSync.pick(path)` 를 그대로 — 같은 `unsafe` 검사와 첫 훑기 미리 보기. 미리 보기(경로 없이)를 `POST …/folders/propose` 로 보내고, 앱은 그 pick 이 어느 제안의 것인지 기억한다(`proposed`).
- **올리기**(`tools:upload` → `FolderSync.bind`): 서버가 링크로 `{proposalId, pickId, folderId, folderName}` 를 보내면, 그 제안을 위해 자기가 만든 pick 일 때만(페이지의 시스템 창 pick 이나 다른 제안의 것은 `no_pick`) 챔피언 폴더의 첫 올리기를 돌린다 — 시스템 창 대신 카드의 「올리기」가 그 사람의 「예」. 올리기 직전 앱은 그 폴더를 다시 검사하고(같은 규칙, 실제 경로가 제안 때와 같아야 함), `bind` 의 「예」 안에서 그때 다시 훑은 결과(경로마다 크기 · inode · mtime 의 지문 · 파일 수 · 바이트 — 같은 크기로 고친 파일, 같은 이름으로 바꿔치기한 파일도 다르다)를 제안 때의 것과 비교한다 — 다르면 아무것도 올리지 않고 `changed` 로 답하며 그 pick 은 버린다. 「예」 뒤에도 그대로다: `bind` 는 확인한 지문을 첫 round 에 넘기고(`round(id, {expect})`), round 는 훑기 전에 폴더의 실제 경로가 그대로인지(위 폴더가 링크로 바뀌지 않았는지) 보고, 훑은 지문이 다르면, 또 스냅숏이 파일을 읽은 뒤 다시 본 경로 · 지문이 다르면 아무것도 밀어 넣지 않고 `changed` 로 끝낸다(원본 행은 되돌림). 채팅 카드는 파일별로 엄격하게 확인하고, 시스템 창은 파일 목록을 기준으로 확인한다. 카드의 「예」는 표시한 개별 파일(크기 · inode · 수정 시각)에 대한 동의를 의미하고, 시스템 창의 「예」는 해당 파일 목록에 대한 동의를 의미한다. 창이 열려 있는 동안 저장한 파일과 권한 · 속성만 바뀐 파일은 그대로 업로드하고, 파일이 추가되거나 사라지면 중단한다. 변경 시각(ctime)은 태그 · 권한 · 클라우드 앱의 표시만 바꿔도 달라지므로 지문에서 제외한다. pick은 첫 업로드가 성공한 뒤에 삭제하여, 중단된 뒤에도 같은 시트 · 같은 카드에서 다시 누를 수 있도록 한다. 카드 처리 경로에서는 스냅숏 이후 그림자 index가 기록한 stat(inode · 크기 · 수정 초)을 순회한 결과와 비교한다. 읽는 동안 상위 폴더를 바꿨다가 되돌린 경우도 감지한다. 시스템 창의 길에서 멈추면 화면은 「「올리기」에 동의한 뒤 폴더가 바뀌어서 …」, 「지금 올리기」에서 폴더가 링크 너머로 옮겨졌으면 `moved`(「폴더가 다른 곳으로 옮겨졌어요 …」). 앱은 「채팅에서 고른 폴더 「…」를 올리고 있어요」 알림을 띄우고, 결과를 `tools:uploaded {ok, why, pushed}` 로 답한다. 그 뒤는 「내 PC 폴더 올리기」로 올린 폴더와 같다.
- **도구는 세션과 함께**(`runner.js toolSearchEnv`): 채팅 실행의 Claude Code 는 `ENABLE_TOOL_SEARCH=false` 로 띄운다 — Claude Code 2.1.332 는 MCP 도구를 ToolSearch 뒤로 미루는데, 사람들의 CLI 가 거치는 회사 모델 게이트웨이가 그 지연 도구 참조에 server_error 를 낸다(실측). 그 사람의 환경에 `ENABLE_TOOL_SEARCH` 가 있거나 runner 설정(`toolSearch` · 앱의 `PGL_TOOL_SEARCH`)이 있으면 그것을 따른다. 단계 실행 · Codex 에는 넣지 않는다.
- 기능 표시: `caps.liteTools`(도구가 있음) · `caps.liteFolders`(폴더도 올릴 수 있음 — 챔피언 엔진이 켜짐).

### 13.3 서버 (`server/lib/localAgents/pcTools.js` · `server/routes/pcProposals.js` · `sql/068_pc_proposals.sql`)
- **도구 토큰** `plt1.<payload>.<서명>`(서비스 키에서 뽑은 별도 열쇠 `pc-tools:v1`): `{tenant, user, device, job, scope: 'pc-tools', exp}`, 90분. 채팅 일의 `prepare` 가 `caps.liteTools` 인 데스크톱에만 싣는다(`job.tools.token`). 요청마다 `access` 가 다시 본다 — 기기가 연결돼 있고(끊지 않음) 그 사람의 것이며, 일이 그 기기 · 그 사람의 채팅 실행이고 지금 `offered` · `running` 이다. 그래서 실행이 끝나면 시간이 남아도 403(`job_over`). 토큰 경로는 세션 · 본문 파서 · 회사 미들웨어 앞(`/api/local-agents/tools`, 본문 16 MB)이고, 회사는 토큰이 말하며, 언어는 앱의 `X-PGL-Lang` 또는 그 사람의 저장된 언어다.
- **스킬 제안**: 서버가 다시 본다 — 경로(`..` · `.` · 빈 이름 · `.git` · 역슬래시 · 절대 경로), `secrets.refusalOf`(비밀 이름 · 큰 파일 · 확실한 열쇠 모양 → 422; git 제어 파일 `.gitignore` · `.gitattributes` · `.gitmodules` · `.lfsconfig` 는 거절하지 않고 버리고 「따로 관리」로 셈), 맨 위 `SKILL.md`, 300개 · 8 MB, 이름(글자 · 숫자 · `-` · `_`, 64자 — 이미 있으면 409 `name_taken`: CLI 가 사람에게 다른 이름을 묻게). 실행 설정은 서버가 `SKILL.md` 머리말(`kit.frontRuns`)과 설정 파일 이름(`RUN_SETTINGS`)으로 읽는다. 카드의 설명은 앱이 보낸 글이 아니라 올라온 `SKILL.md` 머리말(`skills.summarizeSkill`)에서 읽는다. 파일은 제안 때 `<폴더 뿌리>/<회사>/.pc-proposals/<id>/` 에 올라가 있고(카드가 그렇게 알림 — 「한 시간이 지난 뒤」: 정확한 시각은 약속하지 않는다, 정기 정리의 간격만큼 늦을 수 있고 `PRO_BACKGROUND=0` 이면 다음에 읽을 때), 행을 먼저 넣고 파일을 쓴다(정기 정리는 자리의 항목을 먼저 읽고 그다음 기다리는 제안을 묻는다 — 본 항목은 그 행보다 늦게 생겼으므로 제안이 없는 것으로 오인되지 않는다; 쓰다 실패하면 파일과 행을 지움), 등록되면 · 그만두면 · 등록이 실패하면 바로, 만료는 읽을 때와 서버의 정기 정리(10분마다 — `startSweeper`, `PRO_BACKGROUND=0` 이면 돌지 않음: 만료 · 두 시간 넘게 끝나지 않은 누름 · 제안이 없는 파일까지)에서 지운다.
- **폴더 제안**: 미리 보기만 받는다(알려진 필드 · 그룹 · 경고만, 길이 제한). 빈 폴더 · 한도 넘김은 거절. `pick_id` 를 행에 둔다.
- **카드**(`GET /api/pc-proposals/:id` · `register` · `upload` · `drop`): 그 사람의 것만(남은 404). 보인 그대로의 확인 값(메모리의 HMAC — 내용 · 상태 · 고를 수 있는 것에 묶임, 15분; 바뀌었으면 409 `stale`). 한 번 누름은 상태를 먼저 `working` 으로 잡는다(두 번째 409). 「어디에」는 언제나 「내 스킬」로 시작한다(CLI 가 회사를 청해도). 만료(1시간)는 읽을 때 · 새 제안 때 · 정기 정리에서. 기다리는 제안은 사람당 10개(429) — 한 사람의 제안은 이 서버 안에서 하나씩(약속 사슬: 세기와 넣기가 함께; 데이터베이스 잠금은 쓰지 않음 — 공용 풀을 잡은 채 기다리면 풀이 막힌다, #118).
- **등록**: 「내 스킬」 = `folders/skills.js saveDraftPrivate`(skill-creator 의 길 — 비공개 스킬 · 그 폴더 · 그 사람의 실행 사본). 「회사 스킬」 = 스킬 폴더의 「전사에 공유」와 같은 규칙(작성자는 공유할 수 있고, 카드로 등록하는 사람이 작성자 — 처음에는 관리자만으로 했다가 기존 규칙에 맞춤), 언제나 한 번 더 확인(`companyOk` — 없으면 409 `company_confirm`, 실행 설정이 있으면 `runs_confirm` 이고 카드의 확인 문구도 실행 설정을 말한다), 그다음 `skills.js share`(deepagents 설치). 설치가 실패하면 내 스킬로 남기고 카드가 알린다. 등록이 실패하면 그 파일을 지우고, 그 누름이 잡은 이름(폴더가 생기지 않은 `pro_skill_visibility` 행)도 풀며, 오류 문구는 서버의 경로를 말하지 않는다(`routes/folders.js hidePaths`).
- **올리기**: 그 PC 의 링크가 켜져 있고 폴더를 올릴 수 있을 때만(아니면 409 `pc_offline`). `service.createFolder(champion)`(실패하면 카드에는 코드 `create_failed` 만 — 까닭은 서버 로그로, 그 글에 서버의 경로가 있을 수 있다) → 링크로 `tools:upload` → 답(`tools:uploaded`, 그 기기 · 그 사람의 것만)으로 끝낸다. 아무것도 안 올라갔으면 빈 챔피언 폴더를 지우고(`discardEmptyChampion`) 카드를 다시 누를 수 있게(앱이 pick 을 잃었으면 끝), 답 없이 PC 가 1분 넘게 사라졌으면 읽을 때 같은 처리를 한다(파일이 들어갔으면 끝난 것으로).
- **옛 데스크톱**: `liteTools` 가 없는 데스크톱의 채팅 실행은 토큰 대신 프롬프트에 스킬 `process-discovery/prompts/local-tools-missing.md` 의 안내를 받는다(그 사람이 그런 일을 부탁하면 CLI 가 0.2.8 로 업데이트하라고 말함). 에이전트 고르기도 그 데스크톱의 항목에 「PC 앱을 0.2.8 이상으로 업데이트하면 …」과 `update` 를 단다.

### 13.4 왜 이렇게
- **stdio MCP + 앱의 통로(HTTP 를 CLI 에게 주지 않음)**: CLI 가 직접 서버를 부르면 토큰이 CLI 의 환경이나 파일에 있어야 하고, 폴더 올리기는 어차피 앱(챔피언 엔진 · 링크)이 해야 한다. 앱이 토큰을 메모리에만 두고, MCP 서버는 열쇠로 앱에 묻기만 한다 — runner 의 원칙(토큰은 디스크 · 로그에 쓰지 않음)을 지킨다. 같은 사용자로 도는 CLI 가 설정 파일을 읽을 수는 있지만, 그것으로 할 수 있는 것도 제안뿐이고 결정은 카드다.
- **포트를 열지 않음**: 통로는 유닉스 소켓 · 이름 있는 파이프(링크의 원칙: 이 컴퓨터에 포트를 열지 않는다). 파이프는 이 PC 의 어느 프로그램이든 열 수 있으므로 경계는 실행마다 바뀌는 32바이트 열쇠다(같은 사용자의 CLI 는 설정 파일로 그 열쇠를 읽을 수 있지만, 그것으로 할 수 있는 것도 제안뿐이다).
- **MCP 서버를 ELECTRON_RUN_AS_NODE 로**: 훅처럼 앱 플래그(`--pgl-mcp`)로 앱의 브라우저 프로세스에서 띄우는 길도 재 보았다(2026-11-28, Electron 45.3.2 · macOS). stdio 로 답하고 stdin 이 닫히면 끝나는 것까지는 됐지만, 채팅 실행마다 LaunchServices 에 UI 요소로 등록되고 프로세스 3개 · 약 215 MB(노드 모드는 1개 · 약 56 MB) · 첫 답 약 200 ms(노드 모드 약 50 ms)였고, Windows 의 GUI 하위 시스템 본 프로세스가 파이프로 stdout 을 쓰는 것은 확인하지 못했다(훅은 stdin 만 읽고 곧 끝난다). 그래서 노드 모드를 두고, RunAsNode 퓨즈는 Electron 기본대로 둔다(`scripts/adhoc-sign.js` — 시험이 지킴). 그 퓨즈를 끄기로 하면 앱 플래그 길로 옮긴다. 앱이 Developer ID 서명 · hardened runtime 으로 옮겨 가면 그때 옮긴다 — 그 뒤의 RunAsNode 는 이 PC 의 다른 프로그램이 이 앱이 받은 macOS 권한(마이크 · 카메라 · 허락한 폴더)을 빌려 쓰는 길이 되기 때문이다.
- **서버가 경로를 말하지 않음**: 폴더 올리기의 `tools:upload` 는 앱이 자기 실행의 제안을 위해 만든 pick id 만 가리킨다. 서버(또는 그 흉내)가 PC 의 아무 폴더나 올리게 할 수 없다.
- **「회사 스킬」은 기존 규칙대로**: 스킬 폴더의 「전사에 공유」는 작성자 누구나 할 수 있고, 카드로 등록하는 사람이 그 스킬의 작성자다. 관리자만으로 막으면 「내 스킬」로 등록한 뒤 「전사에 공유」로 바로 돌아갈 수 있어 막는 뜻이 없다. 회사 사람들의 PC 에서 실행 설정이 도는 위험은 「한 번 더 확인」으로 남긴다.
- **스킬 파일은 서버 디스크에 잠시**: DB 에 수 MB 를 넣지 않고, 폴더 뿌리(운영의 PVC) 아래 숨은 자리에 둔다.

### 13.5 시험
| 무엇 | 시험 | 결과 |
|---|---|---|
| 토큰 · 범위 · 만료, 도구 있는 데스크톱에만 · 옛 앱 안내, 켜진 실행에만, 서버의 다시 보기(제어 파일은 버림 · 설명은 서버가 읽음), 카드 · 확인 · 두 번 누름, 회사 스킬(언제나 한 번 더), 만료 · 그만두기 · 등록 실패의 정리, 폴더 제안 · 올리기 · 실패 · pick 잃음 · PC 꺼짐, 목록 · 10개(동시 12개), 정기 정리(쉬지 않고 도는 정리 곁의 제안도), 새 연결 · 바뀐 폴더, 폴더 만들기 실패는 코드만 | `server/test/pcProposals.test.js` PT-01 ~ PT-13 | 13/13 |
| 어느 폴더(CLI 의 집 — 다른 대소문자로 적어도 · 홈 바로 아래 숨은 폴더 · 개인 폴더 · `/var`(그 아래 홈 · `/var/www` · `/var/srv` 는 허용) · `/opt/homebrew` · `~/snap` · `/run/user` · 볼륨 맨 위 · `~/Library` 의 클라우드 드라이브 폴더는 허용) · PC 의 스킬 목록 · 스킬 읽기(제어 파일 뺌 — `.LFSCONFIG.` 도) · stdio MCP · 스킬 제안 · 폴더 제안과 `tools:upload` · 바뀐 폴더는 안 올림(같은 크기로 고침 · 바꿔치기도; 권한 · 속성만 바뀐 것은 올림) · CLI 명령 줄 · caps · 퓨즈 · 채팅 실행의 `ENABLE_TOOL_SEARCH=false` | `desktop/test/tools.test.js` DT-01 ~ DT-10 | 9/9 (DT-10 은 DT-06 안) |
| 카드의 길: 「예」 뒤에 바뀐 폴더(더한 파일 · 같은 크기로 고친 파일 · 링크로 바뀐 위 폴더 · 스냅숏이 읽는 동안 고친 파일 · 읽는 동안 바꿨다 되돌린 위 폴더)는 첫 올리기에서 멈춤, pick 은 남음 · 시스템 창의 길: 저장한 파일 · 권한 · 속성 변화는 올라가고 더한 파일은 멈춤 · 같은 pick 으로 다시 누름 | `desktop/test/sync.test.js` 「동의한 뒤 바뀐 폴더」 · 「시스템 창 길」 | 2/2 |
| 실제 BFF + 데스크톱 runner + 가짜 대화형 CLI(실제 stdio MCP 를 부름): 스킬 제안 → 토큰 먼저 · 본문 한도 → 등록, 폴더 제안 → 올리기, 끝난 실행 403, Codex | `server/test/pcProposals.e2e.mjs` (:8999) | 8/8 |
| 화면: 스킬 카드(내 스킬에서 시작 · 회사는 한 번 더 · 임시 공간 안내) → 등록 → 목록, 실행 설정 · 회사 스킬(어둡게), 폴더 카드 → 올리기 → 열기, 390px 밝게 · 어둡게 · 그만두기, 보여 준 뒤 바뀐 폴더 → 「폴더를 올리지 못했어요」 | `e2e/tests/feature/pc-proposals.spec.js` F-PCP-01 ~ 05 (:8999 · :5399) | 5/5 |
| 실제 Claude Code 2.1.332(회사 게이트웨이, 임시 설정 · 홈): 「내 PC 의 견적-규칙 스킬을 Process GPT 에 등록해 줘」 → `lite_list_pc_skills` → `lite_propose_skill` → 「카드를 눌러 확인해 주세요」 (게이트웨이가 ToolSearch 의 지연 도구 참조를 못 받아 `ENABLE_TOOL_SEARCH=false`) | `desktop/test/realClaudeTools.test.js`(사람이 켤 때만) | 1/1 (7초 · 검토 반영 뒤 다시 1/1, 7초) |

### 13.6 PR #120 검토에서 바뀐 것
| # | 무엇 | 어디 |
|---|---|---|
| 1 | 올리기는 카드에 보인 그대로만: 제안 때의 파일 수 · 바이트 · 지문(경로마다 크기)을 앱이 두고, 올리기 직전 다시 검사(실제 경로가 같아야) · `bind` 의 「예」 안에서 다시 훑어 비교 — 다르면 `changed`, 카드는 실패 | `runner/sync.js` · `runner/tools.js` · `pcTools.settleUpload` · 카드 |
| 2 | 「회사 스킬」을 미리 고르지 않음, 언제나 한 번 더 확인(`companyOk`), 서버도 409 `company_confirm` · `runs_confirm` | 카드 · `pcTools.register` · `routes/pcProposals.js` |
| 3 | CLI 의 집은 그 `skills` 만, 홈 바로 아래 숨은 폴더 거절, 비밀 · 개인 묶음을 고른 폴더의 절대 경로 전체에 | `runner/tools.js checkFolder` |
| 4 | git 제어 파일은 앱이 빼고 서버는 버림(거절하지 않음) | `runner/tools.js packSkill` · `pcTools` |
| 5 | 도구 경로는 토큰 먼저, 16 MB 는 스킬 제안에만 | `routes/pcProposals.js` |
| 6 | 정기 정리(`startSweeper`, `PRO_BACKGROUND=0` 이면 없음) · 등록 실패면 파일과 잡은 이름을 풂 · 카드와 스펙에 「서버의 임시 공간 · 한 시간」 | `pcTools.sweepAll` · `server/index.js` · 카드 |
| 7 | 누른 뒤 PC 가 새로 연결되면 기다리던 업로드를 끝냄 | `pcTools.current` |
| 8 | 한 사람의 제안은 서버 안에서 하나씩(약속 사슬 — 데이터베이스 잠금 · 공용 풀은 쓰지 않음) | `pcTools.oneAtATime` |
| 9 | 등록 실패 문구에 서버 경로 없음 | `pcTools.register` · `routes/pcProposals.js` (`routes/folders.js hidePaths`) |
| 10 | 카드의 설명은 올라온 `SKILL.md` 에서 서버가 읽음 | `pcTools` (`skills.summarizeSkill`) |
| 11 | Windows 이름 있는 파이프는 비공개가 아님 — 경계는 32바이트 열쇠 | `mcp/server.js` · `runner/tools.js` 머리말 · 이 문서 §13.2 · §13.4 · `desktop/README.md` |
| 12 | MCP 서버를 앱 플래그로 띄우는 길은 재 보고 두지 않음(§13.4) | — |

재검토(46812a3 기준)에서 더 바뀐 것:

| # | 무엇 | 어디 |
|---|---|---|
| R1 | 「예」 뒤에 더한 · 고친 파일, 위 폴더가 링크로 바뀐 것도 올리지 않음: 확인한 지문을 첫 round 에 넘기고 훑기 전 · 스냅숏 뒤에 다시 봄 | `runner/sync.js bind · round` · `runner/tools.js` |
| R2 | 정기 정리와 스킬 제안의 경쟁: 행을 먼저 넣고 파일을 씀(정리는 자리를 먼저 읽고 행을 나중에 물음) | `pcTools.proposeSkill · sweepAll` |
| R3 | 「올리기」의 폴더 만들기 실패: 카드 · 행에는 코드 `create_failed` 만, 까닭은 로그로 | `pcTools.upload` · 카드 |
| R4 | `/var` · `/private/var` 전체(사람마다의 임시 · 캐시 폴더도) · `/opt/homebrew` · `/snap` · `~/snap` 안쪽 거절, 볼륨 맨 위 거절, 실제 경로는 `realpathSync.native` | `runner/tools.js checkFolder · volumeTop` |
| R5 | 카드 문구 「한 시간이 지난 뒤 지워져요」(정확한 시각을 약속하지 않음) | 카드 · 스펙 |
| R6 | 지문에 파일마다 inode · mtime(3차에서 ctime 은 뺌) | `runner/sync.js stampOf` |
| R7 | 제어 파일 이름은 대소문자 · 끝의 점 · 빈칸 무시(서버 · 데스크톱 · 페이지) | `secrets.js baseOf` · `sync.js baseName` · `tools.js isControl` · `src/folderDrop.js` |
| R8 | Developer ID · hardened runtime 으로 옮기면 MCP 서버도 앱 플래그로(§13.4) | 이 문서 |

3차 확인(c4198d5 기준)에서 더 바뀐 것:

| # | 무엇 | 어디 |
|---|---|---|
| T1 | `/var` 아래 홈(Fedora Silverblue 등)이 통째로 거절되던 회귀: `/var` 는 시스템 자리만, 홈을 품은 시스템 폴더는 안쪽 거절에서 뺌 | `runner/tools.js systemFolderOf · VAR_SYSTEM` |
| T2 | 시스템 창 길이 바이트가 그대로인 변화에도 멈추던 회귀: 카드는 지문(크기 · inode · mtime — ctime 뺌), 시스템 창은 파일 목록; pick 은 성공한 뒤에 지움(다시 누를 수 있음) | `runner/sync.js bind · round` · `runner/tools.js`(`strict: true`) |
| T3 | `/run/user` 안쪽 거절, `/run/media/<사람>` 은 볼륨 맨 위 | `runner/tools.js` |
| T4 | 링크 너머로 옮겨진 폴더는 `moved`(따로 된 문구) | `runner/sync.js round` · `src/desktopFolders.js` |
| T5 | `~/Library/CloudStorage/<드라이브>/…` · `~/Library/Mobile Documents/<…>/…` 허용(페이지의 시스템 창 길은 원래 `~/Library` 를 막지 않음) | `runner/tools.js inCloudDrive` |
| T6 | 카드의 길: 스냅숏 뒤 그림자 index 의 stat 을 훑은 결과와 비교 | `runner/sync.js indexMatches` |
| F1 | 아주 큰 inode(2^53 넘음 — FUSE · overlayfs)에서 카드 올리기가 늘 「바뀜」이던 것: 그때는 inode 를 견주지 않음, 다음 초로 반올림된 수정 시각도 같은 초로 | `runner/sync.js sameIndexed` |
| F2 | 시스템 폴더 안에 홈을 둔 경우 그 이웃 폴더까지 열리던 것: 홈 안만 열림 | `runner/tools.js systemFolderOf` |
| F3 | `/var` 는 목록 대신 통째로 시스템의 것, 사람의 자리(`home` · `www` · `srv`)와 그 아래 홈만 예외 | `runner/tools.js VAR_OWN` |
| F4 | 클라우드 드라이브: iCloud 는 iCloud Drive 와 앱의 `Documents` 안만, 드라이브 안의 숨은 폴더(캐시 · 휴지통)는 거절 | `runner/tools.js inCloudDrive` |
