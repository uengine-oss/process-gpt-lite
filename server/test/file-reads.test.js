// 사람 단계에 낸 PDF · 사진(lib/ontology/fileread.js): 글 PDF 는 글을 바로 뽑고, 글이 없는 쪽(스캔)은 그림으로 읽을 쪽으로 가르며,
// 암호 PDF 는 읽지 못했다는 까닭으로 — 뒤 단계(run.js mapPrev · 에이전트 지시)는 읽은 방법 · 원본 링크를 받는다. 모델 호출 없이.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.DOTENV_CONFIG_QUIET = 'true'
const F = await import('../lib/ontology/fileread.js')
const { mapPrev } = await import('../lib/ontology/run.js')
const FX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../e2e/fixtures/trip-expense')
const buf = (n) => fs.readFileSync(path.join(FX, n))

test('PDF · 그림만 이 모듈이 읽는다(docx · xlsx 는 예전 길 그대로)', () => {
  for (const n of ['a.pdf', 'b.JPG', 'c.jpeg', 'd.png', 'e.webp', 'f.heic']) assert.ok(F.readsHere(n), n)
  for (const n of ['a.docx', 'b.xlsx', 'c.csv', 'd.txt', 'e.hwpx', 'f']) assert.ok(!F.readsHere(n), n)
})

test('글 PDF: 모델 없이 글을 뽑는다(한글 낱자 사이에 빈칸 없이)', async () => {
  const n = 'KTX 승차권 영수증_광주 1124-1125.pdf'
  const r = await F.readPdf(buf(n), n)
  assert.equal(r.read, 'text')
  assert.match(r.text, /결제 합계: 93,600원/)
  assert.match(r.text, /용산 06:50 → 광주송정 08:43/)
})

test('암호 PDF: 읽지 못했다는 까닭으로(건은 멈추지 않음)', async () => {
  const n = '법인카드 이용내역서_2026-11 영업팀.pdf'
  const r = await F.readPdf(buf(n), n)
  assert.deepEqual([r.read, r.text], ['none', ''])
  assert.match(r.why, /암호/)
})

test('HEIC 같은 그림은 모델에 보내지 않고 읽지 못한 것으로', async () => {
  const r = await F.readImage(Buffer.from('x'), 'IMG_0412.HEIC')
  assert.equal(r.read, 'none')
  assert.match(r.why, /HEIC/)
})

test('뒤 단계는 읽은 방법 · 원본 링크를 받고, 읽지 못한 파일은 그 표시로', () => {
  const up = (name, read, text, why) => ({ name, path: `/workspace/uploads/u/1/${name}`, url: `http://s/files/${name}`, read, text, ...(why ? { why } : {}) })
  const earlier = [{ task: '영수증 제출', text: '', files: [
    up('ktx.pdf', 'text', '결제 합계: 93,600원'), up('hotel.pdf', 'image', '합계 176,000원'), up('card.pdf', 'none', '', '암호가 걸린 PDF라 열지 못했어요'), up('old.docx', 'text', '498,000원'),
  ] }]
  const p = mapPrev({ subject: '광주 출장비 정산' }, {}, earlier)
  const [ktx, hotel, card, docx] = p.steps[0].files
  assert.equal(ktx.read, '파일의 글'); assert.equal(ktx.text, '결제 합계: 93,600원'); assert.equal(ktx.original, 'http://s/files/ktx.pdf')
  assert.match(hotel.read, /그림을 모델이 읽은 글/); assert.equal(hotel.text, '합계 176,000원')
  assert.equal(card.read, '읽지 못한 파일'); assert.match(card.text, /읽지 못한 파일 — 암호/); assert.equal(card.original, 'http://s/files/card.pdf')
  assert.equal(docx.text, '498,000원')
  const note = F.filesNote(p)
  assert.match(note, /「hotel\.pdf」은 스캔 · 사진을 모델이 읽은 글/)
  assert.match(note, /「card\.pdf」은 읽지 못했어요.*original/)
  assert.ok(!note.includes('ktx.pdf') && !note.includes('old.docx'))
  // 글로 읽은 파일만 있으면 에이전트 지시는 예전 그대로
  assert.equal(F.filesNote(mapPrev({}, {}, [{ task: 'x', text: '', files: [up('a.docx', 'text', 'y')] }])), '')
  assert.match(F.fileLine(earlier[0].files[2]), /낸 파일 「card\.pdf」\(읽지 못한 파일\): \(읽지 못한 파일 — 암호.*\[원본: http:\/\/s\/files\/card\.pdf\]/)
})
