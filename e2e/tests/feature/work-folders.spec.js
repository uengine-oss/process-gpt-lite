// 작업 폴더 · 버전, 한 턴의 많은 파일은 카드 하나 (스펙 openspec/specs/chat-artifacts 「한 턴의 결과물은 작업 폴더와 버전에」 · 「한 턴의 많은
// 파일은 카드 하나」 · 「목록은 작업 폴더 · 버전으로 묶고 같은 이름은 폴더로 가른다」). 2026-11-28 휴대폰 녹화: 한 턴이 파일 21개를 만들었고 채팅에
// 큰 파일 카드 21개가 쌓였다(README.md 여러 개, curriculum.md 두 개 …). 「폴더로 관리해서 버전 1, 버전 2 … 특정 폴더 안에다가 담아 가지고」.
//   F-WF-01 PC 1280(밝은): 21개를 만든 턴은 카드 하나 「파일 21개 · 폴더 5개」 — 위의 파일은 줄로, 폴더는 접힌 한 줄씩. 폴더를 누르면 펼치고 다시
//           누르면 접힘 · 「모두 펼치기」 · 「모두 접기」. 같은 이름은 폴더가 붙음(「README.md · starter/」). 줄을 누르면 카드처럼 열림(주소가 있는
//           문서는 이음오피스, 작업실에만 있는 파일은 작업실). 줄의 「⋯」은 카드의 메뉴. 작업 폴더 · 버전에 담긴 턴은 머리에 「커리큘럼 · v2」.
//           세 개 이하인 턴은 예전처럼 카드 하나씩
//   F-WF-02 휴대폰 390(밝은 · 어두운): 카드가 화면 안, 옆으로 밀리지 않음, 줄을 길게 누르면 카드의 메뉴
//   F-WF-03 PC 1440: 오른쪽 산출물 목록이 작업 폴더 · 버전으로 묶임 — 새 버전은 펼치고 옛 버전은 접힘, 같은 이름은 폴더가 붙음, 찾기는 폴더도 읽음
//   F-WF-04 휴대폰 390: 산출물 더미의 격자도 작업 폴더 · 버전 이름 아래 · 같은 이름은 폴더가 붙음
//   F-WF-06 (PR #135 검토) 실제 턴: 모델이 「process improvement plan」이라고 이름 지어도 process-* 가 아니라 work-process-improvement-plan/v1 —
//           파일은 카드로 남고(process-* 폴더면 프로세스 생성물로 읽혀 카드가 없음), 에이전트의 스크립트가 쓴 하위 폴더 깊은 곳의 파일
//           (syllabus/notes/…)도 카드 안에 들어옴
//   F-WF-05 실제 턴(가짜 모델 · 가짜 deepagents): 「만들어 줘」 → 에이전트에게 「작업 폴더: … '…/v1/'」, 파일 6개가 카드 하나로 · 「처음부터
//           다시」 → 모델이 v1 을 보고 「다시」로 판단, 에이전트에게 새 버전 v2 와 v1 을 그대로 두라는 줄, 두 번째 카드 「… · v2」
// 자기 스택(lib/localStack.js: 회사 work-folders-ui 의 BFF + Vite, 8941 · 5341 부터 빈 포트)과 이 파일이 띄우는 가짜 모델 · 가짜 deepagents
// (빈 포트)로 돈다. 사람은 지어낸 것이다(정하윤 · 한서윤, 「가나정밀 교육 과정」). 시험이 만든 행 · 파일은 끝나면 지운다.
//   cd e2e && RT_WORKERS=1 npx playwright test --project=feature tests/feature/work-folders.spec.js
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { test, expect } from '@playwright/test'
import { startStack, REPO, SERVER } from '../../lib/localStack.js'

const TENANT = 'work-folders-ui'
const SHOTS = path.join(REPO, 'openspec/specs/chat-artifacts/e2e/results')
const PC = { viewport: { width: 1280, height: 800 }, locale: 'ko-KR' }
const WIDE = { viewport: { width: 1440, height: 900 }, locale: 'ko-KR' }
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2, locale: 'ko-KR' }
const STAMP = crypto.randomBytes(3).toString('hex')
test.use({ channel: 'chromium' })
test.describe.configure({ mode: 'serial' })

// ---- the chat as four turns left it (the recording's shape first) ----
const OLD = `wf-old-${STAMP}`
const NEW = `wf-new-${STAMP}`
const TURN1 = ['README.md', 'constitution.md', 'spec.md', 'scenario.md', 'prompts.md',
  'adr/ADR-001.md', 'adr/ADR-002.md', 'adr/ADR-003.md', 'adr/ADR-004.md', 'adr/README.md',
  'curriculum/README.md', 'curriculum/curriculum.md', 'syllabus/curriculum.md', 'syllabus/week-1.md',
  'starter/README.md', 'starter/css/tokens.css', 'starter/css/base.css', 'starter/request.html', 'starter/index.html', 'starter/app.js', 'starter/notes.txt']
const TURN2 = ['README.md', 'syllabus/week-1.md', 'syllabus/week-2.md', 'starter/README.md', 'adr/ADR-001.md'].map((r) => `커리큘럼/v1/${r}`)
const TURN3 = ['README.md', 'syllabus/week-1.md', 'syllabus/week-2.md', 'syllabus/week-3.md', 'starter/README.md', 'adr/ADR-001.md'].map((r) => `커리큘럼/v2/${r}`)
const TURN4 = ['회의메모-1.md', '회의메모-2.md', '회의메모-3.md']
// (the documents these open: uploaded so they have an address, as a turn's published copies do)
const WITH_URL = new Set(['constitution.md', 'adr/ADR-004.md', '커리큘럼/v2/README.md'])

// ---- the fake model: the front plan, the work-folder question (what the test sets), DELEGATE for the chat's router ----
let servers = []
const listen = (srv) => new Promise((ok, no) => srv.once('error', no).listen(0, '127.0.0.1', () => { servers.push(srv); ok(srv.address().port) }))
const bodyOf = (req) => new Promise((ok) => { let raw = ''; req.on('data', (c) => { raw += c }); req.on('end', () => { try { ok(JSON.parse(raw)) } catch { ok({}) } }) })
const llm = { folder: [], answer: null }
const send = (res, o, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)) }
const say = (res, content) => send(res, { choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] })
const llmServer = () => http.createServer(async (req, res) => {
  const b = await bodyOf(req)
  const sys = String(b.messages?.[0]?.content || '')
  // (a folder judge's one token: refused — the cards' folder suggestions stay out of this test)
  if (b.logprobs) return send(res, { error: 'no' }, 500)
  if (sys.includes('what you understood and how the work will go')) return say(res, JSON.stringify({ understood: '가나정밀 신입 교육 과정 자료를 만들어 달라는 요청으로 이해했어요.', steps: ['과정 짜기', '자료 쓰기'], tier: 'standard', certainty: 'sure' }))
  if (sys.includes('keeps the files of one piece of work')) { llm.folder.push(String(b.messages?.[1]?.content || '')); return say(res, JSON.stringify(llm.answer || {})) }
  if (b.tools) return say(res, 'DELEGATE')
  return say(res, b.response_format ? '{}' : 'OK')
})
// ---- the fake deepagents: puts its files where the line it was given says (as an agent following it would) ----
const { PGPT_ROOT } = await import(path.join(SERVER, 'lib/paths.js'))
const workspace = () => path.join(PGPT_ROOT, 'services/deepagents/workspace', TENANT)
// files: written with a file_artifact event (dated back); scripted: written by the agent's own script — no event, found in the folder
const agent = { bodies: [], files: [], scripted: [] }
const agentServer = () => http.createServer(async (req, res) => {
  const b = await bodyOf(req)
  if (req.url.endsWith('/chat/stop')) return send(res, { stopped: false })
  if (!req.url.endsWith('/chat/stream')) return send(res, [])
  agent.bodies.push(b)
  const msg = String(b.message || '')
  const conv = b.conversation_id || `wf-live-${crypto.randomBytes(4).toString('hex')}`
  // the work folder the line named (「산출물 폴더 안의 '<dir>/'」), else the conversation's folder itself
  const dir = /\(작업 폴더: [^']*'([^']+)\/'/.exec(msg)?.[1] || ''
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write(`event: metadata\ndata: ${JSON.stringify({ conversation_id: conv })}\n\n`)
  res.write(`data: ${JSON.stringify({ type: 'token', content: dir ? `「${dir}」에 담았어요.` : '만들었어요.' })}\n\n`)
  for (const rel of agent.files.splice(0)) {
    const at = path.join(workspace(), '.bpmn', conv, dir, rel)
    fs.mkdirSync(path.dirname(at), { recursive: true })
    fs.writeFileSync(at, `# ${rel}\n\n가나정밀 신입 교육 과정 — ${rel}\n`)
    // (dated back: the server takes a document changed just before a turn started for that turn's own — this fast test's next turn comes
    // seconds later; this one is a card already, by its file_artifact — as project-topics.spec.js does)
    const past = new Date(Date.now() - 3600_000)
    fs.utimesSync(at, past, past)
    const p = ['/workspace/.bpmn', conv, dir, rel].filter(Boolean).join('/')
    res.write(`data: ${JSON.stringify({ type: 'file_artifact', name: rel.split('/').pop(), path: p, ext: rel.split('.').pop() })}\n\n`)
  }
  for (const rel of agent.scripted.splice(0)) {
    const at = path.join(workspace(), '.bpmn', conv, dir, rel)
    fs.mkdirSync(path.dirname(at), { recursive: true })
    fs.writeFileSync(at, `# ${rel}\n\n스크립트가 만든 파일 — ${rel}\n`)
  }
  res.write(`data: ${JSON.stringify({ type: 'done', content: dir ? `「${dir}」에 담았어요.` : '만들었어요.' })}\n\n`)
  res.end()
})

let S, HY, SY, MAIN
const people = []
const uploaded = []
async function attach(who, name, body) {
  const r = await fetch(`http://127.0.0.1:${S.apiPort}/api/attachments`, { method: 'POST', headers: { Authorization: `Bearer ${who.token}`, 'Content-Type': 'text/markdown', 'X-File-Name': encodeURIComponent(name) }, body })
  if (!r.ok) throw new Error(`attach ${name}: ${r.status} ${await r.text()}`)
  const j = await r.json()
  uploaded.push(j.url)
  return j
}
// one turn: the person's message, the answer, its files a second apart (as the server posts them)
async function turn(at, said, answer, room, rels) {
  await S.q(`insert into pro_messages(thread_id,role,kind,content,created_at) values ($1,'user','text',$2, now() - make_interval(secs => $3))`, [MAIN.id, { text: said }, at])
  await S.q(`insert into pro_messages(thread_id,role,kind,content,created_at) values ($1,'agent','text',$2, now() - make_interval(secs => $3))`, [MAIN.id, { text: answer }, at - 5])
  let i = 0
  for (const rel of rels) {
    const name = rel.split('/').pop()
    const c = { name, path: `/workspace/.bpmn/${room}/${rel}` }
    if (WITH_URL.has(rel)) c.url = (await attach(HY, name, `# ${name}\n\n가나정밀 교육 과정 — ${rel}\n`)).url
    // (an edited copy whose 검수 found something — lib/review.js)
    if (rel === 'spec.md' && room === OLD) c.review = { ok: false, summary: '표 두 개가 비었어요' }
    await S.q(`insert into pro_messages(thread_id,role,kind,content,created_at) values ($1,'agent','file',$2, now() - make_interval(secs => $3))`, [MAIN.id, c, at - 8 - i / 10])
    i++
  }
}

test.beforeAll(async () => {
  test.setTimeout(240_000)
  fs.mkdirSync(SHOTS, { recursive: true })
  const llmPort = await listen(llmServer())
  const agentPort = await listen(agentServer())
  S = await startStack({ tenant: TENANT, apiFrom: 8941, webFrom: 5341, env: {
    PRO_LLM_BASE_URL: `http://127.0.0.1:${llmPort}/v1`, PRO_LLM_API_KEY: 'fake', PRO_LLM_KEYS: 'off', PRO_DEEPAGENTS_URL: `http://127.0.0.1:${agentPort}`,
    PRO_CONTEXT_ROUTER_URL: '', PRO_COMPLETION_URL: 'http://127.0.0.1:9', PRO_JUDGE_URL: 'http://127.0.0.1:9/judge', PRO_MCP_HUB_URL: 'http://127.0.0.1:9',
    PRO_MEMENTO_URL: 'http://127.0.0.1:9', PRO_OFFICE_MCP_URL: 'http://127.0.0.1:9', PRO_EMBED_URL: '', PRO_ONTOLOGY_BOLT_URL: '',
  } })
  console.log(`[work-folders] stack on BFF ${S.apiPort} · web ${S.webPort}`)
  HY = await S.person(`pro-rt-${TENANT}-a@uengine.org`, '정하윤')
  SY = await S.person(`pro-rt-${TENANT}-b@uengine.org`, '한서윤')
  for (const who of [HY, SY]) { people.push(who); await S.join(who); await S.api(who.token, '/me/lang', { method: 'PUT', body: { lang: 'ko' } }) }
  for (const who of people) await S.q('delete from pro_messages where thread_id in (select id from pro_threads where user_id=$1)', [who.id])
  ;[MAIN] = await S.api(HY.token, '/threads')
  await turn(3600, '가나정밀 교육 과정을 스펙킷 방식으로 다시 짜 줘', '스펙킷 흐름에 맞춰 교육 과정 자료를 만들었어요.', OLD, TURN1)
  await turn(2400, '커리큘럼만 따로 정리해 줘', '커리큘럼을 버전 1로 정리했어요.', NEW, TURN2)
  await turn(1200, '방향이 별로야. 커리큘럼을 처음부터 다른 구성으로 다시 짜 줘', '새 구성으로 버전 2를 만들었어요. 버전 1은 그대로 두었어요.', NEW, TURN3)
  await turn(300, '오늘 회의 메모 세 개만 써 줘', '회의 메모 세 개예요.', NEW, TURN4)
})
test.afterAll(async () => {
  if (!S) return
  fs.mkdirSync(path.join(REPO, 'e2e/reports'), { recursive: true })
  fs.writeFileSync(path.join(REPO, 'e2e/reports', `bff-${TENANT}.log`), S.logs.join(''))
  const ids = people.map((p) => p.id)
  // (the stored copies: what the test uploaded, and what the live turn's cards were published as)
  const urls = await S.q(`select content->>'url' as url from pro_messages m join pro_threads t on t.id=m.thread_id where t.user_id = any($1::uuid[]) and m.kind='file'`, [ids]).catch(() => [])
  const keys = [...new Set([...uploaded, ...urls.map((u) => u.url)].map((u) => /\/object\/public\/files\/(.+)$/.exec(u || '')?.[1]).filter(Boolean).map(decodeURIComponent))]
  if (keys.length) { const { admin } = await import(path.join(SERVER, 'lib/supa.js')); await admin.storage.from('files').remove(keys).catch(() => {}) }
  for (const who of people) {
    await S.q('delete from pro_messages where thread_id in (select id from pro_threads where user_id=$1)', [who.id]).catch(() => {})
    await S.q('delete from pro_followups where user_id=$1', [who.id]).catch(() => {})
    await S.q('delete from context_threads where tenant_id=$1 and user_id=$2', [TENANT, who.id]).catch(() => {})
    await S.q('delete from pro_threads where user_id=$1', [who.id]).catch(() => {})
  }
  await S.q('delete from notifications where tenant_id=$1', [TENANT]).catch(() => {})
  await S.q('delete from pro_team_members where tenant_id=$1', [TENANT]).catch(() => {})
  await S.q('delete from users where tenant_id=$1', [TENANT]).catch(() => {})
  fs.rmSync(workspace(), { recursive: true, force: true })
  await S.stop()
  for (const s of servers) await new Promise((ok) => s.close(ok))
  servers = []
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
  return p
}
const calm = (p) => p.evaluate(() => Promise.race([Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming?.().iterations !== Infinity).map((a) => a.finished.catch(() => {}))), new Promise((ok) => setTimeout(ok, 1500))]))
const shot = async (p, name) => { await calm(p); await p.waitForTimeout(250); await p.screenshot({ path: path.join(SHOTS, `${name}.png`) }) }
const noSideScroll = async (p) => expect(await p.evaluate(() => document.scrollingElement.scrollWidth)).toBeLessThanOrEqual(await p.evaluate(() => window.innerWidth) + 1)
async function toChat(p, phone = false) {
  await p.goto('/chat')
  if (phone) await p.locator('.seg button').filter({ hasText: /^채팅$/ }).click()
}
const group = (p, n) => p.locator(`[data-test="file-group"][data-count="${n}"]`)
const row = (g, name) => g.locator(`[data-test="file-card"][data-file="${name}"]`)
const folder = (g, dir) => g.locator(`[data-test="file-group-folder"][data-dir="${dir}"]`)
// (twice: the chat may still be settling at its bottom as it loads)
async function center(loc) { for (const ms of [600, 300]) { await loc.evaluate((el) => el.scrollIntoView({ block: 'center' })); await loc.page().waitForTimeout(ms) } }
// a real touch held (Playwright has no long press) — as the context-menu tests do
async function press(p, el, ms = 700) {
  let b = await el.boundingBox()
  for (let i = 0; i < 20; i++) { await p.waitForTimeout(120); const n = await el.boundingBox(); if (n && b && Math.abs(n.y - b.y) < 1) break; b = n }
  const x = b.x + Math.min(b.width / 2, 60), y = b.y + b.height / 2
  await expect.poll(() => el.evaluate((node, [px, py]) => node.contains(document.elementFromPoint(px, py)), [x, y]), { timeout: 5000 }).toBe(true)
  const cdp = await p.context().newCDPSession(p)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
  await p.waitForTimeout(ms)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await cdp.detach().catch(() => {})
}

test('F-WF-01 PC 1280(밝은): 21개를 만든 턴은 카드 하나 — 폴더는 접힌 한 줄, 펼치고 접기, 같은 이름엔 폴더, 줄은 카드처럼 열리고 「⋯」은 카드의 메뉴', async ({ browser }) => {
  const p = await open(browser, HY, PC)
  await toChat(p)
  const g1 = group(p, 21)
  await expect(g1).toBeVisible({ timeout: 30000 })
  // one card for the turn's 21 — none of them a card of its own; the other turns' cards: 5 and 6 in their work folders, the three one by one
  await expect(p.locator('[data-test="file-group"]')).toHaveCount(3)
  await expect(g1.locator('[data-test="file-group-count"]')).toHaveText('파일 21개 · 폴더 5개')
  await expect(g1.locator('[data-test="file-group-where"]')).toHaveCount(0)
  for (const name of TURN4) await expect(p.locator(`.row.k-file [data-test="file-card"][data-file="${name}"]`)).toHaveCount(1)
  await expect(p.locator('.row.k-file [data-test="file-card"]')).toHaveCount(3)
  // the top's five rows (README.md says it is the one at the top), the five folders folded
  await expect(g1.locator(':scope > .tree > .fgr [data-test="file-card"]')).toHaveCount(5)
  await expect(row(g1, 'README.md').first().locator('[data-test="file-dir"]')).toHaveText('· 맨 위')
  await expect(row(g1, 'spec.md').locator('[data-test="file-dir"]')).toHaveCount(0)
  expect(await g1.locator('[data-test="file-group-folder"]').evaluateAll((bs) => bs.map((b) => b.dataset.dir))).toEqual(['adr', 'curriculum', 'starter', 'starter/css', 'syllabus'])
  await expect(g1.locator('[data-test="file-group-rows"]')).toHaveCount(0)
  await expect(folder(g1, 'adr')).toContainText('ADR-001.md · ADR-002.md 외 3개')
  const h1 = await g1.boundingBox()
  expect(h1.height).toBeLessThan(560)
  await center(g1)
  await shot(p, 'f-wf-01-pc-1280')
  // a folder pressed: its rows (README.md · starter/); pressed again: folded
  await folder(g1, 'starter').click()
  await expect(folder(g1, 'starter')).toHaveAttribute('aria-expanded', 'true')
  const starter = g1.locator('[data-test="file-group-rows"][data-dir="starter"]')
  await expect(starter.locator('[data-test="file-card"]')).toHaveCount(5)
  await expect(row(starter, 'README.md').locator('[data-test="file-dir"]')).toHaveText('· starter/')
  await center(folder(g1, 'starter'))
  await shot(p, 'f-wf-01-pc-folder-open')
  await folder(g1, 'starter').click()
  await expect(starter).toHaveCount(0)
  // 모두 펼치기 · 모두 접기
  await g1.locator('[data-test="file-group-toggle"]').click()
  await expect(g1.locator('[data-test="file-group-rows"]')).toHaveCount(5)
  await expect(g1.locator('[data-test="file-group-toggle"]')).toHaveText('모두 접기')
  await expect(row(g1.locator('[data-test="file-group-rows"][data-dir="syllabus"]'), 'curriculum.md').locator('[data-test="file-dir"]')).toHaveText('· syllabus/')
  await g1.locator('[data-test="file-group-toggle"]').click()
  await expect(g1.locator('[data-test="file-group-rows"]')).toHaveCount(0)
  // a row opens as its card would: a document with an address in IeumOffice
  await row(g1, 'constitution.md').locator('button.file').click()
  await expect(p.locator('[data-test="office-sheet"]')).toBeVisible({ timeout: 15000 })
  await expect(p.locator('.oef iframe.frm')).toHaveAttribute('src', /\/office\/markdown\/\?src=/)
  await p.keyboard.press('Escape')
  await p.locator('.oef .tb.ic[title="닫기"]').click().catch(() => {})
  await expect(p.locator('[data-test="office-sheet"]')).toHaveCount(0, { timeout: 10000 })
  // its ⋯: the card's menu (열기 · 팀원에게 공유 …), Esc closes it
  const r = row(g1, 'constitution.md')
  await r.locator('button.file').hover()
  await expect.poll(() => r.locator('[data-test="file-more"]').evaluate((el) => getComputedStyle(el).opacity)).toBe('1')
  // (PR #135 review) as its card: 공유 beside it with the pointer, the 검수 mark of an edited copy
  await expect.poll(() => r.locator('.rshare').evaluate((el) => getComputedStyle(el).opacity)).toBe('1')
  await expect(r.locator('.rshare')).toHaveAttribute('aria-label', 'constitution.md 공유')
  await expect(row(g1, 'spec.md').locator('[data-test="file-review"]')).toHaveText('검수 확인 필요')
  await expect(row(g1, 'spec.md').locator('[data-test="file-review"]')).toHaveAttribute('title', '표 두 개가 비었어요')
  await r.locator('[data-test="file-more"]').click()
  const menu = p.locator('[data-test="file-menu"]')
  await expect(menu).toBeVisible()
  await expect(menu.locator('.sub')).toHaveText('constitution.md')
  await expect(menu.locator('[data-test="file-menu-open"]')).toBeVisible()
  await shot(p, 'f-wf-01-pc-row-menu')
  await p.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  // right-click on a row: the same menu
  await row(g1, 'scenario.md').locator('button.file').click({ button: 'right' })
  await expect(menu.locator('.sub')).toHaveText('scenario.md')
  await p.keyboard.press('Escape')
  // the work folder's turns: 「커리큘럼 · v2」 over its files, and a file only in the workroom opens there — as a single card does
  const g3 = group(p, 6)
  await expect(g3.locator('[data-test="file-group-where"]')).toHaveText('커리큘럼 · v2')
  await expect(g3.locator('[data-test="file-group-count"]')).toHaveText('파일 6개 · 폴더 3개')
  await expect(group(p, 5).locator('[data-test="file-group-where"]')).toHaveText('커리큘럼 · v1')
  await center(g3)
  await shot(p, 'f-wf-01-pc-versions')
  await folder(g3, 'syllabus').click()
  await row(g3.locator('[data-test="file-group-rows"][data-dir="syllabus"]'), 'week-3.md').locator('button.file').click()
  await expect.poll(() => decodeURIComponent(p.url())).toContain(`/workroom/chat/${NEW}?open=커리큘럼/v2/syllabus/week-3.md`)
  await p.goBack()
  await expect(group(p, 21)).toBeVisible({ timeout: 20000 })
  await p.locator(`[data-test="file-card"][data-file="회의메모-1.md"] button.file`).click()
  await expect.poll(() => decodeURIComponent(p.url())).toContain(`/workroom/chat/${NEW}?open=회의메모-1.md`)
  expect(p.errors).toEqual([])
  await p.context().close()
})

for (const theme of ['light', 'dark']) {
  test(`F-WF-02 휴대폰 390(${theme === 'light' ? '밝은' : '어두운'}): 카드는 화면 안, 옆으로 밀리지 않음, 줄을 길게 누르면 카드의 메뉴`, async ({ browser }) => {
    const p = await open(browser, HY, PHONE, { theme })
    await toChat(p, true)
    const g1 = group(p, 21)
    await expect(g1).toBeVisible({ timeout: 30000 })
    expect(await p.evaluate(() => document.documentElement.dataset.theme)).toBe(theme)
    await center(g1)
    const b = await g1.boundingBox()
    expect(b.x).toBeGreaterThanOrEqual(0)
    expect(b.x + b.width).toBeLessThanOrEqual(390)
    await noSideScroll(p)
    // (the card is dark in both themes, as a file card is: its words light)
    expect(await g1.locator('[data-test="file-group-count"]').evaluate((el) => getComputedStyle(el).color)).toBe('rgb(245, 245, 247)')
    await shot(p, `f-wf-02-phone-${theme}`)
    await folder(g1, 'adr').tap()
    await expect(g1.locator('[data-test="file-group-rows"][data-dir="adr"] [data-test="file-card"]')).toHaveCount(5)
    await noSideScroll(p)
    // a phone's ⋯ takes no room — a long press on the row is its menu, not the file
    const r = row(g1.locator('[data-test="file-group-rows"][data-dir="adr"]'), 'ADR-004.md')
    expect((await r.locator('[data-test="file-more"]').boundingBox()).width).toBeLessThanOrEqual(1)
    // (a phone's 공유 is the menu's — no button per row)
    await expect(g1.locator('.rshare')).toHaveCount(0)
    await center(r)
    await shot(p, `f-wf-02-phone-folder-${theme}`)
    await press(p, r.locator('button.file'))
    const menu = p.locator('[data-test="file-menu"]')
    await expect(menu).toBeVisible()
    await expect(menu.locator('.sub')).toHaveText('ADR-004.md')
    await p.waitForTimeout(600)
    await expect(p.locator('[data-test="office-sheet"]')).toHaveCount(0)
    await shot(p, `f-wf-02-phone-menu-${theme}`)
    await menu.locator('[data-test="file-menu-close"]').tap()
    await expect(menu).toHaveCount(0)
    expect(p.errors).toEqual([])
    await p.context().close()
  })
}

test('F-WF-03 PC 1440: 산출물 목록은 작업 폴더 · 버전으로 묶이고(새 버전은 펼침 · 옛 버전은 접힘) 같은 이름엔 폴더, 찾기는 폴더도 읽음', async ({ browser }) => {
  const p = await open(browser, HY, WIDE)
  await toChat(p)
  const list = p.locator('[data-testid="artifact-list"]')
  await expect(list).toBeVisible({ timeout: 30000 })
  await expect(list.locator('[data-testid="artifact-count"]')).toHaveText('35')
  const sec = (f, v) => list.locator(`[data-testid="artifact-folder"][data-folder="${f}"][data-version="${v}"]`)
  await expect(sec('커리큘럼', '2')).toHaveAttribute('aria-expanded', 'true')
  await expect(sec('커리큘럼', '1')).toHaveAttribute('aria-expanded', 'false')
  await expect(sec('커리큘럼', '2')).toContainText('6')
  // the newest first: the three memos, then 커리큘럼 v2, then v1
  const order = await list.locator('[data-testid="artifact-folder"], [data-testid="artifact-row"]').evaluateAll((els) => els.slice(0, 5).map((e) => e.dataset.folder ? `${e.dataset.folder} v${e.dataset.version}` : e.dataset.file))
  expect(order).toEqual(['회의메모-3.md', '회의메모-2.md', '회의메모-1.md', '커리큘럼 v2', 'ADR-001.md'])
  // same names told apart by their folder: inside 커리큘럼 v2 its two README.md (starter/ · the top of v2); the first turn's README.md at the
  // top of the conversation's folder — the ones alone in their folder's section (starter · curriculum · adr) under that section's name
  const dirs = (await list.locator('[data-testid="artifact-row"][data-file="README.md"] [data-testid="artifact-dir"]').allTextContents()).map((t) => t.trim())
  expect(dirs).toEqual(['· starter/', '· 맨 위', '· 맨 위'])
  await expect(list.locator('[data-testid="artifact-row"][data-file="README.md"]')).toHaveCount(6)
  await expect(list.locator('[data-testid="artifact-row"][data-file="spec.md"] [data-testid="artifact-dir"]')).toHaveCount(0)
  await shot(p, 'f-wf-03-list-1440')
  // the older version opens when pressed
  await sec('커리큘럼', '1').click()
  await expect(sec('커리큘럼', '1')).toHaveAttribute('aria-expanded', 'true')
  await expect(list.locator('[data-testid="artifact-row"][data-file="week-2.md"]')).toHaveCount(2)
  // the search reads folders too: 「v1」 — the five files of 커리큘럼 v1
  await list.locator('[data-testid="artifact-search"]').fill('v1')
  await expect(list.locator('[data-testid="artifact-row"]')).toHaveCount(5)
  await list.locator('[data-testid="artifact-search"]').fill('')
  // a row opens as the chat card does
  await list.locator('[data-testid="artifact-row"][data-file="constitution.md"]').click()
  await expect(p.locator('[data-test="office-sheet"]')).toBeVisible({ timeout: 15000 })
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-WF-04 휴대폰 390: 산출물 더미의 격자도 작업 폴더 · 버전 이름 아래, 같은 이름엔 폴더', async ({ browser }) => {
  const p = await open(browser, HY, PHONE)
  await toChat(p, true)
  const pile = p.locator('.astack [data-test="pile"]')
  // (the chat loaded first: the pile closes when the view it belongs to changes)
  await expect(group(p, 21)).toBeVisible({ timeout: 30000 })
  await expect(pile).toBeVisible({ timeout: 30000 })
  // (it bobs: never still — pressed where it is)
  await pile.tap({ force: true })
  const grid = p.locator('.astack .grid')
  await expect(grid).toBeVisible()
  const caps = await grid.locator('[data-test="pile-folder"]').allTextContents()
  expect(caps.slice(0, 2)).toEqual(['커리큘럼 · v2', '커리큘럼 · v1'])
  await expect(grid.locator('[data-test="pile-item"][data-file="README.md"] small').filter({ hasText: 'README.md · starter/' })).toHaveCount(2)
  await expect(grid.locator('[data-test="pile-item"][data-file="README.md"] small').filter({ hasText: 'README.md · 맨 위' })).toHaveCount(3)
  await expect(grid.locator('[data-test="pile-item"][data-file="week-3.md"] small')).toHaveText('week-3.md')
  await expect(grid.locator('[data-test="pile-item"][data-file="spec.md"] small')).toHaveText('spec.md')
  // a card's message changing meanwhile (its folder suggestion saved — the server sends the message again) leaves the grid open
  const [card] = await S.q(`select id from pro_messages where thread_id=$1 and content->>'name'='constitution.md'`, [MAIN.id])
  await S.api(HY.token, '/filing/suggest', { method: 'POST', body: { messageId: card.id, refresh: true } }).catch(() => null)
  await p.waitForTimeout(1500)
  await expect(grid).toBeVisible()
  await noSideScroll(p)
  await shot(p, 'f-wf-04-phone-pile')
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-WF-05 실제 턴: 에이전트는 작업 폴더 · 버전을 듣고, 6개는 카드 하나 — 「처음부터 다시」는 v1 을 두고 v2', async ({ browser }) => {
  const p = await open(browser, SY, PC)
  await toChat(p)
  const box = p.locator('.composer textarea').first()
  await expect(box).toBeVisible({ timeout: 30000 })
  // 1) new work → v1
  llm.answer = { files: 'several', mode: 'new', folder: '', name: '신입 교육 과정', confidence: 0.92 }
  agent.files.push('README.md', 'constitution.md', 'syllabus/week-1.md', 'syllabus/week-2.md', 'starter/README.md', 'starter/tokens.css')
  await box.fill('가나정밀 신입 교육 과정을 스펙킷 방식으로 만들어 줘')
  await box.press('Enter')
  const g1 = p.locator('[data-test="file-group"]').first()
  await expect(g1).toBeVisible({ timeout: 60000 })
  await expect(g1.locator('[data-test="file-group-count"]')).toHaveText('파일 6개 · 폴더 2개', { timeout: 20000 })
  await expect(g1.locator('[data-test="file-group-where"]')).toHaveText('신입-교육-과정 · v1')
  const m1 = String(agent.bodies.at(-1)?.message || '')
  expect(m1).toContain("(작업 폴더: 이번 결과물은 산출물 폴더 안의 '신입-교육-과정/v1/' 에 두세요(이 일의 버전 1)")
  expect(llm.folder.at(-1)).toContain('Existing work folders in this conversation (JSON, one per line):\n(none)')
  expect(llm.folder.at(-1)).toContain('What the assistant understood: 가나정밀 신입 교육 과정 자료를')
  await expect(p.locator('.row.k-file')).toHaveCount(0)
  await shot(p, 'f-wf-05-live-v1')
  // 2) 「처음부터 다시」 → the model sees v1, the agent is told v2 and to keep v1
  llm.answer = { files: 'several', mode: 'redo', folder: '신입-교육-과정', name: '신입 교육 과정', confidence: 0.9 }
  agent.files.push('README.md', 'syllabus/week-1.md', 'syllabus/week-2.md', 'syllabus/week-3.md', 'starter/README.md')
  await box.fill('구성이 별로야. 처음부터 다른 구성으로 다시 만들어 줘')
  await box.press('Enter')
  await expect(p.locator('[data-test="file-group"]')).toHaveCount(2, { timeout: 60000 })
  const g2 = p.locator('[data-test="file-group"]').nth(1)
  await expect(g2.locator('[data-test="file-group-where"]')).toHaveText('신입-교육-과정 · v2', { timeout: 20000 })
  expect(llm.folder.at(-1)).toContain('- {"folder":"신입-교육-과정","versions":["v1"],"latest":"v1","files":[')
  const m2 = String(agent.bodies.at(-1)?.message || '')
  expect(m2).toContain("새 버전 산출물 폴더 안의 '신입-교육-과정/v2/' 에 두세요(버전 2)")
  expect(m2).toContain("이전 버전 산출물 폴더 안의 '신입-교육-과정/v1/' 의 파일은 고치거나 지우지 말고 그대로 두세요")
  // the first version's cards are still there, unchanged
  await expect(g1.locator('[data-test="file-group-count"]')).toHaveText('파일 6개 · 폴더 2개')
  const paths = (await S.q(`select content->>'path' as p from pro_messages m join pro_threads t on t.id=m.thread_id where t.user_id=$1 and m.kind='file' order by m.created_at`, [SY.id])).map((r) => r.p)
  expect(paths.filter((x) => x.includes('/신입-교육-과정/v1/'))).toHaveLength(6)
  expect(paths.filter((x) => x.includes('/신입-교육-과정/v2/'))).toHaveLength(5)
  await center(g2)
  await shot(p, 'f-wf-05-live-v2')
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-WF-06 실제 턴: 「process improvement plan」은 work-process-improvement-plan/v1 — 파일은 카드로, 스크립트가 하위 폴더 깊이 쓴 파일도', async ({ browser }) => {
  const p = await open(browser, SY, PC)
  await toChat(p)
  const box = p.locator('.composer textarea').first()
  await expect(box).toBeVisible({ timeout: 30000 })
  const groups = p.locator('[data-test="file-group"]')
  const n = await groups.count()
  llm.answer = { files: 'several', mode: 'new', folder: '', name: 'process improvement plan', confidence: 0.93 }
  agent.files.push('README.md', 'as-is.md', 'to-be.md', 'syllabus/roadmap.md')
  agent.scripted.push('syllabus/notes/kickoff.md')
  await box.fill('우리 팀 업무 처리 개선 계획 문서를 여러 개 만들어 줘')
  await box.press('Enter')
  await expect(groups).toHaveCount(n + 1, { timeout: 60000 })
  const g = groups.last()
  await expect(g.locator('[data-test="file-group-where"]')).toHaveText('work-process-improvement-plan · v1', { timeout: 20000 })
  await expect(g.locator('[data-test="file-group-count"]')).toHaveText('파일 5개 · 폴더 2개')
  expect(String(agent.bodies.at(-1)?.message || '')).toContain("산출물 폴더 안의 'work-process-improvement-plan/v1/' 에 두세요")
  // the file the agent's script wrote four folders down is a card of the turn too
  await g.locator('[data-test="file-group-folder"][data-dir="syllabus/notes"]').click()
  await expect(g.locator('[data-test="file-card"][data-file="kickoff.md"]')).toBeVisible()
  await center(g)
  await shot(p, 'f-wf-06-live-reserved-name')
  expect(p.errors).toEqual([])
  await p.context().close()
})
