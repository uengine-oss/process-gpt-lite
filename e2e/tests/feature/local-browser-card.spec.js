// PC 의 브라우저에서 도는 작업의 카드와 설정(스펙 browser-handoff 「브라우저 작업은 내 PC에서」 — 2026-11-25 검토에서 나온 것들).
// 모델 · 데스크톱 없이 고정 카드로: 단추가 무엇을 보내는지는 page.route 로 받아 본다.
//   F-LB-01 휴대폰(390): PC 에서 도는 카드 — 「내 PC · 테스트 맥」, 확장 화면의 단추줄은 「직접 제어」 하나 → 누르면 「제어 돌려주기」 하나
//           (둘이 함께 보이지 않는다 — 검토 4), 「이 PC에서 보기」는 /api/browser/show 로 그 작업을
//   F-LB-02 PC 연결이 끊긴 카드 — 「서버에서 이어서」 · 「PC가 다시 켜지면」 · 「멈추기」, 확장 화면에는 「서버에서 이어서」만(직접 제어 · 제어 돌려주기 없음),
//           단추는 /api/browser/route 로 { taskId, to }
//   F-LB-03 웹(휴대폰)의 설정은 읽기만: 내가 시킨 작업 · 단계 · 예약 작업이 지금 어디서 도는지와 PC 마다의 설정, 바꾸는 칸은 없다(바꾸기는 그 PC 의 앱에서)
//   F-LB-04 PC 에서 사람이 필요한 채로 끝난 카드(pcKept): 「다시 시도」 옆에 「이 PC에서 보기」 → /api/browser/show 로 그 작업, 이유는 「직접 제어」가 아니라
//           「이 PC에서 보기」를 말한다 · 다른 작업이 그 브라우저를 쓰면(pcKept: false) 단추가 없다 (2026-11-25 재검토 N4)
//   cd e2e && PGPT_URL=http://127.0.0.1:5273 API_URL=http://127.0.0.1:8873 npx playwright test --project=feature tests/feature/local-browser-card.spec.js
import fs from 'node:fs'
import path from 'node:path'
import { test, expect } from '../../lib/fixtures.js'
import { PNG } from '../../lib/seed.js'

const PHONE = { viewport: { width: 390, height: 844 } }
const shot = PNG(640, 400, [40, 120, 200]).toString('base64')
const steps = [{ text: '상점 열기', done: true }, { text: '찾기', done: false }]
const onPc = { kind: 'local', device: '테스트 맥', deviceId: 'dev-1' }
async function photo(page, testInfo, name) {
  const dir = process.env.LB_SHOTS || testInfo.outputDir
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${name}.png`)
  await page.screenshot({ path: file })
  await testInfo.attach(name, { path: file, contentType: 'image/png' })
}
const toChat = (page) => page.locator('button, a').filter({ hasText: /^채팅$/ }).first().click()
// requests the card's buttons send, answered here
function listen(page) {
  const sent = []
  page.route(/\/api\/browser\/(show|route|resume)$/, (route) => {
    const r = route.request()
    sent.push([r.url().split('/').pop(), r.postDataJSON()])
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) })
  })
  return sent
}

test.describe('PC 의 브라우저에서 도는 작업 · 카드와 설정', () => {
  test('F-LB-01 휴대폰: 「내 PC · 테스트 맥」 — 확장 화면의 단추는 「직접 제어」 또는 「제어 돌려주기」 하나, 「이 PC에서 보기」는 그 작업으로', async ({ pageAs, db }, testInfo) => {
    const page = await pageAs('lb-card-running', PHONE)
    const th = await db.clearMain(page.user.id)
    const [, task] = await db.addMessages(th, [
      { role: 'user', kind: 'text', content: { text: '가상 상점에서 가상 사과 찾아 줘' } },
      { role: 'agent', kind: 'task', content: { title: '가상 상점에서 찾기', goal: 'g', steps, state: 'running', shot, where: onPc } },
    ])
    const sent = listen(page)
    await page.goto('/chat')
    await toChat(page)
    const card = page.locator(`.row[data-id="${task.id}"]`)
    await expect(card.getByTestId('task-where')).toHaveText('내 PC · 테스트 맥', { timeout: 20_000 })
    await card.getByRole('button', { name: '확장' }).click()
    const full = page.locator('.handoff')
    await expect(full).toBeVisible()
    const take = full.getByTestId('task-take-control'), give = full.getByTestId('task-give-back')
    await expect(take).toHaveText('직접 제어')
    await expect(give).toHaveCount(0)
    await expect(full.getByTestId('task-to-server')).toHaveCount(0)
    await expect(full.getByTestId('task-show-pc')).toHaveText('이 PC에서 보기')
    await photo(page, testInfo, 'lb-f01-full-running')
    await take.click()
    await expect(give).toHaveText('제어 돌려주기')
    await expect(take).toHaveCount(0)
    await give.click()
    await expect(take).toBeVisible()
    await expect(give).toHaveCount(0)
    await full.getByTestId('task-show-pc').click()
    await expect.poll(() => sent.length).toBe(2)
    expect(sent[0][0]).toBe('resume')
    expect(sent[1]).toEqual(['show', { taskId: task.id }])
    expect(page.errors).toEqual([])
  })

  test('F-LB-02 PC 연결이 끊긴 카드: 「서버에서 이어서」 · 「PC가 다시 켜지면」 · 「멈추기」, 확장 화면에는 「서버에서 이어서」만', async ({ pageAs, db }, testInfo) => {
    const page = await pageAs('lb-card-offline', PHONE)
    const th = await db.clearMain(page.user.id)
    const reason = '「테스트 맥」의 PC 앱 연결이 끊겨 브라우저 작업을 멈췄어요. 「서버에서 이어서」를 누르면 서버 브라우저가 지금 페이지부터 이어서 해요.'
    const [, task] = await db.addMessages(th, [
      { role: 'user', kind: 'text', content: { text: '가상 상점에서 가상 배 찾아 줘' } },
      { role: 'agent', kind: 'task', content: { title: '가상 상점에서 찾기', goal: 'g', steps, state: 'needs_input', need: 'offline', reason, site: '127.0.0.1', shot, where: onPc,
        offline: { device: '테스트 맥', since: new Date().toISOString(), waiting: false } } },
    ])
    const sent = listen(page)
    await page.goto('/chat')
    await toChat(page)
    const card = page.locator(`.row[data-id="${task.id}"]`)
    await expect(card.getByTestId('task-reason')).toHaveText(reason, { timeout: 20_000 })
    const acts = card.locator('.ask button')
    await expect(acts).toHaveText(['서버에서 이어서', 'PC가 다시 켜지면', '멈추기'])
    await photo(page, testInfo, 'lb-f02-offline-card')
    await acts.nth(1).click()
    await expect.poll(() => sent.length).toBe(1)
    expect(sent[0]).toEqual(['route', { taskId: task.id, to: 'wait' }])
    // the full view: only the way on that works with the PC off
    await card.locator('.attn').click()
    const full = page.locator('.handoff')
    await expect(full.getByTestId('task-to-server')).toHaveText('서버에서 이어서')
    await expect(full.getByTestId('task-take-control')).toHaveCount(0)
    await expect(full.getByTestId('task-give-back')).toHaveCount(0)
    await photo(page, testInfo, 'lb-f02-offline-full')
    await full.getByTestId('task-to-server').click()
    await expect.poll(() => sent.length).toBe(2)
    expect(sent[1]).toEqual(['route', { taskId: task.id, to: 'server' }])
    expect(page.errors).toEqual([])
  })

  test('F-LB-04 PC 에서 사람이 필요한 채로 끝난 카드: 「다시 시도」 · 「이 PC에서 보기」, 다른 작업이 브라우저를 쓰면 「이 PC에서 보기」는 없다', async ({ pageAs, db }, testInfo) => {
    const page = await pageAs('lb-card-kept', PHONE)
    const th = await db.clearMain(page.user.id)
    const reason = '브라우저에서 아무 동작도 하지 못하고 끝났어요. 같은 말로 다시 시키거나, 카드의 「이 PC에서 보기」로 그 PC 에 열어 둔 페이지를 확인해 주세요.'
    const ended = (pcKept) => ({ title: '가상 상점에서 찾기', goal: 'g', steps, state: 'needs_review', need: 'other', reason, summary: reason, shot, where: onPc, pcKept })
    const [, kept, gone] = await db.addMessages(th, [
      { role: 'user', kind: 'text', content: { text: '가상 상점에서 가상 귤 찾아 줘' } },
      { role: 'agent', kind: 'task', content: ended(true) },
      { role: 'agent', kind: 'task', content: { ...ended(false), title: '다른 작업' } },
    ])
    const sent = listen(page)
    await page.goto('/chat')
    await toChat(page)
    const card = page.locator(`.row[data-id="${kept.id}"]`)
    await expect(card.getByTestId('task-reason')).toHaveText(reason, { timeout: 20_000 })
    await expect(card.locator('.ask button')).toHaveText(['다시 시도', '이 PC에서 보기'])
    await expect(page.locator(`.row[data-id="${gone.id}"] .ask button`)).toHaveText(['다시 시도'])
    await card.scrollIntoViewIfNeeded()
    await photo(page, testInfo, 'lb-f04-kept-card')
    await card.locator('.ask button', { hasText: '이 PC에서 보기' }).click()
    await expect.poll(() => sent.length).toBe(1)
    expect(sent[0]).toEqual(['show', { taskId: kept.id }])
    expect(page.errors).toEqual([])
  })

  test('F-LB-03 웹의 설정은 읽기만 — 지금 어디서 도는지와 PC 마다의 설정, 바꾸기는 그 PC 의 앱에서', async ({ pageAs }, testInfo) => {
    const page = await pageAs('lb-settings-web', PHONE)
    await page.route(/\/api\/browser\/where$/, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      own: { where: 'local', why: null, device: { id: 'dev-1', name: '테스트 맥' } },
      unattended: { where: 'local', why: null, device: { id: 'dev-2', name: '사무실 PC' } },
      devices: [
        { id: 'dev-1', name: '테스트 맥', browser: true, pref: 'own', enabled: true },
        { id: 'dev-2', name: '사무실 PC', browser: true, pref: 'all', enabled: true },
        { id: 'dev-3', name: '집 노트북', browser: true, pref: 'all', enabled: false },
        { id: 'dev-4', name: '옛 PC', browser: false, pref: 'own', enabled: true },
      ],
      min: '0.2.3',
    }) }))
    await page.goto('/settings/accounts')
    const box = page.locator('[data-test=browser-local]')
    await expect(box).toBeVisible({ timeout: 20_000 })
    await expect(box.locator('[data-test=browser-local-own]')).toContainText('「테스트 맥」의 브라우저에서 해요')
    await expect(box.locator('[data-test=browser-local-unattended]')).toContainText('「사무실 PC」의 브라우저에서 해요')
    await expect(box.locator('[data-browser-device]')).toHaveCount(3)
    await expect(box.locator('[data-browser-device="dev-1"]')).toContainText('내가 시킨 작업만 — 바꾸기는 그 PC 의 앱에서')
    await expect(box.locator('[data-browser-device="dev-2"]')).toContainText('단계 · 예약 작업까지 모두')
    await expect(box.locator('[data-browser-device="dev-3"]')).toContainText('이 컴퓨터에서 단계 실행을 꺼서 쓰지 않음')
    await expect(page.locator('[data-test=local-browser-pref]')).toHaveCount(0)
    await expect(box.locator('input, select')).toHaveCount(0)
    await box.scrollIntoViewIfNeeded()
    await photo(page, testInfo, 'lb-f03-settings-web')
    // the server's browser for both, and why
    await page.unroute(/\/api\/browser\/where$/)
    await page.route(/\/api\/browser\/where$/, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      own: { where: 'server', why: 'off', device: null }, unattended: { where: 'server', why: 'not-own', device: null },
      devices: [{ id: 'dev-1', name: '테스트 맥', browser: true, pref: 'off', enabled: true }], min: '0.2.3' }) }))
    await page.reload()
    await expect(box.locator('[data-test=browser-local-own]')).toContainText('PC 앱에서 「브라우저 작업은 이 PC에서」를 껐어요', { timeout: 20_000 })
    await expect(box.locator('[data-test=browser-local-unattended]')).toContainText('「단계 · 예약 작업까지 모두」를 고른 PC 에서만')
    await expect(box.locator('[data-browser-device="dev-1"]')).toContainText('쓰지 않음')
    expect(page.errors).toEqual([])
  })
})
