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

## 5. 2단계: Craft (끝남) · 이음오피스

### 자기 출처가 필요한 화면: 샌드박스 프록시

- 실험(2026-11-11): VectorCraft·PhotoCraft 웹 빌드를 출처 없는 틀(sandbox `allow-scripts` 만)에 넣으면 앱은 뜨지만 IndexedDB·localStorage 가 `SecurityError` 이고, PhotoCraft 는 글꼴 목록(`fonts/manifest.txt`, same-origin fetch)을 못 읽어 한글이 깨진다. 자기 출처가 있으면 모두 된다.
- 그래서 MCP Apps 명세의 이중 iframe(샌드박스 프록시)을 쓴다. 바깥 틀 `/api/apps/_sandbox`(`lib/apps/runtime/sandbox.html`)는 `PRO_APPS_SANDBOX_ORIGIN`(Lite 와 다른 호스트·포트, 같은 서버로 오는 주소)에서 뜨고, 화면 HTML 을 받아 안쪽 틀(그 출처, 선언한 CSP)에서 돌린다. 메시지는 그대로 넘긴다. Lite 화면만 프록시를 틀에 넣을 수 있다(`frame-ancestors 'self'` + `PRO_APPS_HOST_ORIGINS`). 프록시는 허락된 부모에게만 답한다.
- 매니페스트 `origin: true` 인 앱만 프록시 뒤에서 돈다(지금 `craft` 하나). 모델이 쓴 홈 패널·검토 보드 같은 화면은 출처 없는 틀 그대로다.
- `PRO_APPS_SANDBOX_ORIGIN` 이 없으면 프록시는 Lite 출처에서 뜬다. 예전 같은 출처 iframe 과 격리 수준이 같고, 코드 길은 하나다. 설치판에서 격리를 켜려면 nginx 에 둘째 포트(또는 하위 도메인)를 열고 그 주소를 넣는다.

### Craft = 내장 앱 `craft`

- 서버 `lib/apps/builtin/craft`: 입구 도구 `craft_open({app, name, lang})`(이 설치에 없는 앱 404), 화면 `ui://craft/editor`(권한은 클립보드만).
- 화면 `ui/editor.js`: 앱의 웹 빌드를 같은 출처 틀에 넣고, 예전에 페이지가 밖에서 하던 일을 안에서 한다. CADCraft 는 postMessage 다리, 나머지는 페이지 API·합성 drop·다운로드 가로채기다.
  - 페이지가 파일을 넣는다: 화면 도구 `craft_file`.
  - 저장·내보내기는 `ui/download-file` 로 페이지에 넘긴다(Lite 는 편집본·내보낸 파일로 올린다).
  - 상태(열림·저장 안 됨·실패)는 Lite 알림 `craft` 로 알린다.
  - 라이브 요청과 그림 뜨기는 화면 도구 `craft_request`·`craft_snapshot` 이다.
- 페이지 `CraftEditorFrame.vue`: 머리줄·알림·저장(업로드)·라이브 연결(`craftLive` 웹소켓)은 그대로다. 앱에 손대는 일은 모두 `AppFrame.callView` 로 바뀌었다.
- 겪은 일: 화면은 `about:srcdoc` 이라 `location.origin` 이 `"null"` 이다. 진짜 출처는 `self.origin` 이다(CADCraft 다리의 출처 검사).
- 시험: Craft 13개(F-CR-<앱> 5·F-CR-10·F-CR-11·F-ED-04 다섯 앱·F-CV-04)가 프록시 뒤에서 통과했다. 바꾸기 전 기준선 12개도 통과. 중첩 틀의 출처가 샌드박스 출처인지도 본다.
- CircuitCraft·SolidCraft 는 `feat/prototype-request`(미병합)에 있다. 그 가지가 이 위로 올라오면 `editor.js` 의 앱 표와 `CraftEditorFrame` 의 머리줄 표에 한 줄씩 넣으면 된다.

### 이음오피스 = 내장 앱 `office` (끝남)

- 서버 `lib/apps/builtin/office`: 입구 도구 `office_open({editor, name, readOnly})`(모르는 편집기 404), 화면 `ui://office/editor`.
- 화면 `ui/editor.js`: 편집기(`/office/<editor>/`, 화면과 같은 출처)를 틀에 넣고, 편집기의 기존 메시지 규약을 그대로 중계한다. 편집기 → 페이지는 Lite 알림 `office`, 페이지 → 편집기는 화면 도구 `office_post` 다. 예전에 페이지가 편집기 문서 안에서 하던 일(리본 접기 Ctrl+F1, 한글 도구 상자, 미리보기의 AI 칸 숨기기, 리본 기억 localStorage)은 화면 도구다. 편집기 주소(사람의 토큰 포함)는 페이지가 화면 도구 `office_load` 로 넘기고, 화면은 자기 출처의 `/office/…` 만 연다.
- 그림 왕복의 바이트는 base64 로 싣는다(`src/apps/bytes.js` 와 런타임 `lite.pack/unpack`, 같은 꼴).
- 개발: 샌드박스 출처는 `/office`·`/craft`·`/api` 를 다 대리하는 곳이어야 한다. 그래서 같은 미리보기를 다른 호스트 이름으로 쓴다(페이지 `127.0.0.1:5198`, 샌드박스 `localhost:5198`). 설치판도 nginx 의 둘째 포트에 같은 경로를 연다.
- 시험: 편집기 묶음 21개(F-ED-01~08·F-CR·F-CV-04), 영문 F-EN-02(워드 그림 ↔ 포토크래프트), 스모크 S-30 이 모두 통과했다. 바꾸기 전 기준선도 21개 통과(F-ED-08 은 Craft 틀 주소 검사를 고친 뒤).
