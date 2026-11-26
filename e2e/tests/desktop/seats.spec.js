// 작업본은 한 곳에 P1 — 「이 PC 에서 작업」 in the desktop app (desktop/, Electron 0.2.6) driven by Playwright's _electron, spec
// openspec/specs/variation-seats. The user (2026-11-26): 「폴더내 작업실을 누르면 일렉트론에 연결된 모바일이나 일렉트론내 해당 워크트리를 클론하여
// 작업할 수 있고 로컬 폴더 작업 결과를 서버로 동기화 할 수 있다. 작업본이 여러군데 흩어져서는 안되니 잘 설계해」.
// 김작업 signs in in the app (it pairs itself), opens her variation's 「작업실」, and the sheet's default 「이 PC 에서 작업」 makes its working
// copy in the app's data folder (a clone + a git worktree — nothing in a folder of hers). She changes a file there with her own tools (here:
// the test writes it), the app shows 「저장 안 한 변경 1」 and sends it up by itself once the files are quiet; 박동료 (an editor, in a
// browser) sees 「김작업의 PC 에서 · 김작업의 맥북 · 방금 올림」 and the file in the variation. 「돌려놓기」 pushes what is there and takes the
// working copy off the PC (what git does not carry goes to the app's trash); the server workroom then opens the same content. Then the PC
// is off while she takes the seat from the web: when the app comes back, what it still had comes up as a variation of its own
// (「… — 김작업의 맥북에 남아 있던 변경」), never mixed in. In a browser the sheet has only the server workroom and says where the PC way is.
//   F-WL-10 앱에서 「작업실」 → 「이 PC 에서 작업」(기본) → 알약 「이 PC 에서」 · 작업본은 앱 데이터 아래에만 · 폴더 열기 · 터미널 열기
//   F-WL-11 파일을 고치면 「저장 안 한 변경 1」 → 저절로 올라감 → 웹에 「김작업의 PC 에서 · 방금 올림」 (1280 · 390, 밝은 · 어두운)
//   F-WL-12 「돌려놓기」 → 보관 중, 작업 트리 없음, .env 는 앱 휴지통 → 서버 작업실에서 같은 내용
//   F-WL-13 꺼진 PC 의 자리를 웹에서 가져오면, PC 가 돌아와 「남아 있던 변경」 변형으로 올린다 (그 전에: 작업본에 터미널이 열려 있으면
//           「여기로 가져오기」가 까닭을 보인다)
//   F-WL-14 웹(앱 아님)의 「작업실」은 서버 작업실과 데스크톱 앱 안내만
//   F-WL-15 남이 넣은 실행 설정(.mcp.json)이 든 변형: 시트가 먼저 파일과 바꾼 사람을 알리고, 「그래도 열기」로 이 PC 에 받는다
// It starts its own stack — a BFF (PRO_BACKGROUND=0, tenant seats-pc-ui) on 8972 and Vite on 5372 in front of it (the next free port when
// taken) — and removes what it made.
//   cd e2e && npx playwright test --project=desktop tests/desktop/seats.spec.js
// Screenshots: openspec/specs/variation-seats/e2e/results/ (f-wl-1N-*.png).
import { test, expect, _electron } from '@playwright/test'
import { createRequire } from 'node:module'
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(here, '../../..')
const DESKTOP = path.join(REPO, 'desktop')
const SERVER = path.join(REPO, 'server')
const SHOTS = path.join(REPO, 'openspec/specs/variation-seats/e2e/results')
const require = createRequire(path.join(DESKTOP, 'package.json'))
let ELECTRON = ''
try { ELECTRON = require('electron') } catch { /* not installed */ }
const pg = createRequire(path.join(SERVER, 'package.json'))('pg')
const TENANT = 'seats-pc-ui'
// other people's stacks on this machine (never these)
const AVOID = new Set([8787, 5180, 8888, 8099, 8500, 8978, 5401, 5402, ...Array.from({ length: 11 }, (_, i) => 5361 + i), ...Array.from({ length: 11 }, (_, i) => 8961 + i)])
const portFree = (p) => { try { execFileSync('lsof', ['-nP', `-iTCP:${p}`, '-sTCP:LISTEN'], { stdio: 'ignore' }); return false } catch { return true } }
const freePort = (from, n = 20) => Array.from({ length: n }, (_, i) => from + i).find((p) => !AVOID.has(p) && portFree(p))

test.describe.configure({ mode: 'serial' })
test.skip(!ELECTRON || !fs.existsSync(ELECTRON), 'desktop/ 에 Electron 이 없음 (cd desktop && npm install)')

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pgl-seats-ui-')))
const APPDATA = path.join(ROOT, 'app')
const PERSON = path.join(ROOT, 'people', '김작업의 문서')
let API_PORT, WEB_PORT, bff, vite, db, app, page, me, other, slug, vid, wt
const logs = []
const errors = []
const WEB = () => `http://127.0.0.1:${WEB_PORT}`
const call = async (who, p, { method = 'GET', body, raw } = {}) => {
  const r = await fetch(`http://127.0.0.1:${API_PORT}/api${p}`, { method, headers: { ...(raw ? { 'Content-Type': 'text/markdown' } : { 'Content-Type': 'application/json' }), Authorization: `Bearer ${who.token}` }, body: raw ?? (body ? JSON.stringify(body) : undefined) })
  const t = await r.text()
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${t.slice(0, 200)}`)
  return t ? JSON.parse(t) : null
}
const q = async (sql, params = []) => (await db.query(sql, params)).rows
const waitFor = async (fn, ms = 40000, what = '') => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error(`timed out: ${what}`); await new Promise((r) => setTimeout(r, 250)) } }
const calm = (p) => p.evaluate(() => Promise.race([
  Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming?.().iterations !== Infinity).map((a) => a.finished.catch(() => {}))),
  new Promise((ok) => setTimeout(ok, 2000)),
]))
const shot = async (p, name) => { await calm(p); await p.waitForTimeout(800); await p.screenshot({ path: path.join(SHOTS, `${name}.png`) }) }
const noSideways = async (p) => expect(await p.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth)).toBeLessThanOrEqual(1)
const git = (repo, ...a) => execFileSync('git', a, { cwd: repo }).toString()
const repoOf = async () => (await q('select repo_path from pro_folders where tenant_id=$1 and slug=$2', [TENANT, slug]))[0].repo_path
const branchOf = async (id) => (await q('select branch from pro_folder_variations where id=$1', [id]))[0].branch
const filesOn = async (id) => git(await repoOf(), 'ls-tree', '-r', '--name-only', '-z', await branchOf(id)).split('\0').filter(Boolean)
// the app's trash for working copies: beside them, <app data>/local-agents/folders/<server>/<person>/trash
function trashDir() {
  const base = path.join(APPDATA, 'local-agents', 'folders')
  for (const s of fs.readdirSync(base)) for (const p of fs.readdirSync(path.join(base, s))) if (p.startsWith('u-')) return path.join(base, s, p, 'trash')
  return null
}
// the working copies the app made: <app data>/local-agents/folders/<server>/<person>/<folder8>/wt/<variation8>-<title>
function workingCopies() {
  const out = []
  const base = path.join(APPDATA, 'local-agents', 'folders')
  const walk = (d, depth) => { let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { return } for (const e of ents) if (e.isDirectory()) { const p = path.join(d, e.name); if (path.basename(d) === 'wt') out.push(p); else if (depth < 5) walk(p, depth + 1) } }
  walk(base, 0)
  return out
}
// the app's window at a size and in a theme (the web app keeps the theme in localStorage)
async function look({ width = 1280, height = 820, theme = 'light' } = {}) {
  await app.evaluate(({ BrowserWindow }, s) => { const w = BrowserWindow.getAllWindows()[0]; w.setSize(s.width, s.height) }, { width, height })
  await page.evaluate((th) => { try { localStorage.setItem('pgpt-pro-theme', th); localStorage.setItem('pgl-lang', 'ko') } catch { /* opaque */ } }, theme)
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme, { timeout: 20000 })
}
async function launch() {
  const env = { ...process.env, PGL_DESKTOP_USER_DATA: APPDATA, PGL_DESKTOP_EXTERNAL: 'log', PGL_RUNNER_LOG: '1', PGL_RUNNER_DEVICE_NAME: '김작업의 맥북', PGL_DESKTOP_BROWSER: '0',
    PGL_SEAT_QUIET_MS: '6000', PGL_SEAT_STATUS_MS: '800', CLAUDE_CONFIG_DIR: path.join(ROOT, 'claude-config'), CODEX_HOME: path.join(ROOT, 'codex-home') }
  delete env.ELECTRON_RUN_AS_NODE
  app = await _electron.launch({ executablePath: ELECTRON, args: [DESKTOP], env, timeout: 60_000 })
  page = await app.firstWindow()
  app.process().stdout?.on('data', (d) => logs.push(`[app] ${d}`))
  app.process().stderr?.on('data', (d) => logs.push(`[app] ${d}`))
  page.on('pageerror', (e) => errors.push(String(e?.message || e)))
  page.on('dialog', (d) => d.accept().catch(() => {}))
}
const linked = () => waitFor(async () => (await page.evaluate(() => window.pglDesktop?.localRunner?.status()).catch(() => null))?.connected, 40000, 'linked')
// a browser of someone signed in (another computer: no desktop app)
async function browserAs(browser, who, { width = 1280, height = 760, theme = 'light', touch = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: touch ? 2 : 1, locale: 'ko-KR', ...(touch ? { hasTouch: true, isMobile: true } : {}) })
  await ctx.addInitScript(([s, th]) => { if (window.top === window) { localStorage.setItem('pgpt-pro-session', s); localStorage.setItem('pgpt-pro-theme', th); localStorage.setItem('pgl-lang', 'ko') } }, [JSON.stringify(who.session), theme])
  const p = await ctx.newPage()
  p.errors = []
  p.on('pageerror', (e) => p.errors.push(String(e?.message || e)))
  p.on('dialog', (d) => d.accept().catch(() => {}))
  return p
}
async function signIn(email, name) {
  const r = await (await fetch(`http://127.0.0.1:${API_PORT}/api/auth/email/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, code: '000000' }) })).json()
  const who = { id: r.user.id, token: r.session.access_token, email, name, session: r }
  await call(who, '/profile', { method: 'POST', body: { name, birth: '1990-01-01', onboarded: true } })
  return who
}

test.beforeAll(async () => {
  test.setTimeout(300_000)
  fs.mkdirSync(SHOTS, { recursive: true })
  fs.mkdirSync(PERSON, { recursive: true })
  fs.writeFileSync(path.join(PERSON, '내 메모.md'), '내 PC 의 내 폴더 — 앱은 여기에 쓰지 않는다\n')
  API_PORT = freePort(8972)
  WEB_PORT = freePort(5372)
  const env = { ...process.env, PRO_PORT: String(API_PORT), PRO_BACKGROUND: '0', PRO_ONTOLOGY_WORKER: '0', PRO_SCENARIOS: 'off', PRO_TENANT_ID: TENANT, PRO_TENANT_HOSTS: '',
    PRO_FOLDERS_ROOT: path.join(ROOT, 'folders'), PRO_LOCAL_AGENT_TICK_MS: '500', PRO_LLM_BASE_URL: 'http://127.0.0.1:9/v1', PRO_PUBLIC_URL: `http://127.0.0.1:${WEB_PORT}`, PRO_GIT_PUBLIC_URL: '' }
  bff = spawn(process.execPath, ['index.js'], { cwd: SERVER, env, stdio: ['ignore', 'pipe', 'pipe'] })
  for (const s of [bff.stdout, bff.stderr]) s.on('data', (d) => logs.push(`[bff] ${d}`))
  vite = spawn(process.execPath, [path.join(REPO, 'node_modules/vite/bin/vite.js'), '--port', String(WEB_PORT), '--strictPort', '--host', '127.0.0.1'], { cwd: REPO, env: { ...process.env, PRO_API_TARGET: `http://127.0.0.1:${API_PORT}` }, stdio: ['ignore', 'pipe', 'pipe'] })
  for (const s of [vite.stdout, vite.stderr]) s.on('data', (d) => logs.push(`[vite] ${d}`))
  await waitFor(async () => (await fetch(`http://127.0.0.1:${API_PORT}/api/config`).catch(() => null))?.ok, 60000, 'BFF')
  await waitFor(async () => (await fetch(`${WEB()}/chat`).catch(() => null))?.ok, 60000, 'Vite')
  const { config } = await import(path.join(SERVER, 'config.js'))
  db = new pg.Pool({ ...config.db, max: 3 })
  me = await signIn('pro-rt-seats-pc-a@uengine.org', '김작업')
  other = await signIn('pro-rt-seats-pc-b@uengine.org', '박동료')
  const f = await call(me, '/folders', { method: 'POST', body: { name: '고객 안내문', description: '작업본은 한 곳에 — PC 에서' } })
  slug = f.slug
  await call(me, `/folders/${encodeURIComponent(slug)}/files?path=${encodeURIComponent('안내문.md')}`, { method: 'POST', raw: '# 고객 세미나 안내\n\n일시: 11월 20일\n' })
  await call(me, `/folders/${encodeURIComponent(slug)}/members`, { method: 'POST', body: { type: 'user', id: other.id, role: 'editor' } })
  vid = (await call(me, `/folders/${encodeURIComponent(slug)}/variations`, { method: 'POST', body: { title: '마감일 추가' } })).id

  // the app: its own profile, the server, then sign-in in the window (the demo login's email code) — it pairs itself
  fs.mkdirSync(path.join(ROOT, 'claude-config'), { recursive: true })
  await launch()
  await page.locator('[data-test=server-url]').fill(`127.0.0.1:${WEB_PORT}`)
  await page.click('[data-test=setup-connect]')
  await page.waitForURL(/\/login/)
  await page.fill('input[type=email]', me.email)
  await page.getByRole('button', { name: '계속', exact: true }).click()
  await page.locator('.code input').first().waitFor()
  await page.locator('.code input').first().fill('000000')
  await page.waitForURL(/\/chat/)
  await linked()
})
test.afterAll(async () => {
  await app?.close().catch(() => {})
  bff?.kill('SIGTERM'); vite?.kill('SIGTERM')
  if (db) {
    for (const t of ['pro_variation_seat_log', 'pro_local_devices', 'pro_folders']) await q(`delete from ${t} where tenant_id=$1`, [TENANT]).catch(() => {})
    await db.end()
  }
  // (SEATS_UI_LOG=<file>: every line of the BFF, Vite and the app, for looking into a failure)
  if (process.env.SEATS_UI_LOG) fs.writeFileSync(process.env.SEATS_UI_LOG, logs.join(''))
  if (test.info().status !== 'passed') console.log(logs.join('').split('\n').filter((l) => /seat|folders|error|Error|refused/i.test(l)).slice(-100).join('\n'))
  fs.rmSync(ROOT, { recursive: true, force: true })
})

test('F-WL-10 앱에서 「작업실」 → 「이 PC 에서 작업」(기본) → 알약 「이 PC 에서」 — 작업본은 앱 데이터 아래에만', async () => {
  expect(await page.evaluate(() => typeof window.pglDesktop.seats?.open)).toBe('function')
  await page.goto(`${WEB()}/folders/${encodeURIComponent(slug)}/v/${vid}`)
  await page.locator('[data-test=seat-open]').click()
  const sheet = page.locator('[data-test=seat-sheet]')
  await expect(sheet).toBeVisible()
  const pc = sheet.locator('[data-test=seat-sheet-pc]')
  await expect(pc).toBeEnabled({ timeout: 20000 })
  await expect(pc).toBeFocused()
  await expect(sheet.locator('[data-test=seat-sheet-server]')).toBeVisible()
  await expect(sheet.locator('[data-test=seat-sheet-app]')).toHaveCount(0)
  await shot(page, 'f-wl-10-sheet-desktop-light')
  // (Enter takes the default: this PC)
  await page.keyboard.press('Enter')
  await page.waitForURL(new RegExp(`/workroom/variation/${vid}`), { timeout: 60000 })
  const bar = page.locator('[data-test=pc-bar]')
  await expect(bar).toBeVisible({ timeout: 20000 })
  await expect(page.locator('[data-test=seat-pill]')).toContainText('이 PC 에서')
  await expect(page.locator('[data-test=wr-pc]')).toContainText('이 변형의 작업본은 이 PC 에 있어요')
  // the server: this computer holds the seat
  const seat = await call(me, `/folders/${encodeURIComponent(slug)}/variations/${vid}/seat`)
  expect(seat).toMatchObject({ place: 'device', state: 'held', mine: true, device: { name: '김작업의 맥북', online: true } })
  expect(JSON.stringify(seat)).not.toContain(APPDATA)
  // one working copy, in the app's data folder only — the person's own folder untouched; the page never learns the path
  const wts = workingCopies()
  expect(wts).toHaveLength(1)
  wt = wts[0]
  expect(path.basename(wt)).toBe(`${vid.slice(0, 8)}-마감일-추가`)
  expect(fs.readFileSync(path.join(wt, '안내문.md'), 'utf8')).toContain('고객 세미나 안내')
  expect(fs.readdirSync(PERSON)).toEqual(['내 메모.md'])
  const list = await page.evaluate(() => window.pglDesktop.seats.list())
  expect(list).toEqual([expect.objectContaining({ variationId: vid, title: '마감일 추가', state: 'held', autoSave: true })])
  expect(JSON.stringify(list)).not.toContain(ROOT)
  // 「폴더 열기」 · 「터미널 열기」: main opens the working copy (logged here instead of Finder · Terminal)
  await bar.locator('[data-test=pc-reveal]').click()
  await bar.locator('[data-test=pc-terminal]').click()
  await waitFor(async () => (await app.evaluate(() => global.__pglTerminals || [])).length, 10000, 'terminal')
  expect(await app.evaluate(() => global.__pglRevealed || [])).toEqual([wt])
  expect(await app.evaluate(() => global.__pglTerminals || [])).toEqual([wt])
  // 「휴지통」: the app's trash for working copies, opened by main (the page never learns where it is)
  await bar.locator('[data-test=pc-trash]').click()
  await waitFor(async () => (await app.evaluate(() => global.__pglRevealed || [])).length === 2, 10000, 'trash opened')
  expect((await app.evaluate(() => global.__pglRevealed))[1]).toBe(trashDir())
  await shot(page, 'f-wl-10-workroom-this-pc-light')
  await look({ theme: 'dark' })
  await expect(page.locator('[data-test=pc-bar]')).toBeVisible({ timeout: 20000 })
  await shot(page, 'f-wl-10-workroom-this-pc-dark')
  await look({ width: 390, height: 844, theme: 'light' })
  await expect(page.locator('[data-test=pc-bar]')).toBeVisible({ timeout: 20000 })
  await noSideways(page)
  await shot(page, 'f-wl-10-workroom-this-pc-390-light')
  await look({ theme: 'light' })
})

test('F-WL-11 작업본에서 파일을 고치면 「저장 안 한 변경 1」 → 저절로 올라감 → 웹에 「김작업의 PC 에서 · 방금 올림」', async ({ browser }) => {
  await page.goto(`${WEB()}/folders/${encodeURIComponent(slug)}/v/${vid}`)
  const bar = page.locator('[data-test=pc-bar]')
  await expect(bar).toBeVisible({ timeout: 20000 })
  const before = (await q('select head_commit from pro_folder_variations where id=$1', [vid]))[0].head_commit
  // her own tool writes a file in the working copy
  fs.writeFileSync(path.join(wt, '마감일.md'), '# 신청 마감\n\n11월 15일까지 신청해 주세요.\n')
  await expect(bar.locator('[data-test=pc-counts]')).toContainText('저장 안 한 변경 1', { timeout: 15000 })
  await shot(page, 'f-wl-11-unsaved-1-light')
  // quiet for a while → a save point goes up by itself (the person's name on it)
  await waitFor(async () => (await q('select head_commit from pro_folder_variations where id=$1', [vid]))[0].head_commit !== before, 40000, 'auto upload')
  expect(await filesOn(vid)).toContain('마감일.md')
  expect(git(await repoOf(), 'log', '-1', '--format=%an|%s', await branchOf(vid)).trim()).toBe('김작업|저장 지점')
  await expect(bar.locator('[data-test=pc-counts]')).toContainText('방금 올림', { timeout: 20000 })
  await expect(bar.locator('[data-test=pc-counts]')).toContainText('모두 올렸어요')
  await expect(page.locator('.vv .meta [data-test=seat-pill]')).toContainText('이 PC 에서')
  // someone else's screen (a browser on another computer): where it is and when it last came up — and the file in the variation
  for (const [theme, width, height] of [['light', 1280, 760], ['dark', 1280, 760], ['light', 390, 844], ['dark', 390, 844]]) {
    const b = await browserAs(browser, other, { width, height, theme, touch: width < 500 })
    await b.goto(`${WEB()}/folders/${encodeURIComponent(slug)}/v/${vid}`)
    const pill = b.locator('.vv .meta [data-test=seat-pill]')
    await expect(pill).toContainText('김작업의 PC 에서', { timeout: 20000 })
    if (width > 500) await expect(pill).toContainText('김작업의 맥북')
    await expect(pill).toContainText('방금 올림')
    await expect(b.locator('[data-test=seat-bar]')).toContainText('김작업 님이 이 변형을 고치는 중이에요')
    await expect(b.locator('.vv')).toContainText('마감일.md')
    if (width < 500) await noSideways(b)
    await shot(b, `f-wl-11-web-other-${width}-${theme}`)
    expect(b.errors).toEqual([])
    await b.context().close()
  }
  // the folder list says it too
  const b = await browserAs(browser, other)
  await b.goto(`${WEB()}/folders/${encodeURIComponent(slug)}`)
  await expect(b.locator('.vl .vc', { hasText: '마감일 추가' }).locator('[data-test=seat-pill]')).toContainText('김작업의 PC 에서', { timeout: 20000 })
  await b.context().close()
})

test('F-WL-12 「돌려놓기」 → 보관 중 · 작업 트리 없음 · .env 는 앱 휴지통 → 서버 작업실에서 같은 내용', async ({ browser }) => {
  // a file git does not carry (a secret's name — left out of every commit) and one more change not yet up
  fs.writeFileSync(path.join(wt, '.env'), `TOKEN=${'x'.repeat(8)}-only-here\n`)
  fs.writeFileSync(path.join(wt, '안내문.md'), '# 고객 세미나 안내\n\n일시: 11월 20일\n신청 마감: 11월 15일\n')
  await page.goto(`${WEB()}/workroom/variation/${vid}`)
  const bar = page.locator('[data-test=pc-bar]')
  await expect(bar).toBeVisible({ timeout: 20000 })
  await bar.locator('[data-test=pc-release]').click()
  // (back on the variation: put away)
  await page.waitForURL(new RegExp(`/folders/[^/]+/v/${vid}`), { timeout: 60000 })
  await expect(page.locator('.vv .meta [data-test=seat-pill]')).toContainText('보관 중', { timeout: 20000 })
  expect(workingCopies()).toEqual([])
  expect(fs.existsSync(wt)).toBe(false)
  // what git did not carry: in the app's trash, not thrown away
  const trash = trashDir()
  const kept = fs.readdirSync(trash).map((d) => path.join(trash, d, '.env')).filter((f) => fs.existsSync(f))
  expect(kept).toHaveLength(1)
  expect(await filesOn(vid)).not.toContain('.env')
  expect(git(await repoOf(), 'show', `${await branchOf(vid)}:안내문.md`)).toContain('신청 마감: 11월 15일')
  const seat = await call(me, `/folders/${encodeURIComponent(slug)}/variations/${vid}/seat`)
  expect(seat.place).toBe(null)
  expect((await q('select status from pro_folder_variations where id=$1', [vid]))[0].status).toBe('ready')
  await shot(page, 'f-wl-12-given-back-light')
  // the server workroom (her browser on another computer): the same content
  const w = await browserAs(browser, me)
  await w.goto(`${WEB()}/folders/${encodeURIComponent(slug)}/v/${vid}`)
  await w.locator('[data-test=seat-open]').click()
  await w.locator('[data-test=seat-sheet-server]').click()
  await w.waitForURL(new RegExp(`/workroom/variation/${vid}`), { timeout: 30000 })
  await w.locator('.files .node', { hasText: '마감일.md' }).click()
  await expect(w.locator('.fbox')).toContainText('11월 15일까지 신청해 주세요', { timeout: 20000 })
  await shot(w, 'f-wl-12-server-workroom')
  expect((await call(me, `/folders/${encodeURIComponent(slug)}/variations/${vid}/seat`))).toMatchObject({ place: 'server', run: 'workroom', mine: true })
  expect(w.errors).toEqual([])
  await w.context().close()
})

test('F-WL-13 꺼진 PC 의 자리를 웹에서 가져오면, PC 가 돌아와 「남아 있던 변경」 변형으로 올린다', async ({ browser }) => {
  // back to this PC (the server workroom gives it up — committed as it is), the automatic upload off
  await page.goto(`${WEB()}/folders/${encodeURIComponent(slug)}/v/${vid}`)
  await page.locator('[data-test=seat-open]').click()
  await page.locator('[data-test=seat-sheet-pc]').click()
  await page.waitForURL(new RegExp(`/workroom/variation/${vid}`), { timeout: 60000 })
  const bar = page.locator('[data-test=pc-bar]')
  await expect(bar).toBeVisible({ timeout: 20000 })
  await bar.locator('[data-test=pc-auto]').uncheck()
  await waitFor(async () => (await q('select auto_save from pro_variation_seats where variation_id=$1', [vid]))[0]?.auto_save === false, 10000, 'auto off on the server')
  ;[wt] = workingCopies()
  fs.writeFileSync(path.join(wt, '오프라인 메모.md'), 'PC 가 꺼진 동안 남은 변경\n')
  await expect(bar.locator('[data-test=pc-counts]')).toContainText('저장 안 한 변경 1', { timeout: 15000 })
  // 「여기로 가져오기」 from her browser while a terminal is open in the working copy (3rd review #6): nothing moves, the page says why
  const w = await browserAs(browser, me)
  const term = spawn('sleep', ['90'], { cwd: wt, stdio: 'ignore' })
  try {
    await w.goto(`${WEB()}/folders/${encodeURIComponent(slug)}/v/${vid}`)
    await w.locator('[data-test=seat-take]').click()
    await expect(w.locator('[data-test=seat-pc-says]')).toContainText('터미널이나 프로그램이 열려 있어 가져오지 못했어요', { timeout: 30000 })
    await shot(w, 'f-wl-13-pc-in-use')
    expect(fs.existsSync(path.join(wt, '오프라인 메모.md'))).toBe(true)
  } finally { term.kill() }
  // the PC goes off
  await app.close()
  app = null
  const head = (await q('select head_commit from pro_folder_variations where id=$1', [vid]))[0].head_commit
  // her browser: 「김작업의 맥북 · PC 꺼짐」 → 「여기로 가져오기」 (from the last upload; what the PC still has comes back on its own)
  await w.goto(`${WEB()}/folders/${encodeURIComponent(slug)}/v/${vid}`)
  await expect(w.locator('.vv .meta [data-test=seat-pill]')).toContainText('PC 꺼짐', { timeout: 30000 })
  await shot(w, 'f-wl-13-pc-off')
  await w.locator('[data-test=seat-take]').click()
  await expect(w.locator('.vv .meta [data-test=seat-pill]')).toContainText('보관 중', { timeout: 20000 })
  expect((await q('select head_commit from pro_folder_variations where id=$1', [vid]))[0].head_commit).toBe(head)
  // the PC comes back: its list no longer has the seat → what it had goes up as a variation of its own, then its working copy goes
  await launch()
  await linked()
  const left = await waitFor(async () => (await q(`select id, title, kind, holder_id, source from pro_folder_variations where folder_id=(select id from pro_folders where tenant_id=$1 and slug=$2) and kind='imported'`, [TENANT, slug]))[0], 60000, 'leftover variation')
  expect(left.title).toBe('마감일 추가 — 김작업의 맥북에 남아 있던 변경')
  expect(String(left.holder_id)).toBe(me.id)
  expect(left.source.left_of).toBe(vid)
  expect(await filesOn(left.id)).toContain('오프라인 메모.md')
  expect(await filesOn(vid)).not.toContain('오프라인 메모.md')
  await waitFor(() => workingCopies().length === 0, 20000, 'working copy removed')
  await w.goto(`${WEB()}/folders/${encodeURIComponent(slug)}`)
  await expect(w.locator('.vl .vc', { hasText: '김작업의 맥북에 남아 있던 변경' })).toBeVisible({ timeout: 20000 })
  await shot(w, 'f-wl-13-leftover-variation')
  expect(w.errors).toEqual([])
  await w.context().close()
})

test('F-WL-14 웹(앱 아님)의 「작업실」은 서버 작업실과 데스크톱 앱 안내만', async ({ browser }) => {
  for (const [theme, width, height] of [['light', 1280, 760], ['dark', 1280, 760], ['light', 390, 844], ['dark', 390, 844]]) {
    const w = await browserAs(browser, me, { width, height, theme, touch: width < 500 })
    await w.goto(`${WEB()}/folders/${encodeURIComponent(slug)}`)
    await w.locator('[data-test=folder-workroom]').click()
    const sheet = w.locator('[data-test=seat-sheet]')
    await expect(sheet).toBeVisible()
    await expect(sheet.locator('[data-test=seat-sheet-pc]')).toHaveCount(0)
    await expect(sheet.locator('[data-test=seat-sheet-server]').first()).toBeVisible({ timeout: 20000 })
    await expect(sheet.locator('[data-test=seat-sheet-app]')).toContainText('데스크톱 앱에서')
    await expect(sheet.locator('[data-test=seat-sheet-new]')).toBeVisible()
    await expect(sheet.locator('[data-test=seat-sheet-main]')).toBeVisible()
    if (width < 500) await noSideways(w)
    await shot(w, `f-wl-14-web-sheet-${width}-${theme}`)
    expect(w.errors).toEqual([])
    await w.context().close()
  }
  expect(errors, errors.join(' | ')).toEqual([])
})

test('F-WL-15 남이 넣은 실행 설정이 든 변형: 시트가 파일과 바꾼 사람을 먼저 알리고, 「그래도 열기」로 이 PC 에 받는다', async () => {
  // 박동료 puts an MCP server setting into main; 김작업's new variation carries it
  await call(other, `/folders/${encodeURIComponent(slug)}/files?path=${encodeURIComponent('.mcp.json')}`, { method: 'POST', raw: '{"mcpServers":{"tool":{"command":"node","args":["tool.js"]}}}\n' })
  const v2 = (await call(me, `/folders/${encodeURIComponent(slug)}/variations`, { method: 'POST', body: { title: '자동화 설정' } })).id
  await page.goto(`${WEB()}/folders/${encodeURIComponent(slug)}/v/${v2}`)
  await page.locator('[data-test=seat-open]').click()
  const sheet = page.locator('[data-test=seat-sheet]')
  await expect(sheet.locator('[data-test=seat-sheet-pc]')).toBeEnabled({ timeout: 20000 })
  await sheet.locator('[data-test=seat-sheet-pc]').click()
  const warn = sheet.locator('[data-test=seat-trust]')
  await expect(warn).toBeVisible({ timeout: 20000 })
  await expect(warn).toContainText('.mcp.json')
  await expect(warn).toContainText('MCP 서버')
  // (the name is only what the commit says — anyone can write any name there)
  await expect(warn).toContainText('커밋에 적힌 이름 · 박동료')
  await expect(warn).toContainText('누가 바꿨는지 확인할 수 없어요')
  // nothing came to this PC yet
  expect(workingCopies()).toEqual([])
  await shot(page, 'f-wl-15-trust-light')
  await look({ width: 390, height: 844, theme: 'dark' })
  await page.locator('[data-test=seat-open]').click()
  await page.locator('[data-test=seat-sheet-pc]').click()
  await expect(page.locator('[data-test=seat-trust]')).toBeVisible({ timeout: 20000 })
  await noSideways(page)
  await shot(page, 'f-wl-15-trust-390-dark')
  // a check that could not be made is a warning too — never 「nothing there」 (review 2nd #3)
  await page.locator('[data-test=seat-trust-cancel]').click()
  await page.route('**/trust', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"down"}' }))
  await page.locator('[data-test=seat-sheet-pc]').click()
  await expect(page.locator('[data-test=seat-trust]')).toContainText('확인하지 못했어요', { timeout: 20000 })
  expect(workingCopies()).toEqual([])
  await page.unroute('**/trust')
  await page.locator('[data-test=seat-trust-open]').click()
  await page.waitForURL(new RegExp(`/workroom/variation/${v2}`), { timeout: 60000 })
  await expect(page.locator('[data-test=pc-bar]')).toBeVisible({ timeout: 20000 })
  const [copy] = workingCopies()
  expect(fs.existsSync(path.join(copy, '.mcp.json'))).toBe(true)
  await look({ theme: 'light' })
  await page.locator('[data-test=pc-release]').click()
  await page.waitForURL(new RegExp(`/folders/[^/]+/v/${v2}`), { timeout: 60000 })
  expect(errors, errors.join(' | ')).toEqual([])
})
