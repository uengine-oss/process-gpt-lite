# 시험과 증거

## 단위 시험 (Electron 없이)

```bash
cd desktop && npm test      # test/policy.test.js · test/server.test.js · test/badge.test.js …
cd server && node --test test/appBadge.test.js   # 웹 앱 쪽 알림 수(src/appBadge.js)
```

주소 정규화, `/api/config` 확인(가짜 fetch), 주소별로 창 안이나 창 밖에서 열지, 차단할지를 확인한다. `test/badge.test.js` 는 알림 수 맞추기, 시스템별 글(메뉴 막대 숫자 · 툴팁 · 오버레이 설명 · 메뉴), 비트맵에 그린 배지(크기 · 빨강 · 0이면 그대로 · 10부터 9+), macOS 메뉴 막대 아이콘의 빨간 점(밝음 · 어두움), 가짜 `app` · `Tray` · `Menu` · `nativeImage` · `nativeTheme` 로 macOS · Windows · Linux 의 `src/tray.js`(Dock 튀기 포함), 트레이 PNG 와 묶기 설정을 본다.

## 앱 시험 (Playwright `_electron`, `e2e/tests/desktop/desktop.spec.js`)

```bash
# 서버: 백그라운드 일 없음, 지도 워커 없음, 공용 deepagents · completion 에 닿지 않게 막음
cd server && PRO_PORT=8791 PRO_BACKGROUND=0 PRO_ONTOLOGY_WORKER=0 PRO_DEEPAGENTS_URL=http://127.0.0.1:9 \
  PRO_CLI_AGENT_URL=http://127.0.0.1:9 PRO_COMPLETION_URL=http://127.0.0.1:9 PRO_PUBLIC_URL=http://localhost:5211 node index.js
PRO_API_TARGET=http://127.0.0.1:8791 npx vite --port 5211 --strictPort
cd desktop && npm install
cd e2e && PGPT_URL=http://localhost:5211 API_URL=http://127.0.0.1:8791 npx playwright test --project=desktop
# 묶은 앱으로 (npm run dist 뒤)
PGL_DESKTOP_EXE="../desktop/release/mac-arm64/Process GPT Lite.app/Contents/MacOS/Process GPT Lite" \
  PGPT_URL=http://localhost:5211 API_URL=http://127.0.0.1:8791 npx playwright test --project=desktop
```

시험에서는 앱의 서버 주소로 TCP 중계 주소(`http://localhost:<중계 포트>`)를 지정한다. 중계를 닫으면 서버가 사라진 것과 같다(D-06, D-10). 앱은 임시 프로필(`PGL_DESKTOP_USER_DATA`)로 뜨고, 바깥으로 넘기는 주소는 브라우저를 여는 대신 기록한다(`PGL_DESKTOP_EXTERNAL=log`). 계정은 `pro-rt-desktop@uengine.org`(데모 코드 000000)이다. D-08은 Google 계정 화면을 실제로 연다(로그인 없이 페이지만 연다). Google에 연결할 수 없으면 건너뛴다.

| 스펙 시나리오 | 시험 |
|---|---|
| 첫 실행 | D-01 |
| 서버 바꾸기 | D-10 |
| 이메일 코드 | D-02 |
| Google | D-08 |
| 넓은 폭 (밝음 · 어두움) | D-04 |
| 좁은 폭 | D-04 |
| 위 메뉴가 없는 화면 | D-04(설정) |
| 브라우저 | D-11 |
| 바깥 링크 · 같은 서버의 새 창 | D-05 |
| 서버가 꺼졌다 켜진다 | D-06, D-10(밝음) |
| 두 번 켠다 · 창 자리 | D-09 |
| 알림과 숫자 · 메뉴 언어 | D-07 |
| 서버 화면이 로컬 단추를 부른다 | D-07(`window.pglLocal` 없음, 메인 쪽 거절은 코드 검토만) |
| 묶은 앱 | `PGL_DESKTOP_EXE`로 D-01~D-11 |
| 채팅 · 루틴 · 폴더 화면 | D-03 |
| 페이지가 보낸 수 · 트레이 아이콘을 누른다 · 「알림 N개 — 열기」 · 로그아웃 | D-12 |
| Home 카드 | D-13 |
| Windows · Linux의 배지 그림 | `desktop/test/badge.test.js`(가짜 Electron), 그림 `d12-tray-badges.png` |
| macOS 메뉴 막대의 빨간 점 | `desktop/test/badge.test.js`(가짜 Electron · 픽셀 — 밝음 · 어두움, 바뀌면 다시 그림, 0이면 템플릿) |
| 새 알림이 오면 Dock 아이콘이 한 번 튄다 | `desktop/test/badge.test.js`(가짜 Electron) |
| 로그인한 뒤의 사용자 데이터 폴더 | DH-01 (`e2e/tests/desktop/desktop-harden.spec.js`) |
| 로그아웃 | DH-03 |
| 앞선 판의 로그인 | DH-04 |
| 키체인을 쓸 수 없는 컴퓨터 | DH-04(`PGL_DESKTOP_NO_SEAL=1`), `desktop/test/session.test.js`, `server/test/sessionStore.test.js` |
| (browser-handoff) 에이전트가 Lite 를 열려 한다 · 넘겨받은 창에서 | DH-02, `desktop/test/policy.test.js` · `browser.test.js`, `server/test/browser-local.test.js` |
| 채팅의 웹 앱 링크 | DH-05, `desktop/test/policy.test.js`(`windowFor`) |
| (browser-handoff) 이 PC 를 가리키는 다른 이름 · 서버의 다른 주소 | DH-02(`--host-resolver-rules` 로 `lite-alias.test` → 127.0.0.1 · `[::ffff:7f00:1]` · BFF 포트), `desktop/test/policy.test.js` · `browser.test.js`, `server/test/agentBrowserGuard.test.js` |
| (browser-handoff) Lite 의 페이지에서 시작하는 작업 · 앞선 판의 데스크톱 | `server/test/browserRoute.test.js` |
| (browser-handoff) 웹소켓의 표시 | DH-06 |
| (browser-handoff) 서버의 브라우저가 Lite 자신의 주소로 간다 | `server/test/browserServerMark.test.js` |
| (browser-handoff) 인증 코드를 묻는다 — 그 설치 자신의 로그인 메일 | `server/test/mail-code.test.js` |

시험하지 않은 것: 실제 Windows · Linux 의 트레이 · 작업 표시줄 오버레이 · 런처 숫자(가짜 Electron 의 단위 시험만), 메뉴 막대에 보이는 모습(화면 기록 권한이 없어 찍지 못함 — `state()` 의 `tray.getTitle()` 로 확인), 전체 화면에서 신호등 자리 비우기(macOS 전체 화면은 새 Space로 옮겨 가서 이 PC의 화면에 영향을 준다), 마우스 오른쪽 단추 메뉴, 접근 암호(basic auth)가 걸린 서버, 401 응답일 때 자동으로 재시도하지 않는 동작, 화면 공유, Windows · Linux.

## 사진 (`results/`)

창 캡처(`capturePage`/Playwright)에는 웹 화면만 찍히고 OS의 신호등은 찍히지 않는다. 이 PC는 화면 기록 권한이 없어 `screencapture`도 쓰지 못한다. 그래서 `*-lights.png`에는 신호등 자리(x 20–80, y 27–41)를 그려 넣고, 그려 넣은 표시임을 사진 안에 적었다.

| 사진 | 내용 |
|---|---|
| `d01-setup-dark.png` | 첫 실행 시 서버 선택 화면 (어두움) |
| `d10-setup-light.png` | 메뉴 「서버 바꾸기…」 (밝음, 현재 서버 · 취소) |
| `d02-login.png` | 로그인 화면: 그림이 신호등 아래에서 시작 |
| `d04-chat-wide-light.png` · `-dark.png` | 채팅 1280×800, 낮 · 밤 하늘이 맨 위까지 |
| `d04-chat-narrow-light.png` · `-dark.png` | 채팅 600×800 휴대폰용 배치 |
| `d02-login-lights.png` · `d04-*-lights.png` | 로그인과 위 네 장에 신호등 자리 표시 |
| `d04-settings.png` | 위 메뉴가 없는 화면(설정) |
| `d06-offline-dark.png` · `d10-offline-light.png` | 연결 실패 화면 |
| `d12-home-from-tray.png` | 트레이 메뉴 「알림 2개 — 열기」로 폴더에서 채팅의 Home 으로 |
| `d13-home-cards.png` | Home 카드 세 장 — 숫자 3 |
| `dh01-signed-in-after-restart.png` | 0.2.6 — 앱을 다시 켜도 로그인한 채 채팅(로그인은 앱이 봉인해 둠) |
| `dh02-pc-window-refused.png` | 0.2.6 — 「이 PC에서 보기」 창: Lite 로 가는 링크 · 요청이 닿지 않음(`blocked blocked no-window`) |
| `d12-tray-badges.png` | 앱이 그리는 그림(`src/badge.js` → Electron `nativeImage`, 크게 확대): Windows · Linux 트레이 0 · 3 · 12(9+), 16 · 32px, 밝은 막대 · 어두운 막대, Windows 작업 표시줄 오버레이, macOS 템플릿 그림과 숫자 |

DH-01~06 은 스스로 BFF(8991 — 쓰고 있으면 다음 빈 포트) · Vite(5391 — 마찬가지) · 대본 모델 · 지어낸 사이트를 띄운다: `cd e2e && npx playwright test --project=desktop tests/desktop/desktop-harden.spec.js`. 사용자 데이터 폴더는 앱을 닫은 뒤 모든 파일을 토큰의 UTF-8 · UTF-16 꼴로 찾는다. 묶은 앱의 쿠키 봉인(fuse)은 `npm run smoke` 의 `fuses` 가 본다 — 묶지 않은 앱(이 시험)에는 없다.

시험 결과는 `e2e.txt`에 있다.
