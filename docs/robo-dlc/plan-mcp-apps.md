# Lite 앱을 MCP Apps 표준으로 (앱 규약 v2)

- 결정(2026-11-11 사용자): 백엔드·프런트엔드 플러그인 기반을 검토한 뒤 「MCP Apps 방향으로 개선하자」. 검토 요지:
  - MCP + MCP Apps 는 MCP 의 첫 공식 확장(2026-01)이고 Claude·ChatGPT·VS Code 가 지원한다. 격리 iframe·postMessage JSON-RPC·CSP 선언이 표준이다.
  - Web Components 는 내부 UI 부품에만 쓴다(격리가 없다).
  - TM Forum ODA 는 엔터프라이즈 배포 기술서로만 쓴다(Kubernetes·Canvas 가 필요하다).
- 가지: `feat/mcp-apps`(feat/robo-dlc 위). 1단계: 호스트 + AI-DLC 앱 3개 + 홈 패널. 2단계: 이음오피스 · Craft(CircuitCraft·SolidCraft 포함).

## 1. 무엇이 표준이고 무엇이 Lite 확장인가

| 부분 | 표준(MCP / MCP Apps 2026-01-26) | Lite 확장 `io.uengine.lite` |
|---|---|---|
| 앱 하나 | MCP 서버 하나: 도구(`tools/*`) + 화면 `ui://` 리소스(`text/html;profile=mcp-app`), 도구의 `_meta.ui.resourceUri` | 매니페스트(붙는 자리 `folder`·`sheet`·`panel`, 맡는 기다림, 필요 조건, 시작 도구) |
| 앱 서버 위치 | Streamable HTTP(`/api/apps/<id>/mcp`, 사람의 토큰) — 같은 프로세스든 다른 서비스든 같은 주소 규약 | 같은 프로세스 앱은 서버가 요청마다 McpServer 를 만들어 등록 |
| 화면 ↔ 호스트 | 격리 iframe, `ui/initialize`, `tools/call`, `resources/read`, `ui/open-link`, `ui/message`, `ui/notifications/tool-input`·`tool-result`·`size-changed`, 호스트 맥락(테마·언어) | 실시간 알림 `notifications/io.uengine.lite/event`(폴더 구성원의 변경·보는 중), Lite 화면 링크(`/apps/…`·`/workroom/…`) |
| 앱 → 호스트 기능 | — | `lite-host` MCP 서버(`/api/apps/_host/mcp`): AI-DLC 기록·사람·세션·결정·알림·이벤트. 같은 프로세스 앱은 메모리 안 연결로 같은 도구를 부른다 |
| 호스트 → 앱 훅 | — | 앱의 도구 `lite_wait_accepts`·`lite_wait_notify`(감시기가 부름, 에이전트·화면에는 숨김) |

## 2. 바뀌는 것

- 서버: `lib/apps/registry.js`(MCP 서버 등록·Streamable HTTP·훅 호출), `lib/apps/host.js`(lite-host 도구), `lib/apps/context.js`(ctx = lite-host 클라이언트 + 앱 자기 저장소), 런타임 `/api/apps/_runtime/{ext-apps.js, lite.js, kit.css}`.
- 앱: `server.js` 가 `export default (server, ctx) => {…}` — `registerAppTool`·`registerAppResource` 로 도구와 화면을 등록. 화면은 `window.lite` 대신 표준 `App` 위의 얇은 `lite` 어댑터.
- 화면(호스트): `AppFrame` = MCP Apps 호스트(`AppBridge` + MCP Client). 화면이 `ui/initialize` 를 보내기 전에 다리를 먼저 잇고, 화면 HTML 에 `<base>` 를 넣어 앱의 `ui/` 와 런타임을 읽게 한다.
- 홈 패널: 호스트에 든 `panels` 앱(`lib/apps/builtin/panels`). 화면은 `ui://panels/view` 하나이고, 입구 도구 `panel_view` 가 그 패널의 html·script·data 를 결과로 준다. 예전 `panel.save/fetch/ask/aidlc` 는 이 앱의 도구(`panel_save` 등, 화면 전용)가 되었고, 언제나 패널 주인으로 돈다. 그래서 `/api/panel-proxy`·`/api/panel-ask`·`PUT /api/panels/:id/data` 와 프런트의 `bridge.js`·`panelRuntime.js` 는 지웠다.
- 개발 서버 둘이 한 DB 를 쓸 때: `PRO_AIDLC_WATCH_ONLY=<경로>` 면 감시기는 그 경로 아래 폴더만 본다(시험 저장소는 임시 폴더, 실제 실행은 그 밖).
- 시험: 규약(매니페스트·입구 도구의 `ui://` 화면·import 경계), MCP 로 도구 부르기(실서버), Playwright F-RD-06~08 과 홈 패널 F-RD-09.

## 3. 받아들인 한계

- 화면 HTML 은 상대 경로로 Lite 의 런타임을 읽는다(호스트가 `<base>` 를 넣음). Claude·ChatGPT 같은 바깥 호스트에 내보내려면 한 파일로 묶는 빌드가 필요하다(다음 일).
- 서버가 화면에 밀어 주는 표준이 아직 없어 실시간은 Lite 확장 알림이다. 바깥 호스트에서는 앱이 도구를 다시 불러 갱신한다.

## 4. 결과(1단계, 2026-11-11)

- 단위 `apps.test.js` 17·`aidlc.test.js`+`panelApps.test.js` 23 통과. 실서버(:8799) `apps.e2e` 9(검토 보드 흐름 전부 MCP 로, MCP 끝점 보호, 홈 패널)·`aidlc.e2e`+`aidlc-team.e2e`+`panelPrivacy.e2e` 15 통과. Playwright `robo-dlc.spec.js` F-RD-01~09 통과(:5198 고정 빌드).
- 겪은 일: MCP 클라이언트 전송은 헤더를 `Headers` 객체로 넘긴다. 토큰을 덧붙일 때 객체 펼치기를 하면 `Accept` 가 빠져 서버가 406 을 준다(`new Headers(init.headers)` 로 고침). 클라이언트가 여는 GET 이벤트 흐름에는 405 를 준다(상태 없는 서버, 표준이 허용).

## 5. 2단계: 이음오피스 · Craft

- 지금: 둘 다 MCP 로 기능이 나뉘어 있지만 화면은 같은 출처 iframe(`/office/…`, `/craft/<app>/…`)이고 격리가 없다.
- 할 일: 편집기마다 MCP 서버의 입구 도구 + `ui://<app>/editor` 화면, 호스트가 같은 `AppFrame` 으로 연다. 편집기와 주고받는 저장·열기·내보내기는 앱 도구로, 편집기 고유 메시지는 Lite 확장 알림으로 옮긴다. 큰 편집기(이음오피스·CADCraft)는 화면 HTML 이 바깥 주소의 편집기를 읽어야 하므로 리소스의 `_meta.ui.csp` 에 그 출처를 선언한다.
