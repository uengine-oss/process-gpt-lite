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
- 단계가 손으로 닫히거나 옮겨지면 일을 멈추라고 보낸다.

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
- **링크로 오는 것**(데스크톱 → 서버, hub 가 받아 relay 에): `term-open {sid, kind, ref, agent, cli, cols, rows, replay?}` · `pty {sid, data}`(40ms 마다 모음) · `term-session {sid, cli}` · `hook {sid, event, data}` · `files {sid, files:[{path, content|deleted}]}` · `term-exit {sid, code}`. 다른 사람의 세션 · 다른 기기의 세션에 대한 것은 버린다.
- **보는 사람**: `POST /api/local-agents/jobs/:id/term` → 1회용 표(60초, 볼 수 있는 사람만, `owner` = 작업자인지) → `wss://…/api/local-agents/term?ticket=…`(같은 출처만 — 작업실 터미널과 같은 문지기). 붙으면 `session {owner, live, cols, rows, agent, device}` 과 지금까지의 화면(`output replay`), 그 뒤로 `output` · `size` · `exit` · `detached` · `attached`. 서버에 이 세션이 없고(서버가 다시 켜짐) 일에 마지막 화면이 있으면 그것을 읽기 전용으로 보인다.
- **입력**: 보는 사람의 `input` · `resize` 는 작업자 것만 그 데스크톱 링크로(`pty-input {sid, data, byId}` · `pty-resize`). 다른 사람 것은 버리고 센다(`stats.dropped`). 화면 크기는 runner 가 정한 80×28 을 기본으로 둔다 — 보는 사람의 화면은 글자 크기를 줄여 맞추고, 넓으면 터미널 상자 안에서만 옆으로 움직인다(작업자의 크기 바꾸기는 프로토콜에 있으나 화면은 아직 보내지 않는다).
- **화면 모델**: 세션마다 `@xterm/headless` 에 바이트를 그대로 먹인다. `screenOf(S)` = 보이는 줄 · 커서 · 크기(「지금 화면에 무엇이 있는지」 — 선택 창을 알아보는 watcher 가 쓸 것), `GET /api/local-agents/jobs/:id/screen`. 되감기용 바이트는 400KB 까지.
- **훅 · 파일**: `events`(EventEmitter: `open` · `hook` · `files` · `exit`)로 서버 안의 듣는 쪽에 전한다. 훅 이벤트에는 사건 이름과 몇 가지 평문(`session_id` · `message` · `notification_type` · `source` · `error` · `last_assistant_message`)만 — 이 컴퓨터의 경로 · 도구 입력은 보내지 않는다. 지켜보는 파일은 세션을 열 때 정한 경로(예: `aidlc/`) 아래 256KB 이하 글만.
- **남기는 것**: 세션이 끝나면 `step` 은 마지막 화면 64KB 와 크기를 일에(`screen` · `screen_size`), 터미널이 있었음을(`terminal`) 남긴다. 링크가 끊기면 세션은 `detached` 로 남고, 다시 붙으면 데스크톱이 열린 세션을 지금까지의 화면과 함께 다시 알린다(서버가 다시 켜졌을 때도).
- **메모리에서 지우기**(검토 지적 11-24): CLI 가 끝난 세션은 `PRO_LOCAL_TERM_KEEP_MS`(기본 10분) 뒤, 데스크톱이 사라져 돌아오지 않는 세션은 `PRO_LOCAL_TERM_DETACH_MS`(기본 1시간) 뒤에 화면 모델을 닫고 지운다(보던 사람의 연결도 닫음). 그 뒤 보는 사람은 일에 남은 마지막 화면을 받는다.
- 서버 한 대 기준(메모리) — hub 의 접속 상태와 같은 가정.

## 6. 데스크톱 (`desktop/src/runner/`)

| 파일 | 하는 일 |
|---|---|
| `clis.js` | CLI 찾기 · 버전 · 로그인, 고정 명령, 출력 읽기 |
| `git.js` | 작업 폴더 맞추기 · 가지 · 커밋 · push · 라인 따라가기 |
| `runner.js` | 일 하나를 처음부터 끝까지, 입력, 보고함(outbox), 중계되는 세션(`openSession`), 다시 켜졌을 때 이어서 |
| `session.js` | 대화형 CLI 세션 하나(PTY): 세션 설정 · 훅 파일, 첫 프롬프트 붙여 넣기, 기록(jsonl · rollout) 읽기, 지켜보는 경로, 폴더 신뢰 |
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
- **단계의 끝**: 턴이 끝나고 `PGL_RUNNER_SETTLE_MS`(기본 3초) 동안 새 턴 · 기록에 아직 안 들어간 입력(20초 한도) · 사람의 타자가 없으면 끝. 사람이 쳤지만 보내지 않은 줄은 `PGL_RUNNER_IDLE_FINISH_MS`(기본 2분)까지 기다린다. 끝나면 CLI 를 닫고(SIGTERM) 결과를 쓴다. 한 번에 60분까지.
- **환경**: 사람 자신의 것에서 부모 Claude Code 의 표지(`CLAUDE*`, 단 `CLAUDE_CONFIG_DIR` 은 둠), `GIT_CONFIG_*`, `ELECTRON_RUN_AS_NODE`, `PGL_*` 를 빼고 `TERM=xterm-256color` · `COLORTERM=truecolor` · `DISABLE_LOGIN_COMMAND=1` · `DISABLE_LOGOUT_COMMAND=1`(agent-share 처럼 — 여럿이 보는 화면에서 계정을 바꾸지 않게).
- **다시 켜졌을 때**: runner 는 세션 id 를 알면 `<userData>/local-agents/sessions/<일>.json`(0600: CLI 세션 · 폴더 · 시작 커밋 · 산출 폴더)에 적는다. 앱이 끝나면 CLI 를 멈추되 그 기록은 남긴다. 서버가 같은 일을 `resume` 과 함께 다시 보내면, 기록이 맞을 때 폴더를 되돌리지 않고 같은 세션을 이어(`--resume` · `codex resume`) 「이 앱이 다시 켜져서 같은 세션을 이어서 해요. 하던 일을 마저 끝내세요.」를 넣는다. 일이 끝나거나 취소되면 기록을 지운다.
- **사람을 기다릴 때**: `Notification` 훅(권한 확인 등)이 오면 진행 줄에 남기고 main 이 「「<단계>」 — 터미널에서 답을 기다려요」 알림을 띄운다. 작업자는 자기 창(또는 휴대폰)의 터미널에서 답한다.

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

## 7. 시험

| 무엇 | 어디 | 결과(2026-11-24) |
|---|---|---|
| 활동 설정 · 기기 토큰 · 배정 · 기다림 · 시간 지남 · 남의 데스크톱 · 거절 · 입력 상태 · 손으로 맡기기 · 링크(WebSocket) · 제안 → 입력(작업자만, 403) · 제안의 종류(의견 · 결정) · 터미널 중계(자기 일만 열기, 같은 바이트, 주인 입력만, 화면 모델, 훅 · 파일, 다시 붙기) · 스킬 고르기 · 배운 것(판정 대역) (검토 수정 11-24: 기기 설정 바꿔도 실행 유지 · 다시 시도 · 관문 먼저 · 에이전트 되돌리기 · 활동 에이전트 제한 · 받기 확인과 거두기 · 세션 지우기 · 보낸 스킬만 · 공개 git 경로) | `server/test/localAgents.test.js` (가짜 링크) | 28/28 |
| runner 헤드리스(예비 길): 맞추기 → 실행 → 입력 → 커밋 → 올리기, 토큰이 남지 않음, 거절, 실패 보고, 스킬 놓기, 배운 것 · 서버 확인 전에는 아무것도 하지 않음 · 같은 폴더는 앞 일의 finished 뒤 · 폴더 자신의 AGENTS.md · CLAUDE.md · .claude/ 그대로 | `desktop/test/runner.test.js` (가짜 CLI · git HTTP) | 14/14 |
| runner 터미널(주 길): node-pty, `SessionStart` 뒤 붙여 넣기 · `Stop` 으로 끝 · 커밋, 중계 바이트 = 터미널 바이트, 주인의 타자만 CLI 에, 고친 제안 붙여 넣기, 앱 다시 켜기 → `--resume`, Codex(명령줄 첫 메시지 · rollout), 단계 아닌 세션의 훅 · 지켜보는 파일, 폴더 신뢰 | `desktop/test/terminal.test.js` (가짜 대화형 CLI `fake-tui.js`) | 6/6 (데스크톱 전체 30/30) |
| 실제 BFF + 두 사람의 runner(터미널): 공개 git 경로(`/api/local-git`)로 맞추기 · 올리기(토큰 없음 401 · 클러스터 토큰 403 · 끊은 기기 403), A → B 이어받기, 참여자의 제안 → 작업자만 입력(403), 터미널(보는 사람과 작업자가 작업자 데스크톱의 바이트 그대로 받음 · 보는 사람의 입력은 버림 · 작업자의 입력은 CLI 에 · 바깥 사람 403 · 지금 화면), 회사 스킬, 배운 것 반영(403 포함), 꺼져 있을 때 기다림 · 서버, Codex 입력(같은 세션), 기기 끊기 | `server/test/localAgents.e2e.mjs` | 9/9 |
| Electron 앱 두 개(Playwright `_electron`): 저절로 연결 · 알약 · 앱 안의 node-pty 로 터미널 실행 · B 가 자기 창의 터미널을 보며 입력 · 로컬 실행 끔 → 기다림 | `e2e/tests/desktop/local-agents.spec.js` | 4/4 |
| 휴대폰(390px) 브라우저에서 터미널 실시간 보기 · 입력 · 권한 · 「PC 앱이 켜지면 시작」 · 서버에 맡기기 · Home 카드 | `e2e/tests/feature/local-agents-mobile.spec.js` | 3/3 |
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
- 환경변수(모두 선택): 서버 `PRO_GIT_PUBLIC_URL`, `PRO_LOCAL_AGENT_WORKER=0`(일꾼 끔), `PRO_LOCAL_AGENT_TICK_MS`(기본 3000), `PRO_LOCAL_KNOWHOW_MIN`(기본 0.5), `PRO_LOCAL_TERM_KEEP_MS`(기본 600000) · `PRO_LOCAL_TERM_DETACH_MS`(기본 3600000). 데스크톱 `PGL_RUNNER_MODE=headless`(터미널 대신 헤드리스), `PGL_RUNNER_SETTLE_MS`(기본 3000), `PGL_RUNNER_IDLE_FINISH_MS`(기본 120000), `PGL_RUNNER_ACCEPT_MS`(기본 60000).
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
6. 단계의 끝을 「턴이 끝나고 3초 동안 아무 일 없음」으로 본다. 끝까지 하는 단계에서 작업자가 더 대화하고 싶을 때 「끝내기」 단추를 두고 자동 끝을 끌지.
7. 작업자의 타자도 서버를 거쳐 PTY 로 간다(어느 기기에서나 같은 길). 데스크톱 앱 창에서는 링크 없이 바로 PTY 에 붙게 할지(지연 · 서버가 꺼졌을 때).
8. 노하우의 「습관」 길: 실행 중 입력은 활동의 정의(「배운 것」)로만 보냈다. 사람마다의 습관(followups)으로도 보낼지.
9. 활동의 노하우를 반영할 사람: 관리자 · 프로세스 담당자(`proc_def.owner`). 지도의 일은 관리자만 고치는 지금 규칙과 같게 둘지, 건의 주인에게도 열지.
10. 판정 기준(`PRO_LOCAL_KNOWHOW_MIN` 0.5)과, 모델이 없을 때 「판정 못 함」으로 모두 올리는 것(지금) vs 올리지 않는 것.
11. 로그아웃하면 그 컴퓨터의 토큰을 끊는다. 로그아웃 뒤에도 그 사람의 일을 계속 받게 할지.
12. 결정(`decision`) 제안을 누가 보낼 수 있는지: 지금은 참여자 누구나(작업자만 넣음). AI-DLC 단계에서 역할자만으로 좁힐지.

## 11. AI-DLC 를 데스크톱으로 옮길 때 (다음 단계, 이번에는 만들지 않음)
Robo-DLC(`origin/feat/mcp-apps` 의 `server/lib/aidlc/*` — 서버 tmux 의 대화형 Claude Code, 화면 · 질문 파일 watcher, `--settings` 훅, 역할자 결정 화면, 헤드리스 intake, bolt worktree)를 개발 담당자의 데스크톱 runner 로 옮길 때 이번 구조에 꽂는 자리:
- (a) **일반 세션**: `runner.openSession({kind, ref, agent, cwd, resume, prompt, stateDir, watch})` — 단계에 묶이지 않은 PTY CLI 세션(세션 id · 이어서 하기). 단계 실행은 `kind: 'step'` 하나. 다음 단계는 `kind: 'aidlc'`(ref = 저장소 · bolt)를 서버에 `registerKind` 하면 된다. 남은 일: 서버가 데스크톱에 「이 저장소에서 세션을 열어라」를 보내는 메시지(지금은 runner 가 단계 일로만 연다), 저장소 · worktree 를 데스크톱에서 고르는 화면.
- (b) **훅 중계**: CLI 의 훅은 세션 설정 파일에서 로컬 파일로만 쓰고, runner 가 자기 링크로 `hook` 을 보낸다(CLI 가 서버 주소를 부르지 않음). `relay.events.on('hook')` 로 받는다. 지금 훅은 SessionStart · UserPromptSubmit · Stop · StopFailure · Notification(hooks.js 와 같은 묶음).
- (c) **서버의 화면 모델**: `@xterm/headless` 에 중계 바이트를 먹이고 `relay.screenOf(S)`(+`flushed`)로 「지금 화면」 — tmux watcher 의 `capture-pane` 자리. 선택 창 알아보기(watch.js 의 판정)는 그 위에 다음 단계에서.
- (d) **폴더 지켜보기 중계**: 세션을 열 때 `watch: ['aidlc']` 처럼 경로를 주면 runner 가 그 아래 바뀐 파일(256KB 이하 글, 지움 포함)을 300ms 모아 `files` 로 보내고, `relay.filesOf(S)` · `events.on('files')` 로 읽는다.
- (e) **제안의 종류**: 제안에 `kind: 'opinion' | 'decision'` 과 `option`(고른 항목). 역할자의 결정은 작업자의 입력란에 「<이름> 결정 · <항목>」으로 쌓이고, 보내는 것은 작업자만. 남은 일: 역할자 판정(누가 결정할 수 있는지), 결정을 CLI 의 선택 창에 맞는 키(번호 · 화살표)로 바꾸는 것.
