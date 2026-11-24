// 서버 브라우저가 멈춘 것처럼 보이지 않는다 — 2026-11-24 「계룡대 인근 숙소 검색 … 브라우저가 먹통이 된」(스펙 browser-handoff).
// 한 걸음이 20초 넘게 움직이지 않으면 작업 카드가 「기다리는 중 · <무엇>」과 몇 초째인지, 「다시 시도」 · 「그만두기」를 보여 준다.
//   F-BW-01 휴대폰(390): 멈춘 카드 — 기다리는 것 · 시간이 흐름 · 두 단추가 화면 안에, 단추는 그 카드의 작업으로 요청
//   F-BW-02 넓은 화면: 입력창 옆 독은 호박색 테두리, 누르면 가운데 카드에도 같은 줄 · 확장 화면에도 · 움직이면 사라짐
//   F-BW-03 진짜 브라우저 작업(이 시험 프로세스 안의 서버 모듈 · 진짜 Chromium · 대본대로 답하지 않는 모델 · 지어낸 숙소 사이트):
//           휴대폰에서 「그만두기」 → 곧바로 취소되고 브라우저가 비어 다음 작업이 돈다
//   F-BW-04 같은 방식으로 「다시 시도」 → 그 걸음만 다시 묻고 작업이 끝까지 간다(카드의 줄은 사라짐)
// F-BW-03·04 의 서버 이벤트는 이 프로세스의 lib/bus.js 에서 화면의 store 로 옮기고, 카드의 단추 요청은 page.route 로 이 프로세스의
// browser.cancel · retryStep 에 잇는다(화면이 붙은 BFF 에는 이 작업이 없다). 모델은 쓰지 않는다.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { test, expect } from '../../lib/fixtures.js'
import { PNG } from '../../lib/seed.js'
import { SERVER_DIR, hasServerSource, LOCAL_API } from '../../lib/env.js'

const PHONE = { viewport: { width: 390, height: 844 } }
const shot = PNG(640, 400, [40, 120, 200]).toString('base64')
const steps = [{ text: '숙소 검색', done: true }, { text: '가격 비교', done: false }]
const stalledCard = (what = 'AI 모델의 답', ago = 25) => ({ title: '가상시 숙소 비교', goal: 'g', steps, state: 'running', shot,
  stall: { what, since: new Date(Date.now() - ago * 1000).toISOString(), after: 20 } })

// the page's own store (pinia 'app'): what an SSE event does
const emit = (page, type, data) => page.evaluate(([t, d]) => document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('app').onEvent(t, d), [type, data])
async function photo(page, testInfo, name) {
  const dir = process.env.BW_SHOTS || testInfo.outputDir
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${name}.png`)
  await page.screenshot({ path: file })
  await testInfo.attach(name, { path: file, contentType: 'image/png' })
  return file
}
async function fitsPhone(page, loc) {
  const b = await loc.boundingBox()
  expect(b.x).toBeGreaterThanOrEqual(0)
  expect(b.x + b.width).toBeLessThanOrEqual(390.5)
  const over = await page.evaluate(() => { const m = document.querySelector('.msgs'); return m ? m.scrollWidth - m.clientWidth : 0 })
  expect(over).toBeLessThanOrEqual(0)
}
const toChat = (page) => page.locator('button, a').filter({ hasText: /^채팅$/ }).first().click()

test.describe('서버 브라우저 · 멈춘 것처럼 보이지 않게', () => {
  test('F-BW-01 휴대폰: 멈춘 걸음 — 「기다리는 중 · AI 모델의 답」, 흐르는 시간, 「다시 시도」 · 「그만두기」가 그 작업으로', async ({ pageAs, db }, testInfo) => {
    const page = await pageAs('bw-stall-phone', PHONE)
    const th = await db.clearMain(page.user.id)
    const [, task] = await db.addMessages(th, [
      { role: 'user', kind: 'text', content: { text: '가상시 근처 12월 18~20일 숙소 검색해서 비교해 줘' } },
      { role: 'agent', kind: 'task', content: stalledCard() },
    ])
    const sent = []
    page.on('request', (r) => { if (/\/api\/browser\/(retry|cancel)$/.test(r.url())) sent.push([r.url().split('/').pop(), r.postDataJSON()]) })
    await page.goto('/chat')
    await toChat(page)
    const card = page.locator(`.row[data-id="${task.id}"]`)
    const strip = card.getByTestId('task-stall')
    await expect(strip).toBeVisible({ timeout: 20_000 })
    await expect(strip.getByTestId('task-stall-what')).toHaveText('기다리는 중 · AI 모델의 답')
    await expect(strip).toContainText('「다시 시도」로 이 단계를 다시 하거나')
    // the time runs on: 25 s ago at seeding, more a moment later
    const secs = async () => Number((await strip.getByTestId('task-stall-time').textContent()).replace(/\D+/g, ''))
    const first = await secs()
    expect(first).toBeGreaterThanOrEqual(25)
    await expect.poll(secs, { timeout: 5000 }).toBeGreaterThan(first)
    const retry = strip.getByTestId('task-retry-step'), giveUp = strip.getByTestId('task-giveup')
    await expect(retry).toHaveText('다시 시도')
    await expect(giveUp).toHaveText('그만두기')
    await strip.scrollIntoViewIfNeeded()
    await fitsPhone(page, strip)
    await fitsPhone(page, giveUp)
    // the buttons are not under the composer
    const foot = await page.locator('.foot').first().boundingBox()
    if (foot) expect((await giveUp.boundingBox()).y + 48).toBeLessThanOrEqual(foot.y + 1)
    await photo(page, testInfo, 'bw01-stall-390')
    await retry.click()
    await giveUp.click()
    await expect.poll(() => sent.length).toBe(2)
    expect(sent).toEqual([['retry', { taskId: task.id }], ['cancel', { taskId: task.id }]])
    expect(page.errors).toEqual([])
  })

  test('F-BW-02 넓은 화면: 독은 호박색 테두리 → 가운데 카드에도 그 줄, 확장 화면에도 · 다음 걸음이 시작되면 사라진다', async ({ pageAs, db }, testInfo) => {
    const page = await pageAs('bw-stall-wide')
    const th = await db.clearMain(page.user.id)
    const [task] = await db.addMessages(th, [{ role: 'agent', kind: 'task', content: stalledCard('travel.example 페이지 읽기', 31) }])
    await page.goto('/chat')
    const dock = page.locator('.foot .dock')
    await expect(dock).toHaveClass(/\bstall\b/, { timeout: 20_000 })
    await expect(dock).toHaveAttribute('aria-label', '브라우저 작업 · 기다리는 중')
    await dock.click()
    const peek = page.locator('.peek .pcard')
    await expect(peek.getByTestId('task-stall-what')).toHaveText('기다리는 중 · travel.example 페이지 읽기')
    await photo(page, testInfo, 'bw02-stall-peek')
    await page.locator('.peek').getByRole('button', { name: '확장' }).click()
    const full = page.locator('.handoff')
    await expect(full.getByTestId('task-stall')).toBeVisible()
    await expect(full.getByTestId('task-retry-step')).toBeVisible()
    await expect(page.locator('.peek')).toHaveCount(0)
    await page.waitForTimeout(500) // (the full view pops in)
    await photo(page, testInfo, 'bw02-stall-full')
    // the next step started (the server clears content.stall): the line goes, the ring too
    await emit(page, 'message', { ...task, content: { ...task.content, stall: null } })
    await expect(full.getByTestId('task-stall')).toHaveCount(0)
    await page.locator('.handoff .x').click()
    await expect(dock).not.toHaveClass(/\bstall\b/)
    expect(page.errors).toEqual([])
  })
})

// ---- F-BW-03 · 04: a real browser task in this process ----
test.describe('서버 브라우저 · 진짜 작업으로', () => {
  test.describe.configure({ mode: 'serial' })
  let browser, bus, steps0, site, llm, scripts, profiles
  const lib = (rel) => import(pathToFileURL(path.join(SERVER_DIR, rel)).href)
  test.skip(!hasServerSource() || !LOCAL_API, 'pgpt-pro server 소스/로컬 서버가 아님 (PGPT_SERVER_DIR)')
  test.beforeAll(async () => {
    profiles = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-profiles-'))
    process.env.PRO_BROWSER_PROFILES = profiles
    // scripted model: the plan, then per goal its moves ('hang': never answers until the agent gives up on the request)
    scripts = {}
    llm = http.createServer((req, res) => {
      let raw = ''
      req.on('data', (c) => { raw += c })
      req.on('end', () => {
        const body = JSON.parse(raw)
        let message
        if (body.response_format) message = { role: 'assistant', content: JSON.stringify({ title: '가상시 숙소 비교', steps: ['숙소 검색', '가격 비교'] }) }
        else {
          const goal = /Goal: (.*)/.exec(body.messages[0].content)?.[1] || ''
          const s = scripts[goal] || { i: 0, moves: [['finish', { summary: '끝.' }]] }
          const move = s.moves[Math.min(s.i++, s.moves.length - 1)]
          if (move === 'hang') return
          message = { role: 'assistant', content: null, tool_calls: [{ id: 'call_' + crypto.randomUUID().slice(0, 8), type: 'function', function: { name: move[0], arguments: JSON.stringify(move[1]) } }] }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message }] }))
      })
    })
    await new Promise((r) => llm.listen(0, '127.0.0.1', r))
    const { config } = await lib('config.js')
    Object.assign(config.llm, { baseUrl: `http://127.0.0.1:${llm.address().port}`, apiKey: 'test' })
    browser = await lib('lib/browser.js')
    bus = await lib('lib/bus.js')
    steps0 = { ...browser.STEP }
    browser.STEP.stallMs = 1500
    const { startHeavy } = await lib('test/fixtures/heavy.mjs')
    site = await startHeavy()
  })
  test.afterAll(async () => {
    if (browser) Object.assign(browser.STEP, steps0)
    await site?.close()
    llm?.close(); llm?.closeAllConnections?.()
    fs.rmSync(profiles, { recursive: true, force: true })
  })

  // the server's events for this person, into the page's store in order; the card's buttons, to this process
  async function wire(page, userId) {
    let chain = Promise.resolve()
    const off = bus.subscribe(userId, {
      writableLength: 0,
      write(line) {
        const type = /^event: (.*)$/m.exec(line)?.[1]
        if (!['message', 'status', 'browser.frame', 'thread'].includes(type)) return true
        const data = JSON.parse(/^data: (.*)$/m.exec(line)[1])
        chain = chain.then(() => emit(page, type, data)).catch(() => {})
        return true
      },
    })
    await page.route('**/api/browser/cancel', (r) => r.fulfill({ json: { ok: browser.cancel(userId, r.request().postDataJSON()?.taskId) } }))
    await page.route('**/api/browser/retry', (r) => r.fulfill({ json: { ok: browser.retryStep(userId, r.request().postDataJSON()?.taskId) } }))
    return () => { off(); return chain }
  }
  async function begin(page, db, goal, moves) {
    const userId = page.user.id
    const th = await db.clearMain(userId)
    await page.goto('/chat')
    await toChat(page)
    await expect(page.locator('.composer, .foot').first()).toBeVisible({ timeout: 20_000 })
    const unwire = await wire(page, userId)
    scripts[goal] = { i: 0, moves }
    const run = browser.runBrowserTask({ userId, threadId: th, goal, startUrl: `${site.url}/stay`, gates: false })
    return { userId, th, run, unwire }
  }

  test('F-BW-03 휴대폰: 모델이 답하지 않아 멈춘 작업 → 「그만두기」 — 2초 안에 취소, 브라우저는 비고 다음 작업이 돈다', async ({ pageAs, db, cleanup }, testInfo) => {
    const page = await pageAs('bw-stall-live', PHONE)
    const goal = '가상시 숙소 비교 — 그만두기'
    const { userId, th, run, unwire } = await begin(page, db, goal, ['hang'])
    cleanup(() => browser.close(userId))
    const strip = page.getByTestId('task-stall')
    await expect(strip).toBeVisible({ timeout: 30_000 })
    await expect(strip.getByTestId('task-stall-what')).toHaveText('기다리는 중 · AI 모델의 답')
    await expect(page.locator('.task .screen img').first()).toBeVisible()
    await strip.scrollIntoViewIfNeeded()
    await fitsPhone(page, strip)
    await photo(page, testInfo, 'bw03-live-stall-390')
    const t0 = Date.now()
    await strip.getByTestId('task-giveup').click()
    const r = await run
    expect(r.state).toBe('cancelled')
    expect(Date.now() - t0).toBeLessThan(2500)
    expect(browser.browserBusy(userId)).toBe('')
    await expect(page.getByTestId('task-stall')).toHaveCount(0)
    // the card says it was cancelled (not a check mark that reads as done), and the live line is gone
    await expect(page.getByTestId('task-pill').first()).toHaveText('취소함 · 가상시 숙소 비교')
    await expect(page.getByText('다음 할 일 고르는 중')).toHaveCount(0)
    await photo(page, testInfo, 'bw03-live-cancelled-390')
    // the browser is free: the next task runs on it
    scripts['다음 작업'] = { i: 0, moves: [['note', { text: '다음' }], ['finish', { summary: '이어서 했어요.' }]] }
    const next = await browser.runBrowserTask({ userId, threadId: th, goal: '다음 작업', startUrl: `${site.url}/stay`, gates: false })
    expect(next.state).toBe('done')
    await unwire()
    expect(page.errors).toEqual([])
  })

  test('F-BW-04 휴대폰: 멈춘 걸음에서 「다시 시도」 — 그 걸음만 다시 묻고 작업이 끝까지 간다', async ({ pageAs, db, cleanup }, testInfo) => {
    const page = await pageAs('bw-stall-live2', PHONE)
    const goal = '가상시 숙소 비교 — 다시 시도'
    const { userId, run, unwire } = await begin(page, db, goal, ['hang', ['note', { text: '가상시 솔숲 게스트하우스 1박 68,000원' }], ['finish', { summary: '가상시 솔숲 게스트하우스가 1박 68,000원이에요.' }]])
    cleanup(() => browser.close(userId))
    const strip = page.getByTestId('task-stall')
    await expect(strip).toBeVisible({ timeout: 30_000 })
    await strip.getByTestId('task-retry-step').click()
    const r = await run
    expect(r.state).toBe('done')
    expect(r.stats.retries).toBe(1)
    await expect(page.getByTestId('task-stall')).toHaveCount(0)
    await expect(page.locator('.task .title .tt').first()).toHaveText('가상시 숙소 비교')
    await photo(page, testInfo, 'bw04-live-retried-390')
    await unwire()
    expect(page.errors).toEqual([])
  })
})
