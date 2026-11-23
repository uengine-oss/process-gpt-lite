// 엑셀 양식을 채운 뒤 앞 건의 값이 남았는지(lib/ontology/docfill.js xlsxLeftovers · stepdoc.js formStep 의 엑셀 갈래): 워드 양식과 같은 규칙으로
// 양식 파일의 지난 건 값(파일 이름의 고객 · 칸 이름 옆의 값 · 첫 칸들의 날짜)을 찾고, 채운 시트에 남았으면 못 지킨 점검으로 — 우리 회사
// 이름(파일 이름의 보낸 쪽)은 고객이 아니다. 수식 칸은 열 때 다시 계산되니 보지 않는다. 모델 · DB 없이(2026-11-16).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ExcelJS from 'exceljs'
import { xlsxLines, xlsxLeftovers, leftoverCheck, sourceCaseStrings } from '../lib/ontology/docfill.js'
import { ownNamesOf, docFacts } from '../lib/ontology/formats.js'
import { defaultRules } from '../lib/ontology/discovery.js'

const R = defaultRules().formats || {}
// a quote form as the company sent it for 바이켐 (the header names us, the sender)
async function quote({ customer = '바이켐 김현석 팀장', day = '2026. 11. 10', note = '바이켐 ERP 서버 2대 기준', header = '유엔진솔루션즈 | 견적서', person = '정석진' } = {}) {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('견적서')
  ws.headerFooter.oddHeader = `&L${header.split(' | ')[0]}&R${header.split(' | ')[1] || ''}`
  ws.getCell('A1').value = '견 적 서'
  ws.getCell('A3').value = '고객명'
  ws.getCell('B3').value = customer
  ws.mergeCells('B3:C3')
  ws.getCell('D3').value = '견적일'
  ws.getCell('E3').value = day
  ws.getRow(5).values = ['품목', '수량', '단가', '금액', '비고']
  ws.getRow(6).values = ['ERP 유지보수', 1, 3500000]
  ws.getCell('D6').value = { formula: 'B6*C6', result: 3500000 }
  ws.getCell('A8').value = note
  ws.getRow(10).values = ['업체명', '㈜유엔진솔루션즈', '담당자', person]
  return Buffer.from(await wb.xlsx.writeBuffer())
}
const tmp = (name, buf) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'xlsxleft-')); const p = path.join(d, name); fs.writeFileSync(p, buf); return p }

test('엑셀 시트의 글: 머리글 · 칸(행 · 줄 안 차례) — 병합된 칸은 한 번, 수식 칸은 빼고', async () => {
  const lines = await xlsxLines(await quote())
  assert.ok(lines.some((l) => l.part === 'header' && /유엔진솔루션즈/.test(l.text)))
  const row3 = lines.filter((l) => l.cell && l.row === lines.find((x) => x.text === '고객명').row).map((l) => [l.col, l.text])
  assert.deepEqual(row3, [[0, '고객명'], [1, '바이켐 김현석 팀장'], [2, '견적일'], [3, '2026. 11. 10']])
  assert.ok(!lines.some((l) => l.text === '3500000' && l.col === 3), '수식 칸(D6)은 읽지 않는다')
})

test('채운 엑셀에 남은 앞 건의 값: 고객 이름 · 날짜는 못 지킨 점검, 우리 회사 이름 · 표의 머리 줄은 아님', async () => {
  const template = { name: '견적서.xlsx', path: tmp('유엔진솔루션즈_바이켐_견적서.xlsx', await quote()) }
  const source = { fileNames: ['유엔진솔루션즈_바이켐_견적서.xlsx'], own: ['유엔진솔루션즈'], others: [] }
  const caseText = '[유지보수 견적 요청] 한빛제약 2027년 MA'
  // the fill changed the customer but left the date and the note
  const half = await quote({ customer: '한빛제약 이수진 과장', person: '박지훈' })
  const r = await xlsxLeftovers({ template, buf: half, source, caseText, rules: R })
  assert.ok(r.sourceCase.includes('바이켐'), JSON.stringify(r.sourceCase))
  assert.ok(r.sourceCase.includes('2026. 11. 10'))
  assert.ok(!r.sourceCase.includes('유엔진솔루션즈'), '우리 회사(보낸 쪽)는 지난 건의 값이 아니다')
  assert.ok(!r.sourceCase.includes('㈜유엔진솔루션즈'), '업체명 옆의 우리 회사도 아니다')
  assert.ok(!r.sourceCase.includes('비고'), '표의 머리 줄(금액 | 비고)은 값이 아니다')
  assert.ok(r.sourceCase.includes('정석진'), '담당자 옆의 사람 이름은 값')
  assert.deepEqual(r.left.sort(), ['2026. 11. 10', '바이켐'].sort())
  assert.deepEqual(r.leftWhere, ['시트 견적서'])
  const c = leftoverCheck(r)
  assert.equal(c.ok, false)
  assert.match(c.note, /^앞 건의 이름이 남았어요: .*바이켐.* — 시트 견적서$/)
  // all changed: nothing left, no check
  const full = await quote({ customer: '한빛제약 이수진 과장', day: '2026. 11. 16', note: '한빛제약 ERP 서버 2대 기준', person: '박지훈' })
  const ok = await xlsxLeftovers({ template, buf: full, source, caseText, rules: R })
  assert.deepEqual(ok.left, [])
  assert.equal(leftoverCheck(ok), null)
  // without our own name the rules would take the sender for the customer (the header · 업체명 keep it in every case)
  const noOwn = await xlsxLeftovers({ template, buf: full, source: { ...source, own: [] }, caseText, rules: R })
  assert.deepEqual(noOwn.left.sort(), ['㈜유엔진솔루션즈', '유엔진솔루션즈'].sort())
})

test('우리 회사 이름: 모든 남겨 둔 파일에 있는 이름도 지난 건의 값이 아니다(다른 파일과 견줌)', async () => {
  const other = await docFacts('유엔진솔루션즈_고모텍_견적서.xlsx', await quote({ customer: '고모텍 강수용 책임', day: '2026. 10. 02', note: '고모텍 MES 연동 기준' }))
  const lines = await xlsxLines(await quote())
  const got = sourceCaseStrings({ form: '견적서.xlsx', templateName: '유엔진솔루션즈_바이켐_견적서.xlsx', lines, others: [other],
    fileNames: ['유엔진솔루션즈_바이켐_견적서.xlsx', '유엔진솔루션즈_고모텍_견적서.xlsx'], caseText: '한빛제약', R }).map((x) => x.text)
  assert.ok(got.includes('바이켐'))
  assert.ok(!got.includes('유엔진솔루션즈'))
})

test('우리 회사 이름 고르기: 회사 이름이 있으면 그것, 없으면 서로 다른 일의 양식 파일 이름에 함께 나오는 이름', () => {
  assert.deepEqual(ownNamesOf([], ['유엔진 데모']), ['유엔진 데모'])
  const byTask = [
    { task: '견적서 작성', forms: [{ name: '견적서.xlsx', fileNames: ['유엔진솔루션즈_바이켐_견적서.xlsx'] }] },
    { task: '제안서 작성', forms: [{ name: '제안서.docx', fileNames: ['유엔진솔루션즈_고모텍_제안서.docx', '유엔진솔루션즈_윈텍_제안서.docx'] }] },
    { task: '진행현황 공유', forms: [{ name: '과제 정의서.docx', fileNames: ['고모텍.docx'] }, { name: '기업분석표.docx', fileNames: ['고모텍_기업분석.docx'] }] },
  ]
  // 유엔진솔루션즈: two works · 바이켐: one · 고모텍: two forms of one work, and one file name of another work (제안서) → two works
  assert.deepEqual(ownNamesOf(byTask).sort(), ['고모텍', '유엔진솔루션즈'].sort())
  assert.deepEqual(ownNamesOf(byTask.slice(0, 2)), ['유엔진솔루션즈'])
})
