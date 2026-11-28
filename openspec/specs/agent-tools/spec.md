# 에이전트 도구 연결 — 설치된 도구는 에이전트에게도 이어져 있어야 한다

## Purpose
2026-11-25 사용자가 운영 환경에서 다음과 같이 보고했다: 「photocraft 도 채팅과 연결이 안되네.. 전체적으로 도구들의 mcp 를 통한 제어가 기본 스펙인데 문제가 있군 회귀테스트를 돌려」.

운영 화면에서 `image.png`를 PhotoCraft로 열어 둔 채 「배경색을 옅은 하늘색으로」라고 요청하자 에이전트는 「PhotoCraft 편집 도구가 현재 연결되지 않아 열린 image.png 의 배경색을 바로 변경하지 못했어요.」라고 답했다. 앞서 이음오피스에서 「AI 수정 요청」과 채팅을 통한 수정이 반영되지 않은 것도 같은 증상이었다.

서버에는 편집기와 CLI가 설치되어 있었다(`/lite/api/config`의 `craft`에서 다섯 앱 모두 `{web: true, cli: true}`였고, 설치 확인 C-IN-*도 통과했다). 하지만 당시 ProcessGPT의 에이전트(process-gpt-deepagents)는 회사(테넌트)의 `tenants.mcp.mcpServers`에 등록된 MCP 서버만 불러왔고, 그 목록에는 ArtCraft 도구가 없었다. 로컬에서는 목록이 채워져 있어 회귀 시험이 모두 통과했다. 화면은 열리지만 에이전트는 그 화면을 수정하지 못하는 상태를 어떤 시험도 잡아내지 못했다.

같은 날 사용자는 다음과 같이 결정했다: 「기본 툴들은 공통 mcp 이므로, 테넌트에 따로 등록 관계없이 등록될 수 있도록」. 이제 deepagents는 공통 MCP 목록(`COMMON_MCP_SERVERS`, process-gpt-k8s의 `process-gpt-deepagents-config`)을 모든 회사의 목록에 합치고, 공통 목록에 있는 이름을 `GET /mcp/common`으로 알린다(deepagents e28c370, 설정과 함께 운영에 반영). 이 스펙은 기본 도구가 실제로 에이전트에 연결되어 있는지를 Lite가 알리고, 운영 점검에서 이를 확인하는 방법을 다룬다. 공통 목록 자체의 규칙은 craft-apps 스펙의 「기본 도구는 모든 회사의 에이전트에 공통 MCP 로 이어진다」에 있다.

- 기본 도구(10개, `server/mcp/toolServers.js`의 단일 목록): 공유 폴더 `pgpt-folders` · 패널 앱 `pgpt-panelapps` · 프로세스 개선 `pgpt-improve` · ArtCraft 5종 `pgpt-cadcraft` · `pgpt-vectorcraft` · `pgpt-photocraft` · `pgpt-soundcraft` · `pgpt-filmcraft` · 이음오피스 `pgpt-ieumoffice-live-editor` · 내 계정으로 보내기 `pgpt-mail`(2026-11-27, 스펙 `mail-reply-review`). 서버 경로는 `/mcp/<pgpt- 를 뺀 이름>`이다(이음오피스는 `/mcp/office`도 같은 경로로 취급한다). 로컬 mcp-hub가 묶는 목록(`server/mcp/connectors.js`)도 이 목록이다.
- 연결 여부 판단: `server/lib/agentTools.js` → `GET /api/config`의 `agentTools`(참 · 거짓), `agentToolsVia`(이름표).
- 운영 점검: `e2e/tests/deploy/agent-tools.spec.js`(D-AT-*, 로그인 없이 읽기만 수행).

## Requirements

### Requirement: 설치된 도구는 에이전트에게도 이어져 있어야 한다 — 운영 점검이 이를 확인한다
시스템은 `/api/config`에서 이 회사의 에이전트가 각 기본 도구 서버를 전달받는지 알려야 한다(SHALL). 값으로는 참 · 거짓과 이름표만 제공하며, MCP 주소 · 헤더 · 키는 제공하지 않는다. 회사는 다른 `/api/config` 값과 같은 방법으로 결정한다(게이트웨이 뒤에서는 주소에 해당하는 회사).

도구가 아래 조건 중 하나를 충족하면 연결된 것으로 본다.
- **common**: deepagents의 공통 목록(`/mcp/common`)에 해당 이름이 있고, 에이전트가 전달받는 항목이 그 공통 항목이다.
- **tenant**: 회사의 MCP 목록에 활성화된 항목이 있고, 그 주소가 이 서버의 `/mcp/<경로>`로 끝나며, 사용자의 토큰(`Authorization: Bearer {{user_jwt}}`)을 전달한다. 항목 이름은 설치마다 다르므로 이름이 아닌 주소로 판단한다. 에이전트가 다른 곳(게이트웨이 뒤, Docker)에서 실행되면 `localhost` 주소로는 이 서버에 도달할 수 없는 것으로 본다.

회사 목록에 같은 이름의 항목이 있으면 회사 항목이 우선한다(deepagents의 규칙). 주소나 명령이 있는 항목은 공통 항목 전체를 대체한다. 주소가 없는 항목은 공통 항목에 덧씌워지며, `enabled: false`이면 해당 도구를 비활성화한다. 같은 이름의 항목이 다른 곳을 가리키면 이름표에 `tenant-overrides-common-with-other-url`이 붙고, 연결되지 않은 것으로 본다.

mcp-hub는 연결의 출처가 아니다. 허브는 에이전트에 연결을 제공하지 않고, 허용하지 않은 서버를 걸러 내기만 한다. 따라서 허브가 응답했지만 그 목록에 해당 이름이 없으면 이름표에 `hub-filtered`가 붙고, 연결되지 않은 것으로 본다(로컬 개발에만 해당하며, 운영에는 허브가 없다).

회사 목록을 읽지 못하면(데이터베이스 오류 · 시간 초과) 모든 도구가 연결되지 않은 것으로 응답한다. 공통 목록이나 허브가 응답하지 않으면(공통 목록이 없는 deepagents는 404) 응답하지 않은 쪽만 판단에서 제외한다. 응답은 1분 동안 캐시한다.

운영 점검(D-AT-*)에서는 웹 편집기와 CLI가 모두 설치된 각 ArtCraft 앱이 연결되어 있어야 한다고 본다. 이음오피스 편집기를 제공하는 설치에서는 이음오피스 편집 도구도 연결되어 있어야 하며, 공유 폴더 · 패널 앱 · 프로세스 개선 · 내 계정으로 보내기는 항상 연결되어 있어야 한다. 하나라도 연결되지 않았으면 점검은 실패하고, 메시지에 해당 도구 이름과 「회사 MCP 등록이 없다」(또는 「회사 항목이 다른 곳을 가리킨다」, 「허브에 없다」)를 적는다. `agentTools`를 알리지 않는 서버는 통과시키지 않고 「이 설치의 서버가 너무 오래돼 알 수 없다」라는 메시지와 함께 실패로 처리한다.

#### Scenario: PhotoCraft 가 회사 목록에도 공통 목록에도 없다
- **WHEN** 서버에 PhotoCraft 웹 편집기와 CLI가 있고(`craft.photocraft`가 `{web: true, cli: true}`), 회사의 MCP 목록에 PhotoCraft를 가리키는 항목이 없으며, deepagents의 공통 목록에도 `pgpt-photocraft`가 없다(또는 `/mcp/common`이 404)
- **THEN** `/lite/api/config`의 `agentTools.craft.photocraft`는 `false`이고, `agentToolsVia.craft.photocraft`는 `[]`이다
- **AND** `PGPT_ROOT_URL=https://<회사>.process-gpt.io`로 실행한 D-AT-photocraft가 「photocraft: … missing tenant MCP registration …」이라는 메시지와 함께 실패한다

#### Scenario: 공통 목록으로 회사마다 등록하지 않아도 이어진다
- **WHEN** deepagents의 `/mcp/common`이 `pgpt-photocraft`를 알리고, 회사 목록에는 그 이름의 항목이 없다
- **THEN** `agentTools.craft.photocraft`는 `true`이고, 이름표는 `["common"]`이다
- **AND** 회사 목록에 `"pgpt-photocraft": {"enabled": false}`를 넣으면 `false`가 된다(회사가 비활성화한 도구)

#### Scenario: 다른 설치에서 옮겨 온 낡은 항목이 공통 항목을 덮는다
- **WHEN** 게이트웨이 뒤의 회사 목록에서 `pgpt-photocraft`가 `http://localhost:8787/mcp/photocraft`를 가리키고, 공통 목록에도 `pgpt-photocraft`가 있다
- **THEN** 에이전트는 회사 항목을 전달받으므로 `agentTools.craft.photocraft`는 `false`이고, 이름표는 `["tenant-overrides-common-with-other-url"]`이다
- **AND** D-AT-photocraft가 「stale tenant MCP registration … points somewhere else and replaces the common one」이라는 메시지와 함께 실패한다

#### Scenario: 이 서버를 가리키는 회사 항목
- **WHEN** 회사 목록에 이름은 다르지만(`my-photo`) 활성화되어 있고, 주소가 이 서버의 `/mcp/photocraft`이며, `Authorization: Bearer {{user_jwt}}`를 전달하는 항목이 있다
- **THEN** `agentTools.craft.photocraft`는 `true`이고, 이름표에 `tenant`가 있다
- **AND** 그 항목이 비활성화되어 있거나(`enabled: false`), 다른 경로(`/mcp`, `/mcp/photocraft-old`)를 가리키거나, 토큰을 전달하지 않으면 `false`이다

#### Scenario: 허브만으로는 이어지지 않는다
- **WHEN** 로컬 mcp-hub의 목록에는 `pgpt-photocraft`가 있지만, 회사 목록과 공통 목록에는 모두 PhotoCraft가 없다
- **THEN** `agentTools.craft.photocraft`는 `false`이다
- **AND** 공통 목록에 `pgpt-cadcraft`가 있어도 허브가 응답한 목록에 그 이름이 없으면 `agentTools.craft.cadcraft`는 `false`이고, 이름표는 `["common", "hub-filtered"]`이다

#### Scenario: 회사 목록을 읽지 못한다
- **WHEN** 데이터베이스가 응답하지 않는다
- **THEN** `/api/config`는 지체 없이 응답하고(약 2.5초 안), `agentTools`는 모두 `false`이다

#### Scenario: 로컬 개발 설치
- **WHEN** 로컬 회사(localhost)의 MCP 목록에 9개 항목이 모두 `http://localhost:8787/mcp/<경로>` 주소로 등록되어 있고, mcp-hub의 목록에도 9개가 모두 있다
- **THEN** `agentTools`는 모두 `true`이고, 이름표는 `["tenant"]`이며, D-AT-* 10개가 통과한다

### Requirement: MCP 경로도 화면 API 와 같은 로그인 확인을 쓴다
시스템은 이 서버의 모든 MCP 경로(`/mcp`, `/mcp/<연결>`, 기본 도구의 `/mcp/<경로>`)에서 화면 API 의 로그인 확인(`auth()`)과 같은 규칙으로 사람을 확인해야 한다(SHALL). 규칙은 한 곳(`server/lib/mcpAuth.js`)에 있다.
- 토큰이 없거나 `{{user_jwt}}` 가 채워지지 않은 요청은 사람이 없는 요청으로 보고, 익명 도구 목록을 그대로 준다(mcp-hub 검증 · D-AT). 도구 호출은 「unauthorized」로 답한다.
- 로그인 서버가 받지 않는 토큰은 401, 로그인 서버가 답하지 못하면 503 과 `X-Auth-Retry: 1` 이다.
- 게이트웨이 뒤(`PRO_TENANT_FROM_HEADER=1`)에서 토큰에 회사(`app_metadata.tenant_id`)가 들어 있으면 — MCP 경로는 그 회사에서 일한다 — 그 사람은 그 회사의 구성원(`public.users`)이어야 하며, 아니면 403 이다(화면 API 와 같다). 토큰에 회사가 없으면 예전과 같다(거절하지 않고, 회사는 예전처럼 정해진다).
- 호스트 이름별 회사(`PRO_TENANT_HOSTS`)에서는 그 사람의 회사에서 실행한다. 한 회사 설치에서는 예전과 같다.

#### Scenario: 회사 소속까지 화면 API 와 같은 규칙
- **WHEN** 게이트웨이 뒤에서 에이전트가 `Authorization: Bearer <사람의 토큰>` 으로 `/mcp/folders` 를 부르고, 토큰에 든 회사가 A 이다
- **THEN** 그 사람이 A 의 구성원이면 도구가 A 에서 실행되고, 구성원이 아니면 모든 MCP 경로가 403 `not a member of this tenant` 로 답한다
- **AND** 토큰에 회사가 없으면 예전처럼 실행된다
- **AND** 한 회사 설치와 호스트 이름별 회사 설치에서는 같은 사람의 호출이 예전처럼 실행되고, 토큰이 없거나 `{{user_jwt}}` 그대로인 요청은 익명 도구 목록을, 잘못된 토큰은 401 을 받는다(시험 `server/test/mcpAuth.integration.test.js` MA-01~06)
