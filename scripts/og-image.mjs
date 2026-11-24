// Renders the link-preview picture: scripts/og-image.html → public/og-image.png (1200×630, the size
// KakaoTalk, Slack and Facebook show large). Needs the e2e folder's packages (cd e2e && npm install) and the
// network for the fonts (Pretendard, Newsreader).
//   node scripts/og-image.mjs [out.png]
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(path.join(ROOT, 'e2e', 'package.json'))
const { chromium } = require('playwright-core')
const out = path.resolve(process.argv[2] || path.join(ROOT, 'public', 'og-image.png'))

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || 'chrome' })
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 })
  await page.goto(pathToFileURL(path.join(ROOT, 'scripts', 'og-image.html')).href, { waitUntil: 'networkidle' })
  await page.evaluate(() => document.fonts.ready)
  await page.screenshot({ path: out, type: 'png' })
  console.log(out)
} finally {
  await browser.close()
}
