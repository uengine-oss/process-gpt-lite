// Local CLI agents in the desktop app (desktop/, Electron) driven by Playwright's _electron — spec openspec/specs/local-agents.
// Two people, each with their own desktop app (their own profile), signed in to the same Lite: the app pairs itself after sign-in, a step
// of A's runs on A's desktop (the pill says so), the next step of B's runs on B's desktop from A's result (synced first) and B steers it
// from the instance page, and B turning local runs off makes the next step wait until it is on again. The CLIs are fakes
// (desktop/test/fixtures/fake-cli.js: Claude Code's and Codex's arguments and JSON output, no model) put first on the runner's path.
// It starts its own stack — a BFF (PRO_BACKGROUND=0, tenant localagent-ui) and Vite in front of it — on free ports, and removes what it made.
//   cd e2e && npx playwright test --project=desktop tests/desktop/local-agents.spec.js
// Screenshots: openspec/specs/local-agents/e2e/results/.
import { test, expect, _electron } from '@playwright/test'
import { createRequire } from 'node:module'
import { spawn, execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(here, '../../..')
const DESKTOP = path.join(REPO, 'desktop')
const SERVER = path.join(REPO, 'server')
const SHOTS = path.join(REPO, 'openspec/specs/local-agents/e2e/results')
const require = createRequire(path.join(DESKTOP, 'package.json'))
let ELECTRON = ''
try { ELECTRON = require('electron') } catch { /* not installed */ }
const { fakeBin } = require('./test/helpers/fakeBin.js')
const pg = createRequire(path.join(SERVER, 'package.json'))('pg')
const TENANT = 'localagent-ui'
const AVOID = new Set([5199, 5195, 8795, 8777, 8794, 8796, 8797, 27790, 8088, 8787, 8798, 5180])
const portFree = (p) => { try { execFileSync('lsof', ['-nP', `-iTCP:${p}`, '-sTCP:LISTEN'], { stdio: 'ignore' }); return false } catch { return true } }
const freePort = (from, n = 20) => Array.from({ length: n }, (_, i) => from + i).find((p) => !AVOID.has(p) && portFree(p))

test.describe.configure({ mode: 'serial' })
test.skip(!ELECTRON || !fs.existsSync(ELECTRON), 'desktop/ 에 Electron 이 없음 (cd desktop && npm install)')

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pgl-local-ui-'))
const BIN = fakeBin(path.join(ROOT, 'bin'))
let API_PORT, WEB_PORT, bff, vite, db
const logs = []
const apps = {}
const users = {}
const api = async (token, p, { method = 'GET', body } = {}) => {
  const r = await fetch(`http://127.0.0.1:${API_PORT}/api${p}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined })
  const t = await r.text()
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${t.slice(0, 200)}`)
  return JSON.parse(t)
}
const q = async (sql, params = []) => (await db.query(sql, params)).rows
const waitFor = async (fn, ms = 40000, what = '') => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error(`timed out: ${what}`); await new Promise((r) => setTimeout(r, 250)) } }
const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`), scale: 'css' })

test.beforeAll(async () => {
  test.setTimeout(240_000)
  fs.mkdirSync(SHOTS, { recursive: true })
  API_PORT = freePort(8831)
  WEB_PORT = freePort(5231)
  const env = { ...process.env, PRO_PORT: String(API_PORT), PRO_BACKGROUND: '0', PRO_ONTOLOGY_WORKER: '0', PRO_SCENARIOS: 'off', PRO_TENANT_ID: TENANT, PRO_TENANT_HOSTS: '',
    PRO_FOLDERS_ROOT: path.join(ROOT, 'folders'), PRO_LOCAL_AGENT_TICK_MS: '500', PRO_LLM_BASE_URL: 'http://127.0.0.1:9/v1', PRO_PUBLIC_URL: `http://127.0.0.1:${WEB_PORT}` }
  bff = spawn(process.execPath, ['index.js'], { cwd: SERVER, env, stdio: ['ignore', 'pipe', 'pipe'] })
  for (const s of [bff.stdout, bff.stderr]) s.on('data', (d) => logs.push(`[bff] ${d}`))
  vite = spawn(process.execPath, [path.join(REPO, 'node_modules/vite/bin/vite.js'), '--port', String(WEB_PORT), '--strictPort', '--host', '127.0.0.1'], { cwd: REPO, env: { ...process.env, PRO_API_TARGET: `http://127.0.0.1:${API_PORT}` }, stdio: ['ignore', 'pipe', 'pipe'] })
  for (const s of [vite.stdout, vite.stderr]) s.on('data', (d) => logs.push(`[vite] ${d}`))
  await waitFor(async () => (await fetch(`http://127.0.0.1:${API_PORT}/api/config`).catch(() => null))?.ok, 60000, 'BFF')
  await waitFor(async () => (await fetch(`http://127.0.0.1:${WEB_PORT}/chat`).catch(() => null))?.ok, 60000, 'Vite')
  // the database the BFF uses (its config: process-gpt's .env)
  const { config } = await import(path.join(SERVER, 'config.js'))
  db = new pg.Pool({ ...config.db, max: 3 })
  for (const who of ['a', 'b']) {
    const r = await api(null, '/auth/email/verify', { method: 'POST', body: { email: `pro-rt-local-ui-${who}@uengine.org`, code: '000000' } })
    await api(r.session.access_token, '/profile', { method: 'POST', body: { name: who === 'a' ? '김견적' : '이검토', birth: '1990-01-01', onboarded: true } })
    users[who] = { id: r.user.id, token: r.session.access_token, email: `pro-rt-local-ui-${who}@uengine.org` }
  }
})
test.afterAll(async () => {
  for (const a of Object.values(apps)) await a.app?.close().catch(() => {})
  bff?.kill('SIGTERM'); vite?.kill('SIGTERM')
  if (db) {
    for (const t of ['todolist', 'bpm_proc_inst', 'proc_def', 'pro_local_jobs', 'pro_local_devices', 'pro_folders']) await q(`delete from ${t} where tenant_id=$1`, [TENANT]).catch(() => {})
    await db.end()
  }
  fs.rmSync(ROOT, { recursive: true, force: true })
})

async function launch(who) {
  const userData = path.join(ROOT, `app-${who}`)
  const env = { ...process.env, PGL_DESKTOP_USER_DATA: userData, PGL_DESKTOP_EXTERNAL: 'log', PGL_RUNNER_PATH: BIN, PGL_RUNNER_LOG: '1', PGL_RUNNER_DEVICE_NAME: who === 'a' ? '김견적의 맥' : '이검토의 맥',
    FAKE_CLI_HOME: path.join(ROOT, 'fake-home'), FAKE_CLI_LOG: path.join(ROOT, 'fake.log'),
    // the CLIs' own config folders (the runner marks its folders trusted there — never in the person's ~/.claude.json); a short settle
    CLAUDE_CONFIG_DIR: path.join(ROOT, 'claude-config'), CODEX_HOME: path.join(ROOT, 'codex-home'), PGL_RUNNER_SETTLE_MS: '800' }
  fs.mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true })
  delete env.ELECTRON_RUN_AS_NODE
  const app = await _electron.launch({ executablePath: ELECTRON, args: [DESKTOP], env, timeout: 60_000 })
  const page = await app.firstWindow()
  app.process().stdout?.on('data', (d) => logs.push(`[app ${who}] ${d}`))
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e?.message || e)))
  apps[who] = { app, page, errors }
  // first run: the server, then sign-in in the window (the email code of the demo login)
  await page.locator('[data-test=server-url]').fill(`127.0.0.1:${WEB_PORT}`)
  await page.click('[data-test=setup-connect]')
  await page.waitForURL(/\/login/)
  await page.fill('input[type=email]', users[who].email)
  await page.getByRole('button', { name: '계속', exact: true }).click()
  await page.locator('.code input').first().waitFor()
  await page.locator('.code input').first().fill('000000')
  await page.waitForURL(/\/chat/)
  return apps[who]
}
const runnerOf = (who) => apps[who].page.evaluate(() => window.pglDesktop.localRunner.status())

// one instance with steps that name local agents (the fake CLI's directives as the activities' instructions)
const DEF = `la_ui_${crypto.randomBytes(3).toString('hex')}`
const INST = `${DEF}.${crypto.randomUUID()}`
const ACTS = [
  { id: 'quote', name: '견적서 작성', instruction: 'SLEEP 4000\nWRITE_OUT 견적서.md :: 견적 초안 — 김견적의 컴퓨터에서' },
  { id: 'review', name: '견적 검토', instruction: 'SLEEP 5000\nREAD 산출물/01_견적서 작성/견적서.md\nWRITE_OUT 검토.md :: 검토 의견' },
  { id: 'send', name: '발송 준비', instruction: 'WRITE_OUT 발송.md :: 발송 준비' },
]
async function stepFor(act, who, local) {
  const [t] = await q(`insert into todolist (id, tenant_id, user_id, proc_inst_id, root_proc_inst_id, proc_def_id, activity_id, activity_name, status, agent_mode, agent_orch, agent_config, start_date)
                       values (gen_random_uuid(), $1, $2, $3, $3, $4, $5, $6, 'IN_PROGRESS', 'COMPLETE', 'pgpt-pro-local', $7, now()) returning id::text as id`,
  [TENANT, users[who].id, INST, DEF, act.id, act.name, { local }])
  return t.id
}
const jobOf = async (todo) => (await q('select * from pro_local_jobs where todo_id=$1', [todo]))[0]
const settled = (todo) => waitFor(async () => { const j = await jobOf(todo); return j && ['done', 'failed'].includes(j.state) ? j : null }, 60000, `job of ${todo}`)

test('L-01 로그인하면 데스크톱이 스스로 연결되고, 설정에 이 컴퓨터의 CLI 가 보인다', async () => {
  const { page } = await launch('a')
  const st = await waitFor(async () => { const s = await runnerOf('a'); return s?.connected ? s : null }, 20000, 'A linked')
  expect(st.user.id).toBe(users.a.id)
  expect(st.clis['claude-code'].installed).toBe(true)
  expect(st.clis['claude-code'].version).toBe('9.9.9')
  // the token is main's: the page's storage does not have it
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }))
  expect(stored).not.toContain('pld1_')
  await page.goto(`http://127.0.0.1:${WEB_PORT}/settings/accounts`)
  const box = page.locator('[data-test=local-agents-settings]')
  await expect(box).toContainText('이 컴퓨터 · 연결됨')
  await expect(box.locator('[data-cli=claude-code]')).toContainText('9.9.9')
  await expect(box.locator('[data-test=local-devices]')).toContainText('이 컴퓨터')
  await box.scrollIntoViewIfNeeded()
  await shot(page, 'l01-settings-linked')
  await launch('b')
  await waitFor(async () => (await runnerOf('b'))?.connected, 20000, 'B linked')
})

test('L-02 A 의 단계가 A 의 데스크톱에서 돈다 — 「로컬 에이전트 실행 중 · Claude Code」', async () => {
  await q(`insert into proc_def (id, name, definition, tenant_id) values ($1,$2,$3,$4)`, [DEF, '세미나 견적(로컬 에이전트)', { activities: ACTS }, TENANT])
  await q(`insert into bpm_proc_inst (proc_inst_id, proc_inst_name, proc_def_id, status, tenant_id, participants) values ($1,$2,$3,'RUNNING',$4,$5)`,
    [INST, '세미나 견적 — 달빛커피', DEF, TENANT, [users.a.id, users.b.id]])
  const { page } = apps.a
  await page.goto(`http://127.0.0.1:${WEB_PORT}/chat`)
  const t1 = await stepFor(ACTS[0], 'a', { agent: 'claude-code', offline: 'wait' })
  const pill = page.locator('[data-test=local-run-pill]')
  await expect(pill).toContainText('로컬 에이전트 실행 중 · Claude Code', { timeout: 30000 })
  await shot(page, 'l02-pill-running')
  const j = await settled(t1)
  expect(j.state, j.error || '').toBe('done')
  expect(String(j.device_id)).toBe((await runnerOf('a')).deviceId)
  // it ran in a terminal inside the Electron app (node-pty loaded in the app): the interactive CLI, its last screen kept
  expect(j.terminal).toBe(true)
  expect(j.screen).toContain('Claude Code (fake)')
  await expect(pill).toHaveCount(0, { timeout: 15000 })
})

test('L-03 B 의 다음 단계: B 의 데스크톱이 A 의 결과를 받아 시작하고, B 가 인스턴스 화면에서 방향을 바꾼다', async () => {
  const { page } = apps.b
  const t2 = await stepFor(ACTS[1], 'b', { agent: 'claude-code', offline: 'wait' })
  await waitFor(async () => (await jobOf(t2))?.state === 'running', 30000, 'B running')
  await page.goto(`http://127.0.0.1:${WEB_PORT}/routines/${encodeURIComponent(INST)}`)
  const card = page.locator('[data-test=local-runs] [data-test=local-run][data-state=running]')
  await expect(card).toContainText('로컬 에이전트 실행 중 · Claude Code', { timeout: 20000 })
  // his own run's terminal in his own app window: his (a cursor, keys he can type), the CLI's screen
  const term = card.locator('[data-test=local-run-terminal]')
  await expect(term).toHaveAttribute('data-owner', 'yes', { timeout: 15000 })
  await expect(term.locator('.xterm-rows')).toContainText('Claude Code (fake)', { timeout: 15000 })
  await card.locator('[data-test=local-run-steer]').fill('WRITE_OUT 조종.md :: 부가세 포함 금액으로')
  await card.locator('[data-test=local-run-steer-send]').click()
  await expect(card).toContainText('Claude Code에 입력했어요')
  await shot(page, 'l03-instance-steer')
  const j = await settled(t2)
  expect(j.state, j.error || '').toBe('done')
  expect(j.steers[0].applied).toBe('live')
  expect(j.result.summary).toContain('견적 초안 — 김견적의 컴퓨터에서')
  expect(j.result.files).toContain('산출물/02_견적 검토/조종.md')
  const done = page.locator('[data-test=local-runs] [data-test=local-run][data-state=done]').first()
  await expect(done).toContainText('반영 — 실행을 멈추지 않고', { timeout: 15000 })
  await shot(page, 'l03-instance-done')
})

test('L-04 B 가 로컬 실행을 끄면 다음 단계는 기다리고(인스턴스가 까닭을 보임), 다시 켜면 돈다', async () => {
  const { page } = apps.b
  await page.goto(`http://127.0.0.1:${WEB_PORT}/settings/accounts`)
  const sw = page.locator('[data-test=local-enabled]')
  await sw.uncheck()
  await waitFor(async () => (await runnerOf('b')).prefs.enabled === false, 5000, 'off')
  await shot(page, 'l04-settings-off')
  const t3 = await stepFor(ACTS[2], 'b', { agent: 'claude-code', offline: 'wait', waitMinutes: 60 })
  await waitFor(async () => (await jobOf(t3))?.why === 'waiting', 20000, 'waiting')
  await page.goto(`http://127.0.0.1:${WEB_PORT}/routines/${encodeURIComponent(INST)}`)
  const card = page.locator('[data-test=local-runs] [data-test=local-run][data-state=queued]')
  await expect(card).toContainText('담당자의 데스크톱이 꺼져 있어 기다리는 중', { timeout: 15000 })
  await shot(page, 'l04-instance-waiting')
  await page.goto(`http://127.0.0.1:${WEB_PORT}/settings/accounts`)
  await page.locator('[data-test=local-enabled]').check()
  const j = await settled(t3)
  expect(j.state, j.error || '').toBe('done')
  for (const who of ['a', 'b']) expect(apps[who].errors, apps[who].errors.join(' | ')).toEqual([])
})
