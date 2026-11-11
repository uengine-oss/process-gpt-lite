// Robo-DLC Lite P2 end to end against a running server (docs/robo-dlc/plan-review.md), the apps as MCP Apps
// (docs/robo-dlc/plan-mcp-apps.md: each app's tools over MCP Streamable HTTP as the signed-in person): the review board
// (role lanes from the question tags, cards to each reviewer, who looks at what, stances, evidence, one
// send into the question file; the approval's findings as one decision into the session), the document
// viewer (focus, the record only), the bolt board and a Home panel. The session is the stand-in of aidlc-team.e2e
// (a Claude Code prompt screen in tmux that records the keys it gets) — no model calls.
// Needs the server with the watcher on (PRO_E2E_API, PRO_AIDLC_WATCH=1); skipped when it is not up.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { pool, q } from '../lib/supa.js'
import { config } from '../config.js'

const API = process.env.PRO_E2E_API || 'http://127.0.0.1:8787/api'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.join(HERE, 'fixtures', 'aidlc-project')
const SCREEN = path.join(HERE, 'fixtures', 'aidlc-screens', 'approval.txt')
const INTENT = 'aidlc/spaces/default/intents/261109-todo-web-app'
const up = await fetch(`${API}/config`).then((r) => r.ok).catch(() => false)
const login = async (email) => (await (await fetch(`${API}/auth/email/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, code: '000000' }) })).json())
const call = async (who, method, p, body) => {
  const r = await fetch(`${API}${p}`, { method, headers: { Authorization: `Bearer ${who.session.access_token}`, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) })
  return { status: r.status, body: await r.json().catch(() => null) }
}
// a tool of an app's MCP server (/api/apps/<id>/mcp) as one person — what the host's AppFrame does
async function tool(who, app, name, args = {}) {
  const client = new Client({ name: 'e2e', version: '1.0.0' })
  const headers = who ? { Authorization: `Bearer ${who.session.access_token}` } : {}
  await client.connect(new StreamableHTTPClientTransport(new URL(`${API}/apps/${app}/mcp`), { requestInit: { headers } }))
  try {
    const r = await client.callTool({ name, arguments: args })
    return r.isError ? { status: r.structuredContent?.status || 500, body: { error: r.structuredContent?.error || r.content?.[0]?.text } } : { status: 200, body: r.structuredContent?.value }
  } finally { await client.close() }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms, what) {
  const end = Date.now() + ms
  while (Date.now() < end) { const v = await fn().catch(() => null); if (v) return v; await sleep(1000) }
  throw new Error(`timeout: ${what}`)
}
const tmux = (...a) => execFileSync('tmux', ['-L', config.aidlcTmuxSocket, ...a], { encoding: 'utf8' })
const cards = async (who, slug) => ((await call(who, 'GET', '/notifications')).body || []).filter((n) => n.type === 'aidlc' && String(n.url).startsWith(`/apps/review/${slug}`))

// three questions, each for a role, with the engine's recommendation; a review of the stage with two findings
const QUESTIONS = `# Requirements Analysis — Questions

각 질문의 A가 권장안입니다.

## Q1. [제품] 완료한 할 일을 다시 미완료로 되돌릴 수 있어야 하나요?

완료 표시가 토글인지 일방향인지에 따라 화면과 저장이 달라집니다.

- A. 다시 누르면 미완료로 돌아간다 (권장: 실수로 누른 것을 되돌릴 수 있음)
- B. 한 번 완료하면 되돌릴 수 없다
- X. Other (please specify)

[Answer]:

## Q2. [아키텍트] 할 일은 어디에 저장할까요?

새로고침 뒤에도 남아야 합니다.

- A. 브라우저 localStorage (권장: 서버 없이 가장 단순)
- B. 서버의 SQLite 파일
- X. Other (please specify)

[Answer]:

## Q3. [개발] 빈 입력은 어떻게 처리하나요?

잘못된 입력의 기대 동작을 정해야 테스트할 수 있습니다.

- A. 추가하지 않고 입력창을 그대로 둔다 (권장)
- B. 추가하지 않고 짧은 안내 문구를 보여 준다
- X. Other (please specify)

[Answer]:
`
const REQUIREMENTS = `# 요구사항 — 할 일 앱

## FR1 할 일 추가

- FR1.1 제목을 적고 Enter 를 누르면 목록 끝에 추가된다.

## FR2 완료 표시

- FR2.1 체크를 누르면 완료로 표시된다. 완료한 할 일을 다시 누르면 미완료로 되돌린다.

## NFR 저장

- 새로고침 뒤에도 할 일이 남는다(localStorage 저장).
`
const REVIEW = `## Review

**Verdict:** READY
**Reviewer:** aidlc-product-reviewer-agent
**Iteration:** 1

### Findings

| ID | Severity | Location | Finding | Required action | Status |
|---|---|---|---|---|---|
| R-01 | Minor | ${INTENT}/inception/requirements-analysis/requirements.md > FR2 완료 표시 | 되돌리기의 키보드 동작이 없다. | FR2 에 키보드로 되돌리는 동작을 한 줄 더한다. | New |
| R-02 | Minor | requirements.md > NFR 저장 | 저장 용량을 넘을 때의 동작이 없다. | 넘으면 알리고 저장하지 않는다고 적는다. | New |
`

let lead, po, arch, dev, out, repo, folder, name, keys

test('준비: AI-DLC 저장소(질문 셋·검토 지적 둘), 팀 리드(소유)·PO·아키텍트(편집)·개발자(보기), 역할', { skip: !up }, async () => {
  const stamp = Date.now()
  ;[lead, po, arch, dev, out] = await Promise.all(['lead', 'po', 'arch', 'dev', 'out'].map((x) => login(`rdlc-board-${x}-${stamp}@pgpt.test`)))
  repo = await fs.mkdtemp(path.join(os.tmpdir(), 'aidlc-board-'))
  await fs.cp(FIXTURE, repo, { recursive: true })
  const ra = path.join(repo, INTENT, 'inception/requirements-analysis')
  await fs.writeFile(path.join(ra, 'requirements-analysis-questions.md'), QUESTIONS)
  await fs.writeFile(path.join(ra, 'requirements.md'), REQUIREMENTS)
  const git = (...a) => execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@pgpt.test', ...a], { cwd: repo })
  git('init', '-q', '-b', 'main'); git('add', '-A'); git('commit', '-q', '-m', 'AI-DLC record')
  const r = await call(lead, 'POST', '/folders/link', { path: repo, name: `검토 보드 시험 ${stamp}` })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  folder = r.body
  for (const [who, role] of [[po, 'editor'], [arch, 'editor'], [dev, 'viewer']]) assert.equal((await call(lead, 'POST', `/folders/${folder.slug}/members`, { type: 'user', id: who.user.id, role })).status, 200)
  for (const [key, who] of [['product', po], ['architect', arch], ['developer', dev]]) assert.equal((await call(lead, 'PUT', `/aidlc/${folder.slug}/roles`, { roleKey: key, userIds: [who.user.id] })).status, 200)
  // the apps this folder gets (it holds an AI-DLC record)
  const apps = (await call(po, 'GET', `/apps/for/${folder.slug}`)).body
  assert.deepEqual(apps.filter((a) => a.mounts.includes('folder')).map((a) => a.id).sort(), ['artifact', 'bolts', 'review'])
  assert.deepEqual(apps.find((a) => a.id === 'panels')?.mounts, ['panel'], 'the Home panels app comes with the host')
})

test('검토 보드: 질문이 기다리면 PO(결정)와 아키텍트·개발자(자기 카드)에게 각자 카드가 간다', { skip: !up }, async () => {
  const poCard = await until(async () => (await cards(po, folder.slug))[0], 30000, 'the PO card')
  assert.match(poCard.title, /질문 3개/)
  const archCard = await until(async () => (await cards(arch, folder.slug))[0], 30000, 'the architect card')
  assert.match(archCard.title, /검토할 질문 1개 \(아키텍트\)/)
  assert.match(archCard.text, /Q2\. 할 일은 어디에 저장할까요/)
  const devCard = await until(async () => (await cards(dev, folder.slug))[0], 30000, 'the developer card')
  assert.match(devCard.title, /검토할 질문 1개 \(개발자\)/)
  assert.equal((await cards(lead, folder.slug)).length, 0, 'not the lead')
  // every card opens the board
  for (const c of [poCard, archCard, devCard]) assert.match(c.url, new RegExp(`^/apps/review/${folder.slug}\\?w=`))
})

test('검토 보드: 역할 열, AI 추천과 이유, 동시에 보는 사람, 각자의 판단, 근거 붙인 의견', { skip: !up }, async () => {
  const b = (await tool(po, 'review', 'review_open', { folder: folder.slug })).body
  assert.deepEqual(b.lanes.map((l) => [l.roleKey, l.people.map((p) => p.id)]), [['product', [po.user.id]], ['architect', [arch.user.id]], ['developer', [dev.user.id]]])
  const byId = Object.fromEntries(b.items.map((i) => [i.id, i]))
  assert.deepEqual([byId.Q1.recommended, byId.Q1.why, byId.Q2.why, byId.Q3.recommended], ['A', '실수로 누른 것을 되돌릴 수 있음', '서버 없이 가장 단순', 'A'])
  assert.ok(b.items.every((i) => i.state === 'open'))
  assert.equal(b.me.canSend, true)
  // the architect looks at Q2: the PO sees it
  await tool(arch, 'review', 'review_presence', { folder: folder.slug, key: byId.Q2.key })
  const live = (await tool(po, 'review', 'review_open', { folder: folder.slug })).body.presence
  assert.ok(live.some((p) => p.id === arch.user.id && p.key === byId.Q2.key))
  // stances: the PO agrees on Q1, the architect picks B on Q2 and objects to Q1, the developer agrees on Q3
  const mark = (who, key, body) => tool(who, 'review', 'review_mark', { folder: folder.slug, key, ...body })
  assert.equal((await mark(po, byId.Q1.key, { stance: 'agree' })).status, 200)
  assert.equal((await mark(arch, byId.Q2.key, { stance: 'choose', choice: 'B' })).status, 200)
  assert.equal((await mark(arch, byId.Q1.key, { stance: 'object' })).status, 400, 'an objection says why')
  assert.equal((await mark(arch, byId.Q1.key, { stance: 'object', note: '서버 저장(Q2 B)이면 되돌리기도 서버 기록이 필요해요' })).status, 200)
  assert.equal((await mark(dev, byId.Q3.key, { stance: 'agree' })).status, 200)
  // a card is decided by the person in its role: the developer cannot decide the PO's Q1 (anyone can doubt it)
  assert.equal((await mark(dev, byId.Q1.key, { stance: 'agree' })).status, 403)
  assert.equal((await mark(out, byId.Q1.key, { stance: 'object', note: 'x' })).status, 403, 'not a member')
  // evidence: the requirement the question is about, then a comment carrying it
  const ev = (await tool(arch, 'review', 'review_evidence', { folder: folder.slug, key: byId.Q1.key })).body
  const hit = ev.hits.find((h) => h.path.endsWith('requirements.md'))
  assert.ok(hit, JSON.stringify(ev))
  assert.equal(hit.focus, 'FR2 완료 표시')
  const c = await tool(arch, 'review', 'review_comment', { folder: folder.slug, key: byId.Q1.key, body: 'FR2.1 에 이미 되돌리기가 있어요', evidence: [hit, { path: '../../etc/hosts', focus: '' }, { url: 'https://example.com/a' }] })
  assert.equal(c.status, 200)
  const after = Object.fromEntries((await tool(po, 'review', 'review_open', { folder: folder.slug })).body.items.map((i) => [i.id, i]))
  assert.deepEqual([after.Q1.state, after.Q2.state, after.Q3.state], ['discuss', 'decided', 'decided'])
  assert.deepEqual(after.Q1.comments[0].evidence.map((e) => e.path || e.url), [hit.path, 'https://example.com/a'], 'a path outside the record is dropped')
})

test('검토 보드: 논의가 남으면 보내기를 멈추고, 담당이 다시 정하면 답 셋이 질문 파일에 한 번에 들어간다', { skip: !up }, async () => {
  const send = (who, body) => tool(who, 'review', 'review_send', { folder: folder.slug, ...body })
  assert.equal((await send(dev, { what: 'questions' })).status, 403, 'the stage’s decider (or a folder editor) sends')
  const held = await send(po, { what: 'questions' })
  assert.equal(held.status, 409)
  assert.match(held.body.error, /논의가 끝나지 않은 질문이 1개 있어요: Q1/)
  const b = (await tool(po, 'review', 'review_open', { folder: folder.slug })).body
  const q1 = b.items.find((i) => i.id === 'Q1')
  assert.equal((await tool(po, 'review', 'review_mark', { folder: folder.slug, key: q1.key, stance: 'agree', note: '되돌리기는 화면 동작이라 저장 방식과 무관해요' })).status, 200)
  const r = await send(po, { what: 'questions' })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.deepEqual(r.body.answers, { Q1: 'A', Q2: 'B', Q3: 'A' })
  const text = await fs.readFile(path.join(repo, INTENT, 'inception/requirements-analysis/requirements-analysis-questions.md'), 'utf8')
  assert.deepEqual([...text.matchAll(/^\[Answer\]: (.*)$/gm)].map((m) => m[1]), ['A', 'B', 'A'])
  const now = (await tool(po, 'review', 'review_open', { folder: folder.slug })).body
  assert.ok(now.items.filter((i) => i.kind === 'question').every((i) => i.state === 'sent'))
  assert.equal((await call(po, 'GET', `/aidlc/${folder.slug}/decide`)).body.ledger[0].kind, 'answers')
})

test('검토 보드: 승인 창의 검토 지적은 위치 문서의 역할에게, 고칠 것과 받아들일 것이 결정 하나로 세션에 들어간다', { skip: !up }, async () => {
  await fs.mkdir(path.join(repo, INTENT, 'inception/requirements-analysis/reviews'), { recursive: true })
  await fs.writeFile(path.join(repo, INTENT, 'inception/requirements-analysis/reviews/review-01.md'), REVIEW)
  name = `aidlc-${'localhost'}-${folder.slug}`.replace(/[^A-Za-z0-9_-]/g, '_')
  keys = path.join(repo, '.keys.log')
  const script = path.join(repo, '.fake-claude.sh')
  await fs.writeFile(script, `#!/bin/bash\ncat ${JSON.stringify(SCREEN)}\nwhile IFS= read -rsn1 k; do printf '%s' "$k" >> ${JSON.stringify(keys)}; done\n`, { mode: 0o755 })
  tmux('new-session', '-d', '-s', name, '-x', '160', '-y', '48', script)
  const b = await until(async () => { const x = (await tool(po, 'review', 'review_open', { folder: folder.slug })).body; return x.items.some((i) => i.kind === 'finding') && x }, 20000, 'the findings on the board')
  const f = Object.fromEntries(b.items.filter((i) => i.kind === 'finding').map((i) => [i.id, i]))
  assert.equal(b.prompt.kind, 'approval')
  assert.deepEqual(f['R-01'].refs, [{ path: 'inception/requirements-analysis/requirements.md', focus: 'FR2 완료 표시', label: 'requirements.md › FR2 완료 표시' }])
  assert.equal(f['R-02'].refs[0].focus, 'NFR 저장')
  assert.equal(f['R-01'].roleKey, 'product')
  // the approval card opens the board too
  await until(async () => (await cards(po, folder.slug)).find((c) => /승인/.test(c.title)), 30000, 'the approval card')
  const mark = (who, key, body) => tool(who, 'review', 'review_mark', { folder: folder.slug, key, ...body })
  assert.equal((await mark(po, f['R-01'].key, { stance: 'fix', note: '키보드 Space 로 되돌리기를 FR2.2 로 적어 주세요' })).status, 200)
  assert.equal((await mark(po, f['R-02'].key, { stance: 'accept' })).status, 200)
  assert.equal((await mark(po, f['R-02'].key, { stance: 'agree' })).status, 400, 'not a stance on a finding')
  const r = await tool(po, 'review', 'review_send', { folder: folder.slug, what: 'findings' })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.action, 'request-changes')
  assert.equal(r.body.text, 'Request Changes: 고쳐 주세요: R-01 — 키보드 Space 로 되돌리기를 FR2.2 로 적어 주세요')
  const typed = await until(() => fs.readFile(keys, 'utf8').then((k) => k.includes('FR2.2') && k), 10000, 'the decision typed in')
  assert.equal(typed, `3${r.body.text}`)
})

test('산출물 보기: 지적이 가리킨 문서 전체와 그 절, 기록 밖·구성원 밖은 거절', { skip: !up }, async () => {
  const d = await tool(dev, 'artifact', 'artifact_doc', { folder: folder.slug, path: 'inception/requirements-analysis/requirements.md', focus: 'NFR 저장' })
  assert.equal(d.status, 200, JSON.stringify(d.body))
  assert.equal(d.body.title, '요구사항 — 할 일 앱')
  assert.equal(d.body.focus.heading, 'nfr-저장')
  assert.ok(d.body.siblings.some((s) => s.name === 'requirements-analysis-questions.md'))
  for (const bad of ['../../../../etc/hosts', `${INTENT}/inception/requirements-analysis/requirements.md`, 'aidlc-state.md.bak']) {
    assert.equal((await tool(dev, 'artifact', 'artifact_doc', { folder: folder.slug, path: bad })).status, 404, bad)
  }
  assert.equal((await tool(out, 'artifact', 'artifact_docs', { folder: folder.slug })).status, 403)
})

test('볼트 보드: 볼트 계획이 없는 작업은 빈 나무, 세션 화면은 구성원에게', { skip: !up }, async () => {
  const t = await tool(dev, 'bolts', 'bolts_open', { folder: folder.slug })
  assert.equal(t.status, 200, JSON.stringify(t.body))
  assert.deepEqual(t.body.bolts, [])
  assert.equal(t.body.session.running, true)
  const s = await tool(dev, 'bolts', 'bolts_screen', { folder: folder.slug, lines: 12 })
  assert.equal(s.body.running, true)
  assert.match(s.body.text, /Enter to select/)
  assert.equal((await tool(dev, 'bolts', 'bolts_unit', { folder: folder.slug, name: 'nope' })).status, 404)
  assert.equal((await tool(out, 'bolts', 'bolts_screen', { folder: folder.slug })).status, 403)
})

// the MCP endpoints themselves: a person's token, POST only (stateless); lite-host as a person cannot send cards
test('MCP 앱 서버: 토큰 없이는 401, GET 은 405, 입구 도구는 ui:// 화면을 가리킨다, lite-host 는 사람에게 카드 보내기를 막는다', { skip: !up }, async () => {
  await assert.rejects(tool(null, 'review', 'review_open', { folder: folder.slug }), /401|Unauthorized|unauthor/i)
  assert.equal((await fetch(`${API}/apps/review/mcp`, { headers: { Authorization: `Bearer ${po.session.access_token}` } })).status, 405)
  const client = new Client({ name: 'e2e', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${API}/apps/review/mcp`), { requestInit: { headers: { Authorization: `Bearer ${po.session.access_token}` } } }))
  const { tools } = await client.listTools()
  const entry = tools.find((t) => t.name === 'review_open')
  assert.equal(entry._meta.ui.resourceUri, 'ui://review/board')
  const page = await client.readResource({ uri: entry._meta.ui.resourceUri })
  assert.equal(page.contents[0].mimeType, 'text/html;profile=mcp-app')
  await client.close()
  // the screen's files and the runtime come from the host, CORS for a frame with no origin, sandboxed when opened alone
  const rt = await fetch(`${API}/apps/_runtime/lite.js`)
  assert.equal(rt.status, 200)
  assert.equal(rt.headers.get('access-control-allow-origin'), '*')
  assert.match(rt.headers.get('content-security-policy'), /^sandbox allow-scripts/)
  assert.equal((await fetch(`${API}/apps/_runtime/ext-apps.js`)).status, 200)
  // lite-host for an app run as its own service: the folder's work as the person; never cards in others' names
  const host = new Client({ name: 'e2e', version: '1.0.0' })
  await host.connect(new StreamableHTTPClientTransport(new URL(`${API}/apps/_host/mcp?app=e2e`), { requestInit: { headers: { Authorization: `Bearer ${po.session.access_token}` } } }))
  const w = await host.callTool({ name: 'aidlc_work', arguments: { folder: folder.slug } })
  assert.equal(w.structuredContent.value.folder.slug, folder.slug)
  const n = await host.callTool({ name: 'notify_user', arguments: { userId: dev.user.id, title: 'x' } })
  assert.equal(n.isError, true)
  assert.equal(n.structuredContent.status, 403)
  await host.close()
})

// a Home panel is the built-in panels app: its own code from panel_view, its calls as its owner only
test('홈 패널: panel_view 가 패널의 코드와 데이터를 주고, 저장·AI-DLC 읽기는 주인만, 경로 밖은 거절', { skip: !up }, async () => {
  const [p] = await q(`insert into pro_panels(user_id, title, icon, spec, data) values ($1, 'E2E 패널', '🧪', $2, '{"n":1}') returning id`,
    [po.user.id, { html: '<b id="n"></b>', script: '$("#n").textContent = panel.data.n' }])
  try {
    const v = await tool(po, 'panels', 'panel_view', { id: p.id })
    assert.equal(v.status, 200, JSON.stringify(v.body))
    assert.deepEqual([v.body.title, v.body.html, v.body.data], ['E2E 패널', '<b id="n"></b>', { n: 1 }])
    assert.equal((await tool(dev, 'panels', 'panel_view', { id: p.id })).status, 404, "another person's panel")
    assert.equal((await tool(po, 'panels', 'panel_save', { id: p.id, data: { n: 2 } })).status, 200)
    assert.equal((await tool(dev, 'panels', 'panel_save', { id: p.id, data: { n: 9 } })).status, 404)
    assert.deepEqual((await q('select data from pro_panels where id=$1', [p.id]))[0].data, { n: 2 })
    const intents = await tool(po, 'panels', 'panel_aidlc', { path: `${folder.slug}/intents` })
    assert.equal(intents.status, 200, JSON.stringify(intents.body))
    assert.ok(intents.body.some((i) => i.slug === 'todo-web-app' && i.dirName === '261109-todo-web-app'), JSON.stringify(intents.body))
    for (const bad of ['../panels', `${folder.slug}/%2e%2e/x`, `${folder.slug}/roles`]) assert.notEqual((await tool(po, 'panels', 'panel_aidlc', { path: bad })).status, 200, bad)
    assert.equal((await tool(out, 'panels', 'panel_aidlc', { path: `${folder.slug}/intents` })).status, 403)
  } finally { await q('delete from pro_panels where id=$1', [p.id]) }
})

after(async () => {
  try { if (name) tmux('kill-session', '-t', name) } catch { /* gone */ }
  if (repo) {
    const [f] = await q('select id from pro_folders where repo_path=$1', [path.resolve(repo)]).catch(() => [])
    if (f) for (const t of ['pro_aidlc_roles', 'pro_aidlc_decisions', 'pro_aidlc_waits', 'pro_aidlc_proposals', 'pro_aidlc_mobs', 'app_review_marks', 'app_review_comments']) await q(`delete from ${t} where folder_id=$1`, [f.id]).catch(() => {})
    await q(`update notifications set is_checked=true where type='aidlc' and (url like $1 or url like $2)`, [`/aidlc/${folder?.slug}/%`, `/apps/%/${folder?.slug}%`]).catch(() => {})
    await q('delete from pro_folder_members where folder_id in (select id from pro_folders where repo_path=$1)', [path.resolve(repo)]).catch(() => {})
    await q('delete from pro_folders where repo_path=$1', [path.resolve(repo)]).catch(() => {})
    await fs.rm(repo, { recursive: true, force: true })
  }
  await pool.end().catch(() => {})
})
