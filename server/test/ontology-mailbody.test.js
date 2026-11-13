// 메일 본문 · 첨부 읽기와 정해진 때 찾기(design-v0.3 §15, lib/ontology/mailbody.js): Gmail payload 의 모양, 인용 자르기,
// 양식의 칸, 메일 날짜의 주기. 파일 · 네트워크 없이(첨부는 이 시험이 만든 xlsx · docx · hwpx).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import JSZip from 'jszip'
import { partsOf, htmlText, newPart, bodyOf, readFile, formKey, formFields, periodOf, cronOfHint } from '../lib/ontology/mailbody.js'
import { cronKo } from '../lib/ontology/timers.js'

const b64u = (s) => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

test('Gmail payload: 본문(text/plain 먼저) · html 만 있으면 글로 · 첨부 목록', () => {
  const payload = { mimeType: 'multipart/mixed', parts: [
    { mimeType: 'multipart/alternative', parts: [
      { mimeType: 'text/plain', body: { data: b64u('안녕하세요.\n매주 월요일 오전에 공정 보고 부탁드립니다.') } },
      { mimeType: 'text/html', body: { data: b64u('<p>안녕하세요.</p>') } },
    ] },
    { mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', filename: '주간공정보고_양식.xlsx', body: { attachmentId: 'ANGjdJ8', size: 12034 } },
  ] }
  const p = partsOf(payload)
  assert.match(p.text, /매주 월요일 오전/)
  assert.deepEqual(p.attachments.map((a) => [a.name, a.attachmentId, a.size]), [['주간공정보고_양식.xlsx', 'ANGjdJ8', 12034]])
  const onlyHtml = partsOf({ mimeType: 'text/html', body: { data: b64u('<div>견적 <b>합계</b>&nbsp;12,400,000원</div><br>감사합니다 &amp; 좋은 하루') } })
  assert.equal(bodyOf(onlyHtml), '견적 합계 12,400,000원\n\n감사합니다 & 좋은 하루')
  assert.equal(htmlText('<style>p{}</style><p>a</p><p>b</p>'), 'a\nb')
})

test('지금 쓴 부분: 인용된 앞 메일(한국어 Gmail · 영어 · Outlook · >)은 잘라 낸다', () => {
  assert.equal(newPart('네, 보내 드리겠습니다.\n\n2026년 9월 3일 (목) 오전 10:32, 남궁현 <hyun.ng@moa-office.example>님이 작성:\n> 매주 월요일 …'), '네, 보내 드리겠습니다.')
  assert.equal(newPart('OK, attached.\n\nOn Thu, Sep 3, 2026 at 10:32 AM Hyun <h@x.example> wrote:\n> every Monday'), 'OK, attached.')
  assert.equal(newPart('첨부합니다.\n-----Original Message-----\nFrom: a\n본문'), '첨부합니다.')
  assert.equal(newPart('검토 부탁드립니다.\n\n보낸 사람: 박서연\n받는 사람: 장진영\n제목: …'), '검토 부탁드립니다.')
  assert.equal(newPart('From: 이도윤 (첫 줄의 서명)\n본문입니다.'), 'From: 이도윤 (첫 줄의 서명)\n본문입니다.')
})

test('첨부 읽기: xlsx 칸 이름(금액 · 날짜 · 주소 빼고), docx · hwpx 줄과 「이름 :」', async () => {
  const x = await readFile('견적서_양식.xlsx', fs.readFileSync(new URL('../scripts/fixtures/ax-demo-templates/견적서_양식.xlsx', import.meta.url)))
  assert.equal(x.kind, 'xlsx')
  for (const l of ['고객명', '견적일', '프로젝트', '현장 주소']) assert.ok(x.labels.includes(l), `${l} in ${x.labels.join(',')}`)
  assert.ok(!x.labels.some((l) => /^[\d,.\s원]+$/.test(l)))
  const zip = new JSZip()
  zip.file('word/document.xml', '<w:document><w:body><w:p><w:r><w:t>현장 주소 : 판교</w:t></w:r></w:p><w:p><w:r><w:t>공정률</w:t></w:r></w:p><w:p><w:r><w:t>2026-09-07</w:t></w:r></w:p></w:body></w:document>')
  const d = await readFile('보고.docx', await zip.generateAsync({ type: 'nodebuffer' }))
  assert.deepEqual(d.labels, ['현장 주소', '공정률'])
  const hz = new JSZip()
  hz.file('Contents/section0.xml', '<hs:sec><hp:p><hp:run><hp:t>제안 개요</hp:t></hp:run></hp:p><hp:p><hp:run><hp:t>공사 기간: 3주</hp:t></hp:run></hp:p></hs:sec>')
  const h = await readFile('제안서.hwpx', await hz.generateAsync({ type: 'nodebuffer' }))
  assert.deepEqual(h.labels, ['제안 개요', '공사 기간'])
  assert.deepEqual((await readFile('a.pdf', Buffer.from('%PDF'))).labels, [])
})

test('양식: 이름은 고객 부분 앞, 칸은 여러 첨부에 늘 있는 것만(고객마다 다른 값은 빠짐)', () => {
  assert.equal(formKey('견적서_달빛커피_2호점.xlsx'), '견적서.xlsx')
  assert.equal(formKey('주간공정보고_모아공유오피스_0907.xlsx'), '주간공정보고.xlsx')
  const sets = [['고객명', '견적일', '달빛커피'], ['고객명', '견적일', '도담 수학학원'], ['고객명', '견적일', '빛담 사진관', '비고']]
  assert.deepEqual(formFields(sets), ['고객명', '견적일'])
  assert.deepEqual(formFields([['고객명', '달빛커피']]), []) // one file alone: its values cannot be told from its labels
})

const kst = (s) => new Date(`${s}+09:00`).toISOString()
test('주기: 매주 월 9시(추석 뒤 하루 늦은 주가 있어도) · 매월 1일 · 평일 매일 · 불규칙 · 너무 적음', () => {
  const mondays = ['2026-09-07T09:25', '2026-09-14T09:12', '2026-09-21T09:31', '2026-09-29T09:20', '2026-10-05T09:08', '2026-10-12T09:35', '2026-10-19T09:15'].map(kst)
  const w = periodOf(mondays)
  assert.equal(w.every, 'week'); assert.equal(w.dow, 1); assert.equal(w.hour, 9); assert.equal(w.cron, '0 9 * * 1')
  assert.ok(w.regular >= 0.8)
  const m = periodOf(['2026-07-01T09:40', '2026-08-01T09:20', '2026-09-01T09:42', '2026-10-01T09:30', '2026-11-01T09:10'].map(kst))
  assert.equal(m.cron, '0 9 1 * *')
  const days = []
  for (let d = new Date('2026-10-05T08:30:00+09:00'); days.length < 15; d = new Date(d.getTime() + 86400000)) if (![0, 6].includes(new Date(d.getTime() + 9 * 3600e3).getUTCDay())) days.push(d.toISOString())
  assert.equal(periodOf(days).cron, '0 8 * * 1-5')
  assert.equal(periodOf(['2026-09-01T10:00', '2026-09-04T15:00', '2026-09-15T09:00', '2026-09-17T11:00', '2026-10-09T16:00'].map(kst)), null)
  assert.equal(periodOf(mondays.slice(0, 3)), null)
  // work that cases drive: every weekday, but several a day and at any hour — not a clock
  const busy = []
  for (let i = 0; i < 30; i++) busy.push(new Date(new Date('2026-09-01T09:00:00+09:00').getTime() + Math.floor(i / 2) * 86400000 + ((i * 197) % 480) * 60000).toISOString())
  assert.equal(periodOf(busy), null)
})

test('메일이 말한 주기 → cron, 사람이 읽는 주기', () => {
  assert.equal(cronOfHint({ every: 'week', dow: 1, hour: 9 }), '0 9 * * 1')
  assert.equal(cronOfHint({ every: 'month', dom: 1 }), '0 9 1 * *')
  assert.equal(cronOfHint({ every: 'day', hour: 8 }), '0 8 * * 1-5')
  assert.equal(cronOfHint({ every: 'month', dom: 31 }), null)
  assert.equal(cronOfHint({ every: 'week' }), null)
  assert.equal(cronKo('0 9 * * 1'), '매주 월 9시')
  assert.equal(cronKo('0 9 1 * *'), '매월 1일 9시')
  assert.equal(cronKo('0 8 * * 1-5'), '평일 8시')
  assert.equal(cronKo('30 12,21 * * *'), '매일 12시 30분 · 21시 30분')
})
