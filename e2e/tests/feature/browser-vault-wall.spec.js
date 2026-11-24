// 로그인 벽에서 보관함 먼저 — 2026-11-24 휴대폰 사진(네이버 예약 → nid.naver.com 로그인, 「직접 로그인」만): 「로그인이 왜 vault 를
// 이용하여 암호관리를 호출하지 않는것인가」(스펙 browser-handoff 「로그인 벽에서는 보관함부터」). 작업 카드가 어느 길로 가는지 휴대폰(390)에서:
//   F-LV-01 보관함의 로그인으로 들어가는 중 · naver.com — 채팅의 카드와 확장 화면에 한 줄(가려지지 않고 잘리지 않음)
//   F-LV-02 저장된 로그인이 없음 — 이유 · 「직접 로그인」 · 「로그인 정보 저장」(보관함 카드로) · 「멈추기」, 확장(직접 제어) 화면에서도
//           보관함 카드가 이유 아래에 화면 안으로
//   F-LV-03 저장된 비밀번호가 틀림 — 이유와 보관함의 고침 카드(새 비밀번호 · 다시 로그인)
//   F-LV-04 넣은 뒤 추가 확인 — 저장된 로그인으로 해 봤다는 말과 막는 것, 「직접 로그인」
// 서버의 실제 흐름(채우기 · 보내기 · 판정 · 카드)은 server/test/browser-wall-vault.e2e.mjs 가 진짜 Chromium 으로 확인한다. 여기서는 그
// 카드 내용을 DB 에 두고 화면만 본다(모델 없음). 휴대폰 사진은 LV_SHOTS=<폴더>.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { test, expect } from '../../lib/fixtures.js'
import { PNG } from '../../lib/seed.js'

const PHONE = { viewport: { width: 390, height: 844 }, touch: true }
const shot = PNG(640, 400, [235, 240, 248]).toString('base64')
const steps = [{ text: '네이버 예약 열기', done: false }, { text: '로그인', done: false }, { text: '예약 내역 확인', done: false }, { text: '알려 주기', done: false }]
const base = { title: '네이버 예약 내역 확인', goal: '네이버 예약에서 이번 달 예약 내역 알려 줘', steps, shot, url: 'https://nid.naver.com/nidlogin.login', site: 'nid.naver.com', siteName: '네이버' }
const REASON = {
  offer: '이 브라우저에서 네이버에 한 번 로그인해야 이어서 진행할 수 있어요. 카드에 로그인 정보를 저장하면 제가 입력해 로그인해요. 「직접 로그인」을 눌러 직접 해도 돼요. 직접 입력한 로그인 정보도 보관함에 저장할 수 있어요. 다음부터는 제가 입력해요.',
  rejected: '보관함에 저장된 비밀번호로 네이버에 로그인하지 못했어요. 네이버에서 비밀번호가 맞지 않는다고 해요. 카드에서 비밀번호를 고쳐 저장하면 다시 로그인해 이어서 진행해요. 「직접 로그인」으로 직접 로그인해도 돼요.',
  check: '보관함에 저장된 로그인 정보로 네이버에 로그인하려 했는데, 네이버에서 사람인지 확인하는 절차를 추가로 요구해요. 「직접 로그인」을 눌러 로그인을 마치면 이어서 진행해요.',
}

async function photo(page, testInfo, name) {
  const dir = process.env.LV_SHOTS || testInfo.outputDir
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${name}.png`)
  await page.screenshot({ path: file })
  await testInfo.attach(name, { path: file, contentType: 'image/png' })
}
// inside the phone's width, and nothing makes the chat scroll sideways
async function fitsPhone(page, loc) {
  const b = await loc.boundingBox()
  expect(b.x).toBeGreaterThanOrEqual(0)
  expect(b.x + b.width).toBeLessThanOrEqual(390.5)
  const over = await page.evaluate(() => Math.max(...[...document.querySelectorAll('.msgs, .handoff')].map((m) => m.scrollWidth - m.clientWidth), 0))
  expect(over).toBeLessThanOrEqual(0)
}
const toChat = (page) => page.locator('button, a').filter({ hasText: /^채팅$/ }).first().click()
async function seed(db, page, content, vaultCard) {
  const th = await db.clearMain(page.user.id)
  const [, task] = await db.addMessages(th, [
    { role: 'user', kind: 'text', content: { text: base.goal } },
    { role: 'agent', kind: 'task', content: { ...base, ...content } },
  ])
  const [vault] = vaultCard ? await db.addMessages(th, [{ role: 'agent', kind: 'vault', content: { ...vaultCard, taskId: task.id, state: 'pending' } }]) : []
  return { task, vault }
}

test.describe('로그인 벽 · 보관함 먼저 (휴대폰 390)', () => {
  test('F-LV-01 보관함의 로그인으로 들어가는 중 · naver.com — 채팅 카드와 확장 화면에 한 줄', async ({ pageAs, db }, testInfo) => {
    const page = await pageAs('lv-signing', PHONE)
    const { task } = await seed(db, page, { state: 'running', signingIn: { via: 'vault', site: 'naver.com' } })
    await page.goto('/chat')
    await toChat(page)
    const card = page.locator(`.row[data-id="${task.id}"]`)
    const line = card.getByTestId('task-vault-signin')
    await expect(line).toBeVisible({ timeout: 20_000 })
    await expect(line.locator('.why')).toHaveText(/보관함의 로그인으로 들어가는 중\s*· naver\.com/)
    await expect(line).toContainText('비밀번호는 화면에도 AI에도 보이지 않아요')
    await line.scrollIntoViewIfNeeded()
    await fitsPhone(page, line)
    await photo(page, testInfo, 'lv01-signing-390')
    // the full view says it too
    await card.getByRole('button', { name: '확장' }).click()
    const full = page.locator('.handoff')
    await expect(full.getByTestId('task-vault-signin')).toBeVisible()
    await page.waitForTimeout(500) // (the full view pops in)
    await fitsPhone(page, full.getByTestId('task-vault-signin'))
    await photo(page, testInfo, 'lv01-signing-full-390')
    // signed in (the server clears content.signingIn): the line goes
    await page.locator('.handoff .x').click()
    expect(page.errors).toEqual([])
  })

  test('F-LV-02 저장된 로그인이 없음 — 「직접 로그인」 · 「로그인 정보 저장」(보관함 카드로) · 「멈추기」, 직접 제어 화면에도 보관함 카드가 이유 아래에', async ({ pageAs, db }, testInfo) => {
    const page = await pageAs('lv-offer', PHONE)
    const { task, vault } = await seed(db, page, { state: 'needs_input', need: 'login', reason: REASON.offer }, { kind: 'login', site: 'nid.naver.com', mode: 'request' })
    await page.goto('/chat')
    await toChat(page)
    const card = page.locator(`.row[data-id="${task.id}"]`)
    const ask = card.getByTestId('task-ask')
    await expect(ask).toBeVisible({ timeout: 20_000 })
    await expect(card.locator('.attn')).toContainText('로그인 필요 · 네이버')
    await expect(ask.getByTestId('task-reason')).toHaveText(REASON.offer)
    const [login, save, stop] = [ask.getByTestId('task-login'), ask.getByTestId('task-save'), ask.getByTestId('task-stop')]
    await expect(login).toHaveText('직접 로그인')
    await expect(save).toHaveText('로그인 정보 저장')
    await expect(stop).toHaveText('멈추기')
    await ask.scrollIntoViewIfNeeded()
    for (const b of [ask, login, save, stop]) await fitsPhone(page, b)
    await photo(page, testInfo, 'lv02-offer-390')
    // 「로그인 정보 저장」 → the vault's card, on screen
    await save.click()
    const vcard = page.locator(`.row[data-id="${vault.id}"]`)
    await expect(vcard.locator('form.vault')).toBeInViewport({ timeout: 5000 })
    await expect(vcard).toContainText('Naver 로그인 정보를 입력하면 암호화된 보관함에 저장하고 바로 이어서 진행해요.')
    await expect(vcard.getByPlaceholder('이메일 또는 아이디')).toBeVisible()
    await fitsPhone(page, vcard.locator('form.vault'))
    await photo(page, testInfo, 'lv02-offer-card-390')
    // 「직접 로그인」 → the full view with control on: the reason, then the vault's card under it, all on the phone
    await login.click()
    const full = page.locator('.handoff')
    await expect(full).toBeVisible()
    await expect(full.locator('.pill.on')).toHaveText(/제어 돌려주기/)
    await expect(full.getByTestId('takeover-kbd')).toBeVisible()
    const reason = full.locator('.reason'), fv = full.locator('.vault form.vault')
    await expect(reason).toHaveText(REASON.offer)
    await expect(fv).toBeVisible()
    await page.waitForTimeout(600) // (the full view pops in)
    await fitsPhone(page, fv)
    expect((await fv.boundingBox()).y).toBeGreaterThanOrEqual((await reason.boundingBox()).y + (await reason.boundingBox()).height - 1)
    await fv.scrollIntoViewIfNeeded()
    await expect(fv.getByRole('button', { name: '로그인' })).toBeInViewport()
    await photo(page, testInfo, 'lv02-offer-full-390')
    expect(page.errors).toEqual([])
  })

  test('F-LV-03 저장된 비밀번호가 틀림 — 이유와 보관함의 고침 카드(새 비밀번호 · 다시 로그인)', async ({ pageAs, db }, testInfo) => {
    const page = await pageAs('lv-rejected', PHONE)
    const { task, vault } = await seed(db, page, { state: 'needs_input', need: 'login', reason: REASON.rejected },
      { kind: 'login', site: 'nid.naver.com', mode: 'update', itemId: crypto.randomUUID(), label: 'fixture-user', reason: '' })
    await page.goto('/chat')
    await toChat(page)
    const card = page.locator(`.row[data-id="${task.id}"]`)
    const ask = card.getByTestId('task-ask')
    await expect(ask.getByTestId('task-reason')).toHaveText(REASON.rejected, { timeout: 20_000 })
    await expect(ask.getByTestId('task-login')).toHaveText('직접 로그인')
    await expect(ask.getByTestId('task-save')).toHaveCount(0)
    await fitsPhone(page, ask)
    const vcard = page.locator(`.row[data-id="${vault.id}"] form.vault`)
    await vcard.scrollIntoViewIfNeeded()
    await expect(vcard).toContainText('Naver에서 저장된 비밀번호를 받아들이지 않았어요.')
    await expect(vcard).toContainText('fixture-user')
    await expect(vcard.getByPlaceholder('새 비밀번호')).toBeVisible()
    await expect(vcard.getByRole('button', { name: '다시 로그인' })).toBeVisible()
    await fitsPhone(page, vcard)
    await photo(page, testInfo, 'lv03-rejected-390')
    expect(page.errors).toEqual([])
  })

  test('F-LV-04 넣은 뒤 추가 확인 — 저장된 로그인으로 해 봤다는 말과 막는 것, 「직접 로그인」(저장 단추 없음)', async ({ pageAs, db }, testInfo) => {
    const page = await pageAs('lv-check', PHONE)
    const { task } = await seed(db, page, { state: 'needs_input', need: 'login', reason: REASON.check })
    await page.goto('/chat')
    await toChat(page)
    const ask = page.locator(`.row[data-id="${task.id}"]`).getByTestId('task-ask')
    await expect(ask.getByTestId('task-reason')).toHaveText(REASON.check, { timeout: 20_000 })
    await expect(ask.getByTestId('task-login')).toHaveText('직접 로그인')
    await expect(ask.getByTestId('task-save')).toHaveCount(0)
    await ask.scrollIntoViewIfNeeded()
    await fitsPhone(page, ask)
    await photo(page, testInfo, 'lv04-check-390')
    expect(page.errors).toEqual([])
  })
})
