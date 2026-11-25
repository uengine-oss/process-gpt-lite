// 광주 출장비 정산 e2e(tests/agent/map-receipt-reads.spec.js)의 영수증을 만든다 — 한 번 만들어 저장소에 둔 파일을 다시 만들 때만 쓴다.
//   글 PDF   KTX 승차권 영수증_광주 1124-1125.pdf      브라우저가 찍은 PDF: 글자가 글로 들어 있다
//   스캔 PDF 숙박 영수증_광주 무등 호텔(스캔).pdf      영수증을 찍은 그림 한 장만 든 PDF: 글이 없다
//   사진     식대 영수증_광주 1124.jpg                 탁자 위 영수증을 비스듬히 찍은 사진
//   암호 PDF 법인카드 이용내역서_2026-11 영업팀.pdf    카드사가 보내는 암호 걸린 명세서(암호 760101): 열지 못한다
//
//   cd e2e && node fixtures/trip-expense/make-pdf-photo-receipts.mjs
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const here = path.dirname(fileURLToPath(import.meta.url))
const out = (n) => path.join(here, n)
const FONT = `font-family: 'Apple SD Gothic Neo', 'Noto Sans KR', 'Malgun Gothic', sans-serif;`

const ktx = `<html><body style="${FONT} margin:40px; color:#111">
<h2 style="margin:0 0 4px">코레일 승차권 영수증</h2><div style="color:#555">한국철도공사 · 사업자등록번호 314-82-10024</div><hr>
<p>승객: 정하준 (영업팀)</p>
<table style="border-collapse:collapse; width:100%" border="1" cellpadding="6">
<tr><th>승차일</th><th>열차</th><th>구간</th><th>좌석</th><th>운임</th></tr>
<tr><td>2026-11-24</td><td>KTX 501</td><td>용산 06:50 → 광주송정 08:43</td><td>일반실 7호차 12A</td><td style="text-align:right">46,800원</td></tr>
<tr><td>2026-11-25</td><td>KTX 530</td><td>광주송정 18:20 → 용산 20:12</td><td>일반실 3호차 5D</td><td style="text-align:right">46,800원</td></tr>
</table>
<p style="font-size:18px"><b>결제 합계: 93,600원</b> (법인카드 끝자리 7710)</p>
<p style="color:#555">영수증 번호 KR-2611-2417 · 발행일 2026-11-25</p></body></html>`

const receipt = (lines) => `<div style="${FONT} width:420px; background:#fbfaf6; padding:28px 30px; color:#1a1a1a; box-shadow:0 2px 6px rgba(0,0,0,.25)">${lines}</div>`
const hotel = receipt(`<div style="text-align:center; font-size:22px; font-weight:700">무등 호텔 광주</div>
<div style="text-align:center; font-size:13px">광주광역시 서구 상무중앙로 61 · 062-380-0700<br>사업자번호 410-81-55320</div><hr style="border:0; border-top:1px dashed #555">
<div style="font-size:15px; line-height:1.7">영 수 증<br>투숙객: 정하준<br>체크인 2026-11-24 / 체크아웃 2026-11-25 (1박)<br>
스탠다드 트윈 1실 × 1박<br>객실료 160,000원<br>부가세 16,000원</div><hr style="border:0; border-top:1px dashed #555">
<div style="font-size:19px; font-weight:700">합계 176,000원</div>
<div style="font-size:14px">결제: 법인카드 ****-7710 일시불<br>승인 2026-11-25 08:12 · 승인번호 30418827<br>영수증 번호 MD-61205</div>`)
const meal = receipt(`<div style="text-align:center; font-size:22px; font-weight:700">송정 한우마을</div>
<div style="text-align:center; font-size:13px">광주광역시 광산구 송정로 18 · 062-944-1122</div><hr style="border:0; border-top:1px dashed #555">
<div style="font-size:15px; line-height:1.65">2026-11-24 19:42 · 테이블 8<br>한우 모둠 (4인) × 6 &nbsp;&nbsp; 648,000<br>된장찌개 × 6 &nbsp;&nbsp; 48,000<br>음료 · 주류 &nbsp;&nbsp; 88,800</div>
<hr style="border:0; border-top:1px dashed #555"><div style="font-size:19px; font-weight:700">합계 784,800원</div>
<div style="font-size:14px">법인카드 ****-7710 승인<br>고객사 세미나 참석자 저녁 24명</div>`)

// a PDF that holds one JPEG page and nothing else (what a scanner app saves)
function imagePdf(jpg, w, h) {
  const W = 595, H = Math.round((595 * h) / w)
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`,
    null,
    null,
  ]
  const content = `q ${W} 0 0 ${H} 0 0 cm /Im0 Do Q`
  const parts = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'binary')]
  const offs = []
  const len = () => parts.reduce((s, b) => s + b.length, 0)
  for (let i = 0; i < objs.length; i++) {
    offs.push(len())
    if (i === 3) {
      parts.push(Buffer.from(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>\nstream\n`), jpg, Buffer.from('\nendstream\nendobj\n'))
    } else if (i === 4) {
      parts.push(Buffer.from(`5 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`))
    } else parts.push(Buffer.from(`${i + 1} 0 obj\n${objs[i]}\nendobj\n`))
  }
  const x = len()
  parts.push(Buffer.from(`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`))
  return Buffer.concat(parts)
}

// a PDF locked with a user password (standard security handler, revision 2 · RC4 40-bit — what older card statements use)
function rc4(key, data) {
  const s = [...Array(256).keys()]
  for (let i = 0, j = 0; i < 256; i++) { j = (j + s[i] + key[i % key.length]) & 255; [s[i], s[j]] = [s[j], s[i]] }
  const o = Buffer.alloc(data.length)
  for (let n = 0, i = 0, j = 0; n < data.length; n++) { i = (i + 1) & 255; j = (j + s[i]) & 255; [s[i], s[j]] = [s[j], s[i]]; o[n] = data[n] ^ s[(s[i] + s[j]) & 255] }
  return o
}
function lockedPdf(text, password) {
  const PAD = Buffer.from('28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A', 'hex')
  const pad = (p) => Buffer.concat([Buffer.from(p, 'latin1'), PAD]).subarray(0, 32)
  const md5 = (...b) => crypto.createHash('md5').update(Buffer.concat(b)).digest()
  const owner = rc4(md5(pad('owner-' + password)).subarray(0, 5), pad(password))
  const id = crypto.randomBytes(16)
  const P = -44
  const pb = Buffer.alloc(4); pb.writeInt32LE(P)
  const key = md5(pad(password), owner, pb, id).subarray(0, 5)
  const user = rc4(key, PAD)
  const objKey = (n) => md5(key, Buffer.from([n & 255, (n >> 8) & 255, (n >> 16) & 255, 0, 0])).subarray(0, 10)
  const hex = (b) => `<${b.toString('hex')}>`
  const content = rc4(objKey(4), Buffer.from(`BT /F1 14 Tf 60 760 Td (${text}) Tj ET`, 'latin1'))
  const body = [
    Buffer.from('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n'),
    Buffer.from('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n'),
    Buffer.from('3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n'),
    Buffer.concat([Buffer.from(`4 0 obj\n<< /Length ${content.length} >>\nstream\n`), content, Buffer.from('\nendstream\nendobj\n')]),
    Buffer.from('5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n'),
    Buffer.from(`6 0 obj\n<< /Filter /Standard /V 1 /R 2 /O ${hex(owner)} /U ${hex(user)} /P ${P} >>\nendobj\n`),
  ]
  const parts = [Buffer.from('%PDF-1.4\n')]
  const offs = []
  for (const b of body) { offs.push(parts.reduce((s, x) => s + x.length, 0)); parts.push(b) }
  const x = parts.reduce((s, b) => s + b.length, 0)
  parts.push(Buffer.from(`xref\n0 7\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 7 /Root 1 0 R /Encrypt 6 0 R /ID [${hex(id)} ${hex(id)}] >>\nstartxref\n${x}\n%%EOF\n`))
  return Buffer.concat(parts)
}

const browser = await chromium.launch()
try {
  const page = await browser.newPage({ deviceScaleFactor: 2 })
  // 글 PDF
  await page.setContent(ktx)
  fs.writeFileSync(out('KTX 승차권 영수증_광주 1124-1125.pdf'), await page.pdf({ format: 'A4' }))
  // 스캔 PDF: 회색 스캐너 바탕에 살짝 기운 영수증
  await page.setViewportSize({ width: 620, height: 640 })
  await page.setContent(`<body style="margin:0; background:#d9d9d6; display:flex; justify-content:center; align-items:center; height:640px"><div style="transform:rotate(-1.2deg); filter:grayscale(1) contrast(1.15) blur(.25px)">${hotel}</div></body>`)
  const scan = await page.screenshot({ type: 'jpeg', quality: 72 })
  fs.writeFileSync(out('숙박 영수증_광주 무등 호텔(스캔).pdf'), imagePdf(scan, 1240, 1280))
  // 사진: 나무 탁자 위, 비스듬히
  await page.setViewportSize({ width: 760, height: 820 })
  await page.setContent(`<body style="margin:0; height:820px; background:repeating-linear-gradient(95deg,#8a5a35 0 18px,#7d5030 18px 31px,#93633d 31px 52px); display:flex; justify-content:center; align-items:center; perspective:900px">
    <div style="transform:rotateX(14deg) rotateZ(6deg); filter:brightness(.93) sepia(.12)">${meal}</div></body>`)
  fs.writeFileSync(out('식대 영수증_광주 1124.jpg'), await page.screenshot({ type: 'jpeg', quality: 78 }))
} finally { await browser.close() }
fs.writeFileSync(out('법인카드 이용내역서_2026-11 영업팀.pdf'), lockedPdf('Corporate card statement 2026-11', '760101'))
console.log('ok')
