// 프로젝트 안의 주제(2026-11-25 사용자: 「홈 채팅에서 주제를 자동 분류하듯이 하나의 프로젝트 내에서도 서브 레벨로 주제들이 자동 분류될 수
// 있어야 한다. 한 프로젝트 내에서도 많은 내용들이 있을 수 있기 때문에.」 — 스펙 openspec/specs/project-room 「프로젝트 안의 주제」,
// 서버 lib/projectTopics.js, 화면 src/projectTopics.js). 지어낸 사람: 한서윤.
// F-PS-01 프로젝트에서 보낸 메시지마다 판단 모델이 이 프로젝트의 주제 가운데서 고름 — 라우터가 받는 후보는 이 프로젝트의 주제뿐(메인 채팅의
//         대화 · 다른 프로젝트의 주제는 없음, 사용자 열쇠는 프로젝트의 것), 새 주제는 새 대화, 이어지는 말은 그 주제의 대화로, 주제 막대 ·
//         왼쪽 목록의 한 단계 아래 주제 행, 메인 채팅의 대화 목록에는 섞이지 않음
// F-PS-02 주제 하나로 좁히기(막대 · 왼쪽 목록) — 그 주제의 메시지만, 「이 주제의 산출물」, 거기서 보낸 말은 라우터를 거치지 않고 그 주제로,
//         「전체」로 돌아가기
// F-PS-03 답 위의 「↳ 주제」 표시를 누르면 그 주제로
// F-PS-04 주제가 생기기 전부터 있던 프로젝트: 원래 대화가 프로젝트 이름의 첫 주제가 되고, 새 주제와 나뉘며, 다시 이어질 수 있음
// F-PS-05 390px 휴대폰(밝은 · 밤): 막대와 목록 창이 화면 안, 옆으로 밀리지 않음, 고르면 그 주제
// F-PS-06 밤 테마의 넓은 화면(왼쪽 목록의 주제 행 · 막대)
// F-PS-07 폴더에서 일하는 프로젝트: 주제마다 대화는 따로지만 프로젝트의 변형은 하나 — 턴의 작업 폴더는 그 턴의 주제 대화 안
// F-PS-08 라우터가 꺼지면(닿지 않으면) 예전처럼 — 프로젝트의 대화로 답하고 오류 없음, 새 프로젝트에는 주제 막대가 없음
// 자기 스택(lib/localStack.js: BFF PRO_BACKGROUND=0 + Vite, 회사 projtopics-ui, 8940 · 5340 부터 빈 포트)과 가짜 셋(맥락 라우터 :8947 ·
// deepagents :8948 · 모델 :8949 — 모두 이 파일이 띄움)으로 돈다. 공용 deepagents · completion · 맥락 라우터 · 판단 서버는 부르지 않는다.
//   cd e2e && npx playwright test --project=feature tests/feature/project-topics.spec.js
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { test, expect } from '@playwright/test'
import { startStack } from '../../lib/localStack.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const SHOTS = path.resolve(here, '../../../openspec/specs/project-room/e2e/results')
test.use({ channel: 'chromium' })
test.describe.configure({ mode: 'serial' })

const NOWHERE = 'http://127.0.0.1:9'
const ROUTER_PORT = 8947, AGENT_PORT = 8948, LLM_PORT = 8949
const DESK = { viewport: { width: 1440, height: 900 }, locale: 'ko-KR' }
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ko-KR' }
const STAMP = crypto.randomBytes(3).toString('hex')

// ---- the fake context router: POST /route decides by a word in the message (the real one asks a model). It keeps what it was given. ----
// a sub-topic id is made from the word and the project (the router's user is the project's key: <user>/project/<thread>)
const WORDS = [['강의', 'lec'], ['견적', 'quote'], ['구글 문서', 'origin']]
const router = { calls: [], srv: null }
function decide(b) {
  const msg = String(b.message || '')
  const contexts = b.metadata?.contexts || []
  const proj = String(b.user_uid || '').split('/project/')[1]?.slice(0, 8) || 'none'
  const key = WORDS.find(([w]) => msg.includes(w))?.[1]
  const conf = { strategy: 'judge', confidence: 0.9, model: 'fake-router', notes: [] }
  if (key === 'origin') {
    // the project's conversation from before it had sub-topics (named after the project, not one this fake made)
    const old = contexts.find((c) => !String(c.conversation_id).startsWith('pt-'))
    if (old) return { conversation_id: old.conversation_id, action: 'continue', context: old, decision: conf }
  }
  if (!key) {
    const here = contexts.find((c) => c.conversation_id === b.conversation_id) || null
    return { conversation_id: b.conversation_id || `pt-x-${proj}-${STAMP}`, action: 'stay', context: here, decision: { ...conf, confidence: 0.4 } }
  }
  const id = `pt-${key}-${proj}-${STAMP}`
  const hit = contexts.find((c) => c.conversation_id === id)
  return hit ? { conversation_id: id, action: 'continue', context: hit, decision: conf } : { conversation_id: id, action: 'new', context: null, decision: conf }
}
// ---- the fake deepagents: an answer in the conversation it was given, a file for some requests; every body kept ----
const FILES = [['정리해', '클라우다이크_강의준비안.md'], ['검토해', '견적_검토표.csv'], ['표지', '강의_표지_문구.md']]
const FILE_TEXT = { md: '# 클라우다이크 강의 준비\n\n1. 강의 목표\n2. 실습 순서\n', csv: '항목,단가,수량\n노트북 대여,30000,20\n강의장,500000,1\n' }
// the agent's workspace of this company (the file is there, as deepagents would leave it in the conversation folder)
const { PGPT_ROOT } = await import(path.resolve(here, '../../../server/lib/paths.js'))
const workspace = () => path.join(PGPT_ROOT, 'services/deepagents/workspace', S.tenant)
const agent = { bodies: [] }
const answerOf = (msg) => `「${(WORDS.find(([w]) => msg.includes(w)) || ['이어서'])[0]}」 주제로 답했어요 · ${msg.split('\n')[0].slice(0, 18)}`
// ---- the fake model: the chat's own router hands every turn to the agent (DELEGATE); a judge gets {}; a project title ----
let servers = []
const listen = (srv, port) => new Promise((ok, no) => srv.once('error', no).listen(port, '127.0.0.1', () => { servers.push(srv); ok(srv) }))
const bodyOf = (req) => new Promise((ok) => { let raw = ''; req.on('data', (c) => { raw += c }); req.on('end', () => { try { ok(JSON.parse(raw)) } catch { ok({}) } }) })
const routerServer = () => http.createServer(async (req, res) => {
  const b = await bodyOf(req)
  if (req.url.endsWith('/route')) {
    router.calls.push(b)
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify(decide(b)))
  }
  res.writeHead(404); res.end()
})

let S, SY, A, B, C, D, F
const people = []
async function page(browser, opts, { theme = null } = {}) {
  const ctx = await browser.newContext({ ...opts, baseURL: S.web })
  await ctx.addInitScript(([s, th]) => {
    if (window.top !== window) return
    localStorage.setItem('pgpt-pro-session', s)
    if (th) localStorage.setItem('pgpt-pro-theme', th)
  }, [JSON.stringify(SY.session), theme])
  const p = await ctx.newPage()
  p.errors = []
  p.on('pageerror', (e) => p.errors.push(String(e?.message || e)))
  return p
}
const shot = async (p, name) => {
  await p.evaluate(() => Promise.race([Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming?.().iterations !== Infinity).map((a) => a.finished.catch(() => {}))), new Promise((ok) => setTimeout(ok, 2500))]))
  await p.waitForTimeout(300)
  await p.screenshot({ path: path.join(SHOTS, `${name}.png`) })
}
const noOverflow = (p) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
const box = (p) => p.locator('.composer textarea').first()
const bar = (p) => p.locator('[data-testid=cbar][data-scope=project]')
const answer = (p, text) => p.locator('.row.r-agent.k-text').filter({ hasText: text })
const userMsg = (p, text) => p.locator('.row.r-user .bubble.user').filter({ hasText: text })
const agentBodies = (conv) => agent.bodies.filter((b) => b.conversation_id === conv)
const scope = (thread) => `${SY.id}/project/${thread}`
const topicRows = (thread) => S.q(`select conversation_id, title, turns, summary, gist from context_threads where tenant_id=$1 and user_id=$2 order by created_at`, [S.tenant, scope(thread)])
const topicId = (key, thread) => `pt-${key}-${String(thread).slice(0, 8)}-${STAMP}`
async function send(p, text) {
  await box(p).fill(text)
  await box(p).press('Enter')
  await expect(answer(p, answerOf(text))).toBeVisible({ timeout: 30000 })
}
async function project(title, conversation = null) {
  const [t] = await S.q(`insert into pro_threads(user_id, kind, title, conversation_id) values ($1,'project',$2,$3) returning id`, [SY.id, title, conversation])
  return t.id
}

test.beforeAll(async () => {
  test.setTimeout(240_000)
  fs.mkdirSync(SHOTS, { recursive: true })
  router.srv = await listen(routerServer(), ROUTER_PORT)
  await listen(http.createServer(async (req, res) => {
    const b = await bodyOf(req)
    if (req.url.endsWith('/chat/stop')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"stopped":false}') }
    if (!req.url.endsWith('/chat/stream')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('[]') }
    agent.bodies.push(b)
    const msg = String(b.message || '')
    const conv = b.conversation_id || `agent-${crypto.randomBytes(4).toString('hex')}`
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`event: metadata\ndata: ${JSON.stringify({ conversation_id: conv })}\n\n`)
    // (what the person said is the first line; Lite's hints for the agent — the project's folder … — follow it)
    res.write(`data: ${JSON.stringify({ type: 'token', content: answerOf(msg.split('\n')[0]) })}\n\n`)
    const file = FILES.find(([w]) => msg.split('\n')[0].includes(w))?.[1]
    if (file) {
      const ext = file.split('.').pop()
      fs.mkdirSync(path.join(workspace(), '.bpmn', conv), { recursive: true })
      fs.writeFileSync(path.join(workspace(), '.bpmn', conv, file), FILE_TEXT[ext] || '')
      // (dated back: the server takes a document changed just before a turn started for that turn's own — the next turn of this fast
      // test comes a second later; this one is a card already, by its file_artifact)
      const past = new Date(Date.now() - 3600_000)
      fs.utimesSync(path.join(workspace(), '.bpmn', conv, file), past, past)
      res.write(`data: ${JSON.stringify({ type: 'file_artifact', name: file, path: `/workspace/.bpmn/${conv}/${file}`, ext })}\n\n`)
    }
    res.end()
  }), AGENT_PORT)
  await listen(http.createServer(async (req, res) => {
    const b = await bodyOf(req)
    const text = (b.messages || []).map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n')
    res.writeHead(200, { 'content-type': 'application/json' })
    // (a one-token judge: the last option, the way a «none of these» answer reads)
    if (b.logprobs) {
      const last = [...text.matchAll(/^([A-Z])\) /gm)].at(-1)?.[1] || 'A'
      return res.end(JSON.stringify({ choices: [{ message: { content: last }, logprobs: { content: [{ token: last, logprob: Math.log(0.9), top_logprobs: [{ token: last, logprob: Math.log(0.9) }] }] } }] }))
    }
    const content = /DELEGATE/.test(text) ? 'DELEGATE' : /프로젝트 제목/.test(text) ? '강의 자료 작업' : '{}'
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] }))
  }), LLM_PORT)
  S = await startStack({ tenant: 'projtopics-ui', apiFrom: 8940, webFrom: 5340, env: {
    PRO_CONTEXT_ROUTER_URL: `http://127.0.0.1:${ROUTER_PORT}`, PRO_DEEPAGENTS_URL: `http://127.0.0.1:${AGENT_PORT}`, PRO_LLM_BASE_URL: `http://127.0.0.1:${LLM_PORT}/v1`,
    PRO_COMPLETION_URL: NOWHERE, PRO_MCP_HUB_URL: NOWHERE, PRO_JUDGE_URL: `${NOWHERE}/judge`, PRO_MEMENTO_URL: NOWHERE, PRO_OFFICE_MCP_URL: NOWHERE,
    PRO_ONTOLOGY_BOLT_URL: 'bolt://127.0.0.1:9' } })
  SY = await S.person('pro-rt-projtopics-ui-a@uengine.org', '한서윤')
  people.push(SY)
  await S.join(SY)
  await S.q(`delete from pro_messages where thread_id in (select id from pro_threads where user_id=$1)`, [SY.id])
  await S.q(`delete from pro_threads where user_id=$1 and kind='project'`, [SY.id])
  await S.q(`delete from context_threads where tenant_id=$1 and (user_id=$2 or user_id like $3)`, [S.tenant, SY.id, `${SY.id}/project/%`])
  // her main chat has a conversation of its own, and another project has a sub-topic: neither is ever offered for project A
  await S.q(`insert into context_threads(tenant_id,user_id,conversation_id,title,summary,gist,kind,turns) values ($1,$2,$3,'주간 보고서 초안','최근 요청: 이번 주 매출 보고서 초안 써 줘','', 'conversation', 1)`,
    [S.tenant, SY.id, `home-report-${STAMP}`])
  B = await project('신제품 출시 준비')
  await S.q(`insert into context_threads(tenant_id,user_id,conversation_id,title,summary,gist,kind,turns) values ($1,$2,$3,'출시 강의 영상','최근 요청: 출시 강의 영상 대본 써 줘','', 'conversation', 1)`,
    [S.tenant, scope(B), `b-lec-${STAMP}`])
  A = await project('클라우다이크 강의 준비')
})
test.afterAll(async () => {
  if (S) {
    for (const who of people) {
      await S.q(`delete from context_threads where tenant_id=$1 and (user_id=$2 or user_id like $3)`, [S.tenant, who.id, `${who.id}/project/%`]).catch(() => {})
      await S.q(`delete from pro_messages where thread_id in (select id from pro_threads where user_id=$1)`, [who.id]).catch(() => {})
      await S.q(`delete from pro_folder_variations where folder_id in (select folder_id from pro_thread_folders where user_id=$1)`, [who.id]).catch(() => {})
      await S.q(`delete from pro_thread_folders where user_id=$1`, [who.id]).catch(() => {})
      await S.q(`delete from pro_threads where user_id=$1 and kind='project'`, [who.id]).catch(() => {})
    }
    // the project's conversation folders the turns left in the agent's workspace of this company
    fs.rmSync(workspace(), { recursive: true, force: true })
    await S.stop()
  }
  for (const s of servers) await new Promise((ok) => s.close(ok))
  servers = []
})

let desk
test('F-PS-01 프로젝트의 메시지는 그 프로젝트의 주제 가운데서만 나뉜다 — 새 주제는 새 대화, 이어지는 말은 그 주제로', async ({ browser }) => {
  desk = await page(browser, DESK)
  await desk.goto(`/projects/${A}`)
  await expect(box(desk)).toBeVisible({ timeout: 20000 })
  // one topic: no bar yet
  await send(desk, '클라우다이크 강의 준비안을 정리해 줘')
  await expect(bar(desk)).toHaveCount(0)
  await send(desk, '견적서 내용을 검토해 줘')
  await send(desk, '강의 표지도 만들어 줘')
  const lec = topicId('lec', A), quote = topicId('quote', A)
  // the router: three calls, each as the project (its key), offered only this project's sub-topics
  const mine = router.calls.filter((c) => c.user_uid === scope(A))
  expect(mine).toHaveLength(3)
  expect(router.calls.every((c) => String(c.user_uid).includes('/project/'))).toBe(true)
  const offered = new Set(mine.flatMap((c) => (c.metadata?.contexts || []).map((x) => x.conversation_id)))
  expect([...offered].sort()).toEqual([lec, quote].sort())
  expect(mine[0].metadata.contexts).toEqual([])
  expect(mine[2].metadata.contexts.map((x) => x.conversation_id).sort()).toEqual([lec, quote].sort())
  // (the router is asked what the person said — not the hints Lite adds for the agent)
  expect(mine[1].message).toBe('견적서 내용을 검토해 줘')
  // each turn went to its sub-topic's own conversation
  expect(agent.bodies.map((b) => b.conversation_id)).toEqual([lec, quote, lec])
  // its rows are the project's, not the main chat's: the main chat's conversation list is as it was
  const rows = await topicRows(A)
  expect(rows.map((r) => [r.conversation_id, r.title, r.turns])).toEqual([[lec, '클라우다이크 강의 준비안을 정리해 줘', 2], [quote, '견적서 내용을 검토해 줘', 1]])
  expect(rows[0].summary).toContain('최근 요청: 강의 표지도 만들어 줘')
  expect(rows[0].gist).toBe('클라우다이크 강의 준비안을 정리해 줘')
  expect((await S.api(SY.token, '/conversations')).map((c) => c.id)).toEqual([`home-report-${STAMP}`])
  const listed = await S.api(SY.token, `/threads/${A}/topics`)
  expect(listed.routed).toBe(true)
  expect(listed.topics.map((t) => t.id)).toEqual([lec, quote])
  // the project stands in the sub-topic of its last turn
  expect((await S.q('select conversation_id from pro_threads where id=$1', [A]))[0].conversation_id).toBe(lec)
  // the bar over the project's chat and, a level down under the project in the list, its sub-topics (newest first)
  await expect(bar(desk).getByTestId('cbar-pill')).toHaveText(/주제 2개 · 주제별로 보기/, { timeout: 10000 })
  const sub = desk.getByTestId('project-topic')
  await expect(sub).toHaveCount(2)
  await expect(sub.nth(0)).toHaveAttribute('data-conv', lec)
  await expect(sub.nth(0)).toContainText('클라우다이크 강의 준비안을 정리해 줘')
  await expect(sub.nth(0)).toContainText('· 6')
  await expect(sub.nth(1)).toContainText('· 3')
  // the answers say which sub-topic they went to
  await expect(answer(desk, answerOf('견적서 내용을 검토해 줘')).locator('.ctx')).toContainText('새 주제 · 견적서 내용을 검토해 줘')
  await expect(desk.getByTestId('artifact-list')).toHaveAttribute('data-scope', 'project')
  await expect(desk.getByTestId('artifact-row')).toHaveCount(3)
  await shot(desk, 'f-ps-01-topics')
  expect(desk.errors).toEqual([])
})

test('F-PS-02 주제 하나로 좁히면 그 주제의 메시지 · 산출물만, 거기서 보낸 말은 그 주제로 이어지고, 「전체」로 돌아간다', async () => {
  const lec = topicId('lec', A), quote = topicId('quote', A)
  await bar(desk).getByTestId('cbar-pill').click()
  const panel = bar(desk).getByTestId('cbar-panel')
  await expect(panel).toContainText('판단 모델이 이 프로젝트에서 나눈 주제')
  await expect(panel.getByTestId('cbar-row')).toHaveCount(2)
  await desk.locator('.msgs').evaluate((el) => { el.scrollTop = 0 })
  await shot(desk, 'f-ps-02-panel')
  await panel.locator(`[data-testid=cbar-row][data-conv="${lec}"]`).click()
  await expect(desk).toHaveURL(new RegExp(`/projects/${A}/t/${lec}$`))
  await expect(bar(desk).getByTestId('cbar-current')).toContainText('클라우다이크 강의 준비안을 정리해 줘')
  await expect(bar(desk).getByTestId('cbar-current')).toContainText('이 주제의 메시지 6개 · 여기서 물으면 이 주제에 이어져요')
  await expect(userMsg(desk, '견적서 내용을 검토해 줘')).toHaveCount(0)
  await expect(userMsg(desk, '강의 표지도 만들어 줘')).toBeVisible()
  // its files only
  await expect(desk.getByTestId('artifact-list')).toHaveAttribute('data-scope', 'topic')
  await expect(desk.getByTestId('artifact-list')).toContainText('이 주제의 산출물')
  await expect(desk.getByTestId('artifact-row')).toHaveCount(2)
  await expect(desk.locator('[data-testid=artifact-row][data-file="견적_검토표.csv"]')).toHaveCount(0)
  await expect(desk.getByTestId('project-topic').nth(0)).toHaveAttribute('aria-current', 'true')
  await expect(box(desk)).toHaveAttribute('placeholder', '이 주제에 이어서 묻기')
  await shot(desk, 'f-ps-02-narrowed')
  // asked here: no router call, the sub-topic's conversation, the message stays in view
  const calls = router.calls.length
  await send(desk, '목차를 두 장으로 줄여 줘')
  expect(router.calls.length).toBe(calls)
  expect(agent.bodies.at(-1).conversation_id).toBe(lec)
  await expect(userMsg(desk, '목차를 두 장으로 줄여 줘')).toBeVisible()
  await expect.poll(async () => (await topicRows(A)).find((r) => r.conversation_id === lec)?.turns).toBe(3)
  // the other one from the list on the left
  await desk.locator(`[data-testid=project-topic][data-conv="${quote}"]`).click()
  await expect(desk).toHaveURL(new RegExp(`/projects/${A}/t/${quote}$`))
  await expect(desk.getByTestId('artifact-row')).toHaveCount(1)
  await expect(desk.locator('[data-testid=artifact-row][data-file="견적_검토표.csv"]')).toBeVisible()
  await expect(userMsg(desk, '목차를 두 장으로 줄여 줘')).toHaveCount(0)
  // 「전체」: the whole project again
  await bar(desk).getByTestId('cbar-all').click()
  await expect(desk).toHaveURL(new RegExp(`/projects/${A}$`))
  await expect(userMsg(desk, '목차를 두 장으로 줄여 줘')).toBeVisible()
  await expect(userMsg(desk, '견적서 내용을 검토해 줘')).toBeVisible()
  await expect(desk.getByTestId('artifact-list')).toHaveAttribute('data-scope', 'project')
  expect(desk.errors).toEqual([])
})

test('F-PS-03 답 위의 「↳ 주제」 표시를 누르면 그 주제로 좁혀진다', async () => {
  const quote = topicId('quote', A)
  await answer(desk, answerOf('견적서 내용을 검토해 줘')).locator('.ctx').click()
  await expect(desk).toHaveURL(new RegExp(`/projects/${A}/t/${quote}$`))
  await expect(bar(desk).getByTestId('cbar-current')).toContainText('견적서 내용을 검토해 줘')
  await desk.locator(`[data-project="${A}"]`).click()
  await expect(desk).toHaveURL(new RegExp(`/projects/${A}$`))
})

test('F-PS-04 주제가 생기기 전부터 있던 프로젝트 — 원래 대화가 프로젝트 이름의 첫 주제가 되고, 새 주제와 나뉘며, 다시 이어진다', async () => {
  const origin = `legacy-${STAMP}`
  D = await project('이음오피스 수정', origin)
  await S.q(`insert into pro_messages(thread_id, role, kind, content, created_at) values
    ($1,'user','text',$2, now() - interval '2 days'), ($1,'agent','text',$3, now() - interval '2 days' + interval '1 minute')`,
  [D, { text: '구글 문서 링크 읽어 줘', conv: origin }, { text: '문서를 읽었어요.', conv: origin }])
  await desk.goto(`/projects/${D}`)
  await expect(box(desk)).toBeVisible({ timeout: 20000 })
  await send(desk, '견적 단가표 초안 써 줘')
  const call = router.calls.at(-1)
  expect(call.user_uid).toBe(scope(D))
  expect(call.conversation_id).toBe(origin)
  expect(call.metadata.contexts.map((c) => [c.conversation_id, c.title])).toEqual([[origin, '이음오피스 수정']])
  await send(desk, '구글 문서 다시 요약해 줘')
  expect(agent.bodies.at(-1).conversation_id).toBe(origin)
  const rows = await topicRows(D)
  expect(rows.map((r) => r.conversation_id).sort()).toEqual([origin, topicId('quote', D)].sort())
  await expect(bar(desk).getByTestId('cbar-pill')).toHaveText(/주제 2개/, { timeout: 10000 })
  await expect(desk.locator(`[data-testid=project-topic][data-conv="${origin}"]`)).toContainText('이음오피스 수정')
  // its old messages are the original topic's
  await desk.locator(`[data-testid=project-topic][data-conv="${origin}"]`).click()
  await expect(userMsg(desk, '구글 문서 링크 읽어 줘')).toBeVisible()
  await expect(userMsg(desk, '견적 단가표 초안 써 줘')).toHaveCount(0)
  await shot(desk, 'f-ps-04-adopted')
  expect(desk.errors).toEqual([])
})

test('F-PS-05 390px 휴대폰 — 막대 · 목록 창이 화면 안, 옆으로 밀리지 않음, 고르면 그 주제(밝은 · 밤)', async ({ browser }) => {
  const lec = topicId('lec', A)
  for (const theme of [null, 'dark']) {
    const phone = await page(browser, PHONE, { theme })
    await phone.goto(`/projects/${A}`)
    await expect(bar(phone).getByTestId('cbar-pill')).toBeVisible({ timeout: 20000 })
    expect(await noOverflow(phone)).toBe(true)
    await bar(phone).getByTestId('cbar-pill').tap()
    const panel = bar(phone).getByTestId('cbar-panel')
    await expect(panel).toBeVisible()
    const r = await panel.boundingBox()
    expect(r.x).toBeGreaterThanOrEqual(0)
    expect(r.x + r.width).toBeLessThanOrEqual(390 + 0.5)
    await shot(phone, `f-ps-05-phone-panel${theme ? '-dark' : ''}`)
    await panel.locator(`[data-testid=cbar-row][data-conv="${lec}"]`).tap()
    await expect(phone).toHaveURL(new RegExp(`/t/${lec}$`))
    await expect(bar(phone).getByTestId('cbar-current')).toBeVisible()
    await expect(userMsg(phone, '견적서 내용을 검토해 줘')).toHaveCount(0)
    expect(await noOverflow(phone)).toBe(true)
    const cur = await bar(phone).boundingBox()
    expect(cur.x + cur.width).toBeLessThanOrEqual(390 + 0.5)
    await shot(phone, `f-ps-05-phone-narrowed${theme ? '-dark' : ''}`)
    expect(phone.errors).toEqual([])
    await phone.context().close()
  }
})

test('F-PS-06 밤 테마의 넓은 화면 — 왼쪽 목록의 주제 행과 막대', async ({ browser }) => {
  const dark = await page(browser, DESK, { theme: 'dark' })
  await dark.goto(`/projects/${A}/t/${topicId('lec', A)}`)
  await expect(bar(dark).getByTestId('cbar-current')).toBeVisible({ timeout: 20000 })
  const on = dark.locator('[data-testid=project-topic][aria-current=true] .tn')
  await expect(on).toHaveCSS('color', 'rgb(245, 245, 247)')
  await shot(dark, 'f-ps-06-dark')
  expect(dark.errors).toEqual([])
  await dark.context().close()
})

test('F-PS-07 폴더에서 일하는 프로젝트 — 주제마다 대화는 따로, 변형은 프로젝트에 하나, 작업 폴더는 그 턴의 주제 대화 안', async () => {
  test.setTimeout(240_000)
  F = (await S.api(SY.token, '/threads', { method: 'POST', body: { text: '강의 자료 폴더에서 작업', newFolder: `강의 자료 ${STAMP}` } })).id
  await desk.goto(`/projects/${F}`)
  await expect(desk.getByTestId('project-folder-bar')).toBeVisible({ timeout: 20000 })
  const n = agent.bodies.length
  await send(desk, '강의 목차를 정리해 줘')
  // (the second turn waits for the first one's commit to the variation — a project's turns go one at a time)
  await box(desk).fill('견적 비교표를 검토해 줘')
  await box(desk).press('Enter')
  await expect(answer(desk, answerOf('견적 비교표를 검토해 줘'))).toBeVisible({ timeout: 120000 })
  const [b1, b2] = agent.bodies.slice(n)
  const lec = topicId('lec', F), quote = topicId('quote', F)
  expect([b1.conversation_id, b2.conversation_id]).toEqual([lec, quote])
  expect(b1.message).toContain(`/workspace/.bpmn/${lec}/folders/`)
  expect(b2.message).toContain(`/workspace/.bpmn/${quote}/folders/`)
  const vars = await S.q(`select branch from pro_folder_variations where source->>'thread_id'=$1`, [String(F)])
  expect(vars).toHaveLength(1)
  expect(b1.message).toContain(vars[0].branch)
  expect(b2.message).toContain(vars[0].branch)
  await expect(desk.getByTestId('project-folder-bar')).toBeVisible()
  await expect(bar(desk).getByTestId('cbar-pill')).toHaveText(/주제 2개/, { timeout: 10000 })
  await shot(desk, 'f-ps-07-folder')
  expect(desk.errors).toEqual([])
})

test('F-PS-08 라우터가 닿지 않으면 예전처럼 — 프로젝트의 대화로 답하고 오류 없음, 새 프로젝트에는 주제 막대가 없음', async () => {
  await new Promise((ok) => router.srv.close(ok))
  servers = servers.filter((s) => s !== router.srv)
  const lec = topicId('lec', A)
  await desk.goto(`/projects/${A}`)
  await expect(box(desk)).toBeVisible({ timeout: 20000 })
  const before = (await topicRows(A)).map((r) => `${r.conversation_id}:${r.turns}`)
  await send(desk, '참고할 만한 점을 짧게 알려 줘')
  // the conversation the project stood in, no new sub-topic, no failure
  expect(agent.bodies.at(-1).conversation_id).toBe(lec)
  expect((await topicRows(A)).map((r) => `${r.conversation_id}:${r.turns}`)).toEqual(before)
  await expect(desk.locator('.row.r-agent').filter({ hasText: '처리하지 못했어요' })).toHaveCount(0)
  // a project that never had sub-topics: as before (its one conversation, no bar)
  C = await project('팟캐스트 대본')
  await desk.goto(`/projects/${C}`)
  await expect(box(desk)).toBeVisible({ timeout: 20000 })
  await send(desk, '팟캐스트 대본 초안 써 줘')
  await send(desk, '두 번째 꼭지도 써 줘')
  // (the first turn has no conversation yet — the agent gives it one, which the project keeps — as before)
  const convs = agent.bodies.slice(-2).map((b) => b.conversation_id)
  const kept = (await S.q('select conversation_id from pro_threads where id=$1', [C]))[0].conversation_id
  expect(convs[0]).toBeNull()
  expect(kept).toMatch(/^agent-/)
  expect(convs[1]).toBe(kept)
  expect(await topicRows(C)).toEqual([])
  await expect(bar(desk)).toHaveCount(0)
  await expect(desk.getByTestId('project-topics')).toHaveCount(0)
  await shot(desk, 'f-ps-08-router-down')
  expect(desk.errors).toEqual([])
})
