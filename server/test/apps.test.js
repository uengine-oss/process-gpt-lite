// Lite apps, contract v2 = MCP Apps (docs/robo-dlc/plan-mcp-apps.md): the manifests, each app's MCP server
// (its entry tool and ui:// screen), the import boundary, the record readers the apps stand on, and each
// app's own logic — no database, no server.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { builtinModules } from 'node:module'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { getToolUiResourceUri, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/app-bridge'
import { checkManifest, loadApps, list, appServer, callAppTool } from '../lib/apps/registry.js'
import { HOST_TOOLS } from '../lib/apps/host.js'
import * as R from '../lib/aidlc/record.js'
import { unitNow } from '../lib/aidlc/metrics.js'
import * as B from '../apps/review/board.js'
import { stageTimes, buildTree } from '../apps/bolts/tree.js'
import { renderDoc, findHeading } from '../apps/artifact/render.js'
import { navAllowed } from '../../src/apps/paths.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const APPS = path.join(HERE, '../apps')
const RUNTIME = path.join(HERE, '../lib/apps/runtime')
const P2 = path.join(HERE, 'fixtures/aidlc-p2/261109-team-todo-board')
const apps = fs.readdirSync(APPS, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)

// an app's MCP server as the host's client sees it (no person: nothing here reaches the database)
async function connect(id) {
  const { server, ctx } = appServer(id, null)
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '1.0.0' })
  await Promise.all([server.connect(a), client.connect(b)])
  return { client, close: () => Promise.all([client.close(), server.close(), ctx.close?.()]) }
}

// ---------- the contract ----------
test('앱 규약: 들어 있는 앱의 매니페스트는 모두 규약 v2 를 지키고, 홈 패널은 호스트에 들어 있다', async () => {
  assert.deepEqual(apps.sort(), ['artifact', 'bolts', 'review'])
  for (const id of apps) {
    const m = checkManifest(JSON.parse(fs.readFileSync(path.join(APPS, id, 'manifest.json'), 'utf8')), id)
    assert.equal(m.contract, 2)
    assert.ok(fs.existsSync(path.join(APPS, id, 'ui', 'index.html')), `${id} has a page`)
  }
  assert.deepEqual((await loadApps()).sort(), ['artifact', 'bolts', 'craft', 'panels', 'review'])
  assert.deepEqual(list().find((m) => m.id === 'panels').mounts, ['panel'])
  // only the ArtCraft screen asks for an origin of its own (the sandbox proxy); model-written panels never get one
  assert.deepEqual(list().filter((m) => m.origin).map((m) => m.id), ['craft'])
})

test('앱 규약: 잘못된 매니페스트는 무엇이 틀렸는지 말하고 거절된다', () => {
  const ok = { id: 'x-app', version: '2.0.0', contract: 2, name: { ko: '가', en: 'A' }, entry: 'x_open', mounts: ['folder'] }
  assert.equal(checkManifest(ok, 'x-app').entry, 'x_open')
  assert.throws(() => checkManifest(ok, 'other'), /id must match/)
  assert.throws(() => checkManifest({ ...ok, contract: 1 }, 'x-app'), /contract 1/)
  assert.throws(() => checkManifest({ ...ok, entry: undefined }, 'x-app'), /entry must name the tool/)
  assert.throws(() => checkManifest({ ...ok, entry: 'Open Screen' }, 'x-app'), /entry must name the tool/)
  assert.throws(() => checkManifest({ ...ok, mounts: ['folder', 'desktop'] }, 'x-app'), /unknown desktop/)
  assert.throws(() => checkManifest({ ...ok, handles: ['aidlc.everything'] }, 'x-app'), /unknown aidlc.everything/)
  assert.throws(() => checkManifest({ ...ok, name: { ko: '가' } }, 'x-app'), /name needs ko and en/)
})

// every app is an MCP server: its entry tool names a ui:// screen in the MCP Apps type, each tool belongs to
// that screen, and the watcher's hooks are hidden from a model
test('앱 규약: 앱마다 입구 도구가 MCP Apps 화면(ui://)을 가리키고, 감시기 훅은 모델에게 숨긴다', async () => {
  for (const m of list()) {
    const { client, close } = await connect(m.id)
    try {
      const { tools } = await client.listTools()
      const entry = tools.find((t) => t.name === m.entry)
      const uri = entry && getToolUiResourceUri(entry)
      assert.ok(uri?.startsWith(`ui://${m.id}/`), `${m.id}: entry ${m.entry} -> ${uri}`)
      const res = await client.readResource({ uri })
      assert.equal(res.contents[0].mimeType, RESOURCE_MIME_TYPE)
      assert.match(res.contents[0].text, /<script type="module"/)
      for (const t of tools) {
        assert.ok(getToolUiResourceUri(t)?.startsWith(`ui://${m.id}/`), `${m.id}: ${t.name} belongs to its own screen`)
        // the watcher's hooks are the host's, never a model's
        if (t.name.startsWith('lite_wait_')) assert.deepEqual(t._meta.ui.visibility, ['app'], `${m.id}: ${t.name}`)
      }
    } finally { await close() }
  }
  assert.equal(RESOURCE_MIME_TYPE, 'text/html;profile=mcp-app')
})

// an app's server code reaches Lite only through ctx (a client of lite-host); its screen only through the
// runtime. Server imports are its own files, node's, or a package the server declares; screen imports are its
// own files or ../../_runtime/
test('앱 규약: 앱 코드는 호스트 모듈을 import 하지 않는다(서버는 ctx, 화면은 런타임으로만)', () => {
  const deps = Object.keys(JSON.parse(fs.readFileSync(path.join(HERE, '../package.json'), 'utf8')).dependencies)
  const pkg = (spec) => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0])
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : d.name.endsWith('.js') ? [path.join(dir, d.name)] : []))
  const importsOf = (src) => [...src.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/gm)].map((m) => m[1] || m[2])
  for (const id of apps) {
    const root = path.join(APPS, id)
    for (const file of walk(root)) {
      const ui = file.startsWith(path.join(root, 'ui') + path.sep)
      for (const spec of importsOf(fs.readFileSync(file, 'utf8'))) {
        const where = `${path.relative(APPS, file)} imports ${spec}`
        if (ui) {
          const target = path.resolve(path.dirname(file), spec)
          assert.ok(spec.startsWith('.') && (target.startsWith(path.join(root, 'ui') + path.sep) || spec === '../../_runtime/lite.js'), where)
        } else if (spec.startsWith('.')) {
          assert.ok(path.resolve(path.dirname(file), spec).startsWith(root + path.sep), `${where} (outside its app)`)
        } else {
          assert.ok(builtinModules.includes(spec.replace(/^node:/, '').split('/')[0]) || deps.includes(pkg(spec)), where)
        }
      }
    }
  }
  // the runtime itself speaks only the standard App of @modelcontextprotocol/ext-apps
  assert.deepEqual(importsOf(fs.readFileSync(path.join(RUNTIME, 'lite.js'), 'utf8')), ['./ext-apps.js'])
  // what lite-host offers is a fixed list (a new tool there is a contract change)
  assert.ok(HOST_TOOLS.includes('aidlc_work') && HOST_TOOLS.includes('events_publish') && HOST_TOOLS.includes('notify_user'))
})

test('앱 규약: 한 앱이 깨져도 다른 앱은 올라오고, 앱 도구는 메모리 안 MCP 로 부른다', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-apps-'))
  const mk = (id, entry, server) => {
    fs.mkdirSync(path.join(dir, id))
    fs.writeFileSync(path.join(dir, id, 'manifest.json'), JSON.stringify({ id, version: '2.0.0', contract: 2, name: { ko: id, en: id }, entry, mounts: ['folder'] }))
    fs.writeFileSync(path.join(dir, id, 'server.js'), server)
  }
  const ok = (name, body) => `server.registerTool('${name}', { description: 'x' }, async () => (${body}))`
  mk('good-app', 'good_open', `export default (server, ctx) => {
    ${ok('good_open', "{ content: [], structuredContent: { value: { contract: ctx.contract, app: ctx.app.id, user: ctx.user } } }")}
    ${ok('good_deny', "{ isError: true, content: [{ type: 'text', text: 'no' }], structuredContent: { error: 'no', status: 403 } }")}
  }`)
  mk('bad-app', 'bad_open', 'throw new Error("boom")')
  mk('no-entry', 'missing_open', `export default (server) => { ${ok('other_tool', '{ content: [] }')} }`)
  assert.deepEqual((await loadApps(dir)).sort(), ['craft', 'good-app', 'panels'])
  assert.deepEqual(list().map((m) => m.id).sort(), ['craft', 'good-app', 'panels'])
  assert.deepEqual(await callAppTool('good-app', 'good_open'), { contract: 2, app: 'good-app', user: null })
  await assert.rejects(callAppTool('good-app', 'good_deny'), { status: 403, message: 'no' })
  await assert.rejects(callAppTool('no-entry', 'other_tool'), { status: 404 })
  await loadApps() // back to the real apps for the rest of the process
})

// the ArtCraft editors: one screen for every app, behind the sandbox proxy; an app this install lacks is refused
test('ArtCraft 앱: 입구 도구가 앱과 언어를 화면에 넘기고, 없는 앱은 404, 화면은 클립보드만 청한다', async () => {
  const { client, close } = await connect('craft')
  try {
    const { tools } = await client.listTools()
    assert.deepEqual(tools.map((t) => t.name), ['craft_open'])
    const bad = await client.callTool({ name: 'craft_open', arguments: { app: 'paintcraft' } })
    assert.equal(bad.isError, true)
    assert.equal(bad.structuredContent.status, 404)
    const page = await client.readResource({ uri: 'ui://craft/editor' })
    assert.deepEqual(page.contents[0]._meta.ui, { csp: {}, permissions: { clipboardWrite: {} } })
    assert.match(page.contents[0].text, /<iframe id="craft"/)
  } finally { await close() }
})

// the proxy page: framed only by Lite's pages, the hosts it answers written into it (no other parent gets the screen)
test('샌드박스 프록시: frame-ancestors 는 Lite 화면만, 프록시는 허락된 부모에게만 답하고 화면은 안쪽 틀에서 그 출처로', () => {
  const html = fs.readFileSync(path.join(RUNTIME, 'sandbox.html'), 'utf8')
  assert.match(html, /data-hosts="__HOSTS__"/)
  assert.match(html, /ui\/notifications\/sandbox-proxy-ready/)
  assert.match(html, /ui\/notifications\/sandbox-resource-ready/)
  assert.match(html, /if \(!hosts\.has\(e\.origin\) \|\| \(host && e\.origin !== host\)\) return/)
})

test('앱 화면의 링크: 정해진 Lite 화면으로만 옮긴다', () => {
  for (const ok of ['/workroom/aidlc/folder-1', '/aidlc/folder-1/decide', '/apps/artifact/folder-1?path=a.md', '/folders/folder-1']) assert.ok(navAllowed(ok), ok)
  for (const bad of ['https://evil.example', '/settings/admin', '//evil', '/workroom/folder/x', 'javascript:alert(1)', '/api/apps/review/mcp']) assert.ok(!navAllowed(bad), bad)
})

// ---------- the record readers ----------
test('질문 파일: 역할 태그, 묻는 이유, AI-DLC 추천과 그 이유를 읽는다', async () => {
  const qs = (await R.listQuestions(P2)).find((f) => f.stage === 'requirements-analysis').questions
  const q1 = qs.find((x) => x.id === 'Q1')
  assert.equal(q1.tag, '제품 관리자')
  assert.match(q1.note, /로그인/)
  assert.equal(q1.recommended, 'A')
  assert.equal(q1.why, '이번 범위를 가장 작게 유지')
  assert.ok(q1.options.find((o) => o.key === 'A').rec)
  // "(권장)" without a reason, and a file that says "각 질문의 A가 권장안" recommends A where no option says so
  const fileRec = R.parseQuestions('각 질문의 A가 권장안입니다.\n\n## Q1. [개발] 무엇으로?\n이유 한 줄\n\nA. 하나\nB. 둘\n\n[Answer]: \n')
  assert.equal(fileRec[0].recommended, 'A')
  assert.equal(fileRec[0].note, '이유 한 줄')
  assert.equal(R.parseQuestions('## Q2. [제품] 몇 명?\n\nA. 한 명\nB. 여러 명 (Recommended: simpler later)\n\n[Answer]: \n')[0].recommended, 'B')
  // a unit's construction questions: "### Q1." under "## …" sections, no role tag
  const h3 = R.parseQuestions('# 기능 설계 질문\n\n## 근거 문서\n\n- 계약 C3\n\n---\n\n### Q1. 규칙을 여러 개 어겼을 때 무엇을 알려 주나요?\n\n예를 들어 …\n\nA. 목록 모두\nB. 계약 순서\n\n[Answer]:\n\n### Q2. 겹침 문장에 시간을 넣나요?\n\nA. 넣는다\n\n[Answer]:\n')
  assert.deepEqual(h3.map((x) => [x.id, x.tag, x.options.length]), [['Q1', '', 2], ['Q2', '', 1]])
})

test('검토 파일: 지적의 위치·내용·고칠 일을 읽고, 위치를 기록 안 문서와 초점으로 바꾼다', async () => {
  const [rv] = await R.listReviews(P2)
  const r2 = rv.findings.find((f) => f.id === 'R-02')
  assert.match(r2.location, /decisions\.md > ADR-004, against requirements\.md FR7\.2/)
  assert.match(r2.finding, /FR7\.2/)
  assert.match(r2.action, /ADR-004/)
  const docs = await R.docList(P2)
  assert.deepEqual(R.resolveRefs(r2.location, docs, 'domain-design'), [
    { path: 'inception/domain-design/decisions.md', focus: 'ADR-004', label: 'decisions.md › ADR-004' },
    { path: 'inception/requirements-analysis/requirements.md', focus: 'FR7.2', label: 'requirements.md › FR7.2' },
  ])
  const r1 = R.resolveRefs(rv.findings.find((f) => f.id === 'R-01').location, docs, 'domain-design')
  assert.deepEqual(r1.map((x) => x.focus), ['ADR-002', '의도적 양방향 호출'])
  assert.deepEqual(R.resolveRefs('server/src/http/app.ts > jsonGate', docs), []) // code is not a record document
})

test('문서: 기록 안의 .md 만, 질문 밖 경로는 404', async () => {
  const d = await R.readDoc(P2, 'inception/domain-design/decisions.md')
  assert.equal(d.stage, 'domain-design')
  assert.match(d.text, /ADR-004/)
  for (const bad of ['../../../../etc/hosts', 'inception/domain-design/../../x.md', '/etc/hosts', 'audit/x.md']) await assert.rejects(R.readDoc(P2, bad), { status: 404 }, bad)
})

test('볼트 계획: 볼트마다 포함 유닛과 앞선 볼트', async () => {
  const units = (await R.readUnits(P2)).map((u) => u.name)
  assert.deepEqual(units, ['u1-todo-api', 'u2-board-web'])
  assert.deepEqual(await R.readBolts(P2, units), [
    { n: 1, name: '할 일 API', id: 'bolt-1-todo-api', units: ['u1-todo-api'], after: [] },
    { n: 2, name: '보드 화면', id: 'bolt-2-board-web', units: ['u2-board-web'], after: [1] },
  ])
  assert.deepEqual(R.parseBolts('## Bolt 1 — API (`bolt-1-api`)\n\n| Item | Detail |\n|---|---|\n| Units | U1 `u1-api` |\n'), [{ n: 1, name: 'API', id: 'bolt-1-api', units: ['u1-api'], after: [] }])
  // the other way (a real run): "## B2 — U2 `u2-…`" and a list line "- **포함 단위**: U2"
  const names = ['u1-walking-skeleton', 'u2-booking-rules', 'u3-identity']
  assert.deepEqual(R.parseBolts('## B1 — U1 `u1-walking-skeleton` ⟨walking skeleton⟩\n\n- **포함 단위**: U1\n\n## B2 — U2 `u2-booking-rules`\n\n- **포함 단위**: U2\n- **앞선 Bolt**: B1\n\n## 검증 명령\n', names), [
    { n: 1, name: 'walking skeleton', id: 'bolt-1', units: ['u1-walking-skeleton'], after: [] },
    { n: 2, name: 'u2-booking-rules', id: 'bolt-2', units: ['u2-booking-rules'], after: [1] },
  ])
})

// the code plan waits on the developer: the stage comes from the unit's events, not the state file
test('지금 유닛 단계: 유닛 사건이 단계를 정하고, 유닛이 끝난 뒤 전체 단계 사건이 오면 끝난다', () => {
  const e = (event, stage, unit = '') => ({ event, stage, unit })
  const run = [e('UNIT_STARTED', 'functional-design', 'u1'), e('UNIT_COMPLETED', 'functional-design', 'u1'), e('UNIT_STARTED', 'code-generation', 'u1')]
  assert.deepEqual(unitNow(run), { unit: 'u1', stage: 'code-generation', open: true, at: undefined })
  // the code plan for u2 is asked before u2's code-generation starts: PLAN_APPROVAL_* names it
  const plan = [...run, e('UNIT_COMPLETED', 'code-generation', 'u1'), e('UNIT_COMPLETED', 'infrastructure-design', 'u2'), e('PLAN_APPROVAL_BLOCKED', 'code-generation', 'u2')]
  assert.equal(unitNow(plan).stage, 'code-generation')
  assert.equal(unitNow(plan).unit, 'u2')
  // after the units: the whole-intent gates (no unit) and build-and-test
  assert.equal(unitNow([...plan, e('GATE_APPROVED', 'code-generation', 'u2'), e('STAGE_AWAITING_APPROVAL', 'functional-design')]), null)
  assert.equal(unitNow([...plan, e('STAGE_STARTED', 'build-and-test')]), null)
  assert.equal(unitNow([e('UNIT_STARTED', 'code-generation', '(missing marker)')]), null)
  // the code plan is written (and asked about) before any event names the unit's code-generation: the file's Context does
  const wrote = (ctx) => ({ event: 'ARTIFACT_CREATED', stage: '', unit: '', fields: { Context: ctx } })
  const infraDone = [e('UNIT_STARTED', 'infrastructure-design', 'u1'), e('UNIT_COMPLETED', 'infrastructure-design', 'u1'), e('GATE_APPROVED', 'infrastructure-design', 'u1')]
  assert.equal(unitNow(infraDone).stage, 'infrastructure-design')
  assert.deepEqual(unitNow([...infraDone, wrote('construction > u1 > code-generation > code-generation-plan.md')]), { unit: 'u1', stage: 'code-generation', open: true, at: undefined })
  assert.equal(unitNow([...infraDone, wrote('inception > units-generation')]).stage, 'infrastructure-design')
})

// ---------- the review board ----------
test('검토 보드: 질문 태그가 역할이 된다(실제 실행에서 본 태그)', () => {
  const want = { '제품': 'product', '제품 관리자': 'product', '제품 책임자': 'product', '아키텍트': 'architect', '아키텍처': 'architect', '개발': 'developer', '개발자': 'developer', '개발 리드': 'developer',
    '디자이너': 'design', '디자인': 'design', '품질': 'quality', '품질 엔지니어': 'quality', '딜리버리 리드': 'delivery', '운영': 'operations', '릴리스 엔지니어': 'pipeline-deploy', '': null, '기타': null }
  for (const [tag, role] of Object.entries(want)) assert.equal(B.roleOfTag(tag), role, tag)
})

test('검토 보드: 담당의 결정, 그 뒤의 이의, 다시 정하면 풀린다', () => {
  const it = { key: 'q:a#Q1@x', kind: 'question', recommended: 'A' }
  const at = (s) => new Date(Date.UTC(2026, 10, 11, 10, s)).toISOString()
  const reviewers = new Set(['po'])
  const m = (user_id, stance, s, extra = {}) => ({ item_key: it.key, user_id, stance, updated_at: at(s), ...extra })
  assert.equal(B.itemState(it, [], reviewers).state, 'open')
  assert.equal(B.itemState(it, [m('dev', 'agree', 1)], reviewers).state, 'open', 'not the reviewer: no decision')
  assert.equal(B.itemState(it, [m('po', 'agree', 1)], reviewers).state, 'decided')
  assert.equal(B.itemState(it, [m('po', 'agree', 1), m('arch', 'object', 2, { note: '왜' })], reviewers).state, 'discuss')
  assert.equal(B.itemState(it, [m('arch', 'object', 1, { note: '왜' }), m('po', 'choose', 3, { choice: 'B' })], reviewers).state, 'decided')
  assert.equal(B.itemState({ ...it, sent: true }, [m('arch', 'object', 1)], reviewers).state, 'sent')
  assert.equal(B.answerOf(it, { stance: 'agree' }), 'A')
  assert.equal(B.answerOf(it, { stance: 'choose', choice: 'C' }), 'C')
  assert.equal(B.answerOf(it, { stance: 'choose', choice: 'X', note: '회의실은 10개까지' }), 'X. 회의실은 10개까지')
  assert.equal(B.answerOf(it, null), null)
  assert.equal(B.answerOf(it, null, { useRecommended: true }), 'A')
})

test('검토 보드: 지적들의 결정이 승인 창의 답 하나가 된다', () => {
  const f = (id, stance, note) => ({ key: id, id, kind: 'finding', decision: stance && { stance, note } })
  const states = (list) => new Map(list.map((x) => [x.key, { decision: x.decision }]))
  const all = [f('R-01', 'accept'), f('R-02', 'accept')]
  assert.deepEqual(B.composeApproval(all, states(all)), { action: 'approve', text: '' })
  const rej = [f('R-01', 'accept'), f('R-03', 'reject', '계약 설계에서 다룸')]
  assert.equal(B.composeApproval(rej, states(rej)).action, 'approve-with-notes')
  assert.match(B.composeApproval(rej, states(rej)).text, /^Approve\. .*R-03 — 계약 설계에서 다룸/)
  const fix = [f('R-01', 'accept'), f('R-02', 'fix', 'FR7.2 를 칸 단위로 고쳐 적어 주세요'), f('R-03', 'reject', '해당 단계 아님')]
  const d = B.composeApproval(fix, states(fix))
  assert.equal(d.action, 'request-changes')
  assert.equal(d.text, 'Request Changes: 고쳐 주세요: R-02 — FR7.2 를 칸 단위로 고쳐 적어 주세요. 해당 없음: R-03 — 해당 단계 아님')
})

test('검토 보드: 근거 찾기는 질문의 낱말이 든 기록의 줄을 그 절과 함께 찾는다', async () => {
  const q = (await R.listQuestions(P2)).find((f) => f.stage === 'requirements-analysis').questions.find((x) => x.id === 'Q2')
  const terms = B.termsOf(`${q.text} ${q.note}`)
  assert.ok(terms.includes('담당자'), terms.join(','))
  assert.ok(!terms.includes('어떻게'))
  const docs = await Promise.all((await R.docList(P2)).filter((d) => !/-questions\.md$|\/reviews\//.test(d.path)).map((d) => R.readDoc(P2, d.path)))
  const hits = B.searchDocs(docs, terms)
  assert.ok(hits.length > 0)
  assert.ok(hits.every((h) => h.snippet && h.path.endsWith('.md') && h.label.includes(h.path.split('/').pop())))
  assert.ok(hits.some((h) => h.path === 'inception/requirements-analysis/requirements.md'))
})

// ---------- the bolt board ----------
test('볼트 보드: 볼트 → 유닛 → 구축 단계, 지금 도는 단계와 각 단계 시간', () => {
  const t0 = Date.UTC(2026, 10, 11, 9, 0)
  const ev = (min, event, stage, unit) => ({ t: t0 + min * 60000, event, stage, unit })
  const events = [ev(0, 'UNIT_STARTED', 'functional-design', 'u1'), ev(12, 'UNIT_COMPLETED', 'functional-design', 'u1'), ev(12, 'UNIT_STARTED', 'code-generation', 'u1')]
  const times = stageTimes(events, t0 + 30 * 60000)
  assert.equal(times.get('u1').get('functional-design').min, 12)
  assert.equal(times.get('u1').get('code-generation').min, 18)
  const units = [{ name: 'u1', kind: 'service', status: 'working', stages: { 'functional-design': 'done', 'code-generation': 'working' } }, { name: 'u2', kind: 'ui', status: 'blocked', stages: {} }, { name: 'u3', kind: 'worker', status: 'ready', stages: {} }]
  const tree = buildTree({ bolts: [{ n: 1, name: 'API', id: 'b1', units: ['u1'], after: [] }, { n: 2, name: '화면', id: 'b2', units: ['u2'], after: [1] }], units, times, now: { unit: 'u1', stage: 'code-generation', open: true } })
  assert.deepEqual(tree.map((b) => [b.id, b.status, b.units.map((u) => u.name)]), [['b1', 'working', ['u1']], ['b2', 'blocked', ['u2']], ['units', 'pending', ['u3']]])
  const u1 = tree[0].units[0]
  assert.ok(u1.running)
  assert.deepEqual(u1.stages.map((s) => s.state), ['done', 'pending', 'pending', 'pending', 'working'])
  assert.ok(u1.stages[4].now)
})

// ---------- the document viewer ----------
test('산출물 보기: 원문 HTML 은 글자로, 링크는 스스로 열리지 않고, 절마다 id, 초점 절을 이름으로 찾는다', () => {
  const r = renderDoc('# 결정\n\n## ADR-004: 바뀐 칸만 저장\n\n## Status: Accepted\n\n본문 <script>alert(1)</script> <img src=x onerror=alert(1)>\n\n[나쁜](javascript:alert(1)) [좋은](https://example.com)\n\n## ADR-005: 다음\n')
  assert.ok(!r.html.includes('<script>') && !r.html.includes('<img'))
  assert.ok(!/\shref=/.test(r.html), 'no live links')
  assert.match(r.html, /data-href="https:\/\/example.com"/)
  assert.match(r.html, /data-ref="javascript:alert\(1\)"/)
  assert.deepEqual(r.headings.map((h) => h.text), ['결정', 'ADR-004: 바뀐 칸만 저장', 'Status: Accepted', 'ADR-005: 다음'])
  assert.equal(findHeading(r.headings, 'ADR-004').text, 'ADR-004: 바뀐 칸만 저장')
  assert.equal(findHeading(r.headings, 'adr 005').text, 'ADR-005: 다음')
  assert.equal(findHeading(r.headings, 'FR7.2'), null)
  // a focus that says more than the heading: its leading words
  assert.equal(findHeading(r.headings, 'ADR-004 Decision 1단계').text, 'ADR-004: 바뀐 칸만 저장')
  assert.equal(findHeading(r.headings, '"결정" 아래 문단').text, '결정')
  assert.equal(r.title, '결정')
})
