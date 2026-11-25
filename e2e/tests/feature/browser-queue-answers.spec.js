// 기다리는 브라우저 작업과 입력창 · 줄 · 「마치고 해」 · 되풀이하는 일 · 짧은 결과 · 지시 · PDF 로 넣기 · 방 규칙 확인
// (2026-11-25 녹화 셋, 프로젝트 방 「링크 슬라이드 팟캐스트」: 「계속 이렇게 막히는 문제가 있어 … 여기서 마치고 해라 라고 했는데 마치기 전에
// 자꾸 다음 일을 하려고」 · 「이런거 필요없고 보고싶으면 볼 수 있겠으나」 · 「이걸 안하네요 … 끊김없이 이어져야 됩니다」 — 스펙 browser-handoff
// 「기다리는 작업에 입력창으로 답한다」 이하).
//   F-BQ-01 보기 카드를 기다리는 작업 + 입력창의 「새로 만들어」 → 그 카드의 답(채팅으로 답함), 새 작업 없음
//   F-BQ-02 답이 아닌 말 → 새 작업의 카드가 앞 작업이 물은 것과 세 갈래(첫 단추 = 판정) · 「뒤에 줄 세우기」 · 「앞 작업 멈추고 이것부터」(1280 · 390)
//   F-BQ-03 카드의 「이 말을 앞 작업의 답으로」 → 그 말이 앞 작업으로, 새 작업은 시작하지 않음
//   F-BQ-04 「작업을 마치고 아까 … 진행해」 → ① 멈춘 삭제가 같은 카드에서 다시 돌고 ② 는 「② 대기 중」, 답이 순서를 말함
//   F-BQ-05 되풀이하는 삭제는 동작 40번을 넘어 끝까지 — 「진행 중 · N개 처리」, 멈춤 없음, 결과는 한두 줄 + 「자세히 · N단계」(390)
//   F-BQ-06 「소스 0개」를 기다리는 동안 준 지시 → 「받은 지시」, 기다림이 끊기고 글을 PDF 로 저장해 「파일 업로드」로 넣음
//   F-BQ-08 이 방에서 AI 가 만든 PDF 카드 + 「이 PDF로 NotebookLM 팟캐스트」 → 묻지 않고 그 PDF 가 가짜 NotebookLM 에 올라감(390)
//   F-BQ-07 규칙이 있는 방에서 작업이 막 끝난 뒤 규칙처럼 들리는 말 → 「규칙을 바꿀까요?」, 「이번 작업에만 적용」은 그 작업을 이어서(390)
// 자기 스택(lib/localStack.js: BFF PRO_BACKGROUND=0 + Vite, 회사 bqueue-ui, 8955 · 5355 부터 빈 포트)에 가짜 모델 · 판정(:8956),
// 지어낸 사이트(:8957, server/test/fixtures/notebooks.mjs)로 돈다. 브라우저 작업은 그 BFF 의 진짜 Chromium 이 한다.
//   cd e2e && npx playwright test --project=feature tests/feature/browser-queue-answers.spec.js
// 사진: openspec/specs/browser-handoff/shots/bq*.png (BQ_SHOTS=<폴더> 로 바꿈)
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test, expect } from '@playwright/test'
import { startStack, SERVER } from '../../lib/localStack.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const SHOTS = process.env.BQ_SHOTS || path.resolve(here, '../../../openspec/specs/browser-handoff/shots')
// (no trace: Vite serves this repository and reloads every open page when a trace writes its .html resources under e2e/reports)
test.use({ channel: 'chromium', trace: 'off', video: 'off' })
test.describe.configure({ mode: 'serial' })

const NOWHERE = 'http://127.0.0.1:9'
const FAKE_PORT = 8956, SITE_PORT = 8957
const DESK = { viewport: { width: 1280, height: 800 }, locale: 'ko-KR' }
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ko-KR' }
const Q = '기존 노트북 중 어느 것에 만들까요? 목록에 없으면 아까 쓰던 소스를 알려 주세요.'
const OPTS = ['AX 컨설팅 해설 1 · Capgemini', 'AX 컨설팅 해설 2 · Accenture']

// ---- the fake model and judge (one server): the router by the person's words, the browser agent by its goal ----
const routes = {} // words the person sends → browser_task arguments
const scripts = {} // goal → { i, moves }
const titles = {} // goal → plan title
const verdicts = [] // [{ kind, said, p }] — the judge's answer for that kind of question about those words
const actions = []
const calls = { router: 0, judge: [] }
let site, S, P
const bodyOf = (req) => new Promise((ok) => { let raw = ''; req.on('data', (c) => { raw += c }); req.on('end', () => { try { ok(JSON.parse(raw)) } catch { ok({}) } }) })
const reply = (res, message) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', ...message }, finish_reason: 'stop' }] })) }
const tool = (res, name, args) => reply(res, { content: null, tool_calls: [{ id: `c_${crypto.randomUUID().slice(0, 8)}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] })
const lastPage = (b) => { const m = [...b.messages].reverse().find((x) => x.role === 'user' && typeof x.content === 'string' && x.content.startsWith('{')); return m ? JSON.parse(m.content.split('\n')[0]) : { els: [], text: '' } }
const lastTool = (b) => String([...b.messages].reverse().find((m) => m.role === 'tool')?.content || '')
const pick = (b, text) => lastPage(b).els.find((e) => e.text === text)?.i
const kindOf = (keys) => keys.includes('set_rule') ? 'room' : keys.includes('steer') && keys.includes('replace') ? 'active'
  : keys.includes('none') && keys.some((k) => /^(then|only|more)\d+$/.test(k)) ? 'resume' : keys.includes('none') && keys.some((k) => /^f\d+$/.test(k)) ? 'file'
    : keys.includes('named') && keys.includes('not') ? 'upload'
    : keys.includes('login_needed') ? 'wall' : keys.includes('idle') ? 'busy' : 'other'
const fakes = http.createServer(async (req, res) => {
  const b = await bodyOf(req)
  if (req.url.startsWith('/judge')) {
    const kind = kindOf((b.options || []).map((o) => o.key))
    calls.judge.push({ kind, state: b.state, keys: b.options.map((o) => o.key) })
    const v = verdicts.find((x) => x.kind === kind && String(b.state).includes(x.said))
    if (v) verdicts.splice(verdicts.indexOf(v), 1)
    const p = kind === 'wall' ? { ok: 1 } : kind === 'busy' ? { busy: 1 } : v?.p || (kind === 'room' ? { other: 1 } : ['resume', 'file'].includes(kind) ? { none: 1 } : kind === 'active' ? { other: 1 } : kind === 'upload' ? { not: 1 } : { new: 1 })
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ probabilities: p, model: 'fake' }))
  }
  if (!req.url.includes('/chat/completions')) { res.writeHead(404); return res.end() }
  const sys = String(b.messages?.[0]?.content || '')
  if (b.logprobs) return reply(res, { content: 'B' })
  if (/Break a web task/.test(sys)) { const g = String(b.messages[1].content).split('\n')[0]; return reply(res, { content: JSON.stringify({ title: titles[g] || g.slice(0, 30), steps: ['열기', '하기', '확인'] }) }) }
  const names = (b.tools || []).map((t) => t.function.name)
  if (names.includes('browser_task')) {
    calls.router++
    const said = String([...b.messages].reverse().find((m) => m.role === 'user')?.content || '').split('\n\n')[0]
    const r = Object.entries(routes).find(([k]) => said.includes(k))?.[1]
    return r ? tool(res, 'browser_task', r) : reply(res, { content: 'DELEGATE' })
  }
  if (names.includes('finish')) {
    const goal = (/Goal: (.*)/.exec(sys)?.[1] || '').trim()
    const s = scripts[goal]
    if (!s) return tool(res, 'finish', { summary: '끝났어요.' })
    if (b.tool_choice?.function?.name === 'finish') return tool(res, 'finish', { summary: '끝났어요.' })
    const move = s.moves[Math.min(s.i++, s.moves.length - 1)]
    if (move === 'hang') return
    const [name, args] = typeof move === 'function' ? move(b) : move
    return tool(res, name, args)
  }
  if (b.response_format && /이 방에 올라오는 링크나 파일로 할 일을 정했다|links or files put in this room from now on/.test(sys)) return reply(res, { content: JSON.stringify(actions.shift() || {}) })
  return reply(res, { content: b.response_format ? '{}' : 'DELEGATE' })
})
// the deletion rounds (the dialog's 「삭제」, else the menu's 「delete 삭제」, else a row's 「more_vert」, else finish)
const deleter = (b) => { const els = lastPage(b).els; const e = ['삭제', 'delete 삭제', 'more_vert'].map((t) => els.find((x) => x.text === t)).find(Boolean); return e ? ['click', { i: e.i }] : ['finish', { summary: '제목 없는 노트북을 모두 삭제했어요.' }] }
function asker(goal, title) {
  titles[goal] = title
  scripts[goal] = { i: 0, moves: [['need_user', { reason: Q, options: OPTS }], (b) => ['note', { text: `받은 답: ${lastTool(b)}` }], ['finish', { summary: `${title}을(를) 마쳤어요.` }]] }
}

async function pageAs(browser, opts) {
  const ctx = await browser.newContext({ ...opts, baseURL: S.web })
  await ctx.addInitScript((s) => { if (window.top === window) localStorage.setItem('pgpt-pro-session', s) }, JSON.stringify(P.session))
  const p = await ctx.newPage()
  p.errors = []
  p.on('pageerror', (e) => p.errors.push(String(e?.message || e)))
  return p
}
async function shot(p, name) {
  fs.mkdirSync(SHOTS, { recursive: true })
  await p.waitForTimeout(500)
  const file = path.join(SHOTS, `${name}.png`)
  await p.screenshot({ path: file })
  return file
}
const noOverflow = (p) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
async function room(title = '링크 슬라이드 팟캐스트') {
  const [t] = await S.q(`insert into pro_threads(user_id, kind, title) values ($1,'project',$2) returning id`, [P.id, title])
  return t.id
}
const box = (p) => p.locator('.composer textarea').first()
// a message sent from the composer, and on the server (not only on the screen)
async function say(p, text) {
  await box(p).fill(text)
  await box(p).press('Enter')
  await expect(p.locator('.row.r-user .bubble.user').filter({ hasText: text }).last()).toBeVisible({ timeout: 15000 })
  await expect.poll(async () => (await S.q(`select 1 from pro_messages m join pro_threads t on t.id=m.thread_id where t.user_id=$1 and m.role='user' and m.content->>'text'=$2`, [P.id, text])).length, { timeout: 15000 }).toBeGreaterThan(0)
}
const taskRow = async (tid, title) => (await S.q(`select id, content from pro_messages where thread_id=$1 and kind='task' and content->>'title'=$2 order by created_at desc limit 1`, [tid, title]))[0]
const tasksOf = async (tid) => S.q(`select id, content from pro_messages where thread_id=$1 and kind='task' order by created_at`, [tid])
const waitTask = (tid, title, ok, ms = 60000) => expect.poll(async () => ok((await taskRow(tid, title))?.content || {}), { timeout: ms }).toBe(true)
async function startAsker(p, tid, goal, title, words) {
  asker(goal, title)
  routes[words] = { goal, start_url: `${site.url}/ask`, ack: '노트 사이트에서 할게요.' }
  await say(p, words)
  await waitTask(tid, title, (c) => c.state === 'needs_input')
  await expect(p.locator('.row.k-choice .choice').last()).toBeVisible({ timeout: 20000 })
}

test.beforeAll(async () => {
  await new Promise((ok, no) => fakes.once('error', no).listen(FAKE_PORT, '127.0.0.1', ok))
  const { startNotebooks } = await import(pathToFileURL(path.join(SERVER, 'test/fixtures/notebooks.mjs')).href)
  site = await startNotebooks(SITE_PORT)
  S = await startStack({ tenant: 'bqueue-ui', apiFrom: 8955, webFrom: 5355, env: {
    PRO_JUDGE_URL: `http://127.0.0.1:${FAKE_PORT}/judge`, PRO_JUDGE_LLM: '0', PRO_LLM_BASE_URL: `http://127.0.0.1:${FAKE_PORT}/v1`, PRO_LLM_API_KEY: 'test',
    PRO_CONTEXT_ROUTER_URL: '', PRO_DEEPAGENTS_URL: NOWHERE, PRO_COMPLETION_URL: NOWHERE, PRO_MCP_HUB_URL: NOWHERE, PRO_MEMENTO_URL: NOWHERE, PRO_OFFICE_MCP_URL: NOWHERE,
    PRO_ONTOLOGY_BOLT_URL: 'bolt://127.0.0.1:9', PRO_BROWSER_PROFILES: fs.mkdtempSync(path.join(os.tmpdir(), 'bq-profiles-')), PRO_BROWSER_SKILLS_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'bq-skills-')) } })
  P = await S.person('pro-rt-bqueue-ui-a@uengine.org', '한서윤')
  await S.join(P)
  await S.q(`delete from pro_messages where thread_id in (select id from pro_threads where user_id=$1)`, [P.id])
  await S.q(`delete from pro_threads where user_id=$1`, [P.id])
})
test.afterAll(async () => {
  if (S) {
    fs.writeFileSync(path.join(os.tmpdir(), 'bq-bff.log'), S.logs.join(''))
    await S.q(`delete from pro_messages where thread_id in (select id from pro_threads where user_id=$1)`, [P?.id]).catch(() => {})
    await S.q(`delete from pro_threads where user_id=$1`, [P?.id]).catch(() => {})
    await S.stop()
  }
  await site?.close()
  await new Promise((ok) => { fakes.closeAllConnections?.(); fakes.close(ok) })
})

test('F-BQ-01 보기 카드를 기다리는 작업에 입력창으로 「새로 만들어」 → 그 카드의 답, 새 작업 없음', async ({ browser }) => {
  const p = await pageAs(browser, DESK)
  const tid = await room()
  await p.goto(`/projects/${tid}`)
  await expect(box(p)).toBeVisible({ timeout: 20000 })
  await startAsker(p, tid, 'NotebookLM 슬라이드 오디오 만들기', 'NotebookLM 슬라이드·오디오 오버뷰 생성', '노트북엘엠에서 이 링크로 노트 정리해 줘')
  const choice = p.locator('.row.k-choice').last()
  await expect(choice).toContainText(Q)
  const routed = calls.router
  verdicts.push({ kind: 'active', said: '새로 만들어', p: { o0: 0.02, o1: 0.03, answer: 0.88, steer: 0.03, replace: 0.02, other: 0.02 } })
  await say(p, '새로 만들어')
  await expect(p.locator('.row.r-agent.k-text').filter({ hasText: "'NotebookLM 슬라이드·오디오 오버뷰 생성' 작업의 답으로 전했어요." })).toBeVisible({ timeout: 20000 })
  await expect(choice.getByTestId('choice-answered')).toContainText('새로 만들어')
  await expect(choice.getByTestId('choice-typed')).toHaveText('채팅으로 답함')
  await shot(p, 'bq01-answered-1280')
  await waitTask(tid, 'NotebookLM 슬라이드·오디오 오버뷰 생성', (c) => c.state === 'done')
  expect(calls.router).toBe(routed)
  expect((await tasksOf(tid)).length).toBe(1)
  expect((await taskRow(tid, 'NotebookLM 슬라이드·오디오 오버뷰 생성')).content.notes.join(' ')).toContain('"새로 만들어"')
  expect(p.errors).toEqual([])
})

test('F-BQ-02 답이 아닌 말 → 새 작업의 카드가 앞 작업이 물은 것과 세 갈래를 보여 주고, 「뒤에 줄 세우기」 · 「앞 작업 멈추고 이것부터」가 그대로 된다', async ({ browser }) => {
  const p = await pageAs(browser, DESK)
  const tid = await room('노트북 고르기 방')
  await p.goto(`/projects/${tid}`)
  await expect(box(p)).toBeVisible({ timeout: 20000 })
  await startAsker(p, tid, '노트북 고르기 작업', '노트북 고르기', '노트북 하나 골라서 정리해 줘')
  const goal = '노트 사이트 첫 화면 열고 제목 적기'
  titles[goal] = '노트 사이트 제목 적기'
  scripts[goal] = { i: 0, moves: [(b) => ['note', { text: lastPage(b).title }], ['finish', { summary: '노트 사이트의 제목은 「노트 사이트」예요.' }]] }
  routes['제목도 적어'] = { goal, start_url: `${site.url}/ask`, ack: '노트 사이트를 열게요.' }
  verdicts.push({ kind: 'active', said: '제목도 적어', p: { o0: 0.02, o1: 0.02, answer: 0.06, steer: 0.05, replace: 0.1, other: 0.75 } })
  await say(p, '노트 사이트 제목도 적어 줘')
  const q = p.getByTestId('task-queue').last()
  await expect(q).toBeVisible({ timeout: 30000 })
  await expect(q.getByTestId('task-queue-why')).toContainText("앞 작업 '노트북 고르기'이(가) 입력을 기다리고 있어요")
  await expect(q.getByTestId('task-queue-question')).toContainText(Q)
  await expect(q.locator('.acts button')).toHaveText(['앞 작업 뒤에 줄 세우기', '이 말을 앞 작업의 답으로', '앞 작업 멈추고 이것부터', '취소'])
  await expect(q.getByTestId('task-q-after')).toHaveAttribute('data-default', 'yes')
  await q.scrollIntoViewIfNeeded()
  await shot(p, 'bq02-queue-1280')
  // the same room on a phone
  const ph = await pageAs(browser, PHONE)
  await ph.goto(`/projects/${tid}`)
  const q2 = ph.getByTestId('task-queue').last()
  await expect(q2).toBeVisible({ timeout: 20000 })
  await q2.scrollIntoViewIfNeeded()
  for (const b of await q2.locator('.acts button').all()) { const r = await b.boundingBox(); expect(r.x).toBeGreaterThanOrEqual(0); expect(r.x + r.width).toBeLessThanOrEqual(390.5) }
  expect(await noOverflow(ph)).toBe(true)
  await shot(ph, 'bq02-queue-390')
  await ph.context().close()
  // 「앞 작업 뒤에 줄 세우기」: in line still, only 이것부터 · 취소 left
  await q.getByTestId('task-q-after').click()
  await expect(q.locator('.acts button')).toHaveText(['앞 작업 멈추고 이것부터', '취소'])
  // 「앞 작업 멈추고 이것부터」: the one ahead stops saying why, this one runs
  await q.getByTestId('task-q-first').click()
  await waitTask(tid, '노트북 고르기', (c) => c.state === 'cancelled' && /'노트 사이트 제목 적기'부터 하려고 멈췄어요/.test(c.summary))
  await waitTask(tid, '노트 사이트 제목 적기', (c) => c.state === 'done')
  await expect(p.getByTestId('task-queue')).toHaveCount(0)
  expect(p.errors).toEqual([])
})

test('F-BQ-03 카드의 「이 말을 앞 작업의 답으로」 → 그 말이 앞 작업의 답이 되고 새 작업은 시작하지 않는다', async ({ browser }) => {
  const p = await pageAs(browser, DESK)
  const tid = await room('노트북 정하기 방')
  await p.goto(`/projects/${tid}`)
  await expect(box(p)).toBeVisible({ timeout: 20000 })
  await startAsker(p, tid, '노트북 정하기 작업', '노트북 정하기', '노트북 정해서 정리해 줘')
  const goal = '새 노트북을 만든다'
  titles[goal] = '새 노트북 만들기'
  scripts[goal] = { i: 0, moves: [['finish', { summary: '시작되면 안 됨' }]] }
  routes['그냥 새 노트북으로'] = { goal, start_url: `${site.url}/ask`, ack: '새로 만들게요.' }
  verdicts.push({ kind: 'active', said: '그냥 새 노트북으로', p: { o0: 0.01, o1: 0.01, answer: 0.6, steer: 0.02, replace: 0.06, other: 0.3 } })
  await say(p, '그냥 새 노트북으로')
  const q = p.getByTestId('task-queue').last()
  await expect(q.getByTestId('task-q-answer')).toHaveAttribute('data-default', 'yes', { timeout: 30000 })
  await q.getByTestId('task-q-answer').click()
  await waitTask(tid, '새 노트북 만들기', (c) => c.state === 'cancelled' && c.summary === "이 말은 앞 작업 '노트북 정하기'의 답으로 보냈어요.")
  await expect(p.locator('.row.k-choice').last().getByTestId('choice-answered')).toContainText('그냥 새 노트북으로')
  await waitTask(tid, '노트북 정하기', (c) => c.state === 'done' && c.notes.join(' ').includes('"그냥 새 노트북으로"'))
  expect(scripts[goal].i).toBe(0)
  expect(p.errors).toEqual([])
})

test('F-BQ-04 「작업을 마치고 아까 노트북 엘엠 만들던거 진행해」 → ① 멈춘 삭제가 같은 카드에서 다시 돌고 ② 는 그 뒤, 답이 순서를 말한다', async ({ browser }) => {
  const p = await pageAs(browser, DESK)
  const tid = await room()
  await p.goto(`/projects/${tid}`)
  const del = "NotebookLM '제목없음' 노트북 모두 삭제"
  titles[del] = del
  scripts[del] = { i: 0, moves: [deleter, deleter, deleter, 'hang'] }
  routes['제목없음 노트북 모두 삭제해'] = { goal: del, start_url: `${site.url}/notebooks?n=5`, ack: '네, 제목이 "제목없음"인 노트북들을 모두 삭제할게요.' }
  await say(p, '노트북엘엠에서 제목없음 노트북 모두 삭제해 줘')
  await expect.poll(() => scripts[del].i, { timeout: 30000 }).toBeGreaterThanOrEqual(4)
  // the person stops it (its card's ✕) part way: three notebooks are gone
  await p.locator('.row.k-task').last().getByRole('button', { name: '작업 취소' }).click()
  await waitTask(tid, del, (c) => c.state === 'cancelled')
  // finish it, then the NotebookLM work
  scripts[del] = { i: 0, moves: [deleter] }
  const nb = 'NotebookLM 슬라이드·오디오 오버뷰 이어서 완료'
  titles[nb] = '슬라이드·오디오 오버뷰 완료'
  scripts[nb] = { i: 0, moves: [['wait_for_page', { minutes: 0.05, gone_text: '노트 사이트' }], ['note', { text: '시작' }], ['finish', { summary: '슬라이드와 오디오 오버뷰를 만들었어요.' }]] }
  const said = '작업을 마치고 아까 노트북 엘엠 만들던거 진행해.'
  routes[said] = { goal: nb, start_url: `${site.url}/ask`, ack: '네, 제목없음 노트북 삭제 작업이 끝나면 아까 하던 노트북LM 슬라이드·오디오 생성을 이어서 진행할게요.' }
  verdicts.push({ kind: 'resume', said, p: { then0: 0.91, only0: 0.03, more0: 0.03, none: 0.03 } })
  await say(p, said)
  await expect(p.locator('.row.r-agent.k-text').filter({ hasText: `① '${del}' 마저 끝내고 → ② '${nb}' 시작할게요.` })).toBeVisible({ timeout: 20000 })
  // ② waits, saying it comes after ①
  const second = p.getByTestId('task-queue').last()
  await expect(second.getByTestId('task-queue-why')).toHaveText(`① '${del}'을(를) 마저 끝내면 이어서 시작해요.`, { timeout: 20000 })
  await shot(p, 'bq04-order-1280')
  const first = await taskRow(tid, del)
  await waitTask(tid, del, (c) => c.state === 'done')
  expect((await taskRow(tid, del)).id).toBe(first.id)
  await waitTask(tid, '슬라이드·오디오 오버뷰 완료', (c) => c.state === 'done')
  expect((await tasksOf(tid)).map((t) => t.content.title)).toEqual([del, '슬라이드·오디오 오버뷰 완료'])
  expect(p.errors).toEqual([])
})

test('F-BQ-05 휴대폰: 되풀이하는 삭제는 동작 40번을 넘어 끝까지 — 「진행 중 · N개 처리」, 멈춤 없음, 결과는 한두 줄 + 「자세히 · N단계」', async ({ browser }) => {
  const p = await pageAs(browser, PHONE)
  const tid = await room('삭제 방')
  await p.goto(`/projects/${tid}`)
  const goal = '제목 없는 노트북 16개 모두 삭제'
  titles[goal] = '제목 없는 노트북 모두 삭제'
  scripts[goal] = { i: 0, moves: [deleter] }
  routes['16개 모두 지워'] = { goal, start_url: `${site.url}/notebooks?n=16`, ack: '모두 지울게요.' }
  await say(p, '제목 없는 노트북 16개 모두 지워 줘')
  const badge = p.getByTestId('task-progress').first()
  // past the first 40 actions (13 rounds) the card is still at work and counting
  await expect(badge).toHaveText(/진행 중 · (1[3-9]|[2-9]\d)개 처리/, { timeout: 90000 })
  await expect(p.locator('.row.k-task .attn, .row.k-task .review')).toHaveCount(0)
  await badge.scrollIntoViewIfNeeded()
  await shot(p, 'bq05-progress-390')
  await waitTask(tid, '제목 없는 노트북 모두 삭제', (c) => c.state === 'done', 120000)
  const row = await taskRow(tid, '제목 없는 노트북 모두 삭제')
  expect(row.content.need ?? null).toBe(null)
  expect(row.content.did.length).toBeGreaterThan(40)
  // the result: a line, with what it did folded
  const msg = p.locator('.row.r-agent.k-text').filter({ hasText: '제목 없는 노트북을 모두 삭제했어요.' }).last()
  await expect(msg).toBeVisible({ timeout: 20000 })
  await expect(msg.locator('.bubble')).not.toContainText('실제로 한 일')
  const toggle = msg.getByTestId('task-detail-toggle')
  await expect(toggle).toHaveText(/자세히 · (4\d)단계/)
  await expect(msg.getByTestId('task-detail-body')).toHaveCount(0)
  await msg.scrollIntoViewIfNeeded()
  await shot(p, 'bq05-done-390')
  await toggle.click()
  await expect(msg.getByTestId('task-detail-body')).toContainText("'more_vert' 누르기")
  await toggle.evaluate((e) => e.scrollIntoView({ block: 'start' }))
  expect(await noOverflow(p)).toBe(true)
  await shot(p, 'bq05-done-detail-390')
  expect(p.errors).toEqual([])
})

test('F-BQ-06 「소스 0개」를 기다리는 동안 준 지시 → 「받은 지시」, 기다림이 끊기고 글을 PDF 로 저장해 「파일 업로드」로 넣는다', async ({ browser }) => {
  const p = await pageAs(browser, DESK)
  const tid = await room()
  await p.goto(`/projects/${tid}`)
  const goal = 'NotebookLM 새 노트북 생성 및 소스 추가'
  titles[goal] = goal
  const article = `${site.url}/article?host=blocked`
  const byType = (b, type) => lastPage(b).els.find((e) => e.type === type)?.i
  scripts[goal] = { i: 0, moves: [
    (b) => ['click', { i: pick(b, '웹사이트') }],
    (b) => ['type', { i: pick(b, 'URL 붙여넣기'), text: article }],
    (b) => ['click', { i: pick(b, '삽입') }],
    ['wait_for_page', { minutes: 2, gone_text: '소스 0개' }],
    // (what the skill says, and what the person just said: open it, print it, upload it)
    ['goto', { url: article }],
    ['save_pdf', { name: 'Agentic AI in practice' }],
    ['goto', { url: `${site.url}/nb` }],
    (b) => ['click', { i: pick(b, '파일 업로드') }],
    (b) => ['attach_file', { i: byType(b, 'file'), name: 'Agentic AI in practice.pdf' }],
    ['wait_for_page', { minutes: 0.2, until_text: '소스 1개' }],
    ['finish', { summary: 'Medium 글을 PDF 로 저장해 「Agentic AI in practice.pdf」 소스로 넣었어요.' }],
  ] }
  routes['노트북에 넣어 줘'] = { goal, start_url: `${site.url}/nb`, ack: '네, 노트북을 만들고 소스로 넣을게요.' }
  await say(p, `이 글 노트북에 넣어 줘 ${article}`)
  await expect.poll(() => scripts[goal].i, { timeout: 30000 }).toBeGreaterThanOrEqual(4)
  await p.waitForTimeout(1500)
  const steer = '미디엄은 접근 권한 문제가 있으니, 내 계정으로 접근해서 인쇄시킨 후, pdf 등으로 만든후에 노트북엘엠에 넣어야 해.'
  verdicts.push({ kind: 'active', said: '미디엄은 접근 권한', p: { steer: 0.86, replace: 0.04, other: 0.1 } })
  // (the PDF it prints is not a file the person attached: it goes to NotebookLM because their own words named both — judged)
  verdicts.push({ kind: 'upload', said: '미디엄은 접근 권한', p: { named: 0.9, not: 0.1 } })
  const t0 = Date.now()
  await say(p, steer)
  await expect(p.locator('.row.r-agent.k-text').filter({ hasText: `'${goal}' 작업에 그대로 전했어요.` })).toBeVisible({ timeout: 20000 })
  const heard = p.getByTestId('task-heard').last()
  await expect(heard).toContainText('받은 지시')
  await expect(heard).toContainText('미디엄은 접근 권한 문제가 있으니')
  await heard.scrollIntoViewIfNeeded()
  await shot(p, 'bq06-steered-1280')
  await waitTask(tid, goal, (c) => c.state === 'done')
  expect(Date.now() - t0).toBeLessThan(60000)
  await expect(p.locator('.row.k-file').filter({ hasText: 'Agentic AI in practice.pdf' })).toBeVisible({ timeout: 20000 })
  const row = await taskRow(tid, goal)
  expect(row.content.files.map((f) => f.name)).toContain('Agentic AI in practice.pdf')
  expect(calls.judge.filter((c) => c.kind === 'upload').at(-1).state).toContain('올릴 파일: Agentic AI in practice.pdf')
  await expect(p.locator('.row.k-choice')).toHaveCount(0)
  await p.locator('.row.k-file').filter({ hasText: 'Agentic AI in practice.pdf' }).scrollIntoViewIfNeeded()
  await shot(p, 'bq06-pdf-uploaded-1280')
  expect(p.errors).toEqual([])
})

test('F-BQ-07 휴대폰: 규칙이 있는 방, 작업이 막 끝난 뒤 규칙처럼 들리는 말 → 「규칙을 바꿀까요?」 — 「이번 작업에만 적용」은 그 작업을 이어서, 규칙은 그대로', async ({ browser }) => {
  const p = await pageAs(browser, PHONE)
  const tid = await room()
  const RULE = '이 링크로 노트북 LM 의 슬라이드와 팟캐스트를 만든다'
  await S.q(`insert into pro_messages(thread_id,role,kind,content) values ($1,'agent','text',$2)`, [tid, { text: `알겠습니다.\n${RULE}`, roomRule: { said: '링크는 슬라이드 팟캐스트로', action: RULE, skill: '', runs: 2 } }])
  await p.goto(`/projects/${tid}`)
  const goal = 'https://blocked.example/a 로 노트북 만들기'
  titles[goal] = '노트북 만들기'
  scripts[goal] = { i: 0, moves: [(b) => ['click', { i: pick(b, '새 노트북') }], ['finish', { summary: '새 노트북은 만들었지만 글은 소스로 들어가지 않았어요. 원하시면 다른 방식으로 이어서 해 드릴게요.' }]] }
  routes['blocked.example/a'] = { goal, start_url: `${site.url}/ask`, ack: '할게요.' }
  verdicts.push({ kind: 'room', said: 'blocked.example/a', p: { other: 1 } })
  await say(p, 'https://blocked.example/a 로 노트북 만들어 줘')
  await waitTask(tid, '노트북 만들기', (c) => c.state === 'done')
  const said = '미디엄은 접근 권한 문제가 있으니 pdf 로 만든 후에 넣어야 해'
  verdicts.push({ kind: 'resume', said, p: { more0: 0.3, none: 0.7 } })
  verdicts.push({ kind: 'room', said, p: { set_rule: 0.9, run_rule: 0.02, steer: 0.05, other: 0.03 } })
  actions.push({ action: '이 링크는 PDF 로 저장해 노트북 LM 에 넣는다', skill: '' })
  await say(p, said)
  const ask = p.getByTestId('rule-confirm').last()
  await expect(ask).toBeVisible({ timeout: 20000 })
  await expect(p.locator('.row.r-agent.k-text').filter({ has: ask })).toContainText('규칙을 바꿀까요?')
  await expect(p.locator('.row.r-agent.k-text').filter({ has: ask })).toContainText(`지금: ${RULE}`)
  await expect(ask.locator('button')).toHaveText(['바꾸기', '이번 작업에만 적용'])
  await ask.scrollIntoViewIfNeeded()
  expect(await noOverflow(p)).toBe(true)
  await shot(p, 'bq07-rule-confirm-390')
  titles[goal] = '노트북에 PDF 넣기'
  scripts[goal] = { i: 0, moves: [['note', { text: 'pdf' }], ['finish', { summary: 'PDF 로 넣었어요.' }]] }
  await ask.getByTestId('rule-confirm-once').click()
  await expect(ask.getByTestId('rule-confirm-done')).toHaveText('이번 작업에만 적용했어요')
  await waitTask(tid, '노트북에 PDF 넣기', (c) => c.state === 'done' && c.goal.endsWith(`이어서 할 일: ${said}`))
  await expect(p.getByTestId('room-rule')).toContainText(RULE)
  expect(p.errors).toEqual([])
})

test('F-BQ-08 휴대폰: 이 방에서 AI 가 만든 PDF 카드 + 「이 PDF로 NotebookLM 팟캐스트」 → 묻지 않고 그 PDF 가 NotebookLM 의 「파일 업로드」로 올라간다', async ({ browser }) => {
  const p = await pageAs(browser, PHONE)
  const tid = await room()
  // the PDF the agent made earlier in this room: in its workspace, and its file card in the chat
  const { PGPT_ROOT } = await import(pathToFileURL(path.join(SERVER, 'lib/paths.js')).href)
  const name = '통신망 장애 온톨로지·광선로 단선 진단 보고서.pdf'
  const rel = `/workspace/.bpmn/bq-e2e-${crypto.randomBytes(3).toString('hex')}/${name}`
  const host = path.join(PGPT_ROOT, 'services/deepagents/workspace', S.tenant, rel.slice('/workspace/'.length))
  fs.mkdirSync(path.dirname(host), { recursive: true })
  fs.writeFileSync(host, Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n'))
  try {
    await S.q(`insert into pro_messages(thread_id,role,kind,content) values ($1,'agent','file',$2)`, [tid, { name, path: rel, size: 54 }])
    await p.goto(`/projects/${tid}`)
    await expect(box(p)).toBeVisible({ timeout: 20000 })
    const goal = 'NotebookLM 에 그 PDF 를 소스로 넣고 팟캐스트 만들기'
    titles[goal] = 'NotebookLM 팟캐스트'
    const byType = (b, type) => lastPage(b).els.find((e) => e.type === type)?.i
    scripts[goal] = { i: 0, moves: [(b) => ['click', { i: pick(b, '파일 업로드') }], (b) => ['attach_file', { i: byType(b, 'file'), name }],
      ['wait_for_page', { minutes: 0.2, until_text: '소스 1개' }], (b) => ['note', { text: lastPage(b).text.split('\n').find((l) => l.startsWith('소스')) }], ['finish', { summary: 'PDF 를 소스로 넣었어요.' }]] }
    routes['이 PDF로 NotebookLM 팟캐스트'] = { goal, start_url: `${site.url}/nb`, ack: '네, NotebookLM 브라우저를 열어 PDF를 소스로 넣고 팟캐스트를 만들게요.' }
    verdicts.push({ kind: 'file', said: goal, p: { f0: 0.93, none: 0.07 } })
    verdicts.push({ kind: 'upload', said: '이 PDF로 NotebookLM 팟캐스트', p: { named: 0.92, not: 0.08 } })
    await say(p, '이 PDF로 NotebookLM 팟캐스트 만들어 줘')
    await waitTask(tid, 'NotebookLM 팟캐스트', (c) => c.state === 'done')
    const row = await taskRow(tid, 'NotebookLM 팟캐스트')
    expect(row.content.notes.at(-1)).toBe(`소스 1개: ${name}`)
    expect(row.content.files.map((f) => f.name)).toEqual([name])
    await expect(p.locator('.row.k-choice')).toHaveCount(0)
    expect(calls.judge.filter((c) => c.kind === 'file').at(-1).keys).toEqual(['f0', 'none'])
    await p.locator('.row.k-task').last().scrollIntoViewIfNeeded()
    expect(await noOverflow(p)).toBe(true)
    await shot(p, 'bq08-made-pdf-uploaded-390')
    expect(p.errors).toEqual([])
  } finally { fs.rmSync(path.dirname(host), { recursive: true, force: true }) }
})
