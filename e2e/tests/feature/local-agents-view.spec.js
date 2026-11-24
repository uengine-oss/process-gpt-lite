// The run card's two views of one CLI session — 「대화」 (Lite's own components, from the CLI's records) and 「터미널」 (its screen in Lite's
// colours) — and what came with them (spec openspec/specs/local-agents; the user's question 2026-11-24: 「ssh 터미널이지만, 보기 모드에 따라
// 원하는 경우는 우리 디자인에 맞춰서 스타일링이 가능할까?」). Fictional people:
//   윤태호 — his PC (the desktop app's own runner, fake Claude Code — desktop/test/fixtures/fake-tui.js, which writes Claude Code's session
//            jsonl and runs its hooks as the real 2.1.331 does) runs 「견적서 작성」; at his desk (1280px) his run opens on 「터미널」
//   서하린 — a participant on a phone (390px): her run card opens on 「대화」
// F-LV-01 toggle · remembered   F-LV-02 phone default 대화   F-LV-03 live while the CLI writes its jsonl   F-LV-04 a tool row with its diff
// F-LV-05 「서하린 제안 · 윤태호 입력」   F-LV-06 the CLI asks: only the owner presses (the PTY gets '1')   F-LV-07 waiting to finish · 끝내기
// F-LV-08 an ended run: its last screen (not the CLI's goodbye) and its conversation, from the job   F-LV-09 light and dark, 390px
// F-LV-10 the run's folder variation on a phone (390px)
// It starts its own stack (lib/localStack.js: a BFF in tenant localagent-view and Vite, on free ports from 8889 · 5289). No model.
//   cd e2e && npx playwright test --project=feature tests/feature/local-agents-view.spec.js
import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { startStack, SHOTS, waitFor } from '../../lib/localStack.js'
import { TERM_THEMES, contrast } from '../../../src/localTermTheme.js'

test.describe.configure({ mode: 'serial' })
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ko-KR' }
const DESK = { viewport: { width: 1280, height: 900 }, locale: 'ko-KR' }
let S, TH, HR, inst, pcT, t1, job
const ACTS = [{
  id: 'quote', name: '견적서 작성', skills: ['견적-규칙'], instruction: [
    'THINK :: 요청 메일과 회사 스킬을 먼저 보자',
    'SKILL 견적-규칙',
    'WRITE_OUT 견적서.md :: | 대관 | 1,000,000원 |',
    'SLEEP 2500',
    'EDIT 견적서.md :: 1,000,000원 => 1,100,000원',
    'BASH wc -l 견적서.md :: 1 견적서.md',
    // (time for a suggestion to be put in: it is taken after the directive at hand)
    'SLEEP 20000',
    'ASK python3 -c "print(42)"',
    'SAY :: 견적서를 **만들었어요**\\n- 합계 1,100,000원(부가세 포함)\\n- 할인 줄은 따로 적었어요',
  ].join('\n'),
}]
async function page(browser, who, opts, { theme = null, view = null } = {}) {
  const ctx = await browser.newContext({ ...opts, baseURL: S.web })
  await ctx.addInitScript(([s, th, v]) => {
    if (window.top !== window) return
    localStorage.setItem('pgpt-pro-session', s)
    if (th) localStorage.setItem('pgpt-pro-theme', th)
    if (v) localStorage.setItem('pgl.localRun.view', v)
  }, [JSON.stringify(who.session), theme, view])
  const p = await ctx.newPage()
  p.errors = []
  p.on('pageerror', (e) => p.errors.push(String(e?.message || e)))
  p.navs = 0
  p.on('framenavigated', (f) => { if (f === p.mainFrame()) p.navs++ })
  return p
}
const noOverflow = (p) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
const card = (p, jobId) => p.locator(`[data-test=local-runs] [data-test=local-run][data-job="${jobId}"]`)
const tab = (c, v) => c.locator(`[data-test=local-run-view][data-view=${v}]`)
const toolRow = (c, label) => c.locator('[data-test=local-run-conv-tool]', { hasText: label })
const shot = (p, name) => p.screenshot({ path: path.join(SHOTS, `${name}.png`) })
const cliLog = () => (fs.existsSync(S.fakeEnv.FAKE_CLI_LOG) ? fs.readFileSync(S.fakeEnv.FAKE_CLI_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [])

test.beforeAll(async () => {
  test.setTimeout(240_000)
  fs.mkdirSync(SHOTS, { recursive: true })
  // (an ended terminal leaves memory after 4 s here: F-LV-08 reads its last screen and conversation from the job)
  S = await startStack({ tenant: 'localagent-view', apiFrom: 8889, webFrom: 5289, env: { PRO_LOCAL_TERM_KEEP_MS: '4000' } })
  TH = await S.person('pro-rt-local-view-t@uengine.org', '윤태호')
  HR = await S.person('pro-rt-local-view-h@uengine.org', '서하린')
  for (const p of [TH, HR]) await S.join(p)
  await S.skill('견적-규칙', '---\nname: 견적-규칙\ndescription: 견적서는 부가세 포함 금액으로\n---\n금액은 늘 부가세 포함으로 적는다.\n')
  inst = await S.instance('세미나 견적 — 달빛커피(보기)', ACTS, [TH, HR], { owner: TH.id })
  // (after the turn the run waits 90 s for the people on the instance — F-LV-07 ends it with 「끝내기」)
  pcT = await S.pc(TH, { name: '윤태호의 맥', settleMs: 90_000 })
})
test.afterAll(async () => { try { pcT?.stop() } catch { /* gone */ } await S?.stop() })

let desk, phone
test('F-LV-01 윤태호의 책상(1280px): 실행 카드는 「터미널」로 열리고(연결하는 동안 「터미널에 연결하는 중…」), 「대화」로 바꾸면 그 선택이 남는다', async ({ browser }) => {
  desk = await page(browser, TH, DESK, { theme: 'dark' })
  await desk.goto(`/routines/${encodeURIComponent(inst.inst)}`)
  t1 = await inst.step(ACTS[0], TH, { agent: 'claude-code', offline: 'wait' })
  job = await waitFor(async () => { const j = await S.jobOf(t1); return ['offered', 'running'].includes(j?.state) ? j : null }, 20000, 'sent')
  const c = card(desk, job.id)
  // the card shows the terminal's frame as soon as the run is sent — its connection waits on the server for the terminal to open
  const seenAt = Date.now()
  await expect(c.locator('[data-test=local-run-terminal]')).toBeVisible({ timeout: 15000 })
  await expect(tab(c, 'term')).toHaveAttribute('aria-selected', 'true')
  await expect(c.locator('[data-test=local-run-terminal]')).toHaveAttribute('data-term-state', 'live', { timeout: 20000 })
  test.info().annotations.push({ type: 'attach', description: `terminal live ${Date.now() - seenAt} ms after its frame showed` })
  await expect(c.locator('.xterm-rows')).toContainText('Claude Code (fake)', { timeout: 15000 })
  await expect(c.locator('[data-test=local-run-terminal]')).toHaveAttribute('data-owner', 'yes')
  await c.scrollIntoViewIfNeeded()
  await shot(desk, 'lv01-desk-term')
  await tab(c, 'chat').click()
  await expect(c.locator('[data-test=local-run-conversation]')).toBeVisible()
  await expect(c.locator('[data-test=local-run-conv-user]').first()).toContainText('단계 프롬프트')
  // remembered (this browser)
  await desk.reload()
  await expect(tab(card(desk, job.id), 'chat')).toHaveAttribute('aria-selected', 'true', { timeout: 20000 })
})

test('F-LV-02 · 03 서하린의 휴대폰(390px): 「대화」로 열리고, CLI 가 기록을 쓰는 대로 새로 고침 없이 늘어난다 — 생각은 접혀 있다', async ({ browser }) => {
  phone = await page(browser, HR, PHONE, { theme: 'dark' })
  await phone.goto(`/projects/p/${encodeURIComponent(inst.inst)}`)
  const c = card(phone, job.id)
  await expect(tab(c, 'chat')).toHaveAttribute('aria-selected', 'true', { timeout: 20000 })
  await expect(c.locator('[data-test=local-run-conversation]')).toBeVisible()
  const navs = phone.navs
  await expect(toolRow(c, '스킬 사용 · 견적-규칙')).toBeVisible({ timeout: 20000 })
  await expect(toolRow(c, '만듦 · 견적서.md')).toBeVisible({ timeout: 15000 })
  await expect(toolRow(c, '고침 · 견적서.md')).toBeVisible({ timeout: 15000 })
  await expect(toolRow(c, '명령 실행 · wc -l 견적서.md')).toBeVisible({ timeout: 15000 })
  expect(phone.navs).toBe(navs)
  // thinking: folded
  const think = c.locator('[data-test=local-run-conv-thinking]').first()
  await expect(think).toContainText('생각')
  await expect(think).not.toContainText('요청 메일과 회사 스킬을 먼저 보자')
  await expect(c.locator('[data-test=local-run-working]')).toBeVisible()
  expect(await noOverflow(phone)).toBe(true)
  await c.scrollIntoViewIfNeeded()
  await shot(phone, 'lv02-phone-chat')
})

test('F-LV-04 · 05 「고침 · 견적서.md」 을 펼치면 차이가 그 상자 안에서 보이고, 서하린의 제안을 윤태호가 넣으면 「서하린 제안 · 윤태호 입력」', async () => {
  const c = card(phone, job.id)
  const edit = toolRow(c, '고침 · 견적서.md')
  await edit.locator('[data-test=local-run-conv-tool-open]').click()
  const diff = edit.locator('[data-test=local-run-conv-diff]')
  await expect(diff).toBeVisible()
  await expect(diff.locator('.dl.del')).toContainText('1,000,000원')
  await expect(diff.locator('.dl.add')).toContainText('1,100,000원')
  expect(await noOverflow(phone)).toBe(true)
  await edit.scrollIntoViewIfNeeded()
  await shot(phone, 'lv04-phone-diff')
  // a suggestion from her phone, put in (edited) by him — whose words they are, on both screens
  await c.locator('[data-test=local-run-suggest]').fill('WRITE_OUT 하린.md :: 할인 줄을 따로')
  await c.locator('[data-test=local-run-suggest-send]').click()
  const dc = card(desk, job.id)
  const chip = dc.locator('[data-test=local-run-suggestions] li[data-suggestion-state=waiting]').first()
  await expect(chip).toBeVisible({ timeout: 10000 })
  await chip.locator('[data-test=local-run-suggestion-load]').click()
  await dc.locator('[data-test=local-run-steer]').fill('WRITE_OUT 하린.md :: 할인 줄을 따로(윤태호가 고침)')
  await dc.locator('[data-test=local-run-steer-send]').click()
  for (const cc of [dc, c]) {
    const row = cc.locator('[data-test=local-run-conv-user]', { hasText: '할인 줄을 따로(윤태호가 고침)' })
    await expect(row.locator('[data-test=local-run-conv-who]')).toHaveText('서하린 제안 · 윤태호 입력', { timeout: 20000 })
  }
  await dc.locator('[data-test=local-run-conv-user]', { hasText: '윤태호가 고침' }).scrollIntoViewIfNeeded()
  await shot(desk, 'lv05-desk-attribution')
})

test('F-LV-06 CLI 가 허락을 물으면: 서하린에게는 「윤태호님의 답을 기다려요」(누르면 403), 윤태호가 「허락」을 누르면 그 터미널에 1 이 들어간다', async () => {
  const pc = card(phone, job.id)
  const dc = card(desk, job.id)
  const askP = pc.locator('[data-test=local-run-ask]')
  await expect(askP).toBeVisible({ timeout: 30000 })
  await expect(askP).toContainText('명령 실행을 허락할까요?')
  await expect(askP).toContainText('python3 -c "print(42)"')
  await expect(askP.locator('[data-test=local-run-ask-wait]')).toHaveText('윤태호님의 답을 기다려요')
  await expect(askP.locator('[data-test=local-run-ask-choice]')).toHaveCount(0)
  const askId = await askP.getAttribute('data-ask')
  await expect(S.api(HR.token, `/local-agents/jobs/${job.id}/answer`, { method: 'POST', body: { ask: askId, answer: 'yes' } })).rejects.toMatchObject({ status: 403 })
  expect(cliLog().some((x) => x.answered)).toBe(false)
  await askP.scrollIntoViewIfNeeded()
  await shot(phone, 'lv06-phone-ask-wait')
  const askD = dc.locator('[data-test=local-run-ask]')
  await expect(askD.locator('[data-test=local-run-ask-choice]')).toHaveCount(3)
  await askD.scrollIntoViewIfNeeded()
  await shot(desk, 'lv06-desk-ask')
  await askD.locator('[data-test=local-run-ask-choice][data-choice=yes]').click()
  await waitFor(() => cliLog().some((x) => x.answered === '1'), 10000, 'the PTY got 1')
  await expect(dc.locator('[data-test=local-run-ask]')).toHaveCount(0, { timeout: 10000 })
  await expect(pc.locator('[data-test=local-run-ask]')).toHaveCount(0, { timeout: 10000 })
  await expect(toolRow(dc, '명령 실행 · 허락이 필요한 명령')).toHaveAttribute('data-tool-state', 'ok', { timeout: 10000 })
})

test('F-LV-07 턴이 끝나면 기다린다: 윤태호에게 「끝내기」와 「… 동안 새 입력이 없으면 저절로 끝나요」, 서하린에게 「윤태호님이 끝내기를 기다려요」 — 제안이 기다림을 늘리고, 끝내기는 윤태호만', async () => {
  const dc = card(desk, job.id)
  const pc = card(phone, job.id)
  await expect(dc.locator('[data-test=local-run-idle-text]')).toHaveText(/^2분 동안 새 입력이 없으면 저절로 끝나요$/, { timeout: 30000 })
  await expect(dc.locator('[data-test=local-run-finish]')).toBeVisible()
  await expect(dc.locator('[data-test=local-run-state]')).toHaveText('끝내기 기다림')
  await expect(pc.locator('[data-test=local-run-idle-text]')).toContainText('윤태호님이 끝내기를 기다려요')
  await expect(pc.locator('[data-test=local-run-finish]')).toHaveCount(0)
  await expect(pc.locator('[data-test=local-run-conv-text]', { hasText: '만들었어요' }).first()).toBeVisible()
  await expect(pc.locator('[data-test=local-run-working]')).toHaveCount(0)
  await pc.locator('[data-test=local-run-idle]').scrollIntoViewIfNeeded()
  expect(await noOverflow(phone)).toBe(true)
  await shot(phone, 'lv07-phone-idle')
  await dc.locator('[data-test=local-run-idle]').scrollIntoViewIfNeeded()
  await shot(desk, 'lv07-desk-idle')
  // a suggestion starts the wait again
  const before = new Date((await S.jobOf(t1)).idle_until).getTime()
  await phone.waitForTimeout(2000)
  await pc.locator('[data-test=local-run-suggest]').fill('목차를 맨 앞에 넣어 주세요')
  await pc.locator('[data-test=local-run-suggest-send]').click()
  await waitFor(async () => new Date((await S.jobOf(t1)).idle_until).getTime() > before + 1000, 10000, 'the wait started again')
  // only he ends it
  await expect(S.api(HR.token, `/local-agents/jobs/${job.id}/finish`, { method: 'POST' })).rejects.toMatchObject({ status: 403 })
  await dc.locator('[data-test=local-run-finish]').click()
  const done = await S.settled(t1, 30000)
  expect(done.state, done.error || '').toBe('done')
  expect(done.idle_until).toBeNull()
  expect(done.result.files).toEqual(expect.arrayContaining(['산출물/01_견적서 작성/하린.md', '산출물/01_견적서 작성/견적서.md']))
  // (her card, with no reload: the run is over and its conversation stays where she was reading)
  await expect(pc).toHaveAttribute('data-state', 'done', { timeout: 15000 })
  await expect(tab(pc, 'chat')).toHaveAttribute('aria-selected', 'true')
  await expect(pc.locator('[data-test=local-run-conversation]')).toBeVisible()
  await expect(pc.locator('[data-test=local-run-idle]')).toHaveCount(0)
})

test('F-LV-08 끝난 실행: 터미널은 마지막 턴의 화면(CLI 가 닫히며 지운 화면이 아니라), 대화는 일에 남은 기록에서', async () => {
  // (the session leaves the server's memory 4 s after the CLI ended: what follows comes from the job)
  const j = await waitFor(async () => { const x = await S.jobOf(t1); return Array.isArray(x.transcript) && x.transcript.length ? x : null }, 15000, 'transcript kept')
  expect(j.screen).toContain('만들었어요')
  expect(j.screen).not.toContain('Resume this session')
  expect(j.transcript.some((i) => i.t === 'tool' && i.name === 'Edit')).toBe(true)
  await desk.waitForTimeout(4500)
  await desk.reload()
  const dc = card(desk, job.id)
  await expect(dc).toHaveAttribute('data-state', 'done', { timeout: 20000 })
  await tab(dc, 'term').click()
  const term = dc.locator('[data-test=local-run-terminal]')
  await expect(term).toHaveAttribute('data-term-state', 'ended', { timeout: 15000 })
  await expect(term.locator('.xterm-rows')).toContainText('만들었어요', { timeout: 10000 })
  await expect(term.locator('.xterm-rows')).not.toContainText('Resume this session')
  await expect(term.locator('[data-test=local-run-term-note]')).toContainText('끝난 화면이에요')
  await dc.scrollIntoViewIfNeeded()
  await shot(desk, 'lv08-desk-ended-term')
  await phone.reload()
  const pc = card(phone, job.id)
  await expect(pc.locator('[data-test=local-run-conv-text]', { hasText: '만들었어요' }).first()).toBeVisible({ timeout: 20000 })
  await expect(toolRow(pc, '고침 · 견적서.md')).toBeVisible()
  await expect(pc.locator('[data-test=local-run-conv-user]', { hasText: '윤태호가 고침' }).locator('[data-test=local-run-conv-who]')).toHaveText('서하린 제안 · 윤태호 입력')
  await pc.scrollIntoViewIfNeeded()
  await shot(phone, 'lv08-phone-ended-chat')
  for (const p of [desk, phone]) expect(p.errors).toEqual([])
})

test('F-LV-09 밝은 · 어두운 테마(390px): 터미널은 Lite 의 색으로, 테마를 바꾸면 그 자리에서 바뀌고, 글은 4.5:1 이상으로 읽힌다', async ({ browser }) => {
  // the palettes: every colour reads on its background
  for (const [mode, t] of Object.entries(TERM_THEMES)) {
    for (const k of ['foreground', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'brightBlack', 'brightWhite']) expect(contrast(t[k], t.background), `${mode} ${k}`).toBeGreaterThanOrEqual(4.5)
  }
  for (const theme of ['light', 'dark']) {
    const p = await page(browser, HR, PHONE, { theme, view: 'term' })
    await p.goto(`/routines/${encodeURIComponent(inst.inst)}`)
    const c = card(p, job.id)
    const term = c.locator('[data-test=local-run-terminal]')
    await expect(term).toHaveAttribute('data-theme-mode', theme, { timeout: 20000 })
    await expect(term.locator('.xterm-rows')).toContainText('만들었어요', { timeout: 15000 })
    const bg = await term.locator('.box').evaluate((e) => getComputedStyle(e).backgroundColor)
    expect(bg).toBe(theme === 'light' ? 'rgb(251, 251, 253)' : 'rgb(29, 29, 31)')
    expect(await noOverflow(p)).toBe(true)
    await c.scrollIntoViewIfNeeded()
    await shot(p, `lv09-phone-${theme}-term`)
    await tab(c, 'chat').click()
    await expect(toolRow(c, '고침 · 견적서.md')).toBeVisible()
    await toolRow(c, '고침 · 견적서.md').locator('[data-test=local-run-conv-tool-open]').click()
    expect(await noOverflow(p)).toBe(true)
    await shot(p, `lv09-phone-${theme}-chat`)
    // switched live: the theme changes, the terminal follows
    await tab(c, 'term').click()
    const other = theme === 'light' ? 'dark' : 'light'
    await p.evaluate((t) => { document.documentElement.dataset.theme = t }, other)
    await expect(term).toHaveAttribute('data-theme-mode', other)
    expect(p.errors).toEqual([])
    await p.context().close()
  }
})

test('F-LV-10 실행의 작업 폴더 변경안을 휴대폰(390px)에서: 제목은 한 덩어리로, 바뀐 파일 목록이 보이고, 옆으로 넘치지 않는다 — 폴더 · 폴더 목록도', async ({ browser }) => {
  const j = await S.jobOf(t1)
  const [v] = await S.q('select v.id, f.slug from pro_folder_variations v join pro_folders f on f.id=v.folder_id where v.folder_id=$1 and v.branch=$2', [j.folder_id, j.result.branch])
  const p = await page(browser, TH, PHONE, { theme: 'dark' })
  await p.goto(`/folders/${v.slug}/v/${v.id}`)
  const title = p.locator('.vv h1 .tt')
  await expect(title).toBeVisible({ timeout: 20000 })
  // (one line for 「견적서 작성」 — before, the title column was squeezed to a letter per line; the heading spans the screen)
  const box = await title.boundingBox()
  expect(box.height).toBeLessThan(40)
  expect((await p.locator('.vv h1').boundingBox()).width).toBeGreaterThan(250)
  const files = p.locator('.vv .ci')
  await expect(files.first()).toBeVisible()
  expect(await files.count()).toBeGreaterThanOrEqual(2)
  await files.first().scrollIntoViewIfNeeded()
  await expect(files.first()).toBeInViewport()
  expect(await noOverflow(p)).toBe(true)
  await p.locator('.vv').evaluate((e) => { e.scrollTop = 0 })
  await p.waitForTimeout(1200) // (the page blurs in)
  await shot(p, 'lv10-phone-variation')
  await files.first().click()
  await expect(p.locator('.vv .diff .dh')).toBeVisible()
  await p.locator('.vv .diff').scrollIntoViewIfNeeded()
  expect(await noOverflow(p)).toBe(true)
  await shot(p, 'lv10-phone-variation-diff')
  await p.goto(`/folders/${v.slug}`)
  await expect(p.locator('.fd h1')).toBeVisible({ timeout: 20000 })
  await p.waitForTimeout(1200)
  expect(await noOverflow(p)).toBe(true)
  await shot(p, 'lv10-phone-folder')
  await p.goto('/folders')
  await p.waitForTimeout(1500)
  expect(await noOverflow(p)).toBe(true)
  await shot(p, 'lv10-phone-folders')
  expect(p.errors).toEqual([])
})
