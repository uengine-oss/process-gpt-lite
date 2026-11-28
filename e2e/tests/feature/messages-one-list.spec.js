// 받은 편지함 = 대화의 거르개 — 1단계: 화면 하나 · 말풍선 하나 · 읽음 하나 (스펙 openspec/specs/messenger-one-list). 2026-11-28 사용자(홈 › 메시지의
// 「받은 편지함」 · 「대화」 두 탭 사진): 「그리고 이 두 대화창이 같은건데... 어떻게 통일할 방법이 없을까? 지금 공유기능 또한 이 두 채널에 따로 구현된
// 상태임. 방안을 고려해보자」 → 사용자 선택 「편지함 = 대화의 거르개 (권장)」. 사진 속 사람은 쓰지 않는다 — 지어낸 사람: 정하윤(보는 사람) ·
// 김서연 · 박도윤, 방 「가나정밀 견적」(셋) · 김서연과의 1:1.
//   F-OL-01 휴대폰 390 밝음: 탭 대신 칩 넷(전체 · 나에게 온 것 · 안 읽음 · 메일), 「받은 편지함」은 없음, 수는 「안 읽음」에 한 번. 나에게 온 것의 항목은
//           방 말풍선과 같은 것(파일 칩 · 「이어서 작업」 · AI 답 카드 · 질문 양식 · 반응) + 「어느 방 · 누가」, 「답장」 · 「편집기에서 열기」 없음,
//           「이어서 작업」은 받은 공유 · 멘션에만. 「어느 방」을 누르면 그 방의 그 메시지(같은 글)
//   F-OL-02 휴대폰 390 어둠: 읽음이 한 번에 — 그 방의 가장 오래된 안 읽은 항목부터 모두 보이면 그 메시지까지 읽음(뒤의 메시지는 안 읽음 그대로), 배지 · 방의 수 · 홈 카드가 함께,
//           항목을 열면 그 방은 전부 읽음, 홈에서 그 공유 카드가 사라짐
//   F-OL-03 휴대폰 390 밝음: 홈 카드(team 알림)를 닫으면 그 방을 그 메시지까지 읽음 — 나에게 온 것의 그 항목도 읽음, 뒤의 메시지는 안 읽음
//   F-OL-04 1280 밝음: 나에게 온 것은 왼쪽 목록, 새 메시지는 바로 끼워짐(공유 · 멘션이 아닌 「AI 답 공유」도), 항목에서 단 반응이 방 말풍선에도,
//           「어느 방」을 누르면 오른쪽에 그 방의 그 메시지
//   F-OL-05 1280 어둠: 메일 칩 — 내 메일 카드(Home 에서 닫은 것도) · 누르면 그 메일 시트
//   F-OL-06 390 밝음: 목록보다 큰 항목도 목록 높이의 대부분이 보이면 본 것 (PR #127 검토)
//   (PR #127 검토) F-OL-02 는 가장 새 항목만 보여서는 그 방을 읽지 않음 — 아래의 더 오래된 항목까지 보아야
// 자기 스택(lib/localStack.js — 회사 one-list-ui, BFF 8993 · Vite 5393, `RT_OL_API_PORT` · `RT_OL_WEB_PORT`; 다른 것이 듣고 있으면 멈춤)을
// 띄우고 지운다. 모델 · deepagents 는 부르지 않는다.
//   cd e2e && RT_WORKERS=1 npx playwright test --project=feature tests/feature/messages-one-list.spec.js
import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { startStack, REPO, SERVER } from '../../lib/localStack.js'

test.describe.configure({ mode: 'serial' })
const SHOTS = path.join(REPO, 'openspec/specs/messenger-one-list/e2e/results')
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ko-KR' }
const DESK = { viewport: { width: 1280, height: 860 }, locale: 'ko-KR' }
const NOWHERE = 'http://127.0.0.1:9'
const TENANT = 'one-list-ui'
const API_PORT = Number(process.env.RT_OL_API_PORT) || 8993
const WEB_PORT = Number(process.env.RT_OL_WEB_PORT) || 5393
const ROOM = '가나정밀 견적'
const FILE = '견적서_가나정밀.md'
let S, A, B, C, DM, GROUP
const id = {} // the seeded messages

async function rawPost(token, p, buf, headers) {
  const r = await fetch(`http://127.0.0.1:${S.apiPort}/api${p}`, { method: 'POST', body: buf, headers: { Authorization: `Bearer ${token}`, ...headers } })
  const t = await r.text()
  if (!r.ok) throw new Error(`POST ${p} → ${r.status} ${t.slice(0, 200)}`)
  return JSON.parse(t)
}
const post = (who, room, body) => S.api(who.token, `/team/threads/${room}/messages`, { method: 'POST', body })
const pause = (ms = 40) => new Promise((ok) => setTimeout(ok, ms))
// an AI answer of someone's chat shared into a room (lib/answerShare.js — the real route: it comes live)
async function shareAnswer(who, room, title, text, note) {
  const [main] = await S.api(who.token, '/threads')
  const [row] = await S.q(`insert into pro_messages(thread_id,role,kind,content) values ($1,'agent','text',$2) returning id`, [main.id, { text: `# ${title}\n\n${text}`, context: { title } }])
  return (await S.api(who.token, `/messages/${row.id}/share/room`, { method: 'POST', body: { room, note } })).message
}
// a request the AI sent for 김서연 (lib/askTeammate.js — kind 'askteam' with its form), written as the server writes it
async function askRow(room, from, to) {
  const { buildSurface } = await import(path.join(SERVER, 'lib/askTeammate.js'))
  const card = crypto.randomUUID(), uuid = crypto.randomUUID()
  const fields = [{ key: 'phone', label: '연락처' }, { key: 'birth', label: '생년월일' }]
  const surface = buildSurface({ id: card, reason: '교육 참석자 명단에 연락처가 비어 있어요', fields, words: { note: '덧붙일 말 (선택)', notePlaceholder: '', send: '보내기', unknown: '잘 모르겠어요', needOne: '하나 이상 채워 주세요.' } })
  const ask = { card, owner: from.id, ownerName: from.name, member: to.id, memberName: to.name, fields, surface, state: 'asked', askedAt: new Date().toISOString() }
  const msg = { uuid, clientUuid: uuid, role: 'user', content: '정하윤님 연락처를 알려 주실 수 있을까요?', timeStamp: new Date().toISOString(), email: from.email, name: from.name, userName: from.name, userId: from.id,
    pgpt: { kind: 'askteam', artifacts: [], context: null, ask } }
  await S.q('insert into chats(uuid, id, messages, tenant_id) values ($1,$2,$3,$4)', [uuid, room, msg, TENANT])
  return uuid
}

test.beforeAll(async () => {
  test.setTimeout(240_000)
  fs.mkdirSync(SHOTS, { recursive: true })
  S = await startStack({ tenant: TENANT, apiFrom: API_PORT, webFrom: WEB_PORT,
    env: { PRO_DEEPAGENTS_URL: NOWHERE, PRO_COMPLETION_URL: NOWHERE, PRO_CONTEXT_ROUTER_URL: NOWHERE, PRO_JUDGE_URL: '' } })
  // (only on its own ports: another work's server on the next one is not this stack's)
  if (S.apiPort !== API_PORT || S.webPort !== WEB_PORT) { const got = `${S.apiPort} · ${S.webPort}`; await S.stop(); S = null; throw new Error(`the stack is not on ${API_PORT} · ${WEB_PORT} (${got})`) }
  A = await S.person(`pro-rt-${TENANT}-a@uengine.org`, '정하윤')
  B = await S.person(`pro-rt-${TENANT}-b@uengine.org`, '김서연')
  C = await S.person(`pro-rt-${TENANT}-c@uengine.org`, '박도윤')
  for (const p of [A, B, C]) { await S.join(p); await S.api(p.token, '/team'); await S.api(p.token, '/me/lang', { method: 'PUT', body: { lang: 'ko' } }) }
  await cleanData()
  DM = (await S.api(B.token, '/team/threads', { method: 'POST', body: { members: [A.id] } })).id
  GROUP = (await S.api(B.token, '/team/threads', { method: 'POST', body: { members: [A.id, C.id], title: ROOM } })).id
  // oldest first: 박도윤's shared AI answer · 김서연's question (AI asking for her) · a plain line · 김서연's file · 박도윤's line after it
  id.answer = await shareAnswer(C, GROUP, '가나정밀 납기 정리', '- 1차 납품: 12월 9일\n- 2차 납품: 12월 23일', '납기 정리해 봤어요')
  await pause()
  id.ask = await askRow(DM, B, A)
  await pause()
  id.line = (await post(B, DM, { text: '참고로 오늘 회의는 3시예요' })).id
  await pause()
  const card = await rawPost(B.token, '/team/uploads', Buffer.from('# 가나정밀 견적서\n\n| 품목 | 수량 |\n|---|---|\n| 브래킷 | 1,200 |\n'), { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(FILE), 'X-File-Type': 'text/markdown' })
  id.share = (await post(B, GROUP, { text: '견적서 초안이에요', artifactIds: [card.id] })).id
  await pause()
  id.after = (await post(C, GROUP, { text: '확인했어요' })).id
  // 김서연 likes 박도윤's answer: the item shows the room's chips
  await S.api(B.token, `/team/messages/${id.answer}/reactions`, { method: 'POST', body: { key: 'like', on: true } }).catch(() => null)
})

async function cleanData() {
  const people = [A, B, C].filter(Boolean).map((p) => p.id)
  for (const sql of ['delete from pro_shares where tenant_id=$1', 'delete from pro_chat_reactions where tenant_id=$1', 'delete from chats where tenant_id=$1',
    'delete from pro_chat_reads where room_id in (select id from chat_rooms where tenant_id=$1)', 'delete from chat_rooms where tenant_id=$1']) await S.q(sql, [TENANT]).catch(() => {})
  await S.q('delete from notifications where user_id::text = any($1::text[])', [people]).catch(() => {})
  await S.q('delete from pro_actions where user_id = any($1::uuid[])', [people]).catch(() => {})
  await S.q('delete from pro_demo_mail where user_id = any($1::uuid[])', [people]).catch(() => {})
  await S.q('delete from pro_mail_accounts where user_id = any($1::uuid[])', [people]).catch(() => {})
  await S.q('delete from pro_messages where thread_id in (select id from pro_threads where user_id = any($1::uuid[]))', [people]).catch(() => {})
  await S.q(`delete from pro_threads where user_id = any($1::uuid[]) and kind <> 'chat'`, [people]).catch(() => {})
}
test.afterAll(async () => { if (S) { await cleanData().catch(() => {}); await S.stop() } })

async function page(browser, who, { theme = 'light', opts = PHONE } = {}) {
  const ctx = await browser.newContext({ ...opts, baseURL: S.web })
  await ctx.addInitScript(([s, th]) => {
    if (window.top !== window) return
    localStorage.setItem('pgpt-pro-session', s)
    localStorage.setItem('pgpt-pro-theme', th)
    localStorage.setItem('pgl-lang', 'ko')
    localStorage.setItem('pgl-install', JSON.stringify({ never: true }))
    try { localStorage.removeItem('pgl-messenger-dock') } catch { /* none */ }
  }, [JSON.stringify(who.session), theme])
  const p = await ctx.newPage()
  p.errors = []
  p.on('pageerror', (e) => p.errors.push(String(e?.message || e)))
  return p
}
const calm = (p) => p.evaluate(() => Promise.race([Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming?.().iterations !== Infinity).map((a) => a.finished.catch(() => {}))), new Promise((ok) => setTimeout(ok, 1500))]))
const shot = async (p, name) => { await calm(p); await p.waitForTimeout(250); await p.screenshot({ path: path.join(SHOTS, `${name}.png`) }) }
const noOverflow = (p) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
async function home(p) {
  await p.goto('/chat')
  await p.locator('.seg button').filter({ hasText: /^(홈|Home)$/ }).click()
}
async function openMessenger(p, { phone = true } = {}) {
  if (phone) { await home(p); await p.locator('button.msgs').click() } else { await p.goto('/chat'); await p.locator('button.msg-btn').click() }
  await p.locator('.ms').waitFor()
}
const chip = (p, c) => p.locator(`[data-test="msg-chip-${c}"]`)
const item = (p, mid) => p.locator(`.ms [data-test="forme-item"][data-forme="${mid}"]`)
const unread = async (who) => (await S.api(who.token, '/team/unread'))
const noticeOf = async (who, mid, room) => (await S.q(`select coalesce(is_checked,false) as checked from notifications where user_id=$1 and type='team' and url=$2`, [who.id, `/pro/team/${room}/${mid}`]))[0]
// back to nothing read for 정하윤 (the rooms and their Home cards), as the seeds left it
async function unreadAll(who) {
  await S.q('delete from pro_chat_reads where user_id=$1 and room_id = any($2::text[])', [who.id, [DM, GROUP]])
  await S.q(`update notifications set is_checked=false where user_id::text = $1 and type='team'`, [who.id])
}

test('F-OL-01 휴대폰 390 밝음 — 칩 넷 · 수는 한 번, 나에게 온 것의 항목은 방 말풍선 그대로 + 「어느 방 · 누가」, 누르면 그 방의 그 메시지', async ({ browser }) => {
  const p = await page(browser, A)
  await openMessenger(p)
  const total = (await unread(A)).total
  expect(total).toBe(5)
  // one list with its chips — no 「받은 편지함」, the count once (on 안 읽음)
  await expect(p.locator('[data-test="msg-chips"] button')).toHaveText(['전체', '나에게 온 것', `안 읽음${total}`, '메일'])
  await expect(p.locator('.ms')).not.toContainText('받은 편지함')
  await expect(chip(p, 'all')).toHaveAttribute('aria-selected', 'true')
  await expect(p.locator('[data-test="msg-unread-count"]')).toHaveCount(1)
  await expect(p.locator('[data-test="msg-forme-dot"]')).toHaveCount(1)
  await expect(p.locator('.ms .th')).toHaveCount(2)
  await expect(p.locator('.ms .th').filter({ hasText: ROOM }).locator('.badge')).toHaveText('3')
  expect(await noOverflow(p)).toBe(true)
  await shot(p, 'f-ol-01a-chips-all-light')
  // 안 읽음: the rooms with something unread
  await chip(p, 'unread').click()
  await expect(p.locator('.ms .th')).toHaveCount(2)

  // 나에게 온 것: newest first — the file, the question, the answer (the plain lines are not in it)
  await chip(p, 'forme').click()
  const items = p.locator('.ms [data-test="forme-item"]')
  await expect(items).toHaveCount(3)
  expect(await items.evaluateAll((l) => l.map((e) => e.dataset.forme))).toEqual([id.share, id.ask, id.answer])
  // where each is: the room · who (a 1:1 room is its person: said once)
  await expect(item(p, id.share).locator('[data-test="forme-open"]')).toHaveText(`${ROOM} · 김서연›`)
  await expect(item(p, id.ask).locator('[data-test="forme-open"]')).toHaveText('김서연›')
  await expect(item(p, id.answer).locator('[data-test="forme-open"]')).toHaveText(`${ROOM} · 박도윤›`)
  // the room's own bubble: the file chip, 「이어서 작업」 (a received share), the AI answer card with the room's reactions, the question's form
  const share = item(p, id.share)
  await expect(share.locator(`[data-test="msg-file"][data-file="${FILE}"]`)).toBeVisible()
  await expect(share.locator('[data-test="msg-continue"]')).toHaveText('이어서 작업')
  await expect(share.getByRole('button', { name: /^(답장|편집기에서 열기|열어 보기)$/ })).toHaveCount(0)
  // 폴더에 정리 waits to be pressed here: scrolling past a file asks no model (PR #127 review)
  await expect(share.locator('[data-test="folder-suggest"]')).toHaveCount(0)
  await expect(share.locator('[data-test="forme-filing"]')).toBeVisible()
  const ans = item(p, id.answer)
  await expect(ans.locator('[data-test="msg-answer"]')).toContainText('가나정밀 납기 정리')
  await expect(ans.locator('[data-test="rx-chip"][data-key="like"]')).toHaveAttribute('data-count', '1')
  await expect(ans.locator('[data-test="msg-continue"]'), '「이어서 작업」은 받은 공유 · 멘션에만').toHaveCount(0)
  const ask = item(p, id.ask)
  await expect(ask.locator('[data-testid="ask-team-form"]')).toHaveAttribute('data-for-me', '1')
  await expect(ask.locator('[data-testid="ask-team-form"]')).toContainText('연락처')
  await expect(ask.locator('[data-test="msg-continue"]')).toHaveCount(0)
  expect(await noOverflow(p)).toBe(true)
  for (const mid of [id.share, id.ask, id.answer]) { const b = await item(p, mid).boundingBox(); expect(b.x).toBeGreaterThanOrEqual(0); expect(b.x + b.width).toBeLessThanOrEqual(390.5) }
  await p.locator('[data-test="forme-list"]').evaluate((el) => { el.scrollTop = 0 })
  await shot(p, 'f-ol-01b-forme-light')
  await ask.scrollIntoViewIfNeeded()
  await shot(p, 'f-ol-01c-forme-ask-answer-light')

  // the same bubble in the room: 「어느 방」 opens it at that message — its line, words, files and 「이어서 작업」 alike
  const shape = (bubble) => bubble.evaluate((b) => ({ kind: b.querySelector('.kind')?.innerText, text: b.querySelector('[data-test="msg-text"]')?.innerText,
    files: [...b.querySelectorAll('[data-test="msg-file"]')].map((f) => f.dataset.file), cont: !!b.querySelector('[data-test="msg-continue"]'), avatar: !!b.parentElement.querySelector(':scope > [data-test="person-avatar"]') }))
  const there = await shape(share.locator('[data-test="msg-bubble"]'))
  expect(there).toMatchObject({ kind: '김서연 · 공유', text: '견적서 초안이에요', files: [FILE], cont: true })
  await share.locator('[data-test="forme-open"]').click()
  const inRoom = p.locator(`.ms .pane [data-id="${id.share}"]`)
  await expect(inRoom).toBeVisible()
  await expect(p.locator('.ms .thd b')).toHaveText(ROOM)
  expect(await shape(inRoom.locator('[data-test="msg-bubble"]'))).toEqual(there)
  await shot(p, 'f-ol-01d-room-at-message-light')
  // back: still 나에게 온 것
  await p.locator('.ms .thd .back').click()
  await expect(chip(p, 'forme')).toHaveAttribute('aria-selected', 'true')
  // pressed: the same 폴더에 정리 as in the room
  await item(p, id.share).locator('[data-test="forme-filing"]').click()
  await expect(item(p, id.share).locator('[data-test="folder-suggest"]')).toBeVisible()
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-OL-02 휴대폰 390 어둠 — 읽음이 한 번에: 그 방의 가장 오래된 안 읽은 항목부터 모두 보아야 그 메시지까지(아래의 안 본 것 · 뒤는 그대로), 배지 · 방 · 홈 카드가 함께, 열면 그 방 전부', async ({ browser }) => {
  await unreadAll(A)
  const p = await page(browser, A, { theme: 'dark' })
  await home(p)
  // Home: the share's card (김서연 shared the file)
  const card = p.locator('[data-test="notice-card"]').filter({ hasText: FILE })
  await expect(card).toBeVisible({ timeout: 15000 })
  await p.locator('button.msgs').click()
  await p.locator('.ms').waitFor()
  await expect(p.locator('[data-test="msg-unread-count"]')).toHaveText('5')
  await chip(p, 'forme').click()
  await expect(item(p, id.share)).toHaveAttribute('data-unread', 'true')
  await shot(p, 'f-ol-02a-forme-unread-dark')
  // the newest of 「가나정밀 견적」 is on screen, its older answer (below the tall question) is not: nothing of that room is read yet
  // (PR #127 review — the older item and its Home card were cleared unseen)
  await expect(item(p, id.answer)).not.toBeInViewport()
  await p.waitForTimeout(2600)
  await expect(item(p, id.share)).toHaveAttribute('data-unread', 'true')
  await expect(item(p, id.answer)).toHaveAttribute('data-unread', 'true')
  expect((await unread(A)).byThread[GROUP]).toBe(3)
  expect((await noticeOf(A, id.share, GROUP))?.checked).toBe(false)
  await expect(card).toHaveCount(1)
  // the answer scrolled into view a moment: now every unread item of the room up to the share has been seen — read up to it, the line
  // after it stays unread
  await item(p, id.answer).scrollIntoViewIfNeeded()
  await expect(item(p, id.answer)).toHaveAttribute('data-unread', 'false', { timeout: 8000 })
  await expect(item(p, id.share)).toHaveAttribute('data-unread', 'false')
  await expect.poll(async () => (await unread(A)).byThread[GROUP] || 0, { timeout: 8000 }).toBe(1)
  await expect.poll(async () => (await noticeOf(A, id.share, GROUP))?.checked, { timeout: 8000 }).toBe(true)
  // the badge says the rooms' own count
  const now = (await unread(A)).total
  expect(now).toBeLessThan(5)
  await expect(p.locator('[data-test="msg-unread-count"]')).toHaveText(String(now))
  expect(await noOverflow(p)).toBe(true)
  await shot(p, 'f-ol-02b-forme-read-dark')
  await p.locator('[data-test="forme-list"]').evaluate((el) => { el.scrollTop = 0 })
  // opened: the room at that message — read whole
  await item(p, id.share).locator('[data-test="forme-open"]').click()
  await expect(p.locator(`.ms .pane [data-id="${id.share}"]`)).toBeVisible()
  await expect.poll(async () => (await unread(A)).byThread[GROUP] || 0, { timeout: 8000 }).toBe(0)
  await shot(p, 'f-ol-02c-room-dark')
  await p.locator('.ms .thd .back').click()
  const left = (await unread(A)).total
  await expect(p.locator('[data-test="msg-unread-count"]')).toHaveText(String(left))
  await expect(p.locator('.ms .th')).toHaveCount(0)
  await chip(p, 'unread').click()
  await expect(p.locator('.ms .th').filter({ hasText: ROOM })).toHaveCount(0)
  // Home: the share's card is gone with it
  await p.locator('[data-test="msg-close"]').click()
  await expect(card).toHaveCount(0)
  await shot(p, 'f-ol-02d-home-dark')
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-OL-03 휴대폰 390 밝음 — 홈 카드를 닫으면 그 방을 그 메시지까지 읽는다', async ({ browser }) => {
  await S.api(A.token, `/team/threads/${DM}/read`, { method: 'POST' })
  // 김서연 asks from her chat (kind mention: a Home card for 정하윤), then a line after it
  await S.api(B.token, '/team/mention', { method: 'POST', body: { to: [{ type: 'user', id: A.id }], text: '계약서 검토 부탁해요', conversation: { title: '가나정밀 계약' } } })
  const [m] = (await S.api(A.token, '/team/inbox')).filter((x) => x.body === '계약서 검토 부탁해요')
  id.mention = m.id
  await pause()
  await post(B, DM, { text: '급하지 않아요' })
  expect((await unread(A)).byThread[DM]).toBe(2)
  const p = await page(browser, A)
  await home(p)
  const card = p.locator('[data-test="notice-card"]').filter({ hasText: '나를 언급했어요' })
  await expect(card).toBeVisible({ timeout: 15000 })
  await shot(p, 'f-ol-03a-home-card-light')
  await card.locator('[data-test="notice-close"]').click()
  await expect(card).toHaveCount(0)
  await expect.poll(async () => (await unread(A)).byThread[DM] || 0, { timeout: 8000 }).toBe(1)
  expect((await S.api(A.token, '/team/inbox')).find((x) => x.id === id.mention).unread).toBe(false)
  // the messenger agrees: the item read, the count the rooms'
  await p.locator('button.msgs').click()
  await chip(p, 'forme').click()
  await expect(item(p, id.mention)).toHaveAttribute('data-unread', 'false')
  await expect(p.locator('[data-test="msg-unread-count"]')).toHaveText(String((await unread(A)).total))
  await shot(p, 'f-ol-03b-forme-after-home-light')
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-OL-04 1280 밝음 — 왼쪽 목록에 새 메시지가 바로(AI 답 공유도), 항목에서 단 반응이 방에도, 「어느 방」은 오른쪽에 그 메시지', async ({ browser }) => {
  const p = await page(browser, A, { opts: DESK })
  await openMessenger(p, { phone: false })
  await chip(p, 'forme').click()
  await expect(p.locator('.ms [data-test="forme-item"]').first()).toBeVisible()
  await expect(p.locator('.ms .blank')).toContainText('대화 이름을 누르면')
  // a new answer shared in the room comes in at once (not a share or a mention: any kind of 나에게 온 것)
  const fresh = await shareAnswer(C, GROUP, '출장 일정 정리', '- 12월 4일 창원 공장 방문', '출장 일정이에요')
  await expect(p.locator('.ms [data-test="forme-item"]').first()).toHaveAttribute('data-forme', fresh, { timeout: 8000 })
  await expect(item(p, fresh).locator('[data-test="msg-answer"]')).toContainText('출장 일정 정리')
  // a reaction from the item: the bar over it, the chip under it — and the same chip in the room
  const bub = item(p, fresh).locator('[data-test="msg-bubble"]')
  await bub.hover()
  await item(p, fresh).locator('[data-test="rx-open"]').click()
  await expect(p.locator('[data-test="rx-bar"]')).toBeVisible()
  await shot(p, 'f-ol-04a-desktop-forme-reaction-light')
  await p.locator('[data-test="rx-bar"] [data-test="rx-pick"][data-key="check"]').click()
  await expect(item(p, fresh).locator('[data-test="rx-chip"][data-key="check"]')).toHaveAttribute('aria-pressed', 'true')
  await item(p, fresh).locator('[data-test="forme-open"]').click()
  const inRoom = p.locator(`.ms .pane [data-id="${fresh}"]`)
  await expect(inRoom).toBeVisible()
  // (both lists side by side: the item on the left, the room on the right)
  await expect(item(p, fresh)).toBeVisible()
  await expect(p.locator(`.ms .pane [data-test="rx-chips"][data-for="${fresh}"] [data-test="rx-chip"][data-key="check"]`)).toHaveAttribute('aria-pressed', 'true')
  expect((await S.q('select count(*)::int n from pro_chat_reactions where chat_uuid=$1 and user_id=$2', [fresh, A.id]))[0].n).toBe(1)
  await shot(p, 'f-ol-04b-desktop-room-light')
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-OL-05 1280 어둠 — 메일 칩: 내 메일 카드(Home 에서 닫은 것도), 누르면 그 메일', async ({ browser }) => {
  const mailId = `demo-ol-${crypto.randomUUID().slice(0, 8)}`
  await S.q(`insert into pro_mail_accounts(user_id, provider, address) values ($1,'demo',$2) on conflict (user_id) do update set provider='demo'`, [A.id, A.email])
  await S.q('insert into pro_demo_mail(user_id, mail_id, sender, subject, body) values ($1,$2,$3,$4,$5)', [A.id, mailId, '이준호 <junho@gana-precision.example>', '견적 요청드립니다', '브래킷 1,200개 견적을 부탁드립니다.'])
  await S.q(`insert into pro_actions(user_id, verb, text, prompt, source, status) values ($1,'Reply','견적 요청 회신','견적을 회신하세요.',$2,'dismissed')`,
    [A.id, { mail_id: mailId, from: '이준호 <junho@gana-precision.example>', subject: '견적 요청드립니다' }])
  const p = await page(browser, A, { theme: 'dark', opts: DESK })
  await openMessenger(p, { phone: false })
  await chip(p, 'mail').click()
  const mail = p.locator('[data-test="msg-mail-card"]').filter({ hasText: '견적 요청 회신' })
  await expect(mail).toContainText('홈에서 닫음')
  await expect(mail).toContainText('이준호')
  await shot(p, 'f-ol-05a-mail-chip-dark')
  await mail.click()
  await expect(p.locator('[data-test="mail-sheet"]')).toBeVisible()
  await expect(p.locator('[data-test="mail-text"]')).toContainText('브래킷 1,200개')
  await shot(p, 'f-ol-05b-mail-sheet-dark')
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-OL-06 휴대폰 390 밝음 — 목록보다 큰 항목도 목록의 대부분을 채우면 본 것(그 방은 그 메시지까지)', async ({ browser }) => {
  // 박도윤 asks from his chat with a long excerpt of lines (a mention taller than the phone's list)
  const long = Array.from({ length: 70 }, (_, i) => `${i + 1}. 납품 일정 확인 항목 — 가나정밀 ${i + 1}차`).join('\n')
  await S.api(C.token, '/team/mention', { method: 'POST', body: { to: [{ type: 'user', id: A.id }], text: long, conversation: { title: '납품 일정' } } })
  const [m] = (await S.api(A.token, '/team/inbox')).filter((x) => x.body === long)
  id.tall = m.id
  const p = await page(browser, A)
  await openMessenger(p)
  await chip(p, 'forme').click()
  const tall = item(p, id.tall)
  await expect(tall).toHaveAttribute('data-unread', 'true')
  const [ih, lh] = await Promise.all([tall.evaluate((el) => el.getBoundingClientRect().height), p.locator('[data-test="forme-list"]').evaluate((el) => el.clientHeight)])
  expect(ih, 'the item is taller than ~1.7 lists').toBeGreaterThan(1.7 * lh)
  await expect(tall).toHaveAttribute('data-unread', 'false', { timeout: 8000 })
  await expect.poll(async () => (await unread(A)).byThread[m.threadId] || 0, { timeout: 8000 }).toBe(0)
  await shot(p, 'f-ol-06-tall-item-light')
  expect(p.errors).toEqual([])
  await p.context().close()
})
