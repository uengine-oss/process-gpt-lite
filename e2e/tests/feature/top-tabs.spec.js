// 위쪽 메뉴 — 「루틴」을 「프로세스」로, 맨 뒤로 (스펙 openspec/specs/top-tabs 「위쪽 메뉴는 채팅 · 프로젝트 · 팀 · 폴더 · 프로세스 순서다」,
// 화면 TopBar.vue). 2026-11-28 사용자: 「그리고 루틴은 "프로세스" 로 바꾸고 맨 뒤 메뉴로 옮겨... 메뉴 순서는 채팅-프로젝트-팀-폴더-프로세스」.
// 「루틴」 탭은 이미 회사 프로세스 지도(지도가 없는 회사는 진행 중인 일 목록)를 열고 있었다 — 이름이 하는 일을 따라간다.
//   F-NAV-01 PC 1280(밝은): 채팅 · 프로젝트 · 팀 · 폴더 · 프로세스, 「루틴」 없음 · 「프로세스」를 누르면 지도(또는 목록)가 열리고 그 탭이 켜짐 ·
//            진행 중인 일 목록(/routines)에서도 「프로세스」가 켜짐
//   F-NAV-02 휴대폰 390(어두운): 홈 · 채팅 · 프로젝트 · 팀 · 폴더 · 프로세스 — 넘치면 옆으로 밀리는 알약, 「프로세스」를 누르면 그 탭이 알약 안으로
//            들어오고 켜짐
//   F-NAV-03 영어 화면: 마지막 탭은 「Process」
// 자기 스택(lib/localStack.js: 회사 top-tabs-ui 의 BFF + Vite, 8861 · 5261 부터 빈 포트)을 띄우고 지운다. 모델 · 지도 저장소는 부르지 않는다
// (PRO_ONTOLOGY_BOLT_URL= — 지도 없는 회사: 「프로세스」는 목록으로). 사람은 지어낸 것이다(정하윤).
//   cd e2e && RT_WORKERS=1 npx playwright test --project=feature tests/feature/top-tabs.spec.js
import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { startStack, REPO } from '../../lib/localStack.js'

const TENANT = 'top-tabs-ui'
const NOWHERE = 'http://127.0.0.1:9'
const SHOTS = path.join(REPO, 'openspec/specs/top-tabs/e2e/results')
const PC = { viewport: { width: 1280, height: 800 } }
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 }
test.use({ channel: 'chromium' })
test.describe.configure({ mode: 'serial' })

let S = null
let HY = null
test.beforeAll(async () => {
  test.setTimeout(240_000)
  fs.mkdirSync(SHOTS, { recursive: true })
  S = await startStack({ tenant: TENANT, apiFrom: 8861, webFrom: 5261, env: {
    PRO_LLM_BASE_URL: NOWHERE + '/v1', PRO_LLM_API_KEY: 'fake', PRO_LLM_KEYS: 'off',
    PRO_DEEPAGENTS_URL: NOWHERE, PRO_CONTEXT_ROUTER_URL: '', PRO_COMPLETION_URL: NOWHERE, PRO_JUDGE_URL: NOWHERE, PRO_JUDGE_LLM: '0', PRO_EMBED_URL: '',
    PRO_MEMENTO_URL: NOWHERE, PRO_ONTOLOGY_BOLT_URL: '',
  } })
  console.log(`[top-tabs] stack on BFF ${S.apiPort} · web ${S.webPort}`)
  HY = await S.person(`pro-rt-${TENANT}-a@uengine.org`, '정하윤')
  await S.join(HY)
  await S.api(HY.token, '/me/lang', { method: 'PUT', body: { lang: 'ko' } })
})
test.afterAll(async () => {
  if (!S) return
  fs.mkdirSync(path.join(REPO, 'e2e/reports'), { recursive: true })
  fs.writeFileSync(path.join(REPO, 'e2e/reports', `bff-${TENANT}.log`), S.logs.join(''))
  if (HY) {
    await S.q('delete from pro_messages where thread_id in (select id from pro_threads where user_id=$1)', [HY.id]).catch(() => {})
    await S.q('delete from pro_threads where user_id=$1', [HY.id]).catch(() => {})
  }
  await S.q('delete from notifications where tenant_id=$1', [TENANT]).catch(() => {})
  await S.q('delete from pro_team_members where tenant_id=$1', [TENANT]).catch(() => {})
  await S.q('delete from users where tenant_id=$1', [TENANT]).catch(() => {})
  await S.stop()
})

async function open(browser, opts, { theme = 'light', lang = 'ko' } = {}) {
  const ctx = await browser.newContext({ ...opts, baseURL: S.web })
  await ctx.addInitScript(([s, th, lg]) => {
    if (window.top !== window) return
    localStorage.setItem('pgpt-pro-session', s)
    localStorage.setItem('pgpt-pro-theme', th)
    localStorage.setItem('pgl-lang', lg)
    localStorage.setItem('pgl-install', JSON.stringify({ never: true }))
  }, [JSON.stringify(HY.session), theme, lang])
  const p = await ctx.newPage()
  p.errors = []
  p.on('pageerror', (e) => p.errors.push(String(e?.message || e)))
  return p
}
const nav = (p) => p.locator('header.top nav.seg')
const labels = (p) => nav(p).locator('button[data-tab]').evaluateAll((bs) => bs.map((b) => b.textContent.trim()))
const ids = (p) => nav(p).locator('button[data-tab]').evaluateAll((bs) => bs.map((b) => b.dataset.tab))
const proc = (p) => nav(p).locator('button[data-tab="routine"]')
const calm = (p) => p.evaluate(() => Promise.race([Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming?.().iterations !== Infinity).map((a) => a.finished.catch(() => {}))), new Promise((ok) => setTimeout(ok, 1500))]))
async function shot(p, name) { await calm(p); await p.screenshot({ path: path.join(SHOTS, `${name}.png`) }) }

test('F-NAV-01 PC 1280(밝은): 채팅 · 프로젝트 · 팀 · 폴더 · 프로세스 — 「프로세스」는 회사 프로세스(지도 · 진행 중인 일)를 열고 켜진다', async ({ browser }) => {
  const p = await open(browser, PC)
  await p.goto('/chat')
  await expect(nav(p)).toBeVisible({ timeout: 30000 })
  await expect.poll(() => labels(p)).toEqual(['채팅', '프로젝트', '팀', '폴더', '프로세스'])
  expect(await ids(p)).toEqual(['chat', 'project', 'team', 'folders', 'routine'])
  await expect(nav(p).getByText('루틴', { exact: true })).toHaveCount(0)
  await shot(p, 'f-nav-01-pc-chat')
  await proc(p).click()
  // (a company without the map store — this stack — gets the list of its process instances; one with it, the map)
  await expect.poll(() => new URL(p.url()).pathname, { timeout: 15000 }).toMatch(/^\/(process-map|routines)$/)
  await expect(proc(p)).toHaveClass(/\bon\b/)
  await shot(p, 'f-nav-01-pc-process')
  // the other tabs still go where they went, in their new places
  await nav(p).locator('button[data-tab="team"]').click()
  await expect.poll(() => new URL(p.url()).pathname).toBe('/team-activity')
  await nav(p).locator('button[data-tab="folders"]').click()
  await expect.poll(() => new URL(p.url()).pathname).toBe('/folders')
  // a process instance's list, reached any way, lights 「프로세스」
  await p.goto('/routines')
  await expect(proc(p)).toHaveClass(/\bon\b/, { timeout: 15000 })
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-NAV-02 휴대폰 390(어두운): 홈 · 채팅 · 프로젝트 · 팀 · 폴더 · 프로세스 — 「프로세스」를 누르면 알약 안으로 들어와 켜진다', async ({ browser }) => {
  const p = await open(browser, PHONE, { theme: 'dark' })
  await p.goto('/chat')
  await expect(nav(p)).toBeVisible({ timeout: 30000 })
  await expect.poll(() => labels(p)).toEqual(['홈', '채팅', '프로젝트', '팀', '폴더', '프로세스'])
  expect(await p.evaluate(() => document.documentElement.dataset.theme)).toBe('dark')
  await shot(p, 'f-nav-02-phone-chat')
  // a full pill scrolls sideways (2026-11-18 design rule) — the last tab is reached by scrolling, not squeezed
  await proc(p).scrollIntoViewIfNeeded()
  await proc(p).tap()
  await expect.poll(() => new URL(p.url()).pathname, { timeout: 15000 }).toMatch(/^\/(process-map|routines)$/)
  await expect(proc(p)).toHaveClass(/\bon\b/)
  // the chosen tab is inside the pill (brought to view), not cut off at its edge
  await expect.poll(async () => {
    const n = await nav(p).boundingBox(), b = await proc(p).boundingBox()
    return !!n && !!b && b.x >= n.x - 1 && b.x + b.width <= n.x + n.width + 1
  }, { timeout: 5000 }).toBe(true)
  await shot(p, 'f-nav-02-phone-process')
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-NAV-03 영어 화면: 마지막 탭은 「Process」', async ({ browser }) => {
  await S.api(HY.token, '/me/lang', { method: 'PUT', body: { lang: 'en' } })
  try {
    const p = await open(browser, PC, { lang: 'en' })
    await p.goto('/chat')
    await expect(nav(p)).toBeVisible({ timeout: 30000 })
    await expect.poll(async () => (await labels(p)).at(-1), { timeout: 15000 }).toBe('Process')
    expect((await labels(p)).slice(0, 2)).toEqual(['Chat', 'Projects'])
    expect(await ids(p)).toEqual(['chat', 'project', 'team', 'folders', 'routine'])
    await shot(p, 'f-nav-03-pc-english')
    expect(p.errors).toEqual([])
    await p.context().close()
  } finally {
    await S.api(HY.token, '/me/lang', { method: 'PUT', body: { lang: 'ko' } })
  }
})
