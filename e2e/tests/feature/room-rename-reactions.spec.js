// 대화방 이름 · 말풍선 반응(2026-11-26 사용자 휴대폰 화면, 「대화방 설정으로 대화방 명칭 바꿀 수 있게하고 다른 사람 말풍선에 좋아요 확인했음 사랑해 웃음
// 등을 붙힐 수 있게」 — 스펙 openspec/specs/messenger-dock 「단체방의 이름을 바꾼다」 · openspec/specs/room-reactions). 지어낸 사람: 정하윤 · 김서연 · 박도윤.
//   F-RX-01 1280px: 머리의 ⚙ → 대화방 설정 → 이름 저장 → 두 사람의 머리 · 목록에 그 이름(열어 둔 김서연의 화면은 새로 고침 없이), 시스템 줄, 읽지 않은 수 없음
//           → 「기본 이름으로」 → 사람들 이름으로 돌아옴
//   F-RX-02 1:1 대화의 ⚙ → 이름 칸 없이 「1:1 대화는 상대의 이름으로 보여요」
//   F-RX-03 1280px: 김서연의 말풍선 위에 마우스 → 반응 단추 → 👍 → 칩 「👍 1」(내 것) · 김서연 화면에 바로(내 것 아님) · 오른쪽 클릭 → ✅ ·
//           칩을 다시 누르면 꺼짐 · 김서연이 자기 말풍선의 칩에 마우스를 올리면 누가 했는지 · 내 말풍선에는 반응 단추 · 막대가 없다
//   F-RX-04 휴대폰 390px 밝은 · 밤: 말풍선 길게 누르기 → 막대가 화면 안 → ❤️ → 칩, 칩 길게 누르기 → 누가 했는지, 다른 사람 화면에 바로, 옆으로 넘치지 않음
//   F-RX-05 휴대폰 390px 밝은 · 밤: 머리의 ⚙ 가 화면 안 · 설정 창 · 이름 저장 → 머리에 그 이름
//   F-RX-06 영어 화면: 설정 · 막대 · 칩 · 시스템 줄이 영어로
//   F-RX-07 반응 테이블이 아직 없는 데이터베이스(운영 2026-11-26 「반응은 곧 쓸 수 있어요.라고 나오고 좋아요 붙힌게 유지되지 않는...」): 방이 그렇다고
//           알리면 반응 단추 · 막대의 반응이 없고 길게 누르면 「복사」만, 칩은 누를 수 없다 / 방은 있다고 했는데 서버가 503 이면 칩이 빠지고
//           그다음부터 반응을 내밀지 않는다. 막대 · 칩은 앱의 선 아이콘(색 이모지 아님)
// 자기 스택(lib/localStack.js — 회사 room-react-ui, RT_API_FROM · RT_WEB_FROM 부터 빈 포트, 기본 8966 · 5366)을 띄우고 지운다. 모델은 부르지 않는다.
//   cd e2e && npx playwright test --project=feature tests/feature/room-rename-reactions.spec.js
import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { startStack, REPO } from '../../lib/localStack.js'

test.describe.configure({ mode: 'serial' })
const SHOTS_NAME = path.join(REPO, 'openspec/specs/messenger-dock/e2e/results')
const SHOTS_RX = path.join(REPO, 'openspec/specs/room-reactions/e2e/results')
const DESK = { viewport: { width: 1280, height: 860 }, locale: 'ko-KR' }
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ko-KR' }
const NOWHERE = 'http://127.0.0.1:9'
const TENANT = 'room-react-ui'
let S, HY, SY, DY

test.beforeAll(async () => {
  test.setTimeout(240_000)
  for (const d of [SHOTS_NAME, SHOTS_RX]) fs.mkdirSync(d, { recursive: true })
  S = await startStack({ tenant: TENANT, apiFrom: Number(process.env.RT_API_FROM) || 8966, webFrom: Number(process.env.RT_WEB_FROM) || 5366,
    env: { PRO_DEEPAGENTS_URL: NOWHERE, PRO_COMPLETION_URL: NOWHERE, PRO_CONTEXT_ROUTER_URL: NOWHERE, PRO_JUDGE_URL: '' } })
  HY = await S.person(`pro-rt-${TENANT}-a@people-mail.test`, '정하윤')
  SY = await S.person(`pro-rt-${TENANT}-b@people-mail.test`, '김서연')
  DY = await S.person(`pro-rt-${TENANT}-c@people-mail.test`, '박도윤')
  for (const p of [HY, SY, DY]) await S.join(p)
  await cleanRooms()
})
async function cleanRooms() {
  for (const sql of ['delete from pro_chat_reactions where tenant_id=$1', 'delete from chats where tenant_id=$1', 'delete from pro_chat_reads where room_id in (select id from chat_rooms where tenant_id=$1)',
    `delete from notifications where tenant_id=$1 and type in ('team','chat')`, `delete from notifications where url like '/chats?id=%' and url in (select '/chats?id=' || id from chat_rooms where tenant_id=$1)`,
    'delete from chat_rooms where tenant_id=$1']) await S.q(sql, [TENANT]).catch(() => {})
}
test.afterAll(async () => { if (S) { await cleanRooms().catch(() => {}); await S.stop() } })

async function page(browser, who, opts, { theme = 'light', lang = 'ko' } = {}) {
  const ctx = await browser.newContext({ ...opts, baseURL: S.web })
  await ctx.addInitScript(([s, th, lg]) => {
    if (window.top !== window) return
    localStorage.setItem('pgpt-pro-session', s)
    localStorage.setItem('pgpt-pro-theme', th)
    localStorage.setItem('pgl-lang', lg)
    try { localStorage.removeItem('pgl-messenger-dock') } catch { /* none */ }
  }, [JSON.stringify(who.session), theme, lang])
  const p = await ctx.newPage()
  p.errors = []
  p.on('pageerror', (e) => p.errors.push(String(e?.message || e)))
  return p
}
const shot = async (p, dir, name) => { await p.waitForTimeout(450); await p.screenshot({ path: path.join(dir, `${name}.png`) }) }
const noOverflow = (p) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
async function openRoom(p, title, { phone = false } = {}) {
  await p.goto('/chat')
  if (phone) {
    await p.locator('.seg button').filter({ hasText: /^(홈|Home)$/ }).click()
    await p.locator('button.msgs').click()
  } else await p.locator('button.msg-btn').click()
  await p.locator('.ms').waitFor()
  // (the list of conversations: the 전체 chip — the same in an English screen)
  await p.locator('[data-test="msg-chip-all"]').click()
  // (the newest first: a room with the same people and no name of its own — F-RX-01's after 「기본 이름으로」 — is further down)
  await p.locator('.ms .th').filter({ has: p.locator('.nm b', { hasText: new RegExp(`^${title}$`) }) }).first().click()
  await p.locator('.ms .cmp textarea').waitFor()
}
const head = (p) => p.locator('[data-test="msg-thread-head"] > b')
const say = (who, room, text) => S.api(who.token, `/team/threads/${room}/messages`, { method: 'POST', body: { text } })
const bubble = (p, text) => p.locator('.ms .msg').filter({ hasText: text })
const chips = (p, text) => p.locator(`[data-test="rx-chips"][data-for="${text}"]`)
const chip = (p, id, key) => p.locator(`[data-test="rx-chips"][data-for="${id}"] [data-test="rx-chip"][data-key="${key}"]`)
const bar = (p) => p.locator('[data-test="rx-bar"]')
// a real touch through the browser's input pipeline (Playwright has no long press) — as the message menu's tests do
async function press(p, el, ms = 700) {
  const b = await el.boundingBox()
  const x = b.x + Math.min(b.width / 2, 60), y = b.y + b.height / 2
  const cdp = await p.context().newCDPSession(p)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
  await p.waitForTimeout(ms)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await cdp.detach().catch(() => {})
}
const inside = async (p, el, width) => { const b = await el.boundingBox(); expect(b.x).toBeGreaterThanOrEqual(0); expect(b.x + b.width).toBeLessThanOrEqual(width) }

test('F-RX-01 단체방 이름 — ⚙ 대화방 설정에서 저장하면 두 사람의 머리에 바로, 시스템 줄, 「기본 이름으로」는 사람들 이름', async ({ browser }) => {
  const { id } = await S.api(HY.token, '/team/threads', { method: 'POST', body: { members: [SY.id, DY.id] } })
  await say(SY, id, '3분기 견적 세 곳 비교해 볼까요?')
  await say(HY, id, '좋아요, 표로 정리할게요.')
  // (박도윤 has read what was said: the rename's line must not make it unread)
  await S.api(DY.token, `/team/threads/${id}/read`, { method: 'POST' })
  // 김서연 has the room open: it changes in front of her
  const y = await page(browser, SY, DESK)
  await openRoom(y, '정하윤, 박도윤')
  await expect(head(y)).toHaveText('정하윤, 박도윤')
  const p = await page(browser, HY, DESK)
  await openRoom(p, '김서연, 박도윤')
  await p.locator('[data-test="room-settings-open"]').click()
  const sheet = p.locator('[data-test="room-settings-sheet"]')
  await expect(sheet).toBeVisible()
  const field = sheet.locator('[data-test="room-name"]')
  await expect(field).toHaveValue('')
  await expect(field).toHaveAttribute('placeholder', '김서연, 박도윤')
  await expect(sheet.locator('[data-test="room-name-save"]')).toBeDisabled()
  await expect(sheet.locator('[data-test="room-name-reset"]')).toHaveCount(0)
  await field.fill('3분기 견적 검토')
  await expect(sheet).toContainText('9/50')
  await shot(p, SHOTS_NAME, 'f-rx-01a-settings')
  await sheet.locator('[data-test="room-name-save"]').click()
  await expect(sheet).toHaveCount(0)
  const line = '정하윤님이 대화방 이름을 「3분기 견적 검토」로 바꿨어요'
  await expect(head(p)).toHaveText('3분기 견적 검토')
  await expect(p.locator('[data-test="msg-rename"]')).toHaveText(line)
  await expect(p.locator('.ms .th.on .nm b')).toHaveText('3분기 견적 검토')
  await shot(p, SHOTS_NAME, 'f-rx-01b-renamed')
  // 김서연's open room: the name and the line, without a reload — and no unread badge for it
  await expect(head(y)).toHaveText('3분기 견적 검토')
  await expect(y.locator('[data-test="msg-rename"]')).toHaveText(line)
  await expect(y.locator('.ms .th').filter({ hasText: '3분기 견적 검토' }).locator('.badge')).toHaveCount(0)
  await shot(y, SHOTS_NAME, 'f-rx-01c-teammate-live')
  // Process GPT's field holds it
  expect((await S.q('select name from chat_rooms where id=$1', [id]))[0].name).toBe('3분기 견적 검토')
  // 박도윤 (not looking): no unread for the rename line, and no Home card for it
  expect((await S.api(DY.token, '/team/unread')).byThread[id] || 0).toBe(0)
  expect((await S.api(DY.token, '/notifications')).filter((n) => String(n.url || '').includes(id))).toEqual([])
  // 「기본 이름으로」: called by its people again, on both screens
  await p.locator('[data-test="room-settings-open"]').click()
  await expect(sheet.locator('[data-test="room-name"]')).toHaveValue('3분기 견적 검토')
  await sheet.locator('[data-test="room-name-reset"]').click()
  await expect(head(p)).toHaveText('김서연, 박도윤')
  await expect(p.locator('[data-test="msg-rename"]').last()).toHaveText('정하윤님이 대화방 이름을 지웠어요')
  await expect(head(y)).toHaveText('정하윤, 박도윤')
  await shot(y, SHOTS_NAME, 'f-rx-01d-name-removed')
  for (const x of [p, y]) { expect(x.errors).toEqual([]); await x.context().close() }
})

test('F-RX-02 1:1 대화의 설정 — 이름 칸 없이 상대의 이름으로 보인다고', async ({ browser }) => {
  const { id } = await S.api(HY.token, '/team/threads', { method: 'POST', body: { members: [SY.id] } })
  await say(HY, id, '둘만 하는 이야기예요.')
  const p = await page(browser, HY, DESK)
  await openRoom(p, '김서연')
  await p.locator('[data-test="room-settings-open"]').click()
  const sheet = p.locator('[data-test="room-settings-sheet"]')
  await expect(sheet.locator('[data-test="room-settings-direct"]')).toHaveText('1:1 대화는 상대의 이름으로 보여요. 이름은 단체방에서 붙일 수 있어요.')
  await expect(sheet.locator('[data-test="room-name"]')).toHaveCount(0)
  await shot(p, SHOTS_NAME, 'f-rx-02-direct-settings')
  await sheet.locator('[data-test="room-settings-cancel"]').click()
  await expect(sheet).toHaveCount(0)
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-RX-03 1280px 반응 — 마우스를 올린 단추 · 오른쪽 클릭으로 막대, 칩, 상대 화면에 바로, 다시 누르면 꺼짐, 누가 했는지', async ({ browser }) => {
  const { id } = await S.api(HY.token, '/team/threads', { method: 'POST', body: { members: [SY.id, DY.id], title: '견적 회의' } })
  const theirs = await say(SY, id, '견적서 초안 올렸어요. 확인 부탁해요.')
  const mine = await say(HY, id, '네, 오후에 볼게요.')
  const y = await page(browser, SY, DESK)
  await openRoom(y, '견적 회의')
  const p = await page(browser, HY, DESK)
  await openRoom(p, '견적 회의')
  // my own bubble: no reaction button, a right-click is the browser's own
  await bubble(p, '네, 오후에 볼게요.').hover()
  await expect(bubble(p, '네, 오후에 볼게요.').locator('[data-test="rx-open"]')).toHaveCount(0)
  await bubble(p, '네, 오후에 볼게요.').locator('.bub').click({ button: 'right' })
  await expect(bar(p)).toHaveCount(0)
  // a teammate's bubble: the button shows while the pointer is over it
  const b = bubble(p, '견적서 초안 올렸어요')
  const open = b.locator('[data-test="rx-open"]')
  await expect(open).toHaveCSS('opacity', '0')
  await b.locator('.bub').hover()
  await expect(open).toHaveCSS('opacity', '1')
  await open.click()
  await expect(bar(p)).toBeVisible()
  await expect(bar(p).locator('[data-test="rx-pick"]')).toHaveText(['좋아요', '확인했음', '사랑해', '웃음', '놀람', '감사'])
  // (each drawn with the app's own line icon, not the device's colour emoji — 2026-11-26 「아이콘들 디자인이 너무 전체 톤이 어울리지 않은듯」)
  await expect(bar(p).locator('[data-test="rx-pick"] svg')).toHaveCount(6)
  await shot(p, SHOTS_RX, 'f-rx-03a-hover-bar')
  await bar(p).locator('[data-key="like"]').click()
  await expect(bar(p)).toHaveCount(0)
  await expect(chip(p, theirs.id, 'like')).toHaveText('1')
  await expect(chip(p, theirs.id, 'like')).toHaveClass(/\bon\b/)
  // 김서연 sees it at once — not hers
  await expect(chip(y, theirs.id, 'like')).toHaveText('1')
  await expect(chip(y, theirs.id, 'like')).not.toHaveClass(/\bon\b/)
  // a right-click on the bubble: the bar where the pointer is; ✅
  await b.locator('.bub .txt').click({ button: 'right' })
  await expect(bar(p)).toBeVisible()
  await expect(bar(p).locator('[data-key="like"]')).toHaveAttribute('aria-pressed', 'true')
  await bar(p).locator('[data-key="check"]').click()
  await expect(chips(p, theirs.id).locator('[data-test="rx-chip"]')).toHaveText(['1', '1'])
  await shot(p, SHOTS_RX, 'f-rx-03b-chips')
  // 박도윤 likes it too (through the API): 👍 2 on both screens
  await S.api(DY.token, `/team/messages/${theirs.id}/reactions`, { method: 'POST', body: { key: 'like' } })
  await expect(chip(p, theirs.id, 'like')).toHaveText('2')
  await expect(chip(y, theirs.id, 'like')).toHaveText('2')
  // 김서연 rests the pointer on the 👍 of her own message: who reacted (her own chips do not toggle)
  await chip(y, theirs.id, 'like').hover()
  const who = chips(y, theirs.id).locator('[data-test="rx-who"]')
  await expect(who).toBeVisible()
  await expect(who).toContainText('좋아요')
  await expect(who).toContainText('정하윤, 박도윤')
  await shot(y, SHOTS_RX, 'f-rx-03c-teammate-who')
  await chip(y, theirs.id, 'like').click()
  await expect(chip(y, theirs.id, 'like')).toHaveText('2')
  // the 👍 chip again on my screen: mine off — 1 left (박도윤's), on both
  await chip(p, theirs.id, 'like').click()
  await expect(chip(p, theirs.id, 'like')).toHaveText('1')
  await expect(chip(p, theirs.id, 'like')).not.toHaveClass(/\bon\b/)
  await expect(chip(y, theirs.id, 'like')).toHaveText('1')
  await shot(p, SHOTS_RX, 'f-rx-03d-toggled-off')
  // what the rows say
  const rows = await S.q('select user_id::text as u, reaction from pro_chat_reactions where chat_uuid=$1 order by created_at', [theirs.id])
  expect(rows).toEqual([{ u: HY.id, reaction: 'check' }, { u: DY.id, reaction: 'like' }])
  expect(await S.q('select 1 from pro_chat_reactions where chat_uuid=$1', [mine.id])).toEqual([])
  // nothing for 김서연's Home or bell
  expect((await S.api(SY.token, '/notifications')).filter((n) => String(n.url || '').includes(id))).toEqual([])
  for (const x of [p, y]) { expect(x.errors).toEqual([]); await x.context().close() }
})

test('F-RX-04 휴대폰 390px 밝은 · 밤 — 길게 누르면 막대, ❤️ 칩, 칩을 길게 누르면 누가 했는지', async ({ browser }) => {
  const { id } = await S.api(SY.token, '/team/threads', { method: 'POST', body: { members: [HY.id, DY.id], title: '휴대폰 반응' } })
  const theirs = await say(SY, id, '오늘 회의는 3시에 해요. 다들 괜찮으세요?')
  const desk = await page(browser, SY, DESK)
  await openRoom(desk, '휴대폰 반응')
  for (const [k, theme, who] of [['a', 'light', DY], ['b', 'dark', HY]]) {
    const p = await page(browser, who, PHONE, { theme })
    await openRoom(p, '휴대폰 반응', { phone: true })
    const b = bubble(p, '오늘 회의는 3시에 해요')
    await press(p, b.locator('.bub'))
    await expect(bar(p)).toBeVisible()
    await inside(p, bar(p), 390)
    expect(await noOverflow(p)).toBe(true)
    await expect(bar(p).locator('[data-test="rx-copy"]')).toBeVisible()
    await shot(p, SHOTS_RX, `f-rx-04${k}1-phone-bar-${theme}`)
    await bar(p).locator('[data-key="love"]').tap()
    await expect(bar(p)).toHaveCount(0)
    const n = k === 'a' ? 1 : 2
    await expect(chip(p, theirs.id, 'love')).toHaveText(`${n}`)
    await expect(chip(desk, theirs.id, 'love')).toHaveText(`${n}`)
    // a long press on the chip: who — not a toggle
    await press(p, chip(p, theirs.id, 'love'))
    const whoList = chips(p, theirs.id).locator('[data-test="rx-who"]')
    await expect(whoList).toBeVisible()
    await expect(whoList).toContainText(k === 'a' ? '박도윤' : '박도윤, 정하윤')
    await expect(chip(p, theirs.id, 'love')).toHaveText(`${n}`)
    await inside(p, whoList, 390)
    expect(await noOverflow(p)).toBe(true)
    await shot(p, SHOTS_RX, `f-rx-04${k}2-phone-who-${theme}`)
    expect(p.errors).toEqual([])
    await p.context().close()
  }
  // a tap on the chip takes mine off (정하윤's, from the phone's last round — through the API here)
  await S.api(HY.token, `/team/messages/${theirs.id}/reactions`, { method: 'POST', body: { key: 'love' } })
  await expect(chip(desk, theirs.id, 'love')).toHaveText('1')
  expect(desk.errors).toEqual([])
  await desk.context().close()
})

test('F-RX-05 휴대폰 390px 밝은 · 밤 — 머리의 ⚙ 가 화면 안, 설정 창, 저장하면 머리에 그 이름', async ({ browser }) => {
  const { id } = await S.api(DY.token, '/team/threads', { method: 'POST', body: { members: [HY.id, SY.id] } })
  await say(HY, id, '휴대폰에서 방 이름 바꿔 볼게요.')
  for (const [k, theme] of [['a', 'light'], ['b', 'dark']]) {
    const p = await page(browser, DY, PHONE, { theme })
    await openRoom(p, k === 'a' ? '정하윤, 김서연' : '주간 보고', { phone: true })
    const gear = p.locator('[data-test="room-settings-open"]')
    await expect(gear).toBeVisible()
    await inside(p, gear, 390)
    await inside(p, p.locator('[data-test="room-invite"]'), 390)
    await gear.tap()
    const sheet = p.locator('[data-test="room-settings-sheet"]')
    await expect(sheet).toBeVisible()
    await inside(p, sheet, 390)
    expect(await noOverflow(p)).toBe(true)
    if (k === 'a') {
      await sheet.locator('[data-test="room-name"]').fill('주간 보고')
      await shot(p, SHOTS_NAME, `f-rx-05${k}1-phone-settings-${theme}`)
      await sheet.locator('[data-test="room-name-save"]').tap()
      await expect(head(p)).toHaveText('주간 보고')
      await expect(p.locator('[data-test="msg-rename"]')).toHaveText('박도윤님이 대화방 이름을 「주간 보고」로 바꿨어요')
    } else {
      await expect(sheet.locator('[data-test="room-name"]')).toHaveValue('주간 보고')
      await shot(p, SHOTS_NAME, `f-rx-05${k}1-phone-settings-${theme}`)
      await sheet.locator('[data-test="room-settings-cancel"]').tap()
    }
    expect(await noOverflow(p)).toBe(true)
    await shot(p, SHOTS_NAME, `f-rx-05${k}2-phone-renamed-${theme}`)
    expect(p.errors).toEqual([])
    await p.context().close()
  }
})

test('F-RX-06 영어 화면 — 설정 · 막대 · 칩 · 누가 했는지 · 시스템 줄', async ({ browser }) => {
  const { id } = await S.api(HY.token, '/team/threads', { method: 'POST', body: { members: [SY.id, DY.id], title: 'English check' } })
  const theirs = await say(SY, id, 'Draft quote is up.')
  await S.api(DY.token, `/team/messages/${theirs.id}/reactions`, { method: 'POST', body: { key: 'thanks' } })
  const p = await page(browser, HY, DESK, { lang: 'en' })
  await openRoom(p, 'English check')
  await p.locator('[data-test="room-settings-open"]').click()
  const sheet = p.locator('[data-test="room-settings-sheet"]')
  await expect(sheet).toContainText('Conversation settings')
  await expect(sheet).toContainText('Conversation name')
  await expect(sheet).toContainText("Everyone sees the same name. Leave it empty to show its people's names.")
  await expect(sheet.locator('[data-test="room-name-reset"]')).toHaveText('Use the default name')
  await sheet.locator('[data-test="room-name"]').fill('Quote review')
  await sheet.locator('[data-test="room-name-save"]').click()
  await expect(p.locator('[data-test="msg-rename"]')).toHaveText('정하윤 renamed the conversation to “Quote review”')
  await bubble(p, 'Draft quote is up.').locator('.bub').hover()
  await bubble(p, 'Draft quote is up.').locator('[data-test="rx-open"]').click()
  await expect(bar(p).locator('[data-test="rx-pick"]')).toHaveText(['Like', 'Got it', 'Love', 'Haha', 'Wow', 'Thanks'])
  await expect(bar(p).locator('[data-test="rx-copy"]')).toHaveText('Copy')
  await shot(p, SHOTS_RX, 'f-rx-06a-english-bar')
  await bar(p).locator('[data-key="check"]').click()
  await expect(chip(p, theirs.id, 'check')).toHaveAttribute('aria-label', 'Got it · 1')
  await chip(p, theirs.id, 'thanks').hover()
  await expect(chips(p, theirs.id).locator('[data-test="rx-who"]')).toContainText('Thanks')
  await expect(chips(p, theirs.id).locator('[data-test="rx-who"]')).toContainText('박도윤')
  await shot(p, SHOTS_RX, 'f-rx-06b-english-who')
  // nothing of this feature's own words left in Korean (a room's name — 「휴대폰 반응」 — is the people's own words)
  const ours = ['대화방 설정', '대화방 이름', '모두에게 같은 이름으로 보여요. 비워 두면 사람들 이름으로 보여요.', '기본 이름으로', '반응 남기기', '좋아요', '확인했음', '사랑해', '웃음', '놀람', '감사', '복사']
  expect(await p.evaluate((o) => (window.osI18n?.missing?.() || []).filter((s) => o.includes(s.trim()) || /^반응 \S+ \d+개$/.test(s.trim())), ours)).toEqual([])
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-RX-07 반응 테이블이 아직 없는 데이터베이스 — 반응을 내밀지 않고, 길게 누르면 「복사」만, 503 이 오면 그때부터 내밀지 않음', async ({ browser }) => {
  const { id } = await S.api(SY.token, '/team/threads', { method: 'POST', body: { members: [HY.id, DY.id], title: '반응 없는 방' } })
  const theirs = await say(SY, id, '내일 자료는 오전에 올릴게요.')
  // (another reaction already on it: its chip is shown but cannot be pressed)
  await S.api(DY.token, `/team/messages/${theirs.id}/reactions`, { method: 'POST', body: { key: 'check' } })
  // the room says this database has no reactions (sql/062 not run): what the server answers there, without dropping the dev table
  const off = async (p) => p.route('**/api/team/threads/*/messages', async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    const r = await route.fetch()
    const j = await r.json()
    await route.fulfill({ response: r, json: { ...j, thread: { ...j.thread, reactions: false } } })
  })
  const p = await page(browser, HY, PHONE, { theme: 'dark' })
  await off(p)
  await openRoom(p, '반응 없는 방', { phone: true })
  const b = bubble(p, '내일 자료는 오전에 올릴게요')
  await expect(chip(p, theirs.id, 'check')).toHaveText('1')
  await chip(p, theirs.id, 'check').tap()
  await p.waitForTimeout(600)
  expect((await S.q('select count(*)::int n from pro_chat_reactions where chat_uuid=$1', [theirs.id]))[0].n).toBe(1)
  await expect(chip(p, theirs.id, 'check')).toHaveText('1')
  // (a chip that cannot be pressed says who reacted instead — put away before the long press)
  await expect(chips(p, theirs.id).locator('[data-test="rx-who"]')).toContainText('박도윤')
  await p.locator('.ms .msgs').tap({ position: { x: 300, y: 600 } })
  await expect(chips(p, theirs.id).locator('[data-test="rx-who"]')).toHaveCount(0)
  await press(p, b.locator('.bub'))
  await expect(bar(p)).toBeVisible()
  await expect(bar(p).locator('[data-test="rx-pick"]')).toHaveCount(0)
  await expect(bar(p).locator('[data-test="rx-copy"]')).toBeVisible()
  await shot(p, SHOTS_RX, 'f-rx-07a-off-copy-only-dark')
  expect(p.errors).toEqual([])
  await p.context().close()

  // the room said yes, the server then refuses (503 — the table went missing): the chip goes back off and no more are offered
  const d = await page(browser, HY, DESK)
  await d.route('**/api/team/messages/*/reactions', (route) => route.fulfill({ status: 503, json: { error: '반응은 곧 쓸 수 있어요.', status: 503, code: 'reactions_off' } }))
  await openRoom(d, '반응 없는 방')
  const db = bubble(d, '내일 자료는 오전에 올릴게요')
  await db.hover()
  await db.locator('[data-test="rx-open"]').click()
  await bar(d).locator('[data-key="like"]').click()
  await expect(chip(d, theirs.id, 'like')).toHaveCount(0)
  await expect(d.locator('.ms')).toContainText('반응은 곧 쓸 수 있어요.')
  await db.hover()
  await expect(db.locator('[data-test="rx-open"]')).toHaveCount(0)
  // (the icons: an svg in every chip)
  await expect(chip(d, theirs.id, 'check').locator('svg')).toHaveCount(1)
  await shot(d, SHOTS_RX, 'f-rx-07b-refused-1280')
  expect(d.errors).toEqual([])
  await d.context().close()
})
