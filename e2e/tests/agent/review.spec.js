// 검수 — 에이전트가 열린 그림·문서를 고친 뒤, 요청대로 됐는지·빠진 게 없는지 확인하고 대화에 "검수" 메모를 남긴다
// (server/lib/review.js, spec pgpt-pro_craft-apps "편집 뒤 검수"). 어두운 바탕에 바탕과 밝기가 비슷한 빨간
// 테이블이 있는 도면을 남색·하늘색으로 바꿔 달라고 하면, 밝기로 바꾸는 방식(gradientMap)은 테이블을 지운다:
// 결과의 선이 원래의 70% 이상 남아야 하고, 검수 메모가 그 판정을 적는다.
import { test, expect, api } from '../../lib/fixtures.js'
import { since, waitFor } from '../../lib/agent.js'
import zlib from 'node:zlib'

const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]) }
// a CAD-style plan, 600×400: dark ground, gray walls, six red tables (as dark as the ground), a yellow label
function planPng(w = 600, h = 400) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
  const raw = Buffer.alloc((w * 3 + 1) * h)
  const px = (x, y) => {
    if (x < 12 || y < 12 || x > w - 13 || y > h - 13) return [33, 40, 48]
    if (x < 18 || y < 18 || x > w - 19 || y > h - 19) return [150, 150, 150]
    for (const [cx, cy] of [[120, 150], [300, 150], [480, 150], [120, 280], [300, 280], [480, 280]]) { const d = Math.hypot(x - cx, y - cy); if (d > 34 && d < 40) return [248, 2, 2] }
    if (x > 260 && x < 340 && y > 50 && y < 70) return [255, 255, 0]
    return [33, 40, 48]
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const [r, g, b] = px(x, y); const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = r; raw[o + 1] = g; raw[o + 2] = b }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
// pixels away from the corner colour, every second pixel — the same measure as lib/review.js
const COVERAGE = `async (src) => { const im = new Image(); im.src = src; await im.decode(); const c = document.createElement('canvas'); c.width = im.width; c.height = im.height
  const g = c.getContext('2d'); g.drawImage(im, 0, 0); const d = g.getImageData(0, 0, im.width, im.height).data; const b = (3 * im.width + 3) * 4; let n = 0
  for (let y = 0; y < im.height; y += 2) for (let x = 0; x < im.width; x += 2) { const i = (y * im.width + x) * 4; if (Math.abs(d[i] - d[b]) + Math.abs(d[i + 1] - d[b + 1]) + Math.abs(d[i + 2] - d[b + 2]) > 60) n++ }
  return n }`

test('A-11 [flaky] 도면 색을 바꾼 뒤 검수: 테이블 선이 남고(70% 이상) 검수 메모가 남는다', async ({ pageAs, db }) => {
  test.setTimeout(15 * 60_000)
  test.skip(!(await api.craftHas('photocraft', ['web', 'cli'])), api.craftSkip('photocraft', ['web', 'cli']))
  const page = await pageAs('ag-review')
  const tok = page.user.token()
  const th = await db.clearMain(page.user.id)
  const png = planPng()
  const card = { name: '매장 평면도.png', url: (await api.upload(tok, '매장 평면도.png', 'image/png', png)).url }
  await db.addMessages(th, [{ role: 'agent', kind: 'file', content: card }])
  await page.goto('/chat')
  await page.locator('button.file', { hasText: '매장 평면도' }).first().click()
  await expect(page.locator('.cef .badge.live')).toContainText('대화와 연결됨', { timeout: 120_000 })
  const t0 = new Date()
  await page.locator('.foot .composer textarea').fill('이 도면 그림의 색을 남색 선·하늘색 바탕으로 맞춰줘')
  await page.keyboard.press('Enter')
  // the review note: a text message carrying content.review
  const note = await waitFor(async () => (await since(db, th, t0, 'text')).find((m) => m.content?.review), { timeout: 12 * 60_000 })
  test.info().annotations.push({ type: 'review', description: note.content.text })
  expect(note.content.text).toMatch(/^검수/)
  expect(note.content.review.app).toBe('photocraft')
  // the picture as it is now in PhotoCraft: its strokes are still there
  const shot = await page.evaluate(async () => (await document.querySelector('.cef iframe').contentWindow.photocraft.request('ui.screenshot', {})).base64)
  const before = await page.evaluate(`(${COVERAGE})('data:image/png;base64,${png.toString('base64')}')`)
  const after = await page.evaluate(`(${COVERAGE})('data:image/png;base64,${shot}')`)
  test.info().annotations.push({ type: 'strokes', description: `${before} → ${after}` })
  expect(after / before, `선이 ${Math.round((after / before) * 100)}% 남음`).toBeGreaterThanOrEqual(0.7)
  expect(note.content.review.ok, note.content.text).toBe(true)
})
