// 휴대폰 알림을 메신저처럼 · AI 의 질문에 알림에서 바로 답하기(2026-11-26 사용자 — 안드로이드 알림 창의 카카오톡 · Gemini · Claude 알림을
// 보여 주며: 「퀵하게 대화방에서 온 내용 혹은 ai의 후먼인더루프 등을 모바일에서 보게할 수 있나?」, 스펙 openspec/specs/mobile-push).
// 지어낸 사람: 정하윤(알림을 받는 사람) · 김서연(팀원).
//   F-PH-01 휴대폰 390px 밝은 · 밤: Home 의 「브라우저 알림 켜기」 카드 — 글, 옆으로 넘치지 않음 → 「알림 켜기」 → 「알림이 켜져 있어요」 ·
//           「시험 알림 보내기」 → 가짜 푸시 서비스에 시험 알림이 오고 카드가 결과를 말함
//   F-PH-02 AI 의 질문: 채팅 에이전트(가짜 deepagents)가 묻고 멈춤 → 알림 피드 → 가짜 푸시 서비스 → 서비스 워커가 보여 준 알림(제목 ·
//           질문 · 보기 두 개의 단추) → 「세 줄 요약」 단추 → 그 말이 그 대화의 내 메시지로 가고 에이전트가 이어서 답함 · Home 카드 사라짐 ·
//           같은 알림을 다시 누르면 답하지 않고 그 대화를 연다
//   F-PH-03 방 메시지: 김서연이 1:1 방에 세 번 → 알림 하나(「김서연 · 3」, 마지막 두 줄, 방마다 한 태그) → 「답장」 → 그 방이 열리고 입력창에
//           글자를 바로 칠 수 있음; 방을 읽으면 그 방의 알림이 사라짐
//   F-PH-04 앞에 열어 둔 방의 메시지는 알리지 않고, 멘션은 언제나 알린다
//   F-PH-05 iPhone(Safari 탭, 홈 화면 앱 아님) 390px 밝은 · 밤: 「iPhone에서 알림 받기」 — iOS 16.4 이상 · 홈 화면에 추가한 앱에서만, 닫으면
//           다시 나오지 않음
//   F-PH-06 설정 › 계정 › 연결: 「알림이 켜져 있어요」 · 「시험 알림 보내기」(밤)
// 자기 스택(lib/localStack.js — 회사 push-hitl-ui, BFF 8973 · Vite 5373 부터 빈 포트, PRO_NOTIFY_FEED=1 로 알림 피드만 켬)을 띄우고 지운다.
// 푸시 서비스는 이 파일의 가짜(server/test/fixtures/fakePush.mjs): 실제 기기 · 실제 푸시 서비스로는 아무것도 가지 않는다 — 브라우저의
// pushManager.subscribe 도 막아 둔다. 서비스 워커의 처리기(public/sw.js self.__pgl)를 그 워커 안에서 부른다. 모델은 부르지 않는다.
//   cd e2e && npx playwright test --project=feature tests/feature/push-hitl.spec.js
import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import http from 'node:http'
import path from 'node:path'
import { startStack, REPO, waitFor } from '../../lib/localStack.js'
import { startFakePush } from '../../../server/test/fixtures/fakePush.mjs'

test.describe.configure({ mode: 'serial' })
test.use({ channel: 'chromium' })
const SHOTS = path.join(REPO, 'openspec/specs/mobile-push/e2e/results')
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ko-KR' }
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1'
const NOWHERE = 'http://127.0.0.1:9'
const TENANT = 'push-hitl-ui'
const HITL = JSON.stringify({ type: 'human_input_required', question: '어떤 형식으로 정리할까요?', context: '이번 주 회의록 초안이 준비됐어요.', options: ['세 줄 요약', '표로 정리'], run_state: {} })
let S, HY, SY, P, agent
const asked = [] // what the fake deepagents was sent

// ---- a fake deepagents: a turn whose message asks for the minutes stops to ask; any other turn answers ----
async function startAgent() {
  const srv = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      if (!req.url.endsWith('/chat/stream')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('[]') }
      let b = {}
      try { b = JSON.parse(raw) } catch { /* none */ }
      asked.push(b)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      if (b.conversation_id) res.write(`event: metadata\ndata: ${JSON.stringify({ conversation_id: b.conversation_id })}\n\n`)
      const msg = String(b.message || '')
      if (msg.includes('회의록')) res.end(`event: message\ndata: ${JSON.stringify({ type: 'done', content: HITL })}\n\n`)
      else res.end(`event: message\ndata: ${JSON.stringify({ type: 'token', content: '세 줄로 요약했어요. 결정 2건, 할 일 3건이에요.' })}\n\n`)
    })
  })
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok))
  return { url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((ok) => srv.close(ok)) }
}

test.beforeAll(async () => {
  test.setTimeout(240_000)
  fs.mkdirSync(SHOTS, { recursive: true })
  P = await startFakePush()
  agent = await startAgent()
  S = await startStack({ tenant: TENANT, apiFrom: Number(process.env.RT_API_FROM) || 8973, webFrom: Number(process.env.RT_WEB_FROM) || 5373,
    env: { PRO_DEEPAGENTS_URL: agent.url, PRO_COMPLETION_URL: NOWHERE, PRO_CONTEXT_ROUTER_URL: '', PRO_JUDGE_URL: '', PRO_MEMENTO_URL: NOWHERE,
      PRO_NOTIFY_FEED: '1', PRO_VAPID_FILE: path.join(os.tmpdir(), `pgl-vapid-${TENANT}-${process.pid}.json`) } })
  HY = await S.person(`pro-rt-${TENANT}-a@people-mail.test`, '정하윤')
  SY = await S.person(`pro-rt-${TENANT}-b@people-mail.test`, '김서연')
  for (const p of [HY, SY]) await S.join(p)
  await clean()
  // 정하윤's phone, as Chrome would have subscribed it — its endpoint is this test's fake push service
  const sub = P.subscription('hy')
  await S.q(`insert into pro_push_subscriptions(endpoint, user_id, tenant_id, p256dh, auth, ua) values ($1,$2,$3,$4,$5,'e2e phone')`, [sub.endpoint, HY.id, TENANT, sub.keys.p256dh, sub.keys.auth])
})
async function clean() {
  for (const sql of [`delete from notifications where tenant_id=$1`, `delete from pro_push_subscriptions where tenant_id=$1`,
    `delete from notifications where url in (select '/chats?id=' || id from chat_rooms where tenant_id=$1)`,
    'delete from chats where tenant_id=$1', 'delete from pro_chat_reads where room_id in (select id from chat_rooms where tenant_id=$1)', 'delete from chat_rooms where tenant_id=$1']) await S.q(sql, [TENANT]).catch(() => {})
}
test.afterAll(async () => {
  if (S) { await clean().catch(() => {}); await S.stop() }
  await P?.close(); await agent?.close()
})

// a page of 정하윤's: signed in, notifications allowed or not, no real push subscription (the browser's push service is never reached)
async function open(browser, who, { opts = PHONE, theme = 'light', allow = true, ua = null } = {}) {
  const ctx = await browser.newContext({ ...opts, ...(ua ? { userAgent: ua } : {}), baseURL: S.web })
  if (allow) await ctx.grantPermissions(['notifications'], { origin: S.web })
  await ctx.addInitScript(([s, th]) => {
    if (window.top !== window) return
    localStorage.setItem('pgpt-pro-session', s)
    localStorage.setItem('pgpt-pro-theme', th)
    localStorage.setItem('pgl-lang', 'ko')
    // (the install card is another test's)
    localStorage.setItem('pgl-install', JSON.stringify({ never: true }))
    if (window.PushManager) {
      PushManager.prototype.subscribe = () => Promise.reject(new Error('e2e: no push service'))
      PushManager.prototype.getSubscription = () => Promise.resolve(null)
    }
  }, [JSON.stringify(who.session), theme])
  const p = await ctx.newPage()
  p.errors = []
  p.on('pageerror', (e) => p.errors.push(String(e?.message || e)))
  return p
}
const shot = async (p, name) => { await p.waitForTimeout(450); await p.screenshot({ path: path.join(SHOTS, `${name}.png`) }) }
const noOverflow = (p) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
async function home(p) {
  await p.goto('/chat')
  await p.locator('.seg button').filter({ hasText: /^(홈|Home)$/ }).click()
}
// the page's service worker (public/sw.js), once it controls the page
async function worker(p) {
  await p.evaluate(() => navigator.serviceWorker.ready.then(() => true))
  return p.context().serviceWorkers()[0] || p.context().waitForEvent('serviceworker', { timeout: 15000 })
}
const shown = (sw, tag) => sw.evaluate(async (tg) => (await self.registration.getNotifications(tg ? { tag: tg } : {}))
  .map((n) => ({ title: n.title, body: n.body, tag: n.tag, requireInteraction: n.requireInteraction, actions: (n.actions || []).map((a) => ({ action: a.action, title: a.title })) })), tag)
const clearShown = (sw) => sw.evaluate(async () => { for (const n of await self.registration.getNotifications()) n.close() })
const click = (sw, tag, action) => sw.evaluate(async ([tg, a]) => { const [n] = await self.registration.getNotifications({ tag: tg }); return n ? self.__pgl.click(n, a) : 'none' }, [tag, action])
const received = (who, pick, ms = 20000) => waitFor(async () => (await P.payloads(who, 1, 200)).find(pick), ms, 'a push')
// the person's main chat, emptied (a run before this one left its messages)
async function mainThread(who) { const [t] = await S.api(who.token, '/threads'); await S.q('delete from pro_messages where thread_id=$1', [t.id]); return t.id }
async function send(who, threadId, text) {
  const r = await fetch(`http://127.0.0.1:${S.apiPort}/api/threads/${threadId}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${who.token}` }, body: JSON.stringify({ text }) })
  await r.text()
}

test('F-PH-01 Home 의 알림 카드: 켜기 → 켜져 있어요 → 시험 알림 보내기, 휴대폰 밝은 · 밤', async ({ browser }) => {
  for (const theme of ['light', 'dark']) {
    const p = await open(browser, HY, { theme, allow: false })
    await home(p)
    const card = p.locator('[data-test="notify-card"]')
    await expect(card).toHaveAttribute('data-state', 'ask')
    await expect(card).toContainText('브라우저 알림 켜기')
    await expect(card).toContainText('앱을 닫아도 팀 메시지 · AI 질문 · 내 할 일을 알려 드려요')
    expect(await noOverflow(p)).toBe(true)
    await shot(p, `f-ph-01a-ask-${theme}`)
    // the browser's question answered 「허용」
    await p.context().grantPermissions(['notifications'], { origin: S.web })
    await card.locator('[data-test="notify-on"]').click()
    await expect(card).toHaveAttribute('data-state', 'on')
    await expect(card).toContainText('알림이 켜져 있어요')
    const before = (await P.payloads('hy', 0, 0)).length
    await card.locator('[data-test="notify-test"]').click()
    // the server pushed one to 정하윤's phone (the fake); this test browser has no push service, so it showed one itself as well
    await expect(card.locator('[data-test="notify-said"]')).toHaveText('기기 1대에 보냈어요. 이 브라우저는 푸시를 받지 못해 직접 띄웠어요.')
    const got = await waitFor(async () => { const l = await P.payloads('hy', before + 1, 200); return l.length > before ? l.at(-1) : null }, 15000, 'the test push')
    expect(got).toMatchObject({ type: 'test', title: '시험 알림이에요', body: '이 알림이 보이면 휴대폰 알림이 켜진 거예요' })
    expect(await noOverflow(p)).toBe(true)
    await shot(p, `f-ph-01b-on-${theme}`)
    await card.locator('[data-test="notify-close"]').click()
    await expect(card).toHaveCount(0)
    expect(p.errors).toEqual([])
    await p.context().close()
  }
})

test('F-PH-02 AI 의 질문: 알림의 단추로 답하면 그 대화로 가고, 같은 알림은 두 번 답하지 않는다', async ({ browser }) => {
  const tid = await mainThread(HY)
  const p = await open(browser, HY)
  // (on 설정: the chat is not in front — a question arriving now is shown)
  await p.goto('/settings')
  const sw = await worker(p)
  await clearShown(sw)
  await send(HY, tid, '이번 주 회의록 정리해 줘')
  const ask = await received('hy', (x) => x.type === 'ai_ask')
  expect(ask).toMatchObject({ title: 'Process GPT 의 질문이 있어요', body: '어떤 형식으로 정리할까요?', place: '/chat', thread: tid,
    actions: [{ action: 'a0', title: '세 줄 요약' }, { action: 'a1', title: '표로 정리' }] })
  expect(ask.token).toMatch(/^pa1\./)
  expect(JSON.stringify(ask)).not.toContain(HY.token)
  // the phone shows it
  await sw.evaluate((d) => self.__pgl.push(d), ask)
  expect(await shown(sw, ask.tag)).toEqual([{ title: 'Process GPT 의 질문이 있어요', body: '어떤 형식으로 정리할까요?', tag: ask.tag, requireInteraction: true,
    actions: [{ action: 'a0', title: '세 줄 요약' }, { action: 'a1', title: '표로 정리' }] }])
  // and so does the Home, until it is answered
  await home(p)
  const homeCard = p.locator('[data-test="notice-card"]').filter({ hasText: 'Process GPT 의 질문이 있어요' })
  await expect(homeCard).toContainText('어떤 형식으로 정리할까요?')
  await expect(homeCard.locator('.verb')).toHaveText('질문')
  await shot(p, 'f-ph-02a-home-card')
  // 「세 줄 요약」 on the notification: answered without opening the app
  const n0 = asked.length
  expect(await click(sw, ask.tag, 'a0')).toBe('answered')
  await waitFor(() => asked.length > n0, 20000, 'the answer reached the agent')
  expect(asked.at(-1).message).toContain('세 줄 요약')
  const rows = await waitFor(async () => { const r = await S.api(HY.token, `/threads/${tid}/messages`); return r.some((m) => m.role === 'agent' && /세 줄로 요약했어요/.test(m.content?.text || '')) ? r : null }, 20000, 'the agent answered')
  expect(rows.filter((m) => m.role === 'user').map((m) => m.content.text)).toEqual(['이번 주 회의록 정리해 줘', '세 줄 요약'])
  await expect(homeCard).toHaveCount(0, { timeout: 15000 })
  // the same notification again (shown on another device): not answered twice — it opens the chat instead
  await sw.evaluate((d) => self.__pgl.push(d), ask)
  expect(await click(sw, ask.tag, 'a1')).toBe('told')
  await expect(p).toHaveURL(/\/chat$/)
  await expect(p.getByText('세 줄로 요약했어요. 결정 2건, 할 일 3건이에요.')).toBeVisible()
  const after = await S.api(HY.token, `/threads/${tid}/messages`)
  expect(after.filter((m) => m.role === 'user').length).toBe(2)
  await shot(p, 'f-ph-02b-answered-chat')
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-PH-03 방 메시지는 방마다 하나로 · 「답장」은 그 방의 입력창으로', async ({ browser }) => {
  const { id: room } = await S.api(SY.token, '/team/threads', { method: 'POST', body: { members: [HY.id] } })
  const p = await open(browser, HY)
  await p.goto('/settings')
  const sw = await worker(p)
  await clearShown(sw)
  for (const text of ['회의 자료 올렸어요', '견적서도 같이 봐 주세요', '오늘 안에 부탁해요']) {
    await S.api(SY.token, `/team/threads/${room}/messages`, { method: 'POST', body: { text } })
    await p.waitForTimeout(120)
  }
  // one pass of the feed or more: the newest is the room's, with all three counted
  const last = await received('hy', (x) => x.type === 'chat' && x.room === room && x.count === 3)
  expect(last).toMatchObject({ title: '김서연 · 3', body: '김서연: 견적서도 같이 봐 주세요\n김서연: 오늘 안에 부탁해요', tag: `pgl-room-${room}`, renotify: true,
    actions: [{ action: 'reply', title: '답장' }] })
  // the phone: whatever came before, one notification for the room
  for (const x of (await P.payloads('hy', 1, 200)).filter((y) => y.room === room)) await sw.evaluate((d) => self.__pgl.push(d), x)
  const list = await shown(sw)
  expect(list.filter((n) => n.tag === `pgl-room-${room}`)).toEqual([{ title: '김서연 · 3', body: '김서연: 견적서도 같이 봐 주세요\n김서연: 오늘 안에 부탁해요',
    tag: `pgl-room-${room}`, requireInteraction: false, actions: [{ action: 'reply', title: '답장' }] }])
  // 「답장」: that room, its composer ready
  expect(await click(sw, `pgl-room-${room}`, 'reply')).toBe('told')
  const ta = p.locator('.ms .cmp textarea')
  await expect(ta).toBeFocused({ timeout: 15000 })
  await expect(p.locator('.ms .msg').filter({ hasText: '오늘 안에 부탁해요' })).toBeVisible()
  await p.keyboard.type('지금 볼게요')
  await expect(ta).toHaveValue('지금 볼게요')
  expect(await noOverflow(p)).toBe(true)
  await shot(p, 'f-ph-03-reply-composer')
  // the room was read here: its notification goes
  await sw.evaluate((d) => self.__pgl.push(d), last)
  await p.evaluate((r) => import('/src/browserNotify.js').then((m) => m.clearRoom(r)), room)
  await expect.poll(async () => (await shown(sw, `pgl-room-${room}`)).length).toBe(0)
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-PH-04 앞에 열어 둔 방은 알리지 않고, 멘션은 언제나', async ({ browser }) => {
  const { id: room } = await S.api(SY.token, '/team/threads', { method: 'POST', body: { members: [HY.id] } })
  await S.api(SY.token, `/team/threads/${room}/messages`, { method: 'POST', body: { text: '첫 인사' } })
  const p = await open(browser, HY, { opts: { viewport: { width: 1280, height: 860 }, locale: 'ko-KR' } })
  await p.goto('/chat')
  const sw = await worker(p)
  await clearShown(sw)
  await p.locator('button.msg-btn').click()
  await p.locator('.ms .tabs button').filter({ hasText: '대화' }).click()
  await p.locator('.ms .th').filter({ hasText: '김서연' }).first().click()
  await p.locator('.ms .cmp textarea').waitFor()
  await p.bringToFront()
  const front = { id: 'x1', type: 'chat', title: '김서연', body: '김서연: 지금 보고 계신 방', tag: `pgl-room-${room}`, renotify: true, room, actions: [{ action: 'reply', title: '답장' }] }
  // the page in front says it shows this room: nothing is shown
  expect(await sw.evaluate((d) => self.__pgl.shownInFront(d), front)).toBe(true)
  expect(await sw.evaluate((d) => self.__pgl.push(d), front)).toBe(null)
  expect(await shown(sw, front.tag)).toEqual([])
  // another room: shown
  const other = { ...front, id: 'x2', room: 'another-room', tag: 'pgl-room-another-room' }
  await sw.evaluate((d) => self.__pgl.push(d), other)
  expect((await shown(sw, other.tag)).length).toBe(1)
  // a mention of me in the room I am looking at: always shown
  const mention = { id: 'x3', type: 'team', title: '김서연님이 나를 언급했어요', body: '@정하윤 확인 부탁해요', room, mention: true, tag: 'pgl-x3', renotify: true, actions: [{ action: 'reply', title: '답장' }] }
  await sw.evaluate((d) => self.__pgl.push(d), mention)
  expect(await shown(sw, 'pgl-x3')).toEqual([{ title: '김서연님이 나를 언급했어요', body: '@정하윤 확인 부탁해요', tag: 'pgl-x3', requireInteraction: false, actions: [{ action: 'reply', title: '답장' }] }])
  // the same room with the messenger closed: shown
  await p.locator('[data-test="msg-close"]').click()
  await expect.poll(() => sw.evaluate((d) => self.__pgl.shownInFront(d), front), { timeout: 10000 }).toBe(false)
  await p.context().close()
})

test('F-PH-05 iPhone 의 Safari 탭: 홈 화면에 추가한 앱에서만 — 밝은 · 밤, 닫으면 다시 나오지 않는다', async ({ browser }) => {
  for (const theme of ['light', 'dark']) {
    const p = await open(browser, HY, { theme, allow: false, ua: IPHONE_UA })
    await home(p)
    const card = p.locator('[data-test="notify-card"]')
    await expect(card).toHaveAttribute('data-state', 'ios')
    await expect(card).toContainText('iPhone에서 알림 받기')
    await expect(card).toContainText('iOS 16.4 이상')
    await expect(card).toContainText('홈 화면에 추가')
    await expect(card.locator('[data-test="notify-on"]')).toHaveCount(0)
    expect(await noOverflow(p)).toBe(true)
    await shot(p, `f-ph-05-ios-${theme}`)
    await card.locator('[data-test="notify-close"]').click()
    await expect(card).toHaveCount(0)
    await p.reload()
    await p.locator('.seg button').filter({ hasText: /^(홈|Home)$/ }).click()
    await expect(p.locator('[data-test="notify-card"]')).toHaveCount(0)
    await p.context().close()
  }
})

test('F-PH-06 설정 › 계정 › 연결: 알림 상태와 「시험 알림 보내기」 (밤)', async ({ browser }) => {
  const p = await open(browser, HY, { theme: 'dark' })
  await p.goto('/settings/accounts')
  const row = p.locator('[data-test="notify-card"]')
  await expect(row).toHaveAttribute('data-state', 'on')
  await expect(row).toContainText('이 기기의 알림 · 켜짐')
  await row.locator('[data-test="notify-test"]').click()
  await expect(row.locator('[data-test="notify-said"]')).toContainText('기기 1대에 보냈어요')
  await row.scrollIntoViewIfNeeded()
  expect(await noOverflow(p)).toBe(true)
  await shot(p, 'f-ph-06-settings-dark')
  await p.context().close()
})
