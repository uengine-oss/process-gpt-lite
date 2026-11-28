// 계획에서 벗어나면 멈추고 묻는다 · 저장된 계획은 단계마다 어떻게 됐는지 남기고 답 위에 있다 (스펙 openspec/specs/turn-plan,
// 서버 lib/planGuard.js · lib/turnPlan.js · lib/agent.js, 화면 components/PlanFold.vue). 2026-11-28 녹화 20:49 — 드라이브의 자료로 만들라는 요청에
// 자료를 찾지 못하자 다른 자료로 끝까지 만들고 「계획 4/4」로 남았다:
// 사용자 「이걸 그냥 무시하고 그냥 넘어갖고 멈춰서 나한테 물어보는 게 맞지」 · 「요청의 의도나 수행 방법/플래닝의 의도에 맞지 않게 돌아가는
// 중요한 경우는 stop 하고 HITL 이 벌어졌어야 한다.」 · 「계획이 지금 사라져버렸는데」.
//   F-PG-01 PC(밝은): 자료를 못 찾고 다른 자료로 가려는 순간 멈춤 — 에이전트 멈추기(/chat/stop) · 답은 무엇이 있었나와 질문, 보기는 빠른 답 단추 ·
//            계획은 답 위에 펼쳐져 「계획 0/3 · 1단계 못 함 · 물어볼 게 있어요」, 1단계 ✗ 와 까닭 · 단추를 누르면 그 말이 보내짐
//   F-PG-02 휴대폰 390(어두운 · 밝은): 에이전트가 멈추기에 답하지 않아도(스트림을 끊음) 같은 질문 · 계획
//   F-PG-03 PC: 끝까지 했지만 계획과 달랐음 — 답은 그대로, 계획이 「계획 1/3 · 1단계 못 함 · 2단계 바꿈」으로 펼쳐지고 「계획과 다르게 진행했어요」
//            상자의 보기를 누르면 보내짐
//   F-PG-04 PC: 계획대로 — 「계획 3/3」 접힌 줄이 답 위에, 상자 없음 · 판정 모델이 없으면(500) 예전처럼 「계획 3/3」
//   F-PG-05 영어 화면: 계획 줄 · 상자 제목이 영어
// 자기 스택(lib/localStack.js: 회사 planguard-ui 의 BFF + Vite, 8961 · 5361 부터 빈 포트)을 띄우고 지운다. 가짜 모델(8966)과 가짜 deepagents(8967)는
// 이 파일이 띄운다 — 실제 모델 · 에이전트 · 드라이브는 부르지 않는다. 사람 · 회사는 지어낸 것(윤가람 · 가나정밀).
//   cd e2e && npx playwright test --project=feature tests/feature/plan-guard.spec.js
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
const TENANT = 'planguard-ui'
const LLM_PORT = Number(process.env.RT_FAKE_LLM_PORT || 8966)
const AGENT_PORT = Number(process.env.RT_FAKE_AGENT_PORT || 8967)
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms))

// what the person asks — the word in it picks the case (the fake model and the fake agent read it):
//   커리큘럼 → stops on the way (the agent ends its stream on /chat/stop) · 교안 → stops, the agent does not answer /chat/stop
//   계획서 → runs to its end, the end check says it went off · 요약 → as planned · 일정표 → as planned, the guard's model fails
const ASK = {
  stop: '드라이브에서 「가나정밀 교육」 자료를 찾아서 그걸 바탕으로 커리큘럼을 만들어 줘',
  cut: '드라이브에서 「가나정밀 교육」 자료를 찾아서 그걸 바탕으로 교안을 만들어 줘',
  after: '드라이브에서 「가나정밀 교육」 자료를 찾아서 그걸 바탕으로 교육 계획서를 만들어 줘',
  ok: '드라이브에서 「가나정밀 교육」 자료를 찾아서 요약해 줘',
  down: '드라이브에서 「가나정밀 교육」 자료를 찾아서 일정표를 만들어 줘',
}
const caseOf = (t) => (/커리큘럼/.test(t) ? 'stop' : /교안/.test(t) ? 'cut' : /계획서/.test(t) ? 'after' : /요약/.test(t) ? 'ok' : /일정표/.test(t) ? 'down' : 'plain')
const STEPS_KO = ['드라이브에서 가나정밀 교육 자료 찾기', '자료를 바탕으로 만들기', '정리해서 전달']
const STEPS_EN = ['Find the Ganaprecision training files in Drive', 'Make it from the files', 'Tidy up and send']
const OFF_KO = { off: true, step: 1, kind: 'missing', what: '드라이브에서 「가나정밀 교육」 자료를 찾지 못했는데, 공개 자료로 대신 만들려고 해요.', question: '어떻게 할까요?', options: ['자료 위치를 알려 줄게요', '공개 자료로 계속해 줘', '여기서 멈춰'], confidence: 0.92 }
const OFF_EN = { ...OFF_KO, what: "I couldn't find the Ganaprecision training files in Drive and used public material instead.", question: 'How should I go on?', options: ["I'll tell you where they are", 'Go on with public material', 'Stop here'] }
const NOTE_KO = '드라이브에서 찾지 못했어요. 공개 자료로 만들게요.'

// ---- the fake model: the front plan, the router (DELEGATE), the guard's checks and its end check, a title ----
const llm = { guard: [], final: [] }
const textOf = (b) => (b.messages || []).map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n')
function answerLlm(b) {
  const all = textOf(b)
  const sys = String(b.messages?.[0]?.content || '')
  const user = String(b.messages?.at(-1)?.content || '')
  if (sys.includes('what you understood and how the work will go')) {
    const en = /LANGUAGE: English|in English/.test(sys)
    return { delay: 150, content: JSON.stringify({ understood: en ? 'You want something made from the training files in your Drive.' : '드라이브의 교육 자료로 만들어 드릴게요.', steps: en ? STEPS_EN : STEPS_KO, tier: 'standard', certainty: 'sure' }) }
  }
  if (b.tools) return { delay: 100, content: 'DELEGATE' }
  if (sys.includes("You watch an assistant's work")) {
    const final = sys.includes('"steps": [{"n"')
    const c = caseOf(user.split("The person's request:")[1] || '')
    const en = /Write what, question, options and why in English/.test(sys)
    const OFF = en ? OFF_EN : OFF_KO
    ;(final ? llm.final : llm.guard).push({ c, user })
    if (c === 'down') return { status: 500 }
    if (!final) {
      // (on the way: the work goes off once the agent wrote that it will use other material instead — only in the stopping cases)
      const wentOn = /What the assistant wrote between steps/.test(user) && /공개 자료|public material/.test(user)
      return { content: JSON.stringify(wentOn && (c === 'stop' || c === 'cut') ? OFF : { off: false, kind: 'none', confidence: 0.2 }) }
    }
    if (c === 'after') return { content: JSON.stringify({ ...OFF, steps: [{ n: 1, state: 'missed', why: en ? 'Not found in Drive' : '드라이브에서 찾지 못함' }, { n: 2, state: 'changed', why: en ? 'Made from public material' : '공개 자료로 만듦' }, { n: 3, state: 'done' }] }) }
    return { content: JSON.stringify({ off: false, kind: 'none', confidence: 0.1, steps: [1, 2, 3].map((n) => ({ n, state: 'done' })) }) }
  }
  if (/제목을|A title for/.test(sys)) return { content: '교육 자료' }
  return { content: b.response_format ? '{}' : 'OK' }
}

// ---- the fake deepagents: to-dos, a Drive search that finds nothing, a note, a fetch, a pause, the answer ----
const agent = { stops: [], streams: new Map() }
const ANSWER_KO = '교육 자료를 정리했어요.\n\n공개 자료의 흐름을 기준으로 3일 과정을 잡았어요. 첫날은 기본 개념, 둘째 날은 실습, 셋째 날은 발표예요.'
const ANSWER_EN = 'I put the training material together.\n\nThe three-day course follows the public material: concepts on day one, practice on day two, presentations on day three.'
async function runAgent(body, res) {
  const msg = String(body.message || '')
  const en = body.metadata?.language === 'en'
  const c = caseOf(msg)
  // (a conversation the server did not name gets one here, as deepagents does — its stop is asked by that id)
  const conv = body.conversation_id || `c${Math.random().toString(36).slice(2, 12)}`
  const say = (o) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(o)}\n\n`) }
  agent.streams.set(conv, { res, say, case: c })
  const todos = (states) => (en ? STEPS_EN : STEPS_KO).map((content, i) => ({ content, status: states[i] }))
  res.write(`event: metadata\ndata: ${JSON.stringify({ conversation_id: conv })}\n\n`)
  await sleep(600)
  say({ type: 'plan_todos', todos: todos(['in_progress', 'pending', 'pending']) })
  await sleep(200)
  say({ type: 'tool_start', tool: 'drive_search', input: { query: '가나정밀 교육' } })
  await sleep(200)
  say({ type: 'tool_end', tool: 'drive_search', output: '[]' })
  await sleep(200)
  if (c !== 'plain') {
    say({ type: 'token', content: en ? "I couldn't find it in Drive. I'll use public material." : NOTE_KO })
    await sleep(150)
  }
  say({ type: 'tool_start', tool: 'fetch_url', input: { url: 'https://github.com/example/spec-kit' } })
  await sleep(200)
  say({ type: 'tool_end', tool: 'fetch_url', output: '<html>public material</html>' })
  // (the stopping cases: the guard reads the note above and stops the run during this pause)
  await sleep(c === 'stop' || c === 'cut' ? 9000 : 800)
  if (res.writableEnded) return
  const answer = en ? ANSWER_EN : ANSWER_KO
  say({ type: 'plan_todos', todos: todos(['completed', 'completed', 'completed']) })
  say({ type: 'token', content: answer })
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
      const r = answerLlm(b)
      if (r.delay) await sleep(r.delay)
      if (r.status) { res.writeHead(r.status, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'fake failure' } })) }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: r.content }, finish_reason: 'stop' }] }))
    })
  }), LLM_PORT)
  await listen(http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      let body = {}
      try { body = JSON.parse(raw) } catch { /* not json */ }
      if (req.url.startsWith('/chat/stop')) {
        // deepagents' own stop: the turn of that conversation ends with "turn cancelled" — unless the case is the one that does not answer
        const s = agent.streams.get(body.conversation_id)
        const cut = s && s.case === 'cut'
        agent.stops.push({ at: Date.now(), conv: body.conversation_id, answered: !!s && !cut })
        if (s && !cut) { s.say({ type: 'error', message: 'turn cancelled' }); s.res.end() }
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ stopped: !!s && !cut }))
      }
      if (!req.url.startsWith('/chat/stream')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('[]') }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      runAgent(body, res).catch(() => res.end())
    })
  }), AGENT_PORT)
  S = await startStack({ tenant: TENANT, apiFrom: 8961, webFrom: 5361, env: {
    PRO_LLM_BASE_URL: `http://127.0.0.1:${LLM_PORT}/v1`, PRO_LLM_API_KEY: 'fake', PRO_LLM_KEYS: 'off',
    PRO_LLM_MODEL: 'main-fake', PRO_LLM_FAST_MODEL: 'fast-fake', PRO_LLM_FRONT_MODEL: 'front-fake', PRO_LLM_ODDS_MODEL: 'fast-fake',
    PRO_DEEPAGENTS_URL: `http://127.0.0.1:${AGENT_PORT}`, PRO_CONTEXT_ROUTER_URL: NOWHERE, PRO_COMPLETION_URL: NOWHERE, PRO_JUDGE_URL: NOWHERE, PRO_EMBED_URL: '',
    PRO_MEMENTO_URL: NOWHERE, PRO_ONTOLOGY_BOLT_URL: '',
  } })
  KO = await S.person(`pro-rt-${TENANT}-a@uengine.org`, '윤가람')
  EN = await S.person(`pro-rt-${TENANT}-b@uengine.org`, 'Mira Song')
  for (const p of [KO, EN]) await S.join(p)
  await S.api(KO.token, '/me/lang', { method: 'PUT', body: { lang: 'ko' } })
  await S.api(EN.token, '/me/lang', { method: 'PUT', body: { lang: 'en' } })
})
test.afterAll(async () => {
  for (const s of servers) await new Promise((ok) => s.close(ok))
  servers = []
  if (S) {
    fs.mkdirSync(path.join(REPO, 'e2e/reports'), { recursive: true })
    fs.writeFileSync(path.join(REPO, 'e2e/reports', `bff-${TENANT}.log`), S.logs.join(''))
    for (const p of [KO, EN].filter(Boolean)) {
      await S.q(`delete from pro_messages where thread_id in (select id from pro_threads where user_id=$1)`, [p.id]).catch(() => {})
      await S.q('delete from context_threads where tenant_id=$1 and user_id=$2', [TENANT, p.id]).catch(() => {})
    }
    await S.q('delete from notifications where tenant_id=$1', [TENANT]).catch(() => {})
    await S.stop()
  }
})

async function open(browser, who, opts, { theme = 'light', lang = 'ko' } = {}) {
  const ctx = await browser.newContext({ ...opts, baseURL: S.web })
  await ctx.addInitScript(([s, th, l]) => {
    if (window.top !== window) return
    localStorage.setItem('pgpt-pro-session', s)
    localStorage.setItem('pgpt-pro-theme', th)
    localStorage.setItem('pgl-lang', l)
    localStorage.setItem('pgl-install', JSON.stringify({ never: true }))
  }, [JSON.stringify(who.session), theme, lang])
  const p = await ctx.newPage()
  p.errors = []
  p.on('pageerror', (e) => p.errors.push(String(e?.message || e)))
  await p.goto('/chat')
  if (opts === PHONE) await p.locator('.seg button').filter({ hasText: lang === 'en' ? 'Chat' : '채팅' }).click()
  await p.locator('[data-test="chat-composer"] textarea').last().waitFor()
  return p
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
  await ta.press('Enter')
}
const answers = (p) => p.locator('.row.r-agent.k-text')
const fold = (row) => row.locator('[data-testid="plan-fold"]')
const calm = (p) => p.evaluate(() => Promise.race([
  Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming?.().iterations !== Infinity).map((a) => a.finished.catch(() => {}))),
  new Promise((ok) => setTimeout(ok, 2000)),
]))
const shot = async (p, name) => { await calm(p); await p.waitForTimeout(200); await p.screenshot({ path: path.join(SHOTS, `${name}.png`) }) }
const lastOf = async (threadId) => (await S.q(`select id, content from pro_messages where thread_id=$1 and role='agent' and kind='text' order by created_at desc limit 1`, [threadId]))[0]

// the stopped turn's answer, the plan over it, the step it stopped at
async function seeStopped(p, row, { phone = false } = {}) {
  await expect(row.locator('.bubble')).toContainText(OFF_KO.what)
  await expect(row.locator('.bubble')).toContainText('어떻게 할까요?')
  await expect(row.locator('.bubble')).not.toContainText(ANSWER_KO.slice(0, 10))
  await expect(row.locator('.replies .reply')).toHaveText(OFF_KO.options)
  await expect(fold(row)).toContainText(/계획 0\/3 · 1단계 못 함 · 물어볼 게 있어요/)
  await expect(row.locator('[data-testid="plan-body"]')).toBeVisible()
  const steps = row.locator('[data-testid="plan-step"]')
  await expect(steps).toHaveCount(3)
  expect(await steps.evaluateAll((li) => li.map((x) => x.dataset.state))).toEqual(['missed', 'pending', 'pending'])
  await expect(steps.first().locator('[data-testid="plan-step-why"]')).toHaveText(OFF_KO.what)
  // the plan is over the answer, where the running turn's card was
  const f = await fold(row).boundingBox(), b = await row.locator('.bubble').boundingBox()
  expect(f.y + f.height).toBeLessThanOrEqual(b.y + 1)
  if (phone) expect(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
}

test('F-PG-01 PC(밝은): 자료를 못 찾고 다른 자료로 가려는 순간 멈추고 묻는다 — 계획은 답 위에 펼쳐져 1단계 ✗', async ({ browser }) => {
  test.setTimeout(120_000)
  const tid = await clearMain(KO)
  const p = await open(browser, KO, DESK)
  const stopsBefore = agent.stops.length
  await send(p, ASK.stop)
  const row = answers(p).last()
  await expect(row.locator('.bubble')).toContainText('어떻게 할까요?', { timeout: 40_000 })
  // deepagents was asked to stop that conversation (its own stop), and it ended the stream
  expect(agent.stops.length).toBe(stopsBefore + 1)
  expect(agent.stops.at(-1).answered).toBe(true)
  await seeStopped(p, row)
  const m = await lastOf(tid)
  expect(m.content.ask).toEqual({ question: OFF_KO.question, options: OFF_KO.options })
  expect(m.content.guard).toMatchObject({ kind: 'missing', step: 1, stopped: true })
  expect(m.content.plan.state).toBe('asked')
  expect(m.content.stopped).toBeFalsy()
  // the guard read the note the agent wrote between steps and the Drive search that came back empty
  const read = llm.guard.filter((g) => g.c === 'stop').at(-1).user
  expect(read).toContain('drive_search')
  expect(read).toContain('→ []')
  expect(read).toContain(NOTE_KO)
  await shot(p, 'f-pg-01-pc-stopped')
  // an answer button sends its words
  await row.locator('.replies .reply').first().click()
  await expect(p.locator('.row.r-user .bubble').last()).toContainText('자료 위치를 알려 줄게요')
  // (that turn's answer is in before the next test clears the chat)
  await expect(answers(p)).toHaveCount(2, { timeout: 40_000 })
  await expect(answers(p).last().locator('.bubble')).toContainText('교육 자료를 정리했어요')
  expect(p.errors).toEqual([])
  await p.context().close()
})

for (const theme of ['dark', 'light']) {
  test(`F-PG-02 휴대폰 390(${theme === 'dark' ? '어두운' : '밝은'}): 에이전트가 멈추기에 답하지 않아도 같은 질문 · 계획`, async ({ browser }) => {
    test.setTimeout(120_000)
    const tid = await clearMain(KO)
    const p = await open(browser, KO, PHONE, { theme })
    await send(p, ASK.cut)
    const row = answers(p).last()
    await expect(row.locator('.bubble')).toContainText('어떻게 할까요?', { timeout: 40_000 })
    expect(agent.stops.at(-1).answered).toBe(false)
    await seeStopped(p, row, { phone: true })
    expect((await lastOf(tid)).content.guard).toMatchObject({ kind: 'missing', stopped: true })
    await row.scrollIntoViewIfNeeded()
    await shot(p, `f-pg-02-phone-stopped-${theme}`)
    expect(p.errors).toEqual([])
    await p.context().close()
  })
}

test('F-PG-03 PC: 끝까지 했지만 계획과 달랐음 — 계획이 펼쳐지고 「계획과 다르게 진행했어요」의 보기를 누르면 보내짐', async ({ browser }) => {
  test.setTimeout(120_000)
  const tid = await clearMain(KO)
  const p = await open(browser, KO, DESK)
  await send(p, ASK.after)
  const row = answers(p).last()
  await expect(row.locator('.bubble')).toContainText('교육 자료를 정리했어요', { timeout: 40_000 })
  await expect(fold(row)).toContainText(/계획 1\/3 · 1단계 못 함 · 2단계 바꿈/, { timeout: 20_000 })
  await expect(row.locator('[data-testid="plan-body"]')).toBeVisible()
  expect(await row.locator('[data-testid="plan-step"]').evaluateAll((li) => li.map((x) => x.dataset.state))).toEqual(['missed', 'changed', 'done'])
  await expect(row.locator('[data-testid="plan-step-why"]').first()).toHaveText('드라이브에서 찾지 못함')
  const off = row.locator('[data-testid="plan-off"]')
  await expect(off).toContainText('계획과 다르게 진행했어요')
  await expect(off).toContainText(OFF_KO.what)
  await expect(off.locator('[data-testid="plan-off-option"]')).toHaveText(OFF_KO.options)
  const m = await lastOf(tid)
  expect(m.content.plan.checking).toBeUndefined()
  expect(m.content.guard).toMatchObject({ after: true, kind: 'missing', step: 1 })
  // (a guard that ran to the end did not stop the run)
  expect(llm.final.filter((f) => f.c === 'after').length).toBeGreaterThan(0)
  await shot(p, 'f-pg-03-pc-went-off')
  await off.locator('[data-testid="plan-off-option"]').nth(1).click()
  await expect(off.locator('[data-testid="plan-off-sent"]')).toContainText('공개 자료로 계속해 줘')
  await expect(p.locator('.row.r-user .bubble').last()).toContainText('공개 자료로 계속해 줘')
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-PG-04 PC: 계획대로면 「계획 3/3」 접힌 줄이 답 위에 · 판정 모델이 없으면 예전처럼', async ({ browser }) => {
  test.setTimeout(120_000)
  await clearMain(KO)
  const p = await open(browser, KO, DESK)
  await send(p, ASK.ok)
  let row = answers(p).last()
  await expect(row.locator('.bubble')).toContainText('교육 자료를 정리했어요', { timeout: 40_000 })
  await expect(fold(row)).toContainText(/^계획 3\/3 · \d+초/, { timeout: 20_000 })
  await expect(row.locator('[data-testid="plan-body"]')).toHaveCount(0)
  await expect(row.locator('[data-testid="plan-off"]')).toHaveCount(0)
  const f = await fold(row).boundingBox(), b = await row.locator('.bubble').boundingBox()
  expect(f.y + f.height).toBeLessThanOrEqual(b.y + 1)
  await fold(row).click()
  expect(await row.locator('[data-testid="plan-step"]').evaluateAll((li) => li.map((x) => x.dataset.state))).toEqual(['done', 'done', 'done'])
  await shot(p, 'f-pg-04-pc-as-planned')
  // the guard's model fails: the turn goes on, and the plan reads done as before
  await send(p, ASK.down)
  row = answers(p).last()
  await expect(row.locator('.bubble')).toContainText('교육 자료를 정리했어요', { timeout: 40_000 })
  await expect(answers(p)).toHaveCount(2)
  await expect(fold(row)).toContainText(/^계획 3\/3/, { timeout: 20_000 })
  await expect(row.locator('[data-testid="plan-off"]')).toHaveCount(0)
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-PG-05 영어 화면: 계획 줄 · 상자 제목이 영어', async ({ browser }) => {
  test.setTimeout(120_000)
  await clearMain(EN)
  const p = await open(browser, EN, DESK, { lang: 'en' })
  await send(p, ASK.after)
  const row = answers(p).last()
  await expect(row.locator('.bubble')).toContainText('I put the training material together', { timeout: 40_000 })
  await expect(fold(row)).toContainText(/Plan 1\/3 · Step 1 not done · Step 2 done another way/, { timeout: 20_000 })
  const off = row.locator('[data-testid="plan-off"]')
  await expect(off).toContainText('This went differently from the plan')
  await expect(off).toContainText(OFF_EN.what)
  expect(await row.locator('[data-test="plan-fold"]').innerText()).not.toMatch(/[가-힣]/)
  await shot(p, 'f-pg-05-pc-english')
  expect(p.errors).toEqual([])
  await p.context().close()
})
