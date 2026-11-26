// 챔피언 폴더 — 내 PC 폴더 올리기 in the desktop app (desktop/, Electron 0.2.5) driven by Playwright's _electron — spec
// openspec/specs/champion-folders. One person signs in in the app (it pairs itself), picks a folder of this computer in the folder list
// (「내 PC 폴더 올리기」), sees the preview (what is left out and why, a file to check, the agent assets), uploads it — the app asks once
// more in a system dialog — and the new Lite folder has the files and its 「에이전트 자산」 tab, never the .env or the person's
// settings.local.json; the picked folder stays byte for byte as it was. The two system dialogs (the folder picker, the confirm) are
// answered by main's test hook (global.__pglTestFolders — read only by an app that is not packaged).
// It starts its own stack — a BFF (PRO_BACKGROUND=0, tenant champion-ui) on 8964 and Vite on 5364 in front of it (the next free port when
// taken) — and removes what it made.
//   cd e2e && npx playwright test --project=desktop tests/desktop/champion.spec.js
// Screenshots: openspec/specs/champion-folders/e2e/results/ (f-ch-0N-desktop-*.png).
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
const SHOTS = path.join(REPO, 'openspec/specs/champion-folders/e2e/results')
const require = createRequire(path.join(DESKTOP, 'package.json'))
let ELECTRON = ''
try { ELECTRON = require('electron') } catch { /* not installed */ }
const { fakeBin } = require('./test/helpers/fakeBin.js')
const pg = createRequire(path.join(SERVER, 'package.json'))('pg')
const TENANT = 'champion-ui'
// other people's stacks on this machine (never these)
const AVOID = new Set([8787, 5180, 8888, 8099, 8500, 5361, 5362, 8961, 8962, 8963, 5363, 5401])
const portFree = (p) => { try { execFileSync('lsof', ['-nP', `-iTCP:${p}`, '-sTCP:LISTEN'], { stdio: 'ignore' }); return false } catch { return true } }
const freePort = (from, n = 20) => Array.from({ length: n }, (_, i) => from + i).find((p) => !AVOID.has(p) && portFree(p))

test.describe.configure({ mode: 'serial' })
test.skip(!ELECTRON || !fs.existsSync(ELECTRON), 'desktop/ 에 Electron 이 없음 (cd desktop && npm install)')

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pgl-champion-ui-')))
const BIN = fakeBin(path.join(ROOT, 'bin'))
let API_PORT, WEB_PORT, bff, vite, db, app, page, me
const logs = []
const errors = []
const api = async (p, { method = 'GET', body } = {}) => {
  const r = await fetch(`http://127.0.0.1:${API_PORT}/api${p}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${me.token}` }, body: body ? JSON.stringify(body) : undefined })
  const t = await r.text()
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${t.slice(0, 200)}`)
  return JSON.parse(t)
}
const q = async (sql, params = []) => (await db.query(sql, params)).rows
const waitFor = async (fn, ms = 40000, what = '') => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error(`timed out: ${what}`); await new Promise((r) => setTimeout(r, 250)) } }
const shot = (name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`), scale: 'css' })

// ---------- the person's folder ----------
const PICKED = path.join(ROOT, 'people', '영업 제안 키트')
// key-shaped text made here (the repository is public: no key-shaped literal in this file)
const FAKE_TOKEN = `${'gh'}${'p_'}${'Zx9Q'.repeat(9)}`
const FAKE_ENV = crypto.randomBytes(18).toString('hex')
const put = (rel, text) => { const f = path.join(PICKED, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text) }
function makeChampion() {
  put('README.md', '# 영업 제안 키트\n견적 · 제안서를 만드는 폴더\n')
  put('docs/제안서 쓰는 법.md', '# 제안서 쓰는 법\n고객의 말로 시작한다.\n')
  put('.gitignore', 'dist/\n')
  put('dist/out.js', 'console.log(1)\n')
  put('.env', `API_KEY=${FAKE_ENV}\n`)
  put('.env.example', 'API_KEY=\n')
  put('.claude/settings.local.json', '{"permissions":{"allow":["Bash(rm:*)"]}}\n')
  put('.claude/settings.json', '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo done"}]}]}}\n')
  put('.claude/skills/견적-정리/SKILL.md', '---\nname: 견적-정리\ndescription: 견적서를 부가세 포함 금액으로 정리한다\n---\n금액은 늘 부가세 포함으로 적는다.\n')
  put('.claude/commands/opsx/apply.md', '---\ndescription: 변경을 적용한다\n---\n$ARGUMENTS\n')
  put('CLAUDE.md', '# 이 폴더에서는\n견적은 부가세 포함\n')
  put('AGENTS.md', '# Agents\n견적은 부가세 포함\n')
  put('node_modules/pkg/index.js', 'module.exports = 1\n')
  put('config/app.txt', `server: example.test\ntoken: ${FAKE_TOKEN}\n`)
  // what never goes up as such: a link (even one inside the folder) and git's control files
  put('.lfsconfig', '[lfs]\n\turl = https://example.test/lfs\n')
  fs.symlinkSync('README.md', path.join(PICKED, 'guide-link'))
}
function treeOf(dir) {
  const out = {}
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name)
      const r = rel ? `${rel}/${e.name}` : e.name
      const st = fs.lstatSync(abs)
      if (st.isSymbolicLink()) out[r] = `link ${fs.readlinkSync(abs)} ${st.mtimeMs}`
      else if (st.isDirectory()) { out[`${r}/`] = `dir ${st.mtimeMs}`; walk(abs, r) } else out[r] = `${st.size} ${st.mtimeMs} ${crypto.createHash('sha1').update(fs.readFileSync(abs)).digest('hex')}`
    }
  }
  walk(dir, '')
  return out
}
let before = null
let folder = null

test.beforeAll(async () => {
  test.setTimeout(240_000)
  fs.mkdirSync(SHOTS, { recursive: true })
  makeChampion()
  before = treeOf(PICKED)
  API_PORT = freePort(8964)
  WEB_PORT = freePort(5364)
  const env = { ...process.env, PRO_PORT: String(API_PORT), PRO_BACKGROUND: '0', PRO_ONTOLOGY_WORKER: '0', PRO_SCENARIOS: 'off', PRO_TENANT_ID: TENANT, PRO_TENANT_HOSTS: '',
    PRO_FOLDERS_ROOT: path.join(ROOT, 'folders'), PRO_LOCAL_AGENT_TICK_MS: '500', PRO_LLM_BASE_URL: 'http://127.0.0.1:9/v1', PRO_PUBLIC_URL: `http://127.0.0.1:${WEB_PORT}` }
  bff = spawn(process.execPath, ['index.js'], { cwd: SERVER, env, stdio: ['ignore', 'pipe', 'pipe'] })
  for (const s of [bff.stdout, bff.stderr]) s.on('data', (d) => logs.push(`[bff] ${d}`))
  vite = spawn(process.execPath, [path.join(REPO, 'node_modules/vite/bin/vite.js'), '--port', String(WEB_PORT), '--strictPort', '--host', '127.0.0.1'], { cwd: REPO, env: { ...process.env, PRO_API_TARGET: `http://127.0.0.1:${API_PORT}` }, stdio: ['ignore', 'pipe', 'pipe'] })
  for (const s of [vite.stdout, vite.stderr]) s.on('data', (d) => logs.push(`[vite] ${d}`))
  await waitFor(async () => (await fetch(`http://127.0.0.1:${API_PORT}/api/config`).catch(() => null))?.ok, 60000, 'BFF')
  await waitFor(async () => (await fetch(`http://127.0.0.1:${WEB_PORT}/chat`).catch(() => null))?.ok, 60000, 'Vite')
  const { config } = await import(path.join(SERVER, 'config.js'))
  db = new pg.Pool({ ...config.db, max: 3 })
  const email = 'pro-rt-champion-a@uengine.org'
  const r = await (await fetch(`http://127.0.0.1:${API_PORT}/api/auth/email/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, code: '000000' }) })).json()
  me = { id: r.user.id, token: r.session.access_token, email }
  await api('/profile', { method: 'POST', body: { name: '박챔피언', birth: '1990-01-01', onboarded: true } })

  // the app: its own profile, the server, then sign-in in the window (the demo login's email code)
  const env2 = { ...process.env, PGL_DESKTOP_USER_DATA: path.join(ROOT, 'app'), PGL_DESKTOP_EXTERNAL: 'log', PGL_RUNNER_PATH: BIN, PGL_RUNNER_LOG: '1', PGL_RUNNER_DEVICE_NAME: '박챔피언의 맥',
    FAKE_CLI_HOME: path.join(ROOT, 'fake-home'), FAKE_CLI_LOG: path.join(ROOT, 'fake.log'), CLAUDE_CONFIG_DIR: path.join(ROOT, 'claude-config'), CODEX_HOME: path.join(ROOT, 'codex-home') }
  fs.mkdirSync(env2.CLAUDE_CONFIG_DIR, { recursive: true })
  delete env2.ELECTRON_RUN_AS_NODE
  app = await _electron.launch({ executablePath: ELECTRON, args: [DESKTOP], env: env2, timeout: 60_000 })
  page = await app.firstWindow()
  app.process().stdout?.on('data', (d) => logs.push(`[app] ${d}`))
  page.on('pageerror', (e) => errors.push(String(e?.message || e)))
  await page.locator('[data-test=server-url]').fill(`127.0.0.1:${WEB_PORT}`)
  await page.click('[data-test=setup-connect]')
  await page.waitForURL(/\/login/)
  await page.fill('input[type=email]', email)
  await page.getByRole('button', { name: '계속', exact: true }).click()
  await page.locator('.code input').first().waitFor()
  await page.locator('.code input').first().fill('000000')
  await page.waitForURL(/\/chat/)
  await waitFor(async () => (await page.evaluate(() => window.pglDesktop.localRunner.status()))?.connected, 30000, 'linked')
})
test.afterAll(async () => {
  await app?.close().catch(() => {})
  bff?.kill('SIGTERM'); vite?.kill('SIGTERM')
  if (db) {
    for (const t of ['pro_folder_sources', 'pro_local_devices', 'pro_folders']) await q(`delete from ${t} where tenant_id=$1`, [TENANT]).catch(() => {})
    await db.end()
  }
  if (test.info().status !== 'passed') console.log(logs.join('').split('\n').filter((l) => /folders|sync|champion|error|Error/i.test(l)).slice(-80).join('\n'))
  fs.rmSync(ROOT, { recursive: true, force: true })
})

test('F-CH-01 미리 보기에 뺀 것(갈래와 까닭) · 확인이 필요한 파일 · 찾은 에이전트 자산이 보인다', async () => {
  // the system's folder picker and its confirm, answered by main for this test
  await app.evaluate((_e, dir) => { global.__pglTestFolders = { pick: dir, confirm: 'yes' } }, PICKED)
  await page.goto(`http://127.0.0.1:${WEB_PORT}/folders`)
  expect(await page.evaluate(() => typeof window.pglDesktop.folders?.pick)).toBe('function')
  await page.locator('[data-test=folder-pc-upload]').click()
  const sheet = page.locator('[data-test=source-sheet]')
  await expect(sheet).toBeVisible({ timeout: 20000 })
  await expect(sheet.locator('[data-test=source-name]')).toHaveValue('영업 제안 키트')
  await expect(sheet.locator('[data-test=source-excluded][data-group=secret]')).toContainText('비밀로 보여 뺐어요')
  await expect(sheet.locator('[data-test=source-excluded][data-group=personal]')).toContainText('내 PC 에만 두는 설정')
  await expect(sheet.locator('[data-test=source-excluded][data-group=rebuildable]')).toContainText('다시 만들 수 있는 것')
  await expect(sheet.locator('[data-test=source-excluded][data-group=gitignore]')).toBeVisible()
  await expect(sheet.locator('[data-test=source-excluded][data-group=structure]')).toBeVisible()
  const flag = sheet.locator('[data-test=source-flagged]')
  await expect(flag).toContainText('config/app.txt')
  await expect(flag).toContainText('GitHub 토큰')
  await expect(sheet.locator('[data-test=source-kit]')).toContainText('Claude Code')
  await expect(sheet.locator('[data-test=source-kit]')).toContainText('Codex')
  // the key's value and this computer's path are nowhere on the page
  const html = await page.content()
  expect(html).not.toContain(FAKE_TOKEN)
  expect(html).not.toContain(FAKE_ENV)
  expect(html).not.toContain(PICKED)
  await shot('f-ch-01-desktop-preview')
  expect(treeOf(PICKED)).toEqual(before)
})

test('F-CH-02 올리면 시스템 창이 한 번 더 묻고, 새 폴더에 파일과 「에이전트 자산」 탭이 있다', async () => {
  await page.locator('[data-test=source-upload]').click()
  await page.waitForURL(/\/folders\/[^/?#]+$/, { timeout: 60000 })
  // the confirm was the system's (main's), with what goes up and where
  const asked = await app.evaluate(() => global.__pglFolderDialogs || [])
  expect(asked).toHaveLength(1)
  expect(asked[0].message).toMatch(new RegExp(`^파일 \\d+개\\([0-9.]+ (KB|MB)\\)를 127\\.0\\.0\\.1:${WEB_PORT} 의 폴더 '영업 제안 키트'로 올립니다$`))
  // (and what stays here: the flagged config/app.txt, which the sheet sends as left out by name — F-CH-09)
  expect(asked[0].detail).toContain('확인이 필요한 파일 1개는 빼고 올려요.')
  const slug = decodeURIComponent(new URL(page.url()).pathname.split('/').pop())
  ;[folder] = await q('select id, slug, repo_path, settings from pro_folders where tenant_id=$1 and slug=$2', [TENANT, slug])
  expect(folder?.settings?.champion).toBeTruthy()
  await expect(page.locator('[data-test=folder-file][data-file="README.md"]')).toBeVisible({ timeout: 20000 })
  await expect(page.locator('[data-test=folder-file][data-file="CLAUDE.md"]')).toBeVisible()
  // this computer's state on the folder
  await expect(page.locator('[data-test=folder-pc-sync]')).toContainText('올려 둠', { timeout: 20000 })
  await shot('f-ch-02-desktop-folder')
  await page.locator('[data-test=folder-kit-tab]').click()
  const kit = page.locator('[data-test=kit-tab]')
  await expect(kit).toBeVisible()
  await expect(kit.locator('[data-test=kit-group][data-platform=claude]')).toContainText('견적-정리', { timeout: 20000 })
  await expect(kit.locator('[data-test=kit-group][data-platform=claude]')).toContainText('CLAUDE.md')
  await expect(kit.locator('[data-test=kit-group][data-platform=codex]')).toContainText('AGENTS.md')
  await shot('f-ch-02-desktop-kit')
  // what the page knows of this computer's folder: its name, never its path
  const list = await page.evaluate(() => window.pglDesktop.folders.list())
  expect(list).toEqual([expect.objectContaining({ folderId: folder.id, label: '영업 제안 키트', state: 'synced' })])
  expect(JSON.stringify(list)).not.toContain(PICKED)
  const [src] = await q('select label, branch, state, report from pro_folder_sources where folder_id=$1', [folder.id])
  expect(src.label).toBe('영업 제안 키트')
  expect(src.branch).toMatch(/^pgpt-agent\/sync-[0-9a-f]{8}\/main$/)
  expect(src.report.excluded.secret).toBeGreaterThanOrEqual(1)
  expect(JSON.stringify(src)).not.toContain(PICKED)
})

test('F-CH-03 .env 와 .claude/settings.local.json 은 서버에 없다 — 고른 폴더는 그대로', async () => {
  const main = execFileSync('git', ['ls-tree', '-r', '--name-only', '-z', 'main'], { cwd: folder.repo_path }).toString().split('\0').filter(Boolean)
  for (const x of ['README.md', 'CLAUDE.md', 'AGENTS.md', '.env.example', '.claude/settings.json', '.claude/skills/견적-정리/SKILL.md', 'docs/제안서 쓰는 법.md']) expect(main, x).toContain(x)
  for (const x of ['.env', '.claude/settings.local.json', 'config/app.txt', 'node_modules/pkg/index.js', 'dist/out.js', '.lfsconfig', 'guide-link']) expect(main, x).not.toContain(x)
  // only plain files: no link (120000) or submodule (160000) entry
  const modes = execFileSync('git', ['ls-tree', '-r', 'main'], { cwd: folder.repo_path }).toString().trim().split('\n').map((l) => l.split(' ')[0])
  expect([...new Set(modes)].every((m) => m === '100644' || m === '100755')).toBe(true)
  const files = (await api(`/folders/${encodeURIComponent(folder.slug)}/tree`)).map((f) => f.path)
  expect(files).toContain('README.md')
  expect(files).not.toContain('.env')
  expect(files).not.toContain('.claude/settings.local.json')
  // the snapshot only — the person's name on it, no computer's name in its message
  expect(execFileSync('git', ['log', '-1', '--format=%an|%s', 'main'], { cwd: folder.repo_path }).toString().trim()).toBe('박챔피언|동기화')
  expect(execFileSync('git', ['log', '--format=%B', 'main'], { cwd: folder.repo_path }).toString()).not.toContain(os.hostname())
  // the picked folder: the same files, bytes and times — no .git, no file made in it
  expect(treeOf(PICKED)).toEqual(before)
  expect(fs.existsSync(path.join(PICKED, '.git'))).toBe(false)
})

test('「지금 올리기」: 고친 파일이 서버 main 으로 — 바뀐 것만, 고른 폴더에는 쓰지 않는다', async () => {
  await page.goto(`http://127.0.0.1:${WEB_PORT}/folders/${encodeURIComponent(folder.slug)}`)
  put('README.md', '# 영업 제안 키트\n고친 줄 — 지금 올리기\n')
  const now = treeOf(PICKED)
  const head = execFileSync('git', ['rev-parse', 'main'], { cwd: folder.repo_path }).toString().trim()
  await page.locator('[data-test=folder-pc-sync-now]').click()
  await waitFor(() => execFileSync('git', ['rev-parse', 'main'], { cwd: folder.repo_path }).toString().trim() !== head, 30000, 'main moved')
  expect(execFileSync('git', ['show', 'main:README.md'], { cwd: folder.repo_path }).toString()).toBe('# 영업 제안 키트\n고친 줄 — 지금 올리기\n')
  expect(execFileSync('git', ['rev-parse', 'main^'], { cwd: folder.repo_path }).toString().trim()).toBe(head)
  await expect(page.locator('[data-test=folder-pc-sync]')).toContainText('올려 둠', { timeout: 20000 })
  expect(treeOf(PICKED)).toEqual(now)
})

test('시스템 창에서 「취소」하면 페이지의 「올리기」만으로는 아무것도 올라가지 않는다', async () => {
  const other = path.join(ROOT, 'people', '두 번째 폴더')
  fs.mkdirSync(other, { recursive: true })
  fs.writeFileSync(path.join(other, '메모.md'), '메모\n')
  await app.evaluate((_e, dir) => { global.__pglTestFolders = { pick: dir, confirm: 'no' }; global.__pglFolderDialogs = [] }, other)
  const sources = (await q('select count(*)::int as n from pro_folder_sources where tenant_id=$1', [TENANT]))[0].n
  await page.goto(`http://127.0.0.1:${WEB_PORT}/folders`)
  await page.locator('[data-test=folder-pc-upload]').click()
  const sheet = page.locator('[data-test=source-sheet]')
  await expect(sheet.locator('[data-test=source-name]')).toHaveValue('두 번째 폴더', { timeout: 20000 })
  await sheet.locator('[data-test=source-upload]').click()
  await expect(sheet.locator('[data-test=source-note]')).toContainText('올리지 않았어요', { timeout: 20000 })
  expect((await app.evaluate(() => global.__pglFolderDialogs)).map((d) => d.message)).toEqual([`파일 1개(1 KB)를 127.0.0.1:${WEB_PORT} 의 폴더 '두 번째 폴더'로 올립니다`])
  // no source, no folder left (the page took back the empty folder it had made), nothing of this computer's
  expect((await q('select count(*)::int as n from pro_folder_sources where tenant_id=$1', [TENANT]))[0].n).toBe(sources)
  expect(await q('select id from pro_folders where tenant_id=$1 and name=$2', [TENANT, '두 번째 폴더'])).toEqual([])
  expect((await page.evaluate(() => window.pglDesktop.folders.list())).map((f) => f.label)).toEqual(['영업 제안 키트'])
  expect(errors, errors.join(' | ')).toEqual([])
})
