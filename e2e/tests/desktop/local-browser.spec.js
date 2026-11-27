// 브라우저 작업이 데스크톱 앱의 브라우저에서 돈다(데스크톱 0.2.3 — 스펙 browser-handoff 「브라우저 작업은 내 PC에서」 · local-agents) — 진짜
// 데스크톱 앱(desktop/, Electron)을 Playwright _electron 로 띄우고, 같은 사람이 휴대폰 폭의 웹에서 그 작업의 카드를 본다.
// 이 시험이 스스로 띄우는 것: BFF(PRO_BACKGROUND=0, 테넌트 localbrowser-ui) · Vite · 지어낸 가게 사이트(server/test/fixtures/drivers.mjs) ·
// 대본대로 답하는 모델과 판정 서버(모델 · 계정 · 인터넷 없음). 끝나면 만든 것을 지운다.
//   LB-01 앱에서 로그인하면 이 PC 의 브라우저가 서버에 알려지고(caps.browser), 이 PC 의 설정 「브라우저 작업은 이 PC에서」(내가 시킨 작업만 ·
//         단계 · 예약 작업까지 모두 · 쓰지 않음)를 바꾸면 서버가 그대로 따른다 — 다른 칸을 바꿔도 그 설정은 남는다
//   LB-02 휴대폰 웹의 설정은 읽기만, 웹(390)에서 시킨 브라우저 작업이 PC 의 브라우저에서 돈다 — 카드에 「내 PC · 테스트 맥」과 실시간 화면(웹 · 앱 모두),
//         서버의 Chromium 은 뜨지 않는다
//   LB-03 사람이 필요한 순간 휴대폰의 「이 PC에서 보기」 → PC 에 그 브라우저 창이 보이고(제목은 그 페이지의 출처부터, 전체 화면 없음), 그 창에서 한 일로
//         작업이 이어져 끝난다
//   cd e2e && npx playwright test --project=desktop tests/desktop/local-browser.spec.js
// 사진: openspec/specs/browser-handoff/shots/lb*.png
import { test, expect, _electron, chromium } from '@playwright/test'
import { createRequire } from 'node:module'
import { spawn, execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(here, '../../..')
const DESKTOP = path.join(REPO, 'desktop')
const SERVER = path.join(REPO, 'server')
const SHOTS = path.join(REPO, 'openspec/specs/browser-handoff/shots')
const require = createRequire(path.join(DESKTOP, 'package.json'))
let ELECTRON = ''
try { ELECTRON = require('electron') } catch { /* not installed */ }
const pg = createRequire(path.join(SERVER, 'package.json'))('pg')
const TENANT = 'localbrowser-ui'
const AVOID = new Set([5199, 5195, 8795, 8777, 8794, 8796, 8797, 27790, 8088, 8787, 8798, 5180, 8888, 8099, 9333, 9555])
const portFree = (p) => { try { execFileSync('lsof', ['-nP', `-iTCP:${p}`, '-sTCP:LISTEN'], { stdio: 'ignore' }); return false } catch { return true } }
const freePort = (from, n = 20) => Array.from({ length: n }, (_, i) => from + i).find((p) => !AVOID.has(p) && portFree(p))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test.describe.configure({ mode: 'serial' })
test.skip(!ELECTRON || !fs.existsSync(ELECTRON), 'desktop/ 에 Electron 이 없음 (cd desktop && npm install)')

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pgl-local-browser-ui-'))
let API_PORT, WEB_PORT, bff, vite, db, site, llm, judge, app, win, web, phone
const logs = []
const me = { email: 'pro-rt-local-browser@uengine.org' }
const api = async (p, { method = 'GET', body } = {}) => {
  const r = await fetch(`http://127.0.0.1:${API_PORT}/api${p}`, { method, headers: { 'Content-Type': 'application/json', ...(me.token ? { Authorization: `Bearer ${me.token}` } : {}) }, body: body ? JSON.stringify(body) : undefined })
  const t = await r.text()
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${t.slice(0, 200)}`)
  return JSON.parse(t)
}
const q = async (sql, params = []) => (await db.query(sql, params)).rows
const waitFor = async (fn, ms = 40000, what = '') => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error(`timed out: ${what}`); await sleep(250) } }
const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`), scale: 'css' })

// ---- the scripted model: per goal (the message) a list of moves — tool calls, or functions of the request (async: they may wait) ----
const scripts = []
const lastSnap = (body) => JSON.parse([...body.messages].reverse().find((m) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('{')).content.split('\n')[0])
function startModel() {
  return http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', async () => {
      let body = {}
      try { body = JSON.parse(raw) } catch { /* not JSON */ }
      let message = { role: 'assistant', content: '네.' }
      const sys = String(body.messages?.[0]?.content || '')
      if (body.response_format && /Break a web task/.test(sys)) message = { role: 'assistant', content: JSON.stringify({ title: '가상 상점에서 찾기', steps: ['상점 열기', '찾기', '정리'] }) }
      else if (body.response_format) message = { role: 'assistant', content: '{}' }
      else {
        const goal = /Goal: ([^\n]*)/.exec(sys)?.[1]
        const s = goal && scripts.find((x) => goal.includes(x.key))
        if (s) {
          const step = s.moves[Math.min(s.i++, s.moves.length - 1)]
          const [name, args] = typeof step === 'function' ? await step(body) : step
          message = { role: 'assistant', content: null, tool_calls: [{ id: 'call_' + crypto.randomUUID().slice(0, 8), type: 'function', function: { name, arguments: JSON.stringify(args) } }] }
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message }] }))
    })
  })
}
function startJudge() {
  return http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      let keys = []
      try { keys = (JSON.parse(raw).options || []).map((o) => o.key) } catch { /* not JSON */ }
      const probabilities = keys.includes('idle') ? { idle: 0.05, busy: 0.95 } : Object.fromEntries(keys.map((k) => [k, k === 'ok' ? 0.96 : 0.04 / Math.max(1, keys.length - 1)]))
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ probabilities, model: 'scripted' }))
    })
  })
}
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)))

test.beforeAll(async () => {
  test.setTimeout(240_000)
  fs.mkdirSync(SHOTS, { recursive: true })
  API_PORT = portFree(8873) ? 8873 : freePort(8874)
  WEB_PORT = portFree(5273) ? 5273 : freePort(5274)
  llm = startModel(); judge = startJudge()
  const llmPort = await listen(llm), judgePort = await listen(judge)
  site = await (await import(pathToFileURL(path.join(SERVER, 'test/fixtures/drivers.mjs')).href)).startDriverSite()
  const env = { ...process.env, PRO_PORT: String(API_PORT), PRO_BACKGROUND: '0', PRO_ONTOLOGY_WORKER: '0', PRO_SCENARIOS: 'off', PRO_TENANT_ID: TENANT, PRO_TENANT_HOSTS: '',
    PRO_FOLDERS_ROOT: path.join(ROOT, 'folders'), PRO_LOCAL_AGENT_TICK_MS: '500', PRO_LLM_BASE_URL: `http://127.0.0.1:${llmPort}`, PRO_LLM_API_KEY: 'test',
    PRO_JUDGE_URL: `http://127.0.0.1:${judgePort}/judge`, PRO_CONTEXT_ROUTER_URL: '', PRO_BROWSER_GATES: 'off', PRO_BROWSER_PROFILES: path.join(ROOT, 'profiles'),
    PRO_PUBLIC_URL: `http://127.0.0.1:${WEB_PORT}` }
  bff = spawn(process.execPath, ['index.js'], { cwd: SERVER, env, stdio: ['ignore', 'pipe', 'pipe'] })
  for (const s of [bff.stdout, bff.stderr]) s.on('data', (d) => logs.push(`[bff] ${d}`))
  vite = spawn(process.execPath, [path.join(REPO, 'node_modules/vite/bin/vite.js'), '--port', String(WEB_PORT), '--strictPort', '--host', '127.0.0.1'], { cwd: REPO, env: { ...process.env, PRO_API_TARGET: `http://127.0.0.1:${API_PORT}` }, stdio: ['ignore', 'pipe', 'pipe'] })
  for (const s of [vite.stdout, vite.stderr]) s.on('data', (d) => logs.push(`[vite] ${d}`))
  await waitFor(async () => (await fetch(`http://127.0.0.1:${API_PORT}/api/config`).catch(() => null))?.ok, 60000, 'BFF')
  await waitFor(async () => (await fetch(`http://127.0.0.1:${WEB_PORT}/chat`).catch(() => null))?.ok, 60000, 'Vite')
  const { config } = await import(pathToFileURL(path.join(SERVER, 'config.js')).href)
  db = new pg.Pool({ ...config.db, max: 3 })
  const r = await api('/auth/email/verify', { method: 'POST', body: { email: me.email, code: '000000' } })
  me.id = r.user.id
  me.token = r.session.access_token
  await api('/profile', { method: 'POST', body: { name: '윤태호', birth: '1990-01-01', onboarded: true } })
})
test.afterAll(async () => {
  await app?.close().catch(() => {})
  await web?.close().catch(() => {})
  bff?.kill('SIGTERM'); vite?.kill('SIGTERM')
  llm?.close(); judge?.close()
  await site?.close()
  if (db) {
    await q('delete from pro_local_devices where tenant_id=$1', [TENANT]).catch(() => {})
    await q(`delete from pro_threads where user_id=$1`, [me.id]).catch(() => {})
    await db.end()
  }
  if (test.info().status !== test.info().expectedStatus) console.log(logs.slice(-80).join(''))
  fs.rmSync(ROOT, { recursive: true, force: true })
})

async function signIn(page, base) {
  await page.fill('input[type=email]', me.email)
  await page.getByRole('button', { name: '계속', exact: true }).click()
  await page.locator('.code input').first().waitFor()
  await page.locator('.code input').first().fill('000000')
  await page.waitForURL(/\/chat/)
}

test('LB-01 앱에서 로그인하면 이 PC 의 브라우저가 알려지고, 설정에 「브라우저 작업은 내 PC에서」', async () => {
  const env = { ...process.env, PGL_DESKTOP_USER_DATA: path.join(ROOT, 'app'), PGL_DESKTOP_EXTERNAL: 'log', PGL_RUNNER_LOG: '1', PGL_RUNNER_DEVICE_NAME: '테스트 맥' }
  delete env.ELECTRON_RUN_AS_NODE
  app = await _electron.launch({ executablePath: ELECTRON, args: [DESKTOP], env, timeout: 60_000 })
  win = await app.firstWindow()
  app.process().stdout?.on('data', (d) => logs.push(`[app] ${d}`))
  await win.locator('[data-test=server-url]').fill(`127.0.0.1:${WEB_PORT}`)
  await win.click('[data-test=setup-connect]')
  await win.waitForURL(/\/login/)
  await signIn(win)
  const st = await waitFor(async () => { const s = await win.evaluate(() => window.pglDesktop.localRunner.status()); return s?.connected ? s : null }, 30000, 'linked')
  expect(st.user.id).toBe(me.id)
  const devices = await api('/local-agents/devices')
  const mine = devices.find((d) => d.id === st.deviceId)
  expect(mine.online).toBe(true)
  expect(mine.caps.browser).toBe(true)
  expect(mine.appVersion).toBe(JSON.parse(fs.readFileSync(path.join(DESKTOP, 'package.json'), 'utf8')).version) // (the app's own version)
  // this PC's own setting (kept by the app with its runner settings, sent with its link): the person's own tasks by default
  expect(st.prefs.browser).toBe('own')
  expect(await api('/browser/where')).toMatchObject({ own: { where: 'local', device: { name: '테스트 맥' } }, unattended: { where: 'server', why: 'not-own' },
    devices: [{ name: '테스트 맥', browser: true, pref: 'own', enabled: true }] })
  await win.goto(`http://127.0.0.1:${WEB_PORT}/settings/accounts`)
  const pref = win.locator('[data-test=local-browser-pref]')
  await expect(pref).toHaveValue('own')
  const box = win.locator('[data-test=browser-local]')
  await expect(box.locator('[data-test=browser-local-own]')).toContainText('「테스트 맥」의 브라우저에서 해요')
  await expect(box.locator('[data-test=browser-local-unattended]')).toContainText('사람이 없는 작업은')
  await pref.scrollIntoViewIfNeeded()
  await shot(win, 'lb01-settings-browser-local')
  // 「단계 · 예약 작업까지 모두」 on this PC → the server routes tasks nobody watches here too; 「쓰지 않음」 → none
  await pref.selectOption('all')
  await waitFor(async () => (await api('/browser/where')).unattended.where === 'local', 15000, 'all')
  expect((await win.evaluate(() => window.pglDesktop.localRunner.status())).prefs.browser).toBe('all')
  await pref.selectOption('off')
  const off = await waitFor(async () => { const w = await api('/browser/where'); return w.own.why === 'off' ? w : null }, 15000, 'off')
  expect(off.unattended.where).toBe('server')
  await win.reload()
  await expect(win.locator('[data-test=browser-local-own]')).toContainText('「브라우저 작업은 이 PC에서」를 껐어요', { timeout: 20000 })
  await expect(win.locator('[data-test=local-browser-pref]')).toHaveValue('off', { timeout: 20000 })
  // the other switches leave it as it is (the app keeps it when only they change)
  await win.locator('[data-test=local-ask]').check()
  await win.locator('[data-test=local-ask]').uncheck()
  expect((await win.evaluate(() => window.pglDesktop.localRunner.status())).prefs.browser).toBe('off')
  await win.locator('[data-test=local-browser-pref]').selectOption('own')
  await waitFor(async () => (await api('/browser/where')).own.where === 'local', 15000, 'own again')
})

test('LB-02 웹(390)에서 시킨 브라우저 작업이 PC 의 브라우저에서 돈다 — 카드에 「내 PC · 테스트 맥」과 실시간 화면', async () => {
  web = await chromium.launch()
  phone = await (await web.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage()
  await phone.goto(`http://127.0.0.1:${WEB_PORT}/login`)
  await signIn(phone)
  // on the phone the setting is read only: where it runs, and each PC's own choice (changed on that PC)
  await phone.goto(`http://127.0.0.1:${WEB_PORT}/settings/accounts`)
  await expect(phone.locator('[data-test=browser-local-own]')).toContainText('「테스트 맥」의 브라우저에서 해요', { timeout: 20000 })
  await expect(phone.locator('[data-browser-device]')).toContainText('내가 시킨 작업만 — 바꾸기는 그 PC 의 앱에서')
  await expect(phone.locator('[data-test=local-browser-pref]')).toHaveCount(0)
  await phone.goto(`http://127.0.0.1:${WEB_PORT}/chat`)
  await win.goto(`http://127.0.0.1:${WEB_PORT}/chat`)
  const text = `가상 상점(${site.url}/shop)에 로그인해서 가상 사과를 찾아 줘`
  scripts.push({ key: '가상 사과를 찾아', i: 0, moves: [
    async (b) => { await sleep(1500); return ['type', { i: lastSnap(b).els.find((x) => x.name === 'q').i, text: '가상 사과', enter: true }] },
    async (b) => { await sleep(4000); return ['note', { text: lastSnap(b).text.split('\n').find((l) => l.startsWith('찾은 것')) || '없음' }] },
    async () => { await sleep(1500); return ['finish', { summary: '가상 상점에서 「가상 사과」를 찾았어요.' }] },
  ] })
  await phone.locator('textarea').first().fill(text)
  await phone.keyboard.press('Enter')
  // the card, on the phone: where it runs, and the live view
  const card = phone.locator('.task').last()
  await expect(card.getByTestId('task-where')).toHaveText('내 PC · 테스트 맥', { timeout: 30000 })
  await expect(card.locator('.screen img')).toHaveAttribute('src', /^data:image\/jpeg;base64,/, { timeout: 20000 })
  await phone.waitForTimeout(1500)
  await card.scrollIntoViewIfNeeded()
  await shot(phone, 'lb02-phone-card-on-pc')
  // the same card in the app window
  await expect(win.locator('.task').last().getByTestId('task-where')).toHaveText('내 PC · 테스트 맥', { timeout: 15000 })
  await expect(win.locator('.task').last().locator('.screen img')).toHaveAttribute('src', /^data:image\/jpeg;base64,/)
  await shot(win, 'lb02-app-card-on-pc')
  // done: on the PC, this server never launched a Chromium of its own for it
  const [task] = await waitFor(async () => {
    const rows = await q(`select m.content from pro_messages m join pro_threads t on t.id=m.thread_id where t.user_id=$1 and m.kind='task' order by m.created_at desc limit 1`, [me.id])
    return rows[0]?.content?.state === 'done' ? rows : null
  }, 60000, 'task done')
  expect(task.content.where).toMatchObject({ kind: 'local', device: '테스트 맥' })
  expect(fs.existsSync(path.join(ROOT, 'profiles', me.id))).toBe(false)
  await expect(phone.locator('.row').filter({ hasText: '「가상 사과」를 찾았어요' }).first()).toBeVisible({ timeout: 15000 })
  await shot(phone, 'lb02-phone-done')
})

test('LB-03 사람이 필요한 순간 휴대폰의 「이 PC에서 보기」 → PC 에 그 브라우저 창이 보이고, 그 창에서 한 뒤 이어서 끝난다', async () => {
  const text = `가상 상점(${site.url}/shop)에 로그인해서 세기 단추를 눌러 줘`
  scripts.push({ key: '세기 단추를', i: 0, moves: [
    ['need_user', { reason: '이 단계는 사람이 직접 확인해야 해요', need: 'other' }],
    (b) => ['note', { text: lastSnap(b).text.includes('눌림 1') ? '사람이 눌렀음' : '안 눌림' }],
    ['finish', { summary: '세기 단추가 눌린 것을 확인했어요.' }],
  ] })
  await phone.locator('textarea').first().fill(text)
  await phone.keyboard.press('Enter')
  const ask = phone.getByTestId('task-ask').last()
  await expect(ask.getByTestId('task-pc')).toHaveText('이 PC에서 보기', { timeout: 30000 })
  await ask.scrollIntoViewIfNeeded()
  await shot(phone, 'lb03-phone-needs-show-pc')
  await ask.getByTestId('task-pc').click()
  // on the PC: the browser's window is there now, showing the page
  const shown = await waitFor(async () => { const l = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.pglBrowser && w.isVisible()).map((w) => ({ url: w.webContents.getURL(), title: w.getTitle(), fs: w.isFullScreenable() }))); return l.length ? l : null }, 15000, 'shown')
  expect(shown[0].url).toContain('/shop')
  // the window says whose page it is (its origin first — a page cannot pass for this app) and cannot go full screen
  expect(shown[0].title.startsWith(`${new URL(site.url).origin} — `)).toBe(true)
  expect(shown[0].fs).toBe(false)
  const pcWin = await waitFor(async () => app.windows().find((p) => p.url().includes('/shop')), 15000, 'the PC window')
  // the person does it in that window, by hand (here: Playwright's own click in it)
  await pcWin.click('#count')
  await expect(pcWin.locator('#count')).toHaveText('눌림 1')
  await pcWin.screenshot({ path: path.join(SHOTS, 'lb03-pc-window.png') })
  // and gives it back from the card ("제어 돌려주기" on the full view sends this)
  await api('/browser/resume', { method: 'POST', body: { text: 'The user took over and finished the manual part. Re-check the page and continue.' } })
  const done = await waitFor(async () => {
    const rows = await q(`select m.content from pro_messages m join pro_threads t on t.id=m.thread_id where t.user_id=$1 and m.kind='task' and m.content->>'goal' like $2 order by m.created_at desc limit 1`, [me.id, '%세기 단추%'])
    return rows[0]?.content?.state === 'done' ? rows[0] : null
  }, 60000, 'task done')
  expect(done.content.where.kind).toBe('local')
  await expect(phone.locator('.row').filter({ hasText: '세기 단추가 눌린 것을 확인했어요' }).first()).toBeVisible({ timeout: 15000 })
  await shot(phone, 'lb03-phone-done')
})
