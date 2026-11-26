# Process GPT Lite 데스크톱 앱 (Electron)

Lite 서버 하나를 창 하나로 여는 데스크톱 앱입니다. Lite 자체(웹 앱·서버·Supabase·deepagents)는 들어 있지 않고, 사용자가 고른 서버의 웹 화면을 그대로 띄웁니다. `android/` 앱과 같은 방식입니다.

- **서버 고르기**: 처음 켜면 서버 주소를 묻습니다. 회사 주소(`https://<회사>.process-gpt.io/lite`) 또는 이 컴퓨터에 설치한 Lite(`http://localhost:18080`)를 넣으면 됩니다. `acme.process-gpt.io`처럼 도메인만 넣으면 `/lite`를 붙여 다시 찾고, 브라우저 주소창에서 복사한 주소(`…/lite/chat`)를 넣으면 앞부분만 씁니다. 저장하기 전에 `<주소>/api/config`의 응답이 Lite에서 온 것인지 확인합니다. 주소는 저장하며, 메뉴의 **서버 바꾸기…**(`Process GPT Lite` 메뉴, Windows는 `파일`)로 바꿀 수 있습니다. 터널 같은 공개 주소에 접근 암호(basic auth)가 걸려 있으면 선택 화면의 「접근 암호」에 넣습니다. 암호는 OS 키체인으로 암호화해 저장합니다(`safeStorage`).
- **로그인**: 서버에 연결한 뒤 해당 서버의 화면에서 로그인합니다(이메일 코드, Google). Google 로그인과 회사 Supabase 로그인 화면은 창 안에서 열리고, 로그인이 끝나면 같은 서버로 돌아옵니다.
- **제목 표시줄**: 별도의 제목 띠가 없습니다. Lite의 하늘 배경이 창 맨 위까지 이어집니다. macOS는 신호등(창 단추)을 위 메뉴 줄 안(20, 27)에 두고, 웹 화면의 위 메뉴는 그 오른쪽부터 시작합니다. Windows·Linux는 오른쪽 위에 투명한 창 단추(`titleBarOverlay`)를 얹습니다. 단추 기호 색은 웹 앱의 밝음/어두움 설정을 따릅니다. 창은 위 메뉴 줄의 빈 곳(위 메뉴가 없는 화면은 맨 위 40px)을 잡고 끕니다.
- **그 밖에**: 하나만 실행됩니다(두 번 켜면 처음 창이 앞으로 옵니다). 창 크기와 위치를 저장합니다. 메뉴는 한국어이고, 웹 앱이 영어면 영어로 바뀝니다. 새로 고침(⌘R), 확대·축소, 전체 화면을 지원하고, 개발자 도구는 개발 실행에서만 켜집니다. 웹 앱의 알림은 시스템 알림으로, Home 카드 수는 Dock · 작업 표시줄 · 트레이 아이콘의 숫자로 보입니다(아래 「트레이 아이콘과 알림 수」). 서버가 응답하지 않으면 연결 실패 화면이 뜹니다. 「다시 시도」를 누르거나 네트워크가 돌아오면 다시 엽니다. 20초마다 서버를 확인하고, 응답이 올 때만 화면을 바꿉니다.

## 설치

내려받기는 세 가지입니다(버전 `0.2.1` 기준).

| 컴퓨터 | 파일 |
|---|---|
| Mac (Apple Silicon: M1 이후) | `Process-GPT-Lite-0.2.1-mac-arm64.dmg` (또는 `.zip`) |
| Mac (Intel) | `Process-GPT-Lite-0.2.1-mac-x64.dmg` (또는 `.zip`) |
| Windows 10 · 11 (64비트) | `Process-GPT-Lite-0.2.1-win-x64-setup.exe` |

Mac 이 어느 쪽인지는 화면 왼쪽 위 Apple(사과) 메뉴 › 이 Mac에 관하여의 「칩」(Apple M…이면 Apple Silicon) 또는 「프로세서」(Intel)에서 봅니다.

**macOS**

1. DMG 를 열고 `Process GPT Lite` 를 「응용 프로그램」으로 끌어 놓습니다.
2. 처음 열면 「"Process GPT Lite"을(를) 열 수 없습니다 … 확인할 수 없습니다」가 뜹니다. Apple 개발자 서명 · 공증을 하지 않은 앱(임시 ad hoc 서명)이라서입니다. 「완료」를 누른 뒤 **시스템 설정 › 개인정보 보호 및 보안**의 맨 아래 「"Process GPT Lite"이(가) 차단되었습니다」 옆 **「그래도 열기」**를 누르고, 다시 묻는 창에서도 「그래도 열기」를 누릅니다(암호나 Touch ID 를 물을 수 있습니다). 한 번만 하면 됩니다.
3. ZIP 을 받았다면 풀어서 나온 앱을 「응용 프로그램」으로 옮긴 뒤 같은 방법으로 엽니다.

**Windows**

1. `…-win-x64-setup.exe` 를 실행합니다. 코드 서명을 하지 않은 설치 파일이라 Microsoft Defender SmartScreen 이 「Windows의 PC 보호」를 띄웁니다. **「추가 정보」**를 누른 뒤 **「실행」**을 누릅니다.
2. 설치는 이 사용자만을 위한 것이라 관리자 권한을 묻지 않습니다(기본 위치 `%LOCALAPPDATA%\Programs\`, 설치 화면에서 바꿀 수 있음). 시작 메뉴와 바탕 화면에 `Process GPT Lite` 가 생깁니다.
3. 지울 때는 설정 › 앱 › 설치된 앱에서 `Process GPT Lite` 를 제거합니다.

**로컬 에이전트(내 컴퓨터의 Claude Code · Codex)를 쓰려면** 그 컴퓨터에 다음이 있어야 합니다.

- `git` — macOS 는 처음 쓸 때 설치를 묻습니다(`xcode-select --install`). Windows 는 [Git for Windows](https://git-scm.com/download/win).
- `claude`(Claude Code) 또는 `codex` 가 설치되어 로그인된 상태. Windows 에서는 npm 으로 깐 `claude.cmd` · `codex.cmd` 와 Claude Code 설치 프로그램의 `claude.exe`(`%USERPROFILE%\.local\bin`) 모두 찾습니다. Claude Code 는 2.1.331 이상을 권합니다(훅을 셸 없이 프로그램과 인자로 넣는 exec form — 이 판에서 확인).

## 개발 실행

```bash
cd desktop
npm install                 # Electron · electron-builder (이 폴더의 node_modules)
npm start                   # 또는 npm run dev (개발자 도구 켬)
```

- 터미널에 `ELECTRON_RUN_AS_NODE=1`이 설정되어 있으면(VS Code 터미널 등) Electron이 Node로 실행되다가 바로 종료됩니다. 이때는 `env -u ELECTRON_RUN_AS_NODE npm start`로 실행합니다.
- 다른 프로필로 띄우려면 `PGL_DESKTOP_USER_DATA=<폴더> npm start`를 씁니다. 설정, 로그인, 창 위치, 중복 실행을 막는 잠금이 모두 해당 폴더를 사용합니다.
- 로컬 Lite에 연결할 때는 개발 서버(`npm run dev`, 기본 `http://localhost:5180`) 또는 설치 번들(`http://localhost:18080`) 주소를 넣습니다.
- 단위 시험: `npm test`(주소 정규화 · 서버 확인 · 주소를 열 위치 · 로컬 에이전트 runner · 시스템별 차이 `test/platform.test.js` · 트레이와 알림 수 `test/badge.test.js`). macOS 와 Windows 에서 돕니다. Windows 에서만 뜻이 있는 시험(cmd.exe · ConPTY · taskkill)은 다른 시스템에서 까닭을 달고 건너뜁니다.

## 묶기

```bash
cd desktop
npm run icon                # build/icon.png ← ../public/favicon.svg, resources/tray/*.png ← build/icon.png (Python Pillow), 바꿀 때만
npm run dist                # (Mac) → release/Process-GPT-Lite-<버전>-mac-arm64.dmg · -mac-x64.dmg (· .zip)
npm run dist:win            # (Windows) → release/Process-GPT-Lite-<버전>-win-x64-setup.exe
npm run smoke -- "release/mac-arm64/Process GPT Lite.app" arm64   # 묶은 앱 확인 (Windows: release/win-unpacked x64)
```

- 결과물은 `release/` 아래에 생성되며 커밋하지 않습니다. 앱 묶음은 `release/mac-arm64/` · `release/mac/`(Intel) · `release/win-unpacked/` 에 있습니다.
- 버전은 `package.json` 의 `version` 입니다(서버의 버전과 따로).
- Developer ID 서명과 공증은 하지 않습니다. 묶은 뒤 임시(ad hoc) 서명을 합니다(`scripts/adhoc-sign.js`). Windows 설치 파일도 코드 서명을 하지 않습니다. 처음 여는 방법은 위 「설치」.
- `scripts/smoke-packaged.js` 는 묶은 앱의 실행 파일로 확인합니다: node-pty 가 그 시스템 · 아키텍처 것으로 풀려 있는지(macOS 는 `lipo` 로 앱 · `pty.node` · `spawn-helper` 아키텍처와 실행 권한), `--pgl-hook` 이 훅 줄을 쓰고 앱은 뜨지 않는지, 앱을 Node 로(`ELECTRON_RUN_AS_NODE`) 띄워 묶인 node-pty 로 터미널을 여는지(Windows 는 ConPTY 에서 `.cmd` 배치 파일에 까다로운 인자를 넘겨 그대로 받는지, 돌고 있는 `cmd.exe` 를 kill 로 끝내는지), 앱이 새 프로필로 첫 창까지 뜨는지.
- **GitHub Actions** `.github/workflows/desktop.yml`: `feat/desktop-release` 에 올리거나 `desktop/**` 를 바꾼 PR, 또는 손으로 실행(workflow_dispatch). macos-latest(Apple Silicon)에서 시험 → arm64 · x64 패키지 → 둘 다 smoke(Intel 은 Rosetta) → DMG 검사, windows-latest 에서 시험 → NSIS 설치 파일 → smoke → 조용히 설치(`/S`)한 사본도 smoke. 결과물은 그 실행의 artifact(`Process-GPT-Lite-mac-arm64` · `-mac-x64` · `-win-x64`)로만 남고, 릴리스는 만들지 않습니다.
- Linux(AppImage) 설정은 `electron-builder.yml` 에 있지만 빌드하거나 시험하지 않았습니다.

## 구조

| 파일 | 하는 일 |
|---|---|
| `src/main.js` | 창(제목 표시줄 · 신호등 자리 · 창 위치 기억), 이동 제한, 권한(알림 · 마이크 · 클립보드), 내려받기, 화면 공유, 메뉴 연결, 로컬 화면 IPC |
| `src/policy.js` | 주소별로 창 안(서버 출처 · 로그인 출처)이나 바깥(시스템 브라우저 · 메일)에서 열지, 차단할지 결정 |
| `src/server.js` | 주소 정규화와 `/api/config` 확인 |
| `src/settings.js` | `<userData>/desktop-settings.json` (서버 · 최근 기록 · 로그인 출처 · 접근 암호 · 창 · 언어 · 테마) |
| `src/menu.js` | 한국어 · 영어 앱 메뉴 |
| `src/tray.js` · `src/badge.js` | 트레이 아이콘과 Home 카드 수(Dock · 작업 표시줄 · 트레이), 배지 그림 — `resources/tray/` |
| `src/preload.js` | 페이지 표시(`html.pgl-desktop`, `--pgl-tb-left/right`), 테마 알림, `window.pglDesktop`(읽기 전용 · 알림 수 `setBadge` · `onOpenHome`), 로컬 화면에만 `window.pglLocal` |
| `src/pages/` | 서버 고르기 · 연결 실패 화면 (웹 앱과 같은 하늘 배경) |
| `src/browser/` | 이 PC 의 브라우저(0.2.3): 서버의 브라우저 에이전트가 링크로 움직인다 — `host.js`(숨은 창 · 탭 · 스크린캐스트 · 동작), `cdp.js`(`webContents.debugger` 위의 프레임 · 페이지 문맥 · 다른 사이트 iframe), `protocol.js`(이름 붙은 동작 · 그 사람만 · 조각), `pageScripts.js`(페이지 안에서 도는 서버와 같은 읽기 스크립트 · 가리기) |
| `src/runner/` | 로컬 에이전트: 이 컴퓨터의 Claude Code · Codex 로 그 사람의 프로세스 단계를 돌린다 — `link.js`(서버로 나가는 WebSocket), `session.js`(그 사람의 대화형 CLI 를 PTY 에서 — 훅 · 기록 · 지켜보는 파일), `pty.js`(node-pty), `clis.js`(CLI 찾기 · 헤드리스 고정 명령 · 출력 읽기), `git.js`(작업 폴더 맞추기 · 커밋 · 올리기), `runner.js`(일 하나 · 입력 · 보고함 · 중계되는 세션 · 다시 켜졌을 때 이어서), `sync.js`(0.2.5 챔피언 폴더 — 고른 폴더의 그림자 저장소 · 훑기 · 비밀 검사 · 올리기, 규칙은 `secret-shapes.json` · `kit-places.json`), `index.js` |

웹 앱 쪽에서 바뀐 곳은 다음과 같습니다. 화면에 관한 것은 모두 `html.pgl-desktop` 아래에서만 동작해서 브라우저에서는 아무것도 바뀌지 않습니다.

- `src/styles/desktop.css`: 창을 끌 수 있는 영역, 위 메뉴가 창 단추와 겹치지 않도록 하는 여백, 로그인 화면과 설정 ✕ 위치.
- `src/main.js`: 위 CSS를 가져옵니다. 카드를 닫을 때 · 로그아웃할 때도 알림 수를 보내고, 트레이의 「알림 N개 — 열기」(`pglDesktop.onOpenHome`)에 Home 을 엽니다.
- `src/browserNotify.js`: 데스크톱 앱에서는 푸시를 구독하지 않습니다. 알림도 서비스 워커가 아니라 `new Notification`으로 띄웁니다(Electron은 서비스 워커 알림을 보여 주지 않습니다). Home 카드 수는 `src/appBadge.js` 가 다리(`pglDesktop.setBadge`)로 보냅니다.

## 로컬 에이전트 (내 컴퓨터의 Claude Code · Codex)

회사 프로세스 지도의 활동에 「Claude Code — 담당자의 컴퓨터」 같은 에이전트를 정하면, 그 단계가 담당자에게 올 때 담당자의 이 앱이 그 컴퓨터의 CLI 로 단계를 돌린다(설계 `docs/local-agents/design.md`, 스펙 `openspec/specs/local-agents`).

- **잇기**: 앱 안에서 로그인하면 페이지가 서버에서 이 컴퓨터용 기기 토큰을 받아 preload 다리(`pglDesktop.localRunner.pair`)로 main 에 넘긴다. main 은 페이지의 쿠키 · 저장소를 읽지 않는다. 토큰은 OS 키체인으로 암호화해 `desktop-settings.json` 의 `runner` 에 둔다. main 은 서버로 나가는 WebSocket 하나(`<서버>/api/local-agents/link`)를 열고, 이 컴퓨터의 CLI(설치 · 버전 · 로그인 여부)를 알린다. 이 컴퓨터에는 포트를 열지 않는다.
- **일**: `<userData>/local-agents/work/` 아래 인스턴스마다 작업 폴더(git clone)를 두고, 서버의 인스턴스 라인을 받아(실행 직전에 한 번 더) `pgpt-agent/local-…` 가지에서 CLI 를 돌린 뒤 커밋해 올린다. 폴더 토큰은 git 요청 머리글로만 쓴다. 끝난 보고는 서버가 받을 때까지 `<userData>/local-agents/outbox.json` 에 둔다.
- **실행 — 그 사람의 터미널 그대로**: 단계는 그 사람의 대화형 `claude` · `codex` 를 node-pty 로 띄워 돈다(agent-share 방식 — 그 사람의 로그인 · 설정 · 슬래시 명령 그대로). Claude Code 에는 세션마다의 `--settings` 로 훅(`SessionStart` · `UserPromptSubmit` · `Stop` · `StopFailure` · `Notification`)만 넣어, 준비되면 프롬프트를 붙여 넣고 `Stop` 으로 턴의 끝을 안다. Codex 는 명령줄의 첫 메시지(프롬프트 파일을 가리킴)와 rollout 으로. 앱이 만든 작업 폴더만 Claude Code 에서 신뢰한 폴더로 둔다(`~/.claude.json` 의 `projects[<폴더>].hasTrustDialogAccepted`). 그 터미널의 바이트는 링크로 서버에 가서 인스턴스를 볼 수 있는 모든 사람의 실행 카드에 같은 화면으로 보인다(작업자 아닌 사람은 읽기 전용). 앱이 실행 중에 꺼졌다 켜지면 같은 세션을 `--resume` 으로 잇는다. node-pty 를 불러오지 못하면 헤드리스(`claude -p` · `codex exec`)로 돈다(`PGL_RUNNER_MODE=headless` 로 강제).
- **node-pty**: 1.1.0(N-API 미리 빌드 — Node 와 Electron 에서 같은 바이너리, mac arm64/x64 · Windows x64/arm64 ConPTY). `npm install` 뒤 `scripts/pty-helper.js` 가 mac `spawn-helper` 에 실행 권한을 준다. electron-builder 는 `asarUnpack`, `npmRebuild: false`(`electron-builder.yml`). 묶은 앱의 Windows 는 node-pty 를 `app.asar.unpacked` 에서 바로 불러온다(`src/runner/pty.js` — ConPTY 쪽의 워커 스크립트와 콘솔 프로세스 목록 도우미가 실제 파일이어야 한다). macOS 는 asar 를 거쳐 부르고 node-pty 가 `spawn-helper` 경로를 스스로 `app.asar.unpacked` 로 바꾼다(풀린 경로에서 부르면 `app.asar.unpacked.unpacked` 가 되어 `posix_spawnp failed`).
- **훅**: 세션의 `--settings` 에 넣는 훅은 Claude Code 의 exec form(`command` + `args`, 셸 없음)이다. 데스크톱 앱에서는 앱 자신의 실행 파일이 그 node 다: `<앱> --pgl-hook <Event> <파일>` 을 `main.js` 가 앱이 뜨기 전에 받아 `src/runner/hook.js` 로 한 줄 적고 끝낸다(창 · 단일 실행 잠금 없음 — 실행 중인 앱은 모른다, 한 번에 약 0.15초). Node 로 돌 때(시험)는 `node src/runner/hook.js <Event> <파일>`. sh · cat · printf 에 기대지 않아 Windows 에서도 같고, 빈칸 · 역슬래시 · 따옴표 · `$` 가 든 경로도 그대로다.
- **Windows**: npm 의 `claude.cmd` · `codex.cmd` 는 배치 파일이라 `cmd.exe /d /s /c "…"` 로 띄운다. 인자는 cross-spawn 방식으로 따옴표로 감싸고 cmd 의 특수 문자를 `^` 로 두 번 막는다(배치 파일의 `%*` 를 cmd 가 한 번 더 읽기 때문). 설치 프로그램의 `claude.exe` 는 바로 띄운다(한 폴더에 둘 다 있으면 PATHEXT 순서로 `.exe`). 멈출 때는 `taskkill /T /F` 로 CLI 와 그것이 띄운 프로세스까지 끝낸다(Windows 에는 SIGINT 가 없어 헤드리스 Codex 의 조종도 이어서 실행으로 간다). Claude Code 설정의 폴더 신뢰는 그 프로그램처럼 `C:/…`(앞으로 빗금)로 적는다. 작업 폴더의 git 은 `core.autocrlf=false`(서버의 폴더와 바이트까지 같게 — Git for Windows 기본값 `true` 를 따르지 않음) · `core.longpaths=true`, git 은 PATH 다음 `C:\Program Files\Git\cmd` 에서도 찾고 없으면 설치하라고 알린다.
- **입력**: 작업자의 입력(실행 카드의 입력란 · 고른 제안 · 인스턴스 대화)은 터미널에 붙여 넣기 + Enter 로, 작업자가 터미널에 직접 친 글은 그대로 들어간다(Claude Code · Codex 모두 멈추지 않음). 다른 사람의 입력은 서버가 막고 runner 도 받지 않는다. 다른 사람의 제안이 오거나 CLI 가 사람을 기다리면(권한 확인) 시스템 알림.
- **설정**(웹 화면 설정 › 계정 › 「내 컴퓨터의 에이전트」): 이 컴퓨터에서 단계 실행 켬 · 끔, 실행 전에 묻기(시스템 창), 연결 해제. 로그아웃하면 이 컴퓨터의 토큰을 끊는다.
- 실행 중이면 화면 오른쪽 아래 「로컬 에이전트 실행 중 · Claude Code」, macOS Dock 배지 ●(Home 카드 수가 0일 때 — 수가 있으면 수).
- 개발용 환경변수: `PGL_RUNNER_PATH`(CLI 를 먼저 찾을 폴더 — 시험의 가짜 CLI), `PGL_RUNNER_LOG=1`(runner 기록을 콘솔에), `PGL_RUNNER_ASK=yes|no`(묻는 창 대신), `PGL_RUNNER_DEVICE_NAME`(기기 이름), `PGL_RUNNER_MODE=headless`, `PGL_RUNNER_SETTLE_MS`(턴이 끝나고 단계를 끝낼 때까지, 기본 3000).
- 시험: `npm test`(runner — 터미널은 가짜 대화형 CLI `test/fixtures/fake-tui.js`, 헤드리스는 `fake-cli.js`), `cd e2e && npx playwright test --project=desktop tests/desktop/local-agents.spec.js`(Electron 두 개). 시험은 CLI 의 설정 폴더를 임시로 준다(`CLAUDE_CONFIG_DIR` · `CODEX_HOME`).

## 이 PC 의 브라우저 (0.2.3 — 브라우저 작업은 내 PC에서)

사람의 브라우저 작업(채팅에서 「…사이트에 들어가서 …」)이 이 앱이 켜져 있으면 이 PC 의 브라우저에서 돈다. 서버의 에이전트(모델 · 판정 · 보관함 · 카드)는 그대로, 페이지만 이 PC 에서(설계 `docs/local-agents/browser.md`, 스펙 `openspec/specs/browser-handoff`).

- **브라우저**: Electron 의 숨은 창(탭마다 하나)을 `webContents.debugger`(CDP)로 움직인다. 포트를 열지 않고, 따로 설치할 브라우저가 없다. 세션은 사람마다 `persist:pgl-browser-<사람 id>` — 여기서 한 로그인은 이 PC 에 남아 다음에도 쓰이고 앱 창(Lite)과 섞이지 않는다.
- **이 PC 의 설정**: 설정 › 계정 › 내 컴퓨터의 에이전트의 「브라우저 작업은 이 PC에서」 — 「내가 시킨 작업만」(기본) · 「단계 · 예약 작업까지 모두」 · 「쓰지 않음」. 실행 설정(`runnerPrefs.browser`)과 함께 이 PC 에 저장하고 링크의 `prefs.browser` 로 알린다(서버에는 저장하지 않는다, 웹 · 휴대폰은 읽기만). 「이 컴퓨터에서 단계 실행」을 끄면 브라우저 작업도 오지 않는다. 사람이 없는 작업(「모두」일 때만)은 이 PC 의 내부망(localhost · 10/8 · 192.168/16 · 한 단어 이름 · .local · .lan · IPv6 안의 IPv4 …, 이 PC 에서 그런 주소로 풀리는 이름)을 열지 않는다 — 그 작업이 쥔 동안 세션의 모든 요청을 먼저 본다(`session.webRequest`).
- **링크**: 로컬 에이전트와 같은 WebSocket 하나로 이름 붙은 동작을 받는다(`src/browser/protocol.js` OPS). 서버가 보낸 코드는 돌리지 않는다. 그 앱에 로그인한 사람의 브라우저만 연다. hello 의 `caps.browser: true` 가 0.2.3 의 표시다. 900KB 넘는 메시지는 바이트로 재어 조각으로 보내고, 받는 조각에는 끝이 있다(한 번에 둘 · 72MB).
- **보이기**: 창은 숨어 있다. 카드의 「이 PC에서 보기」를 누르면 그 탭의 창이 이 PC 에 보이고, 사람이 그 창에서 직접 할 수 있다. 닫으면 다시 숨는다(첫 탭). 숨은 창은 Windows · Linux 에서 앱을 붙잡지 않는다.
- **그림**: 실시간 화면과 모델의 그림은 모두 스크린캐스트에서 얻는다 — 숨은 창을 `capturePage` · `captureScreenshot` 으로 찍으면 그 뒤 창이 그리지 않는다(스크롤이 1.2초씩 기다림, 실측). 서버가 움직이는 동안 앱을 재우지 않는다(macOS App Nap — `powerSaveBlocker`).
- **비밀**: 보관함 값은 그 칸에 넣을 때 한 번 오고, 칸을 먼저 가린 뒤 넣는다. 저장 · 로그 없음(`PGL_BROWSER_TRACE=1` 도 동작 이름과 시간만). 읽기 · 낱말 · 실시간 화면 · 모델의 그림의 가리기는 이 PC 에서 한다. 이 PC 에서 친 로그인은 보관함으로 보내지 않는다.
- **작업 사이**: 작업이 쥔 동안(`begin` ~ `idle`)만 실시간 화면 · 받은 파일을 서버로 보낸다. 작업이 끝나면 페이지를 `about:blank` 로 비운다 — 창을 보고 있거나 작업이 사람이 필요한 채로 끝나면(`idle keep`, 카드의 「이 PC에서 보기」) 그대로. 그 사이 보이는 창에서 사람이 받는 파일은 이 PC 의 다운로드 폴더로, 보이지 않을 때 받는 파일은 지운다. 링크가 끊기면 쥔 상태를 놓는다(페이지는 둔다). 보였다가 숨은 창은 같은 주소의 새 숨은 탭으로 바뀐다(Electron 에서 숨은 뒤 새 페이지를 그리지 않았다). 숨은 창은 소리를 내지 않고, 사람 동작 없이는 자동 재생하지 않는다.
- **제한**: 웹 주소(http · https · about:blank)만 연다 — 이 PC 의 파일(`file:`)은 열지 않는다. 사이트에 카메라 · 마이크 · 화면 · 위치 · 알림 · 클립보드 읽기를 주지 않는다. 받은 파일은 임시 폴더에 받아 서버로 보내고 지운다(50MB 까지 — 크기를 말하지 않으면 받는 동안 센다). 페이지의 alert · confirm · prompt 는 상자 없이 넘기거나 취소하고 그 말을 다음 읽기에 붙인다. 이 PC 의 클립보드는 붙여 넣지 않는다(⌘V · Ctrl+V 거절). 보이는 창의 제목은 페이지의 출처부터, 전체 화면은 막는다. 한 작업에 새 창 10개 · 한 번에 탭 8개. 앱의 기본 인증 답(`app.on('login')`)은 이 브라우저의 세션에 답하지 않는다.
- 개발용 환경변수: `PGL_DESKTOP_BROWSER=0`(브라우저 없이 — 0.2.2 처럼), `PGL_BROWSER_TRACE=1`(동작마다 걸린 시간), `PGL_BROWSER_MAX_DOWNLOAD`(받는 파일의 끝, 바이트 — 시험용), `PGL_TEST_BROWSER_PREF`(시험 호스트가 알리는 이 PC 의 설정).
- 시험: `npm test`(`test/browser.test.js` — 동작 · 사람 · 조각(바이트 · 끝) · 로그 · begin/idle · 내부 주소 · 기본 인증 · 이 PC 의 설정 · 닫으면 세션을 놓음), 서버 쪽 `server/test/browserDriver.test.js` · `browser-local.test.js`(이 앱의 코드를 Electron 으로 띄워 붙인다 — `test/helpers/browser-host.js`), `cd e2e && npx playwright test --project=desktop tests/desktop/local-browser.spec.js`(진짜 앱).

## 트레이 아이콘과 알림 수 (0.2.4)

앱이 시작되면 트레이 아이콘을 하나 표시하고, 운영체제의 숫자 표시 영역에 Home 카드 수를 표시합니다(스펙 `openspec/specs/desktop-app` 「트레이 아이콘과 알림 수」).

| 시스템 | 보이는 곳 |
|---|---|
| macOS | Dock 숫자(`app.setBadgeCount`), 메뉴 막대의 템플릿 이미지 옆 숫자(` 3`). 수가 0이고 로컬 에이전트가 실행 중이면 Dock에 ● 표시 |
| Windows | 작업 표시줄 버튼의 빨간 오버레이(설명 「알림 3개」), 트레이 아이콘의 빨간 배지(1~9, 9+) |
| Linux | 런처 숫자(Unity일 때만), 트레이 아이콘의 빨간 배지. 앱 표시기는 클릭을 전달하지 않으므로 메뉴의 「열기」 사용 |

- **흐름**: 웹 앱 `src/browserNotify.js`의 `setBadge`(Home 카드를 불러올 때 · 카드를 닫을 때 · 로그아웃) → preload `pglDesktop.setBadge` → main `pgl:badge`(서버 화면에서 온 값만, 0~9999 정수) → `src/tray.js`. 데스크톱 앱에서는 `navigator.setAppBadge`를 호출하지 않습니다. Windows에서는 Electron이 해당 배지를 작업 표시줄에 별도로 그려 두 배지가 충돌하기 때문입니다.
- **트레이**: 누르면 창이 표시되고 앞으로 나옵니다(macOS는 창이 없으면 새로 엶). 메뉴는 「열기」 · 「알림 N개 — 열기」(채팅으로 이동해 Home을 엶 — 페이지의 `pglDesktop.onOpenHome`) · 「종료」이며, 웹 앱이 영어이면 메뉴도 영어로 표시합니다. 창을 닫을 때의 동작은 바꾸지 않았습니다(Windows · Linux는 종료되며 트레이도 사라지고, macOS는 남음).
- **그림**: `resources/tray/tray.png` · `tray@2x.png`(Windows · Linux, 앱 아이콘 16 · 32px), `trayTemplate.png` · `@2x`(macOS 템플릿 — 몸통에서 종이비행기를 뺀 검정 이미지). `npm run icon`이 `build/icon.png`에서 다시 생성합니다(`scripts/make-tray.py`). 배지는 실행 중에 `src/badge.js`가 비트맵(`nativeImage.toBitmap` · `createFromBitmap`)에 그립니다. 새 네이티브 모듈과 숨겨진 창은 없습니다.
- 시험: `npm test`의 `test/badge.test.js`(Electron 없이, 가짜 Electron으로 세 시스템), e2e D-12 · D-13. 아직 실제 Windows · Linux에서 확인하지 않았습니다.

## 내 PC 폴더 올리기 — 챔피언 폴더 (0.2.5)

에이전트를 잘 쓰는 사람이 자기 PC 에서 쓰던 폴더(스킬 · 명령 · 지침 · 스펙이 든 폴더)를 골라 Lite 의 관리형 공유 폴더로 올린다(스펙 `openspec/specs/champion-folders`). 웹 앱의 폴더 목록 「내 PC 폴더 올리기」가 `pglDesktop.folders` 로 부른다.

- **고르기**: 운영체제의 폴더 고르기 창(`dialog.showOpenDialog`)에서만. 페이지는 경로를 보내지도 받지도 않는다 — 고른 폴더의 id(`pickId`) · 이름 · 미리 보기만 받는다. 디스크 전체 · 홈 폴더 · 앱 데이터를 품은 폴더는 고를 수 없다.
- **미리 보기**: 올라갈 파일 수 · 크기 · 위 단계 묶음, 뺀 것과 까닭(폴더의 `.gitignore` · 비밀 · 개인 설정 · 다시 만들 수 있는 것 · 50MB 넘는 파일 · 구조 — 안의 다른 git 저장소, 모든 링크(폴더 안을 가리켜도), git 의 제어 파일 `.gitmodules` · `.lfsconfig`: 보통 파일만 올라가고 링크 · 하위 저장소 항목은 올라가지 않는다), 확인이 필요한 파일(1MB 이하 글 파일에서 열쇠 생김새를 찾음 — 파일 · 줄 · 까닭 코드만, 값은 화면 · 로그 · 서버 어디에도 없음, 기본은 빼고 올림), 찾은 에이전트 자산(Claude Code · Codex · Cursor · Gemini · Copilot · 스펙). 이름 · 경로 규칙과 열쇠 생김새는 `src/runner/secret-shapes.json`, 자산 자리는 `src/runner/kit-places.json` — 서버 `server/lib/folders/` 의 같은 파일의 사본이다(`test/sync.test.js` 가 같은지 본다). 폴더의 `.gitignore` 가 `!.env` 라고 해도 앱의 제외가 먼저다. 사람이 미리 보기에서 다시 넣을 수 있는 것(`include`)은 `.gitignore` · 개인 설정 · 다시 만들 수 있는 것 · 큰 파일, 그리고 걸린 것이 모두 `check` 수준인 확인 파일뿐이다 — 비밀(이름 · 그런 폴더 · 다시 넣은 폴더 안의 것), 확실한 열쇠 모양(`block`), 구조 항목은 페이지가 무엇을 보내든 데스크톱이 넣지 않는다. 파일 수와 크기가 서버의 한도(`limits` — 한 번의 push · 스냅숏 전체의 파일 수 · 크기)를 넘으면 미리 보기가 알리고(`too_big` · `too_many`) 올리지 않는다.
- **동의**: 첫 올리기 전에 시스템 창이 한 번 더 묻는다 — 「파일 N개(X MB)를 <서버> 의 폴더 '<이름>'(으)로 올립니다」, 확인 파일을 함께 넣었으면 「— 확인이 필요한 파일 M개도 함께 올라가요」(경고 창). 페이지의 단추만으로는 올라가지 않는다. 말은 `sync.js` 의 `uploadQuestion`.
- **그림자 저장소**: `<userData>/local-agents/sync/<서버10>/u-<사람12>/<폴더 id>.git`(bare — 사람마다 따로: 한 PC 의 두 사람은 서로의 것을 쓰거나 지우지 않는다) 에 색인과 스냅숏을 두고, 고른 폴더는 부를 때마다 작업 트리로만 이름 붙인다. 고른 폴더에는 아무것도 만들지 않고(`.git` · 파일 없음), 그 사람의 `.git`(이력 · 원격 · 설정)은 열지 않는다 — 지난 이력이 아니라 지금 상태의 스냅숏이 올라간다. 이 모듈이 부르는 git 은 정해진 목록(`init` · `ls-files` · `check-ignore` · `update-index` · `write-tree` · `commit-tree` · `update-ref` · `rev-parse` · `fetch` · `push`)뿐이고 어느 것도 작업 트리에 쓰지 않는다 — `reset` · `clean` · `checkout` 은 코드에 없다(시험이 고정). 훅 · 서명 · fsmonitor · 그 사람의 전역 제외 · LFS 같은 필터는 끈다(`info/attributes` 의 `* -text -filter -ident -working-tree-encoding`: 바이트 그대로 — 일 폴더 클론도 같은 줄). 스냅숏 직전에 링크(120000) · 하위 저장소(160000) 항목이 색인에 생겼으면(훑은 뒤 바뀐 파일) 빼고 커밋한다.
- **올리기 한 바퀴**: 훑기 → 링크로 동기화 토큰(`sync:token`, 1시간 — git 요청 머리글로만) → 서버 main 과 이 기기의 가지 받기 → 스냅숏 커밋(작성자 = 그 사람, 메시지 「동기화」 — 컴퓨터 이름은 넣지 않는다, 부모 = 이 기기 가지의 끝, 처음엔 서버 main) → `pgpt-agent/sync-<기기8>/main` 에 push → `sync:pushed`(수만) → 서버가 main 으로 앞감기 · 병합(`sync:taken`) 또는 그대로(`sync:behind`) 또는 거절(`sync:refused` — 까닭 · 파일). 바뀐 것이 없으면 올리지 않는다. 0.2.5 는 「지금 올리기」로만 올리고 받기는 없다(서버에서 바뀐 것이 이 PC 의 폴더에 들어오지 않음).
- **등록부**: `desktop-settings.json` 의 `folders[<서버>]` — 사람별(다른 사람이 이 앱에 로그인하면 앞 사람의 폴더는 멈추고, 로그아웃하면 멈춤). 고른 폴더의 경로는 여기에만 있다. 「연결 끊기」는 그림자 저장소와 이 기록만 지운다(고른 폴더 · 서버 폴더는 그대로). 「폴더 열기」는 Finder · 탐색기에서 연다.
- 상태: `synced`(올려 둠) · `pushing` · `behind`(서버 main 이 앞서 이번 것을 넣지 못함) · `paused`(웹에서 멈춤) · `blocked`(까닭 — `secret` · `not_editor` · `source_removed` · `too_big` · `failed` …) · `missing`(폴더를 찾을 수 없음).
- **일 폴더 클론(로컬 단계 · 채팅, `git.js`)도 같은 원칙**: 폴더 토큰은 그 폴더의 주소로만(`http.<주소>.extraHeader` — `.lfsconfig` 의 `lfs.url` 같은 다른 주소에는 가지 않음), 폴더의 링크는 링크의 글이 든 보통 파일로(`core.symlinks=false`), `info/attributes` 의 같은 줄로 필터 · 줄 끝 바꾸기 끔(앞선 판이 만든 클론도 다음 맞추기에서). 시험 `test/git.test.js`.
- 시험: `npm test` 의 `test/sync.test.js`(가짜 링크 + 진짜 git 서버, 고른 폴더의 파일 · 시각 · 그 사람의 `.git` 이 바이트까지 그대로인지, 넣을 수 없는 것, 한 PC 의 두 사람), `cd e2e && npx playwright test --project=desktop tests/desktop/champion.spec.js`(진짜 앱 · 서버). 시험에서는 묶지 않은 앱에서만 main 의 `global.__pglTestFolders = {pick, confirm}` 이 두 시스템 창을 대신한다(묶은 앱은 읽지 않음).

## 보안

- `contextIsolation`, `sandbox`를 켜고 `nodeIntegration`은 끕니다. `<webview>`를 쓰지 않고 remote 모듈도 없습니다. preload는 읽기 전용 정보와 로컬 화면 버튼만 제공합니다. 로컬 화면의 IPC는 요청을 보낸 곳이 `src/pages/`인지 확인합니다.
- 창 안에서 열리는 곳은 고른 서버의 출처(ProcessGPT와 같은 출처 포함)와 로그인 출처뿐입니다. 로그인 출처는 서버 `/api/config`의 Supabase 주소와 Google 계정 화면입니다. 그 밖의 웹 주소와 메일 링크(`mailto:`)는 시스템 브라우저나 메일 앱으로 넘기고, 다른 스킴(`file:` 등)은 막습니다. 같은 서버의 새 창(원본 받기, 문서 링크)은 preload가 없는 일반 창으로 엽니다.
- 권한(알림 · 마이크 · 카메라 · 클립보드 · 전체 화면)은 서버 출처에만 줍니다.
- 사용자 에이전트에서 `Electron/…`을 뺐습니다. Google이 내장 브라우저 이름을 보고 로그인을 막기 때문입니다.

## 시험

`e2e/tests/desktop/desktop.spec.js`(D-01~D-13)에서 Playwright `_electron`으로 앱을 띄워 확인합니다. 스펙과 사진은 `openspec/specs/desktop-app`에 있습니다.

```bash
cd e2e && PGPT_URL=http://localhost:5180 API_URL=http://127.0.0.1:8787 npx playwright test --project=desktop
# 묶은 앱으로:
PGL_DESKTOP_EXE="../desktop/release/mac-arm64/Process GPT Lite.app/Contents/MacOS/Process GPT Lite" npx playwright test --project=desktop
```

## 남은 일

- Developer ID 서명 · 공증, Windows 코드 서명, 자동 업데이트, Linux 빌드와 시험.
- 트레이 아이콘 · 작업 표시줄 오버레이를 실제 Windows · Linux 에서 보는 일(지금은 가짜 Electron 의 단위 시험과 macOS 실행만).
- Windows 에서 실제 Claude Code · Codex 로 단계를 끝까지 돌려 보는 일(로그인한 사람이 필요하다 — CI 는 가짜 CLI 와 ConPTY 까지). 특히 ConPTY 가 붙여 넣기(bracketed paste) 표시를 대화형 CLI 에 그대로 넘기는지.
- Google이 내장 창의 로그인을 다시 막으면 다른 방법이 필요합니다. 시스템 브라우저에서 로그인하고 `processgptlite://` 같은 주소로 돌아오는 방식이며, Supabase 「Redirect URLs」에 그 주소를 추가해야 합니다.
- 웹 푸시는 앱이 꺼져 있을 때 오지 않습니다(Electron에는 푸시 서비스가 없습니다). 알림은 앱이 켜져 있고 창이 뒤에 있을 때만 옵니다.
- **(2단계 · 할 일) 남의 폴더에 든 실행 설정**: 동료의 챔피언 폴더를 받아 그 안에서 일할 때(로컬 단계 · 채팅의 `claude -p` · 대화형 CLI), 폴더의 `.claude/settings.json` 훅 · 허용 목록과 `.mcp.json` 의 MCP 서버가 그 사람의 컴퓨터에서 돈다. 설계 §7.4 대로 그 PC 의 사람이 처음 한 번 확인(`pro_folder_trust` — 자산의 sha 가 바뀌면 다시)하기 전에는 실행을 시작하지 않게 해야 한다(지금은 확인 없이 돈다 — 2단계 「써 보기」 전에 막을 것).
- 챔피언 폴더 1단계 이후(0.2.5 는 「지금 올리기」뿐): 바뀌면 저절로 올리기(폴더 지켜보기 · 쉬었다가), 서버에서 바뀐 것 받기(겹친 파일 고르기 · 휴지통 · 되돌리기), 오프라인 동안 쌓기, 둘째 PC, 이미 있는 폴더에 합류, 트레이의 폴더 상태. 큰 폴더에서 바퀴마다 모든 파일을 다시 읽지 않게(지금은 색인의 시각 정보를 쓰는 `update-index` 에 맡김) 그리고 Windows 실기에서 확인.
