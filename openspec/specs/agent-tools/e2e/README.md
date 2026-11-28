# 시험과 증거

## 단위 (데이터베이스 · 모델 없이)

```bash
cd server && node --test test/agentTools.test.js
```

| 스펙 시나리오 | 시험 |
|---|---|
| PhotoCraft 가 회사 목록에도 공통 목록에도 없다 | 「회사 행이 없으면(null) …」, 「공통 목록이 아직 없는 deepagents(404) …」 |
| 공통 목록으로 회사마다 등록하지 않아도 이어진다 | 「공통 목록: deepagents 의 GET /mcp/common …」, 「common 과 회사의 같은 이름 항목: url 이 없으면 그 위에 얹힌다 …」 |
| 다른 설치에서 옮겨 온 낡은 항목이 공통 항목을 덮는다 | 「common 과 회사의 같은 이름 항목: url 이 있으면 통째로 바뀐다 …」, 「localhost 주소: …」 |
| 이 서버를 가리키는 회사 항목 | 「tenant: 키가 아니라 주소로 …」, 「tenant: 꺼진 항목 …」, 「tenant: 다른 곳을 가리키는 주소 · 토큰을 넘기지 않는 항목은 아님」 |
| 허브만으로는 이어지지 않는다 | 「hub: 허브만으로는 이어지지 않는다 …」, 「허브: 닿으면 그 회사의 서버 목록(X-Tenant-Id)을 보고, 없는 이름만 거른다」 |
| 회사 목록을 읽지 못한다 | 「회사 목록을 읽지 못하면(undefined) …」, 「회사 목록 읽기 오류 → 모두 false, 10초 뒤 다시 읽는다 …」, 「회사 목록이 시간 안에 오지 않으면 false …」 |
| (이름이 한 목록) | 「이름은 한 목록: …」 — `mcp/toolServers.js` = `mcp/craft.js` CRAFT_APPS · `mcp/office.js` OFFICE_MCP · `mcp/connectors.js` ALWAYS |

2026-11-25: 17개 통과.

## MCP 경로의 로그인 확인 (실제 개발 DB · 로컬 GoTrue)

```bash
cd server && node --test --test-concurrency=1 test/mcpAuth.integration.test.js
```

「MCP 경로도 화면 API 와 같은 로그인 확인을 쓴다」: 설정마다 MCP 경로만 띄운 서버(`test/fixtures/mcpAuthServer.mjs`)에 모든 MCP 경로(19개)를 부른다 — MA-01 한 회사 설치 · MA-02 게이트웨이 뒤(토큰에 든 회사의 구성원인지) · MA-03 게이트웨이 뒤, 토큰에 회사가 없으면 예전과 같음 · MA-04 호스트 이름별 회사 · MA-05 익명 목록 · `{{user_jwt}}` · 잘못된 토큰 401 · MA-06 로그인 서버가 답하지 못할 때 503.

2026-11-29: 4개 통과.

## 운영 점검 (Playwright, `e2e/tests/deploy/agent-tools.spec.js`, 로그인 없이 읽기만)

```bash
cd e2e
PGPT_ROOT_URL=https://uengine.process-gpt.io npx playwright test --project=deploy tests/deploy/agent-tools.spec.js
PGPT_LITE_URL=http://localhost:5180 npx playwright test --project=deploy tests/deploy/agent-tools.spec.js   # 로컬
```

2026-11-25:
- 로컬(BFF `PRO_BACKGROUND=0` :8960 + Vite :5360 + office-host :5400, 회사 localhost, mcp-hub 있음): 10개 통과. deepagents(:8888) 의 `/mcp/common` 은 404(공통 목록 이전 이미지) — 그 출처만 빠졌다. (허브를 출처로 세던 첫 판에서는 `["hub", "tenant"]`; 허브를 거르기만 하는 지금 판에서는 `["tenant"]`.)
- 운영(`https://uengine.process-gpt.io/lite`, 이 서버 변경 배포 전): 10개 모두 「this install's server is too old to report agentTools …」로 실패. `craft` 는 다섯 앱 모두 `{web: true, cli: true}`, `/lite/office/sheets/` 는 편집기 페이지.
- 배포 뒤의 모습(가짜 `/api/config`: craft 다섯 앱 false, photocraft 는 낡은 같은 이름 항목): D-AT-cadcraft · vectorcraft · soundcraft · filmcraft 가 「… missing tenant MCP registration …」, D-AT-photocraft 가 「… stale tenant MCP registration …」로 실패, 나머지 5개 통과.

## 스모크

`e2e/tests/smoke/health-auth.spec.js` S-01: `/api/config` 의 `agentTools` 가 있고, 답에 `/mcp/` · `user_jwt` · `Bearer` 가 없다.
