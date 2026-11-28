// 보낸 공유 카드의 받은 사람별 줄: 「안 열어 봄」 → 「열어 봄 · 언제」 → 「N개 고침 · 언제」(2026-11-26 사용자 휴대폰 화면 — 단체방 「보냄 · 공유」 카드에
// 받은 사람마다 「… 아직 그대로」(한 사람의 두 계정이 똑같은 이름으로 두 줄): 「아직그대로는 뭔가? 혹시 확인여부 ㅡ 파일을 열어서 봤는지라면 좋은데 ○○○께서
// 열어보셨다는데 아직그대로로 표시된」 — 스펙 openspec/specs/team-sharing). 지어낸 사람: 서도윤(보냄) · 한지우 두 계정(mail-b.test · corp-a.test) · 정민호.
//   F-SO-01 휴대폰 390px 밝은: 보낸 직후 세 줄 모두 「안 열어 봄」, 같은 이름은 「한지우 · mail-b.test」 · 「한지우 · corp-a.test」 → 한지우(mail-b)가
//           방에서 그림의 작은 미리 보기를 봐도 그대로 → 눌러 크게 보면 보낸 사람의 열어 둔 카드가 새로 고침 없이 「열어 봄 · 방금」, 나머지는 「안 열어 봄」.
//           받은 사람의 화면에는 이 줄이 없다
//   F-SO-02 휴대폰 390px 밤: 정민호가 대화 › 나에게 온 것의 그림을 눌러 연다 → 보낸 사람 카드: 두 사람 「열어 봄」, 한지우(corp-a) 「안 열어 봄」 · 옆으로 넘치지 않음
//   F-SO-03 영어 화면: 「Opened · just now」 · 「Not opened」, 이름의 주소 표시는 그대로
//   F-SO-04 (PR #91 검토) 방을 연 채 새 공유를 보내면 그 메시지만 묻는다(이미 받은 카드는 다시 묻지 않음) — 새 카드도 「안 열어 봄」
// 자기 스택(lib/localStack.js — 회사 share-open-ui, RT_API_FROM · RT_WEB_FROM 부터 빈 포트, 기본 8977 · 5377)을 띄우고 지운다. 모델은 부르지 않는다.
//   cd e2e && npx playwright test --project=feature tests/feature/share-opened.spec.js
import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { startStack, REPO, SERVER } from '../../lib/localStack.js'

test.describe.configure({ mode: 'serial' })
const SHOTS = path.join(REPO, 'openspec/specs/team-sharing/e2e/results')
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ko-KR' }
const NOWHERE = 'http://127.0.0.1:9'
const TENANT = 'share-open-ui'
const ROOM = '시니어 모임'
const SHOT_NAME = '화면 캡처 2026-11-26 오후 3.20.png'
let S, DY, J1, J2, MH, room, msgId

// a screenshot-like picture (ffmpeg's test card, 780 × 1688 — a phone's screen)
function picture() {
  const out = path.join(os.tmpdir(), `rt-so-${process.pid}-${Date.now()}.png`)
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=780x1688', '-frames:v', '1', out])
  const b = fs.readFileSync(out); fs.rmSync(out, { force: true }); return b
}
async function rawPost(token, p, buf, headers) {
  const r = await fetch(`http://127.0.0.1:${S.apiPort}/api${p}`, { method: 'POST', body: buf, headers: { Authorization: `Bearer ${token}`, ...headers } })
  const t = await r.text()
  if (!r.ok) throw new Error(`POST ${p} → ${r.status} ${t.slice(0, 200)}`)
  return JSON.parse(t)
}

test.beforeAll(async () => {
  test.setTimeout(240_000)
  fs.mkdirSync(SHOTS, { recursive: true })
  S = await startStack({ tenant: TENANT, apiFrom: Number(process.env.RT_API_FROM) || 8977, webFrom: Number(process.env.RT_WEB_FROM) || 5377,
    env: { PRO_DEEPAGENTS_URL: NOWHERE, PRO_COMPLETION_URL: NOWHERE, PRO_CONTEXT_ROUTER_URL: NOWHERE, PRO_JUDGE_URL: '' } })
  DY = await S.person(`pro-rt-${TENANT}-a@corp-a.test`, '서도윤')
  J1 = await S.person(`pro-rt-${TENANT}-b@mail-b.test`, '한지우')
  J2 = await S.person(`pro-rt-${TENANT}-c@corp-a.test`, '한지우')
  MH = await S.person(`pro-rt-${TENANT}-d@corp-a.test`, '정민호')
  for (const p of [DY, J1, J2, MH]) { await S.join(p); await S.api(p.token, '/team') }
  await cleanData()
  room = (await S.api(DY.token, '/team/threads', { method: 'POST', body: { members: [J1.id, J2.id, MH.id], title: ROOM } })).id
  const card = await rawPost(DY.token, '/team/uploads', picture(), { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(SHOT_NAME), 'X-File-Type': 'image/png' })
  msgId = (await S.api(DY.token, `/team/threads/${room}/messages`, { method: 'POST', body: { text: '이 화면 한번 봐 주세요', artifactIds: [card.id] } })).id
})

async function cleanData() {
  const people = [DY, J1, J2, MH].filter(Boolean).map((p) => p.id)
  const { admin } = await import(path.join(SERVER, 'lib/supa.js'))
  const urls = await S.q(`select content->>'url' as url from pro_messages m join pro_threads t on t.id=m.thread_id where t.user_id = any($1::uuid[]) and m.kind='file'`, [people]).catch(() => [])
  const keys = urls.map(({ url }) => /\/object\/public\/files\/(.+)$/.exec(url || '')?.[1]).filter(Boolean).map(decodeURIComponent)
  if (keys.length) await admin.storage.from('files').remove([...new Set(keys)]).catch(() => {})
  for (const sql of ['delete from pro_shares where tenant_id=$1', 'delete from chats where tenant_id=$1',
    'delete from pro_chat_reads where room_id in (select id from chat_rooms where tenant_id=$1)', 'delete from chat_rooms where tenant_id=$1']) await S.q(sql, [TENANT]).catch(() => {})
  await S.q('delete from notifications where user_id::text = any($1::text[])', [people]).catch(() => {})
  await S.q('delete from pro_messages where thread_id in (select id from pro_threads where user_id = any($1::uuid[]))', [people]).catch(() => {})
  await S.q(`delete from pro_threads where user_id = any($1::uuid[]) and kind <> 'chat'`, [people]).catch(() => {})
}
test.afterAll(async () => { if (S) { await cleanData().catch(() => {}); await S.stop() } })

async function page(browser, who, { theme = 'light', lang = 'ko' } = {}) {
  const ctx = await browser.newContext({ ...PHONE, baseURL: S.web })
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
const shot = async (p, name) => { await p.waitForTimeout(500); await p.screenshot({ path: path.join(SHOTS, `${name}.png`) }) }
const noOverflow = (p) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
async function openMessenger(p) {
  await p.goto('/chat')
  await p.locator('.seg button').filter({ hasText: /^(홈|Home)$/ }).click()
  await p.locator('button.msgs').click()
  await p.locator('.ms').waitFor()
}
async function openRoom(p) {
  await openMessenger(p)
  await p.locator('[data-test="msg-chip-all"]').click()
  await p.locator('.ms .th').filter({ hasText: ROOM }).first().click()
  await p.locator('.ms .cmp textarea').waitFor()
}
const line = (p, who) => p.locator(`.ms [data-id="${msgId}"] [data-test="share-receipt"][data-person="${who.id}"]`)
const nameOf = (p, who) => line(p, who).locator('[data-test="receipt-name"]')
const stateOf = (p, who) => line(p, who).locator('[data-test="receipt-state"]')
const opened = async (who) => (await S.q('select opened_at from pro_shares where tenant_id=$1 and recipient_id=$2 and chat_uuid=$3', [TENANT, who.id, msgId]))[0]?.opened_at || null
const toCard = (p) => p.locator(`.ms [data-id="${msgId}"]`).evaluate((el) => el.scrollIntoView({ block: 'center' }))

let sender
test('F-SO-01 휴대폰 390px 밝은 — 안 열어 봄, 같은 이름은 주소로, 미리 보기는 그대로, 크게 보면 보낸 사람 카드에 바로 「열어 봄」', async ({ browser }) => {
  sender = await page(browser, DY)
  await openRoom(sender)
  await expect(line(sender, J1)).toBeVisible({ timeout: 15000 })
  for (const who of [J1, J2, MH]) {
    await expect(line(sender, who)).toHaveAttribute('data-state', 'unopened')
    await expect(stateOf(sender, who)).toHaveText('안 열어 봄')
  }
  await expect(sender.locator('.ms').getByText('아직 그대로')).toHaveCount(0)
  // the same name, told apart by the address's domain; a name alone has no tag
  await expect(nameOf(sender, J1)).toHaveText('한지우 · mail-b.test')
  await expect(nameOf(sender, J2)).toHaveText('한지우 · corp-a.test')
  await expect(nameOf(sender, MH)).toHaveText('정민호')
  expect(await noOverflow(sender)).toBe(true)
  await toCard(sender)
  await shot(sender, 'f-so-01a-sender-unopened-light')

  // 한지우 (mail-b) opens the room on her phone: the picture's small preview loads — that is not opening it
  const j1 = await page(browser, J1)
  await openRoom(j1)
  const thumb = j1.locator(`.ms [data-test="media-preview"][data-file="${SHOT_NAME}"] img`).last()
  await expect(thumb).toBeVisible({ timeout: 15000 })
  await expect.poll(() => thumb.evaluate((i) => (i.complete ? i.naturalWidth : 0)), { timeout: 15000 }).toBeGreaterThan(0)
  // her own screen has no such lines (only the sender sees who opened)
  await expect(j1.locator('.ms [data-test="share-receipts"]')).toHaveCount(0)
  await j1.waitForTimeout(800)
  expect(await opened(J1)).toBeNull()
  await expect(stateOf(sender, J1)).toHaveText('안 열어 봄')
  // pressed: the viewer — opened
  await j1.locator(`.ms [data-test="media-preview"][data-file="${SHOT_NAME}"] button`).last().click()
  const viewer = j1.locator('[data-test="media-viewer"]')
  await expect(viewer).toBeVisible()
  await expect.poll(() => viewer.locator('[data-test="media-full"]').evaluate((i) => (i.complete ? i.naturalWidth : 0)), { timeout: 15000 }).toBeGreaterThan(0)
  await shot(j1, 'f-so-01b-recipient-viewer-light')
  await expect.poll(() => opened(J1), { timeout: 10000 }).not.toBeNull()
  // the sender's open card changes by itself: 한지우 (mail-b) opened, the other 한지우 and 정민호 not
  await expect(line(sender, J1)).toHaveAttribute('data-state', 'opened', { timeout: 15000 })
  await expect(stateOf(sender, J1)).toHaveText('열어 봄 · 방금')
  await expect(stateOf(sender, J2)).toHaveText('안 열어 봄')
  await expect(stateOf(sender, MH)).toHaveText('안 열어 봄')
  expect(await opened(J2)).toBeNull()
  expect(await noOverflow(sender)).toBe(true)
  await toCard(sender)
  await shot(sender, 'f-so-01c-sender-opened-light')
  expect(sender.errors).toEqual([])
  expect(j1.errors).toEqual([])
  await j1.context().close()
})

test('F-SO-02 휴대폰 390px 밤 — 정민호가 대화 › 나에게 온 것에서 그림을 눌러 열면 두 사람 「열어 봄」, 한지우(corp-a)만 「안 열어 봄」', async ({ browser }) => {
  const mh = await page(browser, MH, { theme: 'dark' })
  await openMessenger(mh)
  // (2026-11-28: the item is the room's own bubble — its picture opens the viewer as in the room; no 「열어 보기」 of its own)
  await mh.locator('[data-test="msg-chip-forme"]').click()
  const item = mh.locator('.ms [data-test="forme-item"]', { hasText: '이 화면 한번 봐 주세요' })
  await expect(item).toBeVisible({ timeout: 15000 })
  await item.locator(`[data-test="media-preview"][data-file="${SHOT_NAME}"] button`).click()
  await expect(mh.locator('[data-test="media-viewer"]')).toBeVisible()
  await expect.poll(() => opened(MH), { timeout: 10000 }).not.toBeNull()
  await mh.context().close()

  const dark = await page(browser, DY, { theme: 'dark' })
  await openRoom(dark)
  await expect(line(dark, MH)).toHaveAttribute('data-state', 'opened', { timeout: 15000 })
  await expect(stateOf(dark, MH)).toHaveText('열어 봄 · 방금')
  await expect(stateOf(dark, J1)).toHaveText('열어 봄 · 방금')
  await expect(stateOf(dark, J2)).toHaveText('안 열어 봄')
  await expect(nameOf(dark, J1)).toHaveText('한지우 · mail-b.test')
  await expect(nameOf(dark, J2)).toHaveText('한지우 · corp-a.test')
  expect(await noOverflow(dark)).toBe(true)
  // every line inside the screen
  for (const who of [J1, J2, MH]) { const b = await line(dark, who).boundingBox(); expect(b.x).toBeGreaterThanOrEqual(0); expect(b.x + b.width).toBeLessThanOrEqual(390) }
  await toCard(dark)
  await shot(dark, 'f-so-02-sender-two-opened-dark')
  expect(dark.errors).toEqual([])
  await dark.context().close()
})

test('F-SO-03 영어 화면 — Opened · just now / Not opened, 이름의 주소 표시는 그대로', async ({ browser }) => {
  const en = await page(browser, DY, { lang: 'en' })
  await openRoom(en)
  await expect(stateOf(en, J1)).toHaveText('Opened · just now', { timeout: 15000 })
  await expect(stateOf(en, J2)).toHaveText('Not opened')
  await expect(nameOf(en, J2)).toHaveText('한지우 · corp-a.test')
  await toCard(en)
  await shot(en, 'f-so-03-sender-english')
  expect(en.errors).toEqual([])
  await en.context().close()
})

test('F-SO-04 방을 연 채 새 공유를 보내면 그 메시지만 묻는다', async ({ browser }) => {
  const p = sender || await page(browser, DY)
  if (!sender) await openRoom(p)
  await expect(line(p, J1)).toBeVisible({ timeout: 15000 })
  const asked = []
  p.on('request', (r) => { if (r.url().includes('/receipts?')) asked.push(new URL(r.url()).searchParams.get('ids')) })
  const card = await rawPost(DY.token, '/team/uploads', picture(), { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent('두 번째 화면.png'), 'X-File-Type': 'image/png' })
  const second = (await S.api(DY.token, `/team/threads/${room}/messages`, { method: 'POST', body: { text: '이것도 봐 주세요', artifactIds: [card.id] } })).id
  const fresh = p.locator(`.ms [data-id="${second}"] [data-test="share-receipt"][data-person="${MH.id}"] [data-test="receipt-state"]`)
  await expect(fresh).toHaveText('안 열어 봄', { timeout: 15000 })
  expect(asked, '새 메시지만 묻는다').toEqual([second])
  // the first card is still as it was (not asked again, not emptied)
  await expect(stateOf(p, J1)).toHaveText('열어 봄 · 방금')
  expect(p.errors).toEqual([])
  await p.context().close()
})
