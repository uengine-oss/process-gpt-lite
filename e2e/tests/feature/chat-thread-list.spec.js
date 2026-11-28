// 채팅의 대화 목록(2026-11-24 사용자 요청: 「채팅을 더블클릭하면 프로젝트에서의 목록처럼 왼편에 묶음 처리된 쓰레드 목록이 쭉 나와서
// 필터링됨」 — 스펙 openspec/specs/chat-thread-list). 「채팅」을 두 번 누르면 판단 모델이 나눈 대화(context_threads)가 Home 자리에
// 최근 순으로 나오고, 고르면 채팅이 그 대화만(/chat/c/:cid — 대화 막대와 같은 길), 「전체 대화」로 돌아감, 찾기, 닫기(두 번 · ✕ · Home),
// 한 번 누르기는 그대로, 새로 고침에도 열린 채, 휴대폰 390px 은 시트, 밤 테마, 새 턴이 오면 목록이 따라옴. 모델 없이 고정 데이터로.
// 순수 규칙(순서 · 찾기 · 한 번/두 번 누르기)은 server/test/chatThreadList.test.js.
// F-CT-11 · 12(2026-11-25 운영 화면 — 대화 안에 브리프와 예약 실행이 섞여 있었다): 예약 실행과 브리프가 실제로 도착하는 길(BFF → 가짜
// deepagents · 가짜 모델)로 온다. 그래서 BFF 를 PRO_DEEPAGENTS_URL=http://127.0.0.1:<RT_FAKE_AGENT_PORT, 기본 8986> ·
// PRO_LLM_BASE_URL=http://127.0.0.1:<RT_FAKE_LLM_PORT, 기본 8987>/v1 로 띄운다(두 가짜는 이 파일이 띄운다).
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../../lib/fixtures.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const SHOTS = path.resolve(here, '../../../openspec/specs/chat-thread-list/e2e/results')
const PHONE = { width: 390, height: 844 }
// Playwright's own Chromium (never a person's Chrome)
test.use({ channel: 'chromium' })
// one account's main chat and its conversations, reseeded by every test
test.describe.configure({ mode: 'serial' })

const conv = (id, title, action = 'new') => ({ conversationId: id, action, title, by: 'judge' })
// four conversations the router told apart, as it and the agent would have left them: messages in the main chat, a context_threads row
// each, last touched 5 minutes · 30 minutes · 2 hours · 3 days ago
const THREADS = [
  { id: 'rt-ct-trip', title: '부산 출장 숙소', gist: '숙소 비교', summary: '최근 요청: 조식 포함인 곳만 다시 골라 줘\n최근 답: 조식 포함 숙소는 B 호텔 한 곳이에요.', min: 5 },
  { id: 'rt-ct-quote', title: '견적서 검토', gist: '', summary: '최근 요청: 가온상사 견적서 단가가 맞는지 봐 줘\n최근 답: 단가 두 곳이 시장가보다 높아요.', min: 30 },
  { id: 'rt-ct-report', title: '주간 보고서 초안', gist: '보고서 작성', summary: '최근 요청: 이번 주 매출 보고서 초안 써 줘\n최근 답: 초안을 만들었어요.', min: 120 },
  { id: 'rt-ct-yt', title: '유튜브 채널 분석', gist: '', summary: '최근 요청: 우리 채널 최근 영상 조회수 알려 줘\n최근 답: 최근 영상 10개를 정리했어요.', min: 3 * 1440 },
]
const ANSWER = {
  trip: '조식 포함 숙소는 B 호텔 한 곳이에요.',
  quote: '단가 두 곳이 시장가보다 높아요.',
  report: '보고서 초안을 만들었어요.',
  yt: '최근 영상 10개의 조회수를 정리했어요.',
}
async function seed(db, u) {
  const th = await db.clearMain(u.id)
  await db.addMessages(th, [
    { role: 'user', kind: 'text', content: { text: '우리 채널 최근 영상 조회수 알려 줘' } },
    { role: 'agent', kind: 'text', content: { text: ANSWER.yt, context: conv('rt-ct-yt', '유튜브 채널 분석') } },
    { role: 'user', kind: 'text', content: { text: '이번 주 매출 보고서 초안 써 줘' } },
    { role: 'agent', kind: 'text', content: { text: ANSWER.report, context: conv('rt-ct-report', '주간 보고서 초안') } },
    { role: 'user', kind: 'text', content: { text: '해운대 근처 숙소 세 곳 비교해 줘' } },
    { role: 'agent', kind: 'text', content: { text: '숙소 세 곳을 표로 비교했어요.', context: conv('rt-ct-trip', '부산 출장 숙소') } },
    { role: 'user', kind: 'text', content: { text: '가온상사 견적서 단가가 맞는지 봐 줘' } },
    { role: 'agent', kind: 'text', content: { text: ANSWER.quote, context: conv('rt-ct-quote', '견적서 검토') } },
    { role: 'user', kind: 'text', content: { text: '조식 포함인 곳만 다시 골라 줘' } },
    { role: 'agent', kind: 'text', content: { text: ANSWER.trip, context: conv('rt-ct-trip', '부산 출장 숙소', 'continue') } },
  ])
  for (const t of THREADS) {
    await db.q(`insert into context_threads(tenant_id,user_id,conversation_id,title,summary,gist,turns,updated_at)
                values ($1,$2,$3,$4,$5,$6,1, now() - make_interval(mins => $7))`, [db.tenant, u.id, t.id, t.title, t.summary, t.gist, t.min])
  }
  return th
}

const chatTab = (page) => page.locator('.top .seg button[data-tab="chat"]')
const list = (page) => page.getByTestId('thread-list')
const rows = (page) => page.getByTestId('thread-row')
const dock = (page) => page.locator('aside.dock')
const stored = (page) => page.evaluate(() => { try { return localStorage.getItem('pgl-chat-thread-list') } catch { return 'blocked' } })
// the screen's own transitions are over (endless ones — a spinner — are not waited for)
const settled = (page) => page.evaluate(() => Promise.all(document.getAnimations()
  .filter((a) => a.effect?.getComputedTiming?.().iterations !== Infinity).map((a) => a.finished.catch(() => {}))))
async function chat(page, url = '/chat') {
  await page.goto(url)
  await expect(page.locator('.composer textarea').first()).toBeVisible({ timeout: 30_000 })
}
async function shot(page, name) {
  await settled(page)
  await page.screenshot({ path: path.join(SHOTS, name) })
}

test('F-CT-01 「채팅」을 두 번 누르면 Home 자리에 대화 목록: 최근 순, 제목 · 한 줄 · 시각 · 메시지 수, 맨 위 「전체 대화」', async ({ pageAs, db }) => {
  const page = await pageAs('ct-user')
  await page.context().addInitScript(() => { try { localStorage.setItem('pgpt-pro-theme', 'light') } catch { /* ignore */ } })
  await seed(db, page.user)
  // (the light theme over the daytime sky: ?hour= previews another time of day)
  await chat(page, '/chat?hour=13')
  await expect(dock(page)).toBeVisible()
  await expect(list(page)).toHaveCount(0)
  await expect(chatTab(page)).toHaveAttribute('title', '두 번 누르면 대화 목록')
  // the list is fetched again as it opens
  const fetched = page.waitForRequest((r) => r.url().includes('/api/conversations') && r.method() === 'GET')
  await chatTab(page).dblclick()
  await fetched
  await expect(list(page)).toBeVisible()
  await expect(dock(page)).toHaveCount(0)
  await expect(page).toHaveURL(/\/chat$/)
  await expect(chatTab(page)).toHaveAttribute('aria-expanded', 'true')
  // the column is Home's: the chat moves over beside it
  const box = await list(page).boundingBox()
  expect(box.x).toBe(0)
  expect(box.width).toBe(420)
  // 「전체 대화」 first, then newest first
  await expect(page.getByTestId('thread-all')).toHaveClass(/\bon\b/)
  await expect(page.getByTestId('thread-all').locator('.count')).toHaveText('10')
  await expect(rows(page).locator('.name')).toHaveText(['부산 출장 숙소', '견적서 검토', '주간 보고서 초안', '유튜브 채널 분석'])
  await expect(rows(page).locator('.when')).toHaveText(['5분 전', '30분 전', '2시간 전', /^\d{1,2}\. \d{1,2}\.$/])
  await expect(rows(page).locator('.count')).toHaveText(['4', '2', '2', '2'])
  await expect(rows(page).nth(0).locator('.count')).toHaveAttribute('aria-label', '메시지 4개')
  await expect(rows(page).nth(0).locator('.line')).toHaveText('숙소 비교 · 조식 포함인 곳만 다시 골라 줘')
  await expect(rows(page).nth(1).locator('.line')).toHaveText('가온상사 견적서 단가가 맞는지 봐 줘')
  await expect(page.locator('.tlist .head .n')).toHaveText('4')
  await shot(page, 'f-ct-01-open-light.png')
  expect(page.errors).toEqual([])
})

test('F-CT-02 행을 고르면 채팅이 그 대화만(/chat/c/:cid, 대화 막대와 같음), 목록은 열린 채로 옮겨 다니고, 「전체 대화」는 전체로', async ({ pageAs, db }) => {
  const page = await pageAs('ct-user')
  await seed(db, page.user)
  await chat(page)
  await chatTab(page).dblclick()
  await rows(page).filter({ hasText: '견적서 검토' }).click()
  await expect(page).toHaveURL(/\/chat\/c\/rt-ct-quote$/)
  await expect(rows(page).filter({ hasText: '견적서 검토' })).toHaveClass(/\bon\b/)
  await expect(rows(page).filter({ hasText: '견적서 검토' })).toHaveAttribute('aria-current', 'true')
  await expect(page.getByTestId('thread-all')).not.toHaveClass(/\bon\b/)
  await expect(page.getByText(ANSWER.quote)).toBeVisible()
  for (const t of [ANSWER.trip, ANSWER.report, ANSWER.yt]) await expect(page.getByText(t)).toHaveCount(0)
  // the conversation bar over the chat says the same
  await expect(page.locator('.cbar.inside .cur b')).toHaveText('견적서 검토')
  await expect(list(page)).toBeVisible()
  await shot(page, 'f-ct-02-filtered.png')
  // another one: the highlight follows, the list stays
  await rows(page).filter({ hasText: '부산 출장 숙소' }).click()
  await expect(page).toHaveURL(/\/chat\/c\/rt-ct-trip$/)
  await expect(page.locator('.tlist .item.on')).toHaveCount(1)
  await expect(rows(page).filter({ hasText: '부산 출장 숙소' })).toHaveClass(/\bon\b/)
  await expect(page.getByText(ANSWER.trip)).toBeVisible()
  await expect(page.getByText('숙소 세 곳을 표로 비교했어요.')).toBeVisible()
  await expect(page.getByText(ANSWER.quote)).toHaveCount(0)
  // the bar's way back and the list agree
  await page.locator('.cbar .back').click()
  await expect(page).toHaveURL(/\/chat$/)
  await expect(page.getByTestId('thread-all')).toHaveClass(/\bon\b/)
  await page.goto('/chat/c/rt-ct-report')
  await expect(rows(page).filter({ hasText: '주간 보고서 초안' })).toHaveClass(/\bon\b/)
  // 「전체 대화」: the whole chat again
  await page.getByTestId('thread-all').click()
  await expect(page).toHaveURL(/\/chat$/)
  for (const t of Object.values(ANSWER)) await expect(page.getByText(t)).toBeVisible()
  await expect(page.locator('.cbar.inside')).toHaveCount(0)
  await expect(list(page)).toBeVisible()
  expect(page.errors).toEqual([])
})

test('F-CT-03 찾기: 제목 · 요약에서 글자로, 낱말마다, 없으면 한 줄, 지우면 모두', async ({ pageAs, db }) => {
  const page = await pageAs('ct-user')
  await seed(db, page.user)
  await chat(page)
  await chatTab(page).dblclick()
  const box = page.getByTestId('thread-search')
  await box.fill('보고')
  await expect(rows(page).locator('.name')).toHaveText(['주간 보고서 초안'])
  // the summary (the last request, the last answer) and the gist
  await box.fill('조식')
  await expect(rows(page).locator('.name')).toHaveText(['부산 출장 숙소'])
  await box.fill('시장가')
  await expect(rows(page).locator('.name')).toHaveText(['견적서 검토'])
  await box.fill('최근 영상')
  await expect(rows(page).locator('.name')).toHaveText(['유튜브 채널 분석'])
  await box.fill('없는 대화')
  await expect(rows(page)).toHaveCount(0)
  await expect(page.getByTestId('thread-none')).toHaveText('「없는 대화」와 맞는 대화가 없어요.')
  // 「전체 대화」 is still there
  await expect(page.getByTestId('thread-all')).toBeVisible()
  await box.fill('견적')
  await expect(rows(page)).toHaveCount(1)
  await shot(page, 'f-ct-03-search.png')
  await box.press('Escape')
  await expect(box).toHaveValue('')
  await expect(rows(page)).toHaveCount(4)
  expect(page.errors).toEqual([])
})

test('F-CT-04 닫기: 「채팅」 두 번 · 머리의 ✕ · Home 단추(Home 이 같은 칸을 차지), 다시 두 번이면 목록이 Home 을 밀어냄', async ({ pageAs, db }) => {
  const page = await pageAs('ct-user')
  await seed(db, page.user)
  await chat(page)
  // twice: open, twice again: closed (Home stays put away — it was replaced, the clock shows)
  await chatTab(page).dblclick()
  await expect(list(page)).toBeVisible()
  await page.waitForTimeout(500)
  await chatTab(page).dblclick()
  await expect(list(page)).toHaveCount(0)
  await expect(dock(page)).toHaveCount(0)
  await expect(page.locator('.center')).not.toHaveClass(/shifted/)
  await expect(page.locator('.clock')).toBeVisible()
  // the header's ✕
  await page.waitForTimeout(500)
  await chatTab(page).dblclick()
  await expect(list(page)).toBeVisible()
  await page.getByTestId('thread-list-close').click()
  await expect(list(page)).toHaveCount(0)
  expect(await stored(page)).toBe('0')
  // Home's button: Home takes the column, the list goes
  await chatTab(page).dblclick()
  await expect(list(page)).toBeVisible()
  await page.locator('.top .home').click()
  await expect(dock(page)).toBeVisible()
  await expect(list(page)).toHaveCount(0)
  expect(await stored(page)).toBe('0')
  await shot(page, 'f-ct-04a-home-replaces.png')
  // and the other way: the list pushes Home away
  await chatTab(page).dblclick()
  await expect(list(page)).toBeVisible()
  await expect(dock(page)).toHaveCount(0)
  await expect(page.locator('.top .home')).not.toHaveClass(/\bon\b/)
  // the conversation bar's 「대화 목록 펼치기」 (with Home open)
  await page.locator('.top .home').click()
  await expect(dock(page)).toBeVisible()
  await page.locator('.cbar .pill').click()
  await page.getByTestId('cbar-open-list').click()
  await expect(list(page)).toBeVisible()
  await expect(dock(page)).toHaveCount(0)
  await expect(page.locator('.cbar .panel')).toHaveCount(0)
  expect(page.errors).toEqual([])
})

test('F-CT-05 한 번 누르기는 그대로: 바로 이동(기다리지 않음), 목록은 열지 않음 — 두 번 누르기는 한 번만 이동', async ({ pageAs, db }) => {
  const page = await pageAs('ct-user')
  await seed(db, page.user)
  // inside a conversation, once: the whole chat (as before), nothing else
  await chat(page, '/chat/c/rt-ct-trip')
  await expect(page.locator('.cbar.inside .cur b')).toHaveText('부산 출장 숙소')
  await chatTab(page).click()
  await expect(page).toHaveURL(/\/chat$/)
  await page.waitForTimeout(600)
  await expect(list(page)).toHaveCount(0)
  await expect(dock(page)).toBeVisible()
  // from 프로젝트, once: the chat at once — the route changes well before a double click's time would pass
  await page.goto('/projects')
  await expect(page.locator('.plist')).toBeVisible()
  const ms = await page.evaluate(async () => {
    const b = document.querySelector('.top .seg button[data-tab="chat"]')
    const t0 = performance.now()
    b.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))
    while (location.pathname !== '/chat' && performance.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 5))
    return performance.now() - t0
  })
  expect(ms).toBeLessThan(250)
  await expect(page.locator('.composer textarea').first()).toBeVisible()
  await page.waitForTimeout(600)
  await expect(list(page)).toHaveCount(0)
  // from 프로젝트, twice: one step in the history (the second click does not navigate again), and the list
  await page.goto('/projects')
  await expect(page.locator('.plist')).toBeVisible()
  const before = await page.evaluate(() => history.length)
  await chatTab(page).dblclick()
  await expect(page).toHaveURL(/\/chat$/)
  await expect(list(page)).toBeVisible()
  expect(await page.evaluate(() => history.length)).toBe(before + 1)
  // a click on another tab is untouched: the list waits in 채팅 (hidden there), back with one click on 채팅
  await page.locator('.top .seg button[data-tab="project"]').click()
  await expect(page).toHaveURL(/\/projects$/)
  await expect(list(page)).toHaveCount(0)
  await page.waitForTimeout(500)
  await chatTab(page).click()
  await expect(list(page)).toBeVisible()
  expect(page.errors).toEqual([])
})

test('F-CT-06 새로 고쳐도 열린 채 · 닫힌 채(이 브라우저에 기억)', async ({ pageAs, db }) => {
  const page = await pageAs('ct-user')
  await seed(db, page.user)
  await chat(page, '/chat/c/rt-ct-yt')
  await chatTab(page).dblclick()
  // (the first click of the two went to the whole chat; pick the conversation again)
  await rows(page).filter({ hasText: '유튜브 채널 분석' }).click()
  await expect(page).toHaveURL(/\/chat\/c\/rt-ct-yt$/)
  expect(await stored(page)).toBe('1')
  await page.reload()
  await expect(list(page)).toBeVisible({ timeout: 30_000 })
  await expect(dock(page)).toHaveCount(0)
  await expect(rows(page).filter({ hasText: '유튜브 채널 분석' })).toHaveClass(/\bon\b/)
  await expect(page.getByText(ANSWER.yt)).toBeVisible()
  await page.getByTestId('thread-list-close').click()
  await page.reload()
  await expect(page.locator('.composer textarea').first()).toBeVisible({ timeout: 30_000 })
  await expect(dock(page)).toBeVisible()
  await expect(list(page)).toHaveCount(0)
  // storage refused (a private window): the page works, the list just is not remembered
  const blocked = await pageAs('ct-user')
  await blocked.context().addInitScript(() => {
    const deny = () => { throw new DOMException('denied', 'SecurityError') }
    const real = Storage.prototype.getItem
    Storage.prototype.getItem = function (k) { return k === 'pgl-chat-thread-list' ? deny() : real.call(this, k) }
    Storage.prototype.setItem = new Proxy(Storage.prototype.setItem, { apply: (f, self, args) => (args[0] === 'pgl-chat-thread-list' ? deny() : Reflect.apply(f, self, args)) })
  })
  await chat(blocked)
  await chatTab(blocked).dblclick()
  await expect(list(blocked)).toBeVisible()
  expect(blocked.errors).toEqual([])
  expect(page.errors).toEqual([])
})

test('F-CT-07 휴대폰 390px: 「채팅」 두 번 탭이면 전체 화면 시트, 고르면 시트가 닫히고 그 대화, 옆으로 밀리지 않음', async ({ pageAs, db }) => {
  const page = await pageAs('ct-phone', { viewport: PHONE, dpr: 2, touch: true })
  await seed(db, page.user)
  await page.goto('/chat')
  // a phone starts on Home (its own tab)
  await expect(page.locator('aside.dock.mobile')).toBeVisible({ timeout: 30_000 })
  const tab = await chatTab(page).boundingBox()
  const tap = () => page.touchscreen.tap(tab.x + tab.width / 2, tab.y + tab.height / 2)
  await tap()
  await page.waitForTimeout(120)
  await tap()
  await expect(list(page)).toBeVisible()
  await expect(list(page)).toHaveClass(/\bmobile\b/)
  const box = await list(page).boundingBox()
  expect(box.x).toBe(0)
  expect(box.width).toBe(PHONE.width)
  // the chat is under the sheet (not shown), Home too, and nothing slides sideways
  await expect(page.locator('.composer')).toHaveCount(0)
  await expect(page.locator('aside.dock')).toHaveCount(0)
  await expect(page.locator('.top .seg button.on')).toHaveText('채팅')
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(PHONE.width)
  expect(await list(page).evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
  for (const r of await rows(page).all()) {
    const b = await r.boundingBox()
    expect(b.x).toBeGreaterThanOrEqual(0)
    expect(b.x + b.width).toBeLessThanOrEqual(PHONE.width)
  }
  await shot(page, 'f-ct-07a-phone-sheet.png')
  // choosing closes the sheet and shows that conversation
  await rows(page).filter({ hasText: '견적서 검토' }).tap()
  await expect(list(page)).toHaveCount(0)
  await expect(page).toHaveURL(/\/chat\/c\/rt-ct-quote$/)
  await expect(page.getByText(ANSWER.quote)).toBeVisible()
  await expect(page.getByText(ANSWER.trip)).toHaveCount(0)
  await expect(page.locator('.cbar.inside .cur b')).toHaveText('견적서 검토')
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(PHONE.width)
  await shot(page, 'f-ct-07b-phone-picked.png')
  // twice again opens it, twice once more closes it (the first tap of the two already showed the chat)
  await page.waitForTimeout(500)
  await tap(); await page.waitForTimeout(120); await tap()
  await expect(list(page)).toBeVisible()
  await expect(page.getByTestId('thread-all')).toHaveClass(/\bon\b/)
  await page.waitForTimeout(600)
  await tap(); await page.waitForTimeout(120); await tap()
  await expect(list(page)).toHaveCount(0)
  await expect(page.locator('.composer textarea').first()).toBeVisible()
  // once on 채팅 with the sheet open shows the chat; 홈 puts it away for Home
  await page.waitForTimeout(600)
  await tap(); await page.waitForTimeout(120); await tap()
  await expect(list(page)).toBeVisible()
  await page.waitForTimeout(600)
  await tap()
  await expect(list(page)).toHaveCount(0)
  await expect(page.locator('.composer textarea').first()).toBeVisible()
  await page.waitForTimeout(600)
  await tap(); await page.waitForTimeout(120); await tap()
  await expect(list(page)).toBeVisible()
  await page.locator('.top .seg button[data-tab="home"]').tap()
  await expect(page.locator('aside.dock.mobile')).toBeVisible()
  await expect(list(page)).toHaveCount(0)
  // the ✕ on the sheet
  await page.waitForTimeout(600)
  await tap(); await page.waitForTimeout(120); await tap()
  await expect(list(page)).toBeVisible()
  await page.getByTestId('thread-list-close').tap()
  await expect(list(page)).toHaveCount(0)
  expect(page.errors).toEqual([])
})

test('F-CT-08 밤 테마: 목록 · 고른 행 · 찾기 칸이 읽힘(넓은 화면 · 휴대폰)', async ({ pageAs, db }) => {
  const page = await pageAs('ct-user')
  await page.context().addInitScript(() => { try { localStorage.setItem('pgpt-pro-theme', 'dark') } catch { /* ignore */ } })
  await seed(db, page.user)
  await chat(page, '/chat/c/rt-ct-trip')
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark')
  await chatTab(page).dblclick()
  await rows(page).filter({ hasText: '부산 출장 숙소' }).click()
  await expect(rows(page).filter({ hasText: '부산 출장 숙소' })).toHaveClass(/\bon\b/)
  // the chosen row's title in the dark theme's text colour, the others dimmer
  // (after its colour has eased in — .item's 0.3 s transition)
  await expect.poll(() => page.locator('.tlist .item.on .name').evaluate((el) => getComputedStyle(el).color)).toBe('rgb(245, 245, 247)')
  expect(await rows(page).nth(1).locator('.name').evaluate((el) => getComputedStyle(el).color)).toMatch(/^rgba\(245, 245, 247, 0\.5\)$/)
  await page.getByTestId('thread-search').fill('숙소')
  await shot(page, 'f-ct-08a-dark.png')
  const phone = await pageAs('ct-phone', { viewport: PHONE, dpr: 2, touch: true })
  await phone.context().addInitScript(() => { try { localStorage.setItem('pgpt-pro-theme', 'dark'); localStorage.setItem('pgl-chat-thread-list', '1') } catch { /* ignore */ } })
  await seed(db, phone.user)
  // (remembered open: a phone starts on the sheet)
  await phone.goto('/chat')
  await expect(list(phone)).toBeVisible({ timeout: 30_000 })
  await expect(list(phone)).toHaveClass(/\bmobile\b/)
  await shot(phone, 'f-ct-08b-dark-phone.png')
  expect(page.errors).toEqual([])
  expect(phone.errors).toEqual([])
})

test('F-CT-09 새 턴이 오면(실시간 이벤트) 열린 목록이 따라온다 — 새 대화가 맨 위, 라우터가 쓴 요약은 곧이어', async ({ pageAs, db }) => {
  const page = await pageAs('ct-user')
  const th = await seed(db, page.user)
  await chat(page)
  await chatTab(page).dblclick()
  await expect(rows(page)).toHaveCount(4)
  // what the server sends when another device asks something new and the router opens a conversation for it
  const now = new Date().toISOString()
  const user = { id: crypto.randomUUID(), thread_id: th, role: 'user', kind: 'text', content: { text: '다음 달 워크숍 장소 알아봐 줘' }, created_at: now }
  const agent = { id: crypto.randomUUID(), thread_id: th, role: 'agent', kind: 'text', content: { text: '워크숍 장소 후보 세 곳이에요.', context: conv('rt-ct-new', '워크숍 장소') }, created_at: now }
  await db.q(`insert into context_threads(tenant_id,user_id,conversation_id,title,summary,gist,turns,updated_at) values ($1,$2,'rt-ct-new','워크숍 장소',$3,'장소 조사',1,now())`,
    [db.tenant, page.user.id, '최근 요청: 다음 달 워크숍 장소 알아봐 줘\n최근 답: 후보 세 곳이에요.'])
  const refetched = page.waitForRequest((r) => r.url().includes('/api/conversations') && r.method() === 'GET', { timeout: 10_000 })
  await page.evaluate(([u, a]) => { const app = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('app'); app.onEvent('message', u); app.onEvent('message', a) }, [user, agent])
  await expect(rows(page)).toHaveCount(5)
  await expect(rows(page).first().locator('.name')).toHaveText('워크숍 장소')
  await expect(rows(page).first().locator('.count')).toHaveText('2')
  await refetched
  await expect(rows(page).first().locator('.line')).toHaveText('장소 조사 · 다음 달 워크숍 장소 알아봐 줘')
  expect(page.errors).toEqual([])
})

test('F-CT-10 대화가 없으면 목록은 안내 한 줄과 「전체 대화」만', async ({ pageAs, db }) => {
  const page = await pageAs('ct-empty')
  const th = await db.clearMain(page.user.id)
  await db.addMessages(th, [{ role: 'user', kind: 'text', content: { text: '안녕' } }, { role: 'agent', kind: 'text', content: { text: '안녕하세요.' } }])
  await chat(page)
  await chatTab(page).dblclick()
  await expect(list(page)).toBeVisible()
  await expect(rows(page)).toHaveCount(0)
  await expect(page.getByTestId('thread-search')).toHaveCount(0)
  await expect(page.getByTestId('thread-empty')).toContainText('아직 나뉜 대화가 없어요.')
  await expect(page.getByTestId('thread-all').locator('.count')).toHaveText('2')
  expect(page.errors).toEqual([])
})

// ---- F-CT-11 · 12: a scheduled run and a brief arrive while the person is inside conversation A ----
// The fake deepagents answers the run; the fake model reads the demo mailbox as one card and a brief. The run goes through the real
// path (POST /missions/:id/run → lib/missions.js → delegate), the brief through POST /mail/poll (lib/mail.js pollUser).
test.describe('예약 작업과 브리프는 자기 대화에', () => {
  const AGENT_PORT = Number(process.env.RT_FAKE_AGENT_PORT || 8986)
  const LLM_PORT = Number(process.env.RT_FAKE_LLM_PORT || 8987)
  const RUN = 'KOSPI 5일 +1.2%, ASTS 5일 -6.1% — ASTS 가 5% 넘게 내렸어요 · 출처: 네이버 증권'
  const BRIEF = '박용주님이 uengine.org Tailscale 팀에 가입하도록 초대했어요. 나머지는 안내 메일이에요.'
  const TASK = '주식 5일 누적 5% 급등락 감시(회귀)'
  const A = { said: '보고서 표 머리글 굵게 해 줘', answer: '머리글을 굵게 했어요.' }
  const B = { said: '부산 숙소 세 곳 비교해 줘', answer: '숙소 세 곳을 표로 비교했어요.' }
  const fake = { agent: [], llm: 0 }
  const servers = []
  const listen = (handler, port) => new Promise((ok, no) => { const srv = http.createServer(handler); srv.once('error', no).listen(port, '127.0.0.1', () => { servers.push(srv); ok() }) })
  const read = (req) => new Promise((ok) => { let raw = ''; req.on('data', (c) => { raw += c }); req.on('end', () => { try { ok(JSON.parse(raw)) } catch { ok({}) } }) })
  test.beforeAll(async () => {
    await listen(async (req, res) => {
      const body = await read(req)
      if (!req.url.endsWith('/chat/stream')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('[]') }
      fake.agent.push(body)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      if (body.conversation_id) res.write(`event: metadata\ndata: ${JSON.stringify({ conversation_id: body.conversation_id })}\n\n`)
      res.end(`data: ${JSON.stringify({ type: 'token', content: RUN })}\n\n`)
    }, AGENT_PORT)
    await listen(async (req, res) => {
      const b = await read(req)
      fake.llm += 1
      const text = (b.messages || []).map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n')
      // the mailbox's triage: one card for the seminar mail and the brief; anything else answers nothing
      const content = b.response_format && text.includes('demo-004')
        ? JSON.stringify({ actions: [{ mail_id: 'demo-004', verb: 'Review', kind: 'task', text: '박용주(uengine.org)의 Tailscale 팀 가입 초대 확인', icon_domain: '', due: null, prompt: '초대를 확인해 줘' }], brief: BRIEF, drafts: [] })
        : '{}'
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] }))
    }, LLM_PORT)
  })
  test.afterAll(async () => { for (const s of servers) await new Promise((ok) => s.close(ok)) })

  // conversation A (selected) and B, as the router left them; a prompt task of this person's; the demo mailbox, read afresh
  async function seedOwn(db, u) {
    const th = await db.clearMain(u.id)
    await db.addMessages(th, [
      { role: 'user', kind: 'text', content: { text: B.said } },
      { role: 'agent', kind: 'text', content: { text: B.answer, context: conv('rt-ct-own-b', '부산 출장 숙소') } },
      { role: 'user', kind: 'text', content: { text: A.said } },
      { role: 'agent', kind: 'text', content: { text: A.answer, context: conv('rt-ct-own-a', '보고서 표 정리') } },
    ])
    await db.q(`update pro_threads set conversation_id='rt-ct-own-a' where id=$1`, [th])
    for (const [id, title, min] of [['rt-ct-own-a', '보고서 표 정리', 3], ['rt-ct-own-b', '부산 출장 숙소', 60]]) {
      await db.q(`insert into context_threads(tenant_id,user_id,conversation_id,title,summary,gist,turns,updated_at) values ($1,$2,$3,$4,'','',1, now() - make_interval(mins => $5))`, [db.tenant, u.id, id, title, min])
    }
    await db.q('delete from pro_schedules where user_id=$1', [u.id])
    const [s] = await db.q(`insert into pro_schedules(user_id, name, cron, prompt, notify, tenant_id) values ($1,$2,'0 0 31 2 *','KOSPI와 ASTS 의 5일 누적 등락률이 5% 넘게 움직이면 알려 줘','always',$3) returning id`, [u.id, TASK, db.tenant])
    await db.q(`update pro_profile set email=$2 where user_id=$1`, [u.id, u.email])
    await db.q(`insert into pro_mail_accounts(user_id, provider, address) values ($1,'demo',$2) on conflict (user_id) do update set provider='demo'`, [u.id, u.email])
    await db.q('delete from pro_mail_seen where user_id=$1', [u.id])
    return { th, schedule: s.id }
  }
  const unseed = async (db, u) => {
    await db.q('delete from pro_schedules where user_id=$1', [u.id])
    for (const t of ['pro_mail_accounts', 'pro_mail_seen', 'pro_actions']) await db.q(`delete from ${t} where user_id=$1`, [u.id]).catch(() => {})
  }
  const bubble = (page, text) => page.locator('.row').filter({ hasText: text })
  // the run and the brief, the way they arrive: through the server, live
  // the conversation a tagged message of the chat went to (the server's ids are keyed — lib/ownConversations.js — so they are read back)
  const convOfStored = async (db, th, where, params = []) => (await db.q(`select content->'context'->>'conversationId' as id from pro_messages where thread_id=$1 and ${where} order by created_at limit 1`, [th, ...params]))[0]?.id
  async function arrive(page, s, db) {
    const n0 = fake.agent.length
    const run = await page.user.post(`/missions/${s.schedule}/run`)
    expect(run.status, JSON.stringify(run.body)).toBe(200)
    await expect.poll(() => fake.agent.slice(n0).filter((b) => String(b.conversation_id || '').startsWith('sched-')).length, { timeout: 30_000 }).toBeGreaterThan(0)
    await expect.poll(() => convOfStored(db, s.th, `content->>'scheduleId' = $2`, [s.schedule]), { timeout: 30_000 }).toBeTruthy()
    s.sched = await convOfStored(db, s.th, `content->>'scheduleId' = $2`, [s.schedule])
    const poll = await page.user.post('/mail/poll')
    expect(poll.status, JSON.stringify(poll.body)).toBe(200)
    s.brief = await convOfStored(db, s.th, `content->'context'->>'kind' = 'brief'`)
    // the ids are the server's own, keyed: neither the task's nor the person's id is in them (review 11-25 #1)
    expect(s.sched).toMatch(/^sched-[0-9a-f]{24}$/)
    expect(s.brief).toMatch(/^brief-[0-9a-f]{24}$/)
  }

  test('F-CT-11 대화 A 를 보는 중 예약 실행과 브리프가 도착: A 에는 없고, 목록에 「⏰ 작업 이름」 · 「브리프」, 열면 그 메시지, 「전체 대화」는 시간 순', async ({ pageAs, db, cleanup }) => {
    const page = await pageAs('ct-own')
    await page.context().addInitScript(() => { try { localStorage.setItem('pgpt-pro-theme', 'light') } catch { /* ignore */ } })
    const s = await seedOwn(db, page.user)
    cleanup(() => unseed(db, page.user))
    await chat(page, '/chat?hour=13')
    await chatTab(page).dblclick()
    await expect(rows(page)).toHaveCount(2)
    await rows(page).filter({ hasText: '보고서 표 정리' }).click()
    await expect(rows(page).filter({ hasText: '보고서 표 정리' })).toHaveClass(/\bon\b/)
    await arrive(page, s, db)
    // the list follows: the brief (newest), then the task, then A and B — each of its own with its icon
    await expect(rows(page)).toHaveCount(4, { timeout: 30_000 })
    await expect(rows(page).locator('.name')).toHaveText(['브리프', TASK, '보고서 표 정리', '부산 출장 숙소'], { timeout: 15_000 })
    await expect(rows(page).nth(0).getByTestId('thread-kind')).toHaveAttribute('data-kind', 'brief')
    await expect(rows(page).nth(1).getByTestId('thread-kind')).toHaveAttribute('data-kind', 'schedule')
    await expect(rows(page).nth(1).getByTestId('thread-kind')).toHaveAttribute('aria-label', '예약 작업')
    await expect(rows(page).nth(2).getByTestId('thread-kind')).toHaveCount(0)
    await expect(rows(page).nth(1).locator('.count')).toHaveText('2')
    // conversation A still holds only its own two messages: neither the run nor the brief
    await expect(page).toHaveURL(/\/chat\/c\/rt-ct-own-a/)
    await expect(bubble(page, A.answer)).toBeVisible()
    await expect(bubble(page, RUN)).toHaveCount(0)
    await expect(bubble(page, BRIEF)).toHaveCount(0)
    await expect(rows(page).filter({ hasText: '보고서 표 정리' }).locator('.count')).toHaveText('2')
    await shot(page, 'f-ct-11-a-after-arrivals.png')
    // the task's conversation: its divider (tappable to manage it) and its result
    await rows(page).filter({ hasText: TASK }).click()
    await expect(page).toHaveURL(new RegExp(`/chat/c/${s.sched}$`))
    await expect(page.locator('.row button.sched')).toContainText(`${TASK} 관리`)
    await expect(bubble(page, RUN)).toBeVisible()
    await expect(bubble(page, A.answer)).toHaveCount(0)
    await expect(bubble(page, BRIEF)).toHaveCount(0)
    await shot(page, 'f-ct-11-schedule.png')
    // the briefs: the brief and its mail's chip
    await rows(page).filter({ hasText: '브리프' }).click()
    await expect(page).toHaveURL(new RegExp(`/chat/c/${s.brief}$`))
    await expect(bubble(page, BRIEF)).toBeVisible()
    await expect(page.locator('[data-test="mail-chip"]')).toContainText('Tailscale 팀 가입 초대 확인')
    await expect(bubble(page, RUN)).toHaveCount(0)
    await expect(bubble(page, A.answer)).toHaveCount(0)
    await shot(page, 'f-ct-11-brief.png')
    // 「전체 대화」: everything, in the order it came
    await page.getByTestId('thread-all').click()
    await expect(page).toHaveURL(/\/chat$/)
    await expect(bubble(page, BRIEF)).toBeVisible()
    const texts = await page.locator('.row').allTextContents()
    const at = (t) => texts.findIndex((x) => x.includes(t))
    const order = [B.answer, A.said, A.answer, RUN, BRIEF].map(at)
    expect(order.every((i) => i >= 0), JSON.stringify(order)).toBe(true)
    expect([...order].sort((x, y) => x - y)).toEqual(order)
    await shot(page, 'f-ct-11-all.png')
    // the chat still stands in A on the server: the run and the brief never moved it
    expect((await db.q('select conversation_id from pro_threads where id=$1', [s.th]))[0].conversation_id).toBe('rt-ct-own-a')
    expect(page.errors).toEqual([])
  })

  test('F-CT-12 휴대폰 390px: 시트 목록에 시계 · 해 아이콘, 작업 대화를 고르면 그 결과만', async ({ pageAs, db, cleanup }) => {
    const page = await pageAs('ct-own', { viewport: PHONE, touch: true })
    await page.context().addInitScript(() => { try { localStorage.setItem('pgpt-pro-theme', 'light') } catch { /* ignore */ } })
    const s = await seedOwn(db, page.user)
    cleanup(() => unseed(db, page.user))
    await chat(page, '/chat/c/rt-ct-own-a?hour=13')
    await arrive(page, s, db)
    await expect.poll(async () => (await db.q(`select count(*)::int as n from pro_messages where thread_id=$1 and content->'context'->>'conversationId' = $2`, [s.th, s.brief]))[0].n, { timeout: 30_000 }).toBe(2)
    await expect(bubble(page, RUN)).toHaveCount(0)
    await expect(bubble(page, BRIEF)).toHaveCount(0)
    await chatTab(page).dblclick()
    await expect(list(page)).toHaveClass(/\bmobile\b/)
    await expect(rows(page).locator('.name')).toHaveText(['브리프', TASK, '보고서 표 정리', '부산 출장 숙소'], { timeout: 15_000 })
    await expect(rows(page).getByTestId('thread-kind')).toHaveCount(2)
    // nothing runs off the side of the phone
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await shot(page, 'f-ct-12-phone-list.png')
    await rows(page).filter({ hasText: TASK }).click()
    await expect(list(page)).toHaveCount(0)
    await expect(bubble(page, RUN)).toBeVisible()
    await expect(bubble(page, A.answer)).toHaveCount(0)
    await shot(page, 'f-ct-12-phone-schedule.png')
    expect(page.errors).toEqual([])
  })

  test('F-CT-13 답을 쓰는 중에 예약 실행 결과가 도착해도 쓰던 답(초안)은 지워지지 않는다 — 사람의 답이 오면 그때 (검토 11-25 #6)', async ({ pageAs, db, cleanup }) => {
    const page = await pageAs('ct-own')
    const s = await seedOwn(db, page.user)
    cleanup(() => unseed(db, page.user))
    await chat(page, '/chat')
    // the person's answer is being written (what the stream fills — app.drafts)
    await page.evaluate((th) => { document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('app').drafts[th] = '머리글을 굵게 바꾸는 중' }, s.th)
    await arrive(page, s, db)
    // the run's result (filed aside) and the brief arrived live …
    await expect.poll(() => page.evaluate((th) => (document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('app').messages[th] || []).filter((m) => m.content?.context?.action === 'aside' && m.kind === 'text').length, s.th), { timeout: 30_000 }).toBe(2)
    // … and the draft is still there
    expect(await page.evaluate((th) => document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('app').drafts[th], s.th)).toBe('머리글을 굵게 바꾸는 중')
    // the person's own answer ends it
    await page.evaluate((th) => {
      const app = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('app')
      app.onEvent('message', { id: crypto.randomUUID(), thread_id: th, role: 'agent', kind: 'text', content: { text: '머리글을 굵게 했어요.', context: { conversationId: 'rt-ct-own-a', title: '보고서 표 정리', action: 'continue' } }, created_at: new Date().toISOString() })
    }, s.th)
    expect(await page.evaluate((th) => document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('app').drafts[th], s.th)).toBeNull()
    expect(page.errors).toEqual([])
  })
})
