// 직접 제어(spec pgpt-pro_room-rules): 구글 비밀번호처럼 사람만 칠 수 있는 것은 라이브 화면으로 친다.
// 실제 서버·실제 Chromium·실제 화면, 모델만 대본. 화면에 보이는 색칠한 버튼을 사람처럼 찾아서 누른다.
//   node test/takeover.e2e.mjs
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const here = path.dirname(fileURLToPath(import.meta.url))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, what, ms = 20000) => {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`기다렸지만 안 됨: ${what}`)
    await sleep(100)
  }
}
const freePort = () => new Promise((r) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)) }) })
const listen = (handler) => new Promise((r) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => r(s)) })

// 사람이 알아볼 색칠한 표적: 뷰포트(1280x800)의 네 귀퉁이와 입력 칸
const TARGETS = { top_left: [20, 20, '#ff00ff'], top_right: [1180, 20, '#00ffff'], bottom_left: [20, 730, '#ffff00'], bottom_right: [1180, 730, '#0000ff'] }
const RGB = { top_left: [255, 0, 255], top_right: [0, 255, 255], bottom_left: [255, 255, 0], bottom_right: [0, 0, 255], field: [0, 255, 0] }
const PAGE = `<!doctype html><meta charset="utf-8"><title>로그인</title><body style="margin:0;background:#fff;height:800px;overflow:hidden">
${Object.entries(TARGETS).map(([k, [x, y, c]]) => `<button id="${k}" onclick="fetch('/hit?b=${k}')" style="position:absolute;left:${x}px;top:${y}px;width:80px;height:50px;border:0;background:${c}"></button>`).join('')}
<input id="field" autocomplete="off" style="position:absolute;left:440px;top:360px;width:400px;height:60px;border:0;background:#00ff00;color:#00ff00;font-size:20px" oninput="fetch('/v?n='+(++n)+'&x='+encodeURIComponent(this.value))">
<script>let n=0</script></body>`
const hits = []
let typed = { n: 0, x: '' }
// 이 값들은 시험마다 새로 만들고 어디에도 저장하지 않는다
const secret = `Tz9!kQ#2mX$7vB@4nR%8wL^1pF&6hJ*3-${crypto.randomUUID().slice(0, 8)}`
const pasted = `Pa5te-${crypto.randomUUID().slice(0, 12)}!`

const moves = [['need_user', { reason: '직접 로그인해 주세요' }], ['finish', { summary: '이어서 끝냈습니다' }]]
let llmCalls = 0
const logs = []
// what the server itself logs (the test runner prints its expected values to the same streams)
for (const level of ['log', 'info', 'warn', 'error']) {
  const write = console[level].bind(console)
  console[level] = (...args) => { logs.push(args.map(String).join(' ')); write(...args) }
}

let ctx, page, vite, site, llm, browser, q, pool, session, userId, threadId, api, web

before(async () => {
  site = await listen((req, res) => {
    const u = new URL(req.url, 'http://x')
    if (u.pathname === '/hit') { hits.push(u.searchParams.get('b')); return res.end('ok') }
    if (u.pathname === '/v') { const n = +u.searchParams.get('n'); if (n > typed.n) typed = { n, x: u.searchParams.get('x') }; return res.end('ok') }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(PAGE)
  })
  llm = await listen((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      const body = JSON.parse(raw)
      let message
      if (body.response_format) message = { role: 'assistant', content: JSON.stringify({ title: '로그인', steps: ['로그인', '끝내기'] }) }
      else {
        const [name, args] = moves[Math.min(llmCalls++, moves.length - 1)]
        message = { role: 'assistant', content: null, tool_calls: [{ id: 'call_' + crypto.randomUUID().slice(0, 8), type: 'function', function: { name, arguments: JSON.stringify(args) } }] }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message }] }))
    })
  })
  const bff = await freePort()
  const port = await freePort()
  Object.assign(process.env, { PRO_LLM_BASE_URL: `http://127.0.0.1:${llm.address().port}`, PRO_LLM_API_KEY: 'test', PRO_PORT: String(bff), PRO_BACKGROUND: '0', PRO_PUBLIC_URL: `http://localhost:${port}` })
  process.chdir(path.resolve(here, '..'))
  await import('../index.js')
  browser = await import('../lib/browser.js')
  ;({ q, pool } = await import('../lib/supa.js'))
  api = `http://127.0.0.1:${bff}/api`
  vite = spawn(path.resolve(here, '../../node_modules/.bin/vite'), ['--port', String(port), '--strictPort'], { cwd: path.resolve(here, '../..'), env: { ...process.env, PRO_API_TARGET: `http://127.0.0.1:${bff}` }, stdio: 'ignore' })
  web = `http://localhost:${port}`
  await until(() => fetch(web).then((r) => r.ok).catch(() => false), 'Vite')
  const login = await until(() => fetch(`${api}/auth/email/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'pro-rt-takeover@uengine.org', code: '000000', token: '000000' }) }).then((r) => r.ok && r.json()).catch(() => false), 'BFF 로그인')
  session = login.session
  userId = login.user.id
  await fetch(`${api}/profile`, { method: 'POST', headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '회귀-직접제어', birth: '1990-01-01', onboarded: true }) })
  await q(`delete from pro_threads where user_id=$1 and kind='project'`, [userId])
  ;[{ id: threadId }] = await q(`insert into pro_threads(user_id,kind,title) values ($1,'project','로그인 방') returning id`, [userId])
  browser.runBrowserTask({ userId, threadId, goal: '로그인', startUrl: `http://127.0.0.1:${site.address().port}/` })
  await until(async () => (await q(`select 1 from pro_messages where thread_id=$1 and kind='task' and content->>'state'='needs_input'`, [threadId])).length, '작업이 사람을 기다림')

  const pw = await chromium.launch({ headless: true })
  // 창 높이 800: 노트북에서 흔한 크기이고, 여기서 화면 아래쪽이 잘리면 「다음」 같은 버튼을 못 누른다
  ctx = await pw.newContext({ viewport: { width: 1280, height: 800 }, locale: 'ko-KR', permissions: ['clipboard-read', 'clipboard-write'] })
  await ctx.addInitScript((s) => { localStorage.setItem('pgpt-pro-session', s) }, JSON.stringify(login))
  page = await ctx.newPage()
})

after(async () => {
  await browser?.close?.(userId).catch(() => {})
  await q?.(`delete from pro_threads where id=$1`, [threadId]).catch(() => {})
  await ctx?.browser()?.close().catch(() => {})
  vite?.kill()
  site?.close(); llm?.close()
  if (userId) fs.rmSync(path.resolve(here, '../.browser-profiles', userId), { recursive: true, force: true })
  await pool?.end().catch(() => {})
  setTimeout(() => process.exit(process.exitCode || 0), 300)
})

// 화면 사진에서 그 색의 가운데를 찾는다: 사람 눈에 보이는 자리
const seen = async (color) => {
  const shot = (await page.screenshot()).toString('base64')
  return page.evaluate(async ([b64, [R, G, B]]) => {
    const img = new Image(); img.src = `data:image/png;base64,${b64}`; await img.decode()
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height
    const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0)
    const d = g.getImageData(0, 0, c.width, c.height).data
    let n = 0, sx = 0, sy = 0
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
      const i = (y * c.width + x) * 4
      if (Math.abs(d[i] - R) < 30 && Math.abs(d[i + 1] - G) < 30 && Math.abs(d[i + 2] - B) < 30) { n++; sx += x; sy += y }
    }
    return n > 200 ? { x: sx / n, y: sy / n } : null
  }, [shot, color])
}

test('나중에 연 카드에도 기다리는 화면이 보이고 직접 제어를 켤 수 있다', async () => {
  await page.goto(`${web}/projects/${threadId}`)
  await page.locator('.task .screen img').first().waitFor({ timeout: 15000 })
  await page.locator('.task .ctl').getByRole('button', { name: '조치 필요' }).click()
  await page.getByRole('button', { name: '직접 제어', exact: true }).click()
  await page.getByRole('button', { name: '제어 돌려주기' }).waitFor()
  await sleep(600) // the overlay finishes opening
})

for (const k of Object.keys(TARGETS)) {
  test(`화면에 보이는 표적을 누르면 그 표적이 눌린다: ${k}`, async () => {
    const at = await seen(RGB[k])
    assert.ok(at, `${k} 가 화면에 보이지 않는다 (라이브 화면이 잘렸다)`)
    hits.length = 0
    await page.mouse.click(at.x, at.y)
    await until(() => hits.length, `${k} 클릭이 페이지에 닿음`, 4000).catch(() => {})
    assert.deepEqual(hits, [k])
  })
}

test('빠르게 친 비밀번호가 순서대로 들어간다', async () => {
  const at = await seen(RGB.field)
  assert.ok(at, '입력 칸이 안 보인다')
  await page.mouse.click(at.x, at.y)
  await sleep(300)
  await page.keyboard.type(secret, { delay: 0 })
  await until(() => typed.x === secret, `입력값(지금 길이 ${typed.x.length})`, 8000).catch(() => {})
  assert.equal(typed.x, secret)
})

test('붙여넣기는 글자 v 가 아니라 복사한 내용을 넣는다', async () => {
  await page.evaluate((t) => navigator.clipboard.writeText(t), pasted)
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('Backspace')
  await until(() => typed.x === '', '칸 비우기', 4000).catch(() => {})
  assert.equal(typed.x, '', '전체 선택 후 지우기')
  await page.keyboard.press('ControlOrMeta+v')
  await until(() => typed.x === pasted, '붙여넣기', 4000).catch(() => {})
  assert.equal(typed.x, pasted)
})

test('드라이버가 모르는 키(한글 입력 상태 등)에도 요청이 멈추지 않고 그다음 글자가 들어간다', async () => {
  const before = typed.x
  await page.keyboard.press('Process').catch(() => {})
  const r = await fetch(`${api}/browser/input`, { method: 'POST', headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'key', key: 'Process' }), signal: AbortSignal.timeout(3000) })
  assert.equal(r.status, 200)
  await page.keyboard.type('z')
  await until(() => typed.x === `${before}z`, '다음 글자', 4000).catch(() => {})
  assert.equal(typed.x, `${before}z`)
})

test('친 값은 서버 로그에 남지 않는다', () => {
  const all = logs.join('')
  assert.ok(!all.includes(secret) && !all.includes(pasted))
})

test('제어를 돌려주면 작업이 이어서 끝난다', async () => {
  await page.getByRole('button', { name: '제어 돌려주기' }).click()
  await until(async () => (await q(`select 1 from pro_messages where thread_id=$1 and kind='task' and content->>'state' in ('done','needs_review')`, [threadId])).length, '작업 끝남')
})
