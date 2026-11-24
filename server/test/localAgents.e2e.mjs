// Local CLI agents end to end (docs/local-agents/design.md, spec openspec/specs/local-agents): a real Lite BFF, two people's desktops
// (the desktop app's own runner, desktop/src/runner, with fake interactive `claude` and `codex` in a terminal —
// desktop/test/fixtures/fake-tui.js — on their path) linked over the WebSocket, and one process instance whose steps name local agents:
//   1. step 1 for A (Claude Code): A's desktop clones the instance's work folder, runs, pushes; the server puts it on the instance line
//   2. step 2 for B (Claude Code): B's desktop syncs first and sees A's result; B steers it from the instance's conversation mid-run
//   3. step 3 for B while B's desktop is off (wait): it waits — the instance shows why — and runs when the desktop comes on
//   4. step 4 for B while B's desktop is off (hand to the server): it goes to the server agent at once; a waiting one B hands over by hand
//   (2 also: a participant sees the run pushed live and suggests a prompt — only the worker puts it in (403 for anyone else); someone outside
//    the instance gets 403; what the run learned is proposed and only the process's owner applies it)
//   (2 also: the run's terminal — a viewer and the CLI's owner get the same bytes the owner's desktop terminal holds; the viewer's typing is
//    dropped, the owner's reaches the CLI; someone outside gets no ticket)
//   5. step 5 for A on Codex, steered: typed into the same running session (its rollout says it took it)
//   6. A's device revoked: the link is refused
//   node test/localAgents.e2e.mjs   (a free port in 8811–8829, tenant "localagent-e2e", folders in a temporary directory; no model)
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const here = path.dirname(fileURLToPath(import.meta.url))
const SERVER = path.resolve(here, '..')
const DESKTOP = path.resolve(SERVER, '..', 'desktop')
const require = createRequire(import.meta.url)
const { createLocalRunner } = require(path.join(DESKTOP, 'src/runner/index.js'))
const { fakeBin } = require(path.join(DESKTOP, 'test/helpers/fakeBin.js'))
const AVOID = new Set([5199, 5195, 8795, 8777, 8794, 8796, 8797, 27790, 8088, 8787, 8798])
const portFree = (p) => { try { execFileSync('lsof', ['-nP', `-iTCP:${p}`, '-sTCP:LISTEN'], { stdio: 'ignore' }); return false } catch { return true } }
const PORT = Number(process.env.LA_PORT) || Array.from({ length: 19 }, (_, i) => 8811 + i).find((p) => !AVOID.has(p) && portFree(p))
const BASE = `http://127.0.0.1:${PORT}`
const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'pgl-localagents-'))
const TENANT = 'localagent-e2e'
const RESULTS = process.env.LA_RESULTS || ''
Object.assign(process.env, { PRO_TENANT_ID: TENANT, PRO_TENANT_HOSTS: '', PRO_FOLDERS_ROOT: path.join(ROOT, 'folders') })
const { q, pool } = await import('../lib/supa.js')
const BIN = fakeBin(path.join(ROOT, 'bin'))
process.env.FAKE_CLI_HOME = path.join(ROOT, 'fake-home')
process.env.FAKE_CLI_LOG = path.join(ROOT, 'fake.log')
// the CLIs' own config folders for the test (the runner marks its folders trusted there — never in the person's ~/.claude.json)
const CLI_ENV = { CLAUDE_CONFIG_DIR: path.join(ROOT, 'claude-config'), CODEX_HOME: path.join(ROOT, 'codex-home') }
await fs.mkdir(CLI_ENV.CLAUDE_CONFIG_DIR, { recursive: true })
const SEARCH = [BIN, '/usr/bin', '/bin', '/opt/homebrew/bin'].join(path.delimiter)

let server
const serverLog = []
const runners = []
const report = []
let n = 0
async function cleanup() {
  for (const r of runners) try { r.stop() } catch { /* gone */ }
  if (server && server.exitCode == null) { server.kill('SIGTERM'); await new Promise((r) => server.once('exit', r)) }
  await q(`delete from todolist where tenant_id=$1`, [TENANT]).catch(() => {})
  await q(`delete from bpm_proc_inst where tenant_id=$1`, [TENANT]).catch(() => {})
  await q(`delete from proc_def where tenant_id=$1`, [TENANT]).catch(() => {})
  await q(`delete from pro_local_jobs where tenant_id=$1`, [TENANT]).catch(() => {})
  await q(`delete from pro_local_devices where tenant_id=$1`, [TENANT]).catch(() => {})
  await q(`delete from pro_threads where ref like 'la_e2e_%'`).catch(() => {})
  await q(`delete from pro_folders where tenant_id=$1`, [TENANT]).catch(() => {})
  await pool.end()
  await fs.rm(ROOT, { recursive: true, force: true })
}
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
async function save() { if (RESULTS) await fs.writeFile(RESULTS, JSON.stringify({ at: new Date().toISOString(), port: PORT, steps: report }, null, 2)) }
const waitFor = async (fn, ms = 30000, what = '') => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error(`timed out: ${what}`); await new Promise((r) => setTimeout(r, 200)) } }
const api = async (token, p, { method = 'GET', body } = {}) => {
  const r = await fetch(`${BASE}/api${p}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined })
  const text = await r.text()
  let j = null
  try { j = JSON.parse(text) } catch { j = text }
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${text.slice(0, 200)}`)
  return j
}

// ---------- the BFF ----------
await step('BFF 를 띄운다(PRO_BACKGROUND=0, 시험 회사, 로컬 에이전트 작업자 켬)', async () => {
  server = spawn(process.execPath, ['index.js'], { cwd: SERVER, env: { ...process.env, PRO_PORT: String(PORT), PRO_BACKGROUND: '0', PRO_ONTOLOGY_WORKER: '0', PRO_SCENARIOS: 'off',
    PRO_LOCAL_AGENT_TICK_MS: '500', PRO_LLM_BASE_URL: 'http://127.0.0.1:9/v1', PRO_PUBLIC_URL: BASE }, stdio: ['ignore', 'pipe', 'pipe'] })
  server.stdout.on('data', (d) => serverLog.push(String(d)))
  server.stderr.on('data', (d) => serverLog.push(String(d)))
  await waitFor(async () => (await fetch(`${BASE}/api/config`).catch(() => null))?.ok, 60000, 'the BFF')
  return `${BASE}`
})

const signIn = async (email) => (await api(null, '/auth/email/verify', { method: 'POST', body: { email, code: '000000' } }))
const A = await signIn('pro-rt-local-a@uengine.org')
const B = await signIn('pro-rt-local-b@uengine.org')
// C: not in the instance at all · D: in the instance (a participant) but may not edit its work
const Cu = await signIn('pro-rt-local-c@uengine.org')
const Du = await signIn('pro-rt-local-d@uengine.org')
const ta = A.session.access_token, tb = B.session.access_token, tc = Cu.session.access_token, td = Du.session.access_token
const uidA = A.user.id, uidB = B.user.id, uidD = Du.user.id
// what a person's browser is pushed (the app's own SSE, /api/events): 'local_run' events, as they come
function listen(token) {
  const got = []
  const ctl = new AbortController()
  ;(async () => {
    try {
      const r = await fetch(`${BASE}/api/events?token=${encodeURIComponent(token)}`, { signal: ctl.signal })
      const dec = new TextDecoder()
      let buf = ''
      for await (const chunk of r.body) {
        buf += dec.decode(chunk, { stream: true })
        let i
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2)
          const ev = /^event: (.+)$/m.exec(block)?.[1]
          const data = /^data: (.+)$/m.exec(block)?.[1]
          if (ev === 'local_run' && data) got.push(JSON.parse(data))
        }
      }
    } catch { /* closed */ }
  })()
  return { got, stop: () => ctl.abort() }
}
// a viewer of a run's terminal (relay.js) — as the page connects (agent-share's protocol): all = the screen's bytes so far
function viewer(ticket) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/api/local-agents/term?ticket=${encodeURIComponent(ticket)}`, { headers: { Origin: BASE } })
    const v = { ws, all: '', msgs: [], send: (m) => ws.send(JSON.stringify(m)) }
    ws.on('message', (d) => { const m = JSON.parse(String(d)); v.msgs.push(m); if (m.type === 'output') v.all = m.replay ? m.data : v.all + m.data; if (m.type === 'session') resolve(v); if (m.type === 'denied') reject(new Error(m.reason)) })
    ws.on('error', reject)
  })
}
const status = async (token, p, opts) => { try { await api(token, p, opts); return 200 } catch (e) { return Number(/→ (\d{3})/.exec(e.message)?.[1] || 0) } }

const devices = {}
function runnerFor(who, token, { prefs = { enabled: true, ask: false } } = {}) {
  const r = createLocalRunner({ server: BASE, token, dataDir: path.join(ROOT, 'desktop', who), device: { name: `${who}의 맥`, platform: 'darwin', appVersion: 'e2e' },
    prefs: () => prefs, searchPath: SEARCH, log: (s) => serverLog.push(`[runner ${who}] ${s}\n`), sessionEnv: CLI_ENV, settleMs: 800 })
  runners.push(r)
  return r
}
let ra, rb
await step('두 사람이 각자 데스크톱을 잇는다(기기 토큰 → 링크 → welcome)', async () => {
  devices.A = await api(ta, '/local-agents/devices', { method: 'POST', body: { name: 'A의 맥', platform: 'darwin', appVersion: 'e2e' } })
  devices.B = await api(tb, '/local-agents/devices', { method: 'POST', body: { name: 'B의 맥', platform: 'darwin', appVersion: 'e2e' } })
  assert.match(devices.A.token, /^pld1_/)
  ra = await runnerFor('A', devices.A.token).start()
  rb = await runnerFor('B', devices.B.token).start()
  await waitFor(() => ra.status().connected && rb.status().connected, 10000, 'both links')
  assert.equal(ra.status().user.id, uidA)
  assert.equal(ra.status().clis['claude-code'].installed, true)
  const list = await api(ta, '/local-agents/devices')
  assert.ok(list.some((d) => d.id === devices.A.device.id && d.online))
  const cat = await api(ta, '/local-agents/catalog')
  assert.equal(cat.local.find((x) => x.id === 'local:claude-code').devices, 2)
  return `A ${ra.status().device.name} · B ${rb.status().device.name} · catalog claude-code ${cat.local[0].devices}대`
})

// ---------- one instance ----------
const DEF = `la_e2e_${crypto.randomBytes(3).toString('hex')}`
const INST = `${DEF}.${crypto.randomUUID()}`
const acts = [
  { id: 'quote', name: '견적서 작성', instruction: 'READ 메모.md\nWRITE_OUT 견적서.md :: 견적 초안 — A가 만든 것' },
  { id: 'review', name: '견적 검토', skills: ['견적-규칙'], instruction: 'SLEEP 2500\nREAD 산출물/01_견적서 작성/견적서.md\nSLEEP 3000\nWRITE_OUT 검토.md :: 검토 의견 — B\nSLEEP 3000\nSLEEP 3000\nSLEEP 3000\nWRITE_OUT 마무리.md :: 마무리' },
  { id: 'send', name: '발송 준비', instruction: 'WRITE_OUT 발송.md :: 발송 준비 — B (기다렸다가)' },
  { id: 'archive', name: '보관', instruction: 'WRITE_OUT 보관.md :: 보관' },
  { id: 'memo', name: '메모 정리', instruction: 'SLEEP 2500\nWRITE_OUT 처음.md :: 처음 계획' },
]
await step('인스턴스와 단계 정의를 둔다(활동 지시 = 가짜 CLI 의 할 일, 프로세스 담당자 A) · 회사 스킬 「견적-규칙」 · B 와 D 는 팀원', async () => {
  // (the team: who signs in to Lite joins it — GET /api/me; C never does)
  for (const t of [ta, tb, td]) await api(t, '/me')
  await q(`insert into proc_def (id, name, definition, tenant_id, owner) values ($1,$2,$3,$4,$5)`, [DEF, '로컬 에이전트 시험', { activities: acts }, TENANT, uidA])
  // a company skill: its folder (kind skill) — what the server agent of 「견적 검토」 would load
  const S = await import('../lib/folders/service.js')
  const f = await S.createFolder({ id: uidA, name: 'A', email: 'pro-rt-local-a@uengine.org' }, { name: `견적-규칙 스킬 ${Date.now()}` })
  await S.upload(f, { id: uidA, name: 'A' }, 'SKILL.md', Buffer.from('---\nname: 견적-규칙\ndescription: 견적서는 부가세 포함\n---\n금액은 늘 부가세 포함으로.\n'))
  await q(`update pro_folders set kind='skill', settings = settings || $2 where id=$1`, [f.id, { skill_name: '견적-규칙' }])
  await q(`insert into bpm_proc_inst (proc_inst_id, proc_inst_name, proc_def_id, status, tenant_id, participants) values ($1,$2,$3,'RUNNING',$4,$5)`,
    [INST, '세미나 견적 — 로컬 에이전트 시험', DEF, TENANT, [uidA, uidB, uidD]])
})
async function stepFor(act, user, local, { mode = 'COMPLETE' } = {}) {
  const [t] = await q(`insert into todolist (id, tenant_id, user_id, proc_inst_id, root_proc_inst_id, proc_def_id, activity_id, activity_name, status, agent_mode, agent_orch, agent_config, start_date)
                       values (gen_random_uuid(), $1, $2, $3, $3, $4, $5, $6, 'IN_PROGRESS', $7::agent_mode, 'pgpt-pro-local', $8, now()) returning id::text as id`,
  [TENANT, user, INST, DEF, act.id, act.name, mode, { local }])
  return t.id
}
const jobOf = async (todo) => (await q('select * from pro_local_jobs where todo_id=$1', [todo]))[0]
const todo = async (id) => (await q(`select status::text as status, draft_status::text as draft_status, agent_orch, agent_config, output from todolist where id=$1`, [id]))[0]
const folderOfInst = async () => (await q(`select * from pro_folders where tenant_id=$1 and settings ? 'work' and (settings->'work'->'instances') ? $2`, [TENANT, INST]))[0]
const lineFile = (f, rel) => execFileSync('git', ['show', `${f.settings.work.line}:${rel}`], { cwd: f.repo_path }).toString()

let t1, t2
await step('1. A 의 단계(Claude Code): A 의 데스크톱이 작업 폴더를 받아 실행하고 올린다 → 인스턴스 라인에 들어가고 단계가 끝난다', async () => {
  t1 = await stepFor(acts[0], uidA, { agent: 'claude-code', offline: 'wait' })
  const j = await waitFor(async () => { const x = await jobOf(t1); return x?.state === 'done' || x?.state === 'failed' ? x : null }, 30000, 'step 1 done')
  assert.equal(j.state, 'done', j.error)
  assert.equal(String(j.device_id), devices.A.device.id)
  assert.ok(j.result.pushed)
  const f = await folderOfInst()
  assert.ok(f, '인스턴스의 작업 폴더가 만들어졌다')
  assert.equal(lineFile(f, '산출물/01_견적서 작성/견적서.md'), '견적 초안 — A가 만든 것\n')
  assert.match(lineFile(f, '산출물/01_견적서 작성/결과.md'), /Claude Code/)
  const t = await todo(t1)
  assert.ok(['SUBMITTED', 'DONE'].includes(t.status), t.status)
  // the instance's conversation of A has the run's card
  const [card] = await q(`select m.content from pro_messages m join pro_threads th on th.id=m.thread_id where th.user_id=$1 and th.ref=$2 and m.kind='local_run'`, [uidA, INST])
  assert.equal(card.content.state, 'done')
  // the token was never in the clone's config
  const clone = (await fs.readdir(path.join(ROOT, 'desktop', 'A', 'work'), { recursive: true })).find((p) => p.endsWith(path.join('.git', 'config')))
  assert.ok(!(await fs.readFile(path.join(ROOT, 'desktop', 'A', 'work', clone), 'utf8')).includes('pgf1.'))
  return `${j.result.branch} → ${f.settings.work.line} · ${t.status} · ${j.result.files.length} files`
})

await step('2. B 의 단계: B 의 데스크톱이 먼저 맞춰 A 의 결과를 보고, 실행 중에 인스턴스 대화에서 방향을 바꾼다(같은 세션) — 다른 사람에게도 실시간으로, 권한대로', async () => {
  const dSees = listen(td)
  const cSees = listen(tc)
  t2 = await stepFor(acts[1], uidB, { agent: 'claude-code', offline: 'wait' })
  await waitFor(async () => (await jobOf(t2))?.state === 'running', 20000, 'step 2 running')
  await waitFor(async () => (await jobOf(t2))?.lines?.some((l) => /sleep/i.test(l.text)), 20000, 'B working')
  const job2 = await jobOf(t2)
  // D (a participant who may not edit) sees it live — pushed, with who runs it where — and may not steer or hand it over
  const pushed = await waitFor(() => dSees.got.find((e) => e.jobId === job2.id && e.card?.state === 'running' && e.card.lines?.length), 10000, 'D pushed')
  assert.equal(pushed.card.person, 'pro-rt-local-b')
  assert.equal(pushed.card.device, 'B의 맥')
  assert.equal(pushed.card.canSteer, false)
  assert.equal(await status(td, `/local-agents/instances/${encodeURIComponent(INST)}`), 200)
  assert.equal(await status(td, `/local-agents/jobs/${job2.id}/steer`, { method: 'POST', body: { text: 'D 의 지시' } }), 403)
  assert.equal(await status(td, `/local-agents/jobs/${job2.id}/delegate`, { method: 'POST' }), 403)
  // C (not in the instance) sees nothing of it
  assert.equal(await status(tc, `/local-agents/instances/${encodeURIComponent(INST)}`), 403)
  assert.equal(await status(tc, `/local-agents/jobs/${job2.id}`), 403)
  assert.equal(await status(tc, `/local-agents/jobs/${job2.id}/steer`, { method: 'POST', body: { text: 'C 의 지시' } }), 403)
  assert.ok(!cSees.got.some((e) => e.jobId === job2.id), 'C 에게는 밀어 주지 않는다')
  assert.ok(!(await api(tc, '/local-agents/active')).some((c) => c.jobId === job2.id))
  // nobody but B (whose CLI it is) puts words in — not even A, who owns the work folder
  assert.equal((await api(ta, `/local-agents/jobs/${job2.id}`)).canSteer, false)
  assert.equal((await api(ta, `/local-agents/jobs/${job2.id}`)).worker, false)
  assert.equal((await api(tb, `/local-agents/jobs/${job2.id}`)).worker, true)
  assert.equal(await status(ta, `/local-agents/jobs/${job2.id}/steer`, { method: 'POST', body: { text: 'A 의 입력' } }), 403)
  assert.ok((await api(tb, '/local-agents/active')).some((c) => c.jobId === job2.id), 'B 의 Home 카드')
  // D suggests a prompt: it stacks at B's input (not in the CLI); C (outside the instance) cannot
  const { suggestion } = await api(td, `/local-agents/jobs/${job2.id}/suggestions`, { method: 'POST', body: { text: 'WRITE_OUT 의견.md :: D 의 제안 — 할인 줄을 따로' } })
  assert.equal(await status(tc, `/local-agents/jobs/${job2.id}/suggestions`, { method: 'POST', body: { text: 'C' } }), 403)
  assert.equal(await status(td, `/local-agents/jobs/${job2.id}/steer`, { method: 'POST', body: { text: 'D', suggestionId: suggestion.id } }), 403)
  assert.equal(await status(td, `/local-agents/jobs/${job2.id}/suggestions/${suggestion.id}/dismiss`, { method: 'POST' }), 403)
  assert.equal((await jobOf(t2)).steers.length, 0, '제안은 CLI 로 가지 않는다')
  const [hb] = await q(`select title from notifications where user_id=$1 and type='local_suggestion'`, [uidB])
  assert.match(hb.title, /pro-rt-local-d의 제안 · 견적 검토/)
  // B loads it, edits it, puts it in: attributed to both
  const sent = await api(tb, `/local-agents/jobs/${job2.id}/steer`, { method: 'POST', body: { text: 'WRITE_OUT 의견.md :: D 의 제안 — 할인 줄을 따로(B 가 고침)', suggestionId: suggestion.id } })
  assert.equal(sent.steer.from.name, 'pro-rt-local-d')
  assert.equal(sent.steer.name, 'pro-rt-local-b')
  const used = sent.job.suggestions.find((x) => x.id === suggestion.id)
  assert.deepEqual([used.state, used.edited], ['used', true])
  assert.equal((await api(td, `/local-agents/jobs/${job2.id}`)).suggestions.find((x) => x.id === suggestion.id).state, 'used', 'D 도 입력된 것을 본다')
  // the run's terminal: D (a viewer) and B (whose CLI it is) get the very bytes of B's own desktop terminal; D's typing is dropped, B's
  // reaches the CLI; C (outside the instance) gets no ticket
  const jt = await jobOf(t2)
  assert.equal(jt.terminal, true)
  const tD = await api(td, `/local-agents/jobs/${jt.id}/term`, { method: 'POST' })
  const tB = await api(tb, `/local-agents/jobs/${jt.id}/term`, { method: 'POST' })
  assert.deepEqual([tD.owner, tB.owner, tD.live], [false, true, true])
  assert.equal(await status(tc, `/local-agents/jobs/${jt.id}/term`, { method: 'POST' }), 403)
  const vd = await viewer(tD.ticket)
  const vb = await viewer(tB.ticket)
  const deskTerm = [...rb.runner.sessions.values()].find((x) => x.ref === jt.id).S
  await waitFor(() => vd.all.length > 200 && vd.all === deskTerm.buf && vb.all === deskTerm.buf, 10000, 'the same bytes as the desktop terminal')
  assert.match(vd.all, /Claude Code \(fake\)/)
  vd.send({ type: 'input', data: 'WRITE_OUT 몰래.md :: D 가 터미널에 침' })
  vd.send({ type: 'input', data: '\r' })
  vb.send({ type: 'input', data: 'WRITE_OUT 터미널.md :: B 가 터미널에 직접 침' })
  vb.send({ type: 'input', data: '\r' })
  const scr = await waitFor(async () => { const x = await api(td, `/local-agents/jobs/${jt.id}/screen`); return x.stats.inputs >= 2 && x.stats.dropped >= 2 && x.screen.lines.some((l) => l.includes('B 가 터미널에 직접 침')) ? x : null }, 10000, 'inputs counted, echoed on the screen')
  assert.ok(scr.screen.lines.some((l) => /Working|Write\(/.test(l)), '「지금 화면」 — the server screen model')
  assert.ok(scr.screen.lines.some((l) => l.includes('B 가 터미널에 직접 침')), 'B 가 친 글이 화면에 echo 된다')
  vd.ws.close(); vb.ws.close()
  dSees.stop(); cSees.stop()
  const [th] = await waitFor(async () => { const r = await q(`select id from pro_threads where user_id=$1 and ref=$2`, [uidB, INST]); return r.length ? r : null }, 10000, 'B thread')
  // what B types in the instance's conversation steers the run
  const res = await fetch(`${BASE}/api/threads/${th.id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tb}` },
    body: JSON.stringify({ text: 'WRITE_OUT 조종.md :: 부가세 포함으로 — B가 실행 중에 바꿈' }) })
  const sse = await res.text()
  assert.match(sse, /"steered":true/)
  const j = await waitFor(async () => { const x = await jobOf(t2); return x?.state === 'done' || x?.state === 'failed' ? x : null }, 30000, 'step 2 done')
  assert.equal(j.state, 'done', j.error)
  assert.ok(j.steers.every((x) => x.applied === 'live'), JSON.stringify(j.steers))
  assert.deepEqual(j.steers.map((x) => [x.name, x.from?.name || null]).sort(), [['pro-rt-local-b', 'pro-rt-local-d'], ['pro-rt-local-b', null]].sort())
  assert.match(j.result.summary, /견적 초안 — A가 만든 것/, 'B 의 데스크톱이 A 의 결과를 받았다')
  assert.match(j.result.summary, /스킬: 견적-규칙/, '회사 스킬이 B 의 작업 폴더에(Claude Code 자리) 있었다')
  const f = await folderOfInst()
  assert.equal(lineFile(f, '산출물/02_견적 검토/조종.md'), '부가세 포함으로 — B가 실행 중에 바꿈\n')
  assert.equal(lineFile(f, '산출물/02_견적 검토/의견.md'), 'D 의 제안 — 할인 줄을 따로(B 가 고침)\n')
  assert.equal(lineFile(f, '산출물/02_견적 검토/터미널.md'), 'B 가 터미널에 직접 침\n', 'B 가 터미널에 친 글이 CLI 에 닿았다')
  assert.ok(!j.result.files.some((x) => x.endsWith('/몰래.md')), 'D 의 입력은 CLI 에 닿지 않았다')
  const typed = (await fs.readFile(process.env.FAKE_CLI_LOG, 'utf8')).trim().split('\n').map((l) => JSON.parse(l)).filter((x) => x.typed)
  assert.ok(typed.some((x) => x.typed.includes('B 가 터미널에 직접 침')) && !typed.some((x) => x.typed.includes('D 가 터미널에 침')))
  assert.ok(j.screen && j.screen.includes('Claude Code (fake)'), '끝난 화면은 일에 남는다')
  assert.ok(!j.result.files.some((x) => x.startsWith('.claude')), '스킬은 일의 결과로 올라가지 않는다')
  // what the run learned: candidates (the model is not reachable here: unjudged — still only proposed); only the process's owner (A) applies
  const k = await waitFor(async () => { const x = await jobOf(t2); return x.knowhow?.length ? x : null }, 10000, 'know-how')
  assert.ok(k.knowhow.every((x) => x.state === 'proposed' && x.kind === 'activity'))
  const cand = k.knowhow.find((x) => /부가세 포함으로/.test(x.text))
  assert.ok(k.knowhow.some((x) => x.suggestedBy === 'pro-rt-local-d' && x.by === 'pro-rt-local-b'), '배운 것에 제안한 사람과 입력한 사람이 함께')
  assert.equal(await status(tb, `/local-agents/jobs/${k.id}/knowhow/${cand.id}`, { method: 'POST', body: { action: 'apply' } }), 403)
  const applied = await api(ta, `/local-agents/jobs/${k.id}/knowhow/${cand.id}`, { method: 'POST', body: { action: 'apply' } })
  assert.equal(applied.knowhow.find((x) => x.id === cand.id).state, 'applied')
  assert.match(applied.knowhow.find((x) => x.id === cand.id).provenance, /^pro-rt-local-b의 로컬 실행에서 배움/)
  const [d] = await q('select definition from proc_def where id=$1', [DEF])
  assert.match(d.definition.activities.find((a) => a.id === 'review').instruction, /## 배운 것\n- WRITE_OUT 조종\.md :: 부가세 포함으로 — B가 실행 중에 바꿈 — pro-rt-local-b의 로컬 실행에서 배움/)
  const [n] = await q(`select title from notifications where user_id=$1 and type='local_knowhow' and url like $2`, [uidA, `%${INST}%`])
  assert.match(n.title, /배운 것 \d+개 · 견적 검토/)
  assert.equal(lineFile(f, '산출물/01_견적서 작성/견적서.md'), '견적 초안 — A가 만든 것\n', 'A 의 결과도 그대로')
  const chips = await q(`select m.content from pro_messages m where m.thread_id=$1 and m.kind='chip' and m.content ? 'localSteer'`, [th.id])
  assert.equal(chips.length, 1)
  return `steer ${j.steers[0].applied} · summary: ${j.result.summary.slice(0, 80)}`
})

await step('3. B 의 데스크톱이 꺼져 있으면(기다리기) 기다리고, 인스턴스가 까닭을 보이고, 켜지면 실행한다', async () => {
  rb.stop()
  await waitFor(async () => !(await api(tb, '/local-agents/devices')).find((d) => d.id === devices.B.device.id)?.online, 10000, 'B off')
  const t3 = await stepFor(acts[2], uidB, { agent: 'claude-code', offline: 'wait', waitMinutes: 30 })
  const j = await waitFor(async () => { const x = await jobOf(t3); return x?.state === 'queued' ? x : null }, 10000, 'step 3 queued')
  assert.equal(j.why, 'waiting')
  const view = await api(tb, `/local-agents/instances/${encodeURIComponent(INST)}`)
  const card = view.find((x) => x.todoId === t3)
  assert.match(card.text, /^PC 앱이 켜지면 시작/)
  assert.ok(card.waitUntil)
  assert.equal(card.canDelegate, true)
  assert.equal(view.find((x) => x.todoId === t3) && (await api(td, `/local-agents/instances/${encodeURIComponent(INST)}`)).find((x) => x.todoId === t3).canDelegate, false)
  assert.equal(await status(td, `/local-agents/jobs/${j.id}/delegate`, { method: 'POST' }), 403)
  rb = await runnerFor('B', devices.B.token).start()
  const done = await waitFor(async () => { const x = await jobOf(t3); return x?.state === 'done' || x?.state === 'failed' ? x : null }, 30000, 'step 3 done')
  assert.equal(done.state, 'done', done.error)
  return card.text
})

await step('4. B 의 데스크톱이 꺼져 있고 「서버에 맡기기」면 바로 서버 에이전트로 — 기다리는 실행은 B 가 손으로도 맡긴다', async () => {
  rb.stop()
  await waitFor(async () => !(await api(tb, '/local-agents/devices')).find((d) => d.id === devices.B.device.id)?.online, 10000, 'B off')
  const tw = await stepFor({ ...acts[3], id: 'archive-wait', name: '보관(기다림)' }, uidB, { agent: 'claude-code', offline: 'wait' })
  const w = await waitFor(async () => { const x = await jobOf(tw); return x?.state === 'queued' ? x : null }, 10000, 'waiting job')
  const out = await api(tb, `/local-agents/jobs/${w.id}/delegate`, { method: 'POST' })
  assert.equal(out.state, 'delegated')
  assert.match(out.text, /기다리지 않고/)
  await waitFor(async () => (await todo(tw)).agent_config?.local_delegated, 5000, 'handed over')
  const t4 = await stepFor(acts[3], uidB, { agent: 'claude-code', offline: 'server', serverAgent: 'onto' })
  const j = await waitFor(async () => { const x = await jobOf(t4); return x?.state === 'delegated' ? x : null }, 10000, 'step 4 delegated')
  assert.equal(j.why, 'offline')
  // (the step is handed over right after the job says so)
  const t = await waitFor(async () => { const x = await todo(t4); return x.agent_config?.local_delegated ? x : null }, 5000, '서버 에이전트에게 맡긴 표시')
  assert.ok(!t.agent_config.local)
  const view = await api(tb, `/local-agents/instances/${encodeURIComponent(INST)}`)
  return view.find((x) => x.todoId === t4).text
})

await step('5. A 의 Codex 단계: 실행 중 조종은 같은 세션의 터미널에 붙여 넣는다(rollout 이 받았다고 한다)', async () => {
  const t5 = await stepFor(acts[4], uidA, { agent: 'codex', offline: 'wait' })
  await waitFor(async () => (await jobOf(t5))?.session_id, 20000, 'codex session')
  const j0 = await jobOf(t5)
  const r = await api(ta, `/local-agents/jobs/${j0.id}/steer`, { method: 'POST', body: { text: 'WRITE_OUT 메모정리.md :: 코덱스가 바꾼 방향' } })
  assert.equal(r.delivered, true)
  const j = await waitFor(async () => { const x = await jobOf(t5); return x?.state === 'done' || x?.state === 'failed' ? x : null }, 30000, 'step 5 done')
  assert.equal(j.state, 'done', j.error)
  assert.equal(j.steers[0].applied, 'live')
  const f = await folderOfInst()
  // (step 4 went to the server agent: this is the fourth output folder)
  const file = j.result.files.find((x) => x.endsWith('/메모정리.md'))
  assert.equal(file, '산출물/04_메모 정리/메모정리.md')
  assert.equal(lineFile(f, file), '코덱스가 바꾼 방향\n')
  const log = (await fs.readFile(process.env.FAKE_CLI_LOG, 'utf8')).trim().split('\n').map((l) => JSON.parse(l)).filter((x) => x.kind === 'codex' && x.session === j.session_id)
  assert.ok(!log.some((x) => x.interrupted) && log.filter((x) => x.args).length === 1, 'one Codex session, not stopped')
  assert.ok(log.some((x) => x.received === 'WRITE_OUT 메모정리.md :: 코덱스가 바꾼 방향'))
  return `session ${j.session_id.slice(0, 8)} · runs ${log.filter((x) => x.args).length}`
})

await step('6. 기기를 끊으면 그 링크가 닫히고 다시 붙지 못한다 — 공개 git 경로(/api/local-git)도 그 기기의 일 토큰을 거절한다', async () => {
  // the public git path: only a token minted for one job on one linked desktop
  const GH = await import('../lib/folders/gitHttp.js')
  const j1 = await jobOf(t1)
  const refs = async (token) => (await fetch(`${BASE}/api/local-git/${j1.folder_id}.git/info/refs?service=git-upload-pack`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })).status
  const devTok = GH.mintToken({ tenant: TENANT, folderId: j1.folder_id, push: `pgpt-agent/local-${j1.id.slice(0, 8)}-`, scope: 'device', device: devices.A.device.id, job: j1.id })
  assert.equal(await refs(null), 401)
  assert.equal(await refs(GH.mintToken({ tenant: TENANT, folderId: j1.folder_id })), 403, '클러스터의 폴더 토큰은 공개 경로에서 받지 않는다')
  assert.equal(await refs(devTok), 200, '링크된 기기의 그 일 토큰은 읽기')
  // (the runners cloned and pushed over it: the work folders' remotes are the public path)
  assert.match(execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: ra.runner.dirFor({ instId: INST, git: { folder: { id: j1.folder_id } } }) }).toString(), /\/api\/local-git\//)
  await api(ta, `/local-agents/devices/${devices.A.device.id}`, { method: 'DELETE' })
  await waitFor(() => ra.status().refused?.code === 4401, 10000, 'A refused')
  const list = await api(ta, '/local-agents/devices')
  assert.ok(list.find((d) => d.id === devices.A.device.id).revoked)
  assert.equal(await refs(devTok), 403, '끊은 기기의 토큰은 공개 git 경로에서도 거절')
  return `refused ${ra.status().refused.code}`
})

await save()
await cleanup()
console.log(`# ${report.length} passed`)
