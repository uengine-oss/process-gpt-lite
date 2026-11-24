// Local CLI agent runs seen and steered from a phone (spec openspec/specs/local-agents — "다른 기기에서 보고 조종한다"): A's desktop runner
// (the desktop app's own runner code, desktop/src/runner, with the fake `claude` — desktop/test/fixtures/fake-cli.js) runs A's step; A on a
// phone (a 390px browser, not the desktop app) opens the instance and sees who runs it on which computer, the step, the latest lines, the
// time and the state follow live (pushed: no reload), steers it there and sees the steer reach the run on the PC — the runner's log and the
// CLI's own input show the text. D, in the instance but not allowed to edit it, sees the same card live but cannot steer (403); C, outside
// the instance, gets 403. A run waiting for the PC shows 「PC 앱이 켜지면 시작」 and A hands it to the server from the phone.
// It starts its own stack (lib/localStack.js: a BFF in tenant localagent-mobile and Vite, on free ports).
//   cd e2e && npx playwright test --project=feature tests/feature/local-agents-mobile.spec.js
import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { startStack, desktopRequire, SHOTS, waitFor } from '../../lib/localStack.js'

test.describe.configure({ mode: 'serial' })
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ko-KR' }
let S, A, C, D, inst, runner
const runnerLog = []
const ACTS = [
  { id: 'quote', name: '견적서 작성', instruction: 'SLEEP 2500\nWRITE_OUT 견적서.md :: 견적 초안\nSLEEP 2500\nWRITE_OUT 비고.md :: 비고\nSLEEP 6000\nWRITE_OUT 마무리.md :: 마무리' },
  { id: 'send', name: '발송 준비', instruction: 'WRITE_OUT 발송.md :: 발송 준비' },
  { id: 'quote2', name: '견적서 다시', instruction: 'SLEEP 2500\nWRITE_OUT 견적서2.md :: 다시\nSLEEP 8000\nWRITE_OUT 끝.md :: 끝' },
]
async function phone(browser, who) {
  const ctx = await browser.newContext({ ...PHONE, baseURL: S.web })
  await ctx.addInitScript((s) => { if (window.top === window) localStorage.setItem('pgpt-pro-session', s) }, JSON.stringify(who.session))
  const page = await ctx.newPage()
  page.errors = []
  page.on('pageerror', (e) => page.errors.push(String(e?.message || e)))
  page.navs = 0
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) page.navs++ })
  return page
}
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)

test.beforeAll(async () => {
  test.setTimeout(240_000)
  fs.mkdirSync(SHOTS, { recursive: true })
  S = await startStack({ tenant: 'localagent-mobile', apiFrom: 8871, webFrom: 5271 })
  A = await S.person('pro-rt-local-m-a@uengine.org', '김견적')
  C = await S.person('pro-rt-local-m-c@uengine.org', '박외부')
  D = await S.person('pro-rt-local-m-d@uengine.org', '최참관')
  inst = await S.instance('세미나 견적 — 달빛커피(휴대폰)', ACTS, [A, D])
  // A's PC: the desktop app's runner, paired with a device token of A's
  const dev = await S.api(A.token, '/local-agents/devices', { method: 'POST', body: { name: '김견적의 맥', platform: 'darwin', appVersion: 'e2e' } })
  Object.assign(process.env, S.fakeEnv)
  const { createLocalRunner } = desktopRequire('./src/runner/index.js')
  runner = createLocalRunner({ server: `http://127.0.0.1:${S.apiPort}`, token: dev.token, dataDir: path.join(S.root, 'pc-a'), device: { name: '김견적의 맥' },
    prefs: () => ({ enabled: true, ask: false }), searchPath: `${S.bin}${path.delimiter}/usr/bin${path.delimiter}/bin`, log: (s) => runnerLog.push(s),
    // the CLIs' own config folders of this test (the runner marks its folders trusted there — never in the person's ~/.claude.json)
    sessionEnv: S.cliEnv, settleMs: 800 })
  await runner.start()
  await waitFor(() => runner.status().connected, 15000, 'A linked')
})
test.afterAll(async () => { try { runner?.stop() } catch { /* gone */ } await S?.stop() })

test('M-01 휴대폰(390px)에서 A 의 PC 가 돌리는 실행을 실시간으로 보고, 조종하면 PC 의 CLI 에 닿는다', async ({ browser }) => {
  const t1 = await inst.step(ACTS[0], A, { agent: 'claude-code', offline: 'wait' })
  await waitFor(async () => (await S.jobOf(t1))?.state === 'running', 20000, 'running')
  const page = await phone(browser, A)
  await page.goto(`/projects/p/${encodeURIComponent(inst.inst)}`)
  await page.waitForURL(/\/routines\//)
  const card = page.locator('[data-test=local-runs] [data-test=local-run]').first()
  await expect(card).toHaveAttribute('data-state', 'running', { timeout: 20000 })
  await expect(card.locator('[data-test=local-run-who]')).toContainText('김견적 · 김견적의 맥')
  await expect(card).toContainText('「견적서 작성」 단계')
  await expect(card.locator('[data-test=local-run-elapsed]')).toContainText('째')
  // pushed: the lines grow with no reload
  const navs = page.navs
  await expect(card.locator('[data-test=local-run-terminal] .xterm-rows')).toContainText('견적서.md', { timeout: 15000 })
  await expect(card.locator('[data-test=local-run-terminal] .xterm-rows')).toContainText('비고.md', { timeout: 15000 })
  expect(page.navs).toBe(navs)
  expect(await noOverflow(page)).toBe(true)
  await card.scrollIntoViewIfNeeded()
  await page.screenshot({ path: path.join(SHOTS, 'm01-phone-running.png') })
  // steer from the phone → server → A's PC → the running CLI
  const said = 'WRITE_OUT 휴대폰.md :: 휴대폰에서 바꿈 — 부가세 포함 금액으로'
  await card.locator('[data-test=local-run-steer]').fill(said)
  expect(await noOverflow(page)).toBe(true)
  await card.locator('[data-test=local-run-steer-send]').click()
  await expect(card.locator('[data-test=local-run-steers] li').first()).toHaveAttribute('data-steer-state', /received|applied/, { timeout: 10000 })
  await expect(card.locator('[data-test=local-run-steers] li').first()).toHaveAttribute('data-steer-state', 'applied', { timeout: 20000 })
  await expect(card.locator('[data-test=local-run-steers]')).toContainText('반영 — 실행을 멈추지 않고')
  await page.screenshot({ path: path.join(SHOTS, 'm01-phone-steered.png') })
  // it reached the PC: the runner's log, and the CLI's own input
  expect(runnerLog.some((l) => l.includes('steer from 김견적') && l.includes('휴대폰에서 바꿈'))).toBe(true)
  const cli = fs.readFileSync(S.fakeEnv.FAKE_CLI_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  expect(cli.some((x) => x.received && x.received.includes('휴대폰에서 바꿈'))).toBe(true)
  const j = await S.settled(t1)
  expect(j.state, j.error || '').toBe('done')
  expect(j.result.files.some((f) => f.endsWith('/휴대폰.md'))).toBe(true)
  await expect(card).toHaveAttribute('data-state', 'done', { timeout: 15000 })
  expect(page.errors).toEqual([])
})

test('M-02 인스턴스에 있지만 고칠 수 없는 사람은 실시간으로 보기만, 바깥 사람은 403', async ({ browser }) => {
  const t = await inst.step(ACTS[2], A, { agent: 'claude-code', offline: 'wait' })
  await waitFor(async () => (await S.jobOf(t))?.state === 'running', 20000, 'running')
  const page = await phone(browser, D)
  await page.goto(`/routines/${encodeURIComponent(inst.inst)}`)
  const card = page.locator('[data-test=local-runs] [data-test=local-run][data-state=running]').first()
  await expect(card).toContainText('김견적 · 김견적의 맥', { timeout: 20000 })
  await expect(card.locator('[data-test=local-run-terminal] .xterm-rows')).toContainText('견적서2.md', { timeout: 15000 })
  await expect(card.locator('[data-test=local-run-steer]')).toHaveCount(0)
  await page.screenshot({ path: path.join(SHOTS, 'm02-phone-viewer.png') })
  const job = await S.jobOf(t)
  await expect(S.api(D.token, `/local-agents/jobs/${job.id}/steer`, { method: 'POST', body: { text: '참관자의 지시' } })).rejects.toMatchObject({ status: 403 })
  await expect(S.api(C.token, `/local-agents/jobs/${job.id}/steer`, { method: 'POST', body: { text: '외부의 지시' } })).rejects.toMatchObject({ status: 403 })
  await expect(S.api(C.token, `/local-agents/instances/${encodeURIComponent(inst.inst)}`)).rejects.toMatchObject({ status: 403 })
  expect(runnerLog.some((l) => l.includes('참관자의 지시') || l.includes('외부의 지시'))).toBe(false)
  await S.settled(t)
  expect(page.errors).toEqual([])
})

test('M-03 PC 앱이 꺼져 있으면 「PC 앱이 켜지면 시작」, 휴대폰에서 바로 서버에 맡긴다 · Home 카드도 상태를 보인다', async ({ browser }) => {
  runner.stop()
  await waitFor(async () => !(await S.api(A.token, '/local-agents/devices')).some((d) => d.online), 10000, 'A off')
  const t = await inst.step(ACTS[1], A, { agent: 'claude-code', offline: 'wait', waitMinutes: 120 })
  await waitFor(async () => (await S.jobOf(t))?.why === 'waiting', 20000, 'waiting')
  const page = await phone(browser, A)
  // Home: the step's card says where its local run is
  await page.goto('/chat')
  const notice = page.locator('[data-test=notice-local-run]').first()
  await expect(notice).toContainText('PC 앱이 켜지면 시작', { timeout: 20000 })
  await notice.scrollIntoViewIfNeeded()
  await page.waitForTimeout(1500) // (Home blurs in)
  await page.screenshot({ path: path.join(SHOTS, 'm03-phone-home.png') })
  await page.goto(`/routines/${encodeURIComponent(inst.inst)}`)
  const card = page.locator('[data-test=local-runs] [data-test=local-run][data-state=queued]').first()
  await expect(card.locator('[data-test=local-run-state]')).toHaveText('PC 앱이 켜지면 시작', { timeout: 20000 })
  await expect(card.locator('[data-test=local-run-text]')).toContainText('PC 앱이 켜지면 시작')
  expect(await noOverflow(page)).toBe(true)
  await page.screenshot({ path: path.join(SHOTS, 'm03-phone-waiting.png') })
  await card.locator('[data-test=local-run-delegate]').click()
  const after = page.locator(`[data-test=local-runs] [data-test=local-run][data-job="${(await S.jobOf(t)).id}"]`)
  await expect(after).toHaveAttribute('data-state', 'delegated', { timeout: 10000 })
  await expect(after).toContainText('기다리지 않고 업무 에이전트에게 맡겼어요')
  expect((await S.jobOf(t)).why).toBe('manual')
  expect(page.errors).toEqual([])
})
