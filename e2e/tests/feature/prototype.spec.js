// 시작품 요청 — 결과 카드를 앱에서 연다 (spec pgpt-pro_prototype-request, 모델 없음)
// (src/components/CraftEditorFrame.vue, craft/circuitcraft, craft/solidcraft). 메일에서 초안까지는 server/test/prototype.e2e.mjs
import fs from 'node:fs'
import path from 'node:path'
import { test, expect } from '../../lib/fixtures.js'
import { SERVER_DIR } from '../../lib/env.js'

const DIR = path.join(SERVER_DIR, 'fixtures/mail-attachments/hanbit-sensor')
// the file cards point at this page's own origin; the bytes come from the practice mail's files
async function cards(page, db, list) {
  const th = await db.clearMain(page.user.id)
  await page.route('**/__proto/**', (route) => {
    const name = decodeURIComponent(route.request().url().split('/__proto/')[1])
    route.fulfill({ status: 200, body: fs.readFileSync(path.join(DIR, name)), contentType: 'application/octet-stream' })
  })
  await db.addMessages(th, list.map(({ name, companions }) => ({ role: 'agent', kind: 'file', content: { name, ext: name.split('.').pop(), draft: true, url: `/__proto/${encodeURIComponent(name)}`, companions } })))
  await page.goto('/chat')
}
const frameState = (page, api) => page.locator('.cef iframe.frm').evaluate((f, a) => f.contentWindow[a]?.getState?.() ?? null, api)
const LIB = [{ name: 'HS-200.lib', url: '/__proto/HS-200.lib' }]

test.describe('시작품 요청 (spec pgpt-pro_prototype-request)', () => {
  test('F-PR-01 회로 카드를 열면 CircuitCraft 가 라이브러리와 함께 연다', async ({ pageAs, db }) => {
    const page = await pageAs('pr-cir', { viewport: { width: 1280, height: 800 } })
    await cards(page, db, [{ name: 'HS-200_frontend.cir', companions: LIB }])
    await page.locator('button.file', { hasText: '.cir' }).click()
    await expect.poll(() => frameState(page, 'circuitcraft').then((s) => s?.elements?.length || 0), { timeout: 30000 }).toBe(10)
    const s = await frameState(page, 'circuitcraft')
    expect(s.name).toBe('HS-200_frontend.cir')
    expect(s.unsupported).toEqual([])
    expect(s.runs.map((r) => r.label ?? r)).toEqual(['TRAN RF=100k', 'AC RF=100k', 'TRAN RF=220k', 'AC RF=220k'])
  })

  test('F-PR-02 라이브러리 없이 연 회로는 없는 부품을 이름으로 말한다', async ({ pageAs, db }) => {
    const page = await pageAs('pr-nolib', { viewport: { width: 1280, height: 800 } })
    await cards(page, db, [{ name: 'HS-200_frontend.cir' }])
    await page.locator('button.file', { hasText: '.cir' }).click()
    await expect.poll(() => frameState(page, 'circuitcraft').then((s) => (s?.unsupported || []).join(' ')), { timeout: 30000 }).toContain('HSOPA')
  })

  test('F-PR-03 3D 카드를 열면 SolidCraft 가 모델을 연다', async ({ pageAs, db }) => {
    const page = await pageAs('pr-step', { viewport: { width: 1280, height: 800 } })
    await cards(page, db, [{ name: 'HS-200_pcb.step' }])
    await page.locator('button.file', { hasText: '.step' }).click()
    await expect.poll(() => frameState(page, 'solidcraft').then((s) => s?.nodes || 0), { timeout: 60000 }).toBeGreaterThan(0)
    const s = await frameState(page, 'solidcraft')
    expect(s.name).toBe('HS-200_pcb.step')
    expect(s.lastError || null).toBeNull()
  })

  // 실제 설계(BeagleBoard-xM, 공개 하드웨어). 저장소에 넣지 않는다: craft/orcad/test/fetch-evidence.sh 로 받아 ORCAD_TEST_DIR 에 둔다
  test('F-PR-05 OrCAD .dsn 카드를 열면 넷리스트로 바꿔 부품을 그린다', async ({ pageAs, db }) => {
    const dir = (process.env.ORCAD_TEST_DIR || '').split(':').find((d) => d && fs.existsSync(path.join(d, 'BeagleBoard-xM_ORCAD.DSN')))
    test.skip(!dir, 'ORCAD_TEST_DIR 에 BeagleBoard-xM_ORCAD.DSN 이 없어요')
    const page = await pageAs('pr-dsn', { viewport: { width: 1280, height: 800 } })
    const th = await db.clearMain(page.user.id)
    await page.route('**/__dsn/**', (route) => route.fulfill({ status: 200, body: fs.readFileSync(path.join(dir, 'BeagleBoard-xM_ORCAD.DSN')), contentType: 'application/octet-stream' }))
    await db.addMessages(th, [{ role: 'agent', kind: 'file', content: { name: 'BeagleBoard-xM_ORCAD.DSN', ext: 'dsn', url: '/__dsn/x' } }])
    await page.goto('/chat')
    await page.locator('button.file', { hasText: '.DSN' }).click()
    await expect.poll(() => frameState(page, 'circuitcraft').then((s) => s?.elements?.length || 0), { timeout: 120000 }).toBe(438)
    const s = await frameState(page, 'circuitcraft')
    expect(s.name).toBe('BeagleBoard-xM_ORCAD.cir')
  })

  test('F-PR-04 설정의 연습 메일에 시작품 요청이 있다', async ({ as }) => {
    const c = await as('pr-mail')
    const t = (await c.get('/mail/demo-templates')).body.find((x) => x.id === 'hanbit-sensor-prototype')
    expect(t?.label).toContain('시작품')
    expect(t?.hint).toMatch(/STEP.*IGES/)
  })
})
