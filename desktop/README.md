# Process GPT Lite 데스크톱 앱 (Electron)

Lite 서버 하나를 창 하나로 여는 데스크톱 앱입니다. Lite 자체(웹 앱·서버·Supabase·deepagents)는 들어 있지 않고, 사용자가 고른 서버의 웹 화면을 그대로 띄웁니다. `android/` 앱과 같은 방식입니다.

- **서버 고르기**: 처음 켜면 서버 주소를 묻습니다. 회사 주소(`https://<회사>.process-gpt.io/lite`) 또는 이 컴퓨터에 설치한 Lite(`http://localhost:18080`)를 넣으면 됩니다. `acme.process-gpt.io`처럼 도메인만 넣으면 `/lite`를 붙여 다시 찾고, 브라우저 주소창에서 복사한 주소(`…/lite/chat`)를 넣으면 앞부분만 씁니다. 저장하기 전에 `<주소>/api/config`의 응답이 Lite에서 온 것인지 확인합니다. 주소는 저장하며, 메뉴의 **서버 바꾸기…**(`Process GPT Lite` 메뉴, Windows는 `파일`)로 바꿀 수 있습니다. 터널 같은 공개 주소에 접근 암호(basic auth)가 걸려 있으면 선택 화면의 「접근 암호」에 넣습니다. 암호는 OS 키체인으로 암호화해 저장합니다(`safeStorage`).
- **로그인**: 서버에 연결한 뒤 해당 서버의 화면에서 로그인합니다(이메일 코드, Google). Google 로그인과 회사 Supabase 로그인 화면은 창 안에서 열리고, 로그인이 끝나면 같은 서버로 돌아옵니다.
- **제목 표시줄**: 별도의 제목 띠가 없습니다. Lite의 하늘 배경이 창 맨 위까지 이어집니다. macOS는 신호등(창 단추)을 위 메뉴 줄 안(20, 27)에 두고, 웹 화면의 위 메뉴는 그 오른쪽부터 시작합니다. Windows·Linux는 오른쪽 위에 투명한 창 단추(`titleBarOverlay`)를 얹습니다. 단추 기호 색은 웹 앱의 밝음/어두움 설정을 따릅니다. 창은 위 메뉴 줄의 빈 곳(위 메뉴가 없는 화면은 맨 위 40px)을 잡고 끕니다.
- **그 밖에**: 하나만 실행됩니다(두 번 켜면 처음 창이 앞으로 옵니다). 창 크기와 위치를 저장합니다. 메뉴는 한국어이고, 웹 앱이 영어면 영어로 바뀝니다. 새로 고침(⌘R), 확대·축소, 전체 화면을 지원하고, 개발자 도구는 개발 실행에서만 켜집니다. 웹 앱의 알림은 시스템 알림으로, Home 카드 수는 Dock 아이콘 숫자로 보입니다. 서버가 응답하지 않으면 연결 실패 화면이 뜹니다. 「다시 시도」를 누르거나 네트워크가 돌아오면 다시 엽니다. 20초마다 서버를 확인하고, 응답이 올 때만 화면을 바꿉니다.

## 개발 실행

```bash
cd desktop
npm install                 # Electron · electron-builder (이 폴더의 node_modules)
npm start                   # 또는 npm run dev (개발자 도구 켬)
```

- 터미널에 `ELECTRON_RUN_AS_NODE=1`이 설정되어 있으면(VS Code 터미널 등) Electron이 Node로 실행되다가 바로 종료됩니다. 이때는 `env -u ELECTRON_RUN_AS_NODE npm start`로 실행합니다.
- 다른 프로필로 띄우려면 `PGL_DESKTOP_USER_DATA=<폴더> npm start`를 씁니다. 설정, 로그인, 창 위치, 중복 실행을 막는 잠금이 모두 해당 폴더를 사용합니다.
- 로컬 Lite에 연결할 때는 개발 서버(`npm run dev`, 기본 `http://localhost:5180`) 또는 설치 번들(`http://localhost:18080`) 주소를 넣습니다.
- 단위 시험: `npm test`(주소 정규화 · 서버 확인 · 주소를 열 위치).

## 묶기 (macOS)

```bash
cd desktop
npm run icon                # build/icon.png ← ../public/favicon.svg (Python Pillow), 바꿀 때만
npm run dist                # → release/Process-GPT-Lite-<버전>-mac-arm64.dmg · .zip
```

- 결과물은 `release/` 아래에 생성되며 커밋하지 않습니다. 앱 묶음은 `release/mac-arm64/Process GPT Lite.app`입니다.
- Developer ID 서명과 공증은 하지 않습니다. 묶은 뒤 임시(ad hoc) 서명을 합니다(`scripts/adhoc-sign.js`). 그래서 내려받은 DMG를 처음 열면 「확인할 수 없습니다」가 뜹니다. 이때는 시스템 설정 › 개인정보 보호 및 보안 › 「그래도 열기」를 누릅니다.
- Windows(NSIS)와 Linux(AppImage) 설정은 `electron-builder.yml`에 있지만, 아직 빌드하거나 시험하지 않았습니다.

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

웹 앱 쪽에서 바뀐 곳은 세 군데입니다. 모두 `html.pgl-desktop` 아래에서만 동작해서 브라우저에서는 아무것도 바뀌지 않습니다.

- `src/styles/desktop.css`: 창을 끌 수 있는 영역, 위 메뉴가 창 단추와 겹치지 않도록 하는 여백, 로그인 화면과 설정 ✕ 위치.
- `src/main.js`: 위 CSS를 가져옵니다.
- `src/browserNotify.js`: 데스크톱 앱에서는 푸시를 구독하지 않습니다. 알림도 서비스 워커가 아니라 `new Notification`으로 띄웁니다(Electron은 서비스 워커 알림을 보여 주지 않습니다).

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

- Developer ID 서명 · 공증, 자동 업데이트, Intel(x64) · Windows · Linux 빌드와 시험.
- Google이 내장 창의 로그인을 다시 막으면 다른 방법이 필요합니다. 시스템 브라우저에서 로그인하고 `processgptlite://` 같은 주소로 돌아오는 방식이며, Supabase 「Redirect URLs」에 그 주소를 추가해야 합니다.
- 웹 푸시는 앱이 꺼져 있을 때 오지 않습니다(Electron에는 푸시 서비스가 없습니다). 알림은 앱이 켜져 있고 창이 뒤에 있을 때만 옵니다.
