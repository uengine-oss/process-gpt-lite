// 답을 공유 · 대화를 프로젝트로 (스펙 openspec/specs/answer-share · openspec/specs/chat-to-project, 서버 lib/answerShare.js · lib/chatProject.js,
// 화면 Message.vue · AnswerShareSheet.vue · ProjectOfferCard.vue · team/AnswerRefCard.vue). 2026-11-27 22:33 휴대폰 녹화:
// 「텍스트 결과가 나왔을 때 이것을 어딘가에 우리는 공유한다든지 하는 기능이 지금 존재하지 않아」 · 「이 내용을 가지고 … 프로젝트 하나 만들자 이렇게 말로 할
// 수도 있고」 · 「여기로 프로젝트로 승격하겠다는 거거든」 · 「템플릿 폴더가 좀 우리가 추천이 좀 필요할 수도 있고 … 교육과정 만드는 템플릿 폴더」.
//   F-AS-01 답 카드의 「공유」 → 대화방 · 사람에게 보내기 → 방 고르기 → 무엇이 보일지 확인 · 한마디 → 보내기 → 방에 도착(김서연이 AI 답 카드를 봄)
//   F-AS-02 「문서로 남기기」 → 채팅에 Markdown 파일 카드(공유 단추가 있는 보통 파일 카드)
//   F-AS-03 휴대폰 390(밝은 · 어두운): 길게 누르면 같은 메뉴가 아래 시트로, 「글 선택」, 화면 안 · 옆으로 밀리지 않음
//   F-CP-01 말로 「이 내용을 기반으로 프로젝트를 하나 만들자」 → 확인 카드(이름 · 추천 템플릿과 까닭 · 만들기) → 「프로젝트」 탭에 생김 · 계획에 목적 · 첫 문서 ·
//           채팅에 「프로젝트로 옮겼어요」(원래 대화는 그대로)
//   F-CP-02 답의 「프로젝트로 시작」 → 추천 템플릿 고르기 → 「템플릿으로 시작」과 같은 작업 공간 막대
//   F-CP-03 휴대폰 390(밝은 · 어두운): 확인 카드가 화면 안
// 자기 스택(lib/localStack.js: 회사 answer-project-ui 의 BFF + Vite, 8997 · 5397 에서 빈 곳)을 띄우고 지운다. 가짜 모델 · 가짜 deepagents 는 이 파일이
// 빈 포트에 띄운다 — 실제 모델 · 에이전트 · 판정 서버는 부르지 않는다. 사람 · 회사 · 메일은 지어낸 것이다(정하윤 · 김서연 · 박도윤, 가나정밀 이준호).
//   cd e2e && RT_WORKERS=1 npx playwright test --project=feature tests/feature/answer-share-project.spec.js
import { test, expect } from '@playwright/test'
import http from 'node:http'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { startStack, REPO } from '../../lib/localStack.js'

test.describe.configure({ mode: 'serial' })
const SHOTS = { share: path.join(REPO, 'openspec/specs/answer-share/e2e/results'), project: path.join(REPO, 'openspec/specs/chat-to-project/e2e/results') }
const DESK = { viewport: { width: 1280, height: 860 }, locale: 'ko-KR' }
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ko-KR' }
const NOWHERE = 'http://127.0.0.1:9'
const TENANT = 'answer-project-ui'
const WORDS = '이 내용을 기반으로 프로젝트를 하나 만들자'
const ANSWER = ['# 데이터 분석 실무 교육안', '', '요청 메일의 1차 교육(3일)을 기준으로 정리했어요. 신입 사원 대상, 실습 중심이에요.', '',
  '1. **1일차** — 스프레드시트 기초', '2. **2일차** — 대시보드 만들기 실습', '3. **3일차** — 발표와 피드백', '',
  '사전 확인: 참가자 수, 실습 노트북 준비 여부, 사내 예시 자료 제공 여부.'].join('\n')

// ---- the fake model ----
const llm = { routed: [], drafts: [] }
function answerLlm(b) {
  const all = (b.messages || []).map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n')
  const sys = String(b.messages?.[0]?.content || '')
  const last = String(b.messages?.at(-1)?.content || '')
  if (b.logprobs) {
    const options = [...all.matchAll(/^([A-Z])\) (.+)$/gm)].map((m) => ({ letter: m[1], label: m[2] }))
    // the template judge: the course template; every other reading: its last option (none · other)
    const pick = (options.find((o) => o.label.includes('「교육 과정 만들기 템플릿」')) || options.at(-1) || { letter: 'A' }).letter
    const other = options.find((o) => o.letter !== pick)?.letter || 'Z'
    return { choices: [{ message: { content: pick }, logprobs: { content: [{ token: pick, logprob: Math.log(0.88), top_logprobs: [{ token: pick, logprob: Math.log(0.88) }, { token: other, logprob: Math.log(0.12) }] }] } }] }
  }
  let content = b.response_format ? '{}' : 'OK'
  if (sys.includes('what you understood and how the work will go')) content = JSON.stringify({ understood: '이 대화를 프로젝트로 이어 가려고 하시는 것으로 이해했어요.', steps: ['내용 정리', '확인 카드 보이기'], tier: 'light', certainty: 'sure' })
  else if (sys.startsWith('너는 채팅에서 하던 이야기를')) {
    const user = String(b.messages?.[1]?.content || '')
    llm.drafts.push(user)
    const course = /- key (\S+): 「교육 과정 만들기 템플릿」/.exec(user)?.[1]
    content = JSON.stringify({ title: '가나정밀 1차 교육 과정', intent: '1차 교육 3일 과정의 교안과 실습 목록을 만든다', background: '받은 메일의 교육 요청을 채팅에서 조사한 내용에서 시작했어요',
      deliverables: ['일차별 교안', '실습 목록'], templates: course ? [{ key: course, why: '교안 양식과 교안을 만드는 스킬이 있어요' }] : [] })
  } else if (b.tools) {
    llm.routed.push(last)
    if (last.includes('프로젝트를 하나 만들자')) {
      return { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'start_project', arguments: JSON.stringify({ ack: '이 대화로 프로젝트를 시작할 수 있게 아래 카드를 준비했어요. 이름과 템플릿을 확인해 주세요.' }) } }] }, finish_reason: 'tool_calls' }] }
    }
    content = 'DELEGATE'
  }
  return { choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] }
}
let servers = []
const listen = (srv) => new Promise((ok, no) => srv.once('error', no).listen(0, '127.0.0.1', () => { servers.push(srv); ok(srv.address().port) }))
const bodyOf = (req) => new Promise((ok) => { let raw = ''; req.on('data', (c) => { raw += c }); req.on('end', () => { try { ok(JSON.parse(raw)) } catch { ok({}) } }) })
let S, HY, SY, DY, ROOM, COURSE, PROPOSAL, MAIN, ANS, PROJECT_WORDS

async function upload(who, slug, p, body) {
  const r = await fetch(`http://127.0.0.1:${S.apiPort}/api/folders/${slug}/files?path=${encodeURIComponent(p)}`, { method: 'POST', headers: { Authorization: `Bearer ${who.token}`, 'Content-Type': 'application/octet-stream' }, body })
  if (!r.ok) throw new Error(`upload ${p}: ${r.status} ${await r.text()}`)
}

const API_PORT = Number(process.env.RT_AP_API_PORT || 8997)
const WEB_PORT = Number(process.env.RT_AP_WEB_PORT || 5397)
const busy = (port) => { try { execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { stdio: 'ignore' }); return true } catch { return false } }

test.beforeAll(async () => {
  test.setTimeout(240_000)
  // (this file's own stack on these two ports: something else listening there — even on 127.0.0.1 only — would answer Vite's /api instead)
  for (const port of [API_PORT, WEB_PORT]) if (busy(port)) throw new Error(`port ${port} is in use — this file runs its own stack there (RT_AP_API_PORT · RT_AP_WEB_PORT)`)
  for (const d of Object.values(SHOTS)) fs.mkdirSync(d, { recursive: true })
  const llmPort = await listen(http.createServer(async (req, res) => {
    const b = await bodyOf(req)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(answerLlm(b)))
  }))
  const agentPort = await listen(http.createServer(async (req, res) => {
    const b = await bodyOf(req)
    if (!req.url.startsWith('/chat/stream')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(req.url.startsWith('/chat/stop') ? '{"stopped":false}' : '[]') }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    if (b.conversation_id) res.write(`event: metadata\ndata: ${JSON.stringify({ conversation_id: b.conversation_id })}\n\n`)
    res.write(`data: ${JSON.stringify({ type: 'done', content: '확인했어요.' })}\n\n`)
    res.end()
  }))
  S = await startStack({ tenant: TENANT, apiFrom: API_PORT, webFrom: WEB_PORT, env: {
    PRO_LLM_BASE_URL: `http://127.0.0.1:${llmPort}/v1`, PRO_LLM_API_KEY: 'fake', PRO_LLM_KEYS: 'off',
    PRO_LLM_MODEL: 'main-fake', PRO_LLM_FAST_MODEL: 'fast-fake', PRO_LLM_FRONT_MODEL: 'front-fake', PRO_LLM_ODDS_MODEL: 'fast-fake',
    PRO_DEEPAGENTS_URL: `http://127.0.0.1:${agentPort}`, PRO_CONTEXT_ROUTER_URL: '', PRO_COMPLETION_URL: NOWHERE, PRO_JUDGE_URL: NOWHERE, PRO_JUDGE_LLM: '0', PRO_EMBED_URL: '',
  } })
  if (S.apiPort !== API_PORT || S.webPort !== WEB_PORT) throw new Error(`the stack is not on ${API_PORT} · ${WEB_PORT}`)
  // (the BFF itself answers there — not another server's stand-in on the same port)
  const cfg = await S.api(null, '/config')
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error(`port ${API_PORT} answers as another server, not this stack's BFF`)
  console.log(`[answer-project] stack on BFF ${S.apiPort} · web ${S.webPort}`)
  HY = await S.person(`pro-rt-${TENANT}-a@uengine.org`, '정하윤')
  SY = await S.person(`pro-rt-${TENANT}-b@uengine.org`, '김서연')
  DY = await S.person(`pro-rt-${TENANT}-c@uengine.org`, '박도윤')
  for (const p of [HY, SY, DY]) await S.join(p)
  await S.api(HY.token, '/me/lang', { method: 'PUT', body: { lang: 'ko' } })
  ROOM = (await S.api(HY.token, '/team/threads', { method: 'POST', body: { members: [SY.id, DY.id], title: '가나정밀 교육 준비' } })).id
  // template folders 정하윤 may start from
  const mk = async (name, description) => S.api(HY.token, '/folders', { method: 'POST', body: { name, description } })
  COURSE = await mk('교육 과정 만들기 템플릿', '교육 과정을 설계할 때 쓰는 폴더')
  await upload(HY, COURSE.slug, 'TEMPLATE.md', '---\ndescription: 교육 과정을 설계하고 교안과 일정표를 만들 때 시작해요\noutputs: 산출물/\n---\n# 교육 과정 템플릿\n')
  await upload(HY, COURSE.slug, '교안 양식.md', '# 교안 양식\n\n## 과정 개요\n## 일차별 목표\n')
  await upload(HY, COURSE.slug, '.claude/skills/curriculum-builder/SKILL.md', '---\nname: curriculum-builder\ndescription: 일차별 교안과 실습 목록을 만들어요\n---\n1. 양식대로\n')
  PROPOSAL = await mk('제안서 템플릿', '제안서를 쓸 때 쓰는 폴더')
  await upload(HY, PROPOSAL.slug, 'TEMPLATE.md', '---\ndescription: 제안서를 쓸 때 시작해요\n---\n')
  for (const f of [COURSE, PROPOSAL]) await S.api(HY.token, `/folders/${f.slug}`, { method: 'PATCH', body: { template: true } })
  // 정하윤's chat: the mail's card, the question about it, the answer (a document answer — as in the recording)
  ;[MAIN] = await S.api(HY.token, '/threads')
  const [card] = await S.q(`insert into pro_actions(user_id,verb,text,source,status) values ($1,'Review',$2,$3,'done') returning id`, [HY.id, '1차 교육 요청', { mail_id: 'demo-ap-ui-1', from: '이준호 <junho@gana-precision.example>', subject: '1차 교육 과정 요청드립니다' }])
  await S.q(`insert into pro_messages(thread_id,role,kind,content,created_at) values ($1,'user','text',$2, now() - interval '2 minutes')`, [MAIN.id, { text: '받은 메일 중 1차 교육 요청 내용에 대해 조사해 줘', refs: [{ as: 'mail', actionId: card.id, name: '1차 교육 과정 요청드립니다', from: '이준호' }] }])
  ;[ANS] = await S.q(`insert into pro_messages(thread_id,role,kind,content,created_at) values ($1,'agent','doc',$2, now() - interval '1 minute') returning id`, [MAIN.id, { text: ANSWER, conv: 'conv-ap-ui', context: { conversationId: 'conv-ap-ui', action: 'new', title: '교육 요청 조사' } }])
  // a scheduled run came after it (filed aside, its own conversation): newer and long — not the answer 「이 내용으로 프로젝트」 is about (review M2)
  await S.q(`insert into pro_messages(thread_id,role,kind,content,created_at) values ($1,'agent','text',$2, now() - interval '30 seconds')`, [MAIN.id,
    { text: `주간 시장 동향 예약 실행 결과예요. ${'원자재 가격과 환율 흐름을 정리했어요. '.repeat(6)}`, conv: 'sched-ap-ui', context: { conversationId: 'sched-ap-ui', action: 'aside', title: '주간 시장 동향' } }])
})
test.afterAll(async () => {
  for (const s of servers) await new Promise((ok) => s.close(ok))
  servers = []
  if (!S) return
  fs.mkdirSync(path.join(REPO, 'e2e/reports'), { recursive: true })
  fs.writeFileSync(path.join(REPO, 'e2e/reports', `bff-${TENANT}.log`), S.logs.join(''))
  for (const p of [HY, SY, DY].filter(Boolean)) {
    await S.q('delete from pro_messages where thread_id in (select id from pro_threads where user_id=$1)', [p.id]).catch(() => {})
    await S.q('delete from pro_thread_folders where thread_id in (select id from pro_threads where user_id=$1)', [p.id]).catch(() => {})
    await S.q('delete from pro_threads where user_id=$1', [p.id]).catch(() => {})
    await S.q('delete from pro_actions where user_id=$1', [p.id]).catch(() => {})
    await S.q('delete from pro_followups where user_id=$1', [p.id]).catch(() => {})
    const keys = (await S.q(`select name from storage.objects where bucket_id='files' and starts_with(name, $1)`, [`pgpt-pro/${p.id}/`]).catch(() => [])).map((r) => r.name)
    if (keys.length) await S.q(`delete from storage.objects where bucket_id='files' and name = any($1)`, [keys]).catch(() => {})
  }
  for (const r of await S.q(`select id from chat_rooms where tenant_id=$1`, [TENANT]).catch(() => [])) {
    await S.q('delete from chats where id=$1', [r.id]).catch(() => {})
    await S.q('delete from pro_chat_reads where room_id=$1', [r.id]).catch(() => {})
    await S.q('delete from chat_rooms where id=$1', [r.id]).catch(() => {})
  }
  await S.q('delete from notifications where tenant_id=$1', [TENANT]).catch(() => {})
  await S.q('delete from pro_team_members where tenant_id=$1', [TENANT]).catch(() => {})
  await S.q('delete from users where tenant_id=$1', [TENANT]).catch(() => {})
  await S.stop()
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
const shot = async (p, dir, name) => { await calm(p); await p.waitForTimeout(200); await p.screenshot({ path: path.join(SHOTS[dir], `${name}.png`) }) }
const noSideScroll = async (p) => expect(await p.evaluate(() => document.scrollingElement.scrollWidth)).toBeLessThanOrEqual(await p.evaluate(() => window.innerWidth) + 1)
const answerRow = (p) => p.locator(`.row[data-id="${ANS.id}"]`)
// the chat (on a phone /chat opens on Home's tab: 「채팅」 brings the conversation)
async function toChat(p, phone = false) {
  await p.goto('/chat')
  if (phone) await p.locator('.seg button').filter({ hasText: /^(채팅|Chat)$/ }).click()
}
const composer = (p) => p.locator('[data-test="chat-composer"] textarea').last()
// a real touch through the browser's input pipeline (Playwright has no long press) — as the messenger's reaction tests do
async function press(p, el, ms = 700) {
  const b = await el.boundingBox()
  const x = b.x + Math.min(b.width / 2, 60), y = b.y + b.height / 2
  const cdp = await p.context().newCDPSession(p)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
  await p.waitForTimeout(ms)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await cdp.detach().catch(() => {})
}
async function openRoom(p, title) {
  await p.goto('/chat')
  await p.locator('button.msg-btn').click()
  await p.locator('.ms').waitFor()
  await p.locator('.ms .tabs button').filter({ hasText: '대화' }).click()
  await p.locator('.ms .th').filter({ has: p.locator('.nm b', { hasText: new RegExp(`^${title}$`) }) }).first().click()
  await p.locator('.ms .cmp textarea').waitFor()
}
const inView = async (loc, p) => {
  const b = await loc.boundingBox()
  const v = p.viewportSize()
  expect(b, 'on screen').toBeTruthy()
  expect(b.x).toBeGreaterThanOrEqual(-0.5)
  expect(b.x + b.width).toBeLessThanOrEqual(v.width + 0.5)
  return b
}

test('F-AS-01 답 카드의 「공유」 → 대화방 고르기 → 무엇이 보일지 확인 · 한마디 → 보내기 → 방에 AI 답 카드로 도착', async ({ browser }) => {
  const p = await open(browser, HY, DESK)
  await p.goto('/chat')
  const row = answerRow(p)
  await expect(row.locator('[data-test="answer-actions"]')).toBeVisible({ timeout: 30000 })
  await expect(row.locator('[data-test="answer-share-btn"]')).toHaveText(/공유/)
  await expect(row.locator('[data-test="answer-project-btn"]')).toHaveText(/프로젝트로 시작/)
  await shot(p, 'share', 'f-as-01-answer-buttons')
  await row.locator('[data-test="answer-share-btn"]').click()
  const sheet = p.locator('[data-test="answer-share"]')
  await expect(sheet).toHaveAttribute('data-step', 'menu')
  await expect(sheet).toContainText('데이터 분석 실무 교육안')
  for (const t of ['대화방 · 사람에게 보내기', '문서로 남기기', '프로젝트로 시작', '글 복사']) await expect(sheet.getByRole('menuitem').filter({ hasText: t })).toHaveCount(1)
  await shot(p, 'share', 'f-as-01-menu')
  await sheet.locator('[data-test="answer-share-room"]').click()
  const opt = sheet.locator(`[data-test="answer-room-option"][data-room="${ROOM}"]`)
  await expect(opt).toContainText('가나정밀 교육 준비')
  await expect(sheet.locator('[data-test="answer-person-option"]')).toHaveCount(2)   // 김서연 · 박도윤 — no conversation of two yet
  await opt.click()
  await expect(sheet).toHaveAttribute('data-step', 'send')
  await expect(sheet.locator('[data-test="answer-send-to"]')).toContainText('가나정밀 교육 준비')
  await expect(sheet.locator('[data-test="answer-preview"]')).toContainText('데이터 분석 실무 교육안')
  await expect(sheet.locator('[data-test="answer-says"]')).toContainText('「가나정밀 교육 준비」에 있는 사람들에게 이 답의 글만 보내요')
  await expect(sheet.locator('[data-test="answer-says"]')).toContainText('서명된 주소 · 저장소 주소는 파일 이름만 남기고 빼요')
  await expect(sheet.locator('[data-test="answer-truncated"]')).toHaveCount(0)
  await expect(sheet).toHaveAttribute('aria-modal', 'true')
  await sheet.locator('[data-test="answer-note"]').fill('교육안 초안이에요. 일정 봐 주세요')
  await shot(p, 'share', 'f-as-01-send')
  await sheet.locator('[data-test="answer-send"]').click()
  await expect(sheet.locator('[data-test="answer-sent"]')).toContainText('「가나정밀 교육 준비」에 공유했어요')
  // the answer says where it went
  await expect(row.locator('[data-test="answer-shared"]')).toContainText('「가나정밀 교육 준비」에 공유했어요')
  // 김서연 has it in the room: the word and the answer's title and words
  const got = (await S.api(SY.token, `/team/threads/${ROOM}/messages`)).messages.filter((m) => m.kind === 'answer')
  expect(got).toHaveLength(1)
  expect(got[0].body).toBe('교육안 초안이에요. 일정 봐 주세요')
  expect(got[0].answer.title).toBe('데이터 분석 실무 교육안')
  expect(got[0].answer.text).toContain('2일차')
  // the messenger shows it as an AI answer card
  await sheet.locator('[data-test="answer-room-open"]').click()
  const card = p.locator('[data-test="messenger"] [data-test="msg-answer"]').last()
  await expect(card).toContainText('데이터 분석 실무 교육안', { timeout: 15000 })
  await expect(card).toContainText('1일차')
  await shot(p, 'share', 'f-as-01-room')
  expect(p.errors).toEqual([])
  // and 김서연's own screen
  const k = await open(browser, SY, DESK)
  await openRoom(k, '가나정밀 교육 준비')
  await expect(k.locator('[data-test="messenger"] [data-test="msg-answer"]').last()).toContainText('데이터 분석 실무 교육안', { timeout: 15000 })
  await shot(k, 'share', 'f-as-01-received')
  expect(k.errors).toEqual([])
  await k.context().close()
  await p.context().close()
})

test('F-AS-02 「문서로 남기기」 → 채팅에 Markdown 파일 카드(공유 · 내려받기 · 편집이 되는 보통 파일 카드)', async ({ browser }) => {
  const p = await open(browser, HY, DESK)
  await p.goto('/chat')
  await answerRow(p).locator('[data-test="answer-share-btn"]').click({ timeout: 30000 })
  const sheet = p.locator('[data-test="answer-share"]')
  await sheet.locator('[data-test="answer-share-doc"]').click()
  await expect(sheet.locator('[data-test="answer-doc-saved"]')).toContainText('데이터 분석 실무 교육안.md')
  await shot(p, 'share', 'f-as-02-saved')
  await sheet.locator('[data-test="answer-share-close"]').click()
  const fileCard = p.locator('[data-test="file-card"][data-file="데이터 분석 실무 교육안.md"]')
  await expect(fileCard).toBeVisible()
  // the file's own share button (team/ShareButton.vue): it is an ordinary file card now
  await expect(fileCard.locator('button[aria-label$="공유"]')).toHaveCount(1)
  const [row] = await S.q(`select content from pro_messages where thread_id=$1 and kind='file' and content->>'fromAnswer'=$2`, [MAIN.id, ANS.id])
  const md = await (await fetch(row.content.url)).text()
  expect(md.startsWith('# 데이터 분석 실무 교육안')).toBe(true)
  await fileCard.scrollIntoViewIfNeeded()
  await shot(p, 'share', 'f-as-02-file-card')
  expect(p.errors).toEqual([])
  await p.context().close()
})

for (const theme of ['light', 'dark']) {
  test(`F-AS-03 휴대폰 390(${theme === 'light' ? '밝은' : '어두운'}): 길게 누르면 같은 메뉴가 아래 시트로 · 「글 선택」 · 화면 안`, async ({ browser }) => {
    const p = await open(browser, HY, PHONE, { theme })
    await toChat(p, true)
    const row = answerRow(p)
    await expect(row.locator('[data-test="answer-actions"]')).toBeVisible({ timeout: 30000 })
    await row.locator('[data-test="answer-actions"]').scrollIntoViewIfNeeded()
    await inView(row.locator('[data-test="answer-share-btn"]'), p)
    await inView(row.locator('[data-test="answer-project-btn"]'), p)
    await noSideScroll(p)
    await shot(p, 'share', `f-as-03-phone-${theme}`)
    // a long press on the answer: its message menu
    const doc = row.locator('.doc')
    // (in the middle of the screen: a heading scrolled to the top edge lies under the top bar — a touch there is its 「홈」 tab)
    await row.locator('.doc h3').evaluate((el) => el.scrollIntoView({ block: 'center' }))
    await press(p, row.locator('.doc h3'))
    const sheet = p.locator('[data-test="answer-share"]')
    await expect(sheet).toHaveAttribute('data-step', 'menu')
    await expect(sheet.locator('[data-test="answer-share-select"]')).toBeVisible()
    const sb = await inView(sheet, p)
    expect(sb.y + sb.height).toBeGreaterThan(844 - 2)   // a sheet from the bottom
    await noSideScroll(p)
    await shot(p, 'share', `f-as-03-menu-${theme}`)
    // a long press on the answer is its menu, not the phone's own selection (review L1) — 「글 선택」 gives the selection back
    expect(await doc.evaluate((el) => getComputedStyle(el).webkitUserSelect || getComputedStyle(el).userSelect)).toBe('none')
    await sheet.locator('[data-test="answer-share-select"]').click()
    await expect(sheet).toHaveCount(0)
    expect(await p.evaluate(() => window.getSelection().toString())).toContain('1일차')
    expect(await doc.evaluate((el) => el.hasAttribute('data-selecting'))).toBe(true)
    // and the rooms step fits too
    await row.locator('[data-test="answer-share-btn"]').click()
    await p.locator('[data-test="answer-share-room"]').click()
    await expect(p.locator('[data-test="answer-room-option"]').first()).toBeVisible()
    await noSideScroll(p)
    await shot(p, 'share', `f-as-03-rooms-${theme}`)
    if (theme === 'dark') {
      const [fg, bg] = await p.locator('[data-test="answer-share"]').evaluate((el) => [getComputedStyle(el).color, getComputedStyle(el).backgroundColor])
      const lum = (c) => { const [r, g, b2] = c.match(/[\d.]+/g).map(Number); return 0.2126 * r + 0.7152 * g + 0.0722 * b2 }
      expect(lum(fg)).toBeGreaterThan(lum(bg))
    }
    expect(p.errors).toEqual([])
    await p.context().close()
  })
}

test('F-CP-01 말로 「이 내용을 기반으로 프로젝트를 하나 만들자」 → 확인 카드 → 「프로젝트」 탭에 생김 · 계획 · 첫 문서 · 채팅에 「프로젝트로 옮겼어요」', async ({ browser }) => {
  test.setTimeout(180_000)
  const p = await open(browser, HY, DESK)
  await p.goto('/chat')
  await composer(p).waitFor({ timeout: 30000 })
  await composer(p).fill(WORDS)
  await composer(p).press('Enter')
  const card = p.locator('[data-test="project-offer"]').last()
  await expect(card).toBeVisible({ timeout: 60000 })
  expect(llm.routed.some((t) => t.includes(WORDS)), '라우터가 그 말을 읽었다').toBe(true)
  await expect(card).toHaveAttribute('data-state', 'offered')
  await expect(card.locator('[data-test="offer-title"]')).toHaveValue('가나정밀 1차 교육 과정')
  // (the answer of this conversation — not the scheduled run that came after it)
  await expect(card.locator('[data-test="offer-intent"]')).toHaveValue('1차 교육 3일 과정의 교안과 실습 목록을 만든다')
  await expect(card.locator('[data-test="offer-deliverable"]')).toHaveCount(2)
  await expect(card.locator('[data-test="offer-background"]')).toHaveValue('받은 메일의 교육 요청을 채팅에서 조사한 내용에서 시작했어요')
  expect(llm.drafts.at(-1)).not.toContain('주간 시장 동향')
  await expect(card.locator('[data-test="offer-source"]')).toContainText('1차 교육 과정 요청드립니다')
  await expect(card.locator('[data-test="offer-doc"]')).toContainText('데이터 분석 실무 교육안')
  // the judge's pick with its line of why; the template that does not fit is not offered
  const tpls = card.locator('[data-test="offer-template"]')
  await expect(tpls).toHaveCount(1)
  await expect(tpls.first()).toContainText('교육 과정 만들기 템플릿')
  await expect(tpls.first().locator('[data-test="offer-template-why"]')).toHaveText('교안 양식과 교안을 만드는 스킬이 있어요')
  await expect(card.locator('[data-test="offer-template-none"]')).toHaveAttribute('aria-checked', 'true')
  // nothing made yet
  expect((await S.api(HY.token, '/threads?kind=project')).length).toBe(0)
  await card.scrollIntoViewIfNeeded()
  await shot(p, 'project', 'f-cp-01-offer')
  await card.locator('[data-test="offer-make"]').click()
  await expect(card).toHaveAttribute('data-state', 'made', { timeout: 20000 })
  PROJECT_WORDS = await card.locator('[data-test="offer-made"]').getAttribute('data-project')
  // the chat: one line, and everything before it still there
  const moved = p.locator(`[data-test="moved-to-project"][data-project="${PROJECT_WORDS}"]`)
  await expect(moved).toContainText('프로젝트로 옮겼어요 · 가나정밀 1차 교육 과정')
  await expect(answerRow(p)).toBeVisible()
  await shot(p, 'project', 'f-cp-01-made')
  // the 프로젝트 tab
  await p.goto('/projects')
  await expect(p.getByText('가나정밀 1차 교육 과정').first()).toBeVisible({ timeout: 20000 })
  await shot(p, 'project', 'f-cp-01-projects-tab')
  // the project: its plan says what it is for, the first document is the answer
  await p.goto(`/projects/${PROJECT_WORDS}`)
  await expect(p.getByTestId('project-plan-chip')).toContainText('1차 교육 3일 과정의 교안과 실습 목록을 만든다', { timeout: 20000 })
  await expect(p.locator('[data-test="file-card"][data-file="데이터 분석 실무 교육안.md"]')).toBeVisible()
  await expect(p.locator('[data-test="from-chat"]')).toContainText('채팅에서 이어 온 프로젝트예요')
  await p.getByTestId('project-plan-chip').click()
  const plan = p.getByTestId('project-plan-sheet')
  const decided = plan.getByTestId('plan-decisions').getByTestId('plan-item-text')
  await expect(decided).toHaveCount(2)
  await expect(decided.nth(0)).toHaveValue('받은 메일의 교육 요청을 채팅에서 조사한 내용에서 시작했어요')
  await expect(decided.nth(1)).toHaveValue('출처: 받은 메일 「1차 교육 과정 요청드립니다」 · 이준호')
  await expect(plan.getByTestId('plan-decisions').getByTestId('plan-pinned')).toHaveCount(1)   // the source is kept
  await expect(plan.getByTestId('plan-intent')).toHaveValue('1차 교육 3일 과정의 교안과 실습 목록을 만든다')
  await shot(p, 'project', 'f-cp-01-project')
  await p.keyboard.press('Escape')
  // 「원래 대화 열기」 goes back to the chat
  await p.locator('[data-test="from-chat"]').click()
  await expect(p).toHaveURL(/\/chat/)
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-CP-02 답의 「프로젝트로 시작」 → 추천 템플릿을 고르고 만들기 → 「템플릿으로 시작」과 같은 전용 작업 공간', async ({ browser }) => {
  test.setTimeout(180_000)
  const p = await open(browser, HY, DESK)
  await p.goto('/chat')
  await answerRow(p).locator('[data-test="answer-project-btn"]').click({ timeout: 30000 })
  const card = p.locator('[data-test="project-offer"][data-state="offered"]').last()
  await expect(card).toBeVisible({ timeout: 30000 })
  await card.locator('[data-test="offer-title"]').fill('가나정밀 2차 교육 과정')
  // what goes into the plan is what the card shows — changed here (review M3): the purpose, one deliverable out, one in
  await card.locator('[data-test="offer-intent"]').fill('2차 교육 2일 과정의 교안을 만든다')
  await card.locator('[data-test="offer-deliverable-remove"]').nth(1).click()
  await card.locator('[data-test="offer-deliverable-add"]').click()
  await card.locator('[data-test="offer-deliverable"]').last().fill('강사 안내문')
  await card.locator(`[data-test="offer-template"][data-slug="${COURSE.slug}"]`).click()
  await expect(card.locator(`[data-test="offer-template"][data-slug="${COURSE.slug}"]`)).toHaveAttribute('aria-checked', 'true')
  await shot(p, 'project', 'f-cp-02-pick-template')
  await card.locator('[data-test="offer-make"]').click()
  const made = p.locator('[data-test="offer-made"]').last()
  await expect(made.locator('[data-test="offer-started-from"]')).toHaveText('템플릿 「교육 과정 만들기 템플릿」으로 시작해요', { timeout: 30000 })
  await made.locator('[data-test="offer-open"]').click()
  await expect(p).toHaveURL(/\/projects\/[0-9a-f-]{36}$/)
  const bar = p.locator('[data-test="project-workspace-bar"]')
  await expect(bar).toContainText('교육 과정 만들기 템플릿', { timeout: 20000 })
  await expect(bar).toContainText('전용 작업 공간')
  await shot(p, 'project', 'f-cp-02-workspace')
  // the template's own lists: no workspace there (the template flow's rule)
  const id = p.url().split('/').pop()
  const f = (await S.api(HY.token, `/threads/${id}/folder`)).folder
  expect(f.variation.branch).toMatch(/^var\/t\//)
  expect((await S.api(HY.token, `/folders/${COURSE.slug}`)).variations.map((v) => v.id)).not.toContain(f.variation.id)
  // the plan holds what the card showed when 「만들기」 was pressed
  const note = (await S.api(HY.token, `/threads/${id}/note`))
  const n = note.note || note
  expect(n.intent).toBe('2차 교육 2일 과정의 교안을 만든다')
  expect(n.deliverables.map((x) => x.text)).toEqual(['일차별 교안', '강사 안내문'])
  expect(p.errors).toEqual([])
  await p.context().close()
})

for (const theme of ['light', 'dark']) {
  test(`F-CP-03 휴대폰 390(${theme === 'light' ? '밝은' : '어두운'}): 확인 카드가 화면 안 · 옆으로 밀리지 않음`, async ({ browser }) => {
    const p = await open(browser, HY, PHONE, { theme })
    await toChat(p, true)
    await answerRow(p).locator('[data-test="answer-project-btn"]').click({ timeout: 30000 })
    const card = p.locator('[data-test="project-offer"][data-state="offered"]').last()
    await expect(card).toBeVisible({ timeout: 30000 })
    await card.scrollIntoViewIfNeeded()
    await inView(card, p)
    await inView(card.locator('[data-test="offer-make"]'), p)
    await noSideScroll(p)
    await shot(p, 'project', `f-cp-03-phone-${theme}`)
    // 「아니요」: nothing made, the card says so
    await card.locator('[data-test="offer-no"]').click()
    await expect(p.locator(`.row[data-id] [data-test="project-offer"][data-state="declined"]`).last()).toBeVisible()
    expect(p.errors).toEqual([])
    await p.context().close()
  })
}
