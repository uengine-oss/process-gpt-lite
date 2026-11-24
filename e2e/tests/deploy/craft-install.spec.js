// ArtCraft apps in an install that should have them (spec craft-apps «ArtCraft 가 든 설치는 다섯 앱을 모두 낸다»): no sign-in needed.
//   - /api/config says each app's web editor and CLI are there
//   - /craft/<app>/ is the app's page under the install's own path (/lite behind the ProcessGPT gateway), and the
//     scripts and wasm it loads come back with their types — the big wasm gzipped (VectorCraft's is 74 MB raw)
//   - in a browser the app starts there: its canvas, its page API (window.<app>), nothing it asks for missing
// Unlike S-30 (smoke), a missing app here is a failure, not a skip.
//   PGPT_ROOT_URL=https://uengine.process-gpt.io npx playwright test --project=deploy tests/deploy/craft-install.spec.js
//   (a Docker install with --with-craft: PGPT_LITE_URL=http://localhost:18080)
import { test, expect } from '@playwright/test'

const LITE = (process.env.PGPT_LITE_URL || `${(process.env.PGPT_ROOT_URL || 'http://localhost:8088').replace(/\/$/, '')}/lite`).replace(/\/$/, '')
const APPS = ['cadcraft', 'vectorcraft', 'photocraft', 'soundcraft', 'filmcraft']
// optional upstream files a page asks for and may go without (HOSTING.md › Fonts: without fonts/manifest.txt nothing changes)
const OPTIONAL = /\/fonts\/manifest\.txt$/

let craft = null
test.beforeAll(async ({ request }) => {
  const r = await request.get(`${LITE}/api/config`)
  expect(r.status(), `${LITE}/api/config`).toBe(200)
  craft = (await r.json()).craft || {}
})

for (const app of APPS) {
  test(`C-IN-${app} 설정·페이지·스크립트·wasm`, async ({ request }) => {
    expect(craft[app], `/api/config craft.${app}`).toEqual({ web: true, cli: true })
    const page = await request.get(`${LITE}/craft/${app}/`)
    expect(page.status()).toBe(200)
    expect(page.headers()['content-type']).toContain('text/html')
    const html = await page.text()
    // ./x.js · ./x_bg.wasm in links and imports, and FilmCraft's "filmcraft_web_bg.wasm" built at run time
    const assets = [...new Set([...html.matchAll(/["'](?:\.\/)?([A-Za-z0-9_.-]+\.(?:js|wasm))["']/g)].map((m) => m[1]))]
    if (app === 'photocraft') assets.push('app/parts.txt', 'app/photocraft-web.js')
    expect(assets.some((a) => a.endsWith('.js')), `${app} index.html names a script`).toBe(true)
    for (const a of assets) {
      const r = await request.get(`${LITE}/craft/${app}/${a}`, { headers: { 'Accept-Encoding': 'gzip' } })
      expect(r.status(), a).toBe(200)
      const type = r.headers()['content-type'] || ''
      if (a.endsWith('.wasm')) {
        expect(type, a).toContain('application/wasm')
        expect(r.headers()['content-encoding'] || '', `${a} gzipped`).toContain('gzip')
      } else if (a.endsWith('.js')) expect(type, a).toMatch(/javascript/)
    }
  })

  test(`C-IN-${app}-boot 브라우저에서 앱이 뜬다`, async ({ page }) => {
    test.setTimeout(240_000)
    const bad = []
    page.on('response', (r) => { if (r.status() >= 400 && !OPTIONAL.test(new URL(r.url()).pathname)) bad.push(`${r.status()} ${r.url()}`) })
    page.on('requestfailed', (r) => bad.push(`failed ${r.url()} ${r.failure()?.errorText || ''}`))
    await page.goto(`${LITE}/craft/${app}/`, { waitUntil: 'load', timeout: 120_000 })
    // up = the wasm has started: the page API the chat's editor frame drives (window.<app>) is there, and its canvas
    const up = await page.waitForFunction((a) => typeof window[a] === 'object' && (document.querySelector('canvas')?.width || 0) > 100, app, { timeout: 180_000 })
      .then(() => true, () => false)
    expect(bad).toEqual([])
    expect(up, `window.${app} and the canvas within 3 minutes`).toBe(true)
  })
}
