// 프로젝트 계획 — 프로젝트의 목적 · 약속을 그 방의 모든 대화가 먼저 읽는다 (스펙 openspec/specs/project-room 「프로젝트 계획」 · room-rules
// 「계획에 넣는 말은 규칙을 덮어쓰지 않는다」, 설계 turnplan §4 · P2, 서버 lib/projectNote.js, 화면 ProjectNote.vue · RoomRuleBar.vue).
// 2026-11-27 녹화(운영, 프로젝트 「링크 슬라이드 팟캐스트」): 「… 이 프로젝트에 대해서 클로드MD처럼 뭔가 마스터 플랜 같은 이런게 있어야 되겠죠」.
//   F-PP-01 방 맨 위: 규칙 막대에 누가 하는지(「서버 브라우저: NotebookLM」), 그 아래 「프로젝트 계획 · <목적>」 칩 → 시트 「이 프로젝트의 모든 대화가
//           먼저 읽어요」, 다섯 칸, 고치면 저장되고 고친 항목만 「고정」 (PC · 밝은)
//   F-PP-02 규칙이 있는 방에서 작업에 준 세부 지시(11-25 의 문장) → 칩 「계획에 넣었어요: …」 · 되돌리기 · 계획 보기 — 규칙은 그대로, 계획 보기에 고정
//           항목, 되돌리기는 그 앞의 계획으로
//   F-PP-03 스킬 없는 규칙은 「에이전트가 처리」, 누르면 브라우저 스킬 · 에이전트 가운데 골라 바꾼다
//   F-PP-04 휴대폰 390(밝은): 칩 · 막대가 화면 안, 시트는 아래 시트이고 「저장」이 보이며 옆으로 밀리지 않음
//   F-PP-05 휴대폰 390(밤 테마): 같은 시트가 밤 색으로, 글이 배경보다 밝음
//   F-PP-06 계획이 없는 방에서 「앞으로 …」(11-27 07:05 의 문장) → 처음 채운 계획 칩(계획 보기만) · 규칙이 됨 · 습관은 생기지 않음
//   F-PP-07 계획은 방의 주인만 — 다른 사람은 404(읽기 · 고치기 · 되돌리기)
//   F-PP-08 바뀐 기록(11-27 사용자 「중간중간 방향을 개선하거나 수정한 내용 등이 이 파일에 관리」): 방에서 넣은 것 · 직접 고친 것이 시트의 「바뀐 기록」에
//           언제 · 누가 · 무엇이 · 보낸 메시지와 함께, 기록에서 되돌리면 그 변경만 빠지고 되돌린 것도 기록 · 채팅의 칩도 「되돌렸어요」
// 자기 스택(lib/localStack.js: 회사 projplan-ui 의 BFF + Vite, 8987 · 5387)을 띄우고 지운다. 가짜 판정 서버 · 모델 · deepagents 는 이 파일이 빈 포트에
// 띄운다 — 실제 모델 · 에이전트 · 공용 판정 서버는 부르지 않는다. 지어낸 사람: 정하윤 · 김서연.
//   cd e2e && RT_WORKERS=1 npx playwright test --project=feature tests/feature/project-plan.spec.js
import { test, expect } from '@playwright/test'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { startStack, REPO } from '../../lib/localStack.js'

test.describe.configure({ mode: 'serial' })
const SHOTS = path.join(REPO, 'openspec/specs/project-room/e2e/results')
const DESK = { viewport: { width: 1280, height: 860 }, locale: 'ko-KR' }
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ko-KR' }
const NOWHERE = 'http://127.0.0.1:9'
const TENANT = 'projplan-ui'
const PROMPTS = Object.fromEntries(['update', 'backfill', 'add'].map((k) => [k, fs.readFileSync(path.join(REPO, 'skills/project-plan/prompts', `${k}.md`), 'utf8').replace(/\s+$/, '')]))
const MEDIUM = '미디엄은 접근 권한 문제가 있으니, 내 계정으로 접근해서 인쇄시킨 후, pdf 등으로 만든후에 노트북엘엠에 넣어야 해.'
const AGAIN = '내가 입력한 url 의 내용은 항상 노트북 lm 으로 팟캐스트를 만들어야.'
const MISSION = '이 방에서 내가 주는 url이 있으면 그거를 받아다가 노트북엘엠으로 슬라이드를 만들고 그 팟캐스트를 하나 만들어 주면 돼'

// ---- the fake judge (PRO_JUDGE_URL): scripted probabilities for the room's question, otherwise the last option ----
const judge = { room: [], calls: [] }
// ---- the fake model: the plan's prompts (skills/project-plan) and the rule's write-down by what they ask, the rest as the app expects ----
const llm = { add: [], backfill: [], update: [], action: [] }
const script = { add: [], backfill: [], update: [], action: [] }
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms))
function answerLlm(b) {
  const sys = String(b.messages?.[0]?.content || '')
  const user = String(b.messages?.at(-1)?.content || '')
  if (b.logprobs) {
    const all = (b.messages || []).map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n')
    const pick = [...all.matchAll(/^([A-Z])\) /gm)].map((m) => m[1]).at(-1) || 'A'
    return { body: { choices: [{ message: { content: pick }, logprobs: { content: [{ token: pick, logprob: Math.log(0.9), top_logprobs: [{ token: pick, logprob: Math.log(0.9) }] }] } }] } }
  }
  if (sys.includes('what you understood and how the work will go')) return { content: JSON.stringify({ understood: '말씀을 이 프로젝트에 맞게 처리할게요.', steps: ['읽기', '처리'], tier: 'light', certainty: 'sure' }) }
  for (const k of ['add', 'backfill', 'update']) if (sys === PROMPTS[k]) { llm[k].push(user); return { content: JSON.stringify(script[k].shift() || {}) } }
  if (sys.startsWith('사용자가 앞으로 이 방에 올라오는 링크나 파일로 할 일을 정했다')) { llm.action.push(user); return { content: JSON.stringify(script.action.shift() || {}) } }
  if (b.tools) return { content: 'DELEGATE' }
  return { content: b.response_format ? '{}' : 'OK' }
}
let servers = []
const listen = (srv) => new Promise((ok, no) => srv.once('error', no).listen(0, '127.0.0.1', () => { servers.push(srv); ok(srv.address().port) }))
const bodyOf = (req) => new Promise((ok) => { let raw = ''; req.on('data', (c) => { raw += c }); req.on('end', () => { try { ok(JSON.parse(raw)) } catch { ok({}) } }) })
let S, HY, SY

test.beforeAll(async () => {
  test.setTimeout(240_000)
  fs.mkdirSync(SHOTS, { recursive: true })
  const judgePort = await listen(http.createServer(async (req, res) => {
    const b = await bodyOf(req)
    if (!req.url.startsWith('/judge')) { res.writeHead(404); return res.end() }
    const keys = (b.options || []).map((o) => o.key)
    const room = keys.includes('set_rule')
    judge.calls.push({ ...b, room })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ probabilities: (room && judge.room.shift()) || { [keys.at(-1) || 'other']: 1 }, model: 'fake' }))
  }))
  const llmPort = await listen(http.createServer(async (req, res) => {
    const b = await bodyOf(req)
    const r = answerLlm(b)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(r.body || { choices: [{ message: { role: 'assistant', content: r.content }, finish_reason: 'stop' }] }))
  }))
  const agentPort = await listen(http.createServer(async (req, res) => {
    const b = await bodyOf(req)
    if (!req.url.startsWith('/chat/stream')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(req.url.startsWith('/chat/stop') ? '{"stopped":false}' : '[]') }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    if (b.conversation_id) res.write(`event: metadata\ndata: ${JSON.stringify({ conversation_id: b.conversation_id })}\n\n`)
    await sleep(200)
    res.write(`data: ${JSON.stringify({ type: 'done', content: '확인했어요.' })}\n\n`)
    res.end()
  }))
  S = await startStack({ tenant: TENANT, apiFrom: 8987, webFrom: 5387, env: {
    PRO_LLM_BASE_URL: `http://127.0.0.1:${llmPort}/v1`, PRO_LLM_API_KEY: 'fake', PRO_LLM_KEYS: 'off',
    PRO_LLM_MODEL: 'main-fake', PRO_LLM_FAST_MODEL: 'fast-fake', PRO_LLM_FRONT_MODEL: 'front-fake', PRO_LLM_ODDS_MODEL: 'fast-fake',
    PRO_DEEPAGENTS_URL: `http://127.0.0.1:${agentPort}`, PRO_CONTEXT_ROUTER_URL: '', PRO_COMPLETION_URL: NOWHERE,
    PRO_JUDGE_URL: `http://127.0.0.1:${judgePort}/judge`, PRO_JUDGE_LLM: '0', PRO_EMBED_URL: '',
  } })
  expect([S.apiPort, S.webPort]).toEqual([8987, 5387])
  HY = await S.person(`pro-rt-pp-${TENANT}-a@uengine.org`, '정하윤')
  SY = await S.person(`pro-rt-pp-${TENANT}-b@uengine.org`, '김서연')
  for (const p of [HY, SY]) await S.join(p)
  await S.api(HY.token, '/me/lang', { method: 'PUT', body: { lang: 'ko' } })
})
test.afterAll(async () => {
  for (const s of servers) await new Promise((ok) => s.close(ok))
  servers = []
  if (S) {
    fs.mkdirSync(path.join(REPO, 'e2e/reports'), { recursive: true })
    fs.writeFileSync(path.join(REPO, 'e2e/reports', `bff-${TENANT}.log`), S.logs.join(''))
    for (const p of [HY, SY].filter(Boolean)) {
      await S.q(`delete from pro_threads where user_id=$1 and kind='project'`, [p.id]).catch(() => {})
      await S.q(`delete from pro_followups where user_id=$1`, [p.id]).catch(() => {})
    }
    await S.stop()
  }
})

const PLAN = { v: 1, intent: '링크 · 파일을 NotebookLM 슬라이드와 팟캐스트로 만든다', deliverables: [{ text: '슬라이드' }, { text: '팟캐스트' }],
  tools: [{ name: 'NotebookLM', kind: 'browser_skill', ref: 'notebooklm', how: '서버 브라우저에서 소스로 넣고 만든다' }],
  constraints: [{ text: '오디오는 한국어로' }], decisions: [] }
async function room(title, { rule = null, skill = 'notebooklm', plan = PLAN, said = [] } = {}) {
  const [{ id }] = await S.q(`insert into pro_threads(user_id,kind,title) values ($1,'project',$2) returning id`, [HY.id, title])
  for (const [role, text] of said) await S.q(`insert into pro_messages(thread_id,role,kind,content) values ($1,$2,'text',$3)`, [id, role, { text }])
  if (rule) await S.q(`insert into pro_messages(thread_id,role,kind,content) values ($1,'agent','text',$2)`, [id, { text: `알겠습니다.\n${rule}`, roomRule: { said: '…', action: rule, skill, runs: 0 } }])
  if (plan) await S.q(`insert into pro_messages(thread_id,role,kind,content) values ($1,'system','note',$2)`, [id, { projectNote: { ...plan, editedBy: 'assistant' } }])
  return id
}
const noteOf = async (id) => (await S.q(`select content->'projectNote' as n from pro_messages where thread_id=$1 and kind='note' order by created_at desc limit 1`, [id]))[0]?.n || null
async function open(browser, opts, { theme = 'light' } = {}) {
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
  return p
}
const calm = (p) => p.evaluate(() => Promise.race([Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming?.().iterations !== Infinity).map((a) => a.finished.catch(() => {}))), new Promise((ok) => setTimeout(ok, 2000))]))
const shot = async (p, name) => { await calm(p); await p.waitForTimeout(250); await p.screenshot({ path: path.join(SHOTS, `${name}.png`) }) }
const noOverflow = (p) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
const composer = (p) => p.locator('[data-test="chat-composer"] textarea').last()
async function send(p, text) { await composer(p).fill(text); await composer(p).press('Enter') }
const inView = async (loc, p) => {
  const b = await loc.boundingBox()
  const v = p.viewportSize()
  expect(b, 'on screen').toBeTruthy()
  expect(b.x).toBeGreaterThanOrEqual(-0.5)
  expect(b.x + b.width).toBeLessThanOrEqual(v.width + 0.5)
  expect(b.y + b.height).toBeLessThanOrEqual(v.height + 0.5)
  return b
}

test('F-PP-01 방 맨 위의 규칙 막대(누가 하는지)와 「프로젝트 계획」 칩 → 시트, 다섯 칸, 고친 항목만 고정', async ({ browser }) => {
  const id = await room('링크 슬라이드 팟캐스트', { rule: '이 링크나 파일로 NotebookLM 의 슬라이드와 팟캐스트를 만든다' })
  const p = await open(browser, DESK)
  await p.goto(`/projects/${id}`)
  await expect(p.getByTestId('room-rule-skill')).toHaveText('서버 브라우저: NotebookLM')
  const chip = p.getByTestId('project-plan-chip')
  await expect(chip).toContainText('프로젝트 계획')
  await expect(chip).toContainText(PLAN.intent)
  await chip.click()
  const sheet = p.getByTestId('project-plan-sheet')
  await expect(sheet).toBeVisible()
  await expect(sheet).toContainText('이 프로젝트의 모든 대화가 먼저 읽어요')
  for (const t of ['목적', '쓰는 도구', '만들 것', '지킬 것', '정한 것']) await expect(sheet.locator('h4').filter({ hasText: t })).toHaveCount(1)
  await expect(sheet.getByTestId('plan-intent')).toHaveValue(PLAN.intent)
  await expect(sheet.getByTestId('plan-tool-skill')).toHaveValue('notebooklm')
  await expect(sheet.getByTestId('plan-pinned')).toHaveCount(0)
  // edit: one constraint changed, a decision added
  await sheet.getByTestId('plan-constraints').getByTestId('plan-item-text').first().fill('오디오는 한국어, 슬라이드는 10장 안으로')
  await sheet.getByTestId('plan-add-decisions').click()
  await sheet.getByTestId('plan-decisions').getByTestId('plan-item-text').last().fill('완성본은 이 방에 파일로 올린다')
  await shot(p, 'f-pp-01-sheet')
  await sheet.getByTestId('plan-save').click()
  await expect(sheet.getByTestId('plan-saved')).toBeVisible()
  const n = await noteOf(id)
  expect(n.editedBy).toBe('person')
  expect(n.constraints).toEqual([{ text: '오디오는 한국어, 슬라이드는 10장 안으로', pinned: true }])
  expect(n.decisions).toEqual([{ text: '완성본은 이 방에 파일로 올린다', pinned: true }])
  expect(n.deliverables.every((x) => !x.pinned), '고치지 않은 항목은 고정되지 않는다').toBe(true)
  await expect(sheet.getByTestId('plan-pinned')).toHaveCount(2)
  await p.keyboard.press('Escape')
  await expect(sheet).toHaveCount(0)
  // the plan's rows are not chat messages
  await expect(p.locator('.row').filter({ hasText: 'projectNote' })).toHaveCount(0)
  expect(p.errors).toEqual([])
})

test('F-PP-02 규칙이 있는 방의 세부 지시(11-25) → 「계획에 넣었어요」 칩 — 규칙은 그대로, 계획 보기에 고정 항목, 되돌리기는 그 앞으로', async ({ browser }) => {
  const RULE = '이 링크나 파일로 NotebookLM 의 슬라이드와 팟캐스트를 만든다'
  const id = await room('링크 슬라이드 팟캐스트 2', { rule: RULE, said: [['user', MISSION]] })
  const p = await open(browser, DESK)
  await p.goto(`/projects/${id}`)
  await expect(p.getByTestId('room-rule')).toContainText(RULE)
  judge.room.push({ set_rule: 0.05, plan: 0.9, run_rule: 0.03, other: 0.02 })
  script.add.push({ to: 'constraints', text: '미디엄 글은 내 계정으로 접속해 인쇄한 뒤 PDF 로 만들어 NotebookLM 에 넣는다', replaces: '' })
  await send(p, MEDIUM)
  const chg = p.getByTestId('plan-change').last()
  await expect(chg.getByTestId('plan-change-text')).toHaveText('계획에 넣었어요: 미디엄 글은 내 계정으로 접속해 인쇄한 뒤 PDF 로 만들어 NotebookLM 에 넣는다', { timeout: 20000 })
  await expect(chg.getByTestId('plan-change-undo')).toBeVisible()
  await expect(chg.getByTestId('plan-change-open')).toBeVisible()
  // the rule did not change, and no 「규칙을 바꿀까요?」
  await expect(p.getByTestId('room-rule')).toContainText(RULE)
  await expect(p.getByTestId('rule-confirm')).toHaveCount(0)
  expect(judge.calls.filter((c) => c.room).at(-1).options.map((o) => o.key)).toEqual(['set_rule', 'plan', 'run_rule', 'other'])
  await shot(p, 'f-pp-02-chip')
  await chg.getByTestId('plan-change-open').click()
  const sheet = p.getByTestId('project-plan-sheet')
  await expect(sheet).toBeVisible()
  const items = sheet.getByTestId('plan-constraints').getByTestId('plan-item')
  await expect(items).toHaveCount(2)
  await expect(items.last().getByTestId('plan-item-text')).toHaveValue('미디엄 글은 내 계정으로 접속해 인쇄한 뒤 PDF 로 만들어 NotebookLM 에 넣는다')
  await expect(items.last().getByTestId('plan-pinned')).toHaveText('고정')
  await expect(items.first().getByTestId('plan-pinned')).toHaveCount(0)
  await shot(p, 'f-pp-02-sheet')
  await sheet.getByTestId('plan-close').click()
  await chg.getByTestId('plan-change-undo').click()
  await expect(chg.getByTestId('plan-change-undone')).toHaveText('되돌렸어요')
  await expect.poll(async () => (await noteOf(id)).constraints.map((x) => x.text)).toEqual(['오디오는 한국어로'])
  expect(p.errors).toEqual([])
})

test('F-PP-03 스킬 없는 규칙은 「에이전트가 처리」 — 누르면 브라우저 스킬 · 에이전트 가운데 골라 바꾼다', async ({ browser }) => {
  const id = await room('번역 방', { rule: '이 파일을 영어로 번역한다', skill: '' })
  const p = await open(browser, DESK)
  await p.goto(`/projects/${id}`)
  const who = p.getByTestId('room-rule-skill')
  await expect(who).toHaveText('에이전트가 처리')
  await who.click()
  const picker = p.getByTestId('room-rule-picker')
  await expect(picker).toBeVisible()
  await picker.locator('[data-skill="notebooklm"]').click()
  await expect(who).toHaveText('서버 브라우저: NotebookLM')
  expect((await S.q(`select content->'roomRule'->>'skill' as s from pro_messages where thread_id=$1 and content ? 'roomRule'`, [id]))[0].s).toBe('notebooklm')
  await who.click()
  await picker.locator('[data-skill=""]').click()
  await expect(who).toHaveText('에이전트가 처리')
  expect(p.errors).toEqual([])
})

for (const theme of ['light', 'dark']) {
  test(`F-PP-0${theme === 'light' ? 4 : 5} 휴대폰 390(${theme === 'light' ? '밝은' : '밤'} 테마) — 칩 · 막대가 화면 안, 아래 시트에 「저장」, 옆으로 밀리지 않음`, async ({ browser }) => {
    const id = await room(`휴대폰 방 ${theme}`, { rule: '이 링크나 파일로 NotebookLM 의 슬라이드와 팟캐스트를 만든다', plan: { ...PLAN, intent: `${PLAN.intent} — 미디엄 글은 내 계정으로 인쇄해 PDF 로 넣고, 오디오는 한국어로 만든다` } })
    const p = await open(browser, PHONE, { theme })
    await p.goto(`/projects/${id}`)
    const chip = p.getByTestId('project-plan-chip')
    await expect(chip).toBeVisible({ timeout: 20000 })
    await inView(chip, p)
    await inView(p.getByTestId('room-rule'), p)
    expect(await noOverflow(p)).toBe(true)
    await chip.tap()
    const sheet = p.getByTestId('project-plan-sheet')
    await expect(sheet).toBeVisible()
    await calm(p)
    const b = await inView(sheet, p)
    expect(Math.abs(b.y + b.height - 844), '아래 시트').toBeLessThanOrEqual(1)
    expect(b.width).toBeGreaterThanOrEqual(389)
    await inView(sheet.getByTestId('plan-save'), p)
    expect(await noOverflow(p)).toBe(true)
    if (theme === 'dark') {
      // the sheet in the night colors: its words lighter than its background
      const [fg, bg] = await sheet.evaluate((el) => { const cs = getComputedStyle(el); return [cs.color, cs.backgroundColor] })
      const lum = (c) => { const [r, g, bl] = c.match(/[\d.]+/g).map(Number); return 0.2126 * r + 0.7152 * g + 0.0722 * bl }
      expect(lum(fg)).toBeGreaterThan(lum(bg))
    }
    await shot(p, `f-pp-0${theme === 'light' ? 4 : 5}-phone-sheet${theme === 'dark' ? '-dark' : ''}`)
    expect(p.errors).toEqual([])
  })
}

test('F-PP-06 계획이 없는 방의 「앞으로 …」(11-27 07:05) → 처음 채운 계획 칩 · 규칙이 됨 · 습관은 생기지 않음', async ({ browser }) => {
  const id = await room('링크 슬라이드 팟캐스트 3', { plan: null, said: [['user', MISSION], ['agent', '알겠습니다. 이 방에 올리시는 링크와 파일은 앞으로 바로 처리할게요.'], ['user', MEDIUM]] })
  const p = await open(browser, DESK)
  await p.goto(`/projects/${id}`)
  await expect(p.getByTestId('project-plan-chip')).toContainText('아직 비어 있어요')
  script.backfill.push({ intent: '링크 · 파일을 NotebookLM 슬라이드 · 팟캐스트로 만든다', deliverables: ['슬라이드', '팟캐스트'],
    tools: [{ name: 'NotebookLM', kind: 'browser_skill', ref: 'notebooklm', how: '서버 브라우저에서' }], constraints: ['미디엄은 내 계정으로 인쇄해 PDF 로 넣는다'], decisions: [] })
  judge.room.push({ set_rule: 0.9, plan: 0.06, other: 0.04 })
  script.action.push({ action: '이 링크의 내용으로 NotebookLM 에서 팟캐스트를 만든다', skill: 'notebooklm' })
  await send(p, AGAIN)
  const filled = p.getByTestId('plan-change').filter({ hasText: '프로젝트 계획을 채웠어요' })
  await expect(filled).toContainText('링크 · 파일을 NotebookLM 슬라이드 · 팟캐스트로 만든다', { timeout: 20000 })
  await expect(filled.getByTestId('plan-change-undo')).toHaveCount(0)
  await expect(filled.getByTestId('plan-change-open')).toBeVisible()
  await expect(p.getByTestId('room-rule')).toContainText('이 링크의 내용으로 NotebookLM 에서 팟캐스트를 만든다', { timeout: 20000 })
  await expect(p.getByTestId('project-plan-chip')).toContainText('링크 · 파일을 NotebookLM 슬라이드 · 팟캐스트로 만든다')
  expect(llm.backfill.at(-1)).toContain(MISSION)
  expect(llm.action.at(-1)).toContain('[프로젝트 계획]')
  expect((await S.q('select 1 from pro_followups where user_id=$1', [HY.id])).length, '습관이 생기지 않는다').toBe(0)
  await shot(p, 'f-pp-06-backfill-rule')
  expect(p.errors).toEqual([])
})

test('F-PP-07 계획은 방의 주인만 — 다른 사람은 읽지도 고치지도 되돌리지도 못한다(404)', async () => {
  const id = await room('주인만 방')
  const mine = await S.api(HY.token, `/threads/${id}/note`)
  expect(mine.note.intent).toBe(PLAN.intent)
  for (const [method, p, body] of [['GET', `/threads/${id}/note`], ['PUT', `/threads/${id}/note`, { note: { intent: '남의 목적' } }], ['POST', `/threads/${id}/note/undo`, { chipId: '00000000-0000-4000-8000-000000000000' }]]) {
    const e = await S.api(SY.token, p, { method, body }).then(() => null, (x) => x)
    expect(e?.status, `${method} ${p}`).toBe(404)
  }
  expect((await noteOf(id)).intent).toBe(PLAN.intent)
})

test('F-PP-08 바뀐 기록 — 방에서 넣은 것 · 직접 고친 것이 언제 · 누가 · 무엇이 · 보낸 메시지와 함께, 기록에서 되돌리기', async ({ browser }) => {
  const id = await room('방향이 바뀌는 방')
  const p = await open(browser, DESK)
  await p.goto(`/projects/${id}`)
  await expect(p.getByTestId('project-plan-chip')).toBeVisible({ timeout: 20000 })
  const said = '앞으로 팟캐스트는 10분 안으로 하자'
  judge.room.push({ plan: 0.9, other: 0.1 })
  script.add.push({ to: 'decisions', text: '팟캐스트는 10분 안으로 만든다', replaces: '' })
  await send(p, said)
  await expect(p.getByTestId('plan-change').last()).toContainText('계획에 넣었어요: 팟캐스트는 10분 안으로 만든다', { timeout: 20000 })
  await p.getByTestId('project-plan-chip').click()
  const sheet = p.getByTestId('project-plan-sheet')
  const items = sheet.getByTestId('plan-history-item')
  await expect(items.first()).toHaveAttribute('data-kind', 'add')
  await expect(items.first().getByTestId('plan-history-text')).toHaveText('계획에 넣었어요: 팟캐스트는 10분 안으로 만든다')
  await expect(items.first().getByTestId('plan-history-from')).toContainText(said)
  await expect(items.first()).toContainText('나')
  await expect(items.first().locator('time')).not.toHaveText('')
  // by hand: a deliverable added — its own entry, on top
  await sheet.getByTestId('plan-add-deliverables').click()
  await sheet.getByTestId('plan-deliverables').getByTestId('plan-item-text').last().fill('팟캐스트 MP3')
  await sheet.getByTestId('plan-save').click()
  await expect(items.first()).toHaveAttribute('data-kind', 'edit')
  await expect(items.first().getByTestId('plan-history-text')).toHaveText('직접 고쳤어요: 팟캐스트 MP3')
  // revert the change made in the room (the hand edit after it stays)
  const added = items.filter({ hasText: '계획에 넣었어요: 팟캐스트는 10분 안으로 만든다' })
  await added.getByTestId('plan-history-revert').click()
  await expect(items.first()).toHaveAttribute('data-kind', 'revert')
  await expect(added.getByTestId('plan-history-reverted')).toHaveText('되돌렸어요')
  await expect(sheet.getByTestId('plan-decisions').getByTestId('plan-item')).toHaveCount(0)
  await expect(sheet.getByTestId('plan-deliverables').getByTestId('plan-item-text').last()).toHaveValue('팟캐스트 MP3')
  const n = await noteOf(id)
  expect(n.decisions).toEqual([])
  expect(n.deliverables.map((x) => x.text)).toContain('팟캐스트 MP3')
  await sheet.getByTestId('plan-history').scrollIntoViewIfNeeded()
  await shot(p, 'f-pp-08-history')
  await sheet.getByTestId('plan-close').click()
  await expect(p.getByTestId('plan-change').last().getByTestId('plan-change-undone')).toHaveText('되돌렸어요')
  expect(p.errors).toEqual([])
})

