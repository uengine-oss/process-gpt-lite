// 걸러 본 대화를 통째로 프로젝트로 옮기기 (스펙 openspec/specs/thread-to-project, 서버 lib/conversationMove.js, 화면 ConversationBar.vue ·
// ConversationMoveSheet.vue · ConvMoveCard.vue · ProjectOfferCard.vue · Message.vue). 2026-11-28 사용자: 「필터링된 채팅방 자체를 프로젝트로 이관하는
// 기능. 이관 후엔 이 채팅 내용은 프로젝트에서만 볼 수 있음. 기존 채팅 목록에서는 제거됩니다... 라는 알림도 줘야」.
//   F-TM-01 휴대폰 390(밝은): 걸러 본 대화 → 「다른 대화 ▾」의 「프로젝트로 옮기기」 → 프로젝트 고르기(읽기 전용은 까닭과 함께 못 고름) → 옮기기 전 알림 +
//           구성원이 있는 프로젝트의 추가 문구(확인해야 「옮기기」) → 옮김 → 프로젝트의 그 대화 · 「채팅에서 옮겨 온 대화예요」 · 채팅 목록에서 사라짐 ·
//           옛 링크(/chat/c/…)는 프로젝트로
//   F-TM-02 휴대폰 390(어두운): 구성원 없는 프로젝트(추가 문구 없음) → 옮김 → 「채팅으로 되돌리기」 → 채팅의 그 대화로 돌아옴
//   F-TM-03 넓은 화면 1280: 「새 프로젝트로 옮기기」 → 「프로젝트로 시작」 카드(옮길 대화 · 알림 · 「만들고 옮기기」) → 새 프로젝트의 그 대화
//   F-TM-04 휴대폰 390(밝은): 말로 「이 대화 견적 모음 프로젝트로 옮겨 줘」 → 카드(판정 모델이 고른 프로젝트를 권함) → 같은 알림을 거쳐 옮김
//   F-TM-05 휴대폰 390(밝은 · 어두운) · 1280: 긴 대화를 걸러 보고 맨 아래(최신)로 내려가도 대화 막대가 위에 붙어 있음 — 휴대폰은 한 줄, 글을 쓰는 동안
//           (키보드)은 이름 · 「다른 대화 ▾」만; 전체 채팅의 막대(알약)는 그대로 흘러감
//   F-TM-06 휴대폰 390(밝은): 실시간 이벤트를 받지 못한 옛 화면에서 옮긴 대화에 말을 보내면 → 보내기 실패가 아니라 프로젝트의 그 주제로 가고 말은 입력창에
//           (PR #125 검토 10) — 줄 서 있던 말까지 함께
//   F-TM-07 1280: 그 사이 다른 화면으로 가 있었으면 끌고 가지 않고 알림만, 나중에 그 대화를 열면 말이 입력창에 (PR #125 마지막 확인 2)
//   F-TM-08 휴대폰 390(밝은) · 사진 위: 대화 목록은 프로젝트 목록처럼 읽힘(큰 이름 · 진한 한 줄 · 시각과 수는 배지, 비교용 프로젝트 목록 사진) ·
//           행을 길게 누르면 「프로젝트로 옮기기」(목록은 그 밑에 남음), 누르면 그 대화
//   F-TM-09 1280(어두운): 행에 포인터를 올리면 「프로젝트로 옮기기」 단추 · 오른쪽 클릭도 같은 창 · 「전체 대화」에는 없음
// 자기 스택(lib/localStack.js: 회사 thread-move-ui 의 BFF + Vite, 8994 · 5394)을 띄우고 지운다. 가짜 모델 · 가짜 deepagents 는 이 파일이 빈 포트에
// 띄운다 — 실제 모델 · 에이전트 · 판정 서버는 부르지 않는다. 사람 · 회사는 지어낸 것이다(정하윤 · 김서연 · 박도윤, 가나정밀).
//   cd e2e && RT_WORKERS=1 npx playwright test --project=feature tests/feature/thread-to-project.spec.js
import { test, expect } from '@playwright/test'
import http from 'node:http'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { startStack, REPO } from '../../lib/localStack.js'

test.describe.configure({ mode: 'serial' })
const SHOTS = path.join(REPO, 'openspec/specs/thread-to-project/e2e/results')
const DESK = { viewport: { width: 1280, height: 860 }, locale: 'ko-KR' }
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ko-KR' }
const NOWHERE = 'http://127.0.0.1:9'
const TENANT = 'thread-move-ui'
const WORDS = '이 대화 견적 모음 프로젝트로 옮겨 줘'

// ---- the fake model ----
function answerLlm(b) {
  const all = (b.messages || []).map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n')
  const sys = String(b.messages?.[0]?.content || '')
  const last = String(b.messages?.at(-1)?.content || '')
  if (b.logprobs) {
    const options = [...all.matchAll(/^([A-Z])\) (.+)$/gm)].map((m) => ({ letter: m[1], label: m[2] }))
    // the project the person named: 「견적 모음」; every other reading: its last option (none · other)
    const pick = (options.find((o) => o.label.includes('「견적 모음」')) || options.at(-1) || { letter: 'A' }).letter
    const other = options.find((o) => o.letter !== pick)?.letter || 'Z'
    return { choices: [{ message: { content: pick }, logprobs: { content: [{ token: pick, logprob: Math.log(0.9), top_logprobs: [{ token: pick, logprob: Math.log(0.9) }, { token: other, logprob: Math.log(0.1) }] }] } }] }
  }
  let content = b.response_format ? '{}' : 'OK'
  if (sys.includes('what you understood and how the work will go')) content = JSON.stringify({ understood: '이 대화를 프로젝트로 옮기려고 하시는 것으로 이해했어요.', steps: ['프로젝트 고르기', '옮기기 전 확인'], tier: 'light', certainty: 'sure' })
  else if (sys.startsWith('너는 채팅에서 하던 이야기를')) {
    content = JSON.stringify({ title: '거래처 미팅 후속', intent: '거래처 미팅에서 정한 후속 일을 정리하고 견적서를 보낸다', background: '채팅에서 정리하던 거래처 미팅 메모에서 시작했어요', deliverables: ['후속 일 목록', '견적서'] })
  } else if (b.tools) {
    if (last.includes('프로젝트로 옮겨')) {
      return { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'm1', type: 'function', function: { name: 'move_to_project', arguments: JSON.stringify({ project: '견적 모음', ack: '아래 카드에서 프로젝트를 확인하면 이 대화를 옮길게요.' }) } }] }, finish_reason: 'tool_calls' }] }
    }
    content = 'DELEGATE'
  }
  return { choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] }
}
let servers = []
const listen = (srv) => new Promise((ok, no) => srv.once('error', no).listen(0, '127.0.0.1', () => { servers.push(srv); ok(srv.address().port) }))
const bodyOf = (req) => new Promise((ok) => { let raw = ''; req.on('data', (c) => { raw += c }); req.on('end', () => { try { ok(JSON.parse(raw)) } catch { ok({}) } }) })
let S, HY, SY, DY, MAIN, P1, P2, P3, P4
const sfx = crypto.randomBytes(3).toString('hex')
const CONV = { A: `tm-ui-a-${sfx}`, B: `tm-ui-b-${sfx}`, C: `tm-ui-c-${sfx}`, E: `tm-ui-e-${sfx}`, H: `tm-ui-h-${sfx}`, L: `tm-ui-l-${sfx}` }
const TITLE = { A: '가나정밀 교육 요청 조사', B: '주간 회의록 정리', C: '견적 비교', E: '거래처 미팅 메모', H: '견적 항목', L: '가나정밀 2차 교육 일정과 강사 섭외' }

const API_PORT = Number(process.env.RT_TM_API_PORT || 8994)
const WEB_PORT = Number(process.env.RT_TM_WEB_PORT || 5394)
const busy = (port) => { try { execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { stdio: 'ignore' }); return true } catch { return false } }

test.beforeAll(async () => {
  test.setTimeout(240_000)
  for (const port of [API_PORT, WEB_PORT]) if (busy(port)) throw new Error(`port ${port} is in use — this file runs its own stack there (RT_TM_API_PORT · RT_TM_WEB_PORT)`)
  fs.mkdirSync(SHOTS, { recursive: true })
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
  const cfg = await S.api(null, '/config')
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error(`port ${API_PORT} answers as another server, not this stack's BFF`)
  console.log(`[thread-move] stack on BFF ${S.apiPort} · web ${S.webPort}`)
  HY = await S.person(`pro-rt-${TENANT}-a@uengine.org`, '정하윤')
  SY = await S.person(`pro-rt-${TENANT}-b@uengine.org`, '김서연')
  DY = await S.person(`pro-rt-${TENANT}-c@uengine.org`, '박도윤')
  for (const p of [HY, SY, DY]) await S.join(p)
  await S.api(HY.token, '/me/lang', { method: 'PUT', body: { lang: 'ko' } })
  ;[MAIN] = await S.api(HY.token, '/threads')
  // 정하윤's chat: five conversations the router told apart, each with its row
  let s = 0
  const at = () => new Date(Date.now() - 3600_000 + (s += 5) * 1000).toISOString()
  const ins = (role, kind, content) => S.q(`insert into pro_messages(thread_id,role,kind,content,created_at) values ($1,$2,$3,$4,$5)`, [MAIN.id, role, kind, content, at()])
  const ctx = (k, action = 'continue') => ({ conversationId: CONV[k], action, title: TITLE[k] })
  await ins('user', 'text', { text: '받은 메일의 1차 교육 요청을 조사해 줘' })
  await ins('agent', 'doc', { text: '# 데이터 분석 실무 교육안\n\n요청 메일의 1차 교육(3일)을 기준으로 정리했어요.\n\n1. **1일차** — 스프레드시트 기초\n2. **2일차** — 대시보드 만들기 실습\n3. **3일차** — 발표와 피드백', context: ctx('A', 'new') })
  // (a real file in storage, as the agent leaves one — the card checks it can be shared)
  const up = await fetch(`http://127.0.0.1:${S.apiPort}/api/attachments`, { method: 'POST', headers: { Authorization: `Bearer ${HY.token}`, 'X-File-Name': encodeURIComponent('교육안.md'), 'Content-Type': 'text/markdown' },
    body: '# 데이터 분석 실무 교육안\n\n1일차 · 2일차 · 3일차\n' }).then((r) => r.json())
  await ins('agent', 'file', { name: '교육안.md', url: up.url, type: 'text/markdown' })
  await ins('user', 'text', { text: '이번 주 회의록 정리해 줘' })
  await ins('agent', 'text', { text: '회의록을 정리했어요. 결정 3건, 할 일 5건이에요. 다음 회의는 목요일 오전 10시예요.', context: ctx('B', 'new') })
  await ins('user', 'text', { text: '교육안 2일차를 더 자세히 써 줘' })
  await ins('agent', 'text', { text: '2일차 실습을 세 단계로 나눴어요. 데이터 불러오기, 차트 만들기, 대시보드 묶기예요.', context: ctx('A') })
  await ins('user', 'text', { text: '견적 세 곳 비교해 줘' })
  await ins('agent', 'text', { text: '세 곳의 견적을 표로 비교했어요. 가나정밀이 가장 낮고, 납기는 두 번째로 빨라요.', context: ctx('C', 'new') })
  await ins('user', 'text', { text: '거래처 미팅 메모 정리해 줘' })
  await ins('agent', 'text', { text: '거래처 미팅 메모를 정리했어요. 다음 단계는 견적서 송부이고, 담당은 김서연이에요.', context: ctx('E', 'new') })
  await ins('user', 'text', { text: '견적 항목 정리해 줘' })
  await ins('agent', 'text', { text: '견적 항목을 단가, 수량, 납기 세 칸으로 정리했어요.', context: ctx('H', 'new') })
  // a long conversation (F-TM-05): twelve questions and answers
  for (let i = 1; i <= 12; i++) {
    await ins('user', 'text', { text: `2차 교육 ${i}일차 일정을 정리해 줘` })
    await ins('agent', 'text', { text: `${i}일차는 오전에 이론, 오후에 실습이에요. 강사는 두 명이 번갈아 맡고, 실습실은 30명이 들어가는 곳으로 잡았어요. 준비물은 노트북과 예시 데이터예요.`, context: ctx('L', i === 1 ? 'new' : 'continue') })
  }
  for (const k of Object.keys(CONV)) {
    await S.q(`insert into context_threads(tenant_id,user_id,conversation_id,title,summary,gist,kind,turns,updated_at) values ($1,$2,$3,$4,$5,'','conversation',2,now())
      on conflict (tenant_id,user_id,conversation_id) do nothing`, [TENANT, HY.id, CONV[k], TITLE[k], `최근 요청: ${TITLE[k]}\n최근 답: …`])
  }
  // 정하윤's projects: P1 · P4 (no folder), P2 (works in 「영업 자료」 — 김서연 is in it too), P3 (works in 「규정집」 — 정하윤 only views it)
  const proj = async (title) => (await S.q(`insert into pro_threads(user_id,kind,title,updated_at) values ($1,'project',$2,now()) returning *`, [HY.id, title]))[0]
  P1 = await proj('가나정밀 1차 교육'); P2 = await proj('영업 자료 정리'); P3 = await proj('규정 검토'); P4 = await proj('견적 모음')
  const sales = await S.api(HY.token, '/folders', { method: 'POST', body: { name: '영업 자료', description: '영업 자료를 모으는 폴더' } })
  await S.api(HY.token, `/folders/${sales.slug}/members`, { method: 'POST', body: { id: SY.id, role: 'editor' } })
  const rules = await S.api(DY.token, '/folders', { method: 'POST', body: { name: '규정집', description: '사내 규정' } })
  await S.api(DY.token, `/folders/${rules.slug}/members`, { method: 'POST', body: { id: HY.id, role: 'viewer' } })
  for (const [t, f] of [[P2, sales], [P3, rules]]) await S.q(`insert into pro_thread_folders (thread_id, user_id, folder_id, mode) values ($1,$2,$3,'project')`, [t.id, HY.id, f.id])
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
    await S.q('delete from pro_followups where user_id=$1', [p.id]).catch(() => {})
    const keys = (await S.q(`select name from storage.objects where bucket_id='files' and starts_with(name, $1)`, [`pgpt-pro/${p.id}/`]).catch(() => [])).map((r) => r.name)
    if (keys.length) await S.q(`delete from storage.objects where bucket_id='files' and name = any($1)`, [keys]).catch(() => {})
  }
  await S.q('delete from context_threads where tenant_id=$1', [TENANT]).catch(() => {})
  await S.q('delete from pro_folder_members where folder_id in (select id from pro_folders where tenant_id=$1)', [TENANT]).catch(() => {})
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
const shot = async (p, name) => { await calm(p); await p.waitForTimeout(250); await p.screenshot({ path: path.join(SHOTS, `${name}.png`) }) }
const noSideScroll = async (p) => expect(await p.evaluate(() => document.scrollingElement.scrollWidth)).toBeLessThanOrEqual(await p.evaluate(() => window.innerWidth) + 1)
const inView = async (loc, p) => {
  const b = await loc.boundingBox()
  const v = p.viewportSize()
  expect(b, 'on screen').toBeTruthy()
  expect(b.x).toBeGreaterThanOrEqual(-0.5)
  expect(b.x + b.width).toBeLessThanOrEqual(v.width + 0.5)
  expect(b.y + b.height).toBeLessThanOrEqual(v.height + 0.5)
}
const bar = (p) => p.getByTestId('cbar')
const composer = (p) => p.locator('[data-test="chat-composer"] textarea').last()
const sheet = (p) => p.locator('[data-test="conv-move"]')
// one conversation of the chat, the way a person gets there: 「채팅」 (a phone opens on Home), the bar's pill, its row
async function toConversation(p, k, { phone = false } = {}) {
  await p.goto('/chat')
  if (phone) await p.locator('.seg button').filter({ hasText: /^(채팅|Chat)$/ }).click()
  await bar(p).getByTestId('cbar-pill').click({ timeout: 30000 })
  await bar(p).locator(`[data-testid=cbar-row][data-conv="${CONV[k]}"]`).click()
  await expect(p).toHaveURL(new RegExp(`/chat/c/${CONV[k]}$`))
  await expect(bar(p).getByTestId('cbar-current')).toContainText(TITLE[k])
}
async function openMove(p) {
  await bar(p).getByTestId('cbar-other').click()
  const row = bar(p).getByTestId('cbar-move')
  await expect(row).toContainText('프로젝트로 옮기기')
  await row.click()
  await expect(sheet(p)).toHaveAttribute('data-step', 'pick')
  await expect(sheet(p).locator('[data-test="move-project"]').first()).toBeVisible({ timeout: 15000 })
}
const chatConvs = async () => (await S.api(HY.token, '/conversations')).map((c) => c.id)
const projectRows = async (pid) => S.q(`select id, kind, content from pro_messages where thread_id=$1 order by created_at`, [pid])

test('F-TM-01 휴대폰 390(밝은): 걸러 본 대화 → 프로젝트로 옮기기 → 구성원이 있는 프로젝트는 한 번 더 확인 → 프로젝트에서만 보임 · 채팅 목록에서 사라짐 · 옛 링크는 프로젝트로', async ({ browser }) => {
  test.setTimeout(180_000)
  const p = await open(browser, HY, PHONE)
  await toConversation(p, 'A', { phone: true })
  await expect(bar(p).getByTestId('cbar-count')).toHaveText('메시지 5개')
  // a filtered view opens at its newest message (PR #124) with the bar pinned over it
  await expect(p.locator('.row').filter({ hasText: '2일차 실습을 세 단계로 나눴어요' })).toBeInViewport()
  await expect(bar(p).getByTestId('cbar-current')).toBeInViewport()
  await shot(p, 'f-tm-01-conversation')
  // scrolled to the top, the bar sits in its place — over no message (the first one, right under it, is fully in view)
  await p.evaluate(() => { for (const el of document.querySelectorAll('.scroll.msgs')) el.scrollTop = 0 })
  const first = p.locator('.row').filter({ hasText: '받은 메일의 1차 교육 요청을 조사해 줘' })
  await expect(first).toBeInViewport()
  const fb = await first.boundingBox(), bb = await bar(p).boundingBox()
  expect(fb.y).toBeGreaterThanOrEqual(bb.y + bb.height)
  await shot(p, 'f-tm-01-conversation-top')
  await bar(p).getByTestId('cbar-other').click()
  await expect(bar(p).getByTestId('cbar-move')).toBeVisible()
  await inView(bar(p).getByTestId('cbar-move'), p)
  await shot(p, 'f-tm-01-menu')
  await bar(p).getByTestId('cbar-move').click()
  await expect(sheet(p)).toHaveAttribute('data-step', 'pick')
  await expect(sheet(p).locator('[data-test="move-intro"]')).toHaveText('옮긴 대화는 고른 프로젝트에서만 볼 수 있어요. 채팅 목록과 전체 대화에서는 사라져요.')
  // the projects: the one in 「규정집」 (only viewed) cannot be picked and says why; the one in 「영업 자료」 says who else is in it
  const ro = sheet(p).locator(`[data-test="move-project"][data-project="${P3.id}"]`)
  await expect(ro).toBeDisabled()
  await expect(ro.locator('[data-test="move-project-why"]')).toContainText('「규정집」에 쓸 권한이 없어요')
  const shared = sheet(p).locator(`[data-test="move-project"][data-project="${P2.id}"]`)
  await expect(shared.locator('[data-test="move-project-shared"]')).toHaveText('구성원 1명')
  await expect(shared.locator('[data-test="move-project-line"]')).toHaveText('공유 폴더 「영업 자료」')
  await noSideScroll(p)
  await shot(p, 'f-tm-01-pick')
  await shared.click()
  await expect(sheet(p)).toHaveAttribute('data-step', 'confirm')
  await expect(sheet(p).locator('[data-test="move-notice"]')).toHaveText('옮기면 이 대화(메시지 5개)는 프로젝트 「영업 자료 정리」에서만 볼 수 있어요. 채팅 목록과 전체 대화에서는 사라져요.')
  await expect(sheet(p).locator('[data-test="move-members"]')).toContainText('이 프로젝트는 공유 폴더 「영업 자료」를 사용해요. 옮긴 뒤 이 대화에서 만드는 파일은 프로젝트 구성원 1명(김서연)도 볼 수 있어요.')
  // the second confirmation: 「옮기기」 waits for the box
  await expect(sheet(p).locator('[data-test="move-go"]')).toBeDisabled()
  await inView(sheet(p).locator('[data-test="move-go"]'), p)
  await noSideScroll(p)
  await shot(p, 'f-tm-01-confirm-members')
  // a short phone: the words scroll, 「옮기기」 stays on the sheet (PR #125 review 4)
  await p.setViewportSize({ width: 390, height: 560 })
  await inView(sheet(p).locator('[data-test="move-go"]'), p)
  await inView(sheet(p).locator('[data-test="move-members-ok"]').first(), p).catch(async () => {
    await sheet(p).locator('[data-test="move-members-ok"]').scrollIntoViewIfNeeded()
    await inView(sheet(p).locator('[data-test="move-members-ok"]'), p)
  })
  await noSideScroll(p)
  await shot(p, 'f-tm-01-confirm-short')
  await p.setViewportSize({ width: 390, height: 844 })
  await sheet(p).locator('[data-test="move-members-ok"]').check()
  await expect(sheet(p).locator('[data-test="move-go"]')).toBeEnabled()
  await sheet(p).locator('[data-test="move-go"]').click()
  // the page is in the project's conversation now
  await expect(p).toHaveURL(new RegExp(`/projects/${P2.id}/t/${CONV.A}$`), { timeout: 20000 })
  await expect(p.getByTestId('chat-notice')).toHaveText('프로젝트 「영업 자료 정리」로 옮겼어요 · 채팅 목록에서는 빠졌어요')
  const note = p.locator('[data-test="moved-note"]')
  await expect(note.locator('[data-test="moved-note-text"]')).toHaveText('채팅에서 옮겨 온 대화예요 · 메시지 5개')
  await expect(note.locator('[data-test="moved-back"]')).toHaveText('채팅으로 되돌리기')
  await expect(p.locator('.row').filter({ hasText: '2일차 실습을 세 단계로 나눴어요' })).toHaveCount(1)
  await expect(bar(p).getByTestId('cbar-current')).toContainText(TITLE.A)
  await noSideScroll(p)
  await shot(p, 'f-tm-01-in-project')
  // the server: in the project only — the chat's 대화 list has it no more
  expect(await chatConvs()).not.toContain(CONV.A)
  expect((await projectRows(P2.id)).filter((m) => m.content?.moved && !m.content.moved.note)).toHaveLength(5)
  // a screen still open on it that sends there: not answered in the chat — where it went (409 moved)
  const stale = await fetch(`http://127.0.0.1:${S.apiPort}/api/threads/${MAIN.id}/messages`, { method: 'POST', headers: { Authorization: `Bearer ${HY.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '이어서 3일차도', conversation: { id: CONV.A } }) })
  expect(stale.status).toBe(409)
  expect((await stale.json()).place.project.id).toBe(P2.id)
  // the chat: the conversation is gone from its list
  await p.goto('/chat')
  await p.locator('.seg button').filter({ hasText: /^(채팅|Chat)$/ }).click()
  await bar(p).getByTestId('cbar-pill').click({ timeout: 30000 })
  await expect(bar(p).locator(`[data-testid=cbar-row][data-conv="${CONV.B}"]`)).toBeVisible()
  await expect(bar(p).locator(`[data-testid=cbar-row][data-conv="${CONV.A}"]`)).toHaveCount(0)
  await shot(p, 'f-tm-01-chat-list')
  // a link to it from before (a notification, a Home card): the project's conversation
  await p.goto(`/chat/c/${CONV.A}`)
  await expect(p).toHaveURL(new RegExp(`/projects/${P2.id}/t/${CONV.A}$`), { timeout: 20000 })
  await expect(p.getByTestId('chat-notice')).toHaveText('이 대화는 프로젝트 「영업 자료 정리」로 옮겼어요')
  await shot(p, 'f-tm-01-old-link')
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-TM-02 휴대폰 390(어두운): 구성원 없는 프로젝트(추가 문구 없음) → 옮김 → 「채팅으로 되돌리기」 → 채팅의 그 대화로', async ({ browser }) => {
  test.setTimeout(180_000)
  const p = await open(browser, HY, PHONE, { theme: 'dark' })
  await toConversation(p, 'C', { phone: true })
  await openMove(p)
  await shot(p, 'f-tm-02-pick-dark')
  await sheet(p).locator(`[data-test="move-project"][data-project="${P1.id}"]`).click()
  await expect(sheet(p).locator('[data-test="move-notice"]')).toHaveText('옮기면 이 대화(메시지 2개)는 프로젝트 「가나정밀 1차 교육」에서만 볼 수 있어요. 채팅 목록과 전체 대화에서는 사라져요.')
  await expect(sheet(p).locator('[data-test="move-members"]')).toHaveCount(0)
  await expect(sheet(p).locator('[data-test="move-go"]')).toBeEnabled()
  await noSideScroll(p)
  await shot(p, 'f-tm-02-confirm-dark')
  await sheet(p).locator('[data-test="move-go"]').click()
  await expect(p).toHaveURL(new RegExp(`/projects/${P1.id}/t/${CONV.C}$`), { timeout: 20000 })
  await expect(p.getByTestId('chat-notice')).toHaveText('프로젝트 「가나정밀 1차 교육」으로 옮겼어요 · 채팅 목록에서는 빠졌어요')
  const note = p.locator('[data-test="moved-note"]')
  await expect(note).toBeVisible()
  await shot(p, 'f-tm-02-in-project-dark')
  expect(await chatConvs()).not.toContain(CONV.C)
  // back to the chat: asked once more, then the chat's conversation again
  await note.locator('[data-test="moved-back"]').click()
  await expect(note.locator('[data-test="moved-back-ask"]')).toHaveText('채팅으로 되돌릴까요? 프로젝트에서 이어서 나눈 이야기도 함께 옮겨요')
  await inView(note.locator('[data-test="moved-back-yes"]'), p)
  await shot(p, 'f-tm-02-back-ask-dark')
  await note.locator('[data-test="moved-back-yes"]').click()
  await expect(p).toHaveURL(new RegExp(`/chat/c/${CONV.C}$`), { timeout: 20000 })
  await expect(p.getByTestId('chat-notice')).toHaveText('채팅으로 되돌렸어요 · 채팅 목록에 다시 있어요')
  await expect(p.locator('.row').filter({ hasText: '세 곳의 견적을 표로 비교했어요' })).toHaveCount(1)
  await expect(bar(p).getByTestId('cbar-count')).toHaveText('메시지 2개')
  expect(await chatConvs()).toContain(CONV.C)
  await noSideScroll(p)
  await shot(p, 'f-tm-02-back-dark')
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-TM-03 넓은 화면 1280: 「새 프로젝트로 옮기기」 → 카드(옮길 대화 · 알림 · 「만들고 옮기기」) → 새 프로젝트의 그 대화', async ({ browser }) => {
  test.setTimeout(180_000)
  const p = await open(browser, HY, DESK)
  await toConversation(p, 'E')
  await openMove(p)
  await shot(p, 'f-tm-03-pick-desk')
  await sheet(p).locator('[data-test="move-new"]').click()
  const card = p.locator('[data-test="project-offer"]').last()
  await expect(card).toBeVisible({ timeout: 30000 })
  await expect(card.locator('header b')).toHaveText('이 대화를 새 프로젝트로 옮길까요?')
  await expect(card.locator('[data-test="offer-move-conv"]')).toHaveText(`「${TITLE.E}」 · 메시지 2개`)
  await expect(card.locator('[data-test="offer-move-notice"]')).toHaveText('만들면 이 대화(메시지 2개)를 새 프로젝트로 옮겨요. 옮긴 대화는 그 프로젝트에서만 볼 수 있고, 채팅 목록과 전체 대화에서는 사라져요.')
  await expect(card.locator('[data-test="offer-doc"]')).toHaveCount(0)
  await expect(card.locator('[data-test="offer-make"]')).toHaveText('만들고 옮기기')
  await expect(card.locator('[data-test="offer-title"]')).toHaveValue('거래처 미팅 후속')
  await card.scrollIntoViewIfNeeded()
  await shot(p, 'f-tm-03-new-card')
  await card.locator('[data-test="offer-make"]').click()
  await expect(p).toHaveURL(new RegExp(`/projects/[0-9a-f-]{36}/t/${CONV.E}$`), { timeout: 30000 })
  const pid = /\/projects\/([0-9a-f-]{36})\//.exec(p.url())[1]
  await expect(p.getByTestId('chat-notice')).toHaveText('프로젝트 「거래처 미팅 후속」으로 옮겼어요 · 채팅 목록에서는 빠졌어요')
  await expect(p.locator('[data-test="moved-note"]')).toContainText('채팅에서 옮겨 온 대화예요 · 메시지 3개')
  await expect(p.locator('[data-test="project-offer"][data-state="made"]').locator('[data-test="offer-moved"]')).toHaveText('대화(메시지 3개)를 이 프로젝트로 옮겼어요')
  await expect(p.locator('.row').filter({ hasText: '거래처 미팅 메모를 정리했어요' })).toHaveCount(1)
  await shot(p, 'f-tm-03-new-project')
  expect(await chatConvs()).not.toContain(CONV.E)
  expect((await S.q('select title from pro_threads where id=$1', [pid]))[0].title).toBe('거래처 미팅 후속')
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-TM-04 휴대폰 390(밝은): 말로 「이 대화 견적 모음 프로젝트로 옮겨 줘」 → 카드(판정 모델이 고른 프로젝트) → 같은 알림을 거쳐 옮김', async ({ browser }) => {
  test.setTimeout(180_000)
  const p = await open(browser, HY, PHONE)
  await toConversation(p, 'H', { phone: true })
  await composer(p).fill(WORDS)
  await composer(p).press('Enter')
  const card = p.locator('[data-test="conv-move-card"]').last()
  await expect(card).toBeVisible({ timeout: 40000 })
  await expect(card.locator('header b')).toHaveText('이 대화를 프로젝트로 옮길까요?')
  await expect(card.locator('[data-test="conv-move-named"]')).toHaveText('「견적 모음」으로 옮기기')
  await card.scrollIntoViewIfNeeded()
  await inView(card.locator('[data-test="conv-move-named"]'), p)
  await noSideScroll(p)
  await shot(p, 'f-tm-04-card')
  // nothing moved yet
  expect(await chatConvs()).toContain(CONV.H)
  await card.locator('[data-test="conv-move-named"]').click()
  await expect(sheet(p)).toHaveAttribute('data-step', 'confirm', { timeout: 15000 })
  await expect(sheet(p).locator('[data-test="move-notice"]')).toContainText('는 프로젝트 「견적 모음」에서만 볼 수 있어요. 채팅 목록과 전체 대화에서는 사라져요.')
  await shot(p, 'f-tm-04-confirm')
  await sheet(p).locator('[data-test="move-go"]').click()
  await expect(p).toHaveURL(new RegExp(`/projects/${P4.id}/t/${CONV.H}$`), { timeout: 20000 })
  await expect(p.locator('[data-test="conv-move-card"][data-state="moved"]')).toContainText('대화를 프로젝트로 옮겼어요')
  // the words that asked and the acknowledgement were that conversation's (the view was narrowed to it): they went along
  const moved = await projectRows(P4.id)
  expect(moved.some((m) => m.content?.text === WORDS)).toBe(true)
  expect(moved.some((m) => m.content?.text === '아래 카드에서 프로젝트를 확인하면 이 대화를 옮길게요.')).toBe(true)
  await shot(p, 'f-tm-04-in-project')
  expect(await chatConvs()).not.toContain(CONV.H)
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-TM-05 긴 대화의 맨 아래에서도 대화 막대가 위에 붙어 있다 — 휴대폰은 한 줄, 글을 쓰는 동안은 더 접힘(밝은 · 어두운 · 1280)', async ({ browser }) => {
  test.setTimeout(180_000)
  // the newest message of the conversation brought into view (a filtered view opens there — PR #124), the list's own scroll
  const bottom = async (p, last = '12일차는 오전에 이론') => {
    const row = p.locator('.row').filter({ hasText: last })
    await row.scrollIntoViewIfNeeded()
    await p.evaluate(() => { for (const el of document.querySelectorAll('.scroll.msgs')) el.scrollTop = el.scrollHeight })
    await expect(row).toBeInViewport()
  }
  for (const theme of ['light', 'dark']) {
    const p = await open(browser, HY, PHONE, { theme })
    await toConversation(p, 'L', { phone: true })
    await bottom(p)
    const cur = bar(p).getByTestId('cbar-current')
    await expect(cur).toBeInViewport()
    const b = await bar(p).boundingBox()
    expect(b.y, '맨 위 막대 아래에').toBeGreaterThanOrEqual(60)
    expect(b.y).toBeLessThanOrEqual(90)
    expect(b.height, '한 줄').toBeLessThanOrEqual(48)
    await expect(bar(p).getByTestId('cbar-count')).toHaveText('메시지 24개')
    await expect(bar(p).getByTestId('cbar-other')).toBeVisible()
    await inView(bar(p).getByTestId('cbar-other'), p)
    await noSideScroll(p)
    await shot(p, `f-tm-05-pinned-${theme}`)
    // typing: the keyboard takes the lower half (the page gets shorter while the composer is focused) — the bar folds to the name and ▾
    await composer(p).focus()
    await p.setViewportSize({ width: 390, height: 470 })
    await expect(bar(p).getByTestId('cbar-count')).toBeHidden()
    await expect(bar(p).getByTestId('grade-chip')).toBeHidden()
    await expect(cur).toBeInViewport()
    const k = await bar(p).boundingBox()
    expect(k.height).toBeLessThanOrEqual(44)
    await noSideScroll(p)
    await shot(p, `f-tm-05-typing-${theme}`)
    // the menu still opens from there
    await bar(p).getByTestId('cbar-other').click()
    await expect(bar(p).getByTestId('cbar-move')).toBeVisible()
    await p.setViewportSize({ width: 390, height: 844 })
    expect(p.errors).toEqual([])
    await p.context().close()
  }
  // a wide screen: the bar as it was (its full words), pinned too
  const d = await open(browser, HY, DESK)
  await toConversation(d, 'L')
  await bottom(d)
  await expect(bar(d).getByTestId('cbar-current')).toBeInViewport()
  await expect(bar(d).getByTestId('cbar-count')).toHaveText('이 대화의 메시지 24개 · 여기서 물으면 이 대화에 이어져요')
  await shot(d, 'f-tm-05-pinned-desk')
  // the whole chat: the pill flows with the messages (not pinned)
  await d.goto('/chat')
  await expect(bar(d).getByTestId('cbar-pill')).toBeVisible({ timeout: 30000 })
  await bottom(d)
  await expect(bar(d).getByTestId('cbar-pill')).not.toBeInViewport()
  expect(d.errors).toEqual([])
  await d.context().close()
})

test('F-TM-06 옛 화면에서 옮긴 대화에 보낸 말은 프로젝트의 그 주제로 따라가고 입력창에 다시 들어감', async ({ browser }) => {
  test.setTimeout(180_000)
  const p = await open(browser, HY, PHONE)
  // this screen hears nothing live (a proxy that held the stream back): the move reaches it only through what the server says
  await p.context().route('**/api/events**', (r) => r.abort())
  await toConversation(p, 'B', { phone: true })
  const moved = await S.api(HY.token, `/conversations/${CONV.B}/move`, { method: 'POST', body: { project: P1.id } })
  expect(moved.moved).toBe(2)
  await expect(p).toHaveURL(new RegExp(`/chat/c/${CONV.B}$`))
  // two messages: the first held on its way a moment, the second waits behind it — both come back (PR #125 final check 2)
  await p.route(`**/api/threads/${MAIN.id}/messages`, async (r) => { await new Promise((ok) => setTimeout(ok, 1200)); await r.continue() })
  const words = '회의록에 참석자 명단도 넣어 줘'
  const more = '결정 사항은 굵게 표시해 줘'
  await composer(p).fill(words)
  await composer(p).press('Enter')
  await composer(p).fill(more)
  await composer(p).press('Enter')
  await expect(p).toHaveURL(new RegExp(`/projects/${P1.id}/t/${CONV.B}$`), { timeout: 20000 })
  await expect(p.getByTestId('chat-notice')).toHaveText('이 대화는 프로젝트 「가나정밀 1차 교육」으로 옮겼어요 · 보낸 말은 입력창에 다시 넣었어요')
  await expect(composer(p)).toHaveValue(`${words}\n${more}`)
  // not kept as a failed send in the chat
  await expect(p.locator('[data-test="send-issue"]')).toHaveCount(0)
  expect((await S.q(`select count(*)::int as n from pro_messages where thread_id=$1 and content->>'text' = any($2)`, [MAIN.id, [words, more]]))[0].n).toBe(0)
  await noSideScroll(p)
  await shot(p, 'f-tm-06-followed')
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-TM-07 1280: 그 사이 다른 화면으로 갔으면 끌고 가지 않고 알림만 — 나중에 그 대화를 열면 말이 입력창에', async ({ browser }) => {
  test.setTimeout(180_000)
  const p = await open(browser, HY, DESK)
  await p.context().route('**/api/events**', (r) => r.abort())
  await toConversation(p, 'L')
  // moved elsewhere (another screen); this page has not heard, and its message is slow on the way
  await S.api(HY.token, `/conversations/${CONV.L}/move`, { method: 'POST', body: { project: P4.id } })
  await p.route(`**/api/threads/${MAIN.id}/messages`, async (r) => { await new Promise((ok) => setTimeout(ok, 1500)); await r.continue() })
  const words = '13일차 일정도 정리해 줘'
  await composer(p).fill(words)
  await composer(p).press('Enter')
  // meanwhile the person went to 「프로젝트」
  await p.locator('.seg button').filter({ hasText: /^(프로젝트|Projects)$/ }).click()
  await expect(p).toHaveURL(/\/projects$/)
  await expect(p.getByTestId('chat-notice')).toHaveText('이 대화는 프로젝트 「견적 모음」으로 옮겼어요 · 그 대화를 열면 보낸 말이 입력창에 다시 들어가요', { timeout: 20000 })
  await expect(p).toHaveURL(/\/projects$/)
  await shot(p, 'f-tm-07-told')
  // later: the project, then that conversation — the words are back in its composer
  await p.locator(`.item[data-project="${P4.id}"]`).click()
  await p.locator(`[data-testid="project-topic"][data-conv="${CONV.L}"]`).click()
  await expect(p).toHaveURL(new RegExp(`/projects/${P4.id}/t/${CONV.L}$`))
  await expect(composer(p)).toHaveValue(words)
  await expect(p.getByTestId('chat-notice')).toHaveText('이 대화는 프로젝트 「견적 모음」으로 옮겼어요 · 보낸 말은 입력창에 다시 넣었어요')
  await shot(p, 'f-tm-07-refilled')
  expect(p.errors).toEqual([])
  await p.context().close()
})

// ---- the chat's conversation list (ThreadList.vue) over a busy picture: as readable as the project list, and 「프로젝트로 옮기기」 from its rows
// (2026-11-28 사용자, a phone over a photo: 「채팅 쓰레드 너무 글씨가 흐려... 그냥 프로젝트 쪽과 같이」 · 「쓰레드 내용을 곧바로 프로젝트로 만드는 기능
// 어떻게 되고 있니?」 — the move was only in the conversation bar's 「다른 대화 ▾」)
// a busy picture under the page, harsher than a photo (dark leaves and light sky in stripes), with the photo's own scrim (sky/PhotoBackdrop.vue)
async function busyBackdrop(p) {
  await p.evaluate(() => {
    if (document.getElementById('rt-busy')) return
    const d = document.createElement('div')
    d.id = 'rt-busy'
    const dark = document.documentElement.dataset.theme === 'dark'
    const scrim = dark
      ? 'linear-gradient(180deg, rgba(6 8 18 / .58) 0%, rgba(6 8 18 / .34) 28%, rgba(6 8 18 / .36) 62%, rgba(6 8 18 / .64) 100%)'
      : 'linear-gradient(180deg, rgba(248 249 252 / .5) 0%, rgba(248 249 252 / .2) 30%, rgba(248 249 252 / .24) 64%, rgba(248 249 252 / .55) 100%)'
    d.style.cssText = `position:fixed;inset:0;z-index:0;pointer-events:none;background:${scrim},repeating-linear-gradient(35deg,#2e5a2e 0 14px,#e8eef5 14px 22px,#6b8f4e 22px 34px,#c9d8e6 34px 44px)`
    const page = document.querySelector('.stage > .page')
    page.parentNode.insertBefore(d, page)
  })
}
const alphaOf = (loc) => loc.evaluate((el) => { const m = getComputedStyle(el).color.match(/rgba?\(([^)]+)\)/); const v = m ? m[1].split(/[ ,/]+/).filter(Boolean) : []; return v.length > 3 ? Number(v[3]) : 1 })
async function longPress(p, el, ms = 700) {
  let b = await el.boundingBox()
  for (let i = 0; i < 20; i++) {
    await p.waitForTimeout(120)
    const n = await el.boundingBox()
    if (n && b && Math.abs(n.y - b.y) < 1 && Math.abs(n.x - b.x) < 1) break
    b = n
  }
  const x = b.x + Math.min(b.width / 2, 80), y = b.y + b.height / 2
  await expect.poll(() => el.evaluate((node, [px, py]) => node.contains(document.elementFromPoint(px, py)), [x, y]), { timeout: 5000 }).toBe(true)
  const cdp = await p.context().newCDPSession(p)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
  await p.waitForTimeout(ms)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await cdp.detach().catch(() => {})
}
const tlist = (p) => p.getByTestId('thread-list')
async function openThreadList(p) {
  await bar(p).getByTestId('cbar-pill').click({ timeout: 30000 })
  await bar(p).getByTestId('cbar-open-list').click()
  await expect(tlist(p)).toBeVisible()
}

test('F-TM-08 휴대폰 390(밝은) · 사진 위: 대화 목록은 프로젝트 목록처럼 읽힘(큰 이름 · 진한 한 줄 · 시각과 수는 배지) · 길게 누르면 「프로젝트로 옮기기」', async ({ browser }) => {
  const p = await open(browser, HY, PHONE)
  await p.goto('/chat')
  await p.locator('.seg button').filter({ hasText: /^(채팅|Chat)$/ }).click()
  await openThreadList(p)
  await busyBackdrop(p)
  const row = tlist(p).locator('.rowwrap.movable').first()
  await expect(row).toBeVisible()
  // the project list's size and ink: a big name, the line under it no fainter than the secondary ink, the time and count on a solid badge
  const name = row.locator('.name')
  expect(await name.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(22)
  expect(await alphaOf(row.locator('.line'))).toBeGreaterThanOrEqual(0.5)
  expect(await alphaOf(tlist(p).locator('.cap'))).toBeGreaterThanOrEqual(0.5)
  const meta = row.locator('.meta')
  await expect(meta.locator('.when')).not.toHaveText('')
  expect(await meta.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)')
  expect(await alphaOf(meta)).toBe(1)
  // (the 「프로젝트로 옮기기」 button takes no room and no touch on a phone — the row is held instead)
  expect(await row.getByTestId('thread-move').evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none')
  await noSideScroll(p)
  await shot(p, 'f-tm-08-list-phone-light')
  // the project list over the same picture, for comparison
  await p.locator('.seg button').filter({ hasText: /^(프로젝트|Projects)$/ }).click()
  await expect(p.locator('aside.plist')).toBeVisible({ timeout: 15000 })
  await busyBackdrop(p)
  await shot(p, 'f-tm-08-projects-phone-light')
  // back to the list: a long press on a row opens 「프로젝트로 옮기기」 for that conversation (the list stays under it); a tap still picks it
  await p.locator('.seg button').filter({ hasText: /^(채팅|Chat)$/ }).click()
  if (!(await tlist(p).isVisible())) await openThreadList(p)
  const title = (await row.locator('.name').innerText()).trim()
  await longPress(p, row.getByTestId('thread-row'))
  await expect(sheet(p)).toHaveAttribute('data-step', 'pick', { timeout: 15000 })
  await expect(sheet(p)).toContainText(title)
  await expect(sheet(p).locator('[data-test="move-project"]').first()).toBeVisible({ timeout: 15000 })
  await shot(p, 'f-tm-08-list-hold-move')
  await sheet(p).locator('[data-test="move-close"]').click()
  await expect(sheet(p)).toHaveCount(0)
  await expect(tlist(p)).toBeVisible()
  expect(new URL(p.url()).pathname).toBe('/chat')
  await row.getByTestId('thread-row').tap()
  await expect.poll(() => new URL(p.url()).pathname).toMatch(/^\/chat\/c\//)
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-TM-09 1280(어두운): 대화 목록의 행에 포인터를 올리면 「프로젝트로 옮기기」 단추, 오른쪽 클릭도 같은 창 — 누르면 그 대화가 걸러짐', async ({ browser }) => {
  const p = await open(browser, HY, DESK, { theme: 'dark' })
  await p.goto('/chat')
  await openThreadList(p)
  await busyBackdrop(p)
  const row = tlist(p).locator('.rowwrap.movable').first()
  const mv = row.getByTestId('thread-move')
  expect(await alphaOf(row.locator('.line'))).toBeGreaterThanOrEqual(0.5)
  expect(Number(await mv.evaluate((el) => getComputedStyle(el).opacity))).toBe(0)
  await row.hover()
  await expect.poll(() => mv.evaluate((el) => Number(getComputedStyle(el).opacity))).toBe(1)
  await shot(p, 'f-tm-09-list-hover-dark')
  const title = (await row.locator('.name').innerText()).trim()
  await mv.click()
  await expect(sheet(p)).toHaveAttribute('data-step', 'pick', { timeout: 15000 })
  await expect(sheet(p)).toContainText(title)
  // (Esc at once — before its projects have come: the sheet has the focus from the start)
  await p.keyboard.press('Escape')
  await expect(sheet(p)).toHaveCount(0)
  // a right-click on the row: the same sheet, not the browser's menu
  await row.getByTestId('thread-row').click({ button: 'right' })
  await expect(sheet(p)).toHaveAttribute('data-step', 'pick', { timeout: 15000 })
  await expect(sheet(p)).toContainText(title)
  await p.keyboard.press('Escape')
  await expect(sheet(p)).toHaveCount(0)
  // 「전체 대화」 is not a conversation to move: no button beside it, and its right-click is the browser's own
  await expect(tlist(p).locator('.items > [data-testid="thread-move"]')).toHaveCount(0)
  await tlist(p).getByTestId('thread-all').click({ button: 'right' })
  await p.waitForTimeout(400)
  await expect(sheet(p)).toHaveCount(0)
  // a click still picks it
  await row.getByTestId('thread-row').click()
  await expect.poll(() => new URL(p.url()).pathname).toMatch(/^\/chat\/c\//)
  expect(p.errors).toEqual([])
  await p.context().close()
})
