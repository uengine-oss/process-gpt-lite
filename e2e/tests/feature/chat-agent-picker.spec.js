// The chat's agent picker (spec openspec/specs/local-agents 「채팅에서 고르는 에이전트」; the user's request 2026-11-24: 「채팅 입력창
// 보낼때 기본, codex, claude code 등 cli 에이전트를 선택할 수 있는 옵션이 대화창에 있으면 좋겠음」). Fictional person:
//   윤태호 — his PC (the desktop app's own runner, fake Claude Code · Codex — desktop/test/fixtures/fake-tui.js) answers his chat messages
// F-CA-01 no desktop: 기본, and the local entries off with why and the desktop app's link; his PC linked → they turn on (no reload)
// F-CA-02 by keyboard to 「Claude Code · 내 PC」, send: the tag under his message, the run card (대화 / 터미널), the answer, a file card
// F-CA-03 a follow-up goes into the same session (one run card, a second answer)
// F-CA-04 the choice is kept per chat (a reload, another browser, a project: 기본 there)
// F-CA-05 기본 again: the message goes to the server agent (no agent in the request, no run card)
// F-CA-06 his PC off: the picker says so; the run's card says the link is gone and offers 「기본으로 다시 보내기」; a new message waits
//         (「PC 앱이 꺼져 있어요」) with the same offer
// F-CA-07 390px phone: the picker in the composer, its list inside the screen, no sideways scroll — light and dark
// F-CA-08 dark theme: the list and the chat's run card on a desk
// It starts its own stack (lib/localStack.js: a BFF in tenant chatagent-ui and Vite, on free ports from 8892 · 5292). No model, no shared
// service (deepagents · completion · the context router point nowhere).
//   cd e2e && npx playwright test --project=feature tests/feature/chat-agent-picker.spec.js
import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { startStack, SHOTS as LA_SHOTS, waitFor } from '../../lib/localStack.js'

test.describe.configure({ mode: 'serial' })
const SHOTS = path.join(LA_SHOTS, 'chat-agent')
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ko-KR' }
const DESK = { viewport: { width: 1280, height: 900 }, locale: 'ko-KR' }
const NOWHERE = 'http://127.0.0.1:9'
let S, TH, pc, main

async function page(browser, who, opts, { theme = null } = {}) {
  const ctx = await browser.newContext({ ...opts, baseURL: S.web })
  await ctx.addInitScript(([s, th]) => {
    if (window.top !== window) return
    localStorage.setItem('pgpt-pro-session', s)
    if (th) localStorage.setItem('pgpt-pro-theme', th)
  }, [JSON.stringify(who.session), theme])
  const p = await ctx.newPage()
  p.errors = []
  p.on('pageerror', (e) => p.errors.push(String(e?.message || e)))
  return p
}
// (after the page's and the list's fade — .4s — so the picture shows what a person sees)
const shot = async (p, name) => { await p.waitForTimeout(600); await p.screenshot({ path: path.join(SHOTS, `${name}.png`) }) }
const noOverflow = (p) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
const chip = (p) => p.locator('[data-test=chat-agent-chip]').first()
const option = (p, id) => p.locator(`[data-test=chat-agent-option][data-agent="${id}"]`)
const box = (p) => p.locator('.composer textarea').first()
const runCard = (p, jobId) => p.locator(`[data-test=local-run][data-job="${jobId}"]`)
const cliLog = () => (fs.existsSync(S.fakeEnv.FAKE_CLI_LOG) ? fs.readFileSync(S.fakeEnv.FAKE_CLI_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [])
const chatJobs = () => S.q(`select * from pro_local_jobs where tenant_id=$1 and kind='chat' order by created_at`, [S.tenant])
async function send(p, text) {
  await box(p).fill(text)
  await box(p).press('Enter')
}

test.beforeAll(async () => {
  test.setTimeout(240_000)
  fs.mkdirSync(SHOTS, { recursive: true })
  S = await startStack({ tenant: 'chatagent-ui', apiFrom: 8892, webFrom: 5292, env: { PRO_DEEPAGENTS_URL: NOWHERE, PRO_COMPLETION_URL: NOWHERE, PRO_CONTEXT_ROUTER_URL: NOWHERE } })
  TH = await S.person('pro-rt-chatagent-ui-t@uengine.org', '윤태호')
  await S.join(TH)
  // (his chats start empty on every run)
  await S.q(`delete from pro_messages where thread_id in (select id from pro_threads where user_id=$1)`, [TH.id])
  await S.q(`delete from pro_threads where user_id=$1 and kind='project'`, [TH.id])
  await S.q(`delete from pro_chat_agents where user_id=$1`, [TH.id])
  ;[main] = await S.api(TH.token, '/threads')
})
test.afterAll(async () => {
  try { pc?.stop() } catch { /* gone */ }
  if (S) {
    await S.q(`delete from pro_chat_agents where tenant_id=$1`, [S.tenant]).catch(() => {})
    await S.q(`delete from pro_messages where thread_id in (select id from pro_threads where user_id=$1)`, [TH?.id]).catch(() => {})
    await S.q(`delete from pro_thread_folders where user_id=$1`, [TH?.id]).catch(() => {})
    await S.q(`delete from pro_threads where user_id=$1 and kind='project'`, [TH?.id]).catch(() => {})
    await S.stop()
  }
})

let desk
test('F-CA-01 PC 앱이 없으면 「기본」과, 까닭과 함께 꺼진 「Claude Code · 내 PC」 · 「Codex · 내 PC」 — PC 를 이으면 새로 고침 없이 켜진다', async ({ browser }) => {
  desk = await page(browser, TH, DESK)
  await desk.goto('/chat')
  await expect(chip(desk)).toBeVisible({ timeout: 20000 })
  await expect(chip(desk)).toContainText('기본')
  await chip(desk).click()
  for (const id of ['claude-code', 'codex']) {
    await expect(option(desk, id)).toHaveAttribute('aria-disabled', 'true')
    await expect(option(desk, id).locator('[data-test=chat-agent-why]')).toHaveText('PC 앱을 설치하고 로그인하면 쓸 수 있어요')
  }
  await expect(option(desk, 'claude-code')).toContainText('Claude Code · 내 PC')
  await expect(desk.locator('[data-test=chat-agent-download]')).toHaveAttribute('href', /processgptlite\.html#desktop$/)
  await shot(desk, 'ca01-no-desktop')
  // a disabled entry is not picked (aria-disabled: Playwright would not click it by itself)
  await option(desk, 'claude-code').click({ force: true })
  await expect(chip(desk)).toContainText('기본')
  // his PC comes on: the open list follows (the server's local_presence)
  if (!(await desk.locator('[data-test=chat-agent-menu]').isVisible())) await chip(desk).click()
  pc = await S.pc(TH, { name: '윤태호의 맥', settleMs: 60_000 })
  await expect(option(desk, 'claude-code')).toHaveAttribute('aria-disabled', 'false', { timeout: 15000 })
  await expect(option(desk, 'codex')).toHaveAttribute('aria-disabled', 'false')
  await expect(option(desk, 'claude-code')).toContainText('윤태호의 맥')
  await shot(desk, 'ca01-desktop-linked')
  await desk.keyboard.press('Escape')
  await expect(desk.locator('[data-test=chat-agent-menu]')).toBeHidden()
})

let job1
test('F-CA-02 키보드로 「Claude Code · 내 PC」를 골라 보내면: 메시지 아래 「→ Claude Code · 내 PC」, 실행 카드, 답 메시지, 파일 카드', async () => {
  await chip(desk).focus()
  await desk.keyboard.press('ArrowDown')
  await expect(desk.locator('[data-test=chat-agent-menu]')).toBeVisible()
  await expect(option(desk, 'default')).toBeFocused()
  await desk.keyboard.press('ArrowDown')
  await expect(option(desk, 'claude-code')).toBeFocused()
  await desk.keyboard.press('Enter')
  await expect(desk.locator('[data-test=chat-agent-menu]')).toBeHidden()
  await expect(chip(desk)).toBeFocused()
  await expect(chip(desk)).toContainText('Claude Code')
  await expect(chip(desk)).toContainText('내 PC')
  await expect(desk.locator('[data-test=chat-agent]')).toHaveAttribute('data-agent', 'claude-code')
  await send(desk, '회의록을 만들어 줘\nWRITE 회의록.md :: 안건 1. 예산 2. 일정')
  await expect(desk.locator('[data-test=msg-agent-tag]').last()).toHaveText('→ Claude Code · 내 PC', { timeout: 15000 })
  job1 = (await waitFor(async () => (await chatJobs())[0], 15000, 'the chat job')).id
  const card = runCard(desk, job1)
  await expect(card).toBeVisible({ timeout: 15000 })
  await expect(card.locator('[data-test=local-run-where]')).toContainText('내 PC 에이전트 작업 · 윤태호')
  await expect(desk.locator('[data-test=msg-local-answer]').first()).toHaveText('Claude Code · 내 PC', { timeout: 30000 })
  await expect(desk.locator('.row.r-agent.k-text').filter({ has: desk.locator('[data-test=msg-local-answer]') }).first()).toContainText('회의록.md')
  await expect(desk.locator('.row.k-file').filter({ hasText: '회의록.md' })).toBeVisible({ timeout: 20000 })
  // the card's two views of the session
  await expect(card.locator('[data-test=local-run-view][data-view=chat]')).toBeVisible({ timeout: 15000 })
  await expect(card).toHaveAttribute('data-state', 'running')
  await expect(card.locator('[data-test=local-run-chat-hint]')).toBeVisible()
  await card.scrollIntoViewIfNeeded()
  await shot(desk, 'ca02-sent-answer-file')
  expect(desk.errors).toEqual([])
})

test('F-CA-03 이어서 보낸 메시지는 같은 세션에 들어간다 — 실행 카드는 하나, 답이 하나 더', async () => {
  await send(desk, 'WRITE 할일.md :: 견적서 보내기')
  await expect(desk.locator('[data-test=msg-local-answer]')).toHaveCount(2, { timeout: 30000 })
  await expect(desk.locator('.row.k-file').filter({ hasText: '할일.md' })).toBeVisible({ timeout: 20000 })
  await expect(desk.locator('[data-test=local-run]')).toHaveCount(1)
  expect((await chatJobs()).length).toBe(1)
  expect(new Set(cliLog().filter((l) => l.received).map((l) => l.session)).size).toBe(1)
  await shot(desk, 'ca03-follow-up')
})

test('F-CA-04 고른 것은 대화마다 남는다 — 새로 고침 · 다른 브라우저에서도, 프로젝트는 따로(기본)', async ({ browser }) => {
  await desk.reload()
  await expect(chip(desk)).toContainText('Claude Code', { timeout: 20000 })
  // another browser (nothing in its storage): the server keeps it
  const other = await page(browser, TH, DESK)
  await other.goto('/chat')
  await expect(chip(other)).toContainText('Claude Code', { timeout: 20000 })
  await other.context().close()
  const proj = await S.api(TH.token, '/threads', { method: 'POST', body: { text: '세미나 준비' } })
  await desk.goto(`/projects/${proj.id}`)
  await expect(chip(desk)).toContainText('기본', { timeout: 20000 })
  await desk.goto('/chat')
  await expect(chip(desk)).toContainText('Claude Code', { timeout: 20000 })
})

test('F-CA-05 다시 「기본」을 고르면 서버의 에이전트로 간다 — 요청에 agent 가 없고 실행 카드가 생기지 않는다', async () => {
  await chip(desk).click()
  await option(desk, 'default').click()
  await expect(chip(desk)).toContainText('기본')
  const before = (await chatJobs()).length
  const req = desk.waitForRequest((r) => r.method() === 'POST' && /\/api\/threads\/[^/]+\/messages$/.test(r.url()))
  await send(desk, '오늘 할 일을 알려 줘')
  const body = JSON.parse((await req).postData() || '{}')
  expect(body.agent).toBeUndefined()
  // the server agent answered (here: no model — its own failure message), never a CLI
  await expect(desk.locator('.row.r-agent.k-text').last()).toContainText('처리하지 못했어요', { timeout: 30000 })
  await expect(desk.locator('.row.r-agent.k-text').last().locator('[data-test=msg-local-answer]')).toHaveCount(0)
  expect((await chatJobs()).length).toBe(before)
  await expect(desk.locator('[data-test=msg-agent-tag]')).toHaveCount(2)
})

test('F-CA-06 PC 가 꺼지면: 고르기에 「PC 앱이 꺼져 있어요」, 실행 카드가 까닭과 「기본으로 다시 보내기」를 — 새 메시지는 기다린다', async () => {
  await chip(desk).click()
  await option(desk, 'claude-code').click()
  pc.stop()
  pc = null
  await expect(desk.locator('[data-test=chat-agent]')).toHaveAttribute('data-off', 'yes', { timeout: 15000 })
  await chip(desk).click()
  await expect(option(desk, 'claude-code').locator('[data-test=chat-agent-why]')).toHaveText('PC 앱이 꺼져 있어요')
  await expect(desk.locator('[data-test=chat-agent-nopc]')).toContainText('PC 앱을 켜면')
  await shot(desk, 'ca06-picker-off')
  await desk.keyboard.press('Escape')
  // the run that was on: its link is gone
  const card = runCard(desk, job1)
  await expect(card.locator('[data-test=local-run-text]')).toContainText('PC 앱 연결이 끊겼어요', { timeout: 15000 })
  await expect(card.locator('[data-test=local-run-fallback]')).toBeVisible()
  // 「기본으로 다시 보내기」: the run stops and the words without an answer go to the server agent
  await send(desk, '내일 회의 안건 정리해 줘')
  await expect(desk.locator('[data-test=msg-agent-tag]')).toHaveCount(3, { timeout: 15000 })
  const req = desk.waitForRequest((r) => r.method() === 'POST' && /\/api\/threads\/[^/]+\/messages$/.test(r.url()))
  await card.locator('[data-test=local-run-fallback]').click()
  const body = JSON.parse((await req).postData() || '{}')
  expect(body.text).toBe('내일 회의 안건 정리해 줘')
  expect(body.agent).toBeUndefined()
  await expect(card.locator('[data-test=local-run-text]')).toHaveText('기본 에이전트로 다시 보냈어요', { timeout: 15000 })
  // a new message while it is off: it waits for the PC, with the same offer
  await send(desk, '주간 보고서 초안 써 줘')
  const waiting = await waitFor(async () => (await chatJobs()).find((j) => j.state === 'queued'), 15000, 'a waiting run')
  const wc = runCard(desk, waiting.id)
  await expect(wc.locator('[data-test=local-run-text]')).toContainText('PC 앱이 꺼져 있어요', { timeout: 15000 })
  await expect(wc.locator('[data-test=local-run-state]')).toHaveText('PC 앱이 켜지면 시작')
  await expect(wc.locator('[data-test=local-run-fallback]')).toBeVisible()
  await wc.scrollIntoViewIfNeeded()
  await shot(desk, 'ca06-offline-card')
})

test('F-CA-07 · 08 휴대폰(390px) 밝게 · 어둡게: 입력창의 고르기, 화면 안의 목록, 옆으로 넘치지 않음 — 책상의 어두운 테마', async ({ browser }) => {
  for (const theme of ['light', 'dark']) {
    const p = await page(browser, TH, PHONE, { theme })
    await p.goto('/chat')
    await expect(chip(p)).toBeVisible({ timeout: 20000 })
    await expect(chip(p)).toContainText('Claude Code')
    expect(await noOverflow(p)).toBe(true)
    await chip(p).click()
    const menu = p.locator('[data-test=chat-agent-menu]')
    await expect(menu).toBeVisible()
    const b = await menu.boundingBox()
    expect(b.x).toBeGreaterThanOrEqual(0)
    expect(b.x + b.width).toBeLessThanOrEqual(390 + 1)
    expect(await noOverflow(p)).toBe(true)
    await shot(p, `ca07-phone-${theme}`)
    expect(p.errors).toEqual([])
    await p.context().close()
  }
  const dark = await page(browser, TH, DESK, { theme: 'dark' })
  await dark.goto('/chat')
  await expect(chip(dark)).toBeVisible({ timeout: 20000 })
  await expect(dark.locator('[data-test=local-run]').first()).toBeVisible({ timeout: 20000 })
  await dark.locator('[data-test=local-run]').first().scrollIntoViewIfNeeded()
  await shot(dark, 'ca08-desk-dark-card')
  await chip(dark).click()
  await shot(dark, 'ca08-desk-dark-menu')
  expect(dark.errors).toEqual([])
  await dark.context().close()
})
