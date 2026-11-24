// 채팅 · 프로젝트의 산출물(2026-11-24 사용자: 「프로젝트나 채팅에서 생성된 산출물들은 맥 다운로드 영역처럼 산출물 목록 펼쳐 보기 기능이
// 있었는데.. 지금 안 나타나는 듯?」 · 「우측 영역이 많이 남아돌기에 산출물 목록들이 쭉 보이고 클릭하면 이음오피스로 보일 수 있을 것임」 —
// 스펙 openspec/specs/chat-artifacts). 산출물 더미(ArtifactStack)는 대화 하나를 고른 화면(/chat/c/:cid)에만 있었다. 이제 전체 채팅 ·
// 고른 대화 · 프로젝트 방마다 그 화면의 파일이, 자리가 넉넉하면 오른쪽 목록(ArtifactList)으로, 좁으면 입력창 옆 · 위의 더미로,
// 문서가 열려 있으면 숨는다. 모델 없이 고정 데이터로. 순수 규칙(범위 · 순서 · 찾기 · 자리)은 server/test/chatArtifacts.test.js.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../../lib/fixtures.js'
import { seedConversations } from '../../lib/chatseed.js'
import * as api from '../../lib/api.js'
import { MIME, XLSX, PNG_1PX } from '../../lib/seed.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const SHOTS = path.resolve(here, '../../../openspec/specs/chat-artifacts/e2e/results')
const WIDE = { width: 1440, height: 900 }
const MEDIUM = { width: 1100, height: 800 }
const PHONE = { width: 390, height: 844 }
// Playwright's own Chromium (never a person's Chrome)
test.use({ channel: 'chromium' })
// one account's main chat, reseeded by every test
test.describe.configure({ mode: 'serial' })

const list = (page) => page.getByTestId('artifact-list')
const rows = (page) => page.getByTestId('artifact-row')
const pile = (page) => page.locator('.astack')
const composer = (page) => page.locator('.col .foot .composer').first()
const settled = (page) => page.evaluate(() => Promise.all(document.getAnimations()
  .filter((a) => a.effect?.getComputedTiming?.().iterations !== Infinity).map((a) => a.finished.catch(() => {}))))
async function shot(page, name) { await settled(page); await page.screenshot({ path: path.join(SHOTS, name) }) }
async function chat(page, url = '/chat') {
  await page.goto(url)
  await expect(composer(page)).toBeVisible({ timeout: 30_000 })
}
const theme = (page, t) => page.context().addInitScript((v) => { try { localStorage.setItem('pgpt-pro-theme', v) } catch { /* ignore */ } }, t)
const overlap = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
// a project room with two files the agent made in it
async function seedProject(db, u, cleanup) {
  const xlsx = await api.upload(u.token(), '분기 매출.xlsx', MIME.xlsx, await XLSX([['분기', '매출'], ['1분기', 1200], ['2분기', 1500]]))
  const png = await api.upload(u.token(), '매출 그래프.png', MIME.png, PNG_1PX)
  const [t] = await db.q(`insert into pro_threads(user_id,kind,title) values ($1,'project','회귀 분기 보고') returning id`, [u.id])
  cleanup(() => db.q('delete from pro_threads where id=$1', [t.id]))
  await db.addMessages(t.id, [
    { role: 'user', kind: 'text', content: { text: '분기 매출 표와 그래프 만들어 줘' } },
    { role: 'agent', kind: 'text', content: { text: '표와 그래프를 만들었어요.' } },
    { role: 'agent', kind: 'file', content: { name: '분기 매출.xlsx', url: xlsx.url } },
    { role: 'agent', kind: 'file', content: { name: '매출 그래프.png', url: png.url } },
  ])
  return t.id
}

test('F-AS-01 전체 채팅: 넓은 화면이면 오른쪽에 채팅의 산출물 목록 — 최근 순, 종류 · 이름 · 시각 · 나온 대화, 찾기', async ({ pageAs, db }) => {
  const page = await pageAs('as-user', { viewport: WIDE })
  await theme(page, 'light')
  await seedConversations(db, page.user)
  // (the light theme over the daytime sky: ?hour= previews another time of day)
  await chat(page, '/chat?hour=13')
  await expect(list(page)).toBeVisible()
  await expect(list(page)).toHaveAttribute('data-scope', 'chat')
  await expect(page.getByTestId('artifact-count')).toHaveText('13')
  await expect(list(page).locator('.cap')).toHaveText('채팅의 산출물 · 누르면 그 자리에서 열려요')
  // newest first: the YouTube conversation's ten (its last made last), then the trip's three
  await expect(rows(page)).toHaveCount(13)
  await expect(rows(page).first()).toHaveAttribute('data-file', '영상 10.xlsx')
  await expect(rows(page).nth(1)).toHaveAttribute('data-file', '영상 9.svg')
  await expect(rows(page).last()).toHaveAttribute('data-file', '숙소 1.xlsx')
  await expect(rows(page).nth(1).locator('.tile')).toHaveText('SVG')
  await expect(rows(page).last().locator('.tile')).toHaveText('XLS')
  await expect(rows(page).first().locator('small')).toHaveText(/^\d+분 전 · 유튜브 채널$/)
  await expect(rows(page).last().locator('small')).toHaveText(/ · 출장 숙소$/)
  // the list has its own column: the chat moved over, nothing overlaps
  const lb = await list(page).boundingBox(), cb = await composer(page).boundingBox()
  expect(lb.x + lb.width).toBeLessThanOrEqual(WIDE.width)
  expect(overlap(lb, cb)).toBe(false)
  expect(cb.x + cb.width).toBeLessThan(lb.x)
  await expect(pile(page)).toHaveCount(0)
  await shot(page, 'f-as-01a-wide-light.png')
  // a search box (many files): by name and by the conversation
  await page.getByTestId('artifact-search').fill('숙소')
  await expect(rows(page)).toHaveCount(3)
  await page.getByTestId('artifact-search').fill('유튜브 svg')
  await expect(rows(page).locator('.meta b')).toHaveText(['영상 9.svg', '영상 6.svg', '영상 3.svg'])
  await page.getByTestId('artifact-search').fill('없는 파일')
  await expect(page.getByTestId('artifact-none')).toHaveText('「없는 파일」와 맞는 산출물이 없어요.')
  await page.getByTestId('artifact-search').press('Escape')
  await expect(rows(page)).toHaveCount(13)
  expect(page.errors).toEqual([])
})

test('F-AS-02 고른 대화는 그 대화의 파일만, 프로젝트 방은 그 방의 파일 — 범위가 화면을 따라감', async ({ pageAs, db, cleanup }) => {
  const page = await pageAs('as-user', { viewport: WIDE })
  await seedConversations(db, page.user)
  const pid = await seedProject(db, page.user, cleanup)
  await chat(page, '/chat/c/rt-conv-trip')
  await expect(list(page)).toHaveAttribute('data-scope', 'conv')
  await expect(rows(page).locator('.meta b')).toHaveText(['숙소 3.svg', '숙소 2.png', '숙소 1.xlsx'])
  await expect(list(page).locator('.cap')).toHaveText('이 대화의 산출물 · 누르면 그 자리에서 열려요')
  // (in one conversation the rows do not repeat its name)
  await expect(rows(page).first().locator('small')).toHaveText(/^\d+분 전$/)
  await expect(page.getByTestId('artifact-search')).toHaveCount(0)
  await shot(page, 'f-as-02a-conversation.png')
  await page.goto(`/projects/${pid}`)
  await expect(list(page)).toHaveAttribute('data-scope', 'project', { timeout: 30_000 })
  await expect(rows(page).locator('.meta b')).toHaveText(['매출 그래프.png', '분기 매출.xlsx'])
  await expect(list(page).locator('.cap')).toHaveText('이 프로젝트의 산출물 · 누르면 그 자리에서 열려요')
  await expect(page.getByText('표와 그래프를 만들었어요.')).toBeVisible()
  await shot(page, 'f-as-02b-project.png')
  // a routine's page and 새 프로젝트 have none
  await page.goto('/projects')
  await expect(page.locator('.plist')).toBeVisible()
  await expect(list(page)).toHaveCount(0)
  await expect(pile(page)).toHaveCount(0)
  expect(page.errors).toEqual([])
})

test('F-AS-03 행을 누르면 채팅 카드처럼 이음오피스 패널에서 열리고, 문서가 열려 있는 동안 목록은 비켜 있다가 닫으면 돌아옴', async ({ pageAs, db }) => {
  const page = await pageAs('as-user', { viewport: WIDE })
  await seedConversations(db, page.user)
  await chat(page, '/chat/c/rt-conv-trip')
  await rows(page).filter({ hasText: '숙소 1.xlsx' }).click()
  const frame = page.locator('.oef iframe.frm')
  await expect(frame).toBeVisible({ timeout: 20_000 })
  expect(await frame.getAttribute('src')).toMatch(/^\/office\/sheets\/\?src=/)
  // the document wins: no list, no pile
  await expect(list(page)).toHaveCount(0)
  await expect(pile(page)).toHaveCount(0)
  await shot(page, 'f-as-03a-document-open.png')
  await page.locator('.oef .tb.ic[title="닫기"]').click()
  await expect(page.locator('.oef')).toHaveCount(0)
  await expect(list(page)).toBeVisible()
  await expect(rows(page)).toHaveCount(3)
  // the share button beside a row
  await rows(page).first().hover()
  await expect(list(page).locator('.roww').first().locator('.share')).toBeVisible()
  expect(page.errors).toEqual([])
})

test('F-AS-04 접기: 아이콘만 있는 얇은 띠, 이 브라우저에 기억, 띠의 아이콘도 열림, 펼치면 목록', async ({ pageAs, db }) => {
  const page = await pageAs('as-user', { viewport: WIDE })
  await seedConversations(db, page.user)
  await chat(page)
  await page.getByTestId('artifact-fold').click()
  await expect(list(page)).toHaveClass(/\brail\b/)
  await expect(list(page).locator('.meta')).toHaveCount(0)
  await expect(page.getByTestId('artifact-fold')).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByTestId('artifact-fold').locator('.rn')).toHaveText('13')
  await expect.poll(async () => (await list(page).boundingBox()).width).toBeLessThanOrEqual(64)
  expect(await page.evaluate(() => localStorage.getItem('pgl-artifact-list'))).toBe('rail')
  await shot(page, 'f-as-04a-rail.png')
  await page.reload()
  await expect(list(page)).toHaveClass(/\brail\b/, { timeout: 30_000 })
  await rows(page).filter({ has: page.locator('.tile.xls') }).last().click()
  await expect(page.locator('.oef iframe.frm')).toBeVisible({ timeout: 20_000 })
  await page.locator('.oef .tb.ic[title="닫기"]').click()
  await page.getByTestId('artifact-fold').click()
  await expect(list(page)).not.toHaveClass(/\brail\b/)
  await expect(list(page).locator('.meta')).toHaveCount(13)
  expect(await page.evaluate(() => localStorage.getItem('pgl-artifact-list'))).toBe('list')
  expect(page.errors).toEqual([])
})

test('F-AS-05 메신저를 오른쪽에 붙여 두면: 목록은 메신저 왼쪽에, 자리가 모자라면 더미로 — 서로 겹치지 않음', async ({ pageAs, db }) => {
  const page = await pageAs('as-user', { viewport: { width: 1600, height: 900 } })
  await page.context().addInitScript(() => { try { localStorage.setItem('pgl-messenger-dock', JSON.stringify({ dock: 'right', width: 400 })) } catch { /* ignore */ } })
  await seedConversations(db, page.user)
  await chat(page)
  await page.locator('button.msg-btn').click()
  const ms = page.locator('[data-test="messenger"]')
  await expect(ms).toHaveAttribute('data-dock', 'right')
  await settled(page)
  // Home open beside the chat: 1600 − 412 (messenger) − 420 (Home) leaves no room for the list → the pile, clear of the messenger
  await expect(list(page)).toHaveCount(0)
  await expect(pile(page)).toBeVisible()
  const mb = await ms.boundingBox()
  expect(overlap(await pile(page).boundingBox(), mb)).toBe(false)
  expect(overlap(await pile(page).boundingBox(), await composer(page).boundingBox())).toBe(false)
  await shot(page, 'f-as-05a-docked-pile.png')
  // Home put away: the list fits, left of the messenger
  await page.locator('.top .home').click()
  await expect(list(page)).toBeVisible()
  await settled(page)
  const lb = await list(page).boundingBox()
  expect(lb.x + lb.width).toBeLessThanOrEqual(mb.x)
  expect(overlap(lb, await composer(page).boundingBox())).toBe(false)
  await expect(pile(page)).toHaveCount(0)
  // the corner clock (Home closed) gives way when the chat has moved over next to it
  if (await page.locator('.clock').count()) expect(overlap(await page.locator('.clock').boundingBox(), await composer(page).boundingBox())).toBe(false)
  await shot(page, 'f-as-05b-docked-list.png')
  expect(page.errors).toEqual([])
})

test('F-AS-06 중간 폭(1100px, Home 열림)은 입력창 옆 · 위의 더미 — 입력창 · 멈추기를 가리지 않고, 펼치면 열림', async ({ pageAs, db }) => {
  const page = await pageAs('as-user', { viewport: MEDIUM })
  await theme(page, 'dark')
  await seedConversations(db, page.user)
  await chat(page)
  await expect(list(page)).toHaveCount(0)
  await expect(pile(page)).toBeVisible()
  await expect(pile(page)).toHaveAttribute('data-place', 'above')
  await expect(pile(page).locator('.count')).toHaveText('13')
  const pb = await pile(page).boundingBox(), cb = await composer(page).boundingBox()
  expect(overlap(pb, cb)).toBe(false)
  expect(pb.y + pb.height).toBeLessThan(cb.y - 40)
  // an answer being written: 「멈추기」 over the composer stays clear too
  await page.evaluate(() => { const app = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('app'); app.drafts[app.activeId] = '' })
  await expect(page.locator('.foot .stop')).toBeVisible()
  expect(overlap(await pile(page).boundingBox(), await page.locator('.foot .stop').boundingBox())).toBe(false)
  // a long message typed: the composer grows and the pile moves up with it
  await page.locator('.composer textarea').first().fill('한 줄\n두 줄\n세 줄\n네 줄\n다섯 줄\n여섯 줄')
  await expect.poll(async () => overlap(await pile(page).boundingBox(), await composer(page).boundingBox())).toBe(false)
  await expect.poll(async () => (await pile(page).boundingBox()).y + (await pile(page).boundingBox()).height < (await composer(page).boundingBox()).y).toBe(true)
  await page.evaluate(() => { const app = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('app'); app.drafts[app.activeId] = null })
  await page.locator('.composer textarea').first().fill('')
  await shot(page, 'f-as-06a-medium-dark.png')
  await pile(page).locator('.pile').click({ force: true })
  await expect(pile(page).locator('.grid .cap')).toContainText('채팅의 산출물 13개')
  await page.waitForTimeout(700) // the fan's spring (its transitions start a frame later)
  await shot(page, 'f-as-06b-medium-grid.png')
  await pile(page).locator('.grid .cell', { hasText: '숙소 1.xlsx' }).click()
  await expect(page.locator('.oef iframe.frm')).toBeVisible({ timeout: 20_000 })
  await expect(pile(page)).toHaveCount(0)
  // 1280 with Home open: the pile sits beside the composer (the document beside the page had put Home away; without Home the list fits)
  await page.locator('.oef .tb.ic[title="닫기"]').click()
  await page.setViewportSize({ width: 1280, height: 800 })
  await expect(list(page)).toBeVisible()
  await page.locator('.top .home').click()
  await expect(page.locator('aside.dock')).toBeVisible()
  await expect(pile(page)).toHaveAttribute('data-place', 'beside')
  const b2 = await pile(page).boundingBox(), c2 = await composer(page).boundingBox()
  expect(b2.x).toBeGreaterThan(c2.x + c2.width)
  expect(overlap(b2, c2)).toBe(false)
  expect(page.errors).toEqual([])
})

test('F-AS-07 휴대폰 390px: 작은 더미가 입력창 위에 — 가리지 않고, 옆으로 밀리지 않고, 펼치면 그 대화의 파일', async ({ pageAs, db }) => {
  const page = await pageAs('as-phone', { viewport: PHONE, dpr: 2, touch: true })
  await theme(page, 'light')
  await seedConversations(db, page.user)
  // a phone opens on Home: 채팅, then the conversation from the bar over the chat
  await page.goto('/chat?hour=13')
  await page.locator('.seg button[data-tab="chat"]').tap()
  await expect(composer(page)).toBeVisible({ timeout: 30_000 })
  await expect(pile(page).locator('.count')).toHaveText('13')
  await page.locator('.cbar .pill').tap()
  await page.locator('.cbar .panel .row', { hasText: '출장 숙소' }).tap()
  await expect(page).toHaveURL(/\/chat\/c\/rt-conv-trip$/)
  await expect(list(page)).toHaveCount(0)
  await expect(pile(page)).toBeVisible()
  await expect(pile(page)).toHaveClass(/\bsmall\b/)
  await expect(pile(page).locator('.count')).toHaveText('3')
  const pb = await pile(page).boundingBox(), cb = await composer(page).boundingBox()
  expect(overlap(pb, cb)).toBe(false)
  expect(pb.y + pb.height).toBeLessThan(cb.y)
  expect(pb.x + pb.width).toBeLessThanOrEqual(PHONE.width)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(PHONE.width)
  await shot(page, 'f-as-07a-phone.png')
  await pile(page).locator('.pile').tap({ force: true })
  await expect(pile(page).locator('.fitem')).toHaveCount(3)
  await page.waitForTimeout(700) // the fan's spring (its transitions start a frame later)
  await shot(page, 'f-as-07b-phone-fan.png')
  // back to the whole chat: its pile again
  await page.keyboard.press('Escape')
  await page.locator('.cbar .back').tap()
  await expect(pile(page).locator('.count')).toHaveText('13')
  // Home (a phone's own tab) has none
  await page.locator('.seg button[data-tab="home"]').tap()
  await expect(pile(page)).toHaveCount(0)
  expect(page.errors).toEqual([])
})

test('F-AS-08 밤 테마의 넓은 목록', async ({ pageAs, db }) => {
  const page = await pageAs('as-user', { viewport: WIDE })
  await theme(page, 'dark')
  await seedConversations(db, page.user)
  await chat(page)
  await expect(list(page)).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark')
  expect(await rows(page).first().locator('.meta b').evaluate((el) => getComputedStyle(el).color)).toBe('rgb(245, 245, 247)')
  await rows(page).nth(1).hover()
  await shot(page, 'f-as-08-wide-dark.png')
  expect(page.errors).toEqual([])
})
