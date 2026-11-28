// 에이전트가 턴 도중에 내장 브라우저를 부른다 — 작업 카드가 채팅에 곧바로 서고, 사람은 카드에서 답하고, 결과는 에이전트에게 돌아가
// 계획을 이어 간다 (스펙 openspec/specs/agent-browser, 서버 lib/agentBrowser.js · mcp/connectors/browser.js). 2026-11-28 운영: 프로젝트
// 방에서 티스토리 링크를 NotebookLM 에 넣어 슬라이드 · 오디오 오버뷰를 만들어 달라고 했는데, deepagents 는 브라우저를 못 띄워 페이지를 직접
// 받아 reportlab 으로 PDF 를 만들기 시작했다. 사용자: 「랭체인 디베이전트가 일을 하는 도중에 이 브라우저 유즈 … 화면상에 곧바로 나타나면서
// 진행사항이 나타나면서 서로 커뮤니케이션 하면서 왔다갔다 일이 되어야」.
//   F-AB-01 PC(밝은): 에이전트 턴이 도는 동안 작업 카드(실시간 화면)가 채팅에 서고, 계획 카드에 「에이전트 · 브라우저 · 스튜디오」,
//           답은 작업 카드 뒤에 결과(받은 파일 이름)로
//   F-AB-02 PC: 브라우저가 카드로 묻는다 → 사람이 카드에서 고른다 → 에이전트가 그 답이 든 결과로 이어서 답한다
//   F-AB-03 PC: 에이전트 턴이 먼저 끝난 오래 걸리는 작업 → 끝나면 같은 대화로 한 번 이어 하기(「Lite 가 보냄」), 두 번은 없다
//   F-AB-04 PC: 다른 사람의 대화 id 로 부르면 거절 — 어느 방에도 작업 카드가 없다
//   F-AB-05 휴대폰 390(밝은 · 어두운): 일하는 중의 작업 카드와 계획 카드가 화면 안, 옆으로 밀리지 않음
//   F-AB-06 PC · 휴대폰 390: 에이전트가 시작한 작업에서 사람이 말하지 않은 지우기는 사람의 승인 카드에서 멈추고, 「취소」면 하지 않는다
// 자기 스택(lib/localStack.js: 회사 agentbrowser-ui 의 BFF + Vite, 9061 · 5461 부터 빈 포트)을 띄우고 지운다. 가짜 모델 · 판정(9066)과
// 가짜 deepagents(9067)는 이 파일이 띄운다 — 가짜 deepagents 는 스트림 도중에 Lite 의 /mcp/browser 를 사람의 토큰과 X-Conversation-Id 로
// 부른다. 사이트는 server/test/fixtures/studio.mjs(생성을 누르면 몇 초 뒤 다운로드). 브라우저 작업은 그 BFF 의 진짜 Chromium 이 한다.
// 사람은 지어낸 것(한지우 · 문도윤).
//   cd e2e && npx playwright test --project=feature tests/feature/agent-browser.spec.js --workers=1   (공용 녹화 잠금 안에서)
import { test, expect } from '@playwright/test'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { startStack, REPO, SERVER } from '../../lib/localStack.js'

// (no trace: Vite serves this repository and reloads every open page when a trace writes its .html resources under e2e/reports)
test.use({ channel: 'chromium', trace: 'off', video: 'off' })
test.describe.configure({ mode: 'serial' })
const SHOTS = path.join(REPO, 'openspec/specs/agent-browser/e2e/results')
const DESK = { viewport: { width: 1280, height: 860 }, locale: 'ko-KR' }
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ko-KR' }
const NOWHERE = 'http://127.0.0.1:9'
const TENANT = 'agentbrowser-ui'
const LLM_PORT = Number(process.env.RT_FAKE_LLM_PORT || 9066)
const AGENT_PORT = Number(process.env.RT_FAKE_AGENT_PORT || 9067)
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms))

// what the person asks — a word in it picks the case (the fake agent reads it)
const ASK = {
  audio: '스튜디오 사이트에서 오디오 보고서를 만들어서 받아 줘',
  ask: '스튜디오에서 오디오를 만들어 줘, 목소리는 나한테 물어보고',
  handback: '스튜디오에서 긴 오디오 보고서를 만들고, 끝나면 이어서 정리해 줘',
  other: '다른 사람 대화로 브라우저 작업을 해 봐',
  tidy: '노트북 사이트의 목록을 보기 좋게 정리해 줘',
}
const caseOf = (t) => (t.includes('목소리') ? 'ask' : t.includes('끝나면 이어서') ? 'handback' : t.includes('다른 사람 대화') ? 'other' : t.includes('목록을 보기 좋게') ? 'tidy' : 'audio')
const GOAL = {
  audio: '스튜디오에서 오디오 보고서를 생성하고 다운로드한다',
  ask: '스튜디오에서 어느 목소리로 할지 사람에게 물어 정한 뒤 오디오를 만든다',
  handback: '스튜디오에서 긴 오디오 보고서를 생성하고 다운로드한다',
  tidy: '노트북 목록을 정리한다',
}
const WAIT_MS = { audio: 7000, ask: 1000, handback: 9000 }
const STEPS = ['스튜디오에서 오디오 보고서 만들기', '파일 받아 오기', '결과 알려 주기']
const VOICES = ['차분한 목소리', '밝은 목소리']

// ---- the fake model and judge: the front plan, the router (DELEGATE), the plan guard, the browser's plan and its agent ----
const lastPage = (b) => { const m = [...b.messages].reverse().find((x) => x.role === 'user' && typeof x.content === 'string' && x.content.startsWith('{')); return m ? JSON.parse(m.content.split('\n')[0]) : { els: [], text: '' } }
const el = (b, text) => lastPage(b).els.find((e) => e.text === text || e.name === text)
const lastTool = (b) => String([...b.messages].reverse().find((m) => m.role === 'tool')?.content || '')
const runs = {} // goal → its state, made again on a task's first move
function browserMove(goal, b) {
  if (!b.messages.some((m) => m.role === 'assistant')) runs[goal] = { gen: false, dl: false, asked: false }
  const s = runs[goal] || (runs[goal] = { gen: false, dl: false, asked: false })
  const kase = Object.entries(GOAL).find(([, g]) => g === goal)?.[0]
  if (kase === 'tidy') {
    const k = b.messages.filter((m) => m.role === 'tool').length
    if (k === 0) return ['click', { i: el(b, 'more_vert').i }]
    if (k === 1) return ['click', { i: el(b, 'delete 삭제').i }]
    return ['finish', { summary: /^not done/.test(lastTool(b)) ? '지우지 않았어요.' : '지웠어요.' }]
  }
  if (kase === 'ask') {
    if (!s.asked) { s.asked = true; return ['need_user', { reason: '어느 목소리로 오디오를 만들까요?', options: VOICES, need: 'other' }] }
    const chose = /chose: (.*?)\. Continue/.exec(lastTool(b))?.[1] || /"(.*)"/.exec(lastTool(b))?.[1] || ''
    if (!s.noted) { s.noted = chose || '(답 없음)'; return ['note', { text: `고른 목소리: ${s.noted}` }] }
    return ['finish', { summary: `${s.noted}로 오디오를 만들었어요.` }]
  }
  if (s.dl) return ['finish', { summary: kase === 'handback' ? '긴 오디오 보고서를 만들어 받았어요.' : '오디오 보고서를 만들어 받았어요.' }]
  const dl = el(b, '다운로드')
  if (dl) { s.dl = true; return ['click', { i: dl.i }] }
  if (String(lastPage(b).text || '').includes('생성 중')) return ['wait_for_page', { minutes: 1, gone_text: '생성 중' }]
  if (!s.gen && el(b, '생성')) { s.gen = true; return ['click', { i: el(b, '생성').i }] }
  return ['wait_for_page', { minutes: 1, until_text: '완료' }]
}
function answerLlm(b) {
  const sys = String(b.messages?.[0]?.content || '')
  const names = (b.tools || []).map((t) => t.function?.name)
  if (b.logprobs) return { content: 'B' }
  if (sys.includes('what you understood and how the work will go')) return { delay: 150, content: JSON.stringify({ understood: '스튜디오에서 만들어 받아 드릴게요.', steps: STEPS, tier: 'standard', certainty: 'sure' }) }
  if (/Break a web task/.test(sys)) return { content: JSON.stringify({ title: String(b.messages[1].content).split('\n')[0].slice(0, 30), steps: ['스튜디오 열기', '만들기', '받기'] }) }
  if (names.includes('finish')) {
    const goal = (/Goal: (.*)/.exec(sys)?.[1] || '').trim()
    const [name, args] = GOAL && Object.values(GOAL).includes(goal) ? browserMove(goal, b) : ['finish', { summary: '끝났어요.' }]
    return { tool: { name, args } }
  }
  if (names.length) return { content: 'DELEGATE' }
  if (sys.includes("You watch an assistant's work")) {
    const final = sys.includes('"steps": [{"n"')
    return { content: JSON.stringify(final ? { off: false, kind: 'none', confidence: 0.1, steps: STEPS.map((_, i) => ({ n: i + 1, state: 'done' })) } : { off: false, kind: 'none', confidence: 0.1 }) }
  }
  if (/제목을|A title for/.test(sys)) return { content: '스튜디오 보고서' }
  return { content: b.response_format ? '{}' : 'OK' }
}
// (the effect gate — server lib/browser.js EFFECT_OPTIONS: removing reaches outside the person's workspace, generating stays in it)
const effectOf = (state) => { const c = /Control: "([^"]*)"/.exec(state)?.[1] || ''; return /삭제|delete/i.test(c) ? { outside: 0.92 } : /생성/.test(c) ? { own: 0.9 } : { look: 0.9 } }
const judgeOf = (keys, state = '') => (keys.includes('outside') ? effectOf(state) : keys.includes('login_needed') ? { ok: 1 } : keys.includes('idle') ? { busy: 1 } : keys.includes('none') ? { none: 1 } : keys.includes('new') ? { new: 1 } : { other: 1 })

// ---- the fake deepagents: to-dos, then Lite's /mcp/browser in the middle of its stream, then the answer from the result ----
const agent = { calls: [], handbacks: [] }
let S, A, Bp, site, notes
let otherConv = ''
const FINAL = ['done', 'failed', 'needs_review', 'cancelled']
async function mcp(jwt, conv, name, args) {
  const r = await fetch(`http://127.0.0.1:${S.apiPort}/mcp/browser`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${jwt}`, ...(conv ? { 'X-Conversation-Id': conv } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })
  const j = await r.json()
  const text = j.result?.content?.[0]?.text || j.error?.message || ''
  let out = null
  try { out = JSON.parse(text) } catch { /* an error's words */ }
  return { error: !!(j.error || j.result?.isError), out, text }
}
async function runAgent(body, res) {
  const msg = String(body.message || '')
  const conv = body.conversation_id || `c${Math.random().toString(36).slice(2, 12)}`
  const jwt = body.user_jwt
  const say = (o) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(o)}\n\n`) }
  const answer = (text) => { say({ type: 'plan_todos', todos: STEPS.map((content) => ({ content, status: 'completed' })) }); say({ type: 'token', content: text }); say({ type: 'done', content: text }); res.end() }
  res.write(`event: metadata\ndata: ${JSON.stringify({ conversation_id: conv })}\n\n`)
  agent.calls.push({ conv, msg })
  await sleep(500)
  // Lite's handback: which task is over — the agent reads its result with browser_task_wait (a tool result, not words in the message)
  if (msg.includes('(Lite 가 보낸 메시지예요')) {
    agent.handbacks.push({ conv, msg })
    const id = /task_id: ([0-9a-f-]{36})/.exec(msg)?.[1]
    const r = id ? await mcp(jwt, conv, 'browser_task_wait', { task_id: id, seconds: 30 }) : null
    return answer(`브라우저 작업의 결과를 받아 이어서 정리했어요. ${String(r?.out?.summary || '').split('\n')[0]}`)
  }
  const c = caseOf(msg)
  say({ type: 'plan_todos', todos: STEPS.map((content, i) => ({ content, status: i ? 'pending' : 'in_progress' })) })
  await sleep(200)
  if (c === 'other') {
    const r = await mcp(jwt, otherConv, 'browser_task', { goal: '다른 사람의 방에서 읽기', start_url: site.url })
    return answer(r.error ? `브라우저 작업을 시작하지 못했어요: ${r.text}` : '시작했어요.')
  }
  const args = c === 'tidy' ? { goal: GOAL.tidy, start_url: `${notes.url}/notebooks?n=3` } : { goal: GOAL[c], start_url: `${site.url}?ms=${WAIT_MS[c]}`, skill: 'fake-studio' }
  say({ type: 'token', content: '스튜디오 사이트에서 직접 만들게요.' })
  say({ type: 'tool_start', tool: 'browser_task', input: args })
  let r = await mcp(jwt, conv, 'browser_task', args)
  say({ type: 'tool_end', tool: 'browser_task', output: r.text.slice(0, 400) })
  agent.calls.at(-1).first = r.out?.state || 'error'
  if (c === 'handback') return answer('스튜디오에서 긴 오디오 보고서를 만들고 있어요. 끝나면 이어서 정리할게요.')
  while (r.out && !FINAL.includes(r.out.state)) {
    if (r.out.state === 'waiting_for_person') say({ type: 'token', content: '브라우저가 작업 카드에서 묻고 있어요.' })
    say({ type: 'tool_start', tool: 'browser_task_wait', input: { task_id: r.out.task_id } })
    r = await mcp(jwt, conv, 'browser_task_wait', { task_id: r.out.task_id, seconds: 60 })
    say({ type: 'tool_end', tool: 'browser_task_wait', output: r.text.slice(0, 400) })
  }
  const files = (r.out?.files || []).map((f) => f.name)
  answer(`${String(r.out?.summary || r.text).split('\n')[0]}${files.length ? ` 받은 파일: ${files.join(', ')}` : ''}`)
}

let servers = []
const listen = (srv, port) => new Promise((ok, no) => srv.once('error', no).listen(port, '127.0.0.1', () => { servers.push(srv); ok() }))
const bodyOf = (req) => new Promise((ok) => { let raw = ''; req.on('data', (c) => { raw += c }); req.on('end', () => { try { ok(JSON.parse(raw)) } catch { ok({}) } }) })

test.beforeAll(async () => {
  test.setTimeout(240_000)
  fs.mkdirSync(SHOTS, { recursive: true })
  await listen(http.createServer(async (req, res) => {
    const b = await bodyOf(req)
    if (req.url.startsWith('/judge')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ probabilities: judgeOf((b.options || []).map((o) => o.key), String(b.state || '')), model: 'fake' }))
    }
    const r = answerLlm(b)
    if (r.delay) await sleep(r.delay)
    const message = r.tool ? { role: 'assistant', content: null, tool_calls: [{ id: `c_${crypto.randomUUID().slice(0, 8)}`, type: 'function', function: { name: r.tool.name, arguments: JSON.stringify(r.tool.args) } }] }
      : { role: 'assistant', content: r.content }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message, finish_reason: 'stop' }] }))
  }), LLM_PORT)
  await listen(http.createServer(async (req, res) => {
    const body = await bodyOf(req)
    if (!req.url.startsWith('/chat/stream')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(req.url.startsWith('/chat/stop') ? '{"stopped":false}' : '[]') }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    runAgent(body, res).catch((e) => { console.warn('[fake agent]', e.message); res.end() })
  }), AGENT_PORT)
  const { startStudio } = await import(pathToFileURL(path.join(SERVER, 'test/fixtures/studio.mjs')).href)
  site = await startStudio()
  const { startNotebooks } = await import(pathToFileURL(path.join(SERVER, 'test/fixtures/notebooks.mjs')).href)
  notes = await startNotebooks()
  const skills = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-skills-'))
  fs.mkdirSync(path.join(skills, 'fake-studio'))
  fs.writeFileSync(path.join(skills, 'fake-studio', 'SKILL.md'), '---\nname: fake-studio\ndescription: 시험용 스튜디오 사이트에서 보고서 · 오디오를 만들고 파일로 받아 온다.\nmetadata:\n  runs_in: browser\n  label: 스튜디오\n---\n시험용.\n')
  S = await startStack({ tenant: TENANT, apiFrom: 9061, webFrom: 5461, env: {
    PRO_LLM_BASE_URL: `http://127.0.0.1:${LLM_PORT}/v1`, PRO_LLM_API_KEY: 'fake', PRO_LLM_KEYS: 'off',
    PRO_LLM_MODEL: 'main-fake', PRO_LLM_FAST_MODEL: 'fast-fake', PRO_LLM_FRONT_MODEL: 'front-fake', PRO_LLM_ODDS_MODEL: 'fast-fake',
    PRO_JUDGE_URL: `http://127.0.0.1:${LLM_PORT}/judge`, PRO_JUDGE_LLM: '0', PRO_EMBED_URL: '',
    PRO_DEEPAGENTS_URL: `http://127.0.0.1:${AGENT_PORT}`, PRO_CONTEXT_ROUTER_URL: '', PRO_COMPLETION_URL: NOWHERE, PRO_MEMENTO_URL: NOWHERE,
    PRO_MCP_HUB_URL: NOWHERE, PRO_OFFICE_MCP_URL: NOWHERE, PRO_ONTOLOGY_BOLT_URL: '',
    PRO_BROWSER_PROFILES: fs.mkdtempSync(path.join(os.tmpdir(), 'ab-profiles-')), PRO_BROWSER_SKILLS_DIR: skills, PRO_BROWSER_PRIVATE_ALLOW: '127.0.0.1,localhost',
    // (the agent's call comes back within 4 s here — 240 s in production — so the follow-up wait and the handback are both seen)
    PRO_BROWSER_TOOL_MS: '4000',
  } })
  A = await S.person(`pro-rt-${TENANT}-a@uengine.org`, '한지우')
  Bp = await S.person(`pro-rt-${TENANT}-b@uengine.org`, '문도윤')
  for (const p of [A, Bp]) await S.join(p)
  await S.api(A.token, '/me/lang', { method: 'PUT', body: { lang: 'ko' } })
})
test.afterAll(async () => {
  for (const s of servers) await new Promise((ok) => { s.closeAllConnections?.(); s.close(ok) })
  servers = []
  await site?.close()
  await notes?.close()
  if (S) {
    fs.mkdirSync(path.join(REPO, 'e2e/reports'), { recursive: true })
    fs.writeFileSync(path.join(REPO, 'e2e/reports', `bff-${TENANT}.log`), S.logs.join(''))
    for (const p of [A, Bp].filter(Boolean)) {
      await S.q(`delete from pro_messages where thread_id in (select id from pro_threads where user_id=$1)`, [p.id]).catch(() => {})
      await S.q(`delete from pro_threads where user_id=$1 and kind <> 'chat'`, [p.id]).catch(() => {})
      await S.q('delete from context_threads where tenant_id=$1 and user_id=$2', [TENANT, p.id]).catch(() => {})
    }
    await S.q('delete from notifications where tenant_id=$1', [TENANT]).catch(() => {})
    await S.stop()
  }
})

async function open(browser, who, opts, { theme = 'light' } = {}) {
  const ctx = await browser.newContext({ ...opts, baseURL: S.web })
  await ctx.addInitScript(([s, th]) => {
    if (window.top !== window) return
    localStorage.setItem('pgpt-pro-session', s)
    localStorage.setItem('pgpt-pro-theme', th)
    localStorage.setItem('pgl-lang', 'ko')
    localStorage.setItem('pgl-install', JSON.stringify({ never: true }))
  }, [JSON.stringify(who.session), theme])
  const p = await ctx.newPage()
  p.errors = []
  p.on('pageerror', (e) => p.errors.push(String(e?.message || e)))
  await p.goto('/chat')
  if (opts === PHONE) await p.locator('.seg button').filter({ hasText: '채팅' }).click()
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
const calm = (p) => p.evaluate(() => Promise.race([
  Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming?.().iterations !== Infinity).map((a) => a.finished.catch(() => {}))),
  new Promise((ok) => setTimeout(ok, 1500)),
]))
const shot = async (p, name) => { await calm(p); await p.waitForTimeout(200); await p.screenshot({ path: path.join(SHOTS, `${name}.png`) }) }
const taskRow = (p) => p.locator('.row.k-task').last()
const answers = (p) => p.locator('.row.r-agent.k-text')
// the order of two rows in the chat (their message ids)
const orderOf = (p, ...ids) => p.evaluate((list) => list.map((id) => [...document.querySelectorAll('.row[data-id]')].findIndex((r) => r.dataset.id === id)), ids)
const noOverflow = (p) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
const tasksOf = (userId) => S.q(`select m.id, m.thread_id, m.content from pro_messages m join pro_threads t on t.id=m.thread_id where t.user_id=$1 and m.kind='task' order by m.created_at`, [userId])

// the card in the chat while the agent's turn works: its live screen, and the plan card saying the browser does that part
async function seeWorking(p) {
  const row = taskRow(p)
  await expect(row).toBeVisible({ timeout: 60_000 })
  await expect(row.locator('.screen img')).toBeVisible({ timeout: 30_000 })
  const card = p.locator('[data-testid="turn-card"]').last()
  await expect(card).toBeVisible()
  await expect(card.locator('[data-testid="turn-handler"]')).toHaveText('에이전트 · 브라우저 · 스튜디오', { timeout: 20_000 })
  return row
}

test('F-AB-01 PC(밝은): 에이전트 턴 도중의 작업 카드 · 계획 카드의 「브라우저 · 스튜디오」 · 답은 카드 뒤의 결과', async ({ browser }) => {
  test.setTimeout(150_000)
  const tid = await clearMain(A)
  const p = await open(browser, A, DESK)
  await send(p, ASK.audio)
  const row = await seeWorking(p)
  // the agent's turn is still working: no answer of it yet, and the task card is under the person's message
  await expect(answers(p)).toHaveCount(0)
  await expect(row.locator('[data-testid="task-pill"]')).toBeVisible()
  await row.scrollIntoViewIfNeeded()
  await shot(p, 'f-ab-01-pc-working')
  const ans = answers(p).last()
  await expect(ans.locator('.bubble')).toContainText('오디오 보고서를 만들어 받았어요.', { timeout: 60_000 })
  await expect(ans.locator('.bubble')).toContainText('받은 파일: ')
  await expect(ans.locator('.bubble')).toContainText('오디오 보고서.pdf')
  // the call came back running (4 s here) and the agent waited for the result with browser_task_wait
  expect(agent.calls.at(-1).first).toBe('running')
  const [task] = await tasksOf(A.id)
  expect(task.thread_id).toBe(tid)
  expect(task.content.goal).toBe(GOAL.audio)
  expect(task.content.state).toBe('done')
  const [answer] = await S.q(`select id, content from pro_messages where thread_id=$1 and role='agent' and kind='text' order by created_at desc limit 1`, [tid])
  const [ti, ai] = await orderOf(p, task.id, answer.id)
  expect(ti).toBeGreaterThanOrEqual(0)
  expect(ai).toBeGreaterThan(ti)
  // the plan the answer keeps says who did the work
  expect(answer.content.plan?.handler?.label).toBe('에이전트 · 브라우저 · 스튜디오')
  await ans.scrollIntoViewIfNeeded()
  await shot(p, 'f-ab-01-pc-answered')
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-AB-02 PC: 브라우저가 카드로 묻고, 사람이 카드에서 고르면 에이전트가 그 답이 든 결과로 이어서 답한다', async ({ browser }) => {
  test.setTimeout(150_000)
  await clearMain(A)
  const p = await open(browser, A, DESK)
  await send(p, ASK.ask)
  const choice = p.locator('.row.k-choice').last()
  await expect(choice).toContainText('어느 목소리로 오디오를 만들까요?', { timeout: 60_000 })
  // the agent's turn waits meanwhile (its plan card is up), and it was told the browser is asking the person
  await expect(p.locator('[data-testid="turn-card"]').last()).toBeVisible()
  await expect.poll(() => agent.calls.at(-1)?.first, { timeout: 20_000 }).toBe('waiting_for_person')
  await choice.scrollIntoViewIfNeeded()
  await shot(p, 'f-ab-02-pc-asking')
  await choice.locator('.opt').filter({ hasText: '밝은 목소리' }).click()
  await choice.locator('.dark-btn').filter({ hasText: '확인' }).click()
  await expect(choice.getByTestId('choice-answered')).toContainText('밝은 목소리')
  const ans = answers(p).last()
  await expect(ans.locator('.bubble')).toContainText('밝은 목소리로 오디오를 만들었어요.', { timeout: 60_000 })
  await ans.scrollIntoViewIfNeeded()
  await shot(p, 'f-ab-02-pc-answered')
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-AB-03 PC: 에이전트 턴이 먼저 끝난 작업은 끝난 뒤 같은 대화로 한 번 이어 하기 — 「Lite 가 보냄」', async ({ browser }) => {
  test.setTimeout(180_000)
  const tid = await clearMain(A)
  const p = await open(browser, A, DESK)
  const n0 = agent.handbacks.length
  await send(p, ASK.handback)
  // the agent's own answer first: it is working on the site
  await expect(answers(p).last().locator('.bubble')).toContainText('끝나면 이어서 정리할게요', { timeout: 60_000 })
  const conv = agent.calls.at(-1).conv
  // …the task ends; Lite sends its result to the same conversation, once
  const said = p.locator('.row.r-user').filter({ has: p.getByTestId('handback') }).last()
  await expect(said).toBeVisible({ timeout: 90_000 })
  await expect(said.getByTestId('handback')).toHaveText('Lite 가 보냄 · 브라우저 작업이 끝나 에이전트가 이어서 해요')
  await expect(said.locator('.bubble')).toHaveText('브라우저 작업이 끝났어요. 에이전트가 결과를 읽고 남은 일을 이어서 해요.')
  const ans = answers(p).last()
  await expect(ans.locator('.bubble')).toContainText('브라우저 작업의 결과를 받아 이어서 정리했어요. 긴 오디오 보고서를 만들어 받았어요.', { timeout: 60_000 })
  expect(agent.handbacks.length).toBe(n0 + 1)
  expect(agent.handbacks.at(-1).conv).toBe(conv)
  // the message names the task and its state only — what the site wrote reaches the agent as the tool's result
  expect(agent.handbacks.at(-1).msg).toMatch(/task_id: [0-9a-f-]{36} · state: done/)
  expect(agent.handbacks.at(-1).msg).not.toMatch(/만들어 받았어요|\.pdf|완료/)
  const [m] = await S.q(`select content from pro_messages where thread_id=$1 and role='user' and content ? 'handback'`, [tid])
  expect(m.content.composed).toBe(true)
  await ans.scrollIntoViewIfNeeded()
  await shot(p, 'f-ab-03-pc-handback')
  // never twice
  await sleep(3000)
  expect(agent.handbacks.length).toBe(n0 + 1)
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-AB-04 PC: 다른 사람의 대화 id 로 부르면 거절 — 어느 방에도 작업 카드가 없다', async ({ browser }) => {
  test.setTimeout(120_000)
  await clearMain(A)
  const [bMain] = await S.api(Bp.token, '/threads')
  otherConv = `conv-b-${crypto.randomBytes(3).toString('hex')}`
  await S.q('update pro_threads set conversation_id=$2 where id=$1', [bMain.id, otherConv])
  const before = (await tasksOf(A.id)).length + (await tasksOf(Bp.id)).length
  const p = await open(browser, A, DESK)
  await send(p, ASK.other)
  const ans = answers(p).last()
  await expect(ans.locator('.bubble')).toContainText('이 대화를 이 계정에서 찾지 못해 브라우저 작업을 시작하지 않았어요.', { timeout: 60_000 })
  expect((await tasksOf(A.id)).length + (await tasksOf(Bp.id)).length).toBe(before)
  expect((await S.q('select count(*)::int as n from pro_messages where thread_id=$1', [bMain.id]))[0].n).toBe(0)
  await shot(p, 'f-ab-04-pc-refused')
  await S.q('update pro_threads set conversation_id=null where id=$1', [bMain.id])
  expect(p.errors).toEqual([])
  await p.context().close()
})

for (const theme of ['light', 'dark']) {
  test(`F-AB-05 휴대폰 390(${theme === 'dark' ? '어두운' : '밝은'}): 일하는 중의 작업 카드와 계획 카드가 화면 안`, async ({ browser }) => {
    test.setTimeout(150_000)
    await clearMain(A)
    const p = await open(browser, A, PHONE, { theme })
    await send(p, ASK.audio)
    const row = await seeWorking(p)
    await row.scrollIntoViewIfNeeded()
    const box = await row.locator('.screen').boundingBox()
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(390.5)
    const card = await p.locator('[data-testid="turn-card"]').last().boundingBox()
    expect(card.x + card.width).toBeLessThanOrEqual(390.5)
    expect(await noOverflow(p)).toBe(true)
    await shot(p, `f-ab-05-phone-working-${theme}`)
    await expect(answers(p).last().locator('.bubble')).toContainText('오디오 보고서를 만들어 받았어요.', { timeout: 60_000 })
    expect(await noOverflow(p)).toBe(true)
    await answers(p).last().scrollIntoViewIfNeeded()
    await shot(p, `f-ab-05-phone-answered-${theme}`)
    expect(p.errors).toEqual([])
    await p.context().close()
  })
}

for (const [label, opts] of [['PC', DESK], ['휴대폰 390', PHONE]]) {
  test(`F-AB-06 ${label}: 에이전트가 시작한 작업에서 사람이 말하지 않은 지우기는 승인 카드에서 멈추고, 「취소」면 하지 않는다`, async ({ browser }) => {
    test.setTimeout(120_000)
    const tid = await clearMain(A)
    const p = await open(browser, A, opts)
    await send(p, ASK.tidy)
    const choice = p.locator('.row.k-choice').last()
    await expect(choice).toContainText('「delete 삭제」을(를) 누를까요? 에이전트가 시작한 작업이라', { timeout: 60_000 })
    await expect(choice.locator('.ghost-btn')).toHaveText('취소')
    await expect(choice.locator('.dark-btn')).toHaveText('승인')
    // the task waits on the person — the agent's turn too
    const [task] = await tasksOf(A.id).then((l) => l.filter((t) => t.thread_id === tid))
    expect(task.content.need).toBe('approve')
    await expect(p.locator('[data-testid="turn-card"]').last()).toBeVisible()
    if (opts === PHONE) expect(await noOverflow(p)).toBe(true)
    await choice.scrollIntoViewIfNeeded()
    await shot(p, `f-ab-06-${opts === PHONE ? 'phone' : 'pc'}-approval`)
    await choice.locator('.ghost-btn').click()
    await expect(answers(p).last().locator('.bubble')).toContainText('지우지 않았어요.', { timeout: 60_000 })
    expect(p.errors).toEqual([])
    await p.context().close()
  })
}
