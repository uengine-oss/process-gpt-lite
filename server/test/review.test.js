// 검수 (lib/review.js) without a model: the stroke coverage of a CAD-style picture (dark ground, strokes in
// layer colours), a brightness map that drops strokes as dark as the ground (the plan's red tables), and a
// recolour by distance from the background that keeps every stroke.
import test from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'
// the module pulls in the DB client through its imports; a checkout without server/.env still runs these
process.env.SERVICE_ROLE_KEY ||= 'unit-test'
const { decodePng, strokeCoverage, losses } = await import('../lib/review.js')

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]) }
function png(w, h, px) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = y % 5 // every filter type
    for (let x = 0; x < w; x++) { const [r, g, b] = px(x, y); const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = r; raw[o + 1] = g; raw[o + 2] = b } }
  // filter the rows for real so the decoder's unfiltering is exercised
  const bpp = 3, stride = w * 3, out = Buffer.from(raw)
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], cur = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), prev = y ? raw.subarray((y - 1) * (stride + 1) + 1, y * (stride + 1)) : Buffer.alloc(stride)
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0
      const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c)
      const pred = f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : f === 4 ? (pa <= pb && pa <= pc ? a : pb <= pc ? b : c) : 0
      out[y * (stride + 1) + 1 + i] = (cur[i] - pred) & 255
    }
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(out)), chunk('IEND', Buffer.alloc(0))])
}
const GROUND = [33, 40, 48], WALL = [150, 150, 150], TABLE = [248, 2, 2], TEXT = [255, 255, 0]
// a plan: walls (gray frame), tables (red rings), a label (yellow block)
function plan(x, y) {
  if (x < 4 || y < 4 || x > 195 || y > 115) return GROUND
  if (x < 6 || y < 6 || x > 193 || y > 113) return WALL
  for (const [cx, cy] of [[40, 45], [100, 45], [160, 45], [40, 85], [100, 85], [160, 85]]) { const d = Math.hypot(x - cx, y - cy); if (d > 12 && d < 15) return TABLE }
  if (x > 90 && x < 110 && y > 20 && y < 28) return TEXT
  return GROUND
}
const lum = ([r, g, b]) => 0.299 * r + 0.587 * g + 0.114 * b
// a brightness map: dark → light ground, bright → navy (what gradientMap does; pure red is luminance ≈ 75)
const byBrightness = (x, y) => (lum(plan(x, y)) < 80 ? [238, 245, 252] : [31, 58, 110])
// by distance from the ground: every stroke navy
const byDistance = (x, y) => (plan(x, y) === GROUND ? [238, 245, 252] : [31, 58, 110])

test('PNG decoder reads every filter type', () => {
  const { w, h, rgba } = decodePng(png(200, 120, plan))
  assert.equal(w, 200); assert.equal(h, 120)
  const at = (x, y) => [...rgba.subarray((y * w + x) * 4, (y * w + x) * 4 + 3)]
  assert.deepEqual(at(40 + 13, 45), TABLE); assert.deepEqual(at(5, 50), WALL); assert.deepEqual(at(0, 0), GROUND)
})

test('a brightness map loses the tables; the review flags it', () => {
  const before = { kind: 'image', ...strokeCoverage(png(200, 120, plan)) }
  const after = { kind: 'image', ...strokeCoverage(png(200, 120, byBrightness)) }
  const kept = after.strokes / before.strokes
  assert.ok(kept < 0.7, `tables vanished: ${Math.round(kept * 100)}% of the strokes left`)
  assert.equal(losses('설계도 색을 제안서 색상에 맞춰줘', before, after).out.length, 1)
})

test('a recolour by distance from the background keeps every stroke', () => {
  const before = { kind: 'image', ...strokeCoverage(png(200, 120, plan)) }
  const after = { kind: 'image', ...strokeCoverage(png(200, 120, byDistance)) }
  assert.equal(after.strokes, before.strokes)
  const r = losses('설계도 색을 제안서 색상에 맞춰줘', before, after)
  assert.equal(r.out.length, 0); assert.match(r.ok.join(), /선 100% 유지/)
})

test('documents and drawings: counts that drop are losses unless the request removes something', () => {
  assert.deepEqual(losses('단가를 바꿔줘', { kind: 'sheet', formulas: 13, filled: 80 }, { kind: 'sheet', formulas: 9, filled: 80 }).out, ['수식 13→9'])
  assert.equal(losses('창고 행을 지워줘', { kind: 'doc', tables: 2, rows: { 1: 5 }, length: 900 }, { kind: 'doc', tables: 2, rows: { 1: 4 }, length: 880 }).out.length, 0)
  assert.deepEqual(losses('화분을 그려줘', { kind: 'cad', counts: { Circle: 30, Line: 9 }, total: 39 }, { kind: 'cad', counts: { Circle: 31, Line: 8 }, total: 39 }).out, ['Line 9→8'])
})
