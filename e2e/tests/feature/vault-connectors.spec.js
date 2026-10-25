// 보관함·연결 — 화면에는 이름만, 검증은 값을 보여주지 않고, 활동은 기록된다. 커넥터 토큰도 보관함에.
// (spec pgpt-pro_credential-vault · vault-key-management · 영상 보관함 youtu.be/n5SBj_iRbig, 연동 youtu.be/yVHodTrDwHg)
import { test, expect } from '../../lib/fixtures.js'

test('F-VA-01 같은 사이트 두 계정·두 장의 카드, 화면 목록엔 이름(끝 4자리)만', async ({ pageAs, cleanup }) => {
  const page = await pageAs('va-user')
  const u = page.user
  const ids = []
  cleanup(async () => { for (const id of ids) await u.del(`/vault/${id}`) })
  for (const [user, pw] of [['work@rt.test', 'pw-work-123456'], ['home@rt.test', 'pw-home-123456']]) ids.push((await u.post('/vault', { kind: 'login', site: 'mail.rt.test', data: { username: user, password: pw } })).body.id)
  for (const n of ['4242424242424242', '5555555555554444']) ids.push((await u.post('/vault', { kind: 'card', site: 'shop.rt.test', data: { number: n, exp: '12/39', cvv: '123' } })).body.id)
  const items = (await u.get('/vault')).body.filter((i) => ids.includes(i.id))
  expect(items).toHaveLength(4)
  // 같은 사이트·같은 계정은 새 항목이 아니라 갱신
  const again = await u.post('/vault', { kind: 'login', site: 'mail.rt.test', data: { username: 'WORK@rt.test', password: 'pw-new-1234567' } })
  expect(again.body.id).toBe(ids[0])
  await page.goto('/settings/accounts')
  await expect(page.locator('.settings')).toContainText(/work@rt\.test/i)
  await expect(page.locator('.settings')).toContainText('home@rt.test')
  await page.goto('/settings/wallet')
  await expect(page.locator('.settings')).toContainText('4444')
  const html = await page.content()
  for (const s of ['pw-work-123456', 'pw-new-1234567', '4242424242424242']) expect(html).not.toContain(s)
})

test('F-VA-02 암호화 검증(값 없이)과 활동 기록', async ({ as, cleanup }) => {
  const u = await as('va-user')
  const it = await u.post('/vault', { kind: 'login', site: 'audit.rt.test', data: { username: 'a@rt.test', password: 'pw-audit-123456' } })
  cleanup(() => u.del(`/vault/${it.body.id}`))
  const proof = (await u.get('/vault/proof')).body
  expect(JSON.stringify(proof)).not.toContain('pw-audit-123456')
  expect(proof.kek.in_keyring).toBe(true)
  const checks = JSON.stringify(proof)
  expect(checks).toMatch(/AES-256-GCM/)
  const audit = (await u.get('/vault/audit')).body
  expect(audit.length).toBeGreaterThan(0)
  expect(JSON.stringify(audit)).not.toContain('pw-audit-123456')
})

test('F-CN-01 커넥터 목록, 토큰은 보관함에 들어가고 응답에는 없다', async ({ as, cleanup }) => {
  const u = await as('va-user')
  const c = (await u.get('/connectors')).body
  expect(c.connectors.map((x) => x.name)).toEqual(expect.arrayContaining(['google', 'youtube', 'slack', 'github', 'notion']))
  expect((await u.post('/connectors/evil/token', { token: 'x' })).status).toBe(400)
  const tok = `xoxb-rt-${Date.now()}`
  const r = await u.post('/connectors/slack/token', { token: tok })
  expect(r.status).toBe(200)
  const item = (await u.get('/vault')).body.find((i) => i.kind === 'apikey' && /slack/.test(i.site))
  expect(item).toBeTruthy()
  cleanup(() => u.del(`/vault/${item.id}`))
  expect(JSON.stringify((await u.get('/vault')).body)).not.toContain(tok)
  expect((await u.get('/connectors')).body.connectors.find((x) => x.name === 'slack').connected).toBe(true)
})
