// 단체방에 사람 초대(2026-11-25 사용자 「기존 단체 메신저 대화창에서 신규인원 초대가 가능해야.」, 스펙 openspec/specs/messenger-dock
// 「단체방에 팀원을 초대하고, 1:1 대화에서는 단체방을 만든다」). 지어낸 사람: 정하윤(방을 연 사람) · 김서연 · 박도윤(방의 사람) · 최도현(초대받는 팀원).
//   F-MS-03 단체방의 「초대」 → 방에 없는 팀원만 · 찾기 · 고르고 초대 → 시스템 줄, 방 머리에 새 사람 — 열어 둔 김서연의 화면은 새로 고치지 않아도,
//           최도현의 메신저에는 그 방이 지난 메시지와 함께
//   F-MS-04 1:1 대화에는 「초대」 대신 「단체방 만들기」 → 두 사람과 고른 사람의 새 단체방, 1:1 은 그대로 둘
//   F-MS-05 휴대폰 390px 밝은 · 밤: 머리의 + · 고르는 창 · 시스템 줄이 화면 안, 옆으로 넘치지 않음
//   F-MS-06 같은 이름의 두 사람(한 사람의 회사 계정과 다른 주소의 계정 — 운영 11-25): 대화 목록 · 새 대화 상대 · 방 머리에서 「윤가람 · uengine.org」 ·
//           「윤가람 · people-mail.test」로 갈리고, 혼자인 이름은 그대로(src/sameNames.js)
// 자기 스택(lib/localStack.js — 회사 room-invite, RT_API_FROM · RT_WEB_FROM 부터 빈 포트, 기본 8955 · 5355)을 띄우고 지운다. 모델은 부르지 않는다.
//   cd e2e && npx playwright test --project=feature tests/feature/room-invite.spec.js
import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { startStack, REPO } from '../../lib/localStack.js'

test.describe.configure({ mode: 'serial' })
const SHOTS = path.join(REPO, 'openspec/specs/messenger-dock/e2e/results')
const DESK = { viewport: { width: 1280, height: 860 }, locale: 'ko-KR' }
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ko-KR' }
const NOWHERE = 'http://127.0.0.1:9'
const TENANT = 'room-invite'
let S, HY, SY, DY, DH
// F-MS-06's two of the same name: on the team only during that test (F-MS-03 · 04 count who can be invited)
const TWINS = [`pro-rt-${TENANT}-e@uengine.org`, `pro-rt-${TENANT}-f@people-mail.test`]

test.beforeAll(async () => {
  test.setTimeout(240_000)
  fs.mkdirSync(SHOTS, { recursive: true })
  S = await startStack({ tenant: TENANT, apiFrom: Number(process.env.RT_API_FROM) || 8955, webFrom: Number(process.env.RT_WEB_FROM) || 5355,
    env: { PRO_DEEPAGENTS_URL: NOWHERE, PRO_COMPLETION_URL: NOWHERE, PRO_CONTEXT_ROUTER_URL: NOWHERE, PRO_JUDGE_URL: '' } })
  HY = await S.person(`pro-rt-${TENANT}-a@uengine.org`, '정하윤')
  SY = await S.person(`pro-rt-${TENANT}-b@uengine.org`, '김서연')
  DY = await S.person(`pro-rt-${TENANT}-c@uengine.org`, '박도윤')
  DH = await S.person(`pro-rt-${TENANT}-d@uengine.org`, '최도현')
  for (const p of [HY, SY, DY, DH]) await S.join(p)
  await cleanRooms()
})
async function cleanRooms() {
  await S.q('delete from pro_team_members where tenant_id=$1 and user_id in (select id from users where tenant_id=$1 and email = any($2))', [TENANT, TWINS]).catch(() => {})
  for (const sql of ['delete from chats where tenant_id=$1', 'delete from pro_chat_reads where room_id in (select id from chat_rooms where tenant_id=$1)',
    `delete from notifications where tenant_id=$1 and type in ('team','chat')`, 'delete from chat_rooms where tenant_id=$1']) await S.q(sql, [TENANT]).catch(() => {})
}
test.afterAll(async () => { if (S) { await cleanRooms().catch(() => {}); await S.stop() } })

async function page(browser, who, opts, { theme = 'light' } = {}) {
  const ctx = await browser.newContext({ ...opts, baseURL: S.web })
  await ctx.addInitScript(([s, th]) => {
    if (window.top !== window) return
    localStorage.setItem('pgpt-pro-session', s)
    localStorage.setItem('pgpt-pro-theme', th)
    try { localStorage.removeItem('pgl-messenger-dock') } catch { /* none */ }
  }, [JSON.stringify(who.session), theme])
  const p = await ctx.newPage()
  p.errors = []
  p.on('pageerror', (e) => p.errors.push(String(e?.message || e)))
  return p
}
const shot = async (p, name) => { await p.waitForTimeout(400); await p.screenshot({ path: path.join(SHOTS, `${name}.png`) }) }
const noOverflow = (p) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
async function openRoom(p, title, { phone = false } = {}) {
  await p.goto('/chat')
  if (phone) {
    await p.locator('.seg button').filter({ hasText: '홈' }).click()
    await p.locator('button.msgs').click()
  } else await p.locator('button.msg-btn').click()
  await p.locator('.ms').waitFor()
  await p.locator('[data-test="msg-chip-all"]').click()
  await p.locator('.ms .th').filter({ has: p.locator('.nm b', { hasText: new RegExp(`^${title}$`) }) }).click()
  await p.locator('.ms .cmp textarea').waitFor()
}
const members = (p) => p.locator('[data-test="msg-thread-members"]')
const picker = (p) => p.locator('[data-test="room-invite-sheet"]')
const say = (who, room, text) => S.api(who.token, `/team/threads/${room}/messages`, { method: 'POST', body: { text } })

test('F-MS-03 단체방의 「초대」 — 시스템 줄과 새 사람이 열어 둔 화면에 바로, 초대받은 사람은 지난 메시지까지', async ({ browser }) => {
  const { id } = await S.api(HY.token, '/team/threads', { method: 'POST', body: { members: [SY.id, DY.id] } })
  await say(SY, id, '견적 세 곳 비교해 볼까요?')
  await say(HY, id, '좋아요, 표로 정리할게요.')
  // 김서연 has the room open: it changes in front of her
  const y = await page(browser, SY, DESK)
  await openRoom(y, '정하윤, 박도윤')
  await expect(members(y)).toHaveText('정하윤, 김서연, 박도윤')
  const p = await page(browser, HY, DESK)
  await openRoom(p, '김서연, 박도윤')
  await expect(p.locator('[data-test="room-make-group"]')).toHaveCount(0)
  await p.locator('[data-test="room-invite"]').click()
  const sheet = picker(p)
  await expect(sheet).toBeVisible()
  // the company's teammates not yet in the room, each with a face
  const rows = sheet.locator('[data-test="people-row"]')
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toHaveAttribute('data-person', DH.id)
  await expect(rows.first().locator('[data-test="person-avatar"]')).toHaveText('최')
  await sheet.locator('[data-test="people-find"]').fill('없는사람')
  await expect(rows).toHaveCount(0)
  await expect(sheet).toContainText('맞는 팀원이 없어요.')
  await sheet.locator('[data-test="people-find"]').fill('최')
  await rows.first().click()
  await shot(p, 'f-ms-03a-invite-picker')
  await sheet.locator('[data-test="people-confirm"]').click()
  await expect(sheet).toHaveCount(0)
  const line = '정하윤님이 최도현님을 초대했어요'
  await expect(p.locator('[data-test="msg-invite"]')).toHaveText(line)
  await expect(members(p)).toHaveText('정하윤, 김서연, 박도윤, 최도현')
  await expect(p.locator('.ms .th.on .nm b')).toHaveText('김서연, 박도윤, 최도현')
  await shot(p, 'f-ms-03b-invited')
  // 김서연's open room: the line and the new member, without a reload
  await expect(y.locator('[data-test="msg-invite"]')).toHaveText(line)
  await expect(members(y)).toHaveText('정하윤, 김서연, 박도윤, 최도현')
  await shot(y, 'f-ms-03c-teammate-live')
  // 최도현: the room is in his messenger, with what was said before he came
  const d = await page(browser, DH, DESK)
  await openRoom(d, '정하윤, 김서연, 박도윤')
  await expect(d.locator('.ms .msg').filter({ hasText: '견적 세 곳 비교해 볼까요?' })).toBeVisible()
  await expect(d.locator('.ms .msg').filter({ hasText: '좋아요, 표로 정리할게요.' })).toBeVisible()
  await expect(d.locator('[data-test="msg-invite"]')).toHaveText(line)
  await expect(members(d)).toHaveText('정하윤, 김서연, 박도윤, 최도현')
  await shot(d, 'f-ms-03d-invitee')
  // Process GPT's room: the participant in its own shape; the invited got a notice that opens the room in Lite
  const [room] = await S.q('select participants from chat_rooms where id=$1', [id])
  expect(room.participants.at(-1)).toEqual({ id: DH.id, email: DH.email, username: '최도현', profile: '/images/defaultUser.png', agent_type: null, is_agent: false })
  expect((await S.q(`select title from notifications where user_id=$1 and type='team' and url like $2`, [DH.id, `/pro/team/${id}/%`]))[0]?.title).toBe('정하윤님이 대화방에 초대했어요')
  // nobody left to invite: the picker says so
  await p.locator('[data-test="room-invite"]').click()
  await expect(picker(p)).toContainText('초대할 수 있는 팀원이 없어요.')
  await picker(p).locator('[data-test="people-cancel"]').click()
  for (const x of [p, y, d]) { expect(x.errors).toEqual([]); await x.context().close() }
})

test('F-MS-04 1:1 대화에는 「단체방 만들기」 — 두 사람과 고른 사람의 새 단체방, 1:1 은 그대로', async ({ browser }) => {
  const { id: direct } = await S.api(HY.token, '/team/threads', { method: 'POST', body: { members: [SY.id] } })
  await say(HY, direct, '둘만 하는 이야기예요.')
  const p = await page(browser, HY, DESK)
  await openRoom(p, '김서연')
  await expect(p.locator('[data-test="room-invite"]')).toHaveCount(0)
  await p.locator('[data-test="room-make-group"]').click()
  const sheet = picker(p)
  await expect(sheet).toContainText('단체방에 함께할 팀원')
  // the two of us are not offered
  await expect(sheet.locator('[data-test="people-row"]')).toHaveCount(2)
  const offered = await sheet.locator('[data-test="people-row"]').evaluateAll((l) => l.map((e) => e.dataset.person))
  expect(offered.sort()).toEqual([DY.id, DH.id].sort())
  await sheet.locator(`[data-test="people-row"][data-person="${DY.id}"]`).click()
  await shot(p, 'f-ms-04a-make-group')
  await sheet.locator('[data-test="people-confirm"]').click()
  // a new group is open, with the three of us; the 1:1 is still the two of us, its talk not in the group
  await expect(members(p)).toHaveText('정하윤, 김서연, 박도윤')
  await expect(p.locator('.ms .msg').filter({ hasText: '둘만 하는 이야기예요.' })).toHaveCount(0)
  await expect(p.locator('[data-test="room-invite"]')).toBeVisible()
  await shot(p, 'f-ms-04b-group-made')
  const [d] = await S.q('select participants from chat_rooms where id=$1', [direct])
  expect(d.participants.map((x) => x.id).sort()).toEqual([HY.id, SY.id].sort())
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-MS-05 휴대폰 390px 밝은 · 밤 — 머리의 + · 고르는 창 · 시스템 줄이 화면 안', async ({ browser }) => {
  // (a room with a name of its own: F-MS-04 made another 정하윤 · 김서연 · 박도윤 room)
  const { id } = await S.api(SY.token, '/team/threads', { method: 'POST', body: { members: [HY.id, DY.id], title: '휴대폰 초대' } })
  await say(SY, id, '휴대폰에서 초대해 볼게요.')
  for (const [k, theme] of [['a', 'light'], ['b', 'dark']]) {
    const p = await page(browser, SY, PHONE, { theme })
    await openRoom(p, '휴대폰 초대', { phone: true })
    const btn = p.locator('[data-test="room-invite"]')
    await expect(btn).toBeVisible()
    const bb = await btn.boundingBox()
    expect(bb.x + bb.width).toBeLessThanOrEqual(390)
    await btn.click()
    const sheet = picker(p)
    await expect(sheet).toBeVisible()
    await expect(sheet.locator('.empty').filter({ hasText: '불러오는 중' })).toHaveCount(0)
    const box = await sheet.boundingBox()
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(390)
    expect(await noOverflow(p)).toBe(true)
    await shot(p, `f-ms-05${k}1-phone-picker-${theme}`)
    if (k === 'a') {
      await sheet.locator(`[data-test="people-row"][data-person="${DH.id}"]`).click()
      await sheet.locator('[data-test="people-confirm"]').click()
      await expect(p.locator('[data-test="msg-invite"]')).toHaveText('김서연님이 최도현님을 초대했어요')
    } else {
      await sheet.locator('[data-test="people-cancel"]').click()
      await expect(p.locator('[data-test="msg-invite"]')).toHaveText('김서연님이 최도현님을 초대했어요')
    }
    expect(await noOverflow(p)).toBe(true)
    await shot(p, `f-ms-05${k}2-phone-line-${theme}`)
    expect(p.errors).toEqual([])
    await p.context().close()
  }
})

test('F-MS-06 같은 이름의 두 사람은 주소로 갈린다 — 대화 목록 · 새 대화 상대 · 방 머리, 혼자인 이름은 그대로', async ({ browser }) => {
  const [GA, GB] = [await S.person(TWINS[0], '윤가람'), await S.person(TWINS[1], '윤가람')]
  for (const p of [GA, GB]) await S.join(p)
  for (const p of [GA, GB]) {
    const { id } = await S.api(HY.token, '/team/threads', { method: 'POST', body: { members: [p.id] } })
    await say(HY, id, `${p.email} 에게 하는 말`)
  }
  const { id: g } = await S.api(HY.token, '/team/threads', { method: 'POST', body: { members: [GA.id, GB.id] } })
  await say(HY, g, '두 분 모두 계신 방이에요.')
  const p = await page(browser, HY, DESK)
  await p.goto('/chat')
  await p.locator('button.msg-btn').click()
  await p.locator('[data-test="msg-chip-all"]').click()
  const titles = p.locator('.ms .th .nm b')
  // the 1:1 rows: one name, two people — told apart by their addresses' domains; a name alone stays as it is
  await expect(titles.filter({ hasText: /^윤가람 · uengine\.org$/ })).toHaveCount(1)
  await expect(titles.filter({ hasText: /^윤가람 · people-mail\.test$/ })).toHaveCount(1)
  await expect(titles.filter({ hasText: /^김서연$/ })).toHaveCount(1)
  // the room with both: its title and header
  const both = '윤가람 · uengine.org, 윤가람 · people-mail.test'
  await expect(titles.filter({ hasText: both })).toHaveCount(1)
  await titles.filter({ hasText: both }).click()
  await expect(members(p)).toHaveText(`정하윤, ${both}`)
  await shot(p, 'f-ms-06a-same-names')
  // a new conversation's people: the two are told apart, the others are not
  await p.locator('.ms .hd .tb').click()
  const rows = p.locator('.ms .pick [data-test="people-row"] .nm b')
  await expect(rows.filter({ hasText: /^윤가람 · uengine\.org$/ })).toHaveCount(1)
  await expect(rows.filter({ hasText: /^윤가람 · people-mail\.test$/ })).toHaveCount(1)
  await expect(rows.filter({ hasText: /^김서연$/ })).toHaveCount(1)
  await shot(p, 'f-ms-06b-same-names-picker')
  // Settings › 팀·역할: the team list and the role holders' choices
  await p.goto('/settings/team')
  await expect(p.locator('.tr .li .main b').filter({ hasText: /^윤가람 · (uengine\.org|people-mail\.test)$/ })).toHaveCount(2)
  await expect(p.locator('.tr .li .main b').filter({ hasText: /^김서연$/ })).toHaveCount(1)
  expect(p.errors).toEqual([])
  await p.context().close()
})
