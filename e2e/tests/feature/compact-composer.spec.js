// 채팅 아래를 한 줄로 — 일하는 동안의 진행 알약 · 「멈추기」 · 「기본」 칩 · 입력창이 휴대폰에서 세 줄을 차지하던 것을 입력창과 그 위 한 줄로
// (스펙 openspec/specs/turn-plan 「채팅 아래는 입력창과 그 위 한 줄」, 화면 ChatColumn.vue · Composer.vue).
// 사용자(2026-11-27 휴대폰 녹화): 「이 공간 지금 여기 너무 많이 잡아먹고 있어요 좀 줄일 방법이 없나 … 단순화 시키든 공간을 내가 타이핑하는
// 동안에도 이게 그대로 있잖아」.
//   F-CC-01 390px · 일하는 동안: 진행 알약과 「기본」 칩이 입력창 위 한 줄, 「멈추기」는 입력창 안 ■ — 아래 부분의 높이(전 166px)를 잰다
//   F-CC-02 390px · 글을 치는 동안(입력창에 포커스): 위 줄이 접혀 입력창만, ■ 는 그대로 — 포커스가 빠지면 다시 한 줄
//   F-CC-03 390px · 손이 닿는 것: 알약 → 진행 상황 시트, 칩 → 에이전트 목록, 📎 → 파일 첨부 · 폴더 붙이기, 🎤, Tab 으로 ■(답 멈추기) → 멈춤 · ＋ 가 돌아옴
//   F-CC-04 1280px: 알약만 입력창 위, 칩 · ■ 는 입력창 안, 패널은 그 줄 위에 — 마우스 화면은 포커스가 있어도 접지 않음
//   F-CC-05 390px 프로젝트 방 · 휴대폰 홈 입력창도 같은 모양, 마지막 메시지(계획 카드)가 입력창 아래에 가리지 않음
// 자기 스택(lib/localStack.js: 회사 compact-ui 의 BFF + Vite, 8998 · 5398 부터 빈 포트 — RT_API_FROM · RT_WEB_FROM)을 띄우고 지운다.
// 가짜 모델(8996)과 가짜 deepagents(8997 — 할 일을 쓰고 오래 조용함: 「멈추기」 전까지 턴이 이어짐)는 이 파일이 띄운다. 실제 모델 · 에이전트는 부르지 않는다.
//   cd e2e && npx playwright test --project=feature tests/feature/compact-composer.spec.js
import { test, expect } from '@playwright/test'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { startStack, REPO } from '../../lib/localStack.js'

test.describe.configure({ mode: 'serial' })
const SHOTS = path.join(REPO, 'openspec/specs/turn-plan/e2e/results')
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ko-KR' }
const DESK = { viewport: { width: 1280, height: 860 }, locale: 'ko-KR' }
const NOWHERE = 'http://127.0.0.1:9'
const TENANT = 'compact-ui'
const LLM_PORT = Number(process.env.RT_FAKE_LLM_PORT || 8996)
const AGENT_PORT = Number(process.env.RT_FAKE_AGENT_PORT || 8997)
// the bottom area on a 390 px phone before this change, measured the same way (scratchpad shots, main 0d32fe9): the pill row 38 + 12,
// the chip row 30 + 6, the box 48 and 32 under it
const BEFORE_PX = 166

// ---- the fake model: the front plan, the router (DELEGATE), a title ----
const FRONT = { understood: '앞서 정리한 교육 과정 내용으로 새 프로젝트를 만들고 싶으신 것으로 이해했어요.', steps: ['정리한 내용 읽기', '프로젝트 범위 정하기', '프로젝트 기본 틀 만들기'], tier: 'light', certainty: 'sure' }
const textOf = (b) => (b.messages || []).map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n')
function answerLlm(b) {
  const sys = String(b.messages?.[0]?.content || '')
  if (b.logprobs) {
    const options = [...textOf(b).matchAll(/^([A-Z])\) (.+)$/gm)].map((m) => m[1])
    const pick = options.at(-1) || 'A'
    return { body: { choices: [{ message: { content: pick }, logprobs: { content: [{ token: pick, logprob: Math.log(0.9), top_logprobs: [{ token: pick, logprob: Math.log(0.9) }] }] } }] } }
  }
  if (sys.includes('what you understood and how the work will go')) return { delay: 150, content: JSON.stringify(FRONT) }
  if (b.tools) return { delay: 100, content: 'DELEGATE' }
  if (/제목을|A title for/.test(sys)) return { content: '교육 과정' }
  return { content: b.response_format ? '{}' : 'OK' }
}
// ---- the fake deepagents: its to-dos, then quiet until the turn is stopped (a message with "quick": the answer at once) ----
const ANSWER = '교육 과정 초안을 정리했어요.\n1. 1일차: 생성형 AI 이해\n2. 2일차: 바이브 코딩 실습\n3. 3일차: 팀 과제와 발표'
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms))
async function runAgent(body, res) {
  const quick = /quick/.test(String(body.message || ''))
  const say = (o) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(o)}\n\n`) }
  if (body.conversation_id) res.write(`event: metadata\ndata: ${JSON.stringify({ conversation_id: body.conversation_id })}\n\n`)
  await sleep(quick ? 200 : 800)
  say({ type: 'plan_todos', todos: FRONT.steps.map((content, i) => ({ content, status: i === 0 ? 'in_progress' : 'pending' })) })
  await sleep(quick ? 200 : 180_000)
  say({ type: 'token', content: ANSWER })
  say({ type: 'done', content: ANSWER })
  res.end()
}

let servers = []
const listen = (srv, port) => new Promise((ok, no) => srv.once('error', no).listen(port, '127.0.0.1', () => { servers.push(srv); ok() }))
let S, HY

test.beforeAll(async () => {
  test.setTimeout(240_000)
  fs.mkdirSync(SHOTS, { recursive: true })
  await listen(http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', async () => {
      let b = {}
      try { b = JSON.parse(raw) } catch { /* not json */ }
      const r = answerLlm(b)
      if (r.delay) await sleep(r.delay)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(r.body || { choices: [{ message: { role: 'assistant', content: r.content }, finish_reason: 'stop' }] }))
    })
  }), LLM_PORT)
  await listen(http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      if (!req.url.startsWith('/chat/stream')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(req.url.startsWith('/chat/stop') ? '{"stopped":false}' : '[]') }
      let body = {}
      try { body = JSON.parse(raw) } catch { /* not json */ }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      runAgent(body, res).catch(() => res.end())
    })
  }), AGENT_PORT)
  S = await startStack({ tenant: TENANT, apiFrom: Number(process.env.RT_API_FROM || 8998), webFrom: Number(process.env.RT_WEB_FROM || 5398), env: {
    PRO_LLM_BASE_URL: `http://127.0.0.1:${LLM_PORT}/v1`, PRO_LLM_API_KEY: 'fake', PRO_LLM_KEYS: 'off',
    PRO_LLM_MODEL: 'main-fake', PRO_LLM_FAST_MODEL: 'fast-fake', PRO_LLM_FRONT_MODEL: 'front-fake', PRO_LLM_ODDS_MODEL: 'fast-fake',
    PRO_DEEPAGENTS_URL: `http://127.0.0.1:${AGENT_PORT}`, PRO_CONTEXT_ROUTER_URL: NOWHERE, PRO_COMPLETION_URL: NOWHERE, PRO_JUDGE_URL: NOWHERE, PRO_EMBED_URL: '',
  } })
  HY = await S.person(`pro-rt-${TENANT}-a@uengine.org`, '정하윤')
  await S.join(HY)
  await S.api(HY.token, '/me/lang', { method: 'PUT', body: { lang: 'ko' } })
  // (a first turn on the new server loads what it reaches lazily)
  const [main] = await S.api(HY.token, '/threads')
  const warm = await fetch(`http://127.0.0.1:${S.apiPort}/api/threads/${main.id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${HY.token}` },
    body: JSON.stringify({ text: '준비 quick' }) })
  await warm.text()
})
test.afterAll(async () => {
  for (const s of servers) await new Promise((ok) => s.close(ok))
  servers = []
  if (S) {
    fs.mkdirSync(path.join(REPO, 'e2e/reports'), { recursive: true })
    fs.writeFileSync(path.join(REPO, 'e2e/reports', `bff-${TENANT}.log`), S.logs.join(''))
    if (HY) {
      await S.q(`delete from pro_messages where thread_id in (select id from pro_threads where user_id=$1)`, [HY.id]).catch(() => {})
      await S.q(`delete from pro_threads where user_id=$1 and kind='project'`, [HY.id]).catch(() => {})
    }
    await S.stop()
  }
})

async function open(browser, opts, { theme = 'light', to = '/chat', tab = '채팅' } = {}) {
  const ctx = await browser.newContext({ ...opts, baseURL: S.web })
  await ctx.addInitScript(([s, th]) => {
    if (window.top !== window) return
    localStorage.setItem('pgpt-pro-session', s)
    localStorage.setItem('pgpt-pro-theme', th)
    localStorage.setItem('pgl-lang', 'ko')
  }, [JSON.stringify(HY.session), theme])
  const p = await ctx.newPage()
  p.errors = []
  p.on('pageerror', (e) => p.errors.push(String(e?.message || e)))
  await p.goto(to)
  // (a phone opens on 홈: the chat is its own tab)
  if (opts === PHONE && tab) await p.locator('.seg button').filter({ hasText: tab }).click()
  await composer(p).locator('textarea').waitFor()
  return p
}
async function clearMain() {
  const [main] = await S.api(HY.token, '/threads')
  await S.api(HY.token, `/threads/${main.id}/stop`, { method: 'POST', body: {} }).catch(() => {})
  await S.q('delete from pro_messages where thread_id=$1', [main.id])
  await S.q('update pro_threads set conversation_id=null, status=null where id=$1', [main.id])
  await S.q('delete from context_threads where tenant_id=$1 and user_id=$2', [TENANT, HY.id]).catch(() => {})
  return main.id
}
// a chat that looks like the recording: an earlier answer (put in before the page opens) …
const seed = (thread) => S.q(`insert into pro_messages(thread_id,role,kind,content) values ($1,'user','text',$2), ($1,'agent','text',$3)`,
  [thread, { text: '가나정밀 신입 교육 3일 과정 초안을 정리해 줘' }, { text: `${ANSWER}\n\n원문 메일을 붙여 주시면 요청 항목과 하나씩 대조해 드릴게요.` }])
// … then the message whose turn runs now, sent by the keyboard's Enter
async function run(p, text = '이 내용을 기반으로 프로젝트를 하나 만들자') {
  const ta = composer(p).locator('textarea')
  await ta.fill(text)
  await ta.press('Enter')
  await expect(p.locator('[data-testid="turn-card"]').last()).toBeVisible({ timeout: 15_000 })
  await expect(p.locator('.foot button.stop')).toBeVisible({ timeout: 10_000 })
}
const composer = (p) => p.locator('.col > .foot [data-test="chat-composer"]').first()
const row = (p) => composer(p).locator('.agentrow')
const pill = (p) => p.locator('[data-testid="chat-working"]')
const stopBtn = (p) => composer(p).locator('.box button.stop')
const chip = (p) => composer(p).locator('[data-test="chat-agent-chip"]')
const calm = (p) => p.evaluate(() => Promise.race([
  Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming?.().iterations !== Infinity).map((a) => a.finished.catch(() => {}))),
  new Promise((ok) => setTimeout(ok, 2000)),
]))
const shot = async (p, name) => { await calm(p); await p.waitForTimeout(250); await p.screenshot({ path: path.join(SHOTS, `${name}.png`) }) }
// how much of the screen's height the chat's bottom part takes: from the top of the highest thing over the composer to the bottom
// (→ {area, top: what is highest — for the log})
const bottomArea = (p) => p.evaluate(() => {
  // (the column's own foot — a plan card in the list has a .foot of its own)
  const foot = document.querySelector('.col > .foot')
  let best = null
  for (const el of foot.querySelectorAll('*')) {
    const cs = getComputedStyle(el), r = el.getBoundingClientRect()
    if (!r.height || !r.width || cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0 || el.closest('.menu, .turn-panel, .pglhint')) continue
    if (!best || r.top < best.top) best = { top: r.top, who: `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}` }
  }
  return { area: Math.round(window.innerHeight - best.top), top: best.who }
})
const bb = async (loc) => { const b = await loc.boundingBox(); expect(b, 'on screen').toBeTruthy(); return b }
const overlaps = (a, b) => a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.height - 0.5 && b.y < a.y + a.height - 0.5
const inScreen = (b, p) => { const v = p.viewportSize(); expect(b.x).toBeGreaterThanOrEqual(-0.5); expect(b.x + b.width).toBeLessThanOrEqual(v.width + 0.5); expect(b.y + b.height).toBeLessThanOrEqual(v.height + 0.5) }
const noSideScroll = async (p) => expect(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)

test('F-CC-01 390px · 처리 중 진행 알약과 「기본」 칩은 입력창 위 한 줄, 「멈추기」는 입력창 안의 ■ — 아래 영역 축소', async ({ browser }) => {
  for (const theme of ['light', 'dark']) {
    await seed(await clearMain())
    const p = await open(browser, PHONE, { theme })
    await run(p)
    // the keyboard down (the message went by the keyboard's Enter: the box still has the focus)
    await composer(p).locator('textarea').blur()
    await expect(composer(p)).toHaveAttribute('data-folded', 'no')
    await expect(pill(p)).toBeVisible()
    await expect(pill(p)).toHaveJSProperty('tagName', 'BUTTON')
    await expect(chip(p)).toBeVisible()
    // (the pill pops in: measured once it has settled)
    await calm(p)
    // one row: the pill and the chip side by side over the box, nothing on another
    const box = await bb(composer(p).locator('.box')), pb = await bb(pill(p)), cb = await bb(chip(p)), sb = await bb(stopBtn(p))
    expect(Math.abs((pb.y + pb.height / 2) - (cb.y + cb.height / 2))).toBeLessThanOrEqual(1.5)
    expect(pb.x + pb.width).toBeLessThanOrEqual(cb.x + 0.5)
    expect(pb.y + pb.height).toBeLessThanOrEqual(box.y)
    expect(overlaps(pb, cb)).toBe(false)
    // 멈추기 is the box's own ■, beside the mic, with the stop's name
    expect(sb.y).toBeGreaterThanOrEqual(box.y - 0.5)
    expect(sb.y + sb.height).toBeLessThanOrEqual(box.y + box.height + 0.5)
    await expect(stopBtn(p)).toHaveAttribute('aria-label', '답 멈추기')
    const mic = await bb(composer(p).getByTestId('composer-mic'))
    expect(sb.x + sb.width).toBeLessThanOrEqual(mic.x + 0.5)
    // no 멈추기 of its own over the composer any more, no 새 패널 ＋ while ■ has its place
    await expect(p.locator('.foot > button.stop')).toHaveCount(0)
    await expect(composer(p).getByRole('button', { name: '새 패널 만들기' })).toHaveCount(0)
    for (const b of [pb, cb, sb, box]) inScreen(b, p)
    await noSideScroll(p)
    const { area, top } = await bottomArea(p)
    console.log(`[F-CC-01] ${theme}: the bottom part while a turn runs ${area}px (before ${BEFORE_PX}px) — its top: ${top}`)
    expect(area).toBeLessThanOrEqual(120)
    await shot(p, `cc-work-phone-${theme}`)
    expect(p.errors).toEqual([])
    await p.context().close()
  }
})

test('F-CC-02 390px · 글을 쓰는 동안 위 줄을 접고 입력창만 표시 — ■는 그대로 유지, 포커스가 벗어나면 다시 한 줄 표시', async ({ browser }) => {
  for (const theme of ['light', 'dark']) {
    await seed(await clearMain())
    const p = await open(browser, PHONE, { theme })
    await run(p)
    const ta = composer(p).locator('textarea')
    await ta.blur()
    await expect(pill(p)).toBeVisible()
    await calm(p)
    const box0 = await bb(composer(p).locator('.box'))
    // typing: the keyboard up
    await ta.tap()
    await ta.pressSequentially('3일 과정으로', { delay: 15 })
    await expect(composer(p)).toHaveAttribute('data-folded', 'yes')
    await expect(row(p)).toHaveCount(0)
    await expect(pill(p)).toHaveCount(0)
    await expect(chip(p)).toHaveCount(0)
    await expect(stopBtn(p)).toBeVisible()
    await expect(stopBtn(p)).toHaveClass(/\bbusy\b/)
    // the send button comes in left of ■; ■ and the mic keep their places
    const send = composer(p).getByRole('button', { name: '보내기' })
    await expect(send).toBeVisible()
    expect((await bb(send)).x + (await bb(send)).width).toBeLessThanOrEqual((await bb(stopBtn(p))).x + 0.5)
    // the box itself does not move
    const box1 = await bb(composer(p).locator('.box'))
    expect(Math.abs(box1.y + box1.height - (box0.y + box0.height))).toBeLessThanOrEqual(1)
    const { area, top } = await bottomArea(p)
    console.log(`[F-CC-02] ${theme}: the bottom part while typing ${area}px (before ${BEFORE_PX}px) — its top: ${top}`)
    expect(area).toBeLessThanOrEqual(90)
    // what the keyboard leaves of a phone's screen (844 → 520): the conversation keeps most of it
    await p.setViewportSize({ width: 390, height: 520 })
    await calm(p)
    await shot(p, `cc-typing-phone-${theme}`)
    // the keyboard goes: the row comes back, the words stay
    await ta.blur()
    await expect(composer(p)).toHaveAttribute('data-folded', 'no')
    await expect(pill(p)).toBeVisible()
    await expect(chip(p)).toBeVisible()
    await expect(ta).toHaveValue('3일 과정으로')
    await ta.fill('')
    expect(p.errors).toEqual([])
    await p.context().close()
  }
})

test('F-CC-03 390px · 기능 접근: 알약 → 진행 상황, 칩 → 에이전트, 📎 → 첨부 · 폴더, 🎤, 키보드로 ■ → 멈춤', async ({ browser }) => {
  const th = await clearMain()
  await seed(th)
  const p = await open(browser, PHONE)
  await run(p)
  await composer(p).locator('textarea').blur()
  // the pill: the progress sheet (지금 · 할 일 · 한 일 · 메모 · its own 멈추기), closed by ✕
  await pill(p).tap()
  const panel = p.getByTestId('turn-panel')
  await expect(panel).toBeVisible()
  await expect(panel.locator('h4')).toHaveText(['지금', '할 일', '한 일', '메모'])
  await expect(panel.getByTestId('turn-panel-stop')).toBeVisible()
  await panel.getByTestId('turn-panel-close').tap()
  await expect(panel).toHaveCount(0)
  // the chip: who answers (기본 · the PC ones), inside the screen
  await chip(p).tap()
  const menu = composer(p).locator('[data-test="chat-agent-menu"]')
  await expect(menu).toBeVisible()
  await expect(menu.locator('[data-test="chat-agent-option"]').first()).toHaveAttribute('data-agent', 'default')
  inScreen(await bb(menu), p)
  await p.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  // 📎: 파일 첨부 · 폴더 붙이기
  await composer(p).getByTestId('composer-clip').tap()
  await expect(composer(p).getByRole('menuitem', { name: '파일 첨부' })).toBeVisible()
  await expect(composer(p).getByRole('menuitem', { name: '폴더 붙이기' })).toBeVisible()
  await p.locator('.msgs').tap({ position: { x: 20, y: 200 } })
  await expect(composer(p).getByRole('menuitem', { name: '파일 첨부' })).toHaveCount(0)
  // 🎤 is there, with its name
  await expect(composer(p).getByTestId('composer-mic')).toHaveAttribute('aria-label', '받아쓰기 시작')
  // ■ by the keyboard: Tab from the box reaches it by its name, Enter stops the turn
  await composer(p).locator('textarea').focus()
  let reached = false
  for (let i = 0; i < 6 && !reached; i++) {
    await p.keyboard.press('Tab')
    reached = await p.evaluate(() => document.activeElement?.getAttribute('aria-label') === '답 멈추기')
  }
  expect(reached, 'Tab reaches 답 멈추기').toBe(true)
  const [res] = await Promise.all([p.waitForResponse((r) => r.url().includes(`/api/threads/${th}/stop`)), p.keyboard.press('Enter')])
  expect(res.status()).toBe(200)
  await expect(p.locator('.row.r-agent .bubble.agent').last()).toContainText('멈췄어요', { timeout: 10_000 })
  await expect(stopBtn(p)).toHaveCount(0, { timeout: 10_000 })
  await expect(pill(p)).toHaveCount(0)
  // the turn over: 새 패널 ＋ is back in ■'s place
  await expect(composer(p).getByRole('button', { name: '새 패널 만들기' })).toBeVisible()
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-CC-04 1280px · 알약만 입력창 위, 칩 · ■는 입력창 안, 패널은 그 줄 위 — 마우스를 사용하는 화면에서는 포커스가 있어도 위 줄 유지', async ({ browser }) => {
  for (const theme of ['light', 'dark']) {
    await seed(await clearMain())
    const p = await open(browser, DESK, { theme })
    await run(p)
    await calm(p)
    const box = await bb(composer(p).locator('.box'))
    await expect(composer(p)).toHaveAttribute('data-tight', 'no')
    // (the message went by Enter: the box has the focus — a mouse screen keeps the row)
    await expect(composer(p).locator('textarea')).toBeFocused()
    await expect(composer(p)).toHaveAttribute('data-folded', 'no')
    const pb = await bb(pill(p))
    expect(pb.y + pb.height).toBeLessThanOrEqual(box.y)
    await expect(composer(p).locator('.box [data-test="chat-agent"]')).toHaveCount(1)
    await expect(composer(p).locator('.agentrow [data-test="chat-agent"]')).toHaveCount(0)
    const sb = await bb(stopBtn(p))
    expect(sb.y).toBeGreaterThanOrEqual(box.y - 0.5)
    expect(sb.x + sb.width).toBeLessThanOrEqual(box.x + box.width + 0.5)
    await shot(p, `cc-work-desktop-${theme}`)
    // the panel opens over the row, clear of the box and the pill
    await pill(p).click()
    const panel = p.getByTestId('turn-panel')
    await expect(panel).toBeVisible()
    await calm(p)
    const qb = await bb(panel)
    expect(qb.y + qb.height).toBeLessThanOrEqual(pb.y + 0.5)
    expect(Math.round(qb.width)).toBe(420)
    if (theme === 'light') await shot(p, 'cc-panel-desktop-light')
    await panel.getByTestId('turn-panel-close').click()
    // a narrow box with a mouse (a docked messenger squeezes it — F-CA-09): the chip goes over the box, focus folds nothing
    await p.addStyleTag({ content: '[data-test=chat-composer]{ width: 420px !important; }' })
    await composer(p).locator('textarea').focus()
    await expect(composer(p)).toHaveAttribute('data-tight', 'yes')
    await expect(composer(p)).toHaveAttribute('data-folded', 'no')
    await expect(pill(p)).toBeVisible()
    await expect(composer(p).locator('.agentrow [data-test="chat-agent"]')).toBeVisible()
    await noSideScroll(p)
    expect(p.errors).toEqual([])
    await p.context().close()
  }
})

test('F-CC-05 390px · 프로젝트 방과 휴대폰 홈 입력창도 같은 모양, 마지막 계획 카드가 입력창에 가려지지 않음', async ({ browser }) => {
  // a project's room: the same chat column
  const [{ id }] = await S.q(`insert into pro_threads(user_id,kind,title) values ($1,'project','신입 교육 과정') returning id`, [HY.id])
  await seed(id)
  const p = await open(browser, PHONE, { to: `/projects/${id}`, tab: null })
  await run(p, '이 과정을 3일 일정으로 나눠 줘')
  await composer(p).locator('textarea').blur()
  await expect(pill(p)).toBeVisible()
  await expect(stopBtn(p)).toBeVisible()
  await expect(chip(p)).toBeVisible()
  // the plan card's last line (자세히) stays above the row over the box when the chat is at its bottom
  const more = p.getByTestId('turn-details').last()
  await expect(more).toBeVisible()
  await calm(p)
  const mb = await bb(more), rb = await bb(row(p))
  expect(mb.y + mb.height).toBeLessThanOrEqual(rb.y + 0.5)
  console.log(`[F-CC-05] project: the bottom part ${(await bottomArea(p)).area}px`)
  await shot(p, 'cc-work-project-phone-light')
  // typing folds here too
  await composer(p).locator('textarea').tap()
  await expect(composer(p)).toHaveAttribute('data-folded', 'yes')
  await expect(pill(p)).toHaveCount(0)
  await expect(stopBtn(p)).toBeVisible()
  await composer(p).locator('textarea').blur()
  await stopBtn(p).tap()
  await expect(stopBtn(p)).toHaveCount(0, { timeout: 10_000 })
  expect(p.errors).toEqual([])
  await p.context().close()

  // the phone's Home composer: only the chip over the box — folded while typing
  const h = await browser.newContext({ ...PHONE, baseURL: S.web })
  await h.addInitScript((s) => { if (window.top === window) localStorage.setItem('pgpt-pro-session', s) }, JSON.stringify(HY.session))
  const hp = await h.newPage()
  hp.errors = []
  hp.on('pageerror', (e) => hp.errors.push(String(e?.message || e)))
  await hp.goto('/chat')
  const home = hp.locator('.mfoot [data-test="chat-composer"]')
  await expect(home).toBeVisible({ timeout: 20_000 })
  await expect(home.locator('.agentrow [data-test="chat-agent"]')).toBeVisible()
  await home.locator('textarea').tap()
  await expect(home).toHaveAttribute('data-folded', 'yes')
  await expect(home.locator('.agentrow')).toHaveCount(0)
  await home.locator('textarea').blur()
  await expect(home.locator('.agentrow [data-test="chat-agent"]')).toBeVisible()
  expect(hp.errors).toEqual([])
  await h.close()
})
