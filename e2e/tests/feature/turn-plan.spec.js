// 계획 카드와 진행 상황 — 실행 중 화면이 멈춘 것처럼 보이지 않는다 (스펙 openspec/specs/turn-plan, 설계 turnplan P0, 서버 lib/turnPlan.js).
// 사용자(2026-11-25): 「입력을 주면 일단 의도파악과 어떤식으로 일을 할지 퀵하게 먼저 알려주는 단계가 필요해보이는데, 지금은 그냥 실행하는중....으로
// 만... 그걸 누르면 상세한 진행상황이 보이던가...」 · 「지금 같은 경우는 3분이 지났는데.. 화면이 이꼴임. 사용자 입장에서는 뭐하는건지... 기다릴
// 의욕이 없어지는」.
//   F-TP-01 링크만 보내면 4초 안에 메시지 아래 카드: 이해한 한 문장(한국어) · 단계 2~4개, 에이전트 글보다 먼저
//   F-TP-02 앞단 계획이 4초 안에 오지 않으면 「요청을 받았어요. 바로 살펴볼게요.」, 턴은 이어감
//   F-TP-03 라우터가 오류를 내거나 6초를 넘기면 에이전트가 맡고, 「이 요청을 처리하지 못했어요」는 없음
//   F-TP-04 plan_todos 가 오면 카드의 단계가 그 목록으로, 끝난 항목은 새로고침 없이 체크
//   F-TP-05 짧은 문장 뒤 도구 호출: 그 문장은 진행 상황의 메모에, 저장된 답에는 없음
//   F-TP-06 알약을 누르면 지금 · 할 일 · 한 일 · 메모 패널, 390px 에서는 아래 시트이고 「멈추기」가 다 보임
//   F-TP-07 도구가 끝나고 5초 넘게 소식이 없으면 「다음 단계를 쓰는 중」과 늘어나는 초
//   F-TP-08 라우터가 답하기 전에 「멈추기」 → 아무 처리도 시작하지 않고 「멈췄어요」
//   F-TP-09 턴 도중 새로고침 → 카드와 패널이 같은 계획 · 단계로 돌아옴
//   F-TP-10 영어 화면: 카드 · 패널의 모든 글과 이해한 문장이 영어
//   F-TP-11 턴이 끝나면 답 위에 접힌 「계획 N/N · 시간」 줄, 펼치면 계획
//   F-TP-12 한국어 화면에서 링크만 보낸 턴: 에이전트에게 가는 메시지에 한국어 언어 지시(과 계획 블록)
// 자기 스택(lib/localStack.js: 회사 turnplan-ui 의 BFF + Vite, 8945 · 5345 부터 빈 포트)을 띄우고 지운다. 가짜 모델(8946)과 가짜 deepagents(8947)는
// 이 파일이 띄운다 — 실제 모델 · 에이전트는 부르지 않는다. 가짜 deepagents 는 plan_todos, 짧은 글 뒤 도구 호출, 5초 넘는 쉼, done 을 보낸다.
//   cd e2e && npx playwright test --project=feature tests/feature/turn-plan.spec.js
import { test, expect } from '@playwright/test'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { startStack, REPO } from '../../lib/localStack.js'

test.describe.configure({ mode: 'serial' })
const SHOTS = path.join(REPO, 'openspec/specs/turn-plan/e2e/results')
const DESK = { viewport: { width: 1280, height: 860 }, locale: 'ko-KR' }
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ko-KR' }
const NOWHERE = 'http://127.0.0.1:9'
const TENANT = 'turnplan-ui'
const LLM_PORT = Number(process.env.RT_FAKE_LLM_PORT || 8946)
const AGENT_PORT = Number(process.env.RT_FAKE_AGENT_PORT || 8947)
const PAUSE_MS = 16_000

// ---- the fake model: the front plan (JSON, in the language the prompt asks for), the router (DELEGATE), odds readings ----
const llm = { front: [], router: [] }
const FRONT_KO = { understood: '링크의 글을 읽고 핵심을 요약해 드릴게요.', steps: ['링크의 글 읽기', '핵심을 세 줄로 정리', '요약 전달'], tier: 'light', certainty: 'sure' }
const FRONT_EN = { understood: 'You want a short summary of the article at this link.', steps: ['Read the linked article', 'Pick out the key points', 'Send the summary'], tier: 'light', certainty: 'sure' }
const textOf = (b) => (b.messages || []).map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n')
// the message being decided now (markers are read there, not in the earlier messages the call also carries)
const nowOf = (b, front) => { const t = String(b.messages?.at(-1)?.content || ''); return front ? t.split('The message now:').pop() : t }
async function answerLlm(b) {
  const all = textOf(b)
  const sys = String(b.messages?.[0]?.content || '')
  if (b.logprobs) {
    // (an odds reading: the last option — "none of these" / "something new")
    const options = [...all.matchAll(/^([A-Z])\) (.+)$/gm)].map((m) => m[1])
    const pick = options.at(-1) || 'A'
    return { body: { choices: [{ message: { content: pick }, logprobs: { content: [{ token: pick, logprob: Math.log(0.9), top_logprobs: [{ token: pick, logprob: Math.log(0.9) }, { token: options[0] || 'B', logprob: Math.log(0.05) }] }] } }] } }
  }
  if (sys.includes('what you understood and how the work will go')) {
    const en = /LANGUAGE: English/.test(sys)
    llm.front.push({ model: b.model, at: Date.now(), en, text: all })
    // a front model that does not answer in time — both of them (the front model and the fast one it falls back to)
    const delay = nowOf(b, true).includes('slow-front') ? 6500 : 250
    return { delay, content: JSON.stringify(en ? FRONT_EN : FRONT_KO) }
  }
  if (b.tools) {
    const now = nowOf(b)
    llm.router.push({ at: Date.now(), text: now })
    if (now.includes('router-500')) return { status: 500 }
    if (now.includes('slow-router')) return { delay: 8000, content: 'DELEGATE' }
    if (now.includes('stop-router')) return { delay: 10_000, content: 'DELEGATE' }
    return { delay: 150, content: 'DELEGATE' }
  }
  if (/제목을|A title for/.test(sys)) return { content: '요약' }
  return { content: b.response_format ? '{}' : 'OK' }
}

// ---- the fake deepagents: plan_todos, a short sentence and then a tool call, a pause of 16 s, the answer and done ----
// (a link with "quick" in it: the same events with short gaps; with "short": a pause of 3 s)
const agent = { bodies: [] }
const ANSWER_KO = '요약했어요.\n- 에이전트에게는 계획이 먼저 필요해요.\n- 계획은 할 일 목록으로 남겨요.\n- 사람에게는 진행 상황을 보여 줘요.'
const ANSWER_EN = 'Here is the summary.\n- Agents need a plan first.\n- The plan is kept as a to-do list.\n- People are shown the progress.'
const INTERIM_KO = '먼저 링크의 글을 열어 볼게요.'
const INTERIM_EN = 'Let me open the linked article first.'
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms))
async function runAgent(body, res) {
  const msg = String(body.message || '')
  const en = body.metadata?.language === 'en'
  const url = /https?:\/\/[^\s)]+/.exec(msg)?.[0] || 'https://news.example.com/'
  // (the markers are read in the link only: the plan and the language note after it are words too — "a short summary")
  const quick = /quick/.test(url)
  const say = (o) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(o)}\n\n`) }
  const todos = (states) => (en ? FRONT_EN.steps : FRONT_KO.steps).map((content, i) => ({ content, status: states[i] }))
  if (body.conversation_id) res.write(`event: metadata\ndata: ${JSON.stringify({ conversation_id: body.conversation_id })}\n\n`)
  await sleep(quick ? 300 : 1500)
  say({ type: 'plan_todos', todos: todos(['in_progress', 'pending', 'pending']) })
  await sleep(quick ? 100 : 600)
  say({ type: 'token', content: en ? INTERIM_EN : INTERIM_KO })
  await sleep(quick ? 100 : 300)
  say({ type: 'plan_tools', tools: [{ tool: 'fetch_url', name: 'fetch_url', args: { url } }] })
  say({ type: 'tool_start', tool: 'fetch_url', input: { url } })
  await sleep(quick ? 100 : 500)
  say({ type: 'tool_end', tool: 'fetch_url', output: '<html>…</html>' })
  await sleep(quick ? 50 : 300)
  say({ type: 'plan_todos', todos: todos(['completed', 'in_progress', 'pending']) })
  await sleep(quick ? 600 : /short/.test(url) ? 3000 : PAUSE_MS)
  const answer = en ? ANSWER_EN : ANSWER_KO
  say({ type: 'token', content: answer.slice(0, 20) })
  say({ type: 'token', content: answer.slice(20) })
  say({ type: 'plan_todos', todos: todos(['completed', 'completed', 'completed']) })
  say({ type: 'done', content: answer })
  res.end()
}

let servers = []
const listen = (srv, port) => new Promise((ok, no) => srv.once('error', no).listen(port, '127.0.0.1', () => { servers.push(srv); ok() }))
let S, KO, EN

test.beforeAll(async () => {
  test.setTimeout(240_000)
  fs.mkdirSync(SHOTS, { recursive: true })
  await listen(http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', async () => {
      let b = {}
      try { b = JSON.parse(raw) } catch { /* not json */ }
      const r = await answerLlm(b)
      let gone = false
      res.on('close', () => { gone = true })
      if (r.delay) await sleep(r.delay)
      if (gone) return
      if (r.status) { res.writeHead(r.status, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'fake failure' } })) }
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
      agent.bodies.push({ at: Date.now(), body })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      runAgent(body, res).catch(() => res.end())
    })
  }), AGENT_PORT)
  S = await startStack({ tenant: TENANT, apiFrom: 8945, webFrom: 5345, env: {
    PRO_LLM_BASE_URL: `http://127.0.0.1:${LLM_PORT}/v1`, PRO_LLM_API_KEY: 'fake', PRO_LLM_KEYS: 'off',
    PRO_LLM_MODEL: 'main-fake', PRO_LLM_FAST_MODEL: 'fast-fake', PRO_LLM_FRONT_MODEL: 'front-fake', PRO_LLM_ODDS_MODEL: 'fast-fake',
    PRO_DEEPAGENTS_URL: `http://127.0.0.1:${AGENT_PORT}`, PRO_CONTEXT_ROUTER_URL: NOWHERE, PRO_COMPLETION_URL: NOWHERE, PRO_JUDGE_URL: NOWHERE, PRO_EMBED_URL: '',
  } })
  KO = await S.person(`pro-rt-${TENANT}-a@uengine.org`, '윤가람')
  EN = await S.person(`pro-rt-${TENANT}-b@uengine.org`, 'Mira Song')
  for (const p of [KO, EN]) await S.join(p)
  await S.api(KO.token, '/me/lang', { method: 'PUT', body: { lang: 'ko' } })
  await S.api(EN.token, '/me/lang', { method: 'PUT', body: { lang: 'en' } })
  // a first turn on the new server (its first chat turn loads the modules it reaches lazily): not one of the measured ones
  const [main] = await S.api(KO.token, '/threads')
  const warm = await fetch(`http://127.0.0.1:${S.apiPort}/api/threads/${main.id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KO.token}` },
    body: JSON.stringify({ text: 'https://news.example.com/posts/warm-up-quick' }) })
  await warm.text()
})
test.afterAll(async () => {
  for (const s of servers) await new Promise((ok) => s.close(ok))
  servers = []
  if (S) {
    // the BFF's own log of this run (the plan's model and time, the router's decision), next to the report
    fs.mkdirSync(path.join(REPO, 'e2e/reports'), { recursive: true })
    fs.writeFileSync(path.join(REPO, 'e2e/reports', `bff-${TENANT}.log`), S.logs.join(''))
    for (const p of [KO, EN].filter(Boolean)) await S.q(`delete from pro_messages where thread_id in (select id from pro_threads where user_id=$1)`, [p.id]).catch(() => {})
    await S.stop()
  }
})

// a page signed in as `who` (the main chat), in a theme and a language
async function open(browser, who, opts, { theme = 'light', lang = 'ko' } = {}) {
  const ctx = await browser.newContext({ ...opts, baseURL: S.web })
  await ctx.addInitScript(([s, th, l]) => {
    if (window.top !== window) return
    localStorage.setItem('pgpt-pro-session', s)
    localStorage.setItem('pgpt-pro-theme', th)
    localStorage.setItem('pgl-lang', l)
  }, [JSON.stringify(who.session), theme, lang])
  const p = await ctx.newPage()
  p.errors = []
  p.on('pageerror', (e) => p.errors.push(String(e?.message || e)))
  await toChat(p, opts === PHONE, lang)
  return p
}
async function toChat(p, phone, lang = 'ko') {
  await p.goto('/chat')
  if (phone) await p.locator('.seg button').filter({ hasText: lang === 'en' ? 'Chat' : '채팅' }).click()
  await p.locator('[data-test="chat-composer"] textarea').last().waitFor()
}
async function clearMain(who) {
  const [main] = await S.api(who.token, '/threads')
  await S.q('delete from pro_messages where thread_id=$1', [main.id])
  await S.q('update pro_threads set conversation_id=null, status=null where id=$1', [main.id])
  await S.q('delete from context_threads where tenant_id=$1 and user_id=$2', [TENANT, who.id]).catch(() => {})
  return main.id
}
async function send(p, text) {
  const ta = p.locator('[data-test="chat-composer"] textarea').last()
  await ta.fill(text)
  const t0 = Date.now()
  await ta.press('Enter')
  return t0
}
const card = (p) => p.locator('[data-testid="turn-card"]').last()
// (the pill slides when its text changes: the one leaving is not it)
const pill = (p) => p.locator('[data-testid="chat-working"]:not(.pill-leave-active)')
const panel = (p) => p.locator('[data-testid="turn-panel"]')
const lastAnswer = (p) => p.locator('.row.r-agent.k-text').last()
// the panel's opening animation (it scales in) is over before anything is measured
const calm = (p) => p.evaluate(() => Promise.race([
  Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming?.().iterations !== Infinity).map((a) => a.finished.catch(() => {}))),
  new Promise((ok) => setTimeout(ok, 2000)),
]))
const shot = async (p, name) => { await calm(p); await p.waitForTimeout(200); await p.screenshot({ path: path.join(SHOTS, `${name}.png`) }) }
const bodyFor = (marker) => agent.bodies.filter((x) => String(x.body.message || '').includes(marker))
const inView = async (loc, p) => {
  const b = await loc.boundingBox()
  const v = p.viewportSize()
  expect(b, 'on screen').toBeTruthy()
  expect(b.x).toBeGreaterThanOrEqual(-0.5)
  expect(b.y).toBeGreaterThanOrEqual(-0.5)
  expect(b.x + b.width).toBeLessThanOrEqual(v.width + 0.5)
  expect(b.y + b.height).toBeLessThanOrEqual(v.height + 0.5)
}
const HANGUL = /[가-힣]/

// ---------- one long turn on the desktop (light): F-TP-01 · 04 · 05 · 06 · 07 · 09 · 11 · 12 ----------
let A, aSent, aUrl
test('F-TP-01 링크만 보내면 4초 안에 메시지 아래 카드 — 이해한 한 문장(한국어) · 단계 2~4개, 에이전트 글보다 먼저', async ({ browser }) => {
  await clearMain(KO)
  A = await open(browser, KO, DESK)
  aUrl = `https://news.example.com/posts/agents-need-plans-${Date.now().toString(36)}`
  aSent = await send(A, aUrl)
  const understood = A.locator('[data-testid="turn-understood"]').last()
  await expect(understood).toBeVisible({ timeout: 4000 })
  const ms = Date.now() - aSent
  console.log(`[F-TP-01] card with the plan ${ms} ms after Enter`)
  expect(ms).toBeLessThan(4000)
  const said = await understood.innerText()
  expect(said).toMatch(HANGUL)
  expect(said).toBe(FRONT_KO.understood)
  const n = await card(A).locator('[data-testid="turn-step"]').count()
  expect(n).toBeGreaterThanOrEqual(2)
  expect(n).toBeLessThanOrEqual(4)
  // under the person's message (the user row is the card's nearest message above it)
  const above = await card(A).evaluate((el) => { let x = el.previousElementSibling; while (x && !x.classList.contains('row')) x = x.previousElementSibling; return x ? { user: x.classList.contains('r-user'), text: x.innerText } : null })
  expect(above?.user).toBe(true)
  expect(above.text).toContain(aUrl)
  // before any agent text: no answer bubble, no streamed draft
  expect(await A.locator('.row.r-agent .bubble').count()).toBe(0)
  expect(await A.locator('.inner > div.row:not([data-id]) > .bubble.md').count()).toBe(0)
  // the pill is a button with the stage and the time; 멈추기 beside it
  await expect(pill(A)).toHaveJSProperty('tagName', 'BUTTON')
  await expect(A.locator('.foot button.stop')).toBeVisible()
  await shot(A, 'tp-card-desktop-light')
})

test('F-TP-04 plan_todos 가 오면 카드의 단계가 그 목록으로, 끝난 항목은 새로고침 없이 체크', async () => {
  const steps = card(A).locator('[data-testid="turn-step"]')
  // the agent's first list: the first item active
  await expect(steps.first()).toHaveAttribute('data-state', 'active', { timeout: 8000 })
  await expect(steps.locator('.txt')).toHaveText(FRONT_KO.steps)
  // its second list: the first item done — a check, no reload
  await expect(steps.first()).toHaveAttribute('data-state', 'done', { timeout: 8000 })
  await expect(steps.first().locator('svg')).toBeVisible()
  await expect(steps.nth(1)).toHaveAttribute('data-state', 'active')
  await expect(card(A).locator('[data-testid="turn-count"]')).toHaveText('계획 1/3')
  await expect(card(A).locator('[data-testid="turn-handler"]')).toHaveText('에이전트')
})

test('F-TP-05 · F-TP-06 짧은 문장 뒤 도구 호출 → 메모에 · 알약을 누르면 지금 · 할 일 · 한 일 · 메모 패널', async () => {
  await pill(A).click()
  await expect(panel(A)).toBeVisible()
  for (const id of ['turn-now', 'turn-todos', 'turn-done', 'turn-notes']) await expect(panel(A).locator(`[data-testid="${id}"]`)).toBeVisible()
  await expect(panel(A).locator('h4')).toHaveText(['지금', '할 일', '한 일', '메모'])
  await expect(panel(A).locator('[data-testid="turn-note"]')).toHaveText([INTERIM_KO], { timeout: 5000 })
  await expect(panel(A).locator('[data-testid="turn-done"] li').first()).toContainText('news.example.com')
  await expect(panel(A).locator('[data-testid="turn-todos"] li[data-state="done"]')).toHaveCount(1)
  // the short sentence never became the answer bubble
  expect(await A.locator('.inner > div.row:not([data-id]) > .bubble.md').count()).toBe(0)
  await calm(A)
  await inView(panel(A).locator('[data-testid="turn-panel-stop"]'), A)
  const box = await panel(A).boundingBox()
  expect(Math.round(box.width)).toBe(420)
  await shot(A, 'tp-panel-desktop-light')
})

test('F-TP-07 도구가 끝나고 5초 넘게 소식이 없으면 「다음 단계를 쓰는 중」과 늘어나는 초', async () => {
  const live = card(A).locator('[data-testid="turn-live"]')
  await expect(live).toHaveText(/^다음 단계를 쓰는 중 · \d+초$/, { timeout: 9000 })
  const a = Number(/(\d+)초$/.exec(await live.innerText())[1])
  expect(a).toBeGreaterThanOrEqual(5)
  await A.waitForTimeout(2100)
  const b = Number(/(\d+)초$/.exec(await live.innerText())[1])
  expect(b).toBeGreaterThanOrEqual(a + 2)
  // the panel's 지금 says it too
  await expect(panel(A).locator('[data-testid="turn-now"]')).toContainText('다음 단계를 쓰는 중')
})

test('F-TP-09 턴 도중 새로고침 → 카드와 패널이 같은 계획 · 단계로 돌아옴', async () => {
  const before = { understood: await A.locator('[data-testid="turn-understood"]').last().innerText(), steps: await card(A).locator('[data-testid="turn-step"] .txt').allInnerTexts() }
  // (still inside the agent's pause)
  expect(Date.now() - aSent).toBeLessThan(PAUSE_MS)
  await A.reload()
  await A.locator('[data-test="chat-composer"] textarea').last().waitFor()
  await expect(A.locator('[data-testid="turn-understood"]').last()).toHaveText(before.understood, { timeout: 8000 })
  await expect(card(A).locator('[data-testid="turn-step"] .txt')).toHaveText(before.steps)
  await expect(card(A).locator('[data-testid="turn-step"]').first()).toHaveAttribute('data-state', 'done')
  await expect(card(A).locator('[data-testid="turn-live"]')).toHaveText(/다음 단계를 쓰는 중 · \d+초/)
  await pill(A).click()
  await expect(panel(A).locator('[data-testid="turn-note"]')).toHaveText([INTERIM_KO])
  await expect(panel(A).locator('[data-testid="turn-todos"] li')).toHaveText(FRONT_KO.steps.map((x) => new RegExp(x)))
  await expect(panel(A).locator('[data-testid="turn-done"] li').first()).toContainText('news.example.com')
})

test('F-TP-11 · F-TP-05 턴이 끝나면 답 위에 접힌 「계획 3/3 · 시간」, 펼치면 계획 · 저장된 답에는 중간 글이 없음', async () => {
  await expect(card(A)).toHaveCount(0, { timeout: PAUSE_MS + 8000 })
  await expect(panel(A)).toHaveCount(0)
  const ans = lastAnswer(A)
  await expect(ans.locator('.bubble.agent')).toContainText('요약했어요.')
  await expect(ans.locator('.bubble.agent')).not.toContainText(INTERIM_KO)
  const fold = ans.locator('[data-testid="plan-fold"]')
  await expect(fold).toHaveText(/^계획 3\/3 · \d+초/)
  await shot(A, 'tp-folded-desktop-light')
  await fold.click()
  const body = ans.locator('[data-testid="plan-body"]')
  await expect(body).toContainText(FRONT_KO.understood)
  await expect(body.locator('ol li')).toHaveText(FRONT_KO.steps.map((s) => new RegExp(s)))
  await expect(body).toContainText(INTERIM_KO)
  // the saved row: content.plan · content.notes, the answer is done.content
  const [m] = await S.q(`select content from pro_messages where thread_id=(select id from pro_threads where user_id=$1 and kind='chat' limit 1) and role='agent' and kind='text' order by created_at desc limit 1`, [KO.id])
  expect(m.content.text).toBe(ANSWER_KO)
  expect(m.content.plan.state).toBe('done')
  expect(m.content.plan.steps.map((s) => s.state)).toEqual(['done', 'done', 'done'])
  expect(m.content.notes).toEqual([INTERIM_KO])
  expect(A.errors).toEqual([])
})

test('F-TP-12 한국어 화면에서 링크만 보낸 턴: 에이전트에게 가는 메시지에 한국어 언어 지시와 계획', async () => {
  const [x] = bodyFor(aUrl)
  expect(x, 'the agent got the turn').toBeTruthy()
  expect(x.body.message).toContain('[Instruction] 언어: 한국어')
  // (only because the message has no words of its own — review 11-25 #6; a worded message keeps its language: TP-I-06)
  expect(x.body.message).toContain('말이 없어(링크나 파일뿐)')
  expect(x.body.message).toContain(`[계획] ${FRONT_KO.understood}\n1. 링크의 글 읽기\n2. 핵심을 세 줄로 정리\n3. 요약 전달`)
  // the agreement for leaving the plan reaches the agent (decision 2026-11-28 — the tool named, no write_todos)
  expect(x.body.message).toContain('계획대로 할 수 없을 때:')
  expect(x.body.message).toContain('request_human_input 도구로')
  expect(x.body.message).not.toContain('write_todos')
  expect(x.body.metadata.language).toBe('ko')
  // (the person's words first, the plan and the language after them)
  expect(x.body.message.indexOf(aUrl)).toBeLessThan(x.body.message.indexOf('[계획]'))
  await A.context().close()
})

test('F-TP-02 앞단 계획이 4초 안에 오지 않으면 「요청을 받았어요. 바로 살펴볼게요.」, 턴은 이어감', async ({ browser }) => {
  await clearMain(KO)
  const p = await open(browser, KO, DESK)
  const url = `https://news.example.com/posts/slow-front-short-${Date.now().toString(36)}`
  const t0 = await send(p, url)
  // reading first
  await expect(card(p)).toHaveAttribute('data-state', 'reading', { timeout: 3000 })
  const understood = p.locator('[data-testid="turn-understood"]').last()
  await expect(understood).toHaveText('요청을 받았어요. 바로 살펴볼게요.', { timeout: 6000 })
  const ms = Date.now() - t0
  console.log(`[F-TP-02] fallback sentence ${ms} ms after Enter`)
  expect(ms).toBeGreaterThan(3500)
  // the front model and then the fast one were asked (the fallback race)
  const asked = llm.front.filter((c) => c.text.includes(url)).map((c) => c.model)
  expect(asked).toEqual(['front-fake', 'fast-fake'])
  // the turn goes on: the agent's to-dos fill the card, and the answer comes
  await expect(card(p).locator('[data-testid="turn-step"] .txt')).toHaveText(FRONT_KO.steps, { timeout: 8000 })
  await expect(lastAnswer(p).locator('.bubble.agent')).toContainText('요약했어요.', { timeout: 15000 })
  // no plan block to the agent after a fallback
  expect(bodyFor(url)[0].body.message).not.toContain('[계획]')
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-TP-03 라우터가 오류를 내거나 6초를 넘기면 에이전트가 맡고, 「이 요청을 처리하지 못했어요」는 없음', async ({ browser }) => {
  await clearMain(KO)
  const p = await open(browser, KO, DESK)
  for (const marker of ['router-500', 'slow-router']) {
    const url = `https://news.example.com/posts/${marker}-quick-${Date.now().toString(36)}`
    const t0 = await send(p, url)
    await expect.poll(() => bodyFor(url).length, { timeout: 12_000, message: `${marker}: delegated` }).toBe(1)
    const ms = bodyFor(url)[0].at - t0
    console.log(`[F-TP-03] ${marker}: agent reached ${ms} ms after Enter`)
    if (marker === 'slow-router') expect(ms).toBeLessThan(8000)
    await expect(lastAnswer(p).locator('.bubble.agent')).toContainText('요약했어요.', { timeout: 15000 })
    await expect(card(p)).toHaveCount(0, { timeout: 5000 })
  }
  await expect(p.getByText('이 요청을 처리하지 못했어요')).toHaveCount(0)
  const failed = await S.q(`select count(*)::int as n from pro_messages where thread_id=(select id from pro_threads where user_id=$1 and kind='chat' limit 1) and content->>'failed'='true'`, [KO.id])
  expect(failed[0].n).toBe(0)
  await p.context().close()
})

test('F-TP-08 라우터가 답하기 전에 「멈추기」 → 아무 처리도 시작하지 않고 「멈췄어요」', async ({ browser }) => {
  await clearMain(KO)
  const p = await open(browser, KO, DESK)
  const url = `https://news.example.com/posts/stop-router-${Date.now().toString(36)}`
  await send(p, url)
  await expect(p.locator('[data-testid="turn-understood"]').last()).toBeVisible({ timeout: 4000 })
  // the router is still thinking (10 s): stop now
  await expect.poll(() => llm.router.filter((c) => c.text.includes(url)).length, { timeout: 5000 }).toBe(1)
  await p.locator('.foot button.stop').click()
  await expect(p.locator('.row.r-agent .bubble.agent').last()).toContainText('멈췄어요', { timeout: 5000 })
  await expect(card(p)).toHaveCount(0)
  // no handler started — the agent never got it, even after the router's answer would have come
  await p.waitForTimeout(10_500)
  expect(bodyFor(url)).toHaveLength(0)
  const rows = await S.q(`select role, kind, content from pro_messages where thread_id=(select id from pro_threads where user_id=$1 and kind='chat' limit 1) order by created_at`, [KO.id])
  expect(rows.filter((r) => r.role === 'agent').map((r) => r.content.text)).toEqual(['(답을 멈췄어요.)'])
  expect(rows.at(-1).content.stopped).toBe(true)
  expect(rows.at(-1).content.plan?.state).toBe('stopped')
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-TP-10 영어 화면: 카드 · 패널의 모든 글과 이해한 문장이 영어', async ({ browser }) => {
  await clearMain(EN)
  const p = await open(browser, EN, DESK, { lang: 'en' })
  const url = `https://news.example.com/posts/english-${Date.now().toString(36)}`
  await send(p, url)
  await expect(p.locator('[data-testid="turn-understood"]').last()).toHaveText(FRONT_EN.understood, { timeout: 4000 })
  await expect(card(p).locator('[data-testid="turn-step"] .txt')).toHaveText(FRONT_EN.steps, { timeout: 8000 })
  await expect(card(p).locator('[data-testid="turn-handler"]')).toHaveText('Agent')
  await pill(p).click()
  await expect(panel(p).locator('h4')).toHaveText(['Now', 'To-do', 'Done so far', 'Notes'])
  await expect(panel(p).locator('[data-testid="turn-note"]')).toHaveText([INTERIM_EN], { timeout: 5000 })
  await expect(card(p).locator('[data-testid="turn-live"]')).toHaveText(/^Writing the next step · \d+ ?s$/, { timeout: 9000 })
  for (const loc of [card(p), panel(p), pill(p)]) expect(await loc.innerText()).not.toMatch(HANGUL)
  await shot(p, 'tp-english-desktop')
  // the answer's fold too
  const fold = lastAnswer(p).locator('[data-testid="plan-fold"]')
  await expect(fold).toHaveText(/^Plan 3\/3 · \d+ ?s/, { timeout: PAUSE_MS + 8000 })
  await fold.click()
  expect(await lastAnswer(p).locator('[data-testid="plan-body"]').innerText()).not.toMatch(HANGUL)
  expect(bodyFor(url)[0].body.metadata.language).toBe('en')
  expect(bodyFor(url)[0].body.message).toContain('[Plan] ')
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-TP-06 390px: 아래 시트 · 「멈추기」가 다 보임 · 화면 사진(1280 · 390, 밝은 · 밤 — 카드 · 패널 · 접힌 줄)', async ({ browser }) => {
  test.setTimeout(240_000)
  for (const [name, opts, theme] of [['phone-light', PHONE, 'light'], ['phone-dark', PHONE, 'dark'], ['desktop-dark', DESK, 'dark']]) {
    await clearMain(KO)
    const p = await open(browser, KO, opts, { theme })
    const phone = opts === PHONE
    const url = `https://news.example.com/posts/${name}-${Date.now().toString(36)}`
    await send(p, url)
    await expect(p.locator('[data-testid="turn-understood"]').last()).toBeVisible({ timeout: 4000 })
    // (a phone: the keyboard put away after sending — while the person types, the row over the box folds: compact-composer F-CC-02)
    if (phone) await p.locator('[data-test="chat-composer"] textarea').last().blur()
    // 멈추기 whole: the box's own ■, under the pill's row (compact-composer F-CC-01)
    await inView(p.locator('.foot button.stop'), p)
    const pb = await pill(p).boundingBox(), sb = await p.locator('.foot button.stop').boundingBox()
    expect(pb.y + pb.height).toBeLessThanOrEqual(sb.y + 0.5)
    await expect(card(p).locator('[data-testid="turn-step"]').first()).toHaveAttribute('data-state', 'done', { timeout: 8000 })
    await shot(p, `tp-card-${name}`)
    await pill(p).click()
    await expect(panel(p)).toBeVisible()
    await calm(p)
    if (phone) {
      const box = await panel(p).boundingBox()
      expect(Math.round(box.width)).toBe(390)
      expect(Math.round(box.y + box.height)).toBe(844)
      expect(box.height).toBeLessThanOrEqual(844 * 0.85 + 1)
      await inView(panel(p).locator('[data-testid="turn-panel-stop"]'), p)
      expect(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
    }
    await expect(panel(p).locator('[data-testid="turn-note"]')).toHaveText([INTERIM_KO], { timeout: 5000 })
    await shot(p, `tp-panel-${name}`)
    // closed by ✕ (on a phone also by pulling it down — the scrim closes it too)
    await panel(p).locator('[data-testid="turn-panel-close"]').click()
    await expect(panel(p)).toHaveCount(0)
    const fold = lastAnswer(p).locator('[data-testid="plan-fold"]')
    await expect(fold).toHaveText(/^계획 3\/3 · /, { timeout: PAUSE_MS + 10_000 })
    await fold.click()
    await fold.scrollIntoViewIfNeeded()
    await shot(p, `tp-folded-${name}`)
    expect(p.errors).toEqual([])
    await p.context().close()
  }
})
