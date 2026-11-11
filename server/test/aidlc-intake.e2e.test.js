// Robo-DLC Lite P3 end to end against a running server (docs/robo-dlc/plan-intake.md, plan-p3-impl.md): work
// intake and the bolt line through the two apps' tools (intake, line) — who may take in work, the plan Lite
// proposes checked against the record, starting in the team session, the line's releases and dependencies,
// a request that collides with a running bolt, a security stop, discarding with the files put back.
// Nothing here calls a model or the AI-DLC engine: the estimate comes from a stand-in file
// (PRO_AIDLC_COMPOSE_STUB, read again on every estimate), the session is a stand-in in tmux that shows an
// idle prompt and records the keys it gets, and the test writes into the record what the engine would.
// Needs the server with the watcher on (PRO_E2E_API, PRO_AIDLC_WATCH=1) and the same PRO_AIDLC_COMPOSE_STUB
// as the server's; skipped when it is not up.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { pool, q } from '../lib/supa.js'
import { config } from '../config.js'

const API = process.env.PRO_E2E_API || 'http://127.0.0.1:8787/api'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.join(HERE, 'fixtures', 'aidlc-line')
const SCREEN = path.join(HERE, 'fixtures', 'aidlc-screens', 'idle.txt')
const STUB = config.aidlcComposeStub
const up = !!STUB && await fetch(`${API}/config`).then((r) => r.ok).catch(() => false)
const login = async (email) => (await (await fetch(`${API}/auth/email/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, code: '000000' }) })).json())
const call = async (who, method, p, body) => {
  const r = await fetch(`${API}${p}`, { method, headers: { Authorization: `Bearer ${who.session.access_token}`, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) })
  return { status: r.status, body: await r.json().catch(() => null) }
}
// a tool of an app, as the screen calls it (MCP over HTTP, as the person)
async function tool(who, app, name, args = {}) {
  const client = new Client({ name: 'e2e', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${API}/apps/${app}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${who.session.access_token}` } } }))
  try {
    const r = await client.callTool({ name, arguments: { folder: folder.slug, ...args } })
    return r.isError ? { status: r.structuredContent?.status || 500, body: { error: r.structuredContent?.error || r.content?.[0]?.text } } : { status: 200, body: r.structuredContent?.value }
  } finally { await client.close() }
}
const ok = async (who, app, name, args) => { const r = await tool(who, app, name, args); assert.equal(r.status, 200, `${name}: ${JSON.stringify(r.body)}`); return r.body }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms, what) {
  const end = Date.now() + ms
  while (Date.now() < end) { const v = await fn().catch(() => null); if (v) return v; await sleep(700) }
  throw new Error(`timeout: ${what}`)
}
const tmux = (...a) => execFileSync('tmux', ['-L', config.aidlcTmuxSocket, ...a], { encoding: 'utf8' })
const cards = async (who) => ((await call(who, 'GET', '/notifications')).body || []).filter((n) => n.type === 'aidlc')
const view = (who) => ok(who, 'line', 'line_open')
const boltOf = (v, key) => v.line.bolts.find((b) => b.key === key)
const typed = () => fs.readFile(keys, 'utf8').catch(() => '')

// what the stand-in "model" answers: the raw estimate, before Lite checks every name against the record
const S = (n, why) => ({ score: n, why })
const scores = (iae, csu, ve, r, ua) => ({ iae: S(iae, '요청의 낱말'), csu: S(csu, '기록의 유닛'), ve: S(ve, '검증 범위'), r: S(r, '위험'), ua: S(ua, '불확실성') })
const BUG = '261112-double-mail', SLACK = '261112-slack-notify', RECUR = '261112-recurring'
const U2 = 'u2-booking-rules', U4 = 'u4-booking', U5 = 'u5-notification-worker', U6 = 'u6-web-ui'
const STUBS = [
  { match: '두 번', estimate: { title: '알림 메일 중복 발송', kind: 'bug', scores: scores(0.2, 0.2, 0.3, 0.3, 0.2),
    touches: { units: [U5], contracts: ['c6'], requirements: ['FR6.4', 'FR9.9'], paths: ['packages/worker/src/mail.ts', 'packages/worker/src/nope.ts'] },
    newUnits: [], conflicts: [], summary: '알림 작업자가 같은 예약에 메일을 두 번 보내는 까닭을 찾아 고쳐요.' } },
  { match: '반복 예약', estimate: { title: '반복 예약', kind: 'feature', scores: scores(0.6, 0.6, 0.5, 0.4, 0.4),
    touches: { units: [U6, 'booking', U2, 'u9-ghost'], contracts: ['C3', 'C2', 'C9'], requirements: ['FR3.1'], paths: ['packages/shared/src/rules/slots.ts'] },
    newUnits: [], conflicts: [], summary: '매주 같은 시간에 되풀이되는 예약을 규칙·API·화면에 더해요.' } },
  { match: '문구', estimate: { title: '예약 버튼 문구', kind: 'change', scores: scores(0.1, 0.1, 0.1, 0.1, 0.1),
    touches: { units: [U6], contracts: [], requirements: [], paths: [] }, newUnits: [], conflicts: [], summary: '예약 화면의 버튼 문구를 바꿔요.' } },
  { match: '로고', estimate: { title: '로고 색', kind: 'change', scores: scores(0.1, 0.1, 0.1, 0.1, 0.1),
    touches: { units: [U6], contracts: [], requirements: [], paths: [] }, newUnits: [], conflicts: [], summary: '로고 색을 바꿔요.' } },
  { match: '슬랙', estimate: { title: '슬랙 알림으로 전환', kind: 'change', scores: scores(0.3, 0.2, 0.3, 0.3, 0.3),
    touches: { units: [U5], contracts: ['C6'], requirements: ['FR6.2'], paths: [] }, newUnits: [],
    conflicts: [{ bolt: `i:${BUG}:${U5}`, requestQuote: '메일 알림을 없애고', recordQuote: '메일이 두 번 와요', compatible: false, why: '없앨 메일 발송을 고치는 작업이에요.' },
      { bolt: 'i:nope:u1', requestQuote: 'x', recordQuote: 'y', compatible: false, why: '없는 볼트' }],
    summary: '메일 대신 슬랙으로 예약 알림을 보내요.' } },
]

let lead, po, arch, dev, out, repo, side, folder, name, keys
const req = {}   // the requests by a short name: { bug, word, recur, logo, slack, revert }
const intents = () => path.join(repo, 'aidlc', 'spaces', 'default', 'intents')
// what the engine would write when the session starts an intent
async function writeIntent(dir, { scope, project, stage, units = '', audit = '' }) {
  const list = JSON.parse(await fs.readFile(path.join(intents(), 'intents.json'), 'utf8'))
  list.push({ uuid: randomUUID(), slug: dir.replace(/^\d{6}-/, ''), dirName: dir, scope, status: 'active', request: 'e2e' })
  const d = path.join(intents(), dir)
  await fs.mkdir(path.join(d, 'audit'), { recursive: true })
  await fs.writeFile(path.join(d, 'aidlc-state.md'), `# AI-DLC State Tracking\n\n## Project Information\n- **Project**: ${project}\n- **Scope**: ${scope}\n\n## Current Status\n- **Current Stage**: ${stage}\n- **Status**: In Progress\n`)
  if (units) {
    await fs.mkdir(path.join(d, 'inception', 'units-generation'), { recursive: true })
    await fs.writeFile(path.join(d, 'inception', 'units-generation', 'unit-of-work-dependency.md'), units)
  }
  if (audit) await fs.writeFile(path.join(d, 'audit', 'e2e.md'), audit)
  await fs.writeFile(path.join(intents(), 'intents.json'), JSON.stringify(list, null, 2))
  await fs.writeFile(path.join(intents(), 'active-intent'), dir)
}
async function finishIntent(dir) {
  const list = JSON.parse(await fs.readFile(path.join(intents(), 'intents.json'), 'utf8'))
  list.find((i) => i.dirName === dir).status = 'complete'
  await fs.writeFile(path.join(intents(), 'intents.json'), JSON.stringify(list, null, 2))
  const f = path.join(intents(), dir, 'aidlc-state.md')
  await fs.writeFile(f, (await fs.readFile(f, 'utf8')).replace('In Progress', 'Completed'))
}
// ask for work and wait for the plan
async function ask(who, body, status) {
  const r = await ok(who, 'intake', 'intake_propose', { body })
  assert.equal(r.status, 'estimating')
  return until(async () => { const x = (await ok(who, 'intake', 'intake_open')).requests.find((y) => y.id === r.id); return x.status !== 'estimating' && x }, 20000, `the plan for "${body.slice(0, 12)}"`)
    .then((x) => { assert.equal(x.status, status, x.note); return x })
}

test('준비: 끝난 인텐트가 하나 있는 저장소, 팀 리드(소유)·PO·아키텍트·개발자·외부인, 세션 대역', { skip: !up }, async () => {
  const stamp = Date.now()
  ;[lead, po, arch, dev, out] = await Promise.all(['lead', 'po', 'arch', 'dev', 'out'].map((x) => login(`rdlc-intake-${x}-${stamp}@pgpt.test`)))
  repo = await fs.mkdtemp(path.join(os.tmpdir(), 'aidlc-intake-'))
  side = await fs.mkdtemp(path.join(os.tmpdir(), 'aidlc-intake-side-'))
  await fs.cp(FIXTURE, repo, { recursive: true })
  const git = (...a) => execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@pgpt.test', ...a], { cwd: repo })
  git('init', '-q', '-b', 'main'); git('add', '-A'); git('commit', '-q', '-m', 'room booking')
  await fs.writeFile(STUB, JSON.stringify(STUBS, null, 2))
  const r = await call(lead, 'POST', '/folders/link', { path: repo, name: `회의실 예약 ${stamp}` })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  folder = r.body
  for (const u of [po, arch, dev]) assert.equal((await call(lead, 'POST', `/folders/${folder.slug}/members`, { type: 'user', id: u.user.id, role: 'editor' })).status, 200)
  for (const [roleKey, u] of [['team-lead', lead], ['product', po], ['architect', arch], ['developer', dev]]) {
    assert.equal((await call(lead, 'PUT', `/aidlc/${folder.slug}/roles`, { roleKey, userIds: [u.user.id] })).status, 200)
  }
  // the stand-in session: an idle prompt, then every key it gets goes to a file outside the project
  name = `aidlc-localhost-${folder.slug}`.replace(/[^A-Za-z0-9_-]/g, '_')
  keys = path.join(side, 'keys.log')
  const script = path.join(side, 'fake-claude.sh')
  await fs.writeFile(script, `#!/bin/bash\ncat ${JSON.stringify(SCREEN)}\nwhile IFS= read -rsn1 k; do printf '%s' "$k" >> ${JSON.stringify(keys)}; done\n`, { mode: 0o755 })
  tmux('new-session', '-d', '-s', name, '-x', '160', '-y', '48', script)

  // what each may do (D-1112-23); an outsider sees nothing
  const v = await view(lead)
  assert.deepEqual([v.rights.intake, v.rights.impact, v.rights.stop, v.rights.archive], [true, true, true, true])
  const rights = async (u) => { const x = (await view(u)).rights; return [x.intake, x.impact, x.stop, x.archive] }
  assert.deepEqual(await rights(po), [true, false, true, false])
  assert.deepEqual(await rights(arch), [false, true, false, false])
  assert.deepEqual(await rights(dev), [false, false, false, false])
  assert.equal((await tool(out, 'line', 'line_open')).status, 403)
  assert.equal((await tool(out, 'intake', 'intake_propose', { body: '외부인의 요청이에요' })).status, 403)
  // the line before anything is asked: the six bolts of the finished work, released
  assert.equal(v.head.busy, false)
  assert.equal(v.line.bolts.length, 6)
  assert.ok(v.line.bolts.every((b) => b.state === 'done' && b.bucket === 'shipped'))
  assert.deepEqual(v.scopes.map((s) => s.name), ['bugfix', 'classic', 'express', 'feature', 'refactor', 'security-patch'])
})

test('S1 접수: 권한 없는 사람의 요청은 접수함으로, 접수 담당의 요청은 계획안 → 지금 시작하면 세션에 /aidlc 가 들어간다', { skip: !up }, async () => {
  // a developer asks: the plan waits in the inbox, the people who take in work get a card, the developer cannot start it
  const word = req.word = await ask(dev, '예약 화면의 "예약하기" 버튼 문구를 "회의실 잡기"로 바꿔 주세요', 'inbox')
  assert.equal(word.estimate.scope, 'express')
  assert.equal(word.mine, true)
  const card = await until(async () => (await cards(po)).find((n) => n.url === `/apps/intake/${folder.slug}?r=${word.id}`), 15000, 'the PO card for the inbox')
  assert.match(card.title, /접수를 기다려요/)
  assert.equal((await tool(dev, 'intake', 'intake_approve', { id: word.id, mode: 'after' })).status, 403)

  // the team lead asks: the plan comes back to them; every name was checked against the record
  const bug = req.bug = await ask(lead, '예약 알림 메일이 두 번 와요. 같은 예약인데 10분 전 알림이 두 통씩 옵니다.', 'proposed')
  const e = bug.estimate
  assert.equal(e.kind, 'bug')
  assert.deepEqual([e.scope, e.scopeWhy], ['bugfix', 'kind'])
  assert.deepEqual(e.touches, { units: [U5], contracts: ['C6'], requirements: ['FR6.4'], paths: ['packages/worker/src/mail.ts'] })
  assert.deepEqual([e.dropped.requirements, e.dropped.paths], [['FR9.9'], ['packages/worker/src/nope.ts']])
  assert.equal(e.cost.stub, true)
  // the architect confirms what it touches; a developer may not
  assert.equal((await tool(dev, 'intake', 'intake_impact', { id: bug.id })).status, 403)
  await ok(arch, 'intake', 'intake_impact', { id: bug.id, units: [U5], note: '알림 작업자만 봐요' })
  assert.ok((await ok(lead, 'intake', 'intake_open')).requests.find((x) => x.id === bug.id).estimate.confirmed.at)

  // start now: the request is typed into the team session with the scope
  const started = await ok(lead, 'intake', 'intake_approve', { id: bug.id, mode: 'now' })
  assert.deepEqual(started, { status: 'started', scope: 'bugfix' })
  assert.match(await until(async () => { const k = await typed(); return k.includes('두 통씩 옵니다') && k }, 10000, 'the request typed'), /\/aidlc bugfix "예약 알림 메일이 두 번 와요\. 같은 예약인데 10분 전 알림이 두 통씩 옵니다\."/)
  let v = await view(lead)
  assert.equal(v.head.busy, true)
  let b = boltOf(v, `r:${bug.id}:${U5}`)
  assert.deepEqual([b.state, b.bucket, b.canRestore, b.lane], ['running', 'now', true, 'notification-worker'])
  // one piece of work at a time: another cannot start now
  assert.equal((await tool(po, 'intake', 'intake_approve', { id: word.id, mode: 'now' })).status, 409)

  // the record gets the intent (the engine's part): the request and its bolt are the intent's from then on
  await writeIntent(BUG, { scope: 'bugfix', project: '예약 알림 메일이 두 번 와요', stage: 'code-generation' })
  v = await until(async () => { const x = await view(lead); return x.requests.find((y) => y.id === bug.id).intent === BUG && x }, 30000, 'the request linked to its intent')
  b = boltOf(v, `i:${BUG}:${U5}`)
  assert.deepEqual([b.state, b.bucket, b.canRestore, b.request], ['running', 'now', true, bug.id])
  assert.deepEqual([v.head.intent.dir, v.head.intent.request], [BUG, bug.id])

  // the PO takes the developer's request in after the work in flight; the developer is told
  assert.deepEqual(await ok(po, 'intake', 'intake_approve', { id: word.id, mode: 'after' }), { status: 'queued', scope: 'express' })
  assert.match((await until(async () => (await cards(dev)).find((n) => /접수됐어요/.test(n.title)), 15000, 'the developer told')).text, /앞 작업 다음에/)
  // a feature over three units: its expected bolts stack at the tail, in the order of their dependencies
  const recur = req.recur = await ask(po, '반복 예약을 넣어 주세요. 매주 같은 시간에 되풀이되는 예약이요.', 'proposed')
  assert.deepEqual([recur.estimate.scope, recur.estimate.scopeWhy], ['feature', 'size'])
  assert.deepEqual(recur.estimate.touches.units, [U6, U4, U2])   // "booking" is the record's u4-booking
  assert.deepEqual([recur.estimate.dropped.units, recur.estimate.dropped.contracts], [['u9-ghost'], ['C9']])
  await ok(po, 'intake', 'intake_approve', { id: recur.id, mode: 'after' })
  v = await view(dev)
  const tail = v.line.bolts.filter((x) => x.bucket === 'tail')
  assert.deepEqual(tail.map((x) => [x.request, x.unit, x.state]), [[word.id, U6, 'estimated'], [recur.id, U2, 'estimated'], [recur.id, U4, 'estimated'], [recur.id, U6, 'estimated']])
  const k = (u) => `r:${recur.id}:${u}`
  assert.deepEqual(boltOf(v, k(U4)).deps.map((d) => [d.key, d.via]), [[k(U2), 'C3']])
  assert.deepEqual(boltOf(v, k(U6)).deps.map((d) => [d.key, d.via]).sort(), [[k(U2), 'C3'], [k(U4), 'C2'], [`r:${word.id}:${U6}`, 'lane']].sort())

  // later, with the reason — told to who asked; the asker takes their own request back
  const logo = req.logo = await ask(dev, '로고 색을 파란색으로 바꿔 주세요', 'inbox')
  assert.equal((await tool(po, 'intake', 'intake_triage', { id: logo.id, action: 'later' })).status, 400)
  assert.deepEqual(await ok(po, 'intake', 'intake_triage', { id: logo.id, action: 'later', note: '디자인 개편 때 같이 봐요' }), { status: 'later' })
  assert.match((await until(async () => (await cards(dev)).find((n) => /나중에 하기로/.test(n.title)), 15000, 'the developer told why')).text, /디자인 개편/)
  assert.equal((await tool(arch, 'intake', 'intake_triage', { id: logo.id, action: 'withdraw' })).status, 403)
  assert.deepEqual(await ok(dev, 'intake', 'intake_triage', { id: logo.id, action: 'withdraw' }), { status: 'declined' })
})

test('S2 볼트 줄: 의존을 깨는 이동은 막고 함께 옮길 볼트를 알려 준다 · 끝나지 않은 릴리스는 내보낼 수 없다 · 멈춰 두기', { skip: !up }, async () => {
  const k = (u) => `r:${req.recur.id}:${u}`
  // the API bolt alone to the next release: it waits for the rules bolt, which would stay behind
  assert.equal((await tool(dev, 'line', 'line_move', { key: k(U4), bucket: 'next' })).status, 403)
  const alone = await ok(po, 'line', 'line_move', { key: k(U4), bucket: 'next' })
  assert.deepEqual([alone.moved, alone.ok], [[], false])
  assert.deepEqual(alone.blockers.map((x) => [x.key, x.why, x.via]), [[k(U2), 'provider', 'C3']])
  assert.deepEqual(alone.together, [k(U4), k(U2)])
  const both = await ok(po, 'line', 'line_move', { key: k(U4), bucket: 'next', together: true })
  assert.deepEqual(both.moved, [k(U4), k(U2)])
  let v = await view(po)
  assert.deepEqual(v.line.buckets.find((x) => x.key === 'next').bolts, [k(U2), k(U4)])
  // the screen bolt was not placed by anyone: it stays at the tail, after the bolts it waits for
  assert.equal(boltOf(v, k(U6)).bucket, 'tail')
  // and the rules bolt cannot go back behind the bolt that waits for it
  const back = await ok(po, 'line', 'line_move', { key: k(U2), bucket: 'tail' })
  assert.deepEqual([back.moved, back.blockers.map((x) => [x.key, x.why])], [[], [[k(U4), 'consumer']]])
  // a released bolt does not move
  assert.equal((await tool(po, 'line', 'line_move', { key: `i:261111-room-booking:${U2}`, bucket: 'now' })).status, 400)
  // this release has work under way: it cannot be released
  assert.equal((await tool(dev, 'line', 'line_release')).status, 403)
  const rel = await tool(po, 'line', 'line_release')
  assert.equal(rel.status, 409)
  assert.match(rel.body.error, /끝나지 않은 볼트가 1개/)
  // hold a waiting bolt and let it go on: the architect may not
  assert.equal((await tool(arch, 'line', 'line_hold', { key: k(U6), hold: true })).status, 403)
  await ok(lead, 'line', 'line_hold', { key: k(U6), hold: true, reason: '디자인 시안을 기다려요' })
  v = await view(lead)
  assert.equal(boltOf(v, k(U6)).hold, true)
  assert.equal(v.line.buckets.find((x) => x.key === 'tail').held, 1)
  await ok(lead, 'line', 'line_hold', { key: k(U6), hold: false })
  assert.equal(boltOf(await view(lead), k(U6)).hold, false)
  // every decision is in the ledger, newest first
  v = await view(dev)
  assert.deepEqual(v.ledger.slice(0, 3).map((l) => [l.kind, l.choice]), [['stop', '다시 진행'], ['stop', '멈춰 둠'], ['line', '줄 끝 → 다음 릴리스']])
  assert.match(v.ledger[2].note, /2개를 함께/)
})

test('S3 충돌: 진행 중인 볼트와 부딪히는 요청 → 그 볼트를 폐기하면 세션이 멈추고 파일은 시작 전으로, 기록은 그대로', { skip: !up }, async () => {
  const key = `i:${BUG}:${U5}`
  // the session "worked": a file changed, a file made, a note in the record
  const mail = path.join(repo, 'packages/worker/src/mail.ts'), dedupe = path.join(repo, 'packages/worker/src/dedupe.ts'), note = path.join(intents(), BUG, 'bug-notes.md')
  const before = await fs.readFile(mail, 'utf8')
  await fs.writeFile(mail, `${before}\n// 같은 예약에는 한 번만 (고치는 중)\n`)
  await fs.writeFile(dedupe, 'export const seen = new Set<string>()\n')
  await fs.writeFile(note, '# 원인\n\n작업자가 두 개 떠 있었다.\n')

  // the PO asks for what makes that work pointless: the plan names the bolt it collides with — only one the line has
  const slack = req.slack = await ask(po, '메일 알림을 없애고 슬랙 알림으로 바꿔 주세요', 'proposed')
  assert.deepEqual(slack.estimate.conflicts.map((c) => [c.bolt, c.compatible]), [[key, false]])
  assert.deepEqual(slack.estimate.dropped.conflicts, ['i:nope:u1'])
  await ok(po, 'intake', 'intake_approve', { id: slack.id, mode: 'after' })
  // before anyone decides: what discarding it would mean
  const pv = await ok(po, 'intake', 'intake_discard_preview', { key })
  assert.deepEqual([pv.kind, pv.snapshot, pv.whole], ['stop', true, true])
  assert.deepEqual([pv.files.changed, pv.files.made, pv.files.moved], [['packages/worker/src/mail.ts'], ['packages/worker/src/dedupe.ts'], null])
  // the request that comes after it on the same unit does not need it: nothing to hold
  assert.equal(boltOf(await view(po), `r:${slack.id}:${U5}`).deps[0].via, 'lane')
  assert.deepEqual(pv.dependents, [])
  // who may: not the architect, not without a reason
  assert.equal((await tool(arch, 'intake', 'intake_discard', { key, reason: '필요 없어졌어요' })).status, 403)
  assert.equal((await tool(po, 'intake', 'intake_discard', { key, reason: ' ' })).status, 400)
  const d = await ok(po, 'intake', 'intake_discard', { key, reason: '메일 알림 자체를 없애기로 했어요', forRequest: slack.id })
  assert.equal(d.kind, 'stop')
  assert.deepEqual([d.restored.restored, d.restored.removed, d.restored.record], [['packages/worker/src/mail.ts'], ['packages/worker/src/dedupe.ts'], 'kept'])
  assert.deepEqual(d.dependents, [])
  // the files are as they were when the bolt started; what it made is set aside, not lost; the record stays
  assert.equal(await fs.readFile(mail, 'utf8'), before)
  assert.equal(await fs.stat(dedupe).catch(() => null), null)
  assert.equal(await fs.readFile(path.join(d.restored.aside, 'packages/worker/src/dedupe.ts'), 'utf8'), 'export const seen = new Set<string>()\n')
  assert.match(await fs.readFile(note, 'utf8'), /두 개 떠/)
  // the session was interrupted and told
  const k = await until(async () => { const x = await typed(); return x.includes('코드는 다시 만들지 마세요') && x }, 10000, 'the session told')
  assert.ok(k.includes('\x1b'), 'Escape')
  assert.match(k, /\[Lite\] 이 작업은 폐기하기로 했어요\(.+: 메일 알림 자체를 없애기로 했어요\)\. 바뀐 파일은 시작 전으로 되돌렸고/)
  // on the line it stays as what was discarded and for what; the head is free; discarding twice is refused
  let v = await view(dev)
  const b = boltOf(v, key)
  assert.deepEqual([b.discarded.reason, b.discarded.forTitle, b.discarded.restored.restored.length], ['메일 알림 자체를 없애기로 했어요', '슬랙 알림으로 전환', 1])
  assert.equal(v.head.busy, false)
  assert.equal(v.requests.find((x) => x.id === req.bug.id).discarded, true)
  assert.equal(boltOf(v, `r:${slack.id}:${U5}`).deps.length, 0)
  assert.deepEqual([v.ledger[0].kind, v.ledger[0].intent], ['discard', BUG])
  assert.match(v.ledger[0].choice, /멈추고 폐기 · 파일 1개 되돌림, 1개 치움/)
  assert.equal((await tool(po, 'line', 'line_discard', { key, reason: '한 번 더' })).status, 409)
  // who asked for the discarded work is told
  assert.match((await until(async () => (await cards(lead)).find((n) => /볼트를 폐기했어요/.test(n.title)), 15000, 'the lead told')).text, /슬랙 알림으로 전환/)
  // nothing starts by itself: the people who take in work get a card that the head is free (the next release's work first)
  const free = await until(async () => (await cards(po)).find((n) => /다음 작업을 시작할 수 있어요/.test(n.title)), 30000, 'the head-is-free card')
  assert.equal(free.url, `/apps/intake/${folder.slug}?r=${req.recur.id}`)
  assert.equal(v.head.next, req.recur.id)

  // the PO starts the request it gave way to instead; it runs, finishes, and the release goes out
  assert.deepEqual(await ok(po, 'intake', 'intake_approve', { id: slack.id, mode: 'now' }), { status: 'started', scope: 'express' })
  assert.match(await until(async () => { const x = await typed(); return x.includes('/aidlc express') && x }, 10000, 'the next request typed'), /\/aidlc express "메일 알림을 없애고 슬랙 알림으로 바꿔 주세요"/)
  await writeIntent(SLACK, { scope: 'express', project: '메일 알림을 없애고 슬랙 알림으로', stage: 'code-generation' })
  await until(async () => (await view(po)).requests.find((y) => y.id === slack.id).intent === SLACK, 30000, 'the second request linked')
  assert.equal((await tool(po, 'line', 'line_release')).status, 409)
  await finishIntent(SLACK)
  v = await until(async () => { const x = await view(po); return boltOf(x, `i:${SLACK}:${U5}`)?.state === 'done' && x }, 15000, 'the work finished')
  assert.equal(v.head.busy, false)
  assert.equal(v.requests.find((x) => x.id === slack.id).done, true)
  const rel = await ok(po, 'line', 'line_release')
  assert.deepEqual(rel.released, [`i:${SLACK}:${U5}`])
  v = await view(po)
  assert.equal(boltOf(v, `i:${SLACK}:${U5}`).bucket, 'shipped')
  // the next release moved up
  assert.deepEqual(v.line.buckets.find((x) => x.key === 'now').bolts, [`r:${req.recur.id}:${U2}`, `r:${req.recur.id}:${U4}`])
})

test('S4 보안 멈춤: 누구든 보안 사유로 멈추면 세션이 바로 멈춘다 · 폐기는 권한 있는 사람이, 기다리던 볼트는 멈춰 둔다', { skip: !up }, async () => {
  const recur = req.recur
  // the head is free: a person starts what is next
  assert.equal((await tool(dev, 'line', 'line_start', { id: recur.id })).status, 403)
  assert.deepEqual(await ok(lead, 'line', 'line_start', { id: recur.id }), { status: 'started', scope: 'feature' })
  // the record: an intent with three units, the first under way
  const units = '# 작업 단위 의존 관계\n\n```yaml\nunits:\n  - name: u2-booking-rules\n    kind: library\n    depends_on: []\n  - name: u4-booking\n    kind: service\n    depends_on: [u2-booking-rules]\n  - name: u6-web-ui\n    kind: ui\n    depends_on: [u2-booking-rules, u4-booking]\n```\n'
  const audit = `## Unit started\n\n**Event**: UNIT_STARTED\n**Timestamp**: ${new Date().toISOString()}\n**Stage**: code-generation\n**Unit**: ${U2}\n`
  await writeIntent(RECUR, { scope: 'feature', project: '반복 예약', stage: 'code-generation', units, audit })
  const k = (u) => `i:${RECUR}:${u}`
  let v = await until(async () => { const x = await view(lead); return x.requests.find((y) => y.id === recur.id).intent === RECUR && x }, 30000, 'the feature linked')
  assert.deepEqual([U2, U4, U6].map((u) => { const b = boltOf(v, k(u)); return [b.state, b.bucket, b.canRestore] }), [['running', 'now', true], ['planned', 'now', false], ['planned', 'now', false]])
  assert.deepEqual([v.head.intent.dir, v.head.intent.unit], [RECUR, U2])
  const slots = path.join(repo, 'packages/shared/src/rules/slots.ts')
  const before = await fs.readFile(slots, 'utf8')
  await fs.writeFile(slots, `${before}\nconsole.log('SMTP_PASSWORD', process.env.SMTP_PASSWORD)\n`)

  // a developer sees a secret in the log: a security stop pauses the session at once and holds the bolt
  const mark = (await typed()).length
  const stop = await ok(dev, 'line', 'line_stop_request', { key: k(U2), reason: 'SMTP 비밀번호가 로그에 찍혀요', security: true })
  assert.deepEqual(stop, { paused: true, held: true })
  assert.ok((await until(async () => { const x = (await typed()).slice(mark); return x.includes('\x1b') && x }, 10000, 'Escape')).length < 4, 'only Escape')
  v = await view(dev)
  let b = boltOf(v, k(U2))
  assert.deepEqual([b.hold, b.stop.security, b.stop.reason], [true, true, 'SMTP 비밀번호가 로그에 찍혀요'])
  for (const who of [lead, po]) {
    const c = await until(async () => (await cards(who)).find((n) => /보안 사유로 작업을 멈췄어요/.test(n.title)), 15000, 'the stop card')
    assert.equal(c.url, `/apps/line/${folder.slug}?b=${encodeURIComponent(k(U2))}`)
  }
  // an ordinary stop request changes nothing by itself: it asks
  assert.equal((await tool(dev, 'line', 'line_stop_request', { key: k(U4), reason: ' ' })).status, 400)
  assert.deepEqual(await ok(arch, 'line', 'line_stop_request', { key: k(U4), reason: 'API 설계를 다시 보고 싶어요' }), { paused: false, held: false })
  assert.equal(boltOf(await view(arch), k(U4)).hold, false)
  // what happens next is for the people who may stop and discard
  assert.equal((await tool(dev, 'line', 'line_discard', { key: k(U2), reason: '보안 문제' })).status, 403)
  const pv = await ok(lead, 'line', 'line_discard_preview', { key: k(U2) })
  assert.deepEqual([pv.kind, pv.whole, pv.files.changed, pv.dependents.map((d) => d.key)], ['stop', false, ['packages/shared/src/rules/slots.ts'], [k(U4), k(U6)]])
  const d = await ok(lead, 'line', 'line_discard', { key: k(U2), reason: '비밀번호를 로그에 남기는 코드예요. 처음부터 다시 해요' })
  assert.deepEqual([d.kind, d.restored.restored, d.dependents], ['stop', ['packages/shared/src/rules/slots.ts'], [k(U4), k(U6)]])
  assert.equal(await fs.readFile(slots, 'utf8'), before)
  assert.match(await until(async () => { const x = (await typed()).slice(mark); return x.includes('코드는 다시 만들지 마세요') && x }, 10000, 'the session told'), /\[Lite\] 유닛 u2-booking-rules은 폐기하기로 했어요/)
  v = await view(lead)
  assert.deepEqual([U2, U4, U6].map((u) => { const x = boltOf(v, k(u)); return [!!x.discarded, x.hold] }), [[true, false], [false, true], [false, true]])
  assert.equal(v.head.busy, true, 'the bolts that waited are held, not gone')
  // the rest goes too, and the head is free again
  const rest = await ok(lead, 'line', 'line_discard', { key: k(U4), reason: '규칙 없이 API만 만들 수 없어요', dependents: 'discard' })
  assert.deepEqual([rest.kind, rest.restored, rest.dependents], ['drop', null, [k(U6)]])
  v = await view(lead)
  assert.equal(v.head.busy, false)
  assert.equal(v.requests.find((x) => x.id === recur.id).discarded, true)
  assert.deepEqual(v.ledger.filter((l) => l.intent === RECUR).map((l) => l.kind).reverse(), ['stop', 'stop', 'discard', 'discard'])
  assert.ok(v.ledger.some((l) => l.choice === '보안 사유로 바로 멈춤' && l.note === 'SMTP 비밀번호가 로그에 찍혀요'))

  // finished and released work is not discarded: taking it back is new work, a request of its own
  const done = `i:261111-room-booking:${U5}`
  assert.equal((await ok(lead, 'line', 'line_discard_preview', { key: done })).kind, 'revert')
  const r = await ok(lead, 'line', 'line_discard', { key: done, reason: '메일 알림은 이제 쓰지 않아요' })
  assert.equal(r.kind, 'revert')
  const made = (await ok(lead, 'intake', 'intake_open')).requests.find((x) => x.id === r.request)
  assert.deepEqual([made.status, made.estimate.reverts, made.estimate.scopeWhy], ['proposed', [U5], 'revert'])
  assert.equal(boltOf(await view(lead), done).discarded, null)
  assert.deepEqual(await ok(lead, 'intake', 'intake_triage', { id: r.request, action: 'decline', note: '시험이라 받지 않아요' }), { status: 'declined' })
})

after(async () => {
  try { if (name) tmux('kill-session', '-t', name) } catch { /* gone */ }
  if (STUB && up) await fs.writeFile(STUB, '[]').catch(() => {})
  if (repo) {
    const [f] = await q('select id from pro_folders where repo_path=$1', [path.resolve(repo)]).catch(() => [])
    if (f) for (const t of ['pro_aidlc_roles', 'pro_aidlc_decisions', 'pro_aidlc_waits', 'pro_aidlc_proposals', 'pro_aidlc_mobs', 'pro_aidlc_requests', 'pro_aidlc_line']) await q(`delete from ${t} where folder_id=$1`, [f.id]).catch(() => {})
    await q(`update notifications set is_checked=true where type='aidlc' and (url like $1 or url like $2)`, [`/aidlc/${folder?.slug}/%`, `/apps/%/${folder?.slug}%`]).catch(() => {})
    await q('delete from pro_folder_members where folder_id in (select id from pro_folders where repo_path=$1)', [path.resolve(repo)]).catch(() => {})
    await q('delete from pro_folders where repo_path=$1', [path.resolve(repo)]).catch(() => {})
    await fs.rm(repo, { recursive: true, force: true })
    await fs.rm(side, { recursive: true, force: true }).catch(() => {})
  }
  await pool.end().catch(() => {})
})
