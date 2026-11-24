// The chat's agent picker end to end (spec openspec/specs/local-agents 「채팅에서 고르는 에이전트」, design docs/local-agents/design.md §12):
// a real Lite BFF, a person's desktop (the desktop app's own runner, desktop/src/runner, with the fake interactive `claude` and `codex` —
// desktop/test/fixtures/fake-tui.js — on its path) linked over the WebSocket. Fictional people:
//   윤태호 — his PC runs his chat messages; 서하린 — another person of the company (she may not see or type into his runs).
//   1. the picker: before any desktop, the local entries are off with why; once his PC is linked, Claude Code · Codex are on; his choice
//      is kept per chat (main chat · a conversation of it · a project)
//   2. send → run → final message plus a file card: a main-chat message to Claude Code makes his personal folder 「내 PC 에이전트 작업 ·
//      윤태호」, runs on his PC, and the CLI's last words come back as an assistant message, the file it wrote as a file card (main has it)
//   3. a follow-up goes into the same CLI session (no new run); after 「끝내기」 the next message starts a run that resumes the session
//   4. who: 서하린 gets 403 for his run (see · steer · finish · fallback) and 404 for his thread
//   5. offline: his PC off → the picker says so; a message waits (「PC 앱이 꺼져 있어요」) and 「기본으로 다시 보내기」 hands back its words
//   6. a project thread: its own folder's project variation gets the file (main untouched); a member who may only run it (runner) is refused
//      (403 — edit rights); a folder member watches the run but cannot type
//   node test/chatAgents.e2e.mjs   (a free port in 8884–8899, tenant "chatagent-e2e", folders in a temporary directory; no model)
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const SERVER = path.resolve(here, '..')
const DESKTOP = path.resolve(SERVER, '..', 'desktop')
const require = createRequire(import.meta.url)
const { createLocalRunner } = require(path.join(DESKTOP, 'src/runner/index.js'))
const { fakeBin } = require(path.join(DESKTOP, 'test/helpers/fakeBin.js'))
const AVOID = new Set([5199, 5195, 8795, 8777, 8794, 8796, 8797, 27790, 8088, 8787, 8798, 8888, 8099, 8885, 8886, 8887, 8889, 8890, 8891])
const portFree = (p) => { try { execFileSync('lsof', ['-nP', `-iTCP:${p}`, '-sTCP:LISTEN'], { stdio: 'ignore' }); return false } catch { return true } }
const PORT = Number(process.env.CA_PORT) || Array.from({ length: 16 }, (_, i) => 8884 + i).find((p) => !AVOID.has(p) && portFree(p))
const BASE = `http://127.0.0.1:${PORT}`
const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'pgl-chatagent-'))
const TENANT = 'chatagent-e2e'
const RESULTS = process.env.CA_RESULTS || ''
Object.assign(process.env, { PRO_TENANT_ID: TENANT, PRO_TENANT_HOSTS: '', PRO_FOLDERS_ROOT: path.join(ROOT, 'folders') })
const { q, pool } = await import('../lib/supa.js')
const BIN = fakeBin(path.join(ROOT, 'bin'))
process.env.FAKE_CLI_HOME = path.join(ROOT, 'fake-home')
process.env.FAKE_CLI_LOG = path.join(ROOT, 'fake.log')
const CLI_ENV = { CLAUDE_CONFIG_DIR: path.join(ROOT, 'claude-config'), CODEX_HOME: path.join(ROOT, 'codex-home') }
await fs.mkdir(CLI_ENV.CLAUDE_CONFIG_DIR, { recursive: true })
const SEARCH = [BIN, '/usr/bin', '/bin', '/opt/homebrew/bin'].join(path.delimiter)

let server
const serverLog = []
const runners = []
const report = []
let n = 0
const people = []
async function cleanup() {
  for (const r of runners) try { r.stop() } catch { /* gone */ }
  if (server && server.exitCode == null) { server.kill('SIGTERM'); await new Promise((r) => server.once('exit', r)) }
  for (const t of ['pro_local_jobs', 'pro_local_devices', 'pro_chat_agents', 'pro_folders']) await q(`delete from ${t} where tenant_id=$1`, [TENANT]).catch(() => {})
  for (const u of people) {
    await q(`delete from pro_messages where thread_id in (select id from pro_threads where user_id=$1)`, [u]).catch(() => {})
    await q(`delete from pro_thread_folders where user_id=$1`, [u]).catch(() => {})
    await q(`delete from pro_threads where user_id=$1 and kind='project'`, [u]).catch(() => {})
  }
  await pool.end()
  await fs.rm(ROOT, { recursive: true, force: true })
}
async function save() { if (RESULTS) await fs.writeFile(RESULTS, JSON.stringify({ at: new Date().toISOString(), port: PORT, steps: report }, null, 2)) }
async function step(name, fn) {
  n++
  const t = Date.now()
  try {
    const said = await fn()
    console.log(`ok ${n} - ${name} (${((Date.now() - t) / 1000).toFixed(1)}s)${said ? `\n  ${said}` : ''}`)
    report.push({ n, name, ok: true, said: said || '', seconds: (Date.now() - t) / 1000 })
  } catch (e) {
    console.log(`not ok ${n} - ${name}\n  ${e.stack || e.message}`)
    console.log('--- server log (last 80 lines)\n' + serverLog.join('').split('\n').slice(-80).join('\n'))
    report.push({ n, name, ok: false, error: e.message })
    await save()
    await cleanup(); process.exit(1)
  }
}
const waitFor = async (fn, ms = 30000, what = '') => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error(`timed out: ${what}`); await new Promise((r) => setTimeout(r, 200)) } }
const api = async (token, p, { method = 'GET', body } = {}) => {
  const r = await fetch(`${BASE}/api${p}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined })
  const text = await r.text()
  let j = null
  try { j = JSON.parse(text) } catch { j = text }
  if (!r.ok) throw Object.assign(new Error(`${method} ${p} → ${r.status} ${text.slice(0, 200)}`), { status: r.status })
  return j
}
const status = async (token, p, opts) => { try { await api(token, p, opts); return 200 } catch (e) { return e.status || 0 } }
// a chat message as the page sends it (the stream's events → {done, error})
async function say(token, threadId, text, extra = {}) {
  const r = await fetch(`${BASE}/api/threads/${threadId}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ text, ...extra }) })
  if (!r.ok) throw Object.assign(new Error(`say → ${r.status}`), { status: r.status })
  const out = {}
  for (const block of (await r.text()).split('\n\n')) {
    const ev = /^event: (.+)$/m.exec(block)?.[1]
    const data = /^data: (.+)$/m.exec(block)?.[1]
    if (ev && data) out[ev] = JSON.parse(data)
  }
  return out
}
const messages = (token, threadId) => api(token, `/threads/${threadId}/messages`)
const cliLog = async () => { try { return (await fs.readFile(process.env.FAKE_CLI_LOG, 'utf8')).trim().split('\n').map((l) => JSON.parse(l)) } catch { return [] } }
const jobRow = async (id) => (await q('select * from pro_local_jobs where id=$1', [id]))[0]

// ---------- the BFF ----------
await step('BFF 를 띄운다(PRO_BACKGROUND=0, 시험 회사, 로컬 에이전트 작업자 켬)', async () => {
  server = spawn(process.execPath, ['index.js'], { cwd: SERVER, env: { ...process.env, PRO_PORT: String(PORT), PRO_BACKGROUND: '0', PRO_ONTOLOGY_WORKER: '0', PRO_SCENARIOS: 'off',
    PRO_LOCAL_AGENT_TICK_MS: '500', PRO_LLM_BASE_URL: 'http://127.0.0.1:9/v1', PRO_PUBLIC_URL: BASE,
    // (no shared service is called: the server agent, completion and the context router are nowhere here)
    PRO_DEEPAGENTS_URL: 'http://127.0.0.1:9', PRO_COMPLETION_URL: 'http://127.0.0.1:9', PRO_CONTEXT_ROUTER_URL: 'http://127.0.0.1:9' }, stdio: ['ignore', 'pipe', 'pipe'] })
  server.stdout.on('data', (d) => serverLog.push(String(d)))
  server.stderr.on('data', (d) => serverLog.push(String(d)))
  await waitFor(async () => (await fetch(`${BASE}/api/config`).catch(() => null))?.ok, 60000, 'the BFF')
  return BASE
})

const signIn = async (email, name) => {
  const r = await api(null, '/auth/email/verify', { method: 'POST', body: { email, code: '000000' } })
  await api(r.session.access_token, '/profile', { method: 'POST', body: { name, birth: '1990-01-01', onboarded: true } })
  await api(r.session.access_token, '/me')
  people.push(r.user.id)
  return { id: r.user.id, token: r.session.access_token, name }
}
const TH = await signIn('pro-rt-chatagent-t@uengine.org', '윤태호')
const HR = await signIn('pro-rt-chatagent-h@uengine.org', '서하린')
const [main] = await api(TH.token, '/threads')
const [hrMain] = await api(HR.token, '/threads')
let device = null
let pc = null
const runnerFor = (settleMs = 60_000) => {
  const r = createLocalRunner({ server: BASE, token: device.token, dataDir: path.join(ROOT, 'desktop-th'), device: { name: '윤태호의 맥', platform: 'darwin', appVersion: 'e2e' },
    prefs: () => ({ enabled: true, ask: false }), searchPath: SEARCH, log: (s) => serverLog.push(`[runner] ${s}\n`), sessionEnv: CLI_ENV, settleMs })
  runners.push(r)
  return r
}

await step('고르기: PC 앱이 없으면 내 PC 항목은 꺼져 있고 까닭이 보인다 · 데스크톱을 이으면 켜진다 · 고른 것은 대화마다 남는다', async () => {
  const before = await api(TH.token, `/local-agents/chat?key=${main.id}`)
  assert.equal(before.choice, 'default')
  assert.deepEqual(before.agents.map((a) => a.id), ['default', 'claude-code', 'codex'])
  assert.ok(before.agents.filter((a) => a.id !== 'default').every((a) => !a.available && a.why), 'off, with why')
  assert.match(before.download, /#desktop$/)
  device = await api(TH.token, '/local-agents/devices', { method: 'POST', body: { name: '윤태호의 맥', platform: 'darwin', appVersion: 'e2e' } })
  pc = await runnerFor().start()
  await waitFor(() => pc.status().connected, 10000, 'linked')
  const after = await api(TH.token, `/local-agents/chat?key=${main.id}`)
  assert.equal(after.desktop.online, 1)
  assert.ok(after.agents.find((a) => a.id === 'claude-code').available)
  assert.ok(after.agents.find((a) => a.id === 'codex').available)
  // kept per chat: the main chat, one of its conversations, separately
  await api(TH.token, '/local-agents/chat/choice', { method: 'PUT', body: { key: main.id, agent: 'claude-code' } })
  await api(TH.token, '/local-agents/chat/choice', { method: 'PUT', body: { key: `${main.id}:conv-a`, agent: 'codex' } })
  assert.equal((await api(TH.token, `/local-agents/chat?key=${main.id}`)).choice, 'claude-code')
  assert.equal((await api(TH.token, `/local-agents/chat?key=${main.id}:conv-a`)).choice, 'codex')
  assert.equal((await api(HR.token, `/local-agents/chat?key=${main.id}`)).choice, 'default', 'his choice is his')
  assert.equal(await status(TH.token, '/local-agents/chat/choice', { method: 'PUT', body: { key: main.id, agent: 'bash' } }), 400)
  // her picker: no desktop of hers → off
  assert.ok((await api(HR.token, '/local-agents/chat')).agents.filter((a) => a.id !== 'default').every((a) => !a.available))
  return `claude-code·codex 켜짐 · 고른 것 main=claude-code, conv-a=codex`
})

let job1
await step('메인 채팅 → Claude Code · 내 PC: 내 PC 에이전트 폴더에서 돌고, 마지막 말이 답 메시지로 · 만든 파일이 파일 카드로 온다', async () => {
  const r = await say(TH.token, main.id, 'WRITE 회의록.md :: 안건 1. 예산 2. 일정\nSAY :: 회의록을 만들었어요', { agent: 'claude-code' })
  assert.ok(r.done?.local && r.done.started, JSON.stringify(r))
  job1 = r.done.jobId
  const ans = await waitFor(async () => (await messages(TH.token, main.id)).find((m) => m.role === 'agent' && m.kind === 'text' && m.content?.localAgent?.jobId === job1), 40000, 'the answer')
  assert.match(ans.content.text, /회의록\.md/)
  const all = await messages(TH.token, main.id)
  const mine = all.find((m) => m.role === 'user' && m.content?.agent?.id === 'claude-code')
  assert.equal(mine.content.agent.label, 'Claude Code')
  assert.equal(mine.content.agent.where, '내 PC')
  const card = all.find((m) => m.kind === 'local_run' && m.content?.jobId === job1)
  assert.ok(card?.content?.chat, 'the run card in the chat')
  const file = await waitFor(async () => (await messages(TH.token, main.id)).find((m) => m.kind === 'file' && m.content?.localRun?.jobId === job1), 20000, 'the file card')
  assert.equal(file.content.name, '회의록.md')
  assert.match(file.content.url, /\/storage\/v1\/object\/public\/files\//)
  assert.equal(file.content.folder?.path, '회의록.md')
  // the folder: his own, private, main has the file
  const [f] = await q(`select * from pro_folders where tenant_id=$1 and settings->'local_chat'->>'owner'=$2`, [TENANT, TH.id])
  assert.equal(f.name, '내 PC 에이전트 작업 · 윤태호')
  const members = await q(`select principal_id, role from pro_folder_members where folder_id=$1`, [f.id])
  assert.deepEqual(members.map((m) => [m.principal_id, m.role]), [[TH.id, 'owner']])
  assert.match(execFileSync('git', ['-C', f.repo_path, 'show', 'main:회의록.md'], { encoding: 'utf8' }), /안건 1/)
  // the server agent was not called: no other answer
  assert.equal(all.filter((m) => m.role === 'agent' && m.kind === 'text').length, 1)
  const j = await jobRow(job1)
  assert.equal(j.kind, 'chat')
  assert.equal(j.state, 'running', 'it waits after its turn for the next message')
  return `답 「${ans.content.text.slice(0, 40)}」 · 파일 카드 ${file.content.name} · 폴더 ${f.name}`
})

await step('이어서 보낸 메시지는 같은 CLI 세션에 들어간다(새 실행 없음) · 답과 파일 카드가 또 온다', async () => {
  const r = await say(TH.token, main.id, 'WRITE 할일.md :: 견적서 보내기', { agent: 'claude-code' })
  assert.ok(r.done?.steered, JSON.stringify(r))
  assert.equal(r.done.jobId, job1)
  await waitFor(async () => (await messages(TH.token, main.id)).filter((m) => m.role === 'agent' && m.kind === 'text' && m.content?.localAgent?.jobId === job1).length >= 2, 40000, 'the second answer')
  await waitFor(async () => (await messages(TH.token, main.id)).find((m) => m.kind === 'file' && m.content?.name === '할일.md'), 20000, 'the second file card')
  const log = await cliLog()
  const sessions = new Set(log.filter((l) => l.received).map((l) => l.session))
  assert.equal(sessions.size, 1, 'one CLI session')
  assert.ok(log.some((l) => l.received?.includes('할일.md')))
  assert.equal((await q(`select count(*)::int as n from pro_local_jobs where tenant_id=$1 and kind='chat'`, [TENANT]))[0].n, 1)
  return `세션 ${[...sessions][0].slice(0, 8)} 하나`
})

await step('「끝내기」로 세션을 닫은 뒤의 메시지: 새 실행이 같은 세션을 이어(--resume) 답한다', async () => {
  await api(TH.token, `/local-agents/jobs/${job1}/finish`, { method: 'POST' })
  const done = await waitFor(async () => { const j = await jobRow(job1); return j.state === 'done' ? j : null }, 30000, 'done')
  const card = await api(TH.token, `/local-agents/jobs/${job1}`)
  assert.match(card.text, /세션을 닫았어요/)
  const r = await say(TH.token, main.id, 'READ 회의록.md', { agent: 'claude-code' })
  assert.ok(r.done?.started)
  assert.notEqual(r.done.jobId, job1)
  const j2 = await jobRow(r.done.jobId)
  assert.equal(j2.chat.resumeOf, done.session_id)
  await waitFor(async () => (await messages(TH.token, main.id)).find((m) => m.role === 'agent' && m.kind === 'text' && m.content?.localAgent?.jobId === r.done.jobId), 40000, 'the answer of the resumed session')
  const log = await cliLog()
  const resumed = log.find((l) => l.args && l.resumed)
  assert.ok(resumed, 'claude --resume')
  assert.equal(resumed.session, done.session_id)
  await api(TH.token, `/local-agents/jobs/${r.done.jobId}/finish`, { method: 'POST' })
  await waitFor(async () => (await jobRow(r.done.jobId)).state === 'done', 30000, 'second done')
  return `이어 받은 세션 ${resumed.session.slice(0, 8)}`
})

await step('다른 사람: 그의 실행을 보거나 입력 · 끝내기 · 다시 보내기 → 403, 그의 대화에 보내기 → 404', async () => {
  assert.equal(await status(HR.token, `/local-agents/jobs/${job1}`), 403)
  assert.equal(await status(HR.token, `/local-agents/jobs/${job1}/steer`, { method: 'POST', body: { text: 'x' } }), 403)
  assert.equal(await status(HR.token, `/local-agents/jobs/${job1}/finish`, { method: 'POST' }), 403)
  assert.equal(await status(HR.token, `/local-agents/jobs/${job1}/fallback`, { method: 'POST' }), 403)
  assert.equal(await status(HR.token, `/local-agents/jobs/${job1}/term`, { method: 'POST' }), 403)
  const r = await fetch(`${BASE}/api/threads/${main.id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${HR.token}` }, body: JSON.stringify({ text: 'x', agent: 'claude-code' }) })
  assert.equal(r.status, 404)
  // her own chat to Claude Code: no desktop of hers → it waits for hers; never his
  const mine = await say(HR.token, hrMain.id, 'WRITE 남의것.md :: x', { agent: 'claude-code' })
  const j = await jobRow(mine.done.jobId)
  assert.equal(j.state, 'queued')
  assert.equal(j.device_id, null)
  await api(HR.token, `/local-agents/jobs/${j.id}/fallback`, { method: 'POST' })
  return '403 · 404 · 그녀의 메시지는 그녀의 PC 를 기다림'
})

await step('PC 가 꺼지면: 고르기에 「PC 앱이 꺼져 있어요」, 보낸 메시지는 기다리고, 「기본으로 다시 보내기」가 그 글을 돌려준다', async () => {
  pc.stop()
  await waitFor(async () => (await api(TH.token, '/local-agents/chat')).desktop.online === 0, 10000, 'off')
  const av = await api(TH.token, '/local-agents/chat')
  const cc = av.agents.find((a) => a.id === 'claude-code')
  assert.equal(cc.available, false)
  assert.equal(cc.why, 'PC 앱이 꺼져 있어요')
  const r = await say(TH.token, main.id, '오늘 일정 정리해 줘', { agent: 'claude-code' })
  const j = await jobRow(r.done.jobId)
  assert.equal(j.state, 'queued')
  const card = await api(TH.token, `/local-agents/jobs/${j.id}`)
  assert.match(card.text, /PC 앱이 꺼져 있어요/)
  assert.equal(card.canFallback, true)
  const back = await api(TH.token, `/local-agents/jobs/${j.id}/fallback`, { method: 'POST' })
  assert.equal(back.text, '오늘 일정 정리해 줘')
  assert.equal(back.threadId, main.id)
  const after = await jobRow(j.id)
  assert.equal(after.state, 'cancelled')
  assert.equal(after.why, 'fallback')
  return `대기 → 다시 보내기: 「${back.text}」`
})

await step('프로젝트 대화: 그 프로젝트 폴더의 변형에 파일이 들어가고(main 은 그대로) · runner 권한은 403 · 폴더 구성원은 보기만', async () => {
  pc = await runnerFor().start()
  await waitFor(() => pc.status().connected, 10000, 'linked again')
  const proj = await api(TH.token, '/threads', { method: 'POST', body: { text: '세미나 준비', newFolder: '세미나 준비 폴더' } })
  assert.equal(proj.folder?.mode, 'project')
  const r = await say(TH.token, proj.id, 'WRITE 설계.md :: 좌석 40석', { agent: 'codex' })
  assert.ok(r.done?.started, JSON.stringify(r))
  const file = await waitFor(async () => (await messages(TH.token, proj.id)).find((m) => m.kind === 'file' && m.content?.localRun?.jobId === r.done.jobId), 40000, 'the project file card')
  assert.equal(file.content.name, '설계.md')
  assert.equal(file.content.folder, undefined, "a project's file card is a copy (its folder changes through 반영)")
  const [f] = await q(`select * from pro_folders where tenant_id=$1 and name='세미나 준비 폴더'`, [TENANT])
  const [v] = await q(`select * from pro_folder_variations where folder_id=$1 and source->>'thread_id'=$2`, [f.id, proj.id])
  assert.match(execFileSync('git', ['-C', f.repo_path, 'show', `${v.branch}:설계.md`], { encoding: 'utf8' }), /좌석 40석/)
  assert.throws(() => execFileSync('git', ['-C', f.repo_path, 'show', 'main:설계.md'], { stdio: 'pipe' }), 'main is untouched until 반영')
  // a folder member watches; she cannot type
  assert.equal(await status(HR.token, `/local-agents/jobs/${r.done.jobId}`), 403, 'not a member yet')
  await q(`insert into pro_folder_members (folder_id, principal_type, principal_id, role, added_by) values ($1,'user',$2,'runner',$3)`, [f.id, HR.id, TH.id])
  const seen = await api(HR.token, `/local-agents/jobs/${r.done.jobId}`)
  assert.equal(seen.worker, false)
  assert.equal(await status(HR.token, `/local-agents/jobs/${r.done.jobId}/steer`, { method: 'POST', body: { text: 'x' } }), 403)
  // her own project in that folder (she may run it, not edit it): her local agent is refused, said under her message
  const hp = await api(HR.token, '/threads', { method: 'POST', body: { text: '세미나 보조', folder: f.id } })
  const refused = await say(HR.token, hp.id, 'WRITE x.md :: y', { agent: 'codex' })
  assert.equal(refused.error?.status, 403, JSON.stringify(refused))
  const said = (await messages(HR.token, hp.id)).find((m) => m.content?.localRefused)
  assert.match(said.content.text, /편집자/)
  await api(TH.token, `/local-agents/jobs/${r.done.jobId}/finish`, { method: 'POST' })
  await waitFor(async () => (await jobRow(r.done.jobId)).state === 'done', 30000, 'project done')
  return `변형 ${v.branch} 에 설계.md · 구성원 보기 200 · 입력 403 · runner 보내기 403`
})

await save()
await cleanup()
console.log(`# ${report.filter((r) => r.ok).length}/${report.length} passed`)
process.exit(0)
