// 시작품 요청 메일(spec pgpt-pro_prototype-request): 무엇이 시작품 요청인지, 메일의 숫자를 어떻게 읽는지, 첨부를 어떻게 받는지. DB·모델 없음.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { isPrototypeRequest, normalizeSpec, circuitSummary, bomLines, CIRCUIT_EXT, SOLID_EXT } from '../lib/prototypeDrafts.js'
import { plainText } from '../lib/mail.js'
import { editable, craftAppsFor } from '../lib/office.js'
import { read, toNgspice } from '../../craft/pspice/pspice.mjs'
import { simulateText, magnitude } from '../../craft/circuitcraft-cli/sim.mjs'

const CASES = JSON.parse(fs.readFileSync(new URL('./prototype-cases.json', import.meta.url)))
for (const c of CASES) {
  test(`판별: ${c.name}`, () => assert.equal(isPrototypeRequest({ subject: c.subject, text: c.text || '' }, (c.files || []).map((name) => ({ name }))), c.expect))
}
test('확장자: 회로와 3D 를 나눈다', () => {
  for (const f of ['a.cir', 'A.NET', 'x.dsn', 'y.ckt', 'z.sp']) assert.ok(CIRCUIT_EXT.test(f), f)
  for (const f of ['a.step', 'A.STP', 'x.igs', 'y.IGES']) assert.ok(SOLID_EXT.test(f), f)
  assert.ok(!CIRCUIT_EXT.test('a.lib'), '라이브러리만으로는 돌릴 회로가 아니다')
})
test('메일의 치수를 그대로 쓰고 보스 자리를 계산한다', () => {
  const s = normalizeSpec({ product: 'HS-200', quantity: 20, enclosure: { width: 90, depth: 60, height: 30, wall: 2 }, standoffs: { count: 4, diameter: 6, height: 5, hole_diameter: 2.5 }, front_hole: { diameter: 12 } })
  assert.deepEqual(s.enclosure, { width: 90, depth: 60, height: 30, wall: 2, corner_radius: 0 })
  assert.equal(s.quantity, 20); assert.deepEqual(s.assumed, [])
  assert.deepEqual(s.standoffs.map((b) => [b.x, b.y]), [[8, 8], [82, 8], [8, 52], [82, 52]])
  assert.deepEqual(s.holes, [{ face: 'front', x: 45, y: 15, diameter: 12 }])
})
test('메일이 지정한 부품 번호를 가져간다', () => {
  const s = normalizeSpec({ enclosure: { width: 90, depth: 60, height: 30, wall: 2 }, part_numbers: [{ role: '궤환 커패시터', part: 'TDK C1608C0G1H100D080AA' }, { role: 'x' }] })
  assert.deepEqual(s.part_numbers, [{ role: '궤환 커패시터', part: 'TDK C1608C0G1H100D080AA' }])
  assert.deepEqual(normalizeSpec({}).part_numbers, [])
})
test('메일에 없는 치수는 가정이라고 적는다', () => {
  const s = normalizeSpec({ product: 'X', enclosure: { width: 90 } })
  assert.equal(s.enclosure.width, 90); assert.equal(s.enclosure.depth, 70)
  assert.ok(s.assumed.some((a) => a.includes('세로')) && s.assumed.some((a) => a.includes('벽')), JSON.stringify(s.assumed))
  assert.ok(!s.assumed.some((a) => a.includes('가로')))
  assert.deepEqual(s.standoffs, []); assert.deepEqual(s.holes, [])
})
test('말이 안 되는 치수는 지어내지 않고 멈춘다', () => {
  assert.throws(() => normalizeSpec({ enclosure: { width: 5, depth: 60, height: 30, wall: 2 } }), /치수/)
  assert.throws(() => normalizeSpec({ enclosure: { width: 90, depth: 60, height: 3, wall: 2 } }), /치수/)
})
test('회로 요약: 잰 값만 쓴다', () => {
  const s = circuitSummary({ runs: [{ label: 'AC RF=100k', gain: 9.99, gain_db: 20, bandwidth_hz: 150000 }, { label: 'TRAN RF=100k', peak_to_peak_v: 1 }] })
  assert.match(s, /RF=100k: 이득 20 dB\(9.99배\), 대역폭 150 kHz/)
  assert.match(circuitSummary({ runs: [{ label: 'TRAN', peak_to_peak_v: 1 }] }), /잴 수 있는 해석이 없/)
})
test('메일이 M3 라고 하면 나사 자리 구멍이다: 모델에게 주는 글에 적혀 있다', () => {
  const src = fs.readFileSync(new URL('../lib/prototypeDrafts.js', import.meta.url), 'utf8')
  assert.match(src, /M3 is hole_diameter 2\.5/)
})
test('부품표 줄', () => {
  assert.equal(bomLines({ rows: [{ refs: ['R1', 'R2'], kind: '저항', value: '10k', quantity: 2 }] }), 'R1,R2 | 저항 | 10k | 2')
  assert.equal(bomLines(null), '')
})
test('Gmail 본문: 여러 파트에서 글을 찾는다', () => {
  const data = Buffer.from('안녕하세요 시작품', 'utf8').toString('base64url')
  assert.equal(plainText({ mimeType: 'multipart/mixed', parts: [{ mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/html', body: { data: 'x' } }, { mimeType: 'text/plain', body: { data } }] }] }), '안녕하세요 시작품')
  assert.equal(plainText({ mimeType: 'text/html', body: { data: 'x' } }), '')
})
test('새 파일은 CircuitCraft·SolidCraft 로 연다', () => {
  for (const f of ['a.cir', 'a.dsn', 'a.step', 'a.igs']) assert.ok(editable(f), f)
})
test('말로 부르면 도구를 켠다', () => {
  assert.ok(craftAppsFor('이 pspice 회로 시뮬레이션 돌려 줘').includes('circuitcraft'))
  assert.ok(craftAppsFor('SolidCraft 로 열어 줘').includes('solidcraft'))
  assert.ok(!craftAppsFor('오늘 일정 알려 줘').includes('circuitcraft'))
})
test('OrCAD 변환: 복합 파일이 아니면 도구를 부르지 않고 거절한다', async () => {
  const { dsnToCir } = await import('../lib/orcad.js')
  await assert.rejects(dsnToCir(Buffer.from('not an orcad file')), (e) => e.status === 400 && /\.dsn/.test(e.message))
})
test('고객 회로 예제: 읽히고, 옮겨지고, 안 쓰는 깨진 부품은 건너뛴다', () => {
  const dir = new URL('../fixtures/mail-attachments/hanbit-sensor/', import.meta.url)
  const text = fs.readFileSync(new URL('HS-200_frontend.cir', dir), 'latin1'), lib = fs.readFileSync(new URL('HS-200.lib', dir), 'latin1')
  const files = { 'hs-200.lib': lib }
  assert.equal(read(text).elements.length, 10)
  const t = toNgspice(text, { files })
  assert.deepEqual(t.unsupported, [])
  assert.deepEqual(t.runs.map((r) => r.label), ['TRAN RF=100k', 'AC RF=100k', 'TRAN RF=220k', 'AC RF=220k'])
  assert.ok(!t.runs[0].netlist.includes('HSREF'))
})
test('고객 회로 예제의 값이 손 계산과 맞다: 이득 RF/RIN, 극점 두 개의 -3 dB', async () => {
  const dir = new URL('../fixtures/mail-attachments/hanbit-sensor/', import.meta.url)
  const r = await simulateText(fs.readFileSync(new URL('HS-200_frontend.cir', dir), 'latin1'), { files: { 'hs-200.lib': fs.readFileSync(new URL('HS-200.lib', dir), 'latin1') } })
  assert.ok(r.ok, JSON.stringify(r.runs.map((x) => x.error)))
  const near = (a, b, pct, m) => assert.ok(Math.abs(a - b) <= Math.abs(b) * pct / 100, `${m} 기대 ${b} 실제 ${a}`)
  const vec = (run, n) => run.data.find((d) => d.name.toLowerCase() === n).values.map(magnitude)
  const bandwidth = (run) => { const f = vec(run, 'frequency'), v = vec(run, 'v(flt)'); return [v[0], f[v.findIndex((x) => x < v[0] * Math.SQRT1_2)]] }
  const run = (label) => r.runs.find((x) => x.label === label)
  // 100 k: 극점 159 kHz 두 개, 200 k 부근이 아니라 0.6436 배. 220 k: 72.3 kHz 와 159 kHz
  const [g1, b1] = bandwidth(run('AC RF=100k')), [g2, b2] = bandwidth(run('AC RF=220k'))
  near(g1, 10 * 100 / 101, 1, '이득(100k)'); near(g2, 22 * 100 / 101, 1, '이득(220k)')
  near(b1, 159155 * 0.6436, 8, '대역폭(100k)'); near(b2, 62000, 10, '대역폭(220k)')
  const flt = vec(run('TRAN RF=100k'), 'v(flt)')
  near(Math.max(...flt.slice(flt.length >> 1)) - Math.min(...flt.slice(flt.length >> 1)), 2 * 0.05 * 10 * 100 / 101, 3, 'TRAN 진폭')
})
