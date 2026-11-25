// TIFF · 팩스를 앱 안에서 보고, 에이전트가 쪽 그림(PNG)으로 읽는다 (2026-11-25 운영: KT 스마트메시지 Plus 「팩스 메시지 도착알림」의
// arrive_….tif 칩이 FILE · 「앱 안에서 열지 않는 형식이에요 · 내려받기」뿐 — 「tif 파일을 웹에서 못 열어보나?」). 스펙 openspec/specs/chat-media-preview.
// 시험 파일은 server/fixtures/tiff (make.py 가 만든 방법을 적어 둠): 2쪽 G4 팩스 · 같은 1쪽의 G3 · LZW 컬러 · Deflate 회색조 · 깨진 파일 · 5만 × 5만이라 주장하는 머리.
//   - 종류: TIFF 는 그림(mediaKind · 메일 첨부 · 폴더 · 칩 배지), 저장된 형식이 이름보다 먼저
//   - 걷기(scanTiff): 쪽 수 · 크기 · 해상도 보정(204 × 98 dpi → 두 배 높이), 깨진 · 거대한 · 고리 진 · 값이 너무 많은 파일은 디코딩 전에 거절
//   - 서버 변환(tiffToPngs): 쪽 수 · PNG 서명 · 흑백은 회색조 PNG · 픽셀 상한 · 끝나지 않는 디코딩은 시간 제한으로 끊음
//   - 에이전트에 넘기는 말: 작업 공간 경로 · 비공개 서명 주소만(이 업로드의 것만), 못 바꾼 까닭
//   - src/tiffCore.js 와 server/lib/tiffCore.js 는 같은 파일
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const FIX = path.join(here, '../fixtures/tiff')
const fixture = (n) => fs.readFileSync(path.join(FIX, n))
const ab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.length)
const UTIF = createRequire(path.join(here, '../package.json'))('utif')
const C = await import('../lib/tiffCore.js')
const T = await import('../lib/tiff.js')
const MK = await import('../../src/mediaKind.js')
const FK = await import('../../src/components/folders/fileKind.js')
const { openPlan } = await import('../../src/openPlan.js')
const { sniffExt } = await import('../lib/fileSniff.js')

// a PNG back to its header and pixels (the encoder's own round trip)
function readPng(buf) {
  assert.ok(buf.subarray(0, 8).equals(T.PNG_SIGNATURE), 'PNG 서명')
  let p = 8, ihdr = null
  const idat = []
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('ascii', p + 4, p + 8), data = buf.subarray(p + 8, p + 8 + len)
    if (type === 'IHDR') ihdr = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), depth: data[8], colour: data[9] }
    if (type === 'IDAT') idat.push(data)
    p += 12 + len
  }
  return { ...ihdr, raw: zlib.inflateSync(Buffer.concat(idat)) }
}
const darkShare = (rgba) => { let n = 0; for (let i = 0; i < rgba.length; i += 4) if (rgba[i] < 128) n++; return n / (rgba.length / 4) }

test('src/tiffCore.js 와 server/lib/tiffCore.js 는 같은 파일이다(서버 이미지에는 src/ 가 없다)', () => {
  assert.equal(fs.readFileSync(path.join(here, '../lib/tiffCore.js'), 'utf8'), fs.readFileSync(path.join(here, '../../src/tiffCore.js'), 'utf8'))
})

test('종류: TIFF 는 그림 — 이름 · 저장된 형식 · 주소로, 형식이 말해 주면 형식이 먼저', () => {
  for (const f of [{ name: 'arrive_xroshotplus_uengine1_20261125095030049_121017596357694.tif' }, { name: 'FAX.TIFF' }, { name: 'download', type: 'image/tiff' },
    { name: 'scan', type: 'image/tiff-fx' }, { name: 'x', url: 'https://s/fax.tif?token=1' }]) {
    assert.equal(MK.mediaKindOf(f), 'image', JSON.stringify(f))
    assert.equal(MK.isTiff(f), true, JSON.stringify(f))
  }
  // a type that says otherwise wins over the name; a generic type leaves it to the name
  assert.equal(MK.isTiff({ name: 'fax.tif', type: 'image/png' }), false)
  assert.equal(MK.isTiff({ name: 'fax.tif', type: 'application/octet-stream' }), true)
  assert.equal(MK.isTiff({ name: 'photo.png' }), false)
  assert.equal(MK.mediaKindOf({ name: 'photo.heic', type: 'image/heic' }), '', 'HEIC 는 여전히 그림 아님')
  // the viewer, not 「앱 안에서 열 수 없는 형식」
  assert.deepEqual(openPlan({ name: 'fax.tif', url: 'https://s/fax.tif' }), { how: 'view', media: 'image', url: 'https://s/fax.tif' })
  // folders: an IMG badge and the picture preview (FileView → TiffView)
  assert.equal(FK.kindOf('팩스/arrive.tif'), 'img')
  assert.equal(FK.viewOf('팩스/arrive.TIFF'), 'image')
  // the server: a mail's TIFF attachment is a picture the viewer opens, served as image/tiff; the chat's sniffing names a nameless one
  return import('../lib/mailAttachments.js').then(async (MA) => {
    assert.deepEqual(MA.kindOf({ name: 'arrive.tif', type: '' }), { kind: 'media', media: 'image' })
    assert.deepEqual(MA.kindOf({ name: 'download', type: 'image/tiff' }), { kind: 'media', media: 'image' })
    assert.equal(MA.rawType('arrive.tif', 'application/octet-stream'), 'image/tiff')
    assert.equal(await sniffExt(fixture('fax-2p-g4.tif')), 'tif')
    assert.equal(await sniffExt(Buffer.from('MM\u0000*\u0000\u0000\u0000\u0008', 'latin1')), 'tif')
    assert.equal(T.isTiff({ name: 'x.bin', buf: fixture('color-lzw.tif') }), true, '바이트가 결정')
    assert.equal(T.isTiff({ name: 'fax.tif', buf: Buffer.from('%PDF-1.7') }), false)
  })
})

test('걷기: 2쪽 G4 팩스 · G3 · LZW 컬러 — 쪽 수, 크기, 204 × 98 dpi 는 두 배 높이로', () => {
  const fax = C.scanTiff(fixture('fax-2p-g4.tif'))
  assert.equal(fax.pages.length, 2)
  assert.deepEqual(fax.pages.map((p) => [p.width, p.height, p.shownWidth, p.shownHeight, p.compression]), [[1728, 1100, 1728, 2290, 4], [1728, 1100, 1728, 2290, 4]])
  assert.equal(C.scanTiff(fixture('fax-g3.tif')).pages[0].compression, 3)
  const c = C.scanTiff(fixture('color-lzw.tif'))
  assert.deepEqual([c.pages.length, c.pages[0].shownWidth, c.pages[0].shownHeight, c.pages[0].compression, c.pages[0].photometric], [1, 320, 200, 5, 2])
  assert.deepEqual(C.shownSize(1728, 1100, 204, 98), { width: 1728, height: 2290 })
  assert.deepEqual(C.shownSize(1728, 2200, 204, 196), { width: 1728, height: 2200 }, '고해상도(fine) 팩스는 그대로')
  assert.deepEqual(C.shownSize(100, 100, 0, 0), { width: 100, height: 100 })
})

test('걷기: 깨진 · 거대한 · 고리 진 · 값이 너무 많은 · TIFF 아닌 파일은 디코딩 전에 거절(까닭 코드)', () => {
  const code = (b, limits) => { try { C.scanTiff(b, limits); return 'ok' } catch (e) { assert.ok(e instanceof C.TiffError); return e.code } }
  assert.equal(code(fixture('broken.tif')), 'broken')
  assert.equal(code(fixture('giant.tif')), 'too_big', '5만 × 5만: 픽셀 상한')
  assert.equal(code(fixture('fax-2p-g4.tif'), { ...C.LIMITS, maxPixels: 1000 * 1000 }), 'too_big', '상한을 낮추면 팩스도')
  assert.equal(code(Buffer.from('%PDF-1.7 not a tiff')), 'not_tiff')
  assert.equal(code(Buffer.from('II+\u0000\u0008\u0000\u0000\u0000', 'latin1')), 'bigtiff')
  // a chain of directories that points back at itself (the decoder's own loop would never end)
  const g = Buffer.from(fixture('giant.tif'))
  const loop = Buffer.from(g)
  loop.writeUInt16LE(256, 10); loop.writeUInt32LE(100, 18) // width 100
  loop.writeUInt16LE(257, 22); loop.writeUInt32LE(100, 30) // height 100
  loop.writeUInt32LE(8, 8 + 2 + 8 * 12) // next directory: itself
  assert.equal(code(loop), 'broken')
  // a tag that claims four billion values
  const many = Buffer.from(loop)
  many.writeUInt32LE(0, 8 + 2 + 8 * 12)
  many.writeUInt32LE(0xfffffff0, 8 + 2 + 5 * 12 + 4) // strip offsets (273): 4 294 967 280 values
  assert.equal(code(many), 'broken')
  // a page count past the limit
  assert.equal(code(fixture('fax-2p-g4.tif'), { ...C.LIMITS, maxPages: 1 }), 'too_many_pages')
})

test('쪽 디코딩: 팩스의 글씨가 보이고(검은 점), 썸네일은 작게 — 넓이 평균으로', () => {
  const b = fixture('fax-2p-g4.tif'), scan = C.scanTiff(b)
  for (const i of [0, 1]) {
    const p = C.decodePage(UTIF, ab(b), scan, i)
    assert.deepEqual([p.width, p.height, p.rgba.length], [1728, 2290, 1728 * 2290 * 4])
    const share = darkShare(p.rgba)
    assert.ok(share > 0.03 && share < 0.3, `${i + 1}쪽 검은 점 비율 ${share}`)
  }
  const t = C.decodePage(UTIF, ab(b), scan, 0, { maxWidth: 240 })
  assert.deepEqual([t.width, t.height], [240, 318])
  assert.ok(darkShare(t.rgba) > 0.005, '썸네일에도 글씨')
  const c = fixture('color-lzw.tif'), cp = C.decodePage(UTIF, ab(c), C.scanTiff(c), 0)
  const px = (x, y) => [...cp.rgba.subarray((y * 320 + x) * 4, (y * 320 + x) * 4 + 4)]
  assert.deepEqual(px(160, 100), [255, 255, 255, 255], '가운데 흰 네모')
  assert.ok(px(5, 10)[0] > 150 && px(5, 10)[2] < 80, '위 띠는 붉은색')
})

test('서버 변환: 팩스 2쪽 → PNG 2장(회색조, 1728 × 2290) · 컬러 LZW → RGB · 깨진 · 거대한 파일은 까닭 · 끝나지 않는 디코딩은 시간 제한', async () => {
  const fax = await T.tiffToPngs(fixture('fax-2p-g4.tif'))
  assert.equal(fax.total, 2)
  assert.equal(fax.pages.length, 2)
  for (const p of fax.pages) {
    const png = readPng(p.png)
    assert.deepEqual([png.width, png.height, png.depth, png.colour], [1728, 2290, 8, 0], '회색조 8비트')
    assert.equal(png.raw.length, (1728 + 1) * 2290)
    assert.ok(p.png.length < 200 * 1024, `팩스 한 쪽 PNG ${p.png.length} B`)
  }
  const one = await T.tiffToPngs(fixture('fax-2p-g4.tif'), { maxPages: 1 })
  assert.deepEqual([one.total, one.pages.length], [2, 1], '앞 쪽만, 전체 쪽 수는 앎')
  const g3 = await T.tiffToPngs(fixture('fax-g3.tif'))
  assert.ok(g3.pages[0].png.equals(fax.pages[0].png), 'G3 로 다시 압축한 1쪽은 G4 의 1쪽과 같은 그림')
  const col = readPng((await T.tiffToPngs(fixture('color-lzw.tif'))).pages[0].png)
  assert.deepEqual([col.width, col.height, col.colour], [320, 200, 2], 'RGB')
  // Adobe Deflate: the decoder's inflate (pako) — greyscale stays greyscale
  const gd = readPng((await T.tiffToPngs(fixture('gray-deflate.tif'))).pages[0].png)
  assert.deepEqual([gd.width, gd.height, gd.colour], [200, 120, 0])
  assert.equal(gd.raw[1], 235, '바탕 회색 235')
  assert.ok([...gd.raw].filter((v) => v < 60).length > 300, '글씨와 테두리')
  const rejects = async (buf, code, opts) => assert.rejects(T.tiffToPngs(buf, opts), (e) => e instanceof T.TiffError && e.code === code)
  await rejects(fixture('broken.tif'), 'broken')
  await rejects(fixture('giant.tif'), 'too_big')
  await rejects(fixture('fax-2p-g4.tif'), 'too_big', { limits: { maxPixels: 2000 * 1000 } })
  await rejects(Buffer.from('not a tiff at all'), 'not_tiff')
  // an LZW strip zeroed out: the decoder loops for ever — the worker is stopped after its time
  const bad = Buffer.from(fixture('color-lzw.tif')); bad.fill(0, 200, 50000)
  const t0 = Date.now()
  await rejects(bad, 'timeout', { timeoutMs: 1500 })
  assert.ok(Date.now() - t0 < 5000, '시간 제한 안에 끝남')
  // the server still answers afterwards (the loop was in the worker, not here)
  assert.equal((await T.tiffToPngs(fixture('color-lzw.tif'))).pages.length, 1)
})

test('PNG 쓰기: 회색 그림은 회색조, 색이 있으면 RGB — 픽셀 그대로', () => {
  const rgba = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255, 10, 20, 30, 255, 128, 128, 128, 255])
  const png = readPng(T.encodePng({ width: 2, height: 2, rgba }))
  assert.deepEqual([png.width, png.height, png.colour], [2, 2, 2])
  assert.deepEqual([...png.raw], [0, 0, 0, 0, 255, 255, 255, 0, 10, 20, 30, 128, 128, 128])
  const grey = readPng(T.encodePng({ width: 2, height: 1, rgba: new Uint8ClampedArray([0, 0, 0, 255, 200, 200, 200, 255]) }))
  assert.deepEqual([grey.colour, ...grey.raw], [0, 0, 0, 200])
  assert.equal(T.pageName('arrive_xroshotplus.tif', 2), 'arrive_xroshotplus-page2.png')
  assert.equal(T.pageName('팩스.TIFF', 1), '팩스-page1.png')
})

test('에이전트에 넘기는 말: 이 업로드의 쪽 그림만(같은 작업 공간 폴더 · 이 업로드의 비공개 서명 주소), 못 바꾸면 까닭', async () => {
  const A = await import('../lib/attachments.js')
  const P = await import('../lib/privateStore.js')
  const { config } = await import('../config.js')
  const U = 'a1b2c3d4-0000-4000-8000-000000000001', ID = 'b1b2c3d4-0000-4000-8000-000000000002', OTHER = 'c1b2c3d4-0000-4000-8000-000000000003'
  const signed = (user, up, n) => `${config.supabaseUrl}/storage/v1/object/sign/${P.BUCKET}/${P.chatPageKey({ tenant: config.tenantId, userId: user, upload: up, n })}?token=t${n}`
  const f = { name: 'fax.tif', key: `pgpt-pro/${U}/att/${ID}.tif`, url: 'https://s/f.tif', path: `/workspace/uploads/${U}/${ID}/fax.tif`, pageTotal: 2,
    pages: [{ name: 'fax-page1.png', path: `/workspace/uploads/${U}/${ID}/fax-page1.png`, url: signed(U, ID, 1) }, { name: 'fax-page2.png', url: signed(U, ID, 2) }] }
  assert.deepEqual(A.pageRefs(f), [`/workspace/uploads/${U}/${ID}/fax-page1.png`, signed(U, ID, 2)])
  const hint = A.attachmentHint([f])
  assert.match(hint, /팩스·TIFF 라서 쪽마다 그림\(PNG\)으로도 두었어요\. 그림을 열어 보고 읽으세요: 1쪽 \/workspace\/uploads\/.+fax-page1\.png, 2쪽 https?:\/\/\S+page-2\.png\?token=t2/)
  // not this upload's: another folder, another person's or another upload's pages, a public address, a path that climbs out
  const bad = { ...f, pages: [{ path: `/workspace/uploads/${U}/other/x.png` }, { path: `/workspace/uploads/${U}/${ID}/../x.png` }, { url: signed(OTHER, ID, 1) }, { url: signed(U, OTHER, 1) },
    { url: `${config.supabaseUrl}/storage/v1/object/public/files/pgpt-pro/${U}/att/x.png` }, { url: `${config.supabaseUrl}/storage/v1/object/sign/files/chat/x/page-1.png?token=1` }] }
  assert.deepEqual(A.pageRefs(bad), [])
  assert.doesNotMatch(A.attachmentHint([bad]), /쪽 그림|PNG/)
  // no path of its own (the agent's pods): only the signed addresses
  assert.deepEqual(A.pageRefs({ ...f, path: undefined }), [signed(U, ID, 1), signed(U, ID, 2)])
  assert.match(A.attachmentHint([{ name: 'big.tif', url: 'https://s/b.tif', pagesError: 'too_big' }]), /이 TIFF 는 너무 커서 쪽 그림으로 바꾸지 못했어요/)
  assert.equal(A.attachmentHint([{ name: 'a.pdf', url: 'https://s/a.pdf' }]), '\n\n(첨부 파일: a.pdf — https://s/a.pdf)', '다른 첨부는 그대로')
  // a mail's TIFF: the words beside its file
  const MA = await import('../lib/mailAttachments.js')
  assert.match(MA.pagesLine({ total: 3, pages: [1, 2] }, ['/w/a-page1.png', '/w/a-page2.png']), /쪽마다 그림\(PNG\)으로도 두었어요 — 그림을 열어 보고 읽으세요 \(전체 3쪽 가운데 앞 2쪽\): 1쪽 \/w\/a-page1\.png, 2쪽 \/w\/a-page2\.png/)
  assert.match(MA.pagesLine({ error: { code: 'timeout' } }, []), /그리는 데 너무 오래 걸려서 쪽 그림으로 바꾸지 못했어요/)
  assert.equal(MA.pagesLine(null, []), '')
})

test('작업 공간: TIFF 와 쪽 그림이 같은 무작위 폴더에, 0600', async () => {
  const MA = await import('../lib/mailAttachments.js')
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'tiff-ws-'))
  try {
    const U = 'a1b2c3d4-0000-4000-8000-000000000009'
    const rel = await MA.toWorkspace({ id: U }, { name: 'arrive.tif', buf: Buffer.from('II*\u0000') }, { workspace: async () => ws },
      [{ name: 'arrive-page1.png', buf: Buffer.from('p1') }, { name: 'arrive-page2.png', buf: Buffer.from('p2') }])
    const dir = path.join(ws, path.posix.dirname(rel).slice('/workspace'.length))
    assert.deepEqual(fs.readdirSync(dir).sort(), ['arrive-page1.png', 'arrive-page2.png', 'arrive.tif'])
    assert.equal(fs.readFileSync(path.join(dir, 'arrive-page2.png'), 'utf8'), 'p2')
    assert.equal(fs.statSync(path.join(dir, 'arrive-page1.png')).mode & 0o777, 0o600)
  } finally { fs.rmSync(ws, { recursive: true, force: true }) }
})
