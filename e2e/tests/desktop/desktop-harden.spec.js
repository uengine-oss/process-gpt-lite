// 데스크톱 앱 0.2.6 — 로그인은 키체인으로 봉인해 두고, 에이전트 브라우저는 Lite 앱과 그 로그인 주소를 열지 않는다 (스펙 desktop-app 「로그인 보관」 ·
// browser-handoff 「에이전트 브라우저가 열지 않는 곳」). 진짜 데스크톱 앱(desktop/, Electron)을 Playwright _electron 로 띄운다.
// 이 시험이 스스로 띄우는 것: BFF(PRO_BACKGROUND=0, 테넌트 deskharden-ui, 8991 — 쓰고 있으면 다음 빈 포트) · Vite(5391 — 마찬가지) · 지어낸 사이트 ·
// 대본대로 답하는 모델과 판정 서버(모델 · 계정 · 인터넷 없음). 앱의 사용자 데이터는 임시 폴더(PGL_DESKTOP_USER_DATA). 끝나면 만든 것을 지운다.
//   DH-01 앱에서 로그인하면 그 로그인은 페이지의 저장소에 없고 앱이 봉인해 둔다 — 새로 고쳐도 · 앱을 다시 켜도 로그인한 채, 앱의 사용자 데이터
//         폴더 어느 파일에도 토큰이 그대로 없다
//   DH-02 에이전트 브라우저는 이 앱의 Lite 주소를 열지 않는다 — 에이전트의 「열기」(이 PC 를 가리키는 다른 이름 · IPv4 를 품은 IPv6 로도) · 그리로
//         보내는 사이트 · 페이지의 링크 · 요청(fetch · 그림 · 새 창 · sendBeacon · 폼 POST · 웹소켓 · 서비스 워커의 fetch), 사람이 「이 PC에서 보기」로
//         넘겨받은 창에서도, 그때는 「이 주소는 에이전트 브라우저에서 열지 않아요」. Lite 서버의 다른 주소일 수 있는 곳(이 PC 의 주소 — BFF 포트)으로 가는
//         그 브라우저의 요청에는 표시가 붙고 Lite 서버는 세션이 필요한 API 를 거절한다(403 agent_browser). 다른 사이트의 CORS 요청은 그대로 된다
//   DH-05 새 창으로 여는 웹 앱 링크(채팅의 프로젝트 · 폴더 링크)는 앱 창에서, 웹 앱의 라우터로 연다 — 다시 불러오지 않고 로그인한 채, 페이지의
//         저장소에 로그인이 생기지 않는다. 앱 화면이 아닌 서버 주소(/api/ · 파일)는 지금처럼 새 창, 패널 앱의 링크는 시스템 브라우저
//   DH-06 에이전트 브라우저 세션의 웹소켓도 Lite 서버의 다른 주소(BFF 포트)로 가면 표시가 붙어 서버가 403 으로 닫는다 — 표시 없는 같은 연결은 열린다
//   DH-03 로그아웃하면 봉인해 둔 로그인도 지운다
//   DH-04 앞선 판처럼 페이지의 저장소에 있던 로그인은 처음 실행에 옮기고 지운다(한 번 새로 받아 저장소에 있던 짝은 다 쓴 것으로) — 키체인을 쓸 수
//         없는 컴퓨터(시험: PGL_DESKTOP_NO_SEAL=1)에서는 지금처럼 페이지의 저장소
//   cd e2e && npx playwright test --project=desktop tests/desktop/desktop-harden.spec.js
// 사진: openspec/specs/desktop-app/e2e/results/dh*.png
import { test, expect, _electron } from '@playwright/test'
import { createRequire } from 'node:module'
import { spawn, execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(here, '../../..')
const DESKTOP = path.join(REPO, 'desktop')
const SERVER = path.join(REPO, 'server')
const SHOTS = path.join(REPO, 'openspec/specs/desktop-app/e2e/results')
const require = createRequire(path.join(DESKTOP, 'package.json'))
let ELECTRON = ''
try { ELECTRON = require('electron') } catch { /* not installed */ }
const pg = createRequire(path.join(SERVER, 'package.json'))('pg')
const TENANT = 'deskharden-ui'
const AVOID = new Set([5199, 5195, 8795, 8777, 8794, 8796, 8797, 27790, 8088, 8787, 8798, 5180, 8888, 8099, 9333, 9555])
const portFree = (p) => { try { execFileSync('lsof', ['-nP', `-iTCP:${p}`, '-sTCP:LISTEN'], { stdio: 'ignore' }); return false } catch { return true } }
const freePort = (from, n = 20) => Array.from({ length: n }, (_, i) => from + i).find((p) => !AVOID.has(p) && portFree(p))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test.describe.configure({ mode: 'serial' })
test.skip(!ELECTRON || !fs.existsSync(ELECTRON), 'desktop/ 에 Electron 이 없음 (cd desktop && npm install)')

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pgl-deskharden-'))
let API_PORT, WEB_PORT, LITE, bff, vite, db, site, SITE, other, OTHER, llm, judge
// (names this test maps to this PC for the app — Chromium's host resolver rules: as a name in the hosts file would)
const ALIAS = 'lite-alias.test'
const logs = []
const me = { email: 'pro-rt-deskharden@uengine.org' }
const api = async (p, { method = 'GET', body, token = me.token } = {}) => {
  const r = await fetch(`http://127.0.0.1:${API_PORT}/api${p}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined })
  const t = await r.text()
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${t.slice(0, 200)}`)
  return JSON.parse(t)
}
const q = async (sql, params = []) => (await db.query(sql, params)).rows
const waitFor = async (fn, ms = 40000, what = '') => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error(`timed out: ${what}`); await sleep(250) } }
const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`), scale: 'css' })

// ---- every file of a folder that holds one of the values, as it is (UTF-8 · Latin-1) or as UTF-16 ----
function filesWith(dir, values) {
  const wanted = values.filter((v) => v && v.length >= 8).flatMap((v) => [Buffer.from(v), Buffer.from(v, 'utf16le')])
  const hits = []
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile()) {
        let b
        try { b = fs.readFileSync(p) } catch { continue }
        if (wanted.some((w) => b.includes(w))) hits.push(path.relative(dir, p))
      }
    }
  }
  walk(dir)
  return [...new Set(hits)]
}
const fileCount = (dir) => { let n = 0; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) walk(path.join(d, e.name)); else if (e.isFile()) n++ } }; walk(dir); return n }

// ---- the scripted model: per goal (the message) a list of moves — tool calls, or functions of the request ----
const scripts = []
const lastSnap = (body) => JSON.parse([...body.messages].reverse().find((m) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('{')).content.split('\n')[0])
const lastTool = (body) => String([...body.messages].reverse().find((m) => m.role === 'tool')?.content || '')
function startModel() {
  return http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', async () => {
      let body = {}
      try { body = JSON.parse(raw) } catch { /* not JSON */ }
      let message = { role: 'assistant', content: '네.' }
      const sys = String(body.messages?.[0]?.content || '')
      if (body.response_format && /Break a web task/.test(sys)) message = { role: 'assistant', content: JSON.stringify({ title: '가상 사이트에서 확인', steps: ['사이트 열기', '확인'] }) }
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
// ---- a made-up site whose pages go for the Lite app: a link, a redirect, a fetch, a picture, a new window ----
const html = (title, body) => `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${title}</title></head><body style="margin:0;font:16px sans-serif;padding:16px">${body}</body></html>`
function startSite() {
  return http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    if (u.pathname === '/go-lite') { res.writeHead(302, { Location: `${LITE}/login` }); return res.end() }
    if (u.pathname === '/start') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      return res.end(html('가상 사이트', `<h1>가상 사이트</h1>
<p><a id="to-lite" href="${LITE}/chat">Lite 로 가기</a></p>
<p><button id="probe" onclick="(async () => { const out = []; for (const go of [() => fetch('${LITE}/api/config', { mode: 'no-cors' }), () => new Promise((ok, no) => { const i = new Image(); i.onload = ok; i.onerror = no; i.src = '${LITE}/favicon.svg?' + Date.now() })]) { try { await go(); out.push('reached') } catch { out.push('blocked') } } out.push(window.open('${LITE}/login') ? 'opened' : 'no-window'); document.getElementById('out').textContent = out.join(' ') })()">Lite 에 요청</button></p>
<p id="out">아직</p>
<form id="post" method="post" action="${LITE}/api/auth/email/start"><input name="email" value="${me.email}"></form>
<p><button id="probe2" onclick="(async () => {
  const out = []
  out.push(navigator.sendBeacon('${LITE}/api/config?beacon=1') ? 'beacon-queued' : 'beacon-refused')
  out.push(await new Promise((ok) => { const w = new WebSocket('ws://127.0.0.1:${WEB_PORT}/', 'vite-hmr'); w.onopen = () => { w.close(); ok('ws-open') }; w.onerror = () => ok('ws-blocked'); setTimeout(() => ok('ws-none'), 5000) }))
  try {
    const reg = await navigator.serviceWorker.register('/sw.js')
    const w = reg.installing || reg.waiting || reg.active
    await new Promise((ok) => { if (w.state === 'activated') ok(); else w.addEventListener('statechange', () => { if (w.state === 'activated') ok() }) })
    out.push(await new Promise((ok) => { navigator.serviceWorker.addEventListener('message', (e) => ok('sw-' + e.data), { once: true }); reg.active.postMessage('${LITE}/api/config?sw=1') }))
  } catch (e) { out.push('sw-none') }
  out.push(await fetch('${OTHER}/cors').then((r) => r.text(), () => 'cors-failed'))
  document.getElementById('out2').textContent = out.join(' ')
  document.getElementById('post').submit()
})()">더 요청</button></p>
<p id="out2">아직</p>`))
    }
    if (u.pathname === '/sw.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' })
      return res.end(`self.addEventListener('install', () => self.skipWaiting()); self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('message', (e) => { fetch(e.data, { mode: 'no-cors' }).then(() => 'reached', () => 'blocked').then((t) => e.source.postMessage(t)) })`)
    }
    res.writeHead(404); res.end()
  })
}
// ---- another made-up site: a cross-origin request to it works as before (CORS: any origin, no request header allowed beyond the simple
// ones — the agent browser's mark must not make it fail); it notes the mark it was sent ----
const marks = []
function startOther() {
  return http.createServer((req, res) => {
    marks.push(req.headers['x-pgl-agent-browser'] || '')
    if (req.method === 'OPTIONS') { res.writeHead(404); return res.end() }
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' })
    res.end('cors-ok')
  })
}
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)))

// ---- the app ----
async function launch(dir, extra = {}) {
  const env = { ...process.env, PGL_DESKTOP_USER_DATA: dir, PGL_DESKTOP_EXTERNAL: 'log', PGL_RUNNER_LOG: '1', PGL_RUNNER_DEVICE_NAME: '시험 맥', ...extra }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await _electron.launch({ executablePath: ELECTRON, args: [`--host-resolver-rules=MAP ${ALIAS} 127.0.0.1`, DESKTOP], env, timeout: 60_000 })
  const win = await app.firstWindow()
  app.process().stdout?.on('data', (d) => logs.push(`[app] ${d}`))
  return { app, win }
}
async function connectAndSignIn(win) {
  await win.locator('[data-test=server-url]').fill(`127.0.0.1:${WEB_PORT}`)
  await win.click('[data-test=setup-connect]')
  await win.waitForURL(/\/login/)
  await signIn(win)
}
async function signIn(page) {
  await page.fill('input[type=email]', me.email)
  await page.getByRole('button', { name: '계속', exact: true }).click()
  await page.locator('.code input').first().waitFor()
  await page.locator('.code input').first().fill('000000')
  await page.waitForURL(/\/chat/)
  await expect(page.locator('header.top')).toBeVisible()
}
const settingsOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'desktop-settings.json'), 'utf8'))
const pageSession = (win) => win.evaluate(() => { const s = window.pglDesktop?.session?.get?.(); return s ? JSON.parse(s).session : null })
const stored = (win) => win.evaluate(() => localStorage.getItem('pgpt-pro-session'))
const pcBrowserUrls = (app) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.pglBrowser && !w.isDestroyed()).map((w) => w.webContents.getURL()))

test.beforeAll(async () => {
  test.setTimeout(240_000)
  fs.mkdirSync(SHOTS, { recursive: true })
  API_PORT = portFree(8991) ? 8991 : freePort(8992)
  WEB_PORT = portFree(5391) ? 5391 : freePort(5392)
  LITE = `http://127.0.0.1:${WEB_PORT}`
  llm = startModel(); judge = startJudge(); site = startSite(); other = startOther()
  const llmPort = await listen(llm), judgePort = await listen(judge)
  SITE = `http://127.0.0.1:${await listen(site)}`
  OTHER = `http://127.0.0.1:${await listen(other)}`
  const env = { ...process.env, PRO_PORT: String(API_PORT), PRO_BACKGROUND: '0', PRO_ONTOLOGY_WORKER: '0', PRO_SCENARIOS: 'off', PRO_TENANT_ID: TENANT, PRO_TENANT_HOSTS: '',
    PRO_FOLDERS_ROOT: path.join(ROOT, 'folders'), PRO_LOCAL_AGENT_TICK_MS: '500', PRO_LLM_BASE_URL: `http://127.0.0.1:${llmPort}`, PRO_LLM_API_KEY: 'test',
    PRO_JUDGE_URL: `http://127.0.0.1:${judgePort}/judge`, PRO_CONTEXT_ROUTER_URL: '', PRO_BROWSER_GATES: 'off', PRO_BROWSER_PROFILES: path.join(ROOT, 'profiles'),
    PRO_PUBLIC_URL: LITE }
  bff = spawn(process.execPath, ['index.js'], { cwd: SERVER, env, stdio: ['ignore', 'pipe', 'pipe'] })
  for (const s of [bff.stdout, bff.stderr]) s.on('data', (d) => logs.push(`[bff] ${d}`))
  vite = spawn(process.execPath, [path.join(REPO, 'node_modules/vite/bin/vite.js'), '--port', String(WEB_PORT), '--strictPort', '--host', '127.0.0.1'], { cwd: REPO, env: { ...process.env, PRO_API_TARGET: `http://127.0.0.1:${API_PORT}` }, stdio: ['ignore', 'pipe', 'pipe'] })
  for (const s of [vite.stdout, vite.stderr]) s.on('data', (d) => logs.push(`[vite] ${d}`))
  await waitFor(async () => (await fetch(`http://127.0.0.1:${API_PORT}/api/config`).catch(() => null))?.ok, 60000, 'BFF')
  await waitFor(async () => (await fetch(`${LITE}/chat`).catch(() => null))?.ok, 60000, 'Vite')
  const { config } = await import(pathToFileURL(path.join(SERVER, 'config.js')).href)
  db = new pg.Pool({ ...config.db, max: 3 })
  const r = await api('/auth/email/verify', { method: 'POST', body: { email: me.email, code: '000000' }, token: null })
  me.id = r.user.id
  me.token = r.session.access_token
  await api('/profile', { method: 'POST', body: { name: '한보안', birth: '1990-01-01', onboarded: true } })
})
let A = null // app A: { app, win, dir }
test.afterAll(async () => {
  await A?.app?.close().catch(() => {})
  bff?.kill('SIGTERM'); vite?.kill('SIGTERM')
  llm?.close(); judge?.close(); site?.close(); other?.close()
  if (db) {
    await q('delete from pro_local_devices where tenant_id=$1', [TENANT]).catch(() => {})
    await q('delete from pro_threads where user_id=$1', [me.id]).catch(() => {})
    await db.end()
  }
  if (test.info().status !== test.info().expectedStatus) console.log(logs.slice(-80).join(''))
  fs.rmSync(ROOT, { recursive: true, force: true })
})

test('DH-01 로그인은 앱이 봉인해 둔다 — 페이지의 저장소에 없고, 새로 고쳐도 · 다시 켜도 로그인한 채, 사용자 데이터 폴더에 토큰이 그대로 없다', async () => {
  const dir = path.join(ROOT, 'app-a')
  A = { dir, ...(await launch(dir)) }
  await connectAndSignIn(A.win)
  expect(await A.win.evaluate(() => window.pglDesktop.session.sealed())).toBe(true)
  const s = await pageSession(A.win)
  expect(s?.access_token?.length).toBeGreaterThan(20)
  expect(await stored(A.win)).toBeNull()
  const origin = new URL(LITE).origin
  await waitFor(() => settingsOf(dir).webSession?.[origin]?.enc === true, 5000, 'sealed in the settings')
  // the page works as before after a reload (the app asks the server with it)
  await A.win.reload()
  await expect(A.win.locator('header.top')).toBeVisible()
  expect(A.win.url()).toMatch(/\/chat/)
  await api('/me', { token: (await pageSession(A.win)).access_token })
  // the app again: still signed in, at the chat
  await A.app.close()
  const files = fileCount(dir)
  const hits = filesWith(dir, [s.access_token, s.refresh_token])
  console.log(`[DH-01] ${files} files in the profile, tokens found in: ${JSON.stringify(hits)}`)
  expect(hits).toEqual([])
  Object.assign(A, await launch(dir))
  await A.win.waitForURL(/\/chat/, { timeout: 30000 })
  await expect(A.win.locator('header.top')).toBeVisible()
  expect(A.win.url()).not.toMatch(/\/login/)
  await A.win.waitForTimeout(1200)
  await shot(A.win, 'dh01-signed-in-after-restart')
  // the runner pairs this computer as before (its own token, sealed the same way)
  await waitFor(async () => (await A.win.evaluate(() => window.pglDesktop.localRunner.status()))?.connected, 30000, 'linked')
})

test('DH-02 에이전트 브라우저는 이 앱의 Lite 주소를 열지 않는다 — 열기 · 그리로 보내기 · 링크 · 요청 · 넘겨받은 창에서도', async () => {
  const { app, win } = A
  const seen = { tools: [], snaps: [] }
  const liteUrls = async () => (await pcBrowserUrls(app)).filter((u) => u.startsWith(LITE) || u.startsWith(`http://localhost:${WEB_PORT}`))
  scripts.push({ key: 'Lite 링크를 확인', i: 0, moves: [
    ['goto', { url: `http://localhost:${WEB_PORT}/login` }],
    // (by a name that resolves to this PC, and by IPv4 inside IPv6)
    (b) => { seen.tools.push(lastTool(b)); return ['goto', { url: `http://${ALIAS}:${WEB_PORT}/login` }] },
    (b) => { seen.alias = lastTool(b); return ['goto', { url: `http://[::ffff:7f00:1]:${WEB_PORT}/login` }] },
    (b) => { seen.mapped = lastTool(b); return ['goto', { url: `${SITE}/go-lite` }] },
    (b) => { seen.tools.push(lastTool(b)); return ['goto', { url: `${SITE}/start` }] },
    (b) => { seen.tools.push(lastTool(b)); return ['click', { i: lastSnap(b).els.find((x) => x.text === 'Lite 로 가기').i }] },
    (b) => { seen.tools.push(lastTool(b)); seen.snaps.push(lastSnap(b)); return ['need_user', { reason: '이 단계는 사람이 직접 확인해야 해요', need: 'other' }] },
    (b) => { seen.snaps.push(lastSnap(b)); return ['finish', { summary: 'Lite 링크를 확인했어요.' }] },
  ] })
  await win.goto(`${LITE}/chat`)
  await win.locator('textarea').first().fill(`가상 사이트(${SITE}/start)에 로그인해서 Lite 링크를 확인해 줘`)
  await win.keyboard.press('Enter')
  const card = win.locator('.task').last()
  await expect(card.getByTestId('task-where')).toHaveText('내 PC · 시험 맥', { timeout: 30000 })
  const ask = win.getByTestId('task-ask').last()
  await expect(ask.getByTestId('task-pc')).toHaveText('이 PC에서 보기', { timeout: 40000 })
  // what the agent was told: the app's own address (by another name of this PC too) and a site that sends there are not opened
  expect(seen.tools[0]).toMatch(/^error: could not open .*does not open the Process GPT Lite app/)
  expect(seen.alias).toMatch(/^error: could not open .*does not open the Process GPT Lite app/)
  expect(seen.mapped).toMatch(/^error: could not open .*does not open the Process GPT Lite app/)
  // (the alias was refused because it resolves to this PC — the session's own resolver says so)
  const partition = `persist:pgl-browser-${me.id}`
  const ends = await app.evaluate(async ({ session }, [p, h]) => (await session.fromPartition(p).resolveHost(h)).endpoints.map((e) => e.address), [partition, ALIAS])
  expect(ends).toContain('127.0.0.1')
  // the Lite server's API at an address the PC does not take for the app's (the BFF's own port): a request of that session carries the
  // mark, and the server itself refuses it
  const bff = await app.evaluate(async ({ session }, [p, u]) => { const r = await session.fromPartition(p).fetch(u); return { status: r.status, body: await r.text() } }, [partition, `http://127.0.0.1:${API_PORT}/api/me`])
  console.log(`[DH-02] the BFF port from the agent browser's session: ${bff.status} ${bff.body.slice(0, 120)}`)
  expect(bff.status).toBe(403)
  expect(JSON.parse(bff.body)).toMatchObject({ code: 'agent_browser', error: expect.stringContaining('에이전트 브라우저에서 온 요청은 받지 않아요') })
  expect((await fetch(`http://127.0.0.1:${API_PORT}/api/me`)).status).toBe(401)
  // (what needs no session — the app's public settings — still answers it)
  expect(await app.evaluate(async ({ session }, [p, u]) => (await session.fromPartition(p).fetch(u)).status, [partition, `http://127.0.0.1:${API_PORT}/api/config`])).toBe(200)
  expect(seen.tools[1]).toMatch(/^error: could not open/)
  expect(seen.tools[2]).toBe('ok')
  // a link of the page to it: the page stays, and the agent's next look says why
  expect(seen.snaps[0].url).toBe(`${SITE}/start`)
  expect(seen.snaps[0].text).toMatch(/\[not opened\] http:\/\/127\.0\.0\.1:\d+: this browser does not open the Process GPT Lite app/)
  expect(await liteUrls()).toEqual([])
  // 「이 PC에서 보기」: the person works the window — a link, a fetch, a picture, a new window to the app: none of them goes there
  const [{ id: taskId }] = await q(`select m.id from pro_messages m join pro_threads t on t.id=m.thread_id where t.user_id=$1 and m.kind='task' order by m.created_at desc limit 1`, [me.id])
  await api('/browser/show', { method: 'POST', body: { taskId } })
  const pcWin = await waitFor(async () => app.windows().find((p) => p.url().startsWith(`${SITE}/start`)), 15000, 'the PC window')
  await waitFor(async () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w) => w.pglBrowser && w.isVisible())), 15000, 'shown')
  // (the person's clicks, in the page itself: Playwright's own click would wait for the refused navigation to finish)
  await pcWin.evaluate(() => document.getElementById('to-lite').click())
  await pcWin.waitForTimeout(800)
  expect(await pcWin.evaluate(() => location.href)).toBe(`${SITE}/start`)
  await pcWin.evaluate(() => document.getElementById('probe').click())
  expect(await waitFor(async () => { const t = await pcWin.evaluate(() => document.getElementById('out').textContent); return t !== '아직' ? t : null }, 10000, 'probe')).toBe('blocked blocked no-window')
  const told = await waitFor(async () => { const n = await app.evaluate(() => global.__pglBrowserNotices || []); return n.length ? n : null }, 5000, 'the notice')
  expect(told[0]).toMatchObject({ origin: LITE, message: '이 주소는 에이전트 브라우저에서 열지 않아요' })
  expect(await liteUrls()).toEqual([])
  await pcWin.screenshot({ path: path.join(SHOTS, 'dh02-pc-window-refused.png') })
  // more ways a page goes for it: a beacon, a live socket, a service worker's fetch, a form's POST — none gets there; a CORS request to
  // another site still works, and carries the mark
  const at = logs.length
  marks.length = 0
  await pcWin.evaluate(() => document.getElementById('probe2').click())
  const more = await waitFor(async () => { const t = await pcWin.evaluate(() => document.getElementById('out2')?.textContent).catch(() => null); return t && t !== '아직' ? t : null }, 20000, 'probe2')
  console.log(`[DH-02] ${more}`)
  expect(more).toBe('beacon-queued ws-blocked sw-blocked cors-ok')
  await pcWin.waitForTimeout(800)
  expect(await pcWin.evaluate(() => location.href)).toBe(`${SITE}/start`)
  const refusedKinds = logs.slice(at).join('').match(/refused \(the Lite app or its sign-in\): \w+/g) || []
  console.log(`[DH-02] refused: ${JSON.stringify([...new Set(refusedKinds)])}`)
  expect(refusedKinds.some((k) => k.endsWith('ping'))).toBe(true)
  expect(marks).toContain('1')
  expect(await liteUrls()).toEqual([])
  // given back: the task goes on and ends
  await api('/browser/resume', { method: 'POST', body: { text: 'The user took over and finished the manual part. Re-check the page and continue.' } })
  const done = await waitFor(async () => {
    const rows = await q(`select m.content from pro_messages m join pro_threads t on t.id=m.thread_id where t.user_id=$1 and m.kind='task' and m.content->>'goal' like $2 order by m.created_at desc limit 1`, [me.id, '%Lite 링크를 확인%'])
    return rows[0]?.content?.state === 'done' ? rows[0] : null
  }, 60000, 'task done')
  expect(done.content.where.kind).toBe('local')
  expect(await liteUrls()).toEqual([])
})

test('DH-05 새 창으로 여는 웹 앱 링크는 앱 창에서, 웹 앱의 라우터로 — 다시 불러오지 않고 로그인한 채; 앱 화면이 아닌 서버 주소는 새 창, 패널 앱의 링크는 바깥', async () => {
  const { app, win } = A
  await win.goto(`${LITE}/chat`)
  await expect(win.locator('header.top')).toBeVisible()
  const open = (u) => win.evaluate((x) => { const a = document.createElement('a'); a.href = x; a.target = '_blank'; a.rel = 'noopener'; document.body.appendChild(a); a.click(); a.remove() }, u)
  const pages = () => app.windows().filter((p) => !p.isClosed() && p.url().startsWith(LITE)).length
  const before = pages()
  // (a mark on the page itself: a reload would take it away — a meeting, an open document, a reply on its way would go with it)
  await win.evaluate(() => { window.__dh05 = 'still here' })
  await open(`${LITE}/folders`)
  await win.waitForURL(/\/folders/, { timeout: 15000 })
  await win.waitForTimeout(800)
  expect(await win.evaluate(() => window.__dh05)).toBe('still here')
  expect(pages()).toBe(before)
  expect(win.url()).not.toMatch(/\/login/)
  expect((await pageSession(win))?.access_token?.length).toBeGreaterThan(20)
  expect(await stored(win)).toBeNull()
  // the server's addresses that are not the web app's screens (its /api/, a file it serves): a window of their own, as before
  for (const p of ['/api/config', '/favicon.svg']) {
    const child = app.waitForEvent('window', { timeout: 15000 })
    await open(`${LITE}${p}`)
    const c = await child
    await c.waitForLoadState().catch(() => {})
    expect(c.url()).toContain(p)
    await c.close()
  }
  // a panel app's link (src/components/PanelFrame.vue): the system browser (tests: global.__pglExternal) — the window stays where it was
  const had = (await app.evaluate(() => global.__pglExternal || [])).length
  await win.evaluate((u) => window.pglDesktop.openOutside(u), `${LITE}/chat`)
  await expect.poll(async () => (await app.evaluate(() => global.__pglExternal || [])).slice(had)).toEqual([`${LITE}/chat`])
  expect(win.url()).toMatch(/\/folders/)
  expect(await win.evaluate(() => window.__dh05)).toBe('still here')
})

// a raw websocket handshake to the BFF port, with or without the mark: the first line of the answer
function handshake(port, path, extra = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1')
    let got = ''
    sock.on('data', (d) => { got += d; if (got.includes('\r\n')) { sock.destroy(); resolve(got.split('\r\n')[0]) } })
    sock.on('error', reject)
    sock.setTimeout(5000, () => { sock.destroy(); resolve(got.split('\r\n')[0] || 'no answer') })
    const head = { Host: `127.0.0.1:${port}`, Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', ...extra }
    sock.write(`GET ${path} HTTP/1.1\r\n${Object.entries(head).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`)
  })
}

test('DH-06 에이전트 브라우저 세션의 웹소켓도 서버의 다른 주소(BFF 포트)로 가면 표시가 붙어 서버가 403 으로 닫는다 — 표시 없는 같은 연결은 열린다', async () => {
  const { app } = A
  const url = `ws://127.0.0.1:${API_PORT}/api/local-agents/link`
  const at = logs.length
  const got = await app.evaluate(async ({ BrowserWindow }, u) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.pglBrowser && !x.isDestroyed())
    if (!w) return 'no-window'
    return w.webContents.executeJavaScript(`new Promise((ok) => { const s = new WebSocket(${JSON.stringify(u)}); s.onopen = () => { s.close(); ok('open') }; s.onerror = () => ok('error'); setTimeout(() => ok('none'), 5000) })`, true)
  }, url)
  console.log(`[DH-06] a websocket of the agent browser's session to ${url}: ${got}`)
  expect(got).toBe('error')
  // (not refused by the desktop — the BFF port is not the app's address: the server closed it, as it does a marked handshake)
  expect(logs.slice(at).join('')).not.toMatch(/refused \(the Lite app or its sign-in\): webSocket/)
  expect(await handshake(API_PORT, '/api/local-agents/link', { 'X-PGL-Agent-Browser': '1' })).toBe('HTTP/1.1 403 Forbidden')
  expect(await handshake(API_PORT, '/api/local-agents/link')).toBe('HTTP/1.1 101 Switching Protocols')
})

test('DH-03 로그아웃하면 봉인해 둔 로그인도 지운다', async () => {
  const { win, dir } = A
  const origin = new URL(LITE).origin
  await win.goto(`${LITE}/chat`)
  await win.locator('header.top button.avatar').click()
  await win.waitForURL(/\/settings/)
  await win.locator('.settings .list button.danger', { hasText: '로그아웃' }).click()
  await win.waitForURL(/\/login/)
  await waitFor(() => !settingsOf(dir).webSession?.[origin], 5000, 'forgotten')
  expect(await pageSession(win)).toBeNull()
  await win.reload()
  await win.waitForURL(/\/login/)
  await A.app.close()
  A = null
})

test('DH-04 페이지의 저장소에 있던 로그인(앞선 판)은 처음 실행에 옮기고 지운다 — 키체인을 쓸 수 없으면 지금처럼 저장소에', async () => {
  const dir = path.join(ROOT, 'app-b')
  // as on a computer whose keychain cannot be used (and as 0.2.5 kept it): the page's own storage
  let b = await launch(dir, { PGL_DESKTOP_NO_SEAL: '1' })
  await connectAndSignIn(b.win)
  expect(await b.win.evaluate(() => window.pglDesktop.session.sealed())).toBe(false)
  const old = JSON.parse(await stored(b.win)).session
  expect(old.access_token.length).toBeGreaterThan(20)
  await b.win.reload()
  await expect(b.win.locator('header.top')).toBeVisible()
  await b.app.close()
  const before = filesWith(dir, [old.access_token, old.refresh_token])
  console.log(`[DH-04] the page's own storage (no keychain): tokens found in ${JSON.stringify(before)}`)
  expect(before.some((f) => f.startsWith(path.join('Local Storage', 'leveldb')))).toBe(true)
  expect(settingsOf(dir).webSession).toBeUndefined()
  // the app with the keychain: the sign-in moves, the storage forgets it, the person is still signed in
  b = await launch(dir)
  await b.win.waitForURL(/\/chat/, { timeout: 30000 })
  await expect(b.win.locator('header.top')).toBeVisible()
  expect(await stored(b.win)).toBeNull()
  const origin = new URL(LITE).origin
  await waitFor(() => settingsOf(dir).webSession?.[origin]?.enc === true, 5000, 'moved')
  // renewed once: the pair the storage held is spent (the auth server rotates the refresh token on use)
  const now = await waitFor(async () => { const s = await pageSession(b.win); return s && s.refresh_token !== old.refresh_token ? s : null }, 15000, 'renewed')
  expect(now.access_token).not.toBe(old.access_token)
  await b.win.reload()
  await expect(b.win.locator('header.top')).toBeVisible()
  expect(b.win.url()).toMatch(/\/chat/)
  await b.app.close()
  const after = filesWith(dir, [now.access_token, now.refresh_token])
  const left = filesWith(dir, [old.access_token, old.refresh_token])
  console.log(`[DH-04] after moving: the new pair in ${JSON.stringify(after)}; the spent pair still in ${JSON.stringify(left)}`)
  expect(after).toEqual([])
})
