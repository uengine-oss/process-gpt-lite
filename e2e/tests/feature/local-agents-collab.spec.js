// Working together on someone's local run (spec openspec/specs/local-agents — the heart of it). Fictional people:
//   윤태호 — his PC (the desktop app's own runner, fake Claude Code) runs 「견적서 작성」 with the company skill 「견적-규칙」
//   서하린 — a participant of the instance, on a phone (390px browser): watches his CLI's own terminal live (the same screen as his —
//            read only: no cursor, no keys) and suggests a prompt — she has no send into his CLI (and the server refuses one: 403)
//   윤태호 at his desk (a 1280px browser — his run view: the CLI's output, then its input) sees her suggestion stacked at the input, loads it,
//            edits it and puts it in: it reaches his CLI as 「서하린 제안 · 윤태호 입력」; her phone shows it used
//   then the result goes onto the instance line, 서하린's next step runs on her own PC from it, and what the run learned is proposed and
//   윤태호 (the process's owner) applies it into the activity, with where it came from
// (the user's rule, 2026-11-24: 「타인이 의견을 넣을 수 있다(프롬프트) … 입력란에 추천으로 쌓인다 … 입력버튼으로 실제 입력시키는 당사자는 해당 cli를 가진
// 사람만」). It starts its own stack (lib/localStack.js: a BFF in tenant localagent-collab and Vite, on free ports). No model.
//   cd e2e && npx playwright test --project=feature tests/feature/local-agents-collab.spec.js
import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { startStack, SHOTS, waitFor } from '../../lib/localStack.js'

test.describe.configure({ mode: 'serial' })
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ko-KR' }
const DESK = { viewport: { width: 1280, height: 860 }, locale: 'ko-KR' }
let S, TH, HR, OUT, inst, pcT, pcH
const ACTS = [
  // (short sleeps: a steer is taken between two of them, as Claude Code takes it after the tool call at hand)
  { id: 'quote', name: '견적서 작성', skills: ['견적-규칙'], instruction: `SLEEP 3000\nWRITE_OUT 견적서.md :: 견적 초안 — 윤태호의 PC\nSLEEP 3000\nWRITE_OUT 비고.md :: 비고\n${'SLEEP 1500\n'.repeat(24)}WRITE_OUT 마무리.md :: 마무리` },
  { id: 'review', name: '견적 검토', instruction: 'READ 산출물/01_견적서 작성/견적서.md\nREAD 산출물/01_견적서 작성/하린.md\nWRITE_OUT 검토.md :: 검토 — 서하린의 PC' },
]
async function page(browser, who, opts) {
  const ctx = await browser.newContext({ ...opts, baseURL: S.web })
  await ctx.addInitScript((s) => { if (window.top === window) localStorage.setItem('pgpt-pro-session', s) }, JSON.stringify(who.session))
  const p = await ctx.newPage()
  p.errors = []
  p.on('pageerror', (e) => p.errors.push(String(e?.message || e)))
  p.navs = 0
  p.on('framenavigated', (f) => { if (f === p.mainFrame()) p.navs++ })
  return p
}
const noOverflow = (p) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
const card = (p, jobId) => p.locator(`[data-test=local-runs] [data-test=local-run][data-job="${jobId}"]`)

test.beforeAll(async () => {
  test.setTimeout(240_000)
  fs.mkdirSync(SHOTS, { recursive: true })
  S = await startStack({ tenant: 'localagent-collab', apiFrom: 8891, webFrom: 5291 })
  TH = await S.person('pro-rt-local-collab-t@uengine.org', '윤태호')
  HR = await S.person('pro-rt-local-collab-h@uengine.org', '서하린')
  OUT = await S.person('pro-rt-local-collab-o@uengine.org', '도외부')
  for (const p of [TH, HR]) await S.join(p)
  await S.skill('견적-규칙', '---\nname: 견적-규칙\ndescription: 견적서는 부가세 포함 금액으로\n---\n금액은 늘 부가세 포함으로 적는다.\n')
  inst = await S.instance('세미나 견적 — 달빛커피(함께)', ACTS, [TH, HR], { owner: TH.id })
  pcT = await S.pc(TH, { name: '윤태호의 맥' })
  pcH = await S.pc(HR, { name: '서하린의 맥' })
})
test.afterAll(async () => { for (const r of [pcT, pcH]) try { r?.stop() } catch { /* gone */ } await S?.stop() })

let job1
test('C-01 서하린이 휴대폰에서 제안 → 윤태호의 입력란에 쌓임 → 윤태호가 골라 고쳐 입력 → 윤태호의 CLI 에 닿고, 서하린의 화면은 「입력함」', async ({ browser }) => {
  const t1 = await inst.step(ACTS[0], TH, { agent: 'claude-code', offline: 'wait' })
  job1 = await waitFor(async () => { const j = await S.jobOf(t1); return j?.state === 'running' ? j : null }, 20000, 'running')
  const phone = await page(browser, HR, PHONE)
  const desk = await page(browser, TH, DESK)
  await phone.goto(`/projects/p/${encodeURIComponent(inst.inst)}`)
  await desk.goto(`/routines/${encodeURIComponent(inst.inst)}`)
  const onPhone = card(phone, job1.id)
  const onDesk = card(desk, job1.id)
  // 서하린 sees 윤태호's run live: who, where, the step — and his CLI's terminal itself (the company skill it got, its tool lines growing,
  // no reload); hers is read only (no cursor, no keys), his takes his typing
  await expect(onPhone.locator('[data-test=local-run-who]')).toContainText('윤태호 · 윤태호의 맥', { timeout: 20000 })
  const termPhone = onPhone.locator('[data-test=local-run-terminal]')
  const termDesk = onDesk.locator('[data-test=local-run-terminal]')
  await expect(termPhone.locator('.xterm-rows')).toContainText('보이는 스킬: 견적-규칙', { timeout: 20000 })
  const navs = phone.navs
  await expect(termPhone.locator('.xterm-rows')).toContainText('Write(산출물/01_견적서 작성/견적서.md)', { timeout: 15000 })
  expect(phone.navs).toBe(navs)
  await expect(termPhone).toHaveAttribute('data-owner', 'no')
  await expect(termPhone.locator('[data-test=local-run-keys]')).toHaveCount(0)
  await expect(termDesk).toHaveAttribute('data-owner', 'yes', { timeout: 15000 })
  // the same screen on both (the relayed bytes of his desktop's terminal)
  const rows = (t) => t.locator('.xterm-rows').evaluate((e) => [...e.children].map((r) => r.textContent.replace(/\u00a0/g, ' ').trimEnd()).join('\n'))
  await expect.poll(async () => { const [a, b] = [await rows(termPhone), await rows(termDesk)]; return a.includes('견적서.md') && a === b }, { timeout: 15000 }).toBe(true)
  // she has no send into his CLI — only a line to suggest; the server refuses her steer too
  await expect(onPhone.locator('[data-test=local-run-steer]')).toHaveCount(0)
  await expect(onPhone.locator('[data-test=local-run-steer-send]')).toHaveCount(0)
  await expect(onPhone.locator('[data-test=local-run-no-steer]')).toContainText('입력은 윤태호님만 해요')
  await expect(S.api(HR.token, `/local-agents/jobs/${job1.id}/steer`, { method: 'POST', body: { text: '몰래 입력' } })).rejects.toMatchObject({ status: 403 })
  await onPhone.locator('[data-test=local-run-suggest]').fill('WRITE_OUT 하린.md :: 서하린의 제안 — 할인 줄을 따로')
  await onPhone.locator('[data-test=local-run-suggest-send]').click()
  const mineOnPhone = onPhone.locator('[data-test=local-run-suggestions] li').first()
  await expect(mineOnPhone).toHaveAttribute('data-suggestion-state', 'waiting')
  await expect(mineOnPhone).toContainText('입력 기다림')
  expect(await noOverflow(phone)).toBe(true)
  await onPhone.scrollIntoViewIfNeeded()
  await phone.screenshot({ path: path.join(SHOTS, 'c01-phone-suggest.png') })
  // a second one she suggests, which he will drop
  await onPhone.locator('[data-test=local-run-suggest]').fill('목차를 맨 앞에')
  await onPhone.locator('[data-test=local-run-suggest-send]').click()
  // his run view: the suggestions stacked at the CLI's input (pushed), with who wrote each; his Home has the card
  const stacked = onDesk.locator('[data-test=local-run-suggestions] li[data-suggestion-state=waiting]')
  await expect(stacked).toHaveCount(2, { timeout: 10000 })
  await expect(stacked.first()).toContainText('서하린')
  const [n] = await S.q(`select title from notifications where user_id=$1 and type='local_suggestion' order by time_stamp`, [TH.id])
  expect(n.title).toMatch(/서하린의 제안 · 견적서 작성/)
  await onDesk.locator('[data-test=local-run-term]').scrollIntoViewIfNeeded()
  await desk.screenshot({ path: path.join(SHOTS, 'c01-desk-stacked.png') })
  // he drops the second, loads the first into his input, edits it, sends it
  await stacked.nth(1).locator('[data-test=local-run-suggestion-dismiss]').click()
  await stacked.first().locator('[data-test=local-run-suggestion-load]').click()
  const line = onDesk.locator('[data-test=local-run-steer]')
  await expect(line).toHaveValue('WRITE_OUT 하린.md :: 서하린의 제안 — 할인 줄을 따로')
  await expect(onDesk.locator('[data-test=local-run-loaded]')).toContainText('서하린의 제안을 입력란에 넣었어요')
  await line.fill('WRITE_OUT 하린.md :: 서하린의 제안 — 할인 줄을 따로(윤태호가 고침)')
  await onDesk.locator('[data-test=local-run-steer-send]').click()
  const went = onDesk.locator('[data-test=local-run-steers] li').first()
  await expect(went).toContainText('서하린 제안 · 윤태호 입력')
  await expect(went).toHaveAttribute('data-steer-state', 'applied', { timeout: 20000 })
  // typed into his CLI's terminal as he would paste it — and her phone shows the CLI taking it (its Write of 하린.md)
  await expect(termPhone.locator('.xterm-rows')).toContainText('Write(산출물/01_견적서 작성/하린.md)', { timeout: 15000 })
  await desk.screenshot({ path: path.join(SHOTS, 'c01-desk-sent.png') })
  // the edited words reached his CLI (the runner's log, the CLI's own input)
  expect(pcT.log.some((l) => l.includes('steer from 윤태호') && l.includes('윤태호가 고침'))).toBe(true)
  const cli = fs.readFileSync(S.fakeEnv.FAKE_CLI_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  expect(cli.some((x) => x.received?.includes('할인 줄을 따로(윤태호가 고침)'))).toBe(true)
  expect(cli.some((x) => x.received?.includes('목차를 맨 앞에'))).toBe(false)
  expect(cli.some((x) => Array.isArray(x.skills) && x.skills.includes('견적-규칙'))).toBe(true)
  // her phone shows hers used (edited), the other dropped; she hears of it
  await expect(onPhone.locator('[data-test=local-run-suggestions] li').first()).toHaveAttribute('data-suggestion-state', 'used', { timeout: 10000 })
  await expect(onPhone.locator('[data-test=local-run-suggestions] li').first()).toContainText('윤태호가 고쳐서 입력함')
  await expect(onPhone.locator('[data-test=local-run-suggestions] li').nth(1)).toHaveAttribute('data-suggestion-state', 'dismissed')
  await expect(onPhone.locator('[data-test=local-run-steers] li').first()).toContainText('서하린 제안 · 윤태호 입력')
  const [u] = await S.q(`select title from notifications where user_id=$1 and type='local_suggestion_used'`, [HR.id])
  expect(u.title).toMatch(/제안이 입력됐어요/)
  expect(await noOverflow(phone)).toBe(true)
  await phone.screenshot({ path: path.join(SHOTS, 'c01-phone-used.png') })
  // someone outside the instance can do neither
  await expect(S.api(OUT.token, `/local-agents/jobs/${job1.id}/suggestions`, { method: 'POST', body: { text: '외부' } })).rejects.toMatchObject({ status: 403 })
  const done = await S.settled(t1)
  expect(done.state, done.error || '').toBe('done')
  expect(done.result.files).toEqual(expect.arrayContaining(['산출물/01_견적서 작성/하린.md']))
  expect(done.result.files.some((f) => f.startsWith('.claude'))).toBe(false)
  for (const p of [phone, desk]) expect(p.errors).toEqual([])
})

test('C-02 서하린의 다음 단계: 서하린의 PC 가 윤태호의 결과를 먼저 받아 시작한다', async () => {
  const t2 = await inst.step(ACTS[1], HR, { agent: 'claude-code', offline: 'wait' })
  const j = await S.settled(t2)
  expect(j.state, j.error || '').toBe('done')
  expect(String(j.device_name)).toBe('서하린의 맥')
  expect(j.result.summary).toContain('견적 초안 — 윤태호의 PC')
  expect(j.result.summary).toContain('서하린의 제안 — 할인 줄을 따로(윤태호가 고침)')
})

test('C-03 실행에서 배운 것: 후보로만 올라오고, 프로세스 담당자(윤태호)가 반영하면 출처와 함께 활동의 정의에', async ({ browser }) => {
  const j = await waitFor(async () => { const x = await S.jobOf(job1.todo_id); return x.knowhow?.length ? x : null }, 15000, 'know-how')
  expect(j.knowhow.every((k) => k.state === 'proposed')).toBe(true)
  const phone = await page(browser, HR, PHONE)
  await phone.goto(`/routines/${encodeURIComponent(inst.inst)}`)
  const hk = card(phone, job1.id).locator('[data-test=local-run-knowhow]')
  await expect(hk).toContainText('윤태호의 로컬 실행에서 배움', { timeout: 15000 })
  await expect(hk.locator('[data-test=local-run-knowhow-apply]')).toHaveCount(0)
  const desk = await page(browser, TH, DESK)
  await desk.goto(`/routines/${encodeURIComponent(inst.inst)}`)
  const tk = card(desk, job1.id).locator('[data-test=local-run-knowhow] li', { hasText: '하린.md' })
  await expect(tk).toContainText('실행 중 조종 → 이 일의 방식', { timeout: 15000 })
  await expect(tk).toContainText('서하린 제안 · 윤태호 입력')
  await tk.locator('[data-test=local-run-knowhow-apply]').click()
  await expect(tk).toHaveAttribute('data-k-state', 'applied', { timeout: 10000 })
  await expect(tk).toContainText('이 일의 정의에 반영함')
  await card(desk, job1.id).locator('[data-test=local-run-knowhow]').scrollIntoViewIfNeeded()
  await desk.waitForTimeout(1200) // (the card settles after the push)
  await desk.screenshot({ path: path.join(SHOTS, 'c03-desk-knowhow.png') })
  const [d] = await S.q('select definition from proc_def where id=$1', [inst.def])
  expect(d.definition.activities.find((a) => a.id === 'quote').instruction).toMatch(/## 배운 것\n- WRITE_OUT 하린\.md :: 서하린의 제안 — 할인 줄을 따로\(윤태호가 고침\) — 윤태호의 로컬 실행에서 배움/)
  // 윤태호's Home: the card that asks him to decide
  const [n] = await S.q(`select title from notifications where user_id=$1 and type='local_knowhow'`, [TH.id])
  expect(n.title).toMatch(/배운 것 \d+개 · 견적서 작성/)
  for (const p of [phone, desk]) expect(p.errors).toEqual([])
})
