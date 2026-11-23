// 메일로 온 인증 코드 — 브라우저 작업이 인증 코드를 기다리는 동안 연결된 메일함에서 그 사이트가 보낸 코드를 찾아 바로 넣는다
// (server lib/mailCode.js). 실제 브라우저·사이트·메일로 도는 시험은 server/test/browser-mail-otp.test.js 이고, 여기는 화면과
// 설정, 시험용 사이트의 메일이 데모 메일함에 닿는 길을 본다. 모델 없이 고정 카드로.
import { test, expect } from '../../lib/fixtures.js'

const card = (state, extra = {}) => ({ kind: 'secret', site: '127.0.0.1', mode: 'request', label: '이메일 인증 코드', taskId: 'mo-task', state, ...extra })

test('F-MO-01 인증 코드 카드: 메일함을 보는 동안 그렇다고 말하고, 메일에서 찾으면 어디서 왔는지만(코드는 없이)', async ({ pageAs, db }) => {
  const page = await pageAs('mo-card')
  const th = await db.clearMain(page.user.id)
  const [m] = await db.addMessages(th, [{ role: 'agent', kind: 'vault', content: card('pending', { mailWatch: true, mailName: '테스트 상점' }) }])
  await page.goto('/chat')
  const v = page.locator('form.vault')
  await expect(v.locator('.watch')).toContainText('메일함에서 테스트 상점의 인증 메일을', { timeout: 20_000 })
  await expect(v.locator('input')).toBeVisible()

  await db.q(`update pro_messages set content = content || $2::jsonb where id=$1`, [m.id, JSON.stringify({ state: 'mail', mailFrom: 'shop.example' })])
  await page.reload()
  await expect(page.locator('.saved')).toHaveText(/메일에서 찾은 인증 코드 입력됨 · shop\.example · 저장하지 않음/, { timeout: 20_000 })

  // a card that does not watch (no mailbox, or turned off) says nothing about mail
  await db.clearMain(page.user.id)
  await db.addMessages(th, [{ role: 'agent', kind: 'vault', content: card('pending') }])
  await page.reload()
  await expect(page.locator('form.vault input')).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('form.vault .watch')).toHaveCount(0)
  expect(page.errors).toEqual([])
})

test('F-MO-02 설정 › 보안: 「메일로 온 인증 코드 자동 입력」은 켜져 있고, 끄고 켤 수 있다', async ({ pageAs, as }) => {
  const page = await pageAs('mo-setting')
  const u = await as('mo-setting')
  await u.put('/me/mail-codes', { on: true })
  await page.goto('/settings/security')
  const sw = page.locator('.mailcodes .switch')
  await expect(sw).toHaveAttribute('aria-checked', 'true', { timeout: 20_000 })
  await sw.click()
  await expect(sw).toHaveAttribute('aria-checked', 'false')
  await expect.poll(async () => (await u.get('/me')).body.profile.mail_codes).toBe(false)
  await sw.click()
  await expect.poll(async () => (await u.get('/me')).body.profile.mail_codes).toBe(true)
  expect(page.errors).toEqual([])
})

test('F-MO-03 시험용 사이트의 메일은 그 주소의 데모 메일함에만 닿는다', async ({ as, db }) => {
  const u = await as('mo-inbound')
  await u.post('/mail/connect', { provider: 'demo' })
  const me = (await u.get('/me')).body.user
  const sent = { from: '테스트 상점 <no-reply@shop.example>', subject: '[테스트 상점] 로그인 인증 코드', text: '로그인 인증 코드는 482913 입니다.' }
  expect((await u.post('/mail/demo-inbound', { to: me.email, ...sent })).body).toEqual({ delivered: 1 })
  expect((await u.post('/mail/demo-inbound', { to: 'nobody@uengine.test', ...sent })).body).toEqual({ delivered: 0 })
  const rows = await db.q(`select sender, subject from pro_demo_mail where user_id=$1 order by created_at desc limit 1`, [me.id])
  expect(rows[0].subject).toBe(sent.subject)
  await db.q('delete from pro_demo_mail where user_id=$1', [me.id])
})
