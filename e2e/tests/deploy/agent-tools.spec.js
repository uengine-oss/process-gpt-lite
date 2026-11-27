// 설치된 도구는 에이전트에게도 이어져 있어야 한다 (spec openspec/specs/agent-tools). No sign-in, read only: GET <lite>/api/config.
// 2026-11-25 운영: PhotoCraft 를 열어 둔 채 「배경색을 옅은 하늘색으로」 → 에이전트 「PhotoCraft 편집 도구가 현재 연결되지 않아 …」.
// The editor and the CLI were on the server (C-IN-* passed) but the company's agent did not get the tool server: process-gpt's
// deepagents loaded only the tenant's tenants.mcp.mcpServers, and the craft entries were not there. Locally those entries exist,
// so every local suite passed. Since then the built-in tools reach every company through deepagents' common MCP list
// (COMMON_MCP_SERVERS); this is the check that fails when one of them still does not reach the agent.
//   - D-AT-00   the server reports agentTools (server/lib/agentTools.js); an older server is a failure, not a pass
//   - D-AT-<app> every ArtCraft app whose web editor and CLI are installed (/api/config craft: web && cli) is wired
//   - D-AT-office the IeumOffice editor is served (/office/sheets/ is the editor page) → its live-editing tools are wired
//   - D-AT-folders · panelapps · improve · mail: built in everywhere → wired (mail: 「내 계정으로 보내기」, server mcp/mail.js)
// agentToolsVia labels what made each one true (tenant · common) and what stops one: tenant-overrides-common-with-other-url (the
// company's own entry of the built-in name points elsewhere and replaces the common one), hub-filtered (an mcp-hub that does not
// have it; local development only) — labels only, no addresses.
//   PGPT_ROOT_URL=https://uengine.process-gpt.io npx playwright test --project=deploy tests/deploy/agent-tools.spec.js
//   (a local server: PGPT_LITE_URL=http://localhost:8787; a Docker install: PGPT_LITE_URL=http://localhost:18080)
import { test, expect } from '@playwright/test'

const LITE = (process.env.PGPT_LITE_URL || `${(process.env.PGPT_ROOT_URL || 'http://localhost:8088').replace(/\/$/, '')}/lite`).replace(/\/$/, '')
const APPS = ['cadcraft', 'vectorcraft', 'photocraft', 'soundcraft', 'filmcraft']
const SERVER = { office: 'pgpt-ieumoffice-live-editor', folders: 'pgpt-folders', panelapps: 'pgpt-panelapps', improve: 'pgpt-improve', ...Object.fromEntries(APPS.map((a) => [a, `pgpt-${a}`])) }
const PATH = { office: 'ieumoffice-live-editor (or /mcp/office)' }
const TOO_OLD = `this install's server is too old to report agentTools (${LITE}/api/config has no agentTools field) — deploy a server with lib/agentTools.js and run again; until then nothing says the agent gets its tools`

let cfg = null
test.beforeAll(async ({ request }) => {
  const r = await request.get(`${LITE}/api/config`)
  expect(r.status(), `${LITE}/api/config`).toBe(200)
  cfg = await r.json()
})

// (via: tenant · common, tenant-overrides-common-with-other-url, hub-filtered — server/lib/agentTools.js)
const missing = (name, via) => `${name}: installed here, but this company's agent does not get the ${SERVER[name]} tool server — `
  + ((via || []).includes('tenant-overrides-common-with-other-url')
    ? `stale tenant MCP registration: the company's own ${SERVER[name]} entry in tenants.mcp.mcpServers points somewhere else and replaces the common one `
      + `(point it at <lite server>/mcp/${PATH[name] || name} or remove it).`
    : (via || []).includes('hub-filtered')
      ? `the mcp-hub this server reaches does not have ${SERVER[name]}, so the agent's tool list leaves it out (register it in the hub).`
      : `missing tenant MCP registration (deepagents' common MCP list — COMMON_MCP_SERVERS — does not carry ${SERVER[name]} here, and no enabled `
        + `tenants.mcp.mcpServers entry reaches <lite server>/mcp/${PATH[name] || name} with Authorization: Bearer {{user_jwt}}; `
        + `or the company switched it off with "${SERVER[name]}": {"enabled": false}).`)
  + ` Sources seen: ${JSON.stringify(via ?? null)}`

function expectWired(name, value, via) {
  expect(cfg.agentTools, TOO_OLD).toBeTruthy()
  expect(value, missing(name, via)).toBe(true)
}

test('D-AT-00 서버가 도구 연결 상태(agentTools)를 알린다', () => {
  expect(cfg.agentTools, TOO_OLD).toBeTruthy()
  // booleans only: no address, header or key in the answer
  expect(JSON.stringify(cfg.agentTools)).not.toMatch(/http|\/mcp|Bearer|user_jwt/)
  expect(JSON.stringify(cfg.agentToolsVia || {})).not.toMatch(/http|\/mcp|Bearer|user_jwt/)
})

for (const app of APPS) {
  test(`D-AT-${app} 설치된 ${app} 는 에이전트 도구로도 이어져 있다`, () => {
    const c = cfg.craft?.[app]
    test.skip(!(c?.web && c?.cli), `${app} 웹 편집기·CLI 가 이 설치에 없음 (/api/config craft.${app} = ${JSON.stringify(c ?? null)})`)
    expectWired(app, cfg.agentTools?.craft?.[app], cfg.agentToolsVia?.craft?.[app])
  })
}

test('D-AT-office 이음오피스 편집기가 열리는 설치는 그 편집 도구도 이어져 있다', async ({ request }) => {
  const r = await request.get(`${LITE}/office/sheets/`)
  // the editor's own page (office-host: its preload script), not the app's page or a 404
  const served = r.status() === 200 && (r.headers()['content-type'] || '').includes('text/html') && (await r.text()).includes('/_preload/')
  test.skip(!served, `이음오피스 편집기를 내지 않는 설치 (${LITE}/office/sheets/ → ${r.status()})`)
  expectWired('office', cfg.agentTools?.office, cfg.agentToolsVia?.office)
})

for (const name of ['folders', 'panelapps', 'improve', 'mail']) {
  test(`D-AT-${name} 기본 도구 ${name} 는 늘 이어져 있다`, () => {
    expectWired(name, cfg.agentTools?.[name], cfg.agentToolsVia?.[name])
  })
}
