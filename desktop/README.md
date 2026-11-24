# Process GPT Lite 데스크톱 앱 (Electron)

Lite 서버 하나를 창 하나로 여는 데스크톱 앱입니다. Lite 자체(웹 앱·서버·Supabase·deepagents)는 들어 있지 않고, 사용자가 고른 서버의 웹 화면을 그대로 띄웁니다. `android/` 앱과 같은 방식입니다.

- **서버 고르기**: 처음 켜면 서버 주소를 묻습니다. 회사 주소(`https://<회사>.process-gpt.io/lite`) 또는 이 컴퓨터에 설치한 Lite(`http://localhost:18080`)를 넣으면 됩니다. `acme.process-gpt.io`처럼 도메인만 넣으면 `/lite`를 붙여 다시 찾고, 브라우저 주소창에서 복사한 주소(`…/lite/chat`)를 넣으면 앞부분만 씁니다. 저장하기 전에 `<주소>/api/config`의 응답이 Lite에서 온 것인지 확인합니다. 주소는 저장하며, 메뉴의 **서버 바꾸기…**(`Process GPT Lite` 메뉴, Windows는 `파일`)로 바꿀 수 있습니다. 터널 같은 공개 주소에 접근 암호(basic auth)가 걸려 있으면 선택 화면의 「접근 암호」에 넣습니다. 암호는 OS 키체인으로 암호화해 저장합니다(`safeStorage`).
- **로그인**: 서버에 연결한 뒤 해당 서버의 화면에서 로그인합니다(이메일 코드, Google). Google 로그인과 회사 Supabase 로그인 화면은 창 안에서 열리고, 로그인이 끝나면 같은 서버로 돌아옵니다.
- **제목 표시줄**: 별도의 제목 띠가 없습니다. Lite의 하늘 배경이 창 맨 위까지 이어집니다. macOS는 신호등(창 단추)을 위 메뉴 줄 안(20, 27)에 두고, 웹 화면의 위 메뉴는 그 오른쪽부터 시작합니다. Windows·Linux는 오른쪽 위에 투명한 창 단추(`titleBarOverlay`)를 얹습니다. 단추 기호 색은 웹 앱의 밝음/어두움 설정을 따릅니다. 창은 위 메뉴 줄의 빈 곳(위 메뉴가 없는 화면은 맨 위 40px)을 잡고 끕니다.
- **그 밖에**: 하나만 실행됩니다(두 번 켜면 처음 창이 앞으로 옵니다). 창 크기와 위치를 저장합니다. 메뉴는 한국어이고, 웹 앱이 영어면 영어로 바뀝니다. 새로 고침(⌘R), 확대·축소, 전체 화면을 지원하고, 개발자 도구는 개발 실행에서만 켜집니다. 웹 앱의 알림은 시스템 알림으로, Home 카드 수는 Dock 아이콘 숫자로 보입니다. 서버가 응답하지 않으면 연결 실패 화면이 뜹니다. 「다시 시도」를 누르거나 네트워크가 돌아오면 다시 엽니다. 20초마다 서버를 확인하고, 응답이 올 때만 화면을 바꿉니다.

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
- 단위 시험: `npm test`(주소 정규화 · 서버 확인 · 주소를 열 위치 · 로컬 에이전트 runner · 시스템별 차이 `test/platform.test.js`). macOS 와 Windows 에서 돕니다. Windows 에서만 뜻이 있는 시험(cmd.exe · ConPTY · taskkill)은 다른 시스템에서 까닭을 달고 건너뜁니다.

## 묶기

```bash
cd desktop
npm run icon                # build/icon.png ← ../public/favicon.svg (Python Pillow), 바꿀 때만
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
| `src/preload.js` | 페이지 표시(`html.pgl-desktop`, `--pgl-tb-left/right`), 테마 알림, `window.pglDesktop`(읽기 전용), 로컬 화면에만 `window.pglLocal` |
| `src/pages/` | 서버 고르기 · 연결 실패 화면 (웹 앱과 같은 하늘 배경) |
| `src/runner/` | 로컬 에이전트: 이 컴퓨터의 Claude Code · Codex 로 그 사람의 프로세스 단계를 돌린다 — `link.js`(서버로 나가는 WebSocket), `session.js`(그 사람의 대화형 CLI 를 PTY 에서 — 훅 · 기록 · 지켜보는 파일), `pty.js`(node-pty), `clis.js`(CLI 찾기 · 헤드리스 고정 명령 · 출력 읽기), `git.js`(작업 폴더 맞추기 · 커밋 · 올리기), `runner.js`(일 하나 · 입력 · 보고함 · 중계되는 세션 · 다시 켜졌을 때 이어서), `index.js` |

웹 앱 쪽에서 바뀐 곳은 세 군데입니다. 모두 `html.pgl-desktop` 아래에서만 동작해서 브라우저에서는 아무것도 바뀌지 않습니다.

- `src/styles/desktop.css`: 창을 끌 수 있는 영역, 위 메뉴가 창 단추와 겹치지 않도록 하는 여백, 로그인 화면과 설정 ✕ 위치.
- `src/main.js`: 위 CSS를 가져옵니다.
- `src/browserNotify.js`: 데스크톱 앱에서는 푸시를 구독하지 않습니다. 알림도 서비스 워커가 아니라 `new Notification`으로 띄웁니다(Electron은 서비스 워커 알림을 보여 주지 않습니다).

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
- 실행 중이면 화면 오른쪽 아래 「로컬 에이전트 실행 중 · Claude Code」, macOS Dock 배지 ●.
- 개발용 환경변수: `PGL_RUNNER_PATH`(CLI 를 먼저 찾을 폴더 — 시험의 가짜 CLI), `PGL_RUNNER_LOG=1`(runner 기록을 콘솔에), `PGL_RUNNER_ASK=yes|no`(묻는 창 대신), `PGL_RUNNER_DEVICE_NAME`(기기 이름), `PGL_RUNNER_MODE=headless`, `PGL_RUNNER_SETTLE_MS`(턴이 끝나고 단계를 끝낼 때까지, 기본 3000).
- 시험: `npm test`(runner — 터미널은 가짜 대화형 CLI `test/fixtures/fake-tui.js`, 헤드리스는 `fake-cli.js`), `cd e2e && npx playwright test --project=desktop tests/desktop/local-agents.spec.js`(Electron 두 개). 시험은 CLI 의 설정 폴더를 임시로 준다(`CLAUDE_CONFIG_DIR` · `CODEX_HOME`).

## 보안

- `contextIsolation`, `sandbox`를 켜고 `nodeIntegration`은 끕니다. `<webview>`를 쓰지 않고 remote 모듈도 없습니다. preload는 읽기 전용 정보와 로컬 화면 버튼만 제공합니다. 로컬 화면의 IPC는 요청을 보낸 곳이 `src/pages/`인지 확인합니다.
- 창 안에서 열리는 곳은 고른 서버의 출처(ProcessGPT와 같은 출처 포함)와 로그인 출처뿐입니다. 로그인 출처는 서버 `/api/config`의 Supabase 주소와 Google 계정 화면입니다. 그 밖의 웹 주소와 메일 링크(`mailto:`)는 시스템 브라우저나 메일 앱으로 넘기고, 다른 스킴(`file:` 등)은 막습니다. 같은 서버의 새 창(원본 받기, 문서 링크)은 preload가 없는 일반 창으로 엽니다.
- 권한(알림 · 마이크 · 카메라 · 클립보드 · 전체 화면)은 서버 출처에만 줍니다.
- 사용자 에이전트에서 `Electron/…`을 뺐습니다. Google이 내장 브라우저 이름을 보고 로그인을 막기 때문입니다.

## 시험

`e2e/tests/desktop/desktop.spec.js`(D-01~D-11)에서 Playwright `_electron`으로 앱을 띄워 확인합니다. 스펙과 사진은 `openspec/specs/desktop-app`에 있습니다.

```bash
cd e2e && PGPT_URL=http://localhost:5180 API_URL=http://127.0.0.1:8787 npx playwright test --project=desktop
# 묶은 앱으로:
PGL_DESKTOP_EXE="../desktop/release/mac-arm64/Process GPT Lite.app/Contents/MacOS/Process GPT Lite" npx playwright test --project=desktop
```

## 남은 일

- Developer ID 서명 · 공증, Windows 코드 서명, 자동 업데이트, Linux 빌드와 시험.
- Windows 에서 실제 Claude Code · Codex 로 단계를 끝까지 돌려 보는 일(로그인한 사람이 필요하다 — CI 는 가짜 CLI 와 ConPTY 까지). 특히 ConPTY 가 붙여 넣기(bracketed paste) 표시를 대화형 CLI 에 그대로 넘기는지.
- Google이 내장 창의 로그인을 다시 막으면 다른 방법이 필요합니다. 시스템 브라우저에서 로그인하고 `processgptlite://` 같은 주소로 돌아오는 방식이며, Supabase 「Redirect URLs」에 그 주소를 추가해야 합니다.
- 웹 푸시는 앱이 꺼져 있을 때 오지 않습니다(Electron에는 푸시 서비스가 없습니다). 알림은 앱이 켜져 있고 창이 뒤에 있을 때만 옵니다.
