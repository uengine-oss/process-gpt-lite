// 걸러 본 대화 — 맨 아래에서 열림 · 메시지마다의 대화 표시 숨김(2026-11-28 07:24 휴대폰 녹화 — 스펙 openspec/specs/chat-thread-list
// 「걸러 본 대화는 맨 아래에서 열린다」 · 「걸러 본 대화에는 메시지마다의 대화 표시가 없다」).
//  · 「필터링으로 들어온 상태에서는 … 맨 위로 스크롤을 하려고 하는데 이러면 안 되고 맨 아래로 다시 해줘야 되고」: 대화 막대는 목록 맨 위에
//    있어서, 그것을 누르는 사람은 늘 목록 맨 위에 있다. 걸러 들어가도 · 「‹ 전체 대화」로 돌아와도 · 다른 대화로 바꿔도 그 위치(맨 위)가 남았고,
//    전체 대화로 돌아오면 긴 채팅 전체를 부드럽게 훑어 내려가며 잠깐 빈 칸이 보였다. 이제는 그리는 순간 맨 아래(최신)다.
//  · 「특정 여기 들어왔으면 … 이 표시가 필요 없지」: 걸러 본 대화 안에서는 답마다 붙던 「↳ 대화 이름 · logprob 1.00」 칩을 그리지 않는다
//    (머리의 막대가 이미 어느 대화인지 말한다). 전체 대화에서는 그대로 보인다.
// 모델 없이 고정 데이터(지어낸 대화 두 개, 메시지 많이)로. 화면 사진은 openspec/specs/chat-thread-list/e2e/results/f-tv-*.png.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../../lib/fixtures.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const SHOTS = path.resolve(here, '../../../openspec/specs/chat-thread-list/e2e/results')
const PHONE = { width: 390, height: 844 }
test.use({ channel: 'chromium' })
test.describe.configure({ mode: 'serial' })

// two conversations the router told apart, many turns each, taking turns in the main chat — the whole chat is many screens tall
const A = { id: 'rt-tv-trip', title: '부산 출장 준비' }
const B = { id: 'rt-tv-quote', title: '가나정밀 견적 검토' }
const TURNS = 14
const ask = (c, i) => (c === A ? `출장 ${i}번째 질문: 해운대 근처 숙소와 이동 편을 다시 정리해 줘` : `견적 ${i}번째 질문: 가나정밀 견적서의 단가와 납기를 다시 봐 줘`)
const answer = (c, i) => (c === A
  ? `출장 ${i}번째 답이에요. 숙소는 조식이 포함된 곳으로 두 곳을 골랐고, 기차는 오전 8시 출발 편이 가장 알맞아요. 회의 장소까지는 택시로 15분 걸려요.`
  : `견적 ${i}번째 답이에요. 단가 세 곳이 지난 분기보다 높고, 납기는 2주 늦어요. 표로 비교해 두었으니 협상 전에 한 번 보세요.`)
const LAST = { A: answer(A, TURNS), B: answer(B, TURNS) } // B's is the whole chat's last message
const ctx = (c, i) => ({ conversationId: c.id, action: i === 1 ? 'new' : 'continue', title: c.title, strategy: i % 2 ? 'logprob' : 'pinned', confidence: 1 })
async function seed(db, u) {
  const th = await db.clearMain(u.id)
  const msgs = []
  for (let i = 1; i <= TURNS; i++) {
    for (const c of [A, B]) {
      msgs.push({ role: 'user', kind: 'text', content: { text: ask(c, i) } })
      msgs.push({ role: 'agent', kind: 'text', content: { text: answer(c, i), context: ctx(c, i) } })
    }
  }
  await db.addMessages(th, msgs)
  for (const c of [A, B]) await db.addConversation(u.id, c.id, c.title, { summary: `최근 요청: ${ask(c, TURNS)}` })
  return th
}

const chatTab = (page) => page.locator('.top .seg button[data-tab="chat"]')
const scroller = (page) => page.locator('.col .scroll.msgs')
const chips = (page) => page.locator('.col .row .ctx')
const settled = (page) => page.evaluate(() => Promise.all(document.getAnimations()
  .filter((a) => a.effect?.getComputedTiming?.().iterations !== Infinity).map((a) => a.finished.catch(() => {}))))
async function shot(page, name) {
  await settled(page)
  await page.screenshot({ path: path.join(SHOTS, name) })
}
// how far the list is from its bottom (0: the newest message is at the end of the screen)
const gap = (page) => scroller(page).evaluate((el) => Math.round(el.scrollHeight - el.scrollTop - el.clientHeight))
// the message with this text is on screen: under the top bar, above the composer
async function onScreen(page, text) {
  return page.evaluate((t) => {
    const b = [...document.querySelectorAll('.col .row .bubble')].find((x) => x.textContent.includes(t))
    const foot = document.querySelector('.col .foot')?.getBoundingClientRect()
    if (!b || !foot) return false
    const r = b.getBoundingClientRect()
    return r.bottom <= foot.top + 1 && r.top >= 60
  }, text)
}
// the person at the top of the list (where the conversation bar is) — as a finger would leave it: no longer kept at the bottom
async function toTop(page) {
  await scroller(page).evaluate((el) => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')) })
  await expect.poll(() => scroller(page).evaluate((el) => el.scrollTop)).toBe(0)
  await page.waitForTimeout(150)
}
// every frame from a press until the view has changed and a little after: how far from the bottom each one was drawn, and how many
// messages it had (and which conversation) — the frames after the change must all be at the bottom (no run down the whole chat, no top shown first). Read just
// after the frame is painted (a task after its animation frame): what grew during the frame's layout has been kept at the bottom by
// then (ChatColumn's ResizeObserver runs between layout and paint), as the person sees it
async function watchFrames(page) {
  await page.evaluate(() => {
    const el = document.querySelector('.col .scroll.msgs')
    window.__tvFrames = []
    const t0 = performance.now()
    const step = () => setTimeout(() => {
      const s = document.querySelector('.col .scroll.msgs') || el
      const view = `${document.querySelector('[data-testid="cbar-current"]')?.dataset.conv || 'all'}:${s.querySelectorAll('.row.r-agent, .row.r-user').length}`
      window.__tvFrames.push({ t: Math.round(performance.now() - t0), view, gap: Math.round(s.scrollHeight - s.scrollTop - s.clientHeight) })
      if (performance.now() - t0 < 1600) requestAnimationFrame(step)
    }, 0)
    requestAnimationFrame(step)
  })
}
async function framesAfterChange(page) {
  await page.waitForFunction(() => (window.__tvFrames?.at(-1)?.t || 0) >= 1600)
  const f = await page.evaluate(() => window.__tvFrames)
  const i = f.findIndex((x) => x.view !== f[0].view)
  return i < 0 ? [] : f.slice(i)
}
async function expectAtBottomFromFirstFrame(page) {
  const after = await framesAfterChange(page)
  expect(after.length, 'the view changed').toBeGreaterThan(0)
  const far = after.filter((x) => x.gap > 40)
  expect(far, `frames drawn away from the bottom: ${JSON.stringify(far.slice(0, 5))}`).toEqual([])
}

async function phoneRun(page, db, theme) {
  await page.context().addInitScript((t) => { try { localStorage.setItem('pgpt-pro-theme', t) } catch { /* ignore */ } }, theme)
  await seed(db, page.user)
  await page.goto(theme === 'light' ? '/chat?hour=13' : '/chat')
  // a phone starts on Home: one tap on 채팅 shows the chat
  await expect(page.locator('aside.dock.mobile')).toBeVisible({ timeout: 30_000 })
  await chatTab(page).tap()
  await expect(page.locator('.composer textarea').first()).toBeVisible()
  await expect(page.getByText(LAST.B)).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme)
  // the whole chat: each answer says which conversation it went to
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(2)
  expect(await chips(page).count()).toBe(TURNS * 2)

  // into one conversation from the bar at the top of the list: its newest message, at once
  await toTop(page)
  await page.getByTestId('cbar-pill').tap()
  await watchFrames(page)
  await page.locator(`[data-testid="cbar-row"][data-conv="${A.id}"]`).tap()
  await expect(page).toHaveURL(new RegExp(`/chat/c/${A.id}$`))
  await expectAtBottomFromFirstFrame(page)
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(2)
  expect(await onScreen(page, LAST.A)).toBe(true)
  // inside it: no per-message label — the bar over the list says which conversation this is
  await expect(page.locator('.cbar.inside .cur b')).toHaveText(A.title)
  await expect(chips(page)).toHaveCount(0)
  await expect(page.getByText(LAST.B)).toHaveCount(0)
  await shot(page, `f-tv-01-${theme}-phone-filtered.png`)

  // scrolled up by the person: left where it is (only opening a view goes to the bottom)
  await scroller(page).evaluate((el) => { el.scrollTop = 300; el.dispatchEvent(new Event('scroll')) })
  await page.waitForTimeout(1200)
  expect(Math.abs(await scroller(page).evaluate((el) => el.scrollTop) - 300)).toBeLessThanOrEqual(2)

  // to another conversation from the bar: its newest message
  await toTop(page)
  await page.getByTestId('cbar-other').tap()
  await watchFrames(page)
  await page.locator(`[data-testid="cbar-row"][data-conv="${B.id}"]`).tap()
  await expect(page).toHaveURL(new RegExp(`/chat/c/${B.id}$`))
  await expectAtBottomFromFirstFrame(page)
  expect(await onScreen(page, LAST.B)).toBe(true)
  await expect(chips(page)).toHaveCount(0)

  // back to the whole chat from the top: the newest message of all, and no run down the chat
  await toTop(page)
  await watchFrames(page)
  await page.getByTestId('cbar-all').tap()
  await expect(page).toHaveURL(/\/chat$/)
  await expectAtBottomFromFirstFrame(page)
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(2)
  expect(await onScreen(page, LAST.B)).toBe(true)
  // the labels are back in the whole chat
  expect(await chips(page).count()).toBe(TURNS * 2)
  await expect(chips(page).last()).toContainText(B.title)
  await shot(page, `f-tv-01-${theme}-phone-all.png`)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(PHONE.width)
  expect(page.errors).toEqual([])
}

test('F-TV-01 휴대폰 390 밝음: 걸러 들어가면 · 다른 대화로 바꾸면 · 「전체 대화」로 돌아오면 처음 그리는 순간부터 맨 아래(최신), 걸러 본 대화에는 대화 표시 칩이 없고 전체 대화에는 있음, 위로 올려 둔 자리는 그대로', async ({ pageAs, db }) => {
  const page = await pageAs('tv-phone', { viewport: PHONE, dpr: 2, touch: true })
  await phoneRun(page, db, 'light')
})

test('F-TV-02 휴대폰 390 어둠: 같은 흐름(맨 아래 · 칩 숨김 · 전체 대화의 칩)', async ({ pageAs, db }) => {
  const page = await pageAs('tv-phone', { viewport: PHONE, dpr: 2, touch: true })
  await phoneRun(page, db, 'dark')
})

test('F-TV-03 넓은 화면 1280: 왼쪽 대화 목록으로 걸러 들어가도 · 「전체 대화」로 돌아와도 맨 아래, 주소로 연 대화도 맨 아래, 칩은 전체 대화에만', async ({ pageAs, db }) => {
  const page = await pageAs('tv-wide')
  await page.context().addInitScript(() => { try { localStorage.setItem('pgpt-pro-theme', 'light') } catch { /* ignore */ } })
  await seed(db, page.user)
  await page.goto('/chat?hour=13')
  await expect(page.locator('.composer textarea').first()).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText(LAST.B)).toBeVisible()
  // the list beside the chat (「채팅」 twice), the chat scrolled to its top first
  await chatTab(page).dblclick()
  await expect(page.getByTestId('thread-list')).toBeVisible()
  await toTop(page)
  await watchFrames(page)
  await page.getByTestId('thread-row').filter({ hasText: A.title }).click()
  await expect(page).toHaveURL(new RegExp(`/chat/c/${A.id}$`))
  await expectAtBottomFromFirstFrame(page)
  expect(await onScreen(page, LAST.A)).toBe(true)
  await expect(chips(page)).toHaveCount(0)
  await shot(page, 'f-tv-03-wide-filtered.png')
  // 「전체 대화」 in the list, from the top of the conversation
  await toTop(page)
  await watchFrames(page)
  await page.getByTestId('thread-all').click()
  await expect(page).toHaveURL(/\/chat$/)
  await expectAtBottomFromFirstFrame(page)
  expect(await onScreen(page, LAST.B)).toBe(true)
  expect(await chips(page).count()).toBe(TURNS * 2)
  await shot(page, 'f-tv-03-wide-all.png')
  // a conversation opened by its address (a new page): at the bottom too, no labels
  await page.goto(`/chat/c/${B.id}`)
  await expect(page.locator('.cbar.inside .cur b')).toHaveText(B.title)
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(2)
  expect(await onScreen(page, LAST.B)).toBe(true)
  await expect(chips(page)).toHaveCount(0)
  expect(page.errors).toEqual([])
})

test('F-TV-04 휴대폰 390 프로젝트의 주제 하나로 좁혀도 같음: 막대에서 고르면 맨 아래, 칩 없음 — 「전체」로 돌아오면 맨 아래, 칩 있음', async ({ pageAs, db, cleanup }) => {
  const page = await pageAs('tv-phone', { viewport: PHONE, dpr: 2, touch: true })
  await page.context().addInitScript(() => { try { localStorage.setItem('pgpt-pro-theme', 'light') } catch { /* ignore */ } })
  // a project of its own (made in the database — no agent turn), its answers filed under two sub-topics (content.conv), each with the
  // router's label (content.context) as the server leaves them (src/projectTopics.js)
  const [p] = await db.q(`insert into pro_threads(user_id,kind,title) values ($1,'project',$2) returning id`, [page.user.id, '가나정밀 납품 준비'])
  cleanup(async () => { await db.q('delete from pro_messages where thread_id=$1', [p.id]); await db.q('delete from pro_threads where id=$1', [p.id]) })
  const T = { a: { id: `rt-tv-topic-a-${p.id.slice(0, 8)}`, title: '납품 일정' }, b: { id: `rt-tv-topic-b-${p.id.slice(0, 8)}`, title: '검사 성적서' } }
  const msgs = []
  for (let i = 1; i <= TURNS; i++) {
    for (const t of [T.a, T.b]) {
      msgs.push({ role: 'user', kind: 'text', content: { text: `${t.title} ${i}번째 질문: 지난번 내용을 다시 정리해 줘`, conv: t.id } })
      msgs.push({ role: 'agent', kind: 'text', content: { text: `${t.title} ${i}번째 답이에요. 지난번 내용을 세 줄로 정리했고, 바뀐 곳은 굵게 표시했어요. 다음 회의 전에 한 번 확인해 주세요.`, conv: t.id, context: { conversationId: t.id, action: 'continue', title: t.title, strategy: 'logprob', confidence: 1 } } })
    }
  }
  await db.addMessages(p.id, msgs)
  const lastA = `${T.a.title} ${TURNS}번째 답이에요.`
  const lastB = `${T.b.title} ${TURNS}번째 답이에요.`
  await page.goto(`/projects/${p.id}?hour=13`)
  await expect(page.locator('.composer textarea').first()).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText(lastB)).toBeVisible()
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(2)
  expect(await chips(page).count()).toBe(TURNS * 2)
  // from the bar at the top of the project's chat: one sub-topic
  await toTop(page)
  await page.getByTestId('cbar-pill').tap()
  await watchFrames(page)
  await page.locator(`[data-testid="cbar-row"][data-conv="${T.a.id}"]`).tap()
  await expect(page).toHaveURL(new RegExp(`/projects/${p.id}/t/${T.a.id}$`))
  await expectAtBottomFromFirstFrame(page)
  expect(await onScreen(page, lastA)).toBe(true)
  await expect(chips(page)).toHaveCount(0)
  await shot(page, 'f-tv-04-phone-topic.png')
  // 「전체」: the whole project at its newest, the labels back
  await toTop(page)
  await watchFrames(page)
  await page.getByTestId('cbar-all').tap()
  await expect(page).toHaveURL(new RegExp(`/projects/${p.id}$`))
  await expectAtBottomFromFirstFrame(page)
  expect(await onScreen(page, lastB)).toBe(true)
  expect(await chips(page).count()).toBe(TURNS * 2)
  expect(page.errors).toEqual([])
})
