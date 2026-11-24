# ArtCraft 앱 — 앱을 포함한 설치는 다섯 앱을 모두 제공한다 · 에이전트와 디스크를 공유하지 않아도 도구가 실행된다

## Purpose
2026-11-25 사용자 요청: 「서버에도 크래프트 시리즈 배포해줘」.

운영 환경(<회사>.process-gpt.io/lite)에서 파일 카드를 PhotoCraft로 열면 「이 설치에는 PhotoCraft 앱이 없어 앱 안에서 열 수 없어요」라는 메시지가 떴다. 운영 서버에는 ArtCraft 웹 앱과 CLI가 모두 없어 `craftStatus()`가 어떤 앱도 찾지 못했다. 앱을 설치한 뒤에도 에이전트의 도구는 실행되지 않았다. 도구는 deepagents의 작업 폴더(`/workspace`)를 이 서버의 디스크에서 찾지만, 운영 환경에서는 deepagents가 다른 파드에 있어 이 서버가 해당 디스크에 접근할 수 없다. VectorCraft · PhotoCraft · SoundCraft는 도구 목록을 조회하는 단계부터 `workspace folder not found: /workspace` 오류로 실패했다.

이 스펙은 설치와 운영에 관한 요구사항을 다룬다. 앱 연동 자체에 관한 내용(같은 출처의 iframe, 사용자별 CLI 세션, 라이브 공동 편집, 의도에 따른 도구 활성화)은 process-gpt 저장소의 `openspec/specs/pgpt-pro_craft-apps/spec.md`에 있다.

- 이미지: `install/docker/craft.Dockerfile` · `install/docker/craft-build.sh` → `ghcr.io/uengine-oss/process-gpt-lite-craft:<커밋>` (`.github/workflows/craft-image.yml`). 마지막 단계에는 `/craft/web/<앱>` · `/craft/bin/<앱>-cli`가 있다.
- Docker 설치: `install/docker-compose.yml`의 `craft` 프로필(`./install.sh --with-craft`)이 파일을 `/data/craft` · `/data/craft-bin`에 복사한다.
- 운영: process-gpt-k8s의 `deployments/process-gpt-lite.yaml`에 정의된 서버 Deployment에서 craft initContainer가 같은 위치(PVC `/data`)에 파일을 복사한다. 이미지 내용이 바뀔 때만 다시 복사하고, wasm·js의 `.gz` 파일을 만든다.
- 서버: `server/mcp/craft.js`는 `craftStatus`와 `/mcp/<앱>`을, `server/lib/craftWork.js`는 작업 폴더를 대신할 폴더를, `server/lib/office.js`는 카드를, `server/index.js`는 `/craft` 정적 파일과 `.gz` 제공을 담당한다.

## Requirements

### Requirement: ArtCraft를 포함한 설치는 다섯 앱을 모두 제공한다
시스템은 ArtCraft를 포함한 설치(Docker `--with-craft`, 운영 환경의 craft initContainer)에 다섯 앱(CADCraft · VectorCraft · PhotoCraft · SoundCraft · FilmCraft)의 웹 편집기와 CLI를 모두 갖추어야 한다(SHALL). 설치할 때 `PRO_CRAFT_WEB_ROOT/<앱>/index.html`과 `PRO_<앱>_CLI` 실행 파일을 배치한다. `/api/config`의 `craft`에는 각 앱이 `{web: true, cli: true}`로 표시된다. `/craft/<앱>/`은 해당 앱의 페이지를 제공한다. 페이지가 불러오는 wasm은 `application/wasm`으로 제공하며, 요청에서 gzip을 허용하면 gzip으로 제공한다(VectorCraft의 wasm은 74MB, gzip으로 압축하면 25MB). 앱 하나가 빠지면 해당 앱만 없는 것으로 표시한다.

#### Scenario: 운영 환경에서 PhotoCraft 카드 열기
- **WHEN** craft initContainer가 포함된 서버가 시작된 뒤 운영 주소의 `/lite/api/config`를 조회한다
- **THEN** `craft.photocraft`는 `{web: true, cli: true}`다
- **AND** `/lite/craft/photocraft/`는 200 상태 코드와 HTML을 반환하고, PNG·PSD 파일 카드는 「이 설치에는 PhotoCraft 앱이 없어」라는 메시지 대신 옆 칸의 PhotoCraft로 열린다

#### Scenario: 빠진 구성 요소만 없는 것으로 표시한다
- **WHEN** 웹 루트에 `photocraft/index.html`이 없고, FilmCraft CLI에 실행 권한이 없으며, SoundCraft CLI 경로에 파일이 없다
- **THEN** `craftStatus()`는 photocraft를 `{web: false, cli: true}`, filmcraft를 `{web: true, cli: false}`, soundcraft를 `{web: true, cli: false}`로 표시하고, CADCraft · VectorCraft는 그대로 표시한다

#### Scenario: 설치 확인 시험은 구성 요소가 빠지면 실패한다
- **WHEN** `PRO_CRAFT_WEB_ROOT`와 `PRO_<앱>_CLI`를 지정한 상태로 서버 이미지 안에서 `test/craftInstall.test.js`를 실행한다
- **THEN** 각 앱에 `index.html`이 있고, CLI가 `--version`에 응답하며, MCP `initialize` · `tools/list` 요청에 도구를 제공해야 통과한다
- **AND** 하나라도 없으면 건너뛰지 않고 실패한다(스모크 S-30은 앱이 없는 설치에서 건너뛴다)

---

### Requirement: 웹 앱은 하위 경로에서도 실행된다
시스템은 설치의 하위 경로(게이트웨이 뒤의 `/lite`)에 있는 `/lite/craft/<앱>/`에서 ArtCraft 웹 앱을 실행해야 한다(SHALL). 앱 페이지는 자신의 파일을 상대 경로로 불러온다. 채팅의 편집기 틀(`BASE/craft/<앱>/`)과 라이브 연결(`BASE/api/craft/live`)을 요청할 때도 접두어를 붙인다. PhotoCraft가 요청하는 `fonts/manifest.txt`(문서 글꼴 목록)는 없어도 된다(업스트림 HOSTING.md). 이미지에 해당 파일과 NanumGothic을 함께 포함하면 웹에서도 한글 글자 레이어에 같은 글꼴이 적용된다.

#### Scenario: 브라우저에서 다섯 앱이 실행된다
- **WHEN** 브라우저에서 `/lite/craft/<앱>/`을 연다
- **THEN** 3분 안에 `window.<앱>`(편집기 틀이 사용하는 페이지 API)과 캔버스가 준비된다
- **AND** 앱이 요청한 파일 중 4xx · 5xx 응답을 받은 파일이 없다(`fonts/manifest.txt`는 제외한다)

#### Scenario: 라이브 연결은 접두어가 있는 경로에서도 서버에 도달한다
- **WHEN** 표 없이 페이지의 Origin을 붙여 `wss://<회사>.process-gpt.io/lite/api/craft/live`에 연결한다
- **THEN** 서버가 소켓 연결을 받아 `{type: 'denied', code: 4401}`을 보낸 뒤 4401로 닫는다(다른 Origin이면 4403)

---

### Requirement: 에이전트와 디스크를 공유하지 않는 설치에서도 앱 도구가 실행된다
시스템은 deepagents의 작업 폴더가 이 서버에 없을 때(운영 환경에서는 deepagents가 다른 파드에 있음) 사용자별 대체 폴더(`PRO_CRAFT_WORK_ROOT/<테넌트>/<사람>`, 기본값은 임시 폴더)를 `/workspace`로 삼아 ArtCraft CLI를 실행해야 한다(SHALL). 작업 폴더가 이 서버에 있으면(로컬, Docker) 지금처럼 해당 폴더를 사용한다.
- 도구 목록(`tools/list`)은 작업 폴더가 없어도 조회할 수 있다.
- 도구가 대화 폴더(`/workspace/.bpmn/<대화>/`)에 쓴 파일은 해당 호출이 끝나면 대화 폴더의 storage 사본(`files` 버킷의 `skills/<테넌트>/<대화>/…`, deepagents와 같은 키 인코딩)에 업로드한다. 경로를 지정하지 않고 저장한 문서도 해당 세션에서 다룬 대화 폴더에서 찾아 업로드한다.
- 도구가 대화 폴더의 파일을 열 때 해당 파일이 대체 폴더에 없으면 storage 사본에서 내려받는다.
- 파일을 내려받거나 업로드할 수 있는 대상은 해당 사용자가 사용할 수 있는 대화 폴더로 제한한다. 작업실(`lib/workroom.js`)에서 폴더 접근을 허용하는 규칙과 같다. 대상은 자신의 대화(`context_threads` · `pro_threads`), 실행 권한(runner) 이상을 가진 공유 폴더의 실행 방, 참여한 프로세스 인스턴스의 폴더다. 에이전트가 한 사용자를 위해 호출하는 도구이므로, 테넌트 관리자라도 다른 사람의 폴더는 사용할 수 없다. 그 밖의 폴더에서는 파일을 내려받지 않고, 저장할 위치도 만들지 않으며, 파일을 업로드하지 않는다. 도구는 해당 위치에서 파일을 찾지 못했다는 자체 오류를 반환한다. 서버 기록은 호출마다 파일 이름을 제외하고 한 줄로 남긴다.
- 사용자 자신의 첨부·카드에 해당하는 storage 주소(`…/object/public/files/pgpt-pro/<그 사용자>/…`)를 인자로 전달하면 서버가 해당 파일을 `/workspace/uploads/<사용자>/files/`에 내려받고, 그 경로로 도구를 호출한다. 다른 사람의 주소에 있는 파일은 내려받지 않는다.
- 채팅 카드는 대체 폴더에 있는 파일도 찾는다. 답변에 적힌 경로와 대화 폴더를 확인하고, 해당 파일의 바이트를 업로드해 카드를 만든다.
- 인자로 지정할 수 있는 경로는 `/workspace` 안으로 제한한다. 그 밖의 절대 경로나 상위 폴더 조각(`..`)이 포함된 경로는 도구를 호출하지 않고 거절한다. CLI는 작업 폴더를 현재 폴더로 삼아 실행된다.
- 대체 폴더의 파일은 하루 동안 보관한 뒤 삭제한다. 사본은 storage에 남는다.

#### Scenario: 도구 목록
- **WHEN** 작업 폴더가 이 서버에 없는 설치에서 `/mcp/vectorcraft` · `/mcp/photocraft` · `/mcp/soundcraft`에 `tools/list`를 보낸다
- **THEN** 각 앱의 도구 목록을 반환한다(이전에는 `workspace folder not found: /workspace` 오류가 발생했다)

#### Scenario: 만든 파일을 카드로 표시한다
- **WHEN** 에이전트가 `photocraft_doc_save`로 `/workspace/.bpmn/<대화>/썸네일.psd`에 저장하고 답변에 그 경로를 적는다
- **THEN** 해당 파일이 `skills/<테넌트>/<대화>/` 아래에 업로드되고, 채팅에 「썸네일.psd」 카드가 붙는다

#### Scenario: 첨부한 사진을 앱으로 연다
- **WHEN** 에이전트가 사용자가 첨부한 사진의 storage 주소를 `photocraft_doc_open`에 전달한다
- **THEN** 서버가 해당 파일을 `/workspace/uploads/<사용자>/files/`에 내려받아 연다
- **AND** 같은 회사의 다른 사람이 첨부한 파일의 주소는 파일을 내려받지 않고 그대로 전달한다(앱이 열지 못한다)

#### Scenario: 경로는 /workspace 안으로 제한한다
- **WHEN** 도구 인자에 `/etc/hosts` 같은 다른 절대 경로나 `../x.dxf`처럼 상위 폴더 조각이 포함된 경로가 있다
- **THEN** 도구를 호출하지 않고 「only paths under /workspace」 · 「may not go up a folder」 오류를 반환한다

#### Scenario: 다른 사람의 대화 폴더에서는 파일을 열거나 쓰지 않는다
- **WHEN** 같은 회사 김 대리의 에이전트가 이 대리의 대화 폴더에 있는 `/workspace/.bpmn/<이 대리의 대화>/계약서.psd`를 `photocraft_doc_open`으로 열거나, 해당 폴더에 `photocraft_doc_save`로 저장하려 한다
- **THEN** 서버는 해당 파일을 storage 사본에서 내려받지 않고, 저장할 폴더도 만들지 않으며, 해당 폴더의 storage 사본에 아무것도 업로드하지 않는다
- **AND** 도구는 파일이나 폴더가 없다는 자체 오류(`No such file or directory`)를 반환하고, 이 대리의 채팅·대화 폴더는 그대로 유지된다
- **AND** 김 대리가 실행 권한 이상의 구성원인 공유 폴더의 실행 방에서는 기존처럼 파일을 열고 저장할 수 있다

#### Scenario: 이전 턴의 파일
- **WHEN** 도구가 대체 폴더에 없는 `/workspace/.bpmn/<대화>/사진.psd`를 연다
- **THEN** 대화 폴더의 storage 사본에서 내려받아 연다. 이미 있으면 다시 내려받지 않는다

---

### Requirement: 기본 도구는 공통 MCP를 통해 모든 회사의 에이전트에 연결된다
시스템은 ArtCraft 도구를 회사(테넌트)마다 따로 등록하지 않아도 모든 회사의 에이전트에 연결해야 한다(SHALL). 공유 폴더 · 패널 앱 · 프로세스 개선 · 이음오피스 편집 도구도 같은 방식으로 연결해야 한다. 사용자 결정(2026-11-25): 「기본 툴들은 공통 mcp 이므로, 테넌트에 따로 등록 관계없이 등록될 수 있도록」.
- 기본 도구는 deepagents의 공통 MCP 목록(`COMMON_MCP_SERVERS`, process-gpt-k8s의 `process-gpt-deepagents-config`)을 통해 모든 회사의 에이전트에 연결된다. 이름은 앱마다 `pgpt-<앱>`이다. 주소는 클러스터 내부 서버(`http://process-gpt-lite-server.default.svc.cluster.local:8787/mcp/<앱>`)이고, 헤더는 `Authorization: Bearer {{user_jwt}}`다. 공개 주소의 `/lite`는 `/mcp` 요청을 전달하지 않는다.
- 회사는 개별 도구를 끌 수 있다. 회사의 `tenants.mcp.mcpServers`에 `"pgpt-<앱>": {"enabled": false}`를 설정한다.
- 회사 목록에 같은 이름으로 주소나 명령이 지정된 항목이 있으면 그 항목이 공통 항목을 통째로 대체한다. 다른 설치에서 옮겨 온 낡은 항목(예: `http://localhost:8787/mcp/<앱>`)이면 에이전트는 그 낡은 주소를 받아 도구에 연결하지 못한다. 운영 점검 D-AT-<앱>이 이를 알린다(agent-tools 스펙).
- 도구가 연결된 회사에서도 사용자의 메시지가 해당 앱을 찾기 전에는 앱마다 활성화 도구(`<앱>_start`) 하나만 보인다.

#### Scenario: 회사마다 등록하지 않아도 연결된다
- **WHEN** 회사의 `tenants.mcp`에 `pgpt-photocraft`가 없다
- **THEN** 공통 목록을 통해 에이전트에 PhotoCraft 도구가 연결되고, 사용자가 「포토크래프트로 썸네일 만들어 줘」라고 하면 해당 턴에 photocraft_ 도구가 보이며 만든 파일이 카드로 붙는다
- **AND** `/lite/api/config`의 `agentTools.craft.photocraft`는 `true`(이름표 `["common"]`)이고 D-AT-photocraft가 통과한다

#### Scenario: 회사가 끈 도구
- **WHEN** 회사의 `tenants.mcp.mcpServers`에 `"pgpt-photocraft": {"enabled": false}`가 있다
- **THEN** PhotoCraft 카드는 열리지만 그 회사의 에이전트에는 photocraft_ 도구가 없고, `agentTools.craft.photocraft`는 `false`다

#### Scenario: 같은 이름의 낡은 항목이 공통 항목을 대체한다
- **WHEN** 운영 환경(게이트웨이 뒤)에 있는 회사의 `tenants.mcp.mcpServers`에 `pgpt-photocraft`가 `http://localhost:8787/mcp/photocraft`로 남아 있다
- **THEN** 에이전트는 그 주소를 받아 PhotoCraft 도구에 연결하지 못한다
- **AND** `agentToolsVia.craft.photocraft`는 `["tenant-overrides-common-with-other-url"]`이고, D-AT-photocraft가 「stale tenant MCP registration」으로 실패한다
