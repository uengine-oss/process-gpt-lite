// 일 정의가 읽는 엑셀 칸(spec pgpt-pro_process-ontology, 「에이전트가 만든 견적서와 배운 조건」): 점검 항목은 사람이 보는 글자로
// 판단해야 한다 — LibreOffice 가 글꼴이 섞인 칸을 rich text 로 저장하면 빈칸으로 읽혀 점검이 모두 ✗ 가 됐다(2026-11-13).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import ExcelJS from 'exceljs'
import { cellText, sheetText } from '../lib/ontology/taskdef.js'

test('칸 하나: rich text · 수식 결과 · 날짜 · 빈칸', () => {
  assert.equal(cellText({ richText: [{ text: '달빛커피 ' }, { font: { name: '맑은 고딕' }, text: '2' }, { text: '호점' }] }), '달빛커피 2호점')
  assert.equal(cellText({ formula: 'D13*F13', result: 34000000 }), '34000000')
  assert.equal(cellText({ formula: 'F2+30' }), '=F2+30')
  assert.equal(cellText({ text: { richText: [{ text: '링크' }] }, hyperlink: 'https://x' }), '링크')
  assert.equal(cellText(new Date('2026-11-12T00:00:00Z')), '2026-11-12')
  assert.equal(cellText(null), '')
  assert.equal(cellText(0), '0')
})

test('시트: 병합 칸은 한 번, 값이 같은 이웃 칸은 그대로', async () => {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('견적서')
  ws.getCell('A1').value = '수 신'
  ws.getCell('B1').value = { richText: [{ text: '달빛커피 ' }, { text: '한서윤' }] }
  ws.mergeCells('B1:D1')
  ws.getRow(2).values = ['설계비', 1, '식', 3500000, { formula: 'B2*D2', result: 3500000 }]
  const back = new ExcelJS.Workbook()
  await back.xlsx.load(await wb.xlsx.writeBuffer())
  assert.equal(sheetText(back), '수 신 | 달빛커피 한서윤\n설계비 | 1 | 식 | 3500000 | 3500000')
})
